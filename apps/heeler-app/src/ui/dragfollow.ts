// A drag follows the pointer off the canvas (2026-10-08: "When
// dragging an interactive selection outside of the canvas space ends the
// selection, this is not how other programs work. They allow you to drag
// outside the canvas, its good for making sure you're capturing all the
// extents"). Every drag on the canvas and the curve editors ended where
// the pointer left the element: a marquee or lasso, a crop edge, a
// gradient handle, a brush stroke, the straighten line, a curve point.
//
// From the press to the release, the window carries the drag's moves and
// its release, to the handlers of the latest render (so a modifier or a
// state set mid-drag reads live). The element's own move and release
// handlers stand aside while a drag is followed (`active`), or each
// would be heard twice; leaving the element ends nothing. Positions read
// from the element's box clamp to its edge as they always did.

import { useCallback, useEffect, useRef } from "react";

export type DragHandlers<E> = {
  move?: (e: E) => void;
  up: (e: E) => void;
  /** The drag ended without its release: the window lost focus (its
   *  release may never come) or the host unmounted. A host that holds a
   *  gesture ends it here; with no `lost`, a blur leaves the drag alone
   *  and an unmount only stops listening, as before. */
  lost?: () => void;
};

export function useDragFollow<E extends MouseEvent = MouseEvent>(
  handlers: DragHandlers<E>,
  events: "mouse" | "pointer" = "mouse",
): { start: () => void; active: () => boolean; stop: () => void } {
  const latest = useRef(handlers);
  latest.current = handlers;
  const stopRef = useRef<(() => void) | null>(null);
  useEffect(
    () => () => {
      if (!stopRef.current) return;
      stopRef.current();
      latest.current.lost?.();
    },
    [],
  );
  const start = useCallback(() => {
    if (stopRef.current) return;
    const [moveName, upName] = events === "pointer" ? ["pointermove", "pointerup"] : ["mousemove", "mouseup"];
    const move = (e: Event) => latest.current.move?.(e as E);
    const up = (e: Event) => {
      stop();
      latest.current.up(e as E);
    };
    const blur = () => {
      if (!latest.current.lost) return;
      stop();
      latest.current.lost();
    };
    const stop = () => {
      window.removeEventListener(moveName, move);
      window.removeEventListener(upName, up);
      window.removeEventListener("blur", blur);
      stopRef.current = null;
    };
    window.addEventListener(moveName, move);
    window.addEventListener(upName, up);
    window.addEventListener("blur", blur);
    stopRef.current = stop;
  }, [events]);
  const active = useCallback(() => stopRef.current !== null, []);
  const stop = useCallback(() => stopRef.current?.(), []);
  return { start, active, stop };
}
