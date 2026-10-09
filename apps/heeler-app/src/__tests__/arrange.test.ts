// Laying the graph out so it can be read.
//
// "I enabled sharpening. I see it created nodes, awesome! But
// the node graph is a mess. We need nodes to automatically organize and
// layout, that way after doing lots of tweaks in Develop and flipping over
// to Graph its not a massive mess. Could probably use some sort of auto
// arrange tools in a the graph view context menu."

import { describe, expect, it } from "vitest";
import { arrange, bandOf, columnsOf, untidiness } from "../ui/arrange";
import type { NodeCard, Wire } from "../state";

const W = 140;
const H = 78;

const n = (id: string, over: Partial<NodeCard> = {}): NodeCard =>
  ({
    id,
    type: "heeler.exposure",
    name: id,
    cat: "color",
    x: 0,
    y: 0,
    enabled: true,
    params: {},
    ...over,
  }) as NodeCard;

const w = (from: string, to: string, kind: Wire["kind"] = "image"): Wire => ({
  from,
  to,
  toPort: "in",
  kind,
});

describe("which column a node belongs in", () => {
  it("is one past whatever feeds it", () => {
    const nodes = [n("a"), n("b"), n("c")];
    const col = columnsOf(nodes, [w("a", "b"), w("b", "c")]);
    expect(col.get("a")).toBe(0);
    expect(col.get("b")).toBe(1);
    expect(col.get("c")).toBe(2);
  });

  it("is one past the FURTHEST thing feeding it, not the first", () => {
    // This is the whole reason for the algorithm. A node fed by both a
    // source and the end of a long chain has to sit after the long chain,
    // or that wire doubles back across the canvas.
    const nodes = [n("src"), n("a"), n("b"), n("blend")];
    const col = columnsOf(nodes, [
      w("src", "a"),
      w("a", "b"),
      w("src", "blend"),
      w("b", "blend"),
    ]);
    expect(col.get("blend")).toBe(3);
  });

  it("leaves an unwired node at the start rather than nowhere", () => {
    const col = columnsOf([n("lonely")], []);
    expect(col.get("lonely")).toBe(0);
  });

  it("settles on a graph that somehow contains a cycle", () => {
    // The editor refuses to make one, but a hand-edited project file is not
    // bound by that, and a layout that never returns is worse than an odd
    // looking one.
    const nodes = [n("a"), n("b")];
    const col = columnsOf(nodes, [w("a", "b"), w("b", "a")]);
    // Bounded by the node count: a real path cannot be longer than that,
    // and a cycle laid out three screens away is no better than a pile.
    expect(col.get("a")).toBeLessThan(nodes.length);
    expect(col.get("b")).toBeLessThan(nodes.length);
  });

  it("ignores a wire to a node that is not there", () => {
    const col = columnsOf([n("a")], [w("ghost", "a")]);
    expect(col.get("a")).toBe(0);
  });
});

describe("bands, top to bottom", () => {
  it("puts the image chain above the layers, and masks below both", () => {
    expect(bandOf(n("stdcolor"))).toBe(0);
    expect(bandOf(n("layer_1_adj"))).toBe(1);
    expect(bandOf(n("lummask", { maskOut: true }))).toBe(2);
    // A mask inside a layer is still a mask: it is the thing you look at
    // last, whoever owns it.
    expect(bandOf(n("layer_1_mask", { maskOut: true }))).toBe(2);
  });
});

describe("the layout itself", () => {
  const chain = () => ({
    nodes: [n("src"), n("mid"), n("out"), n("mask", { maskOut: true, y: 400 })],
    wires: [w("src", "mid"), w("mid", "out"), w("src", "mask"), w("mask", "mid", "mask")],
  });

  it("never lets a wire point backwards", () => {
    const { nodes, wires } = chain();
    const at = arrange(nodes, wires, W, H);
    for (const wire of wires) {
      const from = at.get(wire.from)!;
      const to = at.get(wire.to)!;
      // A mask feeding back into the chain it hangs off is the one case
      // where equal is fine: it sits below rather than behind.
      expect(to.x >= from.x, `${wire.from} -> ${wire.to} goes backwards`).toBe(true);
    }
  });

  it("spaces columns wider than a node, since that is where the wires live", () => {
    const { nodes, wires } = chain();
    const at = arrange(nodes, wires, W, H);
    expect(at.get("mid")!.x - at.get("src")!.x).toBeGreaterThan(W);
  });

  it("gives every node in a column its own row", () => {
    const nodes = [n("a"), n("b"), n("c")];
    const at = arrange(nodes, [], W, H);
    const ys = nodes.map((x) => at.get(x.id)!.y);
    expect(new Set(ys).size).toBe(3);
    // And enough apart not to overlap.
    expect(Math.abs(ys[1] - ys[0])).toBeGreaterThan(H);
  });

  it("keeps the vertical order the user already had", () => {
    // Tidying a layout should not reshuffle it: whatever is above stays
    // above, so the arrangement you recognize survives.
    const nodes = [n("low", { y: 900 }), n("high", { y: 10 })];
    const at = arrange(nodes, [], W, H);
    expect(at.get("high")!.y).toBeLessThan(at.get("low")!.y);
  });

  it("gives the same answer twice", () => {
    // Nodes arrive in whatever order the array holds them, and a layout
    // that shuffles on every press is its own kind of mess.
    const { nodes, wires } = chain();
    const a = arrange(nodes, wires, W, H);
    const b = arrange([...nodes].reverse(), wires, W, H);
    for (const node of nodes) {
      expect(b.get(node.id)).toEqual(a.get(node.id));
    }
  });

  it("places everything it is given", () => {
    const { nodes, wires } = chain();
    const at = arrange(nodes, wires, W, H);
    expect(at.size).toBe(nodes.length);
  });

  it("starts inside the canvas rather than at its very corner", () => {
    const at = arrange([n("a")], [], W, H);
    expect(at.get("a")!.x).toBeGreaterThan(0);
    expect(at.get("a")!.y).toBeGreaterThan(0);
  });
});

describe("how untidy a graph is", () => {
  it("is nothing for a graph already laid out", () => {
    const nodes = [n("a"), n("b")];
    const wires = [w("a", "b")];
    const at = arrange(nodes, wires, W, H);
    const placed = nodes.map((x) => ({ ...x, ...at.get(x.id)! }));
    expect(untidiness(placed, wires, W, H)).toBe(0);
  });

  it("is everything for a graph piled in one spot", () => {
    const nodes = [n("a"), n("b"), n("c")];
    expect(untidiness(nodes, [w("a", "b"), w("b", "c")], W, H)).toBeGreaterThan(0.5);
  });

  it("is nothing at all for an empty graph, rather than dividing by zero", () => {
    expect(untidiness([], [], W, H)).toBe(0);
  });
});
