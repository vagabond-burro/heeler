//! A k-d tree over descriptors, searched best-bin-first.
//!
//! Brown and Lowe index every feature of every image in one tree and ask
//! it for each feature's k=4 nearest neighbors. The reason is cost:
//! comparing every descriptor against every other is quadratic, and a
//! dozen frames at a couple of thousand features each makes that hundreds
//! of millions of 128-dimensional distances.
//!
//! An exact k-d tree does not help in 128 dimensions, where nearly every
//! branch has to be opened. Beis and Lowe's best-bin-first search is the
//! usual answer: visit the most promising branches first, then stop after
//! a fixed budget and accept whatever was found. It is approximate, and
//! that is fine here, because a wrong neighbor is not a wrong panorama.
//! It is one bad correspondence among hundreds, and RANSAC exists to
//! throw those away.

/// How many leaves a search may open before giving up. Lowe's figure for
/// SIFT matching, and the knob that trades accuracy for time.
const MAX_LEAVES: usize = 200;
/// Below this a node stops splitting, since scanning a handful of points
/// costs less than the branching.
const LEAF_SIZE: usize = 16;

struct Node {
    /// Split dimension and value, or None for a leaf.
    split: Option<(usize, f32)>,
    left: usize,
    right: usize,
    /// Indices into the point list, for leaves.
    items: Vec<usize>,
}

pub struct KdTree<'a> {
    points: &'a [Vec<f32>],
    nodes: Vec<Node>,
    dims: usize,
}

/// One neighbor: which point, and how far.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Neighbour {
    pub index: usize,
    pub dist: f32,
}

fn dist2(a: &[f32], b: &[f32]) -> f32 {
    a.iter().zip(b).map(|(u, v)| (u - v) * (u - v)).sum()
}

impl<'a> KdTree<'a> {
    pub fn build(points: &'a [Vec<f32>]) -> KdTree<'a> {
        let dims = points.first().map(|p| p.len()).unwrap_or(0);
        let mut tree = KdTree { points, nodes: Vec::new(), dims };
        let all: Vec<usize> = (0..points.len()).collect();
        tree.build_node(all);
        tree
    }

    fn build_node(&mut self, items: Vec<usize>) -> usize {
        let id = self.nodes.len();
        self.nodes.push(Node { split: None, left: 0, right: 0, items: Vec::new() });
        if items.len() <= LEAF_SIZE || self.dims == 0 {
            self.nodes[id].items = items;
            return id;
        }

        // Split on the dimension the points actually spread out in.
        // Cycling through dimensions in order, the textbook version,
        // wastes splits on the many descriptor bins that happen to be
        // near zero for this particular set of points.
        let mut best_dim = 0;
        let mut best_spread = -1.0f32;
        for d in 0..self.dims {
            let mut lo = f32::INFINITY;
            let mut hi = f32::NEG_INFINITY;
            for &i in &items {
                let v = self.points[i][d];
                lo = lo.min(v);
                hi = hi.max(v);
            }
            if hi - lo > best_spread {
                best_spread = hi - lo;
                best_dim = d;
            }
        }
        if best_spread <= 0.0 {
            // Every remaining point is identical in every dimension.
            self.nodes[id].items = items;
            return id;
        }

        let mut sorted = items;
        sorted.sort_by(|&a, &b| {
            self.points[a][best_dim]
                .partial_cmp(&self.points[b][best_dim])
                .unwrap_or(std::cmp::Ordering::Equal)
        });
        let mid = sorted.len() / 2;
        let value = self.points[sorted[mid]][best_dim];
        let right_items = sorted.split_off(mid);
        let left = self.build_node(sorted);
        let right = self.build_node(right_items);
        self.nodes[id].split = Some((best_dim, value));
        self.nodes[id].left = left;
        self.nodes[id].right = right;
        id
    }

    /// The k nearest neighbors of `query`, nearest first.
    ///
    /// Approximate: the search abandons the tree after MAX_LEAVES leaves,
    /// keeping whatever it has. `skip` excludes one index, which is how a
    /// point avoids matching itself when the tree holds its own image.
    pub fn nearest(&self, query: &[f32], k: usize, skip: Option<usize>) -> Vec<Neighbour> {
        let mut best: Vec<Neighbour> = Vec::with_capacity(k + 1);
        if self.nodes.is_empty() || k == 0 {
            return best;
        }
        // Branches not taken, ordered by how close the query is to the
        // splitting plane. That ordering is the whole idea: the branch
        // whose boundary is nearest is the one most likely to hide a
        // closer point.
        let mut queue: Vec<(f32, usize)> = vec![(0.0, 0)];
        let mut leaves = 0;

        while let Some(pos) = queue
            .iter()
            .enumerate()
            .min_by(|a, b| a.1 .0.partial_cmp(&b.1 .0).unwrap_or(std::cmp::Ordering::Equal))
            .map(|(i, _)| i)
        {
            let (bound, mut node) = queue.swap_remove(pos);
            // Nothing in this branch can beat what we already have.
            if best.len() == k && bound > best[best.len() - 1].dist {
                continue;
            }
            // Walk down to a leaf, stacking the far sides as we go.
            loop {
                match self.nodes[node].split {
                    None => break,
                    Some((dim, value)) => {
                        let delta = query[dim] - value;
                        let (near, far) = if delta < 0.0 {
                            (self.nodes[node].left, self.nodes[node].right)
                        } else {
                            (self.nodes[node].right, self.nodes[node].left)
                        };
                        queue.push((delta * delta, far));
                        node = near;
                    }
                }
            }
            for &i in &self.nodes[node].items {
                if Some(i) == skip {
                    continue;
                }
                let d = dist2(query, &self.points[i]).sqrt();
                if best.len() < k || d < best[best.len() - 1].dist {
                    let at = best
                        .iter()
                        .position(|n| d < n.dist)
                        .unwrap_or(best.len());
                    best.insert(at, Neighbour { index: i, dist: d });
                    best.truncate(k);
                }
            }
            leaves += 1;
            if leaves >= MAX_LEAVES {
                break;
            }
        }
        best
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn brute(points: &[Vec<f32>], q: &[f32], k: usize) -> Vec<usize> {
        let mut all: Vec<(f32, usize)> =
            points.iter().enumerate().map(|(i, p)| (dist2(q, p).sqrt(), i)).collect();
        all.sort_by(|a, b| a.0.partial_cmp(&b.0).unwrap());
        all.into_iter().take(k).map(|(_, i)| i).collect()
    }

    /// Deterministic pseudo-random points. A fixed generator keeps the
    /// test reproducible: an intermittent nearest-neighbor test is worse
    /// than no test.
    fn cloud(n: usize, dims: usize) -> Vec<Vec<f32>> {
        let mut state = 0x2545F491u32;
        let mut next = || {
            state ^= state << 13;
            state ^= state >> 17;
            state ^= state << 5;
            (state % 10_000) as f32 / 10_000.0
        };
        (0..n).map(|_| (0..dims).map(|_| next()).collect()).collect()
    }

    #[test]
    fn finds_the_true_nearest_in_low_dimensions() {
        let points = cloud(500, 3);
        let tree = KdTree::build(&points);
        for q in cloud(20, 3) {
            let got = tree.nearest(&q, 1, None);
            let want = brute(&points, &q, 1);
            assert_eq!(got[0].index, want[0], "missed the nearest neighbor");
        }
    }

    #[test]
    fn returns_k_neighbours_in_order() {
        let points = cloud(300, 8);
        let tree = KdTree::build(&points);
        let q = vec![0.5; 8];
        let got = tree.nearest(&q, 4, None);
        assert_eq!(got.len(), 4);
        for w in got.windows(2) {
            assert!(w[0].dist <= w[1].dist, "not sorted: {got:?}");
        }
    }

    /// The case that matters, and the reason the search is approximate:
    /// 128 dimensions is where an exact k-d tree stops being a saving.
    /// It has to stay good enough that the ratio test still means
    /// something.
    #[test]
    fn stays_accurate_enough_at_descriptor_dimensions() {
        let points = cloud(800, 128);
        let tree = KdTree::build(&points);
        let mut hits = 0;
        let queries = cloud(40, 128);
        for q in &queries {
            let got = tree.nearest(q, 1, None);
            let want = brute(&points, q, 1);
            if got[0].index == want[0] {
                hits += 1;
            }
        }
        let rate = hits as f32 / queries.len() as f32;
        assert!(rate > 0.8, "best-bin-first found the true nearest only {rate:.2} of the time");
    }

    /// An exact hit must come back first: a feature matched against a
    /// tree containing its own descriptor is the everyday case.
    #[test]
    fn an_exact_match_is_found_and_can_be_skipped() {
        let points = cloud(200, 16);
        let tree = KdTree::build(&points);
        let got = tree.nearest(&points[42], 2, None);
        assert_eq!(got[0].index, 42);
        assert!(got[0].dist < 1e-6);
        // Skipping it hands back the next one instead of itself.
        let skipped = tree.nearest(&points[42], 1, Some(42));
        assert_ne!(skipped[0].index, 42);
    }

    #[test]
    fn an_empty_tree_answers_nothing_rather_than_panicking() {
        let points: Vec<Vec<f32>> = Vec::new();
        let tree = KdTree::build(&points);
        assert!(tree.nearest(&[0.0; 8], 4, None).is_empty());
    }

    #[test]
    fn identical_points_do_not_split_forever() {
        // Every point the same: the split test has to notice there is no
        // spread, or recursion never bottoms out.
        let points: Vec<Vec<f32>> = (0..100).map(|_| vec![0.25; 4]).collect();
        let tree = KdTree::build(&points);
        assert_eq!(tree.nearest(&[0.25; 4], 3, None).len(), 3);
    }
}
