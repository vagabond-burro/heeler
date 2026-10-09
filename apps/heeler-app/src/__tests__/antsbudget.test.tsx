// The ants' display budget and the engine trace off the interactive
// thread (the assistant review's R7). The selection's coverage is not
// the display's business: the traced loops stay whole.
import { act, render, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ANTS_MAX_CHARS, ANTS_MAX_ISLANDS, ANTS_MAX_POINTS, FIELD, displayAnts, loopArea, traceContours } from "../ui/selectionfield";
import { ANTS_ENGINE_MAX_POINTS, fitAnts, traceMask } from "../ui/maskants";
import { Outline, useMaskAnts } from "../ui/selection";

/** A mask the size of the ones the viewer fetches for a square frame. */
const N = 768;

/** 4096 islands, in 64 sizes so the smallest can be told from the
 * largest: island k is 2 + (k % 8) pixels square. */
function speckled(): Float32Array {
  const f = new Float32Array(N * N);
  for (let iy = 0; iy < 64; iy++) {
    for (let ix = 0; ix < 64; ix++) {
      const side = 2 + ((iy * 64 + ix) % 8);
      for (let y = 0; y < side; y++) for (let x = 0; x < side; x++) f[(iy * 12 + 1 + y) * N + ix * 12 + 1 + x] = 1;
    }
  }
  return f;
}
const points = (loops: [number, number][][]) => loops.reduce((s, l) => s + l.length, 0);

afterEach(() => { vi.useRealTimers(); });

describe("the ants' display budget", () => {
  it("draws a 4096-island mask within the caps and keeps the largest islands", () => {
    const traced = traceMask(speckled(), N, N);
    expect(traced.length).toBe(4096);
    const { loops: shown } = fitAnts(traced, N, N);
    expect(shown.length).toBeLessThanOrEqual(ANTS_MAX_ISLANDS);
    expect(points(shown)).toBeLessThanOrEqual(ANTS_ENGINE_MAX_POINTS);
    // The smallest go first: nothing drawn is smaller than anything cut.
    const smallestKept = Math.min(...shown.map(loopArea));
    const cut = [...traced].sort((a, b) => loopArea(b) - loopArea(a)).slice(ANTS_MAX_ISLANDS);
    expect(Math.max(...cut.map(loopArea))).toBeLessThanOrEqual(smallestKept + 1e-12);
    // The coverage is untouched: the traced loops are still all there.
    expect(traced.length).toBe(4096);
    // And the path the browser is handed stays under its cap per layer.
    const { container } = render(<svg><Outline ants={shown} softEdges={[]} exact /></svg>);
    const over = [...container.querySelectorAll("path.ants-over")].reduce((s, p) => s + (p.getAttribute("d") ?? "").length, 0);
    expect(over).toBeGreaterThan(0);
    expect(over).toBeLessThanOrEqual(ANTS_MAX_CHARS);
  });

  it("a drawn shape's geometry ants keep their own budget", () => {
    const f = new Float32Array(FIELD * FIELD);
    for (let y = 50; y < 100; y++) for (let x = 50; x < 100; x++) f[y * FIELD + x] = 1;
    const traced = traceContours(f);
    expect(displayAnts(traced)).toBe(traced);
    expect(points(displayAnts(traced))).toBeLessThanOrEqual(ANTS_MAX_POINTS);
  });

  it("past the vertex budget the tolerance grows, never a stride through the vertices", () => {
    // A long saw-toothed edge: every tooth is two pixels tall, so a
    // stride would cut straight across the teeth while a tolerance of
    // under a pixel keeps every one of them.
    const [w, h] = [2048, 64];
    const f = new Float32Array(w * h);
    for (let x = 0; x < w; x++) {
      const top = 20 + (x % 4 < 2 ? 0 : 2);
      for (let y = top; y < 44; y++) f[y * w + x] = 1;
    }
    const traced = traceMask(f, w, h);
    const fine = fitAnts(traced, w, h);
    expect(fine.eps).toBeLessThan(0.5);
    const tight = fitAnts(traced, w, h, 600);
    expect(points(tight.loops)).toBeLessThanOrEqual(600);
    expect(tight.eps).toBeGreaterThan(fine.eps);
  });
});

describe("the engine trace", () => {
  it("lands after the render, the previous ants held until the new ones arrive", async () => {
    vi.useFakeTimers();
    const first = { plane: speckled(), w: N, h: N };
    const { result, rerender } = renderHook(({ m }) => useMaskAnts(m), { initialProps: { m: first } });
    // Not traced during the render that asked for it.
    expect(result.current.traced).toEqual([]);
    await act(async () => { await vi.runAllTimersAsync(); });
    expect(result.current.traced.length).toBe(4096);
    const before = result.current;
    const next = new Float32Array(N * N);
    for (let y = 100; y < 300; y++) for (let x = 100; x < 300; x++) next[y * N + x] = 1;
    rerender({ m: { plane: next, w: N, h: N } });
    expect(result.current).toBe(before);
    await act(async () => { await vi.runAllTimersAsync(); });
    expect(result.current.traced.length).toBe(1);
  });
});
