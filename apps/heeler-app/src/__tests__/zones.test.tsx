import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

vi.mock("../bridge", async (importOriginal) => {
  const real = (await importOriginal()) as Record<string, unknown>;
  return {
    ...real,
    // The engine's answer to a placement: a stop up for one spot, and a
    // development of 80 with a second.
    placeZone: vi.fn(async (_s: unknown, spots: { target: number }[]) => ({
      exposure: 1.0,
      contrast: spots.length > 1 ? 80 : null,
      // Every spot lands where it was asked, unless a test says not.
      landed: spots.map((sp) => landedAt.shift() ?? sp.target),
    })),
    // The bars' plain render of the chain's end (item 4): a 2x1 gray
    // pair, encoded, so the bins are exactly two zones.
    nodeThumbs: vi.fn(async (_s: unknown, ids: string[]) => Object.fromEntries(ids.map((id) => [id, PLAIN_THUMB]))),
  };
});

/** Where the next placements come to rest, when a test wants a miss. */
const landedAt: number[] = [];
/** A data URL the bars can draw: replaced per test through the canvas
 * mock below, since jsdom has no real canvas. */
const PLAIN_THUMB = "data:image/png;base64,plain";

import { App } from "../app";
import { ZONES, ZONE_V, placementWord, zoneCentre, zoneOf } from "../blackwhite";
import { nodeThumbs } from "../bridge";
import { BARS_EDGE } from "../ui/zones";
import { clearLog, getEntries } from "../log";
import { initialState } from "../data";
import { anyPickerArmed, previewTarget, reduce } from "../state";

describe("the Zone System's ruler math", () => {
  it("mirrors the engine: Zone V is encoded 18% gray, the ends are black and white, the steps are equal either side", () => {
    // to_display(0.18) in sRGB.
    expect(ZONE_V).toBeCloseTo(1.055 * Math.pow(0.18, 1 / 2.4) - 0.055, 5);
    expect(zoneCentre(0)).toBe(0);
    expect(zoneCentre(5)).toBeCloseTo(ZONE_V, 6);
    expect(zoneCentre(10)).toBeCloseTo(1, 6);
    for (let k = 1; k < ZONES; k++) expect(zoneCentre(k)).toBeGreaterThan(zoneCentre(k - 1));
    for (let k = 0; k < ZONES; k++) expect(zoneOf(zoneCentre(k))).toBe(k);
    const edge = (zoneCentre(3) + zoneCentre(4)) / 2;
    expect(zoneOf(edge - 1e-3)).toBe(3);
    expect(zoneOf(edge + 1e-3)).toBe(4);
  });
});

describe("the zone views and the placement picker", () => {
  it("the eye and the hover name their targets on any photograph, one view at a time", () => {
    let s = initialState();
    s = reduce(s, { type: "toggle_zones_view" });
    expect(previewTarget(s)).toBe("__zones__");
    s = reduce(s, { type: "set_zone_hover", zone: 3 });
    expect(previewTarget(s)).toBe("__zones__@3");
    s = reduce(s, { type: "set_zone_hover", zone: null });
    s = reduce(s, { type: "toggle_depth_view" });
    expect(s.zonesView).toBe(false);
    expect(previewTarget(s)).toBe("__depth__");
    // Color or mono alike: the Zone System is about tone.
    expect(previewTarget(reduce(initialState(), { type: "toggle_zones_view" }))).toBe("__zones__");
  });

  it("arms from a zone, keeps the first spot through a change of zone, and is put away by Escape's disarm", () => {
    let s = initialState();
    s = reduce(s, { type: "arm_zone_place", zone: 3 });
    expect(s.zonePlace).toEqual({ zone: 3, first: null });
    expect(anyPickerArmed(s)).toBe(true);
    s = reduce(s, { type: "set_zone_place_first", first: { x: 0.2, y: 0.3, zone: 3 } });
    // The first spot spends the zone: the next move is the ruler's.
    expect(s.zonePlace).toEqual({ zone: null, first: { x: 0.2, y: 0.3, zone: 3 } });
    s = reduce(s, { type: "arm_zone_place", zone: 7 });
    expect(s.zonePlace).toEqual({ zone: 7, first: { x: 0.2, y: 0.3, zone: 3 } });
    // The same zone again with no first spot puts it down; with one it does not.
    s = reduce(s, { type: "arm_zone_place", zone: 7 });
    expect(s.zonePlace?.zone).toBe(7);
    s = reduce(s, { type: "disarm_pickers" });
    expect(s.zonePlace).toBeNull();
    s = reduce(s, { type: "arm_zone_place", zone: 5 });
    s = reduce(s, { type: "arm_zone_place", zone: 5 });
    expect(s.zonePlace).toBeNull();
  });

  it("the ruler shows eleven zones, hovers them onto the frame, and a click then a spot writes Exposure; a second spot writes the development", async () => {
    const user = userEvent.setup();
    render(<App />);
    // In the Exposure section, on a color photograph, folded until opened.
    expect(screen.queryByTestId("bw-zone-ruler")).toBeNull();
    await user.click(screen.getByTestId("bw-zones-fold"));
    const ruler = screen.getByTestId("bw-zone-ruler");
    expect(screen.getByTestId("slider-exposure").parentElement).toContainElement(screen.getByTestId("bw-zones"));
    const zones = within(ruler).getAllByRole("button");
    expect(zones.length).toBe(ZONES);
    expect(zones[5]).toHaveAccessibleName("Zone V");
    fireEvent.mouseEnter(zones[3]);
    // The frame's target follows the hover (read through the state the App holds).
    await user.click(zones[3]);
    expect(zones[3]).toHaveAttribute("aria-pressed", "true");
    const overlay = screen.getByTestId("zone-place-overlay");
    fireEvent.mouseDown(overlay, { button: 0, clientX: 30, clientY: 30 });
    // The first spot lands: Exposure moved, the zone is spent, and the
    // photograph takes no click until the ruler names the next zone; the
    // help line says so (2026-09-14: "Not even the status line is telling
    // me what to do next").
    await waitFor(() => expect(screen.queryByTestId("zone-place-overlay")).toBeNull());
    expect(screen.getByTestId("zone-place-pin")).toBeVisible();
    const exposure = within(screen.getByTestId("slider-exposure")).getByRole("slider");
    expect(Number(exposure.getAttribute("aria-valuenow"))).toBeCloseTo(1, 1);
    expect(screen.getByTestId("bw-zones-help").textContent).toMatch(/NEXT: click the zone/);
    expect(screen.getByTestId("bw-zones-help").textContent).toMatch(/Exposure > Luminance/);
    // A second zone and a second spot: Exposure's Contrast lands, the picker goes down.
    await user.click(within(screen.getByTestId("bw-zone-ruler")).getAllByRole("button")[7]);
    expect(screen.getByTestId("zone-place-overlay")).toHaveAttribute("data-hint", expect.stringMatching(/Exposure > Luminance/));
    fireEvent.mouseDown(screen.getByTestId("zone-place-overlay"), { button: 0, clientX: 80, clientY: 80 });
    await waitFor(() => expect(screen.queryByTestId("zone-place-overlay")).toBeNull());
    // Two sliders carry the contrast id (Exposure's, Color's): the one
    // beside Exposure's own slider is the development.
    const contrast = within(within(screen.getByTestId("slider-exposure").parentElement as HTMLElement).getByTestId("slider-contrast")).getByRole("slider");
    expect(Number(contrast.getAttribute("aria-valuenow"))).toBeCloseTo(80, 0);
    // No reset of Zones' own (2026-09-14): Undo and Exposure's are the ways back.
    expect(screen.queryByTestId("bw-zones-reset")).toBeNull();
  });

  it("the Exposure section's reset drops the placement with the dials", async () => {
    const user = userEvent.setup();
    render(<App />);
    const exposure = () => Number(within(screen.getByTestId("slider-exposure")).getByRole("slider").getAttribute("aria-valuenow"));
    await user.click(screen.getByTestId("bw-zones-fold"));
    await user.click(within(screen.getByTestId("bw-zone-ruler")).getAllByRole("button")[3]);
    fireEvent.mouseDown(screen.getByTestId("zone-place-overlay"), { button: 0, clientX: 30, clientY: 30 });
    await waitFor(() => expect(exposure()).toBeCloseTo(1, 1));
    await user.click(screen.getByTestId("reset-exposure"));
    expect(screen.queryByTestId("zone-place-overlay")).toBeNull();
    expect(screen.getByTestId("bw-zone-ruler")).not.toBeNull();
  });

  it("the fold opens closed and toggles", () => {
    let s = initialState();
    expect(s.zonesOpen).toBe(false);
    s = reduce(s, { type: "toggle_zones_fold" });
    expect(s.zonesOpen).toBe(true);
  });
});

describe("the placement says where a spot came to rest (review 2026-09-15, item 3)", () => {
  it("is silent on a landing and names the miss and its zone", () => {
    expect(placementWord(zoneCentre(3), zoneCentre(3) + 0.01, "Exposure > Exposure")).toBe("");
    expect(placementWord(zoneCentre(5), undefined, "Exposure > Exposure")).toBe("");
    const miss = placementWord(zoneCentre(5), zoneCentre(2), "Exposure > Exposure");
    expect(miss).toMatch(/Out of Exposure > Exposure's reach/);
    expect(miss).toMatch(/came to rest on Zone II\./);
  });

  it("the log warns of a miss instead of calling it a landing", async () => {
    const user = userEvent.setup();
    render(<App />);
    clearLog();
    await user.click(screen.getByTestId("bw-zones-fold"));
    const zones = within(screen.getByTestId("bw-zone-ruler")).getAllByRole("button");
    landedAt.push(zoneCentre(2));
    await user.click(zones[5]);
    fireEvent.mouseDown(screen.getByTestId("zone-place-overlay"), { button: 0, clientX: 30, clientY: 30 });
    await waitFor(() => expect(getEntries().some((e) => /placed as far as it goes/.test(e.message))).toBe(true));
    const entry = getEntries().find((e) => /placed as far as it goes/.test(e.message))!;
    expect(entry.level).toBe("warn");
    expect(entry.message).toMatch(/came to rest on Zone II/);
  });
});

describe("the bars read a plain render, never the view (review 2026-09-15, item 4)", () => {
  it("asks the engine for the chain's end while the fold is open, and not while it is closed", async () => {
    render(<App />);
    // This test's calls alone. The mock's list runs across the file, and
    // the test above opens the fold: on a slow machine (the owner's Windows
    // box, 2026-09-15) its request had time to fire before that test ended,
    // and this one read it as a request made with the fold closed. The hook
    // clears its timer on unmount, so nothing from an earlier test can land
    // after this point.
    vi.mocked(nodeThumbs).mockClear();
    // Other editors ask for their own sources (the Hue curve's input);
    // the chain's end is the bars' ask alone.
    const asksForEnd = () => vi.mocked(nodeThumbs).mock.calls.some(([, ids, edge]) => ids.length === 1 && ids[0] === "output" && edge === BARS_EDGE);
    await new Promise((r) => setTimeout(r, 300));
    expect(asksForEnd()).toBe(false);
    fireEvent.click(screen.getByTestId("bw-zones-fold"));
    await waitFor(() => expect(asksForEnd()).toBe(true));
  });
});
