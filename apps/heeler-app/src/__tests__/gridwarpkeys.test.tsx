// Grid Warp's keys (2026-09-30: "Grid Warp (both Finish and
// Adjustments) The SHIFT key should lock the transforming of the grids
// to one axis. It should also support arrow keys for adjustments").
//
// Held here: Shift during a drag holds the move to the axis the pointer
// has gone further along, live, and Shift pressed or let go with the
// pointer still; Shift-click still adds and trims the pick; the arrows
// nudge the picked handles a photograph pixel (ten with Shift) whatever
// the zoom and the display's pixel ratio, along the picture's axes under
// a turned view; a burst of presses is one undo step; the arrows belong
// to the grid while the tool is up and step through photos when it is
// not; and all of it on the three seats the one overlay serves: the
// photograph's own Grid Warp, a Warp layer, an image layer's own warp.
import { act, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import React, { useCallback, useState } from "react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { initialState, NEUTRAL_NODES, NEUTRAL_WIRES } from "../data";
import { artLayers, imageLayerWarp, reduce, warpNodeFor, type Command, type State } from "../state";
import { noteFrameAspect } from "../imagelayers";
import { GridWarpOverlay, gridWarpKeysLine, type WarpPair } from "../ui/gridwarp";
import { meshFromNode, restMesh, vertexIndex } from "../gridwarp";
import { arrowNudge, lockToAxis } from "../gridwarpkeys";
import type { ViewTransform } from "../ui/overlays";
import { App } from "../app";

const run = (s: State, ...cmds: Command[]): State => cmds.reduce(reduce, s);

let latest: State;
let commands: Command[] = [];
function Harness({ start, view, frame = { w: 4000, h: 3000 } }: { start: State; view?: ViewTransform; frame?: { w: number; h: number } }) {
  const [state, setState] = useState(start);
  latest = state;
  const live = React.useRef<WarpPair | null>(null);
  const send = useCallback((c: Command) => {
    commands.push(c);
    setState((s) => {
      const next = reduce(s, c);
      latest = next;
      return next;
    });
  }, []);
  return <GridWarpOverlay state={state} dispatch={send} frame={frame} live={live} view={view} />;
}

/** A 400 by 300 stage at `zoom`: the layout box stays 400 by 300 and the
 * transform scales the rect, the way the viewer's stage does. */
function stubBox(el: HTMLElement, zoom = 1, w = 400, h = 300) {
  el.getBoundingClientRect = () =>
    ({ left: 0, top: 0, right: w * zoom, bottom: h * zoom, width: w * zoom, height: h * zoom, x: 0, y: 0, toJSON() {} }) as DOMRect;
  Object.defineProperty(el, "offsetWidth", { configurable: true, value: w });
  Object.defineProperty(el, "offsetHeight", { configurable: true, value: h });
}

const develop = (): State => ({ ...reduce(initialState(), { type: "select_image", id: "4869" }), tool: "gridwarp", warpTarget: null });

function fresh(id = "gridwarp_keys"): State {
  noteFrameAspect(id, 4 / 3);
  return { ...initialState(), activeImage: id, mode: "simple", panelTab: "layers", nodes: structuredClone(NEUTRAL_NODES), wires: structuredClone(NEUTRAL_WIRES) };
}
/** A Warp layer of Grid type with the tool up on it. */
function warpLayerSeat(): { s: State; warp: string } {
  const added = run(fresh(), { type: "art_add_layer", kind: "warp" });
  const blend = added.artActive!;
  const warp = artLayers(added).find((l) => l.blend.id === blend)!.content.id;
  return { s: run(added, { type: "art_warp_kind", id: warp, kind: "grid" }, { type: "set_tool", tool: "gridwarp", target: warp }), warp };
}
/** An image layer 0.4 of the frame wide and 0.3 high, unturned, with its
 * own warp of Grid type and the tool up on it. */
const BOX = { x: 0.3, y: 0.35, w: 0.4, h: 0.3 };
function imageLayerSeat(): { s: State; warp: string } {
  let s = run(fresh(), { type: "art_add_image_layer", source: { kind: "file", path: "__IMAGE__" }, name: "logo", box: BOX });
  const blend = s.artActive!;
  s = run(s, { type: "art_layer_warp", id: blend, on: true });
  const warp = imageLayerWarp(s, blend)!.id;
  return { s: run(s, { type: "art_warp_kind", id: warp, kind: "grid" }, { type: "set_tool", tool: "gridwarp", target: warp }), warp };
}

const meshOf = (s: State) => meshFromNode(warpNodeFor(s, "grid")!);
const lastMesh = () => (commands.filter((c) => c.type === "grid_warp_mesh").pop() as Extract<Command, { type: "grid_warp_mesh" }>).mesh;

beforeEach(() => {
  commands = [];
});
afterEach(() => {
  Object.defineProperty(window, "devicePixelRatio", { configurable: true, value: 1 });
});

describe("the arithmetic", () => {
  it("Shift holds a move to the axis the pointer went further along, in pixels", () => {
    // A unit of x is `aspect` units of y: on a 4:3 frame 0.1 across is
    // 40 px, 0.12 down is 36 px, so x wins.
    expect(lockToAxis(0.1, 0.12, 4 / 3)).toEqual([0.1, 0]);
    expect(lockToAxis(0.1, 0.14, 4 / 3)).toEqual([0, 0.14]);
    expect(lockToAxis(-0.2, 0.05, 1)).toEqual([-0.2, 0]);
  });

  it("an arrow is a photograph pixel along the warp's axis nearest its direction on screen", () => {
    const frame = { w: 4000, h: 3000 };
    expect(arrowNudge("ArrowRight", 1, 0, frame)).toEqual([1 / 4000, 0]);
    expect(arrowNudge("ArrowUp", 10, 0, frame)).toEqual([0, -10 / 3000]);
    // A small tilt of the view leaves Right on the picture's x.
    expect(arrowNudge("ArrowRight", 1, 4, frame)).toEqual([1 / 4000, 0]);
    // A quarter turn clockwise: the screen's right is the picture's up.
    const q = arrowNudge("ArrowRight", 1, 90, frame);
    expect(q[0]).toBe(0);
    expect(q[1]).toBeCloseTo(-1 / 3000, 6);
    // Half a turn: Right moves the picture's x backwards.
    expect(arrowNudge("ArrowRight", 1, 180, frame)[0]).toBeCloseTo(-1 / 4000, 6);
    // A picture 0.4 of the frame wide: one frame pixel is 1/1600 of it.
    expect(arrowNudge("ArrowRight", 1, 0, frame, [[0.4, 0], [0, 0.3]])).toEqual([1 / 1600, 0]);
  });
});

describe("Shift locks a drag to one axis", () => {
  it("follows the dominant axis live and lets go of the lock without a jump", () => {
    render(<Harness start={develop()} frame={{ w: 400, h: 300 }} />);
    const overlay = screen.getByTestId("gridwarp-overlay");
    stubBox(screen.getByTestId("gridwarp-frame"));
    const m = restMesh(4, 3);
    const k = vertexIndex(m, 1, 1); // (0.25, 1/3): pixel (100, 100)
    const handle = () => screen.getAllByTestId("gridwarp-vertex")[k];
    fireEvent.mouseDown(overlay, { button: 0, clientX: 100, clientY: 100 });
    // 40 right, 10 down with Shift: only the 40.
    fireEvent.mouseMove(document, { buttons: 1, clientX: 140, clientY: 110, shiftKey: true });
    expect(handle().style.left).toBe("35%");
    expect(parseFloat(handle().style.top)).toBeCloseTo(100 / 3, 6);
    // Now 50 right, 80 down: the lock swaps to y.
    fireEvent.mouseMove(document, { buttons: 1, clientX: 150, clientY: 180, shiftKey: true });
    expect(handle().style.left).toBe("25%");
    expect(parseFloat(handle().style.top)).toBeCloseTo(60, 6);
    // Shift let go with the pointer still: both axes, at once.
    act(() => {
      fireEvent.keyUp(window, { key: "Shift" });
    });
    expect(handle().style.left).toBe("37.5%");
    expect(parseFloat(handle().style.top)).toBeCloseTo(60, 6);
    // And pressed again: the lock is back.
    act(() => {
      fireEvent.keyDown(window, { key: "Shift", shiftKey: true });
    });
    expect(handle().style.left).toBe("25%");
    fireEvent.mouseUp(document);
    const d = lastMesh().d[k];
    expect(d[0]).toBeCloseTo(0, 9);
    expect(d[1]).toBeCloseTo(80 / 300, 9);
    expect(latest.gesture).toBeNull();
  });

  it("Shift-click still adds a handle and trims a picked one; a Shift-drag on a picked one moves the pick", () => {
    render(<Harness start={develop()} frame={{ w: 400, h: 300 }} />);
    const overlay = screen.getByTestId("gridwarp-overlay");
    stubBox(screen.getByTestId("gridwarp-frame"));
    const m = restMesh(4, 3);
    const a = vertexIndex(m, 1, 1); // (100, 100)
    const b = vertexIndex(m, 2, 1); // (200, 100)
    fireEvent.mouseDown(overlay, { button: 0, clientX: 100, clientY: 100 });
    fireEvent.mouseUp(document);
    fireEvent.mouseDown(overlay, { button: 0, clientX: 200, clientY: 100, shiftKey: true });
    fireEvent.mouseUp(document);
    expect(latest.gridWarp.selected).toEqual([a, b]);
    // A Shift-click on a picked handle takes it out, moving nothing,
    // even with a pixel of tremor.
    fireEvent.mouseDown(overlay, { button: 0, clientX: 200, clientY: 100, shiftKey: true });
    fireEvent.mouseMove(document, { buttons: 1, clientX: 201, clientY: 101, shiftKey: true });
    fireEvent.mouseUp(document);
    expect(latest.gridWarp.selected).toEqual([a]);
    expect(commands.some((c) => c.type === "grid_warp_mesh")).toBe(false);
    // Put it back, then Shift-drag a picked handle: the whole pick
    // moves, held to the axis, and stays picked.
    fireEvent.mouseDown(overlay, { button: 0, clientX: 200, clientY: 100, shiftKey: true });
    fireEvent.mouseUp(document);
    fireEvent.mouseDown(overlay, { button: 0, clientX: 100, clientY: 100, shiftKey: true });
    fireEvent.mouseMove(document, { buttons: 1, clientX: 104, clientY: 160, shiftKey: true });
    fireEvent.mouseUp(document);
    expect(latest.gridWarp.selected).toEqual([a, b]);
    const d = lastMesh().d;
    for (const k of [a, b]) {
      expect(d[k][0]).toBeCloseTo(0, 9);
      expect(d[k][1]).toBeCloseTo(0.2, 9);
    }
  });
});

describe("the arrows nudge the picked handles", () => {
  const pickAndNudge = (zoom: number, dpr: number) => {
    Object.defineProperty(window, "devicePixelRatio", { configurable: true, value: dpr });
    commands = [];
    const view = render(<Harness start={develop()} view={{ rotation: 0, zoom }} />);
    stubBox(screen.getByTestId("gridwarp-frame"), zoom);
    const m = restMesh(4, 3);
    const k = vertexIndex(m, 1, 1); // (100, 100) of the layout box, times the zoom on screen
    fireEvent.mouseDown(screen.getByTestId("gridwarp-overlay"), { button: 0, clientX: 100 * zoom, clientY: 100 * zoom });
    fireEvent.mouseUp(document);
    expect(latest.gridWarp.selected).toEqual([k]);
    fireEvent.keyDown(window, { key: "ArrowRight" });
    fireEvent.keyUp(window, { key: "ArrowRight" });
    fireEvent.keyDown(window, { key: "ArrowDown", shiftKey: true });
    fireEvent.keyUp(window, { key: "ArrowDown", shiftKey: true });
    const d = meshOf(latest).d[k];
    view.unmount();
    return d;
  };

  it("by one photograph pixel, ten with Shift, whatever the zoom and the pixel ratio", () => {
    for (const [zoom, dpr] of [[1, 1], [2, 1], [0.5, 2], [3, 2]]) {
      const d = pickAndNudge(zoom, dpr);
      expect(d[0]).toBeCloseTo(1 / 4000, 6);
      expect(d[1]).toBeCloseTo(10 / 3000, 6);
    }
  });

  it("a burst of presses and repeats is one undo step", () => {
    render(<Harness start={develop()} />);
    stubBox(screen.getByTestId("gridwarp-frame"));
    const k = vertexIndex(restMesh(4, 3), 1, 1);
    fireEvent.mouseDown(screen.getByTestId("gridwarp-overlay"), { button: 0, clientX: 100, clientY: 100 });
    fireEvent.mouseUp(document);
    // The first press builds the node; take the count after that burst.
    fireEvent.keyDown(window, { key: "ArrowLeft" });
    fireEvent.keyUp(window, { key: "ArrowLeft" });
    const before = latest.undoStack.length;
    fireEvent.keyDown(window, { key: "ArrowRight" });
    fireEvent.keyDown(window, { key: "ArrowRight", repeat: true });
    fireEvent.keyDown(window, { key: "ArrowRight", repeat: true });
    // A second arrow joining the burst stays in it.
    fireEvent.keyDown(window, { key: "ArrowUp" });
    fireEvent.keyUp(window, { key: "ArrowUp" });
    expect(latest.gesture).toBe("gridwarp.mesh");
    fireEvent.keyUp(window, { key: "ArrowRight" });
    expect(latest.gesture).toBeNull();
    expect(latest.undoStack.length).toBe(before + 1);
    expect(meshOf(latest).d[k][0]).toBeCloseTo(2 / 4000, 6);
    expect(meshOf(latest).d[k][1]).toBeCloseTo(-1 / 3000, 6);
    // One undo takes the whole burst back, to the first press's place.
    const undone = run(latest, { type: "undo" });
    expect(meshOf(undone).d[k][0]).toBeCloseTo(-1 / 4000, 6);
    expect(meshOf(undone).d[k][1]).toBeCloseTo(0, 6);
  });

  it("leave a focused slider's arrows to it, and say so when nothing is picked", () => {
    render(
      <>
        <input type="range" data-testid="slider" />
        <Harness start={develop()} />
      </>,
    );
    stubBox(screen.getByTestId("gridwarp-frame"));
    const slider = screen.getByTestId("slider");
    const onSlider = fireEvent.keyDown(slider, { key: "ArrowRight" });
    expect(onSlider).toBe(true); // not prevented
    // Nothing picked: the arrow is the grid's, and does nothing.
    const onGrid = fireEvent.keyDown(window, { key: "ArrowRight" });
    expect(onGrid).toBe(false);
    expect(commands.some((c) => c.type === "grid_warp_mesh" || c.type === "begin_gesture")).toBe(false);
  });

  it("the status line names the keys", () => {
    const line = gridWarpKeysLine();
    expect(line).toMatch(/while dragging locks to one axis/);
    expect(line).toMatch(/arrows nudge 1 px/);
    expect(line).toMatch(/\+arrows 10 px/);
  });
});

describe("the same keys on every Grid Warp seat", () => {
  it("a Warp layer: Shift locks and the arrows nudge in the frame's pixels, one undo step", () => {
    const { s, warp } = warpLayerSeat();
    render(<Harness start={s} />);
    const overlay = screen.getByTestId("gridwarp-overlay");
    stubBox(screen.getByTestId("gridwarp-frame"));
    const k = vertexIndex(restMesh(4, 3), 1, 1);
    fireEvent.mouseDown(overlay, { button: 0, clientX: 100, clientY: 100 });
    fireEvent.mouseMove(document, { buttons: 1, clientX: 140, clientY: 120, shiftKey: true });
    fireEvent.mouseUp(document);
    let d = meshOf(latest).d[k];
    expect(d[0]).toBeCloseTo(0.1, 9);
    expect(d[1]).toBeCloseTo(0, 9);
    const before = latest.undoStack.length;
    fireEvent.keyDown(window, { key: "ArrowDown" });
    fireEvent.keyDown(window, { key: "ArrowDown", repeat: true });
    fireEvent.keyUp(window, { key: "ArrowDown" });
    d = meshOf(latest).d[k];
    expect(d[1]).toBeCloseTo(2 / 3000, 6);
    expect(latest.undoStack.length).toBe(before + 1);
    // Written on the layer's warp, never the photograph's own.
    expect(latest.warpTarget).toBe(warp);
    expect(latest.nodes.some((n) => n.type === "heeler.grid_warp")).toBe(false);
  });

  it("an image layer's own warp: the arrows move a frame pixel along the picture's axes", () => {
    const { s } = imageLayerSeat();
    render(<Harness start={s} />);
    const overlay = screen.getByTestId("gridwarp-overlay");
    stubBox(screen.getByTestId("gridwarp-frame"));
    // The picture's handle (0.25, 1/3) sits at frame (0.4, 0.45):
    // stage pixel (160, 135).
    const k = vertexIndex(restMesh(4, 3), 1, 1);
    fireEvent.mouseDown(overlay, { button: 0, clientX: 160, clientY: 135 });
    fireEvent.mouseUp(document);
    expect(latest.gridWarp.selected).toEqual([k]);
    fireEvent.keyDown(window, { key: "ArrowRight", shiftKey: true });
    fireEvent.keyUp(window, { key: "ArrowRight" });
    // Ten frame pixels across a picture 0.4 of 4000 wide.
    expect(meshOf(latest).d[k][0]).toBeCloseTo(10 / 1600, 6);
    expect(meshOf(latest).d[k][1]).toBeCloseTo(0, 6);
    // Shift-drag 40 right and 30 down on the stage: in the picture's
    // units, 0.25 across against 1/3 down; in pixels 40 against 30, so
    // across wins.
    fireEvent.mouseDown(overlay, { button: 0, clientX: 160 + 400 * (10 / 4000), clientY: 135 });
    fireEvent.mouseMove(document, { buttons: 1, clientX: 201, clientY: 165, shiftKey: true });
    fireEvent.mouseUp(document);
    expect(meshOf(latest).d[k][1]).toBeCloseTo(0, 9);
    expect(meshOf(latest).d[k][0]).toBeGreaterThan(10 / 1600);
  });
});

describe("in the app", () => {
  // The frame's size in photograph pixels, which jsdom never decodes.
  const proto = HTMLImageElement.prototype;
  const prior = (["naturalWidth", "naturalHeight"] as const).map((k) => [k, Object.getOwnPropertyDescriptor(proto, k)] as const);
  beforeEach(() => {
    Object.defineProperty(proto, "naturalWidth", { configurable: true, get: () => 4000 });
    Object.defineProperty(proto, "naturalHeight", { configurable: true, get: () => 3000 });
  });
  afterEach(() => {
    for (const [k, d] of prior) {
      if (d) Object.defineProperty(proto, k, d);
      else delete (proto as unknown as Record<string, unknown>)[k];
    }
  });

  it("the arrows nudge the grid while its tool is up and step through photos when it is not", async () => {
    const user = userEvent.setup();
    render(<App />);
    await user.click(screen.getByTestId("thumb-4869"));
    for (const img of Array.from(document.querySelectorAll("img"))) fireEvent.load(img);
    const active = () =>
      screen
        .getAllByTestId(/^thumb-/)
        .find((t) => t.getAttribute("data-selected") === "true")
        ?.getAttribute("data-testid");
    const collapse = screen.getByTestId("collapse-grid-warp");
    if (collapse.getAttribute("data-open") !== "true") fireEvent.click(collapse);
    fireEvent.click(screen.getByTestId("gridwarp-tool"));
    fireEvent.click(screen.getByTestId("gridwarp-pick-all"));
    const left = () => screen.getAllByTestId("gridwarp-vertex")[0].style.left;
    const rest = left();
    fireEvent.keyDown(window, { key: "ArrowDown" });
    fireEvent.keyUp(window, { key: "ArrowDown" });
    fireEvent.keyDown(window, { key: "ArrowRight", shiftKey: true });
    fireEvent.keyUp(window, { key: "ArrowRight" });
    expect(active()).toBe("thumb-4869");
    expect(left()).not.toBe(rest);
    // Put away: the arrows are the ribbon's again.
    fireEvent.click(screen.getByTestId("gridwarp-tool"));
    expect(screen.queryByTestId("gridwarp-overlay")).toBeNull();
    fireEvent.keyDown(window, { key: "ArrowDown" });
    expect(active()).not.toBe("thumb-4869");
  });
});
