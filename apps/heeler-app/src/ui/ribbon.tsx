// An interactive color ribbon: stops are handles you drag along the
// bar to place, each with a swatch beneath it that opens Heeler's own
// picker, a click on the bar adds a stop in the color the ribbon has
// there, and an X above each stop removes it. "an
// interactive gradient ribbon, where I could grab the end stops and
// drag them to set the location. The stops would have a color swatch
// on the bottom we click on to set the color. Click in the ribbon to
// add more color points, there is an X on top to remove the color
// point."
//
// Stops keep their STORED order while edited, so a handle dragged past
// its neighbor stays the handle under the pointer; the preview and
// every consumer sort for themselves.

import { useRef, useState } from "react";
import { ColorField, hexToRgb255 } from "./colorfield";
import { previewCss, type GradStop } from "./gradientstops";
import { ValueField } from "./track";

const HANDLE = 14;

/** The ribbon's color at `pos`, between its neighboring stops. */
export function ribbonColorAt(stops: GradStop[], pos: number): string {
  const sorted = [...stops].sort((a, b) => a.pos - b.pos);
  if (!sorted.length) return "#808080";
  if (pos <= sorted[0].pos) return sorted[0].color;
  const last = sorted[sorted.length - 1];
  if (pos >= last.pos) return last.color;
  for (let i = 0; i < sorted.length - 1; i++) {
    const a = sorted[i];
    const b = sorted[i + 1];
    if (pos < a.pos || pos > b.pos) continue;
    const t = (pos - a.pos) / Math.max(1e-6, b.pos - a.pos);
    const ca = hexToRgb255(a.color);
    const cb = hexToRgb255(b.color);
    const mix = ca.map((v, k) => Math.round(v + (cb[k] - v) * t));
    return `#${mix.map((v) => v.toString(16).padStart(2, "0")).join("")}`;
  }
  return last.color;
}

export function RibbonEditor({
  stops,
  onChange,
  onBegin,
  onEnd,
  testid,
  minStops = 2,
}: {
  stops: GradStop[];
  onChange: (next: GradStop[]) => void;
  /** gesture brackets around a handle drag, so it is one undo step */
  onBegin?: () => void;
  onEnd?: () => void;
  testid: string;
  minStops?: number;
}) {
  const bar = useRef<HTMLDivElement>(null);
  const [selected, setSelected] = useState<number | null>(null);
  const drag = useRef<{ index: number; moved: boolean } | null>(null);
  const posOf = (clientX: number): number => {
    const r = bar.current?.getBoundingClientRect();
    if (!r || r.width <= 0) return 50;
    return Math.round(Math.max(0, Math.min(100, ((clientX - r.left) / r.width) * 100)));
  };
  const put = (i: number, patch: Partial<GradStop>) => onChange(stops.map((s, j) => (j === i ? { ...s, ...patch } : s)));
  const sorted = [...stops].sort((a, b) => a.pos - b.pos);
  return (
    <div data-testid={testid} style={{ display: "flex", flexDirection: "column", gap: 0, userSelect: "none" }}>
      {/* The X row: one above each stop, only while a stop can go. */}
      <div style={{ position: "relative", height: 12 }}>
        {stops.length > minStops &&
          stops.map((s, i) => (
            <button
              key={i}
              data-testid={`${testid}-remove-${i}`}
              aria-label={`Remove stop ${i + 1}`}
              data-hint="Remove this color point"
              style={{
                all: "unset",
                position: "absolute",
                left: `calc(${s.pos}% - 6px)`,
                top: 0,
                width: 12,
                height: 12,
                fontSize: 9,
                lineHeight: "12px",
                textAlign: "center",
                cursor: "pointer",
                color: "var(--text-ghost)",
              }}
              onClick={() => {
                onChange(stops.filter((_, j) => j !== i));
                setSelected(null);
              }}
            >
              {"\u2715"}
            </button>
          ))}
      </div>
      {/* The bar: click adds a stop in the color found there. */}
      <div
        ref={bar}
        data-testid={`${testid}-bar`}
        data-hint="Click to add a color point here; drag a handle below to move it"
        style={{
          height: 14,
          borderRadius: 2,
          background: previewCss(sorted),
          border: "1px solid var(--line-4)",
          cursor: "copy",
        }}
        onClick={(e) => {
          const pos = posOf(e.clientX);
          onChange([...stops, { pos, color: ribbonColorAt(stops, pos), alpha: 100, mid: 50 }]);
          setSelected(stops.length);
        }}
      />
      {/* The handles and their swatches. */}
      <div style={{ position: "relative", height: 30 }}>
        {stops.map((s, i) => (
          <div
            key={i}
            style={{
              position: "absolute",
              left: `calc(${s.pos}% - ${HANDLE / 2}px)`,
              top: 0,
              width: HANDLE,
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
            }}
          >
            <div
              data-testid={`${testid}-handle-${i}`}
              role="slider"
              aria-label={`Stop ${i + 1} position`}
              aria-valuenow={s.pos}
              aria-valuemin={0}
              aria-valuemax={100}
              data-hint="Drag to move this color point along the streak; click to select it"
              style={{
                width: 0,
                height: 0,
                borderLeft: `${HANDLE / 2}px solid transparent`,
                borderRight: `${HANDLE / 2}px solid transparent`,
                borderBottom: `8px solid ${selected === i ? "var(--accent)" : "var(--text-dim)"}`,
                cursor: "ew-resize",
                touchAction: "none",
              }}
              onPointerDown={(e) => {
                if (e.button !== 0) return;
                e.preventDefault();
                drag.current = { index: i, moved: false };
                onBegin?.();
                const move = (ev: PointerEvent) => {
                  const d = drag.current;
                  if (!d) return;
                  d.moved = true;
                  put(d.index, { pos: posOf(ev.clientX) });
                };
                const up = () => {
                  window.removeEventListener("pointermove", move);
                  window.removeEventListener("pointerup", up);
                  const d = drag.current;
                  drag.current = null;
                  onEnd?.();
                  if (d && !d.moved) setSelected(d.index);
                };
                window.addEventListener("pointermove", move);
                window.addEventListener("pointerup", up);
              }}
              onMouseDown={(e) => e.preventDefault()}
            />
            <ColorField
              testid={`${testid}-color-${i}`}
              label={`Stop ${i + 1} color`}
              hint="This color point's color"
              value={s.color}
              width={HANDLE}
              onChange={(hex) => put(i, { color: hex })}
            />
          </div>
        ))}
      </div>
      {/* The selected stop's opacity: how much of the streak shows
          there, which is also how a ribbon fades the streak out. */}
      {selected !== null && stops[selected] && (
        <div style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 9, color: "var(--text-faint)" }}>
          <span>{`Point ${selected + 1} at ${stops[selected].pos}%, opacity`}</span>
          <ValueField
            param={`${testid}-alpha-${selected}`}
            value={Math.round(stops[selected].alpha)}
            lo={0}
            hi={100}
            display={(v) => `${Math.round(v)}%`}
            onCommit={(v) => put(selected, { alpha: Math.round(v) })}
          />
        </div>
      )}
    </div>
  );
}
