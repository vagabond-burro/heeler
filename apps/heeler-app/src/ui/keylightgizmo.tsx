import { isPrimaryPress } from "./pointerguard";
import { useDragFollow } from "./dragfollow";
import { usePickSessions } from "../picksession";
// The Key Light rig (the owner's second field report): lights are
// TYPED - directional suns and point lamps - every light is
// first-class, the gizmo selects as well as drags, and the panel
// steers whichever light is selected. The rig lives whole in the
// node's "lights" JSON; the node's azimuth/elevation/strength params
// are only the legacy single light for graphs saved before the rig
// existed.
//
// Gizmo grammar:
// - a DIRECTIONAL light is a line from its target (diamond, draggable:
// "I should be able to change the target position") to its
// handle (disc): drag the disc to aim, drag the diamond to move the
// whole rig;
// - a POINT light is a single disc IN the scene with a dashed range
// ring: drag it where the lamp sits; when selected, a grip rides the
// ring at 45 degrees and dragging it IS the Reach dial;
// - click selects (the panel's controls follow), ALT-drag changes
// strength through zero into the dark, SHIFT-click deletes.

import { DirectionalLightIcon, PointLightIcon } from "./panelicons";
import React, { useLayoutEffect, useRef, useState } from "react";
import { toolNode, type Command, type NodeCard, type State } from "../state";
import { depthAt } from "../bridge";
import { reportToolError } from "./hints";
import { ColorField } from "./colorfield";
import { resolveLineColor, useAutoLineColor } from "./linecolor";
import { lineColorCss } from "../gridwarp";
import { TrackSlider, ValueField } from "./track";
import { MenuField } from "./menufield";

type D = React.Dispatch<Command>;

const RIM = 0.42;

export type KeyLight = {
  kind: "directional" | "point";
  azimuth: number;
  elevation: number;
  strength: number;
  /** Off keeps the light's settings without its push. */
  on: boolean;
  /** Display hex; white is neutral. */
  color: string;
  /** directional: the target the gizmo anchors on (display only). */
  tx: number;
  ty: number;
  /** point: where the lamp sits, its place along the near-far axis (0
   * nearest, 100 farthest - "height is actually depth"),
   * and how far its push reaches.*/
  px: number;
  py: number;
  depth: number;
  range: number;
  /** directional: the plane it lands hardest on along the near-far axis
   * (0 nearest, the light as it always was; 100 farthest), and how far
   * it carries along depth from there (50 the falloff it always had, 100
   * every plane alike). Its own pair, not the lamp's: every saved
   * directional light carries the lamp's default depth of 30, which goes
   * on meaning nothing to it (2026-10-03: "We added a depth slider for
   * point light but not directional").*/
  sun_depth: number;
  sun_reach: number;
  /** the Lens Flare section draws this light's flare*/
  flare: boolean;
  /** this light's flare intensity, relative to the section's */
  flare_strength: number;
};

const LIGHT_DEFAULTS: Omit<KeyLight, "azimuth" | "elevation" | "strength"> = {
  kind: "directional",
  on: true,
  color: "#ffffff",
  tx: 0.5,
  ty: 0.5,
  px: 0.5,
  py: 0.5,
  depth: 30,
  range: 50,
  sun_depth: 0,
  sun_reach: 50,
  flare: false,
  flare_strength: 100,
};

/** The rig: the lights JSON when it has any, else the node's legacy
 * single-directional params seeded into rig shape. */
export function lightsOf(node: NodeCard): KeyLight[] {
  let list: Partial<KeyLight>[] = [];
  try {
    list = JSON.parse(node.textParams?.lights ?? "[]") as Partial<KeyLight>[];
  } catch {
    list = [];
  }
  if (list.length === 0) {
    return [
      {
        ...LIGHT_DEFAULTS,
        azimuth: (node.params.azimuth as number) ?? 45,
        elevation: (node.params.elevation as number) ?? 45,
        strength: oldStrength((node.params.strength as number) ?? 0),
      },
    ];
  }
  return list.map((l) => {
    const { power, ...rest } = l as Partial<KeyLight> & { power?: number };
    return {
      ...LIGHT_DEFAULTS,
      azimuth: 45,
      elevation: 45,
      // Rigs saved under the old name carry over.
      ...("height" in rest ? { depth: (rest as { height?: number }).height } : {}),
      ...rest,
      strength: typeof power === "number" ? power : oldStrength(rest.strength ?? 0),
    };
  }) as KeyLight[];
}

/** Strength's range: -100 to 100, saved as each light's `power`
 * (2026-10-08: "it goes to 200 which is odd (vs 100) and seems
 * arbitrary... Also increase the calculated strength by 50%"); the
 * engine reads 100 as three times the light (ops_depth POWER_SCALE). */
export const STRENGTH_MAX = 100;

/** A strength saved before, on the old -200 to 200 scale, in the new
 * one: half the number, the same place on the slider, 50% stronger as
 * the owner chose (the engine reads it the same way). */
function oldStrength(saved: number): number {
  return saved / 2;
}

/** Writes the WHOLE rig. Once this runs, the JSON is the truth and
 * the legacy params go quiet (the engine's rule). */
export function writeLights(dispatch: D, node: NodeCard, lights: KeyLight[]) {
  dispatch({
    type: "set_text_param",
    id: node.id,
    param: "lights",
    // Strength is saved as power, the scale since 2026-10-08, and the
    // old key goes so nothing reads it twice.
    value: JSON.stringify(lights.map(({ strength, ...rest }) => ({ ...rest, power: strength }))),
  });
  if (lights.length === 0) {
    // Emptying the rig must not resurrect the legacy params light.
    dispatch({ type: "set_params", id: node.id, values: { strength: 0 }, text: {} });
  }
}

/** Where a light's FLARE comes from, in frame coordinates: the engine's
 * light_position, mirrored. A point lamp flares where it stands; a
 * directional light has no place, only a direction, so its flare
 * comes from where that direction meets the frame edge, its elevation
 * setting how far past the edge the source sits. Drawn in the rig so
 * the handle (an aiming control) and the source (where the flare is)
 * stop being mistaken for each other. */
export function flareSourceOf(l: KeyLight, aspect: number): [number, number] {
  if (l.kind === "point") return [l.px, l.py];
  const a = (l.azimuth * Math.PI) / 180;
  const dir: [number, number] = [Math.cos(a) / Math.max(1e-6, aspect), -Math.sin(a)];
  const tx = Math.abs(dir[0]) > 1e-6 ? 0.5 / Math.abs(dir[0]) : Infinity;
  const ty = Math.abs(dir[1]) > 1e-6 ? 0.5 / Math.abs(dir[1]) : Infinity;
  const t = Math.min(tx, ty) * (1 + (Math.min(90, Math.max(0, l.elevation)) / 90) * 0.8);
  return [0.5 + dir[0] * t, 0.5 + dir[1] * t];
}

function handlePos(l: KeyLight): [number, number] {
  if (l.kind === "point") return [l.px, l.py];
  const az = (l.azimuth * Math.PI) / 180;
  const r = ((90 - Math.min(90, Math.max(5, l.elevation))) / 85) * RIM;
  return [l.tx + Math.cos(az) * r, l.ty - Math.sin(az) * r];
}

function aimFrom(l: KeyLight, nx: number, ny: number): Partial<KeyLight> {
  const [vx, vy] = [nx - l.tx, ny - l.ty];
  const azimuth = Math.round((Math.atan2(-vy, vx) * 180) / Math.PI);
  const dist = Math.min(1, Math.hypot(vx, vy) / RIM);
  return { azimuth, elevation: Math.max(5, Math.round(90 - dist * 85)) };
}

export function KeyLightGizmo({
  state,
  dispatch,
  node,
  norm,
  previewUrl = null,
  lineWidth = 2,
}: {
  state: State;
  dispatch: D;
  node: NodeCard;
  norm: (e: { clientX: number; clientY: number }, el: HTMLElement) => [number, number];
  /** the frame on screen, for the lines' automatic color */
  previewUrl?: string | null;
  /** how thick the rig's lines and handle borders draw, in pixels: the
   * shapeLineWidth preference the shape overlays read, so the light
   * handles answer the same THICKNESS the shapes do (2026-09-15:
   * "Missing the slider to control the line thickness of the light's
   * control handles (like with shapes)"); 2 is the shipped look*/
  lineWidth?: number;
}) {
  const lights = lightsOf(node);
  // Every stroke below was drawn for a 2 px preference; the rest scale
  // with it, so the rig keeps its proportions at any thickness.
  const stroke = (base: number) => base * (Math.max(0.5, lineWidth) / 2);
  // Keep the colored center at its shipped size when borders grow. A
  // thick outline must not hide whether a lamp emits light or darkness.
  const handleSize = (size: number, border: number) => size + 2 * Math.max(0, stroke(border) - border);
  const lampSize = (l: KeyLight) => 12 + Math.min(8, (Math.abs(l.strength) / STRENGTH_MAX) * 8);
  // The rig's lines and handle borders take the LINES color every
  // overlay shares (linecolor.tsx): automatic is the opposite of the
  // photograph, so the rig reads over any scene (2026-09-13: "the same
  // logic as the warp tools to color the controls based on the scene").
  // A handle's fill keeps saying what the light is: amber emitting,
  // near-black dark, or the light's own color.
  const auto = useAutoLineColor(previewUrl);
  const line = resolveLineColor(state.lineColor, auto);
  const ink = (alpha: number) => lineColorCss(line.hue, line.luma, line.sat, alpha);
  const overlay = useRef<HTMLDivElement>(null);
  const drag = useRef<{
    index: number;
    part: "handle" | "target" | "reach";
    alt: boolean;
    startY: number;
    startStrength: number;
    reachOffset: number;
  } | null>(null);
  // The overlay's on-screen size, so the reach ring and its grip are
  // the ENGINE's circle (range/100 x 1.2 x the short side) rather than
  // an SVG percentage that only resembled it. Measured after render;
  // zoom re-renders the gizmo, which re-measures.
  const [dims, setDims] = useState<[number, number]>([0, 0]);
  useLayoutEffect(() => {
    const el = overlay.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    setDims((d) =>
      Math.abs(r.width - d[0]) > 0.5 || Math.abs(r.height - d[1]) > 0.5
        ? [r.width, r.height]
        : d,
    );
  });
  const reachPx = (l: KeyLight) =>
    (l.range / 100) * 1.2 * Math.min(dims[0], dims[1]);

  // The drag in hand's own move, and its end: the release, or a drag
  // lost to a window blur or an unmount (the 26.4.3 full review's R6),
  // which used to leave the gesture held and the light following.
  const dragMove = useRef<((ev: PointerEvent) => void) | null>(null);
  const endDrag = () => {
    if (!drag.current) return;
    drag.current = null;
    dragMove.current = null;
    dispatch({ type: "end_gesture" });
  };
  const followed = useDragFollow<PointerEvent>(
    { move: (ev) => dragMove.current?.(ev), up: endDrag, lost: endDrag },
    "pointer",
  );

  const beginDrag = (
    e: React.PointerEvent,
    index: number,
    part: "handle" | "target" | "reach",
  ) => {
    if (!isPrimaryPress(e)) return;
    e.stopPropagation();
    e.preventDefault();
    dispatch({ type: "select_keylight", index });
    if (e.shiftKey) {
      // SHIFT-click deletes ANY light ("Can't delete
      // extra lights" - now there is no second-class light to spare).
      const next = lights.filter((_, k) => k !== index);
      writeLights(dispatch, node, next);
      dispatch({ type: "select_keylight", index: null });
      return;
    }
    dispatch({ type: "begin_gesture", key: `${node.id}.lights` });
    const el = overlay.current!;
    const [sx, sy] = norm(e, el);
    const [w, h] = [el.clientWidth || 1, el.clientHeight || 1];
    const lamp = lights[index];
    drag.current = {
      index,
      part,
      alt: e.altKey,
      startY: e.clientY,
      startStrength: lamp.strength,
      // The visible grip stays outside a thick disc even at zero reach.
      // Carry that offset through the drag instead of jumping on its first move.
      reachOffset: Math.hypot((sx - lamp.px) * w, (sy - lamp.py) * h) - (lamp.range / 100) * 1.2 * Math.min(w, h),
    };
    const move = (ev: PointerEvent) => {
      const d = drag.current;
      if (!d) return;
      const cur = lightsOf(node);
      const patch: Partial<KeyLight> = {};
      if (d.alt) {
        // The same travel of the hand across the whole range as before.
        const delta = (d.startY - ev.clientY) * 0.3;
        patch.strength = Math.round(
          Math.max(-STRENGTH_MAX, Math.min(STRENGTH_MAX, d.startStrength + delta)),
        );
      } else {
        const [nx, ny] = norm(ev, el);
        const l = cur[d.index];
        if (!l) return;
        if (l.kind === "point" && d.part === "reach") {
          // Reach follows the change in distance from the lamp,
          // preserving where the grip was grabbed.
          const [w, h] = [el.clientWidth || 1, el.clientHeight || 1];
          const r = Math.hypot((nx - l.px) * w, (ny - l.py) * h);
          patch.range = Math.round(
            Math.max(0, Math.min(100, ((r - d.reachOffset) / (1.2 * Math.min(w, h))) * 100)),
          );
        } else if (l.kind === "point") {
          patch.px = nx;
          patch.py = ny;
        } else if (d.part === "target") {
          // Moving the target translates the rig; the aim stays.
          patch.tx = nx;
          patch.ty = ny;
        } else {
          Object.assign(patch, aimFrom(l, nx, ny));
        }
      }
      const next = cur.map((l, k) => (k === d.index ? { ...l, ...patch } : l));
      writeLights(dispatch, node, next);
    };
    dragMove.current = move;
    followed.start();
  };

  return (
    <div
      ref={overlay}
      data-testid="keylight-gizmo"
      style={{ position: "absolute", inset: 0, pointerEvents: "none" }}
    >
      <svg
        width="100%"
        height="100%"
        style={{ position: "absolute", inset: 0, overflow: "visible" }}
        aria-hidden="true"
      >
        {lights.map((l, i) => {
          if (l.kind === "point") {
            return (
              <circle
                key={i}
                cx={`${l.px * 100}%`}
                cy={`${l.py * 100}%`}
                r={dims[0] ? Math.max(4, reachPx(l)) : `${(l.range / 100) * 30}%`}
                fill="none"
                stroke={ink(l.strength < 0 ? 0.45 : 0.6)}
                strokeWidth={stroke(1)}
                strokeDasharray="3 4"
              />
            );
          }
          const [hx, hy] = handlePos(l);
          return (
            <g key={i}>
              <circle
                cx={`${l.tx * 100}%`}
                cy={`${l.ty * 100}%`}
                r={`${RIM * 100}%`}
                fill="none"
                stroke={ink(0.25)}
                strokeWidth={stroke(1)}
                strokeDasharray="2 5"
                style={{ display: state.keyLightSel === i ? undefined : "none" }}
              />
              <line
                x1={`${l.tx * 100}%`}
                y1={`${l.ty * 100}%`}
                x2={`${hx * 100}%`}
                y2={`${hy * 100}%`}
                stroke={ink(l.strength < 0 ? 0.6 : 0.8)}
                strokeWidth={stroke(1.2)}
              />
            </g>
          );
        })}
        {/* Where each flaring light's flare comes from: a sun marker at the
source, pinned to the frame edge with the line running out to it
when the source is off-frame, joined to the aiming handle by a
dotted line. "Does it make sense that the flare isn't
aligned with the handle?" The handle aims; this is the source.*/}
        {lights.map((l, i) => {
          if (!l.flare || !l.on) return null;
          const aspect = dims[0] && dims[1] ? dims[0] / dims[1] : 1.5;
          const [sx, sy] = flareSourceOf(l, aspect);
          const inside = sx >= 0 && sx <= 1 && sy >= 0 && sy <= 1;
          const cx = Math.min(1, Math.max(0, sx));
          const cy = Math.min(1, Math.max(0, sy));
          const [hx, hy] = l.kind === "point" ? [l.px, l.py] : handlePos(l);
          // A point lamp and its flare share a center. Keep the source
          // ring outside the enlarged disc so flaring remains visible.
          const sourceRadius = l.kind === "point"
            ? Math.max(9, handleSize(lampSize(l), state.keyLightSel === i ? 2 : 1.5) / 2 + 2 + stroke(1.5) / 2)
            : inside ? 9 : 7;
          return (
            <g key={`flare-${i}`} data-testid={`keylight-flare-source-${i}`}>
              {l.kind !== "point" && (
                <line
                  x1={`${hx * 100}%`}
                  y1={`${hy * 100}%`}
                  x2={`${cx * 100}%`}
                  y2={`${cy * 100}%`}
                  stroke={ink(0.55)}
                  strokeWidth={stroke(1)}
                  strokeDasharray="2 4"
                />
              )}
              <circle
                cx={`${cx * 100}%`}
                cy={`${cy * 100}%`}
                r={sourceRadius}
                fill="none"
                stroke={ink(0.95)}
                strokeWidth={stroke(1.5)}
                strokeDasharray={inside ? undefined : "3 3"}
              />
              <circle cx={`${cx * 100}%`} cy={`${cy * 100}%`} r={2.5} fill={ink(0.95)} />
            </g>
          );
        })}
      </svg>
      {lights.map((l, i) => {
        const dark = l.strength < 0;
        const sel = state.keyLightSel === i;
        const disc = (
          part: "handle" | "target",
          x: number,
          y: number,
          size: number,
          shape: "round" | "diamond",
        ) => {
          size = handleSize(size, sel ? 2 : 1.5);
          return (
            <div
              key={`${i}-${part}`}
              data-testid={`keylight-${part}-${i}`}
              title={
                part === "target"
                  ? `Light ${i + 1} target`
                  : `Light ${i + 1}: ${Math.round(l.strength)}${dark ? " (dark)" : ""}${l.kind === "point" ? " (point)" : ""}`
              }
              style={{
                position: "absolute",
                left: `${x * 100}%`,
                top: `${y * 100}%`,
                width: size,
                height: size,
                marginLeft: -size / 2,
                marginTop: -size / 2,
                cursor: "grab",
                pointerEvents: "auto",
                borderRadius: shape === "round" ? "50%" : 2,
                transform: shape === "diamond" ? "rotate(45deg)" : undefined,
                opacity: l.on ? 1 : 0.35,
                background:
                  part === "target"
                    ? "rgba(255,255,255,.75)"
                    : dark
                      ? "rgba(20,20,26,.9)"
                      : l.color.toLowerCase() === "#ffffff"
                        ? "rgba(224,162,71,.9)"
                        : l.color,
                border: `${stroke(sel ? 2 : 1.5)}px solid ${ink(sel ? 1 : 0.9)}`,
                boxShadow: sel ? `0 0 0 2px ${ink(0.35)}` : `0 0 8px ${ink(0.45)}`,
              }}
              onPointerDown={(e) => beginDrag(e, i, part)}
            />
          );
        };
        const size = lampSize(l);
        if (l.kind === "point") {
          // The selected lamp wears a grip on its ring ("drag the
          // handle for Point light > Reach instead of having to use the
          // slider"). At 45 degrees so it never hides under the lamp disc,
          // even at reach 0.
          const grip =
            sel && dims[0]
              ? (() => {
                  const gripSize = handleSize(9, 1.5);
                  const r = Math.max(gripSize, handleSize(size, 2) / 2 + gripSize / Math.SQRT2 + 2, reachPx(l));
                  const gx = l.px + (r * Math.SQRT1_2) / dims[0];
                  const gy = l.py + (r * Math.SQRT1_2) / dims[1];
                  return (
                    <div
                      key={`${i}-reach`}
                      data-testid={`keylight-reach-${i}`}
                      title={`Light ${i + 1} reach: ${Math.round(l.range)}`}
                      style={{
                        position: "absolute",
                        left: `${gx * 100}%`,
                        top: `${gy * 100}%`,
                        width: gripSize,
                        height: gripSize,
                        marginLeft: -gripSize / 2,
                        marginTop: -gripSize / 2,
                        cursor: "ew-resize",
                        pointerEvents: "auto",
                        borderRadius: 2,
                        transform: "rotate(45deg)",
                        background: dark ? "rgba(20,20,26,.9)" : "rgba(224,162,71,.9)",
                        border: `${stroke(1.5)}px solid ${ink(0.9)}`,
                      }}
                      onPointerDown={(e) => beginDrag(e, i, "reach")}
                    />
                  );
                })()
              : null;
          return (
            <React.Fragment key={i}>
              {disc("handle", l.px, l.py, size, "round")}
              {grip}
            </React.Fragment>
          );
        }
        const [hx, hy] = handlePos(l);
        return (
          <React.Fragment key={i}>
            {disc("target", l.tx, l.ty, 9, "diamond")}
            {disc("handle", hx, hy, size, "round")}
          </React.Fragment>
        );
      })}
    </div>
  );
}

/** The selected light's controls, seated in the Key Light section:
 * type, strength, the point light's depth and reach, and the
 * directional light's elevation, depth and reach. Every light is
 * first-class here ("Added lights share same properties
 * as the original").*/
export function KeyLightControls({
  state,
  dispatch,
  node,
}: {
  state: State;
  dispatch: D;
  node: NodeCard;
}) {
  const picks = usePickSessions(state, dispatch);
  const lights = lightsOf(node);
  const sel = state.keyLightSel;
  // The dropdown is the roster ("easier to move between
  // lights if the lights were in a dropdown"): every light by number and
  // kind, pickable without hunting its disc in the viewport. It renders
  // even with nothing selected, as the way IN.
  const roster = (
    <MenuField
      testid="keylight-roster"
      label="Which light the controls steer"
      hint="Pick which light these controls steer; clicking a light in the photo does the same"
      size="regular"
      value={sel === null ? "" : String(sel)}
      placeholder="Select a light…"
      options={lights.map((k, i) => ({
        id: String(i),
        label: `Light ${i + 1} · ${k.kind === "point" ? "point" : "directional"}${k.strength < 0 ? " (dark)" : ""}${k.on ? "" : " (off)"}`,
      }))}
      onChange={(id) => dispatch({ type: "select_keylight", index: Number(id) })}
    />
  );
  if (sel === null || !lights[sel]) {
    return (
      <div
        data-testid="keylight-selected"
        style={{ display: "flex", gap: 6, alignItems: "center", margin: "2px 0 6px" }}
      >
        {roster}
      </div>
    );
  }
  const l = lights[sel];
  const put = (patch: Partial<KeyLight>) =>
    writeLights(
      dispatch,
      node,
      lights.map((k, i) => (i === sel ? { ...k, ...patch } : k)),
    );
  // THE house slider, not an imitation of it: TrackSlider is the same
  // rail/fill/handle every develop row renders, bound here to the
  // selected light's JSON instead of a node param. The owner caught
  // the native <input type=range> impostor by screenshot.
  const slider = (
    label: string,
    testid: string,
    value: number,
    min: number,
    max: number,
    write: (v: number) => void,
    hint?: string,
  ) => (
    <div className="srow" data-hint={hint}>
      <div className="lbl">{label}</div>
      <TrackSlider
        label={label}
        testid={testid}
        value={value}
        lo={min}
        hi={max}
        centered={min < 0}
        onBegin={() => dispatch({ type: "begin_gesture", key: `${node.id}.lights` })}
        onChange={(v) => write(Math.round(v))}
        onEnd={() => dispatch({ type: "end_gesture" })}
      />
      {/* The readout is a field, like every develop row's
("Can't type values straight in"). One write is one undo step.*/}
      <ValueField
        param={testid}
        value={Math.round(value)}
        lo={min}
        hi={max}
        display={(v) => String(Math.round(v))}
        onCommit={(v) => write(Math.round(v))}
      />
    </div>
  );
  // The plane already knows how deep a spot is; a dial that asks you to
  // guess it put a lamp on a streetlamp at 30 and the bus in front of it
  // never occluded the flare ("I barely saw a change"). The
  // same read the Depth of Field focus picker makes, on one click: the
  // lamp's own spot for a point light, its target for a directional.
  const fromScene = (key: "depth" | "sun_depth", at: { x: number; y: number }, testid: string, hint: string) => (
    <div style={{ display: "flex", justifyContent: "flex-end", marginTop: -2 }}>
      <button
        className="chip"
        data-testid={testid}
        data-hint={hint}
        style={{ fontSize: 11, padding: "0 6px" }}
        onClick={() => {
          const session = picks.start("light-depth", {
            aim: (v) => [v.keyLightSel, v.nodes.some((n) => n.id === node.id)],
            settings: (v) => {
              const live = v.nodes.find((n) => n.id === node.id);
              return live ? lightsOf(live)[sel] : null;
            },
          });
          void depthAt(session.state(), at.x, at.y)
            .then((far) => {
              if (!session.stillMine()) return;
              const live = session.state().nodes.find((n) => n.id === node.id);
              if (!live) return;
              writeLights(session.dispatch, live, lightsOf(live).map((light, i) =>
                i === sel ? { ...light, [key]: Math.round(Math.max(0, Math.min(1, far)) * 100) } : light));
            })
            .catch((err) => { if (session.stillMine()) reportToolError("Depth from scene", err); })
            .finally(session.cancel);
        }}
      >
        From scene
      </button>
    </div>
  );
  return (
    <div
      data-testid="keylight-selected"
      style={{ display: "flex", flexDirection: "column", gap: 4, margin: "2px 0 6px" }}
    >
      {/* Two rows, not one (the owner's screenshot: "The layout here is
really cramped"): the roster row answers WHICH light, the row
below answers WHAT KIND, and the sliders follow.*/}
      <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
        <button
          className="chip"
          data-testid="keylight-on"
          aria-pressed={l.on}
          data-hint={l.on ? "Switch this light off; its settings stay" : "Switch this light back on"}
          style={{ fontSize: 9, padding: "0 5px", color: l.on ? "var(--accent)" : "var(--text-ghost)" }}
          onClick={() => put({ on: !l.on })}
        >
          {l.on ? "\u25cf" : "\u25cb"}
        </button>
        <div style={{ flex: 1, minWidth: 0, display: "flex" }}>{roster}</div>
        <button
          className="chip"
          data-testid="keylight-delete"
          aria-label="Remove this light"
          data-hint="Remove this light from the rig"
          style={{ fontSize: 10, padding: "1px 6px", flex: "none" }}
          onClick={() => {
            writeLights(dispatch, node, lights.filter((_, i) => i !== sel));
            dispatch({ type: "select_keylight", index: null });
          }}
        >
          {"\u2715"}
        </button>
      </div>
      <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
        <ColorField
          testid="keylight-color"
          label="Light color"
          hint="The light's color; white pushes plain exposure"
          value={l.color}
          onChange={(hex) => put({ color: hex })}
        />
        <div className="zoom-seg" role="group" aria-label="Light type" style={{ border: "1px solid var(--line-4)" }}>
          {(["directional", "point"] as const).map((kind) => (
            <button
              key={kind}
              data-testid={`keylight-kind-${kind}`}
              data-active={l.kind === kind}
              aria-pressed={l.kind === kind}
              data-hint={
                kind === "point"
                  ? "A lamp IN the scene: sits at a spot, pushes light that fades with distance"
                  : "A sun: one direction over the whole scene, aimed from its target"
              }
              aria-label={kind === "point" ? "Point light" : "Directional light"}
              style={{ padding: "2px 9px", display: "inline-flex", alignItems: "center" }}
              onClick={() =>
                // Converting keeps the light where the eye already
                // is: a directional becomes a lamp at its target,
                // a lamp becomes a sun targeting its old spot.
                put(
                  kind === "point"
                    ? { kind, px: l.tx, py: l.ty }
                    : { kind, tx: l.px, ty: l.py },
                )
              }
            >
              {/* A picture, not a word (2026-09-20): the hint carries the
words.*/}
              {kind === "point" ? <PointLightIcon /> : <DirectionalLightIcon />}
            </button>
          ))}
        </div>
      </div>
      {slider("Strength", "keylight-sel-strength", l.strength, -STRENGTH_MAX, STRENGTH_MAX, (v) => put({ strength: v }))}
      {l.kind === "point" && (
        <>
          {slider("Depth", "keylight-sel-depth", l.depth, 0, 100, (v) => put({ depth: v }))}
          {fromScene(
            "depth",
            { x: l.px, y: l.py },
            "keylight-sel-depth-from-scene",
            "Set this light's depth to the scene's depth where it sits, from the depth plane: a lamp placed on a streetlamp then sits at the streetlamp's distance",
          )}
          {slider("Reach", "keylight-sel-range", l.range, 0, 100, (v) => put({ range: v }))}
        </>
      )}
      {/* The directional light's own three (2026-10-03: "We added a depth
slider for point light but not directional. I think this was an
oversight. Also, there is no Reach", then "add the depth, reach,
and elevation slider"). Elevation had only the handle's distance
from its target for a seat; Depth and Reach open the falloff along
depth the light always had and nobody could set. At 0 and 50 it is
the light as it was.*/}
      {l.kind === "directional" && (
        <>
          {slider(
            "Elevation",
            "keylight-sel-elevation",
            l.elevation,
            5,
            90,
            (v) => put({ elevation: v }),
            "How high the light stands over the scene: 90 shines straight in from the camera, lower rakes across the relief from the side",
          )}
          {slider(
            "Depth",
            "keylight-sel-sun-depth",
            l.sun_depth,
            0,
            100,
            (v) => put({ sun_depth: v }),
            "The plane this light lands hardest on: 0 the nearest thing in frame, 100 the farthest",
          )}
          {fromScene(
            "sun_depth",
            { x: l.tx, y: l.ty },
            "keylight-sel-sun-depth-from-scene",
            "Set this light's depth to the scene's depth at its target, from the depth plane: the light then lands hardest on what the target sits on",
          )}
          {slider(
            "Reach",
            "keylight-sel-sun-reach",
            l.sun_reach,
            0,
            100,
            (v) => put({ sun_reach: v }),
            "How far this light carries along depth from its plane: 100 lights every plane alike, lower keeps it to its own",
          )}
        </>
      )}
      {/* The light's flare: whether the Lens Flare section draws this
light, and how strongly. The look itself is the section's.*/}
      <div className="srow">
        <div className="lbl">Flare</div>
        <button
          className="chip"
          data-testid="keylight-sel-flare"
          aria-pressed={l.flare}
          data-hint={
            l.flare
              ? "This light flares: the Lens Flare section draws its glow, rays and ghosts"
              : "Let the Lens Flare section draw this light's flare"
          }
          style={{ fontSize: 9, padding: "0 6px", color: l.flare ? "var(--accent)" : "var(--text-ghost)" }}
          onClick={() => put({ flare: !l.flare })}
        >
          {l.flare ? "\u25cf flaring" : "\u25cb off"}
        </button>
      </div>
      {l.flare &&
        slider("Flare strength", "keylight-sel-flare-strength", l.flare_strength, 0, 300, (v) =>
          put({ flare_strength: v }),
        )}
      {/* A flaring light draws nothing until the Lens Flare section is
          on. Said here, where the toggle is, with the switch one
          explicit click away rather than thrown implicitly. */}
      {l.flare &&
        (() => {
          const flareNode = toolNode(state, "flare");
          const on = !!flareNode && flareNode.enabled && state.nodes.some((n) => n.id === flareNode.id);
          return on ? null : (
            <div
              data-testid="keylight-flare-off-note"
              style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 9, color: "var(--text-faint)", paddingLeft: 2 }}
            >
              <span>The Lens Flare section is off, so this light draws no flare.</span>
              <button
                className="chip"
                data-testid="keylight-flare-switch-on"
                data-hint="Switch the Lens Flare section on"
                style={{ fontSize: 9, padding: "0 6px" }}
                onClick={() => dispatch({ type: "set_category", title: "Lens Flare", on: true })}
              >
                Switch on
              </button>
            </div>
          );
        })()}
    </div>
  );
}

/** One click sets the focal plane: read the farness under the cursor
 * and write it to the Depth of Field node's focus dial. */
export function DofFocusOverlay({
  state,
  dispatch,
  node,
  norm,
}: {
  state: State;
  dispatch: D;
  node: NodeCard;
  norm: (e: { clientX: number; clientY: number }, el: HTMLElement) => [number, number];
}) {
  const picks = usePickSessions(state, dispatch);
  return (
    <div
      data-testid="dof-focus-overlay"
      style={{ position: "absolute", inset: 0, cursor: "crosshair" }}
      onMouseDown={(e) => {
        if (!isPrimaryPress(e)) return;
        e.stopPropagation();
        const [nx, ny] = norm(e, e.currentTarget);
        const session = picks.start("focus", {
          aim: (v) => [v.dofPick, v.nodes.some((n) => n.id === node.id)],
          arm: "dofPick",
          settings: (v) => v.nodes.find((n) => n.id === node.id)?.params,
        });
        const clearBusy = session.busy("DEPTH · reading the focus distance");
        void depthAt(session.state(), nx, ny)
          .then((far) => {
            if (!session.stillMine()) return;
            session.dispatch({ type: "set_param", id: node.id, param: "focus", value: Math.round(far * 100) });
            session.dispatch({ type: "toggle_dof_pick" });
          })
          .catch((err) => { if (session.stillMine()) reportToolError("Set focus", err); })
          .finally(() => { clearBusy(); session.cancel(); });
      }}
    />
  );
}
