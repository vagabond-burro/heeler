// The canvas header's Navigator and Loupe: the two toggles and the
// Navigator's corner menu, the rectangle the Navigator draws and the pan
// its drag makes, showing only while the photograph is bigger than the
// canvas, and the Loupe's magnification and radius under the wheel and
// the keys.
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { initialState } from "../data";
import { reduce, type Command, type State } from "../state";
import { COMMANDS, bindingMap, conflicts } from "../hotkeys";
import { runCommand } from "../commands";
import { uiSettingsCommands, uiSettingsSnapshot } from "../settings";
import { Viewer } from "../ui/viewer";
import { Loupe, Navigator, ViewAidButtons } from "../ui/viewaids";
import {
  LOUPE_MAG_RANGE,
  LOUPE_RADIUS_RANGE,
  insideQuad,
  loupeLabel,
  loupeMagStep,
  loupeWheel,
  navigatorBox,
  overflowsStage,
  panToCenter,
  stageToFrame,
  viewCenter,
  viewQuad,
  type StageView,
} from "../ui/viewaidsparts";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const withPrefs = (prefs: Partial<State["prefs"]>, s: State = initialState()) => reduce(s, { type: "set_prefs", prefs });

// A 1000 x 500 frame laid out 2000 x 1000 on an 800 x 600 canvas.
const zoomed = (over: Partial<StageView> = {}): StageView => ({
  stage: { w: 800, h: 600 },
  base: { w: 1000, h: 500 },
  scale: 2,
  pan: { x: 0, y: 0 },
  rotation: 0,
  ...over,
});

describe("the header toggles", () => {
  it("turn each aid on and off, lit while on", () => {
    let s = initialState();
    const sent: Command[] = [];
    const dispatch = (c: Command) => {
      sent.push(c);
      s = reduce(s, c);
    };
    const { rerender } = render(<ViewAidButtons state={s} dispatch={dispatch} />);
    expect(screen.getByTestId("btn-navigator")).toHaveAttribute("data-active", "false");
    expect(screen.getByTestId("btn-loupe")).toHaveAttribute("data-active", "false");
    fireEvent.click(screen.getByTestId("btn-navigator"));
    fireEvent.click(screen.getByTestId("btn-loupe"));
    rerender(<ViewAidButtons state={s} dispatch={dispatch} />);
    expect(screen.getByTestId("btn-navigator")).toHaveAttribute("data-active", "true");
    expect(screen.getByTestId("btn-loupe")).toHaveAttribute("data-active", "true");
    expect(sent).toEqual([
      { type: "set_prefs", prefs: { navigatorOn: true } },
      { type: "set_prefs", prefs: { loupeOn: true } },
    ]);
    fireEvent.click(screen.getByTestId("btn-loupe"));
    expect(s.prefs.loupeOn).toBe(false);
  });

  it("name the Loupe's key in its hint, through the live binding", () => {
    render(<ViewAidButtons state={initialState()} dispatch={vi.fn()} />);
    expect(screen.getByTestId("btn-loupe")).toHaveAttribute("data-hint-cmd", "view.loupe");
    expect(screen.getByTestId("btn-navigator")).toHaveAttribute("data-hint-cmd", "view.navigator");
  });

  it("persist with the settings, corner, size, magnification and radius too", () => {
    const s = withPrefs({ navigatorOn: true, navigatorCorner: "tl", navigatorSize: 30, loupeOn: true, loupeMagnification: 6, loupeRadius: 120 });
    const json = JSON.stringify(uiSettingsSnapshot(s));
    const back = uiSettingsCommands(json).reduce(reduce, initialState());
    expect(back.prefs).toMatchObject({ navigatorOn: true, navigatorCorner: "tl", navigatorSize: 30, loupeOn: true, loupeMagnification: 6, loupeRadius: 120 });
  });

  it("start off, and a hand-edited settings file cannot put them out of range", () => {
    const s = initialState();
    expect(s.prefs).toMatchObject({ navigatorOn: false, navigatorCorner: "br", loupeOn: false });
    const bad = withPrefs({ navigatorCorner: "middle" as never, navigatorSize: 900, loupeMagnification: 0, loupeRadius: "big" as never });
    expect(bad.prefs.navigatorCorner).toBe("br");
    expect(bad.prefs.navigatorSize).toBe(40);
    expect(bad.prefs.loupeMagnification).toBe(LOUPE_MAG_RANGE[0]);
    expect(bad.prefs.loupeRadius).toBe(90);
  });
});

describe("the Navigator's corner menu", () => {
  it("opens on a right-click and sets the corner", () => {
    const dispatch = vi.fn();
    render(<ViewAidButtons state={initialState()} dispatch={dispatch} />);
    expect(screen.queryByTestId("navigator-corner-menu")).toBeNull();
    fireEvent.contextMenu(screen.getByTestId("btn-navigator"));
    const menu = screen.getByTestId("navigator-corner-menu");
    expect([...menu.querySelectorAll("button")].map((b) => b.textContent)).toEqual(["Top Left", "Top Right", "Bottom Left", "Bottom Right"]);
    expect(screen.getByTestId("navigator-corner-br")).toHaveAttribute("aria-checked", "true");
    fireEvent.click(screen.getByTestId("navigator-corner-tr"));
    expect(dispatch).toHaveBeenCalledWith({ type: "set_prefs", prefs: { navigatorCorner: "tr" } });
    expect(screen.queryByTestId("navigator-corner-menu")).toBeNull();
    // A right-click does not toggle the Navigator itself.
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId("btn-navigator")).toHaveFocus();
  });

  it("opens from the keyboard, moves through its choices and returns focus", () => {
    render(<ViewAidButtons state={initialState()} dispatch={vi.fn()} />);
    const button = screen.getByTestId("btn-navigator");
    fireEvent.keyDown(button, { key: "ArrowDown" });
    const menu = screen.getByTestId("navigator-corner-menu");
    expect(screen.getByTestId("navigator-corner-br")).toHaveFocus();
    fireEvent.keyDown(menu, { key: "ArrowUp" });
    expect(screen.getByTestId("navigator-corner-bl")).toHaveFocus();
    fireEvent.keyDown(menu, { key: "Home" });
    expect(screen.getByTestId("navigator-corner-tl")).toHaveFocus();
    fireEvent.keyDown(menu, { key: "Escape" });
    expect(screen.queryByTestId("navigator-corner-menu")).toBeNull();
    expect(button).toHaveFocus();
  });

  it("puts the Navigator in that corner", () => {
    for (const corner of ["tl", "tr", "bl", "br"] as const) {
      cleanup();
      render(<Navigator view={zoomed()} src="frame" corner={corner} size={20} dispatch={vi.fn()} />);
      const nav = screen.getByTestId("navigator");
      expect(nav.style[corner[0] === "t" ? "top" : "bottom"]).toBe("10px");
      expect(nav.style[corner[1] === "l" ? "left" : "right"]).toBe("10px");
    }
  });
});

describe("the Navigator's rectangle", () => {
  it("is the canvas on the frame", () => {
    // 2000 x 1000 on screen, centered: the 800 x 600 canvas sees the
    // middle 40 percent across and 60 percent down.
    const q = viewQuad(zoomed());
    expect(q[0][0]).toBeCloseTo(0.3);
    expect(q[0][1]).toBeCloseTo(0.2);
    expect(q[2][0]).toBeCloseTo(0.7);
    expect(q[2][1]).toBeCloseTo(0.8);
    // Panned 200 px right, the view sees 10 percent further left.
    const p = viewQuad(zoomed({ pan: { x: 200, y: 0 } }));
    expect(p[0][0]).toBeCloseTo(0.2);
    expect(viewCenter(zoomed({ pan: { x: 200, y: 0 } }))[0]).toBeCloseTo(0.4);
  });

  it("turns with the view", () => {
    // A quarter turn: the canvas's 800 across runs down the frame.
    const v = zoomed({ rotation: 90 });
    const q = viewQuad(v);
    const xs = q.map(([x]) => x);
    const ys = q.map(([, y]) => y);
    expect(Math.max(...xs) - Math.min(...xs)).toBeCloseTo(600 / 2000);
    expect(Math.max(...ys) - Math.min(...ys)).toBeCloseTo(800 / 1000);
  });

  it("is where panToCenter puts the view, at any turn", () => {
    for (const rotation of [0, 30, 90, 200]) {
      const v = zoomed({ rotation });
      const pan = panToCenter(v, 0.25, 0.7);
      const [x, y] = viewCenter({ ...v, pan });
      expect(x).toBeCloseTo(0.25);
      expect(y).toBeCloseTo(0.7);
      // And stageToFrame is its inverse at the middle.
      expect(stageToFrame({ ...v, pan }, 400, 300)[0]).toBeCloseTo(0.25);
    }
  });

  it("holds the middle of the view on the frame", () => {
    const v = zoomed();
    expect(viewCenter({ ...v, pan: panToCenter(v, -1, 2) })).toEqual([expect.closeTo(0), expect.closeTo(1)]);
  });

  it("knows a press inside it from one outside", () => {
    const q = viewQuad(zoomed());
    expect(insideQuad(q, 0.5, 0.5)).toBe(true);
    expect(insideQuad(q, 0.1, 0.5)).toBe(false);
  });

  it("sizes the thumbnail to the frame's shape inside the percent", () => {
    expect(navigatorBox({ w: 800, h: 600 }, 2, 25)).toEqual({ w: 200, h: 100 });
    expect(navigatorBox({ w: 800, h: 600 }, 0.5, 25)).toEqual({ w: 75, h: 150 });
    expect(navigatorBox({ w: 0, h: 0 }, 2, 25)).toEqual({ w: 0, h: 0 });
    expect(navigatorBox({ w: 800, h: 0 }, 2, 25)).toEqual({ w: 0, h: 0 });
  });
});

describe("dragging on the Navigator", () => {
  // jsdom has no PointerEvent: a MouseEvent under the pointer event's
  // name carries the button and the coordinates.
  const press = (el: Element | Window, type: string, init: MouseEventInit) =>
    act(() => {
      el.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, ...init }));
    });
  const mount = (view: StageView) => {
    const dispatch = vi.fn();
    const { rerender } = render(<Navigator view={view} src="frame" corner="br" size={25} dispatch={dispatch} />);
    const nav = screen.getByTestId("navigator");
    // The thumbnail: 200 x 100 at (500, 400).
    nav.getBoundingClientRect = () => ({ left: 500, top: 400, width: 200, height: 100, right: 700, bottom: 500, x: 500, y: 400, toJSON: () => ({}) });
    const update = (next: StageView, src = "frame") => rerender(<Navigator view={next} src={src} corner="br" size={25} dispatch={dispatch} />);
    return { nav, dispatch, update };
  };

  it("pans the canvas with the rectangle, from where it was grabbed", () => {
    const v = zoomed();
    const { nav, dispatch } = mount(v);
    expect(nav.style.width).toBe("200px");
    // Grab the rectangle a little left of its middle (0.45, 0.5)...
    press(nav, "pointerdown", { button: 0, clientX: 590, clientY: 450 });
    // ...the press alone moves nothing.
    expect(dispatch).toHaveBeenLastCalledWith({ type: "set_viewer_pan", x: expect.closeTo(0), y: expect.closeTo(0) });
    // Drag 20 thumbnail px right: a tenth of the frame, 200 screen px.
    press(window, "pointermove", { buttons: 1, clientX: 610, clientY: 450 });
    expect(dispatch).toHaveBeenLastCalledWith({ type: "set_viewer_pan", x: expect.closeTo(-200), y: expect.closeTo(0) });
    press(window, "pointerup", {});
    dispatch.mockClear();
    press(window, "pointermove", { buttons: 1, clientX: 650, clientY: 450 });
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("centers the view on a press outside the rectangle", () => {
    const { nav, dispatch } = mount(zoomed());
    // (0.1, 0.5): 40 percent of 2000 left of the middle.
    press(nav, "pointerdown", { button: 0, clientX: 520, clientY: 450 });
    expect(dispatch).toHaveBeenLastCalledWith({ type: "set_viewer_pan", x: expect.closeTo(800), y: expect.closeTo(0) });
    press(window, "pointerup", {});
  });

  it("stops when a lost release leaves no primary button held", () => {
    const { nav, dispatch } = mount(zoomed());
    press(nav, "pointerdown", { button: 0, clientX: 590, clientY: 450 });
    dispatch.mockClear();
    press(window, "pointermove", { buttons: 0, clientX: 610, clientY: 450 });
    press(window, "pointermove", { buttons: 1, clientX: 620, clientY: 450 });
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("stops on blur, when Fit hides it and when the photograph changes", () => {
    const { nav, dispatch, update } = mount(zoomed());
    press(nav, "pointerdown", { button: 0, clientX: 590, clientY: 450 });
    dispatch.mockClear();
    press(window, "blur", {});
    press(window, "pointermove", { buttons: 1, clientX: 610, clientY: 450 });
    expect(dispatch).not.toHaveBeenCalled();

    press(nav, "pointerdown", { button: 0, clientX: 590, clientY: 450 });
    dispatch.mockClear();
    update(zoomed({ scale: 0.8 }));
    press(window, "pointermove", { buttons: 1, clientX: 610, clientY: 450 });
    expect(dispatch).not.toHaveBeenCalled();

    update(zoomed());
    press(nav, "pointerdown", { button: 0, clientX: 590, clientY: 450 });
    dispatch.mockClear();
    update(zoomed(), "next-frame");
    press(window, "pointermove", { buttons: 1, clientX: 610, clientY: 450 });
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("lands the pan on the view without adding up or making history", () => {
    const before = initialState();
    let s = reduce(reduce(before, { type: "set_viewer_pan", x: 120, y: -40 }), { type: "set_viewer_pan", x: 130, y: -40 });
    expect(s.view.pan).toEqual({ x: 130, y: -40 });
    s = reduce(s, { type: "set_prefs", prefs: { navigatorOn: true, loupeOn: true } });
    expect(s.undoStack).toBe(before.undoStack);
  });
});

describe("showing only zoomed past the canvas", () => {
  it("is the frame on screen bigger than the canvas", () => {
    expect(overflowsStage(zoomed())).toBe(true);
    expect(overflowsStage(zoomed({ scale: 0.8 }))).toBe(false);
    // Fit's own rounding is not overflow.
    expect(overflowsStage(zoomed({ scale: 0.8, base: { w: 1000.3, h: 500 } }))).toBe(false);
    // Taller than the canvas alone is enough.
    expect(overflowsStage({ ...zoomed({ scale: 1 }), base: { w: 400, h: 700 } })).toBe(true);
    // A turn that stands the frame up can push it past.
    expect(overflowsStage(zoomed({ scale: 0.75, rotation: 0 }))).toBe(false);
    expect(overflowsStage(zoomed({ scale: 0.75, rotation: 90 }))).toBe(true);
  });

  it("in the viewer: none at Fit, up once zoomed in, none with the button off", () => {
    stubStage();
    const fit = withPrefs({ navigatorOn: true });
    mountViewer(fit);
    expect(screen.queryByTestId("navigator")).toBeNull();
    mountViewer({ ...fit, view: { ...fit.view, zoomScale: 4 } });
    expect(screen.getByTestId("navigator")).toBeInTheDocument();
    mountViewer({ ...initialState(), view: { ...fit.view, zoomScale: 4 } });
    expect(screen.queryByTestId("navigator")).toBeNull();
  });
});

describe("the Loupe and the wheel", () => {
  const wheel = (over: Partial<WheelEvent>) => ({ deltaX: 0, deltaY: -100, shiftKey: false, altKey: false, ctrlKey: false, metaKey: false, ...over });

  it("scroll changes its magnification, Ctrl+scroll its radius", () => {
    const up = loupeWheel(wheel({}), false, 0.0015);
    expect(up?.kind).toBe("mag");
    expect(up!.factor).toBeGreaterThan(1);
    expect(loupeWheel(wheel({ deltaY: 100 }), false, 0.0015)!.factor).toBeLessThan(1);
    expect(loupeWheel(wheel({ ctrlKey: true }), false, 0.0015)?.kind).toBe("radius");
    // On a Mac Ctrl is Command, and the physical Control of a pinch is a zoom.
    expect(loupeWheel(wheel({ metaKey: true }), true, 0.0015)?.kind).toBe("radius");
    expect(loupeWheel(wheel({ ctrlKey: true }), true, 0.0015)?.kind).toBe("mag");
    // The inverted wheel preference flips it too.
    expect(loupeWheel(wheel({}), false, 0.0015, true)!.factor).toBeLessThan(1);
  });

  it("leaves Shift's pan and the rotations to the canvas", () => {
    expect(loupeWheel(wheel({ shiftKey: true }), false, 0.0015)).toBeNull();
    expect(loupeWheel(wheel({ shiftKey: true, altKey: true }), false, 0.0015)).toBeNull();
    expect(loupeWheel(wheel({ ctrlKey: true, altKey: true }), false, 0.0015)).toBeNull();
  });

  it("in the viewer: the wheel moves the Loupe, not the canvas", () => {
    stubStage();
    const s = withPrefs({ loupeOn: true });
    const dispatch = mountViewer(s);
    const raf = vi.spyOn(window, "requestAnimationFrame");
    fireEvent.wheel(screen.getByTestId("viewer-stage"), { deltaY: -100 });
    const mag = dispatch.mock.calls.map(([c]) => c).find((c: Command) => c.type === "set_prefs");
    expect(mag?.prefs.loupeMagnification).toBeGreaterThan(3);
    fireEvent.wheel(screen.getByTestId("viewer-stage"), { deltaY: -100, ...(navigator.platform.startsWith("Mac") ? { metaKey: true } : { ctrlKey: true }) });
    const radius = dispatch.mock.calls.map(([c]) => c).filter((c: Command) => c.type === "set_prefs").pop();
    expect(radius?.prefs.loupeRadius).toBeGreaterThan(90);
    // No canvas zoom or pan was queued.
    expect(raf).not.toHaveBeenCalled();
    expect(dispatch.mock.calls.some(([c]) => c.type === "zoom_viewer" || c.type === "pan_viewer")).toBe(false);
    expect(screen.getByTestId("loupe-label")).toHaveTextContent("3×");
    raf.mockRestore();
  });

  it("stops at its ends", () => {
    const s = withPrefs({ loupeMagnification: 99, loupeRadius: 1 });
    expect(s.prefs.loupeMagnification).toBe(LOUPE_MAG_RANGE[1]);
    expect(s.prefs.loupeRadius).toBe(LOUPE_RADIUS_RANGE[0]);
  });

  it("claims wheel ticks at its ends without writing an unchanged preference", () => {
    stubStage();
    const s = withPrefs({ loupeOn: true, loupeMagnification: LOUPE_MAG_RANGE[1], loupeRadius: LOUPE_RADIUS_RANGE[1] });
    const dispatch = mountViewer(s);
    dispatch.mockClear();
    fireEvent.wheel(screen.getByTestId("viewer-stage"), { deltaY: -100 });
    fireEvent.wheel(screen.getByTestId("viewer-stage"), { deltaY: -100, ...(navigator.platform.startsWith("Mac") ? { metaKey: true } : { ctrlKey: true }) });
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("prints its magnification, and what that is in photograph pixels", () => {
    expect(loupeLabel(3, null)).toBe("3×");
    expect(loupeLabel(2.46, 50)).toBe("2.5× · 123%");
    expect(loupeLabel(12.4, 25)).toBe("12× · 310%");
  });

  it("takes no pointer events, so tools beneath keep working", () => {
    stubStage();
    mountViewer(withPrefs({ loupeOn: true }));
    expect(screen.getByTestId("loupe").style.pointerEvents).toBe("none");
  });
});

describe("the Loupe's canvas lifecycle", () => {
  const rect = (left: number, top: number, width: number, height: number) =>
    ({ left, top, width, height, right: left + width, bottom: top + height, x: left, y: top, toJSON: () => ({}) }) as DOMRect;

  function harness() {
    const pending = new Map<number, FrameRequestCallback>();
    let next = 0;
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      pending.set(++next, callback);
      return next;
    });
    vi.spyOn(window, "cancelAnimationFrame").mockImplementation((id) => pending.delete(id));
    const flush = () => {
      const callbacks = [...pending.values()];
      pending.clear();
      act(() => callbacks.forEach((callback) => callback(0)));
    };
    const ctx = {
      filter: "none",
      imageSmoothingEnabled: true,
      setTransform: vi.fn(),
      clearRect: vi.fn(),
      fillRect: vi.fn(),
      translate: vi.fn(),
      scale: vi.fn(),
      rotate: vi.fn(),
      drawImage: vi.fn(),
    } as unknown as CanvasRenderingContext2D;
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(() => ctx);
    const stage = document.createElement("div");
    stage.getBoundingClientRect = () => rect(0, 0, 800, 600);
    const frame = document.createElement("div");
    frame.getBoundingClientRect = () => rect(200, 150, 400, 200);
    const img = document.createElement("img");
    const patch = document.createElement("img");
    const stageRef = { current: stage };
    const frameRef = { current: frame };
    const imgRef = { current: img };
    const patchRef = { current: patch };
    const element = (filter = "none", currentStage = stage) => (
      <Loupe
        stageRef={{ current: currentStage }}
        frameRef={frameRef}
        imgRef={imgRef}
        patchRef={patchRef}
        patchRect={[0.25, 0.25, 0.5, 0.5]}
        view={zoomed()}
        mag={3}
        radius={90}
        truePct={200}
        frameWidth={1000}
        filter={filter}
      />
    );
    return { pending, flush, ctx, stage, frame, img, patch, stageRef, element };
  }

  it("clears an old filter and sizes its backing store for the display", () => {
    vi.stubGlobal("devicePixelRatio", 2);
    const h = harness();
    Object.defineProperties(h.img, { complete: { configurable: true, value: true }, naturalWidth: { configurable: true, value: 1000 } });
    const { rerender } = render(h.element("brightness(1.2)"));
    h.flush();
    act(() => h.stage.dispatchEvent(new MouseEvent("pointermove", { clientX: 400, clientY: 300, bubbles: true })));
    h.flush();
    expect(h.ctx.filter).toBe("brightness(1.2)");
    expect((screen.getByTestId("loupe-glass") as HTMLCanvasElement).width).toBe(360);
    rerender(h.element());
    h.flush();
    expect(h.ctx.filter).toBe("none");
  });

  it("redraws a stationary pointer when the frame and sharp patch decode", () => {
    const h = harness();
    Object.defineProperties(h.img, { complete: { configurable: true, value: false }, naturalWidth: { configurable: true, value: 0 } });
    Object.defineProperties(h.patch, { complete: { configurable: true, value: false }, naturalWidth: { configurable: true, value: 0 } });
    render(h.element());
    act(() => h.stage.dispatchEvent(new MouseEvent("pointermove", { clientX: 400, clientY: 300, bubbles: true })));
    h.flush();
    expect(h.ctx.drawImage).not.toHaveBeenCalled();
    Object.defineProperties(h.img, { complete: { configurable: true, value: true }, naturalWidth: { configurable: true, value: 1000 } });
    fireEvent.load(h.img);
    h.flush();
    expect(h.ctx.drawImage).toHaveBeenCalledTimes(1);
    Object.defineProperties(h.patch, { complete: { configurable: true, value: true }, naturalWidth: { configurable: true, value: 500 } });
    fireEvent.load(h.patch);
    h.flush();
    // One draw for the base and one for the sharp patch.
    expect(h.ctx.drawImage).toHaveBeenCalledTimes(3);
  });

  it("moves its native listeners when the stage element changes", () => {
    const h = harness();
    const nextStage = document.createElement("div");
    nextStage.getBoundingClientRect = () => rect(100, 50, 800, 600);
    const { rerender } = render(h.element());
    h.flush();
    rerender(h.element("none", nextStage));
    h.flush();
    act(() => h.stage.dispatchEvent(new MouseEvent("pointermove", { clientX: 400, clientY: 300, bubbles: true })));
    expect(h.pending.size).toBe(0);
    act(() => nextStage.dispatchEvent(new MouseEvent("pointermove", { clientX: 500, clientY: 350, bubbles: true })));
    h.flush();
    expect(screen.getByTestId("loupe").style.transform).toBe("translate(310px, 210px)");
  });
});

describe("the Loupe's keys", () => {
  const run = (id: string, s: State) => {
    let out = s;
    const handled = runCommand(id, s, (c) => (out = reduce(out, c)));
    return { handled, out };
  };

  it("L turns it on and off, on a key nothing else uses", () => {
    expect(COMMANDS.find((c) => c.id === "view.loupe")?.binding).toBe("L");
    expect(bindingMap({}).get("L")).toEqual(["view.loupe"]);
    for (const ids of conflicts({}).values()) expect(ids.some((id) => id.startsWith("view.loupe"))).toBe(false);
    const on = run("view.loupe", initialState()).out;
    expect(on.prefs.loupeOn).toBe(true);
    expect(run("view.loupe", on).out.prefs.loupeOn).toBe(false);
  });

  it("the zoom keys step its magnification while it is up, and the canvas's otherwise", () => {
    const s = withPrefs({ loupeOn: true });
    const { out } = run("view.zoom.in", s);
    expect(out.prefs.loupeMagnification).toBe(4);
    expect(out.view.zoomScale).toBe(s.view.zoomScale);
    expect(run("view.zoom.out", s).out.prefs.loupeMagnification).toBe(2);
    expect(loupeMagStep(16, 1)).toBe(16);
    expect(loupeMagStep(1.5, -1)).toBe(1.5);
    const off = run("view.zoom.in", initialState()).out;
    expect(off.view.zoomScale).toBeGreaterThan(1);
    expect(off.prefs.loupeMagnification).toBe(3);
  });

  it("Ctrl+Shift with the zoom keys sizes it, only while it is up", () => {
    expect(COMMANDS.find((c) => c.id === "view.loupe.bigger")?.binding).toBe("Ctrl+Shift+=");
    expect(COMMANDS.find((c) => c.id === "view.loupe.smaller")?.binding).toBe("Ctrl+Shift+-");
    const s = withPrefs({ loupeOn: true });
    expect(run("view.loupe.bigger", s).out.prefs.loupeRadius).toBeGreaterThan(90);
    expect(run("view.loupe.smaller", s).out.prefs.loupeRadius).toBeLessThan(90);
    expect(run("view.loupe.bigger", initialState()).handled).toBe(false);
  });

  it("does not dispatch at the magnification or radius limit", () => {
    const s = withPrefs({ loupeOn: true, loupeMagnification: LOUPE_MAG_RANGE[1], loupeRadius: LOUPE_RADIUS_RANGE[1] });
    const dispatch = vi.fn();
    expect(runCommand("view.zoom.in", s, dispatch)).toBe(true);
    expect(runCommand("view.loupe.bigger", s, dispatch)).toBe(true);
    expect(dispatch).not.toHaveBeenCalled();
  });
});

function stubStage() {
  vi.stubGlobal("ResizeObserver", class {
    constructor(private callback: ResizeObserverCallback) {}
    observe(target: Element) {
      if (target.getAttribute("data-testid") === "viewer-stage")
        this.callback([{ contentRect: { width: 1000, height: 700 } } as ResizeObserverEntry], this as unknown as ResizeObserver);
    }
    disconnect() {}
    unobserve() {}
  });
}

function mountViewer(s: State) {
  cleanup();
  const dispatch = vi.fn();
  render(<Viewer state={s} dispatch={dispatch} previewUrl="proxy" />);
  const img = screen.getByTestId("viewer-image");
  Object.defineProperties(img, { naturalWidth: { configurable: true, value: 1500 }, naturalHeight: { configurable: true, value: 1000 } });
  fireEvent.load(img);
  return dispatch;
}
