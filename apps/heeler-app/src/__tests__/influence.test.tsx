// Influence Mapping on the app side: the Inspect picker and point, the
// influence views as frame view state, and the panel's trace.
import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("../bridge", async (orig) => {
  const real = await orig<typeof import("../bridge")>();
  return { ...real, tracePixel: vi.fn() };
});

import { invoke } from "@tauri-apps/api/core";
import { initialState } from "../data";
import { anyPickerArmed, inspectDocked, previewTarget, reduce, toolNode, type Command, type State } from "../state";
import { tracePixel, type TraceStep } from "../bridge";
import { InspectDock, InspectPanel } from "../ui/inspect";
import { SimplePanel } from "../ui/simple";
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

// 2026-10-18: "move that to the bottom of the right panel in its own
// resizable view? Kind of like the selection and brush tools do".
describe("the Inspect panel docked in the right panel", () => {
  const inspecting = () => run(initialState(), { type: "toggle_inspect_pick" }, { type: "inspect_at", x: 0.5, y: 0.5 });

  it("docks where a right panel is on screen, and floats anywhere else", () => {
    const s = initialState();
    expect(inspectDocked({ ...s, mode: "simple" })).toBe(true);
    expect(inspectDocked({ ...s, mode: "simple", polishOpen: true })).toBe(false);
    expect(inspectDocked({ ...s, mode: "advanced", inspectorHome: "main" })).toBe(true);
    expect(inspectDocked({ ...s, mode: "advanced", inspectorHome: "graph" })).toBe(false);
    expect(inspectDocked({ ...s, mode: "canvas" })).toBe(false);
  });

  it("shows while a point is inspected, folds to a bar and back, and its seam sets its height", () => {
    traceMock.mockResolvedValue([]);
    const dispatch = vi.fn();
    const { rerender } = render(<InspectDock state={initialState()} dispatch={dispatch} />);
    expect(screen.queryByTestId("inspect-split")).toBeNull();
    let s = inspecting();
    rerender(<InspectDock state={s} dispatch={dispatch} />);
    const pane = screen.getByTestId("inspect-split");
    expect(pane.style.height).toBe("260px");
    expect(pane).toContainElement(screen.getByTestId("inspect-panel"));
    expect(screen.getByTestId("inspect-panel")).toHaveAttribute("data-docked", "true");
    expect(screen.getByTestId("inspect-panel").style.position).toBe("");
    fireEvent.click(screen.getByTestId("inspect-minimize"));
    expect(dispatch).toHaveBeenLastCalledWith({ type: "toggle_inspect_split" });
    s = run(s, { type: "toggle_inspect_split" });
    rerender(<InspectDock state={s} dispatch={dispatch} />);
    expect(screen.queryByTestId("inspect-split")).toBeNull();
    fireEvent.click(screen.getByTestId("inspect-split-bar"));
    expect(dispatch).toHaveBeenLastCalledWith({ type: "toggle_inspect_split" });
    // A dragged height is kept, within its bounds, and the pane wears it.
    s = run(s, { type: "toggle_inspect_split" }, { type: "set_panel_size", panel: "inspectSplit", size: 340 });
    expect(s.panelSizes.inspectSplit).toBe(340);
    expect(run(s, { type: "set_panel_size", panel: "inspectSplit", size: 20 }).panelSizes.inspectSplit).toBe(120);
    rerender(<InspectDock state={s} dispatch={dispatch} />);
    expect(screen.getByTestId("inspect-split").style.height).toBe("340px");
    // Closing Inspect takes the pane away.
    rerender(<InspectDock state={run(s, { type: "close_inspect" })} dispatch={dispatch} />);
    expect(screen.queryByTestId("inspect-split")).toBeNull();
  });

  it("sits at the foot of Develop's panel", () => {
    traceMock.mockResolvedValue([]);
    render(<SimplePanel state={{ ...inspecting(), mode: "simple" }} dispatch={() => {}} width={320} />);
    const panel = screen.getByTestId("simple-panel");
    expect(panel).toContainElement(screen.getByTestId("inspect-split"));
    expect(panel).toContainElement(screen.getByTestId("divider-inspect-split"));
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
