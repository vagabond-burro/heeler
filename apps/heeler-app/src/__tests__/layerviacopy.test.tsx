import { describe, it, expect, vi, beforeEach} from "vitest";
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { render, screen, act, fireEvent, waitFor } from "@testing-library/react";
import expected from "./fixtures/layer-via-copy.json";
import { initialState, NEUTRAL_NODES, NEUTRAL_WIRES } from "../data";
import { reduce, artLayers, layerViaCopySource, ART_ID, DOC_SEL_ID, type State, type Command } from "../state";
import { serializeGraph, bakeLayerCopy } from "../bridge";
import { runCommand } from "../commands";
import { COMMANDS } from "../hotkeys";
import { frameRemap, cropGeomOf, cropGeomOfParams, applyAffine, remapNode } from "../framemap";
import { App } from "../app";

// New Layer via Copy (2026-09-30: "to be able to marquee select part of
// the background picture and copy that to a new pixel layer", then "the
// layer via copy means that layer would have to be like an image layer
// and have its own warp effect on the layer"). The desktop cuts the
// pixels inside the selection (bake_layer_copy) and the reducer lays an
// image layer down on the rectangle they came from, above the active
// layer, in one undo step, the selection left as it was.
//
// These build the copy through the reducer for every kind of selection
// on an uncropped, a cropped and a turned photograph, from the picture
// under the Finish layers and from a Pixel and an Image layer, then crop
// again, and pin the serialized graphs; the desktop's pixel test
// (src-tauri/src/layer_via_copy.rs) makes the copy the placeholders stand
// for, renders at Fit, 1:1 and export, and checks the copy is the
// selection's pixels, lands where it was cut from, moves with its
// corners and stays on the scene through the second crop. After a
// deliberate change to what the reducer builds, regenerate:
//   GEN_FIXTURE=1 npx vitest run layerviacopy

/** The placement every case is given: the desktop test pads its real
 * cut out to this rectangle, which is whole pixels on every frame here
 * (600 by 400, its 0.6 crop, the turn's 0.7) at full size and at a
 * quarter, and holds every selection. */
const PLACE = { x: 0.2, y: 0.2, w: 0.6, h: 0.6 };
const ASPECT = 1.5;
const COPY = "__COPY__";

vi.mock("../bridge", async (importOriginal) => {
  const real = await importOriginal<typeof import("../bridge")>();
  return {
    ...real,
    bakeLayerCopy: vi.fn(async () => ({ path: "/kept/layercopies/00000000000000aa.tif", box: [0.2, 0.2, 0.6, 0.6], aspect: 1.5, width: 360, height: 240 })),
  };
});

beforeEach(() => {
  vi.mocked(bakeLayerCopy).mockClear();
});

const FIXTURE = resolve(process.cwd(), "src/__tests__/fixtures/layer-via-copy.json");
const IMAGE = "layer_via_copy";
const SUBJECT_BASE = "baked:00000000000000b1";

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

const CROPS: Record<string, Record<string, number>> = {
  uncropped: { angle: 0, crop_x: 0, crop_y: 0, crop_w: 1, crop_h: 1 },
  cropped: { angle: 0, crop_x: 0.2, crop_y: 0.2, crop_w: 0.6, crop_h: 0.6 },
  turned: { angle: 8, crop_x: 0.15, crop_y: 0.15, crop_w: 0.7, crop_h: 0.7 },
};
/** The crop made after the copy: each frame to the next. */
const RECROP: Record<string, string> = { uncropped: "cropped", cropped: "turned", turned: "uncropped" };

const RECT = { kind: "marquee", op: "add", x0: 0.4, y0: 0.35, x1: 0.62, y1: 0.66 } as const;
const LASSO = { kind: "path", op: "add", points: [[0.4, 0.36], [0.63, 0.34], [0.6, 0.66], [0.42, 0.64]] as [number, number][] };

const SELECTIONS: Record<string, Command[]> = {
  rectangle: [{ type: "set_select_method", method: "rect" }, { type: "arm_document_selection" }, { type: "add_region", id: DOC_SEL_ID, region: RECT }],
  lasso: [{ type: "set_select_method", method: "freehand" }, { type: "arm_document_selection" }, { type: "add_region", id: DOC_SEL_ID, region: LASSO }],
  polished: [
    { type: "set_select_method", method: "rect" },
    { type: "arm_document_selection" },
    { type: "add_region", id: DOC_SEL_ID, region: RECT },
    { type: "add_polish_stroke", id: DOC_SEL_ID, stroke: { points: [[0.51, 0.5]], radius: 0.05, mode: "background" } },
  ],
  // A soft edge a twentieth of the short side wide, kept inside the
  // placement.
  feathered: [
    { type: "set_select_method", method: "rect" },
    { type: "arm_document_selection" },
    { type: "add_region", id: DOC_SEL_ID, region: RECT },
    { type: "set_param", id: DOC_SEL_ID, param: "feather", value: 1 },
  ],
  subject: [
    { type: "set_select_method", method: "smart" },
    { type: "arm_document_selection" },
    { type: "set_text_param", id: DOC_SEL_ID, param: "mode", value: "subject" },
    { type: "set_text_param", id: DOC_SEL_ID, param: "matte_id", value: SUBJECT_BASE },
  ],
} as unknown as Record<string, Command[]>;

const COVER = { points: [[0.5, 0.5]] as [number, number][], radius: 2, hardness: 1, flow: 1 };

/** The layer copied from: none (the picture under the Finish layers), an
 * Adjustment layer active (still the picture), a Pixel layer painted all
 * over, an Image layer filling the frame. */
function withSource(s: State, from: string): State {
  if (from === "picture") return s;
  if (from === "adjusted") return run(s, { type: "art_add_layer", kind: "exposure" } as Command);
  if (from === "image") return run(s, { type: "art_add_file_layers", path: "__IMAGE__", items: [{ layer: "", name: "picture", box: null }] } as Command);
  const out = run(s, { type: "art_add_layer", kind: "paint" } as Command);
  return run(out, { type: "art_add_stroke", id: out.artActive!, stroke: { ...COVER, color: "#ff2000" } } as Command);
}

function cropped(crop: string): State {
  return run(fresh(), { type: "set_params", id: "crop", values: CROPS[crop] } as Command);
}

type Case = { bake: State; before: State; after: State; recropBefore: State; recropAfter: State; source: string; carrier: string | null };

/** The copy as runLayerViaCopy makes it, with the desktop's answer
 * standing in as the placement above. */
function copyOf(before: State): Case {
  const { source, carrier, above, name } = layerViaCopySource(before);
  const bake = before.nodes.some((n) => n.id === ART_ID) ? before : reduce(before, { type: "art_add_layer", kind: "image" });
  const after = run(before, { type: "art_layer_via_copy", path: COPY, box: PLACE, aspect: ASPECT, name, above } as Command);
  return { bake, before, after, recropBefore: before, recropAfter: after, source, carrier };
}

function build(): Record<string, Case> {
  const out: Record<string, Case> = {};
  for (const crop of Object.keys(CROPS)) {
    const cases: [string, string][] = [
      ...Object.keys(SELECTIONS).map((sel) => ["picture", sel] as [string, string]),
      ["adjusted", "rectangle"],
      ["paint", "rectangle"],
      ["image", "rectangle"],
    ];
    for (const [from, sel] of cases) {
      const before = run(withSource(cropped(crop), from), ...SELECTIONS[sel]);
      const c = copyOf(before);
      const recrop = { type: "set_params", id: "crop", values: CROPS[RECROP[crop]] } as Command;
      out[`${from}_${sel}_${crop}`] = { ...c, recropBefore: run(c.before, recrop), recropAfter: run(c.after, recrop) };
    }
  }
  return out;
}

const copyLayer = (s: State) => artLayers(s).find((l) => l.blend.id === s.artActive)!;

describe("New Layer via Copy makes an image layer of the selection's pixels", () => {
  it("lays the copy down on the rectangle it came from, placed, on the scene, the selection kept", () => {
    const c = build().picture_rectangle_cropped;
    const made = copyLayer(c.after);
    expect(made.content.type).toBe("heeler.file");
    expect(made.content.artKind).toBe("image");
    expect(made.content.textParams).toMatchObject({ path: COPY, layer: "", space: "display", origin: "copy" });
    expect(made.blend.textParams).toMatchObject({ fit: "place", anchor: "scene", mode: "normal" });
    expect(made.blend.params).toMatchObject({
      warp_bx: 0.2, warp_by: 0.2, warp_bw: 0.6, warp_bh: 0.6,
      warp_x0: 0.2, warp_y0: 0.2, warp_x1: 0.8, warp_y1: 0.2, warp_x2: 0.8, warp_y2: 0.8, warp_x3: 0.2, warp_y3: 0.8,
      warp_aspect: 1.5,
    });
    expect(made.blend.name).toBe("Picture copy");
    // A layer editor leaves the selection: the hole is still selected for the
    // strokes that fill it.
    const sel = (s: State) => s.nodes.find((n) => n.id === DOC_SEL_ID);
    expect(sel(c.after)).toEqual(sel(c.before));
  });

  it("takes an image layer's own warp, like any image layer", () => {
    const c = build().picture_rectangle_uncropped;
    const id = c.after.artActive!;
    const warped = run(c.after, { type: "art_layer_warp", id, on: true } as Command);
    expect(copyLayer(warped).fx.map((f) => f.type)).toEqual(["heeler.layer_warp"]);
    expect(copyLayer(warped).fx[0].textParams?.space).toBe("picture");
  });

  it("copies the active Pixel or Image layer's own picture, and the picture under an Adjustment layer", () => {
    const b = build();
    expect(b.paint_rectangle_uncropped.source).toMatch(/^art_p\d+$/);
    expect(b.paint_rectangle_uncropped.carrier).toBe(b.paint_rectangle_uncropped.before.artActive);
    expect(b.image_rectangle_uncropped.source).toMatch(/^art_p\d+$/);
    expect(b.adjusted_rectangle_uncropped.source).toBe("art_in");
    expect(b.adjusted_rectangle_uncropped.carrier).toBeNull();
    expect(b.picture_rectangle_uncropped.source).toBe("art_in");
    // An image layer's own warp is what the composite shows, so it is
    // what is copied.
    const img = b.image_rectangle_uncropped.before;
    const warped = run(img, { type: "art_layer_warp", id: img.artActive!, on: true } as Command);
    expect(layerViaCopySource(warped).source).toMatch(/_warp$/);
    expect(copyLayer(b.paint_rectangle_uncropped.after).blend.name).toMatch(/ copy$/);
  });

  it("lands directly above the active layer, or on top with none", () => {
    // Two layers, the lower one active: the copy goes between them.
    let s = run(cropped("uncropped"), { type: "art_add_layer", kind: "paint" } as Command, { type: "art_add_layer", kind: "exposure" } as Command);
    const [lower, upper] = artLayers(s).map((l) => l.blend.id);
    s = run(s, { type: "select_art_layer", id: lower } as Command, ...SELECTIONS.rectangle);
    const after = copyOf(s).after;
    const order = artLayers(after).map((l) => l.blend.id);
    expect(order).toEqual([lower, after.artActive, upper]);
    // None active: on top.
    const top = copyOf(run(cropped("uncropped"), { type: "art_add_layer", kind: "paint" } as Command, { type: "select_art_layer", id: null } as Command, ...SELECTIONS.rectangle));
    const ids = artLayers(top.after).map((l) => l.blend.id);
    expect(ids[ids.length - 1]).toBe(top.after.artActive);
  });

  it("is one undo step, which also takes back the Finish stack it had to make", () => {
    const c = build().picture_rectangle_uncropped;
    expect(c.before.nodes.some((n) => n.id === ART_ID)).toBe(false);
    const undone = run(c.after, { type: "undo" } as Command);
    expect(undone.nodes).toEqual(c.before.nodes);
    const p = build().paint_rectangle_turned;
    expect(artLayers(run(p.after, { type: "undo" } as Command)).length).toBe(artLayers(p.before).length);
  });

  it("stays on the scene through a later crop, its corners carried by the crop's own map", () => {
    for (const [name, c] of Object.entries(build())) {
      const map = frameRemap(cropGeomOf(c.after.nodes), cropGeomOf(c.recropAfter.nodes), ASPECT)!;
      expect(map, name).toBeTruthy();
      const was = copyLayer(c.after).blend.params;
      const now = artLayers(c.recropAfter).find((l) => l.blend.id === c.after.artActive)!.blend.params;
      for (let i = 0; i < 4; i++) {
        const [x, y] = applyAffine(map.m, [was[`warp_x${i}`], was[`warp_y${i}`]]);
        expect(now[`warp_x${i}`], `${name} x${i}`).toBeCloseTo(x, 12);
        expect(now[`warp_y${i}`], `${name} y${i}`).toBeCloseTo(y, 12);
      }
      // The stamp of the frame it was cut on is dropped: the numbers are
      // the new frame's now.
      expect(now.warp_aspect, name).toBeUndefined();
    }
  });

  it("a picture brought in from a file keeps its place on the frame through a crop, as it did", () => {
    const s = run(cropped("uncropped"), { type: "art_add_image_layer", source: { kind: "file", path: "/x.png" }, name: "x", box: PLACE } as Command);
    const blend = artLayers(s)[0].blend;
    const map = frameRemap(cropGeomOfParams(CROPS.uncropped), cropGeomOfParams(CROPS.cropped), ASPECT)!;
    expect(remapNode(blend, map)).toBe(blend);
  });

  it("serialized graphs match the desktop pixel fixture", () => {
    const fixtures = Object.fromEntries(
      Object.entries(build()).map(([name, c]) => [
        name,
        {
          bake: serializeGraph(c.bake),
          before: serializeGraph(c.before),
          after: serializeGraph(c.after),
          recrop_before: serializeGraph(c.recropBefore),
          recrop_after: serializeGraph(c.recropAfter),
          selection: DOC_SEL_ID,
          source: c.source,
          carrier: c.carrier,
        },
      ]),
    );
    if (process.env.GEN_FIXTURE) writeFileSync(FIXTURE, JSON.stringify(fixtures, null, 1) + "\n");
    expect(fixtures).toEqual(expected);
  });
});

describe("the command, its key and its seats", () => {
  it("is bound to Ctrl+J, which nothing else holds", () => {
    const spec = COMMANDS.find((c) => c.id === "layer.via_copy")!;
    expect(spec.binding).toBe("Ctrl+J");
    expect(spec.label).toBe("New Layer via Copy");
    expect(COMMANDS.filter((c) => c.binding === "Ctrl+J")).toHaveLength(1);
  });

  it("bakes the active layer's picture inside the selection and lays the copy down", async () => {
    const s = run(withSource(cropped("uncropped"), "paint"), ...SELECTIONS.rectangle);
    const layer = s.artActive!;
    const seen: Command[] = [];
    expect(runCommand("layer.via_copy", s, (c) => void seen.push(c as Command))).toBe(true);
    await waitFor(() => expect(seen.some((c) => c.type === "art_layer_via_copy")).toBe(true));
    const [graphState, selection, source, carrier] = vi.mocked(bakeLayerCopy).mock.calls[0];
    expect(graphState).toBe(s);
    expect([selection, source, carrier]).toEqual([DOC_SEL_ID, layerViaCopySource(s).source, layer]);
    expect(seen.find((c) => c.type === "art_layer_via_copy")).toEqual({
      type: "art_layer_via_copy",
      expected: { image: s.activeImage, take: s.activeTakes[s.activeImage], crop: cropGeomOf(s.nodes) },
      path: "/kept/layercopies/00000000000000aa.tif",
      box: PLACE,
      aspect: 1.5,
      name: `${artLayers(s).find((l) => l.blend.id === layer)!.blend.name} copy`,
      above: layer,
    });
  });

  it("with no Finish stack yet, renders the picture from a graph with the stack made", async () => {
    const s = run(cropped("uncropped"), ...SELECTIONS.rectangle);
    runCommand("layer.via_copy", s, () => {});
    await waitFor(() => expect(vi.mocked(bakeLayerCopy)).toHaveBeenCalledTimes(1));
    const [graphState, , source, carrier] = vi.mocked(bakeLayerCopy).mock.calls[0];
    expect(graphState.nodes.some((n) => n.id === ART_ID)).toBe(true);
    expect([source, carrier]).toEqual(["art_in", null]);
  });

  it("on a free copy, asks for Pro before the desktop makes the copy", () => {
    const s = run(cropped("uncropped"), ...SELECTIONS.rectangle);
    const seen: Command[] = [];
    expect(runCommand("layer.via_copy", s, (c) => void seen.push(c as Command))).toBe(true);
    expect(vi.mocked(bakeLayerCopy)).not.toHaveBeenCalled();
    expect(seen.some((c) => c.type === "art_layer_via_copy")).toBe(false);
  });

  it("does nothing without a selection, and says where it works outside Finish", () => {
    const seen: Command[] = [];
    expect(runCommand("layer.via_copy", cropped("uncropped"), (c) => void seen.push(c as Command))).toBe(false);
    const develop = { ...run(cropped("uncropped"), ...SELECTIONS.rectangle), panelTab: "adjust" } as State;
    expect(runCommand("layer.via_copy", develop, (c) => void seen.push(c as Command))).toBe(true);
    expect(seen).toEqual([{ type: "set_notice", text: "New Layer via Copy works in the Finish tab" }]);
    expect(vi.mocked(bakeLayerCopy)).not.toHaveBeenCalled();
  });
});

type Door = { dispatch: (c: Command) => void; state: () => State };
const door = () => (window as unknown as { __heeler: Door }).__heeler;

describe("in the app", () => {
  it("the Layer menu's New Layer via Copy makes the layer, grayed until there is a selection", async () => {
    render(<App />);
    fireEvent.click(screen.getByTestId("panel-tab-layers"));
    fireEvent.click(screen.getByTestId("menu-layer"));
    expect(screen.getByTestId("menu-layer-via-copy")).toBeDisabled();
    fireEvent.click(screen.getByTestId("menu-layer"));
    act(() => {
      for (const c of SELECTIONS.rectangle) door().dispatch(c);
    });
    fireEvent.click(screen.getByTestId("menu-layer"));
    fireEvent.click(screen.getByTestId("menu-layer-via-copy"));
    await waitFor(() => expect(artLayers(door().state()).some((l) => l.content.textParams?.origin === "copy")).toBe(true));
    // The layer's source line says where its pixels came from, not the
    // kept file's hashed name.
    const id = door().state().artActive!;
    if (!screen.queryByTestId(`art-image-name-${id}`)) fireEvent.click(screen.getByTestId(`art-settings-${id}`));
    await waitFor(() => expect(screen.getByTestId(`art-image-name-${id}`).textContent).toBe("Copied from a selection"));
  });

  it("the Finish panel's Image seat offers From Selection", async () => {
    render(<App />);
    fireEvent.click(screen.getByTestId("panel-tab-layers"));
    act(() => {
      door().dispatch({ type: "art_add_layer", kind: "paint" } as Command);
    });
    fireEvent.click(screen.getByTestId("art-add-image"));
    expect(screen.getByTestId("art-image-from-copy")).toBeDisabled();
    fireEvent.click(screen.getByTestId("art-add-image"));
    act(() => {
      for (const c of SELECTIONS.rectangle) door().dispatch(c);
    });
    fireEvent.click(screen.getByTestId("art-add-image"));
    fireEvent.click(screen.getByTestId("art-image-from-copy"));
    await waitFor(() => expect(vi.mocked(bakeLayerCopy)).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(artLayers(door().state())).toHaveLength(2));
  });
});
