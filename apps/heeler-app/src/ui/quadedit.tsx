// Quad edit: the viewer replaced by up to four photos taking the same
// adjustments at once. The right panel still shows the driver's
// controls; every change mirrors onto the unpinned panes as a relative
// delta (state.ts quadMirror). No zoom in here, deliberately: four
// full-res pipelines panning in sync is a performance promise the
// engine should not write yet.
//
// Gestures: click a pane to make it the driver (its values fill the
// panel), ALT-click to pin a pane out of the mirroring, DONE or Escape
// to fold back to the single photo.

import React, { memo, useEffect } from "react";
import { panePropsEqual } from "./viewmemo";
import type { Command, State } from "../state";
import { modLabel } from "../platform";

type D = React.Dispatch<Command>;

function QuadEditViewImpl({
  state,
  dispatch,
  previewUrl,
  quadFrames,
}: {
  state: State;
  dispatch: D;
  /** the driver's live engine render, same feed the Viewer shows */
  previewUrl: string | null;
  /** per-member renders from the pane pump, keyed by image id */
  quadFrames: Record<string, string>;
}) {
  const q = state.quadEdit!;

  useEffect(() => {
    const on = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      const el = e.target as HTMLElement | null;
      if (el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA")) return;
      e.stopPropagation();
      dispatch({ type: "close_quad_edit" });
    };
    window.addEventListener("keydown", on, true);
    return () => window.removeEventListener("keydown", on, true);
  }, [dispatch]);

  return (
    <div
      data-testid="quad-edit"
      style={{
        flex: 1,
        minWidth: 0,
        minHeight: 0,
        display: "flex",
        flexDirection: "column",
        background: "var(--bg-viewer)",
      }}
    >
      <div
        style={{
          flex: "none",
          display: "flex",
          alignItems: "center",
          gap: 10,
          padding: "6px 12px",
          borderBottom: "1px solid var(--line-1)",
        }}
      >
        {/* The canvas header's own type (11), not a footnote's 9
("the font on the canvas header needs to manage the normal font
size of the header, it's too small to read").*/}
        <div className="kicker" style={{ fontSize: 10, letterSpacing: ".14em" }}>
          Quad Edit
        </div>
        <div style={{ fontSize: 11, color: "var(--text-dim)" }}>
          adjustments land on every unpinned photo · click a pane to drive from
          it · {modLabel("alt")}-click pins one out
        </div>
        <button
          className="chip"
          data-testid="quad-done"
          data-hint="Back to the single photo (Esc)"
          style={{ fontSize: 10, padding: "3px 10px", marginLeft: "auto" }}
          onClick={() => dispatch({ type: "close_quad_edit" })}
        >
          DONE
        </button>
      </div>
      <div
        style={{
          flex: 1,
          minHeight: 0,
          display: "grid",
          gap: 6,
          padding: 8,
          gridTemplateColumns: q.ids.length > 1 ? "1fr 1fr" : "1fr",
          gridTemplateRows: q.ids.length > 2 ? "1fr 1fr" : "1fr",
        }}
      >
        {q.ids.map((id) => {
          const img = state.images.find((i) => i.id === id);
          const driving = id === q.driver;
          const pinned = q.pinned.includes(id);
          const src = driving
            ? previewUrl ?? img?.src
            : quadFrames[id] ?? img?.src;
          return (
            <div
              key={id}
              data-testid={`quad-pane-${id}`}
              data-driver={driving || undefined}
              data-pinned={pinned || undefined}
              onClick={(e) => {
                if (e.altKey) {
                  dispatch({ type: "quad_toggle_pin", id });
                } else if (!driving) {
                  dispatch({ type: "quad_anchor", id });
                }
              }}
              style={{
                position: "relative",
                minWidth: 0,
                minHeight: 0,
                display: "flex",
                flexDirection: "column",
                cursor: driving ? "default" : "pointer",
                background: "var(--bg-panel)",
                outline: driving
                  ? "2px solid var(--accent)"
                  : "1px solid var(--line-1)",
                opacity: pinned ? 0.75 : 1,
              }}
            >
              <div style={{ flex: 1, minHeight: 0, background: "#111010" }}>
                {src && (
                  <img
                    src={src}
                    alt={img?.name ?? id}
                    style={{
                      width: "100%",
                      height: "100%",
                      objectFit: "contain",
                      // Engine renders arrive finished; only the mock's
                      // demo photo leans on the CSS stand-in filter.
                      filter: src === img?.src ? img?.filter : undefined,
                    }}
                  />
                )}
              </div>
              <div
                style={{
                  flex: "none",
                  display: "flex",
                  alignItems: "center",
                  gap: 6,
                  padding: "4px 8px",
                  fontSize: 11,
                }}
              >
                <span
                  className="tnum"
                  style={{
                    flex: 1,
                    minWidth: 0,
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                    color: driving ? "var(--accent)" : "var(--text-body)",
                  }}
                >
                  {img?.name ?? id}
                </span>
                {driving && (
                  <span className="kicker" data-testid={`quad-driving-${id}`} style={{ fontSize: 9, color: "var(--accent)" }}>
                    DRIVING
                  </span>
                )}
                {pinned && (
                  <span
                    data-testid={`quad-pin-${id}`}
                    data-hint={`Pinned: edits pass this one by (${modLabel("alt")}-click to release)`}
                    style={{ display: "inline-flex", alignItems: "center", gap: 3, color: "var(--text-faint)" }}
                  >
                    {/* a pin, drawn: the badge has to read at 9px */}
                    <svg width="10" height="10" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden focusable="false">
                      <path d="M8 2l3 3-1.2 1.2L11 8l-3 1-1 3-1.5-4.5L2 6l3-1z" />
                    </svg>
                    PINNED
                  </span>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// Memoized against everything but the view-only fields (see viewmemo.ts).
export const QuadEditView = memo(QuadEditViewImpl, panePropsEqual);
