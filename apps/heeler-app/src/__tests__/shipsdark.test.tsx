// What ships dark (2026-08-25): Color Tune and Recolor keep the
// default node graph clean by not being in it. Both are on-demand like
// their neighbors, bypassed in the demo session, collapsed in the
// panel, and self-arming the moment their bands or curves say
// something. The depth tools ship the same way.

import { describe, expect, it } from "vitest";
import { initialState } from "../data";
import { reduce, type Command, type State } from "../state";

const run = (s: State, ...cmds: Command[]) => cmds.reduce(reduce, s);

describe("what ships dark", () => {
  it("keeps Color Tune and Recolor out of a fresh graph, bypassed in the demo", () => {
    const s = initialState();
    // On-demand: a reset photograph does not carry them at all.
    expect(s.defaultGraph.nodes.some((n) => n.id === "colorconsole")).toBe(false);
    expect(s.defaultGraph.nodes.some((n) => n.id === "recolor")).toBe(false);
    // The demo session keeps its cards, switched off.
    expect(s.nodes.find((n) => n.id === "colorconsole")!.enabled).toBe(false);
    expect(s.nodes.find((n) => n.id === "recolor")!.enabled).toBe(false);
  });

  it("collapses the dark sections by default", () => {
    const closed = initialState().sectionsClosed;
    for (const t of ["Color Tune", "Recolor", "Fog", "Depth Lighting", "Depth of Field", "Sky Rescue"]) {
      expect(closed).toContain(t);
    }
  });

  it("arms a bypassed node when its text says something, and never disarms it", () => {
    let s = initialState();
    s = run(s, { type: "set_text_param", id: "colorconsole", param: "bands", value: '[{"c":0}]' });
    expect(s.nodes.find((n) => n.id === "colorconsole")!.enabled).toBe(true);
    s = run(s, { type: "set_text_param", id: "recolor", param: "curves", value: "hue_hue:0,0.5;" });
    expect(s.nodes.find((n) => n.id === "recolor")!.enabled).toBe(true);
    // Emptying the text is a values operation: the switch stays where
    // the user left it, the same rule Reset lives by.
    s = run(s, { type: "set_text_param", id: "recolor", param: "curves", value: "" });
    expect(s.nodes.find((n) => n.id === "recolor")!.enabled).toBe(true);
    // Whitespace says nothing, so it arms nothing.
    const s2 = run(initialState(), { type: "set_text_param", id: "colorconsole", param: "bands", value: "  " });
    expect(s2.nodes.find((n) => n.id === "colorconsole")!.enabled).toBe(false);
  });
});

describe("a fresh adjustment layer keeps the dark sections dark", () => {
  it("the off-by-default switches stay off when a layer is active", async () => {
    // "I added an adjustment layer and it turned on a bunch
    // of sections that should be off by default." The stand-in card the
    // panel renders for an untouched layer tool was born enabled, so
    // every on-demand section's switch lit the moment a layer existed,
    // while the graph ran none of them.
    const { render, screen } = await import("@testing-library/react");
    const { SimplePanel } = await import("../ui/simple");
    const s = run(initialState(), { type: "add_layer", maskType: "brush" });
    expect(s.activeLayer).toBeTruthy();
    render(<SimplePanel state={s} dispatch={(() => {}) as never} />);
    for (const slug of [
      "curves", "color-wheels", "color-bend", "grain", "vignette",
      "fog", "depth-lighting", "depth-of-field", "levels", "relight",
    ]) {
      const toggle = screen.getByTestId(`toggle-${slug}`);
      expect(toggle.getAttribute("data-on"), `${slug} must read off`).toBe("false");
    }
  });
});
