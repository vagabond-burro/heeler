//! The largest rectangle a panorama fills.
//!
//! A panorama's edges are ragged: each frame was pointed a little higher
//! or lower than the last, and the surface bends them besides, so the
//! canvas has empty wedges along every side. The picture people want is
//! the largest axis-aligned rectangle with nothing empty in it, which is
//! offered as the panorama's starting crop rather than cut, so it can be
//! widened again.
//!
//! The coverage is read at reduced resolution, a cell counting as
//! covered only when every pixel under it is. The rectangle is then the
//! classic maximal rectangle in a binary matrix: each row turns the
//! column heights of covered cells above it into a histogram, and the
//! largest rectangle under a histogram falls out of one pass with a
//! stack. Linear in the cells.

use heeler_engine::buffers::ImageBuf;

/// Longest side of the coverage grid, in cells.
const CROP_EDGE: usize = 1024;

/// A crop, in fractions of the panorama: what Crop & Rotate's
/// crop_x, crop_y, crop_w and crop_h hold.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct CropRect {
    pub x: f32,
    pub y: f32,
    pub w: f32,
    pub h: f32,
}

/// Which cells of the panorama are wholly covered, with the cell size
/// in pixels and the grid's width and height.
fn coverage(img: &ImageBuf) -> (Vec<bool>, usize, usize, usize) {
    let s = img.width.max(img.height).div_ceil(CROP_EDGE).max(1);
    let (gw, gh) = (img.width.div_ceil(s), img.height.div_ceil(s));
    let mut cells = heeler_engine::memory::or_unwind(heeler_engine::memory::vector(gw * gh, true, "panorama crop coverage"));
    for y in 0..img.height {
        for x in 0..img.width {
            if img.data[(y * img.width + x) * 4 + 3] < 0.5 {
                cells[(y / s) * gw + x / s] = false;
            }
        }
    }
    (cells, s, gw, gh)
}

/// The largest all-true rectangle in a grid, as (x, y, w, h) in cells.
fn largest_rectangle(cells: &[bool], gw: usize, gh: usize) -> Option<(usize, usize, usize, usize)> {
    let mut height = heeler_engine::memory::or_unwind(heeler_engine::memory::vector(gw, 0usize, "panorama crop histogram"));
    let mut best: Option<(usize, (usize, usize, usize, usize))> = None;
    let mut stack = heeler_engine::memory::or_unwind(heeler_engine::memory::vector(gw + 1, 0usize, "panorama crop histogram"));
    for y in 0..gh {
        for x in 0..gw {
            height[x] = if cells[y * gw + x] { height[x] + 1 } else { 0 };
        }
        // Columns on the stack have rising heights; a lower column ends
        // every taller rectangle started before it.
        stack.clear();
        for x in 0..=gw {
            let h = if x < gw { height[x] } else { 0 };
            while let Some(&top) = stack.last() {
                if height[top] < h {
                    break;
                }
                stack.pop();
                let left = stack.last().map_or(0, |&l| l + 1);
                let (w, th) = (x - left, height[top]);
                if th > 0 && best.is_none_or(|(a, _)| w * th > a) {
                    best = Some((w * th, (left, y + 1 - th, w, th)));
                }
            }
            stack.push(x);
        }
    }
    best.map(|(_, r)| r)
}

/// The largest all-true rectangle whose width over height, in cells, is
/// `ratio`, as (x, y, w, h). The height is searched: a rectangle of some
/// shape fits wherever a shorter one of that shape does, and a summed
/// area table answers each try in one pass.
fn largest_at_ratio(cells: &[bool], gw: usize, gh: usize, ratio: f64) -> Option<(usize, usize, usize, usize)> {
    let count = heeler_engine::memory::or_unwind(heeler_engine::memory::bytes(gw + 1, gh + 1, 1, 4)) / 4;
    let mut sum = heeler_engine::memory::or_unwind(heeler_engine::memory::vector(count, 0u32, "panorama crop coverage sums"));
    for y in 0..gh {
        for x in 0..gw {
            let i = (y + 1) * (gw + 1) + x + 1;
            sum[i] = cells[y * gw + x] as u32 + sum[i - 1] + sum[i - gw - 1] - sum[i - gw - 2];
        }
    }
    let empty = |x: usize, y: usize, w: usize, h: usize| {
        let at = |x: usize, y: usize| sum[y * (gw + 1) + x];
        at(x + w, y + h) + at(x, y) - at(x + w, y) - at(x, y + h) == (w * h) as u32
    };
    let place = |h: usize| -> Option<(usize, usize, usize, usize)> {
        let w = (h as f64 * ratio).round() as usize;
        if w == 0 || w > gw || h > gh {
            return None;
        }
        for y in 0..=gh - h {
            for x in 0..=gw - w {
                if empty(x, y, w, h) {
                    return Some((x, y, w, h));
                }
            }
        }
        None
    };
    let (mut lo, mut hi) = (0usize, gh);
    let mut found = None;
    while lo < hi {
        let mid = (lo + hi).div_ceil(2);
        match place(mid) {
            Some(r) => {
                found = Some(r);
                lo = mid;
            }
            None => hi = mid - 1,
        }
    }
    found
}

/// Cells back to fractions of the panorama. A side inside the canvas is
/// drawn in by one more cell: the preview and the full-size stitch are
/// painted separately and their ragged edges differ by a pixel or two,
/// and the crop has to hold at either.
fn to_fractions(img: &ImageBuf, (x, y, w, h): (usize, usize, usize, usize), s: usize, gw: usize, gh: usize) -> Option<CropRect> {
    let (mut x0, mut y0, mut x1, mut y1) = (x, y, x + w, y + h);
    if x0 > 0 {
        x0 += 1;
    }
    if y0 > 0 {
        y0 += 1;
    }
    if x1 < gw {
        x1 = x1.saturating_sub(1);
    }
    if y1 < gh {
        y1 = y1.saturating_sub(1);
    }
    if x1 <= x0 || y1 <= y0 {
        return None;
    }
    let (fw, fh) = (img.width as f32, img.height as f32);
    let px = |c: usize, edge: f32| ((c * s) as f32).min(edge);
    let (left, top) = (px(x0, fw), px(y0, fh));
    let (right, bottom) = (px(x1, fw), px(y1, fh));
    Some(CropRect { x: left / fw, y: top / fh, w: (right - left) / fw, h: (bottom - top) / fh })
}

/// The largest rectangle of the panorama with nothing empty in it, or
/// None when nothing is covered.
pub fn auto_crop(img: &ImageBuf) -> Option<CropRect> {
    if img.width == 0 || img.height == 0 {
        return None;
    }
    let (cells, s, gw, gh) = coverage(img);
    to_fractions(img, largest_rectangle(&cells, gw, gh)?, s, gw, gh)
}

/// The same, held to a shape: `ratio` is width over height in pixels.
pub fn auto_crop_at_ratio(img: &ImageBuf, ratio: f64) -> Option<CropRect> {
    if img.width == 0 || img.height == 0 || !(ratio > 0.0 && ratio.is_finite()) {
        return None;
    }
    let (cells, s, gw, gh) = coverage(img);
    to_fractions(img, largest_at_ratio(&cells, gw, gh, ratio)?, s, gw, gh)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Every rectangle in the grid, by brute force.
    fn brute(cells: &[bool], gw: usize, gh: usize) -> usize {
        let mut best = 0;
        for y in 0..gh {
            for x in 0..gw {
                for h in 1..=gh - y {
                    for w in 1..=gw - x {
                        if (y..y + h).all(|yy| (x..x + w).all(|xx| cells[yy * gw + xx])) {
                            best = best.max(w * h);
                        }
                    }
                }
            }
        }
        best
    }

    #[test]
    fn the_histogram_pass_finds_the_largest_rectangle() {
        let mut state = 0x1234_5678u32;
        for trial in 0..200 {
            let (gw, gh) = (1 + trial % 9, 1 + (trial / 9) % 7);
            let cells: Vec<bool> = (0..gw * gh)
                .map(|_| {
                    state ^= state << 13;
                    state ^= state >> 17;
                    state ^= state << 5;
                    state % 5 != 0
                })
                .collect();
            let want = brute(&cells, gw, gh);
            let got = largest_rectangle(&cells, gw, gh).map_or(0, |(x, y, w, h)| {
                assert!((y..y + h).all(|yy| (x..x + w).all(|xx| cells[yy * gw + xx])), "trial {trial} holds an empty cell");
                w * h
            });
            assert_eq!(got, want, "trial {trial}");
        }
    }

    /// A panorama's coverage, drawn: a band that wanders up and down
    /// the canvas the way a hand-held pan does, with bowed ends.
    fn wandering_pan(w: usize, h: usize) -> ImageBuf {
        let mut img = ImageBuf::new(w, h);
        for x in 0..w {
            let t = x as f32 / w as f32;
            let mid = h as f32 * (0.5 + 0.08 * (t * 9.0).sin());
            let half = h as f32 * 0.36 * (1.0 - (2.0 * t - 1.0).powi(8));
            for y in 0..h {
                if (y as f32 - mid).abs() < half {
                    img.set_pixel(x, y, [0.5, 0.5, 0.5, 1.0]);
                }
            }
        }
        img
    }

    fn holds_no_empty_pixel(img: &ImageBuf, r: CropRect) -> bool {
        let (x0, y0) = ((r.x * img.width as f32).floor() as usize, (r.y * img.height as f32).floor() as usize);
        let (x1, y1) = (((r.x + r.w) * img.width as f32).ceil() as usize, ((r.y + r.h) * img.height as f32).ceil() as usize);
        (y0..y1.min(img.height)).all(|y| (x0..x1.min(img.width)).all(|x| img.pixel(x, y)[3] > 0.5))
    }

    #[test]
    fn a_wandering_pan_crops_to_a_rectangle_with_nothing_empty_in_it() {
        for (w, h) in [(900, 300), (3000, 700)] {
            let img = wandering_pan(w, h);
            let r = auto_crop(&img).expect("a crop");
            assert!(holds_no_empty_pixel(&img, r), "{w} x {h}: {r:?} holds empty pixels");
            // Most of the band: its narrowest point is about 56% of the
            // height and the bowed ends cost a little of the width.
            assert!(r.h > 0.4 && r.w > 0.8, "{w} x {h}: only {r:?}");
        }
    }

    #[test]
    fn a_ratio_holds_its_shape_and_stays_inside() {
        let img = wandering_pan(900, 300);
        let free = auto_crop(&img).unwrap();
        for ratio in [1.0, 1.5, 3.0] {
            let r = auto_crop_at_ratio(&img, ratio).expect("a crop");
            let got = (r.w * img.width as f32) / (r.h * img.height as f32);
            assert!((got / ratio as f32 - 1.0).abs() < 0.05, "ratio {ratio}: {got}");
            assert!(holds_no_empty_pixel(&img, r), "ratio {ratio}: {r:?}");
            assert!(r.w * r.h <= free.w * free.h + 1e-6, "no larger than the free crop");
        }
    }

    #[test]
    fn a_full_canvas_keeps_everything_and_an_empty_one_offers_nothing() {
        let mut full = ImageBuf::new(200, 100);
        full.data.chunks_mut(4).for_each(|p| p[3] = 1.0);
        assert_eq!(auto_crop(&full), Some(CropRect { x: 0.0, y: 0.0, w: 1.0, h: 1.0 }));
        assert_eq!(auto_crop(&ImageBuf::new(200, 100)), None);
    }
}
