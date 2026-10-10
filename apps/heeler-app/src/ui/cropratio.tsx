// The crop tool's settings on the viewer's floating sub-bar: the ratio
// presets and a ratio of your own as two numbers, width: height
// (2026-10-07: the Crop dialog was crowded, small and hard to read;
// its dropdown needed consistent font sizes, and X:Y needed separate
// fields). The menu is the panels' regular MenuField, the label and
// fields its 11px.

import React, { useEffect, useRef, useState } from "react";
import { CROP_RATIOS, CROP_RATIO_NAME_MAX, cropRatioList, type SavedCropRatio } from "../state";
import { MenuField } from "./menufield";
import { useDismiss } from "./hooks";

/** The two numbers the W: H fields show for a ratio: a preset's own
 * (3 and 2), else the smallest whole pair that makes it (an original
 * frame of 6024 by 4016 is 3: 2), else the ratio to 1. Free shows
 * nothing. */
export function ratioPair(aspect: number | null): [string, string] {
  if (aspect === null || !Number.isFinite(aspect) || aspect <= 0) return ["", ""];
  for (const [label, ratio] of CROP_RATIOS) {
    if (Math.abs(ratio - aspect) < 0.001) {
      const [w, h] = label.split(":");
      return [w, h];
    }
  }
  for (let h = 1; h <= 32; h++) {
    // Close enough to give the ratio back, not merely near it: 2.39 is
    // not 43: 18.
    const w = Math.round(aspect * h);
    if (w >= 1 && Math.abs(w / h - aspect) < 1e-4) return [String(w), String(h)];
  }
  return [String(Number(aspect.toFixed(3))), "1"];
}

/** A resolution as a ratio: its label in lowest terms (1920 by 1080 is
 * 16:9, 1366 by 768 is 683:384) and its width over height. Sides that
 * are not whole numbers have no lowest terms, so they read as the ratio
 * to 1. Null unless both sides are positive. */
export function resolutionRatio(w: number, h: number): { label: string; ratio: number } | null {
  if (!(Number.isFinite(w) && w > 0 && Number.isFinite(h) && h > 0)) return null;
  const ratio = w / h;
  if (!Number.isInteger(w) || !Number.isInteger(h)) return { label: `${Number(ratio.toFixed(3))}:1`, ratio };
  const gcd = (a: number, b: number): number => (b === 0 ? a : gcd(b, a % b));
  const d = gcd(w, h);
  return { label: `${w / d}:${h / d}`, ratio };
}

/** A side of the ratio as typed: a positive number, or null. */
function side(text: string): number | null {
  const n = Number(text.trim());
  return text.trim() !== "" && Number.isFinite(n) && n > 0 ? n : null;
}

const FIELD: React.CSSProperties = {
  width: 40,
  boxSizing: "border-box",
  textAlign: "center",
  fontSize: 11,
  fontFamily: "inherit",
  padding: "3px 4px",
  background: "var(--bg-app)",
  border: "1px solid var(--line-4)",
  borderRadius: "var(--radius-btn)",
  color: "var(--text-body)",
  outline: "none",
};

export function CropRatioBar({
  aspect,
  original,
  onRatio,
  resolution = null,
  saved = [],
  onSaved = () => {},
}: {
  /** The ratio the crop is held to, null when free. */
  aspect: number | null;
  /** The photograph's own width over height, when known. */
  original: number | null;
  /** Holds the crop to a ratio (null frees it). */
  onRatio: (ratio: number | null) => void;
  /** The photograph's size in pixels, offered to the calculator. */
  resolution?: [number, number] | null;
  /** The person's saved ratios (Prefs.cropRatios). */
  saved?: SavedCropRatio[];
  /** Replaces the saved ratios. */
  onSaved?: (next: SavedCropRatio[]) => void;
}) {
  const options: [string, number | null][] = [["Free", null], ["Original", original], ...cropRatioList({ cropRatios: saved })];
  const is = ([label, ratio]: [string, number | null]) =>
    ratio === null ? aspect === null && label === "Free" : aspect !== null && Math.abs(aspect - ratio) < 0.001;
  // A named ratio before Original: on a 3:2 photograph, choosing 3:2
  // reads 3:2, not Original.
  const named = options.findIndex((o, i) => i !== 1 && is(o));
  const match = named >= 0 ? named : is(options[1]) ? 1 : -1;
  // A ratio typed by hand is not in the list, so the menu says so
  // rather than lying about which preset is active.
  const value = match >= 0 ? String(match) : "custom";

  const [draft, setDraft] = useState<[string, string]>(() => ratioPair(aspect));
  // The fields follow the ratio in force: a preset fills them with its
  // numbers, Free empties them.
  useEffect(() => setDraft(ratioPair(aspect)), [aspect]);
  const pair = useRef<HTMLSpanElement>(null);

  const apply = () => {
    const [w, h] = [side(draft[0]), side(draft[1])];
    // A typo or a half-typed pair leaves the crop alone rather than
    // collapsing it to a sliver.
    if (w === null || h === null) return;
    const ratio = w / h;
    if (aspect === null || Math.abs(ratio - aspect) >= 0.0005) onRatio(ratio);
  };
  const keys = (e: React.KeyboardEvent<HTMLInputElement>) => {
    // The crop tool's own keys (Enter commits, Escape cancels) are not
    // this field's to trigger while it is being typed in.
    e.stopPropagation();
    if (e.key === "Enter") {
      e.preventDefault();
      apply();
    } else if (e.key === "Escape") {
      e.preventDefault();
      setDraft(ratioPair(aspect));
      (e.target as HTMLInputElement).blur();
    }
  };
  const field = (i: 0 | 1, testid: string, label: string, placeholder: string) => (
    <input
      data-testid={testid}
      aria-label={label}
      inputMode="decimal"
      placeholder={placeholder}
      value={draft[i]}
      onChange={(e) => {
        const next: [string, string] = [...draft];
        next[i] = e.target.value;
        setDraft(next);
      }}
      onKeyDown={keys}
      style={FIELD}
    />
  );

  return (
    <span style={{ display: "flex", alignItems: "center", gap: 10 }} data-testid="crop-aspects">
      <span style={{ fontSize: 11, letterSpacing: ".08em", color: "var(--text-faint)" }}>CROP</span>
      <MenuField
        testid="crop-aspect"
        size="regular"
        label="Crop ratio"
        hint="Hold the crop to a ratio"
        value={value}
        placeholder={aspect ? `${ratioPair(aspect).join(":")}` : "Custom"}
        options={options.map(([label], i) => ({ id: String(i), label }))}
        onChange={(id) => onRatio(options[Number(id)][1])}
      />
      <span
        ref={pair}
        style={{ display: "flex", alignItems: "center", gap: 5 }}
        data-hint="A ratio of your own: width, then height. Enter or leaving the fields applies it"
        onBlur={(e) => {
          // Leaving the pair applies it; moving from width to height
          // does not.
          if (!pair.current?.contains(e.relatedTarget as Node | null)) apply();
        }}
      >
        {field(0, "crop-aspect-w", "Ratio width", "W")}
        <span style={{ fontSize: 11, color: "var(--text-faint)" }}>:</span>
        {field(1, "crop-aspect-h", "Ratio height", "H")}
      </span>
      <AspectCalculator resolution={resolution} saved={saved} onRatio={onRatio} onSaved={onSaved} />
    </span>
  );
}

function CalculatorIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden focusable="false">
      <rect x="5" y="2.5" width="14" height="19" rx="2" />
      <rect x="8" y="5.5" width="8" height="4" rx="0.5" />
      <path d="M8.5 13h.01M12 13h.01M15.5 13h.01M8.5 16.5h.01M12 16.5h.01M15.5 16.5h.01" strokeWidth="2.4" />
    </svg>
  );
}

const PANEL_FIELD: React.CSSProperties = { ...FIELD, width: 64 };

/** The aspect ratio calculator, at the crop bar's right end: a
 * resolution in, its ratio out, applied to the crop or saved under a
 * name of your own (2026-10-09: "an 'aspect ratio calculator' where a
 * user enters in a resolution and it calculates the aspect ratio ...
 * Users should be able to save custom aspect ratios"). A saved ratio
 * joins the crop bar's menu and Photo > Crop to Aspect Ratio. */
function AspectCalculator({
  resolution,
  saved,
  onRatio,
  onSaved,
}: {
  resolution: [number, number] | null;
  saved: SavedCropRatio[];
  onRatio: (ratio: number) => void;
  onSaved: (next: SavedCropRatio[]) => void;
}) {
  const [open, setOpen] = useState(false);
  const [size, setSize] = useState<[string, string]>(["", ""]);
  const [name, setName] = useState("");
  const rootRef = useDismiss<HTMLSpanElement>(open, () => setOpen(false));
  const [w, h] = [side(size[0]), side(size[1])];
  const result = w !== null && h !== null ? resolutionRatio(w, h) : null;
  const nameTaken = saved.some((r) => r.name === (name.trim() || result?.label));

  const save = () => {
    if (!result || w === null || h === null) return;
    const label = (name.trim() || result.label).slice(0, CROP_RATIO_NAME_MAX);
    // The same name again replaces its ratio rather than listing two.
    onSaved([...saved.filter((r) => r.name !== label), { name: label, w, h }]);
    setName("");
  };
  // The crop tool's Enter and Escape are not this panel's fields' to
  // trigger; Enter in a size field applies the ratio, in the name saves.
  const keys = (enter: () => void) => (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Escape") return; // the root closes the panel
    e.stopPropagation();
    if (e.key === "Enter") {
      e.preventDefault();
      enter();
    }
  };
  const sizeField = (i: 0 | 1, label: string) => (
    <input
      data-testid={`crop-calc-${i === 0 ? "w" : "h"}`}
      aria-label={label}
      inputMode="decimal"
      placeholder={resolution ? String(resolution[i]) : i === 0 ? "Width" : "Height"}
      value={size[i]}
      onChange={(e) => {
        const next: [string, string] = [...size];
        next[i] = e.target.value;
        setSize(next);
      }}
      onKeyDown={keys(() => result && onRatio(result.ratio))}
      style={PANEL_FIELD}
    />
  );
  const heading: React.CSSProperties = { fontSize: 11, letterSpacing: ".1em", color: "var(--text-faint)" };

  return (
    <span
      ref={rootRef}
      style={{ position: "relative", display: "inline-flex" }}
      onKeyDown={(e) => {
        // Escape closes the panel and nothing else: the app's Cancel Tool
        // also listens for it, and would put the crop away with it. A
        // prevented key is one the shortcuts leave alone.
        if (open && e.key === "Escape") {
          e.preventDefault();
          e.stopPropagation();
          setOpen(false);
        }
      }}
    >
      <button
        className="chip"
        data-testid="crop-calc"
        data-active={open}
        aria-pressed={open}
        aria-label="Aspect ratio calculator"
        data-hint="Aspect ratio calculator: work out a ratio from a resolution, apply it, or save it"
        onClick={() => setOpen(!open)}
        style={{ display: "inline-flex", alignItems: "center", padding: "2px 5px" }}
      >
        <CalculatorIcon />
      </button>
      {open && (
        <div
          data-testid="crop-calc-panel"
          role="dialog"
          aria-label="Aspect ratio calculator"
          style={{
            position: "absolute", top: "calc(100% + 8px)", right: 0, zIndex: 30, width: 236,
            background: "#191817", border: "1px solid var(--line-4)", boxShadow: "0 6px 18px rgba(0,0,0,.5)",
            display: "flex", flexDirection: "column", gap: 9, padding: 10, fontSize: 11, color: "var(--text-body)",
          }}
        >
          <span style={heading}>ASPECT RATIO CALCULATOR</span>
          <span style={{ display: "flex", alignItems: "center", gap: 6 }} data-hint="A resolution in pixels: width, then height">
            {sizeField(0, "Resolution width")}
            <span style={{ color: "var(--text-faint)" }}>×</span>
            {sizeField(1, "Resolution height")}
            {resolution && (
              <button
                className="chip bare"
                data-testid="crop-calc-photo"
                data-hint="Fill in the photograph's own size"
                onClick={() => setSize([String(resolution[0]), String(resolution[1])])}
                style={{ fontSize: 11, padding: "1px 5px" }}
              >
                Photo
              </button>
            )}
          </span>
          <span data-testid="crop-calc-result" style={{ fontSize: 13, color: result ? "var(--text-bright, var(--text-body))" : "var(--text-ghost)" }}>
            {result ? (
              <>
                {result.label}
                <span style={{ fontSize: 11, color: "var(--text-faint)", marginLeft: 8 }}>{Number(result.ratio.toFixed(3))}:1</span>
              </>
            ) : (
              "Enter a width and height"
            )}
          </span>
          <button
            className="chip"
            data-testid="crop-calc-apply"
            disabled={!result}
            data-hint="Hold the crop to this ratio"
            onClick={() => result && onRatio(result.ratio)}
            style={{ alignSelf: "flex-start" }}
          >
            Apply to crop
          </button>
          <span style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <input
              data-testid="crop-calc-name"
              aria-label="Name for the saved ratio"
              placeholder={result ? result.label : "Name"}
              maxLength={CROP_RATIO_NAME_MAX}
              value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={keys(save)}
              style={{ ...FIELD, width: "auto", flex: 1, textAlign: "left" }}
            />
            <button
              className="chip"
              data-testid="crop-calc-save"
              disabled={!result}
              data-hint={nameTaken ? "Replace the saved ratio of this name" : "Save this ratio: it joins the crop ratio menus"}
              onClick={save}
            >
              {nameTaken ? "Replace" : "Save"}
            </button>
          </span>
          {saved.length > 0 && (
            <div data-testid="crop-calc-saved" style={{ display: "flex", flexDirection: "column", gap: 2, borderTop: "1px solid var(--line-4)", paddingTop: 7 }}>
              <span style={{ ...heading, marginBottom: 3 }}>SAVED</span>
              {saved.map((r) => (
                <span key={r.name} style={{ display: "flex", alignItems: "center", gap: 6 }}>
                  <button
                    className="chip bare"
                    data-testid={`crop-calc-saved-${r.name}`}
                    data-hint={`Hold the crop to ${r.name}`}
                    onClick={() => onRatio(r.w / r.h)}
                    style={{ flex: 1, textAlign: "left", display: "flex", gap: 8, padding: "2px 4px" }}
                  >
                    <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{r.name}</span>
                    <span style={{ color: "var(--text-faint)", marginLeft: "auto" }}>{r.w} × {r.h}</span>
                  </button>
                  <button
                    className="chip bare"
                    data-testid={`crop-calc-delete-${r.name}`}
                    aria-label={`Delete ${r.name}`}
                    data-hint={`Delete the saved ratio ${r.name}`}
                    onClick={() => onSaved(saved.filter((o) => o.name !== r.name))}
                    style={{ padding: "0 5px", color: "var(--text-faint)" }}
                  >
                    ×
                  </button>
                </span>
              ))}
            </div>
          )}
        </div>
      )}
    </span>
  );
}
