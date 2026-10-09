// (2026-10-01), testing the Displacement Map with two Math nodes as
// constant fields: "I disconnected the Displacement map node and
// dragged it between image source and standard color. When I did that
// both math nodes dropped their connection. I could reconnect the first
// but the second won't reconnect. When I drag from the Displacement
// Map.Y attribute the output on the second math node highlights, that
// is great. However when dragging the wire from the Math.out the
// diamond on the Displacement Map.Y does not highlight. This is a
// consistent issue where when dragging a wire from the IN attribute the
// OUT attributes that are compatible highlight, but not when I drag
// from an OUT the IN attributes/connections do not"
//
// Three causes, three holds here:
// 1. A pipe drawn out of an output lit whole cards, never an input, and
//    judged them by its own rule; a pipe drawn out of an input lit
//    outputs by another. Now one rule (pipeFits over the reducer's
//    seatTakes) answers both ends, and every input it passes is ringed.
// 2. Moving a node onto another pipe (splice) or pulling it loose
//    (extract) dropped every wire it had; now only its main in and out
//    move, its fields and second inputs stay.
// 3. The connect reducer took the alpha diamond on Output and the
//    Export Layer alone, so the Displacement Map's Y (and Alpha
//    Association's Replace alpha) lit as a target and refused the drop.
import { afterEach, describe, expect, it } from "vitest";
import React from "react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { App } from "../app";
import { initialState } from "../data";
import { NODE_W, reduce, seatTakes, type Command, type NodeCard, type State, type Wire } from "../state";
import { NODE_CATALOG, makeNode, specFor } from "../nodes";
import { BUILTIN_RECIPES } from "../noderecipes";
import { Inspector, NodeEditor, drawnSeats, pipeFits, portCenter, sourceSeat, type InSeat } from "../ui/graph";
import { choose, menuRows, menuValue } from "./menuhelp";

afterEach(() => cleanup());

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

const card = (type: string, id: string, x: number, y: number) => makeNode(specFor(type)!, id, x, y);

function bench(nodes: NodeCard[], wires: Wire[] = [], extra: Command[] = []): State {
  let s: State = { ...initialState(), graphView: { x: 0, y: 0, zoom: 1 }, nodes, wires, undoStack: [], redoStack: [] };
  for (const c of extra) s = reduce(s, c);
  return { ...s, undoStack: [], redoStack: [] };
}

const IN_TESTID: Record<InSeat, string> = {
  in: "in-port",
  in2: "in2-port",
  in3: "in3-port",
  mask: "mask-in-port",
  alpha: "alpha-in-port",
  depth: "depth-in-port",
};
type OutSeat = "out" | "maskOut" | "depthOut" | "fileMask";
const OUT_TESTID: Record<OutSeat, string> = {
  out: "out-port",
  maskOut: "mask-port",
  depthOut: "depth-port",
  fileMask: "file-mask-port",
};

const inPort = (id: string, seat: InSeat) => screen.getByTestId(`${IN_TESTID[seat]}-${id}`);
const lit = (el: HTMLElement) => el.hasAttribute("data-wire-in");
const aimed = (el: HTMLElement) => el.hasAttribute("data-wire-in-target");

/** Presses on the element, moves to graph point q (the view is at the
 * origin at 100%, so graph and client points agree), and holds. */
function press(testId: string, p: { x: number; y: number }, q: { x: number; y: number }) {
  fireEvent.mouseDown(screen.getByTestId(testId), { clientX: p.x, clientY: p.y, button: 0, buttons: 1 });
  fireEvent.mouseMove(window, { clientX: q.x, clientY: q.y, buttons: 1 });
}
const release = (q: { x: number; y: number }) => fireEvent.mouseUp(window, { clientX: q.x, clientY: q.y });

/** The owner's bench: the picture through the Displacement Map into
 * Levels, two Math nodes (constants 0.6 and 0.4) beside it, nothing
 * on its diamonds yet.*/
function displacementBench(): State {
  const m1 = card("heeler.math", "m1", 40, 300);
  const m2 = card("heeler.math", "m2", 40, 460);
  m1.params = { ...m1.params, constant: 0.6 };
  m2.params = { ...m2.params, constant: 0.4 };
  return bench(
    [
      card("heeler.image_source", "src", 40, 40),
      card("heeler.displacement_map", "disp", 340, 40),
      card("heeler.levels", "lv", 640, 40),
      m1,
      m2,
    ],
    [
      { from: "src", to: "disp", toPort: "in", kind: "image" },
      { from: "disp", to: "lv", toPort: "in", kind: "image" },
    ],
  );
}

describe("a pipe drawn out of an output lights the inputs it can land on", () => {
  it("Math.out lights the Displacement Map's X and Y diamonds, not its picture input, and lands on the one aimed at", () => {
    const box = harness(displacementBench());
    const s = box.s;
    const m2 = s.nodes.find((n) => n.id === "m2")!;
    const disp = s.nodes.find((n) => n.id === "disp")!;
    const y = portCenter(disp, "alpha");
    press("mask-port-m2", portCenter(m2, "maskOut"), y);
    // Every input a field may land on, on every card, is ringed.
    expect(lit(inPort("disp", "alpha"))).toBe(true);
    expect(lit(inPort("disp", "mask"))).toBe(true);
    expect(lit(inPort("lv", "mask"))).toBe(true);
    // A picture input takes no field.
    expect(lit(inPort("disp", "in"))).toBe(false);
    expect(lit(inPort("lv", "in"))).toBe(false);
    // The Math nodes' operands take one, but not its own.
    expect(lit(inPort("m1", "in"))).toBe(true);
    expect(lit(inPort("m2", "in"))).toBe(false);
    // The diamond under the pointer is the drop's.
    expect(aimed(inPort("disp", "alpha"))).toBe(true);
    expect(aimed(inPort("disp", "mask"))).toBe(false);
    release(y);
    expect(box.s.wires).toContainEqual({ from: "m2", to: "disp", toPort: "alpha", kind: "mask" });
    expect(box.s.undoStack).toHaveLength(1);

    const m1 = box.s.nodes.find((n) => n.id === "m1")!;
    const x = portCenter(disp, "mask");
    press("mask-port-m1", portCenter(m1, "maskOut"), x);
    expect(aimed(inPort("disp", "mask"))).toBe(true);
    release(x);
    expect(box.s.wires).toContainEqual({ from: "m1", to: "disp", toPort: "mask", kind: "mask" });
  });

  it("drawn from the Y diamond, Math.out lights and the drop connects (the same rule from the input end)", () => {
    const box = harness(displacementBench());
    const disp = box.s.nodes.find((n) => n.id === "disp")!;
    const m2 = box.s.nodes.find((n) => n.id === "m2")!;
    const out = portCenter(m2, "maskOut");
    press("alpha-in-port-disp", portCenter(disp, "alpha"), out);
    expect(screen.getByTestId("mask-port-m2").hasAttribute("data-wire-source")).toBe(true);
    // A picture output is no source for a field input.
    expect(screen.getByTestId("out-port-src").hasAttribute("data-wire-source")).toBe(false);
    release(out);
    expect(box.s.wires).toContainEqual({ from: "m2", to: "disp", toPort: "alpha", kind: "mask" });
  });

  // Every input kind, drawn from the output end and from the input end:
  // the same input lights, the same wire is made.
  type Case = {
    name: string;
    src: [string, string];
    out: OutSeat;
    dst: [string, string];
    seat: InSeat;
    wire: Partial<Wire>;
    setup?: Command[];
  };
  const recipe = (id: string) => BUILTIN_RECIPES.find((r) => r.id === id)!;
  const cases: Case[] = [
    { name: "picture in", src: ["heeler.image_source", "a"], out: "out", dst: ["heeler.levels", "b"], seat: "in", wire: { kind: "image" } },
    { name: "second picture (in2)", src: ["heeler.levels", "a"], out: "out", dst: ["heeler.merge", "b"], seat: "in2", wire: { kind: "image" } },
    { name: "Math's second operand (in2)", src: ["heeler.range_mask", "a"], out: "maskOut", dst: ["heeler.math", "b"], seat: "in2", wire: { kind: "mask" } },
    { name: "Channel Join's third plane (in3)", src: ["heeler.math", "a"], out: "maskOut", dst: ["heeler.channel_join", "b"], seat: "in3", wire: { kind: "mask" } },
    { name: "Channel Join's alpha plane", src: ["heeler.math", "a"], out: "maskOut", dst: ["heeler.channel_join", "b"], seat: "alpha", wire: { kind: "mask" } },
    { name: "the mask diamond", src: ["heeler.range_mask", "a"], out: "maskOut", dst: ["heeler.levels", "b"], seat: "mask", wire: { kind: "mask" } },
    // Docs review 2026-10-01: these Utility nodes take a mask in the
    // engine and drew no diamond (graphmaskseat.test.ts holds them all).
    { name: "Color Transform's mask diamond", src: ["heeler.luminance_range_mask", "a"], out: "maskOut", dst: ["heeler.color_transform", "b"], seat: "mask", wire: { kind: "mask" } },
    { name: "Channel Gain's mask diamond", src: ["heeler.range_mask", "a"], out: "maskOut", dst: ["heeler.channel_gain", "b"], seat: "mask", wire: { kind: "mask" } },
    { name: "Channel Mixer's mask diamond", src: ["heeler.range_mask", "a"], out: "maskOut", dst: ["heeler.channel_mixer", "b"], seat: "mask", wire: { kind: "mask" } },
    { name: "Invert's mask diamond", src: ["heeler.range_mask", "a"], out: "maskOut", dst: ["heeler.invert", "b"], seat: "mask", wire: { kind: "mask" } },
    { name: "Blend Mode's mask diamond", src: ["heeler.range_mask", "a"], out: "maskOut", dst: ["heeler.blend", "b"], seat: "mask", wire: { kind: "mask" } },
    { name: "Output's alpha diamond", src: ["heeler.math", "a"], out: "maskOut", dst: ["heeler.output", "b"], seat: "alpha", wire: { kind: "mask" } },
    { name: "the Export Layer's alpha diamond", src: ["heeler.math", "a"], out: "maskOut", dst: ["heeler.export_layer", "b"], seat: "alpha", wire: { kind: "mask" } },
    { name: "Alpha Association's Replace alpha", src: ["heeler.math", "a"], out: "maskOut", dst: ["heeler.alpha_association", "b"], seat: "alpha", wire: { kind: "mask" } },
    { name: "the Displacement Map's X (mask diamond, engine x)", src: ["heeler.math", "a"], out: "maskOut", dst: ["heeler.displacement_map", "b"], seat: "mask", wire: { kind: "mask" } },
    { name: "the Displacement Map's Y (alpha diamond, engine y)", src: ["heeler.math", "a"], out: "maskOut", dst: ["heeler.displacement_map", "b"], seat: "alpha", wire: { kind: "mask" } },
    { name: "Guided Filter (Mask)'s target diamond", src: ["heeler.range_mask", "a"], out: "maskOut", dst: ["heeler.guided_filter_mask", "b"], seat: "mask", wire: { kind: "mask" } },
    { name: "Edge Field's field diamond", src: ["heeler.math", "a"], out: "maskOut", dst: ["heeler.edge_field", "b"], seat: "mask", wire: { kind: "mask" } },
    { name: "a depth input from the Depth Map's plane", src: ["heeler.depth_map", "a"], out: "depthOut", dst: ["heeler.fog", "b"], seat: "depth", wire: { kind: "mask", fromPort: "depth" } },
    { name: "a mask node's depth input", src: ["heeler.depth_map", "a"], out: "depthOut", dst: ["heeler.range_mask", "b"], seat: "depth", wire: { kind: "mask", fromPort: "depth" } },
    { name: "a field from a File's alpha", src: ["heeler.file", "a"], out: "fileMask", dst: ["heeler.levels", "b"], seat: "mask", wire: { kind: "mask", fromPort: "mask" } },
    {
      name: "a recipe group's picture input",
      src: ["heeler.image_source", "a"],
      out: "out",
      dst: ["", "b"],
      seat: "in",
      wire: { kind: "image" },
      setup: [{ type: "add_recipe", recipe: recipe("depth_color_matte"), x: 400, y: 300, id: "b" }],
    },
    {
      name: "a recipe group's depth input",
      src: ["heeler.linear_mask", "a"],
      out: "maskOut",
      dst: ["", "b"],
      seat: "depth",
      wire: { kind: "mask" },
      setup: [{ type: "add_recipe", recipe: recipe("depth_color_matte"), x: 400, y: 300, id: "b" }],
    },
  ];
  const caseBench = (c: Case) =>
    bench(
      [card(c.src[0], c.src[1], 40, 40), ...(c.dst[0] ? [card(c.dst[0], c.dst[1], 400, 300)] : [])],
      [],
      c.setup,
    );
  const wireOf = (c: Case): Wire => ({ from: c.src[1], to: c.dst[1], toPort: c.seat, ...c.wire }) as Wire;

  it.each(cases)("output first: $name", (c) => {
    const box = harness(caseBench(c));
    const a = box.s.nodes.find((n) => n.id === c.src[1])!;
    const b = box.s.nodes.find((n) => n.id === c.dst[1])!;
    const at = portCenter(b, c.seat);
    press(`${OUT_TESTID[c.out]}-${a.id}`, portCenter(a, c.out), at);
    expect(lit(inPort(b.id, c.seat))).toBe(true);
    expect(aimed(inPort(b.id, c.seat))).toBe(true);
    release(at);
    expect(box.s.wires).toContainEqual(expect.objectContaining(wireOf(c)));
    expect(box.s.wires.filter((w) => w.to === b.id)).toHaveLength(1);
  });

  it.each(cases)("input first: $name", (c) => {
    const box = harness(caseBench(c));
    const a = box.s.nodes.find((n) => n.id === c.src[1])!;
    const b = box.s.nodes.find((n) => n.id === c.dst[1])!;
    const out = portCenter(a, c.out);
    press(`${IN_TESTID[c.seat]}-${b.id}`, portCenter(b, c.seat), out);
    expect(screen.getByTestId(`${OUT_TESTID[c.out]}-${a.id}`).hasAttribute("data-wire-source")).toBe(true);
    release(out);
    expect(box.s.wires).toContainEqual(expect.objectContaining(wireOf(c)));
    expect(box.s.wires.filter((w) => w.to === b.id)).toHaveLength(1);
  });
});

describe("one rule from either end", () => {
  // The sources a pipe can leave, each by the kind its port carries.
  const sources: { type: string; kind: "mask" | "image"; fromPort?: Wire["fromPort"] }[] = [
    { type: "heeler.image_source", kind: "image" },
    { type: "heeler.levels", kind: "image" },
    { type: "heeler.range_mask", kind: "mask" },
    { type: "heeler.math", kind: "mask" },
    { type: "heeler.depth_map", kind: "mask", fromPort: "depth" },
    { type: "heeler.file", kind: "mask", fromPort: "mask" },
    { type: "heeler.export_layer", kind: "image", fromPort: "image" },
  ];

  it("for every node type and every input it draws, the hand lights exactly what the reducer connects", () => {
    let checked = 0;
    for (const spec of NODE_CATALOG) {
      const dst = makeNode(spec, "dst", 400, 300);
      for (const src of sources) {
        const from = makeNode(specFor(src.type)!, "from", 40, 40);
        expect(sourceSeat(src.kind, from)).not.toBeNull();
        const s = bench([from, dst]);
        for (const seat of drawnSeats(dst)) {
          const fits = pipeFits(s.wires, from, src.kind, dst, seat);
          const wire: Wire = { from: "from", to: "dst", toPort: seat, kind: src.kind, ...(src.fromPort ? { fromPort: src.fromPort } : {}) };
          const made = reduce(s, { type: "connect", wire }).wires.length === 1;
          expect({ type: spec.type, source: src.type, seat, made }).toEqual({ type: spec.type, source: src.type, seat, made: fits });
          // And the type half of it is the reducer's own rule.
          expect(fits).toBe(seatTakes(dst, seat, src.kind === "mask"));
          checked++;
        }
      }
    }
    expect(checked).toBeGreaterThan(500);
  });
});

describe("moving a node onto another pipe keeps its side inputs", () => {
  /** The owner's graph after his first wiring: Image Source into Standard
   * Color into the Displacement Map into Levels, both Math nodes on its
   * diamonds.*/
  function wired(): State {
    const s = displacementBench();
    return {
      ...s,
      nodes: [...s.nodes, card("heeler.standard_color", "stdcolor", 340, 40)].map((n) =>
        n.id === "disp" ? { ...n, x: 640, y: 40 } : n.id === "lv" ? { ...n, x: 940, y: 40 } : n,
      ),
      wires: [
        { from: "src", to: "stdcolor", toPort: "in", kind: "image" },
        { from: "stdcolor", to: "disp", toPort: "in", kind: "image" },
        { from: "disp", to: "lv", toPort: "in", kind: "image" },
        { from: "m1", to: "disp", toPort: "mask", kind: "mask" },
        { from: "m2", to: "disp", toPort: "alpha", kind: "mask" },
      ],
    };
  }

  it("dragged between Image Source and Standard Color, the Displacement Map keeps both Math wires, in one undo step", () => {
    const box = harness(wired());
    const disp = box.s.nodes.find((n) => n.id === "disp")!;
    const src = box.s.nodes.find((n) => n.id === "src")!;
    const std = box.s.nodes.find((n) => n.id === "stdcolor")!;
    // The card's center over the middle of the Image Source to Standard
    // Color pipe.
    const a = portCenter(src, "out");
    const b = portCenter(std, "in");
    const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    const grip = { x: disp.x + 10, y: disp.y + 10 };
    const to = { x: mid.x - NODE_W / 2 + 10, y: mid.y - 35 + 10 };
    fireEvent.mouseDown(screen.getByTestId("node-disp"), { clientX: grip.x, clientY: grip.y, button: 0, buttons: 1 });
    fireEvent.mouseMove(window, { clientX: to.x, clientY: to.y, buttons: 1 });
    const before = box.s.undoStack.length;
    fireEvent.mouseUp(window, { clientX: to.x, clientY: to.y });
    const w = box.s.wires;
    expect(w).toContainEqual({ from: "src", to: "disp", toPort: "in", kind: "image" });
    expect(w).toContainEqual(expect.objectContaining({ from: "disp", to: "stdcolor", toPort: "in", kind: "image" }));
    // The hole it left healed.
    expect(w).toContainEqual(expect.objectContaining({ from: "stdcolor", to: "lv", toPort: "in", kind: "image" }));
    // Its fields came along.
    expect(w).toContainEqual({ from: "m1", to: "disp", toPort: "mask", kind: "mask" });
    expect(w).toContainEqual({ from: "m2", to: "disp", toPort: "alpha", kind: "mask" });
    expect(w).toHaveLength(5);
    // The splice is one step.
    expect(box.s.undoStack.length).toBe(before + 1);
    expect(box.s.nodes.find((n) => n.id === "disp")).toBeDefined();
  });

  it("splice_node_into_wire keeps a Merge's second picture, and Option-drag loose (extract) keeps the fields", () => {
    let s = wired();
    s = reduce(s, { type: "extract_node", id: "disp" });
    expect(s.wires).toContainEqual(expect.objectContaining({ from: "stdcolor", to: "lv", toPort: "in" }));
    expect(s.wires).toContainEqual({ from: "m1", to: "disp", toPort: "mask", kind: "mask" });
    expect(s.wires).toContainEqual({ from: "m2", to: "disp", toPort: "alpha", kind: "mask" });
    expect(s.wires.some((w) => w.to === "disp" && w.toPort === "in")).toBe(false);
    s = reduce(s, { type: "undo" });
    expect(s.wires).toEqual(wired().wires);

    let m = bench(
      [
        card("heeler.image_source", "src", 0, 0),
        card("heeler.levels", "a", 300, 0),
        card("heeler.levels", "b", 600, 0),
        card("heeler.merge", "mg", 300, 300),
        card("heeler.levels", "fg", 0, 300),
      ],
      [
        { from: "src", to: "a", toPort: "in", kind: "image" },
        { from: "a", to: "b", toPort: "in", kind: "image" },
        { from: "src", to: "fg", toPort: "in", kind: "image" },
        { from: "fg", to: "mg", toPort: "in2", kind: "image" },
      ],
    );
    m = reduce(m, { type: "splice_node_into_wire", id: "mg", from: "a", to: "b", toPort: "in" });
    expect(m.wires).toContainEqual({ from: "fg", to: "mg", toPort: "in2", kind: "image" });
    expect(m.wires).toContainEqual(expect.objectContaining({ from: "a", to: "mg", toPort: "in" }));
    expect(m.wires).toContainEqual(expect.objectContaining({ from: "mg", to: "b", toPort: "in" }));
  });

  it("a side input that would close a loop at the new place is the one let go", () => {
    // The Math reads Levels B; the Displacement Map moves in front of B.
    let s = bench(
      [
        card("heeler.image_source", "src", 0, 0),
        card("heeler.levels", "b", 300, 0),
        card("heeler.luminance_extract", "lum", 600, 300),
        card("heeler.displacement_map", "disp", 300, 300),
      ],
      [
        { from: "src", to: "b", toPort: "in", kind: "image" },
        { from: "b", to: "lum", toPort: "in", kind: "image" },
        { from: "lum", to: "disp", toPort: "mask", kind: "mask" },
      ],
    );
    s = reduce(s, { type: "splice_node_into_wire", id: "disp", from: "src", to: "b", toPort: "in" });
    expect(s.wires).toContainEqual(expect.objectContaining({ from: "src", to: "disp", toPort: "in" }));
    expect(s.wires).toContainEqual(expect.objectContaining({ from: "disp", to: "b", toPort: "in" }));
    expect(s.wires.some((w) => w.from === "lum" && w.to === "disp")).toBe(false);
  });

  it("a field pass-through spliced onto a field pipe keeps its second operand", () => {
    let s = bench(
      [
        card("heeler.range_mask", "rm", 0, 0),
        card("heeler.levels", "lv", 600, 0),
        card("heeler.math", "mt", 300, 300),
        card("heeler.math", "k", 0, 300),
      ],
      [
        { from: "rm", to: "lv", toPort: "mask", kind: "mask" },
        { from: "k", to: "mt", toPort: "in2", kind: "mask" },
      ],
    );
    s = reduce(s, { type: "splice_node_into_wire", id: "mt", from: "rm", to: "lv", toPort: "mask" });
    expect(s.wires).toContainEqual(expect.objectContaining({ from: "rm", to: "mt", toPort: "in" }));
    expect(s.wires).toContainEqual(expect.objectContaining({ from: "mt", to: "lv", toPort: "mask" }));
    expect(s.wires).toContainEqual({ from: "k", to: "mt", toPort: "in2", kind: "mask" });
  });
});

describe("the Y diamond reconnects", () => {
  it("taken off and drawn again, from either end", () => {
    const box = harness(displacementBench());
    const disp = () => box.s.nodes.find((n) => n.id === "disp")!;
    const m2 = () => box.s.nodes.find((n) => n.id === "m2")!;
    // Wired output first.
    press("mask-port-m2", portCenter(m2(), "maskOut"), portCenter(disp(), "alpha"));
    release(portCenter(disp(), "alpha"));
    expect(box.s.wires).toContainEqual({ from: "m2", to: "disp", toPort: "alpha", kind: "mask" });
    // Lifted by its input end and dropped on empty canvas: off.
    const empty = { x: 1200, y: 900 };
    press("alpha-in-port-disp", portCenter(disp(), "alpha"), empty);
    release(empty);
    expect(box.s.wires.some((w) => w.to === "disp" && w.toPort === "alpha")).toBe(false);
    // Drawn again from the diamond.
    press("alpha-in-port-disp", portCenter(disp(), "alpha"), portCenter(m2(), "maskOut"));
    release(portCenter(m2(), "maskOut"));
    expect(box.s.wires).toContainEqual({ from: "m2", to: "disp", toPort: "alpha", kind: "mask" });
  });
});

type Door = { dispatch: (c: Command) => void; state: () => State };
const door = () => (window as unknown as { __heeler: Door }).__heeler;

describe("in the app", () => {
  it("the owner's run: both Math nodes wired output first, the Displacement Map moved between Image Source and Standard Color, and Y taken off and back on", async () => {
    render(<App />);
    await act(async () => {
      fireEvent.click(screen.getByRole("tablist", { name: /workspace mode/i }).children[1] as HTMLElement);
    });
    const start = door().state();
    const feed = start.wires.find((w) => w.from === "src" && w.toPort === "in" && w.kind === "image")!;
    expect(feed).toBeDefined();
    const m1 = card("heeler.math", "m1", 3000, 3300);
    const m2 = card("heeler.math", "m2", 3000, 3500);
    m1.params = { ...m1.params, constant: 0.6 };
    m2.params = { ...m2.params, constant: 0.4 };
    act(() => {
      door().dispatch({ type: "add_node", node: card("heeler.displacement_map", "disp", 3300, 3300) });
      door().dispatch({ type: "add_node", node: m1 });
      door().dispatch({ type: "add_node", node: m2 });
    });
    const view = () => door().state().graphView;
    const client = (p: { x: number; y: number }) => ({ x: p.x * view().zoom + view().x, y: p.y * view().zoom + view().y });
    const node = (id: string) => door().state().nodes.find((n) => n.id === id)!;
    const drag = (testId: string, from: { x: number; y: number }, to: { x: number; y: number }) => {
      const a = client(from);
      const b = client(to);
      fireEvent.mouseDown(screen.getByTestId(testId), { clientX: a.x, clientY: a.y, button: 0, buttons: 1 });
      fireEvent.mouseMove(window, { clientX: b.x, clientY: b.y, buttons: 1 });
      fireEvent.mouseUp(window, { clientX: b.x, clientY: b.y });
    };
    // The test as given: X and Y wired from Math.out.
    drag("mask-port-m1", portCenter(node("m1"), "maskOut"), portCenter(node("disp"), "mask"));
    drag("mask-port-m2", portCenter(node("m2"), "maskOut"), portCenter(node("disp"), "alpha"));
    expect(door().state().wires).toContainEqual({ from: "m1", to: "disp", toPort: "mask", kind: "mask" });
    expect(door().state().wires).toContainEqual({ from: "m2", to: "disp", toPort: "alpha", kind: "mask" });
    // Moved onto the picture's first pipe.
    const a = portCenter(node(feed.from), "out");
    const b = portCenter(node(feed.to), feed.toPort);
    const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    const d = node("disp");
    drag("node-disp", { x: d.x + 10, y: d.y + 10 }, { x: mid.x - NODE_W / 2 + 10, y: mid.y - 35 + 10 });
    const after = door().state().wires;
    expect(after).toContainEqual(expect.objectContaining({ from: "src", to: "disp", toPort: "in" }));
    expect(after).toContainEqual(expect.objectContaining({ from: "disp", to: feed.to, toPort: feed.toPort }));
    expect(after).toContainEqual({ from: "m1", to: "disp", toPort: "mask", kind: "mask" });
    expect(after).toContainEqual({ from: "m2", to: "disp", toPort: "alpha", kind: "mask" });
    // Y off, and back on from the output end.
    drag("alpha-in-port-disp", portCenter(node("disp"), "alpha"), { x: node("disp").x + 900, y: node("disp").y + 900 });
    expect(door().state().wires.some((w) => w.to === "disp" && w.toPort === "alpha")).toBe(false);
    drag("mask-port-m2", portCenter(node("m2"), "maskOut"), portCenter(node("disp"), "alpha"));
    expect(door().state().wires).toContainEqual({ from: "m2", to: "disp", toPort: "alpha", kind: "mask" });
  });
});

// (2026-10-01): "color space worked but my From was 709 by default. I
// set to SRGB and it got darker". Correct (the wires carry scene-linear
// Rec. 709, and calling that sRGB decodes it again), so the default
// says whose space it is and From says what to leave it at.
describe("the Color Transform says what its default is", () => {
  it("names Linear Rec. 709 as Heeler's working space, and From's hint says to leave it there", () => {
    const s = reduce(bench([card("heeler.color_transform", "ct", 0, 0)]), { type: "select_nodes", ids: ["ct"] });
    render(<Inspector state={s} dispatch={() => {}} />);
    const from = screen.getByTestId("node-option-from");
    expect(menuValue(from)).toBe("linear_rec709");
    expect(menuRows(from)).toContainEqual(["linear_rec709", "Linear Rec. 709 (Heeler's working space)"]);
    expect(from.getAttribute("data-tip")).toMatch(/^Leave at Linear Rec\. 709, Heeler's working space, unless/);
    expect(from.getAttribute("data-tip")).toMatch(/sRGB here decodes the picture again and darkens it/);
    expect(screen.getByTestId("node-option-to").getAttribute("data-tip")).toMatch(/back to Linear Rec\. 709/);
  });
});

// (2026-10-01): "yes, add the Edges option". The Displacement Map
// takes the warps' Edges under the warps' names and default, and the
// generic inspector shows it as a choice with an outcome-first hint.
describe("the Displacement Map offers the warps' Edges", () => {
  it("shows Edges as Stretch then Transparent, opening on Stretch, and a pick writes the text param", () => {
    const s = reduce(bench([card("heeler.displacement_map", "disp", 0, 0)]), { type: "select_nodes", ids: ["disp"] });
    const sent: Command[] = [];
    render(<Inspector state={s} dispatch={(c: Command) => sent.push(c)} />);
    const edges = screen.getByTestId("node-option-edges");
    expect(edges.getAttribute("aria-label")).toBe("Edges");
    expect(menuValue(edges)).toBe("clamp");
    expect(menuRows(edges)).toEqual([
      ["clamp", "Stretch"],
      ["transparent", "Transparent"],
    ]);
    expect(edges.getAttribute("data-tip")).toMatch(/^Where the picture moves away from the frame's edge/);
    // The numbers stay on the panel beside it.
    expect(document.querySelector('[data-node="disp"][data-param="strength"]')).not.toBeNull();
    choose(edges, "transparent");
    expect(sent).toContainEqual({ type: "set_text_param", id: "disp", param: "edges", value: "transparent" });
  });
});
