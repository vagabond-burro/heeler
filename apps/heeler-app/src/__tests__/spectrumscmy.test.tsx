// 2026-10-02: "The work you did for curves where a modifier key
// switches between RGB and CMY. I think we should have the same thing
// for Spectrums > Histogram. And for Spectrums > RGB Parade have a CMY
// toggle button next to the EV button."
//
// The histogram's row turns over the way Curves' does (Option-click or Option+Enter on
// the composite chip). The parade's CMY chip is built but hidden (PARADE_INK_CHIP)
// since the owner looked at it. Both are views: C is the red counts read as ink, 0% ink
// at the left of the histogram and at the bottom of the parade.

import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { initialState } from "../data";
import { PARADE_INK_CHIP, Spectrums, drawEvScale, drawHistogram, readout, type Frame } from "../ui/spectrum";
import { histogram, LEVELS } from "../spectrums";
import { modLabel } from "../platform";

const KEYS = ["spectrumKind", "spectrumChannel", "spectrumEvLines", "spectrumHistInk", "spectrumParadeInk"];
const clearPrefs = () => KEYS.forEach((k) => localStorage.removeItem(`heeler.ui.${k}`));
beforeEach(clearPrefs);
afterEach(() => {
  cleanup();
  clearPrefs();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

/** A frame of `n` pixels of each listed color, in order. */
function frameOf(...runs: [number, [number, number, number]][]): Frame {
  const total = runs.reduce((a, [n]) => a + n, 0);
  const pixels = new Uint8ClampedArray(total * 4);
  let i = 0;
  for (const [n, [r, g, b]] of runs) {
    for (let k = 0; k < n; k++, i++) {
      pixels.set([r, g, b, 255], i * 4);
    }
  }
  return { pixels, w: total, h: 1 };
}

describe("the histogram's CMY readout", () => {
  // A quarter of the frame at level 0 in red, the rest at the top.
  const f = frameOf([2, [0, 255, 255]], [6, [255, 255, 255]]);
  const h = histogram(f.pixels, 1);

  it("reads 0% ink at the left, where the brightest level is", () => {
    const left = readout("histogram", "rgb", f, h, { x: 0, y: 0.5 }, { inkHist: true })!;
    expect(left).toBe("ink 0% · C 75.00% · M 100.00% · Y 100.00%");
    // The RGB face reads the same spot as level 0, where red has its quarter.
    expect(readout("histogram", "rgb", f, h, { x: 0, y: 0.5 })!).toBe(
      "level 0 · R 25.00% · G 0.00% · B 0.00%",
    );
  });

  it("reads 100% ink at the right, level 0", () => {
    expect(readout("histogram", "rgb", f, h, { x: 1, y: 0.5 }, { inkHist: true })!).toBe(
      "ink 100% · C 25.00% · M 0.00% · Y 0.00%",
    );
  });

  it("names one ink and its count when one channel shows", () => {
    expect(readout("histogram", "r", f, h, { x: 1, y: 0.5 }, { inkHist: true })!).toBe(
      "ink 100% · C 25.00% (2 px)",
    );
    expect(readout("histogram", "b", f, h, { x: 0, y: 0.5 }, { inkHist: true })!).toBe(
      "ink 0% · Y 100.00% (8 px)",
    );
  });

  it("names the bin it counts: a level in the middle reads as its ink", () => {
    const mid = frameOf([4, [64, 64, 64]]);
    const mh = histogram(mid.pixels, 1);
    // Level 64 sits at 1 - 64/255 of the way across the ink axis.
    const x = 1 - 64 / (LEVELS - 1);
    expect(readout("histogram", "r", mid, mh, { x, y: 0.5 }, { inkHist: true })!).toBe(
      `ink ${Math.round((1 - 64 / 255) * 100)}% · C 100.00% (4 px)`,
    );
  });

  it("keeps LUM on the light axis in the CMY face", () => {
    expect(readout("histogram", "luma", f, h, { x: 1, y: 0.5 }, { inkHist: true })).toBe(
      readout("histogram", "luma", f, h, { x: 1, y: 0.5 }),
    );
  });
});

describe("the parade's CMY readout", () => {
  const f = frameOf([10, [200, 100, 50]]);

  it("names the inks and reads the ink upward from 0% at the bottom", () => {
    expect(readout("parade", "rgb", f, null, { x: 0.1, y: 1 }, { inkParade: true })).toBe(
      "Cyan · x 3 of 10 · ink 0%",
    );
    expect(readout("parade", "rgb", f, null, { x: 0.5, y: 0 }, { inkParade: true })).toBe(
      "Magenta · x 5 of 10 · ink 100%",
    );
    expect(readout("parade", "rgb", f, null, { x: 0.9, y: 0.25 }, { inkParade: true })).toBe(
      `Yellow · x 6 of 10 · ink ${Math.round((1 - Math.round(0.25 * 255) / 255) * 100)}%`,
    );
  });

  it("is the light band turned over: the same height reads the complement", () => {
    // A quarter of the way down is 75% light and 25% ink.
    expect(readout("parade", "rgb", f, null, { x: 0.1, y: 0.25 })).toContain(`level ${Math.round(0.75 * 255)}`);
    expect(readout("parade", "rgb", f, null, { x: 0.1, y: 0.75 }, { inkParade: true })).toContain("ink 25%");
  });

  it("leaves the waveform and the histogram alone", () => {
    expect(readout("waveform", "rgb", f, null, { x: 0.5, y: 0 }, { inkParade: true })).toContain("level 255");
    const h = histogram(f.pixels, 1);
    expect(readout("histogram", "rgb", f, h, { x: 0, y: 0.5 }, { inkParade: true })).toContain("level 0");
  });
});

describe("turning the histogram's row over", () => {
  const alt = modLabel("alt");

  it("Option-click on RGB shows CMY, C, M, Y and LUM, and Option-click on CMY goes back", () => {
    render(<Spectrums state={initialState()} />);
    const rgb = screen.getByTestId("spectrum-channel-rgb");
    expect(rgb.getAttribute("data-hint")).toMatch(new RegExp(`^All three channels together; ${alt}-click shows the histogram as CMY ink`));
    fireEvent.click(rgb, { altKey: true });
    expect(screen.queryByTestId("spectrum-channel-rgb")).toBeNull();
    expect(["cmy", "c", "m", "y", "luma"].map((id) => screen.getByTestId(`spectrum-channel-${id}`).textContent)).toEqual([
      "CMY",
      "C",
      "M",
      "Y",
      "LUM",
    ]);
    // The composite stays the live channel across the flip.
    expect(screen.getByTestId("spectrum-channel-cmy")).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(screen.getByTestId("spectrum-channel-cmy"), { altKey: true });
    expect(screen.getByTestId("spectrum-channel-rgb")).toHaveTextContent("RGB");
    expect(screen.queryByTestId("spectrum-channel-cmy")).toBeNull();
  });

  it("Option+Enter on the focused composite chip does the same, and a plain Enter does not", () => {
    render(<Spectrums state={initialState()} />);
    const rgb = screen.getByTestId("spectrum-channel-rgb");
    fireEvent.keyDown(rgb, { key: "Enter" });
    expect(screen.getByTestId("spectrum-channel-rgb")).toBeInTheDocument();
    fireEvent.keyDown(rgb, { key: "Enter", altKey: true });
    expect(screen.getByTestId("spectrum-channel-cmy")).toBeInTheDocument();
    fireEvent.keyDown(screen.getByTestId("spectrum-channel-cmy"), { key: " ", altKey: true });
    expect(screen.getByTestId("spectrum-channel-rgb")).toBeInTheDocument();
  });

  it("C picks the red channel: the stored channel is the same in both faces", () => {
    render(<Spectrums state={initialState()} />);
    fireEvent.click(screen.getByTestId("spectrum-channel-rgb"), { altKey: true });
    fireEvent.click(screen.getByTestId("spectrum-channel-c"));
    expect(screen.getByTestId("spectrum-channel-c")).toHaveAttribute("aria-pressed", "true");
    expect(JSON.parse(localStorage.getItem("heeler.ui.spectrumChannel")!)).toBe("r");
    // An Option-click on a single channel just picks it.
    fireEvent.click(screen.getByTestId("spectrum-channel-m"), { altKey: true });
    expect(screen.getByTestId("spectrum-channel-m")).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(screen.getByTestId("spectrum-channel-cmy"), { altKey: true });
    expect(screen.getByTestId("spectrum-channel-g")).toHaveAttribute("aria-pressed", "true");
  });

  it("the face is remembered: the pop-out opens on it and the panel comes back on the window's", () => {
    const panel = render(<Spectrums state={initialState()} />);
    fireEvent.click(screen.getByTestId("spectrum-channel-rgb"), { altKey: true });
    panel.unmount();
    const win = render(<Spectrums state={initialState()} fill />);
    expect(screen.getByTestId("spectrum-channel-cmy")).toBeInTheDocument();
    fireEvent.click(screen.getByTestId("spectrum-channel-cmy"), { altKey: true });
    win.unmount();
    render(<Spectrums state={initialState()} />);
    expect(screen.getByTestId("spectrum-channel-rgb")).toBeInTheDocument();
  });
});

describe("the parade's CMY chip, hidden for now", () => {
  // 2026-10-02: "just hide the button. If it gets requested as a
  // feature it would be easy to turn back on." PARADE_INK_CHIP brings
  // it back; these hold it hidden until then.
  it("is not shown for the parade, in the panel or the window", () => {
    expect(PARADE_INK_CHIP).toBe(false);
    for (const fill of [false, true]) {
      const r = render(<Spectrums state={initialState()} fill={fill} />);
      fireEvent.click(screen.getByTestId("spectrum-parade"));
      expect(screen.getByRole("button", { name: "EV" })).toBeInTheDocument();
      expect(screen.queryByTestId("spectrum-parade-cmy")).toBeNull();
      r.unmount();
      clearPrefs();
    }
  });
});

describe("the EV scale on the ink axis", () => {
  const linesAt = (ink: boolean) => {
    const ys: number[] = [];
    const labels: { text: string; y: number }[] = [];
    const ctx = new Proxy({} as Record<string, unknown>, {
      get: (t, k: string) => {
        if (k in t) return t[k];
        if (k === "measureText") return (s: string) => ({ width: s.length * 7 });
        if (k === "moveTo") return (_x: number, y: number) => ys.push(y);
        if (k === "fillText") return (s: string, _x: number, y: number) => labels.push({ text: s, y });
        return () => {};
      },
      set: (t, k: string, v) => {
        t[k] = v;
        return true;
      },
    });
    drawEvScale(ctx as unknown as CanvasRenderingContext2D, 400, 600, 1, ink);
    return { ys, labels };
  };

  it("puts each stop on the same level, turned over, with the same labels", () => {
    const light = linesAt(false);
    const ink = linesAt(true);
    expect(ink.ys).toHaveLength(light.ys.length);
    // A line at height y in light sits at 600 - y in ink, give or take
    // the half pixel each is rounded to.
    light.ys.forEach((y, i) => expect(Math.abs(ink.ys[i] - (600 - y))).toBeLessThanOrEqual(1.01));
    expect(ink.labels.map((l) => l.text)).toEqual(light.labels.map((l) => l.text));
    // Middle gray encodes to about 46%: below the middle of the light
    // plot, so above the middle of the ink one (canvas y runs down).
    const mid = (s: typeof ink) => s.labels.find((l) => l.text === "0 EV")!.y;
    expect(mid(light)).toBeGreaterThan(300);
    expect(mid(ink)).toBeLessThan(300);
  });

  it("still drops a crowded label and never middle gray, at a short plot", () => {
    const short = (() => {
      const labels: string[] = [];
      let strokes = 0;
      const ctx = new Proxy({} as Record<string, unknown>, {
        get: (t, k: string) =>
          k in t
            ? t[k]
            : k === "measureText"
              ? (s: string) => ({ width: s.length * 7 })
              : k === "fillText"
                ? (s: string) => labels.push(s)
                : k === "stroke"
                  ? () => strokes++
                  : () => {},
        set: (t, k: string, v) => {
          t[k] = v;
          return true;
        },
      });
      drawEvScale(ctx as unknown as CanvasRenderingContext2D, 400, 90, 1, true);
      return { labels, strokes };
    })();
    expect(short.strokes).toBe(7);
    expect(short.labels).toContain("0 EV");
    expect(short.labels.length).toBeLessThan(7);
  });
});

describe("the clipping figures on the flipped axis", () => {
  /** Hands the Spectrums a frame: an Image that loads at once and a
   * canvas whose pixels are `f`'s, since jsdom draws nothing. */
  function feed(f: Frame) {
    vi.stubGlobal(
      "Image",
      class {
        onload: (() => void) | null = null;
        onerror: (() => void) | null = null;
        naturalWidth = f.w;
        naturalHeight = f.h;
        set src(_v: string) {
          queueMicrotask(() => this.onload?.());
        }
      },
    );
    const ctx = new Proxy({} as Record<string, unknown>, {
      get: (t, k: string) =>
        k in t ? t[k] : k === "getImageData" ? () => ({ data: f.pixels }) : k === "measureText" ? () => ({ width: 0 }) : () => {},
      set: (t, k: string, v) => {
        t[k] = v;
        return true;
      },
    });
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(
      () => ctx as unknown as CanvasRenderingContext2D,
    );
  }

  it("keep their meaning and sit in the order the axis runs", async () => {
    // A quarter black, three quarters white.
    feed(frameOf([2, [0, 0, 0]], [6, [255, 255, 255]]));
    render(<Spectrums state={initialState()} frame="data:frame" />);
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    const order = () =>
      Array.from(screen.getByTestId("spectrum-clipping").querySelectorAll("span")).map((s) => s.textContent!.slice(0, 1));
    expect(order()).toEqual(["▼", "▲"]);
    // CMY face: black is 100% ink, at the right, so its figure goes last.
    fireEvent.click(screen.getByTestId("spectrum-channel-rgb"), { altKey: true });
    expect(order()).toEqual(["▲", "▼"]);
    expect(screen.getByTestId("spectrum-clip-black")).toHaveTextContent("▼25.0%");
    // LUM keeps the light axis, so the order comes back with it.
    fireEvent.click(screen.getByTestId("spectrum-channel-luma"));
    expect(order()).toEqual(["▼", "▲"]);
    // The parade's axis is vertical: the figures stay as they are.
    fireEvent.click(screen.getByTestId("spectrum-channel-cmy"));
    fireEvent.click(screen.getByTestId("spectrum-parade"));
    expect(order()).toEqual(["▼", "▲"]);
  });
});

describe("the histogram's ink outline", () => {
  /** The outline each fill traces, as the canvas was told it. */
  function outlines(channel: "rgb" | "r" | "luma", ink: boolean) {
    const paths: [number, number][][] = [];
    const ctx = {
      beginPath: () => paths.push([]),
      moveTo: (x: number, y: number) => paths[paths.length - 1].push([x, y]),
      lineTo: (x: number, y: number) => paths[paths.length - 1].push([x, y]),
      closePath: () => {},
      fill: () => {},
      fillStyle: "",
      globalCompositeOperation: "source-over",
    } as unknown as CanvasRenderingContext2D;
    // A dark frame: everything piled near level 40, nothing bright.
    const px = new Uint8ClampedArray(64 * 4);
    for (let i = 0; i < 64; i++) px.set([40 + (i % 8), 40, 40 + (i % 3), 255], i * 4);
    drawHistogram(ctx, 256, 100, histogram(px), channel, 1, ink);
    return paths;
  }

  it("runs left to right in both faces, so the fill never crosses itself", () => {
    for (const ink of [false, true]) {
      for (const ch of ["rgb", "r", "luma"] as const) {
        for (const path of outlines(ch, ink)) {
          for (let k = 1; k < path.length; k++) expect(path[k][0]).toBeGreaterThanOrEqual(path[k - 1][0]);
        }
      }
    }
  });

  it("puts a dark frame's pile on the ink side: the right in CMY, the left in RGB", () => {
    const peakX = (path: [number, number][]) =>
      path.reduce((best, p) => (p[1] < best[1] ? p : best))[0];
    expect(peakX(outlines("r", false)[0])).toBeLessThan(128);
    expect(peakX(outlines("r", true)[0])).toBeGreaterThan(128);
  });
});

it("follows a histogram face changed in the other window", () => {
  render(<Spectrums state={initialState()} />);
  localStorage.setItem("heeler.ui.spectrumHistInk", "true");
  fireEvent(window, Object.assign(new Event("storage"), { key: "heeler.ui.spectrumHistInk", newValue: "true", storageArea: localStorage }));
  expect(screen.getByTestId("spectrum-channel-cmy")).toBeInTheDocument();
  localStorage.removeItem("heeler.ui.spectrumHistInk");
  fireEvent(window, Object.assign(new Event("storage"), { key: null, storageArea: localStorage }));
  expect(screen.getByTestId("spectrum-channel-rgb")).toBeInTheDocument();
});
