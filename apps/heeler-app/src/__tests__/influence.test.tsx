// Influence Mapping on the app side: the Inspect picker and point, the
// influence views as frame view state, and the panel's trace.
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, render, screen, fireEvent, waitFor } from "@testing-library/react";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("../bridge", async (orig) => {
  const real = await orig<typeof import("../bridge")>();
  return { ...real, tracePixel: vi.fn() };
});

import { invoke } from "@tauri-apps/api/core";
import { initialState } from "../data";
import { anyPickerArmed, inspectDocked, layoutSnapshot, previewTarget, reduce, toolNode, type Command, type State } from "../state";
import { tracePixel, type TraceStep } from "../bridge";
import { InspectColumn, InspectPanel } from "../ui/inspect";
import { sectionOfNode } from "../ui/simpledata";

const run = (s: State, ...cmds: Command[]) => cmds.reduce(reduce, s);
const invokeMock = invoke as unknown as ReturnType<typeof vi.fn>;
const traceMock = tracePixel as unknown as ReturnType<typeof vi.fn>;

afterEach(() => {
  invokeMock.mockReset();
  traceMock.mockReset();
  delete (window as any).__TAURI_INTERNALS__;
});

const sample = (v: number) => ({ r: v, g: v, b: v, luma: v });

describe("Influence Mapping", () => {
  it("the Inspect picker is one picker among the rest, and its point stays until closed", () => {
    let s = run(initialState(), { type: "arm_wb_pick", id: "stdcolor" }, { type: "toggle_inspect_pick" });
    expect(s.inspectPick).toBe(true);
    expect(s.wbPick).toBeNull();
    s = run(s, { type: "inspect_at", x: 0.25, y: 1.4 });
    expect(s.inspectPoint).toEqual({ x: 0.25, y: 1 });
    // Escape puts the picker away and leaves the panel up.
    s = run(s, { type: "disarm_pickers" });
    expect(anyPickerArmed(s)).toBe(false);
    expect(s.inspectPoint).not.toBeNull();
    s = run(s, { type: "toggle_influence_view", id: "exposure", mode: "luma" }, { type: "close_inspect" });
    expect(s.inspectPoint).toBeNull();
    expect(s.influenceView).toBeNull();
  });

  it("an influence view is view state, one node and mode, exclusive with the other frame views", () => {
    let s = run(initialState(), { type: "toggle_influence_view", id: "exposure", mode: "isolate" });
    expect(previewTarget(s)).toBe("__influence__@isolate@exposure");
    expect(run(s, { type: "undo" }).influenceView).toEqual({ id: "exposure", mode: "isolate" });
    s = run(s, { type: "toggle_halation_view" });
    expect(s.influenceView).toBeNull();
    s = run(s, { type: "toggle_influence_view", id: "exposure", mode: "color" });
    expect(s.halationView).toBe(false);
    expect(previewTarget(s)).toBe("__influence__@color@exposure");
    s = run(s, { type: "toggle_influence_view", id: "exposure", mode: "color" });
    expect(s.influenceView).toBeNull();
    // A node switched off shows the plain frame.
    s = run(s, { type: "toggle_influence_view", id: "exposure", mode: "both" }, { type: "set_enabled", id: "exposure", enabled: false });
    expect(previewTarget(s) ?? "").not.toMatch(/__influence__/);
  });

  it("the 1:1 patch renders the influence view too", async () => {
    (window as any).__TAURI_INTERNALS__ = {};
    invokeMock.mockRejectedValue(new Error("no envelope in a test"));
    const { renderRoi } = await import("../bridge");
    const s = run(initialState(), { type: "toggle_influence_view", id: "exposure", mode: "both" });
    await renderRoi(s, [0.1, 0.1, 0.2, 0.2]);
    expect(invokeMock).toHaveBeenCalledWith("render_preview", expect.objectContaining({ maskNode: "__influence__@both@exposure" }));
  });

  it("the panel lists the path by name, skips hidden nodes, and opens each node's views", async () => {
    const steps: TraceStep[] = [
      { id: "src", node_type: "heeler.image_source", enabled: true, input: null, output: sample(0.2), coverage: null, moves: false },
      { id: "exposure", node_type: "heeler.exposure", enabled: true, input: sample(0.2), output: sample(0.4), coverage: null, moves: false },
      { id: "__finish_scene_0", node_type: "heeler.exposure", enabled: true, input: sample(0.4), output: sample(0.4), coverage: null, moves: false },
      { id: "layer_1_adj", node_type: "heeler.exposure", enabled: true, input: sample(0.4), output: sample(0.4), coverage: 0, moves: false },
      { id: "crop", node_type: "heeler.crop_rotate", enabled: true, input: sample(0.4), output: sample(0.3), coverage: null, moves: true },
      { id: "output", node_type: "heeler.output", enabled: true, input: sample(0.3), output: sample(0.3), coverage: null, moves: false },
    ];
    traceMock.mockResolvedValue(steps);
    const state = run(initialState(), { type: "inspect_at", x: 0.5, y: 0.5 });
    const dispatch = vi.fn();
    render(<InspectPanel state={state} dispatch={dispatch} />);
    await waitFor(() => expect(screen.getByTestId("inspect-row-exposure")).toBeTruthy());
    expect(screen.queryByTestId("inspect-row-__finish_scene_0")).toBeNull();
    expect(screen.queryByTestId("inspect-row-output")).toBeNull();
    expect(screen.getByTestId("inspect-row-src").textContent).toMatch(/Photograph/);
    expect(screen.getByTestId("inspect-value-exposure").textContent).toBe("40");
    expect(screen.getByTestId("inspect-change-exposure").textContent).toBe("+20");
    expect(screen.getByTestId("inspect-row-exposure").getAttribute("data-changed")).toBe("true");
    expect(screen.getByTestId("inspect-row-layer_1_adj").getAttribute("data-changed")).toBe("false");
    expect(screen.getByTestId("inspect-mask-layer_1_adj").textContent).toBe("0%");
    // Every row, and the header, on one grid of the same columns, so the
    // columns line up whatever a node's name (2026-10-18: "Everything is a
    // visual mess").
    const grid = screen.getByTestId("inspect-head").style.gridTemplateColumns;
    expect(grid).not.toBe("");
    for (const id of ["exposure", "layer_1_adj", "crop", "src"]) {
      expect(screen.getByTestId(`inspect-row-${id}`).style.gridTemplateColumns).toBe(grid);
      expect(screen.getByTestId(`inspect-row-${id}`).children).toHaveLength(screen.getByTestId("inspect-head").children.length - (id === "crop" ? 2 : 0));
    }
    expect(screen.getByTestId("inspect-value-crop").textContent).toBe("moves pixels");
    expect(screen.queryByTestId("inspect-isolate-crop")).toBeNull();
    expect(screen.getByTestId("inspect-final").textContent).toMatch(/30/);
    // Map and Isolate are pictures with their names on hover, so the
    // node's name and numbers keep the row's room.
    for (const id of ["inspect-heatmap-exposure", "inspect-isolate-exposure"]) {
      const b = screen.getByTestId(id);
      expect(b.textContent).toBe("");
      expect(b.querySelector("svg")).not.toBeNull();
      expect(b.getAttribute("aria-label")).toBe(id.includes("heatmap") ? "Map" : "Isolate");
    }
    fireEvent.click(screen.getByTestId("inspect-heat-luma"));
    fireEvent.click(screen.getByTestId("inspect-heatmap-exposure"));
    expect(dispatch).toHaveBeenLastCalledWith({ type: "toggle_influence_view", id: "exposure", mode: "luma" });
    fireEvent.click(screen.getByTestId("inspect-isolate-exposure"));
    expect(dispatch).toHaveBeenLastCalledWith({ type: "toggle_influence_view", id: "exposure", mode: "isolate" });
    fireEvent.click(screen.getByTestId("inspect-select-exposure"));
    expect(dispatch).toHaveBeenCalledWith({ type: "select_nodes", ids: ["exposure"] });
    fireEvent.click(screen.getByTestId("inspect-close"));
    expect(dispatch).toHaveBeenLastCalledWith({ type: "close_inspect" });
  });
});

describe("the Inspect rows in a narrow panel", () => {
  it("leaves out the MASK column when nothing on the path has a mask, and splits one swatch in and out", async () => {
    traceMock.mockResolvedValue([
      { id: "src", node_type: "heeler.image_source", enabled: true, input: null, output: sample(0.2), coverage: null, moves: false },
      { id: "exposure", node_type: "heeler.exposure", enabled: true, input: sample(0.2), output: sample(0.4), coverage: null, moves: false },
    ] satisfies TraceStep[]);
    const s = run(initialState(), { type: "toggle_inspect_pick" }, { type: "inspect_at", x: 0.5, y: 0.5 });
    render(<InspectPanel state={s} dispatch={() => {}} />);
    await waitFor(() => expect(screen.getByTestId("inspect-row-exposure")).toBeInTheDocument());
    const head = screen.getByTestId("inspect-head");
    expect(head.textContent).not.toMatch(/MASK/);
    expect(head.style.gridTemplateColumns.split(" ").filter(Boolean)).toHaveLength(6);
    expect(screen.getByTestId("inspect-row-exposure").style.gridTemplateColumns).toBe(head.style.gridTemplateColumns);
    // One swatch, the color in on its left half and out on its right.
    expect(screen.getByTestId("inspect-swatch-exposure").style.background).toMatch(/linear-gradient/);
  });
});

// 2026-10-18: "Lets make inspector its own panel. Add a button to
// position it either on the right or left side of the canvas ... and
// remember the last preferred location. When its enabled, check the
// status of the Library and Thumbnail strip. Collapse either if open.
// When the inspector closes, restore those views".
describe("the Inspect panel's own column", () => {
  const inspecting = (s = initialState()) => run(s, { type: "toggle_inspect_pick" }, { type: "inspect_at", x: 0.5, y: 0.5 });

  it("takes a column in Develop and Graph, and floats in Finish or over an expanded Library", () => {
    const s = initialState();
    expect(inspectDocked({ ...s, mode: "simple" })).toBe(true);
    expect(inspectDocked({ ...s, mode: "simple", polishOpen: true })).toBe(true);
    expect(inspectDocked({ ...s, mode: "advanced", inspectorHome: "graph" })).toBe(true);
    expect(inspectDocked({ ...s, mode: "canvas" })).toBe(false);
    expect(inspectDocked({ ...s, mode: "simple", ribbonExpanded: true })).toBe(false);
  });

  it("folds the Library and the strip away while open, and puts them back as they were", () => {
    let s = { ...initialState(), browserOpen: true, ribbonOpen: true };
    s = inspecting(s);
    expect([s.browserOpen, s.ribbonOpen]).toEqual([false, false]);
    // Another point while open changes nothing about them.
    s = run(s, { type: "inspect_at", x: 0.2, y: 0.2 });
    expect(s.inspectRestore).toEqual({ browserOpen: true, ribbonOpen: true });
    s = run(s, { type: "close_inspect" });
    expect([s.browserOpen, s.ribbonOpen, s.inspectRestore]).toEqual([true, true, null]);
    // One that was closed stays closed.
    s = inspecting({ ...s, browserOpen: false, ribbonOpen: true });
    s = run(s, { type: "close_inspect" });
    expect([s.browserOpen, s.ribbonOpen]).toEqual([false, true]);
    // A photograph switch closes Inspect, and puts them back too.
    s = inspecting({ ...s, browserOpen: true, ribbonOpen: true });
    const other = s.images.find((i) => i.id !== s.activeImage);
    if (other) {
      s = run(s, { type: "select_image", id: other.id });
      expect(s.inspectPoint).toBeNull();
      expect([s.browserOpen, s.ribbonOpen]).toEqual([true, true]);
    }
  });

  it("remembers its side with the layout, the right by default", () => {
    let s = initialState();
    expect(s.inspectSide).toBe("right");
    s = run(s, { type: "set_inspect_side", side: "left" });
    const saved = layoutSnapshot(s);
    expect(saved.inspectSide).toBe("left");
    const back = run(initialState(), { type: "restore_layout", layout: saved });
    expect(back.inspectSide).toBe("left");
    expect(run(initialState(), { type: "restore_layout", layout: { ...saved, inspectSide: "middle" as never } }).inspectSide).toBe("right");
    // Its width is a panel size, kept within bounds.
    expect(run(s, { type: "set_panel_size", panel: "inspect", size: 9999 }).panelSizes.inspect).toBe(560);
  });

  it("the column holds the panel, and its header moves it, picks and closes with pictures", () => {
    traceMock.mockResolvedValue([]);
    const dispatch = vi.fn();
    const { rerender } = render(<InspectColumn state={initialState()} dispatch={dispatch} width={300} />);
    expect(screen.queryByTestId("inspect-column")).toBeNull();
    const s = inspecting();
    rerender(<InspectColumn state={s} dispatch={dispatch} width={300} />);
    const column = screen.getByTestId("inspect-column");
    expect(column.style.width).toBe("300px");
    expect(column).toContainElement(screen.getByTestId("inspect-panel"));
    for (const id of ["inspect-repick", "inspect-side", "inspect-close", "inspect-heat-luma", "inspect-heat-color", "inspect-heat-both"]) {
      const b = screen.getByTestId(id);
      expect(b.textContent).toBe("");
      expect(b.querySelector("svg")).not.toBeNull();
      expect(b.getAttribute("aria-label")).toBeTruthy();
    }
    fireEvent.click(screen.getByTestId("inspect-side"));
    expect(dispatch).toHaveBeenLastCalledWith({ type: "set_inspect_side", side: "left" });
  });

  it("sits in the canvas row, left of Adjustments by default and right of the strip when moved", async () => {
    traceMock.mockResolvedValue([]);
    const { App } = await import("../app");
    render(<App />);
    const live = () => (window as unknown as { __heeler: { state: () => State; dispatch: (c: Command) => void } }).__heeler;
    await act(async () => {
      live().dispatch({ type: "toggle_inspect_pick" });
      live().dispatch({ type: "inspect_at", x: 0.5, y: 0.5 });
    });
    const column = await screen.findByTestId("inspect-column");
    const panel = screen.getByTestId("simple-panel");
    expect(column.compareDocumentPosition(panel) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(panel).not.toContainElement(column);
    await act(async () => live().dispatch({ type: "set_inspect_side", side: "left" }));
    const moved = screen.getByTestId("inspect-column");
    expect(moved.getAttribute("data-side")).toBe("left");
    // Opened, it folded the strip and the Library away.
    expect([live().state().browserOpen, live().state().ribbonOpen]).toEqual([false, false]);
  });
});

// 2026-10-18: "when a user clicks on an attribute or section name ... the
// adjustments view automatically scrolls to center the section ... (expand
// the section if collapsed)", with the accent outline the keyboard
// navigator and the Assistant use.
describe("an Inspect row in Develop", () => {
  const steps = (ids: [string, string][]): TraceStep[] =>
    ids.map(([id, type], i) => ({ id, node_type: type, enabled: true, input: i ? sample(0.2) : null, output: sample(i ? 0.3 : 0.2), coverage: id.includes("layer") ? 0.5 : null, moves: false }));

  it("knows each node's section, and a layer's node its layer", () => {
    const s = run(initialState(), { type: "add_layer", maskType: "radial" }, { type: "set_active_layer", id: null });
    const exposure = toolNode(s, "adj")!;
    expect(sectionOfNode(s, exposure.id)).toEqual({ section: "Exposure", layer: null });
    expect(sectionOfNode(s, "layer_1_adj")).toEqual({ section: "Exposure", layer: "layer_1_adj" });
    expect(sectionOfNode(s, "layer_1_mask")).toEqual({ section: null, layer: "layer_1_adj" });
    expect(sectionOfNode(s, "no_such_node")).toBeNull();
  });

  it("a click opens the node's section, centered and outlined, selecting its layer first", async () => {
    const s0 = { ...run(initialState(), { type: "add_layer", maskType: "radial" }, { type: "toggle_inspect_pick" }, { type: "inspect_at", x: 0.5, y: 0.5 }), mode: "simple" as const };
    const exposure = toolNode({ ...s0, activeLayer: null }, "adj")!;
    traceMock.mockResolvedValue(steps([["src", "heeler.image_source"], [exposure.id, "heeler.exposure"], ["layer_1_adj", "heeler.exposure"]]));
    const dispatch = vi.fn();
    render(<InspectPanel state={{ ...s0, activeLayer: null }} dispatch={dispatch} />);
    await waitFor(() => expect(screen.getByTestId(`inspect-select-${exposure.id}`)).toBeInTheDocument());
    // The status line's words: the colors in and out, the change, the mask,
    // and where a click goes.
    const hint = screen.getByTestId(`inspect-select-${exposure.id}`).getAttribute("data-hint")!;
    expect(hint).toMatch(/in R \d+ G \d+ B \d+, out R \d+ G \d+ B \d+/);
    expect(hint).toMatch(/brightness/);
    expect(hint).toMatch(/click to open Exposure/);
    expect(screen.getByTestId("inspect-select-layer_1_adj").getAttribute("data-hint")).toMatch(/mask lets 50% through here/);
    fireEvent.click(screen.getByTestId(`inspect-select-${exposure.id}`));
    const sent = dispatch.mock.calls.map(([c]) => c);
    expect(sent).toContainEqual({ type: "open_section", title: "Exposure" });
    expect(sent).toContainEqual({ type: "flash_control", section: "Exposure", param: null });
    expect(sent).toContainEqual({ type: "set_panel_tab", tab: "adjust" });
    expect(sent.some((c) => c.type === "set_active_layer")).toBe(false);
    dispatch.mockClear();
    fireEvent.click(screen.getByTestId("inspect-select-layer_1_adj"));
    const layer = dispatch.mock.calls.map(([c]) => c);
    const at = (t: string) => layer.findIndex((c) => c.type === t);
    expect(layer).toContainEqual({ type: "set_active_layer", id: "layer_1_adj" });
    expect(at("set_active_layer")).toBeLessThan(at("flash_control"));
    expect(layer).toContainEqual({ type: "flash_control", section: "Exposure", param: null });
  });

  it("in Graph a click only selects the node", async () => {
    const s0 = { ...run(initialState(), { type: "toggle_inspect_pick" }, { type: "inspect_at", x: 0.5, y: 0.5 }), mode: "advanced" as const };
    const exposure = toolNode({ ...s0, activeLayer: null }, "adj")!;
    traceMock.mockResolvedValue(steps([["src", "heeler.image_source"], [exposure.id, "heeler.exposure"]]));
    const dispatch = vi.fn();
    render(<InspectPanel state={s0} dispatch={dispatch} />);
    await waitFor(() => expect(screen.getByTestId(`inspect-select-${exposure.id}`)).toBeInTheDocument());
    fireEvent.click(screen.getByTestId(`inspect-select-${exposure.id}`));
    expect(dispatch.mock.calls.map(([c]) => c)).toEqual([{ type: "select_nodes", ids: [exposure.id] }]);
  });
});
