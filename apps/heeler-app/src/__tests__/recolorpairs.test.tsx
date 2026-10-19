// Recolor's color pairs: the arithmetic the scope draws (the engine's
// own), the two-click picker, and the fold's dials.
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, render, screen, fireEvent, waitFor, within } from "@testing-library/react";

vi.mock("../bridge", async (orig) => {
  const real = await orig<typeof import("../bridge")>();
  return { ...real, sampleImage: vi.fn() };
});

import { sampleImage } from "../bridge";
import { initialState } from "../data";
import { anyPickerArmed, reduce, toolNode, type Command, type State } from "../state";
import { IDENTITY_VIEW } from "../ui/overlays";
import { RecolorPairLayer, RecolorPairs } from "../ui/recolorpairs";
import { pairAfter, pairTurn, parsePairs, type RecolorPair } from "../ui/recolorpairsparts";

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
    const met = pairAfter(pair(100, 80, { width: 10, sep: -100 }));
    expect(met.a.h).toBeCloseTo(90, 5);
    expect(met.b.h).toBeCloseTo(90, 5);
    const bal = pairAfter(pair(200, 100, { sat: 100 }));
    expect(bal.a.c).toBeCloseTo(0.18, 5);
    expect(bal.b.c).toBeCloseTo(0.06, 5);
    expect(parsePairs("not json")).toEqual([]);
    expect(parsePairs(JSON.stringify([pair(1, 2), pair(3, 4), pair(5, 6), pair(7, 8)]))).toHaveLength(3);
  });

  it("normalizes incomplete pair records before opening the fold", () => {
    const s = initialState();
    const text = '[{"a":{"h":200,"ev":0},"b":{"h":100,"ev":0},"sep":100}]';
    const node = { ...s.nodes[0], type: "heeler.recolor", textParams: { pairs: text } };
    const pairs = parsePairs(text);
    expect(pairs[0]).toMatchObject({ width: 30, sep: 100, sat: 0, lum: 0 });
    expect(pairs[0].a.rgb).toHaveLength(3);
    expect(parsePairs('[null,{"a":null,"b":{}},{"a":1,"b":2}]')).toEqual([]);
    expect(parsePairs('[{"a":{},"b":{},"width":999,"sep":-999}]')[0]).toMatchObject({ width: 90, sep: -100 });
    render(<RecolorPairs state={s} node={node} dispatch={() => {}} width={320} />);
    fireEvent.click(screen.getByTestId("recolor-pairs-toggle"));
    expect(screen.getByTestId("recolor-pair-0")).toBeInTheDocument();
    expect(screen.getByTestId("recolor-pair-scope-0").innerHTML).not.toContain("NaN");
  });

  it("shows both windows' contributions when the picked hues overlap", () => {
    const moved = pairAfter(pair(100, 80, { sep: -100, sat: 100 }));
    // The opposite window has weight 0.25 at each picked hue. The
    // engine's rendered reference is 92.49993 degrees for A.
    expect(moved.a.h).toBeCloseTo(92.5, 4);
    expect(moved.b.h).toBeCloseTo(87.5, 4);
    expect(moved.a.c).toBeCloseTo(0.12 * 1.5 * 0.875, 5);
    expect(moved.b.c).toBeCloseTo(0.12 * 1.125 * 0.5, 5);
    const same = pairAfter(pair(100, 100, { sep: 100, sat: 100 }));
    expect(same.a.h).toBe(100);
    expect(same.a.c).toBeCloseTo(0.09, 5);
  });

  it("dragging an overlapping ring uses the same windowed result it draws", () => {
    let s = run(initialState(), { type: "set_category", title: "Recolor", on: true });
    const id = toolNode(s, "recolor")!.id;
    s = run(s, { type: "set_text_param", id, param: "pairs", value: JSON.stringify([pair(100, 80, { sep: -100 })]) });
    const dispatch = (c: Command) => {
      s = reduce(s, c);
      view.rerender(<RecolorPairs state={s} node={s.nodes.find((n) => n.id === id)!} dispatch={dispatch} width={320} />);
    };
    const view = render(<RecolorPairs state={s} node={s.nodes.find((n) => n.id === id)!} dispatch={dispatch} width={320} />);
    fireEvent.click(screen.getByTestId("recolor-pairs-toggle"));
    const svg = screen.getByTestId("recolor-pair-scope-0");
    svg.getBoundingClientRect = () => ({ left: 0, top: 0, width: 320 / 3, height: 320 / 3 } as DOMRect);
    const handle = screen.getByTestId("recolor-pair-handle-0-a");
    const x = Number(handle.getAttribute("cx")), y = Number(handle.getAttribute("cy"));
    fireEvent(handle, new MouseEvent("pointerdown", { bubbles: true, button: 0 }));
    fireEvent(svg, new MouseEvent("pointermove", { bubbles: true, clientX: x, clientY: y }));
    const stayed = parsePairs(s.nodes.find((n) => n.id === id)!.textParams?.pairs)[0];
    expect(stayed.sep).toBe(-100);
    expect(stayed.sat).toBe(0);
    const size = 320 / 3, r = size / 2 - 6, rad = 95 * Math.PI / 180;
    fireEvent(svg, new MouseEvent("pointermove", { bubbles: true, clientX: size / 2 + r * 0.4 * Math.cos(rad), clientY: size / 2 - r * 0.4 * Math.sin(rad) }));
    const moved = pairAfter(parsePairs(s.nodes.find((n) => n.id === id)!.textParams?.pairs)[0]);
    expect(Math.abs(moved.a.h - 95)).toBeLessThan(0.1);
    expect(moved.a.c).toBeCloseTo(0.12, 5);
    fireEvent(svg, new MouseEvent("pointerup", { bubbles: true }));
  });

  it.each(["rearm", "photo", "unmount"])("drops a delayed pick after %s", async (change) => {
    let s = run(initialState(), { type: "toggle_recolor_pair_pick", id: "recolor" });
    let answer!: (v: unknown) => void;
    sampleMock.mockReturnValueOnce(new Promise((resolve) => { answer = resolve; }));
    const dispatch = (c: Command) => {
      s = reduce(s, c);
      view.rerender(<RecolorPairLayer state={s} dispatch={dispatch} view={IDENTITY_VIEW} />);
    };
    const view = render(<RecolorPairLayer state={s} dispatch={dispatch} view={IDENTITY_VIEW} />);
    fireEvent.mouseDown(screen.getByTestId("recolor-pair-overlay"), { button: 0 });
    act(() => {
      if (change === "unmount") view.unmount();
      else {
        dispatch({ type: "toggle_recolor_pair_pick", id: "recolor" });
        if (change === "photo") s = { ...s, activeImage: "another-photo" };
        dispatch({ type: "toggle_recolor_pair_pick", id: "recolor" });
      }
    });
    await act(async () => answer({ r: 0.8, g: 0.1, b: 0.05 }));
    expect(s.recolorPairPick?.first).toBeNull();
    expect(s.nodes.find((n) => n.id === "recolor")?.textParams?.pairs ?? "").toBe("");
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

  it("folds each pair to its two colors on its own, and a removed pair takes its fold with it", () => {
    let s = run(initialState(), { type: "set_category", title: "Recolor", on: true });
    const id = toolNode(s, "recolor")!.id;
    s = run(s, { type: "set_text_param", id, param: "pairs", value: JSON.stringify([pair(200, 100), pair(40, 120), pair(300, 20)]) });
    let current = s;
    const dispatch = (c: Command) => {
      current = reduce(current, c);
      view.rerender(<RecolorPairs state={current} node={current.nodes.find((n) => n.id === id)!} dispatch={dispatch} width={320} />);
    };
    const view = render(<RecolorPairs state={current} node={current.nodes.find((n) => n.id === id)!} dispatch={dispatch} width={320} />);
    // The badge counts every pair, dials moved or not.
    expect(screen.getByTestId("recolor-pairs-badge")).toHaveTextContent("3");
    fireEvent.click(screen.getByTestId("recolor-pairs-toggle"));
    // Every pair opens with its wheel and dials.
    for (const i of [0, 1, 2]) expect(screen.queryByTestId(`recolor-pair-sep-${i}`)).not.toBeNull();
    // Folding the second hides its dials alone; its swatches and Remove stay.
    fireEvent.click(screen.getByTestId("recolor-pair-fold-1"));
    expect(screen.getByTestId("recolor-pair-fold-1")).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByTestId("recolor-pair-sep-1")).toBeNull();
    expect(screen.getByTestId("recolor-pair-remove-1")).toBeInTheDocument();
    // Remove is a picture with its name on hover, not a word.
    expect(screen.getByTestId("recolor-pair-remove-1").textContent).toBe("");
    expect(screen.getByTestId("recolor-pair-remove-1")).toHaveAttribute("aria-label", "Remove this pair");
    expect(screen.getByTestId("recolor-pair-remove-1").querySelector("svg")).not.toBeNull();
    expect(screen.queryByTestId("recolor-pair-sep-0")).not.toBeNull();
    expect(screen.queryByTestId("recolor-pair-sep-2")).not.toBeNull();
    // Removing the first moves the folded pair up a place, folded still.
    fireEvent.click(screen.getByTestId("recolor-pair-remove-0"));
    expect(screen.queryByTestId("recolor-pair-sep-0")).toBeNull();
    expect(screen.queryByTestId("recolor-pair-sep-1")).not.toBeNull();
    expect(screen.getByTestId("recolor-pairs-badge")).toHaveTextContent("2");
    // And it opens again.
    fireEvent.click(screen.getByTestId("recolor-pair-fold-0"));
    expect(screen.queryByTestId("recolor-pair-sep-0")).not.toBeNull();
  });
});
