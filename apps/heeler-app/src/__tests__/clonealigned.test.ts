import { describe, expect, it } from "vitest";

import { initialState } from "../data";
import { reduce } from "../state";

describe("the clone and heal source", () => {
  it("forgets the remembered distance when a new source is picked", async () => {
    // The distance belongs to the source it was measured from. The
    // report: "the relative distance resets every time a new source is
    // set."
    let s = initialState();
    s = reduce(s, { type: "set_clone_offset", offset: [0.1, 0.1] });
    expect(s.cloneOffset).toEqual([0.1, 0.1]);
    s = reduce(s, { type: "set_clone_source", at: [0.4, 0.4] });
    expect(s.cloneOffset).toBeNull();
    expect(s.cloneSource).toEqual([0.4, 0.4]);
  });

  it("forgets it when the mode changes too", async () => {
    // A distance measured for aligned use means nothing to the other
    // mode, and leaving it behind would quietly act as the source.
    let s = initialState();
    s = reduce(s, { type: "set_clone_offset", offset: [0.2, 0] });
    s = reduce(s, { type: "set_brush_clone_aligned", aligned: false });
    expect(s.brushCloneAligned).toBe(false);
    expect(s.cloneOffset).toBeNull();
  });

  it("defaults to aligned, and remembers being turned off", async () => {
    localStorage.removeItem("heeler.ui.brushCloneAligned");
    expect(initialState().brushCloneAligned).toBe(true);
    const { setUiPref } = await import("../uiprefs");
    setUiPref("brushCloneAligned", false);
    expect(initialState().brushCloneAligned).toBe(false);
    localStorage.removeItem("heeler.ui.brushCloneAligned");
  });
});
