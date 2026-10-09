import { describe, expect, it } from "vitest";
import { panePropsEqual, stateEqualExceptView } from "../ui/viewmemo";
import { initialState } from "../data";

describe("stateEqualExceptView", () => {
  it("treats a view-only change as equal and anything else as not", () => {
    const s = initialState();
    expect(stateEqualExceptView(s, s)).toBe(true);
    const panned = { ...s, view: { ...s.view, pan: { x: 40, y: 0 } } };
    expect(stateEqualExceptView(s, panned)).toBe(true);
    const edited = { ...s, renderVersion: s.renderVersion + 1 };
    expect(stateEqualExceptView(s, edited)).toBe(false);
  });

  it("compares non-state props by reference", () => {
    const s = initialState();
    const d = () => {};
    expect(panePropsEqual({ state: s, dispatch: d, url: "a" }, { state: s, dispatch: d, url: "a" })).toBe(true);
    expect(panePropsEqual({ state: s, dispatch: d, url: "a" }, { state: s, dispatch: d, url: "b" })).toBe(false);
  });
});

describe("who may read state.view", () => {
  // The comparator's one hazard: a memoized pane that reads state.view
  // will not re-render when it changes, and nothing crashes, the panel
  // just quietly shows yesterday's view. The unmemoized components are
  // the legitimate readers: the viewer, and the status bar (rendered
  // bare from App, so it re-renders with every state change - it shows
  // the view rotation readout that used to live in the viewer's
  // floating row). This scan is the tripwire: a new read anywhere else
  // either belongs in one of those subtrees, or its component must
  // come out of the memo wrapper before this list grows. (viewmemo.ts
  // is excluded for naming the rule in its comment, not for reading
  // the fields.)
  it("only the unmemoized components read it in the ui layer", () => {
    const sources = import.meta.glob("../ui/*.{ts,tsx}", {
      query: "?raw",
      import: "default",
      eager: true,
    }) as Record<string, string>;
    const offenders = Object.entries(sources)
      // splitview.tsx renders only from the viewer's own (unmemoized)
      // subtree: SplitCompare and SplitControls are the split half of
      // the viewer, extracted for size, not a memoized pane.
      .filter(([file]) => !/\/(viewer\.tsx|statusbar\.tsx|splitview\.tsx|viewmemo\.ts)$/.test(file))
      .filter(([, src]) => /\bstate\.view\b/.test(src))
      .map(([file]) => file);
    expect(offenders).toEqual([]);
  });
});
