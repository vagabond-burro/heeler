// 2026-10-02: "I created a smart selection layer and selected the
// subject... I went to Select > Polish and the entire image has a red
// overlay. It's like getting the polish tool from the menu doesn't
// recognize the smart selection." And: "there are active marching ants in
// the scene the polish tool ignored."
//
// The rule: whatever the marching ants trace is what Polish opens on. A
// selection that shows anything is refined as it is; with none, a Finish
// layer's live mask is polished in the document selection and Apply puts
// it back on the layer as the pixel mask Mask from selection makes, one
// undo step; Cancel leaves everything as it was; a Develop layer's live
// mask goes the way its mask block's Polish button takes it; with nothing
// on screen Polish stays shut and the status line says what to do.

import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";
import { initialState } from "../data";
import { runCommand } from "../commands";
import {
  DOC_SEL_ID,
  POLISH_NOTHING_LINE,
  activeSelectionMask,
  antsSources,
  artMaskNode,
  polishLayerLine,
  polishSource,
  reduce,
  type Command,
  type State,
} from "../state";
import { PolishLayerRunner } from "../ui/polish";
import { _clearFlashForTests, currentFlash } from "../ui/hints";
import { App } from "../app";

afterEach(() => {
  cleanup();
  _clearFlashForTests();
});

const run = (s: State, ...cmds: Command[]): State => cmds.reduce(reduce, s);

/** The Subject recipe on a Smart mask, as the Smart tool's Subject button
 * leaves it once the model answered. */
const subject = (id: string): Command[] => [
  { type: "set_text_param", id, param: "mode", value: "subject" },
  { type: "set_text_param", id, param: "model", value: "birefnet_lite" },
];

const square: Command = {
  type: "add_region",
  id: DOC_SEL_ID,
  region: { kind: "marquee", op: "replace", x0: 0.2, y0: 0.2, x1: 0.8, y1: 0.8 },
};

/** The owner's screen: the Finish tab, a Smart layer with Subject
 * found, the document selection there and empty (the select tool was
 * picked up and put down again).*/
function smartLayer(): { s: State; mask: string; layer: string } {
  let s = run({ ...initialState(), panelTab: "layers" }, { type: "art_add_smart_layer" });
  const layer = s.artActive!;
  const mask = `art_m_${layer}`;
  s = run(s, ...subject(mask), { type: "arm_document_selection" }, { type: "set_tool", tool: "none" });
  return { s, mask, layer };
}

/** Select > Polish through the command door, every command it sends
 * (now or once the desktop answers) folded into the state. */
async function polish(s: State, until: (c: Command[]) => boolean = () => true): Promise<{ s: State; sent: Command[] }> {
  const sent: Command[] = [];
  runCommand("select.polish", s, (c) => {
    sent.push(c);
  });
  await waitFor(() => expect(until(sent)).toBe(true));
  return { s: run(s, ...sent), sent };
}

const docSel = (s: State) => s.nodes.find((n) => n.id === DOC_SEL_ID);

describe("Polish opens on what the marching ants trace", () => {
  it("the ants and Polish pick the same mask in every case", () => {
    // The document selection showing something.
    let a = run(initialState(), { type: "arm_document_selection" }, square);
    expect(antsSources(a)[0]?.id).toBe(DOC_SEL_ID);
    expect(polishSource(a)).toMatchObject({ kind: "selection", node: { id: DOC_SEL_ID } });

    // A Finish Smart layer in hand, the document selection empty.
    const { s: b, mask } = smartLayer();
    expect(antsSources(b)[0]?.id).toBe(mask);
    expect(polishSource(b)).toMatchObject({ kind: "layer", node: { id: mask } });

    // The same layer with a document selection on screen: the selection.
    const c = run(b, square);
    expect(antsSources(c)[0]?.id).toBe(DOC_SEL_ID);
    expect(polishSource(c)?.node.id).toBe(DOC_SEL_ID);

    // A Develop Selection layer with a marquee on it.
    let d = run(initialState(), { type: "add_layer", maskType: "selection" });
    const sel = d.activeLayer!.replace("_adj", "_mask");
    d = run(d, { type: "add_region", id: sel, region: { kind: "marquee", op: "add", x0: 0.2, y0: 0.2, x1: 0.8, y1: 0.8 } });
    expect(antsSources(d)[0]?.id).toBe(sel);
    expect(polishSource(d)).toMatchObject({ kind: "selection", node: { id: sel } });

    // A Develop Smart layer with Subject found.
    let e = run(initialState(), { type: "add_layer", maskType: "smart" });
    const smart = e.activeLayer!.replace("_adj", "_mask");
    e = run(e, ...subject(smart));
    expect(antsSources(e)[0]?.id).toBe(smart);
    expect(polishSource(e)).toMatchObject({ kind: "develop", node: { id: smart } });

    // Nothing: no ants, nothing to polish.
    a = run(initialState(), { type: "arm_document_selection" });
    expect(antsSources(a)).toEqual([]);
    expect(polishSource(a)).toBeUndefined();
  });

  it("a Finish Smart layer with nothing selected polishes the layer's mask, not the empty selection", async () => {
    const { s: start, mask, layer } = smartLayer();
    const before = artMaskNode(start, mask)!;
    const { s } = await polish(start, (c) => c.some((x) => x.type === "polish_layer_mask"));
    expect(s.tool).toBe("polish");
    // What Polish holds is the mask's render, loaded as the selection:
    // the whole frame is not red.
    const held = activeSelectionMask(s)!;
    expect(held.id).toBe(DOC_SEL_ID);
    expect(held.textParams?.matte_id).toMatch(/^baked:/);
    expect(s.polishLayer).toMatchObject({ layerId: layer, maskId: mask, applying: 0 });
    // The layer's mask is untouched and never a live selection.
    expect(artMaskNode(s, mask)).toEqual(before);
    expect(artMaskNode(s, mask)!.type).toBe("heeler.smart_mask");
    // The status line says what is being polished and what Apply does.
    expect(polishLayerLine(s)).toMatch(/^Polishing .+'s mask: Apply puts the refined edge back on the layer/);
    // Opening it is no step on the history.
    expect(s.undoStack.length).toBe(start.undoStack.length);
  });

  it("Apply makes the polished selection the layer's black and white mask; one undo brings the Smart mask back", async () => {
    const { s: start, mask } = smartLayer();
    const smartBefore = artMaskNode(start, mask)!;
    const selBefore = docSel(start);
    let { s } = await polish(start, (c) => c.some((x) => x.type === "polish_layer_mask"));
    // A polish stroke, its own step while polishing.
    s = run(s, { type: "add_stroke", id: DOC_SEL_ID, stroke: { points: [[0.5, 0.5], [0.6, 0.5]], radius: 0.02 } });
    expect(s.undoStack.length).toBe(start.undoStack.length + 1);
    // Apply.
    s = run(s, { type: "set_tool", tool: "polish" });
    expect(s.tool).toBe("none");
    expect(s.polishLayer?.applying).toBeGreaterThan(0);
    // The runner bakes the selection as the layer's mask and lands it.
    const sent: Command[] = [];
    render(<PolishLayerRunner state={s} dispatch={(c) => sent.push(c)} />);
    await waitFor(() => expect(sent.some((c) => c.type === "polish_layer_mask_land")).toBe(true));
    const land = sent.find((c) => c.type === "polish_layer_mask_land") as Extract<Command, { type: "polish_layer_mask_land" }>;
    expect(land.version).toBeTruthy();
    s = run(s, land);
    // The layer wears a pixel mask, as Mask from selection makes it.
    const after = artMaskNode(s, mask)!;
    expect(after.type).toBe("heeler.brush_mask");
    expect(after.textParams?.matte_id).toBe(`baked:${land.version}`);
    // The document selection is as it was: empty.
    expect(docSel(s)).toEqual(selBefore);
    expect(s.polishLayer).toBeNull();
    // One step for the whole pass.
    expect(s.undoStack.length).toBe(start.undoStack.length + 1);
    const undone = run(s, { type: "undo" });
    expect(artMaskNode(undone, mask)).toEqual(smartBefore);
    expect(docSel(undone)).toEqual(selBefore);
    expect(undone.undoStack.length).toBe(start.undoStack.length);
  });

  it("Cancel leaves the layer's mask and the empty selection as they were", async () => {
    const { s: start, mask } = smartLayer();
    let { s } = await polish(start, (c) => c.some((x) => x.type === "polish_layer_mask"));
    s = run(s, { type: "add_stroke", id: DOC_SEL_ID, stroke: { points: [[0.5, 0.5], [0.6, 0.5]], radius: 0.02 } });
    s = run(s, { type: "cancel_tool" });
    expect(s.tool).toBe("none");
    expect(s.polishLayer).toBeNull();
    expect(artMaskNode(s, mask)).toEqual(artMaskNode(start, mask));
    expect(docSel(s)).toEqual(docSel(start));
    expect(s.undoStack.length).toBe(start.undoStack.length);
    expect(s.matteApply).toEqual(start.matteApply);
  });

  it("with no document selection at all, Cancel takes the one Polish made away again", async () => {
    let start = run({ ...initialState(), panelTab: "layers" }, { type: "art_add_smart_layer" });
    const mask = `art_m_${start.artActive}`;
    start = run(start, ...subject(mask));
    expect(docSel(start)).toBeUndefined();
    let { s } = await polish(start, (c) => c.some((x) => x.type === "polish_layer_mask"));
    expect(docSel(s)).toBeDefined();
    s = run(s, { type: "cancel_tool" });
    expect(docSel(s)).toBeUndefined();
    expect(s.wires).toEqual(start.wires);
  });

  it("undo while polishing takes back strokes, never what came before the pass", async () => {
    const { s: start } = smartLayer();
    let { s } = await polish(start, (c) => c.some((x) => x.type === "polish_layer_mask"));
    s = run(s, { type: "add_stroke", id: DOC_SEL_ID, stroke: { points: [[0.5, 0.5], [0.6, 0.5]], radius: 0.02 } });
    s = run(s, { type: "undo" });
    expect(docSel(s)!.strokes ?? []).toEqual([]);
    expect(run(s, { type: "undo" })).toBe(s);
  });

  it("a photograph switch while polishing cancels the pass on the photograph it was opened on", async () => {
    const { s: start } = smartLayer();
    const { s } = await polish(start, (c) => c.some((x) => x.type === "polish_layer_mask"));
    const other = s.images.find((i) => i.id !== s.activeImage);
    expect(other, "the sample session has a second photograph").toBeDefined();
    const away = run(s, { type: "select_image", id: other!.id } as Command);
    expect(away.polishLayer).toBeNull();
    expect(away.tool).toBe("none");
    const back = run(away, { type: "select_image", id: s.activeImage } as Command);
    expect(docSel(back)).toEqual(docSel(start));
  });

  it("with a document selection on screen Polish refines it, as before", async () => {
    const { s: base, mask } = smartLayer();
    const start = run(base, square);
    const { s, sent } = await polish(start);
    expect(sent.map((c) => c.type)).toEqual(["select_nodes", "set_tool"]);
    expect(s.tool).toBe("polish");
    expect(activeSelectionMask(s)!.id).toBe(DOC_SEL_ID);
    expect(s.polishLayer).toBeNull();
    expect(artMaskNode(s, mask)).toEqual(artMaskNode(start, mask));
  });

  it("a Develop Smart layer goes the way its mask block's Polish button takes it", async () => {
    let start = run(initialState(), { type: "add_layer", maskType: "smart" });
    const mask = start.activeLayer!.replace("_adj", "_mask");
    start = run(start, ...subject(mask), { type: "arm_document_selection" }, { type: "set_tool", tool: "none" });
    const { s, sent } = await polish(start, (c) => c.some((x) => x.type === "set_tool"));
    expect(sent.map((c) => c.type)).toEqual(["convert_mask_to_selection", "set_tool"]);
    expect(s.tool).toBe("polish");
    expect(activeSelectionMask(s)!.id).toBe(mask);
    expect(s.nodes.find((n) => n.id === mask)!.type).toBe("heeler.selection_mask");
  });

  it("with nothing on screen Polish stays shut and the status line says what to do", async () => {
    const start = run(initialState(), { type: "arm_document_selection" }, { type: "set_tool", tool: "none" });
    const sent: Command[] = [];
    expect(runCommand("select.polish", start, (c) => sent.push(c))).toBe(true);
    await new Promise((r) => setTimeout(r, 20));
    expect(sent).toEqual([]);
    expect(currentFlash()).toBe(POLISH_NOTHING_LINE);
  });
});

describe("Select > Polish in the app", () => {
  type Door = { dispatch: (c: Command) => void; state: () => State };
  const door = () => (window as unknown as { __heeler: Door }).__heeler;

  it("on a Finish Smart layer: Polish opens on its mask, Apply puts it back, the status line says so", async () => {
    const user = userEvent.setup();
    render(<App />);
    await user.click(screen.getByTestId("panel-tab-layers"));
    await act(async () => {
      door().dispatch({ type: "art_add_smart_layer" });
    });
    const layer = door().state().artActive!;
    const mask = `art_m_${layer}`;
    await act(async () => {
      for (const c of subject(mask)) door().dispatch(c);
    });
    await user.click(screen.getByTestId("menu-select"));
    await user.click(screen.getByTestId("menu-select-polish"));
    await waitFor(() => expect(door().state().tool).toBe("polish"));
    expect(door().state().polishLayer?.maskId).toBe(mask);
    expect(screen.getByTestId("brush-overlay")).toBeInTheDocument();
    expect(screen.getByTestId("status-bar").textContent).toMatch(/Polishing .+'s mask: Apply puts the refined edge back on the layer/);
    await user.click(screen.getByTestId("art-polish-apply"));
    await waitFor(() => expect(artMaskNode(door().state(), mask)?.type).toBe("heeler.brush_mask"));
    const s = door().state();
    expect(s.polishLayer).toBeNull();
    expect(s.nodes.find((n) => n.id === DOC_SEL_ID)?.textParams?.matte_id ?? "").toBe("");
    await act(async () => {
      door().dispatch({ type: "undo" });
    });
    expect(artMaskNode(door().state(), mask)?.type).toBe("heeler.smart_mask");
  });

  it("with nothing selected and no mask in hand the menu flashes the hint", async () => {
    const user = userEvent.setup();
    render(<App />);
    await user.click(screen.getByTestId("menu-select"));
    await user.click(screen.getByTestId("menu-select-polish"));
    expect(door().state().tool).not.toBe("polish");
    expect(screen.getByTestId("status-bar").textContent).toContain(POLISH_NOTHING_LINE);
  });
});
