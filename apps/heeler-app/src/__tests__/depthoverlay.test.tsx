// 2026-09-29: "For depth mask previews, when we click it shows the black and
// white mask. Would be nice if when holding a modifier and you click it
// shows the red overlay like what masks on the Finish layers can do to
// review the mask over the image." Its mapping: white at 100 percent is 50
// percent red, 50 percent gray 25 percent. Then: "this is for any tool that
// uses depth map and has the depth map preview. the default red opacity (50%
// opacity and 100% white) should be something a user can define in
// preferences". The composite's mapping is proven on the desktop side
// (lib.rs, the_overlay_tints_by_the_mask_as_displayed_...); these prove the
// app asks for it.
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

import { invoke } from "@tauri-apps/api/core";
import { App } from "../app";
import { loadUiSettings, saveUiSettings } from "../bridge";
import { initialState } from "../data";
import { uiSettingsCommands, uiSettingsSnapshot } from "../settings";
import {
  DEFAULT_PREFS,
  graphHasNode,
  maskOverlayWanted,
  maskViewOverriddenBy,
  previewTarget,
  reduce,
  type Command,
  type State,
} from "../state";
import { Preferences } from "../ui/preferences";
import { DepthViewButton } from "../ui/smarttool";

const run = (s: State, ...cmds: Command[]) => cmds.reduce(reduce, s);
const invokeMock = invoke as unknown as ReturnType<typeof vi.fn>;

afterEach(() => {
  cleanup();
  invokeMock.mockReset();
  delete (window as any).__TAURI_INTERNALS__;
});

/** What the frame's render and the 1:1 patch's render ask the desktop
 * for, in this state. */
async function asked(s: State): Promise<{ frame: Record<string, unknown>; patch: Record<string, unknown> }> {
  (window as any).__TAURI_INTERNALS__ = {};
  invokeMock.mockReset();
  invokeMock.mockRejectedValue(new Error("no envelope in a test"));
  const { renderPreview, renderRoi } = await import("../bridge");
  await renderPreview(s).catch(() => null);
  await renderRoi(s, [0.1, 0.1, 0.2, 0.2]).catch(() => null);
  const calls = invokeMock.mock.calls.filter((c) => c[0] === "render_preview").map((c) => c[1] as Record<string, unknown>);
  expect(calls).toHaveLength(2);
  return { frame: calls[0], patch: calls[1] };
}

const withDepthLayer = () =>
  run(
    initialState(),
    { type: "add_layer", maskType: "range" },
    { type: "set_param", id: "layer_1_mask", param: "depth_on", value: 1 },
  );

describe("a depth tool's eye (Fog, Depth Lighting, DoF, Flare, Depth Map, Recolor, B&W)", () => {
  it("a plain click shows the depth map black and white", async () => {
    const s = run(initialState(), { type: "toggle_depth_view" });
    expect(previewTarget(s)).toBe("__depth__");
    expect(s.maskRed).toBe(false);
    const { frame, patch } = await asked(s);
    expect(frame).toMatchObject({ maskNode: "__depth__", maskOverlay: false });
    expect(patch).toMatchObject({ maskNode: "__depth__", maskOverlay: false });
  });

  it("the modifier click shows it as the red overlay at the Overlay strength and color", async () => {
    const s = run(initialState(), { type: "toggle_depth_view", flavor: true });
    expect(s.depthView).toBe(true);
    expect(s.maskRed).toBe(true);
    expect(maskOverlayWanted(s)).toBe(true);
    const { frame, patch } = await asked(s);
    expect(frame).toMatchObject({ maskNode: "__depth__", maskOverlay: true, maskOverlayOpacity: 0.5, maskOverlayColor: "red" });
    // The 1:1 patch carries the same strength and color as the frame
    // under it (it used to fall back to the desktop's own defaults).
    expect(patch).toMatchObject({ maskNode: "__depth__", maskOverlay: true, maskOverlayOpacity: 0.5, maskOverlayColor: "red" });
  });

  it("the flavor is the one app-wide flavor: the modifier again flips back, and a plain click keeps the flavor", () => {
    let s = run(initialState(), { type: "toggle_depth_view", flavor: true });
    s = run(s, { type: "toggle_depth_view", flavor: true });
    expect(s.depthView).toBe(true);
    expect(s.maskRed).toBe(false);
    s = run(s, { type: "toggle_mask_flavor" }, { type: "toggle_depth_view" }, { type: "toggle_depth_view" });
    expect(s.depthView).toBe(true);
    expect(maskOverlayWanted(s)).toBe(true);
  });

  it("the Map's Levels move under the overlay without putting it down", async () => {
    let s = run(initialState(), { type: "toggle_depth_view", flavor: true });
    const map = s.nodes.find((n) => n.type === "heeler.depth_map");
    expect(map).toBeDefined();
    s = run(s, { type: "set_param", id: map!.id, param: "depth_black", value: 0.3 });
    expect(maskOverlayWanted(s)).toBe(true);
    const { frame } = await asked(s);
    expect(frame).toMatchObject({ maskNode: "__depth__", maskOverlay: true });
  });

  it("the shared eye: click and modifier click, and the glyph and hint follow the flavor", async () => {
    const user = userEvent.setup();
    const onToggle = vi.fn();
    const { rerender } = render(<DepthViewButton depthView={false} onToggle={onToggle} testid="eye" />);
    const eye = screen.getByTestId("eye");
    expect(eye).toHaveAttribute("data-flavor", "bw");
    await user.click(eye);
    expect(onToggle).toHaveBeenLastCalledWith(false);
    fireEvent.click(eye, { altKey: true });
    expect(onToggle).toHaveBeenLastCalledWith(true);
    fireEvent.click(eye, { metaKey: true });
    expect(onToggle).toHaveBeenLastCalledWith(true);
    expect(eye.getAttribute("data-hint")).toMatch(/-click switches black\/white and the red overlay/);
    rerender(<DepthViewButton depthView={true} onToggle={onToggle} testid="eye" red={true} />);
    expect(screen.getByTestId("eye")).toHaveAttribute("data-flavor", "red");
    expect(screen.getByTestId("eye").getAttribute("data-hint")).toMatch(/red tint over the photograph/);
    for (const props of [{}, { mask: true }, { mask: true, maskShown: true }, { coversMask: true, depthView: true }]) {
      rerender(<DepthViewButton depthView={false} onToggle={onToggle} testid="eye" red={true} {...props} />);
      expect(screen.getByTestId("eye").getAttribute("data-hint")!.length).toBeLessThanOrEqual(165);
    }
  });
});

describe("a layer's Depth mask eye", () => {
  it("the modifier click shows THIS layer's mask, depth Levels applied, as the red overlay", async () => {
    const s = run(withDepthLayer(), { type: "toggle_depth_view", flavor: true, mask: "layer_1_mask" });
    expect(s.depthView).toBe(false);
    expect(s.maskRed).toBe(true);
    expect(previewTarget(s)).toBe("layer_1_mask");
    const { frame, patch } = await asked(s);
    expect(frame).toMatchObject({ maskNode: "layer_1_mask", maskOverlay: true, maskOverlayOpacity: 0.5 });
    expect(patch).toMatchObject({ maskNode: "layer_1_mask", maskOverlay: true, maskOverlayOpacity: 0.5 });
  });

  it("moving the depth Levels keeps the overlay up, and the render carries the new Levels", async () => {
    let s = run(withDepthLayer(), { type: "toggle_depth_view", flavor: true, mask: "layer_1_mask" });
    s = run(
      s,
      { type: "set_param", id: "layer_1_mask", param: "depth_black", value: 0.3 },
      { type: "set_param", id: "layer_1_mask", param: "depth_gamma", value: 1.6 },
      { type: "set_param", id: "layer_1_mask", param: "depth_invert", value: 1 },
    );
    expect(previewTarget(s)).toBe("layer_1_mask");
    expect(maskOverlayWanted(s)).toBe(true);
    const { frame } = await asked(s);
    expect(frame).toMatchObject({ maskNode: "layer_1_mask", maskOverlay: true });
    const graph = frame.graph as { nodes: { id: string; params: Record<string, unknown> }[] };
    expect(graph.nodes.find((n) => n.id === "layer_1_mask")!.params).toMatchObject({ depth_black: 0.3, depth_gamma: 1.6 });
  });

  it("a plain click still shows the depth map black and white, and never puts the layer's mask down", async () => {
    let s = run(withDepthLayer(), { type: "toggle_depth_view", mask: "layer_1_mask" });
    expect(previewTarget(s)).toBe("__depth__");
    expect((await asked(s)).frame).toMatchObject({ maskNode: "__depth__", maskOverlay: false });
    s = run(s, { type: "toggle_depth_view", mask: "layer_1_mask" });
    expect(s.depthView).toBe(false);
    s = run(s, { type: "toggle_depth_view", flavor: true, mask: "layer_1_mask" });
    expect(previewTarget(s)).toBe("layer_1_mask");
    // 2026-09-29: "turning on the depth mask (black and white) sometimes
    // caused the regular mask preview to turn off". The plain click is View
    // depth: it shows over the mask, the mask eye stays on and says so, and
    // the mask comes back when View depth goes.
    s = run(s, { type: "toggle_depth_view", mask: "layer_1_mask" });
    expect(s.maskView).toBe(true);
    expect(previewTarget(s)).toBe("__depth__");
    expect(maskViewOverriddenBy(s)).toBe("View depth");
    s = run(s, { type: "toggle_depth_view", mask: "layer_1_mask" });
    expect(s.maskView).toBe(true);
    expect(previewTarget(s)).toBe("layer_1_mask");
  });

  it("the modifier click shows the mask in red even when the flavor was black and white, and again turns it black and white, the eye staying on", () => {
    let s = run(withDepthLayer(), { type: "toggle_mask_view" });
    expect(s.maskRed).toBe(false);
    s = run(s, { type: "toggle_depth_view", flavor: true, mask: "layer_1_mask" });
    expect(s.maskRed).toBe(true);
    expect(previewTarget(s)).toBe("layer_1_mask");
    s = run(s, { type: "toggle_depth_view", flavor: true, mask: "layer_1_mask" });
    expect(s.maskRed).toBe(false);
    expect(s.maskView).toBe(true);
    expect(previewTarget(s)).toBe("layer_1_mask");
    // Red already the flavor, the mask down: the modifier click puts it
    // up in red (a flip would have shown it black and white).
    s = run(withDepthLayer(), { type: "toggle_mask_flavor" });
    expect(s.maskRed).toBe(true);
    s = run(s, { type: "toggle_depth_view", flavor: true, mask: "layer_1_mask" });
    expect(s.maskRed).toBe(true);
    expect(previewTarget(s)).toBe("layer_1_mask");
  });

  it("in the Develop panel: the modifier click turns the eye to the overlay glyph, a plain click to black and white", async () => {
    const user = userEvent.setup();
    render(<App />);
    await user.click(screen.getByTestId("add-layer-range"));
    const block = screen.getByTestId("mask-depth");
    await user.click(within(block).getByTestId("mask-depth-toggle"));
    const eye = () => within(screen.getByTestId("mask-depth")).getByTestId("mask-depth-view");
    expect(eye()).toHaveAttribute("data-flavor", "bw");
    expect(eye().getAttribute("data-hint")).toContain("-click shows this layer's mask in red");
    fireEvent.click(eye(), { altKey: true });
    expect(eye()).toHaveAttribute("data-flavor", "red");
    // One path: the modifier click shows the layer's mask through the
    // layer's own mask eye, which is the eye that lights; the depth eye
    // is View depth and stays up only for that.
    expect(eye()).toHaveAttribute("aria-pressed", "false");
    expect(eye().getAttribute("data-hint")).toMatch(/This layer's mask shows in red/);
    // The layer mask eye tells the same flavor: one flavor, app-wide.
    expect(screen.getByTestId("mask-view-toggle").getAttribute("aria-label")).toMatch(/red overlay/);
    fireEvent.click(eye());
    expect(eye()).toHaveAttribute("aria-pressed", "true");
    expect(eye().getAttribute("data-hint")).toMatch(/over this layer's mask/);
    fireEvent.click(eye());
    expect(eye()).toHaveAttribute("aria-pressed", "false");
    fireEvent.click(eye(), { altKey: true });
    expect(eye()).toHaveAttribute("data-flavor", "bw");
  });

  it("a Finish layer's depth eye does the same with its mask", async () => {
    const user = userEvent.setup();
    render(<App />);
    await user.click(screen.getByTestId("panel-tab-layers"));
    await user.click(screen.getByTestId("art-add-content"));
    await user.click(screen.getByTestId("art-depth-art_b1-toggle"));
    const eye = () => screen.getByTestId("art-depth-art_b1-view");
    expect(eye().getAttribute("data-hint")).toContain("-click shows this layer's mask in red");
    fireEvent.click(eye(), { metaKey: true });
    expect(eye().getAttribute("data-hint")).toMatch(/This layer's mask shows in red/);
  });

  it("a Finish layer's mask and a Color Set's range take the modifier click the same way", () => {
    let s = run(initialState(), { type: "set_panel_tab", tab: "layers" }, { type: "art_add_layer", kind: "paint" });
    const art = s.artActive!;
    expect(art).toBeTruthy();
    s = run(s, { type: "art_add_mask", id: art, kind: "brush" });
    const mask = `art_m_${art}`;
    expect(graphHasNode(s.nodes, mask)).toBe(true);
    const shown = run(s, { type: "toggle_depth_view", flavor: true, mask });
    expect(previewTarget(shown)).toBe(mask);
    expect(maskOverlayWanted(shown)).toBe(true);
    let c = run(initialState(), { type: "add_color_set" });
    const set = c.nodes.find((n) => /^cset\d+_mask$/.test(n.id));
    expect(set).toBeDefined();
    c = run(c, { type: "toggle_depth_view", flavor: true, mask: set!.id });
    expect(previewTarget(c)).toBe(set!.id);
    expect(maskOverlayWanted(c)).toBe(true);
    c = run(c, { type: "toggle_depth_view", mask: set!.id });
    expect(c.csetMaskView).not.toBeNull();
    expect(previewTarget(c)).toBe("__depth__");
    expect(maskViewOverriddenBy(c)).toBe("View depth");
  });
});

describe("the overlay opacity preference", () => {
  it("defaults to 50 percent, and every overlay's strength starts there", () => {
    expect(DEFAULT_PREFS.maskOverlayOpacity).toBe(50);
    expect(initialState().brushOverlayStrength).toBe(0.5);
  });

  it("drives the render's maskOverlayOpacity for the depth view and a layer's mask alike", async () => {
    let s = run(initialState(), { type: "set_prefs", prefs: { maskOverlayOpacity: 80 } });
    expect(s.brushOverlayStrength).toBeCloseTo(0.8);
    const depth = run(s, { type: "toggle_depth_view", flavor: true });
    const d = await asked(depth);
    expect(d.frame.maskOverlayOpacity).toBeCloseTo(0.8);
    expect(d.patch.maskOverlayOpacity).toBeCloseTo(0.8);
    s = run(s, { type: "add_layer", maskType: "radial" }, { type: "toggle_mask_flavor" }, { type: "toggle_mask_view" });
    expect((await asked(s)).frame.maskOverlayOpacity).toBeCloseTo(0.8);
    // The brush panel's slider moves it for the session, over the
    // whole range now that the preference can ask for any of it.
    s = run(s, { type: "set_brush_overlay_strength", strength: 1 });
    expect((await asked(s)).frame.maskOverlayOpacity).toBe(1);
    expect(s.prefs.maskOverlayOpacity).toBe(80);
  });

  it("survives a relaunch through the app settings, and repairs a hand-edited value", async () => {
    const changed = reduce(initialState(), { type: "set_prefs", prefs: { maskOverlayOpacity: 35 } });
    await saveUiSettings(JSON.stringify(uiSettingsSnapshot(changed)));
    let restored = initialState();
    for (const command of uiSettingsCommands(await loadUiSettings())) restored = reduce(restored, command);
    expect(restored.prefs.maskOverlayOpacity).toBe(35);
    expect(restored.brushOverlayStrength).toBeCloseTo(0.35);
    let repaired = initialState();
    for (const command of uiSettingsCommands(JSON.stringify({ prefs: { maskOverlayOpacity: 140 } }))) repaired = reduce(repaired, command);
    expect(repaired.prefs.maskOverlayOpacity).toBe(100);
    repaired = initialState();
    for (const command of uiSettingsCommands(JSON.stringify({ prefs: { maskOverlayOpacity: "lots" } }))) repaired = reduce(repaired, command);
    expect(repaired.prefs.maskOverlayOpacity).toBe(50);
  });

  it("sits beside the overlay color in Preferences", () => {
    const sent: Command[] = [];
    const state = reduce(initialState(), { type: "open_prefs" });
    render(<Preferences state={state} dispatch={((c: Command) => sent.push(c)) as never} />);
    fireEvent.click(screen.getByTestId("prefs-tab-brush"));
    expect(screen.getByTestId("prefs-mask-color")).toHaveAttribute("data-value", "red");
    const slider = screen.getByTestId("prefs-mask-overlay-opacity");
    expect(slider.getAttribute("aria-valuenow")).toBe("50");
    const field = screen.getByTestId("prefs-mask-overlay-opacity-value");
    fireEvent.change(field, { target: { value: "70" } });
    fireEvent.blur(field);
    expect(sent).toContainEqual({ type: "set_prefs", prefs: { maskOverlayOpacity: 70 } });
  });
});
