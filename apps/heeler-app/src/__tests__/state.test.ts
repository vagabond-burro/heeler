import { describe, expect, it } from "vitest";
import { artLayers, clampParam, cropNode, hardRange, snapStep, createsCycle, curvesUntouched, filtersActive, layersOf, nameMatches, paramRange, reduce, spliceIn, spliceOut, toolNode, visibleImages, PARAM_RANGE, NEUTRAL_PARAMS, BRUSH_TIPS, RADIAL_SHAPES, SHAPE_AMOUNT_LABEL, TEXTURED_TIPS, type Command, type NodeCard, type State, type Wire , maskPreviewNode, needsRenderedBypass, stackAppendTargets, PROFILE_DEFAULTS, DEFAULT_SECTIONS_CLOSED} from "../state";
import { makeNode, specFor } from "../nodes";
import { gridWarpMesh, shapeWarpShapes, NODE_H, NODE_W, publishedTarget } from "../state";
import { NEUTRAL_NODES, NEUTRAL_WIRES, initialState } from "../data";
import { runCommand } from "../commands";
import { handleApi, handleApiAsync, API_BATCH_ONLY, API_COMMANDS, API_METHODS, API_NATIVE } from "../api";
import { mockExportedLog, mockResetExports, serializeBeforeGraph, serializeGraph } from "../bridge";
import { COMMANDS, exportHotkeys } from "../hotkeys";
import { SECTIONS, paramDefault, ROW_TIPS } from "../ui/simple";

function run(s: State, ...cmds: Command[]): State {
  return cmds.reduce(reduce, s);
}

describe("the splash, once done", () => {
  it("stays done: a later boot step does not bring it back (2026-09-19)", () => {
    let s: State = { ...initialState(), boot: { step: "catalog", detail: "" } };
    s = reduce(s, { type: "boot_step", step: "folders" });
    expect(s.boot?.step).toBe("folders");
    s = reduce(s, { type: "dismiss_splash" });
    expect(s.boot).toBeNull();
    s = reduce(s, { type: "boot_step", step: "photos" });
    expect(s.boot).toBeNull();
    // An ordinary boot_done still lets a later step start a splash, the
    // way the splash tests expect.
    let t: State = { ...initialState(), boot: { step: "catalog", detail: "" } };
    t = reduce(t, { type: "boot_done" });
    t = reduce(t, { type: "boot_step", step: "photos" });
    expect(t.boot?.step).toBe("photos");
  });
});

describe("graph state semantics", () => {
  it("clamps params to what is real, not to what the slider spans", () => {
    // Twelve stops is past the slider and past sanity, and it is still
    // what someone typed. The app-wide rule: the control range is
    // editorial, the hard range is physics. See hardRange().
    const s = run(initialState(), { type: "set_param", id: "exposure", param: "exposure", value: 12 });
    expect(s.nodes.find((n) => n.id === "exposure")!.params.exposure).toBe(12);
    // A parameter that cannot go negative still cannot.
    const t = run(initialState(), { type: "set_param", id: "stdcolor", param: "temperature", value: -500 });
    expect(t.nodes.find((n) => n.id === "stdcolor")!.params.temperature).toBe(0);
  });

  it("set_param marks the active image edited", () => {
    let s = initialState();
    s = run(s, { type: "select_image", id: "4869" });
    expect(s.images.find((i) => i.id === "4869")!.edited).toBe(false);
    s = run(s, { type: "set_param", id: "exposure", param: "exposure", value: 1 });
    expect(s.images.find((i) => i.id === "4869")!.edited).toBe(true);
  });

  it("a first visit holds the render pump until the saved graph is read; a return renders the stash at once", () => {
    let s = initialState();
    s = run(s, { type: "select_image", id: "4869" });
    // Nothing stashed for this photo yet: the graph on hand is the
    // template, and rendering it would flash the unedited look.
    expect(s.graphLoading).toBe("4869");
    // Another photo's settle is not this one's.
    expect(run(s, { type: "graph_settled", id: "4875" }).graphLoading).toBe("4869");
    expect(run(s, { type: "graph_settled", id: "4869" }).graphLoading).toBeNull();
    // The saved graph arriving is the settle too.
    const replaced = run(s, { type: "replace_graph", nodes: s.nodes, wires: s.wires, backdrops: [] });
    expect(replaced.graphLoading).toBeNull();
    // Coming back to a photo seen this session: its stash is the edited
    // state already, so nothing to wait for.
    const back = run(replaced, { type: "select_image", id: "4875" }, { type: "select_image", id: "4869" });
    expect(back.graphLoading).toBeNull();
    // A new session's first photo waits the same way.
    expect(run(back, { type: "load_images", images: back.images }).graphLoading).toBe(back.images[0].id);
  });

  it("a photo switched away mid-read holds again on return: the stash is the template, not the saved graph", () => {
    let s = initialState();
    s = run(s, { type: "select_image", id: "4869" });
    expect(s.graphLoading).toBe("4869");
    // Walking off before the read lands stashes the template; coming
    // back must keep holding, or the unedited look flashes again.
    s = run(s, { type: "select_image", id: "4875" });
    s = run(s, { type: "select_image", id: "4869" });
    expect(s.graphLoading).toBe("4869");
    // Once the saved graph has arrived and the photo is walked off
    // again, the stash is real edits and the return renders at once.
    s = run(s, { type: "replace_graph", nodes: s.nodes, wires: s.wires, backdrops: [] });
    s = run(s, { type: "select_image", id: "4875" });
    expect(run(s, { type: "select_image", id: "4869" }).graphLoading).toBeNull();
  });

  describe("grid warp", () => {
    const meshOf = (s: State) => {
      const n = s.nodes.find((x) => x.type === "heeler.grid_warp")!;
      return { node: n, mesh: JSON.parse(n.textParams!.mesh) as number[] };
    };

    it("the first drag builds the node on, a handle arms a switched-off warp, and graph removal drops its tool", () => {
      let s = run(initialState(), { type: "select_image", id: "4869" }, { type: "set_tool", tool: "gridwarp" });
      s = run(s, { type: "grid_warp_mesh", mesh: gridWarpMesh(s) });
      // Born on, like the crop the first crop drag builds.
      expect(meshOf(s).node.enabled).toBe(true);
      // Switched off, a rest mesh leaves it off; a handle that moves
      // switches it on, the way every bypassed node's controls do.
      const off = run(s, { type: "set_enabled", id: "gridwarp", enabled: false }, { type: "set_tool", tool: "gridwarp" });
      expect(meshOf(run(off, { type: "grid_warp_mesh", mesh: gridWarpMesh(off) })).node.enabled).toBe(false);
      const rest = gridWarpMesh(off);
      const moved = { ...rest, d: rest.d.map((d, k) => (k === 7 ? ([0.1, 0] as [number, number]) : d)) };
      expect(meshOf(run(off, { type: "grid_warp_mesh", mesh: moved })).node.enabled).toBe(true);
      expect(s.tool).toBe("gridwarp");
      expect(run(s, { type: "delete_nodes", ids: ["gridwarp"], heal: true }).tool).toBe("none");
      expect(run(s, { type: "undo" }).tool).toBe("none");
      expect(run(s, { type: "replace_graph", nodes: s.nodes, wires: s.wires }).tool).toBe("none");
    });

    it("leaving the warp tool for another tool arms that tool, with its own revert", () => {
      // The drop that follows the warp's node out of the graph must not
      // fire on an ordinary tool change: set_tool crop from gridwarp
      // used to land on "none" with the crop's revert snapshot wiped.
      let s = run(initialState(), { type: "select_image", id: "4869" }, { type: "set_tool", tool: "gridwarp" });
      s = run(s, { type: "grid_warp_select", ids: [7] });
      const crop = run(s, { type: "set_tool", tool: "crop" });
      expect(crop.tool).toBe("crop");
      expect(crop.toolRevert).toMatchObject({ id: "crop" });
      // The picks do not outlive the tool.
      expect(crop.gridWarp.selected).toEqual([]);
      // Toggling the tool off (Enter, or the button again) is "none".
      expect(run(s, { type: "set_tool", tool: "gridwarp" }).tool).toBe("none");
    });

    it("density streams and a two-axis insert are one step, separate drags stay separate", () => {
      let s = run(initialState(), { type: "select_image", id: "4869" });
      const before = s.undoStack.length;
      for (let drag = 0; drag < 2; drag++) {
        s = run(s, { type: "begin_gesture", key: "gridwarp.density" },
          { type: "grid_warp_density", cols: 5+drag, rows: 3 },
          { type: "grid_warp_density", cols: 6+drag, rows: 3 }, { type: "end_gesture" });
        expect(s.undoStack.length).toBe(before+drag+1);
      }
      s = run(s, { type: "begin_gesture", key: "gridwarp.line" },
        { type: "grid_warp_line", axis: "col", at: 0.37 },
        { type: "grid_warp_line", axis: "row", at: 0.37 }, { type: "end_gesture" });
      expect(s.undoStack.length).toBe(before+3);
    });

    it("the first drag builds the node after the lens, and a density change keeps the warp", () => {
      let s = run(initialState(), { type: "select_image", id: "4869" });
      expect(s.nodes.some((n) => n.type === "heeler.grid_warp")).toBe(false);
      const rest = gridWarpMesh(s);
      const moved = { ...rest, d: rest.d.map((d, k) => (k === 7 ? ([0.1, -0.05] as [number, number]) : d)) };
      s = run(s, { type: "grid_warp_mesh", mesh: moved });
      const { node, mesh } = meshOf(s);
      expect(node.id).toBe("gridwarp");
      expect(node.params).toMatchObject({ cols: 4, rows: 3 });
      expect(mesh.slice(14, 16)).toEqual([0.1, -0.05]);
      // Spliced at the chain's crop slot: straight after the source in
      // a graph that has no crop or lens, and marked edited.
      expect(s.wires.some((w) => w.to === "gridwarp" && w.toPort === "in")).toBe(true);
      expect(s.images.find((i) => i.id === "4869")!.edited).toBe(true);
      expect(s.undoStack[s.undoStack.length - 1].label).toBe("Grid Warp: drag");
      // Doubling the density: the old handle keeps its displacement on
      // the finer grid, and the picks are dropped.
      s = run(s, { type: "grid_warp_select", ids: [7] }, { type: "grid_warp_density", cols: 8, rows: 6 });
      const dense = meshOf(s);
      expect(dense.node.params).toMatchObject({ cols: 8, rows: 6 });
      // Vertex (2,1) on the coarse grid is (4,2) on the fine one.
      const k = 2 * 9 + 4;
      expect(dense.mesh[2 * k]).toBeCloseTo(0.1, 6);
      expect(dense.mesh[2 * k + 1]).toBeCloseTo(-0.05, 6);
      expect(s.gridWarp.selected).toEqual([]);
      // A line in by hand, at a third: non-uniform, everything else kept.
      s = run(s, { type: "grid_warp_line", axis: "col", at: 1 / 3 });
      expect(JSON.parse(meshOf(s).node.textParams!.cols_u)).toHaveLength(10);
      expect(meshOf(s).node.params.cols).toBe(9);
      // On top of a line: nothing happens, and nothing lands in undo.
      const before = s.undoStack.length;
      expect(run(s, { type: "grid_warp_line", axis: "col", at: 0.5 })).toBe(s);
      expect(s.undoStack.length).toBe(before);
      // Reset: every handle at rest, the density kept.
      s = run(s, { type: "grid_warp_reset" });
      expect(meshOf(s).mesh.every((x) => x === 0)).toBe(true);
      expect(meshOf(s).node.params.cols).toBe(9);
      // Undo walks it all back to the drag.
      s = run(s, { type: "undo" }, { type: "undo" }, { type: "undo" });
      expect(meshOf(s).node.params.cols).toBe(4);
      expect(meshOf(s).mesh.slice(14, 16)).toEqual([0.1, -0.05]);
    });

    it("picks are view state: set, add, toggle, grow, shrink, and gone on a photo switch", () => {
      let s = run(initialState(), { type: "select_image", id: "4869" });
      s = run(s, { type: "grid_warp_select", ids: [7] });
      expect(s.gridWarp.selected).toEqual([7]);
      s = run(s, { type: "grid_warp_select", ids: [8, 7], mode: "add" });
      expect(s.gridWarp.selected).toEqual([7, 8]);
      s = run(s, { type: "grid_warp_select", ids: [8], mode: "toggle" });
      expect(s.gridWarp.selected).toEqual([7]);
      s = run(s, { type: "grid_warp_grow" });
      expect(s.gridWarp.selected).toEqual([2, 6, 7, 8, 12]);
      s = run(s, { type: "grid_warp_shrink" });
      expect(s.gridWarp.selected).toEqual([7]);
      s = run(s, { type: "set_grid_warp_ui", influence: 99, heat: "chroma" });
      expect(s.gridWarp).toMatchObject({ influence: 8, heat: "chroma" });
      s = run(s, { type: "select_image", id: "4875" });
      expect(s.gridWarp.selected).toEqual([]);
      expect(s.gridWarp.heat).toBe("chroma");
      // The reset of a photo with no node is nothing at all.
      expect(run(s, { type: "grid_warp_reset" })).toBe(s);
    });

    it("the tool arms like crop: Escape puts the mesh back, and takes out a node the tool built", () => {
      let s = run(initialState(), { type: "select_image", id: "4869" }, { type: "set_tool", tool: "gridwarp" });
      expect(s.tool).toBe("gridwarp");
      expect(s.toolRevert).toMatchObject({ id: "gridwarp", fresh: true });
      const rest = gridWarpMesh(s);
      s = run(s, { type: "grid_warp_mesh", mesh: { ...rest, d: rest.d.map((d, k) => (k === 7 ? ([0.1, 0] as [number, number]) : d)) } });
      expect(s.nodes.some((n) => n.type === "heeler.grid_warp")).toBe(true);
      s = run(s, { type: "cancel_tool" });
      expect(s.tool).toBe("none");
      expect(s.nodes.some((n) => n.type === "heeler.grid_warp")).toBe(false);
      // Armed on a photo that has a warp, Escape puts that warp back.
      s = run(s, { type: "grid_warp_mesh", mesh: { ...rest, d: rest.d.map((d, k) => (k === 7 ? ([0.2, 0] as [number, number]) : d)) } });
      s = run(s, { type: "set_tool", tool: "gridwarp" });
      expect(s.toolRevert).toMatchObject({ id: "gridwarp", fresh: false });
      s = run(s, { type: "grid_warp_reset" }, { type: "cancel_tool" });
      expect(meshOf(s).mesh.slice(14, 16)).toEqual([0.2, 0]);
      // Enter (set_tool again) keeps what is there.
      s = run(s, { type: "set_tool", tool: "gridwarp" }, { type: "grid_warp_reset" }, { type: "set_tool", tool: "gridwarp" });
      expect(s.tool).toBe("none");
      expect(meshOf(s).mesh.every((x) => x === 0)).toBe(true);
    });

    it("switching the warp off, or resetting the photo, puts the tool away; the section starts folded", () => {
      const rest = gridWarpMesh(initialState());
      const up = (): State =>
        run(initialState(), { type: "select_image", id: "4869" }, { type: "set_tool", tool: "gridwarp" }, { type: "grid_warp_mesh", mesh: rest }, { type: "grid_warp_select", ids: [7] });
      // The section's switch.
      let s = run(up(), { type: "set_category", title: "Grid Warp", on: false });
      expect(s.tool).toBe("none");
      expect(s.toolRevert).toBeNull();
      expect(s.gridWarp.selected).toEqual([]);
      // Switching it ON leaves the tool alone.
      s = run(up(), { type: "set_category", title: "Grid Warp", on: true });
      expect(s.tool).toBe("gridwarp");
      // The node's own switch, from the graph.
      s = run(up(), { type: "set_enabled", id: "gridwarp", enabled: false });
      expect(s.tool).toBe("none");
      // Another node's switch does not.
      s = run(up(), { type: "set_enabled", id: "exposure", enabled: false });
      expect(s.tool).toBe("gridwarp");
      // Reset edits on the open photo.
      s = run(up(), { type: "reset_image_edits", id: "4869" });
      expect(s.tool).toBe("none");
      expect(s.nodes.some((n) => n.type === "heeler.grid_warp")).toBe(false);
      // And on another photo, the tool stays up on this one.
      s = run(up(), { type: "reset_image_edits", id: "4875" });
      expect(s.tool).toBe("gridwarp");
      expect(DEFAULT_SECTIONS_CLOSED).toContain("Grid Warp");
      expect(DEFAULT_SECTIONS_CLOSED).toContain("Depth Map");
      // Off by default and folded by default, though its node is always
      // in the graph (2026-09-22).
      expect(DEFAULT_SECTIONS_CLOSED).toContain("Color Checker");
      expect(initialState().sectionsClosed).toContain("Color Checker");
      // Switched on from the section, the card lands beside the chain,
      // not on top of the Image Source card ("there is no
      // Image Source node in the graph").
      const on = run(initialState(), { type: "select_image", id: "4869" }, { type: "set_category", title: "Grid Warp", on: true });
      const warp = on.nodes.find((n) => n.type === "heeler.grid_warp")!;
      for (const other of on.nodes.filter((n) => n.id !== warp.id)) {
        expect(Math.abs(other.x - warp.x) >= NODE_W || Math.abs(other.y - warp.y) >= NODE_H, `${other.id} under the warp card`).toBe(true);
      }
    });
  });

  describe("shape warp", () => {
    const shapesOf = (s: State) => shapeWarpShapes(s);
    const nodeOf = (s: State) => s.nodes.find((n) => n.type === "heeler.shape_warp");
    const withShape = (): State =>
      run(initialState(), { type: "select_image", id: "4869" }, { type: "set_tool", tool: "shapewarp" }, { type: "shape_warp_add" });

    it("the first shape builds the node on after Grid Warp's slot, picked, in Position mode", () => {
      let s = run(initialState(), { type: "select_image", id: "4869" });
      expect(nodeOf(s)).toBeUndefined();
      // Nothing but an add builds the node: a stray write is nothing.
      expect(run(s, { type: "shape_warp_set", id: "shape_1", patch: { dx: 0.1 } })).toBe(s);
      expect(run(s, { type: "shape_warp_reset" })).toBe(s);
      s = run(s, { type: "shape_warp_add" });
      const node = nodeOf(s)!;
      expect(node.id).toBe("shapewarp");
      expect(node.enabled).toBe(true);
      expect(s.wires.some((w) => w.to === "shapewarp" && w.toPort === "in")).toBe(true);
      expect(s.images.find((i) => i.id === "4869")!.edited).toBe(true);
      expect(s.undoStack[s.undoStack.length - 1].label).toBe("Shape Warp: add shape");
      expect(shapesOf(s)).toHaveLength(1);
      expect(shapesOf(s)[0]).toMatchObject({ id: "shape_1", name: "", enabled: true, cx: 0.5, cy: 0.5, dx: 0, angle: 0, scale: 1, amount: 1 });
      expect(s.shapeWarp).toEqual({ selected: "shape_1", mode: "position" });
      // A second shape gets the next name, and takes the pick.
      s = run(s, { type: "shape_warp_mode", mode: "warp" }, { type: "shape_warp_add" });
      expect(shapesOf(s).map((x) => x.id)).toEqual(["shape_1", "shape_2"]);
      expect(s.shapeWarp).toEqual({ selected: "shape_2", mode: "position" });
      // The node is spliced in the chain's order: after the grid warp
      // when there is one, before the color work.
      const stdcolor = s.wires.find((w) => w.to === "stdcolor" && w.toPort === "in");
      expect(stdcolor?.from).toBe("shapewarp");
    });

    it("the list: rename, switch off, remove with the pick moving to the last, reset one or all, undo", () => {
      let s = run(withShape(), { type: "shape_warp_add" }, { type: "shape_warp_add" });
      s = run(s, { type: "shape_warp_rename", id: "shape_2", name: "  Nose  " });
      expect(shapesOf(s)[1].name).toBe("Nose");
      // A blank name hands the shape back to the automatic one: its
      // outline and its place, which is what the row then reads.
      expect(shapesOf(run(s, { type: "shape_warp_rename", id: "shape_2", name: "  " }))[1].name).toBe("");
      s = run(s, { type: "shape_warp_enable", id: "shape_2", on: false });
      expect(shapesOf(s)[1].enabled).toBe(false);
      expect(s.undoStack[s.undoStack.length - 1].label).toBe("Shape Warp: disable shape");
      // A move on two shapes, then Reset warp on one leaves the other.
      s = run(s, { type: "shape_warp_set", id: "shape_1", patch: { dx: 0.1, dy: -0.05 } });
      s = run(s, { type: "shape_warp_set", id: "shape_3", patch: { angle: 30, scale: 1.5, scaleY: 0.5 } });
      expect(shapesOf(s)[0]).toMatchObject({ dx: 0.1, dy: -0.05 });
      expect(shapesOf(s)[2]).toMatchObject({ angle: 30, scale: 1.5, scaleY: 0.5 });
      s = run(s, { type: "shape_warp_reset", id: "shape_1" });
      expect(shapesOf(s)[0]).toMatchObject({ dx: 0, dy: 0 });
      expect(shapesOf(s)[2]).toMatchObject({ angle: 30, scale: 1.5, scaleY: 0.5 });
      // The section's Reset: every warp to rest, the shapes kept where
      // they are, on or off as they were.
      s = run(s, { type: "shape_warp_set", id: "shape_3", patch: { cx: 0.2 } }, { type: "shape_warp_reset" });
      expect(shapesOf(s)[2]).toMatchObject({ cx: 0.2, angle: 0, scale: 1, scaleY: 1 });
      expect(shapesOf(s)[1].enabled).toBe(false);
      expect(shapesOf(s)).toHaveLength(3);
      // Removing the picked shape picks the last one left; removing a
      // shape that is not there is nothing.
      expect(s.shapeWarp.selected).toBe("shape_3");
      s = run(s, { type: "shape_warp_remove", id: "shape_3" });
      expect(shapesOf(s).map((x) => x.id)).toEqual(["shape_1", "shape_2"]);
      expect(s.shapeWarp.selected).toBe("shape_2");
      expect(run(s, { type: "shape_warp_remove", id: "shape_9" })).toBe(s);
      s = run(s, { type: "shape_warp_remove", id: "shape_1" });
      expect(s.shapeWarp.selected).toBe("shape_2");
      s = run(s, { type: "shape_warp_remove", id: "shape_2" });
      expect(shapesOf(s)).toEqual([]);
      expect(s.shapeWarp.selected).toBeNull();
      // Undo brings the last shape back.
      s = run(s, { type: "undo" });
      expect(shapesOf(s).map((x) => x.id)).toEqual(["shape_2"]);
      // Two shapes taken out and added again do not share an id.
      s = run(s, { type: "shape_warp_add" });
      expect(shapesOf(s).map((x) => x.id)).toEqual(["shape_2", "shape_3"]);
    });

    it("a move arms a switched-off warp; placing a shape that moves nothing leaves it off", () => {
      let s = run(withShape(), { type: "set_enabled", id: "shapewarp", enabled: false });
      expect(nodeOf(s)!.enabled).toBe(false);
      s = run(s, { type: "shape_warp_set", id: "shape_1", patch: { cx: 0.3, radius: 0.4 } });
      expect(nodeOf(s)!.enabled).toBe(false);
      s = run(s, { type: "shape_warp_add" }, { type: "shape_warp_rename", id: "shape_2", name: "Eye" });
      expect(nodeOf(s)!.enabled).toBe(true);
      s = run(s, { type: "set_enabled", id: "shapewarp", enabled: false });
      s = run(s, { type: "shape_warp_set", id: "shape_1", patch: { dx: 0.05 } });
      expect(nodeOf(s)!.enabled).toBe(true);
      // A drag's writes coalesce under one gesture into one undo step.
      const before = s.undoStack.length;
      s = run(s, { type: "begin_gesture", key: "shapewarp.shape" },
        { type: "shape_warp_set", id: "shape_1", patch: { dx: 0.1 } },
        { type: "shape_warp_set", id: "shape_1", patch: { dx: 0.2 } }, { type: "end_gesture" });
      expect(s.undoStack.length).toBe(before + 1);
      expect(shapesOf(s)[0].dx).toBe(0.2);
      expect(s.undoStack[s.undoStack.length - 1].label).toBe("Shape Warp: drag");
      // A write that is not finite is kept out of the shape.
      s = run(s, { type: "shape_warp_set", id: "shape_1", patch: { dx: Number.NaN, scale: Number.POSITIVE_INFINITY } });
      expect(shapesOf(s)[0]).toMatchObject({ dx: 0.2, scale: 1 });
    });

    it("the tool arms like crop, and is put away when the warp goes, the section switches off, or the photo changes", () => {
      let s = run(initialState(), { type: "select_image", id: "4869" }, { type: "set_tool", tool: "shapewarp" });
      expect(s.tool).toBe("shapewarp");
      expect(s.toolRevert).toMatchObject({ id: "shapewarp", fresh: true });
      s = run(s, { type: "shape_warp_add" });
      // Escape takes out the node the tool built.
      const cancelled = run(s, { type: "cancel_tool" });
      expect(cancelled.tool).toBe("none");
      expect(nodeOf(cancelled)).toBeUndefined();
      // Enter keeps it.
      const kept = run(s, { type: "set_tool", tool: "shapewarp" });
      expect(kept.tool).toBe("none");
      expect(shapesOf(kept)).toHaveLength(1);
      // Armed again on a photo with shapes, the last shape is picked
      // (Enter had dropped the pick), and Escape puts the shapes back.
      expect(kept.shapeWarp.selected).toBeNull();
      let t = run(kept, { type: "set_tool", tool: "shapewarp" });
      expect(t.shapeWarp.selected).toBe("shape_1");
      t = run(t, { type: "shape_warp_set", id: "shape_1", patch: { dx: 0.3 } }, { type: "cancel_tool" });
      expect(shapesOf(t)[0].dx).toBe(0);
      expect(t.tool).toBe("none");
      // The section's switch, the node's switch, the node's removal,
      // and Reset edits all put the tool away with the pick.
      const up = (): State => run(kept, { type: "set_tool", tool: "shapewarp" }, { type: "shape_warp_mode", mode: "warp" });
      expect(up().shapeWarp).toEqual({ selected: "shape_1", mode: "warp" });
      t = run(up(), { type: "set_category", title: "Shape Warp", on: false });
      expect(t.tool).toBe("none");
      expect(t.shapeWarp.selected).toBeNull();
      t = run(up(), { type: "set_category", title: "Grid Warp", on: false });
      expect(t.tool).toBe("shapewarp");
      t = run(up(), { type: "set_enabled", id: "shapewarp", enabled: false });
      expect(t.tool).toBe("none");
      t = run(up(), { type: "set_enabled", id: "exposure", enabled: false });
      expect(t.tool).toBe("shapewarp");
      t = run(up(), { type: "delete_nodes", ids: ["shapewarp"], heal: true });
      expect(t.tool).toBe("none");
      t = run(up(), { type: "reset_image_edits", id: "4869" });
      expect(t.tool).toBe("none");
      expect(nodeOf(t)).toBeUndefined();
      t = run(up(), { type: "reset_image_edits", id: "4875" });
      expect(t.tool).toBe("shapewarp");
      // Another tool takes over cleanly, the pick dropped.
      t = run(up(), { type: "set_tool", tool: "crop" });
      expect(t.tool).toBe("crop");
      expect(t.toolRevert).toMatchObject({ id: "crop" });
      expect(t.shapeWarp.selected).toBeNull();
      // Walking to another photo drops the pick, keeps the mode.
      t = run(up(), { type: "select_image", id: "4875" });
      expect(t.shapeWarp).toEqual({ selected: null, mode: "warp" });
      expect(DEFAULT_SECTIONS_CLOSED).toContain("Shape Warp");
      expect(COMMANDS.some((h) => h.id === "tool.shapewarp" && h.binding === "Shift+W")).toBe(true);
    });
  });

  it("undo/redo round-trips a param change", () => {
    const s0 = initialState();
    const before = s0.nodes.find((n) => n.id === "exposure")!.params.exposure;
    let s = run(s0, { type: "set_param", id: "exposure", param: "exposure", value: 2 });
    s = run(s, { type: "undo" });
    expect(s.nodes.find((n) => n.id === "exposure")!.params.exposure).toBe(before);
    s = run(s, { type: "redo" });
    expect(s.nodes.find((n) => n.id === "exposure")!.params.exposure).toBe(2);
  });

  it("rejects connections into an occupied input", () => {
    const s0 = initialState();
    const s = run(s0, {
      type: "connect",
      wire: { from: "src", to: "cbal", toPort: "in", kind: "image" },
    });
    expect(s.wires).toEqual(s0.wires);
  });

  it("rejects cycles", () => {
    expect(createsCycle(initialState().wires, "src", "output")).toBe(false);
    expect(createsCycle(initialState().wires, "output", "src")).toBe(true);
    const s0 = initialState();
    const s = run(
      s0,
      { type: "disconnect", to: "merge", toPort: "in" },
      { type: "connect", wire: { from: "output", to: "merge", toPort: "in", kind: "image" } }
    );
    expect(s.wires.some((w) => w.from === "output")).toBe(false);
  });

  it("rejects image outputs plugged into mask inputs and vice versa", () => {
    const s0 = run(initialState(), { type: "disconnect", to: "cbal", toPort: "mask" });
    // Image source into mask port: refused.
    let s = run(s0, { type: "connect", wire: { from: "src", to: "cbal", toPort: "mask", kind: "mask" } });
    expect(s.wires.some((w) => w.to === "cbal" && w.toPort === "mask")).toBe(false);
    // Mask node into image port: refused.
    s = run(s0, { type: "disconnect", to: "sharpen", toPort: "in" }, {
      type: "connect",
      wire: { from: "lummask", to: "sharpen", toPort: "in", kind: "image" },
    });
    expect(s.wires.some((w) => w.from === "lummask" && w.toPort === "in")).toBe(false);
    // Mask node into mask port: allowed.
    s = run(s0, { type: "connect", wire: { from: "lummask", to: "cbal", toPort: "mask", kind: "mask" } });
    expect(s.wires.some((w) => w.to === "cbal" && w.toPort === "mask")).toBe(true);
  });

  it("lets mask pipes land on the logic family's operand ports, and nothing else", () => {
    // The family (measure/compare/logic/math/remap, plus invert_mask)
    // consumes masks AS its input, so the usual "mask pipes only to the
    // mask port" rule would make them unwireable. invert_mask was
    // exactly that: the canvas refused every pipe a user could drag to
    // it, and only recipes wrote its wire.
    let s = run(initialState(), { type: "add_node", node: makeNode(specFor("heeler.logic")!, "lg", 0, 0) });
    s = run(s, { type: "connect", wire: { from: "lummask", to: "lg", toPort: "in", kind: "mask" } });
    expect(s.wires.some((w) => w.to === "lg" && w.toPort === "in")).toBe(true);
    s = run(s, { type: "connect", wire: { from: "lummask", to: "lg", toPort: "in2", kind: "mask" } });
    expect(s.wires.some((w) => w.to === "lg" && w.toPort === "in2")).toBe(true);
    // An image pipe has no operand port to go to: refused.
    s = run(s, { type: "connect", wire: { from: "src", to: "lg", toPort: "in", kind: "image" } });
    expect(s.wires.some((w) => w.from === "src" && w.to === "lg")).toBe(false);
    // invert_mask keeps its historical "mask" landing (its registry
    // port is literally named that) and still refuses image pipes.
    s = run(s, { type: "add_node", node: makeNode(specFor("heeler.invert_mask")!, "inv", 0, 0) });
    s = run(s, { type: "connect", wire: { from: "lummask", to: "inv", toPort: "mask", kind: "mask" } });
    expect(s.wires.some((w) => w.to === "inv")).toBe(true);
    s = run(s, { type: "connect", wire: { from: "src", to: "inv", toPort: "in", kind: "image" } });
    expect(s.wires.some((w) => w.from === "src" && w.to === "inv")).toBe(false);
  });

  it("delete removes attached wires and undo restores them", () => {
    let s = run(initialState(), { type: "delete_nodes", ids: ["cbal"] });
    expect(s.nodes.some((n) => n.id === "cbal")).toBe(false);
    expect(s.wires.some((w) => w.from === "cbal" || w.to === "cbal")).toBe(false);
    s = run(s, { type: "undo" });
    expect(s.nodes.some((n) => n.id === "cbal")).toBe(true);
    expect(s.wires.filter((w) => w.from === "cbal" || w.to === "cbal").length).toBe(3);
  });

  it("group_selection collapses members, rewires boundary, adds preset", () => {
    let s = run(initialState(), { type: "select_nodes", ids: ["stdcolor", "cbal", "lummask"] });
    const nodesBefore = s.nodes.length;
    // Boundary rewired: whatever fed the first member now feeds the group,
    // and the group feeds whatever the last member did. Named by the
    // relationship rather than by node, since the chain between crop and
    // stdcolor keeps gaining nodes (a lens correction, then the Depth
    // Map's fixed seat) and this test should not care. Captured before
    // the collapse, since afterwards the feed is the group's.
    const fedStdcolor = s.wires.find((w) => w.to === "stdcolor" && w.kind === "image")!.from;
    s = run(s, { type: "group_selection", name: "Test Look" });
    expect(s.nodes.length).toBe(nodesBefore - 3 + 1);
    const group = s.nodes.find((n) => n.isGroup && n.name === "Test Look")!;
    expect(group).toBeTruthy();
    expect(group.groupNodes?.length).toBe(3);
    expect(s.wires.some((w) => w.from === fedStdcolor && w.to === group.id)).toBe(true);
    expect(s.wires.some((w) => w.from === group.id && w.to === "exposure")).toBe(true);
    // Preset browser gains the new entry at the top.
    expect(s.presets[0].name).toBe("Test Look");
    expect(s.presets[0].isNew).toBe(true);
  });

  it("a group carries the wiring between its members, not just the members", () => {
    let s = run(initialState(), { type: "select_nodes", ids: ["stdcolor", "detail", "cbal"] });
    s = run(s, { type: "group_selection", name: "Wired" });
    const group = s.nodes.find((n) => n.name === "Wired")!;
    // stdcolor -> detail -> cbal was inside the selection, so it lives on the group.
    expect(group.groupWires?.some((w) => w.from === "stdcolor" && w.to === "detail")).toBe(true);
    expect(group.groupWires?.some((w) => w.from === "detail" && w.to === "cbal")).toBe(true);
    // The wire that crossed the boundary does not: it was rewired to the group.
    expect(group.groupWires?.some((w) => w.to === "levels")).toBe(false);
  });

  it("a group renders as the chain inside it", () => {
    const plain = initialState();
    let grouped = run(plain, { type: "select_nodes", ids: ["stdcolor", "detail", "cbal"] });
    grouped = run(grouped, { type: "group_selection", name: "Same" });
    // The whole point of flattening: the engine cannot tell the two apart.
    // If it could, grouping would be an edit, and grouping is not an edit.
    const a = serializeGraph(plain);
    const b = serializeGraph(grouped);
    const ids = (g: any) => g.nodes.map((n: any) => n.id).sort();
    const links = (g: any) =>
      g.connections.map((c: any) => `${c.from}>${c.to}:${c.to_port ?? c.toPort}`).sort();
    expect(ids(b)).toEqual(ids(a));
    expect(links(b)).toEqual(links(a));
  });

  it("a bypassed group is stepped over, not run disabled", () => {
    let s = run(initialState(), { type: "select_nodes", ids: ["stdcolor", "cbal"] });
    s = run(s, { type: "group_selection", name: "Off" });
    const gid = s.nodes.find((n) => n.name === "Off")!.id;
    s = run(s, { type: "set_enabled", id: gid, enabled: false });
    const g = serializeGraph(s);
    expect(g.nodes.some((n: any) => n.id === "stdcolor")).toBe(false);
    expect(g.nodes.some((n: any) => n.id === gid)).toBe(false);
    // The chain closes over the gap: what fed the group now feeds what it
    // fed. The feed is the Color Checker's pass-through since 26.3
    // Phase 11 gave it the seat in front of Standard Color (the Depth
    // Map's pass-through, Phase 10, feeds the checker).
    expect(
      g.connections.some((c: any) => c.from[0] === "colorchecker" && c.to[0] === "exposure"),
    ).toBe(true);
  });

  it("an edit inside an open group lands on the group, not the graph", () => {
    let s = run(initialState(), { type: "select_nodes", ids: ["stdcolor", "cbal"] });
    s = run(s, { type: "group_selection", name: "Guts" });
    const gid = s.nodes.find((n) => n.name === "Guts")!.id;
    // stdcolor is inside the group, so it is not in the graph any more.
    expect(s.nodes.some((n) => n.id === "stdcolor")).toBe(false);

    s = run(s, { type: "open_group", id: gid });
    s = run(s, { type: "set_param", id: "stdcolor", param: "saturation", value: 30 });
    const g = s.nodes.find((n) => n.id === gid)!;
    expect(g.groupNodes!.find((n) => n.id === "stdcolor")!.params.saturation).toBe(30);
    // And the graph itself is untouched: the group is still one node.
    expect(s.nodes.some((n) => n.id === "stdcolor")).toBe(false);
  });

  it("undo inside a group puts the group back, not the graph", () => {
    let s = run(initialState(), { type: "select_nodes", ids: ["stdcolor", "cbal"] });
    s = run(s, { type: "group_selection", name: "Guts" });
    const gid = s.nodes.find((n) => n.name === "Guts")!.id;
    const graphBefore = s.nodes.length;
    const was = s.nodes
      .find((n) => n.id === gid)!
      .groupNodes!.find((n) => n.id === "stdcolor")!.params.saturation;
    s = run(s, { type: "open_group", id: gid });
    s = run(s, { type: "set_param", id: "stdcolor", param: "saturation", value: 30 });
    s = run(s, { type: "undo" });
    // The value goes back...
    const g = s.nodes.find((n) => n.id === gid)!;
    expect(g.groupNodes!.find((n) => n.id === "stdcolor")!.params.saturation).toBe(was);
    // ...and the graph is still the graph. An inner snapshot restored at the
    // outer level would have replaced every node with the group's two.
    expect(s.nodes.length).toBe(graphBefore);
    expect(s.nodes.some((n) => n.id === "output")).toBe(true);
  });

  it("what is edited inside a group is what the engine runs", () => {
    let s = run(initialState(), { type: "select_nodes", ids: ["stdcolor", "cbal"] });
    s = run(s, { type: "group_selection", name: "Guts" });
    const gid = s.nodes.find((n) => n.name === "Guts")!.id;
    s = run(s, { type: "open_group", id: gid });
    s = run(s, { type: "set_param", id: "stdcolor", param: "saturation", value: 30 });
    // Flattening is what closes the loop: going under the hood is pointless
    // if the engine never sees what you did there.
    const sent = serializeGraph(s).nodes.find((n: any) => n.id === "stdcolor");
    expect((sent?.params as Record<string, unknown>).saturation).toBe(30);
  });

  it("group_selection requires at least two nodes", () => {
    const s0 = run(initialState(), { type: "select_nodes", ids: ["cbal"] });
    const s = run(s0, { type: "group_selection", name: "X" });
    expect(s.nodes.length).toBe(s0.nodes.length);
  });

  it("the dialog's description lands on the group as its note", () => {
    let s = run(initialState(), { type: "select_nodes", ids: ["stdcolor", "cbal"] });
    s = run(s, { type: "group_selection", name: "Look", note: "  Warm skin.  " });
    const g = s.nodes.find((n) => n.name === "Look")!;
    expect(g.note).toBe("Warm skin.");
  });

  it("grouping keeps one boundary wire per outside source, not one per port", () => {
    // Two members, each masked by its own outside mask: the port is the
    // same on both, and grouping used to keep the first wire and
    // silently delete the second. flattenGroups already knows how to
    // send each wire home by its sender; it can only do that if the
    // wire still exists.
    let s = initialState();
    s = {
      ...s,
      wires: [
        { from: "lens", to: "stdcolor", toPort: "in", kind: "image" },
        { from: "cbal", to: "levels", toPort: "in", kind: "image" },
        { from: "lummask", to: "stdcolor", toPort: "mask", kind: "mask" },
        { from: "brushmask", to: "cbal", toPort: "mask", kind: "mask" },
      ],
    };
    s = run(s, { type: "select_nodes", ids: ["stdcolor", "cbal"] });
    s = run(s, { type: "group_selection", name: "Masked" });
    const gid = s.nodes.find((n) => n.name === "Masked")!.id;
    expect(s.wires.some((w) => w.from === "lummask" && w.to === gid)).toBe(true);
    expect(s.wires.some((w) => w.from === "brushmask" && w.to === gid)).toBe(true);
    // And each mask lands back on its own member once flattened.
    const g = serializeGraph(s);
    const links = g.connections.map((c: any) => `${c.from[0]}>${c.to[0]}`);
    expect(links).toContain("lummask>stdcolor");
    expect(links).toContain("brushmask>cbal");
  });

  it("layout and labels do not count as edits to the render", () => {
    // The render pump keys on renderVersion: moving a node across the
    // canvas, renaming it, tinting it or noting it must not buy a
    // re-render, and every real edit must buy exactly one.
    let s = initialState();
    const v0 = s.renderVersion;
    s = run(s, { type: "move_node", id: "cbal", x: 40, y: 90 });
    s = run(s, { type: "rename_node", id: "cbal", name: "Wheels" });
    s = run(s, { type: "set_node_tint", id: "cbal", tint: "#ff0000" });
    s = run(s, { type: "set_node_note", id: "cbal", note: "why" });
    expect(s.renderVersion).toBe(v0);
    s = run(s, { type: "set_param", id: "cbal", param: "shadows_hue", value: 12 });
    expect(s.renderVersion).toBe(v0 + 1);
    s = run(s, { type: "set_enabled", id: "cbal", enabled: false });
    expect(s.renderVersion).toBe(v0 + 2);
    s = run(s, {
      type: "add_stroke",
      id: "brushmask",
      stroke: { points: [[0.5, 0.5]], radius: 0.1 },
    });
    expect(s.renderVersion).toBe(v0 + 3);
    // Undo and redo move it too: the render changes when history does.
    s = run(s, { type: "undo" });
    expect(s.renderVersion).toBe(v0 + 4);
  });

  describe("culling", () => {
    // Rating a burst one frame at a time is the difference between a
    // usable cull and a chore, so a tag lands on the selection.
    it("a rating applies to the whole selection", async () => {
      const { taggingTargets } = await import("../state");
      let s = initialState();
      s = run(s, { type: "select_image", id: "4866" });
      s = run(s, { type: "select_image_range", id: "4869", range: true });
      expect(s.imageSelection.length).toBeGreaterThan(2);
      const targets = taggingTargets(s);
      s = run(s, { type: "set_rating", ids: targets, stars: 3 });
      for (const id of targets) {
        expect(s.images.find((i) => i.id === id)!.stars).toBe(3);
      }
      // The frames outside the run keep whatever they had.
      const before = initialState();
      for (const img of s.images.filter((i) => !targets.includes(i.id))) {
        expect(img.stars).toBe(before.images.find((b) => b.id === img.id)!.stars);
      }
    });

    it("with no selection a tag lands on the image on screen", async () => {
      const { taggingTargets } = await import("../state");
      let s = run(initialState(), { type: "select_image", id: "4871" });
      expect(taggingTargets(s)).toEqual(["4871"]);
      s = run(s, { type: "set_flag", ids: taggingTargets(s), flag: "pick" });
      expect(s.images.find((i) => i.id === "4871")!.flag).toBe("pick");
      expect(s.images.filter((i) => i.flag === "pick").length).toBeGreaterThan(0);
    });

    it("ratings are clamped rather than trusted", () => {
      let s = run(initialState(), { type: "set_rating", ids: ["4866"], stars: 99 });
      expect(s.images.find((i) => i.id === "4866")!.stars).toBe(5);
      s = run(s, { type: "set_rating", ids: ["4866"], stars: -3 });
      expect(s.images.find((i) => i.id === "4866")!.stars).toBe(0);
    });

    it("loading an empty folder clears the ribbon instead of ignoring it", () => {
      // The owner picked a folder whose photos all live in subfolders,
      // and the ribbon kept showing the previous folder as if the click
      // did nothing. An empty listing is still a listing.
      let s = run(initialState(), { type: "select_image", id: "4866" });
      s = run(s, { type: "load_images", images: [] });
      expect(s.images).toEqual([]);
      expect(s.activeImage).toBe("");
      expect(s.imageSelection).toEqual([]);
    });

    it("flags and ratings are independent", () => {
      let s = run(initialState(), { type: "set_rating", ids: ["4866"], stars: 4 });
      s = run(s, { type: "set_flag", ids: ["4866"], flag: "reject" });
      // A reject can still carry the rating it had: they answer
      // different questions and clearing one must not clear the other.
      expect(s.images.find((i) => i.id === "4866")).toMatchObject({ stars: 4, flag: "reject" });
      s = run(s, { type: "set_flag", ids: ["4866"], flag: "" });
      expect(s.images.find((i) => i.id === "4866")).toMatchObject({ stars: 4, flag: "" });
    });
  });

  describe("cropping a straightened photo", () => {
    /// The owner straightened a shot and then reached for the crop, and
    /// the preview un-rotated itself. The rotation was still in the
    /// adjustments, but the frame he was dragging a rectangle over was not
    /// the frame he was going to get.
    it("keeps the rotation while opening the crop rectangle", async () => {
      const { cropPreviewGraph } = await import("../state");
      let s = initialState();
      const crop = s.nodes.find((n) => n.type === "heeler.crop_rotate")!;
      s = run(
        s,
        { type: "set_params", id: crop.id, values: { angle: 3.4, crop_x: 0.2, crop_y: 0.1, crop_w: 0.5, crop_h: 0.6 } }
      );

      const preview = cropPreviewGraph(s).nodes.find((n) => n.type === "heeler.crop_rotate")!;
      // The rectangle opens up so the overlay has the whole picture to
      // sit on...
      expect(preview.params).toMatchObject({ crop_x: 0, crop_y: 0, crop_w: 1, crop_h: 1 });
      // ...and the straightening stays, because the empty wedges it
      // creates at the corners are the whole thing you are looking at
      // while you pull the crop in.
      expect(preview.params.angle).toBe(3.4);
    });

    /// Bypassing the node is the user's own decision and not something
    /// the crop tool gets to override.
    it("leaves the node's own bypass alone", async () => {
      const { cropPreviewGraph } = await import("../state");
      let s = initialState();
      const crop = s.nodes.find((n) => n.type === "heeler.crop_rotate")!;
      s = run(s, { type: "set_enabled", id: crop.id, enabled: false });
      const off = s.nodes.find((n) => n.id === crop.id)!.enabled;
      expect(cropPreviewGraph(s).nodes.find((n) => n.id === crop.id)!.enabled).toBe(off);
    });

    it("touches nothing else in the graph", async () => {
      const { cropPreviewGraph } = await import("../state");
      const s = initialState();
      const out = cropPreviewGraph(s);
      expect(out.wires).toBe(s.wires);
      for (const n of out.nodes) {
        if (n.type === "heeler.crop_rotate") continue;
        expect(n).toBe(s.nodes.find((o) => o.id === n.id));
      }
    });
  });

  it("rating and flag updates persist per image", () => {
    let s = run(initialState(), { type: "set_rating", ids: ["4866"], stars: 5 }, { type: "set_flag", ids: ["4866"], flag: "reject" });
    expect(s.images.find((i) => i.id === "4866")).toMatchObject({ stars: 5, flag: "reject" });
  });

  it("contract: every section has a summary and every row a tip", async () => {
    // "there needs to be more tool tips in the status line" -
    // section summaries on the name, a sentence on every slider. This
    // guard makes a NEW section or row without its help a failing test
    // rather than a silent gap.
    const { SECTIONS, SECTION_BLURBS, ROW_TIPS, SOURCE_ROWS } = await import("../ui/simple");
    for (const sec of SECTIONS) {
      expect(SECTION_BLURBS[sec.title], `${sec.title}: no summary`).toBeTruthy();
      for (const row of sec.rows) {
        expect(
          ROW_TIPS[`${sec.title}|${row.label}`],
          `${sec.title}/${row.label}: no tip`,
        ).toBeTruthy();
      }
    }
    // Source's dials are not rows; they are held to the same rule.
    for (const row of SOURCE_ROWS) {
      expect(ROW_TIPS[`Source|${row.label}`], `Source/${row.label}: no tip`).toBeTruthy();
    }
  });

  it("contract: every row tip names a row its section actually has", async () => {
    const { readFileSync } = await import("node:fs");
    const { resolve } = await import("node:path");
    // "Sharpening|Threshold" described the free-tier Unsharp's dial,
    // which that section does not have, and Color Bend and Skin
    // Softening carried tips for rows long renamed (the 2026-09-23
    // Sharpening review, fix 2 and R3): a tip nobody can hover is a
    // misfiled sentence. Every key names a section and one of its rows.
    // Source's rows are written by hand in the panel and read their
    // tips by key, so a tip the panel source reads by name is used.
    const src = readFileSync(resolve(process.cwd(), "src/ui/simple.tsx"), "utf8");
    const rows = new Set<string>();
    for (const s of SECTIONS) for (const r of s.rows) rows.add(`${s.title}|${r.label}`);
    for (const key of Object.keys(ROW_TIPS)) {
      const used = rows.has(key) || src.includes(`ROW_TIPS["${key}"]`);
      expect(used, `${key}: no such row`).toBe(true);
    }
    // And the Sharpening section's rows are all described.
    const sharp = SECTIONS.find((s) => s.title === "Sharpening")!;
    for (const r of sharp.rows) expect(ROW_TIPS[`Sharpening|${r.label}`], `Sharpening|${r.label} has no tip`).toBeTruthy();
  });

  it("contract: every Develop control maps to a real node param and serializes", () => {
    let s = initialState();
    // The off-by-default recipe categories have no nodes until they are
    // switched on, which is the point of them. Switch them on, and the
    // contract holds for their controls exactly as it does for the rest: the
    // owner's 1:1 rule does not get an exemption just because a category
    // builds itself lazily.
    for (const sec of SECTIONS) {
      if (sec.recipe) s = reduce(s, { type: "set_recipe", recipe: sec.recipe, on: true });
    }
    // Noise Reduction's Model rows show only while Model is the method:
    // the contract is checked on each row in the state that shows it.
    let sModel = reduce(s, { type: "set_denoise_method", model: true });
    for (const sec of SECTIONS) {
      for (const row of sec.rows) {
        const useModel = !!row.when && !row.when(s) && row.when(sModel);
        if (row.when && !row.when(s) && !useModel) continue;
        if (useModel) {
          const target = row.node?.(sModel) ?? sec.node(sModel);
          expect(target, `${sec.title}/${row.label}: no target node`).toBeTruthy();
          expect(PARAM_RANGE[row.param], `${sec.title}/${row.label}: param '${row.param}' missing from PARAM_RANGE`).toBeTruthy();
          const [lo, hi] = paramRange(row.param, target!.type);
          const probe = clampParam(row.param, lo + (hi - lo) * 0.77);
          sModel = reduce(sModel, { type: "set_param", id: target!.id, param: row.param, value: probe });
          const serialized = serializeGraph(sModel).nodes.find((n) => n.id === target!.id)!;
          expect((serialized.params as Record<string, unknown>)[row.param], `${sec.title}/${row.label}: '${row.param}' did not reach the serialized graph`).toBe(probe);
          continue;
        }
        const target = row.node?.(s) ?? sec.node(s);
        expect(target, `${sec.title}/${row.label}: no target node`).toBeTruthy();
        expect(PARAM_RANGE[row.param], `${sec.title}/${row.label}: param '${row.param}' missing from PARAM_RANGE`).toBeTruthy();
        // The range the CONTROL offers, which is the per-node one where a
        // node overrides it. A blur radius is in pixels while every other
        // radius in the app is a fraction of the frame, so probing with the
        // global range tested a value the reducer would rightly clamp.
        const [lo, hi] = paramRange(row.param, target!.type);
        const probe = clampParam(row.param, lo + (hi - lo) * 0.77);
        s = reduce(s, { type: "set_param", id: target!.id, param: row.param, value: probe });
        // A tool group (Sharpening, Skin Softening) flattens into its
        // members for the engine: the dial reaches the member its
        // published control names, under that member's own param.
        const after = s.nodes.find((n) => n.id === target!.id);
        if (after?.isGroup && after.tool) {
          const pt = publishedTarget(after, row.label)!;
          expect(pt, `${sec.title}/${row.label}: no published target`).toBeTruthy();
          const member = serializeGraph(s).nodes.find((n) => n.id === pt.node)!;
          expect(member, `${sec.title}/${row.label}: member ${pt.node} did not reach the serialized graph`).toBeTruthy();
          expect((member.params as Record<string, unknown>)[pt.param], `${sec.title}/${row.label}: '${pt.param}' did not reach ${pt.node}`).toBe(probe);
          continue;
        }
        const serialized = serializeGraph(s).nodes.find((n) => n.id === target!.id)!;
        expect(
          (serialized.params as Record<string, unknown>)[row.param],
          `${sec.title}/${row.label}: '${row.param}' did not reach the serialized graph`
        ).toBe(probe);
      }
    }
  });

  it("wheel hue/sat params serialize for the backend color balance", () => {
    let s = reduce(initialState(), {
      type: "set_params",
      id: "cbal",
      values: { midtones_hue: 90, midtones_sat: 40 },
    });
    const cbal = serializeGraph(s).nodes.find((n) => n.id === "cbal")!;
    expect((cbal.params as any).midtones_hue).toBe(90);
    expect((cbal.params as any).midtones_sat).toBe(40);
  });

  it("per-type ranges and defaults agree with the registry's scale", () => {
    // Each pair here was caught by the Adjustments audit wearing the
    // shared row's scale: the word is the same, the meaning is not.
    // Full-turn angles where the shared `angle` row is the crop tool's
    // +/-45 straightening nudge; a fresh Shadow's 135-degree default sat
    // off the end of its own slider.
    for (const t of [
      "heeler.gradient",
      "heeler.fx_gradient_overlay",
      "heeler.fx_shadow",
      "heeler.fx_bevel",
    ]) {
      expect(paramRange("angle", t), `${t} angle`).toEqual([-180, 180]);
    }
    // Fraction-scale amounts where the shared `amount` row is a percent:
    // on the 0..100 row any drag at or past 1 clamped to full in the
    // engine, which made the inspector's slider a binary switch.
    for (const t of ["heeler.desaturate", "heeler.invert"]) {
      expect(paramRange("amount", t), `${t} amount`).toEqual([0, 1]);
      expect(paramDefault("amount", t), `${t} amount default`).toBe(1);
    }
    // A 0..1 distance around the picked color, not the bend's
    // third-of-a-wheel reach.
    expect(paramRange("falloff", "heeler.color_range_mask")).toEqual([0, 1]);
    expect(paramDefault("falloff", "heeler.color_range_mask")).toBe(0.1);
    // CAT16's own span, not the white balance sliders' wider one.
    expect(paramRange("temperature", "heeler.chromatic_adapt")).toEqual([1667, 25000]);
  });

  it("detail weights are neutral at even, so a reset to 100 is not an edit", () => {
    // The Advanced weights sit at 100, not 0: "even" is their identity.
    // They belong in NEUTRAL_PARAMS so the places that ask "did this
    // node say something" (armed, previews, payload diffs) agree with
    // the Advanced panel's own badge, which counts a weight only when it
    // is off 100. The chain's own color node never exercises this (it
    // ships carrying the default look), but a bypassed copy's reset
    // writing 100s must not read as an arming edit.
    const identity = NEUTRAL_PARAMS["heeler.standard_color"];
    for (const e of ["texture", "clarity", "dehaze"]) {
      for (const w of ["shadows", "midtones", "highlights", "red", "green", "blue"]) {
        expect(identity[`${e}_${w}`], `${e}_${w}`).toBe(100);
      }
    }
  });

  /// The class behind two of the audit's findings, guarded rather than
  /// listed: every row the Adjustments panel renders is checked against
  /// the ENGINE's own registry, parsed out of spec.rs, so a param whose
  /// name this app happens to use twice cannot quietly inherit the other
  /// meaning's default again.
  ///
  /// This is the mirror of the Rust test that reads nodes.ts
  /// (the_node_palette_matches_the_engine_registry): each side checks
  /// the other, and neither is allowed to be the only witness.
  it("every panel row resets to what its node actually ships with", async () => {
    const { readFileSync } = await import("node:fs");
    const { resolve } = await import("node:path");
    // Same convention sliderguard.test.ts uses: vitest runs from the
    // app directory, and the repo's tsconfig deliberately carries no
    // @types/node beyond the two functions declared in node-shim.d.ts.
    const spec = readFileSync(
      resolve(process.cwd(), "../../crates/heeler-graph/src/spec.rs"),
      "utf8",
    );
    // num("name", default, min, max) inside each type_name block.
    const registry: Record<string, Record<string, number>> = {};
    for (const m of spec.matchAll(/type_name:\s*"([^"]+)"\.into\(\),(.*?)inputs:/gs)) {
      const [, type, body] = m;
      for (const pm of body.matchAll(/num\("(\w+)",\s*([-\d.]+),/g)) {
        (registry[type] ??= {})[pm[1]] = Number(pm[2]);
      }
    }
    // A parser that silently found nothing would pass this test while
    // checking air.
    expect(Object.keys(registry).length).toBeGreaterThan(40);

    // The deliberate deviations, each with its reason recorded where the
    // override lives (PARAM_DEFAULT_BY_TYPE in ui/simple.tsx).
    const deliberate = new Set([
      // The shipped look, not the registry's neutral zero.
      "heeler.tone_profile.baseline_ev",
      "heeler.tone_profile.shadow_toe",
      "heeler.tone_profile.highlight_rolloff",
      // Reset inside the B&W mixer means full strength, not "no longer
      // black and white".
      "heeler.black_white.amount",
    ]);

    const s = initialState();
    const wrong: string[] = [];
    for (const sec of SECTIONS) {
      for (const r of sec.rows) {
        const target = r.node?.(s) ?? sec.node(s);
        const shipped = target && registry[target.type]?.[r.param];
        if (!target || shipped === undefined) continue;
        if (deliberate.has(`${target.type}.${r.param}`)) continue;
        const reset = paramDefault(r.param, target.type);
        if (Math.abs(reset - shipped) > 1e-9) {
          wrong.push(`${sec.title}/${r.label} (${target.type}.${r.param}): resets to ${reset}, ships ${shipped}`);
        }
      }
    }
    expect(wrong, wrong.join("\n")).toEqual([]);
  });

  describe("layer tools", () => {
    /** Walks the image chain from the source and returns the ids in order,
     * which is how a splice that drops or orphans a node shows up. */
    function chain(s: State): string[] {
      const out: string[] = [];
      let cur: string | undefined = "src";
      const seen = new Set<string>();
      while (cur && !seen.has(cur)) {
        out.push(cur);
        seen.add(cur);
        cur = s.wires.find((w) => w.from === cur && w.kind === "image" && w.toPort !== "mask")?.to;
      }
      return out;
    }

    it("a Develop tool edits the active layer's own node, behind its mask", () => {
      let s = reduce(initialState(), { type: "add_layer", maskType: "range" });
      const globalBefore = s.nodes.find((n) => n.id === "curves")!;
      // A layer starts lean: only the mask and the exposure node.
      expect(s.nodes.some((n) => n.id === "layer_1_curves")).toBe(false);
      // toolNode hands the panel a stand-in so the control renders...
      expect(toolNode(s, "curves")!.id).toBe("layer_1_curves");

      // ...and writing to it splices the real node into the layer.
      s = reduce(s, { type: "set_curve", id: "layer_1_curves", channel: "luma", curve: [[0, 0], [0.5, 0.7], [1, 1]] });
      const made = s.nodes.find((n) => n.id === "layer_1_curves")!;
      expect(made.type).toBe("heeler.curves");
      expect(made.curves!.luma![1]).toEqual([0.5, 0.7]);
      // The mask feeds it, which is the whole point: the engine blends any
      // masked node back toward its input.
      expect(s.wires).toContainEqual({ from: "layer_1_mask", to: "layer_1_curves", toPort: "mask", kind: "mask" });
      // The global curve node is untouched, so the rest of the photo is not.
      expect(s.nodes.find((n) => n.id === "curves")!.curves).toEqual(globalBefore.curves);
      // Spliced in line, not dangling.
      expect(chain(s)).toContain("layer_1_curves");
      expect(chain(s)[chain(s).length - 1]).toBe("output");
      expect(chain(s).indexOf("layer_1_adj")).toBeLessThan(chain(s).indexOf("layer_1_curves"));
    });

    it("with no layer selected the same tool edits the global node", () => {
      const s = reduce(initialState(), { type: "set_curve", id: toolNode(initialState(), "curves")!.id, channel: "luma", curve: [[0, 0], [1, 1]] });
      expect(toolNode(s, "curves")!.id).toBe("curves");
      expect(s.nodes.some((n) => /^layer_\d+_curves$/.test(n.id))).toBe(false);
    });

    /// A curve pulled off the diagonal is an edit the user expects to
    /// SEE, so it arms a bypassed node the way a slider leaving zero
    /// does. The owner, from the pop-out: "Curves still doesn't work."
    it("bending a curve arms a bypassed curves node; an identity curve does not", () => {
      let s = initialState();
      s = { ...s, nodes: s.nodes.map((n) => (n.id === "curves" ? { ...n, enabled: false } : n)) };
      const identity = reduce(s, { type: "set_curve", id: "curves", channel: "rgb", curve: [[0, 0], [1, 1]] });
      expect(identity.nodes.find((n) => n.id === "curves")!.enabled).toBe(false);
      const bent = reduce(s, { type: "set_curve", id: "curves", channel: "rgb", curve: [[0, 0], [0.5, 0.8], [1, 1]] });
      expect(bent.nodes.find((n) => n.id === "curves")!.enabled).toBe(true);
    });

    it("undo takes a materialized tool back out of the graph", () => {
      let s = reduce(initialState(), { type: "add_layer", maskType: "radial" });
      const before = chain(s);
      s = reduce(s, { type: "set_param", id: "layer_1_levels", param: "gamma", value: 1.4 });
      expect(s.nodes.some((n) => n.id === "layer_1_levels")).toBe(true);
      s = reduce(s, { type: "undo" }); // the param change
      s = reduce(s, { type: "undo" }); // the splice
      expect(s.nodes.some((n) => n.id === "layer_1_levels")).toBe(false);
      expect(chain(s)).toEqual(before);
    });

    it("a no-op write does not conjure a layer tool", () => {
      let s = reduce(initialState(), { type: "add_layer", maskType: "range" });
      // What a section Reset sends: every row back to its default.
      s = reduce(s, { type: "set_param", id: "layer_1_levels", param: "gamma", value: 1 });
      s = reduce(s, { type: "set_params", id: "layer_1_split", values: { shadow_hue: 0, shadow_sat: 0 } });
      s = reduce(s, { type: "reset_curves", id: "layer_1_curves" });
      expect(s.nodes.filter((n) => n.id.startsWith("layer_1_")).map((n) => n.id).sort()).toEqual([
        "layer_1_adj",
        "layer_1_mask",
      ]);
      // A real change still brings the tool in.
      s = reduce(s, { type: "set_param", id: "layer_1_levels", param: "gamma", value: 1.3 });
      expect(s.nodes.some((n) => n.id === "layer_1_levels")).toBe(true);
    });

    it("a text write at the tool's own default does not conjure it either", () => {
      // Choosing Vivid on a layer whose sharpening copy does not exist
      // yet lands on the node's own default (PARAM_TEXT_DEFAULT says
      // vivid), so the click says nothing and the graph must stay
      // empty of it. Choosing Hi Pass says something.
      let s = reduce(initialState(), { type: "add_layer", maskType: "range" });
      s = reduce(s, { type: "set_text_param", id: "layer_1_sharpening", param: "mode", value: "vivid" });
      expect(s.nodes.some((n) => n.id === "layer_1_sharpening")).toBe(false);
      s = reduce(s, { type: "set_text_param", id: "layer_1_sharpening", param: "mode", value: "hipass" });
      const copy = s.nodes.find((n) => n.id === "layer_1_sharpening");
      expect(copy?.textParams?.mode).toBe("hipass");
      expect(s.wires.some((w) => w.from === "layer_1_mask" && w.to === "layer_1_sharpening")).toBe(true);
    });

    it("a second layer stacks after the first layer's whole chain", () => {
      let s = reduce(initialState(), { type: "add_layer", maskType: "range" });
      s = reduce(s, { type: "set_param", id: "layer_1_color", param: "saturation", value: 30 });
      s = reduce(s, { type: "add_layer", maskType: "radial" });
      const ids = chain(s);
      expect(ids.indexOf("layer_1_color")).toBeLessThan(ids.indexOf("layer_2_adj"));
      expect(ids[ids.length - 1]).toBe("output");
    });

    it("removing a layer takes its whole group and heals the chain", () => {
      const s0 = initialState();
      let s = reduce(s0, { type: "add_layer", maskType: "range" });
      s = reduce(s, { type: "set_param", id: "layer_1_color", param: "vibrance", value: 20 });
      s = reduce(s, { type: "set_param", id: "layer_1_levels", param: "black", value: 0.1 });
      s = reduce(s, { type: "remove_layer", id: "layer_1_adj" });
      expect(s.nodes.some((n) => n.id.startsWith("layer_1_"))).toBe(false);
      expect(s.wires.some((w) => w.from.startsWith("layer_1_") || w.to.startsWith("layer_1_"))).toBe(false);
      expect(chain(s)).toEqual(chain(s0));
    });

    it("duplicating a layer copies every tool it had", () => {
      let s = reduce(initialState(), { type: "add_layer", maskType: "range" });
      s = reduce(s, { type: "set_param", id: "layer_1_color", param: "saturation", value: 44 });
      s = reduce(s, { type: "duplicate_layer", id: "layer_1_adj" });
      expect(s.nodes.find((n) => n.id === "layer_2_color")!.params.saturation).toBe(44);
      expect(s.wires).toContainEqual({ from: "layer_2_mask", to: "layer_2_color", toPort: "mask", kind: "mask" });
      const ids = chain(s);
      expect(ids.indexOf("layer_1_color")).toBeLessThan(ids.indexOf("layer_2_adj"));
      expect(ids).toContain("layer_2_color");
      expect(ids[ids.length - 1]).toBe("output");
    });

    it("every layer-scoped section resolves to a node inside the layer", () => {
      const s = reduce(initialState(), { type: "add_layer", maskType: "range" });
      for (const sec of SECTIONS.filter((x) => x.layerTool)) {
        const target = sec.node(s)!;
        expect(target, `${sec.title}: no target`).toBeTruthy();
        expect(target.id, `${sec.title} escaped the layer`).toMatch(/^layer_1_/);
      }
      // ...and the global-only ones stay global. A recipe category that
      // has never been switched on has no node yet, which is the whole
      // point of it, so there is nothing to be global.
      for (const sec of SECTIONS.filter((x) => !x.layerTool)) {
        const target = sec.node(s);
        if (!target) {
          expect(sec.recipe, `${sec.title}: no node and not a recipe`).toBeTruthy();
          continue;
        }
        expect(target.id, `${sec.title} should be global`).not.toMatch(/^layer_\d+_/);
      }
    });
  });

  it("contract: a section's switch bypasses every node its controls write to", () => {
    // Detail's Unsharp and Smoothing live on their own nodes, and
    // Tone hosts the curve editor. A switch that only reached its own
    // node left those still applied, which reads as a dead toggle.
    const s = initialState();
    for (const sec of SECTIONS) {
      if (sec.hideToggle) continue;
      // A recipe's switch splices its subgraph in and out rather than
      // flipping enabled flags, and its own tests cover that.
      if (sec.recipe) continue;
      const own = sec.node(s);
      if (!own) continue;
      const toggled = new Set(
        [own, ...(sec.alsoToggles?.(s) ?? [])].filter(Boolean).map((n) => n!.id)
      );
      for (const row of sec.rows) {
        const target = row.node?.(s) ?? own;
        expect(
          toggled.has(target.id),
          `${sec.title} writes to ${target.id} but its switch does not bypass it`
        ).toBe(true);
      }
    }
    // The editors a section hosts are not rows, so name them directly.
    const covers = (title: string, id: string) =>
      new Set((SECTIONS.find((x) => x.title === title)!.alsoToggles?.(s) ?? []).map((n) => n?.id)).has(id);
    // Curves is its own section now; the curve node IS the section's
    // node rather than a guest of Tone's.
    expect(
      SECTIONS.find((x) => x.title === "Curves")!.node(s)?.id,
      "the Curves section is the curve",
    ).toBe("curves");
    expect(
      SECTIONS.find((x) => x.title === "Levels")!.node(s)?.id,
      "Levels has its own section",
    ).toBe("levels");
    expect(covers("Color", "bw"), "Color hosts the B&W treatment").toBe(true);
  });

  it("a section switch disables its hosted nodes too", () => {
    let s = initialState();
    const detail = SECTIONS.find((x) => x.title === "Detail")!;
    for (const n of [detail.node(s)!, ...(detail.alsoToggles!(s) as NodeCard[])]) {
      s = reduce(s, { type: "set_enabled", id: n.id, enabled: false });
    }
    for (const id of ["detail", "sharpen", "denoise"]) {
      expect(s.nodes.find((n) => n.id === id)!.enabled, `${id} should be bypassed`).toBe(false);
    }
  });

  it("a graph saved before Bend existed stays without it on load: the switch builds it", async () => {
    // "These are off by default and that also means don't add
    // them to the graph unless enabled." A load used to splice every
    // missing on-demand section in bypassed, which put five dead cards in
    // every graph and, worse, put them BACK after Reset: the clean graph
    // was autosaved, and the next visit re-spliced them.
    const { migrateGraph } = await import("../state");
    let s = initialState();
    s = { ...s, nodes: structuredClone(NEUTRAL_NODES), wires: structuredClone(NEUTRAL_WIRES) };
    // An older save: everything except the bend node, which the neutral
    // graph never carried anyway.
    const out = migrateGraph(s.nodes, s.wires);
    expect(out.nodes.find((n) => n.type === "heeler.color_bend")).toBeUndefined();
    expect(out.nodes.map((n) => n.id)).toEqual(s.nodes.map((n) => n.id));
    expect(out.wires).toEqual(s.wires);
    // The section's switch is what builds it, at identity, in the chain.
    s = run({ ...s, nodes: out.nodes, wires: out.wires }, { type: "set_category", title: "Color Bend", on: true });
    const bend = s.nodes.find((n) => n.type === "heeler.color_bend")!;
    expect(bend).toBeTruthy();
    expect(bend.params.src_hue).toBe(bend.params.dst_hue);
    expect(bend.params.src_sat).toBe(bend.params.dst_sat);
    expect(s.wires.some((w) => w.to === bend.id && w.kind === "image")).toBe(true);
    expect(s.wires.some((w) => w.from === bend.id)).toBe(true);
    const output = s.nodes.find((n) => n.type === "heeler.output")!;
    expect(s.wires.filter((w) => w.to === output.id)).toHaveLength(1);
  });

  it("a load strips the bypassed identity cards the old backfill left behind", async () => {
    // Graphs already on disk carry the five, because every load before
    // this wrote them. Turning a section on and straight off again
    // leaves exactly the card the backfill used to write, so that is
    // the shape to build here.
    const { migrateGraph } = await import("../state");
    let s = initialState();
    s = { ...s, nodes: structuredClone(NEUTRAL_NODES), wires: structuredClone(NEUTRAL_WIRES) };
    for (const title of ["Lens", "Relight", "Color Bend", "Recolor", "Color Tune"]) {
      s = run(s, { type: "set_category", title, on: true }, { type: "set_category", title, on: false });
    }
    const dark = ["lens", "toneeq", "bend", "recolor", "colorconsole"];
    for (const id of dark) expect(s.nodes.find((n) => n.id === id)!.enabled).toBe(false);

    const out = migrateGraph(s.nodes, s.wires);
    for (const id of dark) expect(out.nodes.find((n) => n.id === id), `${id} should be gone`).toBeUndefined();
    // The chain closed over every gap: same nodes and wires as a graph
    // that never had them (as sets: healing a gap appends the wire).
    const wireSet = (ws: { from: string; to: string; toPort?: string; kind: string }[]) =>
      ws.map((w) => `${w.from}>${w.to}:${w.toPort ?? "in"}:${w.kind}`).sort();
    expect(out.nodes.map((n) => n.id)).toEqual(NEUTRAL_NODES.map((n) => n.id));
    expect(wireSet(out.wires)).toEqual(wireSet(NEUTRAL_WIRES));
    // Idempotent: a clean graph stays clean.
    const twice = migrateGraph(out.nodes, out.wires);
    expect(twice.nodes.map((n) => n.id)).toEqual(out.nodes.map((n) => n.id));
    expect(twice.wires).toEqual(out.wires);
  });

  it("a load keeps a bypassed section somebody actually set", async () => {
    // "Once on and turned back off preserve the nodes just
    // disable them." The cleanup only recognizes the backfill's exact
    // identity; a moved dial, a chosen model, or a wired mask is work, and
    // stays.
    const { migrateGraph } = await import("../state");
    let s = initialState();
    s = { ...s, nodes: structuredClone(NEUTRAL_NODES), wires: structuredClone(NEUTRAL_WIRES) };
    s = run(
      s,
      { type: "set_category", title: "Relight", on: true },
      { type: "set_param", id: "toneeq", param: "ev_0", value: 0.5 },
      { type: "set_category", title: "Relight", on: false },
      { type: "set_category", title: "Lens", on: true },
      { type: "set_text_param", id: "lens", param: "dist_model", value: "poly3" },
      { type: "set_category", title: "Lens", on: false },
    );
    const out = migrateGraph(s.nodes, s.wires);
    const toneeq = out.nodes.find((n) => n.id === "toneeq")!;
    expect(toneeq).toBeTruthy();
    expect(toneeq.enabled).toBe(false);
    expect(toneeq.params.ev_0).toBe(0.5);
    const lens = out.nodes.find((n) => n.id === "lens")!;
    expect(lens).toBeTruthy();
    expect(lens.textParams?.dist_model).toBe("poly3");
    expect(out.wires).toEqual(s.wires);
  });

  it("a saved 26.2 graph loads with the Depth Map at its seat and its consumers wired (26.3 Phase 10.4)", async () => {
    // 26.2 spliced the Depth Map after Grain, so with tonal nodes in
    // the graph it sat behind them, and Fog read the plane from the
    // planted slot: no wire anywhere. The loader moves the node to its
    // fixed seat (after geometry, before anything tonal) and wires the
    // consumers that were asking.
    const { migrateGraph } = await import("../state");
    const card = (id: string, type: string, params: Record<string, number> = {}): NodeCard => ({
      id, type, name: id, cat: "color", x: 0, y: 0, enabled: true, params, hasIn: true, hasOut: true,
    });
    const nodes: NodeCard[] = [
      card("src", "heeler.image_source"),
      card("crop", "heeler.crop_rotate", { crop_x: 0.25, crop_y: 0.25, crop_w: 0.5, crop_h: 0.5 }),
      card("exposure", "heeler.exposure", { exposure: 40 }),
      card("depthmap", "heeler.depth_map", { edges: 25 }),
      card("fog", "heeler.fog", { density: 40 }),
      card("output", "heeler.output"),
    ];
    const wires: Wire[] = [
      { from: "src", to: "crop", toPort: "in", kind: "image" },
      { from: "crop", to: "exposure", toPort: "in", kind: "image" },
      { from: "exposure", to: "depthmap", toPort: "in", kind: "image" },
      { from: "depthmap", to: "fog", toPort: "in", kind: "image" },
      { from: "fog", to: "output", toPort: "in", kind: "image" },
    ];
    const out = migrateGraph(nodes, wires);
    // Re-seated: the crop feeds the Depth Map, the Depth Map feeds the
    // first tonal node.
    const feeds = (id: string) => out.wires.find((w) => w.from === id && w.kind === "image")?.to;
    expect(feeds("crop")).toBe("depthmap");
    expect(feeds("depthmap")).toBe("exposure");
    expect(feeds("exposure")).toBe("fog");
    expect(feeds("fog")).toBe("output");
    // Fog was asking for the plane the whole time; now the wire says so.
    expect(
      out.wires.some((w) => w.from === "depthmap" && w.fromPort === "depth" && w.to === "fog" && w.toPort === "depth"),
      "the consumer gets the wire the planted slot used to answer",
    ).toBe(true);
    // Nothing else moved, and a second load is a no-op.
    const twice = migrateGraph(out.nodes, out.wires);
    expect(twice.nodes.map((n) => n.id)).toEqual(out.nodes.map((n) => n.id));
    expect(twice.wires).toEqual(out.wires);
  });

  it("a Depth Map already at its seat loads untouched, depth wires and all", async () => {
    // The pass runs on every load, so the 26.3 shape must round-trip
    // bit for bit: no re-splice churn, no second depth wire.
    const { migrateGraph } = await import("../state");
    const card = (id: string, type: string, params: Record<string, number> = {}): NodeCard => ({
      id, type, name: id, cat: "color", x: 0, y: 0, enabled: true, params, hasIn: true, hasOut: true,
    });
    const nodes: NodeCard[] = [
      card("src", "heeler.image_source"),
      card("crop", "heeler.crop_rotate"),
      card("depthmap", "heeler.depth_map", { edges: 25 }),
      card("exposure", "heeler.exposure", { exposure: 40 }),
      card("fog", "heeler.fog", { density: 40 }),
      card("output", "heeler.output"),
    ];
    const wires: Wire[] = [
      { from: "src", to: "crop", toPort: "in", kind: "image" },
      { from: "crop", to: "depthmap", toPort: "in", kind: "image" },
      { from: "depthmap", to: "exposure", toPort: "in", kind: "image" },
      { from: "exposure", to: "fog", toPort: "in", kind: "image" },
      { from: "fog", to: "output", toPort: "in", kind: "image" },
      { from: "depthmap", fromPort: "depth", to: "fog", toPort: "depth", kind: "mask" },
    ];
    const out = migrateGraph(nodes, wires);
    expect(out.wires).toEqual(wires);
    expect(out.wires.filter((w) => w.toPort === "depth")).toHaveLength(1);
  });

  it("reset, autosave, come back: the on-demand sections stay gone", () => {
    // "I did a reset edits and those disabled nodes disappear...
    // until I click on a different image then come back to the one I just
    // reset, and those disabled nodes come back." The round trip is
    // reset_image_edits, then replace_graph with what autosave wrote.
    let s = initialState();
    s = run(
      s,
      { type: "set_category", title: "Relight", on: true },
      { type: "set_category", title: "Lens", on: true },
      { type: "reset_image_edits", id: s.activeImage },
    );
    const saved = { nodes: structuredClone(s.nodes), wires: structuredClone(s.wires) };
    s = run(s, { type: "select_image", id: "4869" }, { type: "select_image", id: "4871" });
    s = run(s, { type: "replace_graph", nodes: saved.nodes, wires: saved.wires });
    for (const id of ["lens", "toneeq", "bend", "recolor", "colorconsole"]) {
      expect(s.nodes.find((n) => n.id === id), `${id} came back after reset`).toBeUndefined();
    }
    expect(s.nodes.map((n) => n.id)).toEqual(NEUTRAL_NODES.map((n) => n.id));
  });

  it("contract: loading a graph never removes anything the user made", async () => {
    const { migrateGraph } = await import("../state");
    // A real working graph: layers, masks, wires, a section switched on
    // and used, another switched on and off again with a dial moved.
    let s = initialState();
    s = { ...s, nodes: structuredClone(NEUTRAL_NODES), wires: structuredClone(NEUTRAL_WIRES) };
    s = reduce(s, { type: "add_layer", maskType: "range" });
    s = reduce(s, { type: "set_param", id: "layer_1_mask", param: "luma_low", value: 0.4 });
    s = reduce(s, { type: "set_param", id: "layer_1_adj", param: "exposure", value: 0.8 });
    s = reduce(s, { type: "add_layer", maskType: "radial" });
    s = reduce(s, { type: "set_category", title: "Color Bend", on: true });
    s = reduce(s, { type: "set_param", id: "bend", param: "dst_hue", value: 90 });
    s = reduce(s, { type: "set_category", title: "Relight", on: true });
    s = reduce(s, { type: "set_param", id: "toneeq", param: "ev_m2", value: 1 });
    s = reduce(s, { type: "set_category", title: "Relight", on: false });
    const saved = { nodes: s.nodes, wires: s.wires };

    const out = migrateGraph(saved.nodes, saved.wires);
    // Every node survives, with its params intact. A migration that
    // quietly drops a layer costs somebody an afternoon's work.
    for (const before of saved.nodes) {
      const after = out.nodes.find((n) => n.id === before.id);
      expect(after, `${before.id} disappeared during load`).toBeTruthy();
      // Superset, not equality: the contract is that nothing the user
      // made is REMOVED. Backfilling a newly shipped parameter at its
      // neutral value (the NEUTRAL_PARAMS mechanism) is the load doing
      // its job, not the load losing something.
      expect(after!.params, `${before.id} lost params`).toMatchObject(before.params);
      expect(after!.enabled).toBe(before.enabled);
    }
    // Both layers still derive, masks and all.
    expect(layersOf({ ...s, nodes: out.nodes } as State).map((l) => l.id)).toEqual([
      "layer_1_adj",
      "layer_2_adj",
    ]);
    // Every wire survives: a load no longer re-routes anything to make
    // room for a section nobody asked for.
    const lost = saved.wires.filter(
      (w) => !out.wires.some((o) => o.from === w.from && o.to === w.to && o.toPort === w.toPort)
    );
    expect(lost).toHaveLength(0);
  });

  it("a bend saved with the old param name keeps its strength", async () => {
    const { migrateNodes } = await import("../state");
    // The pull was briefly called `strength`, which the engine now
    // ignores: the tool would render as if untouched.
    const out = migrateNodes([
      { id: "bend", type: "heeler.color_bend", name: "Color Bend", cat: "color", x: 0, y: 0, enabled: true,
        params: { src_hue: 10, dst_hue: 90, strength: 60 } } as NodeCard,
    ]);
    expect(out[0].params.amount).toBe(60);
    expect(out[0].params.strength).toBeUndefined();
    expect(out[0].params.dst_hue).toBe(90);
  });

  it("an untouched bend opens up, a configured one is left alone", async () => {
    const { migrateNodes } = await import("../state");
    const bend = (params: Record<string, number>) =>
      migrateNodes([
        { id: "bend", type: "heeler.color_bend", name: "Color Bend", cat: "color", x: 0, y: 0, enabled: true, params } as NodeCard,
      ])[0].params;

    // Exactly the old shipped defaults: nobody configured this, and as
    // shipped it sat in empty space where the target did nothing.
    const { BEND_FALLOFF_DEFAULT } = await import("../state");
    const opened = bend({ src_hue: 0, src_sat: 0.5, dst_hue: 0, dst_sat: 0.5, falloff: 0.35, amount: 100 });
    expect(opened.src_sat).toBe(0);
    expect(opened.falloff).toBe(BEND_FALLOFF_DEFAULT);

    // Someone's actual work, matching the old defaults in every way but
    // one. Left exactly as they set it.
    const mine = { src_hue: 0, src_sat: 0.5, dst_hue: 40, dst_sat: 0.5, falloff: 0.35, amount: 100 };
    expect(bend(mine)).toEqual(mine);
    const narrowed = { src_hue: 0, src_sat: 0.5, dst_hue: 0, dst_sat: 0.5, falloff: 0.6, amount: 100 };
    expect(bend(narrowed)).toEqual(narrowed);
  });

  it("contract: a section Reset restores every row to its neutral value", () => {
    // Reset writes paramDefault(param, nodeType). For a param whose neutral
    // value is 100, a missing entry means Reset writes 0 and silently
    // switches the tool off. That is exactly how Bend died: Reset set
    // its Amount to 0 and every later drag did nothing.
    const s = initialState();
    const neutral = NEUTRAL_NODES;
    const wrong: string[] = [];
    for (const sec of SECTIONS) {
      for (const row of sec.rows) {
        const target = row.node?.(s) ?? sec.node(s);
        if (!target) continue;
        // What Reset would write, against what a freshly opened photo
        // actually starts from. Checking it is merely inside the range
        // is too weak: 0 sits inside Amount's 0..100 and still means
        // off.
        // The per-node answer, which is what Reset actually writes: the
        // same name means different things on different nodes. `amount` is
        // 100 on a bend, because a bend at zero does nothing, and 0 on an
        // unsharp mask, because photographs do not arrive sharpened.
        const resets = paramDefault(row.param, target.type);
        // NEUTRAL_NODES, not initialState: the latter is the demo
        // session, which ships with an edit already applied.
        const fresh = neutral.find((n) => n.id === target.id)?.params[row.param];
        if (fresh !== undefined && resets !== fresh) {
          wrong.push(`${sec.title}/${row.label}: Reset writes ${resets}, a new photo starts at ${fresh}`);
        }
      }
    }
    expect(wrong).toEqual([]);
  });

  it("repairs a bend that a Reset switched off", async () => {
    const { migrateNodes } = await import("../state");
    const bend = (params: Record<string, number>) =>
      migrateNodes([
        { id: "bend", type: "heeler.color_bend", name: "Color Bend", cat: "color", x: 0, y: 0, enabled: true, params } as NodeCard,
      ])[0].params;

    // What Reset left behind: a configured bend with its pull at zero,
    // which renders as if the node were not there.
    const killed = bend({ src_hue: 0, src_sat: 0, dst_hue: 200, dst_sat: 0.6, falloff: 0.39, amount: 0 });
    expect(killed.amount).toBe(100);
    // The bend itself is preserved: this repairs the switch, not the work.
    expect(killed.dst_hue).toBe(200);
    expect(killed.falloff).toBe(0.39);
    // A reach reset under the floor is unusable too.
    const { BEND_FALLOFF_DEFAULT } = await import("../state");
    expect(bend({ src_hue: 0, dst_hue: 90, falloff: 0, amount: 100 }).falloff).toBe(
      BEND_FALLOFF_DEFAULT,
    );
  });

  it("every way of getting a bend agrees on how far it reaches", async () => {
    /// "How is it when I RESET BLEND the falloff goes to
    /// 0.33... but when I first see Blend the falloff is 1.0? That
    /// inconsistency is annoying."
    ///
    /// It was mine. Reset read the constant; the three tables that
    /// CREATE the node had the old number typed into them, so a photo
    /// edited before Bend existed got a wheel whose reach ring sat
    /// exactly on the wheel's own edge, which is the confusion the
    /// constant was introduced to fix in the first place.
    const { BEND_FALLOFF_DEFAULT, migrateGraph, migrateNodes } = await import("../state");
    const { PARAM_DEFAULT } = await import("../ui/simple");
    const s = initialState();

    // The bend in a fresh session.
    expect(s.nodes.find((n) => n.type === "heeler.color_bend")!.params.falloff).toBe(
      BEND_FALLOFF_DEFAULT,
    );
    // What Reset writes.
    expect(PARAM_DEFAULT.falloff).toBe(BEND_FALLOFF_DEFAULT);
    // And the one the section's switch builds into a graph that never
    // had one, which is the door every photo's bend comes through now
    // (a load no longer splices one in).
    const without = { ...s, nodes: structuredClone(NEUTRAL_NODES), wires: structuredClone(NEUTRAL_WIRES) };
    expect(without.nodes.find((n) => n.type === "heeler.color_bend")).toBeUndefined();
    const built = reduce(without, { type: "set_category", title: "Color Bend", on: true });
    const late = built.nodes.find((n) => n.type === "heeler.color_bend");
    expect(late, "the switch should build a bend").toBeTruthy();
    expect(late!.params.falloff).toBe(BEND_FALLOFF_DEFAULT);
    // Nothing anywhere still reaches the whole wheel by default: a
    // loaded graph keeps the reach it was built with. Bent first,
    // because an unbent bend is off (migrateOne), and an off, untouched
    // section is one a load takes back out.
    const bent = reduce(built, { type: "set_param", id: "bend", param: "dst_hue", value: 90 });
    const loaded = migrateGraph(bent.nodes, bent.wires);
    expect(migrateNodes(loaded.nodes).find((n) => n.type === "heeler.color_bend")!.params.falloff)
      .toBe(BEND_FALLOFF_DEFAULT);
  });

  it("repairs a whole-wheel reach only where it is reaching around nothing", async () => {
    // Photos edited while the old number was still written into the
    // creation tables carry falloff 1 on disk, so fixing the tables does
    // not fix them. A node with no bend on it can be corrected safely:
    // the reach reaches around nothing and moves no pixel either way.
    const { BEND_FALLOFF_DEFAULT, migrateNodes } = await import("../state");
    const bend = (params: Record<string, number>) =>
      migrateNodes([
        { id: "bend", type: "heeler.color_bend", name: "Color Bend", cat: "color", x: 0, y: 0, enabled: true, params } as NodeCard,
      ])[0].params;

    const fresh = bend({ src_hue: 0, src_sat: 0, dst_hue: 0, dst_sat: 0, falloff: 1, amount: 100 });
    expect(fresh.falloff).toBe(BEND_FALLOFF_DEFAULT);

    // But somebody's actual bend keeps the reach they gave it, whatever it
    // is. "it'd be advisable that we don't mess with their
    // edit."
    const mine = { src_hue: 30, src_sat: 0.4, dst_hue: 200, dst_sat: 0.6, falloff: 1, amount: 100 };
    expect(bend(mine).falloff).toBe(1);
    const sat = { src_hue: 0, src_sat: 0, dst_hue: 0, dst_sat: 0.5, falloff: 1, amount: 100 };
    expect(bend(sat).falloff).toBe(1);
  });

  describe("picking frames to stack", () => {
    const ids = (s: State) => s.imageSelection;

    it("click replaces, ctrl adds, shift takes the span", () => {
      let s = initialState();
      const all = s.images.map((i) => i.id);
      s = reduce(s, { type: "select_image_range", id: all[1] });
      expect(ids(s)).toEqual([all[1]]);
      expect(s.activeImage).toBe(all[1]);

      s = reduce(s, { type: "select_image_range", id: all[3], additive: true });
      expect(ids(s)).toEqual([all[1], all[3]]);
      // Ctrl on a selected frame removes it again.
      s = reduce(s, { type: "select_image_range", id: all[1], additive: true });
      expect(ids(s)).toEqual([all[3]]);

      // Shift spans from the active image, in ribbon order, whichever
      // direction you drag.
      s = reduce(s, { type: "select_image_range", id: all[0], range: true });
      expect(ids(s)).toEqual([all[0], all[1], all[2], all[3]]);
    });

    it("the selection never empties and always holds the active photo", () => {
      let s = initialState();
      const all = s.images.map((i) => i.id);
      s = reduce(s, { type: "select_image_range", id: all[2] });
      // Ctrl-clicking the only selected frame would otherwise leave the
      // viewer showing a photo that is not selected.
      s = reduce(s, { type: "select_image_range", id: all[2], additive: true });
      expect(ids(s)).toEqual([all[2]]);
      expect(ids(s)).toContain(s.activeImage);

      // And picking a single photo anywhere else collapses the set, so a
      // stale selection cannot make Photo actions hit the wrong frames.
      s = reduce(s, { type: "select_image_range", id: all[0], additive: true });
      expect(ids(s)).toHaveLength(2);
      s = reduce(s, { type: "select_image", id: all[4] });
      expect(ids(s)).toEqual([all[4]]);
    });

    it("a finished stack lands beside its frames and becomes active", () => {
      let s = initialState();
      const before = s.images.length;
      s = reduce(s, {
        type: "add_stack_image",
        image: { id: "stk_1", name: "HDR_a-c.stack", stars: 0, flag: "", edited: false, filter: "none", src: "" },
      });
      expect(s.images).toHaveLength(before + 1);
      expect(s.activeImage).toBe("stk_1");
      expect(ids(s)).toEqual(["stk_1"]);
      // Sorted in by name rather than appended, so it sits with the
      // frames it came from.
      const names = s.images.map((i) => i.name);
      expect(names).toEqual([...names].sort((a, b) => a.localeCompare(b)));
    });
  });

  it("bend ships bypassed and arms itself when you actually bend something", async () => {
    const { migrateNodes } = await import("../state");
    // Every photo would otherwise show a Bend switch reading on for an
    // edit nobody made.
    let s = initialState();
    expect(s.nodes.find((n) => n.id === "bend")!.enabled).toBe(false);

    // Reach and amount alone do nothing, so they leave it off.
    s = reduce(s, { type: "set_param", id: "bend", param: "falloff", value: 0.6 });
    expect(s.nodes.find((n) => n.id === "bend")!.enabled).toBe(false);

    // Moving the target is a bend, so the node switches itself on rather
    // than swallowing the drag.
    s = reduce(s, { type: "set_params", id: "bend", values: { dst_hue: 120, dst_sat: 0.5 } });
    expect(s.nodes.find((n) => n.id === "bend")!.enabled).toBe(true);

    // Loading an older graph: an unbent node goes quiet, a bent one is
    // left exactly as the user had it.
    const node = (params: Record<string, number>, enabled: boolean) =>
      ({ id: "bend", type: "heeler.color_bend", name: "Color Bend", cat: "color", x: 0, y: 0, enabled, params }) as NodeCard;
    expect(migrateNodes([node({ src_hue: 0, dst_hue: 0, src_sat: 0, dst_sat: 0 }, true)])[0].enabled).toBe(false);
    expect(migrateNodes([node({ src_hue: 0, dst_hue: 90, src_sat: 0, dst_sat: 0.4 }, true)])[0].enabled).toBe(true);
  });

  it("the stacks filter finds merges among a folder of frames", async () => {
    const { visibleImages, isStack } = await import("../state");
    let s = initialState();
    s = reduce(s, {
      type: "add_stack_image",
      image: { id: "stk", name: "HDR_a-c.heelerstack", stars: 0, flag: "", edited: false, filter: "none", src: "" },
    });
    expect(visibleImages(s).length).toBeGreaterThan(1);
    s = reduce(s, { type: "toggle_filter_stacks" });
    // A merge is told apart by its manifest extension: that is what it
    // is, so nothing extra has to be tracked to find it again.
    expect(visibleImages(s).map((i) => i.id)).toEqual(["stk"]);
    expect(isStack({ name: "P1032357.RW2" })).toBe(false);
    expect(isStack({ name: "HDR_x.HEELERSTACK" })).toBe(true);
  });

  it("the merged filter finds panoramas as well as stacks", async () => {
    const { visibleImages, isPano, isStack, isComposite } = await import("../state");
    let s = initialState();
    s = reduce(s, {
      type: "add_stack_image",
      image: { id: "pan", name: "PANO_a-c.pano", stars: 0, flag: "", edited: false, filter: "none", src: "" },
    });
    s = reduce(s, { type: "toggle_filter_stacks" });
    // Both are recipes Heeler assembled rather than files off a card,
    // and both are what you go looking for after making one.
    expect(visibleImages(s).map((i) => i.id)).toEqual(["pan"]);
    expect(isPano({ name: "PANO_x.PANO" })).toBe(true);
    expect(isPano({ name: "HDR_x.stack" })).toBe(false);
    expect(isStack({ name: "PANO_x.pano" })).toBe(false);
    expect(isComposite({ name: "PANO_x.pano" })).toBe(true);
    expect(isComposite({ name: "HDR_x.stack" })).toBe(true);
    expect(isComposite({ name: "P1032357.RW2" })).toBe(false);
  });

  it("flag params serialize as booleans, not numbers", () => {
    // The engine declares invert with flag(), so a numeric 0/1 makes the
    // registry reject the entire graph and no preview renders.
    let s = reduce(initialState(), { type: "add_layer", maskType: "range" });
    const maskId = layersOf(s)[0].maskId;
    const flagOf = (st: State) =>
      (serializeGraph(st).nodes.find((n) => n.id === maskId)!.params as Record<string, unknown>).invert;
    // Untouched, the flag is simply absent and the engine's default holds.
    expect(flagOf(s)).toBeUndefined();
    s = reduce(s, { type: "set_param", id: maskId, param: "invert", value: 1 });
    expect(flagOf(s)).toBe(true);
    s = reduce(s, { type: "set_param", id: maskId, param: "invert", value: 0 });
    expect(flagOf(s)).toBe(false);
    // Nodes without the flag do not sprout one.
    expect((serializeGraph(s).nodes.find((n) => n.id === "curves")!.params as Record<string, unknown>).invert).toBeUndefined();
  });

  it("luma curve serializes under the backend's luma key", () => {
    const s = reduce(initialState(), {
      type: "set_curve",
      id: "curves",
      channel: "luma",
      curve: [[0, 0], [0.5, 0.35], [1, 1]],
    });
    const node = serializeGraph(s).nodes.find((n) => n.id === "curves")!;
    const points = JSON.parse((node.params as any).points);
    expect(points.luma[1]).toEqual([0.5, 0.35]);
  });

  it("curves serialize their interpolation, smooth by default", () => {
    let s = reduce(initialState(), {
      type: "set_curve",
      id: "curves",
      channel: "rgb",
      curve: [[0, 0], [0.5, 0.3], [1, 1]],
    });
    let points = JSON.parse((serializeGraph(s).nodes.find((n) => n.id === "curves")!.params as any).points);
    expect(points.interp).toBe("smooth");
    s = reduce(s, { type: "set_curve_interp", id: "curves", interp: "linear" });
    points = JSON.parse((serializeGraph(s).nodes.find((n) => n.id === "curves")!.params as any).points);
    expect(points.interp).toBe("linear");
  });

  it("grain pattern is a text param that serializes and undoes", () => {
    const grain = initialState().nodes.find((n) => n.type === "heeler.grain")!;
    let s = reduce(initialState(), { type: "set_text_param", id: grain.id, param: "pattern", value: "cinema" });
    expect((serializeGraph(s).nodes.find((n) => n.id === grain.id)!.params as any).pattern).toBe("cinema");
    s = reduce(s, { type: "undo" });
    expect((serializeGraph(s).nodes.find((n) => n.id === grain.id)!.params as any).pattern).toBeUndefined();
  });

  it("mask view toggles without touching history", () => {
    let s = initialState();
    const depth = s.undoStack.length;
    expect(s.maskView).toBe(false);
    s = reduce(s, { type: "toggle_mask_view" });
    expect(s.maskView).toBe(true);
    expect(s.undoStack.length).toBe(depth);
  });

  it("tree merges fresh subfolder listings without losing expansion", () => {
    let s = initialState();
    s = reduce(s, {
      type: "set_folder_tree",
      root: {
        name: "Trip", path: "t", expanded: true,
        children: [
          { name: "Day 1", path: "t/1", expanded: true, children: [{ name: "RAW", path: "t/1/raw", expanded: false, children: null }] },
          { name: "Day 2", path: "t/2", expanded: false, children: null },
        ],
      },
    });
    // The watcher re-lists the current folder and finds a new day; the
    // known days keep their state, the stale one drops.
    s = reduce(s, {
      type: "set_tree_node",
      path: "t",
      children: [
        { name: "Day 1", path: "t/1" },
        { name: "Day 3", path: "t/3" },
      ],
    });
    const kids = s.folderTree!.children!;
    expect(kids.map((c) => c.path)).toEqual(["t/1", "t/3"]);
    expect(kids[0].expanded).toBe(true);
    expect(kids[0].children![0].path).toBe("t/1/raw");
    expect(kids[1].expanded).toBe(false);
    // Expansion toggles by path without touching siblings.
    s = reduce(s, { type: "set_tree_node", path: "t/3", expanded: true });
    expect(s.folderTree!.children![1].expanded).toBe(true);
    expect(s.folderTree!.children![0].expanded).toBe(true);
  });

  it("ancestorsBetween yields the expansion chain for session restore", async () => {
    const { ancestorsBetween } = await import("../state");
    expect(ancestorsBetween("F:\\JUNE-2023", "F:\\JUNE-2023\\060123\\S5\\RAW")).toEqual([
      "F:\\JUNE-2023\\060123",
      "F:\\JUNE-2023\\060123\\S5",
    ]);
    // Direct child: nothing between.
    expect(ancestorsBetween("mock://trip", "mock://trip/day1")).toEqual([]);
    // Same folder or unrelated paths: empty.
    expect(ancestorsBetween("F:\\A", "F:\\A")).toEqual([]);
    expect(ancestorsBetween("F:\\A", "D:\\B\\C")).toEqual([]);
  });

  it("reset_image_edits folds the sections that start folded, and keeps the user's folds", () => {
    // "Reset all edits should also collapse on sections
    // that are collapsed by default." The panel reads as it does for a
    // fresh photo; a section the user folded by hand stays folded too.
    let s = initialState();
    const userFolded = "Color";
    expect(DEFAULT_SECTIONS_CLOSED).toContain("Lens Character");
    expect(DEFAULT_SECTIONS_CLOSED).not.toContain(userFolded);
    s = reduce(s, { type: "open_section", title: "Lens Character" });
    s = reduce(s, { type: "open_section", title: "Fog" });
    s = reduce(s, { type: "toggle_section", title: userFolded });
    expect(s.sectionsClosed).not.toContain("Lens Character");
    expect(s.sectionsClosed).toContain(userFolded);
    s = reduce(s, { type: "reset_image_edits", id: s.activeImage! });
    for (const title of DEFAULT_SECTIONS_CLOSED) expect(s.sectionsClosed).toContain(title);
    expect(s.sectionsClosed).toContain(userFolded);
    expect(new Set(s.sectionsClosed).size).toBe(s.sectionsClosed.length);
  });

  it("reset_image_edits restores the neutral graph and clears the badge", () => {
    let s = initialState();
    s = reduce(s, { type: "set_param", id: "exposure", param: "exposure", value: 2 });
    expect(s.images.find((i) => i.id === "4871")!.edited).toBe(true);
    s = reduce(s, { type: "reset_image_edits", id: "4871" });
    expect(s.nodes.find((n) => n.id === "exposure")!.params.exposure).toBe(0);
    expect(s.images.find((i) => i.id === "4871")!.edited).toBe(false);
    // The history stays, with the reset as its newest step.
    expect(s.undoStack.length).toBe(2);
    expect(s.undoStack[1].label).toBe("Reset Edits");
    // Resetting a non-active image leaves the working graph alone.
    s = reduce(s, { type: "set_param", id: "exposure", param: "exposure", value: 1 });
    s = reduce(s, { type: "reset_image_edits", id: "4866" });
    expect(s.nodes.find((n) => n.id === "exposure")!.params.exposure).toBe(1);
    expect(s.images.find((i) => i.id === "4866")!.edited).toBe(false);
  });

  /* : "I reset an image's edits and realized I made a mistake and
   * reset the wrong image. I hit undo and it did not restore the
   * edits."*/
  describe("Reset Edits is undoable", () => {
    const exposure = (st: State) => st.nodes.find((n) => n.id === "exposure")!.params.exposure;
    const edited = (st: State, id: string) => st.images.find((i) => i.id === id)!.edited;

    it("undo brings the open photograph's edits, badge and history back, and redo resets again", () => {
      let s = initialState();
      const a = s.activeImage;
      const original = exposure(s);
      s = reduce(s, { type: "set_param", id: "exposure", param: "exposure", value: 2 });
      const before = s.undoStack.length;
      s = reduce(s, { type: "reset_image_edits", id: a });
      expect(exposure(s)).toBe(0);
      s = reduce(s, { type: "reset_settled", id: a });
      s = reduce(s, { type: "undo" });
      expect(exposure(s)).toBe(2);
      expect(edited(s, a)).toBe(true);
      expect(s.undoStack.length).toBe(before);
      // The open photograph goes back through its own autosave, not a
      // write-back, and nothing else is owed.
      expect(s.restorePending).toEqual([]);
      s = reduce(s, { type: "redo" });
      expect(exposure(s)).toBe(0);
      expect(edited(s, a)).toBe(false);
      expect(s.resetPending).toEqual([a]);
      s = reduce(s, { type: "undo" });
      expect(exposure(s)).toBe(2);
      // Further back still walks the edits made before the reset.
      s = reduce(s, { type: "undo" });
      expect(exposure(s)).toBe(original);
    });

    it("a thumbnail reset while another photograph is open is undone on the photograph that was reset", () => {
      let s = initialState();
      const a = s.activeImage;
      const b = s.images.find((i) => i.id !== a)!.id;
      // B edited, then A opened and edited: B's graph is in the stash.
      s = run(s, { type: "select_image", id: b }, { type: "set_param", id: "exposure", param: "exposure", value: 1.5 });
      s = run(s, { type: "select_image", id: a }, { type: "set_param", id: "exposure", param: "exposure", value: 0.5 });
      const bStash = s.graphs[b];
      s = reduce(s, { type: "reset_image_edits", ids: [b] });
      expect(edited(s, b)).toBe(false);
      expect(s.graphs[b]).toBeUndefined();
      // The archive was already asked for.
      s = reduce(s, { type: "reset_settled", id: b });
      s = reduce(s, { type: "undo" });
      // A keeps its own edit; B gets its graph, badge and write-back.
      expect(exposure(s)).toBe(0.5);
      expect(s.graphs[b]).toBe(bStash);
      expect(edited(s, b)).toBe(true);
      expect(s.restorePending).toEqual([b]);
      s = run(s, { type: "select_image", id: b });
      expect(exposure(s)).toBe(1.5);
    });

    it("an undo before the archive was asked for cancels it instead of owing a write-back", () => {
      let s = initialState();
      const a = s.activeImage;
      const b = s.images.find((i) => i.id !== a)!.id;
      s = run(s, { type: "select_image", id: b }, { type: "set_param", id: "exposure", param: "exposure", value: 1 }, { type: "select_image", id: a });
      s = reduce(s, { type: "reset_image_edits", id: b });
      expect(s.resetPending).toEqual([b]);
      s = reduce(s, { type: "undo" });
      expect(s.resetPending).toEqual([]);
      expect(s.restorePending).toEqual([]);
      expect(edited(s, b)).toBe(true);
    });

    it("a multi-selection reset is one step, and a photograph edited since keeps its new edits", () => {
      let s = initialState();
      const [a, b, c] = s.images.map((i) => i.id);
      s = run(s, { type: "select_image", id: b }, { type: "set_param", id: "exposure", param: "exposure", value: 1 });
      s = run(s, { type: "select_image", id: c }, { type: "set_param", id: "exposure", param: "exposure", value: 2 });
      s = run(s, { type: "select_image", id: a });
      const depth = s.undoStack.length;
      s = reduce(s, { type: "reset_image_edits", ids: [b, c] });
      expect(s.undoStack.length).toBe(depth + 1);
      expect(s.undoStack[s.undoStack.length - 1].label).toBe("Reset Edits (2 photos)");
      s = run(s, { type: "reset_settled", id: b }, { type: "reset_settled", id: c });
      // C is opened and edited after the reset.
      s = run(s, { type: "select_image", id: c }, { type: "set_param", id: "exposure", param: "exposure", value: -1 }, { type: "select_image", id: a });
      s = reduce(s, { type: "undo" });
      expect(edited(s, b)).toBe(true);
      expect(s.restorePending).toEqual([b]);
      s = run(s, { type: "select_image", id: c });
      expect(exposure(s)).toBe(-1);
    });

    it("resetting a photograph with nothing to lose adds no step", () => {
      const s = initialState();
      const b = s.images.find((i) => i.id !== s.activeImage && !i.edited)!.id;
      const t = reduce(s, { type: "reset_image_edits", id: b });
      expect(t.undoStack).toBe(s.undoStack);
      expect(t.resetPending).toEqual([b]);
    });
  });

  it("collapse_tree_below folds every descendant", () => {
    let s = initialState();
    s = reduce(s, {
      type: "set_folder_tree",
      root: {
        name: "Trip", path: "t", expanded: true,
        children: [
          {
            name: "Day 1", path: "t/1", expanded: true,
            children: [{ name: "RAW", path: "t/1/raw", expanded: true, children: [] }],
          },
        ],
      },
    });
    s = reduce(s, { type: "collapse_tree_below", path: "t" });
    const day = s.folderTree!.children![0];
    expect(s.folderTree!.expanded).toBe(true, );
    expect(day.expanded).toBe(false);
    expect(day.children![0].expanded).toBe(false);
  });

  it("folderHasEdits marks ancestors without false prefix matches", async () => {
    const { folderHasEdits } = await import("../state");
    const edited = ["F:\\JUNE-2023\\060123\\S5\\RAW", "mock://trip/day1"];
    // The exact folder and every ancestor light up.
    expect(folderHasEdits(edited, "F:\\JUNE-2023\\060123\\S5\\RAW")).toBe(true);
    expect(folderHasEdits(edited, "F:\\JUNE-2023\\060123\\S5")).toBe(true);
    expect(folderHasEdits(edited, "F:\\JUNE-2023\\060123")).toBe(true);
    expect(folderHasEdits(edited, "F:\\JUNE-2023")).toBe(true);
    expect(folderHasEdits(edited, "mock://trip")).toBe(true);
    // Siblings and lookalike prefixes do not.
    expect(folderHasEdits(edited, "F:\\JUNE-2023\\060223")).toBe(false);
    expect(folderHasEdits(edited, "F:\\JUNE-202")).toBe(false);
    expect(folderHasEdits(edited, "mock://trip/day2")).toBe(false);
  });

  it("thumbnail progress ticks up and auto-clears when done", () => {
    let s = initialState();
    expect(s.thumbProgress).toBe(null);
    s = reduce(s, { type: "set_thumb_progress", progress: { done: 0, total: 3 } });
    s = reduce(s, { type: "tick_thumb_progress" });
    s = reduce(s, { type: "tick_thumb_progress" });
    expect(s.thumbProgress).toEqual({ done: 2, total: 3 });
    s = reduce(s, { type: "tick_thumb_progress" });
    expect(s.thumbProgress).toBe(null);
    // Ticking while idle is a no-op.
    s = reduce(s, { type: "tick_thumb_progress" });
    expect(s.thumbProgress).toBe(null);
  });

  it("param ranges are node-type aware: mask angle is a full rotation", async () => {
    const { paramRange } = await import("../state");
    // Crop straighten keeps its narrow range; the linear mask gets ±180.
    expect(paramRange("angle", "heeler.crop_rotate")).toEqual([-45, 45]);
    expect(paramRange("angle", "heeler.linear_mask")).toEqual([-180, 180]);
    // What the SLIDER spans still differs; what may be typed does not.
    // Both ranges go negative, so neither has a hard limit to hold, and
    // a straighten of 135 degrees is a strange thing to ask for rather
    // than an impossible one.
    let s = reduce(initialState(), { type: "add_layer", maskType: "linear" });
    s = reduce(s, { type: "set_param", id: "layer_1_mask", param: "angle", value: 135 });
    expect(s.nodes.find((n) => n.id === "layer_1_mask")!.params.angle).toBe(135);
    s = reduce(s, { type: "set_param", id: "crop", param: "angle", value: 135 });
    expect(s.nodes.find((n) => n.id === "crop")!.params.angle).toBe(135);
  });

  it("old graphs migrate B&W treatment from enabled into amount", async () => {
    const { migrateNodes } = await import("../state");
    // Pre-amount saved graphs: enabled carried the treatment.
    const wasBW = migrateNodes([
      { id: "bw", type: "heeler.black_white", name: "B&W", cat: "color", x: 0, y: 0, enabled: true, params: { red: 30, green: 59, blue: 11 } },
    ])[0];
    expect(wasBW.params.amount).toBe(100);
    expect(wasBW.enabled).toBe(true, );

    const wasColor = migrateNodes([
      { id: "bw", type: "heeler.black_white", name: "B&W", cat: "color", x: 0, y: 0, enabled: false, params: { red: 30, green: 59, blue: 11 } },
    ])[0];
    expect(wasColor.params.amount).toBe(0);
    // enabled becomes a pure bypass rather than the treatment flag.
    expect(wasColor.enabled).toBe(true);

    // Current graphs pass through untouched, bypass state included.
    const current = migrateNodes([
      { id: "bw", type: "heeler.black_white", name: "B&W", cat: "color", x: 0, y: 0, enabled: false, params: { amount: 60 } },
    ])[0];
    expect(current.params.amount).toBe(60);
    expect(current.enabled).toBe(false);

    // A loaded graph gets migrated, so panel and engine agree.
    let s = initialState();
    s = reduce(s, {
      type: "replace_graph",
      nodes: [
        { id: "bw", type: "heeler.black_white", name: "B&W", cat: "color", x: 0, y: 0, enabled: true, params: {} },
      ],
      wires: [],
    });
    expect(s.nodes[0].params.amount).toBe(100);
  });

  it("restore_takes brings back saved siblings and the active pointer", () => {
    let s = initialState();
    const versions = [
      { id: "take_1", name: "Take 1", nodes: s.nodes, wires: s.wires },
      { id: "take_2", name: "Moody", note: "client pick", nodes: s.nodes, wires: s.wires },
    ];
    s = reduce(s, {
      type: "restore_takes",
      imageId: "4871",
      versions,
      activeVersion: "take_2",
    });
    expect(s.takes["4871"].map((v) => v.name)).toEqual(["Take 1", "Moody"]);
    expect(s.activeTakes["4871"]).toBe("take_2");
    // Switching back to a restored sibling loads its graph.
    s = reduce(s, { type: "switch_take", takeId: "take_1" });
    expect(s.activeTakes["4871"]).toBe("take_1");
    // An empty restore is a no-op, not a wipe.
    s = reduce(s, { type: "restore_takes", imageId: "4871", versions: [], activeVersion: "x" });
    expect(s.takes["4871"].length).toBe(2);
  });

  it("restore_takes migrates every sibling the way replace_graph migrates the active take", () => {
    // A take saved before 2026-09-03 still holds the Sharpening recipe
    // block. replace_graph migrates the ACTIVE take on load, but
    // restore_takes stored the siblings raw, so switching to one
    // brought back a graph this build no longer renders the same.
    const block = (id: string, type: string, params: Record<string, number>): NodeCard =>
      ({ id, type, name: id, cat: "detail", x: 0, y: 0, enabled: true, params, hasIn: true, hasOut: true }) as NodeCard;
    const nodes: NodeCard[] = [
      block("a", "heeler.crop", {}),
      block("sharp_display", "heeler.to_display", {}),
      block("sharp_inv", "heeler.invert", { amount: 1 }),
      block("sharp_blur", "heeler.blur", { radius: 12 }),
      block("sharp_vivid", "heeler.blend", { opacity: 100 }),
      block("sharp_over", "heeler.blend", { opacity: 35 }),
      block("sharp_scene", "heeler.to_scene", {}),
      block("b", "heeler.output", {}),
    ];
    const wires = [
      { from: "a", to: "sharp_display", toPort: "in", kind: "image" },
      { from: "sharp_display", to: "sharp_over", toPort: "in", kind: "image" },
      { from: "sharp_display", to: "sharp_inv", toPort: "in", kind: "image" },
      { from: "sharp_inv", to: "sharp_blur", toPort: "in", kind: "image" },
      { from: "sharp_display", to: "sharp_vivid", toPort: "in", kind: "image" },
      { from: "sharp_blur", to: "sharp_vivid", toPort: "in2", kind: "image" },
      { from: "sharp_vivid", to: "sharp_over", toPort: "in2", kind: "image" },
      { from: "sharp_over", to: "sharp_scene", toPort: "in", kind: "image" },
      { from: "sharp_scene", to: "b", toPort: "in", kind: "image" },
    ] as State["wires"];
    const s = reduce(initialState(), {
      type: "restore_takes",
      imageId: "4871",
      versions: [
        { id: "take_1", name: "Take 1", nodes: [], wires: [] },
        { id: "take_2", name: "Old", nodes, wires },
      ],
      activeVersion: "take_1",
    });
    const restored = s.takes["4871"].find((t) => t.id === "take_2")!;
    expect(restored.nodes.some((n) => n.id.startsWith("sharp_"))).toBe(false);
    const tool = restored.nodes.find((n) => n.id === "sharpening")!;
    expect(tool.params).toEqual({ radius: 12, intensity: 35, keep_color: 100 });
    expect(restored.wires.find((w) => w.to === "sharpening")!.from).toBe("a");
    expect(restored.wires.find((w) => w.to === "b")!.from).toBe("sharpening");
  });

  it("restore_takes refuses an active pointer no saved take holds", () => {
    // The file is hand-editable and older builds wrote it: when
    // activeVersion names a take that is not there, pointing the
    // active slot at the ghost means new_take and switch_take snapshot
    // the live graph into NOTHING (their map matches no id) and the
    // next switch throws the edits away. Fall to the first take, the
    // same fallback the loader uses when the key is absent.
    let s = initialState();
    const versions = [
      { id: "take_1", name: "Take 1", nodes: s.nodes, wires: s.wires },
      { id: "take_2", name: "Moody", nodes: s.nodes, wires: s.wires },
    ];
    s = reduce(s, { type: "restore_takes", imageId: "4871", versions, activeVersion: "take_9" });
    expect(s.activeTakes["4871"]).toBe("take_1");
  });

  it("switching takes drops what pointed into the old take's graph", () => {
    // A take switch swaps the graph out from under the UI exactly the
    // way select_image swaps photos, so it owes the same resets: the
    // active layer, the armed pickers, the color-set dropper and mask
    // eye, the Finish selection. Left behind, the active layer makes
    // every Develop panel read and write a ghost layer's stand-in
    // (toolNode), and an armed picker's next click lands on a node the
    // showing take does not have. compareTake stays: take ids survive
    // a switch, so the comparison source still names a real take.
    let s = run(initialState(), { type: "new_take" });
    s = {
      ...s,
      activeLayer: "layer_1_adj",
      curvePick: { nodeId: "curves", channel: "luma" },
      curveHoverX: 0.5,
      csetDropper: 1,
      csetMaskView: 1,
      probeNode: "curves",
      toneEqPick: "toneeq",
      wbPick: "stdcolor",
      recolorPick: "recolor",
      recolorMatch: { id: "recolor", source: null },
      consolePick: "wheels",
      artActive: "art_b1",
      artSelected: ["art_b1"],
      artGradientEdit: "art_b1",
      compareTake: "take_1",
    };
    s = run(s, { type: "switch_take", takeId: "take_1" });
    expect(s.activeLayer).toBeNull();
    expect(s.curvePick).toBeNull();
    expect(s.curveHoverX).toBeNull();
    expect(s.csetDropper).toBeNull();
    expect(s.csetMaskView).toBeNull();
    expect(s.probeNode).toBeNull();
    expect(s.toneEqPick).toBeNull();
    expect(s.wbPick).toBeNull();
    expect(s.recolorPick).toBeNull();
    expect(s.recolorMatch).toBeNull();
    expect(s.consolePick).toBeNull();
    expect(s.artActive).toBeNull();
    expect(s.artSelected).toEqual([]);
    expect(s.artGradientEdit).toBeNull();
    expect(s.compareTake).toBe("take_1");
    // Deleting the take on screen swaps the graph the same way, so the
    // same resets owe there too.
    s = {
      ...s,
      activeLayer: "layer_1_adj",
      csetDropper: 2,
      artSelected: ["art_b1"],
    };
    s = run(s, { type: "delete_take", takeId: "take_1" });
    expect(s.activeTakes[s.activeImage!]).toBe("take_2");
    expect(s.activeLayer).toBeNull();
    expect(s.csetDropper).toBeNull();
    expect(s.artSelected).toEqual([]);
  });

  it("eyedropper folds samples into the luma window per mode", async () => {
    const { applyPick } = await import("../state");
    const sample = { luma: 0.7, hue: 30, sat: 0.5 };
    // Replace centers a fresh window on the sample.
    const replaced = applyPick({ luma_low: 0, luma_high: 1 }, sample, "replace", "luma");
    expect(replaced.luma_low).toBeCloseTo(0.64, 5);
    expect(replaced.luma_high).toBeCloseTo(0.76, 5);
    // Add grows an existing window to reach the sample.
    const added = applyPick({ luma_low: 0.1, luma_high: 0.3 }, sample, "add", "luma");
    expect(added.luma_low).toBe(0.1);
    expect(added.luma_high!).toBeGreaterThanOrEqual(0.7);
    // Subtract pulls the nearer edge past the sample, excluding it.
    const sub = applyPick({ luma_low: 0.6, luma_high: 1 }, sample, "subtract", "luma");
    expect(sub.luma_low!).toBeGreaterThan(0.7);
    // A sample already outside the window is a no-op for subtract.
    expect(applyPick({ luma_low: 0, luma_high: 0.5 }, sample, "subtract", "luma")).toEqual({});
    // Windows clamp to the legal range.
    const edge = applyPick({}, { luma: 0.98, hue: 0, sat: 0 }, "replace", "luma");
    expect(edge.luma_high).toBe(1);
  });

  it("eyedropper handles hue circularly", async () => {
    const { applyPick } = await import("../state");
    const replaced = applyPick({}, { luma: 0.5, hue: 200, sat: 0.6 }, "replace", "hue");
    expect(replaced.hue_center).toBe(200);
    expect(replaced.hue_width).toBe(18);
    // Adding a hue across the 0/360 seam widens the SHORT way round: 320
    // is 50 degrees from a window centered at 10, not 310.
    const added = applyPick({ hue_center: 10, hue_width: 20 }, { luma: 0.5, hue: 320, sat: 0.6 }, "add", "hue");
    expect(added.hue_width!).toBeLessThan(60);
    expect(added.hue_center!).toBeGreaterThan(300);
    // A hue already inside the window needs no change.
    expect(applyPick({ hue_center: 10, hue_width: 20 }, { luma: 0.5, hue: 350, sat: 0.6 }, "add", "hue")).toEqual({});
    // Already covered: no change.
    expect(applyPick({ hue_center: 0, hue_width: 40 }, { luma: 0.5, hue: 20, sat: 0.5 }, "add", "hue")).toEqual({});
    // Subtract narrows so the sample falls outside.
    const sub = applyPick({ hue_center: 0, hue_width: 60 }, { luma: 0.5, hue: 40, sat: 0.5 }, "subtract", "hue");
    expect(sub.hue_width!).toBeLessThan(40);
  });

  it("layers duplicate with their settings and can be renamed", () => {
    let s = reduce(initialState(), { type: "add_layer", maskType: "range" });
    s = reduce(s, { type: "set_param", id: "layer_1_mask", param: "luma_low", value: 0.42 });
    s = reduce(s, { type: "set_param", id: "layer_1_adj", param: "exposure", value: 1.5 });

    s = reduce(s, { type: "duplicate_layer", id: "layer_1_adj" });
    const layers = layersOf(s);
    expect(layers.length).toBe(2);
    // The copy carries mask settings and adjustments, and is selected.
    expect(s.nodes.find((n) => n.id === "layer_2_mask")!.params.luma_low).toBe(0.42);
    expect(s.nodes.find((n) => n.id === "layer_2_adj")!.params.exposure).toBe(1.5);
    expect(s.activeLayer).toBe("layer_2_adj");
    // It is wired into the chain after its source, with its own mask.
    expect(s.wires.some((w) => w.from === "layer_1_adj" && w.to === "layer_2_adj")).toBe(true);
    expect(s.wires.some((w) => w.from === "layer_2_mask" && w.to === "layer_2_adj" && w.toPort === "mask")).toBe(true);
    // Editing the copy leaves the original alone.
    s = reduce(s, { type: "set_param", id: "layer_2_mask", param: "luma_low", value: 0.9 });
    expect(s.nodes.find((n) => n.id === "layer_1_mask")!.params.luma_low).toBe(0.42);

    s = reduce(s, { type: "rename_layer", id: "layer_2_adj", name: "Sky" });
    expect(layersOf(s).find((l) => l.id === "layer_2_adj")!.name).toBe("Sky");
    // Blank renames are ignored rather than clearing the label.
    s = reduce(s, { type: "rename_layer", id: "layer_2_adj", name: "   " });
    expect(layersOf(s).find((l) => l.id === "layer_2_adj")!.name).toBe("Sky");
  });

  describe("the curve eyedropper", () => {
    it("arms per node and channel, and the same button disarms", () => {
      let s = run(initialState(), { type: "arm_curve_pick", nodeId: "curves", channel: "rgb" });
      expect(s.curvePick).toEqual({ nodeId: "curves", channel: "rgb" });
      // A different channel re-arms rather than toggling off.
      s = run(s, { type: "arm_curve_pick", nodeId: "curves", channel: "r" });
      expect(s.curvePick).toEqual({ nodeId: "curves", channel: "r" });
      s = run(s, { type: "arm_curve_pick", nodeId: "curves", channel: "r" });
      expect(s.curvePick).toBeNull();
    });

    it("tracks hover only while armed, and switching photos disarms", () => {
      let s = run(initialState(), { type: "set_curve_hover", x: 0.5 });
      expect(s.curveHoverX).toBeNull();
      s = run(s, { type: "arm_curve_pick", nodeId: "curves", channel: "luma" });
      s = run(s, { type: "set_curve_hover", x: 0.42 });
      expect(s.curveHoverX).toBe(0.42);
      // The pick was armed on this photo; the next one starts clean.
      s = run(s, { type: "select_image", id: "4868" });
      expect(s.curvePick).toBeNull();
      expect(s.curveHoverX).toBeNull();
    });

    it("a bright-sky pick commits a point instead of vanishing", async () => {
      const { pickedCurvePoint } = await import("../ui/editors");
      const identity: [number, number][] = [[0, 0], [1, 1]];
      // The owner's field case: a blown sky samples x ~1.0, the commit clamps
      // to 0.99, and the old proximity test saw the pinned x=1 corner 0.01
      // away and threw the click away. Endpoints must never block.
      const next = pickedCurvePoint(identity, true, 1.0)!.curve;
      expect(next.map((p) => p[0])).toEqual([0, 0.99, 1]);
      // Same at the black end.
      const low = pickedCurvePoint(identity, true, 0.0)!.curve;
      expect(low.map((p) => p[0])).toEqual([0, 0.01, 1]);
      // An interior point already there is selected without moving.
      expect(pickedCurvePoint(next, true, 1.0)!.curve).toEqual(next);
      // Outside the snap distance a new point is added.
      const third = pickedCurvePoint(next, true, 0.5)!.curve;
      expect(third.map((p) => p[0])).toEqual([0, 0.5, 0.99, 1]);
      // The committed point sits on the curve, not off it.
      const { curveValueAt } = await import("../ui/editors");
      expect(third[1][1]).toBeCloseTo(curveValueAt(next, true, 0.5), 6);
    });

    it("the ghost point lands exactly on the curve", async () => {
      const { curveValueAt } = await import("../ui/editors");
      const pts: [number, number][] = [[0, 0], [0.5, 0.8], [1, 1]];
      // Endpoints and knots are exact in both interpolations.
      for (const smooth of [true, false]) {
        expect(curveValueAt(pts, smooth, 0)).toBe(0);
        expect(curveValueAt(pts, smooth, 0.5)).toBeCloseTo(0.8, 6);
        expect(curveValueAt(pts, smooth, 1)).toBe(1);
      }
      // Linear between knots is the straight line.
      expect(curveValueAt(pts, false, 0.25)).toBeCloseTo(0.4, 6);
      // Smooth stays monotone between the same knots.
      let prev = -1;
      for (let i = 0; i <= 40; i++) {
        const v = curveValueAt(pts, true, i / 40);
        expect(v).toBeGreaterThanOrEqual(prev - 1e-6);
        prev = v;
      }
    });
  });

  describe("the name filter", () => {
    it("plain text matches anywhere in the name, any case", () => {
      expect(nameMatches("4867", "DSC_04867.NEF")).toBe(true);
      expect(nameMatches("dsc_048", "DSC_04867.NEF")).toBe(true);
      expect(nameMatches("nef", "DSC_04867.NEF")).toBe(true);
      expect(nameMatches("4899", "DSC_04867.NEF")).toBe(false);
      // Blank (or all spaces) is the filter turned off.
      expect(nameMatches("   ", "anything.raw")).toBe(true);
    });

    it("* and ? make it a whole-name wildcard, never regex", () => {
      expect(nameMatches("DSC_*", "DSC_04867.NEF")).toBe(true);
      expect(nameMatches("*.nef", "DSC_04867.NEF")).toBe(true);
      expect(nameMatches("DSC_0486?.NEF", "DSC_04867.NEF")).toBe(true);
      expect(nameMatches("DSC_0487?.NEF", "DSC_04867.NEF")).toBe(false);
      // A wildcard pattern covers the whole name, like filename globs
      // always have: a prefix pattern is not a substring hunt.
      expect(nameMatches("DSC_*", "IMG_DSC_1.NEF")).toBe(false);
      // Regex punctuation is just punctuation here.
      expect(nameMatches("a+b*", "a+b_c.raw")).toBe(true);
      expect(nameMatches("a.b*", "axb.raw")).toBe(false);
    });

    it("narrows the ribbon and clears with everything else", () => {
      let s = run(initialState(), { type: "set_filter_name", text: "4867" });
      expect(visibleImages(s).map((i) => i.id)).toEqual(["4867"]);
      expect(filtersActive(s)).toBe(true);
      s = run(s, { type: "clear_filters" });
      expect(s.filterName).toBe("");
      expect(visibleImages(s).length).toBe(s.images.length);
    });
  });

  describe("curves moving to the end of the chain", () => {
    // The chain as it was when curves sat between cbal and levels: the
    // arrangement every saved graph from before the move still has.
    // Levels has since moved onto the profile as well (2026-09-13), so
    // it is left out of the old order here: the curve then lands where
    // it did, between cbal and exposure.
    const OLD_ORDER = [
      "src", "merge", "crop", "lens", "stdcolor", "cbal", "curves",
      "exposure", "bw", "denoise", "sharpen", "grain",
      "splittone", "bend", "profile", "output",
    ];
    const withOldWiring = () => {
      const s = initialState();
      const wires = spliceIn(spliceOut(s.wires, "curves"), "curves", OLD_ORDER);
      return run(s, { type: "replace_graph", nodes: s.nodes, wires, backdrops: [] });
    };

    it("an untouched curve is rewired to ride on the profile", () => {
      let s = withOldWiring();
      expect(s.wires.some((w) => w.from === "cbal" && w.to === "curves")).toBe(true);
      s = run(s, { type: "move_curves_late" });
      // Onto the profile, behind the Levels that rides there now, and
      // ahead of the print.
      expect(s.wires.some((w) => w.from === "levels" && w.to === "curves")).toBe(true);
      expect(s.wires.some((w) => w.from === "curves" && w.to === "paper")).toBe(true);
      expect(s.wires.some((w) => w.from === "paper" && w.to === "output")).toBe(true);
      expect(s.wires.some((w) => w.from === "cbal" && w.to === "curves")).toBe(false);
      // Idempotent: a graph already in shape is left exactly alone.
      expect(run(s, { type: "move_curves_late" }).wires).toEqual(s.wires);
    });

    it("a curve someone bent stays where they bent it", () => {
      let s = withOldWiring();
      s = run(s, {
        type: "set_curve",
        id: "curves",
        channel: "rgb",
        curve: [[0, 0], [0.4, 0.6], [1, 1]],
      });
      const before = s.wires;
      s = run(s, { type: "move_curves_late" });
      expect(s.wires).toEqual(before);
    });

    it("the default identity diagonal still counts as untouched", () => {
      expect(curvesUntouched({ curves: {} })).toBe(true);
      expect(curvesUntouched({})).toBe(true);
      expect(curvesUntouched({ curves: { rgb: [[0, 0], [1, 1]] } })).toBe(true);
      expect(curvesUntouched({ curves: { rgb: [[0, 0], [0.5, 0.3], [1, 1]] } })).toBe(false);
    });
  });

  describe("art layers", () => {
    const add = (s: State) => run(s, { type: "art_add_layer", kind: "paint" });

    it("the first layer builds the group after curves, wrapped in display space", () => {
      const s = add(initialState());
      // After the print: paint and blend ride on the finished print.
      expect(s.wires.some((w) => w.from === "curves" && w.to === "paper")).toBe(true);
      expect(s.wires.some((w) => w.from === "paper" && w.to === "art")).toBe(true);
      expect(s.wires.some((w) => w.from === "art" && w.to === "output")).toBe(true);
      const ls = artLayers(s);
      expect(ls.length).toBe(1);
      expect(ls[0].content.type).toBe("heeler.paint");
      expect(ls[0].blend.type).toBe("heeler.blend");
      expect(s.artActive).toBe(ls[0].blend.id);
      // The engine sees display conversion around the stack and the
      // blend fed on both ports; the group itself dissolves.
      const g = serializeGraph(s);
      expect(g.nodes.some((n: any) => n.id === "art")).toBe(false);
      expect(g.connections.some((c: any) => c.from[0] === "paper" && c.to[0] === "art_in")).toBe(true);
      expect(g.connections.some((c: any) => c.from[0] === "art_in" && c.to[0] === ls[0].blend.id)).toBe(true);
      // in2 serializes as "fg"; the engine maps that onto blend's
      // second input, the same road merge's second input travels.
      expect(g.connections.some((c: any) => c.from[0] === ls[0].content.id && c.to[0] === ls[0].blend.id && c.to[1] === "fg")).toBe(true);
      expect(g.connections.some((c: any) => c.from[0] === "art_out" && c.to[0] === "output")).toBe(true);
    });

    it("layers stack, reorder, and leave cleanly", () => {
      let s = add(add(initialState()));
      let ls = artLayers(s);
      expect(ls.map((l) => l.blend.id)).toEqual(["art_b1", "art_b2"]);
      // Moving the bottom layer up in render order swaps the pair.
      s = run(s, { type: "art_move_layer", id: "art_b1", delta: 1 });
      expect(artLayers(s).map((l) => l.blend.id)).toEqual(["art_b2", "art_b1"]);
      // Off the end is refused, not wrapped.
      const same = run(s, { type: "art_move_layer", id: "art_b1", delta: 1 });
      expect(artLayers(same).map((l) => l.blend.id)).toEqual(["art_b2", "art_b1"]);
      // Removal keeps the survivor wired through.
      s = run(s, { type: "art_remove_layer", id: "art_b2" });
      ls = artLayers(s);
      expect(ls.map((l) => l.blend.id)).toEqual(["art_b1"]);
      const g = s.nodes.find((n) => n.id === "art")!;
      expect(g.groupWires!.some((w) => w.from === "art_b1" && w.to === "art_out")).toBe(true);
      expect(g.groupNodes!.some((n) => n.id === "art_p2")).toBe(false);
    });

    it("a layer mask lives in the Finish group and reaches its own blend", async () => {
      // 2026-10-01: "Everything that happens in Finish should be in the
      // finish group."
      const { artMaskOf, ART_ID } = await import("../state");
      let s = add(add(initialState()));
      s = run(s, { type: "art_add_mask", id: "art_b2" });
      const mask = artMaskOf(s, "art_b2")!;
      expect(mask.type).toBe("heeler.brush_mask");
      // Reveal-all by default: inverted empty mask is one everywhere.
      expect(mask.params.invert).toBe(1);
      // A member of the Finish group, wired inside it to its blend, and
      // nowhere in the top-level list.
      const art = s.nodes.find((n) => n.id === ART_ID)!;
      expect(s.nodes.some((n) => n.id === mask.id)).toBe(false);
      expect(art.groupNodes!.some((n) => n.id === mask.id)).toBe(true);
      expect(art.groupWires).toContainEqual({ from: mask.id, to: "art_b2", toPort: "mask", kind: "mask" });
      // Fed from the whole frame, after this sample's crop and lens
      // correction, like every develop mask: the size of the layer it
      // gates, on the frame it edits. The frame arrives on the group's
      // second input, and the boundary hands it to the mask.
      expect(s.wires).toContainEqual({ from: "lens", to: ART_ID, toPort: "in2", kind: "image" });
      expect(art.hasIn2).toBe(true);
      expect(art.groupBoundary).toContainEqual({ from: "lens", to: mask.id, toPort: "in", kind: "image", groupPort: "in2" });
      expect(s.wires.some((w) => w.from === mask.id || w.to === mask.id)).toBe(false);
      // A second add on the same layer is refused; the other layer is bare.
      expect(run(s, { type: "art_add_mask", id: "art_b2" })).toBe(s);
      expect(artMaskOf(s, "art_b1")).toBeUndefined();
      // The flattened graph routes the mask to ITS blend, not the first
      // mask port someone finds.
      const g = serializeGraph(s);
      expect(
        g.connections.some(
          (c: any) => c.from[0] === mask.id && c.to[0] === "art_b2" && c.to[1] === "mask",
        ),
      ).toBe(true);
      expect(g.connections.some((c: any) => c.to[0] === "art_b1" && c.to[1] === "mask")).toBe(false);
      // The frame reaches the mask's input in the flattened graph, from
      // the same node the mask read when it hung outside the group.
      expect(g.connections.some((c: any) => c.from[0] === "lens" && c.to[0] === mask.id && c.to[1] === "in")).toBe(true);
      // Removal takes the node, its wires and the boundary entries, and
      // the group's second input with them.
      s = run(s, { type: "art_remove_mask", id: "art_b2" });
      expect(artMaskOf(s, "art_b2")).toBeUndefined();
      const after = s.nodes.find((n) => n.id === ART_ID)!;
      expect(after.groupNodes!.some((n) => n.id === mask.id)).toBe(false);
      expect((after.groupWires ?? []).some((w) => w.from === mask.id || w.to === mask.id)).toBe(false);
      expect((after.groupBoundary ?? []).some((w) => w.from === mask.id || w.to === mask.id)).toBe(false);
      expect(s.wires.some((w) => w.to === ART_ID && w.toPort === "in2")).toBe(false);
      expect(after.hasIn2).toBeUndefined();
    });

    it("grouping wraps a contiguous run in an isolation group", async () => {
      const { artGroupMembers, artFindLayer } = await import("../state");
      let s = add(add(add(initialState())));
      s = run(s, { type: "select_art_layers", ids: ["art_b1", "art_b2"] });
      s = run(s, { type: "art_group_layers", ids: ["art_b1", "art_b2"] });
      const ls = artLayers(s);
      // Two entries left: the group (where b1/b2 were) and b3.
      expect(ls.length).toBe(2);
      expect(ls[0].content.isGroup).toBe(true);
      expect(ls[1].blend.id).toBe("art_b3");
      const members = artGroupMembers(ls[0].content);
      expect(members.map((m) => m.content.id)).toEqual(["art_p1", "art_p2"]);
      // A member's carrier is a blend as of 2026-08-27, and that is the
      // whole reason masks, modes and clipping work inside a group at
      // all: a merge has a base port and a foreground port and nothing
      // else to hang them on. At mode "normal" it composites exactly as
      // the merge it replaced.
      expect(members[0].merge.type).toBe("heeler.blend");
      expect(members[0].merge.textParams?.mode).toBe("normal");
      expect(ls[0].blend.type).toBe("heeler.blend");
      // Member lookup and stroke routing reach inside.
      const m1 = artFindLayer(s, members[0].merge.id)!;
      expect(m1.groupId).toBe(ls[0].content.id);
      s = run(s, {
        type: "art_add_stroke",
        id: members[0].merge.id,
        stroke: { points: [[0.5, 0.5]], radius: 0.1, color: "#00ff00" },
      });
      expect(artFindLayer(s, members[0].merge.id)!.content.strokes?.length).toBe(1);
      // The serialized graph dissolves BOTH nesting levels: neither the
      // Layers group nor the stack group survives (portra, the template
      // look source, stays: memberless groups are the engine's image
      // sources by design). Canvas feeds the merge chain, the chain
      // feeds the blend.
      const gid = ls[0].content.id;
      const g = serializeGraph(s);
      expect(g.nodes.some((n: any) => n.id === "art" || n.id === gid)).toBe(false);
      expect(g.nodes.some((n: any) => n.id === `${gid}_c`)).toBe(true);
      expect(
        g.connections.some((c: any) => c.from[0] === `${gid}_c` && c.to[0] === `${gid}_m1`),
      ).toBe(true);
      expect(
        g.connections.some((c: any) => c.from[0] === `${gid}_m2` && c.to[0] === ls[0].blend.id),
      ).toBe(true);
      // Ungrouping puts the members back as top-level layers.
      s = run(s, { type: "art_ungroup", id: ls[0].blend.id });
      const flat = artLayers(s);
      expect(flat.length).toBe(3);
      expect(flat.map((l) => l.content.id)).toEqual(["art_p1", "art_p2", "art_p3"]);
      expect(flat.every((l) => l.blend.type === "heeler.blend")).toBe(true);
    });

    /// 2026-08-27: "Finish > Group layers are still broken. I can not
    /// expand/open up a group to access any of the controls for layer
    /// FX, Masks, and Smart Masks... I also don't see a way to Add pixel
    /// layer to existing group / Remove a pixel from the current group /
    /// Reorder pixel layers in a group."
    ///
    /// All of that comes back to one thing: a member used to be carried
    /// by a merge, which has a base port, a foreground port and nowhere
    /// to put anything else.
    it("gives a grouped layer the same controls a top-level one has", async () => {
      const { artGroupMembers, artMaskOf, artFindLayer } = await import("../state");
      let s = add(add(initialState()));
      s = run(s, { type: "art_group_layers", ids: ["art_b1", "art_b2"] });
      const group = artLayers(s).find((l) => l.content.isGroup)!;
      const member = artGroupMembers(group.content)[0].merge.id;

      // A blend mode, which a merge could not hold.
      s = run(s, { type: "art_layer_set", id: member, mode: "multiply" });
      expect(artFindLayer(s, member)!.carrier.textParams?.mode).toBe("multiply");

      // An effect, wired between the content and the carrier inside the
      // group exactly as it is at the top level.
      s = run(s, { type: "art_add_fx", id: member, fx: "shadow" });
      const withFx = artGroupMembers(artLayers(s).find((l) => l.content.isGroup)!.content)[0];
      expect(withFx.fx.map((f) => f.type)).toEqual(["heeler.fx_shadow"]);
      const g = serializeGraph(s);
      const fxId = withFx.fx[0].id;
      expect(g.connections.some((c: any) => c.from[0] === withFx.content.id && c.to[0] === `__fx_shape_${member}`)).toBe(true);
      expect(g.connections.some((c: any) => c.from[0] === fxId && c.to[0] === member)).toBe(true);

      // A mask, which crosses two boundaries to reach a member: into
      // the art group as far as the stack group, then into the stack
      // group as far as this layer.
      s = run(s, { type: "art_add_mask", id: member });
      const mask = artMaskOf(s, member)!;
      expect(mask).toBeTruthy();
      const g2 = serializeGraph(s);
      expect(
        g2.connections.some((c: any) => c.from[0] === mask.id && c.to[0] === member && c.to[1] === "mask"),
      ).toBe(true);

      // And a smart mask, the same way.
      s = run(s, { type: "art_remove_mask", id: member });
      expect(artMaskOf(s, member)).toBeUndefined();
      s = run(s, { type: "art_add_mask", id: member, kind: "smart" });
      expect(artMaskOf(s, member)!.type).toBe("heeler.smart_mask");
    });

    it("moves layers into a group, out of it, and around inside it", async () => {
      const { artGroupMembers, artFindLayer } = await import("../state");
      let s = add(add(add(initialState())));
      s = run(s, { type: "art_group_layers", ids: ["art_b1", "art_b2"] });
      let group = artLayers(s).find((l) => l.content.isGroup)!;
      expect(artGroupMembers(group.content).length).toBe(2);

      // In: the third layer joins, and leaves the top level.
      s = run(s, { type: "art_add_to_group", id: "art_b3", groupId: group.blend.id });
      group = artLayers(s).find((l) => l.content.isGroup)!;
      const members = artGroupMembers(group.content);
      expect(members.map((m) => m.content.id)).toEqual(["art_p1", "art_p2", "art_p3"]);
      expect(artLayers(s).length).toBe(1);
      // It kept its opacity and its name on the way in.
      expect(artFindLayer(s, members[2].merge.id)!.carrier.name).toBe("Pixel 3");

      // Around: the top member moves down one.
      s = run(s, { type: "art_move_member", id: members[2].merge.id, delta: -1 });
      group = artLayers(s).find((l) => l.content.isGroup)!;
      expect(artGroupMembers(group.content).map((m) => m.content.id)).toEqual([
        "art_p1",
        "art_p3",
        "art_p2",
      ]);

      // Out: it returns to the top level, above the group it left.
      s = run(s, { type: "art_remove_from_group", id: members[2].merge.id });
      const top = artLayers(s);
      expect(top.length).toBe(2);
      expect(top[1].content.id).toBe("art_p3");
      expect(top[1].blend.type).toBe("heeler.blend");
      expect(artGroupMembers(top[0].content).length).toBe(2);
    });

    it("takes the group away with its last member", async () => {
      const { artGroupMembers } = await import("../state");
      let s = add(add(initialState()));
      s = run(s, { type: "art_group_layers", ids: ["art_b1", "art_b2"] });
      const group = artLayers(s).find((l) => l.content.isGroup)!;
      const [first, second] = artGroupMembers(group.content);
      s = run(s, { type: "art_remove_from_group", id: first.merge.id });
      s = run(s, { type: "art_remove_from_group", id: second.merge.id });
      // Two layers back at the top and no empty group left behind.
      expect(artLayers(s).length).toBe(2);
      expect(artLayers(s).some((l) => l.content.isGroup)).toBe(false);
    });

    /// Grouping used to drop a layer's effects on the floor: groupNodes
    /// took the content and the merge and nothing else.
    it("carries a layer's effects into a group and back out again", async () => {
      const { artGroupMembers } = await import("../state");
      let s = add(add(initialState()));
      s = run(s, { type: "art_add_fx", id: "art_b1", fx: "glow" });
      s = run(s, { type: "art_group_layers", ids: ["art_b1", "art_b2"] });
      const group = artLayers(s).find((l) => l.content.isGroup)!;
      expect(artGroupMembers(group.content)[0].fx.map((f) => f.type)).toEqual(["heeler.fx_glow"]);
      s = run(s, { type: "art_ungroup", id: group.blend.id });
      expect(artLayers(s)[0].fx.map((f) => f.type)).toEqual(["heeler.fx_glow"]);
    });

    /// Dragging a color around the picker fires one art_content_set
    /// per mousemove, with a STRING value, and gestureKey only keyed
    /// numbers: a two-second drag was a hundred undo entries and the
    /// pre-drag state fell off the end of the history. A color drag
    /// brackets like any other slider: one entry for the gesture.
    it("a color drag is one undo entry, like any other slider", () => {
      let s = add(initialState());
      const depth = s.undoStack.length;
      s = run(s, { type: "begin_gesture", key: "art_b1.color" });
      s = run(s, { type: "art_content_set", id: "art_b1", param: "color", value: "#ff0000" });
      s = run(s, { type: "art_content_set", id: "art_b1", param: "color", value: "#00ff00" });
      s = run(s, { type: "art_content_set", id: "art_b1", param: "color", value: "#0000ff" });
      expect(s.undoStack.length).toBe(depth + 1);
      // One undo lands back on the color from before the drag.
      s = run(s, { type: "end_gesture" }, { type: "undo" });
      const content = artLayers(s)[0].content;
      expect(content.textParams?.color).not.toBe("#0000ff");
    });

    /// The blur effect's kind must land under the name the engine
    /// reads: the registry declares `kind` (spec.rs, heeler.blur) and
    /// ops.rs choice() looks it up; ART_FX shipped `blur_type`, which
    /// no code reads, so a saved Box or Motion blur would silently
    /// render Gaussian.
    it("the blur effect names its kind the way the engine reads it", async () => {
      const { ART_FX } = await import("../state");
      expect(ART_FX.blur.text).toEqual({ kind: "gaussian" });
    });

    /// A mask is boundary-wired to its layer's carrier, so every
    /// operation that moves a layer has to move the mask's wiring with
    /// it. Grouping used to refuse a masked layer outright (the menu
    /// offered it, the reducer said nothing), and removing a masked
    /// member left the mask pointing at a blend that was gone.
    it("carries a layer's mask into a group and back out again", async () => {
      const { artGroupMembers, artMaskOf } = await import("../state");
      let s = add(add(initialState()));
      s = run(s, { type: "art_add_mask", id: "art_b1" });
      const mid = artMaskOf(s, "art_b1")!.id;
      // Grouping is no longer refused: the mask travels. Hop 1 of the
      // boundary now lands on the group, hop 2 reaches the member's
      // new carrier.
      s = run(s, { type: "art_group_layers", ids: ["art_b1", "art_b2"] });
      const group = artLayers(s).find((l) => l.content.isGroup)!;
      const member = artGroupMembers(group.content)[0].merge.id;
      expect(artMaskOf(s, member)?.id).toBe(mid);
      let g = serializeGraph(s);
      expect(
        g.connections.some((c: any) => c.from[0] === mid && c.to[0] === member && c.to[1] === "mask"),
      ).toBe(true);
      // Ungrouping hands each member a new blend; the mask follows its
      // layer to the new id rather than dangling off the dead group.
      s = run(s, { type: "art_ungroup", id: group.blend.id });
      const landed = artLayers(s).find((l) => artMaskOf(s, l.blend.id)?.id === mid);
      expect(landed).toBeTruthy();
      expect(landed!.content.id).toBe("art_p1");
      g = serializeGraph(s);
      expect(
        g.connections.some((c: any) => c.from[0] === mid && c.to[0] === landed!.blend.id && c.to[1] === "mask"),
      ).toBe(true);
    });

    it("adds a masked layer to a group and removes it again, mask intact", async () => {
      const { artGroupMembers, artMaskOf } = await import("../state");
      let s = add(add(add(initialState())));
      s = run(s, { type: "art_group_layers", ids: ["art_b1", "art_b2"] });
      s = run(s, { type: "art_add_mask", id: "art_b3" });
      const mid = artMaskOf(s, "art_b3")!.id;
      let group = artLayers(s).find((l) => l.content.isGroup)!;
      // In: the mask crosses a second boundary now - hop 1 retargeted
      // at the stack group, hop 2 recorded on it.
      s = run(s, { type: "art_add_to_group", id: "art_b3", groupId: group.blend.id });
      group = artLayers(s).find((l) => l.content.isGroup)!;
      const member = artGroupMembers(group.content)[2].merge.id;
      expect(artMaskOf(s, member)?.id).toBe(mid);
      let g = serializeGraph(s);
      expect(
        g.connections.some((c: any) => c.from[0] === mid && c.to[0] === member && c.to[1] === "mask"),
      ).toBe(true);
      // Out: hop 1 points at the carrier again, which keeps its id when
      // it becomes the top-level blend.
      s = run(s, { type: "art_remove_from_group", id: member });
      expect(artMaskOf(s, member)?.id).toBe(mid);
      g = serializeGraph(s);
      expect(
        g.connections.some((c: any) => c.from[0] === mid && c.to[0] === member && c.to[1] === "mask"),
      ).toBe(true);
    });

    it("removing a masked member takes its mask with it", async () => {
      const { artGroupMembers, artMaskOf } = await import("../state");
      let s = add(add(initialState()));
      s = run(s, { type: "art_group_layers", ids: ["art_b1", "art_b2"] });
      const group = artLayers(s).find((l) => l.content.isGroup)!;
      const member = artGroupMembers(group.content)[0].merge.id;
      s = run(s, { type: "art_add_mask", id: member });
      const mid = artMaskOf(s, member)!.id;
      s = run(s, { type: "art_remove_layer", id: member });
      // The mask node, its wires and both boundary hops are gone, the
      // same cleanup a top-level masked layer gets.
      expect(s.nodes.some((n) => n.id === mid)).toBe(false);
      expect(s.wires.some((w) => w.from === mid || w.to === mid)).toBe(false);
      const art = s.nodes.find((n) => n.id === "art")!;
      expect((art.groupBoundary ?? []).some((w) => w.from === mid)).toBe(false);
      const inner = art.groupNodes!.find((n) => n.isGroup);
      expect(inner && (inner.groupBoundary ?? []).some((w) => w.from === mid)).toBeFalsy();
    });

    it("grouping refuses gaps and nesting", () => {
      let s = add(add(add(initialState())));
      // A gap: b1 and b3 without b2.
      expect(run(s, { type: "art_group_layers", ids: ["art_b1", "art_b3"] })).toBe(s);
      // Groups do not nest (v1).
      let g = run(s, { type: "art_group_layers", ids: ["art_b2", "art_b3"] });
      const groupBlend = artLayers(g).find((l) => l.content.isGroup)!.blend.id;
      expect(run(g, { type: "art_group_layers", ids: [groupBlend] })).toBe(g);
    });

    /// A document saved before 2026-08-27 carries its group members on
    /// merges, which have no mask port, no mode and no clip port. The
    /// MEMBER_CARRIER comment promised a load-time migration
    /// (migrateGroupCarriers); it was never written. Without it an old
    /// group's mode dropdown dispatches into art_layer_set, which
    /// silently skips the mode write on a merge.
    it("converts pre-blend group carriers to blends on load", async () => {
      const { migrateGraph, artGroupMembers } = await import("../state");
      let s = add(add(initialState()));
      s = run(s, { type: "art_group_layers", ids: ["art_b1", "art_b2"] });
      // Age the document: carriers back to merges, modes gone.
      const aged = {
        ...s,
        nodes: s.nodes.map((n) =>
          n.id === "art"
            ? {
                ...n,
                groupNodes: (n.groupNodes ?? []).map((g) =>
                  g.isGroup
                    ? {
                        ...g,
                        groupNodes: (g.groupNodes ?? []).map((m) =>
                          m.type === "heeler.blend" && m.id.includes("_m")
                            ? { ...m, type: "heeler.merge", textParams: undefined }
                            : m,
                        ),
                      }
                    : g,
                ),
              }
            : n,
        ),
      };
      const migrated = migrateGraph(aged.nodes, aged.wires);
      const art = migrated.nodes.find((n) => n.id === "art")!;
      const grp = art.groupNodes!.find((n) => n.isGroup)!;
      const members = artGroupMembers(grp);
      expect(members.length).toBe(2);
      expect(members.every((m) => m.merge.type === "heeler.blend")).toBe(true);
      expect(members.every((m) => m.merge.textParams?.mode === "normal")).toBe(true);
      // The composite does not move: the wiring is untouched, and a
      // blend at normal composites exactly as the merge it replaces.
      expect(grp.groupWires).toEqual(
        (aged.nodes.find((n) => n.id === "art")!.groupNodes!.find((n) => n.isGroup)!).groupWires,
      );
    });

    /// The menu must say so when the reducer would refuse: a silent
    /// dispatch is how "inert control" bugs are born. Group Layers is
    /// disabled for a gapped selection or one with a group in it, which
    /// are exactly art_group_layers' two refusals.
    it("offers Group Layers only when the reducer would accept it", async () => {
      const { layerActions } = await import("../layeractions");
      const groupItem = (s: State, id: string) =>
        layerActions(s, id).find((a) => a.kind === "item" && a.testid === "art-menu-group");
      let s = add(add(add(initialState())));
      // A gap: b1 and b3 without b2.
      s = run(s, { type: "select_art_layers", ids: ["art_b1", "art_b3"] });
      expect(groupItem(s, "art_b1")).toMatchObject({ disabled: true });
      // Contiguous and ungrouped: offered.
      s = run(s, { type: "select_art_layers", ids: ["art_b1", "art_b2"] });
      expect(groupItem(s, "art_b1")).toMatchObject({ disabled: false });
      // A group in the selection nests, and nesting is refused.
      let g = run(s, { type: "art_group_layers", ids: ["art_b1", "art_b2"] });
      const gid = artLayers(g).find((l) => l.content.isGroup)!.blend.id;
      g = run(g, { type: "select_art_layers", ids: [gid, "art_b3"] });
      expect(groupItem(g, gid)).toMatchObject({ disabled: true });
    });

    it("effects run between the content and the blend, in their own order", () => {
      let s = add(initialState());
      s = run(
        s,
        { type: "art_add_fx", id: "art_b1", fx: "shadow" },
        { type: "art_add_fx", id: "art_b1", fx: "glow" },
      );
      const fx = artLayers(s)[0].fx;
      expect(fx.map((f) => f.type)).toEqual(["heeler.fx_shadow", "heeler.fx_glow"]);

      // The chain the engine sees: content, then each effect in order,
      // then the blend's second input. This is the whole claim, so it
      // gets asserted wire by wire.
      const g = serializeGraph(s);
      const link = (from: string, to: string, port = "in") =>
        g.connections.some(
          (c: any) => c.from[0] === from && c.to[0] === to && c.to[1] === port,
        );
      expect(link("art_p1", "__fx_shape_art_b1", "fg")).toBe(true);
      expect(link("__fx_shape_art_b1", fx[0].id)).toBe(true);
      expect(link(fx[0].id, fx[1].id)).toBe(true);
      expect(link(fx[1].id, "art_b1", "fg")).toBe(true);
      // The content no longer feeds the blend directly.
      expect(link("art_p1", "art_b1", "fg")).toBe(false);

      // Reordering rewires rather than re-rendering something stale.
      s = run(s, { type: "art_fx_move", id: "art_b1", fxId: fx[1].id, delta: -1 });
      const g2 = serializeGraph(s);
      expect(
        g2.connections.some((c: any) => c.from[0] === "__fx_shape_art_b1" && c.to[0] === fx[1].id),
      ).toBe(true);

      // Removing the last one hands the blend back to the content.
      s = run(s, { type: "art_remove_fx", id: "art_b1", fxId: fx[0].id });
      s = run(s, { type: "art_remove_fx", id: "art_b1", fxId: fx[1].id });
      expect(artLayers(s)[0].fx).toHaveLength(0);
      const g3 = serializeGraph(s);
      expect(
        g3.connections.some(
          (c: any) => c.from[0] === "art_p1" && c.to[0] === "art_b1" && c.to[1] === "fg",
        ),
      ).toBe(true);
    });

    it("a Fill hole's mask starts empty and un-inverted: paint to reveal", async () => {
      // No live selection kind since 2026-09-30: a layer mask is always
      // the paintable kind, and the Fill layer's hole is the brush's
      // other polarity.
      const { artMaskOf } = await import("../state");
      let s = add(initialState());
      s = run(s, { type: "art_add_mask", id: "art_b1", kind: "fill" });
      const mask = artMaskOf(s, "art_b1")!;
      expect(mask.type).toBe("heeler.brush_mask");
      expect(mask.params.invert ?? 0).toBe(0);
      expect(mask.strokes).toEqual([]);
    });

    it("opacity, mode, visibility and strokes land on the right nodes", () => {
      let s = add(initialState());
      const id = artLayers(s)[0].blend.id;
      s = run(
        s,
        { type: "art_layer_set", id, opacity: 60, mode: "multiply" },
        { type: "art_layer_set", id, enabled: false },
        {
          type: "art_add_stroke",
          id,
          stroke: { points: [[0.5, 0.5]], radius: 0.1, color: "#ff0000" },
        },
      );
      const l = artLayers(s)[0];
      expect(l.blend.params.opacity).toBe(60);
      expect(l.blend.textParams?.mode).toBe("multiply");
      expect(l.blend.enabled).toBe(false);
      expect(l.content.strokes?.length).toBe(1);
      expect(l.content.strokes?.[0].color).toBe("#ff0000");
      // The stroke marks the photograph edited, like any real edit.
      expect(s.images.find((i) => i.id === s.activeImage)?.edited).toBe(true);
      // And an undo walks it back.
      const undone = run(s, { type: "undo" });
      expect(artLayers(undone)[0].content.strokes ?? []).toHaveLength(0);
    });
  });

  describe("region-of-interest at 1:1", () => {
    it("visibleRoi inverts zoom and pan into frame coordinates", async () => {
      const { visibleRoi } = await import("../ui/viewer");
      const stage = { w: 800, h: 600 };
      const basebox = { w: 800, h: 600 };
      // 4x zoom, centered: a quarter of the frame plus the margin.
      let r = visibleRoi(stage, basebox, { x: 0, y: 0 }, 4, 0);
      expect(r[0]).toBeGreaterThan(0.3);
      expect(r[0]).toBeLessThan(0.36);
      expect(r[2]).toBeGreaterThan(0.3);
      expect(r[2]).toBeLessThan(0.4);
      // Dragging the image right reveals its left side: the rect's
      // right edge moves left of where the centered rect's sat.
      const centered = visibleRoi(stage, basebox, { x: 0, y: 0 }, 4, 0);
      r = visibleRoi(stage, basebox, { x: 200, y: 0 }, 4, 0);
      expect(r[0] + r[2]).toBeLessThan(centered[0] + centered[2]);
      // At fit-ish scale the whole frame is visible.
      r = visibleRoi(stage, basebox, { x: 0, y: 0 }, 1, 0);
      expect(r[0]).toBe(0);
      expect(r[2]).toBe(1);
      // A 90-degree view rotation swaps which axis sees more frame.
      r = visibleRoi(stage, basebox, { x: 0, y: 0 }, 4, 90);
      expect(r[2]).toBeLessThan(r[3]);
      // Never outside the frame, never below the crop op's minimum.
      for (const rect of [
        visibleRoi(stage, basebox, { x: 5000, y: -5000 }, 32, 37),
        visibleRoi(stage, basebox, { x: 0, y: 0 }, 32, 0),
      ]) {
        expect(rect[0]).toBeGreaterThanOrEqual(0);
        expect(rect[1]).toBeGreaterThanOrEqual(0);
        expect(rect[0] + rect[2]).toBeLessThanOrEqual(1 + 1e-9);
        expect(rect[1] + rect[3]).toBeLessThanOrEqual(1 + 1e-9);
        expect(rect[2]).toBeGreaterThanOrEqual(0.05);
        expect(rect[3]).toBeGreaterThanOrEqual(0.05);
      }
    });

    it("the patch follows the photograph and the tier", () => {
      const patch = {
        url: "data:x",
        rect: [0.25, 0.25, 0.5, 0.5] as [number, number, number, number],
        frame: [6000, 4000] as [number, number],
        imageId: "4871",
        look: "",
      };
      let s = run(initialState(), { type: "set_roi_patch", patch });
      expect(s.view.roiPatch?.imageId).toBe("4871");
      // A patch for a photo no longer on screen is refused outright.
      s = run(s, { type: "set_roi_patch", patch: { ...patch, imageId: "elsewhere" } });
      expect(s.view.roiPatch?.imageId).toBe("4871");
      // Leaving 1:1 drops it with the tier.
      s = run(s, { type: "set_zoom", zoom: "fit" });
      expect(s.view.roiPatch).toBeNull();
      // Switching photos drops it too.
      s = run(initialState(), { type: "set_roi_patch", patch });
      s = run(s, { type: "select_image", id: "4868" });
      expect(s.view.roiPatch).toBeNull();
    });
  });

  it("desktop boot clears the bundled sample session", () => {
    let s = initialState();
    s = { ...s, activeFolderPath: "/old/day", folderTree: { name: "Old", path: "/old", expanded: true, children: [] } };
    expect(s.images.length).toBeGreaterThan(0);
    s = reduce(s, { type: "begin_session_load" });
    expect(s.images).toEqual([]);
    expect(s.activeImage).toBe("");
    expect(s.libraryLabel).toBe("Loading…");
    // The tree and folder path go too. The session saver keys off them,
    // and a catalog switch that left them standing had the saver write
    // the old catalog's folders into the newly opened one.
    expect(s.folderTree).toBeNull();
    expect(s.activeFolderPath).toBeNull();
  });

  it("panel sizes clamp to sane bounds", () => {
    let s = initialState();
    s = reduce(s, { type: "set_panel_size", panel: "library", size: 50 });
    expect(s.panelSizes.library).toBe(180);
    s = reduce(s, { type: "set_panel_size", panel: "library", size: 9999 });
    expect(s.panelSizes.library).toBe(420);
    s = reduce(s, { type: "set_panel_size", panel: "right", size: 400 });
    expect(s.panelSizes.right).toBe(400);
    s = reduce(s, { type: "set_panel_size", panel: "graphViewer", size: 500 });
    expect(s.panelSizes.graphViewer).toBe(500);
  });

  it("crop aspect is a ui setting, not an undoable edit", () => {
    let s = initialState();
    const depth = s.undoStack.length;
    s = reduce(s, { type: "set_crop_aspect", aspect: 1.5 });
    expect(s.cropAspect).toBe(1.5);
    expect(s.undoStack.length).toBe(depth);
    s = reduce(s, { type: "set_crop_aspect", aspect: null });
    expect(s.cropAspect).toBe(null);
  });

  it("backdrops move their nodes, resize with floors, and undo", () => {
    let s = initialState();
    const exposure = () => s.nodes.find((n) => n.id === "exposure")!;
    const start = { x: exposure().x, y: exposure().y };
    // Backdrop around the exposure node's position.
    s = reduce(s, {
      type: "add_backdrop",
      backdrop: { id: "bd_1", name: "Tone", x: start.x - 20, y: start.y - 30, w: 220, h: 180, color: 0 },
    });
    expect(s.backdrops.length).toBe(1);

    // Moving the backdrop carries the node inside it.
    s = reduce(s, { type: "move_backdrop", id: "bd_1", dx: 40, dy: 25 });
    expect(exposure().x).toBe(start.x + 40);
    expect(exposure().y).toBe(start.y + 25);

    // Resize clamps to a usable floor.
    s = reduce(s, { type: "resize_backdrop", id: "bd_1", w: 10, h: 10 });
    expect(s.backdrops[0].w).toBe(120);
    expect(s.backdrops[0].h).toBe(80);

    s = reduce(s, { type: "rename_backdrop", id: "bd_1", name: "Tonal work" });
    expect(s.backdrops[0].name).toBe("Tonal work");

    // Undo walks the whole chain back out, nodes included.
    s = reduce(s, { type: "undo" }); // rename
    s = reduce(s, { type: "undo" }); // resize
    s = reduce(s, { type: "undo" }); // move
    expect(exposure().x).toBe(start.x);
    s = reduce(s, { type: "undo" }); // add
    expect(s.backdrops.length).toBe(0);
  });

  it("backdrops stay with their image across switches", () => {
    let s = initialState();
    s = reduce(s, {
      type: "add_backdrop",
      backdrop: { id: "bd_1", name: "Look", x: 0, y: 0, w: 200, h: 120, color: 1 },
    });
    s = reduce(s, { type: "select_image", id: "4869" });
    expect(s.backdrops.length).toBe(0, );
    s = reduce(s, { type: "select_image", id: "4871" });
    expect(s.backdrops.length).toBe(1);
    expect(s.backdrops[0].name).toBe("Look");
  });

  it("arrange_nodes puts every node downstream of what feeds it", () => {
    // "the node graph is a mess. We need nodes to automatically
    // organize and layout." This used to lay out a column per node CATEGORY,
    // which reads well until you look at the wires: every color node landed
    // in one column whatever its place in the chain, so the wires zigzagged.
    let s = reduce(initialState(), { type: "arrange_nodes" });
    const at = (id: string) => s.nodes.find((n) => n.id === id)!;

    // The property that makes a graph readable: no wire doubles back.
    const backwards = s.wires
      .filter((w) => w.kind === "image")
      .filter((w) => {
        const from = s.nodes.find((n) => n.id === w.from);
        const to = s.nodes.find((n) => n.id === w.to);
        return from && to && to.x <= from.x;
      })
      .map((w) => `${w.from} -> ${w.to}`);
    expect(backwards, "these wires point back up the canvas").toEqual([]);

    // And the chain reads left to right, which is the same statement said
    // the way a person would check it.
    expect(at("src").x).toBeLessThan(at("stdcolor").x);
    expect(at("stdcolor").x).toBeLessThan(at("sharpen").x);
    expect(at("output").x).toBeGreaterThan(at("sharpen").x);

    // Nothing overlaps: within a column every node has its own row.
    const byColumn = new Map<number, number[]>();
    for (const n of s.nodes) byColumn.set(n.x, [...(byColumn.get(n.x) ?? []), n.y]);
    for (const [x, ys] of byColumn) {
      expect(new Set(ys).size, `two nodes share a spot in column ${x}`).toBe(ys.length);
    }

    // Masks sit below the image chain, where every node editor draws them.
    const masks = s.nodes.filter((n) => n.maskOut);
    const chain = s.nodes.filter((n) => !n.maskOut && !/^layer_/.test(n.id));
    expect(Math.min(...masks.map((n) => n.y))).toBeGreaterThan(
      Math.min(...chain.map((n) => n.y)),
    );

    // Undoable in one step.
    const before = initialState().nodes.find((n) => n.id === "src")!.x;
    s = reduce(s, { type: "undo" });
    expect(at("src").x).toBe(before);
  });

  it("library rail toggles the browser open and closed", () => {
    let s = initialState();
    expect(s.browserOpen).toBe(true);
    s = run(s, { type: "toggle_browser" });
    expect(s.browserOpen).toBe(false);
    s = run(s, { type: "toggle_browser" });
    expect(s.browserOpen).toBe(true);
  });

  it("set_curve edits one channel and round-trips through undo", () => {
    const s0 = initialState();
    const bent: [number, number][] = [[0, 0], [0.25, 0.3], [0.5, 0.62], [0.75, 0.8], [1, 1]];
    let s = run(s0, { type: "set_curve", id: "curves", channel: "r", curve: bent });
    const curves = () => s.nodes.find((n) => n.id === "curves")!.curves!;
    expect(curves().r).toEqual(bent);
    expect(curves().rgb).toBeUndefined();
    s = run(s, { type: "undo" });
    expect(curves().r).toBeUndefined();
  });

  it("takes branch, isolate, and switch back", () => {
    const exposureOf = (st: State) => st.nodes.find((n) => n.id === "exposure")!.params.exposure;
    let s = run(initialState(), { type: "set_param", id: "exposure", param: "exposure", value: 2 });
    s = run(s, { type: "new_take" });
    expect(s.takes["4871"].length).toBe(2);
    expect(s.activeTakes["4871"]).toBe("take_2");
    expect(exposureOf(s)).toBe(2, );

    s = run(s, { type: "set_param", id: "exposure", param: "exposure", value: -1 });
    s = run(s, { type: "switch_take", takeId: "take_1" });
    expect(exposureOf(s)).toBe(2, );
    s = run(s, { type: "switch_take", takeId: "take_2" });
    expect(exposureOf(s)).toBe(-1);
  });

  it("slider drags coalesce into a single history entry per gesture", () => {
    let s = run(initialState(), { type: "begin_gesture", key: "exposure.exposure" });
    for (const v of [0.7, 0.8, 0.9, 1.0, 1.1]) {
      s = run(s, { type: "set_param", id: "exposure", param: "exposure", value: v });
    }
    expect(s.undoStack.length).toBe(1, );
    expect(s.nodes.find((n) => n.id === "exposure")!.params.exposure).toBe(1.1);
    s = run(s, { type: "end_gesture" });

    // One undo reverts the whole drag.
    s = run(s, { type: "undo" });
    expect(s.nodes.find((n) => n.id === "exposure")!.params.exposure).toBe(0.62);

    // A second drag on the same control is its own entry.
    s = run(s, { type: "begin_gesture", key: "exposure.exposure" });
    s = run(s, { type: "set_param", id: "exposure", param: "exposure", value: 2 });
    s = run(s, { type: "set_param", id: "exposure", param: "exposure", value: 2.5 });
    s = run(s, { type: "end_gesture" });
    expect(s.undoStack.length).toBe(1);
  });

  it("a lens profile apply is one command, one undo step, both kinds of param", () => {
    // The Lens panel's Apply writes the model name (text) and its
    // coefficients (numbers) as a single set_params, so one Cmd+Z takes
    // the whole profile off again.
    let s = run(initialState(), {
      type: "set_params",
      id: "lens",
      values: {
        dist_a: 0.02,
        dist_b: -0.06,
        dist_c: 0.01,
        dist_scale: 1,
        tca_vr: 1.0006,
        tca_vb: 0.9998,
        vig_k1: -0.9,
      },
      text: { dist_model: "ptlens" },
    });
    expect(s.undoStack.length).toBe(1);
    const lens = s.nodes.find((n) => n.id === "lens")!;
    expect(lens.params.dist_a).toBeCloseTo(0.02);
    expect(lens.params.tca_vr).toBeCloseTo(1.0006);
    expect(lens.params.vig_k1).toBeCloseTo(-0.9);
    expect(lens.textParams?.dist_model).toBe("ptlens");
    // And the engine sees it: the serialized node carries the model.
    const g = serializeGraph(s);
    const gl = g.nodes.find((n) => n.id === "lens")!;
    const gp = gl.params as Record<string, unknown>;
    expect(gp.dist_model).toBe("ptlens");
    expect(gp.dist_b as number).toBeCloseTo(-0.06);

    s = run(s, { type: "undo" });
    const back = s.nodes.find((n) => n.id === "lens")!;
    expect(back.textParams?.dist_model).toBeUndefined();
    expect(back.params.dist_a).toBeUndefined();
  });

  it("edits outside the gesture key still record individually", () => {
    let s = run(initialState(), { type: "begin_gesture", key: "exposure.exposure" });
    s = run(s, { type: "set_param", id: "exposure", param: "exposure", value: 1 });
    s = run(s, { type: "set_param", id: "exposure", param: "contrast", value: 40 });
    expect(s.undoStack.length).toBe(2, );
  });

  it("clear_history purges both stacks without touching the edit", () => {
    let s = run(initialState(), { type: "set_param", id: "exposure", param: "exposure", value: 2 });
    s = run(s, { type: "undo" }, { type: "redo" });
    expect(s.undoStack.length).toBe(1);
    s = run(s, { type: "clear_history" });
    expect(s.undoStack.length).toBe(0);
    expect(s.redoStack.length).toBe(0);
    expect(s.nodes.find((n) => n.id === "exposure")!.params.exposure).toBe(2);
  });

  it("history snapshots carry labels and jump_history reverts en masse", () => {
    let s = run(
      initialState(),
      { type: "set_param", id: "exposure", param: "exposure", value: 1 },
      { type: "set_param", id: "exposure", param: "contrast", value: 50 },
      { type: "set_enabled", id: "grain", enabled: false }
    );
    expect(s.undoStack.map((u) => u.label)).toEqual([
      "Exposure: exposure",
      "Exposure: contrast",
      "Disable Grain",
    ]);
    s = run(s, { type: "jump_history", index: 1 });
    const e = s.nodes.find((n) => n.id === "exposure")!;
    expect(e.params.exposure).toBe(1);
    expect(e.params.contrast).toBe(18, );
    expect(s.nodes.find((n) => n.id === "grain")!.enabled).toBe(true);
    expect(s.undoStack.length).toBe(1);
  });

  it("each image keeps its own graph and undo history", () => {
    let s = initialState();
    const exposureOf = (st: State) => st.nodes.find((n) => n.id === "exposure")!.params.exposure;
    s = run(s, { type: "set_param", id: "exposure", param: "exposure", value: 2 });
    expect(exposureOf(s)).toBe(2);

    // A freshly selected image starts from the NEUTRAL default graph, not
    // the sample session's demo edit.
    s = run(s, { type: "select_image", id: "4869" });
    expect(exposureOf(s)).toBe(0);
    expect(s.undoStack.length).toBe(0);

    s = run(s, { type: "set_param", id: "exposure", param: "exposure", value: 1 });
    s = run(s, { type: "select_image", id: "4871" });
    expect(exposureOf(s)).toBe(2);
    s = run(s, { type: "undo" });
    expect(exposureOf(s)).toBe(0.62);

    s = run(s, { type: "select_image", id: "4869" });
    expect(exposureOf(s)).toBe(1);
  });

  it("the default graph for new images is neutral", () => {
    const s = initialState();
    const of = (id: string) => s.defaultGraph.nodes.find((n) => n.id === id)!.params;
    expect(of("exposure").exposure).toBe(0);
    expect(of("exposure").contrast).toBe(0);
    expect(of("stdcolor").temperature).toBe(6500);
    expect(of("stdcolor").saturation).toBe(0);
    // The names the engine actually reads. This used to be `sharpening`,
    // which no node declares, so the slider writing it did nothing at all.
    // Sharpen ships without a node now; the stand-in the row reads
    // carries the same neutral.
    const fresh = { ...s, nodes: s.defaultGraph.nodes, wires: s.defaultGraph.wires };
    expect(s.defaultGraph.nodes.some((n) => n.id === "sharpen")).toBe(false);
    expect(toolNode(fresh, "sharpen")!.params.amount).toBe(0);
  });

  it("a category builds neutral, however long it has been off", () => {
    // Same promise as the nodes that ship in the graph, made at a different
    // time: switching Grain on must not arrive with grain already on the
    // picture. `grain_amount` is the name that never worked.
    let s: State = initialState();
    s = { ...s, nodes: s.defaultGraph.nodes, wires: s.defaultGraph.wires };
    s = run(s, { type: "set_category", title: "Grain", on: true });
    s = run(s, { type: "set_category", title: "Vignette", on: true });
    s = run(s, { type: "set_category", title: "Color Wheels", on: true });
    expect(s.nodes.find((n) => n.id === "grain")!.params.intensity).toBe(0);
    expect(s.nodes.find((n) => n.id === "cbal")!.params.midtones_lum).toBe(0);
    // Vignette too: an effect switched on is an effect at zero.
    expect(s.nodes.find((n) => n.id === "vignette")!.params.vignette).toBe(0);
  });

  it("replace_graph swaps content without history", () => {
    let s = initialState();
    const nodes = structuredClone(s.nodes);
    nodes.find((n) => n.id === "exposure")!.params.exposure = 3;
    s = run(s, { type: "replace_graph", nodes, wires: structuredClone(s.wires) });
    expect(s.nodes.find((n) => n.id === "exposure")!.params.exposure).toBe(3);
    expect(s.undoStack.length).toBe(0);
  });

  it("set_params batches into a single undo entry", () => {
    let s = run(initialState(), {
      type: "set_params",
      id: "crop",
      values: { crop_x: 0.1, crop_w: 0.5, crop_h: 0.4 },
    });
    const crop = () => s.nodes.find((n) => n.id === "crop")!;
    expect(crop().params.crop_x).toBe(0.1);
    expect(crop().params.crop_w).toBe(0.5);
    s = run(s, { type: "undo" });
    const after = s.nodes.find((n) => n.id === "crop")!;
    expect(after.params.crop_x).toBe(0);
    expect(after.params.crop_w).toBe(1);
    expect(after.params.crop_h).toBe(1);
  });

  /// "Brush layer mask doesn't seem to be working."
  ///
  /// It was not. Adding a brush layer created the nodes and wired them
  /// correctly, and then nothing happened, because the viewer only
  /// paints while state.tool is "brush" and nothing ever set it. Radial
  /// and linear masks place themselves the moment their layer is
  /// active, so brush was the one mask type that silently required the
  /// user to go and find the toolbar.
  describe("a brush layer hands you the brush", () => {
    it("arms the brush tool when the layer is created", () => {
      const s = run(initialState(), { type: "add_layer", maskType: "brush" });
      expect(s.tool).toBe("brush");
      // And the layer it armed it for is the active one, so the overlay
      // has a mask node to paint into.
      expect(s.activeLayer).toBeTruthy();
      expect(
        s.nodes.find((n) => n.id === s.activeLayer!.replace("_adj", "_mask"))?.type
      ).toBe("heeler.brush_mask");
    });

    it("leaves the tool alone for the mask types that place themselves", () => {
      for (const maskType of ["radial", "linear", "range"] as const) {
        expect(run(initialState(), { type: "add_layer", maskType }).tool).toBe("none");
      }
    });

    it("arms and disarms as you move between layers", () => {
      let s = run(initialState(), { type: "add_layer", maskType: "radial" });
      const radial = s.activeLayer!;
      s = run(s, { type: "add_layer", maskType: "brush" });
      const brush = s.activeLayer!;
      expect(s.tool).toBe("brush");

      // Back to the radial layer: the brush must not outlive the layer
      // it belonged to, or the radial overlay never appears.
      s = run(s, { type: "set_active_layer", id: radial });
      expect(s.tool).toBe("none");

      s = run(s, { type: "set_active_layer", id: brush });
      expect(s.tool).toBe("brush");
    });

    it("does not take a tool the user chose for themselves", () => {
      let s = run(initialState(), { type: "add_layer", maskType: "radial" });
      s = run(s, { type: "set_tool", tool: "crop" });
      s = run(s, { type: "set_active_layer", id: s.activeLayer });
      expect(s.tool).toBe("crop");
    });
  });

  it("brush strokes append, clear, and undo", () => {
    const stroke = { points: [[0.2, 0.2], [0.4, 0.4]] as [number, number][], radius: 0.04 };
    let s = run(initialState(), { type: "add_stroke", id: "brushmask", stroke });
    const strokes = () => s.nodes.find((n) => n.id === "brushmask")!.strokes ?? [];
    expect(strokes().length).toBe(1);
    s = run(s, { type: "add_stroke", id: "brushmask", stroke: { ...stroke, erase: true } });
    expect(strokes().length).toBe(2);
    s = run(s, { type: "clear_strokes", id: "brushmask" });
    expect(strokes().length).toBe(0);
    s = run(s, { type: "undo" });
    expect(strokes().length).toBe(2);
  });

  it("tool selection toggles and brush radius clamps", () => {
    let s = run(initialState(), { type: "set_tool", tool: "crop" });
    expect(s.tool).toBe("crop");
    s = run(s, { type: "set_tool", tool: "crop" });
    expect(s.tool).toBe("none");
    s = run(s, { type: "set_brush_radius", radius: 5 });
    expect(s.brushRadius).toBe(0.3);
  });

  it("layers splice into the chain and heal on removal", () => {
    let s = run(initialState(), { type: "add_layer", maskType: "range" });
    // Adjustment spliced after the base exposure node.
    expect(s.wires.some((w) => w.from === "exposure" && w.to === "layer_1_adj")).toBe(true);
    // The Tone EQ sits between Exposure and B&W since M5.5, and a layer
    // splices in FRONT of it: zone exposure should see layered edits.
    expect(s.wires.some((w) => w.from === "layer_1_adj" && w.to === "toneeq")).toBe(true);
    // Mask reads the post-geometry image (the sample's crop, then its
    // lens correction) and gates the adjustment.
    expect(s.wires.some((w) => w.from === "lens" && w.to === "layer_1_mask")).toBe(true);
    expect(s.wires.some((w) => w.from === "layer_1_mask" && w.to === "layer_1_adj" && w.toPort === "mask")).toBe(true);
    expect(s.activeLayer).toBe("layer_1_adj");

    // Second layer chains after the first.
    s = run(s, { type: "add_layer", maskType: "radial" });
    expect(s.wires.some((w) => w.from === "layer_1_adj" && w.to === "layer_2_adj")).toBe(true);
    expect(s.wires.some((w) => w.from === "layer_2_adj" && w.to === "toneeq")).toBe(true);

    // Removing the middle layer heals the chain around it.
    s = run(s, { type: "remove_layer", id: "layer_1_adj" });
    expect(s.nodes.some((n) => n.id === "layer_1_adj")).toBe(false);
    expect(s.wires.some((w) => w.from === "exposure" && w.to === "layer_2_adj")).toBe(true);
    // Undo restores everything.
    s = run(s, { type: "undo" });
    expect(s.nodes.some((n) => n.id === "layer_1_mask")).toBe(true);
  });

  it("range_select layer params serialize to the backend graph", () => {
    let s = run(initialState(), { type: "add_layer", maskType: "range" });
    s = run(s, { type: "set_param", id: "layer_1_mask", param: "luma_high", value: 0.4 });
    s = run(s, { type: "set_param", id: "layer_1_adj", param: "exposure", value: 1.2 });
    const nodes = serializeGraph(s).nodes;
    expect((nodes.find((n) => n.id === "layer_1_mask")!.params as any).luma_high).toBe(0.4);
    expect((nodes.find((n) => n.id === "layer_1_adj")!.params as any).exposure).toBe(1.2);
  });

  it("reset_curves clears every channel and undoes", () => {
    const bent: [number, number][] = [[0, 0], [0.5, 0.7], [1, 1]];
    let s = run(
      initialState(),
      { type: "set_curve", id: "curves", channel: "rgb", curve: bent },
      { type: "set_curve", id: "curves", channel: "luma", curve: bent },
      { type: "reset_curves", id: "curves" }
    );
    const curves = () => s.nodes.find((n) => n.id === "curves")!.curves!;
    expect(Object.keys(curves()).length).toBe(0);
    s = run(s, { type: "undo" });
    expect(curves().luma).toEqual(bent);
  });

  it("split position clamps to sane bounds", () => {
    let s = run(initialState(), { type: "toggle_split" }, { type: "set_split_pos", pos: 1.4 });
    expect(s.splitOn).toBe(true);
    expect(s.view.splitPos).toBe(0.95);
    s = run(s, { type: "set_split_pos", pos: -2 });
    expect(s.view.splitPos).toBe(0.05);
  });
});

describe("healed deletes", () => {
  it("delete with heal splices the chain shut; without, the gap stays", () => {
    // src -> merge -> ... the sample chain. Delete the exposure node
    // healed: whatever fed it now feeds what it fed.
    let s = initialState();
    const fedBy = s.wires.find((w) => w.to === "exposure" && w.kind === "image")!.from;
    const fed = s.wires.filter((w) => w.from === "exposure").map((w) => w.to);
    expect(fed.length).toBeGreaterThan(0);
    const healed = run(s, { type: "delete_nodes", ids: ["exposure"], heal: true });
    for (const to of fed) {
      expect(healed.wires).toContainEqual(
        expect.objectContaining({ from: fedBy, to }),
      );
    }
    // Unhealed: the neighbors are left unconnected, the old behavior.
    const gapped = run(s, { type: "delete_nodes", ids: ["exposure"] });
    expect(gapped.wires.some((w) => w.from === fedBy && fed.includes(w.to))).toBe(false);
  });

  it("deleting a whole run keeps everything downstream fed", () => {
    const s = initialState();
    const outOfLast = s.wires
      .filter((w) => w.from === "exposure" && w.kind === "image")
      .map((w) => w.to);
    expect(outOfLast.length).toBeGreaterThan(0);
    const healed = run(s, { type: "delete_nodes", ids: ["stdcolor", "exposure"], heal: true });
    // Whatever the run used to feed is still fed by something live,
    // and nothing references the dead.
    for (const to of outOfLast) {
      expect(healed.wires.some((w) => w.to === to && w.kind === "image")).toBe(true);
    }
    expect(
      healed.wires.some((w) => ["stdcolor", "exposure"].includes(w.from) || ["stdcolor", "exposure"].includes(w.to)),
    ).toBe(false);
  });
});

describe("reset renders the same picture the thumbnail shows", () => {
  it("the fresh graph's tone profile is born wearing today's defaults", () => {
    // The owner's before/after screenshots: reset left the viewer
    // darker than the thumbnail until a switch away and back
    // re-applied the profile defaults. The template carries them from
    // birth now.
    const s = run(initialState(), { type: "reset_image_edits", id: initialState().activeImage });
    const profile = s.nodes.find((n) => n.type === "heeler.tone_profile")!;
    expect(profile.params.baseline_ev).toBeDefined();
    expect(profile.params.shadow_toe).toBeDefined();
    expect(profile.params.highlight_rolloff).toBeDefined();
    // And the load-effect's upgrade recognizes it as already current,
    // so nothing double-applies on the next visit.
    expect(profile.params.baseline_ev).not.toBe(0);
  });
});

describe("the Color Set mask overlay", () => {
  it("only the eye toggle points the viewer at the set's mask; the dropper alone does not", () => {
    let s = run(initialState(), { type: "add_color_set" });
    expect(maskPreviewNode(s)).toBe(null);
    s = run(s, { type: "toggle_cset_mask_view", n: 1 });
    expect(maskPreviewNode(s)).toBe("cset1_mask");
    s = run(s, { type: "toggle_cset_mask_view", n: 1 });
    expect(maskPreviewNode(s)).toBe(null);
    // Arming the dropper no longer forces the overlay. The owner's
    // overrule: "It should not default to mask on, only when the mask
    // button is toggled on while using the picker."
    s = run(s, { type: "arm_cset_dropper", n: 1 });
    expect(maskPreviewNode(s)).toBe(null);
    // A deleted set cannot be shown, however stale the toggle.
    s = run(s, { type: "toggle_cset_mask_view", n: 1 });
    s = run(s, { type: "remove_color_set", n: 1 });
    expect(maskPreviewNode(s)).toBe(null);
  });

  it("deleting the set disarms its own dropper and eye, and only its own", () => {
    // "If I delete the color set while the picker for that
    // same set is active, the picker tool stays active. My cursor does
    // not reset until I add a new color set."
    let s = run(initialState(), { type: "add_color_set" }, { type: "add_color_set" });
    s = run(s, { type: "arm_cset_dropper", n: 1 }, { type: "toggle_cset_mask_view", n: 1 });
    const other = run(s, { type: "remove_color_set", n: 2 });
    expect(other.csetDropper).toBe(1);
    expect(other.csetMaskView).toBe(1);
    const gone = run(s, { type: "remove_color_set", n: 1 });
    expect(gone.csetDropper).toBe(null);
    expect(gone.csetMaskView).toBe(null);
  });

  it("the gamut warning's fix splices a Gamut Map after the culprit", () => {
    // One click, ordinary graph surgery, one undo step. Every image
    // consumer of the culprit must now listen to the map instead; no
    // wire may skip it.
    let s = run(initialState(), { type: "add_gamut_map_after", id: "exposure" });
    const gm = s.nodes.find((n) => n.type === "heeler.gamut_map")!;
    expect(gm).toBeTruthy();
    expect(gm.params.amount).toBe(100);
    const feed = s.wires.find((w) => w.to === gm.id && w.toPort === "in")!;
    expect(feed.from).toBe("exposure");
    expect(s.wires.some((w) => w.from === gm.id)).toBe(true);
    expect(
      s.wires.some((w) => w.from === "exposure" && w.kind === "image" && w.to !== gm.id),
    ).toBe(false);
    expect(s.undoStack.length).toBe(1);
    s = run(s, { type: "undo" });
    expect(s.nodes.some((n) => n.type === "heeler.gamut_map")).toBe(false);
    // A culprit the graph does not have is a no-op, not a crash.
    expect(run(s, { type: "add_gamut_map_after", id: "never_was" }).nodes).toEqual(s.nodes);
  });

  it("a stage probe outranks the mask views and clears on photo switch", () => {
    // The probe rides the same arbitrary-terminal render path as the mask
    // views, so precedence is decided here in one function and nowhere
    // else.
    let s = run(initialState(), { type: "add_color_set" });
    s = run(s, { type: "toggle_cset_mask_view", n: 1 });
    s = run(s, { type: "probe_node", id: "exposure" });
    expect(maskPreviewNode(s)).toBe("exposure");
    // Toggle contract: probing the probed node stops the probe, and the
    // mask view underneath is visible again.
    s = run(s, { type: "probe_node", id: "exposure" });
    expect(maskPreviewNode(s)).toBe("cset1_mask");
    // A probe pointing at a node this graph does not have shows the
    // photograph, not an error.
    s = run(s, { type: "probe_node", id: "never_was" });
    expect(maskPreviewNode(s)).toBe("cset1_mask");
    // A photo switch clears it: the next photo's graph is a different
    // circuit.
    s = run(s, { type: "probe_node", id: "never_was" }, { type: "probe_node", id: "exposure" });
    const other = s.images.find((i) => i.id !== s.activeImage)!;
    s = run(s, { type: "select_image", id: other.id });
    expect(s.probeNode).toBe(null);
  });
});

describe("folder switches and armed eyedroppers", () => {
  it("load_images disarms every picker: the fresh graph reuses the same node ids", () => {
    // The pick arms carry a NODE ID, and a folder switch rebuilds the
    // graph by cloning the default template, whose nodes wear the same
    // ids every time: a carried-over arm would aim the next click at
    // the new photo's same-id node. curvePick was always cleared here;
    // the other four were not.
    const img = (id: string) =>
      ({ id, name: `${id}.RW2`, stars: 0, edited: false, flag: "" }) as State["images"][number];
    const arms: Command[] = [
      { type: "toggle_tone_eq_pick", id: "n1" },
      { type: "toggle_recolor_pick", id: "n1" },
      { type: "toggle_console_pick", id: "n1" },
      { type: "arm_wb_pick", id: "n1" },
      { type: "arm_curve_pick", nodeId: "n1", channel: "rgb" },
    ];
    for (const arm of arms) {
      let s = run(initialState(), { type: "load_images", images: [img("a")] }, arm);
      s = run(s, { type: "load_images", images: [img("b")] });
      expect(s.toneEqPick).toBe(null);
      expect(s.recolorPick).toBe(null);
      expect(s.consolePick).toBe(null);
      expect(s.wbPick).toBe(null);
      expect(s.curvePick).toBe(null);
      expect(s.curveHoverX).toBe(null);
      expect(s.consolePickBand).toBe(null);
    }
  });
});

describe("rendered sources and the tone profile (ICC )", () => {
  const entry = (id: string, name: string) =>
    ({ id, name, stars: 0, edited: false, flag: "" }) as State["images"][number];

  it("a JPEG opens with the profile bypassed; a raw keeps it", () => {
    // A camera already rendered the JPEG: running the default profile
    // on top would render the picture twice.
    let s = run(initialState(), {
      type: "load_images",
      images: [entry("j1", "IMG_0100.jpg"), entry("r1", "IMG_0101.RW2")],
    });
    const profile = (st: State) => st.nodes.find((n) => n.type === "heeler.tone_profile")!;
    expect(profile(s).enabled).toBe(false);
    s = run(s, { type: "select_image", id: "r1" });
    expect(profile(s).enabled).toBe(true);
    // And back: each format keeps its own answer.
    s = run(s, { type: "select_image", id: "j1" });
    expect(profile(s).enabled).toBe(false);
  });

  it("an edited graph is never second-guessed by the format rule", () => {
    let s = run(initialState(), {
      type: "load_images",
      images: [entry("j1", "IMG_0100.jpg"), entry("r1", "IMG_0101.RW2")],
    });
    // The user turns the profile ON for their JPEG: that choice stays.
    const profileId = s.nodes.find((n) => n.type === "heeler.tone_profile")!.id;
    s = run(s, { type: "set_enabled", id: profileId, enabled: true });
    s = run(s, { type: "select_image", id: "r1" });
    s = run(s, { type: "select_image", id: "j1" });
    expect(s.nodes.find((n) => n.type === "heeler.tone_profile")!.enabled).toBe(true);
  });

  it("a saved JPEG graph with an untouched profile catches up to the rule", () => {
    // The fresh-graph bypass never reached graphs saved before it existed
    // - and the app saves a graph for every image it opens. "I
    // still have profiles being added to JPG... any 8 bit image probably
    // should not get a profile applied. Clearly one was baked in."
    const graphWith = (params: Record<string, number>, extra?: object) => ({
      nodes: [
        { type: "heeler.exposure", params: { exposure: 1.2 } },
        { type: "heeler.tone_profile", enabled: true, params, ...extra },
      ],
    });
    const untouched = { contrast: 100, ...PROFILE_DEFAULTS };
    // Untouched profile on a JPEG: the rule speaks.
    expect(needsRenderedBypass({ name: "IMG_1.jpg" }, graphWith(untouched))).toBe(true);
    // The shape every saved graph actually has: Film's development dial
    // rides along at 0. It is a shipped value, not a hand on the controls
    // (2026-09-20: the saved EXR graphs never caught up).
    expect(needsRenderedBypass({ name: "IMG_1.jpg" }, graphWith({ ...untouched, development: 0 }))).toBe(true);
    expect(needsRenderedBypass({ name: "render.exr" }, graphWith({ ...untouched, development: 0 }))).toBe(true);
    // A development the user set is a hand on the controls.
    expect(needsRenderedBypass({ name: "IMG_1.jpg" }, graphWith({ ...untouched, development: 1 }))).toBe(false);
    // A RAW never qualifies.
    expect(needsRenderedBypass({ name: "IMG_1.RW2" }, graphWith(untouched))).toBe(false);
    // A phone's DNG does: its decode follows the file's own gain table
    // map since 26.4.1, and every graph saved before that has the
    // profile on. A camera's DNG is a RAW like any other.
    expect(needsRenderedBypass({ name: "IMG_6991.DNG", phoneRendered: true }, graphWith(untouched))).toBe(true);
    expect(needsRenderedBypass({ name: "L1000123.DNG" }, graphWith(untouched))).toBe(false);
    expect(
      needsRenderedBypass({ name: "IMG_6991.DNG", phoneRendered: true }, graphWith({ ...untouched, contrast: 140 })),
    ).toBe(false);
    // A hand on the controls keeps the owner's profile - even on a JPEG.
    expect(
      needsRenderedBypass({ name: "IMG_1.jpg" }, graphWith({ ...untouched, contrast: 140 })),
    ).toBe(false);
    // A chosen mode is a choice too.
    expect(
      needsRenderedBypass(
        { name: "IMG_1.jpg" },
        graphWith(untouched, { textParams: { mode: "film" } }),
      ),
    ).toBe(false);
    // Already bypassed: nothing to do.
    expect(
      needsRenderedBypass(
        { name: "IMG_1.jpg" },
        { nodes: [{ type: "heeler.tone_profile", enabled: false, params: untouched }] },
      ),
    ).toBe(false);
    // And the command flips exactly the switch.
    let s = run(initialState(), {
      type: "load_images",
      images: [entry("j1", "IMG_0100.jpg")],
    });
    const profileId = s.nodes.find((n) => n.type === "heeler.tone_profile")!.id;
    s = run(s, { type: "set_enabled", id: profileId, enabled: true });
    s = run(s, { type: "apply_rendered_bypass" });
    expect(s.nodes.find((n) => n.id === profileId)!.enabled).toBe(false);
  });

  it("Reset is as fresh as never having opened the file", () => {
    // "when I did a reset edits I expect a fresh start.
    // That is not happening... it seems to be shallow." Reset used to
    // clone the bare template, skipping the fresh-graph door where the
    // rendered bypass and the RAW profile preference live.
    let s = run(initialState(), {
      type: "load_images",
      images: [entry("j1", "IMG_0100.jpg")],
    });
    const profile = (st: State) => st.nodes.find((n) => n.type === "heeler.tone_profile")!;
    // The user (or an old saved graph) has the profile on; reset must
    // shed it, because a fresh JPEG would never have had it.
    s = run(s, { type: "set_enabled", id: profile(s).id, enabled: true });
    s = run(s, { type: "reset_image_edits", id: "j1" });
    expect(profile(s).enabled).toBe(false);
    // And the RAW side honors the preference on reset too.
    let r = run(initialState(), { type: "set_ui_setting", key: "rawProfile", value: "linear" });
    r = run(r, { type: "load_images", images: [entry("r1", "IMG_0101.RW2")] });
    r = run(r, { type: "set_text_param", id: profile(r).id, param: "mode", value: "film" });
    r = run(r, { type: "reset_image_edits", id: "r1" });
    expect(profile(r).textParams?.mode).toBe("linear");
  });

  it("the rawProfile preference names the mode a fresh RAW is born with", () => {
    // "Maybe people loading RAW files don't want a profile added ([the
    // other editor] works like this)." Linear is that neutral start; the
    // preference only speaks at graph birth, and only for RAW - a JPEG stays
    // bypassed whatever the preference says.
    let s = run(initialState(), {
      type: "set_ui_setting",
      key: "rawProfile",
      value: "linear",
    });
    s = run(s, {
      type: "load_images",
      images: [entry("r1", "IMG_0101.RW2"), entry("j1", "IMG_0100.jpg")],
    });
    const profile = (st: State) => st.nodes.find((n) => n.type === "heeler.tone_profile")!;
    expect(profile(s).enabled).toBe(true);
    expect(profile(s).textParams?.mode).toBe("linear");
    s = run(s, { type: "select_image", id: "j1" });
    expect(profile(s).enabled).toBe(false);
    // Standard is the do-nothing default: the template's own mode.
    let d = run(initialState(), {
      type: "load_images",
      images: [entry("r1", "IMG_0101.RW2")],
    });
    expect(profile(d).textParams?.mode).toBe("standard");
  });
});

describe("radial mask shapes", () => {
  /// The owner asked for shapes beyond the ellipse. The engine reads the
  /// shape by name, and the name is also how it knows whether it may use
  /// the corrected geometry: see ops_masks.rs.
  it("a new radial mask names its shape", () => {
    const s = run(initialState(), { type: "add_layer", maskType: "radial" });
    const mask = s.nodes.find((n) => n.id === s.activeLayer!.replace("_adj", "_mask"))!;
    expect(mask.textParams?.shape).toBe("ellipse");
    // And carries the controls the shapes need.
    expect(mask.params.aspect).toBe(1);
    expect(mask.params.rotation).toBe(0);
  });

  it("the other mask types do not grow a shape", () => {
    for (const maskType of ["linear", "range", "brush"] as const) {
      const s = run(initialState(), { type: "add_layer", maskType });
      const mask = s.nodes.find((n) => n.id === s.activeLayer!.replace("_adj", "_mask"))!;
      expect(mask.textParams?.shape).toBeUndefined();
    }
  });

  it("changing shape is an ordinary undoable edit", () => {
    let s = run(initialState(), { type: "add_layer", maskType: "radial" });
    const id = s.nodes.find((n) => n.id === s.activeLayer!.replace("_adj", "_mask"))!.id;
    s = run(s, { type: "set_text_param", id, param: "shape", value: "crescent" });
    expect(s.nodes.find((n) => n.id === id)!.textParams!.shape).toBe("crescent");
    s = run(s, { type: "undo" });
    expect(s.nodes.find((n) => n.id === id)!.textParams!.shape).toBe("ellipse");
  });

  it("rotation runs a full turn, unlike the crop tool's angle", () => {
    // Same parameter name, two different jobs: a radial mask spins all
    // the way round, a straighten is a nudge.
    expect(paramRange("rotation", "heeler.radial_mask")).toEqual([-180, 180]);
    expect(paramRange("angle", "heeler.crop_rotate")).toEqual([-45, 45]);
  });

  it("every shape the picker offers is one the engine knows", () => {
    // The list drives the dropdown; the engine parses these names and
    // falls back to the ellipse for anything else, so a typo here would
    // silently draw the wrong shape.
    expect(RADIAL_SHAPES.map((s) => s.id)).toEqual([
      "ellipse",
      "rectangle",
      "triangle",
      "crescent",
      "trapeze",
      "cross",
      "semicircle",
    ]);
    // The amount slider is only named for the shapes it does anything to.
    expect(Object.keys(SHAPE_AMOUNT_LABEL).sort()).toEqual(["crescent", "cross", "trapeze"]);
    for (const id of Object.keys(SHAPE_AMOUNT_LABEL)) {
      expect(RADIAL_SHAPES.some((s) => s.id === id)).toBe(true);
    }
  });
});

describe("brush tips", () => {
  /// "There should be some brush types, not just
/// circle."
  it("offers the tips the engine knows how to paint", () => {
    expect(BRUSH_TIPS.map((b) => b.id)).toEqual([
      "circle",
      "square",
      "texture",
      "splatter",
      "dry",
      "crosshatch",
    ]);
    // The grain controls belong to the tips that have grain. Round and
    // square are solid, so a grain slider for them controls nothing.
    expect(TEXTURED_TIPS).toEqual(["texture", "splatter", "dry", "crosshatch"]);
    for (const id of TEXTURED_TIPS) {
      expect(BRUSH_TIPS.some((b) => b.id === id)).toBe(true);
    }
  });

  it("the tip is a tool setting, and starts round", () => {
    const s = initialState();
    expect(s.brushTip).toBe("circle");
    expect(run(s, { type: "set_brush_tip", tip: "splatter" }).brushTip).toBe("splatter");
  });

  it("keeps the grain settings inside a range the engine can use", () => {
    let s = run(initialState(), { type: "set_brush_texture", scale: 99, depth: 99 });
    expect(s.brushTextureScale).toBe(2);
    expect(s.brushTextureDepth).toBe(1);
    s = run(s, { type: "set_brush_texture", scale: -5, depth: -5 });
    expect(s.brushTextureScale).toBe(0.02);
    expect(s.brushTextureDepth).toBe(0);
    // Each can be set without disturbing the other.
    s = run(s, { type: "set_brush_texture", depth: 0.5 });
    expect(s.brushTextureScale).toBe(0.02);
    expect(s.brushTextureDepth).toBe(0.5);
  });

  it("a stroke carries the tip it was painted with", () => {
    // Per stroke, not per node: changing brush half way through a mask
    // must not reach back and repaint the first half.
    let s = run(initialState(), { type: "add_layer", maskType: "brush" });
    const id = s.nodes.find((n) => n.id === s.activeLayer!.replace("_adj", "_mask"))!.id;
    s = run(
      s,
      { type: "add_stroke", id, stroke: { points: [[0.2, 0.2]], radius: 0.1, brush: "dry" } },
      { type: "add_stroke", id, stroke: { points: [[0.8, 0.8]], radius: 0.1, brush: "square" } },
    );
    const strokes = s.nodes.find((n) => n.id === id)!.strokes!;
    expect(strokes.map((k) => k.brush)).toEqual(["dry", "square"]);
  });
});

describe("SHIFT-drag increments", () => {
  it("sizes the step to the range rather than using one number everywhere", () => {
    // "make sure the increment is proportionate and
    // reasonable to range and type of value being controlled."
    expect(snapStep(0, 100)).toBe(5);
    expect(snapStep(-100, 100)).toBe(10);
    expect(snapStep(0, 1)).toBeCloseTo(0.05);
    expect(snapStep(-1, 1)).toBeCloseTo(0.1);
    expect(snapStep(2000, 12000)).toBe(500);
    expect(snapStep(-180, 180)).toBe(20);
    // Degenerate ranges do not divide by zero or hand back Infinity.
    expect(snapStep(5, 5)).toBe(1);
  });
});

describe("typed values may go past the slider", () => {
  it("keeps a number the slider cannot reach", () => {
    // "The sliders go from X to Y. A user may be able to type
    // in larger or smaller values... The tool accepts this extended value.
    // The slider itself still functions within its coded constraints."
    const s = run(initialState(), { type: "set_param", id: "exposure", param: "exposure", value: 12 });
    expect(s.nodes.find((n) => n.id === "exposure")!.params.exposure).toBe(12);
  });

  it("still holds the limits that are real rather than editorial", () => {
    // A slider starting at zero starts there because below zero is
    // meaningless, and that survives typing.
    expect(hardRange("exposure")).toEqual([-Infinity, Infinity]);
    expect(hardRange("temperature")).toEqual([0, Infinity]);
    expect(hardRange("radius", "heeler.blur")).toEqual([0, Infinity]);
    const s = run(initialState(), { type: "set_param", id: "stdcolor", param: "temperature", value: -500 });
    expect(s.nodes.find((n) => n.id === "stdcolor")!.params.temperature).toBe(0);
  });
});

describe("an edit invalidates the sharp ROI slice", () => {
  // The patch guard rejects a slice for any image not on screen, so
  // the test patch has to belong to the active one.
  const patch = (url: string, s: State) => ({
    type: "set_roi_patch" as const,
    patch: { url, rect: [0, 0, 0.5, 0.5] as [number, number, number, number], frame: [4000, 3000] as [number, number], imageId: s.activeImage, look: "" },
  });
  const patched = () => {
    const s = initialState();
    return run(s, patch("blob:x", s));
  };

  it("remembers the frame dims after the patch itself is gone", () => {
    // The photograph's true size does not change when a slice goes
    // stale: 1:1 sizing and the status readouts keep using it, so a
    // return to 1:1 lands at true scale instead of proxy-then-snap.
    const s = patched();
    const img = s.activeImage;
    expect(s.view.frameDims[img]).toEqual([4000, 3000]);
    const cleared = run(s, { type: "set_roi_patch", patch: null });
    expect(cleared.view.roiPatch).toBeNull();
    expect(cleared.view.frameDims[img]).toEqual([4000, 3000]);
  });

  it("drops the patch on any undoable edit, so stale sharp pixels never cover a fresh stroke", () => {
    // "the stroke flashes invisible for a split second and
    // reappears" -- the pre-stroke patch sat on top of the post-stroke
    // base. The rule the gesture path already had, applied to one-shot
    // edits: an edit makes the slice stale, and soft-but-current beats
    // sharp-but-wrong.
    const s = run(patched(), { type: "set_param", id: "exposure", param: "exposure", value: 1 });
    expect(s.view.roiPatch).toBeNull();
  });

  it("keeps the patch across view-only changes, where the pixels are still right", () => {
    let s = run(patched(), { type: "pan_viewer", dx: 30, dy: 10 });
    expect(s.view.roiPatch).not.toBeNull();
    s = run(s, { type: "zoom_viewer", factor: 1.2, cx: 0, cy: 0 });
    expect(s.view.roiPatch).not.toBeNull();
  });

  it("drops it on undo and redo, which change the picture like any edit", () => {
    let s = run(patched(), { type: "set_param", id: "exposure", param: "exposure", value: 1 });
    s = run(s, patch("blob:y", s));
    s = run(s, { type: "undo" });
    expect(s.view.roiPatch).toBeNull();
    s = run(s, patch("blob:z", s));
    s = run(s, { type: "redo" });
    expect(s.view.roiPatch).toBeNull();
  });
});

describe("a streamed stroke erases in real time and undoes in one step", () => {
  it("grows the last stroke under one gesture, one history entry", () => {
    let s = run(initialState(), { type: "art_add_layer", kind: "paint" });
    const layer = s.artActive!;
    const depth = s.undoStack.length;
    const strokes = () =>
      (artLayers(s).find((l) => l.blend.id === layer)!.content.strokes ?? []) as unknown as {
        points: [number, number][];
        erase?: boolean;
      }[];

    // Mousedown: the stroke enters the graph immediately, which is what
    // makes the engine render it while the hand is still moving. The
    // report: "I need to see the eraser real time updating."
    s = run(
      s,
      { type: "begin_gesture", key: `${layer}.artstroke` },
      {
        type: "art_add_stroke",
        id: layer,
        stroke: { points: [[0.2, 0.2]], radius: 0.05, hardness: 1, flow: 1, erase: true } as never,
      },
    );
    // Each drag event grows it in place.
    s = run(s, { type: "art_update_stroke", id: layer, points: [[0.2, 0.2], [0.3, 0.2]] });
    s = run(s, {
      type: "art_update_stroke",
      id: layer,
      points: [[0.2, 0.2], [0.3, 0.2], [0.4, 0.25]],
    });
    s = run(s, { type: "end_gesture" });

    expect(strokes()).toHaveLength(1);
    expect(strokes()[0].points).toHaveLength(3);
    expect(strokes()[0].erase).toBe(true);
    // The whole drag is one history entry, like a slider gesture.
    expect(s.undoStack.length).toBe(depth + 1);
    s = run(s, { type: "undo" });
    expect(strokes()).toHaveLength(0);
  });
});

describe("clipping masks", () => {
  const artGroup = (s: State) => s.nodes.find((n) => n.id === "art")!;

  it("clips a layer to the one below it, as a wire in the graph", () => {
    let s = run(
      initialState(),
      { type: "art_add_layer", kind: "paint" },
      { type: "art_add_layer", kind: "paint" },
    );
    const [base, top] = artLayers(s);
    s = run(s, { type: "art_clip_layer", id: top.blend.id, clip: true });
    // The relationship is a wire: base content into the clipped blend's
    // mask port, read by alpha. Visible in Graph mode like everything
    // else, per the 1:1 rule.
    expect(artGroup(s).groupWires).toContainEqual(
      expect.objectContaining({ from: base.content.id, to: top.blend.id, toPort: "clip" }),
    );
    expect(artLayers(s)[1].blend.params.clip).toBe(1);

    // Release takes the wire back out.
    s = run(s, { type: "art_clip_layer", id: top.blend.id, clip: false });
    expect(
      artGroup(s).groupWires!.some((w) => w.toPort === "clip" && w.to === top.blend.id),
    ).toBe(false);
  });

  it("the bottom layer has nothing below it, and refuses", () => {
    let s = run(initialState(), { type: "art_add_layer", kind: "paint" });
    const only = artLayers(s)[0];
    s = run(s, { type: "art_clip_layer", id: only.blend.id, clip: true });
    expect(artLayers(s)[0].blend.params.clip ?? 0).toBe(0);
  });

  it("chained clips share one base, the layer-editor rule", () => {
    let s = run(
      initialState(),
      { type: "art_add_layer", kind: "paint" },
      { type: "art_add_layer", kind: "paint" },
      { type: "art_add_layer", kind: "paint" },
    );
    const [base, mid, top] = artLayers(s);
    s = run(
      s,
      { type: "art_clip_layer", id: mid.blend.id, clip: true },
      { type: "art_clip_layer", id: top.blend.id, clip: true },
    );
    const masks = artGroup(s).groupWires!.filter((w) => w.toPort === "clip");
    // Both clipped layers read the same unclipped base, not each other.
    expect(masks).toContainEqual(
      expect.objectContaining({ from: base.content.id, to: mid.blend.id }),
    );
    expect(masks).toContainEqual(
      expect.objectContaining({ from: base.content.id, to: top.blend.id }),
    );
  });
});

describe("insert-into-pipe and extract, the compositor gestures", () => {
  const wiresOf = (s: State) => s.wires.filter((w) => w.kind === "image");
  const feedOf = (s: State, id: string) => wiresOf(s).find((w) => w.to === id)?.from;

  it("drops a node onto a pipe and it splices in, healing where it came from", () => {
    const s0 = initialState();
    // The sharpen node moves from wherever it sits into the pipe that
    // feeds the exposure node.
    const feed = wiresOf(s0).find((w) => w.to === "exposure")!;
    const s = run(s0, {
      type: "splice_node_into_wire",
      id: "sharpen",
      from: feed.from,
      to: "exposure",
      toPort: feed.toPort,
    });
    expect(feedOf(s, "sharpen")).toBe(feed.from);
    expect(feedOf(s, "exposure")).toBe("sharpen");
    // Where it used to sit, its old neighbors are joined directly:
    // one node, one place in the chain.
    const stillFeeds = wiresOf(s).filter((w) => w.from === "sharpen");
    expect(stillFeeds).toHaveLength(1);
  });

  it("dropping a node onto its own pipe does nothing", () => {
    const s0 = initialState();
    const own = wiresOf(s0).find((w) => w.to === "sharpen")!;
    const s = run(s0, {
      type: "splice_node_into_wire",
      id: "sharpen",
      from: own.from,
      to: "sharpen",
      toPort: own.toPort,
    });
    expect(s.wires).toEqual(s0.wires);
  });

  it("extract pulls a node loose and its neighbors heal around it", () => {
    const s0 = initialState();
    const before = feedOf(s0, "sharpen");
    const after = wiresOf(s0).find((w) => w.from === "sharpen")!.to;
    const s = run(s0, { type: "extract_node", id: "sharpen" });
    expect(feedOf(s, after)).toBe(before);
    expect(s.wires.some((w) => w.from === "sharpen" || w.to === "sharpen")).toBe(false);
    // And extracting a loose node is a no-op, not a history entry.
    const depth = s.undoStack.length;
    const again = run(s, { type: "extract_node", id: "sharpen" });
    expect(again.undoStack.length).toBe(depth);
  });

  it("one undo puts an extracted node back", () => {
    const s0 = initialState();
    const s = run(s0, { type: "extract_node", id: "sharpen" }, { type: "undo" });
    expect(s.wires).toEqual(s0.wires);
  });

  // 26.3: a node with a field in and a field out splices into a mask or
  // alpha pipe the same way an image node splices into an image pipe.
  // "If a node has Alpha in and out and is dragged over a
  // Alpha connection it should be able to connect."
  it("a field pass-through dropped onto a mask pipe splices into it", () => {
    // invert_mask reads a field and writes a field; the pipe's landing is kept.
    let s = run(initialState(), { type: "add_node", node: makeNode(specFor("heeler.invert_mask")!, "inv", 0, 0) });
    s = run(s, { type: "splice_node_into_wire", id: "inv", from: "lummask", to: "cbal", toPort: "mask" });
    expect(s.wires.some((w) => w.from === "lummask" && w.to === "inv" && w.toPort === "mask")).toBe(true);
    expect(s.wires.some((w) => w.from === "inv" && w.to === "cbal" && w.toPort === "mask")).toBe(true);
    expect(s.wires.some((w) => w.from === "lummask" && w.to === "cbal")).toBe(false);
  });

  it("a two-operand field node splices onto its first operand", () => {
    let s = run(initialState(), { type: "add_node", node: makeNode(specFor("heeler.logic")!, "lg", 0, 0) });
    s = run(s, { type: "splice_node_into_wire", id: "lg", from: "lummask", to: "cbal", toPort: "mask" });
    expect(s.wires.some((w) => w.from === "lummask" && w.to === "lg" && w.toPort === "in")).toBe(true);
    expect(s.wires.some((w) => w.from === "lg" && w.to === "cbal" && w.toPort === "mask")).toBe(true);
  });

  it("an Export Layer dropped onto an alpha pipe passes the field through and lets its image input go", () => {
    let s = run(
      initialState(),
      { type: "add_node", node: makeNode(specFor("heeler.export_layer")!, "ex", 0, 0) },
      { type: "connect", wire: { from: "lummask", to: "output", toPort: "alpha", kind: "mask" } },
      { type: "connect", wire: { from: "exposure", to: "ex", toPort: "in", kind: "image" } },
    );
    s = run(s, { type: "splice_node_into_wire", id: "ex", from: "lummask", to: "output", toPort: "alpha" });
    expect(s.wires.some((w) => w.from === "lummask" && w.to === "ex" && w.toPort === "mask")).toBe(true);
    expect(s.wires.some((w) => w.from === "ex" && w.fromPort === "mask" && w.to === "output" && w.toPort === "alpha")).toBe(true);
    // One picture or one field, never both: the image input let go when
    // the node was lifted onto the field pipe.
    expect(s.wires.some((w) => w.to === "ex" && w.toPort === "in")).toBe(false);
  });

  it("a field-in image-out node does not splice into a mask pipe", () => {
    let s = run(initialState(), { type: "add_node", node: makeNode(specFor("heeler.channel_join")!, "join", 0, 0) });
    s = run(s, { type: "splice_node_into_wire", id: "join", from: "lummask", to: "cbal", toPort: "mask" });
    expect(s.wires.some((w) => w.from === "join" || w.to === "join")).toBe(false);
    expect(s.wires.some((w) => w.from === "lummask" && w.to === "cbal" && w.toPort === "mask")).toBe(true);
  });

  it("a field node already on a pipe moves to the new one, its old wires let go", () => {
    // The same bargain the image splice makes: one gesture is also
    // "move a node elsewhere". A field feed is not healed; brushmask
    // simply loses its consumer, the extract rule for mask sources.
    let s = run(
      initialState(),
      { type: "add_node", node: makeNode(specFor("heeler.invert_mask")!, "inv", 0, 0) },
      { type: "connect", wire: { from: "brushmask", to: "inv", toPort: "mask", kind: "mask" } },
    );
    s = run(s, { type: "splice_node_into_wire", id: "inv", from: "lummask", to: "cbal", toPort: "mask" });
    expect(s.wires.some((w) => w.from === "lummask" && w.to === "inv" && w.toPort === "mask")).toBe(true);
    expect(s.wires.some((w) => w.from === "inv" && w.to === "cbal" && w.toPort === "mask")).toBe(true);
    expect(s.wires.some((w) => w.from === "brushmask" && w.to === "inv")).toBe(false);
    expect(s.wires.some((w) => w.from === "lummask" && w.to === "cbal")).toBe(false);
  });

  it("a field node downstream of the pipe's target moves without looping the graph", () => {
    // inv sits downstream of cbal (cbal -> exposure -> rm2 -> inv).
    // Splicing it between lummask and cbal lifts it out of that seat,
    // so no loop forms: the rm2 pipe lets go with the move.
    let s = run(
      initialState(),
      { type: "add_node", node: makeNode(specFor("heeler.invert_mask")!, "inv", 0, 0) },
      { type: "add_node", node: makeNode(specFor("heeler.range_mask")!, "rm2", 0, 0) },
      { type: "connect", wire: { from: "exposure", to: "rm2", toPort: "in", kind: "image" } },
      { type: "connect", wire: { from: "rm2", to: "inv", toPort: "mask", kind: "mask" } },
    );
    s = run(s, { type: "splice_node_into_wire", id: "inv", from: "lummask", to: "cbal", toPort: "mask" });
    expect(s.wires.some((w) => w.from === "lummask" && w.to === "inv" && w.toPort === "mask")).toBe(true);
    expect(s.wires.some((w) => w.from === "inv" && w.to === "cbal" && w.toPort === "mask")).toBe(true);
    expect(s.wires.some((w) => w.from === "rm2" && w.to === "inv")).toBe(false);
    expect(s.wires.some((w) => w.from === "exposure" && w.to === "rm2")).toBe(true);
  });
});

describe("mask pipes by hand", () => {
  const maskWireTo = (s: State, to: string) =>
    s.wires.find((w) => w.to === to && w.toPort === "mask");

  it("connect refuses a non-mask source on a mask port, and honors cycles", () => {
    const s0 = initialState();
    // cbal ships masked already, so the probe targets sharpen, which
    // does not.
    const bad = run(s0, {
      type: "connect",
      wire: { from: "exposure", to: "sharpen", toPort: "mask", kind: "mask" },
    });
    expect(maskWireTo(bad, "sharpen")).toBeUndefined();
  });

  it("a mask connects, reassigns, and comes off, one undo step each", () => {
    let s = run(initialState(), {
      type: "connect",
      wire: { from: "lummask", to: "sharpen", toPort: "mask", kind: "mask" },
    });
    expect(maskWireTo(s, "sharpen")?.from).toBe("lummask");

    // Reassign is what the head-drag gesture dispatches: off the old,
    // onto the new.
    s = run(
      s,
      { type: "disconnect", to: "sharpen", toPort: "mask" },
      { type: "connect", wire: { from: "lummask", to: "exposure", toPort: "mask", kind: "mask" } },
    );
    expect(maskWireTo(s, "sharpen")).toBeUndefined();
    expect(maskWireTo(s, "exposure")?.from).toBe("lummask");

    s = run(s, { type: "disconnect", to: "exposure", toPort: "mask" });
    expect(maskWireTo(s, "exposure")).toBeUndefined();
    // Three actions, three undos, back to the start.
    s = run(s, { type: "undo" });
    expect(maskWireTo(s, "exposure")?.from).toBe("lummask");
  });

  it("one mask can feed several nodes at once", () => {
    let s = run(
      initialState(),
      { type: "connect", wire: { from: "lummask", to: "sharpen", toPort: "mask", kind: "mask" } },
      { type: "connect", wire: { from: "lummask", to: "exposure", toPort: "mask", kind: "mask" } },
    );
    expect(maskWireTo(s, "sharpen")?.from).toBe("lummask");
    expect(maskWireTo(s, "exposure")?.from).toBe("lummask");
  });
});

describe("select upstream", () => {
  it("takes everything the selection depends on, masks included", () => {
    // cbal ships with lummask already wired, which is exactly what the
    // walk should bring along.
    let s = run(initialState(), { type: "select_nodes", ids: ["cbal"] });
    const sent: Command[] = [];
    runCommand("node.upstream", s, (c) => sent.push(c));
    const picked = (sent.find((c) => c.type === "select_nodes") as never as { ids: string[] }).ids;
    // The image chain above it...
    expect(picked).toContain("cbal");
    expect(picked).toContain("src");
    // ...and the mask that feeds it, which a walk that only followed
    // image wires would leave behind.
    expect(picked).toContain("lummask");
    // Nothing downstream comes along.
    expect(picked).not.toContain("output");
  });
});

describe("the Outside gesture", () => {
  it("pairs a masked grade with its complement through one shared mask", () => {
    // cbal ships wearing lummask, so it is the natural subject.
    const s0 = initialState();
    const downstream = s0.wires.find((w) => w.from === "cbal" && w.kind === "image")!.to;
    const sent: Command[] = [];
    let s = run(s0, { type: "select_nodes", ids: ["cbal"] });
    runCommand("node.outside", s, (c) => sent.push(c));
    for (const c of sent) s = run(s, c);

    const copy = s.nodes.find((n) => n.id === "cbal_outside")!;
    const inv = s.nodes.find((n) => n.id === "cbal_outmask")!;
    expect(copy.name).toBe("Color Balance Outside");
    expect(inv.type).toBe("heeler.invert_mask");

    // The chain reads original -> copy -> whatever the original fed.
    expect(s.wires).toContainEqual(
      expect.objectContaining({ from: "cbal", to: "cbal_outside", toPort: "in" }),
    );
    expect(s.wires).toContainEqual(
      expect.objectContaining({ from: "cbal_outside", to: downstream }),
    );
    // ONE mask feeds both sides: lummask straight into cbal as before,
    // and through the inverter into the copy. Editing the mask moves
    // the pair together, which is the whole point.
    expect(s.wires).toContainEqual(
      expect.objectContaining({ from: "lummask", to: "cbal", toPort: "mask" }),
    );
    expect(s.wires).toContainEqual(
      expect.objectContaining({ from: "lummask", to: "cbal_outmask", toPort: "mask" }),
    );
    expect(s.wires).toContainEqual(
      expect.objectContaining({ from: "cbal_outmask", to: "cbal_outside", toPort: "mask" }),
    );
    // The copy starts from the original's settings and is selected,
    // since the next thing anyone does is adjust it.
    expect(copy.params).toEqual(s.nodes.find((n) => n.id === "cbal")!.params);
    expect(s.selection).toEqual(["cbal_outside"]);

    // One undo removes the whole pair.
    s = run(s, { type: "undo" });
    expect(s.nodes.some((n) => n.id === "cbal_outside")).toBe(false);
    expect(s.wires).toEqual(s0.wires);
  });

  it("says WHY it refuses without a mask, rather than doing nothing", () => {
    // The owner pressed Alt+O on an unmasked node and nothing happened at
    // all, which read as the key being broken. A refusal is an answer, and
    // answers are spoken: the command claims the key and posts a notice
    // telling you what the node is missing.
    const s = run(initialState(), { type: "select_nodes", ids: ["exposure"] });
    const sent: Command[] = [];
    expect(runCommand("node.outside", s, (c) => sent.push(c))).toBe(true);
    const notice = sent.find((c) => c.type === "set_notice") as never as { text: string };
    expect(notice.text).toContain("mask");
    expect(sent.some((c) => c.type === "node_outside")).toBe(false);
  });
});

describe("node notes and color", () => {
  it("a tint and a note stick to the card, and clear back off", () => {
    let s = run(
      initialState(),
      { type: "set_node_tint", id: "cbal", tint: "#4a8ac6" },
      { type: "set_node_note", id: "cbal", note: "  cool the shadows only  " },
    );
    const n = () => s.nodes.find((k) => k.id === "cbal")!;
    expect(n().tint).toBe("#4a8ac6");
    // Trimmed: a note that is all whitespace is no note.
    expect(n().note).toBe("cool the shadows only");
    s = run(
      s,
      { type: "set_node_tint", id: "cbal", tint: null },
      { type: "set_node_note", id: "cbal", note: "   " },
    );
    expect(n().tint).toBeUndefined();
    expect(n().note).toBeUndefined();
  });

  it("both survive the serialize round trip the sidecar makes", () => {
    // Persistence is the whole point of a note: the graph file stores
    // NodeCards as-is, so the fields must live on the card rather than
    // in view state.
    const s = run(
      initialState(),
      { type: "set_node_tint", id: "cbal", tint: "#5aa564" },
      { type: "set_node_note", id: "cbal", note: "greens" },
    );
    const revived = JSON.parse(JSON.stringify(s.nodes)) as typeof s.nodes;
    const n = revived.find((k) => k.id === "cbal")!;
    expect(n.tint).toBe("#5aa564");
    expect(n.note).toBe("greens");
  });
});

describe("fresh photographs carry no demo furniture", () => {
  it("the neutral graph has no pre-seeded masks, and no dangling wires", () => {
    // "nodes should always be on-demand." The sample session
    // keeps its demo masks; a new photograph starts with only what makes it
    // a photograph. Masks arrive when a layer or the palette asks.
    const ids = new Set(NEUTRAL_NODES.map((n) => n.id));
    expect(ids.has("lummask")).toBe(false);
    expect(ids.has("brushmask")).toBe(false);
    // Every neutral wire points at nodes that exist: nothing dangles.
    for (const w of NEUTRAL_WIRES) {
      expect(ids.has(w.from)).toBe(true);
      expect(ids.has(w.to)).toBe(true);
    }
  });
});

describe("the scripting bridge's frontend half", () => {
  const call = (s: State, method: string, params?: unknown) => {
    const sent: Command[] = [];
    const out = handleApi(s, (c) => sent.push(c), method, params);
    return { out, sent };
  };

  it("answers state, graph and catalog queries from the live state", () => {
    const s = initialState();
    const st = call(s, "app.state").out.data as { imageId: string; mode: string };
    expect(st.imageId).toBe(s.activeImage);
    const g = call(s, "graph.get").out.data as { nodes: { id: string }[]; wires: unknown[] };
    expect(g.nodes.some((n) => n.id === "exposure")).toBe(true);
    expect(g.wires.length).toBe(s.wires.length);
    const imgs = call(s, "catalog.images").out.data as { id: string }[];
    expect(imgs.length).toBe(s.images.length);
  });

  it("dispatches whitelisted commands and refuses the rest by name", () => {
    const s = initialState();
    const ok = call(s, "graph.command", {
      command: { type: "set_param", id: "exposure", param: "exposure", value: 1 },
    });
    expect(ok.sent).toHaveLength(1);
    // View state is not scriptable: the whitelist is the contract, and
    // a refusal names the command so the script can read why.
    const no = call(s, "graph.command", { command: { type: "zoom_viewer", factor: 2 } });
    expect(no.sent).toHaveLength(0);
    expect(no.out.error).toContain("zoom_viewer");
    const unknown = call(s, "no.such.method");
    expect(unknown.out.error).toContain("no.such.method");
  });

  it("serializes the graph the same way a render does", () => {
    const s = initialState();
    const out = call(s, "graph.serialize").out.data as { graph: unknown; imageId: string };
    expect(out.imageId).toBe(s.activeImage);
    expect(JSON.stringify(out.graph)).toContain("heeler.exposure");
  });

  it("lists takes, and the take commands are whitelisted", () => {
    const s = initialState();
    // Never branched: one implicit take, the edit itself.
    const fresh = call(s, "takes.list").out.data as {
      active: string;
      takes: { id: string; name: string; note: string | null; rating: number }[];
    };
    expect(fresh.active).toBe("take_1");
    expect(fresh.takes).toEqual([{ id: "take_1", name: "Take 1", note: null, rating: 0 }]);
    // Branch, rename and switch through the bus, then read it back.
    const branched = run(
      s,
      { type: "new_take", name: "Cool" },
      { type: "switch_take", takeId: "take_1" },
    );
    const listed = call(branched, "takes.list").out.data as typeof fresh;
    expect(listed.takes.map((t) => t.name)).toEqual(["Take 1", "Cool"]);
    expect(listed.active).toBe("take_1");
    for (const t of ["new_take", "update_take", "switch_take", "delete_take"] as const) {
      expect(API_COMMANDS.has(t)).toBe(true);
    }
  });

  it("reads and writes preferences, and round-trips hotkeys", () => {
    const s = initialState();
    const prefs = call(s, "prefs.get").out.data as typeof s.prefs;
    expect(prefs.quickQuality).toBe(s.prefs.quickQuality);
    // set_prefs rides the whitelist, so scripts get the panel's command.
    const ok = call(s, "graph.command", {
      command: { type: "set_prefs", prefs: { quickQuality: 85 } },
    });
    expect(ok.sent).toHaveLength(1);
    // Hotkeys export and import are the panel's own shapes.
    const exported = call(s, "hotkeys.export").out.data as { json: string };
    expect(JSON.parse(exported.json)).toEqual(JSON.parse(exportHotkeys(s.prefs.hotkeys)));
    const imported = call(s, "hotkeys.import", { json: exportHotkeys({ "flag.pick": "Ctrl+P" }) });
    expect((imported.out.data as { imported: number }).imported).toBe(1);
    expect(imported.sent[0]).toEqual({
      type: "set_prefs",
      prefs: { hotkeys: { "flag.pick": "Ctrl+P" } },
    });
    const bad = call(s, "hotkeys.import", { json: "not json at all" });
    expect(bad.out.error).toContain("hotkeys.import");
    expect(bad.sent).toHaveLength(0);
  });

  it("lists collections, saves nothing (the app saves itself), and switches mode", () => {
    const s: State = {
      ...initialState(),
      collections: [{ id: 3, name: "Heroes", count: 12, hasLook: true }],
    };
    const cols = call(s, "catalog.collections").out.data as { name: string; hasLook: boolean }[];
    expect(cols).toEqual([{ id: 3, name: "Heroes", count: 12, hasLook: true }]);
    // Batch mode's explicit save is a no-op against the app door, so a
    // script written for batch runs unchanged in the console.
    const saved = call(s, "graph.save").out.data as { automatic: boolean };
    expect(saved.automatic).toBe(true);
    const mode = call(s, "graph.command", { command: { type: "set_mode", mode: "canvas" } });
    expect(mode.sent).toEqual([{ type: "set_mode", mode: "canvas" }]);
  });

  it("exports through the panel's pipeline, reporting per-image failures", async () => {
    mockResetExports();
    const s = initialState();
    const [a, b] = s.images;
    const sent: Command[] = [];
    const out = await handleApiAsync(s, (c) => sent.push(c), "export.run", {
      ids: [a.id, "ghost", b.id],
      dir: "/tmp/heeler-out",
      format: "png",
      template: "{name}-{n}",
    });
    const data = out.data as { written: string[]; failed: { name: string; error: string }[] };
    // The unknown id is a reported failure, never a reason to stop.
    expect(data.failed).toEqual([{ name: "ghost", error: "not in the open folder" }]);
    expect(data.written).toHaveLength(2);
    expect(data.written[0]).toContain("-1.png");
    // The mock ledger proves the writes went through exportTo, the
    // panel's own door.
    expect(mockExportedLog().map((e) => e.format)).toEqual(["png", "png"]);
    // A nonsense format refuses by naming the valid ones.
    const bad = await handleApiAsync(s, () => {}, "export.run", { dir: "/tmp/x", format: "gif" });
    expect(bad.error).toContain("jpeg");
    mockResetExports();
  });

  it("opens a folder through the same landing as the tree", async () => {
    const s = initialState();
    const sent: Command[] = [];
    const out = await handleApiAsync(s, (c) => sent.push(c), "app.open_folder", {
      path: "mock://trip/day2",
    });
    const data = out.data as { opened: string; images: number };
    expect(data.opened).toBe("mock://trip/day2");
    expect(data.images).toBeGreaterThan(0);
    expect(sent.some((c) => c.type === "set_library")).toBe(true);
    const missing = await handleApiAsync(s, () => {}, "app.open_folder", { path: "" });
    expect(missing.error).toContain("app.open_folder needs");
  });

  it("stacks and panoramas refuse in words where there are no files", async () => {
    // The browser build has no sources to merge; the refusal is the
    // desktop app's name for why, not an opaque null.
    const s = initialState();
    const made = await handleApiAsync(s, () => {}, "stack.create", { ids: ["a", "b"], mode: "hdr" });
    expect(made.error).toContain("desktop app");
    const pano = await handleApiAsync(s, () => {}, "pano.create", { ids: ["a", "b"] });
    expect(pano.error).toContain("desktop app");
    const shape = await handleApiAsync(s, () => {}, "stack.configure", { mode: "mean" });
    expect(shape.error).toContain("needs { id }");
  });

  it("every method the app door should answer is answered", async () => {
    // The parity walk, app side: the manifest is the file the batch
    // door's test reads too. A method that reaches the frontend and is
    // not handled answers "unknown method", which is exactly the
    // divergence this test exists to catch.
    const s = initialState();
    for (const m of API_METHODS) {
      if (API_NATIVE.has(m) || API_BATCH_ONLY.has(m)) continue;
      const out = await handleApiAsync(s, () => {}, m, {});
      expect(out.error ?? "", `method ${m}`).not.toContain("unknown method");
    }
  });
});

describe("selecting several photographs by id", () => {
  it("select_images goes through select_image's own door and widens", () => {
    // The Stack panel's "Select in ribbon": active becomes the first,
    // with every cleanup a photo switch owes (the reducer routes
    // through select_image), and the selection holds them all.
    const base = initialState();
    const ids = base.images.slice(2, 5).map((i) => i.id);
    const s = run(base, { type: "select_images", ids: [...ids, "ghost"] });
    expect(s.activeImage).toBe(ids[0]);
    expect(s.imageSelection).toEqual(ids);
    // Ids the folder does not hold are dropped; none at all is a no-op.
    expect(run(s, { type: "select_images", ids: ["nope"] })).toBe(s);
  });
});

describe("what Add to Stack offers", () => {
  const stackImg = {
    id: "stk1",
    name: "MAX_a-b.stack",
    stars: 0 as const,
    flag: "" as const,
    edited: false,
    filter: "none",
    src: "",
  };
  it("stacks in the folder, minus the selection; frames minus the recipes", () => {
    let s = run(initialState(), { type: "add_stack_image", image: { ...stackImg } });
    // add_stack_image makes the stack active; move the selection onto
    // ordinary frames.
    const frames = s.images.filter((i) => i.id !== "stk1").slice(0, 2).map((i) => i.id);
    s = run(s, { type: "select_images", ids: frames });
    const offer = stackAppendTargets(s);
    expect(offer.stacks.map((i) => i.id)).toEqual(["stk1"]);
    expect(offer.frames).toEqual(frames);
    // A selected stack is never its own target, and a selection with
    // no ordinary frames has nothing to offer at all.
    const onStack = run(s, { type: "select_images", ids: ["stk1"] });
    expect(stackAppendTargets(onStack)).toEqual({ stacks: [], frames: [] });
  });
});

describe("the main-chain tools ship without a node and build on first write", () => {
  /// 2026-09-01: "let's remove Denoise and Sharpen. Even Black and
  /// White. Do we need to have Crop & Rotate by default? ... Let's
  /// remove that one too. Lastly, the Portra Grade... It looks like a
  /// group node but I can't open it."
  const fresh = (): State => {
    const s = initialState();
    return { ...s, nodes: structuredClone(NEUTRAL_NODES), wires: structuredClone(NEUTRAL_WIRES) };
  };
  const feeds = (s: State, to: string) =>
    s.wires.find((w) => w.to === to && w.toPort === "in" && w.kind === "image")?.from;

  it("a fresh graph carries none of them, nor the sample's dressing", () => {
    const ids = new Set(NEUTRAL_NODES.map((n) => n.id));
    for (const id of ["sharpen", "denoise", "bw", "crop", "portra", "merge"]) {
      expect(ids.has(id), `${id} should not be in a fresh graph`).toBe(false);
    }
    // And the chain is joined across every gap: the source reaches the
    // color node directly.
    expect(NEUTRAL_WIRES.some((w) => w.from === "src" && w.to === "stdcolor")).toBe(true);
  });

  it("the panel rows read a stand-in at identity, born on", () => {
    const s = fresh();
    for (const [key, id] of [["sharpen", "sharpen"], ["denoise", "denoise"], ["bw", "bw"]]) {
      const n = toolNode(s, key as never)!;
      expect(n.id).toBe(id);
      expect(n.enabled).toBe(true);
    }
    expect(toolNode(s, "bw")!.params.amount).toBe(0);
  });

  it("Unsharp's first move builds Sharpen in the chain", () => {
    let s = fresh();
    s = run(s, { type: "set_param", id: "sharpen", param: "amount", value: 20 });
    const n = s.nodes.find((x) => x.id === "sharpen")!;
    expect(n).toBeTruthy();
    expect(n.enabled).toBe(true);
    expect(n.params.amount).toBe(20);
    expect(n.params.radius).toBe(1);
    // In the chain at its slot, and the profile is fed exactly once.
    expect(feeds(s, "sharpen")).toBe("exposure");
    expect(feeds(s, "profile")).toBe("sharpen");
    expect(s.wires.filter((w) => w.to === "profile" && w.toPort === "in")).toHaveLength(1);
    // The build is its own undo step, the way a layer tool's is.
    s = run(s, { type: "undo" });
    expect(s.nodes.find((x) => x.id === "sharpen")!.params.amount).toBe(0);
    s = run(s, { type: "undo" });
    expect(s.nodes.some((x) => x.id === "sharpen")).toBe(false);
    expect(feeds(s, "profile")).toBe("exposure");
  });

  it("a write at identity builds nothing: a section Reset over a stand-in leaves the graph alone", () => {
    let s = fresh();
    s = run(s, { type: "set_param", id: "sharpen", param: "amount", value: 0 });
    s = run(s, { type: "set_params", id: "bw", values: { amount: 0, red: 30, green: 59, blue: 11 } });
    expect(s.nodes.some((x) => x.id === "sharpen")).toBe(false);
    expect(s.nodes.some((x) => x.id === "bw")).toBe(false);
    expect(s.nodes.map((n) => n.id)).toEqual(NEUTRAL_NODES.map((n) => n.id));
    expect(s.wires).toEqual(NEUTRAL_WIRES);
  });

  it("choosing the B&W treatment builds Black & White", () => {
    const s = run(fresh(), { type: "set_param", id: "bw", param: "amount", value: 100 });
    const bw = s.nodes.find((x) => x.id === "bw")!;
    expect(bw.params).toMatchObject({ amount: 100, red: 30, green: 59, blue: 11 });
    expect(feeds(s, "bw")).toBe("exposure");
  });

  it("the crop tool drags a stand-in, and the first drag builds the node", () => {
    let s = fresh();
    expect(cropNode(s).params.crop_w).toBe(1);
    s = run(s, { type: "set_tool", tool: "crop" });
    expect(s.toolRevert).toMatchObject({ id: "crop", fresh: true });
    s = run(s, { type: "set_param", id: "crop", param: "crop_w", value: 0.5 });
    const crop = s.nodes.find((x) => x.id === "crop")!;
    expect(crop.params.crop_w).toBe(0.5);
    expect(cropNode(s)).toBe(crop);
    // First in the chain after the source, before anything reads pixels.
    expect(feeds(s, "crop")).toBe("src");
    expect(feeds(s, "stdcolor")).toBe("crop");
    // Committing keeps it.
    s = run(s, { type: "set_tool", tool: "crop" });
    expect(s.tool).toBe("none");
    expect(s.nodes.some((x) => x.id === "crop")).toBe(true);
  });

  it("Escape after a first drag takes the built crop out again", () => {
    let s = fresh();
    s = run(
      s,
      { type: "set_tool", tool: "straighten" },
      { type: "set_param", id: "crop", param: "angle", value: 2 },
      { type: "cancel_tool" },
    );
    expect(s.tool).toBe("none");
    expect(s.nodes.some((x) => x.id === "crop")).toBe(false);
    expect(feeds(s, "stdcolor")).toBe("src");
  });

  it("Escape on a photo that already had a crop puts its values back", () => {
    let s = fresh();
    s = run(s, { type: "set_param", id: "crop", param: "crop_w", value: 0.5 });
    s = run(
      s,
      { type: "set_tool", tool: "crop" },
      { type: "set_param", id: "crop", param: "crop_w", value: 0.25 },
      { type: "cancel_tool" },
    );
    expect(s.nodes.find((x) => x.id === "crop")!.params.crop_w).toBe(0.5);
  });

  it("the Geometry switch builds the crop and bypasses it, like any section", () => {
    let s = fresh();
    expect(s.sectionsClosed).toContain("Geometry");
    s = run(s, { type: "set_category", title: "Geometry", on: true });
    const crop = s.nodes.find((x) => x.id === "crop")!;
    expect(crop.enabled).toBe(true);
    expect(crop.params).toMatchObject({ angle: 0, crop_w: 1, crop_h: 1 });
    s = run(s, { type: "set_category", title: "Geometry", on: false });
    expect(s.nodes.find((x) => x.id === "crop")!.enabled).toBe(false);
  });

  it("a load strips the tools and the dressing every older graph carried", async () => {
    const { migrateGraph } = await import("../state");
    // What a graph saved before 2026-09-01 looks like: Sharpen, Denoise,
    // B&W and Crop enabled at identity, and the sample's empty Portra
    // group feeding a Merge between the source and the crop.
    let s = fresh();
    s = run(
      s,
      { type: "set_category", title: "Geometry", on: true },
      { type: "set_param", id: "sharpen", param: "amount", value: 10 },
      { type: "set_param", id: "sharpen", param: "amount", value: 0 },
      { type: "set_param", id: "denoise", param: "strength", value: 5 },
      { type: "set_param", id: "denoise", param: "strength", value: 0 },
      { type: "set_param", id: "bw", param: "amount", value: 50 },
      { type: "set_param", id: "bw", param: "amount", value: 0 },
    );
    for (const id of ["sharpen", "denoise", "bw", "crop"]) {
      expect(s.nodes.find((x) => x.id === id)!.enabled, id).toBe(true);
    }
    const srcOut = s.wires.find((w) => w.from === "src" && w.kind === "image")!;
    const nodes: NodeCard[] = [
      ...s.nodes,
      { id: "portra", type: "heeler.group", name: "Portra Grade", cat: "group", x: 0, y: 0, enabled: true, params: { grade_strength: 78 }, isGroup: true, hasOut: true } as NodeCard,
      { id: "merge", type: "heeler.merge", name: "Merge", cat: "utility", x: 0, y: 0, enabled: true, params: { opacity: 72 }, hasIn: true, hasIn2: true, hasOut: true } as NodeCard,
    ];
    const wires = [
      ...s.wires.filter((w) => w !== srcOut),
      { from: "src", to: "merge", toPort: "in", kind: "image" } as const,
      { from: "portra", to: "merge", toPort: "in2", kind: "group" } as const,
      { from: "merge", to: srcOut.to, toPort: srcOut.toPort, kind: "image" } as const,
    ];

    const out = migrateGraph(nodes, wires);
    for (const id of ["sharpen", "denoise", "bw", "crop", "portra", "merge"]) {
      expect(out.nodes.some((x) => x.id === id), `${id} should be gone`).toBe(false);
    }
    expect(out.nodes.map((n) => n.id).sort()).toEqual(NEUTRAL_NODES.map((n) => n.id).sort());
    const wireSet = (ws: { from: string; to: string; toPort?: string; kind: string }[]) =>
      ws.map((w) => `${w.from}>${w.to}:${w.toPort ?? "in"}:${w.kind}`).sort();
    expect(wireSet(out.wires)).toEqual(wireSet(NEUTRAL_WIRES));
  });

  it("a load keeps a tool that says something, and a group with something in it", async () => {
    const { migrateGraph } = await import("../state");
    let s = fresh();
    s = run(
      s,
      { type: "set_param", id: "crop", param: "crop_w", value: 0.5 },
      { type: "set_param", id: "bw", param: "amount", value: 100 },
      { type: "set_param", id: "sharpen", param: "amount", value: 30 },
    );
    const nodes: NodeCard[] = [
      ...s.nodes,
      { id: "portra", type: "heeler.group", name: "Portra Grade", cat: "group", x: 0, y: 0, enabled: true, params: {}, isGroup: true, hasOut: true,
        groupNodes: [{ id: "portra_1", type: "heeler.exposure", name: "Exposure", cat: "color", x: 0, y: 0, enabled: true, params: { exposure: 1 } } as NodeCard] } as NodeCard,
    ];
    const out = migrateGraph(nodes, s.wires);
    expect(out.nodes.find((x) => x.id === "crop")!.params.crop_w).toBe(0.5);
    expect(out.nodes.find((x) => x.id === "bw")!.params.amount).toBe(100);
    expect(out.nodes.find((x) => x.id === "sharpen")!.params.amount).toBe(30);
    expect(out.nodes.some((x) => x.id === "portra")).toBe(true);
  });

  it("the before pane carries a crop the fresh graph never had", () => {
    let s = fresh();
    s = run(s, { type: "select_image", id: "4869" });
    s = { ...s, nodes: structuredClone(NEUTRAL_NODES), wires: structuredClone(NEUTRAL_WIRES) };
    s = run(s, { type: "set_param", id: "crop", param: "crop_w", value: 0.5 });
    const before = serializeBeforeGraph(s, "4869") as unknown as {
      nodes: { type: string; params: Record<string, number> }[];
    };
    const crop = before.nodes.find((n) => n.type === "heeler.crop_rotate");
    expect(crop?.params.crop_w).toBe(0.5);
  });
});

describe("what counts as an edit", () => {
  it("a graph change marks the photo edited, a layout move does not", () => {
    let s = run(initialState(), { type: "select_image", id: "4869" });
    const edited = () => s.images.find((i) => i.id === "4869")!.edited;
    expect(edited()).toBe(false);
    s = run(s, { type: "move_node", id: "exposure", x: 500, y: 500 });
    expect(edited()).toBe(false);
    s = run(s, { type: "set_category", title: "Grain", on: true });
    expect(edited()).toBe(true);
    // Reset clears it; adding a Color Set sets it again with no dial moved.
    s = run(s, { type: "reset_image_edits", id: "4869" });
    expect(edited()).toBe(false);
    s = run(s, { type: "add_color_set" });
    expect(edited()).toBe(true);
  });

  it("the Color Tune's pick can aim at one custom band, and toggles per aim", () => {
    let s = run(initialState(), { type: "toggle_console_pick", id: "n1" });
    expect(s.consolePick).toBe("n1");
    expect(s.consolePickBand).toBe(null);
    // Arming a row's picker while the new-band pick is armed re-aims
    // rather than disarming.
    s = run(s, { type: "toggle_console_pick", id: "n1", band: "c2" });
    expect(s.consolePick).toBe("n1");
    expect(s.consolePickBand).toBe("c2");
    // The same aim again disarms both.
    s = run(s, { type: "toggle_console_pick", id: "n1", band: "c2" });
    expect(s.consolePick).toBe(null);
    expect(s.consolePickBand).toBe(null);
    // The name format is a preference and only takes its three values.
    s = run(s, { type: "set_prefs", prefs: { consoleNameFormat: "hex" } });
    expect(s.prefs.consoleNameFormat).toBe("hex");
    s = run(s, { type: "set_prefs", prefs: { consoleNameFormat: "cmyk" as never } });
    expect(s.prefs.consoleNameFormat).toBe("rgb");
  });
});

/* Levels followed Curves onto the finished profile (2026-09-13: "the
 * smallest nudge of a slider has huge changes"): the same load-time
 * move, under the same rule.*/
describe("levels moving onto the profile", () => {
  const OLD_ORDER = [
    "src", "merge", "crop", "lens", "stdcolor", "cbal", "levels",
    "exposure", "bw", "denoise", "sharpen", "grain", "bend", "profile", "curves", "output",
  ];
  const withOldWiring = () => {
    const s = initialState();
    const wires = spliceIn(spliceOut(s.wires, "levels"), "levels", OLD_ORDER);
    return run(s, { type: "replace_graph", nodes: s.nodes, wires, backdrops: [] });
  };

  it("the sample opens with Levels between the profile and Curves", () => {
    const s = initialState();
    expect(s.wires.some((w) => w.from === "profile" && w.to === "levels")).toBe(true);
    expect(s.wires.some((w) => w.from === "levels" && w.to === "curves")).toBe(true);
    expect(s.wires.some((w) => w.from === "cbal" && w.to === "exposure")).toBe(true);
  });

  it("an untouched Levels is rewired to ride on the profile, ahead of Curves, and the move is idempotent", () => {
    let s = withOldWiring();
    expect(s.wires.some((w) => w.from === "cbal" && w.to === "levels")).toBe(true);
    s = run(s, { type: "move_levels_late" });
    expect(s.wires.some((w) => w.from === "profile" && w.to === "levels")).toBe(true);
    expect(s.wires.some((w) => w.from === "levels" && w.to === "curves")).toBe(true);
    expect(s.wires.some((w) => w.from === "cbal" && w.to === "exposure")).toBe(true);
    expect(run(s, { type: "move_levels_late" }).wires).toEqual(s.wires);
  });

  it("a Levels someone has set stays where they set it", () => {
    let s = withOldWiring();
    s = run(s, { type: "set_param", id: "levels", param: "black", value: 0.1 });
    const before = s.wires;
    expect(run(s, { type: "move_levels_late" }).wires).toEqual(before);
  });
});


it("Reset all edits folds an explicitly unfolded Color Checker", () => {
  let s = initialState();
  s = reduce(s, { type: "open_section", title: "Color Checker" });
  expect(s.sectionsClosed).not.toContain("Color Checker");
  s = reduce(s, { type: "reset_image_edits", id: s.activeImage });
  expect(s.sectionsClosed).toContain("Color Checker");
});

describe("a photograph's own line thickness", () => {
  // 2026-09-28: the Thickness row follows the preference or is set for
  // one photograph, and no node carries it.
  it("each photograph keeps its own across a switch, and the rest follow the preference", async () => {
    const { shapeLineWidth } = await import("../state");
    let s = initialState();
    const a = s.activeImage;
    s = run(s, { type: "set_photo_line_width", width: 5 });
    expect(shapeLineWidth(s)).toBe(5);
    s = run(s, { type: "select_image", id: "4866" });
    expect(shapeLineWidth(s)).toBe(s.prefs.shapeLineWidth);
    s = run(s, { type: "set_photo_line_width", width: 7 });
    s = run(s, { type: "set_prefs", prefs: { shapeLineWidth: 3 } });
    expect(shapeLineWidth(s)).toBe(7);
    s = run(s, { type: "select_image", id: a });
    expect(shapeLineWidth(s)).toBe(5);
    s = run(s, { type: "set_photo_line_width", width: 0 });
    expect(shapeLineWidth(s)).toBe(3);
    expect(s.photoLineWidth).toEqual({ "4866": 7 });
    // Undo takes back edits, not a view setting.
    expect(s.undoStack.some((e) => /outline|thickness/i.test(e.label))).toBe(false);
  });
});
