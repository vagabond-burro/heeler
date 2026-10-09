import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { App } from "../app";
import { initialState } from "../data";
import { DEPTH_MASK_DEFAULTS, LAYER_MASK_DEFAULTS, LAYER_MASK_TYPES, NEUTRAL_PARAMS, reduce, type Command, type State } from "../state";
import { depthWanted } from "../ui/depthtool";
import { LayersSection } from "../ui/simple";

const run = (s: State, ...cmds: Command[]) => cmds.reduce(reduce, s);
const maskOf = (s: State, id: string) => s.nodes.find((n) => n.id === id)!;

/* (2026-09-09): depth as a mask on adjustment layers and Finish
 * layers, multiplied into the layer's own mask, with an Invert that is
 * the layer's alone.*/
describe("the Depth block on a layer's mask", () => {
  it("every mask type is born with the block off and not inverted", () => {
    for (const type of LAYER_MASK_TYPES) {
      expect(LAYER_MASK_DEFAULTS[type]).toMatchObject(DEPTH_MASK_DEFAULTS);
    }
    const s = reduce(initialState(), { type: "add_layer", maskType: "range" });
    expect(maskOf(s, "layer_1_mask").params).toMatchObject({ depth_on: 0, depth_invert: 0, depth_black: 0, depth_white: 1, depth_gamma: 1 });
  });

  it("a mask with Depth on asks for the depth map; off, or on a layer switched off, it does not", () => {
    const s = reduce(initialState(), { type: "add_layer", maskType: "range" });
    expect(depthWanted(s)).toBe(false);
    const on = reduce(s, { type: "set_param", id: "layer_1_mask", param: "depth_on", value: 1 });
    expect(depthWanted(on)).toBe(true);
    const off = reduce(on, { type: "set_enabled", id: "layer_1_mask", enabled: false });
    expect(depthWanted(off)).toBe(false);
  });

  it("Reset mask puts the Depth block back with the rest", () => {
    const s = run(
      initialState(),
      { type: "add_layer", maskType: "radial" },
      { type: "set_param", id: "layer_1_mask", param: "depth_on", value: 1 },
      { type: "set_param", id: "layer_1_mask", param: "depth_invert", value: 1 },
    );
    const reset = reduce(s, { type: "reset_mask", id: "layer_1_mask", maskType: "radial" });
    expect(maskOf(reset, "layer_1_mask").params).toMatchObject(DEPTH_MASK_DEFAULTS);
  });

  it("the Develop layer's block: a switch, its own Invert, and the depth eye; no dials (simpler than a near/far window)", async () => {
    const user = userEvent.setup();
    render(<App />);
    await user.click(screen.getByTestId("add-layer-range"));
    const block = screen.getByTestId("mask-depth");
    expect(within(block).queryByTestId("mask-depth-invert")).toBeNull();
    await user.click(within(block).getByTestId("mask-depth-toggle"));
    expect(within(block).getByTestId("mask-depth-toggle")).toHaveAttribute("aria-checked", "true");
    expect(within(block).queryAllByRole("slider")).toHaveLength(0);
    // The Levels widget on the depth map: three handles and, since
    // 2026-09-13, the two falloffs ("the exact same
    // histogram widget as found in LEVELS", then "a fall off handle to
    // smooth the transition").
    const editor = within(block).getByTestId("mask-depth-levels-editor");
    for (const h of ["black", "gamma", "white", "black-soft", "white-soft"]) expect(within(editor).getByTestId(`mask-depth-levels-handle-${h}`)).toBeInTheDocument();
    await user.click(within(block).getByTestId("mask-depth-invert"));
    expect(within(block).getByTestId("mask-depth-invert")).toHaveAttribute("aria-checked", "true");
    // The eye beside the switch is the View depth eye.
    await user.click(within(block).getByTestId("mask-depth-view"));
    expect(screen.getByTestId("mask-depth-view")).toHaveAttribute("aria-pressed", "true");
    // The next layer's mask is untouched: the block, and its inversion,
    // are each layer's alone.
    await user.click(screen.getByTestId("add-layer-radial"));
    const second = screen.getByTestId("mask-depth");
    expect(within(second).getByTestId("mask-depth-toggle")).toHaveAttribute("aria-checked", "false");
  });

  it("a Finish layer's Depth button sits beside the mask button, gives a maskless layer a brush mask, and opens the invert and eye row", async () => {
    const user = userEvent.setup();
    render(<App />);
    await user.click(screen.getByTestId("panel-tab-layers"));
    await user.click(screen.getByTestId("art-add-content"));
    expect(screen.getByTestId("art-mask-add-art_b1")).toBeInTheDocument();
    const button = screen.getByTestId("art-depth-art_b1-toggle");
    expect(button).not.toHaveAttribute("data-active");
    expect(screen.queryByTestId("art-depth-art_b1")).toBeNull();
    fireEvent.click(button);
    // The mask exists now, the button is lit, and the row offers
    // Invert depth and the depth eye as icon toggles.
    expect(screen.queryByTestId("art-mask-add-art_b1")).not.toBeInTheDocument();
    expect(screen.getByTestId("art-depth-art_b1-toggle")).toHaveAttribute("data-active", "true");
    const row = screen.getByTestId("art-depth-art_b1");
    fireEvent.click(within(row).getByTestId("art-depth-art_b1-invert"));
    expect(within(row).getByTestId("art-depth-art_b1-invert")).toHaveAttribute("data-active", "true");
    fireEvent.click(within(row).getByTestId("art-depth-art_b1-view"));
    expect(within(row).getByTestId("art-depth-art_b1-view")).toHaveAttribute("data-active", "true");
    expect(screen.getByTestId("art-depth-art_b1-levels-handle-gamma")).toBeInTheDocument();
    // Off again: the mask stays, the row folds.
    fireEvent.click(screen.getByTestId("art-depth-art_b1-toggle"));
    expect(screen.queryByTestId("art-depth-art_b1")).toBeNull();
    expect(screen.getByTestId("art-mask-edit-art_b1")).toBeInTheDocument();
  });
});

/* (2026-09-13): the same Levels on the three depth sections, and the
 * layers' Depth block at the foot of every Color Set.*/
describe("depth Levels on the sections and on the Color Sets", () => {
  it("Depth Map, Fog and Depth Lighting are born with identity Levels on the plane", () => {
    const s = initialState();
    for (const id of ["depthmap", "fog", "keylight"]) {
      const n = s.nodes.find((k) => k.id === id)!;
      expect(NEUTRAL_PARAMS[n.type]).toMatchObject({ depth_black: 0, depth_white: 1, depth_gamma: 1 });
    }
  });

  it("each of the three sections carries the Levels widget on the plane, and no other depth section does", () => {
    render(<App />);
    for (const key of ["depthmap", "fog", "keylight"]) {
      expect(screen.getByTestId(`depth-plane-${key}-levels-editor`)).toBeInTheDocument();
    }
    expect(screen.queryByTestId("depth-plane-dof-levels-editor")).toBeNull();
    // The widget writes the section's own node.
    const s0 = initialState();
    const s = reduce(s0, { type: "set_param", id: "fog", param: "depth_black", value: 0.3 });
    expect(maskOf(s, "fog").params.depth_black).toBe(0.3);
    expect(maskOf(s, "keylight").params.depth_black).toBeUndefined();
  });

  it("every Color Set ends with a Depth mask block of its own, on the set's range mask, and asks for the map when switched on", async () => {
    const user = userEvent.setup();
    render(<App />);
    await user.click(screen.getByTestId("add-color-set"));
    const block = screen.getByTestId("cset-depth-1");
    expect(block).toBeInTheDocument();
    expect(within(block).getByTestId("cset-depth-1-toggle")).toHaveAttribute("data-hint", expect.stringContaining("this set's range"));
    // Reducer side: the set's mask is a range mask, so the block's
    // flags ride the same params the layers' do, this set's alone.
    let s = reduce(initialState(), { type: "add_color_set" });
    s = reduce(s, { type: "add_color_set" });
    expect(depthWanted(s)).toBe(false);
    s = reduce(s, { type: "set_param", id: "cset1_mask", param: "depth_on", value: 1 });
    expect(depthWanted(s)).toBe(true);
    s = reduce(s, { type: "set_param", id: "cset1_mask", param: "depth_invert", value: 1 });
    expect(maskOf(s, "cset1_mask").params).toMatchObject({ depth_on: 1, depth_invert: 1 });
    expect(maskOf(s, "cset2_mask").params.depth_on ?? 0).toBe(0);
  });
});

/* (2026-09-13): "one thing missing on these depth map levels is a
 * fall off handle to smooth the transition".*/
it("every depth Levels carries the two falloff handles, born at zero", async () => {
  expect(DEPTH_MASK_DEFAULTS).toMatchObject({ depth_black_soft: 0, depth_white_soft: 0 });
  const user = userEvent.setup();
  render(<App />);
  await user.click(screen.getByTestId("add-layer-range"));
  await user.click(within(screen.getByTestId("mask-depth")).getByTestId("mask-depth-toggle"));
  expect(screen.getByTestId("mask-depth-levels-handle-black-soft")).toBeInTheDocument();
  expect(screen.getByTestId("depth-plane-keylight-levels-handle-white-soft")).toBeInTheDocument();
});

/* 26.3 bug: the Recolor eyedropper on a Depth row clicked dead on a
 * flat depth cell, because nothing had ever asked for the plane. The
 * arm itself asks now, the way the DoF focus picker's does. */
it("an armed Recolor picker on a Depth row asks for the plane; a Hue row does not", () => {
  const s = run(
    initialState(),
    { type: "set_category", title: "Recolor", on: true },
    { type: "toggle_recolor_pick", id: "recolor" },
  );
  expect(depthWanted({ ...s, recolorCell: "depth_lum" })).toBe(true);
  expect(depthWanted({ ...s, recolorCell: "hue_sat" })).toBe(false);
  // Disarmed, a flat depth cell asks for nothing, as before.
  expect(depthWanted(reduce({ ...s, recolorCell: "depth_lum" }, { type: "toggle_recolor_pick", id: "recolor" }))).toBe(false);
});

/* (2026-09-13): "reset edits should turn off depth mask preview".*/
it("Reset all edits puts the depth eye away with the edits", () => {
  const s = run(initialState(), { type: "toggle_depth_view" });
  expect(s.depthView).toBe(true);
  const reset = reduce(s, { type: "reset_image_edits", id: s.activeImage });
  expect(reset.depthView).toBe(false);
  // A reset of another photograph from the strip leaves the eye as it is.
  expect(reduce(s, { type: "reset_image_edits", id: "4866" }).depthView).toBe(true);
});

/* 26.3 bug: the depth mask Levels sized only from its own default, so
 * resizing the right panel never reached it. The panel's width is
 * threaded down now; the mask controls' container is padded 12px right
 * and 18px left, so the Levels width is the panel's less 30. */
describe("the depth Levels follows the right panel's width", () => {
  const withDepthOn = () =>
    run(
      initialState(),
      { type: "add_layer", maskType: "range" },
      { type: "set_param", id: "layer_1_mask", param: "depth_on", value: 1 },
    );

  it("the Layers section at two panel widths", () => {
    const s = withDepthOn();
    const first = render(<LayersSection state={s} dispatch={() => {}} width={280} />);
    expect(Number(screen.getByTestId("mask-depth-levels-editor").getAttribute("width"))).toBe(250);
    first.unmount();
    render(<LayersSection state={s} dispatch={() => {}} width={500} />);
    expect(Number(screen.getByTestId("mask-depth-levels-editor").getAttribute("width"))).toBe(470);
  });

  it("a panel too narrow still leaves the Levels at its floor", () => {
    render(<LayersSection state={withDepthOn()} dispatch={() => {}} width={240} />);
    expect(Number(screen.getByTestId("mask-depth-levels-editor").getAttribute("width"))).toBe(220);
  });
});
