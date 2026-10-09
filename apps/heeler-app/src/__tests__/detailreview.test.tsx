import React from "react";
import { describe, it, expect } from "vitest";
import { render, screen, within, fireEvent } from "@testing-library/react";
import { initialState, NEUTRAL_NODES, NEUTRAL_WIRES } from "../data";
import { reduce, toolNode, capturePreset, paramRange, migrateNodes, type State, type Command } from "../state";
import { DetailAdvanced, SECTIONS, SimplePanel } from "../ui/simple";
const fresh = (): State => ({ ...initialState(), nodes: structuredClone(NEUTRAL_NODES), wires: structuredClone(NEUTRAL_WIRES), sectionsClosed: [] });
const run = (s: State, ...cmds: Command[]) => cmds.reduce(reduce, s);
const weights = ["texture", "clarity", "dehaze"].flatMap(e => ["shadows", "midtones", "highlights", "red", "green", "blue"].map(w => `${e}_${w}`));
describe("Detail review contracts", () => {
 it("backfills old weights and carries nondefault weights through presets and reset", () => {
  let s = run(fresh(), { type: "set_category", title: "Detail", on: true });
  const old = { ...toolNode(s, "detail")!, params: { texture: 0, clarity: 0, dehaze: 0 } };
  const n = migrateNodes([old])[0];
  for (const p of weights) { expect(n.params[p]).toBe(100); expect(paramRange(p, n.type)).toEqual([0, 200]); }
  s = run(s, { type: "set_params", id: "detail", values: { texture: 50, texture_highlights: 0, clarity_shadows: 20, dehaze_blue: 150 } });
  const preset = capturePreset(s, "Detail weights");
  s = run(fresh(), { type: "apply_preset", preset });
  expect(toolNode(s, "detail")!.params).toMatchObject({ texture: 50, texture_highlights: 0, clarity_shadows: 20, dehaze_blue: 150 });
  s = run(s, { type: "reset_image_edits", id: s.activeImage });
  expect(toolNode(s, "detail")).toBeUndefined();
  s = run(s, { type: "set_category", title: "Detail", on: true });
  expect(toolNode(s, "detail")!.params.texture).toBe(0);
  for (const p of weights) expect(toolNode(s, "detail")!.params[p]).toBe(100);
 });
 it("keeps Base and two layers separate and groups each drag into one undo", () => {
  let s = run(fresh(), { type: "set_category", title: "Detail", on: true }, { type: "set_param", id: "detail", param: "texture", value: 12 }, { type: "add_layer", maskType: "range" });
  for (const param of ["texture", "clarity_shadows"]) {
   const before = toolNode(s, "detail")!.params[param];
   s = run(s, { type: "begin_gesture", key: `layer_1_detail.${param}` }, { type: "set_param", id: "layer_1_detail", param, value: 30 }, { type: "set_param", id: "layer_1_detail", param, value: 60 }, { type: "end_gesture" });
   expect(toolNode(s, "detail")!.params[param]).toBe(60);
   s = run(s, { type: "undo" }); expect(toolNode(s, "detail")!.params[param]).toBe(before);
  }
  s = run(s, { type: "set_param", id: "layer_1_detail", param: "clarity", value: 35 }, { type: "add_layer", maskType: "radial" }, { type: "set_param", id: "layer_2_detail", param: "clarity", value: -25 });
  expect(s.nodes.find(n => n.id === "detail")!.params.texture).toBe(12);
  expect(s.nodes.find(n => n.id === "layer_1_detail")!.params.clarity).toBe(35);
  expect(toolNode(s, "detail")!.params.clarity).toBe(-25);
  for (const i of [1, 2]) expect(s.wires).toContainEqual({ from: `layer_${i}_mask`, to: `layer_${i}_detail`, toPort: "mask", kind: "mask" });
 });
 it("the switch reaches all three nodes on Base and a layer", () => {
  for (const layered of [false, true]) {
   let s = run(fresh(), { type: "set_category", title: "Detail", on: true }); if (layered) s = run(s, { type: "add_layer", maskType: "range" });
   for (const [tool, param] of [["detail", "texture"], ["sharpen", "amount"], ["denoise", "strength"]] as const) s = run(s, { type: "set_param", id: toolNode(s, tool)?.id ?? tool, param, value: 25 });
   const sec = SECTIONS.find(s => s.title === "Detail")!;
   const ids = [sec.node(s), ...(sec.alsoToggles?.(s) ?? [])].map(n => n!.id); expect(ids).toHaveLength(3);
   let current = s;
   function Harness() { const [state, dispatch] = React.useReducer(reduce, s); current = state; return <SimplePanel state={state} dispatch={dispatch} />; }
   const view = render(<Harness />);
   fireEvent.click(screen.getByTestId("toggle-detail")); for (const id of ids) expect(current.nodes.find(n => n.id === id)!.enabled).toBe(false);
   fireEvent.click(screen.getByTestId("toggle-detail")); for (const id of ids) expect(current.nodes.find(n => n.id === id)!.enabled).toBe(true);
   expect(toolNode(current, "detail")!.params.texture).toBe(25); view.unmount();
  }
 });
 it("shared seats edit all eighteen weights and agree on the badge", () => {
  const start = run(fresh(), { type: "set_category", title: "Detail", on: true });
  function Harness() { const [s, dispatch] = React.useReducer(reduce, start); return <>{["develop", "graph"].map(id => <div key={id} data-testid={id}><DetailAdvanced node={toolNode(s, "detail")!} dispatch={dispatch} /></div>)}</>; }
  render(<Harness />); const a = within(screen.getByTestId("develop")), b = within(screen.getByTestId("graph"));
  fireEvent.click(a.getByTestId("detail-advanced-toggle")); fireEvent.click(b.getByTestId("detail-advanced-toggle"));
  for (const effect of ["texture", "clarity", "dehaze"]) {
   fireEvent.click(a.getByTestId(`detail-effect-${effect}`)); fireEvent.click(b.getByTestId(`detail-effect-${effect}`));
   for (const band of ["shadows", "midtones", "highlights", "red", "green", "blue"]) {
    const row = `slider-${effect}_${band}`; const slider = within(b.getByTestId(row)).getByRole("slider"); fireEvent.keyDown(slider, { key: "ArrowLeft" });
    expect(within(a.getByTestId(row)).getByRole("slider").getAttribute("aria-valuenow")).toBe(slider.getAttribute("aria-valuenow")); expect(Number(slider.getAttribute("aria-valuenow"))).toBeLessThan(100);
   }
  }
  expect(a.getByTestId("detail-advanced-badge")).toHaveTextContent("3"); expect(b.getByTestId("detail-advanced-badge")).toHaveTextContent("3");
 });
});
