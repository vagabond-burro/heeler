// Grid Warp's keys (2026-09-30: "The SHIFT key should lock the
// transforming of the grids to one axis. It should also support arrow
// keys for adjustments"). Pure, so the overlay that every Grid Warp seat
// shares (the photograph's own, a Warp layer's, an image layer's own)
// and the tests read the same arithmetic.
//
// Both work in the warp's OWN axes: the photograph's for its own warp
// and a Warp layer's, the picture's for an image layer's own warp. The
// grid's lines run along those axes, so a locked drag keeps a handle on
// its row or column whatever the view's tilt, which is what the lock is
// for; a view turned by a few degrees does not drag it off its line.

type Pt = [number, number];

/** A move in the warp's normalized units held to one axis: whichever
 * the pointer has gone further along since the drag began, measured in
 * pixels (`aspect` is the space's width over its height, so a unit of x
 * is `aspect` units of y). The layer editors' Shift. A tie goes
 * to x. */
export function lockToAxis(dx: number, dy: number, aspect: number): Pt {
  return Math.abs(dx * aspect) >= Math.abs(dy) ? [dx, 0] : [0, dy];
}

export const ARROW_KEYS = ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"] as const;
export type ArrowKey = (typeof ARROW_KEYS)[number];
export const isArrowKey = (k: string): k is ArrowKey => (ARROW_KEYS as readonly string[]).includes(k);

/** Photograph pixels an arrow moves the picked handles, and with Shift. */
export const NUDGE_PX = 1;
export const NUDGE_PX_BIG = 10;

const SCREEN: Record<ArrowKey, Pt> = {
  ArrowLeft: [-1, 0],
  ArrowRight: [1, 0],
  ArrowUp: [0, -1],
  ArrowDown: [0, 1],
};

/** What an arrow does to the picked handles, in the warp's normalized
 * units: `px` photograph pixels along the warp's own axis that runs
 * closest to the arrow's direction on screen. The screen direction is
 * carried back through the view's rotation (a quarter turn makes Right
 * move the picture's y), then matched to the warp's axes as the frame
 * holds them. `frame` is the photograph's size in pixels; `unit` is the
 * frame fractions one unit of each of the warp's axes spans (warpspace
 * WarpSpace.unit), null when the warp is in the frame's own space. The
 * zoom and the display's pixel ratio play no part: a nudge is measured
 * in the photograph, not on the screen. */
export function arrowNudge(
  key: ArrowKey,
  px: number,
  viewRotationDeg: number,
  frame: { w: number; h: number },
  unit: [Pt, Pt] | null = null,
): Pt {
  const [sx, sy] = SCREEN[key];
  const t = (-viewRotationDeg * Math.PI) / 180;
  const fx = sx * Math.cos(t) - sy * Math.sin(t);
  const fy = sx * Math.sin(t) + sy * Math.cos(t);
  const [u, v] = unit ?? [[1, 0], [0, 1]];
  // Each axis of the warp in photograph pixels per unit.
  const U: Pt = [u[0] * frame.w, u[1] * frame.h];
  const V: Pt = [v[0] * frame.w, v[1] * frame.h];
  const lu = Math.hypot(U[0], U[1]) || 1;
  const lv = Math.hypot(V[0], V[1]) || 1;
  const du = (fx * U[0] + fy * U[1]) / lu;
  const dv = (fx * V[0] + fy * V[1]) / lv;
  if (Math.abs(du) >= Math.abs(dv)) return [(Math.sign(du) * px) / lu, 0];
  return [0, (Math.sign(dv) * px) / lv];
}

/** Whether a key event belongs to something that reads arrows itself
 * (a text field, a slider, a list, a menu or dialog), which the grid
 * leaves alone. */
export function arrowsOwnedElsewhere(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el || typeof el.closest !== "function") return false;
  const tag = el.tagName;
  const type = (el as HTMLInputElement).type ?? "";
  if (tag === "TEXTAREA" || el.isContentEditable) return true;
  if (tag === "INPUT" && !["checkbox", "radio", "button", "submit", "reset", "color", "file"].includes(type)) return true;
  if (el.closest('[role="slider"], [role="listbox"], [contenteditable="true"], select, input[type="range"]')) return true;
  // A dialog or menu keeps its keys, but the guided tour's card is not
  // modal (app.tsx reads it the same way).
  const modal = el.closest('[role="dialog"], [role="menu"]');
  return !!modal && !modal.hasAttribute("data-tour-card");
}
