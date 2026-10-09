// A polish pick must not outlive the polish pass.
//
// select.polish picks the mask it refines so the whole pass works on
// one node - correct while the tool is up, poison afterwards: a picked
// selection mask outranks the active layer in activeSelectionMask, so
// a leftover pick silently routed every later draw, Select-menu
// command and polish stroke to a mask that was no longer on screen. On
// an Adjustments Selection layer that had been working: "Then the
// selection was no longer recognized as I adjusted exposure. I was
// confused so I clicked Show Mask and saw everything as black" - Show
// Mask showed the layer's real (untouched) mask while his refinements
// landed on the still-picked document selection.

import { describe, expect, it } from "vitest";
import { initialState } from "../data";
import { runCommand } from "../commands";
import {
  DOC_SEL_ID,
  activeSelectionMask,
  reduce,
  type Command,
  type State,
} from "../state";

const run = (s: State, ...cmds: Command[]) => cmds.reduce(reduce, s);
const square = {
  kind: "path" as const,
  op: "replace" as const,
  points: [
    [0.2, 0.2],
    [0.8, 0.2],
    [0.8, 0.8],
    [0.2, 0.8],
  ] as [number, number][],
};

const polish = (s: State) => {
  let next = s;
  runCommand("select.polish", next, (c) => {
    next = reduce(next, c);
  });
  return next;
};

describe("the polish pick dies with the pass", () => {
  it("Apply unpicks, and the resolver returns to the active layer", () => {
    let s = run(initialState(), { type: "add_layer", maskType: "selection" });
    const maskId = s.activeLayer!.replace("_adj", "_mask");
    s = run(s, { type: "add_region", id: maskId, region: square });
    s = polish(s);
    expect(s.selection).toContain(maskId); // picked FOR the pass
    s = run(s, { type: "set_tool", tool: "polish" }); // Apply
    expect(s.selection).not.toContain(maskId);
    expect(activeSelectionMask(s)?.id).toBe(maskId);
  });

  it("Cancel unpicks the same way", () => {
    let s = run(initialState(), { type: "add_layer", maskType: "selection" });
    const maskId = s.activeLayer!.replace("_adj", "_mask");
    s = run(s, { type: "add_region", id: maskId, region: square });
    s = polish(s);
    s = run(s, { type: "cancel_tool" });
    expect(s.selection).not.toContain(maskId);
  });

  it("the owner's session: a polished document selection cannot hijack a later layer", () => {
    // Yesterday: a document selection, polished and applied.
    let s = run(initialState(), { type: "arm_document_selection" });
    s = run(s, { type: "add_region", id: DOC_SEL_ID, region: square });
    s = polish(s);
    s = run(s, { type: "set_tool", tool: "polish" }); // Apply
    // Today: an Adjustments Selection layer. The resolver must answer
    // the LAYER's mask - before the fix it kept answering sel_doc, and
    // everything drawn or polished went to a selection nobody could
    // see.
    s = run(s, { type: "add_layer", maskType: "selection" });
    const maskId = s.activeLayer!.replace("_adj", "_mask");
    expect(activeSelectionMask(s)?.id).toBe(maskId);
    // Drawing lands on the layer's mask (the overlay dispatches to the
    // resolver's answer, so the resolver IS the routing). "add", so it
    // joins the region adoption moved in at birth instead of replacing
    // it.
    s = run(s, {
      type: "add_region",
      id: activeSelectionMask(s)!.id,
      region: { ...square, op: "add" as const },
    });
    expect(
      s.nodes.find((n) => n.id === maskId)!.regions!.length,
    ).toBeGreaterThanOrEqual(2);
    // And polishing now targets the layer's mask too.
    s = polish(s);
    expect(s.selection).toContain(maskId);
    expect(activeSelectionMask(s)?.id).toBe(maskId);
  });

  it("deleting the layer mid-polish puts the tool down and takes its pick", () => {
    // "I had an Adjustment Selection layer that I was using
    // Selection Polish on. When I deleted the layer, without applying the
    // Polish, it left a red overlay on the image." The polish tool
    // survived the deletion armed at nothing, and its preview kept
    // painting.
    let s = run(initialState(), { type: "add_layer", maskType: "selection" });
    const adjId = s.activeLayer!;
    const maskId = adjId.replace("_adj", "_mask");
    s = run(s, { type: "add_region", id: maskId, region: square });
    s = polish(s);
    expect(s.tool).toBe("polish");
    s = run(s, { type: "remove_layer", id: adjId });
    expect(s.tool).not.toBe("polish");
    expect(s.selection).not.toContain(maskId);
    expect(s.toolRevert).toBeNull();
    expect(s.nodes.some((n) => n.id === maskId)).toBe(false);
  });

  it("the owner's Sky: clicking Base mid-polish ends the pass, and Deselect cannot reach the layer", () => {
    // Adjustment layer > Smart layer > Sky, then Polish... on it. The
    // conversion picks the mask and arms polish; the pass is applied by
    // clicking off the layer, which put the tool down but left the pick,
    // so the resolver kept answering the layer's mask with Base active:
    // ants up, and Deselect emptied the layer. "when I click
    // off the adjustment back to the Base layer the selection (marching
    // ants) persist. If I do a deselect the adjustments made to the smart
    // layer disappear."
    let s = run(initialState(), { type: "add_layer", maskType: "smart" });
    const maskId = s.activeLayer!.replace("_adj", "_mask");
    s = run(s, { type: "convert_mask_to_selection", maskId, version: "v7" });
    s = run(s, { type: "set_tool", tool: "polish" });
    expect(s.tool).toBe("polish");
    expect(s.selection).toContain(maskId);
    s = run(s, {
      type: "add_polish_stroke",
      id: maskId,
      stroke: { points: [[0.5, 0.5]], radius: 0.05, mode: "foreground" },
    });
    // Off to Base.
    s = run(s, { type: "set_active_layer", id: null });
    expect(s.tool).not.toBe("polish");
    expect(s.selection).not.toContain(maskId);
    // Nothing points at the layer's mask now, so nothing resolves to
    // it: no ants, and no Deselect.
    expect(activeSelectionMask(s)).toBeUndefined();
    let handled = false;
    runCommand("select.none", s, (c) => {
      handled = true;
      s = reduce(s, c);
    });
    expect(handled).toBe(false);
    const mask = s.nodes.find((n) => n.id === maskId)!;
    expect(mask.textParams?.matte_id).toBe("baked:v7");
    expect(mask.strokes?.length).toBe(1);
    // Back on the layer, the polished selection is still there to edit.
    s = run(s, { type: "set_active_layer", id: maskId.replace("_mask", "_adj") });
    expect(activeSelectionMask(s)?.id).toBe(maskId);
  });

  it("with a document selection about, Base resolves to it and not to a layer", () => {
    let s = run(initialState(), { type: "arm_document_selection" });
    s = run(s, { type: "add_region", id: DOC_SEL_ID, region: square });
    s = run(s, { type: "add_layer", maskType: "selection" });
    const maskId = s.activeLayer!.replace("_adj", "_mask");
    s = run(s, { type: "add_region", id: maskId, region: square });
    s = polish(s);
    s = run(s, { type: "set_active_layer", id: null });
    expect(activeSelectionMask(s)?.id).toBe(DOC_SEL_ID);
  });

  it("activating a layer drops a pick of another layer's mask", () => {
    let s = run(initialState(), { type: "add_layer", maskType: "selection" });
    const first = s.activeLayer!;
    s = run(s, { type: "add_layer", maskType: "selection" });
    const secondMask = s.activeLayer!.replace("_adj", "_mask");
    s = run(s, { type: "select_nodes", ids: [secondMask] });
    s = run(s, { type: "set_active_layer", id: first });
    expect(s.selection).not.toContain(secondMask);
    expect(activeSelectionMask(s)?.id).toBe(first.replace("_adj", "_mask"));
  });

  it("adding a layer sheds any stale selection-mask pick outright", () => {
    let s = run(initialState(), { type: "arm_document_selection" });
    s = run(s, { type: "add_region", id: DOC_SEL_ID, region: square });
    s = run(s, { type: "select_nodes", ids: [DOC_SEL_ID] });
    s = run(s, { type: "add_layer", maskType: "selection" });
    expect(s.selection).not.toContain(DOC_SEL_ID);
  });
});
