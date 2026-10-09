// The Blend brush on pixel layers: the mask's SHIFT-blend lifted into
// color. "The blending modifier on masks was blending
// gray scale alpha masks. The blend tool on the toolbar will be
// blending RGB colors. That way I can use it to blend paint strokes
// on a pixel layer." The engine half (what a blend stroke does to
// pixels) is pinned in ops_masks.rs's a_rgb_blend_* tests; these pin
// the wiring: the button, the panel, and that the tool asks for
// nothing it does not need.

import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";

import { App } from "../app";
import { getEntries } from "../log";

/** The Finish tab with a pixel layer on it, ready to paint. */
async function finishWithLayer(user: ReturnType<typeof userEvent.setup>) {
  render(<App />);
  await user.click(screen.getByTestId("panel-tab-layers"));
  await user.click(screen.getByTestId("art-add-content"));
}

function paintStroke() {
  const brush = screen.getByTestId("brush-overlay");
  Object.defineProperty(brush, "clientWidth", { value: 400, configurable: true });
  Object.defineProperty(brush, "clientHeight", { value: 300, configurable: true });
  fireEvent.mouseDown(brush, { button: 0, clientX: 80, clientY: 80 });
  fireEvent.mouseMove(brush, { buttons: 1, clientX: 140, clientY: 140 });
  fireEvent.mouseUp(brush, { clientX: 140, clientY: 140 });
}

/** Blend is the blur button's other half now, reached from its menu.
 * "Next I would like combine Blur and Blend with the
 * default being Blur."*/
async function armBlend(user: ReturnType<typeof userEvent.setup>) {
  fireEvent.contextMenu(screen.getByTestId("art-tool-blur"));
  await user.click(screen.getByTestId("art-blur-option-blend"));
}

describe("the blend tool", () => {
  it("is the blur button's other half, rather than a slot of its own", async () => {
    // It was a separate button next to Blur; the owner folded the pair into
    // one slot. The blend entry's hint still says what it is FOR: taking the
    // step out between two paint strokes, in color.
    const user = userEvent.setup();
    await finishWithLayer(user);
    expect(screen.queryByTestId("art-tool-blend")).not.toBeInTheDocument();
    const btn = screen.getByTestId("art-tool-blur");
    expect(btn).toHaveAttribute("data-mode", "blur");
    fireEvent.contextMenu(btn);
    const blend = screen.getByTestId("art-blur-option-blend");
    expect(blend.getAttribute("data-hint") ?? "").toMatch(/seam|colors|average/i);
  });

  it("arms like any brush and gets the shared brush settings, but not blur's strength", async () => {
    // Blending has one question (how much of it lands), and the shared
    // opacity slider already asks it. A strength slider on top would be
    // a second answer to the same question.
    const user = userEvent.setup();
    await finishWithLayer(user);
    await armBlend(user);
    const btn = screen.getByTestId("art-tool-blur");
    expect(btn).toHaveAttribute("data-active", "true");
    expect(btn).toHaveAttribute("data-mode", "blend");
    expect(screen.getByTestId("brush-opacity")).toBeInTheDocument();
    expect(screen.queryByTestId("brush-blur-strength")).not.toBeInTheDocument();
    // And it disarms on a second click, like the rest.
    await user.click(btn);
    expect(btn).toHaveAttribute("data-active", "false");
  });

  it("paints without asking for a source the way clone and heal do", async () => {
    // Blend takes its material from what is already under the brush
    // (the picture and the layer's own strokes), so there is nothing to
    // pick and nothing to refuse.
    const user = userEvent.setup();
    await finishWithLayer(user);
    await armBlend(user);
    const before = getEntries().length;
    paintStroke();
    const added = getEntries().slice(before);
    expect(added.some((e) => /click somewhere first/i.test(e.message))).toBe(false);
  });

  it("never shows the crosshair, which is for picking a source it does not have", async () => {
    const user = userEvent.setup();
    await finishWithLayer(user);
    await armBlend(user);
    const brush = screen.getByTestId("brush-overlay");
    Object.defineProperty(brush, "clientWidth", { value: 400, configurable: true });
    Object.defineProperty(brush, "clientHeight", { value: 300, configurable: true });
    fireEvent.mouseMove(brush, { clientX: 100, clientY: 100 });
    fireEvent.keyDown(window, { key: "Alt", altKey: true });
    expect(brush.style.cursor).toBe("none");
    fireEvent.keyUp(window, { key: "Alt", altKey: false });
  });
});
