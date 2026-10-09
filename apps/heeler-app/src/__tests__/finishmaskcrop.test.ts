import { describe, it, expect } from "vitest";
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import expected from "./fixtures/finish-mask-crop.json";
import { initialState, NEUTRAL_NODES, NEUTRAL_WIRES } from "../data";
import { ART_ID, artMaskView, reduce, masksReadTheFrame, DOC_SEL_ID, type State, type Command, type Wire, type NodeCard } from "../state";
import { serializeGraph } from "../bridge";
import { legacySelectionMask } from "./legacymask";

// A mask gates the frame it is measured on. Behind a crop that frame is
// the crop's, and a mask reading the image source ahead of it came out
// the photograph's size: the engine dropped it and a masked Finish
// layer covered the whole frame after a crop (2026-09-30). These build
// the graphs the app builds, through the reducer, in the order a
// person works (the layer and its mask first, the crop after), and the
// desktop's pixel tests (src-tauri/src/finish_mask_crop.rs) render the
// serialized graphs at Fit, 1:1 and export. After a deliberate change
// to what the reducer builds, regenerate:
//   GEN_FIXTURE=1 npx vitest run finishmaskcrop

function fresh(): State {
  return {
    ...initialState(),
    activeImage: "finish_mask_crop",
    nodes: structuredClone(NEUTRAL_NODES),
    wires: structuredClone(NEUTRAL_WIRES),
  };
}

const run = (s: State, ...cmds: Command[]): State => cmds.reduce(reduce, s);

/** Placeholders the desktop test rewrites per crop: the marquee, the
 * brush stroke and the polish stroke are drawn on the cropped frame. */
const MARQUEE = { kind: "marquee", op: "add", x0: 0.4, y0: 0.4, x1: 0.6, y1: 0.6 } as const;
const CROP = { crop_x: 0.2, crop_y: 0.2, crop_w: 0.6, crop_h: 0.6 };
const COVER = { points: [[0.5, 0.5]] as [number, number][], radius: 2, hardness: 1, flow: 1 };

/** A Finish layer of `kind` over the whole frame, masked by `mask`,
 * then the crop. */
function finishLayer(kind: string, mask: "selection" | "brush" | "smart" | "polish" | "depth"): State {
  let s = run(fresh(), { type: "art_add_layer", kind } as Command);
  if (kind === "image") {
    s = run(fresh(), { type: "art_add_file_layers", path: "__IMAGE__", items: [{ layer: "", name: "picture", box: null }] });
  }
  const id = s.artActive!;
  if (kind === "paint") s = run(s, { type: "art_add_stroke", id, stroke: { ...COVER, color: "#ff2000" } });
  if (kind === "dodgeburn") s = run(s, { type: "art_add_stroke", id, stroke: { ...COVER, color: "#ffffff" } });
  if (kind === "clone") s = run(s, { type: "art_add_stroke", id, stroke: { ...COVER, src_dx: 0.013, src_dy: 0.021 } });
  if (kind === "heal") s = run(s, { type: "art_add_stroke", id, stroke: { ...COVER, src_dx: 0.013, src_dy: 0.021, heal: true } });
  if (kind === "fill") s = run(s, { type: "art_content_set", id, param: "color", value: "#ff2000" });
  if (kind === "exposure") s = run(s, { type: "art_content_set", id, param: "exposure", value: 2 });
  // A selection mask, polished or not, is a layer saved as a live
  // selection before 2026-09-30, opened as the pixel mask it is now:
  // its frozen base must follow the crop as the selection did.
  if (mask === "selection" || mask === "polish") {
    const polish = mask === "polish" ? [{ points: [[0.5, 0.5]], radius: 0.05, mode: "background" }] : undefined;
    s = legacySelectionMask(s, id, [MARQUEE as never], polish as never);
  } else {
    s = run(s, { type: "art_add_mask", id, kind: mask === "depth" ? "brush" : mask });
  }
  const mid = `art_m_${id}`;
  if (mask === "brush") s = run(s, { type: "add_stroke", id: mid, stroke: { points: [[0.5, 0.5]], radius: 0.08, hardness: 1, flow: 1 } });
  if (mask === "smart") s = run(s, { type: "set_text_param", id: mid, param: "mode", value: "subject" });
  if (mask === "depth") {
    s = run(
      s,
      { type: "set_param", id: mid, param: "depth_on", value: 1 },
      { type: "set_param", id: mid, param: "depth_black", value: 0.4 },
      { type: "set_param", id: mid, param: "depth_white", value: 0.6 },
    );
  }
  return run(s, { type: "set_params", id: "crop", values: CROP });
}

/** A Develop selection layer made before the photograph's first crop. */
function developLayer(): State {
  let s = run(fresh(), { type: "add_layer", maskType: "selection" });
  const id = s.activeLayer!;
  const mid = id.replace("_adj", "_mask");
  s = run(s, { type: "add_region", id: mid, region: MARQUEE }, { type: "set_param", id, param: "exposure", value: 2 });
  return run(s, { type: "set_params", id: "crop", values: CROP });
}

const LAYERS = ["paint", "exposure", "fill", "gradient", "image", "dodgeburn", "clone", "heal"];
const MASKS = ["brush", "smart", "polish", "depth"] as const;

function build(): Record<string, State> {
  const out: Record<string, State> = {};
  for (const kind of LAYERS) out[`layer_${kind}`] = finishLayer(kind, "selection");
  for (const mask of MASKS) out[`mask_${mask}`] = finishLayer("fill", mask);
  out.develop_selection = developLayer();
  return out;
}

describe("masks read the frame they gate", () => {
  it("every mask built before the crop reads the crop after it", () => {
    // Read in the outside shape (artMaskView): a Finish mask lives in
    // the Finish group, its feed on the group's boundary.
    for (const [name, sunk] of Object.entries(build())) {
      const s = artMaskView(sunk);
      const masks = s.nodes.filter((n) => n.type.endsWith("_mask"));
      expect(masks.length, name).toBeGreaterThan(0);
      for (const m of masks) {
        const feed = s.wires.find((w) => w.to === m.id && w.toPort === "in");
        expect(feed?.from, `${name}: ${m.id}`).toBe("crop");
      }
    }
  });

  it("a mask made after the crop reads the crop from birth", () => {
    let s = run(fresh(), { type: "set_params", id: "crop", values: CROP }, { type: "art_add_layer", kind: "fill" } as Command);
    s = run(s, { type: "art_add_mask", id: s.artActive!, kind: "brush" });
    const mid = `art_m_${s.artActive}`;
    // In the Finish group: the crop's pipe lands on the group's second
    // input, and the group's boundary hands it to the mask.
    expect(s.wires.find((w) => w.to === ART_ID && w.toPort === "in2")?.from).toBe("crop");
    expect(s.nodes.find((n) => n.id === ART_ID)!.groupBoundary!.find((b) => b.to === mid && b.toPort === "in")?.from).toBe("crop");
    expect(artMaskView(s).wires.find((w) => w.to === mid && w.toPort === "in")?.from).toBe("crop");
  });

  it("undoing the crop puts the mask back on the photograph", () => {
    const cropped = finishLayer("fill", "selection");
    const mid = `art_m_${cropped.artActive}`;
    // The write, then the crop's own build.
    const undone = run(cropped, { type: "undo" }, { type: "undo" });
    expect(undone.nodes.some((n) => n.type === "heeler.crop_rotate")).toBe(false);
    expect(artMaskView(undone).wires.find((w) => w.to === mid && w.toPort === "in")?.from).toBe("src");
    expect(undone.wires.find((w) => w.to === ART_ID && w.toPort === "in2")?.from).toBe("src");
  });

  it("a mask gating a node ahead of the crop keeps reading the photograph", () => {
    const nodes = [
      { id: "src", type: "heeler.image_source" },
      { id: "early", type: "heeler.exposure" },
      { id: "crop", type: "heeler.crop_rotate" },
      { id: "late", type: "heeler.exposure" },
      { id: "m1", type: "heeler.brush_mask" },
      { id: "m2", type: "heeler.brush_mask" },
      { id: "inv", type: "heeler.invert_mask" },
    ] as NodeCard[];
    const wires: Wire[] = [
      { from: "src", to: "early", toPort: "in", kind: "image" },
      { from: "early", to: "crop", toPort: "in", kind: "image" },
      { from: "crop", to: "late", toPort: "in", kind: "image" },
      { from: "src", to: "m1", toPort: "in", kind: "image" },
      { from: "m1", to: "early", toPort: "mask", kind: "mask" },
      { from: "src", to: "m2", toPort: "in", kind: "image" },
      { from: "m2", to: "inv", toPort: "mask", kind: "mask" },
      { from: "inv", to: "late", toPort: "mask", kind: "mask" },
    ];
    const out = masksReadTheFrame(nodes, wires);
    expect(out.find((w) => w.to === "m1")?.from).toBe("src");
    // Through Invert Mask to a gate behind the crop.
    expect(out.find((w) => w.to === "m2")?.from).toBe("crop");
    // Nothing to move, the same array.
    expect(masksReadTheFrame(nodes, out)).toBe(out);
  });

  // The document selection gates nothing (a selection is not a layer
  // mask), so no gate decides where it belongs. The first crop moved it
  // in the reducer, but one saved before masks read the frame came back
  // on the photograph while the desktop, which left it there too, drew
  // its marquee on the photograph under ants drawn on the frame.
  it("a document selection made before the first crop reads the crop after it", () => {
    let s = run(fresh(), { type: "arm_document_selection" });
    expect(s.wires.find((w) => w.to === DOC_SEL_ID && w.toPort === "in")?.from).toBe("src");
    s = run(s, { type: "add_region", id: DOC_SEL_ID, region: MARQUEE }, { type: "set_params", id: "crop", values: CROP });
    expect(s.wires.find((w) => w.to === DOC_SEL_ID && w.toPort === "in")?.from).toBe("crop");
  });

  it("a saved document selection on the photograph reads the crop when the graph loads", () => {
    const cropped = run(fresh(), { type: "set_params", id: "crop", values: CROP }, { type: "arm_document_selection" });
    expect(cropped.wires.find((w) => w.to === DOC_SEL_ID && w.toPort === "in")?.from).toBe("crop");
    // As saved before: the selection and a mask wired to nothing, both
    // on the photograph.
    const loose = { id: "loose_mask", type: "heeler.selection_mask", name: "Mask", cat: "masking", x: 0, y: 0, enabled: true, params: {} } as NodeCard;
    const wires: Wire[] = [
      ...cropped.wires.map((w) => (w.to === DOC_SEL_ID && w.toPort === "in" ? { ...w, from: "src" } : w)),
      { from: "src", to: "loose_mask", toPort: "in", kind: "image" },
    ];
    const loaded = run(fresh(), { type: "replace_graph", nodes: [...cropped.nodes, loose], wires } as Command);
    const feed = (id: string) => loaded.wires.find((w) => w.to === id && w.toPort === "in")?.from;
    expect(feed(DOC_SEL_ID)).toBe("crop");
    expect(feed("loose_mask")).toBe("crop");
    // The picture itself still reads the photograph.
    expect(feed("crop")).toBe("src");
    // Loaded again, nothing moves.
    const again = run(fresh(), { type: "replace_graph", nodes: loaded.nodes, wires: loaded.wires } as Command);
    expect(again.wires).toEqual(loaded.wires);
  });

  // The desktop's rule (lib.rs masks_read_the_frame) on the same graph
  // as its test: a mask with no gate, or only an Export Layer tap,
  // reads the crop; one gating a node ahead of the crop keeps the
  // photograph; a picture op is never moved.
  it("masks with no gate read the crop, as the desktop reads them", () => {
    const nodes = [
      { id: "src", type: "heeler.image_source" },
      { id: "early", type: "heeler.exposure" },
      { id: "crop", type: "heeler.crop_rotate" },
      { id: "late", type: "heeler.exposure" },
      { id: "m_early", type: "heeler.brush_mask" },
      { id: "m_tap", type: "heeler.brush_mask" },
      { id: "tap", type: "heeler.export_layer" },
      { id: "m_loose", type: "heeler.selection_mask" },
      { id: "loose_op", type: "heeler.exposure" },
    ] as NodeCard[];
    const wires: Wire[] = [
      { from: "src", to: "early", toPort: "in", kind: "image" },
      { from: "early", to: "crop", toPort: "in", kind: "image" },
      { from: "crop", to: "late", toPort: "in", kind: "image" },
      { from: "src", to: "m_early", toPort: "in", kind: "image" },
      { from: "m_early", to: "early", toPort: "mask", kind: "mask" },
      { from: "src", to: "m_tap", toPort: "in", kind: "image" },
      { from: "m_tap", to: "tap", toPort: "mask", kind: "mask" },
      { from: "src", to: "m_loose", toPort: "in", kind: "image" },
      { from: "src", to: "loose_op", toPort: "in", kind: "image" },
    ];
    const out = masksReadTheFrame(nodes, wires);
    const feed = (id: string) => out.find((w) => w.to === id && w.toPort === "in")?.from;
    expect(feed("m_early")).toBe("src");
    expect(feed("m_tap")).toBe("crop");
    expect(feed("m_loose")).toBe("crop");
    expect(feed("loose_op")).toBe("src");
  });

  it("serialized graphs match the desktop pixel fixture", () => {
    const fixtures = Object.fromEntries(Object.entries(build()).map(([name, s]) => [name, serializeGraph(s)]));
    if (process.env.GEN_FIXTURE) {
      writeFileSync(resolve(process.cwd(), "src/__tests__/fixtures/finish-mask-crop.json"), JSON.stringify(fixtures, null, 1) + "\n");
    }
    expect(fixtures).toEqual(expected);
  });
});
