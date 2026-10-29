// Which button a press on the canvas or the graph belongs to.
//
// (2026-09-30): "I noticed middle mouse button is painting a stroke,
// this makes panning around with a mouse problematic." The viewer and
// the graph pan on a middle-drag (useViewportNav, a native listener on
// the stage), but every tool on top of the stage had its own press
// handler, and the brush's never asked which button went down: a middle
// press panned AND laid down a stroke. Some handlers checked `button`,
// some did not, and nothing stopped the next one from forgetting.
//
// So there is one rule, here, and every press handler on the canvas and
// in the graph starts with it (a static test in pointerguard.test.tsx
// scans the source and fails on a handler that does not):
//
//   * the primary button (a mouse's left button, a pen's tip, a touch)
//     is the only press that starts a tool action: a stroke, a gizmo
//     drag, a lasso or marquee, a picker click, a node or wire drag;
//   * the middle button always pans, whatever tool is armed;
//   * the right button keeps its context menu and never paints.

import { useRef } from "react";

/** The fields of a mouse or pointer event the rule reads. */
type Press = { button: number; buttons?: number };

/** Whether this press may start a tool action.
 *
 * The primary button, and only on its own: a left press while the
 * middle button is already down (a chord in the middle of a pan) is
 * still the pan's, so it must not turn into a stroke under the moving
 * picture. `buttons` is the set held right now; a real press of the
 * primary alone reads 1, and a synthetic event that leaves it out reads
 * 0, both of which are the primary alone. */
export function isPrimaryPress(e: Press): boolean {
  if (e.button !== 0) return false;
  const held = e.buttons ?? 0;
  return (held & ~1) === 0;
}

/** Whether the primary button is still down on a move. A stroke or a
 * drag that started on the primary ends on the first move that no
 * longer carries it: the release happened somewhere this element never
 * heard (off the window, over a menu), and following the hover after
 * that would paint with no button down. */
export function primaryHeld(e: { buttons: number }): boolean {
  return (e.buttons & 1) === 1;
}

/** Whether the primary button held on a move was pressed on this
 * element. A control that follows a held button must ask, not only
 * whether the button is down: a drag that began elsewhere and crosses
 * it (the straighten line, a crop edge or a brush stroke carried off the
 * canvas, which the window now follows) holds the button too, and a
 * slider in the panel took that drag for its own and moved (2026-10-29:
 * "when I dragged outside of the canvas the image shifted its color
 * tone", the line crossing the Color panel's Temp). `press` on the
 * element's own primary press; the release anywhere ends it. */
export function usePressedHere(): { press: () => void; held: (e: { buttons: number }) => boolean } {
  const down = useRef(false);
  const press = () => {
    if (down.current) return;
    down.current = true;
    const up = () => {
      down.current = false;
      window.removeEventListener("mouseup", up, true);
      window.removeEventListener("pointerup", up, true);
      window.removeEventListener("blur", up);
    };
    window.addEventListener("mouseup", up, true);
    window.addEventListener("pointerup", up, true);
    window.addEventListener("blur", up);
  };
  return { press, held: (e) => down.current && primaryHeld(e) };
}
