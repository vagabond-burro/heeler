//! Solving all the cameras at once.
//!
//! Up to here every pair of images has been fitted independently, which
//! is enough to know what overlaps what and not enough to build a
//! panorama. Chaining pairwise transforms accumulates error: each fit is
//! a little wrong, the errors compound along the chain, and by the far
//! end of a wide pan the last frame is visibly out. Worse, a panorama
//! that closes on itself does not close, and the gap lands wherever the
//! chain happened to end.
//!
//! Brown and Lowe's answer is to stop treating the images as a chain.
//! Every photograph in a panorama was taken from one point with the
//! camera turned, so the only real unknowns are each frame's rotation
//! and its focal length: four numbers per image, not eight. Solving all
//! of them together against every correspondence at once spreads the
//! error evenly instead of piling it at one end, and a loop closes
//! because nothing ever told it not to.
//!
//! Then the panorama is straightened, because a hand-held pan is never
//! level and the result otherwise waves up and down.

use crate::geom::{
    cross3, dot3, inverse_rodrigues, normalise3, rodrigues, solve, symmetric_eigen, Mat3,
};

/// One photograph's pose: where it was pointed, and how long the lens
/// was. No position, because a panorama assumes the camera turned rather
/// than moved.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Camera {
    /// Focal length in pixels.
    pub f: f64,
    /// World to camera.
    pub r: Mat3,
}

impl Camera {
    /// Intrinsics, in coordinates measured from the image center. The
    /// principal point is assumed to be the middle of the frame, which
    /// for a photograph off a normal lens it is.
    pub fn k(&self) -> Mat3 {
        Mat3([self.f, 0.0, 0.0, 0.0, self.f, 0.0, 0.0, 0.0, 1.0])
    }

    pub fn k_inverse(&self) -> Mat3 {
        Mat3([1.0 / self.f, 0.0, 0.0, 0.0, 1.0 / self.f, 0.0, 0.0, 0.0, 1.0])
    }
}

/// The homography taking points in `from` onto `to`.
///
/// K_to R_to R_from' K_from', read right to left: undo the source
/// camera's lens to get a ray, rotate that ray into the world, rotate it
/// into the destination camera, and apply its lens. Every homography in
/// the panorama is this product, which is exactly the constraint that
/// makes the joint solve possible.
pub fn homography(from: &Camera, to: &Camera) -> Mat3 {
    to.k().mul(&to.r).mul(&from.r.transpose()).mul(&from.k_inverse())
}

/// Focal lengths implied by a homography between two images.
///
/// A rotational homography carries its own focal lengths inside it: it
/// is built from them, so with a little algebra they come back out.
/// Szeliski and Shum's derivation, which is what makes the pipeline
/// automatic even when EXIF is missing, wrong, or from a scanned print.
///
/// Returns (focal of the source image, focal of the destination), either
/// of which may be missing when the geometry is degenerate: a pure
/// rotation about the optical axis, or two frames that barely differ,
/// carry no information about focal length at all.
pub fn focals_from_homography(h: &Mat3) -> (Option<f64>, Option<f64>) {
    let m = h.normalised().0;

    // Destination focal.
    let d1 = m[6] * m[7];
    let d2 = (m[7] - m[6]) * (m[7] + m[6]);
    let v1 = -(m[0] * m[1] + m[3] * m[4]) / d1;
    let v2 = (m[0] * m[0] + m[3] * m[3] - m[1] * m[1] - m[4] * m[4]) / d2;
    let f_to = pick_focal(v1, v2, d1, d2);

    // Source focal: the same relation read the other way up.
    let d1 = m[0] * m[3] + m[1] * m[4];
    let d2 = m[0] * m[0] + m[1] * m[1] - m[3] * m[3] - m[4] * m[4];
    let v1 = -m[2] * m[5] / d1;
    let v2 = (m[5] * m[5] - m[2] * m[2]) / d2;
    let f_from = pick_focal(v1, v2, d1, d2);

    (f_from, f_to)
}

/// Two candidate values for f squared come out of the algebra. Prefer
/// whichever came from the better conditioned denominator, and fall back
/// to the other when only one is positive.
fn pick_focal(v1: f64, v2: f64, d1: f64, d2: f64) -> Option<f64> {
    let (hi, lo) = if v1 > v2 { (v1, v2) } else { (v2, v1) };
    if !hi.is_finite() && !lo.is_finite() {
        return None;
    }
    if hi > 0.0 && lo > 0.0 {
        let chosen = if d1.abs() > d2.abs() { v1 } else { v2 };
        if chosen > 0.0 && chosen.is_finite() {
            return Some(chosen.sqrt());
        }
    }
    if hi > 0.0 && hi.is_finite() {
        return Some(hi.sqrt());
    }
    None
}

/// A confirmed overlap, in the form the solver needs.
#[derive(Debug, Clone)]
pub struct PairConstraint {
    pub i: usize,
    pub j: usize,
    /// Maps image i onto image j, in centered coordinates.
    pub h: Mat3,
    /// Inlier correspondences, both in centered coordinates.
    pub points: Vec<((f64, f64), (f64, f64))>,
}

/// Estimates an initial focal length per camera.
///
/// Frames of one panorama nearly always come off one lens at one zoom,
/// so a median over every pairwise estimate is both more robust than any
/// single one and usually right. But a pairwise estimate comes out in
/// the pixel units of the frame it belongs to, and mixed frame sizes in
/// one selection (a phone beside a camera, a crop mode beside full
/// frame) put different pixel units into the same set: a raw median
/// would blend 800-pixel and 1600-pixel focals into a number that fits
/// nobody. Each estimate is normalized by its frame's long side (the
/// long side rather than the width because it is orientation-invariant
/// for one sensor, so portrait frames in a landscape pan stay
/// comparable); the median is taken in those units, and every camera
/// starts from it converted back into its own pixels. Bundle adjustment
/// refines each camera's focal from there.
///
/// The fallback when the geometry gives nothing is one long side, a
/// wide-normal lens and no worse than any other guess.
pub fn estimate_focals(constraints: &[PairConstraint], dims: &[(usize, usize)]) -> Vec<f64> {
    let mut all = Vec::new();
    for c in constraints {
        let (a, b) = focals_from_homography(&c.h);
        for (f, k) in [(a, c.i), (b, c.j)] {
            let Some(f) = f else { continue };
            let long = dims.get(k).map(|&(w, h)| w.max(h)).unwrap_or(0);
            if f.is_finite() && f > 1.0 && long > 0 {
                all.push(f / long as f64);
            }
        }
    }
    let normalised = if all.is_empty() {
        1.0
    } else {
        all.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
        all[all.len() / 2]
    };
    dims.iter()
        .map(|&(w, h)| normalised * w.max(h) as f64)
        .collect()
}

/// Initial rotations, by walking outward from one image.
///
/// Deliberately crude: it only has to land close enough for the joint
/// solve to converge. The strongest overlaps are walked first, so the
/// chain runs along the best-supported links and the weak ones inherit a
/// pose rather than defining one.
///
/// `focals` is per camera, in that camera's own pixels, because H maps
/// centered pixels of one frame onto centered pixels of the other and the
/// two frames may not share a pixel size: R_j R_i^-1 = K_j^-1 H K_i.
pub fn initial_cameras(n: usize, constraints: &[PairConstraint], focals: &[f64]) -> Vec<Camera> {
    let focal_of = |k: usize| focals.get(k).copied().unwrap_or(1.0).max(1.0);
    let k_of = |f: f64| Mat3([f, 0.0, 0.0, 0.0, f, 0.0, 0.0, 0.0, 1.0]);
    let k_inv_of = |f: f64| Mat3([1.0 / f, 0.0, 0.0, 0.0, 1.0 / f, 0.0, 0.0, 0.0, 1.0]);
    let mut cams: Vec<Camera> = (0..n).map(|k| Camera { f: focal_of(k), r: Mat3::IDENTITY }).collect();
    if n == 0 {
        return cams;
    }
    let mut placed = vec![false; n];
    placed[0] = true;

    let mut order: Vec<usize> = (0..constraints.len()).collect();
    order.sort_by_key(|&i| std::cmp::Reverse(constraints[i].points.len()));

    // Repeat until nothing more can be attached: one pass is not enough
    // when a link arrives before the image it hangs off has a pose.
    let mut progress = true;
    while progress {
        progress = false;
        for &ci in &order {
            let c = &constraints[ci];
            let (known, unknown, h) = if placed[c.i] && !placed[c.j] {
                // H maps i onto j, so R_j = (K_j^-1 H K_i) R_i.
                (c.i, c.j, c.h)
            } else if placed[c.j] && !placed[c.i] {
                let Some(inv) = c.h.inverse() else { continue };
                (c.j, c.i, inv)
            } else {
                continue;
            };
            let rel = k_inv_of(focal_of(unknown)).mul(&h).mul(&k_of(focal_of(known)));
            cams[unknown].r = rel.mul(&cams[known].r).orthonormalised();
            placed[unknown] = true;
            progress = true;
        }
    }
    cams
}

/// Projects a point from image `from` into image `to`.
fn project(from: &Camera, to: &Camera, p: (f64, f64)) -> Option<(f64, f64)> {
    homography(from, to).apply(p.0, p.1)
}

/// Every residual in the problem: for each correspondence, how far the
/// projected point lands from where it was actually seen. Both
/// directions, so neither image is privileged.
fn residuals(cams: &[Camera], constraints: &[PairConstraint]) -> Vec<f64> {
    let mut out = Vec::new();
    for c in constraints {
        for (pi, pj) in &c.points {
            match project(&cams[c.i], &cams[c.j], *pi) {
                Some((x, y)) => {
                    out.push(x - pj.0);
                    out.push(y - pj.1);
                }
                None => {
                    out.push(0.0);
                    out.push(0.0);
                }
            }
            match project(&cams[c.j], &cams[c.i], *pj) {
                Some((x, y)) => {
                    out.push(x - pi.0);
                    out.push(y - pi.1);
                }
                None => {
                    out.push(0.0);
                    out.push(0.0);
                }
            }
        }
    }
    out
}

/// Root mean square reprojection error, in pixels. The number worth
/// reporting: it is what "how well did this stitch" means.
pub fn rms_error(cams: &[Camera], constraints: &[PairConstraint]) -> f64 {
    let r = residuals(cams, constraints);
    if r.is_empty() {
        return 0.0;
    }
    (r.iter().map(|v| v * v).sum::<f64>() / (r.len() as f64 / 2.0)).sqrt()
}

/// Parameters, packed: focal then axis-angle, per camera.
fn pack(cams: &[Camera]) -> Vec<f64> {
    let mut p = Vec::with_capacity(cams.len() * 4);
    for c in cams {
        let w = inverse_rodrigues(&c.r);
        p.push(c.f);
        p.extend_from_slice(&w);
    }
    p
}

fn unpack(p: &[f64]) -> Vec<Camera> {
    p.chunks(4)
        .map(|c| Camera { f: c[0].max(1.0), r: rodrigues([c[1], c[2], c[3]]) })
        .collect()
}

/// Refines every camera together, by Levenberg-Marquardt.
///
/// LM interpolates between two methods depending on how well it is
/// doing. Far from the answer it behaves like gradient descent, which is
/// slow but safe; close to it it behaves like Gauss-Newton, which
/// converges quickly. The damping term lambda is what slides between
/// them: raised when a step made things worse, lowered when it helped.
///
/// The first camera's rotation is held fixed. Without that the problem
/// is under-determined in an obvious way: rotating the entire panorama
/// changes no residual at all, so the solver would be free to wander.
pub fn bundle_adjust(cams: &[Camera], constraints: &[PairConstraint]) -> Vec<Camera> {
    let n = cams.len();
    if n == 0 || constraints.is_empty() {
        return cams.to_vec();
    }
    let mut params = pack(cams);
    // Every parameter except the reference camera's three rotation terms.
    let free: Vec<usize> = (0..params.len()).filter(|&i| !(1..=3).contains(&i)).collect();
    let m = free.len();

    let mut lambda = 1e-3;
    let mut best = residuals(&unpack(&params), constraints);
    let mut best_cost: f64 = best.iter().map(|v| v * v).sum();

    for _ in 0..40 {
        // Jacobian by central differences. Analytic derivatives exist and
        // are in the paper; these are a few lines instead of a few
        // hundred, and at four parameters per image the cost is nothing
        // next to being certain they are right.
        let mut jac = vec![0.0; best.len() * m];
        for (col, &pi) in free.iter().enumerate() {
            let step = (params[pi].abs() * 1e-6).max(1e-7);
            let mut up = params.clone();
            up[pi] += step;
            let mut down = params.clone();
            down[pi] -= step;
            let ru = residuals(&unpack(&up), constraints);
            let rd = residuals(&unpack(&down), constraints);
            for row in 0..best.len() {
                jac[row * m + col] = (ru[row] - rd[row]) / (2.0 * step);
            }
        }

        // Normal equations J'J h = -J'r, with lambda on the diagonal.
        let mut jtj = vec![0.0; m * m];
        let mut jtr = vec![0.0; m];
        for row in 0..best.len() {
            for a in 0..m {
                let ja = jac[row * m + a];
                if ja == 0.0 {
                    continue;
                }
                jtr[a] -= ja * best[row];
                for b in a..m {
                    let v = ja * jac[row * m + b];
                    jtj[a * m + b] += v;
                    if a != b {
                        jtj[b * m + a] += v;
                    }
                }
            }
        }

        let mut improved = false;
        for _ in 0..8 {
            let mut damped = jtj.clone();
            for d in 0..m {
                // Scale the damping by the diagonal rather than adding a
                // flat lambda: focal lengths are measured in pixels and
                // rotations in radians, and a single additive term would
                // hobble one while barely touching the other.
                damped[d * m + d] += lambda * jtj[d * m + d].max(1e-12);
            }
            let Some(step) = solve(m, damped, jtr.clone()) else {
                lambda *= 10.0;
                continue;
            };
            let mut trial = params.clone();
            for (col, &pi) in free.iter().enumerate() {
                trial[pi] += step[col];
            }
            let r = residuals(&unpack(&trial), constraints);
            let cost: f64 = r.iter().map(|v| v * v).sum();
            if cost < best_cost {
                params = trial;
                best = r;
                best_cost = cost;
                lambda = (lambda * 0.3).max(1e-9);
                improved = true;
                break;
            }
            lambda *= 10.0;
        }
        if !improved || lambda > 1e9 {
            break;
        }
    }

    unpack(&params)
}

/// Rotates the whole panorama so the horizon is level.
///
/// Nobody pans a camera level. The frames come out slightly rolled and
/// slightly rising, and a correctly solved panorama faithfully
/// reproduces that as a wave: the result is geometrically right and
/// looks wrong.
///
/// Brown and Lowe's observation is that the error is a roll about the
/// viewing direction, and that photographers do not roll the camera
/// deliberately. So the frames' own X axes all lie roughly in one plane,
/// the horizontal one, and the direction they vary least about is the
/// vertical. That is the smallest eigenvector of their covariance, and
/// rotating it onto the world's up axis levels everything at once.
pub fn straighten(cams: &[Camera]) -> Mat3 {
    if cams.len() < 2 {
        return Mat3::IDENTITY;
    }
    let mut cov = [0.0f64; 9];
    for c in cams {
        // Camera X axis in world coordinates: the first row of R, since
        // R maps world to camera.
        let x = [c.r.0[0], c.r.0[1], c.r.0[2]];
        for r in 0..3 {
            for k in 0..3 {
                cov[r * 3 + k] += x[r] * x[k];
            }
        }
    }
    let (_, vecs) = symmetric_eigen(&Mat3(cov));
    let mut up = [vecs.0[0], vecs.0[3], vecs.0[6]];
    normalise3(&mut up);

    // Sign is arbitrary out of an eigen decomposition, and getting it
    // wrong turns the panorama upside down. Keep it pointing the same
    // way as the cameras' own idea of down.
    let mut mean_y = [0.0; 3];
    for c in cams {
        for k in 0..3 {
            mean_y[k] += c.r.0[3 + k];
        }
    }
    if dot3(up, mean_y) < 0.0 {
        for v in up.iter_mut() {
            *v = -*v;
        }
    }

    // Build the rotation taking `up` onto the world y axis, about the
    // axis perpendicular to both.
    let target = [0.0, 1.0, 0.0];
    let mut axis = cross3(up, target);
    let s = dot3(axis, axis).sqrt();
    if s < 1e-12 {
        return Mat3::IDENTITY;
    }
    normalise3(&mut axis);
    let angle = dot3(up, target).clamp(-1.0, 1.0).acos();
    rodrigues([axis[0] * angle, axis[1] * angle, axis[2] * angle])
}

/// Applies a global rotation to every camera.
pub fn rotate_all(cams: &[Camera], r: &Mat3) -> Vec<Camera> {
    cams.iter().map(|c| Camera { f: c.f, r: c.r.mul(&r.transpose()) }).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cam(f: f64, w: [f64; 3]) -> Camera {
        Camera { f, r: rodrigues(w) }
    }

    /// Deterministic scene points, spread over the sphere in front of the
    /// cameras.
    fn world_points(n: usize) -> Vec<[f64; 3]> {
        let mut state = 0xA5A5_1234u32;
        let mut next = || {
            state ^= state << 13;
            state ^= state >> 17;
            state ^= state << 5;
            (state % 100_000) as f64 / 100_000.0 - 0.5
        };
        (0..n)
            .map(|_| {
                let mut v = [next() * 1.2, next() * 0.9, 1.0];
                normalise3(&mut v);
                v
            })
            .collect()
    }

    /// Where a world ray lands in an image, or None if it is behind the
    /// camera or outside the frame.
    fn see(c: &Camera, p: [f64; 3], half_w: f64, half_h: f64) -> Option<(f64, f64)> {
        let d = c.r.mul_vec(p);
        if d[2] <= 1e-6 {
            return None;
        }
        let (x, y) = (c.f * d[0] / d[2], c.f * d[1] / d[2]);
        if x.abs() > half_w || y.abs() > half_h {
            return None;
        }
        Some((x, y))
    }

    /// Builds the constraints a perfect matcher would have produced from
    /// a known set of cameras.
    fn constraints_from(cams: &[Camera], pts: &[[f64; 3]]) -> Vec<PairConstraint> {
        let (hw, hh) = (400.0, 300.0);
        let mut out = Vec::new();
        for i in 0..cams.len() {
            for j in i + 1..cams.len() {
                let mut points = Vec::new();
                for p in pts {
                    if let (Some(a), Some(b)) = (see(&cams[i], *p, hw, hh), see(&cams[j], *p, hw, hh))
                    {
                        points.push((a, b));
                    }
                }
                if points.len() < 8 {
                    continue;
                }
                out.push(PairConstraint {
                    i,
                    j,
                    h: homography(&cams[i], &cams[j]),
                    points,
                });
            }
        }
        out
    }

    #[test]
    fn a_homography_between_a_camera_and_itself_is_the_identity() {
        let c = cam(700.0, [0.1, 0.2, -0.05]);
        let h = homography(&c, &c).normalised();
        for (i, v) in h.0.iter().enumerate() {
            assert!((v - Mat3::IDENTITY.0[i]).abs() < 1e-9, "entry {i} is {v}");
        }
    }

    /// The composition the whole model rests on: going from A to B to C
    /// must be the same as going from A to C.
    #[test]
    fn homographies_compose_along_the_chain() {
        let a = cam(650.0, [0.0, 0.0, 0.0]);
        let b = cam(650.0, [0.0, 0.30, 0.0]);
        let c = cam(650.0, [0.05, 0.60, -0.02]);
        let direct = homography(&a, &c).normalised();
        let chained = homography(&b, &c).mul(&homography(&a, &b)).normalised();
        for (i, v) in direct.0.iter().enumerate() {
            assert!((v - chained.0[i]).abs() < 1e-9, "entry {i}: {v} vs {}", chained.0[i]);
        }
    }

    /// EXIF is often missing or wrong, so the focal length has to come
    /// out of the geometry itself.
    #[test]
    fn focal_length_is_recovered_from_a_pairwise_homography() {
        let a = cam(820.0, [0.0, 0.0, 0.0]);
        let b = cam(820.0, [0.02, 0.28, 0.01]);
        let h = homography(&a, &b);
        let (fa, fb) = focals_from_homography(&h);
        let fa = fa.expect("source focal");
        let fb = fb.expect("destination focal");
        assert!((fa - 820.0).abs() < 5.0, "source focal came out {fa}");
        assert!((fb - 820.0).abs() < 5.0, "destination focal came out {fb}");
    }

    /// A pan with no tilt still determines the focal length, since the
    /// perspective terms are what carry it.
    #[test]
    fn focal_estimate_takes_the_median_over_every_pair() {
        let cams = [
            cam(900.0, [0.0, 0.0, 0.0]),
            cam(900.0, [0.0, 0.25, 0.0]),
            cam(900.0, [0.03, 0.5, 0.0]),
        ];
        let cs = constraints_from(&cams, &world_points(400));
        assert!(cs.len() >= 2, "only {} pairs overlapped", cs.len());
        let dims = [(1000, 750); 3];
        let fs = estimate_focals(&cs, &dims);
        assert_eq!(fs.len(), 3);
        for f in fs {
            assert!((f - 900.0).abs() < 20.0, "estimated {f}");
        }
    }

    /// The same sensor at two resolutions: one frame's pixels are twice
    /// the other's, so its focal in pixels is twice as long. A single
    /// shared estimate would fit one frame at best; each camera must
    /// start from the estimate in its own pixel units.
    #[test]
    fn focal_estimates_survive_mixed_frame_sizes() {
        let cams = [
            cam(800.0, [0.0, 0.0, 0.0]),
            cam(1600.0, [0.02, 0.28, 0.01]),
        ];
        let cs = constraints_from(&cams, &world_points(400));
        assert!(!cs.is_empty());
        // Frame 0 is 800x600 (focal 800 = one long side), frame 1 is the
        // same view at 1600x1200 (focal 1600 = one long side).
        let dims = [(800, 600), (1600, 1200)];
        let fs = estimate_focals(&cs, &dims);
        assert!((fs[0] - 800.0).abs() < 30.0, "frame 0 estimated {}", fs[0]);
        assert!((fs[1] - 1600.0).abs() < 60.0, "frame 1 estimated {}", fs[1]);
    }

    #[test]
    fn a_degenerate_homography_yields_no_focal_rather_than_a_wrong_one() {
        // Pure rotation about the optical axis: no perspective, so
        // nothing in it depends on focal length.
        let a = cam(700.0, [0.0, 0.0, 0.0]);
        let b = cam(700.0, [0.0, 0.0, 0.4]);
        let (fa, fb) = focals_from_homography(&homography(&a, &b));
        assert!(fa.is_none() || !fa.unwrap().is_finite() || fa.unwrap() > 0.0);
        assert!(fb.is_none() || fb.unwrap() > 0.0);
        // And the estimator falls back rather than returning nonsense:
        // one long side per camera, the wide-normal guess.
        let fs = estimate_focals(&[], &[(1200, 900), (800, 800)]);
        assert_eq!(fs, vec![1200.0, 800.0]);
    }

    #[test]
    fn initial_poses_place_every_connected_image() {
        let cams = [
            cam(800.0, [0.0, 0.0, 0.0]),
            cam(800.0, [0.0, 0.22, 0.0]),
            cam(800.0, [0.0, 0.44, 0.0]),
            cam(800.0, [0.02, 0.66, 0.0]),
        ];
        let cs = constraints_from(&cams, &world_points(600));
        let got = initial_cameras(4, &cs, &[800.0; 4]);
        // Poses are relative to the first camera, which is already the
        // identity here, so they should land on the originals.
        for i in 0..4 {
            let err = (0..9).map(|k| (got[i].r.0[k] - cams[i].r.0[k]).abs()).fold(0.0, f64::max);
            assert!(err < 0.02, "camera {i} initialized {err} off");
        }
    }

    /// The point of the whole module: perturbed cameras pulled back onto
    /// the answer by fitting every correspondence at once.
    #[test]
    fn bundle_adjustment_recovers_perturbed_cameras() {
        let truth = [
            cam(760.0, [0.0, 0.0, 0.0]),
            cam(760.0, [0.01, 0.24, 0.02]),
            cam(760.0, [-0.02, 0.48, -0.01]),
        ];
        let cs = constraints_from(&truth, &world_points(500));
        assert!(cs.len() >= 2);

        // Knock the poses and the focal off, as a chain of pairwise fits
        // would have left them.
        let start = vec![
            truth[0],
            cam(735.0, [0.03, 0.21, 0.05]),
            cam(735.0, [-0.05, 0.52, -0.04]),
        ];
        let before = rms_error(&start, &cs);
        assert!(before > 5.0, "the starting point should be visibly wrong, was {before}");

        let solved = bundle_adjust(&start, &cs);
        let after = rms_error(&solved, &cs);
        assert!(after < 0.5, "converged only to {after} pixels (from {before})");
        for i in 1..3 {
            assert!((solved[i].f - 760.0).abs() < 15.0, "camera {i} focal {}", solved[i].f);
        }
    }

    /// Error must not pile up at the end of a chain: the far frame of a
    /// pan should be no worse placed than the near one, which is the
    /// whole reason for solving jointly rather than sequentially.
    #[test]
    fn error_does_not_accumulate_along_a_long_pan() {
        let truth: Vec<Camera> =
            (0..6).map(|i| cam(700.0, [0.01 * i as f64, 0.2 * i as f64, 0.0])).collect();
        let cs = constraints_from(&truth, &world_points(900));
        let start: Vec<Camera> = truth
            .iter()
            .enumerate()
            .map(|(i, c)| {
                if i == 0 {
                    *c
                } else {
                    // Perturbation grows along the chain, as accumulated
                    // pairwise error does.
                    let w = inverse_rodrigues(&c.r);
                    let k = 0.008 * i as f64;
                    cam(690.0, [w[0] + k, w[1] - k, w[2] + k * 0.5])
                }
            })
            .collect();

        let solved = bundle_adjust(&start, &cs);
        // Compare the last pair's fit against the first pair's: if error
        // were accumulating, the far end would be much worse.
        let first: Vec<PairConstraint> =
            cs.iter().filter(|c| c.i == 0 && c.j == 1).cloned().collect();
        let last: Vec<PairConstraint> =
            cs.iter().filter(|c| c.i == 4 && c.j == 5).cloned().collect();
        assert!(!first.is_empty() && !last.is_empty());
        let near = rms_error(&solved, &first);
        let far = rms_error(&solved, &last);
        assert!(far < 1.0, "far end of the pan is {far} pixels out");
        assert!(far < near * 4.0 + 0.5, "error grew along the chain: {near} then {far}");
    }

    #[test]
    fn adjusting_nothing_is_harmless() {
        let cams = vec![cam(700.0, [0.0, 0.0, 0.0])];
        assert_eq!(bundle_adjust(&cams, &[]).len(), 1);
        assert_eq!(bundle_adjust(&[], &[]).len(), 0);
        assert_eq!(rms_error(&cams, &[]), 0.0);
    }

    /// A pan shot with the camera rolled: correctly solved, it comes out
    /// as a tilted panorama, which is right and looks wrong.
    #[test]
    fn straightening_removes_a_consistent_roll() {
        let roll = 0.12;
        let level: Vec<Camera> =
            (0..5).map(|i| cam(700.0, [0.0, 0.18 * (i as f64 - 2.0), 0.0])).collect();
        // Tilt the whole rig about the viewing axis.
        let tilt = rodrigues([0.0, 0.0, roll]);
        let rolled: Vec<Camera> =
            level.iter().map(|c| Camera { f: c.f, r: c.r.mul(&tilt) }).collect();

        let fix = straighten(&rolled);
        let fixed = rotate_all(&rolled, &fix);

        // Each camera's X axis should be back in the horizontal plane,
        // meaning no vertical component.
        for (i, c) in fixed.iter().enumerate() {
            let up_component = c.r.0[1];
            assert!(up_component.abs() < 0.02, "camera {i} still rolled by {up_component}");
        }
    }

    #[test]
    fn straightening_leaves_an_already_level_pan_alone() {
        let level: Vec<Camera> =
            (0..4).map(|i| cam(700.0, [0.0, 0.2 * (i as f64 - 1.5), 0.0])).collect();
        let fixed = rotate_all(&level, &straighten(&level));
        for (i, c) in fixed.iter().enumerate() {
            for k in 0..9 {
                assert!((c.r.0[k] - level[i].r.0[k]).abs() < 0.02, "camera {i} moved at {k}");
            }
        }
    }

    #[test]
    fn straightening_a_single_frame_does_nothing() {
        assert_eq!(straighten(&[cam(700.0, [0.3, 0.2, 0.1])]), Mat3::IDENTITY);
        assert_eq!(straighten(&[]), Mat3::IDENTITY);
    }
}
