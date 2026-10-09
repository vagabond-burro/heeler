// Adding a mask is editing it (2026-10-01: "adding then editing a mask is
// one too many clicks. I click the mask button to make the mask. THe icon
// changes. THen I have to click it again to edit ... When you make the
// mask select the mask and go into mask editing"). Every door that adds a
// mask to a Finish layer lands with the new mask selected and the tool
// that edits it in hand: the brush for a layer mask, the click tool for a
// Smart mask, the brush again for To Mask. The mask's making is the one
// undo step; arming is tool state, and one undo takes the mask away and
// puts its tool down.

import { describe, it, expect, vi } from "vitest";
import { render, screen, act, fireEvent, waitFor } from "@testing-library/react";
import { App } from "../app";
import { artMaskOf, DOC_SEL_ID, selectionHasContent, type Command, type State } from "../state";
import { layerActions, type LayerActionItem } from "../layeractions";

vi.mock("../bridge", async (importOriginal) => {
  const real = await importOriginal<typeof import("../bridge")>();
  const m = { id: "x", installed: true, label: "x", license: "x", url: "x", bytes: 1 };
  return {
    ...real,
    smartModelStatus: vi.fn(async () => ({ sam: m, matte: m, fill: m, refine: m })),
    smartSelect: vi.fn(async () => "00000000000000b1"),
    bakeMaskRaster: vi.fn(async () => "00000000000000c2"),
    bakeLayerMask: vi.fn(async () => "00000000000000d4"),
  };
});

type Door = { dispatch: (c: Command) => void; state: () => State };
const door = () => (window as unknown as { __heeler: Door }).__heeler;

/** The App on the Finish tab with one Exposure adjustment layer, made
 * through the reducer's own command, the way the toolbar makes it. */
function finishApp(kind = "exposure"): string {
  render(<App />);
  fireEvent.click(screen.getByTestId("panel-tab-layers"));
  act(() => {
    door().dispatch({ type: "art_add_layer", kind } as Command);
  });
  return door().state().artActive!;
}

/** The layer's mask selected with `tool` in hand, the mask button lit:
 * the state the mask button's own click sets. */
function expectEditing(blend: string, tool: State["tool"]) {
  const s = door().state();
  const mask = artMaskOf(s, blend);
  expect(mask).toBeDefined();
  expect(s.tool).toBe(tool);
  expect(s.selection).toEqual([mask!.id]);
  expect(screen.getByTestId(`art-mask-edit-${blend}`).getAttribute("data-active")).toBe("true");
}

function menuItem(blend: string, testid: string): LayerActionItem {
  const item = layerActions(door().state(), blend).find((a) => a.kind === "item" && a.testid === testid);
  expect(item).toBeDefined();
  return item as LayerActionItem;
}

describe("adding a Finish layer mask goes straight into editing it", () => {
  it("Add layer mask selects the new mask, arms the brush on it and opens the Brush panel, in one click", () => {
    const blend = finishApp();
    expect(screen.queryByTestId("art-brush-panel")).toBeNull();
    fireEvent.click(screen.getByTestId(`art-mask-add-${blend}`));
    expect(artMaskOf(door().state(), blend)?.type).toBe("heeler.brush_mask");
    expectEditing(blend, "brush");
    expect(screen.getByTestId("art-brush-panel")).toBeInTheDocument();
    expect(screen.getByTestId("brush-overlay")).toBeInTheDocument();
  });

  it("a brush already in hand stays up, moved onto the new mask, rather than toggling down", () => {
    const blend = finishApp();
    act(() => {
      door().dispatch({ type: "set_tool", tool: "brush" } as Command);
    });
    expect(door().state().tool).toBe("brush");
    fireEvent.click(screen.getByTestId(`art-mask-add-${blend}`));
    expectEditing(blend, "brush");
  });

  it("the lit mask button's click leaves editing as it is", () => {
    const blend = finishApp();
    fireEvent.click(screen.getByTestId(`art-mask-add-${blend}`));
    fireEvent.click(screen.getByTestId(`art-mask-edit-${blend}`));
    expectEditing(blend, "brush");
  });

  it("the mask's making is one undo step, and that undo takes the mask away and puts the brush down", () => {
    const blend = finishApp();
    const steps = door().state().undoStack.length;
    fireEvent.click(screen.getByTestId(`art-mask-add-${blend}`));
    expect(door().state().undoStack.length).toBe(steps + 1);
    expectEditing(blend, "brush");
    const mid = artMaskOf(door().state(), blend)!.id;
    act(() => {
      door().dispatch({ type: "undo" } as Command);
    });
    const s = door().state();
    expect(artMaskOf(s, blend)).toBeUndefined();
    expect(s.tool).toBe("none");
    expect(s.selection).not.toContain(mid);
    expect(screen.getByTestId(`art-mask-add-${blend}`)).toBeInTheDocument();
    expect(screen.queryByTestId("art-brush-panel")).toBeNull();
    expect(screen.queryByTestId("brush-overlay")).toBeNull();
  });

  it("Smart mask selects the new Smart mask with the click tool armed on it", () => {
    const blend = finishApp();
    fireEvent.click(screen.getByTestId(`art-mask-smart-${blend}`));
    expect(artMaskOf(door().state(), blend)?.type).toBe("heeler.smart_mask");
    expectEditing(blend, "smart");
  });

  it("the Layer menu's Add Layer Mask and Add Smart Mask land in editing the same way", () => {
    const blend = finishApp();
    act(() => {
      menuItem(blend, "art-menu-mask-add").run(door().dispatch);
    });
    expectEditing(blend, "brush");
    act(() => {
      door().dispatch({ type: "art_remove_mask", id: blend } as Command);
      door().dispatch({ type: "set_tool", tool: "none" } as Command);
    });
    act(() => {
      menuItem(blend, "art-menu-mask-smart").run(door().dispatch);
    });
    expectEditing(blend, "smart");
  });

  it("To Mask from a selection selects the new pixel mask with the brush on it, the selection spent", async () => {
    const blend = finishApp();
    act(() => {
      door().dispatch({ type: "set_select_method", method: "rect" } as Command);
      door().dispatch({ type: "arm_document_selection" } as Command);
      door().dispatch({ type: "add_region", id: DOC_SEL_ID, region: { kind: "marquee", op: "add", x0: 0.4, y0: 0.35, x1: 0.62, y1: 0.66 } } as Command);
    });
    fireEvent.click(await screen.findByTestId(`art-mask-from-selection-${blend}`));
    await waitFor(() => expect(artMaskOf(door().state(), blend)?.type).toBe("heeler.brush_mask"));
    expectEditing(blend, "brush");
    expect(screen.getByTestId("art-brush-panel")).toBeInTheDocument();
    expect(selectionHasContent(door().state().nodes.find((n) => n.id === DOC_SEL_ID))).toBe(false);
  });

  it("Develop's Brush layer already arrives with the brush in hand", () => {
    render(<App />);
    act(() => {
      door().dispatch({ type: "add_layer", maskType: "brush" } as Command);
    });
    expect(door().state().tool).toBe("brush");
  });
});
