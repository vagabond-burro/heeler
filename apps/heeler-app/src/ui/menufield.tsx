// A dropdown in the app's own language, which opens whichever way there
// is room.
//
// On the brush menu in the Finish toolbar: "should go upwards as well.
// It only does when the window is maximized, I think its a strange
// experience for it to extend outside the main window. Also, it keeps
// it consistent with the color picker."
//
// A native <select> hands its list to the OS, which is free to draw it
// outside the window and does exactly that when the window is small.
// The same objection as the native color dialog: it is not ours, it
// does not match, and it does not respect the window. This is the same
// control drawn here, flipping with the same rule the picker uses.

import React, { useEffect, useLayoutEffect, useRef, useState } from "react";
import { opensLeft, opensUp, scrollItemIntoList, useDismiss } from "./hooks";

/** The open list's surface, one look for every dropdown and suggestion
 * list in the app (2026-10-06: "dropdowns are NOT consistent in this
 * app ... Standardize this"). SuggestField draws its list with the
 * same two, so a typed suggestion and a menu row cannot drift apart.*/
export const MENU_LIST_SURFACE: React.CSSProperties = {
  zIndex: 60,
  boxSizing: "border-box",
  maxHeight: 260,
  overflowY: "auto",
  background: "#191817",
  border: "1px solid var(--line-4)",
  boxShadow: "0 8px 22px rgba(0,0,0,.6)",
  padding: 3,
  display: "flex",
  flexDirection: "column",
};

/** One row of an open list, at the regular (11px) or small size. */
export const menuRowStyle = (regular: boolean, chosen: boolean): React.CSSProperties => ({
  all: "unset",
  cursor: "pointer",
  fontSize: regular ? 11 : 10.5,
  padding: "3px 7px",
  whiteSpace: "nowrap",
  display: "flex",
  alignItems: "center",
  gap: 7,
  color: chosen ? "var(--accent)" : "var(--text-body)",
});

/** Roughly how tall the list will be, for the flip decision. */
const ROW = 21;
const CHROME = 8;

/** The row type-ahead lands on: the first usable row after `current`
 * (wrapping, so a repeated key cycles) whose label starts with the
 * buffer, case aside. A buffer of one letter pressed again and again
 * is that letter, not a prefix nothing matches. -1 when no row
 * answers; a disabled row never does. Exported for the tests; the
 * list's keydown is the only caller. */
export function typeaheadRow(
  options: readonly { label: string; disabled?: boolean }[],
  buffer: string,
  current: number,
): number {
  if (!buffer) return -1;
  const needle = (/^(.)\1+$/.test(buffer) ? buffer[0] : buffer).toLowerCase();
  const n = options.length;
  for (let step = 1; step <= n; step++) {
    const i = (((current + step) % n) + n) % n;
    const o = options[i];
    if (!o.disabled && o.label.toLowerCase().startsWith(needle)) return i;
  }
  return -1;
}

export function MenuField({
  value,
  options,
  onChange,
  label,
  testid,
  hint,
  minWidth = 64,
  disabled = false,
  compact = false,
  size = "small",
  fitLabels,
  placeholder,
  onPreview,
  node,
  param,
  tip,
}: {
  value: string;
  /** `hint` on an option is its status-line help, shown on its row in
   * the list and on the closed field while it is the one chosen.
   * `swatch` is a CSS color drawn as a dot before the label, in the
   * closed field and on the option's row, for a choice that IS a color
   * (2026-09-30, on the mask overlay color: "make the 4 color options a
   * dropdown option menu but keep the color dots with labels").*/
  options: { id: string; label: string; icon?: React.ReactNode; hint?: string; swatch?: string; disabled?: boolean }[];
  onChange: (id: string) => void;
  label: string;
  testid: string;
  hint?: string;
  minWidth?: number;
  /** Shown but not usable. The selection mode "should
   * always be visible, just disabled when the selection tools is not
   * active." A control that vanishes takes the row's layout with it,
   * and the next thing along moves under the cursor.*/
  disabled?: boolean;
  /** Icon only in the closed field. The list still carries names, so
   * the glyph has somewhere to be learned. */
  compact?: boolean;
  /** "regular" draws the field and its list at the panel's 11px row size,
   * the size of the segmented buttons these menus replaced in Source and
   * Preferences (2026-09-29: "make these a dropdown option menu").
   * "small" is the toolbar size the field was made at.*/
  size?: "small" | "regular";
  /** Labels the closed field must fit, whichever is chosen. The field
   * lays them all into one grid cell, hidden, so it is exactly as wide
   * as the longest at its own font; hand several fields the same list
   * and they come out one width with nothing measured and no pixel
   * number to go stale when an option is renamed (2026-09-29: "make
   * sure the dropdowns are all the same width (defaulting to the length
   * of the longest word in all 4)").*/
  fitLabels?: string[];
  /** What the closed field says when no option is the value: a menu
   * of things to do rather than a choice held (the section looks'
   * "Preview a look"). */
  placeholder?: string;
  /** Told which row the pointer is over or the keyboard is on while
   * the list is open, and null the moment it closes (Escape, a click
   * outside, Tab, a choice, the field leaving the screen). The pointer
   * leaving the list is not a close: the last row stays told. A
   * disabled row is never told. */
  onPreview?: (id: string | null) => void;
  /** The node and param the menu edits, carried as data-node and
   * data-param so Find a Control can flash it and a right-click can
   * publish it, as every other control in a section does. */
  node?: string;
  param?: string;
  /** The cursor tip (ui/cursortip.tsx reads data-tip), for a menu in a
   * row whose other controls wear one, as the Graph inspector's do. */
  tip?: string;
}) {
  const [open, setOpen] = useState(false);
  const [up, setUp] = useState(false);
  const [left, setLeft] = useState(false);
  const root = useDismiss<HTMLDivElement>(open, () => setOpen(false));
  const field = useRef<HTMLButtonElement | null>(null);
  const list = useRef<HTMLDivElement | null>(null);
  // Set when the keyboard opened the list: focus goes to the chosen row
  // so the arrows carry on from there. A click leaves focus alone.
  const focusOnOpen = useRef(false);
  // The type-ahead buffer and the time the last letter landed.
  const typeBuffer = useRef("");
  const typeTime = useRef(0);
  const current = options.find((o) => o.id === value);
  const previewRef = useRef(onPreview);
  previewRef.current = onPreview;
  // The list closing, however it closed, and the field leaving the
  // screen while open, take the preview back.
  const wasOpen = useRef(false);
  useEffect(() => {
    if (open) wasOpen.current = true;
    else if (wasOpen.current) {
      wasOpen.current = false;
      previewRef.current?.(null);
    }
  }, [open]);
  useEffect(
    () => () => {
      if (wasOpen.current) previewRef.current?.(null);
    },
    [],
  );
  const regular = size === "regular";
  // One dot slot in the closed field whenever any choice has a color,
  // so a fitted field counts the dot and keeps one width whichever
  // choice is showing.
  const swatched = options.some((o) => o.swatch !== undefined);
  const rows = () =>
    Array.from(list.current?.querySelectorAll<HTMLButtonElement>("[role=option]") ?? []);
  // Which way the list hangs: guessed from its row count as it opens,
  // then settled from the list's real size once it is laid out (a long
  // label or the height cap makes the guess wrong), both measured by
  // the one flip rule (ui/hooks.ts), in the field's own units.
  const listWidth = () => Math.max(minWidth, 108, field.current?.offsetWidth ?? 0);
  const place = (el: HTMLElement) => {
    setUp(opensUp(el, options.length * ROW + CHROME));
    setLeft(opensLeft(el, listWidth()));
  };
  useLayoutEffect(() => {
    const el = field.current;
    const box = list.current;
    if (!open || !el || !box || box.offsetHeight <= 0) return;
    setUp(opensUp(el, box.offsetHeight + 4));
    setLeft(opensLeft(el, box.offsetWidth));
  }, [open]);
  useEffect(() => {
    if (!open || !focusOnOpen.current) return;
    focusOnOpen.current = false;
    const all = rows();
    (all.find((b) => b.dataset.active) ?? all.find((b) => b.getAttribute("aria-disabled") !== "true") ?? all[0])?.focus();
  }, [open]);
  // A keyboard open focuses the chosen row and focus scrolls it into
  // view; a mouse open moves nothing, so a long list (the tether
  // exposures, the film stocks) opened on a choice far down it showed
  // the list's top instead. Scroll the chosen row, else the first
  // usable one, into view either way, by offsets (the ui-zoom trap
  // makes client rects lie).
  useEffect(() => {
    if (!open) return;
    const box = list.current;
    if (!box) return;
    const all = rows();
    const show = all.find((b) => b.dataset.active) ?? all.find((b) => b.getAttribute("aria-disabled") !== "true");
    if (show) scrollItemIntoList(box, show);
  }, [open]);
  const openFromKeys = (e: React.KeyboardEvent<HTMLButtonElement>) => {
    if (disabled || open) return;
    // A native select opens on the arrows, Space and Enter alike; the
    // arrows were the only ones heard here, so a Space or Enter open
    // (the button's own click) left focus on the field and the arrows
    // dead. preventDefault keeps the key from also clicking the button,
    // which would toggle the list straight shut again.
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp" && e.key !== " " && e.key !== "Enter") return;
    e.preventDefault();
    focusOnOpen.current = true;
    place(e.currentTarget);
    setOpen(true);
  };
  const close = () => {
    setOpen(false);
    field.current?.focus();
  };
  const listKeys = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const all = rows();
    const at = all.indexOf(document.activeElement as HTMLButtonElement);
    const go = (i: number) => {
      e.preventDefault();
      all[Math.max(0, Math.min(all.length - 1, i))]?.focus();
    };
    if (e.key === "ArrowDown") go(at + 1);
    else if (e.key === "ArrowUp") go(at - 1);
    else if (e.key === "Home") go(0);
    else if (e.key === "End") go(all.length - 1);
    else if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      close();
    } else if (e.key === "Tab") setOpen(false);
    else if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
      // Type-ahead, as a native listbox does: the buffer resets after a
      // pause, and focus (not the value) moves to the row it names. The
      // closed field hears no typing on purpose: a stray key must not
      // write a param.
      const now = Date.now();
      typeBuffer.current = now - typeTime.current > 600 ? e.key : typeBuffer.current + e.key;
      typeTime.current = now;
      const i = typeaheadRow(options, typeBuffer.current, at);
      if (i >= 0) {
        e.preventDefault();
        all[i]?.focus();
      }
    }
  };

  return (
    <div ref={root} data-node={node} data-param={param} style={{ position: "relative", display: "inline-flex", justifySelf: "start" }}>
      <button
        ref={field}
        className="chip"
        data-testid={testid}
        data-value={value}
        data-active={(open && !disabled) || undefined}
        aria-label={label}
        aria-haspopup="listbox"
        aria-expanded={open}
        disabled={disabled}
        data-hint={hint ?? current?.hint ?? label}
        data-tip={tip}
        onKeyDown={openFromKeys}
        onMouseDown={(e) => e.stopPropagation()}
        onClick={(e) => {
          e.stopPropagation();
          place(e.currentTarget as HTMLElement);
          setOpen((o) => !o);
        }}
        style={{
          minWidth: compact || fitLabels ? undefined : minWidth,
          padding: regular ? "3px 7px 3px 9px" : "2px 5px",
          display: "inline-flex",
          alignItems: "center",
          gap: regular ? 6 : 4,
          ...(regular ? { fontSize: 11 } : { fontSize: 9.5 }),
          letterSpacing: regular ? "normal" : undefined,
        }}
      >
        {swatched && !compact && <Swatch color={current?.swatch} testid={`${testid}-swatch`} />}
        {compact ? (
          <span style={{ display: "inline-flex" }}>{current?.icon}</span>
        ) : fitLabels ? (
          <span
            data-fit-labels={fitLabels.join("|")}
            style={{ flex: 1, display: "inline-grid", textAlign: "left" }}
          >
            <span style={{ gridArea: "1 / 1", whiteSpace: "nowrap" }}>{current?.label ?? placeholder ?? value}</span>
            {fitLabels.map((l) => (
              <span
                key={l}
                aria-hidden="true"
                style={{ gridArea: "1 / 1", visibility: "hidden", whiteSpace: "nowrap" }}
              >
                {l}
              </span>
            ))}
          </span>
        ) : (
          <span style={{ flex: 1, textAlign: "left" }}>{current?.label ?? placeholder ?? value}</span>
        )}
        <svg
          width={regular ? 8 : 7}
          height={regular ? 8 : 7}
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="3"
          aria-hidden="true"
          style={{ transform: up ? "rotate(180deg)" : "none" }}
        >
          <path d="M6 9l6 6 6-6" />
        </svg>
      </button>
      {open && !disabled && (
        <div
          ref={list}
          className="menufield-list"
          role="listbox"
          aria-label={label}
          data-testid={`${testid}-menu`}
          data-up={up || undefined}
          data-left={left || undefined}
          onKeyDown={listKeys}
          onMouseDown={(e) => e.stopPropagation()}
          // A choice is the menu's alone: a row that selects on click
          // (a Shape Warp shape, a Finish layer) must not hear it too.
          onClick={(e) => e.stopPropagation()}
          style={{
            position: "absolute",
            ...(up ? { bottom: "calc(100% + 4px)" } : { top: "calc(100% + 4px)" }),
            ...(left ? { right: 0 } : { left: 0 }),
            ...MENU_LIST_SURFACE,
            minWidth: fitLabels ? "100%" : Math.max(minWidth, 108),
          }}
        >
          {options.map((o) => (
            <button
              key={o.id}
              role="option"
              aria-selected={o.id === value}
              data-testid={`${testid}-option-${o.id}`}
              data-active={o.id === value || undefined}
              data-hint={o.hint}
              // aria-disabled rather than disabled: the arrows still
              // walk through the row, they just do nothing on it.
              aria-disabled={o.disabled || undefined}
              onMouseEnter={o.disabled ? undefined : () => previewRef.current?.(o.id)}
              onFocus={o.disabled ? undefined : () => previewRef.current?.(o.id)}
              onClick={() => {
                if (o.disabled) return;
                // Re-choosing the chosen row says nothing: a native
                // select fires no change for it, and here it would push
                // an undo step that changes nothing.
                if (o.id !== value) onChange(o.id);
                close();
              }}
              style={{
                ...menuRowStyle(regular, o.id === value),
                cursor: o.disabled ? "default" : "pointer",
                opacity: o.disabled ? 0.45 : undefined,
              }}
            >
              {o.icon && <span style={{ display: "inline-flex" }}>{o.icon}</span>}
              {o.swatch !== undefined && <Swatch color={o.swatch} testid={`${testid}-option-${o.id}-swatch`} />}
              {o.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/** The color dot a swatched option wears, the size the segmented mask
 * color buttons drew it at. With no color it still holds its place, so
 * the field's width never depends on which choice is showing. */
function Swatch({ color, testid }: { color?: string; testid: string }) {
  return (
    <span
      data-testid={testid}
      data-swatch={color ?? ""}
      aria-hidden="true"
      style={{
        flex: "none",
        display: "inline-block",
        width: 8,
        height: 8,
        borderRadius: "50%",
        background: color ?? "transparent",
      }}
    />
  );
}
