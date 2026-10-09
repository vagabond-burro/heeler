// The main window's side of the panel fit (layoutfit.ts): it tells the
// state how much room the window has, and hands the panels the layout
// that fits rather than the one that was saved.

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { layoutFitOf, type Command, type State } from "../state";
import type { LayoutFit } from "../layoutfit";
import { CHROME_ZOOM_EVENT } from "../uiprefs";

/** The zoom in force: the CSS variable every .ui-zoom wrapper reads. */
export function zoomInForce(): number {
  const v = parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--chrome-zoom"));
  return Number.isFinite(v) && v > 0 ? v : 1;
}

/** Reports the window's width and the zoom to the state, now and on
 * every resize or zoom change. */
export function useLayoutRoom(dispatch: React.Dispatch<Command>): void {
  useEffect(() => {
    const report = () => dispatch({ type: "set_layout_room", width: window.innerWidth, zoom: zoomInForce() });
    report();
    window.addEventListener("resize", report);
    window.addEventListener(CHROME_ZOOM_EVENT, report);
    return () => {
      window.removeEventListener("resize", report);
      window.removeEventListener(CHROME_ZOOM_EVENT, report);
    };
  }, [dispatch]);
}

/** The state as the panels should draw it: the fold panels open only
 * where the fit shows them, at the widths the fit gives them. The
 * saved layout in the real state is untouched. The same object comes
 * back for as long as nothing it carries changes, so the memoized panes
 * keep skipping renders they skipped before. */
export function useFittedState(state: State): { laid: State; fit: LayoutFit | null } {
  const fit = layoutFitOf(state);
  const lib = fit?.sizes.library ?? state.panelSizes.library;
  const rib = fit?.sizes.ribbon ?? state.panelSizes.ribbon;
  const right = fit?.sizes.right ?? state.panelSizes.right;
  const sizes = useMemo(() => {
    const p = state.panelSizes;
    if (p.library === lib && p.ribbon === rib && p.right === right) return p;
    return { ...p, library: lib, ribbon: rib, right };
  }, [state.panelSizes, lib, rib, right]);
  const prev = useRef<State | null>(null);
  if (!fit) return { laid: state, fit };
  const browserOpen = fit.library;
  const exportOpen = fit.export;
  const ribbonOpen = state.ribbonExpanded ? state.ribbonOpen : fit.ribbon;
  if (
    browserOpen === state.browserOpen &&
    exportOpen === state.exportOpen &&
    ribbonOpen === state.ribbonOpen &&
    sizes === state.panelSizes
  ) {
    prev.current = null;
    return { laid: state, fit };
  }
  const p = prev.current;
  const laid =
    p && p.browserOpen === browserOpen && p.exportOpen === exportOpen && p.ribbonOpen === ribbonOpen && p.panelSizes === sizes && sameExceptLaid(p, state)
      ? p
      : { ...state, browserOpen, exportOpen, ribbonOpen, panelSizes: sizes };
  prev.current = laid;
  return { laid, fit };
}

const LAID_KEYS = new Set<keyof State>(["browserOpen", "exportOpen", "ribbonOpen", "panelSizes"]);

/** Whether a previous laid state still carries every other field of
 * the real one (the view included, so the viewer sees pan and zoom). */
function sameExceptLaid(laid: State, state: State): boolean {
  for (const k of Object.keys(state) as (keyof State)[]) {
    if (LAID_KEYS.has(k)) continue;
    if (laid[k] !== state[k]) return false;
  }
  return true;
}

/** The width a divider drag asks for: from the width the panel is drawn
 * at (which the fit may have shrunk), and never wider than the room the
 * center can spare above its minimum. */
export function fittedDragSize(state: State, panel: "library" | "ribbon" | "right", delta: number): number {
  const fit = layoutFitOf(state);
  if (!fit) return state.panelSizes[panel] + delta;
  const shown = fit.sizes[panel];
  if (delta <= 0) return shown + delta;
  const zoom = state.layoutRoom?.zoom ?? 1;
  // The right panel's width is spent twice while Export borrows it.
  const share = panel === "right" && fit.export ? 2 : 1;
  const spare = Math.max(0, fit.center - fit.centerMin) / (zoom * share);
  return shown + Math.min(delta, spare);
}

/** An element's left edge inside an ancestor, from offsets (never
 * client rects, which WKWebView gets wrong inside .ui-zoom). */
function leftWithin(el: HTMLElement, ancestor: HTMLElement): number {
  let x = 0;
  let at: HTMLElement | null = el;
  while (at && at !== ancestor) {
    x += at.offsetLeft;
    const up = at.offsetParent as HTMLElement | null;
    // An offsetParent above the ancestor means the ancestor is not
    // positioned; its own offset comes off again.
    if (up && !ancestor.contains(up)) return x - ancestor.offsetLeft;
    at = up;
  }
  return x;
}

/** Whether a bottom-right row of hints clears a bottom-left (or
 * centered) row, found by its test id inside the hints' parent, along
 * the same bottom edge. Hints are help, so on a narrow surface they
 * step aside rather than print over the node count. */
export function useClearsSibling(ref: React.RefObject<HTMLElement>, siblingTestId: string, gap = 12): boolean {
  const [clear, setClear] = useState(true);
  const measure = useRef<() => void>(() => {});
  measure.current = () => {
    const el = ref.current;
    const parent = el?.parentElement;
    if (!el || !parent) return;
    const other = parent.querySelector<HTMLElement>(`[data-testid="${siblingTestId}"]`);
    // Nothing laid out (a test's DOM) is nothing to collide.
    if (!other || parent.clientWidth === 0) return setClear(true);
    // The row's printed extent: a centered row spans the whole surface
    // as a box, so its children say where the words are.
    const kids = [...other.children] as HTMLElement[];
    const end = kids.length > 0 ? Math.max(...kids.map((k) => k.offsetLeft + k.offsetWidth)) : other.offsetWidth;
    // Hidden keeps its box, so its left edge is where it would print.
    setClear(leftWithin(other, parent) + end + gap <= leftWithin(el, parent));
  };
  // Every render: what the row says (a selection count) changes its
  // width without resizing its box.
  useLayoutEffect(() => measure.current());
  useLayoutEffect(() => {
    const parent = ref.current?.parentElement;
    if (!parent || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => measure.current());
    ro.observe(parent);
    return () => ro.disconnect();
  }, [ref]);
  return clear;
}

/** The title bar on a small window. Two rules, both measured with
 * offsets in the bar's own (zoomed) coordinates:
 *
 * - Its controls never run off the right edge: when the menus, the
 *   mode tabs and the buttons need more room than the window has at
 *   the app zoom, the bar alone draws at the largest zoom that holds
 *   them, never below 100%. At 1280 wide and 150% the tabs and the
 *   export button were clipped.
 * - The centered title (the library and the photo's name) stays in the
 *   true middle of the bar, and hides when it would sit on the menus
 *   or the tabs rather than printing over them.
 */
export function useTopBarFit(
  bar: React.RefObject<HTMLElement>,
  room: { width: number; zoom: number } | null,
  titleKey: string,
): { zoom: number | undefined; titleShown: boolean } {
  const [fit, setFit] = useState<{ zoom: number | undefined; titleShown: boolean }>({ zoom: undefined, titleShown: true });
  useLayoutEffect(() => {
    const el = bar.current;
    if (!el || !room) return;
    const measure = () => {
      const kids = [...el.children] as HTMLElement[];
      const flow = kids.filter((k) => getComputedStyle(k).position !== "absolute");
      if (flow.length === 0) return;
      const cs = getComputedStyle(el);
      const gap = parseFloat(cs.columnGap) || 0;
      const padL = parseFloat(cs.paddingLeft) || 0;
      const padR = parseFloat(cs.paddingRight) || 0;
      const need = flow.reduce((a, k) => a + k.offsetWidth, 0) + gap * (flow.length - 1) + padL + padR;
      const zoom = need > 0 ? Math.max(1, Math.min(room.zoom, room.width / need)) : room.zoom;
      const barW = room.width / zoom;
      const title = kids.find((k) => k.classList.contains("center"));
      const menus = flow.find((k) => k.dataset.testid === "menubar");
      const cluster = flow[flow.length - 1];
      let titleShown = true;
      if (title && menus && cluster) {
        const half = title.offsetWidth / 2;
        const menuRight = menus.offsetLeft + menus.offsetWidth;
        const clusterLeft = barW - padR - cluster.offsetWidth;
        titleShown = barW / 2 - half >= menuRight + gap / 2 && barW / 2 + half <= clusterLeft - gap / 2;
      }
      const next = { zoom: zoom < room.zoom ? Math.floor(zoom * 1000) / 1000 : undefined, titleShown };
      setFit((prev) => (prev.zoom === next.zoom && prev.titleShown === next.titleShown ? prev : next));
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(measure);
    for (const k of el.children) ro.observe(k);
    return () => ro.disconnect();
  }, [bar, room?.width, room?.zoom, titleKey]);
  return fit;
}
