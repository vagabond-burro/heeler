//! Retouching: clone, heal, fill and gradient. The art stack's phase-2
//! tools.
//!
//! Everything here produces an RGBA canvas the layer stack composites,
//! and everything here is replayable data rather than stored pixels: a
//! clone is a list of strokes plus where they read from, so it
//! re-executes after an upstream develop change instead of going stale
//! the way a baked layer-editor patch does. That is the whole argument for
//! doing this in a graph.

use std::sync::Arc;

use heeler_graph::Node;

use crate::buffers::{ImageBuf, Value};
use crate::executor::EngineError;
use crate::ops::{image_input, p};
use crate::ops_masks::parse_hex_display;

/// Bilinear sample, transparent outside the buffer. Outside is a real
/// answer here: at 1:1 the source of a clone can sit beyond the patch,
/// and a transparent sample composites to "leave the photograph alone"
/// rather than smearing an edge pixel across the repair.
pub(crate) fn sample(img: &ImageBuf, fx: f32, fy: f32) -> [f32; 4] {
    let (w, h) = (img.width as f32, img.height as f32);
    if fx < 0.0 || fy < 0.0 || fx >= w || fy >= h {
        return [0.0; 4];
    }
    let gx = (fx - 0.5).clamp(0.0, w - 1.0);
    let gy = (fy - 0.5).clamp(0.0, h - 1.0);
    let x0 = gx.floor() as usize;
    let y0 = gy.floor() as usize;
    let x1 = (x0 + 1).min(img.width - 1);
    let y1 = (y0 + 1).min(img.height - 1);
    let (tx, ty) = (gx - x0 as f32, gy - y0 as f32);
    let (p00, p10, p01, p11) = (
        img.pixel(x0, y0),
        img.pixel(x1, y0),
        img.pixel(x0, y1),
        img.pixel(x1, y1),
    );
    let mut out = [0.0f32; 4];
    for c in 0..4 {
        let top = p00[c] + (p10[c] - p00[c]) * tx;
        let bot = p01[c] + (p11[c] - p01[c]) * tx;
        out[c] = top + (bot - top) * ty;
    }
    out
}

/// Clone and heal, kept as a node type of its own for graphs that
/// already carry one. The work happens in the paint op now: a repair is
/// just a stroke with a source offset, so one layer takes every tool
/// ("We should have one layer that works with all the
/// tools").
///
/// Clone copies pixels from the offset; heal copies the TEXTURE from
/// there but takes its color and brightness from the destination, so a
/// repair lands in the right tone instead of dragging the source's
/// exposure with it.
pub(crate) fn clone_stamp(node: &Node, inputs: &[(String, Value)]) -> Result<Value, EngineError> {
    crate::ops_masks::paint(node, inputs)
}

/// Seamless heal: solves for the colors inside a stroke that keep the
/// source's TEXTURE but meet the destination's tones all the way around
/// the stroke's edge: a Poisson blend, the trick every healing brush
/// that earns the name is built on.
///
/// The mean shift this replaces matched the stroke's AVERAGE landing
/// tone, and for a dust spot on an even sky an average is all a repair
/// needs. But one offset cannot match SHADING: a stroke laid across a
/// light gradient got a single shift, so the end sitting in shadow kept
/// the lit side's tone and the patch showed. Here the boundary
/// condition is the destination ring itself, so every side of the
/// stroke agrees with the ground it touches, and the source contributes
/// only its gradients, the texture. "match the texture,
/// lighting, and shading of the target area so the repair looks smooth
/// and natural."
///
/// Solved with SOR over the stroke's bounding box. Returns the RGB
/// patch as (data, x0, y0, width, height), or None when there is
/// nothing under the stroke, or when the stroke is so large that an
/// iterative solve is the wrong tool, in which case the caller falls
/// back to the mean shift. A repair the size of the frame was never a
/// repair.
pub(crate) fn seamless_patch(
    src: &ImageBuf,
    cov: &crate::buffers::MaskBuf,
    footprint: &crate::buffers::MaskBuf,
    off: (f32, f32),
    win: crate::ops_masks::FrameWindow,
) -> Option<(Vec<f32>, usize, usize, usize, usize)> {
    let (w, h) = (src.width, src.height);
    // The stroke's footprint, tightly. This was a serial full-frame
    // scan per heal stroke, seconds of a large export's heal all told;
    // coverage_bounds walks the same pixels in parallel, and min and
    // max over indices are order-free, so the box is the same.
    let Some((x0, y0, x1, y1)) = crate::ops_masks::coverage_bounds(cov) else {
        return None;
    };
    let (pw, ph) = (x1 - x0 + 1, y1 - y0 + 1);
    // Convergence needs iterations on the order of the region's span, so
    // cost grows roughly with span cubed. A blemish is tens of pixels
    // across and converges in moments; past a couple of megapixels the
    // flat mean shift is the honest answer.
    if pw * ph > 2_000_000 {
        return None;
    }

    // The problem over the bbox plus a one-pixel ring: the destination,
    // the sampled source and which pixels are inside the stroke and on
    // the photograph. The update reads source gradients to every
    // neighbor, and sampling once up front keeps the iteration loop to
    // plain array math. Alpha marks validity: off-frame samples take a
    // zero gradient, which turns the solve into a smooth membrane toward
    // the boundary there rather than punching a hole.
    let (sw, sh) = (pw + 2, ph + 2);
    let mut level = HealLevel {
        w: pw,
        h: ph,
        inside: vec![false; sw * sh],
        frame: vec![false; sw * sh],
        d: vec![0.0f32; sw * sh * 3],
        s: vec![0.0f32; sw * sh * 3],
        sv: vec![false; sw * sh],
    };
    for y in 0..sh {
        for x in 0..sw {
            let k = y * sw + x;
            let (gx, gy) = ((x0 + x) as isize - 1, (y0 + y) as isize - 1);
            if gx >= 0 && gy >= 0 && gx < w as isize && gy < h as isize {
                let (gx, gy) = (gx as usize, gy as usize);
                level.frame[k] = true;
                let inner = x >= 1 && y >= 1 && x <= pw && y <= ph;
                // The solve's region is the stroke's footprint, pixels
                // whose centers lie within its radius, the same region at
                // every size (ops_masks.rs stroke_footprint). A rim pixel
                // the stroke only grazes keeps its own tone, the solve's
                // at its boundary; taken by any coverage at all, a soft
                // heal's region grew by most of a pixel at Fit and by a
                // quarter as much in the export.
                level.inside[k] = inner && footprint.data[gy * w + gx] > 0.5;
                let d = src.pixel(gx, gy);
                level.d[k * 3..k * 3 + 3].copy_from_slice(&d[..3]);
            }
            // The ring's samples as they always were (an edge pixel's
            // neighbor off the frame reads the edge's own sample, unused:
            // that neighbor is never visited).
            let gx = (x0 + x).saturating_sub(1);
            let gy = (y0 + y).saturating_sub(1);
            let (sx, sy) = win.read_at(gx, gy, off);
            let s = sample(src, sx, sy);
            if s[3] > 0.0 {
                level.s[k * 3..k * 3 + 3].copy_from_slice(&s[..3]);
                level.sv[k] = true;
            }
        }
    }
    let solved = level.solve();
    let mut v = vec![0.0f32; pw * ph * 3];
    for y in 0..ph {
        for x in 0..pw {
            let k = ((y + 1) * sw + x + 1) * 3;
            let i = (y * pw + x) * 3;
            for c in 0..3 {
                v[i + c] = solved[k + c].clamp(0.0, 1.0);
            }
        }
    }
    Some((v, x0, y0, pw, ph))
}

/// A heal wider or taller than this many pixels starts from the same
/// problem solved at half the size, carried up (HealLevel::solve).
const HEAL_COARSE_SPAN: usize = 48;

/// One size of the heal's problem: a box `w` by `h` with a one-pixel
/// ring, every array row-major over (w + 2) by (h + 2). `inside` is the
/// stroke (never on the ring), `frame` whether the pixel is on the
/// photograph, `d` the destination's color, `s` and `sv` the source's
/// sampled color and whether it could be read.
struct HealLevel {
    w: usize,
    h: usize,
    inside: Vec<bool>,
    frame: Vec<bool>,
    d: Vec<f32>,
    s: Vec<f32>,
    sv: Vec<bool>,
}

impl HealLevel {
    /// The same problem at half the size: each cell the mean of the
    /// (up to) four pixels it covers on the photograph, inside where any
    /// of them is, the source read where any of them reads.
    fn coarse(&self) -> HealLevel {
        let (pw, ph) = (self.w + 2, self.h + 2);
        let (cw, ch) = (self.w.div_ceil(2), self.h.div_ceil(2));
        let (qw, qh) = (cw + 2, ch + 2);
        let mut c = HealLevel {
            w: cw,
            h: ch,
            inside: vec![false; qw * qh],
            frame: vec![false; qw * qh],
            d: vec![0.0; qw * qh * 3],
            s: vec![0.0; qw * qh * 3],
            sv: vec![false; qw * qh],
        };
        for j in 0..qh {
            for i in 0..qw {
                let (mut nf, mut ns, mut inside) = (0f32, 0f32, false);
                let (mut d, mut s) = ([0.0f32; 3], [0.0f32; 3]);
                // Coarse box cell i - 1 holds fine box pixels 2(i - 1)
                // and 2(i - 1) + 1: padded 2i - 1 and 2i.
                for fj in [2 * j as isize - 1, 2 * j as isize] {
                    for fi in [2 * i as isize - 1, 2 * i as isize] {
                        if fi < 0 || fj < 0 || fi >= pw as isize || fj >= ph as isize {
                            continue;
                        }
                        let k = fj as usize * pw + fi as usize;
                        if !self.frame[k] {
                            continue;
                        }
                        nf += 1.0;
                        inside |= self.inside[k];
                        for ch in 0..3 {
                            d[ch] += self.d[k * 3 + ch];
                        }
                        if self.sv[k] {
                            ns += 1.0;
                            for ch in 0..3 {
                                s[ch] += self.s[k * 3 + ch];
                            }
                        }
                    }
                }
                let q = j * qw + i;
                let ring = i == 0 || j == 0 || i == qw - 1 || j == qh - 1;
                c.frame[q] = nf > 0.0;
                c.inside[q] = inside && !ring;
                for ch in 0..3 {
                    c.d[q * 3 + ch] = if nf > 0.0 { d[ch] / nf } else { 0.0 };
                    c.s[q * 3 + ch] = if ns > 0.0 { s[ch] / ns } else { 0.0 };
                }
                c.sv[q] = ns > 0.0;
            }
        }
        c
    }

    /// The colors inside: the padded array, the destination everywhere
    /// outside the stroke.
    ///
    /// A small stroke: successive over-relaxation from the destination,
    /// already the right answer at the boundary, so the iterations only
    /// have to carry it inward, as it always was.
    ///
    /// A large one would not get there that way: Gauss-Seidel carries a
    /// correction about a pixel a sweep, so a stroke hundreds of pixels
    /// across stopped at the iteration ceiling with its middle still far
    /// from the answer, and the same heal drawn at a quarter of the size
    /// (Fit), converged, showed another picture than the export (the
    /// canyon check, 2026-10-01: 0.17 off the export reduced, a 400 pixel
    /// heal on a 24 megapixel photograph). So a large stroke starts from
    /// its own problem solved at half the size, carried up (the source's
    /// texture plus the coarse solve's smooth correction to it), then
    /// conjugate gradients with a multigrid cycle for each step settle
    /// what is left, every wavelength at the size that settles it in a
    /// few sweeps, until the equations hold to the arithmetic's floor:
    /// every size lands on the same solve, and the 1:1 slice, whose
    /// stroke is the export's to a millionth of a pixel, on the export's.
    fn solve(&self) -> Vec<f32> {
        let mut v = self.d.clone();
        if self.w.max(self.h) <= HEAL_COARSE_SPAN {
            self.relax(&mut v);
            return v;
        }
        let pw = self.w + 2;
        let c = self.coarse();
        let vc = c.solve();
        let qw = c.w + 2;
        // Bilinear over the coarse cells that count (on the frame, or
        // reading the source), weights renormalized.
        let lerp = |arr: &[f32], ok: &[bool], fx: f32, fy: f32| -> Option<[f32; 3]> {
            let (x0, y0) = (fx.floor(), fy.floor());
            let (tx, ty) = (fx - x0, fy - y0);
            let (mut acc, mut wsum) = ([0.0f32; 3], 0.0f32);
            for (dx, dy, wt) in [(0, 0, (1.0 - tx) * (1.0 - ty)), (1, 0, tx * (1.0 - ty)), (0, 1, (1.0 - tx) * ty), (1, 1, tx * ty)] {
                let (x, y) = (x0 as isize + dx, y0 as isize + dy);
                if x < 0 || y < 0 || x >= qw as isize || y >= (c.h + 2) as isize || wt <= 0.0 {
                    continue;
                }
                let q = y as usize * qw + x as usize;
                if !ok[q] {
                    continue;
                }
                for ch in 0..3 {
                    acc[ch] += wt * arr[q * 3 + ch];
                }
                wsum += wt;
            }
            (wsum > 1e-6).then(|| acc.map(|a| a / wsum))
        };
        for y in 1..=self.h {
            for x in 1..=self.w {
                let k = y * pw + x;
                if !self.inside[k] {
                    continue;
                }
                // Fine box pixel x - 1's center in the coarse box is
                // (x - 1 + 0.5) / 2 - 0.5; padded, one more.
                let (fx, fy) = ((x as f32 - 0.5) * 0.5 + 0.5, (y as f32 - 0.5) * 0.5 + 0.5);
                let Some(u) = lerp(&vc, &c.frame, fx, fy) else { continue };
                let start = match (self.sv[k], lerp(&c.s, &c.sv, fx, fy)) {
                    (true, Some(cs)) => [0, 1, 2].map(|ch| self.s[k * 3 + ch] + u[ch] - cs[ch]),
                    _ => u,
                };
                v[k * 3..k * 3 + 3].copy_from_slice(&start);
            }
        }
        // The multigrid's grids: this one's shape, then halves down to a
        // span the plain iteration settles outright.
        let mut grids = vec![Grid::of(self)];
        let mut level = c;
        loop {
            grids.push(Grid::of(&level));
            if level.w.max(level.h) <= HEAL_COARSEST_SPAN {
                break;
            }
            level = level.coarse();
        }
        // Settled: no pixel off its equation by more than this per
        // neighbor. In double precision, so the solve lands on the
        // equations' own answer rather than wherever the arithmetic's
        // floor left it: the 1:1 slice, whose stroke differs from the
        // export's by the last bits of a float, then heals what the
        // export heals. The canyon's 400 by 640 heal gets there in about
        // twenty-five steps.
        const SETTLED: f64 = 1e-9;
        const MAX_STEPS: usize = 200;
        let mut x: Vec<f64> = v.iter().map(|&c| c as f64).collect();
        grids[0].cg(&mut x, &self.rhs(), SETTLED, MAX_STEPS, &grids);
        for (o, c) in v.iter_mut().zip(&x) {
            *o = *c as f32;
        }
        v
    }

    /// The equations' right side for a large stroke's cycles: at each
    /// pixel inside, the source's gradients to its neighbors on the frame
    /// and the destination of each neighbor outside the stroke. The
    /// pixel's color times its neighbor count, less its neighbors' inside
    /// the stroke, is this.
    fn rhs(&self) -> Vec<f64> {
        let pw = self.w + 2;
        let mut b = vec![0.0f64; self.d.len()];
        for y in 1..=self.h {
            for x in 1..=self.w {
                let k = y * pw + x;
                if !self.inside[k] {
                    continue;
                }
                for q in [k + 1, k - 1, k + pw, k - pw] {
                    if !self.frame[q] {
                        continue;
                    }
                    for ch in 0..3 {
                        let grad = if self.sv[k] && self.sv[q] { self.s[k * 3 + ch] as f64 - self.s[q * 3 + ch] as f64 } else { 0.0 };
                        b[k * 3 + ch] += grad + if self.inside[q] { 0.0 } else { self.d[q * 3 + ch] as f64 };
                    }
                }
            }
        }
        b
    }

    /// Successive over-relaxation from `v`: ω just under 2 converges a
    /// small region in a few hundred passes; the ceiling keeps a
    /// pathological stroke from holding the render hostage.
    fn relax(&self, v: &mut [f32]) {
        const OMEGA: f32 = 1.9;
        const MAX_ITERS: usize = 600;
        const EPS: f32 = 5e-4;
        let pw = self.w + 2;
        for _ in 0..MAX_ITERS {
            let mut delta = 0.0f32;
            for y in 1..=self.h {
                for x in 1..=self.w {
                    let k = y * pw + x;
                    if !self.inside[k] {
                        continue;
                    }
                    let mut target = [0.0f32; 3];
                    let mut n = 0usize;
                    for q in [k + 1, k - 1, k + pw, k - pw] {
                        // A neighbor beyond the frame contributes nothing
                        // and shrinks the divisor: the photograph's edge
                        // is a free boundary, not a color.
                        if !self.frame[q] {
                            continue;
                        }
                        n += 1;
                        // The source gradient across this edge; zero when
                        // either side cannot be read. A neighbor outside
                        // the stroke holds the destination in v.
                        for ch in 0..3 {
                            let grad = if self.sv[k] && self.sv[q] { self.s[k * 3 + ch] - self.s[q * 3 + ch] } else { 0.0 };
                            target[ch] += v[q * 3 + ch] + grad;
                        }
                    }
                    if n == 0 {
                        continue;
                    }
                    for ch in 0..3 {
                        let t = target[ch] / n as f32;
                        let old = v[k * 3 + ch];
                        let new = old + OMEGA * (t - old);
                        delta = delta.max((new - old).abs());
                        v[k * 3 + ch] = new;
                    }
                }
            }
            if delta < EPS {
                break;
            }
        }
    }
}

/// The coarsest grid of a heal's multigrid: settled outright there.
const HEAL_COARSEST_SPAN: usize = 16;

/// One grid of a heal's multigrid: which pixels are unknowns
/// (inside the stroke) and how many neighbors on the photograph each
/// has, padded as HealLevel is. The equation at an unknown: its value
/// times that count, less its neighbors that are unknowns, is the right
/// side.
struct Grid {
    w: usize,
    h: usize,
    inside: Vec<bool>,
    n: Vec<f32>,
}

impl Grid {
    fn of(level: &HealLevel) -> Grid {
        let pw = level.w + 2;
        let mut n = vec![0.0f32; level.inside.len()];
        for y in 1..=level.h {
            for x in 1..=level.w {
                let k = y * pw + x;
                if level.inside[k] {
                    n[k] = [k + 1, k - 1, k + pw, k - pw].iter().filter(|&&q| level.frame[q]).count() as f32;
                }
            }
        }
        Grid { w: level.w, h: level.h, inside: level.inside.clone(), n }
    }

    fn neighbors(&self, x: &[f64], k: usize, ch: usize) -> f64 {
        let pw = self.w + 2;
        let mut s = 0.0;
        for q in [k + 1, k - 1, k + pw, k - pw] {
            if self.inside[q] {
                s += x[q * 3 + ch];
            }
        }
        s
    }

    /// Gauss-Seidel sweeps.
    fn smooth(&self, x: &mut [f64], f: &[f64], sweeps: usize) {
        let pw = self.w + 2;
        for _ in 0..sweeps {
            for y in 1..=self.h {
                for xx in 1..=self.w {
                    let k = y * pw + xx;
                    if !self.inside[k] || self.n[k] == 0.0 {
                        continue;
                    }
                    for ch in 0..3 {
                        x[k * 3 + ch] = (self.neighbors(x, k, ch) + f[k * 3 + ch]) / self.n[k] as f64;
                    }
                }
            }
        }
    }

    /// Gauss-Seidel sweeps in the reverse order: after `smooth`, the two
    /// make a symmetric pass.
    fn smooth_back(&self, x: &mut [f64], f: &[f64], sweeps: usize) {
        let pw = self.w + 2;
        for _ in 0..sweeps {
            for y in (1..=self.h).rev() {
                for xx in (1..=self.w).rev() {
                    let k = y * pw + xx;
                    if !self.inside[k] || self.n[k] == 0.0 {
                        continue;
                    }
                    for ch in 0..3 {
                        x[k * 3 + ch] = (self.neighbors(x, k, ch) + f[k * 3 + ch]) / self.n[k] as f64;
                    }
                }
            }
        }
    }

    /// The right side less what `x` makes of the equations, at every
    /// unknown.
    fn residual(&self, x: &[f64], f: &[f64]) -> Vec<f64> {
        let pw = self.w + 2;
        let mut r = vec![0.0f64; x.len()];
        for y in 1..=self.h {
            for xx in 1..=self.w {
                let k = y * pw + xx;
                if !self.inside[k] {
                    continue;
                }
                for ch in 0..3 {
                    r[k * 3 + ch] = f[k * 3 + ch] - (self.n[k] as f64 * x[k * 3 + ch] - self.neighbors(x, k, ch));
                }
            }
        }
        r
    }

    /// Conjugate gradients from `x`, each step preconditioned by one
    /// symmetric multigrid cycle over `grids` (this grid first), until no
    /// pixel is off its equation by more than `tol` per neighbor, or
    /// `max` steps. Each step lowers the error's energy, whatever the
    /// stroke's shape.
    fn cg(&self, x: &mut [f64], f: &[f64], tol: f64, max: usize, grids: &[Grid]) {
        let len = x.len();
        let zero = vec![0.0f64; len];
        let mut r = self.residual(x, f);
        let precond = |r: &[f64]| -> Vec<f64> {
            let mut z = vec![0.0f64; len];
            vcycle(grids, 0, &mut z, r);
            z
        };
        let worst = |r: &[f64]| -> f64 {
            let mut w = 0.0f64;
            for (k, &n) in self.n.iter().enumerate() {
                if self.inside[k] && n > 0.0 {
                    for ch in 0..3 {
                        w = w.max(r[k * 3 + ch].abs() / n as f64);
                    }
                }
            }
            w
        };
        let dot = |a: &[f64], b: &[f64]| a.iter().zip(b).map(|(p, q)| p * q).sum::<f64>();
        let mut z = precond(&r);
        let mut p = z.clone();
        let mut rz = dot(&r, &z);
        for _ in 0..max {
            if worst(&r) < tol {
                return;
            }
            // A p is minus the residual of p against nothing.
            let ap: Vec<f64> = self.residual(&p, &zero).iter().map(|v| -v).collect();
            let pap = dot(&p, &ap);
            if pap <= 0.0 {
                return;
            }
            let alpha = rz / pap;
            for k in 0..len {
                x[k] += alpha * p[k];
                r[k] -= alpha * ap[k];
            }
            z = precond(&r);
            let rz_new = dot(&r, &z);
            let beta = rz_new / rz;
            rz = rz_new;
            for k in 0..len {
                p[k] = z[k] + beta * p[k];
            }
        }
    }
}

/// The preconditioner's V-cycle on grid `i`, from `x` (zero): a forward
/// sweep, the residual summed into each coarse cell, the coarse
/// correction solved the same way and handed to each of the cell's
/// pixels, a backward sweep. Restriction and prolongation are each
/// other's transpose and the sweeps mirror, so the cycle is symmetric,
/// as conjugate gradients need.
fn vcycle(grids: &[Grid], i: usize, x: &mut [f64], f: &[f64]) {
    let g = &grids[i];
    if i + 1 == grids.len() {
        for _ in 0..20 {
            g.smooth(x, f, 1);
            g.smooth_back(x, f, 1);
        }
        return;
    }
    let nu = 2;
    g.smooth(x, f, nu);
    let r = g.residual(x, f);
    let c = &grids[i + 1];
    let (pw, qw) = (g.w + 2, c.w + 2);
    let parent = |y: usize, xx: usize| (y + 1) / 2 * qw + (xx + 1) / 2;
    let mut fc = vec![0.0f64; c.inside.len() * 3];
    for y in 1..=g.h {
        for xx in 1..=g.w {
            let k = y * pw + xx;
            if g.inside[k] {
                let q = parent(y, xx);
                for ch in 0..3 {
                    fc[q * 3 + ch] += r[k * 3 + ch];
                }
            }
        }
    }
    let mut ec = vec![0.0f64; fc.len()];
    vcycle(grids, i + 1, &mut ec, &fc);
    for y in 1..=g.h {
        for xx in 1..=g.w {
            let k = y * pw + xx;
            if g.inside[k] {
                let q = parent(y, xx);
                for ch in 0..3 {
                    x[k * 3 + ch] += ec[q * 3 + ch];
                }
            }
        }
    }
    g.smooth_back(x, f, nu);
}

/// A solid color the size of its input. Opacity, blend mode and the
/// mask belong to the layer, which is why this has none of them: a fill
/// layer is a color and a mask, and the mask is where the work is.
pub(crate) fn fill(node: &Node, inputs: &[(String, Value)]) -> Result<Value, EngineError> {
    let src = image_input(inputs, "in", &node.id)?;
    let color = node
        .params
        .get("color")
        .and_then(|v| v.as_str())
        .and_then(parse_hex_display)
        .unwrap_or([0.0, 0.0, 0.0]);
    let mut out = ImageBuf::new(src.width, src.height);
    // PERF: the fill ran serially; every pixel writes the same four
    // constants, so parallel chunks are bit for bit.
    use rayon::prelude::*;
    out.data.par_chunks_mut(4).for_each(|px| {
        px[..3].copy_from_slice(&color);
        px[3] = 1.0;
    });
    Ok(Value::Image(Arc::new(out)))
}

/// One stop of a gradient: where it sits, what color it is, how opaque,
/// and where the blend to the NEXT stop reaches its halfway point.
#[derive(serde::Deserialize, Clone)]
pub(crate) struct Stop {
    /// 0..100 along the gradient
    pub pos: f32,
    pub color: String,
    #[serde(default = "full")]
    pub alpha: f32,
    /// 0..100; 50 is an even blend to the next stop, lower pulls the
    /// halfway point toward this one. Layer editors draw this as the little
    /// diamond between two stops, and it is the difference between a
    /// gradient that looks right and one that does not.
    #[serde(default = "half")]
    pub mid: f32,
}

fn full() -> f32 {
    100.0
}
fn half() -> f32 {
    50.0
}

/// The stops a gradient node carries: its own list when it has one,
/// otherwise the two-color form built from color_a/color_b, so simple
/// mode and advanced mode are one code path with different data.
pub(crate) fn stops_of(node: &Node) -> Vec<Stop> {
    let raw = node.params.get("stops").and_then(|v| v.as_str()).unwrap_or("");
    if !raw.trim().is_empty() {
        if let Ok(mut list) = serde_json::from_str::<Vec<Stop>>(raw) {
            if list.len() >= 2 {
                list.sort_by(|a, b| a.pos.partial_cmp(&b.pos).unwrap_or(std::cmp::Ordering::Equal));
                return list;
            }
        }
    }
    let text =
        |k: &str, d: &str| node.params.get(k).and_then(|v| v.as_str()).unwrap_or(d).to_string();
    vec![
        Stop {
            pos: 0.0,
            color: text("color_a", "#000000"),
            alpha: p(&node.params, "alpha_a", 100.0),
            // Simple mode's one weighting control: where the blend between the two
            // colors reaches halfway. "could use a center weighting so
            // it is not always an even split".
            mid: p(&node.params, "midpoint", 50.0),
        },
        Stop {
            pos: 100.0,
            color: text("color_b", "#ffffff"),
            alpha: p(&node.params, "alpha_b", 100.0),
            mid: 50.0,
        },
    ]
}

/// A stop list with the hex strings and percentages already resolved.
///
/// parse_hex_display and the alpha clamp are pure functions of the
/// stop, so resolving them once up front yields exactly the values the
/// per-pixel parse produced, and sample() below keeps sample_stops'
/// arithmetic in its exact order: same early-outs, same span clamp,
/// same midpoint remap, same lerp.
pub(crate) struct ParsedStops {
    pos: Vec<f32>,
    rgb: Vec<[f32; 3]>,
    alpha: Vec<f32>,
    mid: Vec<f32>,
}

impl ParsedStops {
    pub(crate) fn new(stops: &[Stop]) -> ParsedStops {
        ParsedStops {
            pos: stops.iter().map(|s| s.pos).collect(),
            rgb: stops
                .iter()
                .map(|s| parse_hex_display(&s.color).unwrap_or([0.0, 0.0, 0.0]))
                .collect(),
            alpha: stops.iter().map(|s| (s.alpha / 100.0).clamp(0.0, 1.0)).collect(),
            mid: stops.iter().map(|s| s.mid).collect(),
        }
    }

    pub(crate) fn sample(&self, t: f32) -> ([f32; 3], f32) {
        let x = t * 100.0;
        let last = self.pos.len() - 1;
        if x <= self.pos[0] {
            return (self.rgb[0], self.alpha[0]);
        }
        if x >= self.pos[last] {
            return (self.rgb[last], self.alpha[last]);
        }
        // First span holding x wins, the same first-match walk the
        // windows(2) form made; the positions are sorted, so the match
        // is unique.
        for i in 0..last {
            let (ap, bp) = (self.pos[i], self.pos[i + 1]);
            if x < ap || x > bp {
                continue;
            }
            let span = (bp - ap).max(1e-6);
            let u = ((x - ap) / span).clamp(0.0, 1.0);
            // Move the halfway point: below the midpoint the first half
            // of the blend is stretched, above it the second half is.
            let m = (self.mid[i] / 100.0).clamp(0.05, 0.95);
            let k = if u <= m { 0.5 * u / m } else { 0.5 + 0.5 * (u - m) / (1.0 - m) };
            let (ca, cb) = (self.rgb[i], self.rgb[i + 1]);
            let (aa, ab) = (self.alpha[i], self.alpha[i + 1]);
            return (
                [
                    ca[0] + (cb[0] - ca[0]) * k,
                    ca[1] + (cb[1] - ca[1]) * k,
                    ca[2] + (cb[2] - ca[2]) * k,
                ],
                aa + (ab - aa) * k,
            );
        }
        (self.rgb[last], self.alpha[last])
    }
}

/// The frame-relative geometry of a gradient, hoisted out of the pixel
/// loop. Every field is a pure function of the node's params and the
/// buffer's size, and t() below reproduces the per-pixel expression
/// order exactly, so a render through this is bit for bit the render
/// that re-read the params per pixel.
pub(crate) struct GradientGeom {
    rx: f32,
    ry: f32,
    rw: f32,
    rh: f32,
    radial: bool,
    aspect: f32,
    sin: f32,
    cos: f32,
    span: f32,
}

impl GradientGeom {
    pub(crate) fn new(node: &Node, w: usize, h: usize, radial: bool, angle: f32) -> GradientGeom {
        let rx = p(&node.params, "roi_x", 0.0);
        let ry = p(&node.params, "roi_y", 0.0);
        let rw = p(&node.params, "roi_w", 1.0).max(1e-6);
        let rh = p(&node.params, "roi_h", 1.0).max(1e-6);
        // The frame's own aspect, so a 45-degree gradient runs corner to
        // corner rather than finishing early on the long side.
        let aspect = (w as f32 / rw) / (h as f32 / rh).max(1e-6);
        let (sin, cos) = angle.sin_cos();
        let span = cos.abs() * aspect + sin.abs();
        GradientGeom { rx, ry, rw, rh, radial, aspect, sin, cos, span }
    }

    /// Where a pixel sits along the gradient, 0..1.
    ///
    /// Measured against the FRAME rather than the buffer: at 1:1 the buffer
    /// is a patch of the photograph, and a gradient that restarted inside
    /// every patch would be a different picture at every zoom level. The
    /// roi params say which slice of the frame this buffer is.
    pub(crate) fn t(&self, x: usize, y: usize, w: usize, h: usize) -> f32 {
        let fx = self.rx + ((x as f32 + 0.5) / w as f32) * self.rw;
        let fy = self.ry + ((y as f32 + 0.5) / h as f32) * self.rh;
        if self.radial {
            let (dx, dy) = (fx - 0.5, fy - 0.5);
            return ((dx * dx + dy * dy).sqrt() / 0.5).clamp(0.0, 1.0);
        }
        let (px, py) = ((fx - 0.5) * self.aspect, fy - 0.5);
        ((px * self.cos + py * self.sin) / self.span.max(1e-6) + 0.5).clamp(0.0, 1.0)
    }
}

fn shape_is(node: &Node, shape: &str) -> bool {
    node.params
        .get("shape")
        .and_then(|v| v.as_str())
        .map(|s| s == shape)
        .unwrap_or(false)
}

fn is_radial(node: &Node) -> bool {
    shape_is(node, "radial")
}

/// Whether the gradient runs along the picture's tones rather than
/// across the frame: the "By tone" shape, which took over the Finish
/// Gradient Map adjustment (2026-09-30: "having a Gradient Map
/// adjustment layer is redundant with the Gradient layer").
pub(crate) fn is_by_tone(node: &Node) -> bool {
    shape_is(node, "tone")
}

/// A gradient, from two stops or from a list of them, linear or radial,
/// with alpha per stop so "color fading to nothing" is one node rather
/// than a color plus a mask. Angle is degrees clockwise.
///
/// By tone, the place along the stops is the brightness of the picture
/// arriving on "in" (the stack below, in a Finish layer) rather than
/// where the pixel sits: display-referred luma clamped to 0..1, the key
/// the Gradient Map node reads, so a Gradient Map layer converted to a
/// By tone Gradient layer renders the same picture. Every stop feature
/// (falloff, per-stop alpha) applies unchanged, and the frame geometry
/// (angle, the 1:1 slice) is not read at all.
pub(crate) fn gradient(node: &Node, inputs: &[(String, Value)]) -> Result<Value, EngineError> {
    let src = image_input(inputs, "in", &node.id)?;
    let stops = ParsedStops::new(&stops_of(node));
    if is_by_tone(node) {
        let w = src.width;
        let mut out = ImageBuf::new(w, src.height);
        use rayon::prelude::*;
        out.data.par_chunks_mut(w * 4).zip(src.data.par_chunks(w * 4)).for_each(|(row, inp)| {
            for x in 0..w {
                let i = x * 4;
                let t = crate::buffers::luma(inp[i], inp[i + 1], inp[i + 2]).clamp(0.0, 1.0);
                let (c, a) = stops.sample(t);
                row[i..i + 3].copy_from_slice(&c);
                row[i + 3] = a;
            }
        });
        return Ok(Value::Image(Arc::new(out)));
    }
    let radial = is_radial(node);
    let angle = p(&node.params, "angle", 0.0).to_radians();
    let (w, h) = (src.width, src.height);
    // PERF: this ran serially with four BTreeMap lookups, a sin_cos and
    // a hex-parse per stop inside the pixel loop; at frame size the
    // parameter reads dwarfed the gradient math. The geometry and the
    // stops are pure functions of the params, so hoisting them changes
    // no value, and each pixel's (t, color) is an independent pure
    // function of (x, y) plus the hoisted constants, so parallel rows
    // are bit for bit the serial loop, alpha written exactly as before.
    let geom = GradientGeom::new(node, w, h, radial, angle);
    let mut out = ImageBuf::new(w, h);
    use rayon::prelude::*;
    out.data.par_chunks_mut(w * 4).enumerate().for_each(|(y, row)| {
        for x in 0..w {
            let t = geom.t(x, y, w, h);
            let (c, a) = stops.sample(t);
            let i = x * 4;
            row[i..i + 3].copy_from_slice(&c);
            row[i + 3] = a;
        }
    });
    Ok(Value::Image(Arc::new(out)))
}

/// Gradient map: brightness decides color. Three stops (shadows,
/// midtones, highlights) rather than two, because two cannot do the
/// thing people actually reach for a gradient map to do, which is cool
/// shadows and warm highlights with the mids left alone.
///
/// Keyed on display-referred luma, since the art stack is
/// display-shaped and a gradient map is a look, not a physical model.
pub(crate) fn gradient_map(node: &Node, inputs: &[(String, Value)]) -> Result<Value, EngineError> {
    let src = image_input(inputs, "in", &node.id)?;
    let hex = |k: &str, fallback: [f32; 3]| {
        node.params
            .get(k)
            .and_then(|v| v.as_str())
            .and_then(parse_hex_display)
            .unwrap_or(fallback)
    };
    let lo = hex("color_lo", [0.0, 0.0, 0.0]);
    let mid = hex("color_mid", [0.5, 0.5, 0.5]);
    let hi = hex("color_hi", [1.0, 1.0, 1.0]);
    let pivot = p(&node.params, "midpoint", 50.0).clamp(1.0, 99.0) / 100.0;
    let amount = (p(&node.params, "amount", 100.0) / 100.0).clamp(0.0, 1.0);

    let out = crate::ops::map_rgb(src, |r, g, b| {
        let l = crate::buffers::luma(r, g, b).clamp(0.0, 1.0);
        let mapped = if l <= pivot {
            let t = l / pivot.max(1e-6);
            [
                lo[0] + (mid[0] - lo[0]) * t,
                lo[1] + (mid[1] - lo[1]) * t,
                lo[2] + (mid[2] - lo[2]) * t,
            ]
        } else {
            let t = (l - pivot) / (1.0 - pivot).max(1e-6);
            [
                mid[0] + (hi[0] - mid[0]) * t,
                mid[1] + (hi[1] - mid[1]) * t,
                mid[2] + (hi[2] - mid[2]) * t,
            ]
        };
        // Amount mixes back toward the original, so the node is useful
        // below full strength without needing the layer's opacity.
        [
            r + (mapped[0] - r) * amount,
            g + (mapped[1] - g) * amount,
            b + (mapped[2] - b) * amount,
        ]
    });
    Ok(Value::Image(Arc::new(out)))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ops::test_util::*;
    use heeler_graph::ParamValue;

    fn ramp(w: usize, h: usize) -> ImageBuf {
        // Left half dark, right half bright, so a clone from right to
        // left is visible and a heal's color match is measurable.
        let mut img = ImageBuf::new(w, h);
        for y in 0..h {
            for x in 0..w {
                let v = if x < w / 2 { 0.2 } else { 0.8 };
                img.set_pixel(x, y, [v, v, v, 1.0]);
            }
        }
        img
    }

    #[test]
    fn clone_copies_pixels_from_the_offset() {
        let mut node = make_node("heeler.clone");
        // Paint at the left edge, read from half a frame to the right.
        set_text(
            &mut node,
            "strokes",
            r#"[{"points":[[0.25,0.5]],"radius":0.1,"hardness":1.0,"flow":1.0,"src_dx":0.5,"src_dy":0.0}]"#,
        );
        let out = run_on(&node, ramp(64, 32)).unwrap();
        let img = out.as_image().unwrap();
        let px = img.pixel(16, 16);
        assert!(px[3] > 0.9, "the stroke laid something down");
        assert!((px[0] - 0.8).abs() < 0.02, "and it is the bright side, got {}", px[0]);
        // Outside the stroke the canvas stays transparent.
        assert_eq!(img.pixel(60, 2)[3], 0.0);
    }

    #[test]
    fn heal_takes_texture_from_the_source_and_tone_from_the_destination() {
        let mut node = make_node("heeler.clone");
        set_text(
            &mut node,
            "strokes",
            r#"[{"points":[[0.25,0.5]],"radius":0.1,"hardness":1.0,"flow":1.0,"src_dx":0.5,"src_dy":0.0}]"#,
        );
        node.params.insert("heal".into(), ParamValue::Bool(true));
        let out = run_on(&node, ramp(64, 32)).unwrap();
        let px = out.as_image().unwrap().pixel(16, 16);
        // Cloning would have dropped 0.8 here; healing matches the
        // destination's 0.2 while carrying the source's structure.
        assert!(
            (px[0] - 0.2).abs() < 0.03,
            "heal should land in the destination's tone, got {}",
            px[0]
        );
    }

    #[test]
    fn heal_matches_shading_all_the_way_around_the_stroke() {
        // The mean shift matched one average; a stroke across a light
        // gradient kept a single offset and its ends disagreed with the
        // ground they touched. The seamless solve takes the boundary
        // ring as the condition, so the interior RUNS with the gradient:
        // dark where the surround is dark, bright where it is bright.
        //
        // Bottom half of the frame is a left-to-right ramp, top half is
        // flat mid-gray; the stroke sits in the ramp and reads from the
        // flat half, so the source brings no gradient of its own and
        // every interior value is the destination's shading showing
        // through the repair.
        let mut img = ImageBuf::new(64, 64);
        for y in 0..64 {
            for x in 0..64 {
                let v = if y < 32 { 0.5 } else { x as f32 / 63.0 };
                img.set_pixel(x, y, [v, v, v, 1.0]);
            }
        }
        let mut node = make_node("heeler.clone");
        set_text(
            &mut node,
            "strokes",
            r#"[{"points":[[0.5,0.75]],"radius":0.15,"hardness":1.0,"flow":1.0,"src_dx":0.0,"src_dy":-0.5,"heal":true}]"#,
        );
        let out = run_on(&node, img).unwrap();
        let out = out.as_image().unwrap();
        // Interior of the stroke, near its left and right edges. The
        // ramp reads 24/63 ≈ 0.38 and 39/63 ≈ 0.62 at these columns;
        // a flat offset would have painted both ends with one tone
        // (0.5) and this test reads the seam.
        let left = out.pixel(25, 48);
        let right = out.pixel(39, 48);
        assert!(left[3] > 0.9 && right[3] > 0.9, "the stroke laid something down");
        assert!(
            left[0] < 0.45,
            "the shadowed end should stay shadowed, got {}",
            left[0]
        );
        assert!(
            right[0] > 0.55,
            "the lit end should stay lit, got {}",
            right[0]
        );
    }

    #[test]
    fn heal_carries_the_sources_texture_into_the_destinations_tone() {
        // A smooth repair is not a flat one: the source's grain has to
        // survive the tone match, or skin repairs read as plastic.
        // Top half is a checker around mid-gray, bottom half flat dark.
        let mut img = ImageBuf::new(64, 64);
        for y in 0..64 {
            for x in 0..64 {
                let v = if y < 32 {
                    if (x + y) % 2 == 0 {
                        0.58
                    } else {
                        0.42
                    }
                } else {
                    0.2
                };
                img.set_pixel(x, y, [v, v, v, 1.0]);
            }
        }
        let mut node = make_node("heeler.clone");
        set_text(
            &mut node,
            "strokes",
            r#"[{"points":[[0.5,0.75]],"radius":0.15,"hardness":1.0,"flow":1.0,"src_dx":0.0,"src_dy":-0.5,"heal":true}]"#,
        );
        let out = run_on(&node, img).unwrap();
        let out = out.as_image().unwrap();
        let mut lo = 1.0f32;
        let mut hi = 0.0f32;
        let mut sum = 0.0f32;
        let mut n = 0usize;
        for y in 42..54 {
            for x in 26..38 {
                let p = out.pixel(x, y);
                if p[3] > 0.9 {
                    lo = lo.min(p[0]);
                    hi = hi.max(p[0]);
                    sum += p[0];
                    n += 1;
                }
            }
        }
        assert!(n > 0, "the stroke laid something down");
        assert!(
            hi - lo > 0.05,
            "the checker's texture should survive the heal, range {}",
            hi - lo
        );
        let mean = sum / n as f32;
        assert!(
            (mean - 0.2).abs() < 0.04,
            "and it should sit in the destination's tone, mean {}",
            mean
        );
    }

    #[test]
    fn a_heal_stroke_with_no_source_lays_nothing_down() {
        // Heal used to fall through to content-aware fill when nobody
        // picked a source. That was removed: exemplar synthesis never
        // came close to what a layer editor does, and a repair tool is not
        // worth shipping at "technically present". The interface refuses
        // the stroke, and the engine lays nothing down if one arrives
        // anyway, rather than smearing something across the frame.
        let mut node = make_node("heeler.paint");
        set_text(
            &mut node,
            "strokes",
            r##"[{"points":[[0.5,0.5]],"radius":0.06,"hardness":1.0,"flow":1.0,"heal":true}]"##,
        );
        let out = run_on(&node, ramp(64, 64)).unwrap();
        let img = out.as_image().unwrap();
        assert_eq!(
            img.pixel(32, 32)[3],
            0.0,
            "a sourceless heal put something on the canvas"
        );
    }

    #[test]
    fn one_layer_takes_paint_and_repair_strokes_together() {
        // The merge, in one node: a stroke with an offset reads from
        // the picture, a stroke without one lays down its color, and
        // they stack in the order they were made.
        let mut node = make_node("heeler.paint");
        set_text(
            &mut node,
            "strokes",
            concat!(
                r##"[{"points":[[0.25,0.25]],"radius":0.08,"hardness":1.0,"flow":1.0,"color":"#ff0000"},"##,
                r##"{"points":[[0.25,0.75]],"radius":0.08,"hardness":1.0,"flow":1.0,"src_dx":0.5,"src_dy":0.0}]"##
            ),
        );
        let out = run_on(&node, ramp(64, 64)).unwrap();
        let img = out.as_image().unwrap();
        let painted = img.pixel(16, 16);
        assert!(painted[0] > 0.9 && painted[1] < 0.1, "the color stroke is red");
        let cloned = img.pixel(16, 48);
        assert!(
            (cloned[0] - 0.8).abs() < 0.05 && (cloned[0] - cloned[1]).abs() < 0.02,
            "the repair stroke carries the bright side over, got {cloned:?}"
        );
    }

    #[test]
    fn clone_on_a_patch_lands_where_it_would_on_the_full_frame() {
        let strokes = r#"[{"points":[[0.4,0.5]],"radius":0.08,"hardness":1.0,"flow":1.0,"src_dx":0.3,"src_dy":0.0}]"#;
        let mut full = make_node("heeler.clone");
        set_text(&mut full, "strokes", strokes);
        let full_out = run_on(&full, ramp(64, 32)).unwrap();
        let full_img = full_out.as_image().unwrap().clone();

        // The same stroke through a half-size patch of the same scene.
        let mut patch = make_node("heeler.clone");
        set_text(&mut patch, "strokes", strokes);
        for (k, v) in [("roi_x", 0.25), ("roi_y", 0.25), ("roi_w", 0.5), ("roi_h", 0.5)] {
            patch.params.insert(k.into(), ParamValue::Number(v));
        }
        let mut src = ImageBuf::new(32, 16);
        for y in 0..16 {
            for x in 0..32 {
                // The middle half of the same ramp.
                let fx = 16 + x;
                let v = if fx < 32 { 0.2 } else { 0.8 };
                src.set_pixel(x, y, [v, v, v, 1.0]);
            }
        }
        let patch_out = run_on(&patch, src).unwrap();
        let patch_img = patch_out.as_image().unwrap();
        // Frame pixel (26,16) is patch pixel (10,8): both should carry
        // the same repair.
        assert!((patch_img.pixel(10, 8)[0] - full_img.pixel(26, 16)[0]).abs() < 0.02);
        assert!((patch_img.pixel(10, 8)[3] - full_img.pixel(26, 16)[3]).abs() < 0.02);
    }

    #[test]
    fn a_gradient_map_colours_by_brightness_through_three_stops() {
        let mut node = make_node("heeler.gradient_map");
        // Cool shadows, neutral mids, warm highlights: the split-tone
        // look a two-stop map cannot express.
        set_text(&mut node, "color_lo", "#0000ff");
        set_text(&mut node, "color_mid", "#808080");
        set_text(&mut node, "color_hi", "#ff0000");
        let mut img = ImageBuf::new(3, 1);
        img.set_pixel(0, 0, [0.0, 0.0, 0.0, 1.0]);
        img.set_pixel(1, 0, [0.5, 0.5, 0.5, 1.0]);
        img.set_pixel(2, 0, [1.0, 1.0, 1.0, 1.0]);
        let out = run_on(&node, img).unwrap();
        let img = out.as_image().unwrap();
        assert!(img.pixel(0, 0)[2] > 0.9 && img.pixel(0, 0)[0] < 0.1, "black went blue");
        assert!(img.pixel(2, 0)[0] > 0.9 && img.pixel(2, 0)[2] < 0.1, "white went red");
        let midv = img.pixel(1, 0);
        assert!((midv[0] - midv[2]).abs() < 0.05, "mid stayed neutral, got {midv:?}");
    }

    #[test]
    fn a_gradient_map_at_zero_amount_is_the_picture_it_was_given() {
        let mut node = make_node("heeler.gradient_map");
        set_text(&mut node, "color_lo", "#00ff00");
        node.params.insert("amount".into(), ParamValue::Number(0.0));
        let out = run_on(&node, ImageBuf::filled(2, 2, [0.3, 0.4, 0.5, 1.0])).unwrap();
        let px = out.as_image().unwrap().pixel(1, 1);
        assert!((px[0] - 0.3).abs() < 1e-5 && (px[2] - 0.5).abs() < 1e-5);
    }

    #[test]
    fn fill_is_the_colour_it_was_given() {
        let mut node = make_node("heeler.fill");
        set_text(&mut node, "color", "#3366cc");
        let out = run_on(&node, ImageBuf::filled(4, 4, [0.0, 0.0, 0.0, 1.0])).unwrap();
        let px = out.as_image().unwrap().pixel(2, 2);
        assert!((px[0] - 0x33 as f32 / 255.0).abs() < 1e-3);
        assert!((px[2] - 0xcc as f32 / 255.0).abs() < 1e-3);
        assert_eq!(px[3], 1.0);
    }

    #[test]
    fn a_gradient_runs_between_its_stops_and_can_fade_out() {
        let mut node = make_node("heeler.gradient");
        set_text(&mut node, "color_a", "#000000");
        set_text(&mut node, "color_b", "#ffffff");
        node.params.insert("alpha_a".into(), ParamValue::Number(100.0));
        node.params.insert("alpha_b".into(), ParamValue::Number(0.0));
        let out = run_on(&node, ImageBuf::filled(32, 8, [0.0, 0.0, 0.0, 1.0])).unwrap();
        let img = out.as_image().unwrap();
        assert!(img.pixel(0, 4)[0] < 0.1, "dark stop on the left");
        assert!(img.pixel(31, 4)[0] > 0.9, "bright stop on the right");
        assert!(img.pixel(0, 4)[3] > 0.9, "opaque where alpha_a is");
        assert!(img.pixel(31, 4)[3] < 0.1, "faded out where alpha_b is");
        // Radial reads from the middle out instead.
        set_text(&mut node, "shape", "radial");
        let out = run_on(&node, ImageBuf::filled(32, 32, [0.0, 0.0, 0.0, 1.0])).unwrap();
        let img = out.as_image().unwrap();
        assert!(img.pixel(16, 16)[0] < 0.1, "center is the first stop");
        assert!(img.pixel(0, 0)[0] > 0.7, "corners are the second");
    }

    /// A stroke painted inside a selection keeps to it on the 1:1 patch
    /// as in the export: the selection is laid on the patch's own pixels
    /// of the frame. It was laid on the patch as if the patch were the
    /// frame, so at 1:1 the stroke was clipped to the selection squeezed
    /// into the view.
    #[test]
    fn a_clipped_stroke_on_a_patch_is_the_export_cropped() {
        let (w, h) = (1003usize, 1501usize);
        let full = ImageBuf::filled(w, h, [0.3, 0.4, 0.5, 1.0]);
        let clip = r#"[{"kind":"marquee","op":"add","shape":"ellipse","x0":0.3,"y0":0.4,"x1":0.6,"y1":0.7},{"kind":"marquee","op":"subtract","shape":"rect","x0":0.42,"y0":0.5,"x1":0.5,"y1":0.6}]"#;
        let strokes = serde_json::json!([{"points": [[0.2, 0.55], [0.7, 0.56]], "radius": 0.06, "hardness": 0.9, "flow": 1, "color": "#cc3366", "clip": clip}]).to_string();
        let mut node = make_node("heeler.paint");
        set_text(&mut node, "strokes", &strokes);
        let export = run_on(&node, full.clone()).unwrap().as_image().unwrap().as_ref().clone();
        let (px, py, pw, ph) = (197usize, 501usize, 611usize, 700usize);
        let mut patch = ImageBuf::new(pw, ph);
        for y in 0..ph {
            for x in 0..pw {
                patch.set_pixel(x, y, full.pixel(px + x, py + y));
            }
        }
        let mut sliced = make_node("heeler.paint");
        set_text(&mut sliced, "strokes", &strokes);
        for (k, v) in [("roi_x", px as f64 / w as f64), ("roi_y", py as f64 / h as f64), ("roi_w", pw as f64 / w as f64), ("roi_h", ph as f64 / h as f64)] {
            sliced.params.insert(k.into(), ParamValue::Number(v));
        }
        let got = run_on(&sliced, patch).unwrap().as_image().unwrap().as_ref().clone();
        let mut worst = (0.0f32, 0, 0);
        for y in 0..ph {
            for x in 0..pw {
                for c in 0..4 {
                    let d = (got.pixel(x, y)[c] - export.pixel(px + x, py + y)[c]).abs();
                    if d > worst.0 {
                        worst = (d, px + x, py + y);
                    }
                }
            }
        }
        assert!(worst.0 <= 1e-5, "the clipped stroke on the patch is {} off the export at {:?}", worst.0, (worst.1, worst.2));
    }

    /// The 1:1 slice renders a Pixel layer's strokes on a patch of the
    /// frame (roi params, the patch whole pixels of the frame) and must
    /// be the export cropped, to the bit: a heal across the patch's
    /// left edge, a clone reading far outside it, paint and a blur
    /// crossing its edges, and a textured tip whose grain is anchored to
    /// the frame. Mapped through the rect's fractions, the stroke's
    /// points, its source and the pixels' centers came out a few float
    /// bits off the export's, and the heal's solve carried that inward:
    /// 9.4e-5 off on the canyon RAW (canyon_checks.rs), and the grain of
    /// a textured tip restarted at the patch's corner.
    #[test]
    fn repair_strokes_on_a_patch_are_the_export_cropped() {
        let (w, h) = (1003usize, 1501usize);
        let mut full = ImageBuf::new(w, h);
        for y in 0..h {
            for x in 0..w {
                let (fx, fy) = ((x as f32 + 0.5) / w as f32, (y as f32 + 0.5) / h as f32);
                let t = (fx * 97.0).sin() * (fy * 61.0).cos() + 0.5 * ((x * 7 + y * 13) % 11) as f32 / 11.0;
                let v = 0.25 + 0.1 * t + 0.2 * fx + 0.3 * fy;
                full.set_pixel(x, y, [v, v * 0.9, v * 0.8, 1.0]);
            }
        }
        let strokes = r##"[
            {"points": [[0.45, 0.66]], "radius": 0.04, "hardness": 0.8, "flow": 1, "src_dx": 0.3, "src_dy": -0.25},
            {"points": [[0.3, 0.62], [0.3, 0.66]], "radius": 0.05, "hardness": 0.8, "flow": 1, "src_dx": -0.2, "src_dy": 0.15, "heal": true},
            {"points": [[0.5, 0.71]], "radius": 0.03, "hardness": 0.8, "flow": 1, "src_dx": 0.0, "src_dy": -0.4, "heal": true},
            {"points": [[0.35, 0.7], [0.5, 0.78], [0.62, 0.74]], "radius": 0.015, "hardness": 0.8, "flow": 1, "color": "#3366cc"},
            {"points": [[0.4, 0.58], [0.6, 0.6]], "radius": 0.02, "hardness": 0.5, "flow": 1, "color": "#cc6633", "brush": "texture"},
            {"points": [[0.6, 0.58], [0.6, 0.64]], "radius": 0.03, "hardness": 0.8, "flow": 1, "blur": true, "blur_strength": 1.0}
        ]"##;
        let mut node = make_node("heeler.paint");
        set_text(&mut node, "strokes", strokes);
        let export = run_on(&node, full.clone()).unwrap().as_image().unwrap().as_ref().clone();
        // Patches as the slice cuts them: whole pixels of the frame, the
        // rect the fractions the desktop writes (inject_roi_frame), each
        // holding everything the strokes read (the slice grows to that,
        // strokes_reach), at odd offsets.
        for (px, py, pw, ph) in [(31usize, 397usize, 869usize, 903usize), (45, 401, 955, 899)] {
            let mut patch = ImageBuf::new(pw, ph);
            for y in 0..ph {
                for x in 0..pw {
                    patch.set_pixel(x, y, full.pixel(px + x, py + y));
                }
            }
            let mut sliced = make_node("heeler.paint");
            set_text(&mut sliced, "strokes", strokes);
            for (k, v) in [("roi_x", px as f64 / w as f64), ("roi_y", py as f64 / h as f64), ("roi_w", pw as f64 / w as f64), ("roi_h", ph as f64 / h as f64)] {
                sliced.params.insert(k.into(), ParamValue::Number(v));
            }
            let got = run_on(&sliced, patch).unwrap().as_image().unwrap().as_ref().clone();
            let mut worst = (0.0f32, 0, 0);
            for y in 0..ph {
                for x in 0..pw {
                    let (a, b) = (got.pixel(x, y), export.pixel(px + x, py + y));
                    for c in 0..4 {
                        let d = (a[c] - b[c]).abs();
                        if d > worst.0 {
                            worst = (d, px + x, py + y);
                        }
                    }
                }
            }
            assert!(worst.0 <= 1e-5, "patch at ({px}, {py}) {pw}x{ph}: {} off the export at {:?}", worst.0, (worst.1, worst.2));
        }
    }
}

#[cfg(test)]
mod gradient_tests {
    use super::*;
    use crate::ops::test_util::*;
    use heeler_graph::ParamValue;

    fn flat(w: usize, h: usize) -> ImageBuf {
        ImageBuf::filled(w, h, [0.0, 0.0, 0.0, 1.0])
    }

    #[test]
    fn the_midpoint_moves_where_the_blend_reaches_halfway() {
        let mut node = make_node("heeler.gradient");
        set_text(&mut node, "color_a", "#000000");
        set_text(&mut node, "color_b", "#ffffff");
        node.params.insert("alpha_b".into(), ParamValue::Number(100.0));
        let even = run_on(&node, flat(64, 4)).unwrap();
        let mid_even = even.as_image().unwrap().pixel(32, 2)[0];
        assert!((mid_even - 0.5).abs() < 0.05, "an even split is gray in the middle");

        // Pull the halfway point left: the middle of the frame is past
        // it, so it is brighter than gray.
        node.params.insert("midpoint".into(), ParamValue::Number(25.0));
        let weighted = run_on(&node, flat(64, 4)).unwrap();
        let mid_w = weighted.as_image().unwrap().pixel(32, 2)[0];
        assert!(mid_w > mid_even + 0.15, "weighting moved the blend: {mid_w} vs {mid_even}");
    }

    #[test]
    fn a_stop_list_beats_the_simple_pair() {
        let mut node = make_node("heeler.gradient");
        set_text(&mut node, "color_a", "#000000");
        set_text(&mut node, "color_b", "#000000");
        set_text(
            &mut node,
            "stops",
            r##"[{"pos":0,"color":"#ff0000"},{"pos":50,"color":"#00ff00"},{"pos":100,"color":"#0000ff"}]"##,
        );
        let out = run_on(&node, flat(64, 4)).unwrap();
        let img = out.as_image().unwrap();
        assert!(img.pixel(1, 2)[0] > 0.9, "first stop is red");
        assert!(img.pixel(32, 2)[1] > 0.9, "middle stop is green");
        assert!(img.pixel(62, 2)[2] > 0.9, "last stop is blue");
    }

    /// A gray ramp from black to white across the frame, with a tinted
    /// row so the luma key is not just one channel.
    fn tone_ramp(w: usize, h: usize) -> ImageBuf {
        let mut img = ImageBuf::new(w, h);
        for y in 0..h {
            for x in 0..w {
                let v = x as f32 / (w - 1) as f32;
                let px = if y % 2 == 0 { [v, v, v, 1.0] } else { [v, v * 0.6, (v * 1.3).min(1.0), 1.0] };
                img.set_pixel(x, y, px);
            }
        }
        img
    }

    #[test]
    fn by_tone_maps_brightness_through_the_stops_as_the_gradient_map_did() {
        for (lo, mid, hi, pivot) in [("#000000", "#808080", "#ffffff", 50.0), ("#1b2a44", "#a05030", "#f0e0c0", 30.0)] {
            let mut map = make_node("heeler.gradient_map");
            set_text(&mut map, "color_lo", lo);
            set_text(&mut map, "color_mid", mid);
            set_text(&mut map, "color_hi", hi);
            map.params.insert("midpoint".into(), ParamValue::Number(pivot as f64));
            let mut tone = make_node("heeler.gradient");
            set_text(&mut tone, "shape", "tone");
            set_text(
                &mut tone,
                "stops",
                &format!(
                    r#"[{{"pos":0,"color":"{lo}","alpha":100,"mid":50}},{{"pos":{pivot},"color":"{mid}","alpha":100,"mid":50}},{{"pos":100,"color":"{hi}","alpha":100,"mid":50}}]"#
                ),
            );
            // The angle is a position control and By tone ignores it.
            tone.params.insert("angle".into(), ParamValue::Number(37.0));
            let a = run_on(&map, tone_ramp(256, 4)).unwrap();
            let b = run_on(&tone, tone_ramp(256, 4)).unwrap();
            let (a, b) = (a.as_image().unwrap(), b.as_image().unwrap());
            let worst = a.data.iter().zip(b.data.iter()).map(|(x, y)| (x - y).abs()).fold(0.0f32, f32::max);
            assert!(worst < 1e-5, "{lo} {mid} {hi} at {pivot}: By tone differs from the gradient map by {worst}");
        }
    }

    #[test]
    fn by_tone_keeps_per_stop_alpha_and_falloff() {
        let mut node = make_node("heeler.gradient");
        set_text(&mut node, "shape", "tone");
        set_text(
            &mut node,
            "stops",
            r##"[{"pos":0,"color":"#0000ff","alpha":100,"mid":20},{"pos":100,"color":"#ff0000","alpha":0,"mid":50}]"##,
        );
        let out = run_on(&node, tone_ramp(101, 2)).unwrap();
        let img = out.as_image().unwrap();
        assert!(img.pixel(0, 0)[2] > 0.99 && img.pixel(0, 0)[3] > 0.99, "black takes the first stop, opaque");
        assert!(img.pixel(100, 0)[3] < 0.01, "white takes the last stop's alpha");
        // Falloff 20: the blend is halfway at a fifth of the way along.
        let at20 = img.pixel(20, 0);
        assert!((at20[3] - 0.5).abs() < 0.03, "halfway alpha at tone 20, got {}", at20[3]);
    }

    #[test]
    fn a_gradient_on_a_patch_matches_the_frame_it_came_from() {
        // At 1:1 the buffer is a slice of the photograph. Without the
        // roi rect the gradient would restart inside every patch, so a
        // sky graduated at fit view would look wrong zoomed in.
        let mut full = make_node("heeler.gradient");
        set_text(&mut full, "color_a", "#000000");
        set_text(&mut full, "color_b", "#ffffff");
        full.params.insert("alpha_b".into(), ParamValue::Number(100.0));
        let whole = run_on(&full, flat(64, 8)).unwrap();
        let whole = whole.as_image().unwrap().clone();

        let mut patch = make_node("heeler.gradient");
        set_text(&mut patch, "color_a", "#000000");
        set_text(&mut patch, "color_b", "#ffffff");
        patch.params.insert("alpha_b".into(), ParamValue::Number(100.0));
        for (k, v) in [("roi_x", 0.5), ("roi_y", 0.0), ("roi_w", 0.5), ("roi_h", 1.0)] {
            patch.params.insert(k.into(), ParamValue::Number(v));
        }
        let out = run_on(&patch, flat(32, 8)).unwrap();
        let img = out.as_image().unwrap();
        // Patch pixel 0 is frame pixel 32, patch 31 is frame 63.
        assert!((img.pixel(0, 4)[0] - whole.pixel(32, 4)[0]).abs() < 0.03);
        assert!((img.pixel(31, 4)[0] - whole.pixel(63, 4)[0]).abs() < 0.03);
    }

    /// A heal hundreds of pixels across heals the same picture at every
    /// size (the canyon check, 2026-10-01: a heal of radius 0.05 on a
    /// 24 megapixel photograph, 400 pixels across, was 0.15 off its Fit
    /// in the Finish stack's encoding). Gauss-Seidel carries a
    /// correction about a pixel a sweep, so the full-size solve stopped
    /// at its iteration ceiling far from the answer the quarter-size
    /// solve reached; it starts from its own problem solved at half the
    /// size now. The same stroke on the same picture at 2000 by 3000 and
    /// at a quarter of that: the large one reduced four by four is the
    /// small one, within the fixture tests' Fit bound for a Pixel layer
    /// (0.02, warp_bake.rs FIT_PAINTED; it was 0.12 here). A small heal
    /// starts from the destination as it always did.
    #[test]
    fn a_large_heal_is_the_same_at_a_quarter_of_the_size() {
        let picture = |w: usize, h: usize| {
            let mut img = ImageBuf::new(w, h);
            for y in 0..h {
                for x in 0..w {
                    let (fx, fy) = ((x as f32 + 0.5) / w as f32, (y as f32 + 0.5) / h as f32);
                    let t = (fx * std::f32::consts::TAU * 6.0).sin() * (fy * std::f32::consts::TAU * 4.0).sin();
                    let v = 0.2 + 0.15 * t + 0.2 * fx + 0.3 * fy;
                    img.set_pixel(x, y, [v, v * 0.9, v * 0.8, 1.0]);
                }
            }
            img
        };
        let strokes = r#"[{"points":[[0.3,0.62],[0.3,0.66]],"radius":0.05,"hardness":0.8,"flow":1,"src_dx":-0.2,"src_dy":0.15,"heal":true}]"#;
        let heal = |w: usize, h: usize, scale: f64| {
            let mut node = make_node("heeler.paint");
            set_text(&mut node, "strokes", strokes);
            if scale < 1.0 {
                set_num(&mut node, "px_scale", scale);
            }
            let out = run_on(&node, picture(w, h)).unwrap();
            out.as_image().unwrap().as_ref().clone()
        };
        let (big, small) = (heal(2000, 3000, 1.0), heal(500, 750, 0.25));
        let mut worst = (0.0f32, 0, 0);
        for y in 0..750 {
            for x in 0..500 {
                // The layer's pixels as they composite: color times alpha.
                let mut s = [0.0f32; 4];
                for j in 0..4 {
                    for i in 0..4 {
                        let p = big.pixel(x * 4 + i, y * 4 + j);
                        for c in 0..3 {
                            s[c] += p[c] * p[3] / 16.0;
                        }
                        s[3] += p[3] / 16.0;
                    }
                }
                let q = small.pixel(x, y);
                for c in 0..3 {
                    let d = (s[c] - q[c] * q[3]).abs();
                    if d > worst.0 {
                        worst = (d, x, y);
                    }
                }
            }
        }
        assert!(worst.0 < 0.02, "the full-size heal reduced is {} off the quarter-size heal at {:?}", worst.0, (worst.1, worst.2));
    }

}
