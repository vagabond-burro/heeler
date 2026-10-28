//! Where one frame hands over to the next.
//!
//! Multi-band blending hides a seam; it cannot decide where the seam
//! goes. Giving every pixel to the frame that looks at it most directly
//! puts the seam down the middle of each overlap whatever is there, and
//! anything that moved between the shots is cut in half on that line,
//! or kept from both frames by the coarse bands as a ghost.
//!
//! The seam belongs where the frames agree. That is a minimum cut:
//! every pixel of an overlap is a node, every pair of neighbors is
//! joined by the cost of a seam running between them (how differently
//! the two frames see those two pixels), and the pixels the overlap
//! touches on either side are tied to their own frame. The cheapest set
//! of links to cut that separates the two sides is the seam, and it
//! goes round a walking figure because cutting through one is expensive
//! in both frames' disagreement. Kwatra, Schodl, Essa, Turk and Bobick's
//! "Graphcut Textures" is the formulation; the max flow that finds the
//! cut is Dinic's.
//!
//! Frames are cut in one at a time against everything placed before
//! them, on a reduced copy of the canvas: the seam's position matters
//! to a handful of pixels, the blend smooths the rest, and the flow's
//! cost grows faster than the area it runs over.

use crate::composite::Warped;

/// The reduced canvas holds at most this many cells, whatever the
/// panorama's size: the seam's memory is a fixed allowance rather than
/// a per-pixel one.
pub(crate) const SEAM_CELLS: usize = 1 << 19;
/// Working memory per reduced cell, besides the frames' own reduced
/// copies: the graph's four links and two terminals, its index, level
/// and edge pointer, the queue, and the reduced ownership.
const CELL_BYTES: usize = 48;
/// Fixed-point scale for link costs, which the flow keeps as integers
/// so it terminates exactly.
const QUANT: f32 = 256.0;
/// Hard ties to a frame: larger than any seam could cost.
const TIE: i32 = i32::MAX / 8;
/// Below this weight a frame is close to its own border, where the lens
/// is at its worst and the blend's coarse bands reach past what the
/// frame covers. A seam is not let in there.
const MARGIN_WEIGHT: f32 = 0.02;
/// The seam's cost per link where the frames agree exactly, so that
/// among agreeing routes the shortest wins.
const SEAM_FLOOR: f32 = 0.01;
/// How much an image edge running between two pixels cheapens a seam
/// along it: a seam on an edge is the hardest kind to see.
const EDGE_RELIEF: f32 = 4.0;
/// How far, in canvas pixels, a seam keeps from where the frames
/// disagree. The blend's coarse bands reach this far across a seam, so
/// one cut tight against a moving subject still carries a faint copy of
/// it over from the frame it was cut out of.
const SEAM_CLEARANCE: usize = 8;
/// The pull, per cell, toward the frame that looks at it more directly.
/// Weak: enough to keep an overlap where nothing differs as it was
/// (down the middle), never enough to drag the seam through a subject.
const CENTRE_PULL: f32 = 0.02;

/// Bytes the seam finder holds for a canvas of `width` by `height` from
/// `frames` frames, on top of bytes_per_pixel's workspace.
pub(crate) fn seam_bytes(frames: usize, width: usize, height: usize) -> usize {
    let cells = width.saturating_mul(height).min(SEAM_CELLS);
    cells.saturating_mul(frames.saturating_mul(16).saturating_add(CELL_BYTES))
}

/// The side, in canvas pixels, of the cells the seam is found on.
fn cell_size(width: usize, height: usize) -> usize {
    let area = width.saturating_mul(height) as f64;
    ((area / SEAM_CELLS as f64).sqrt().ceil() as usize).max(1)
}

/// One frame at the seam's resolution. A cell counts as covered only
/// when every pixel under it is, so a seam found here never hands a
/// pixel to a frame that does not see it.
struct Cells {
    rgb: Vec<[f32; 3]>,
    weight: Vec<f32>,
}

fn reduce(w: &Warped, width: usize, height: usize, s: usize, rw: usize, rh: usize) -> Cells {
    let count = rw * rh;
    let mut rgb = heeler_engine::memory::or_unwind(heeler_engine::memory::vector(count, [0.0f32; 3], "panorama seam cells"));
    let mut weight = heeler_engine::memory::or_unwind(heeler_engine::memory::vector(count, 0.0f32, "panorama seam cells"));
    for cy in 0..rh {
        for cx in 0..rw {
            let (mut sum, mut wsum, mut n, mut whole) = ([0.0f32; 3], 0.0f32, 0usize, true);
            'cell: for y in cy * s..((cy + 1) * s).min(height) {
                for x in cx * s..((cx + 1) * s).min(width) {
                    let p = y * width + x;
                    let wt = w.weight.data[p];
                    if wt <= 0.0 {
                        whole = false;
                        break 'cell;
                    }
                    for c in 0..3 {
                        sum[c] += w.rgb[c].data[p];
                    }
                    wsum += wt;
                    n += 1;
                }
            }
            if whole && n > 0 {
                let c = cy * rw + cx;
                rgb[c] = [sum[0] / n as f32, sum[1] / n as f32, sum[2] / n as f32];
                weight[c] = wsum / n as f32;
            }
        }
    }
    Cells { rgb, weight }
}

/// No neighbor in this direction.
const NONE: u32 = u32::MAX;

/// A max-flow problem whose nodes each have up to four neighbors, link
/// `d` and link `d ^ 1` being the two directions between a pair: left
/// and right, up and down. Each node also has a link from the source
/// and one to the sink.
pub(crate) struct Graph {
    nbr: Vec<[u32; 4]>,
    cap: Vec<[i32; 4]>,
    src: Vec<i32>,
    snk: Vec<i32>,
    level: Vec<i32>,
    next: Vec<u8>,
}

impl Graph {
    pub(crate) fn new(nodes: usize) -> Graph {
        let v = |x| heeler_engine::memory::or_unwind(heeler_engine::memory::vector(nodes, x, "panorama seam graph"));
        Graph {
            nbr: heeler_engine::memory::or_unwind(heeler_engine::memory::vector(nodes, [NONE; 4], "panorama seam graph")),
            cap: heeler_engine::memory::or_unwind(heeler_engine::memory::vector(nodes, [0i32; 4], "panorama seam graph")),
            src: v(0),
            snk: v(0),
            level: v(-1),
            next: heeler_engine::memory::or_unwind(heeler_engine::memory::vector(nodes, 0u8, "panorama seam graph")),
        }
    }

    /// Joins `a` to `b` through `a`'s link `d` (and `b`'s link `d ^ 1`),
    /// with a capacity each way.
    pub(crate) fn link(&mut self, a: usize, d: usize, b: usize, ab: i32, ba: i32) {
        self.nbr[a][d] = b as u32;
        self.nbr[b][d ^ 1] = a as u32;
        self.cap[a][d] = ab;
        self.cap[b][d ^ 1] = ba;
    }

    pub(crate) fn tie_source(&mut self, a: usize, c: i32) {
        self.src[a] = self.src[a].saturating_add(c);
    }

    pub(crate) fn tie_sink(&mut self, a: usize, c: i32) {
        self.snk[a] = self.snk[a].saturating_add(c);
    }

    /// Dinic's algorithm: breadth-first levels from the source, then a
    /// blocking flow along strictly rising levels, until the sink cannot
    /// be reached. Answers the flow, which is the cut's cost, or None
    /// when stopped.
    pub(crate) fn max_flow(&mut self, stop: &dyn Fn() -> bool) -> Option<i64> {
        let n = self.src.len();
        // Whatever a node takes from the source and gives to the sink
        // straight away needs no path.
        let mut flow = 0i64;
        for i in 0..n {
            let m = self.src[i].min(self.snk[i]);
            self.src[i] -= m;
            self.snk[i] -= m;
            flow += m as i64;
        }
        let mut queue: Vec<u32> = heeler_engine::memory::or_unwind(heeler_engine::memory::vector(0, 0u32, "panorama seam graph"));
        let mut path: Vec<(u32, u8)> = Vec::new();
        loop {
            if stop() {
                return None;
            }
            self.level.iter_mut().for_each(|l| *l = -1);
            queue.clear();
            for i in 0..n {
                if self.src[i] > 0 {
                    self.level[i] = 0;
                    queue.push(i as u32);
                }
            }
            // The sink sits one past the first level that reaches it;
            // nothing beyond that level can be on a shortest path.
            let mut sink_level = i32::MAX;
            let mut head = 0;
            while head < queue.len() {
                let u = queue[head] as usize;
                head += 1;
                if self.level[u] >= sink_level {
                    continue;
                }
                if self.snk[u] > 0 {
                    sink_level = self.level[u];
                    continue;
                }
                for d in 0..4 {
                    let v = self.nbr[u][d];
                    if v != NONE && self.cap[u][d] > 0 && self.level[v as usize] < 0 {
                        self.level[v as usize] = self.level[u] + 1;
                        queue.push(v);
                    }
                }
            }
            if sink_level == i32::MAX {
                return Some(flow);
            }
            self.next.iter_mut().for_each(|e| *e = 0);
            for i in 0..n {
                if self.level[i] != 0 {
                    continue;
                }
                while self.src[i] > 0 {
                    let f = self.augment(i, sink_level, &mut path);
                    if f == 0 {
                        break;
                    }
                    flow += f as i64;
                }
            }
        }
    }

    /// One path from `start` (a node the source feeds) to the sink in
    /// the level graph, pushed to its bottleneck. Dead ends are taken out
    /// of the level graph as they are found, so each phase is linear.
    fn augment(&mut self, start: usize, sink_level: i32, path: &mut Vec<(u32, u8)>) -> i32 {
        path.clear();
        let mut u = start;
        loop {
            if self.snk[u] > 0 && self.level[u] == sink_level {
                let mut b = self.src[start].min(self.snk[u]);
                for &(a, d) in path.iter() {
                    b = b.min(self.cap[a as usize][d as usize]);
                }
                self.src[start] -= b;
                self.snk[u] -= b;
                for &(a, d) in path.iter() {
                    let (a, d) = (a as usize, d as usize);
                    let v = self.nbr[a][d] as usize;
                    self.cap[a][d] -= b;
                    self.cap[v][d ^ 1] = self.cap[v][d ^ 1].saturating_add(b);
                }
                return b;
            }
            let mut moved = false;
            while (self.next[u] as usize) < 4 {
                let d = self.next[u] as usize;
                let v = self.nbr[u][d];
                if v != NONE && self.cap[u][d] > 0 && self.level[v as usize] == self.level[u] + 1 && self.level[u] < sink_level {
                    path.push((u as u32, d as u8));
                    u = v as usize;
                    moved = true;
                    break;
                }
                self.next[u] += 1;
            }
            if moved {
                continue;
            }
            // Nothing onward from here this phase.
            self.level[u] = -1;
            match path.pop() {
                Some((a, _)) => {
                    u = a as usize;
                    self.next[u] += 1;
                }
                None => return 0,
            }
        }
    }

    /// After max_flow: which nodes the source still reaches, the source
    /// side of the minimum cut.
    pub(crate) fn source_side(&self) -> Vec<bool> {
        let n = self.src.len();
        let mut seen = heeler_engine::memory::or_unwind(heeler_engine::memory::vector(n, false, "panorama seam graph"));
        let mut queue: Vec<u32> = (0..n as u32).filter(|&i| self.src[i as usize] > 0).collect();
        for &i in &queue {
            seen[i as usize] = true;
        }
        let mut head = 0;
        while head < queue.len() {
            let u = queue[head] as usize;
            head += 1;
            for d in 0..4 {
                let v = self.nbr[u][d];
                if v != NONE && self.cap[u][d] > 0 && !seen[v as usize] {
                    seen[v as usize] = true;
                    queue.push(v);
                }
            }
        }
        seen
    }
}

/// The four neighbors of a cell, in the Graph's link order: left,
/// right, up, down.
fn neighbors(c: usize, rw: usize, rh: usize) -> [Option<usize>; 4] {
    let (x, y) = (c % rw, c / rw);
    [
        (x > 0).then(|| c - 1),
        (x + 1 < rw).then(|| c + 1),
        (y > 0).then(|| c - rw),
        (y + 1 < rh).then(|| c + rw),
    ]
}

/// Each overlap cell's disagreement, raised to the most found within
/// `radius` cells of it: a max filter, across then down, over the
/// overlap's own cells.
fn clearance(overlap: &[usize], index: &[u32], rw: usize, rh: usize, radius: usize, differ: impl Fn(usize) -> f32) -> Vec<f32> {
    let own: Vec<f32> = overlap.iter().map(|&c| differ(c)).collect();
    let mut across = own.clone();
    let at = |x: usize, y: usize| index[y * rw + x];
    for (i, &c) in overlap.iter().enumerate() {
        let (x, y) = (c % rw, c / rw);
        for xx in x.saturating_sub(radius)..(x + radius + 1).min(rw) {
            let j = at(xx, y);
            if j != NONE {
                across[i] = across[i].max(own[j as usize]);
            }
        }
    }
    let mut out = across.clone();
    for (i, &c) in overlap.iter().enumerate() {
        let (x, y) = (c % rw, c / rw);
        for yy in y.saturating_sub(radius)..(y + radius + 1).min(rh) {
            let j = at(x, yy);
            if j != NONE {
                out[i] = out[i].max(across[j as usize]);
            }
        }
    }
    out
}

fn l1(a: [f32; 3], b: [f32; 3]) -> f32 {
    (a[0] - b[0]).abs() + (a[1] - b[1]).abs() + (a[2] - b[2]).abs()
}

fn luma(a: [f32; 3]) -> f32 {
    a[0] * 0.2126 + a[1] * 0.7152 + a[2] * 0.0722
}

/// Which frame owns each canvas pixel, with the seams between frames
/// cut where they agree. None when stopped.
pub(crate) fn seam_ownership(warps: &[Warped], width: usize, height: usize, stop: &dyn Fn() -> bool) -> Option<Vec<i32>> {
    let s = cell_size(width, height);
    let (rw, rh) = (width.div_ceil(s), height.div_ceil(s));
    let cells: Vec<Cells> = warps.iter().map(|w| reduce(w, width, height, s, rw, rh)).collect();
    let count = rw * rh;
    let mut owner = heeler_engine::memory::or_unwind(heeler_engine::memory::vector(count, -1i32, "panorama seam ownership"));
    let mut index = heeler_engine::memory::or_unwind(heeler_engine::memory::vector(count, NONE, "panorama seam graph"));

    for (k, frame) in cells.iter().enumerate() {
        if stop() {
            return None;
        }
        // The overlap: cells this frame sees that an earlier one already
        // holds. Cells only this frame sees are simply its own.
        let overlap: Vec<usize> = (0..count).filter(|&c| frame.weight[c] > 0.0 && owner[c] >= 0).collect();
        if !overlap.is_empty() {
            for (i, &c) in overlap.iter().enumerate() {
                index[c] = i as u32;
            }
            // The colors the composite has so far, against this frame's.
            let held = |c: usize| cells[owner[c] as usize].rgb[c];
            let differ = clearance(&overlap, &index, rw, rh, SEAM_CLEARANCE.div_ceil(s), |c| l1(held(c), frame.rgb[c]));
            let mut g = Graph::new(overlap.len());
            for (i, &c) in overlap.iter().enumerate() {
                let (a, b) = (held(c), frame.rgb[c]);
                let (wa, wb) = (cells[owner[c] as usize].weight[c], frame.weight[c]);
                for (d, q) in neighbors(c, rw, rh).into_iter().enumerate() {
                    let Some(q) = q else { continue };
                    if index[q] != NONE {
                        // Each pair once, from its left or upper end.
                        if d == 1 || d == 3 {
                            let (qa, qb) = (held(q), frame.rgb[q]);
                            let apart = differ[i] + differ[index[q] as usize];
                            let edge = (luma(a) - luma(qa)).abs() + (luma(b) - luma(qb)).abs();
                            let cost = apart / (1.0 + EDGE_RELIEF * edge) + SEAM_FLOOR;
                            let c = ((cost * QUANT).round() as i32).clamp(1, TIE);
                            g.link(i, d, index[q] as usize, c, c);
                        }
                    } else if owner[q] >= 0 && frame.weight[q] <= 0.0 {
                        // Beside what only the composite has: stays.
                        g.tie_source(i, TIE);
                    } else if owner[q] < 0 && frame.weight[q] > 0.0 {
                        // Beside what only this frame has: joins it.
                        g.tie_sink(i, TIE);
                    }
                }
                if wb < MARGIN_WEIGHT {
                    g.tie_source(i, TIE);
                } else if wa < MARGIN_WEIGHT {
                    g.tie_sink(i, TIE);
                }
                let pull = (CENTRE_PULL * (wa - wb).abs() / (wa + wb).max(1e-6) * QUANT).round() as i32;
                if wa > wb {
                    g.tie_source(i, pull);
                } else {
                    g.tie_sink(i, pull);
                }
            }
            g.max_flow(stop)?;
            let keep = g.source_side();
            for (i, &c) in overlap.iter().enumerate() {
                if !keep[i] {
                    owner[c] = k as i32;
                }
                index[c] = NONE;
            }
        }
        for c in 0..count {
            if frame.weight[c] > 0.0 && owner[c] < 0 {
                owner[c] = k as i32;
            }
        }
    }

    // Back to canvas pixels. A pixel under a cell no frame wholly covers
    // (the ragged border, mostly) goes to the frame that sees it best,
    // as every pixel used to.
    let full = heeler_engine::memory::or_unwind(heeler_engine::memory::bytes(width, height, 1, 4)) / 4;
    let mut out = heeler_engine::memory::or_unwind(heeler_engine::memory::vector(full, -1i32, "panorama seam ownership"));
    for y in 0..height {
        for x in 0..width {
            let p = y * width + x;
            let o = owner[(y / s) * rw + x / s];
            if o >= 0 && warps[o as usize].weight.data[p] > 0.0 {
                out[p] = o;
                continue;
            }
            let mut best = 0.0f32;
            for (i, w) in warps.iter().enumerate() {
                if w.weight.data[p] > best {
                    best = w.weight.data[p];
                    out[p] = i as i32;
                }
            }
        }
    }
    Some(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Every assignment of the nodes to the two sides, cheapest first:
    /// the minimum cut by brute force.
    fn brute_cut(nbr: &[[u32; 4]], cap: &[[i32; 4]], src: &[i32], snk: &[i32]) -> i64 {
        let n = src.len();
        let mut best = i64::MAX;
        for mask in 0u32..(1 << n) {
            let side = |i: usize| mask & (1 << i) != 0; // true: source side
            let mut cost = 0i64;
            for i in 0..n {
                if side(i) {
                    cost += snk[i] as i64;
                    for d in 0..4 {
                        let v = nbr[i][d];
                        if v != NONE && !side(v as usize) {
                            cost += cap[i][d] as i64;
                        }
                    }
                } else {
                    cost += src[i] as i64;
                }
            }
            best = best.min(cost);
        }
        best
    }

    #[test]
    fn the_flow_equals_the_cheapest_cut() {
        let mut state = 0x9E37_79B9u32;
        let mut next = || {
            state ^= state << 13;
            state ^= state >> 17;
            state ^= state << 5;
            state
        };
        for trial in 0..60 {
            let (rw, rh) = (2 + trial % 3, 2 + (trial / 3) % 3);
            let n = rw * rh;
            let mut g = Graph::new(n);
            for c in 0..n {
                for (d, q) in neighbors(c, rw, rh).into_iter().enumerate() {
                    if let (Some(q), true) = (q, d == 1 || d == 3) {
                        g.link(c, d, q, (next() % 20) as i32, (next() % 20) as i32);
                    }
                }
                match next() % 4 {
                    0 => g.tie_source(c, (next() % 30) as i32),
                    1 => g.tie_sink(c, (next() % 30) as i32),
                    2 => {
                        g.tie_source(c, (next() % 30) as i32);
                        g.tie_sink(c, (next() % 30) as i32);
                    }
                    _ => {}
                }
            }
            let want = brute_cut(&g.nbr, &g.cap, &g.src, &g.snk);
            let (src, snk) = (g.src.clone(), g.snk.clone());
            let (nbr, cap) = (g.nbr.clone(), g.cap.clone());
            let flow = g.max_flow(&|| false).unwrap();
            assert_eq!(flow, want, "trial {trial}: {rw} x {rh}");
            // And the side it reports costs exactly that.
            let side = g.source_side();
            let mut cost = 0i64;
            for i in 0..n {
                if side[i] {
                    cost += snk[i] as i64;
                    for d in 0..4 {
                        let v = nbr[i][d];
                        if v != NONE && !side[v as usize] {
                            cost += cap[i][d] as i64;
                        }
                    }
                } else {
                    cost += src[i] as i64;
                }
            }
            assert_eq!(cost, want, "trial {trial}: the reported side is not the cut");
        }
    }

    /// Seam time on a full-size canvas: frames side by side, each
    /// overlapping the next by a third, textured and disagreeing a
    /// little everywhere as real frames do.
    #[test]
    #[ignore = "offline seam timing fixture"]
    fn bench_seams() {
        use crate::gray::Gray;
        for (frames, width, height) in [(4usize, 8000usize, 2000usize), (8, 8000, 1200)] {
            let span = width * 3 / (2 * frames + 1);
            let warps: Vec<Warped> = (0..frames)
                .map(|k| {
                    let x0 = k * span * 2 / 3;
                    let mut w = Warped { rgb: [Gray::new(width, height), Gray::new(width, height), Gray::new(width, height)], weight: Gray::new(width, height) };
                    for y in 0..height {
                        for x in x0..(x0 + span).min(width) {
                            let p = y * width + x;
                            let v = 0.4 + 0.2 * ((x as f32 * 0.05).sin() * (y as f32 * 0.07).cos()) + 0.03 * ((x * 7 + y * 13 + k * 31) % 17) as f32 / 17.0;
                            for c in 0..3 {
                                w.rgb[c].data[p] = v;
                            }
                            let fx = 1.0 - (2.0 * (x - x0) as f32 / span as f32 - 1.0).abs();
                            let fy = 1.0 - (2.0 * y as f32 / height as f32 - 1.0).abs();
                            w.weight.data[p] = (fx * fy).max(1e-4);
                        }
                    }
                    w
                })
                .collect();
            let start = std::time::Instant::now();
            let owner = seam_ownership(&warps, width, height, &|| false).unwrap();
            println!(
                "seams frames={frames} canvas={width}x{height} cells={} ms={:.0} seam_bytes={}",
                width.div_ceil(cell_size(width, height)) * height.div_ceil(cell_size(width, height)),
                start.elapsed().as_secs_f64() * 1000.0,
                seam_bytes(frames, width, height)
            );
            assert!((0..owner.len()).all(|p| (owner[p] >= 0) == warps.iter().any(|w| w.weight.data[p] > 0.0)));
        }
    }

    #[test]
    fn a_stopped_flow_answers_none() {
        let mut g = Graph::new(2);
        g.link(0, 1, 1, 5, 5);
        g.tie_source(0, 9);
        g.tie_sink(1, 9);
        assert_eq!(g.max_flow(&|| true), None);
    }

    #[test]
    fn the_seam_allowance_is_fixed_past_its_cell_count() {
        assert_eq!(cell_size(400, 300), 1);
        assert!(cell_size(8000, 2000) > 1);
        assert_eq!(seam_bytes(4, 20_000, 10_000), seam_bytes(4, 40_000, 10_000));
        assert!(seam_bytes(4, 100, 100) < seam_bytes(4, 1000, 1000));
    }
}
