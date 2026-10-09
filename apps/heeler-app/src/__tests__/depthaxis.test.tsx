import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { initialState } from "../data";
import { reduce } from "../state";
import { EqEditor } from "../ui/eqeditor";
import { RecolorBlock } from "../ui/recolor";
import { EyedropperIcon } from "../ui/panelicons";

const luma = (hex: string) => parseInt(hex.slice(1, 3), 16) + parseInt(hex.slice(3, 5), 16) + parseInt(hex.slice(5, 7), 16);

describe("the depth axis reads as the depth map (2026-09-16)", () => {
  it("paints white near and black far, and names its ends instead of numbering them", () => {
    const state = reduce(initialState(), { type: "set_category", title: "Recolor", on: true });
    const node = state.nodes.find((n) => n.id === "recolor")!;
    const view = render(
      <EqEditor node={node} dispatch={(() => {}) as never} domain={[0, 100]} xTicks={[0, 50, 100]} yRange={[-2, 2]} axisBackground="depth" xEndLabels={["NEAR", "FAR"]} points={[{ x: 0, y: 0 }, { x: 100, y: 0 }]} onPoints={() => {}} noPresets noInterp />,
    );
    const stops = Array.from(view.container.querySelectorAll("#eq-bg-depth stop")).map((s) => s.getAttribute("stop-color")!);
    expect(stops).toHaveLength(2);
    // Near (x = 0) is the light end, far the dark, as View depth paints the map.
    expect(luma(stops[0])).toBeGreaterThan(luma(stops[1]));
    expect(view.container.querySelector("#eq-bg-depth")?.getAttribute("x1")).toBe("0");
    expect(view.container.querySelector("#eq-bg-depth")?.getAttribute("x2")).toBe("1");
    expect(Array.from(view.container.querySelectorAll("#eq-bg-depth stop")).map((s) => s.getAttribute("offset"))).toEqual(["0%", "100%"]);
    expect(view.getByText("NEAR")).toBeTruthy();
    expect(view.getByText("FAR")).toBeTruthy();
    expect(view.queryByText("+100")).toBeNull();
    expect(view.getByText("+50")).toBeTruthy();
  });

  it("keeps the end words inside a 160-pixel editor and only replaces ticks that exist", () => {
    const node = reduce(initialState(), { type: "set_category", title: "Recolor", on: true }).nodes.find((n) => n.id === "recolor")!;
    const editor = (ticks: number[]) => <EqEditor node={node} dispatch={(() => {}) as never} width={160} domain={[0, 100]} xTicks={ticks} yRange={[-2, 2]} xEndLabels={["NEAR", "FAR"]} points={[{ x: 0, y: 0 }, { x: 100, y: 0 }]} onPoints={() => {}} noPresets noInterp />;
    const view = render(editor([0, 50, 100]));
    const labels = [view.getByText("NEAR"), view.getByText("+50"), view.getByText("FAR")];
    expect(labels.map((label) => label.getAttribute("x"))).toEqual(["34", "93", "152"]);
    expect(labels.map((label) => label.getAttribute("text-anchor"))).toEqual(["start", "middle", "end"]);
    // Even a full em per monospace character leaves a gap at this
    // narrower-than-inspector width. This checks SVG geometry, not a
    // browser's font rasterization.
    const boxes = labels.map((label, i) => {
      const width = label.textContent!.length * Number(label.getAttribute("font-size"));
      const x = Number(label.getAttribute("x"));
      const left = x - (i === 0 ? 0 : i === 1 ? width / 2 : width);
      return [left, left + width];
    });
    expect(boxes[0][0]).toBeGreaterThanOrEqual(0);
    expect(boxes[0][1]).toBeLessThan(boxes[1][0]);
    expect(boxes[1][1]).toBeLessThan(boxes[2][0]);
    expect(boxes[2][1]).toBeLessThanOrEqual(160);
    view.rerender(editor([25, 50, 75]));
    expect(view.queryByText("NEAR")).toBeNull();
    expect(view.queryByText("FAR")).toBeNull();
    expect(view.getByText("+25")).toBeTruthy();
    expect(view.getByText("+75")).toBeTruthy();
  });

  it("Recolor's Depth row says what its click does and wears the end words; a hue row keeps its numbers", () => {
    const state = reduce(initialState(), { type: "set_category", title: "Recolor", on: true });
    const node = state.nodes.find((n) => n.id === "recolor")!;
    const block = (cell: "depth_lum" | "hue_sat") => (
      <RecolorBlock node={node} dispatch={(() => {}) as never} cell={cell} onCell={() => {}} onTogglePick={() => {}} />
    );
    const view = render(block("depth_lum"));
    const target = view.getByTestId("tone-eq-pick");
    expect(target).toHaveAttribute("aria-label", "Pick a depth from the photo");
    expect(target.getAttribute("data-hint")).toContain("Pick a depth");
    expect(target.getAttribute("data-hint")).toContain("drop a point");
    const icon = render(<EyedropperIcon size={11} />);
    expect(target.querySelector("svg")?.innerHTML).toBe(icon.container.querySelector("svg")?.innerHTML);
    icon.unmount();
    expect(view.getByText("NEAR")).toBeTruthy();
    expect(view.getByText("FAR")).toBeTruthy();
    view.rerender(block("hue_sat"));
    const dropper = view.getByTestId("tone-eq-pick");
    expect(dropper).toHaveAttribute("aria-label", "Pick a color from the photo");
    expect(dropper.getAttribute("data-hint")).toContain("Pick a color");
    expect(dropper.getAttribute("data-hint")).not.toContain("re-expose");
    expect(view.queryByText("NEAR")).toBeNull();
    expect(view.getByText("+360")).toBeTruthy();
  });
});
