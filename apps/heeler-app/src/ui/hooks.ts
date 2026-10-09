// Shared UI hooks.

import type React from "react";
import { useEffect, useRef, useState } from "react";
import { isMac } from "../platform";

export interface ViewportNav {
  /** factor > 1 zooms in; cx/cy are cursor offsets from the surface center */
  onZoom: (factor: number, cx: number, cy: number) => void;
  /** screen-pixel deltas */
  onPan: (dx: number, dy: number) => void;
  /** degrees; only wired where rotation makes sense (the image) */
  onRotate?: (deltaDeg: number) => void;
  onResetRotation?: () => void;
  /** wheel sensitivity and rotation amount from Preferences */
  zoomRate?: number;
  rotationStep?: number;
  /** flips which wheel direction zooms in (Preferences) */
  invertZoom?: boolean;
}

const ZOOM_RATE = 0.0015;

const ROTATE_STEP = 2;

/** One navigation scheme for every zoomable surface:
 *   scroll             zoom
 *   ALT/CMD + scroll   zoom at half rate   (Mac: ALT only; CMD is below)
 *   SHIFT + scroll     pan horizontally
 *   CTRL + scroll      pan vertically      (Mac: CMD + scroll)
 *   middle drag        free pan
 * plus, where rotation is supported:
 *   SHIFT + ALT + scroll  rotate counter-clockwise
 *   CTRL + ALT + scroll   rotate clockwise (Mac: CMD + ALT)
 *   SHIFT + ALT + middle  reset rotation
 *
 * On a Mac, Command plays Control's role (as it does in hotkeys.ts) and
 * physical ctrl+wheel is left unclaimed on purpose: a trackpad pinch
 * arrives as exactly that, and a pinch means zoom.
 *
 * The wheel listener is attached natively and non-passive: React's
 * onWheel cannot preventDefault, so CTRL+scroll would zoom the whole
 * webview instead of panning the surface.
 */
export function useViewportNav<T extends HTMLElement>(nav: ViewportNav) {
  const ref = useRef<T | null>(null);
  const latest = useRef(nav);
  latest.current = nav;

  useEffect(() => {
    const el = ref.current;
    if (!el) return;

    // Pointer devices can deliver several wheel/move events between two
    // paints. Applying each event immediately made React reconcile the
    // complete viewer (photo, tools, masks and ants) more often than the
    // display could show it. Preserve operation order and cursor-centered
    // zoom math, coalescing only adjacent operations that are exactly
    // equivalent, then deliver the burst in one animation-frame callback;
    // React 18 batches the resulting state updates into one render.
    type NavOp =
      | { kind: "zoom"; factor: number; cx: number; cy: number }
      | { kind: "pan"; dx: number; dy: number }
      | { kind: "rotate"; delta: number };
    let queued: NavOp[] = [];
    let frame = 0;
    const flush = () => {
      frame = 0;
      const ops = queued;
      queued = [];
      for (const op of ops) {
        if (op.kind === "zoom") latest.current.onZoom(op.factor, op.cx, op.cy);
        else if (op.kind === "pan") latest.current.onPan(op.dx, op.dy);
        else latest.current.onRotate?.(op.delta);
      }
    };
    const enqueue = (op: NavOp) => {
      const last = queued[queued.length - 1];
      if (last?.kind === "pan" && op.kind === "pan") {
        last.dx += op.dx;
        last.dy += op.dy;
      } else if (last?.kind === "rotate" && op.kind === "rotate") {
        last.delta += op.delta;
      } else {
        queued.push(op);
      }
      if (!frame) frame = window.requestAnimationFrame(flush);
    };

    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const mac = isMac();
      const alt = e.altKey || (!mac && e.metaKey);
      const vpan = mac ? e.metaKey : e.ctrlKey;
      const delta = e.deltaY !== 0 ? e.deltaY : e.deltaX;
      if (delta === 0) return;

      // Rotation combos are checked first: they share SHIFT/CTRL with pan.
      // Positive degrees are clockwise, so scrolling forward with
      // SHIFT+ALT goes counter-clockwise. Scrolling back reverses it, so
      // an overshoot is undone the way it was made.
      if (alt && e.shiftKey) {
        enqueue({ kind: "rotate", delta: Math.sign(delta) * (latest.current.rotationStep ?? ROTATE_STEP) });
        return;
      }
      if (alt && vpan) {
        enqueue({ kind: "rotate", delta: -Math.sign(delta) * (latest.current.rotationStep ?? ROTATE_STEP) });
        return;
      }
      // A trackpad's two-finger scroll reports both axes, and a pan that
      // only honored one wasted the other half of the gesture (The
      // report: "how on earth in Canvas view do I pan using the
      // touchpad?"). Both axes moving means a trackpad: pan freely. A
      // mouse wheel reports one axis, and the modifier keeps choosing
      // which way that one axis pans.
      if ((e.shiftKey || vpan) && e.deltaX !== 0 && e.deltaY !== 0) {
        enqueue({ kind: "pan", dx: -e.deltaX, dy: -e.deltaY });
        return;
      }
      if (e.shiftKey) {
        enqueue({ kind: "pan", dx: -delta, dy: 0 });
        return;
      }
      if (vpan) {
        enqueue({ kind: "pan", dx: 0, dy: -delta });
        return;
      }
      const rect = el.getBoundingClientRect();
      const cx = e.clientX - (rect.left + rect.width / 2);
      const cy = e.clientY - (rect.top + rect.height / 2);
      const rate = alt ? (latest.current.zoomRate ?? ZOOM_RATE) / 2 : latest.current.zoomRate ?? ZOOM_RATE;
      enqueue({
        kind: "zoom",
        factor: Math.exp((latest.current.invertZoom ? delta : -delta) * rate),
        cx,
        cy,
      });
    };

    const onMouseDown = (e: MouseEvent) => {
      if (e.button !== 1) return;
      e.preventDefault();
      if ((e.altKey || (!isMac() && e.metaKey)) && e.shiftKey) {
        latest.current.onResetRotation?.();
        return;
      }
      let last = { x: e.clientX, y: e.clientY };
      const move = (ev: MouseEvent) => {
        // A mouseup released OFF the window never arrives here, and
        // without this the next hover would keep panning with no
        // button down. No buttons means the drag is over whether or
        // not the up event was heard.
        if (ev.buttons === 0) {
          up();
          return;
        }
        enqueue({ kind: "pan", dx: ev.clientX - last.x, dy: ev.clientY - last.y });
        last = { x: ev.clientX, y: ev.clientY };
      };
      const up = () => {
        window.removeEventListener("mousemove", move);
        window.removeEventListener("mouseup", up);
      };
      window.addEventListener("mousemove", move);
      window.addEventListener("mouseup", up);
    };

    // Middle-click on Windows otherwise starts autoscroll.
    const onAux = (e: MouseEvent) => e.button === 1 && e.preventDefault();

    el.addEventListener("wheel", onWheel, { passive: false });
    el.addEventListener("mousedown", onMouseDown);
    el.addEventListener("auxclick", onAux);
    return () => {
      el.removeEventListener("wheel", onWheel);
      el.removeEventListener("mousedown", onMouseDown);
      el.removeEventListener("auxclick", onAux);
      if (frame) window.cancelAnimationFrame(frame);
      queued = [];
    };
  }, []);

  return ref;
}

/** Closes a popover when the pointer goes down anywhere outside the
 * referenced element. Put the ref on a container that includes the
 * toggle button, so clicking the toggle still toggles instead of
 * close-then-reopen. Capture phase, so stopPropagation inside other
 * handlers cannot swallow the dismissal. */
export function useDismiss<T extends HTMLElement>(open: boolean, onClose: () => void) {
  const ref = useRef<T | null>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) closeRef.current();
    };
    const key = (event: KeyboardEvent) => {
      if (event.key === "Escape" && ref.current?.contains(event.target as Node)) { event.stopPropagation(); closeRef.current(); }
    };
    window.addEventListener("mousedown", onDown, true);
    window.addEventListener("keydown", key);
    return () => { window.removeEventListener("mousedown", onDown, true); window.removeEventListener("keydown", key); };
  }, [open]);
  return ref;
}

/** Whether SHIFT is down right now.
 *
 * Sliders quantize while it is held. Read from the window rather than
 * from the drag event because a native range input's change event does
 * not carry modifier keys, and because SHIFT can be pressed or released
 * in the middle of a drag and should take effect there and then. */
export function useShiftKey(): boolean {
  const [down, setDown] = useState(false);
  useEffect(() => {
    const on = (e: KeyboardEvent | MouseEvent) => setDown(e.shiftKey);
    window.addEventListener("keydown", on);
    window.addEventListener("keyup", on);
    window.addEventListener("mousemove", on);
    return () => {
      window.removeEventListener("keydown", on);
      window.removeEventListener("keyup", on);
      window.removeEventListener("mousemove", on);
    };
  }, []);
  return down;
}

/** An element's own CSS zoom, 1 when it has none. */
function ownZoom(n: Element): number {
  const z = Number(getComputedStyle(n).zoom);
  return Number.isFinite(z) && z > 0 ? z : 1;
}

/** The zoom an element's offsets are divided by: its own and every
 * ancestor's, multiplied. One offset unit of `el` is this many window
 * pixels. */
function effectiveZoom(el: Element): number {
  let z = 1;
  for (let n: Element | null = el; n; n = n.parentElement) z *= ownZoom(n);
  return z;
}

export interface PxBox {
  top: number;
  left: number;
  bottom: number;
  right: number;
  /** window pixels per offset unit at the element */
  z: number;
}

/** A zoomed element's client rect in true window pixels, or null when
 * it has no size to calibrate against.
 *
 * Engines disagree on the units of a client rect under CSS zoom:
 * Chromium reports window pixels, WebKit has reported the element's own
 * zoomed units. Its offsetWidth and offsetHeight are in its own units in
 * both, so the rect's height over offsetHeight says which convention
 * this engine used, and the rect is scaled to pixels by that measured
 * ratio rather than by a guess. Only ever called on the zoomed box
 * itself or on something the offset chain cannot reach; everything
 * inside a zoomed box is measured from offsets. */
function calibratedRect(e: HTMLElement, z: number): PxBox | null {
  const r = e.getBoundingClientRect();
  const ratio =
    r.height > 0 && e.offsetHeight > 0
      ? r.height / e.offsetHeight
      : r.width > 0 && e.offsetWidth > 0
        ? r.width / e.offsetWidth
        : NaN;
  if (!Number.isFinite(ratio) || ratio <= 0) return null;
  const s = z / ratio;
  return { top: r.top * s, left: r.left * s, bottom: r.bottom * s, right: r.right * s, z };
}

/** The last resort when nothing has a rect to calibrate (a layout-less
 * DOM): offsets all the way to the root, each in its own element's
 * units, so each is scaled by that element's zoom. */
function offsetCorner(el: HTMLElement): PxBox {
  let top = 0;
  let left = 0;
  for (let n: HTMLElement | null = el; n; n = n.offsetParent as HTMLElement | null) {
    const zn = effectiveZoom(n);
    top += n.offsetTop * zn;
    left += n.offsetLeft * zn;
  }
  const z = effectiveZoom(el);
  return { top, left, bottom: top + el.offsetHeight * z, right: left + el.offsetWidth * z, z };
}

/** An element's border box in true window pixels.
 *
 * Outside any CSS zoom that is its client rect. Inside a zoomed box (a
 * `.ui-zoom` panel, or the viewer's toolbars wearing the zoom inline) it
 * is measured from offsets up to that box, never from client rects,
 * because a client rect inside a CSS zoom does not track the zoom in
 * every engine (the thumbnail strip hit this in WebKit, ); the box's own
 * corner comes from its calibrated rect, which also carries any
 * transform on it or above it (the viewer's floating bar is centered
 * with translateX(-50%), which no offset sees).
 *
 * The rule once took the zoomed box's own offsetTop for window pixels
 * and divided it by the zoom a second time, but a zoomed element's own
 * offsets are already in its zoomed units. For a panel whose corner sits
 * near the window's top that cost a few pixels; for the viewer's
 * floating toolbar, hundreds of pixels down, it put the bar a third of
 * the way up the window at 150 percent, so its menus saw room below and
 * opened down into the viewer's clip (2026-09-30: "The drop down for
 * selection mode is broken again, its expanding downwards and getting
 * clipped").*/
export function pxBox(el: HTMLElement): PxBox {
  const z = effectiveZoom(el);
  if (z === 1) {
    const r = el.getBoundingClientRect();
    return { top: r.top, left: r.left, bottom: r.bottom, right: r.right, z: 1 };
  }
  let panel: HTMLElement | null = null;
  for (let n: HTMLElement | null = el; n; n = n.parentElement) {
    if (ownZoom(n) !== 1) {
      panel = n;
      break;
    }
  }
  if (!panel || panel === el) return calibratedRect(el, z) ?? offsetCorner(el);
  // el's place in the panel's units, offsets all the way up.
  let top = 0;
  let left = 0;
  for (let n: HTMLElement = el; n !== panel; ) {
    top += n.offsetTop;
    left += n.offsetLeft;
    const p = n.offsetParent as HTMLElement | null;
    if (!p || (p !== panel && !panel.contains(p))) {
      // A fixed layer between el and the panel broke the offset chain.
      return calibratedRect(el, z) ?? offsetCorner(el);
    }
    n = p;
  }
  for (let a = el.parentElement; a && a !== panel; a = a.parentElement) {
    top -= a.scrollTop;
    left -= a.scrollLeft;
  }
  // Offsets inside the panel run from its padding edge, and its own
  // scroll moves them.
  top += panel.clientTop - panel.scrollTop;
  left += panel.clientLeft - panel.scrollLeft;
  const corner = calibratedRect(panel, effectiveZoom(panel)) ?? offsetCorner(panel);
  return {
    top: corner.top + top * z,
    left: corner.left + left * z,
    bottom: corner.top + (top + el.offsetHeight) * z,
    right: corner.left + (left + el.offsetWidth) * z,
    z,
  };
}

const CLIPS = new Set(["hidden", "clip", "auto", "scroll", "overlay"]);

/** The part of the window a popover hung inside `el`'s box can show in,
 * in window pixels: the window, cut down by every ancestor that clips
 * its overflow on that axis (the viewer clips its floating toolbar's
 * lists; a scrolling panel clips its own), up to the first fixed layer,
 * which nothing above it clips. */
export function clipBox(el: HTMLElement): { top: number; left: number; bottom: number; right: number } {
  const c = { top: 0, left: 0, bottom: window.innerHeight, right: window.innerWidth };
  const root = document.documentElement;
  for (let a = el.parentElement; a && a !== document.body && a !== root; a = a.parentElement) {
    const cs = getComputedStyle(a);
    const y = CLIPS.has(cs.overflowY ?? "");
    const x = CLIPS.has(cs.overflowX ?? "");
    if (y || x) {
      const b = pxBox(a);
      if (y) {
        c.top = Math.max(c.top, b.top);
        c.bottom = Math.min(c.bottom, b.bottom);
      }
      if (x) {
        c.left = Math.max(c.left, b.left);
        c.right = Math.min(c.right, b.right);
      }
    }
    if (cs.position === "fixed") break;
  }
  return c;
}

/** Scrolls `list` just enough that `item` (somewhere inside it) is in
 * view, measured by offsets so it holds inside a `.ui-zoom` box, where
 * scrollIntoView and client rects do not track the zoom in WebKit (the
 * ui-zoom trap). Offsets and scrollTop are both in the list's own
 * units, so no zoom enters the sum. */
export function scrollItemIntoList(list: HTMLElement, item: HTMLElement): void {
  let top = 0;
  for (let n: HTMLElement | null = item; n && n !== list; ) {
    top += n.offsetTop;
    const p = n.offsetParent as HTMLElement | null;
    // The list is the item's offset parent only when it is positioned;
    // when it is not, both offsets run from the same ancestor, so the
    // list's own offset comes off.
    if (p && p !== list && !list.contains(p)) {
      top -= list.offsetTop;
      break;
    }
    n = p;
  }
  const bottom = top + item.offsetHeight;
  if (top < list.scrollTop) list.scrollTop = top;
  else if (bottom > list.scrollTop + list.clientHeight) list.scrollTop = bottom - list.clientHeight;
}

/** Whether a popover anchored to `el` should open upward.
 *
 * It does when there is not room below it and there IS room above (or, with room on
 * neither side, more room above), which is the case for anything in the toolbar across
 * the bottom of the viewer. Measured when the popover opens rather than decided by
 * whoever declared it, because the same control appears in the panel and in that
 * toolbar and neither placement is the component's business. On a menu that escaped the
 * window: "I think its a strange experience for it to extend outside the main window."
 *
 * `height` is in `el`'s own units (what the popover's CSS says), so it
 * scales with the zoom el is under; the room is the window cut by the
 * ancestors that clip, all in window pixels (pxBox, clipBox).
 */
export function opensUp(el: HTMLElement, height: number): boolean {
  const b = pxBox(el);
  const c = clipBox(el);
  const h = height * b.z;
  const below = c.bottom - b.bottom;
  const above = b.top - c.top;
  // When neither side holds it (the picker in a short viewer at 150
  // percent), the side with more room shows more of it.
  return below < h && (above > h || above > below);
}

/** Whether a popup hung from `el`'s left edge would run off the right
 * of the room it has (the window, cut by any clipping ancestor), and
 * there is room to hang it from the right edge instead. `width` is in
 * `el`'s own units. */
export function opensLeft(el: HTMLElement, width: number): boolean {
  const b = pxBox(el);
  const c = clipBox(el);
  const w = width * b.z;
  return b.left + w > c.right && b.right - w >= c.left;
}

/** Space-drag panning: hold space, drag with a plain left button, and
 * `onPan` gets the deltas. Space is the one modifier the viewers'
 * own navigation does not already use, it is what every other editor
 * uses for exactly this, and it is the pan a touchpad can actually
 * reach. "Since there is no middle-mouse it is pretty
 * much impossible to pan around the graph view or even a photo."
 *
 * Attach `onMouseDown` in the CAPTURE phase on the pannable surface,
 * so a held space preempts whatever tool the click would otherwise
 * feed. Space is swallowed except while typing, which also keeps it
 * from re-pressing whatever button was last focused mid-pan. */
export function useSpacePan(onPan: (dx: number, dy: number) => void) {
  const [held, setHeld] = useState(false);
  const heldRef = useRef(false);
  heldRef.current = held;
  const panRef = useRef(onPan);
  panRef.current = onPan;

  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      const tag = el?.tagName;
      if (e.code !== "Space" || tag === "INPUT" || tag === "TEXTAREA" || el?.isContentEditable) return;
      // Only the bare key pans. Shift+Space is Find a Node, and any other
      // chord belongs to the hotkey layer too; this listener runs first (a
      // child's effect, registered before the App's), and its preventDefault
      // below is what the hotkey layer reads as "taken" ("The
      // Find Node hotkey doesn't seem to be working").
      if (e.shiftKey || e.ctrlKey || e.altKey || e.metaKey) return;
      // A control that owns Space keeps it: a slider, a switch, a select,
      // anything inside a dialog or a menu, and a button the user reached
      // by KEYBOARD (focus-visible), which a screen reader user expects
      // Space to press. A button that merely holds focus because it was
      // clicked (Windows focuses a clicked button; macOS does not) keeps
      // the old rule, which is the point of the comment above: click a
      // chip, hold Space, pan, and the chip is not pressed again.
      if (el?.closest?.("select, [role=slider], [role=switch], [role=dialog], [role=menu]")) return;
      const button = el?.closest?.("button");
      if (button) {
        let keyboardFocused = true;
        try {
          keyboardFocused = button.matches(":focus-visible");
        } catch {
          keyboardFocused = true;
        }
        if (keyboardFocused) return;
      }
      e.preventDefault(); // space would otherwise scroll or re-press a button
      setHeld(true);
    };
    const up = (e: KeyboardEvent) => e.code === "Space" && setHeld(false);
    const blur = () => setHeld(false); // never leave the pan cursor stuck on
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    window.addEventListener("blur", blur);
    return () => {
      window.removeEventListener("keydown", down);
      window.removeEventListener("keyup", up);
      window.removeEventListener("blur", blur);
    };
  }, []);

  const onMouseDown = (e: React.MouseEvent) => {
    // Any button: while space is held, space decides what pans, and the
    // button stops mattering. Left-only let a middle-drag fall through to
    // its no-space meaning, so in Canvas SPACE+left panned the photo
    // while SPACE+middle panned the nodes. "This does not
    // feel consistent."
    if (!heldRef.current || e.button > 1) return;
    e.preventDefault();
    e.stopPropagation();
    let last = { x: e.clientX, y: e.clientY };
    const move = (ev: MouseEvent) => {
      // Same lost-mouseup guard as the middle-drag above: a button
      // released outside the window must not leave the surface
      // panning on hover forever after.
      if (ev.buttons === 0) {
        stop();
        return;
      }
      panRef.current(ev.clientX - last.x, ev.clientY - last.y);
      last = { x: ev.clientX, y: ev.clientY };
    };
    const stop = () => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", stop);
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", stop);
  };

  // A tool that starts on pointerdown (the key light's handles, the
  // Color Checker's corners, a pen on a graph port) hears its press
  // before the mousedown above can take it, so a held space stops it
  // here too. No preventDefault: that would cancel the mousedown that
  // follows, and the mousedown is the pan.
  const onPointerDown = (e: React.PointerEvent) => {
    if (!heldRef.current || e.button > 1) return;
    e.stopPropagation();
  };

  return { held, onMouseDown, onPointerDown };
}
