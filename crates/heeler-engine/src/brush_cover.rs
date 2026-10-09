//! A brush stroke's coverage: each pixel the average of the brush's
//! profile over the pixel's own square.
//!
//! Every brush the engine draws comes through here: paint, clone, heal,
//! blur, the eraser and every other paint stroke (ops_masks.rs
//! rasterize_stroke), a brush mask's strokes (ops_masks.rs brush_mask),
//! the tip preview the cursor shows (ops_masks.rs tip_preview), and a
//! selection's brush and the Polish brush's footprint (ops_selection.rs
//! fill_brush).
//!
//! The profile is the brush's falloff along the distance from the path
//! the stroke sweeps (a capsule a segment, a disc a dab): one inside the
//! hardness, a smoothstep down to nothing at the radius, a plain step
//! when the brush is hard. A pixel's coverage is the profile averaged
//! over the pixel's square, the share of a hard brush's footprint inside
//! the pixel, so a Fit pixel is the export's sixteen reduced at every
//! size (the owner's rule: the preview matches the export). It used to
//! be the profile at the pixel's center with an edge never sharper than
//! a smoothstep a pixel wide, a window a pixel of whatever size the
//! render was: at Fit a hard edge stood up to 0.149 off its export
//! reduced.
//!
//! How the average is taken, each pixel measuring from the nearest point
//! of the whole path (so where two segments meet the coverage is the
//! union's, not the larger of two shares):
//!
//! - Where the profile is one cubic across the pixel (inside a falloff
//!   at least three pixels wide, or anywhere on one eight or wider) and
//!   no sharp ridge crosses it, the mean is the center value plus a
//!   twenty-fourth of the profile's Laplacian: exact across a straight
//!   side, and round a vertex the curve's term on the share of the
//!   pixel the vertex is nearest.
//! - Where an edge crosses the pixel along a side, the mean across the
//!   straight edge is exact: the pixel's extent along the edge's normal
//!   is a trapezoid, and the mean a second difference of the profile's
//!   second antiderivative.
//! - Round a dab's tight curve (under 24 pixels in radius), or across a
//!   ridge where the edge turns a corner (inside a turn, a stroke
//!   crossing itself), the pixel is cut into sub-squares, each across
//!   the straight edge through it: two, four or eight a side.
//! - Under a brush less than a pixel in radius every pixel it touches is
//!   cut sixteen a side: the whole brush is a tight curve there.
//!
//! brush_cover_tests proves it against the profile averaged over a
//! 128 by 128 grid in each pixel.

use rayon::prelude::*;

/// Half a pixel's diagonal: how far a pixel's distance from the path
/// can stray from its center's (the distance moves no faster than the
/// point measuring it).
const HALF_DIAGONAL: f32 = 0.707_107_1;

/// A falloff this many pixels wide or wider is smooth enough at the
/// pixel's scale for the center-plus-Laplacian average everywhere: the
/// smoothstep's curvature jumps by 6 / w^2 at its ends, a few
/// thousandths of coverage at this width.
const SMOOTH_WIDTH: f32 = 8.0;

/// A falloff narrower than this many pixels is cut into sub-squares
/// wherever it crosses the pixel: across a pixel or two, the vertex
/// share's straight-line approximation and the smoothstep's ends are
/// too close together for the Laplacian.
const NARROW: f32 = 3.0;

/// A dab's curve this many pixels in radius or wider is taken straight
/// across the pixel: about 1 / (24 r) off, under two thousandths.
const WIDE_CURVE: f32 = 24.0;

/// A ridge whose two sides' directions differ by more than this (a turn
/// sharper than about twenty degrees) is cut eight by eight.
const SHARP_KINK: f32 = 0.35;

/// Sub-squares a side where an edge crosses the pixel. A sub-square's
/// straight edge misses a dab's curve by about (1/4)^2 / (24 r) of the
/// pixel, 0.0026 at a radius of one pixel.
const CUTS: usize = 4;

/// Sub-squares a side round a brush under a pixel in radius. A dab's
/// curve that tight bends away from a quarter-pixel sub-square's
/// straight edge by a share of the dab's whole area: a hard round dab
/// half a pixel in radius came out 0.7978 against its pi / 4 (0.012 off),
/// one 0.3 in radius worse. At a sixteenth of a pixel the curve's miss
/// is a sixteenth of that, under a thousandth. The pixels such a brush
/// touches are few (three or so a pixel of its path), so the finer cut
/// costs little; a brush a pixel or wider keeps its cuts, to the bit.
const SMALL_CUTS: usize = 16;

/// Pixels a side of the tiles the path's segments are sorted into: a
/// pixel weighs every segment its tile lists, so a tile is kept about as
/// small as the brush, from 8 to 32 pixels.
fn tile_for(radius: f32) -> usize {
    if radius < 12.0 {
        8
    } else if radius < 40.0 {
        16
    } else {
        32
    }
}

/// The brush profile along the distance from the path: 1 up to `lo`, a
/// smoothstep falling to 0 across the next `w` pixels, a step at `lo`
/// when `w` is zero.
#[derive(Clone, Copy, Debug)]
struct Profile {
    lo: f32,
    w: f32,
}

impl Profile {
    /// The profile of a brush `radius` pixels wide at `hardness`: hard
    /// inside hardness times the radius, nothing past the radius.
    fn of(radius: f32, hardness: f32) -> Profile {
        let lo = hardness.clamp(0.0, 1.0) * radius;
        Profile { lo, w: (radius - lo).max(0.0) }
    }

    fn hi(&self) -> f32 {
        self.lo + self.w
    }

    /// The profile at distance `d`, and its first and second
    /// derivatives.
    fn at(&self, d: f32) -> (f32, f32, f32) {
        if d <= self.lo {
            return (1.0, 0.0, 0.0);
        }
        if d >= self.hi() {
            return (0.0, 0.0, 0.0);
        }
        let t = (d - self.lo) / self.w;
        (1.0 - t * t * (3.0 - 2.0 * t), -6.0 * t * (1.0 - t) / self.w, -(6.0 - 12.0 * t) / (self.w * self.w))
    }

    /// Whether the profile is one cubic over everything within `r` of
    /// distance `d`: inside the falloff, or at a soft dab's center,
    /// where a falloff from nothing at all is smooth.
    fn smooth_across(&self, d: f32, r: f32) -> bool {
        // At the path itself the distance folds (|v| across a side, |x|
        // round a dab), and the profile's cubic term with it, which the
        // Laplacian misses by about (r / w)^3: only across a span small
        // against the falloff.
        (d - r >= self.lo || (self.lo <= 0.0 && r <= 0.1 * self.w)) && d + r <= self.hi()
    }

    /// The profile's mean over a square `size2` (its side squared) in
    /// area centered `d` from the path where it is smooth: the center
    /// value and a twenty-fourth of the Laplacian times the area, the
    /// second derivative across the edge plus, on the share `curved` of
    /// the square round a dab's curve, the first over the radius.
    fn smooth_mean(&self, d: f32, curved: f32, size2: f32) -> f32 {
        let (v, p1, p2) = self.at(d);
        let curve = if curved <= 0.0 {
            0.0
        } else if d > 1e-4 {
            p1 / d
        } else if self.lo <= 0.0 && self.w > 0.0 {
            // The limit at a soft dab's center: -6 (1 - t) / w^2 with t
            // at zero.
            -6.0 / (self.w * self.w)
        } else {
            0.0
        };
        (v + (p2 + curve * curved) * size2 / 24.0).clamp(0.0, 1.0)
    }

    /// The profile's first antiderivative, from `lo`: y = d - lo.
    fn p1(&self, y: f64) -> f64 {
        let w = self.w as f64;
        if y <= 0.0 {
            y
        } else if y >= w {
            w * 0.5
        } else {
            let t = y / w;
            y - w * (t * t * t - 0.5 * t * t * t * t)
        }
    }

    /// The profile's first antiderivative from the path (y >= 0).
    fn p1_path(&self, y: f64) -> f64 {
        let lo = self.lo as f64;
        if y <= lo { y } else { lo + self.p1(y - lo) }
    }

    /// The profile's second antiderivative from the path (y >= 0).
    fn p2_path(&self, y: f64) -> f64 {
        let lo = self.lo as f64;
        if y <= lo { 0.5 * y * y } else { 0.5 * lo * lo + lo * (y - lo) + self.p2(y - lo) }
    }

    /// The profile's second antiderivative, from `lo`.
    fn p2(&self, y: f64) -> f64 {
        let w = self.w as f64;
        if y <= 0.0 {
            0.5 * y * y
        } else if y >= w {
            0.35 * w * w + 0.5 * w * (y - w)
        } else {
            let t = y / w;
            let t4 = t * t * t * t;
            0.5 * y * y - w * w * (0.25 * t4 - 0.1 * t4 * t)
        }
    }

    /// The profile's mean over a square whose center sits `d` from the
    /// path, across a straight edge: the square's extent along the
    /// edge's normal is the sum of two uniform spreads `a` and `b` wide
    /// (a square of side s at normal (nx, ny): s |nx| and s |ny|), so
    /// the mean is the profile's second antiderivative differenced over
    /// both.
    fn across(&self, d: f32, a: f32, b: f32) -> f32 {
        let reach = 0.5 * (a + b);
        if d + reach <= self.lo {
            return 1.0;
        }
        if d - reach >= self.hi() {
            return 0.0;
        }
        let (a, b) = (a as f64, b as f64);
        if a < 1e-9 {
            return self.at(d).0;
        }
        // Clear of the path, from `lo`, where the numbers stay small;
        // across the path itself, from the path, the profile mirrored
        // there (the distance is |v| either side of it).
        let fold = d - reach < 0.0;
        let y = if fold { d as f64 } else { (d - self.lo) as f64 };
        let p1 = |y: f64| if fold { y.signum() * self.p1_path(y.abs()) } else { self.p1(y) };
        let p2 = |y: f64| if fold { self.p2_path(y.abs()) } else { self.p2(y) };
        let v = if b < 1e-6 {
            (p1(y + 0.5 * a) - p1(y - 0.5 * a)) / a
        } else {
            let (s, r) = (0.5 * (a + b), 0.5 * (a - b));
            (p2(y + s) - p2(y + r) - p2(y - r) + p2(y - s)) / (a * b)
        };
        (v as f32).clamp(0.0, 1.0)
    }
}

/// The shape a brush's tip lays down around its path.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Metric {
    /// Round: the distance to the path.
    Round,
    /// Square: the larger of the two axis offsets from the path's
    /// nearest point, so a dab is a square out to the radius each way.
    Square,
}

/// One segment of the swept path, in the frame's pixels.
#[derive(Clone, Copy)]
struct Seg {
    ax: f32,
    ay: f32,
    dx: f32,
    dy: f32,
    inv: f32,
    /// Its length and unit direction (zero for a dab).
    len: f32,
    ux: f32,
    uy: f32,
}

impl Seg {
    fn new(a: (f32, f32), b: (f32, f32)) -> Seg {
        let (dx, dy) = (b.0 - a.0, b.1 - a.1);
        let len2 = dx * dx + dy * dy;
        let len = len2.sqrt();
        let (ux, uy) = if len > 0.0 { (dx / len, dy / len) } else { (0.0, 0.0) };
        Seg { ax: a.0, ay: a.1, dx, dy, inv: if len2 > 0.0 { 1.0 / len2 } else { 0.0 }, len, ux, uy }
    }

    /// The share of the pixel centered on (px, py) lying past the
    /// segment's end (`past`) or short of its start: where an end is
    /// the segment's nearest point. All of it for a dab.
    fn beyond(&self, px: f32, py: f32, past: bool) -> f32 {
        if self.len <= 0.0 {
            return 1.0;
        }
        let along = (px - self.ax) * self.ux + (py - self.ay) * self.uy;
        let s = if past { along - self.len } else { -along };
        crate::ops_selection::edge_cover(s, self.ux, self.uy)
    }

    /// The offset from the segment's nearest point to (px, py), and
    /// whether that point is an end (where the edge is a dab's curve).
    fn offset(&self, px: f32, py: f32) -> (f32, f32, bool) {
        let (ex, ey) = (px - self.ax, py - self.ay);
        let t = (ex * self.dx + ey * self.dy) * self.inv;
        let (t, end) = if t <= 0.0 {
            (0.0, true)
        } else if t >= 1.0 {
            (1.0, true)
        } else {
            (t, false)
        };
        (ex - t * self.dx, ey - t * self.dy, end)
    }

    /// The magnitudes of the unit normal of the distance's level line
    /// through a point offset (cx, cy), `d` long, from the segment's
    /// nearest point (`end`: an end): along a side the side's own
    /// normal, which holds on the path itself too.
    fn normal(&self, cx: f32, cy: f32, d: f32, end: bool) -> (f32, f32) {
        if !end && self.len > 0.0 {
            (self.uy.abs(), self.ux.abs())
        } else if d > 0.0 {
            ((cx / d).abs(), (cy / d).abs())
        } else {
            (1.0, 0.0)
        }
    }

    /// The distance from the segment to the point in pixels, for
    /// sorting segments into tiles.
    fn distance(&self, px: f32, py: f32) -> f32 {
        let (cx, cy, _) = self.offset(px, py);
        (cx * cx + cy * cy).sqrt()
    }
}

/// The path's chords. Runs of points closer together than a quarter of
/// the radius are consolidated into one chord: a capsule is exact
/// however short its segment, but every segment is one more distance
/// each pixel near it measures, and a pointer samples fast enough to
/// hand over points a few pixels apart under a brush a hundred pixels
/// wide. A chord a quarter radius long departs from its own path by
/// about a hundredth of a radius even on the tightest curve, so the
/// saving costs no shape anyone can see. A quarter of the radius at
/// every size, so Fit sweeps the chords the export sweeps.
fn chords(pts: &[(f32, f32)], radius: f32) -> Vec<Seg> {
    let mut out = Vec::new();
    if pts.is_empty() {
        return out;
    }
    let min_seg = radius * 0.25;
    let mut anchor = pts[0];
    let mut prev = pts[0];
    let mut acc = 0.0f32;
    for &p in &pts[1..] {
        acc += ((p.0 - prev.0).powi(2) + (p.1 - prev.1).powi(2)).sqrt();
        if acc >= min_seg && acc > 0.0 {
            out.push(Seg::new(anchor, p));
            anchor = p;
            acc = 0.0;
        }
        prev = p;
    }
    // The tail under the minimum, and the single-point dab, both close
    // here: the stroke must reach the point the pointer lifted at.
    if acc > 0.0 || out.is_empty() {
        out.push(Seg::new(anchor, *pts.last().unwrap()));
    }
    out
}

/// A segment a pixel weighs: its offset from the segment's nearest
/// point, whether that is an end, and its distance in the tip's metric
/// (squared for the round tip).
struct Cand {
    i: u32,
    cx: f32,
    cy: f32,
    end: bool,
    m: f32,
}

/// The nearest of `segs` to (px, py) in the tip's metric: the distance,
/// the offset from that segment's nearest point, whether that point is
/// a segment's end, and which segment. Equal distances go to the earlier
/// segment, so a patch and the export, which may list a pixel's segments
/// from different tiles, pick the same one.
fn nearest(segs: &[Seg], idx: &[u32], metric: Metric, px: f32, py: f32) -> (f32, f32, f32, bool, u32) {
    let mut best = (f32::INFINITY, 0.0f32, 0.0f32, false, 0u32);
    for &i in idx {
        let (cx, cy, end) = segs[i as usize].offset(px, py);
        let m = match metric {
            Metric::Round => cx * cx + cy * cy,
            Metric::Square => cx.abs().max(cy.abs()),
        };
        if m < best.0 {
            best = (m, cx, cy, end, i);
        }
    }
    if metric == Metric::Round {
        best.0 = best.0.sqrt();
    }
    best
}

/// The profile's mean over a sub-square `step` wide whose center is
/// offset (cx, cy) from the path's nearest point, `d` away in the tip's
/// metric.
fn sub_cover(prof: &Profile, metric: Metric, step: f32, d: f32, cx: f32, cy: f32, end: bool, seg: &Seg) -> f32 {
    match metric {
        Metric::Round => {
            if prof.smooth_across(d, HALF_DIAGONAL * step) {
                return prof.smooth_mean(d, if end { 1.0 } else { 0.0 }, step * step);
            }
            let (nx, ny) = seg.normal(cx, cy, d, end);
            prof.across(d, step * nx.max(ny), step * nx.min(ny))
        }
        Metric::Square if !end => {
            // Along a segment's side the offset runs along the side's
            // normal n, so the larger of its two parts is |v| times the
            // larger of n's: a straight edge, the metric growing that
            // much faster across it.
            let (nx, ny) = seg.normal(cx, cy, (cx * cx + cy * cy).sqrt(), false);
            let m = nx.max(ny);
            prof.across(d, step * m * m, step * m * nx.min(ny))
        }
        Metric::Square => {
            // Round a dab the square's edge is two axis-aligned edges,
            // the profile along each axis's offset, the lower of the two
            // winning (the profile of the larger offset).
            let r = 0.5 * step;
            let (ax, ay) = (cx.abs(), cy.abs());
            // Clear of the square's corner the larger offset is the
            // larger across the whole sub-square: one straight edge.
            if (ax - ay).abs() >= step {
                return prof.across(ax.max(ay), step, 0.0);
            }
            // Across an axis-aligned sub-square the two offsets spread
            // independently. The share of the sub-square within `dt` of
            // the path along one axis, its center offset `c` (the offset
            // folds at the path):
            let share = |c: f32, dt: f32| (((dt - c).min(r) - (-dt - c).max(-r)).max(0.0) / step).min(1.0);
            if prof.w <= 0.0 {
                // Hard: the share inside both edges, across times down.
                return share(cx, prof.lo) * share(cy, prof.lo);
            }
            if ax.min(ay) >= r && prof.w >= 8.0 * step {
                // A falloff wide against the sub-square is a straight
                // line across it, so the mean is the profile at the mean
                // of the larger offset: two uniform spreads `step` wide,
                // their larger one's mean the larger center plus
                // (step - gap)^3 / (6 step^2).
                let gap = (ax - ay).abs();
                let m = ax.max(ay) + (step - gap).powi(3) / (6.0 * step * step);
                return prof.at(m).0;
            }
            // Otherwise the mean of the lower profile is the integral over
            // levels t of the chance both clear t.
            const LEVELS: usize = 16;
            let mut sum = 0.0f32;
            for k in 0..LEVELS {
                let t = (k as f32 + 0.5) / LEVELS as f32;
                // The distance at which the profile falls to t: the
                // smoothstep's inverse at 1 - t.
                let dt = prof.lo + prof.w * (0.5 - ((1.0 - 2.0 * (1.0 - t)).asin() / 3.0).sin());
                sum += share(cx, dt) * share(cy, dt);
            }
            sum / LEVELS as f32
        }
    }
}

/// The share of pixel (fx, fy) whose nearest point on the path is one
/// of the path's vertices (`near`'s ends), where the distance's level
/// lines are a dab's circles rather than a side's straight lines: the
/// wedge between a vertex's two perpendiculars on the outside of its
/// turn, and the half-planes past the path's two ends. Each a share of
/// the square across straight lines, exact while the pixel is clear of
/// the vertex itself.
fn cap_share(segs: &[Seg], near: &[u32], fx: f32, fy: f32, reach: f32) -> f32 {
    let n = segs.len();
    let mut share = 0.0f32;
    let mut last = usize::MAX;
    for &k in near {
        for v in [k as usize, k as usize + 1] {
            // Vertices come in order; each once.
            if v == last || (last != usize::MAX && v < last) {
                continue;
            }
            last = v;
            // Only a vertex that can be the nearest point somewhere in
            // the pixel: a far end of a near segment's wedge may hold
            // the pixel while another part of the path is nearer.
            let (vx, vy) = if v < n { (segs[v].ax, segs[v].ay) } else { (segs[v - 1].ax + segs[v - 1].dx, segs[v - 1].ay + segs[v - 1].dy) };
            let (ex, ey) = (fx - vx, fy - vy);
            if ex * ex + ey * ey > reach * reach {
                continue;
            }
            let past = if v == 0 { 1.0 } else { segs[v - 1].beyond(fx, fy, true) };
            let short = if v == n { 1.0 } else { segs[v].beyond(fx, fy, false) };
            share += (past + short - 1.0).max(0.0);
        }
    }
    share.min(1.0)
}

/// The profile averaged over pixel (fx, fy)'s square, its center `d0`
/// from the path in the tip's metric, nearest to segment `win` (`end`:
/// at one of its ends).
fn pixel_cover(segs: &[Seg], cand: &[Cand], metric: Metric, prof: &Profile, fx: f32, fy: f32, d0: f32, win: u32, end: bool) -> f32 {
    // The segments that can be nearest somewhere in the pixel: a point
    // of it is within half a diagonal of the center, so its nearest
    // segment is within twice that of the center's distance.
    let reach = d0 + 2.0 * HALF_DIAGONAL;
    let reach_m = match metric {
        Metric::Round => reach * reach,
        Metric::Square => reach,
    };
    // On the stack; a pixel among more segments than that (a scribble
    // over itself) spills to the heap, keeping the same list.
    let mut near = [0u32; 32];
    let mut n = 0usize;
    let mut spill: Vec<u32> = Vec::new();
    // How sharply the pixel's distance kinks: across a ridge, where two
    // parts of the path are equally near and the edge turns a corner
    // (inside a turn, or where a stroke comes back past itself), the
    // distance's gradient jumps by the difference of the two parts'
    // directions. The profile kinks with it, which neither the center's
    // Laplacian nor a straight edge sees: a sharp kink is cut finer, a
    // gentle one costs a few thousandths at most.
    let mut kink = 0.0f32;
    let (wx, wy, _) = segs[win as usize].offset(fx, fy);
    for c in cand {
        if c.m > reach_m {
            continue;
        }
        let (i, cx, cy, e) = (c.i, c.cx, c.cy, c.end);
        let d = match metric {
            Metric::Round => c.m.sqrt(),
            Metric::Square => c.m,
        };
        if n < near.len() {
            near[n] = i;
            n += 1;
        } else {
            if spill.is_empty() {
                spill.extend_from_slice(&near);
            }
            spill.push(i);
        }
        if i == win {
            continue;
        }
        // A square tip's sides are as wide as their slope makes them, so
        // a turn always kinks it: any other segment in reach.
        if metric == Metric::Square {
            kink = 2.0;
            continue;
        }
        // A neighbor that carries on from the winner's end (one of the
        // two measured to their shared vertex, the other along its
        // side) meets it smoothly on the outside of their turn. Any
        // other segment makes a ridge where its distance can drop to the
        // winner's within the pixel, which, both changing at most by the
        // difference of their gradients, is where the gap is under that
        // difference across half a diagonal.
        if i.abs_diff(win) == 1 && e != end {
            let (first, next) = (&segs[i.min(win) as usize], &segs[i.max(win) as usize]);
            let turn = first.ux * next.uy - first.uy * next.ux;
            let side = first.ux * (fy - next.ay) - first.uy * (fx - next.ax);
            if turn * side <= 0.0 {
                continue;
            }
        }
        let (g, gw) = (d.max(1e-6), d0.max(1e-6));
        let (jx, jy) = (cx / g - wx / gw, cy / g - wy / gw);
        let jump = (jx * jx + jy * jy).sqrt();
        if d - d0 <= jump * HALF_DIAGONAL + 1e-3 {
            kink = kink.max(jump);
        }
    }
    // A square dab's own corner is a ridge of its metric: where the two
    // offsets are within the pixel's reach of each other.
    if metric == Metric::Square && end && (wx.abs() - wy.abs()).abs() <= 2.0 * HALF_DIAGONAL {
        kink = 2.0;
    }
    let near: &[u32] = if spill.is_empty() { &near[..n] } else { &spill };
    // A brush under a pixel in radius has its whole path inside the
    // pixels it touches: a pixel straddles the path, a bend in it and the
    // ridge inside the bend, which its center's side of the path does not
    // see. Every such pixel is cut finely, measured from the whole path.
    if prof.hi() < 1.0 {
        return sub_squares(segs, near, metric, prof, fx, fy, SMALL_CUTS);
    }
    if metric == Metric::Round {
        let (_, slope, _) = prof.at(d0);
        // The profile is a cubic across the pixel (or near enough one)
        // and any kink costs under a few thousandths (about the slope
        // times the jump over sixteen): its mean over the square is the
        // center value and a twenty-fourth of its Laplacian, the second
        // derivative across the edge plus, on the share of the pixel
        // round a vertex, the first over the radius.
        if (prof.w >= SMOOTH_WIDTH || (prof.w >= NARROW && prof.smooth_across(d0, HALF_DIAGONAL))) && kink * slope.abs() < 0.03 {
            return prof.smooth_mean(d0, cap_share(segs, near, fx, fy, reach), 1.0);
        }
        // An edge crosses the pixel along a side, straight: its mean is
        // exact across the pixel's own square. Round a vertex too, where
        // the curve is wide against the pixel (about 1 / (24 r) off).
        let curved = kink == 0.0 && d0 < WIDE_CURVE && cap_share(segs, near, fx, fy, reach) > 0.0;
        if kink == 0.0 && !curved {
            let (nx, ny) = segs[win as usize].normal(wx, wy, d0, end);
            return prof.across(d0, nx.max(ny), nx.min(ny));
        }
        // Round a curve four pixels or more in radius, two by two is
        // enough (about 1 / (96 r) off).
        if curved && d0 >= 4.0 {
            return sub_squares(segs, near, metric, prof, fx, fy, 2);
        }
    }
    // Round a tight curve or across a ridge: sub-squares, each across the
    // straight edge through it, measured from the whole path; a sharp
    // ridge twice as finely.
    sub_squares(segs, near, metric, prof, fx, fy, if kink > SHARP_KINK { 2 * CUTS } else { CUTS })
}

/// The pixel at (fx, fy) cut `cuts` by `cuts`, each sub-square across
/// the straight edge through it, measured from the nearest of `near`.
fn sub_squares(segs: &[Seg], near: &[u32], metric: Metric, prof: &Profile, fx: f32, fy: f32, cuts: usize) -> f32 {
    let step = 1.0 / cuts as f32;
    let mut sum = 0.0f32;
    for j in 0..cuts {
        let sy = fy + (j as f32 + 0.5) * step - 0.5;
        for i in 0..cuts {
            let sx = fx + (i as f32 + 0.5) * step - 0.5;
            let (d, cx, cy, end, k) = nearest(segs, near, metric, sx, sy);
            sum += sub_cover(prof, metric, step, d, cx, cy, end, &segs[k as usize]);
        }
    }
    sum / (cuts * cuts) as f32
}

/// Sweeps a brush along `pts` (in the frame's pixels) into `out`, a
/// `w` by `h` buffer holding the frame's pixels from `off` on: each
/// pixel the brush reaches gets `shade(cover, fx, fy)`, its coverage and
/// its center in the frame's pixels, where that is more than it holds.
///
/// Every pixel measures from the frame's own numbers and the whole
/// path, so a patch of the frame (a 1:1 slice) is the export's pixels
/// there, bit for bit.
pub(crate) fn sweep(
    out: &mut [f32],
    w: usize,
    h: usize,
    off: (isize, isize),
    pts: &[(f32, f32)],
    radius: f32,
    hardness: f32,
    metric: Metric,
    shade: impl Fn(f32, f32, f32) -> f32 + Sync,
) {
    sweep_with(out, w, h, off, pts, radius, hardness, metric, None::<&NoGrain>, |cover, _, fx, fy| shade(cover, fx, fy));
}

/// A textured tip's grain at a point in the frame's pixels, with a
/// scratch `Cache` each band keeps (the noise lattice's last cell, say)
/// that changes how fast the answer comes, never the answer.
pub(crate) trait GrainSampler: Sync {
    type Cache: Default;
    fn at(&self, cache: &mut Self::Cache, x: f32, y: f32) -> f32;
    /// How a pixel's average of the grain is taken.
    fn plan(&self) -> GrainPlan;
}

/// How a textured sweep averages its grain over a pixel: on an `nx` by
/// `ny` grid, blended by `alpha` toward `mean`, the grain's own average
/// over the whole plane (what a pixel's average tends to as the grain
/// gets finer than the grid can follow).
#[derive(Clone, Copy, Debug)]
pub(crate) struct GrainPlan {
    pub(crate) nx: usize,
    pub(crate) ny: usize,
    /// A coarser grid for coarse grain, and how far toward the fine grid
    /// the pixel is (0 the coarse alone, 1 the fine alone).
    pub(crate) coarse_nx: usize,
    pub(crate) coarse_ny: usize,
    pub(crate) fine: f32,
    pub(crate) alpha: f32,
    pub(crate) mean: f32,
}

/// The grain of an untextured sweep, which has none.
pub(crate) struct NoGrain;

impl GrainSampler for NoGrain {
    type Cache = ();
    fn at(&self, _: &mut (), _: f32, _: f32) -> f32 {
        1.0
    }
    fn plan(&self) -> GrainPlan {
        GrainPlan { nx: 1, ny: 1, coarse_nx: 1, coarse_ny: 1, fine: 1.0, alpha: 1.0, mean: 1.0 }
    }
}

/// A textured brush's coverage: each pixel the profile averaged over its
/// square (the analytic path every brush takes) times the grain averaged
/// over the share of the square the brush covers, taken on the grain's
/// small grid (GrainPlan) and blended toward the grain's own mean as the
/// grain gets finer than the grid can follow. Frame coordinates
/// throughout, so a slice is the whole frame's pixels to the bit.
pub(crate) fn sweep_textured<G: GrainSampler>(
    out: &mut [f32], w: usize, h: usize, off: (isize, isize),
    pts: &[(f32, f32)], radius: f32, hardness: f32,
    grain: &G,
) {
    sweep_with(out, w, h, off, pts, radius, hardness, Metric::Round, Some(grain),
        |cover, _, _, _| cover);
}

/// The stroke's footprint as a region: 1 where a pixel's center lies
/// within the brush's radius of the path, 0 elsewhere (into `out` as
/// sweep lays coverage). A heal solves over this, the same region at
/// every size; the pixels its rim only partly covers keep their own
/// tone there, which is the solve's tone at its boundary.
pub(crate) fn footprint(out: &mut [f32], w: usize, h: usize, off: (isize, isize), pts: &[(f32, f32)], radius: f32, hardness: f32, metric: Metric) {
    sweep_with(out, w, h, off, pts, radius, hardness, metric, None::<&NoGrain>, |_, inside, _, _| if inside { 1.0 } else { 0.0 });
}

/// sweep, its shade also told whether the pixel's center lies within the
/// radius.
fn sweep_with<G: GrainSampler>(
    out: &mut [f32],
    w: usize,
    h: usize,
    off: (isize, isize),
    pts: &[(f32, f32)],
    radius: f32,
    hardness: f32,
    metric: Metric,
    grain: Option<&G>,
    shade: impl Fn(f32, bool, f32, f32) -> f32 + Sync,
) {
    if pts.is_empty() || w == 0 || h == 0 {
        return;
    }
    let prof = Profile::of(radius, hardness);
    let segs = chords(pts, radius);
    // How far from a segment a pixel's center can be and still be
    // touched: the radius (a square's corner a diagonal of it), and half
    // a pixel's diagonal.
    let extent = match metric {
        Metric::Round => prof.hi(),
        Metric::Square => prof.hi() * std::f32::consts::SQRT_2,
    } + HALF_DIAGONAL;
    // How far a segment can be and still count for a touched pixel: the
    // segments pixel_cover weighs reach twice half a diagonal past the
    // nearest, so a tile lists every segment within that of any pixel
    // in it (a square's metric is at least its distance over root two).
    // Every pixel then weighs the same segments in a patch as in the
    // export, whatever tiles hold it.
    let listed = match metric {
        Metric::Round => prof.hi() + 3.0 * HALF_DIAGONAL,
        Metric::Square => (prof.hi() + 3.0 * HALF_DIAGONAL) * std::f32::consts::SQRT_2,
    } + 1.0;
    // The tiles the path's bounds touch, in the buffer.
    let (mut bx0, mut by0, mut bx1, mut by1) = (f32::INFINITY, f32::INFINITY, f32::NEG_INFINITY, f32::NEG_INFINITY);
    for s in &segs {
        bx0 = bx0.min(s.ax.min(s.ax + s.dx));
        by0 = by0.min(s.ay.min(s.ay + s.dy));
        bx1 = bx1.max(s.ax.max(s.ax + s.dx));
        by1 = by1.max(s.ay.max(s.ay + s.dy));
    }
    let clampi = |v: f32, o: isize, n: usize| -> isize { ((v.floor() as isize) - o).clamp(-1, n as isize) };
    let (px0, py0) = (clampi(bx0 - extent, off.0, w).max(0) as usize, clampi(by0 - extent, off.1, h).max(0) as usize);
    let (px1, py1) = (clampi(bx1 + extent, off.0, w), clampi(by1 + extent, off.1, h));
    if px1 < px0 as isize || py1 < py0 as isize || px0 >= w || py0 >= h {
        return;
    }
    let (px1, py1) = ((px1 as usize).min(w - 1), (py1 as usize).min(h - 1));
    let tile = tile_for(prof.hi());
    let (tx0, ty0, tx1, ty1) = (px0 / tile, py0 / tile, px1 / tile, py1 / tile);
    let tw = tx1 - tx0 + 1;
    // Each tile's segments: those within reach of some pixel in it, in
    // the path's order.
    let half = tile as f32 * HALF_DIAGONAL;
    let mut tiles: Vec<Vec<u32>> = vec![Vec::new(); tw * (ty1 - ty0 + 1)];
    for (k, s) in segs.iter().enumerate() {
        let (sx0, sx1) = (s.ax.min(s.ax + s.dx) - listed, s.ax.max(s.ax + s.dx) + listed);
        let (sy0, sy1) = (s.ay.min(s.ay + s.dy) - listed, s.ay.max(s.ay + s.dy) + listed);
        let t = |v: f32, o: isize, lo: usize, hi: usize| (((v.floor() as isize - o).max(0) as usize) / tile).clamp(lo, hi);
        for ty in t(sy0, off.1, ty0, ty1)..=t(sy1, off.1, ty0, ty1) {
            for tx in t(sx0, off.0, tx0, tx1)..=t(sx1, off.0, tx0, tx1) {
                // The tile's center in the frame.
                let cx = (tx * tile) as f32 + off.0 as f32 + tile as f32 * 0.5;
                let cy = (ty * tile) as f32 + off.1 as f32 + tile as f32 * 0.5;
                if s.distance(cx, cy) <= listed + half {
                    tiles[(ty - ty0) * tw + (tx - tx0)].push(k as u32);
                }
            }
        }
    }
    let (lo, hi) = (prof.lo, prof.hi());
    // Each segment's bounds out to the reach a pixel's average weighs
    // (pixel_cover: the nearest's distance and a diagonal more, the
    // nearest under the radius and half a diagonal): a segment past
    // them never counts at that pixel, whichever tile lists it.
    let weighed = listed - 1.0;
    let bounds: Vec<[f32; 4]> = segs
        .iter()
        .map(|s| {
            [
                s.ax.min(s.ax + s.dx) - weighed,
                s.ay.min(s.ay + s.dy) - weighed,
                s.ax.max(s.ax + s.dx) + weighed,
                s.ay.max(s.ay + s.dy) + weighed,
            ]
        })
        .collect();
    // From the weighed bounds in to those a touched pixel's center can
    // lie in (the radius, a square's corner, and half a diagonal).
    let slack = weighed - extent;
    // Deep inside the hard core: within this of any segment, in the
    // metric's terms (a squared distance for the round tip).
    let core = lo - HALF_DIAGONAL;
    let stop_m = match metric {
        Metric::Round if core > 0.0 => core * core,
        Metric::Round => -1.0,
        Metric::Square => core,
    };
    out.par_chunks_mut(tile * w).enumerate().skip(ty0).take(ty1 - ty0 + 1).for_each(|(ty, band)| {
        let rows = band.len() / w;
        let mut cand: Vec<Cand> = Vec::with_capacity(64);
        let textured = grain.is_some();
        let mut grain_near: Vec<u32> = if textured { Vec::with_capacity(32) } else { Vec::new() };
        let mut cache = G::Cache::default();
        for tx in tx0..=tx1 {
            let idx = &tiles[(ty - ty0) * tw + (tx - tx0)];
            if idx.is_empty() {
                continue;
            }
            // Only the pixels some listed segment can touch.
            let mut u = [f32::INFINITY, f32::INFINITY, f32::NEG_INFINITY, f32::NEG_INFINITY];
            for &i in idx {
                let b = &bounds[i as usize];
                u = [u[0].min(b[0] + slack), u[1].min(b[1] + slack), u[2].max(b[2] - slack), u[3].max(b[3] - slack)];
            }
            let span = |lo: f32, hi: f32, o: isize, a: usize, b: usize| -> (isize, isize) {
                let lo = ((lo - 0.5).floor() as isize - o).max(a as isize);
                let hi = ((hi - 0.5).ceil() as isize - o).min(b as isize);
                (lo, hi)
            };
            let (x0, x1) = span(u[0], u[2], off.0, (tx * tile).max(px0), ((tx + 1) * tile - 1).min(px1));
            let (ry0, ry1) = span(u[1], u[3], off.1, (ty * tile).max(py0), ((ty + 1) * tile - 1).min(py1));
            if x1 < x0 || ry1 < ry0 {
                continue;
            }
            let (x0, x1) = (x0 as usize, x1 as usize);
            for r in 0..rows {
                let y = ty * tile + r;
                if (y as isize) < ry0 || (y as isize) > ry1 {
                    continue;
                }
                let fy = (y as isize + off.1) as f32 + 0.5;
                for x in x0..=x1 {
                    let fx = (x as isize + off.0) as f32 + 0.5;
                    // The nearest segment, every segment's offset kept for
                    // the pixel's average. Deep inside the hard core, any
                    // segment that close settles it.
                    cand.clear();
                    let mut best = (f32::INFINITY, 0u32, false);
                    let mut core = false;
                    for &i in idx {
                        // Past the reach any pixel's average weighs, by
                        // the segment's bounds alone.
                        let b = &bounds[i as usize];
                        if fx < b[0] || fx > b[2] || fy < b[1] || fy > b[3] {
                            continue;
                        }
                        let (cx, cy, end) = segs[i as usize].offset(fx, fy);
                        let m = match metric {
                            Metric::Round => cx * cx + cy * cy,
                            Metric::Square => cx.abs().max(cy.abs()),
                        };
                        if m <= stop_m {
                            core = true;
                            break;
                        }
                        cand.push(Cand { i, cx, cy, end, m });
                        if m < best.0 {
                            best = (m, i, end);
                        }
                    }
                    let d0 = match metric {
                        Metric::Round => best.0.sqrt(),
                        Metric::Square => best.0,
                    };
                    let cover = if core {
                        1.0
                    } else if d0 >= hi + HALF_DIAGONAL {
                        0.0
                    } else {
                        pixel_cover(&segs, &cand, metric, &prof, fx, fy, d0, best.1, best.2)
                    };
                    if cover <= 0.0 {
                        continue;
                    }
                    let v = if !textured {
                        shade(cover, core || d0 < hi, fx, fy)
                    } else {
                        let grain = grain.expect("a textured sweep has its grain");
                        // Where the whole pixel lies inside the profile's
                        // flat top every point weighs one, as deep in the
                        // core: no point needs its own distance.
                        let core = core || d0 + HALF_DIAGONAL + 1e-3 <= lo;
                        // A segment farther than this cannot be nearest
                        // anywhere in the pixel. Reuse the band's list:
                        // fine grain must not search a whole tile at each
                        // quadrature point. Keep path order for exact ties.
                        grain_near.clear();
                        if !core {
                            let reach = d0 + 2.0 * HALF_DIAGONAL;
                            grain_near.extend(cand.iter().filter(|c| c.m <= reach * reach).map(|c| c.i));
                        }
                        // The profile's share comes from the analytic cover; the
                        // grain is only averaged. Where the grain is finer
                        // than the grid it is its mean alone, no point taken.
                        let plan = grain.plan();
                        let mean = plan.mean as f64;
                        if plan.alpha >= 1.0 {
                            cover * plan.mean
                        } else {
                            // The grain's average over the share of the pixel the
                            // brush covers, on an `nx` by `ny` grid: each point
                            // weighs the profile there (one everywhere in the flat
                            // top), so grain and profile move together along a rim.
                            let grain_near = &grain_near;
                            let grid = |nx: usize, ny: usize, cache: &mut G::Cache| -> f64 {
                                let (step_x, step_y) = (1.0 / nx as f32, 1.0 / ny as f32);
                                let (mut weight, mut sum, mut plain) = (0.0f64, 0.0f64, 0.0f64);
                                for j in 0..ny {
                                    let sy = fy - 0.5 + (j as f32 + 0.5) * step_y;
                                    for i in 0..nx {
                                        let sx = fx - 0.5 + (i as f32 + 0.5) * step_x;
                                        let c = if core { 1.0 } else {
                                            let (d, cx, cy, end, k) = nearest(&segs, grain_near, metric, sx, sy);
                                            if prof.w > 0.0 { prof.at(d).0 }
                                            else {
                                                // A hard edge across the sub-rectangle: its
                                                // extent along the edge's normal is two
                                                // uniform spreads, each side times the
                                                // normal's part along it.
                                                let (enx, eny) = segs[k as usize].normal(cx, cy, d, end);
                                                let (a, b) = (step_x * enx, step_y * eny);
                                                prof.across(d, a.max(b), a.min(b))
                                            }
                                        } as f64;
                                        if c > 0.0 {
                                            let g = grain.at(cache, sx, sy) as f64;
                                            weight += c;
                                            sum += c * g;
                                        }
                                    }
                                }
                                if weight > 0.0 {
                                    return sum / weight;
                                }
                                // A brush too small to hold a point of the grid:
                                // the grain over the whole pixel.
                                for j in 0..ny {
                                    let sy = fy - 0.5 + (j as f32 + 0.5) * step_y;
                                    for i in 0..nx {
                                        let sx = fx - 0.5 + (i as f32 + 0.5) * step_x;
                                        plain += grain.at(cache, sx, sy) as f64;
                                    }
                                }
                                plain / (nx * ny) as f64
                            };
                            // Coarse grain on the coarse grid alone, fine on the
                            // fine grid, the two crossfaded between.
                            let b = plan.fine as f64;
                            let coarse = if b < 1.0 { grid(plan.coarse_nx, plan.coarse_ny, &mut cache) } else { 0.0 };
                            let fine = if b > 0.0 { grid(plan.nx, plan.ny, &mut cache) } else { 0.0 };
                            let sampled = (1.0 - b) * coarse + b * fine;
                            let a = plan.alpha as f64;
                            cover * ((1.0 - a) * sampled + a * mean) as f32
                        }
                    };
                    let o = &mut band[r * w + x];
                    if v > *o {
                        *o = v;
                    }
                }
            }
        }
    });
}

#[cfg(test)]
mod brush_cover_tests {
    use super::*;

    /// The profile averaged over a 128 by 128 grid in pixel (x, y), from
    /// the distance to the whole path at each point: the reference. Each
    /// row and column of the grid is shifted by a golden-ratio fraction
    /// of its spacing, so an edge along an axis (a square tip's) is not
    /// counted a whole row of samples at a time.
    fn brute(pts: &[(f32, f32)], radius: f32, hardness: f32, metric: Metric, x: usize, y: usize) -> f32 {
        let segs = chords(pts, radius);
        let all: Vec<u32> = (0..segs.len() as u32).collect();
        let prof = Profile::of(radius, hardness);
        const N: usize = 128;
        let mut sum = 0.0f64;
        for j in 0..N {
            for i in 0..N {
                let (ox, oy) = ((j as f32 * 0.618_034).fract(), (i as f32 * 0.754_878).fract());
                let (px, py) = (x as f32 + (i as f32 + ox) / N as f32, y as f32 + (j as f32 + oy) / N as f32);
                let (d, ..) = nearest(&segs, &all, metric, px, py);
                // A hard edge is a step; a sample on it counts in.
                sum += if prof.w == 0.0 { (d <= prof.lo) as u8 as f64 } else { prof.at(d).0 as f64 };
            }
        }
        (sum / (N * N) as f64) as f32
    }

    /// Coverage is the brush's profile averaged over each pixel: within
    /// a few thousandths of a 128 by 128 grid's average, for round and
    /// square tips, hard and soft, from under a pixel in radius to
    /// thirteen (wider falloffs are smoother still), for a dab, a
    /// straight stroke, a sharp V and a gently curving stroke.
    #[test]
    fn coverage_is_the_profile_averaged_over_the_pixel() {
        let paths: [&[(f32, f32)]; 4] = [
            &[(20.37, 20.71)],
            &[(6.13, 9.42), (33.7, 27.1)],
            &[(5.2, 30.3), (20.6, 8.1), (34.9, 31.4)],
            &[(4.6, 20.2), (12.1, 21.0), (19.2, 23.4), (25.8, 27.6), (31.2, 33.3), (34.0, 36.1)],
        ];
        let mut failed = Vec::new();
        for metric in [Metric::Round, Metric::Square] {
            // A dab smaller than the pixel is curved inside a sub-square;
            // the worst of the rest is the inside of the sharp turn.
            for &(radius, bound) in &[(0.3f32, 0.01f32), (0.5, 0.01), (0.75, 0.01), (1.0, 0.008), (2.0, 0.008), (3.3, 0.008), (8.0, 0.008), (13.0, 0.008)] {
                let mut worst = (0.0f32, String::new());
                for &hardness in &[1.0f32, 0.97, 0.85, 0.5, 0.0] {
                    for (k, pts) in paths.iter().enumerate() {
                        let (w, h) = (42usize, 42usize);
                        let mut out = vec![0.0f32; w * h];
                        sweep(&mut out, w, h, (0, 0), pts, radius, hardness, metric, |c, _, _| c);
                        for y in 0..h {
                            for x in 0..w {
                                let got = out[y * w + x];
                                // Only where the brush's edge or falloff is.
                                if got == 0.0 && x % 3 != 0 || got == 1.0 {
                                    continue;
                                }
                                let want = brute(pts, radius, hardness, metric, x, y);
                                let d = (got - want).abs();
                                if d > worst.0 {
                                    worst = (d, format!("{metric:?} r {radius} hardness {hardness} path {k} at ({x}, {y}): {got} against {want}"));
                                }
                            }
                        }
                    }
                }
                eprintln!("{metric:?} r {radius}: worst {} ({})", worst.0, worst.1);
                if worst.0 >= bound {
                    failed.push(format!("{} over {bound}: {}", worst.0, worst.1));
                }
            }
        }
        assert!(failed.is_empty(), "coverage departs from the profile's average: {failed:#?}");
    }

    /// A patch of the frame (the 1:1 slice) is the export's pixels there
    /// to the bit, however its tiles fall against the export's: odd
    /// offsets, hard and soft, round and square, a path that turns and
    /// crosses itself.
    #[test]
    fn a_patch_is_the_export_to_the_bit() {
        let pts: Vec<(f32, f32)> = (0..90)
            .map(|i| {
                let t = i as f32 / 89.0;
                (40.3 + 300.0 * t + 60.0 * (t * 17.0).sin(), 150.7 + 90.0 * (t * 6.1).cos())
            })
            .collect();
        let (w, h) = (420usize, 300usize);
        for metric in [Metric::Round, Metric::Square] {
            for &(radius, hardness) in &[(1.3f32, 1.0f32), (6.0, 1.0), (6.0, 0.9), (17.0, 0.6), (40.0, 0.0)] {
                let mut full = vec![0.0f32; w * h];
                sweep(&mut full, w, h, (0, 0), &pts, radius, hardness, metric, |c, _, _| c);
                assert!(full.iter().any(|v| *v > 0.0 && *v < 1.0));
                for &(x0, y0, pw, ph) in &[(17usize, 9usize, 151usize, 133usize), (203, 101, 217, 199), (0, 0, 61, 300), (333, 47, 87, 31)] {
                    let mut patch = vec![0.0f32; pw * ph];
                    sweep(&mut patch, pw, ph, (x0 as isize, y0 as isize), &pts, radius, hardness, metric, |c, _, _| c);
                    for y in 0..ph {
                        for x in 0..pw {
                            let (a, b) = (patch[y * pw + x], full[(y0 + y) * w + x0 + x]);
                            assert!(a.to_bits() == b.to_bits(), "{metric:?} r {radius} hardness {hardness}: patch at {:?} {a} against the export's {b}", (x0 + x, y0 + y));
                        }
                    }
                }
            }
        }
    }

    /// The straight edge's average is exact: a sub-square's mean across
    /// an edge at any angle agrees with a fine grid's.
    #[test]
    fn the_straight_edge_mean_is_the_area() {
        for &(lo, w) in &[(3.0f32, 0.0f32), (3.0, 0.6), (3.0, 2.5), (0.0, 4.0)] {
            let prof = Profile { lo, w };
            for k in 0..24 {
                let ang = k as f32 * 0.137;
                let (nx, ny) = (ang.cos(), ang.sin());
                for m in 0..40 {
                    // Distances are never negative: across the path the
                    // profile folds (|v| either side of a stroke's line).
                    let d = (lo - 1.0 + m as f32 * (w + 2.0) / 40.0).max(0.0);
                    let got = prof.across(d, nx.abs().max(ny.abs()), nx.abs().min(ny.abs()));
                    const N: usize = 400;
                    let mut sum = 0.0f64;
                    for j in 0..N {
                        for i in 0..N {
                            let (u, v) = ((i as f32 + 0.5) / N as f32 - 0.5, (j as f32 + 0.5) / N as f32 - 0.5);
                            let dd = d + u * nx + v * ny;
                            sum += if w == 0.0 { (dd.abs() <= lo) as u8 as f64 } else { prof.at(dd.abs()).0 as f64 };
                        }
                    }
                    let want = (sum / (N * N) as f64) as f32;
                    assert!((got - want).abs() < 2e-3, "lo {lo} w {w} angle {ang} d {d}: {got} against {want}");
                }
            }
        }
    }
}
