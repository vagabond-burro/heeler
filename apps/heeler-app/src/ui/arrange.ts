// Laying the graph out so it can be read.
//
// "I enabled sharpening. I see it created nodes, awesome! But
// the node graph is a mess. We need nodes to automatically organize and
// layout, that way after doing lots of tweaks in Develop and flipping over
// to Graph its not a massive mess."
//
// Derived from the wires rather than from a list of node ids in a known
// order, which matters: a sharpening recipe, a layer's masked adjustment and
// a node the user dropped in by hand are all things no fixed order could
// know about. Anything wired up gets placed.
//
// The rule is that a node sits one column to the right of everything feeding
// it, at the furthest right any of them can push it. That is what makes every
// wire point forwards: the alternative, placing a node next to its first
// input, leaves later wires doubling back across the canvas, which is most of
// what "a mess" means when you look at a graph.

// Types only, which are erased at compile time, and the node size arrives as
// an argument. So this module has no runtime dependency on state.ts and the
// reducer can call it without a cycle.
import type { NodeCard, Wire } from "../state";
import { isLayerNode } from "../layerids";

/** Space between columns and between rows.
 *
 * A column gap wider than the node itself, because that is where the wires
 * live and a wire you cannot follow is the whole problem being solved.
 */
export const COL_GAP = 60;
export const ROW_GAP = 34;
export const MARGIN = 24;

/** How far right each node has to sit: one past its furthest input.
 *
 * Iterative rather than recursive, so a graph that somehow contains a cycle
 * settles instead of overflowing the stack. The graph editor refuses to make
 * cycles, but a hand-edited project file is not bound by that.
 */
export function columnsOf(nodes: NodeCard[], wires: Wire[]): Map<string, number> {
  const ids = new Set(nodes.map((n) => n.id));
  const feeds = new Map<string, string[]>();
  for (const w of wires) {
    if (!ids.has(w.from) || !ids.has(w.to)) continue;
    feeds.set(w.to, [...(feeds.get(w.to) ?? []), w.from]);
  }
  const col = new Map<string, number>(nodes.map((n) => [n.id, 0]));
  // At most one pass per node: the longest path in a graph of n nodes cannot
  // be longer than n, and a cycle stops moving once it stops growing.
  for (let pass = 0; pass < nodes.length; pass++) {
    let moved = false;
    for (const n of nodes) {
      const want = (feeds.get(n.id) ?? []).reduce(
        (max, from) => Math.max(max, (col.get(from) ?? 0) + 1),
        0,
      );
      // Capped at the node count, which is the longest a real path can be.
      // A cycle would otherwise keep pushing its members further right on
      // every pass, and a graph laid out three screens away is no more
      // usable than a pile.
      const capped = Math.min(want, nodes.length - 1);
      if (capped > (col.get(n.id) ?? 0)) {
        col.set(n.id, capped);
        moved = true;
      }
    }
    if (!moved) break;
  }
  return col;
}

/** Which band a node belongs in, top to bottom.
 *
 * Masks below the picture, because that is where they are drawn in every
 * node editor anybody has used and because the image chain is the thing you
 * follow first. A layer's adjustment goes between the two: it is part of the
 * picture, but reading the main chain should not mean stepping over six of
 * them.
 */
export function bandOf(n: NodeCard): number {
  if (n.maskOut) return 2;
  if (isLayerNode(n.id)) return 1;
  return 0;
}

/** New positions for every node, keyed by id.
 *
 * Returns positions rather than nodes so the caller can decide what to do
 * with them, and so this can be tested without a graph.
 */
export function arrange(
  nodes: NodeCard[],
  wires: Wire[],
  nodeW: number,
  nodeH: number,
): Map<string, { x: number; y: number }> {
  const col = columnsOf(nodes, wires);
  // Grouped by column, then ordered within it. Band first, so the image
  // chain reads across the top; then whatever vertical order the nodes are
  // already in, so a layout the user has nudged is tidied rather than
  // reshuffled; then id, so the result is the same every time.
  const byCol = new Map<number, NodeCard[]>();
  for (const n of nodes) {
    const c = col.get(n.id) ?? 0;
    byCol.set(c, [...(byCol.get(c) ?? []), n]);
  }
  const out = new Map<string, { x: number; y: number }>();
  for (const [c, list] of byCol) {
    const ordered = [...list].sort(
      (a, b) => bandOf(a) - bandOf(b) || a.y - b.y || a.id.localeCompare(b.id),
    );
    ordered.forEach((n, row) => {
      out.set(n.id, {
        x: MARGIN + c * (nodeW + COL_GAP),
        y: MARGIN + row * (nodeH + ROW_GAP),
      });
    });
  }
  return out;
}

/** How far from tidy a graph currently is, 0 to 1.
 *
 * Used to decide whether to offer the arrange as something worth doing. A
 * graph nobody has disturbed should not nag.
 */
export function untidiness(
  nodes: NodeCard[],
  wires: Wire[],
  nodeW: number,
  nodeH: number,
): number {
  if (nodes.length === 0) return 0;
  const want = arrange(nodes, wires, nodeW, nodeH);
  const off = nodes.filter((n) => {
    const p = want.get(n.id);
    return p && (Math.abs(p.x - n.x) > 8 || Math.abs(p.y - n.y) > 8);
  });
  return off.length / nodes.length;
}
