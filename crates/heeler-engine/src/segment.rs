//! Region Select: click a thing, get the region the picture says it is.
//!
//! Felzenszwalb-Huttenlocher graph segmentation (2004), the classical
//! half of Selective Search (Uijlings 2013), which the owner supplied as
//! the reference. The deep alternative (Xu 2016) needs trained weights
//! and a neural runtime; this needs arithmetic over pixels the engine
//! already holds, and it is deterministic, which is a hard requirement
//! here: the same click on the same picture must select the same region
//! every time.
//!
//! Honestly named: this is similarity grouping, not object detection.
//! It will hand back "the sunlit half of the dog" because that is a
//! coherent region, and it has no idea what a dog is. Which is why the
//! tool is called Region Select and not Object Select.

use crate::buffers::ImageBuf;

/// Union-find with the Felzenszwalb merge threshold carried per root.
struct Forest {
    parent: Vec<u32>,
    size: Vec<u32>,
    /// the largest edge weight inside the component, plus k/|C|
    thresh: Vec<f32>,
}

impl Forest {
    fn new(n: usize, k: f32) -> Self {
        Forest {
            parent: (0..n as u32).collect(),
            size: vec![1; n],
            thresh: vec![k; n],
        }
    }
    fn find(&mut self, mut a: u32) -> u32 {
        while self.parent[a as usize] != a {
            // Path halving: cheap, and enough.
            self.parent[a as usize] = self.parent[self.parent[a as usize] as usize];
            a = self.parent[a as usize];
        }
        a
    }
    fn union(&mut self, a: u32, b: u32) -> u32 {
        let (a, b) = if self.size[a as usize] >= self.size[b as usize] { (a, b) } else { (b, a) };
        self.parent[b as usize] = a;
        self.size[a as usize] += self.size[b as usize];
        a
    }
}

/// Per-pixel component labels for the image, at its own resolution.
///
/// `k` sets the scale of observation: the merge threshold for a
/// component is its largest internal edge plus k/|C|, so small k keeps
/// fine structure apart and large k lets it merge. The UI maps its
/// Tolerance slider onto k, which makes "how much counts as one region"
/// a slider rather than a fixed opinion.
pub fn segment(img: &ImageBuf, k: f32, min_size: usize) -> Vec<u32> {
    let (w, h) = (img.width, img.height);
    let n = w * h;
    if n == 0 {
        return Vec::new();
    }
    // Edge weight: RGB distance. The paper smooths first; at the preview
    // scale this runs on, the downsample already did the smoothing.
    let px = |i: usize| [img.data[i * 4], img.data[i * 4 + 1], img.data[i * 4 + 2]];
    let dist = |a: usize, b: usize| {
        let (p, q) = (px(a), px(b));
        ((p[0] - q[0]).powi(2) + (p[1] - q[1]).powi(2) + (p[2] - q[2]).powi(2)).sqrt()
    };

    let mut edges: Vec<(f32, u32, u32)> = Vec::with_capacity(n * 2);
    for y in 0..h {
        for x in 0..w {
            let i = y * w + x;
            if x + 1 < w {
                edges.push((dist(i, i + 1), i as u32, (i + 1) as u32));
            }
            if y + 1 < h {
                edges.push((dist(i, i + w), i as u32, (i + w) as u32));
            }
        }
    }
    // total_cmp: NaN cannot occur (distances are finite), and a plain
    // partial sort would panic on it rather than segmenting wrongly.
    edges.sort_unstable_by(|a, b| a.0.total_cmp(&b.0));

    let mut f = Forest::new(n, k);
    for &(wgt, a, b) in &edges {
        let (ra, rb) = (f.find(a), f.find(b));
        if ra == rb {
            continue;
        }
        if wgt <= f.thresh[ra as usize].min(f.thresh[rb as usize]) {
            let r = f.union(ra, rb);
            f.thresh[r as usize] = wgt + k / f.size[r as usize] as f32;
        }
    }
    // Small-component cleanup, the paper's post-pass: a region below the
    // minimum joins its most similar neighbor, so noise speckles do not
    // survive as selectable one-pixel regions.
    for &(_, a, b) in &edges {
        let (ra, rb) = (f.find(a), f.find(b));
        if ra != rb && (f.size[ra as usize] < min_size as u32 || f.size[rb as usize] < min_size as u32) {
            f.union(ra, rb);
        }
    }
    (0..n as u32).map(|i| f.find(i)).collect()
}

/// The clicked component as a coverage grid.
///
/// `x`/`y` in 0..1 of the frame; the grid is `out` cells on each side,
/// each holding how much of it the component covers, 0..255. Coverage
/// rather than membership so the traced outline lands where the region's
/// edge really is instead of on the grid.
pub fn region_coverage(
    labels: &[u32],
    w: usize,
    h: usize,
    x: f32,
    y: f32,
    out: usize,
) -> Vec<u8> {
    let mut grid = vec![0u8; out * out];
    if labels.len() != w * h || w == 0 || h == 0 {
        return grid;
    }
    let cx = ((x * w as f32) as usize).min(w - 1);
    let cy = ((y * h as f32) as usize).min(h - 1);
    let target = labels[cy * w + cx];

    let mut hits = vec![0u32; out * out];
    let mut totals = vec![0u32; out * out];
    for py in 0..h {
        for px in 0..w {
            let gx = (px * out / w).min(out - 1);
            let gy = (py * out / h).min(out - 1);
            totals[gy * out + gx] += 1;
            if labels[py * w + px] == target {
                hits[gy * out + gx] += 1;
            }
        }
    }
    for i in 0..out * out {
        if totals[i] > 0 {
            grid[i] = ((hits[i] * 255) / totals[i]) as u8;
        }
    }
    grid
}

/// The image at segmentation scale: capped so the sort stays interactive
/// whatever the preview size is.
pub fn segmentation_scale(img: &ImageBuf, max_edge: usize) -> ImageBuf {
    let (w, h) = (img.width, img.height);
    let long = w.max(h);
    if long <= max_edge {
        return img.clone();
    }
    let sw = (w * max_edge / long).max(1);
    let sh = (h * max_edge / long).max(1);
    let mut small = ImageBuf::new(sw, sh);
    // Box average: every source pixel lands in exactly one cell, which
    // is the smoothing the segmenter wants anyway.
    let mut counts = vec![0u32; sw * sh];
    for y in 0..h {
        for x in 0..w {
            let gx = (x * sw / w).min(sw - 1);
            let gy = (y * sh / h).min(sh - 1);
            let o = (gy * sw + gx) * 4;
            let i = (y * w + x) * 4;
            for c in 0..4 {
                small.data[o + c] += img.data[i + c];
            }
            counts[gy * sw + gx] += 1;
        }
    }
    for i in 0..sw * sh {
        let n = counts[i].max(1) as f32;
        for c in 0..4 {
            small.data[i * 4 + c] /= n;
        }
    }
    small
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Two halves, distinct colors, mild texture: a click on one side
    /// selects that side and stops at the boundary.
    fn two_tone(w: usize, h: usize) -> ImageBuf {
        let mut img = ImageBuf::new(w, h);
        for y in 0..h {
            for x in 0..w {
                let i = (y * w + x) * 4;
                let noise = ((x * 7 + y * 13) % 5) as f32 * 0.01;
                let base = if x < w / 2 { 0.2 } else { 0.7 };
                img.data[i] = base + noise;
                img.data[i + 1] = base + noise;
                img.data[i + 2] = base + noise;
                img.data[i + 3] = 1.0;
            }
        }
        img
    }

    #[test]
    fn a_click_selects_the_region_it_lands_in() {
        let img = two_tone(120, 80);
        let labels = segment(&img, 0.5, 20);
        let grid = region_coverage(&labels, 120, 80, 0.25, 0.5, 160);
        // Solid inside the clicked half...
        assert!(grid[80 * 160 + 40] > 200, "inside: {}", grid[80 * 160 + 40]);
        // ...and nothing on the far side of the boundary.
        assert!(grid[80 * 160 + 120] < 30, "outside: {}", grid[80 * 160 + 120]);
    }

    #[test]
    fn the_same_click_selects_the_same_region_every_time() {
        let img = two_tone(120, 80);
        let a = region_coverage(&segment(&img, 0.5, 20), 120, 80, 0.25, 0.5, 160);
        let b = region_coverage(&segment(&img, 0.5, 20), 120, 80, 0.25, 0.5, 160);
        assert_eq!(a, b);
    }

    #[test]
    fn tolerance_widens_what_counts_as_one_region() {
        // A gentle gradient: at low k it shatters into strips, at high k
        // it reads as one thing.
        let (w, h) = (120usize, 40usize);
        let mut img = ImageBuf::new(w, h);
        for y in 0..h {
            for x in 0..w {
                let i = (y * w + x) * 4;
                let v = x as f32 / w as f32;
                img.data[i] = v;
                img.data[i + 1] = v;
                img.data[i + 2] = v;
                img.data[i + 3] = 1.0;
            }
        }
        let covered = |k: f32| {
            let grid = region_coverage(&segment(&img, k, 8), w, h, 0.1, 0.5, 160);
            grid.iter().filter(|v| **v > 128).count()
        };
        assert!(
            covered(5.0) > covered(0.02) * 2,
            "large k merges what small k keeps apart: {} vs {}",
            covered(5.0),
            covered(0.02)
        );
    }
}
