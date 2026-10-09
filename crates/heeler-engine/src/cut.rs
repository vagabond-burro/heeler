//! A Finish picture cut to what of it shows: Layer via Copy's and Bake
//! Warp's last step before the file (the desktop's layer_copy.rs).
//!
//! Here rather than in the desktop crate for speed (the Finish review,
//! 2026-10-01: the cut took 529 to 662 ms on a 24 megapixel bake): the
//! desktop crate builds at opt-level 0 in the dev profile, where its
//! pixel loops ran unoptimized, and the engine is built at 3 in every
//! profile. Not generic for the same reason: a generic function is
//! compiled in its caller's crate, at the caller's level.
use std::sync::Arc;

use rayon::prelude::*;

use crate::ImageBuf;

/// How a pixel's alpha meets its coverage. `Times`: the picture's alpha
/// times the coverage (clamped), clamped (Layer via Copy, whose
/// selection is the coverage). `ClampedTimes`: the picture's alpha
/// clamped first, then times the coverage, clamped (Bake Warp, whose
/// coverage is the blend's weight and whose alpha is what the blend
/// reads, clamped the way the blend clamps it).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CutAlpha {
    Times,
    ClampedTimes,
}

/// The pixels a cut keeps, and where in the frame they came from.
pub struct ShownCut {
    pub image: ImageBuf,
    pub x: usize,
    pub y: usize,
}

#[inline(always)]
fn alpha_at(rule: CutAlpha, a: f32, cov: Option<&[f32]>, i: usize) -> f32 {
    match (rule, cov) {
        (CutAlpha::Times, Some(c)) => (a * c[i].clamp(0.0, 1.0)).clamp(0.0, 1.0),
        (CutAlpha::ClampedTimes, Some(c)) => (a.clamp(0.0, 1.0) * c[i].clamp(0.0, 1.0)).clamp(0.0, 1.0),
        (_, None) => a.clamp(0.0, 1.0),
    }
}

/// `picture` (straight alpha) cut to the bounds of the pixels whose
/// alpha, met with `cov` (one value a pixel, the picture's size; None
/// is coverage one everywhere) by `rule`, is at least `floor`, each kept
/// pixel's alpha that answer and its color the picture's. None when no
/// pixel shows.
///
/// The picture is taken by value: when the cut is the whole frame and
/// nothing else holds the picture, its own pixels become the cut's, the
/// alpha written in place, so a whole-frame bake copies nothing.
pub fn cut_shown(picture: Arc<ImageBuf>, cov: Option<&[f32]>, rule: CutAlpha, floor: f32) -> Option<ShownCut> {
    let (w, h) = (picture.width, picture.height);
    if w == 0 || h == 0 || picture.data.len() != w * h * 4 || cov.is_some_and(|c| c.len() != w * h) {
        return None;
    }
    let shows = |i: usize| alpha_at(rule, picture.data[i * 4 + 3], cov, i) >= floor;
    // Each row's first and last shown column, then the rows' extremes.
    let (x0, y0, x1, y1) = (0..h)
        .into_par_iter()
        .filter_map(|y| {
            let row = y * w;
            let first = (0..w).find(|&x| shows(row + x))?;
            let last = (first..w).rev().find(|&x| shows(row + x))?;
            Some((first, y, last, y))
        })
        .reduce(
            || (usize::MAX, usize::MAX, 0usize, 0usize),
            |a, b| (a.0.min(b.0), a.1.min(b.1), a.2.max(b.2), a.3.max(b.3)),
        );
    if x0 == usize::MAX {
        return None;
    }
    let (cw, ch) = (x1 - x0 + 1, y1 - y0 + 1);
    if (cw, ch) == (w, h) {
        // The whole frame: the picture itself when it is ours alone.
        let picture = match Arc::try_unwrap(picture) {
            Ok(own) => own,
            Err(shared) => ImageBuf { width: w, height: h, data: shared.data.clone() },
        };
        let mut image = picture;
        image.data.par_chunks_mut(4 * w).enumerate().for_each(|(y, row)| {
            let at = y * w;
            for (x, px) in row.chunks_exact_mut(4).enumerate() {
                px[3] = alpha_at(rule, px[3], cov, at + x);
            }
        });
        return Some(ShownCut { image, x: 0, y: 0 });
    }
    let mut image = ImageBuf::new(cw, ch);
    image.data.par_chunks_mut(cw * 4).enumerate().for_each(|(y, out)| {
        let row = (y + y0) * w + x0;
        let src = &picture.data[row * 4..(row + cw) * 4];
        for (x, (px, from)) in out.chunks_exact_mut(4).zip(src.chunks_exact(4)).enumerate() {
            px[..3].copy_from_slice(&from[..3]);
            px[3] = alpha_at(rule, from[3], cov, row + x);
        }
    });
    Some(ShownCut { image, x: x0, y: y0 })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn picture(w: usize, h: usize, f: impl Fn(usize, usize) -> [f32; 4]) -> ImageBuf {
        let mut img = ImageBuf::new(w, h);
        for y in 0..h {
            for x in 0..w {
                img.data[(y * w + x) * 4..(y * w + x) * 4 + 4].copy_from_slice(&f(x, y));
            }
        }
        img
    }

    #[test]
    fn cuts_to_the_shown_bounds_by_either_rule() {
        let p = picture(7, 5, |x, y| [x as f32, y as f32, 0.5, if (2..5).contains(&x) && (1..3).contains(&y) { 1.5 } else { 0.0 }]);
        let cov: Vec<f32> = (0..35).map(|i| if i % 7 == 3 { 0.5 } else { 2.0 }).collect();
        let a = cut_shown(Arc::new(p.clone()), Some(&cov), CutAlpha::Times, 1e-5).unwrap();
        assert_eq!((a.x, a.y, a.image.width, a.image.height), (2, 1, 3, 2));
        // Times: 1.5 x 0.5 = 0.75 in the half-covered column, else 1.
        assert_eq!(a.image.data.chunks(4).map(|p| p[3]).collect::<Vec<_>>(), vec![1.0, 0.75, 1.0, 1.0, 0.75, 1.0]);
        let b = cut_shown(Arc::new(p.clone()), Some(&cov), CutAlpha::ClampedTimes, 1e-5).unwrap();
        assert_eq!(b.image.data.chunks(4).map(|p| p[3]).collect::<Vec<_>>(), vec![1.0, 0.5, 1.0, 1.0, 0.5, 1.0]);
        assert_eq!(&a.image.data[..3], &[2.0, 1.0, 0.5]);
        assert!(cut_shown(Arc::new(picture(3, 3, |_, _| [1.0, 1.0, 1.0, 0.0])), None, CutAlpha::Times, 1e-5).is_none());
    }

    #[test]
    fn a_whole_frame_cut_takes_the_picture_itself_when_it_is_alone() {
        let p = Arc::new(picture(4, 3, |x, _| [0.1, 0.2, 0.3, 1.0 + x as f32]));
        let at = p.data.as_ptr();
        let cut = cut_shown(p, None, CutAlpha::ClampedTimes, 1e-5).unwrap();
        assert_eq!(cut.image.data.as_ptr(), at, "moved, not copied");
        assert!(cut.image.data.chunks(4).all(|p| p[3] == 1.0));
        // Shared, the same answer from a copy, the original untouched.
        let p = Arc::new(picture(4, 3, |x, _| [0.1, 0.2, 0.3, 1.0 + x as f32]));
        let other = p.clone();
        let cut = cut_shown(p, None, CutAlpha::ClampedTimes, 1e-5).unwrap();
        assert!(cut.image.data.chunks(4).all(|p| p[3] == 1.0));
        assert_eq!(other.data[7], 2.0);
    }
}
