// The curve editors without a pointer: Curves and the Tone Profile's
// Custom curve take the same keys on a focused point (ui/curvekeys.ts).
// Every key is tried in both, against the real reducer, so the undo
// steps counted here are the ones Undo would take.

import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { initialState } from "../data";
import { reduce, type Command, type NodeCard, type State } from "../state";
import { MAX_POINTS, parseToneCurve, toneCurveAt, toneCurveJson, type ToneCurveDoc } from "../toneprofile";
import { CurveEditor } from "../ui/editors";
import { CURVE_KEYS_HINT, curveKeyAction } from "../ui/curvekeys";
import { ToneCurveBlock } from "../ui/tonecurve";

afterEach(cleanup);

type Pt = [number, number];

/** An editor over the real reducer: what it dispatches is reduced and
 * drawn again, as the app does. */
function mount(start: State, draw: (s: State, dispatch: (c: Command) => void) => React.ReactElement) {
  let s = start;
  const sent: Command[] = [];
  let view: ReturnType<typeof render>;
  const dispatch = (c: Command) => {
    sent.push(c);
    s = reduce(s, c);
    view.rerender(draw(s, dispatch));
  };
  view = render(draw(s, dispatch));
  return { state: () => s, sent, steps: () => s.undoStack.length };
}

const CURVES = "curves";
function curves(points: Pt[], extra: Partial<NodeCard> = {}) {
  const base = initialState();
  const start: State = {
    ...base,
    nodes: base.nodes.map((n) => (n.id === CURVES ? { ...n, curves: { rgb: points }, ...extra } : n)),
  };
  const m = mount(start, (s, dispatch) => (
    <CurveEditor node={s.nodes.find((n) => n.id === CURVES)!} dispatch={dispatch} />
  ));
  const node = () => m.state().nodes.find((n) => n.id === CURVES)!;
  return { ...m, node, points: () => node().curves!.rgb as Pt[], point: (i: number) => screen.getByTestId(`curve-point-${i}`) };
}

function tone(doc: ToneCurveDoc) {
  const base = initialState();
  const id = base.nodes.find((n) => n.type === "heeler.tone_profile")!.id;
  const start: State = {
    ...base,
    nodes: base.nodes.map((n) =>
      n.id === id ? { ...n, textParams: { ...n.textParams, mode: "custom", curve: toneCurveJson(doc) } } : n,
    ),
  };
  const m = mount(start, (s, dispatch) => <ToneCurveBlock node={s.nodes.find((n) => n.id === id)!} dispatch={dispatch} />);
  const curve = () => parseToneCurve(m.state().nodes.find((n) => n.id === id)!.textParams!.curve)!;
  return { ...m, curve, points: () => curve().points as Pt[], point: (i: number) => screen.getByTestId(`tone-curve-point-${i}`) };
}

const THREE: Pt[] = [[0, 0], [0.5, 0.5], [1, 1]];
const TONE: ToneCurveDoc = { name: "", interp: "smooth", points: [[-6, 0.02], [0, 0.4], [3, 0.95]] };

/** Both editors behind one face, so each key's test reads the same for
 * the two. A step is the small arrow step along [x, y]. */
const EDITORS = [
  { name: "Curves", open: () => curves(THREE), step: [0.01, 0.01] as const, ring: "curve-focus-ring", edit: "set_curve" },
  { name: "the Custom tone curve", open: () => tone(TONE), step: [0.1, 0.01] as const, ring: "tone-curve-focus-ring", edit: "set_tone_curve" },
];

describe("the keys of a curve's points", () => {
  it("are the arrows, Enter, Delete and Backspace, and leave the app's chords alone", () => {
    const key = (k: string, mods: Partial<Record<"shiftKey" | "ctrlKey" | "metaKey" | "altKey", boolean>> = {}) =>
      curveKeyAction({ key: k, shiftKey: false, ctrlKey: false, metaKey: false, altKey: false, ...mods });
    expect(key("ArrowRight")).toEqual({ kind: "move", dx: 1, dy: 0 });
    expect(key("ArrowUp", { shiftKey: true })).toEqual({ kind: "move", dx: 0, dy: 5 });
    expect(key("Enter")).toEqual({ kind: "add" });
    expect(key("Delete")).toEqual({ kind: "remove" });
    expect(key("Backspace")).toEqual({ kind: "remove" });
    expect(key("ArrowLeft", { metaKey: true })).toBeNull();
    expect(key("Backspace", { ctrlKey: true })).toBeNull();
    expect(key("z")).toBeNull();
    expect(key("Tab")).toBeNull();
  });

  for (const ed of EDITORS) {
    describe(`in ${ed.name}`, () => {
      it("Tab reaches every point, and the focused one wears a ring", () => {
        const e = ed.open();
        const n = e.points().length;
        for (let i = 0; i < n; i++) expect(e.point(i).getAttribute("tabindex")).toBe("0");
        expect(screen.queryByTestId(ed.ring)).toBeNull();
        fireEvent.focus(e.point(1));
        const ring = screen.getByTestId(ed.ring);
        expect(ring.getAttribute("cx")).toBe(e.point(1).getAttribute("cx"));
        expect(ring.getAttribute("cy")).toBe(e.point(1).getAttribute("cy"));
        expect(Number(ring.getAttribute("r"))).toBeGreaterThan(Number(e.point(1).getAttribute("r")));
        fireEvent.blur(e.point(1));
        expect(screen.queryByTestId(ed.ring)).toBeNull();
      });

      it("the four arrows move the focused point a small step, and a larger one with Shift", () => {
        const e = ed.open();
        const [sx, sy] = ed.step;
        const press = (key: string, shiftKey = false) => {
          fireEvent.keyDown(e.point(1), { key, shiftKey });
          fireEvent.keyUp(e.point(1), { key, shiftKey });
        };
        const [x0, y0] = e.points()[1];
        press("ArrowRight");
        expect(e.points()[1][0]).toBeCloseTo(x0 + sx, 6);
        press("ArrowLeft");
        press("ArrowLeft");
        expect(e.points()[1][0]).toBeCloseTo(x0 - sx, 6);
        press("ArrowUp");
        expect(e.points()[1][1]).toBeCloseTo(y0 + sy, 6);
        press("ArrowDown");
        press("ArrowDown");
        expect(e.points()[1][1]).toBeCloseTo(y0 - sy, 6);
        const [x1, y1] = e.points()[1];
        press("ArrowRight", true);
        press("ArrowUp", true);
        expect(e.points()[1][0]).toBeCloseTo(x1 + 5 * sx, 6);
        expect(e.points()[1][1]).toBeCloseTo(y1 + 5 * sy, 6);
        // The other points stay where they were.
        expect(e.points()[0]).toEqual(ed.name === "Curves" ? THREE[0] : TONE.points[0]);
      });

      it("each press is one undo step, and a held key's run of moves is one step", () => {
        const e = ed.open();
        const before = e.steps();
        const start = e.points()[1][1];
        // Held: the first press and five repeats, then the key comes up.
        fireEvent.keyDown(e.point(1), { key: "ArrowUp" });
        for (let i = 0; i < 5; i++) fireEvent.keyDown(e.point(1), { key: "ArrowUp", repeat: true });
        fireEvent.keyUp(e.point(1), { key: "ArrowUp" });
        expect(e.points()[1][1]).toBeCloseTo(start + 6 * ed.step[1], 6);
        expect(e.steps()).toBe(before + 1);
        expect(e.state().gesture).toBeNull();
        // Two separate presses: two more steps.
        for (let i = 0; i < 2; i++) {
          fireEvent.keyDown(e.point(1), { key: "ArrowUp" });
          fireEvent.keyUp(e.point(1), { key: "ArrowUp" });
        }
        expect(e.steps()).toBe(before + 3);
        // Undo takes the held run back whole.
        let s = e.state();
        for (let i = 0; i < 3; i++) s = reduce(s, { type: "undo" });
        expect(s.undoStack.length).toBe(before);
      });

      it("a key held when the point loses focus closes its step", () => {
        const e = ed.open();
        fireEvent.focus(e.point(1));
        fireEvent.keyDown(e.point(1), { key: "ArrowUp" });
        expect(e.state().gesture).not.toBeNull();
        fireEvent.blur(e.point(1));
        expect(e.state().gesture).toBeNull();
        expect(e.sent.filter((c) => c.type === "end_gesture")).toHaveLength(1);
      });

      it("a point stays between its neighbors and on the plot, and a press that moves nothing writes nothing", () => {
        const e = ed.open();
        const up = (key: string, times: number, i = 1) => {
          for (let k = 0; k < times; k++) {
            fireEvent.keyDown(e.point(i), { key, shiftKey: true });
            fireEvent.keyUp(e.point(i), { key, shiftKey: true });
          }
        };
        up("ArrowRight", 80);
        const [, mid, last] = e.points();
        expect(mid[0]).toBeLessThan(last[0]);
        up("ArrowUp", 80);
        expect(e.points()[1][1]).toBe(1);
        const steps = e.steps();
        const writes = e.sent.filter((c) => c.type === ed.edit).length;
        up("ArrowUp", 3);
        up("ArrowRight", 3);
        expect(e.sent.filter((c) => c.type === ed.edit).length).toBe(writes);
        expect(e.steps()).toBe(steps);
      });

      it("Delete and Backspace remove the focused point, and the two ends stay", () => {
        for (const key of ["Delete", "Backspace"]) {
          const e = ed.open();
          const before = e.steps();
          fireEvent.keyDown(e.point(1), { key });
          expect(e.points()).toHaveLength(2);
          expect(e.steps()).toBe(before + 1);
          // What is left is the minimum: neither end goes.
          fireEvent.keyDown(e.point(0), { key });
          fireEvent.keyDown(e.point(1), { key });
          expect(e.points()).toHaveLength(2);
          expect(e.steps()).toBe(before + 1);
          cleanup();
        }
      });

      it("Enter adds a point on the curve halfway to the next one, and it takes the focus", () => {
        const e = ed.open();
        const before = e.steps();
        const [a, b] = e.points();
        act(() => e.point(0).focus());
        fireEvent.keyDown(e.point(0), { key: "Enter" });
        expect(e.points()).toHaveLength(4);
        expect(e.steps()).toBe(before + 1);
        const added = e.points()[1];
        expect(added[0]).toBeCloseTo((a[0] + b[0]) / 2, 6);
        // On the curve as it was drawn: between its neighbors' values.
        expect(added[1]).toBeGreaterThan(a[1]);
        expect(added[1]).toBeLessThan(b[1]);
        expect(document.activeElement).toBe(e.point(1));
        expect(screen.getByTestId(ed.ring).getAttribute("cx")).toBe(e.point(1).getAttribute("cx"));
        // From the last point there is no next one: halfway back.
        const pts = e.points();
        fireEvent.keyDown(e.point(3), { key: "Enter" });
        expect(e.points()).toHaveLength(5);
        expect(e.points()[3][0]).toBeCloseTo((pts[2][0] + pts[3][0]) / 2, 6);
        expect(document.activeElement).toBe(e.point(3));
      });

      it("a point's accessible name reads its place among the points and its position", () => {
        const e = ed.open();
        const name = e.point(1).getAttribute("aria-label")!;
        expect(name).toMatch(/^Point 2 of 3: /);
        expect(e.point(1).getAttribute("role")).toBe("slider");
        // The plot is a group, so its points are not hidden behind an image.
        expect(e.point(1).closest("svg")!.getAttribute("role")).toBe("group");
        fireEvent.keyDown(e.point(1), { key: "ArrowUp" });
        fireEvent.keyUp(e.point(1), { key: "ArrowUp" });
        expect(e.point(1).getAttribute("aria-label")).not.toBe(name);
      });

      it("a chord of the app's passes through, and a key that is the editor's does not reach the app", () => {
        const e = ed.open();
        let reached = 0;
        const count = () => reached++;
        window.addEventListener("keydown", count);
        const writes = () => e.sent.filter((c) => c.type === ed.edit).length;
        fireEvent.keyDown(e.point(1), { key: "ArrowLeft", metaKey: true });
        fireEvent.keyDown(e.point(1), { key: "z", ctrlKey: true });
        expect(writes()).toBe(0);
        expect(reached).toBe(2);
        fireEvent.keyDown(e.point(1), { key: "ArrowLeft" });
        fireEvent.keyUp(e.point(1), { key: "ArrowLeft" });
        fireEvent.keyDown(e.point(1), { key: "Backspace" });
        expect(writes()).toBe(2);
        expect(reached).toBe(2);
        window.removeEventListener("keydown", count);
      });
    });
  }
});

describe("the keys in Curves", () => {
  it("name a point by input and output", () => {
    const e = curves([[0, 0], [0.25, 0.4], [1, 1]]);
    expect(e.point(1).getAttribute("aria-label")).toBe("Point 2 of 3: input 0.25, output 0.40");
    expect(screen.getByTestId("curve-plot").getAttribute("aria-label")).toBe("RGB curve");
  });

  it("keep the end points on the plot's edges", () => {
    const e = curves(THREE);
    for (const key of ["ArrowLeft", "ArrowRight"]) {
      fireEvent.keyDown(e.point(0), { key });
      fireEvent.keyUp(e.point(0), { key });
      fireEvent.keyDown(e.point(2), { key });
      fireEvent.keyUp(e.point(2), { key });
    }
    expect(e.points()[0][0]).toBe(0);
    expect(e.points()[2][0]).toBe(1);
    fireEvent.keyDown(e.point(0), { key: "ArrowUp" });
    fireEvent.keyUp(e.point(0), { key: "ArrowUp" });
    expect(e.points()[0]).toEqual([0, 0.01]);
  });

  it("add no point where two are too close for one between them", () => {
    const e = curves([[0, 0], [0.5, 0.5], [0.515, 0.52], [1, 1]]);
    fireEvent.keyDown(e.point(1), { key: "Enter" });
    expect(e.points()).toHaveLength(4);
  });

  it("keep Tangent's slopes and handles in step through an add and a remove", () => {
    const e = curves(THREE, { curveInterp: "tangent", curveTangents: { rgb: [1, 1, 1] } });
    fireEvent.keyDown(e.point(0), { key: "Enter" });
    expect(e.points()).toHaveLength(4);
    expect(e.node().curveTangents!.rgb).toHaveLength(4);
    expect(e.node().curveHandles!.rgb).toHaveLength(4);
    fireEvent.keyDown(e.point(1), { key: "Delete" });
    expect(e.node().curveTangents!.rgb).toHaveLength(3);
    expect(e.node().curveHandles!.rgb).toHaveLength(3);
  });

  it("move a point of the ink view as it is shown", () => {
    const base = initialState();
    const start: State = { ...base, nodes: base.nodes.map((n) => (n.id === CURVES ? { ...n, curves: { rgb: THREE } } : n)) };
    const m = mount(start, (s, dispatch) => (
      <CurveEditor node={s.nodes.find((n) => n.id === CURVES)!} dispatch={dispatch} channelMode="cmy" />
    ));
    const shown = () => screen.getByTestId("curve-point-1").getAttribute("aria-label");
    expect(shown()).toBe("Point 2 of 3: input 0.50, output 0.50");
    fireEvent.keyDown(screen.getByTestId("curve-point-1"), { key: "ArrowUp" });
    fireEvent.keyUp(screen.getByTestId("curve-point-1"), { key: "ArrowUp" });
    // Up on the ink is up on the screen and down in the stored curve.
    expect(shown()).toBe("Point 2 of 3: input 0.50, output 0.51");
    expect((m.state().nodes.find((n) => n.id === CURVES)!.curves!.rgb as Pt[])[1][1]).toBeCloseTo(0.49, 6);
  });

  it("the footer's hint names the keys", () => {
    curves(THREE);
    expect(screen.getByTestId("curve-help").getAttribute("data-hint")).toBe(CURVE_KEYS_HINT);
  });
});

describe("the keys in the Custom tone curve", () => {
  it("name a point by stops and display value", () => {
    const e = tone(TONE);
    expect(e.point(0).getAttribute("aria-label")).toBe("Point 1 of 3: -6.00 stops, display 0.020");
    expect(e.point(2).getAttribute("aria-label")).toBe("Point 3 of 3: +3.00 stops, display 0.950");
    expect(screen.getByTestId("tone-curve-editor").getAttribute("aria-label")).toBe("Custom tone curve");
  });

  it("put the added point on the curve's own value", () => {
    const e = tone(TONE);
    const want = toneCurveAt(e.curve(), -3);
    fireEvent.keyDown(e.point(0), { key: "Enter" });
    expect(e.points()[1][0]).toBe(-3);
    expect(e.points()[1][1]).toBeCloseTo(want, 3);
  });

  it("keep points a quarter stop apart: a move stops short, and a gap under two quarters takes no point", () => {
    const e = tone({ name: "", interp: "smooth", points: [[-6, 0.02], [0, 0.4], [0.4, 0.5], [3, 0.95]] });
    fireEvent.keyDown(e.point(1), { key: "Enter" });
    expect(e.points()).toHaveLength(4);
    for (let i = 0; i < 4; i++) {
      fireEvent.keyDown(e.point(1), { key: "ArrowRight" });
      fireEvent.keyUp(e.point(1), { key: "ArrowRight" });
    }
    expect(e.points()[1][0]).toBeCloseTo(0.15, 6);
  });

  it("keep Tangent's slopes and handles in step through an add and a remove", () => {
    const e = tone({ ...TONE, interp: "tangent", tangents: [0.05, 0.1, 0.05], handles: [null, null, null] });
    fireEvent.keyDown(e.point(0), { key: "Enter" });
    expect(e.curve().points).toHaveLength(4);
    expect(e.curve().tangents).toHaveLength(4);
    expect(e.curve().handles).toHaveLength(4);
    fireEvent.keyDown(e.point(1), { key: "Backspace" });
    expect(e.curve().tangents).toHaveLength(3);
    expect(e.curve().handles).toHaveLength(3);
  });

  it("add no point past the engine's limit, and say so", () => {
    const points: Pt[] = Array.from({ length: MAX_POINTS }, (_, i) => [-8 + (i * 14) / (MAX_POINTS - 1), i / (MAX_POINTS - 1)]);
    // Room between the first two, so the limit is what refuses.
    points[1] = [points[0][0] + 0.6, points[1][1]];
    for (let i = 2; i < MAX_POINTS; i++) points[i] = [points[1][0] + ((i - 1) * 13.4) / (MAX_POINTS - 2), points[i][1]];
    const e = tone({ name: "", interp: "linear", points });
    fireEvent.keyDown(e.point(0), { key: "Enter" });
    expect(e.points()).toHaveLength(MAX_POINTS);
    expect(e.sent.some((c) => c.type === "set_notice")).toBe(true);
  });

  it("the help under the plot names the keys", () => {
    tone(TONE);
    expect(screen.getByTestId("tone-curve-block").textContent).toContain(CURVE_KEYS_HINT);
  });
});
