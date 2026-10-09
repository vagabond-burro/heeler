// The View Transform's curve face (proposal §3.3, the parked half of
// M5.4): the display rendering as a drawn, grabbable curve instead of
// three abstract sliders.
//
// The plot is scene EV across (the photographic axis, graticules every
// two stops, mid-gray at zero) against encoded display up. The two
// range bars are the point of the widget: the bottom strip shows the
// SCENE range as the light it is, the right strip shows the DISPLAY
// range the curve must land it in: the whole job of a view transform,
// visible as geometry. Dragging the curve moves the exposure trim
// (sideways) and, on the sigmoid, the contrast (up and down); the
// filmic white point is its own marker on the top edge. The sliders
// below the face stay for typed precision; the face and they edit the
// same params, so neither can lie about the other.

import React, { useRef } from "react";
import type { Command, NodeCard } from "../state";
import { vtCurve, vtToDisplay, type VtParams } from "../viewtransform";

type D = (c: Command) => void;

const EV_MIN = -10;
const EV_MAX = 8;

function paramsOf(node: NodeCard): VtParams {
  return {
    mode: node.textParams?.mode ?? "sigmoid",
    exposure_ev: node.params.exposure_ev ?? 0,
    contrast: node.params.contrast ?? 100,
    white_ev: node.params.white_ev ?? 6,
  };
}

export function ViewTransformFace({
  node,
  dispatch,
  width = 280,
}: {
  node: NodeCard;
  dispatch: D;
  width?: number;
}) {
  const p = paramsOf(node);
  const plotW = width - 22;
  const plotH = 118;
  const barH = 8;
  const h = plotH + barH + 4;
  const pxPerEv = plotW / (EV_MAX - EV_MIN);
  const evX = (ev: number) => (ev - EV_MIN) * pxPerEv;
  const outY = (v: number) => plotH - vtToDisplay(v) * plotH;
  const svgRef = useRef<SVGSVGElement | null>(null);

  const samples: string[] = [];
  for (let ev = EV_MIN; ev <= EV_MAX + 1e-6; ev += 0.2) {
    const v = vtCurve(p, 0.18 * Math.pow(2, ev));
    samples.push(`${evX(ev).toFixed(1)},${outY(v).toFixed(1)}`);
  }

  // The scene strip: each stop painted as the light it is, clipped at
  // display white, which is exactly the story: the scene axis runs
  // stops past what the display can say, and the curve is the
  // negotiation between the two bars.
  const sceneStops: React.ReactNode[] = [];
  for (let ev = EV_MIN; ev < EV_MAX; ev += 0.5) {
    const g = Math.round(Math.min(1, Math.max(0, vtToDisplay(0.18 * Math.pow(2, ev)))) * 255);
    sceneStops.push(
      <rect
        key={ev}
        x={evX(ev)}
        y={plotH + 4}
        width={pxPerEv / 2 + 0.5}
        height={barH}
        fill={`rgb(${g},${g},${g})`}
      />,
    );
  }
  const displayRamp: React.ReactNode[] = [];
  for (let i = 0; i < 24; i++) {
    const g = Math.round(vtToDisplay(Math.pow((23 - i + 0.5) / 24, 2.2)) * 255);
    displayRamp.push(
      <rect key={i} x={plotW + 4} y={(i * plotH) / 24} width={barH} height={plotH / 24 + 0.5} fill={`rgb(${g},${g},${g})`} />,
    );
  }

  const drag = (
    ev: React.MouseEvent,
    apply: (dxEv: number, dy: number, start: VtParams) => Record<string, number>,
  ) => {
    ev.preventDefault();
    ev.stopPropagation();
    const start = paramsOf(node);
    const sx = ev.clientX;
    const sy = ev.clientY;
    dispatch({ type: "begin_gesture", key: `${node.id}.face` });
    const move = (m: MouseEvent) => {
      const values = apply((m.clientX - sx) / pxPerEv, m.clientY - sy, start);
      dispatch({ type: "set_params", id: node.id, values });
    };
    const up = () => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
  };

  const round1 = (v: number) => Math.round(v * 10) / 10;
  return (
    <div style={{ margin: "2px 0 6px" }}>
      <svg
        ref={svgRef}
        data-testid="vt-face"
        width={width}
        height={h}
        style={{ display: "block", background: "#181614", border: "1px solid var(--line-4)" }}
      >
        {/* EV graticules, mid-gray strongest: the same honest axis the
            scopes use. */}
        {[-8, -6, -4, -2, 0, 2, 4, 6].map((ev) => (
          <line
            key={ev}
            x1={evX(ev)}
            x2={evX(ev)}
            y1={0}
            y2={plotH}
            stroke={ev === 0 ? "#44474a" : "#25282b"}
          />
        ))}
        {[0.25, 0.5, 0.75].map((f) => (
          <line key={f} x1={0} x2={plotW} y1={plotH * f} y2={plotH * f} stroke="#192023" />
        ))}
        {sceneStops}
        {displayRamp}
        <polyline points={samples.join(" ")} fill="none" stroke="var(--accent)" strokeWidth={1.6} />
        {/* Mid-gray: where 18% lands. */}
        <circle
          cx={evX(-p.exposure_ev)}
          cy={outY(vtCurve(p, 0.18 * Math.pow(2, -p.exposure_ev)))}
          r={3}
          fill="var(--accent)"
          stroke="#181614"
        />
        {/* The filmic white point rides the top edge; the other modes
            own their shoulder. */}
        {p.mode === "filmic" && (
          <polygon
            data-testid="vt-white"
            points={`${evX(p.white_ev - p.exposure_ev) - 5},1 ${evX(p.white_ev - p.exposure_ev) + 5},1 ${evX(p.white_ev - p.exposure_ev)},9`}
            fill="#c2c7cd"
            style={{ cursor: "ew-resize" }}
            onMouseDown={(ev) =>
              drag(ev, (dxEv, _dy, start) => ({
                white_ev: Math.min(10, Math.max(1, round1(start.white_ev + dxEv))),
              }))
            }
          />
        )}
        {/* The grab surface: sideways is the exposure trim (pull the
            curve where the light should sit), vertical is contrast on
            the sigmoid. */}
        <rect
          data-testid="vt-grab"
          x={0}
          y={0}
          width={plotW}
          height={plotH}
          fill="transparent"
          style={{ cursor: p.mode === "sigmoid" ? "move" : "ew-resize" }}
          onMouseDown={(ev) =>
            drag(ev, (dxEv, dy, start) => {
              const values: Record<string, number> = {
                // Pulling the curve right means the same picture needs
                // more light: the trim goes DOWN.
                exposure_ev: Math.min(4, Math.max(-4, round1(start.exposure_ev - dxEv))),
              };
              if (start.mode === "sigmoid") {
                values.contrast = Math.min(300, Math.max(25, Math.round(start.contrast - dy * 1.5)));
              }
              return values;
            })
          }
        />
      </svg>
      <div
        data-testid="vt-readout"
        style={{ display: "flex", gap: 10, fontSize: 9, letterSpacing: ".1em", color: "var(--text-faint)", marginTop: 3 }}
      >
        <span>EV {p.exposure_ev >= 0 ? "+" : ""}{p.exposure_ev.toFixed(1)}</span>
        {p.mode === "sigmoid" && <span>CONTRAST {Math.round(p.contrast)}</span>}
        {p.mode === "filmic" && <span>WHITE +{p.white_ev.toFixed(1)} EV</span>}
        <span style={{ marginLeft: "auto" }}>{p.mode.toUpperCase()}</span>
      </div>
    </div>
  );
}
