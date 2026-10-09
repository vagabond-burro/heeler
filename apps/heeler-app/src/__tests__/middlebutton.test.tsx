// The middle button pans, whatever tool is in hand. (2026-09-30): "I
// noticed middle mouse button is painting a stroke, this makes panning
// around with a mouse problematic." The viewer and the graph pan on a
// middle-drag, but the brush's press handler never asked which button
// went down, so a middle-drag panned AND painted. The rule now lives in
// ui/pointerguard.ts and every canvas press handler asks it
// (pressguardscan.test.ts keeps it that way); these are the gestures.

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import React, { useCallback, useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { App } from "../app";
import { initialState, NEUTRAL_NODES, NEUTRAL_WIRES } from "../data";
import { reduce, type Command, type State } from "../state";
import { isPrimaryPress, primaryHeld } from "../ui/pointerguard";
import { BrushOverlay, CropOverlay, TransformOverlay } from "../ui/overlays";
import { DofFocusOverlay, KeyLightGizmo } from "../ui/keylightgizmo";
import { PolishOverlay } from "../ui/polish";
import { SelectionOverlay } from "../ui/selection";
import { NodeEditor } from "../ui/graph";
import { Viewer } from "../ui/viewer";
import { depthAt } from "../bridge";

// The focus picker's one question of the engine, counted.
vi.mock("../bridge", async (importOriginal) => {
  const real = await importOriginal<typeof import("../bridge")>();
  return { ...real, depthAt: vi.fn(async () => 0.5) };
});

const MIDDLE = { button: 1, buttons: 4 };
const RIGHT = { button: 2, buttons: 2 };
const LEFT = { button: 0, buttons: 1 };

/** A 400 by 300 box at the origin, so pointer pixels mean something. */
function sized(el: HTMLElement, w = 400, h = 300) {
  Object.defineProperty(el, "clientWidth", { value: w, configurable: true });
  Object.defineProperty(el, "clientHeight", { value: h, configurable: true });
  el.getBoundingClientRect = () =>
    ({ left: 0, top: 0, right: w, bottom: h, width: w, height: h, x: 0, y: 0, toJSON() {} }) as DOMRect;
}

/** A press, a drag and a release, the way a real mouse reports them. */
function drag(el: Element, press: { button: number; buttons: number }, extra: Record<string, unknown> = {}) {
  fireEvent.mouseDown(el, { ...press, clientX: 100, clientY: 100, ...extra });
  fireEvent.mouseMove(el, { buttons: press.buttons, clientX: 140, clientY: 130 });
  fireEvent.mouseMove(el, { buttons: press.buttons, clientX: 160, clientY: 170 });
  fireEvent.mouseMove(el, { buttons: press.buttons, clientX: 110, clientY: 170 });
  fireEvent.mouseMove(window, { buttons: press.buttons, clientX: 160, clientY: 150 });
  fireEvent.mouseUp(el, { button: press.button, clientX: 160, clientY: 150 });
  fireEvent.mouseUp(window, { button: press.button });
}

describe("the rule", () => {
  it("only the primary button, on its own, starts a tool action", () => {
    expect(isPrimaryPress({ button: 0, buttons: 1 })).toBe(true);
    // A synthetic press that leaves the held set out.
    expect(isPrimaryPress({ button: 0, buttons: 0 })).toBe(true);
    expect(isPrimaryPress({ button: 1, buttons: 4 })).toBe(false);
    expect(isPrimaryPress({ button: 2, buttons: 2 })).toBe(false);
    // Left pressed while the middle is already down: still the pan's.
    expect(isPrimaryPress({ button: 0, buttons: 5 })).toBe(false);
    expect(primaryHeld({ buttons: 1 })).toBe(true);
    expect(primaryHeld({ buttons: 5 })).toBe(true);
    expect(primaryHeld({ buttons: 4 })).toBe(false);
    expect(primaryHeld({ buttons: 0 })).toBe(false);
  });
});

describe("the brush (mask brush, heal, clone, dodge, burn, blur, fill, paint)", () => {
  /** Every brush tool is this one overlay. Streamed is how clone and
   * heal run: the stroke renders as it grows, through onLive. */
  function mount(streamed: boolean, extra: Partial<React.ComponentProps<typeof BrushOverlay>> = {}) {
    const sent: Command[] = [];
    const strokes: unknown[] = [];
    const live: string[] = [];
    const node = { id: "b", type: "heeler.brush_mask", strokes: [] } as never;
    const onLive = { start: () => live.push("start"), move: () => live.push("move"), end: () => live.push("end") };
    render(
      <BrushOverlay
        node={node}
        radius={0.05}
        dispatch={(c) => sent.push(c)}
        onStroke={(s) => strokes.push(s)}
        {...(streamed ? { onLive: onLive as never } : {})}
        {...extra}
      />,
    );
    const el = screen.getByTestId("brush-overlay");
    sized(el);
    return { el, sent, strokes, live };
  }

  it.each([false, true])("a middle-drag lays down nothing (streamed %s)", (streamed) => {
    const { el, sent, strokes, live } = mount(streamed);
    drag(el, MIDDLE);
    expect(strokes).toEqual([]);
    expect(sent).toEqual([]);
    expect(live).toEqual([]);
  });

  it.each([false, true])("a right press lays down nothing (streamed %s)", (streamed) => {
    const { el, sent, strokes, live } = mount(streamed);
    drag(el, RIGHT);
    expect(strokes).toEqual([]);
    expect(sent).toEqual([]);
    expect(live).toEqual([]);
  });

  it("a left press pressed during a middle-drag lays down nothing", () => {
    const { el, sent, strokes } = mount(false);
    fireEvent.mouseDown(el, { ...MIDDLE, clientX: 100, clientY: 100 });
    fireEvent.mouseDown(el, { button: 0, buttons: 5, clientX: 110, clientY: 100 });
    fireEvent.mouseMove(el, { buttons: 5, clientX: 150, clientY: 120 });
    fireEvent.mouseUp(el, { button: 0, clientX: 150, clientY: 120 });
    fireEvent.mouseUp(el, { button: 1, clientX: 150, clientY: 120 });
    expect(strokes).toEqual([]);
    expect(sent).toEqual([]);
  });

  it("a middle press does not ask a clone or heal source question either", () => {
    // Heal with no source refuses a stroke with a message; a middle
    // press must not even ask, and a middle ALT press sets no source.
    let asked = 0;
    const picked: unknown[] = [];
    const { el } = mount(true, { blockStroke: () => (asked++, true), onAltPick: (at) => picked.push(at) });
    drag(el, MIDDLE, { altKey: true });
    drag(el, MIDDLE);
    expect(asked).toBe(0);
    expect(picked).toEqual([]);
  });

  it("a left drag still paints one stroke", () => {
    const plain = mount(false);
    drag(plain.el, LEFT);
    expect(plain.strokes).toHaveLength(1);
  });

  it("a streamed left drag still starts and ends its stroke", () => {
    const streamed = mount(true);
    drag(streamed.el, LEFT);
    expect(streamed.live[0]).toBe("start");
    expect(streamed.live[streamed.live.length - 1]).toBe("end");
  });
});

describe("the Polish brush and the selection tools", () => {
  it("Polish: middle and right lay down no region, left does, and a lost release ends it", () => {
    const sent: Command[] = [];
    render(<PolishOverlay state={initialState()} dispatch={(c) => sent.push(c)} maskUrl={null} nodeId="sel_mask" />);
    const el = screen.getByTestId("polish-overlay");
    sized(el);
    drag(el, MIDDLE);
    drag(el, RIGHT);
    expect(sent).toEqual([]);
    // The primary goes down, then a move arrives with no button held:
    // the release happened where this element never heard it.
    fireEvent.mouseDown(el, { ...LEFT, clientX: 100, clientY: 100 });
    fireEvent.mouseMove(el, { buttons: 1, clientX: 120, clientY: 100 });
    fireEvent.mouseMove(el, { buttons: 0, clientX: 300, clientY: 250 });
    fireEvent.mouseMove(el, { buttons: 0, clientX: 320, clientY: 260 });
    expect(sent).toHaveLength(1);
    const region = (sent[0] as Extract<Command, { type: "add_region" }>).region;
    expect(region.kind === "brush" && region.points).toHaveLength(2);
  });

  it.each(["rect", "lasso"])("%s: middle and right draw nothing, left does", (method) => {
    const sent: Command[] = [];
    const node = { id: "sel", type: "heeler.selection_mask", params: {}, regions: [] } as never;
    render(
      <SelectionOverlay
        node={node}
        dispatch={(c: Command) => sent.push(c)}
        method={method}
        op="replace"
        tolerance={0.4}
        smooth={0}
        imageId="img1"
      />,
    );
    const el = screen.getByTestId("selection-overlay");
    sized(el);
    drag(el, MIDDLE);
    drag(el, RIGHT);
    expect(screen.queryByTestId("selection-live")).toBeNull();
    expect(screen.queryByTestId("selection-live-marquee")).toBeNull();
    expect(sent.filter((c) => c.type === "add_region")).toEqual([]);
    drag(el, LEFT);
    expect(sent.filter((c) => c.type === "add_region")).toHaveLength(1);
  });
});

describe("the gizmos", () => {
  it("crop: a middle press on a handle opens no gesture and moves nothing", () => {
    const sent: Command[] = [];
    const node = { id: "crop", type: "heeler.crop_rotate", params: { crop_x: 0.1, crop_y: 0.1, crop_w: 0.8, crop_h: 0.8 } } as never;
    render(<CropOverlay node={node} dispatch={(c) => sent.push(c)} />);
    sized(screen.getByTestId("crop-overlay"));
    for (const id of ["crop-handle-tl", "crop-rect"]) {
      drag(screen.getByTestId(id), MIDDLE);
      drag(screen.getByTestId(id), RIGHT);
    }
    expect(sent).toEqual([]);
    drag(screen.getByTestId("crop-handle-tl"), LEFT);
    expect(sent[0]).toEqual({ type: "begin_gesture", key: "crop.batch" });
  });

  it("transform: a middle press on a corner or the body opens no gesture", () => {
    const sent: Command[] = [];
    render(
      <TransformOverlay
        blendId="blend"
        box={{ x: 0, y: 0, w: 1, h: 1 }}
        quad={[[0.1, 0.1], [0.9, 0.1], [0.9, 0.9], [0.1, 0.9]]}
        mode="transform"
        dispatch={(c) => sent.push(c)}
      />,
    );
    sized(screen.getByTestId("transform-overlay-transform"));
    for (const id of ["transform-handle-0", "transform-body", "transform-rotate"]) {
      drag(screen.getByTestId(id), MIDDLE);
      drag(screen.getByTestId(id), RIGHT);
    }
    expect(sent).toEqual([]);
    drag(screen.getByTestId("transform-handle-0"), LEFT);
    expect(sent[0]).toEqual({ type: "begin_gesture", key: "blend.quad" });
  });

  const RIG =
    '[{"kind":"directional","azimuth":45,"elevation":45,"strength":60,"tx":0.5,"ty":0.5},' +
    '{"kind":"point","px":0.3,"py":0.6,"strength":-50,"height":50,"range":40}]';
  const norm = (e: { clientX: number; clientY: number }) => [e.clientX / 200, e.clientY / 100] as [number, number];

  it("the Depth Lighting rig: a middle or right press grabs no light", () => {
    const s = reduce(initialState(), { type: "set_text_param", id: "keylight", param: "lights", value: RIG });
    const node = s.nodes.find((n) => n.id === "keylight")!;
    const got: Command[] = [];
    render(<KeyLightGizmo state={s} dispatch={(c) => got.push(c)} node={node} norm={norm} />);
    const press = (id: string, b: { button: number; buttons: number }) => {
      screen.getByTestId(id).dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, cancelable: true, clientX: 100, clientY: 50, ...b }));
      window.dispatchEvent(new MouseEvent("pointermove", { clientX: 40, clientY: 30, buttons: b.buttons }));
      window.dispatchEvent(new MouseEvent("pointerup", { button: b.button }));
    };
    for (const id of ["keylight-target-0", "keylight-handle-0", "keylight-handle-1"]) {
      press(id, MIDDLE);
      press(id, RIGHT);
    }
    expect(got).toEqual([]);
    press("keylight-target-0", LEFT);
    expect(got).toContainEqual({ type: "select_keylight", index: 0 });
  });

  it("the focus picker: middle, right and a left chorded onto a middle-drag pick nothing", async () => {
    const s = reduce(initialState(), { type: "toggle_dof_pick" });
    const node = s.nodes.find((n) => n.id === "dof")!;
    const got: Command[] = [];
    render(<DofFocusOverlay state={s} dispatch={(c) => got.push(c)} node={node} norm={norm} />);
    const el = screen.getByTestId("dof-focus-overlay");
    vi.mocked(depthAt).mockClear();
    fireEvent.mouseDown(el, { ...MIDDLE, clientX: 100, clientY: 50 });
    fireEvent.mouseDown(el, { button: 0, buttons: 5, clientX: 100, clientY: 50 });
    fireEvent.mouseDown(el, { ...RIGHT, clientX: 100, clientY: 50 });
    expect(depthAt).not.toHaveBeenCalled();
    fireEvent.mouseDown(el, { ...LEFT, clientX: 100, clientY: 50 });
    expect(depthAt).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(got).toContainEqual({ type: "toggle_dof_pick" }));
  });
});

/** The Viewer over a live reducer, every command recorded. */
function viewerHarness(start: State) {
  const commands: Command[] = [];
  const Harness = () => {
    const [state, setState] = useState(start);
    const send = useCallback((c: Command) => {
      commands.push(c);
      setState((s) => reduce(s, c));
    }, []);
    return <Viewer state={state} dispatch={send} />;
  };
  render(<Harness />);
  return commands;
}

describe("in the viewer", () => {
  it("grid warp: a left press chorded onto a middle-drag picks no handle", () => {
    const commands = viewerHarness({ ...reduce(initialState(), { type: "select_image", id: "4869" }), tool: "gridwarp" });
    const overlay = screen.getByTestId("gridwarp-overlay");
    sized(screen.getByTestId("gridwarp-frame"));
    fireEvent.mouseDown(overlay, { ...MIDDLE, clientX: 100, clientY: 100 });
    fireEvent.mouseDown(overlay, { button: 0, buttons: 5, clientX: 100, clientY: 100 });
    fireEvent.mouseMove(overlay, { buttons: 5, clientX: 140, clientY: 100 });
    fireEvent.mouseUp(overlay, { clientX: 140, clientY: 100 });
    expect(commands.filter((c) => c.type.startsWith("grid_warp"))).toEqual([]);
  });

  it("a held space takes a press away from a light before the light hears it", () => {
    // The rig's handles start on pointerdown, which comes before the
    // mousedown the space pan listens for; a held space must win there
    // too, or SPACE+drag over a light moved the light.
    const s = reduce(
      { ...initialState(), keyLightPick: true },
      { type: "set_text_param", id: "keylight", param: "lights", value: RIG2 },
    );
    const restore = stubStage();
    try {
      const commands = viewerHarness(s);
      fireEvent.load(screen.getByTestId("viewer-image"));
      const target = screen.getByTestId("keylight-target-0");
      fireEvent.keyDown(window, { code: "Space", key: " " });
      target.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, cancelable: true, button: 0, buttons: 1, clientX: 100, clientY: 50 }));
      fireEvent.mouseDown(target, { ...LEFT, clientX: 100, clientY: 50 });
      fireEvent.mouseMove(window, { buttons: 1, clientX: 140, clientY: 80 });
      window.dispatchEvent(new MouseEvent("pointermove", { buttons: 1, clientX: 140, clientY: 80 }));
      fireEvent.mouseUp(window);
      window.dispatchEvent(new MouseEvent("pointerup", {}));
      fireEvent.keyUp(window, { code: "Space", key: " " });
      expect(commands.some((c) => c.type === "select_keylight")).toBe(false);
      expect(commands.some((c) => c.type === "pan_viewer")).toBe(true);
    } finally {
      restore();
    }
  });
});

const RIG2 = '[{"kind":"directional","azimuth":45,"elevation":45,"strength":60,"tx":0.5,"ty":0.5}]';

describe("in the graph", () => {
  function graph() {
    const box: { s: State } = { s: { ...initialState(), nodes: structuredClone(NEUTRAL_NODES), wires: structuredClone(NEUTRAL_WIRES) } };
    const start = box.s;
    const Harness = () => {
      const [s, d] = React.useReducer(reduce, start);
      box.s = s;
      return <NodeEditor state={s} dispatch={d} />;
    };
    render(<Harness />);
    return box;
  }

  it("a middle-drag on a card pans the graph and leaves the card where it was", async () => {
    const box = graph();
    const before = box.s.nodes.find((n) => n.id === "src")!;
    const viewport = screen.getByTestId("graph-viewport").style.transform;
    const card = screen.getByTestId("node-src");
    fireEvent.mouseDown(card, { ...MIDDLE, clientX: 100, clientY: 100 });
    fireEvent.mouseMove(window, { buttons: 4, clientX: 150, clientY: 130 });
    fireEvent.mouseUp(window, { button: 1 });
    await waitFor(() => expect(screen.getByTestId("graph-viewport").style.transform).not.toBe(viewport));
    const after = box.s.nodes.find((n) => n.id === "src")!;
    expect([after.x, after.y]).toEqual([before.x, before.y]);
    expect(box.s.selection).not.toContain("src");
  });

  it("a middle or right press on a port lifts no pipe", () => {
    graph();
    for (const b of [MIDDLE, RIGHT]) {
      fireEvent.mouseDown(screen.getByTestId("out-port-src"), { ...b, clientX: 100, clientY: 100 });
      fireEvent.mouseMove(window, { buttons: b.buttons, clientX: 200, clientY: 150 });
      expect(screen.queryByTestId("wire-drag-ghost")).toBeNull();
      fireEvent.mouseUp(window, { button: b.button });
    }
    fireEvent.mouseDown(screen.getByTestId("out-port-src"), { ...LEFT, clientX: 100, clientY: 100 });
    fireEvent.mouseMove(window, { buttons: 1, clientX: 200, clientY: 150 });
    expect(screen.getByTestId("wire-drag-ghost")).toBeInTheDocument();
    fireEvent.mouseUp(window);
  });

  it("a right press on a card moves nothing", () => {
    const box = graph();
    const before = box.s.nodes.find((n) => n.id === "src")!;
    fireEvent.mouseDown(screen.getByTestId("node-src"), { ...RIGHT, clientX: 100, clientY: 100 });
    fireEvent.mouseMove(window, { buttons: 2, clientX: 160, clientY: 150 });
    fireEvent.mouseUp(window, { button: 2 });
    const after = box.s.nodes.find((n) => n.id === "src")!;
    expect([after.x, after.y]).toEqual([before.x, before.y]);
  });
});

/** The viewer applies its transform only once it knows the stage size
 * and the frame's aspect; jsdom supplies neither. */
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
  const priorDims = ["naturalWidth", "naturalHeight"].map((k) => [k, Object.getOwnPropertyDescriptor(proto, k)] as const);
  for (const [k] of priorDims) Object.defineProperty(proto, k, { configurable: true, get: () => frame });
  return () => {
    (globalThis as { ResizeObserver?: unknown }).ResizeObserver = priorRO;
    for (const [k, d] of priorDims) {
      if (d) Object.defineProperty(proto, k, d);
      else delete (proto as unknown as Record<string, unknown>)[k];
    }
  };
}

describe("in the app", () => {
  it("with a brush armed, a middle-drag pans the photo and paints no stroke; a left drag paints", async () => {
    const restore = stubStage();
    try {
      const user = userEvent.setup();
      render(<App />);
      fireEvent.load(screen.getByTestId("viewer-image"));
      await user.click(screen.getByTestId("add-layer-brush"));
      const overlay = screen.getByTestId("brush-overlay");
      sized(overlay);
      const frame = screen.getByTestId("stage-frame").style.transform;
      fireEvent.mouseDown(overlay, { ...MIDDLE, clientX: 100, clientY: 100 });
      fireEvent.mouseMove(overlay, { buttons: 4, clientX: 140, clientY: 130 });
      fireEvent.mouseMove(window, { buttons: 4, clientX: 140, clientY: 130 });
      fireEvent.mouseUp(overlay, { button: 1, clientX: 140, clientY: 130 });
      fireEvent.mouseUp(window, { button: 1 });
      await waitFor(() => expect(screen.getByTestId("stage-frame").style.transform).not.toBe(frame));
      // A right press paints nothing either.
      fireEvent.mouseDown(overlay, { ...RIGHT, clientX: 100, clientY: 100 });
      fireEvent.mouseMove(overlay, { buttons: 2, clientX: 120, clientY: 110 });
      fireEvent.mouseUp(overlay, { button: 2, clientX: 120, clientY: 110 });
      await user.click(screen.getByRole("tablist", { name: /workspace mode/i }).children[1]);
      fireEvent.mouseDown(screen.getByTestId("node-layer_1_mask"));
      expect(screen.getByTestId("stroke-count")).toHaveTextContent("0 strokes");
      // The control: the same overlay still paints on the left button.
      await user.click(screen.getByRole("tablist", { name: /workspace mode/i }).children[0]);
      const again = screen.getByTestId("brush-overlay");
      sized(again);
      drag(again, LEFT);
      await user.click(screen.getByRole("tablist", { name: /workspace mode/i }).children[1]);
      fireEvent.mouseDown(screen.getByTestId("node-layer_1_mask"));
      expect(screen.getByTestId("stroke-count")).toHaveTextContent("1 stroke");
    } finally {
      restore();
    }
  });

  it("split view: a middle or right drag on the radial apex leaves it where it was", () => {
    render(<App />);
    fireEvent.click(screen.getByTestId("btn-split"));
    fireEvent.click(screen.getByTestId("split-mode-radial"));
    sized(screen.getByTestId("split-view"));
    for (const b of [MIDDLE, RIGHT]) {
      fireEvent.mouseDown(screen.getByTestId("split-radial-center"), { ...b, clientX: 30, clientY: 30 });
      fireEvent.mouseMove(window, { buttons: b.buttons, clientX: 60, clientY: 60 });
      fireEvent.mouseUp(window, { button: b.button });
    }
    expect((screen.getByTestId("split-radial-x") as HTMLInputElement).value).toBe("50");
    fireEvent.mouseDown(screen.getByTestId("split-radial-center"), { ...LEFT, clientX: 200, clientY: 150 });
    fireEvent.mouseMove(window, { buttons: 1, clientX: 300, clientY: 150 });
    fireEvent.mouseUp(window);
    expect((screen.getByTestId("split-radial-x") as HTMLInputElement).value).not.toBe("50");
  });
});
