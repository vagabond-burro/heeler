// The keys of a curve's points, the same in the Curves editor and the
// Tone Profile's Custom curve: Tab moves between the points, the arrow
// keys move the focused one (Shift takes the larger step), Enter adds a
// point on the curve halfway to the next one, and Delete or Backspace
// removes it. Each editor says what a move, an add and a remove do to
// its own curve; this file owns the keys, the focus and the undo steps.

import { useEffect, useRef, useState } from "react";
import type React from "react";

/** How many small steps Shift takes at once. */
export const CURVE_KEY_BIG = 5;

/** The keys, for the editors' help and the hint on a point. */
export const CURVE_KEYS_HINT =
  "Tab moves between the points. The arrow keys move the focused point, Shift for a larger step; Enter adds a point halfway to the next one; Delete removes it";

export type CurveKeyAction =
  | { kind: "move"; dx: number; dy: number }
  | { kind: "add" }
  | { kind: "remove" };

const ARROWS: Record<string, [number, number]> = {
  ArrowLeft: [-1, 0],
  ArrowRight: [1, 0],
  ArrowUp: [0, 1],
  ArrowDown: [0, -1],
};

/** What a key press asks of the focused point, in small steps, or null
 * for a key that is not the editor's: a chord with Ctrl, Cmd or Alt is
 * a shortcut of the app's or the system's, and passes through. */
export function curveKeyAction(e: {
  key: string;
  shiftKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
}): CurveKeyAction | null {
  if (e.ctrlKey || e.metaKey || e.altKey) return null;
  const arrow = ARROWS[e.key];
  if (arrow) {
    const n = e.shiftKey ? CURVE_KEY_BIG : 1;
    return { kind: "move", dx: arrow[0] * n, dy: arrow[1] * n };
  }
  if (e.key === "Enter") return { kind: "add" };
  if (e.key === "Delete" || e.key === "Backspace") return { kind: "remove" };
  return null;
}

export type CurveKeyHandlers = {
  /** Open and close the undo step a run of moves is. */
  begin: () => void;
  end: () => void;
  /** Move point `i` by so many small steps along each axis. */
  move: (i: number, dx: number, dy: number) => void;
  /** Add a point beside point `i`; the new point's index, or null where
   * there is no room for one. */
  add: (i: number) => number | null;
  /** Remove point `i` where the curve can spare it. */
  remove: (i: number) => void;
};

/** The focus and key handling of a curve's points. `focused` is the
 * point with the keyboard, for the ring; `props(i)` goes on point `i`.
 *
 * A press and its repeats while the key is held are one undo step: the
 * step opens on the first press and closes when the key comes up or the
 * point loses focus. A second press opens a new one. */
export function useCurvePointKeys(handlers: CurveKeyHandlers) {
  const [focused, setFocused] = useState<number | null>(null);
  const els = useRef<(SVGCircleElement | null)[]>([]);
  const wanted = useRef<number | null>(null);
  const open = useRef(false);
  const latest = useRef(handlers);
  latest.current = handlers;

  const close = () => {
    if (!open.current) return;
    open.current = false;
    latest.current.end();
  };

  // A point added by key takes the focus once it is drawn, so the arrow
  // keys go on to move it.
  useEffect(() => {
    if (wanted.current === null) return;
    const el = els.current[wanted.current];
    if (!el) return;
    wanted.current = null;
    el.focus();
  });
  // An editor taken away mid-press closes its step.
  useEffect(() => () => {
    if (open.current) latest.current.end();
  }, []);

  const props = (i: number) => ({
    tabIndex: 0,
    ref: (el: SVGCircleElement | null) => {
      els.current[i] = el;
    },
    onFocus: () => setFocused(i),
    onBlur: () => {
      close();
      setFocused((f) => (f === i ? null : f));
    },
    onKeyDown: (e: React.KeyboardEvent) => {
      const action = curveKeyAction(e);
      if (!action) return;
      // The app's own keys (the arrows step between photographs) stay
      // out of it while a point has the keyboard.
      e.preventDefault();
      e.stopPropagation();
      if (action.kind === "move") {
        if (!e.repeat || !open.current) {
          close();
          open.current = true;
          latest.current.begin();
        }
        latest.current.move(i, action.dx, action.dy);
        return;
      }
      if (e.repeat) return;
      close();
      if (action.kind === "remove") {
        latest.current.remove(i);
        return;
      }
      const at = latest.current.add(i);
      if (at !== null) wanted.current = at;
    },
    onKeyUp: (e: React.KeyboardEvent) => {
      if (e.key in ARROWS) close();
    },
  });

  return { focused, props };
}
