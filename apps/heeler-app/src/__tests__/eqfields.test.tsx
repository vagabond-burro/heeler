// The curve editor's numeric face, and the snap under SHIFT.
//
// "two fields for the X and Y position of the selected
// point, that updates to show the current position as the user drags.
// The user can also manually type in a value. Also, while the user is
// dragging hold SHIFT snaps to increments of 0.25." And for Recolor,
// the same, with the step following the axes the cell's two menus
// chose.
//
// The step is a property of the UNIT, not of the control: stops snap at
// 0.25, hue degrees at 10, saturation points at 10. The owner's five
// Recolor cases, the case his table left out (the BY-Lum x axis), and
// both Relight axes are all two rules, and the snap targets are numbers
// a person can read on the axis, which is the same principle the layout
// presets settled on.

import { act, fireEvent, render, screen } from "@testing-library/react";

/** jsdom has no PointerEvent, and RTL's fireEvent.pointerDown builds an
 * event with no clientX at all, which reads as a click at nowhere. A
 * MouseEvent dispatched under the pointer event's NAME carries the
 * coordinates and the modifier keys, and React routes by name. */
function pointer(
  el: Element,
  type: "pointerdown" | "pointermove" | "pointerup",
  init: MouseEventInit,
) {
  // act(), because a raw dispatchEvent is outside RTL's wrapping and
  // React defers the setState the handler makes: the write reaches
  // dispatch synchronously either way, but the DOM the next assertion
  // reads would still be the old render.
  act(() => {
    el.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, ...init }));
  });
}
import { describe, expect, it } from "vitest";
import { EqEditor } from "../ui/eqeditor";
import {
  EQ_PRESETS,
  RECOLOR_AXIS,
  RECOLOR_OUT,
  parseEqPoints,
  recolorLayouts,
  serializeEqPoints,
  snapTo,
  type EqPoint,
} from "../eqcurve";
import type { Command, NodeCard } from "../state";
import { choose } from "./menuhelp";

/** A tone_eq card carrying `points`, or nothing for the fresh default. */
function toneNode(points?: EqPoint[]): NodeCard {
  return {
    id: "toneeq",
    type: "heeler.tone_eq",
    name: "Relight",
    cat: "color",
    x: 0,
    y: 0,
    enabled: true,
    params: {},
    textParams: points === undefined ? {} : { points: serializeEqPoints(points) },
    hasIn: true,
    hasOut: true,
  } as NodeCard;
}

/** Renders the editor at its default 272x170 and gives the svg the box
 * jsdom refuses to measure, so pointer math has pixels to work with. */
function mount(node: NodeCard) {
  const sent: Command[] = [];
  const utils = render(<EqEditor node={node} dispatch={((c: Command) => sent.push(c)) as never} />);
  // The PLOT svg by its own name: the interp toggle above it brought
  // icon svgs of its own, and querySelector("svg") started grabbing
  // those instead of the plot.
  const svg = utils.container.querySelector('[data-testid="eq-plot"]')! as SVGSVGElement;
  svg.getBoundingClientRect = () =>
    ({ left: 0, top: 0, right: 272, bottom: 170, width: 272, height: 170, x: 0, y: 0, toJSON() {} }) as DOMRect;
  return { sent, svg, ...utils };
}

// The editor's own geometry: PAD {l:34,r:8,t:6,b:15} inside 272x170.
const xToPx = (x: number) => 34 + ((x + 6) / 9) * 230;
const yToPx = (y: number) => 6 + (1 - (y + 2) / 4) * 149;
/** The points of the last write, which is what the graph would carry. */
const lastWrite = (sent: Command[]) => {
  const w = [...sent].reverse().find((c) => c.type === "set_text_param");
  return w ? parseEqPoints((w as { value: string }).value) : null;
};

describe("snapTo", () => {
  it("clicks to the step and tidies the float", () => {
    expect(snapTo(-2.63, 0.25)).toBe(-2.75);
    expect(snapTo(0.13, 0.25)).toBe(0.25);
    expect(snapTo(133, 10)).toBe(130);
    expect(snapTo(-47, 10)).toBe(-50);
    // The reason for the toFixed: 0.1 + 0.2 arithmetic must not leak
    // into a field the user reads.
    expect(snapTo(0.7500000001, 0.25)).toBe(0.75);
  });
});

describe("the X and Y fields", () => {
  it("sit disabled until a point is picked, and say how to pick one", () => {
    const { svg } = mount(toneNode());
    for (const id of ["eq-point-x", "eq-point-y"]) {
      const field = screen.getByTestId(id);
      expect(field).toBeDisabled();
      expect(field.closest("[data-hint]")?.getAttribute("data-hint")).toContain("Click a point");
    }
    // Picking the coarse layout's point at (-3, 0) wakes them up.
    pointer(svg, "pointerdown", { clientX: xToPx(-3), clientY: yToPx(0) });
    pointer(svg, "pointerup", {});
    expect(screen.getByTestId("eq-point-x")).toHaveValue("-3");
    expect(screen.getByTestId("eq-point-y")).toHaveValue("0");
    expect(screen.getByTestId("eq-point-x")).toBeEnabled();
  });

  it("track the drag as it happens", () => {
    const { svg } = mount(toneNode());
    pointer(svg, "pointerdown", { clientX: xToPx(-3), clientY: yToPx(0) });
    pointer(svg, "pointermove", { clientX: xToPx(-3), clientY: yToPx(1) });
    // Mid-drag, before pointerUp: the field reads the moving value.
    expect(parseFloat((screen.getByTestId("eq-point-y") as HTMLInputElement).value)).toBeCloseTo(1, 1);
    pointer(svg, "pointerup", {});
  });

  it("commit a typed value, clamped the way a drag is", () => {
    const { svg, sent } = mount(toneNode());
    pointer(svg, "pointerdown", { clientX: xToPx(-3), clientY: yToPx(0) });
    pointer(svg, "pointerup", {});
    const y = screen.getByTestId("eq-point-y");
    fireEvent.change(y, { target: { value: "1.5" } });
    fireEvent.keyDown(y, { key: "Enter" });
    expect(lastWrite(sent)![1]).toMatchObject({ x: -3, y: 1.5 });
    // Out of range comes back to the edge, not to an error.
    fireEvent.change(y, { target: { value: "9" } });
    fireEvent.keyDown(y, { key: "Enter" });
    expect(lastWrite(sent)![1].y).toBe(2);
    // X cannot cross its neighbor at -6 + the working gap...
    const x = screen.getByTestId("eq-point-x");
    fireEvent.change(x, { target: { value: "-8" } });
    fireEvent.keyDown(x, { key: "Enter" });
    expect(lastWrite(sent)![1].x).toBeCloseTo(-5.95, 5);
    // ...and typing is never snapped: the field is for the exact number.
    fireEvent.change(x, { target: { value: "-2.63" } });
    fireEvent.keyDown(x, { key: "Enter" });
    expect(lastWrite(sent)![1].x).toBe(-2.63);
  });
});

describe("SHIFT snaps the drag", () => {
  it("clicks to quarter stops on the EV editor, only while held", () => {
    const { svg, sent } = mount(toneNode());
    pointer(svg, "pointerdown", { clientX: xToPx(-3), clientY: yToPx(0) });
    // Free drag to an off-grid spot: lands where the hand is.
    pointer(svg, "pointermove", { clientX: xToPx(-2.63), clientY: yToPx(0.61) });
    let p = lastWrite(sent)![1];
    expect(Math.abs(p.x % 0.25)).toBeGreaterThan(0.001);
    // Same spot with SHIFT: both axes click to their step.
    pointer(svg, "pointermove", { clientX: xToPx(-2.63), clientY: yToPx(0.61), shiftKey: true });
    p = lastWrite(sent)![1];
    expect(p.x).toBe(-2.75);
    expect(p.y).toBe(0.5);
    pointer(svg, "pointerup", {});
  });
});

describe("starting fresh", () => {
  it("offers Empty in the layout menu, and empty means empty when read back", () => {
    const { sent } = mount(toneNode());
    expect(EQ_PRESETS[0].id).toBe("empty");
    choose(screen.getByTestId("eq-preset"), "empty");
    expect(lastWrite(sent)).toEqual([]);
    // Read back: "[]" stored is authoritative, not a fall-through to
    // the default layout, or Empty would be a layout that cannot be
    // chosen.
    const { container } = render(
      <EqEditor node={toneNode([])} dispatch={(() => {}) as never} />,
    );
    expect(container.querySelectorAll('[data-testid^="eq-point-"][data-testid$="0"]').length).toBe(0);
  });

  it("lets ALT-click take the last points away, which Empty makes legitimate", () => {
    // The remove gate used to stop at two. With an empty curve now a
    // real state, a point you can add but never remove would be the
    // inconsistency: start fresh, add one, be stuck with it.
    //
    // Two mounts, because the editor renders from its node prop and
    // this harness does not route dispatches back into one: each mount
    // is one deletion observed at the write.
    const two = mount(toneNode([{ x: -3, y: 1 }, { x: 1, y: 0 }]));
    pointer(two.svg, "pointerdown", { clientX: xToPx(-3), clientY: yToPx(1), altKey: true });
    expect(lastWrite(two.sent)).toEqual([{ x: 1, y: 0 }]);
    two.unmount();
    const one = mount(toneNode([{ x: 1, y: 0 }]));
    pointer(one.svg, "pointerdown", { clientX: xToPx(1), clientY: yToPx(0), altKey: true });
    expect(lastWrite(one.sent)).toEqual([]);
  });
});

describe("Recolor's snap steps follow its two menus", () => {
  it("matches the table the owner wrote, and covers the case it left out", () => {
    // BY (the x axis): "0 to 360 hue direction should snap in
    // increments of 10", "0 to +100 Sat could be increments of 10",
    // and BY-Lum, unlisted, follows the EV unit.
    expect(RECOLOR_AXIS.hue.snap).toBe(10);
    expect(RECOLOR_AXIS.sat.snap).toBe(10);
    expect(RECOLOR_AXIS.lum.snap).toBe(0.25);
    // ADJUST (the y axis): "-2 to +2 Lum would have to be 0.25",
    // "-100 to +100 Sat could be increments of 10", "-60 to 60 Hue
    // could be increments of 10".
    expect(RECOLOR_OUT.lum.snap).toBe(0.25);
    expect(RECOLOR_OUT.sat.snap).toBe(10);
    expect(RECOLOR_OUT.hue.snap).toBe(10);
  });
});

describe("the footer's shape", () => {
  it("orders the row picker, fields, then the interpolation faces on the right", () => {
    // "The Picker should be on the far left. That makes most
    // sense to keep it closest to the picture view where it gets used",
    // the fields one width in both sections; and (2026-09-02) the
    // Linear/Smooth/Tangent toggle below the spectrum on its right edge,
    // with the Layout menu above the spectrum on its left.
    const { container } = render(
      <EqEditor node={toneNode()} dispatch={(() => {}) as never} onTogglePick={() => {}} />,
    );
    const row = screen.getByTestId("eq-help").previousElementSibling as HTMLElement;
    const order = [...row.querySelectorAll("[data-testid]")].map((e) =>
      e.getAttribute("data-testid"),
    );
    expect(order.indexOf("tone-eq-pick")).toBeLessThan(order.indexOf("eq-point-x"));
    expect(order.indexOf("eq-point-x")).toBeLessThan(order.indexOf("eq-point-y"));
    expect(order.indexOf("eq-point-y")).toBeLessThan(order.indexOf("eq-interp"));
    expect(order).not.toContain("eq-preset");
    // The row starts at the plot's left edge, so the picker lines up
    // with the spectrum; the faces are pushed to the plot's right edge.
    expect(row.style.paddingLeft).toBe("34px");
    expect((screen.getByTestId("eq-interp").closest("[style*='margin-left: auto']"))).not.toBeNull();
    // The Layout menu sits above the plot, inset to the same edge. The
    // field sits in the MenuField wrapper, which sits in the row.
    const layoutRow = screen.getByTestId("eq-preset").parentElement!.parentElement as HTMLElement;
    expect(layoutRow.style.paddingLeft).toBe("34px");
    expect(layoutRow.compareDocumentPosition(screen.getByTestId("eq-plot")) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect((screen.getByTestId("eq-point-x") as HTMLElement).style.width).toBe("42px");
    expect(container).toBeTruthy();
  });

  it("puts the help line on its own row under the controls", () => {
    // "Put the help text below the X, Y, Picker, and Layout
    // control." Sharing the row squeezed the teaching text into whatever
    // was left beside four controls, which in a Recolor cell was a column
    // three words wide.
    mount(toneNode());
    const help = screen.getByTestId("eq-help");
    expect(help.textContent).toContain("SHIFT-drag snaps");
    // Below, not beside: the row above it holds the controls, and the
    // help is not inside that row.
    expect(help.previousElementSibling!.contains(screen.getByTestId("eq-point-x"))).toBe(true);
    expect(help.contains(screen.getByTestId("eq-point-x"))).toBe(false);
  });
});

describe("Recolor's Layout menu follows its BY axis", () => {
  it("shapes each axis in its own nameable steps", () => {
    // "context aware to the grids available... horizontal
    // Sat has one grid at +50 so either add more grids or some sort
    // of half/quarter grid option." Gridline first, finer after.
    expect(recolorLayouts("hue").map((l) => l.points.length)).toEqual([2, 4, 6, 12]);
    expect(recolorLayouts("sat").map((l) => l.points.length)).toEqual([3, 5, 11]);
    expect(recolorLayouts("sat")[1].points.map((p) => p.x)).toEqual([0, 25, 50, 75, 100]);
  });

  it("stops a periodic axis one step short of the top", () => {
    // 360° is 0° again: a handle on each would be two handles fighting
    // over one hue across the seam.
    for (const layout of recolorLayouts("hue")) {
      const xs = layout.points.map((p) => p.x);
      expect(xs[0]).toBe(0);
      expect(xs[xs.length - 1]).toBeLessThan(360);
    }
  });

  it("borrows Relight's layouts for the EV axis, minus Empty", () => {
    // The lum BY axis IS Relight's window. Empty stays out because a
    // Recolor cell below two points serializes away and snaps back to
    // its default: empty is not a state a cell can hold.
    const lum = recolorLayouts("lum");
    expect(lum.map((l) => l.id)).toEqual(["coarse", "alternate", "stops"]);
    expect(lum.every((l) => l.points.length >= 2)).toBe(true);
  });

  it("reaches the editor: a passed preset applies through onPoints", () => {
    const got: EqPoint[][] = [];
    render(
      <EqEditor
        node={toneNode()}
        dispatch={(() => {}) as never}
        points={[{ x: 0, y: 0 }, { x: 100, y: 0 }]}
        onPoints={(p) => got.push(p)}
        presets={recolorLayouts("sat")}
        domain={[0, 100]}
        minPoints={2}
      />,
    );
    choose(screen.getByTestId("eq-preset"), "half");
    expect(got[got.length - 1].map((p) => p.x)).toEqual([0, 25, 50, 75, 100]);
  });
});

describe("ALT/CMD locks the drag to its dominant axis", () => {
  // "The ALT/CMD key locks the drag to one axis...
  // calculate which drag direction is more dominant (X or Y) and lock.
  // This should work with the SHIFT key so someone can start dragging
  // upwards, hold ALT/CMD + SHIFT and lock in increments on the Y
  // only."

  it("reads the dominance off the movement already made", () => {
    const { svg, sent } = mount(toneNode());
    pointer(svg, "pointerdown", { clientX: xToPx(-3), clientY: yToPx(0) });
    // Mostly upward first, then a diagonal with ALT held: Y won, so X
    // holds the value it had when the lock engaged.
    pointer(svg, "pointermove", { clientX: xToPx(-3), clientY: yToPx(0.8) });
    pointer(svg, "pointermove", { clientX: xToPx(-1.2), clientY: yToPx(1.4), altKey: true });
    const p = lastWrite(sent)![1];
    expect(p.x).toBeCloseTo(-3, 5);
    expect(p.y).toBeCloseTo(1.4, 1);
    pointer(svg, "pointerup", {});
  });

  it("waits for the hand when engaged before any movement, then locks", () => {
    // CMD from the start: the point freezes until 3px of motion picks
    // a winner. CMD rather than ALT here, because ALT on the way down
    // is remove-this-point.
    const { svg, sent } = mount(toneNode());
    pointer(svg, "pointerdown", { clientX: xToPx(0), clientY: yToPx(0) });
    // A sub-3px twitch with the key held: frozen, both axes.
    pointer(svg, "pointermove", { clientX: xToPx(0) + 1, clientY: yToPx(0) + 1, metaKey: true });
    let p = lastWrite(sent)![2];
    expect(p.x).toBeCloseTo(0, 5);
    expect(p.y).toBeCloseTo(0, 5);
    // Then a clearly horizontal pull: X wins, Y stays home.
    pointer(svg, "pointermove", { clientX: xToPx(1.4), clientY: yToPx(0.4), metaKey: true });
    p = lastWrite(sent)![2];
    expect(p.x).toBeCloseTo(1.4, 1);
    expect(p.y).toBeCloseTo(0, 5);
    pointer(svg, "pointerup", {});
  });

  it("composes with SHIFT: increments on the moving axis, the frozen one exact", () => {
    const { svg, sent } = mount(toneNode());
    pointer(svg, "pointerdown", { clientX: xToPx(-3), clientY: yToPx(0) });
    // Drift the point somewhere off-grid first, free-hand.
    pointer(svg, "pointermove", { clientX: xToPx(-2.87), clientY: yToPx(0.1) });
    // Upward with ALT+SHIFT: Y snaps to quarter stops, X stays at the
    // exact off-grid value it had, unsnapped, because frozen means
    // frozen.
    pointer(svg, "pointermove", { clientX: xToPx(-2.87), clientY: yToPx(1.13), altKey: true, shiftKey: true });
    const p = lastWrite(sent)![1];
    expect(p.x).toBeCloseTo(-2.87, 2);
    expect(p.y).toBe(1.25);
    pointer(svg, "pointerup", {});
  });

  it("releasing the key unlocks, and re-pressing re-aims", () => {
    const { svg, sent } = mount(toneNode());
    pointer(svg, "pointerdown", { clientX: xToPx(-3), clientY: yToPx(0) });
    pointer(svg, "pointermove", { clientX: xToPx(-3), clientY: yToPx(1) });
    pointer(svg, "pointermove", { clientX: xToPx(-2), clientY: yToPx(1.2), altKey: true });
    // Y-locked: x held at -3. Release: the same spot now lands free.
    pointer(svg, "pointermove", { clientX: xToPx(-2), clientY: yToPx(1.2) });
    const p = lastWrite(sent)![1];
    expect(p.x).toBeCloseTo(-2, 1);
    pointer(svg, "pointerup", {});
  });

  it("leaves ALT-click's meaning alone: on the way down it still removes", () => {
    const { svg, sent } = mount(toneNode([{ x: -3, y: 1 }, { x: 1, y: 0 }]));
    pointer(svg, "pointerdown", { clientX: xToPx(-3), clientY: yToPx(1), altKey: true });
    expect(lastWrite(sent)).toEqual([{ x: 1, y: 0 }]);
  });
});
