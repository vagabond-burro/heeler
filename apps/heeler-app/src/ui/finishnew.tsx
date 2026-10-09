// The Finish tab's new-layer seats: the toolbar row above the stack,
// the list that stands in for the stack while it is empty, and the
// data both of them (and the menu bar's Layer > New Finish Layer, and
// the empty list's right-click menu) are drawn from.
//
// (2026-09-30), on a row of nine icon buttons with a "+" on most of
// them, wrapping to two rows: "I think all the new layer buttons is
// confusing and sort of sloppy looking." The row is now three seats
// that add and two that act:
//
// * Content you make: a split button. The left half adds a layer and
// shows whichever of Pixel, Gradient and Fill was made from it last
// (Pixel to start); the arrow opens the three.
// * Adjustment: its menu, as before, with a Utility section after
// the adjustment kinds for Smart and Warp ("Smart and Warp should
// be handled like Adjustments. I see them as sort of a utility").
// * Image: one button, From File and From Catalog under it.
// * Group and Delete at the right end, after a thin divider: they act
// on layers that exist rather than making one.
// * Expand settings on select, just left of that divider (the owner,
// 2026-09-30: "Add a button to the left of the separator next to
// the group button. It's a toggle button."): on, selecting a layer
// opens its settings; off, each layer opens with its chevron.
//
// No "+" badges: a caret marks the seats that open a menu, and nothing
// else wears a mark. The row keeps to one line; when it cannot (150
// percent app zoom in the narrowest panel), Group and Delete move to
// the right end of a second row and the add seats stay where they are.

import React, { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { ArtContentKind, Command, State } from "../state";
import { ART_ADJUSTMENTS, ART_CONTENT_KINDS, ART_KINDS, activeSelectionMask, selectionHasContent } from "../state";
import { runCommand } from "../commands";
import { EXPAND_ON_SELECT_GLYPH, MESH_WARP_GLYPH } from "./panelicons";
import { MenuSurface } from "./menusurface";
import { useDismiss } from "./hooks";
import { addImageLayerFromFile } from "./imagelayers";

type D = React.Dispatch<Command>;

/** The new-layer glyphs, 16x16 at a 1.4 stroke like the rest of the
 * Finish toolbar. */
export const NEW_LAYER_GLYPHS = {
  // A sheet with a corner turned: a canvas of pixels.
  pixel: (
    <>
      <path d="M2.5 2.5h7l4 4v7h-11z" />
      <path d="M9.5 2.5v4h4" />
    </>
  ),
  // A square shading from empty to full.
  gradient: (
    <>
      <rect x="2.5" y="2.5" width="11" height="11" />
      <path d="M4.5 11.5h7M6 9.5h5.5M8 7.5h3.5" />
    </>
  ),
  // A paint bucket, tipped.
  fill: (
    <>
      <path d="M7 2.5l5.5 5.5-5 5-5.5-5.5z" />
      <path d="M13.5 10.5c.8 1.2.8 2 0 2.6-.8.5-1.6.1-1.6-.9 0-.6.5-1.2 1.6-1.7z" fill="currentColor" stroke="none" />
    </>
  ),
  // Half-filled circle: the contrast dial every app draws for an
  // adjustment, because an adjustment is a change of tone.
  adjust: (
    <>
      <circle cx="8" cy="8" r="5.5" />
      <path d="M8 2.5a5.5 5.5 0 0 1 0 11z" fill="currentColor" stroke="none" />
    </>
  ),
  // An open frame with sparkles inside: the model-made selection.
  smart: (
    <>
      <path d="M6.5 2.5h-2a2 2 0 0 0-2 2v7a2 2 0 0 0 2 2h7a2 2 0 0 0 2-2v-2" />
      <path d="M11 1.6l.85 1.95 1.95.85-1.95.85L11 7.2l-.85-1.95-1.95-.85 1.95-.85z" fill="currentColor" stroke="none" />
      <path d="M7.6 6.7l.55 1.25 1.25.55-1.25.55-.55 1.25-.55-1.25-1.25-.55 1.25-.55z" fill="currentColor" stroke="none" />
    </>
  ),
  // A grid whose lines bow (panelicons MESH_WARP_GLYPH).
  warp: MESH_WARP_GLYPH,
  // A framed picture, hills under a sun.
  image: (
    <>
      <rect x="2.5" y="3.5" width="11" height="9" />
      <path d="M3 11.5l3.2-3.4 2.3 2.2 1.8-1.6 2.7 2.8" />
      <circle cx="10.6" cy="6.2" r="1" fill="currentColor" stroke="none" />
    </>
  ),
} as const;

/** A 16x16 glyph at the toolbar's stroke. */
export function Glyph({ glyph, size = 15 }: { glyph: React.ReactNode; size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {glyph}
    </svg>
  );
}

/** The small down caret on a seat that opens a menu, and only there. */
export function Caret() {
  return (
    <svg width="7" height="7" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M3.5 6l4.5 4.5L12.5 6" />
    </svg>
  );
}

/** One toolbar button: a glyph, a name for the hint row and for a
 * screen reader. `plus` is the small plus the per-layer rows still use
 * for "this adds something to the layer"; `caret` marks a button that
 * opens a menu; `pressed` makes it a toggle and says which way it is. */
export function IconButton({
  testid,
  label,
  hint,
  glyph,
  onClick,
  disabled = false,
  active = false,
  plus = false,
  caret = false,
  pressed,
  style,
}: {
  testid: string;
  label: string;
  hint: string;
  glyph: React.ReactNode;
  onClick: (e?: React.MouseEvent) => void;
  disabled?: boolean;
  active?: boolean;
  plus?: boolean;
  caret?: boolean;
  pressed?: boolean;
  style?: React.CSSProperties;
}) {
  return (
    <button
      className="chip"
      data-testid={testid}
      data-active={active || undefined}
      disabled={disabled}
      aria-label={label}
      aria-haspopup={caret ? "menu" : undefined}
      aria-expanded={caret ? active : undefined}
      aria-pressed={pressed}
      data-tip={label}
      data-hint={hint}
      onClick={onClick}
      onMouseDown={(e) => e.stopPropagation()}
      style={{ padding: "3px 5px", display: "inline-flex", alignItems: "center", gap: caret ? 3 : 1, ...style }}
    >
      <Glyph glyph={glyph} />
      {plus && (
        <svg width="7" height="7" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" aria-hidden="true">
          <path d="M8 3v10M3 8h10" />
        </svg>
      )}
      {caret && <Caret />}
    </button>
  );
}

/** One way to make a layer: its name, its picture, one outcome-first
 * line on what it is for, and what making it does. */
export interface NewLayerItem {
  id: string;
  label: string;
  hint: string;
  glyph: React.ReactNode;
  run: (state: State, dispatch: D) => void;
}

/** Content you make: the split button's three. */
export const CONTENT_ITEMS: Record<ArtContentKind, Omit<NewLayerItem, "run">> = {
  paint: {
    id: "paint",
    label: "Pixel layer",
    hint: "Add a clear layer to paint, clone and heal on, over everything below it",
    glyph: NEW_LAYER_GLYPHS.pixel,
  },
  gradient: {
    id: "gradient",
    label: "Gradient layer",
    hint: "Add a graduated tint for skies and falloff, or color the picture by its tones with By tone",
    glyph: NEW_LAYER_GLYPHS.gradient,
  },
  fill: {
    id: "fill",
    label: "Fill layer",
    hint: "Add a solid color; mask it to put the color only where you want it",
    glyph: NEW_LAYER_GLYPHS.fill,
  },
};

/** Makes a Pixel, Gradient or Fill layer and remembers the kind, so the
 * split button shows and repeats it. The remembering is view state,
 * not an edit: the add is the one undo step, as it always was. */
export function addContentLayer(dispatch: D, kind: ArtContentKind) {
  dispatch({ type: "set_art_content_kind", kind });
  dispatch({ type: "art_add_layer", kind });
}

export const contentItems = (): NewLayerItem[] =>
  ART_CONTENT_KINDS.map((k) => ({ ...CONTENT_ITEMS[k], run: (_s, d) => addContentLayer(d, k) }));

/** The Adjustment seat's own name and line. */
export const ADJUST_SEAT = {
  label: "Adjustment layer",
  hint: "Change everything below through the layer's own mask: an adjustment, or a Smart or Warp layer under Utility",
  glyph: NEW_LAYER_GLYPHS.adjust,
};

/** One line for the empty list's Adjustment row. */
export const ADJUST_ABOUT = "Curves, color and tone over everything below, through a mask";

export const adjustmentItems = (): NewLayerItem[] =>
  ART_ADJUSTMENTS.map((k) => ({
    id: k,
    label: ART_KINDS[k].label,
    hint: `Add ${ART_KINDS[k].label} on its own layer, changing everything below through its mask`,
    glyph: NEW_LAYER_GLYPHS.adjust,
    run: (_s, d) => d({ type: "art_add_layer", kind: k }),
  }));

/** The Utility section of the Adjustment menu: layers that work on the
 * picture below rather than paint or tone it. */
export const UTILITY_ITEMS: NewLayerItem[] = [
  {
    id: "smart",
    label: "Smart layer",
    hint: "Isolate the subject, the sky or what you click as its own layer of the picture below",
    glyph: NEW_LAYER_GLYPHS.smart,
    run: (_s, d) => d({ type: "art_add_smart_layer" }),
  },
  {
    id: "warp",
    label: "Warp layer",
    hint: "Bend everything below with a grid or shapes, shown only where the layer's mask lets it through",
    glyph: NEW_LAYER_GLYPHS.warp,
    run: (_s, d) => d({ type: "art_add_layer", kind: "warp" }),
  },
];

/** The Image seat's own name and line. */
export const IMAGE_SEAT = {
  label: "Image layer",
  hint: "Bring in a picture from a file or from this catalog, centered and fitted, to place with Transform",
  glyph: NEW_LAYER_GLYPHS.image,
};

export const IMAGE_ITEMS: NewLayerItem[] = [
  {
    id: "file",
    label: "From File…",
    hint: "Pick an image on disk; it stays where it is and the layer reads it from there",
    glyph: NEW_LAYER_GLYPHS.image,
    run: (s, d) => void addImageLayerFromFile(s, d),
  },
  {
    id: "catalog",
    label: "From Catalog…",
    hint: "Pick a photograph of this catalog; the layer shows it through its own edits",
    glyph: NEW_LAYER_GLYPHS.image,
    run: (_s, d) => d({ type: "open_catalog_layer_pick" }),
  },
];

/** The Image seat's third way in (2026-09-30: "to be able to marquee
 * select part of the background picture and copy that to a new pixel
 * layer"): New Layer via Copy, the Layer menu's item and Ctrl+J, made
 * an image layer so it moves and warps as one. Only in the panel's
 * Image menu, not in IMAGE_ITEMS, which the Layer menu's New Finish
 * Layer also reads: the Layer menu has its own New Layer via Copy.*/
export const COPY_ITEM: NewLayerItem = {
  id: "copy",
  label: "From Selection",
  hint: "Copy the pixels inside the selection to a new layer above the active one, to move, transform and warp on their own",
  glyph: NEW_LAYER_GLYPHS.image,
  run: (s, d) => void runCommand("layer.via_copy", s, d),
};

/** Which of the toolbar's three menus is open. */
export type NewMenu = "content" | "adjust" | "image";

/** The gap between the add seats and the actions, and between the two
 * rows when the actions wrap. */
export const TOOLBAR_GAP = 6;

/** Whether Group and Delete must go to a second row: the add seats,
 * the gap and the actions, all at their own widths, against the row.
 * Every width is an offsetWidth, which is CSS pixels inside the app's
 * zoom (client rects are misreported there). A row that reads zero
 * has not been laid out, and does not wrap. */
export function toolbarWraps(row: number, adds: number, actions: number): boolean {
  if (row <= 0) return false;
  return adds + TOOLBAR_GAP + actions > row;
}

/** A menu hanging under a toolbar seat, kept inside the toolbar's
 * width: at the narrowest panel a menu opened from the Image seat would
 * otherwise run off the panel's right edge. */
function SeatMenu({
  testid,
  label,
  children,
}: {
  testid: string;
  label: string;
  children: React.ReactNode;
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  useLayoutEffect(() => {
    const menu = ref.current;
    const seat = menu?.parentElement;
    const row = seat?.closest<HTMLElement>('[data-testid="finish-new-bar"]');
    if (!menu || !seat || !row) return;
    // offsetLeft of the seat is in the row's coordinates (the row is
    // the positioned ancestor), so the shift is all in one space.
    const room = row.offsetWidth - seat.offsetLeft;
    const over = menu.offsetWidth - room;
    if (row.offsetWidth > 0 && over > 0) {
      menu.style.left = `${-Math.min(over, seat.offsetLeft)}px`;
    }
  }, []);
  return (
    <MenuSurface
      ref={ref}
      aria-label={label}
      className="ctx-menu"
      data-testid={testid}
      onMouseDown={(e) => e.stopPropagation()}
      style={{ position: "absolute", top: "calc(100% + 4px)", left: 0, width: "max-content", minWidth: 150, zIndex: 60 }}
    >
      {children}
    </MenuSurface>
  );
}

/** One row of a seat's menu: its picture and name, its line on the
 * hint row, and the current choice in the accent. */
function MenuItem({
  item,
  testid,
  current = false,
  bare = false,
  disabled = false,
  why,
  onPick,
}: {
  item: Omit<NewLayerItem, "run">;
  testid: string;
  current?: boolean;
  /** no picture, its space kept */
  bare?: boolean;
  /** grayed, with `why` saying where it does apply */
  disabled?: boolean;
  why?: string;
  onPick: () => void;
}) {
  return (
    <div data-hint={disabled && why ? `${item.hint}. ${why}` : item.hint}>
      <button
        data-testid={testid}
        aria-label={item.label}
        data-active={current || undefined}
        disabled={disabled}
        onClick={onPick}
        style={current ? { color: "var(--accent)" } : undefined}
      >
        {/* The adjustment kinds would all wear the same dial, which
            says nothing nine times over: they keep the space and leave
            the pictures to the rows that differ. */}
        {bare ? <span aria-hidden="true" style={{ width: 14, flex: "none" }} /> : <Glyph glyph={item.glyph} size={14} />}
        <span>{item.label}</span>
      </button>
    </div>
  );
}

/** The Finish toolbar: the add seats on the left, Group and Delete at
 * the right end. The open menu is the caller's, so the empty list can
 * open the same one. */
export function FinishToolbar({
  state,
  dispatch,
  menu,
  setMenu,
  actions,
}: {
  state: State;
  dispatch: D;
  menu: NewMenu | null;
  setMenu: (m: NewMenu | null) => void;
  /** Group (or Ungroup) and Delete, drawn by the stack that knows what
   * is selected */
  actions: React.ReactNode;
}) {
  const kind = state.artContentKind;
  const content = CONTENT_ITEMS[kind] ?? CONTENT_ITEMS.paint;
  const root = useDismiss<HTMLDivElement>(menu !== null, () => setMenu(null));
  const addsRef = useRef<HTMLDivElement | null>(null);
  const actsRef = useRef<HTMLDivElement | null>(null);
  const [wrap, setWrap] = useState(false);
  const [, remeasure] = useState(0);
  // Measured after every render (the panel's width and the app zoom
  // both arrive as a re-render) and on the row's own resize.
  useLayoutEffect(() => {
    const row = root.current;
    const adds = addsRef.current;
    const acts = actsRef.current;
    if (!row || !adds || !acts) return;
    const next = toolbarWraps(row.offsetWidth, adds.offsetWidth, acts.offsetWidth);
    if (next !== wrap) setWrap(next);
  });
  useEffect(() => {
    const row = root.current;
    if (!row || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => remeasure((n) => n + 1));
    ro.observe(row);
    return () => ro.disconnect();
  }, [root]);
  const toggle = (m: NewMenu) => setMenu(menu === m ? null : m);
  const pick = (run: (s: State, d: D) => void) => {
    setMenu(null);
    run(state, dispatch);
  };
  return (
    <div
      ref={root}
      data-testid="finish-new-bar"
      data-wrapped={wrap || undefined}
      style={{
        position: "relative",
        display: "flex",
        flexWrap: wrap ? "wrap" : "nowrap",
        alignItems: "center",
        columnGap: TOOLBAR_GAP,
        rowGap: 4,
      }}
    >
      <div ref={addsRef} data-testid="art-toolbar-adds" style={{ display: "inline-flex", alignItems: "center", gap: 4, flex: "none" }}>
        {/* The split button: the left half makes the kind it shows, the
            arrow chooses among the three. Two chips sharing an edge, the
            app's own button face, nothing drawn around them. */}
        <div data-testid="art-content-seat" style={{ position: "relative", display: "inline-flex" }}>
          <IconButton
            testid="art-add-content"
            label={content.label}
            hint={`${content.hint}. The arrow beside it picks Pixel, Gradient or Fill`}
            glyph={content.glyph}
            onClick={() => {
              setMenu(null);
              addContentLayer(dispatch, kind);
            }}
            style={{ borderTopRightRadius: 0, borderBottomRightRadius: 0 }}
          />
          <button
            className="chip"
            data-testid="art-add-content-more"
            data-kind={kind}
            data-active={menu === "content" || undefined}
            aria-label="Pixel, Gradient or Fill layer"
            aria-haspopup="menu"
            aria-expanded={menu === "content"}
            data-tip="Pixel, Gradient or Fill layer"
            data-hint="Choose Pixel, Gradient or Fill; the button beside it then makes that kind"
            onMouseDown={(e) => e.stopPropagation()}
            onClick={() => toggle("content")}
            style={{
              padding: "3px 3px",
              display: "inline-flex",
              alignItems: "center",
              alignSelf: "stretch",
              borderLeft: "none",
              borderTopLeftRadius: 0,
              borderBottomLeftRadius: 0,
            }}
          >
            <Caret />
          </button>
          {menu === "content" && (
            <SeatMenu testid="art-content-menu" label="Pixel, Gradient or Fill layer">
              {ART_CONTENT_KINDS.map((k) => (
                <MenuItem
                  key={k}
                  item={CONTENT_ITEMS[k]}
                  testid={`art-content-${k}`}
                  current={k === kind}
                  onPick={() => pick((_s, d) => addContentLayer(d, k))}
                />
              ))}
            </SeatMenu>
          )}
        </div>
        <div style={{ position: "relative", display: "inline-flex" }}>
          <IconButton
            testid="art-add-adjust"
            label={ADJUST_SEAT.label}
            hint={ADJUST_SEAT.hint}
            glyph={ADJUST_SEAT.glyph}
            active={menu === "adjust"}
            caret
            onClick={() => toggle("adjust")}
          />
          {menu === "adjust" && (
            <SeatMenu testid="art-adjust-menu" label="Adjustment layer">
              {adjustmentItems().map((it) => (
                <MenuItem key={it.id} item={it} testid={`art-adjust-${it.id}`} bare onPick={() => pick(it.run)} />
              ))}
              <div className="sep" />
              <div className="hd" data-testid="art-adjust-utility">UTILITY</div>
              {UTILITY_ITEMS.map((it) => (
                <MenuItem key={it.id} item={it} testid={`art-utility-${it.id}`} onPick={() => pick(it.run)} />
              ))}
            </SeatMenu>
          )}
        </div>
        <div style={{ position: "relative", display: "inline-flex" }}>
          <IconButton
            testid="art-add-image"
            label={IMAGE_SEAT.label}
            hint={IMAGE_SEAT.hint}
            glyph={IMAGE_SEAT.glyph}
            active={menu === "image"}
            caret
            onClick={() => toggle("image")}
          />
          {menu === "image" && (
            <SeatMenu testid="art-image-menu" label="Image layer">
              {IMAGE_ITEMS.map((it) => (
                <MenuItem key={it.id} item={it} testid={`art-image-from-${it.id}`} onPick={() => pick(it.run)} />
              ))}
              <MenuItem
                item={COPY_ITEM}
                testid="art-image-from-copy"
                disabled={!selectionHasContent(activeSelectionMask(state))}
                why="Draw a selection first, with a tool from Interactive Selection in the Select menu."
                onPick={() => pick(COPY_ITEM.run)}
              />
            </SeatMenu>
          )}
        </div>
      </div>
      {/* Group and Delete, pushed to the right end; on a second row of
          their own when the row is too narrow for everything. */}
      <div style={{ flex: wrap ? "1 0 100%" : "1 1 auto", display: "flex", justifyContent: "flex-end", minWidth: 0 }}>
        <div ref={actsRef} data-testid="art-toolbar-actions" style={{ display: "inline-flex", alignItems: "center", gap: 4, flex: "none" }}>
          {/* Hidden rather than removed on the second row, so the
              actions measure the same either way and the row cannot
              flip back and forth at the boundary. */}
          <ExpandOnSelectToggle state={state} dispatch={dispatch} />
          <div style={{ width: 1, height: 15, background: "var(--line-2)", margin: "0 3px", visibility: wrap ? "hidden" : undefined }} />
          {actions}
        </div>
      </div>
    </div>
  );
}

/** Expand settings on select: one global choice, kept with the UI
 * settings rather than with a photograph (2026-09-30: "Whatever the
 * last setting the user set will persist, it's a global setting and
 * not per-photo").*/
export function ExpandOnSelectToggle({ state, dispatch }: { state: State; dispatch: D }) {
  const on = state.layerExpandOnSelect;
  return (
    <IconButton
      testid="art-expand-on-select"
      label="Expand settings on select"
      hint={
        on
          ? "On: selecting a layer opens its settings and closes the last one's. Click so layers stay compact and each opens with its chevron"
          : "Off: layers stay compact and each opens with the chevron beside its visibility dot. Click so selecting a layer opens its settings"
      }
      glyph={EXPAND_ON_SELECT_GLYPH}
      active={on}
      pressed={on}
      onClick={() => dispatch({ type: "set_ui_setting", key: "layerExpandOnSelect", value: !on })}
    />
  );
}

/** The empty stack's list: the same seats as the toolbar, named, each
 * with one line on what it is for. A click makes the layer; Adjustment
 * and Image open their menus in the toolbar, since each is a choice. */
export function FinishEmptyList({
  state,
  dispatch,
  openMenu,
}: {
  state: State;
  dispatch: D;
  openMenu: (m: NewMenu) => void;
}) {
  const row = (testid: string, glyph: React.ReactNode, name: string, about: string, onClick: () => void, hint: string, opens = false) => (
    <button
      key={testid}
      data-testid={testid}
      aria-label={name}
      aria-haspopup={opens ? "menu" : undefined}
      data-hint={hint}
      onClick={onClick}
      className="art-empty-row"
    >
      <span style={{ color: "var(--text-mid)", display: "inline-flex", paddingTop: 1 }}>
        <Glyph glyph={glyph} size={14} />
      </span>
      <span style={{ display: "flex", flexDirection: "column", gap: 1, minWidth: 0 }}>
        <span style={{ fontSize: 12, color: "var(--text-body)", display: "inline-flex", alignItems: "center", gap: 4 }}>
          {name}
          {opens && <Caret />}
        </span>
        <span style={{ fontSize: 11, color: "var(--text-ghost)", lineHeight: 1.4 }}>{about}</span>
      </span>
    </button>
  );
  const head = (text: string) => (
    <div key={text} style={{ fontSize: 11, letterSpacing: "0.12em", color: "var(--text-ghost)", padding: "8px 4px 2px" }}>
      {text}
    </div>
  );
  return (
    <div data-testid="art-empty" style={{ display: "flex", flexDirection: "column", padding: "8px 0 4px" }}>
      <div style={{ fontSize: 11, color: "var(--text-ghost)", lineHeight: 1.6, padding: "0 4px 4px" }}>
        Finishing layers go over the developed photograph; the graph grows a Finish group you can open like any other.
      </div>
      {head("PIXEL, GRADIENT OR FILL")}
      {ART_CONTENT_KINDS.map((k) => {
        const it = CONTENT_ITEMS[k];
        return row(`art-empty-${k}`, it.glyph, it.label, EMPTY_ABOUT[k], () => addContentLayer(dispatch, k), it.hint);
      })}
      {head("ADJUSTMENT")}
      {row("art-empty-adjust", ADJUST_SEAT.glyph, ADJUST_SEAT.label, ADJUST_ABOUT, () => openMenu("adjust"), ADJUST_SEAT.hint, true)}
      {head("UTILITY")}
      {UTILITY_ITEMS.map((it) => row(`art-empty-${it.id}`, it.glyph, it.label, EMPTY_ABOUT[it.id], () => it.run(state, dispatch), it.hint))}
      {head("IMAGE")}
      {row("art-empty-image", IMAGE_SEAT.glyph, IMAGE_SEAT.label, EMPTY_ABOUT.image, () => openMenu("image"), IMAGE_SEAT.hint, true)}
    </div>
  );
}

/** The empty list's one line per row: what the layer is for. */
const EMPTY_ABOUT: Record<string, string> = {
  paint: "Paint, clone and heal on a clear layer",
  gradient: "A graduated tint for skies, or colors by tone",
  fill: "A flat color, masked to where you want it",
  smart: "The subject, the sky or what you click, isolated",
  warp: "Bend everything below with a grid or shapes",
  image: "A picture from a file or from this catalog",
};
