// A range mask's node in Graph has its layer's controls (2026-10-06:
// "when I view the range mask node I noticed the node did not have the
// same controls as to what the adjustment layer has"). Develop's layer
// block carries the Preset menu, the eyedropper with its Set, Widen and
// Narrow modes and its Luma and Hue targets, and the range histogram;
// the node had the sliders alone. And the eyedropper wrote into the
// active Develop layer's mask whoever armed it, so a Pick on the node
// would have sampled into another layer, or nowhere.

import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { initialState } from "../data";
import { makeNode, specFor } from "../nodes";
import { NEUTRAL_PARAMS, pickMaskNode, reduce, type Command, type State } from "../state";
import { NodeParams } from "../ui/graph";

const test = vi.hoisted(() => ({ sample: { luma: 0.8, hue: 120, sat: 0.5 } }));
vi.mock("../bridge", async (original) => ({
  ...await original<typeof import("../bridge")>(),
  sampleImage: async () => test.sample,
}));
import { Viewer } from "../ui/viewer";
import { choose } from "./menuhelp";

const rangeNode = (id: string) => ({
  ...makeNode(specFor("heeler.range_mask")!, id, 0, 0),
  params: { ...(NEUTRAL_PARAMS["heeler.range_mask"] ?? {}) },
});

/** Two Develop range layers, the second one active. */
function twoLayers(): State {
  let s = initialState();
  s = reduce(s, { type: "add_layer", maskType: "range" });
  s = reduce(s, { type: "add_layer", maskType: "range" });
  return s;
}

describe("the range mask node's seat in Graph", () => {
  it("offers the Preset menu, the eyedropper, its modes and targets, and the histogram", () => {
    const node = rangeNode("layer_1_mask");
    render(<NodeParams node={node} dispatch={() => {}} appState={initialState()} />);
    const seat = screen.getByTestId("inspector-range-tools-layer_1_mask");
    for (const id of ["range-preset", "range-picker", "pick-mode-replace", "pick-mode-add", "pick-mode-subtract", "pick-target-luma", "pick-target-hue"]) {
      expect(seat.querySelector(`[data-testid="${id}"]`), id).not.toBeNull();
    }
    expect(seat.querySelector("canvas, svg")).not.toBeNull();
    // The sliders are still there, after the tools as in Develop.
    expect(screen.getByText("Luma low")).toBeTruthy();
  });

  it("writes a preset and arms the eyedropper on this node", () => {
    const got: Command[] = [];
    render(<NodeParams node={rangeNode("layer_1_mask")} dispatch={(c) => got.push(c)} appState={initialState()} />);
    choose(screen.getByTestId("range-preset"), "highlights");
    fireEvent.click(screen.getByTestId("range-picker"));
    expect(got[0]).toMatchObject({ type: "set_params", id: "layer_1_mask" });
    expect(got[1]).toEqual({ type: "set_tool", tool: "pick", node: "layer_1_mask" });
  });

  it("lights its Pick only while the eyedropper samples into it", () => {
    const armedElsewhere = { ...initialState(), tool: "pick" as const, pickNode: "layer_2_mask" };
    const { unmount } = render(<NodeParams node={rangeNode("layer_1_mask")} dispatch={() => {}} appState={armedElsewhere} />);
    expect(screen.getByTestId("range-picker")).toHaveAttribute("data-active", "false");
    unmount();
    render(<NodeParams node={rangeNode("layer_2_mask")} dispatch={() => {}} appState={armedElsewhere} />);
    expect(screen.getByTestId("range-picker")).toHaveAttribute("data-active", "true");
  });

  it("is absent without the app state, and on other mask nodes", () => {
    const { unmount } = render(<NodeParams node={rangeNode("m")} dispatch={() => {}} />);
    expect(screen.queryByTestId("inspector-range-tools-m")).toBeNull();
    unmount();
    const radial = { ...makeNode(specFor("heeler.radial_mask")!, "r", 0, 0), params: { ...(NEUTRAL_PARAMS["heeler.radial_mask"] ?? {}) } };
    render(<NodeParams node={radial} dispatch={() => {}} appState={initialState()} />);
    expect(screen.queryByTestId("range-picker")).toBeNull();
  });
});

describe("the eyedropper's target", () => {
  it("is the mask its Pick named, else the active layer's", () => {
    const s = twoLayers();
    expect(s.activeLayer).toBe("layer_2_adj");
    expect(pickMaskNode(s)).toBe("layer_2_mask");
    const named = reduce(s, { type: "set_tool", tool: "pick", node: "layer_1_mask" });
    expect(named.tool).toBe("pick");
    expect(pickMaskNode(named)).toBe("layer_1_mask");
    // The menu and shortcut name nothing: the active layer's mask.
    const plain = reduce(s, { type: "set_tool", tool: "pick" });
    expect(plain.pickNode).toBeNull();
    expect(pickMaskNode(plain)).toBe("layer_2_mask");
  });

  it("moves to another mask instead of going down, and goes down on its own mask", () => {
    const s = reduce(twoLayers(), { type: "set_tool", tool: "pick", node: "layer_1_mask" });
    const moved = reduce(s, { type: "set_tool", tool: "pick", node: "layer_2_mask" });
    expect(moved.tool).toBe("pick");
    expect(pickMaskNode(moved)).toBe("layer_2_mask");
    const down = reduce(moved, { type: "set_tool", tool: "pick", node: "layer_2_mask" });
    expect(down.tool).toBe("none");
    expect(down.pickNode).toBeNull();
  });

  it("forgets its mask when another tool is taken up", () => {
    const s = reduce(twoLayers(), { type: "set_tool", tool: "pick", node: "layer_1_mask" });
    expect(reduce(s, { type: "set_tool", tool: "brush" }).pickNode).toBeNull();
  });

  it("puts the dropper down when its named mask leaves the graph", () => {
    // The seat the dropper was armed from is gone, so it cannot stay
    // armed: the click would sample into the void (the viewer finds no
    // node by the dead id) with no lit button left to put it down.
    const s = reduce(twoLayers(), { type: "set_tool", tool: "pick", node: "layer_1_mask" });
    const gone = reduce(s, { type: "delete_nodes", ids: ["layer_1_mask"] });
    expect(gone.pickNode).toBeNull();
    expect(gone.tool).toBe("none");
  });

  it("leaves another tool alone when a stale target's mask leaves the graph", () => {
    // pickNode is cleared only by set_tool; the reducer also sets the
    // tool directly in places, so a target can outlive its arming. Its
    // mask going must not take down whatever tool is in hand now.
    const s = { ...twoLayers(), tool: "crop", pickNode: "layer_1_mask" } as ReturnType<typeof twoLayers>;
    const gone = reduce(s, { type: "delete_nodes", ids: ["layer_1_mask"] });
    expect(gone.pickNode).toBeNull();
    expect(gone.tool).toBe("crop");
  });

  it("samples into the named mask, not the active layer's", async () => {
    const s = reduce(twoLayers(), { type: "set_tool", tool: "pick", node: "layer_1_mask" });
    const got: Command[] = [];
    render(<Viewer state={s} dispatch={(c) => got.push(c)} />);
    fireEvent.mouseDown(screen.getByTestId("pick-overlay"), { button: 0, clientX: 10, clientY: 10 });
    await vi.waitFor(() => expect(got.some((c) => c.type === "set_params")).toBe(true));
    const write = got.find((c) => c.type === "set_params") as Extract<Command, { type: "set_params" }>;
    expect(write.id).toBe("layer_1_mask");
    // Set on a luma sample of 0.8: a window around it.
    expect(write.values.luma_low).toBeCloseTo(0.74, 2);
    expect(write.values.luma_high).toBeCloseTo(0.86, 2);
  });
});
