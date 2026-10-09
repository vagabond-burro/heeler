// Dragging cards on the canvas, and the card that joins three fields.
//
// (2026-09-01): "it seems there is a 'top' to the graph... it went a
// small distance then it a hard stop. Same when I tried dragging the
// image source left." And: "If I marquee select a bunch of nodes I
// can't drag as a group. Only the node I drag on moves."
import { describe, expect, it } from "vitest";
import React from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { NEUTRAL_NODES, NEUTRAL_WIRES, initialState } from "../data";
import { reduce, migrateNodes, NODE_H, NODE_W, type Command, type State } from "../state";
import { makeNode, portHint, specFor } from "../nodes";
import { serializeGraph } from "../bridge";
import { NodeEditor, inputY } from "../ui/graph";

function run(s: State, ...cmds: Command[]): State {
  return cmds.reduce(reduce, s);
}

/** The editor over a live reducer, with the state readable from outside. */
function harness(start: State) {
  const box: { s: State } = { s: start };
  const Harness = () => {
    const [s, d] = React.useReducer(reduce, start);
    box.s = s;
    return <NodeEditor state={s} dispatch={d} />;
  };
  render(<Harness />);
  return box;
}

const fresh = (): State => {
  const s = initialState();
  return { ...s, nodes: structuredClone(NEUTRAL_NODES), wires: structuredClone(NEUTRAL_WIRES) };
};

describe("dragging a card", () => {
  it("goes wherever the hand takes it, above and left of the origin included", () => {
    const box = harness(fresh());
    const card = screen.getByTestId("node-src");
    const start = box.s.nodes.find((n) => n.id === "src")!;
    fireEvent.mouseDown(card, { clientX: 100, clientY: 100 });
    fireEvent.mouseMove(window, { clientX: 100 - (start.x + 300), clientY: 100 - (start.y + 300) });
    fireEvent.mouseUp(window);
    const moved = box.s.nodes.find((n) => n.id === "src")!;
    expect(moved.x).toBeLessThan(0);
    expect(moved.y).toBeLessThan(0);
  });

  it("carries a marquee selection along as one", () => {
    let s = fresh();
    s = run(s, { type: "select_nodes", ids: ["stdcolor", "exposure"] });
    const box = harness(s);
    const before = Object.fromEntries(box.s.nodes.map((n) => [n.id, [n.x, n.y]]));
    fireEvent.mouseDown(screen.getByTestId("node-stdcolor"), { clientX: 200, clientY: 200 });
    fireEvent.mouseMove(window, { clientX: 250, clientY: 280 });
    fireEvent.mouseUp(window);
    const after = Object.fromEntries(box.s.nodes.map((n) => [n.id, [n.x, n.y]]));
    // Both selected cards moved by the same hand.
    expect(after.stdcolor).toEqual([before.stdcolor[0] + 50, before.stdcolor[1] + 80]);
    expect(after.exposure).toEqual([before.exposure[0] + 50, before.exposure[1] + 80]);
    // The rest stayed.
    expect(after.src).toEqual(before.src);
    expect(after.output).toEqual(before.output);
    // And it is one undo step: the party comes home together.
    const back = run(box.s, { type: "end_gesture" }, { type: "undo" });
    expect(back.nodes.find((n) => n.id === "stdcolor")!.x).toBe(before.stdcolor[0]);
    expect(back.nodes.find((n) => n.id === "exposure")!.x).toBe(before.exposure[0]);
  });

  it("a card outside the selection travels alone", () => {
    let s = fresh();
    s = run(s, { type: "select_nodes", ids: ["stdcolor", "exposure"] });
    const box = harness(s);
    const before = Object.fromEntries(box.s.nodes.map((n) => [n.id, [n.x, n.y]]));
    fireEvent.mouseDown(screen.getByTestId("node-output"), { clientX: 200, clientY: 200 });
    fireEvent.mouseMove(window, { clientX: 260, clientY: 200 });
    fireEvent.mouseUp(window);
    const after = Object.fromEntries(box.s.nodes.map((n) => [n.id, [n.x, n.y]]));
    expect(after.output[0]).toBe(before.output[0] + 60);
    expect(after.stdcolor).toEqual(before.stdcolor);
    expect(after.exposure).toEqual(before.exposure);
  });
});

describe("Channel Join", () => {
  /// "How would I merge the outputs of 3 float into an vector
  /// 3 to input to a color channel?" There was no node for it; now there
  /// is.
  const join = () => makeNode(specFor("heeler.channel_join")!, "join", 500, 300);

  it("is a utility card with three stacked field inputs and an image out", () => {
    const n = join();
    expect(n.hasIn && n.hasIn2 && n.hasIn3 && n.hasOut).toBe(true);
    expect(n.maskOut).toBeFalsy();
    expect(n.maskIn).toBeFalsy();
    // The ports spread the card's height, in reading order.
    expect(inputY(n, "in")).toBeLessThan(inputY(n, "in2"));
    expect(inputY(n, "in2")).toBeLessThan(inputY(n, "in3"));
    // And they say what they are.
    expect(portHint(n, "in").tip).toBe("Channel Join.r");
    expect(portHint(n, "in2").tip).toBe("Channel Join.g");
    expect(portHint(n, "in3").tip).toBe("Channel Join.b");
    expect(portHint(n, "in3").hint).toMatch(/blue plane: takes alpha/);
    expect(portHint(n, "out").hint).toMatch(/Image output: rgb/);
  });

  it("takes fields on all three inputs and refuses an image", () => {
    let s = initialState();
    s = run(s, { type: "add_node", node: join() });
    // Three fields: the sample's two masks and a fresh measure.
    s = run(s, { type: "add_node", node: makeNode(specFor("heeler.measure")!, "m1", 300, 300) });
    s = run(
      s,
      { type: "connect", wire: { from: "lummask", to: "join", toPort: "in", kind: "mask" } },
      { type: "connect", wire: { from: "brushmask", to: "join", toPort: "in2", kind: "mask" } },
      { type: "connect", wire: { from: "m1", to: "join", toPort: "in3", kind: "mask" } },
    );
    const fed = s.wires.filter((w) => w.to === "join").map((w) => w.toPort).sort();
    expect(fed).toEqual(["in", "in2", "in3"]);
    // An image pipe has no port to land on.
    const refused = run(s, { type: "disconnect", to: "join", toPort: "in" }, {
      type: "connect",
      wire: { from: "exposure", to: "join", toPort: "in", kind: "image" },
    });
    expect(refused.wires.some((w) => w.to === "join" && w.toPort === "in")).toBe(false);
    // Its output is an image and feeds an image input (Output's in is
    // taken in the sample graph, so free it first).
    const out = run(
      s,
      { type: "disconnect", to: "output", toPort: "in" },
      { type: "connect", wire: { from: "join", to: "output", toPort: "in", kind: "image" } },
    );
    expect(out.wires.some((w) => w.from === "join" && w.to === "output")).toBe(true);
  });

  it("the third input reaches the engine by its own name", () => {
    let s = initialState();
    s = run(
      s,
      { type: "add_node", node: join() },
      { type: "connect", wire: { from: "lummask", to: "join", toPort: "in3", kind: "mask" } },
    );
    const ser = serializeGraph(s) as unknown as { connections: { from: string[]; to: string[] }[] };
    const c = ser.connections.find((x) => x.to[0] === "join")!;
    // in3 goes through as itself; the desktop maps in/in2(fg)/in3 to r/g/b.
    expect(c.to[1]).toBe("in3");
  });

  it("draws three input ports on the canvas", () => {
    let s = initialState();
    s = run(s, { type: "add_node", node: join() });
    harness(s);
    expect(screen.getByTestId("in-port-join")).toBeInTheDocument();
    expect(screen.getByTestId("in2-port-join")).toBeInTheDocument();
    expect(screen.getByTestId("in3-port-join")).toBeInTheDocument();
    expect(screen.getByTestId("in3-port-join").getAttribute("data-tip")).toBe("Channel Join.b");
  });
});

describe("Depth Map's depth output", () => {
  /// 26.3 Phase 4: the farness plane is a graph value now - a second
  /// output on the Depth Map card that pipes like any field.
  const dm = () => makeNode(specFor("heeler.depth_map")!, "dm", 500, 300);

  it("is a second diamond under the image out, and says what it carries", () => {
    const n = dm();
    expect(n.hasOut && n.depthOut).toBe(true);
    expect(n.maskOut).toBeFalsy();
    expect(portHint(n, "depthOut").tip).toBe("Depth Map.depth");
    expect(portHint(n, "depthOut").hint).toMatch(/farness 0 near to 1 far/);
  });

  it("loads onto a saved card that predates it", () => {
    const [m] = migrateNodes([{ ...dm(), depthOut: undefined }]);
    expect(m.depthOut).toBe(true);
  });

  it("pipes into a mask input and reaches the engine by its own name", () => {
    let s = initialState();
    s = run(
      s,
      { type: "add_node", node: dm() },
      { type: "add_node", node: makeNode(specFor("heeler.invert_mask")!, "inv", 700, 300) },
      { type: "connect", wire: { from: "dm", to: "inv", toPort: "mask", kind: "mask", fromPort: "depth" } },
    );
    expect(s.wires.some((w) => w.from === "dm" && w.fromPort === "depth" && w.to === "inv")).toBe(true);
    const ser = serializeGraph(s) as unknown as { connections: { from: string[]; to: string[] }[] };
    const c = ser.connections.find((x) => x.to[0] === "inv")!;
    expect(c.from).toEqual(["dm", "depth"]);
  });

  it("refuses to land as an image", () => {
    let s = initialState();
    s = run(
      s,
      { type: "add_node", node: dm() },
      { type: "add_node", node: makeNode(specFor("heeler.levels")!, "lv", 700, 300) },
      { type: "connect", wire: { from: "dm", to: "lv", toPort: "in", kind: "image", fromPort: "depth" } },
    );
    expect(s.wires.some((w) => w.from === "dm" && w.to === "lv")).toBe(false);
  });

  it("draws the diamond on the canvas, under the image out", () => {
    let s = initialState();
    s = run(s, { type: "add_node", node: dm() });
    harness(s);
    expect(screen.getByTestId("depth-port-dm")).toBeInTheDocument();
    expect(screen.getByTestId("depth-port-dm").getAttribute("data-tip")).toBe("Depth Map.depth");
    expect(screen.getByTestId("out-port-dm")).toBeInTheDocument();
  });
});

describe("File's mask output", () => {
  /// 26.3 Phase 6: a File card's page alpha (or the channel its Layer
  /// field names) is a graph value now, a second diamond that pipes
  /// like the Depth Map's farness plane.
  const file = () => makeNode(specFor("heeler.file")!, "f", 500, 300);

  it("is a second diamond on the card, and says what it carries", () => {
    const n = file();
    expect(n.hasOut && n.fileMaskOut).toBe(true);
    expect(n.maskOut).toBeFalsy();
    expect(portHint(n, "fileMask").tip).toBe("File.mask");
    expect(portHint(n, "fileMask").hint).toMatch(/Page alpha output/);
  });

  it("loads onto a saved card that predates it", () => {
    const [m] = migrateNodes([{ ...file(), fileMaskOut: undefined }]);
    expect(m.fileMaskOut).toBe(true);
  });

  it("pipes into a mask input and reaches the engine by its own name", () => {
    let s = initialState();
    s = run(
      s,
      { type: "add_node", node: file() },
      { type: "add_node", node: makeNode(specFor("heeler.invert_mask")!, "inv", 700, 300) },
      { type: "connect", wire: { from: "f", to: "inv", toPort: "mask", kind: "mask", fromPort: "mask" } },
    );
    expect(s.wires.some((w) => w.from === "f" && w.fromPort === "mask" && w.to === "inv")).toBe(true);
    const ser = serializeGraph(s) as unknown as { connections: { from: string[]; to: string[] }[] };
    const c = ser.connections.find((x) => x.to[0] === "inv")!;
    expect(c.from).toEqual(["f", "mask"]);
  });

  it("refuses to land as an image, while the image out still pipes as rgb", () => {
    let s = initialState();
    s = run(
      s,
      { type: "add_node", node: file() },
      { type: "add_node", node: makeNode(specFor("heeler.levels")!, "lv", 700, 300) },
      { type: "connect", wire: { from: "f", to: "lv", toPort: "in", kind: "image", fromPort: "mask" } },
    );
    expect(s.wires.some((w) => w.from === "f" && w.to === "lv")).toBe(false);
    // The card's ordinary output is untouched by the diamond's
    // existence: an image pipe off it lands as it always did.
    s = run(s, { type: "connect", wire: { from: "f", to: "lv", toPort: "in", kind: "image" } });
    expect(s.wires.some((w) => w.from === "f" && w.to === "lv" && !w.fromPort)).toBe(true);
  });

  it("draws the diamond on the canvas, and the Layer field is a text param", () => {
    let s = initialState();
    s = run(s, { type: "add_node", node: file() });
    harness(s);
    expect(screen.getByTestId("file-mask-port-f")).toBeInTheDocument();
    expect(screen.getByTestId("file-mask-port-f").getAttribute("data-tip")).toBe("File.mask");
    expect(screen.getByTestId("out-port-f")).toBeInTheDocument();
    // The field itself lives on the inspector face; here the command
    // it dispatches lands on the card.
    s = run(s, { type: "set_text_param", id: "f", param: "layer", value: "page 2" });
    expect(s.nodes.find((n) => n.id === "f")?.textParams?.layer).toBe("page 2");
  });
});

describe("moving a named field pipe by its input handle", () => {
  it.each([
    ["heeler.depth_map", "depth"],
    ["heeler.file", "mask"],
    ["heeler.export_layer", "mask"],
  ] as const)("preserves %s's %s output in the serialized connection", (type, fromPort) => {
    let s = fresh();
    s = { ...s, nodes: [
      makeNode(specFor(type)!, "field", 50, 50),
      makeNode(specFor("heeler.levels")!, "old", 300, 50),
      makeNode(specFor("heeler.levels")!, "next", 600, 50),
    ], wires: [{ from: "field", to: "old", toPort: "mask", kind: "mask", fromPort }] };
    const box = harness(s);
    fireEvent.mouseDown(screen.getByTestId("mask-head-old"), { clientX: 309, clientY: 50 + NODE_H });
    fireEvent.mouseMove(window, { clientX: 600 + NODE_W / 2, clientY: 50 + NODE_H / 2 });
    fireEvent.mouseUp(window, { clientX: 600 + NODE_W / 2, clientY: 50 + NODE_H / 2 });
    const graph = serializeGraph(box.s) as unknown as { connections: { from: string[]; to: string[] }[] };
    expect(graph.connections.find((c) => c.to[0] === "next" && c.to[1] === "mask")?.from).toEqual(["field", fromPort]);
  });
});

describe("dropping a hand-dragged pipe", () => {
  /// (2026-09-17): "Range Mask.alpha to Color.MASK - they were connected
  /// before and I broke the connection and am trying to reconnect." The
  /// pipe and the ports were fine; the drop died silently, twice over:
  /// the mask diamond hangs below the card's rectangle, which is all the
  /// hit-test counted, and a card sitting UNDER the target won the test
  /// because it came first in the array.
  const withRangeMask = (): State => {
    let s = fresh();
    s = run(s, { type: "add_node", node: makeNode(specFor("heeler.range_mask")!, "rangemask", 150, 300) });
    s = run(s, { type: "connect", wire: { from: "src", to: "rangemask", toPort: "in", kind: "image" } });
    return s;
  };
  const rangeFeedsColor = (s: State) =>
    s.wires.some((w) => w.from === "rangemask" && w.to === "stdcolor" && w.toPort === "mask");
  /** Drags the Range Mask's field out diamond to the graph point. */
  const dragRangeOutTo = (s: State, gx: number, gy: number) => {
    const rm = s.nodes.find((n) => n.id === "rangemask")!;
    fireEvent.mouseDown(screen.getByTestId("mask-port-rangemask"), { clientX: rm.x + NODE_W, clientY: rm.y + 39 });
    fireEvent.mouseMove(window, { clientX: gx, clientY: gy });
    fireEvent.mouseUp(window, { clientX: gx, clientY: gy });
  };
  const color = (s: State) => s.nodes.find((n) => n.id === "stdcolor")!;

  it("a mask pipe dropped on the card's middle connects", () => {
    const box = harness(withRangeMask());
    const c = color(box.s);
    dragRangeOutTo(box.s, c.x + NODE_W / 2, c.y + NODE_H / 2);
    expect(rangeFeedsColor(box.s)).toBe(true);
  });

  it("a mask pipe dropped on the mask diamond's overhanging tip connects", () => {
    const box = harness(withRangeMask());
    const c = color(box.s);
    // The diamond's bottom point sits a few px below the card's edge.
    dragRangeOutTo(box.s, c.x + 9, c.y + NODE_H + 4);
    expect(rangeFeedsColor(box.s)).toBe(true);
  });

  it("a mask pipe dropped on the alpha diamond's overhanging tip connects", () => {
    const box = harness(withRangeMask());
    const o = box.s.nodes.find((n) => n.id === "output")!;
    dragRangeOutTo(box.s, o.x + 9, o.y + NODE_H + 4);
    expect(box.s.wires.some((w) => w.from === "rangemask" && w.to === "output" && w.toPort === "alpha")).toBe(true);
  });

  it("the topmost card under the cursor takes the drop, not the first in the array", () => {
    let s = withRangeMask();
    const c = color(s);
    // A masking card across the Color card's mask corner, EARLIER in
    // the array: it renders underneath and cannot take a mask pipe, so
    // a first-match hit-test kills the drop on the visible card.
    s = { ...s, nodes: [{ ...makeNode(specFor("heeler.brush_mask")!, "undermask", c.x - 60, c.y + 30), strokes: [] }, ...s.nodes] };
    const box = harness(s);
    dragRangeOutTo(box.s, color(box.s).x + 9, color(box.s).y + NODE_H - 1);
    expect(rangeFeedsColor(box.s)).toBe(true);
  });

  it("a tail dropped over overlapped sources picks the topmost one", () => {
    let s = withRangeMask();
    // Two eligible image sources sharing one spot; the later renders on top.
    s = run(s, { type: "add_node", node: makeNode(specFor("heeler.levels")!, "under", 700, 300) });
    s = run(s, { type: "add_node", node: makeNode(specFor("heeler.levels")!, "over", 700, 300) });
    s = run(s, { type: "disconnect", to: "rangemask", toPort: "in" });
    const box = harness(s);
    const rm = box.s.nodes.find((n) => n.id === "rangemask")!;
    fireEvent.mouseDown(screen.getByTestId("in-port-rangemask"), { clientX: rm.x, clientY: rm.y + 40 });
    fireEvent.mouseMove(window, { clientX: 700 + NODE_W / 2, clientY: 300 + NODE_H / 2 });
    fireEvent.mouseUp(window, { clientX: 700 + NODE_W / 2, clientY: 300 + NODE_H / 2 });
    const feed = box.s.wires.find((w) => w.to === "rangemask" && w.toPort === "in");
    expect(feed?.from).toBe("over");
  });
});

describe("dropping a field node onto a pipe", () => {
  /// 26.3. "If a node has Alpha in and out and is
  /// dragged over a Alpha connection it should be able to connect."
  /** The midpoint of the sample graph's lummask -> cbal mask pipe. */
  const maskPipeMid = (s: State) => {
    const lm = s.nodes.find((n) => n.id === "lummask")!;
    const cb = s.nodes.find((n) => n.id === "cbal")!;
    return { x: (lm.x + NODE_W + cb.x + 9) / 2, y: (lm.y + 39 + cb.y + NODE_H - 1) / 2 };
  };
  /** Drags the card so its drop probe (center, y + 35) lands on the point. */
  const dragNodeOver = (s: State, id: string, gx: number, gy: number) => {
    const n = s.nodes.find((k) => k.id === id)!;
    fireEvent.mouseDown(screen.getByTestId(`node-${id}`), { clientX: n.x + 8, clientY: n.y + 8 });
    fireEvent.mouseMove(window, { clientX: gx - NODE_W / 2 + 8, clientY: gy - 35 + 8 });
    fireEvent.mouseUp(window);
  };

  it("an invert mask dragged over a mask pipe splices into it", () => {
    let s = initialState();
    s = run(s, { type: "add_node", node: makeNode(specFor("heeler.invert_mask")!, "inv", 40, 500) });
    const box = harness(s);
    const mid = maskPipeMid(box.s);
    dragNodeOver(box.s, "inv", mid.x, mid.y);
    expect(box.s.wires.some((w) => w.from === "lummask" && w.to === "inv" && w.toPort === "mask")).toBe(true);
    expect(box.s.wires.some((w) => w.from === "inv" && w.to === "cbal" && w.toPort === "mask")).toBe(true);
    expect(box.s.wires.some((w) => w.from === "lummask" && w.to === "cbal")).toBe(false);
  });

  it("a picture-fed mask node dragged over a mask pipe is just a move", () => {
    let s = initialState();
    s = run(s, { type: "add_node", node: makeNode(specFor("heeler.range_mask")!, "rangemask", 40, 500) });
    s = run(s, { type: "connect", wire: { from: "src", to: "rangemask", toPort: "in", kind: "image" } });
    const box = harness(s);
    const mid = maskPipeMid(box.s);
    dragNodeOver(box.s, "rangemask", mid.x, mid.y);
    // The pipe is untouched and the node gained and lost nothing.
    expect(box.s.wires.some((w) => w.from === "lummask" && w.to === "cbal" && w.toPort === "mask")).toBe(true);
    expect(box.s.wires.filter((w) => w.from === "rangemask" || w.to === "rangemask")).toEqual([
      { from: "src", to: "rangemask", toPort: "in", kind: "image" },
    ]);
  });
});
