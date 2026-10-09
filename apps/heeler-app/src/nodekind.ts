// What kind of node a card is, in words, whatever its name says.
//
// 2026-09-30: "when you rename a node its not clear the node type... The
// label under the name should be {CATEGORY}/{TYPE} so no matter what a
// node gets renamed to, we can always tell what type it is." An Export
// Layer made from a pixel layer takes the layer's name ("Pixel 1"), and
// "Utility node" under it said nothing about what it does.
//
// Then, 2026-10-01: "the node type label should be updated with
// {CATEGORY}/{SUB CATEGORY}/{TYPE}", and, seeing it at 115% app zoom run
// off the Inspector's edge, "or, just show the node type and on mouse
// hover the tooltip shows the location", and then that the location show
// in the status line like every other hover. So the line shows the type
// alone (nodeKindLabel) and its hover the whole place the palette lists
// it (nodeKindLocation): Source / Geometry / Displacement Map.
//
// One helper so every place that prints the kind (the Inspector header,
// the multiple-selection list, the popped-out graph's Inspector, which
// is the same component) reads the same words, taken from the palette:
// the category and section as the add menus name them and the type as
// the palette lists it.

import { BUILTIN_RECIPES, type NodeRecipe } from "./noderecipes";
import { CATEGORY_LABEL, NODE_SECTION, sectionOf, specFor } from "./nodes";
import { LAYER_TOOLS, type NodeCard } from "./state";

export interface NodeKind {
  /** the palette category whose add menu lists it ("Source",
   * "Utility"), or "Group" for any group. A palette type answers with
   * its menu section's category, which is not always its card's
   * stripe: Transform wears Utility's blue and is listed under Source. */
  category: string;
  /** the menu section inside that category ("Geometry", "Mask Tools");
   * empty for a group and for a type no section lists (internal or
   * retired types) */
  section: string;
  /** the type's display name as the palette lists it ("Export Layer");
   * for a group, the tool or recipe it came from, empty for a plain
   * group the person made by hand */
  type: string;
}

type KindOf = Pick<NodeCard, "type" | "cat" | "isGroup" | "tool" | "recipe">;

/** "heeler.layer_warp_mask" to "Layer Warp Mask": the last resort for an
 * engine type the palette does not list (internal or retired), so the
 * line is never blank. */
function humanize(type: string): string {
  const tail = type.includes(".") ? type.slice(type.lastIndexOf(".") + 1) : type;
  return tail
    .split(/[_\s]+/)
    .filter(Boolean)
    .map((w) => w[0].toUpperCase() + w.slice(1))
    .join(" ");
}

const isGroupCard = (node: KindOf) => !!node.isGroup || node.type === "heeler.group";

export function nodeKind(node: KindOf, userRecipes: readonly NodeRecipe[] = []): NodeKind {
  if (isGroupCard(node)) {
    const tool = node.tool ? LAYER_TOOLS[node.tool]?.name : undefined;
    const recipe = node.recipe
      ? [...BUILTIN_RECIPES, ...userRecipes].find((r) => r.id === node.recipe || r.aliases?.includes(node.recipe!))?.name
      : undefined;
    return { category: CATEGORY_LABEL.group, section: "", type: tool ?? recipe ?? "" };
  }
  const spec = specFor(node.type);
  if (!spec) {
    // A type the palette does not list keeps its card's category.
    return { category: CATEGORY_LABEL[node.cat] ?? humanize(node.cat ?? ""), section: "", type: humanize(node.type) };
  }
  // The menu the palette lists it in (2026-10-01: the long categories
  // were split into sections): Source > Geometry. A palette type no
  // section names (sectionOf's fallback) has no middle part.
  const sec = sectionOf(spec);
  return {
    category: CATEGORY_LABEL[sec.family],
    section: NODE_SECTION[spec.type] ? sec.label : "",
    type: spec.name,
  };
}

/** The words on the line under a node's name: the type alone
 * ("Displacement Map"), because the whole location ran off the edge of
 * a narrow Inspector. A group keeps its form: "Group / Frequency
 * Separation", or "Group" for a plain one. Shown in the uppercase
 * kicker style, so it reads DISPLACEMENT MAP. */
export function nodeKindLabel(node: KindOf, userRecipes: readonly NodeRecipe[] = []): string {
  const k = nodeKind(node, userRecipes);
  if (isGroupCard(node)) return k.type ? `${k.category} / ${k.type}` : k.category;
  return k.type;
}

/** Where the palette lists it, for the line's hover: "Source / Geometry
 * / Displacement Map", "Category / Type" for a type no section lists,
 * and a group's own label. */
export function nodeKindLocation(node: KindOf, userRecipes: readonly NodeRecipe[] = []): string {
  const k = nodeKind(node, userRecipes);
  return [k.category, k.section, k.type].filter(Boolean).join(" / ");
}
