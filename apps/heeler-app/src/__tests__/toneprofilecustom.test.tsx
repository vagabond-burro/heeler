import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
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
import { serializeGraph, toneProfileList, toneProfileSave } from "../bridge";
import { initialState } from "../data";
import { reduce, type State } from "../state";
import {
  MAX_POINTS,
  WHITE_STOPS,
  curveBroken,
  parseToneCurve,
  toneCurveJson,
  profileChoices,
  profileMenuValue,
  profilePick,
  reloadToneProfiles,
  standardAt,
  standardSeed,
  toneCurveAt,
  useToneProfiles,
} from "../toneprofile";
import { ProfileMenuRow, ToneCurveBlock } from "../ui/tonecurve";
import { chooseWith, menuValue } from "./menuhelp";

const profileOf = (s: State) => s.nodes.find((n) => n.type === "heeler.tone_profile")!;

/** A press on a drawn point, where the editor's hit test looks for it:
 * the test DOM lays the plot out at the page's origin. */
function pressOn(el: Element, init: MouseEventInit = {}): MouseEvent {
  const cx = Number(el.getAttribute("cx"));
  const cy = Number(el.getAttribute("cy"));
  return new MouseEvent("pointerdown", { bubbles: true, cancelable: true, button: 0, clientX: cx, clientY: cy, ...init });
}

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

  it("takes and refuses the same curves as the engine (tests/tone_curve_cases.json)", () => {
    type Case = { name: string; json: string; interp?: string; points: [number, number][] | null };
    const { cases }: { cases: Case[] } = JSON.parse(
      readFileSync(resolve(process.cwd(), "../../crates/heeler-engine/tests/tone_curve_cases.json"), "utf8"),
    );
    for (const c of cases) {
      const got = parseToneCurve(c.json);
      if (c.points === null) expect(got, c.name).toBeNull();
      else {
        expect(got?.points, c.name).toEqual(c.points);
        expect(got?.interp, c.name).toBe(c.interp);
      }
    }
  });

  it("the editor adds no point past the engine's limit", () => {
    const base = profileOf(initialState());
    const full = { name: "full", interp: "linear", points: Array.from({ length: MAX_POINTS }, (_, i) => [-20 + i * 0.01, i / MAX_POINTS]) };
    const node = { ...base, textParams: { ...base.textParams, mode: "custom", curve: JSON.stringify(full) } };
    const dispatch = vi.fn();
    render(<ToneCurveBlock node={node} dispatch={dispatch} />);
    const editor = screen.getByTestId("tone-curve-editor") as unknown as SVGSVGElement;
    editor.setPointerCapture = vi.fn();
    editor.getBoundingClientRect = () => ({ left: 0, top: 0, width: 260, height: 150, right: 260, bottom: 150, x: 0, y: 0, toJSON: () => ({}) });
    // Far right of the plot, clear of every point.
    fireEvent(editor, new MouseEvent("pointerdown", { bubbles: true, button: 0, clientX: 250, clientY: 40 }));
    expect(dispatch.mock.calls.some(([cmd]) => cmd.type === "set_tone_curve" || cmd.type === "begin_gesture")).toBe(false);
    expect(dispatch).toHaveBeenCalledWith({ type: "set_notice", text: expect.stringContaining(`${MAX_POINTS} points`) });
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

  it("edits like Curves: a near miss grabs, the remove chord takes an inner point, points keep their room", () => {
    // "Tone profile curve is all messed up. Impossible to edit, isn't it
    // supposed to behave like the curve editor?"
    const id = profileOf(initialState()).id;
    let node = { ...profileOf(initialState()), textParams: { ...profileOf(initialState()).textParams, mode: "custom", curve: toneCurveJson(standardSeed()) } };
    const writes: string[] = [];
    const dispatch = vi.fn((c: { type: string; curve?: string }) => {
      if (c.type === "set_tone_curve") {
        writes.push(c.curve!);
        node = { ...node, textParams: { ...node.textParams, curve: c.curve! } };
      }
    });
    const view = render(<ToneCurveBlock node={node} dispatch={dispatch as never} />);
    const editor = screen.getByTestId("tone-curve-editor") as unknown as SVGSVGElement;
    editor.setPointerCapture = vi.fn();
    const count = () => screen.getAllByTestId(/^tone-curve-point-/).length;
    const n = count();
    // Six pixels off a point grabs it: a drag, no new point.
    const p2 = screen.getByTestId("tone-curve-point-2");
    fireEvent(editor, new MouseEvent("pointerdown", { bubbles: true, cancelable: true, button: 0, clientX: Number(p2.getAttribute("cx")) + 4, clientY: Number(p2.getAttribute("cy")) + 4 }));
    expect(dispatch).toHaveBeenCalledWith({ type: "begin_gesture", key: `${id}.tone_curve` });
    expect(writes).toHaveLength(0);
    // Dragged onto its neighbor, it stops a quarter stop short.
    const p3 = screen.getByTestId("tone-curve-point-3");
    fireEvent(editor, new MouseEvent("pointermove", { bubbles: true, clientX: Number(p3.getAttribute("cx")) + 20, clientY: Number(p3.getAttribute("cy")) }));
    const dragged = parseToneCurve(writes[writes.length - 1])!.points;
    expect(dragged[3][0] - dragged[2][0]).toBeGreaterThanOrEqual(0.25 - 1e-6);
    fireEvent(editor, new MouseEvent("pointerup", { bubbles: true }));
    view.rerender(<ToneCurveBlock node={node} dispatch={dispatch as never} />);
    // The remove chord on an end point keeps it; on an inner one takes it.
    const before = writes.length;
    fireEvent(editor, pressOn(screen.getByTestId("tone-curve-point-0"), { metaKey: true }));
    expect(writes).toHaveLength(before);
    fireEvent(editor, pressOn(screen.getByTestId(`tone-curve-point-${n - 1}`), { ctrlKey: true }));
    expect(writes).toHaveLength(before);
    // A remove chord off every point adds nothing.
    fireEvent(editor, new MouseEvent("pointerdown", { bubbles: true, cancelable: true, button: 0, ctrlKey: true, clientX: 120, clientY: 20 }));
    expect(writes).toHaveLength(before);
    expect(screen.getByText(/-click one to remove it/)).toBeInTheDocument();
  });

  it("wears the app's controls: Curves' Smooth and Linear button, chips, the panel's text field", () => {
    // "Why is tone profile curve not using the same smooth/linear buttons
    // used on the curve editors? The buttons and input field does not
    // match the look of the rest of the app."
    const dispatch = vi.fn();
    render(<ToneCurveBlock node={profileOf(initialState())} dispatch={dispatch} />);
    const interp = screen.getByTestId("tone-curve-interp");
    expect(interp).toHaveClass("chip");
    expect(interp.getAttribute("data-mode")).toBe("smooth");
    fireEvent.click(interp);
    const [cmd] = dispatch.mock.calls[dispatch.mock.calls.length - 1];
    expect(parseToneCurve(cmd.curve)!.interp).toBe("linear");
    for (const id of ["tone-curve-save", "tone-curve-import", "tone-curve-export"]) expect(screen.getByTestId(id)).toHaveClass("chip");
    expect(screen.getByTestId("tone-curve-name")).toHaveClass("field");
    expect(screen.queryByTestId("tone-curve-smooth")).toBeNull();
  });

  it("a canceled point drag closes its undo gesture", () => {
    const dispatch = vi.fn();
    render(<ToneCurveBlock node={profileOf(initialState())} dispatch={dispatch} />);
    const editor = screen.getByTestId("tone-curve-editor") as unknown as SVGSVGElement;
    editor.setPointerCapture = vi.fn();
    fireEvent(screen.getByTestId("tone-curve-point-2"), pressOn(screen.getByTestId("tone-curve-point-2")));
    expect(dispatch).toHaveBeenCalledWith({ type: "begin_gesture", key: `${profileOf(initialState()).id}.tone_curve` });
    fireEvent(editor, new MouseEvent("pointercancel", { bubbles: true }));
    expect(dispatch).toHaveBeenCalledWith({ type: "end_gesture" });
    fireEvent(editor, new MouseEvent("pointerup", { bubbles: true }));
    expect(dispatch.mock.calls.filter(([cmd]) => cmd.type === "end_gesture")).toHaveLength(1);
  });

  it("a broken curve shows as broken, not as Standard, and stays until Reset replaces it", () => {
    const base = profileOf(initialState());
    const node = { ...base, textParams: { ...base.textParams, mode: "custom", curve: '{"points":[[0,0],[0,1]]}' } };
    expect(curveBroken(node)).toBe(true);
    expect(curveBroken({ ...node, textParams: { ...node.textParams, curve: "" } })).toBe(false);
    // Picking Custom again keeps the broken curve rather than seeding over it.
    expect(profilePick({ ...node, textParams: { ...node.textParams, mode: "standard" } }, "custom", [])).toEqual({
      type: "set_text_param",
      id: node.id,
      param: "mode",
      value: "custom",
    });
    const dispatch = vi.fn();
    render(<ToneCurveBlock node={node} dispatch={dispatch} />);
    expect(screen.getByTestId("tone-curve-broken")).toBeInTheDocument();
    expect(screen.queryByTestId("tone-curve-editor")).toBeNull();
    expect(screen.getByTestId("tone-curve-import")).toBeInTheDocument();
    fireEvent.click(screen.getByTestId("tone-curve-reset"));
    expect(dispatch).toHaveBeenCalledWith({ type: "set_tone_curve", id: node.id, curve: JSON.stringify(standardSeed()) });
  });

  it("a profiles folder that cannot be read keeps the last listing and says why", async () => {
    const Names = () => <div data-testid="names">{useToneProfiles().map((p) => p.name).join(",")}</div>;
    const node = profileOf(initialState());
    render(
      <>
        <Names />
        <ProfileMenuRow node={node} dispatch={vi.fn()} testid="tp" />
      </>,
    );
    await act(() => reloadToneProfiles());
    await waitFor(() => expect(screen.getByTestId("names")).toHaveTextContent("Soft Fade"));
    expect(screen.queryByTestId("tp-list-error")).toBeNull();
    vi.mocked(toneProfileList).mockRejectedValueOnce("permission denied");
    await act(() => reloadToneProfiles());
    await waitFor(() => expect(screen.getByTestId("tp-list-error")).toHaveTextContent("permission denied"));
    expect(screen.getByTestId("names")).toHaveTextContent("Soft Fade");
    // A later read that works clears the notice.
    await act(() => reloadToneProfiles());
    await waitFor(() => expect(screen.queryByTestId("tp-list-error")).toBeNull());
  });

  it("a slow profile listing from before a newer one does not replace it", async () => {
    const Names = () => <div data-testid="names">{useToneProfiles().map((p) => p.name).join(",")}</div>;
    render(<Names />);
    const entry = (name: string) => ({ path: `/p/${name}.heelerprofile`, file: name, name, curve: SAVED, error: null });
    let finishOld: (v: ReturnType<typeof entry>[]) => void = () => {};
    vi.mocked(toneProfileList).mockImplementationOnce(() => new Promise((r) => (finishOld = r)));
    const old = reloadToneProfiles();
    vi.mocked(toneProfileList).mockResolvedValueOnce([entry("Newer")]);
    await act(() => reloadToneProfiles());
    await act(async () => {
      finishOld([entry("Older")]);
      await old;
    });
    await waitFor(() => expect(screen.getByTestId("names")).toHaveTextContent("Newer"));
    expect(screen.getByTestId("names")).not.toHaveTextContent("Older");
    await act(() => reloadToneProfiles());
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
    // Curves' remove chord takes a point away; a double-click does not.
    fireEvent.doubleClick(screen.getByTestId("tone-curve-point-3"));
    expect(screen.getAllByTestId(/^tone-curve-point-/)).toHaveLength(standardSeed().points.length);
    fireEvent(screen.getByTestId("tone-curve-point-3"), pressOn(screen.getByTestId("tone-curve-point-3"), { ctrlKey: true }));
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
