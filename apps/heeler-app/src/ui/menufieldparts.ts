// menufield.tsx's values and helpers that are not components, kept apart so
// menufield.tsx exports components alone and Vite can refresh it in place as
// it is edited instead of reloading the window.
import React from "react";

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
