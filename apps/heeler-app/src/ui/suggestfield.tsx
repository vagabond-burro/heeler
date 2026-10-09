// A text field with suggestions, drawn in the app's own language.
//
// A native <datalist> hands its list to the OS, which draws it white on
// Windows and in its own font everywhere (2026-10-06: "dropdowns are
// NOT consistent in this app. That is NOT cool ... Standardize this").
// This is the same typing field with the suggestions laid out on
// MenuField's list surface: what is typed narrows them, the arrows walk
// them, Enter or a click puts one in the field, and Escape puts the
// list away. Taking a suggestion only fills the field; the field's own
// Enter and blur still do what they did (add the keyword, apply the
// filter), as they did with the datalist.

import React, { useId, useState } from "react";
import { MENU_LIST_SURFACE, menuRowStyle } from "./menufield";

/** How many suggestions the list shows at most. */
const SHOWN = 8;

/** The suggestions for `typed`: every one containing it, case aside,
 * the exact match left out (it is already in the field). */
export function suggestionsFor(all: string[], typed: string): string[] {
  const q = typed.trim().toLowerCase();
  return all.filter((s) => s.toLowerCase().includes(q) && s.toLowerCase() !== q).slice(0, SHOWN);
}

type InputProps = Omit<React.InputHTMLAttributes<HTMLInputElement>, "value" | "onChange" | "list"> & {
  "data-testid": string;
  "data-hint"?: string;
};

export function SuggestField({
  value,
  onChange,
  suggestions,
  boxStyle,
  ...input
}: InputProps & {
  value: string;
  onChange: (value: string) => void;
  suggestions: string[];
  /** the wrapper's layout (flex, width): the field fills it */
  boxStyle?: React.CSSProperties;
}) {
  const [open, setOpen] = useState(false);
  const [at, setAt] = useState(-1);
  const testid = input["data-testid"];
  // The list's own DOM id: one field can be mounted twice (the tag
  // filter's row and its popover), and the testid is shared.
  const listId = useId();
  const shown = open ? suggestionsFor(suggestions, value) : [];
  const take = (s: string) => {
    onChange(s);
    setOpen(false);
    setAt(-1);
  };
  return (
    <div style={{ position: "relative", ...boxStyle }}>
      <input
        {...input}
        value={value}
        autoComplete="off"
        role="combobox"
        aria-expanded={shown.length > 0}
        aria-autocomplete="list"
        aria-controls={shown.length ? listId : undefined}
        aria-activedescendant={at >= 0 && at < shown.length ? `${listId}-opt-${at}` : undefined}
        style={{ ...input.style, ...(boxStyle ? { width: "100%", boxSizing: "border-box" } : null) }}
        onChange={(e) => {
          onChange(e.target.value);
          setOpen(true);
          setAt(-1);
        }}
        onFocus={(e) => {
          setOpen(true);
          input.onFocus?.(e);
        }}
        onBlur={(e) => {
          setOpen(false);
          setAt(-1);
          input.onBlur?.(e);
        }}
        onKeyDown={(e) => {
          // An IME composition owns its keys: Enter confirms the
          // candidate and the arrows walk the candidate window. Taking
          // a suggestion or handing Enter to the field here would
          // commit text the user has not finished writing.
          if (e.nativeEvent.isComposing) return;
          if (shown.length && (e.key === "ArrowDown" || e.key === "ArrowUp")) {
            e.preventDefault();
            setAt((i) => (e.key === "ArrowDown" ? Math.min(shown.length - 1, i + 1) : Math.max(-1, i - 1)));
            return;
          }
          if (e.key === "Enter" && at >= 0 && at < shown.length) {
            e.preventDefault();
            take(shown[at]);
            return;
          }
          if (e.key === "Escape" && shown.length) {
            e.preventDefault();
            e.stopPropagation();
            setOpen(false);
            setAt(-1);
            return;
          }
          input.onKeyDown?.(e);
        }}
      />
      {shown.length > 0 && (
        <div
          id={listId}
          className="menufield-list"
          role="listbox"
          data-testid={`${testid}-suggestions`}
          style={{ position: "absolute", top: "calc(100% + 4px)", left: 0, minWidth: "100%", ...MENU_LIST_SURFACE }}
        >
          {shown.map((s, i) => (
            <button
              key={s}
              id={`${listId}-opt-${i}`}
              type="button"
              role="option"
              tabIndex={-1}
              aria-selected={i === at}
              data-testid={`${testid}-suggestion-${s}`}
              data-highlight={i === at || undefined}
              // Keep the field's focus, so taking a suggestion is not
              // also the field's blur.
              onMouseDown={(e) => e.preventDefault()}
              onMouseEnter={() => setAt(i)}
              onClick={() => take(s)}
              style={menuRowStyle(true, false)}
            >
              {s}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
