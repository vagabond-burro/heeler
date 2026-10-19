// Where Canvas mode's floating settings panel sits beside its node. No
// components live here, so canvas.tsx exports components alone and Vite
// can refresh it in place as it is edited instead of reloading the window.

/** Width of the floating settings panel, and the gap it keeps from the
 * node it belongs to and from the edges. */
export const PANEL_W = 312;
const PANEL_GAP = 12;

/** Where the floating settings panel goes for a node: beside it, flipped
 * to its other side when that would run off the edge, and clamped so it
 * is never partly off screen. Pure, so the awkward cases are testable
 * without rendering anything. */
export function panelPlacement(
  node: { x?: number; y?: number },
  view: { x: number; y: number; zoom: number },
  surface: { w: number; h: number },
  nodeW = 190,
  // The panel's PAINTED width: the ui-zoom on it makes that
  // PANEL_W times the chrome zoom, and flipping and clamping
  // against the layout width let the zoomed box hang off the edge.
  panelW = PANEL_W
) {
  const z = view.zoom;
  const nodeLeft = (node.x ?? 0) * z + view.x;
  const nodeTop = (node.y ?? 0) * z + view.y;
  const right = nodeLeft + nodeW * z + PANEL_GAP;
  // Prefer the right of the node; flip left when the panel would not fit.
  const left = right + panelW + PANEL_GAP <= surface.w ? right : nodeLeft - panelW - PANEL_GAP;
  const maxLeft = Math.max(PANEL_GAP, surface.w - panelW - PANEL_GAP);
  const maxTop = Math.max(52, surface.h - 220);
  return {
    left: Math.min(Math.max(PANEL_GAP, left), maxLeft),
    top: Math.min(Math.max(52, nodeTop), maxTop),
  };
}
