// Keeping a pop-up menu inside the window.
//
// "When right clicking on the right mode tab, the split popup is
// cutoff."
//
// A context menu opens at the pointer, which is fine everywhere except
// against an edge, and the right panel's tabs are as far right as the
// window goes: a 208 pixel menu opening at the pointer there has nowhere
// to go but off the screen. Same story vertically for a long menu opened
// near the bottom.
//
// So it flips rather than slides where it can. Sliding a menu left until it
// fits leaves it sitting under the pointer with the wrong item beneath the
// cursor; opening it to the left of the pointer instead is what every
// desktop menu does at a right edge, and it keeps the corner nearest the
// click where the click was.

export interface MenuBox {
  x: number;
  y: number;
}

/** Where to put a menu of a given size so all of it is visible.
 *
 * `pad` keeps it off the very edge, since a menu flush against the frame
 * reads as clipped even when it is not.
 */
export function clampMenu(
  at: MenuBox,
  size: { w: number; h: number },
  view: { w: number; h: number },
  pad = 6,
): MenuBox {
  let x = at.x;
  let y = at.y;

  // Flip to the other side of the pointer if there is room there.
  if (x + size.w + pad > view.w) {
    const flipped = at.x - size.w;
    x = flipped >= pad ? flipped : Math.max(pad, view.w - size.w - pad);
  }
  if (y + size.h + pad > view.h) {
    const flipped = at.y - size.h;
    y = flipped >= pad ? flipped : Math.max(pad, view.h - size.h - pad);
  }

  // A menu taller or wider than the window itself cannot fit either way,
  // and pinning it to the top left at least shows the beginning of it.
  return { x: Math.max(pad, x), y: Math.max(pad, y) };
}

/** The window, or something harmless when there is no window.
 *
 * jsdom reports 1024 by 768, which is a real size and fine to clamp
 * against; this only guards the case where there is no window at all.
 */
export function viewportSize(): { w: number; h: number } {
  if (typeof window === "undefined") return { w: 1920, h: 1080 };
  return {
    w: window.innerWidth || 1920,
    h: window.innerHeight || 1080,
  };
}
