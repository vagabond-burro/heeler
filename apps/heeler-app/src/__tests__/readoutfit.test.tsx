// The viewer header's cursor readout against the Take menu.
//
// Found while screenshotting the browser build: with the pointer over
// the photograph, the X/Y readout ran under the Take menu. It floated
// over the bar, centered, so nothing kept it out of the controls once
// the bar got short (150% app zoom on a narrow window, a five-digit
// photograph). It now sits in an in-flow slot between the tools and the
// Take menu and is fitted into it (cursorreadout.ts).
//
// jsdom lays nothing out, so the widths here are the test's own: every
// offset the fit reads is stood in for, and restored afterwards.

import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { App } from "../app";
import { READOUT_GAP } from "../ui/cursorreadout";

type Layout = { widths: Record<string, number>; lefts: Record<string, number> };

const keyOf = (el: HTMLElement) =>
  el.dataset.testid ?? (el.dataset.readoutPart ? `part:${el.dataset.readoutPart}` : "");

let restore: (() => void)[] = [];

/** Stands in for layout: offsetWidth and offsetLeft by test id (or
 * readout part), zero for anything hidden or not named. */
function fakeLayout(layout: Layout) {
  const proto = HTMLElement.prototype;
  const priorW = Object.getOwnPropertyDescriptor(proto, "offsetWidth");
  const priorL = Object.getOwnPropertyDescriptor(proto, "offsetLeft");
  const priorP = Object.getOwnPropertyDescriptor(proto, "offsetParent");
  Object.defineProperty(proto, "offsetWidth", {
    configurable: true,
    get(this: HTMLElement) {
      if (this.style.display === "none") return 0;
      return layout.widths[keyOf(this)] ?? 0;
    },
  });
  Object.defineProperty(proto, "offsetLeft", {
    configurable: true,
    get(this: HTMLElement) {
      return layout.lefts[keyOf(this)] ?? 0;
    },
  });
  // The header is the bar every offset above is measured in.
  Object.defineProperty(proto, "offsetParent", {
    configurable: true,
    get(this: HTMLElement) {
      return this.closest('[data-testid="viewer-header"]') === this ? null : this.closest('[data-testid="viewer-header"]');
    },
  });
  restore.push(() => {
    if (priorW) Object.defineProperty(proto, "offsetWidth", priorW);
    if (priorL) Object.defineProperty(proto, "offsetLeft", priorL);
    if (priorP) Object.defineProperty(proto, "offsetParent", priorP);
  });
}

/** A 12346 x 12346 photograph whose frame decodes onto a canvas that
 * answers every pixel read with `pixel.rgb`, which the test may change
 * between moves. */
function fakeFrame(pixel: { rgb: number[] }) {
  const naturalW = Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, "naturalWidth");
  const naturalH = Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, "naturalHeight");
  Object.defineProperty(HTMLImageElement.prototype, "naturalWidth", { get: () => 12346, configurable: true });
  Object.defineProperty(HTMLImageElement.prototype, "naturalHeight", { get: () => 12346, configurable: true });
  const priorImage = globalThis.Image;
  const priorContext = HTMLCanvasElement.prototype.getContext;
  class LoadedImage {
    naturalWidth = 12346;
    naturalHeight = 12346;
    onload: null | (() => void) = null;
    set src(_: string) {
      queueMicrotask(() => this.onload?.());
    }
  }
  globalThis.Image = LoadedImage as unknown as typeof Image;
  HTMLCanvasElement.prototype.getContext = (() =>
    new Proxy({}, {
      get: (_, key) =>
        key === "getImageData"
          ? () => ({ data: new Uint8ClampedArray([...pixel.rgb, 255]) })
          : () => ({ data: new Uint8ClampedArray(4), width: 1, height: 1 }),
    })) as unknown as typeof HTMLCanvasElement.prototype.getContext;
  restore.push(() => {
    globalThis.Image = priorImage;
    HTMLCanvasElement.prototype.getContext = priorContext;
    if (naturalW) Object.defineProperty(HTMLImageElement.prototype, "naturalWidth", naturalW);
    if (naturalH) Object.defineProperty(HTMLImageElement.prototype, "naturalHeight", naturalH);
  });
}

async function hover() {
  render(<App />);
  fireEvent.load(screen.getByTestId("viewer-image"));
  await act(async () => {});
  fireEvent.mouseMove(screen.getByTestId("stage-frame"), { clientX: 0, clientY: 0 });
}

/** The readout's painted extent in the bar: the box's left inside its
 * slot, plus the widths of whatever it still shows, one gap apart. */
function readoutExtent(layout: Layout) {
  const box = screen.getByTestId("cursor-readout-box");
  const shown = [screen.getByTestId("cursor-swatch"), ...box.querySelectorAll<HTMLElement>("[data-readout-part]")]
    .filter((el) => el.style.display !== "none")
    .map((el) => layout.widths[keyOf(el)] ?? 0)
    .filter((w) => w > 0);
  const width = shown.reduce((a, b) => a + b, 0) + READOUT_GAP * Math.max(0, shown.length - 1);
  const left = layout.lefts["cursor-readout-slot"] + Number.parseFloat(box.style.left);
  return { left, right: left + width };
}

const parts = (box: HTMLElement) =>
  [...box.querySelectorAll<HTMLElement>("[data-readout-part]")]
    .filter((el) => el.style.display !== "none")
    .map((el) => el.dataset.readoutPart);

beforeEach(() => {
  restore = [];
});
afterEach(() => {
  for (const undo of restore.reverse()) undo();
});

describe("the header readout and the Take menu", () => {
  it("the readout reserves a fixed width of tabular digits, whatever the values", async () => {
    const layout: Layout = {
      widths: { "viewer-header": 900, "cursor-readout-slot": 400, "cursor-swatch": 14, "part:pos": 110, "part:rgb": 95, "part:luma": 45 },
      lefts: { "cursor-readout-slot": 180 },
    };
    fakeLayout(layout);
    const pixel = { rgb: [200, 9, 6] };
    fakeFrame(pixel);
    await hover();
    const readout = screen.getByTestId("cursor-readout");
    expect(readout.classList.contains("tnum")).toBe(true);
    const slots = [...readout.querySelectorAll<HTMLElement>("[data-readout-slot]")];
    // Five digits for a position on a 12346-pixel photograph, three for
    // each channel and for luma: sized by the largest value, not this one.
    expect(slots.map((el) => el.style.width)).toEqual(["5ch", "5ch", "3ch", "3ch", "3ch", "3ch"]);
    expect(slots.map((el) => el.textContent)).toEqual(["6173", "6173", "200", "9", "6", "19"]);
    const left = screen.getByTestId("cursor-readout-box").style.left;
    // A second pixel with values of other lengths: the same slots, the
    // same widths, the box where it was.
    pixel.rgb = [7, 255, 30];
    fireEvent.mouseMove(screen.getByTestId("stage-frame"), { clientX: 0, clientY: 0 });
    const again = [...readout.querySelectorAll<HTMLElement>("[data-readout-slot]")];
    expect(again).toEqual(slots);
    expect(again.map((el) => el.textContent)).toEqual(["6173", "6173", "7", "255", "30", "73"]);
    expect(again.map((el) => el.style.width)).toEqual(["5ch", "5ch", "3ch", "3ch", "3ch", "3ch"]);
    expect(screen.getByTestId("cursor-readout-box").style.left).toBe(left);
  });

  it("with room, the whole readout shows, centered on the bar", async () => {
    const layout: Layout = {
      widths: { "viewer-header": 900, "cursor-readout-slot": 520, "cursor-swatch": 14, "part:pos": 110, "part:rgb": 95, "part:luma": 45 },
      lefts: { "cursor-readout-slot": 180 },
    };
    fakeLayout(layout);
    fakeFrame({ rgb: [200, 9, 6] });
    await hover();
    expect(parts(screen.getByTestId("cursor-readout-box"))).toEqual(["pos", "rgb", "luma"]);
    const { left, right } = readoutExtent(layout);
    expect((left + right) / 2).toBe(450);
  });

  it("at a narrow header the readout drops whole parts and never reaches the Take menu", async () => {
    // Tools end at 166, the Take menu starts at 314 (14 past the slot's
    // right edge), and the slot between them is 120 wide: the readout
    // at its longest (288) cannot fit whole.
    const layout: Layout = {
      widths: { "viewer-header": 500, "cursor-readout-slot": 120, "btn-split": 16, "takes-menu": 110, "cursor-swatch": 14, "part:pos": 110, "part:rgb": 95, "part:luma": 45 },
      lefts: { "cursor-readout-slot": 180, "btn-split": 150, "takes-menu": 314 },
    };
    fakeLayout(layout);
    fakeFrame({ rgb: [255, 255, 255] });
    await hover();
    const box = screen.getByTestId("cursor-readout-box");
    // Luma goes first, then the position; the swatch and RGB stay.
    expect(parts(box)).toEqual(["rgb"]);
    expect(box.dataset.dropped).toBe("pos luma");
    expect(screen.getByTestId("cursor-swatch").style.display).toBe("block");
    const { left, right } = readoutExtent(layout);
    const toolsEnd = layout.lefts["btn-split"] + layout.widths["btn-split"];
    const takesStart = layout.lefts["takes-menu"];
    expect(left).toBeGreaterThanOrEqual(toolsEnd);
    expect(right).toBeLessThanOrEqual(takesStart);
    // The Take menu and the zoom pair sit after the slot in the bar's
    // own flow, whole, never under a box floated over them.
    const slot = screen.getByTestId("cursor-readout-slot");
    expect(slot.compareDocumentPosition(screen.getByTestId("takes-menu")) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(slot.compareDocumentPosition(screen.getByTestId("btn-split")) & Node.DOCUMENT_POSITION_PRECEDING).toBeTruthy();
    expect(slot.contains(screen.getByTestId("takes-menu"))).toBe(false);
  });

  it("when not even the swatch fits, the readout hides rather than overlapping", async () => {
    const layout: Layout = {
      widths: { "viewer-header": 300, "cursor-readout-slot": 10, "cursor-swatch": 14, "part:pos": 110, "part:rgb": 95, "part:luma": 45 },
      lefts: { "cursor-readout-slot": 180 },
    };
    fakeLayout(layout);
    fakeFrame({ rgb: [255, 255, 255] });
    await hover();
    const box = screen.getByTestId("cursor-readout-box");
    expect(parts(box)).toEqual([]);
    expect(box.style.visibility).toBe("hidden");
  });
});
