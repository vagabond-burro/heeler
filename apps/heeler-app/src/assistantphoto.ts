// What the assistant is told about the open photograph (src/assistant.ts,
// PhotoFacts): whether it is in color or converted to black and white,
// which Develop sections and Finish layers are on, by name, and the
// file's type. Read in the main window, which holds the
// edit, and sent to the Console with the assistant's settings. Nothing
// else is read: no pixels, no file name or path, no catalog data, no
// metadata. Also where the user is (whereFactsOf): the workspace, the
// tab, the layer, the tool and the selected nodes' types and names,
// read when a question is asked.

import type { PhotoFacts, SelectedNode, WhereFacts, Workspace } from "./assistant";
import { NODE_CATALOG } from "./nodes";
import { nodeChapter } from "./tourstops";
import { artLayers, LAYER_TOOLS, layersOf, mainConversion, PANEL_TABS, type NodeCard, type State } from "./state";
import { SECTIONS, sectionIsOn } from "./ui/simple";

// -- where the user is ------------------------------------------------------------

const WORKSPACE_OF: Record<State["mode"], Workspace> = { simple: "Develop", advanced: "Graph", canvas: "Canvas" };

/** The viewer's tools by the names the guide and the toolbars give
 * them. */
export const TOOL_NAMES: Record<Exclude<State["tool"], "none">, string> = {
  crop: "Crop",
  straighten: "Straighten",
  gridwarp: "Grid Warp",
  shapewarp: "Shape Warp",
  brush: "Brush (painting a layer's mask)",
  pick: "Pick (sampling a color or tone from the photograph)",
  select: "Select (making a selection)",
  polish: "Polish Selection (refining a selection's edge)",
  smart: "Smart Selection (Click)",
  object: "Object mask pick",
  fill: "Fill brush",
  transform: "Transform (a Finish layer)",
  warp: "Warp (a Finish layer's corners)",
  paint: "Paint",
  erase: "Erase",
  clone: "Clone",
  heal: "Heal",
  dodge: "Dodge",
  burn: "Burn",
  blur: "Blur brush",
  blend: "Blend brush",
};

/** A card's kind: the node reference's name for its type, a tool
 * group's own (Sharpening, Skin Softening), or Group. */
function kindOf(n: NodeCard): string {
  if (n.isGroup && n.tool && LAYER_TOOLS[n.tool]) return LAYER_TOOLS[n.tool].name;
  const spec = NODE_CATALOG.find((x) => x.type === n.type);
  if (spec) return spec.name;
  return n.isGroup ? "Group" : n.type.replace(/^heeler\./, "");
}

/** Where the user is in Heeler, for the assistant (src/assistant.ts,
 * WhereFacts): the workspace; in Develop the right panel's tab and the
 * layer it is working on; in Graph and Canvas the selected nodes by
 * type and name, never their values, and the open group; the viewer
 * tool in hand. View state only, read when a question is asked. */
export function whereFactsOf(s: State): WhereFacts {
  const workspace = WORKSPACE_OF[s.mode] ?? "Develop";
  const tool = s.tool !== "none" ? TOOL_NAMES[s.tool] ?? s.tool : undefined;
  if (workspace === "Develop") {
    const tab = PANEL_TABS.find((t) => t.id === s.panelTab);
    let layer: string | undefined;
    if (s.panelTab === "adjust") {
      const adj = s.activeLayer ? layersOf(s).find((l) => l.id === s.activeLayer) : undefined;
      layer = adj ? `the adjustment layer "${adj.name.slice(0, 40)}" (edits behind its mask)` : "Base (the whole photograph)";
    } else if (s.panelTab === "layers") {
      const art = s.artActive ? artLayers(s).find((l) => l.blend.id === s.artActive) : undefined;
      layer = art ? `the Finish layer "${art.blend.name.slice(0, 40)}"` : "none selected";
    }
    return { workspace, ...(tab ? { tab: tab.label } : {}), ...(layer ? { layer } : {}), ...(tool ? { tool } : {}) };
  }
  const group = s.openedGroup ? s.nodes.find((n) => n.id === s.openedGroup) : undefined;
  const scope = group?.groupNodes ?? s.nodes;
  const selected: SelectedNode[] = scope
    .filter((n) => s.selection.includes(n.id))
    .map((n) => {
      const kind = kindOf(n);
      const spec = NODE_CATALOG.find((x) => x.type === n.type) ?? NODE_CATALOG.find((x) => x.name === kind);
      return { kind, type: n.type, ...(n.name && n.name !== kind ? { name: n.name } : {}), ...(spec ? { ref: nodeChapter(spec) } : {}) };
    });
  return {
    workspace,
    ...(selected.length ? { selected } : {}),
    ...(group ? { group: group.name || kindOf(group) } : {}),
    ...(tool ? { tool } : {}),
  };
}

/** The facts for the photograph on screen, or null with none open. */
export function photoFactsOf(s: State): PhotoFacts | null {
  const image = s.images.find((i) => i.id === s.activeImage);
  if (!image) return null;
  const ext = /\.([A-Za-z0-9]{1,8})$/.exec(image.name)?.[1] ?? "";
  // The base chain's sections, whichever Develop layer is selected: a
  // section reads its active layer's tool otherwise.
  const base: State = s.activeLayer ? { ...s, activeLayer: null } : s;
  const conversion = mainConversion(s.nodes);
  const mono = !!conversion && conversion.enabled && (conversion.params.amount ?? 0) > 0;
  return {
    fileType: ext.toUpperCase(),
    mono,
    develop: SECTIONS.filter((sec) => !sec.hideToggle && sectionIsOn(base, sec)).map((sec) => sec.title),
    finish: artLayers(s).filter((l) => l.blend.enabled).map((l) => l.blend.name),
  };
}
