// A Finish warp, compact (2026-09-30: "Warp layer is too big, too much
// stack and redundant controls. This layer should by default look like
// a pixel layer (in size), with an additional button to go into edit
// mode which then expands to show the controls. The first control is
// type: Either GRID or SHAPES.").
//
// Then (2026-09-30): "I think we can remove the EDIT WARP button, when
// the layer is expanded it should just turn on warp editing. Turn warp
// editing off when collapsed".
//
// What is held here: a collapsed Warp layer's row is a Pixel layer's
// row; opening its settings opens edit mode by arming the warp's tool on
// it and closing them closes it, as do Enter, another layer and another
// tool, one warp at a time (layerexpand.test.tsx holds the rest of the
// open-is-edit rules); the
// Type comes first and only the chosen type's controls show, each once;
// switching the type is one undo step, keeps the other type's data and
// changes what the serialized graph asks the engine to apply; an image
// layer's own warp follows the same pattern with its Room; a warp saved
// before the Type existed loads with its shapes chosen. The pixels of
// the chosen type are the desktop's (src-tauri/src/finish_warps.rs,
// over the fixture finishwarps.test.tsx writes).
import { fireEvent, render, screen, within } from "@testing-library/react";
import { useCallback, useState } from "react";
import { describe, expect, it } from "vitest";
import { initialState, NEUTRAL_NODES, NEUTRAL_WIRES } from "../data";
import {
  artLayers,
  artWarpNode,
  imageLayerWarp,
  reduce,
  warpKindOf,
  type Command,
  type NodeCard,
  type State
} from "../state";
import { loadGraph, saveGraph, serializeGraph } from "../bridge";
import { runCommand } from "../commands";
import { noteFrameAspect } from "../imagelayers";
import { shapesFromNode } from "../shapewarp";
import { ArtLayersTab } from "../ui/artlayers";
import { FinishWarpControls } from "../ui/finishwarp";
import { NodeParams } from "../ui/graph";


const run = (s: State, ...cmds: Command[]): State => cmds.reduce(reduce, s);

function fresh(id = "finish_warp_compact"): State {
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

const MESH = { cols: 1, rows: 1, us: [0, 1], vs: [0, 1], d: [[0.02, 0], [0.02, 0], [0.02, 0.01], [0.02, 0.01]] as [number, number][] };

/** A Pixel layer under a Warp layer, the Warp layer active, collapsed. */
function stack(): { s: State; pixel: string; blend: string; warp: string } {
  const s = run(fresh(), { type: "art_add_layer", kind: "paint" }, { type: "art_add_layer", kind: "warp" });
  const [pixel, blend] = artLayers(s).map((l) => l.blend.id);
  const warp = artLayers(s)[1].content.id;
  return { s: run(s, { type: "set_tool", tool: "none" }), pixel, blend, warp };
}

/** The same with a grid pulled and a shape placed on the warp: a warp
 * with both, the way one made before the Type existed could be. */
function both(): { s: State; blend: string; warp: string } {
  const { s, blend, warp } = stack();
  const out = run(
    s,
    { type: "grid_warp_mesh", mesh: MESH, target: warp },
    { type: "shape_warp_add", target: warp },
    { type: "shape_warp_set", id: "shape_1", patch: { cx: 0.5, cy: 0.5, radius: 0.2, dx: 0.05 }, target: warp },
  );
  // Written as one saved before the Type: no choice on the node (the
  // first edit pinned the grid's).
  return { s: withoutKind(out, warp), blend, warp };
}

/** The state with a Finish warp's Type taken off its node. */
function withoutKind(s: State, warp: string): State {
  const strip = (list: NodeCard[]): NodeCard[] =>
    list.map((n) => {
      if (n.id === warp) {
        const rest = { ...(n.textParams ?? {}) };
        delete rest.kind;
        return { ...n, textParams: rest };
      }
      return n.isGroup && n.groupNodes ? { ...n, groupNodes: strip(n.groupNodes) } : n;
    });
  return { ...s, nodes: strip(s.nodes) };
}

/** The Finish tab over a live reducer; `latest()` is its state. */
function mount(initial: State) {
  let current = initial;
  function Host() {
    const [s, setS] = useState(initial);
    const dispatch = useCallback((c: Command) => {
      setS((prev) => {
        const next = reduce(prev, c);
        current = next;
        return next;
      });
    }, []);
    return <ArtLayersTab state={s} dispatch={dispatch} />;
  }
  const view = render(<Host />);
  return { view, latest: () => current };
}

/** An element's shape as a tree of tags and child counts, the thing its
 * height is made of; the buttons' own contents aside. */
function shapeOf(el: Element, skip: (e: Element) => boolean): string {
  if (el.tagName === "BUTTON" || el.tagName === "svg" || el.tagName === "SELECT") return el.tagName;
  const kids = Array.from(el.children).filter((k) => !skip(k));
  return `${el.tagName}(${kids.map((k) => shapeOf(k, skip)).join(",")})`;
}

describe("a Warp layer collapsed", () => {
  it("is a Pixel layer's row, with no Edit Warp button", () => {
    const { s, pixel, blend } = stack();
    // The two rows side by side, each the layer being worked in turn, so
    // the comparison is of like with like.
    for (const activeId of [pixel, blend]) {
      const view = render(<ArtLayersTab state={run(s, { type: "select_art_layer", id: activeId })} dispatch={() => {}} />);
      const pixelRow = screen.getByTestId(`art-layer-${pixel}`);
      const warpRow = screen.getByTestId(`art-layer-${blend}`);
      // Opening the settings is edit mode now: no button of its own.
      expect(within(warpRow).queryByTestId(`art-warp-edit-${blend}`)).toBeNull();
      expect(within(warpRow).queryByLabelText("Edit warp")).toBeNull();
      // The Warp row is the Pixel row, element for element: the same
      // rows, so the same height. The export tick is the one seat that
      // differs in kind, not in size: a warp has no picture of its own
      // to export, so it wears the adjustment layers' 9px mark where a
      // pixel layer has its tick, inside the name row.
      const tick = (e: Element) => (e.getAttribute("data-testid") ?? "").startsWith("art-export-");
      // The settings chevron's seat likewise: the Warp row's chevron
      // and the Pixel row's blank of the same width, beside the dot.
      const seat = (e: Element) => (e.getAttribute("data-testid") ?? "").startsWith("art-settings-");
      const chevron = within(warpRow).getByTestId(`art-settings-${blend}`);
      expect(chevron).toHaveAttribute("aria-expanded", "false");
      expect(chevron.getAttribute("data-hint")).toMatch(/^Show settings: edit the warp on the canvas/);
      expect(within(pixelRow).getByTestId(`art-settings-none-${pixel}`)).toBeTruthy();
      expect(shapeOf(warpRow, (e) => tick(e) || seat(e))).toBe(shapeOf(pixelRow, (e) => tick(e) || seat(e)));
      // Nothing of the warp itself.
      expect(within(warpRow).queryByTestId(/^finish-warp-/)).toBeNull();
      expect(within(warpRow).queryByTestId("gridwarp-controls")).toBeNull();
      expect(within(warpRow).queryByTestId("shapewarp-controls")).toBeNull();
      view.unmount();
    }
  });
});

describe("edit mode", () => {
  it("opening the settings arms the warp's tool and shows its controls, closing them puts it down", () => {
    const { s, blend, warp } = stack();
    const { latest } = mount(s);
    fireEvent.click(screen.getByTestId(`art-settings-${blend}`));
    expect(latest().tool).toBe("gridwarp");
    expect(latest().warpTarget).toBe(warp);
    const panel = screen.getByTestId(`finish-warp-${warp}`);
    expect(panel).toHaveAttribute("data-kind", "grid");
    expect(screen.getByTestId(`art-settings-${blend}`)).toHaveAttribute("aria-expanded", "true");
    // Closing is a commit: no undo step of its own.
    const before = latest().undoStack.length;
    fireEvent.click(screen.getByTestId(`art-settings-${blend}`));
    expect(latest().tool).toBe("none");
    expect(latest().warpTarget).toBeNull();
    expect(latest().undoStack.length).toBe(before);
    expect(screen.queryByTestId(`finish-warp-${warp}`)).toBeNull();
  });

  it("the chevron selects its layer first when another is the one being worked", () => {
    const { s, pixel, blend, warp } = stack();
    const { latest } = mount(run(s, { type: "select_art_layer", id: pixel }));
    fireEvent.click(screen.getByTestId(`art-settings-${blend}`));
    expect(latest().artActive).toBe(blend);
    expect(latest().warpTarget).toBe(warp);
    expect(screen.getByTestId(`finish-warp-${warp}`)).toBeTruthy();
  });

  it("Enter, another layer and another tool each close it", () => {
    const { s, pixel, warp } = stack();
    const open = run(s, { type: "art_warp_edit", id: warp, on: true });
    expect(open.tool).toBe("gridwarp");
    // Enter: the tool's Apply, put down on this warp, never moved to the
    // photograph's own.
    let after = open;
    runCommand("tool.apply", open, (c) => (after = reduce(after, c)));
    expect(after.tool).toBe("none");
    expect(after.warpTarget).toBeNull();
    expect(run(open, { type: "select_art_layer", id: pixel }).tool).toBe("none");
    const brush = run(open, { type: "set_tool", tool: "paint" });
    expect(brush.tool).toBe("paint");
    expect(brush.warpTarget).toBeNull();
  });

  it("art_warp_edit is idempotent: on twice stays on, off on a warp put down arms nothing", () => {
    const { s, warp } = stack();
    const on = run(s, { type: "art_warp_edit", id: warp, on: true });
    expect(run(on, { type: "art_warp_edit", id: warp, on: true })).toBe(on);
    const off = run(on, { type: "art_warp_edit", id: warp, on: false });
    expect(off.tool).toBe("none");
    expect(run(off, { type: "art_warp_edit", id: warp, on: false })).toBe(off);
    expect(run(s, { type: "art_warp_edit", id: "nothing", on: true })).toBe(s);
  });

  it("Escape puts the warp back as it was when edit mode opened", () => {
    const { s, warp } = both();
    const open = run(s, { type: "set_tool", tool: "shapewarp", target: warp });
    const moved = run(open, { type: "shape_warp_set", id: "shape_1", patch: { dx: 0.3 }, target: warp });
    const escaped = run(moved, { type: "cancel_tool" });
    expect(escaped.tool).toBe("none");
    expect(artWarpNode(escaped, warp)!.textParams).toEqual(artWarpNode(s, warp)!.textParams);
  });

  it("only one warp is in edit mode at a time", () => {
    const { s, blend, warp } = stack();
    const two = run(s, { type: "art_add_layer", kind: "warp" });
    const other = artLayers(two)[2];
    const { latest } = mount(run(two, { type: "select_art_layer", id: blend }));
    fireEvent.click(screen.getByTestId(`art-settings-${blend}`));
    expect(latest().warpTarget).toBe(warp);
    fireEvent.click(screen.getByTestId(`art-settings-${other.blend.id}`));
    expect(latest().warpTarget).toBe(other.content.id);
    expect(latest().artActive).toBe(other.blend.id);
    // The first stays open (its chevron opened it), its handles gone.
    expect(screen.getByTestId(`art-settings-${blend}`)).toHaveAttribute("aria-expanded", "true");
    expect(screen.getAllByTestId(/^finish-warp-kind-/)).toHaveLength(2);
  });
});

describe("the Type", () => {
  it("comes first, and only the chosen type's controls show, each once", () => {
    const { s, warp } = both();
    for (const [tool, kind] of [["gridwarp", "grid"], ["shapewarp", "shapes"]] as const) {
      const armed = run(s, { type: "art_warp_kind", id: warp, kind }, { type: "set_tool", tool, target: warp });
      const view = render(<FinishWarpControls state={armed} dispatch={() => {}} target={warp} />);
      const panel = screen.getByTestId(`finish-warp-${warp}`);
      // Type is the first control in the panel.
      const first = panel.querySelector("[data-testid]");
      expect(first).toHaveAttribute("data-testid", `finish-warp-kind-${warp}`);
      expect(screen.getByTestId(`finish-warp-kind-${warp}`).textContent).toContain(kind === "grid" ? "Grid" : "Shapes");
      expect(!!screen.queryByTestId("gridwarp-controls")).toBe(kind === "grid");
      expect(!!screen.queryByTestId("shapewarp-controls")).toBe(kind === "shapes");
      // Dropped: the arm chips (the Edit Warp button is edit mode), the
      // lines' color (the Develop warp sections) and thickness
      // (Preferences), the paragraph the Edit Warp hint now says, and a
      // Warp layer's Room (image layers only).
      for (const gone of ["gridwarp-tool", "shapewarp-tool", "gridwarp-lines", "shapewarp-lines", "gridwarp-line-width-row", "shapewarp-line-width-row", `finish-warp-what-${warp}`, `finish-warp-room-${warp}`]) {
        expect(screen.queryByTestId(gone)).toBeNull();
      }
      // No control twice: every testid in the panel is there once.
      const ids = Array.from(panel.querySelectorAll("[data-testid]"))
        .map((e) => e.getAttribute("data-testid")!)
        // A shape's own row repeats per shape, by design.
        .filter((id) => !id.startsWith("shapewarp-row") && !["shapewarp-on", "shapewarp-name", "shapewarp-rename-open", "shapewarp-shape", "shapewarp-remove"].includes(id));
      expect(ids.length).toBe(new Set(ids).size);
      // One Edges choice, whichever type shows it.
      expect(panel.querySelectorAll('[data-testid$="-edges-clamp"]')).toHaveLength(1);
      view.unmount();
    }
  });

  it("switching is one undo step, keeps the other type's data, and changes what the graph applies", () => {
    const { s, warp } = both();
    const node = () => (st: State) => artWarpNode(st, warp)!;
    const mesh = artWarpNode(s, warp)!.textParams!.mesh;
    const shapes = artWarpNode(s, warp)!.textParams!.shapes;
    // Before a choice: the shapes, since the warp has some.
    expect(warpKindOf(artWarpNode(s, warp))).toBe("shapes");
    const before = s.undoStack.length;
    const grid = run(s, { type: "art_warp_kind", id: warp, kind: "grid" });
    expect(grid.undoStack.length).toBe(before + 1);
    expect(node()(grid).textParams!.kind).toBe("grid");
    // The shapes stay on the node, not applied.
    expect(node()(grid).textParams!.shapes).toBe(shapes);
    expect(node()(grid).textParams!.mesh).toBe(mesh);
    const g = serializeGraph(grid) as unknown as { nodes: { id: string; params: Record<string, unknown> }[] };
    expect(g.nodes.find((n) => n.id === warp)!.params.kind).toBe("grid");
    // And back: the shapes are there as they were.
    const back = run(grid, { type: "art_warp_kind", id: warp, kind: "shapes" });
    expect(back.undoStack.length).toBe(before + 2);
    expect(shapesFromNode(node()(back))).toEqual(shapesFromNode(node()(s)));
    expect(node()(back).textParams!.mesh).toBe(mesh);
    // Undo walks it back one step at a time.
    expect(run(back, { type: "undo" }).nodes).toEqual(grid.nodes);
  });

  it("in edit mode the Type menu swaps the tool on the canvas to the chosen type's", () => {
    const { s, blend, warp } = both();
    const { latest } = mount(s);
    fireEvent.click(screen.getByTestId(`art-settings-${blend}`));
    expect(latest().tool).toBe("shapewarp");
    fireEvent.click(screen.getByTestId(`finish-warp-kind-${warp}`));
    fireEvent.click(screen.getByTestId(`finish-warp-kind-${warp}-option-grid`));
    expect(latest().tool).toBe("gridwarp");
    expect(latest().warpTarget).toBe(warp);
    expect(screen.getByTestId(`finish-warp-${warp}`)).toHaveAttribute("data-kind", "grid");
    expect(screen.getByTestId("gridwarp-controls")).toBeTruthy();
    expect(screen.queryByTestId("shapewarp-controls")).toBeNull();
    // An undo of the type under the tool puts the tool down rather than
    // leave it editing the type the render no longer applies.
    const undone = reduce(latest(), { type: "undo" });
    expect(warpKindOf(artWarpNode(undone, warp))).toBe("shapes");
    expect(undone.tool).toBe("none");
  });

  it("a tool for the type not chosen does not arm on the warp", () => {
    const { s, warp } = both();
    const grid = run(s, { type: "art_warp_kind", id: warp, kind: "grid" });
    expect(run(grid, { type: "set_tool", tool: "shapewarp", target: warp }).tool).toBe("none");
    expect(run(grid, { type: "set_tool", tool: "gridwarp", target: warp }).tool).toBe("gridwarp");
  });
});

describe("a warp saved before the Type", () => {
  it("loads with its shapes chosen and its grid kept", async () => {
    const { s, warp } = both();
    // As saved then: no kind on the node.
    expect(artWarpNode(s, warp)!.textParams!.kind).toBeUndefined();
    await saveGraph("finishwarp-compact-old", { nodes: s.nodes, wires: s.wires });
    const saved = await loadGraph("finishwarp-compact-old");
    const loaded = run(fresh(), { type: "replace_graph", nodes: saved!.nodes as NodeCard[], wires: saved!.wires });
    const node = artWarpNode(loaded, warp)!;
    expect(warpKindOf(node)).toBe("shapes");
    expect(node.textParams!.mesh).toBe(artWarpNode(s, warp)!.textParams!.mesh);
    const armed = run(loaded, { type: "set_tool", tool: "shapewarp", target: warp });
    render(<FinishWarpControls state={armed} dispatch={() => {}} target={warp} />);
    expect(screen.getByTestId(`finish-warp-kind-${warp}`).textContent).toContain("Shapes");
    expect(screen.getByTestId("shapewarp-controls")).toBeTruthy();
  });
});

describe("an image layer's own warp", () => {
  const BOX = { x: 0.3, y: 0.35, w: 0.4, h: 0.3 };
  function image(): { s: State; blend: string } {
    const s = run(fresh(), { type: "art_add_image_layer", source: { kind: "file", path: "__IMAGE__" }, name: "logo", box: BOX });
    return { s, blend: s.artActive! };
  }

  it("the Warp button adds it straight into edit mode, Type first, Room kept", () => {
    const { s, blend } = image();
    const { latest } = mount(s);
    // The transform row is in the image layer's settings.
    fireEvent.click(screen.getByTestId(`art-settings-${blend}`));
    fireEvent.click(screen.getByTestId(`art-xform-warp-${blend}`));
    const warp = imageLayerWarp(latest(), blend)!.id;
    expect(latest().tool).toBe("gridwarp");
    expect(latest().warpTarget).toBe(warp);
    const panel = screen.getByTestId(`finish-warp-${warp}`);
    expect(panel).toHaveAttribute("data-space", "picture");
    expect(panel.querySelector("[data-testid]")).toHaveAttribute("data-testid", `finish-warp-kind-${warp}`);
    expect(screen.getByTestId(`finish-warp-room-${warp}`)).toBeTruthy();
    expect(screen.getByTestId("gridwarp-controls")).toBeTruthy();
    expect(screen.queryByTestId("shapewarp-controls")).toBeNull();
    // Adding it was one undo step; arming is not a step.
    expect(latest().undoStack.length).toBe(s.undoStack.length + 1);
  });

  it("shows with the layer's settings, arms only on its button, Remove Warp takes it away", () => {
    const { s: added, blend } = image();
    const s = run(added, { type: "art_layer_warp", id: blend, on: true });
    const warp = imageLayerWarp(s, blend)!.id;
    const { latest } = mount(s);
    // The layer's settings closed: nothing of the transform or the warp.
    expect(screen.queryByTestId(`finish-warp-${warp}`)).toBeNull();
    expect(screen.queryByTestId(`art-xform-warp-${blend}`)).toBeNull();
    // Open (2026-09-30, the Warp layer's rule): the warp's Type and
    // controls with the transform, and no tool armed by the opening.
    fireEvent.click(screen.getByTestId(`art-settings-${blend}`));
    expect(screen.getByTestId(`finish-warp-${warp}`)).toBeTruthy();
    expect(latest().warpTarget).toBeNull();
    expect(latest().tool).toBe(s.tool);
    const edit = screen.getByTestId(`art-xform-warp-${blend}`);
    expect(edit).toHaveAttribute("aria-label", "Edit warp");
    expect(edit.getAttribute("data-hint")).toMatch(/^Bend the picture itself/);
    expect(screen.getByTestId(`art-xform-unwarp-${blend}`)).toBeTruthy();
    // Arming is the button's.
    fireEvent.click(edit);
    expect(latest().warpTarget).toBe(warp);
    expect(screen.getByTestId(`finish-warp-${warp}`)).toBeTruthy();
    // Shapes: the type menu swaps the controls.
    fireEvent.click(screen.getByTestId(`finish-warp-kind-${warp}`));
    fireEvent.click(screen.getByTestId(`finish-warp-kind-${warp}-option-shapes`));
    expect(latest().tool).toBe("shapewarp");
    expect(screen.getByTestId("shapewarp-controls")).toBeTruthy();
    expect(screen.queryByTestId("gridwarp-controls")).toBeNull();
    expect(screen.getByTestId(`finish-warp-room-${warp}`)).toBeTruthy();
    fireEvent.click(screen.getByTestId(`art-xform-warp-${blend}`));
    expect(latest().tool).toBe("none");
    // Put down, its settings stay with the open layer's.
    expect(screen.getByTestId(`finish-warp-${warp}`)).toBeTruthy();
    fireEvent.click(screen.getByTestId(`art-xform-unwarp-${blend}`));
    expect(imageLayerWarp(latest(), blend)).toBeUndefined();
  });
});

describe("in the graph inspector", () => {
  it("wears the same compact controls: the Edit Warp button, then in edit mode the Type", () => {
    const { s, warp } = both();
    const node = artWarpNode(s, warp)!;
    const closed = render(<NodeParams node={node} dispatch={() => {}} appState={s} allNodes={s.nodes} wires={s.wires} />);
    expect(screen.getByTestId(`finish-warp-edit-${warp}`)).toHaveAttribute("aria-label", "Edit warp");
    expect(screen.queryByTestId(`finish-warp-kind-${warp}`)).toBeNull();
    closed.unmount();
    const armed = run(s, { type: "set_tool", tool: "shapewarp", target: warp });
    render(<NodeParams node={artWarpNode(armed, warp)!} dispatch={() => {}} appState={armed} allNodes={armed.nodes} wires={armed.wires} />);
    expect(screen.getByTestId(`finish-warp-kind-${warp}`)).toBeTruthy();
    expect(screen.getByTestId("shapewarp-controls")).toBeTruthy();
    expect(screen.queryByTestId("gridwarp-controls")).toBeNull();
  });
});
