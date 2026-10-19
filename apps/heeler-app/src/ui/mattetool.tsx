// The Object Mask's frontend half: the mask a renderer wrote into the
// photograph's own OpenEXR, picked by name. The panel lists what the
// file's Cryptomatte layers name (objects, materials) and the plain
// matte channels; a name toggles in and out of the mask, and the pick
// tool names the object under a click on the photograph. The desktop
// reads the coverage out of the file when the recipe changes; nothing
// is computed here and no model is involved.

import { isPrimaryPress } from "./pointerguard";
import { modLabel } from "../platform";
import React, { useState } from "react";
import { mattePick } from "../bridge";
import { usePickSessions } from "../picksession";
import { reportToolError } from "./hints";
import { passesOf } from "./depthtool";
import type { Command, State, NodeCard } from "../state";
import { activeMatteMask, layerLabel, matteNames } from "./mattetoolparts";

type D = React.Dispatch<Command>;

/** Writes a new name list onto the mask, with the layer it belongs
 * to; an empty list is an empty mask. */
function writeNames(dispatch: D, id: string, layer: string, names: string[]) {
  dispatch({ type: "set_text_param", id, param: "layer", value: layer });
  dispatch({ type: "set_text_param", id, param: "names", value: JSON.stringify(names) });
}

export function ObjectMattePanel({ state, dispatch, node }: { state: State; dispatch: D; node?: NodeCard }) {
  const [filter, setFilter] = useState("");
  // The source being browsed: the mask's own layer once names are
  // chosen, the user's pick before then, else the file's first. A
  // fresh mask's empty layer name is "nothing yet", not the Channel
  // source, whose layer name is empty too.
  const [browsing, setBrowsing] = useState<string | null>(null);
  const mask = node ?? activeMatteMask(state);
  const passes = passesOf(state);
  if (!mask) return null;
  const chosen = matteNames(mask);
  const layer = mask.textParams?.layer ?? "";
  const sources: { layer: string; label: string; names: string[] }[] = [
    ...(passes?.mattes ?? []).map((m) => ({ layer: m.layer, label: layerLabel(m.layer), names: m.names })),
    ...((passes?.channels.length ?? 0) > 0 ? [{ layer: "", label: "Channel", names: passes!.channels }] : []),
  ];
  if (sources.length === 0) {
    return (
      <div data-testid="object-none" className="help" style={{ margin: "2px 0 6px" }}>
        {passes === null
          ? "This photograph's file names no objects. An OpenEXR with a Cryptomatte or a matte channel does; a TIFF's alpha reads as Alpha."
          : "This file carries no object mattes."}
      </div>
    );
  }
  const selected = chosen.length > 0 ? layer : browsing;
  const current = (selected !== null ? sources.find((s) => s.layer === selected) : undefined) ?? sources[0];
  const shown = current.names.filter((n) => n.toLowerCase().includes(filter.toLowerCase()));
  const toggle = (name: string) => {
    const same = layer === current.layer;
    const base = same ? chosen : [];
    const next = base.includes(name)
      ? base.filter((n) => n !== name)
      : current.layer === "" ? [name] : [...base, name];
    writeNames(dispatch, mask.id, current.layer, next);
  };
  return (
    <div data-testid="object-panel" style={{ margin: "2px 0 6px", display: "flex", flexDirection: "column", gap: 4 }}>
      {sources.length > 1 && (
        <div className="zoom-seg" role="group" aria-label="Matte source" style={{ border: "1px solid var(--line-4)" }}>
          {sources.map((s) => (
            <button
              key={s.layer || "channel"}
              data-testid={`object-source-${s.label.toLowerCase()}`}
              data-active={current.layer === s.layer}
              data-hint={
                s.layer === ""
                  ? "Read one of the file's plain matte channels as the mask"
                  : `Pick from the ${s.names.length} ${s.label.toLowerCase()} names the render wrote into the file`
              }
              onClick={() => {
                setBrowsing(s.layer);
                // Names belong to a layer: another source starts empty.
                if (chosen.length > 0 && s.layer !== layer) writeNames(dispatch, mask.id, s.layer, []);
              }}
            >
              {s.label}
            </button>
          ))}
        </div>
      )}
      <div className="help">
        {state.tool === "object"
          ? current.layer === ""
            ? "Pick a channel below."
            : `Click the photograph to add an object, ${modLabel("alt")}-click to take one out, or pick below.`
          : "Pick below."}
        {chosen.length > 0 && layer === current.layer && (
          <span data-testid="object-count"> {chosen.length} in the mask.</span>
        )}
      </div>
      {/* The list, the owner's shape (2026-09-19): a scrollable list of
rows, eight showing at once, a plain text filter above it, a check
on every row the mask holds. Not a heap of chips.*/}
      <input
        data-testid="object-filter"
        value={filter}
        placeholder="Filter names"
        aria-label="Filter names"
        onChange={(e) => setFilter(e.target.value)}
        style={{ fontSize: 12, padding: "3px 8px", background: "transparent", color: "inherit", border: "1px solid var(--line-4)", borderRadius: "var(--radius-btn)" }}
      />
      <div data-testid="object-names" className="listbox" role="listbox" aria-label="Names in the file" aria-multiselectable={current.layer !== ""}>
        {shown.map((name) => {
          const on = layer === current.layer && chosen.includes(name);
          // A TIFF's one plain channel is its alpha, reported as "A";
          // nobody reads "A" as transparency until it says Alpha.
          const label = name === "A" ? "Alpha" : name;
          return (
            <button
              key={name}
              className="listrow"
              role="option"
              data-testid={`object-name-${name}`}
              data-active={on ? "true" : undefined}
              aria-selected={on}
              aria-pressed={on}
              data-hint={on ? `${label} is in the mask: click to take it out` : `Add ${label} to the mask`}
              onClick={() => toggle(name)}
            >
              <span className="check" aria-hidden>{on ? "\u2713" : ""}</span>
              <span>{label}</span>
            </button>
          );
        })}
        {shown.length === 0 && (
          <span className="help" style={{ padding: "4px 8px" }}>No name matches</span>
        )}
      </div>
    </div>
  );
}

/** The pick tool over the viewer: a click names the object under it
 * from the mask's Cryptomatte layer and toggles it into the mask. A
 * mask reading a plain channel has nothing to pick, and a click does
 * nothing. */
export function ObjectPickOverlay({
  state,
  dispatch,
  norm,
}: {
  state: State;
  dispatch: D;
  /** the viewer's own pointer mapping, so clicks stay honest under
   * pan, zoom and rotation */
  norm: (e: { clientX: number; clientY: number }, el: HTMLElement) => [number, number];
}) {
  const [busy, setBusy] = useState(false);
  const picks = usePickSessions(state, dispatch);
  const mask = activeMatteMask(state);
  if (!mask) return null;
  const passes = passesOf(state);
  // A layer chosen, or the file's first: a fresh mask picks objects
  // before the user has visited the panel.
  const layer = mask.textParams?.layer || passes?.mattes[0]?.layer || "";
  const pickable = layer !== "" && (passes?.mattes ?? []).some((m) => m.layer === layer);
  return (
    <div
      data-testid="object-overlay"
      style={{ position: "absolute", inset: 0, cursor: busy ? "progress" : pickable ? "crosshair" : "default" }}
      onMouseDown={(e) => {
        if (!isPrimaryPress(e) || busy || !pickable) return;
        e.stopPropagation();
        const [nx, ny] = norm(e, e.currentTarget);
        if (nx < 0 || nx > 1 || ny < 0 || ny > 1) return;
        const remove = e.altKey;
        const session = picks.start("object", {
          aim: (s) => [s.tool, activeMatteMask(s)?.id],
          settings: (s) => activeMatteMask(s)?.textParams,
        });
        setBusy(true);
        void mattePick(state, layer, nx, ny)
          .then((name) => {
            if (name === null || !session.stillMine()) return;
            const same = (mask.textParams?.layer ?? "") === layer;
            const base = same ? matteNames(mask) : [];
            const next = remove ? base.filter((n) => n !== name) : base.includes(name) ? base : [...base, name];
            if (same && next.length === base.length && !remove) return;
            writeNames(session.dispatch, mask.id, layer, next);
          })
          .catch((err) => reportToolError("Object mask", err))
          .finally(() => setBusy(false));
      }}
    />
  );
}
