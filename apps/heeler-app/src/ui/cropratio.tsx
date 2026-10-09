// The crop tool's settings on the viewer's floating sub-bar: the ratio
// presets and a ratio of your own as two numbers, width: height
// (2026-10-07: the Crop dialog was crowded, small and hard to read;
// its dropdown needed consistent font sizes, and X:Y needed separate
// fields). The menu is the panels' regular MenuField, the label and
// fields its 11px.

import React, { useEffect, useRef, useState } from "react";
import { CROP_RATIOS } from "../state";
import { MenuField } from "./menufield";

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
}: {
  /** The ratio the crop is held to, null when free. */
  aspect: number | null;
  /** The photograph's own width over height, when known. */
  original: number | null;
  /** Holds the crop to a ratio (null frees it). */
  onRatio: (ratio: number | null) => void;
}) {
  const options: [string, number | null][] = [["Free", null], ["Original", original], ...CROP_RATIOS];
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
    </span>
  );
}
