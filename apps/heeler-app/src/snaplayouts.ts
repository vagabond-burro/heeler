// Windows 11 Snap Layouts for the app's own maximize button.
//
// The title bar is ours (decorations: false), so Windows cannot see
// the maximize button, and hovering it brought up nothing where a
// native one brings up the Snap Layouts flyout ("the
// maximize button does not trigger desktop window manager"). The
// Rust side parks a tiny native window over the button that answers
// Windows' "what is under the cursor" with "a maximize button"
// (src-tauri/src/snaplayouts.rs). This file keeps that native window
// told where the button is, and relays its hover back to the button,
// which no longer sees the mouse itself.

import { isTauri, safeUnlisten, setMaximizeButtonRect } from "./bridge";
import { isMac } from "./platform";

/** The Rust side's hover report, a bool payload. Spelled out on both
 * sides (snaplayouts.rs). */
export const MAXIMIZE_HOVER_EVENT = "heeler:maximize-hover";

export type PhysicalRect = { x: number; y: number; w: number; h: number };

/** A CSS-pixel rect as the native window wants it: physical pixels,
 * rounded outward so a fractional edge never leaves a sliver of the
 * button answering as plain page. */
export function physicalRect(
  r: { left: number; top: number; right: number; bottom: number },
  dpr: number,
): PhysicalRect {
  const x = Math.floor(r.left * dpr);
  const y = Math.floor(r.top * dpr);
  return { x, y, w: Math.ceil(r.right * dpr) - x, h: Math.ceil(r.bottom * dpr) - y };
}

/** Keeps the native overlay on the button for as long as the button
 * is mounted: reports on mount, on every window resize (the button
 * rides the right edge) and whenever the button itself changes size
 * (the chrome zoom). Returns the teardown, which also clears the
 * overlay. A no-op outside Tauri and on macOS, where the OS's own
 * buttons do this job. */
export function watchMaximizeButton(
  el: HTMLElement | null,
  onHover: (hovering: boolean) => void,
): () => void {
  if (!el || !isTauri() || isMac()) return () => {};
  const report = () => {
    void setMaximizeButtonRect(physicalRect(el.getBoundingClientRect(), window.devicePixelRatio || 1));
  };
  report();
  window.addEventListener("resize", report);
  const ro = typeof ResizeObserver === "function" ? new ResizeObserver(report) : null;
  ro?.observe(el);
  let unlisten: (() => void) | null = null;
  let gone = false;
  // Listened on this window, not the global bus: the Rust side emits
  // to the window's label (each pop-out has its own overlay), and a
  // label-targeted emit reaches only listeners registered against
  // that label. A plain listen() from api/event hears nothing.
  void import("@tauri-apps/api/webviewWindow")
    .then(({ getCurrentWebviewWindow }) =>
      getCurrentWebviewWindow().listen<boolean>(MAXIMIZE_HOVER_EVENT, (e) => onHover(e.payload)),
    )
    .then((un) => {
      if (gone) un();
      else unlisten = un;
    });
  return () => {
    gone = true;
    window.removeEventListener("resize", report);
    ro?.disconnect();
    safeUnlisten(unlisten);
    void setMaximizeButtonRect({ x: 0, y: 0, w: 0, h: 0 });
  };
}
