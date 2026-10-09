// A Develop layer's Opacity (2026-09-30: "Adjustment layers are missing
// an opacity slider. That would be a nice touch."). The layer's own
// node carries `opacity`, 0 to 100, missing is 100; the desktop scales
// the layer's mask by it on every node the mask gates. These hold the
// control's two faces (the layer's block in Develop and the layer's
// node in the graph inspector), one undo per drag, old graphs at 100,
// and the copies that carry it. The pixels are the desktop's:
// src-tauri/src/layer_opacity.rs renders the graphs pinned below at
// Fit, on the 1:1 slice and in the export. After a deliberate change to
// what the reducer builds, regenerate: GEN_FIXTURE=1 npx vitest run
// layeropacity

import React from "react";
import { act, render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import expected from "./fixtures/layer-opacity.json";
import { initialState, NEUTRAL_NODES, NEUTRAL_WIRES } from "../data";
import { migrateNodes, reduce, type Command, type NodeCard, type State } from "../state";
import { serializeGraph } from "../bridge";
import { LayersSection } from "../ui/simple";
import { Inspector } from "../ui/graph";

const IMAGE = "layer_opacity";

function fresh(): State {
  return {
    ...initialState(),
    activeImage: IMAGE,
    images: [{ id: IMAGE, name: "layer_opacity.jpg", folder: "", edited: false } as unknown as State["images"][number]],
    nodes: structuredClone(NEUTRAL_NODES),
    wires: structuredClone(NEUTRAL_WIRES),
  };
}

const run = (s: State, ...cmds: Command[]): State => cmds.reduce(reduce, s);
const node = (s: State, id: string): NodeCard => s.nodes.find((n) => n.id === id)!;

/** A radial layer over the middle of the frame, Exposure +1. */
function layered(): State {
  let s = run(fresh(), { type: "add_layer", maskType: "radial" });
  const id = s.activeLayer!;
  s = run(
    s,
    { type: "set_params", id: id.replace("_adj", "_mask"), values: { center_x: 0.5, center_y: 0.5, radius: 0.3, feather: 0.4 } },
    { type: "set_param", id, param: "exposure", value: 1 },
  );
  return s;
}

const RECT = { left: 0, top: 0, width: 400, height: 12, right: 400, bottom: 12, x: 0, y: 0, toJSON: () => ({}) } as DOMRect;
const pointer = (el: Element, type: string, x: number) =>
  act(() => {
    el.dispatchEvent(new MouseEvent(type, { clientX: x, buttons: type === "pointerup" ? 0 : 1, bubbles: true, cancelable: true }));
  });

describe("a Develop layer's Opacity", () => {
  it("sits in the layer's block, on the layer's own node, at 100 on a layer that never set it", () => {
    const s = layered();
    expect("opacity" in node(s, "layer_1_adj").params).toBe(false);
    render(<LayersSection state={s} dispatch={() => {}} width={300} />);
    const seat = screen.getByTestId("layer-opacity");
    const row = within(seat).getByTestId("slider-opacity");
    expect(row).toHaveAttribute("data-node", "layer_1_adj");
    expect(row.getAttribute("data-hint")).toMatch(/^How much of this layer's edit comes through/);
    expect(within(row).getByRole("slider")).toHaveAttribute("aria-valuenow", "100");
    // Above the mask's own controls: a setting of the whole layer.
    const block = screen.getByTestId("layer-mask-controls");
    expect(block.firstElementChild).toBe(seat);
  });

  it("is the same control on the layer's node in the graph inspector", () => {
    const s = run(layered(), { type: "select_nodes", ids: ["layer_1_adj"] });
    render(<Inspector state={s} dispatch={() => {}} />);
    const row = screen.getByTestId("slider-opacity");
    expect(row).toHaveAttribute("data-node", "layer_1_adj");
    expect(row.getAttribute("data-hint")).toMatch(/^How much of this layer's edit comes through/);
    expect(within(row).getByRole("slider")).toHaveAttribute("aria-valuenow", "100");
    expect(screen.queryByTestId("opacity-none")).toBeNull();
  });

  it("a drag is one undo step, and writes the layer's node only", async () => {
    let current = layered();
    const start = current;
    function Harness() {
      const [state, dispatch] = React.useReducer(reduce, start);
      current = state;
      return <LayersSection state={state} dispatch={dispatch} width={300} />;
    }
    render(<Harness />);
    const track = within(screen.getByTestId("layer-opacity")).getByRole("slider");
    track.getBoundingClientRect = () => RECT;
    pointer(track, "pointerdown", 300);
    for (const x of [280, 250, 200]) pointer(track, "pointermove", x);
    pointer(track, "pointerup", 200);
    await act(async () => {
      await new Promise((r) => setTimeout(r, 20));
    });
    expect(node(current, "layer_1_adj").params.opacity).toBe(50);
    expect(current.undoStack.length).toBe(start.undoStack.length + 1);
    // Nothing but the layer's own node moved.
    for (const n of current.nodes) if (n.id !== "layer_1_adj") expect(n).toEqual(node(start, n.id));
    const undone = run(current, { type: "undo" });
    expect("opacity" in node(undone, "layer_1_adj").params).toBe(false);
  });

  it("the keys move it like any slider", async () => {
    let current = layered();
    const start = current;
    function Harness() {
      const [state, dispatch] = React.useReducer(reduce, start);
      current = state;
      return <LayersSection state={state} dispatch={dispatch} width={300} />;
    }
    render(<Harness />);
    const track = within(screen.getByTestId("layer-opacity")).getByRole("slider");
    act(() => {
      track.focus();
      track.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true, cancelable: true }));
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 20));
    });
    const v = node(current, "layer_1_adj").params.opacity;
    expect(v).toBeLessThan(100);
    expect(v).toBeGreaterThan(90);
  });

  it("does not switch a fresh layer on by itself, and the switch keeps it", () => {
    let s = run(fresh(), { type: "add_layer", maskType: "radial" }, { type: "set_param", id: "layer_1_adj", param: "opacity", value: 40 });
    // Opacity is how much of an edit, not an edit: a layer that says
    // nothing yet stays bypassed.
    expect(node(s, "layer_1_adj").enabled).toBe(false);
    s = run(s, { type: "set_param", id: "layer_1_adj", param: "exposure", value: 1 });
    expect(node(s, "layer_1_adj").enabled).toBe(true);
    s = run(s, { type: "set_layer_enabled", id: "layer_1_adj", enabled: false }, { type: "set_layer_enabled", id: "layer_1_adj", enabled: true });
    expect(node(s, "layer_1_adj").params.opacity).toBe(40);
  });

  it("an old graph migrates without inventing one, and serializes as it was", () => {
    const s = layered();
    const migrated = migrateNodes(structuredClone(s.nodes));
    expect("opacity" in migrated.find((n) => n.id === "layer_1_adj")!.params).toBe(false);
    const wire = serializeGraph(s).nodes.find((n) => n.id === "layer_1_adj")!;
    expect("opacity" in wire.params).toBe(false);
  });

  it("travels with the layer: duplicate, takes, copy and paste, links, saved graphs", () => {
    const s = run(layered(), { type: "set_param", id: "layer_1_adj", param: "opacity", value: 35 });
    // Serialized for the engine and for the saved graph alike.
    expect((serializeGraph(s).nodes.find((n) => n.id === "layer_1_adj")!.params as Record<string, unknown>).opacity).toBe(35);
    // Duplicate.
    const dup = run(s, { type: "duplicate_layer", id: "layer_1_adj" });
    expect(node(dup, "layer_2_adj").params.opacity).toBe(35);
    // Copy and Paste Edits: the whole graph, layers included.
    const copied = run(s, { type: "copy_edits" });
    const pasted = run({ ...fresh(), editClipboard: copied.editClipboard }, { type: "paste_edits" });
    expect(node(pasted, "layer_1_adj").params.opacity).toBe(35);
    // A take is a copy of the graph, and switching back restores it.
    const took = run(s, { type: "new_take" }, { type: "set_param", id: "layer_1_adj", param: "opacity", value: 80 });
    expect(node(run(took, { type: "switch_take", takeId: "take_1" }), "layer_1_adj").params.opacity).toBe(35);
    expect(node(run(took, { type: "switch_take", takeId: "take_1" }, { type: "switch_take", takeId: "take_2" }), "layer_1_adj").params.opacity).toBe(80);
    // A linked photograph takes the change, as a move from where its
    // own layer stood: an unset opacity is 100 on either side.
    const pair = (driver: State, member: NodeCard[]) =>
      run(
        { ...driver, images: [...driver.images, { id: "other", name: "other.jpg", folder: "", edited: false } as unknown as State["images"][number]] },
        { type: "set_link_group", ids: [driver.activeImage, "other"], group: "link_o" },
        { type: "stash_graphs", graphs: { other: { nodes: member, wires: structuredClone(driver.wires) } } },
      );
    const linked = run(pair(s, structuredClone(s.nodes)), { type: "set_param", id: "layer_1_adj", param: "opacity", value: 60 });
    expect(node(linked, "layer_1_adj").params.opacity).toBe(60);
    expect(linked.graphs.other.nodes.find((n) => n.id === "layer_1_adj")!.params.opacity).toBe(60);
    const unset = layered();
    const explicit = structuredClone(unset.nodes).map((n) => (n.id === "layer_1_adj" ? { ...n, params: { ...n.params, opacity: 100 } } : n));
    const moved = run(pair(unset, explicit), { type: "set_param", id: "layer_1_adj", param: "opacity", value: 70 });
    expect(moved.graphs.other.nodes.find((n) => n.id === "layer_1_adj")!.params.opacity).toBe(70);
  });
});

describe("the desktop's pixel fixture", () => {
  it("serialized graphs at 0, 50 and 100, an old graph, and a layer with a tool behind it", () => {
    const base = layered();
    const at = (s: State, v: number) => run(s, { type: "set_param", id: "layer_1_adj", param: "opacity", value: v });
    // A second node of the layer, gated by the same mask: the Color
    // section that edits the layer, saturation up.
    const tooled = run(base, { type: "set_param", id: "layer_1_color", param: "saturation", value: 60 });
    expect(tooled.wires).toContainEqual({ from: "layer_1_mask", to: "layer_1_color", toPort: "mask", kind: "mask" });
    const fixtures = {
      old: serializeGraph(base),
      p0: serializeGraph(at(base, 0)),
      p50: serializeGraph(at(base, 50)),
      p100: serializeGraph(at(base, 100)),
      tool_old: serializeGraph(tooled),
      tool_p0: serializeGraph(at(tooled, 0)),
    };
    if (process.env.GEN_FIXTURE) {
      writeFileSync(resolve(process.cwd(), "src/__tests__/fixtures/layer-opacity.json"), JSON.stringify(fixtures, null, 1) + "\n");
    }
    expect(fixtures).toEqual(expected);
  });
});
