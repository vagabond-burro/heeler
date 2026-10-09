import { describe, it, expect } from "vitest";
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import expected from "./fixtures/mask-after-warp.json";
import { initialState, NEUTRAL_NODES, NEUTRAL_WIRES } from "../data";
import { artMaskView, reduce, frameFeed, masksReadTheFrame, type State, type Command, type Wire, type NodeCard } from "../state";
import { serializeGraph } from "../bridge";
import { framePoint, sourcePoint } from "../pickgeometry";
import { legacySelectionMask } from "./legacymask";

// A mask reads the frame its layer edits (2026-09-30): after the crop
// AND after the lens correction, the Grid Warp and the Shape Warp. Read
// at the crop, a mask sat on the unwarped frame while its layer landed
// on the warped one, off by the warp. These build the graphs the app
// builds, through the reducer, in the order a person works (the layer
// and its mask first, then the crop, then the lens and the warps), and
// the desktop's pixel tests (src-tauri/src/finish_mask_crop.rs, the
// warp half) render the serialized graphs at Fit, 1:1 and export with
// the lens and warps set. After a deliberate change to what the
// reducer builds, regenerate:
//   GEN_FIXTURE=1 npx vitest run maskafterwarp

function fresh(): State {
  return {
    ...initialState(),
    activeImage: "finish_mask_crop",
    nodes: structuredClone(NEUTRAL_NODES),
    wires: structuredClone(NEUTRAL_WIRES),
  };
}

const run = (s: State, ...cmds: Command[]): State => cmds.reduce(reduce, s);

const MARQUEE = { kind: "marquee", op: "add", x0: 0.4, y0: 0.4, x1: 0.6, y1: 0.6 } as const;
const CROP = { crop_x: 0.2, crop_y: 0.2, crop_w: 0.6, crop_h: 0.6 };

/** The crop, then the lens correction, the Grid Warp and the Shape
 * Warp switched on, each through its section's switch. The desktop
 * test writes their numbers. */
const GEOMETRY: Command[] = [
  { type: "set_params", id: "crop", values: CROP },
  { type: "set_category", title: "Lens", on: true },
  { type: "set_params", id: "lens", values: { distortion: 40 } },
  { type: "set_category", title: "Grid Warp", on: true },
  { type: "set_category", title: "Shape Warp", on: true },
];

/** A Finish layer masked by `mask`, then the geometry. */
function finishLayer(kind: "exposure" | "fill", mask: "selection" | "smart" | "depth" | "brush"): State {
  let s = run(fresh(), { type: "art_add_layer", kind } as Command);
  const id = s.artActive!;
  if (kind === "fill") s = run(s, { type: "art_content_set", id, param: "color", value: "#ff2000" });
  if (kind === "exposure") s = run(s, { type: "art_content_set", id, param: "exposure", value: 2 });
  // A selection mask is a layer saved as a live selection before
  // 2026-09-30, opened as the pixel mask it is now.
  s = mask === "selection" ? legacySelectionMask(s, id, [MARQUEE as never]) : run(s, { type: "art_add_mask", id, kind: mask === "depth" ? "brush" : mask });
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
  return run(s, ...GEOMETRY);
}

/** A Develop brush layer painted before the geometry. */
function developBrush(): State {
  let s = run(fresh(), { type: "add_layer", maskType: "brush" });
  const id = s.activeLayer!;
  const mid = id.replace("_adj", "_mask");
  s = run(
    s,
    { type: "add_stroke", id: mid, stroke: { points: [[0.5, 0.5]], radius: 0.08, hardness: 1, flow: 1 } },
    { type: "set_param", id, param: "exposure", value: 2 },
  );
  return run(s, ...GEOMETRY);
}

function build(): Record<string, State> {
  return {
    warp_layer_exposure: finishLayer("exposure", "selection"),
    warp_mask_brush: finishLayer("fill", "brush"),
    warp_mask_smart: finishLayer("fill", "smart"),
    warp_mask_depth: finishLayer("fill", "depth"),
    warp_develop_brush: developBrush(),
  };
}

const feedOf = (s: { wires: Wire[] }, id: string) => s.wires.find((w) => w.to === id && w.toPort === "in")?.from;

describe("masks read the frame after the lens and the warps", () => {
  it("every mask built before the geometry reads the last of it", () => {
    // Read in the outside shape (artMaskView): a Finish mask lives in
    // the Finish group, its feed on the group's boundary.
    for (const [name, sunk] of Object.entries(build())) {
      const s = artMaskView(sunk);
      const masks = s.nodes.filter((n) => n.type.endsWith("_mask"));
      expect(masks.length, name).toBeGreaterThan(0);
      for (const m of masks) expect(feedOf(s, m.id), `${name}: ${m.id}`).toBe("shapewarp");
      // The picture runs crop, lens, grid, shape.
      expect(feedOf(s, "lens"), name).toBe("crop");
      expect(feedOf(s, "gridwarp"), name).toBe("lens");
      expect(feedOf(s, "shapewarp"), name).toBe("gridwarp");
    }
  });

  it("a mask made after the geometry reads the last of it from birth", () => {
    let s = run(fresh(), ...GEOMETRY, { type: "art_add_layer", kind: "fill" } as Command);
    expect(frameFeed(s.nodes, s.wires)).toBe("shapewarp");
    s = run(s, { type: "art_add_mask", id: s.artActive!, kind: "brush" });
    expect(feedOf(artMaskView(s), `art_m_${s.artActive}`)).toBe("shapewarp");
    const dev = run(fresh(), ...GEOMETRY, { type: "add_layer", maskType: "selection" });
    expect(feedOf(dev, dev.activeLayer!.replace("_adj", "_mask"))).toBe("shapewarp");
  });

  it("each piece of geometry moves the masks on as it arrives, and undo puts them back", () => {
    let s = run(fresh(), { type: "add_layer", maskType: "brush" });
    const mid = s.activeLayer!.replace("_adj", "_mask");
    const order = ["crop", "lens", "gridwarp", "shapewarp"];
    const steps: Command[][] = [
      [{ type: "set_params", id: "crop", values: CROP }],
      [{ type: "set_category", title: "Lens", on: true }],
      [{ type: "set_category", title: "Grid Warp", on: true }],
      [{ type: "set_category", title: "Shape Warp", on: true }],
    ];
    const seen: string[] = [feedOf(s, mid)!];
    for (const step of steps) {
      s = run(s, ...step);
      seen.push(feedOf(s, mid)!);
    }
    expect(seen).toEqual(["src", ...order]);
    // The Shape Warp's build undone: the mask is back on the grid.
    expect(feedOf(run(s, { type: "undo" }), mid)).toBe("gridwarp");
  });

  it("a mask gating the lens correction reads the crop, not the frame after it", () => {
    const nodes = [
      { id: "src", type: "heeler.image_source" },
      { id: "crop", type: "heeler.crop_rotate" },
      { id: "lens", type: "heeler.lens_correct" },
      { id: "gridwarp", type: "heeler.grid_warp" },
      { id: "late", type: "heeler.exposure" },
      { id: "output", type: "heeler.output" },
      { id: "m_lens", type: "heeler.brush_mask" },
      { id: "m_late", type: "heeler.brush_mask" },
      { id: "m_loose", type: "heeler.selection_mask" },
    ] as NodeCard[];
    const wires: Wire[] = [
      { from: "src", to: "crop", toPort: "in", kind: "image" },
      { from: "crop", to: "lens", toPort: "in", kind: "image" },
      { from: "lens", to: "gridwarp", toPort: "in", kind: "image" },
      { from: "gridwarp", to: "late", toPort: "in", kind: "image" },
      { from: "late", to: "output", toPort: "in", kind: "image" },
      { from: "src", to: "m_lens", toPort: "in", kind: "image" },
      { from: "m_lens", to: "lens", toPort: "mask", kind: "mask" },
      { from: "crop", to: "m_late", toPort: "in", kind: "image" },
      { from: "m_late", to: "late", toPort: "mask", kind: "mask" },
      { from: "src", to: "m_loose", toPort: "in", kind: "image" },
    ];
    const out = masksReadTheFrame(nodes, wires);
    const feed = (id: string) => feedOf({ wires: out }, id);
    expect(feed("m_lens")).toBe("crop");
    expect(feed("m_late")).toBe("gridwarp");
    expect(feed("m_loose")).toBe("gridwarp");
    // The picture itself never moves, and a second read moves nothing.
    expect(feed("lens")).toBe("crop");
    expect(masksReadTheFrame(nodes, out)).toBe(out);
  });

  // A Smart click is carried back to the photograph through the frame's
  // geometry (pickgeometry.ts); the lens correction is part of it now,
  // as it is of the raster's trip to the mask (lib.rs
  // lens_geometry_buf). The expectation is ops_lens.rs's own sample
  // for green, worked by hand.
  it("a click walks back through the lens distortion the op applies", () => {
    const graph = {
      nodes: [
        { id: "src", type: "heeler.image_source", enabled: true, params: {} },
        { id: "lens", type: "heeler.lens_correct", enabled: true, params: { distortion: 40, vignette: 80, ca_red: 50 } },
        { id: "output", type: "heeler.output", enabled: true, params: {} },
      ],
      connections: [
        { from: ["src", "out"], to: ["lens", "in"] },
        { from: ["lens", "out"], to: ["output", "in"] },
      ],
    };
    const [w, h] = [600, 400];
    const at = sourcePoint(graph, [w, h], [0.9, 0.3])!;
    const dx = 0.4 * w, dy = -0.2 * h;
    const r = Math.hypot(dx, dy) / Math.hypot((w - 1) / 2, (h - 1) / 2);
    const s = 1 + 0.04 * r * r;
    expect(at[0]).toBeCloseTo(0.5 + 0.4 * s, 9);
    expect(at[1]).toBeCloseTo(0.5 - 0.2 * s, 9);
    // And the marker comes back where the click was made.
    const back = framePoint(graph, [w, h], at)!;
    expect(back[0]).toBeCloseTo(0.9, 6);
    expect(back[1]).toBeCloseTo(0.3, 6);
  });

  it("serialized graphs match the desktop pixel fixture", () => {
    const fixtures = Object.fromEntries(Object.entries(build()).map(([name, s]) => [name, serializeGraph(s)]));
    if (process.env.GEN_FIXTURE) {
      writeFileSync(resolve(process.cwd(), "src/__tests__/fixtures/mask-after-warp.json"), JSON.stringify(fixtures, null, 1) + "\n");
    }
    expect(fixtures).toEqual(expected);
  });
});
