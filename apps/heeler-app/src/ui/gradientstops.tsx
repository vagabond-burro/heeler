// The gradient editor: simple mode is two colors, advanced mode is a
// stop list that takes over the Finish panel.
//
// The owner asked for advanced editing, got a popup, and rejected it:
// "the pop-up pushed up and got cut off by the header bars. Maybe,
// what advanced does is a drill down. It uses the right panel space
// but the layers are hidden and what it does is basically takes over
// that view and each custom point, and it's properties, has vertical
// space to be displayed (similar to layers) and edited."
//
// He is right, and not only about the clipping: a popup has to guess a
// size that fits somewhere, and stops are a list that grows. A drill-
// down has the whole panel and the same shape as the stack it replaces,
// so a stop reads like a layer, which is what it is.
//
// Stops carry a position, a color, an alpha and a MIDPOINT: where the
// blend to the next stop reaches halfway. The midpoint is the control
// that makes a gradient look right, and the one most editors bury or
// leave out; a layer editor draws it as a diamond between two stops, which
// is the shape used on the ramp here.

import { useState } from "react";
import type { Command, NodeCard } from "../state";
import { GRADIENT_BY_TONE } from "../state";
import { ColorField } from "./colorfield";
import { TrackSlider, ValueField } from "./track";
import { MenuField } from "./menufield";

type D = React.Dispatch<Command>;

/** The shapes a Gradient offers. By tone runs the stops from the
 * picture's darks to its brights instead of across the frame
 * (2026-09-30: "do the merge with a By tone shape"); it is what
 * the Finish Gradient Map adjustment was.*/
export const GRADIENT_SHAPES: { id: string; label: string }[] = [
  { id: "linear", label: "Linear" },
  { id: "radial", label: "Radial" },
  { id: GRADIENT_BY_TONE, label: "By tone" },
];

/** Whether a gradient's stops run along the picture's tones. */
export function isByTone(text: Record<string, string> | undefined): boolean {
  return (text?.shape ?? "linear") === GRADIENT_BY_TONE;
}

/** A gradient's controls: two colors, a shape, an angle and a center
 * weighting in simple mode, the full stop list behind ADV.
 *
 * "How it is now is fine for a simple mode, should be
 * able to toggle to advanced editing." The two modes are the same
 * data, since the engine builds a two-stop list from the simple
 * params when there is no explicit one; switching to advanced writes
 * that list out, so nothing changes on screen at the moment of the
 * switch.
 *
 * Shared by the Finish layer row and the Gradient node's Inspector, so
 * the two seats cannot offer different controls; each hands in how it
 * writes a value and what ADV opens. By tone hides the angle, the one
 * control that only places the gradient on the frame. */
export function GradientControls({
  testid,
  params,
  text,
  set,
  onAdvanced,
  dispatch,
}: {
  /** the suffix every control's test id carries */
  testid: string;
  params: Record<string, number>;
  text: Record<string, string> | undefined;
  set: (param: string, value: number | string) => void;
  /** opens the stop list; ADV writes the simple pair out first */
  onAdvanced: () => void;
  dispatch: D;
}) {
  const advanced = (text?.stops ?? "").trim() !== "";
  const stops = readStops(text, params);
  const tone = isByTone(text);
  const gesture = (key: string) => ({
    onBegin: () => dispatch({ type: "begin_gesture", key: `${testid}.${key}` }),
    onEnd: () => dispatch({ type: "end_gesture" }),
  });
  const label = { fontSize: 11, color: "var(--text-faint)", width: 44 } as const;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 4, position: "relative" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
        {advanced ? (
          <div
            data-testid={`art-grad-ramp-${testid}`}
            onMouseDown={(e) => e.stopPropagation()}
            onClick={onAdvanced}
            data-hint={tone ? "Edit the stops, from the darkest tones on the left to the brightest on the right" : "Edit the stops"}
            style={{
              width: 52, height: 18, cursor: "pointer",
              background: previewCss(stops), border: "1px solid var(--line-4)",
            }}
          />
        ) : (
          <>
            <ColorField
              value={text?.color_a ?? "#000000"}
              onChange={(hex) => set("color_a", hex)}
              label={tone ? "Color for the darkest tones" : "Gradient start color"}
              testid={`art-grad-a-${testid}`}
              width={24}
              {...gesture("color_a")}
            />
            <ColorField
              value={text?.color_b ?? "#ffffff"}
              onChange={(hex) => set("color_b", hex)}
              label={tone ? "Color for the brightest tones" : "Gradient end color"}
              testid={`art-grad-b-${testid}`}
              width={24}
              {...gesture("color_b")}
            />
          </>
        )}
        <MenuField
          testid={`art-grad-shape-${testid}`}
          label="Gradient shape"
          hint="Linear and Radial color across the frame; By tone colors each pixel by its brightness, darks to the first stop and brights to the last"
          param="shape"
          size="regular"
          value={text?.shape ?? "linear"}
          options={GRADIENT_SHAPES}
          fitLabels={GRADIENT_SHAPES.map((s) => s.label)}
          onChange={(value) => set("shape", value)}
        />
        <button
          className="chip"
          data-testid={`art-grad-advanced-${testid}`}
          data-active={advanced || undefined}
          style={{ fontSize: 11, padding: "1px 5px" }}
          data-hint="Custom stops, with a falloff between each pair"
          onMouseDown={(e) => e.stopPropagation()}
          onClick={() => {
            // Write the simple pair out as stops, so the picture does
            // not change at the moment of the switch.
            if (!advanced) set("stops", JSON.stringify(stops));
            onAdvanced();
          }}
        >
          ADV
        </button>
      </div>
      {!tone && (
        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <span style={label}>Angle</span>
          <div className="strack-flex" style={{ minWidth: 50 }} onMouseDown={(e) => e.stopPropagation()}>
            <TrackSlider
              label="Gradient angle"
              lo={-180}
              hi={180}
              step={1}
              testid={`art-grad-angle-${testid}`}
              value={params.angle ?? 0}
              onChange={(v) => set("angle", v)}
              {...gesture("angle")}
            />
          </div>
          <div style={{ width: 34, flex: "none", fontSize: 11 }}>
            <ValueField
              param="gradient angle"
              value={params.angle ?? 0}
              lo={-180}
              hi={180}
              display={(v) => `${Math.round(v)}°`}
              testid={`art-grad-angle-value-${testid}`}
              onCommit={(v) => set("angle", v)}
            />
          </div>
        </div>
      )}
      {!advanced && (
        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <span style={label}>Center</span>
          <div className="strack-flex" style={{ minWidth: 50 }} onMouseDown={(e) => e.stopPropagation()}>
            <TrackSlider
              label="Gradient center weighting"
              lo={5}
              hi={95}
              step={1}
              testid={`art-grad-mid-${testid}`}
              hint={tone ? "The tone where the two colors meet halfway" : "Where the blend between the two colors reaches halfway"}
              value={params.midpoint ?? 50}
              onChange={(v) => set("midpoint", v)}
              {...gesture("midpoint")}
            />
          </div>
          <div style={{ width: 34, flex: "none", fontSize: 11 }}>
            <ValueField
              param="gradient center weighting"
              value={params.midpoint ?? 50}
              lo={5}
              hi={95}
              display={(v) => String(Math.round(v))}
              testid={`art-grad-mid-value-${testid}`}
              onCommit={(v) => set("midpoint", v)}
            />
          </div>
        </div>
      )}
    </div>
  );
}

export interface GradStop {
  pos: number;
  color: string;
  alpha: number;
  mid: number;
}

/** Parses the stops JSON a gradient node carries, or builds the
 * two-stop form from its simple params when it has none. One shape
 * either way, which is what lets the editor open on any gradient. */
export function readStops(
  text: Record<string, string> | undefined,
  params: Record<string, number> | undefined,
): GradStop[] {
  const raw = text?.stops ?? "";
  if (raw.trim()) {
    try {
      const list = JSON.parse(raw) as GradStop[];
      if (Array.isArray(list) && list.length >= 2) {
        return list
          .map((s) => ({
            pos: Number(s.pos) || 0,
            color: s.color ?? "#000000",
            alpha: s.alpha ?? 100,
            mid: s.mid ?? 50,
          }))
          .sort((a, b) => a.pos - b.pos);
      }
    } catch {
      // Unreadable stops fall back to the simple pair rather than
      // taking the panel down.
    }
  }
  return [
    {
      pos: 0,
      color: text?.color_a ?? "#000000",
      alpha: params?.alpha_a ?? 100,
      mid: params?.midpoint ?? 50,
    },
    { pos: 100, color: text?.color_b ?? "#ffffff", alpha: params?.alpha_b ?? 0, mid: 50 },
  ];
}

/** The CSS gradient that previews a stop list, midpoints included: each
 * segment gets an extra sample where the blend reaches halfway, so the
 * weighting is visible rather than implied. */
export function previewCss(stops: GradStop[]): string {
  const parts: string[] = [];
  const rgb = (hex: string) => {
    const n = parseInt(hex.replace("#", ""), 16) || 0;
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  };
  const rgba = (hex: string, a: number) => {
    const [r, g, b] = rgb(hex);
    return `rgba(${r},${g},${b},${a / 100})`;
  };
  for (let i = 0; i < stops.length; i++) {
    const a = stops[i];
    parts.push(`${rgba(a.color, a.alpha)} ${a.pos}%`);
    const b = stops[i + 1];
    if (!b) continue;
    const m = Math.min(95, Math.max(5, a.mid)) / 100;
    const at = a.pos + (b.pos - a.pos) * m;
    const [ar, ag, ab] = rgb(a.color);
    const [br, bg, bb] = rgb(b.color);
    const mix = (x: number, y: number) => Math.round((x + y) / 2);
    parts.push(
      `rgba(${mix(ar, br)},${mix(ag, bg)},${mix(ab, bb)},${(a.alpha + b.alpha) / 200}) ${at}%`,
    );
  }
  return `linear-gradient(to right, ${parts.join(", ")})`;
}

/** Adds a stop halfway along the widest gap, so a new one lands where
 * there is room rather than on top of one already there. */
export function withNewStop(stops: GradStop[]): GradStop[] {
  let at = 50;
  let widest = -1;
  for (let i = 0; i < stops.length - 1; i++) {
    const gap = stops[i + 1].pos - stops[i].pos;
    if (gap > widest) {
      widest = gap;
      at = stops[i].pos + gap / 2;
    }
  }
  return [...stops, { pos: at, color: "#808080", alpha: 100, mid: 50 }].sort(
    (a, b) => a.pos - b.pos,
  );
}

/** The Gradient node's face in the graph Inspector: the Finish layer's
 * controls (features reach their nodes), writing the node's own params,
 * with ADV opening the same stop list in place under them. */
export function GradientNodeControls({ node, dispatch }: { node: NodeCard; dispatch: D }) {
  const [open, setOpen] = useState(false);
  const set = (param: string, value: number | string) =>
    dispatch(
      typeof value === "number"
        ? { type: "set_param", id: node.id, param, value }
        : { type: "set_text_param", id: node.id, param, value },
    );
  return (
    <div data-testid={`node-grad-${node.id}`} style={{ display: "flex", flexDirection: "column", gap: 6, marginBottom: 6 }}>
      <GradientControls
        testid={node.id}
        params={node.params}
        text={node.textParams}
        set={set}
        onAdvanced={() => setOpen(true)}
        dispatch={dispatch}
      />
      {open && (
        <GradientPanel
          layerName={node.name}
          stops={readStops(node.textParams, node.params)}
          onChange={(next) => set("stops", JSON.stringify(next))}
          onBack={() => setOpen(false)}
          onSimple={() => {
            set("stops", "");
            setOpen(false);
          }}
          dispatch={dispatch}
          testid={`node-grad-${node.id}-stops`}
          tone={isByTone(node.textParams)}
          backHint="Close the stop list"
        />
      )}
    </div>
  );
}

/** The stop list, taking over the panel the layer stack was in. */
export function GradientPanel({
  layerName,
  stops,
  onChange,
  onBack,
  onSimple,
  dispatch,
  testid,
  tone = false,
  backHint = "Back to the layer stack",
}: {
  layerName: string;
  stops: GradStop[];
  onChange: (next: GradStop[]) => void;
  onBack: () => void;
  onSimple: () => void;
  dispatch: D;
  testid: string;
  /** By tone: the ramp is the picture's tones, darkest on the left,
   * and a stop's place is the tone it colors */
  tone?: boolean;
  /** what the back arrow returns to, where it is not the layer stack */
  backHint?: string;
}) {
  const edit = (i: number, patch: Partial<GradStop>) => {
    const next = stops.map((s, k) => (k === i ? { ...s, ...patch } : s));
    // Re-sorted on every edit, because dragging a stop past its
    // neighbor is a normal thing to do and the engine reads the list
    // in order.
    onChange([...next].sort((a, b) => a.pos - b.pos));
  };

  const row = (label: string, node: React.ReactNode) => (
    <div style={{ display: "flex", alignItems: "center", gap: 7 }}>
      <span style={{ fontSize: 9, color: "var(--text-faint)", width: 52 }}>{label}</span>
      {node}
    </div>
  );

  const slider = (
    i: number,
    key: "pos" | "alpha" | "mid",
    value: number,
    label: string,
    lo = 0,
    hi = 100,
  ) => (
    <>
      <div className="strack-flex">
        <TrackSlider
          label={label}
          lo={lo}
          hi={hi}
          step={1}
          testid={`${testid}-${key}-${i}`}
          value={value}
          onChange={(v) => edit(i, { [key]: v })}
          onBegin={() => dispatch({ type: "begin_gesture", key: `${testid}.${key}.${i}` })}
          onEnd={() => dispatch({ type: "end_gesture" })}
        />
      </div>
      <div style={{ width: 24, flex: "none" }}>
        <ValueField
          param={label}
          value={value}
          lo={lo}
          hi={hi}
          display={(v) => String(Math.round(v))}
          testid={`${testid}-${key}-${i}-value`}
          onCommit={(v) => edit(i, { [key]: v })}
        />
      </div>
    </>
  );

  return (
    <div
      data-testid={`${testid}-panel`}
      style={{ padding: "10px 12px", display: "flex", flexDirection: "column", gap: 8, minHeight: 0, overflowY: "auto", flex: 1 }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
        <button
          className="chip"
          data-testid={`${testid}-back`}
          aria-label={backHint === "Back to the layer stack" ? "Back to layers" : backHint}
          data-hint={backHint}
          style={{ padding: "2px 6px", display: "inline-flex", alignItems: "center" }}
          onClick={onBack}
        >
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4">
            <path d="M15 18l-6-6 6-6" />
          </svg>
        </button>
        <span className="kicker">GRADIENT</span>
        <span style={{ fontSize: 10, color: "var(--text-faint)", flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {layerName}
        </span>
        <button
          className="chip"
          data-testid={`${testid}-simple`}
          style={{ fontSize: 8.5, padding: "1px 6px" }}
          data-hint="Back to two colors. Any extra stops are discarded."
          onClick={onSimple}
        >
          SIMPLE
        </button>
      </div>

      {/* The ramp, with a marker per stop and a diamond per midpoint. */}
      <div style={{ position: "relative", height: 30, flex: "none" }}>
        <div
          data-testid={`${testid}-preview`}
          style={{
            position: "absolute", left: 0, right: 0, top: 0, height: 20,
            background: previewCss(stops),
            border: "1px solid var(--line-2)",
          }}
        />
        {stops.map((s, i) => (
          <div
            key={`s${i}`}
            data-testid={`${testid}-marker-${i}`}
            style={{
              position: "absolute", left: `${s.pos}%`, top: 20, width: 7, height: 7,
              marginLeft: -3.5, background: s.color, border: "1px solid var(--line-4)",
            }}
          />
        ))}
        {stops.slice(0, -1).map((s, i) => (
          <div
            key={`m${i}`}
            data-testid={`${testid}-diamond-${i}`}
            style={{
              position: "absolute",
              left: `${s.pos + (stops[i + 1].pos - s.pos) * (Math.min(95, Math.max(5, s.mid)) / 100)}%`,
              top: 22, width: 4, height: 4, marginLeft: -2,
              background: "var(--text-ghost)", transform: "rotate(45deg)",
            }}
          />
        ))}
      </div>
      {/* By tone the ramp's axis is brightness, so it says which end is
          which; the stops' places read as tones. */}
      {tone && (
        <div
          data-testid={`${testid}-tone-axis`}
          style={{ display: "flex", justifyContent: "space-between", fontSize: 11, color: "var(--text-faint)", marginTop: -4 }}
        >
          <span>Dark</span>
          <span>Bright</span>
        </div>
      )}

      <button
        className="chip"
        data-testid={`${testid}-add`}
        style={{ fontSize: 9, padding: "2px 7px", alignSelf: "flex-start" }}
        data-hint="Add a stop in the widest gap"
        onClick={() => onChange(withNewStop(stops))}
      >
        + STOP
      </button>

      {/* One block per stop, the way the stack gives one per layer. */}
      {stops.map((s, i) => (
        <div
          key={i}
          data-testid={`${testid}-stop-${i}`}
          style={{
            border: "1px solid var(--line-4)",
            background: "var(--bg-row)",
            padding: "7px 9px",
            display: "flex",
            flexDirection: "column",
            gap: 5,
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: 7 }}>
            <ColorField
              value={s.color}
              onChange={(hex) => edit(i, { color: hex })}
              label={`Stop ${i + 1} color`}
              testid={`${testid}-color-${i}`}
              width={22}
            />
            <span style={{ flex: 1, fontSize: 11, color: "var(--text-body)" }}>
              Stop {i + 1}
            </span>
            <button
              className="chip"
              data-testid={`${testid}-remove-${i}`}
              aria-label={`Remove stop ${i + 1}`}
              disabled={stops.length <= 2}
              style={{ fontSize: 8.5, padding: "0 5px" }}
              data-hint="Two stops is the fewest a gradient can have"
              onClick={() => onChange(stops.filter((_, k) => k !== i))}
            >
              ✕
            </button>
          </div>
          {tone
            ? row("Tone", slider(i, "pos", s.pos, `Stop ${i + 1} tone`))
            : row("Position", slider(i, "pos", s.pos, `Stop ${i + 1} position`))}
          {row("Opacity", slider(i, "alpha", s.alpha, `Stop ${i + 1} opacity`))}
          {i < stops.length - 1 &&
            row("Falloff", slider(i, "mid", s.mid, `Stop ${i + 1} falloff`, 5, 95))}
        </div>
      ))}
    </div>
  );
}
