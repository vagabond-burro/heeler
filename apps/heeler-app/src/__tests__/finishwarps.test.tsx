// The Finish tab's warps (2026-09-30: "build both, A for image layers and
// B for the photo"). A: an image layer's own Grid and Shape Warp, in the
// picture's space, before the blend places it. B: a Warp layer that bends
// everything below it, its mask the part that moves. One engine node for
// both (heeler.layer_warp), edited by the Develop warps' own gizmos and
// sections aimed at it.
//
// What is held here: the graphs both build; the gizmos and sections
// landing on the right warp and never on the photograph's; one undo step
// per drag and Escape; a crop keeping a Warp layer on the scene while an
// image layer's warp stays on its picture; Duplicate, save and reload,
// Paste Edits and takes; the handles drawn through the layer's
// placement; the tier gate. The desktop's pixel tests
// (src-tauri/src/finish_warps.rs) render the serialized graphs below at
// Fit, 1:1 and export. After a deliberate change to what the reducer
// builds, regenerate:
//   GEN_FIXTURE=1 npx vitest run finishwarps
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { act, fireEvent, render, screen } from "@testing-library/react";
import React, { useCallback, useState } from "react";
import { beforeEach, describe, expect, it } from "vitest";
import expected from "./fixtures/finish-warps.json";
import { initialState, NEUTRAL_NODES, NEUTRAL_WIRES } from "../data";
import {
  ART_ADJUSTMENTS,
  LAYER_WARP,
  artLayers,
  artWarpNode,
  artWarpOwner,
  imageLayerWarp,
  isPictureWarp,
  layerQuad,
  reduce,
  warpNodeFor,
  type Command,
  type NodeCard,
  type State
} from "../state";
import { loadGraph, saveGraph, serializeGraph } from "../bridge";
import { noteFrameAspect } from "../imagelayers";
import { shapesFromNode } from "../shapewarp";
import { pictureSpace, roomPx, unpaddedLen } from "../warpspace";
import { GridWarpOverlay, type WarpPair } from "../ui/gridwarp";
import { ShapeWarpOverlay } from "../ui/shapewarp";
import { FinishWarpControls } from "../ui/finishwarp";
import { NodeParams } from "../ui/graph";
import { previewSourceBox } from "../ui/transformpreview";
import { legacySelectionMask } from "./legacymask";


const run = (s: State, ...cmds: Command[]): State => cmds.reduce(reduce, s);

function fresh(id = "finish_warps"): State {
  noteFrameAspect(id, 1.5);
  return {
    ...initialState(),
    activeImage: id,
    mode: "simple",
    panelTab: "layers",
    nodes: structuredClone(NEUTRAL_NODES),
    wires: structuredClone(NEUTRAL_WIRES),
  };
}

/** A Warp layer enlarging a head-sized region, masked to it (the
 * owner's use case: "scale someone's head with a Shape Warp and mask
 * to the head so the background behind it stays as it was").*/
const HEAD = { cx: 0.5, cy: 0.45, radius: 0.12 };
function warpLayer(s: State = fresh()): { s: State; blend: string; warp: string } {
  let out = run(s, { type: "art_add_layer", kind: "warp" });
  const blend = out.artActive!;
  const warp = artLayers(out).find((l) => l.blend.id === blend)!.content.id;
  out = run(
    out,
    { type: "set_tool", tool: "shapewarp", target: warp },
    { type: "shape_warp_add" },
    { type: "shape_warp_set", id: "shape_1", patch: { ...HEAD, feather: 0.5, scale: 1.5, scaleY: 1.5 } },
    { type: "set_tool", tool: "shapewarp", target: warp },
  );
  // An oval marquee round the head, 0.1 of the short side each way: the
  // layer shows only inside it. A live selection mask as the layer was
  // saved before 2026-09-30, opened as the pixel mask it is now (the
  // frozen selection renders as it rendered); Mask from selection's own
  // pixel masks on a Warp layer are maskfromselection.test.tsx's.
  out = legacySelectionMask(out, blend, [
    { kind: "marquee", op: "add", x0: HEAD.cx - 0.1 / 1.5, y0: HEAD.cy - 0.1, x1: HEAD.cx + 0.1 / 1.5, y1: HEAD.cy + 0.1, shape: "ellipse" } as never,
  ]);
  return { s: out, blend, warp };
}

/** A 2:1 picture placed in the 3:2 frame, 0.4 wide, with its own warp
 * enlarging the right end of it. */
const BOX = { x: 0.3, y: 0.35, w: 0.4, h: 0.3 };
function imageWarp(s: State = fresh(), path = "__IMAGE__"): { s: State; blend: string; warp: string } {
  let out = run(s, { type: "art_add_image_layer", source: { kind: "file", path }, name: "logo", box: BOX });
  const blend = out.artActive!;
  out = run(out, { type: "art_layer_warp", id: blend, on: true });
  const warp = imageLayerWarp(out, blend)!.id;
  out = run(
    out,
    { type: "shape_warp_add", target: warp },
    { type: "shape_warp_set", id: "shape_1", patch: { cx: 0.8, cy: 0.5, radius: 0.6, feather: 0.8, scale: 2, scaleY: 2 }, target: warp },
  );
  return { s: out, blend, warp };
}

/** A warp's Type set to Grid, so the grid's tool arms on it (a warp
 * applies one type at a time; its shapes stay on the node). */
const gridType = (s: State, warp: string): State => run(s, { type: "art_warp_kind", id: warp, kind: "grid" });

/** A Warp layer that bends a head with its shapes and also has a grid
 * pulled, then its Type set to Grid: the fixture for "only the chosen
 * type applies" (src-tauri/src/finish_warps.rs). */
function gridChosen(): State {
  const { s, warp } = warpLayer();
  return run(
    gridType(s, warp),
    { type: "grid_warp_mesh", mesh: { cols: 1, rows: 1, us: [0, 1], vs: [0, 1], d: [[0.03, 0], [0.03, 0], [0.03, 0.02], [0.03, 0.02]] }, target: warp },
  );
}

/** The same warp as one saved before the Type existed: no choice on the
 * node, so it applies its shapes. */
function bothUnchosen(): State {
  const s = gridChosen();
  const strip = (list: NodeCard[]): NodeCard[] =>
    list.map((n) => {
      if (n.type === LAYER_WARP) {
        const rest = { ...(n.textParams ?? {}) };
        delete rest.kind;
        return { ...n, textParams: rest };
      }
      return n.isGroup && n.groupNodes ? { ...n, groupNodes: strip(n.groupNodes) } : n;
    });
  return { ...s, nodes: strip(s.nodes) };
}

const MOVED: [number, number][] = [[0.1, 0.1], [0.5, 0.1], [0.5, 0.4], [0.1, 0.4]];
const DISTORTED: [number, number][] = [[0.3, 0.3], [0.75, 0.35], [0.7, 0.7], [0.25, 0.62]];
const CROP = { crop_x: 0.2, crop_y: 0.2, crop_w: 0.6, crop_h: 0.6 };

function build(): Record<string, State> {
  const b = warpLayer();
  const a = imageWarp();
  return {
    warp_layer: b.s,
    warp_layer_cropped: run(b.s, { type: "set_params", id: "crop", values: CROP }),
    image_warp: a.s,
    image_warp_moved: run(a.s, { type: "art_set_quad", id: a.blend, box: BOX, corners: MOVED }),
    image_warp_distorted: run(a.s, { type: "art_set_quad", id: a.blend, box: BOX, corners: DISTORTED }),
    warp_layer_grid_chosen: gridChosen(),
    warp_layer_both_unchosen: bothUnchosen(),
  };
}

type Graph = { nodes: { id: string; type: string; enabled: boolean; params: Record<string, unknown> }[]; connections: { from: [string, string]; to: [string, string] }[] };
const graph = (s: State) => serializeGraph(s) as unknown as Graph;

describe("B: a Warp layer", () => {
  it("is a layer of its own whose content reads everything below it", () => {
    const { s, blend, warp } = warpLayer();
    const layer = artLayers(s).find((l) => l.blend.id === blend)!;
    expect(layer.content.type).toBe(LAYER_WARP);
    expect(layer.content.textParams?.space).toBe("frame");
    expect(layer.fx).toHaveLength(0);
    expect(layer.blend.name).toBe("Warp 1");
    // Its own seat, not one more adjustment in the list.
    expect(ART_ADJUSTMENTS).not.toContain("warp");
    const g = graph(s);
    // The content reads what is below it, the blend lays it back over
    // the same, through the layer's mask.
    expect(g.connections).toContainEqual({ from: ["art_in", "out"], to: [warp, "in"] });
    expect(g.connections).toContainEqual({ from: [warp, "out"], to: [blend, "fg"] });
    expect(g.connections.some((c) => c.to[0] === blend && c.to[1] === "mask")).toBe(true);
    expect(artWarpOwner(s, warp)).toEqual({ carrier: blend, picture: false });
  });

  it("the gizmos armed on it write to it, never to the photograph's own warp", () => {
    const { s, warp } = warpLayer();
    expect(s.nodes.some((n) => n.type === "heeler.shape_warp" || n.type === "heeler.grid_warp")).toBe(false);
    expect(shapesFromNode(artWarpNode(s, warp))).toHaveLength(1);
    expect(shapesFromNode(artWarpNode(s, warp))[0]).toMatchObject({ scale: 1.5, cx: HEAD.cx });
    // Armed on the photograph's own warp again, the same commands build
    // and write the Develop node instead.
    const develop = run(s, { type: "set_tool", tool: "shapewarp", target: null }, { type: "shape_warp_add" });
    expect(develop.warpTarget).toBeNull();
    expect(shapesFromNode(warpNodeFor(develop, "shape", null))).toHaveLength(1);
    expect(shapesFromNode(artWarpNode(develop, warp))).toHaveLength(1);
  });

  it("arming the tool on another warp moves it there instead of putting it down", () => {
    const { s: layer, warp } = warpLayer();
    const s = gridType(layer, warp);
    const armed = run(s, { type: "set_tool", tool: "gridwarp", target: null });
    expect(armed.tool).toBe("gridwarp");
    expect(armed.warpTarget).toBeNull();
    const moved = run(armed, { type: "grid_warp_select", ids: [3] }, { type: "set_tool", tool: "gridwarp", target: warp });
    expect(moved.tool).toBe("gridwarp");
    expect(moved.warpTarget).toBe(warp);
    // The picks named the other warp's handles.
    expect(moved.gridWarp.selected).toEqual([]);
    // The same button again puts it down, and the target with it.
    const down = run(moved, { type: "set_tool", tool: "gridwarp", target: warp });
    expect(down.tool).toBe("none");
    expect(down.warpTarget).toBeNull();
  });

  it("a crop keeps its shapes and its grid on the scene", () => {
    const { s, warp } = warpLayer();
    const bent = run(
      gridType(s, warp),
      { type: "set_tool", tool: "gridwarp", target: warp },
      { type: "grid_warp_density", cols: 2, rows: 2 },
      { type: "grid_warp_mesh", mesh: { cols: 2, rows: 2, us: [0, 0.5, 1], vs: [0, 0.5, 1], d: Array.from({ length: 9 }, (_, k) => (k === 4 ? [0.02, 0] : [0, 0])) as [number, number][] } },
    );
    const cropped = run(bent, { type: "set_params", id: "crop", values: CROP });
    const shape = shapesFromNode(artWarpNode(cropped, warp))[0];
    // The head's place on the new frame: (0.5 - 0.2) / 0.6.
    expect(shape.cx).toBeCloseTo((HEAD.cx - 0.2) / 0.6, 9);
    expect(shape.cy).toBeCloseTo((HEAD.cy - 0.2) / 0.6, 9);
    expect(shape.radius).toBeCloseTo(HEAD.radius / 0.6, 9);
    // The grid rides a lattice, the Develop warp's rule.
    expect(artWarpNode(cropped, warp)!.textParams?.lattice).not.toBe("");
    // And undoing the crop puts them back.
    const undone = run(cropped, { type: "undo" });
    expect(shapesFromNode(artWarpNode(undone, warp))[0].cx).toBeCloseTo(HEAD.cx, 12);
  });

  it("clipped to another layer it stays a warp, limited to that layer's outline", () => {
    const { s: withFill } = warpLayer(run(fresh(), { type: "art_add_layer", kind: "fill" }));
    const top = artLayers(withFill)[1].blend.id;
    const clipped = run(withFill, { type: "art_clip_layer", id: top, clip: true });
    expect(artLayers(clipped)[1].blend.params.clip).toBe(1);
    expect(graph(clipped).connections.some((c) => c.to[0] === top && c.to[1] === "clip")).toBe(true);
  });

  it("seats no lines' color or thickness in its panel, and one Edges choice", () => {
    // The thickness is a Preference and the color is seated in the
    // Develop warp sections, one setting for every overlay
    // (2026-09-30: "too much stack and redundant controls").
    const { s, warp } = warpLayer();
    for (const armed of [run(s, { type: "set_tool", tool: "shapewarp", target: warp }), run(gridType(s, warp), { type: "set_tool", tool: "gridwarp", target: warp })]) {
      const view = render(<FinishWarpControls state={armed} dispatch={() => {}} target={warp} />);
      for (const gone of ["gridwarp-lines", "gridwarp-line-width-row", "shapewarp-lines", "shapewarp-line-width-row"]) {
        expect(screen.queryByTestId(gone)).toBeNull();
      }
      // One node, one Edges choice, under whichever type shows.
      expect(document.querySelectorAll('[data-testid$="-edges-clamp"]')).toHaveLength(1);
      view.unmount();
    }
  });

  it("its tool goes down when another layer becomes the one being worked", () => {
    const { s: withFill } = warpLayer(run(fresh(), { type: "art_add_layer", kind: "fill" }));
    const [fill, warpBlend] = artLayers(withFill).map((l) => l.blend.id);
    const warp = artLayers(withFill)[1].content.id;
    const armed = run(withFill, { type: "select_art_layer", id: warpBlend }, { type: "set_tool", tool: "shapewarp", target: warp });
    expect(armed.tool).toBe("shapewarp");
    const other = run(armed, { type: "select_art_layer", id: fill });
    expect(other.tool).toBe("none");
    expect(other.warpTarget).toBeNull();
  });

  it("shows nothing until edited, then the Develop warps' own section for its type, aimed here", () => {
    const { s, warp } = warpLayer();
    const closed = render(<FinishWarpControls state={run(s, { type: "set_tool", tool: "none" })} dispatch={() => {}} target={warp} />);
    expect(closed.container.innerHTML).toBe("");
    closed.unmount();
    render(<FinishWarpControls state={run(s, { type: "set_tool", tool: "shapewarp", target: warp })} dispatch={() => {}} target={warp} />);
    expect(screen.getByTestId(`finish-warp-${warp}`)).toHaveAttribute("data-space", "frame");
    expect(screen.getAllByTestId("shapewarp-row")).toHaveLength(1);
    expect(screen.queryByTestId("gridwarp-controls")).toBeNull();
  });
});

describe("A: an image layer's own warp", () => {
  it("rides the layer's chain first, in the picture's space, and the blend knows its room", () => {
    const { s, blend, warp } = imageWarp();
    const layer = artLayers(s).find((l) => l.blend.id === blend)!;
    expect(layer.content.type).toBe("heeler.file");
    expect(layer.fx.map((f) => f.id)).toEqual([warp]);
    expect(isPictureWarp(layer.fx[0])).toBe(true);
    expect(layer.fx[0].textParams?.edges).toBe("transparent");
    expect(artWarpOwner(s, warp)).toEqual({ carrier: blend, picture: true });
    const g = graph(s);
    expect(g.connections).toContainEqual({ from: [layer.content.id, "out"], to: [warp, "in"] });
    expect(g.connections).toContainEqual({ from: [warp, "out"], to: [blend, "fg"] });
    expect(g.nodes.find((n) => n.id === blend)!.params.place_pad).toBe(25);
    // Switched off, the picture passes through bare and meets no room.
    const off = run(s, { type: "art_fx_enable", fxId: warp, enabled: false });
    expect(graph(off).nodes.find((n) => n.id === blend)!.params.place_pad).toBeUndefined();
    // A layer clipped to it clips to the warped picture where it shows.
    const clipped = run(s, { type: "art_add_layer", kind: "fill" });
    const fill = clipped.artActive!;
    const nums = String(graph(run(clipped, { type: "art_clip_layer", id: fill, clip: true })).nodes.find((n) => n.id === fill)!.params.clip_place).split(";")[1].split(",").map(Number);
    expect(nums).toHaveLength(14);
    expect(nums[12]).toBe(1.5);
    expect(nums[13]).toBe(25);
  });

  it("only a placed picture takes one, once, and removing it restores the bare picture", () => {
    const paint = run(fresh(), { type: "art_add_layer", kind: "paint" });
    expect(run(paint, { type: "art_layer_warp", id: paint.artActive!, on: true })).toBe(paint);
    const { s, blend } = imageWarp();
    expect(run(s, { type: "art_layer_warp", id: blend, on: true })).toBe(s);
    const bare = run(s, { type: "art_layer_warp", id: blend, on: false });
    expect(imageLayerWarp(bare, blend)).toBeUndefined();
    expect(graph(bare).nodes.some((n) => n.type === LAYER_WARP)).toBe(false);
    // One undo step each way.
    expect(imageLayerWarp(run(bare, { type: "undo" }), blend)).toBeDefined();
  });

  it("moves with the layer: a transform changes the corners, never the warp", () => {
    const { s, blend, warp } = imageWarp();
    const before = artWarpNode(s, warp)!.textParams;
    const moved = run(s, { type: "art_set_quad", id: blend, box: BOX, corners: DISTORTED });
    expect(artWarpNode(moved, warp)!.textParams).toEqual(before);
    // A crop leaves it on its picture too.
    const cropped = run(s, { type: "set_params", id: "crop", values: CROP });
    expect(artWarpNode(cropped, warp)!.textParams).toEqual(before);
  });

  it("an effect never moves ahead of it", () => {
    const { s, blend, warp } = imageWarp();
    const shadowed = run(s, { type: "art_add_fx", id: blend, fx: "shadow" });
    const fx = artLayers(shadowed).find((l) => l.blend.id === blend)!.fx;
    expect(fx.map((f) => f.id)[0]).toBe(warp);
    const tried = run(shadowed, { type: "art_fx_move", id: blend, fxId: fx[1].id, delta: -1 });
    expect(artLayers(tried).find((l) => l.blend.id === blend)!.fx[0].id).toBe(warp);
  });

  it("survives Duplicate, save and reload, Paste Edits and takes", async () => {
    const { s, blend, warp } = imageWarp(fresh(), "/pictures/logo.png");
    const shapes = artWarpNode(s, warp)!.textParams!.shapes;
    // Duplicate: the copy carries its own warp, the same shapes.
    const dup = run(s, { type: "art_duplicate_layer", id: blend });
    const copy = dup.artActive!;
    const copyWarp = imageLayerWarp(dup, copy)!;
    expect(copyWarp.id).not.toBe(warp);
    expect(copyWarp.textParams!.shapes).toBe(shapes);
    expect(graph(dup).nodes.find((n) => n.id === copy)!.params.place_pad).toBe(25);
    // Save and reload.
    await saveGraph("finishwarps-roundtrip", { nodes: s.nodes, wires: s.wires });
    const saved = await loadGraph("finishwarps-roundtrip");
    const reloaded = { ...s, nodes: saved!.nodes as State["nodes"], wires: saved!.wires as State["wires"] };
    expect(imageLayerWarp(reloaded, blend)?.textParams?.shapes).toBe(shapes);
    expect(serializeGraph(reloaded)).toEqual(serializeGraph(s));
    // Paste Edits onto another photograph.
    const copied = run(s, { type: "copy_edits" });
    const other = run(copied, { type: "select_image", id: "4866" });
    noteFrameAspect(other.activeImage, 1.5);
    const pasted = run(other, { type: "paste_edits" });
    expect(imageLayerWarp(pasted, blend)?.textParams?.shapes).toBe(shapes);
    // A take keeps it.
    const take = run(s, { type: "new_take" });
    const takes = take.takes[s.activeImage];
    const kept = takes[takes.length - 1].nodes as NodeCard[];
    expect(imageLayerWarp({ ...s, nodes: kept }, blend)?.textParams?.shapes).toBe(shapes);
  });

  it("Escape puts a Finish warp back the way it was armed", () => {
    const { s, warp } = imageWarp();
    const armed = run(s, { type: "set_tool", tool: "shapewarp", target: warp });
    const dragged = run(armed, { type: "shape_warp_set", id: "shape_1", patch: { dx: 0.3 } });
    expect(shapesFromNode(artWarpNode(dragged, warp))[0].dx).toBeCloseTo(0.3, 9);
    const canceled = run(dragged, { type: "cancel_tool" });
    expect(canceled.tool).toBe("none");
    expect(canceled.warpTarget).toBeNull();
    expect(artWarpNode(canceled, warp)!.textParams).toEqual(artWarpNode(s, warp)!.textParams);
  });

  it("the drag preview places the picture inside its room", () => {
    const { s, blend } = imageWarp();
    // A 200 by 100 picture padded by a quarter: 300 by 150.
    const box = previewSourceBox(s, blend, 300, 150);
    expect(box).toEqual({ x: 50 / 300, y: 25 / 150, w: 200 / 300, h: 100 / 150 });
    expect(unpaddedLen(300, 25)).toBe(200);
    expect(roomPx(101, 25)).toBe(25);
  });
});

// The gizmos on the canvas ----------------------------------------------

let latest: State;
let commands: Command[] = [];
function Harness({ start, overlay }: { start: State; overlay: "grid" | "shape" }) {
  const [state, setState] = useState(start);
  latest = state;
  const live = React.useRef<WarpPair | null>(null);
  const send = useCallback((c: Command) => {
    commands.push(c);
    setState((s) => {
      const next = reduce(s, c);
      latest = next;
      return next;
    });
  }, []);
  return overlay === "grid" ? (
    <GridWarpOverlay state={state} dispatch={send} frame={{ w: 400, h: 300 }} live={live} />
  ) : (
    <ShapeWarpOverlay state={state} dispatch={send} frame={{ w: 400, h: 300 }} live={live} />
  );
}
function stubBox(el: HTMLElement, w = 400, h = 300) {
  el.getBoundingClientRect = () => ({ left: 0, top: 0, right: w, bottom: h, width: w, height: h, x: 0, y: 0, toJSON() {} }) as DOMRect;
  Object.defineProperty(el, "offsetWidth", { configurable: true, value: w });
  Object.defineProperty(el, "offsetHeight", { configurable: true, value: h });
}
beforeEach(() => {
  commands = [];
});

describe("the gizmos on a Finish warp", () => {
  it("draw an image layer's grid on the picture where the layer is placed", () => {
    const { s, blend, warp } = imageWarp();
    const moved = run(gridType(s, warp), { type: "art_set_quad", id: blend, box: BOX, corners: DISTORTED }, { type: "set_tool", tool: "gridwarp", target: warp });
    render(<Harness start={moved} overlay="grid" />);
    const vertices = screen.getAllByTestId("gridwarp-vertex");
    const quad = layerQuad(moved, blend);
    // Corner handles sit on the layer's four corners (TL, TR, BL, BR in
    // the grid's row-major order).
    const cols = 4;
    const rows = 3;
    const pick = (k: number) => vertices.find((v) => v.getAttribute("data-index") === String(k))!;
    const corner = (k: number, q: [number, number]) => {
      expect(parseFloat(pick(k).style.left)).toBeCloseTo(q[0] * 100, 6);
      expect(parseFloat(pick(k).style.top)).toBeCloseTo(q[1] * 100, 6);
    };
    corner(0, quad[0]);
    corner(cols, quad[1]);
    corner(rows * (cols + 1), quad[3]);
    corner(rows * (cols + 1) + cols, quad[2]);
  });

  it("a drag inside an image layer's shape moves the picture in the picture's units, one undo step", () => {
    const { s, blend, warp } = imageWarp();
    const moved = run(
      s,
      { type: "art_set_quad", id: blend, box: BOX, corners: MOVED },
      { type: "set_tool", tool: "shapewarp", target: warp },
      { type: "shape_warp_select", id: "shape_1" },
      { type: "shape_warp_mode", mode: "warp" },
    );
    render(<Harness start={moved} overlay="shape" />);
    const overlay = screen.getByTestId("shapewarp-overlay");
    stubBox(overlay);
    // The shape's center on the picture, (0.8, 0.5), is (0.42, 0.25) of
    // the frame on the moved corners: (168, 75) on the 400 by 300 stage.
    const space = pictureSpace(BOX, MOVED, 1.5)!;
    const [fx, fy] = space.toFrame([0.8, 0.5]);
    expect(fx).toBeCloseTo(0.42, 9);
    expect(fy).toBeCloseTo(0.25, 9);
    const before = latest.undoStack.length;
    fireEvent.mouseDown(overlay, { button: 0, clientX: fx * 400, clientY: fy * 300 });
    expect(latest.gesture).toBe("shapewarp.shape");
    fireEvent.mouseMove(document, { clientX: fx * 400 + 40, clientY: fy * 300, buttons: 1 });
    fireEvent.mouseMove(document, { clientX: fx * 400 + 80, clientY: fy * 300, buttons: 1 });
    act(() => {
      fireEvent.mouseUp(document);
    });
    // 80 stage pixels is 0.2 of the frame, half the picture's 0.4 width.
    const shape = shapesFromNode(artWarpNode(latest, warp))[0];
    expect(shape.dx).toBeCloseTo(0.5, 6);
    expect(shape.dy).toBeCloseTo(0, 6);
    expect(latest.undoStack.length).toBe(before + 1);
    // The photograph's own warp was never built.
    expect(latest.nodes.some((n) => n.type === "heeler.shape_warp")).toBe(false);
    const undone = run(latest, { type: "undo" });
    expect(shapesFromNode(artWarpNode(undone, warp))[0].dx).toBe(0);
  });

  it("a drag on a Warp layer's shape is one undo step", () => {
    const { s, warp } = warpLayer();
    const armed = run(s, { type: "set_tool", tool: "shapewarp", target: warp }, { type: "shape_warp_select", id: "shape_1" }, { type: "shape_warp_mode", mode: "warp" });
    render(<Harness start={armed} overlay="shape" />);
    const overlay = screen.getByTestId("shapewarp-overlay");
    stubBox(overlay);
    const before = latest.undoStack.length;
    fireEvent.mouseDown(overlay, { button: 0, clientX: HEAD.cx * 400, clientY: HEAD.cy * 300 });
    fireEvent.mouseMove(document, { clientX: HEAD.cx * 400 + 20, clientY: HEAD.cy * 300, buttons: 1 });
    fireEvent.mouseMove(document, { clientX: HEAD.cx * 400 + 40, clientY: HEAD.cy * 300, buttons: 1 });
    act(() => {
      fireEvent.mouseUp(document);
    });
    expect(shapesFromNode(artWarpNode(latest, warp))[0].dx).toBeCloseTo(0.1, 6);
    expect(latest.undoStack.length).toBe(before + 1);
  });
});

describe("in the graph", () => {
  it("each Finish warp node wears its layer's controls in the inspector", () => {
    const { s: b, warp: bw } = warpLayer();
    const { s, warp: aw } = imageWarp(b);
    for (const [id, space] of [[bw, "frame"], [aw, "picture"]] as const) {
      // In edit mode, as the inspector's Edit Warp button puts it.
      const open = run(s, { type: "set_tool", tool: "shapewarp", target: id });
      const node = artWarpNode(open, id)!;
      const view = render(<NodeParams node={node} dispatch={() => {}} appState={open} allNodes={open.nodes} wires={open.wires} />);
      expect(screen.getByTestId(`finish-warp-edit-${id}`)).toHaveAttribute("aria-pressed", "true");
      expect(screen.getByTestId(`finish-warp-${id}`)).toHaveAttribute("data-space", space);
      expect(screen.getByTestId("shapewarp-controls")).toBeTruthy();
      // The image layer's own warp has its Room there too.
      expect(!!screen.queryByTestId(`finish-warp-room-${id}`)).toBe(space === "picture");
      view.unmount();
    }
  });

  it("a Warp node placed by hand in the graph is edited by the same gizmos", () => {
    const placed: NodeCard = {
      id: "handwarp",
      type: LAYER_WARP,
      name: "Warp",
      cat: "source",
      x: 0,
      y: 0,
      enabled: true,
      params: { cols: 4, rows: 3, room: 25 },
      textParams: { space: "frame", shapes: "[]", mesh: "[]" },
      hasIn: true,
      hasOut: true,
    };
    const s = { ...fresh(), nodes: [...fresh().nodes, placed] };
    const armed = run(s, { type: "set_tool", tool: "shapewarp", target: "handwarp" }, { type: "shape_warp_add" });
    expect(shapesFromNode(armed.nodes.find((n) => n.id === "handwarp"))).toHaveLength(1);
    const undone = run(armed, { type: "cancel_tool" });
    expect(shapesFromNode(undone.nodes.find((n) => n.id === "handwarp"))).toHaveLength(0);
  });
});

describe("the desktop's pixel fixture", () => {
  it("serialized graphs match", () => {
    const fixtures = Object.fromEntries(Object.entries(build()).map(([name, s]) => [name, serializeGraph(s)]));
    if (process.env.GEN_FIXTURE) {
      writeFileSync(resolve(process.cwd(), "src/__tests__/fixtures/finish-warps.json"), JSON.stringify(fixtures, null, 1) + "\n");
    }
    expect(fixtures).toEqual(expected);
  });
});
