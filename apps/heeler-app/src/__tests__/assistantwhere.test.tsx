// Where the user is, for the assistant (2026-09-28: "is the assistant
// context aware if the user is in Adjustments or Node graph? that
// would matter a lot of the directions being given"): the facts read
// from the app in each workspace (src/assistantphoto.ts,
// whereFactsOf), the rules the prompts carry for each, the local
// ranking's lean over the real guide, and the tour's stops per
// workspace. Nothing here reaches a server.

import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  plainChapter,
  rankingQuestion,
  ROUTE_DEVELOP,
  ROUTE_GRAPH,
  routePrompt,
  SELECTED_ANSWER,
  systemPrompt,
  WHERE_ANSWER,
  whereFactsText,
  type Chapter,
  type WhereFacts,
} from "../assistant";
import { gatherMaterial, indexGuide } from "../assistantguide";
import { TOOL_NAMES, whereFactsOf } from "../assistantphoto";
import set from "../assistantworkspace.json";
import questions from "../assistantquestions.json";
import { initialState } from "../data";
import { NODE_CATALOG } from "../nodes";
import type { NodeCard, State } from "../state";
import { navFor, relevantStops, tourPrompt, TOUR_WHERE } from "../tour";
import { STOP_BY_ID } from "../tourstops";

const GUIDE_DIR = resolve(process.cwd(), "../../docs/user-guide");

function realGuide(): Chapter[] {
  const out: Chapter[] = [];
  const walk = (dir: string, pre: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const rel = pre ? `${pre}/${e.name}` : e.name;
      if (e.isDirectory()) walk(`${dir}/${e.name}`, rel);
      else if (e.name.endsWith(".md") && rel !== "legal/third-party-notices.md" && rel !== "legal/cddl.md") {
        const raw = readFileSync(`${dir}/${e.name}`, "utf8");
        const title = raw.split("\n").find((l) => l.startsWith("# "))?.slice(2).trim() ?? rel;
        out.push({ file: rel, title, text: plainChapter(raw) });
      }
    }
  };
  walk(GUIDE_DIR, "");
  return out.sort((a, b) => a.file.localeCompare(b.file));
}

type Expect = string | string[];
const satisfied = (expect: Expect[], files: string[]) =>
  expect.every((x) => (Array.isArray(x) ? x : [x]).some((f) => files.includes(f)));

const specOf = (type: string) => NODE_CATALOG.find((n) => n.type === type)!;

/** A card of a type, as the palette would place it, with values the
 * facts must never carry. */
function card(id: string, type: string, name = specOf(type).name, params: Record<string, number> = { secret_value: 0.4242 }): NodeCard {
  return { id, type, name, cat: specOf(type).cat, x: 0, y: 0, enabled: true, params };
}

/** The selection as the facts would carry it, for a question in the
 * set. */
function whereFor(workspace: "Develop" | "Graph", selected?: string[]): WhereFacts {
  if (workspace === "Develop") return { workspace, tab: "Adjustments", layer: "Base (the whole photograph)" };
  return { workspace, ...(selected?.length ? { selected: selected.map((t) => ({ kind: specOf(t).name, type: t })) } : {}) };
}

describe("where the user is, read from the app", () => {
  it("in Develop: the workspace, the tab, the layer and the tool", () => {
    const s = initialState();
    const base: State = { ...s, mode: "simple", panelTab: "adjust", activeLayer: null, tool: "none" };
    const w = whereFactsOf(base);
    expect(w).toEqual({ workspace: "Develop", tab: "Adjustments", layer: "Base (the whole photograph)" });
    expect(whereFactsText(w)).toBe(
      [
        "WHERE THE USER IS IN HEELER (read from the app when the question was asked)",
        "Workspace: Develop (the photograph with the right panel's tabs: Adjustments, Finish and the others)",
        "Right panel tab: Adjustments",
        "Layer being worked on: Base (the whole photograph)",
        "Tool in hand: none",
      ].join("\n"),
    );
    // An adjustment layer, by the name the Layers list gives it.
    const adj = card("layer_1_adj", "heeler.exposure", "Sky lift");
    const onLayer = whereFactsOf({ ...base, nodes: [...base.nodes, adj], activeLayer: "layer_1_adj", tool: "crop" });
    expect(onLayer.layer).toBe('the adjustment layer "Sky lift" (edits behind its mask)');
    expect(onLayer.tool).toBe(TOOL_NAMES.crop);
    // Finish, History: the tab by its label; Finish says its layer.
    expect(whereFactsOf({ ...base, panelTab: "layers", artActive: null })).toEqual({ workspace: "Develop", tab: "Finish", layer: "none selected" });
    expect(whereFactsOf({ ...base, panelTab: "history" })).toEqual({ workspace: "Develop", tab: "History" });
    // A selection in the graph is not Develop's business.
    const curves = card("n_curves", "heeler.curves");
    expect(whereFactsOf({ ...base, nodes: [...base.nodes, curves], selection: ["n_curves"] }).selected).toBeUndefined();
  });

  it("in Graph with a node selected: its type and its name, never its values", () => {
    const s = initialState();
    const curves = card("n_curves", "heeler.curves", "Sky curve");
    const exposure = card("n_exp", "heeler.exposure");
    const state: State = { ...s, mode: "advanced", nodes: [...s.nodes, curves, exposure], selection: ["n_curves"], tool: "none", panelTab: "adjust" };
    const w = whereFactsOf(state);
    expect(w).toEqual({ workspace: "Graph", selected: [{ kind: "Curves", type: "heeler.curves", name: "Sky curve", ref: "graph/nodes/color.md" }] });
    const text = whereFactsText(w);
    expect(text).toBe(
      [
        "WHERE THE USER IS IN HEELER (read from the app when the question was asked)",
        "Workspace: Graph (the node graph the edit is made of, with the Inspector beside it)",
        'Selected node: Curves (heeler.curves, in the menus Color > Tone > Curves), named "Sky curve"',
        "Tool in hand: none",
      ].join("\n"),
    );
    expect(text).not.toContain("0.4242");
    expect(text).not.toContain("secret_value");
    expect(text).not.toContain("Right panel tab");
    // Two selected, the second under its own kind's name: no "named".
    const two = whereFactsText(whereFactsOf({ ...state, selection: ["n_curves", "n_exp"] }));
    expect(two).toContain('Selected nodes: Curves (heeler.curves, in the menus Color > Tone > Curves), named "Sky curve"; Exposure (heeler.exposure, in the menus Color > Tone > Exposure)');
    expect(whereFactsText(whereFactsOf({ ...state, selection: [] }))).toContain("Selected nodes: none");
  });

  it("in Graph with a group open: the group's name, and the selection inside it", () => {
    const s = initialState();
    const blur = card("g_blur", "heeler.blur");
    const group: NodeCard = { ...card("grp_1", "heeler.exposure", "Background soften"), type: "heeler.group", isGroup: true, groupNodes: [blur], groupWires: [] };
    const state: State = { ...s, mode: "advanced", nodes: [...s.nodes, group], openedGroup: "grp_1", selection: ["g_blur"], tool: "none" };
    const w = whereFactsOf(state);
    expect(w.group).toBe("Background soften");
    expect(w.selected).toEqual([{ kind: "Blur", type: "heeler.blur", ref: "graph/nodes/detail.md" }]);
    expect(whereFactsText(w)).toContain("Open group: Background soften (the graph shows the group's own nodes)");
  });

  it("in Canvas: the graph's facts, and the tool in hand", () => {
    const s = initialState();
    const grain = card("n_grain", "heeler.grain");
    const w = whereFactsOf({ ...s, mode: "canvas", nodes: [...s.nodes, grain], selection: ["n_grain"], tool: "straighten" });
    expect(w).toEqual({ workspace: "Canvas", selected: [{ kind: "Grain", type: "heeler.grain", ref: "graph/nodes/detail.md" }], tool: "Straighten" });
    expect(whereFactsText(w)).toContain("Workspace: Canvas (the node graph floating over the photograph");
  });
});

describe("the prompts carry the workspace's rules", () => {
  const chapters: Chapter[] = [{ file: "a.md", title: "A", text: "# A" }];
  const graph: WhereFacts = { workspace: "Graph", selected: [{ kind: "Curves", type: "heeler.curves" }] };
  const develop: WhereFacts = { workspace: "Develop", tab: "Adjustments", layer: "Base (the whole photograph)" };

  it("the answer: directions in the place the user is, and what \"this node\" means", () => {
    const g = systemPrompt(chapters, null, null, null, graph);
    expect(g).toContain(WHERE_ANSWER.Graph);
    expect(g).toContain("which output port to wire to which input port");
    expect(g).toContain(SELECTED_ANSWER);
    expect(g).toContain("Selected node: Curves (heeler.curves, in the menus Color > Tone > Curves)");
    expect(g).not.toContain(WHERE_ANSWER.Develop);
    const d = systemPrompt(chapters, null, null, null, develop);
    expect(d).toContain(WHERE_ANSWER.Develop);
    expect(d).toContain("sections and sliders");
    expect(d).not.toContain(SELECTED_ANSWER);
    expect(d).toContain("Right panel tab: Adjustments");
    expect(systemPrompt(chapters, null, null, null, { workspace: "Canvas" })).toContain(WHERE_ANSWER.Canvas);
    // Without it, the prompt is as it was.
    const none = systemPrompt(chapters, null);
    expect(none).not.toContain("WHERE THE USER IS");
    expect(none).not.toContain("workspace");
  });

  it("the routing: the workspace and the selected types, not the rest of the facts", () => {
    const g = routePrompt("toc", null, { ...graph, selected: [{ kind: "Curves", type: "heeler.curves", ref: "graph/nodes/color.md" }], tool: "Crop", group: "Mine" });
    expect(g).toContain(ROUTE_GRAPH);
    expect(g).toContain("Selected in the graph: Curves (heeler.curves, described in graph/nodes/color.md)");
    expect(g).not.toContain("Crop");
    expect(g).not.toContain("Mine");
    const d = routePrompt("toc", null, { ...develop, tool: "Crop" });
    expect(d).toContain(ROUTE_DEVELOP);
    expect(d).not.toContain("Adjustments tab");
    expect(d).not.toContain("Crop");
    expect(routePrompt("toc", null)).not.toContain("workspace");
  });

  it("the tour: made where the user is", () => {
    expect(tourPrompt( "Graph")).toContain(TOUR_WHERE.Graph);
    expect(tourPrompt( "Develop")).toContain(TOUR_WHERE.Develop);
    expect(tourPrompt()).not.toContain("The user is in");
  });

  it("reads \"this node\" as the selected nodes' types for the local ranking, and nothing else", () => {
    expect(rankingQuestion("What does this node do?", graph)).toBe("What does this node do? Curves");
    expect(rankingQuestion("How do I add grain?", graph)).toBe("How do I add grain?");
    expect(rankingQuestion("What does this node do?", develop)).toBe("What does this node do?");
    expect(rankingQuestion("How do I connect nodes in the node graph?", graph)).toBe("How do I connect nodes in the node graph?");
  });
});

describe("the question set in both workspaces, over the real guide", () => {
  const guide = realGuide();
  const index = indexGuide(guide);
  const known = new Set(guide.map((c) => c.file));

  it("names only chapters that exist", () => {
    for (const q of set.questions) {
      for (const f of [...((q.develop ?? []) as Expect[]).flat(), ...(q.graph as Expect[]).flat()]) expect(known.has(f), `${q.q}: ${f}`).toBe(true);
    }
    expect(set.questions.length).toBeGreaterThanOrEqual(10);
  });

  it("lands each workspace's chapters in the material the local ranking sends", () => {
    const misses: string[] = [];
    for (const q of set.questions) {
      for (const ws of ["Develop", "Graph"] as const) {
        const want = (ws === "Develop" ? q.develop : q.graph) as Expect[] | null;
        if (!want) continue;
        const where = whereFor(ws, q.selected);
        const m = gatherMaterial(rankingQuestion(q.q, where), index, [], undefined, where.workspace);
        const files = m.chapters.map((c) => c.file);
        if (!satisfied(want, files)) misses.push(`${ws}: ${q.q} -> ${files.join(", ")}`);
      }
    }
    expect(misses).toEqual([]);
  });

  it("puts a graph chapter first in Graph, and an Adjustments chapter first in Develop", () => {
    const wrong: string[] = [];
    for (const q of set.questions) {
      for (const ws of ["Develop", "Graph"] as const) {
        if (ws === "Develop" && !q.develop) continue;
        const where = whereFor(ws, q.selected);
        const first = gatherMaterial(rankingQuestion(q.q, where), index, [], undefined, where.workspace).chapters[0]?.file ?? "";
        if (ws === "Graph" ? !first.startsWith("graph/") : first.startsWith("graph/")) wrong.push(`${ws}: ${q.q} -> ${first}`);
      }
    }
    expect(wrong).toEqual([]);
  });

  it("lands every expected chapter of the guide's question set when asked in Develop, as without the workspace", () => {
    const misses: string[] = [];
    for (const q of questions.questions) {
      const files = gatherMaterial(q.q, index, [], undefined, "Develop").chapters.map((c) => c.file);
      if (!satisfied(q.expect as Expect[], files)) misses.push(`${q.q} -> ${files.join(", ")}`);
    }
    expect(misses).toEqual([]);
    expect(questions.questions.length).toBe(35);
  });

  it("leans Develop away from the graph's chapters only when the question does not ask about the graph", () => {
    const grain = gatherMaterial("How do I add grain?", index, [], undefined, "Develop").chapters.map((c) => c.file);
    expect(grain[0]).toBe("adjustments/grain.md");
    const asked = gatherMaterial("How do I use the red channel as a mask in the node graph?", index, [], undefined, "Develop").chapters.map((c) => c.file);
    expect(asked).toEqual(gatherMaterial("How do I use the red channel as a mask in the node graph?", index).chapters.map((c) => c.file));
    // And the graph leans toward its own chapters unless the question
    // names Develop's: a Finish layer asked about in the graph.
    const finish = gatherMaterial("How do I add a gradient layer in Finish?", index, [], undefined, "Graph").chapters.map((c) => c.file);
    expect(finish).toContain("finish/gradient-layer.md");
  });
});

describe("the tour's stops, per workspace", () => {
  const color: Chapter = { file: "adjustments/color-tune.md", title: "Color Tune", text: "# Color Tune" };
  const nodes: Chapter = { file: "graph/nodes/color.md", title: "Color nodes", text: "# Color nodes" };

  it("in Graph: the graph's gestures and the named nodes' stops, no Develop tabs or sections, no way out of the graph", () => {
    const ids = relevantStops({
      question: "How do I desaturate the reds?",
      answer: "Add a Hue Range Mask node and a Color node, and wire the mask's output into Color's mask input.",
      chapters: [nodes],
      max: 220,
      workspace: "Graph",
    }).map((s) => s.id);
    expect(ids).toContain("graph.add");
    expect(ids).toContain("graph.connect");
    expect(ids).toContain("graph.add.hue_range_mask");
    expect(ids).toContain("port.standard_color.mask");
    expect(ids).toContain("mode.graph");
    expect(ids).not.toContain("mode.develop");
    expect(ids.some((id) => id.startsWith("tab."))).toBe(false);
    expect(ids.some((id) => id.startsWith("section.") || id.startsWith("control."))).toBe(false);
  });

  it("in Graph: the selected node's stops and the node behind an answering section's chapter", () => {
    const ids = relevantStops({ question: "How do I use this node?", answer: "Drag its points.", chapters: [{ ...color }], max: 220, workspace: "Graph", selected: ["heeler.curves"] }).map((s) => s.id);
    expect(ids).toContain("node.curves");
    const behind = STOP_BY_ID.get("section.color-tune")?.nodeType;
    expect(behind).toBeTruthy();
    expect(ids).toContain(`graph.add.${behind!.replace(/^heeler\./, "")}`);
  });

  it("in Graph: Develop's stops when the answer sends the user there", () => {
    const c = { question: "How do I fix lens distortion?", answer: "Switch to Develop and open the Lens section in the Adjustments tab.", chapters: [{ file: "adjustments/lens.md", title: "Lens", text: "# Lens" }], max: 220, workspace: "Graph" as const };
    expect(navFor(c)).toContain("mode.develop");
    const ids = relevantStops(c).map((s) => s.id);
    expect(ids).toContain("tab.adjust");
    expect(ids).toContain("section.lens");
  });

  it("in Develop: the sections and tabs, and no graph unless asked about", () => {
    const c = { question: "How do I desaturate the reds?", answer: "Open Color Tune and lower Saturation for Red.", chapters: [color], max: 220, workspace: "Develop" as const };
    const ids = relevantStops(c).map((s) => s.id);
    expect(ids).toContain("tab.adjust");
    expect(ids).toContain("section.color-tune");
    expect(ids).not.toContain("mode.graph");
    expect(ids).not.toContain("mode.canvas");
    expect(ids.some((id) => id.startsWith("graph.") || id.startsWith("node.") || id.startsWith("port."))).toBe(false);
    const asked = relevantStops({ ...c, question: "How do I desaturate the reds in the node graph?", answer: "Add a Color node." }).map((s) => s.id);
    expect(asked).toContain("mode.graph");
    expect(asked).toContain("graph.add.standard_color");
  });

  it("in Canvas: the graph's stops, and the graph counted open with its nodes shown", () => {
    const ids = relevantStops({ question: "How do I add grain?", answer: "Add a Grain node and splice it into the chain.", chapters: [], max: 220, workspace: "Canvas" }).map((s) => s.id);
    expect(ids).toContain("mode.canvas");
    expect(ids).toContain("graph.add.grain");
    expect(ids).not.toContain("mode.develop");
    const s = initialState();
    const test = (st: State) => {
      const d = STOP_BY_ID.get("mode.graph")!.done;
      return d.kind === "state" && d.test(st, st, {});
    };
    expect(test({ ...s, mode: "canvas", canvasNodesHidden: false, graphPoppedOut: false })).toBe(true);
    expect(test({ ...s, mode: "canvas", canvasNodesHidden: true, graphPoppedOut: false })).toBe(false);
    expect(test({ ...s, mode: "simple" })).toBe(false);
  });

  it("offers every workspace's places when the workspace is not known, as before", () => {
    const ids = relevantStops({ question: "How do I add grain?", answer: "Open Grain.", chapters: [], max: 220 }).map((s) => s.id);
    for (const id of ["mode.develop", "mode.graph", "mode.canvas", "tab.adjust"]) expect(ids).toContain(id);
  });
});
