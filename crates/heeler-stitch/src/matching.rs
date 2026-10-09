//! Deciding which features correspond, and which images overlap at all.
//!
//! This is the part that makes stitching automatic. The user hands over
//! a pile of photographs; nothing says which ones belong to the same
//! panorama, in what order, or which are of the dog. Brown and Lowe's
//! answer is to match everything against everything and then decide,
//! per pair, whether the matches found are consistent with a real
//! overlap or are the coincidences you would expect from two unrelated
//! photographs of the same holiday.

use crate::features::Feature;
use crate::geom::{fit_homography, Mat3};
use crate::kdtree::KdTree;

/// Lowe's ratio test threshold. A descriptor's nearest neighbor is only
/// believable if it is clearly nearer than the second nearest: in a
/// repeated texture (brickwork, railings, leaves) the two are equally
/// close and neither means anything.
const RATIO: f32 = 0.8;
/// RANSAC trials. Brown and Lowe's n = 500, which for four points drawn
/// from a set that is half inliers leaves a vanishing chance of never
/// once drawing a clean sample.
const TRIALS: usize = 500;
/// Correspondences per trial: the minimum that determines a homography.
const SAMPLE: usize = 4;
/// How far a mapped point may land from its partner and still count.
/// Three pixels, allowing for the detector's own localization error.
const INLIER_DIST: f64 = 3.0;
/// Match verification, from the paper: accept the pair when
/// ni > alpha + beta * nf.
const ALPHA: f64 = 8.0;
const BETA: f64 = 0.3;

/// A putative correspondence: index into each image's feature list.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Correspondence {
    pub a: usize,
    pub b: usize,
}

/// Two images, and what was found between them.
#[derive(Debug, Clone)]
pub struct PairMatch {
    /// Maps points in image A onto image B.
    pub h: Mat3,
    pub inliers: Vec<Correspondence>,
    /// Putative matches before RANSAC, for reporting.
    pub putative: usize,
    /// Whether the geometry is strong enough to believe the images
    /// really overlap.
    pub confirmed: bool,
}

/// Deterministic generator. RANSAC needs random samples, but a stitch
/// that produces a different panorama each time it runs would be
/// impossible to test and unpleasant to use, so the randomness is
/// reproducible.
struct Rng(u32);

impl Rng {
    fn next(&mut self) -> u32 {
        self.0 ^= self.0 << 13;
        self.0 ^= self.0 >> 17;
        self.0 ^= self.0 << 5;
        self.0
    }

    fn below(&mut self, n: usize) -> usize {
        (self.next() % n as u32) as usize
    }
}

/// Putative correspondences from A to B, filtered by the ratio test.
pub fn match_features(a: &[Feature], b: &[Feature]) -> Vec<Correspondence> {
    if a.is_empty() || b.is_empty() {
        return Vec::new();
    }
    let descs: Vec<Vec<f32>> = b.iter().map(|f| f.desc.clone()).collect();
    let tree = KdTree::build(&descs);
    let mut out = Vec::new();
    for (i, f) in a.iter().enumerate() {
        let near = tree.nearest(&f.desc, 2, None);
        if near.len() < 2 {
            continue;
        }
        // Ambiguous matches are worse than no match: they are wrong
        // roughly half the time and they all look confident.
        if near[1].dist > 1e-12 && near[0].dist / near[1].dist < RATIO {
            out.push(Correspondence { a: i, b: near[0].index });
        }
    }
    out
}

/// Fits the homography that most correspondences agree on.
///
/// Least squares over everything would be pulled apart by a single bad
/// match, and a putative set is typically half bad. RANSAC instead fits
/// from four at a time and keeps whichever fit the most points agree
/// with, so wrong matches are outvoted rather than averaged in.
pub fn ransac(src: &[(f64, f64)], dst: &[(f64, f64)]) -> Option<(Mat3, Vec<usize>)> {
    if src.len() < SAMPLE || src.len() != dst.len() {
        return None;
    }
    let mut rng = Rng(0x9E3779B9);
    let mut best: Vec<usize> = Vec::new();
    let mut best_h = Mat3::IDENTITY;

    for _ in 0..TRIALS {
        let mut idx = [0usize; SAMPLE];
        let mut n = 0;
        let mut guard = 0;
        while n < SAMPLE && guard < 64 {
            let candidate = rng.below(src.len());
            guard += 1;
            if idx[..n].contains(&candidate) {
                continue;
            }
            idx[n] = candidate;
            n += 1;
        }
        if n < SAMPLE {
            continue;
        }
        let s: Vec<(f64, f64)> = idx.iter().map(|&i| src[i]).collect();
        let d: Vec<(f64, f64)> = idx.iter().map(|&i| dst[i]).collect();
        // None here means the four points were degenerate (collinear, or
        // three coincident), which happens and is not an error.
        let Some(h) = fit_homography(&s, &d) else {
            continue;
        };
        let inliers = consensus(&h, src, dst);
        if inliers.len() > best.len() {
            best = inliers;
            best_h = h;
        }
    }

    if best.len() < SAMPLE {
        return None;
    }
    // Refit on everything that agreed. The winning sample of four was
    // chosen for being clean, not for being well spread, so the fit it
    // gives is noisier than one over all its own inliers.
    let s: Vec<(f64, f64)> = best.iter().map(|&i| src[i]).collect();
    let d: Vec<(f64, f64)> = best.iter().map(|&i| dst[i]).collect();
    if let Some(refined) = fit_homography(&s, &d) {
        let inliers = consensus(&refined, src, dst);
        if inliers.len() >= best.len() {
            return Some((refined, inliers));
        }
    }
    Some((best_h, best))
}

fn consensus(h: &Mat3, src: &[(f64, f64)], dst: &[(f64, f64)]) -> Vec<usize> {
    let mut out = Vec::new();
    for i in 0..src.len() {
        let Some((x, y)) = h.apply(src[i].0, src[i].1) else {
            continue;
        };
        let dx = x - dst[i].0;
        let dy = y - dst[i].1;
        if dx * dx + dy * dy <= INLIER_DIST * INLIER_DIST {
            out.push(i);
        }
    }
    out
}

/// Brown and Lowe's probabilistic verification: is this overlap real?
///
/// The insight is that the question cannot be answered by a fixed inlier
/// count, because how many inliers to expect depends on how much of the
/// image overlaps. What is constant is the comparison between two
/// hypotheses: correct matches happen at a high rate in a genuine
/// overlap, and false matches happen at a low rate everywhere. Working
/// the likelihood ratio through leaves a straight line: accept when
/// inliers exceed alpha + beta times the features in the overlap.
///
/// `features_in_overlap` is the count of features that actually fall in
/// the shared region, not the total, and that is the whole point. Two
/// frames sharing a narrow strip get judged on the strip.
pub fn verify(inliers: usize, features_in_overlap: usize) -> bool {
    inliers as f64 > ALPHA + BETA * features_in_overlap as f64
}

/// How many of A's features land inside B once mapped. The denominator
/// for `verify`.
pub fn features_in_overlap(h: &Mat3, a: &[Feature], b_width: usize, b_height: usize) -> usize {
    a.iter()
        .filter(|f| match h.apply(f.kp.x as f64, f.kp.y as f64) {
            Some((x, y)) => x >= 0.0 && y >= 0.0 && x < b_width as f64 && y < b_height as f64,
            None => false,
        })
        .count()
}

/// The whole pairwise decision: match, fit, and judge.
pub fn match_images(
    a: &[Feature],
    b: &[Feature],
    b_size: (usize, usize),
) -> Option<PairMatch> {
    let putative = match_features(a, b);
    if putative.len() < SAMPLE {
        return None;
    }
    let src: Vec<(f64, f64)> =
        putative.iter().map(|c| (a[c.a].kp.x as f64, a[c.a].kp.y as f64)).collect();
    let dst: Vec<(f64, f64)> =
        putative.iter().map(|c| (b[c.b].kp.x as f64, b[c.b].kp.y as f64)).collect();
    let (h, inlier_idx) = ransac(&src, &dst)?;
    let overlap = features_in_overlap(&h, a, b_size.0, b_size.1);
    Some(PairMatch {
        h,
        confirmed: verify(inlier_idx.len(), overlap),
        inliers: inlier_idx.into_iter().map(|i| putative[i]).collect(),
        putative: putative.len(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::features::detect;
    use crate::gray::Gray;

    /// Deterministic point cloud. The seed is a parameter and not a
    /// constant, because two clouds drawn from the same seed are the same
    /// cloud, and a test comparing an image against itself proves nothing.
    fn cloud(n: usize, w: f64, h: f64, seed: u32) -> Vec<(f64, f64)> {
        let mut state = seed;
        let mut next = || {
            state ^= state << 13;
            state ^= state >> 17;
            state ^= state << 5;
            (state % 100_000) as f64 / 100_000.0
        };
        (0..n).map(|_| (next() * w, next() * h)).collect()
    }

    #[test]
    fn ransac_recovers_a_transform_from_points_half_of_which_are_wrong() {
        let truth = Mat3([0.96, -0.22, 30.0, 0.21, 0.99, -12.0, 0.0001, 0.00005, 1.0]).normalised();
        let src = cloud(120, 600.0, 400.0, 0x1234_5678);
        let mut dst: Vec<(f64, f64)> =
            src.iter().map(|p| truth.apply(p.0, p.1).unwrap()).collect();
        // Corrupt every other correspondence: this is what a putative set
        // off a real pair of photographs looks like.
        let noise = cloud(60, 600.0, 400.0, 0xC0FF_EE01);
        for (i, n) in noise.into_iter().enumerate() {
            dst[i * 2] = n;
        }

        let (h, inliers) = ransac(&src, &dst).unwrap();
        assert!(inliers.len() >= 55, "found only {} inliers of 60", inliers.len());
        assert!(inliers.iter().all(|&i| i % 2 == 1), "an outlier was counted as an inlier");
        // The recovered mapping agrees with the true one across the frame.
        for p in [(0.0, 0.0), (600.0, 0.0), (300.0, 400.0), (600.0, 400.0)] {
            let (gx, gy) = h.apply(p.0, p.1).unwrap();
            let (tx, ty) = truth.apply(p.0, p.1).unwrap();
            assert!((gx - tx).abs() < 0.5 && (gy - ty).abs() < 0.5, "off at {p:?}");
        }
    }

    #[test]
    fn ransac_gives_up_on_pure_noise() {
        let src = cloud(80, 500.0, 500.0, 0x0BAD_F00D);
        let dst = cloud(80, 500.0, 500.0, 0x5EED_1234);
        let (_, inliers) = ransac(&src, &dst).unwrap();
        // Four points always agree with the fit made from them, but there
        // is no consensus beyond a handful of coincidences.
        assert!(inliers.len() < 12, "{} points agreed on noise", inliers.len());
        assert!(!verify(inliers.len(), 80), "noise passed verification");
    }

    /// Two runs, same answer. RANSAC is randomized, and a stitcher that
    /// gave a different panorama every time would be untestable.
    #[test]
    fn ransac_is_deterministic() {
        let truth = Mat3([1.0, 0.0, 25.0, 0.0, 1.0, -8.0, 0.0, 0.0, 1.0]);
        let src = cloud(60, 400.0, 300.0, 0x2222_3333);
        let dst: Vec<(f64, f64)> = src.iter().map(|p| truth.apply(p.0, p.1).unwrap()).collect();
        let a = ransac(&src, &dst).unwrap();
        let b = ransac(&src, &dst).unwrap();
        assert_eq!(a.0 .0, b.0 .0);
        assert_eq!(a.1, b.1);
    }

    /// The verification rule scales with the overlap, which is the point
    /// of it: a narrow strip is judged on the strip.
    #[test]
    fn verification_scales_with_the_size_of_the_overlap() {
        // A small overlap: 20 features there, 15 of them agreeing, is a
        // real match. The line sits at 8 + 0.3*20 = 14 exactly, and the
        // comparison is strict, so 14 is not enough.
        assert!(verify(15, 20));
        assert!(!verify(14, 20));
        // The same 15 agreeing out of 200 in the overlap is not a match:
        // in a genuine overlap that large, far more should have matched.
        assert!(!verify(15, 200));
        // And nothing passes on a handful of inliers alone.
        assert!(!verify(8, 0));
        assert!(verify(9, 0));
    }

    fn textured(w: usize, h: usize) -> Gray {
        let mut g = Gray::new(w, h);
        for y in 0..h {
            for x in 0..w {
                let (fx, fy) = (x as f32, y as f32);
                let v = 0.35
                    + 0.18 * (fx * 0.21).sin() * (fy * 0.17).cos()
                    + 0.12 * (fx * 0.07 + fy * 0.05).sin()
                    + 0.10 * ((fx * 0.41).cos() * (fy * 0.37).sin());
                g.set(x, y, v.clamp(0.02, 1.0));
            }
        }
        g
    }

    fn crop(src: &Gray, x0: usize, y0: usize, w: usize, h: usize) -> Gray {
        let mut out = Gray::new(w, h);
        for y in 0..h {
            for x in 0..w {
                out.set(x, y, src.at(x0 + x, y0 + y));
            }
        }
        out
    }

    /// End to end on two real overlapping frames: detect, match, fit.
    /// Every part of the pipeline so far has to be right for the answer
    /// to come out as the shift that was actually applied.
    #[test]
    fn two_overlapping_crops_are_matched_and_their_shift_recovered() {
        let scene = textured(220, 128);
        let left = crop(&scene, 0, 0, 140, 128);
        let right = crop(&scene, 60, 0, 140, 128);

        let fa = detect(&left, 400);
        let fb = detect(&right, 400);
        assert!(fa.len() > 40 && fb.len() > 40, "detected {} and {}", fa.len(), fb.len());

        let m = match_images(&fa, &fb, (right.width, right.height)).expect("a match");
        assert!(m.confirmed, "a real 80px overlap was not confirmed ({} inliers)", m.inliers.len());

        // A point at x in the left frame sits at x - 60 in the right one.
        for (x, y) in [(80.0, 30.0), (100.0, 64.0), (120.0, 100.0)] {
            let (gx, gy) = m.h.apply(x, y).unwrap();
            assert!(
                (gx - (x - 60.0)).abs() < 1.0 && (gy - y).abs() < 1.0,
                "({x}, {y}) mapped to ({gx:.2}, {gy:.2})"
            );
        }
    }

    /// And the other half of automatic: two photographs that share
    /// nothing must be rejected, or they end up spliced into the
    /// panorama.
    #[test]
    fn unrelated_images_are_not_confirmed() {
        let a = textured(128, 128);
        let mut b = Gray::new(128, 128);
        for y in 0..128 {
            for x in 0..128 {
                let (fx, fy) = (x as f32, y as f32);
                // Deliberately different structure at a different scale.
                b.set(x, y, (0.4 + 0.3 * ((fx * 0.9).sin() + (fy * 0.63).cos())).clamp(0.02, 1.0));
            }
        }
        let fa = detect(&a, 300);
        let fb = detect(&b, 300);
        let m = match_images(&fa, &fb, (b.width, b.height));
        match m {
            None => {}
            Some(m) => assert!(
                !m.confirmed,
                "unrelated frames confirmed with {} inliers of {} putative",
                m.inliers.len(),
                m.putative
            ),
        }
    }

    #[test]
    fn matching_against_nothing_is_empty_rather_than_a_panic() {
        let g = textured(64, 64);
        let f = detect(&g, 50);
        assert!(match_features(&f, &[]).is_empty());
        assert!(match_features(&[], &f).is_empty());
        assert!(match_images(&f, &[], (64, 64)).is_none());
    }
}
