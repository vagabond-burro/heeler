// A color swatch that opens Heeler's own picker.
//
// "The color picker is generic looking. It doesn't adhere
// to the look of Heeler." The native <input type="color"> hands the OS
// a dialog: white chrome on Windows, a different dialog on macOS, none
// of it dark, none of it ours, and on Windows it is a modal that steals
// the window. This is the same job done in the app's own language: a
// saturation/value field, a hue rail, the swatches a photographer
// actually reaches for, and a hex box for when you know the number.

import React, { useState } from "react";
import { opensLeft, opensUp, useDismiss } from "./hooks";
import { isPrimaryPress } from "./pointerguard";
import { ValueField } from "./track";

/** #rrggbb to h (0..360), s, v (0..1). */
export function hexToHsv(hex: string): [number, number, number] {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  const n = m ? parseInt(m[1], 16) : 0;
  const r = ((n >> 16) & 255) / 255;
  const g = ((n >> 8) & 255) / 255;
  const b = (n & 255) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const d = max - min;
  let h = 0;
  if (d > 1e-6) {
    if (max === r) h = 60 * (((g - b) / d) % 6);
    else if (max === g) h = 60 * ((b - r) / d + 2);
    else h = 60 * ((r - g) / d + 4);
  }
  return [(h + 360) % 360, max <= 0 ? 0 : d / max, max];
}

/** #rrggbb to 0..255 channels, for the dab's canvas tint. White on a
 * string that is not a color, which is what the dab always was. */
export function hexToRgb255(hex: string): [number, number, number] {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  const n = m ? parseInt(m[1], 16) : 0xffffff;
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

export function hsvToHex(h: number, s: number, v: number): string {
  const c = v * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = v - c;
  const t: [number, number, number] =
    h < 60 ? [c, x, 0]
    : h < 120 ? [x, c, 0]
    : h < 180 ? [0, c, x]
    : h < 240 ? [0, x, c]
    : h < 300 ? [x, 0, c]
    : [c, 0, x];
  const hex = t
    .map((u) => Math.round(Math.min(1, Math.max(0, u + m)) * 255).toString(16).padStart(2, "0"))
    .join("");
  return `#${hex}`;
}

/** The swatches worth having one click away when finishing a photograph:
 * the neutral ramp for dodging and burning, then warm and cool for skin
 * and skies. Not a rainbow: a rainbow is for designing, and this is not
 * a design tool. */
const SWATCHES = [
  "#000000", "#404040", "#808080", "#bfbfbf", "#ffffff",
  "#4a2f21", "#8a5a3c", "#c98f63", "#e8c39e", "#f7e3cd",
  "#1b2a44", "#2e4a6b", "#4e7ea8", "#8fb8d6", "#cfe2ef",
];

export function ColorField({
  value,
  onChange,
  label,
  testid,
  hint,
  width = 26,
  onBegin,
  onEnd,
}: {
  value: string;
  onChange: (hex: string) => void;
  label: string;
  testid: string;
  hint?: string;
  width?: number;
  /** Gesture brackets: a drag in the field or on the rail writes one
   * color per mousemove, and without the bracket each is its own undo
   * entry. The caller passes the key its command carries. */
  onBegin?: () => void;
  onEnd?: () => void;
}) {
  const [open, setOpen] = useState(false);
  // Which way there is room to open. "the color picker
  // expands below and out of the window, it should open above the
  // toolbar." Measured at open time rather than guessed from where the
  // field is declared, since the same component is used in the panel and
  // in the toolbar across the bottom of the viewer.
  const [up, setUp] = useState(false);
  // And which way there is room sideways. "I click on the
  // right side and it got cut off." A swatch at the panel's right edge
  // (the streak ribbon's last stop, say) opens its picker leftward,
  // hung from its right edge, rather than off the window.
  const [flip, setFlip] = useState(false);
  const root = useDismiss<HTMLDivElement>(open, () => setOpen(false));

  return (
    <div ref={root} style={{ position: "relative", display: "inline-flex" }}>
      <button
        data-testid={testid}
        data-value={value}
        data-active={open || undefined}
        aria-label={label}
        data-hint={hint ?? label}
        onClick={(e) => {
          e.stopPropagation();
          // The popover is about 250 tall; if that does not fit under
          // the swatch, it goes over it instead.
          setUp(opensUp(e.currentTarget as HTMLElement, 250));
          setFlip(opensLeft(e.currentTarget as HTMLElement, 186));
          setOpen((o) => !o);
        }}
        onMouseDown={(e) => e.stopPropagation()}
        style={{
          all: "unset",
          cursor: "pointer",
          width,
          height: 18,
          background: value,
          border: `1px solid ${open ? "var(--accent)" : "var(--line-4)"}`,
          boxSizing: "border-box",
        }}
      />
      {open && (
        <div
          data-testid={`${testid}-popover`}
          onMouseDown={(e) => e.stopPropagation()}
          style={{
            position: "absolute",
            ...(up ? { bottom: "calc(100% + 5px)" } : { top: "calc(100% + 5px)" }),
            ...(flip ? { right: 0 } : { left: 0 }), zIndex: 60, width: 186,
            background: "#191817", border: "1px solid var(--line-4)",
            boxShadow: "0 8px 22px rgba(0,0,0,.6)", padding: 8,
          }}
        >
          <ColorPicker value={value} onChange={onChange} label={label} testid={testid} onBegin={onBegin} onEnd={onEnd} />
        </div>
      )}
    </div>
  );
}

/** The picker itself: a saturation/value field, a hue rail, the swatches
 * and a hex box. The swatch's popover holds one; a Fill layer's open
 * settings hold one inline (2026-09-30: "instead of having the pop up
 * color swatch the layer could be collapsible/expandable and have both
 * the color picker and color fields"). A drag is one gesture (onBegin
 * and onEnd); only the primary button drags.*/
export function ColorPicker({
  value,
  onChange,
  label,
  testid,
  onBegin,
  onEnd,
  fieldHeight = 96,
}: {
  value: string;
  onChange: (hex: string) => void;
  label: string;
  testid: string;
  onBegin?: () => void;
  onEnd?: () => void;
  fieldHeight?: number;
}) {
  const [h, s, v] = hexToHsv(value);
  // The hex box's in-progress text. Bound straight to the canonical
  // value, a hex that is not yet six digits could never be typed: the
  // change was rejected, the prop never moved, and React snapped the
  // text back to the old color on every keystroke. The draft holds the
  // typing; only a complete color commits.
  const [draft, setDraft] = useState<string | null>(null);

  // Dragging in the field or the rail: pointer capture so a stroke that
  // leaves the box keeps steering, the same as every slider here.
  const track = (
    el: HTMLElement,
    e: React.PointerEvent,
    read: (fx: number, fy: number) => void,
  ) => {
    const rect = el.getBoundingClientRect();
    const at = (ev: { clientX: number; clientY: number }) => {
      if (!Number.isFinite(ev.clientX) || !Number.isFinite(ev.clientY) || rect.width <= 0 || rect.height <= 0) return;
      read(
        Math.min(1, Math.max(0, (ev.clientX - rect.left) / rect.width)),
        Math.min(1, Math.max(0, (ev.clientY - rect.top) / rect.height)),
      );
    };
    // The gesture opens before the first color is written, or the press
    // itself is an undo step of its own ahead of the drag's.
    onBegin?.();
    at(e);
    const move = (ev: PointerEvent) => at(ev);
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      onEnd?.();
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  return (
    <div data-testid={`${testid}-picker`} style={{ display: "flex", flexDirection: "column", gap: 7 }}>
      {/* Saturation across, value down, over the current hue. */}
      <div
        data-testid={`${testid}-field`}
        onPointerDown={(e) => {
          if (!isPrimaryPress(e)) return;
          e.preventDefault();
          track(e.currentTarget, e, (fx, fy) => onChange(hsvToHex(h, fx, 1 - fy)));
        }}
        style={{
          position: "relative", height: fieldHeight, cursor: "crosshair",
          background: `linear-gradient(to top, #000, transparent), linear-gradient(to right, #fff, ${hsvToHex(h, 1, 1)})`,
          border: "1px solid var(--line-2)",
        }}
      >
        <div
          style={{
            position: "absolute",
            left: `${s * 100}%`,
            top: `${(1 - v) * 100}%`,
            width: 9, height: 9, marginLeft: -5, marginTop: -5,
            borderRadius: 9, border: "1.5px solid #fff",
            boxShadow: "0 0 0 1px rgba(0,0,0,.6)", pointerEvents: "none",
          }}
        />
      </div>
      {/* Hue rail. */}
      <div
        data-testid={`${testid}-hue`}
        onPointerDown={(e) => {
          if (!isPrimaryPress(e)) return;
          e.preventDefault();
          track(e.currentTarget, e, (fx) => onChange(hsvToHex(fx * 360, s || 1, v || 1)));
        }}
        style={{
          position: "relative", height: 11, cursor: "ew-resize",
          background:
            "linear-gradient(to right, #f00 0%, #ff0 17%, #0f0 33%, #0ff 50%, #00f 67%, #f0f 83%, #f00 100%)",
          border: "1px solid var(--line-2)",
        }}
      >
        <div
          style={{
            position: "absolute", left: `${(h / 360) * 100}%`, top: -2, bottom: -2,
            width: 3, marginLeft: -1.5, background: "#fff",
            boxShadow: "0 0 0 1px rgba(0,0,0,.6)", pointerEvents: "none",
          }}
        />
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(5, 1fr)", gap: 3 }}>
        {SWATCHES.map((sw) => (
          <button
            key={sw}
            data-testid={`${testid}-swatch-${sw.slice(1)}`}
            aria-label={sw}
            onClick={() => onChange(sw)}
            style={{
              all: "unset", cursor: "pointer", height: 13, background: sw,
              border: `1px solid ${sw.toLowerCase() === value.toLowerCase() ? "var(--accent)" : "var(--line-2)"}`,
            }}
          />
        ))}
      </div>
      <input
        data-testid={`${testid}-hex`}
        aria-label={`${label} hex`}
        value={draft ?? value}
        spellCheck={false}
        onFocus={() => setDraft(value)}
        onChange={(e) => {
          const t = e.target.value;
          setDraft(t);
          const trimmed = t.trim();
          if (/^#?[0-9a-f]{6}$/i.test(trimmed)) {
            onChange(trimmed.startsWith("#") ? trimmed : `#${trimmed}`);
          }
        }}
        onBlur={() => setDraft(null)}
        style={{
          background: "var(--bg-app)", border: "1px solid var(--line-4)",
          color: "var(--text-body)", fontSize: 11, padding: "2px 5px",
          fontFamily: "Consolas, ui-monospace, monospace", outline: "none",
        }}
      />
    </div>
  );
}

/** #rrggbb from 0..255 channels, rounded and clamped. */
export function rgb255ToHex(rgb: [number, number, number]): string {
  return `#${rgb.map((c) => Math.round(Math.min(255, Math.max(0, c))).toString(16).padStart(2, "0")).join("")}`;
}

/** A Fill layer's open settings: the picker inline, then the color as
 * three numbers, RGB (0 to 255) or CMY (0 to 100 percent of ink, the
 * complement of RGB, the way the Color Console names a band in CMY).
 * Each typed number is one undo step; a drag in the picker is one. */
export function FillColorControls({
  value,
  onChange,
  testid,
  onBegin,
  onEnd,
}: {
  value: string;
  onChange: (hex: string) => void;
  testid: string;
  onBegin?: () => void;
  onEnd?: () => void;
}) {
  const [cmy, setCmy] = useState(false);
  const rgb = hexToRgb255(value);
  const channels = cmy ? ["C", "M", "Y"] : ["R", "G", "B"];
  const shown = (c: number) => (cmy ? ((255 - c) / 255) * 100 : c);
  const commit = (i: number, typed: number) => {
    const next: [number, number, number] = [...rgb];
    next[i] = cmy ? 255 - (Math.min(100, Math.max(0, typed)) / 100) * 255 : typed;
    onChange(rgb255ToHex(next));
  };
  const face = (on: boolean, word: string, hint: string, testSuffix: string, pick: () => void) => (
    <button
      className="chip"
      data-testid={`${testid}-mode-${testSuffix}`}
      data-active={on || undefined}
      aria-pressed={on}
      data-hint={hint}
      onClick={pick}
      style={{ fontSize: 11, padding: "1px 6px" }}
    >
      {word}
    </button>
  );
  return (
    <div
      data-testid={`${testid}-inline`}
      onMouseDown={(e) => e.stopPropagation()}
      style={{ display: "flex", flexDirection: "column", gap: 6 }}
    >
      <ColorPicker value={value} onChange={onChange} label="Fill color" testid={testid} onBegin={onBegin} onEnd={onEnd} fieldHeight={84} />
      <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
        <div role="group" aria-label="Color numbers as" style={{ display: "inline-flex", gap: 3, flex: "none" }}>
          {face(!cmy, "RGB", "Show the color as red, green and blue, 0 to 255", "rgb", () => setCmy(false))}
          {face(cmy, "CMY", "Show the color as cyan, magenta and yellow ink, 0 to 100 percent", "cmy", () => setCmy(true))}
        </div>
        {channels.map((ch, i) => (
          <div key={ch} style={{ display: "flex", alignItems: "center", gap: 3, flex: 1, minWidth: 0 }}>
            <span style={{ fontSize: 11, color: "var(--text-faint)" }}>{ch}</span>
            <ValueField
              param={`fill ${ch}`}
              label={`Fill ${ch}`}
              value={shown(rgb[i])}
              lo={0}
              hi={cmy ? 100 : 255}
              display={(v) => String(Math.round(v))}
              testid={`${testid}-${ch.toLowerCase()}`}
              hint={cmy ? `${ch}: ink, 0 to 100 percent` : `${ch}: 0 to 255`}
              onCommit={(v) => commit(i, v)}
            />
          </div>
        ))}
      </div>
    </div>
  );
}
