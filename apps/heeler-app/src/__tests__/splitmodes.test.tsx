// The Split tool's three carvings (the owner's "Advanced split
// views"): the geometry that cuts the frame, the reducer that keeps
// every field renderable, and the header seat plus in-frame
// furniture for each mode. The classic split must remain exactly the
// zero case.
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { App } from "../app";
import * as bridge from "../bridge";
import { initialState } from "../data";
import { compareLabels, reduce } from "../state";
import { Viewer } from "../ui/viewer";
import { choose, menuValue } from "./menuhelp";
import {
  bearing,
  gridMask,
  lineClip,
  linePoint,
  posOnAxis,
  radialMask,
  snapDeg,
} from "../ui/splitview";

describe("split geometry", () => {
  const dims = { w: 100, h: 50 };

  it("the unrotated line is the classic inset, both ways round", () => {
    // The original split clipped with inset(0 0 0 P%); angle 0 must
    // produce byte-for-byte the same family or the old behavior (and
    // its tests) silently changed.
    expect(lineClip(0, 0.25, false, dims)).toBe("inset(0 0 0 25%)");
    expect(lineClip(0, 0.25, true, dims)).toBe("inset(0 75% 0 0)");
  });

  it("a 90 degree bar splits top from bottom", () => {
    expect(lineClip(90, 0.5, false, { w: 100, h: 100 })).toBe(
      "polygon(100.00% 50.00%, 100.00% 100.00%, 0.00% 100.00%, 0.00% 50.00%)",
    );
  });

  it("the bar's point and the pointer's position invert each other", () => {
    // Dragging must put the bar under the cursor at any rotation: the
    // point ON the line answers back the pos that produced it.
    for (const angle of [0, 37, -63, 90, 145]) {
      for (const pos of [0.2, 0.5, 0.8]) {
        const lp = linePoint(angle, pos, dims);
        expect(posOnAxis(angle, lp.x / 100, lp.y / 100, dims)).toBeCloseTo(pos, 6);
      }
    }
    // And at angle 0 the axis is plain x, the original contract.
    expect(posOnAxis(0, 0.3, 0.9, dims)).toBeCloseTo(0.3, 6);
  });

  it("the grid checkerboard is one conic tile, two cells per repeat", () => {
    expect(gridMask(3, 3, false)).toEqual({
      image: "repeating-conic-gradient(black 0 25%, transparent 0 50%)",
      size: "66.6667% 66.6667%",
    });
    // Invert swaps which parity is opaque, nothing else.
    expect(gridMask(3, 3, true).image).toBe(
      "repeating-conic-gradient(transparent 0 25%, black 0 50%)",
    );
    expect(gridMask(4, 2, false).size).toBe("50.0000% 100.0000%");
  });

  it("the radial slice is a conic wedge at the apex", () => {
    expect(radialMask(0.5, 0.5, -22.5, 22.5, false)).toBe(
      "conic-gradient(from -22.50deg at 50.00% 50.00%, black 0 45.00deg, transparent 0)",
    );
    // Inverted, the slice goes transparent and the rest opaque.
    expect(radialMask(0.25, 0.75, 10, 100, true)).toBe(
      "conic-gradient(from 10.00deg at 25.00% 75.00%, transparent 0 90.00deg, black 0)",
    );
    // Edges together means the whole frame, not a zero-width sliver:
    // a handle dragged onto its twin must not blank the comparison.
    expect(radialMask(0.5, 0.5, 40, 40, false)).toContain("black 0 360.00deg");
  });

  it("bearings run clockwise from straight up, like the CSS conic", () => {
    expect(bearing(0, -1)).toBe(0);
    expect(bearing(1, 0)).toBe(90);
    expect(bearing(0, 1)).toBe(180);
    expect(bearing(-1, 0)).toBe(-90);
  });

  it("SHIFT snaps to the mode's own step", () => {
    expect(snapDeg(47, true, 10)).toBe(50); // the line's 10 degrees
    expect(snapDeg(47, false, 10)).toBe(47);
    expect(snapDeg(-88, true, 5)).toBe(-90); // the radial edges' 5
  });
});

describe("the set_split reducer", () => {
  it("clamps every field to something renderable", () => {
    const s = reduce(initialState(), {
      type: "set_split",
      changes: { gridX: 99, gridY: 0, radialX: 4, radialY: -1, angle: 370, radialFrom: -541 },
    });
    expect(s.split.gridX).toBe(12);
    expect(s.split.gridY).toBe(1);
    expect(s.split.radialX).toBe(1);
    expect(s.split.radialY).toBe(0);
    expect(s.split.angle).toBe(10);
    expect(s.split.radialFrom).toBe(179);
  });

  it("partial changes leave the rest of the split alone", () => {
    const s = reduce(initialState(), { type: "set_split", changes: { mode: "grid" } });
    expect(s.split.mode).toBe("grid");
    expect(s.split.gridX).toBe(3);
    expect(s.split.barShown).toBe(true);
  });
});

describe("the compare source", () => {
  it("names the matchup, and a photo switch puts it down", () => {
    let s = reduce(initialState(), { type: "new_take" });
    expect(compareLabels(s)).toEqual({ before: "BEFORE", after: "AFTER" });
    s = reduce(s, { type: "set_compare_take", id: "take_1" });
    expect(compareLabels(s)).toEqual({ before: "TAKE 1", after: "CURRENT" });
    // A take that stopped existing falls back to the original quietly.
    expect(compareLabels({ ...s, compareTake: "take_9" })).toEqual({
      before: "BEFORE",
      after: "AFTER",
    });
    // Another photo's takes are other graphs; the pointer clears.
    const other = s.images.find((i) => i.id !== s.activeImage)!;
    s = reduce(s, { type: "select_image", id: other.id });
    expect(s.compareTake).toBe(null);
  });

  it("deleting the take the before side points at clears the pointer", () => {
    // The selector would otherwise keep naming a ghost while
    // compareTakeOf quietly fell back to the original.
    let s = reduce(initialState(), { type: "new_take" });
    s = reduce(s, { type: "set_compare_take", id: "take_1" });
    expect(s.compareTake).toBe("take_1");
    s = reduce(s, { type: "delete_take", takeId: "take_1" });
    expect(s.compareTake).toBe(null);
    // Deleting any OTHER take leaves the pointer alone, even when the
    // take on screen is the one that goes.
    s = reduce(s, { type: "new_take" });
    s = reduce(s, { type: "set_compare_take", id: "take_2" });
    s = reduce(s, { type: "delete_take", takeId: s.activeTakes[s.activeImage] });
    expect(s.compareTake).toBe("take_2");
  });

  it("a branch after a delete never mints an id a living take holds", () => {
    // Count-based ids collide here: [take_1, take_2], drop take_1,
    // branch, and the old rule made a second take_2. Every by-id
    // lookup (switch, update, delete) would then hit both at once.
    let s = reduce(initialState(), { type: "new_take" });
    s = reduce(s, { type: "delete_take", takeId: "take_1" });
    s = reduce(s, { type: "new_take" });
    const ids = s.takes[s.activeImage].map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe("the split header seat and in-frame furniture", () => {
  it("in the app the after pane does not grade the stand-in thumbnail twice", () => {
    const tauri = vi.spyOn(bridge, "isTauri").mockReturnValue(true);
    try {
      // Black and white makes the CSS approximation nontrivial, so a
      // double grade would show up as grayscale(1) on the after pane.
      let s = reduce(initialState(), { type: "set_param", id: "bw", param: "amount", value: 100 });
      s = { ...s, splitOn: true };
      render(<Viewer state={s} dispatch={() => {}} />);
      const after = screen.getByTestId("split-after") as HTMLImageElement;
      // The engine already graded the rendered thumbnail the pane
      // stands in for; only the browser stand-in gets the CSS look.
      expect(after.style.filter).toBe("none");
    } finally {
      tauri.mockRestore();
    }
  });

  it("appears with Split, and each mode brings its own controls", () => {
    render(<App />);
    expect(screen.queryByTestId("split-controls")).not.toBeInTheDocument();
    fireEvent.click(screen.getByTestId("btn-split"));

    // Line first: the shared Reset/Reverse/Bar/color seat, the
    // editable degrees field, and the rotate handle in the frame.
    expect(screen.getByTestId("split-mode-line").getAttribute("data-active")).toBe("true");
    expect((screen.getByTestId("split-angle") as HTMLInputElement).value).toBe("0");
    expect(screen.getByTestId("split-reset")).toBeInTheDocument();
    expect(screen.getByTestId("split-reverse")).toBeInTheDocument();
    expect(screen.getByTestId("split-bar-toggle")).toBeInTheDocument();
    expect(screen.getByTestId("split-bar-color")).toBeInTheDocument();
    expect(screen.getByTestId("split-rotate-handle")).toBeInTheDocument();
    // The degrees field really edits: the owner asked for it
    // editable. It commits on blur, like every typed field.
    fireEvent.change(screen.getByTestId("split-angle"), { target: { value: "45" } });
    fireEvent.blur(screen.getByTestId("split-angle"));
    expect((screen.getByTestId("split-angle") as HTMLInputElement).value).toBe("45");
    expect((screen.getByTestId("split-after") as HTMLImageElement).style.clipPath).toContain("polygon");

    // Grid: the 3x3 default draws two lines per axis, the header
    // fields grow real columns, and the shared Reverse answers for
    // the grid's own invert.
    fireEvent.click(screen.getByTestId("split-mode-grid"));
    expect(screen.getByTestId("split-view").getAttribute("data-split-mode")).toBe("grid");
    expect(screen.getByTestId("split-grid-v-2")).toBeInTheDocument();
    expect(screen.getByTestId("split-grid-h-2")).toBeInTheDocument();
    expect(screen.queryByTestId("split-grid-v-3")).not.toBeInTheDocument();
    fireEvent.change(screen.getByTestId("split-grid-x"), { target: { value: "4" } });
    fireEvent.blur(screen.getByTestId("split-grid-x"));
    expect((screen.getByTestId("split-grid-x") as HTMLInputElement).value).toBe("4");
    expect(screen.getByTestId("split-grid-v-3")).toBeInTheDocument();
    const reverse = screen.getByTestId("split-reverse");
    expect(reverse.getAttribute("data-active")).toBe("false");
    fireEvent.click(reverse);
    expect(reverse.getAttribute("data-active")).toBe("true");

    // Radial: apex handle, two draggable edges (no handles riding
    // them), and the XY inputs.
    fireEvent.click(screen.getByTestId("split-mode-radial"));
    expect(screen.getByTestId("split-radial-center")).toBeInTheDocument();
    expect(screen.getByTestId("split-radial-edge-from")).toBeInTheDocument();
    expect(screen.getByTestId("split-radial-edge-to")).toBeInTheDocument();
    expect(screen.queryByTestId("split-radial-handle-from")).not.toBeInTheDocument();
    const x = screen.getByTestId("split-radial-x") as HTMLInputElement;
    fireEvent.change(x, { target: { value: "20" } });
    expect((screen.getByTestId("split-radial-x") as HTMLInputElement).value).toBe("20");
  });

  it("one Reset serves each mode's own idea of fresh", () => {
    render(<App />);
    fireEvent.click(screen.getByTestId("btn-split"));
    // Grid: the owner, "Reset restores the 3x3 grid".
    fireEvent.click(screen.getByTestId("split-mode-grid"));
    fireEvent.change(screen.getByTestId("split-grid-x"), { target: { value: "5" } });
    fireEvent.blur(screen.getByTestId("split-grid-x"));
    expect((screen.getByTestId("split-grid-x") as HTMLInputElement).value).toBe("5");
    fireEvent.click(screen.getByTestId("split-reset"));
    expect((screen.getByTestId("split-grid-x") as HTMLInputElement).value).toBe("3");
    expect((screen.getByTestId("split-grid-y") as HTMLInputElement).value).toBe("3");
    // Radial: back to the centered apex and the birth angles.
    fireEvent.click(screen.getByTestId("split-mode-radial"));
    fireEvent.change(screen.getByTestId("split-radial-x"), { target: { value: "20" } });
    fireEvent.blur(screen.getByTestId("split-radial-x"));
    fireEvent.click(screen.getByTestId("split-reset"));
    expect((screen.getByTestId("split-radial-x") as HTMLInputElement).value).toBe("50");
  });

  it("every value field scrubs by drag; the Line field snaps to 5 with SHIFT", () => {
    render(<App />);
    fireEvent.click(screen.getByTestId("btn-split"));
    // Line: 46px at half a degree per pixel is 23, snapped to 25.
    const angle = screen.getByTestId("split-angle") as HTMLInputElement;
    fireEvent.mouseDown(angle, { clientX: 100, button: 0 });
    fireEvent.mouseMove(window, { clientX: 146, shiftKey: true });
    fireEvent.mouseUp(window);
    expect(angle.value).toBe("25");
    // Grid: a cell per 24 pixels.
    fireEvent.click(screen.getByTestId("split-mode-grid"));
    const gx = screen.getByTestId("split-grid-x") as HTMLInputElement;
    fireEvent.mouseDown(gx, { clientX: 100, button: 0 });
    fireEvent.mouseMove(window, { clientX: 148 });
    fireEvent.mouseUp(window);
    expect(gx.value).toBe("5");
    // Radial: half a percent per pixel.
    fireEvent.click(screen.getByTestId("split-mode-radial"));
    const rx = screen.getByTestId("split-radial-x") as HTMLInputElement;
    fireEvent.mouseDown(rx, { clientX: 100, button: 0 });
    fireEvent.mouseMove(window, { clientX: 140 });
    fireEvent.mouseUp(window);
    expect(rx.value).toBe("70");
  });

  it("the radial origin moves only by its own drag", () => {
    // The owner's bug: "Trying to rotate on a handle is moving the
    // origin", and "it should not move when I click on the canvas".
    render(<App />);
    fireEvent.click(screen.getByTestId("btn-split"));
    fireEvent.click(screen.getByTestId("split-mode-radial"));
    // A press on the frame does nothing to the apex.
    fireEvent.mouseDown(screen.getByTestId("split-view"), { clientX: 30, clientY: 30 });
    fireEvent.mouseMove(window, { clientX: 60, clientY: 60, buttons: 1 });
    fireEvent.mouseUp(window);
    expect((screen.getByTestId("split-radial-x") as HTMLInputElement).value).toBe("50");
    // Dragging a slice edge turns the edge and leaves the apex alone.
    fireEvent.mouseDown(screen.getByTestId("split-radial-edge-from"), { clientX: 30, clientY: 30 });
    fireEvent.mouseMove(window, { clientX: 90, clientY: 10 });
    fireEvent.mouseUp(window);
    expect((screen.getByTestId("split-radial-x") as HTMLInputElement).value).toBe("50");
  });

  it("A/B shows the same framing twice and turns on its toggle", () => {
    // "sort of like line except its always even...
    // Each split views the exact same part of an image."
    render(<App />);
    fireEvent.click(screen.getByTestId("btn-split"));
    fireEvent.click(screen.getByTestId("split-mode-twin"));
    const view = screen.getByTestId("split-view");
    expect(view.getAttribute("data-split-mode")).toBe("twin");
    expect(view.style.flexDirection).toBe("row");
    expect(screen.getByTestId("twin-before")).toBeInTheDocument();
    expect(screen.getByTestId("twin-after")).toBeInTheDocument();
    expect(screen.getByTestId("split-divider")).toBeInTheDocument();
    // The orientation toggle stacks the panes.
    fireEvent.click(screen.getByTestId("split-twin-orient"));
    expect(screen.getByTestId("split-view").style.flexDirection).toBe("column");
    // Reverse swaps which pane comes first.
    const beforeFirst =
      screen.getByTestId("twin-before").compareDocumentPosition(screen.getByTestId("twin-after")) & 4;
    expect(beforeFirst).toBe(4);
    fireEvent.click(screen.getByTestId("split-reverse"));
    const afterFirst =
      screen.getByTestId("twin-after").compareDocumentPosition(screen.getByTestId("twin-before")) & 4;
    expect(afterFirst).toBe(4);
    // Reset restores side-by-side; Bar hides the seam.
    fireEvent.click(screen.getByTestId("split-reset"));
    expect(screen.getByTestId("split-view").style.flexDirection).toBe("row");
    fireEvent.click(screen.getByTestId("split-bar-toggle"));
    expect(screen.queryByTestId("split-divider")).not.toBeInTheDocument();
  });

  it("a second take offers itself as the before side, by name", () => {
    // "switch up Before/After with take numbers. Take 2 /
    // Current Take."
    render(<App />);
    fireEvent.click(screen.getByTestId("btn-split"));
    // One take: nothing to choose, no selector.
    expect(screen.queryByTestId("compare-source")).not.toBeInTheDocument();
    expect(screen.getByText("BEFORE")).toBeInTheDocument();
    // Branch a second take; the selector appears with the OTHER take.
    fireEvent.click(screen.getByTestId("new-take"));
    const source = screen.getByTestId("compare-source");
    expect(menuValue(source)).toBe("original");
    choose(source, "take_1");
    // The corner labels now name the matchup.
    expect(screen.getByText("TAKE 1")).toBeInTheDocument();
    expect(screen.getByText("CURRENT")).toBeInTheDocument();
    expect(screen.queryByText("BEFORE")).not.toBeInTheDocument();
    // A/B panes wear the same names.
    fireEvent.click(screen.getByTestId("split-mode-twin"));
    expect(screen.getByText("TAKE 1")).toBeInTheDocument();
    expect(screen.getByText("CURRENT")).toBeInTheDocument();
  });

  it("the header runs Gamut | Crop Straighten | Before/After Split", () => {
    render(<App />);
    const order = ["btn-gamut", "btn-tool-crop", "btn-tool-straighten", "btn-before-after", "btn-split"].map(
      (id) => screen.getByTestId(id),
    );
    for (let i = 1; i < order.length; i++) {
      // DOCUMENT_POSITION_FOLLOWING = 4: each button follows the last.
      expect(order[i - 1].compareDocumentPosition(order[i]) & 4).toBe(4);
    }
  });

  it("the Bar toggle hides the furniture but never the split itself", () => {
    render(<App />);
    fireEvent.click(screen.getByTestId("btn-split"));
    expect(screen.getByTestId("split-divider")).toBeInTheDocument();
    fireEvent.click(screen.getByTestId("split-bar-toggle"));
    expect(screen.queryByTestId("split-divider")).not.toBeInTheDocument();
    expect(screen.queryByTestId("split-rotate-handle")).not.toBeInTheDocument();
    // The comparison is still up: only the furniture went.
    expect(screen.getByTestId("split-after")).toBeInTheDocument();
    fireEvent.click(screen.getByTestId("split-mode-grid"));
    expect(screen.queryByTestId("split-grid-v-1")).not.toBeInTheDocument();
  });

  it("reverse swaps the corner labels with the pixels", () => {
    render(<App />);
    fireEvent.click(screen.getByTestId("btn-split"));
    expect(screen.getByText("BEFORE")).toBeInTheDocument();
    fireEvent.click(screen.getByTestId("split-reverse"));
    // The after image now claims the left, and the words follow.
    const after = screen.getByTestId("split-after") as HTMLImageElement;
    expect(after.style.clipPath).toBe("inset(0 50% 0 0)");
    const labels = screen.getAllByText(/BEFORE|AFTER/).map((el) => el.textContent);
    expect(labels[0]).toBe("AFTER");
  });

  it("grid and radial drop the corner labels: no side for a word to stand on", () => {
    render(<App />);
    fireEvent.click(screen.getByTestId("btn-split"));
    fireEvent.click(screen.getByTestId("split-mode-grid"));
    expect(screen.queryByText("BEFORE")).not.toBeInTheDocument();
    expect(screen.queryByText("AFTER")).not.toBeInTheDocument();
  });

  it("double-clicking the rotate handle resets bar and angle", () => {
    render(<App />);
    fireEvent.click(screen.getByTestId("btn-split"));
    // Knock the bar off center first, then reset from the handle.
    fireEvent.mouseDown(screen.getByTestId("split-view"), { clientX: 10, clientY: 10 });
    fireEvent.doubleClick(screen.getByTestId("split-rotate-handle"));
    const after = screen.getByTestId("split-after") as HTMLImageElement;
    expect(after.style.clipPath).toBe("inset(0 0 0 50%)");
    expect((screen.getByTestId("split-angle") as HTMLInputElement).value).toBe("0");
  });

  it("the bar moves only from its own press, never a stray held-button pass", () => {
    // The drag starts on the box's own mousedown and rides the window;
    // a mousemove over the frame with a button held for ANOTHER gesture
    // (a space-pan, a rotate-handle drag) must leave the bar alone.
    render(<App />);
    fireEvent.click(screen.getByTestId("btn-split"));
    const after = screen.getByTestId("split-after") as HTMLImageElement;
    expect(after.style.clipPath).toBe("inset(0 0 0 50%)");
    // No press on the box: a held-button sweep changes nothing.
    fireEvent.mouseMove(screen.getByTestId("split-view"), { buttons: 1, clientX: 40 });
    expect(after.style.clipPath).toBe("inset(0 0 0 50%)");
    // A real press drags: the clip leaves the default.
    // (jsdom reports a zero-size rect, so assert the CHANGE, not a value.)
    fireEvent.mouseDown(screen.getByTestId("split-view"), { clientX: 40, clientY: 10 });
    expect(after.style.clipPath).not.toBe("inset(0 0 0 50%)");
    fireEvent.mouseUp(window);
  });
});
