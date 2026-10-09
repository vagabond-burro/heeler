//! The whole thing, end to end.
//!
//! Hand this a pile of photographs and it works out which of them belong
//! to a panorama, how the camera was pointed for each, and paints them
//! onto one surface. Nothing tells it the order they were shot in,
//! whether they form one panorama or three, or which of them is a
//! photograph of the dog. That is the point of the Brown and Lowe
//! pipeline: recognition first, stitching second.

use crate::bundle::{
    bundle_adjust, estimate_focals, initial_cameras, rms_error, rotate_all, straighten, Camera,
    PairConstraint,
};
use crate::composite::{composite_with_control, CompositeOpts, Frame, Surface};
use crate::features::detect;
use crate::geom::Mat3;
use crate::gray::Gray;
use crate::matching::match_images;
use heeler_engine::buffers::ImageBuf;

/// Features kept per image. Matching cost grows with the square of this,
/// and past a couple of thousand the extra points are describing the
/// same textures over again.
const FEATURE_LIMIT: usize = 1500;
/// The long edge every frame is registered at: features, matching and
/// the solve run on each frame scaled down to this, and the cameras are
/// converted back to the frame's own pixels for the composite. A
/// preview's frames and the full-size frames then solve the same
/// picture, so the two agree on which frames belong and where (the
/// 26.4.3 branch review's R1: a five-frame RW2 panorama solved five
/// cameras at the preview and three at full size, where the 1500
/// strongest features of a 20 megapixel frame were fine texture that
/// matched nothing). 2048 is the preview's own size, so a preview at
/// the default edge solves exactly as it did; on that set 1.5 megapixels
/// and up kept all five frames and 1 megapixel lost one. A preview
/// smaller than this reads its frames at this edge to register them.
pub const REGISTER_EDGE: usize = 2048;
/// Above this vertical spread, a cylinder cannot hold the panorama and
/// it has to go on a sphere. Radians.
const MULTI_ROW_TILT: f64 = 0.35;

#[derive(Debug, Clone)]
pub struct StitchOpts {
    /// None picks between a cylinder and a sphere by how much the
    /// cameras tilt.
    pub surface: Option<Surface>,
    pub max_dimension: usize,
    pub gain_compensation: bool,
    pub bands: usize,
    /// Level the result. Almost always wanted: nobody pans level.
    pub straighten: bool,
    /// Legacy option retained for callers. The shared machine budget admits
    /// the requested canvas or refuses it without changing its resolution.
    pub memory_budget: usize,
}

impl Default for StitchOpts {
    fn default() -> Self {
        StitchOpts {
            surface: None,
            max_dimension: 8000,
            gain_compensation: true,
            bands: 4,
            straighten: true,
            memory_budget: 2 << 30,
        }
    }
}

#[derive(Debug, Clone)]
pub struct Stitched {
    pub image: ImageBuf,
    /// Which of the inputs went in, by their original index. Frames that
    /// did not overlap anything are simply absent.
    pub used: Vec<usize>,
    /// Root mean square reprojection error, in pixels. How well the
    /// cameras actually agree.
    pub rms: f64,
}

/// Why a stitch produced nothing.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum StitchError {
    /// Fewer than two images to work with.
    NotEnoughImages,
    /// No two images were found to overlap.
    NoOverlap,
    /// The cameras solved, but nothing could be painted from them.
    NothingToDraw,
    /// The caller's stop answered true (stitch_with_control).
    Canceled,
}

/// Translates between pixel coordinates and coordinates measured from
/// the image center, which is what the camera model uses.
fn centring(width: usize, height: usize) -> Mat3 {
    Mat3([1.0, 0.0, -(width as f64) * 0.5, 0.0, 1.0, -(height as f64) * 0.5, 0.0, 0.0, 1.0])
}

/// Groups images into panoramas: everything reachable through confirmed
/// overlaps belongs together.
fn components(n: usize, edges: &[(usize, usize)]) -> Vec<Vec<usize>> {
    let mut parent: Vec<usize> = (0..n).collect();
    fn find(parent: &mut Vec<usize>, mut i: usize) -> usize {
        while parent[i] != i {
            parent[i] = parent[parent[i]];
            i = parent[i];
        }
        i
    }
    for &(a, b) in edges {
        let (ra, rb) = (find(&mut parent, a), find(&mut parent, b));
        if ra != rb {
            parent[ra] = rb;
        }
    }
    let mut groups: Vec<Vec<usize>> = vec![Vec::new(); n];
    for i in 0..n {
        let r = find(&mut parent, i);
        groups[r].push(i);
    }
    groups.retain(|g| g.len() > 1);
    groups.sort_by_key(|g| std::cmp::Reverse(g.len()));
    groups
}

/// Where the whole job stands, for anyone waiting on it.
///
/// The fractions below are not evenly spaced because the stages are not
/// evenly expensive. They are roughly what each costs on a handful of
/// full-size frames, so the bar moves at something like a constant rate
/// rather than sitting at 90% for most of the wait.
const P_DETECT: f32 = 0.30;
const P_MATCH: f32 = 0.70;
const P_SOLVE: f32 = 0.78;

/// Runs the pipeline over a set of images.
///
/// The largest group of mutually overlapping images wins. A photograph
/// that overlaps nothing is dropped rather than forced in, which is what
/// makes it safe to select a whole folder.
///
/// Frames it drops are reported to the caller through `used`, which
/// the desktop turns into a console line naming the members left out.
pub fn stitch(images: &[&ImageBuf], opts: &StitchOpts) -> Result<Stitched, StitchError> {
    stitch_with_progress(images, opts, &|_, _| {})
}

/// The same, reporting how far along it is.
///
/// Stitching a real set of frames takes long enough that silence reads
/// as a hang: the only sign anything is happening is the machine getting
/// hot. `on_progress` is called with a fraction from 0 to 1 and a short
/// description of what is being done.
pub fn stitch_with_progress(
    images: &[&ImageBuf],
    opts: &StitchOpts,
    on_progress: &dyn Fn(f32, &str),
) -> Result<Stitched, StitchError> {
    stitch_with_control(images, opts, on_progress, &|| false)
}

/// The same, stopping when `stop` answers true: it is asked wherever
/// progress is reported (each frame's features, each pair matched, the
/// solve, and through the composite), and a stopped stitch answers
/// Canceled (2026-10-08: "pano stitching is missing a cancel button
/// like stacking has"). A unit of work under way finishes first: one
/// frame's features, one pair, the solve, one frame's warp or blend.
pub fn stitch_with_control(
    images: &[&ImageBuf],
    opts: &StitchOpts,
    on_progress: &dyn Fn(f32, &str),
    stop: &dyn Fn() -> bool,
) -> Result<Stitched, StitchError> {
    if images.len() < 2 {
        return Err(StitchError::NotEnoughImages);
    }

    let n = images.len();
    let mut features = Vec::with_capacity(n);
    // Each frame's registration size: everything up to the solve is
    // measured in these pixels (REGISTER_EDGE).
    let mut reg: Vec<(usize, usize)> = Vec::with_capacity(n);
    for (i, img) in images.iter().enumerate() {
        if stop() {
            return Err(StitchError::Canceled);
        }
        on_progress(
            P_DETECT * i as f32 / n as f32,
            &format!("Finding features in frame {} of {n}", i + 1),
        );
        let gray = match register_edge(img.width, img.height) {
            Some(edge) => Gray::from_image(&heeler_engine::downscale::downscale_area(img, edge)),
            None => Gray::from_image(img),
        };
        reg.push((gray.width, gray.height));
        features.push(detect(&gray, FEATURE_LIMIT));
    }

    // Every pair, both to decide what belongs together and to collect the
    // correspondences the solver will use.
    let total_pairs = (n * n.saturating_sub(1) / 2).max(1);
    let mut done_pairs = 0usize;
    let mut edges = Vec::new();
    let mut pairs = Vec::new();
    for i in 0..images.len() {
        for j in i + 1..images.len() {
            if stop() {
                return Err(StitchError::Canceled);
            }
            on_progress(
                P_DETECT + (P_MATCH - P_DETECT) * done_pairs as f32 / total_pairs as f32,
                &format!("Matching frames {} and {}", i + 1, j + 1),
            );
            done_pairs += 1;
            let Some(m) = match_images(&features[i], &features[j], reg[j]) else {
                continue;
            };
            if !m.confirmed {
                continue;
            }
            edges.push((i, j));
            // Into centered coordinates, which is where the camera model
            // lives: H_centred = C_j H C_i".
            let ci = centring(reg[i].0, reg[i].1);
            let cj = centring(reg[j].0, reg[j].1);
            let Some(ci_inv) = ci.inverse() else { continue };
            let h = cj.mul(&m.h).mul(&ci_inv);
            let points = m
                .inliers
                .iter()
                .map(|c| {
                    let a = &features[i][c.a].kp;
                    let b = &features[j][c.b].kp;
                    (
                        (a.x as f64 - reg[i].0 as f64 * 0.5, a.y as f64 - reg[i].1 as f64 * 0.5),
                        (b.x as f64 - reg[j].0 as f64 * 0.5, b.y as f64 - reg[j].1 as f64 * 0.5),
                    )
                })
                .collect();
            pairs.push((i, j, h, points));
        }
    }

    let groups = components(images.len(), &edges);
    let Some(used) = groups.into_iter().next() else {
        return Err(StitchError::NoOverlap);
    };

    // Renumber into the group's own indices, since the solver works over
    // a dense list of cameras.
    let local: Vec<Option<usize>> = {
        let mut map = vec![None; images.len()];
        for (k, &g) in used.iter().enumerate() {
            map[g] = Some(k);
        }
        map
    };
    let constraints: Vec<PairConstraint> = pairs
        .into_iter()
        .filter_map(|(i, j, h, points)| {
            Some(PairConstraint { i: local[i]?, j: local[j]?, h, points })
        })
        .collect();
    if constraints.is_empty() {
        return Err(StitchError::NoOverlap);
    }

    if stop() {
        return Err(StitchError::Canceled);
    }
    on_progress(P_SOLVE, &format!("Solving {} cameras", used.len()));
    // Per-camera initial focals: a mixed-size selection puts homographies
    // in different pixel units into one solve, so each camera starts from
    // the shared estimate converted into its own pixels.
    let dims: Vec<(usize, usize)> = used.iter().map(|&g| reg[g]).collect();
    let focals = estimate_focals(&constraints, &dims);
    let cams = initial_cameras(used.len(), &constraints, &focals);
    let mut cams = bundle_adjust(&cams, &constraints);
    let rms = rms_error(&cams, &constraints);
    if opts.straighten {
        let level = straighten(&cams);
        cams = rotate_all(&cams, &level);
    }

    let surface = opts.surface.unwrap_or_else(|| auto_surface(&cams));
    // Back from registration pixels to each frame's own: the rotation
    // holds, the focal length scales with the frame.
    let frames: Vec<Frame> = used
        .iter()
        .zip(&cams)
        .map(|(&idx, cam)| frame_at_full_size(images[idx], cam, reg[idx]))
        .collect();
    if stop() {
        return Err(StitchError::Canceled);
    }
    let image = composite_with_control(
        &frames,
        &CompositeOpts {
            surface,
            max_dimension: opts.max_dimension,
            gain_compensation: opts.gain_compensation,
            bands: opts.bands,
            memory_budget: opts.memory_budget,
        },
        &|f, stage| on_progress(P_SOLVE + (1.0 - P_SOLVE) * f, stage),
        stop,
    );
    // A composite that stopped answers None too; the stop says which.
    if stop() {
        return Err(StitchError::Canceled);
    }
    let image = image.ok_or(StitchError::NothingToDraw)?;
    on_progress(1.0, "Done");

    Ok(Stitched { image, used, rms })
}

/// A frame solved at its registration size `reg`, back in its own
/// pixels: the rotation holds, and the focal length scales across and
/// down by each side's own factor (the 26.4.3 latest review's R1).
pub(crate) fn frame_at_full_size<'a>(image: &'a ImageBuf, cam: &Camera, reg: (usize, usize)) -> Frame<'a> {
    let sx = image.width as f64 / reg.0 as f64;
    let sy = image.height as f64 / reg.1 as f64;
    Frame { image, camera: Camera { f: cam.f * sx, r: cam.r }, aspect: sy / sx }
}

/// The long edge a frame is registered at, or None when the frame is
/// already no bigger than REGISTER_EDGE.
fn register_edge(width: usize, height: usize) -> Option<usize> {
    (width.max(height) > REGISTER_EDGE).then_some(REGISTER_EDGE)
}

/// A cylinder keeps verticals vertical and is the right surface for a
/// single row. Once the camera has been tilted through much of an angle
/// the panorama no longer fits on one, and it has to go on a sphere.
pub fn auto_surface(cams: &[Camera]) -> Surface {
    let mut lo = f64::INFINITY;
    let mut hi = f64::NEG_INFINITY;
    for c in cams {
        // Where this camera is looking, as an elevation.
        let d = c.r.transpose().mul_vec([0.0, 0.0, 1.0]);
        let elev = d[1].clamp(-1.0, 1.0).asin();
        lo = lo.min(elev);
        hi = hi.max(elev);
    }
    if hi - lo > MULTI_ROW_TILT {
        Surface::Spherical
    } else {
        Surface::Cylindrical
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::geom::rodrigues;

    fn cam(f: f64, w: [f64; 3]) -> Camera {
        Camera { f, r: rodrigues(w) }
    }

    /// The world, as an equirectangular texture: aperiodic blobs at a
    /// range of scales.
    ///
    /// Blobs, and not a sum of sinusoids, because a sinusoid is periodic
    /// and every crest of it looks like every other crest, so the ratio
    /// test correctly throws the whole thing away. Blobs, and not blurred
    /// noise, because blurring noise to a given scale leaves almost no
    /// energy in the narrow band a difference-of-Gaussians actually
    /// measures. A blob is what a DoG extremum *is*, which is what makes
    /// it the honest fixture here.
    fn world_texture() -> Gray {
        // Big enough that a 260 pixel view samples it at roughly 1:1. A
        // smaller world would be magnified by the camera, smoothing away
        // exactly the fine detail the detector lives on.
        let (w, h) = (1800usize, 900usize);
        let mut g = Gray::new(w, h);
        for v in g.data.iter_mut() {
            *v = 0.35;
        }
        let mut state = 0x51ED_2701u32;
        let mut next = || {
            state ^= state << 13;
            state ^= state >> 17;
            state ^= state << 5;
            (state % 100_000) as f32 / 100_000.0
        };
        // Dense enough that a single view holds a few hundred of them,
        // which is the order a real photograph gives.
        for _ in 0..14_000 {
            let cx = next() * w as f32;
            let cy = next() * h as f32;
            let sigma = 1.4 + next() * 4.0;
            let amp = (next() - 0.5) * 0.8;
            let r = (sigma * 3.0).ceil() as isize;
            for dy in -r..=r {
                for dx in -r..=r {
                    let (x, y) = (cx as isize + dx, cy as isize + dy);
                    if x < 0 || y < 0 || x >= w as isize || y >= h as isize {
                        continue;
                    }
                    let d2 = (dx * dx + dy * dy) as f32;
                    let v = amp * (-d2 / (2.0 * sigma * sigma)).exp();
                    let p = y as usize * w + x as usize;
                    g.data[p] += v;
                }
            }
        }
        for v in g.data.iter_mut() {
            *v = v.clamp(0.03, 1.0);
        }
        g
    }

    /// A perspective view of that world, so two frames are genuine views
    /// of the same scene rather than crops of one picture.
    fn view_of(tex: &Gray, cam: &Camera, w: usize, h: usize) -> ImageBuf {
        let mut img = ImageBuf::new(w, h);
        for y in 0..h {
            for x in 0..w {
                let d = [
                    (x as f64 - w as f64 * 0.5) / cam.f,
                    (y as f64 - h as f64 * 0.5) / cam.f,
                    1.0,
                ];
                let world = cam.r.transpose().mul_vec(d);
                let len =
                    (world[0] * world[0] + world[1] * world[1] + world[2] * world[2]).sqrt();
                let theta = world[0].atan2(world[2]);
                let phi = (world[1] / len).clamp(-1.0, 1.0).asin();
                let tx = (theta / std::f64::consts::TAU + 0.5) * tex.width as f64;
                let ty = (phi / std::f64::consts::PI + 0.5) * tex.height as f64;
                let v = tex.sample(tx as f32, ty as f32);
                img.set_pixel(x, y, [v, v * 0.94, v * 0.88, 1.0]);
            }
        }
        img
    }

    #[test]
    fn components_group_what_overlaps_and_drop_what_does_not() {
        // 0-1-2 form one panorama, 3 and 4 another, 5 is alone.
        let groups = components(6, &[(0, 1), (1, 2), (3, 4)]);
        assert_eq!(groups.len(), 2);
        assert_eq!(groups[0], vec![0, 1, 2]);
        assert_eq!(groups[1], vec![3, 4]);
        assert!(components(3, &[]).is_empty(), "nothing overlapping is no panorama");
    }

    #[test]
    fn fewer_than_two_images_is_refused() {
        let c = cam(300.0, [0.0, 0.0, 0.0]);
        let img = view_of(&world_texture(), &c, 64, 48);
        assert_eq!(stitch(&[], &StitchOpts::default()).unwrap_err(), StitchError::NotEnoughImages);
        assert_eq!(
            stitch(&[&img], &StitchOpts::default()).unwrap_err(),
            StitchError::NotEnoughImages
        );
    }

    #[test]
    fn a_single_row_goes_on_a_cylinder_and_a_tilted_set_on_a_sphere() {
        let row: Vec<Camera> =
            (0..4).map(|i| cam(500.0, [0.0, 0.2 * i as f64, 0.0])).collect();
        assert_eq!(auto_surface(&row), Surface::Cylindrical);
        let mut grid = row.clone();
        grid.push(cam(500.0, [0.5, 0.2, 0.0]));
        assert_eq!(auto_surface(&grid), Surface::Spherical);
    }

    #[test]
    #[ignore = "offline panorama scaling fixture"]
    fn bench_member_counts() {
        use std::{cell::Cell, sync::Arc, time::Instant};
        let tex = world_texture();
        for count in [2, 4, 8, 16] {
            heeler_engine::memory::with_budget(4usize << 30, || {
                let imgs: Vec<_> = (0..count).map(|i| Arc::new(view_of(&tex, &cam(320.0, [0.0, -0.3 + 0.6 * i as f64 / (count - 1) as f64, 0.0]), 260, 200))).collect();
                for image in &imgs { heeler_engine::memory::budget().track_image(image); }
                let refs: Vec<_> = imgs.iter().map(Arc::as_ref).collect();
                let start = Instant::now();
                let composite_start = Cell::new(None);
                let matching_start = Cell::new(None);
                let solving_start = Cell::new(None);
                let out = stitch_with_progress(&refs, &StitchOpts::default(), &|_, stage| {
                    if stage.starts_with("Matching frames") && matching_start.get().is_none() { matching_start.set(Some(Instant::now())); }
                    if stage.starts_with("Solving") { solving_start.set(Some(Instant::now())); }
                    if stage.starts_with("Warping") && composite_start.get().is_none() { composite_start.set(Some(Instant::now())); }
                    heeler_engine::memory::budget().snapshot();
                }).expect("synthetic views overlap");
                let end = Instant::now();
                let split = composite_start.get().expect("composite progress");
                let matching = matching_start.get().unwrap();
                let solving = solving_start.get().unwrap();
                println!("panorama-profile members={count} detect_ms={:.3} matching_ms={:.3} solve_ms={:.3}", (matching-start).as_secs_f64()*1000.0,(solving-matching).as_secs_f64()*1000.0,(split-solving).as_secs_f64()*1000.0);
                assert_eq!(out.used.len(), count);
                let m = heeler_engine::memory::budget().snapshot();
                println!("panorama members={count} pairs={} alignment_ms={:.3} composite_ms={:.3} accounted_peak_bytes={} canvas={}x{}", count*(count-1)/2, (split-start).as_secs_f64()*1000.0, (end-split).as_secs_f64()*1000.0,m.peak,out.image.width,out.image.height);
            });
        }
    }

    /// The whole pipeline on three overlapping views: detect, match,
    /// verify, solve, straighten, blend. The cameras have to come out
    /// close enough that the reprojection error is subpixel, and the
    /// panorama has to be wider than any single frame.
    #[test]
    fn three_overlapping_views_become_one_panorama() {
        let cams = [
            cam(320.0, [0.0, -0.30, 0.0]),
            cam(320.0, [0.0, 0.0, 0.0]),
            cam(320.0, [0.0, 0.30, 0.0]),
        ];
        let tex = world_texture();
        let imgs: Vec<ImageBuf> = cams.iter().map(|c| view_of(&tex, c, 260, 200)).collect();
        let refs: Vec<&ImageBuf> = imgs.iter().collect();

        let out = stitch(&refs, &StitchOpts::default()).expect("a panorama");
        assert_eq!(out.used, vec![0, 1, 2], "every frame should have been used");
        assert!(out.rms < 2.0, "cameras disagree by {} pixels", out.rms);
        assert!(out.image.width > 320, "panorama only {} wide", out.image.width);

        // Continuous across the middle: no hole where the frames meet.
        let y = out.image.height / 2;
        let covered = (0..out.image.width).filter(|&x| out.image.pixel(x, y)[3] > 0.5).count();
        assert!(
            covered as f32 > out.image.width as f32 * 0.9,
            "only {covered} of {} pixels covered",
            out.image.width
        );
    }

    /// A stitch stops where it is asked to (2026-10-08: "pano
    /// stitching is missing a cancel button like stacking has"): at the
    /// start, in matching, at the solve and inside the composite, each
    /// answers Canceled, and nothing after the stop is reported. A stop
    /// that never fires changes nothing.
    #[test]
    fn a_stitch_stops_where_it_is_asked_to() {
        let cams = [
            cam(320.0, [0.0, -0.30, 0.0]),
            cam(320.0, [0.0, 0.0, 0.0]),
            cam(320.0, [0.0, 0.30, 0.0]),
        ];
        let tex = world_texture();
        let imgs: Vec<ImageBuf> = cams.iter().map(|c| view_of(&tex, c, 260, 200)).collect();
        let refs: Vec<&ImageBuf> = imgs.iter().collect();
        let opts = StitchOpts::default();

        // Every stage the full run reports, in order.
        let stages = std::cell::RefCell::new(Vec::<String>::new());
        let whole = stitch_with_control(&refs, &opts, &|_, s| stages.borrow_mut().push(s.to_string()), &|| false).expect("a panorama");
        assert_eq!(whole.image.data, stitch(&refs, &opts).unwrap().image.data, "a stop that never fires changes nothing");
        let stages = stages.into_inner();
        let at = |prefix: &str| stages.iter().position(|s| s.starts_with(prefix)).unwrap_or_else(|| panic!("no {prefix} in {stages:?}"));

        for stop_before in [0, at("Matching frames"), at("Solving"), at("Warping frame 2"), at("Blending frame"), at("Assembling")] {
            let reported = std::cell::Cell::new(0usize);
            let out = stitch_with_control(
                &refs,
                &opts,
                &|_, _| reported.set(reported.get() + 1),
                &|| reported.get() >= stop_before,
            );
            assert_eq!(out.unwrap_err(), StitchError::Canceled, "stop before stage {stop_before}");
            assert_eq!(reported.get(), stop_before, "nothing reported after the stop at {stop_before}");
        }
    }

    /// Cancel is asked inside a frame's blend, not only between frames
    /// (the 26.4.3 branch review's R2: a full-size blend ran ten seconds
    /// before it asked). A stop that fires on the second question after
    /// the first frame's blend begins ends the stitch inside that frame:
    /// the second frame's blend is never reported. Asked only between
    /// frames, the second question came after it.
    #[test]
    fn a_stitch_stops_inside_a_frames_blend() {
        let cams = [
            cam(320.0, [0.0, -0.30, 0.0]),
            cam(320.0, [0.0, 0.0, 0.0]),
            cam(320.0, [0.0, 0.30, 0.0]),
        ];
        let tex = world_texture();
        let imgs: Vec<ImageBuf> = cams.iter().map(|c| view_of(&tex, c, 260, 200)).collect();
        let refs: Vec<&ImageBuf> = imgs.iter().collect();
        let stages = std::cell::RefCell::new(Vec::<String>::new());
        let asked = std::cell::Cell::new(0usize);
        let out = stitch_with_control(&refs, &StitchOpts::default(), &|_, s| stages.borrow_mut().push(s.to_string()), &|| {
            if !stages.borrow().iter().any(|s| s.starts_with("Blending frame 1")) {
                return false;
            }
            asked.set(asked.get() + 1);
            asked.get() >= 2
        });
        assert_eq!(out.unwrap_err(), StitchError::Canceled);
        let stages = stages.into_inner();
        assert!(!stages.iter().any(|s| s.starts_with("Blending frame 2")), "the blend ran on to the next frame: {stages:?}");
    }

    /// Registration runs at REGISTER_EDGE: the same views rendered at
    /// two sizes above it solve the same frames with the same error in
    /// registration pixels, so a preview and a full-size stitch agree
    /// (the 26.4.3 branch review's R1, where a full-size stitch lost
    /// frames its preview kept). Solved at each frame's own size, the
    /// error was measured in different pixels and the solves differed.
    #[test]
    fn a_stitch_solves_the_same_at_any_size_above_the_registration_edge() {
        let tex = world_texture();
        let solve_at = |width: usize| {
            let height = width * 200 / 260;
            let f = 320.0 * width as f64 / 260.0;
            let imgs: Vec<ImageBuf> = [-0.30, 0.0, 0.30].iter().map(|&y| view_of(&tex, &cam(f, [0.0, y, 0.0]), width, height)).collect();
            stitch(&imgs.iter().collect::<Vec<_>>(), &StitchOpts { max_dimension: 800, ..StitchOpts::default() }).expect("the views stitch")
        };
        let (a, b) = (solve_at(REGISTER_EDGE * 5 / 4), solve_at(REGISTER_EDGE * 2));
        assert_eq!(a.used, vec![0, 1, 2]);
        assert_eq!(b.used, a.used, "both sizes solve the same frames");
        // 4% apart registered, 19% apart when each solved at its own size.
        assert!((a.rms / b.rms - 1.0).abs() < 0.1, "the same solve at both sizes: rms {} against {}", a.rms, b.rms);
        let (ra, rb) = (a.image.width as f64 / a.image.height as f64, b.image.width as f64 / b.image.height as f64);
        assert!((ra / rb - 1.0).abs() < 0.03, "the same view: {ra} against {rb}");
    }

    /// A frame registered at a size whose sides round differently comes
    /// back with each side's own scale (R1 of the 26.4.3 latest review).
    #[test]
    fn a_registered_frame_comes_back_at_each_sides_scale() {
        let img = ImageBuf::new(333, 6000);
        let f = frame_at_full_size(&img, &cam(600.0, [0.0, 0.2, 0.0]), (114, 2048));
        assert!((f.camera.f - 600.0 * 333.0 / 114.0).abs() < 1e-9);
        assert!((f.camera.f * f.aspect - 600.0 * 6000.0 / 2048.0).abs() < 1e-9);
        let square = ImageBuf::new(400, 300);
        assert_eq!(frame_at_full_size(&square, &cam(600.0, [0.0; 3]), (400, 300)).aspect, 1.0);
    }

    /// The other half of automatic: a photograph that belongs to nothing
    /// must be left out rather than forced into the panorama.
    #[test]
    fn an_unrelated_photograph_is_left_out() {
        let cams = [cam(320.0, [0.0, -0.26, 0.0]), cam(320.0, [0.0, 0.26, 0.0])];
        let tex = world_texture();
        let mut imgs: Vec<ImageBuf> = cams.iter().map(|c| view_of(&tex, c, 260, 200)).collect();

        // A different scene entirely, at a different scale.
        let mut stranger = ImageBuf::new(260, 200);
        for y in 0..200 {
            for x in 0..260 {
                let v = (0.4
                    + 0.3 * ((x as f32) * 0.31).sin()
                    + 0.2 * ((y as f32) * 0.47).cos())
                .clamp(0.02, 1.0);
                stranger.set_pixel(x, y, [v * 0.8, v, v * 0.7, 1.0]);
            }
        }
        imgs.push(stranger);
        let refs: Vec<&ImageBuf> = imgs.iter().collect();

        let out = stitch(&refs, &StitchOpts::default()).expect("a panorama");
        assert_eq!(out.used, vec![0, 1], "the stranger was stitched in");
    }

    #[test]
    fn images_that_share_nothing_produce_no_panorama() {
        let mut a = ImageBuf::new(120, 90);
        let mut b = ImageBuf::new(120, 90);
        for y in 0..90 {
            for x in 0..120 {
                let u = (0.4 + 0.3 * ((x as f32) * 0.29).sin() * ((y as f32) * 0.23).cos())
                    .clamp(0.02, 1.0);
                let v = (0.5 + 0.3 * ((x as f32) * 0.77).cos() * ((y as f32) * 0.91).sin())
                    .clamp(0.02, 1.0);
                a.set_pixel(x, y, [u, u, u, 1.0]);
                b.set_pixel(x, y, [v, v, v, 1.0]);
            }
        }
        assert_eq!(stitch(&[&a, &b], &StitchOpts::default()).unwrap_err(), StitchError::NoOverlap);
    }
}


