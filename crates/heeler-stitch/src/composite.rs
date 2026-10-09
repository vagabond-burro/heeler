//! Painting the solved cameras onto one surface.
//!
//! Two problems stand between a correct set of camera poses and a
//! photograph, and neither is geometric.
//!
//! The first is that the frames do not match in brightness. Every camera
//! meters each shot separately, so a pan across a bright sky and a dark
//! treeline comes back as a set of frames each individually well
//! exposed and collectively inconsistent. Averaging them leaves visible
//! steps.
//!
//! The second is that even after gain compensation the seam is visible,
//! because no two frames agree exactly: the lens vignettes, the
//! registration is a fraction of a pixel out, and anything that moved
//! between shots is in one frame and not the other. Blending over a wide
//! band hides the step but smears the detail; blending over a narrow one
//! keeps the detail but shows the seam. Burt and Adelson's answer is to
//! do both, at different scales, which is what multi-band blending is.

use crate::bundle::Camera;
use crate::geom::solve;
use crate::gray::{blur_with_stop, Gray};
use heeler_engine::buffers::ImageBuf;

/// Expected variance of the intensity error between two frames of the
/// same scene, in 0-255 units. Brown and Lowe's sigma_N = 10.
const SIGMA_N: f64 = 10.0;
/// How far a gain may stray from 1 before the fit objects. Without this
/// term the whole panorama has a trivial solution: set every gain to
/// zero, making all frames agree perfectly at black.
const SIGMA_G: f64 = 0.1;
/// Width of the finest blending band, in pixels. Each band after it is
/// twice as wide.
const BAND_SIGMA: f32 = 5.0;

/// The surface the panorama is painted onto.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Surface {
    /// Straight lines stay straight, and the frame explodes toward the
    /// edges. Only usable under roughly 90 degrees.
    Planar,
    /// Verticals stay vertical, horizontals bow. The usual choice for a
    /// single row of frames.
    Cylindrical,
    /// The only one that survives a full turn, and the only one that can
    /// hold more than one row.
    Spherical,
}

#[derive(Debug, Clone)]
pub struct CompositeOpts {
    pub surface: Surface,
    /// Cap on the longest output side. A panorama's natural size is the
    /// sum of its inputs, which is quickly larger than anything worth
    /// holding in memory for a preview.
    pub max_dimension: usize,
    /// Equalize exposure between frames before blending.
    pub gain_compensation: bool,
    /// Blending bands. One is a plain feather; more costs memory and
    /// hides wider seams.
    pub bands: usize,
    /// Legacy serialized option. Admission uses the shared machine budget;
    /// memory pressure never changes the requested canvas dimensions.
    pub memory_budget: usize,
}

impl Default for CompositeOpts {
    fn default() -> Self {
        CompositeOpts {
            surface: Surface::Spherical,
            max_dimension: 8000,
            gain_compensation: true,
            bands: 4,
            memory_budget: 2 << 30, // 2 GiB
        }
    }
}

/// Working memory per output pixel, in bytes.
///
/// Compositing is not cheap in memory, and the cost scales with the
/// output area, so a panorama asked for at an ambitious size does not
/// run slowly, it runs out of memory and takes the app with it. The
/// accounting, per pixel of canvas:
///
/// - every frame warped and held at once, four f32 planes each (three
///   color and a weight), because gain compensation needs to compare
///   every overlapping pair before any blending starts: `16 * frames`
/// - which frame owns the pixel: 4
/// - the per-band accumulators, three color planes and a weight: `16 * bands`
/// - the scratch a single frame's band decomposition needs: about 32
/// - the finished image: 16
///
/// Six frames into four bands is a little over 200 bytes per pixel, so a
/// 2 GiB allowance holds around ten megapixels of panorama. Admission
/// checks this workspace before painting and refuses when it cannot fit.
pub fn bytes_per_pixel(frames: usize, bands: usize) -> usize {
    heeler_engine::memory::or_unwind(heeler_engine::memory::sum([
        heeler_engine::memory::or_unwind(heeler_engine::memory::bytes(frames, 1, 1, 16)),
        heeler_engine::memory::or_unwind(heeler_engine::memory::bytes(bands.max(1), 1, 1, 16)), 52]))
}

/// One solved photograph.
pub struct Frame<'a> {
    pub image: &'a ImageBuf,
    pub camera: Camera,
    /// The vertical focal length over the horizontal, in this frame's
    /// pixels: 1 for a frame solved at its own size. A frame registered
    /// at REGISTER_EDGE was scaled by slightly different factors across
    /// and down (each side rounds on its own), so its camera's one focal
    /// length is right across and this puts it right down (the 26.4.3
    /// latest review's R1: up to a pixel on an ordinary frame, eight on a
    /// very tall one).
    pub aspect: f64,
}

impl<'a> Frame<'a> {
    /// A frame whose pixels are square to its camera.
    pub fn new(image: &'a ImageBuf, camera: Camera) -> Self {
        Frame { image, camera, aspect: 1.0 }
    }

    /// The focal length down the frame, in its pixels.
    fn fy(&self) -> f64 {
        self.camera.f * self.aspect
    }
}

/// Maps between output pixels and rays.
struct Projection {
    surface: Surface,
    /// Output pixels per radian.
    scale: f64,
    /// Where the ray straight ahead lands.
    origin_x: f64,
    origin_y: f64,
    /// Yaw offset between the solved world and the canvas, chosen so the
    /// +-PI seam falls in the largest gap in the frames' coverage
    /// instead of through the middle of the scene. Zero keeps the
    /// solved origin.
    yaw: f64,
}

/// Rotation about the world Y (up) axis: yaw_of(rot_y(t, d)) is
/// yaw_of(d) + t.
fn rot_y(t: f64, d: [f64; 3]) -> [f64; 3] {
    let (s, c) = t.sin_cos();
    [d[0] * c + d[2] * s, d[1], d[2] * c - d[0] * s]
}

impl Projection {
    /// The direction a given output pixel looks in.
    fn ray(&self, x: f64, y: f64) -> [f64; 3] {
        let u = (x - self.origin_x) / self.scale;
        let v = (y - self.origin_y) / self.scale;
        let d = match self.surface {
            // Angle across, angle down. Wraps in both directions.
            Surface::Spherical => {
                let (su, cu) = u.sin_cos();
                let (sv, cv) = v.sin_cos();
                [su * cv, sv, cu * cv]
            }
            // Angle across, but straight up the side of a cylinder, so
            // verticals stay vertical.
            Surface::Cylindrical => {
                let (su, cu) = u.sin_cos();
                [su, v, cu]
            }
            // Flat plane at unit distance: this is just a camera.
            Surface::Planar => [u, v, 1.0],
        };
        // The canvas is yaw-rotated against the solved world; a ray
        // back into the world undoes it.
        if self.yaw == 0.0 { d } else { rot_y(-self.yaw, d) }
    }

    /// Where a ray lands, or None when it is behind the surface.
    fn place(&self, d: [f64; 3]) -> Option<(f64, f64)> {
        let d = if self.yaw == 0.0 { d } else { rot_y(self.yaw, d) };
        let (u, v) = match self.surface {
            Surface::Spherical => {
                let len = (d[0] * d[0] + d[1] * d[1] + d[2] * d[2]).sqrt();
                if len < 1e-12 {
                    return None;
                }
                (d[0].atan2(d[2]), (d[1] / len).clamp(-1.0, 1.0).asin())
            }
            Surface::Cylindrical => {
                let horiz = (d[0] * d[0] + d[2] * d[2]).sqrt();
                if horiz < 1e-12 {
                    return None;
                }
                (d[0].atan2(d[2]), d[1] / horiz)
            }
            Surface::Planar => {
                if d[2] <= 1e-6 {
                    return None;
                }
                (d[0] / d[2], d[1] / d[2])
            }
        };
        Some((u * self.scale + self.origin_x, v * self.scale + self.origin_y))
    }
}

/// Falls off to zero at the frame's border.
///
/// The weight that decides which frame owns a pixel where several
/// overlap: whichever one is looking at it most directly. A pixel at the
/// edge of one frame and the middle of another belongs to the second,
/// which is also the one whose lens distorted and vignetted it least.
fn frame_weight(x: f64, y: f64, w: usize, h: usize) -> f32 {
    let fx = 1.0 - (2.0 * x / w as f64 - 1.0).abs();
    let fy = 1.0 - (2.0 * y / h as f64 - 1.0).abs();
    (fx.max(0.0) * fy.max(0.0)) as f32
}

/// Samples an image bilinearly. None outside its bounds.
fn sample_rgb(img: &ImageBuf, x: f64, y: f64) -> Option<[f32; 3]> {
    if x < 0.0 || y < 0.0 || x >= img.width as f64 - 1.0 || y >= img.height as f64 - 1.0 {
        return None;
    }
    let (x0, y0) = (x.floor() as usize, y.floor() as usize);
    let (fx, fy) = ((x - x0 as f64) as f32, (y - y0 as f64) as f32);
    let mut out = [0.0f32; 3];
    for (c, o) in out.iter_mut().enumerate() {
        let a = img.pixel(x0, y0)[c];
        let b = img.pixel(x0 + 1, y0)[c];
        let d = img.pixel(x0, y0 + 1)[c];
        let e = img.pixel(x0 + 1, y0 + 1)[c];
        *o = (a * (1.0 - fx) + b * fx) * (1.0 - fy) + (d * (1.0 - fx) + e * fx) * fy;
    }
    Some(out)
}

/// Where a frame's pixel `(x, y)` sits on the output surface.
fn to_canvas(proj: &Projection, frame: &Frame, x: f64, y: f64, w: usize, h: usize) -> Option<(f64, f64)> {
    // Centered coordinates, undo the lens, rotate into the world.
    let d = [(x - w as f64 * 0.5) / frame.camera.f, (y - h as f64 * 0.5) / frame.fy(), 1.0];
    proj.place(frame.camera.r.transpose().mul_vec(d))
}

/// Yaw of a world direction, matching what `place` reports.
fn yaw_of(d: [f64; 3]) -> f64 {
    d[0].atan2(d[2])
}

/// Wraps an angle into [-PI, PI).
fn wrap_pi(a: f64) -> f64 {
    (a + std::f64::consts::PI).rem_euclid(2.0 * std::f64::consts::PI) - std::f64::consts::PI
}

/// The yaw offset that puts the +-PI seam in the middle of the largest
/// gap in the frames' coverage.
///
/// `place` reports yaw through atan2, which is defined on (-PI, PI].
/// Without this, a panorama whose content crosses that line (any
/// 360-degree set, or simply a pan shot facing roughly -x so the cut
/// falls mid-scene) lands frames at BOTH ends of the range, and the
/// canvas bounds span the full circle with the panorama torn in half at
/// the edges and a hole in the middle. Zero when there is no gap to
/// hide in: a true full turn covers everything, and the bounds are
/// already right. Planar never wraps.
fn yaw_shift_for(frames: &[Frame], surface: Surface) -> f64 {
    use std::f64::consts::PI;
    if matches!(surface, Surface::Planar) || frames.is_empty() {
        return 0.0;
    }
    // Half-degree buckets round the circle; a frame covers every bucket
    // between its border's yaw extremes.
    const BUCKETS: usize = 720;
    let mut covered = vec![false; BUCKETS];
    for f in frames {
        let (w, h) = (f.image.width, f.image.height);
        // Measured around the frame's own center, so a frame sitting on
        // the old seam does not wrap against itself.
        let fwd = f.camera.r.transpose().mul_vec([0.0, 0.0, 1.0]);
        let centre = yaw_of(fwd);
        let mut rel_lo = 0.0f64;
        let mut rel_hi = 0.0f64;
        let steps = 32;
        for s in 0..=steps {
            let t = s as f64 / steps as f64;
            for (x, y) in [
                (t * w as f64, 0.0),
                (t * w as f64, h as f64),
                (0.0, t * h as f64),
                (w as f64, t * h as f64),
            ] {
                let d = [(x - w as f64 * 0.5) / f.camera.f, (y - h as f64 * 0.5) / f.fy(), 1.0];
                let rel = wrap_pi(yaw_of(f.camera.r.transpose().mul_vec(d)) - centre);
                rel_lo = rel_lo.min(rel);
                rel_hi = rel_hi.max(rel);
            }
        }
        let bucket_of = |yaw: f64| ((wrap_pi(yaw) + PI) / (2.0 * PI) * BUCKETS as f64).floor() as i32;
        let b0 = bucket_of(centre + rel_lo);
        let span = (bucket_of(centre + rel_hi) - b0).rem_euclid(BUCKETS as i32);
        for k in 0..=span {
            covered[(b0 + k).rem_euclid(BUCKETS as i32) as usize] = true;
        }
    }
    let Some(start) = covered.iter().position(|&c| c) else {
        return 0.0;
    };
    // The longest uncovered run, circular: start from a covered bucket
    // and scan once round.
    let mut best_len = 0usize;
    let mut best_mid = 0.0f64;
    let mut run = 0usize;
    for k in 1..=BUCKETS {
        let idx = (start + k) % BUCKETS;
        if covered[idx] {
            if run > best_len {
                best_len = run;
                best_mid = (start + k - run) as f64 + (run as f64 - 1.0) / 2.0;
            }
            run = 0;
        } else {
            run += 1;
        }
    }
    if best_len == 0 {
        return 0.0;
    }
    // The middle bucket of the gap as an angle, and the turn that moves
    // the +-PI line onto it. Both wrapped: the scan index can run past
    // one full circle, and a turn of PI and -PI are the same seam.
    let cut = wrap_pi(best_mid / BUCKETS as f64 * 2.0 * PI - PI);
    wrap_pi(PI - cut)
}

/// Output bounds, from the frames' borders. The projection's yaw shift
/// has already moved the +-PI seam into the largest coverage gap, so on
/// a curved surface these bounds are the content and nothing else.
fn bounds(frames: &[Frame], proj: &Projection) -> Option<(f64, f64, f64, f64)> {
    let (mut lo_x, mut lo_y, mut hi_x, mut hi_y) =
        (f64::INFINITY, f64::INFINITY, f64::NEG_INFINITY, f64::NEG_INFINITY);
    for f in frames {
        let (w, h) = (f.image.width, f.image.height);
        // The border, not just the corners: on a curved surface the
        // middle of an edge can reach further than either end of it.
        let steps = 32;
        for s in 0..=steps {
            let t = s as f64 / steps as f64;
            for (x, y) in [
                (t * w as f64, 0.0),
                (t * w as f64, h as f64),
                (0.0, t * h as f64),
                (w as f64, t * h as f64),
            ] {
                if let Some((cx, cy)) = to_canvas(proj, f, x, y, w, h) {
                    lo_x = lo_x.min(cx);
                    lo_y = lo_y.min(cy);
                    hi_x = hi_x.max(cx);
                    hi_y = hi_y.max(cy);
                }
            }
        }
    }
    if !lo_x.is_finite() || hi_x <= lo_x || hi_y <= lo_y {
        return None;
    }
    Some((lo_x, lo_y, hi_x, hi_y))
}

/// One frame, warped onto the canvas.
struct Warped {
    rgb: [Gray; 3],
    weight: Gray,
}

fn warp(frame: &Frame, proj: &Projection, width: usize, height: usize) -> Warped {
    let (w, h) = (frame.image.width, frame.image.height);
    let mut out =
        Warped { rgb: [Gray::new(width, height), Gray::new(width, height), Gray::new(width, height)], weight: Gray::new(width, height) };
    for cy in 0..height {
        for cx in 0..width {
            // Backward mapping: ask what each output pixel sees, rather
            // than scattering input pixels forward and leaving holes
            // wherever the frame was stretched.
            let d = proj.ray(cx as f64 + 0.5, cy as f64 + 0.5);
            let cam = frame.camera.r.mul_vec(d);
            if cam[2] <= 1e-9 {
                continue;
            }
            let sx = frame.camera.f * cam[0] / cam[2] + w as f64 * 0.5;
            let sy = frame.fy() * cam[1] / cam[2] + h as f64 * 0.5;
            let Some(px) = sample_rgb(frame.image, sx, sy) else {
                continue;
            };
            for c in 0..3 {
                out.rgb[c].set(cx, cy, px[c]);
            }
            out.weight.set(cx, cy, frame_weight(sx, sy, w, h).max(1e-4));
        }
    }
    out
}

/// Solves for a gain per frame so the overlaps agree.
///
/// The error being minimized is the disagreement between every
/// overlapping pair, weighted by how much they overlap, plus a term
/// pulling all the gains toward 1. That second term is not decoration:
/// without it the whole system is solved perfectly by setting every gain
/// to zero, since a completely black panorama has no disagreements
/// anywhere.
///
/// Because the error is quadratic in the gains, there is no iteration
/// here. Differentiating gives one linear equation per frame, and the
/// answer comes straight out of the solve.
pub fn solve_gains(mean: &[Vec<f64>], counts: &[Vec<f64>]) -> Vec<f64> {
    let n = mean.len();
    if n == 0 {
        return Vec::new();
    }
    let mut a = vec![0.0; n * n];
    let mut b = vec![0.0; n];
    for i in 0..n {
        // The pull toward unity, on both sides of the equation.
        a[i * n + i] += 1.0 / (SIGMA_G * SIGMA_G);
        b[i] += 1.0 / (SIGMA_G * SIGMA_G);
        for j in 0..n {
            if i == j || counts[i][j] <= 0.0 {
                continue;
            }
            let nij = counts[i][j];
            a[i * n + i] += nij * mean[i][j] * mean[i][j] / (SIGMA_N * SIGMA_N);
            a[i * n + j] -= nij * mean[i][j] * mean[j][i] / (SIGMA_N * SIGMA_N);
        }
    }
    solve(n, a, b).unwrap_or_else(|| vec![1.0; n])
}

/// Overlap statistics between every pair of warped frames: mean
/// intensity in the shared region, and how large that region is.
fn gain_statistics(warps: &[Warped]) -> (Vec<Vec<f64>>, Vec<Vec<f64>>) {
    let n = warps.len();
    let mut mean = vec![vec![0.0; n]; n];
    let mut counts = vec![vec![0.0; n]; n];
    for i in 0..n {
        for j in 0..n {
            if i == j {
                continue;
            }
            let mut sum = 0.0;
            let mut count = 0.0;
            for p in 0..warps[i].weight.data.len() {
                if warps[i].weight.data[p] <= 0.0 || warps[j].weight.data[p] <= 0.0 {
                    continue;
                }
                // 0-255 units, because sigma_N is quoted in them.
                let lum = (warps[i].rgb[0].data[p] * 0.2126
                    + warps[i].rgb[1].data[p] * 0.7152
                    + warps[i].rgb[2].data[p] * 0.0722) as f64
                    * 255.0;
                sum += lum;
                count += 1.0;
            }
            if count > 0.0 {
                mean[i][j] = sum / count;
                counts[i][j] = count;
            }
        }
    }
    (mean, counts)
}

/// Which frame owns each output pixel, by weight. Ties go to the lower
/// index, which only matters for reproducibility.
fn ownership(warps: &[Warped], width: usize, height: usize) -> Vec<i32> {
    let count = heeler_engine::memory::or_unwind(heeler_engine::memory::bytes(width, height, 1, 4)) / 4;
    let mut owner = heeler_engine::memory::or_unwind(heeler_engine::memory::vector(count, -1i32, "panorama seam ownership"));
    let mut best = heeler_engine::memory::or_unwind(heeler_engine::memory::vector(count, 0.0f32, "panorama seam weights"));
    for (i, w) in warps.iter().enumerate() {
        for p in 0..owner.len() {
            if w.weight.data[p] > best[p] {
                best[p] = w.weight.data[p];
                owner[p] = i as i32;
            }
        }
    }
    owner
}

/// Builds the panorama.
///
/// Returns None when the cameras describe nothing that can be drawn: no
/// frames, or every frame pointing away from the surface.
pub fn composite(frames: &[Frame], opts: &CompositeOpts) -> Option<ImageBuf> {
    composite_with_progress(frames, opts, &|_, _| {})
}

/// The same, reporting progress from 0 to 1 over the compositing stage.
pub fn composite_with_progress(
    frames: &[Frame],
    opts: &CompositeOpts,
    on_progress: &dyn Fn(f32, &str),
) -> Option<ImageBuf> {
    composite_with_control(frames, opts, on_progress, &|| false)
}

/// The same, stopping when `stop` answers true: it is asked wherever
/// progress is reported (each frame warped, the exposure match, each
/// frame blended, the assembly), and a stopped composite answers None.
/// The caller, which asked, knows a None after a stop is a cancel
/// (2026-10-08: "pano stitching is missing a cancel button like
/// stacking has").
pub fn composite_with_control(
    frames: &[Frame],
    opts: &CompositeOpts,
    on_progress: &dyn Fn(f32, &str),
    stop: &dyn Fn() -> bool,
) -> Option<ImageBuf> {
    if frames.is_empty() {
        return None;
    }
    // Output resolution: match the input's angular resolution, so the
    // panorama is neither softened nor pointlessly enlarged.
    let scale = frames.iter().map(|f| f.camera.f).sum::<f64>() / frames.len() as f64;
    let mut proj = Projection {
        surface: opts.surface,
        scale,
        origin_x: 0.0,
        origin_y: 0.0,
        yaw: yaw_shift_for(frames, opts.surface),
    };
    let (lo_x, lo_y, hi_x, hi_y) = bounds(frames, &proj)?;

    let mut width = (hi_x - lo_x).ceil() as usize;
    let mut height = (hi_y - lo_y).ceil() as usize;
    if width == 0 || height == 0 {
        return None;
    }
    // Shrink only for the explicitly requested output size.
    let mut k = 1.0f64;
    let longest = width.max(height);
    if longest > opts.max_dimension {
        k = opts.max_dimension as f64 / longest as f64;
    }

    if k < 1.0 {
        proj.scale *= k;
        let (lo2, lo2y, hi2, hi2y) = bounds(frames, &proj)?;
        width = ((hi2 - lo2).ceil() as usize).max(1);
        height = ((hi2y - lo2y).ceil() as usize).max(1);
        proj.origin_x = -lo2;
        proj.origin_y = -lo2y;
    } else {
        proj.origin_x = -lo_x;
        proj.origin_y = -lo_y;
    }

    let needed = heeler_engine::memory::or_unwind(heeler_engine::memory::bytes(width, height, 1, bytes_per_pixel(frames.len(), opts.bands))
        .and_then(|canvas| heeler_engine::memory::sum(std::iter::once(canvas).chain(frames.iter().map(|f| f.image.data.len().saturating_mul(4))))));
    let _job = heeler_engine::memory::or_unwind(heeler_engine::memory::Job::admit(needed, "panorama canvas, warps and blend pyramids"));

    // Warping is the first of the two heavy passes over the canvas, and
    // the canvas is the size of the finished panorama, so this is where a
    // big stitch spends its time.
    let mut warps: Vec<Warped> = Vec::with_capacity(frames.len());
    for (i, f) in frames.iter().enumerate() {
        if stop() {
            return None;
        }
        on_progress(
            0.5 * i as f32 / frames.len() as f32,
            &format!("Warping frame {} of {}", i + 1, frames.len()),
        );
        warps.push(warp(f, &proj, width, height));
    }

    if opts.gain_compensation && warps.len() > 1 {
        if stop() {
            return None;
        }
        on_progress(0.5, "Matching exposure between frames");
        let (mean, counts) = gain_statistics(&warps);
        let gains = solve_gains(&mean, &counts);
        for (w, g) in warps.iter_mut().zip(&gains) {
            let g = (*g as f32).clamp(0.1, 10.0);
            for plane in w.rgb.iter_mut() {
                for v in plane.data.iter_mut() {
                    *v *= g;
                }
            }
        }
    }

    let owner = ownership(&warps, width, height);
    let bands = opts.bands.max(1);

    // Per band: the weighted sum of every frame's contribution, and the
    // weights themselves, to divide by at the end.
    let mut num: Vec<[Gray; 3]> = (0..bands)
        .map(|_| [Gray::new(width, height), Gray::new(width, height), Gray::new(width, height)])
        .collect();
    let mut den: Vec<Gray> = (0..bands).map(|_| Gray::new(width, height)).collect();

    for (i, w) in warps.iter().enumerate() {
        if stop() {
            return None;
        }
        on_progress(
            0.55 + 0.4 * i as f32 / warps.len() as f32,
            &format!("Blending frame {} of {}", i + 1, warps.len()),
        );
        // Start from a hard assignment, then blur it band by band. The
        // hard mask is what keeps detail crisp in the finest band; the
        // blurred versions are what hide the seam in the coarse ones.
        let mut mask = Gray::new(width, height);
        for p in 0..mask.data.len() {
            mask.data[p] = if owner[p] == i as i32 { 1.0 } else { 0.0 };
        }
        let mut current = w.rgb.clone();
        let mut current_mask = mask;
        let mut sigma = BAND_SIGMA;
        // Cancel is asked inside every blur and between the passes over
        // the canvas: one frame's blend at full size runs for seconds.
        let blur = |g: &Gray, sigma: f32| blur_with_stop(g, sigma, stop);

        // A single band IS the feather. With one band the difference
        // loop below never runs, so the coarsest band would accumulate
        // through the HARD ownership mask: no feathering at all, and
        // seams at full strength. Blur the mask once up front instead.
        if bands == 1 {
            current_mask = blur(&current_mask, sigma)?;
        }

        for k in 0..bands - 1 {
            let next: [Gray; 3] = [
                blur(&current[0], sigma)?,
                blur(&current[1], sigma)?,
                blur(&current[2], sigma)?,
            ];
            // The band is what this scale holds and the next does not.
            for c in 0..3 {
                for p in 0..num[k][c].data.len() {
                    let detail = current[c].data[p] - next[c].data[p];
                    num[k][c].data[p] += detail * current_mask.data[p];
                }
            }
            for p in 0..den[k].data.len() {
                den[k].data[p] += current_mask.data[p];
            }
            current = next;
            current_mask = blur(&current_mask, sigma)?;
            // Each band spans twice the last, so a handful of them cover
            // everything from a pixel to the whole frame.
            sigma *= 2.0;
        }
        // The coarsest band is the remainder, not a difference.
        let last = bands - 1;
        for c in 0..3 {
            for p in 0..num[last][c].data.len() {
                num[last][c].data[p] += current[c].data[p] * current_mask.data[p];
            }
        }
        for p in 0..den[last].data.len() {
            den[last].data[p] += current_mask.data[p];
        }
    }

    if stop() {
        return None;
    }
    on_progress(0.95, "Assembling the panorama");
    let mut out = ImageBuf::new(width, height);
    for p in 0..width * height {
        if owner[p] < 0 {
            continue;
        }
        let mut rgb = [0.0f32; 3];
        for k in 0..bands {
            let d = den[k].data[p];
            if d <= 1e-6 {
                continue;
            }
            for (c, v) in rgb.iter_mut().enumerate() {
                *v += num[k][c].data[p] / d;
            }
        }
        out.data[p * 4] = rgb[0].max(0.0);
        out.data[p * 4 + 1] = rgb[1].max(0.0);
        out.data[p * 4 + 2] = rgb[2].max(0.0);
        out.data[p * 4 + 3] = 1.0;
    }
    Some(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A frame solved at the registration size lands where its solve put
    /// it (the 26.4.3 latest review's R1). Registration scales a frame by
    /// slightly different factors across and down, each side rounding on
    /// its own: 333 x 6000 registers at 114 x 2048. Every full-size pixel
    /// is the registered pixel scaled by those two factors, so it must
    /// reach the canvas where the registered pixel does; converting the
    /// camera by the across factor alone put the frame's ends 8 output
    /// pixels away at 4000 pixels a radian.
    #[test]
    fn a_registered_frame_lands_where_its_solve_put_it() {
        let (full, reg) = ((333usize, 6000usize), (114usize, 2048usize));
        let (sx, sy) = (full.0 as f64 / reg.0 as f64, full.1 as f64 / reg.1 as f64);
        let solved = cam(1800.0, [0.1, 0.3, 0.0]);
        let (small, big) = (ImageBuf::new(reg.0, reg.1), ImageBuf::new(full.0, full.1));
        let at_reg = Frame::new(&small, solved);
        let at_full = Frame { image: &big, camera: Camera { f: solved.f * sx, r: solved.r }, aspect: sy / sx };
        let across_only = Frame::new(&big, Camera { f: solved.f * sx, r: solved.r });
        let proj = Projection { surface: Surface::Spherical, scale: 4000.0, origin_x: 0.0, origin_y: 0.0, yaw: 0.0 };
        let mut worst_old = 0.0f64;
        for (u, v) in [(0.0, 0.0), (57.0, 0.0), (114.0, 2048.0), (0.0, 1024.0), (114.0, 300.0)] {
            let want = to_canvas(&proj, &at_reg, u, v, reg.0, reg.1).unwrap();
            let got = to_canvas(&proj, &at_full, u * sx, v * sy, full.0, full.1).unwrap();
            assert!((got.0 - want.0).abs() < 1e-6 && (got.1 - want.1).abs() < 1e-6, "pixel ({u}, {v}): {got:?} against {want:?}");
            let old = to_canvas(&proj, &across_only, u * sx, v * sy, full.0, full.1).unwrap();
            worst_old = worst_old.max((old.0 - want.0).hypot(old.1 - want.1));
        }
        assert!(worst_old > 5.0, "the across-only conversion was off by {worst_old} pixels");
    }
    use crate::geom::rodrigues;

    fn cam(f: f64, w: [f64; 3]) -> Camera {
        Camera { f, r: rodrigues(w) }
    }

    /// A scene painted on a sphere, so every frame of it is a genuine
    /// perspective view of the same thing rather than a crop.
    fn render(cam: &Camera, w: usize, h: usize, gain: f32) -> ImageBuf {
        let mut img = ImageBuf::new(w, h);
        for y in 0..h {
            for x in 0..w {
                let d = [
                    (x as f64 - w as f64 * 0.5) / cam.f,
                    (y as f64 - h as f64 * 0.5) / cam.f,
                    1.0,
                ];
                let world = cam.r.transpose().mul_vec(d);
                let len = (world[0] * world[0] + world[1] * world[1] + world[2] * world[2]).sqrt();
                let (theta, phi) =
                    (world[0].atan2(world[2]), (world[1] / len).clamp(-1.0, 1.0).asin());
                // Deterministic pattern in world angles: whatever frame
                // looks at it, it looks the same.
                let v = 0.45
                    + 0.2 * (theta * 9.0).sin() * (phi * 7.0).cos()
                    + 0.15 * (theta * 21.0 + phi * 3.0).sin();
                let v = (v as f32 * gain).clamp(0.0, 1.5);
                img.set_pixel(x, y, [v, v * 0.9, v * 0.8, 1.0]);
            }
        }
        img
    }

    #[test]
    fn a_ray_and_its_pixel_are_inverses() {
        for surface in [Surface::Planar, Surface::Cylindrical, Surface::Spherical] {
            // yaw 0 and a shifted canvas alike: the shift must round-trip.
            for yaw in [0.0, 1.1] {
                let p = Projection { surface, scale: 500.0, origin_x: 300.0, origin_y: 200.0, yaw };
                for (x, y) in [(300.0, 200.0), (450.0, 260.0), (120.0, 90.0)] {
                    let d = p.ray(x, y);
                    let (bx, by) = p.place(d).expect("a ray from the surface lands on it");
                    assert!(
                        (bx - x).abs() < 1e-6 && (by - y).abs() < 1e-6,
                        "{surface:?} yaw {yaw}: ({x}, {y}) came back as ({bx}, {by})"
                    );
                }
            }
        }
    }

    #[test]
    fn the_seam_moves_into_the_largest_gap() {
        use std::f64::consts::PI;
        let img = ImageBuf::new(40, 40);
        // rodrigues([0, t, 0]) makes a camera that looks at yaw -t.
        let frame_at = |theta: f64| Frame::new(&img, cam(500.0, [0.0, theta, 0.0]));

        // Frames looking at yaws -150, 180 and 150 degrees: the content
        // straddles the +-PI line and the open water is straight ahead,
        // so the canvas must turn by PI (either sign, the same seam).
        let crossing = [
            frame_at(150.0f64.to_radians()),
            frame_at(PI),
            frame_at(-150.0f64.to_radians()),
        ];
        let shift = yaw_shift_for(&crossing, Surface::Spherical);
        assert!((shift.abs() - PI).abs() < 0.05, "shift was {shift}");

        // Frames already facing forward: the gap is behind and the seam
        // stays where it was.
        let ahead = [frame_at(20.0f64.to_radians()), frame_at(-20.0f64.to_radians())];
        let shift = yaw_shift_for(&ahead, Surface::Spherical);
        assert!(shift.abs() < 0.05, "shift was {shift}");

        // A planar canvas has no seam to move.
        assert_eq!(yaw_shift_for(&crossing, Surface::Planar), 0.0);
    }

    #[test]
    fn frame_weight_peaks_in_the_middle_and_vanishes_at_the_edge() {
        assert!((frame_weight(50.0, 50.0, 100, 100) - 1.0).abs() < 1e-6);
        assert!(frame_weight(0.0, 50.0, 100, 100) < 1e-6);
        assert!(frame_weight(50.0, 100.0, 100, 100) < 1e-6);
        // Halfway out is worth less than the middle, more than the edge.
        let mid = frame_weight(25.0, 50.0, 100, 100);
        assert!(mid > 0.4 && mid < 0.6, "got {mid}");
    }

    /// One frame in, the same frame out: the panorama of a single
    /// photograph is that photograph.
    #[test]
    fn a_single_frame_composites_to_itself() {
        let c = cam(400.0, [0.0, 0.0, 0.0]);
        let img = render(&c, 200, 150, 1.0);
        let out = composite(
            &[Frame::new(&img, c)],
            &CompositeOpts { surface: Surface::Planar, ..Default::default() },
        )
        .unwrap();
        assert!(out.width >= 190 && out.width <= 210, "width {}", out.width);

        // Sample the middle, where the mapping is closest to identity.
        let (ox, oy) = (out.width / 2, out.height / 2);
        let a = out.pixel(ox, oy);
        let b = img.pixel(img.width / 2, img.height / 2);
        for c in 0..3 {
            assert!((a[c] - b[c]).abs() < 0.02, "channel {c}: {} vs {}", a[c], b[c]);
        }
    }

    #[test]
    fn compositing_nothing_returns_nothing() {
        assert!(composite(&[], &CompositeOpts::default()).is_none());
    }

    /// Two overlapping views of one scene must produce a panorama wider
    /// than either, with no hole in the middle.
    #[test]
    fn two_frames_become_one_wider_image() {
        let a = cam(300.0, [0.0, -0.25, 0.0]);
        let b = cam(300.0, [0.0, 0.25, 0.0]);
        let ia = render(&a, 240, 180, 1.0);
        let ib = render(&b, 240, 180, 1.0);
        let out = composite(
            &[Frame::new(&ia, a), Frame::new(&ib, b)],
            &CompositeOpts { surface: Surface::Cylindrical, ..Default::default() },
        )
        .unwrap();

        assert!(out.width > 300, "panorama is only {} wide", out.width);
        // Nothing transparent along the middle row: the two frames
        // overlap, so the span between them is covered.
        let y = out.height / 2;
        for x in 5..out.width - 5 {
            assert!(out.pixel(x, y)[3] > 0.5, "hole at x = {x}");
        }
    }

    /// The gain solve, in isolation. Two frames whose overlap disagrees
    /// by a factor of two should be pulled toward each other rather than
    /// one being dragged onto the other.
    #[test]
    fn gains_pull_disagreeing_frames_together() {
        let mean = vec![vec![0.0, 100.0], vec![50.0, 0.0]];
        let counts = vec![vec![0.0, 1000.0], vec![1000.0, 0.0]];
        let g = solve_gains(&mean, &counts);
        assert_eq!(g.len(), 2);
        // The bright frame is turned down, the dark one up.
        assert!(g[0] < 1.0 && g[1] > 1.0, "gains {g:?}");
        // And they now agree: g0 * 100 should be near g1 * 50.
        let (l, r) = (g[0] * 100.0, g[1] * 50.0);
        assert!((l - r).abs() / l < 0.25, "still disagreeing: {l} vs {r}");
    }

    /// The prior on gains is what stops the trivial solution. Frames that
    /// already agree must be left alone rather than drifting off together.
    #[test]
    fn gains_stay_near_one_when_the_frames_already_agree() {
        let mean = vec![vec![0.0, 80.0], vec![80.0, 0.0]];
        let counts = vec![vec![0.0, 5000.0], vec![5000.0, 0.0]];
        let g = solve_gains(&mean, &counts);
        for v in &g {
            assert!((v - 1.0).abs() < 0.05, "gain drifted to {v}");
        }
        assert!(solve_gains(&[], &[]).is_empty());
    }

    /// End to end: the same scene shot twice, one frame a stop and a bit
    /// brighter. Gain compensation should leave the seam invisible.
    #[test]
    fn a_brightness_difference_between_frames_is_evened_out() {
        let a = cam(300.0, [0.0, -0.22, 0.0]);
        let b = cam(300.0, [0.0, 0.22, 0.0]);
        let ia = render(&a, 240, 180, 1.0);
        let ib = render(&b, 240, 180, 1.35);

        let opts = CompositeOpts { surface: Surface::Cylindrical, ..Default::default() };
        let with = composite(
            &[Frame::new(&ia, a), Frame::new(&ib, b)],
            &opts,
        )
        .unwrap();
        let without = composite(
            &[Frame::new(&ia, a), Frame::new(&ib, b)],
            &CompositeOpts { gain_compensation: false, ..opts.clone() },
        )
        .unwrap();

        // Compare the far left against the far right: the two frames'
        // own territory, away from the blend.
        let spread = |img: &ImageBuf| {
            let y = img.height / 2;
            let mut left = 0.0;
            let mut right = 0.0;
            let span = img.width / 6;
            for x in 0..span {
                left += img.pixel(x + span / 2, y)[0];
                right += img.pixel(img.width - 1 - x - span / 2, y)[0];
            }
            ((left - right) / span as f32).abs()
        };
        let before = spread(&without);
        let after = spread(&with);
        assert!(after < before * 0.6, "gain compensation barely helped: {before} -> {after}");
    }

    /// Multi-band blending exists to hide the seam. Across the join, the
    /// image should vary no more sharply than it does inside a frame.
    #[test]
    fn the_seam_between_two_frames_is_not_visible_as_a_step() {
        let a = cam(300.0, [0.0, -0.20, 0.0]);
        let b = cam(300.0, [0.0, 0.20, 0.0]);
        let ia = render(&a, 240, 180, 1.0);
        let ib = render(&b, 240, 180, 1.18);
        let out = composite(
            &[Frame::new(&ia, a), Frame::new(&ib, b)],
            &CompositeOpts { surface: Surface::Cylindrical, ..Default::default() },
        )
        .unwrap();

        // The largest step between neighboring pixels along the middle
        // row. A visible seam shows up here as a spike well above the
        // scene's own texture.
        let y = out.height / 2;
        let mut steps: Vec<f32> = Vec::new();
        for x in 4..out.width - 5 {
            if out.pixel(x, y)[3] < 0.5 || out.pixel(x + 1, y)[3] < 0.5 {
                continue;
            }
            steps.push((out.pixel(x + 1, y)[0] - out.pixel(x, y)[0]).abs());
        }
        assert!(steps.len() > 50);
        let mut sorted = steps.clone();
        sorted.sort_by(|p, q| p.partial_cmp(q).unwrap());
        let median = sorted[sorted.len() / 2];
        let worst = *sorted.last().unwrap();
        assert!(
            worst < median * 12.0 + 0.02,
            "a step of {worst} against a typical {median} looks like a seam"
        );
    }

    /// The accounting has to reflect what is actually allocated, because
    /// the budget is what stands between an ambitious panorama and an
    /// allocation failure.
    #[test]
    fn the_memory_estimate_grows_with_frames_and_bands() {
        let one = bytes_per_pixel(1, 1);
        assert!(bytes_per_pixel(6, 1) > one, "every frame is held at once");
        assert!(bytes_per_pixel(1, 4) > one, "every band has its own accumulator");
        // Six frames into four bands: a little over 200 bytes a pixel, so
        // a 2 GiB budget is around ten megapixels.
        let six = bytes_per_pixel(6, 4);
        assert!((190..=240).contains(&six), "estimate drifted to {six}");
        assert!((2usize << 30) / six > 8_000_000, "budget should allow a real panorama");
    }

    #[test]
    fn natural_panorama_width_is_not_limited_to_eight_thousand_pixels() {
        let a = cam(10_000.0, [0.0, -0.5, 0.0]);
        let b = cam(10_000.0, [0.0, 0.5, 0.0]);
        let ia = render(&a, 6000, 4, 1.0);
        let ib = render(&b, 6000, 4, 1.0);
        let frames = [Frame::new(&ia, a), Frame::new(&ib, b)];
        heeler_engine::memory::with_budget(3 << 30, || {
            let out = composite(&frames, &CompositeOpts { max_dimension: usize::MAX, ..Default::default() }).unwrap();
            assert!(out.width > 8000, "natural width was silently reduced: {}", out.width);
            assert!(out.height < 16, "this test must remain a small allocation");
        });
    }

    #[test]
    fn memory_refusal_preserves_the_requested_canvas() {
        let a = cam(300.0, [0.0, -0.22, 0.0]);
        let b = cam(300.0, [0.0, 0.22, 0.0]);
        let ia = render(&a, 240, 180, 1.0);
        let ib = render(&b, 240, 180, 1.0);
        let frames = [Frame::new(&ia, a), Frame::new(&ib, b)];
        let opts = CompositeOpts { max_dimension: 100_000, memory_budget: 1, ..Default::default() };
        heeler_engine::memory::with_budget(1024, || {
            assert!(heeler_engine::memory::catch(|| composite(&frames, &opts)).is_err());
        });
        let out = composite(&frames, &opts).unwrap();
        assert!(out.width * out.height > 14_000, "the legacy budget must not silently shrink a panorama");
    }

    #[test]
    fn the_output_respects_the_size_cap() {
        let a = cam(600.0, [0.0, -0.3, 0.0]);
        let b = cam(600.0, [0.0, 0.3, 0.0]);
        let ia = render(&a, 300, 200, 1.0);
        let ib = render(&b, 300, 200, 1.0);
        let out = composite(
            &[Frame::new(&ia, a), Frame::new(&ib, b)],
            &CompositeOpts { max_dimension: 200, ..Default::default() },
        )
        .unwrap();
        assert!(out.width <= 200 && out.height <= 200, "{} x {}", out.width, out.height);
        assert!(out.width > 100, "shrunk too far: {}", out.width);
    }
}
