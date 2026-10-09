// The two-input surface editor: a grid of hue across and luminance up,
// one output. Each cell is a value in the output's units; drag a cell
// up or down to set it, SHIFT snaps, ALT-click or double-click clears
// it. Where a pair of curves multiplies two separate answers, a cell
// answers the pair of coordinates directly: "protect skin in the
// highlights, boost the same hue in the shadows" is two cells.

import { modLabel } from "../platform";
import React, { useRef, useState } from "react";
import type { Command, NodeCard } from "../state";
import {
  SURFACE_COLS,
  SURFACE_EV,
  SURFACE_ROWS,
  emptySurface,
  parseRecolorSurfaces,
  serializeRecolorSurfaces,
  type SurfaceId,
} from "../eqcurve";
import { EQ_PLOT_INSET } from "./eqeditor";

type D = React.Dispatch<Command>;

const PAD = { l: EQ_PLOT_INSET, r: 8, t: 6, b: 16 };

export function SurfaceEditor({
  node,
  dispatch,
  width = 272,
  height = 160,
  id,
  range,
  unit,
  snap,
}: {
  node: NodeCard;
  dispatch: D;
  width?: number;
  height?: number;
  id: SurfaceId;
  range: [number, number];
  unit: string;
  snap: number;
}) {
  const surfaces = parseRecolorSurfaces(node.textParams?.surfaces);
  const grid = surfaces[id] ?? emptySurface();
  const plotW = width - PAD.l - PAD.r;
  const plotH = height - PAD.t - PAD.b;
  const cw = plotW / SURFACE_COLS;
  const ch = plotH / SURFACE_ROWS;
  const [hover, setHover] = useState<[number, number] | null>(null);
  const drag = useRef<{ r: number; c: number; startY: number; start: number } | null>(null);

  const write = (next: number[][]) =>
    dispatch({
      type: "set_text_param",
      id: node.id,
      param: "surfaces",
      value: serializeRecolorSurfaces({ ...surfaces, [id]: next }),
    });
  const setCell = (r: number, c: number, v: number) => {
    const next = grid.map((row) => [...row]);
    next[r][c] = Math.max(range[0], Math.min(range[1], v));
    write(next);
  };

  // Row 0 of the grid is EV -6 and draws at the BOTTOM: up is brighter.
  const rowY = (r: number) => PAD.t + (SURFACE_ROWS - 1 - r) * ch;

  return (
    <div data-testid="surface-editor" style={{ position: "relative", userSelect: "none" }}>
      <svg
        width={width}
        height={height}
        viewBox={`0 0 ${width} ${height}`}
        style={{ display: "block", maxWidth: "100%" }}
        onContextMenu={(e) => e.preventDefault()}
        onMouseLeave={() => setHover(null)}
      >
        <defs>
          <linearGradient id="surface-hue" x1="0" y1="0" x2="1" y2="0">
            {[0, 60, 120, 180, 240, 300, 360].map((h) => (
              <stop key={h} offset={`${(h / 360) * 100}%`} stopColor={`hsl(${h} 90% 55%)`} />
            ))}
          </linearGradient>
          <linearGradient id="surface-lum" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#fff" stopOpacity="0.55" />
            <stop offset="50%" stopColor="#000" stopOpacity="0" />
            <stop offset="100%" stopColor="#000" stopOpacity="0.75" />
          </linearGradient>
        </defs>
        <rect x={PAD.l} y={PAD.t} width={plotW} height={plotH} fill="#131211" />
        <g opacity={0.35}>
          <rect x={PAD.l} y={PAD.t} width={plotW} height={plotH} fill="url(#surface-hue)" />
          <rect x={PAD.l} y={PAD.t} width={plotW} height={plotH} fill="url(#surface-lum)" />
        </g>
        {grid.map((row, r) =>
          row.map((v, c) => {
            const a = Math.min(1, Math.abs(v) / Math.max(1e-6, Math.max(Math.abs(range[0]), range[1])));
            const on = v !== 0;
            const isHover = hover?.[0] === r && hover?.[1] === c;
            return (
              <g key={`${r}-${c}`}>
                <rect
                  data-testid={`surface-cell-${r}-${c}`}
                  x={PAD.l + c * cw}
                  y={rowY(r)}
                  width={cw}
                  height={ch}
                  fill={v > 0 ? `rgba(53,184,224,${0.15 + 0.7 * a})` : v < 0 ? `rgba(208,52,44,${0.15 + 0.7 * a})` : "transparent"}
                  stroke={isHover ? "#e6e1dc" : "rgba(255,255,255,.12)"}
                  strokeWidth={isHover ? 1 : 0.5}
                  style={{ cursor: "ns-resize" }}
                  onMouseEnter={() => setHover([r, c])}
                  onDoubleClick={() => setCell(r, c, 0)}
                  onMouseDown={(e) => {
                    if (e.button !== 0) return;
                    e.preventDefault();
                    if (e.altKey) {
                      setCell(r, c, 0);
                      return;
                    }
                    drag.current = { r, c, startY: e.clientY, start: v };
                    dispatch({ type: "begin_gesture", key: `${node.id}.surfaces` });
                    const move = (ev: MouseEvent) => {
                      const d = drag.current;
                      if (!d) return;
                      let value = d.start + ((d.startY - ev.clientY) / 160) * (range[1] - range[0]);
                      if (ev.shiftKey) value = Math.round(value / snap) * snap;
                      setCell(d.r, d.c, value);
                    };
                    const up = () => {
                      window.removeEventListener("mousemove", move);
                      window.removeEventListener("mouseup", up);
                      drag.current = null;
                      dispatch({ type: "end_gesture" });
                    };
                    window.addEventListener("mousemove", move);
                    window.addEventListener("mouseup", up);
                  }}
                />
                {on && cw > 18 && (
                  <text
                    x={PAD.l + c * cw + cw / 2}
                    y={rowY(r) + ch / 2 + 3}
                    textAnchor="middle"
                    fontSize={8}
                    fill="#f2efe9"
                    style={{ pointerEvents: "none" }}
                  >
                    {Math.round(v)}
                  </text>
                )}
              </g>
            );
          }),
        )}
        {/* Axes: hue every 60° along the bottom, EV up the left. */}
        {[0, 60, 120, 180, 240, 300, 360].map((h) => (
          <text
            key={h}
            x={PAD.l + (h / 360) * plotW}
            y={height - 4}
            textAnchor={h === 0 ? "start" : h === 360 ? "end" : "middle"}
            fontSize={7}
            fill="var(--text-ghost)"
          >
            {h}°
          </text>
        ))}
        {SURFACE_EV.map((ev, r) => (
          <text
            key={r}
            x={PAD.l - 4}
            y={rowY(r) + ch / 2 + 3}
            textAnchor="end"
            fontSize={7}
            fill="var(--text-ghost)"
          >
            {ev > 0 ? `+${ev}` : `${ev}`}
          </text>
        ))}
      </svg>
      <div style={{ fontSize: 9, color: "var(--text-ghost)", paddingLeft: PAD.l, lineHeight: 1.5 }}>
        {hover
          ? `hue ${hover[1] * 30}° at ${SURFACE_EV[hover[0]] >= 0 ? "+" : ""}${SURFACE_EV[hover[0]].toFixed(2)} EV: ${Math.round(grid[hover[0]][hover[1]])}${unit}`
          : `Drag a cell up or down · ${modLabel("shift")} snaps · ${modLabel("alt")}-click or 2×click clears`}
      </div>
    </div>
  );
}
