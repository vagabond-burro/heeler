// The Detail Equalizer: its seat after Detail, built on the first band
// that moves, its fold in the Detail section, and its band view.
import React from "react";
import { describe, it, expect } from "vitest";
import { render, screen, within, fireEvent } from "@testing-library/react";
import { initialState, NEUTRAL_NODES, NEUTRAL_WIRES } from "../data";
import { CHAIN_ORDER } from "../recipes";
import { reduce, toolNode, previewTarget, type State, type Command } from "../state";
import { SimplePanel } from "../ui/simple";

const fresh = (): State => ({ ...initialState(), nodes: structuredClone(NEUTRAL_NODES), wires: structuredClone(NEUTRAL_WIRES), sectionsClosed: [] });
const run = (s: State, ...cmds: Command[]) => cmds.reduce(reduce, s);
const BANDS = ["fine", "small", "medium", "large", "broad"];

describe("Detail Equalizer", () => {
  it("sits right after Detail in the chain", () => {
    expect(CHAIN_ORDER.indexOf("detaileq")).toBe(CHAIN_ORDER.indexOf("detail") + 1);
  });

  it("is built on the first band that moves, after Detail, as an undo step", () => {
    let s = run(fresh(), { type: "set_category", title: "Detail", on: true });
    const stand = toolNode(s, "detaileq")!;
    expect(s.nodes.some((n) => n.id === stand.id)).toBe(false);
    // A write at its identity builds nothing.
    s = run(s, { type: "set_param", id: stand.id, param: "fine", value: 0 });
    expect(s.nodes.some((n) => n.type === "heeler.detail_eq")).toBe(false);
    s = run(s, { type: "set_param", id: stand.id, param: "medium", value: 40 });
    const eq = s.nodes.find((n) => n.type === "heeler.detail_eq")!;
    expect(eq.params.medium).toBe(40);
    expect(s.wires).toContainEqual(expect.objectContaining({ from: "detail", to: eq.id }));
    expect(s.undoStack.some((u) => /Add Detail Equalizer/.test(u.label ?? ""))).toBe(true);
  });

  it("follows the selected layer like the rest of Detail", () => {
    let s = run(fresh(), { type: "set_category", title: "Detail", on: true }, { type: "add_layer", maskType: "range" });
    s = run(s, { type: "set_param", id: toolNode(s, "detaileq")!.id, param: "fine", value: -50 });
    expect(s.nodes.find((n) => n.id === "layer_1_detaileq")?.params.fine).toBe(-50);
    expect(s.nodes.some((n) => n.id === "detaileq")).toBe(false);
  });

  it("the band view is view state, one band of one node, exclusive with the other frame views", () => {
    let s = run(fresh(), { type: "set_category", title: "Detail", on: true });
    s = run(s, { type: "set_param", id: toolNode(s, "detaileq")!.id, param: "large", value: 30 });
    const id = toolNode(s, "detaileq")!.id;
    s = run(s, { type: "toggle_detail_eq_view", id, band: 2 });
    expect(previewTarget(s)).toBe(`__detaileq__@2@${id}`);
    // Not undoable: the photograph did not change.
    expect(run(s, { type: "undo" }).detailEqView).toEqual({ id, band: 2 });
    s = run(s, { type: "toggle_halation_view" });
    expect(s.detailEqView).toBeNull();
    s = run(s, { type: "toggle_detail_eq_view", id, band: 4 });
    expect(s.halationView).toBe(false);
    expect(previewTarget(s)).toBe(`__detaileq__@4@${id}`);
    // The same band again puts it down.
    s = run(s, { type: "toggle_detail_eq_view", id, band: 4 });
    expect(s.detailEqView).toBeNull();
    // A node switched off shows the plain frame.
    s = run(s, { type: "toggle_detail_eq_view", id, band: 1 }, { type: "set_enabled", id, enabled: false });
    expect(previewTarget(s) ?? "").not.toMatch(/__detaileq__/);
  });

  it("the fold edits the bands and weights, shows its badge, and resets with the section", () => {
    const start = run(fresh(), { type: "set_category", title: "Detail", on: true });
    let current = start;
    function Harness() {
      const [state, dispatch] = React.useReducer(reduce, start);
      current = state;
      return <SimplePanel state={state} dispatch={dispatch} />;
    }
    render(<Harness />);
    const fold = screen.getByTestId("detail-eq");
    fireEvent.click(within(fold).getByTestId("detail-eq-toggle"));
    for (const b of BANDS) expect(within(fold).getByTestId(`slider-${b}`)).toBeTruthy();
    // The view needs the node: until a band moves, the eyes are off.
    expect((within(fold).getByTestId("detail-eq-view-fine") as HTMLButtonElement).disabled).toBe(true);
    fireEvent.keyDown(within(within(fold).getByTestId("slider-small")).getByRole("slider"), { key: "ArrowRight" });
    const eq = current.nodes.find((n) => n.type === "heeler.detail_eq")!;
    expect(eq.params.small).toBeGreaterThan(0);
    expect(within(fold).getByTestId("detail-eq-badge")).toHaveTextContent("1");
    fireEvent.click(within(fold).getByTestId("detail-eq-view-medium"));
    expect(current.detailEqView).toEqual({ id: eq.id, band: 3 });
    fireEvent.click(within(fold).getByTestId("detail-eq-weights-toggle"));
    fireEvent.keyDown(within(within(fold).getByTestId("slider-highlights")).getByRole("slider"), { key: "ArrowLeft" });
    expect(current.nodes.find((n) => n.id === eq.id)!.params.highlights).toBeLessThan(100);
    fireEvent.click(within(fold).getByTestId("detail-eq-weights-reset"));
    expect(current.nodes.find((n) => n.id === eq.id)!.params.highlights).toBe(100);
    fireEvent.click(screen.getByTestId("reset-detail"));
    const after = current.nodes.find((n) => n.id === eq.id)!;
    for (const b of BANDS) expect(after.params[b]).toBe(0);
  });
});
