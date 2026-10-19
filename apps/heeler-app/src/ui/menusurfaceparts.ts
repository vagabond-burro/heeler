// menusurface.tsx's values and helpers that are not components, kept apart so
// menusurface.tsx exports components alone and Vite can refresh it in place as
// it is edited instead of reloading the window.
import { clipBox, pxBox } from "./hooks";

/** The gap a submenu keeps from the edge of the room it has. */
export const PAD = 6;

/** Places a submenu beside the row that opened it, inside the room it
 * has: the window cut by every ancestor that clips (the graph's surface
 * clips its context menu), all measured by pxBox and clipBox, so a menu
 * inside a `.ui-zoom` box (the menubar) is measured by offsets rather
 * than by client rects (the ui-zoom trap).
 *
 * It opens to the right, or to the left when the right has no room. A
 * list taller than the room scrolls rather than losing its tail
 * (2026-10-01: "I can see someone with a small window layout not
 * seeing all the nodes"); `scroll` is off for lists whose rows are
 * themselves flyouts, which a scrolling list would clip.
 *
 * `fixed` pins the list to the window instead of its row: no ancestor's
 * overflow clips a fixed box, so its room is the whole window and the
 * list it hangs from may scroll without cutting it away. Only for menus
 * outside every CSS zoom (the graph's, portaled to the body), where
 * window pixels are its CSS pixels. Exported for the tests. */
export function placeSubmenu(root: HTMLElement, scroll: boolean, fixed = false): void {
  const anchor = root.parentElement;
  if (!anchor) return;
  const a = pxBox(anchor);
  const z = a.z || 1;
  const c = fixed
    ? { top: 0, left: 0, bottom: window.innerHeight, right: window.innerWidth }
    : clipBox(root);
  if (fixed) root.style.position = "fixed";
  root.style.maxHeight = "";
  root.style.overflowY = "";
  const room = Math.max(0, c.bottom - c.top - 2 * PAD);
  let h = root.offsetHeight * z;
  if (scroll && h > room) {
    root.style.maxHeight = `${room / z}px`;
    root.style.overflowY = "auto";
    h = Math.min(h, room);
  }
  const w = root.offsetWidth * z;
  const x = a.right + w > c.right - PAD ? Math.max(c.left + PAD, a.left - w) : a.right;
  const y = Math.max(c.top + PAD, Math.min(a.top, c.bottom - h - PAD));
  // Fixed: window pixels over the zoom. Otherwise left and top are in
  // the anchor's CSS units, which wear its zoom.
  root.style.left = `${(fixed ? x : x - a.left) / z}px`;
  root.style.top = `${(fixed ? y : y - a.top) / z}px`;
}
