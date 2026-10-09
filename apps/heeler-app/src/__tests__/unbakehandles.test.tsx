// Unbake brings the ellipse back (2026-10-01: "bake dialog and backup
// switch did not bring back the ellipse"). His screenshot after Unbake:
// the Warp layer back, its settings open with Ellipse 1 listed, and no
// outline or handles on the canvas. Now a Warp layer's open settings are
// its edit mode, armed on the chevron's own event; Unbake put the Warp
// layer back in a row whose settings were already open, and nothing
// armed it.
//
// Held here: the selected Warp layer's open settings and its armed warp
// stay in step by every door that opens them without the chevron
// (Unbake, the undo of a bake, a redo, the Layer menu's selection, a
// Duplicate, Paste Edits, a Take switched back, a reload, a member of a
// group), the shape overlay drawn over the restored ellipse; and the
// warp's dragged shape (a move and an enlargement, Warp mode's drag and
// Pinch) comes back deep-equal through bake and unbake, a crop between
// them and a flip, so the live warp renders as it did. The pixels are
// the desktop's: warp_bake.rs a_dragged_ellipse_unbakes_to_the_render_it_had,
// over the fixture the last test here writes. After a deliberate change
// to what the reducer builds, regenerate:
//   GEN_FIXTURE=1 npx vitest run unbakehandles
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { act, fireEvent, render, screen } from "@testing-library/react";
import React, { useCallback, useState } from "react";
import { describe, expect, it } from "vitest";
import { initialState, NEUTRAL_NODES, NEUTRAL_WIRES } from "../data";
import { artFindLayer, artGroupMembers, artLayers, reduce, warpEditing, LAYER_WARP, type Command, type State } from "../state";
import { noteFrameAspect } from "../imagelayers";
import { shapesFromNode } from "../shapewarp";
import { ArtLayersTab } from "../ui/artlayers";
import { ShapeWarpOverlay } from "../ui/shapewarp";
import type { WarpPair } from "../ui/gridwarp";
import { serializeGraph } from "../bridge";
import { legacySelectionMask } from "./legacymask";
import expectedDragged from "./fixtures/unbake-dragged.json";

const run = (s: State, ...cmds: Command[]): State => cmds.reduce(reduce, s);

function fresh(id = "unbake_handles"): State {
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

/** The ellipse on the head, then dragged in Warp mode: moved, and
 * enlarged with the Pinch pad (the shape's scale). */
const HEAD = { cx: 0.5, cy: 0.45, radius: 0.12, feather: 0.3 };
const DRAGGED = { dx: 0.04, dy: -0.02, scale: 1.45, scaleY: 1.3 };

/** A Pixel layer under a Warp layer whose Type is Shapes, one ellipse on
 * it, dragged, the Warp layer selected and its warp put down. */
function warpStack(start = fresh()): { s: State; blend: string; warp: string; shape: string } {
  let s = run(start, { type: "art_add_layer", kind: "paint" }, { type: "art_add_layer", kind: "warp" });
  const blend = s.artActive!;
  const warp = artFindLayer(s, blend)!.content.id;
  s = run(
    s,
    { type: "shape_warp_add", target: warp },
    { type: "shape_warp_set", id: "shape_1", patch: HEAD, target: warp },
    { type: "art_warp_edit", id: warp, on: true },
    { type: "shape_warp_mode", mode: "warp" },
    { type: "begin_gesture", key: "shapewarp.shape" },
    { type: "shape_warp_set", id: "shape_1", patch: DRAGGED },
    { type: "end_gesture" },
    { type: "art_warp_edit", id: warp, on: false },
  );
  return { s, blend, warp, shape: "shape_1" };
}

const BAKE: Omit<Extract<Command, { type: "art_bake_warp" }>, "id"> = { type: "art_bake_warp", path: "/kept/layercopies/00000000000000aa.tif", box: { x: 0.3, y: 0.2, w: 0.4, h: 0.5 }, aspect: 1.5 };

let send: (c: Command) => void = () => {};
let latest: State;

/** The Finish tab and, as the viewer mounts it, the Shape Warp overlay
 * while its tool is in hand, over one live reducer. */
function mount(initial: State) {
  latest = initial;
  function Host() {
    const [s, setS] = useState(initial);
    const live = React.useRef<WarpPair | null>(null);
    const dispatch = useCallback((c: Command) => {
      setS((prev) => {
        const next = reduce(prev, c);
        latest = next;
        return next;
      });
    }, []);
    send = dispatch;
    return (
      <>
        <ArtLayersTab state={s} dispatch={dispatch} />
        {s.tool === "shapewarp" && <ShapeWarpOverlay state={s} dispatch={dispatch} frame={{ w: 300, h: 200 }} live={live} />}
      </>
    );
  }
  return render(<Host />);
}
const act1 = (c: Command) => act(() => send(c));

/** Whether a Warp layer's settings show, by its controls. */
const shown = (warp: string) => screen.queryByTestId(`finish-warp-${warp}`) !== null;
/** Open and armed agree, and say `want`. */
function inStep(warp: string, want: boolean) {
  expect(shown(warp), "settings open").toBe(want);
  expect(warpEditing(latest, warp), "warp armed").toBe(want);
  expect(screen.queryByTestId("shapewarp-overlay") !== null, "the shape overlay").toBe(want);
}

describe("the selected Warp layer's open settings and its armed warp stay in step", () => {
  it("Unbake leaves the restored Warp layer armed, its ellipse on the canvas (Expand settings on select off)", () => {
    const { s, blend, warp } = warpStack();
    mount(s);
    fireEvent.click(screen.getByTestId(`art-settings-${blend}`));
    inStep(warp, true);
    act1({ ...BAKE, id: blend });
    expect(latest.tool).toBe("none");
    expect(latest.toolRevert).toBeNull();
    // The baked layer's settings stay open (the row's chevron), with Unbake.
    expect(screen.getByTestId(`art-settings-${blend}`)).toHaveAttribute("aria-expanded", "true");
    act1({ type: "art_unbake_warp", id: blend });
    inStep(warp, true);
    expect(latest.tool).toBe("shapewarp");
    expect(latest.warpTarget).toBe(warp);
    expect(screen.getByTestId(`art-settings-${blend}`)).toHaveAttribute("aria-expanded", "true");
    // The ellipse is the overlay's: picked, the gizmo draws it in
    // Position mode, the ring in Warp mode.
    expect(latest.shapeWarp.selected).toBe("shape_1");
    act1({ type: "shape_warp_mode", mode: "warp" });
    const ring = screen.getAllByTestId("shapewarp-ring");
    expect(ring).toHaveLength(1);
    expect(ring[0]).toHaveAttribute("data-shape", "ellipse");
  });

  it("Unbake with Expand settings on select on", () => {
    const { s, blend, warp } = warpStack();
    const on = { ...s, layerExpandOnSelect: true };
    mount(on);
    // Selected and open on mount (a reload): armed.
    inStep(warp, true);
    act1({ ...BAKE, id: blend });
    expect(latest.tool).toBe("none");
    act1({ type: "art_unbake_warp", id: blend });
    inStep(warp, true);
  });

  it("the undo of a bake, and the redo of an Unbake", () => {
    const { s, blend, warp } = warpStack();
    mount(s);
    fireEvent.click(screen.getByTestId(`art-settings-${blend}`));
    act1({ ...BAKE, id: blend });
    act1({ type: "undo" });
    expect(artFindLayer(latest, blend)!.content.type).toBe(LAYER_WARP);
    inStep(warp, true);
    act1({ type: "redo" });
    expect(latest.tool).toBe("none");
    act1({ type: "art_unbake_warp", id: blend });
    act1({ type: "undo" });
    expect(latest.tool).toBe("none");
    act1({ type: "redo" });
    inStep(warp, true);
  });

  it("a selection by the Layer menu reaches a Warp layer whose chevron left it open", () => {
    const { s, blend, warp } = warpStack();
    const pixel = artLayers(s)[0].blend.id;
    mount(s);
    fireEvent.click(screen.getByTestId(`art-settings-${blend}`));
    act1({ type: "select_art_layer", id: pixel });
    expect(warpEditing(latest, warp)).toBe(false);
    // The row stays open, not selected; the warp is down with it.
    expect(shown(warp)).toBe(true);
    act1({ type: "select_art_layer", id: blend });
    inStep(warp, true);
  });

  it("after Enter the settings stay open and the warp stays down until the chevron or a reselect", () => {
    const { s, blend, warp } = warpStack();
    mount(s);
    fireEvent.click(screen.getByTestId(`art-settings-${blend}`));
    act1({ type: "set_tool", tool: "shapewarp", target: warp });
    expect(latest.tool).toBe("none");
    expect(shown(warp)).toBe(true);
    expect(warpEditing(latest, warp)).toBe(false);
  });

  it("a Duplicate: closed and down with the chevron's rows, open and armed with Expand settings on select", () => {
    {
      const { s, blend } = warpStack();
      const view = mount(s);
      act1({ type: "art_duplicate_layer", id: blend });
      const copy = latest.artActive!;
      expect(copy).not.toBe(blend);
      inStep(artFindLayer(latest, copy)!.content.id, false);
      view.unmount();
    }
    {
      const { s, blend } = warpStack();
      mount({ ...s, layerExpandOnSelect: true });
      act1({ type: "art_duplicate_layer", id: blend });
      inStep(artFindLayer(latest, latest.artActive!)!.content.id, true);
    }
  });

  it("Paste Edits that brings the Warp layer back over its baked picture", () => {
    const { s, blend, warp } = warpStack();
    mount(run(s, { type: "copy_edits" }));
    fireEvent.click(screen.getByTestId(`art-settings-${blend}`));
    act1({ ...BAKE, id: blend });
    expect(latest.tool).toBe("none");
    act1({ type: "paste_edits" });
    expect(artFindLayer(latest, blend)!.content.type).toBe(LAYER_WARP);
    inStep(warp, true);
  });

  it("a Take switched back: nothing selected, closed and down; selecting the layer again opens and arms it", () => {
    for (const expand of [false, true]) {
      const { s, blend, warp } = warpStack();
      const view = mount({ ...s, layerExpandOnSelect: expand });
      if (!expand) fireEvent.click(screen.getByTestId(`art-settings-${blend}`));
      inStep(warp, true);
      act1({ type: "new_take" });
      act1({ type: "switch_take", takeId: "take_1" });
      expect(latest.activeTakes[latest.activeImage]).toBe("take_1");
      expect(latest.artActive).toBeNull();
      inStep(warp, false);
      // The Layer menu's selection; with the chevron's rows a chevron
      // opens it again, the switch having closed it.
      act1({ type: "select_art_layer", id: blend });
      if (!expand) {
        inStep(warp, false);
        fireEvent.click(screen.getByTestId(`art-settings-${blend}`));
      }
      inStep(warp, true);
      view.unmount();
    }
  });

  it("a member of a group unbakes armed when its own chevron left it open", () => {
    const { s, blend } = warpStack();
    const grouped = run(s, { type: "art_group_layers", ids: [blend] } as Command);
    const group = artLayers(grouped).find((l) => l.content.isGroup)!;
    const member = artGroupMembers(group.content)[0];
    mount(run(grouped, { type: "select_art_layer", id: member.merge.id }));
    // The group open, then the member's chevron.
    fireEvent.click(screen.getByTestId(`art-open-${group.blend.id}`));
    fireEvent.mouseDown(screen.getByTestId(`art-open-member-${member.merge.id}`));
    fireEvent.click(screen.getByTestId(`art-open-member-${member.merge.id}`));
    expect(warpEditing(latest, member.content.id)).toBe(true);
    act1({ ...BAKE, id: member.merge.id });
    expect(latest.tool).toBe("none");
    act1({ type: "art_unbake_warp", id: member.merge.id });
    expect(warpEditing(latest, member.content.id)).toBe(true);
    expect(screen.queryByTestId("shapewarp-overlay")).not.toBeNull();
  });
});

describe("the dragged shape comes back with Unbake", () => {
  const live = (st: State, blend: string) => artFindLayer(st, blend)!;

  it("deep-equal: the move and the enlargement, its carrier and its graph", () => {
    const { s, blend } = warpStack();
    const before = live(s, blend);
    const shape = shapesFromNode(before.content)[0];
    expect(shape).toMatchObject({ dx: DRAGGED.dx, dy: DRAGGED.dy, scale: DRAGGED.scale, scaleY: DRAGGED.scaleY });
    const baked = run(s, { ...BAKE, id: blend });
    expect(live(baked, blend).content.bakedFrom!.content).toEqual(before.content);
    expect(live(baked, blend).content.bakedFrom!.carrier).toEqual(before.carrier);
    const back = run(baked, { type: "art_unbake_warp", id: blend });
    expect(live(back, blend).content).toEqual(before.content);
    expect(live(back, blend).carrier).toEqual(before.carrier);
    expect(back.nodes).toEqual(s.nodes);
  });

  it("baked while armed: what the bake keeps is the drag, not the shape as edit mode opened", () => {
    const { s, blend, warp } = warpStack();
    const armed = run(s, { type: "art_warp_edit", id: warp, on: true }, { type: "shape_warp_set", id: "shape_1", patch: { scale: 1.6 } });
    const baked = run(armed, { ...BAKE, id: blend });
    expect(baked.toolRevert).toBeNull();
    expect(shapesFromNode(live(baked, blend).content.bakedFrom!.content)[0].scale).toBe(1.6);
    // Escape after the bake has nothing to put back onto the picture.
    const escaped = run(baked, { type: "cancel_tool" });
    expect(live(escaped, blend).content).toEqual(live(baked, blend).content);
    const back = run(baked, { type: "art_unbake_warp", id: blend });
    expect(shapesFromNode(live(back, blend).content)[0].scale).toBe(1.6);
  });

  it("through a crop between bake and unbake, as the live layer's own crop carries it", () => {
    const { s, blend } = warpStack();
    const crop = { type: "set_params", id: "crop", values: { angle: 6, crop_x: 0.1, crop_y: 0.15, crop_w: 0.7, crop_h: 0.65 } } as Command;
    const liveCropped = run(s, crop);
    const back = run(s, { ...BAKE, id: blend }, crop, { type: "art_unbake_warp", id: blend });
    const want = shapesFromNode(live(liveCropped, blend).content)[0];
    const got = shapesFromNode(live(back, blend).content)[0];
    expect(got).toEqual(want);
    // The drag is carried, not dropped: still a move and an enlargement.
    expect(Math.hypot(got.dx, got.dy)).toBeGreaterThan(0.01);
    expect(got.scale).toBeCloseTo(DRAGGED.scale, 6);
  });

  it("through a flip of the baked layer: the move mirrors, the enlargement stays", () => {
    const { s, blend } = warpStack();
    const baked = run(s, { ...BAKE, id: blend });
    const flipped = run(baked, { type: "art_flip_layer", id: blend, axis: "h" } as Command);
    const got = shapesFromNode(live(run(flipped, { type: "art_unbake_warp", id: blend }), blend).content)[0];
    expect(got.dx).toBeCloseTo(-DRAGGED.dx, 9);
    expect(got.dy).toBeCloseTo(DRAGGED.dy, 9);
    expect(got.scale).toBeCloseTo(DRAGGED.scale, 9);
    expect(got.scaleY).toBeCloseTo(DRAGGED.scaleY, 9);
  });
});

const CROPS: Record<string, Record<string, number>> = {
  uncropped: { angle: 0, crop_x: 0, crop_y: 0, crop_w: 1, crop_h: 1 },
  cropped: { angle: 0, crop_x: 0.2, crop_y: 0.2, crop_w: 0.6, crop_h: 0.6 },
  turned: { angle: 8, crop_x: 0.15, crop_y: 0.15, crop_w: 0.7, crop_h: 0.7 },
};
const RECROP: Record<string, string> = { uncropped: "cropped", cropped: "turned", turned: "uncropped" };

describe("the desktop's fixture: a dragged ellipse baked and unbaked", () => {
  it("serialized graphs match it (masked and whole, uncropped, cropped and turned, and through a second crop)", () => {
    const out: Record<string, unknown> = {};
    for (const crop of Object.keys(CROPS)) {
      for (const masked of [true, false]) {
        const start = run(fresh(), { type: "set_params", id: "crop", values: CROPS[crop] } as Command);
        let { s, blend } = warpStack(start);
        if (masked) {
          s = legacySelectionMask(s, blend, [
            { kind: "marquee", op: "add", x0: HEAD.cx - 0.1 / 1.5, y0: HEAD.cy - 0.1, x1: HEAD.cx + 0.1 / 1.5, y1: HEAD.cy + 0.1, shape: "ellipse" } as never,
          ]);
        }
        const recrop = { type: "set_params", id: "crop", values: CROPS[RECROP[crop]] } as Command;
        const baked = run(s, { ...BAKE, id: blend });
        const unbaked = run(baked, { type: "art_unbake_warp", id: blend });
        expect(unbaked.nodes).toEqual(s.nodes);
        out[`${masked ? "masked" : "whole"}_${crop}`] = {
          before: serializeGraph(s),
          below: serializeGraph(run(s, { type: "art_remove_layer", id: blend })),
          unbaked: serializeGraph(unbaked),
          recrop_before: serializeGraph(run(s, recrop)),
          recrop_unbaked: serializeGraph(run(baked, recrop, { type: "art_unbake_warp", id: blend })),
          carrier: blend,
        };
      }
    }
    if (process.env.GEN_FIXTURE) writeFileSync(resolve(process.cwd(), "src/__tests__/fixtures/unbake-dragged.json"), JSON.stringify(out, null, 1) + "\n");
    expect(out).toEqual(expectedDragged);
  });
});
