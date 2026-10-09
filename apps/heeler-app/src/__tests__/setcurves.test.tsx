// The Color Set expert curves face (proposal §3.5, the parked half of
// M5's Color Sets item): the set's grades as curves across hue. The
// engine half is pinned in ops_grade.rs; this file pins the JSON
// helpers and the face's wiring.

import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import {
  gradeDefaultPoints,
  parseGradeCurves,
  serializeGradeCurves,
} from "../eqcurve";
import type { ColorSet } from "../colorsets";
import type { Command, NodeCard } from "../state";
import { ColorSetControls } from "../ui/colorsets";

const node = (id: string, type: string, textParams?: Record<string, string>): NodeCard =>
  ({
    id,
    type,
    name: id,
    cat: "color",
    x: 0,
    y: 0,
    enabled: true,
    params: {},
    textParams,
    hasIn: true,
    hasOut: true,
  }) as NodeCard;

const set = (curves?: string): ColorSet =>
  ({
    n: 1,
    name: "Skin tones",
    mask: node("cset1_mask", "heeler.hue_range_mask"),
    grade: node("cset1_grade", "heeler.color_grade", curves ? { curves } : undefined),
  }) as ColorSet;

describe("the grade curves JSON", () => {
  it("round-trips, drops empties, and shrugs at garbage", () => {
    const map = { hue: [{ x: 0, y: 10 }, { x: 180, y: 0 }] };
    const json = serializeGradeCurves(map);
    expect(parseGradeCurves(json).hue).toHaveLength(2);
    expect(serializeGradeCurves({})).toBe("");
    expect(parseGradeCurves("not json")).toEqual({});
    expect(parseGradeCurves(undefined)).toEqual({});
  });

  it("fresh curves are six flat points around the circle", () => {
    const pts = gradeDefaultPoints();
    expect(pts).toHaveLength(6);
    expect(pts.every((p) => p.y === 0)).toBe(true);
    expect(pts[5].x).toBe(300);
  });
});

describe("the expert face", () => {
  it("hides behind its toggle and shows one curve at a time", () => {
    render(<ColorSetControls set={set()} dispatch={() => {}} />);
    expect(screen.queryByTestId("set-curves-1")).toBeNull();
    fireEvent.click(screen.getByTestId("set-curves-toggle-1"));
    expect(screen.getByTestId("set-curves-1")).toBeTruthy();
    // The row picker is there, hue first.
    expect(screen.getByTestId("set-curve-1-hue").getAttribute("data-active")).toBe("true");
    fireEvent.click(screen.getByTestId("set-curve-1-lum"));
    expect(screen.getByTestId("set-curve-1-lum").getAttribute("data-active")).toBe("true");
  });

  it("a shaped curve wears its dot on the picker", () => {
    const shaped = serializeGradeCurves({ sat: [{ x: 0, y: 40 }, { x: 180, y: 0 }] });
    render(<ColorSetControls set={set(shaped)} dispatch={() => {}} />);
    fireEvent.click(screen.getByTestId("set-curves-toggle-1"));
    expect(screen.getByTestId("set-curve-1-sat").textContent).toContain("●");
    expect(screen.getByTestId("set-curve-1-hue").textContent).not.toContain("●");
  });

  it("edits write the grade node's curves param as one merged map", () => {
    const shaped = serializeGradeCurves({ sat: [{ x: 0, y: 40 }, { x: 180, y: 0 }] });
    const got: Command[] = [];
    render(<ColorSetControls set={set(shaped)} dispatch={(c) => got.push(c)} />);
    fireEvent.click(screen.getByTestId("set-curves-toggle-1"));
    // Double-click the plot to add a point on the hue curve; the write
    // must carry BOTH curves, not clobber sat.
    const svg = screen.getByTestId("set-curves-1").querySelector("svg")!;
    fireEvent.doubleClick(svg, { clientX: 100, clientY: 40 });
    const write = got.find((c) => c.type === "set_text_param") as Extract<
      Command,
      { type: "set_text_param" }
    >;
    expect(write).toBeTruthy();
    expect(write.id).toBe("cset1_grade");
    expect(write.param).toBe("curves");
    const map = parseGradeCurves(write.value);
    expect(map.sat).toBeTruthy();
    expect(map.hue).toBeTruthy();
  });
});
