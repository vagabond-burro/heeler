// The shot-date range's two fields, From and To, one component for the
// ribbon's filter pop-up (its last row) and the catalog header (its
// right end), so the two seats cannot drift (2026-09-23). Each field
// parses what was typed (datefilter.ts), commits the canonical form on
// Enter or blur and shows it back, so what the field shows is what the
// filter means; Escape clears the field; an invalid value shows a
// quiet red state and filters nothing rather than everything. Beside
// them, how many of the folder's photographs the filter hides for want
// of a date, so a scan or a render never vanishes silently.

import React, { useEffect, useRef, useState } from "react";
import type { Command, State } from "../state";
import { filtersActive, undatedCount } from "../state";
import { parseDateInput, shotDay, spanEnd, spanStart } from "../datefilter";
import { folderMetadata } from "../bridge";

type D = React.Dispatch<Command>;

const HINT = "Taken on or after this day, month or year (YYYY-MM-DD, a month as YYYY-MM, a year as YYYY); empty means no earlier limit";
const HINT_TO = "Taken on or before this day, month or year, inclusive: 2025-05 to 2026-03 is May 2025 through March 2026; empty means no later limit";

function DateField({
  value,
  placeholder,
  label,
  hint,
  testid,
  inline,
  cleared,
  onCommit,
}: {
  value: string;
  placeholder: string;
  label: string;
  hint: string;
  testid: string;
  inline: boolean;
  /** Flips when every filter is cleared: a draft that never became a
   * bound (so `value` did not move) is dropped with the rest. */
  cleared: boolean;
  onCommit: (canon: string) => void;
}) {
  const [draft, setDraft] = useState(value);
  const [error, setError] = useState<string | null>(null);
  // The bound this field itself sent last: when the state comes back
  // with it, the field keeps what it shows (a red draft above all).
  const committed = useRef<string | null>(null);
  // CLEAR ALL, or the other seat, moved the filter: show what it means.
  useEffect(() => {
    if (committed.current === value && !cleared) return;
    committed.current = null;
    setDraft(value);
    setError(null);
  }, [value, cleared]);
  const send = (canon: string) => {
    committed.current = canon;
    onCommit(canon);
  };
  const commit = () => {
    const parsed = parseDateInput(draft);
    if ("canon" in parsed) {
      setError(null);
      setDraft(parsed.canon);
      if (parsed.canon !== value) send(parsed.canon);
    } else if (parsed.error === "") {
      setError(null);
      if (value !== "") send("");
    } else {
      // Not a date: this end is open. The field shows the mistake in
      // red and the filter has no bound here, so what it shows and what
      // it does agree, and the other seat shows the end empty (the
      // 2026-09-23 review's R6: an older bound used to stay in force
      // behind a red field).
      setError(parsed.error);
      if (value !== "") send("");
    }
  };
  return (
    <input
      type="text"
      value={draft}
      placeholder={placeholder}
      aria-label={label}
      aria-invalid={error ? true : undefined}
      title={error ?? undefined}
      data-testid={testid}
      data-hint={error ?? hint}
      data-invalid={error ? "true" : undefined}
      spellCheck={false}
      onChange={(e) => {
        setDraft(e.target.value);
        if (error) setError(null);
      }}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          commit();
          (e.target as HTMLInputElement).blur();
        } else if (e.key === "Escape") {
          e.preventDefault();
          e.stopPropagation();
          setDraft("");
          setError(null);
          if (value !== "") send("");
        }
      }}
      style={{
        background: "var(--bg-app)",
        border: `1px solid ${error ? "var(--warn)" : "var(--line-4)"}`,
        color: error ? "var(--warn)" : "var(--text-body)",
        outline: "none",
        boxSizing: "border-box",
        ...(inline ? { width: 96, height: 20, padding: "0 5px" } : { width: "100%", padding: "3px 5px" }),
      }}
    />
  );
}

export function DateRangeFields({ state, dispatch, inline }: { state: State; dispatch: D; inline: boolean }) {
  const undated = undatedCount(state);
  const cleared = !filtersActive(state);
  // From after To selects no day at all; say so rather than showing an
  // empty ribbon with two valid-looking dates.
  const reversed =
    state.filterDateFrom !== "" && state.filterDateTo !== "" && spanStart(state.filterDateFrom) > spanEnd(state.filterDateTo);
  const note = reversed
    ? "From is after To"
    : undated > 0
      ? `${undated} ${undated === 1 ? "has" : "have"} no date`
      : null;
  const fields = (
    <>
      <DateField
        value={state.filterDateFrom}
        placeholder="YYYY-MM-DD"
        label="Taken from"
        hint={HINT}
        testid="filter-date-from"
        inline={inline}
        cleared={cleared}
        onCommit={(from) => dispatch({ type: "set_filter_dates", from })}
      />
      <span className="lbl" style={{ flex: "none" }}>to</span>
      <DateField
        value={state.filterDateTo}
        placeholder="YYYY-MM-DD"
        label="Taken to"
        hint={HINT_TO}
        testid="filter-date-to"
        inline={inline}
        cleared={cleared}
        onCommit={(to) => dispatch({ type: "set_filter_dates", to })}
      />
    </>
  );
  return inline ? (
    <div role="group" aria-label="Taken" data-testid="filter-dates" style={{ display: "flex", alignItems: "center", gap: 4, flex: "none" }}>
      {fields}
      {note && (
        <span className="lbl" data-testid="filter-dates-undated" style={{ color: "var(--text-ghost)" }}>
          {note}
        </span>
      )}
    </div>
  ) : (
    // (2026-09-23): "Remove the help text to free up room": the
    // pattern is the placeholder, the rest is in the hints.
    <div data-testid="filter-dates">
      <div style={{ display: "flex", alignItems: "center", gap: 6 }}>{fields}</div>
      {note && (
        <div className="help" data-testid="filter-dates-undated" style={{ marginTop: 3 }}>
          {note}
        </div>
      )}
    </div>
  );
}

/** Reads the shot dates a date filter needs, and only then: with a
 * range set, every photograph in the folder whose date is not known yet
 * is asked for through the catalog's metadata (which reads and caches
 * the EXIF on its first pass), in bounded batches, and the answers land in
 * state for the filter to read. Nothing runs without a date filter, so
 * a folder that is never filtered by date never pays the read. */
export function ShotDateRunner({ state, dispatch }: { state: State; dispatch: D }) {
  const active = state.filterDateFrom !== "" || state.filterDateTo !== "";
  const missing = active ? state.images.filter((i) => !Object.prototype.hasOwnProperty.call(state.shotDates, i.id)).map((i) => i.id).slice(0, 32) : [];
  const key = missing.join("|");
  useEffect(() => {
    if (!active || missing.length === 0) return;
    let live = true;
    void folderMetadata(state, missing)
      .then((metas) => {
        if (!live) return;
        const dates: Record<string, string | null> = {};
        // A photograph the read skipped (unreadable) counts as undated
        // rather than being asked for again on every render.
        for (const id of missing) dates[id] = null;
        for (const m of metas) dates[m.id] = shotDay(m.shot_at);
        dispatch({ type: "set_shot_dates", dates });
      })
      .catch((e: unknown) => {
        // A failed read lands as undated so the batch shows in the
        // count rather than staying hidden and silent; the next folder
        // load reads afresh (the 2026-09-23 review's R7).
        if (!live) return;
        console.warn("shot dates: the read failed", e);
        const dates: Record<string, string | null> = {};
        for (const id of missing) dates[id] = null;
        dispatch({ type: "set_shot_dates", dates });
      });
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, key]);
  return null;
}
