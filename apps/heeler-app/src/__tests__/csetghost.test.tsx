// The Color Set eyedropper's hover ghost (2026-10-06: "It would be nice
// if when hover pixels with the eyedropper that we see a ghosted
// preview on the color bar of the hue the the eyedropper is hover").
// The mock bridge's sampleImage answers nothing, so these answer with a
// color. The 2026-08-31 ruling still stands: a hover moves only the
// ghost, never the band.
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";

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
import { initialState } from "../data";
import { reduce } from "../state";
import { HueBandStrip } from "../ui/colorsets";

const red = Math.round(oklabHueChroma(0.8, 0.05, 0.05).hue);
const params = () => {
  const strip = screen.getByTestId("hue-center-1");
  return [strip.style.left, screen.getByTestId("hue-band-1").style.width];
};

describe("the Color Set eyedropper's hover ghost", () => {
  it("rides the strip at the hue under the cursor and leaves the band alone", async () => {
    Object.assign(under, { r: 0.8, g: 0.05, b: 0.05 });
    render(<App />);
    fireEvent.click(screen.getByTestId("add-color-set"));
    expect(screen.queryByTestId("hue-ghost-1")).toBeNull();
    fireEvent.click(screen.getByTestId("dropper-color-set-1"));
    const band = params();
    fireEvent.mouseMove(screen.getByTestId("cset-dropper-overlay"), { clientX: 40, clientY: 40 });
    await waitFor(() => expect(screen.getByTestId("hue-ghost-1").dataset.hue).toBe(String(red)));
    expect(params()).toEqual(band);
  });

  it("keeps its last hue over a neutral, and goes when the cursor leaves the picture", async () => {
    Object.assign(under, { r: 0.8, g: 0.05, b: 0.05 });
    render(<App />);
    fireEvent.click(screen.getByTestId("add-color-set"));
    fireEvent.click(screen.getByTestId("dropper-color-set-1"));
    const overlay = screen.getByTestId("cset-dropper-overlay");
    fireEvent.mouseMove(overlay, { clientX: 40, clientY: 40 });
    await waitFor(() => expect(screen.getByTestId("hue-ghost-1").dataset.hue).toBe(String(red)));
    Object.assign(under, { r: 0.3, g: 0.3, b: 0.3 });
    await new Promise((r) => setTimeout(r, 60));
    fireEvent.mouseMove(overlay, { clientX: 80, clientY: 40 });
    await new Promise((r) => setTimeout(r, 60));
    expect(screen.getByTestId("hue-ghost-1").dataset.hue).toBe(String(red));
    fireEvent.mouseLeave(overlay, { relatedTarget: document.body });
    await waitFor(() => expect(screen.queryByTestId("hue-ghost-1")).toBeNull());
  });

  it("goes with the picker: disarming, Escape and re-arming all start clean", async () => {
    Object.assign(under, { r: 0.8, g: 0.05, b: 0.05 });
    render(<App />);
    fireEvent.click(screen.getByTestId("add-color-set"));
    const dropper = screen.getByTestId("dropper-color-set-1");
    fireEvent.click(dropper);
    fireEvent.mouseMove(screen.getByTestId("cset-dropper-overlay"), { clientX: 40, clientY: 40 });
    await waitFor(() => expect(screen.getByTestId("hue-ghost-1")).toBeTruthy());
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByTestId("hue-ghost-1")).toBeNull();
    fireEvent.click(dropper);
    expect(screen.queryByTestId("hue-ghost-1")).toBeNull();
  });
});

describe("the hover hue in state", () => {
  it("is only held while a set's dropper is armed, and arming starts it empty", () => {
    let s = reduce(initialState(), { type: "add_color_set" });
    expect(reduce(s, { type: "set_cset_hover", hue: 120 }).csetHoverHue).toBeNull();
    s = reduce(s, { type: "arm_cset_dropper", n: 1 });
    s = reduce(s, { type: "set_cset_hover", hue: 120 });
    expect(s.csetHoverHue).toBe(120);
    expect(reduce(s, { type: "arm_cset_dropper", n: 1 }).csetHoverHue).toBeNull();
    expect(reduce(s, { type: "remove_color_set", n: 1 }).csetHoverHue).toBeNull();
  });
});

describe("the strip's ghost", () => {
  it("sits at its hue, wears that hue, and takes no pointer", () => {
    render(<HueBandStrip center={30} range={60} gestureKey="g" testSuffix="t" dispatch={() => {}} onCenter={() => {}} ghost={270} />);
    const ghost = screen.getByTestId("hue-ghost-t");
    expect(ghost.style.left).toBe("calc(75% - 3px)");
    expect(ghost.style.background).toMatch(/^oklch\(0\.7 0\.15 270(deg)?\)$/);
    expect(ghost.style.pointerEvents).toBe("none");
  });

  it("is absent with no hue", () => {
    render(<HueBandStrip center={30} gestureKey="g" testSuffix="t" dispatch={() => {}} onCenter={() => {}} />);
    expect(screen.queryByTestId("hue-ghost-t")).toBeNull();
  });
});
