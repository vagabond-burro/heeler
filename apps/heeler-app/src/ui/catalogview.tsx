// The expanded thumbnail panel's catalog surface: the owner's
// grid of thumbnails, and the Compare view it opens into.
//
// The owner, after watching the old gallery tool at work: "it's
// basically like [the file browser] but its specific to managing large
// catalogs of photos... I want the views to manage the catalogs of
// pictures to be separate from the actual editing of individual files."
// So this file is catalog management, and it never edits a photograph:
// it selects, compares, tags and filters. The metadata TABLE the panel
// always had lives on beside the grid as the other shape of the same
// surface.
//
// Compare shows up to four of the selection at a time. Arrow pages by
// four; SHIFT+Arrow slides by two, so the right pair becomes the left
// pair and judgment carries across pages. Tags are the keyword system:
// type a term once, then stamp it on panes with the 1..4 keys.

import { ThumbBox } from "./thumbbox";
import React, { useEffect, useRef, useState } from "react";
import type { Command, ImageEntry, State } from "../state";
import { visibleImages } from "../state";
import { isMacControlClick } from "../platform";
import { allKeywords, imageKeywords, setImageKeywords } from "../bridge";
import { FilterControls } from "./chrome";
import { chromeZoomFactor, setUiPref } from "../uiprefs";
import { TrackSlider } from "./track";
import { BROWSER_CHIP, BROWSER_CHIP_WIDE, BROWSER_ICON, BackToPhotoIcon, CompareIcon, EditTogetherIcon, MetadataTable, SortIcon, ViewShapeIcon } from "./ribbontable";
import { FlagToggle, StarRow } from "./tagrow";
import { openQuadEdit } from "../quadedit";
import { SuggestField } from "./suggestfield";

type D = React.Dispatch<Command>;

/** Grid tile bounds: the slider's rails. 168 was the old fixed size
 * and stays the default. */
const TILE_MIN = 96;
const TILE_MAX = 300;

/** The catalog lives outside the chrome's ui-zoom wrapper so its
 * thumbnails stay pixel-true, but "In the photo view,
 * increase the size of the fonts by 1.15x". The header rows wear
 * ui-zoom like the rest of the chrome; the type that sits against
 * images (tile captions, compare pane footers) cannot be zoomed
 * without softening the pictures, so those fonts carry the chrome zoom
 * step themselves, read from the same preference so they never drift
 * from the chrome.*/

/** Raising the shared thumbnail context menu is the Ribbon's business;
 * the catalog only reports where and on which photo it was asked for. */
export type ThumbContext = (menu: { x: number; y: number; id: string }) => void;

export function CatalogView({
  state,
  dispatch,
  onThumbContext,
}: {
  state: State;
  dispatch: D;
  onThumbContext?: ThumbContext;
}) {
  if (state.catalogCompare) return <CompareView state={state} dispatch={dispatch} />;
  return (
    <div
      data-testid="catalog-view"
      style={{
        flex: 1,
        minWidth: 0,
        display: "flex",
        flexDirection: "column",
        background: "var(--bg-app)",
        borderRight: "1px solid var(--line-1)",
      }}
    >
      <CatalogHeader state={state} dispatch={dispatch} />
      {state.expandedView === "table" ? (
        <MetadataTable state={state} dispatch={dispatch} embedded onThumbContext={onThumbContext} />
      ) : (
        <GridBody state={state} dispatch={dispatch} onThumbContext={onThumbContext} />
      )}
    </div>
  );
}

/** The header both shapes share: what folder, how many, which shape,
 * the way into Compare and the way back to the photo. */
export function CatalogHeader({
  state,
  dispatch,
  children,
}: {
  state: State;
  dispatch: D;
  children?: React.ReactNode;
}) {
  const selected = state.imageSelection.length;
  return (
    <div
      className="ui-zoom"
      style={{
        flex: "none",
        display: "flex",
        alignItems: "center",
        gap: 10,
        rowGap: 6,
        // The filters sit in the row now, so a narrow window wraps the
        // row rather than pushing the way back off the edge.
        flexWrap: "wrap",
        padding: "8px 12px",
        borderBottom: "1px solid var(--line-1)",
      }}
    >
      <div className="kicker" style={{ letterSpacing: ".14em" }}>
        {state.libraryLabel || "Folder"}
      </div>
      <div className="tnum" style={{ fontSize: 9, color: "var(--text-ghost)" }}>
        {visibleImages(state).length} of {state.images.length}
        {selected > 1 ? ` · ${selected} selected` : ""}
      </div>
      <div
        className="zoom-seg"
        role="group"
        aria-label="Catalog view"
        style={{ border: "1px solid var(--line-4)" }}
      >
        {/* The ribbon's own view icons rather than words ("Replace
the Grid / Table labels with the icons that the thumbnail view
uses"): the grid of pictures and the list of rows mean the same
thing here as they do in the panel.*/}
        {(
          [
            ["grid", "Grid", "thumbs", "The folder as a grid of pictures"],
            ["table", "Table", "list", "One row per photograph, the metadata table"],
          ] as const
        ).map(([id, label, shape, hint]) => (
          <button
            key={id}
            data-active={state.expandedView === id}
            data-testid={`expanded-view-${id}`}
            aria-label={label}
            data-hint={hint}
            style={BROWSER_CHIP}
            onClick={() => dispatch({ type: "set_expanded_view", view: id })}
          >
            <ViewShapeIcon shape={shape} size={BROWSER_ICON} />
          </button>
        ))}
      </div>
      <button
        className="chip"
        data-testid="open-compare"
        disabled={selected < 2}
        aria-label="Compare"
        data-tip="Compare"
        data-hint="Review the selected photos four at a time"
        data-hint-key="C"
        style={selected > 1 ? BROWSER_CHIP_WIDE : BROWSER_CHIP}
        onClick={() => {
          // Selection in VIEW order, not click order: comparing walks
          // the shoot the way the shoot is laid out.
          const ids = visibleImages(state)
            .filter((i) => state.imageSelection.includes(i.id))
            .map((i) => i.id);
          dispatch({ type: "open_compare", ids });
        }}
      >
        <CompareIcon size={BROWSER_ICON} />
        {/* The count stays: it says how many the compare will walk. */}
        {selected > 1 && <span className="tnum">{selected}</span>}
      </button>
      <button
        className="chip"
        data-testid="open-quad"
        disabled={selected < 2 || selected > 4}
        aria-label="Edit together"
        data-tip="Edit together"
        data-hint="Edit the selected photos together, adjustments landing on all of them"
        style={BROWSER_CHIP}
        onClick={() => {
          // Quad lives in the editing surface; fold the catalog first.
          dispatch({ type: "toggle_ribbon_expanded" });
          void openQuadEdit(state, dispatch, state.imageSelection);
        }}
      >
        <EditTogetherIcon size={BROWSER_ICON} />
      </button>
      {/* The catalog's own filter, sort and size seats ("I noticed
filters are missing. Also, there should be a slider to control
thumbnail size. As well as missing ascending and descending
ordering"). The filters are the ribbon's own controls, laid out in the
row now that the actions are icons (2026-09-15: "I want to see what
that header looks like with the filters options, so we don't have to
use the pop up menu"); the sort is the ribbon's own direction, shared
on purpose so the strip and the grid never disagree about order; the
slider is the grid's alone and steps aside in Table view, whose rows
have no size to control.*/}
      {/* Centered between the actions and the sort, in the room the
labels gave up (2026-09-15: "center the filtering controls
between the sort buttons and the edit together buttons").*/}
      <div style={{ flex: "1 0 300px", minWidth: 0, display: "flex", justifyContent: "center" }}>
        <FilterControls state={state} dispatch={dispatch} inline />
      </div>
      {/* Keep the way back beside sort and size when the row wraps. */}
      <div style={{ display: "flex", alignItems: "center", gap: 10, flex: "none", marginLeft: "auto" }}>
        {/* One sort button that cycles, at the right beside the size and the way
back ("consolidated to one button to save space. Clicking
on it cycles the sorting direction"; "Move the scale slider and sort
to the right side").*/}
        {(() => {
          const desc = state.ribbonSort.desc;
          const name = desc ? "Newest first" : "Oldest first";
          return (
            <button
              className="chip"
              data-testid="catalog-sort"
              data-sort={desc ? "desc" : "asc"}
              aria-pressed={desc}
              aria-label={name}
              data-tip={name}
              data-hint={
                desc
                  ? "Newest first: the list read from the other end. Click for oldest first"
                  : "Oldest first: file-name order, which on any camera is the order they were taken. Click for newest first"
              }
              style={BROWSER_CHIP}
              onClick={() => dispatch({ type: "set_ribbon_sort", desc: !desc })}
            >
              <SortIcon size={BROWSER_ICON} desc={desc} />
            </button>
          );
        })()}
        {state.expandedView === "grid" && (
          <div style={{ width: 110 }} data-hint="How big the grid draws each photograph">
            <TrackSlider
              label="Size"
              value={Math.min(300, Math.max(96, state.expandedTile || 168))}
              lo={96}
              hi={300}
              step={4}
              testid="catalog-tile-size"
              onChange={(v) => {
                dispatch({ type: "set_expanded_tile", px: v });
                setUiPref("expandedTile", v);
              }}
            />
          </div>
        )}
        {children}
        <button
          className="chip"
          data-testid="ribbon-collapse"
          aria-label="Back to photo"
          data-tip="Back to photo"
          data-hint="Close the browser and continue editing the active photo"
          style={BROWSER_CHIP}
          onClick={() => dispatch({ type: "toggle_ribbon_expanded" })}
        >
          <BackToPhotoIcon size={BROWSER_ICON} />
        </button>
      </div>
    </div>
  );
}

function GridBody({
  state,
  dispatch,
  onThumbContext,
}: {
  state: State;
  dispatch: D;
  onThumbContext?: ThumbContext;
}) {
  const shown = visibleImages(state);
  const tile = Math.min(TILE_MAX, Math.max(TILE_MIN, state.expandedTile || 168));
  const FZ = chromeZoomFactor();
  // C from the grid is the fast way into Compare, matching the button.
  useEffect(() => {
    const on = (e: KeyboardEvent) => {
      if (e.key.toLowerCase() !== "c" || e.ctrlKey || e.metaKey || e.altKey) return;
      const el = e.target as HTMLElement | null;
      if (el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA")) return;
      if (state.imageSelection.length < 2) return;
      e.stopPropagation();
      const ids = visibleImages(state)
        .filter((i) => state.imageSelection.includes(i.id))
        .map((i) => i.id);
      dispatch({ type: "open_compare", ids });
    };
    window.addEventListener("keydown", on, true);
    return () => window.removeEventListener("keydown", on, true);
  }, [state, dispatch]);

  return (
    <div
      data-testid="catalog-grid-view"
      style={{ flex: 1, minHeight: 0, overflowY: "auto", padding: 8 }}
    >
        <div
          data-testid="catalog-grid"
          style={{
            display: "grid",
            gridTemplateColumns: `repeat(auto-fill, minmax(${tile}px, 1fr))`,
            gap: 6,
          }}
        >
          {shown.map((img) => {
            const active = img.id === state.activeImage;
            const picked = state.imageSelection.includes(img.id) && !active;
            return (
              <div
                role="group"
                aria-label={img.name}
                key={img.id}
                data-testid={`grid-${img.id}`}
                data-selected={active || picked}
                onClick={(e) =>
                  dispatch({
                    type: "select_image_range",
                    id: img.id,
                    additive: e.ctrlKey || e.metaKey,
                    range: e.shiftKey,
                  })
                }
                onDoubleClick={() => {
                  // The grid manages; double-click hands off to editing.
                  dispatch({ type: "select_image", id: img.id });
                  dispatch({ type: "toggle_ribbon_expanded" });
                }}
                onContextMenu={(e) => {
                  // A Mac's Control-click is the grid's ctrl-click, not a menu
                  // (; see isMacControlClick).
                  if (isMacControlClick(e)) {
                    e.preventDefault();
                    dispatch({ type: "select_image_range", id: img.id, additive: true });
                    return;
                  }
                  if (!onThumbContext) return;
                  e.preventDefault();
                  // Outside the selection moves to that photo first, so
                  // the menu always acts on what is highlighted; the
                  // filmstrip's rule.
                  if (!state.imageSelection.includes(img.id)) {
                    dispatch({ type: "select_image_range", id: img.id });
                  }
                  onThumbContext({ x: e.clientX, y: e.clientY, id: img.id });
                }}
                style={{
                  all: "unset",
                  cursor: "pointer",
                  display: "flex",
                  flexDirection: "column",
                  background: active ? "var(--bg-row)" : "var(--bg-panel)",
                  outline: active
                    ? "2px solid var(--accent)"
                    : picked
                      ? "2px solid var(--accent)"
                      : "1px solid var(--line-1)",
                }}
              >
                {/* Every tile is the same 4:3 landscape window (the ribbon's ratio); a
photo of any other shape sits whole inside it on gray bars.
Portrait photos disrupted the layout; differing aspect ratios need
gray bars.*/}
                <button type="button" className="thumb-action" aria-label={`Select ${img.name}`} style={{ display: "block", width: "100%", aspectRatio: "4 / 3", background: "#1f2426" }}>
                  <ThumbBox
                    id={img.id}
                    src={img.src}
                    pending={
                      <div className="thumb-pending" data-testid={`thumb-pending-${img.id}`}>
                        <img src="/heeler-icon.svg" alt="" width={28} height={28} />
                      </div>
                    }
                  >
                    <img
                      src={img.src}
                      alt={img.name}
                      style={{ width: "100%", height: "100%", objectFit: "contain", filter: img.filter }}
                    />
                  </ThumbBox>
                </button>
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 5,
                    padding: "3px 6px",
                    fontSize: 9 * FZ,
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
                      color: "var(--text-body)",
                    }}
                  >
                    {img.name}
                  </span>
                  {/* The filmstrip's five stars, on every tile: the rating shows whether
or not there is one, and a click sets it here as it does in the
strip (2026-09-15: "The picture browser should show the ratings on
each thumbnail"). A lit ★ alone only showed on rated photos, which
read as no ratings at all across an unrated shoot.*/}
                  <StarRow img={img} active={active} state={state} dispatch={dispatch} />
                  {/* And the strip's pick and reject, always there to click (2026-09-15:
"I should also be able to see picks and rejects from here"); a P or
X only when set had no seat to set one from.*/}
                  <FlagToggle img={img} state={state} dispatch={dispatch} />
                </div>
              </div>
            );
          })}
        </div>
    </div>
  );
}

/** One compare pane's keywords, cached and editable through the same
 * bridge the metadata tab uses. */
function useKeywords(id: string) {
  const [keywords, setKeywords] = useState<string[]>([]);
  const edited = useRef(false);
  useEffect(() => {
    edited.current = false;
    void imageKeywords(id).then((k) => {
      // A stamp that lands before this first read resolves must not be
      // wiped by it; the store already knows better than this snapshot.
      if (!edited.current) setKeywords(k);
    });
  }, [id]);
  const toggle = (tag: string) => {
    edited.current = true;
    // Read-modify-write against the store, not the local copy: the copy
    // can be a render behind when stamps arrive as fast as key presses.
    void (async () => {
      const current = await imageKeywords(id);
      const has = current.some((k) => k.toLowerCase() === tag.toLowerCase());
      const next = has
        ? current.filter((k) => k.toLowerCase() !== tag.toLowerCase())
        : [...current, tag];
      await setImageKeywords(id, next);
      setKeywords(next);
    })();
  };
  return { keywords, toggle };
}

function ComparePane({
  img,
  slot,
  tag,
}: {
  img: ImageEntry;
  slot: number;
  tag: string;
}) {
  const { keywords, toggle } = useKeywords(img.id);
  const FZ = chromeZoomFactor();
  // The 1..4 stamp keys arrive from the view's key handler as events.
  useEffect(() => {
    const on = (e: Event) => {
      const which = (e as CustomEvent<number>).detail;
      if (which === slot && tag) toggle(tag);
    };
    window.addEventListener("heeler:compare-stamp", on);
    return () => window.removeEventListener("heeler:compare-stamp", on);
  });
  return (
    <div
      data-testid={`compare-pane-${slot}`}
      style={{
        display: "flex",
        flexDirection: "column",
        minWidth: 0,
        minHeight: 0,
        background: "var(--bg-panel)",
        border: "1px solid var(--line-1)",
      }}
    >
      <div style={{ flex: 1, minHeight: 0, background: "#111010" }}>
        {img.src ? (
          <img
            src={img.src}
            alt={img.name}
            style={{ width: "100%", height: "100%", objectFit: "contain", filter: img.filter }}
          />
        ) : (
          <div className="thumb-pending">
            <img src="/heeler-icon.svg" alt="" width={36} height={36} />
          </div>
        )}
      </div>
      <div style={{ flex: "none", display: "flex", alignItems: "center", gap: 6, padding: "4px 8px", fontSize: 9 * FZ }}>
        <span className="tnum" style={{ color: "var(--text-ghost)" }}>{slot}</span>
        <span
          className="tnum"
          style={{
            flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis",
            whiteSpace: "nowrap", color: "var(--text-body)",
          }}
        >
          {img.name}
        </span>
        {img.stars > 0 && (
          <span className="tnum" style={{ color: "var(--accent)" }}>{"★".repeat(img.stars)}</span>
        )}
        {tag && (
          <button
            className="chip"
            data-testid={`compare-tag-${slot}`}
            data-active={keywords.some((k) => k.toLowerCase() === tag.toLowerCase()) || undefined}
            data-hint={`Toggle "${tag}" on this photo (key ${slot})`}
            style={{
              fontSize: 8 * FZ,
              padding: "0 6px",
              color: keywords.some((k) => k.toLowerCase() === tag.toLowerCase())
                ? "var(--accent)"
                : undefined,
            }}
            onClick={() => toggle(tag)}
          >
            {tag}
          </button>
        )}
      </div>
      {keywords.length > 0 && (
        <div style={{ flex: "none", display: "flex", flexWrap: "wrap", gap: 3, padding: "0 8px 5px" }}>
          {keywords.map((k) => (
            <span
              key={k}
              style={{
                fontSize: 8 * FZ, padding: "0 5px", border: "1px solid var(--line-4)",
                color: "var(--text-faint)", background: "var(--bg-app)",
              }}
            >
              {k}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

function CompareView({ state, dispatch }: { state: State; dispatch: D }) {
  const compare = state.catalogCompare!;
  const byId = new Map(state.images.map((i) => [i.id, i]));
  const windowIds = compare.ids.slice(compare.start, compare.start + 4);
  const panes = windowIds
    .map((id) => byId.get(id))
    .filter((i): i is ImageEntry => !!i);
  const [tag, setTag] = useState("");
  const [known, setKnown] = useState<string[]>([]);
  const tagRef = useRef(tag);
  tagRef.current = tag;

  useEffect(() => {
    void allKeywords().then(setKnown);
  }, []);

  // The view's whole keyboard: Arrow ±4, SHIFT+Arrow ±2, Escape out,
  // 1..4 stamp the current tag. Capture phase, so the app's photo
  // navigation and shortcuts stand aside while comparing.
  useEffect(() => {
    const on = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      const typing = el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA");
      if (e.key === "Escape") {
        e.stopPropagation();
        if (typing) return; // Escape leaves the tag field first
        dispatch({ type: "close_compare" });
        return;
      }
      if (typing) return;
      if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
        e.preventDefault();
        e.stopPropagation();
        const unit = e.shiftKey ? 2 : 4;
        dispatch({ type: "compare_step", by: e.key === "ArrowRight" ? unit : -unit });
        return;
      }
      if (["1", "2", "3", "4"].includes(e.key) && tagRef.current) {
        e.preventDefault();
        e.stopPropagation();
        window.dispatchEvent(
          new CustomEvent("heeler:compare-stamp", { detail: Number(e.key) })
        );
      }
    };
    window.addEventListener("keydown", on, true);
    return () => window.removeEventListener("keydown", on, true);
  }, [dispatch]);

  return (
    <div
      data-testid="compare-view"
      style={{
        flex: 1,
        minWidth: 0,
        display: "flex",
        flexDirection: "column",
        background: "var(--bg-app)",
        borderRight: "1px solid var(--line-1)",
      }}
    >
      <div
        className="ui-zoom"
        style={{
          flex: "none", display: "flex", alignItems: "center", gap: 10,
          padding: "8px 12px", borderBottom: "1px solid var(--line-1)",
        }}
      >
        <div className="kicker" style={{ letterSpacing: ".14em" }}>Compare</div>
        <div className="tnum" data-testid="compare-window" style={{ fontSize: 9, color: "var(--text-ghost)" }}>
          {compare.start + 1} to {Math.min(compare.start + 4, compare.ids.length)} of {compare.ids.length}
        </div>
        <SuggestField
          data-testid="compare-tag-input"
          aria-label="Tag to stamp"
          value={tag}
          placeholder="Tag to stamp (keys 1 to 4)…"
          suggestions={known}
          onChange={setTag}
          boxStyle={{ width: 180 }}
          style={{
            background: "var(--bg-app)", border: "1px solid var(--line-4)",
            color: "var(--text-body)", fontSize: 10, padding: "3px 6px", outline: "none",
          }}
        />
        <div style={{ fontSize: 9, color: "var(--text-ghost)" }}>
          arrows page 4 · shift+arrows slide 2 · esc back
        </div>
        <button
          className="chip"
          data-testid="compare-close"
          style={{ fontSize: 9, padding: "2px 9px", marginLeft: "auto" }}
          onClick={() => dispatch({ type: "close_compare" })}
        >
          BACK TO GRID
        </button>
      </div>
      <div
        style={{
          flex: 1, minHeight: 0, display: "grid", gap: 6, padding: 8,
          gridTemplateColumns: panes.length > 1 ? "1fr 1fr" : "1fr",
          gridTemplateRows: panes.length > 2 ? "1fr 1fr" : "1fr",
        }}
      >
        {panes.map((img, i) => (
          <ComparePane key={img.id} img={img} slot={i + 1} tag={tag.trim()} />
        ))}
      </div>
    </div>
  );
}
