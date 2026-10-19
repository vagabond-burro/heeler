// mattetool.tsx's values and helpers that are not components, kept apart so
// mattetool.tsx exports components alone and Vite can refresh it in place as
// it is edited instead of reloading the window.
import type { State } from "../state";
import { artMaskNode } from "../state";
import { maskOfLayer } from "../layerids";

/** The object mask in hand: the active Develop layer's, the active
 * Finish layer's (art masks hang off the group boundary as
 * art_m_<id> nodes, the same candidate activeSmartMask carries), or
 * a directly selected one, so the panel and the pick tool follow the
 * user across every surface. */
export function activeMatteMask(s: State) {
  const candidates = [
    s.activeLayer ? maskOfLayer(s.activeLayer) : undefined,
    s.artActive ? `art_m_${s.artActive}` : undefined,
    ...s.selection,
  ];
  for (const id of candidates) {
    if (!id) continue;
    const node = artMaskNode(s, id);
    if (node?.type === "heeler.matte_mask") return node;
  }
  return undefined;
}

/** The names a mask has chosen, out of its JSON recipe. */
export function matteNames(node: { textParams?: Record<string, string> }): string[] {
  try {
    const cur: unknown = JSON.parse(node.textParams?.names ?? "[]");
    return Array.isArray(cur) ? cur.filter((n): n is string => typeof n === "string") : [];
  } catch {
    return [];
  }
}

/** The layer's short label for the picker: a 3D renderer's
 * `ViewLayer.CryptoObject` reads as "Object", `uCryptoMaterial` as
 * "Material"; anything else keeps its own name. */
export function layerLabel(layer: string): string {
  const leaf = layer.split(".").pop() ?? layer;
  const m = /crypto(\w+)$/i.exec(leaf);
  return m ? m[1] : leaf;
}
