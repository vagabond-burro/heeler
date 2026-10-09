// The Levels editor ("a histogram with interactive handles to
// adjust would be a nicer touch"). The photograph's luminance histogram
// with the three classic handles riding its baseline: black point, gamma,
// white point - drag any of them, or keep using the sliders below for
// typed precision; they steer the same params. The gamma handle sits
// where the input that maps to middle gray lands, the way every Levels
// has drawn it since the early layer editors.

import React, { useEffect, useRef, useState } from "react";
import { REGISTRY_DEFAULTS, type Command, type NodeCard, type State } from "../state";

type D = React.Dispatch<Command>;

/** sRGB code value (0..255) to linear light, as a table. */
const SRGB_TO_LINEAR = Array.from({ length: 256 }, (_, i) => {
  const c = i / 255;
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
});

/** The luma of one sRGB-encoded pixel on the chosen axis: the display
 * code value (Levels) or linear light (a mask that keys scene luma). */
export function lumaOf(r: number, g: number, b: number, linear: boolean): number {
  if (linear) return 0.2126 * SRGB_TO_LINEAR[r] + 0.7152 * SRGB_TO_LINEAR[g] + 0.0722 * SRGB_TO_LINEAR[b];
  return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
}

/** 64-bin luminance histogram from the preview frame, on the display
 * axis, or with `linear` on linear light: the frames Heeler hands over
 * are sRGB-encoded linear buffers, so decoding the curve gets the
 * engine's own luma back (above 1 lands in the last bin). */
export function useLumaBins(src: string | undefined, linear = false): number[] | null {
  const [bins, setBins] = useState<number[] | null>(null);
  useEffect(() => {
    if (!src) {
      setBins(null);
      return;
    }
    let live = true;
    const img = new Image();
    img.onload = () => {
      try {
        const c = document.createElement("canvas");
        const scale = Math.min(1, 160 / img.width);
        c.width = Math.max(1, Math.round(img.width * scale));
        c.height = Math.max(1, Math.round(img.height * scale));
        const ctx = c.getContext("2d")!;
        ctx.drawImage(img, 0, 0, c.width, c.height);
        const d = ctx.getImageData(0, 0, c.width, c.height).data;
        const b = new Array(64).fill(0);
        for (let i = 0; i < d.length; i += 4) {
          const l = lumaOf(d[i], d[i + 1], d[i + 2], linear);
          b[Math.min(63, Math.floor(l * 64))]++;
        }
        const peak = Math.max(...b, 1);
        if (live) setBins(b.map((v) => v / peak));
      } catch {
        // A canvas that refuses (tainted source) just means no
        // histogram: the handles still work.
        if (live) setBins(null);
      }
    };
    img.src = src;
    return () => {
      live = false;
    };
  }, [src, linear]);
  return bins;
}

/** The plot's horizontal inset, exported so tests measure the same axis
 * the component draws rather than a copy of the number. */
export const LEVELS_PAD = 12;

/** Which params the three handles (and the two falloffs) steer. The
 * Levels section's own by default; a layer's Depth block points the
 * same widget at its depth_* dials. */
export type LevelsKeys = { black: string; white: string; gamma?: string; blackSoft?: string; whiteSoft?: string };

/** The widget steering a mask's WINDOW instead of a tone map (the
 * Luminance Mask node, ): black and white are the band's low and high
 * edges, there is no gamma, the one `feather` param is the soft roll
 * OUTSIDE each edge on the axis's own scale (the engine's
 * smoothstep(low - feather, low) and smoothstep(high, high +
 * feather)), both top handles steer it, and the plot shades the tones
 * the mask selects, the other side when `invert` is on.*/
export type LevelsWindow = { feather: string; invert?: string };

/** What the mask takes at luma `l`, the engine's formula exactly
 * (ops.rs luminance_range_mask). */
export function windowWeight(l: number, low: number, high: number, feather: number, invert: boolean): number {
  const f = Math.max(feather, 1e-6);
  const ss = (e0: number, e1: number, x: number) => {
    const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
    return t * t * (3 - 2 * t);
  };
  const v = ss(low - f, low, l) * (1 - ss(high, high + f, l));
  return invert ? 1 - v : v;
}
export const LEVELS_KEYS: LevelsKeys = { black: "black", white: "white", gamma: "gamma", blackSoft: "black_soft", whiteSoft: "white_soft" };

export function LevelsEditor({
  state,
  node,
  dispatch,
  width = 272,
  histogramSrc,
  bins: binsGiven,
  keys = LEVELS_KEYS,
  falloff = true,
  testPrefix = "levels",
  hint,
  window: band,
  label = "Levels histogram",
}: {
  state?: State;
  node: NodeCard;
  dispatch: D;
  width?: number;
  histogramSrc?: string;
  /** ready-made bins (0..1, 64 of them) instead of a frame to count */
  bins?: number[] | null;
  keys?: LevelsKeys;
  /** the falloff handles and their knees; off for a plain three-handle Levels */
  falloff?: boolean;
  /** test ids: `${testPrefix}-editor`, `${testPrefix}-handle-black`... */
  testPrefix?: string;
  /** the status-line hint for the whole widget */
  hint?: string;
  /** steer a mask's window rather than a tone map (see LevelsWindow) */
  window?: LevelsWindow;
  /** the plot's accessible name */
  label?: string;
}) {
  const counted = useLumaBins(binsGiven === undefined ? histogramSrc : undefined);
  const bins = binsGiven === undefined ? counted : binsGiven;
  const H = 64;
  // An unset param reads as the registry's default for this node, the
  // same answer the sliders give, then the tone map's own neutral.
  const read = (key: string | undefined, fallback: number) =>
    key === undefined ? fallback : ((node.params[key] as number) ?? REGISTRY_DEFAULTS[node.type]?.[key] ?? fallback);
  const black = read(keys.black, 0);
  const white = read(keys.white, 1);
  const gamma = read(keys.gamma, 1);
  const feather = band ? Math.max(0, read(band.feather, 0)) : 0;
  const inverted = band?.invert ? read(band.invert, 0) !== 0 : false;
  // The falloffs, drawn where they act ("the falloff should
  // be visually represented in the graph by an interactive handle").
  // The engine's knee is half k wide each side of the point on the
  // normalized axis, k = soft/100 x 0.25, so the handle rides the
  // knee's outer edge and the shaded band is the roll itself.
  const KNEE_MAX = 0.25;
  const bsoft = falloff && !band && keys.blackSoft ? read(keys.blackSoft, 0) : 0;
  const wsoft = falloff && !band && keys.whiteSoft ? read(keys.whiteSoft, 0) : 0;
  const range = Math.max(1e-6, white - black);
  const kb = (bsoft / 100) * KNEE_MAX * range;
  const kw = (wsoft / 100) * KNEE_MAX * range;
  const svgRef = useRef<SVGSVGElement>(null);
  const drag = useRef<"black" | "white" | "gamma" | "bsoft" | "wsoft" | null>(null);

  // The plot is inset, because the handles have width and the extreme
  // values do not. Drawn edge to edge, a white point of 1 put its marker
  // at exactly `width`: half the triangle and half the 14px hit area fell
  // outside the SVG, so it could not be grabbed ("the handle
  // for White point and White falloff are just off the canvas and can't
  // be grabbed by the mouse"). Black at 0 had the same fault at the other
  // end. PAD is half the widest hit area plus a pixel, so 0 and 1 are
  // both fully reachable. 12, not 7: the falloff handle has the widest
  // hit area of the five, at 11px each side.
  const PAD = LEVELS_PAD;
  const plotW = Math.max(1, width - PAD * 2);
  const xOf = (v: number) => PAD + v * plotW;
  // The gamma handle sits at the input that maps to middle gray.
  const gammaX = () => xOf(black + (white - black) * Math.pow(0.5, gamma));

  const valueAt = (clientX: number) => {
    const rect = svgRef.current!.getBoundingClientRect();
    const scale = rect.width / width;
    const pad = PAD * scale;
    const span = Math.max(1e-6, rect.width - pad * 2);
    return Math.min(1, Math.max(0, (clientX - rect.left - pad) / span));
  };

  const write = (param: string, value: number) =>
    dispatch({ type: "set_param", id: node.id, param, value });

  const onPointerDown = (which: "black" | "white" | "gamma" | "bsoft" | "wsoft") => (e: React.PointerEvent) => {
    e.preventDefault();
    e.stopPropagation();
    drag.current = which;
    const param = band && (which === "bsoft" || which === "wsoft")
      ? band.feather
      : which === "bsoft" ? (keys.blackSoft ?? "black_soft") : which === "wsoft" ? (keys.whiteSoft ?? "white_soft") : (keys[which] ?? which);
    dispatch({ type: "begin_gesture", key: `${node.id}.${param}` });
    const move = (ev: PointerEvent) => {
      const v = valueAt(ev.clientX);
      const cur = drag.current;
      if (cur === "black") write(keys.black, band ? v : Math.max(0, Math.min(v, white - 0.02)));
      else if (cur === "white") write(keys.white, band ? v : Math.min(1, Math.max(v, black + 0.02)));
      else if (band && cur === "bsoft") {
        // The window's one feather, from whichever edge is dragged: the
        // distance out from that edge, on the axis's own scale.
        write(band.feather, Math.min(1, Math.max(0, black - v)));
      } else if (band && cur === "wsoft") {
        write(band.feather, Math.min(1, Math.max(0, v - white)));
      } else if (cur === "gamma" && keys.gamma) {
        // Invert the middle-gray placement: t in (0,1) across the
        // black..white span becomes gamma = log(t)/log(0.5).
        const t = Math.min(0.98, Math.max(0.02, (v - black) / Math.max(1e-3, white - black)));
        write(keys.gamma, Math.min(4, Math.max(0.25, Math.log(t) / Math.log(0.5))));
      } else if (cur === "bsoft" && keys.blackSoft) {
        // The handle is the knee's outer edge: distance from the black
        // point, in knee units, back to the 0..100 dial.
        const t = Math.min(KNEE_MAX, Math.max(0, (v - black) / range));
        write(keys.blackSoft, Math.round((t / KNEE_MAX) * 100));
      } else if (cur === "wsoft" && keys.whiteSoft) {
        const t = Math.min(KNEE_MAX, Math.max(0, (white - v) / range));
        write(keys.whiteSoft, Math.round((t / KNEE_MAX) * 100));
      }
    };
    const up = () => {
      drag.current = null;
      dispatch({ type: "end_gesture" });
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  const handle = (
    which: "black" | "white" | "gamma",
    x: number,
    fill: string,
  ) => (
    <g
      key={which}
      data-testid={`${testPrefix}-handle-${which}`}
      style={{ cursor: "ew-resize", pointerEvents: "all" }}
      onPointerDown={onPointerDown(which)}
    >
      {/* A generous invisible hit area over a small visible marker.
          Black and white leave the top strip alone: that corner
          belongs to their falloff handle, which draws underneath. */}
      <rect
        x={x - 7}
        y={which === "gamma" ? 0 : 24}
        width={14}
        height={which === "gamma" ? H + 12 : H - 12}
        fill="transparent"
      />
      <path d={`M ${x - 5} ${H + 10} L ${x + 5} ${H + 10} L ${x} ${H + 2} Z`} fill={fill} stroke="#111214" strokeWidth="0.75" />
      <line x1={x} y1={0} x2={x} y2={H} stroke={fill} strokeWidth="1" opacity="0.5" />
    </g>
  );

  // The falloff handles hang from the TOP edge, at the knee's outer
  // edge, so they never fight the baseline triangles for the pointer: at
  // zero falloff each sits directly above its point, one drag away. The
  // marker keeps clear of the plot's edges (a black point at 0 put the
  // handle half off the canvas) and the hit area is a whole corner of
  // the plot, so grabbing one does not need the falloff moved out by
  // slider first ("I wish it was easier to grab").
  const softHandle = (which: "bsoft" | "wsoft", x: number) => {
    // No clamp any more: PAD already keeps this inside the SVG, and a
    // second clamp here would slide the marker off the value it marks.
    const hx = x;
    return (
      <g
        key={which}
        data-testid={`${testPrefix}-handle-${which === "bsoft" ? "black-soft" : "white-soft"}`}
        style={{ cursor: "ew-resize", pointerEvents: "all" }}
        onPointerDown={onPointerDown(which)}
      >
        <rect x={hx - 11} y={0} width={22} height={22} fill="transparent" />
        <line x1={hx} y1={0} x2={hx} y2={H} stroke="var(--accent)" strokeWidth="1" opacity="0.45" strokeDasharray="2 3" />
        <path d={`M ${hx - 5} 0 L ${hx + 5} 0 L ${hx} 8 Z`} fill="var(--accent)" stroke="#111214" strokeWidth="0.75" />
      </g>
    );
  };

  void state;
  const clamp01 = (v: number) => Math.min(1, Math.max(0, v));
  // The window's response across the axis, for the shaded area.
  const response = band
    ? Array.from({ length: 97 }, (_, i) => {
        const l = i / 96;
        return `${i === 0 ? "M" : "L"} ${xOf(l).toFixed(2)} ${((1 - windowWeight(l, black, white, feather, inverted)) * H).toFixed(2)}`;
      }).join(" ")
    : "";
  return (
    <svg
      ref={svgRef}
      data-testid={`${testPrefix}-editor`}
      data-hint={hint}
      width={width}
      height={H + 14}
      style={{ display: "block", maxWidth: "100%", touchAction: "none" }}
      aria-label={label}
    >
      {/* The well is the axis, not the whole SVG. The inset that gives the end
handles room to hang has to move the well with it, or a black point
of 0 draws its marker 12px inside the well's own left edge and reads
as offset (the owner, with the panel reset). The SVG keeps its full
width; the margin either side is where the handles at 0 and 1 put
their hit areas.*/}
      <rect x={PAD} y={0} width={plotW} height={H} fill="#111214" />
      {bins &&
        bins.map((b, i) => (
          <rect
            key={i}
            x={PAD + (i / bins.length) * plotW}
            y={(1 - b) * H}
            width={Math.max(1, plotW / bins.length - 0.5)}
            height={b * H}
            fill="#33383c"
          />
        ))}
      {/* The tones the window selects: each bar lit by what the mask
          takes at its tone, and the mask's response drawn over the
          well, so Invert visibly swaps the side. */}
      {band && bins &&
        bins.map((b, i) => {
          const weight = windowWeight((i + 0.5) / bins.length, black, white, feather, inverted);
          return (
            <rect
              key={`sel${i}`}
              data-testid={`${testPrefix}-selected-${i}`}
              data-weight={weight.toFixed(3)}
              x={PAD + (i / bins.length) * plotW}
              y={(1 - b) * H}
              width={Math.max(1, plotW / bins.length - 0.5)}
              height={b * H}
              fill="var(--accent)"
              opacity={0.55 * weight}
            />
          );
        })}
      {band && (
        <g data-testid={`${testPrefix}-response`} data-inverted={inverted} pointerEvents="none">
          <path d={`${response} L ${xOf(1)} ${H} L ${xOf(0)} ${H} Z`} fill="var(--accent)" opacity={0.1} />
          <path d={response} fill="none" stroke="var(--accent)" strokeWidth="1" opacity={0.6} />
        </g>
      )}
      {/* The knee zones, shaded where the roll actually happens:
          half k each side of the point. */}
      {falloff && kb > 0 && (
        <rect
          x={Math.max(PAD, xOf(black - kb))}
          y={0}
          width={Math.min(width - PAD, xOf(black + kb)) - Math.max(PAD, xOf(black - kb))}
          height={H}
          fill="var(--accent)"
          opacity={0.12}
        />
      )}
      {falloff && kw > 0 && (
        <rect
          x={Math.max(PAD, xOf(white - kw))}
          y={0}
          width={Math.min(width - PAD, xOf(white + kw)) - Math.max(PAD, xOf(white - kw))}
          height={H}
          fill="var(--accent)"
          opacity={0.12}
        />
      )}
      {falloff && softHandle("bsoft", band ? xOf(clamp01(black - feather)) : xOf(black + kb))}
      {falloff && softHandle("wsoft", band ? xOf(clamp01(white + feather)) : xOf(white - kw))}
      {/* The black triangle wore near-black on a near-black well and
vanished ("not consistent with the white point
handles, which are preferred"). All three ride the same light
dress now; which is which is what their position says.*/}
      {handle("black", xOf(black), "var(--accent)")}
      {keys.gamma && handle("gamma", gammaX(), "var(--accent)")}
      {handle("white", xOf(white), "var(--accent)")}
    </svg>
  );
}
