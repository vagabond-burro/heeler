// Guided tours' stops. A model cannot be trusted to name a button
// precisely, so a tour is a list of these ids, chosen by the model and
// checked here: every id a tour names must be in this list, and each
// stop knows how to find its element on screen, which stops open the
// way to it, and what state change completes it.
//
// Generated wherever the app has a definition to read: the Develop
// sections and their rows (ui/simple.tsx SECTIONS), the panel tabs
// (PANEL_TABS), the workspaces, the export sizes, the crop ratios, the
// Preferences categories, and in Graph mode every node type in the
// palette (NODE_CATALOG) with each of its ports (makeNode's flags, the
// names portName and portData give them). The rest (the Finish toolbar,
// the menus a beginner needs, the graph's own gestures) is listed by
// hand, and a test renders the app and finds every stop's element, so a
// renamed control fails a test rather than a tour.
//
// A stop never changes the edit. `open` is how NEXT reveals a place
// (a mode, a tab, a section unfolded, a panel shown): view state only,
// from VIEW_COMMANDS. Everything else is the user's to do.

import type { Command, Mode, NodeCard, State, Wire } from "./state";
import { artFindLayer, panelShown, artLayers, CROP_RATIOS, LAYER_TOOLS, mainConversion, toolNode, PANEL_TABS } from "./state";
import { makeNode, NODE_CATALOG, nodeMenuPath, portData, portName, producesMask, MASK_IN_TYPES, RETIRED_TYPES, sectionOf, type NodeSpec, type PortSeat } from "./nodes";
import { SECTIONS, sectionIsOn } from "./ui/simple";
import { EXPORT_SIZES } from "./ui/exportpanel";
import { PREFS_CATEGORIES } from "./ui/preferences";
import { IR_MATERIALS } from "./film";
import { isInfrared } from "./filters";

/** The commands a tour may dispatch on its own: showing a place, never
 * editing. The walker's test holds every dispatch to this list. */
export const VIEW_COMMANDS = new Set<Command["type"]>([
  "set_mode",
  "set_panel_tab",
  "open_section",
  "toggle_browser",
  "toggle_export",
  "open_prefs",
  "open_palette",
  "toggle_graph_search",
]);

/** What completes a stop: a change in the state since the stop began
 * (`at`), a click on its element, something appearing on screen (a
 * menu opening, which is the menu's own state, not the app's), or
 * nothing but NEXT. */
export type Done =
  | { kind: "state"; test: (s: State, at: State, step: StepRefs) => boolean }
  | { kind: "click" }
  | { kind: "dom"; test: (doc: Document) => boolean }
  | { kind: "next" };

/** The two stop ids a composite stop takes (graph.connect: from an
 * output port, to an input port). */
export interface StepRefs {
  from?: string;
  to?: string;
}

export type StopArea = "workspace" | "develop" | "finish" | "export" | "library" | "viewer" | "menus" | "preferences" | "graph";

export interface TourStop {
  id: string;
  /** a short name, as the app writes it */
  name: string;
  /** one line: what it is and what doing it does */
  about: string;
  area: StopArea;
  /** "place": a place to open (NEXT opens it with `open`); "control":
   * the user does something; "look": pointed at, NEXT goes on */
  kind: "place" | "control" | "look";
  /** the stops that must be done before this one is on screen,
   * outermost first */
  via: string[];
  /** CSS selectors for the elements to spotlight; empty when none is
   * on screen for this state */
  target: (s: State, step: StepRefs) => string[];
  /** view commands that open this place (NEXT on a way step) */
  open?: (s: State) => Command[];
  done: Done;
  /** the guide chapter that teaches it */
  chapter?: string;
  /** the named feature it belongs to (Film, Filter, Curves), so Learn
   * more can offer a sibling feature of the same chapter */
  feature?: string;
  /** a node type, for the graph's stops and Learn more */
  nodeType?: string;
  /** a port: its direction and the kind of pipe it takes */
  port?: { seat: PortSeat; dir: "in" | "out"; kind: "image" | "mask" };
  /** composite stops name other stops: graph.connect takes from and to */
  needs?: ("from" | "to")[];
  /** whether it can be on screen for this state at all (a Black and
   * White control needs the conversion on); absent: always */
  present?: (s: State) => boolean;
  /** the words for a way step, when this stop opens the way to another */
  way?: (s: State) => string;
  /** the stop's own instruction, shown under the step's sentence on
   * every step at this stop, whatever the model wrote: the ways to do
   * it, the same every run */
  how?: (s: State) => string;
}

const tid = (id: string) => `[data-testid="${id}"]`;
const sel = (...ids: string[]) => ids.map(tid);

export const slugOf = (title: string) => title.toLowerCase().replace(/[^a-z]+/g, "-");

/** The node slug in stop ids: the type without its namespace. */
export const nodeSlug = (type: string) => type.replace(/^heeler\./, "");

// -- the graph's scope -----------------------------------------------------------

/** What the canvas draws: the opened group's contents, else the graph. */
export function graphScope(s: State): { nodes: NodeCard[]; wires: Wire[] } {
  const g = s.openedGroup ? s.nodes.find((n) => n.id === s.openedGroup) : undefined;
  if (g?.groupNodes) return { nodes: g.groupNodes, wires: g.groupWires ?? [] };
  return { nodes: s.nodes, wires: s.wires };
}

/** The card a stop about a node type points at: a selected one, else
 * the last one placed (a tour's "add a Blur" is the newest Blur). */
/** The palette types that land as tool groups (Sharpening and Skin
 * Softening are groups of real nodes, recipes.ts): their cards are
 * found by the group's tool. */
const GROUP_TOOL: Record<string, string> = { "heeler.sharpening": "sharpening", "heeler.skin_soften": "skin" };

const isOfType = (n: NodeCard, type: string) =>
  n.type === type || (GROUP_TOOL[type] !== undefined && n.isGroup === true && (n as NodeCard & { tool?: string }).tool === GROUP_TOOL[type]);

export function instanceOf(s: State, type: string): NodeCard | undefined {
  const { nodes } = graphScope(s);
  const all = nodes.filter((n) => isOfType(n, type));
  return all.find((n) => s.selection.includes(n.id)) ?? all[all.length - 1];
}

const countOf = (s: State, type: string) => graphScope(s).nodes.filter((n) => isOfType(n, type)).length;

// -- ports ------------------------------------------------------------------------

/** A port's seat as a stop id's last part, and back. */
const SEAT_ID: Record<PortSeat, string> = {
  in: "in",
  in2: "in2",
  in3: "in3",
  mask: "mask",
  alpha: "alpha",
  depthIn: "depth-in",
  out: "out",
  maskOut: "mask-out",
  depthOut: "depth-out",
  fileMask: "file-mask",
};

/** The element a seat draws as, by the card's id. */
function portTestId(seat: PortSeat, id: string): string {
  switch (seat) {
    case "in": return `in-port-${id}`;
    case "in2": return `in2-port-${id}`;
    case "in3": return `in3-port-${id}`;
    case "mask": return `mask-in-port-${id}`;
    case "alpha": return `alpha-in-port-${id}`;
    case "depthIn": return `depth-in-port-${id}`;
    case "out": return `out-port-${id}`;
    case "maskOut": return `mask-port-${id}`;
    case "depthOut": return `depth-port-${id}`;
    case "fileMask": return `file-mask-port-${id}`;
  }
}

/** The seats a fresh card of this type draws, from makeNode's own
 * flags. A card with a field output draws its diamond over the plain
 * output, so the diamond is the port. */
export function seatsOf(type: string): PortSeat[] {
  const spec = NODE_CATALOG.find((k) => k.type === type);
  if (!spec) return [];
  const card = makeNode(spec, "x", 0, 0);
  const out: PortSeat[] = [];
  if (card.hasIn) out.push("in");
  if (card.hasIn2) out.push("in2");
  if (card.hasIn3) out.push("in3");
  if (card.maskIn) out.push("mask");
  if (card.alphaIn) out.push("alpha");
  if (card.depthIn) out.push("depthIn");
  if (card.maskOut) out.push("maskOut");
  else if (card.hasOut) out.push("out");
  if (card.depthOut) out.push("depthOut");
  if (card.fileMaskOut) out.push("fileMask");
  return out;
}

/** Whether a card on the canvas draws this seat: a card saved or built
 * before a port existed may not (the default graph's cards carry the
 * flags they were made with). */
export function drawsSeat(n: NodeCard, seat: PortSeat): boolean {
  switch (seat) {
    case "in": return !!n.hasIn;
    case "in2": return !!n.hasIn2;
    case "in3": return !!n.hasIn3;
    case "mask": return !!n.maskIn;
    case "alpha": return !!n.alphaIn;
    case "depthIn": return !!n.depthIn;
    case "out": return !!n.hasOut && !n.maskOut;
    case "maskOut": return !!n.maskOut;
    case "depthOut": return !!n.depthOut;
    case "fileMask": return !!n.fileMaskOut;
  }
}

const INPUT_SEATS = new Set<PortSeat>(["in", "in2", "in3", "mask", "alpha", "depthIn"]);

/** What a seat carries: an image (rgb) or a field (alpha). */
export function seatKind(type: string, seat: PortSeat): "image" | "mask" {
  if (seat === "in" || seat === "in2" || seat === "in3") return MASK_IN_TYPES.has(type) ? "mask" : "image";
  if (seat === "out") return producesMask(type) ? "mask" : "image";
  return "mask";
}

/** A wire's landing seat, as the Wire type names it. */
export function wirePort(seat: PortSeat): Wire["toPort"] | null {
  switch (seat) {
    case "in": case "in2": case "in3": case "mask": case "alpha": return seat;
    case "depthIn": return "depth";
    default: return null;
  }
}

/** A wire's leaving seat, as the Wire type names it (absent: the plain
 * output). */
export function wireFromPort(type: string, seat: PortSeat): Wire["fromPort"] | "any" {
  if (seat === "depthOut") return "depth";
  if (seat === "fileMask") return "mask";
  if (type === "heeler.export_layer" && seat === "out") return "image";
  return undefined;
}

const firstSentence = (text: string) => (/^(.*?\.)(\s|$)/.exec(text)?.[1] ?? text).trim();

// -- the list -------------------------------------------------------------------------

const MODE_WORDS: Record<Mode, { name: string; about: string; chapter: string }> = {
  simple: { name: "Develop", about: "The Develop workspace: the photograph with the Adjustments, Finish and other tabs beside it.", chapter: "workspaces.md" },
  advanced: { name: "Graph", about: "The Graph workspace: the node graph the edit is made of, with the Inspector beside it.", chapter: "graph/README.md" },
  canvas: { name: "Canvas", about: "The Canvas workspace: the photograph full size with the graph floating over it.", chapter: "workspaces.md" },
};

const MODE_ID: Record<Mode, string> = { simple: "mode.develop", advanced: "mode.graph", canvas: "mode.canvas" };

const TAB_CHAPTER: Record<string, string> = {
  adjust: "adjustments/README.md",
  layers: "finish/README.md",
  history: "history.md",
  presets: "presets.md",
  metadata: "metadata.md",
};

/** A section's guide chapter, by its title. */
const SECTION_CHAPTER: Record<string, string> = {
  "Lens Flare": "adjustments/depth-of-field.md",
};
export function sectionChapter(title: string): string {
  return SECTION_CHAPTER[title] ?? `adjustments/${slugOf(title)}.md`;
}

/** A node type's reference chapter: the chapter of the category its
 * menu section sits under (nodes.ts NODE_SECTIONS), which is how the
 * node reference is organized since the menus were split into sections
 * (2026-10-01), or a Develop chapter that describes it fully. */
const NODE_CHAPTER: Record<string, string> = {
  "heeler.model_denoise": "adjustments/noise-reduction.md",
  "heeler.paper": "adjustments/print.md",
  "heeler.skin_soften": "adjustments/skin-softening.md",
  "heeler.grid_warp": "adjustments/grid-warp.md",
  "heeler.shape_warp": "adjustments/shape-warp.md",
  "heeler.layer_warp": "finish/warp-layer.md",
};
export function nodeChapter(spec: NodeSpec): string {
  if (NODE_CHAPTER[spec.type]) return NODE_CHAPTER[spec.type];
  return `graph/nodes/${sectionOf(spec).family}.md`;
}

/** Where an add-node step finds its node, in the words every one of
 * them shows: typed into the palette, or chosen by its full menu path
 * (nodes.ts nodeMenuPath) in the Node menu or the graph's Add menu. */
export function addNodeHow(spec: NodeSpec): string {
  const path = nodeMenuPath(spec.type);
  return `Type ${spec.name} in Find a Node and choose it, or choose Node > ${path} in the menu bar (Add > ${path} in the graph's right-click menu).`;
}

/** Canvas with its graph drawn over the photograph (not hidden, not
 * popped out into its own window). */
/** How the node palette opens, in the words every add-node step uses:
 * Shift+Space, or the add node button where the graph draws one. */
export function addNodeWays(s: State): string {
  return graphOnCanvas(s)
    ? "press Shift+Space or choose Find a Node... in the Node menu."
    : "press Shift+Space or click the add node button (+ at the top of the graph's left toolbar).";
}

export function graphOnCanvas(s: State): boolean {
  return s.mode === "canvas" && !s.canvasNodesHidden && !s.graphPoppedOut;
}

function modeStops(): TourStop[] {
  return (Object.keys(MODE_WORDS) as Mode[]).map((mode) => ({
    id: MODE_ID[mode],
    name: MODE_WORDS[mode].name,
    about: MODE_WORDS[mode].about,
    area: "workspace",
    kind: "place",
    via: [],
    target: () => sel(`mode-${mode}`),
    open: () => [{ type: "set_mode", mode }],
    // Canvas draws the same node cards, ports and wires over the
    // photograph, so the way into the graph is already open there while
    // its nodes are shown: a Canvas user's graph tour stays in Canvas.
    done: { kind: "state", test: (s) => s.mode === mode || (mode === "advanced" && graphOnCanvas(s)) },
    chapter: MODE_WORDS[mode].chapter,
    way: () => `Switch to the ${MODE_WORDS[mode].name} workspace first: click ${MODE_WORDS[mode].name} at the top right.`,
  }));
}

function tabStops(): TourStop[] {
  return PANEL_TABS.filter((t) => t.id !== "tether").map((t) => ({
    id: `tab.${t.id}`,
    name: `${t.label} tab`,
    about: `${t.hint}.`,
    area: t.id === "layers" ? "finish" : "develop",
    kind: "place",
    via: ["mode.develop"],
    target: () => sel(`panel-tab-${t.id}`),
    open: () => [{ type: "set_panel_tab", tab: t.id }],
    done: { kind: "state", test: (s) => s.panelTab === t.id || (s.panelBottom.length > 0 && s.panelTabBottom === t.id) },
    chapter: TAB_CHAPTER[t.id],
    way: () => `Open the ${t.label} tab in the right panel.`,
  }));
}

function sectionStops(): TourStop[] {
  const out: TourStop[] = [];
  for (const sec of SECTIONS) {
    const slug = slugOf(sec.title);
    const chapter = sectionChapter(sec.title);
    const nodeType = sec.layerTool ? LAYER_TOOLS[sec.layerTool]?.type : sec.title === "Geometry" ? "heeler.crop_rotate" : undefined;
    const place = ["mode.develop", "tab.adjust"];
    const hidden = (s: State) => s.prefs.hiddenSections.includes(sec.title);
    out.push({
      id: `section.${slug}`,
      name: `${sec.title} section`,
      about: `The ${sec.title} section of Adjustments; click its title to unfold it.`,
      area: "develop",
      kind: "place",
      via: place,
      target: (s) => (s.prefs.hiddenSections.includes(sec.title) ? [] : [`${tid(`collapse-${slug}`)}`, `[data-section="${sec.title}"]`]),
      open: () => [{ type: "open_section", title: sec.title }],
      done: { kind: "state", test: (s) => !s.sectionsClosed.includes(sec.title) },
      chapter,
      nodeType,
      present: (s) => !hidden(s),
      way: (s) =>
        sec.node(s) || sec.hideToggle
          ? `Unfold the ${sec.title} section in Adjustments.`
          : `Switch the ${sec.title} section on; its controls appear once it is on.`,
    });
    if (!sec.hideToggle) {
      out.push({
        id: `section.${slug}.on`,
        name: `${sec.title} switch`,
        about: `Switches ${sec.title} on or off.`,
        area: "develop",
        kind: "control",
        via: place,
        target: () => sel(`toggle-${slug}`),
        done: { kind: "state", test: (s) => sectionIsOn(s, sec) },
        chapter,
        nodeType,
        present: (s) => !hidden(s),
      });
    }
    const seenParams = new Set<string>();
    for (const row of sec.rows) {
      const nodeOf = (s: State) => row.node?.(s) ?? sec.node(s);
      // Two rows may share a param on different nodes (Noise
      // Reduction's Strength, one per Method): the second is named by
      // its label.
      const rowId = seenParams.has(row.param) ? `${row.param}.${slugOf(row.label)}` : row.param;
      seenParams.add(row.param);
      out.push({
        id: `control.${slug}.${rowId}`,
        name: `${row.label} (${sec.title})`,
        about: `The ${row.label} slider in ${sec.title}${row.heading ? `, under ${row.heading}` : ""}.`,
        area: "develop",
        kind: "control",
        via: [...place, `section.${slug}`],
        target: () => [`[data-section="${sec.title}"] ${tid(`slider-${row.param}`)}`],
        done: {
          kind: "state",
          test: (s, at) => {
            const now = nodeOf(s);
            const was = nodeOf(at);
            return !!now && (now.params[row.param] ?? null) !== (was?.params[row.param] ?? null);
          },
        },
        chapter,
        nodeType,
        present: (s) => !hidden(s) && !!sec.node(s) && !s.sectionsClosed.includes(sec.title) && (row.when ? row.when(s) : true),
      });
    }
  }
  return out;
}

const monoOn = (s: State) => {
  const c = mainConversion(s.nodes);
  return !!c && c.enabled && (c.params.amount ?? 0) > 0;
};
const bwNode = (s: State) => mainConversion(s.nodes);

/** The sections whose control is a widget rather than rows: without a
 * stop of their own, a model asked for an S curve reached for
 * Exposure's sliders (measured, the owner's Qwen3, 2026-09-28).*/
function widgetStops(): TourStop[] {
  const via = ["mode.develop", "tab.adjust"];
  const curves = (s: State) => toolNode(s, "curves");
  const wheels = (s: State) => toolNode(s, "wheels");
  return [
    {
      id: "curves.editor",
      name: "Curve (Curves)",
      about: "The Curves section's curve: click it to add a point and drag the point up or down; lower in the shadows and higher in the highlights is an S curve, more contrast.",
      area: "develop",
      kind: "control",
      via: [...via, "section.curves"],
      target: () => [`[data-section="Curves"] ${tid("curve-editor")}`],
      done: { kind: "state", test: (s, at) => JSON.stringify(curves(s)?.curves ?? null) !== JSON.stringify(curves(at)?.curves ?? null) },
      chapter: "adjustments/curves.md",
      feature: "Curves",
      nodeType: "heeler.curves",
      present: (s) => !!curves(s) && !s.sectionsClosed.includes("Curves"),
    },
    {
      id: "wheels.editor",
      name: "Wheels (Color Wheels)",
      about: "The Color Wheels: drag in a wheel to tint the shadows, midtones or highlights toward that hue.",
      area: "develop",
      kind: "control",
      via: [...via, "section.color-wheels"],
      target: () => [`[data-section="Color Wheels"] ${tid("develop-wheels")}`],
      done: { kind: "state", test: (s, at) => JSON.stringify(wheels(s)?.params ?? null) !== JSON.stringify(wheels(at)?.params ?? null) },
      chapter: "adjustments/color-wheels.md",
      feature: "Color Wheels",
      nodeType: LAYER_TOOLS.wheels?.type,
      present: (s) => !!wheels(s) && !s.sectionsClosed.includes("Color Wheels"),
    },
  ];
}

function blackWhiteStops(): TourStop[] {
  const chapter = "adjustments/black-and-white.md";
  const via = ["mode.develop", "tab.adjust", "section.color"];
  const changed = (param: string) => (s: State, at: State) => {
    const now = bwNode(s);
    return !!now && (now.params[param] ?? null) !== (bwNode(at)?.params[param] ?? null);
  };
  const stops: TourStop[] = [
    {
      id: "bw.treatment",
      name: "Black and white treatment",
      about: "The Treatment choice in the Color section: black and white builds the conversion and opens its mix below the dials.",
      area: "develop",
      kind: "control",
      via,
      target: () => sel("bw-mode-bw"),
      done: { kind: "state", test: (s) => monoOn(s) },
      chapter,
      nodeType: "heeler.black_white",
    },
    {
      id: "bw.color",
      name: "Color treatment",
      about: "The Treatment choice back to color: the conversion stands down.",
      area: "develop",
      kind: "control",
      via,
      target: () => sel("bw-mode-color"),
      done: { kind: "state", test: (s) => !monoOn(s) },
      chapter,
      nodeType: "heeler.black_white",
    },
    {
      id: "bw.strength",
      name: "Strength (black and white)",
      about: "Fades between the color photograph and the black and white conversion.",
      area: "develop",
      kind: "control",
      via: [...via, "bw.treatment"],
      target: () => [`${tid("bw-mixer")} ${tid("slider-amount")}`],
      done: { kind: "state", test: changed("amount") },
      chapter,
      nodeType: "heeler.black_white",
      present: monoOn,
    },
  ];
  for (const [param, color, does] of [
    ["red", "Red", "how bright reds and skin render: raise it to lighten them"],
    ["green", "Green", "how bright greens and foliage render"],
    ["blue", "Blue", "how bright blues render: lower it to darken a blue sky"],
  ] as const) {
    stops.push({
      id: `bw.mix.${param}`,
      name: `${color} (black and white mix)`,
      about: `The mix's ${color} slider: ${does}.`,
      area: "develop",
      kind: "control",
      via: [...via, "bw.treatment"],
      target: () => [`${tid("bw-mixer-weights")} ${tid(`slider-${param}`)}`],
      done: { kind: "state", test: changed(param) },
      chapter,
      nodeType: "heeler.black_white",
      present: monoOn,
    });
  }
  stops.push(
    {
      id: "bw.hue-curve",
      name: "Hue curve (black and white)",
      about: "Brightens or darkens each hue by name, finer than the mix.",
      area: "develop",
      kind: "look",
      via: [...via, "bw.treatment"],
      target: () => sel("bw-hue-curve"),
      done: { kind: "next" },
      chapter,
      nodeType: "heeler.black_white",
      present: monoOn,
    },
    {
      id: "bw.film",
      name: "Film (black and white)",
      about: "Develops the conversion as a black and white film stock, with its filter and development.",
      area: "develop",
      kind: "control",
      via: [...via, "bw.treatment"],
      target: () => sel("bw-film"),
      done: { kind: "click" },
      chapter,
      nodeType: "heeler.black_white",
      feature: "Film",
      present: monoOn,
    },
    // The filter and the Infrared fold (2026-09-29: a follow-up "how do I
    // simulate infrared?" answered with Film, the filter and the Infrared
    // dials, which had no stops, and the tour was dropped).
    {
      id: "bw.filter",
      name: "Filter (black and white)",
      about: "The filter in front of the film: yellow, orange, red or green darken and lighten colors as on film, and the 720 and 850 filters make it infrared.",
      area: "develop",
      kind: "control",
      via: [...via, "bw.treatment"],
      target: () => sel("bw-filter"),
      done: { kind: "state", test: (s, at) => (bwNode(s)?.textParams?.filter ?? "") !== (bwNode(at)?.textParams?.filter ?? "") },
      chapter,
      nodeType: "heeler.black_white",
      feature: "Filter",
      present: monoOn,
    },
    {
      id: "bw.infrared",
      name: "Infrared (black and white)",
      about: "The Infrared fold, open with an infrared film or a 720 or 850 filter: how much foliage lifts and sky, water and skin move, in stops.",
      area: "develop",
      kind: "look",
      via: [...via, "bw.treatment"],
      target: () => sel("bw-infrared"),
      done: { kind: "next" },
      chapter,
      nodeType: "heeler.black_white",
      feature: "Infrared",
      present: infraredOn,
    },
  );
  for (const m of IR_MATERIALS) {
    stops.push({
      id: `bw.infrared.${m.key.replace(/^ir_/, "")}`,
      name: `${m.label} (infrared)`,
      about: `The Infrared fold's ${m.label} dial: ${m.tip.split(":")[0].replace(/^How much/, "how much")}.`,
      area: "develop",
      kind: "control",
      via: [...via, "bw.treatment"],
      target: () => [`${tid("bw-ir-materials")} ${tid(`slider-${m.key}`)}`],
      done: { kind: "state", test: changed(m.key) },
      chapter,
      nodeType: "heeler.black_white",
      feature: "Infrared",
      present: infraredOn,
    });
  }
  return stops;
}

/** Whether the Infrared fold shows: an infrared film on the profile, or
 * an infrared filter (the panel's own test, src/ui/bwcontrols.tsx). */
const infraredOn = (s: State) => {
  const bw = bwNode(s);
  if (!bw || !monoOn(s)) return false;
  const profile = s.nodes.find((n) => n.type === "heeler.tone_profile");
  const film = profile ? (profile.textParams?.film ?? "") : (bw.textParams?.film ?? "");
  return isInfrared(bw.textParams?.filter, film) || isInfrared(bw.textParams?.far_filter, film);
};

function viewerStops(): TourStop[] {
  const chapter = "image-viewport.md";
  const crop = (s: State) => s.nodes.find((n) => n.type === "heeler.crop_rotate");
  const stops: TourStop[] = [
    {
      id: "viewer.crop",
      name: "Crop tool",
      about: "Arms the crop: drag the frame's handles in the viewport, and its ratio sits above the photograph.",
      area: "viewer",
      kind: "control",
      via: ["mode.develop"],
      target: () => sel("btn-tool-crop"),
      done: { kind: "state", test: (s) => s.tool === "crop" },
      chapter,
      way: () => "Arm the crop tool first: click Crop above the photograph.",
    },
    {
      id: "viewer.crop.ratio",
      name: "Crop ratio",
      about: "The ratio the crop holds while dragged: Free, Original, 1:1, 3:2, 16:9 and the rest.",
      area: "viewer",
      kind: "control",
      via: ["mode.develop", "viewer.crop"],
      target: () => sel("crop-aspect"),
      done: { kind: "state", test: (s, at) => s.cropAspect !== at.cropAspect },
      chapter,
      present: (s) => s.tool === "crop",
    },
    {
      id: "viewer.crop.frame",
      name: "Crop frame",
      about: "The crop frame over the photograph: drag its handles or its middle to recompose.",
      area: "viewer",
      kind: "control",
      via: ["mode.develop", "viewer.crop"],
      target: () => sel("crop-rect"),
      done: {
        kind: "state",
        test: (s, at) => {
          const now = crop(s)?.params;
          const was = crop(at)?.params ?? {};
          return !!now && ["crop_x", "crop_y", "crop_w", "crop_h"].some((k) => (now[k] ?? null) !== (was[k] ?? null));
        },
      },
      chapter,
      present: (s) => s.tool === "crop",
    },
    {
      id: "viewer.straighten",
      name: "Straighten tool",
      about: "Arms Straighten: drag along a line that should be level and the photograph turns to match.",
      area: "viewer",
      kind: "control",
      via: ["mode.develop"],
      target: () => sel("btn-tool-straighten"),
      done: { kind: "state", test: (s) => s.tool === "straighten" },
      chapter,
    },
    {
      // Where a brush is used: without it, a model asked for "Alt-click a
      // clean spot, then paint over the dust" borrowed two Exposure sliders
      // for the two steps (measured, the owner's Qwen3, 2026-09-28).
      id: "viewer.photograph",
      name: "The photograph",
      about: "The photograph in the viewer: with a brush in hand, paint on it here; for Clone and Heal, Alt or Option-click a clean spot first to set the source.",
      area: "viewer",
      kind: "look",
      via: [],
      target: () => sel("viewer-stage"),
      done: { kind: "next" },
      chapter,
    },
  ];
  return stops;
}

function menuStops(): TourStop[] {
  const top = (id: string, label: string, about: string, chapter = "menus.md"): TourStop => ({
    id: `menu.${id}`,
    name: `${label} menu`,
    about,
    area: "menus",
    kind: "control",
    via: [],
    target: () => sel(`menu-${id}`),
    done: { kind: "dom", test: (doc) => !!doc.querySelector(tid(`menu-${id}-list`)) },
    chapter,
    way: () => `Open the ${label} menu in the menu bar.`,
  });
  const item = (id: string, testid: string, name: string, about: string, via: string[], done: Done = { kind: "click" }, extra: Partial<TourStop> = {}): TourStop => ({
    id,
    name,
    about,
    area: "menus",
    kind: "control",
    via,
    target: () => sel(testid),
    done,
    chapter: "menus.md",
    ...extra,
  });
  const stops: TourStop[] = [
    top("file", "File", "Opening folders, catalogs and Preferences."),
    top("photo", "Photo", "Crop and straighten, ratings, copy and paste edits, quick export, panoramas and stacks."),
    top("select", "Select", "Selections, Smart Selection and their refinements."),
    top("help", "Help", "The user guide and Find a Control."),
    item("menu.file.open", "menu-file-open", "Open folder", "Adds a folder of photographs to the catalog.", ["menu.file"]),
    item("menu.file.prefs", "menu-file-prefs", "Preferences", "Opens Preferences.", ["menu.file"], { kind: "state", test: (s) => s.prefsOpen }),
    {
      ...item("menu.photo.crop", "menu-photo-crop", "Crop / Straighten", "The Photo menu's crop and straighten tools, and the crop ratios.", ["menu.photo"], { kind: "dom", test: (doc) => !!doc.querySelector(tid("menu-photo-cropinit")) }),
      chapter: "image-viewport.md",
    },
    {
      ...item("menu.photo.ratio", "menu-photo-aspect", "Crop to Aspect Ratio", "Holds the crop to a ratio while you drag it.", ["menu.photo", "menu.photo.crop"], { kind: "dom", test: (doc) => !!doc.querySelector(tid("menu-photo-aspect-free")) }),
      chapter: "image-viewport.md",
    },
    item("menu.photo.copy-edits", "menu-photo-copy-edits", "Copy Edits", "Copies this photograph's edit, to paste on others.", ["menu.photo"]),
    item("menu.photo.paste-edits", "menu-photo-paste-edits", "Paste Edits", "Pastes a copied edit on the selected photographs.", ["menu.photo"]),
    item("menu.select.smart", "menu-select-smart", "Smart Selection", "Selects a thing in the photograph from a click, the subject or the sky.", ["menu.select"], { kind: "click" }, { chapter: "image-viewport.md" }),
    item("menu.help.docs", "menu-help-docs", "User Guide", "Opens the user guide.", ["menu.help"], { kind: "state", test: (s) => s.docsOpen }),
    item("menu.help.find", "menu-help-find", "Find a Control", "Searches every control by name and takes you there.", ["menu.help"], { kind: "state", test: (s) => s.findControlOpen }),
  ];
  for (const [label, ratio] of CROP_RATIOS) {
    stops.push({
      ...item(
        `menu.photo.ratio.${label.replace(":", "-")}`,
        `menu-photo-aspect-${label.replace(":", "-")}`,
        `${label} crop`,
        `Holds the crop to ${label} and arms the crop tool.`,
        ["menu.photo", "menu.photo.crop", "menu.photo.ratio"],
        { kind: "state", test: (s) => s.cropAspect !== null && Math.abs(s.cropAspect - ratio) < 0.001 },
      ),
      chapter: "image-viewport.md",
    });
  }
  return stops;
}

function exportStops(): TourStop[] {
  const chapter = "export.md";
  const settings = (s: State) => s.exportQueue.groups[s.exportQueue.active]?.settings;
  const via = ["export.open"];
  const open = (s: State) => panelShown(s, "export");
  const stops: TourStop[] = [
    {
      id: "export.open",
      name: "Export panel",
      about: "The Export panel on the right edge: format, size, name, folder and the export button.",
      area: "export",
      kind: "place",
      via: [],
      target: () => sel("export-bar"),
      open: (s) => (panelShown(s, "export") ? [] : [{ type: "toggle_export" }]),
      done: { kind: "state", test: (s) => panelShown(s, "export") },
      chapter,
      way: () => "Open the Export panel: click EXPORT on the right edge of the window.",
    },
    {
      id: "export.format",
      name: "Export format",
      about: "The file type: JPEG for sharing, PNG, TIFF, EXR, DNG and the rest for archives and other software.",
      area: "export",
      kind: "control",
      via,
      target: () => sel("export-format"),
      present: open,
      done: { kind: "state", test: (s, at) => settings(s)?.format !== settings(at)?.format },
      chapter,
    },
    {
      id: "export.quality",
      name: "Export quality",
      about: "The JPEG and WebP quality slider.",
      area: "export",
      kind: "control",
      via,
      target: () => sel("export-quality"),
      present: open,
      done: { kind: "state", test: (s, at) => settings(s)?.quality !== settings(at)?.quality },
      chapter,
    },
    {
      id: "export.folder",
      name: "Export folder",
      about: "Where the files are written.",
      area: "export",
      kind: "control",
      via,
      target: () => sel("export-folder"),
      present: open,
      done: { kind: "click" },
      chapter,
    },
    {
      id: "export.run",
      name: "Export button",
      about: "Writes the files with these settings.",
      area: "export",
      kind: "control",
      via,
      target: () => sel("export-run"),
      present: open,
      done: { kind: "click" },
      chapter,
    },
    {
      id: "export.quick",
      name: "Quick Export",
      about: "The title bar's export: one file from the photograph on screen, with the quick settings.",
      area: "export",
      kind: "control",
      via: [],
      target: () => sel("btn-export"),
      done: { kind: "click" },
      chapter,
    },
  ];
  for (const [label, edge] of EXPORT_SIZES) {
    stops.push({
      id: `export.size.${label.toLowerCase()}`,
      name: `Export size ${label}`,
      about: edge ? `Exports at ${label} pixels on the long side.` : "Exports at the photograph's full size.",
      area: "export",
      kind: "control",
      via,
      target: () => sel(`export-size-${label.toLowerCase()}`),
      present: open,
      done: { kind: "state", test: (s) => settings(s)?.maxEdge === edge },
      chapter,
    });
  }
  return stops;
}

/** The Finish panel's add buttons and the toolbar's tools. */
function finishStops(): TourStop[] {
  const via = ["mode.develop", "tab.layers"];
  const added = (s: State, at: State) => artLayers(s).length > artLayers(at).length;
  const adds: [string, string, string, string][] = [
    ["paint", "Pixel layer", "Adds a transparent layer for paint and retouching: Paint, Clone, Heal, Blur and Erase write to it.", "finish/pixel-layer.md"],
    ["smart", "Smart layer", "Adds a layer that finds a thing in the photograph from a click: a subject, the sky, an object. In the Adjustment menu, under Utility.", "finish/smart-layer.md"],
    ["adjust", "Adjustment layer", "Opens the Adjustment menu: a Develop adjustment as a layer of its own, with its own mask, and the Smart and Warp layers under Utility.", "finish/adjustment-layers.md"],
    ["gradient", "Gradient layer", "Adds a gradient layer over the photograph: across the frame, or By tone, which colors the darks, mids and brights.", "finish/gradient-layer.md"],
    ["fill", "Fill layer", "Adds a layer of flat color.", "finish/fill-layer.md"],
    ["warp", "Warp layer", "Adds a layer that bends everything below it with a grid or shapes; its mask picks out what is warped and moves with it. In the Adjustment menu, under Utility.", "finish/warp-layer.md"],
  ];
  // Where each add is on screen (2026-09-30, the toolbar regrouped):
  // Pixel, Gradient and Fill on the split button, whose left half makes
  // the kind it shows and whose arrow lists all three; Smart and Warp in
  // the Adjustment menu's Utility section; every one of them also a row
  // of the list an empty stack shows.
  const adjustOpen = (doc: Document) => !!doc.querySelector(tid("art-adjust-menu"));
  const targetOf = (kind: string) => (s: State): string[] => {
    if (kind === "adjust") return sel("art-add-adjust", "art-empty-adjust");
    if (kind === "smart" || kind === "warp") return sel(`art-empty-${kind}`, `art-utility-${kind}`);
    return s.artContentKind === kind
      ? sel(`art-empty-${kind}`, "art-add-content", `art-content-${kind}`)
      : sel(`art-empty-${kind}`, "art-add-content-more", `art-content-${kind}`);
  };
  const stops: TourStop[] = adds.map(([kind, name, about, chapter]) => ({
    id: `finish.add.${kind}`,
    name,
    about,
    area: "finish",
    kind: "control",
    // Smart and Warp are in the Adjustment menu: the way to them opens it.
    via: kind === "smart" || kind === "warp" ? [...via, "finish.add.adjust"] : via,
    target: targetOf(kind),
    done: kind === "adjust" ? { kind: "dom", test: adjustOpen } : { kind: "state", test: added },
    chapter,
  }));
  stops.push({
    id: "finish.layers",
    name: "Finish layers",
    about: "The layer list: select a layer here before painting on it.",
    area: "finish",
    kind: "look",
    via,
    target: () => sel("art-layers"),
    done: { kind: "next" },
    chapter: "finish/README.md",
  });
  const tools: [string, string, string, (t: State["tool"]) => boolean][] = [
    ["cursor", "Cursor", "Puts the tools away so clicks select layers.", (t) => t === "none"],
    ["shape", "Transform / Warp", "Moves, scales or warps the active layer.", (t) => t === "transform" || t === "warp"],
    ["select", "Select", "Draws a selection with the current method.", (t) => t === "select"],
    ["paint", "Paint", "Paints the current color on the active layer.", (t) => t === "paint"],
    ["dodgeburn", "Dodge / Burn", "Lightens or darkens where you brush.", (t) => t === "dodge" || t === "burn"],
    ["repair", "Clone / Heal", "Paints from a source: Alt or Option-click a clean spot first, then brush over the flaw.", (t) => t === "clone" || t === "heal"],
    ["blur", "Blur / Blend", "Softens or blends what the brush passes over.", (t) => t === "blur" || t === "blend"],
    ["fill", "Fill", "Brush over something to remove it; the model fills the hole.", (t) => t === "fill"],
    ["erase", "Erase", "Takes paint back off the active layer.", (t) => t === "erase"],
  ];
  // The brushes that write to a retouch layer are disabled without one:
  // a tour to them first asks for one, as a step of its own.
  const retouch = (s: State) => {
    const layer = s.artActive ? artFindLayer(s, s.artActive) : undefined;
    return layer?.content.type === "heeler.paint" || layer?.content.type === "heeler.clone";
  };
  stops.push({
    id: "finish.retouch-layer",
    name: "A Pixel layer to retouch on",
    about: "Clone, Heal, Blur, Blend and Erase write to a Pixel layer: add one, or select one in the layer list.",
    area: "finish",
    kind: "control",
    via,
    target: targetOf("paint"),
    done: { kind: "state", test: (s) => retouch(s) },
    chapter: "finish/pixel-layer.md",
    way: () => "These brushes paint on a Pixel layer: add one with the split button at the left of the Finish toolbar (its arrow lists Pixel), or select one in the list.",
  });
  const needsLayer = new Set(["repair", "blur", "erase"]);
  for (const [stem, name, about, on] of tools) {
    stops.push({
      id: `finish.tool.${stem}`,
      name: `${name} tool`,
      about,
      area: "finish",
      kind: "control",
      via: needsLayer.has(stem) ? [...via, "finish.retouch-layer"] : via,
      target: () => sel(`art-tool-${stem}`),
      done: { kind: "state", test: (s) => on(s.tool) },
      chapter: "finish/toolbar.md",
    });
  }
  return stops;
}

function libraryStops(): TourStop[] {
  const chapter = "library.md";
  return [
    {
      id: "library.open",
      name: "Library",
      about: "The Library panel on the left: folders and collections.",
      area: "library",
      kind: "place",
      via: [],
      target: (s) => (panelShown(s, "library") ? sel("browser-panel") : sel("library-bar")),
      open: (s) => (panelShown(s, "library") ? [] : [{ type: "toggle_browser" }]),
      done: { kind: "state", test: (s) => panelShown(s, "library") },
      chapter,
      way: () => "Open the Library: click LIBRARY on the left edge of the window.",
    },
    {
      id: "library.open-folder",
      name: "Open folder",
      about: "Adds a folder of photographs to the catalog; the files stay where they are.",
      area: "library",
      kind: "control",
      via: ["library.open"],
      target: () => sel("open-folder"),
      present: (s) => panelShown(s, "library"),
      done: { kind: "click" },
      chapter,
    },
    {
      id: "library.new-collection",
      name: "New collection",
      about: "Starts a collection: a list of photographs that moves no file.",
      area: "library",
      kind: "control",
      via: ["library.open"],
      target: () => sel("new-collection"),
      present: (s) => panelShown(s, "library"),
      done: { kind: "click" },
      chapter,
    },
    {
      id: "library.filter",
      name: "Filter",
      about: "Narrows the thumbnails by rating, flag, name, tag or date.",
      area: "library",
      kind: "control",
      via: [],
      target: () => sel("filter-open"),
      done: { kind: "click" },
      chapter: "thumbnails.md",
    },
    {
      id: "library.thumbnails",
      name: "Thumbnails",
      about: "The strip of photographs in the folder or collection: click one to open it.",
      area: "library",
      kind: "look",
      via: [],
      target: () => sel("ribbon"),
      done: { kind: "next" },
      chapter: "thumbnails.md",
    },
  ];
}

function preferenceStops(): TourStop[] {
  const stops: TourStop[] = [
    {
      id: "prefs.open",
      name: "Preferences",
      about: "Heeler's settings.",
      area: "preferences",
      kind: "place",
      via: [],
      target: () => sel("menu-file"),
      open: () => [{ type: "open_prefs" }],
      done: { kind: "state", test: (s) => s.prefsOpen },
      chapter: "menus.md",
      way: () => "Open Preferences: File > Preferences.",
    },
  ];
  for (const c of PREFS_CATEGORIES) {
    stops.push({
      id: `prefs.${c.id}`,
      name: `${c.label} preferences`,
      about: `The ${c.label} page of Preferences.`,
      area: "preferences",
      kind: "control",
      via: ["prefs.open"],
      target: () => sel(`prefs-tab-${c.id}`),
      present: (s) => s.prefsOpen,
      done: { kind: "click" },
      chapter: "menus.md",
    });
  }
  return stops;
}

/** The graph's own gestures and places. */
function graphStops(): TourStop[] {
  const via = ["mode.graph"];
  const chapter = "graph/canvas.md";
  const refs = (s: State, step: StepRefs, key: "from" | "to") => {
    const stop = step[key] ? STOP_BY_ID.get(step[key]!) : undefined;
    return stop ? stop.target(s, {}) : [];
  };
  return [
    {
      id: "graph.canvas",
      name: "Graph canvas",
      about: "The node graph: every card is an operation, every wire carries a picture or a mask from left to right.",
      area: "graph",
      kind: "look",
      via,
      target: () => sel("graph-surface"),
      done: { kind: "next" },
      chapter: "graph/README.md",
    },
    {
      id: "graph.add",
      name: "Add node (Find a Node...)",
      about: "Opens the node palette to add a node: type a few letters of its name, or browse (press Shift+Space or click the add node button, the + at the top of the graph's left toolbar; Node > Find a Node... and the canvas menu's Find a Node... open it too). The Node menu and the graph's right-click Add menu also list every node by its full path, category > section > node, such as Masking > Mask Tools > Morphology.",
      area: "graph",
      kind: "place",
      via,
      target: (s) => (s.palette ? sel("palette-search") : sel("palette-add")),
      open: (s) => (s.palette ? [] : [{ type: "open_palette", x: 260, y: 180 }]),
      done: { kind: "state", test: (s) => !!s.palette },
      chapter,
      // Both ways, every run, whatever the model wrote (2026-09-29: "The
      // second time I tried this it did not ask me to use SHIFT + SPACE").
      // Canvas draws no left toolbar over the photograph.
      way: (s) => `Open the node palette: ${addNodeWays(s)}`,
      how: (s) => addNodeWays(s).replace(/^p/, "P"),
    },
    {
      id: "graph.find",
      name: "Search the graph",
      about: "Selects nodes already in the graph by name (press /); it adds nothing (to add a node, use graph.add).",
      area: "graph",
      kind: "place",
      via,
      target: (s) => (s.graphSearchOpen ? sel("graph-search-input") : sel("graph-surface")),
      open: (s) => (s.graphSearchOpen ? [] : [{ type: "toggle_graph_search", open: true }]),
      done: { kind: "state", test: (s) => s.graphSearchOpen },
      chapter,
    },
    {
      id: "graph.connect",
      name: "Connect two ports",
      about: "Drag from an output port to an input port: the wire carries the picture or the mask along. Give from (an output port stop) and to (an input port stop).",
      area: "graph",
      kind: "control",
      via,
      needs: ["from", "to"],
      target: (s, step) => [...refs(s, step, "from"), ...refs(s, step, "to")],
      done: { kind: "state", test: (s, at, step) => wireMade(s, at, step) },
      chapter,
    },
    {
      id: "graph.disconnect",
      name: "Disconnect a wire",
      about: "Drag from an input port out to empty canvas: its wire comes off. Give to (the input port stop).",
      area: "graph",
      kind: "control",
      via,
      needs: ["to"],
      target: (s, step) => refs(s, step, "to"),
      done: { kind: "state", test: (s, at, step) => wireRemoved(s, at, step) },
      chapter,
    },
    {
      id: "graph.splice",
      name: "Drop a node on a wire",
      about: "Drag a node onto a wire between two others and drop it: it splices in and its neighbors reconnect through it. Give from (the node's card stop).",
      area: "graph",
      kind: "control",
      via,
      needs: ["from"],
      target: (s, step) => refs(s, step, "from"),
      done: { kind: "state", test: (s, at, step) => spliced(s, at, step) },
      chapter,
    },
    {
      id: "graph.menu",
      name: "Graph context menu",
      about: "Right-click the canvas or a selection: grouping, backdrops, duplicate, arrange.",
      area: "graph",
      kind: "control",
      via,
      target: () => sel("graph-surface"),
      done: { kind: "dom", test: (doc) => !!doc.querySelector(tid("context-menu")) },
      chapter,
      way: () => "Right-click the graph canvas to open its menu.",
    },
    {
      id: "graph.group",
      name: "Save selection as group",
      about: "Makes the selected nodes (two or more) one group card with a name; its wires stay inside.",
      area: "graph",
      kind: "control",
      via: [...via, "graph.menu"],
      target: () => sel("menu-save-group"),
      done: { kind: "state", test: (s, at) => s.groupDialogOpen || graphScope(s).nodes.filter((n) => n.isGroup).length > graphScope(at).nodes.filter((n) => n.isGroup).length },
      chapter: "graph/groups-popout.md",
    },
    {
      id: "graph.group.open",
      name: "Open a group",
      about: "Double-click a group card to see and change the nodes inside it.",
      area: "graph",
      kind: "control",
      via,
      target: (s) => {
        const g = graphScope(s).nodes.filter((n) => n.isGroup).pop();
        return g ? sel(`node-${g.id}`) : [];
      },
      done: { kind: "state", test: (s) => s.openedGroup !== null },
      chapter: "graph/groups-popout.md",
      present: (s) => graphScope(s).nodes.some((n) => n.isGroup),
    },
    {
      id: "graph.group.leave",
      name: "Leave the group",
      about: "Returns from inside a group to the graph around it.",
      area: "graph",
      kind: "control",
      via,
      target: () => sel("leave-group"),
      done: { kind: "state", test: (s) => s.openedGroup === null },
      chapter: "graph/groups-popout.md",
      present: (s) => s.openedGroup !== null,
    },
    {
      id: "graph.backdrop",
      name: "Add backdrop",
      about: "Puts a labeled colored rectangle behind nodes to organize them; it changes nothing in the picture.",
      area: "graph",
      kind: "control",
      via: [...via, "graph.menu"],
      target: () => sel("menu-add-backdrop"),
      done: { kind: "state", test: (s, at) => s.backdrops.length > at.backdrops.length },
      chapter: "graph/groups-popout.md",
    },
    {
      id: "graph.arrange",
      name: "Auto-arrange",
      about: "Lays the nodes out left to right so wires do not double back.",
      area: "graph",
      kind: "control",
      via: [...via, "graph.menu"],
      target: () => sel("menu-arrange"),
      done: { kind: "click" },
      chapter: "graph/groups-popout.md",
    },
    {
      id: "graph.inspector",
      name: "Inspector",
      about: "The selected node's controls, its switch, reset and note.",
      area: "graph",
      kind: "look",
      via,
      target: () => sel("inspector"),
      done: { kind: "next" },
      chapter: "graph/inspector.md",
    },
    {
      id: "graph.inspector.controls",
      name: "Node controls",
      about: "The selected node's dials in the Inspector: move one to change what the node does.",
      area: "graph",
      kind: "control",
      via,
      target: () => [`${tid("inspector")} ${tid("node-params")}`, tid("inspector")],
      done: {
        kind: "state",
        test: (s, at) => {
          const id = s.selection[0];
          const now = graphScope(s).nodes.find((n) => n.id === id);
          const was = graphScope(at).nodes.find((n) => n.id === id);
          return !!now && !!was && JSON.stringify(now.params) !== JSON.stringify(was.params);
        },
      },
      chapter: "graph/inspector.md",
    },
    {
      id: "graph.inspector.enable",
      name: "Node switch",
      about: "Bypasses the selected node or brings it back (D does the same).",
      area: "graph",
      kind: "control",
      via,
      target: () => sel("inspector-enable"),
      done: {
        kind: "state",
        test: (s, at) => {
          const id = s.selection[0];
          const now = graphScope(s).nodes.find((n) => n.id === id);
          const was = graphScope(at).nodes.find((n) => n.id === id);
          return !!now && !!was && now.enabled !== was.enabled;
        },
      },
      chapter: "graph/inspector.md",
    },
    {
      id: "graph.popout",
      name: "Pop out the graph",
      about: "Gives the graph its own window; its dock icon puts it back.",
      area: "graph",
      kind: "control",
      via,
      target: () => sel("graph-popout"),
      done: { kind: "click" },
      chapter: "graph/groups-popout.md",
    },
  ];
}

/** Every node type the palette offers: adding it, its card, and each
 * of its ports. */
function nodeStops(): TourStop[] {
  const out: TourStop[] = [];
  for (const spec of NODE_CATALOG) {
    if (RETIRED_TYPES.has(spec.type)) continue;
    const slug = nodeSlug(spec.type);
    const chapter = nodeChapter(spec);
    const fixed = spec.type === "heeler.image_source" || spec.type === "heeler.output";
    if (!fixed) {
      out.push({
        id: `graph.add.${slug}`,
        name: `Add ${spec.name}`,
        about: `Adds a ${spec.name} node (in the menus: ${nodeMenuPath(spec.type)}): ${spec.blurb.charAt(0).toLowerCase()}${spec.blurb.slice(1)}.`,
        area: "graph",
        kind: "control",
        via: ["mode.graph", "graph.add"],
        // Where it is, whole, on every add step whatever the model wrote
        // (2026-10-01: the steps named the menus as they were before the
        // sections).
        how: () => addNodeHow(spec),
        target: (s) => (s.palette ? [tid(`palette-item-${spec.type}`), tid("palette-search")] : []),
        done: { kind: "state", test: (s, at) => countOf(s, spec.type) > countOf(at, spec.type) },
        chapter,
        nodeType: spec.type,
      });
    }
    out.push({
      id: `node.${slug}`,
      name: `${spec.name} node`,
      about: `The ${spec.name} card: click it to select it and see its controls in the Inspector.`,
      area: "graph",
      kind: "control",
      via: ["mode.graph"],
      target: (s) => {
        const n = instanceOf(s, spec.type);
        return n ? sel(`node-${n.id}`) : [];
      },
      done: {
        kind: "state",
        test: (s) => {
          const n = instanceOf(s, spec.type);
          return !!n && s.selection.includes(n.id);
        },
      },
      chapter,
      nodeType: spec.type,
      present: (s) => !!instanceOf(s, spec.type),
    });
    for (const seat of seatsOf(spec.type)) {
      const dir = INPUT_SEATS.has(seat) ? "in" : "out";
      const kind = seatKind(spec.type, seat);
      out.push({
        id: `port.${slug}.${SEAT_ID[seat]}`,
        name: `${spec.name}.${portName(spec.type, seat)}`,
        about: `${dir === "in" ? "Input" : "Output"} port, ${kind === "image" ? "a picture (rgb)" : "a mask or field (alpha)"}: ${firstSentence(portData(spec.type, seat))}`,
        area: "graph",
        kind: "look",
        via: ["mode.graph"],
        target: (s) => {
          const n = instanceOf(s, spec.type);
          return n ? sel(portTestId(seat, n.id)) : [];
        },
        done: { kind: "next" },
        chapter,
        nodeType: spec.type,
        port: { seat, dir, kind },
        present: (s) => {
          const n = instanceOf(s, spec.type);
          return !!n && drawsSeat(n, seat);
        },
      });
    }
  }
  return out;
}

// -- the graph's completions -------------------------------------------------------

const wireKey = (w: Wire) => `${w.from}|${w.fromPort ?? ""}|${w.to}|${w.toPort}`;

function portStop(id: string | undefined): TourStop | undefined {
  const stop = id ? STOP_BY_ID.get(id) : undefined;
  return stop?.port && stop.nodeType ? stop : undefined;
}

/** The wires that match a connect step's two ports, by node type. */
function matchingWires(s: State, step: StepRefs): Wire[] {
  const from = portStop(step.from);
  const to = portStop(step.to);
  if (!from || !to) return [];
  const { nodes, wires } = graphScope(s);
  const typeOf = new Map(nodes.map((n) => [n.id, Object.keys(GROUP_TOOL).find((k) => isOfType(n, k)) ?? n.type]));
  const toPort = wirePort(to.port!.seat);
  const fromPort = wireFromPort(from.nodeType!, from.port!.seat);
  return wires.filter(
    (w) =>
      typeOf.get(w.from) === from.nodeType &&
      typeOf.get(w.to) === to.nodeType &&
      w.toPort === toPort &&
      (fromPort === "any" || (w.fromPort ?? undefined) === fromPort || (fromPort === undefined && w.fromPort === "image")),
  );
}

export function wireMade(s: State, at: State, step: StepRefs): boolean {
  const before = new Set(matchingWires(at, step).map(wireKey));
  return matchingWires(s, step).some((w) => !before.has(wireKey(w)));
}

export function wireRemoved(s: State, at: State, step: StepRefs): boolean {
  const to = portStop(step.to);
  if (!to) return false;
  const fed = (st: State) => {
    const n = instanceOf(st, to.nodeType!);
    const port = wirePort(to.port!.seat);
    return !!n && graphScope(st).wires.some((w) => w.to === n.id && w.toPort === port);
  };
  return fed(at) && !fed(s);
}

export function spliced(s: State, at: State, step: StepRefs): boolean {
  const card = step.from ? STOP_BY_ID.get(step.from) : undefined;
  if (!card?.nodeType) return false;
  const joined = (st: State) => {
    const n = instanceOf(st, card.nodeType!);
    if (!n) return false;
    const { wires } = graphScope(st);
    return wires.some((w) => w.to === n.id) && wires.some((w) => w.from === n.id);
  };
  return joined(s) && !joined(at);
}

// -- the whole list --------------------------------------------------------------

export const TOUR_STOPS: TourStop[] = [
  ...modeStops(),
  ...tabStops(),
  ...sectionStops(),
  ...widgetStops(),
  ...blackWhiteStops(),
  ...viewerStops(),
  ...menuStops(),
  ...exportStops(),
  ...finishStops(),
  ...libraryStops(),
  ...preferenceStops(),
  ...graphStops(),
  ...nodeStops(),
];

export const STOP_BY_ID = new Map(TOUR_STOPS.map((s) => [s.id, s]));

export function stopById(id: string): TourStop | undefined {
  return STOP_BY_ID.get(id);
}

/** Whether a port may feed another: an output into an input of the same
 * kind (a picture into a picture input, a field into a mask input). */
export function portsConnect(from: TourStop | undefined, to: TourStop | undefined): boolean {
  return !!from?.port && !!to?.port && from.port.dir === "out" && to.port.dir === "in" && from.port.kind === to.port.kind;
}
