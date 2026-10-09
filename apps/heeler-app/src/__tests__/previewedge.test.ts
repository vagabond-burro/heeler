// The settled preview's size follows the screen (2026-09-23: "people
// like to see as close as possible to the final render result"): the
// preference is a floor, the stage's device pixels raise it, rounded
// to 256 and capped at 4096.

import { describe, expect, it } from "vitest";
import { initialState } from "../data";
import { previewEdgeFor, reduce, type State } from "../state";
import { needsFullRes } from "../bridge";
import { SETTLE_JPEG_QUALITY, settleJpegQuality } from "../state";

describe("the settled preview's edge", () => {
  it("is the preference until the stage is measured, then at least the stage", () => {
    let s = initialState();
    expect(s.view.stagePx).toBeNull();
    expect(previewEdgeFor(s)).toBe(s.prefs.previewEdge);
    // A 1600 by 1000 CSS stage on a 2x display: 3200 device pixels, so 3328.
    s = reduce(s, { type: "set_stage_px", w: 3200, h: 2000 });
    expect(s.view.stagePx).toEqual({ w: 3200, h: 2000 });
    expect(previewEdgeFor(s)).toBe(3328);
    // A small window stays at the preference's floor.
    s = reduce(s, { type: "set_stage_px", w: 900, h: 600 });
    expect(previewEdgeFor(s)).toBe(s.prefs.previewEdge);
    // And a wall of pixels stops at the ceiling.
    s = reduce(s, { type: "set_stage_px", w: 6000, h: 4000 });
    expect(previewEdgeFor(s)).toBe(4096);
    // The same size again changes nothing, so no render is asked for.
    const same = reduce(s, { type: "set_stage_px", w: 6000.2, h: 4000 });
    expect(same).toBe(s);
  });
});

describe("the full-resolution settle", () => {
  it("is a preference that reads screen or full and nothing else", () => {
    let s = initialState();
    expect(s.prefs.settledPreview).toBe("screen");
    s = reduce(s, { type: "set_prefs", prefs: { settledPreview: "full" } });
    expect(s.prefs.settledPreview).toBe("full");
    s = reduce(s, { type: "set_prefs", prefs: { settledPreview: "sometimes" as unknown as "full" } });
    expect(s.prefs.settledPreview).toBe("screen");
  });

  it("is wanted only with the hand off, below 1:1 and in the plain view", async () => {
    // The browser build has no engine, so the rule's other clauses are
    // read through needsFullRes and the state alone.
    const { settleWanted } = await import("../bridge");
    const base: State = { ...reduce(initialState(), { type: "set_prefs", prefs: { settledPreview: "full" } }) };
    expect(needsFullRes(base)).toBe(false);
    // No engine here: never wanted in the browser build.
    expect(settleWanted(base)).toBe(false);
    expect(settleWanted({ ...base, gesture: { kind: "slider" } as unknown as State["gesture"] })).toBe(false);
    expect(settleWanted({ ...base, viewerZoom: "100" })).toBe(false);
    expect(settleWanted({ ...base, compare: true })).toBe(false);
  });

  it("the settle's JPEG quality is one of three named steps, Balanced unless told otherwise", () => {
    let s = initialState();
    expect(s.prefs.settleQuality).toBe("balanced");
    expect(settleJpegQuality(s.prefs)).toBe(85);
    s = reduce(s, { type: "set_prefs", prefs: { settleQuality: "sharper" } });
    expect(settleJpegQuality(s.prefs)).toBe(94);
    s = reduce(s, { type: "set_prefs", prefs: { settleQuality: "smaller" } });
    expect(settleJpegQuality(s.prefs)).toBe(75);
    s = reduce(s, { type: "set_prefs", prefs: { settleQuality: "raw" as unknown as "smaller" } });
    expect(s.prefs.settleQuality).toBe("balanced");
    expect(settleJpegQuality({})).toBe(85);
    expect(Object.values(SETTLE_JPEG_QUALITY).every((q) => q >= 60 && q <= 94)).toBe(true);
  });
});
