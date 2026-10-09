// One toolbar slot, two tool halves.
//
// The pattern started as a one-off for dodge and burn
// ("usually how dodge/burn works on many apps is they are the same
// tool") and was then asked for twice more ("Clone and Heal use the
// same tool slot", "combine Blur and Blend"). Three copies of
// hold-to-switch is a framework, so the framework is here: a pair is
// two glyphs, two hints, and two callbacks, and this component owns the
// rest.
//
// The bargain, the same on every pair: a tap arms the half showing (or
// puts it down), a hold or right-click opens the menu that switches,
// and the little corner triangle says the slot is shared. The state
// (which half is showing, whether either is armed, what a tap or a pick
// means) belongs to the wrapper that knows its tools.
//
// Testids all derive from the stem: the button is art-tool-{stem}, the
// menu art-{stem}-menu, and each entry art-{stem}-option-{id}.

import React, { useRef, useState } from "react";
import { useDismiss } from "./hooks";
import { MENU_LIST_SURFACE } from "./menufield";

const HOLD_MS = 320;

export type ToolPairHalf = {
  id: string;
  label: string;
  hint: string;
  glyph: React.ReactNode;
};

export function ToolPairButton({
  stem,
  halves,
  mode,
  armed,
  disabled = false,
  disabledHint,
  onTap,
  onPick,
}: {
  stem: string;
  /** Menu order; the first half is conventionally the default. */
  halves: readonly ToolPairHalf[];
  /** The half on the button face right now. */
  mode: string;
  armed: boolean;
  disabled?: boolean;
  /** What the hint says while the pair has nowhere to work. */
  disabledHint?: string;
  /** A plain click: arm the showing half, or put it down. The wrapper
   * knows which, because it knows whether either half is armed. */
  onTap: (mode: string) => void;
  /** A menu pick: switch the showing half. */
  onPick: (mode: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const root = useDismiss<HTMLDivElement>(open, () => setOpen(false));
  const timer = useRef<number | null>(null);
  const held = useRef(false);
  const half = halves.find((h) => h.id === mode) ?? halves[0];

  const cancel = () => {
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = null;
  };

  return (
    <div ref={root} style={{ position: "relative", display: "inline-flex" }}>
      <button
        className="chip"
        data-testid={`art-tool-${stem}`}
        data-active={armed}
        data-mode={mode}
        disabled={disabled}
        aria-label={half.label}
        aria-haspopup="menu"
        aria-expanded={open}
        data-hint={disabled ? disabledHint : `${half.hint} · hold to switch`}
        style={{ padding: "3px 6px", display: "inline-flex", position: "relative" }}
        onMouseDown={(e) => {
          if (e.button !== 0) return;
          held.current = false;
          cancel();
          timer.current = window.setTimeout(() => {
            held.current = true;
            setOpen(true);
          }, HOLD_MS);
        }}
        onMouseUp={() => {
          cancel();
          if (held.current) return;
          onTap(mode);
        }}
        onMouseLeave={cancel}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown" || e.key === "ArrowUp") {
            e.preventDefault();
            setOpen(true);
          }
        }}
        onContextMenu={(e) => {
          e.preventDefault();
          cancel();
          setOpen(true);
        }}
      >
        <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round">
          {half.glyph}
        </svg>
        <span
          aria-hidden="true"
          style={{
            position: "absolute",
            right: 1.5,
            bottom: 1.5,
            width: 0,
            height: 0,
            borderLeft: "3px solid transparent",
            borderBottom: "3px solid currentColor",
            opacity: 0.65,
          }}
        />
      </button>
      {open && (
        <div
          data-testid={`art-${stem}-menu`}
          role="menu"
          onMouseDown={(e) => e.stopPropagation()}
          style={{
            position: "absolute",
            bottom: "calc(100% + 5px)",
            left: 0,
            ...MENU_LIST_SURFACE,
            maxHeight: undefined,
            minWidth: 120,
          }}
        >
          {halves.map((h) => (
            <button
              key={h.id}
              role="menuitem"
              data-testid={`art-${stem}-option-${h.id}`}
              data-active={h.id === mode || undefined}
              data-hint={h.hint}
              onClick={() => {
                setOpen(false);
                onPick(h.id);
              }}
              style={{
                all: "unset",
                cursor: "pointer",
                // With the toolbar's zoom this lands at about 1.25x the old
                // rows ("could be scaled up by 1.25x").
                fontSize: 11.5,
                padding: "4px 8px",
                whiteSpace: "nowrap",
                display: "flex",
                alignItems: "center",
                gap: 8,
                color: h.id === mode ? "var(--accent)" : "var(--text-body)",
              }}
            >
              <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round">
                {h.glyph}
              </svg>
              {h.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
