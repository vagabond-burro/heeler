// The Finish half of P3, as SPECIAL LAYERS (the owner's unified
// model: "make this its own special layer, like Fill... It keeps
// these smart tools working alike in Finish"): the Fill brush lives
// on its own layer whose mask holds the strokes and whose content is
// the model's fill; the Smart layer is the picture below lifted
// through a Smart mask. Layer machinery owns both lifecycles: hide,
// reorder, opacity, delete, and one undo per creation.

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { initialState } from "../data";
import { ART_ID, artLayers, artMaskOf, graphHasNode, reduce, type Command, type State } from "../state";
import { activeFillLayer, fillLayers, FillRunner, FillToolButton } from "../ui/filltool";

vi.mock("../bridge", async (importOriginal) => {
  const real = await importOriginal<typeof import("../bridge")>();
  return {
    ...real,
    inpaintFill: vi.fn(async () => "fillabc"),
    smartModelStatus: vi.fn(async () => null),
  };
});

const run = (s: State, ...cmds: Command[]) => cmds.reduce(reduce, s);
/** The Finish pane up: the fill brush is a Finish tool, and a Finish
 * tool is only in hand while the Finish toolbar is on screen. */
const inFinish = () => reduce(initialState(), { type: "set_panel_tab", tab: "layers" });

beforeEach(() => {
  vi.clearAllMocks();
});

describe("the Fill layer", () => {
  it("is a whole arrangement in one undo: inpaint content, stroke mask, layer-life", () => {
    const s0 = inFinish();
    const s = run(s0, { type: "art_add_fill_layer" });
    const layer = artLayers(s).find((l) => l.content.type === "heeler.inpaint")!;
    expect(layer).toBeTruthy();
    expect(layer.content.textParams?.hole).toBe("layer");
    // The stroke mask: brush-typed with the SELECTION character (empty
    // = shows nowhere, strokes reveal the fill).
    const mask = artMaskOf(s, layer.blend.id)!;
    expect(mask.type).toBe("heeler.brush_mask");
    expect(mask.params.invert ?? 0).toBe(0);
    expect(mask.strokes).toEqual([]);
    // The tool armed, and one undo removes the whole arrangement.
    expect(s.tool).toBe("fill");
    expect(s.undoStack.length).toBe(s0.undoStack.length + 1);
    const back = run(s, { type: "undo" });
    expect(artLayers(back).some((l) => l.content.type === "heeler.inpaint")).toBe(false);
    expect(graphHasNode(back.nodes, mask.id)).toBe(false);
  });

  it("deleting the layer takes the fill with it, like any layer", () => {
    let s = run(initialState(), { type: "art_add_fill_layer" });
    const layer = fillLayers(s)[0];
    s = run(s, { type: "art_remove_layer", id: layer.blendId });
    expect(fillLayers(s)).toHaveLength(0);
    expect(graphHasNode(s.nodes, layer.maskId)).toBe(false);
  });

  it("the button arms on an existing fill layer and creates one otherwise", () => {
    let cur = inFinish();
    const dispatch = (c: Command) => {
      cur = reduce(cur, c);
    };
    render(<FillToolButton state={cur} dispatch={dispatch} />);
    fireEvent.click(screen.getByTestId("art-tool-fill"));
    expect(cur.tool).toBe("fill");
    expect(fillLayers(cur)).toHaveLength(1);
    expect(activeFillLayer(cur)).toBeTruthy();
  });
});

describe("the fill runner", () => {
  it("a finished stroke refills its layer and records the fill on the content", async () => {
    let cur = run(initialState(), { type: "art_add_fill_layer" });
    const layer = fillLayers(cur)[0];
    const dispatch = (c: Command) => {
      cur = reduce(cur, c);
      rerender(<FillRunner state={cur} dispatch={dispatch} />);
    };
    const { rerender } = render(<FillRunner state={cur} dispatch={dispatch} />);
    dispatch({
      type: "add_stroke",
      id: layer.maskId,
      stroke: { points: [[0.4, 0.4], [0.5, 0.5]], radius: 0.05 } as never,
    });
    await waitFor(
      () => {
        const content = artLayers(cur).find((l) => l.blend.id === layer.blendId)!.content;
        expect(content.textParams?.fill_id).toBe("fillabc");
        expect(content.textParams?.model).toBe("lama");
      },
      { timeout: 3000 },
    );
    const { inpaintFill } = await import("../bridge");
    // The layer names its stroke mask explicitly: there is no wire
    // from mask to content to follow.
    expect(vi.mocked(inpaintFill)).toHaveBeenCalledWith(
      expect.anything(),
      layer.contentId,
      layer.maskId,
    );
  });
});

describe("the Smart layer", () => {
  it("is a lift through a Smart mask, controls-ready, one undo", () => {
    const s0 = initialState();
    const s = run(s0, { type: "art_add_smart_layer" });
    const layer = artLayers(s).find((l) => l.content.type === "heeler.lift")!;
    expect(layer).toBeTruthy();
    const mask = artMaskOf(s, layer.blend.id)!;
    expect(mask.type).toBe("heeler.smart_mask");
    expect(mask.textParams).toEqual({ mode: "click", prompts: "[]", model: "" });
    expect(s.tool).toBe("smart");
    expect(s.artActive).toBe(layer.blend.id);
    expect(s.undoStack.length).toBe(s0.undoStack.length + 1);
    // Delete takes mask and layer together.
    const gone = run(s, { type: "art_remove_layer", id: layer.blend.id });
    expect(graphHasNode(gone.nodes, mask.id)).toBe(false);
  });
});

describe("the Smart mask on Finish layers", () => {
  it("art_add_mask kind smart puts a smart_mask in the Finish group", async () => {
    let s = run(initialState(), { type: "art_add_layer", kind: "paint" });
    const id = s.artActive!;
    s = run(s, { type: "art_add_mask", id, kind: "smart" });
    const art = s.nodes.find((n) => n.id === ART_ID)!;
    const mask = art.groupNodes!.find((n) => n.id === `art_m_${id}`)!;
    expect(mask.type).toBe("heeler.smart_mask");
    // Read from the frame (the sample's last geometry, its lens
    // correction), the size of its layer, through the group's boundary.
    expect(art.groupBoundary!.some((b) => b.from === "lens" && b.to === mask.id && b.groupPort === "in2")).toBe(true);
    expect(s.wires.some((w) => w.from === "lens" && w.to === ART_ID && w.toPort === "in2")).toBe(true);
    const { activeSmartMask } = await import("../ui/smarttool");
    expect(activeSmartMask({ ...s, artActive: id })?.id).toBe(mask.id);
  });
});
