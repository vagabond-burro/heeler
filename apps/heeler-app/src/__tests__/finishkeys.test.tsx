// The Finish toolbar by key, and the keys' one rule: they work only
// while the toolbar itself is on screen. "hotkeys for the
// toolbar in Finish. We should make sure these hotkeys only work with
// the toolbar is visible... Graph or Canvas but ONLY when inside
// editing the 'Finish' group node." Plus the graph's frame key, and
// the two graph cards of one pixel layer learning to tell each other
// apart.

import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { App } from "../app";
import { initialState } from "../data";
import { runCommand } from "../commands";
import {
  ART_ID,
  NODE_W,
  artLayers,
  artToolbarVisible,
  reduce,
  type Command,
  type State,
} from "../state";

const run = (s: State, ...cmds: Command[]) => cmds.reduce(reduce, s);

describe("where the Finish toolbar (and so its keys) is live", () => {
  // The Finish pane only: the Selection pane is the automatic split
  // (derived from the tool, with its own complete controls), and the
  // owner ruled the bar stays out of it: "exposing those extra tools
  // in Adjustments would be confusing."
  it("Develop shows it with the Finish pane up, not Adjustments", () => {
    const s = initialState();
    expect(artToolbarVisible(s)).toBe(false);
    expect(artToolbarVisible({ ...s, panelTab: "layers" })).toBe(true);
  });

  it("Graph and Canvas show it only inside the Finish group", () => {
    const s = { ...initialState(), panelTab: "layers" as const };
    // The panel tab persists across modes, which is exactly what used
    // to leave the bar over the graph the whole time.
    expect(artToolbarVisible({ ...s, mode: "advanced" })).toBe(false);
    expect(artToolbarVisible({ ...s, mode: "canvas" })).toBe(false);
    expect(artToolbarVisible({ ...s, mode: "advanced", openedGroup: ART_ID })).toBe(true);
    expect(artToolbarVisible({ ...s, mode: "canvas", openedGroup: ART_ID })).toBe(true);
    // Some other group is not the Finish group.
    expect(artToolbarVisible({ ...s, mode: "advanced", openedGroup: "g1" })).toBe(false);
  });

  it("polish keeps the bar anywhere, since the bar is its Apply and Cancel", () => {
    const s = { ...initialState(), mode: "advanced" as const, tool: "polish" as const };
    expect(artToolbarVisible(s)).toBe(true);
  });
});

describe("the toolbar keys mirror the buttons", () => {
  const finish = () =>
    run(initialState(), { type: "set_panel_tab", tab: "layers" });

  it("B arms the paint brush only where the toolbar is, and toggles off", () => {
    let s = finish();
    const dispatch = (c: Command) => {
      s = reduce(s, c);
    };
    expect(runCommand("art.paint", s, dispatch)).toBe(true);
    expect(s.tool).toBe("paint");
    expect(runCommand("art.paint", s, dispatch)).toBe(true);
    expect(s.tool).toBe("none");
    // Adjustments tab: no toolbar, no key.
    let adj = initialState();
    expect(runCommand("art.paint", adj, (c) => (adj = reduce(adj, c)))).toBe(false);
    expect(adj.tool).toBe("none");
  });

  it("the retouch keys gray out with their buttons until a pixel layer is under them", () => {
    let s = finish();
    const dispatch = (c: Command) => {
      s = reduce(s, c);
    };
    expect(runCommand("art.erase", s, dispatch)).toBe(false);
    s = run(s, { type: "art_add_layer", kind: "paint" });
    expect(runCommand("art.erase", s, dispatch)).toBe(true);
    expect(s.tool).toBe("erase");
    expect(runCommand("art.repair", s, dispatch)).toBe(true);
    expect(["clone", "heal"]).toContain(s.tool);
  });

  it("M arms the selection tool even in Adjustments, where the others stay quiet", () => {
    let s = initialState();
    const dispatch = (c: Command) => {
      s = reduce(s, c);
    };
    expect(runCommand("art.select", s, dispatch)).toBe(true);
    expect(s.tool).toBe("select");
    expect(runCommand("art.select", s, dispatch)).toBe(true);
    expect(s.tool).toBe("none");
  });

  /// armed in Develop, where the Finish toolbar is off screen, V did
  /// nothing and only M put the Selection Tool down. V puts it away
  /// wherever M takes it out; other tools use the same cursor exit.
  it("V puts the selection tool away in Adjustments too", () => {
    let s = initialState();
    const dispatch = (c: Command) => {
      s = reduce(s, c);
    };
    expect(runCommand("art.select", s, dispatch)).toBe(true);
    expect(s.tool).toBe("select");
    expect(runCommand("art.cursor", s, dispatch)).toBe(true);
    expect(s.tool).toBe("none");
    // With nothing in hand and no toolbar, V still stands down.
    expect(runCommand("art.cursor", s, dispatch)).toBe(false);
  });

  it("the keys reach the tools from the keyboard end to end", async () => {
    const user = userEvent.setup();
    render(<App />);
    await user.click(screen.getByTestId("panel-tab-layers"));
    fireEvent.keyDown(window, { key: "B" });
    expect(screen.getByTestId("art-tool-paint").getAttribute("data-active")).toBe("true");
    fireEvent.keyDown(window, { key: "V" });
    expect(screen.getByTestId("art-tool-cursor").getAttribute("data-active")).toBe("true");
  });
});

describe("F frames the graph", () => {
  it("centers everything when nothing is selected, the selection when there is one", () => {
    let s = run(initialState(), { type: "select_nodes", ids: [] });
    const before = s.graphView;
    s = reduce(s, { type: "frame_graph", w: 800, h: 600 });
    expect(s.graphView).not.toEqual(before);
    expect(s.graphView.zoom).toBeLessThanOrEqual(1);
    expect(s.graphView.zoom).toBeGreaterThanOrEqual(0.2);
    // Framing one node centers THAT node.
    const node = s.nodes.find((n) => n.id === "output") ?? s.nodes[0];
    s = run(s, { type: "select_nodes", ids: [node.id] });
    s = reduce(s, { type: "frame_graph", w: 800, h: 600 });
    const cx = (node.x + NODE_W / 2) * s.graphView.zoom + s.graphView.x;
    expect(cx).toBeCloseTo(400, 0);
  });

  it("entering a group auto-frames it, and leaving restores the view", () => {
    // "when entering a group, the nodes should center in
    // the view by default. Basically auto-framing."
    let s = run(
      initialState(),
      { type: "set_panel_tab", tab: "layers" },
      { type: "art_add_layer", kind: "paint" },
      { type: "pan_graph", dx: 500, dy: 300 },
    );
    const outside = s.graphView;
    s = reduce(s, { type: "open_group", id: ART_ID, frame: { w: 800, h: 600 } });
    const g = s.nodes.find((n) => n.id === ART_ID)!;
    const xs = g.groupNodes!.map((n) => n.x);
    const cx =
      ((Math.min(...xs) + Math.max(...xs.map((x) => x + NODE_W))) / 2) * s.graphView.zoom +
      s.graphView.x;
    expect(cx).toBeCloseTo(400, 0);
    // The trip inside costs nothing: leaving puts the old view back.
    s = reduce(s, { type: "open_group", id: null });
    expect(s.graphView).toEqual(outside);
    expect(s.graphViewBack).toBeNull();
  });

  it("frames the group's contents while a group is open", () => {
    let s = run(
      initialState(),
      { type: "set_panel_tab", tab: "layers" },
      { type: "art_add_layer", kind: "paint" },
      { type: "select_nodes", ids: [] },
      { type: "open_group", id: ART_ID },
    );
    s = reduce(s, { type: "frame_graph", w: 800, h: 600 });
    const g = s.nodes.find((n) => n.id === ART_ID)!;
    const xs = g.groupNodes!.map((n) => n.x);
    const cx =
      ((Math.min(...xs) + Math.max(...xs.map((x) => x + NODE_W))) / 2) * s.graphView.zoom +
      s.graphView.x;
    expect(cx).toBeCloseTo(400, 0);
  });
});

describe("one pixel layer, two graph cards, two names", () => {
  it("the strokes' node wears Paint after the layer name, birth and rename", () => {
    let s = run(
      initialState(),
      { type: "set_panel_tab", tab: "layers" },
      { type: "art_add_layer", kind: "paint" },
    );
    const layer = artLayers(s)[artLayers(s).length - 1];
    expect(layer.blend.name).toBe("Pixel 1");
    expect(layer.content.name).toBe("Pixel 1 Paint");
    s = run(s, { type: "art_layer_set", id: layer.blend.id, name: "Sky fix" });
    const renamed = artLayers(s).find((l) => l.blend.id === layer.blend.id)!;
    expect(renamed.blend.name).toBe("Sky fix");
    expect(renamed.content.name).toBe("Sky fix Paint");
  });

  it("selecting either card in the graph makes that layer the paint target", () => {
    let s = run(
      initialState(),
      { type: "set_panel_tab", tab: "layers" },
      { type: "art_add_layer", kind: "paint" },
      { type: "art_add_layer", kind: "paint" },
    );
    const [first, second] = artLayers(s);
    expect(s.artActive).toBe(second.blend.id);
    s = run(s, { type: "select_nodes", ids: [first.content.id] });
    expect(s.artActive).toBe(first.blend.id);
    s = run(s, { type: "select_nodes", ids: [second.blend.id] });
    expect(s.artActive).toBe(second.blend.id);
    // A non-layer node changes the selection, not the target.
    s = run(s, { type: "select_nodes", ids: ["output"] });
    expect(s.artActive).toBe(second.blend.id);
  });
});

describe("F fits, everywhere it can", () => {
  // "Would F make sense for 'Fit'?" One story now: F
  // fits the view to what matters - the photograph in Develop, the
  // nodes in Graph and Canvas - and Adjust by Key moved to A.
  it("F fits the photograph in Develop and stays Frame Nodes in Graph", () => {
    let s = run(initialState(), { type: "set_zoom", zoom: "100" });
    const dispatch = (c: Command) => {
      s = reduce(s, c);
    };
    expect(runCommand("view.fit", s, dispatch)).toBe(true);
    expect(s.viewerZoom).toBe("fit");
  });

  it("the F key reaches Fit end to end in Develop", async () => {
    const user = userEvent.setup();
    render(<App />);
    await user.click(screen.getByRole("button", { name: "100%" }));
    expect(screen.getByRole("button", { name: "100%" }).getAttribute("data-active")).toBe("true");
    fireEvent.keyDown(window, { key: "F" });
    expect(screen.getByRole("button", { name: "Fit" }).getAttribute("data-active")).toBe("true");
  });
});

describe("SHIFT+M walks the selection methods", () => {
  it("arms the tool and cycles the whole Draw-with list, wrapping", async () => {
    // "a modifier key that when pressing M cycles
    // through each selection type each time M is pressed."
    const { SELECT_METHODS } = await import("../state");
    let s = initialState();
    const dispatch = (c: Command) => {
      s = reduce(s, c);
    };
    const start = SELECT_METHODS.findIndex((m) => m.id === s.selectMethod);
    expect(runCommand("art.select.cycle", s, dispatch)).toBe(true);
    expect(s.tool).toBe("select");
    expect(s.selectMethod).toBe(SELECT_METHODS[(start + 1) % SELECT_METHODS.length].id);
    // A full lap comes home.
    for (let i = 0; i < SELECT_METHODS.length - 1; i++) {
      runCommand("art.select.cycle", s, dispatch);
    }
    expect(s.selectMethod).toBe(SELECT_METHODS[start].id);
    expect(s.tool).toBe("select");
  });
});
