// The select tool's overlay contract: modifier gestures, the pen's
// Escape, and whose photograph a late Region Select answer lands on.

import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Command } from "../state";
import { regionSelect } from "../bridge";
import { SelectionAnts, SelectionOverlay } from "../ui/selection";

// Region Select's segmentation round trip, held open so a test can
// switch the photograph while the answer is in flight. Everything else
// in the bridge is the real module.
let regionHold: { resolve: (v: Uint8Array) => void } | null = null;
vi.mock("../bridge", async (importOriginal) => {
  const real = await importOriginal<typeof import("../bridge")>();
  return {
    ...real,
    regionSelect: vi.fn((imageId: string, x: number, y: number, tolerance: number) => {
      if (regionHold) return new Promise<Uint8Array>((res) => { regionHold!.resolve = res; });
      return real.regionSelect(imageId, x, y, tolerance);
    }),
  };
});

afterEach(() => {
  regionHold = null;
  cleanup();
});

function mountOverlay(method: string, imageId = "img1") {
  const sent: Command[] = [];
  const node = { id: "sel", type: "heeler.selection_mask", params: {}, regions: [] } as never;
  const props = {
    node,
    dispatch: (c: Command) => sent.push(c),
    method,
    op: "replace" as const,
    tolerance: 0.4,
    smooth: 0,
    imageId,
  };
  const view = render(React.createElement(SelectionOverlay, props));
  const overlay = view.getByTestId("selection-overlay");
  Object.defineProperty(overlay, "clientWidth", { value: 200, configurable: true });
  Object.defineProperty(overlay, "clientHeight", { value: 200, configurable: true });
  overlay.getBoundingClientRect = () =>
    ({ left: 0, top: 0, width: 200, height: 200, right: 200, bottom: 200 }) as DOMRect;
  const rerender = (nextImageId: string) =>
    view.rerender(React.createElement(SelectionOverlay, { ...props, imageId: nextImageId }));
  return { view, overlay, sent, rerender };
}

describe("the marquee modifier", () => {
  // The methods' shared hint: "Drag a rectangle; SHIFT keeps it square".
  it("SHIFT held during the drag keeps a rectangle square", async () => {
    const { overlay, sent } = mountOverlay("rect");
    fireEvent.mouseDown(overlay, { button: 0, clientX: 50, clientY: 50 });
    fireEvent.mouseMove(overlay, { buttons: 1, clientX: 90, clientY: 130 });
    fireEvent.mouseMove(overlay, { buttons: 1, clientX: 90, clientY: 130, shiftKey: true });
    fireEvent.mouseUp(overlay, { clientX: 90, clientY: 130, shiftKey: true });
    await waitFor(() => expect(sent.some((c) => c.type === "add_region")).toBe(true));
    const region = (sent.find((c) => c.type === "add_region") as never as {
      region: { kind: string; x1: number; y1: number };
    }).region;
    expect(region.kind).toBe("marquee");
    // From (0.25, 0.25) toward (0.45, 0.65): squared, the longer side
    // wins and both ends land at 0.65.
    expect(region.x1).toBeCloseTo(0.65, 2);
    expect(region.y1).toBeCloseTo(0.65, 2);
  });
});

describe("the pen's Escape", () => {
  it("abandons the path in progress and swallows the key, so the tool stays in hand", async () => {
    const { overlay, view } = mountOverlay("pen");
    fireEvent.mouseDown(overlay, { button: 0, clientX: 60, clientY: 60 });
    fireEvent.mouseUp(overlay, { clientX: 60, clientY: 60 });
    fireEvent.mouseDown(overlay, { button: 0, clientX: 140, clientY: 60 });
    fireEvent.mouseUp(overlay, { clientX: 140, clientY: 60 });
    await waitFor(() => expect(view.getByTestId("pen-anchor-1")).toBeTruthy());

    // The app's own Escape (window keydown -> tool.cancel) honors
    // defaultPrevented. The pen eats the key when it has a path to drop:
    // the path goes, the select tool stays armed.
    let preventedAtBubble: boolean | null = null;
    const probe = (e: Event) => { preventedAtBubble = (e as KeyboardEvent).defaultPrevented; };
    window.addEventListener("keydown", probe);
    fireEvent.keyDown(window, { key: "Escape" });
    window.removeEventListener("keydown", probe);

    await waitFor(() => expect(view.queryByTestId("pen-anchor-1")).toBeNull());
    expect(preventedAtBubble).toBe(true);
  });

  it("with no path in progress it leaves Escape alone for the tool", async () => {
    mountOverlay("pen");
    let preventedAtBubble: boolean | null = null;
    const probe = (e: Event) => { preventedAtBubble = (e as KeyboardEvent).defaultPrevented; };
    window.addEventListener("keydown", probe);
    fireEvent.keyDown(window, { key: "Escape" });
    window.removeEventListener("keydown", probe);
    expect(preventedAtBubble).toBe(false);
  });
});

// An answer grid with a filled block in the middle: a full grid has no
// boundary at all, so the trace would find nothing to dispatch.
function blobGrid(): Uint8Array {
  const g = new Uint8Array(224 * 224);
  for (let y = 64; y < 160; y++)
    for (let x = 64; x < 160; x++) g[y * 224 + x] = 255;
  return g;
}

describe("a late Region Select answer", () => {
  const regionMock = () => vi.mocked(regionSelect);

  it("never lands on another photograph", async () => {
    const { overlay, sent, rerender } = mountOverlay("region", "img1");
    regionHold = { resolve: () => {} };
    fireEvent.mouseDown(overlay, { button: 0, clientX: 100, clientY: 100 });
    fireEvent.mouseUp(overlay, { clientX: 100, clientY: 100 });
    // The component reaches the bridge through a dynamic import; wait
    // for the call to actually arrive before answering it.
    await waitFor(() => expect(regionMock()).toHaveBeenCalled());

    // The answer is still flying when the user moves to another
    // photograph: the overlay stays mounted (the tool is still armed),
    // only its imageId prop moved on.
    rerender("img2");
    regionHold!.resolve(blobGrid());
    // A beat for the .then chain.
    await new Promise((r) => setTimeout(r, 50));
    expect(sent.some((c) => c.type === "add_region")).toBe(false);
  });

  it("lands when the photograph never changed", async () => {
    const { overlay, sent } = mountOverlay("region", "img1");
    regionHold = { resolve: () => {} };
    fireEvent.mouseDown(overlay, { button: 0, clientX: 100, clientY: 100 });
    fireEvent.mouseUp(overlay, { clientX: 100, clientY: 100 });
    await waitFor(() => expect(regionMock()).toHaveBeenCalled());
    regionHold!.resolve(blobGrid());
    await waitFor(() => expect(sent.some((c) => c.type === "add_region")).toBe(true));
  });
});

describe("the frame read", () => {
  // Every selection on the viewer wears its own ants and they all read
  // the same photograph: the decode is cached by src, so three sets of
  // ants cost one decode, not three.
  it("is shared between the ants on one photograph", async () => {
    let constructed = 0;
    class FakeImage {
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      naturalWidth = 8;
      naturalHeight = 8;
      set src(_v: string) {
        constructed++;
        queueMicrotask(() => this.onload?.());
      }
    }
    vi.stubGlobal("Image", FakeImage);
    try {
      const antNode = (id: string) =>
        ({ id, type: "heeler.selection_mask", params: {}, regions: [] }) as never;
      const src = "data:image/png;base64,shared-frame";
      render(
        <>
          <SelectionAnts node={antNode("sel")} frame={src} />
          <SelectionAnts node={antNode("sel2")} frame={src} />
          <SelectionAnts node={antNode("sel3")} frame={src} />
        </>,
      );
      await waitFor(() => expect(constructed).toBeGreaterThan(0));
      expect(constructed).toBe(1);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
