//! The selection mask: a mask built from editable geometry.
//!
//! "as editable geometry, [a layer editor] had a way of saving
//! selection paths something similar, I don't want it rasterized down to
//! pixels."
//!
//! So a selection is a list of regions and the operations between them,
//! stored as coordinates and numbers, and rasterized fresh on every
//! render at whatever resolution is being asked for. Nothing here is
//! ever baked: move a vertex a week later and the mask follows, and the
//! preview and the 60-megapixel export are the same geometry evaluated
//! twice rather than one resampled bitmap.
//!
//! Four of the five ways the UI offers to make a selection (freehand,
//! polygon, magnetic lasso, edge-snapping paint) differ only in how the
//! points get chosen while you drag. They all hand over the same thing:
//! a closed path. Only picking by color is genuinely different, and it
//! is stored as what it is, a sample point and a tolerance, rather than
//! traced into a path that would stop meaning anything the moment the
//! image under it changed.

use std::sync::Arc;

use heeler_graph::Node;
use serde::Deserialize;

use crate::buffers::{ImageBuf, MaskBuf, Value};
use crate::executor::EngineError;
use crate::ops::{image_input, invalid_param, p, p_bool, smoothstep, to_display};

/// What a region does to the selection built so far.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SelectOp {
    /// everything before this is discarded
    Replace,
    #[default]
    Add,
    Subtract,
    /// keep only what both cover
    Intersect,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
enum Region {
    /// A closed path. Points are normalized to 0..1 of the frame.
    Path {
        #[serde(default)]
        op: SelectOp,
        points: Vec<[f32; 2]>,
        /// Corner-cutting passes, 0..1. Stored rather than applied when
        /// the stroke was drawn, so the hand-shake smoothing on a
        /// freehand path stays adjustable afterwards instead of being
        /// burned into the points.
        #[serde(default)]
        smooth: f32,
    },
    /// Pixels near a sampled color or luminance. Not a path: it is a
    /// rule about the image, and it stays a rule.
    Key {
        #[serde(default)]
        op: SelectOp,
        /// where the color was picked from, in 0..1 of the frame
        x: f32,
        y: f32,
        /// 0..1; how far from that color still counts
        tolerance: f32,
        /// "luma" keys on brightness alone, anything else on color
        #[serde(default)]
        space: String,
    },
    /// A painted stroke, thickened by its own radius.
    ///
    /// What the polish brush leaves behind. It is not a closed outline
    /// and pretending otherwise would fill in whatever the stroke
    /// happened to loop around, so it is stored as a path with a width
    /// and rasterized as one.
    Brush {
        #[serde(default)]
        op: SelectOp,
        points: Vec<[f32; 2]>,
        /// as a fraction of the shorter side, matching the brush mask
        radius: f32,
    },
    /// A pen path: anchors with symmetric handles.
    ///
    /// Each point is [x, y, hx, hy], the handle being the OUT vector
    /// from the anchor; the in-handle is its mirror, which is what
    /// makes a pen path smooth through its anchors. A zero handle is a
    /// corner. Stored as anchors rather than as the flattened polygon
    /// so the curve stays a curve: it subdivides to whatever the render
    /// size needs instead of carrying one resolution's worth of points.
    Bezier {
        #[serde(default)]
        op: SelectOp,
        points: Vec<[f32; 4]>,
    },
    /// A dragged rectangle or ellipse.
    ///
    /// Stored as the two corners it was dragged between rather than as
    /// a polygon, so it stays a shape: an ellipse rasterizes as a true
    /// ellipse at any render size instead of as however many segments
    /// the UI happened to emit, and both stay adjustable.
    Marquee {
        #[serde(default)]
        op: SelectOp,
        x0: f32,
        y0: f32,
        x1: f32,
        y1: f32,
        /// "ellipse" for an oval, anything else for a rectangle
        #[serde(default)]
        shape: String,
    },
    /// Everything whose value on one channel falls inside a range.
    ///
    /// Three menu items share this: "Select by luma range", "by color
    /// range" and "by contrast" differ only in which channel they read,
    /// so they are one rule with a channel name rather than three
    /// near-identical ones. A range is not a key: a key asks "how close
    /// to THIS color", which cannot express "every highlight above
    /// here" without picking a representative pixel first.
    ///
    /// `lo`/`hi` are in DISPLAY units, 0..1, because that is what the
    /// histogram in the dialog is drawn in. A range set against a
    /// histogram has to mean the same thing the histogram showed.
    Range {
        #[serde(default)]
        op: SelectOp,
        /// "luma", "red", "green", "blue", "saturation" or "contrast"
        #[serde(default)]
        channel: String,
        lo: f32,
        hi: f32,
        /// how far outside the range the coverage takes to fall away
        #[serde(default)]
        soft: f32,
    },
    /// Everything resembling any of a list of sampled colors.
    ///
    /// What a brush that selects as it is dragged produces: the hand
    /// says which colors are interesting by passing over them, and the
    /// picture says which other pixels are like them. Stored as the
    /// samples rather than as the pixels they matched, so it is still a
    /// rule and still follows the image if the develop settings under it
    /// change.
    Samples {
        #[serde(default)]
        op: SelectOp,
        /// points passed over, in 0..1 of the frame
        points: Vec<[f32; 2]>,
        tolerance: f32,
        #[serde(default)]
        space: String,
    },
}

impl Region {
    /// This region on a canvas past the frame (a Warp layer's mask
    /// beyond the frame, ops_masks.rs beyond_render): a rectangle's side
    /// on or past the frame's edge reaches on past it. A marquee dragged
    /// to the edge, or Select All, means everything that way, and a
    /// canvas past the frame shows it so (an ellipse's box on the edge
    /// does not make the ellipse go on). Every other region is its own
    /// geometry there; the fills place it by the canvas's window.
    fn past_the_frame(&self) -> Option<Region> {
        let Region::Marquee { op, x0, y0, x1, y1, shape } = self else { return None };
        if shape == "ellipse" {
            return None;
        }
        // Far past any margin a canvas has (beyond_margin stops at half
        // the frame a side).
        const PAST: f32 = 4.0;
        let (mut lx, mut hx, mut ly, mut hy) = (x0.min(*x1), x0.max(*x1), y0.min(*y1), y0.max(*y1));
        if lx <= 0.0 {
            lx = -PAST;
        }
        if ly <= 0.0 {
            ly = -PAST;
        }
        if hx >= 1.0 {
            hx = 1.0 + PAST;
        }
        if hy >= 1.0 {
            hy = 1.0 + PAST;
        }
        Some(Region::Marquee { op: *op, x0: lx, y0: ly, x1: hx, y1: hy, shape: shape.clone() })
    }
}

/// Whether a selection's regions read its picture's pixels (a color
/// key, a range, sampled colors), not geometry alone.
pub(crate) fn regions_read_the_picture(raw: &str) -> bool {
    serde_json::from_str::<Vec<Region>>(raw).is_ok_and(|regions| {
        regions.iter().any(|r| matches!(r, Region::Key { .. } | Region::Range { .. } | Region::Samples { .. }))
    })
}

/// Subdivides a closed pen path into the polygon that fills it.
///
/// Sixteen steps a segment: past that the difference is smaller than a
/// pixel on any frame anyone is editing, and the cost is linear in
/// anchors rather than in image size.
fn flatten_bezier(points: &[[f32; 4]]) -> Vec<[f32; 2]> {
    if points.len() < 2 {
        return points.iter().map(|p| [p[0], p[1]]).collect();
    }
    const STEPS: usize = 16;
    let mut out = Vec::with_capacity(points.len() * STEPS);
    for i in 0..points.len() {
        let a = points[i];
        let b = points[(i + 1) % points.len()];
        let p0 = [a[0], a[1]];
        let p1 = [a[0] + a[2], a[1] + a[3]];
        // The next anchor's IN handle is the mirror of its out handle.
        let p2 = [b[0] - b[2], b[1] - b[3]];
        let p3 = [b[0], b[1]];
        // Two anchors clicked without dragging have no handles, and a
        // cubic with its controls sitting on its endpoints is exactly a
        // straight line. Emitting one point instead of sixteen is not
        // an approximation, it is the same edge: it is what keeps a pen
        // path built entirely of corners as cheap as the Polygon tool
        // it replaced.
        if a[2] == 0.0 && a[3] == 0.0 && b[2] == 0.0 && b[3] == 0.0 {
            out.push(p0);
            continue;
        }
        for s in 0..STEPS {
            let t = s as f32 / STEPS as f32;
            let u = 1.0 - t;
            let (w0, w1, w2, w3) = (u * u * u, 3.0 * u * u * t, 3.0 * u * t * t, t * t * t);
            out.push([
                p0[0] * w0 + p1[0] * w1 + p2[0] * w2 + p3[0] * w3,
                p0[1] * w0 + p1[1] * w1 + p2[1] * w2 + p3[1] * w3,
            ]);
        }
    }
    out
}

/// A rectangle or ellipse, each pixel the share of it the shape covers.
///
/// It used to sample the shape at four points a pixel, so a pixel's
/// share came in quarters, a quarter off at worst. The export's pixels
/// are each a sixteenth of a Fit pixel, so the export reduced holds the
/// share to a sixty-fourth, and Fit's mask edge stood up to a quarter of
/// a Fit pixel off it: carried by a Warp layer over a step of 0.58
/// between the layer and the picture below, 0.136 off the export
/// reduced on the canyon RAW (canyon_checks.rs), where the bound is
/// 0.012. Now the share is the area itself, the same at every size: a
/// rectangle's exactly (its overlap across times its overlap down), an
/// ellipse's exactly too, the area where the pixel and the ellipse
/// meet in closed form (ellipse_cover), so Fit and export agree to
/// the float's last bits at any size and any aspect.
fn fill_marquee(
    x0: f32,
    y0: f32,
    x1: f32,
    y1: f32,
    ellipse: bool,
    w: usize,
    h: usize,
    out: &mut [f32],
    win: &crate::ops_masks::FrameWindow,
) {
    // In the frame's pixels; the buffer is the frame's from (win.x0,
    // win.y0) on, so a patch measures what the export measures.
    let (fw, fh) = (win.full_w as f32, win.full_h as f32);
    let (lx, hx) = (x0.min(x1) * fw, x0.max(x1) * fw);
    let (ly, hy) = (y0.min(y1) * fh, y0.max(y1) * fh);
    if hx - lx < 1e-6 || hy - ly < 1e-6 {
        return;
    }
    let (cx, cy) = ((lx + hx) / 2.0, (ly + hy) / 2.0);
    let (rx, ry) = ((hx - lx) / 2.0, (hy - ly) / 2.0);
    // The share of pixel (x, y) inside the shape.
    let cover = |x: usize, y: usize| -> f32 {
        let (px, py) = ((x as isize + win.x0) as f32, (y as isize + win.y0) as f32);
        if !ellipse {
            let across = ((px + 1.0).min(hx) - px.max(lx)).clamp(0.0, 1.0);
            let down = ((py + 1.0).min(hy) - py.max(ly)).clamp(0.0, 1.0);
            return across * down;
        }
        // In (u, v) the ellipse is the unit circle and the pixel an
        // axis-aligned rectangle; the share is the exact area where
        // the two meet, over the rectangle's area.
        let (u0, u1) = (((px - cx) / rx) as f64, ((px + 1.0 - cx) / rx) as f64);
        let (v0, v1) = (((py - cy) / ry) as f64, ((py + 1.0 - cy) / ry) as f64);
        ellipse_cover(u0, u1, v0, v1)
    };
    let span = |lo: f32, hi: f32, off: isize, n: usize| {
        let a = (lo.floor() as isize - off).clamp(0, n as isize) as usize;
        let b = (hi.ceil() as isize - off).clamp(0, n as isize) as usize;
        (a, b)
    };
    let (y_lo, y_hi) = span(ly, hy, win.y0, h);
    let (x_lo, x_hi) = span(lx, hx, win.x0, w);
    // PERF: rows are disjoint strips and every pixel's share is its own,
    // so the parallel rows are bit for bit.
    use rayon::prelude::*;
    out.par_chunks_mut(w)
        .enumerate()
        .skip(y_lo)
        .take(y_hi.saturating_sub(y_lo))
        .for_each(|(y, out_row)| {
            for x in x_lo..x_hi {
                let c = cover(x, y);
                if c > 0.0 {
                    out_row[x] = c;
                }
            }
        });
}

/// The share of an axis-aligned rectangle, in (u, v) where the ellipse
/// is the unit circle, that lies inside the circle: the exact area of
/// the two's overlap over the rectangle's area (fill_marquee).
fn ellipse_cover(u0: f64, u1: f64, v0: f64, v1: f64) -> f32 {
    let near = |a: f64, b: f64| if a <= 0.0 && b >= 0.0 { 0.0 } else { a.abs().min(b.abs()) };
    let (un, vn) = (near(u0, u1), near(v0, v1));
    if un * un + vn * vn >= 1.0 {
        return 0.0;
    }
    let (uf, vf) = (u0.abs().max(u1.abs()), v0.abs().max(v1.abs()));
    if uf * uf + vf * vf <= 1.0 {
        return 1.0;
    }
    // At u the circle's half height is s(u) = sqrt(1 - u^2) and the
    // covered height is the measure of [v0, v1] within [-s, s]. That
    // measure's pieces switch between a cap and s(u) only where s
    // crosses |v0| or |v1|, so on the runs between those crossings (and
    // the circle's own ends at u = -1, 1) one antiderivative, or a
    // constant, holds end to end.
    let mut cuts = [u0, u1, (-1.0f64).max(u0).min(u1), 1.0f64.max(u0).min(u1), u0, u0, u0, u0];
    let mut n = 4;
    for c in [v0.abs(), v1.abs()] {
        if c > 0.0 && c < 1.0 {
            let d = (1.0 - c * c).sqrt();
            cuts[n] = d.max(u0).min(u1);
            cuts[n + 1] = (-d).max(u0).min(u1);
            n += 2;
        }
    }
    let cuts = &mut cuts[..n];
    cuts.sort_unstable_by(|a, b| a.partial_cmp(b).unwrap());
    // The antiderivative of the circle's half height.
    let ant = |u: f64| 0.5 * (u * (1.0 - u * u).max(0.0).sqrt() + u.asin());
    let mut area = 0.0;
    for w in cuts.windows(2) {
        let (a, b) = (w[0], w[1]);
        if b - a < 1e-15 {
            continue;
        }
        let s = (1.0 - ((a + b) * 0.5).powi(2)).max(0.0).sqrt();
        if s == 0.0 {
            continue;
        }
        // The covered height is min(v1, s) less max(v0, -s); each picks
        // its branch by the run's midpoint, strictly: s only reaching
        // the cap at one point (a tangent, s = |v| = 1 at u = 0) is
        // still the circle branch end to end. The height's sign is
        // fixed on a run, so a run that nets below zero adds nothing.
        let hi = if s > v1 { v1 * (b - a) } else { ant(b) - ant(a) };
        let lo = if s > -v0 { v0 * (b - a) } else { -(ant(b) - ant(a)) };
        let d = hi - lo;
        if d > 0.0 {
            area += d;
        }
    }
    (area / ((u1 - u0) * (v1 - v0))).clamp(0.0, 1.0) as f32
}

/// The share of a pixel on the inside of a straight edge: the pixel's
/// center `s` pixels inside it, (nx, ny) the edge's unit normal. The
/// area of the unit square past a line, which is the sum of two uniform
/// spreads (the square's extent along the normal, |nx| and |ny| wide)
/// taken up to `s`: linear across the middle and quadratic at the ends,
/// where the line clips a corner.
pub(crate) fn edge_cover(s: f32, nx: f32, ny: f32) -> f32 {
    let (a, b) = (nx.abs().max(ny.abs()), nx.abs().min(ny.abs()));
    let (inner, outer) = ((a - b) * 0.5, (a + b) * 0.5);
    if !(s > -outer) {
        return 0.0;
    }
    if s >= outer {
        return 1.0;
    }
    if b < 1e-4 {
        return (0.5 + s / a).clamp(0.0, 1.0);
    }
    if s < -inner {
        let t = s + outer;
        return t * t / (2.0 * a * b);
    }
    if s <= inner {
        return 0.5 + s / a;
    }
    let t = outer - s;
    1.0 - t * t / (2.0 * a * b)
}

/// One round of Chaikin corner cutting on a closed path.
///
/// Each edge gives up its ends and keeps its middle, which pulls the
/// path off its corners and towards the average of its neighbors. Two
/// or three rounds turn a jittery hand-drawn outline into a smooth one
/// without moving it anywhere it did not already go.
fn chaikin(points: &[[f32; 2]]) -> Vec<[f32; 2]> {
    let n = points.len();
    if n < 3 {
        return points.to_vec();
    }
    let mut out = Vec::with_capacity(n * 2);
    for i in 0..n {
        let a = points[i];
        let b = points[(i + 1) % n];
        out.push([a[0] * 0.75 + b[0] * 0.25, a[1] * 0.75 + b[1] * 0.25]);
        out.push([a[0] * 0.25 + b[0] * 0.75, a[1] * 0.25 + b[1] * 0.75]);
    }
    out
}

/// How many rounds of smoothing an amount asks for.
///
/// Capped at three: past that a closed path starts pulling in towards
/// its own center and the selection visibly shrinks, which is not what
/// anyone means by "smooth out the shakes".
pub fn smooth_passes(amount: f32) -> usize {
    (amount.clamp(0.0, 1.0) * 3.0).round() as usize
}

fn smoothed(points: &[[f32; 2]], amount: f32) -> Vec<[f32; 2]> {
    let mut pts = points.to_vec();
    for _ in 0..smooth_passes(amount) {
        pts = chaikin(&pts);
    }
    pts
}

/// Fills a closed polygon (points in fractions of the buffer), each
/// pixel the share of it inside: even-odd, so a path that crosses itself
/// the way a hand-drawn one will leaves its overlaps out.
///
/// Split every row at vertices and crossings, sort its edges in each
/// band, then integrate the even-odd spans. Each boundary deposits the
/// change in coverage from the previous column; a prefix sum fills the
/// row. Applying even-odd before integration preserves crossing lobes
/// and overlapping outlines even when they share a single pixel.
fn fill_polygon(
    points: &[[f32; 2]],
    w: usize,
    h: usize,
    out: &mut [f32],
    win: &crate::ops_masks::FrameWindow,
) {
    if points.len() < 3 || w == 0 || h == 0 {
        return;
    }
    #[derive(Clone, Copy)]
    struct Edge {
        x: f64,
        y: f64,
        end: f64,
        slope: f64,
    }
    impl Edge {
        fn at(self, y: f64) -> f64 {
            self.x + (y - self.y) * self.slope
        }
    }
    let mut edges = Vec::new();
    for i in 0..points.len() {
        let (mut a, mut b) = (points[i], points[(i + 1) % points.len()]);
        if !a.iter().chain(b.iter()).all(|v| v.is_finite()) || a[1] == b[1] {
            continue;
        }
        if a[1] > b[1] {
            std::mem::swap(&mut a, &mut b);
        }
        let (x, y, end) = (
            a[0] as f64 * win.full_w as f64,
            a[1] as f64 * win.full_h as f64,
            b[1] as f64 * win.full_h as f64,
        );
        edges.push(Edge {
            x,
            y,
            end,
            slope: (b[0] as f64 * win.full_w as f64 - x) / (end - y),
        });
    }
    // Bin edges once. Rows only inspect edges that actually cross them.
    let mut rows = vec![Vec::new(); h];
    for (i, e) in edges.iter().enumerate() {
        let first = (e.y - win.y0 as f64).floor().clamp(0.0, h as f64) as usize;
        let end = (e.end - win.y0 as f64).ceil().clamp(0.0, h as f64) as usize;
        for row in &mut rows[first..end] {
            row.push(i);
        }
    }
    use rayon::prelude::*;
    out.par_chunks_mut(w)
        .zip(rows.par_iter())
        .enumerate()
        .for_each(|(y, (row, ids))| {
            let y0 = y as f64 + win.y0 as f64;
            let mut cuts = vec![y0, y0 + 1.0];
            for &i in ids {
                let e = edges[i];
                if e.y > y0 && e.y < y0 + 1.0 {
                    cuts.push(e.y);
                }
                if e.end > y0 && e.end < y0 + 1.0 {
                    cuts.push(e.end);
                }
            }
            // Even-odd is a pointwise rule. Split at crossings before
            // integrating; folding a signed area afterwards cancels the
            // opposite lobes of a bow tie inside a single pixel.
            let mut spans: Vec<_> = ids
                .iter()
                .map(|&i| {
                    let e = edges[i];
                    let (a, b) = (e.at(y0.max(e.y)), e.at((y0 + 1.0).min(e.end)));
                    (i, a.min(b), a.max(b))
                })
                .collect();
            spans.sort_by(|a, b| a.1.total_cmp(&b.1));
            for (n, &(i, _, right)) in spans.iter().enumerate() {
                // Disjoint x ranges cannot cross. A detailed lasso with
                // many separate spans must not do all pairs in every row.
                for &(j, left, _) in &spans[n + 1..] {
                    if left > right {
                        break;
                    }
                    let (a, b) = (edges[i], edges[j]);
                    if a.slope == b.slope {
                        continue;
                    }
                    let cross = y0 + (b.at(y0) - a.at(y0)) / (a.slope - b.slope);
                    if cross > y0.max(a.y).max(b.y) && cross < (y0 + 1.0).min(a.end).min(b.end) {
                        cuts.push(cross);
                    }
                }
            }
            cuts.sort_by(f64::total_cmp);
            cuts.dedup();
            let mut delta = vec![0.0f64; w + 1];
            let mut active = Vec::with_capacity(ids.len());
            for band in cuts.windows(2) {
                let (a, b) = (band[0], band[1]);
                let mid = (a + b) * 0.5;
                active.clear();
                active.extend(
                    ids.iter()
                        .copied()
                        .filter(|&i| edges[i].y <= mid && edges[i].end > mid),
                );
                active.sort_by(|&i, &j| edges[i].at(mid).total_cmp(&edges[j].at(mid)));
                for pair in active.chunks_exact(2) {
                    for (index, sign) in [(pair[0], 1.0), (pair[1], -1.0)] {
                        let edge = edges[index];
                        let (xa, xb) = (edge.at(a) - win.x0 as f64, edge.at(b) - win.x0 as f64);
                        let (lo, hi) = (xa.min(xb), xa.max(xb));
                        // Integral of the half-plane to the right of this
                        // edge, bounded before integer conversion even for
                        // finite imported coordinates far outside a frame.
                        let area = |x: f64| {
                            if x <= lo {
                                0.0
                            } else if x >= hi {
                                x - 0.5 * (lo + hi)
                            } else {
                                (x - lo) * (x - lo) / (2.0 * (hi - lo))
                            }
                        };
                        let first = lo.floor().clamp(0.0, w as f64) as usize;
                        let last = hi.ceil().clamp(0.0, w as f64) as usize;
                        let weight = (b - a) * sign;
                        let mut before = if first == 0 {
                            0.0
                        } else {
                            area(first as f64) - area(first as f64 - 1.0)
                        };
                        delta[0] += weight * before;
                        for x in first..last.min(w) {
                            let share = area(x as f64 + 1.0) - area(x as f64);
                            delta[x] += weight * (share - before);
                            before = share;
                        }
                        if last < w {
                            delta[last] += weight * (1.0 - before);
                        }
                    }
                }
            }
            let mut sum = 0.0;
            for (o, d) in row.iter_mut().zip(delta) {
                sum += d;
                *o = sum.clamp(0.0, 1.0) as f32;
            }
        });
}

fn luma(r: f32, g: f32, b: f32) -> f32 {
    0.2126 * r + 0.7152 * g + 0.0722 * b
}

/// The color under a normalized point.
fn sample_at(src: &ImageBuf, x: f32, y: f32, win: &crate::ops_masks::FrameWindow) -> [f32; 3] {
    // The frame's pixel at (x, y), in the buffer (the frame's from
    // (win.x0, win.y0) on), held at the buffer's edge.
    let at = |t: f32, full: usize, off: isize, n: usize| (((t * full as f32) as isize).max(0) - off).clamp(0, n.saturating_sub(1) as isize) as usize;
    let sx = at(x, win.full_w, win.x0, src.width);
    let sy = at(y, win.full_h, win.y0, src.height);
    let i = (sy * src.width + sx) * 4;
    [src.data[i], src.data[i + 1], src.data[i + 2]]
}

/// Coverage for pixels resembling any of `targets`.
///
/// Nearest of the set rather than an average: a brush dragged across a
/// leaf and the sky behind it has sampled two colors, and averaging
/// them selects neither. Taking the closest match means every color
/// passed over counts on its own.
fn fill_key_multi(src: &ImageBuf, targets: &[[f32; 3]], tolerance: f32, luma_only: bool, out: &mut [f32]) {
    if targets.is_empty() {
        return;
    }
    let target_lumas: Vec<f32> = targets.iter().map(|c| luma(c[0], c[1], c[2])).collect();
    // A little softness either side of the tolerance, so the edge of a
    // keyed region is not a staircase.
    let tol = tolerance.clamp(0.0, 1.0).max(1e-4);
    let soft = (tol * 0.35).max(1e-4);
    // PERF: the per-pixel nearest-target walk ran serially. Each output
    // element reads only its own pixel and the shared target list, the
    // early break included, so the parallel loop answers bit for bit.
    use rayon::prelude::*;
    out.par_iter_mut().enumerate().for_each(|(p, o)| {
        let j = p * 4;
        let px = [src.data[j], src.data[j + 1], src.data[j + 2]];
        let px_luma = luma(px[0], px[1], px[2]);
        let mut nearest = f32::INFINITY;
        for (k, t) in targets.iter().enumerate() {
            let d = if luma_only {
                (px_luma - target_lumas[k]).abs()
            } else {
                ((px[0] - t[0]).powi(2) + (px[1] - t[1]).powi(2) + (px[2] - t[2]).powi(2)).sqrt()
            };
            if d < nearest {
                nearest = d;
            }
            // Already inside the window; nothing closer can change the
            // answer, and a long drag has a lot of samples.
            if nearest <= tol {
                break;
            }
        }
        *o = 1.0 - smoothstep(tol, tol + soft, nearest);
    });
}

/// One channel of the picture, in display units, as its own plane.
///
/// Display rather than scene-linear because the dialogs draw a
/// histogram of the display-encoded preview and put the sliders on that
/// axis: a range picked at "the top third of the histogram" has to
/// select the top third of the histogram.
///
/// ACCURACY: honoring that contract means computing every derived axis
/// FROM the display-encoded channels, the way the histogram and the
/// ants do, because luma and saturation do not commute with the sRGB
/// transfer. The luma and saturation arms used to derive from linear
/// and encode after (a pure red read 0.36 on the engine's axis against
/// 0.16 on the histogram the user picks on); the audit caught it, the
/// pin flipped, and the owner ruled the engine to the histogram's
/// side. The single-channel arms were never wrong: a display byte IS
/// to_display of the channel.
fn channel_plane(src: &ImageBuf, channel: &str) -> Vec<f32> {
    let n = src.width * src.height;
    // PERF: the plane fills ran serially; each element is a pure function
    // of its own pixel, and the parallel collect preserves index order,
    // so the plane is bit for bit the serial one's.
    use rayon::prelude::*;
    if channel == "contrast" {
        // Local contrast: how far a pixel sits from its own
        // neighborhood. A flat sky reads near zero however bright it
        // is, and an edge reads high however dark. That is what makes
        // "select by contrast" select detail rather than tone.
        let mut lum = ImageBuf::new(src.width, src.height);
        lum.data.par_chunks_mut(4).enumerate().for_each(|(i, o)| {
            // Luma of the display channels, not display of the linear
            // luma: the ants build their contrast plane from byte luma,
            // and the two orders do not commute.
            let l = luma(
                to_display(src.data[i * 4].max(0.0)),
                to_display(src.data[i * 4 + 1].max(0.0)),
                to_display(src.data[i * 4 + 2].max(0.0)),
            );
            o[0] = l;
            o[1] = l;
            o[2] = l;
            o[3] = 1.0;
        });
        // Sigma scaled to the frame so the same setting means the same
        // thing at preview size and at full size.
        let sigma = (src.width.min(src.height) as f32 * 0.004).max(0.8);
        let soft = crate::ops_detail::gaussian_blur_pub(&lum, sigma);
        // Doubled: the high-pass of a photograph rarely reaches 0.5,
        // and a slider whose top half never fires is a broken slider.
        return (0..n)
            .into_par_iter()
            .map(|i| ((lum.data[i * 4] - soft.data[i * 4]).abs() * 2.0).clamp(0.0, 1.0))
            .collect();
    }
    (0..n)
        .into_par_iter()
        .map(|i| {
            // Encode first, derive after: every axis is a function of
            // the display channels, exactly as the histogram and the
            // ants compute it.
            let d = [
                to_display(src.data[i * 4].max(0.0)),
                to_display(src.data[i * 4 + 1].max(0.0)),
                to_display(src.data[i * 4 + 2].max(0.0)),
            ];
            match channel {
                "red" => d[0],
                "green" => d[1],
                "blue" => d[2],
                "saturation" => {
                    let max = d[0].max(d[1]).max(d[2]);
                    let min = d[0].min(d[1]).min(d[2]);
                    if max <= 1e-6 { 0.0 } else { ((max - min) / max).clamp(0.0, 1.0) }
                }
                _ => luma(d[0], d[1], d[2]),
            }
        })
        .collect()
}

/// Ramp: sharpen the partial-alpha transition, and bias it in or out.
///
/// One layer editor's control, and it is better than another's answer
/// to the same problem. That other one needs Contrast to harden the edge and Shift
/// Edge to move it, and both of them act on everything, so a hard
/// Contrast can eat into the solid interior of a selection. This touches
/// only pixels that are neither fully in nor fully out: solid stays
/// solid, empty stays empty, and the only thing that moves is the ramp
/// between them.
///
/// Positive pushes the transition outward (more selected), negative
/// pulls it in. The sharpening rises with the magnitude, which is what
/// makes one slider enough.
fn apply_ramp(mask: &mut [f32], ramp: f32) {
    let r = (ramp / 100.0).clamp(-1.0, 1.0);
    if r.abs() < 1e-4 {
        return;
    }
    // A midpoint shifted against the bias, and a steeper curve through
    // it. At full tilt the transition is nearly a step.
    let mid = 0.5 - r * 0.4;
    let steep = 1.0 + r.abs() * 7.0;
    // PERF: the remap ran serially; each element is the same pure
    // function of its own value (the solid/empty skip included), so the
    // parallel form is bit for bit.
    use rayon::prelude::*;
    mask.par_iter_mut().for_each(|v| {
        // Fully in and fully out are left exactly alone, which is the
        // whole point of the control.
        if *v <= 0.0 || *v >= 1.0 {
            return;
        }
        let t = ((*v - mid) * steep + 0.5).clamp(0.0, 1.0);
        *v = t * t * (3.0 - 2.0 * t);
    });
}

/// A linear stretch about the half-way line, 0 to 100: at 0 the alpha
/// is the model's own, at 50 a quarter and below is nothing and three
/// quarters and above is full with the line between them straight, at
/// 100 the edge is a hard cut at a half. The half-way line itself never
/// moves, so the ants (traced at a half) stay where the model put them.
fn matte_contrast(mask: &mut [f32], contrast: f32) {
    let c = (contrast / 100.0).clamp(0.0, 1.0);
    if c < 1e-4 {
        return;
    }
    let lo = 0.5 * c;
    let hi = 1.0 - 0.5 * c;
    use rayon::prelude::*;
    mask.par_iter_mut().for_each(|v| {
        *v = if hi - lo < 1e-4 {
            if *v >= 0.5 { 1.0 } else { 0.0 }
        } else {
            ((*v - lo) / (hi - lo)).clamp(0.0, 1.0)
        };
    });
}

/// Runs every polish stroke, in the order it was painted.
///
/// Four modes, matching what both apps settled on, because they settled
/// on the right four: re-analyze the edge, add, subtract, and soften.
/// The first is the clever one and the other three are what you reach
/// for when the clever one gets 90% of it.
fn apply_polish(
    mask: &mut MaskBuf,
    node: &Node,
    src: &ImageBuf,
    w: usize,
    h: usize,
    frame: &crate::ops_masks::FrameWindow,
) -> Result<(), EngineError> {
    let raw = node.params.get("strokes").and_then(|v| v.as_str()).unwrap_or("[]");
    let strokes: Vec<PolishStroke> = serde_json::from_str(raw)
        .map_err(|e| invalid_param(node, "strokes", format!("bad polish JSON: {e}")))?;
    if strokes.is_empty() {
        return Ok(());
    }
    // No global strength. Neither reference layer editor has one, and
    // they are right: the brush already has flow, and a second
    // multiplier over the top of it is one more thing to be at the
    // wrong setting when a stroke does not take.
    let strength = 1.0f32;
    let mut cov = vec![0.0f32; w * h];
    // PERF: the coverage clear and the three stroke-mode combines all
    // ran serially over the whole frame; every one is per-element pure
    // (max, min, and the feather blend each read their own slots), so
    // the parallel forms are bit for bit. The feather mode's blur rides
    // the parallel feather_mask.
    use rayon::prelude::*;
    for stroke in &strokes {
        if stroke.points.is_empty() {
            continue;
        }
        cov.par_iter_mut().for_each(|v| *v = 0.0);
        fill_brush(&stroke.points, stroke.radius, w, h, &mut cov, frame);
        let short = frame.short();
        let win = (stroke.radius * short).round().max(1.0) as i32;
        match stroke.mode.as_str() {
            // Add and subtract are ordinary painting, which is most of
            // the work once the matte has done its part.
            "foreground" => {
                mask.data
                    .par_iter_mut()
                    .zip(cov.par_iter())
                    .for_each(|(m, c)| {
                        *m = m.max(*c);
                    });
            }
            "background" => {
                mask.data
                    .par_iter_mut()
                    .zip(cov.par_iter())
                    .for_each(|(m, c)| {
                        *m = m.min(1.0 - *c);
                    });
            }
            // Soften just here, rather than everywhere at once.
            "feather" => {
                let r = win.max(1) as usize;
                let mut soft = mask.data.clone();
                feather_mask(&mut soft, w, h, r);
                mask.data
                    .par_iter_mut()
                    .zip(soft.par_iter())
                    .zip(cov.par_iter())
                    .for_each(|((m, s), c)| {
                        *m += (*s - *m) * c.clamp(0.0, 1.0);
                    });
            }
            // Matte strokes are the model's now: the stroke marks the band, the
            // desktop runs ViTMatte over it, and the answer arrives as this node's
            // planted raster base. The classical sampler that used to run here is
            // retired: its cost grew with every stroke until the render queue
            // drowned (the owner watched 400ms climb to 4s per preview), and its
            // quality on fur is the reason the tool was gated. In the engine a
            // matte stroke is a no-op on purpose; without the planted raster
            // (model absent, foreign machine) the mask renders the geometry and
            // the other strokes, honestly coarse, never slow.
            _ => {
                let _ = (src, win, strength);
            }
        }
    }
    Ok(())
}

/// Each region filled and combined onto `out` in order, by its own op:
/// the one loop a selection's geometry, a stroke's clip and the shapes
/// drawn on a Smart or Object mask all run (2026-10-02: a Subtract
/// drawn over a Smart layer's over-selected edge "didn't work"). `out`
/// is what is already there: zero for a selection's geometry alone, a
/// model's matte for a Smart mask, a bake for a converted selection.
/// `w` by `h` is the plane, `win` where it lies in the frame.
fn combine_regions(
    out: &mut [f32],
    regions: &[Region],
    src: &ImageBuf,
    depth: Option<&[f32]>,
    w: usize,
    h: usize,
    win: &crate::ops_masks::FrameWindow,
) {
    debug_assert_eq!(out.len(), w * h);
    if regions.is_empty() {
        return;
    }
    let win = *win;
    let mut scratch = vec![0.0f32; w * h];
    // PERF: the scratch clear and the combine are per-element pure (the
    // combine reads its own two slots and applies one pure function),
    // so the parallel forms are bit for bit. The region fills in
    // between keep their own guarantees.
    use rayon::prelude::*;
    for region in regions {
        scratch.par_iter_mut().for_each(|v| *v = 0.0);
        let op = match region {
            Region::Path { op, points, smooth } => {
                let pts = smoothed(points, *smooth);
                fill_polygon(&pts, w, h, &mut scratch, &win);
                *op
            }
            Region::Key { op, x, y, tolerance, space } => {
                let target = sample_at(src, *x, *y, &win);
                fill_key_multi(src, &[target], *tolerance, space == "luma", &mut scratch);
                *op
            }
            Region::Brush { op, points, radius } => {
                fill_brush(points, *radius, w, h, &mut scratch, &win);
                *op
            }
            Region::Bezier { op, points } => {
                fill_polygon(&flatten_bezier(points), w, h, &mut scratch, &win);
                *op
            }
            Region::Marquee { op, x0, y0, x1, y1, shape } => {
                fill_marquee(*x0, *y0, *x1, *y1, shape == "ellipse", w, h, &mut scratch, &win);
                *op
            }
            Region::Range { op, channel, lo, hi, soft } => {
                fill_range(src, channel, *lo, *hi, *soft, depth, &mut scratch);
                *op
            }
            Region::Samples { op, points, tolerance, space } => {
                let targets: Vec<[f32; 3]> = points.iter().map(|p| sample_at(src, p[0], p[1], &win)).collect();
                fill_key_multi(src, &targets, *tolerance, space == "luma", &mut scratch);
                *op
            }
        };
        out.par_iter_mut().zip(scratch.par_iter()).for_each(|(m, r)| {
            *m = combine(*m, *r, op);
        });
    }
}

/// The shapes drawn on a Smart or Object mask (its "regions" param),
/// combined onto the model's or the file's coverage in `mask`: a
/// Subtract takes its shape out, an Add puts it in, an Intersect keeps
/// only what is inside it, at whatever size the render is (the regions
/// are fractions of the frame). The plane is the whole frame: these
/// masks are cut for the 1:1 slice on their own wire, after they render.
pub(crate) fn combine_drawn_shapes(node: &Node, inputs: &[(String, Value)], src: &ImageBuf, mask: &mut MaskBuf) -> Result<(), EngineError> {
    let raw = node.params.get("regions").and_then(|v| v.as_str()).unwrap_or("[]");
    let regions: Vec<Region> =
        serde_json::from_str(raw).map_err(|e| invalid_param(node, "regions", format!("bad selection JSON: {e}")))?;
    if regions.is_empty() {
        return Ok(());
    }
    let (w, h) = (mask.width, mask.height);
    let win = crate::ops_masks::FrameWindow::whole(w, h);
    let depth_in = crate::ops_depth::plane_for_node(node, inputs, "depth", w, h);
    combine_regions(&mut mask.data, &regions, src, depth_in.as_deref(), w, h, &win);
    Ok(())
}

/// The coverage a list of regions combines to, with none of the polish.
///
/// Pulled out so a paint stroke can carry the selection it was made
/// under. A stroke restricted to a selection has to STAY restricted when
/// that selection is later changed or cleared: the paint you laid down
/// inside a selection is paint you laid down, and deselecting is not a
/// request to erase it.
///
/// `win` places `src` in the frame: on the 1:1 patch a stroke's
/// selection is laid on the patch's own pixels of the frame. Laid on the
/// patch as if it were the frame, a stroke clipped to a selection was
/// clipped to the selection squeezed into the 1:1 view.
pub(crate) fn regions_coverage(
    raw: &str,
    src: &ImageBuf,
    depth: Option<&[f32]>,
    win: crate::ops_masks::FrameWindow,
) -> Option<Vec<f32>> {
    let regions: Vec<Region> = serde_json::from_str(raw).ok()?;
    if regions.is_empty() {
        return None;
    }
    let (w, h) = (src.width, src.height);
    let mut out = vec![0.0f32; w * h];
    combine_regions(&mut out, &regions, src, depth, w, h, &win);
    Some(out)
}

/// One polish stroke: where the hand went, how wide, and what it meant.
///
/// Both reference layer editors make this a brush, and they are right to.
/// A selection's edge is not one problem: a shoulder is settled, the
/// hair beside it is not, and a control that treats them alike can only
/// serve one of them. So the refinement happens where you paint it.
///
/// Stored as geometry like every other stroke here, which is where this
/// parts company with both: theirs bake on Apply and re-entering means
/// re-refining the baked result. These stay strokes, so picking the tool
/// up next week and erasing one of them is an ordinary thing to do.
#[derive(Deserialize)]
struct PolishStroke {
    points: Vec<[f32; 2]>,
    /// fraction of the shorter side, like every brush here
    radius: f32,
    /// "matte", "foreground", "background" or "feather"
    #[serde(default)]
    mode: String,
}

/// Coverage for pixels whose channel value lands between `lo` and `hi`.
///
/// Soft on BOTH sides, and outward only: the range the user set is
/// selected in full, and the falloff happens outside it. Softening
/// inward would mean a range dragged to cover a histogram peak selected
/// less than the peak.
fn fill_range(
    src: &ImageBuf,
    channel: &str,
    lo: f32,
    hi: f32,
    soft: f32,
    depth: Option<&[f32]>,
    out: &mut [f32],
) {
    let (lo, hi) = (lo.min(hi), lo.max(hi));
    let s = soft.clamp(0.0, 1.0).max(1e-4);
    // The depth channel reads the injected farness plane, not the
    // pixels; without a computed plane it selects nothing (honest,
    // and the DepthRunner computes one the moment the region exists).
    let plane = if channel == "depth" {
        match depth {
            Some(d) => d.to_vec(),
            None => {
                out.iter_mut().for_each(|v| *v = 0.0);
                return;
            }
        }
    } else {
        channel_plane(src, channel)
    };
    // PERF: the window test ran serially; each output element reads only
    // its own plane value, so the parallel zip is bit for bit.
    use rayon::prelude::*;
    out.par_iter_mut()
        .zip(plane.par_iter())
        .for_each(|(o, v)| {
            *o = if *v < lo {
                smoothstep(lo - s, lo, *v)
            } else if *v > hi {
                1.0 - smoothstep(hi, hi + s, *v)
            } else {
                1.0
            };
        });
}

/// Draws a round stroke of a given width into `out`.
///
/// Each segment is a capsule and each pixel the share of the stroke
/// inside its square (brush_cover.rs, the sweep every brush stroke
/// takes), so the edge is one smooth line and a Fit pixel is the
/// export's reduced. This used to stamp dabs every half radius, which
/// read as a row of circles along the edge ("the strokes
/// are not smooth as I can see the individual circles"); then it took
/// the distance at the pixel's center through a smoothstep a pixel
/// wide, a window as wide as whatever pixel the render had, so at Fit
/// the edge stood up to 0.149 off its export reduced.
fn fill_brush(points: &[[f32; 2]], radius: f32, w: usize, h: usize, out: &mut [f32], win: &crate::ops_masks::FrameWindow) {
    if points.is_empty() || w == 0 || h == 0 {
        return;
    }
    // In the frame's pixels (radius a share of its short side), the
    // buffer the frame's from (win.x0, win.y0) on.
    let r = (radius * win.short()).max(crate::ops_masks::MIN_RADIUS_PX);
    let px: Vec<(f32, f32)> = points.iter().map(|p| win.at(*p)).collect();
    crate::brush_cover::sweep(out, w, h, (win.x0, win.y0), &px, r, 1.0, crate::brush_cover::Metric::Round, |c, _, _| c);
}

/// Distance in pixels from the selection's edge, negative inside.
///
/// Two passes of a chamfer transform rather than an exact euclidean one:
/// the error is under a couple of percent and it costs two sweeps of the
/// buffer instead of a search per pixel. Growing and shrinking a
/// selection is a thing people drag a slider on, so it has to be cheap
/// enough to redo on every frame.
fn signed_distance(mask: &[f32], w: usize, h: usize) -> Vec<f32> {
    const FAR: f32 = 1e6;
    // Distance out of the selection, and distance into it, done the same
    // way on the inverted mask and then subtracted.
    let sweep = |inside: bool| -> Vec<f32> {
        let mut d: Vec<f32> = mask
            .iter()
            .map(|&v| {
                let is = if inside { v >= 0.5 } else { v < 0.5 };
                if is { 0.0 } else { FAR }
            })
            .collect();
        // Chamfer weights: 1 straight, sqrt(2) diagonal.
        const S: f32 = 1.0;
        const DG: f32 = std::f32::consts::SQRT_2;
        for y in 0..h {
            for x in 0..w {
                let i = y * w + x;
                let mut best = d[i];
                if y > 0 {
                    best = best.min(d[i - w] + S);
                    if x > 0 {
                        best = best.min(d[i - w - 1] + DG);
                    }
                    if x + 1 < w {
                        best = best.min(d[i - w + 1] + DG);
                    }
                }
                if x > 0 {
                    best = best.min(d[i - 1] + S);
                }
                d[i] = best;
            }
        }
        for y in (0..h).rev() {
            for x in (0..w).rev() {
                let i = y * w + x;
                let mut best = d[i];
                if y + 1 < h {
                    best = best.min(d[i + w] + S);
                    if x + 1 < w {
                        best = best.min(d[i + w + 1] + DG);
                    }
                    if x > 0 {
                        best = best.min(d[i + w - 1] + DG);
                    }
                }
                if x + 1 < w {
                    best = best.min(d[i + 1] + S);
                }
                d[i] = best;
            }
        }
        d
    };
    let out_d = sweep(true);
    let in_d = sweep(false);
    (0..mask.len()).map(|i| out_d[i] - in_d[i]).collect()
}

/// Moves the selection's edge outward or inward by `pixels`.
///
/// Rebuilt from the distance field rather than by repeatedly dilating,
/// so a shrink of twelve pixels costs the same as a shrink of one and
/// the edge stays smooth instead of picking up the shape of whatever
/// kernel was used.
pub fn grow_mask(mask: &mut [f32], w: usize, h: usize, pixels: f32) {
    if pixels.abs() < 0.01 || w == 0 || h == 0 {
        return;
    }
    let d = signed_distance(mask, w, h);
    for (m, dist) in mask.iter_mut().zip(&d) {
        // Half a pixel either side of the new boundary, so the result is
        // antialiased rather than a hard step.
        *m = 1.0 - smoothstep(pixels - 0.5, pixels + 0.5, *dist);
    }
}

/// Rounds off the jagged edges a hand-drawn selection leaves.
///
/// Blur and re-threshold: a corner sharper than the blur radius loses
/// more of its area than a straight edge does, so the corners round and
/// the straight parts stay where they are. That is what "smooth" means
/// on a selection, as opposed to feather, which softens the edge without
/// moving it.
pub fn smooth_mask(mask: &mut [f32], w: usize, h: usize, radius: usize) {
    if radius == 0 || w == 0 || h == 0 {
        return;
    }
    let mut work = mask.to_vec();
    feather_mask(&mut work, w, h, radius);
    for (m, &v) in mask.iter_mut().zip(work.iter()) {
        *m = 1.0 - smoothstep(0.45, 0.55, 1.0 - v);
    }
}

/// Separable box blur, run twice, which is close enough to a gaussian
/// for a mask edge and far cheaper.
///
/// PERF: the four sweeps ran serially over the whole frame, and the
/// window is summed FRESH per pixel, O(n*r): one feather unit is a 67
/// px radius on a 1350-short-side frame, and a polished selection paid
/// over a second (16.7 s at feather 25). The window sum stays exactly
/// as it was, ascending k and fresh per pixel, because a sliding window
/// would reorder the float additions and change bits; what parallelizes
/// is the rows of the horizontal pass and the columns of the vertical
/// one, each row or column an independent strip of the same sums.
/// (blur_mask in ops_masks.rs is the sliding-window version of this and
/// already says so; this one stays fresh-summed for bit-exactness.)
fn feather_mask(data: &mut [f32], w: usize, h: usize, radius: usize) {
    if radius == 0 || w == 0 || h == 0 {
        return;
    }
    use rayon::prelude::*;
    let mut tmp = vec![0.0f32; data.len()];
    for _ in 0..2 {
        // Horizontal: each output row is a function of the same input
        // row only.
        tmp.par_chunks_mut(w)
            .enumerate()
            .for_each(|(y, tmp_row)| {
                let row = y * w;
                for x in 0..w {
                    let lo = x.saturating_sub(radius);
                    let hi = (x + radius).min(w - 1);
                    let mut sum = 0.0;
                    for k in lo..=hi {
                        sum += data[row + k];
                    }
                    tmp_row[x] = sum / (hi - lo + 1) as f32;
                }
            });
        // Vertical: each output element sums its own column ascending
        // in y, so row-parallel chunks give every column the same sums
        // in the same order.
        data.par_chunks_mut(w)
            .enumerate()
            .for_each(|(y, data_row)| {
                for x in 0..w {
                    let lo = y.saturating_sub(radius);
                    let hi = (y + radius).min(h - 1);
                    let mut sum = 0.0;
                    for k in lo..=hi {
                        sum += tmp[k * w + x];
                    }
                    data_row[x] = sum / (hi - lo + 1) as f32;
                }
            });
    }
}

/// "Feather follows the picture": the mask softened by the guided filter
/// with the photograph as the guide, at the feather's own radius. Where
/// the photograph is flat within the radius the result is the plain
/// feather; where it has an edge (a hairline, fur against a wall) the
/// softening stops there, so the transition takes the picture's own
/// contour instead of blurring straight across it. A layer editor's
/// Smart Radius without a model, live. The guide is OkLab, chroma at
/// twice its size, the form the Depth Map's refinement uses, with an eps
/// that lets a surface's texture and a JPEG's chroma blocks smooth and
/// stops at an edge of a few hundredths of lightness. The box means are
/// cut at the frame (BoxEdge::Truncate) as the plain feather's are, so a
/// selection that touches the frame feathers there as it always did
/// rather than growing into the repeated edge. The guide is the
/// photograph as the mask's input carries it, the source before this
/// layer's own edits and the ones after it (the 2026-09-23 review's R4),
/// deliberately: the object's boundary is in the source whatever a later
/// treatment does to its color, and a guide upstream of the edits does
/// not re-run the feather when a slider on another layer moves.
fn feather_along_picture(mask: &mut [f32], src: &ImageBuf, w: usize, h: usize, radius: usize) {
    if radius == 0 || w == 0 || h == 0 {
        return;
    }
    use rayon::prelude::*;
    let mut ll = vec![0.0f32; w * h];
    let mut ga = vec![0.0f32; w * h];
    let mut gb = vec![0.0f32; w * h];
    ll.par_iter_mut()
        .zip(ga.par_iter_mut())
        .zip(gb.par_iter_mut())
        .zip(src.data.par_chunks(4))
        .for_each(|(((l, a), b), px)| {
            let lab = crate::color::linear_to_oklab(px[0].max(0.0), px[1].max(0.0), px[2].max(0.0));
            *l = lab[0];
            *a = lab[1] * 2.0;
            *b = lab[2] * 2.0;
        });
    crate::ops::guided_blur_planes(&mut [mask], [&ll, &ga, &gb], w, h, radius, 0.03 * 0.03, crate::ops::BoxEdge::Truncate);
    for v in mask.iter_mut() {
        *v = v.clamp(0.0, 1.0);
    }
}

/// Combines one region's coverage into the selection so far.
pub fn combine(current: f32, region: f32, op: SelectOp) -> f32 {
    match op {
        SelectOp::Replace => region,
        SelectOp::Add => current.max(region),
        SelectOp::Subtract => current * (1.0 - region),
        SelectOp::Intersect => current.min(region),
    }
}

/// A planted raster (its first channel) laid onto a `w` x `h` plane by
/// bilinear resampling at the pixel centers: a selection's refined or
/// baked base, and a pixel mask's base (ops_masks.rs brush_mask), read
/// the same way so a mask converted from a selection lands on the same
/// pixels. The plane is `win` of the frame: the frame itself, or for a
/// Warp layer's mask beyond the frame (ops_masks.rs beyond_render) the
/// frame and a margin, where the raster lies on the frame's pixels and
/// holds at its own edge past them, the same raster at every size.
pub(crate) fn raster_onto_window(r: &ImageBuf, out: &mut [f32], w: usize, h: usize, win: crate::ops_masks::FrameWindow) {
    debug_assert_eq!(out.len(), w * h);
    let (rw, rh) = (r.width, r.height);
    let (fw, fh) = (win.full_w, win.full_h);
    // PERF: the bilinear resample ran serially over the frame; each
    // output pixel reads the same four raster texels and lerps them
    // in the same order, so the parallel rows are bit for bit.
    use rayon::prelude::*;
    out.par_chunks_mut(w).enumerate().for_each(|(y, mask_row)| {
        let sy = (((y as isize + win.y0) as f32 + 0.5) * rh as f32 / fh as f32 - 0.5).clamp(0.0, (rh - 1) as f32);
        let y0 = sy.floor() as usize;
        let y1 = (y0 + 1).min(rh - 1);
        let fy = sy - y0 as f32;
        for x in 0..w {
            let sx = (((x as isize + win.x0) as f32 + 0.5) * rw as f32 / fw as f32 - 0.5).clamp(0.0, (rw - 1) as f32);
            let x0 = sx.floor() as usize;
            let x1 = (x0 + 1).min(rw - 1);
            let fx = sx - x0 as f32;
            let at = |px: usize, py: usize| r.data[(py * rw + px) * 4];
            let top = at(x0, y0) + (at(x1, y0) - at(x0, y0)) * fx;
            let bot = at(x0, y1) + (at(x1, y1) - at(x0, y1)) * fx;
            mask_row[x] = (top + (bot - top) * fy).clamp(0.0, 1.0);
        }
    });
}

pub(crate) fn selection_mask(
    node: &Node,
    inputs: &[(String, Value)],
) -> Result<Value, EngineError> {
    if let Some(v) = crate::ops_masks::beyond_render(node, inputs, selection_mask)? {
        return Ok(v);
    }
    let src = image_input(inputs, "in", &node.id)?;
    // Where this canvas lies in the frame: the frame itself, but for a
    // Warp layer's mask beyond the frame (beyond_render).
    let (cw, ch) = crate::ops_masks::canvas_of(node, src);
    let win = crate::ops_masks::FrameWindow::from_params(&node.params, cw, ch);
    let raw = node
        .params
        .get("regions")
        .and_then(|v| v.as_str())
        .unwrap_or("[]");
    let regions: Vec<Region> = serde_json::from_str(raw)
        .map_err(|e| invalid_param(node, "regions", format!("bad selection JSON: {e}")))?;
    // The depth-range channel's farness plane, when the desktop
    // planted one (the "raster" slot is the matte/baked base, so
    // depth rides its own).
    let depth_in = crate::ops_depth::plane_for_node(node, inputs, "depth", cw, ch);
    // Clamped only where the limit is real. These three used to be
    // pinned to the slider's range, so a value typed past it was thrown
    // away here even after the graph had agreed to carry it. Negative
    // softening is meaningless; a softening larger than the slider
    // offers is merely unusual.
    let feather = p(&node.params, "feather", 0.0).max(0.0);
    // Polish: move the edge, then round it off, then soften it. In that
    // order, because growing a jagged edge grows the jags, and
    // feathering before smoothing would smooth the feather instead of
    // the shape.
    let grow = p(&node.params, "grow", 0.0);
    let smooth = p(&node.params, "smooth", 0.0).max(0.0);
    let invert = p_bool(&node.params, "invert", false);

    let (w, h) = (cw, ch);
    let mut mask = MaskBuf::new(w, h);

    // The ViTMatte-refined base (P4): when the desktop planted a
    // refined raster for this node, it stands in for the region
    // rasterization: the model already resolved the same geometry
    // against the photograph, strand by strand. Everything below
    // (grow, smooth, polish strokes, feather, ramp, invert) still
    // applies: the matte is a better base, not a different tool. No
    // raster planted (never refined, or the regions changed since)
    // means the geometry renders classically, as it always did.
    let refined = inputs
        .iter()
        .find(|(port, _)| port == "raster")
        .and_then(|(_, v)| v.as_image());
    // A BAKED base is coverage already rendered, with whatever Contrast
    // shaped it at the bake; stretching it again changed every
    // converted selection the moment it loaded (review R2, 2026-09-23).
    // Contrast is live on a raw refinement only; on a baked base the
    // desktop applies it to the model's answer at the bake, once.
    let baked = node
        .params
        .get("matte_id")
        .and_then(|v| v.as_str())
        .is_some_and(|m| m.starts_with("baked:"));
    if let Some(r) = refined {
        raster_onto_window(r, &mut mask.data, w, h, win);
        // Contrast (the Polish panel's dial, the owner 2026-09-22): how
        // decided the refined edge reads. The model answers a compositing
        // matte, a soft alpha everywhere it is unsure, and on a defocused
        // edge that is a haze of 0.1 to 0.4 for tens of pixels beside the
        // fur. A selection wants the half-way line decided and the strands'
        // partial cover kept, and how much of each is the photograph's call:
        // the lemur wanted the haze gone, another photo keeps every faint
        // hair. Live here, on the planted base alone, so a drag costs a
        // render and never a re-read of the edge, and the strokes, feather
        // and ramp below see the base they always did.
        if !baked {
            matte_contrast(&mut mask.data, p(&node.params, "matte_contrast", 25.0));
        }
    }

    // A matte base REPLACES the region rasterization (the model
    // resolved the same geometry, so running both would double it). A
    // BAKED base - a converted smart selection - is the geometry's
    // starting point instead: the regions the user draws afterwards
    // are new edits and combine on top.
    let regions: &[Region] = if refined.is_some() && !baked { &[] } else { &regions };
    // Past the frame, a rectangle on its edge reaches on (beyond_render).
    let past = win.x0 < 0 || win.y0 < 0 || win.x0 + w as isize > win.full_w as isize || win.y0 + h as isize > win.full_h as isize;
    let placed: Vec<Region>;
    let regions: &[Region] = if past {
        placed = regions.iter().map(|r| r.past_the_frame().unwrap_or_else(|| r.clone())).collect();
        &placed
    } else {
        regions
    };
    combine_regions(&mut mask.data, regions, src, depth_in.as_deref(), w, h, &win);
    use rayon::prelude::*;

    // All three at the end rather than per region: doing any of them
    // first would work on the seams between regions that are meant to
    // butt up against each other, and a selection built from five pieces
    // would look like five pieces.
    let short = win.short();
    grow_mask(&mut mask.data, w, h, grow * 0.05 * short);
    smooth_mask(&mut mask.data, w, h, (smooth * 0.03 * short).round() as usize);
    // Polish before feather: the strokes decide where the edge IS, and
    // feathering is how soft it becomes once that is settled.
    apply_polish(&mut mask, node, src, w, h, &win)?;
    let radius = (feather * 0.05 * short).round() as usize;
    if p_bool(&node.params, "feather_guided", false) {
        feather_along_picture(&mut mask.data, src, w, h, radius);
    } else {
        feather_mask(&mut mask.data, w, h, radius);
    }
    // Ramp last of the shaping controls: it works ON the transition, so
    // it has to run after whatever made one.
    apply_ramp(&mut mask.data, p(&node.params, "ramp", 0.0));

    // Antialiasing off means the edge is a decision rather than a ramp:
    // every pixel is either in or out. Applied last, after grow, smooth
    // and feather, because those all work in fractions and hardening
    // first would throw away the very information they read.
    //
    // Feather and antialias are not the same switch: feather says how
    // WIDE the ramp is, this says whether there is one at all. Turning
    // this off with a feather set is a contradiction the user is
    // allowed to make, and hardening wins.
    if !p_bool(&node.params, "antialias", true) {
        mask.data.par_iter_mut().for_each(|v| {
            *v = if *v >= 0.5 { 1.0 } else { 0.0 };
        });
    }

    if invert {
        mask.data.par_iter_mut().for_each(|v| {
            *v = 1.0 - *v;
        });
    }
    crate::ops_masks::depth_weight_mask(node, inputs, &mut mask);
    Ok(Value::Mask(Arc::new(mask)))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ops::test_util::*;

    /// A marquee's or a lasso's mask at Fit is the export's reduced: each
    /// pixel the share of it the shape covers, at every size. Sampled at
    /// four points a pixel (a marquee) or four sub-scanlines a row (a
    /// lasso), a Fit pixel's share came in quarters while the export
    /// reduced holds it to a sixty-fourth: an ellipse's edge 0.25 off, a
    /// rectangle's and a lasso's 0.125.
    ///
    /// A selection's brush region and a paint stroke the same (brush_cover.rs):
    /// their edges were a smoothstep a pixel wide, a pixel of whatever size
    /// the render was, so a hard brush's edge at Fit stood 0.149 off.
    #[test]
    fn a_marquee_or_lasso_at_fit_is_its_export_reduced() {
        let (w, h) = (1604usize, 1204usize);
        for regions in [
            r#"[{"kind":"marquee","op":"add","shape":"ellipse","x0":0.78,"y0":0.55,"x1":1.0,"y1":0.8}]"#,
            r#"[{"kind":"marquee","op":"add","shape":"ellipse","x0":0.1037,"y0":0.18,"x1":0.8,"y1":0.5013}]"#,
            r#"[{"kind":"marquee","op":"add","shape":"rect","x0":0.2011,"y0":0.3007,"x1":0.6993,"y1":0.7021}]"#,
            r#"[{"kind":"marquee","op":"add","shape":"ellipse","x0":0.5,"y0":0.5,"x1":0.5031,"y1":0.5043}]"#,
            r#"[{"kind":"path","op":"add","points":[[0.1013,0.2007],[0.8021,0.2109],[0.7,0.8013],[0.3,0.6],[0.1,0.79]]}]"#,
            r#"[{"kind":"brush","op":"add","radius":0.0213,"points":[[0.1013,0.2007],[0.3021,0.2509],[0.5,0.4013],[0.62,0.43],[0.8,0.39]]}]"#,
            r#"[{"kind":"brush","op":"add","radius":0.0033,"points":[[0.2013,0.6007],[0.7021,0.6509]]}]"#,
            // Adversarial (review 2026-10-02): a thin ellipse's caps turn
            // within a pixel even when the ellipse is wide; a sliver is
            // caps end to end; a path hugging the frame's edge runs some
            // of its vertices past it.
            r#"[{"kind":"marquee","op":"add","shape":"ellipse","x0":0.1,"y0":0.4,"x1":0.9,"y1":0.46}]"#,
            r#"[{"kind":"marquee","op":"add","shape":"ellipse","x0":0.3,"y0":0.2,"x1":0.34,"y1":0.8}]"#,
            r#"[{"kind":"path","op":"add","points":[[-0.05,0.2],[0.5,0.22],[1.06,0.2],[1.04,0.6],[0.4,0.58],[-0.03,0.61]]}]"#,
        ] {
            let mut node = make_node("heeler.selection_mask");
            set_text(&mut node, "regions", regions);
            let mask = |w: usize, h: usize| run_on(&node, ImageBuf::filled(w, h, [0.5, 0.5, 0.5, 1.0])).unwrap().as_mask().unwrap().as_ref().clone();
            let (full, fit) = (mask(w, h), mask(w / 4, h / 4));
            let mut worst = (0.0f32, 0, 0);
            for y in 0..h / 4 {
                for x in 0..w / 4 {
                    let mut r = 0.0f32;
                    for j in 0..4 {
                        for i in 0..4 {
                            r += full.data[(y * 4 + j) * w + x * 4 + i] / 16.0;
                        }
                    }
                    let d = (fit.data[y * (w / 4) + x] - r).abs();
                    if d > worst.0 {
                        worst = (d, x, y);
                    }
                }
            }
            assert!(worst.0 <= 0.01, "{regions}: Fit {} off the export reduced at {:?}", worst.0, (worst.1, worst.2));
        }
        // A hard and a soft paint stroke over the same frames.
        for hardness in [1.0f32, 0.5] {
            let stroke: crate::ops_masks::Stroke = serde_json::from_str(&format!(
                r#"{{"points":[[0.1013,0.2007],[0.3021,0.2509],[0.5,0.4013],[0.62,0.43],[0.8,0.39]],"radius":0.0213,"hardness":{hardness},"flow":1}}"#
            ))
            .unwrap();
            let cover = |w: usize, h: usize| crate::ops_masks::rasterize_stroke(&stroke, w, h, crate::ops_masks::FrameWindow::whole(w, h));
            let (full, fit) = (cover(w, h), cover(w / 4, h / 4));
            let mut worst = 0.0f32;
            for y in 0..h / 4 {
                for x in 0..w / 4 {
                    let mut r = 0.0f32;
                    for j in 0..4 {
                        for i in 0..4 {
                            r += full.data[(y * 4 + j) * w + x * 4 + i] / 16.0;
                        }
                    }
                    worst = worst.max((fit.data[y * (w / 4) + x] - r).abs());
                }
            }
            assert!(worst <= 0.01, "a paint stroke at hardness {hardness}: Fit {worst} off the export reduced");
        }
    }

    /// A frame split down the middle at `edge`, dark on the left.
    ///
    /// Sized so the reach means something: the band is a fraction of the
    /// SHORT side, the same convention grow and feather use, so a 64
    /// pixel test frame would give a one pixel band and prove nothing.
    fn wall(w: usize, h: usize, edge: usize, noise: bool) -> ImageBuf {
        let mut img = ImageBuf::new(w, h);
        for y in 0..h {
            for x in 0..w {
                // With noise on, both halves average the same brightness
                // and only texture separates them: the case a guided
                // filter is happy to snap to, and should not.
                let v = if noise {
                    if (x * 7 + y * 13) % 5 == 0 { 0.62 } else { 0.38 }
                } else if x < edge {
                    0.15
                } else {
                    0.85
                };
                let lin = crate::ops::to_scene(v);
                let i = (y * w + x) * 4;
                img.data[i] = lin;
                img.data[i + 1] = lin;
                img.data[i + 2] = lin;
                img.data[i + 3] = 1.0;
            }
        }
        img
    }

    /// A rectangle whose right edge sits at `at`.
    fn box_regions(at: f32) -> String {
        format!(
            r#"[{{"kind":"marquee","op":"replace","x0":0.0,"y0":0.0,"x1":{at},"y1":1.0,"shape":"rect"}}]"#
        )
    }

    /// Feather follows the picture (item 3): a straight selection edge
    /// over a wavy picture edge. The plain feather softens straight
    /// across; the guided feather's half-way line takes the wave.
    #[test]
    fn a_guided_feather_takes_the_pictures_contour_and_a_plain_one_does_not() {
        let (w, h) = (240usize, 120usize);
        // The picture: bright left of a sine-wave boundary about x=120,
        // dark right of it, amplitude 12 px.
        let boundary = |y: usize| 120.0 + 12.0 * ((y as f32) * std::f32::consts::TAU / 40.0).sin();
        let mut img = ImageBuf::new(w, h);
        for y in 0..h {
            for x in 0..w {
                let v = if (x as f32) < boundary(y) { 0.6 } else { 0.05 };
                img.set_pixel(x, y, [v, v, v, 1.0]);
            }
        }
        // The selection: the straight left half, feathered at the wave's
        // amplitude and a little more.
        let mut node = make_node("heeler.selection_mask");
        set_text(&mut node, "regions", &box_regions(0.5));
        set_num(&mut node, "feather", (16.0 / (h as f32 * 0.05)).into());
        let plain = run_on(&node, img.clone()).unwrap().as_mask().unwrap().clone();
        set_num(&mut node, "feather_guided", 1.0);
        let guided = run_on(&node, img).unwrap().as_mask().unwrap().clone();
        // The half-way crossing of each row, against the wave.
        let crossing = |m: &MaskBuf, y: usize| -> f32 {
            for x in 60..180 {
                let (a, b) = (m.value(x, y), m.value(x + 1, y));
                if a >= 0.5 && b < 0.5 {
                    return x as f32 + (a - 0.5) / (a - b).max(1e-6);
                }
            }
            f32::NAN
        };
        let (mut plain_err, mut guided_err, mut n) = (0.0f32, 0.0f32, 0);
        for y in 10..h - 10 {
            let (cp, cg) = (crossing(&plain, y), crossing(&guided, y));
            if cp.is_nan() || cg.is_nan() {
                continue;
            }
            plain_err += (cp - boundary(y)).abs();
            guided_err += (cg - boundary(y)).abs();
            n += 1;
        }
        let (plain_err, guided_err) = (plain_err / n as f32, guided_err / n as f32);
        assert!(plain_err > 6.0, "the plain feather does not follow the wave: mean error {plain_err}");
        assert!(guided_err < plain_err * 0.4, "the guided feather follows the wave: {guided_err} against {plain_err}");
        // Away from the edge both are the same solid selection.
        assert!(guided.value(20, 60) > 0.99 && guided.value(220, 60) < 0.01);
    }

    /// R2 of the 2026-09-23 review: over a flat picture the guided
    /// feather IS the plain feather, at the frame's corner and along its
    /// edge as much as in the middle. With the box clamped to the edge
    /// a one-pixel corner selection at radius 20 came out with forty
    /// times its coverage; cut at the frame, the two agree.
    #[test]
    fn over_a_flat_picture_the_guided_feather_is_the_plain_one_at_the_frame_too() {
        let (w, h) = (160usize, 120usize);
        let img = ImageBuf::filled(w, h, [0.3, 0.3, 0.3, 1.0]);
        let cases: [(&str, Box<dyn Fn(usize, usize) -> f32>); 3] = [
            ("a corner pixel", Box::new(|x, y| if x == 0 && y == 0 { 1.0 } else { 0.0 })),
            ("a strip along the top edge", Box::new(|x, y| if y < 3 && x > 40 && x < 100 { 1.0 } else { 0.0 })),
            ("a block in the middle", Box::new(|x, y| if (50..90).contains(&x) && (40..80).contains(&y) { 1.0 } else { 0.0 })),
        ];
        for radius in [1usize, 5, 20] {
            for (name, shape) in cases.iter() {
                let mut plain: Vec<f32> = (0..w * h).map(|i| shape(i % w, i / w)).collect();
                let mut guided = plain.clone();
                feather_mask(&mut plain, w, h, radius);
                feather_along_picture(&mut guided, &img, w, h, radius);
                let cover = |m: &[f32]| m.iter().sum::<f32>();
                let worst = plain.iter().zip(guided.iter()).map(|(a, b)| (a - b).abs()).fold(0.0f32, f32::max);
                assert!(worst < 1e-4, "{name} at radius {radius}: the guided feather departs from the plain one by {worst}");
                assert!((cover(&plain) - cover(&guided)).abs() < 1e-2 * cover(&plain).max(1.0), "{name} at radius {radius}: coverage {} against {}", cover(&guided), cover(&plain));
            }
        }
    }

    /// Ramp sharpens the soft edge and leaves the solid parts alone.
    #[test]
    fn ramp_touches_only_the_transition() {
        let img = wall(200, 100, 100, false);
        let mut node = make_node("heeler.selection_mask");
        set_text(&mut node, "regions", &box_regions(0.5));
        set_num(&mut node, "feather", 0.3);
        let soft = run_on(&node, img.clone()).unwrap().as_mask().unwrap().clone();
        set_num(&mut node, "ramp", 80.0);
        let ramped = run_on(&node, img).unwrap().as_mask().unwrap().clone();

        let row = 50usize;
        // Deep inside and far outside are untouched: this is the thing
        // a layer editor's Contrast cannot promise.
        assert_eq!(soft.data[row * 200 + 20], ramped.data[row * 200 + 20]);
        assert_eq!(soft.data[row * 200 + 180], ramped.data[row * 200 + 180]);
        // And the transition got steeper: fewer half-way pixels.
        let midish = |m: &MaskBuf| {
            (85..115)
                .filter(|x| {
                    let v = m.data[row * 200 + x];
                    v > 0.2 && v < 0.8
                })
                .count()
        };
        assert!(
            midish(&ramped) < midish(&soft),
            "ramp should sharpen: {} -> {}",
            midish(&soft),
            midish(&ramped)
        );
    }

    /// A stroke starting inside the selection and drawn outward across
    /// the edge, which is what both apps tell you to do and what this
    /// one reads the subject side from.
    fn polish_stroke(mode: &str) -> String {
        format!(
            r#"[{{"points":[[0.45,0.5],[0.52,0.5]],"radius":0.06,"mode":"{mode}"}}]"#
        )
    }

    fn polish_run(regions: &str, img: ImageBuf, strokes: &str, strength: f32) -> Arc<MaskBuf> {
        let mut node = make_node("heeler.selection_mask");
        set_text(&mut node, "regions", regions);
        set_text(&mut node, "strokes", strokes);
        set_num(&mut node, "polish", strength.into());
        run_on(&node, img).unwrap().as_mask().unwrap().clone()
    }

    /// The depth-range channel: farness from the injected plane, not
    /// the pixels. Without a plane it selects nothing (honest), with
    /// one it slices the scene by distance.
    #[test]
    fn a_depth_range_slices_by_the_injected_plane() {
        let (w, h) = (16usize, 4);
        let mut node = make_node("heeler.selection_mask");
        set_text(
            &mut node,
            "regions",
            r#"[{"kind":"range","op":"replace","channel":"depth","lo":0.6,"hi":1.0,"soft":0.01}]"#,
        );
        let mut src = ImageBuf::new(w, h);
        for px in src.data.chunks_mut(4) {
            px[3] = 1.0;
        }
        // Farness ramp left (near) to right (far).
        let mut depth = ImageBuf::new(w, h);
        for y in 0..h {
            for x in 0..w {
                let v = x as f32 / (w - 1) as f32;
                depth.set_pixel(x, y, [v, v, v, 1.0]);
            }
        }
        let base = vec![("in".to_string(), Value::Image(Arc::new(src)))];
        // No plane: nothing selected.
        let out = selection_mask(&node, &base).unwrap();
        let m = out.as_mask().unwrap();
        assert!(m.data.iter().all(|v| *v == 0.0), "no depth, no selection");
        // With the plane: the far side selects, the near side does not.
        let mut fed = base.clone();
        fed.push(("depth".to_string(), Value::Image(Arc::new(depth))));
        let out2 = selection_mask(&node, &fed).unwrap();
        let m2 = out2.as_mask().unwrap();
        assert!(m2.value(w - 1, 2) > 0.9, "the far edge is selected");
        assert!(m2.value(1, 2) < 0.1, "the near edge is not");
    }

    /// P4: a planted refined raster (the ViTMatte matte) replaces the
    /// region geometry as the base (resampled from the resolution the
    /// model ran at), and the dials still apply on top of it.
    #[test]
    fn a_baked_base_takes_new_regions_on_top() {
        // A BAKED base (a converted smart selection) is a starting point,
        // not a replacement: regions drawn afterwards combine on top, where
        // a matte base skips them (the model already resolved that
        // geometry). The owner's conversion flow needs both.
        let (w, h) = (64usize, 64usize);
        let img = wall(w, h, 32, false);
        let mut node = make_node("heeler.selection_mask");
        node.params
            .insert("matte_id".into(), heeler_graph::ParamValue::Text("baked:00ff".into()));
        // The baked raster selects the left half; the drawn region
        // adds a box on the right.
        set_text(
            &mut node,
            "regions",
            r#"[{"kind":"marquee","op":"add","x0":0.75,"y0":0.4,"x1":0.95,"y1":0.6,"shape":"rect"}]"#,
        );
        let mut raster = ImageBuf::new(32, 32);
        for y in 0..32 {
            for x in 0..16 {
                let i = (y * 32 + x) * 4;
                raster.data[i] = 1.0;
                raster.data[i + 3] = 1.0;
            }
        }
        let inputs = [
            ("in".to_string(), Value::Image(Arc::new(img))),
            ("raster".to_string(), Value::Image(Arc::new(raster))),
        ];
        let m = selection_mask(&node, &inputs).unwrap();
        let m = m.as_mask().unwrap();
        assert!(m.data[32 * w + 8] > 0.9, "the baked base holds");
        assert!(m.data[32 * w + 54] > 0.9, "the drawn region joins it");
        assert!(m.data[32 * w + 40] < 0.1, "between the two stays out");
    }

    #[test]
    fn a_refined_raster_becomes_the_base_and_keeps_the_dials() {
        let (w, h) = (64usize, 64usize);
        let img = wall(w, h, 32, false);
        let mut node = make_node("heeler.selection_mask");
        // The geometry says everything; the matte says the left half.
        // The matte must win, or a refined selection would re-grow its
        // own coarse mistakes.
        set_text(&mut node, "regions", &box_regions(0.95));
        let mut raster = ImageBuf::new(32, 32);
        for y in 0..32 {
            for x in 0..16 {
                let i = (y * 32 + x) * 4;
                raster.data[i] = 1.0;
                raster.data[i + 1] = 1.0;
                raster.data[i + 2] = 1.0;
                raster.data[i + 3] = 1.0;
            }
        }
        let inputs = [
            ("in".to_string(), Value::Image(Arc::new(img.clone()))),
            ("raster".to_string(), Value::Image(Arc::new(raster))),
        ];
        let out = selection_mask(&node, &inputs).unwrap();
        let m = out.as_mask().unwrap();
        assert!(m.data[32 * w + 8] > 0.9, "the matte's inside is selected");
        assert!(m.data[32 * w + 56] < 0.1, "the matte's outside is not, geometry or no");
        // Invert runs after the base, matte or classical alike.
        node.params
            .insert("invert".into(), heeler_graph::ParamValue::Bool(true));
        let flipped = selection_mask(&node, &inputs).unwrap();
        let f = flipped.as_mask().unwrap();
        assert!(f.data[32 * w + 8] < 0.1);
        assert!(f.data[32 * w + 56] > 0.9);
    }

    /// A matte stroke is the MODEL's now (P4): in the engine it is a
    /// deliberate no-op, because its answer arrives as the node's
    /// planted raster base. The classical sampler that used to run
    /// here cost seconds per render by the third stroke and lost the
    /// fur cases anyway; a stroke that does nothing fast beats one
    /// that does the wrong thing slowly, and the honest render on a
    /// machine without the raster is the geometry, not a guess.
    #[test]
    fn a_matte_stroke_is_the_models_and_costs_the_engine_nothing() {
        let (w, h) = (200usize, 100usize);
        let img = wall(w, h, 100, false);
        let drawn = run_with(&box_regions(0.48), 0, img.clone());
        let t0 = std::time::Instant::now();
        let out = polish_run(&box_regions(0.48), img, &polish_stroke("matte"), 1.0);
        let cost = t0.elapsed();
        for i in 0..w * h {
            assert_eq!(out.data[i], drawn.data[i], "the engine must not touch the mask");
        }
        // The whole point of the retirement: strokes must never make
        // the render slower. Generous bound; the old sampler blew past
        // it by an order of magnitude on real frames.
        // Linux runs on the owner's VM, slower than the Macs the bound
        // was set on: four times the room there.
        let slack = if cfg!(target_os = "linux") { 4 } else { 1 };
        assert!(cost.as_millis() < 200 * slack, "a matte stroke cost {cost:?}");
    }

    /// Foreground and background strokes are ordinary painting, which is
    /// most of the work once the matte has done its part.
    #[test]
    fn foreground_and_background_strokes_add_and_take_away() {
        let (w, h) = (200usize, 100usize);
        let img = wall(w, h, 100, false);
        let row = h / 2;

        let fore = polish_run(&box_regions(0.48), img.clone(), &polish_stroke("foreground"), 1.0);
        assert!(fore.data[row * w + 102] > 0.9, "foreground adds");

        let back = polish_run(&box_regions(0.48), img, &polish_stroke("background"), 1.0);
        assert!(back.data[row * w + 92] < 0.1, "background takes away");
    }

    /// A feather stroke softens where it is painted and nowhere else.
    #[test]
    fn a_feather_stroke_softens_only_where_it_lands() {
        let (w, h) = (200usize, 100usize);
        let img = wall(w, h, 100, false);
        let out = polish_run(&box_regions(0.48), img, &polish_stroke("feather"), 1.0);
        let row = h / 2;
        // Soft under the stroke...
        let band: Vec<f32> = (92..100).map(|x| out.data[row * w + x]).collect();
        assert!(
            band.iter().any(|v| *v > 0.02 && *v < 0.98),
            "should have softened under the stroke: {band:?}"
        );
        // ...and untouched far away from it.
        assert_eq!(out.data[5 * w + 95], 1.0);
    }

    /// Off by default: strokes with no strength do nothing, and no
    /// strokes at all is the ordinary selection.
    /// Contrast on the planted matte base: 0 leaves the model's alpha,
    /// 50 decides a quarter and three quarters, 100 cuts at a half, and
    /// the half-way line never moves.
    #[test]
    fn matte_contrast_decides_the_edge_and_holds_the_half_way_line() {
        let mut v = [0.0f32, 0.2, 0.25, 0.4, 0.5, 0.6, 0.75, 0.9, 1.0];
        matte_contrast(&mut v, 0.0);
        assert_eq!(v, [0.0, 0.2, 0.25, 0.4, 0.5, 0.6, 0.75, 0.9, 1.0]);
        matte_contrast(&mut v, 50.0);
        assert_eq!(v[0], 0.0);
        assert_eq!(v[1], 0.0, "haze below a quarter is nothing");
        assert_eq!(v[2], 0.0);
        assert!((v[3] - 0.3).abs() < 1e-6, "0.4 reads 0.3: {}", v[3]);
        assert!((v[4] - 0.5).abs() < 1e-6, "the half-way line does not move");
        assert!((v[5] - 0.7).abs() < 1e-6, "a strand keeps its partial cover: {}", v[5]);
        assert_eq!(v[6], 1.0);
        assert_eq!(v[8], 1.0);
        let mut hard = [0.1f32, 0.49, 0.5, 0.9];
        matte_contrast(&mut hard, 100.0);
        assert_eq!(hard, [0.0, 0.0, 1.0, 1.0]);
        // Through the op, on a planted base: the same numbers.
        let mut node = make_node("heeler.selection_mask");
        set_text(&mut node, "matte_id", "abc");
        set_num(&mut node, "matte_contrast", 50.0);
        let mut raster = ImageBuf::new(4, 1);
        for (i, a) in [0.2f32, 0.5, 0.6, 1.0].iter().enumerate() {
            raster.data[i * 4] = *a;
            raster.data[i * 4 + 3] = 1.0;
        }
        let src = ImageBuf::filled(4, 1, [0.5; 4]);
        let out = selection_mask(&node, &[("in".into(), Value::Image(Arc::new(src))), ("raster".into(), Value::Image(Arc::new(raster)))]).unwrap();
        let m = out.as_mask().unwrap();
        assert!((m.data[0] - 0.0).abs() < 1e-5 && (m.data[1] - 0.5).abs() < 1e-5 && (m.data[2] - 0.7).abs() < 1e-5 && (m.data[3] - 1.0).abs() < 1e-5, "{:?}", m.data);
        // A baked base is coverage: Contrast leaves it exactly as planted
        // (review R2, 2026-09-23).
        let mut baked = make_node("heeler.selection_mask");
        set_text(&mut baked, "matte_id", "baked:0123456789abcdef");
        set_num(&mut baked, "matte_contrast", 100.0);
        let mut raster = ImageBuf::new(4, 1);
        for (i, a) in [0.2f32, 0.5, 0.6, 1.0].iter().enumerate() {
            raster.data[i * 4] = *a;
            raster.data[i * 4 + 3] = 1.0;
        }
        let src = ImageBuf::filled(4, 1, [0.5; 4]);
        let out = selection_mask(&baked, &[("in".into(), Value::Image(Arc::new(src))), ("raster".into(), Value::Image(Arc::new(raster)))]).unwrap();
        let m = out.as_mask().unwrap();
        assert!((m.data[0] - 0.2).abs() < 1e-5 && (m.data[1] - 0.5).abs() < 1e-5 && (m.data[2] - 0.6).abs() < 1e-5 && (m.data[3] - 1.0).abs() < 1e-5, "{:?}", m.data);
    }

    #[test]
    fn polish_does_nothing_until_asked() {
        let img = wall(200, 100, 100, false);
        let plain = run_with(&box_regions(0.48), 0, img.clone());
        // No strokes is the ordinary selection. There is no strength
        // slider to turn down: neither reference layer editor has one,
        // and the brush already has flow.
        let none = polish_run(&box_regions(0.48), img, "[]", 1.0);
        assert_eq!(plain.data, none.data);
    }

    /// A gradient across the frame, so a range has something to bite.
    fn ramp(w: usize, h: usize) -> ImageBuf {
        let mut img = ImageBuf::new(w, h);
        for y in 0..h {
            for x in 0..w {
                // Scene-linear values whose DISPLAY luma runs 0..1
                // across the frame, since a range is stated in display
                // units.
                let d = x as f32 / (w - 1) as f32;
                let lin = crate::ops::to_scene(d);
                let i = (y * w + x) * 4;
                img.data[i] = lin;
                img.data[i + 1] = lin;
                img.data[i + 2] = lin;
                img.data[i + 3] = 1.0;
            }
        }
        img
    }

    #[test]
    fn a_luma_range_selects_the_band_it_names() {
        let m = run_with(
            r#"[{"kind":"range","op":"replace","channel":"luma","lo":0.6,"hi":0.9,"soft":0.02}]"#,
            0,
            ramp(64, 8),
        );
        let at = |d: f32| m.data[4 * 64 + ((d * 63.0) as usize)];
        // Inside the band, selected in full: a range dragged over a
        // histogram peak has to take the whole peak, not a soft
        // approximation of it.
        assert!(at(0.7) > 0.99, "mid-band {}", at(0.7));
        assert!(at(0.62) > 0.99 && at(0.88) > 0.99);
        // Outside it, nothing.
        assert!(at(0.4) < 0.01, "below {}", at(0.4));
        assert!(at(0.98) < 0.01, "above {}", at(0.98));
    }

    #[test]
    fn a_color_range_reads_one_channel_and_ignores_the_others() {
        // Red ramps across; green and blue are pinned bright. A red
        // range must not notice them.
        let (w, h) = (64usize, 4usize);
        let mut img = ImageBuf::new(w, h);
        for y in 0..h {
            for x in 0..w {
                let i = (y * w + x) * 4;
                img.data[i] = crate::ops::to_scene(x as f32 / (w - 1) as f32);
                img.data[i + 1] = 1.0;
                img.data[i + 2] = 1.0;
                img.data[i + 3] = 1.0;
            }
        }
        let m = run_with(
            r#"[{"kind":"range","op":"replace","channel":"red","lo":0.0,"hi":0.25,"soft":0.02}]"#,
            0,
            img,
        );
        assert!(m.data[(w) + 5] > 0.99);
        assert!(m.data[(w) + 60] < 0.01);
    }

    #[test]
    fn contrast_selects_detail_rather_than_brightness() {
        // Half flat mid-gray, half a one-pixel checker at the same
        // average brightness. Only the busy half has contrast.
        let (w, h) = (48usize, 32usize);
        let mut img = ImageBuf::new(w, h);
        for y in 0..h {
            for x in 0..w {
                let v = if x < w / 2 {
                    0.5
                } else if (x + y) % 2 == 0 {
                    0.25
                } else {
                    0.75
                };
                let lin = crate::ops::to_scene(v);
                let i = (y * w + x) * 4;
                img.data[i] = lin;
                img.data[i + 1] = lin;
                img.data[i + 2] = lin;
                img.data[i + 3] = 1.0;
            }
        }
        let m = run_with(
            r#"[{"kind":"range","op":"replace","channel":"contrast","lo":0.15,"hi":1.0,"soft":0.05}]"#,
            0,
            img,
        );
        let flat = m.data[16 * w + 12];
        let busy = m.data[16 * w + 36];
        assert!(flat < 0.05, "flat half selected: {flat}");
        assert!(busy > 0.5, "busy half missed: {busy}");
    }

    /// A pen path of plain corners is the polygon through those
    /// corners, which is the whole reason the Polygon tool is gone.
    ///
    /// Asserted against the path region rather than against a picture of
    /// a square, because "these two tools agree" is the claim; a
    /// tolerance on coverage would pass even if one of them were subtly
    /// bent.
    #[test]
    fn a_pen_of_corners_is_the_polygon_through_them() {
        let corners = [[0.2f32, 0.2], [0.8, 0.25], [0.7, 0.8], [0.25, 0.75]];
        let anchors: Vec<[f32; 4]> = corners.iter().map(|c| [c[0], c[1], 0.0, 0.0]).collect();
        let flat = flatten_bezier(&anchors);
        // One point per corner, not sixteen: a cubic whose controls sit
        // on its endpoints is a straight line, and subdividing a
        // straight line only costs geometry.
        assert_eq!(flat.len(), corners.len());
        for (got, want) in flat.iter().zip(corners.iter()) {
            assert!((got[0] - want[0]).abs() < 1e-6 && (got[1] - want[1]).abs() < 1e-6);
        }

        // And the mask it fills is the same mask the path region fills.
        let pts = corners
            .iter()
            .map(|c| format!("[{},{}]", c[0], c[1]))
            .collect::<Vec<_>>()
            .join(",");
        let as_path = run(
            &format!(r#"[{{"kind":"path","op":"replace","points":[{pts}]}}]"#),
            64,
        );
        let anc = corners
            .iter()
            .map(|c| format!("[{},{},0,0]", c[0], c[1]))
            .collect::<Vec<_>>()
            .join(",");
        let as_pen = run(
            &format!(r#"[{{"kind":"bezier","op":"replace","points":[{anc}]}}]"#),
            64,
        );
        assert_eq!(as_path.data.len(), as_pen.data.len());
        let worst = as_path
            .data
            .iter()
            .zip(as_pen.data.iter())
            .map(|(a, b)| (a - b).abs())
            .fold(0.0f32, f32::max);
        assert!(worst < 1e-6, "pen and polygon disagree by {worst}");
    }

    /// A dragged handle still bends, so the shortcut is a shortcut and
    /// not a tool that forgot how to curve.
    #[test]
    fn a_dragged_handle_still_subdivides() {
        let curved = [
            [0.2f32, 0.2, 0.1, 0.0],
            [0.8, 0.25, 0.0, 0.1],
            [0.7, 0.8, 0.0, 0.0],
        ];
        assert!(flatten_bezier(&curved).len() > curved.len());
    }

    fn run(regions: &str, size: usize) -> Arc<MaskBuf> {
        run_with(regions, size, ImageBuf::filled(size, size, [0.5, 0.5, 0.5, 1.0]))
    }

    fn run_with(regions: &str, _size: usize, img: ImageBuf) -> Arc<MaskBuf> {
        let mut node = make_node("heeler.selection_mask");
        set_text(&mut node, "regions", regions);
        run_on(&node, img).unwrap().as_mask().unwrap().clone()
    }

    const SQUARE: &str =
        r#"{"kind":"path","op":"add","points":[[0.2,0.2],[0.8,0.2],[0.8,0.8],[0.2,0.8]]}"#;

    #[test]
    fn a_pen_path_curves_between_its_anchors() {
        // A square's four corners with no handles is the square.
        let corners = concat!(
            r#"[{"kind":"bezier","op":"add","points":"#,
            r#"[[0.2,0.2,0,0],[0.8,0.2,0,0],[0.8,0.8,0,0],[0.2,0.8,0,0]]}]"#
        );
        let m = run(corners, 40);
        assert!(m.data[20 * 40 + 20] > 0.9, "inside the square");
        assert!(m.data[20 * 40 + 2] < 0.1, "outside it");
        // The corner region is included when the path is a polygon.
        assert!(m.data[10 * 40 + 10] > 0.9, "the corner is square");

        // The same anchors with handles bow the edges OUT, so the
        // corner area is swallowed by the curve rather than cut off.
        let curved = concat!(
            r#"[{"kind":"bezier","op":"add","points":"#,
            r#"[[0.2,0.2,0.2,-0.2],[0.8,0.2,0.2,0.2],[0.8,0.8,-0.2,0.2],[0.2,0.8,-0.2,-0.2]]}]"#
        );
        let c = run(curved, 40);
        assert!(c.data[20 * 40 + 20] > 0.9, "still filled in the middle");
        // A bowed edge reaches further out than the straight one did.
        let straight_edge = m.data[20 * 40 + 7];
        let curved_edge = c.data[20 * 40 + 7];
        assert!(
            curved_edge > straight_edge,
            "the curve bows past the straight edge: {curved_edge} vs {straight_edge}"
        );
    }

    #[test]
    fn a_marquee_fills_a_rectangle_and_an_ellipse() {
        let rect = r#"[{"kind":"marquee","op":"add","x0":0.25,"y0":0.25,"x1":0.75,"y1":0.75}]"#;
        let m = run(rect, 40);
        assert!(m.data[20 * 40 + 20] > 0.99, "center is in");
        assert!(m.data[20 * 40 + 4] < 0.01, "outside the left edge is out");
        assert!(m.data[11 * 40 + 11] > 0.99, "the rectangle takes its corner");

        let oval = r#"[{"kind":"marquee","op":"add","x0":0.25,"y0":0.25,"x1":0.75,"y1":0.75,"shape":"ellipse"}]"#;
        let e = run(oval, 40);
        assert!(e.data[20 * 40 + 20] > 0.99, "center is in");
        assert!(e.data[11 * 40 + 11] < 0.01, "the ellipse gives the corner up");
        assert!(e.data[20 * 40 + 12] > 0.5, "but keeps the ends of its axes");
        assert!(e.data[12 * 40 + 20] > 0.5);
    }

    #[test]
    fn a_marquee_combines_like_any_other_region() {
        let both = concat!(
            r#"[{"kind":"marquee","op":"add","x0":0.1,"y0":0.1,"x1":0.9,"y1":0.9,"shape":"ellipse"},"#,
            r#"{"kind":"marquee","op":"subtract","x0":0.4,"y0":0.4,"x1":0.6,"y1":0.6}]"#
        );
        let m = run(both, 40);
        assert!(m.data[20 * 40 + 20] < 0.01, "the bite is out of the middle");
        assert!(m.data[20 * 40 + 8] > 0.5, "the oval survives around it");
    }

    #[test]
    fn nothing_selected_is_an_empty_mask() {
        let m = run("[]", 21);
        assert!(m.data.iter().all(|v| *v == 0.0));
    }

    #[test]
    fn a_path_selects_its_inside_and_not_its_outside() {
        let m = run(&format!("[{SQUARE}]"), 41);
        assert!(m.value(20, 20) > 0.99, "the middle of the path is not selected");
        assert!(m.value(4, 4) < 0.01, "outside the path is selected");
        assert!(m.value(20, 4) < 0.01);
    }

    /// The whole point of storing geometry: the same region evaluates at
    /// whatever size it is asked for, and means the same thing.
    #[test]
    fn the_same_selection_renders_at_any_resolution() {
        for size in [21, 41, 101, 200] {
            let m = run(&format!("[{SQUARE}]"), size);
            let mid = size / 2;
            assert!(m.value(mid, mid) > 0.99, "middle missing at {size}");
            // A tenth in from the corner is outside a path that starts
            // two tenths in, at every size.
            let out = size / 10;
            assert!(m.value(out, out) < 0.01, "corner selected at {size}");
        }
    }

    #[test]
    fn subtract_takes_a_bite_out_of_what_is_already_there() {
        let hole = r#"{"kind":"path","op":"subtract","points":[[0.4,0.4],[0.6,0.4],[0.6,0.6],[0.4,0.6]]}"#;
        let m = run(&format!("[{SQUARE},{hole}]"), 41);
        assert!(m.value(20, 20) < 0.01, "the hole was not subtracted");
        // The ring around it survives.
        assert!(m.value(12, 20) > 0.99);
        assert!(m.value(28, 20) > 0.99);
    }

    #[test]
    fn replace_throws_away_everything_before_it() {
        let other = r#"{"kind":"path","op":"replace","points":[[0.05,0.05],[0.2,0.05],[0.2,0.2],[0.05,0.2]]}"#;
        let m = run(&format!("[{SQUARE},{other}]"), 41);
        assert!(m.value(20, 20) < 0.01, "the first path survived a replace");
        assert!(m.value(5, 5) > 0.9, "the replacing path is not there");
    }

    #[test]
    fn intersect_keeps_only_the_overlap() {
        let right = r#"{"kind":"path","op":"intersect","points":[[0.5,0.0],[1.0,0.0],[1.0,1.0],[0.5,1.0]]}"#;
        let m = run(&format!("[{SQUARE},{right}]"), 41);
        // Right half of the original square: kept. Left half: gone.
        assert!(m.value(28, 20) > 0.99);
        assert!(m.value(12, 20) < 0.01);
    }

    /// Order matters, and the ops have to apply in the order the user
    /// made them rather than by kind.
    #[test]
    fn regions_apply_in_order() {
        let hole = r#"{"kind":"path","op":"subtract","points":[[0.4,0.4],[0.6,0.4],[0.6,0.6],[0.4,0.6]]}"#;
        let refill = r#"{"kind":"path","op":"add","points":[[0.45,0.45],[0.55,0.45],[0.55,0.55],[0.45,0.55]]}"#;
        // Cut a hole, then put some of it back.
        let m = run(&format!("[{SQUARE},{hole},{refill}]"), 81);
        assert!(m.value(40, 40) > 0.9, "the re-added piece is missing");
        // Still a gap between the refill and the outer square.
        assert!(m.value(34, 40) < 0.1);
    }

    #[test]
    fn a_colour_key_selects_what_matches_and_leaves_the_rest() {
        // Left half dark, right half bright.
        let mut img = ImageBuf::filled(40, 20, [0.1, 0.1, 0.1, 1.0]);
        for y in 0..20 {
            for x in 20..40 {
                let i = (y * 40 + x) * 4;
                img.data[i] = 0.9;
                img.data[i + 1] = 0.9;
                img.data[i + 2] = 0.9;
            }
        }
        // Pick from the bright half.
        let key = r#"[{"kind":"key","op":"add","x":0.8,"y":0.5,"tolerance":0.2}]"#;
        let m = run_with(key, 40, img);
        assert!(m.value(30, 10) > 0.9, "the sampled color is not selected");
        assert!(m.value(10, 10) < 0.1, "the other color is selected");
    }

    /// A key is a rule about the image, not a traced outline: the same
    /// region on a different picture selects different pixels, which is
    /// the entire reason to store it this way.
    #[test]
    fn a_colour_key_follows_the_image_it_is_given() {
        let key = r#"[{"kind":"key","op":"add","x":0.5,"y":0.5,"tolerance":0.2}]"#;
        let dark = run_with(key, 20, ImageBuf::filled(20, 20, [0.1, 0.1, 0.1, 1.0]));
        // A flat frame keys entirely: every pixel matches the sample.
        assert!(dark.data.iter().all(|v| *v > 0.9));

        let mut split = ImageBuf::filled(20, 20, [0.1, 0.1, 0.1, 1.0]);
        for y in 0..20 {
            for x in 0..10 {
                let i = (y * 20 + x) * 4;
                split.data[i] = 0.95;
                split.data[i + 1] = 0.95;
                split.data[i + 2] = 0.95;
            }
        }
        let m = run_with(key, 20, split);
        assert!(m.value(15, 10) > 0.9);
        assert!(m.value(4, 10) < 0.1);
    }

    /// On the paint method: "As I paint (click and drag over the image)
    /// it finds similar colors that were within the brush and selects
    /// those pixels."
    ///
    /// So the drag is a list of samples, and every color it passed over
    /// counts. Nearest of the set, not the average: a brush dragged
    /// across two different colors has to select both, and their
    /// average is a third color that may be in neither.
    #[test]
    fn painted_samples_select_every_colour_they_passed_over() {
        // Three bands: dark, mid, bright.
        let mut img = ImageBuf::filled(30, 10, [0.0, 0.0, 0.0, 1.0]);
        for y in 0..10 {
            for x in 0..30 {
                let v = if x < 10 { 0.05 } else if x < 20 { 0.5 } else { 0.95 };
                let i = (y * 30 + x) * 4;
                img.data[i] = v;
                img.data[i + 1] = v;
                img.data[i + 2] = v;
            }
        }
        // A drag across the dark band and the bright one, skipping the
        // middle.
        let painted = r#"[{"kind":"samples","op":"add","tolerance":0.15,
            "points":[[0.05,0.5],[0.1,0.5],[0.9,0.5],[0.95,0.5]]}]"#;
        let m = run_with(painted, 30, img.clone());
        assert!(m.value(5, 5) > 0.9, "the dark band it passed over is not selected");
        assert!(m.value(25, 5) > 0.9, "the bright band it passed over is not selected");
        // The middle was never touched, and it is not the average of the
        // two that were.
        assert!(m.value(15, 5) < 0.1, "a band it never touched got selected");
    }

    #[test]
    fn painted_samples_with_nothing_in_them_select_nothing() {
        // A click that never became a drag.
        let m = run(r#"[{"kind":"samples","op":"add","tolerance":0.2,"points":[]}]"#, 20);
        assert!(m.data.iter().all(|v| *v < 0.01));
    }

    /// Tolerance is what makes it a selection rather than an exact match.
    #[test]
    fn painted_samples_widen_with_tolerance() {
        let mut img = ImageBuf::filled(20, 10, [0.5, 0.5, 0.5, 1.0]);
        for y in 0..10 {
            for x in 10..20 {
                let i = (y * 20 + x) * 4;
                img.data[i] = 0.62;
                img.data[i + 1] = 0.62;
                img.data[i + 2] = 0.62;
            }
        }
        let at = |tol: f32| {
            let r = format!(
                r#"[{{"kind":"samples","op":"add","tolerance":{tol},"points":[[0.2,0.5]]}}]"#
            );
            run_with(&r, 20, img.clone()).value(15, 5)
        };
        // A near neighbor: outside a tight tolerance, inside a loose one.
        assert!(at(0.02) < 0.1);
        assert!(at(0.5) > 0.9);
    }

    #[test]
    fn a_luma_key_ignores_hue() {
        // Two patches of the same brightness, wildly different color.
        let mut img = ImageBuf::filled(20, 20, [0.0, 0.0, 0.0, 1.0]);
        for y in 0..20 {
            for x in 0..20 {
                let i = (y * 20 + x) * 4;
                if x < 10 {
                    // Gray at 0.5.
                    img.data[i] = 0.5;
                    img.data[i + 1] = 0.5;
                    img.data[i + 2] = 0.5;
                } else {
                    // Green of the same luma: 0.5 / 0.7152.
                    img.data[i + 1] = 0.5 / 0.7152;
                }
            }
        }
        let colour = r#"[{"kind":"key","op":"add","x":0.25,"y":0.5,"tolerance":0.15}]"#;
        let by_luma = r#"[{"kind":"key","op":"add","x":0.25,"y":0.5,"tolerance":0.05,"space":"luma"}]"#;
        // Keying on color, the green half is a long way off.
        assert!(run_with(colour, 20, img.clone()).value(15, 10) < 0.1);
        // Keying on luminance, it matches.
        assert!(run_with(by_luma, 20, img).value(15, 10) > 0.9);
    }

    /// Smoothing is stored, not baked, so it has to be a parameter the
    /// render reads and not something the UI did once.
    #[test]
    fn smoothing_rounds_the_corners_off_a_path() {
        let jagged = |smooth: f32| {
            format!(
                r#"[{{"kind":"path","op":"add","smooth":{smooth},"points":[[0.2,0.2],[0.8,0.2],[0.8,0.8],[0.2,0.8]]}}]"#
            )
        };
        let sharp = run(&jagged(0.0), 81);
        let soft = run(&jagged(1.0), 81);
        // The corner of the square: solid when sharp, cut away by
        // smoothing. Just inside the corner at 0.2,0.2 -> pixel 17.
        assert!(sharp.value(18, 18) > 0.9, "the sharp path lost its corner");
        assert!(soft.value(18, 18) < 0.5, "smoothing did not round the corner");
        // The middle is untouched either way.
        assert!(sharp.value(40, 40) > 0.99);
        assert!(soft.value(40, 40) > 0.99);
    }

    #[test]
    fn smoothing_is_capped_before_it_shrinks_the_selection() {
        assert_eq!(smooth_passes(0.0), 0);
        assert_eq!(smooth_passes(1.0), 3);
        assert_eq!(smooth_passes(9.0), 3, "amount is clamped, not trusted");
    }

    #[test]
    fn feather_softens_the_edge_and_leaves_the_middle_alone() {
        let hard = run(&format!("[{SQUARE}]"), 81);
        let mut node = make_node("heeler.selection_mask");
        set_text(&mut node, "regions", &format!("[{SQUARE}]"));
        set_num(&mut node, "feather", 0.5);
        let soft = run_on(&node, ImageBuf::filled(81, 81, [0.5; 4]))
            .unwrap()
            .as_mask()
            .unwrap()
            .clone();
        // Middle stays fully selected.
        assert!(soft.value(40, 40) > 0.95);
        // A hard edge crosses from nothing to everything in a pixel or
        // two; a feathered one takes a while about it. Counting the
        // half-selected pixels across the middle says which is which
        // without depending on exactly where the ramp starts.
        let ramp = |m: &MaskBuf| {
            (0..81).filter(|&x| { let v = m.value(x, 40); v > 0.05 && v < 0.95 }).count()
        };
        let (hard_ramp, soft_ramp) = (ramp(&hard), ramp(&soft));
        assert!(hard_ramp <= 4, "the hard edge was not hard ({hard_ramp} px)");
        assert!(
            soft_ramp > hard_ramp + 4,
            "feather did not soften anything (hard {hard_ramp} px, soft {soft_ramp} px)"
        );
    }

    // Polish -----------------------------------------------------------

    /// The owner wants a refinement pass for cleaning up rough selections, the
    /// way a layer editor's Refine does. Grow moves the edge, smooth rounds it
    /// off, and feather softens it without moving it: three different jobs
    /// that are easy to confuse until you have all three. 161 across,
    /// deliberately: grow tops out at 5% of the short side and smooth at 3%,
    /// so on an 81 pixel fixture full strength is four pixels and two, and
    /// neither control can show what it does.
    fn polished(regions: &str, grow: f32, smooth: f32, size: usize) -> Arc<MaskBuf> {
        let mut node = make_node("heeler.selection_mask");
        set_text(&mut node, "regions", regions);
        set_num(&mut node, "grow", grow.into());
        set_num(&mut node, "smooth", smooth.into());
        run_on(&node, ImageBuf::filled(size, size, [0.5; 4]))
            .unwrap()
            .as_mask()
            .unwrap()
            .clone()
    }

    /// How far across the middle the selection reaches, in pixels.
    fn span(m: &MaskBuf, row: usize) -> usize {
        (0..m.width).filter(|&x| m.value(x, row) > 0.5).count()
    }

    #[test]
    fn grow_pushes_the_edge_out_and_shrink_pulls_it_in() {
        let sq = format!("[{SQUARE}]");
        let plain = polished(&sq, 0.0, 0.0, 161);
        let bigger = polished(&sq, 0.5, 0.0, 161);
        let smaller = polished(&sq, -0.5, 0.0, 161);
        let mid = 80;
        assert!(
            span(&bigger, mid) > span(&plain, mid) + 4,
            "grow did not push the edge out"
        );
        assert!(
            span(&smaller, mid) + 4 < span(&plain, mid),
            "shrink did not pull the edge in"
        );
        // And it stays centered: growing is not the same as moving.
        let centre = |m: &MaskBuf| {
            let cols: Vec<usize> = (0..m.width).filter(|&x| m.value(x, mid) > 0.5).collect();
            (cols.first().copied().unwrap_or(0) + cols.last().copied().unwrap_or(0)) / 2
        };
        assert!((centre(&bigger) as i32 - centre(&plain) as i32).abs() <= 1);
    }

    #[test]
    fn shrinking_past_the_middle_leaves_nothing() {
        // Rather than an inside-out selection, which is the failure mode
        // of doing this by repeated erosion.
        //
        // Comfortably smaller than twice the shrink: at exactly twice it
        // the center pixel sits right on the new boundary and correctly
        // comes out at a half, which is a sliver rather than nothing.
        // Shrink tops out at 5% of the short side, so 8 pixels here.
        let small = r#"{"kind":"path","op":"add","points":[[0.47,0.47],[0.53,0.47],[0.53,0.53],[0.47,0.53]]}"#;
        let m = polished(&format!("[{small}]"), -1.0, 0.0, 161);
        assert!(m.data.iter().all(|v| *v < 0.01));
    }

    #[test]
    fn smoothing_rounds_a_corner_without_moving_the_straight_edges() {
        // The difference between smooth and grow: a straight edge has
        // nowhere to round to, so it should stay put.
        let sq = format!("[{SQUARE}]");
        let plain = polished(&sq, 0.0, 0.0, 161);
        let soft = polished(&sq, 0.0, 1.0, 161);
        let mid = 80;
        assert!(
            (span(&soft, mid) as i32 - span(&plain, mid) as i32).abs() <= 4,
            "smoothing moved a straight edge"
        );
        // The corner loses area, which is the whole point. 0.2 of 161 is
        // 32, so this sits just inside it.
        let corner = |m: &MaskBuf| m.value(34, 34);
        assert!(corner(&plain) > 0.9, "the fixture corner was not solid to begin with");
        assert!(corner(&soft) < 0.5, "the corner did not round off");
    }

    /// Smooth and feather are different things and the panel offers both,
    /// so they had better not do the same thing.
    #[test]
    fn smooth_is_not_feather() {
        let sq = format!("[{SQUARE}]");
        let mut node = make_node("heeler.selection_mask");
        set_text(&mut node, "regions", &sq);
        set_num(&mut node, "feather", 0.35);
        let feathered = run_on(&node, ImageBuf::filled(161, 161, [0.5; 4]))
            .unwrap()
            .as_mask()
            .unwrap()
            .clone();
        let smoothed = polished(&sq, 0.0, 1.0, 161);
        let ramp = |m: &MaskBuf| {
            (0..161).filter(|&x| { let v = m.value(x, 80); v > 0.05 && v < 0.95 }).count()
        };
        // Feather leaves a wide soft band; smooth leaves a hard edge in a
        // slightly different place.
        assert!(ramp(&feathered) > ramp(&smoothed) + 4);
    }

    #[test]
    fn the_polish_brush_paints_a_stroke_not_a_filled_loop() {
        // A stroke that loops around must not fill what it encircled,
        // which is exactly what treating it as a closed path would do.
        let loop_stroke = r#"[{"kind":"brush","op":"add","radius":0.03,
            "points":[[0.3,0.3],[0.7,0.3],[0.7,0.7],[0.3,0.7],[0.3,0.3]]}]"#;
        let m = run(loop_stroke, 81);
        // On the stroke itself.
        assert!(m.value(40, 24) > 0.5, "the stroke did not paint");
        // Inside the loop it drew, which a fill would have covered.
        assert!(m.value(40, 40) < 0.1, "a painted loop filled itself in");
    }

    #[test]
    fn the_polish_brush_can_take_away_as_well_as_add() {
        let both = format!(
            r#"[{SQUARE},{{"kind":"brush","op":"subtract","radius":0.04,"points":[[0.3,0.5],[0.7,0.5]]}}]"#
        );
        let m = run(&both, 81);
        // A stripe wiped out of the middle of the square.
        assert!(m.value(40, 40) < 0.1, "the brush did not subtract");
        // With the square still there above and below it.
        assert!(m.value(40, 24) > 0.9);
        assert!(m.value(40, 56) > 0.9);
    }

    #[test]
    fn polish_does_nothing_when_it_is_turned_off() {
        // The default has to be the selection exactly as drawn, or every
        // existing selection moves the day this shipped.
        let sq = format!("[{SQUARE}]");
        let mut bare = make_node("heeler.selection_mask");
        set_text(&mut bare, "regions", &sq);
        let untouched = run_on(&bare, ImageBuf::filled(161, 161, [0.5; 4]))
            .unwrap()
            .as_mask()
            .unwrap()
            .clone();
        assert_eq!(untouched.data, polished(&sq, 0.0, 0.0, 161).data);
    }

    #[test]
    fn invert_flips_the_selection() {
        let mut node = make_node("heeler.selection_mask");
        set_text(&mut node, "regions", &format!("[{SQUARE}]"));
        node.params.insert("invert".into(), heeler_graph::ParamValue::Bool(true));
        let m = run_on(&node, ImageBuf::filled(41, 41, [0.5; 4]))
            .unwrap()
            .as_mask()
            .unwrap()
            .clone();
        assert!(m.value(20, 20) < 0.01);
        assert!(m.value(4, 4) > 0.99);
    }

    /// A path that crosses itself is what a shaky hand actually draws,
    /// and it must not turn the mask inside out.
    #[test]
    fn a_self_crossing_path_still_fills_sensibly() {
        let bowtie = r#"[{"kind":"path","op":"add","points":[[0.2,0.2],[0.8,0.8],[0.8,0.2],[0.2,0.8]]}]"#;
        let m = run(bowtie, 41);
        // The two long sides cross, so even-odd fills a pair of
        // triangles pointing inwards from the left and right edges.
        // Near the top the fill is two narrow bands with a gap between.
        assert!(m.value(10, 12) > 0.5, "the left band of the bowtie is missing");
        assert!(m.value(20, 12) < 0.1, "the gap between the bands filled in");
        // And the far corners are still outside.
        assert!(m.value(2, 2) < 0.01);
        assert!(m.value(38, 38) < 0.01);
    }

    /// Degenerate geometry has to render as nothing rather than panic:
    /// a click that never became a drag leaves one or two points behind.
    #[test]
    fn a_path_with_too_few_points_selects_nothing() {
        for pts in ["[]", "[[0.5,0.5]]", "[[0.1,0.1],[0.9,0.9]]"] {
            let m = run(&format!(r#"[{{"kind":"path","op":"add","points":{pts}}}]"#), 21);
            assert!(m.data.iter().all(|v| *v < 0.01), "{pts} selected something");
        }
    }

    #[test]
    fn broken_json_is_an_error_not_a_panic() {
        let mut node = make_node("heeler.selection_mask");
        set_text(&mut node, "regions", "{not json");
        assert!(run_on(&node, ImageBuf::filled(9, 9, [0.5; 4])).is_err());
    }

    /// An op the build has not heard of should not take the whole render
    /// down; serde rejects it, and the error names the parameter.
    #[test]
    fn the_ops_round_trip_by_name() {
        let by_name = |s: &str| {
            serde_json::from_str::<SelectOp>(&format!("\"{s}\"")).unwrap()
        };
        assert_eq!(by_name("replace"), SelectOp::Replace);
        assert_eq!(by_name("add"), SelectOp::Add);
        assert_eq!(by_name("subtract"), SelectOp::Subtract);
        assert_eq!(by_name("intersect"), SelectOp::Intersect);
        // Missing op defaults to add, which is what a first region wants.
        assert_eq!(SelectOp::default(), SelectOp::Add);
    }

    /// A hang guard, not a benchmark: the matte at photograph scale.
    ///
    /// The tests above run on 200-pixel frames, where any cost is
    /// invisible, which is how a starved-evidence fallback that
    /// scanned an (8 x radius)^2 box at stride one shipped: at a real
    /// frame's scale one stroke took minutes of stride-one reads and
    /// the app read as frozen. This runs the two worst shapes, a
    /// stroke along a long edge and a stroke deep inside the solid
    /// subject, at preview resolution with a big brush. The bound is
    /// generous on purpose; the failure mode it guards against misses
    /// it by two orders of magnitude.
    #[test]
    fn polish_stays_interactive_at_photograph_scale() {
        let (w, h) = (1400usize, 900usize);
        let mut img = ImageBuf::new(w, h);
        for y in 0..h {
            for x in 0..w {
                let inside = x < w / 2;
                let (r, g, b) = if inside { (0.55, 0.38, 0.22) } else { (0.30, 0.40, 0.34) };
                let i = (y * w + x) * 4;
                img.data[i] = crate::ops::to_scene(r);
                img.data[i + 1] = crate::ops::to_scene(g);
                img.data[i + 2] = crate::ops::to_scene(b);
                img.data[i + 3] = 1.0;
            }
        }
        let strokes = r#"[
            {"points":[[0.5,0.05],[0.5,0.95]],"radius":0.1,"mode":"matte"},
            {"points":[[0.15,0.05],[0.15,0.95]],"radius":0.1,"mode":"matte"}
        ]"#;
        let started = std::time::Instant::now();
        let out = polish_run(&box_regions(0.5), img, strokes, 1.0);
        assert!(
            started.elapsed() < std::time::Duration::from_secs(10),
            "one stroke took {:?}; painting is interactive or it is nothing",
            started.elapsed()
        );
        // And it still did its job: the edge stroke landed.
        assert!(out.data[(h / 2) * w + (w / 2 - 4)] > 0.5);
    }

    #[test]
    fn combine_is_the_arithmetic_the_ops_promise() {
        assert_eq!(combine(0.0, 0.7, SelectOp::Replace), 0.7);
        assert_eq!(combine(0.9, 0.2, SelectOp::Replace), 0.2);
        assert_eq!(combine(0.3, 0.8, SelectOp::Add), 0.8);
        assert_eq!(combine(0.8, 0.3, SelectOp::Add), 0.8);
        assert!((combine(1.0, 0.25, SelectOp::Subtract) - 0.75).abs() < 1e-6);
        assert_eq!(combine(0.4, 0.9, SelectOp::Intersect), 0.4);
    }
}

#[cfg(test)]
mod review_area_tests {
    use super::*;
    #[test]
    fn crossing_lasso_keeps_both_lobes_in_one_pixel() {
        let mut out = [0.0];
        fill_polygon(
            &[[0.0, 0.0], [1.0, 1.0], [1.0, 0.0], [0.0, 1.0]],
            1,
            1,
            &mut out,
            &crate::ops_masks::FrameWindow::whole(1, 1),
        );
        assert!(
            (out[0] - 0.5).abs() < 1e-6,
            "both triangles occupy half the pixel, got {}",
            out[0]
        );
    }
    #[test]
    fn edge_crossing_polygon_matches_reduced_export_independently() {
        let points = [
            [-0.05, 0.2],
            [0.5, 0.22],
            [1.06, 0.2],
            [1.04, 0.6],
            [0.4, 0.58],
            [-0.03, 0.61],
        ];
        let (w, h) = (401, 301);
        let mut small = vec![0.0; w * h];
        let mut big = vec![0.0; w * h * 16];
        fill_polygon(
            &points,
            w,
            h,
            &mut small,
            &crate::ops_masks::FrameWindow::whole(w, h),
        );
        fill_polygon(
            &points,
            w * 4,
            h * 4,
            &mut big,
            &crate::ops_masks::FrameWindow::whole(w * 4, h * 4),
        );
        let mut worst = 0.0f32;
        for y in 0..h {
            for x in 0..w {
                let mut s = 0.0;
                for j in 0..4 {
                    for i in 0..4 {
                        s += big[(y * 4 + j) * w * 4 + x * 4 + i] / 16.0;
                    }
                }
                worst = std::hint::black_box(worst.max((small[y * w + x] - s).abs()));
            }
        }
        eprintln!("edge polygon gap={worst}");
        assert!(worst < 0.01);
    }
    #[test]
    fn thin_ellipse_area_matches_analytic_area() {
        let mut out = vec![0.0; 100];
        fill_marquee(
            0.1,
            0.4,
            0.9,
            0.46,
            true,
            10,
            10,
            &mut out,
            &crate::ops_masks::FrameWindow::whole(10, 10),
        );
        let sum: f32 = out.iter().sum();
        let expected = std::f32::consts::PI * 4.0 * 0.3;
        assert!((sum - expected).abs() < 1e-5, "{sum} vs {expected}");
    }
}
