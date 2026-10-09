// A drag on the canvas follows the pointer off it (2026-10-08: "When
// dragging an interactive selection outside of the canvas space ends the
// selection, this is not how other programs work. They allow you to drag
// outside the canvas, its good for making sure you're capturing all the
// extents"). Every canvas drag ended where the pointer left the overlay;
// these pin, for each, that leaving ends nothing, that moves outside
// still drive the drag, and that the release outside ends it once. The
// marquee and lasso are in selection.test.tsx, the Polish brush in
// polish.test.tsx. The Transform and Warp handles joined them with the
// 26.4.3 full review's R4: a layer can be dragged past the frame, which
// is an ordinary thing to do to a layer, and the drag ended there.

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { Command } from "../state";
import { BrushOverlay, CropOverlay, LinearOverlay, RadialOverlay, StraightenOverlay, TransformOverlay } from "../ui/overlays";

afterEach(() => cleanup());

/** A 400 by 300 box at the origin, so pointer pixels mean something. */
function sized(el: HTMLElement, w = 400, h = 300) {
  Object.defineProperty(el, "clientWidth", { value: w, configurable: true });
  Object.defineProperty(el, "clientHeight", { value: h, configurable: true });
  Object.defineProperty(el, "offsetWidth", { value: w, configurable: true });
  Object.defineProperty(el, "offsetHeight", { value: h, configurable: true });
  el.getBoundingClientRect = () =>
    ({ left: 0, top: 0, right: w, bottom: h, width: w, height: h, x: 0, y: 0, toJSON() {} }) as DOMRect;
}

/** Press inside, wander out past the right and bottom edges, leave. */
function outside(el: Element, press: [number, number], out: [number, number]) {
  fireEvent.mouseDown(el, { button: 0, buttons: 1, clientX: press[0], clientY: press[1] });
  fireEvent.mouseMove(el, { buttons: 1, clientX: press[0] + 10, clientY: press[1] + 10 });
  fireEvent.mouseLeave(el, { buttons: 1, clientX: 401, clientY: press[1] });
  fireEvent.mouseMove(window, { buttons: 1, clientX: out[0], clientY: out[1] });
}

const ends = (sent: Command[]) => sent.filter((c) => c.type === "end_gesture").length;

describe("a canvas drag follows the pointer off the canvas", () => {
  it("the brush keeps painting outside, where the brush really is, and lands one stroke at the release", () => {
    const strokes: { points: [number, number][] }[] = [];
    const node = { id: "b", type: "heeler.brush_mask", strokes: [] } as never;
    render(<BrushOverlay node={node} radius={0.05} dispatch={() => {}} onStroke={(s) => strokes.push(s as never)} />);
    const el = screen.getByTestId("brush-overlay");
    sized(el);
    outside(el, [100, 100], [500, 200]);
    expect(strokes, "leaving ends nothing").toEqual([]);
    fireEvent.mouseMove(window, { buttons: 1, clientX: 5000, clientY: 200 });
    fireEvent.mouseUp(window, { clientX: 5000, clientY: 200 });
    expect(strokes).toHaveLength(1);
    const xs = strokes[0].points.map((p) => p[0]);
    expect(xs).toContain(1.25);
    expect(Math.max(...xs), "held within half a picture of the edge").toBe(1.5);
    fireEvent.mouseMove(window, { buttons: 1, clientX: 50, clientY: 50 });
    expect(strokes, "the drag is over").toHaveLength(1);
  });

  it("a crop corner dragged past the picture holds at its edge, and the drag ends at the release", () => {
    const sent: Command[] = [];
    const node = { id: "crop", type: "heeler.crop_rotate", params: { crop_x: 0.1, crop_y: 0.1, crop_w: 0.5, crop_h: 0.5 } } as never;
    render(<CropOverlay node={node} dispatch={(c) => sent.push(c)} />);
    sized(screen.getByTestId("crop-overlay"));
    outside(screen.getByTestId("crop-handle-br"), [240, 180], [700, 600]);
    expect(ends(sent), "leaving ends nothing").toBe(0);
    const last = [...sent].reverse().find((c) => c.type === "set_params") as Extract<Command, { type: "set_params" }>;
    expect(last.values.crop_w! + last.values.crop_x!).toBeCloseTo(1, 9);
    expect(last.values.crop_h! + last.values.crop_y!).toBeCloseTo(1, 9);
    fireEvent.mouseUp(window);
    expect(ends(sent)).toBe(1);
  });

  it("the straighten line keeps its far end outside the canvas", () => {
    const sent: Command[] = [];
    const node = { id: "crop", type: "heeler.crop_rotate", params: { angle: 0 } } as never;
    render(<StraightenOverlay node={node} dispatch={(c) => sent.push(c)} />);
    const el = screen.getByTestId("straighten-overlay");
    sized(el);
    outside(el, [100, 100], [900, 140]);
    expect(sent, "leaving ends nothing").toEqual([]);
    fireEvent.mouseUp(window);
    const set = sent.find((c) => c.type === "set_param") as Extract<Command, { type: "set_param" }>;
    // A line from (100, 100) to (900, 140): about 2.9 degrees off level,
    // read from the end outside the canvas, not from where it left.
    expect(Math.abs(set.value)).toBeCloseTo((Math.atan2(40, 800) * 180) / Math.PI, 1);
  });

  it.each([
    ["linear", LinearOverlay, { position: 0.5, span: 0.4, angle: 0 }],
    ["radial", RadialOverlay, { center_x: 0.5, center_y: 0.5, radius_x: 0.2, radius_y: 0.2, feather: 0.3 }],
  ] as const)("the %s gradient's handle keeps moving outside, and its gesture ends at the release", (name, Overlay, params) => {
    const sent: Command[] = [];
    const node = { id: "g", type: `heeler.${name}_mask`, params } as never;
    render(<Overlay node={node} dispatch={(c) => sent.push(c)} />);
    const el = screen.getByTestId(`${name}-overlay`);
    sized(el);
    outside(el, [200, 150], [700, 150]);
    expect(ends(sent), "leaving ends nothing").toBe(0);
    const moves = sent.filter((c) => c.type === "set_params").length;
    fireEvent.mouseMove(window, { buttons: 1, clientX: 800, clientY: 200 });
    expect(sent.filter((c) => c.type === "set_params").length, "a move outside still drives the drag").toBeGreaterThan(moves);
    fireEvent.mouseUp(window);
    expect(ends(sent)).toBe(1);
  });

  for (const mode of ["transform", "warp"] as const) {
    it(`a ${mode} drag carries a layer past the frame and commits once at the release`, async () => {
      const sent: Command[] = [];
      const quad: [number, number][] = [[0.2, 0.2], [0.6, 0.2], [0.6, 0.6], [0.2, 0.6]];
      render(<TransformOverlay blendId="art_b1" box={{ x: 0.2, y: 0.2, w: 0.4, h: 0.4 }} quad={quad} mode={mode} dispatch={(c) => sent.push(c)} />);
      const el = screen.getByTestId(`transform-overlay-${mode}`);
      sized(el);
      // Transform moves the body; Warp pulls its far corner.
      const handle = screen.getByTestId(mode === "transform" ? "transform-body" : "transform-handle-2");
      outside(handle, mode === "transform" ? [160, 120] : [240, 180], [560, 420]);
      await new Promise((r) => requestAnimationFrame(() => r(null)));
      expect(ends(sent), "leaving ends nothing").toBe(0);
      const last = [...sent].reverse().find((c) => c.type === "art_set_quad") as { corners: [number, number][] } | undefined;
      expect(last, "a move outside still drives the drag").toBeDefined();
      expect(Math.max(...last!.corners.map((c) => c[0])), "the layer goes past the frame").toBeGreaterThan(1);
      fireEvent.mouseUp(window, { clientX: 560, clientY: 420 });
      expect(ends(sent)).toBe(1);
      fireEvent.mouseMove(window, { buttons: 1, clientX: 50, clientY: 50 });
      fireEvent.mouseUp(window);
      expect(ends(sent), "the drag is over").toBe(1);
    });
  }
});
