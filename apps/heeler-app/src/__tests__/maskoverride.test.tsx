// with Show mask and View depth both on for an adjustment layer, the
// depth map takes the frame and nothing said so. The Show mask
// button wears the warning color and says which view has the frame;
// View depth's hint says it is covering the mask.
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { initialState } from "../data";
import { maskViewOverriddenBy, reduce, type Command, type State } from "../state";
import { LayersSection } from "../ui/simple";

const run = (s: State, ...cmds: Command[]) => cmds.reduce(reduce, s);
const layer = () =>
  run(initialState(), { type: "add_layer", maskType: "radial" }, { type: "set_param", id: "layer_1_mask", param: "depth_on", value: 1 });

describe("which view has the frame", () => {
  it("names View depth when it takes the frame from the mask", () => {
    expect(maskViewOverriddenBy(layer())).toBeNull();
    expect(maskViewOverriddenBy(run(layer(), { type: "toggle_mask_view" }))).toBeNull();
    expect(maskViewOverriddenBy(run(layer(), { type: "toggle_depth_view" }))).toBeNull();
    expect(maskViewOverriddenBy(run(layer(), { type: "toggle_mask_view" }, { type: "toggle_depth_view" }))).toBe("View depth");
    expect(maskViewOverriddenBy(run(layer(), { type: "toggle_mask_view" }, { type: "toggle_halation_view" }))).toBe("the halation view");
  });
});

describe("the buttons say so", () => {
  it("Show mask wears the warning color and names the view; View depth says it covers the mask", () => {
    const s = run(layer(), { type: "toggle_mask_view" }, { type: "toggle_depth_view" });
    render(<LayersSection state={s} dispatch={() => {}} width={280} />);
    const eye = screen.getByTestId("mask-view-toggle");
    expect(eye).toHaveAttribute("data-overridden", "true");
    expect(eye.style.color).toBe("var(--warn)");
    expect(eye.getAttribute("data-hint")).toMatch(/View depth is showing instead/);
    expect(eye.getAttribute("data-hint")).toMatch(/depth Levels/);
    expect(screen.getByTestId("mask-depth-view").getAttribute("data-hint")).toMatch(/over this layer's mask/);
  });

  it("with the mask showing, nothing is flagged", () => {
    render(<LayersSection state={run(layer(), { type: "toggle_mask_view" })} dispatch={() => {}} width={280} />);
    const eye = screen.getByTestId("mask-view-toggle");
    expect(eye).not.toHaveAttribute("data-overridden");
    expect(eye.style.color).toBe("var(--accent)");
  });
});
