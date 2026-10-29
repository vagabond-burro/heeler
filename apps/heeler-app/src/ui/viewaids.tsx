// The canvas header's Loupe button, and the two views the Navigator
// and the Loupe put over the canvas. The math is in
// viewaidsparts.ts.

import React, { useEffect, useRef, useState } from "react";
import type { Command, State } from "../state";
import { useDismiss } from "./hooks";
import { isPrimaryPress } from "./pointerguard";
import { MENU_LIST_SURFACE } from "./menufieldparts";
import { modLabel } from "../platform";
import {
  NAVIGATOR_CORNERS,
  insideQuad,
  loupeLabel,
  loupeSliceRect,
  loupeSpan,
  navigatorBox,
  overflowsStage,
  panToCenter,
  sliceCovers,
  viewCenter,
  viewQuad,
  type FrameRect,
  type StageView,
} from "./viewaidsparts";

type D = React.Dispatch<Command>;

/** The header's Loupe button. The Navigator has no button of its own:
 * the View menu turns it on and places it. */
export function ViewAidButtons({ state, dispatch }: { state: State; dispatch: D }) {
  return (
    <>
      <button
        data-active={state.prefs.loupeOn}
        onClick={() => dispatch({ type: "set_prefs", prefs: { loupeOn: !state.prefs.loupeOn } })}
        data-testid="btn-loupe"
        aria-label="Loupe"
        aria-pressed={state.prefs.loupeOn}
        data-hint={`Loupe: a magnifying glass under the pointer. While it is up, scroll or the zoom keys change its magnification and ${modLabel("ctrl")}+scroll its size; clicks and tools work through it`}
        data-hint-cmd="view.loupe"
        style={{ display: "inline-flex", alignItems: "center" }}
      >
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden focusable="false">
          <circle cx="10" cy="10" r="6.5" />
          <path d="M15 15l6 6" />
        </svg>
      </button>
    </>
  );
}

const NAV_MARGIN = 10;

/** The Navigator: the whole frame small in a corner of the canvas, with
 * the view's rectangle on it. Up only while the photograph is bigger
 * than the canvas. A drag on the rectangle pans the canvas with it; a
 * press anywhere else on the thumbnail centers the view there and goes
 * on dragging from it. */
export function Navigator({
  view,
  src,
  corner,
  size,
  filter,
  dispatch,
}: {
  view: StageView;
  src: string;
  corner: State["prefs"]["navigatorCorner"];
  size: number;
  filter?: string;
  dispatch: D;
}) {
  const latest = useRef(view);
  latest.current = view;
  const endDrag = useRef<(() => void) | null>(null);
  const shown = overflowsStage(view);
  // The corner menu, at the press that opened it, in the map's own
  // pixels (2026-10-29: the header button's right-click menu, back on
  // the map now that the button is gone: "right click does not seem to
  // do anything in the Navigator view").
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const root = useDismiss<HTMLDivElement>(menu !== null, () => setMenu(null));
  const menuRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!shown) endDrag.current?.();
    return () => endDrag.current?.();
  }, [shown, src]);
  useEffect(() => {
    if (!shown) setMenu(null);
  }, [shown]);
  useEffect(() => {
    if (!menu) return;
    const items = Array.from(menuRef.current?.querySelectorAll<HTMLButtonElement>("[role=menuitemradio]") ?? []);
    (items.find((item) => item.dataset.active) ?? items[0])?.focus();
  }, [menu !== null]);
  if (!shown) return null;
  const menuKeys = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const items = Array.from(menuRef.current?.querySelectorAll<HTMLButtonElement>("[role=menuitemradio]") ?? []);
    const at = items.indexOf(document.activeElement as HTMLButtonElement);
    const go = (i: number) => {
      e.preventDefault();
      items[Math.max(0, Math.min(items.length - 1, i))]?.focus();
    };
    if (e.key === "ArrowDown") go(at + 1);
    else if (e.key === "ArrowUp") go(at - 1);
    else if (e.key === "Home") go(0);
    else if (e.key === "End") go(items.length - 1);
    else if (e.key === "Escape") {
      // The menu alone: the canvas's own Escape is for the tool.
      e.preventDefault();
      e.stopPropagation();
      setMenu(null);
    } else if (e.key === "Tab") setMenu(null);
  };
  const box = navigatorBox(view.stage, view.base.w / view.base.h, size);
  const quad = viewQuad(view);
  const at = (e: { clientX: number; clientY: number }, el: Element): [number, number] => {
    const r = el.getBoundingClientRect();
    return [(e.clientX - r.left) / (r.width || 1), (e.clientY - r.top) / (r.height || 1)];
  };
  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!isPrimaryPress(e)) return;
    e.preventDefault();
    e.stopPropagation();
    endDrag.current?.();
    const el = e.currentTarget;
    const [px, py] = at(e, el);
    // Grabbed inside, the rectangle keeps the offset it was grabbed at;
    // outside, the view jumps to center on the press first.
    const [cx, cy] = viewCenter(latest.current);
    const grab: [number, number] = insideQuad(viewQuad(latest.current), px, py) ? [px - cx, py - cy] : [0, 0];
    const panTo = (ev: { clientX: number; clientY: number }) => {
      const [x, y] = at(ev, el);
      const pan = panToCenter(latest.current, x - grab[0], y - grab[1]);
      dispatch({ type: "set_viewer_pan", x: pan.x, y: pan.y });
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
      window.removeEventListener("blur", up);
      if (endDrag.current === up) endDrag.current = null;
    };
    const move = (ev: { clientX: number; clientY: number; buttons: number }) => {
      // A release outside the window can take its pointerup with it. The
      // next hover has no primary button, so it must not keep panning.
      if ((ev.buttons & 1) === 0) up();
      else panTo(ev);
    };
    panTo(e);
    endDrag.current = up;
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
    window.addEventListener("blur", up);
  };
  const place: React.CSSProperties = {
    [corner[0] === "t" ? "top" : "bottom"]: NAV_MARGIN,
    [corner[1] === "l" ? "left" : "right"]: NAV_MARGIN,
  };
  return (
    <div
      ref={root}
      data-testid="navigator"
      data-corner={corner}
      onPointerDown={onPointerDown}
      onContextMenu={(e) => {
        e.preventDefault();
        e.stopPropagation();
        const r = e.currentTarget.getBoundingClientRect();
        setMenu({ x: e.clientX - r.left, y: e.clientY - r.top });
      }}
      // The canvas's own wheel and middle drag stay the canvas's; the map
      // is for the left button.
      onMouseDown={(e) => {
        if (isPrimaryPress(e)) e.stopPropagation();
      }}
      onClick={(e) => e.stopPropagation()}
      data-hint="Drag the rectangle to move the view, or click to center it there. Right-click to choose its corner"
      style={{
        position: "absolute",
        ...place,
        width: box.w,
        height: box.h,
        zIndex: 45,
        cursor: "move",
        background: "#0e0d0c",
        boxShadow: "0 0 0 1px var(--line-4), 0 4px 14px rgba(0,0,0,.5)",
        touchAction: "none",
      }}
    >
      <img src={src} alt="" draggable={false} style={{ width: "100%", height: "100%", display: "block", objectFit: "fill", pointerEvents: "none", filter }} />
      <svg
        viewBox="0 0 1 1"
        preserveAspectRatio="none"
        width="100%"
        height="100%"
        style={{ position: "absolute", inset: 0, overflow: "visible", pointerEvents: "none" }}
        aria-hidden
      >
        <polygon
          data-testid="navigator-rect"
          points={quad.map(([x, y]) => `${x},${y}`).join(" ")}
          fill="rgba(255,255,255,.08)"
          stroke="var(--accent)"
          strokeWidth={1.5}
          vectorEffect="non-scaling-stroke"
        />
      </svg>
      {menu && (
        <div
          ref={menuRef}
          data-testid="navigator-corner-menu"
          role="menu"
          aria-label="Navigator position"
          onKeyDown={menuKeys}
          // The map pans on a press; a press in its menu is the menu's.
          onPointerDown={(e) => e.stopPropagation()}
          onMouseDown={(e) => e.stopPropagation()}
          onContextMenu={(e) => {
            e.preventDefault();
            e.stopPropagation();
          }}
          style={{
            position: "absolute",
            // Opened from the press toward the canvas's middle, so a map
            // in a bottom or right corner keeps its menu on the canvas.
            ...(corner[0] === "b" ? { bottom: box.h - menu.y } : { top: menu.y }),
            ...(corner[1] === "r" ? { right: box.w - menu.x } : { left: menu.x }),
            zIndex: 80,
            cursor: "default",
            ...MENU_LIST_SURFACE,
            maxHeight: undefined,
            minWidth: 128,
          }}
        >
          {NAVIGATOR_CORNERS.map((c) => (
            <button
              key={c.id}
              role="menuitemradio"
              aria-checked={c.id === corner}
              tabIndex={-1}
              data-testid={`navigator-corner-${c.id}`}
              data-active={c.id === corner || undefined}
              onClick={(e) => {
                e.stopPropagation();
                dispatch({ type: "set_prefs", prefs: { navigatorCorner: c.id } });
                setMenu(null);
              }}
              style={{
                all: "unset",
                cursor: "pointer",
                fontSize: 11.5,
                padding: "4px 8px",
                whiteSpace: "nowrap",
                display: "block",
                color: c.id === corner ? "var(--accent)" : "var(--text-body)",
              }}
            >
              {c.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/** The Loupe: a round glass that follows the pointer over the canvas
 * and shows what is under it magnified. Drawn on a canvas from the
 * pixels the viewer already holds (the frame on screen, and the sharp
 * 1:1 slice where it covers the spot). Where those are a reduced
 * preview's pixels, a pause of the pointer asks the engine for its own
 * full-resolution slice around the glass ("when I zoom in I am seeing
 * the lower resolution proxy's pixels"), twice the glass's span so a
 * small move stays inside it; the reduced pixels show meanwhile, and a
 * move off the slice, an edit or another photograph asks again. It
 * takes no pointer events: every click and every tool lands on
 * the canvas beneath it exactly as without it. Drawn imperatively on
 * each move, as the header readout is, so following the pointer never
 * re-renders the viewer. */
export function Loupe({
  stageRef,
  frameRef,
  imgRef,
  patchRef,
  patchRect,
  view,
  mag,
  radius,
  truePct,
  frameWidth,
  filter,
  requestSlice,
  cancelSlice,
  sliceOn = false,
  sliceKey = "",
}: {
  stageRef: React.RefObject<HTMLDivElement | null>;
  frameRef: React.RefObject<HTMLDivElement | null>;
  imgRef: React.RefObject<HTMLImageElement | null>;
  patchRef: React.RefObject<HTMLImageElement | null>;
  /** where the sharp slice sits on the frame, normalized */
  patchRect: [number, number, number, number] | null;
  view: StageView;
  mag: number;
  radius: number;
  truePct: number | null;
  /** the photograph's full width in pixels, once known */
  frameWidth: number | null;
  filter?: string;
  /** a full-resolution render of part of the frame, normalized, and
   * the part the engine cut (renderRoi) */
  requestSlice?: (rect: FrameRect, token: string) => Promise<{ url: string; rect: FrameRect } | null>;
  cancelSlice?: (token: string) => void;
  /** whether slices may be asked for now: an engine, no gesture */
  sliceOn?: boolean;
  /** what a slice's pixels depend on (the photograph, the edit, the
   * view): a slice made under another key is not drawn */
  sliceKey?: string;
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const pointer = useRef<{ x: number; y: number } | null>(null);
  const props = useRef({ view, mag, radius, patchRect, frameWidth, filter, requestSlice, cancelSlice, sliceOn, sliceKey });
  props.current = { view, mag, radius, patchRect, frameWidth, filter, requestSlice, cancelSlice, sliceOn, sliceKey };
  const frame = useRef(0);
  // The glass's own sharp slice, decoded, and the one being asked for:
  // its rect and key, the timer that waits for the pointer to pause and
  // the engine call's token once it is sent.
  const slice = useRef<{ key: string; rect: FrameRect; img: HTMLImageElement } | null>(null);
  const pending = useRef<{ sig: string; timer: number | undefined; token: string | null } | null>(null);
  // The last slice the engine would not cut (one so near the whole
  // frame it renders the frame instead, or a failure): not asked again
  // on every move.
  const refused = useRef<string | null>(null);
  const dropPending = () => {
    const q = pending.current;
    if (!q) return;
    window.clearTimeout(q.timer);
    if (q.token) props.current.cancelSlice?.(q.token);
    pending.current = null;
  };
  const askSlice = (rect: FrameRect, key: string) => {
    const sig = `${rect.join(",")}|${key}`;
    if (pending.current?.sig === sig || refused.current === sig) return;
    dropPending();
    const q: { sig: string; timer: number | undefined; token: string | null } = { sig, timer: undefined, token: null };
    pending.current = q;
    q.timer = window.setTimeout(() => {
      const ask = props.current.requestSlice;
      if (!ask || pending.current !== q) return;
      const token = `loupe:${crypto.randomUUID()}`;
      q.token = token;
      void ask(rect, token).then(async (got) => {
        if (pending.current !== q) return;
        pending.current = null;
        if (!got) {
          refused.current = sig;
          return;
        }
        const im = new Image();
        im.src = got.url;
        try {
          await im.decode();
        } catch {
          // decode() missing (test DOM) or refusing: drawn once loaded.
        }
        slice.current = { key, rect: got.rect, img: im };
        schedule();
      });
    }, 120);
  };

  const draw = () => {
    frame.current = 0;
    const wrap = wrapRef.current;
    const canvas = canvasRef.current;
    const stage = stageRef.current;
    const p = pointer.current;
    if (!wrap || !canvas || !stage) return;
    if (!p) {
      wrap.style.display = "none";
      if (pending.current && !pending.current.token) dropPending();
      return;
    }
    const { view: v, mag: m, radius: r, patchRect: pr, frameWidth: fw, filter: f, sliceOn: on, sliceKey: key } = props.current;
    wrap.style.display = "block";
    wrap.style.transform = `translate(${p.x - r}px, ${p.y - r}px)`;
    const dpr = window.devicePixelRatio || 1;
    const px = Math.round(r * 2 * dpr);
    if (canvas.width !== px) canvas.width = px;
    if (canvas.height !== px) canvas.height = px;
    const ctx = canvas.getContext?.("2d");
    if (!ctx) return;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, px, px);
    ctx.fillStyle = "#0e0d0c";
    ctx.fillRect(0, 0, px, px);
    // The frame point under the pointer to the glass's middle, at the
    // canvas's own scale and turn times the magnification.
    const frameEl = frameRef.current;
    const fr = frameEl?.getBoundingClientRect();
    const sr = stage.getBoundingClientRect();
    if (!fr) return;
    // The frame's on-screen middle, which the stage's transform turns
    // the frame about.
    const fx = fr.left + fr.width / 2 - sr.left;
    const fy = fr.top + fr.height / 2 - sr.top;
    const dw = v.base.w * v.scale * m * dpr;
    const dh = v.base.h * v.scale * m * dpr;
    ctx.translate(px / 2, px / 2);
    ctx.scale(m * dpr, m * dpr);
    ctx.translate(fx - p.x, fy - p.y);
    ctx.rotate((v.rotation * Math.PI) / 180);
    ctx.scale(1 / (m * dpr), 1 / (m * dpr));
    // Now one unit is a device pixel of the glass, centered on the frame.
    const img = imgRef.current;
    // Real pixels magnified past one per glass pixel are shown as the
    // squares they are. A reduced preview is smoothed as the canvas
    // smooths it: its squares would be the preview's, not the photograph's.
    const nat = img?.naturalWidth || 0;
    const square = (srcW: number, drawnW: number, full: number) => srcW > 0 && drawnW > srcW && fw !== null && srcW >= full * 0.98;
    ctx.imageSmoothingEnabled = !square(nat, dw, fw ?? Infinity);
    // Canvas state survives a redraw. Clear an old approximation when
    // the sharp frame that needs no filter replaces the thumbnail. Some
    // canvas implementations have no filter property at all.
    if ("filter" in ctx) ctx.filter = f || "none";
    try {
      if (img && img.complete && nat > 0) ctx.drawImage(img, -dw / 2, -dh / 2, dw, dh);
      const patch = patchRef.current;
      if (patch && pr && patch.complete && patch.naturalWidth > 0) {
        ctx.imageSmoothingEnabled = !square(patch.naturalWidth, dw * pr[2], (fw ?? Infinity) * pr[2]);
        ctx.drawImage(patch, -dw / 2 + pr[0] * dw, -dh / 2 + pr[1] * dh, pr[2] * dw, pr[3] * dh);
      }
      const own = slice.current;
      if (own && own.key === key && own.img.complete && own.img.naturalWidth > 0) {
        const sr2 = own.rect;
        // The engine's own pixels: the thumbnail's approximation is not theirs.
        if ("filter" in ctx) ctx.filter = "none";
        ctx.imageSmoothingEnabled = !square(own.img.naturalWidth, dw * sr2[2], (fw ?? Infinity) * sr2[2]);
        ctx.drawImage(own.img, -dw / 2 + sr2[0] * dw, -dh / 2 + sr2[1] * dh, sr2[2] * dw, sr2[3] * dh);
      }
    } catch {
      // An image the canvas refuses leaves the glass dark, never broken.
    }
    // Real pixels under the whole glass already (the frame is the full
    // one, or a slice covers it): nothing to ask for. Otherwise a pause
    // here asks for a slice around it.
    const span = loupeSpan(p, fx, fy, v.rotation, v.base.w * v.scale, v.base.h * v.scale, r, m);
    const full = fw !== null && nat >= fw * 0.98;
    const own = slice.current && slice.current.key === key ? slice.current.rect : null;
    if (!on || !span || full || sliceCovers(pr, span) || sliceCovers(own, span)) {
      if (pending.current && !pending.current.token) dropPending();
      return;
    }
    const want = loupeSliceRect(span);
    if (want) askSlice(want, key);
  };
  const schedule = () => {
    if (!frame.current) frame.current = window.requestAnimationFrame(draw);
  };

  // Rebind after each commit: a viewer variant can replace the stage
  // element while keeping this aid mounted.
  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;
    const move = (e: PointerEvent) => {
      // Over the Navigator, the floating bars and their buttons the
      // glass steps aside: they are controls, not the photograph.
      const t = e.target instanceof Element ? e.target : null;
      if (t?.closest('[data-testid="navigator"], .viewer-toolbar, button, [role="menu"], [role="dialog"]')) {
        pointer.current = null;
      } else {
        const r = stage.getBoundingClientRect();
        pointer.current = { x: e.clientX - r.left, y: e.clientY - r.top };
      }
      schedule();
    };
    const leave = () => {
      pointer.current = null;
      schedule();
    };
    stage.addEventListener("pointermove", move, { passive: true });
    stage.addEventListener("pointerdown", move, { passive: true });
    stage.addEventListener("pointerleave", leave);
    return () => {
      stage.removeEventListener("pointermove", move);
      stage.removeEventListener("pointerdown", move);
      stage.removeEventListener("pointerleave", leave);
      if (frame.current) window.cancelAnimationFrame(frame.current);
      frame.current = 0;
    };
  });
  // Put away, the glass leaves nothing queued behind the engine lock.
  useEffect(() => () => dropPending(), []);
  // A wheel tick, a pan or a new frame under a still pointer redraws.
  // Decoding finishes after that render, so the images get a load redraw
  // too, especially the sharp patch arriving under a stationary pointer.
  useEffect(() => {
    schedule();
    const img = imgRef.current;
    const patch = patchRef.current;
    img?.addEventListener("load", schedule);
    patch?.addEventListener("load", schedule);
    return () => {
      img?.removeEventListener("load", schedule);
      patch?.removeEventListener("load", schedule);
    };
  });

  return (
    <div
      ref={wrapRef}
      data-testid="loupe"
      aria-hidden
      style={{ position: "absolute", left: 0, top: 0, zIndex: 44, pointerEvents: "none", display: "none", width: radius * 2 }}
    >
      <canvas
        ref={canvasRef}
        data-testid="loupe-glass"
        style={{
          display: "block",
          width: radius * 2,
          height: radius * 2,
          borderRadius: "50%",
          boxShadow: "0 0 0 1.5px var(--accent), 0 0 0 3px rgba(0,0,0,.55), 0 6px 18px rgba(0,0,0,.5)",
        }}
      />
      {/* The spot the pointer is on: the glass covers the cursor. */}
      <span
        style={{
          position: "absolute",
          left: radius - 4,
          top: radius - 4,
          width: 8,
          height: 8,
          boxSizing: "border-box",
          border: "1px solid rgba(255,255,255,.85)",
          boxShadow: "0 0 0 1px rgba(0,0,0,.6)",
        }}
      />
      <div
        data-testid="loupe-label"
        className="tnum"
        style={{
          marginTop: 6,
          textAlign: "center",
          fontSize: 11,
          letterSpacing: ".06em",
          color: "var(--text-body)",
          textShadow: "0 1px 2px rgba(0,0,0,.9)",
          whiteSpace: "nowrap",
        }}
      >
        {loupeLabel(mag, truePct)}
      </div>
    </div>
  );
}
