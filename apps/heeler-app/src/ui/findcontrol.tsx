// Find a Control (a tester, via "It would be helpful if a
// user could search for a tool under the Help menu"). "Tool" is broad
// and tools live under different tabs, so the search indexes CONTROLS
// by name - every Adjustments section and slider, the depth chips,
// and the Finish toolbar's buttons - and each result says where it
// lives. Picking one takes you there: the right tab, the section
// opened, the control scrolled into view and outlined gold for a
// beat, the same outline the keyboard navigator uses.

import React, { useEffect, useMemo, useRef, useState } from "react";
import { COMMANDS } from "../hotkeys";
import { runCommand } from "../commands";
import type { Command, State } from "../state";
import { ROW_TIPS, SECTIONS, SECTION_BLURBS, sectionHidden } from "./simple";

type D = React.Dispatch<Command>;

type Hit = {
  /** what the user reads */
  name: string;
  /** where it lives, spoken */
  place: string;
  /** what it does, when we know */
  tip?: string;
  go: (dispatch: D, state: State) => void;
  /** Off the list for this state (a section hidden in Preferences). */
  hidden?: (state: State) => boolean;
};

/** The Finish toolbar's named controls: a static index, since they are
 * buttons rather than declared rows. */
const FINISH_TOOLS = [
  "Pixel layer", "Cutout layer", "Fill brush", "Paint", "Clone", "Heal",
  "Dodge & Burn", "Layer effects", "Smart selection layer", "Layer mask",
];

function buildIndex(): Hit[] {
  const hits: Hit[] = COMMANDS.filter((cmd) => cmd.id.startsWith("view.sections.")).map((cmd) => ({
    name: cmd.label, place: "View", tip: cmd.blurb,
    go: (d, state) => { runCommand(cmd.id, state, d); },
  }));
  for (const sec of SECTIONS) {
    hits.push({
      name: sec.title,
      place: "Adjustments",
      // A section hidden in Preferences is not on offer: a hit that
      // opens nothing is worse than no hit.
      hidden: (state) => sectionHidden(state, sec),
      tip: SECTION_BLURBS[sec.title],
      go: (d) => {
        d({ type: "set_panel_tab", tab: "adjust" });
        d({ type: "open_section", title: sec.title });
        d({ type: "flash_control", section: sec.title, param: null });
      },
    });
    for (const row of sec.rows) {
      hits.push({
        name: row.label,
        place: `Adjustments · ${sec.title}`,
        hidden: (state) => sectionHidden(state, sec),
        tip: ROW_TIPS[`${sec.title}|${row.label}`],
        go: (d) => {
          d({ type: "set_panel_tab", tab: "adjust" });
          d({ type: "open_section", title: sec.title });
          d({ type: "flash_control", section: sec.title, param: row.param });
        },
      });
    }
  }
  for (const [name, section] of [
    ["View depth", "Fog"],
    ["Position lights", "Depth Lighting"],
    ["Add light", "Depth Lighting"],
    ["Invert depth", "Depth Lighting"],
    ["Set focus", "Depth of Field"],
  ] as const) {
    hits.push({
      name,
      place: `Adjustments · ${section}`,
      hidden: (state) => SECTIONS.some((sec) => sec.title === section && sectionHidden(state, sec)),
      go: (d) => {
        d({ type: "set_panel_tab", tab: "adjust" });
        d({ type: "open_section", title: section });
        d({ type: "flash_control", section, param: null });
      },
    });
  }
  for (const name of FINISH_TOOLS) {
    hits.push({
      name,
      place: "Finish · toolbar",
      go: (d) => d({ type: "set_panel_tab", tab: "layers" }),
    });
  }
  return hits;
}

export function FindControl({ state, dispatch }: { state: State; dispatch: D }) {
  const [q, setQ] = useState("");
  const [sel, setSel] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const index = useMemo(buildIndex, []);
  useEffect(() => inputRef.current?.focus(), []);
  const needle = q.trim().toLowerCase();
  const hits = needle
    ? index
        .filter(
          (h) =>
            !h.hidden?.(state) &&
            (h.name.toLowerCase().includes(needle) ||
              (h.tip ?? "").toLowerCase().includes(needle)),
        )
        .slice(0, 12)
    : [];
  const pick = (h: Hit) => {
    h.go(dispatch, state);
    dispatch({ type: "toggle_find_control" });
  };
  return (
    <div
      data-testid="find-control"
      style={{
        position: "fixed", inset: 0, zIndex: 80, background: "rgba(0,0,0,.4)",
        display: "flex", alignItems: "flex-start", justifyContent: "center", paddingTop: "18vh",
      }}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) dispatch({ type: "toggle_find_control" });
      }}
    >
      <div
        style={{
          width: 420, maxWidth: "86vw", background: "var(--bg-panel)",
          border: "1px solid var(--line-4)", boxShadow: "0 18px 44px rgba(0,0,0,.6)",
        }}
      >
        <input
          ref={inputRef}
          data-testid="find-control-input"
          value={q}
          placeholder="Find a control: exposure, fog, blades, vibrance…"
          aria-label="Find a control"
          onChange={(e) => {
            setQ(e.target.value);
            setSel(0);
          }}
          onKeyDown={(e) => {
            if (e.key === "Escape") dispatch({ type: "toggle_find_control" });
            if (e.key === "ArrowDown") setSel((s) => Math.min(hits.length - 1, s + 1));
            if (e.key === "ArrowUp") setSel((s) => Math.max(0, s - 1));
            if (e.key === "Enter" && hits[sel]) pick(hits[sel]);
          }}
          style={{
            width: "100%", boxSizing: "border-box", padding: "10px 13px", fontSize: 13,
            background: "var(--bg-app)", border: "none", borderBottom: "1px solid var(--line-3)",
            color: "var(--text-hi)", outline: "none",
          }}
        />
        {hits.map((h, i) => (
          <button
            key={`${h.place}|${h.name}`}
            data-testid={`find-hit-${i}`}
            data-active={i === sel}
            onMouseEnter={() => setSel(i)}
            onClick={() => pick(h)}
            style={{
              all: "unset", cursor: "pointer", display: "block", width: "100%",
              boxSizing: "border-box", padding: "7px 13px",
              background: i === sel ? "var(--bg-seg-active)" : "transparent",
            }}
          >
            <div style={{ display: "flex", gap: 8, alignItems: "baseline" }}>
              <span style={{ fontSize: 12.5, color: "var(--text-hi)" }}>{h.name}</span>
              <span style={{ fontSize: 10, color: "var(--text-ghost)" }}>{h.place}</span>
            </div>
            {h.tip && (
              <div style={{ fontSize: 10.5, color: "var(--text-faint)", marginTop: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {h.tip}
              </div>
            )}
          </button>
        ))}
        {needle && hits.length === 0 && (
          <div style={{ padding: "9px 13px", fontSize: 11, color: "var(--text-faint)" }}>
            Nothing by that name. Try what the control does: "blur", "warm", "sky".
          </div>
        )}
      </div>
    </div>
  );
}
