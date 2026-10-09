// A layer mask turned off (2026-10-01: "do we have an way to disable a
// mask? I don't see it", then "yes, build disable mask"). Shift-click a
// Finish layer's mask button, or the Develop layer's mask button, or
// Layer > Disable Layer Mask: the mask node carries `mask_off`, the
// bridge sends it as a flag, and the layer applies everywhere (Depth
// mask included) while the mask's strokes, Smart clicks and Depth
// settings stay as they were. One undo step per toggle. The pixels are
// the desktop's: src-tauri/src/disabled_mask.rs renders a mask turned
// off as the unmasked layer at export, Fit and 1:1, and its Export Mask
// as Layer as the opacity everywhere.

import { describe, expect, it } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { initialState, NEUTRAL_NODES, NEUTRAL_WIRES } from "../data";
import {
  artMaskOf,
  layerMaskToggleTarget,
  maskIsOff,
  MASK_OFF_GESTURE,
  reduce,
  type Command,
  type NodeCard,
  type State,
} from "../state";
import { serializeGraph } from "../bridge";
import { layerActions, maskToggleItem } from "../layeractions";
import { ArtLayersTab } from "../ui/artlayers";
import { LayersSection } from "../ui/simple";
import { Inspector } from "../ui/graph";
import { MASK_OFF_HINT } from "../ui/masktoggle";
import { App } from "../app";


const IMAGE = "disable_mask";

function fresh(): State {
  return {
    ...initialState(),
    activeImage: IMAGE,
    images: [{ id: IMAGE, name: "disable_mask.jpg", folder: "", edited: false } as unknown as State["images"][number]],
    nodes: structuredClone(NEUTRAL_NODES),
    wires: structuredClone(NEUTRAL_WIRES),
  };
}

const run = (s: State, ...cmds: Command[]): State => cmds.reduce(reduce, s);
const STROKE = { points: [[0.5, 0.5]] as [number, number][], radius: 0.08, hardness: 1, flow: 1 };

/** A Finish Exposure layer with a painted mask whose Depth mask is on. */
function finishLayer(): { s: State; blend: string; mid: string } {
  let s = run(fresh(), { type: "set_panel_tab", tab: "layers" }, { type: "art_add_layer", kind: "exposure" } as Command);
  const blend = s.artActive!;
  s = run(s, { type: "art_content_set", id: blend, param: "exposure", value: 2 } as Command, { type: "art_add_mask", id: blend, kind: "brush" });
  const mid = artMaskOf(s, blend)!.id;
  s = run(
    s,
    { type: "add_stroke", id: mid, stroke: STROKE },
    { type: "set_param", id: mid, param: "depth_on", value: 1 },
    { type: "set_param", id: mid, param: "depth_black", value: 0.3 },
  );
  return { s, blend, mid };
}

/** A Develop Smart layer with clicks, and a Depth mask on. */
function developLayer(): { s: State; id: string; mid: string } {
  let s = run(fresh(), { type: "add_layer", maskType: "smart" });
  const id = s.activeLayer!;
  const mid = id.replace("_adj", "_mask");
  s = run(
    s,
    { type: "set_param", id, param: "exposure", value: 1 },
    { type: "set_text_param", id: mid, param: "prompts", value: JSON.stringify([{ x: 0.4, y: 0.5, positive: true }]) },
    { type: "set_param", id: mid, param: "depth_on", value: 1 },
  );
  return { s, id, mid };
}

/** What a mask holds besides the switch: everything has to survive. */
const content = (n: NodeCard | undefined) => {
  const { mask_off: _off, ...params } = n!.params;
  return { params, strokes: n!.strokes, regions: n!.regions, textParams: n!.textParams };
};

/** The commands a panel dispatches, run against the state it showed. */
function clicks(s: State, ui: (dispatch: (c: Command) => void) => React.ReactElement, testid: string, init: { shiftKey?: boolean } = {}): State {
  cleanup();
  const seen: Command[] = [];
  const { unmount } = render(ui((c) => seen.push(c)));
  fireEvent.click(screen.getByTestId(testid), init);
  unmount();
  return run(s, ...seen);
}

describe("Finish: Shift-click the mask button", () => {
  it("turns the mask off and on again, one undo step each, the mask's content kept", () => {
    const { s, blend, mid } = finishLayer();
    const before = content(artMaskOf(s, blend));
    const tab = (st: State) => (d: (c: Command) => void) => <ArtLayersTab state={st} dispatch={d} />;
    const off = clicks(s, tab(s), `art-mask-edit-${blend}`, { shiftKey: true });
    expect(maskIsOff(artMaskOf(off, blend))).toBe(true);
    expect(artMaskOf(off, blend)!.id).toBe(mid);
    expect(content(artMaskOf(off, blend))).toEqual(before);
    expect(off.undoStack.length).toBe(s.undoStack.length + 1);
    expect(off.undoStack[off.undoStack.length - 1].label).toBe("Disable Layer Mask");
    // Off: the button wears the red slash and says what the picture does.
    render(<ArtLayersTab state={off} dispatch={() => {}} />);
    const button = screen.getByTestId(`art-mask-edit-${blend}`);
    expect(button.getAttribute("data-hint")).toBe(MASK_OFF_HINT);
    expect(MASK_OFF_HINT).toBe("Mask off: the layer applies everywhere. Shift-click to turn it back on.");
    expect(button.querySelector("[data-testid=mask-off-slash]")).not.toBeNull();
    expect((button.querySelector("[data-testid=mask-off-slash]") as SVGElement).style.stroke).toBe("var(--reject)");
    const on = clicks(off, tab(off), `art-mask-edit-${blend}`, { shiftKey: true });
    expect(maskIsOff(artMaskOf(on, blend))).toBe(false);
    expect(content(artMaskOf(on, blend))).toEqual(before);
    expect(on.undoStack.length).toBe(off.undoStack.length + 1);
    // On: no slash, and the hint names the Shift-click.
    const { unmount } = render(<ArtLayersTab state={on} dispatch={() => {}} />);
    const again = screen.getByTestId(`art-mask-edit-${blend}`);
    expect(again.querySelector("[data-testid=mask-off-slash]")).toBeNull();
    expect(again.getAttribute("data-hint")).toMatch(/Shift-click turns the mask off, so the layer applies everywhere$/);
    unmount();
    // Undo walks back one toggle at a time.
    expect(maskIsOff(artMaskOf(run(on, { type: "undo" }), blend))).toBe(true);
    expect(maskIsOff(artMaskOf(run(on, { type: "undo" }, { type: "undo" }), blend))).toBe(false);
  });

  it("Shift-click only toggles: it neither arms the mask's tool nor makes a mask", () => {
    const { s, blend, mid } = finishLayer();
    const seen: Command[] = [];
    render(<ArtLayersTab state={s} dispatch={(c) => seen.push(c)} />);
    fireEvent.click(screen.getByTestId(`art-mask-edit-${blend}`), { shiftKey: true });
    expect(seen).toEqual([{ type: "set_param", id: mid, param: "mask_off", value: 1 }]);
    const after = run(s, ...seen);
    expect(after.tool).toBe(s.tool);
    expect(after.nodes.length).toBe(s.nodes.length);
    cleanup();
    // On a layer with no mask the add button makes one mask, born on and
    // in hand, Shift or not: there is nothing yet to turn off.
    const bare = run(fresh(), { type: "set_panel_tab", tab: "layers" }, { type: "art_add_layer", kind: "exposure" } as Command);
    const id = bare.artActive!;
    const added: Command[] = [];
    render(<ArtLayersTab state={bare} dispatch={(c) => added.push(c)} />);
    fireEvent.click(screen.getByTestId(`art-mask-add-${id}`), { shiftKey: true });
    expect(added.filter((c) => c.type === "art_add_mask")).toHaveLength(1);
    expect(added.some((c) => c.type === "set_param")).toBe(false);
    expect(maskIsOff(artMaskOf(run(bare, ...added), id))).toBe(false);
  });

  it("a plain click still edits the mask while it is off, and strokes go into it", () => {
    const { s, blend, mid } = finishLayer();
    const off = run(s, { type: "set_param", id: mid, param: "mask_off", value: 1 });
    const seen: Command[] = [];
    render(<ArtLayersTab state={off} dispatch={(c) => seen.push(c)} />);
    fireEvent.click(screen.getByTestId(`art-mask-edit-${blend}`));
    expect(seen).toContainEqual({ type: "select_nodes", ids: [mid] });
    expect(seen).toContainEqual({ type: "set_tool", tool: "brush" });
    expect(seen.some((c) => c.type === "set_param")).toBe(false);
    const painted = run(off, { type: "add_stroke", id: mid, stroke: { ...STROKE, points: [[0.2, 0.2]] } });
    expect(artMaskOf(painted, blend)!.strokes).toHaveLength(2);
    expect(maskIsOff(artMaskOf(painted, blend))).toBe(true);
  });

  it("is sent to the engine as a flag on the mask node, and not at all while on", () => {
    const { s, mid } = finishLayer();
    const sent = (st: State) => (serializeGraph(st) as unknown as { nodes: { id: string; params: Record<string, unknown> }[] }).nodes.find((n) => n.id === mid)!.params;
    expect(sent(s).mask_off).toBeUndefined();
    const off = run(s, { type: "set_param", id: mid, param: "mask_off", value: 1 });
    expect(sent(off).mask_off).toBe(true);
    // The strokes and the Depth mask still travel.
    expect(sent(off).strokes).toBe(sent(s).strokes);
    expect(sent(off).depth_on).toBe(true);
    expect(sent(run(off, { type: "set_param", id: mid, param: "mask_off", value: 0 })).mask_off).toBe(false);
    // Saved and opened again, the Finish mask is still off, in its group.
    const stored = JSON.parse(JSON.stringify({ nodes: off.nodes, wires: off.wires })) as { nodes: NodeCard[]; wires: State["wires"] };
    const reopened = run(fresh(), { type: "replace_graph", nodes: stored.nodes, wires: stored.wires } as Command);
    expect(sent(reopened).mask_off).toBe(true);
    // Copy Edits, then paste over a fresh graph.
    const copied = run(off, { type: "copy_edits" });
    expect(sent(run({ ...fresh(), editClipboard: copied.editClipboard }, { type: "paste_edits" })).mask_off).toBe(true);
  });
});

describe("Develop: the mask button", () => {
  it("turns the mask off and on, click or Shift-click, one undo each, clicks and depth kept", () => {
    const { s, mid } = developLayer();
    const before = content(s.nodes.find((n) => n.id === mid));
    const section = (st: State) => (d: (c: Command) => void) => <LayersSection state={st} dispatch={d} width={300} />;
    const off = clicks(s, section(s), "mask-off-toggle", { shiftKey: true });
    const mask = (st: State) => st.nodes.find((n) => n.id === mid);
    expect(maskIsOff(mask(off))).toBe(true);
    expect(content(mask(off))).toEqual(before);
    expect(off.undoStack.length).toBe(s.undoStack.length + 1);
    render(<LayersSection state={off} dispatch={() => {}} width={300} />);
    const button = screen.getByTestId("mask-off-toggle");
    expect(button.getAttribute("aria-pressed")).toBe("true");
    expect(button.getAttribute("data-hint")).toMatch(/^Mask off: the layer applies everywhere\./);
    expect(button.querySelector("[data-testid=mask-off-slash]")).not.toBeNull();
    const on = clicks(off, section(off), "mask-off-toggle");
    expect(maskIsOff(mask(on))).toBe(false);
    expect(content(mask(on))).toEqual(before);
    expect(on.undoStack.length).toBe(off.undoStack.length + 1);
    expect(maskIsOff(mask(run(on, { type: "undo" })))).toBe(true);
    // Reset mask keeps the switch where it is.
    expect(maskIsOff(mask(run(off, { type: "reset_mask", id: mid, maskType: "smart" })))).toBe(true);
  });

  it("is sent as a flag on the layer's mask node", () => {
    const { s, mid } = developLayer();
    const off = run(s, { type: "set_param", id: mid, param: "mask_off", value: 1 });
    const params = (serializeGraph(off) as unknown as { nodes: { id: string; params: Record<string, unknown> }[] }).nodes.find((n) => n.id === mid)!.params;
    expect(params.mask_off).toBe(true);
    expect(params.depth_on).toBe(true);
    expect(params.prompts).toBe(JSON.stringify([{ x: 0.4, y: 0.5, positive: true }]));
  });

  it("survives save and reload, takes, a paste of the edits and a linked photograph", () => {
    const { s, mid } = developLayer();
    const off = run(s, { type: "set_param", id: mid, param: "mask_off", value: 1 });
    const mask = (st: State, id = mid) => st.nodes.find((n) => n.id === id);
    const stored = JSON.parse(JSON.stringify({ nodes: off.nodes, wires: off.wires })) as { nodes: NodeCard[]; wires: State["wires"] };
    expect(maskIsOff(mask(run(fresh(), { type: "replace_graph", nodes: stored.nodes, wires: stored.wires } as Command)))).toBe(true);
    // A take is the graph.
    const took = run(off, { type: "new_take" }, { type: "set_param", id: mid, param: "mask_off", value: 0 });
    expect(maskIsOff(mask(took))).toBe(false);
    expect(maskIsOff(mask(run(took, { type: "switch_take", takeId: "take_1" })))).toBe(true);
    // Copy Edits, then paste over a fresh graph.
    const copied = run(off, { type: "copy_edits" });
    expect(maskIsOff(mask(run({ ...fresh(), editClipboard: copied.editClipboard }, { type: "paste_edits" })))).toBe(true);
    // A linked photograph with the same layer takes the switch.
    const before = s;
    const linked = run(
      { ...before, images: [...before.images, { id: "other", name: "other.jpg", folder: "", edited: false } as unknown as State["images"][number]] },
      { type: "set_link_group", ids: [IMAGE, "other"], group: "link_o" },
      { type: "stash_graphs", graphs: { other: { nodes: structuredClone(before.nodes), wires: structuredClone(before.wires) } } },
      { type: "set_param", id: mid, param: "mask_off", value: 1 },
    );
    expect(maskIsOff(linked.graphs.other.nodes.find((n) => n.id === mid))).toBe(true);
  });
});

describe("Layer > Disable Layer Mask", () => {
  it("one item whose label flips, grayed with a reason without a mask, the gesture shown", () => {
    let s = run(fresh(), { type: "set_panel_tab", tab: "layers" }, { type: "art_add_layer", kind: "exposure" } as Command);
    const blend = s.artActive!;
    const item = (st: State) => layerActions(st, blend).find((a) => a.kind === "item" && a.testid === "art-menu-mask-disable")!;
    const bare = item(s);
    expect(bare.kind === "item" && [bare.label, bare.disabled, bare.why, bare.keys]).toEqual([
      "Disable Layer Mask",
      true,
      "This layer has no mask yet. Add one first.",
      MASK_OFF_GESTURE,
    ]);
    s = run(s, { type: "art_add_mask", id: blend, kind: "brush" });
    const live = item(s);
    expect(live.kind === "item" && [live.label, live.disabled]).toEqual(["Disable Layer Mask", false]);
    const seen: Command[] = [];
    if (live.kind === "item") live.run((c) => seen.push(c));
    s = run(s, ...seen);
    expect(maskIsOff(artMaskOf(s, blend))).toBe(true);
    const flipped = item(s);
    expect(flipped.kind === "item" && flipped.label).toBe("Enable Layer Mask");
    // The menu bar acts on the panel that is showing.
    expect(layerMaskToggleTarget(s)).toEqual({ maskId: artMaskOf(s, blend)!.id, off: true });
    const develop = run(s, { type: "set_panel_tab", tab: "adjust" }, { type: "add_layer", maskType: "brush" });
    const target = layerMaskToggleTarget(develop);
    expect(target).toEqual({ maskId: develop.activeLayer!.replace("_adj", "_mask"), off: false });
    expect(maskToggleItem(layerMaskToggleTarget({ ...develop, activeLayer: null })).disabled).toBe(true);
  });

  it("in the app's menu bar: grayed, then live, then Enable, with the gesture words", () => {
    render(<App />);
    type Door = { dispatch: (c: Command) => void; state: () => State };
    const door = () => (window as unknown as { __heeler: Door }).__heeler;
    fireEvent.click(screen.getByTestId("panel-tab-layers"));
    act(() => door().dispatch({ type: "art_add_layer", kind: "exposure" } as Command));
    const blend = door().state().artActive!;
    fireEvent.click(screen.getByTestId("menu-layer"));
    expect(screen.getByTestId("menu-layer-mask-disable")).toBeDisabled();
    expect(screen.getByTestId("menu-layer-mask-disable").parentElement!.getAttribute("data-hint")).toMatch(/Add one first\.$/);
    fireEvent.click(screen.getByTestId("menu-layer"));
    act(() => door().dispatch({ type: "art_add_mask", id: blend, kind: "brush" }));
    fireEvent.click(screen.getByTestId("menu-layer"));
    const entry = screen.getByTestId("menu-layer-mask-disable");
    expect(entry).not.toBeDisabled();
    expect(entry.textContent).toContain("Disable Layer Mask");
    expect(entry.querySelector("[data-testid=menu-keys]")!.textContent).toBe("Shift-click the mask button");
    fireEvent.click(entry);
    expect(maskIsOff(artMaskOf(door().state(), blend))).toBe(true);
    fireEvent.click(screen.getByTestId("menu-layer"));
    expect(screen.getByTestId("menu-layer-mask-disable").textContent).toContain("Enable Layer Mask");
  });
});

describe("the graph", () => {
  it("the mask node's Inspector says the mask is off", () => {
    const { s, mid } = developLayer();
    const off = run(s, { type: "set_param", id: mid, param: "mask_off", value: 1 }, { type: "select_nodes", ids: [mid] });
    const { unmount } = render(<Inspector state={off} dispatch={() => {}} />);
    expect(screen.getByTestId("inspector-mask-off").textContent).toMatch(/^Mask off: the layer applies everywhere\./);
    // No row of its own: the switch is the mask button and the menu.
    expect(screen.queryByText(/mask off$/i)).toBeNull();
    unmount();
    render(<Inspector state={run(s, { type: "select_nodes", ids: [mid] })} dispatch={() => {}} />);
    expect(screen.queryByTestId("inspector-mask-off")).toBeNull();
  });
});
