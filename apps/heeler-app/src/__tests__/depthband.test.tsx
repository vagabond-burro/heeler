// The depth Band (Ramp | Band): a mask's effect on one slice of depth,
// picked on the photograph (2026-10-18: "how could I pick a point in the
// depth map ... and have it shift the edits to only affect anything in
// that range (with a fall off)"). Each mask keeps its own Band.
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

const depthAt = vi.fn(async () => 0.3);
vi.mock("../bridge", async (orig) => {
  const real = await orig<typeof import("../bridge")>();
  return { ...real, depthAt: (...args: unknown[]) => depthAt(...(args as [])) };
});

import { App } from "../app";
import { initialState } from "../data";
import { FLAG_PARAMS, anyPickerArmed, publishShape, reduce, type Command, type NodeCard, type State } from "../state";
import { bandOf, bandWeight, widenBand } from "../ui/depthbins";
import { DepthShape } from "../ui/depthband";
import { depthWanted } from "../ui/depthtoolparts";
import { serializeGraph } from "../bridge";

const run = (s: State, ...cmds: Command[]) => cmds.reduce(reduce, s);

afterEach(() => depthAt.mockReset());

describe("the depth Band", () => {
  it("weighs a slice the way the engine does, and widens to take a second pick in", () => {
    const band = { center: 0.5, range: 0.1, soft: 0.1 };
    expect(bandWeight(band, 0.5)).toBe(1);
    expect(bandWeight(band, 0.58)).toBe(1);
    expect(bandWeight(band, 0.65)).toBeCloseTo(0.5, 6);
    expect(bandWeight(band, 0.35)).toBeCloseTo(0.5, 6);
    expect(bandWeight(band, 0.9)).toBe(0);
    expect(bandWeight({ ...band, soft: 0 }, 0.61)).toBe(0);
    // A nearness outside the full-effect span pulls that side out to it.
    const wide = widenBand(band, 0.2);
    expect(wide.center).toBeCloseTo(0.4, 9);
    expect(wide.range).toBeCloseTo(0.2, 9);
    expect(wide.soft).toBe(0.1);
    // One already inside changes nothing.
    expect(widenBand(band, 0.55)).toEqual(band);
    // A mask that never had a Band reads the defaults; nonsense is clamped.
    expect(bandOf({})).toEqual({ center: 0.5, range: 0.1, soft: 0.1 });
    expect(bandOf({ depth_center: 3, depth_range: -1, depth_band_soft: Number.NaN })).toEqual({ center: 1, range: 0, soft: 0.1 });
  });

  it("its picker is one picker among the rest, aimed at one mask", () => {
    let s = run(initialState(), { type: "toggle_depth_band_pick", mask: "layer_1_mask" });
    expect(s.depthBandPick).toBe("layer_1_mask");
    expect(anyPickerArmed(s)).toBe(true);
    // Another mask's picker takes over; another kind of picker puts it away.
    s = run(s, { type: "toggle_depth_band_pick", mask: "layer_2_mask" });
    expect(s.depthBandPick).toBe("layer_2_mask");
    s = run(s, { type: "toggle_dof_pick" });
    expect(s.depthBandPick).toBeNull();
    s = run(s, { type: "toggle_depth_band_pick", mask: "layer_2_mask" }, { type: "toggle_depth_band_pick", mask: "layer_2_mask" });
    expect(s.depthBandPick).toBeNull();
  });

  it("a Develop layer picks its slice on the photograph, and a Shift-click widens it", async () => {
    const user = userEvent.setup();
    render(<App />);
    await user.click(screen.getByTestId("add-layer-range"));
    const block = screen.getByTestId("mask-depth");
    // The eyedropper sits beside the eye, ahead of the switch, and is
    // there before the Depth mask is on: picking turns it on.
    const pick = within(block).getByTestId("mask-depth-pick");
    expect(pick.compareDocumentPosition(within(block).getByTestId("mask-depth-toggle")) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    await user.click(pick);
    const overlay = await screen.findByTestId("depth-band-overlay");
    overlay.getBoundingClientRect = () => ({ left: 0, top: 0, width: 200, height: 100, right: 200, bottom: 100, x: 0, y: 0, toJSON: () => ({}) });
    depthAt.mockResolvedValueOnce(0.3);
    fireEvent.mouseDown(overlay, { button: 0, clientX: 50, clientY: 50 });
    // Read at the click, as the median of a small patch.
    await waitFor(() => expect(depthAt).toHaveBeenCalled());
    expect(depthAt.mock.calls[0].slice(1)).toEqual([0.25, 0.5, 3]);
    await waitFor(() => expect(screen.queryByTestId("depth-band-overlay")).toBeNull());
    // The Depth mask is on, in Band mode, centered on the picked
    // nearness (0.7 for a farness of 0.3).
    expect(within(block).getByTestId("mask-depth-toggle")).toHaveAttribute("aria-checked", "true");
    expect(within(block).getByTestId("mask-depth-mode-band")).toHaveAttribute("aria-pressed", "true");
    expect(within(block).getByTestId("mask-depth-band")).toBeInTheDocument();
    expect((within(block).getByTestId("mask-depth-depth_center") as HTMLInputElement).value).toBe("70");
    // Shift-click a nearer-than-the-slice point: the slice widens to take
    // it in, and the picker stays armed for another.
    await user.click(within(block).getByTestId("mask-depth-pick"));
    const again = await screen.findByTestId("depth-band-overlay");
    again.getBoundingClientRect = overlay.getBoundingClientRect;
    depthAt.mockResolvedValueOnce(0.6);
    fireEvent.mouseDown(again, { button: 0, clientX: 150, clientY: 50, shiftKey: true });
    await waitFor(() => expect((within(block).getByTestId("mask-depth-depth_center") as HTMLInputElement).value).toBe("60"));
    expect((within(block).getByTestId("mask-depth-depth_range") as HTMLInputElement).value).toBe("20");
    expect(screen.getByTestId("depth-band-overlay")).toBeInTheDocument();
    // Ramp brings the Levels back, untouched.
    fireEvent.keyDown(screen.getByTestId("depth-band-overlay"), { key: "Escape" });
    await user.click(within(block).getByTestId("mask-depth-mode-ramp"));
    expect(within(block).queryByTestId("mask-depth-band")).toBeNull();
    expect(within(block).getByTestId("mask-depth-levels-editor")).toBeInTheDocument();
  });

  it("each layer's mask keeps a Band of its own", () => {
    const s = run(
      initialState(),
      { type: "add_layer", maskType: "range" },
      { type: "add_layer", maskType: "radial" },
      { type: "set_params", id: "layer_1_mask", values: { depth_on: 1, depth_band: 1, depth_center: 0.2 } },
      { type: "set_params", id: "layer_2_mask", values: { depth_on: 1, depth_band: 1, depth_center: 0.8 } },
    );
    const mask = (id: string) => s.nodes.find((n) => n.id === id)!.params;
    expect(bandOf(mask("layer_1_mask")).center).toBe(0.2);
    expect(bandOf(mask("layer_2_mask")).center).toBe(0.8);
  });

  it("the Band's editor moves the slice, widens it and softens it by its marks, one undo step a drag", () => {
    const node = { id: "m", type: "heeler.range_mask", name: "m", params: { depth_on: 1, depth_band: 1, depth_center: 0.5, depth_range: 0.1, depth_band_soft: 0.1 } } as unknown as NodeCard;
    const dispatch = vi.fn();
    render(<DepthShape maskNode={node} dispatch={dispatch} width={200} bins={[1, 2, 3, 4]} testPrefix="t" levels={<div data-testid="t-levels" />} />);
    const svg = screen.getByTestId("t-band");
    svg.getBoundingClientRect = () => ({ left: 0, top: 0, width: 200, height: 54, right: 200, bottom: 54, x: 0, y: 0, toJSON: () => ({}) });
    const last = () => dispatch.mock.calls.filter(([c]) => c.type === "set_params").pop()![0].values;
    // The right inner mark (center + range, at 120) widens the slice.
    fireEvent.mouseDown(svg, { button: 0, clientX: 120 });
    fireEvent.mouseMove(window, { clientX: 150 });
    fireEvent.mouseUp(window);
    expect(last().depth_range).toBeCloseTo(0.25, 6);
    expect(dispatch.mock.calls[0][0]).toEqual({ type: "begin_gesture", key: "m.depth_band" });
    expect(dispatch.mock.calls[dispatch.mock.calls.length - 1][0]).toEqual({ type: "end_gesture" });
    // The left outer mark (at 60) sets the falloff past the range.
    fireEvent.mouseDown(svg, { button: 0, clientX: 60 });
    fireEvent.mouseMove(window, { clientX: 20 });
    fireEvent.mouseUp(window);
    expect(last().depth_band_soft).toBeCloseTo(0.3, 6);
    // Away from the marks, a press centers the slice there.
    fireEvent.mouseDown(svg, { button: 0, clientX: 180 });
    fireEvent.mouseUp(window);
    expect(last().depth_center).toBeCloseTo(0.9, 6);
    // Ramp | Band writes the switch, and Ramp shows what it was handed.
    fireEvent.click(screen.getByTestId("t-mode-ramp"));
    expect(dispatch).toHaveBeenLastCalledWith({ type: "set_param", id: "m", param: "depth_band", value: 0 });
  });

  // 2026-10-18, on a Finish layer: "I clicked on the rock on the right
  // side ... when I click on the rocks in the distance it didn't update".
  // A Finish layer's mask lives inside the Finish group, where the pick
  // looked for it at the top level only and dropped every answer.
  it("a Finish layer's pick lands on its mask, and its Depth mask asks for the depth map", async () => {
    const user = userEvent.setup();
    render(<App />);
    await user.click(screen.getByTestId("panel-tab-layers"));
    await user.click(screen.getByTestId("art-add-content"));
    const live = () => (window as unknown as { __heeler: { state: () => State } }).__heeler.state();
    expect(depthWanted(live())).toBe(false);
    fireEvent.click(screen.getByTestId("art-depth-art_b1-toggle"));
    // On, the layer's Depth mask is a depth reader like any other: it
    // asks for the plane, and there is a Depth Map to carry it.
    expect(depthWanted(live())).toBe(true);
    const graph = serializeGraph(live()) as unknown as { connections: { from: [string, string]; to: [string, string] }[] };
    expect(graph.connections.some((c) => c.to[0] === "art_m_art_b1" && c.to[1] === "depth")).toBe(true);
    fireEvent.click(screen.getByTestId("art-depth-art_b1-pick"));
    // Arming the picker asks for the plane too, as Set focus does.
    expect(live().depthBandPick).not.toBeNull();
    const overlay = await screen.findByTestId("depth-band-overlay");
    overlay.getBoundingClientRect = () => ({ left: 0, top: 0, width: 200, height: 100, right: 200, bottom: 100, x: 0, y: 0, toJSON: () => ({}) });
    depthAt.mockResolvedValueOnce(0.85);
    fireEvent.mouseDown(overlay, { button: 0, clientX: 180, clientY: 20 });
    await waitFor(() => expect((screen.getByTestId("art-depth-art_b1-depth_center") as HTMLInputElement).value).toBe("15"));
    expect(screen.getByTestId("art-depth-art_b1-mode-band")).toHaveAttribute("aria-pressed", "true");
    // A second pick, at another depth, moves it.
    fireEvent.click(screen.getByTestId("art-depth-art_b1-pick"));
    const again = await screen.findByTestId("depth-band-overlay");
    again.getBoundingClientRect = overlay.getBoundingClientRect;
    depthAt.mockResolvedValueOnce(0.2);
    fireEvent.mouseDown(again, { button: 0, clientX: 150, clientY: 80 });
    await waitFor(() => expect((screen.getByTestId("art-depth-art_b1-depth_center") as HTMLInputElement).value).toBe("80"));
  });

  it("a Finish layer's Depth mask brings a Depth Map into a graph that has none", () => {
    const s = initialState();
    const bare: State = { ...s, nodes: s.nodes.filter((n) => n.type !== "heeler.depth_map"), wires: s.wires.filter((w) => w.fromPort !== "depth") };
    let t = run(bare, { type: "art_add_layer", kind: "pixel" });
    const finish = t.nodes.find((n) => n.groupNodes?.some((m) => m.id.startsWith("art_b")));
    const blend = finish!.groupNodes!.find((m) => m.id.startsWith("art_b"))!;
    t = run(t, { type: "art_add_mask", id: blend.id, kind: "brush" });
    expect(t.nodes.some((n) => n.type === "heeler.depth_map")).toBe(false);
    t = run(t, { type: "set_param", id: `art_m_${blend.id}`, param: "depth_on", value: 1 });
    expect(t.nodes.some((n) => n.type === "heeler.depth_map")).toBe(true);
  });

  it("arming the picker asks for the depth map even with no depth reader on", () => {
    const s = run(initialState(), { type: "add_layer", maskType: "range" });
    expect(depthWanted(s)).toBe(false);
    expect(depthWanted(run(s, { type: "toggle_depth_band_pick", mask: "layer_1_mask" }))).toBe(true);
  });

  it("a Finish layer's Depth row has the picker too, and its Levels give way to the Band", async () => {
    const user = userEvent.setup();
    render(<App />);
    await user.click(screen.getByTestId("panel-tab-layers"));
    await user.click(screen.getByTestId("art-add-content"));
    fireEvent.click(screen.getByTestId("art-depth-art_b1-toggle"));
    const row = screen.getByTestId("art-depth-art_b1");
    expect(within(row).getByTestId("art-depth-art_b1-pick")).toBeInTheDocument();
    expect(screen.getByTestId("art-depth-art_b1-levels-handle-gamma")).toBeInTheDocument();
    fireEvent.click(screen.getByTestId("art-depth-art_b1-mode-band"));
    expect(screen.getByTestId("art-depth-art_b1-band")).toBeInTheDocument();
    expect(screen.queryByTestId("art-depth-art_b1-levels-handle-gamma")).toBeNull();
  });

  // The fourth review: the Band is a flag like depth_on, so a recipe that
  // publishes it offers Off and On, and Quad edit copies it whole rather
  // than mirroring a difference.
  it("is a flag wherever flags are treated as flags", () => {
    expect(FLAG_PARAMS).toContain("depth_band");
    const mask = { id: "m", type: "heeler.range_mask", name: "m", params: { depth_band: 0 } } as unknown as NodeCard;
    expect(publishShape(mask, "depth_band")).toEqual({ kind: "menu", options: [{ label: "Off", value: 0 }, { label: "On", value: 1 }] });
  });
});
