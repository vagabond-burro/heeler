// 2026-09-29, a Color Set's mask eye on a portrait RAW: "I turned on
// depth mask when viewing the color set mask and it seemed to stack and
// make things darker. I think both regular mask preview and the overlay
// preview should be reconciled so we can see them together to see the
// effect. I noticed that turning on the depth mask (black and white)
// sometimes caused the regular mask preview to turn off. These need to
// be reconciled to accurately depict the masking effect (whether black
// and white, or tint)."
//
// What a mask eye shows is its mask node, which carries the selection
// times the Depth mask (Levels, Invert): the one mask the adjustment
// multiplies by. The desktop proves the values (lib.rs,
// a_mask_eye_shows_the_mask_the_adjustment_consumes); these prove the
// views: one precedence (MASK_EYE_TAKES_FRAME), and a mask eye goes
// down only when the user presses it.
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

import { invoke } from "@tauri-apps/api/core";
import { App } from "../app";
import { initialState } from "../data";
import { maskOverlayWanted, maskViewOverriddenBy, previewTarget, reduce, type Command, type State } from "../state";

const run = (s: State, ...cmds: Command[]) => cmds.reduce(reduce, s);
const invokeMock = invoke as unknown as ReturnType<typeof vi.fn>;

afterEach(() => {
  cleanup();
  invokeMock.mockReset();
  delete (window as any).__TAURI_INTERNALS__;
});

/** The frame's and the 1:1 patch's render requests in this state. */
async function asked(s: State): Promise<Record<string, unknown>[]> {
  (window as any).__TAURI_INTERNALS__ = {};
  invokeMock.mockReset();
  invokeMock.mockRejectedValue(new Error("no envelope in a test"));
  const { renderPreview, renderRoi } = await import("../bridge");
  await renderPreview(s).catch(() => null);
  await renderRoi(s, [0.1, 0.3, 0.8, 0.4]).catch(() => null);
  return invokeMock.mock.calls.filter((c) => c[0] === "render_preview").map((c) => c[1] as Record<string, unknown>);
}

const paramsIn = (req: Record<string, unknown>, id: string) =>
  (req.graph as { nodes: { id: string; params: Record<string, unknown> }[] }).nodes.find((n) => n.id === id)!.params;

const setShown = () => run(initialState(), { type: "add_color_set" }, { type: "toggle_cset_mask_view", n: 1 });
const layerShown = () => run(initialState(), { type: "add_layer", maskType: "range" }, { type: "toggle_mask_view" });

describe("the Depth mask switch and its Levels never put a mask eye down", () => {
  for (const [name, start, mask] of [
    ["a Color Set's eye", setShown, "cset1_mask"],
    ["a layer's eye", layerShown, "layer_1_mask"],
  ] as const) {
    for (const red of [false, true]) {
      it(`${name}, ${red ? "red" : "black and white"}: the frame follows the effective mask`, async () => {
        let s = start();
        if (red) s = run(s, { type: "toggle_mask_flavor" });
        expect(previewTarget(s)).toBe(mask);
        s = run(s, { type: "set_param", id: mask, param: "depth_on", value: 1 });
        expect(previewTarget(s)).toBe(mask);
        s = run(
          s,
          { type: "set_param", id: mask, param: "depth_black", value: 0.2 },
          { type: "set_param", id: mask, param: "depth_gamma", value: 1.5 },
          { type: "set_param", id: mask, param: "depth_invert", value: 1 },
        );
        expect(previewTarget(s)).toBe(mask);
        expect(maskViewOverriddenBy(s)).toBeNull();
        expect(maskOverlayWanted(s)).toBe(red);
        // Both renders ask for the mask node itself, carrying the Depth
        // mask: the product the adjustment consumes, in the one flavor.
        for (const req of await asked(s)) {
          expect(req).toMatchObject({ maskNode: mask, maskOverlay: red });
          expect(paramsIn(req, mask)).toMatchObject({ depth_on: true, depth_black: 0.2, depth_gamma: 1.5, depth_invert: true });
        }
        s = run(s, { type: "set_param", id: mask, param: "depth_on", value: 0 });
        expect(previewTarget(s)).toBe(mask);
      });
    }
  }

  it("a Finish layer's mask eye too", () => {
    let s = run(initialState(), { type: "set_panel_tab", tab: "layers" }, { type: "art_add_layer", kind: "paint" });
    const art = s.artActive!;
    s = run(s, { type: "art_add_mask", id: art, kind: "brush" }, { type: "toggle_mask_view" });
    const mask = `art_m_${art}`;
    expect(previewTarget(s)).toBe(mask);
    s = run(s, { type: "set_param", id: mask, param: "depth_on", value: 1 }, { type: "set_param", id: mask, param: "depth_white", value: 0.7 });
    expect(previewTarget(s)).toBe(mask);
    s = run(s, { type: "toggle_depth_view", mask });
    expect(s.maskView).toBe(true);
    expect(maskViewOverriddenBy(s)).toBe("View depth");
  });
});

describe("the block's depth eye and the mask eye", () => {
  it("a plain click on the set's depth eye while the set's eye is on keeps the eye on: View depth covers it, and says so", () => {
    let s = run(setShown(), { type: "set_param", id: "cset1_mask", param: "depth_on", value: 1 });
    s = run(s, { type: "toggle_depth_view", mask: "cset1_mask" });
    expect(s.csetMaskView).toBe(1);
    expect(previewTarget(s)).toBe("__depth__");
    expect(maskViewOverriddenBy(s)).toBe("View depth");
    s = run(s, { type: "toggle_depth_view", mask: "cset1_mask" });
    expect(s.csetMaskView).toBe(1);
    expect(previewTarget(s)).toBe("cset1_mask");
  });

  it("the modifier click shows the set's effective mask in red, one path: the set's own eye, not a second picture", async () => {
    let s = run(setShown(), { type: "set_param", id: "cset1_mask", param: "depth_on", value: 1 });
    expect(s.maskRed).toBe(false);
    s = run(s, { type: "toggle_depth_view", flavor: true, mask: "cset1_mask" });
    expect(s.csetMaskView).toBe(1);
    expect(s.depthView).toBe(false);
    expect(previewTarget(s)).toBe("cset1_mask");
    for (const req of await asked(s)) expect(req).toMatchObject({ maskNode: "cset1_mask", maskOverlay: true });
    s = run(s, { type: "toggle_depth_view", flavor: true, mask: "cset1_mask" });
    expect(s.csetMaskView).toBe(1);
    expect(s.maskRed).toBe(false);
  });

  it("a mask eye turned on takes the frame from View depth; View depth turned on after it covers it", () => {
    let s = run(initialState(), { type: "add_color_set" }, { type: "toggle_depth_view" });
    expect(previewTarget(s)).toBe("__depth__");
    s = run(s, { type: "toggle_cset_mask_view", n: 1 });
    expect(s.depthView).toBe(false);
    expect(previewTarget(s)).toBe("cset1_mask");
    s = run(s, { type: "toggle_depth_view" });
    expect(previewTarget(s)).toBe("__depth__");
    expect(s.csetMaskView).toBe(1);
    let l = run(initialState(), { type: "add_layer", maskType: "range" }, { type: "toggle_depth_view" }, { type: "toggle_mask_view" });
    expect(l.depthView).toBe(false);
    expect(previewTarget(l)).toBe("layer_1_mask");
    // Pressing the eye again is what puts it down.
    l = run(l, { type: "toggle_mask_view" });
    expect(previewTarget(l)).toBeNull();
  });

  it("in the Develop panel: the owner's Color Set, its eye stays pressed through the Depth mask switch and its depth eye", async () => {
    const user = userEvent.setup();
    render(<App />);
    await user.click(screen.getByTestId("add-color-set"));
    const eye = () => screen.getByTestId("mask-view-color-set-1");
    await user.click(eye());
    expect(eye()).toHaveAttribute("aria-pressed", "true");
    const block = () => screen.getByTestId("cset-depth-1");
    await user.click(within(block()).getByTestId("cset-depth-1-toggle"));
    expect(eye()).toHaveAttribute("aria-pressed", "true");
    expect(eye()).not.toHaveAttribute("data-overridden");
    const depthEye = () => within(block()).getByTestId("cset-depth-1-view");
    expect(depthEye().getAttribute("data-hint")).toMatch(/This set's range shows black\/white, depth mask applied/);
    fireEvent.click(depthEye());
    expect(eye()).toHaveAttribute("aria-pressed", "true");
    expect(eye()).toHaveAttribute("data-overridden", "true");
    expect(depthEye()).toHaveAttribute("aria-pressed", "true");
    expect(depthEye().getAttribute("data-hint")).toMatch(/over this set's range/);
    fireEvent.click(depthEye(), { altKey: true });
    expect(eye()).toHaveAttribute("aria-pressed", "true");
    expect(eye()).not.toHaveAttribute("data-overridden");
    expect(eye().getAttribute("aria-label")).toMatch(/red overlay/);
    expect(depthEye()).toHaveAttribute("aria-pressed", "false");
    await user.click(within(block()).getByTestId("cset-depth-1-toggle"));
    expect(eye()).toHaveAttribute("aria-pressed", "true");
  });
});
