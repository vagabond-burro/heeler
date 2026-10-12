// When a curve stored in a text param stands and when its control falls
// back, from the cases the engine's renders are held to as well
// (crates/heeler-engine/tests/stored_curves.json, read by ops.rs
// stored_curves_stand_as_the_shared_cases_say). The two sides drifted
// once: the Tone Equalizer's Empty layout drew a flat line while the
// engine fell back to the zone sliders. A case that falls back shows
// exactly what the param absent shows; one that stands shows otherwise.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { App } from "../app";
import { bwDefaultPoints, separatePoints } from "../blackwhite";
import * as bridge from "../bridge";
import { initialState } from "../data";
import { parseEqPoints, storedEqPoints } from "../eqcurve";
import type { NodeCard } from "../state";
import { BwControls } from "../ui/bwcontrols";

interface Case {
  node: string;
  param: string;
  stored: string | null;
  stands: boolean;
}

const { cases } = JSON.parse(
  readFileSync(resolve(process.cwd(), "../../crates/heeler-engine/tests/stored_curves.json"), "utf8"),
) as { cases: Case[] };

afterEach(cleanup);

function withStored(textParams: Record<string, string> | undefined, param: string, stored: string | null) {
  const next = { ...(textParams ?? {}) };
  if (stored === null) delete next[param];
  else next[param] = stored;
  return next;
}

/** What the control shows for the param: the Tone Equalizer's curve as
 * its widget reads it, a Black & White editor's drawn points, or whether
 * the infrared materials stand down for a drawn curve. */
function shown(param: string, stored: string | null): string {
  if (param === "points") {
    return JSON.stringify(storedEqPoints({ params: { ev_0: 1 }, textParams: withStored({}, param, stored) }));
  }
  const s = initialState();
  const base = s.nodes.find((n) => n.type === "heeler.black_white")!;
  // Infrared (r72 and no stock) and a Far filter, so every editor shows.
  const bw: NodeCard = {
    ...base,
    params: { ...base.params, amount: 100 },
    textParams: withStored({ ...base.textParams, filter: "r72", far_filter: "w25" }, param, stored),
  };
  render(<BwControls bw={bw} nodes={s.nodes} dispatch={(() => {}) as never} state={s} />);
  try {
    if (param === "ir_curve") return screen.getByTestId("bw-ir-materials").style.opacity;
    const box = screen.getByTestId(param === "hue_curve" ? "bw-hue-curve" : "bw-depth-curve");
    return within(box)
      .getAllByTestId(/^eq-point-/)
      .filter((el) => el.tagName === "circle")
      .map((c) => `${c.getAttribute("cx")},${c.getAttribute("cy")}`)
      .join(" ");
  } finally {
    cleanup();
  }
}

describe("stored curves, as the engine reads them", () => {
  it("has cases for every param it names", () => {
    expect(new Set(cases.map((c) => c.param))).toEqual(new Set(["points", "hue_curve", "ir_curve", "depth_curve"]));
  });

  // The cases compare against the param absent, so a fallback wrong in
  // the same way everywhere would pass them: what each control shows
  // with nothing stored is pinned here.
  it("with nothing stored, each control shows its own fallback", () => {
    expect(shown("hue_curve", null).split(" ")).toHaveLength(bwDefaultPoints().length);
    const depth = shown("depth_curve", null)
      .split(" ")
      .map((p) => p.split(",").map(Number));
    expect(depth).toHaveLength(2);
    expect(depth[1][1]).toBeLessThan(depth[0][1]); // the diagonal rises: far reads higher on the plot
    expect(shown("ir_curve", null)).toBe("");
    expect(shown("ir_curve", "[{\"x\":0,\"y\":0},{\"x\":359,\"y\":0}]")).toBe("0.45");
  });

  for (const c of cases) {
    it(`${c.node} ${c.param} = ${JSON.stringify(c.stored)} ${c.stands ? "stands" : "falls back"}`, () => {
      const absent = shown(c.param, null);
      expect(shown(c.param, c.stored) !== absent).toBe(c.stands);
    });
  }
});

// The viewer's two hue-curve writers start from the same fallback the
// control draws: with no curve stored, the hue pick and Separate build
// on the default layout, and its points are still there afterwards.
describe("the viewer's hue-curve writers, with no curve stored", () => {
  it("separatePoints reads too short a curve as the default layout", () => {
    const a = { hue: 30, chroma: 0.2, gray: 0.7 };
    const b = { hue: 150, chroma: 0.2, gray: 0.3 };
    const from = separatePoints(a, b, bwDefaultPoints(), 0.5, "smooth");
    expect(separatePoints(a, b, [], 0.5, "smooth")).toEqual(from);
    expect(separatePoints(a, b, [{ x: 200, y: 1 }], 0.5, "smooth")).toEqual(from);
    expect(separatePoints(a, b, [{ x: 100, y: 1 }, { x: 300, y: 1 }], 0.5, "smooth")).not.toEqual(from);
  });

  it("Separate builds on the default layout", async () => {
    const sample = vi.spyOn(bridge, "sampleImage").mockImplementation(async (_state, x, _y, _radius, _node, port) => {
      const red = x < 0.5;
      const gray = red ? 0.9 : 0.1;
      return {
        luma: gray,
        hue: 0,
        sat: 1,
        luma_linear: gray,
        r: port === "out" ? gray : red ? 0.8 : 0.05,
        g: port === "out" ? gray : red ? 0.05 : 0.8,
        b: port === "out" ? gray : 0.05,
      };
    });
    try {
      const user = userEvent.setup();
      render(<App />);
      await user.click(screen.getByTestId("bw-mode-bw"));
      await user.click(screen.getByTestId("bw-separate"));
      const overlay = screen.getByTestId("bw-separate-overlay");
      vi.spyOn(overlay, "getBoundingClientRect").mockReturnValue({ left: 0, top: 0, width: 100, height: 100 } as DOMRect);
      fireEvent.mouseDown(overlay, { button: 0, clientX: 20, clientY: 20 });
      await waitFor(() => expect(screen.getByTestId("bw-separate-pin")).toBeVisible());
      fireEvent.mouseDown(overlay, { button: 0, clientX: 80, clientY: 20 });
      await waitFor(() => expect(screen.queryByTestId("bw-separate-overlay")).toBeNull());
      // The written curve, read back through the next sample's state.
      await user.click(screen.getByTestId("bw-pick"));
      fireEvent.mouseMove(screen.getByTestId("bw-pick-overlay"), { clientX: 30, clientY: 20 });
      await waitFor(() => expect(sample.mock.calls.length).toBeGreaterThan(5));
      const state = sample.mock.calls[sample.mock.calls.length - 1][0];
      const pts = parseEqPoints(state.nodes.find((n) => n.id === "bw")?.textParams?.hue_curve);
      // Blue, far from both picked hues, keeps the default layout's point.
      expect(bwDefaultPoints().some((p) => p.x === 240)).toBe(true);
      expect(pts.find((p) => p.x === 240)?.y).toBe(0);
    } finally {
      sample.mockRestore();
    }
  });
});
