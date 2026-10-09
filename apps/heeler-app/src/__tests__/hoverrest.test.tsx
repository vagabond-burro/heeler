// A hover sampler throttled to one sample every 40 ms still samples where
// the cursor comes to rest. The 26.4.2 branch review found that a move
// inside the window was queued and only taken by the next move or by a
// sample in flight finishing, so a cursor that stopped within 40 ms of
// the last landed sample left the ghost on a hue it had already left.
// The Color Set ghost, the hue curve's ghost and Recolor's share the shape.
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const under = { r: 0.8, g: 0.05, b: 0.05 };
vi.mock("../bridge", async (importOriginal) => {
  const real = (await importOriginal()) as Record<string, unknown>;
  return {
    ...real,
    sampleImage: vi.fn(async () => ({ luma: 0.5, hue: 0, sat: 0.9, ...under, luma_linear: 0.2, source: "toneeq" })),
  };
});

import { App } from "../app";
import { oklabHueChroma } from "../colorsets";

const hueOf = (c: typeof under) => String(Math.round(oklabHueChroma(c.r, c.g, c.b).hue));
const RED = { r: 0.8, g: 0.05, b: 0.05 };
const BLUE = { r: 0.05, g: 0.1, b: 0.8 };
const settle = () => new Promise((r) => setTimeout(r, 150));
// The throttle reads performance.now(). Rendering the app takes longer
// than the 40 ms window, so a real clock almost never reproduces the
// race: the clock is held, then moved 10 ms on for the second move.
let clock = 1000;
vi.spyOn(performance, "now").mockImplementation(() => clock);

describe("a hover sampler at rest", () => {
  it("the Color Set ghost lands on the hue under a cursor that stopped inside the throttle window", async () => {
    Object.assign(under, RED);
    render(<App />);
    fireEvent.click(screen.getByTestId("add-color-set"));
    fireEvent.click(screen.getByTestId("dropper-color-set-1"));
    const overlay = screen.getByTestId("cset-dropper-overlay");
    clock += 1000;
    fireEvent.mouseMove(overlay, { clientX: 40, clientY: 40 });
    await waitFor(() => expect(screen.getByTestId("hue-ghost-1").dataset.hue).toBe(hueOf(RED)));
    Object.assign(under, BLUE);
    clock += 10;
    fireEvent.mouseMove(overlay, { clientX: 90, clientY: 40 });
    await settle();
    expect(screen.getByTestId("hue-ghost-1").dataset.hue).toBe(hueOf(BLUE));
  });

  it("the hue curve's ghost does the same", async () => {
    Object.assign(under, RED);
    const user = userEvent.setup();
    render(<App />);
    await user.click(screen.getByTestId("bw-mode-bw"));
    const curve = screen.getByTestId("bw-hue-curve");
    await user.click(within(curve).getByTestId("bw-pick"));
    const overlay = screen.getByTestId("bw-pick-overlay");
    const ghostAt = () => within(curve).queryByTestId("eq-ghost")?.querySelector("circle")?.getAttribute("cx") ?? null;
    clock += 1000;
    fireEvent.mouseMove(overlay, { clientX: 40, clientY: 40 });
    await waitFor(() => expect(ghostAt()).not.toBeNull());
    const red = ghostAt();
    Object.assign(under, BLUE);
    clock += 10;
    fireEvent.mouseMove(overlay, { clientX: 90, clientY: 40 });
    await settle();
    expect(ghostAt()).not.toBe(red);
  });
});
