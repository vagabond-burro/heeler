// The house slider's track, alone in its own module so BOTH panels
// that render dials - the develop rows in simple.tsx and the Depth
// Lighting rig in keylightgizmo.tsx - can share it without importing
// each other. (simple.tsx mounts the rig's controls, so a shared
// control living in simple.tsx would be an import cycle.)

import { startTransition, useRef, useState, type ReactNode } from "react";
import { PARAM_RANGE, snapStep } from "../state";
import { isPrimaryPress } from "./pointerguard";

/** The house slider track alone - rail, optional center notch, fill,
 * handle, pointer capture, SHIFT snap, arrow keys - with no opinion
 * about where its value lives. Slider binds it to a node param; the
 * Depth Lighting rig binds it to the selected light's JSON. One
 * control, however many value stores, so a dial can never drift
 * into a browser-native lookalike again (the owner's screenshot:
 * "That slider is different from the others").*/
export function TrackSlider({
  label,
  value,
  lo,
  hi,
  centered = false,
  step,
  disabled = false,
  testid,
  hint,
  onBegin,
  onChange,
  onEnd,
  readout,
}: {
  label: string;
  value: number;
  lo: number;
  hi: number;
  centered?: boolean;
  /** the granularity the control had as a native range: drag quantizes
   * to it, the arrows move by it, and nothing between two steps ever
   * reaches onChange. Left out, drag is continuous and the arrows move
   * a hundredth of the span. */
  step?: number;
  disabled?: boolean;
  testid?: string;
  hint?: string;
  onBegin?: () => void;
  onChange: (v: number) => void;
  onEnd?: () => void;
  /** What sits beside the track and reads its value (the typed field):
   * handed the value the handle shows, so mid-drag the number moves
   * with the hand rather than a render behind it. Rendered after the
   * track, as its sibling. */
  readout?: (shown: number) => ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  // A drag answers the hand at once and the app behind it when it can
  // (a tester, 2026-09-30: "I do get a bit of jitter/lag on the
  // sliders"). Each step of a drag writes a param, and a param write
  // re-renders the whole window: the develop panel, the menus, the
  // viewer, well past a frame's budget on a slower machine, and the
  // handle waited for all of it. The handle now draws from the value
  // under the pointer, a render of this row alone, and the write goes
  // in a transition React may split across frames and bring up to the
  // newest value. The drag's end rides the same transition, after its
  // last write, so the release never renders ahead of the value the
  // hand left, and the handle lets go of its own value in that same
  // commit, when the param has caught up.
  const [drag, setDrag] = useState<number | null>(null);
  const dragging = useRef(false);
  // The track's box, read once when the press lands: reading it on
  // every move forced a layout of the whole window inside the handler.
  const box = useRef<{ left: number; width: number } | null>(null);
  const shown = drag ?? value;
  const pct = Math.min(100, Math.max(0, ((shown - lo) / (hi - lo)) * 100));
  const from = centered ? Math.min(50, pct) : 0;
  const w = centered ? Math.abs(pct - 50) : pct;
  // Rounds relative to lo, the way the native input counts steps from
  // its min, and trims to the step's own decimals: 0.005 steps land on
  // 0.15, never on 0.15000000000000002.
  const quantize = (raw: number, unit: number) => {
    const decimals = (String(unit).split(".")[1] ?? "").length;
    const snapped = lo + Math.round((raw - lo) / unit) * unit;
    return Math.min(hi, Math.max(lo, Number(snapped.toFixed(decimals))));
  };
  const setFromClientX = (clientX: number, shift = false) => {
    if (!Number.isFinite(clientX)) return;
    const rect = box.current ?? ref.current!.getBoundingClientRect();
    const t = rect.width > 0 ? Math.min(1, Math.max(0, (clientX - rect.left) / rect.width)) : 0;
    const raw = lo + t * (hi - lo);
    // SHIFT snaps to the coarse grid; a control with a step always
    // quantizes to it, shift or not.
    const next = shift ? quantize(raw, snapStep(lo, hi)) : step !== undefined ? quantize(raw, step) : raw;
    // A move this track never saw pressed (a press that began outside
    // it) writes as it always did.
    if (!dragging.current) {
      onChange(next);
      return;
    }
    setDrag(next);
    startTransition(() => onChange(next));
  };
  const release = () => {
    if (!dragging.current) {
      // An ignored press or a second release owns no gesture.
      return;
    }
    dragging.current = false;
    box.current = null;
    startTransition(() => {
      setDrag(null);
      onEnd?.();
    });
  };
  return (
    <>
    <div
      ref={ref}
      className="strack"
      role="slider"
      aria-label={label}
      aria-valuenow={shown}
      aria-valuemin={lo}
      aria-valuemax={hi}
      aria-disabled={disabled || undefined}
      data-disabled={disabled || undefined}
      data-testid={testid}
      data-hint={hint}
      tabIndex={0}
      onPointerDown={(e) => {
        if (disabled || !isPrimaryPress(e)) return;
        (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
        const r = ref.current!.getBoundingClientRect();
        box.current = { left: r.left, width: r.width };
        dragging.current = true;
        onBegin?.();
        setFromClientX(e.clientX, e.shiftKey);
      }}
      onPointerMove={(e) => !disabled && e.buttons === 1 && setFromClientX(e.clientX, e.shiftKey)}
      onPointerUp={() => !disabled && release()}
      onLostPointerCapture={() => !disabled && release()}
      onKeyDown={(e) => {
        if (disabled) return;
        // A stepped control moves one step and stays on its grid; a
        // continuous one moves a hundredth of the span, unrounded.
        const unit = e.shiftKey ? snapStep(lo, hi) : step ?? (hi - lo) / 100;
        if (["ArrowRight", "ArrowLeft", "ArrowUp", "ArrowDown", "Home", "End"].includes(e.key)) { e.preventDefault(); e.stopPropagation(); }
        if (e.key === "Home") onChange(lo);
        if (e.key === "End") onChange(hi);
        if (e.key === "ArrowRight" || e.key === "ArrowUp")
          onChange(step !== undefined ? quantize(value + unit, unit) : Math.min(hi, value + unit));
        if (e.key === "ArrowLeft" || e.key === "ArrowDown")
          onChange(step !== undefined ? quantize(value - unit, unit) : Math.max(lo, value - unit));
      }}
    >
      <div className="rail" />
      {centered && <div className="center" />}
      <div className="fill" style={{ left: `${from}%`, width: `${w}%` }} />
      <div className="handle" style={{ left: `${pct}%` }} />
    </div>
    {readout?.(shown)}
    </>
  );
}


const UNSIGNED = new Set([
  "sharpening",
  "noise",
  "grain_amount",
  "grain_size",
  "strength",
  "opacity",
  "grade_strength",
  "sample",
  "shadows_gain",
  "midtones_gain",
  "highlights_gain",
  "red_gain",
  "green_gain",
  "blue_gain",
]);

/** How a value reads beside its slider, per param family. */
export function fmt(param: string, v: number): string {
  if (param === "exposure")
    return (v >= 0 ? "+" : "−") + Math.abs(v).toFixed(2);
  if (param === "temperature") return String(Math.round(v));
  if (
    param === "black" ||
    param === "white" ||
    param === "gamma" ||
    param.startsWith("crop_")
  )
    return v.toFixed(2);
  if (param === "angle")
    return (v >= 0 ? "+" : "−") + Math.abs(v).toFixed(1) + "°";
  const r = Math.round(v);
  if (UNSIGNED.has(param)) return String(r);
  const range = PARAM_RANGE[param];
  if (range && range[1] - range[0] <= 2) return v.toFixed(2);
  return (r >= 0 ? "+" : "−") + Math.abs(r);
}

export function ValueField({
  param,
  value,
  lo,
  hi,
  beyond = false,
  display,
  scale,
  step,
  testid,
  hint,
  label,
  placeholder,
  onEmpty,
  shiftStep,
  align = "right",
  onCommit,
}: {
  param: string;
  value: number;
  lo: number;
  hi: number;
  /** the value is outside what the slider can reach, so the field says
   * so rather than looking like the handle has stuck at one end */
  beyond?: boolean;
  /** overrides the per-param formatting (the rig's dials are plain
   * integers with no param family to answer to) */
  display?: (v: number) => string;
  /** the field shows and accepts value*scale: a brush radius of 0.04
   * reads and types as 8, because nobody thinks in fractions of the
   * frame. The commit divides back before clamping. */
  scale?: number;
  /** with a step, the arrows nudge by it and a sideways drag scrubs the
   * value (rows and columns should drag like every other
   * number). Ten pixels of drag is one step; a plain click still
   * types.*/
  step?: number;
  testid?: string;
  hint?: string;
  /** the accessible name, when "<param> value" is not what it is */
  label?: string;
  /** shown while the display is empty (the take filter's open maximum
   * reads "any") */
  placeholder?: string;
  /** a cleared field, or one holding the placeholder's word, means
   * something rather than nothing: the take filter's maximum goes back
   * to any. Without it, a cleared field keeps its value. */
  onEmpty?: () => void;
  /** with Shift held, the arrows move by this many steps */
  shiftStep?: number;
  /** right beside a slider's label; a field standing alone centers */
  align?: "right" | "center";
  onCommit: (v: number) => void;
}) {
  const [text, setText] = useState<string | null>(null);
  const skipBlur = useRef(false);
  const shown = scale !== undefined ? value * scale : value;
  const commit = (raw: string) => {
    setText(null);
    const parsed = Number(raw.trim().replace(/,/g, ""));
    const typed = raw.trim().toLowerCase();
    if (onEmpty && (typed === "" || (placeholder !== undefined && typed === placeholder.toLowerCase()))) {
      onEmpty();
      return;
    }
    // Anything unreadable leaves the value where it was rather than
    // reaching for zero, which is a real value and not what was meant.
    if (raw.trim() === "" || !Number.isFinite(parsed)) return;
    const asValue = scale !== undefined ? parsed / scale : parsed;
    onCommit(Math.min(hi, Math.max(lo, asValue)));
  };
  /** A stepped move, in the field's displayed space: arrows and drags
   * share it, clamped to the range the typing path enforces. */
  const nudge = (next: number) => {
    if (!Number.isFinite(next)) return;
    const asValue = scale !== undefined ? next / scale : next;
    setText(null);
    onCommit(Math.min(hi, Math.max(lo, asValue)));
  };
  return (
    <input
      className="val tnum"
      data-testid={testid ?? `value-${param}`}
      data-hint={hint}
      data-beyond={beyond || undefined}
      aria-label={label ?? `${param} value`}
      placeholder={placeholder}
      // inputMode rather than type=number: the spinner arrows are noise at
      // this size, and a number input rejects a lone "-" while you are
      // still typing the rest of it.
      inputMode="decimal"
      value={text ?? (display ?? ((v: number) => fmt(param, v)))(shown)}
      onChange={(e) => { skipBlur.current = false; setText(e.target.value); }}
      onFocus={(e) => { skipBlur.current = false; e.currentTarget.select(); }}
      onBlur={(e) => {
        if (skipBlur.current) { skipBlur.current = false; return; }
        if (text !== null) commit(e.target.value);
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          skipBlur.current = true;
          commit((e.target as HTMLInputElement).value);
          (e.target as HTMLInputElement).blur();
        }
        // Escape abandons the edit rather than committing half a number.
        if (e.key === "Escape") {
          skipBlur.current = true;
          setText(null);
          (e.target as HTMLInputElement).blur();
        }
        // A stepped field's arrows nudge the value; any other field's
        // arrows stay eaten, or they would move the caret instead.
        if (e.key === "ArrowUp" || e.key === "ArrowDown") {
          e.preventDefault();
          const by = step !== undefined && e.shiftKey && shiftStep !== undefined ? step * shiftStep : step;
          if (by !== undefined) {
            const raw = e.currentTarget.value.trim().replace(/,/g, "");
            const parsed = Number(raw);
            const current = text !== null && raw !== "" && Number.isFinite(parsed) ? parsed : shown;
            nudge(current + (e.key === "ArrowUp" ? by : -by));
          }
        }
        e.stopPropagation();
      }}
      onMouseDown={(e) => {
        if (step === undefined) return;
        // Left button only; mid-typing, the drag is text selection.
        if (e.button !== 0) return;
        if (document.activeElement === e.currentTarget) return;
        e.preventDefault();
        const target = e.currentTarget;
        const startX = e.clientX;
        const startV = shown;
        let scrubbed = false;
        const move = (ev: MouseEvent) => {
          if (!scrubbed && Math.abs(ev.clientX - startX) < 3) return;
          scrubbed = true;
          const raw = startV + ((ev.clientX - startX) * step) / 10;
          nudge(Math.round(raw / step) * step);
        };
        const up = () => {
          window.removeEventListener("mousemove", move);
          window.removeEventListener("mouseup", up);
          // The press that never became a drag is the click: hand the
          // field its caret, since the preventDefault above ate it.
          if (!scrubbed) {
            target.focus();
            target.select();
          }
        };
        window.addEventListener("mousemove", move);
        window.addEventListener("mouseup", up);
      }}
      style={{
        all: "unset",
        boxSizing: "border-box",
        width: "100%",
        textAlign: align,
        fontSize: 11,
        // Gold when the value is past what the slider can reach, so a
        // handle parked at the end is not mistaken for the real value.
        color: beyond ? "var(--accent)" : "#c2c7cb",
        fontVariantNumeric: "tabular-nums",
        cursor: step !== undefined ? "ew-resize" : "text",
        padding: "1px 2px",
        border: "1px solid transparent",
      }}
      onMouseEnter={(e) => (e.currentTarget.style.borderColor = "var(--line-4)")}
      onMouseLeave={(e) => (e.currentTarget.style.borderColor = "transparent")}
    />
  );
}
