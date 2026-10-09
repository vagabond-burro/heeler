// The parametric editors' tangent grammar (the owner's batch):
// resizable handle vectors whose sibling mirrors length and all,
// ALT/CMD-click breaking the pair for good, CTRL-click restoring the
// default reach and the pairing, and the three-face interpolation
// toggle.
import React from "react";
import { act, fireEvent, render, screen } from "@testing-library/react";

/** jsdom has no PointerEvent, and RTL's fireEvent.pointerDown builds an
 * event with no clientX at all, which reads as a click at nowhere. A
 * MouseEvent dispatched under the pointer event's NAME carries the
 * coordinates and the modifier keys, and React routes by name. Same
 * trick eqfields.test.tsx documents. */
function pointer(
  el: Element,
  type: "pointerdown" | "pointermove" | "pointerup",
  init: MouseEventInit = {},
) {
  act(() => {
    el.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, ...init }));
  });
}
import { describe, expect, it } from "vitest";
import { EqEditor } from "../ui/eqeditor";
import { parseEqPoints, type EqPoint } from "../eqcurve";
import type { Command, NodeCard } from "../state";

// Geometry constants mirroring the component: width 272, height 170,
// PAD {l:34, r:8, t:6, b:15}, domain [-6,3], yRange [-2,2].
const W = 272;
const H = 170;
const PAD = { l: 34, r: 8, t: 6, b: 15 };
const DOMAIN: [number, number] = [-6, 3];
const YR: [number, number] = [-2, 2];
const plotW = W - PAD.l - PAD.r;
const plotH = H - PAD.t - PAD.b;
const xPx = (x: number) => PAD.l + ((x - DOMAIN[0]) / (DOMAIN[1] - DOMAIN[0])) * plotW;
const yPx = (y: number) => PAD.t + ((YR[1] - y) / (YR[1] - YR[0])) * plotH;

function mount(points: EqPoint[], interp: "smooth" | "linear" | "tangent" = "tangent") {
  const initial = {
    id: "toneeq",
    type: "heeler.tone_eq",
    name: "Relight",
    cat: "tone",
    x: 0,
    y: 0,
    enabled: true,
    params: {},
    textParams: { points: JSON.stringify(points) },
    curveInterp: interp,
    hasIn: true,
    hasOut: true,
  } as unknown as NodeCard;
  const sent: Command[] = [];
  // A live little store: in the app every write round-trips through
  // the reducer back into the node prop; a static prop here made the
  // editor revert on pointerup (its echo clears then) and the second
  // gesture aimed at handles that had snapped back.
  function Harness() {
    const [node, setNode] = React.useState(initial);
    const dispatch = (c: Command) => {
      sent.push(c);
      if (c.type === "set_text_param") {
        setNode((n) => ({ ...n, textParams: { ...n.textParams, [c.param]: c.value } }));
      }
      if (c.type === "set_curve_interp") {
        setNode((n) => ({ ...n, curveInterp: c.interp }));
      }
    };
    return <EqEditor node={node} dispatch={dispatch as never} />;
  }
  render(<Harness />);
  const svg = document.querySelector('[data-testid="eq-plot"]') as SVGSVGElement;
  // jsdom draws nothing: hand local() the box the math expects.
  svg.getBoundingClientRect = () =>
    ({ left: 0, top: 0, width: W, height: H, right: W, bottom: H, x: 0, y: 0 }) as DOMRect;
  return { svg, sent, written: () => {
    const w = [...sent].reverse().find((c) => c.type === "set_text_param");
    return w && w.type === "set_text_param" ? parseEqPoints(w.value) : null;
  } };
}

const PTS: EqPoint[] = [
  { x: -4, y: 0.5 },
  { x: -1, y: -0.5 },
  { x: 2, y: 0.8 },
];

const select = (svg: SVGSVGElement, p: EqPoint) => {
  pointer(svg, "pointerdown", { clientX: xPx(p.x), clientY: yPx(p.y), button: 0 });
  pointer(svg, "pointerup", {});
};

describe("the EQ editors' tangent handles", () => {
  it("show for the selected point in tangent mode only", () => {
    const t = mount(PTS, "tangent");
    expect(screen.queryByTestId("eq-handles")).not.toBeInTheDocument();
    select(t.svg, PTS[1]);
    expect(screen.getByTestId("eq-handles")).toBeInTheDocument();
    const s = mount(PTS, "smooth");
    select(s.svg, PTS[1]);
    // Two editors mounted; the smooth one contributes no handles, so
    // the page still holds exactly the tangent editor's group.
    expect(screen.getAllByTestId("eq-handles").length).toBe(1);
  });

  it("dragging a handle mirrors the sibling, length included", () => {
    const t = mount(PTS, "tangent");
    select(t.svg, PTS[1]);
    // Grab the auto right handle (34px along the slope from the point)
    // and pull it far right and up.
    const hx = xPx(PTS[1].x) + 34;
    const hy = yPx(PTS[1].y);
    pointer(t.svg, "pointerdown", { clientX: hx, clientY: hy, button: 0 });
    pointer(t.svg, "pointermove", { clientX: xPx(0.5), clientY: yPx(0.2), buttons: 1 });
    pointer(t.svg, "pointerup", {});
    const p = t.written()![1];
    expect(p.r![0]).toBeCloseTo(1.5, 3);
    expect(p.r![1]).toBeCloseTo(0.7, 3);
    // The sibling is the exact negation: equal length, opposite way.
    expect(p.l![0]).toBeCloseTo(-1.5, 3);
    expect(p.l![1]).toBeCloseTo(-0.7, 3);
    expect(p.broken).toBeUndefined();
  });

  it("ALT-click breaks the pair for good; CTRL-click resets reach and mends it", () => {
    const t = mount(PTS, "tangent");
    select(t.svg, PTS[1]);
    const hx = xPx(PTS[1].x) + 34;
    const hy = yPx(PTS[1].y);
    // Break, then pull only the right handle.
    pointer(t.svg, "pointerdown", { clientX: hx, clientY: hy, button: 0, altKey: true });
    pointer(t.svg, "pointermove", { clientX: xPx(1), clientY: yPx(0.5), buttons: 1, altKey: true });
    pointer(t.svg, "pointerup", {});
    let p = t.written()![1];
    expect(p.broken).toBe(true);
    expect(p.r![0]).toBeCloseTo(2, 3);
    // The left side never moved with it.
    expect(p.l ?? null).toBeNull();
    // CTRL-click on the (now long) right handle: back to AUTOMATIC
    // entirely, the same reset double-clicking the point performs (the
    // owner settled it mid-build: "double clicking directly on the point
    // resets the tangent handles perfectly" after "CTRL-CLICK is not
    // resetting the tangents to the default length they start at").
    const rx = xPx(PTS[1].x + 2);
    const ry = yPx(PTS[1].y + 1);
    pointer(t.svg, "pointerdown", { clientX: rx, clientY: ry, button: 0, ctrlKey: true });
    p = t.written()![1];
    expect(p.broken).toBeUndefined();
    expect(p.l ?? null).toBeNull();
    expect(p.r ?? null).toBeNull();
  });

  it("one button wears the face and a click walks to the next (2026-09-14)", () => {
    const t = mount(PTS, "tangent");
    expect(screen.getByTestId("eq-interp").getAttribute("data-mode")).toBe("tangent");
    expect(screen.queryByTestId("eq-interp-linear")).toBeNull();
    fireEvent.click(screen.getByTestId("eq-interp"));
    expect(t.sent).toContainEqual({ type: "set_curve_interp", id: "toneeq", interp: "smooth" });
  });
});
