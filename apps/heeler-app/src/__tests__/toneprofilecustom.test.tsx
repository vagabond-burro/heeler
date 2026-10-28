import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const SAVED = JSON.stringify({ name: "Soft Fade", interp: "smooth", points: [[-8, 0.04], [0, 0.42], [3, 0.95]] });

vi.mock("../bridge", async (importOriginal) => {
  const real = (await importOriginal()) as Record<string, unknown>;
  return {
    ...real,
    toneProfileList: vi.fn(async () => [{ path: "/p/Soft Fade.heelerprofile", file: "Soft Fade", name: "Soft Fade", curve: SAVED, error: null }]),
    toneProfileSave: vi.fn(async () => "/p/Mine.heelerprofile"),
    toneProfileImport: vi.fn(async () => ({ name: "Phone", curve: JSON.stringify({ name: "Phone", interp: "smooth", points: [[-8, 0], [2.4739, 1]] }), saved: null })),
  };
});

import { App } from "../app";
import { serializeGraph, toneProfileSave } from "../bridge";
import { initialState } from "../data";
import { reduce, type State } from "../state";
import {
  WHITE_STOPS,
  parseToneCurve,
  profileChoices,
  profileMenuValue,
  profilePick,
  standardAt,
  standardSeed,
  toneCurveAt,
} from "../toneprofile";
import { ToneCurveBlock } from "../ui/tonecurve";
import { chooseWith, menuValue } from "./menuhelp";

const profileOf = (s: State) => s.nodes.find((n) => n.type === "heeler.tone_profile")!;

describe("Tone Profile: Custom", () => {
  it("a fresh Custom starts on the Standard curve, white held at scene white", () => {
    const seed = standardSeed();
    expect(seed.points[seed.points.length - 1][0]).toBeCloseTo(WHITE_STOPS, 3);
    for (const [x, y] of seed.points) expect(y).toBeCloseTo(standardAt(x), 3);
    // Middle gray: the Standard S puts it a touch under the display value of 0.18.
    expect(toneCurveAt(seed, 0)).toBeGreaterThan(0.4);
    expect(toneCurveAt(seed, 0)).toBeLessThan(0.47);
    // Past the ends the end holds, as the engine holds it.
    expect(toneCurveAt(seed, -20)).toBe(seed.points[0][1]);
    expect(toneCurveAt(seed, 9)).toBe(seed.points[seed.points.length - 1][1]);
  });

  it("reads only curves the engine would take", () => {
    expect(parseToneCurve("")).toBeNull();
    expect(parseToneCurve("{")).toBeNull();
    expect(parseToneCurve('{"points":[[0,0.5]]}')).toBeNull();
    expect(parseToneCurve('{"points":[[2,1],[-2,0]]}')!.points[0]).toEqual([-2, 0]);
    expect(parseToneCurve('{"interp":"linear","points":[[0,0],[1,1]]}')!.interp).toBe("linear");
    expect(parseToneCurve('{"interp":"cubic","points":[[0,0],[1,1]]}')).toBeNull();
    expect(parseToneCurve('{"points":[[0,0],[0,1]]}')).toBeNull();
    expect(parseToneCurve('{"points":[[0,0],[25,1]]}')).toBeNull();
    expect(parseToneCurve('{"points":[[0,0],"bad",[1,1]]}')).toBeNull();
    expect(parseToneCurve(JSON.stringify({ points: Array.from({ length: 1025 }, (_, i) => [i / 100, 0]) }))).toBeNull();
    // The engine clamps display values rather than refusing them.
    expect(parseToneCurve('{"points":[[0,-1],[1,2]]}')!.points).toEqual([[0, 0], [1, 1]]);
  });

  it("the menu still names a saved profile after the writer rounds its curve", () => {
    const before = profileOf(initialState());
    const curve = JSON.stringify({ name: "Soft", interp: "smooth", points: [[-8, 0], [0, 0.123456], [3, 1]] });
    const rounded = JSON.stringify({ name: "Soft", interp: "smooth", points: [[-8.0, 0.0], [0.0, 0.1235], [3.0, 1.0]] });
    const node = { ...before, textParams: { ...before.textParams, mode: "custom", curve } };
    const saved = [{ path: "/p/Soft.heelerprofile", file: "Soft", name: "Soft", curve: rounded, error: null }];
    expect(profileMenuValue(node, saved)).toBe("profile:/p/Soft.heelerprofile");
    const changed = { ...node, textParams: { ...node.textParams, curve: JSON.stringify({ ...JSON.parse(curve), points: [[-8, 0], [0, 0.124], [3, 1]] }) } };
    expect(profileMenuValue(changed, saved)).toBe("custom");
  });

  it("the menu lists saved profiles beside the modes; picking one copies its curve in one undo step", () => {
    let s: State = initialState();
    const saved = [{ path: "/p/Soft.heelerprofile", file: "Soft", name: "Soft", curve: SAVED, error: null }];
    const broken = { path: "/p/Bad.heelerprofile", file: "Bad", name: "Bad", curve: null, error: "no points" };
    expect(profileChoices([...saved, broken]).map((c) => c.id)).toEqual(["linear", "standard", "film", "custom", "profile:/p/Soft.heelerprofile"]);
    const before = profileOf(s);
    expect(profileMenuValue(before, saved)).toBe("standard");
    const pick = profilePick(before, "profile:/p/Soft.heelerprofile", saved)!;
    s = reduce(s, pick);
    expect(profileOf(s).textParams?.mode).toBe("custom");
    expect(profileOf(s).textParams?.curve).toBe(SAVED);
    expect(profileMenuValue(profileOf(s), saved)).toBe("profile:/p/Soft.heelerprofile");
    // The curve rides to the engine in the params: the document is
    // self-contained.
    type Sent = { nodes: { type: string; params: Record<string, unknown> }[] };
    const sent = (serializeGraph(s) as Sent).nodes.find((n) => n.type === "heeler.tone_profile")!;
    expect(sent.params.mode).toBe("custom");
    expect(sent.params.curve).toBe(SAVED);
    // Edited, it is no longer the saved profile: the menu says Custom.
    const edited = JSON.stringify({ ...JSON.parse(SAVED), points: [[-8, 0.04], [0, 0.5], [3, 0.95]] });
    s = reduce(s, { type: "set_tone_curve", id: before.id, curve: edited });
    expect(profileMenuValue(profileOf(s), saved)).toBe("custom");
    s = reduce(s, { type: "undo" });
    s = reduce(s, { type: "undo" });
    expect(profileOf(s).textParams?.mode).toBe("standard");
    // Custom with no curve yet starts from the seed.
    const fresh = profilePick(profileOf(s), "custom", saved)!;
    expect(fresh.type).toBe("set_tone_curve");
    expect(parseToneCurve((fresh as { curve: string }).curve)).toEqual(standardSeed());
  });

  it("a canceled point drag closes its undo gesture", () => {
    const dispatch = vi.fn();
    render(<ToneCurveBlock node={profileOf(initialState())} dispatch={dispatch} />);
    const editor = screen.getByTestId("tone-curve-editor") as unknown as SVGSVGElement;
    editor.setPointerCapture = vi.fn();
    fireEvent(screen.getByTestId("tone-curve-point-2"), new MouseEvent("pointerdown", { bubbles: true, button: 0 }));
    expect(dispatch).toHaveBeenCalledWith({ type: "begin_gesture", key: `${profileOf(initialState()).id}.tone_curve` });
    fireEvent(editor, new MouseEvent("pointercancel", { bubbles: true }));
    expect(dispatch).toHaveBeenCalledWith({ type: "end_gesture" });
    fireEvent(editor, new MouseEvent("pointerup", { bubbles: true }));
    expect(dispatch.mock.calls.filter(([cmd]) => cmd.type === "end_gesture")).toHaveLength(1);
  });

  it("Develop draws the curve under Custom, hides Toe and Highlight roll, and saves, imports and edits it", async () => {
    const user = userEvent.setup();
    render(<App />);
    await user.click(screen.getByTestId("collapse-source"));
    const menu = screen.getByTestId("tone-profile");
    expect(screen.queryByTestId("tone-curve-editor")).toBeNull();
    expect(screen.getByRole("slider", { name: /toe/i })).toBeInTheDocument();
    await waitFor(() => expect(document.querySelector('[data-testid="tone-profile"]')).toBeTruthy());
    await chooseWith(user, menu, "custom");
    expect(menuValue(screen.getByTestId("tone-profile"))).toBe("custom");
    expect(screen.getByTestId("tone-curve-editor")).toBeInTheDocument();
    expect(screen.queryByRole("slider", { name: /^toe/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("slider", { name: /highlight roll/i })).not.toBeInTheDocument();
    expect(screen.getByRole("slider", { name: /profile amt/i })).toBeInTheDocument();
    expect(screen.getAllByTestId(/^tone-curve-point-/)).toHaveLength(standardSeed().points.length);
    // Double-clicking a point removes it.
    fireEvent.doubleClick(screen.getByTestId("tone-curve-point-3"));
    expect(screen.getAllByTestId(/^tone-curve-point-/)).toHaveLength(standardSeed().points.length - 1);
    // Save names it and writes it.
    const name = screen.getByTestId("tone-curve-name");
    await user.clear(name);
    await user.type(name, "Mine");
    await user.click(screen.getByTestId("tone-curve-save"));
    await waitFor(() => expect(toneProfileSave).toHaveBeenCalled());
    const [curve, saved] = vi.mocked(toneProfileSave).mock.calls[0];
    expect(saved).toBe("Mine");
    expect(parseToneCurve(curve)!.points).toHaveLength(standardSeed().points.length - 1);
    // Import sets the curve it read.
    await user.click(screen.getByTestId("tone-curve-import"));
    await waitFor(() => expect(screen.getAllByTestId(/^tone-curve-point-/)).toHaveLength(2));
    // A saved profile is in the menu and picks.
    await chooseWith(user, screen.getByTestId("tone-profile"), "profile:/p/Soft Fade.heelerprofile");
    expect(screen.getByTestId("tone-profile")).toHaveTextContent("Soft Fade");
    expect(screen.getAllByTestId(/^tone-curve-point-/)).toHaveLength(3);
  });
});
