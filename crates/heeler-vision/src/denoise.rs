//! Model noise reduction (SCUNet): a blind real-noise denoiser run
//! over the photograph in tiles. The model reads display-encoded RGB
//! in 0..1 and answers the same; the desktop converts to and from
//! scene-linear around this call and the engine's model_denoise op
//! does the blending, so this file is pixels in, pixels out.
//!
//! Tiles because attention costs quadratically in the tile's area and
//! a 24 MP frame does not fit a transformer's working set in one go.
//! Each tile is a multiple of 64 on both sides (four window levels of
//! eight: the export's real constraint, whatever its card says),
//! overlaps its neighbors, and is blended back through a linear ramp
//! over the overlap so no seam survives. A photograph smaller than a
//! tile is padded by reflection to the next multiple of 64.

use std::path::Path;

use ort::session::Session;
use ort::value::Tensor;

use crate::models::{model_paths, ModelSpec};
use crate::VisionError;

/// The tile's side. 512 is where SCUNet was trained, but the working
/// set a 512 tile grows in ORT's arena (4.0 to 7.5 GB across sessions,
/// and it never leaves while the session is held) costs more than it
/// saves: metered 2026-09-10, a 256 tile runs at the same throughput
/// per pixel and holds the arena to about a quarter of that.
pub const DENOISE_TILE: usize = 256;
/// How far neighboring tiles overlap, each side: the model's
/// receptive field reaches about this far, so a pixel this far into a
/// tile sees the same context it would in one big pass.
pub const DENOISE_OVERLAP: usize = 32;

pub struct Denoiser {
    session: Session,
}

/// The transient working set of one denoise run over w*h pixels: the
/// arena the run can grow, plus a per-pixel term. Metered 2026-09-10
/// on a Mac16,5 (48 GiB, release build, real weights) by the ignored
/// metering test below, with the session dropped after each run, the
/// desktop's policy: a held session retains the arena for its life,
/// and reloading the weights costs 115 ms. A cold run grows the 256
/// tile arena, 1042, 1415 and 2011 MB across three sessions (the
/// allocator decides how far the first growth runs) and independent of the
/// image's size; the fixed term is the worst of those with a quarter
/// margin. A warm run draws at most 16 bytes per pixel (the f32 RGB
/// answer and the tile blend) with the intercept at zero within
/// noise, so the per-pixel term carries the quarter margin alone. The
/// desktop's admission budget reads these terms, and the metering
/// test asserts every run's draw stays under this reserve: a model
/// export that changes the footprint fails that test, not the user's
/// export.
pub const DENOISE_RUN_BYTES_PER_PIXEL: u64 = 20;
pub const DENOISE_RUN_ARENA_BYTES: u64 = 2011 * (1 << 20) * 5 / 4;

/// arena + pixels * per-pixel, saturating rather than wrapping.
pub fn denoise_run_reserve(w: usize, h: usize) -> u64 {
    DENOISE_RUN_ARENA_BYTES
        .saturating_add((w as u64).saturating_mul(h as u64).saturating_mul(DENOISE_RUN_BYTES_PER_PIXEL))
}

fn inference(e: ort::Error) -> VisionError {
    VisionError::Inference(e.to_string())
}

impl Denoiser {
    pub fn load(base: &Path, spec: &ModelSpec) -> Result<Denoiser, VisionError> {
        let paths = model_paths(base, spec);
        // CPU only, and on purpose: CoreML was tried (2026-09-09) and
        // refuses the model at load, its window attention reshaping
        // through six-dimensional tensors the partitioner cannot take.
        // A 256 tile costs about 0.6 s here and a load about 115 ms;
        // the desktop counts tiles and says so before a full-size run.
        let mut builder = Session::builder().map_err(inference)?;
        let session = builder.commit_from_file(&paths[0]).map_err(inference)?;
        Ok(Denoiser { session })
    }

    /// RGB HWC f32 in 0..1 (display-encoded) at (w, h) in; the same,
    /// denoised, out. `progress` is told (tiles done, tiles in all).
    pub fn denoise(
        &mut self,
        rgb: &[f32],
        w: usize,
        h: usize,
        progress: impl FnMut(usize, usize),
    ) -> Result<Vec<f32>, VisionError> {
        let session = &mut self.session;
        denoise_tiled(rgb, w, h, progress, |chw, tw, th| {
            let input = Tensor::from_array(([1usize, 3, th, tw], chw.to_vec())).map_err(inference)?;
            let outputs = session.run(ort::inputs!["image" => input]).map_err(inference)?;
            let output = outputs.get("denoised")
                .ok_or_else(|| VisionError::Inference("the model did not answer denoised RGB".into()))?;
            let (shape, data) = output.try_extract_tensor::<f32>().map_err(inference)?;
            check_answer(&shape, data, tw, th)?;
            Ok(data.to_vec())
        })
    }
}

fn check_answer(shape: &[i64], data: &[f32], w: usize, h: usize) -> Result<(), VisionError> {
    if shape != [1, 3, h as i64, w as i64] || Some(data.len()) != w.checked_mul(h).and_then(|n| n.checked_mul(3)) {
        return Err(VisionError::Inference(format!("the model answered {shape:?} for a {w}x{h} RGB tile")));
    }
    Ok(())
}

/// One tile of the plan: its origin in the image and its size, both
/// sides multiples of 64; a tile may reach past the image's edge
/// only when the image is smaller than a tile, and then the sample is
/// reflected.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Tile {
    pub x: usize,
    pub y: usize,
    pub w: usize,
    pub h: usize,
}

/// The model's grain: four window levels of eight.
pub const DENOISE_GRAIN: usize = 64;

fn snap_up(v: usize) -> usize {
    v.div_ceil(DENOISE_GRAIN) * DENOISE_GRAIN
}

/// The tiles that cover a (w, h) image with `tile` squares stepping
/// `tile - 2 * overlap`, the last row and column pulled back to end on
/// the image's edge rather than hanging past it. An image no bigger
/// than a tile is one tile of its own size rounded up to the grain.
pub fn tile_plan(w: usize, h: usize, tile: usize, overlap: usize) -> Vec<Tile> {
    if w == 0 || h == 0 {
        return Vec::new();
    }
    let tile = snap_up(tile.max(DENOISE_GRAIN));
    let step = tile.saturating_sub(2 * overlap).max(DENOISE_GRAIN);
    let axis = |n: usize| -> Vec<(usize, usize)> {
        if n <= tile {
            return vec![(0, snap_up(n))];
        }
        let mut out = Vec::new();
        let mut at = 0;
        loop {
            if at + tile >= n {
                out.push((n - tile, tile));
                break;
            }
            out.push((at, tile));
            at += step;
        }
        out
    };
    let mut tiles = Vec::new();
    for (y, th) in axis(h) {
        for (x, tw) in axis(w) {
            tiles.push(Tile { x, y, w: tw, h: th });
        }
    }
    tiles
}

/// The image's sample index along one axis, reflected at the edges.
fn reflect(i: isize, n: usize) -> usize {
    if n <= 1 {
        return 0;
    }
    let period = 2 * (n - 1) as isize;
    let phase = i.rem_euclid(period);
    phase.min(period - phase) as usize
}

/// Runs `model` over every tile of the plan and blends the answers
/// back. `model` gets the tile as CHW in 0..1 and returns CHW of the
/// same shape. Pure tiling, so the seams and the coverage are tested
/// without a model.
pub fn denoise_tiled(
    rgb: &[f32],
    w: usize,
    h: usize,
    mut progress: impl FnMut(usize, usize),
    mut model: impl FnMut(&[f32], usize, usize) -> Result<Vec<f32>, VisionError>,
) -> Result<Vec<f32>, VisionError> {
    if w == 0 || h == 0 || Some(rgb.len()) != w.checked_mul(h).and_then(|n| n.checked_mul(3)) {
        return Err(VisionError::Inference("a nonempty HWC RGB image is required".into()));
    }
    let plan = tile_plan(w, h, DENOISE_TILE, DENOISE_OVERLAP);
    let total = plan.len();
    let mut acc = vec![0.0f32; w * h * 3];
    let mut weight = vec![0.0f32; w * h];
    let ramp = DENOISE_OVERLAP.max(1) as f32;
    for (done, t) in plan.iter().enumerate() {
        let mut chw = vec![0.0f32; 3 * t.w * t.h];
        for ty in 0..t.h {
            let sy = reflect((t.y + ty) as isize, h);
            for tx in 0..t.w {
                let sx = reflect((t.x + tx) as isize, w);
                let src = (sy * w + sx) * 3;
                for c in 0..3 {
                    chw[c * t.w * t.h + ty * t.w + tx] = rgb[src + c];
                }
            }
        }
        let out = model(&chw, t.w, t.h)?;
        if out.len() != chw.len() {
            return Err(VisionError::Inference("the model answered a tile of another size".into()));
        }
        for ty in 0..t.h {
            let y = t.y + ty;
            if y >= h {
                continue;
            }
            // A ramp over the overlap on the sides that meet another
            // tile; the image's own edges keep full weight.
            let wy = edge_weight(ty, t.h, t.y > 0, t.y + t.h < h, ramp);
            for tx in 0..t.w {
                let x = t.x + tx;
                if x >= w {
                    continue;
                }
                let wx = edge_weight(tx, t.w, t.x > 0, t.x + t.w < w, ramp);
                let wgt = wx * wy;
                let dst = y * w + x;
                weight[dst] += wgt;
                for c in 0..3 {
                    acc[dst * 3 + c] += out[c * t.w * t.h + ty * t.w + tx] * wgt;
                }
            }
        }
        progress(done + 1, total);
    }
    for (i, wgt) in weight.iter().enumerate() {
        let inv = 1.0 / wgt.max(1e-6);
        for c in 0..3 {
            acc[i * 3 + c] *= inv;
        }
    }
    Ok(acc)
}

fn edge_weight(i: usize, n: usize, ramp_lo: bool, ramp_hi: bool, ramp: f32) -> f32 {
    let mut wgt = 1.0f32;
    if ramp_lo {
        wgt = wgt.min(((i as f32) + 1.0) / ramp);
    }
    if ramp_hi {
        wgt = wgt.min(((n - i) as f32) / ramp);
    }
    wgt.clamp(1.0 / ramp, 1.0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn malformed_answers_and_empty_inputs_are_refused() {
        let data = vec![0.5; 3 * 64 * 64];
        assert!(check_answer(&[1, 3, 64, 64], &data, 64, 64).is_ok());
        for shape in [vec![], vec![64], vec![64, 64], vec![1, 1, 64, 64], vec![2, 3, 64, 64], vec![1, 3, 32, 64]] {
            assert!(check_answer(&shape, &data, 64, 64).is_err());
        }
        assert!(check_answer(&[1, 3, 64, 64], &data[..12], 64, 64).is_err());
        for (rgb, w, h) in [(&[][..], 0, 1), (&[][..], 1, 1), (&[][..], usize::MAX, 2)] {
            assert!(denoise_tiled(rgb, w, h, |_, _| {}, |_, _, _| panic!("invalid input reached the model")).is_err());
        }
    }

    #[test]
    fn reflection_repeats_across_the_entire_padding_of_tiny_images() {
        for n in 1..8 {
            for i in 0..128 {
                let expected = if n == 1 { 0 } else {
                    let phase = i % (2 * (n - 1));
                    phase.min(2 * (n - 1) - phase)
                };
                assert_eq!(reflect(i as isize, n), expected, "index {i}, side {n}");
                assert_eq!(reflect(-(i as isize), n), expected);
            }
        }
    }

    #[test]
    fn the_plan_covers_the_image_with_tiles_of_the_grain_that_end_on_its_edge() {
        for (w, h) in [(4000usize, 3000usize), (512, 512), (600, 100), (37, 41), (1300, 2100)] {
            let plan = tile_plan(w, h, DENOISE_TILE, DENOISE_OVERLAP);
            assert!(!plan.is_empty());
            let mut covered = vec![false; w * h];
            for t in &plan {
                assert_eq!(t.w % DENOISE_GRAIN, 0);
                assert_eq!(t.h % DENOISE_GRAIN, 0);
                if w > DENOISE_TILE {
                    assert!(t.x + t.w <= w, "{w}x{h}: tile hangs past the right edge");
                }
                if h > DENOISE_TILE {
                    assert!(t.y + t.h <= h, "{w}x{h}: tile hangs past the bottom edge");
                }
                for y in t.y..(t.y + t.h).min(h) {
                    for x in t.x..(t.x + t.w).min(w) {
                        covered[y * w + x] = true;
                    }
                }
            }
            assert!(covered.iter().all(|c| *c), "{w}x{h}: a pixel no tile reaches");
        }
        // One tile for a small image, its size rounded up to the grain.
        assert_eq!(tile_plan(37, 41, DENOISE_TILE, DENOISE_OVERLAP), vec![Tile { x: 0, y: 0, w: 64, h: 64 }]);
    }

    #[test]
    fn an_identity_model_returns_the_image_and_a_constant_model_a_flat_field() {
        let (w, h) = (1100usize, 700usize);
        let rgb: Vec<f32> = (0..w * h * 3).map(|i| ((i * 7919) % 1000) as f32 / 1000.0).collect();
        let mut tiles = 0;
        let same = denoise_tiled(&rgb, w, h, |d, t| tiles = t.max(d), |chw, _, _| Ok(chw.to_vec())).unwrap();
        assert!(tiles > 1);
        for (a, b) in rgb.iter().zip(&same) {
            assert!((a - b).abs() < 1e-5, "seam or weight error: {a} vs {b}");
        }
        // Weights sum to one everywhere, seams included: a model that
        // answers 0.5 for every pixel gives 0.5 for every pixel.
        let flat = denoise_tiled(&rgb, w, h, |_, _| {}, |chw, _, _| Ok(vec![0.5; chw.len()])).unwrap();
        assert!(flat.iter().all(|v| (v - 0.5).abs() < 1e-5));
    }

    #[test]
    fn a_model_that_answers_the_wrong_size_is_refused() {
        let rgb = vec![0.2f32; 64 * 64 * 3];
        let err = denoise_tiled(&rgb, 64, 64, |_, _| {}, |chw, _, _| Ok(chw[..3].to_vec())).unwrap_err();
        assert!(matches!(err, VisionError::Inference(_)));
    }

    /// Against the real weights: only when a model base is named, so
    /// the suite never needs a download. Run with
    /// `HEELER_VISION_BASE=... cargo test -p heeler-vision --release -- --ignored real_model --nocapture`.
    #[test]
    #[ignore]
    fn real_model_takes_noise_off_a_flat_field() {
        let Ok(base) = std::env::var("HEELER_VISION_BASE") else { return };
        let base = std::path::PathBuf::from(base);
        let mut d = Denoiser::load(&base, &crate::models::SCUNET).expect("load");
        let dim = |k: &str, d: usize| std::env::var(k).ok().and_then(|v| v.parse().ok()).unwrap_or(d);
        let (w, h) = (dim("HEELER_TEST_W", 1100), dim("HEELER_TEST_H", 700));
        let mut seed = 12345u32;
        let mut noisy = vec![0.0f32; w * h * 3];
        for v in noisy.iter_mut() {
            seed = seed.wrapping_mul(1664525).wrapping_add(1013904223);
            let n = ((seed >> 8) as f32 / (1u32 << 24) as f32) - 0.5;
            *v = (0.5 + n * 0.2).clamp(0.0, 1.0);
        }
        eprintln!("size {w}x{h}");
        let t0 = std::time::Instant::now();
        let out = d.denoise(&noisy, w, h, |d, t| eprintln!("tile {d}/{t}")).expect("run");
        eprintln!("{}x{} in {:?}", w, h, t0.elapsed());
        let dev = |v: &[f32]| (v.iter().map(|x| (x - 0.5).powi(2)).sum::<f32>() / v.len() as f32).sqrt();
        eprintln!("noise in {:.4} out {:.4}", dev(&noisy), dev(&out));
        assert!(dev(&out) < dev(&noisy) * 0.5, "the model did not reduce the noise");
    }

    /// Meters the model's real footprint under the desktop's policy:
    /// resident size around a load, then around denoise runs at three
    /// sizes on a session loaded fresh and dropped after each run, each
    /// size twice so the warm-heap run reads separately from the first.
    /// A sampler thread reads `ps` every 50 ms. Prints the table the
    /// reserve terms were fitted from, and asserts every measured
    /// transient stays under denoise_run_reserve, so a model export
    /// that changes the arena fails here and not in the user's export.
    /// The input vector is allocated before the measured window because
    /// the desktop admits it separately.
    #[test]
    #[ignore]
    fn real_model_memory_footprint_is_metered_against_the_reserve() {
        let Ok(base) = std::env::var("HEELER_VISION_BASE") else { return };
        use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
        use std::sync::Arc;
        let rss = || -> usize {
            let out = std::process::Command::new("ps")
                .args(["-o", "rss=", "-p"])
                .arg(std::process::id().to_string())
                .output()
                .expect("ps");
            String::from_utf8_lossy(&out.stdout).trim().parse::<usize>().unwrap_or(0) * 1024
        };
        let peak = Arc::new(AtomicUsize::new(0));
        let stop = Arc::new(AtomicBool::new(false));
        let sampler = {
            let (peak, stop) = (peak.clone(), stop.clone());
            std::thread::spawn(move || {
                while !stop.load(Ordering::Relaxed) {
                    peak.fetch_max(rss(), Ordering::Relaxed);
                    std::thread::sleep(std::time::Duration::from_millis(50));
                }
            })
        };
        let mb = |b: usize| format!("{:.1}", b as f64 / (1 << 20) as f64);
        let noisy = |w: usize, h: usize| {
            let mut seed = 12345u32;
            let mut v = vec![0.0f32; w * h * 3];
            for px in v.iter_mut() {
                seed = seed.wrapping_mul(1664525).wrapping_add(1013904223);
                *px = (0.5 + (((seed >> 8) as f32 / (1u32 << 24) as f32) - 0.5) * 0.2).clamp(0.0, 1.0);
            }
            v
        };
        let base = std::path::PathBuf::from(base);
        eprintln!("config: tile {DENOISE_TILE}, overlap {DENOISE_OVERLAP}, session dropped after each run");
        let baseline = rss();
        peak.store(baseline, Ordering::Relaxed);
        let t_load = std::time::Instant::now();
        let probe = Denoiser::load(&base, &crate::models::SCUNET).expect("load");
        let after_load = rss();
        let during_load = peak.load(Ordering::Relaxed);
        drop(probe);
        eprintln!("baseline {} MB", mb(baseline));
        eprintln!("load: resident {} MB, peak during {} MB, session footprint {} MB, wall {:?}",
            mb(after_load), mb(during_load), mb(after_load.saturating_sub(baseline)), t_load.elapsed());
        let mut over: Vec<String> = Vec::new();
        for &(w, h) in &[(512usize, 512usize), (2048, 1365), (6000, 4000)] {
            let input = noisy(w, h);
            for run in 1..=2 {
                let before = rss();
                peak.store(before, Ordering::Relaxed);
                let t0 = std::time::Instant::now();
                // The desktop's policy: every run loads fresh and drops
                // the session right after, so nothing is held between
                // runs and the arena is a per-run cost.
                let tl = std::time::Instant::now();
                let mut fresh = Denoiser::load(&base, &crate::models::SCUNET).expect("load");
                let load_wall = tl.elapsed();
                let out = fresh.denoise(&input, w, h, |_, _| {}).expect("run");
                drop(fresh);
                let elapsed = t0.elapsed();
                let during = peak.load(Ordering::Relaxed);
                let after = rss();
                drop(out);
                let transient = during.saturating_sub(before);
                eprintln!("{w}x{h} run {run}: load wall {:?}, resident before {} MB, peak during {} MB, resident after {} MB, transient {} MB, wall {:?}, reserve {} MB",
                    load_wall, mb(before), mb(during), mb(after), mb(transient), elapsed, mb(denoise_run_reserve(w, h) as usize));
                // A run's whole draw, arena included, is covered by its
                // own reserve: nothing is held to pre-pay it.
                let covered = denoise_run_reserve(w, h);
                if transient as u64 > covered {
                    over.push(format!("{w}x{h} run {run}: transient {transient} over reserve {covered}"));
                }
            }
        }
        // RSS stays near the high-water mark after the runs: the freed
        // arena and buffers are heap slack the next allocation reuses,
        // not a session anyone holds. Printed for the table, not
        // asserted: the allocator's habit is not the model's footprint.
        eprintln!("resident after all runs, nothing held: {} MB", mb(rss().saturating_sub(baseline)));
        stop.store(true, Ordering::Relaxed);
        sampler.join().unwrap();
        assert!(over.is_empty(), "runs over the reserve: {over:?}");
    }
}
