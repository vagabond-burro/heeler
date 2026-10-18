// Recolor's color pairs: the arithmetic the scope draws (the engine's
// own), the two-click picker, and the fold's dials.
import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";

vi.mock("../bridge", async (orig) => {
  const real = await orig<typeof import("../bridge")>();
  return { ...real, sampleImage: vi.fn() };
});

import { sampleImage } from "../bridge";
import { initialState } from "../data";
import { anyPickerArmed, reduce, toolNode, type Command, type State } from "../state";
import { IDENTITY_VIEW } from "../ui/overlays";
import { pairAfter, pairTurn, parsePairs, RecolorPairLayer, RecolorPairs, type RecolorPair } from "../ui/recolorpairs";

const run = (s: State, ...cmds: Command[]) => cmds.reduce(reduce, s);
const sampleMock = sampleImage as unknown as ReturnType<typeof vi.fn>;
afterEach(() => sampleMock.mockReset());

const end = (h: number, ev = 0) => ({ h, c: 0.12, ev, rgb: [0.2, 0.2, 0.2] as [number, number, number] });
const pair = (a: number, b: number, patch: Partial<RecolorPair> = {}): RecolorPair => ({ a: end(a), b: end(b), width: 30, sep: 0, sat: 0, lum: 0, ...patch });

describe("Recolor pairs", () => {
  it("turn each color away from the other on the shorter arc, as the engine does", () => {
    expect(pairTurn(pair(200, 100, { sep: 100 }))).toBe(30);
    expect(pairTurn(pair(100, 200, { sep: 100 }))).toBe(-30);
    // Nearly opposite already: they stop at opposite sides.
    expect(pairAfter(pair(250, 60, { sep: 100 })).a.h).toBeCloseTo(245, 5);
    // Pulled together, they meet in the middle.
    const met = pairAfter(pair(100, 80, { sep: -100 }));
    expect(met.a.h).toBeCloseTo(90, 5);
    expect(met.b.h).toBeCloseTo(90, 5);
    const bal = pairAfter(pair(200, 100, { sat: 100 }));
    expect(bal.a.c).toBeCloseTo(0.18, 5);
    expect(bal.b.c).toBeCloseTo(0.06, 5);
    expect(parsePairs("not json")).toEqual([]);
    expect(parsePairs(JSON.stringify([pair(1, 2), pair(3, 4), pair(5, 6), pair(7, 8)]))).toHaveLength(3);
  });

  it("the picker is one picker among the rest, and takes two colored clicks", async () => {
    let s = run(initialState(), { type: "set_category", title: "Recolor", on: true });
    const id = toolNode(s, "recolor")!.id;
    s = run(s, { type: "arm_wb_pick", id: "stdcolor" }, { type: "toggle_recolor_pair_pick", id });
    expect(s.wbPick).toBeNull();
    expect(s.recolorPairPick).toEqual({ id, first: null });
    let current = s;
    const dispatch = (c: Command) => {
      current = reduce(current, c);
      view.rerender(<RecolorPairLayer state={current} dispatch={dispatch} view={IDENTITY_VIEW} />);
    };
    const view = render(<RecolorPairLayer state={current} dispatch={dispatch} view={IDENTITY_VIEW} />);
    const click = () => fireEvent.mouseDown(screen.getByTestId("recolor-pair-overlay"), { button: 0, clientX: 0, clientY: 0 });
    // A gray has no hue to pair: nothing happens.
    sampleMock.mockResolvedValueOnce({ luma: 0.5, hue: 0, sat: 0, r: 0.2, g: 0.2, b: 0.2 });
    click();
    await waitFor(() => expect(sampleMock).toHaveBeenCalledTimes(1));
    expect(current.recolorPairPick?.first).toBeNull();
    sampleMock.mockResolvedValueOnce({ luma: 0.5, hue: 0, sat: 0, r: 0.05, g: 0.15, b: 0.5 });
    click();
    await waitFor(() => expect(current.recolorPairPick?.first).not.toBeNull());
    sampleMock.mockResolvedValueOnce({ luma: 0.5, hue: 0, sat: 0, r: 0.6, g: 0.25, b: 0.05 });
    click();
    await waitFor(() => expect(current.recolorPairPick).toBeNull());
    const pairs = parsePairs(current.nodes.find((n) => n.id === id)!.textParams?.pairs);
    expect(pairs).toHaveLength(1);
    expect(pairs[0].a.ev).toBeLessThan(pairs[0].b.ev);
    expect(anyPickerArmed(current)).toBe(false);
  });

  it("the fold's dials write the pair, and Remove takes it out", () => {
    let s = run(initialState(), { type: "set_category", title: "Recolor", on: true });
    const id = toolNode(s, "recolor")!.id;
    s = run(s, { type: "set_text_param", id, param: "pairs", value: JSON.stringify([pair(200, 100)]) });
    let current = s;
    const dispatch = (c: Command) => {
      current = reduce(current, c);
      view.rerender(<RecolorPairs state={current} node={current.nodes.find((n) => n.id === id)!} dispatch={dispatch} width={320} />);
    };
    const view = render(<RecolorPairs state={current} node={current.nodes.find((n) => n.id === id)!} dispatch={dispatch} width={320} />);
    fireEvent.click(screen.getByTestId("recolor-pairs-toggle"));
    const row = screen.getByTestId("recolor-pair-0");
    const slider = (testid: string) => within(row).getByTestId(testid).closest("[role=slider]") ?? within(within(row).getByTestId(testid)).getByRole("slider");
    fireEvent.keyDown(slider("recolor-pair-sep-0"), { key: "ArrowRight" });
    fireEvent.keyDown(slider("recolor-pair-lum-0"), { key: "ArrowLeft" });
    const p = parsePairs(current.nodes.find((n) => n.id === id)!.textParams?.pairs)[0];
    expect(p.sep).toBeGreaterThan(0);
    expect(p.lum).toBeLessThan(0);
    expect(screen.getByTestId("recolor-pairs-badge")).toHaveTextContent("1");
    fireEvent.click(screen.getByTestId("recolor-pair-remove-0"));
    expect(current.nodes.find((n) => n.id === id)!.textParams?.pairs).toBe("");
  });
});
