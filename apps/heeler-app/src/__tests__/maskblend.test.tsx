import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { BrushOverlay } from "../ui/overlays";
import type { Command } from "../state";

afterEach(cleanup);

function paint(mods: { shiftKey?: boolean; ctrlKey?: boolean; altKey?: boolean }, wash = true) {
  cleanup();
  const seen: Command[] = [];
  const node = { id: "m", type: "heeler.brush_mask", strokes: [] } as never;
  render(
    <BrushOverlay
      node={node}
      radius={0.1}
      dispatch={(c) => seen.push(c as Command)}
      tip="circle"
      flow={0.6}
      wash={wash ? { strength: 0.5 } : undefined}
    />,
  );
  const el = screen.getByTestId("brush-overlay");
  Object.defineProperty(el, "clientWidth", { value: 400, configurable: true });
  Object.defineProperty(el, "clientHeight", { value: 300, configurable: true });
  fireEvent.mouseDown(el, { button: 0, clientX: 100, clientY: 100, ...mods });
  fireEvent.mouseUp(el, { clientX: 100, clientY: 100, ...mods });
  const add = seen.find((c) => c.type === "add_stroke") as
    | { stroke?: { blend?: boolean; erase?: boolean } }
    | undefined;
  return add?.stroke ?? {};
}

describe("the blend modifier", () => {
  it("makes a blending stroke while SHIFT is held", () => {
    expect(paint({ shiftKey: true }).blend).toBe(true);
  });

  it("leaves CTRL alone, because the webview has already claimed it", () => {
    // CTRL was the first choice and is unusable: CTRL-click opens the
    // webview's own context menu, so trying the modifier got Reload and
    // Inspect Element rather than a stroke.
    expect(paint({ ctrlKey: true }).blend).toBeUndefined();
  });

  it("leaves an ordinary stroke alone", () => {
    const plain = paint({});
    expect(plain.blend).toBeUndefined();
    expect(plain.erase).toBeUndefined();
  });

  it("wins over erase when both modifiers are down", () => {
    // Blending and erasing are different answers to "change what is
    // here", and a stroke has to be one thing. Choosing silently is worse
    // than choosing badly, so it is chosen here and tested.
    const both = paint({ shiftKey: true, altKey: true });
    expect(both.blend).toBe(true);
    expect(both.erase).toBeUndefined();
  });

  it("stays out of the retouch tools, which have their own CTRL", () => {
    // Only the mask brush passes a wash, and only the mask has values to
    // blend. On a pixel layer CTRL means something else entirely.
    expect(paint({ shiftKey: true }, false).blend).toBeUndefined();
  });
});
