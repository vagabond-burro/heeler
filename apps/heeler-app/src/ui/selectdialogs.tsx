import { useDialogFocus } from "./dialogfocus";
// The Select menu's dialogs: polish a selection, or build one out of a
// range of values.
//
// Every one of these steers the REAL graph while it is open. The sliders
// dispatch to the mask node the photograph is already being rendered
// through, so what is on screen is the answer rather than a preview of
// it, and Cancel is an undo rather than a discarded draft. That is the
// same rule the rest of the app runs on, and it is why none of these
// needed a new engine path except the range regions themselves.

import React, { useEffect, useState } from "react";
import type { Command, NodeCard, SelectRegion, State } from "../state";
import { RANGE_CHANNELS, activeSelectionMask, artMaskNode } from "../state";
import { MenuField } from "./menufield";
import { TrackSlider } from "./track";
import { DepthViewButton } from "./smarttool";

type D = React.Dispatch<Command>;

/** The mask params each polish dialog drives, and how to say them.
 *
 * Resize is one signed slider rather than separate Grow and Contract
 * commands, because the engine param is signed: two menu items for one
 * number would be two ways to reach the same control, and the one you
 * did not use would look like it did nothing. */
const PARAM: Record<
  string,
  { title: string; blurb: string; min: number; max: number; unit: string }
> = {
  smooth: {
    title: "Smooth Selection",
    blurb: "Rounds the corners off. The straight parts stay where they are.",
    min: 0,
    max: 1,
    unit: "",
  },
  feather: {
    title: "Feather Selection",
    blurb: "Softens the edge without moving it.",
    min: 0,
    max: 1,
    unit: "",
  },
  grow: {
    title: "Resize Selection",
    blurb: "Positive grows the selection outward, negative pulls it in.",
    min: -1,
    max: 1,
    unit: "",
  },
};

const MODE: Record<string, { title: string; blurb: string }> = {
  luma: {
    title: "Select by Luma Range",
    blurb: "Everything whose brightness falls between the two limits.",
  },
  color: {
    title: "Select by Color Range",
    blurb: "Everything whose value on one channel falls between the two limits.",
  },
  contrast: {
    title: "Select by Contrast",
    blurb:
      "Everything with this much local contrast: detail rather than tone, so a flat sky scores low however bright it is.",
  },
  depth: {
    title: "Select by Depth Range",
    blurb:
      "Everything whose distance falls between the two limits: 0 is the nearest thing in frame, 1 the farthest. Computed by the depth model for any photograph.",
  },
};

/** A shell every dialog here shares, so they read as one family.
 *
 * Draggable by its title bar. "I should be able to drag the
 * dialogs around so I can see what's behind them." These steer the live
 * graph, so the picture behind them is the whole point of having them
 * open, and a box parked over the part you are working on is in the
 * way. Exported for the "Layers from File..." picker (26.3 Phase 7
 * import), which is the same family.*/
export function Shell({
  testid,
  title,
  blurb,
  onCancel,
  onDone,
  children,
  headerActions,
}: {
  testid: string;
  title: string;
  blurb: string;
  onCancel: () => void;
  onDone: () => void;
  children: React.ReactNode;
  headerActions?: React.ReactNode;
}) {
  const focus = useDialogFocus(true);
  const [at, setAt] = useState<{ x: number; y: number } | null>(null);
  const drag = (e: React.MouseEvent) => {
    e.preventDefault();
    const start = { x: e.clientX, y: e.clientY };
    const from = at ?? { x: 0, y: 0 };
    const move = (ev: MouseEvent) =>
      setAt({ x: from.x + ev.clientX - start.x, y: from.y + ev.clientY - start.y });
    const up = () => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
  };
  // ESC cancels and ENTER commits, which is what a dialog owes anyone
  // who has typed into one before.
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") onCancel();
      if (e.key === "Enter" && !(e.target as HTMLElement).closest("button, input, textarea")) onDone();
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  });

  return (
    <div
      data-testid={testid}
      style={{
        position: "fixed",
        inset: 0,
        // Barely there: the photograph behind is what the sliders are
        // being judged against, so darkening it to a silhouette would
        // defeat the dialog.
        background: "rgba(12, 11, 10, .28)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex: 60,
      }}
    >
      <div ref={focus} role="dialog" aria-modal="true" aria-label={title} tabIndex={-1}
        onMouseDown={(e) => e.stopPropagation()}
        style={{
          transform: at ? `translate(${at.x}px, ${at.y}px)` : undefined,
          width: 320,
          // A quarter larger than the panel's type (2026-09-09: "some people
          // having a hard time reading"). zoom rather than a transform, so
          // the histogram tracks still measure the pointer in their own
          // pixels.
          zoom: 1.25,
          background: "var(--bg-panel)",
          border: "1px solid var(--line-4)",
          padding: "15px 17px 13px",
          boxShadow: "0 18px 44px rgba(0,0,0,.55)",
        }}
      >
        <div
          data-testid={`${testid}-title`}
          onMouseDown={drag}
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: 8,
            fontSize: 11,
            fontWeight: 600,
            letterSpacing: ".10em",
            textTransform: "uppercase",
            color: "#c7ccd0",
            marginBottom: 3,
            cursor: "move",
            userSelect: "none",
          }}
        >
          <span>{title}</span>
          {headerActions && <span style={{ display: "inline-flex", gap: 5 }} onMouseDown={(e) => e.stopPropagation()}>{headerActions}</span>}
        </div>
        <div style={{ fontSize: 10, color: "var(--text-faint)", marginBottom: 12, lineHeight: 1.45 }}>
          {blurb}
        </div>
        {children}
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 7, marginTop: 13 }}>
          <button className="chip" data-testid={`${testid}-cancel`} onClick={onCancel}>
            CANCEL
          </button>
          <button className="chip" data-testid={`${testid}-done`} data-primary onClick={onDone}>
            DONE
          </button>
        </div>
      </div>
    </div>
  );
}

/** One labeled slider, in the panel's own idiom. */
function Row({
  label,
  testid,
  value,
  min,
  max,
  step = 0.01,
  onChange,
  format,
  hardLo = min,
  hardHi = max,
}: {
  label: string;
  testid: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  onChange: (v: number) => void;
  format?: (v: number) => string;
  /** what may be TYPED, when that is wider than what may be dragged */
  hardLo?: number;
  hardHi?: number;
}) {
  // Held as text while it is being edited: "-" and "0." are states a
  // number cannot hold, and pushing each keystroke through as a value
  // makes the picture flicker and the caret jump.
  const [text, setText] = useState<string | null>(null);
  const commit = (raw: string) => {
    setText(null);
    const parsed = Number(raw.trim().replace(/,/g, ""));
    if (raw.trim() === "" || !Number.isFinite(parsed)) return;
    // These sliders read 0..1 and show percentages, so a typed number
    // comes back the same way it went out.
    const asValue = parsed / 100;
    onChange(Math.max(hardLo, Math.min(hardHi, asValue)));
  };
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 9, marginBottom: 7 }}>
      <div style={{ fontSize: 10.5, color: "var(--text-mid)", width: 62, flex: "none" }}>{label}</div>
      <div className="strack-flex">
        <TrackSlider
          label={label}
          lo={min}
          hi={max}
          step={step}
          testid={testid}
          value={value}
          onChange={onChange}
        />
      </div>
      {/* Typed as well as dragged, and typed past the slider when the
limit is editorial rather than real. Resize is the case the owner
raised: the slider stops at a twentieth of the frame and
sometimes you want half of it.*/}
      <input
        className="tnum"
        data-testid={`${testid}-value`}
        aria-label={`${label} value`}
        inputMode="decimal"
        value={text ?? (format ? format(value) : String(Math.round(value * 100)))}
        onChange={(e) => setText(e.target.value)}
        onFocus={(e) => e.currentTarget.select()}
        onBlur={(e) => commit(e.currentTarget.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") (e.target as HTMLInputElement).blur();
          if (e.key === "Escape") {
            setText(null);
            (e.target as HTMLInputElement).blur();
          }
          e.stopPropagation();
        }}
        style={{
          all: "unset",
          boxSizing: "border-box",
          width: 38,
          fontSize: 10.5,
          // Gold past the slider's reach, so a handle parked at the end
          // is not mistaken for the value.
          color: value < min || value > max ? "var(--accent)" : "#c2c7cb",
          textAlign: "right",
          fontVariantNumeric: "tabular-nums",
          cursor: "text",
          padding: "1px 2px",
          border: "1px solid transparent",
        }}
        onMouseEnter={(e) => (e.currentTarget.style.borderColor = "var(--line-4)")}
        onMouseLeave={(e) => (e.currentTarget.style.borderColor = "transparent")}
      />
    </div>
  );
}

/** Bars of the image's own histogram, with the chosen range lit.
 *
 * Drawn from the same thumbnail bytes the curve editor reads, which are
 * display-encoded: that is the axis the range is stated on, so the
 * window lands exactly where the eye puts it. */
function RangeBars({
  bins,
  lo,
  hi,
}: {
  bins: number[] | null;
  lo: number;
  hi: number;
}) {
  const peak = bins ? Math.max(1, ...bins) : 1;
  // A filled curve, not 64 hard bars. "The histogram
  // could have smooth curves and not look all pixelated." Three
  // passes of a 1-2-1 kernel over the counts, then a Catmull-Rom
  // through the result: the shape of the data survives, the staircase
  // does not.
  const path = (() => {
    if (!bins) return null;
    let v = bins.map((c) => Math.log1p(c) / Math.log1p(peak));
    for (let pass = 0; pass < 3; pass++) {
      v = v.map((_, i) => {
        const a = v[Math.max(0, i - 1)];
        const b = v[i];
        const c = v[Math.min(v.length - 1, i + 1)];
        return (a + 2 * b + c) / 4;
      });
    }
    const pt = (i: number): [number, number] => [
      (i / (v.length - 1)) * 100,
      100 - Math.min(1, v[Math.max(0, Math.min(v.length - 1, i))]) * 100,
    ];
    let d = `M 0 100 L ${pt(0)[0]} ${pt(0)[1]}`;
    for (let i = 0; i < v.length - 1; i++) {
      const [x0, y0] = pt(i - 1);
      const [x1, y1] = pt(i);
      const [x2, y2] = pt(i + 1);
      const [x3, y3] = pt(i + 2);
      // Catmull-Rom to cubic Bezier.
      d += ` C ${x1 + (x2 - x0) / 6} ${y1 + (y2 - y0) / 6}, ${x2 - (x3 - x1) / 6} ${y2 - (y3 - y1) / 6}, ${x2} ${y2}`;
    }
    return `${d} L 100 100 Z`;
  })();
  return (
    <div
      data-testid="range-dialog-histogram"
      style={{
        position: "relative",
        height: 62,
        marginBottom: 9,
        background: "var(--bg-app)",
        border: "1px solid var(--line-2)",
        overflow: "hidden",
      }}
    >
      {/* The lit window, behind the bars, so the bars stay readable
          rather than being tinted by it. */}
      <div
        data-testid="range-dialog-window"
        style={{
          position: "absolute",
          left: `${lo * 100}%`,
          width: `${Math.max(0, hi - lo) * 100}%`,
          top: 0,
          bottom: 0,
          background: "rgba(53, 184, 224, .17)",
          borderLeft: "1px solid var(--accent)",
          borderRight: "1px solid var(--accent)",
        }}
      />
      {path && (
        <svg
          viewBox="0 0 100 100"
          preserveAspectRatio="none"
          style={{ position: "absolute", inset: 0, width: "100%", height: "100%" }}
        >
          <path d={path} fill="#53595d" stroke="var(--text-dim)" strokeWidth="0.8" vectorEffect="non-scaling-stroke" />
        </svg>
      )}
    </div>
  );
}

/** Histogram bins of one channel, from the thumbnail. Null where canvas
 * is unavailable, which is every headless test; the dialog then draws
 * its sliders without an underlay rather than refusing to open. */
function useBins(src: string | undefined, channel: string): number[] | null {
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
        const w = 96;
        const h = Math.max(1, Math.round(((img.height || 64) / (img.width || 96)) * w));
        const canvas = document.createElement("canvas");
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext("2d");
        if (!ctx) return;
        ctx.drawImage(img, 0, 0, w, h);
        const data = ctx.getImageData(0, 0, w, h).data;
        const out = new Array(64).fill(0);
        for (let i = 0; i < data.length; i += 4) {
          const [r, g, b] = [data[i], data[i + 1], data[i + 2]];
          const v =
            channel === "red" ? r
            : channel === "green" ? g
            : channel === "blue" ? b
            : channel === "saturation"
              ? (Math.max(r, g, b) === 0 ? 0 : ((Math.max(r, g, b) - Math.min(r, g, b)) / Math.max(r, g, b)) * 255)
              : 0.2126 * r + 0.7152 * g + 0.0722 * b;
          out[Math.min(63, Math.floor((v / 255) * 64))]++;
        }
        if (live) setBins(out);
      } catch {
        // No canvas: sliders without an underlay.
      }
    };
    img.src = src;
    return () => {
      live = false;
    };
  }, [src, channel]);
  return bins;
}

export function SelectDialogs({ state, dispatch }: { state: State; dispatch: D }) {
  const dlg = state.selectDialog;
  // A range taken on a live Smart or Object mask (selectShapeTarget)
  // steers that mask; every other one steers the selection.
  const mask = (dlg?.kind === "range" && dlg.maskId ? artMaskNode(state, dlg.maskId) : undefined) ?? activeSelectionMask(state);
  // Both hooks run every render, dialog or not: a component cannot
  // change how many hooks it calls between renders, and bailing out
  // above them would do exactly that.
  const region = dlg?.kind === "range" ? (mask?.regions ?? [])[dlg.index ?? 0] : undefined;
  const channel = dlg?.channel ?? "luma";
  const bins = useBins(
    dlg?.kind === "range" && dlg.mode !== "contrast" && dlg.mode !== "depth"
      ? state.images.find((i) => i.id === state.activeImage)?.src
      : undefined,
    channel,
  );
  if (!dlg || !mask) return null;

  if (dlg.kind === "param") {
    return <ParamDialog state={state} dispatch={dispatch} mask={mask} dlg={dlg} />;
  }
  if (!region || region.kind !== "range") return null;

  const put = (patch: Partial<Extract<SelectRegion, { kind: "range" }>>) =>
    dispatch({
      type: "update_region",
      id: mask.id,
      index: dlg.index ?? 0,
      region: { ...region, ...patch },
    });

  const meta = MODE[dlg.mode ?? "luma"];
  return (
    <Shell
      testid="select-range-dialog"
      title={meta.title}
      blurb={meta.blurb}
      headerActions={dlg.mode === "depth" && <DepthViewButton depthView={state.depthView} red={state.maskRed} onToggle={(flavor) => dispatch({ type: "toggle_depth_view", flavor })} testid="select-range-depth-view" />}
      onCancel={() => {
        // The list as it was before the dialog opened. Not just
        // removing the range: it went in on whatever New/Add/Subtract
        // is set to, and "New" drops the regions it supersedes, so
        // removing only the range would leave Cancel destructive.
        dispatch({ type: "set_regions", id: mask.id, regions: dlg.restoreRegions ?? [] });
        dispatch({ type: "close_select_dialog" });
      }}
      onDone={() => dispatch({ type: "close_select_dialog" })}
    >
      {dlg.mode === "color" && (
        <div style={{ display: "flex", alignItems: "center", gap: 9, marginBottom: 9 }}>
          <div style={{ fontSize: 10.5, color: "var(--text-mid)", width: 62, flex: "none" }}>Channel</div>
          <MenuField
            testid="range-channel"
            label="Channel"
            hint="Which plane the range is read on"
            value={channel}
            options={RANGE_CHANNELS.map((c) => ({ id: c.id, label: c.label }))}
            onChange={(id) => {
              dispatch({ type: "open_select_dialog", dialog: { ...dlg, channel: id } });
              put({ channel: id });
            }}
            minWidth={92}
          />
        </div>
      )}
      {dlg.mode !== "contrast" && dlg.mode !== "depth" && (
        <RangeBars bins={bins} lo={region.lo} hi={region.hi} />
      )}
      <Row
        label="From"
        testid="range-lo"
        value={region.lo}
        min={0}
        max={1}
        // The two limits cannot cross: a range whose start is past its
        // end is not a range, and the engine would just sort them
        // behind your back, which reads as the slider jumping.
        onChange={(v) => put({ lo: Math.min(v, region.hi) })}
      />
      <Row
        label="To"
        testid="range-hi"
        value={region.hi}
        min={0}
        max={1}
        onChange={(v) => put({ hi: Math.max(v, region.lo) })}
      />
      <Row
        label="Falloff"
        testid="range-soft"
        value={region.soft}
        min={0}
        max={0.5}
        onChange={(v) => put({ soft: v })}
      />
    </Shell>
  );
}

function ParamDialog({
  state,
  dispatch,
  mask,
  dlg,
}: {
  state: State;
  dispatch: D;
  mask: NodeCard;
  dlg: NonNullable<State["selectDialog"]>;
}) {
  const param = dlg.param ?? "smooth";
  const meta = PARAM[param];
  const value = Number(mask.params[param] ?? 0);
  return (
    <Shell
      testid="select-param-dialog"
      title={meta.title}
      blurb={meta.blurb}
      onCancel={() => {
        dispatch({
          type: "set_param",
          id: mask.id,
          param,
          value: dlg.restore ?? 0,
        });
        dispatch({ type: "close_select_dialog" });
      }}
      onDone={() => dispatch({ type: "close_select_dialog" })}
    >
      <Row
        label={param === "grow" ? "Amount" : meta.title.split(" ")[0]}
        testid={`select-param-${param}`}
        value={value}
        min={meta.min}
        max={meta.max}
        // Grow reaches both ways and has no natural limit either side;
        // smoothing and feathering cannot go below nothing.
        hardLo={param === "grow" ? -Infinity : 0}
        hardHi={Infinity}
        onChange={(v) => dispatch({ type: "set_param", id: mask.id, param, value: v })}
        format={(v) => (param === "grow" && v > 0 ? `+${Math.round(v * 100)}` : String(Math.round(v * 100)))}
      />
    </Shell>
  );
}
