import { describe, it, expect, vi, beforeEach } from "vitest";
import { writeFileSync } from "node:fs";
import expected from "./fixtures/mask-from-selection.json";
import { resolve } from "node:path";
import { render, screen, act, fireEvent, waitFor } from "@testing-library/react";
import { initialState, NEUTRAL_NODES, NEUTRAL_WIRES } from "../data";
import {
  reduce,
  artLayers,
  artMaskOf,
  artMaskNode,
  maskBrushTarget,
  maskPreviewNode,
  migrateNodes,
  DOC_SEL_ID,
  type State,
  type Command,
  type NodeCard,
} from "../state";
import { serializeGraph, bakeLayerMask } from "../bridge";
import { App } from "../app";
import { rawLegacySelectionMask } from "./legacymask";

// A selection made into a layer's mask is a PIXEL mask (2026-09-30: "I
// expect when I clicked To Mask that it made a regular black and white
// mask and I could clear the selection ... I honestly thought that
// converted it to a paintable mask"; "drop the live mask, make To Mask a
// pixel mask"). Every door renders the selection once on the desktop
// (bake_layer_mask, bake_mask_raster) and the layer's mask is the brush's
// kind, wearing that coverage: the brush paints it, the eye shows it,
// Invert flips it, and the document selection is spent on it. A layer
// mask saved as a live selection before then opens as a pixel mask whose
// frozen base renders it as it rendered.
//
// These build every door through the reducer (Mask from selection for
// each kind of selection on each Finish layer kind that takes a mask, its
// Shift and Option forms, To Mask on Finish and Develop Smart masks, the
// Develop Selection layer kind, saved live selections opened), on an
// uncropped, a cropped and a turned photograph, and pin the serialized
// graphs; the desktop's pixel tests (src-tauri/src/mask_from_selection.rs)
// make the bakes the placeholders stand for, render at Fit, 1:1 and
// export, and check the layer changes the picture where the selection
// was and nowhere else, the mask is the selection's coverage, and a saved
// live selection renders as it did. After a deliberate change to what the
// reducer builds, regenerate:
//   GEN_FIXTURE=1 npx vitest run maskfromselection

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

beforeEach(() => {
  vi.mocked(bakeLayerMask).mockClear();
});

const FIXTURE = resolve(process.cwd(), "src/__tests__/fixtures/mask-from-selection.json");
const IMAGE = "mask_from_selection";
/** The pointer the desktop test plants the subject's raster under. */
const SUBJECT_BASE = "baked:00000000000000b1";
/** The bakes the desktop test makes and rewrites these with: Mask from
 * selection's (and a second one's, for Shift and Option), To Mask's. */
const BAKE_A = "00000000000000d4";
const BAKE_B = "00000000000000d5";
const TO_MASK_BAKE = "00000000000000c2";

function fresh(): State {
  return {
    ...initialState(),
    activeImage: IMAGE,
    panelTab: "layers",
    nodes: structuredClone(NEUTRAL_NODES),
    wires: structuredClone(NEUTRAL_WIRES),
  };
}

const run = (s: State, ...cmds: Command[]): State => cmds.reduce(reduce, s);

const CROPS: Record<string, Record<string, number> | null> = {
  uncropped: null,
  cropped: { crop_x: 0.2, crop_y: 0.2, crop_w: 0.6, crop_h: 0.6 },
  turned: { angle: 8, crop_x: 0.15, crop_y: 0.15, crop_w: 0.7, crop_h: 0.7 },
};

const RECT = { kind: "marquee", op: "add", x0: 0.4, y0: 0.35, x1: 0.62, y1: 0.66 } as const;
const LASSO = { kind: "path", op: "add", points: [[0.4, 0.36], [0.63, 0.34], [0.6, 0.66], [0.42, 0.64]] as [number, number][] };
/** The second selection Shift and Option land: overlapping RECT's right
 * half and reaching past it. */
const SECOND = { kind: "marquee", op: "add", x0: 0.52, y0: 0.42, x1: 0.72, y1: 0.58 } as const;

/** The document selection as each tool leaves it. */
const SELECTIONS: Record<string, Command[]> = {
  // Smart Subject and Smart click: the model's answer is the baked base
  // and there are no regions (SmartSelectOverlay).
  subject: [
    { type: "set_select_method", method: "smart" },
    { type: "arm_document_selection" },
    { type: "set_text_param", id: DOC_SEL_ID, param: "mode", value: "subject" },
    { type: "set_text_param", id: DOC_SEL_ID, param: "matte_id", value: SUBJECT_BASE },
  ],
  click: [
    { type: "set_select_method", method: "smart" },
    { type: "arm_document_selection" },
    { type: "set_text_param", id: DOC_SEL_ID, param: "mode", value: "click" },
    { type: "set_text_param", id: DOC_SEL_ID, param: "prompts", value: JSON.stringify([{ x: 0.52, y: 0.5, positive: true }]) },
    { type: "set_text_param", id: DOC_SEL_ID, param: "matte_id", value: SUBJECT_BASE },
  ],
  // The Subject with a rectangle added past its right edge.
  subject_and_rectangle: [
    { type: "set_select_method", method: "smart" },
    { type: "arm_document_selection" },
    { type: "set_text_param", id: DOC_SEL_ID, param: "mode", value: "subject" },
    { type: "set_text_param", id: DOC_SEL_ID, param: "matte_id", value: SUBJECT_BASE },
    { type: "add_region", id: DOC_SEL_ID, region: { kind: "marquee", op: "add", x0: 0.62, y0: 0.4, x1: 0.75, y1: 0.6 } },
  ],
  rectangle: [
    { type: "set_select_method", method: "rect" },
    { type: "arm_document_selection" },
    { type: "add_region", id: DOC_SEL_ID, region: RECT },
  ],
  lasso: [
    { type: "set_select_method", method: "freehand" },
    { type: "arm_document_selection" },
    { type: "add_region", id: DOC_SEL_ID, region: LASSO },
  ],
  // A drawn selection polished: a background stroke carves a hole.
  polished: [
    { type: "set_select_method", method: "rect" },
    { type: "arm_document_selection" },
    { type: "add_region", id: DOC_SEL_ID, region: RECT },
    { type: "add_polish_stroke", id: DOC_SEL_ID, stroke: { points: [[0.51, 0.5]], radius: 0.05, mode: "background" } },
  ],
  // Its edge softened and moved by the dials.
  feathered: [
    { type: "set_select_method", method: "rect" },
    { type: "arm_document_selection" },
    { type: "add_region", id: DOC_SEL_ID, region: RECT },
    { type: "set_param", id: DOC_SEL_ID, param: "feather", value: 0.15 },
    { type: "set_param", id: DOC_SEL_ID, param: "grow", value: 0.1 },
  ],
} as unknown as Record<string, Command[]>;

const COVER = { points: [[0.5, 0.5]] as [number, number][], radius: 2, hardness: 1, flow: 1 };

/** A Finish layer of `kind` with what makes it change the picture. */
function finishLayer(s: State, kind: string): State {
  if (kind === "image") return run(s, { type: "art_add_file_layers", path: "__IMAGE__", items: [{ layer: "", name: "picture", box: null }] } as Command);
  let out = run(s, { type: "art_add_layer", kind } as Command);
  const id = out.artActive!;
  if (kind === "exposure") out = run(out, { type: "art_content_set", id, param: "exposure", value: 2 } as Command);
  if (kind === "paint") out = run(out, { type: "art_add_stroke", id, stroke: { ...COVER, color: "#ff2000" } } as Command);
  if (kind === "warp") {
    const warp = artLayers(out).find((l) => l.blend.id === id)!.content.id;
    out = run(
      out,
      ...([
        { type: "set_tool", tool: "shapewarp", target: warp },
        { type: "shape_warp_add" },
        { type: "shape_warp_set", id: "shape_1", patch: { cx: 0.51, cy: 0.5, radius: 0.35, feather: 0.2, scale: 1.6, scaleY: 1.6 } },
        { type: "set_tool", tool: "none" },
      ] as unknown as Command[]),
    );
  }
  return out;
}

/** What each fixture carries: the graph the door read (the selection it
 * made the mask of, `reference`), the graph after, and how to switch the
 * layer off; for Shift and Option, the first mask (`mid`) and the graph
 * the second selection was made on (`second`, `reference2`). */
type Case = {
  before: State;
  after: State;
  reference: string;
  off: { blend?: string; adj?: string };
  mid?: State;
  second?: State;
  op?: "add" | "subtract";
};

function cropped(crop: string): State {
  const c = CROPS[crop];
  return c ? run(fresh(), { type: "set_params", id: "crop", values: c } as Command) : fresh();
}

const docSel = (s: State) => s.nodes.find((n) => n.id === DOC_SEL_ID)!;
const artMask = (s: State, blend: string) => artMaskNode(s, `art_m_${blend}`) as NodeCard;

/** The selection's content, as a live layer selection carried it. */
function liveCopy(src: NodeCard): Pick<NodeCard, "regions" | "strokes" | "params" | "textParams"> {
  const matte = src.textParams?.matte_id ?? "";
  return {
    regions: src.regions ?? [],
    strokes: src.strokes ?? [],
    params: { ...src.params },
    textParams: { matte_id: matte.startsWith("baked:") ? matte : "" },
  };
}

function build(): Record<string, Case> {
  const out: Record<string, Case> = {};
  for (const crop of Object.keys(CROPS)) {
    // Every Finish layer kind that takes a mask, through Mask from
    // selection; every selection on the Adjustment layer, the two
    // commonest on the others.
    for (const kind of ["exposure", "paint", "warp", "image"]) {
      const sels = kind === "exposure" ? Object.keys(SELECTIONS) : ["subject", "rectangle"];
      for (const sel of sels) {
        const layered = finishLayer(cropped(crop), kind);
        const blend = layered.artActive!;
        const before = run(layered, ...SELECTIONS[sel]);
        const after = run(before, { type: "art_mask_from_selection", id: blend, maskId: DOC_SEL_ID, version: BAKE_A } as Command);
        out[`finish_${kind}_${sel}_${crop}`] = { before, after, reference: DOC_SEL_ID, off: { blend } };
      }
    }
    // Shift and Option: a second selection added to and taken out of the
    // pixel mask the first made.
    for (const op of ["add", "subtract"] as const) {
      const layered = finishLayer(cropped(crop), "exposure");
      const blend = layered.artActive!;
      const before = run(layered, ...SELECTIONS.rectangle);
      const mid = run(before, { type: "art_mask_from_selection", id: blend, maskId: DOC_SEL_ID, version: BAKE_A } as Command);
      const second = run(mid, { type: "add_region", id: DOC_SEL_ID, region: SECOND } as Command);
      const after = run(second, { type: "art_mask_from_selection", id: blend, maskId: DOC_SEL_ID, version: BAKE_B, op } as Command);
      out[`combine_${op}_${crop}`] = { before, after, reference: DOC_SEL_ID, off: { blend }, mid, second, op };
    }
    // A Develop Selection layer, a layer kind of its own, adopts the
    // selection it is made over, as it did.
    for (const sel of ["subject", "subject_and_rectangle", "polished"]) {
      const before = run(cropped(crop), ...SELECTIONS[sel]);
      let after = run(before, { type: "add_layer", maskType: "selection" } as Command);
      const adj = after.activeLayer!;
      after = run(after, { type: "set_param", id: adj, param: "exposure", value: 2 } as Command);
      out[`develop_${sel}_${crop}`] = { before, after, reference: DOC_SEL_ID, off: { adj } };
    }
    // The layer's own Smart mask made a pixel mask with To Mask, on the
    // Adjustment layer and the Warp layer, and on a Develop Smart layer.
    for (const kind of ["exposure", "warp"]) {
      const layered = finishLayer(cropped(crop), kind);
      const blend = layered.artActive!;
      const mid = `art_m_${blend}`;
      const before = run(
        layered,
        { type: "art_add_mask", id: blend, kind: "smart" } as Command,
        { type: "set_text_param", id: mid, param: "mode", value: "subject" } as Command,
        { type: "set_text_param", id: mid, param: "model", value: "mobile_sam" } as Command,
      );
      const after = run(before, { type: "convert_mask_to_pixels", maskId: mid, version: TO_MASK_BAKE } as Command);
      out[`to_mask_finish_${kind}_${crop}`] = { before, after, reference: mid, off: { blend } };
    }
    {
      let before = run(cropped(crop), { type: "add_layer", maskType: "smart" } as Command);
      const adj = before.activeLayer!;
      const mid = adj.replace("_adj", "_mask");
      before = run(
        before,
        { type: "set_text_param", id: mid, param: "mode", value: "subject" } as Command,
        { type: "set_text_param", id: mid, param: "model", value: "mobile_sam" } as Command,
        { type: "set_param", id: adj, param: "exposure", value: 2 } as Command,
      );
      const after = run(before, { type: "convert_mask_to_pixels", maskId: mid, version: TO_MASK_BAKE } as Command);
      out[`to_mask_develop_${crop}`] = { before, after, reference: mid, off: { adj } };
    }
    // A layer saved with a live selection mask, before 2026-09-30, and
    // the same graph opened (migrateNodes): the crop is made with the
    // live selection on the layer, the way it was saved.
    for (const kind of ["exposure", "warp"]) {
      for (const sel of ["rectangle", "lasso", "polished", "feathered", "subject_and_rectangle"]) {
        const layered = finishLayer(fresh(), kind);
        const blend = layered.artActive!;
        const selected = run(layered, ...SELECTIONS[sel]);
        let before = rawLegacySelectionMask(selected, blend, liveCopy(docSel(selected)));
        before = run(before, { type: "clear_regions", id: DOC_SEL_ID } as Command);
        const c = CROPS[crop];
        if (c) before = run(before, { type: "set_params", id: "crop", values: c } as Command);
        const after = { ...before, nodes: migrateNodes(before.nodes) };
        out[`legacy_${kind}_${sel}_${crop}`] = { before, after, reference: `art_m_${blend}`, off: { blend } };
      }
    }
  }
  return out;
}

describe("a selection made into a layer's mask is a pixel mask", () => {
  it("Mask from selection gives every Finish layer the brush's mask wearing the bake, and spends the selection", () => {
    for (const [name, c] of Object.entries(build())) {
      if (!name.startsWith("finish_")) continue;
      const mask = artMask(c.after, c.off.blend!);
      expect(mask.type, name).toBe("heeler.brush_mask");
      expect(mask.textParams?.matte_id, name).toBe(`baked:${BAKE_A}`);
      expect(mask.strokes, name).toEqual([]);
      // Add layer mask's polarity: inverted, painting hides; the base laid
      // in as its complement so the mask shows the selection.
      expect(mask.params.invert, name).toBe(1);
      expect(mask.params.base_invert, name).toBe(1);
      // The selection is spent on it, its Smart recipe with it.
      const left = docSel(c.after);
      expect(left.regions ?? [], name).toEqual([]);
      expect(left.strokes ?? [], name).toEqual([]);
      expect(left.textParams?.matte_id ?? "", name).toBe("");
      expect(left.textParams?.mode ?? "", name).toBe("");
      // One undo puts both back.
      const undone = run(c.after, { type: "undo" } as Command);
      expect(artMaskOf(undone, c.off.blend!), name).toBeUndefined();
      expect(docSel(undone), name).toEqual(docSel(c.before));
    }
  });

  it("a drawn selection's shape stays beside the pixels for the Transform handles; a Smart one has none", () => {
    const c = build();
    expect(artMask(c.finish_exposure_rectangle_uncropped.after, c.finish_exposure_rectangle_uncropped.off.blend!).regions).toEqual([RECT]);
    expect(artMask(c.finish_exposure_subject_uncropped.after, c.finish_exposure_subject_uncropped.off.blend!).regions).toBeUndefined();
    expect(artMask(c.finish_exposure_polished_uncropped.after, c.finish_exposure_polished_uncropped.off.blend!).regions).toBeUndefined();
  });

  it("Shift adds a selection to the mask and Option takes it out, one undo each", () => {
    const c = build();
    for (const op of ["add", "subtract"] as const) {
      const k = c[`combine_${op}_uncropped`];
      const mask = artMask(k.after, k.off.blend!);
      expect(mask.type).toBe("heeler.brush_mask");
      expect(mask.textParams?.matte_id).toBe(`baked:${BAKE_B}`);
      expect(mask.params.invert).toBe(1);
      expect(mask.regions).toEqual([RECT, { ...SECOND, op }]);
      expect(docSel(k.after).regions).toEqual([]);
      const undone = run(k.after, { type: "undo" } as Command);
      expect(artMask(undone, k.off.blend!).textParams?.matte_id).toBe(`baked:${BAKE_A}`);
      expect(docSel(undone).regions).toEqual([SECOND]);
    }
  });

  it("the brush paints into the converted mask, on top of its pixels", () => {
    const k = build().finish_exposure_subject_uncropped;
    const mid = `art_m_${k.off.blend}`;
    expect(k.after.tool).toBe("brush");
    expect(maskBrushTarget(k.after)?.id).toBe(mid);
    const painted = run(k.after, { type: "add_stroke", id: mid, stroke: { points: [[0.3, 0.3]], radius: 0.05, hardness: 1, flow: 1 } } as Command);
    const mask = artMask(painted, k.off.blend!);
    expect(mask.strokes).toHaveLength(1);
    expect(mask.textParams?.matte_id).toBe(`baked:${BAKE_A}`);
  });

  it("To Mask makes a Finish or Develop Smart mask the brush's kind, in place", () => {
    for (const [name, c] of Object.entries(build())) {
      if (!name.startsWith("to_mask_")) continue;
      const mask = artMaskNode(c.after, c.reference)!;
      expect(mask.type, name).toBe("heeler.brush_mask");
      expect(mask.textParams?.matte_id, name).toBe(`baked:${TO_MASK_BAKE}`);
      const develop = name.startsWith("to_mask_develop");
      expect(mask.params.invert, name).toBe(develop ? 0 : 1);
      expect(mask.params.base_invert, name).toBe(develop ? 0 : 1);
      expect(c.after.tool, name).toBe("brush");
    }
  });

  it("Isolate Selection and Fill Selection mask their new layer with the bake", () => {
    for (const sel of ["subject", "subject_and_rectangle", "polished"]) {
      const s = run(fresh(), ...SELECTIONS[sel]);
      for (const cmd of [
        { type: "art_layer_from_selection", maskId: DOC_SEL_ID, version: BAKE_A },
        { type: "art_fill_from_selection", maskId: DOC_SEL_ID, color: "#ff0000", version: BAKE_A },
      ] as Command[]) {
        const out = run(s, cmd);
        const mask = artMask(out, out.artActive!);
        expect(mask.type, `${sel} ${cmd.type}`).toBe("heeler.brush_mask");
        expect(mask.textParams?.matte_id, `${sel} ${cmd.type}`).toBe(`baked:${BAKE_A}`);
        expect(docSel(out).textParams?.matte_id ?? "", `${sel} ${cmd.type}`).toBe("");
      }
    }
  });

  it("a Develop Selection layer, a kind of its own, still adopts the whole selection", () => {
    for (const [name, c] of Object.entries(build())) {
      if (!name.startsWith("develop_")) continue;
      const src = docSel(c.before);
      const mask = c.after.nodes.find((n) => n.id === c.off.adj!.replace("_adj", "_mask"))!;
      expect(mask.type, name).toBe("heeler.selection_mask");
      expect(mask.regions ?? [], name).toEqual(src.regions ?? []);
      expect(mask.strokes ?? [], name).toEqual(src.strokes ?? []);
      expect(mask.textParams?.matte_id ?? "", name).toBe(src.textParams?.matte_id ?? "");
    }
  });

  it("a layer mask saved as a live selection opens as a pixel mask with the selection frozen under it", () => {
    for (const [name, c] of Object.entries(build())) {
      if (!name.startsWith("legacy_")) continue;
      const was = artMaskNode(c.before, c.reference)!;
      const now = artMaskNode(c.after, c.reference)!;
      expect(was.type, name).toBe("heeler.selection_mask");
      expect(now.type, name).toBe("heeler.brush_mask");
      expect(now.strokes, name).toEqual([]);
      expect(now.params.invert, name).toBe(1);
      const frozen = JSON.parse(now.textParams!.base_selection!);
      expect(JSON.parse(frozen.regions), name).toEqual((was.regions ?? []).filter((r) => !r.off));
      expect(frozen.matte_id ?? "", name).toBe(was.textParams?.matte_id ?? "");
    }
    // A removal's hole still waiting for its snapshot keeps the pointer
    // the removal fills in, and paints the fill brush's way round.
    let s = run(fresh(), ...SELECTIONS.rectangle, { type: "art_add_layer", kind: "fix" } as Command);
    const hole = s.artActive!;
    s = rawLegacySelectionMask(s, hole, { regions: [], params: { antialias: 1 }, textParams: { matte_id: "", source: DOC_SEL_ID } });
    const opened = artMaskNode({ ...s, nodes: migrateNodes(s.nodes) }, `art_m_${hole}`)!;
    expect(opened.type).toBe("heeler.brush_mask");
    expect(opened.textParams).toEqual({ source: DOC_SEL_ID, matte_id: "" });
    expect(opened.params.invert).toBe(0);
  });

  it("a saved live selection's frozen base follows a later crop as the selection would have", () => {
    for (const sel of ["rectangle", "lasso", "polished", "feathered"]) {
      const layered = finishLayer(fresh(), "exposure");
      const blend = layered.artActive!;
      const selected = run(layered, ...SELECTIONS[sel]);
      const raw = rawLegacySelectionMask(selected, blend, liveCopy(docSel(selected)));
      const opened = { ...raw, nodes: migrateNodes(raw.nodes) };
      const crop = { type: "set_params", id: "crop", values: CROPS.turned } as Command;
      // The live selection, cropped as the app cropped it, against the
      // pixel mask opened from it, cropped now.
      const live = artMaskNode(run(raw, crop), `art_m_${blend}`)!;
      const frozen = JSON.parse(artMaskNode(run(opened, crop), `art_m_${blend}`)!.textParams!.base_selection!);
      expect(JSON.parse(frozen.regions), sel).toEqual((live.regions ?? []).filter((r) => !r.off));
      expect(JSON.parse(frozen.strokes), sel).toEqual(live.strokes ?? []);
      for (const k of ["feather", "grow", "smooth"]) expect(frozen[k], `${sel} ${k}`).toBe(live.params[k]);
    }
  });

  it("serialized graphs match the desktop pixel fixture", () => {
    const fixtures = Object.fromEntries(
      Object.entries(build()).map(([name, c]) => [
        name,
        {
          before: serializeGraph(c.before),
          after: serializeGraph(c.after),
          reference: c.reference,
          off: c.off,
          ...(c.mid ? { mid: serializeGraph(c.mid), second: serializeGraph(c.second!), op: c.op } : {}),
        },
      ]),
    );
    if (process.env.GEN_FIXTURE) writeFileSync(FIXTURE, JSON.stringify(fixtures, null, 1) + "\n");
    expect(fixtures).toEqual(expected);
  });
});

type Door = { dispatch: (c: Command) => void; state: () => State };
const door = () => (window as unknown as { __heeler: Door }).__heeler;

/** The App with a Finish layer of `kind` made through the reducer's own
 * commands, the way its toolbar makes it. */
function finishApp(kind: string): string {
  render(<App />);
  fireEvent.click(screen.getByTestId("panel-tab-layers"));
  act(() => {
    if (kind === "image") {
      door().dispatch({ type: "art_add_file_layers", path: "__IMAGE__", items: [{ layer: "", name: "picture", box: null }] } as Command);
    } else {
      door().dispatch({ type: "art_add_layer", kind } as Command);
    }
  });
  return door().state().artActive!;
}

/** The layer mask's eye is on screen, once, and shows this layer's mask. */
function expectMaskEye(blend: string, label: string) {
  const eyes = screen.getAllByTestId("mask-view-chip");
  expect(eyes, label).toHaveLength(1);
  fireEvent.click(eyes[0]);
  expect(door().state().maskView, label).toBe(true);
  expect(maskPreviewNode(door().state()), label).toBe(`art_m_${blend}`);
}

describe("the Finish layer's Mask from selection button", () => {
  it("is offered for a Smart selection, which has no regions, and gives the layer a pixel mask of it", async () => {
    const blend = finishApp("exposure");
    expect(screen.queryByTestId(`art-mask-from-selection-${blend}`)).toBeNull();
    act(() => {
      for (const c of SELECTIONS.subject) door().dispatch(c);
    });
    fireEvent.click(await screen.findByTestId(`art-mask-from-selection-${blend}`));
    await waitFor(() => expect(artMask(door().state(), blend)?.textParams?.matte_id).toBe(`baked:${BAKE_A}`));
    expect(vi.mocked(bakeLayerMask).mock.calls[0].slice(1)).toEqual([DOC_SEL_ID, `art_m_${blend}`, undefined, "replace"]);
    expect(artMask(door().state(), blend).type).toBe("heeler.brush_mask");
    expect(docSel(door().state()).textParams?.matte_id).toBe("");
  });

  it("Shift adds to the layer's mask and Option takes out of it, through the desktop's bake", async () => {
    const blend = finishApp("exposure");
    act(() => {
      door().dispatch({ type: "art_add_mask", id: blend, kind: "brush" } as Command);
      for (const c of SELECTIONS.rectangle) door().dispatch(c);
    });
    fireEvent.click(await screen.findByTestId(`art-mask-from-selection-${blend}`), { shiftKey: true });
    await waitFor(() => expect(artMask(door().state(), blend).textParams?.matte_id).toBe(`baked:${BAKE_A}`));
    expect(vi.mocked(bakeLayerMask).mock.calls[0].slice(1)).toEqual([DOC_SEL_ID, `art_m_${blend}`, `art_m_${blend}`, "add"]);
    act(() => {
      for (const c of SELECTIONS.lasso) door().dispatch(c);
    });
    fireEvent.click(await screen.findByTestId(`art-mask-from-selection-${blend}`), { altKey: true });
    await waitFor(() => expect(vi.mocked(bakeLayerMask)).toHaveBeenCalledTimes(2));
    expect(vi.mocked(bakeLayerMask).mock.calls[1].slice(1)).toEqual([DOC_SEL_ID, `art_m_${blend}`, `art_m_${blend}`, "subtract"]);
  });

  it("Shift on a layer with no mask is the plain click; Option hides the selection from it", async () => {
    const blend = finishApp("exposure");
    act(() => {
      for (const c of SELECTIONS.rectangle) door().dispatch(c);
    });
    fireEvent.click(await screen.findByTestId(`art-mask-from-selection-${blend}`), { shiftKey: true });
    await waitFor(() => expect(vi.mocked(bakeLayerMask)).toHaveBeenCalledTimes(1));
    expect(vi.mocked(bakeLayerMask).mock.calls[0].slice(1)).toEqual([DOC_SEL_ID, `art_m_${blend}`, undefined, "replace"]);
  });

  // One test per layer kind, not one loop over the four: each renders
  // the whole App, and four in one test ran past the 5 s limit on a
  // slower Linux machine, where the abandoned loop then cleared the
  // page under the next test.
  for (const kind of ["exposure", "paint", "warp", "image"]) {
    it(`the converted mask has the brush in hand, one eye, and Invert (${kind})`, async () => {
      const blend = finishApp(kind);
      act(() => {
        for (const c of SELECTIONS.subject) door().dispatch(c);
      });
      fireEvent.click(await screen.findByTestId(`art-mask-from-selection-${blend}`));
      await waitFor(() => expect(artMask(door().state(), blend)?.type).toBe("heeler.brush_mask"));
      expect(door().state().tool, kind).toBe("brush");
      expect(screen.getByTestId(`art-mask-edit-${blend}`)).toBeInTheDocument();
      expect(screen.getByTestId(`art-mask-remove-${blend}`)).toBeInTheDocument();
      expect(screen.getByTestId(`art-depth-${blend}-toggle`)).toBeInTheDocument();
      expectMaskEye(blend, kind);
      // Invert flips the pixel mask, and lights while it is flipped.
      const invert = screen.getByTestId(`art-mask-invert-${blend}`);
      expect(invert.getAttribute("data-active"), kind).toBeNull();
      fireEvent.click(invert);
      expect(artMask(door().state(), blend).params.invert, kind).toBe(0);
      expect(screen.getByTestId(`art-mask-invert-${blend}`).getAttribute("data-active"), kind).toBe("true");
    });
  }
});

describe("To Mask hands over a pixel mask with its eye", () => {
  for (const kind of ["exposure", "paint", "warp", "image"]) {
    it(`To Mask on a ${kind} layer's Smart mask`, async () => {
      const blend = finishApp(kind);
      act(() => {
        door().dispatch({ type: "art_add_mask", id: blend, kind: "smart" } as Command);
        door().dispatch({ type: "set_tool", tool: "smart" } as Command);
        door().dispatch({ type: "set_text_param", id: `art_m_${blend}`, param: "model", value: "mobile_sam" } as Command);
      });
      // The Smart dials carry the eye.
      expect(screen.getByTestId(`art-mask-eye-${blend}`)).toBeInTheDocument();
      fireEvent.click(screen.getByTestId("smart-to-mask"));
      await waitFor(() => expect(artMask(door().state(), blend).type).toBe("heeler.brush_mask"));
      expect(artMask(door().state(), blend).textParams?.matte_id).toBe(`baked:${TO_MASK_BAKE}`);
      expectMaskEye(blend, kind);
    });
  }

  it("a Develop Smart layer becomes a Brush layer with its block's single eye", async () => {
    render(<App />);
    act(() => {
      door().dispatch({ type: "add_layer", maskType: "smart" } as Command);
    });
    const mid = door().state().activeLayer!.replace("_adj", "_mask");
    act(() => {
      door().dispatch({ type: "set_text_param", id: mid, param: "model", value: "mobile_sam" } as Command);
    });
    fireEvent.click(screen.getByTestId("smart-to-mask"));
    await waitFor(() => expect(artMaskNode(door().state(), mid)?.type).toBe("heeler.brush_mask"));
    expect(screen.getAllByTestId("mask-view-toggle")).toHaveLength(1);
    fireEvent.click(screen.getByTestId("mask-view-toggle"));
    expect(maskPreviewNode(door().state())).toBe(mid);
  });

  it("Add layer mask's brush shows the same eye, once", () => {
    const blend = finishApp("exposure");
    fireEvent.click(screen.getByTestId(`art-mask-add-${blend}`));
    fireEvent.click(screen.getByTestId(`art-mask-edit-${blend}`));
    expect(door().state().tool).toBe("brush");
    expectMaskEye(blend, "brush");
  });

  it("the select tool's panel is the document selection's, never a layer mask's", async () => {
    const blend = finishApp("exposure");
    act(() => {
      for (const c of SELECTIONS.rectangle) door().dispatch(c);
    });
    fireEvent.click(await screen.findByTestId(`art-mask-from-selection-${blend}`));
    await waitFor(() => expect(artMask(door().state(), blend)?.type).toBe("heeler.brush_mask"));
    act(() => {
      door().dispatch({ type: "arm_document_selection" } as Command);
    });
    expect(screen.getByTestId("select-tab-title").textContent).toBe("Selection");
  });
});
