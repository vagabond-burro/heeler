// The selection mask, on the frontend side.
//
// The thing worth pinning down is that nothing here ever becomes pixels.
// Every gesture ends as geometry, every edit rewrites geometry, and what
// goes to the engine is coordinates.

import { describe, expect, it, vi } from "vitest";
import { initialState } from "../data";
import { runCommand } from "../commands";
import { DOC_SEL_ID, activeSelectionMask, artLayers, artMaskNode } from "../state";
import { LAYER_MASK_TYPES, RADIAL_SHAPES, reduce, SELECT_METHODS, SELECT_OPS, type Command, type SelectOp, type SelectRegion, type State } from "../state";
import { serializeGraph } from "../bridge";
import { edgeField, snapToEdge, thin } from "../ui/selection";
import { selectionField } from "../ui/selectionfield";

const run = (s: State, ...cmds: Command[]) => cmds.reduce(reduce, s);

function withSelectionLayer() {
  const s = run(initialState(), { type: "add_layer", maskType: "selection" });
  const id = s.nodes.find((n) => n.id === s.activeLayer!.replace("_adj", "_mask"))!.id;
  return { s, id };
}

const square = (op: SelectOp = "add") => ({
  kind: "path" as const,
  op,
  points: [
    [0.2, 0.2],
    [0.8, 0.2],
    [0.8, 0.8],
    [0.2, 0.8],
  ] as [number, number][],
});

describe("the selection history", () => {
  /// The region list is an editable selection history, which a pixel
  /// mask structurally cannot be. "we should have a button
  /// to enable/disable a selection. I know for a fact NONE of the
  /// other apps have that."
  it("a region can sit out without being thrown out", () => {
    let { s, id } = withSelectionLayer();
    s = run(s, { type: "add_region", id, region: square("replace") });
    s = run(s, { type: "add_region", id, region: { ...square("subtract"), points: [[0.4, 0.4], [0.6, 0.4], [0.6, 0.6], [0.4, 0.6]] } });
    s = run(s, { type: "set_region_off", id, index: 1, off: true });

    const node = s.nodes.find((n) => n.id === id)!;
    expect(node.regions).toHaveLength(2);
    expect(node.regions![1].off).toBe(true);

    // The engine never learns an off region exists.
    const g = serializeGraph(s);
    const sent = JSON.parse(
      (g.nodes.find((n) => n.id === id)!.params as { regions: string }).regions,
    );
    expect(sent).toHaveLength(1);
    expect(sent[0].op).toBe("replace");

    // And the frontend field holds its silence the same way.
    const withOff = selectionField(node.regions!, null, {});
    const withoutSecond = selectionField([node.regions![0]], null, {});
    expect(withOff).toEqual(withoutSecond);

    // Back on: the vote returns.
    s = run(s, { type: "set_region_off", id, index: 1, off: false });
    expect(s.nodes.find((n) => n.id === id)!.regions![1].off).toBeUndefined();
  });

  /// Order is meaning: ops apply in sequence, so moving a subtract
  /// above an add changes what survives.
  it("regions reorder, and refuse nonsense moves", () => {
    let { s, id } = withSelectionLayer();
    s = run(s, { type: "add_region", id, region: { ...square("replace"), via: "first" } });
    s = run(s, { type: "add_region", id, region: { ...square("add"), via: "second" } });
    s = run(s, { type: "move_region", id, from: 1, to: 0 });
    const vias = (s.nodes.find((n) => n.id === id)!.regions ?? []).map(
      (r) => (r as { via?: string }).via,
    );
    expect(vias).toEqual(["second", "first"]);
    // Out of range or in place: the list stands.
    const same = run(s, { type: "move_region", id, from: 0, to: 5 });
    expect(same.nodes.find((n) => n.id === id)!.regions).toEqual(
      s.nodes.find((n) => n.id === id)!.regions,
    );
  });
});

describe("polish is modal", () => {
  /// "selection refinement is kind of a modal tool... You
  /// exit by canceling and applying the refinement." Same contract as the
  /// crop: escape puts the snapshot back, any other exit is a commit.
  it("escape drops the strokes painted since entry; any other exit keeps them", () => {
    let { s, id } = withSelectionLayer();
    s = run(s, { type: "add_region", id, region: square("replace") });
    s = run(s, { type: "set_tool", tool: "polish" });
    expect(s.tool).toBe("polish");
    s = run(s, {
      type: "add_polish_stroke",
      id,
      stroke: { points: [[0.5, 0.5]], radius: 0.1, mode: "matte" },
    });
    expect(s.nodes.find((n) => n.id === id)!.strokes).toHaveLength(1);

    const cancelled = reduce(s, { type: "cancel_tool" });
    expect(cancelled.tool).toBe("none");
    expect(cancelled.nodes.find((n) => n.id === id)!.strokes).toEqual([]);
    // The regions are not the snapshot's business; the rough selection
    // survives a canceled refinement.
    expect(cancelled.nodes.find((n) => n.id === id)!.regions).toHaveLength(1);

    const applied = reduce(s, { type: "set_tool", tool: "polish" });
    expect(applied.tool).toBe("none");
    expect(applied.nodes.find((n) => n.id === id)!.strokes).toHaveLength(1);
  });

  /// The stroke streams: it enters the graph at mousedown and its point
  /// list grows as the hand moves, so the matte refines under the brush.
  it("a streamed stroke grows in place rather than piling up copies", () => {
    let { s, id } = withSelectionLayer();
    s = run(
      s,
      { type: "set_tool", tool: "polish" },
      {
        type: "add_polish_stroke",
        id,
        stroke: { points: [[0.1, 0.1]], radius: 0.05, mode: "matte" },
      },
      { type: "update_polish_stroke", id, points: [[0.1, 0.1], [0.2, 0.2]] },
      { type: "update_polish_stroke", id, points: [[0.1, 0.1], [0.2, 0.2], [0.3, 0.3]] },
    );
    const strokes = s.nodes.find((n) => n.id === id)!.strokes!;
    expect(strokes).toHaveLength(1);
    expect((strokes[0] as { points: unknown[] }).points).toHaveLength(3);
    expect((strokes[0] as { mode?: string }).mode).toBe("matte");
  });
});

describe("a selection layer", () => {
  it("creates a selection mask node and arms the tool", () => {
    const { s, id } = withSelectionLayer();
    expect(s.nodes.find((n) => n.id === id)!.type).toBe("heeler.selection_mask");
    expect(s.nodes.find((n) => n.id === id)!.regions).toEqual([]);
    // Like the brush layer: adding one hands you the tool that uses it.
    expect(s.tool).toBe("select");
  });

  it("puts the tool down again when you move to another layer", () => {
    let { s } = withSelectionLayer();
    s = run(s, { type: "add_layer", maskType: "radial" });
    expect(s.tool).toBe("none");
  });

  it("offers every method and mode the owner asked for", () => {
    expect(SELECT_METHODS.map((m) => m.id)).toEqual([
      // The marquee shapes lead: they are what a hand reaches for
      // first, and both are dragged rather than traced.
      "rect",
      "ellipse",
      // Click for a corner, drag for a curve: the one method that
      // draws a shape rather than tracing or keying one.
      "pen",
      "freehand",
      // No Polygon. A pen anchor clicked without a drag has no handles,
      // and a cubic with no handles is a straight line, so Polygon was
      // the pen with its one interesting ability removed.
      "magnetic",
      "paint",
      "wand",
      // Region Select: the picture's own structure does the drawing.
      "region",
      // Smart click: the model does, and it makes a selection only.
      "smart",
    ]);
    // "specify if they are adding, replacing, or removing from a selection"
    expect(SELECT_OPS.map((o) => o.id)).toEqual(["replace", "add", "subtract", "intersect"]);
  });
});

describe("regions are geometry, and stay geometry", () => {
  it("keeps the points it was given", () => {
    const { s, id } = withSelectionLayer();
    const after = run(s, { type: "add_region", id, region: square() });
    const r = after.nodes.find((n) => n.id === id)!.regions![0];
    expect(r.kind).toBe("path");
    expect(r.kind === "path" && r.points).toHaveLength(4);
  });

  it("a vertex can be moved long after it was drawn", () => {
    // The whole reason for storing geometry rather than pixels.
    const { s, id } = withSelectionLayer();
    let next = run(s, { type: "add_region", id, region: square() });
    next = run(next, { type: "move_region_point", id, index: 0, point: 1, x: 0.55, y: 0.11 });
    const r = next.nodes.find((n) => n.id === id)!.regions![0];
    expect(r.kind === "path" && r.points[1]).toEqual([0.55, 0.11]);
    // And its neighbors are untouched.
    expect(r.kind === "path" && r.points[0]).toEqual([0.2, 0.2]);
  });

  it("keeps a dragged vertex inside the frame", () => {
    const { s, id } = withSelectionLayer();
    let next = run(s, { type: "add_region", id, region: square() });
    next = run(next, { type: "move_region_point", id, index: 0, point: 0, x: -3, y: 42 });
    const r = next.nodes.find((n) => n.id === id)!.regions![0];
    expect(r.kind === "path" && r.points[0]).toEqual([0, 1]);
  });

  it("a region's operation can be changed afterwards", () => {
    const { s, id } = withSelectionLayer();
    let next = run(s, { type: "add_region", id, region: square("add") });
    next = run(next, { type: "set_region_op", id, index: 0, op: "subtract" });
    expect(next.nodes.find((n) => n.id === id)!.regions![0].op).toBe("subtract");
  });

  it("smoothing is stored on the region, not baked into the points", () => {
    const { s, id } = withSelectionLayer();
    let next = run(s, { type: "add_region", id, region: { ...square(), smooth: 0 } });
    const before = next.nodes.find((n) => n.id === id)!.regions![0];
    next = run(next, { type: "set_region_smooth", id, index: 0, smooth: 0.8 });
    const after = next.nodes.find((n) => n.id === id)!.regions![0];
    expect(after.kind === "path" && after.smooth).toBe(0.8);
    // The points did not move: smoothing is applied at render, so it
    // stays adjustable instead of being a one-way trip.
    expect(after.kind === "path" && after.points).toEqual(before.kind === "path" && before.points);
  });

  it("removes one region without disturbing the others", () => {
    const { s, id } = withSelectionLayer();
    let next = run(
      s,
      { type: "add_region", id, region: square("add") },
      { type: "add_region", id, region: { kind: "key", op: "subtract", x: 0.5, y: 0.5, tolerance: 0.3 } },
      { type: "add_region", id, region: square("intersect") },
    );
    next = run(next, { type: "remove_region", id, index: 1 });
    const rs = next.nodes.find((n) => n.id === id)!.regions!;
    expect(rs.map((r) => r.op)).toEqual(["add", "intersect"]);
  });

  it("clearing empties the selection but keeps the layer", () => {
    const { s, id } = withSelectionLayer();
    let next = run(s, { type: "add_region", id, region: square() });
    next = run(next, { type: "clear_regions", id });
    expect(next.nodes.find((n) => n.id === id)!.regions).toEqual([]);
    expect(next.nodes.find((n) => n.id === id)).toBeDefined();
  });

  it("every edit is undoable, because every edit is just data", () => {
    const { s, id } = withSelectionLayer();
    let next = run(s, { type: "add_region", id, region: square() });
    next = run(next, { type: "move_region_point", id, index: 0, point: 0, x: 0.9, y: 0.9 });
    next = run(next, { type: "undo" });
    const r = next.nodes.find((n) => n.id === id)!.regions![0];
    expect(r.kind === "path" && r.points[0]).toEqual([0.2, 0.2]);
  });

  it("travels to the engine as coordinates, not pixels", () => {
    const { s, id } = withSelectionLayer();
    const next = run(s, { type: "add_region", id, region: square() });
    const graph = serializeGraph(next) as { nodes: { id: string; params: Record<string, unknown> }[] };
    const node = graph.nodes.find((n) => n.id === id)!;
    const sent = JSON.parse(String(node.params.regions));
    expect(sent).toHaveLength(1);
    expect(sent[0].points).toHaveLength(4);
    expect(sent[0].op).toBe("add");
  });
});

describe("the tool settings for the next region", () => {
  it("start somewhere sensible and clamp", () => {
    const s = initialState();
    expect(s.selectMethod).toBe("freehand");
    expect(s.selectOp).toBe("add");
    expect(run(s, { type: "set_select_tolerance", tolerance: 99 }).selectTolerance).toBe(1);
    expect(run(s, { type: "set_select_tolerance", tolerance: -1 }).selectTolerance).toBe(0.01);
    expect(run(s, { type: "set_select_smooth", smooth: 99 }).selectSmooth).toBe(1);
    expect(run(s, { type: "set_select_smooth", smooth: -1 }).selectSmooth).toBe(0);
  });

  it("changing the method or mode is not an undoable edit", () => {
    // These are tool settings, not changes to the picture.
    const { s } = withSelectionLayer();
    const depth = s.undoStack.length;
    const next = run(s, { type: "set_select_method", method: "pen" }, { type: "set_select_op", op: "subtract" });
    expect(next.selectMethod).toBe("pen");
    expect(next.selectOp).toBe("subtract");
    expect(next.undoStack.length).toBe(depth);
  });
});

describe("edge snapping", () => {
  /** A frame with a hard vertical edge down the middle. */
  function splitFrame(w: number, h: number): Uint8ClampedArray {
    const px = new Uint8ClampedArray(w * h * 4);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const v = x < w / 2 ? 20 : 235;
        const i = (y * w + x) * 4;
        px[i] = px[i + 1] = px[i + 2] = v;
        px[i + 3] = 255;
      }
    }
    return px;
  }

  it("finds the edge in the picture", () => {
    const field = edgeField(splitFrame(40, 20), 40, 20);
    const at = (x: number, y: number) => field.data[y * 40 + x];
    // Strong right at the boundary, nothing out in the flat halves.
    expect(at(20, 10)).toBeGreaterThan(0.5);
    expect(at(5, 10)).toBeLessThan(0.05);
    expect(at(35, 10)).toBeLessThan(0.05);
  });

  it("pulls a nearby point onto the edge", () => {
    const field = edgeField(splitFrame(40, 20), 40, 20);
    // Traced a little to the left of the boundary at x = 0.5.
    const [x] = snapToEdge(field, 0.43, 0.5, 0.2);
    expect(x).toBeGreaterThan(0.46);
    expect(x).toBeLessThan(0.54);
  });

  it("leaves a point alone when there is no edge to snap to", () => {
    // Flat gray: nothing to find, so the hand wins.
    const flat = new Uint8ClampedArray(40 * 20 * 4).fill(128);
    const field = edgeField(flat, 40, 20);
    expect(snapToEdge(field, 0.3, 0.7, 0.2)).toEqual([0.3, 0.7]);
    // And with no field at all, which is what a cross-origin frame gives.
    expect(snapToEdge(null, 0.3, 0.7, 0.2)).toEqual([0.3, 0.7]);
  });

  it("does not reach past its radius", () => {
    const field = edgeField(splitFrame(40, 20), 40, 20);
    // Far from the edge with a tight radius: stays put.
    const [x, y] = snapToEdge(field, 0.1, 0.5, 0.02);
    expect(x).toBeCloseTo(0.1, 1);
    expect(y).toBeCloseTo(0.5, 1);
  });

  /// "would it be possible to have a sensitivity
  /// slider for magnetic selection?" Sensitivity is how faint an
  /// edge still attracts the trace: a wisp of fur is a whisper
  /// next to a silhouette, and whether the magnet hears it is a
  /// choice.
  it("sensitivity decides whether a faint edge attracts the trace", () => {
    // A bold silhouette at x=9 anchors the field's scale (edgeField
    // normalizes to the frame's peak, and a real photograph always has
    // a strong edge somewhere); the whisper is the 235-to-250 step at
    // x=20, a wisp next to it.
    const w = 40;
    const h = 20;
    const px = new Uint8ClampedArray(w * h * 4);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const v = x < 9 ? 20 : x < 20 ? 235 : 250;
        const i = (y * w + x) * 4;
        px[i] = px[i + 1] = px[i + 2] = v;
        px[i + 3] = 255;
      }
    }
    const field = edgeField(px, w, h);
    // Probing near the whisper, with the silhouette out of reach.
    const [eager] = snapToEdge(field, 0.43, 0.5, 0.2, 1.0);
    expect(eager).toBeGreaterThan(0.46);
    const [deaf] = snapToEdge(field, 0.43, 0.5, 0.2, 0.0);
    expect(deaf).toBeCloseTo(0.43, 2);
    // And leaving it unset is the magnet as it always behaved.
    expect(snapToEdge(field, 0.43, 0.5, 0.2)).toEqual(
      snapToEdge(field, 0.43, 0.5, 0.2, 0.5),
    );
  });
});

describe("thinning a freehand drag", () => {
  it("drops points too close together to be worth keeping", () => {
    // A drag fires far more points than anyone could edit.
    const dense: [number, number][] = Array.from({ length: 50 }, (_, i) => [0.5 + i * 0.0001, 0.5]);
    expect(thin(dense).length).toBeLessThan(5);
  });

  it("keeps the shape of a real outline", () => {
    const corners: [number, number][] = [
      [0.1, 0.1],
      [0.9, 0.1],
      [0.9, 0.9],
      [0.1, 0.9],
    ];
    expect(thin(corners)).toEqual(corners);
  });
});

describe("every mask type is reachable", () => {
  /// The selection layer could not be found where layers are
/// added.
  ///
  /// It was in the Layer menu and nowhere else. The Layers panel's row
  /// of add buttons was its own hardcoded list of four, so a fifth mask
  /// type could be wired through the entire app and still have no button
  /// where anyone actually adds a layer.
  it("has a button in the Layers panel for every mask type", async () => {
    const { render, screen } = await import("@testing-library/react");
    const { App } = await import("../app");
    render(<App />);
    // Object is the one kind with a condition: it shows only for a
    // photograph whose file names objects, and then first. Its seat is
    // pinned in mattetool.test.tsx; a plain photograph offers the rest.
    for (const t of LAYER_MASK_TYPES.filter((k) => k !== "object")) {
      expect(
        screen.getByTestId(`add-layer-${t}`),
        `no add-layer button for "${t}", so it can only be reached from the menu`,
      ).toBeInTheDocument();
    }
    expect(screen.queryByTestId("add-layer-object")).toBeNull();
  });

  it("the panel list and the type union cannot drift apart", () => {
    // Every type the app knows how to build a node for is offered.
    const buildable: string[] = ["range", "radial", "linear", "brush", "selection", "smart", "object"];
    expect([...LAYER_MASK_TYPES].sort()).toEqual([...buildable].sort());
  });

  it("every type actually builds a mask node", () => {
    for (const maskType of LAYER_MASK_TYPES) {
      const s = run(initialState(), { type: "add_layer", maskType });
      const mask = s.nodes.find((n) => n.id === s.activeLayer!.replace("_adj", "_mask"));
      expect(mask, `${maskType} built no mask node`).toBeDefined();
      expect(mask!.type).toMatch(/^heeler\./);
    }
  });

  /// One selection system, whoever owns the selection.
  /// "this selection functionality could also be used for selection
  /// adjustment layers... How can we unify this functionality?" The
  /// Selection tab resolves to the active layer's mask, so an
  /// adjustment-layer selection gets the same history the document
  /// selection gets, and adding the layer takes you there.
  it("a selection adjustment layer shares the selection history machinery", () => {
    let s = run(initialState(), { type: "add_layer", maskType: "selection" });
    expect(s.tool).toBe("select");
    const id = s.activeLayer!.replace("_adj", "_mask");
    expect(activeSelectionMask(s)?.id).toBe(id);
    // The shared history machinery works on the layer's own regions.
    s = run(s, { type: "add_region", id, region: square("replace") });
    s = run(s, { type: "set_region_off", id, index: 0, off: true });
    expect(s.nodes.find((n) => n.id === id)!.regions![0].off).toBe(true);
  });
});

describe("the brush cursor is the brush", () => {
  /// "The cursor should be the brush shape and
/// size."
  const mount = async (tip: string, alt = false) => {
    const { render, screen, fireEvent } = await import("@testing-library/react");
    const { BrushOverlay } = await import("../ui/overlays");
    const node = { id: "b", type: "heeler.brush_mask", strokes: [] } as never;
    const view = render(
      <BrushOverlay node={node} radius={0.1} dispatch={() => {}} tip={tip} />,
    );
    const overlay = screen.getByTestId("brush-overlay");
    // jsdom reports every element as zero-sized, and the cursor
    // correctly declines to draw itself into a box with no size.
    Object.defineProperty(overlay, "clientWidth", { value: 400, configurable: true });
    Object.defineProperty(overlay, "clientHeight", { value: 300, configurable: true });
    fireEvent.mouseMove(overlay, { clientX: 200, clientY: 150, altKey: alt });
    const cursor = screen.getByTestId("brush-cursor");
    return { cursor, overlay, fireEvent, unmount: view.unmount };
  };

  it("does not draw before the pointer is over the photograph", async () => {
    const { render, screen } = await import("@testing-library/react");
    const { BrushOverlay } = await import("../ui/overlays");
    const view = render(
      <BrushOverlay
        node={{ id: "b", type: "heeler.brush_mask", strokes: [] } as never}
        radius={0.1}
        dispatch={() => {}}
      />,
    );
    expect(screen.queryByTestId("brush-cursor")).not.toBeInTheDocument();
    view.unmount();
  });

  it("is round for the round tip and square for the square one", async () => {
    const round = await mount("circle");
    expect(round.cursor.querySelector("circle")).toBeTruthy();
    expect(round.cursor.querySelector("rect")).toBeNull();
    round.unmount();

    const square = await mount("square");
    expect(square.cursor.querySelector("rect")).toBeTruthy();
    square.unmount();
  });

  it("is round for the textured tips, which sample inside a round bound", async () => {
    for (const tip of ["texture", "splatter", "dry", "crosshatch"]) {
      const m = await mount(tip);
      expect(m.cursor.getAttribute("data-tip")).toBe(tip);
      expect(m.cursor.querySelector("rect"), `${tip} drew a square cursor`).toBeNull();
      m.unmount();
    }
  });

  it("is the size of the brush, measured off the short side", async () => {
    const m = await mount("circle");
    // radius 0.1 of a 400x300 box is 0.1 * 300 = 30, not 0.1 * 400.
    expect(Number(m.cursor.querySelector("circle")!.getAttribute("r"))).toBeCloseTo(30, 0);
    m.unmount();
  });

  it("says when it is about to erase instead of paint", async () => {
    const paint = await mount("circle");
    expect(paint.cursor.getAttribute("data-erasing")).toBeNull();
    paint.unmount();

    const erase = await mount("circle", true);
    expect(erase.cursor.getAttribute("data-erasing")).toBe("true");
    erase.unmount();
  });
});

describe("the radial gizmo is the shape it says it is", () => {
  /// The owner, twice: "The shape never changes no matter what I
  /// selected" and "I still don't see different shapes when change shape
  /// selection."
  ///
  /// The engine was right the whole time. The gizmo drew two hardcoded
  /// ellipses and never read the shape at all, so picking Cross moved
  /// nothing on screen, which is the only thing anyone can see.
  it("draws a different outline for every shape", async () => {
    const { shapeOutline, svgPoints } = await import("../ui/maskshapes");
    const drawn = new Map<string, string>();
    for (const s of RADIAL_SHAPES) {
      const geo = shapeOutline(s.id, { cx: 0.5, cy: 0.5, radius: 0.4 });
      // The bite counts as part of the drawing: a crescent's outer
      // boundary really is a circle, and it is the hole that makes it a
      // crescent on screen.
      drawn.set(
        s.id,
        [geo.points, ...(geo.extra ?? [])].map(svgPoints).join("|"),
      );
    }
    // No two shapes draw the same thing.
    expect(new Set(drawn.values()).size).toBe(RADIAL_SHAPES.length);
    expect(drawn.get("crescent")).not.toBe(drawn.get("ellipse"));
  });

  it("a rectangle reaches its corners where an ellipse does not", async () => {
    const { shapeOutline } = await import("../ui/maskshapes");
    const far = (shape: string) => {
      const { points } = shapeOutline(shape, { cx: 0.5, cy: 0.5, radius: 0.4 });
      // How far the outline gets from the center along the diagonal.
      return Math.max(
        ...points.map(([x, y]) => Math.min(Math.abs(x - 0.5), Math.abs(y - 0.5))),
      );
    };
    expect(far("rectangle")).toBeGreaterThan(far("ellipse") + 0.05);
  });

  /// "A user would expect to look like a crescent,
  /// not two overlapping ellipses."
  it("draws a crescent as one closed crescent, not two circles", async () => {
    const { shapeOutline } = await import("../ui/maskshapes");
    const geo = shapeOutline("crescent", { cx: 0.5, cy: 0.5, radius: 0.3, amount: 0.5 });
    // One loop, not a shape plus a hole.
    expect(geo.extra).toBeUndefined();

    // A crescent is concave and a disc is not. That is the difference
    // between the two, and it survives any amount of fiddling with the
    // size, unlike measuring how wide the shape is at a given height,
    // which is unstable right where the two arcs meet at a point.
    const turnsOf = (pts: [number, number][]) =>
      pts.map((p, i) => {
        const a = pts[(i + pts.length - 1) % pts.length];
        const b = pts[(i + 1) % pts.length];
        return (p[0] - a[0]) * (b[1] - p[1]) - (p[1] - a[1]) * (b[0] - p[0]);
      });
    const bendsBothWays = (pts: [number, number][]) => {
      const t = turnsOf(pts);
      return t.some((v) => v > 1e-9) && t.some((v) => v < -1e-9);
    };
    expect(bendsBothWays(geo.points), "a crescent has a concave side").toBe(true);
    // And the shape it is cut from does not, so this is really testing
    // the bite rather than a wobble in the point sampling.
    const disc = shapeOutline("ellipse", { cx: 0.5, cy: 0.5, radius: 0.3 });
    expect(bendsBothWays(disc.points)).toBe(false);

    const xs = geo.points.map((p) => p[0]);
    const ys = geo.points.map((p) => p[1]);
    const midY = (Math.min(...ys) + Math.max(...ys)) / 2;

    // The concave side faces left, matching the engine, which takes its
    // bite from that side.
    const leftmost = Math.min(...xs);
    const mid = geo.points.find((p) => Math.abs(p[1] - midY) < 0.012);
    expect(mid![0]).toBeGreaterThan(leftmost);
  });

  /// "I don't think having the two overlapping ellipses
  /// properly shows how feathering will be applied."
  ///
  /// Right, and the inner ring was the shape SCALED by 1 - feather,
  /// which is only the feather contour for a circle. On a crescent that
  /// slides the bite towards the middle and draws a line the mask never
  /// has. The engine's feather is a distance pulled in from the edge, so
  /// the gizmo insets rather than scales.
  it("insets the feather contour instead of scaling the shape", async () => {
    const { unitShape } = await import("../ui/maskshapes");
    // A crescent's bite GROWS as the feather pulls the body in, because
    // the bite is subtracted. Scaling would have shrunk it.
    const edge = unitShape("crescent", 0.5, 0);
    const inner = unitShape("crescent", 0.5, 0.25);
    const leftOf = (pts: [number, number][]) => Math.min(...pts.map((p) => p[0]));
    const rightOf = (pts: [number, number][]) => Math.max(...pts.map((p) => p[0]));
    // The outer tip comes in, as it must.
    expect(rightOf(inner.points)).toBeLessThan(rightOf(edge.points));
    // And the concave side comes in from the other direction too, rather
    // than following the body inward the way a scale would take it.
    expect(leftOf(inner.points)).toBeGreaterThan(leftOf(edge.points));
  });

  it("insets a polygon by the same distance on every edge", async () => {
    const { unitShape } = await import("../ui/maskshapes");
    // Scaling a stretched shape moves its far edges further than its
    // near ones; the engine's feather band is the same width all round.
    const edge = unitShape("rectangle", 0.5, 0);
    const inner = unitShape("rectangle", 0.5, 0.2);
    const extent = (pts: [number, number][], axis: 0 | 1) =>
      Math.max(...pts.map((p) => p[axis]));
    expect(extent(inner.points, 0)).toBeCloseTo(extent(edge.points, 0) - 0.2, 5);
    expect(extent(inner.points, 1)).toBeCloseTo(extent(edge.points, 1) - 0.2, 5);
  });

  it("draws nothing when the feather reaches the middle", async () => {
    const { unitShape } = await import("../ui/maskshapes");
    // There is no full-strength region left, so there is no contour to
    // draw, and an outline pinched into a knot would be a lie.
    expect(unitShape("triangle", 0.5, 5).points).toEqual([]);
    expect(unitShape("ellipse", 0.5, 2).points).toEqual([]);
    expect(unitShape("crescent", 0.5, 2).points).toEqual([]);
  });

  it("rotation turns the outline", async () => {
    const { shapeOutline, svgPoints } = await import("../ui/maskshapes");
    const at = (deg: number) =>
      svgPoints(shapeOutline("triangle", { cx: 0.5, cy: 0.5, radius: 0.3, rotation: deg }).points);
    expect(at(0)).not.toBe(at(90));
  });

  it("stays round on a frame that is not square", async () => {
    const { shapeOutline } = await import("../ui/maskshapes");
    // The engine measures in units of the short side; the gizmo has to
    // undo that or the two disagree about where the mask is.
    const { points } = shapeOutline("ellipse", {
      cx: 0.5,
      cy: 0.5,
      radius: 0.3,
      frameAspect: 2,
    });
    const spanX = Math.max(...points.map((p) => p[0])) - Math.min(...points.map((p) => p[0]));
    const spanY = Math.max(...points.map((p) => p[1])) - Math.min(...points.map((p) => p[1]));
    // Half the width in normalized terms, because the frame is twice as
    // wide: that is what draws as a circle on screen.
    expect(spanX / spanY).toBeCloseTo(0.5, 1);
  });
});

describe("reset means reset", () => {
  /// "Also, reset button didn't work." It dispatched the
  /// numeric defaults and nothing else, so on a brush mask (defaults: {})
  /// it did nothing at all, and on a selection it reset the feather and
  /// left every region where it was.
  it("clears a selection's regions", () => {
    const { s, id } = withSelectionLayer();
    let next = run(s, { type: "add_region", id, region: square() });
    expect(next.nodes.find((n) => n.id === id)!.regions).toHaveLength(1);
    next = run(next, { type: "reset_mask", id, maskType: "selection" });
    expect(next.nodes.find((n) => n.id === id)!.regions).toEqual([]);
  });

  it("clears a brush mask's strokes", () => {
    let s = run(initialState(), { type: "add_layer", maskType: "brush" });
    const id = s.nodes.find((n) => n.id === s.activeLayer!.replace("_adj", "_mask"))!.id;
    s = run(s, { type: "add_stroke", id, stroke: { points: [[0.5, 0.5]], radius: 0.1 } });
    expect(s.nodes.find((n) => n.id === id)!.strokes).toHaveLength(1);
    s = run(s, { type: "reset_mask", id, maskType: "brush" });
    expect(s.nodes.find((n) => n.id === id)!.strokes).toEqual([]);
  });

  it("puts a radial mask's shape back to an ellipse", () => {
    let s = run(initialState(), { type: "add_layer", maskType: "radial" });
    const id = s.nodes.find((n) => n.id === s.activeLayer!.replace("_adj", "_mask"))!.id;
    s = run(s, { type: "set_text_param", id, param: "shape", value: "cross" });
    s = run(s, { type: "reset_mask", id, maskType: "radial" });
    expect(s.nodes.find((n) => n.id === id)!.textParams!.shape).toBe("ellipse");
    expect(s.nodes.find((n) => n.id === id)!.params.radius).toBe(0.4);
  });

  it("is undoable, like every other edit", () => {
    const { s, id } = withSelectionLayer();
    let next = run(s, { type: "add_region", id, region: square() });
    next = run(next, { type: "reset_mask", id, maskType: "selection" });
    next = run(next, { type: "undo" });
    expect(next.nodes.find((n) => n.id === id)!.regions).toHaveLength(1);
  });
});

describe("brush opacity and the grain floor", () => {
  /// "we need a slider for opacity. Obviously 100% is
  /// maximum white. This is for all brushes."
  it("opacity rides on the stroke, so an old stroke keeps its own", () => {
    let s = run(initialState(), { type: "add_layer", maskType: "brush" });
    expect(s.brushFlow).toBe(1);
    s = run(s, { type: "set_brush_flow", flow: 0.4 });
    expect(s.brushFlow).toBe(0.4);
  });

  it("never lets a brush paint literally nothing", () => {
    // Zero opacity is indistinguishable from a broken brush.
    expect(run(initialState(), { type: "set_brush_flow", flow: 0 }).brushFlow).toBe(0.01);
    expect(run(initialState(), { type: "set_brush_flow", flow: 9 }).brushFlow).toBe(1);
  });

  /// "lower values are coming in gray and not fully
  /// transparent, there are cases where I want that in my textures."
  ///
  /// That quantity already existed as "Grain depth", which is the same
  /// number upside down and said nothing about transparency. It is the
  /// floor: how much coverage the darkest part of the grain keeps.
  it("a textured brush starts with its gaps fully transparent", () => {
    // Which is what "textured" normally means. The old default left the
    // gaps at 40% gray, which is the thing the owner noticed.
    const s = initialState();
    expect(s.brushTextureDepth).toBe(1);
    // floor = 1 - depth, so this is a floor of zero.
    expect(1 - s.brushTextureDepth).toBe(0);
  });

  it("the floor can be raised when the gray is what you want", () => {
    // The panel sets depth from 1 - floor, so a floor of 0.35 is a
    // depth of 0.65.
    const s = run(initialState(), { type: "set_brush_texture", depth: 1 - 0.35 });
    expect(1 - s.brushTextureDepth).toBeCloseTo(0.35, 5);
  });
});

describe("New starts a new selection", () => {
  /// "I noticed the New mode is adding to current
/// selection."
  ///
  /// The render was already right: replace discards whatever came
  /// before it. But the superseded outlines stayed on screen and in the
  /// list, so a new selection looked exactly like an added one.
  it("discards what came before it", () => {
    const { s, id } = withSelectionLayer();
    let next = run(
      s,
      { type: "add_region", id, region: square("add") },
      { type: "add_region", id, region: square("add") },
    );
    expect(next.nodes.find((n) => n.id === id)!.regions).toHaveLength(2);
    next = run(next, { type: "add_region", id, region: square("replace") });
    const rs = next.nodes.find((n) => n.id === id)!.regions!;
    expect(rs).toHaveLength(1);
    expect(rs[0].op).toBe("replace");
  });

  it("add still adds", () => {
    const { s, id } = withSelectionLayer();
    const next = run(
      s,
      { type: "add_region", id, region: square("add") },
      { type: "add_region", id, region: square("subtract") },
    );
    expect(next.nodes.find((n) => n.id === id)!.regions).toHaveLength(2);
  });
});

describe("the color brush", () => {
  /// "As I paint (click and drag over the image) it finds
  /// similar colors that were within the brush and selects those
  /// pixels."
  it("is a list of samples, not an outline", () => {
    const { s, id } = withSelectionLayer();
    const next = run(s, {
      type: "add_region",
      id,
      region: {
        kind: "samples",
        op: "add",
        points: [
          [0.2, 0.2],
          [0.3, 0.3],
        ],
        tolerance: 0.2,
      },
    });
    const r = next.nodes.find((n) => n.id === id)!.regions![0];
    expect(r.kind).toBe("samples");
    // Which means it goes to the engine as samples, and stays a rule
    // about the image rather than becoming a shape drawn on it.
    const graph = serializeGraph(next) as { nodes: { id: string; params: Record<string, unknown> }[] };
    const sent = JSON.parse(String(graph.nodes.find((n) => n.id === id)!.params.regions));
    expect(sent[0].kind).toBe("samples");
    expect(sent[0].points).toHaveLength(2);
  });

  it("has its own size, which is not the tolerance", () => {
    const s = initialState();
    expect(s.selectBrushRadius).toBe(0.04);
    expect(run(s, { type: "set_select_brush_radius", radius: 0.5 }).selectBrushRadius).toBe(0.3);
    expect(run(s, { type: "set_select_brush_radius", radius: 0 }).selectBrushRadius).toBe(0.005);
  });
});

describe("deleting a layer puts its tool down", () => {
  /// "my cursor is not resetting when I delete a paint
  /// layer. It still has the brush preview."
  it("disarms the brush when its layer is deleted", () => {
    const s = run(initialState(), { type: "add_layer", maskType: "brush" });
    expect(s.tool).toBe("brush");
    const after = run(s, { type: "remove_layer", id: s.activeLayer! });
    expect(after.activeLayer).toBeNull();
    expect(after.tool).toBe("none");
  });

  it("disarms the selection tool the same way", () => {
    const { s } = withSelectionLayer();
    expect(s.tool).toBe("select");
    expect(run(s, { type: "remove_layer", id: s.activeLayer! }).tool).toBe("none");
  });

  it("leaves a tool alone when a different layer is deleted", () => {
    let s = run(initialState(), { type: "add_layer", maskType: "radial" });
    const radial = s.activeLayer!;
    s = run(s, { type: "add_layer", maskType: "brush" });
    // Deleting the radial layer must not take the brush away from the
    // layer that is actually active.
    const after = run(s, { type: "remove_layer", id: radial });
    expect(after.tool).toBe("brush");
  });
});

describe("the radial gizmo says what a drag will do", () => {
  /// "The cursor never changes so I don't know what
  /// happens when I drag on different parts of the shape."
  it("names a zone for every part of the shape", async () => {
    const { radialZoneAt } = await import("../ui/overlays");
    const feather = 0.3;
    // Middle: move. Edge: scale. Outside: rotate. Far out: nothing, so
    // the stage keeps its own zoom and pan.
    expect(radialZoneAt(0.1, 0, feather)).toBe("move");
    expect(radialZoneAt(1.0, 45, feather)).toBe("uniform");
    expect(radialZoneAt(1.4, 0, feather)).toBe("rotate");
    expect(radialZoneAt(3.0, 0, feather)).toBeNull();
  });

  it("tells uniform scaling from stretching one axis", async () => {
    const { radialZoneAt } = await import("../ui/overlays");
    // On the shape's own axes: one axis only, which is where the square
    // handles sit. On the diagonals: both, where the round ones are.
    for (const axis of [0, 90, 180, -90]) {
      expect(radialZoneAt(1.0, axis, 0.3), `${axis} degrees`).toBe("aspect");
    }
    for (const diag of [45, 135, -45, -135]) {
      expect(radialZoneAt(1.0, diag, 0.3), `${diag} degrees`).toBe("uniform");
    }
  });

  it("offers the feather ring where the feather actually is", async () => {
    const { radialZoneAt } = await import("../ui/overlays");
    // Feather 0.4 puts the ring at 0.6 of the radius.
    expect(radialZoneAt(0.6, 30, 0.4)).toBe("feather");
    // With no feather there is no ring to grab, and the middle stays
    // draggable rather than becoming a dead zone.
    expect(radialZoneAt(0.6, 30, 0)).toBe("move");
    // And a feather so small the ring sits on the edge lets scaling win,
    // since two controls in the same pixel is worse than one.
    expect(radialZoneAt(0.97, 45, 0.05)).toBe("uniform");
  });

  it("snaps rotation to ten degrees on SHIFT and not otherwise", async () => {
    const { snapRotation } = await import("../ui/overlays");
    expect(snapRotation(37.4, false)).toBeCloseTo(37.4, 5);
    expect(snapRotation(37.4, true)).toBe(40);
    expect(snapRotation(-93, true)).toBe(-90);
    // And stays in a half turn either way, so the slider agrees with it.
    expect(snapRotation(200, false)).toBeCloseTo(-160, 5);
  });

  it("picks the resize arrow that points along the axis being dragged", async () => {
    const { resizeCursorFor } = await import("../ui/cursors");
    expect(resizeCursorFor(0)).toBe("ew-resize");
    expect(resizeCursorFor(90)).toBe("ns-resize");
    expect(resizeCursorFor(45)).toBe("nwse-resize");
    expect(resizeCursorFor(135)).toBe("nesw-resize");
    // A rotated shape asks for angles all over, and pointing left says
    // the same as pointing right.
    expect(resizeCursorFor(180)).toBe("ew-resize");
    expect(resizeCursorFor(-90)).toBe("ns-resize");
    expect(resizeCursorFor(370)).toBe("ew-resize");
  });

  it("has a real cursor for rotate and feather, which CSS does not name", async () => {
    const { ROTATE_CURSOR, FEATHER_CURSOR } = await import("../ui/cursors");
    for (const c of [ROTATE_CURSOR, FEATHER_CURSOR]) {
      expect(c).toMatch(/^url\("data:image\/svg\+xml,/);
      // A hotspot and a fallback, or a browser that refuses the image
      // shows a plain arrow and says nothing.
      expect(c).toMatch(/\d+ \d+, auto$/);
    }
    expect(ROTATE_CURSOR).not.toBe(FEATHER_CURSOR);
  });
});

describe("the bend wheel's reach ring", () => {
  /// "having the default size of the ring the size of
  /// the color circle is confusing. I think it should be 1/3 the
  /// radius."
  ///
  /// It was drawn at the full radius, which put it exactly on top of the
  /// wheel's own edge: two circles in the same place, one of them a
  /// control you are supposed to notice and drag.
  it("starts at a third of the wheel, not the whole of it", async () => {
    const { BEND_FALLOFF_DEFAULT } = await import("../state");
    expect(BEND_FALLOFF_DEFAULT).toBeCloseTo(1 / 3, 6);
    // Which is inside the wheel, so the ring is visible as its own thing.
    expect(BEND_FALLOFF_DEFAULT).toBeLessThan(1);
  });

  it("is the same number everywhere a new bend node is made", async () => {
    // The frontend's sample graph, its per-type defaults, and the engine
    // spec all have to agree, or a node built one way reaches further
    // than the same node built another.
    const { initialState } = await import("../data");
    const { BEND_FALLOFF_DEFAULT, reduce } = await import("../state");
    // Built the way the app builds it, which is on demand now: Bend is not
    // in a photograph until somebody asks for it.
    const s0 = initialState();
    const s = reduce(
      { ...s0, nodes: s0.defaultGraph.nodes, wires: s0.defaultGraph.wires },
      { type: "set_category", title: "Color Bend", on: true },
    );
    const bend = s.nodes.find((n) => n.type === "heeler.color_bend")!;
    expect(bend.params.falloff).toBe(BEND_FALLOFF_DEFAULT);
    // And Reset writes the same number, or a reset bend would reach
    // further than a new one. There is a contract test for that in
    // state.test.ts; this is the half that names the value.
    const { PARAM_DEFAULT } = await import("../ui/simple");
    expect(PARAM_DEFAULT.falloff).toBe(BEND_FALLOFF_DEFAULT);
  });
});

describe("marching ants follow the selection, not its pieces", () => {
  /// "If I have a selection, and I draw another selecting
  /// around it I expect the add to append to the current selection. So
  /// any of the second selection that goes inside the original selection
  /// is just absorbed and any selection outside the original extends the
  /// marching ants."
  const box = (
    x0: number,
    y0: number,
    x1: number,
    y1: number,
    op: SelectOp = "add",
  ): SelectRegion => ({
    kind: "path",
    op,
    points: [
      [x0, y0],
      [x1, y0],
      [x1, y1],
      [x0, y1],
    ],
  });

  const trace = async (regions: SelectRegion[]) => {
    const { selectionField, traceContours } = await import("../ui/selectionfield");
    return traceContours(selectionField(regions, null));
  };

  it("draws one outline for one region", async () => {
    expect(await trace([box(0.3, 0.3, 0.7, 0.7)])).toHaveLength(1);
  });

  it("absorbs a region drawn inside another", async () => {
    // The whole of the second one is already selected, so it adds no
    // boundary at all: one outline, the same as before.
    const loops = await trace([box(0.2, 0.2, 0.8, 0.8), box(0.4, 0.4, 0.6, 0.6)]);
    expect(loops).toHaveLength(1);
  });

  it("extends the outline when the second region reaches outside", async () => {
    const one = await trace([box(0.2, 0.2, 0.5, 0.5)]);
    const two = await trace([box(0.2, 0.2, 0.5, 0.5), box(0.4, 0.4, 0.8, 0.8)]);
    // Still one selection, not two shapes with a seam between them.
    expect(two).toHaveLength(1);
    // And it now reaches further than the first did.
    const far = (loops: [number, number][][]) =>
      Math.max(...loops.flat().map((p) => p[0]));
    expect(far(two)).toBeGreaterThan(far(one) + 0.2);
  });

  it("leaves two outlines for two selections that do not touch", async () => {
    // Merging is about overlap, not about lumping everything together.
    const loops = await trace([box(0.05, 0.05, 0.3, 0.3), box(0.7, 0.7, 0.95, 0.95)]);
    expect(loops).toHaveLength(2);
  });

  it("traces the hole a subtract leaves", async () => {
    // An outer boundary and an inner one, which is the thing a per
    // region outline could never show correctly.
    const loops = await trace([
      box(0.15, 0.15, 0.85, 0.85),
      box(0.4, 0.4, 0.6, 0.6, "subtract"),
    ]);
    expect(loops).toHaveLength(2);
    const spans = loops
      .map((l) => Math.max(...l.map((p) => p[0])) - Math.min(...l.map((p) => p[0])))
      .sort((a, b) => a - b);
    // The hole is the smaller of the two.
    expect(spans[0]).toBeLessThan(spans[1] / 2);
  });

  it("shows nothing at all when nothing is selected", async () => {
    expect(await trace([])).toEqual([]);
    // And when a subtract removes everything that was there.
    expect(await trace([box(0.3, 0.3, 0.6, 0.6), box(0.1, 0.1, 0.9, 0.9, "subtract")])).toEqual([]);
  });

  it("keeps only the overlap for an intersect", async () => {
    const loops = await trace([box(0.2, 0.2, 0.6, 0.6), box(0.4, 0.4, 0.8, 0.8, "intersect")]);
    expect(loops).toHaveLength(1);
    const xs = loops[0].map((p) => p[0]);
    // Roughly the 0.4..0.6 overlap, not either whole box.
    expect(Math.min(...xs)).toBeGreaterThan(0.35);
    expect(Math.max(...xs)).toBeLessThan(0.65);
  });

  it("closes a selection that runs off the edge of the frame", async () => {
    // Half of it is outside the picture; the ants still have to be a
    // closed loop or the outline is a stray line.
    const loops = await trace([box(-0.3, 0.3, 0.4, 0.7)]);
    expect(loops).toHaveLength(1);
    expect(loops[0].length).toBeGreaterThan(3);
  });
});

describe("Select All, Deselect and Invert", () => {
  const run3 = (s: State, id: string) => {
    const out: Command[] = [];
    runCommand(id, s, (c) => out.push(c));
    return out;
  };

  it("Select All lays one region over the whole frame", () => {
    const { s, id } = withSelectionLayer();
    const cmds = run3(s, "select.all");
    const add = cmds.find((c) => c.type === "add_region") as
      | Extract<Command, { type: "add_region" }>
      | undefined;
    expect(add?.id).toBe(id);
    expect(add?.region.kind).toBe("marquee");
    // Replace, not add: "all" means all, whatever was selected before.
    expect(add?.region.op).toBe("replace");
    const after = reduce(s, add!);
    expect(after.nodes.find((n) => n.id === id)!.regions).toHaveLength(1);
  });

  it("Deselect clears the regions and never leaves it inverted", () => {
    let { s, id } = withSelectionLayer();
    s = reduce(s, { type: "add_region", id, region: square() });
    s = reduce(s, { type: "set_param", id, param: "invert", value: 1 });
    for (const c of run3(s, "select.none")) s = reduce(s, c);
    // An empty selection that stayed inverted would select the whole
    // frame, which is the opposite of what Deselect means.
    expect(s.nodes.find((n) => n.id === id)!.regions).toHaveLength(0);
    expect(s.nodes.find((n) => n.id === id)!.params.invert).toBe(0);
  });

  it("Invert flips the mask's own flag rather than rewriting regions", () => {
    let { s, id } = withSelectionLayer();
    s = reduce(s, { type: "add_region", id, region: square() });
    for (const c of run3(s, "select.invert")) s = reduce(s, c);
    expect(s.nodes.find((n) => n.id === id)!.params.invert).toBe(1);
    // The shape you drew is still the shape you drew, and inverting
    // again puts it back without an undo.
    expect(s.nodes.find((n) => n.id === id)!.regions).toHaveLength(1);
    for (const c of run3(s, "select.invert")) s = reduce(s, c);
    expect(s.nodes.find((n) => n.id === id)!.params.invert).toBe(0);
  });

  it("all three hand the key back when there is no selection to act on", () => {
    const s = initialState();
    for (const id of ["select.all", "select.none", "select.invert"]) {
      expect(runCommand(id, s, () => {})).toBe(false);
    }
  });
});

describe("the Select menu's polish and range commands", () => {
  const fire = (s: State, id: string) => {
    let next = s;
    runCommand(id, s, (c) => {
      next = reduce(next, c);
    });
    return next;
  };

  it("Smooth, Feather and Resize open onto the mask's own numbers", () => {
    for (const [cmd, param] of [
      ["select.smooth", "smooth"],
      ["select.feather", "feather"],
      ["select.resize", "grow"],
    ] as const) {
      let { s, id } = withSelectionLayer();
      s = reduce(s, { type: "set_param", id, param, value: 0.4 });
      s = fire(s, cmd);
      // Opened remembering what it found, so Cancel has something to
      // put back: these steer the live param rather than a draft.
      expect(s.selectDialog).toEqual({ kind: "param", param, restore: 0.4 });
    }
  });

  it("a range command lays down a real region and points the dialog at it", () => {
    let { s, id } = withSelectionLayer();
    s = fire(s, "select.range.luma");
    const region = s.nodes.find((n) => n.id === id)!.regions![0];
    expect(region.kind).toBe("range");
    // Opened on a band rather than on nothing: a dialog that selected
    // nothing until you moved a slider would make you guess.
    expect(region).toMatchObject({ channel: "luma", lo: 0.5, hi: 1 });
    expect(s.selectDialog).toMatchObject({ kind: "range", mode: "luma", index: 0 });

    // Color and contrast are the same dialog pointed at another plane.
    let c = fire(withSelectionLayer().s, "select.range.color");
    expect(c.selectDialog).toMatchObject({ mode: "color", channel: "red" });
    let k = fire(withSelectionLayer().s, "select.range.contrast");
    expect(k.selectDialog).toMatchObject({ mode: "contrast", channel: "contrast" });
  });

  it("update_region steers one region without disturbing the others", () => {
    let { s, id } = withSelectionLayer();
    s = reduce(s, { type: "add_region", id, region: square() });
    s = fire(s, "select.range.luma");
    const at = () => s.nodes.find((n) => n.id === id)!.regions!;
    expect(at()).toHaveLength(2);
    const range = at()[1] as Extract<SelectRegion, { kind: "range" }>;
    s = reduce(s, { type: "update_region", id, index: 1, region: { ...range, lo: 0.2 } });
    expect((at()[1] as { lo: number }).lo).toBe(0.2);
    // The hand-drawn shape beside it is untouched.
    expect(at()[0].kind).toBe("path");
  });

  it("acts on the mask the ants are tracing, not a different one", () => {
    // The failure this pins: a develop layer active from earlier, then
    // selecting on a Finish layer. The overlay drew the Finish mask
    // because arming the tool picks it; the menu used to prefer the
    // develop layer's, so Smooth and the range commands quietly worked
    // on a selection that was not on screen and nothing looked wrong.
    let s = reduce(initialState(), { type: "add_layer", maskType: "selection" });
    const developMask = s.nodes.find((n) => n.id === s.activeLayer!.replace("_adj", "_mask"))!.id;
    s = reduce(s, { type: "art_add_layer", kind: "paint" });
    const art = s.artActive!;
    s = reduce(s, { type: "art_add_mask", id: art, kind: "brush" });
    s = reduce(s, { type: "select_nodes", ids: [`art_m_${art}`] });
    // A Finish layer's mask is pixels (2026-09-30), never a selection the
    // Select menu acts on: picked, it does not take the menu over.
    expect(s.activeLayer).toBeTruthy();
    expect(activeSelectionMask(s)!.id).toBe(developMask);
    // A Develop Selection layer, picked, does.
    s = reduce(s, { type: "select_nodes", ids: [developMask] });
    expect(activeSelectionMask(s)!.id).toBe(developMask);

    // And with nothing picked it falls back to the develop layer, which
    // is what the Develop panel is looking at.
    s = reduce(s, { type: "select_nodes", ids: [] });
    expect(activeSelectionMask(s)!.id).toBe(developMask);
  });

  it("a stroke keeps the selection it was painted under", () => {
    // The owner's three rules, as three assertions: paint freely
    // with no selection; painting inside one is restricted to it;
    // deselecting leaves those strokes exactly as they were.
    const dab = { points: [[0.5, 0.5]], radius: 0.05, hardness: 1, flow: 1, color: "#ffffff" };
    const strokesOf = (st: State) => {
      const layer = artLayers(st).find((l) => l.blend.id === st.artActive)!;
      return (layer.content.strokes ?? []) as unknown as { clip?: string }[];
    };

    // 1. No selection: the stroke carries no clip and paints freely.
    let s = reduce(initialState(), { type: "art_add_layer", kind: "paint" });
    const layer = s.artActive!;
    s = reduce(s, { type: "art_add_stroke", id: layer, stroke: dab as never });
    expect(strokesOf(s)[0].clip).toBeUndefined();

    // 2. Under a selection: the stroke carries it.
    s = reduce(s, { type: "arm_document_selection" });
    s = reduce(s, { type: "add_region", id: DOC_SEL_ID, region: square("replace") });
    s = reduce(s, { type: "set_tool", tool: "paint" });
    s = reduce(s, { type: "art_add_stroke", id: layer, stroke: dab as never });
    const carried = strokesOf(s)[1].clip;
    expect(carried).toBeTruthy();
    expect(JSON.parse(carried!)).toHaveLength(1);

    // The layer's own mask slot is untouched: a selection is not a mask.
    expect(artMaskNode(s, `art_m_${layer}`)).toBeUndefined();

    // 3. Deselecting cannot reach back. The clip is on the stroke, so
    // there is no live wire for a cleared selection to empty.
    s = reduce(s, { type: "clear_regions", id: DOC_SEL_ID });
    expect(strokesOf(s)[1].clip).toBe(carried);
    // And the layer is paintable again, freely.
    s = reduce(s, { type: "art_add_stroke", id: layer, stroke: dab as never });
    expect(strokesOf(s)[2].clip).toBeUndefined();
  });

  /** A command whose work lands after the desktop's bake (Fill
   * Selection): every dispatch it makes, now and when the bake answers
   * (the browser bridge answers at once). */
  const fireBaked = async (s: State, id: string, landed: (n: State) => boolean) => {
    let next = s;
    runCommand(id, s, (c) => {
      next = reduce(next, c);
    });
    await vi.waitFor(() => expect(landed(next)).toBe(true));
    return next;
  };

  it("Fill Selection makes a fill layer wearing the selection's coverage as pixels", async () => {
    let { s, id } = withSelectionLayer();
    s = reduce(s, { type: "add_region", id, region: square() });
    s = reduce(s, { type: "art_add_layer", kind: "paint" });
    s = reduce(s, { type: "set_paint_color", color: "#ff3300" });
    // Finish-only now: the menu lives where the layer stack does.
    s = reduce(s, { type: "set_panel_tab", tab: "layers" });
    const before = s.artActive;
    s = await fireBaked(s, "select.fill", (n) => n.artActive !== before);
    const layer = artLayers(s).find((l) => l.blend.id === s.artActive)!;
    expect(layer.content.type).toBe("heeler.fill");
    // The color is the toolbar's, as a parameter: still editable, not
    // burned into pixels.
    expect(layer.content.textParams!.color).toBe("#ff3300");
    // And the selection came along as the layer's own pixel mask (a layer
    // mask is always the paintable kind since 2026-09-30); the
    // document selection is spent on it (a Develop Selection layer, as here,
    // keeps its own); its shape kept beside the pixels for the handles.
    const made = artMaskNode(s, `art_m_${s.artActive}`)!;
    expect(made.type).toBe("heeler.brush_mask");
    expect(made.textParams?.matte_id).toBe("baked:beefbeefbeefbeef");
    expect(made.regions).toHaveLength(1);
    expect(s.nodes.find((n) => n.id === id)!.regions).toHaveLength(1);
  });

  it("the whole fill is one undo", async () => {
    let { s, id } = withSelectionLayer();
    s = reduce(s, { type: "add_region", id, region: square() });
    s = reduce(s, { type: "art_add_layer", kind: "paint" });
    s = reduce(s, { type: "set_panel_tab", tab: "layers" });
    const layers = artLayers(s).length;
    s = await fireBaked(s, "select.fill", (n) => artLayers(n).length === layers + 1);
    s = reduce(s, { type: "undo" });
    expect(artLayers(s).length).toBe(layers);
    expect(s.nodes.find((n) => n.id === id)!.regions).toHaveLength(1);
  });
});

describe("modifiers, center and the clearing click", () => {
  const mount = async (props: Record<string, unknown> = {}) => {
    const { render, screen, fireEvent } = await import("@testing-library/react");
    const { SelectionOverlay } = await import("../ui/selection");
    const sent: Command[] = [];
    const node = { id: "sel", type: "heeler.selection_mask", params: {}, regions: [] } as never;
    const view = render(
      <SelectionOverlay
        node={node}
        dispatch={(c: Command) => sent.push(c)}
        method="rect"
        op="replace"
        tolerance={0.2}
        smooth={0}
        {...props}
      />,
    );
    const overlay = screen.getByTestId("selection-overlay");
    Object.defineProperty(overlay, "clientWidth", { value: 200, configurable: true });
    Object.defineProperty(overlay, "clientHeight", { value: 200, configurable: true });
    overlay.getBoundingClientRect = () =>
      ({ left: 0, top: 0, width: 200, height: 200, right: 200, bottom: 200 }) as DOMRect;
    return { overlay, sent, fireEvent, unmount: view.unmount, screen };
  };

  const drag = (
    fireEvent: { mouseDown: Function; mouseMove: Function; mouseUp: Function },
    overlay: HTMLElement,
    mods: object,
    from: [number, number],
    to: [number, number],
  ) => {
    fireEvent.mouseDown(overlay, { button: 0, clientX: from[0], clientY: from[1], ...mods });
    fireEvent.mouseMove(overlay, { buttons: 1, clientX: to[0], clientY: to[1], ...mods });
    fireEvent.mouseUp(overlay, { clientX: to[0], clientY: to[1], ...mods });
  };

  // 2026-10-08: "When dragging an interactive selection outside of
  // the canvas space ends the selection, this is not how other programs
  // work. They allow you to drag outside the canvas, its good for making
  // sure you're capturing all the extents."
  // And it is drawn where the pointer is, out there too (2026-10-08:
  // "Every other app will draw the marching ants outside the border, the
  // marching ants aren't clipped until the selection is completed"): the
  // region keeps the box as drawn, and the engine fills the picture's
  // part of it, a side past the edge reaching on past it.
  it("a marquee dragged off the canvas carries on, drawn where the pointer is", async () => {
    const { overlay, sent, fireEvent } = await mount();
    fireEvent.mouseDown(overlay, { button: 0, clientX: 40, clientY: 50 });
    fireEvent.mouseMove(overlay, { buttons: 1, clientX: 150, clientY: 160 });
    fireEvent.mouseLeave(overlay, { buttons: 1, clientX: 201, clientY: 170 });
    expect(sent.filter((c) => c.type === "add_region"), "leaving ends nothing").toEqual([]);
    fireEvent.mouseMove(window, { buttons: 1, clientX: 320, clientY: 260 });
    fireEvent.mouseUp(window, { clientX: 320, clientY: 260 });
    const add = sent.find((c) => c.type === "add_region") as Extract<Command, { type: "add_region" }>;
    expect(add.region).toMatchObject({ kind: "marquee", x0: 0.2, y0: 0.25, x1: 1.6, y1: 1.3 });
    // The drag is over: a later move draws nothing more.
    fireEvent.mouseMove(window, { buttons: 0, clientX: 10, clientY: 10 });
    expect(sent.filter((c) => c.type === "add_region")).toHaveLength(1);
  });

  it("a freehand outline keeps drawing outside the canvas, where the pointer is", async () => {
    const { overlay, sent, fireEvent } = await mount({ method: "freehand" });
    fireEvent.mouseDown(overlay, { button: 0, clientX: 100, clientY: 100 });
    fireEvent.mouseMove(overlay, { buttons: 1, clientX: 180, clientY: 100 });
    fireEvent.mouseLeave(overlay, { buttons: 1, clientX: 201, clientY: 100 });
    fireEvent.mouseMove(window, { buttons: 1, clientX: 260, clientY: 150 });
    fireEvent.mouseMove(window, { buttons: 1, clientX: 260, clientY: 240 });
    fireEvent.mouseMove(overlay, { buttons: 1, clientX: 100, clientY: 180 });
    fireEvent.mouseUp(window, { clientX: 100, clientY: 180 });
    const add = sent.find((c) => c.type === "add_region") as Extract<Command, { type: "add_region" }>;
    expect(add, "the lasso landed after its trip outside").toBeDefined();
    const pts = (add.region as { points: [number, number][] }).points;
    expect(Math.max(...pts.map((p) => p[0]))).toBeCloseTo(1.3, 9);
    expect(Math.max(...pts.map((p) => p[1]))).toBeCloseTo(1.2, 9);
  });

  // 2026-10-08: "the selection drag works, but only if I start
  // within the canvas. other apps let you begin a selection outside the
  // border of the image."
  it("a marquee begins on the stage around the picture, drawn from the press at once", async () => {
    const { render, screen, fireEvent } = await import("@testing-library/react");
    const { SelectionOverlay } = await import("../ui/selection");
    const sent: Command[] = [];
    const node = { id: "sel", type: "heeler.selection_mask", params: {}, regions: [] } as never;
    const mountIn = (method: string) =>
      render(
        <div data-testid="viewer-stage">
          <button data-testid="stage-button">Fit</button>
          <SelectionOverlay node={node} dispatch={(c: Command) => sent.push(c)} method={method} op="replace" tolerance={0.2} smooth={0} />
        </div>,
      );
    const view = mountIn("rect");
    const overlay = screen.getByTestId("selection-overlay");
    // The picture sits at 100..300 on the stage.
    Object.defineProperty(overlay, "clientWidth", { value: 200, configurable: true });
    Object.defineProperty(overlay, "clientHeight", { value: 200, configurable: true });
    overlay.getBoundingClientRect = () => ({ left: 100, top: 100, width: 200, height: 200, right: 300, bottom: 300 }) as DOMRect;
    const stage = screen.getByTestId("viewer-stage");
    fireEvent.mouseDown(stage, { button: 0, clientX: 20, clientY: 30 });
    // Still off the picture: the outline shows already, out in the gray.
    fireEvent.mouseMove(window, { buttons: 1, clientX: 60, clientY: 80 });
    const live = screen.getByTestId("selection-live-marquee");
    expect(Number(live.getAttribute("x"))).toBeCloseTo(-40, 6);
    expect(Number(live.getAttribute("width"))).toBeCloseTo(20, 6);
    fireEvent.mouseMove(window, { buttons: 1, clientX: 200, clientY: 250 });
    fireEvent.mouseUp(window, { clientX: 200, clientY: 250 });
    const add = sent.find((c) => c.type === "add_region") as Extract<Command, { type: "add_region" }>;
    expect(add.region).toMatchObject({ kind: "marquee", x0: -0.4, y0: -0.35, x1: 0.5, y1: 0.75 });
    // The stage's own controls keep their presses.
    sent.length = 0;
    fireEvent.mouseDown(screen.getByTestId("stage-button"), { button: 0, clientX: 20, clientY: 30 });
    fireEvent.mouseMove(window, { buttons: 1, clientX: 200, clientY: 250 });
    fireEvent.mouseUp(window, { clientX: 200, clientY: 250 });
    expect(sent.filter((c) => c.type === "add_region")).toEqual([]);
    view.unmount();
    // A click method has nothing to click off the picture.
    mountIn("wand");
    fireEvent.mouseDown(screen.getByTestId("viewer-stage"), { button: 0, clientX: 20, clientY: 30 });
    fireEvent.mouseUp(window, { clientX: 20, clientY: 30 });
    expect(sent.filter((c) => c.type === "add_region")).toEqual([]);
  });

  // The stack's merge card floats over the canvas as role="status",
  // inside the stage. A press on it belongs to the card: it must not
  // begin a selection, and a plain click on it must not clear one.
  it("a press on a merge card over the canvas starts no selection", async () => {
    const { render, screen, fireEvent } = await import("@testing-library/react");
    const { SelectionOverlay } = await import("../ui/selection");
    const sent: Command[] = [];
    const node = { id: "sel", type: "heeler.selection_mask", params: {}, regions: [] } as never;
    render(
      <div data-testid="viewer-stage">
        <div role="status" data-testid="stack-merge">
          <div>Merging 3 frames</div>
        </div>
        <SelectionOverlay node={node} dispatch={(c: Command) => sent.push(c)} method="rect" op="replace" tolerance={0.2} smooth={0} autoClear />
      </div>,
    );
    const overlay = screen.getByTestId("selection-overlay");
    Object.defineProperty(overlay, "clientWidth", { value: 200, configurable: true });
    Object.defineProperty(overlay, "clientHeight", { value: 200, configurable: true });
    overlay.getBoundingClientRect = () => ({ left: 100, top: 100, width: 200, height: 200, right: 300, bottom: 300 }) as DOMRect;
    // A press on the card's body, dragged out, lands no region.
    fireEvent.mouseDown(screen.getByTestId("stack-merge"), { button: 0, clientX: 150, clientY: 150 });
    fireEvent.mouseMove(window, { buttons: 1, clientX: 260, clientY: 260 });
    fireEvent.mouseUp(window, { clientX: 260, clientY: 260 });
    expect(sent.filter((c) => c.type === "add_region"), "the card's press started a drag").toEqual([]);
    // And a plain click on it does not clear the selection.
    fireEvent.mouseDown(screen.getByTestId("stack-merge"), { button: 0, clientX: 150, clientY: 150 });
    fireEvent.mouseUp(window, { clientX: 150, clientY: 150 });
    expect(sent, "the card's click reached the selection").toEqual([]);
  });

  // 2026-10-08: "Every other app will draw the marching ants outside
  // the border, the marching ants aren't clipped until the selection is
  // completed." A box grown from its center near the edge is drawn whole,
  // and kept whole: an ellipse past the edge is cut there by the mask,
  // not shrunk to fit.
  it("a box grown from its center near the edge is drawn and kept whole, past the edge", async () => {
    const { overlay, sent, fireEvent, screen } = await mount({ drawFromCenter: true });
    fireEvent.mouseDown(overlay, { button: 0, clientX: 190, clientY: 100 });
    fireEvent.mouseMove(overlay, { buttons: 1, clientX: 100, clientY: 60 });
    const live = screen.getByTestId("selection-live-marquee");
    const [x, w] = ["x", "width"].map((k) => Number(live.getAttribute(k)));
    expect(x).toBeCloseTo(50, 6);
    expect(x + w, "drawn past the edge").toBeCloseTo(140, 6);
    fireEvent.mouseUp(window, { clientX: 100, clientY: 60 });
    const add = sent.find((c) => c.type === "add_region") as Extract<Command, { type: "add_region" }>;
    // Centered on x 0.95, reaching 0.45 left: the right side sits at 1.4.
    expect(add.region).toMatchObject({ kind: "marquee", x0: expect.closeTo(1.4, 9), x1: 0.5, y0: 0.7, y1: 0.3 });
  });

  it("SHIFT adds, ALT subtracts, both intersect", async () => {
    const { overlay, sent, fireEvent, unmount } = await mount();
    drag(fireEvent, overlay, {}, [20, 20], [80, 80]);
    drag(fireEvent, overlay, { shiftKey: true }, [20, 20], [80, 80]);
    drag(fireEvent, overlay, { altKey: true }, [20, 20], [80, 80]);
    drag(fireEvent, overlay, { shiftKey: true, altKey: true }, [20, 20], [80, 80]);
    expect(
      sent.filter((c) => c.type === "add_region").map((c) => (c as never as { region: { op: string } }).region.op),
    ).toEqual(["replace", "add", "subtract", "intersect"]);
    unmount();
  });

  it("naming the mode you are already in changes nothing", async () => {
    // "If a user is already in Add mode, holding SHIFT
    // essentially would do nothing. It would not invert to something
    // like New or Subtract." The modifiers name a mode; they do not
    // toggle one.
    const { overlay, sent, fireEvent, unmount } = await mount({ op: "add" });
    drag(fireEvent, overlay, { shiftKey: true }, [20, 20], [80, 80]);
    drag(fireEvent, overlay, {}, [20, 20], [80, 80]);
    expect(
      sent.filter((c) => c.type === "add_region").map((c) => (c as never as { region: { op: string } }).region.op),
    ).toEqual(["add", "add"]);
    unmount();
  });

  it("draws from the center when told to, and CTRL flips it either way", async () => {
    const box = (sent: Command[]) => {
      const r = (sent.find((c) => c.type === "add_region") as never as {
        region: { x0: number; x1: number };
      }).region;
      return [Math.min(r.x0, r.x1), Math.max(r.x0, r.x1)];
    };
    // Corner by default: 0.1 to 0.4 of the frame.
    const a = await mount();
    drag(a.fireEvent, a.overlay, {}, [20, 20], [80, 80]);
    expect(box(a.sent)[0]).toBeCloseTo(0.1, 2);
    a.unmount();

    // From the center: the drag reaches back the other way too, held
    // to the picture (the box past the edge is the next test's).
    const b = await mount({ drawFromCenter: true });
    drag(b.fireEvent, b.overlay, {}, [100, 100], [140, 140]);
    expect(box(b.sent)).toEqual([expect.closeTo(0.3, 2), expect.closeTo(0.7, 2)]);
    b.unmount();

    // CTRL flips whichever way the setting is pointing.
    const c = await mount({ drawFromCenter: true });
    drag(c.fireEvent, c.overlay, { ctrlKey: true }, [20, 20], [80, 80]);
    expect(box(c.sent)[0]).toBeCloseTo(0.1, 2);
    c.unmount();
  });

  it("a plain click clears; a modified click does not", async () => {
    const { overlay, sent, fireEvent, unmount } = await mount();
    fireEvent.mouseDown(overlay, { button: 0, clientX: 60, clientY: 60 });
    fireEvent.mouseUp(overlay, { clientX: 60, clientY: 60 });
    expect(sent.some((c) => c.type === "clear_regions")).toBe(true);
    unmount();

    // SHIFT-click means the hand was reaching for Add and missed.
    const b = await mount();
    b.fireEvent.mouseDown(b.overlay, { button: 0, clientX: 60, clientY: 60, shiftKey: true });
    b.fireEvent.mouseUp(b.overlay, { clientX: 60, clientY: 60, shiftKey: true });
    expect(b.sent.some((c) => c.type === "clear_regions")).toBe(false);
    b.unmount();

    // And the switch turns it off entirely.
    const c = await mount({ autoClear: false });
    c.fireEvent.mouseDown(c.overlay, { button: 0, clientX: 60, clientY: 60 });
    c.fireEvent.mouseUp(c.overlay, { clientX: 60, clientY: 60 });
    expect(c.sent.some((x) => x.type === "clear_regions")).toBe(false);
    c.unmount();
  });

  it("the cursor says which tool is in hand and what it will do", async () => {
    const { overlay, unmount } = await mount();
    const cursorFor = (el: HTMLElement) => decodeURIComponent(el.style.cursor);
    // A dashed rectangle for the marquee, and no badge in New mode.
    expect(cursorFor(overlay)).toContain("stroke-dasharray");
    expect(cursorFor(overlay)).toContain("crosshair");
    unmount();

    const b = await mount({ op: "add" });
    // The plus that says this region joins what is already selected.
    expect(decodeURIComponent(b.overlay.style.cursor)).toContain("M19 3.5v5");
    b.unmount();

    const c = await mount({ method: "wand" });
    expect(decodeURIComponent(c.overlay.style.cursor)).not.toContain("stroke-dasharray");
    c.unmount();
  });
});

describe("a Selection layer adopts the document selection", () => {
  // The owner drew a selection, added Adjustment > Selection layer,
  // and the layer's mask was born empty: "Heeler is not recognizing it
  // as a mask. I press the show mask button and everything is black."
  // The document selection exists to "become a layer mask on request"
  // (DOC_SEL_ID's own words), and creating a Selection layer IS that
  // request.
  it("moves the regions, strokes and dials onto the new mask", () => {
    let s = reduce(initialState(), { type: "arm_document_selection" });
    s = reduce(s, { type: "add_region", id: DOC_SEL_ID, region: square("replace") });
    s = reduce(s, { type: "set_param", id: DOC_SEL_ID, param: "feather", value: 0.4 });
    s = reduce(s, {
      type: "add_polish_stroke",
      id: DOC_SEL_ID,
      stroke: { points: [[0.4, 0.4], [0.6, 0.6]], radius: 0.05, mode: "matte" },
    });
    s = reduce(s, { type: "add_layer", maskType: "selection" });
    const mask = s.nodes.find((n) => n.id === s.activeLayer!.replace("_adj", "_mask"))!;
    expect(mask.regions).toHaveLength(1);
    expect(mask.params.feather).toBe(0.4);
    // The strokes follow, so the matte runner re-mattes the new node
    // on its own; matte_id must NOT follow (the raster is keyed by
    // node id and could never match).
    expect(mask.strokes).toHaveLength(1);
    expect(mask.textParams?.matte_id ?? "").toBe("");
    // Moved, not copied: the document selection emptied in the same
    // step, so the two can never drift apart.
    const doc = s.nodes.find((n) => n.id === DOC_SEL_ID)!;
    expect(doc.regions).toHaveLength(0);
    expect(doc.strokes ?? []).toHaveLength(0);
    // One undo puts both back.
    const undone = reduce(s, { type: "undo" });
    expect(undone.nodes.find((n) => n.id === DOC_SEL_ID)!.regions).toHaveLength(1);
    expect(undone.nodes.find((n) => n.id === mask.id)).toBeUndefined();
  });

  it("with no document selection the mask is simply empty, as before", () => {
    const s = reduce(initialState(), { type: "add_layer", maskType: "selection" });
    const mask = s.nodes.find((n) => n.id === s.activeLayer!.replace("_adj", "_mask"))!;
    expect(mask.regions).toHaveLength(0);
  });
});

describe("the tool settings outlive the session", () => {
  it("saves the tool settings and restores them on the next launch, but not the tool in hand", async () => {
    const { saveUiSettings } = await import("../bridge");
    const { render, fireEvent, within } = await import("@testing-library/react");
    const { App } = await import("../app");

    // Something else gets chosen and written down.
    await saveUiSettings(
      JSON.stringify({
        tool: "clone",
        dodgeMode: "burn",
        selectMethod: "ellipse",
        selectFromCenter: true,
        selectAntialias: false,
        selectAutoClear: false,
      }),
    );

    // Next launch reads it back rather than defaulting to Freehand. The
    // report: "It seems to keep defaulting to Freehand when the app
    // relaunches." Scoped to this render: other tests in the file leave
    // an App mounted, and a bare screen query would find theirs as well.
    // Bound queries still search the whole body, so this is scoped to the
    // container: other tests in the file leave an App mounted.
    const rendered = render(<App />);
    const view = within(rendered.container);
    fireEvent.click(await view.findByTestId("panel-tab-layers"));
    fireEvent.click(view.getByTestId("art-add-content"));
    const tool = await view.findByTestId("art-tool-select");
    expect(tool).toHaveAttribute("data-method", "ellipse");
    fireEvent.click(view.getByTestId("menu-select"));
    expect(view.getByTestId("menu-select-from-center")).toHaveAttribute("data-checked");
    expect(view.getByTestId("menu-select-antialias")).not.toHaveAttribute("data-checked");
    expect(view.getByTestId("menu-select-autoclear")).not.toHaveAttribute("data-checked");
    // The dodge/burn button remembers which half it was left on...
    expect(view.getByTestId("art-tool-dodgeburn")).toHaveAttribute("data-mode", "burn");
    // ...but the tool that was in hand does not come back (the app opened
    // with the Magnetic cursor armed and the Selection panel up). The
    // repair button is not lit and shows its own remembered half, the
    // default Heal.
    expect(view.getByTestId("art-tool-repair")).not.toHaveAttribute("data-active", "true");
    expect(view.getByTestId("art-tool-repair")).toHaveAttribute("data-mode", "heal");
    rendered.unmount();
  });
});

describe("the outline is smooth, not a staircase", () => {
  it("traces an ellipse without the grid showing through", async () => {
    const { selectionField, traceContours } = await import("../ui/selectionfield");
    const loops = traceContours(
      selectionField(
        [{ kind: "marquee", op: "replace", x0: 0.2, y0: 0.25, x1: 0.8, y1: 0.75, shape: "ellipse" }],
        null,
      ),
    );
    expect(loops.length).toBe(1);
    const loop = loops[0];
    // Every vertex should sit on the ellipse, within a fraction of a
    // grid cell. Snapping crossings to cell-edge midpoints put them up
    // to half a cell off, which is what read as rough.
    const worst = Math.max(
      ...loop.map(([x, y]) => {
        const dx = (x - 0.5) / 0.3;
        const dy = (y - 0.5) / 0.25;
        return Math.abs(Math.hypot(dx, dy) - 1);
      }),
    );
    // Tight enough to fail on a stepped outline: one grid cell is
    // about 0.02 here, which is what the staircase cost and what the
    // old tolerance quietly allowed.
    expect(worst).toBeLessThan(0.006);
  });

  it("a traced freehand loop is smooth too", async () => {
    const { selectionField, traceContours } = await import("../ui/selectionfield");
    // A circle traced by hand, as points rather than as a shape.
    const pts: [number, number][] = Array.from({ length: 48 }, (_, i) => {
      const a = (i / 48) * Math.PI * 2;
      return [0.5 + Math.cos(a) * 0.3, 0.5 + Math.sin(a) * 0.3] as [number, number];
    });
    const loops = traceContours(
      selectionField([{ kind: "path", op: "replace", points: pts }], null),
    );
    const worst = Math.max(
      ...loops[0].map(([x, y]) => Math.abs(Math.hypot(x - 0.5, y - 0.5) - 0.3)),
    );
    // Paths were binary too, which is the case most selections take.
    expect(worst).toBeLessThan(0.006);
  });

  it("still leaves a rectangle with square corners", async () => {
    const { selectionField, traceContours } = await import("../ui/selectionfield");
    const loops = traceContours(
      selectionField(
        [{ kind: "marquee", op: "replace", x0: 0.25, y0: 0.25, x1: 0.75, y1: 0.75, shape: "rect" }],
        null,
      ),
    );
    const xs = loops[0].map(([x]) => x);
    const ys = loops[0].map(([, y]) => y);
    // Interpolating the crossing must not round the corners off: a
    // rectangle's edges land exactly where they were dragged.
    expect(Math.min(...xs)).toBeCloseTo(0.25, 2);
    expect(Math.max(...xs)).toBeCloseTo(0.75, 2);
    expect(Math.min(...ys)).toBeCloseTo(0.25, 2);
    expect(Math.max(...ys)).toBeCloseTo(0.75, 2);
  });
});

describe("Region Select", () => {
  it("a click becomes a traced path region, geometry like every other", async () => {
    const { render, fireEvent, waitFor } = await import("@testing-library/react");
    const { SelectionOverlay } = await import("../ui/selection");
    const sent: Command[] = [];
    const node = { id: "sel", type: "heeler.selection_mask", params: {}, regions: [] } as never;
    const view = render(
      <SelectionOverlay
        node={node}
        dispatch={(c: Command) => sent.push(c)}
        method="region"
        op="replace"
        tolerance={0.4}
        smooth={0}
        imageId="img1"
      />,
    );
    const overlay = view.getByTestId("selection-overlay");
    Object.defineProperty(overlay, "clientWidth", { value: 200, configurable: true });
    Object.defineProperty(overlay, "clientHeight", { value: 200, configurable: true });
    overlay.getBoundingClientRect = () =>
      ({ left: 0, top: 0, width: 200, height: 200, right: 200, bottom: 200 }) as DOMRect;

    fireEvent.mouseDown(overlay, { button: 0, clientX: 100, clientY: 100 });
    fireEvent.mouseUp(overlay, { clientX: 100, clientY: 100 });

    // The segmentation round trip is async; what lands is an ordinary
    // path region, replayable and editable like any hand-drawn one. The
    // segmenter is only the pencil that drew it.
    await waitFor(() => expect(sent.some((c) => c.type === "add_region")).toBe(true));
    const region = (sent.find((c) => c.type === "add_region") as never as {
      region: { kind: string; via?: string; points: [number, number][] };
    }).region;
    expect(region.kind).toBe("path");
    expect(region.via).toBe("region");
    // The mock returns a block around the click sized by tolerance, so
    // the traced loop surrounds the click point.
    const xs = region.points.map(([x]) => x);
    const ys = region.points.map(([, y]) => y);
    expect(Math.min(...xs)).toBeLessThan(0.5);
    expect(Math.max(...xs)).toBeGreaterThan(0.5);
    expect(Math.min(...ys)).toBeLessThan(0.5);
    expect(Math.max(...ys)).toBeGreaterThan(0.5);
    view.unmount();
  });

  it("SHIFT-click adds a region instead of replacing", async () => {
    const { render, fireEvent, waitFor } = await import("@testing-library/react");
    const { SelectionOverlay } = await import("../ui/selection");
    const sent: Command[] = [];
    const node = { id: "sel", type: "heeler.selection_mask", params: {}, regions: [] } as never;
    const view = render(
      <SelectionOverlay
        node={node}
        dispatch={(c: Command) => sent.push(c)}
        method="region"
        op="replace"
        tolerance={0.4}
        smooth={0}
        imageId="img1"
      />,
    );
    const overlay = view.getByTestId("selection-overlay");
    Object.defineProperty(overlay, "clientWidth", { value: 200, configurable: true });
    Object.defineProperty(overlay, "clientHeight", { value: 200, configurable: true });
    overlay.getBoundingClientRect = () =>
      ({ left: 0, top: 0, width: 200, height: 200, right: 200, bottom: 200 }) as DOMRect;

    fireEvent.mouseDown(overlay, { button: 0, clientX: 60, clientY: 60, shiftKey: true });
    fireEvent.mouseUp(overlay, { clientX: 60, clientY: 60, shiftKey: true });
    await waitFor(() => expect(sent.some((c) => c.type === "add_region")).toBe(true));
    const region = (sent.find((c) => c.type === "add_region") as never as {
      region: { op: string };
    }).region;
    expect(region.op).toBe("add");
    view.unmount();
  });
});
