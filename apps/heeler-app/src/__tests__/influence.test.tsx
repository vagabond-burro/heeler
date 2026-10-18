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
import { anyPickerArmed, previewTarget, reduce, type Command, type State } from "../state";
import { tracePixel, type TraceStep } from "../bridge";
import { InspectPanel } from "../ui/inspect";

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
    expect(screen.getByTestId("inspect-value-exposure").textContent).toBe("40 (+20)");
    expect(screen.getByTestId("inspect-row-exposure").getAttribute("data-changed")).toBe("true");
    expect(screen.getByTestId("inspect-row-layer_1_adj").getAttribute("data-changed")).toBe("false");
    expect(screen.getByTestId("inspect-mask-layer_1_adj").textContent).toBe("mask 0%");
    expect(screen.getByTestId("inspect-value-crop").textContent).toBe("moves pixels");
    expect(screen.queryByTestId("inspect-isolate-crop")).toBeNull();
    expect(screen.getByTestId("inspect-final").textContent).toMatch(/30/);
    fireEvent.click(screen.getByTestId("inspect-heat-luma"));
    fireEvent.click(screen.getByTestId("inspect-heatmap-exposure"));
    expect(dispatch).toHaveBeenLastCalledWith({ type: "toggle_influence_view", id: "exposure", mode: "luma" });
    fireEvent.click(screen.getByTestId("inspect-isolate-exposure"));
    expect(dispatch).toHaveBeenLastCalledWith({ type: "toggle_influence_view", id: "exposure", mode: "isolate" });
    fireEvent.click(screen.getByTestId("inspect-select-exposure"));
    expect(dispatch).toHaveBeenLastCalledWith({ type: "select_nodes", ids: ["exposure"] });
    fireEvent.click(screen.getByTestId("inspect-close"));
    expect(dispatch).toHaveBeenLastCalledWith({ type: "close_inspect" });
  });
});
