import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { App } from "../app";
import { initialState } from "../data";
import { migrateNodes, reduce, type Command } from "../state";
import { NodeParams } from "../ui/graph";
import { separatePoints, zoneOfSrgb } from "../blackwhite";
import * as bridge from "../bridge";
import { parseEqPoints } from "../eqcurve";
import { oklabHueChroma } from "../colorsets";
import { chooseWith } from "./menuhelp";

describe("Ansel review regressions", () => {
  it("Separate starts from the selected interpolation face", () => {
    const pts = [{ x: 0, y: 0 }, { x: 90, y: 1 }, { x: 250, y: -1 }];
    const result = separatePoints({ hue: 45, chroma: 0.2, gray: 0.7 }, { hue: 180, chroma: 0.2, gray: 0.3 }, pts, 0.5, "linear");
    expect(typeof result).not.toBe("string");
    if (typeof result !== "string") expect(result.find((p) => p.x === 45)?.y).toBeCloseTo(1);
  });
  it("Separate follows the rendered gray ordering and refreshes the first spot", async () => {
    const sample = vi.spyOn(bridge, "sampleImage").mockImplementation(async (_state, x, _y, _radius, _node, port) => {
      const red = x < 0.5;
      const gray = red ? 0.9 : 0.1;
      return { luma: gray, hue: 0, sat: 1, luma_linear: gray,
        r: port === "out" ? gray : red ? 0.8 : 0.05,
        g: port === "out" ? gray : red ? 0.05 : 0.8, b: port === "out" ? gray : 0.05 };
    });
    try {
      const user = userEvent.setup();
      render(<App />);
      await user.click(screen.getByTestId("bw-mode-bw"));
      // The curve switched off to compare: Separate switches it back on
      // with the push (review 2026-09-15, item 6).
      await user.click(screen.getByTestId("bw-hue-on"));
      await user.click(screen.getByTestId("bw-separate"));
      const overlay = screen.getByTestId("bw-separate-overlay");
      vi.spyOn(overlay, "getBoundingClientRect").mockReturnValue({ left: 0, top: 0, width: 100, height: 100 } as DOMRect);
      fireEvent.mouseDown(overlay, { button: 0, clientX: 20, clientY: 20 });
      await waitFor(() => expect(screen.getByTestId("bw-separate-pin")).toBeVisible());
      fireEvent.mouseDown(overlay, { button: 0, clientX: 80, clientY: 20 });
      await waitFor(() => expect(screen.queryByTestId("bw-separate-overlay")).toBeNull());
      expect(sample.mock.calls.filter((c) => c[5] === "out" && c[1] < 0.5)).toHaveLength(2);
      await user.click(screen.getByTestId("bw-pick"));
      fireEvent.mouseMove(screen.getByTestId("bw-pick-overlay"), { clientX: 30, clientY: 20 });
      await waitFor(() => expect(sample.mock.calls.length).toBeGreaterThan(5));
      const state = sample.mock.calls[sample.mock.calls.length - 1][0];
      const pts = parseEqPoints(state.nodes.find((n) => n.id === "bw")?.textParams?.hue_curve);
      const hue = oklabHueChroma(0.8, 0.05, 0.05).hue;
      expect(pts.find((p) => Math.abs(p.x - hue) < 1)?.y).toBeCloseTo(0.5);
      expect(state.nodes.find((n) => n.id === "bw")?.params.hue_curve_on).toBe(1);
    } finally { sample.mockRestore(); }
  });
  it("Grain Field exposes the same frame-sizing control as Grain", async () => {
    const s = initialState();
    const grain = s.nodes.find((n) => n.type === "heeler.grain")!;
    const writes: Command[] = [];
    render(<NodeParams node={{ ...grain, id: "field", type: "heeler.noise", params: { size: 30 } }} allNodes={s.nodes} dispatch={(c) => writes.push(c)} />);
    await userEvent.setup().click(screen.getByTestId("grain-by-frame"));
    expect(writes).toContainEqual({ type: "set_param", id: "field", param: "by_frame", value: 1 });
  });
  it("the color histogram uses the same print zones as the engine", () => {
    expect(zoneOfSrgb(1, 0, 0)).toBe(5);
    expect(zoneOfSrgb(0, 1, 0)).toBe(9);
    expect(zoneOfSrgb(0, 0, 1)).toBe(3);
    expect(zoneOfSrgb(0, 0, 0)).toBe(0);
    expect(zoneOfSrgb(1, 1, 1)).toBe(10);
  });
  it("loading grain without by_frame preserves its saved pixel sizing", () => {
    const grain = initialState().nodes.find((n) => n.type === "heeler.grain")!;
    const old = { ...grain, params: { intensity: 25, size: 18 } };
    const loaded = migrateNodes([old])[0];
    expect(loaded.params.by_frame ?? 0).toBe(0);
    expect(migrateNodes([grain])[0].params.by_frame).toBe(1);
  });

  it.each<Command>([
    { type: "toggle_bw_pick" },
    { type: "toggle_bw_separate" },
    { type: "arm_zone_place", zone: 3 },
  ])("switching photographs drops $type and its ghost or first spot", (arm) => {
    let s = reduce(initialState(), { type: "set_param", id: "bw", param: "amount", value: 100 });
    s = reduce(s, arm);
    s = reduce(s, { type: "set_bw_hover", hue: 142 });
    s = reduce(s, { type: "select_image", id: s.images.find((i) => i.id !== s.activeImage)!.id });
    expect(s.bwPick).toBe(false);
    expect(s.bwSeparate).toBeNull();
    expect(s.bwHoverHue).toBeNull();
    expect(s.zonePlace).toBeNull();
  });

  it("switching to color drops the conversion picker", () => {
    let s = reduce(initialState(), { type: "set_param", id: "bw", param: "amount", value: 100 });
    s = reduce(s, { type: "toggle_bw_pick" });
    s = reduce(s, { type: "set_param", id: "bw", param: "amount", value: 0 });
    expect(s.bwPick).toBe(false);
  });

  it("Color reset clears the mixer and the film, and is one undo step", async () => {
    try {
      const user = userEvent.setup();
      render(<App />);
      await user.click(screen.getByTestId("bw-mode-bw"));
      fireEvent.keyDown(within(screen.getByTestId("slider-red")).getByRole("slider"), { key: "ArrowRight" });
      const red = within(screen.getByTestId("slider-red")).getByRole("slider").getAttribute("aria-valuenow");
      await user.click(screen.getByTestId("reset-color"));
      expect(screen.queryByTestId("bw-mixer")).toBeNull();
      expect(screen.queryByRole("dialog", { name: /pro/i })).toBeNull();
      fireEvent.keyDown(window, { key: "z", metaKey: true });
      expect(within(screen.getByTestId("slider-red")).getByRole("slider")).toHaveAttribute("aria-valuenow", red);
    } finally {
    }
  });

  it("the infrared controls are available for an infrared Far filter", () => {
    const s = reduce(initialState(), { type: "set_param", id: "bw", param: "amount", value: 100 });
    const bw = s.nodes.find((n) => n.id === "bw")!;
    render(<NodeParams node={{ ...bw, textParams: { filter: "w25", far_filter: "r72" } }} allNodes={s.nodes} dispatch={() => {}} />);
    expect(screen.getByTestId("slider-neutral")).toBeTruthy();
  });

  it("Print reset restores all paper values and its toner", async () => {
    const user = userEvent.setup();
    render(<App />);
    const header = screen.getByTestId("collapse-print");
    if (header.getAttribute("aria-expanded") === "false") fireEvent.click(header);
    await user.click(screen.getByTestId("toggle-print"));
    fireEvent.keyDown(within(screen.getByTestId("slider-grade")).getByRole("slider"), { key: "ArrowRight" });
    await chooseWith(user, screen.getByTestId("print-toner"), "sepia");
    await user.click(screen.getByTestId("reset-print"));
    expect(within(screen.getByTestId("slider-grade")).getByRole("slider")).toHaveAttribute("aria-valuenow", "2");
    expect(screen.getByTestId("print-toner")).toHaveValue("");
  });
});
