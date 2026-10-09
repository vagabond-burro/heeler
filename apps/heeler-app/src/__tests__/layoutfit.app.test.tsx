// The window's side of the panel fit, rendered: a small window at 150%
// with the library open in the saved layout. 2026-10-01: "yes, look at
// the cramped layout at 150%".

import { act, fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, onTestFinished } from "vitest";
import { useRef } from "react";
import { App } from "../app";
import { useClearsSibling, useTopBarFit } from "../ui/layoutroom";

/** Sets the window's width and the app zoom for this test only. */
function windowOf(width: number, zoom: number) {
  const before = window.innerWidth;
  const root = document.documentElement.style;
  const zoomBefore = root.getPropertyValue("--chrome-zoom");
  Object.defineProperty(window, "innerWidth", { value: width, configurable: true });
  root.setProperty("--chrome-zoom", String(zoom));
  onTestFinished(() => {
    Object.defineProperty(window, "innerWidth", { value: before, configurable: true });
    if (zoomBefore) root.setProperty("--chrome-zoom", zoomBefore);
    else root.removeProperty("--chrome-zoom");
  });
}

function resizeTo(width: number) {
  act(() => {
    Object.defineProperty(window, "innerWidth", { value: width, configurable: true });
    window.dispatchEvent(new Event("resize"));
  });
}

const px = (el: HTMLElement) => parseFloat(el.style.width);

/** What the row spends beside the center at this zoom, from the widths
 * the panels were drawn at (the rails are 24, dividers 5, the folded
 * strip 26). */
function sideSpend(zoom: number): number {
  let used = 24 * zoom * 2;
  const lib = screen.queryByTestId("browser-panel");
  if (lib) used += px(lib) * zoom + 5;
  const ribbon = screen.queryByTestId("ribbon");
  used += ribbon ? px(ribbon) * zoom + 5 : 26;
  const right = screen.queryByTestId("simple-panel") ?? screen.queryByTestId("inspector");
  if (right) used += px(right) * zoom + 5;
  const exp = screen.queryByTestId("export-panel");
  if (exp) used += px(exp) * zoom;
  return used;
}

/** jsdom lays nothing out: elements report the offsets their data-w /
 * data-x attributes give, for this test only. */
function fakeOffsets() {
  const proto = HTMLElement.prototype;
  const saved = {
    w: Object.getOwnPropertyDescriptor(proto, "offsetWidth")!,
    x: Object.getOwnPropertyDescriptor(proto, "offsetLeft")!,
    c: Object.getOwnPropertyDescriptor(Element.prototype, "clientWidth")!,
  };
  Object.defineProperty(proto, "offsetWidth", { configurable: true, get(this: HTMLElement) { return Number(this.dataset.w ?? 0); } });
  Object.defineProperty(proto, "offsetLeft", { configurable: true, get(this: HTMLElement) { return Number(this.dataset.x ?? 0); } });
  Object.defineProperty(Element.prototype, "clientWidth", { configurable: true, get(this: HTMLElement) { return Number(this.dataset.w ?? 0); } });
  onTestFinished(() => {
    Object.defineProperty(proto, "offsetWidth", saved.w);
    Object.defineProperty(proto, "offsetLeft", saved.x);
    Object.defineProperty(Element.prototype, "clientWidth", saved.c);
  });
}

function Bar({ room }: { room: { width: number; zoom: number } }) {
  const ref = useRef<HTMLDivElement>(null);
  const fit = useTopBarFit(ref, room, "t");
  return (
    <div ref={ref} data-testid="bar" style={{ padding: "0 12px", columnGap: 14, zoom: fit.zoom }}>
      <div data-w="100" data-x="12" />
      <div data-testid="menubar" data-w="400" data-x="126" />
      <div className="center" data-testid="title" data-w="200" style={{ position: "absolute", visibility: fit.titleShown ? undefined : "hidden" }} />
      <div data-w="300" />
    </div>
  );
}

function Hints({ footer, at }: { footer: number; at: number }) {
  const ref = useRef<HTMLDivElement>(null);
  const clear = useClearsSibling(ref, "foot");
  return (
    <div data-w="600">
      <div data-testid="foot" data-x="12" data-w={footer}>
        <span data-x="0" data-w={footer} />
      </div>
      <div ref={ref} data-testid="hints" data-x={at} data-w={600 - at - 12} style={{ visibility: clear ? undefined : "hidden" }} />
    </div>
  );
}

describe("the bars on a small window", () => {
  it("the title bar draws at the zoom that holds its controls, never under 100%", () => {
    fakeOffsets();
    // It needs 12 + 100 + 14 + 400 + 14 + 300 + 12 = 852 px of its own.
    const { rerender } = render(<Bar room={{ width: 1000, zoom: 1.5 }} />);
    expect(screen.getByTestId("bar").style.zoom).toBe(String(Math.floor((1000 / 852) * 1000) / 1000));
    rerender(<Bar room={{ width: 2000, zoom: 1.5 }} />);
    expect(screen.getByTestId("bar").style.zoom).toBe("");
    rerender(<Bar room={{ width: 700, zoom: 1.5 }} />);
    expect(screen.getByTestId("bar").style.zoom).toBe("1");
  });

  it("the centered title hides rather than print over the menus", () => {
    fakeOffsets();
    // The menus end at 526; a 200-wide title centered clears them once
    // the bar is wider than 2 x (526 + 7 + 100).
    const { rerender } = render(<Bar room={{ width: 1200, zoom: 1 }} />);
    expect(screen.getByTestId("title").style.visibility).toBe("hidden");
    rerender(<Bar room={{ width: 1400, zoom: 1 }} />);
    expect(screen.getByTestId("title").style.visibility).toBe("");
  });

  it("key hints step aside when they would print over the node count", () => {
    fakeOffsets();
    const { rerender } = render(<Hints footer={200} at={300} />);
    expect(screen.getByTestId("hints").style.visibility).toBe("");
    rerender(<Hints footer={300} at={300} />);
    expect(screen.getByTestId("hints").style.visibility).toBe("hidden");
  });
});

describe("a small window at 150%", () => {
  it("folds the library and the thumbnail strip so the viewer keeps its minimum", () => {
    windowOf(1000, 1.5);
    render(<App />);
    // The saved layout has the library open; the window cannot hold it.
    expect(screen.queryByTestId("browser-panel")).not.toBeInTheDocument();
    expect(screen.getByTestId("library-bar")).toHaveAttribute("aria-pressed", "false");
    expect(screen.getByTestId("ribbon-collapsed")).toBeInTheDocument();
    expect(1000 - sideSpend(1.5)).toBeGreaterThanOrEqual(320 * 1.5);
  });

  it("brings the saved layout back when the window grows", () => {
    windowOf(1000, 1.5);
    render(<App />);
    expect(screen.queryByTestId("browser-panel")).not.toBeInTheDocument();
    resizeTo(1920);
    expect(screen.getByTestId("browser-panel").style.width).toBe("252px");
    expect(screen.getByTestId("ribbon")).toBeInTheDocument();
    expect(screen.getByTestId("simple-panel").style.width).toBe("320px");
  });

  it("keeps the library the user opens, and folds the strip instead", () => {
    windowOf(1280, 1.5);
    render(<App />);
    const bar = screen.getByTestId("library-bar");
    expect(bar).toHaveAttribute("aria-pressed", "false");
    fireEvent.click(bar);
    expect(screen.getByTestId("browser-panel")).toBeInTheDocument();
    expect(bar).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByTestId("ribbon-collapsed")).toBeInTheDocument();
    // The right panel is never what gives way.
    expect(screen.getByTestId("simple-panel")).toBeInTheDocument();
    expect(1280 - sideSpend(1.5)).toBeGreaterThan(0);
  });

  it("fits Graph and Finish too", () => {
    windowOf(1000, 1.5);
    render(<App />);
    for (const [mode, center] of [["advanced", "node-editor"], ["canvas", "canvas-mode"]]) {
      fireEvent.click(screen.getByTestId(`mode-${mode}`));
      expect(screen.getByTestId(center)).toBeInTheDocument();
      expect(screen.queryByTestId("browser-panel")).not.toBeInTheDocument();
      expect(1000 - sideSpend(1.5)).toBeGreaterThanOrEqual(320 * 1.5);
    }
  });
});
