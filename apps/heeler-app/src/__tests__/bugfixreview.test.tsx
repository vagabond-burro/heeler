import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { initialState } from "../data";
import { reduce, type Command, type State, activeSelectionMask, maskPreviewNode } from "../state";
import { runCommand } from "../commands";
import { SimplePanel } from "../ui/simple";
import { MaskViewButton } from "../ui/smarttool";
import { ColorSetsBlock } from "../ui/colorsets";
import { CanvasMode } from "../ui/canvas";
import { Viewer } from "../ui/viewer";
const run = (s: State, ...cs: Command[]) => cs.reduce(reduce, s);

describe("bug-fix review regressions", () => {
  it.each(["crop", "straighten", "brush", "pick", "polish"] as const)("V puts %s away outside Finish", tool => {
    let s = run(initialState(), { type: "set_tool", tool });
    runCommand("art.cursor", s, (c: Command) => { s = reduce(s, c); });
    expect(s.tool).toBe("none");
  });
  it("V also disarms an eyedropper", () => {
    let s = run(initialState(), { type: "toggle_console_pick", id: "colorconsole" });
    runCommand("art.cursor", s, (c: Command) => { s = reduce(s, c); });
    expect(s.consolePick).toBeNull();
  });
  it("graph deletion releases the active layer's eye and brush, including redo", () => {
    let s = run(initialState(), { type: "add_layer", maskType: "radial" }, { type: "toggle_mask_view" }, { type: "set_tool", tool: "brush" });
    const id = s.activeLayer!;
    s = run(s, { type: "delete_nodes", ids: [id, id.replace("_adj", "_mask")], heal: true });
    expect(s.activeLayer).toBeNull();
    expect(s.maskView).toBe(false);
    expect(s.tool).toBe("none");
    expect(maskPreviewNode(s)).toBeNull();
    s = run(s, { type: "undo" }, { type: "redo" });
    expect(s.activeLayer).toBeNull();
    expect(maskPreviewNode(s)).toBeNull();
  });
  it("removing a node disarms its picker rather than leaving a dead cursor", () => {
    let s = run(initialState(), { type: "set_category", title: "Color Tune", on: true }, { type: "toggle_console_pick", id: "colorconsole" });
    s = run(s, { type: "delete_nodes", ids: ["colorconsole"], heal: true });
    expect(s.consolePick).toBeNull();
  });
  it("a saved document selection keeps its panel when the cursor is active", () => {
    let s = run(initialState(), { type: "arm_document_selection" });
    const mask = activeSelectionMask(s)!;
    s = { ...s, tool: "none", selection: [], nodes: s.nodes.map(n => n.id === mask.id ? { ...n, regions: [{ kind: "path", points: [[0.2, 0.2], [0.5, 0.2], [0.5, 0.5]], op: "add" }] } : n) } as State;
    render(<SimplePanel state={s} dispatch={() => {}} />);
    expect(screen.getByTestId("selection-split")).toBeInTheDocument();
  });
  it("the shared mask button warns when depth covers it", () => {
    const s = run(initialState(), { type: "add_layer", maskType: "radial" }, { type: "toggle_mask_view" }, { type: "toggle_depth_view" });
    render(<MaskViewButton state={s} dispatch={() => {}} />);
    expect(screen.getByTestId("mask-view-chip").style.color).toBe("var(--warn)");
    expect(screen.getByTestId("mask-view-chip").getAttribute("data-hint")).toContain("View depth");
  });
  it("the Finish canvas eye warns when depth covers it", () => {
    const s = run(initialState(), { type: "add_layer", maskType: "radial" }, { type: "toggle_mask_view" }, { type: "toggle_depth_view" });
    render(<CanvasMode state={s} dispatch={() => {}} />);
    expect(screen.getByTestId("canvas-mask").style.color).toBe("var(--warn)");
    expect(screen.getByTestId("canvas-mask").getAttribute("data-hint")).toContain("View depth");
  });
  it("a Color Set eye warns when depth covers it", () => {
    const s = run(initialState(), { type: "add_color_set" }, { type: "toggle_cset_mask_view", n: 1 }, { type: "toggle_depth_view" });
    render(<ColorSetsBlock state={s} dispatch={() => {}} />);
    expect(screen.getByTestId("mask-view-color-set-1").style.color).toBe("var(--warn)");
  });
  it("the readout sits in the bar's own slot, lets clicks through, and reads at 11px", () => {
    render(<Viewer state={initialState()} dispatch={() => {}} previewUrl={null} previewError={null} previewMs={null} previewBackend={null} originalUrl={null} maskUrl={null} multiFrames={{}} />);
    const box = screen.getByTestId("cursor-readout-box");
    // In the flow between the tools and the Take menu, not floating over
    // the bar (it ran under the Take menu at 150% app zoom).
    const slot = screen.getByTestId("cursor-readout-slot");
    expect(box.parentElement).toBe(slot);
    expect(slot.parentElement).toBe(screen.getByTestId("viewer-header"));
    expect(box.style.pointerEvents).toBe("none");
    expect(Number.parseFloat(screen.getByTestId("cursor-readout").style.fontSize)).toBeGreaterThanOrEqual(11);
  });
});
