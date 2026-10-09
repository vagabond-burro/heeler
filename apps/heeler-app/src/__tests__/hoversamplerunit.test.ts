// The hover sampler on its own (hoversampler.ts): the scheduling the
// three viewer hover ghosts share, without the viewer. The ghosts
// themselves are pinned in hoversampler.test.tsx.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HoverSampler, WINDOW_MS, type HoverPoint, type HoverRead } from "../hoversampler";

let clock = 1000;
let out: { at: HoverPoint; latest: () => boolean; land: () => Promise<void> }[] = [];
let resume = true;
const read: HoverRead = (at, latest) => {
  let land!: () => void;
  const landed = new Promise<void>((r) => { land = r; });
  out.push({ at, latest, land: async () => { land(); await landed; await Promise.resolve(); await Promise.resolve(); } });
  return { landed, resume: () => resume };
};
const xs = () => out.map((s) => s.at[0]);

beforeEach(() => {
  clock = 1000;
  out = [];
  resume = true;
  vi.spyOn(performance, "now").mockImplementation(() => clock);
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe("the hover sampler", () => {
  it("keeps one sample out and only the newest position waiting", async () => {
    const s = new HoverSampler(() => true);
    s.move([1, 0], read);
    clock += 100; s.move([2, 0], read);
    clock += 100; s.move([3, 0], read);
    expect(xs()).toEqual([1]);
    await out[0].land();
    expect(xs()).toEqual([1, 3]);
  });

  it("takes a position queued inside the window as it closes", async () => {
    const s = new HoverSampler(() => true);
    s.move([1, 0], read);
    await out[0].land();
    clock += 10; s.move([2, 0], read);
    vi.advanceTimersByTime(WINDOW_MS - 11);
    expect(xs()).toEqual([1]);
    vi.advanceTimersByTime(1);
    expect(xs()).toEqual([1, 2]);
  });

  it("tells a sample whether it is still the newest", async () => {
    const s = new HoverSampler(() => true);
    s.move([1, 0], read);
    expect(out[0].latest()).toBe(true);
    await out[0].land();
    clock += 100; s.move([2, 0], read);
    expect(out[0].latest()).toBe(false);
    expect(out[1].latest()).toBe(true);
  });

  it("starts nothing for a read with nothing to read, and stays free", () => {
    const s = new HoverSampler(() => true);
    s.move([1, 0], () => null);
    clock += 100; s.move([2, 0], read);
    expect(xs()).toEqual([2]);
  });

  it("leaves the waiting position when the sample out says it may not go", async () => {
    const s = new HoverSampler(() => true);
    s.move([1, 0], read);
    clock += 100; s.move([2, 0], read);
    resume = false;
    await out[0].land();
    expect(xs()).toEqual([1]);
  });

  it("the window's timer leaves the position while the site is not ready", async () => {
    let ready = true;
    const s = new HoverSampler(() => ready);
    s.move([1, 0], read);
    await out[0].land();
    clock += 10; s.move([2, 0], read);
    ready = false;
    vi.advanceTimersByTime(100);
    expect(xs()).toEqual([1]);
  });

  it("drop forgets the waiting position, and dispose stops the timer", async () => {
    const a = new HoverSampler(() => true);
    a.move([1, 0], read);
    clock += 100; a.move([2, 0], read);
    a.drop();
    await out[0].land();
    expect(xs()).toEqual([1]);
    const b = new HoverSampler(() => true);
    b.move([5, 0], read);
    await out[1].land();
    clock += 10; b.move([6, 0], read);
    b.dispose();
    vi.advanceTimersByTime(100);
    expect(xs()).toEqual([1, 5]);
  });
});
