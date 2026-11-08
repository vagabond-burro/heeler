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
import { IDENTITY_VIEW } from "../ui/overlaysparts";
import { RecolorPairLayer, RecolorPairs } from "../ui/recolorpairs";
import { PAIR_PICK_NOISE, pairAfter, pairPickFloor, pairTurn, parsePairs, type RecolorPair } from "../ui/recolorpairsparts";
import { _clearFlashForTests, currentFlash } from "../ui/hints";
import { guardGate } from "../eqcurve";

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
    svg.getBoundingClientRect = () => ({ left: 0, top: 0, width: 320 / 3.4, height: 320 / 3.4 } as DOMRect);
    const handle = screen.getByTestId("recolor-pair-handle-0-a");
    const x = Number(handle.getAttribute("cx")), y = Number(handle.getAttribute("cy"));
    fireEvent(handle, new MouseEvent("pointerdown", { bubbles: true, button: 0, clientX: x, clientY: y }));
    fireEvent(svg, new MouseEvent("pointermove", { bubbles: true, clientX: x, clientY: y }));
    const stayed = parsePairs(s.nodes.find((n) => n.id === id)!.textParams?.pairs)[0];
    expect(stayed.sep).toBe(-100);
    expect(stayed.sat).toBe(0);
    // The wheel is the pair's own: its more colorful pick (0.12) sits 0.6
    // of the way out, so 0.12 is at 0.6 of the radius.
    const size = 320 / 3.4, r = size / 2 - 5, rad = 95 * Math.PI / 180;
    fireEvent(svg, new MouseEvent("pointermove", { bubbles: true, clientX: size / 2 + r * 0.6 * Math.cos(rad), clientY: size / 2 - r * 0.6 * Math.sin(rad) }));
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

  // 2026-10-19: "The circles don't move far off of origin so if feels like
  // it uses lots of space", and the dials' labels stood larger than other
  // sliders'.
  it("spreads the pair across its own wheel, and labels its dials as the other sliders are", () => {
    let s = run(initialState(), { type: "set_category", title: "Recolor", on: true });
    const id = toolNode(s, "recolor")!.id;
    // Two quiet colors, 0.06 and 0.04 chroma: on a fixed 0.3 wheel they sat
    // a fifth of the way out.
    const quiet = { ...pair(200, 40), a: { ...pair(200, 40).a, c: 0.06 }, b: { ...pair(200, 40).b, c: 0.04 } };
    s = run(s, { type: "set_text_param", id, param: "pairs", value: JSON.stringify([quiet]) });
    render(<RecolorPairs state={s} node={s.nodes.find((n) => n.id === id)!} dispatch={() => {}} width={320} />);
    fireEvent.click(screen.getByTestId("recolor-pairs-toggle"));
    const size = 320 / 3.4, r = size / 2 - 5;
    const out = (which: "a" | "b") => {
      const h = screen.getByTestId(`recolor-pair-handle-0-${which}`);
      return Math.hypot(Number(h.getAttribute("cx")) - size / 2, Number(h.getAttribute("cy")) - size / 2) / r;
    };
    expect(out("a")).toBeCloseTo(0.6, 2);
    expect(out("b")).toBeCloseTo(0.4, 2);
    // The rings are the slimmer size.
    expect(screen.getByTestId("recolor-pair-handle-0-a").getAttribute("r")).toBe("4.5");
    // The dials' names and numbers wear the slider rows' classes.
    const row = screen.getByTestId("recolor-pair-sep-0").closest(".srow")!;
    expect(row.querySelector(".lbl")?.textContent).toBe("Separation");
    expect(row.querySelector(".val")).not.toBeNull();
  });
});

// 2026-11: with the Neutral guard at 0, a dark green the engine
// would have moved in full was silently refused by a fixed 0.02 floor.
describe("the pair picker's floor", () => {
  it("follows the Neutral guard, with a floor for hue noise", () => {
    for (const g of [2, 5, 10, 20, 50]) {
      expect(guardGate(pairPickFloor(g), g), `guard ${g}`).toBeCloseTo(0.1, 3);
    }
    expect(pairPickFloor(0)).toBe(PAIR_PICK_NOISE);
    expect(pairPickFloor(10), "no stricter than the old fixed floor at the default guard").toBeLessThan(0.02);
    expect(pairPickFloor(5)).toBeLessThan(pairPickFloor(10));
  });

  it("holds at fractional guards and the slider's top, and never falls as the guard rises", () => {
    // The slider runs 0 to 100 and is not limited to whole numbers.
    for (const g of [0.1, 0.5, 0.9, 1, 1.1, 2.5, 99.5, 100]) {
      const floor = pairPickFloor(g);
      expect(floor, `guard ${g}`).toBeGreaterThanOrEqual(PAIR_PICK_NOISE);
      if (floor > PAIR_PICK_NOISE) expect(guardGate(floor, g), `guard ${g}`).toBeCloseTo(0.1, 3);
      else expect(guardGate(PAIR_PICK_NOISE, g), `guard ${g}: the noise floor already gets a tenth`).toBeGreaterThanOrEqual(0.1);
    }
    // At the top a vivid color still pairs: sRGB red is about 0.26.
    expect(pairPickFloor(100)).toBeLessThan(0.26);
    let prev = 0;
    for (let g = 0; g <= 100; g += 0.25) {
      const floor = pairPickFloor(g);
      expect(floor, `guard ${g}`).toBeGreaterThanOrEqual(prev);
      prev = floor;
    }
  });

  async function pickAt(guard: number, rgb: [number, number, number]) {
    _clearFlashForTests();
    let s = run(initialState(), { type: "set_category", title: "Recolor", on: true });
    const id = toolNode(s, "recolor")!.id;
    s = run(s, { type: "set_param", id, param: "neutral_guard", value: guard }, { type: "toggle_recolor_pair_pick", id });
    let current = s;
    const dispatch = (c: Command) => {
      current = reduce(current, c);
      view.rerender(<RecolorPairLayer state={current} dispatch={dispatch} view={IDENTITY_VIEW} />);
    };
    const view = render(<RecolorPairLayer state={current} dispatch={dispatch} view={IDENTITY_VIEW} />);
    sampleMock.mockResolvedValueOnce({ luma: 0, hue: 0, sat: 0, r: rgb[0], g: rgb[1], b: rgb[2] });
    fireEvent.mouseDown(screen.getByTestId("recolor-pair-overlay"), { button: 0, clientX: 0, clientY: 0 });
    await waitFor(() => expect(sampleMock).toHaveBeenCalled());
    await act(async () => {});
    view.unmount();
    return current;
  }
  // The issue's dark green, sRGB (20,22,20): OkLab chroma 0.005.
  const lin = (v: number) => ((v / 255 + 0.055) / 1.055) ** 2.4;
  const DARK_GREEN: [number, number, number] = [lin(20), lin(22), lin(20)];

  it("takes a dark green at guard 0", async () => {
    const s = await pickAt(0, DARK_GREEN);
    expect(s.recolorPairPick?.first).not.toBeNull();
    expect(currentFlash()).toBeNull();
  });

  it("says in the browser build that picking needs the desktop app", async () => {
    _clearFlashForTests();
    const s = run(initialState(), { type: "toggle_recolor_pair_pick", id: "recolor" });
    render(<RecolorPairLayer state={s} dispatch={() => {}} view={IDENTITY_VIEW} />);
    sampleMock.mockResolvedValueOnce(null);
    fireEvent.mouseDown(screen.getByTestId("recolor-pair-overlay"), { button: 0, clientX: 0, clientY: 0 });
    await waitFor(() => expect(currentFlash()).toBe("Picking a pair's colors needs the desktop app"));
  });

  it("says why at the click when a pick is too gray, and stays armed", async () => {
    let s = await pickAt(10, DARK_GREEN);
    expect(s.recolorPairPick).not.toBeNull();
    expect(s.recolorPairPick?.first).toBeNull();
    expect(currentFlash()).toMatch(/Too gray to pair at Neutral guard 10: lower the guard/);
    s = await pickAt(0, [0.2, 0.2, 0.2]);
    expect(s.recolorPairPick?.first).toBeNull();
    expect(currentFlash()).toBe("Too gray to pair: no hue here");
  });
});

// 2026-11: only the 1.6 px painted ring took a press.
describe("the pair scope's handles", () => {
  function scope(p: RecolorPair) {
    let s = run(initialState(), { type: "set_category", title: "Recolor", on: true });
    const id = toolNode(s, "recolor")!.id;
    s = run(s, { type: "set_text_param", id, param: "pairs", value: JSON.stringify([p]) });
    const cmds: Command[] = [];
    render(<RecolorPairs state={s} node={s.nodes.find((n) => n.id === id)!} dispatch={(c) => cmds.push(c)} width={320} />);
    fireEvent.click(screen.getByTestId("recolor-pairs-toggle"));
    const svg = screen.getByTestId("recolor-pair-scope-0");
    svg.getBoundingClientRect = () => ({ left: 0, top: 0, width: 320 / 3.4, height: 320 / 3.4 } as DOMRect);
    const at = (which: "a" | "b") => {
      const h = screen.getByTestId(`recolor-pair-handle-0-${which}`);
      return [Number(h.getAttribute("cx")), Number(h.getAttribute("cy"))];
    };
    const press = (x: number, y: number) => {
      fireEvent(svg, new MouseEvent("pointerdown", { bubbles: true, button: 0, clientX: x, clientY: y }));
      const began = cmds.some((c) => c.type === "begin_gesture");
      fireEvent(svg, new MouseEvent("pointerup", { bubbles: true }));
      cmds.length = 0;
      return began;
    };
    return { svg, at, press, cmds };
  }

  it("grabs at the ring's center and a margin around it, not far off", () => {
    const { at, press } = scope(pair(200, 20));
    const [x, y] = at("a");
    expect(press(x, y), "the center").toBe(true);
    expect(press(x + 9, y), "a few pixels outside the ring").toBe(true);
    expect(press(x + 20, y + 20), "well away").toBe(false);
    // The visible ring is drawn as before, and a wider clear circle sits under it.
    expect(screen.getByTestId("recolor-pair-handle-0-a").getAttribute("r")).toBe("4.5");
    expect(Number(screen.getByTestId("recolor-pair-hit-0-a").getAttribute("r"))).toBeGreaterThanOrEqual(10);
  });

  it("gives a press between two close rings to the nearer", () => {
    const { svg, at, cmds } = scope(pair(100, 110, { width: 5 }));
    const [ax, ay] = at("a");
    const [bx, by] = at("b");
    const size = 320 / 3.4, r = size / 2 - 5;
    // Drag to hue 70 at the picks' chroma (0.6 of the radius).
    const to = (h: number) => [size / 2 + r * 0.6 * Math.cos((h * Math.PI) / 180), size / 2 - r * 0.6 * Math.sin((h * Math.PI) / 180)];
    const drag = (fromX: number, fromY: number) => {
      fireEvent(svg, new MouseEvent("pointerdown", { bubbles: true, button: 0, clientX: fromX, clientY: fromY }));
      const [tx, ty] = to(70);
      fireEvent(svg, new MouseEvent("pointermove", { bubbles: true, clientX: tx, clientY: ty }));
      fireEvent(svg, new MouseEvent("pointerup", { bubbles: true }));
      const set = cmds.filter((c) => c.type === "set_text_param").pop() as Extract<Command, { type: "set_text_param" }>;
      cmds.length = 0;
      return pairAfter(parsePairs(set.value)[0]);
    };
    // A third of the way from A to B takes A: A turns out to 70. Two
    // thirds takes B, which can only come toward A: they meet at 105.
    expect(drag(ax + (bx - ax) / 3, ay + (by - ay) / 3).a.h).toBeCloseTo(70, 0);
    expect(drag(ax + (bx - ax) * 2 / 3, ay + (by - ay) * 2 / 3).b.h).toBeCloseTo(105, 0);
  });

  it("takes a press on the transparent hit circle as one gesture", () => {
    const { svg, at, cmds } = scope(pair(200, 20));
    const [x, y] = at("a");
    fireEvent(screen.getByTestId("recolor-pair-hit-0-a"), new MouseEvent("pointerdown", { bubbles: true, button: 0, clientX: x, clientY: y }));
    fireEvent(svg, new MouseEvent("pointerup", { bubbles: true }));
    expect(cmds.map((c) => c.type)).toEqual(["begin_gesture", "end_gesture"]);
  });

  it("ignores a primary press chorded with another button", () => {
    const { svg, at, cmds } = scope(pair(200, 20));
    const [x, y] = at("a");
    fireEvent(svg, new MouseEvent("pointerdown", { bubbles: true, button: 0, buttons: 5, clientX: x, clientY: y }));
    expect(cmds).toEqual([]);
  });

  it("ends its gesture when the pointer is canceled", () => {
    const { svg, at, cmds } = scope(pair(200, 20));
    const [x, y] = at("a");
    fireEvent(svg, new MouseEvent("pointerdown", { bubbles: true, button: 0, clientX: x, clientY: y }));
    fireEvent(svg, new MouseEvent("pointercancel", { bubbles: true }));
    expect(cmds.map((c) => c.type)).toEqual(["begin_gesture", "end_gesture"]);
  });

  it("uses SVG coordinates when the scope is scaled", () => {
    const { svg, at, cmds } = scope(pair(100, 20));
    const size = 320 / 3.4, r = size / 2 - 5;
    svg.getBoundingClientRect = () => ({ left: 20, top: 10, width: size * 2, height: size * 2 } as DOMRect);
    const [ax, ay] = at("a");
    fireEvent(svg, new MouseEvent("pointerdown", { bubbles: true, button: 0, clientX: 20 + ax * 2, clientY: 10 + ay * 2 }));
    const tx = size / 2 + r * 0.6 * Math.cos(70 * Math.PI / 180);
    const ty = size / 2 - r * 0.6 * Math.sin(70 * Math.PI / 180);
    fireEvent(svg, new MouseEvent("pointermove", { bubbles: true, clientX: 20 + tx * 2, clientY: 10 + ty * 2 }));
    fireEvent(svg, new MouseEvent("pointerup", { bubbles: true }));
    const set = cmds.filter((c) => c.type === "set_text_param").pop() as Extract<Command, { type: "set_text_param" }>;
    expect(set).toBeDefined();
    const moved = pairAfter(parsePairs(set.value)[0]);
    expect(moved.a.h).toBeCloseTo(70, 0);
    expect(moved.a.c).toBeCloseTo(0.12, 5);
  });

  it("keeps the whole hit circle available at the scope's edge", () => {
    const { svg, at, press } = scope(pair(0, 180, { sat: 100 }));
    const [x, y] = at("a");
    expect(svg.style.overflow).toBe("visible");
    expect(press(x + 10, y), "the reach outside the SVG's bounds").toBe(true);
  });
});
