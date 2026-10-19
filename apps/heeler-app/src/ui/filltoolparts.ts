// filltool.tsx's values and helpers that are not components, kept apart so
// filltool.tsx exports components alone and Vite can refresh it in place as
// it is edited instead of reloading the window.
import { artLayers, type State } from "../state";

/** Every Fill layer in the stack: blend id, content (inpaint) id, and
 * the stroke mask's id. */
export function fillLayers(s: State): { blendId: string; contentId: string; maskId: string }[] {
  return artLayers(s)
    .filter((l) => l.content.type === "heeler.inpaint")
    .map((l) => ({ blendId: l.blend.id, contentId: l.content.id, maskId: `art_m_${l.blend.id}` }));
}

/** The active Fill layer, when the active Finish layer is one. */
export function activeFillLayer(s: State) {
  return fillLayers(s).find((l) => l.blendId === s.artActive);
}
