// The thumbnail panel's two extra shapes: its little control row, and the
// table it becomes when you throw it open.
//
// "I would like to be able to maximize/expand the
// thumbnail panel. This would hide the viewport, but it would reveal
// metadata sorted by columns for each image. Some metadata is from the
// workspace; rating, status, etc. Other columns are common camera
// data."
//
// The columns come from META_COLUMNS in state.ts, which the Metadata tab's
// row list also reads, so the two cannot end up disagreeing about what
// "Shutter" means.

import React, { useEffect, useState } from "react";
import type { Command, State } from "../state";
import { META_COLUMNS, visibleImages, takeCount } from "../state";
import { isMacControlClick } from "../platform";
import { folderMetadata, type ImageMeta } from "../bridge";
import { humanShotAt, humanSize } from "./metadata";
import { chromeZoomFactor } from "../uiprefs";

type D = React.Dispatch<Command>;

/** The picture browser's three actions as glyphs, in the view-shape
 * icons' idiom (2026-09-15: "Compare, Edit Together, and Back to
 * Photo buttons should have the labels replaced with icons"). Each
 * button keeps its name in aria-label and data-tip, so the cursor
 * tip says what a glyph is.*/
export function CompareIcon({ size = 11 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden focusable="false">
      <rect x="2" y="3" width="5" height="10" />
      <rect x="9" y="3" width="5" height="10" />
    </svg>
  );
}

export function EditTogetherIcon({ size = 11 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden focusable="false">
      <rect x="2" y="6" width="8" height="8" />
      <path d="M6 6V2h8v8h-4" />
      <path d="M4.5 10h3M6 8.5v3" strokeLinecap="round" />
    </svg>
  );
}

/** A merged photograph: frames stacked one behind another, the front
 * one whole. The filter's Merged button (stacks and panoramas), in
 * the line style of the browser's other icons (2026-09-30: "swap the
 * 'MERGED' label for an icon").*/
export function MergedIcon({ size = 11 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden focusable="false">
      <rect x="1.5" y="6.5" width="9" height="8" />
      <path d="M4 6.5V4h9v8h-2.5" />
      <path d="M6.5 4V1.5h8v8H13" />
    </svg>
  );
}

export function BackToPhotoIcon({ size = 11 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden focusable="false">
      <rect x="2" y="3" width="12" height="10" />
      <path d="M2 11l4-4 3 3 2-2 3 3" strokeLinejoin="round" />
      <circle cx="11" cy="6" r="1" fill="currentColor" stroke="none" />
    </svg>
  );
}

/** The sort direction as one glyph: bars growing down the list with
 * an arrow beside them, flipped for newest first. One button that
 * cycles, where two labeled ones stood (2026-09-15: "consolidated to
 * one button to save space. Clicking on it cycles the sorting
 * direction").*/
export function SortIcon({ size = 11, desc }: { size?: number; desc: boolean }) {
  const bars = desc ? [10, 7, 4] : [4, 7, 10];
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" aria-hidden focusable="false">
      {bars.map((w, i) => (
        <path key={i} d={`M2 ${4 + i * 4}h${w}`} />
      ))}
      <path d="M14 3v10" />
      <path d={desc ? "M12 11l2 2 2-2" : "M12 5l2-2 2 2"} strokeLinejoin="round" />
    </svg>
  );
}

/** A picture grid and a list, drawn: two words do not fit in a panel
 * this narrow and these are the two shapes everyone already knows.
 * Shared by the ribbon's view toggle and the catalog's Grid/Table
 * toggle ("Replace the Grid / Table labels with the
 * icons that the thumbnail view uses"), so the same idea wears the
 * same icon.*/
export function ViewShapeIcon({ shape, size = 11 }: { shape: "thumbs" | "list"; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden focusable="false">
      {shape === "thumbs" ? (
        <>
          <rect x="2" y="2" width="5" height="5" />
          <rect x="9" y="2" width="5" height="5" />
          <rect x="2" y="9" width="5" height="5" />
          <rect x="9" y="9" width="5" height="5" />
        </>
      ) : (
        <path d="M2 4h12M2 8h12M2 12h12" strokeLinecap="round" />
      )}
    </svg>
  );
}

/** The thumbs/list switch alone. The header's rows are composed in the
 * ribbon itself, to the owner's layout: "[Photo view] XX/XX" on the
 * first row, "[Filter][Thumb][List]" on the second.*/
export function RibbonControls({ state, dispatch }: { state: State; dispatch: D }) {
  return (
    <div
      className="zoom-seg"
      role="group"
      aria-label="Thumbnail view"
      style={{ border: "1px solid var(--line-4)", flex: "none" }}
    >
      {(
        [
          ["thumbs", "Thumbnails"],
          ["list", "List"],
        ] as const
      ).map(([id, label]) => (
        <button
          key={id}
          data-active={state.ribbonView === id}
          data-testid={`ribbon-view-${id}`}
          data-hint={
            id === "thumbs"
              ? "Show each photograph as a picture"
              : "One row per photograph, names and marks"
          }
          aria-label={label}
          // The same box as the Photo view and Filter chips, so the four
          // icon chips in the header are one size.
          style={RIBBON_ICON_CHIP}
          onClick={() => dispatch({ type: "set_ribbon_view", view: id })}
        >
          <ViewShapeIcon shape={id} />
        </button>
      ))}
    </div>
  );
}

/** The way into the full catalog view, first in the header 's
 * layout sketch.*/
/** The one box every icon-only chip in the ribbon's header wears, so
 * the Photo view button over the Filter button line up edge for
 * edge ("Make the Filter and Photo view button the same
 * size").*/
export const RIBBON_ICON_CHIP: React.CSSProperties = {
  boxSizing: "border-box",
  width: 30,
  height: 20,
  padding: 0,
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  gap: 3,
  fontSize: 9,
  flex: "none",
};

/** The picture browser's toolbar: every button in the Filter button's
 * box, so they read as one row (2026-09-15: "All the Buttons in this
 * picture browser should have the same size as what the filter
 * button is"). An icon-only button is exactly that box; one that
 * also carries a count or a label keeps the height and grows
 * sideways.*/
export const BROWSER_CHIP: React.CSSProperties = { ...RIBBON_ICON_CHIP };
export const BROWSER_CHIP_WIDE: React.CSSProperties = {
  ...RIBBON_ICON_CHIP,
  width: "auto",
  minWidth: 30,
  padding: "0 6px",
  boxSizing: "border-box",
};
/** The icon fills nine tenths of the button's height
 * ("make sure the icon scales up to fill 90% of the button space").*/
export const BROWSER_ICON = Math.round(0.9 * 20);

export function RibbonExpandButton({ dispatch }: { dispatch: D }) {
  return (
    <button
      className="chip"
      data-testid="ribbon-expand"
      data-hint="Fill the window with the folder and its metadata"
      aria-label="Expand the thumbnail panel"
      style={RIBBON_ICON_CHIP}
      onClick={() => dispatch({ type: "toggle_ribbon_expanded" })}
    >
      <svg width="11" height="11" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" aria-hidden focusable="false">
        <path d="M6 2H2v4M10 14h4v-4M2 10v4h4M14 6V2h-4" />
      </svg>
    </button>
  );
}

/** One cell's text, for a column and a photograph. */
export function cellText(
  column: string,
  m: ImageMeta,
  takes: number,
): string {
  switch (column) {
    case "name":
      return m.name;
    case "stars":
      return m.stars ? "★".repeat(m.stars) : "";
    case "flag":
      return m.flag === "pick" ? "Pick" : m.flag === "reject" ? "Reject" : "";
    case "edited":
      return m.edited ? "Yes" : "";
    case "takes":
      return String(takes);
    case "shot_at":
      return humanShotAt(m.shot_at);
    case "camera":
      return m.camera ?? "";
    case "lens":
      return m.lens ?? "";
    case "shutter":
      return m.shutter ?? "";
    case "aperture":
      return m.aperture ?? "";
    case "iso":
      return m.iso ? String(m.iso) : "";
    case "focal":
      return m.focal ?? "";
    case "exposure_bias":
      return m.exposure_bias ?? "";
    case "pixels":
      return m.width && m.height ? `${m.width} × ${m.height}` : "";
    case "size":
      return humanSize(m.size);
    default:
      return "";
  }
}

/** What a column sorts by.
 *
 * Numbers sort as numbers, which is the whole reason this is separate
 * from the text: ISO 1600 comes after ISO 400, and "1600" does not.
 * Blanks always sort last whichever way the arrow points, because a photo
 * with no lens recorded is not the smallest lens.
 */
export function sortKey(column: string, m: ImageMeta, takes: number): number | string {
  switch (column) {
    case "stars":
      return m.stars;
    case "iso":
      return m.iso ?? -1;
    case "takes":
      return takes;
    case "size":
      return m.size;
    case "edited":
      return m.edited ? 1 : 0;
    case "pixels":
      return (m.width ?? 0) * (m.height ?? 0);
    // Shutter and aperture are strings shaped like readings ("1/250",
    // "f/2.8"), so they need parsing back to sort in the order a
    // photographer expects rather than alphabetically.
    case "shutter": {
      const t = m.shutter ?? "";
      const frac = /^1\/(\d+)/.exec(t);
      if (frac) return 1 / Number(frac[1]);
      const secs = parseFloat(t);
      return Number.isFinite(secs) ? secs : -1;
    }
    case "aperture": {
      const f = parseFloat((m.aperture ?? "").replace("f/", ""));
      return Number.isFinite(f) ? f : -1;
    }
    case "focal": {
      const mm = parseFloat(m.focal ?? "");
      return Number.isFinite(mm) ? mm : -1;
    }
    case "exposure_bias": {
      const ev = parseFloat(m.exposure_bias ?? "");
      return Number.isFinite(ev) ? ev : -999;
    }
    default:
      return cellText(column, m, takes).toLowerCase();
  }
}

/** Orders the rows, blanks last. */
export function sortRows(
  rows: { meta: ImageMeta; takes: number }[],
  column: string,
  desc: boolean,
): { meta: ImageMeta; takes: number }[] {
  const out = [...rows];
  out.sort((a, b) => {
    const ka = sortKey(column, a.meta, a.takes);
    const kb = sortKey(column, b.meta, b.takes);
    // A photograph with nothing recorded in this column goes to the
    // bottom either way: it is absent, not small.
    const emptyA = ka === "" || ka === -1 || ka === -999;
    const emptyB = kb === "" || kb === -1 || kb === -999;
    if (emptyA !== emptyB) return emptyA ? 1 : -1;
    if (ka < kb) return desc ? 1 : -1;
    if (ka > kb) return desc ? -1 : 1;
    return a.meta.name.localeCompare(b.meta.name);
  });
  return out;
}

export function MetadataTable({
  state,
  dispatch,
  embedded,
  onThumbContext,
}: {
  state: State;
  dispatch: D;
  // Inside the catalog view the header (label, count, the way back) is
  // the CatalogHeader's job; standalone, the table still brings its own.
  embedded?: boolean;
  // Right-clicking a row raises the same menu the filmstrip's
  // thumbnails have; the Ribbon owns the menu, the table just asks.
  onThumbContext?: (menu: { x: number; y: number; id: string }) => void;
}) {
  const [metas, setMetas] = useState<ImageMeta[] | null>(null);
  const shown = visibleImages(state);
  const ids = shown.map((i) => i.id).join(",");

  useEffect(() => {
    let live = true;
    void folderMetadata(state, shown.map((i) => i.id)).then((m) => {
      if (live) setMetas(m);
    });
    return () => {
      live = false;
    };
  }, [ids]);

  const rows = sortRows(
    (metas ?? []).map((meta) => ({ meta, takes: takeCount(state, meta.id) })),
    state.ribbonSort.column,
    state.ribbonSort.desc,
  );

  // In the ribbon panel the ui-zoom wrapper already scales the table's
  // type; embedded in the catalog there is no wrapper (the grid's
  // thumbnails must stay pixel-true), so the fonts, and the columns
  // that must keep holding them, carry the chrome zoom step themselves,
  // read from the same preference so they track the chrome's setting.
  const fz = embedded ? chromeZoomFactor() : 1;

  return (
    <div
      data-testid="ribbon-table"
      style={{
        flex: 1,
        minWidth: 0,
        display: "flex",
        flexDirection: "column",
        background: "var(--bg-app)",
        borderRight: "1px solid var(--line-1)",
      }}
    >
      {!embedded && (
        <div
          style={{
            flex: "none",
            display: "flex",
            alignItems: "center",
            gap: 10,
            padding: "8px 12px",
            borderBottom: "1px solid var(--line-1)",
          }}
        >
          <div className="kicker" style={{ letterSpacing: ".14em" }}>
            {state.libraryLabel || "Folder"}
          </div>
          <div className="tnum" style={{ fontSize: 9, color: "var(--text-ghost)" }}>
            {rows.length} of {state.images.length}
          </div>
          <button
            className="chip"
            data-testid="ribbon-collapse"
            aria-label="Back to photo"
            data-tip="Back to photo"
            data-hint="Back to the photograph"
            style={{ ...BROWSER_CHIP, marginLeft: "auto" }}
            onClick={() => dispatch({ type: "toggle_ribbon_expanded" })}
          >
            <BackToPhotoIcon size={BROWSER_ICON} />
          </button>
        </div>
      )}

      <div style={{ flex: 1, minHeight: 0, overflow: "auto" }}>
        {/* One grid, so the header and every row share exactly one set of
            column widths. Two grids drift by a pixel the moment a
            scrollbar appears. */}
        <div
          style={{
            display: "grid",
            gridTemplateColumns: META_COLUMNS.map((c) => `${c.width * fz}px`).join(" "),
            minWidth: "fit-content",
          }}
        >
          {META_COLUMNS.map((c) => {
            const sorted = state.ribbonSort.column === c.id;
            return (
              <button
                key={c.id}
                data-testid={`col-${c.id}`}
                data-active={sorted}
                data-hint={c.own ? "This workspace's own" : "From the camera"}
                onClick={() => dispatch({ type: "set_ribbon_sort", column: c.id })}
                style={{
                  all: "unset",
                  cursor: "pointer",
                  position: "sticky",
                  top: 0,
                  zIndex: 2,
                  background: "var(--bg-panel)",
                  padding: "6px 8px",
                  fontSize: 9 * fz,
                  letterSpacing: ".08em",
                  textTransform: "uppercase",
                  textAlign: c.num ? "right" : "left",
                  borderBottom: "1px solid var(--line-2)",
                  // The workspace's columns are ours and editable; the
                  // camera's are a record. Told apart by color rather
                  // than by reading the labels.
                  color: sorted ? "var(--accent)" : c.own ? "var(--text-faint)" : "var(--text-ghost)",
                }}
              >
                {c.label}
                {sorted ? (state.ribbonSort.desc ? " ↓" : " ↑") : ""}
              </button>
            );
          })}

          {metas === null && (
            <div
              data-testid="ribbon-table-loading"
              style={{ gridColumn: `1 / -1`, padding: "10px 12px", fontSize: 10 * fz, color: "var(--text-ghost)" }}
            >
              Reading metadata…
            </div>
          )}

          {rows.map(({ meta, takes }) => {
            const active = meta.id === state.activeImage;
            const picked = state.imageSelection.includes(meta.id) && !active;
            return META_COLUMNS.map((c, i) => (
              <div
                key={`${meta.id}-${c.id}`}
                data-testid={i === 0 ? `table-row-${meta.id}` : undefined}
                onClick={(e) =>
                  dispatch({
                    type: "select_image_range",
                    id: meta.id,
                    additive: e.ctrlKey || e.metaKey,
                    range: e.shiftKey,
                  })
                }
                onContextMenu={(e) => {
                  // A Mac's Control-click is the table's ctrl-click, not a menu
                  // (; see isMacControlClick).
                  if (isMacControlClick(e)) {
                    e.preventDefault();
                    dispatch({ type: "select_image_range", id: meta.id, additive: true });
                    return;
                  }
                  if (!onThumbContext) return;
                  e.preventDefault();
                  if (!state.imageSelection.includes(meta.id)) {
                    dispatch({ type: "select_image_range", id: meta.id });
                  }
                  onThumbContext({ x: e.clientX, y: e.clientY, id: meta.id });
                }}
                className="tnum"
                style={{
                  cursor: "pointer",
                  padding: "4px 8px",
                  fontSize: 10 * fz,
                  whiteSpace: "nowrap",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  textAlign: c.num ? "right" : "left",
                  background: active ? "var(--bg-row)" : picked ? "#1b1a18" : "transparent",
                  color: active ? "var(--text-strong)" : "var(--text-faint)",
                  borderBottom: "1px solid var(--line-1)",
                  borderLeft: i === 0 ? `2px solid ${active ? "var(--accent)" : picked ? "var(--pick)" : "transparent"}` : undefined,
                }}
              >
                {cellText(c.id, meta, takes)}
              </div>
            ));
          })}
        </div>
      </div>
    </div>
  );
}
