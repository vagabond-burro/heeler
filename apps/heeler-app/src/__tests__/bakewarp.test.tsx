import { describe, it, expect, vi, beforeEach} from "vitest";
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { render, screen, act, fireEvent, waitFor } from "@testing-library/react";
import expected from "./fixtures/bake-warp.json";
import { initialState, NEUTRAL_NODES, NEUTRAL_WIRES } from "../data";
import { reduce, artLayers, artFindLayer, artMaskOf, artGroupMembers, bakeableWarp, unbakeableWarp, migrateGraph, pasteGraphKeepingWarp, LAYER_WARP, type State, type Command, type NodeCard } from "../state";
import { serializeGraph, bakeWarpLayer, loadGraph, saveGraph } from "../bridge";
import { BAKE_WARP_HINT, UNBAKE_WARP_HINT, layerActionHint, layerActions, runBakeWarp, type LayerActionItem } from "../layeractions";
import { ImageLayerControls } from "../ui/imagelayers";
import { NodeParams } from "../ui/graph";
import { frameRemap, cropGeomOf, applyAffine } from "../framemap";
import { noteFrameAspect } from "../imagelayers";
import { App } from "../app";
import { FinishWarpControls } from "../ui/finishwarp";
import { legacySelectionMask } from "./legacymask";

// Bake Warp (2026-09-30: "I was also thinking too we could have a bake option
// on the warp layer that bakes warping effect down to a pixel layer. I think
// both the [layer editor] way and a way to commit/bake a warp could be
// useful"). The desktop renders what the Warp layer shows (bake_warp_layer)
// and the reducer puts an image layer reading it in the Warp layer's own seat
// (art_bake_warp), one undo step.
//
// These build Warp layers through the reducer, masked and not, on an
// uncropped, a cropped and a turned photograph, bake them with a stand-in
// file on the whole frame, crop again, and pin the serialized graphs; the
// desktop's pixel test (src-tauri/src/warp_bake.rs) makes the file the
// placeholder stands for, places it where the bake answers, and checks
// the picture is unchanged at export, Fit and 1:1 and stays on the scene
// through the second crop. After a deliberate change to what the reducer
// builds, regenerate:
//   GEN_FIXTURE=1 npx vitest run bakewarp

const BAKE = "__BAKE__";
const WHOLE = { x: 0, y: 0, w: 1, h: 1 };
const ASPECT = 1.5;
const IMAGE = "bake_warp";

vi.mock("../bridge", async (importOriginal) => {
  const real = await importOriginal<typeof import("../bridge")>();
  return {
    ...real,
    bakeWarpLayer: vi.fn(async () => ({ path: "/kept/layercopies/00000000000000bb.tif", box: [0.3, 0.2, 0.4, 0.5], aspect: 1.5, width: 240, height: 200 })),
  };
});

beforeEach(() => {
  vi.mocked(bakeWarpLayer).mockClear();
});

const run = (s: State, ...cmds: Command[]): State => cmds.reduce(reduce, s);

function fresh(): State {
  noteFrameAspect(IMAGE, ASPECT);
  return {
    ...initialState(),
    activeImage: IMAGE,
    mode: "simple",
    panelTab: "layers",
    nodes: structuredClone(NEUTRAL_NODES),
    wires: structuredClone(NEUTRAL_WIRES),
  };
}

const CROPS: Record<string, Record<string, number>> = {
  uncropped: { angle: 0, crop_x: 0, crop_y: 0, crop_w: 1, crop_h: 1 },
  cropped: { angle: 0, crop_x: 0.2, crop_y: 0.2, crop_w: 0.6, crop_h: 0.6 },
  turned: { angle: 8, crop_x: 0.15, crop_y: 0.15, crop_w: 0.7, crop_h: 0.7 },
};
/** The crop made after the bake: each frame to the next. */
const RECROP: Record<string, string> = { uncropped: "cropped", cropped: "turned", turned: "uncropped" };

/** A Warp layer enlarging a head-sized region, finishwarps.test.tsx's,
 * masked round the head or not. */
const HEAD = { cx: 0.5, cy: 0.45, radius: 0.12 };
const ENLARGED = { ...HEAD, feather: 0.5, scale: 1.5, scaleY: 1.5 };
/** The same head dragged as Warp mode drags it (unbakehandles.test.tsx's
 * ellipse): moved up and right as well as enlarged, its feather
 * narrower, so the move carries the head over the background ahead of
 * it (the field folds there) and stretches what it leaves behind. */
const DRAGGED = { ...HEAD, feather: 0.3, dx: 0.04, dy: -0.02, scale: 1.45, scaleY: 1.3 };
function warpLayer(s: State, masked: boolean, shape: Record<string, number> = ENLARGED): { s: State; blend: string; warp: string } {
  let out = run(s, { type: "art_add_layer", kind: "warp" });
  const blend = out.artActive!;
  const warp = artLayers(out).find((l) => l.blend.id === blend)!.content.id;
  out = run(
    out,
    { type: "set_tool", tool: "shapewarp", target: warp },
    { type: "shape_warp_add" },
    { type: "shape_warp_set", id: "shape_1", patch: shape },
    { type: "set_tool", tool: "shapewarp", target: warp },
  );
  if (masked) {
    out = legacySelectionMask(out, blend, [
      { kind: "marquee", op: "add", x0: HEAD.cx - 0.1 / 1.5, y0: HEAD.cy - 0.1, x1: HEAD.cx + 0.1 / 1.5, y1: HEAD.cy + 0.1, shape: "ellipse" } as never,
    ]);
  }
  return { s: out, blend, warp };
}

const cropped = (crop: string) => run(fresh(), { type: "set_params", id: "crop", values: CROPS[crop] } as Command);
const bake = (s: State, id: string, box = WHOLE): State => run(s, { type: "art_bake_warp", id, path: BAKE, box, aspect: ASPECT });
const unbake = (s: State, id: string): State => run(s, { type: "art_unbake_warp", id });

type Case = { before: State; after: State; recropBefore: State; recropAfter: State; carrier: string };

function build(): Record<string, Case> {
  const out: Record<string, Case> = {};
  for (const [kind, shape] of [["", ENLARGED], ["dragged_", DRAGGED]] as const) {
    for (const crop of Object.keys(CROPS)) {
      for (const masked of [true, false]) {
        const { s, blend } = warpLayer(cropped(crop), masked, shape);
        const before = s;
        const after = bake(before, blend);
        const recrop = { type: "set_params", id: "crop", values: CROPS[RECROP[crop]] } as Command;
        out[`${masked ? "masked" : "whole"}_${kind}${crop}`] = { before, after, recropBefore: run(before, recrop), recropAfter: run(after, recrop), carrier: blend };
      }
    }
  }
  // Its mode and opacity stay on the layer, not in the pixels: Multiply
  // at 60, over a Pixel layer painted below it.
  {
    let s = run(cropped("uncropped"), { type: "art_add_layer", kind: "paint" } as Command);
    s = run(s, { type: "art_add_stroke", id: s.artActive!, stroke: { points: [[0.3, 0.6], [0.7, 0.4]], radius: 0.06, hardness: 0.5, flow: 1, color: "#3060ff" } } as Command);
    const w = warpLayer(s, true);
    const before = run(w.s, { type: "art_layer_set", id: w.blend, mode: "multiply", opacity: 60 });
    const after = bake(before, w.blend);
    out.styled_masked_uncropped = { before, after, recropBefore: before, recropAfter: after, carrier: w.blend };
  }
  return out;
}

describe("Bake Warp puts an image layer of what the Warp layer shows in its seat", () => {
  it("keeps the layer's seat, name, mode and opacity; the content is the kept picture, placed on the scene", () => {
    const c = build().styled_masked_uncropped;
    const was = artLayers(c.before);
    const now = artLayers(c.after);
    expect(now.map((l) => l.blend.id)).toEqual(was.map((l) => l.blend.id));
    const layer = now.find((l) => l.blend.id === c.carrier)!;
    const before = was.find((l) => l.blend.id === c.carrier)!;
    expect(layer.content.type).toBe("heeler.file");
    expect(layer.content.id).toBe(before.content.id);
    expect(layer.content.artKind).toBe("image");
    // What recovery bundles read for a file a layer needs (recovery.rs
    // graph_refs: a heeler.file's textParams.path), as Layer via Copy's.
    expect(layer.content.textParams).toMatchObject({ path: BAKE, layer: "", space: "display", origin: "bake" });
    expect(layer.fx).toEqual([]);
    expect(layer.blend.name).toBe(before.blend.name);
    expect(layer.blend.textParams).toMatchObject({ mode: "multiply", fit: "place", anchor: "scene" });
    expect(layer.blend.params).toMatchObject({
      opacity: 60,
      warp_bx: 0, warp_by: 0, warp_bw: 1, warp_bh: 1,
      warp_x0: 0, warp_y0: 0, warp_x1: 1, warp_y1: 0, warp_x2: 1, warp_y2: 1, warp_x3: 0, warp_y3: 1,
      warp_aspect: 1.5,
    });
    // The mask is in the pixels' alpha now: the layer has none.
    expect(artMaskOf(c.before, c.carrier)).toBeTruthy();
    expect(artMaskOf(c.after, c.carrier)).toBeUndefined();
    expect(c.after.nodes.some((n) => n.id === artMaskOf(c.before, c.carrier)!.id)).toBe(false);
    // Its warp is gone, and with it the warp's tool.
    expect(bakeableWarp(c.after, c.carrier)).toBeUndefined();
    expect(c.after.artActive).toBe(c.carrier);
  });

  it("lays the picture on the rectangle the desktop answers", () => {
    const { s, blend } = warpLayer(cropped("uncropped"), true);
    const after = bake(s, blend, { x: 0.3, y: 0.2, w: 0.4, h: 0.5 });
    expect(artFindLayer(after, blend)!.carrier.params).toMatchObject({ warp_bx: 0.3, warp_by: 0.2, warp_bw: 0.4, warp_bh: 0.5, warp_x2: 0.7, warp_y2: 0.7 });
  });

  it("keeps a layer's place in the middle of the stack, its clipping, and its group", () => {
    let s = run(cropped("uncropped"), { type: "art_add_layer", kind: "paint" } as Command);
    const w = warpLayer(s, true);
    s = run(w.s, { type: "art_add_layer", kind: "paint" } as Command, { type: "art_clip_layer", id: w.blend, clip: true } as Command);
    const order = artLayers(s).map((l) => l.blend.id);
    const after = bake(s, w.blend);
    expect(artLayers(after).map((l) => l.blend.id)).toEqual(order);
    expect(artFindLayer(after, w.blend)!.carrier.params.clip).toBe(1);
    const wire = (st: State) => serializeGraph(st).connections.find((c) => c.to[0] === w.blend && c.to[1] === "clip");
    expect(wire(after)).toEqual(wire(s));
    // Grouped: the member is baked inside its group.
    const g = run(w.s, { type: "art_group_layers", ids: [w.blend] } as Command);
    const group = artLayers(g).find((l) => l.content.isGroup)!;
    const member = artGroupMembers(group.content)[0];
    expect(bakeableWarp(g, member.merge.id)).toBeTruthy();
    const baked = bake(g, member.merge.id);
    const inner = artGroupMembers(artLayers(baked).find((l) => l.content.isGroup)!.content);
    expect(inner.map((m) => m.merge.id)).toEqual([member.merge.id]);
    expect(inner[0].content.type).toBe("heeler.file");
    expect(artFindLayer(baked, member.merge.id)!.groupId).toBe(group.content.id);
    expect(artMaskOf(baked, member.merge.id)).toBeUndefined();
  });

  it("bakes the layer's effects in and drops them", () => {
    const w = warpLayer(cropped("uncropped"), false);
    const s = run(w.s, { type: "art_add_fx", id: w.blend, fx: "glow" } as Command);
    expect(artLayers(s).find((l) => l.blend.id === w.blend)!.fx).toHaveLength(1);
    const after = bake(s, w.blend);
    expect(artLayers(after).find((l) => l.blend.id === w.blend)!.fx).toEqual([]);
    expect(serializeGraph(after).nodes.some((n) => n.type.startsWith("heeler.fx_"))).toBe(false);
  });

  it("is one undo step that brings the live Warp layer back exactly", () => {
    for (const [name, c] of Object.entries(build())) {
      const undone = run(c.after, { type: "undo" });
      expect(undone.nodes, name).toEqual(c.before.nodes);
      expect(undone.wires, name).toEqual(c.before.wires);
      expect(run(undone, { type: "redo" }).nodes, name).toEqual(c.after.nodes);
    }
  });

  it("puts the warp's tool down when the warp was being edited", () => {
    const w = warpLayer(cropped("uncropped"), false);
    const editing = run(w.s, { type: "set_tool", tool: "shapewarp", target: w.warp });
    expect(editing.tool).toBe("shapewarp");
    expect(editing.warpTarget).toBe(w.warp);
    const after = bake(editing, w.blend);
    expect(after.tool).toBe("none");
    expect(after.warpTarget).toBeNull();
  });

  it("refuses a layer that is not a Warp layer, and an image layer's own warp", () => {
    const s = run(cropped("uncropped"), { type: "art_add_layer", kind: "paint" } as Command);
    expect(bake(s, s.artActive!)).toBe(s);
    const img = run(s, { type: "art_add_image_layer", source: { kind: "file", path: "/x.png" }, name: "x", box: WHOLE } as Command);
    const warped = run(img, { type: "art_layer_warp", id: img.artActive!, on: true } as Command);
    expect(bakeableWarp(warped, img.artActive!)).toBeUndefined();
    expect(bake(warped, img.artActive!)).toBe(warped);
  });

  it("stays on the scene through a later crop, its corners carried by the crop's own map", () => {
    for (const [name, c] of Object.entries(build())) {
      if (name.startsWith("styled")) continue;
      const map = frameRemap(cropGeomOf(c.after.nodes), cropGeomOf(c.recropAfter.nodes), ASPECT)!;
      const was = artFindLayer(c.after, c.carrier)!.carrier.params;
      const now = artFindLayer(c.recropAfter, c.carrier)!.carrier.params;
      for (let i = 0; i < 4; i++) {
        const [x, y] = applyAffine(map.m, [was[`warp_x${i}`], was[`warp_y${i}`]]);
        expect(now[`warp_x${i}`], `${name} x${i}`).toBeCloseTo(x, 12);
        expect(now[`warp_y${i}`], `${name} y${i}`).toBeCloseTo(y, 12);
      }
    }
  });

  it("serialized graphs match the desktop pixel fixture", () => {
    const fixtures = Object.fromEntries(
      Object.entries(build()).map(([name, c]) => [
        name,
        {
          before: serializeGraph(c.before),
          // The picture under the Warp layer: the stack without it.
          below: serializeGraph(run(c.before, { type: "art_remove_layer", id: c.carrier })),
          after: serializeGraph(c.after),
          recrop_before: serializeGraph(c.recropBefore),
          recrop_below: serializeGraph(run(c.recropBefore, { type: "art_remove_layer", id: c.carrier })),
          recrop_after: serializeGraph(c.recropAfter),
          // Unbaked (2026-10-01): the live Warp layer back, before and
          // after the second crop; warp_bake.rs renders each against the
          // live layer it came from.
          unbaked: serializeGraph(unbake(c.after, c.carrier)),
          recrop_unbaked: serializeGraph(unbake(c.recropAfter, c.carrier)),
          carrier: c.carrier,
        },
      ]),
    );
    if (process.env.GEN_FIXTURE) writeFileSync(resolve(process.cwd(), "src/__tests__/fixtures/bake-warp.json"), JSON.stringify(fixtures, null, 1) + "\n");
    expect(fixtures).toEqual(expected);
  });
});

describe("its seats, its words and its gate", () => {
  it("the layer's menus offer it on a Warp layer and gray it elsewhere, saying why", () => {
    const w = warpLayer(cropped("uncropped"), true);
    const item = (s: State, id: string | null) => layerActions(s, id).find((a): a is LayerActionItem => a.kind === "item" && a.testid === "art-menu-bake-warp")!;
    expect(item(w.s, w.blend)).toMatchObject({ label: "Bake Warp", disabled: false, hint: BAKE_WARP_HINT });
    const paint = run(w.s, { type: "art_add_layer", kind: "paint" } as Command);
    expect(item(paint, paint.artActive!).disabled).toBe(true);
    expect(layerActionHint(item(paint, paint.artActive!))).toBe(`${BAKE_WARP_HINT} Works on a Warp layer. Select one first.`);
    expect(item(paint, null).disabled).toBe(true);
    // Every way the line can read fits the status row (menuhints.test).
    for (const a of [item(w.s, w.blend), item(paint, paint.artActive!), item(paint, null)]) {
      expect(layerActionHint(a)!.length).toBeLessThanOrEqual(165);
    }
  });

  it("says the outcome first and the cost after", () => {
    expect(BAKE_WARP_HINT).toMatch(/^Turn the warp into a picture layer to move and warp again\./);
    expect(BAKE_WARP_HINT).toMatch(/stops following Develop edits and layers below\.$/);
  });

  it("renders what the Warp layer shows, then replaces it in one step", async () => {
    const w = warpLayer(cropped("uncropped"), true);
    const seen: Command[] = [];
    runBakeWarp(w.s, (c) => void seen.push(c), w.blend);
    await waitFor(() => expect(seen.some((c) => c.type === "art_bake_warp")).toBe(true));
    expect(vi.mocked(bakeWarpLayer).mock.calls[0]).toEqual([w.s, w.blend]);
    expect(seen.find((c) => c.type === "art_bake_warp")).toEqual({
      type: "art_bake_warp",
      expected: { image: w.s.activeImage, take: w.s.activeTakes[w.s.activeImage], crop: cropGeomOf(w.s.nodes) },
      id: w.blend,
      path: "/kept/layercopies/00000000000000bb.tif",
      box: { x: 0.3, y: 0.2, w: 0.4, h: 0.5 },
      aspect: 1.5,
    });
  });

  it("the Warp layer's panel has the seat, an image layer's own warp does not", async () => {
    const w = warpLayer(cropped("uncropped"), false);
    const seen: Command[] = [];
    const view = render(<FinishWarpControls state={w.s} dispatch={(c) => void seen.push(c)} target={w.warp} open />);
    const button = screen.getByTestId(`finish-warp-bake-${w.warp}`);
    expect(button.getAttribute("data-hint")).toBe(BAKE_WARP_HINT);
    fireEvent.click(button);
    await waitFor(() => expect(seen.some((c) => c.type === "art_bake_warp")).toBe(true));
    view.unmount();
    const img = run(cropped("uncropped"), { type: "art_add_image_layer", source: { kind: "file", path: "/x.png" }, name: "x", box: WHOLE } as Command);
    const warped = run(img, { type: "art_layer_warp", id: img.artActive!, on: true } as Command);
    const own = artLayers(warped)[0].fx.find((f) => f.type === LAYER_WARP)!;
    render(<FinishWarpControls state={warped} dispatch={() => {}} target={own.id} open />);
    expect(screen.queryByTestId(`finish-warp-bake-${own.id}`)).toBeNull();
  });
});


// Unbake (2026-10-01: "go ahead with 1 and 2", 2 being "keep the warp's
// settings on the baked layer so it can be unbaked"). Bake Warp keeps
// the Warp layer's whole definition on the picture node it puts in the
// seat (bakedFrom), and Unbake puts the live Warp layer back from it,
// one undo step. The desktop half (the unbaked graph renders as the live
// Warp layer at export) is warp_bake.rs
// the_unbaked_layer_renders_as_the_live_warp_layer.

/** A layer's whole definition: its carrier, its content, its effects
 * and its mask node, and the group it sits in. */
function parts(s: State, id: string) {
  const found = artFindLayer(s, id)!;
  const fx = found.groupId
    ? artGroupMembers(artLayers(s).find((l) => l.content.id === found.groupId)!.content).find((m) => m.merge.id === id)!.fx
    : artLayers(s).find((l) => l.blend.id === id)!.fx;
  return { carrier: found.carrier, content: found.content, fx, mask: artMaskOf(s, id), groupId: found.groupId };
}

/** The serialized graph, its nodes and connections in a fixed order. */
function graphOf(s: State) {
  const g = serializeGraph(s);
  const key = (v: unknown) => JSON.stringify(v);
  return { ...g, nodes: [...g.nodes].sort((a, b) => a.id.localeCompare(b.id)), connections: [...g.connections].sort((a, b) => key(a).localeCompare(key(b))) };
}

describe("Unbake puts the live Warp layer back", () => {
  it("bake then unbake gives back the Warp layer's definition, deep-equal, and the same graph", () => {
    for (const [name, c] of Object.entries(build())) {
      const back = unbake(c.after, c.carrier);
      expect(parts(back, c.carrier), name).toEqual(parts(c.before, c.carrier));
      expect(back.nodes, name).toEqual(c.before.nodes);
      expect(graphOf(back), name).toEqual(graphOf(c.before));
      expect(unbakeableWarp(back, c.carrier), name).toBeUndefined();
      expect(bakeableWarp(back, c.carrier), name).toBeTruthy();
    }
  });

  it("keeps the definition on the baked layer, small and pixel-free: the mask's bake by its pointer", () => {
    const c = build().masked_uncropped;
    const kept = artFindLayer(c.after, c.carrier)!.content.bakedFrom!;
    expect(kept.content.type).toBe(LAYER_WARP);
    expect(kept.carrier.id).toBe(c.carrier);
    expect(kept.mask!.id).toBe(artMaskOf(c.before, c.carrier)!.id);
    expect(JSON.stringify(kept).length).toBeLessThan(20000);
    // A pixel mask whose base is a bake: the definition holds the
    // pointer recovery and the Storage clear read (recovery.rs
    // required_rasters), never a copy of the raster.
    const painted = run(c.before, { type: "set_text_param", id: kept.mask!.id, param: "matte_id", value: "baked:00000000000000c1" } as Command);
    const bakedPainted = artFindLayer(bake(painted, c.carrier), c.carrier)!.content.bakedFrom!;
    expect(bakedPainted.mask!.textParams?.matte_id).toBe("baked:00000000000000c1");
    expect(unbake(bake(painted, c.carrier), c.carrier).nodes).toEqual(painted.nodes);
  });

  it("is one undo step each way", () => {
    const c = build().masked_cropped;
    const back = unbake(c.after, c.carrier);
    expect(back.undoStack.length).toBe(c.after.undoStack.length + 1);
    const undone = run(back, { type: "undo" });
    expect(undone.nodes).toEqual(c.after.nodes);
    expect(undone.wires).toEqual(c.after.wires);
    expect(run(undone, { type: "redo" }).nodes).toEqual(back.nodes);
    // And the bake's own undo still reaches the Warp layer from before.
    expect(run(c.after, { type: "undo" }).nodes).toEqual(c.before.nodes);
  });

  it("survives saving and reloading the graph in between", async () => {
    for (const name of ["masked_turned", "whole_cropped", "styled_masked_uncropped"]) {
      const c = build()[name];
      const imageId = `unbake-reload-${name}`;
      await saveGraph(imageId, { nodes: c.after.nodes, wires: c.after.wires });
      const saved = (await loadGraph(imageId))!;
      const loaded = migrateGraph(saved.nodes as NodeCard[], saved.wires as State["wires"]);
      const reloaded = { ...c.after, nodes: loaded.nodes, wires: loaded.wires };
      expect(unbakeableWarp(reloaded, c.carrier), name).toBeTruthy();
      const back = unbake(reloaded, c.carrier);
      expect(parts(back, c.carrier), name).toEqual(parts(c.before, c.carrier));
      expect(graphOf(back), name).toEqual(graphOf(c.before));
    }
  });

  it("after a crop, unbakes onto the scene the baked layer stayed on, as the live layer would have moved", () => {
    for (const [name, c] of Object.entries(build())) {
      if (name.startsWith("styled")) continue;
      const back = unbake(c.recropAfter, c.carrier);
      expect(parts(back, c.carrier), name).toEqual(parts(c.recropBefore, c.carrier));
      expect(graphOf(back), name).toEqual(graphOf(c.recropBefore));
    }
  });

  it("a Warp layer baked inside a group unbakes back into the group, its mask on its own hop", () => {
    const w = warpLayer(cropped("uncropped"), true);
    const g = run(w.s, { type: "art_group_layers", ids: [w.blend] } as Command);
    const group = artLayers(g).find((l) => l.content.isGroup)!;
    const member = artGroupMembers(group.content)[0].merge.id;
    const baked = bake(g, member);
    expect(unbakeableWarp(baked, member)?.groupId).toBe(group.content.id);
    const back = unbake(baked, member);
    expect(parts(back, member)).toEqual(parts(g, member));
    expect(parts(back, member).groupId).toBe(group.content.id);
    expect(graphOf(back)).toEqual(graphOf(g));
  });

  it("brings the effects back, and the warp's tool is not left on the picture's own warp", () => {
    const w = warpLayer(cropped("uncropped"), false);
    const s = run(w.s, { type: "art_add_fx", id: w.blend, fx: "glow" } as Command);
    const baked = bake(s, w.blend);
    expect(parts(baked, w.blend).fx).toEqual([]);
    expect(parts(unbake(baked, w.blend), w.blend).fx).toEqual(parts(s, w.blend).fx);
    // The baked picture given its own warp, being edited: the tool goes
    // down with it.
    const warped = run(baked, { type: "art_layer_warp", id: w.blend, on: true } as Command);
    const own = parts(warped, w.blend).fx.find((f) => f.type === LAYER_WARP)!;
    const editing = run(warped, { type: "set_tool", tool: "gridwarp", target: own.id } as Command);
    const back = unbake(editing, w.blend);
    expect(back.tool).toBe("none");
    expect(back.warpTarget).toBeNull();
    // The picture's own warp goes with the picture; the glow comes back.
    expect(parts(back, w.blend).fx).toEqual(parts(s, w.blend).fx);
  });

  it("what the baked layer still offered keeps the newer word: name, mode, opacity, clipping", () => {
    let s = run(cropped("uncropped"), { type: "art_add_layer", kind: "paint" } as Command);
    const w = warpLayer(s, true);
    s = bake(w.s, w.blend);
    s = run(
      s,
      { type: "art_layer_set", id: w.blend, mode: "screen", opacity: 35, name: "Bigger head" } as Command,
      { type: "art_clip_layer", id: w.blend, clip: true } as Command,
    );
    const back = artFindLayer(unbake(s, w.blend), w.blend)!.carrier;
    expect(back.textParams?.mode).toBe("screen");
    expect(back.params.opacity).toBe(35);
    expect(back.params.clip).toBe(1);
    expect(back.name).toBe("Bigger head");
    // The rest is the Warp layer's own: its warp, and no placement.
    expect(artFindLayer(unbake(s, w.blend), w.blend)!.content).toEqual(artFindLayer(w.s, w.blend)!.content);
    expect(Object.keys(back.params).some((k) => k.startsWith("warp_"))).toBe(false);
  });

  it("travels with takes and Paste Edits, and a linked photograph's copy unbakes with it", () => {
    const c = build().masked_uncropped;
    // A new take is a copy of the graph: its baked layer unbakes too.
    const take = run(c.after, { type: "new_take" } as Command);
    expect(unbakeableWarp(take, c.carrier)).toBeTruthy();
    expect(parts(unbake(take, c.carrier), c.carrier)).toEqual(parts(c.before, c.carrier));
    // Copy and Paste Edits onto a photograph of the same shape.
    const clip = run(c.after, { type: "copy_edits" }).editClipboard!;
    const pasted = pasteGraphKeepingWarp(clip, { nodes: structuredClone(c.before.nodes), wires: structuredClone(c.before.wires) }, ASPECT);
    const onOther = { ...c.after, nodes: pasted.nodes, wires: pasted.wires };
    expect(parts(unbake(onOther, c.carrier), c.carrier)).toEqual(parts(c.before, c.carrier));
    // Linked: a member holding a baked layer of its own keeps the kept
    // definition through the link's mirrored edits, and unbakes when it
    // is the photograph on screen. Bake Warp's picture is the photograph
    // it was made from, so a bake lands on that photograph alone, and so
    // does its Unbake: the members are left as they are.
    // Both photographs in the catalog, the one on screen and the member.
    const listed = { ...c.after, images: [...c.after.images, { ...c.after.images[0], id: c.after.activeImage }, { ...c.after.images[0], id: "unbake_member" }] };
    const linkedState = run(
      listed,
      { type: "set_link_group", ids: [c.after.activeImage, "unbake_member"], group: "link_unbake" } as Command,
      { type: "stash_graphs", graphs: { unbake_member: { nodes: structuredClone(c.after.nodes), wires: structuredClone(c.after.wires) } } } as Command,
      { type: "set_param", id: "exposure", param: "exposure", value: 0.4 } as Command,
    );
    const memberOf = (st: State) => ({ ...st, nodes: st.graphs.unbake_member.nodes, wires: st.graphs.unbake_member.wires });
    expect(memberOf(linkedState).nodes.find((n) => n.id === "exposure")!.params.exposure).toBe(0.4);
    expect(unbakeableWarp(memberOf(linkedState), c.carrier)).toBeTruthy();
    const driverUnbaked = unbake(linkedState, c.carrier);
    expect(memberOf(driverUnbaked).nodes).toEqual(memberOf(linkedState).nodes);
    expect(parts(unbake(memberOf(linkedState), c.carrier), c.carrier)).toEqual(parts(c.before, c.carrier));
  });

  it("a bake and an unbake, and their undo and redo, leave a linked photograph's own Warp layer alone", () => {
    // Found building Unbake: mirrored, Bake Warp took a linked
    // photograph's Warp layer mask away while its warp stayed live.
    const c = build().masked_uncropped;
    const listed = { ...c.before, images: [...c.before.images, { ...c.before.images[0], id: c.before.activeImage }, { ...c.before.images[0], id: "bake_member" }] };
    const linked = run(
      listed,
      { type: "set_link_group", ids: [c.before.activeImage, "bake_member"], group: "link_bake" } as Command,
      { type: "stash_graphs", graphs: { bake_member: { nodes: structuredClone(c.before.nodes), wires: structuredClone(c.before.wires) } } } as Command,
    );
    const member = (st: State) => st.graphs.bake_member;
    const was = member(linked);
    let s = linked;
    for (const step of [
      { type: "art_bake_warp", id: c.carrier, path: BAKE, box: WHOLE, aspect: ASPECT },
      { type: "undo" },
      { type: "redo" },
      { type: "art_unbake_warp", id: c.carrier },
      { type: "undo" },
      { type: "redo" },
    ] as Command[]) {
      s = run(s, step);
      expect(member(s).nodes, step.type).toEqual(was.nodes);
      expect(member(s).wires, step.type).toEqual(was.wires);
      expect(s.linkDirty, step.type).not.toContain("bake_member");
    }
    expect(artFindLayer(s, c.carrier)!.content.type).toBe(LAYER_WARP);
    // The link still carries an ordinary edit.
    s = run(s, { type: "set_param", id: "exposure", param: "exposure", value: 0.3 } as Command);
    expect(member(s).nodes.find((n) => n.id === "exposure")!.params.exposure).toBeCloseTo(0.3, 9);
  });

  it("Reset Edits takes a baked layer away like any layer, and its undo brings it back unbakeable", () => {
    const built = build().whole_uncropped;
    // The photograph on screen, as one of the catalog's.
    const c = { ...built, after: { ...built.after, images: [...built.after.images, { ...built.after.images[0], id: built.after.activeImage }] } };
    const reset = run(c.after, { type: "reset_image_edits", id: c.after.activeImage } as Command);
    expect(artFindLayer(reset, c.carrier)).toBeUndefined();
    const undone = run(reset, { type: "undo" });
    expect(unbakeableWarp(undone, c.carrier)).toBeTruthy();
  });

  it("refuses every layer Bake Warp did not make: a Warp layer, a Pixel layer, Layer via Copy's", () => {
    const w = warpLayer(cropped("uncropped"), true);
    expect(unbake(w.s, w.blend)).toBe(w.s);
    const paint = run(w.s, { type: "art_add_layer", kind: "paint" } as Command);
    expect(unbake(paint, paint.artActive!)).toBe(paint);
    const copied = run(w.s, { type: "art_layer_via_copy", path: "/kept/layercopies/00000000000000aa.tif", box: { x: 0.2, y: 0.2, w: 0.3, h: 0.3 }, aspect: ASPECT, name: "copy", above: null } as Command);
    expect(unbakeableWarp(copied, copied.artActive!)).toBeUndefined();
    expect(unbake(copied, copied.artActive!)).toBe(copied);
  });
});

describe("Unbake's seats, words and gate", () => {
  it("the layer's menus offer it on a baked layer, beside Bake Warp, and gray it elsewhere saying why", () => {
    const c = build().masked_uncropped;
    const item = (s: State, id: string | null) => layerActions(s, id).find((a): a is LayerActionItem => a.kind === "item" && a.testid === "art-menu-unbake-warp")!;
    const list = layerActions(c.after, c.carrier).map((a) => (a.kind === "sep" ? "-" : a.testid));
    expect(list.indexOf("art-menu-unbake-warp")).toBe(list.indexOf("art-menu-bake-warp") + 1);
    expect(item(c.after, c.carrier)).toMatchObject({ label: "Unbake", disabled: false, hint: UNBAKE_WARP_HINT });
    expect(item(c.before, c.carrier).disabled).toBe(true);
    expect(layerActionHint(item(c.before, c.carrier))).toBe(`${UNBAKE_WARP_HINT} Works on a layer Bake Warp made. Select one first.`);
    expect(item(c.after, null).disabled).toBe(true);
    for (const a of [item(c.after, c.carrier), item(c.before, c.carrier), item(c.after, null)]) {
      expect(layerActionHint(a)!.length).toBeLessThanOrEqual(165);
    }
    const seen: Command[] = [];
    item(c.after, c.carrier).run((cmd) => void seen.push(cmd));
    expect(seen).toEqual([{ type: "art_unbake_warp", id: c.carrier }]);
  });

  it("says the outcome first, then that the warp bends what is below it now", () => {
    expect(UNBAKE_WARP_HINT).toMatch(/^Turn this baked layer back into its live Warp layer\./);
    expect(UNBAKE_WARP_HINT).toMatch(/bends whatever is below it now\.$/);
  });

  it("the baked layer's panel and its picture node in the inspector have the seat; Layer via Copy's layer does not", () => {
    const c = build().masked_uncropped;
    const seen: Command[] = [];
    const layer = artLayers(c.after).find((l) => l.blend.id === c.carrier)!;
    const view = render(<ImageLayerControls layer={layer} active state={c.after} dispatch={(cmd) => void seen.push(cmd)} />);
    const button = screen.getByTestId(`art-image-unbake-${c.carrier}`);
    expect(button.getAttribute("data-hint")).toBe(UNBAKE_WARP_HINT);
    fireEvent.click(button);
    expect(seen).toEqual([{ type: "art_unbake_warp", id: c.carrier }]);
    view.unmount();
    const content = artFindLayer(c.after, c.carrier)!.content;
    const inspector = render(<NodeParams node={content} dispatch={(cmd) => void seen.push(cmd)} appState={c.after} allNodes={c.after.nodes} />);
    fireEvent.click(screen.getByTestId(`inspector-unbake-${content.id}`));
    expect(seen[seen.length - 1]).toEqual({ type: "art_unbake_warp", id: c.carrier });
    inspector.unmount();
    const copied = run(c.before, { type: "art_layer_via_copy", path: "/kept/layercopies/00000000000000aa.tif", box: { x: 0.2, y: 0.2, w: 0.3, h: 0.3 }, aspect: ASPECT, name: "copy", above: null } as Command);
    const copyLayer = artLayers(copied).find((l) => l.blend.id === copied.artActive)!;
    render(<ImageLayerControls layer={copyLayer} active state={copied} dispatch={() => {}} />);
    expect(screen.queryByTestId(`art-image-unbake-${copyLayer.blend.id}`)).toBeNull();
  });
});

type Door = { dispatch: (c: Command) => void; state: () => State };
const door = () => (window as unknown as { __heeler: Door }).__heeler;

describe("in the app", () => {
  it("the Layer menu's Bake Warp bakes the active Warp layer, grayed on another layer", async () => {
    render(<App />);
    fireEvent.click(screen.getByTestId("panel-tab-layers"));
    act(() => door().dispatch({ type: "art_add_layer", kind: "paint" } as Command));
    fireEvent.click(screen.getByTestId("menu-layer"));
    expect(screen.getByTestId("menu-layer-bake-warp")).toBeDisabled();
    fireEvent.click(screen.getByTestId("menu-layer"));
    act(() => door().dispatch({ type: "art_add_layer", kind: "warp" } as Command));
    const id = door().state().artActive!;
    fireEvent.click(screen.getByTestId("menu-layer"));
    fireEvent.click(screen.getByTestId("menu-layer-bake-warp"));
    await waitFor(() => expect(artFindLayer(door().state(), id)?.content.type).toBe("heeler.file"));
    // The layer's source line says where its pixels came from, not the
    // kept file's hashed name.
    if (!screen.queryByTestId(`art-image-name-${id}`)) fireEvent.click(screen.getByTestId(`art-settings-${id}`));
    await waitFor(() => expect(screen.getByTestId(`art-image-name-${id}`).textContent).toBe("Baked from a warp"));
  });

  it("the Layer menu's Unbake brings the Warp layer back, grayed on a Warp layer", async () => {
    render(<App />);
    fireEvent.click(screen.getByTestId("panel-tab-layers"));
    act(() => door().dispatch({ type: "art_add_layer", kind: "warp" } as Command));
    const id = door().state().artActive!;
    fireEvent.click(screen.getByTestId("menu-layer"));
    expect(screen.getByTestId("menu-layer-unbake-warp")).toBeDisabled();
    fireEvent.click(screen.getByTestId("menu-layer-bake-warp"));
    await waitFor(() => expect(artFindLayer(door().state(), id)?.content.type).toBe("heeler.file"));
    fireEvent.click(screen.getByTestId("menu-layer"));
    fireEvent.click(screen.getByTestId("menu-layer-unbake-warp"));
    await waitFor(() => expect(artFindLayer(door().state(), id)?.content.type).toBe(LAYER_WARP));
  });

  it("the layer's right-click menu bakes it", async () => {
    render(<App />);
    fireEvent.click(screen.getByTestId("panel-tab-layers"));
    act(() => door().dispatch({ type: "art_add_layer", kind: "warp" } as Command));
    const id = door().state().artActive!;
    fireEvent.contextMenu(screen.getByTestId(`art-layer-${id}`));
    fireEvent.click(screen.getByTestId("art-menu-bake-warp"));
    await waitFor(() => expect(vi.mocked(bakeWarpLayer)).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(artFindLayer(door().state(), id)?.content.type).toBe("heeler.file"));
  });
});
