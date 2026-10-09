// Guided tours' stop list (src/tourstops.ts): every stop's element is
// found in the rendered app, in the mode and with the panels its way
// opens, so a renamed control fails here rather than in a tour. The
// test opens each place itself (through the app's own commands and
// clicks) and checks every stop that can be on screen there; every stop
// in the list must be checked by some scene.

import { act, fireEvent, render, screen } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { App } from "../app";
import { makeNode, NODE_CATALOG, RETIRED_TYPES } from "../nodes";
import { mainConversion, type Command, type State } from "../state";
import { SECTIONS } from "../ui/simple";
import { seatsOf, TOUR_STOPS, VIEW_COMMANDS, type TourStop } from "../tourstops";
import { tourHostForTests } from "../tourwalk";

const GUIDE = resolve(process.cwd(), "../../docs/user-guide");
const read = (file: string): string | null => {
  try {
    return readFileSync(`${GUIDE}/${file}`, "utf8");
  } catch {
    return null;
  }
};

function host() {
  const h = tourHostForTests();
  if (!h) throw new Error("the app registered no tour host");
  return h;
}

function run(...cmds: Command[]) {
  act(() => {
    for (const c of cmds) host().dispatch(c);
  });
}

const state = (): State => host().getState();

/** The stops found, and the ones that should have been and were not. */
function check(stops: TourStop[], checked: Set<string>, missing: string[]) {
  const s = state();
  for (const stop of stops) {
    if (stop.present && !stop.present(s)) continue;
    const found = stop.target(s, {}).some((q) => document.querySelector(q) !== null);
    if (found) checked.add(stop.id);
    else missing.push(`${stop.id} (${stop.target(s, {}).join(" | ") || "no target for this state"})`);
  }
}

const byArea = (area: TourStop["area"]) => TOUR_STOPS.filter((s) => s.area === area && !s.needs);

describe("the tour stops", () => {
  it("has unique ids, words for every stop and only view commands to open places", () => {
    const ids = TOUR_STOPS.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
    const s0 = {} as State;
    for (const stop of TOUR_STOPS) {
      expect(stop.name.length).toBeGreaterThan(0);
      expect(stop.about.length).toBeGreaterThan(0);
      for (const v of stop.via) expect(ids, `${stop.id} via ${v}`).toContain(v);
      if (stop.kind === "place") expect(stop.open, stop.id).toBeDefined();
      for (const c of stop.open?.({ ...s0, exportOpen: false, browserOpen: false, palette: null, graphSearchOpen: false } as State) ?? []) {
        expect(VIEW_COMMANDS.has(c.type), `${stop.id} opens with ${c.type}`).toBe(true);
      }
    }
    // Generated, not hand-listed: every section, every row, every
    // palette node and each of its ports.
    for (const sec of SECTIONS) expect(ids).toContain(`section.${sec.title.toLowerCase().replace(/[^a-z]+/g, "-")}`);
    const rows = SECTIONS.reduce((n, sec) => n + sec.rows.length, 0);
    expect(TOUR_STOPS.filter((s) => s.id.startsWith("control.")).length).toBe(rows);
    const nodes = NODE_CATALOG.filter((n) => !RETIRED_TYPES.has(n.type));
    expect(TOUR_STOPS.filter((s) => s.id.startsWith("node.")).length).toBe(nodes.length);
    const ports = nodes.reduce((n, spec) => n + seatsOf(spec.type).length, 0);
    expect(TOUR_STOPS.filter((s) => s.id.startsWith("port.")).length).toBe(ports);
  });

  it("names guide chapters that exist, and every node's reference has its heading", () => {
    for (const stop of TOUR_STOPS) {
      if (!stop.chapter) continue;
      expect(read(stop.chapter), `${stop.id}: ${stop.chapter}`).not.toBeNull();
    }
    const missing: string[] = [];
    for (const stop of TOUR_STOPS.filter((s) => s.id.startsWith("node."))) {
      const text = read(stop.chapter!) ?? "";
      if (stop.chapter!.startsWith("graph/nodes/") && !text.includes(`\`${stop.nodeType}\``)) missing.push(`${stop.nodeType} in ${stop.chapter}`);
    }
    // A few kin share a heading (To Display and To Scene, the split and
    // the join); none is simply missing.
    expect(missing).toEqual([]);
  });

  it("finds every stop's element in the rendered app", () => {
    render(<App />);
    const checked = new Set<string>();
    const missing: string[] = [];

    // Develop, Adjustments, every section unfolded.
    run({ type: "set_mode", mode: "simple" }, { type: "set_panel_tab", tab: "adjust" }, { type: "open_sections", titles: SECTIONS.map((s) => s.title) });
    check(TOUR_STOPS.filter((s) => s.id.startsWith("mode.") || s.id.startsWith("tab.")), checked, missing);
    check(byArea("develop").filter((s) => !s.id.startsWith("bw.")), checked, missing);
    // Every section switched on (the ones that build their nodes on
    // first use draw their rows only then), and Noise Reduction's other
    // Method, whose rows replace the first.
    for (const sec of SECTIONS) {
      const toggle = document.querySelector(`[data-testid="toggle-${sec.title.toLowerCase().replace(/[^a-z]+/g, "-")}"]`);
      if (toggle && toggle.getAttribute("aria-checked") !== "true") act(() => { fireEvent.click(toggle); });
    }
    run({ type: "open_sections", titles: SECTIONS.map((s) => s.title) });
    check(byArea("develop").filter((s) => !s.id.startsWith("bw.")), checked, missing);
    act(() => { fireEvent.click(screen.getByTestId("nr-method-model")); });
    check(byArea("develop").filter((s) => s.id.startsWith("control.noise-reduction.")), checked, missing);
    // The treatment's stops, then the mix it opens.
    check(byArea("develop").filter((s) => s.id.startsWith("bw.")), checked, missing);
    const bw = mainConversion(state().nodes);
    expect(bw, "the Color section hosts the conversion").toBeDefined();
    act(() => {
      fireEvent.click(screen.getByTestId("bw-mode-bw"));
    });
    check(byArea("develop").filter((s) => s.id.startsWith("bw.")), checked, missing);
    // An infrared filter opens the Infrared fold.
    run({ type: "set_text_param", id: mainConversion(state().nodes)!.id, param: "filter", value: "r72" });
    check(byArea("develop").filter((s) => s.id.startsWith("bw.infrared")), checked, missing);

    // The viewer's crop and straighten, then the crop's own bar.
    check(byArea("viewer"), checked, missing);
    run({ type: "set_tool", tool: "crop" });
    check(byArea("viewer"), checked, missing);
    run({ type: "set_tool", tool: "none" });

    // The menus, opened as a user opens them.
    const menus = byArea("menus");
    check(menus.filter((s) => s.via.length === 0), checked, missing);
    for (const top of ["file", "photo", "select", "help"]) {
      act(() => {
        fireEvent.click(screen.getByTestId(`menu-${top}`));
      });
      check(menus.filter((s) => s.via.length === 1 && s.via[0] === `menu.${top}`), checked, missing);
      if (top === "photo") {
        act(() => {
          fireEvent.mouseEnter(screen.getByTestId("menu-photo-crop").parentElement!);
        });
        check(menus.filter((s) => s.via[s.via.length - 1] === "menu.photo.crop"), checked, missing);
        act(() => {
          fireEvent.mouseEnter(screen.getByTestId("menu-photo-aspect").parentElement!);
        });
        check(menus.filter((s) => s.via[s.via.length - 1] === "menu.photo.ratio"), checked, missing);
      }
      act(() => {
        fireEvent.click(screen.getByTestId(`menu-${top}`));
      });
    }

    // Export, closed and open.
    check(byArea("export"), checked, missing);
    run({ type: "toggle_export" });
    check(byArea("export"), checked, missing);
    run({ type: "toggle_export" });

    // Finish: the panel's add buttons and the toolbar.
    run({ type: "set_panel_tab", tab: "layers" });
    check(byArea("finish"), checked, missing);

    // The Library, folded and open.
    if (state().browserOpen) run({ type: "toggle_browser" });
    check(byArea("library"), checked, missing);
    run({ type: "toggle_browser" });
    check(byArea("library"), checked, missing);

    // Preferences.
    check(byArea("preferences"), checked, missing);
    run({ type: "open_prefs" });
    check(byArea("preferences"), checked, missing);
    run({ type: "close_prefs" });

    // Graph: a card of every type on the canvas, then the palette, the
    // search and the context menu.
    run({ type: "set_mode", mode: "advanced" });
    // A fresh card of every type, the newest of its kind, so each draws
    // every port its type has (the default graph's cards carry the flags
    // they were built with).
    let x = 0;
    for (const spec of NODE_CATALOG) {
      if (RETIRED_TYPES.has(spec.type) || spec.type === "heeler.image_source" || spec.type === "heeler.output") continue;
      run({ type: "add_node", node: makeNode(spec, `t_${spec.type.replace("heeler.", "")}`, (x += 160), 900) });
    }
    const graph = byArea("graph");
    check(graph.filter((s) => !s.id.startsWith("graph.add.") && !s.via.includes("graph.menu")), checked, missing);
    run({ type: "open_palette", x: 260, y: 180 });
    check(graph.filter((s) => s.id === "graph.add" || s.id.startsWith("graph.add.")), checked, missing);
    run({ type: "close_palette" });
    run({ type: "toggle_graph_search", open: true });
    check(graph.filter((s) => s.id === "graph.find"), checked, missing);
    run({ type: "toggle_graph_search", open: false });
    const two = state().nodes.slice(-2).map((n) => n.id);
    run({ type: "select_nodes", ids: two });
    act(() => {
      fireEvent.contextMenu(screen.getByTestId("graph-surface"), { clientX: 300, clientY: 300 });
    });
    expect(screen.queryByTestId("context-menu")).not.toBeNull();
    check(graph.filter((s) => s.via.includes("graph.menu")), checked, missing);

    // Composite stops point at the stops they name, checked above.
    for (const stop of TOUR_STOPS.filter((s) => s.needs)) checked.add(stop.id);
    // A group card and the way out of one need a group: made from the
    // selection above, then opened.
    act(() => {
      host().dispatch({ type: "group_selection", name: "Tour group" });
    });
    check(graph.filter((s) => s.id === "graph.group.open"), checked, missing);
    const group = state().nodes.find((n) => n.isGroup && n.name === "Tour group");
    expect(group).toBeDefined();
    run({ type: "open_group", id: group!.id });
    check(graph.filter((s) => s.id === "graph.group.leave"), checked, missing);

    expect(missing).toEqual([]);
    const unchecked = TOUR_STOPS.map((s) => s.id).filter((id) => !checked.has(id));
    expect(unchecked).toEqual([]);
  }, 60_000);
});

it("keeps the spec's stop count in step with the generated list", () => {
  const spec = readFileSync(resolve(process.cwd(), "../../docs/spec-agentic.md"), "utf8");
  const count = spec.match(/stop list \(src\/tourstops.ts\): (\d+) stops/);
  expect(Number(count?.[1])).toBe(TOUR_STOPS.length);
});
