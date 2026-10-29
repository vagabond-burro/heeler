// The canvas header's Loupe button, and the two views the Navigator
// and the Loupe put over the canvas. The math is in
// viewaidsparts.ts.

import React, { useEffect, useRef } from "react";
import type { Command, State } from "../state";
import { isPrimaryPress } from "./pointerguard";
import { modLabel } from "../platform";
import {
  insideQuad,
  loupeLabel,
  navigatorBox,
  overflowsStage,
  panToCenter,
  viewCenter,
  viewQuad,
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
  useEffect(() => {
    if (!shown) endDrag.current?.();
    return () => endDrag.current?.();
  }, [shown, src]);
  if (!shown) return null;
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
      data-testid="navigator"
      data-corner={corner}
      onPointerDown={onPointerDown}
      // The canvas's own wheel and middle drag stay the canvas's; the map
      // is for the left button.
      onMouseDown={(e) => {
        if (isPrimaryPress(e)) e.stopPropagation();
      }}
      onClick={(e) => e.stopPropagation()}
      data-hint="Drag the rectangle to move the view, or click to center it there"
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
    </div>
  );
}

/** The Loupe: a round glass that follows the pointer over the canvas
 * and shows what is under it magnified. Drawn on a canvas from the
 * pixels the viewer already holds (the frame on screen, and the sharp
 * 1:1 slice where it covers the spot), so it costs no render of its
 * own. It takes no pointer events: every click and every tool lands on
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
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const pointer = useRef<{ x: number; y: number } | null>(null);
  const props = useRef({ view, mag, radius, patchRect, frameWidth, filter });
  props.current = { view, mag, radius, patchRect, frameWidth, filter };
  const frame = useRef(0);

  const draw = () => {
    frame.current = 0;
    const wrap = wrapRef.current;
    const canvas = canvasRef.current;
    const stage = stageRef.current;
    const p = pointer.current;
    if (!wrap || !canvas || !stage) return;
    if (!p) {
      wrap.style.display = "none";
      return;
    }
    const { view: v, mag: m, radius: r, patchRect: pr, frameWidth: fw, filter: f } = props.current;
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
    } catch {
      // An image the canvas refuses leaves the glass dark, never broken.
    }
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
