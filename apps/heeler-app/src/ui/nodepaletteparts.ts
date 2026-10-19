// nodepalette.tsx's values and helpers that are not components, kept apart so
// nodepalette.tsx exports components alone and Vite can refresh it in place as
// it is edited instead of reloading the window.
import type { Category } from "../state";
import { NODE_CATALOG, byName, searchNodes, specFor, type NodeSpec } from "../nodes";
import { BUILTIN_RECIPES, searchRecipes, type NodeRecipe } from "../noderecipes";

/** How many recent nodes the shortlist holds. A preference, because five
 * is right for someone with three habits and twenty for someone with a
 * lot of them. */
export const RECENTS_MIN = 5;

export const RECENTS_MAX = 20;

export const RECENTS_DEFAULT = 10;

export function clampRecents(n: number): number {
  if (!Number.isFinite(n)) return RECENTS_DEFAULT;
  return Math.min(RECENTS_MAX, Math.max(RECENTS_MIN, Math.round(n)));
}

/** What the palette shows: matches while typing, recents when not.
 *
 * Split out so the ordering is testable without a keyboard. The recents
 * shortlist falls back to the catalog's own order when there is no
 * history, because an empty palette on first use looks broken.
 */
export function paletteItems(query: string, recents: string[], limit: number, cat?: Category): NodeSpec[] {
  // Opened from a legend glyph: that category, the whole of it, in
  // catalog order; a search still searches everything, since typing is
  // a stronger statement than the glyph was.
  if (cat) {
    const within = byName(NODE_CATALOG.filter((s) => s.cat === cat));
    return query.trim() ? searchNodes(query).filter((s) => s.cat === cat) : within;
  }
  if (query.trim()) return searchNodes(query);
  const known = recents.map(specFor).filter((s): s is NodeSpec => !!s);
  if (known.length >= limit) return known.slice(0, limit);
  // Recents keep their recency; what fills the list after them reads
  // alphabetically, like the menus.
  const rest = byName(NODE_CATALOG.filter((s) => !known.some((k) => k.type === s.type)));
  return [...known, ...rest].slice(0, limit);
}

/** The palette's Recipes section (node recipes, 2026-09-30): every
 * built-in and every recipe this person saved, matched by the same
 * query, under the nodes. A legend glyph's category view is about
 * nodes, so it lists none. */
export function paletteRecipes(query: string, userRecipes: readonly NodeRecipe[], cat?: Category): NodeRecipe[] {
  if (cat) return [];
  return searchRecipes([...BUILTIN_RECIPES, ...userRecipes], query);
}
