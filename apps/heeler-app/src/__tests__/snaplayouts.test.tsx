// Windows 11 Snap Layouts for the custom maximize button: the native
// overlay that answers Windows' hit test has to be told where the
// button is, and its hover has to come back to the button. The
// report: "the maximize button does not trigger desktop window
// manager".
import { render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setMacForTests } from "../platform";

const handlers: Record<string, (e: { payload: unknown }) => void> = {};
const unlistenMock = vi.fn();
// The listener has to be the window's own: a label-targeted emit from
// Rust never reaches a plain listen() on the global bus.
vi.mock("@tauri-apps/api/webviewWindow", () => ({
  getCurrentWebviewWindow: () => ({
    listen: vi.fn(async (name: string, cb: (e: { payload: unknown }) => void) => {
      handlers[name] = cb;
      return unlistenMock;
    }),
  }),
}));

const invokeMock = vi.fn<(cmd: string, args?: unknown) => Promise<unknown>>(async () => undefined);

function withTauri() {
  (window as any).__TAURI_INTERNALS__ = { invoke: invokeMock };
}

function rectCalls(): unknown[] {
  return invokeMock.mock.calls.filter((c) => c[0] === "set_maximize_button_rect").map((c) => c[1]);
}

function button(r: { left: number; top: number; right: number; bottom: number }): HTMLButtonElement {
  const el = document.createElement("button");
  el.getBoundingClientRect = () =>
    ({
      ...r,
      x: r.left,
      y: r.top,
      width: r.right - r.left,
      height: r.bottom - r.top,
      toJSON() {},
    }) as DOMRect;
  document.body.appendChild(el);
  return el;
}

const tick = () => new Promise((r) => setTimeout(r, 0));

describe("the maximize button's rect", () => {
  it("lands in physical pixels, rounded outward", async () => {
    const { physicalRect } = await import("../snaplayouts");
    expect(physicalRect({ left: 10.4, top: 7.5, right: 49.5, bottom: 42.1 }, 1)).toEqual({ x: 10, y: 7, w: 40, h: 36 });
    expect(physicalRect({ left: 10.4, top: 7.5, right: 49.5, bottom: 42.1 }, 2)).toEqual({ x: 20, y: 15, w: 79, h: 70 });
  });
});

describe("watching the maximize button", () => {
  beforeEach(() => {
    invokeMock.mockClear();
    unlistenMock.mockClear();
    for (const k of Object.keys(handlers)) delete handlers[k];
    setMacForTests(false);
  });
  afterEach(() => {
    delete (window as any).__TAURI_INTERNALS__;
    setMacForTests(null);
    document.body.innerHTML = "";
  });

  it("does nothing outside Tauri", async () => {
    const { watchMaximizeButton } = await import("../snaplayouts");
    const stop = watchMaximizeButton(button({ left: 0, top: 0, right: 34, bottom: 30 }), () => {});
    expect(typeof stop).toBe("function");
    stop();
    await tick();
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it("does nothing on a Mac, where the traffic lights are the OS's own", async () => {
    withTauri();
    setMacForTests(true);
    const { watchMaximizeButton } = await import("../snaplayouts");
    watchMaximizeButton(button({ left: 0, top: 0, right: 34, bottom: 30 }), () => {})();
    await tick();
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it("reports on mount, again on resize, relays hover, and clears on teardown", async () => {
    withTauri();
    const { watchMaximizeButton, MAXIMIZE_HOVER_EVENT } = await import("../snaplayouts");
    const el = button({ left: 2378, top: 7.5, right: 2417.1, bottom: 42 });
    const hovers: boolean[] = [];
    const stop = watchMaximizeButton(el, (h) => hovers.push(h));
    // The report rides the bridge's lazy import of the Tauri core API,
    // which can take more than one macrotask the first time a test file
    // touches it: wait for the condition, never a fixed tick. (A single
    // setTimeout raced the import and flaked red on a green tree.)
    await vi.waitFor(() => expect(rectCalls()).toEqual([{ x: 2378, y: 7, w: 40, h: 35 }]));

    // The window grew: the button rides the right edge.
    el.getBoundingClientRect = () => ({ left: 3000, top: 7.5, right: 3039.1, bottom: 42 }) as DOMRect;
    window.dispatchEvent(new Event("resize"));
    await vi.waitFor(() =>
      expect(rectCalls()).toEqual([
        { x: 2378, y: 7, w: 40, h: 35 },
        { x: 3000, y: 7, w: 40, h: 35 },
      ]),
    );

    // The overlay owns the mouse now; its hover comes back as an event.
    expect(handlers[MAXIMIZE_HOVER_EVENT]).toBeTypeOf("function");
    handlers[MAXIMIZE_HOVER_EVENT]({ payload: true });
    handlers[MAXIMIZE_HOVER_EVENT]({ payload: false });
    expect(hovers).toEqual([true, false]);

    stop();
    await vi.waitFor(() => expect(unlistenMock).toHaveBeenCalledTimes(1));
    await vi.waitFor(() =>
      expect(rectCalls()[rectCalls().length - 1]).toEqual({ x: 0, y: 0, w: 0, h: 0 }),
    );
    const before = rectCalls().length;
    window.dispatchEvent(new Event("resize"));
    await tick();
    expect(rectCalls().length).toBe(before);
  });

  it("a teardown that beats the listener still unlistens it", async () => {
    withTauri();
    const { watchMaximizeButton } = await import("../snaplayouts");
    const stop = watchMaximizeButton(button({ left: 0, top: 0, right: 34, bottom: 30 }), () => {});
    stop();
    await vi.waitFor(() => expect(unlistenMock).toHaveBeenCalledTimes(1));
  });
});

describe("the window controls", () => {
  afterEach(() => {
    setMacForTests(null);
    vi.doUnmock("../snaplayouts");
    vi.resetModules();
  });

  it("hand their maximize button to the watcher for as long as it is on screen", async () => {
    setMacForTests(false);
    const stop = vi.fn();
    const watch = vi.fn<(el: HTMLElement | null, onHover: (h: boolean) => void) => () => void>(() => stop);
    vi.doMock("../snaplayouts", () => ({ watchMaximizeButton: watch, MAXIMIZE_HOVER_EVENT: "heeler:maximize-hover" }));
    const { App } = await import("../app");
    const view = render(<App />);
    expect(watch).toHaveBeenCalledTimes(1);
    expect(watch.mock.calls[0][0]).toBe(screen.getByTestId("win-toggleMaximize"));
    // The watcher's hover lights the button the way the mouse does.
    const onHover = watch.mock.calls[0][1] as (h: boolean) => void;
    onHover(true);
    expect(screen.getByTestId("win-toggleMaximize").style.background).not.toBe("transparent");
    onHover(false);
    expect(screen.getByTestId("win-toggleMaximize").style.background).toBe("transparent");
    view.unmount();
    expect(stop).toHaveBeenCalledTimes(1);
  });
});
