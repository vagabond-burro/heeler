// The Finish tab: layer-editor-style finishing layers over the developed
// photograph, as a view over the "art" group node. Top-most layer
// first, the way every layers panel anyone has used draws it; the graph
// runs the same list bottom up. Groups are isolation groups: members
// composite together over a transparent canvas, and the group blends
// onto the photo as one unit with its own mode, opacity and mask.

import React, { useEffect, useRef, useState } from "react";
import type { ArtLayer, Command, NodeCard, State } from "../state";
import { ART_FX, ART_FX_INNER, ART_KINDS, BRUSH_TIPS, DOC_SEL_ID, LAYER_WARP, activeIsExr, artMaskEditTool, imageLayerWarp, isPictureWarp, warpEditing, artGroupMembers, artLayers, artMaskOf, canGroupLayers, depthMaskShown, maskPreviewNode, hardRange, paramRange, POLISH_MODES, layerMaskPolarity, maskIsOff, selectionHasContent, type MaskFromSelectionOp } from "../state";
import { FinishAdjustmentControls } from "./finishadjustments";
import { useDismiss } from "./hooks";
import { clampMenu, viewportSize } from "./menupos";
import { layerActionHint, layerActions, toggleLayerMask, type LayerActionItem } from "../layeractions";
import { MenuField } from "./menufield";
import { ExportTick, MASK_EXPORT_LABEL, MaskExportTick } from "./exporttick";
import { PREVIEW_MODES } from "./selection";
import { ColorField, FillColorControls } from "./colorfield";
import { MaskViewButton, SmartModePanel, depthEyeHint, depthEyeModifier } from "./smarttool";
import { ObjectMattePanel } from "./mattetool";
import { MASK_FROM_SELECTION_GLYPH } from "./panelicons";
import { FinishWarpControls } from "./finishwarp";
import { bakeLayerMask, bakeMaskRaster } from "../bridge";
import { flashStatus, reportToolError } from "./hints";
import { MASK_OFF_HINT, slashed } from "./masktoggle";
import { publishBusy } from "./statusbar";
import { modLabel } from "../platform";
import { GradientControls, GradientPanel, isByTone, readStops } from "./gradientstops";
import { BrushTipPicker, ValueField, paramDefault } from "./simple";
import { LevelsEditor } from "./levels";
import { DEPTH_LEVELS_HINT, DEPTH_LEVELS_KEYS, useDepthBins } from "./depthbins";
import { TrackSlider, fmt as valueText } from "./track";
import { ImageLayerControls, isImageLayer } from "./imagelayers";
import { FinishEmptyList, FinishToolbar, IconButton, NEW_LAYER_GLYPHS, contentItems, adjustmentItems, UTILITY_ITEMS, IMAGE_ITEMS, type NewMenu } from "./finishnew";

type D = React.Dispatch<Command>;

/** The modes the engine's blend node understands, in the order layer-editor
 * users expect to find them. */
/** An effect's own small menus: the gradient overlay's shape, the
 * blur's type and the inner or outer placement. */
const FX_GRADIENT_SHAPES = [
  { id: "linear", label: "Linear" },
  { id: "radial", label: "Radial" },
];
const FX_BLUR_KINDS = [
  { id: "gaussian", label: "Gaussian" },
  { id: "box", label: "Box" },
  { id: "motion", label: "Motion" },
];
const FX_PLACEMENTS = [
  { id: "0", label: "Outer" },
  { id: "1", label: "Inner" },
];

export const ART_MODES: { id: string; label: string }[] = [
  { id: "normal", label: "Normal" },
  { id: "darken", label: "Darken" },
  { id: "multiply", label: "Multiply" },
  { id: "color_burn", label: "Color Burn" },
  { id: "lighten", label: "Lighten" },
  { id: "screen", label: "Screen" },
  { id: "color_dodge", label: "Color Dodge" },
  { id: "add", label: "Add" },
  { id: "overlay", label: "Overlay" },
  { id: "soft_light", label: "Soft Light" },
  { id: "hard_light", label: "Hard Light" },
  { id: "vivid_light", label: "Vivid Light" },
  { id: "linear_light", label: "Linear Light" },
  { id: "difference", label: "Difference" },
  { id: "exclusion", label: "Exclusion" },
  { id: "hue", label: "Hue" },
  { id: "saturation", label: "Saturation" },
  { id: "color", label: "Color" },
  { id: "luminosity", label: "Luminosity" },
];

/** The Finish toolbar's glyphs. Drawn, not fetched: an icon font is a
 * network request, a license and a flash of nothing on first paint, for
 * a handful of shapes that are each a few lines. 16x16, 1.4 stroke, to
 * match the chrome around them. */
const ICONS = {
  // An open frame with sparkles inside: the model-made selection, 's
  // reference art (the same picture the Smart layer wears in the
  // Adjustment menu's Utility section, finishnew.tsx).
  smartMask: NEW_LAYER_GLYPHS.smart,
  // Half light, half dark: the two halves of dodging and burning.
  dodgeburn: (
    <>
      <circle cx="8" cy="8" r="5.5" />
      <path d="M8 2.5a5.5 5.5 0 0 0 0 11z" fill="currentColor" stroke="none" />
      <path d="M8 5.5v5" />
    </>
  ),
  // The letters themselves, the way the layer editors mark layer
  // effects. The star burst it replaces sat two buttons from the Smart
  // sparkles and read as the same idea; "dropping the star
  // shape for FX... might help."
  fx: (
    <text
      x="1.5"
      y="12"
      fontSize="11"
      fontStyle="italic"
      fontFamily="inherit"
      fill="currentColor"
      stroke="none"
    >
      fx
    </text>
  ),
  // A dashed marquee becoming a solid mask: the selection turning into
  // the thing the layer shows through.
  maskFromSel: MASK_FROM_SELECTION_GLYPH,
  // A circle inside a frame: the mask thumbnail every editor draws.
  mask: (
    <>
      <rect x="2.5" y="3" width="11" height="10" />
      <circle cx="8" cy="8" r="2.8" fill="currentColor" stroke="none" />
    </>
  ),
  // A tagged box, the name a renderer gave the object: the glyph the
  // Layers row draws for the Object kind, redrawn at this row's size.
  objectMask: (
    <>
      <path d="M3 5.5l5-2.7 5 2.7v5.8l-5 2.7-5-2.7z" />
      <path d="M3 5.5l5 2.6 5-2.6M8 8.1v5.9" opacity=".6" />
    </>
  ),
  /* The scene in depth: a near ridge over a far one, the Depth block's own
picture in the Adjustments panel (DepthViewIcon, minus its sun), where
two stacked planes read as the canvas header's before and after
(2026-09-20).*/
  depth: (
    <>
      <path d="M1.5 12.5l3.4-4.6 2.4 3 1.8-2.2 3.4 3.8" />
      <path d="M4.5 8.6l2-2.6 1.9 2.2" opacity="0.55" />
    </>
  ),
  /* The old two planes, kept for nothing; see depth above. */
  depthPlanes: (
    <>
      <rect x="2" y="6" width="8" height="8" rx="1" />
      <path d="M6 6V3.5A1.5 1.5 0 0 1 7.5 2H12.5A1.5 1.5 0 0 1 14 3.5V8.5A1.5 1.5 0 0 1 12.5 10H10" />
    </>
  ),
  /* Reads the map the other way: a half-filled disc. */
  invert: (
    <>
      <circle cx="8" cy="8" r="6" />
      <path d="M8 2a6 6 0 0 1 0 12z" fill="currentColor" stroke="none" />
    </>
  ),
  eye: (
    <>
      <path d="M1.5 8s2.5-4.5 6.5-4.5S14.5 8 14.5 8 12 12.5 8 12.5 1.5 8 1.5 8z" />
      <circle cx="8" cy="8" r="2" />
    </>
  ),
  // The red overlay flavor, MaskOverlayIcon's drawing: the tint ON the
  // picture, told apart from the eye before either is pressed.
  overlay: (
    <>
      <rect x="1.5" y="2.5" width="13" height="11" rx="1.5" />
      <circle cx="8" cy="8" r="3.1" fill="currentColor" stroke="none" opacity="0.85" />
    </>
  ),
  trash: (
    <>
      <path d="M3 4.5h10" />
      <path d="M6.5 4.5v-2h3v2" />
      <path d="M4.5 4.5l.7 9h5.6l.7-9" />
    </>
  ),
  // A folder: what a group is, everywhere anyone has seen one.
  group: (
    <>
      <path d="M2 12.5v-9h4l1.4 2H14v7z" />
    </>
  ),
  // The same folder, opening, with its contents leaving.
  ungroup: (
    <>
      <path d="M2 12.5v-9h4l1.4 2H14v2" />
      <path d="M2 12.5l2.2-4.5H15l-2.2 4.5z" />
    </>
  ),
} as const;

function VisibilityDot({
  id,
  enabled,
  dispatch,
  onToggle,
}: {
  id: string;
  enabled: boolean;
  dispatch: D;
  /** what the dot means for THIS row; layers are the default, and an
   * fx row passes its own toggle (art_layer_set rejects an fx id). */
  onToggle?: (enabled: boolean) => void;
}) {
  return (
    <button
      style={{ all: "unset", cursor: "pointer", width: 12, textAlign: "center" }}
      data-testid={`art-vis-${id}`}
      aria-label={enabled ? "Hide layer" : "Show layer"}
      data-hint="Show or hide this layer"
      onClick={(e) => {
        e.stopPropagation();
        if (onToggle) onToggle(!enabled);
        else dispatch({ type: "art_layer_set", id, enabled: !enabled });
      }}
    >
      <span
        style={{
          display: "inline-block",
          width: 7,
          height: 7,
          borderRadius: 7,
          background: enabled ? "var(--accent)" : "transparent",
          border: "1px solid var(--line-4)",
        }}
      />
    </button>
  );
}

/** The Finish layer's Export checkbox lives in exporttick.tsx (26.3
 * Phase 8), shared with the graph inspector; re-exported here so the
 * layers panel's imports read the way they always have. */
export { ExportTick };

function OpacityRow({
  id,
  opacity,
  dispatch,
  width = 90,
}: {
  id: string;
  opacity: number;
  dispatch: D;
  width?: number;
}) {
  return (
    <>
      <div
        className="strack-flex"
        style={{ width, flex: "none", minWidth: 0 }}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <TrackSlider
          label="Layer opacity"
          lo={0}
          hi={100}
          step={1}
          testid={`art-opacity-${id}`}
          value={opacity}
          onChange={(v) => dispatch({ type: "art_layer_set", id, opacity: v })}
          onBegin={() => dispatch({ type: "begin_gesture", key: `${id}.artopacity` })}
          onEnd={() => dispatch({ type: "end_gesture" })}
        />
      </div>
      <div style={{ width: 26, flex: "none" }}>
        <ValueField
          param="layer opacity"
          value={opacity}
          lo={0}
          hi={100}
          display={(v) => String(Math.round(v))}
          testid={`art-opacity-value-${id}`}
          onCommit={(v) => dispatch({ type: "art_layer_set", id, opacity: v })}
        />
      </div>
    </>
  );
}

export function ArtLayersTab({ state, dispatch, width }: { state: State; dispatch: D; /** the panel's width, so a layer's depth Levels scales with it */ width?: number }) {
  // Every hook before the drilled-gradient return below: a hook after
  // a conditional return drops out of the count when the branch flips.
  // Which of the toolbar's new-layer menus is open; the empty list opens
  // the same ones.
  const [newMenu, setNewMenu] = useState<NewMenu | null>(null);
  // The empty list's right-click menu: the same new-layer seats.
  const [emptyMenu, setEmptyMenu] = useState<{ x: number; y: number } | null>(null);
  const emptyMenuRef = useDismiss<HTMLDivElement>(emptyMenu !== null, () => setEmptyMenu(null));
  // Bottom-up in the graph, top-down on screen.
  const ordered = artLayers(state);
  // Drilled into a gradient: the stops take the panel and the stack
  // steps aside, the way opening a group takes the graph.
  const drilled = ordered.find(
    (l) => l.blend.id === state.artGradientEdit && l.content.type === "heeler.gradient",
  );
  const layers = [...ordered].reverse();
  const active = state.artActive;
  const selected = state.artSelected;
  // The picture's own selection, if there is one. Offering "mask from
  // selection" with nothing selected would be a button that could only
  // disappoint.
  const [openGroups, setOpenGroups] = useState<Set<string>>(new Set());
  // The layers opened with their disclosure chevron while Expand settings
  // on select is off. Each stays open until its own chevron closes it:
  // selecting another layer leaves it alone (2026-09-30: an edit button
  // "so layers aren't expanding and collapsing all the time").
  const [openSettings, setOpenSettings] = useState<Set<string>>(new Set());
  const toggleSettings = (id: string) =>
    setOpenSettings((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  // A Warp layer's settings are its edit mode (2026-09-30: "when the
  // layer is expanded it should just turn on warp editing. Turn warp
  // editing off when collapsed"): its chevron opens them and arms the
  // warp on the canvas, the layer selected first so nothing else takes
  // the tool back off it, and closes them and puts the warp down (a
  // commit, as Enter). `shown` is whether they show now, which an edit
  // mode armed elsewhere (the graph inspector) opens too.
  const toggleLayerSettings = (l: { blend: NodeCard; content: NodeCard }, shown: boolean) => {
    const id = l.blend.id;
    if (l.content.type !== LAYER_WARP) {
      toggleSettings(id);
      return;
    }
    setOpenSettings((prev) => {
      const next = new Set(prev);
      if (shown) next.delete(id);
      else next.add(id);
      return next;
    });
    if (!shown && active !== id) dispatch({ type: "select_art_layer", id });
    dispatch({ type: "art_warp_edit", id: l.content.id, on: !shown });
  };
  // Another photograph or Take puts the warp down (the reducer), so its
  // Warp layers close with it: open, a Warp layer is being edited, and
  // one left open over a warp put down would say otherwise. The layers
  // that were Warp layers on the way out are the ones closed.
  const scene = `${state.activeImage}|${state.activeTakes[state.activeImage] ?? ""}`;
  const warpRows = useRef<string[]>([]);
  useEffect(() => {
    const leaving = warpRows.current;
    if (leaving.length) setOpenSettings((prev) => (leaving.some((id) => prev.has(id)) ? new Set([...prev].filter((id) => !leaving.includes(id))) : prev));
  }, [scene]);
  useEffect(() => {
    warpRows.current = ordered.filter((l) => l.content.type === LAYER_WARP).map((l) => l.blend.id);
  });
  // Open is armed for the selected Warp layer, by whatever door its
  // settings came open (2026-10-01: "bake dialog and backup switch did not
  // bring back the ellipse": Unbake put the Warp layer back in a row whose
  // settings were open, and nothing armed it). The chevron and a click arm
  // on their own event; this catches every door that has none: Unbake, the
  // undo of a bake, a redo, the Layer menu's selection, a Duplicate, a
  // paste, a Take switched back and a reload. Only when the selected Warp
  // layer comes open, so after Enter or Escape the settings stay open and
  // the warp stays down until the chevron or a reselect arms it again. A
  // Take or photograph switch closes the chevron's Warp rows (above), so a
  // move of scene arms only where Expand settings on select keeps the
  // settings open.
  const armedKey = useRef<string | null>(null);
  const armedScene = useRef(scene);
  useEffect(() => {
    const moved = armedScene.current !== scene;
    armedScene.current = scene;
    const l = ordered.find((x) => x.blend.id === active);
    const open = !!l && l.content.type === LAYER_WARP && (state.layerExpandOnSelect || (!moved && openSettings.has(l.blend.id)));
    const key = open ? `${scene}|${l!.blend.id}|${l!.content.id}` : null;
    const was = armedKey.current;
    armedKey.current = key;
    if (key !== null && key !== was && !warpEditing(state, l!.content.id)) dispatch({ type: "art_warp_edit", id: l!.content.id, on: true });
  });
  // The right-click menu, and the rename it can start. "I
  // think a lot of this could be handled with context menus for the
  // layers and groups. And add to the contex menu the ability to rename
  // layers."
  const [menu, setMenu] = useState<{ x: number; y: number; id: string } | null>(null);
  const menuRef = useDismiss<HTMLDivElement>(menu !== null, () => setMenu(null));
  const [renaming, setRenaming] = useState<string | null>(null);
  const openMenu = (e: React.MouseEvent, id: string) => {
    e.preventDefault();
    e.stopPropagation();
    // Right-clicking a row that is not selected selects it first: a menu
    // that acts on something other than what you aimed at is a trap.
    if (!selected.includes(id)) dispatch({ type: "select_art_layer", id });
    setMenu({ x: e.clientX, y: e.clientY, id });
  };

  const pick = (e: React.MouseEvent, id: string) => {
    if (e.ctrlKey || e.metaKey) {
      const next = selected.includes(id)
        ? selected.filter((x) => x !== id)
        : [...selected, id];
      dispatch({ type: "select_art_layers", ids: next });
    } else if (e.shiftKey && active) {
      // Range over the displayed top-level order.
      const ids = layers.map((l) => l.blend.id);
      const a = ids.indexOf(active);
      const b = ids.indexOf(id);
      if (a >= 0 && b >= 0) {
        const [lo, hi] = a < b ? [a, b] : [b, a];
        dispatch({ type: "select_art_layers", ids: ids.slice(lo, hi + 1) });
        return;
      }
      dispatch({ type: "select_art_layer", id });
    } else {
      dispatch({ type: "select_art_layer", id });
      // Selecting a Warp layer whose settings its chevron left open
      // opens them onto it again, so it is the warp being edited (with
      // Expand settings on select on, the reducer does this for every
      // selection).
      const l = ordered.find((x) => x.blend.id === id);
      if (l && id !== active && !state.layerExpandOnSelect && l.content.type === LAYER_WARP && openSettings.has(id)) {
        dispatch({ type: "art_warp_edit", id: l.content.id, on: true });
      }
    }
  };

  const activeLayer = ordered.find((l) => l.blend.id === active);
  // The reducer's own rule, not a second opinion on it. This used to
  // skip the contiguity test, so the button was live for selections
  // art_group_layers then refused without a word, and it barred masked
  // layers long after grouping learned to carry a mask across.
  const groupable = canGroupLayers(state, selected);

  // The drilled gradient view, after every hook above it: an early
  // return ahead of the hooks meant the drilled render called fewer of
  // them, which React tolerated only while that branch called none.
  if (drilled) {
    const set = (param: string, value: number | string) =>
      dispatch({ type: "art_content_set", id: drilled.blend.id, param, value });
    return (
      <div style={{ display: "flex", flexDirection: "column", minHeight: 0, flex: 1 }}>
        <GradientPanel
          layerName={drilled.blend.name}
          stops={readStops(drilled.content.textParams, drilled.content.params)}
          onChange={(next) => set("stops", JSON.stringify(next))}
          onBack={() => dispatch({ type: "art_edit_gradient", id: null })}
          onSimple={() => {
            // Clearing the list hands the engine back to the two-color
            // params it never stopped carrying.
            set("stops", "");
            dispatch({ type: "art_edit_gradient", id: null });
          }}
          dispatch={dispatch}
          testid={`art-grad-${drilled.blend.id}`}
          tone={isByTone(drilled.content.textParams)}
        />
        <BrushPanel state={state} dispatch={dispatch} />
      </div>
    );
  }
  return (
    <div style={{ display: "flex", flexDirection: "column", minHeight: 0, flex: 1 }}>
    <div data-testid="art-layers" style={{ padding: "10px 12px", display: "flex", flexDirection: "column", gap: 8, minHeight: 0, overflowY: "auto", flex: 1 }}>
      <FinishToolbar
        state={state}
        dispatch={dispatch}
        menu={newMenu}
        setMenu={setNewMenu}
        actions={
          <>
            {/* One slot: a group cannot hold another group, so when one
                is selected the only thing this position can mean is
                ungroup. */}
            {activeLayer?.content.isGroup ? (
              <IconButton
                testid="art-ungroup"
                label="Ungroup"
                hint="Dissolve the group; its layers return to the stack"
                onClick={() => active && dispatch({ type: "art_ungroup", id: active })}
                glyph={ICONS.ungroup}
              />
            ) : (
              <IconButton
                testid="art-group"
                label="Group layers"
                hint="Group the selected layers: they composite together, then blend onto the photo as one unit"
                disabled={!groupable}
                onClick={() => dispatch({ type: "art_group_layers", ids: selected })}
                glyph={ICONS.group}
              />
            )}
            <IconButton
              testid="art-delete"
              label="Delete layer"
              hint="Delete the selected layer"
              disabled={!active}
              onClick={() => active && dispatch({ type: "art_remove_layer", id: active })}
              glyph={ICONS.trash}
            />
          </>
        }
      />

      {layers.length === 0 && (
        <div
          onContextMenu={(e) => {
            e.preventDefault();
            setEmptyMenu({ x: e.clientX, y: e.clientY });
          }}
        >
          <FinishEmptyList state={state} dispatch={dispatch} openMenu={setNewMenu} />
        </div>
      )}

      <div>
      {layers.map((l, at) => {
        const isActive = l.blend.id === active;
        const isSelected = selected.includes(l.blend.id);
        const isGroup = !!l.content.isGroup;
        const open = openGroups.has(l.content.id);
        // Mode, opacity, the mask and what is editing it are all
        // LayerControls' business now: it works them out from the
        // carrier, so a member and a top-level layer cannot end up
        // reading them differently.
        const clipped = (l.blend.params.clip ?? 0) !== 0;
        const collapsible = layerCollapsible(l);
        const settingsOpen = layerSettingsOpen(state, l, isActive, openSettings.has(l.blend.id));
        return (
          <div
            key={l.blend.id}
            data-settings={collapsible ? (settingsOpen ? "open" : "closed") : undefined}
            data-testid={`art-layer-${l.blend.id}`}
            data-active={isActive}
            data-selected={isSelected}
            onMouseDown={(e) => pick(e, l.blend.id)}
            onContextMenu={(e) => openMenu(e, l.blend.id)}
            style={{
              // A clipped layer indents toward the base it shows
              // through, the convention every editor shares and the one
              // thing about clipping worth copying exactly.
              marginLeft: clipped ? 14 : 0,
              border: `1px solid ${isActive ? "var(--accent)" : isSelected ? "var(--accent-dim)" : "var(--line-4)"}`,
              background: isActive ? "#172024" : isSelected ? "#181d20" : "var(--bg-row)",
              padding: "7px 9px",
              display: "flex",
              flexDirection: "column",
              gap: 6,
              cursor: "default",
            }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: 7 }}>
              {isGroup && (
                <button
                  style={{ all: "unset", cursor: "pointer", width: 10, color: "var(--text-faint)" }}
                  data-testid={`art-open-${l.blend.id}`}
                  aria-label={open ? "Collapse group" : "Expand group"}
                  onClick={(e) => {
                    e.stopPropagation();
                    setOpenGroups((prev) => {
                      const next = new Set(prev);
                      if (next.has(l.content.id)) next.delete(l.content.id);
                      else next.add(l.content.id);
                      return next;
                    });
                  }}
                >
                  <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" style={{ transform: open ? "none" : "rotate(-90deg)" }}>
                    <path d="M6 9l6 6 6-6" />
                  </svg>
                </button>
              )}
              {/* The settings disclosure, beside the visibility dot (2026-09-30:
"maybe have the edit (collapse/expand button) on the top next to the
visibility so it's not like another tool button"), in the group
chevron's seat and drawn the same way. Only with Expand settings on
select off; a row with nothing to open keeps the chevron's width so
the names line up. A group that carries effects wears it after its
own chevron: that one opens the members, this one the effects.*/}
              {!state.layerExpandOnSelect && (collapsible ? (
                <button
                  style={{ all: "unset", cursor: "pointer", width: 10, color: "var(--text-faint)" }}
                  data-testid={`art-settings-${l.blend.id}`}
                  aria-label={settingsOpen ? "Hide settings" : "Show settings"}
                  aria-expanded={settingsOpen}
                  data-tip={settingsOpen ? "Hide settings" : "Show settings"}
                  data-hint={
                    l.content.type === LAYER_WARP
                      ? settingsOpen
                        ? "Hide settings: keeps the warp and puts its handles away (Enter does the same, Escape puts the warp back)"
                        : "Show settings: edit the warp on the canvas, with a grid or shapes, and see its controls here"
                      : settingsOpen
                        ? "Hide settings: the row goes back to its compact height"
                        : "Show settings: this layer's controls open under its row and stay open while you select other layers"
                  }
                  onClick={(e) => {
                    e.stopPropagation();
                    toggleLayerSettings(l, settingsOpen);
                  }}
                >
                  <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" style={{ transform: settingsOpen ? "none" : "rotate(-90deg)" }}>
                    <path d="M6 9l6 6 6-6" />
                  </svg>
                </button>
              ) : (
                !isGroup && <span data-testid={`art-settings-none-${l.blend.id}`} aria-hidden="true" style={{ width: 10, flex: "none" }} />
              ))}
              {clipped && (
                <span
                  data-testid={`art-clip-mark-${l.blend.id}`}
                  aria-label="Clipped to the layer below"
                  data-hint="Shows only where the layer below has pixels (Layer menu to release)"
                  style={{ color: "var(--text-ghost)", fontSize: 10, lineHeight: 1 }}
                >
                  ⤵
                </span>
              )}
              <VisibilityDot id={l.blend.id} enabled={l.blend.enabled} dispatch={dispatch} />
              <ExportTick
                id={l.blend.id}
                exported={l.exported}
                adjust={!!ART_KINDS[l.content.artKind ?? ""]?.adjust || l.content.type === LAYER_WARP}
                dispatch={dispatch}
              />

              <LayerName
                id={l.blend.id}
                name={l.blend.name}
                enabled={l.blend.enabled}
                size={11}
                renaming={renaming === l.blend.id}
                onDone={() => setRenaming(null)}
                dispatch={dispatch}
              />
              {/* A closed Fill row's color, as a chip that only opens the settings
(2026-09-30: "instead of having the pop up color swatch the layer could
be collapsible/expandable"); the color itself is set in the open
settings.*/}
              {l.content.type === "heeler.fill" && !settingsOpen && (
                <button
                  data-testid={`art-fill-chip-${l.blend.id}`}
                  data-value={l.content.textParams?.color ?? "#808080"}
                  aria-label="Fill color: show settings"
                  data-hint="The fill's color; click to open its settings and change it"
                  onClick={(e) => {
                    if (state.layerExpandOnSelect) return;
                    e.stopPropagation();
                    toggleSettings(l.blend.id);
                  }}
                  style={{
                    all: "unset",
                    cursor: "pointer",
                    width: 14,
                    height: 11,
                    flex: "none",
                    background: l.content.textParams?.color ?? "#808080",
                    boxShadow: "inset 0 0 0 1px rgba(255,255,255,.12)",
                  }}
                />
              )}
              <button
                className="chip"
                data-testid={`art-up-${l.blend.id}`}
                aria-label="Move layer up"
                // Up on screen is later in the render order.
                disabled={at === 0}
                style={{ fontSize: 9, padding: "0 5px" }}
                onClick={(e) => {
                  e.stopPropagation();
                  dispatch({ type: "art_move_layer", id: l.blend.id, delta: 1 });
                }}
              >
                ▲
              </button>
              <button
                className="chip"
                data-testid={`art-down-${l.blend.id}`}
                aria-label="Move layer down"
                disabled={at === layers.length - 1}
                style={{ fontSize: 9, padding: "0 5px" }}
                onClick={(e) => {
                  e.stopPropagation();
                  dispatch({ type: "art_move_layer", id: l.blend.id, delta: -1 });
                }}
              >
                ▼
              </button>
            </div>
            <LayerControls
              layer={l}
              active={isActive}
              open={settingsOpen}
              onEffectAdded={() =>
                setOpenSettings((prev) => (prev.has(l.blend.id) ? prev : new Set(prev).add(l.blend.id)))
              }
              state={state}
              dispatch={dispatch}
              width={width}
            />
            {isGroup && open && (
              <div style={{ display: "flex", flexDirection: "column", gap: 4, paddingLeft: 14, borderLeft: "1px solid var(--line-2)" }}>
                {[...artGroupMembers(l.content)].reverse().map((m) => (
                  <MemberRow
                    key={m.merge.id}
                    member={m}
                    active={m.merge.id === active}
                    state={state}
                    dispatch={dispatch}
                    onMenu={openMenu}
                    renaming={renaming}
                    onRenamed={() => setRenaming(null)}
                    width={width}
                  />
                ))}
              </div>
            )}
          </div>
        );
      })}
      </div>
    </div>
    <BrushPanel state={state} dispatch={dispatch} />
    {emptyMenu && layers.length === 0 && (
      <NewLayerMenu
        state={state}
        dispatch={dispatch}
        at={emptyMenu}
        menuRef={emptyMenuRef}
        onClose={() => setEmptyMenu(null)}
      />
    )}
    {menu && (
      <LayerMenu
        state={state}
        dispatch={dispatch}
        at={menu}
        id={menu.id}
        menuRef={menuRef}
        onRename={(id) => setRenaming(id)}
        onClose={() => setMenu(null)}
        onOpenGroup={(gid) =>
          setOpenGroups((prev) => {
            const next = new Set(prev);
            next.add(gid);
            return next;
          })
        }
      />
    )}
    </div>
  );
}

/** The width the layer menu reserves, for clampMenu. */
const LAYER_MENU_W = 194;

/** The empty stack's right-click menu: the toolbar's seats in the
 * toolbar's order, Adjustment and Image folding out the way the menu
 * bar's New Finish Layer does. */
function NewLayerMenu({
  state,
  dispatch,
  at,
  menuRef,
  onClose,
}: {
  state: State;
  dispatch: D;
  at: { x: number; y: number };
  menuRef: React.RefObject<HTMLDivElement>;
  onClose: () => void;
}) {
  const z =
    parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--chrome-zoom")) || 1;
  const vp = viewportSize();
  const p = clampMenu(
    { x: at.x / z, y: at.y / z },
    { w: LAYER_MENU_W, h: 30 + 6 * 22 },
    { w: vp.w / z, h: vp.h / z },
  );
  const entry = (it: { id: string; label: string; hint: string; run: (s: State, d: D) => void }, testid: string) => (
    <div key={testid} data-hint={it.hint}>
      <button
        data-testid={testid}
        onClick={() => {
          onClose();
          it.run(state, dispatch);
        }}
      >
        {it.label}
      </button>
    </div>
  );
  return (
    <div
      ref={menuRef}
      className="ctx-menu"
      data-testid="art-new-menu"
      style={{ position: "fixed", width: LAYER_MENU_W, left: p.x, top: p.y, zIndex: 60 }}
      onMouseDown={(e) => e.stopPropagation()}
    >
      {contentItems().map((it) => entry(it, `art-new-${it.id}`))}
      <div className="sep" />
      <LayerSubMenu label="Adjustment layer" testid="art-new-adjust">
        {adjustmentItems().map((it) => entry(it, `art-new-adjust-${it.id}`))}
        <div className="sep" />
        <div className="hd">UTILITY</div>
        {UTILITY_ITEMS.map((it) => entry(it, `art-new-${it.id}`))}
      </LayerSubMenu>
      <LayerSubMenu label="Image layer" testid="art-new-image">
        {IMAGE_ITEMS.map((it) => entry(it, `art-new-image-${it.id}`))}
      </LayerSubMenu>
    </div>
  );
}

/** Everything you can do to one layer, where you are pointing at it.
 *
 * "I think a lot of this could be handled with context
 * menus for the layers and groups. And add to the contex menu the
 * ability to rename layers."
 *
 * One menu for both kinds of row. What it offers is worked out from
 * where the layer LIVES rather than from which row called it: a member
 * gets Remove from Group, a top-level layer gets Add to Group with the
 * groups that exist, and a group gets Ungroup. Everything here is
 * mirrored in the Layer menu (ui/chrome.tsx), which acts on the active
 * layer instead of the pointed-at one.
 */
function LayerMenu({
  state,
  dispatch,
  at,
  id,
  menuRef,
  onRename,
  onClose,
  onOpenGroup,
}: {
  state: State;
  dispatch: D;
  at: { x: number; y: number };
  id: string;
  menuRef: React.RefObject<HTMLDivElement>;
  onRename: (id: string) => void;
  onClose: () => void;
  onOpenGroup: (groupId: string) => void;
}) {
  const acts = layerActions(state, id);
  const z =
    parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--chrome-zoom")) || 1;
  const vp = viewportSize();
  const p = clampMenu(
    { x: at.x / z, y: at.y / z },
    { w: LAYER_MENU_W, h: 30 + acts.length * 22 },
    { w: vp.w / z, h: vp.h / z },
  );
  return (
    <div
      ref={menuRef}
      className="ctx-menu"
      data-testid="art-layer-menu"
      style={{ position: "fixed", width: LAYER_MENU_W, left: p.x, top: p.y, zIndex: 60 }}
      onMouseDown={(e) => e.stopPropagation()}
    >
      {acts.map((a, i) => {
        if (a.kind === "sep") return <div key={`sep${i}`} className="sep" />;
        const fire = (item: LayerActionItem) => {
          if (item.testid === "art-menu-rename") onRename(id);
          else item.run(dispatch);
          if (item.opensGroup) onOpenGroup(item.opensGroup);
          onClose();
        };
        // The hint goes on a WRAPPER, never on the button.
        //
        // A disabled button fires no mouse events, so a data-hint
        // written on it is precisely the hint nobody can read, and a
        // grayed item is the one that most needs to explain itself
        // ("inform the user on the context it is enabled
        // so there is direction, guidance"). The event lands on this
        // div instead, and the enabled case finds it by walking up.
        const hint = layerActionHint(a);
        if (a.kind === "submenu") {
          return (
            <div key={a.testid} data-hint={hint}>
              <LayerSubMenu label={a.label} testid={a.testid} disabled={a.disabled}>
                {a.items.map((child) => (
                  <button key={child.testid} data-testid={child.testid} onClick={() => fire(child)}>
                    {child.label}
                  </button>
                ))}
              </LayerSubMenu>
            </div>
          );
        }
        return (
          <div key={a.testid} data-hint={hint}>
            <button data-testid={a.testid} disabled={a.disabled} onClick={() => fire(a)}>
              {a.label}
            </button>
          </div>
        );
      })}
    </div>
  );
}

/** The brush settings, under the stack.
 *
 * "The preferences for each brush tip should be in a lower
 * panel in the FINISH tab. A split that is bottom weighted so its well
 * below the layer list." It is the same component the Develop panel
 * uses for mask brushes, not a copy: one brush engine, one set of
 * controls, so a tip tuned here paints the same everywhere. Collapses
 * to a bar when the stack needs the room, which is the pattern the rest
 * of the app uses for a panel that is not always wanted.*/
function BrushPanel({ state, dispatch }: { state: State; dispatch: D }) {
  const [open, setOpen] = useState(true);
  const polishing = state.tool === "polish";
  const painting =
    polishing ||
    state.tool === "paint" ||
    state.tool === "clone" ||
    state.tool === "heal" ||
    state.tool === "dodge" ||
    state.tool === "burn" ||
    // The eraser is a brush like any other, so its settings live where
    // every brush's settings live. So is blur, which additionally wants
    // its own strength: how far out of focus, as against how much of the
    // result lands, which are two questions and were one control. Blend
    // needs only the shared settings: size, softness and how much lands.
    state.tool === "erase" ||
    state.tool === "blur" ||
    state.tool === "blend" ||
    state.tool === "brush";
  const tip = BRUSH_TIPS.find((b) => b.id === (state.brushTip ?? "circle"));
  // Tool settings belong to the tool. "I noticed tool settings
  // for Brush persist in the right panel even when I have the layer select
  // (cursor) tool." The flag above was computed and then never used, so
  // the panel sat there whatever was in hand, advertising settings for a
  // tool that was not running.
  if (!painting) return null;
  return (
    <div
      data-testid="art-brush-panel"
      style={{
        // Size to the content, shrinking only when the stack above genuinely
        // needs the room; the inner div scrolls then. This was flex:none plus
        // maxHeight:52%, which capped the panel at half the column even with
        // the rest of the column empty, and the Tip row sat cut off under the
        // cap. "It's not computing the space needed to display all
        // controls correctly as some elements are being cut off."
        flex: "0 1 auto",
        borderTop: "1px solid var(--line-2)",
        background: "var(--bg-panel-head)",
        display: "flex",
        flexDirection: "column",
        // Never below the header: collapsed to a bar, the toggle stays
        // whole and clickable.
        minHeight: 28,
      }}
    >
      <button
        data-testid="art-brush-toggle"
        aria-expanded={open}
        data-hint="The brush settings for painting, cloning, healing and masks"
        onClick={() => setOpen((v) => !v)}
        style={{
          all: "unset", cursor: "pointer", display: "flex", alignItems: "center", gap: 6,
          padding: "6px 12px", flex: "none",
        }}
      >
        <svg width="8" height="8" viewBox="0 0 24 24" fill="none" stroke="var(--text-faint)" strokeWidth="2.6" style={{ transform: open ? "none" : "rotate(-90deg)" }}>
          <path d="M6 9l6 6 6-6" />
        </svg>
        <span className="kicker">{polishing ? "POLISH" : "BRUSH"}</span>
        <span style={{ flex: 1 }} />
        <span style={{ fontSize: 9, color: painting ? "var(--accent)" : "var(--text-ghost)", letterSpacing: ".06em" }}>
          {tip?.label ?? "Round"}
        </span>
      </button>
      {/* No eye row here: the shared settings body below already carries the
ONE [Show Mask][Dab] row, and this panel adding its own put two on
screen. "The Show Mask button appears 3 times... it
should appear once in the settings."*/}
      {open && (state.tool === "dodge" || state.tool === "burn") && (
        <div style={{ padding: "0 12px" }}>
          {/* The same .srow grid as the Radius/Opacity/Softness rows
              below it, because it IS one of them: a row that dressed
              differently from its neighbors read as belonging to
              something else. Not the brush flow, on purpose: dodging
              wants a tenth of what painting wants, and the two would
              fight over one slider. */}
          <div className="srow" style={{ gridTemplateColumns: "78px 1fr 42px" }}>
            <div className="lbl">Strength</div>
            <TrackSlider
              label="Dodge and burn strength"
              lo={1}
              hi={100}
              step={1}
              testid="art-dodge-strength"
              hint="How much one pass lightens or darkens. Low and repeated beats high and once."
              value={state.dodgeStrength}
              onChange={(strength) =>
                dispatch({ type: "set_dodge_strength", strength })
              }
            />
            <ValueField
              param="dodge and burn strength"
              value={state.dodgeStrength}
              lo={1}
              hi={100}
              display={(v) => String(Math.round(v))}
              testid="art-dodge-strength-value"
              onCommit={(strength) =>
                dispatch({ type: "set_dodge_strength", strength: Math.round(strength) })
              }
            />
          </div>
        </div>
      )}
      {open && polishing && (
        <div
          data-testid="art-polish-settings"
          style={{ display: "flex", flexDirection: "column", gap: 6, padding: "2px 12px 8px" }}
        >
          {/* The tool's own settings, where the tool's settings live. The
report: "I feel the polish settings should be in the right panel as
it is technically the active tool." The toolbar keeps them too,
since the hand is down there mid-stroke, but the panel is where you
go to read them.*/}
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <span style={{ fontSize: 9.5, color: "var(--text-faint)", width: 52 }}>Mode</span>
            <MenuField
              testid="polish-panel-mode"
              label="Polish mode"
              hint={POLISH_MODES.find((m) => m.id === state.polishMode)?.hint ?? ""}
              value={state.polishMode}
              options={POLISH_MODES.map((m) => ({ id: m.id, label: m.label }))}
              onChange={(mode) => dispatch({ type: "set_polish_mode", mode })}
              minWidth={96}
            />
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <span style={{ fontSize: 9.5, color: "var(--text-faint)", width: 52 }}>Preview</span>
            <MenuField
              testid="polish-panel-preview"
              label="Preview"
              hint={PREVIEW_MODES.find((m) => m.id === state.polishPreview)?.hint ?? ""}
              value={state.polishPreview}
              options={PREVIEW_MODES.map((m) => ({ id: m.id, label: m.label }))}
              onChange={(mode) => dispatch({ type: "set_polish_preview", mode })}
              minWidth={96}
            />
          </div>
        </div>
      )}
      {open && (
        <div style={{ overflowY: "auto", padding: "0 12px 10px", minHeight: 0 }}>
          <BrushTipPicker state={state} dispatch={dispatch} />
        </div>
      )}
    </div>
  );
}

/** The numeric params an adjustment layer's controls show, by the kind
 * that built it, not by node type: White Balance and Color are the same
 * engine node wearing two hats. */
function adjustParamNames(c: NodeCard): string[] {
  const kind = c.artKind ? ART_KINDS[c.artKind] : undefined;
  return (kind?.show ?? Object.keys(c.params)).filter((k) => typeof c.params[k] === "number");
}

/** Whether the selected layer's strip shows its mask's Show mask eye.
 * One eye on screen: not while the brush is in hand (the brush settings
 * carry it beside the dab). A layer's mask is never a live selection
 * since 2026-09-30, so no selection panel carries one. */
function maskEyeHere(state: State): boolean {
  return state.tool !== "brush";
}

/** A layer's effects as the stack lists them: an image layer's own warp
 * rides the chain ahead of them but is not one (it has its own seat under
 * the layer's transform). */
function layerEffects(layer: { fx?: NodeCard[] }): NodeCard[] {
  return (layer.fx ?? []).filter((f) => !isPictureWarp(f));
}

/** Whether a Finish layer's settings open and close (2026-09-30: the
 * collapsible layers are the Adjustment layers, Warp, Gradient,
 * Image and Fill; then "pixel layers should be collapsible as well.
 * I forgot about layer fx").
 *
 * Every layer that carries effects folds them, whatever its kind: the
 * effects' settings are what a Pixel layer shows under its strip, and
 * the same chevron folds them on a paint layer, a Smart (Isolate) layer
 * or a group. A Smart layer's own dials stay out of it ("Smart layer
 * should not be collapsible"): they show while it is the layer worked,
 * as they always did, and its chevron folds only its effects. With no
 * effects, a Pixel or paint layer, a Smart layer, a group (its own
 * chevron opens the members) and an adjustment with nothing to set
 * (Invert) have nothing to fold, so no chevron. */
export function layerCollapsible(layer: { content: NodeCard; fx?: NodeCard[] }): boolean {
  if (layerEffects(layer).length > 0) return true;
  const c = layer.content;
  if (c.isGroup) return false;
  if (isImageLayer(layer)) return true;
  if (c.type === "heeler.fill" || c.type === "heeler.gradient" || c.type === LAYER_WARP) return true;
  const kind = c.artKind ? ART_KINDS[c.artKind] : undefined;
  if (!kind?.adjust) return false;
  return c.type === "heeler.curves" || adjustParamNames(c).length > 0;
}

/** Whether a layer's settings are open. With Expand settings on select
 * on (2026-09-30: "When on, layer controls auto expand when the layer
 * is selected"), the selected layer's are and the rest close; off,
 * the ones opened with their chevron are, selected or not. A warp
 * being edited on the canvas has its controls open either way. A
 * layer that does not collapse has nothing under its strip to fold,
 * and is "open" while selected, as it always was.*/
export function layerSettingsOpen(
  state: State,
  layer: { blend: NodeCard; content: NodeCard; fx?: NodeCard[] },
  active: boolean,
  opened: boolean,
): boolean {
  if (!layerCollapsible(layer)) return active;
  if (state.layerExpandOnSelect ? active : opened) return true;
  if (layer.content.type === LAYER_WARP) return warpEditing(state, layer.content.id);
  const own = isImageLayer(layer) ? imageLayerWarp(state, layer.blend.id) : undefined;
  return !!own && warpEditing(state, own.id);
}

/** The controls a layer's CONTENT node has, if any. A pixel or retouch
 * layer keeps its work in strokes and shows nothing here; a fill is a
 * color; a gradient is two stops, an angle and a shape. */
function ContentControls({
  layer,
  open,
  state,
  dispatch,
}: {
  layer: { blend: NodeCard; content: NodeCard };
  /** the layer's settings are open (layerSettingsOpen) */
  open: boolean;
  state: State;
  dispatch: D;
}) {
  const id = layer.blend.id;
  const c = layer.content;
  // An image layer: its picture, its transform and its own warp while
  // its settings are open; a missing file is said either way.
  if (isImageLayer(layer)) {
    return <ImageLayerControls layer={layer} active={open} state={state} dispatch={dispatch} />;
  }
  const text = (k: string, fallback: string) => c.textParams?.[k] ?? fallback;
  // A Fill layer's settings: the picker itself, inline, and the color
  // as numbers (2026-09-30: "have both the color picker and color
  // fields (toggle between RGB and CMY)").
  if (c.type === "heeler.fill") {
    if (!open) return null;
    return (
      <FillColorControls
        value={text("color", "#808080")}
        testid={`art-fill-color-${id}`}
        onChange={(hex) => dispatch({ type: "art_content_set", id, param: "color", value: hex })}
        onBegin={() => dispatch({ type: "begin_gesture", key: `${id}.color` })}
        onEnd={() => dispatch({ type: "end_gesture" })}
      />
    );
  }
  if (c.type === "heeler.gradient") {
    if (!open) return null;
    return (
      <GradientControls
        testid={id}
        params={c.params}
        text={c.textParams}
        set={(param, value) => dispatch({ type: "art_content_set", id, param, value })}
        onAdvanced={() => dispatch({ type: "art_edit_gradient", id })}
        dispatch={dispatch}
      />
    );
  }
  // An adjustment layer's controls are the node's own, shown only while
  // the layer's settings are open: seven exposure sliders under every
  // row would bury the stack they belong to.
  if (!open) return null;
  // A Warp layer: the Type and that type's own controls. Opening them
  // armed the warp on the canvas (toggleLayerSettings, or the reducer
  // with Expand settings on select); after Enter or Escape put it down
  // they stay open until the layer closes.
  if (c.type === LAYER_WARP) return <FinishWarpControls state={state} dispatch={dispatch} target={c.id} open />;
  if (!ART_KINDS[c.artKind ?? ""]?.adjust) return null;
  return <div data-testid={`art-adjust-${id}`}><FinishAdjustmentControls node={c} state={state} dispatch={dispatch} carrierId={id} /></div>;
}

/** A layer's effects: a chip to add one, then a row each.
 *
 * Every effect is derived from the layer's ALPHA, so a paint layer gets
 * a shadow without anyone drawing one. The list is nodes on a chain
 * rather than a layer editor's fixed menu behind a modal: two glows at
 * different radii is a normal thing to want, an outline before a shadow
 * is a different picture from one after, and both are just ordering.
 */
function FxRow({
  layer,
  active,
  dispatch,
}: {
  layer: { blend: NodeCard; content: NodeCard; fx: NodeCard[] };
  active: boolean;
  dispatch: D;
}) {
  const id = layer.blend.id;
  const fx = layerEffects(layer);
  if (fx.length === 0) return null;
  // One readout column for every effect on the layer, so the tracks
  // line up from one effect to the next.
  const readout = Math.max(...fx.map(fxReadoutChars));
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
      {fx.map((f, i) => (
        <FxItem
          key={f.id}
          fx={f}
          layerId={id}
          index={i}
          count={fx.length}
          expanded={active}
          readout={readout}
          dispatch={dispatch}
        />
      ))}
    </div>
  );
}

/** The button that adds an effect, and the list it opens.
 *
 * Its own component now so it can sit in the action row beside the mask
 * button rather than in the effects column below it. */
function FxAddButton({
  layer,
  onAdded,
  dispatch,
}: {
  layer: { blend: NodeCard; content: NodeCard; fx: NodeCard[] };
  /** an effect was added: the layer's settings open, so the new effect
   * shows its controls rather than a folded name */
  onAdded?: () => void;
  dispatch: D;
}) {
  const [open, setOpen] = useState(false);
  const root = useDismiss<HTMLDivElement>(open, () => setOpen(false));
  const id = layer.blend.id;
  return (
    <div ref={root} style={{ position: "relative", display: "flex" }}>
      <IconButton
        testid={`art-fx-add-${id}`}
        label="Add effect"
        active={open}
        hint="Effects derived from this layer's shape: shadow, glow, overlays, bevel, blur"
        glyph={ICONS.fx}
        plus
        onClick={(e) => {
          e?.stopPropagation();
          setOpen((v) => !v);
        }}
      />
      {open && (
        <div
          data-testid={`art-fx-menu-${id}`}
          onMouseDown={(e) => e.stopPropagation()}
          style={{
            position: "absolute", top: "calc(100% + 4px)", left: 0, zIndex: 40, minWidth: 140,
            background: "#191817", border: "1px solid var(--line-4)",
            boxShadow: "0 6px 18px rgba(0,0,0,.5)", padding: 3,
            display: "flex", flexDirection: "column",
          }}
        >
          {/* The signpost for the trap the owner walked into: "I applied a color
overlay to a pixel layer and it does not work." FX transform the
layer's own pixels, so on an unpainted Pixel layer every one of
them is invisible: say so at the door instead of letting the menu
promise nothing.*/}
          {layer.content.type === "heeler.paint" && (layer.content.strokes ?? []).length === 0 && (
            <div
              data-testid={`art-fx-empty-note-${id}`}
              style={{
                fontSize: 9.5, color: "var(--text-faint)", padding: "3px 7px 5px",
                lineHeight: 1.4, maxWidth: 170, borderBottom: "1px solid var(--line-4)",
                marginBottom: 2,
              }}
            >
              Effects shape this layer's own pixels, and this layer has none yet. Paint
              something first; until then any effect here shows nothing.
            </div>
          )}
          {Object.entries(ART_FX).map(([k, spec]) => (
            <button
              key={k}
              data-testid={`art-fx-pick-${k}`}
              onClick={() => {
                dispatch({ type: "art_add_fx", id, fx: k });
                setOpen(false);
                onAdded?.();
              }}
              style={{ all: "unset", cursor: "pointer", fontSize: 10.5, padding: "3px 7px", color: "var(--text-body)" }}
            >
              {spec.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/** An effect dial's readout: an angle in whole degrees ("+135\u00b0"),
 * since its slider steps by one and a tenth of a degree only made the
 * text longer than its seat; every other dial as the house field reads
 * it. */
export function fxReadout(param: string, v: number): string {
  if (param === "angle") return (v >= 0 ? "+" : "\u2212") + Math.abs(Math.round(v)) + "\u00b0";
  return valueText(param, v);
}

/** The effect dials an effect shows, in order (Inner is a switch). */
function fxDials(fx: NodeCard): string[] {
  const spec = Object.values(ART_FX).find(f => f.type === fx.type);
  return Object.keys(spec?.params ?? fx.params).filter(k => k !== "inner");
}

/** How many characters an effect's readout seat holds: the widest of its
 * dials' readouts at either end of the slider and at the value it holds
 * now. In the owner's screenshot the Angle read "+135." with the rest
 * cut off: a 34px seat for a seven-character "+135.0\u00b0".*/
export function fxReadoutChars(fx: NodeCard): number {
  let widest = 0;
  for (const param of fxDials(fx)) {
    const [lo, hi] = paramRange(param, fx.type);
    for (const v of [lo, hi, fx.params[param] ?? 0]) widest = Math.max(widest, fxReadout(param, v).length);
  }
  return widest;
}

/** The readout seat's width for that many characters: one ch each (the
 * field's own 11px, so the ch is its digits' width under tabular
 * figures, and the sign and degree mark are no wider), plus the field's
 * 2px padding and 1px border either side. In ch, so it scales with the
 * text at every UI zoom. */
export function fxReadoutWidth(chars: number): string {
  return `calc(${chars}ch + 6px)`;
}

function FxItem({
  fx,
  layerId,
  index,
  count,
  expanded,
  readout,
  dispatch,
}: {
  fx: NodeCard;
  layerId: string;
  index: number;
  count: number;
  expanded: boolean;
  /** the readout seat's width in characters (fxReadoutChars, widest of
   * the layer's effects) */
  readout: number;
  dispatch: D;
}) {
  return (
    <div
      data-testid={`art-fx-${fx.id}`}
      onMouseDown={(e) => e.stopPropagation()}
      style={{
        marginLeft: 12,
        paddingLeft: 7,
        display: "flex",
        flexDirection: "column",
        gap: 3,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
        <VisibilityDot
          id={fx.id}
          enabled={fx.enabled}
          dispatch={dispatch}
          onToggle={(enabled) => dispatch({ type: "art_fx_enable", fxId: fx.id, enabled })}
        />
        <span style={{ flex: 1, fontSize: 11, color: fx.enabled ? "var(--text-body)" : "var(--text-ghost)" }}>
          {fx.name}
        </span>
        {expanded && (
          <>
            <button
              className="chip"
              data-testid={`art-fx-up-${fx.id}`}
              aria-label="Move effect earlier"
              disabled={index === 0}
              style={{ fontSize: 11, padding: "0 4px" }}
              onClick={() => dispatch({ type: "art_fx_move", id: layerId, fxId: fx.id, delta: -1 })}
            >
              ▲
            </button>
            <button
              className="chip"
              data-testid={`art-fx-down-${fx.id}`}
              aria-label="Move effect later"
              disabled={index === count - 1}
              style={{ fontSize: 11, padding: "0 4px" }}
              onClick={() => dispatch({ type: "art_fx_move", id: layerId, fxId: fx.id, delta: 1 })}
            >
              ▼
            </button>
            <button
              className="chip"
              data-testid={`art-fx-remove-${fx.id}`}
              aria-label="Remove effect"
              style={{ fontSize: 11, padding: "0 4px" }}
              onClick={() => dispatch({ type: "art_remove_fx", id: layerId, fxId: fx.id })}
            >
              ✕
            </button>
          </>
        )}
      </div>
      {expanded && <FxSettings fx={fx} readout={readout} dispatch={dispatch} />}
    </div>
  );
}

export function FxSettings({ fx, dispatch, readout = fxReadoutChars(fx) }: { fx: NodeCard; dispatch: D; readout?: number }) {
  const [stopsOpen, setStopsOpen] = useState(false);
  const kind = fx.artKind ?? Object.keys(ART_FX).find(k => ART_FX[k].type === fx.type) ?? "";
  const set = (param: string, value: number | string) =>
    dispatch(typeof value === "number" ? { type: "set_param", id: fx.id, param, value } : { type: "set_text_param", id: fx.id, param, value });
  const swatch = (k: string, fallback: string, label: string) => (
    <div data-param={k}><ColorField
      value={fx.textParams?.[k] ?? fallback}
      onChange={(hex) => set(k, hex)}
      label={label}
      testid={`art-fx-color-${fx.id}-${k}`}
      width={22}
      onBegin={() => dispatch({ type: "begin_gesture", key: `${fx.id}.${k}` })}
      onEnd={() => dispatch({ type: "end_gesture" })}
    /></div>
  );
  return (
        <div data-testid={`art-fx-settings-${fx.id}`} data-node={fx.id} style={{ display: "flex", flexDirection: "column", gap: 2 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 5 }}>
            {kind === "bevel" ? (
              <>
                {swatch("highlight", "#ffffff", "Bevel highlight")}
                {swatch("shadow", "#000000", "Bevel shadow")}
              </>
            ) : kind === "gradient_overlay" ? (
              <>
                {swatch("color_a", "#000000", "Gradient start")}
                {swatch("color_b", "#ffffff", "Gradient end")}
              </>
            ) : kind === "blur" ? null : (
              swatch("color", "#000000", `${fx.name} color`)
            )}
            {kind === "gradient_overlay" && <>
              <MenuField testid={`art-fx-shape-${fx.id}`} label="Gradient shape" node={fx.id} param="shape" size="regular"
                value={fx.textParams?.shape ?? "linear"} options={FX_GRADIENT_SHAPES} fitLabels={FX_GRADIENT_SHAPES.map((s) => s.label)}
                onChange={(value) => set("shape", value)} />
              <button className="chip" data-param="stops" style={{ fontSize: 11 }} onClick={() => setStopsOpen(true)} data-hint="Edit every color stop in this overlay">Stops</button>
            </>}
            {kind === "blur" && (
              <MenuField
                testid={`art-fx-kind-${fx.id}`}
                label="Blur type"
                node={fx.id}
                param="kind"
                size="regular"
                value={fx.textParams?.kind ?? "gaussian"}
                options={FX_BLUR_KINDS}
                fitLabels={FX_BLUR_KINDS.map((k) => k.label)}
                onChange={(value) => set("kind", value)}
              />
            )}
            {ART_FX_INNER.includes(kind) && (
              <MenuField testid={`art-fx-inner-${fx.id}`} label={`${fx.name} placement`} node={fx.id} param="inner" size="regular"
                hint="Inner puts the effect inside the layer's edge; Outer spreads it outside"
                value={(fx.params.inner ?? 0) !== 0 ? "1" : "0"} options={FX_PLACEMENTS} fitLabels={FX_PLACEMENTS.map((p) => p.label)}
                onChange={(value) => set("inner", Number(value))} />
            )}
          </div>
          {stopsOpen && kind === "gradient_overlay" && <GradientPanel layerName={fx.name} stops={readStops(fx.textParams, fx.params)}
            onChange={stops => set("stops", JSON.stringify(stops))} onBack={() => setStopsOpen(false)} onSimple={() => { set("stops", ""); setStopsOpen(false); }}
            dispatch={dispatch} testid={`fx-stops-${fx.id}`} backHint="Close the overlay stop list" />}
          {fxDials(fx).map((param) => {
              const [lo, hi] = paramRange(param, fx.type);
              const value = fx.params[param] ?? paramDefault(param, fx.type);
              return (
                <div key={param} data-node={fx.id} data-param={param} onDoubleClick={() => set(param, ART_FX[kind]?.params[param] ?? paramDefault(param, fx.type))} style={{ display: "flex", alignItems: "center", gap: 6 }}>
                  <span style={{ fontSize: 11, color: "var(--text-faint)", width: 54, textTransform: "capitalize" }}>
                    {param}
                  </span>
                  <div className="strack-flex" style={{ minWidth: 50 }}>
                    <TrackSlider
                      label={`${fx.name} ${param}`}
                      lo={lo}
                      hi={hi}
                      step={hi - lo > 20 ? 1 : 0.01}
                      testid={`art-fx-param-${fx.id}-${param}`}
                      value={value}
                      onChange={(v) => set(param, v)}
                      onBegin={() => dispatch({ type: "begin_gesture", key: `${fx.id}.${param}` })}
                      onEnd={() => dispatch({ type: "end_gesture" })}
                    />
                  </div>
                  <div
                    data-testid={`art-fx-readout-${fx.id}-${param}`}
                    style={{ width: fxReadoutWidth(readout), flex: "none", fontSize: 11, fontVariantNumeric: "tabular-nums" }}
                  >
                    <ValueField
                      param={param}
                      display={(v) => fxReadout(param, v)}
                      value={value}
                      lo={hardRange(param, fx.type)[0]}
                      hi={hardRange(param, fx.type)[1]}
                      beyond={value < lo || value > hi}
                      onCommit={(v) => set(param, v)}
                    />
                  </div>
                  <span hidden className="tnum" style={{ fontSize: 11, color: "var(--text-faint)", width: 26, textAlign: "right" }}>
                    {Math.round(value)}
                  </span>
                </div>
              );
            })}
        </div>
  );
}

/** One layer inside a group.
 *
 * It used to be visibility, opacity and nothing else, on the reasoning
 * that modes and masks belong to the group's own blend. On living with
 * it: "when I group layers, that I can no longer access any controls
 * of a grouped layer except for opacity. This is not how it should
 * work. I need a collapse/expand control on those layers to expand
 * them to their full height to be able to edit them as normal."
 *
 * So the row collapses and expands like the group above it, and open it
 * carries the layer's OWN controls: the fill's color, the text, the
 * shape, whatever that content is. Those all run through
 * art_content_set, which resolves a member through artFindLayer and
 * always could.
 *
 * What a document saved before that date carried: merge-carried
 * members, which have no mask port, no mode and no clip port. Those are
 * converted on load (migrateGroupCarriers), so by the time this row
 * renders there is nothing left that only works at the top level.
 */
function MemberRow({
  member,
  active,
  state,
  dispatch,
  onMenu,
  renaming,
  onRenamed,
  width,
}: {
  member: { merge: NodeCard; content: NodeCard; fx: NodeCard[] };
  active: boolean;
  state: State;
  dispatch: D;
  /** the stack's right-click menu, so a member opens the same one */
  onMenu: (e: React.MouseEvent, id: string) => void;
  /** which layer is being renamed, and how to say it is finished */
  renaming: string | null;
  onRenamed: () => void;
  /** the panel's width, handed to the member's own controls */
  width?: number;
}) {
  const [open, setOpen] = useState(false);
  const warp = member.content.type === LAYER_WARP;
  // A selected Warp member whose chevron left it open is armed when it
  // comes open as a Warp layer by a door with no event of its own
  // (Unbake inside the group, the undo of a bake, a redo): the stack's
  // own rule for a top-level row.
  const armedKey = useRef<string | null>(null);
  useEffect(() => {
    const key = warp && open && active ? `${member.merge.id}|${member.content.id}` : null;
    const was = armedKey.current;
    armedKey.current = key;
    if (key !== null && key !== was && !warpEditing(state, member.content.id)) dispatch({ type: "art_warp_edit", id: member.content.id, on: true });
  });
  return (
    <div
      data-testid={`art-member-${member.merge.id}`}
      data-active={active}
      data-open={open}
      onMouseDown={(e) => {
        e.stopPropagation();
        dispatch({ type: "select_art_layer", id: member.merge.id });
        // A Warp member opened with its chevron is edited while selected,
        // a top-level Warp layer's rule.
        if (warp && open && !active) dispatch({ type: "art_warp_edit", id: member.content.id, on: true });
      }}
      onContextMenu={(e) => onMenu(e, member.merge.id)}
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 5,
        padding: "3px 4px",
        background: active ? "#172024" : "transparent",
        borderLeft: `2px solid ${active ? "var(--accent)" : "transparent"}`,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 7 }}>
        {/* The same chevron the group wears, in the same place, so the
            gesture is learned once. */}
        <button
          style={{ all: "unset", cursor: "pointer", width: 10, color: "var(--text-faint)" }}
          // Named art-open-* like the group's own chevron rather than
          // art-member-*: the stack's tests count members by that
          // prefix, and a button inside a member is not another member.
          data-testid={`art-open-member-${member.merge.id}`}
          aria-label={open ? "Collapse layer" : "Expand layer"}
          aria-expanded={open}
          data-hint={open ? "Collapse this layer" : "Expand this layer to its own controls"}
          onClick={(e) => {
            e.stopPropagation();
            setOpen((v) => !v);
            // A Warp member's chevron is its edit mode, as a top-level Warp layer's
            // (2026-09-30: "when the layer is expanded it should just turn on warp
            // editing. Turn warp editing off when collapsed"). The mouse-down has
            // selected it already.
            if (warp) dispatch({ type: "art_warp_edit", id: member.content.id, on: !open });
          }}
        >
          <svg
            width="9"
            height="9"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.6"
            style={{ transform: open ? "none" : "rotate(-90deg)" }}
          >
            <path d="M6 9l6 6 6-6" />
          </svg>
        </button>
        <VisibilityDot id={member.merge.id} enabled={member.merge.enabled} dispatch={dispatch} />
        <LayerName
          id={member.merge.id}
          name={member.merge.name}
          enabled={member.merge.enabled}
          size={10.5}
          renaming={renaming === member.merge.id}
          onDone={onRenamed}
          dispatch={dispatch}
        />
        <OpacityRow id={member.merge.id} opacity={member.merge.params.opacity ?? 100} dispatch={dispatch} width={64} />
      </div>
      {open && (
        <div style={{ paddingLeft: 17, display: "flex", flexDirection: "column", gap: 6 }}>
          {/* The same controls a top-level layer has, from the same
              component: mode, opacity, the content's own dials, the
              mask and effect buttons, and the effects. A member is
              carried by a blend now, so there is nothing left that only
              works out there. */}
          {/* A member opens with its own chevron, which is already
              the explicit show: open, a collapsible member's settings
              show in either mode, and with Expand settings on select on
              they follow the selection the way a top-level row's do. */}
          <LayerControls
            layer={{ blend: member.merge, content: member.content, fx: member.fx, exported: false }}
            active={active}
            open={layerCollapsible(member) && !state.layerExpandOnSelect ? true : active}
            state={state}
            dispatch={dispatch}
            width={width}
          />
        </div>
      )}
    </div>
  );
}

/** Everything under a layer's name: the mode and opacity row, the
 * content's own controls, the mask and effect buttons, and the effects
 * themselves.
 *
 * Extracted so a layer INSIDE a group renders the same controls a
 * top-level one does ("I need a collapse/expand control on
 * those layers to expand them to their full height to be able to edit
 * them as normal"). Both callers hand it the same shape, because since
 * the carrier became a blend both rows ARE the same shape.
 */
function LayerControls({
  layer,
  active,
  open,
  onEffectAdded,
  state,
  dispatch,
  width,
}: {
  layer: ArtLayer;
  active: boolean;
  /** the layer's settings are open (layerSettingsOpen) */
  open: boolean;
  /** an effect was just added: open the settings so it shows */
  onEffectAdded?: () => void;
  state: State;
  dispatch: D;
  /** the panel's width, so the depth Levels scales with it */
  width?: number;
}) {
  const carrier = layer.blend;
  const mode = carrier.textParams?.mode ?? "normal";
  const opacity = carrier.params.opacity ?? 100;
  const mask = artMaskOf(state, carrier.id);
  const depthOn = ((mask?.params.depth_on as number | undefined) ?? 0) !== 0;
  const depthBins = useDepthBins(state, active && depthOn);
  const docSel = state.nodes.find((n) => n.id === DOC_SEL_ID);
  const editingMask =
    mask &&
    ((state.tool === "brush" && state.selection.includes(mask.id)) ||
      (state.tool === "select" && state.selection.includes(mask.id)) ||
      (state.tool === "smart" && state.selection.includes(mask.id)) ||
      (state.tool === "object" && state.selection.includes(mask.id)));
  return (
    <>
      <div style={{ display: "flex", alignItems: "center", gap: 7 }}>
        <MenuField
          testid={`art-mode-${carrier.id}`}
          label="Blend mode"
          size="regular"
          value={mode}
          options={ART_MODES}
          fitLabels={ART_MODES.map((m) => m.label)}
          onChange={(next) => dispatch({ type: "art_layer_set", id: carrier.id, mode: next })}
        />
        <OpacityRow id={carrier.id} opacity={opacity} dispatch={dispatch} />
      </div>
      <ContentControls layer={layer} open={open} state={state} dispatch={dispatch} />
      {/* FX and MASK share one row, and the row is always there. The
report: the buttons appearing only on the selected layer
"causes other layers to shift up and down", which makes the
stack jump under the cursor as you click down it. There is
room for both across, so both live here as icons.*/}
      <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
        <FxAddButton layer={layer} onAdded={onEffectAdded} dispatch={dispatch} />
        {/* The explicit version of what arming the select tool used to do
behind your back. Only offered when there is a selection to make a
mask out of: any selection, a Smart one included, which has a base
and no regions. The mask it makes is pixels, the kind Add layer
mask makes, and the selection is spent on it (2026-09-30: "drop
the live mask, make To Mask a pixel mask"). On a layer that has a
mask, Shift adds the selection to it and Option takes it out, the
select tools' modifiers; on one without, Option hides the
selection from a layer that showed everywhere.*/}
        {docSel && selectionHasContent(docSel) && !layer.content.isGroup && (
          <IconButton
            testid={`art-mask-from-selection-${carrier.id}`}
            label="Mask from selection"
            hint={`Mask this layer to the current selection; ${modLabel("shift")}-click adds the selection to the layer's mask, ${modLabel("alt")}-click takes it out`}
            glyph={ICONS.maskFromSel}
            onClick={(e) => {
              e?.stopPropagation();
              void maskFromSelection(state, dispatch, carrier.id, docSel.id, maskFromSelectionOp(e, !!mask));
            }}
          />
        )}
        {/* Adding a mask is editing it (2026-10-01: "When you make the mask
select the mask and go into mask editing"): the new mask is
selected with its tool in hand, the state the mask button's own
click sets, so there is no second click between making a mask and
painting it.*/}
        {!mask ? (
          <>
            <IconButton
              testid={`art-mask-add-${carrier.id}`}
              label="Add layer mask"
              hint="A layer mask, with the brush in hand to paint it: starts fully revealed; painting hides, erasing brings back"
              glyph={ICONS.mask}
              plus
              onClick={(e) => {
                e?.stopPropagation();
                dispatch({ type: "art_add_mask", id: carrier.id, edit: true });
              }}
            />
            <IconButton
              testid={`art-mask-smart-${carrier.id}`}
              label="Smart mask"
              hint="Mask this layer by a Smart selection: subject, sky, or your clicks, computed locally; the click tool comes up on it"
              glyph={ICONS.smartMask}
              plus
              onClick={(e) => {
                e?.stopPropagation();
                dispatch({ type: "art_add_mask", id: carrier.id, kind: "smart", edit: true });
              }}
            />
          </>
        ) : (
          <>
            <IconButton
              testid={`art-mask-edit-${carrier.id}`}
              label="Edit layer mask"
              active={!!editingMask}
              hint={maskIsOff(mask) ? MASK_OFF_HINT : `${
                editingMask
                  ? "You are editing this mask now: work in the viewer, or pick another tool to stop"
                  : mask.type === "heeler.smart_mask"
                      ? "Edit the Smart selection this layer shows through: arms the click tool to add or adjust clicks"
                      : mask.type === "heeler.matte_mask"
                        ? "Edit the object mask this layer shows through: arms the pick tool to add or remove objects"
                        : "Paint on the mask: strokes hide this layer, erase reveals it again"
              }; ${modLabel("ctrl")}-click loads it as the document selection; Shift-click turns the mask off, so the layer applies everywhere`}
              glyph={maskIsOff(mask) ? slashed(ICONS.mask) : ICONS.mask}
              onClick={(e) => {
                e?.stopPropagation();
                // Shift-click turns the mask off, or back on, its data kept
                // (2026-10-01: "yes, build disable mask").
                if (e?.shiftKey) {
                  toggleLayerMask(dispatch, mask.id, maskIsOff(mask));
                  return;
                }
                // The layer editors' Cmd-click on the thumbnail: the
                // mask's render becomes the document selection's
                // baked base, and the mask itself stays put.
                if (e?.metaKey || e?.ctrlKey) {
                  publishBusy("LOADING \u00b7 baking the mask into a selection");
                  void bakeMaskRaster(state, mask.id)
                    .then((version) =>
                      dispatch({ type: "load_selection_from_mask", maskId: mask.id, version }),
                    )
                    .catch((err) => reportToolError("Selection from Mask", err))
                    .finally(() => publishBusy(null));
                  return;
                }
                // Arm-only: set_tool toggles, and a second press
                // used to put the tool away - a button that
                // undoes itself reads as a button that does
                // nothing.
                if (editingMask) return;
                // Painting on a mask turned off is allowed, as in
                // a layer editor: the strokes go into the mask and show once
                // it is on. The status line says so.
                if (maskIsOff(mask)) flashStatus("Mask off: your edits go into the mask, and the layer still applies everywhere until you Shift-click the mask button.", 6000);
                dispatch({ type: "select_nodes", ids: [mask.id] });
                dispatch({ type: "set_tool", tool: artMaskEditTool(state, carrier.id) ?? "brush" });
              }}
            />
            <IconButton
              testid={`art-mask-remove-${carrier.id}`}
              label="Remove layer mask"
              hint="Remove the mask; the layer shows everywhere again"
              glyph={ICONS.trash}
              onClick={(e) => {
                e?.stopPropagation();
                dispatch({ type: "art_remove_mask", id: carrier.id });
              }}
            />
            {/* Invert, beside the mask it flips: a selection made into
                the mask is pixels now, and its own panel's Invert went
                with the live selection (2026-09-30). Lit when the mask
                is the other way round from how its kind starts. */}
            <IconButton
              testid={`art-mask-invert-${carrier.id}`}
              label="Invert layer mask"
              active={(mask.params.invert ?? 0) !== (mask.type === "heeler.brush_mask" ? layerMaskPolarity(state, mask.id) : 0)}
              hint="Flip this layer's mask: the layer shows where it was hidden and hides where it showed"
              glyph={ICONS.invert}
              onClick={(e) => {
                e?.stopPropagation();
                dispatch({ type: "set_param", id: mask.id, param: "invert", value: (mask.params.invert ?? 0) !== 0 ? 0 : 1 });
              }}
            />
          </>
        )}
        {/* The layer mask's Show mask eye, in this strip beside the mask's
own buttons (2026-09-30: "We have basically an entire row for the
show mask button, that is a waste of screen space"): on the
selected layer, every kind alike. Still one on screen: it stands
down while the brush is in hand (the brush settings carry it
beside the dab).*/}
        {active && mask && maskEyeHere(state) && (
          <span data-testid={`art-mask-eye-${carrier.id}`} style={{ display: "inline-flex" }}>
            <MaskViewButton state={state} dispatch={dispatch} padding="3px 5px" />
          </span>
        )}
        {/* The Depth mask, beside the mask it multiplies (2026-09-09: "an icon
button next to the regular mask button"). A layer with no mask yet
gets a brush mask, born reveal-all, so there is a mask for the
depth to shape. On, the row below offers Invert depth and the depth
eye.*/}
        {!layer.content.isGroup && (
          <IconButton
            testid={`art-depth-${carrier.id}-toggle`}
            label="Depth mask"
            active={depthOn}
            hint={
              depthOn
                ? "Depth mask is on: the nearest takes this layer's full effect, the farthest none. Click to switch it off"
                : "Multiplies this layer's mask by the depth map: the nearest takes the full effect, the farthest none; a layer with no mask gets one"
            }
            glyph={ICONS.depth}
            onClick={(e) => {
              e?.stopPropagation();
              if (!mask) dispatch({ type: "art_add_mask", id: carrier.id, kind: "brush" });
              dispatch({ type: "set_param", id: `art_m_${carrier.id}`, param: "depth_on", value: depthOn ? 0 : 1 });
            }}
          />
        )}
        {/* The Object mask, beside Depth and only for an OpenEXR (2026-09-20:
"a button next to the depth mask button to enable object masking,
but only visible when it's an EXR file"). On, the layer's mask is
the objects the file names, picked in the panel below or by clicking
them; a mask of another kind gives way to it. Off takes the mask
away.*/}
        {!layer.content.isGroup && activeIsExr(state) && (
          <IconButton
            testid={`art-mask-object-${carrier.id}`}
            label="Object mask"
            active={mask?.type === "heeler.matte_mask"}
            hint={
              mask?.type === "heeler.matte_mask"
                ? "Object mask is on: this layer shows through the objects picked below. Click to switch it off"
                : mask
                  ? "Masks this layer by the objects the photograph's file names, picked from the list or by clicking them; replaces the layer's current mask"
                  : "Masks this layer by the objects the photograph's file names, picked from the list or by clicking them"
            }
            glyph={ICONS.objectMask}
            onClick={(e) => {
              e?.stopPropagation();
              if (mask?.type === "heeler.matte_mask") {
                dispatch({ type: "art_remove_mask", id: carrier.id });
                return;
              }
              if (mask) dispatch({ type: "art_remove_mask", id: carrier.id });
              dispatch({ type: "art_add_mask", id: carrier.id, kind: "object", edit: true });
            }}
          />
        )}
      </div>
      {active && depthOn && mask && (
        <div
          data-testid={`art-depth-${carrier.id}`}
          style={{ display: "flex", alignItems: "center", gap: 6, margin: "4px 0 2px" }}
        >
          <div style={{ fontSize: 10, letterSpacing: ".06em", color: "var(--text-dim)", textTransform: "uppercase", marginRight: 2 }}>Depth</div>
          <IconButton
            testid={`art-depth-${carrier.id}-invert`}
            label="Invert depth"
            active={(mask.params.depth_invert ?? 0) !== 0}
            hint="Reads the depth map the other way: the farthest takes this layer's full effect, the nearest none; this layer only"
            glyph={ICONS.invert}
            onClick={(e) => {
              e?.stopPropagation();
              dispatch({ type: "set_param", id: mask.id, param: "depth_invert", value: (mask.params.depth_invert ?? 0) !== 0 ? 0 : 1 });
            }}
          />
          {/* The depth eyes' one contract (DepthViewButton): a click
              shows the depth map in the mask flavor, the modifier click
              shows this layer's own mask in red, its depth mask applied,
              through the layer's mask eye (again: black and white). */}
          <IconButton
            testid={`art-depth-${carrier.id}-view`}
            label="View depth"
            active={state.depthView}
            hint={depthEyeHint({ red: state.maskRed, mask: true, maskShown: depthMaskShown(state, mask.id), covering: state.depthView && maskPreviewNode(state) === mask.id })}
            glyph={state.maskRed ? ICONS.overlay : ICONS.eye}
            onClick={(e) => {
              e?.stopPropagation();
              dispatch({ type: "toggle_depth_view", flavor: depthEyeModifier(e), mask: mask.id });
            }}
          />
        </div>
      )}
      {active && depthOn && mask && (
        <div style={{ margin: "2px 0 6px" }} onMouseDown={(e) => e.stopPropagation()}>
          {/* The stack is padded 12px either side and the layer card
              9px, so the Levels width is the panel's less 42; undefined
              keeps the old default. */}
          <LevelsEditor
            state={state}
            node={mask}
            dispatch={dispatch}
            width={width === undefined ? 272 : Math.max(220, width - 42)}
            bins={depthBins}
            keys={DEPTH_LEVELS_KEYS}
            falloff={true}
            testPrefix={`art-depth-${carrier.id}-levels`}
            hint={DEPTH_LEVELS_HINT}
          />
        </div>
      )}
      {/* The mask's Export checkbox, right below the Depth mask control and its
block (2026-09-30: "on Adjustment layers, add a toggle below the Depth
Mask for export layer", and the same night: "I am not seeing the toggle
I requested ... make sure that is labeled something like Export Mask as
Layer"). Shown wherever the Depth mask button is (the strip above is
always there, selected or not, expanded or not), on every adjustment
layer, masked or not (an unmasked one exports its opacity everywhere),
and on any other layer wearing a mask.*/}
      {!layer.content.isGroup &&
        (!!ART_KINDS[layer.content.artKind ?? ""]?.adjust || !!mask) &&
        artLayers(state).some((l) => l.blend.id === carrier.id) && (
          <div
            data-testid={`art-mask-export-row-${carrier.id}`}
            style={{ display: "flex", alignItems: "center", gap: 6, margin: "2px 0 4px" }}
          >
            <MaskExportTick state={state} blendId={carrier.id} dispatch={dispatch} testid={`art-mask-export-${carrier.id}`} />
            <span style={{ fontSize: 11, color: "var(--text-faint)" }}>{MASK_EXPORT_LABEL}</span>
          </div>
        )}
      {/* No eye row here: the selected layer's eye is in the strip
          above (maskEyeHere keeps it to one on screen), and
          maskPreviewNode's art branch points the view at this
          layer's mask when no brush is up. */}
      {/* The smart-selection dials live WITH the layer that wears the
Smart mask (the controls floating above the
toolbar was "weird"), and only while it is the active layer.*/}
      {active && mask?.type === "heeler.smart_mask" && <SmartModePanel state={state} dispatch={dispatch} />}
      {/* The object picker, with the layer that wears the Object mask,
          the same seat the Smart dials take. */}
      {active && mask?.type === "heeler.matte_mask" && <ObjectMattePanel state={state} dispatch={dispatch} />}
      {/* The effects themselves stay in their own column under the
          row that adds them. */}
      <FxRow layer={layer} active={open} dispatch={dispatch} />
    </>
  );
}

/** A layer's name, and the inline edit the menu's Rename… starts.
 *
 * An input rather than a dialog: the name is right there, and a dialog
 * for one field is a lot of ceremony for typing six letters. Enter and
 * blur commit, Escape puts the old name back, and an empty name is
 * refused rather than leaving a row with nothing to point at.
 */
function LayerName({
  id,
  name,
  enabled,
  size,
  renaming,
  onDone,
  dispatch,
}: {
  id: string;
  name: string;
  enabled: boolean;
  size: number;
  renaming: boolean;
  onDone: () => void;
  dispatch: D;
}) {
  const [draft, setDraft] = useState(name);
  useEffect(() => {
    if (renaming) setDraft(name);
  }, [renaming, name]);
  if (!renaming) {
    return (
      <span
        data-testid={`art-name-${id}`}
        style={{ flex: 1, fontSize: size, color: enabled ? "var(--text-body)" : "var(--text-ghost)" }}
      >
        {name}
      </span>
    );
  }
  const commit = () => {
    const next = draft.trim();
    if (next && next !== name) dispatch({ type: "art_layer_set", id, name: next });
    onDone();
  };
  return (
    <input
      data-testid={`art-rename-${id}`}
      aria-label="Layer name"
      autoFocus
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onMouseDown={(e) => e.stopPropagation()}
      onBlur={commit}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === "Enter") commit();
        if (e.key === "Escape") onDone();
      }}
      style={{
        flex: 1,
        minWidth: 0,
        fontSize: size,
        background: "var(--bg-app)",
        color: "var(--text-body)",
        border: "1px solid var(--accent)",
        padding: "1px 4px",
      }}
    />
  );
}

/** A fold-out inside the layer menu. Opens on hover, like every other
 * submenu in this app, and flips to the left when there is no room on
 * the right: the stack sits against the window's right edge, which is
 * exactly where a submenu has nowhere to go. */
function LayerSubMenu({
  label,
  testid,
  disabled,
  children,
}: {
  label: string;
  testid: string;
  disabled?: boolean;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const [left, setLeft] = useState(false);
  const host = useRef<HTMLDivElement>(null);
  // Which side it opens on is measured when it opens, not read during
  // render: the panel is CSS-zoomed, the window can be any width, and a
  // ref read while rendering is null the first time through anyway.
  const reveal = () => {
    if (disabled) return;
    const box = host.current?.getBoundingClientRect();
    setLeft(!!box && box.right + LAYER_MENU_W > viewportSize().w);
    setOpen(true);
  };
  return (
    <div
      ref={host}
      style={{ position: "relative" }}
      onMouseEnter={reveal}
      onMouseLeave={() => setOpen(false)}
    >
      <button
        data-testid={testid}
        disabled={disabled}
        data-active={open}
        onClick={() => (open ? setOpen(false) : reveal())}
        style={{ display: "flex", alignItems: "center", justifyContent: "space-between", width: "100%" }}
      >
        {label}
        <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4">
          <path d="M9 6l6 6-6 6" />
        </svg>
      </button>
      {open && (
        <div
          className="ctx-menu"
          data-testid={`${testid}-list`}
          style={{
            position: "absolute",
            ...(left ? { right: "100%" } : { left: "100%" }),
            top: -4,
            width: LAYER_MENU_W,
            maxHeight: 320,
            overflowY: "auto",
          }}
        >
          {children}
        </div>
      )}
    </div>
  );
}

/** Which way Mask from selection lands, from the click's modifiers:
 * Option (Alt) takes the selection out of the layer's mask, Shift adds it
 * to the mask the layer has, a plain click makes the selection the mask.
 * Shift on a layer with no mask is the plain click: there is nothing to
 * add to. */
export function maskFromSelectionOp(e: { altKey?: boolean; shiftKey?: boolean } | undefined, hasMask: boolean): MaskFromSelectionOp {
  if (e?.altKey) return "subtract";
  if (e?.shiftKey && hasMask) return "add";
  return "replace";
}

/** Mask from selection, whole: the desktop renders the selection once
 * (with the mask it lands in, for add and subtract) and keeps the
 * coverage; the reducer gives the layer the pixel mask wearing it and
 * empties the selection, in one undo step. */
export async function maskFromSelection(
  state: State,
  dispatch: (c: Command) => void,
  layerId: string,
  selectionId: string,
  op: MaskFromSelectionOp,
): Promise<void> {
  const mask = artMaskOf(state, layerId);
  publishBusy("MASK \u00b7 making the selection the layer's mask");
  try {
    const version = await bakeLayerMask(state, selectionId, mask?.id ?? `art_m_${layerId}`, op === "replace" ? undefined : mask?.id, op);
    dispatch({ type: "art_mask_from_selection", id: layerId, maskId: selectionId, version, op });
  } catch (err) {
    reportToolError("Mask from selection", err);
  } finally {
    publishBusy(null);
  }
}
