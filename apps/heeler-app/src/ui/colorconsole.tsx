// The Color Tune's face (designed with the owner): one wheel at a
// time, because seven wheels do not fit a side panel; the band strip
// picks which, and the RGB / CMY group views show a trio of smaller
// wheels for cross-band balancing, editable like the big one (The
// report: editable).
//
// The band strip is the six fixed bands in two families, R G B then C
// M Y, and the picker beside them. Custom bands do not sit in the
// strip (2026-09-04: chips stacking up and pushing the view buttons
// "doesn't sit right"); they live in a list under the wheel, five
// rows tall before it scrolls, each row its name, its own picker and
// its delete.

import React, { useRef, useState } from "react";
import type { Command, NodeCard } from "../state";
import {
  DEFAULT_WIDTH,
  FIXED_BANDS,
  faceAngleToOkHue,
  okHueToFaceAngle,
  bandLabel,
  bandOf,
  bandRgb,
  customCount,
  nextNameFormat,
  parseConsoleBands,
  rgbToHex,
  serializeConsoleBands,
  withBand,
  type ConsoleBand,
  type NameFormat,
} from "../consolebands";
import { EyedropperIcon } from "./panelicons";

type D = React.Dispatch<Command>;

type View = "one" | "rgb" | "cmy";

/** A slider over a band value (bands live in JSON, not node params, so
 * the house Slider cannot drive them; this renders with the same
 * classes so the two are visually one family). */
function BandSlider({
  label,
  shortLabel,
  compact = false,
  value,
  range,
  centered = true,
  testid,
  onChange,
  onGesture,
}: {
  label: string;
  /** what renders when the panel is narrow; aria keeps the full name */
  shortLabel?: string;
  compact?: boolean;
  value: number;
  range: [number, number];
  centered?: boolean;
  testid: string;
  onChange: (v: number) => void;
  onGesture: (begin: boolean) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  // The gesture's owner: only the pointer that pressed writes and
  // closes, so a second finger's release cannot end another's drag and
  // a canceled gesture closes exactly once (the Color Wheels pass's
  // pattern, which this slider predates).
  const pointer = useRef<number | null>(null);
  const endDrag = (pointerId: number) => {
    if (pointer.current !== (pointerId ?? 0)) return;
    pointer.current = null;
    onGesture(false);
  };
  const [lo, hi] = range;
  const pct = Math.min(100, Math.max(0, ((value - lo) / (hi - lo)) * 100));
  const from = centered ? Math.min(50, pct) : 0;
  const w = centered ? Math.abs(pct - 50) : pct;
  const set = (clientX: number) => {
    if (!Number.isFinite(clientX)) return;
    const rect = ref.current!.getBoundingClientRect();
    const t = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
    onChange(lo + t * (hi - lo));
  };
  return (
    <div className="srow" data-testid={testid} style={compact ? { gridTemplateColumns: "14px 1fr 34px" } : undefined}>
      <div className="lbl" data-hint={compact ? label : undefined}>
        {compact ? (shortLabel ?? label[0]) : label}
      </div>
      <div
        ref={ref}
        className="strack"
        role="slider"
        aria-label={label}
        aria-valuenow={value}
        aria-valuemin={lo}
        aria-valuemax={hi}
        tabIndex={0}
        style={{ touchAction: "none" }}
        onPointerDown={(e) => {
          if (e.button > 0 || pointer.current !== null) return;
          pointer.current = e.pointerId ?? 0;
          e.currentTarget.focus();
          e.currentTarget.setPointerCapture?.(e.pointerId);
          onGesture(true);
          set(e.clientX);
        }}
        onPointerMove={(e) => pointer.current === (e.pointerId ?? 0) && set(e.clientX)}
        onPointerUp={(e) => endDrag(e.pointerId)}
        onPointerCancel={(e) => endDrag(e.pointerId)}
        onLostPointerCapture={(e) => endDrag(e.pointerId)}
        onKeyDown={(e) => {
          const step = (hi - lo) / 100;
          if (["ArrowRight", "ArrowLeft", "ArrowUp", "ArrowDown", "Home", "End"].includes(e.key)) { e.preventDefault(); e.stopPropagation(); }
          if (e.key === "Home") onChange(lo);
          if (e.key === "End") onChange(hi);
          if (e.key === "ArrowRight" || e.key === "ArrowUp") onChange(Math.min(hi, value + step));
          if (e.key === "ArrowLeft" || e.key === "ArrowDown") onChange(Math.max(lo, value - step));
        }}
      >
        <div className="rail" />
        {centered && <div className="center" />}
        <div className="fill" style={{ left: `${from}%`, width: `${w}%` }} />
        <div className="handle" style={{ left: `${pct}%` }} />
      </div>
      {/* The house value class (.srow .val): same 11px tabular figures
as Exposure and Levels,. */}
      <div className="val tnum">{value.toFixed(Math.abs(hi - lo) <= 4 ? 2 : 0)}</div>
    </div>
  );
}

/** The wheel, wearing the house face: the same muted conic disc,
 * desaturated center, tick and puck as Color Wheels and Color Bend
 * (all wheels consistent). The face is decorative; the
 * engine speaks OkLab, so the face bridge translates the direction
 * under the cursor into the OkLab hue of the color actually shown
 * there.*/
function BandPad({
  band,
  size,
  testid,
  onWheel,
  onGesture,
}: {
  band: ConsoleBand;
  size: number;
  testid: string;
  onWheel: (xy: [number, number]) => void;
  onGesture: (begin: boolean) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  // One gesture, one owner, closed once: as the Color Wheels puck and
  // the band sliders beside it (this pad got capture in the first pass;
  // the ownership, focus and cancellation half of the gesture contract
  // is the second pass's).
  const pointer = useRef<number | null>(null);
  const endDrag = (pointerId: number) => {
    if (pointer.current !== (pointerId ?? 0)) return;
    pointer.current = null;
    onGesture(false);
  };
  const k = Math.max(1, size / 86);
  const strength = band.wheel ? Math.min(1, Math.hypot(band.wheel[0], band.wheel[1])) : 0;
  const okHue =
    band.wheel && strength > 1e-4
      ? ((Math.atan2(band.wheel[1], band.wheel[0]) * 180) / Math.PI + 360) % 360
      : null;
  const faceDeg = okHue !== null ? okHueToFaceAngle(okHue) : 0;
  const puckX = 50 + strength * 42 * Math.cos((faceDeg * Math.PI) / 180);
  const puckY = 50 + strength * 42 * Math.sin((faceDeg * Math.PI) / 180);
  const set = (clientX: number, clientY: number) => {
    if (!Number.isFinite(clientX) || !Number.isFinite(clientY)) return;
    const rect = ref.current!.getBoundingClientRect();
    // The puck is drawn at 42% of the width at full strength, so the
    // input maps 42% too: normalizing by the half width wrote 0.84 when
    // the puck was grabbed at its drawn full-strength position (the bug
    // the Color Wheels pass fixed in the Wheel; this pad had it still).
    const dx = (clientX - (rect.left + rect.width / 2)) / ((rect.width || 2) * 0.42);
    const dy = (clientY - (rect.top + rect.height / 2)) / ((rect.height || 2) * 0.42);
    const dist = Math.min(1, Math.hypot(dx, dy));
    const screenDeg = (Math.atan2(dy, dx) * 180) / Math.PI;
    const hue = (faceAngleToOkHue(screenDeg) * Math.PI) / 180;
    onWheel([dist * Math.cos(hue), dist * Math.sin(hue)]);
  };
  return (
    <div
      ref={ref}
      role="slider"
      aria-label="Band wheel"
      aria-valuetext={`Hue ${Math.round(okHue ?? 0)} degrees, strength ${Math.round(strength * 100)} percent`}
      onKeyDown={e => {
        if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(e.key)) return;
        e.preventDefault(); e.stopPropagation();
        // The arrows move the PUCK the way they point. The face is a
        // nonlinear warp of OkLab a,b (measured, 26.3.2: a step taken
        // in a,b landed the puck as much as 37 degrees off the arrow's
        // direction), so the step is taken in screen space and bridged
        // back through the face table.
        const step = e.shiftKey ? 0.01 : 0.05;
        let sx = strength * Math.cos((faceDeg * Math.PI) / 180);
        let sy = strength * Math.sin((faceDeg * Math.PI) / 180);
        if (e.key === "ArrowLeft") sx -= step;
        if (e.key === "ArrowRight") sx += step;
        if (e.key === "ArrowUp") sy -= step;
        if (e.key === "ArrowDown") sy += step;
        const dist = Math.min(1, Math.hypot(sx, sy));
        const hue = (faceAngleToOkHue((Math.atan2(sy, sx) * 180) / Math.PI) * Math.PI) / 180;
        onWheel([dist * Math.cos(hue), dist * Math.sin(hue)]);
      }}
      aria-valuenow={okHue !== null ? Math.round(okHue) : 0}
      aria-valuemin={0}
      aria-valuemax={360}
      tabIndex={0}
      data-testid={testid}
      // Captured, like Color Wheels' pucks and the band sliders beside
      // it: a drag past the rim keeps full strength and ends where the
      // button comes up, not where the pointer leaves the disc (which
      // stopped short of full and then wrote every move back inside as
      // an undo step of its own).
      onPointerDown={(e) => {
        if (e.button > 0 || pointer.current !== null) return;
        pointer.current = e.pointerId ?? 0;
        e.currentTarget.focus();
        e.currentTarget.setPointerCapture?.(e.pointerId);
        onGesture(true);
        set(e.clientX, e.clientY);
      }}
      onPointerMove={(e) => pointer.current === (e.pointerId ?? 0) && set(e.clientX, e.clientY)}
      onPointerUp={(e) => endDrag(e.pointerId)}
      onPointerCancel={(e) => endDrag(e.pointerId)}
      onLostPointerCapture={(e) => endDrag(e.pointerId)}
      style={{
        position: "relative",
        width: size,
        height: size,
        borderRadius: "50%",
        cursor: "crosshair",
        flex: "none",
        touchAction: "none",
        background:
          "conic-gradient(from 90deg,#c25b5b,#c2c25b,#5bc25b,#5bc2c2,#5b5bc2,#c25bc2,#c25b5b)",
        border: "1px solid var(--line-4)",
      }}
    >
      <div
        style={{
          position: "absolute",
          inset: 1,
          borderRadius: "50%",
          background:
            "radial-gradient(circle,#1e1d1b 6%,rgba(30,29,27,.85) 26%,rgba(30,29,27,0) 74%)",
          pointerEvents: "none",
        }}
      />
      <div
        style={{
          position: "absolute",
          left: "50%",
          top: "50%",
          width: Math.max(1, Math.round(k)),
          height: 9 * k,
          background: "var(--wire)",
          transform: "translate(-50%,-50%)",
          pointerEvents: "none",
        }}
      />
      <div
        style={{
          position: "absolute",
          left: `${puckX}%`,
          top: `${puckY}%`,
          width: 9 * k,
          height: 9 * k,
          border: `${1.5 * k}px solid var(--text-hi)`,
          borderRadius: "50%",
          background: "rgba(0,0,0,.35)",
          transform: "translate(-50%,-50%)",
          pointerEvents: "none",
        }}
      />
    </div>
  );
}

export function ColorConsoleBlock({
  node,
  dispatch,
  width = 272,
  band,
  onBand,
  pickArmed = false,
  pickBand = null,
  onTogglePick,
  customMax = 4,
  nameFormat,
  onNameFormat,
  compact = false,
  windowed = false,
  height = 320,
}: {
  node: NodeCard;
  dispatch: D;
  width?: number;
  /** active band id, owned by the caller (viewer picks focus it) */
  band: string;
  onBand: (id: string) => void;
  pickArmed?: boolean;
  /** which custom band the armed pick will move; null makes a new one */
  pickBand?: string | null;
  /** arm the picker: for a new band, or (with an id) to move that one */
  onTogglePick?: (band?: string) => void;
  /** Preferences: how many custom bands may exist */
  customMax?: number;
  /** what an unnamed custom band is called (a preference, so the
   * panel, the inspector and the window agree); local when absent */
  nameFormat?: NameFormat;
  onNameFormat?: (fmt: NameFormat) => void;
  /** panel width is scarce: single-letter slider labels; the
   * pop-out uses the full names*/
  compact?: boolean;
  /** the pop-out layout: the wheel takes the left side at full size,
   * every control stacks on the right, Smoothing above the band
   * buttons, everything bigger*/
  windowed?: boolean;
  height?: number;
}) {
  const bands = parseConsoleBands(node.textParams?.bands);
  const active = bandOf(bands, band);
  const [view, setView] = useState<View>("one");
  const [localFormat, setLocalFormat] = useState<NameFormat>("rgb");
  const fmt = nameFormat ?? localFormat;
  const cycleFormat = () => (onNameFormat ?? setLocalFormat)(nextNameFormat(fmt));
  /** the row being renamed, and its draft */
  const [renaming, setRenaming] = useState<{ id: string; value: string } | null>(null);
  const cancelRename = useRef(false);

  const write = (next: ConsoleBand[]) => {
    dispatch({
      type: "set_text_param",
      id: node.id,
      param: "bands",
      value: serializeConsoleBands(next),
    });
  };
  const gesture = (begin: boolean) =>
    dispatch(begin ? { type: "begin_gesture", key: `${node.id}.bands` } : { type: "end_gesture" });
  const edit = (id: string, patch: Partial<ConsoleBand>) =>
    write(withBand(bands, { ...bandOf(bands, id), ...patch }));

  // Custom bands are the ones that carry a picked center; the fixed
  // CYAN band's id is "c", so a prefix test would list it here.
  const customs = bands.filter((b) => b.center !== undefined);
  const touched = (id: string) => {
    const b = bandOf(bands, id);
    return (
      (b.wheel && Math.hypot(b.wheel[0], b.wheel[1]) > 1e-4) ||
      (b.hue ?? 0) !== 0 ||
      (b.sat ?? 0) !== 0 ||
      (b.vib ?? 0) !== 0 ||
      (b.lum ?? 0) !== 0
    );
  };

  const chip = (id: string, label: string, swatch?: string) => (
    <button
      key={id}
      className="chip"
      data-testid={`console-band-${id}`}
      data-active={band === id || undefined}
      aria-pressed={band === id}
      style={{
        fontSize: windowed ? 11 : 9,
        padding: windowed ? "4px 12px" : "1px 7px",
        flex: "none",
        display: "flex",
        alignItems: "center",
        gap: windowed ? 6 : 4,
      }}
      onClick={() => {
        onBand(id);
        setView("one");
      }}
    >
      {swatch && (
        <span
          style={{
            width: windowed ? 8 : 6,
            height: windowed ? 8 : 6,
            background: swatch,
            borderRadius: windowed ? 4 : 3,
          }}
        />
      )}
      {label}
      {touched(id) && (
        <span style={{ width: 4, height: 4, borderRadius: 2, background: "var(--accent)" }} />
      )}
    </button>
  );

  const viewSeg = (
    <div
      className="zoom-seg"
      role="group"
      aria-label="Console view"
      style={{ border: "1px solid var(--line-4)" }}
    >
      {(
        [
          ["one", "One wheel at a time", <circle key="o" cx="6" cy="6" r="3.4" />],
          [
            "rgb",
            "The red, green and blue wheels together",
            <g key="rgb">
              <circle cx="3" cy="6" r="2" fill="#c04a3a" stroke="none" />
              <circle cx="6" cy="6" r="2" fill="#4a9a4a" stroke="none" />
              <circle cx="9" cy="6" r="2" fill="#4a5ac0" stroke="none" />
            </g>,
          ],
          [
            "cmy",
            "The cyan, magenta and yellow wheels together",
            <g key="cmy">
              <circle cx="3" cy="6" r="2" fill="#3a9a9a" stroke="none" />
              <circle cx="6" cy="6" r="2" fill="#a84a9a" stroke="none" />
              <circle cx="9" cy="6" r="2" fill="#b9a23a" stroke="none" />
            </g>,
          ],
        ] as const
      ).map(([id, hint, glyph]) => (
        <button
          key={id}
          data-testid={`console-view-${id}`}
          data-active={view === id || undefined}
          aria-pressed={view === id}
          aria-label={hint}
          data-hint={hint}
          style={{ padding: windowed ? "3px 9px" : "1px 5px", display: "flex", alignItems: "center" }}
          onClick={() => setView(id)}
        >
          <svg
            width={windowed ? 16 : 12}
            height={windowed ? 16 : 12}
            viewBox="0 0 12 12"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.4"
          >
            {glyph}
          </svg>
        </button>
      ))}
    </div>
  );

  const fixedChip = (id: string) => {
    const f = FIXED_BANDS.find((x) => x.id === id)!;
    return chip(f.id, f.label, f.swatch);
  };
  const divider = (
    <span
      aria-hidden
      style={{ width: 1, height: windowed ? 16 : 12, background: "var(--line-4)", flex: "none" }}
    />
  );
  const full = customCount(bands) >= customMax;
  // One picker for new bands, an icon like every other eyedropper in the
  // app. Full is disabled, never hidden (a control that does
  // not apply is grayed, so the row keeps its shape); the hint rides a
  // wrapper because a disabled button fires no mouse events.
  const picker = onTogglePick && (
    <span
      data-hint={
        full
          ? `Pick a color on the photo for a new custom band. All ${customMax} custom bands are taken: delete one in the list, or raise the limit in Preferences`
          : "Pick a color on the photo and a custom band is born on that hue: skin, sky, a jersey, anything"
      }
      style={{ display: "inline-flex" }}
    >
      <button
        className="chip"
        data-testid="console-add-custom"
        data-active={(pickArmed && !pickBand) || undefined}
        aria-pressed={pickArmed && !pickBand}
        aria-label="Pick a color from the photo for a new custom band"
        disabled={full}
        style={{
          padding: windowed ? "3px 9px" : "1px 6px",
          flex: "none",
          display: "flex",
          alignItems: "center",
        }}
        onClick={() => onTogglePick()}
      >
        <EyedropperIcon size={windowed ? 14 : 11} />
      </button>
    </span>
  );
  const chipsRow = (
    <div
      data-testid="console-band-strip"
      style={{ display: "flex", gap: windowed ? 6 : 4, alignItems: "center", minWidth: 0 }}
    >
      {["r", "g", "b"].map(fixedChip)}
      {divider}
      {["c", "m", "y"].map(fixedChip)}
      {picker && divider}
      {picker}
    </div>
  );
  // The view buttons sit on their own row under the bands (2026-09-05:
  // "below the RGB buttons"), not at the strip's far end.
  const stripRows = (
    <div style={{ display: "flex", flexDirection: "column", gap: windowed ? 6 : 4, alignItems: "flex-start" }}>
      {chipsRow}
      {viewSeg}
    </div>
  );

  // The custom band list: name | picker | delete, five rows before it
  // scrolls. The header is the notation an unnamed band is called by;
  // clicking it cycles RGB, CMY, hex. A named band keeps its name in
  // every notation.
  const rowH = windowed ? 26 : 20;
  const iconCol = windowed ? 26 : 22;
  const commitRename = () => {
    if (!renaming) return;
    const { id, value } = renaming;
    setRenaming(null);
    if (cancelRename.current) {
      cancelRename.current = false;
      return;
    }
    const name = value.trim();
    const was = bandOf(bands, id);
    const next: ConsoleBand = { ...was };
    if (name) next.name = name;
    else delete next.name;
    write(withBand(bands, next));
  };
  const rowButton: React.CSSProperties = {
    all: "unset",
    cursor: "pointer",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    width: iconCol,
    height: rowH,
    color: "var(--text-dim)",
    flex: "none",
  };
  const customList = customs.length > 0 && (
    <div
      data-testid="console-custom-list"
      style={{
        border: "1px solid var(--line-4)",
        borderRadius: "var(--radius-btn)",
        fontSize: windowed ? 11 : 9,
        minWidth: 0,
      }}
    >
      <div
        style={{
          display: "grid",
          gridTemplateColumns: `1fr ${iconCol}px ${iconCol}px`,
          alignItems: "center",
          height: rowH,
          borderBottom: "1px solid var(--line-4)",
        }}
      >
        <button
          className="chip bare"
          data-testid="console-name-format"
          aria-label={`Unnamed bands are shown as ${fmt.toUpperCase()}; click for the next notation`}
          data-hint="Unnamed bands go by their picked color: click to show it as RGB, CMY or hex"
          style={{
            fontSize: windowed ? 10 : 8,
            letterSpacing: ".14em",
            color: "var(--text-faint)",
            padding: `0 ${windowed ? 9 : 6}px`,
            height: rowH - 2,
            display: "flex",
            alignItems: "center",
            justifySelf: "start",
          }}
          onClick={cycleFormat}
        >
          {fmt.toUpperCase()}
        </button>
      </div>
      <div style={{ maxHeight: rowH * 5, overflowY: "auto" }}>
        {customs.map((b) => {
          const label = bandLabel(b, fmt);
          const rgb = bandRgb(b);
          const selected = band === b.id;
          const editing = renaming?.id === b.id;
          return (
            <div
              key={b.id}
              data-testid={`console-custom-${b.id}`}
              data-active={selected || undefined}
              style={{
                display: "grid",
                gridTemplateColumns: `1fr ${iconCol}px ${iconCol}px`,
                alignItems: "center",
                height: rowH,
                background: selected ? "var(--accent-tint)" : undefined,
                color: selected ? "var(--accent)" : "var(--text-mid)",
              }}
            >
              <div style={{ display: "flex", alignItems: "center", gap: windowed ? 6 : 4, minWidth: 0, paddingLeft: windowed ? 9 : 6 }}>
                <span
                  aria-hidden
                  style={{
                    width: windowed ? 8 : 6,
                    height: windowed ? 8 : 6,
                    borderRadius: "50%",
                    background: rgbToHex(rgb),
                    border: "1px solid var(--line-4)",
                    flex: "none",
                  }}
                />
                {editing ? (
                  <input
                    autoFocus
                    value={renaming!.value}
                    data-testid={`console-rename-input-${b.id}`}
                    aria-label="Band name"
                    placeholder={bandLabel({ ...b, name: undefined }, fmt)}
                    onChange={(e) => setRenaming({ id: b.id, value: e.target.value })}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") e.currentTarget.blur();
                      if (e.key === "Escape") {
                        cancelRename.current = true;
                        e.currentTarget.blur();
                      }
                      e.stopPropagation();
                    }}
                    onBlur={commitRename}
                    style={{
                      flex: 1,
                      minWidth: 0,
                      background: "var(--bg-app)",
                      border: "1px solid var(--line-4)",
                      color: "var(--text-body)",
                      fontSize: windowed ? 11 : 9,
                      padding: "0 4px",
                      outline: "none",
                      fontFamily: "inherit",
                    }}
                  />
                ) : (
                  <button
                    data-testid={`console-custom-name-${b.id}`}
                    aria-pressed={selected}
                    data-hint={`Edit ${label}: its wheel and sliders take the panel`}
                    style={{
                      all: "unset",
                      cursor: "pointer",
                      flex: 1,
                      minWidth: 0,
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                      letterSpacing: b.name ? undefined : ".06em",
                      lineHeight: `${rowH}px`,
                    }}
                    onClick={() => {
                      onBand(b.id);
                      setView("one");
                    }}
                  >
                    {label}
                  </button>
                )}
                {touched(b.id) && !editing && (
                  <span
                    aria-hidden
                    style={{ width: 4, height: 4, borderRadius: 2, background: "var(--accent)", flex: "none" }}
                  />
                )}
                {!editing && (
                  <button
                    className="rowbtn"
                    data-testid={`console-rename-${b.id}`}
                    aria-label={`Name ${label}`}
                    data-hint="Give this band a name, like Bride's skin; an empty name goes back to the color"
                    style={{ marginRight: 2 }}
                    onClick={() => {
                      cancelRename.current = false;
                      setRenaming({ id: b.id, value: b.name ?? "" });
                    }}
                  >
                    <svg width={windowed ? 11 : 9} height={windowed ? 11 : 9} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden focusable="false">
                      <path d="M12 20h9M16.5 3.5a2.1 2.1 0 013 3L7 19l-4 1 1-4L16.5 3.5z" />
                    </svg>
                  </button>
                )}
              </div>
              {onTogglePick ? (
                <button
                  data-testid={`console-repick-${b.id}`}
                  data-active={(pickArmed && pickBand === b.id) || undefined}
                  aria-pressed={pickArmed && pickBand === b.id}
                  aria-label={`Move ${label} to another color on the photo`}
                  data-hint="Move this band onto a different color: pick it on the photo and the band recenters there, keeping its name and its grade"
                  style={{
                    ...rowButton,
                    color: pickArmed && pickBand === b.id ? "var(--accent)" : rowButton.color,
                  }}
                  onClick={() => onTogglePick(b.id)}
                >
                  <EyedropperIcon size={windowed ? 13 : 11} />
                </button>
              ) : (
                <span />
              )}
              <button
                data-testid={`console-delete-${b.id}`}
                aria-label={`Delete ${label}`}
                data-hint="Delete this custom band; its grade goes with it"
                style={rowButton}
                onClick={() => {
                  write(bands.filter((x) => x.id !== b.id));
                  if (band === b.id) onBand("r");
                }}
              >
                <svg width={windowed ? 12 : 10} height={windowed ? 12 : 10} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden focusable="false">
                  <path d="M6 6l12 12M18 6L6 18" />
                </svg>
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
  /** the list's height, so the window's wheel makes room for it */
  const listH = customs.length ? rowH * (1 + Math.min(5, customs.length)) + 2 : 0;

  const sliders = (
    <div>
      <BandSlider
        label="Hue"
        shortLabel="H"
        compact={compact}
        value={active.hue ?? 0}
        range={[-60, 60]}
        testid="console-hue"
        onChange={(v) => edit(band, { hue: v })}
        onGesture={gesture}
      />
      <BandSlider
        label="Saturation"
        shortLabel="S"
        compact={compact}
        value={active.sat ?? 0}
        range={[-100, 100]}
        testid="console-sat"
        onChange={(v) => edit(band, { sat: v })}
        onGesture={gesture}
      />
      <BandSlider
        label="Vibrance"
        shortLabel="V"
        compact={compact}
        value={active.vib ?? 0}
        range={[-100, 100]}
        testid="console-vib"
        onChange={(v) => edit(band, { vib: v })}
        onGesture={gesture}
      />
      <BandSlider
        label="Luminance"
        shortLabel="L"
        compact={compact}
        value={active.lum ?? 0}
        range={[-2, 2]}
        testid="console-lum"
        onChange={(v) => edit(band, { lum: v })}
        onGesture={gesture}
      />
      {active.center !== undefined && (
        <>
          <BandSlider
            label="Width"
            shortLabel="W"
            compact={compact}
            value={active.width ?? DEFAULT_WIDTH}
            range={[5, 120]}
            centered={false}
            testid="console-width"
            onChange={(v) => edit(band, { width: v })}
            onGesture={gesture}
          />
        </>
      )}
    </div>
  );

  const activeLabel = FIXED_BANDS.find((f) => f.id === band)?.label ?? bandLabel(active, fmt);

  const pad = (id: string, size: number) => (
    <BandPad
      key={id}
      band={bandOf(bands, id)}
      size={size}
      testid={`console-pad-${id}`}
      onWheel={(xy) => edit(id, { wheel: xy })}
      onGesture={gesture}
    />
  );

  if (windowed) {
    // Smoothing lives here in the window (above the
    // buttons); the panel keeps it as a section row.
    const smoothing = (
      <BandSlider
        label="Smoothing"
        value={node.params.smoothing ?? 50}
        range={[0, 100]}
        centered={false}
        testid="console-smoothing"
        onChange={(v) => dispatch({ type: "set_param", id: node.id, param: "smoothing", value: v })}
        onGesture={(begin) =>
          dispatch(
            begin
              ? { type: "begin_gesture", key: `${node.id}.smoothing` }
              : { type: "end_gesture" },
          )
        }
      />
    );
    const room = listH ? listH + 10 : 0;
    const padSize = Math.max(180, Math.min(height - 24 - room, Math.floor(width * 0.45)));
    const trioSize = Math.max(110, Math.floor((height - 60 - room) / 3));
    const leftW = view === "one" ? padSize : Math.max(trioSize, 220);
    return (
      <div data-testid="color-console" style={{ display: "flex", gap: 24, height }}>
        <div
          data-testid="console-window-left"
          style={{
            flex: "none",
            width: leftW,
            maxHeight: "100%",
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            // "safe" so an overflow (the smallest window with a full
            // list: the wheel's floor plus five rows is taller than
            // 280px) scrolls instead of clipping the wheel off the
            // top, which plain center does.
            justifyContent: "safe center",
            gap: 8,
            overflowY: "auto",
          }}
        >
          {view === "one" ? (
            <>
              {pad(band, padSize)}
              <div style={{ fontSize: 10, letterSpacing: ".14em", color: "var(--text-faint)" }}>
                {activeLabel.toUpperCase()}
              </div>
            </>
          ) : (
            (view === "rgb" ? ["r", "g", "b"] : ["c", "m", "y"]).map((id) => (
              <div key={id} style={{ display: "grid", justifyItems: "center", gap: 2 }}>
                {pad(id, trioSize)}
                <button
                  className="chip"
                  style={{ fontSize: 9, padding: "1px 8px" }}
                  onClick={() => {
                    onBand(id);
                    setView("one");
                  }}
                >
                  {FIXED_BANDS.find((f) => f.id === id)!.label}
                </button>
              </div>
            ))
          )}
          {customList && <div style={{ width: "100%", marginTop: 2 }}>{customList}</div>}
        </div>
        <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: 10, justifyContent: "center" }}>
          {smoothing}
          {stripRows}
          {sliders}
        </div>
      </div>
    );
  }

  return (
    <div data-testid="color-console">
      <div style={{ marginBottom: 5 }}>{stripRows}</div>
      {view !== "one" ? (
        <div
          data-testid={`console-trio-${view}`}
          style={{ display: "flex", gap: 6, justifyContent: "space-between" }}
        >
          {(view === "rgb" ? ["r", "g", "b"] : ["c", "m", "y"]).map((id) => (
            <div key={id} style={{ display: "grid", justifyItems: "center", gap: 2 }}>
              {pad(id, Math.floor((width - 24) / 3))}
              <button
                className="chip"
                style={{ fontSize: 8, padding: "0 6px" }}
                onClick={() => {
                  onBand(id);
                  setView("one");
                }}
              >
                {FIXED_BANDS.find((f) => f.id === id)!.label}
              </button>
            </div>
          ))}
        </div>
      ) : (
        <div style={{ display: "flex", gap: 10 }}>
          <div style={{ display: "grid", gap: 3, justifyItems: "center", alignContent: "start" }}>
            {pad(band, Math.min(120, Math.floor(width * 0.42)))}
            <div style={{ fontSize: 8, letterSpacing: ".1em", color: "var(--text-faint)" }}>
              {activeLabel.toUpperCase()}
            </div>
          </div>
          <div style={{ flex: 1, minWidth: 0 }}>{sliders}</div>
        </div>
      )}
      {customList && <div style={{ marginTop: 6 }}>{customList}</div>}
    </div>
  );
}
