// Space-drag panning, everywhere something pans. "I used
// a touchpad a lot these days. Since there is no middle-mouse it is
// pretty much impossible to pan around the graph view or even a photo
// (when zoomed in)." Hold space, drag: the photo in Develop, the
// graph in Graph mode, and Canvas keeps its photo-pan from before.

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { App } from "../app";

/** The viewer only applies its transform once it knows the stage size
 * and the frame's aspect; jsdom supplies neither on its own. */
function stubStage(stage = 632, frame = 400) {
  const priorRO = (globalThis as { ResizeObserver?: unknown }).ResizeObserver;
  (globalThis as { ResizeObserver?: unknown }).ResizeObserver = class {
    constructor(private cb: (e: { contentRect: { width: number; height: number } }[]) => void) {}
    observe() {
      this.cb([{ contentRect: { width: stage, height: stage } }]);
    }
    disconnect() {}
  };
  const proto = HTMLImageElement.prototype;
  const priorDims = ["naturalWidth", "naturalHeight"].map(
    (k) => [k, Object.getOwnPropertyDescriptor(proto, k)] as const,
  );
  for (const [k] of priorDims) Object.defineProperty(proto, k, { configurable: true, get: () => frame });
  return () => {
    (globalThis as { ResizeObserver?: unknown }).ResizeObserver = priorRO;
    for (const [k, d] of priorDims) {
      if (d) Object.defineProperty(proto, k, d);
      else delete (proto as unknown as Record<string, unknown>)[k];
    }
  };
}

const holdSpace = () => fireEvent.keyDown(window, { code: "Space", key: " " });
const releaseSpace = () => fireEvent.keyUp(window, { code: "Space", key: " " });

describe("space-drag pans", () => {
  it("moves the photo in Develop", () => {
    const restore = stubStage();
    try {
      render(<App />);
      fireEvent.load(screen.getByTestId("viewer-image"));
      holdSpace();
      const stage = screen.getByTestId("viewer-stage");
      fireEvent.mouseDown(stage, { button: 0, clientX: 100, clientY: 100 });
      fireEvent.mouseMove(window, { clientX: 140, clientY: 130, buttons: 1 });
      fireEvent.mouseUp(window);
      releaseSpace();
      expect(screen.getByTestId("stage-frame").style.transform).toContain(
        "translate(40px, 30px)",
      );
    } finally {
      restore();
    }
  });

  it("a mouseup lost off-window ends the drag instead of panning on hover", () => {
    // The buttons guard in useSpacePan: release the button outside
    // the window and no mouseup ever reaches it; the next move
    // arrives with buttons 0 and must read as the end of the drag,
    // not as more panning.
    const restore = stubStage();
    try {
      render(<App />);
      fireEvent.load(screen.getByTestId("viewer-image"));
      holdSpace();
      const stage = screen.getByTestId("viewer-stage");
      fireEvent.mouseDown(stage, { button: 0, clientX: 100, clientY: 100 });
      fireEvent.mouseMove(window, { clientX: 140, clientY: 130, buttons: 1 });
      // The up never lands; the next hover says so.
      fireEvent.mouseMove(window, { clientX: 200, clientY: 200, buttons: 0 });
      fireEvent.mouseMove(window, { clientX: 260, clientY: 260, buttons: 0 });
      releaseSpace();
      expect(screen.getByTestId("stage-frame").style.transform).toContain(
        "translate(40px, 30px)",
      );
    } finally {
      restore();
    }
  });

  it("moves the graph in Graph mode", async () => {
    const user = userEvent.setup();
    render(<App />);
    await user.click(
      screen.getByRole("tablist", { name: /workspace mode/i }).children[1],
    );
    holdSpace();
    const surface = screen.getByTestId("graph-surface");
    fireEvent.mouseDown(surface, { button: 0, clientX: 200, clientY: 200 });
    fireEvent.mouseMove(window, { clientX: 260, clientY: 180, buttons: 1 });
    fireEvent.mouseUp(window);
    releaseSpace();
    expect(screen.getByTestId("graph-viewport").style.transform).toContain(
      "translate(60px, -20px)",
    );
  });

  it("in Canvas, space plus ANY button pans the photo, never the nodes", async () => {
    // Left-only capture let SPACE+middle fall through to the graph's
    // middle-drag. "SPACE+MMB pans the nodes while
    // SPACE+LEFTCLICK pans the canvas. This does not feel consistent."
    // While space is held, space decides what pans; the button stops
    // mattering.
    const restore = stubStage();
    try {
      const user = userEvent.setup();
      render(<App />);
      await user.click(
        screen.getByRole("tablist", { name: /workspace mode/i }).children[2],
      );
      fireEvent.load(screen.getByTestId("viewer-image"));
      holdSpace();
      const layer = screen.getByTestId("canvas-graph-layer");
      fireEvent.mouseDown(layer, { button: 1, clientX: 100, clientY: 100 });
      fireEvent.mouseMove(window, { clientX: 130, clientY: 120, buttons: 4 });
      fireEvent.mouseUp(window);
      releaseSpace();
      expect(screen.getByTestId("stage-frame").style.transform).toContain(
        "translate(30px, 20px)",
      );
      expect(screen.getByTestId("graph-viewport").style.transform).toContain(
        "translate(0px, 0px)",
      );
    } finally {
      restore();
    }
  });

  it("modifier plus a two-finger scroll pans both axes at once", async () => {
    // A trackpad reports dx AND dy; the pan used to keep only one and
    // the diagonal gesture crabbed along an axis. A mouse wheel still
    // pans its single axis the way the modifier chooses.
    const user = userEvent.setup();
    render(<App />);
    await user.click(
      screen.getByRole("tablist", { name: /workspace mode/i }).children[1],
    );
    const surface = screen.getByTestId("graph-surface");
    fireEvent.wheel(surface, { deltaX: -30, deltaY: -20, ctrlKey: true });
    await waitFor(() =>
      expect(screen.getByTestId("graph-viewport").style.transform).toContain(
        "translate(30px, 20px)",
      ),
    );
  });

  it("stays out of the way while typing, and a plain drag still draws", () => {
    const restore = stubStage();
    try {
      render(<App />);
      fireEvent.load(screen.getByTestId("viewer-image"));
      // Space typed into a field must not arm the pan.
      const field = document.createElement("input");
      document.body.appendChild(field);
      fireEvent.keyDown(field, { code: "Space", key: " " });
      const stage = screen.getByTestId("viewer-stage");
      fireEvent.mouseDown(stage, { button: 0, clientX: 100, clientY: 100 });
      fireEvent.mouseMove(window, { clientX: 150, clientY: 150 });
      fireEvent.mouseUp(window);
      expect(screen.getByTestId("stage-frame").style.transform).toContain(
        "translate(0px, 0px)",
      );
      field.remove();
    } finally {
      restore();
    }
  });
});
