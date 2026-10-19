import { DepthViewButton } from "./smarttool";
// Simple mode right panel: histogram, adjustment sections, masks.
// Sliders write to real graph nodes (exposure / standard color / grain),
// exactly like the backend contract: Simple mode is a skin over the graph.

import { chromeZoomFactor, setUiPref } from "../uiprefs";
import { withRootDispatch } from "../rootdispatch";

/** One coat for all nine Source chips (Highlights, Demosaic, Profile).
 * "Inconsistent font sizes (profile is too small) and
 * since each has three buttons, all 9 buttons should have a uniform
 * width so the layout is clean." Fixed width, centered, and NO per-row
 * font override, so the three rows line up as the grid they visually
 * are.*/
/** The mask row's chips share one height: a glyph chip and a word chip
 * size themselves differently from their content, and the owner wants
 * Polish as tall as Show mask. Box-sized so the border is inside the
 * number.*/
const MASK_CHIP: React.CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  height: 18,
  boxSizing: "border-box",
};

import { SourceMenuRow } from "./sourcemenus";
import { PROFILE_CHOICES, SOURCE_MENU_ROWS } from "./sourcemenusparts";
import { GuardStrip } from "./guardstrip";
import { capturePreset, maskBrushTarget, maskOverlayRgb, DEPTH_SIZES, snapDepthSize, MODEL_DENOISE_ID, denoiseMethodIsModel, denoiseSectionOn, depthMapMissing, maskViewOverriddenBy, maskPreviewNode, depthMaskShown, maskOverlayWanted, DEPTH_EXPORT_CONVENTION } from "../state";
import { useDenoiseStatus, useFullDenoiseStatus, requestFullDenoise, retryDenoise, denoiseMark } from "./denoisetoolparts";
import { TrackSlider, ValueField } from "./track";
// Re-exported from its new home so artlayers' import keeps working;
// the field moved to track.tsx (a leaf) so the Depth Lighting rig can
// use it without a simple<->keylightgizmo cycle.
export { ValueField };
import { KeyLightControls } from "./keylightgizmo";
import { lightsOf, writeLights } from "./keylightgizmoparts";
import { DepthInvertIcon, EyedropperIcon, LightAddIcon, LightRigIcon, ResetIcon, ScopeIcon } from "./panelicons";
import { publishBusy } from "./statusbar";
import { flashStatus } from "./hints";
import { GridWarpControls } from "./gridwarp";
import { ShapeWarpControls } from "./shapewarp";
import { ColorCheckerControls } from "./colorchecker";
import { FeatherFollowsToggle } from "./featherfollows";
import { LinesRow, LineWidthRow } from "./linecolor";
import { depthForget, denoiseTileCount, imageMetadata, presetExport, presetImport, presetList, presetRead, presetSave, presetTrash, type PresetEntry } from "../bridge";
import { LevelsEditor } from "./levels";
import { DEPTH_LEVELS_HINT, DEPTH_LEVELS_KEYS, useDepthBins } from "./depthbins";
import { reportToolError } from "./hints";
import { DabPreviewButton, MaskViewButton } from "./smarttool";
import { hexToRgb255 } from "./colorfieldparts";
import React, { memo, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ColorSetsBlock } from "./colorsets";
import { panePropsEqual } from "./viewmemo";
import type { Command, NodeCard, State } from "../state";
import { NEUTRAL_PARAMS, BRUSH_TIPS, availableMaskTypes, PANEL_TABS, RADIAL_SHAPES, RANGE_PRESETS, SELECT_METHODS, SELECT_OPS, SHAPE_AMOUNT_LABEL, TEXTURED_TIPS, activeSelectionMask, layersOf, hardRange, paramRange, clampBlurStrength, toolNode, detailEqViewOn, visiblePanelTabs, sectionExportId, artLayers, artMaskOf } from "../state";
import type { LayerMaskType, PanelTab, PickMode, PickTarget, SelectOp } from "../state";
import { curveModeOf, photoFlips, photoTurn, pickMaskNode } from "../state";
import { FlipPhotoRow } from "./flipphoto";
import { CATEGORY_PIECES, recipeParamDefault } from "../recipes";
import { CurveEditor, Wheel } from "./editors";
import { ExportTick, LayerMaskExportRow, MaskExportTick } from "./exporttick";
import { OpIcon } from "./selecticons";
import { BrushPreview } from "./brushpreview";
import {
  STACK_KINDS,
  panoInfo,
  stackAddFrames,
  stackInfo,
  resumePanoStitch,
  updatePano,
  updateStack,
  type PanoInfo,
  type StackInfo,
} from "../bridge";
import {
  autoNoiseStrengths,
  estimateNoise,
  lensProfileFor,
  loadLensPresets,
  saveLensPresets,
} from "../bridge";
import {
  captureLensPreset,
  DNG_WARP,
  fileWarpValues,
  lensPresetValues,
  parseLensPresets,
  upsertLensPreset,
  type LensPreset,
} from "../lenspresets";
import { logDebug, logMsg } from "../log";
import { AS_SHOT, averageColor, neutralize } from "../whitebalance";
import { assignHints } from "../keynav";
import { HintKey } from "./hintkey";
import { BendBar, BendWheel } from "./bend";
import { EqEditor } from "./eqeditor";
import { EQ_PRESETS, serializeEqPoints } from "../eqcurve";
import { BwControls } from "./bwcontrols";
import { PrintControls } from "./print";
import { GrainFilmRow, GrainFrameRow } from "./grainfilm";
import { ZonesBlock } from "./zones";
import { RecolorHost } from "./recolor";
import { RecolorPairs } from "./recolorpairs";
import { InspectDock } from "./inspect";
import { DepthPickButton, DepthShape } from "./depthband";
import { SectionLooks } from "./sectionlooks";
import { ColorConsoleBlock } from "./colorconsole";
import { DepthProgressBar, NormalsChoice } from "./depthtool";
import { depthFromFile, passesOf } from "./depthtoolparts";
import { ObjectMattePanel } from "./mattetool";
import { TetherTab } from "./tether";
import { MaskEyeIcon, MaskOverlayIcon } from "./panelicons";
import { SmartClearButton, SmartModePanel } from "./smarttool";
import { FlarePanel, StreakRibbon } from "./flare";
import { LensCharacterBlock } from "./lenscharacter";
import { SpectrumBar, Spectrums } from "./spectrum";
import { PanelTabs } from "./panelicons";
import { MetadataTab } from "./metadata";
import { ArtLayersTab } from "./artlayers";
import { DevelopMaskToggle } from "./masktoggle";
import { PanelDivider } from "./divider";
import { useDismiss } from "./hooks";
import { revealActiveThumb } from "./chrome";
import { clampMenu, viewportSize } from "./menupos";
import { linkedWith } from "../links";
import { LinkIcon } from "./linkicon";
import { isMac, modLabel } from "../platform";
import { polishDevelopMask } from "../polishdoor";
import { isLayerNode, maskOfLayer } from "../layerids";
import { MenuField } from "./menufield";
import { SuggestField } from "./suggestfield";
import { DETAIL_EFFECTS, DETAIL_EQ_BANDS, DETAIL_EQ_PARAMS, DETAIL_WEIGHTS, MASK_ROWS, ROW_TIPS, SECTIONS, SECTION_BLURBS, SOURCE_ROWS, type SectionSpec, buildFor, hiddenSectionCount, navSections, paramDefault, powerOnSection, previewNodes, sectionExportCommand, sectionExportLayer, sectionExportOffered, sectionHidden, sectionIsOn, sectionNodeIds, sectionPinHint, sliderHint, visibleSections } from "./simpledata";

/** Width of the tab context menu, shared by its style and its placement so
 * the two cannot disagree about how much room it needs. */
const TAB_MENU_W = 208;
export { HintKey };

type D = React.Dispatch<Command>;

/** Sections whose tool can leave for a window of its own, Color Bend
 * style. "make the following adjustment tools able to
 * pop out to larger floating windows."*/
const TOOL_POPOUTS: Record<string, "wheels" | "curves" | "toneeq" | "recolor" | "colorconsole" | undefined> = {
  Curves: "curves",
  "Color Wheels": "wheels",
  "Tone Equalizer": "toneeq",
  Recolor: "recolor",
  "Color Tune": "colorconsole",
};

/** The folded bar a popped-out tool leaves behind; clicking it is the
 * way back, same as the Color Bend's. */
function ToolPopBar({
  tool,
  label,
  dispatch,
}: {
  tool: "wheels" | "curves" | "toneeq" | "recolor" | "colorconsole";
  label: string;
  dispatch: D;
}) {
  return (
    <button
      data-testid={`${tool}-bar`}
      data-hint="Bring this tool back into the panel"
      onClick={() => dispatch({ type: "set_tool_popped_out", tool, out: false })}
      style={{
        all: "unset",
        boxSizing: "border-box",
        cursor: "pointer",
        display: "flex",
        alignItems: "center",
        gap: 6,
        width: "100%",
        padding: "7px 12px",
        border: "1px solid var(--line-2)",
        color: "var(--text-ghost)",
      }}
    >
      <span style={{ fontSize: 9, letterSpacing: ".16em", textTransform: "uppercase" }}>
        {label}
      </span>
      <span style={{ fontSize: 9 }}>in its own window</span>
    </button>
  );
}

/** Making and editing a selection.
 *
 * The list is the selection: every region in it is geometry that can be
 * re-opened, re-pointed at a different operation, or thrown away, and
 * nothing above it has been flattened into pixels.
 */
export function SelectionControls({
  state,
  dispatch,
  node,
}: {
  state: State;
  dispatch: D;
  node: NodeCard;
}) {
  const regions = node.regions ?? [];
  const seg = (active: boolean) => ({
    fontSize: 9,
    padding: "1px 6px",
    whiteSpace: "nowrap" as const,
    ...(active ? {} : {}),
  });
  return (
    <>
      <div className="srow" style={{ gridTemplateColumns: "78px 1fr" }}>
        <div className="lbl">Draw with</div>
        <MenuField
          testid="select-method"
          label="Draw with"
          size="regular"
          value={state.selectMethod}
          options={SELECT_METHODS}
          fitLabels={SELECT_METHODS.map((m) => m.label)}
          onChange={(method) => dispatch({ type: "set_select_method", method })}
        />
      </div>

      {/* What the next region does. "specify if they are adding,
replacing, or removing from a selection." The same icons the toolbar
wears, because two pictures of one concept teaches it twice as fast
as a picture and a word.*/}
      <div className="srow" style={{ gridTemplateColumns: "78px 1fr" }}>
        <div className="lbl">Mode</div>
        {/* Hugging its buttons, not the grid column: stretched to the 1fr the
group's border ran to the panel's right edge and the last button
looked like it did the stretching. "The intersect button
extends to the right edge of the panel."*/}
        <div className="zoom-seg" role="group" aria-label="Selection mode" style={{ border: "1px solid var(--line-4)", width: "fit-content" }}>
          {SELECT_OPS.map((o) => (
            <button
              key={o.id}
              data-active={state.selectOp === o.id}
              data-testid={`select-op-${o.id}`}
              data-hint={`${o.label} · ${o.hint}`}
              aria-label={o.label}
              data-tip={o.label}
              style={{ ...seg(state.selectOp === o.id), display: "inline-flex", alignItems: "center" }}
              onClick={() => dispatch({ type: "set_select_op", op: o.id })}
            >
              <OpIcon id={o.id} size={12} />
            </button>
          ))}
        </div>
      </div>

      {/* Tolerance means the color distance for the wand and the snap
          radius for the two edge-following methods. Named for whichever
          it currently is, rather than left as a word that could mean
          either. */}
      {/* The color brush has a size, like any brush. */}
      {state.selectMethod === "paint" && (
        <div className="srow" style={{ gridTemplateColumns: "78px 1fr 42px" }}>
          <div className="lbl">Brush size</div>
          <TrackSlider
            label="Selection brush size"
            lo={0.005}
            hi={0.3}
            step={0.005}
            testid="select-brush-radius"
            hint="How much of the picture each drag samples from"
            value={state.selectBrushRadius ?? 0.04}
            onChange={(radius) =>
              dispatch({ type: "set_select_brush_radius", radius })
            }
          />
          <ValueField
            param="selection brush size"
            value={state.selectBrushRadius ?? 0.04}
            lo={0.005}
            hi={0.3}
            scale={200}
            display={(v) => String(Math.round(v))}
            onCommit={(radius) =>
              dispatch({ type: "set_select_brush_radius", radius })
            }
          />
        </div>
      )}
      {["wand", "magnetic", "paint", "region"].includes(state.selectMethod) && (
        <div className="srow" style={{ gridTemplateColumns: "78px 1fr 42px" }}>
          <div className="lbl">
            {state.selectMethod === "magnetic" ? "Snap range" : "Tolerance"}
          </div>
          <TrackSlider
            label={state.selectMethod === "magnetic" ? "Snap range" : "Tolerance"}
            lo={0.01}
            hi={1}
            step={0.01}
            testid="select-tolerance"
            value={state.selectTolerance}
            onChange={(tolerance) =>
              dispatch({ type: "set_select_tolerance", tolerance })
            }
          />
          <ValueField
            param="tolerance"
            value={state.selectTolerance}
            lo={0.01}
            hi={1}
            display={(v) => v.toFixed(2)}
            onCommit={(tolerance) =>
              dispatch({ type: "set_select_tolerance", tolerance })
            }
          />
        </div>
      )}

      {state.selectMethod === "magnetic" && (
        <div className="srow" style={{ gridTemplateColumns: "78px 1fr 42px" }}>
          <div className="lbl">Sensitivity</div>
          <TrackSlider
            label="Sensitivity"
            lo={0}
            hi={1}
            step={0.01}
            testid="select-magnet-sense"
            hint="How faint an edge still attracts the trace: low takes only bold contours, high takes wisps and fine fur"
            value={state.selectMagnetSense}
            onChange={(sense) =>
              dispatch({ type: "set_select_magnet_sense", sense })
            }
          />
          <ValueField
            param="sensitivity"
            value={state.selectMagnetSense}
            lo={0}
            hi={1}
            display={(v) => v.toFixed(2)}
            onCommit={(sense) =>
              dispatch({ type: "set_select_magnet_sense", sense })
            }
          />
        </div>
      )}

      {state.selectMethod === "freehand" && (
        <div className="srow" style={{ gridTemplateColumns: "78px 1fr 42px" }}>
          <div className="lbl">Smoothing</div>
          <TrackSlider
            label="Smoothing"
            lo={0}
            hi={1}
            step={0.01}
            testid="select-smooth"
            value={state.selectSmooth}
            onChange={(smooth) =>
              dispatch({ type: "set_select_smooth", smooth })
            }
          />
          <ValueField
            param="smoothing"
            value={state.selectSmooth}
            lo={0}
            hi={1}
            display={(v) => v.toFixed(2)}
            onCommit={(smooth) =>
              dispatch({ type: "set_select_smooth", smooth })
            }
          />
        </div>
      )}

      <div
        data-testid="region-list"
        style={{ display: "flex", flexDirection: "column", gap: 2, marginTop: 4 }}
      >
        {(() => {
          // The smart base gets a row of its own, first: it applies before
          // every drawn region, and a selection the list does not show is a
          // selection you cannot see or discard. "What I would
          // expect to see after using any of these 3 is marching ants and a
          // selection region added to the Selection list."
          const matte = node.textParams?.matte_id ?? "";
          if (!matte.startsWith("baked:")) return null;
          const mode = node.textParams?.mode || "click";
          const clicks = (() => {
            try {
              const p: unknown = JSON.parse(node.textParams?.prompts || "[]");
              return Array.isArray(p) ? p.length : 0;
            } catch {
              return 0;
            }
          })();
          const label =
            mode === "subject"
              ? "Smart · Subject"
              : mode === "sky"
                ? "Smart · Sky"
                : `Smart · ${clicks} click${clicks === 1 ? "" : "s"}`;
          return (
            <div
              data-testid="region-smart-base"
              style={{
                display: "flex",
                alignItems: "center",
                gap: 6,
                padding: "3px 6px",
                background: "var(--bg-row)",
                fontSize: 10,
              }}
            >
              <span style={{ color: "var(--text-ghost)", width: 14 }}>◆</span>
              <span style={{ flex: 1, color: "var(--text-faint)" }}>{label}</span>
              <button
                className="chip"
                data-testid="region-smart-delete"
                data-hint="Drop the model's selection; regions drawn on top stay"
                style={{ fontSize: 9, padding: "0 5px" }}
                onClick={() =>
                  dispatch({
                    type: "set_params",
                    id: node.id,
                    values: {},
                    text: { matte_id: "", prompts: "", mode: "" },
                  })
                }
              >
                ✕
              </button>
            </div>
          );
        })()}
        {regions.length === 0 && (node.textParams?.matte_id ?? "") === "" && (
          <div style={{ fontSize: 10, color: "var(--text-faint)", lineHeight: 1.5 }}>
            Draw in the viewer to start a selection. Every region lands in the list below, where
            it can be switched off or removed at any time.
          </div>
        )}
        {regions.map((r, i) => (
          <div
            key={i}
            data-testid={`region-row-${i}`}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 6,
              padding: "3px 6px",
              background: "var(--bg-row)",
              fontSize: 10,
            }}
          >
            <span style={{ color: "var(--text-ghost)", width: 14 }}>{i + 1}</span>
            <MenuField
              testid={`region-op-${i}`}
              label={`Region ${i + 1} mode`}
              size="regular"
              value={r.op}
              options={SELECT_OPS}
              fitLabels={SELECT_OPS.map((o) => o.label)}
              onChange={(op) =>
                dispatch({
                  type: "set_region_op",
                  id: node.id,
                  index: i,
                  op: op as SelectOp,
                })
              }
            />
            <span style={{ flex: 1, color: "var(--text-faint)", opacity: r.off ? 0.45 : 1 }}>
              {r.kind === "key"
                ? `Color · ${(r.tolerance * 100).toFixed(0)}%`
                : r.kind === "samples"
                  ? `Color brush · ${r.points.length} samples · ${(r.tolerance * 100).toFixed(0)}%`
                  : r.kind === "brush"
                    ? `Polish · ${r.points.length} pts`
                    : r.kind === "bezier"
                      ? `Pen · ${r.points.length} anchors`
                      : r.kind === "marquee"
                      ? `${r.shape === "ellipse" ? "Ellipse" : "Rectangle"} · ${Math.round(
                          insidePicture(r.x0, r.x1) * 100,
                        )}×${Math.round(insidePicture(r.y0, r.y1) * 100)}%`
                      : r.kind === "range"
                      ? `${r.channel === "luma" ? "Luma" : r.channel === "contrast" ? "Contrast" : r.channel[0].toUpperCase() + r.channel.slice(1)} range · ${Math.round(
                          r.lo * 100,
                        )} to ${Math.round(r.hi * 100)}%`
                      : `${r.via ?? "Path"} · ${r.points.length} pts`}
            </span>
            {/* Sitting out, not thrown out: geometry and place in line both kept,
only the vote withheld. "we should have a button to
enable/disable a selection. I know for a fact NONE of the other apps
have that."*/}
            <button
              className="chip"
              data-testid={`region-toggle-${i}`}
              data-hint={r.off ? "Let this region vote again" : "Silence this region without deleting it"}
              aria-pressed={!r.off}
              style={{ fontSize: 9, padding: "0 5px", color: r.off ? "var(--text-ghost)" : "var(--accent)" }}
              onClick={() => dispatch({ type: "set_region_off", id: node.id, index: i, off: !r.off })}
            >
              {r.off ? "○" : "●"}
            </button>
            {/* Order is meaning: ops apply top to bottom, so moving a
                subtract above an add changes what survives. */}
            <button
              className="chip"
              data-testid={`region-up-${i}`}
              data-hint="Apply this region earlier"
              disabled={i === 0}
              style={{ fontSize: 9, padding: "0 4px", opacity: i === 0 ? 0.3 : 1 }}
              onClick={() => dispatch({ type: "move_region", id: node.id, from: i, to: i - 1 })}
            >
              ↑
            </button>
            <button
              className="chip"
              data-testid={`region-down-${i}`}
              data-hint="Apply this region later"
              disabled={i === regions.length - 1}
              style={{ fontSize: 9, padding: "0 4px", opacity: i === regions.length - 1 ? 0.3 : 1 }}
              onClick={() => dispatch({ type: "move_region", id: node.id, from: i, to: i + 1 })}
            >
              ↓
            </button>
            <button
              className="chip"
              data-testid={`region-delete-${i}`}
              data-hint="Remove this region from the selection"
              style={{ fontSize: 9, padding: "0 5px" }}
              onClick={() => dispatch({ type: "remove_region", id: node.id, index: i })}
            >
              ✕
            </button>
          </div>
        ))}
        {/* No CLEAR ALL and no POLISH here. Deselect already has a
            hotkey and a click-off; a third door was furniture. Polish
            waits behind its gate; see features.ts. */}
      </div>
      {/* No Remove chip here any more. It earned its seat once, then lost it
to its own name: beside a list of regions, "Remove" reads as "remove
the selection", not "remove the object". "I thought it
mean 'remove selection'." Select > Remove Object remains the one
door, where the menu's words have room to say which removal is
meant.*/}
    </>
  );
}

/** The tip the next stroke is laid down with.
 *
 * A tool setting, not a node parameter: it applies to what you are about
 * to paint, and every stroke already on the mask keeps the tip it was
 * painted with. Changing brush half way through a mask is a normal thing
 * to do and it should not rewrite the first half.
 */
export function BrushTipPicker({ state, dispatch }: { state: State; dispatch: D }) {
  // Defaulted rather than read straight off state: a session saved
  // before these settings existed restores without them, and a slider
  // that reads .toFixed() off undefined takes the whole panel down.
  const tip = state.brushTip ?? "circle";
  const scale = state.brushTextureScale ?? 0.5;
  const depth = state.brushTextureDepth ?? 0.6;
  const textured = TEXTURED_TIPS.includes(tip);
  return (
    <>
      {/* Size and softness first: they are the two things you reach for
          constantly, and both are on [ and ] while the brush is up. */}
      <div className="srow" style={{ gridTemplateColumns: "78px 1fr 42px" }}>
        <div className="lbl">Radius</div>
        <TrackSlider
          label="Brush radius"
          lo={0.005}
          hi={0.3}
          step={0.005}
          testid="brush-radius"
          hint="Brush size · [ and ] while painting"
          value={state.brushRadius}
          onChange={(radius) => dispatch({ type: "set_brush_radius", radius })}
        />
        <ValueField
          param="brush radius"
          value={state.brushRadius}
          lo={0.005}
          hi={0.3}
          scale={200}
          display={(v) => String(Math.round(v))}
          testid="brush-radius-value"
          onCommit={(radius) => dispatch({ type: "set_brush_radius", radius })}
        />
      </div>
      <div className="srow" style={{ gridTemplateColumns: "78px 1fr 42px" }}>
        <div className="lbl">Opacity</div>
        <TrackSlider
          label="Brush opacity"
          lo={0.01}
          hi={1}
          step={0.01}
          testid="brush-opacity"
          hint={`How much the brush lays down; 100 is full white. ${modLabel("alt")} inverts, ${modLabel("shift")} blends what is already there`}
          value={state.brushFlow ?? 1}
          onChange={(flow) => dispatch({ type: "set_brush_flow", flow })}
        />
        <ValueField
          param="brush opacity"
          value={state.brushFlow ?? 1}
          lo={0.01}
          hi={1}
          scale={100}
          display={(v) => String(Math.round(v))}
          testid="brush-opacity-value"
          onCommit={(flow) => dispatch({ type: "set_brush_flow", flow })}
        />
      </div>
      <div className="srow" style={{ gridTemplateColumns: "78px 1fr 42px" }}>
        <div className="lbl">Softness</div>
        <TrackSlider
          label="Brush softness"
          lo={0}
          hi={1}
          step={0.01}
          testid="brush-softness"
          hint={`Edge falloff · ${modLabel("shift")}+[ and ${modLabel("shift")}+] while painting`}
          // Shown as softness, stored as hardness, because the engine
          // reads a hardness and one of the two has to be the inverse.
          value={1 - (state.brushHardness ?? 0.8)}
          onChange={(v) =>
            dispatch({ type: "set_brush_hardness", hardness: 1 - v })
          }
        />
        <ValueField
          param="brush softness"
          value={1 - (state.brushHardness ?? 0.8)}
          lo={0}
          hi={1}
          scale={100}
          display={(v) => String(Math.round(v))}
          testid="brush-softness-value"
          onCommit={(v) =>
            dispatch({ type: "set_brush_hardness", hardness: 1 - v })
          }
        />
      </div>
      {/* How far out of focus, as against how much of it lands. Opacity
          answers the second and always did; without this the first was
          pinned to the brush size, so a big soft brush could not lay down
          a gentle blur and a small one could not lay down a heavy one.

Here rather than below the tip picker, because it belongs with the
other numbers. The dab beside the picker once overhung whatever sat
under it. "The brush tip preview is overlapping the blur
strength value." The Tip row sizes to the dab now, so it would no
longer overlap, but the numbers read better together anyway.

A fifth of the radius at the top of the slider, not the whole of it. The
report: "the default blur strength range on the slider is way to high
(100). Maybe 0-20". Sigma is a fraction of the brush, so a hundred percent
of a large brush is a blur nobody reaches for by dragging.

          The floor is one and not zero: a blur brush set to no blur is a
          brush that does nothing, and it is reachable by dragging to the
          end and then remembered, which is a way to open the app with a
          dead tool and no clue why. */}
      {state.tool === "blur" && (
      <div className="srow" style={{ gridTemplateColumns: "78px 1fr 42px" }}>
        <div className="lbl">Blur</div>
        <TrackSlider
          label="Blur strength"
          lo={0.01}
          hi={0.2}
          step={0.005}
          testid="brush-blur-strength"
          hint="How far out of focus the brush takes what is underneath, as a percentage of its radius; opacity says how much of that lands"
          value={state.brushBlurStrength ?? 0.08}
          onChange={(v) => {
            // Clamped once, then both remembered and dispatched, so what
            // comes back tomorrow is what was on screen today.
            const strength = clampBlurStrength(v);
            setUiPref("brushBlurStrength", strength);
            dispatch({ type: "set_brush_blur_strength", strength });
          }}
        />
        <ValueField
          param="blur strength"
          value={state.brushBlurStrength ?? 0.08}
          lo={0.01}
          hi={0.2}
          scale={100}
          display={(v) => String(Math.round(v))}
          testid="brush-blur-strength-value"
          onCommit={(v) => {
            const strength = clampBlurStrength(v);
            setUiPref("brushBlurStrength", strength);
            dispatch({ type: "set_brush_blur_strength", strength });
          }}
        />
      </div>
      )}
      {/* The four tools that read pixels from somewhere: clone and heal from a
picked source, blur and blend from what is under the brush. All four
have always read the composite BELOW the layer, which is what lets a
repair layer be empty, and all four were therefore useless on a layer
inside a group: a group member's input is the group's transparent
canvas, so there is nothing below to read. "one feature is
missing in brush settings for Clone, Heal, Blur, Blend. And that is to
only sample pixels on the current layer."*/}
      {(state.tool === "clone" ||
        state.tool === "heal" ||
        state.tool === "blur" ||
        state.tool === "blend") && (
      <div className="srow" style={{ gridTemplateColumns: "78px 1fr" }}>
        <div className="lbl">This layer</div>
        <div
          className="toggle"
          data-on={state.brushSampleLayer === true}
          data-testid="brush-sample-layer"
          role="switch"
          aria-checked={state.brushSampleLayer === true}
          aria-label="Sample this layer only"
          data-hint="Reads this layer's own pixels instead of the picture below it, which is the only source a layer inside a group has"
          tabIndex={0}
          onClick={() => {
            const on = !state.brushSampleLayer;
            setUiPref("brushSampleLayer", on);
            dispatch({ type: "set_brush_sample_layer", on });
          }}
        >
          <div className="dot" />
        </div>
      </div>
      )}
      {state.tool === "blur" && (
      <div className="srow" style={{ gridTemplateColumns: "78px 1fr" }}>
        <div className="lbl">Build up</div>
        <div
          className="toggle"
          data-on={state.brushBlurBuild === true}
          data-testid="brush-blur-build"
          role="switch"
          aria-checked={state.brushBlurBuild === true}
          aria-label="Build up"
          data-hint="On, a second pass softens further; off, it stops at the strongest pass, so overlaps do not show"
          tabIndex={0}
          onClick={() => {
            const build = !state.brushBlurBuild;
            setUiPref("brushBlurBuild", build);
            dispatch({ type: "set_brush_blur_build", build });
          }}
        >
          <div className="dot" />
        </div>
      </div>
      )}
      {/* The dab, rendered by the engine, beside the picker. The layer
          editors both put one here, and it is the fastest way to
          tell splatter from dry media without painting a test stroke. */}
      {/* .srow pins every row to 28px; the dab is 46. Grow this row to fit it
rather than letting it overhang with overflow visible: an overhanging
dab is not counted in the picker's layout height, so the panel around
it sized 18px short and the dab's foot was clipped by the window edge
the panel sits on. "The brush controls are still being
clipped at the bottom."*/}
      <div className="srow" style={{ gridTemplateColumns: "78px 1fr auto", alignItems: "center", height: "auto", minHeight: 28 }}>
        <div className="lbl">Tip</div>
        <MenuField
          testid="brush-tip"
          label="Brush tip"
          size="regular"
          value={tip}
          options={BRUSH_TIPS}
          fitLabels={BRUSH_TIPS.map((b) => b.label)}
          onChange={(next) => dispatch({ type: "set_brush_tip", tip: next })}
        />
        {/* The dab beside the picker stays whatever happens: "having
the texture on the brush is necessary." It is the painted-on copy
that gets in the way, and that is the toggle below.*/}
        <BrushPreview
          tip={tip}
          hardness={state.brushHardness ?? 0.8}
          textureScale={scale}
          textureDepth={depth}
          textureAngle={state.brushTextureAngle ?? 0}
          // Full strength for the mask brush, whatever the flow slider says: the
          // swatch answers "what value does this paint", and a half-flow gray
          // answering "black" reads as broken. "The tip preview in
          // settings should be showing the full opaque/opacity as it will be
          // applied while painting."
          flow={state.tool === "brush" ? 1 : state.brushFlow ?? 1}
          // The panel swatch is the cursor's dab at another size, so it wears the
          // color the stroke will: the wash red on a mask, "The brush
          // tip preview needs to represent the overlay color as well." And the
          // chosen color on the paint brush, which showed white whatever the
          // picker said. "the dab for paint brush ... always shows as
          // white even when I change the color."
          tint={
            state.tool === "brush"
              ? // The swatch and the cursor dab must tell the same story: the VALUE
                // a paint stroke leaves in the mask the brush would write to. the
                // owner's screenshot had the cursor saying black while this said
                // white, because this ignored the target mask's polarity.
                (((state.maskRed && state.maskView)
                  ? maskOverlayRgb(state.prefs.maskOverlayColor)
                  : ((maskBrushTarget(state)?.params.invert ?? 0) !== 0) !== state.brushSwap
                    ? "20,20,20"
                    : "235,235,235"
                ).split(",").map(Number) as [number, number, number])
              : state.tool === "paint"
                ? hexToRgb255(state.paintColor)
                : undefined
          }
        />
      </div>
      {/* "the paint overlay is distracting when a brush is
applied ... I can't see the edits. Maybe we need a Show Texture as
well." Off, the strokes still show while you are drawing them and
then hand the picture back to the adjustment they are driving. On,
they stay so you can see the shape of a mask you have been building
up in pieces.

Named for the first half of that sentence, not the second. It was "Show
texture", which promised the grain and governs no such thing, so it read
as broken: the brush is textured while you drag whatever this is set to,
deliberately, because the owner asked for that too ("having the texture on
the brush is necessary"). The overlay is what he named it in the same
breath, and it is what a RAW editor calls the equivalent wash.*/}
      {/* The owner's layout, verbatim: the Tip row above, then one row of
icon buttons - "Show Mask should just be the button, no label" -
then the Overlay slider, always visible, live only while the red
overlay actually shows. (Keep wash lived here briefly and died:
the owner only ever wanted the texture in the dab.)*/}
      {state.tool === "brush" && (
      <div className="srow" style={{ gridTemplateColumns: "1fr" }}>
        <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
          <MaskViewButton state={state} dispatch={dispatch} />
          <DabPreviewButton state={state} dispatch={dispatch} />
          {/* The mask's Export checkbox while it is being painted (2026-09-30:
"Add an Export Layer toggle on Finish layer masks"): the Finish
layer's own box, the same node as the row under the layer's Depth
mask.*/}
          {(() => {
            // The Finish brush paints the mask it selected (the layer's
            // mask button and art_mask_from_selection both select it).
            const owner = artLayers(state).find((l) => {
              const m = artMaskOf(state, l.blend.id);
              return !!m && state.selection.includes(m.id);
            });
            return owner ? (
              <MaskExportTick state={state} blendId={owner.blend.id} dispatch={dispatch} testid="brush-mask-export" />
            ) : null;
          })()}
        </div>
      </div>
      )}
      {state.tool === "brush" && (
      <div className="srow" style={{ gridTemplateColumns: "78px 1fr 42px" }}>
        <div className="lbl" style={{ opacity: (state.maskView && state.maskRed) || maskOverlayWanted(state) ? 1 : 0.4 }}>Overlay</div>
        <TrackSlider
          label="Overlay opacity"
          lo={0}
          hi={1}
          step={0.01}
          disabled={!((state.maskView && state.maskRed) || maskOverlayWanted(state))}
          testid="brush-overlay-strength"
          hint="How strongly the mask overlay (and the brush wash) reads where the mask is white, for this session; Preferences sets where it starts"
          value={state.brushOverlayStrength ?? 0.5}
          onChange={(strength) => {
            dispatch({ type: "set_brush_overlay_strength", strength });
          }}
        />
        <ValueField
          param="overlay opacity"
          value={state.brushOverlayStrength ?? 0.5}
          lo={0}
          hi={1}
          scale={100}
          display={(v) => String(Math.round(v))}
          testid="brush-overlay-strength-value"
          onCommit={(strength) => {
            dispatch({ type: "set_brush_overlay_strength", strength });
          }}
        />
      </div>
      )}
      {/* Aligned, the way every retoucher means it: the source keeps its
          distance from the cursor, so a second stroke continues the first
          instead of restarting it. Off, every stroke reads from the point
          that was picked, which is what you want when one clean patch has
          to cover several blemishes. The distance is set by the first
          stroke after a source is chosen and resets with the next one.

Only the two tools that read from a source. It "should only
be visible with clone stamp and healing tool, it doesn't make sense
otherwise", and a switch that governs nothing is worse than absent,
because it invites the question of what it did.*/}
      {(state.tool === "clone" || state.tool === "heal") && (
      <div className="srow" style={{ gridTemplateColumns: "78px 1fr" }}>
        <div className="lbl">Aligned</div>
        <div
          className="toggle"
          data-on={state.brushCloneAligned === true}
          data-testid="brush-clone-aligned"
          role="switch"
          aria-checked={state.brushCloneAligned === true}
          aria-label="Aligned"
          data-hint="Clone and heal: keep the source at a fixed distance from the cursor, rather than reading from the picked point every stroke"
          tabIndex={0}
          onClick={() => {
            const aligned = !state.brushCloneAligned;
            setUiPref("brushCloneAligned", aligned);
            dispatch({ type: "set_brush_clone_aligned", aligned });
          }}
        >
          <div className="dot" />
        </div>
      </div>
      )}
      {/* Round and square are solid, so a grain control for them would
          be a control for nothing. */}
      {textured && (
        <>
          <div className="srow" style={{ gridTemplateColumns: "78px 1fr 42px" }}>
            <div className="lbl">Grain size</div>
            <TrackSlider
              label="Grain size"
              lo={0.02}
              hi={2}
              step={0.01}
              testid="brush-texture-scale"
              value={scale}
              onChange={(v) =>
                dispatch({ type: "set_brush_texture", scale: v })
              }
            />
            <ValueField
              param="grain size"
              value={scale}
              lo={0.02}
              hi={2}
              display={(v) => v.toFixed(2)}
              testid="brush-texture-scale-value"
              onCommit={(v) =>
                dispatch({ type: "set_brush_texture", scale: v })
              }
            />
          </div>
          {/* The owner asked for this twice, in his words both times: "another
slider to manage transparency of the lower values", and then "the
opacity to let me control how transparent the lower values of the
texture would be".
           *
           * It was here the first time, called "Grain floor", which is
           * the same number and none of his words. He went looking for
           * opacity and found jargon, so it may as well not have
           * existed. Named for the thing it does now: the gaps in the
           * grain, and how opaque they are. Zero leaves them as holes,
           * a hundred fills them in and the texture disappears, which
           * is the gray he said he sometimes wants on the way. */}
          <div className="srow" style={{ gridTemplateColumns: "78px 1fr 42px" }}>
            <div className="lbl">Gap opacity</div>
            <TrackSlider
              label="Gap opacity"
              lo={0}
              hi={1}
              step={0.01}
              testid="brush-gap-opacity"
              hint="How opaque the dark gaps in the grain are. 0 leaves them fully transparent; higher fills them in with gray."
              value={1 - depth}
              onChange={(v) =>
                dispatch({ type: "set_brush_texture", depth: 1 - v })
              }
            />
            <ValueField
              param="gap opacity"
              value={1 - depth}
              lo={0}
              hi={1}
              scale={100}
              display={(v) => String(Math.round(v))}
              testid="brush-gap-opacity-value"
              onCommit={(v) =>
                dispatch({ type: "set_brush_texture", depth: 1 - v })
              }
            />
          </div>
          {/* "a rotate control that is also wired into the hotkey ALT +
[]." Turning the grain turns the coordinates it is sampled at, so the
pattern stays anchored to the image and a dragged stroke still lays
down one continuous texture.*/}
          <div className="srow" style={{ gridTemplateColumns: "78px 1fr 42px" }}>
            <div className="lbl">Grain angle</div>
            <TrackSlider
              label="Grain angle"
              lo={-180}
              hi={180}
              step={1}
              testid="brush-texture-angle"
              hint={`Which way the grain runs · ${modLabel("alt")}+[ and ${modLabel("alt")}+] while painting, ${modLabel("shift")}+${modLabel("alt")} for finer steps`}
              value={state.brushTextureAngle ?? 0}
              onChange={(angle) =>
                dispatch({ type: "set_brush_texture_angle", angle })
              }
            />
            <ValueField
              param="grain angle"
              value={state.brushTextureAngle ?? 0}
              lo={-180}
              hi={180}
              display={(v) => String(Math.round(v))}
              testid="brush-texture-angle-value"
              onCommit={(angle) =>
                dispatch({ type: "set_brush_texture_angle", angle: Math.round(angle) })
              }
            />
          </div>
        </>
      )}
    </>
  );
}

/** Shape for a radial mask, and the one slider whose meaning follows it.
 *
 * A dropdown rather than a row of buttons: seven shapes will not fit
 * across a 285 pixel panel, and this is a thing you set once per mask
 * rather than something you flick between. */
export function RadialShapePicker({ node, dispatch }: { node: NodeCard; dispatch: D }) {
  // Absent means a mask placed before shapes existed. It draws as an
  // ellipse, which is what it has always been.
  const shape = node.textParams?.shape ?? "ellipse";
  const amountLabel = SHAPE_AMOUNT_LABEL[shape];
  return (
    <>
      <div className="srow" style={{ gridTemplateColumns: "78px 1fr" }}>
        <div className="lbl">Shape</div>
        <MenuField
          testid="radial-shape"
          label="Shape"
          hint="The outline the mask takes"
          node={node.id}
          param="shape"
          size="regular"
          value={shape}
          options={RADIAL_SHAPES}
          fitLabels={RADIAL_SHAPES.map((s) => s.label)}
          onChange={(value) => dispatch({ type: "set_text_param", id: node.id, param: "shape", value })}
        />
      </div>
      {/* Only for the shapes it does something to, named for what it
          does to each rather than left as "amount". */}
      {amountLabel && (
        <Slider
          label={amountLabel}
          param="shape_amount"
          node={node}
          dispatch={dispatch}
          centered={false}
        />
      )}
    </>
  );
}

/** Distinct icons for the add-layer buttons (two mask types share an
 * initial, so first letters were ambiguous). */
const MASK_ICONS: Record<LayerMaskType, React.ReactNode> = {
  // Range: histogram bars with a selected window.
  range: (
    <svg
      width="12"
      height="12"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.2"
    >
      <path d="M4 20V10M9 20V4M14 20v-8M19 20V7" />
      <path d="M7 22h9" strokeWidth="3" opacity=".55" />
    </svg>
  ),
  // Radial: circle with a soft inner dot.
  radial: (
    <svg
      width="12"
      height="12"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
    >
      <circle cx="12" cy="12" r="8" />
      <circle cx="12" cy="12" r="2.5" fill="currentColor" stroke="none" />
    </svg>
  ),
  // Linear: diagonal gradient steps.
  linear: (
    <svg
      width="12"
      height="12"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.2"
    >
      <path d="M4 18L18 4" />
      <path d="M8 21L21 8" opacity=".6" />
      <path d="M2 13L13 2" opacity=".3" />
    </svg>
  ),
  // Brush: stroke with a handle.
  brush: (
    <svg
      width="12"
      height="12"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
    >
      <path d="M20 4c-4 1-9 5-11 9l3 3c4-2 8-7 9-11z" />
      <path
        d="M7 15c-2 .5-3 2.5-3 5 2.5 0 4.5-1 5-3z"
        fill="currentColor"
        stroke="none"
      />
    </svg>
  ),
  // Selection: a marching-ants outline with a vertex on it, since the
  // vertices are the thing that makes this one different.
  selection: (
    <svg
      width="12"
      height="12"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
    >
      <path d="M4 8a4 4 0 0 1 4-4" />
      <path d="M16 4a4 4 0 0 1 4 4" />
      <path d="M20 16a4 4 0 0 1-4 4" />
      <path d="M8 20a4 4 0 0 1-4-4" />
      <circle cx="12" cy="4" r="2" fill="currentColor" stroke="none" />
      <circle cx="20" cy="12" r="2" fill="currentColor" stroke="none" />
    </svg>
  ),
  // Smart: a cursor spark; the model answers the click.
  smart: (
    <svg
      width="12"
      height="12"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
    >
      <path d="M12 2v4M12 18v4M2 12h4M18 12h4" />
      <circle cx="12" cy="12" r="4" />
    </svg>
  ),
  // Object: a tagged shape, the name a renderer gave it.
  object: (
    <svg
      width="12"
      height="12"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.2"
    >
      <path d="M4 7l8-4 8 4v10l-8 4-8-4z" />
      <path d="M4 7l8 4 8-4M12 11v10" opacity=".6" />
    </svg>
  ),
};

/** Grain stock patterns; ids match the engine's pattern param. */
/** Halation's film gauges, smallest first. */
const HALATION_FORMATS = ["8mm", "16mm", "35mm", "65mm"].map((f) => ({ id: f, label: f }));

/** The Sharpen node's two recipes. */
const RECIPES = [
  { id: "vivid", label: "Vivid" },
  { id: "hipass", label: "Hi Pass" },
];

const GRAIN_PATTERNS = [
  { id: "fine", label: "Fine" },
  { id: "standard", label: "Standard" },
  { id: "coarse", label: "Coarse" },
  { id: "cinema", label: "Cinema" },
];

/** Presets and the eyedropper for range masks. The picker arms the
 * viewer's pick tool; the click itself is handled there, where the image
 * geometry lives. */
export function RangeMaskTools({
  state,
  dispatch,
  maskNode,
}: {
  state: State;
  dispatch: D;
  maskNode: NodeCard;
}) {
  // Lit only while the dropper samples into THIS mask: the same block
  // sits on the node in Graph, and two range masks can be on screen.
  const picking = state.tool === "pick" && pickMaskNode(state) === maskNode.id;
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 5,
        marginBottom: 6,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
        <div className="kicker" style={{ width: 46 }}>
          Preset
        </div>
        <MenuField
          testid="range-preset"
          label="Range preset"
          hint="Set the range from a preset; the controls stay yours to edit"
          size="regular"
          value=""
          placeholder="Choose…"
          options={RANGE_PRESETS}
          fitLabels={["Choose…", ...RANGE_PRESETS.map((p) => p.label)]}
          onChange={(id) => {
            const preset = RANGE_PRESETS.find((p) => p.id === id);
            if (preset)
              dispatch({
                type: "set_params",
                id: maskNode.id,
                values: preset.values,
              });
          }}
        />
      </div>
      {/* The eyedropper row, a size up from the rest of the panel and icons
where a word was decoration ("scaled by 1.15x... Pick
should just be the icon as should Luma and Hue"). The sample modes
say what they do to the RANGE, since that is the thing on screen
above them: Set, Widen, Narrow. "Set + -" had to be hovered to be
understood.*/}
      <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
        <button
          className="chip"
          data-testid="range-picker"
          data-active={picking}
          aria-label="Pick"
          data-tip="Pick"
          data-hint="Pick a color or tone from the image: click the photo to sample it into the range"
          style={{
            fontSize: 10,
            padding: "3px 7px",
            display: "inline-flex",
            alignItems: "center",
            color: picking ? "var(--accent)" : "var(--text-ghost)",
            borderColor: picking ? "var(--accent)" : "var(--line-4)",
          }}
          onClick={() => dispatch({ type: "set_tool", tool: "pick", node: maskNode.id })}
        >
          <svg
            width="12"
            height="12"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
          >
            <path d="M18 2l4 4-9 9-4 1 1-4z" />
            <path d="M9 12l-6 6v3h3l6-6" />
          </svg>
        </button>
        <div
          className="zoom-seg"
          role="group"
          aria-label="Pick mode"
          data-hint="What a sample does to the range: Set starts it over on the sample, Widen grows it to take the sample in, Narrow pulls it back to leave the sample out"
          style={{ border: "1px solid var(--line-4)" }}
        >
          {PICK_MODE_ICONS.map(([m, label, hint, icon]) => (
            <button
              key={m}
              data-active={state.pickMode === m}
              data-testid={`pick-mode-${m}`}
              aria-label={label}
              data-tip={label}
              data-hint={hint}
              style={{
                fontSize: 10,
                padding: "2px 7px",
                display: "inline-flex",
                alignItems: "center",
              }}
              onClick={() => dispatch({ type: "set_pick_mode", mode: m })}
            >
              {icon}
            </button>
          ))}
        </div>
        <div
          className="zoom-seg"
          role="group"
          aria-label="Pick target"
          style={{ border: "1px solid var(--line-4)" }}
        >
          {(["luma", "hue"] as const).map((t) => (
            <button
              key={t}
              data-active={state.pickTarget === t}
              data-testid={`pick-target-${t}`}
              aria-label={t === "luma" ? "Luma" : "Hue"}
              data-tip={t === "luma" ? "Luma" : "Hue"}
              data-hint={
                t === "luma"
                  ? "Sample into the luma range: how light the picked spot is"
                  : "Sample into the hue range: what color the picked spot is"
              }
              style={{
                fontSize: 10,
                padding: "2px 7px",
                display: "inline-flex",
                alignItems: "center",
              }}
              onClick={() => dispatch({ type: "set_pick_target", target: t })}
            >
              {t === "luma" ? (
                <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
                  <circle cx="6" cy="6" r="5" fill="none" stroke="currentColor" strokeWidth="1.4" />
                  <path d="M6 1a5 5 0 0 1 0 10z" fill="currentColor" />
                </svg>
              ) : (
                <span
                  aria-hidden="true"
                  style={{
                    display: "inline-block",
                    width: 11,
                    height: 11,
                    borderRadius: "50%",
                    background:
                      "conic-gradient(#e0473c, #e0b13c, #6fcf4a, #3cc8c8, #4a6fe0, #c84ad2, #e0473c)",
                    opacity: state.pickTarget === "hue" ? 1 : 0.6,
                  }}
                />
              )}
            </button>
          ))}
        </div>
      </div>
      {picking && (
        <div style={{ fontSize: 9, color: "var(--accent)", lineHeight: 1.5 }}>
          Click the image to sample. ESC or the Pick button stops.
        </div>
      )}
    </div>
  );
}

/** The three things a sample can do to the range, drawn as what they do
 * to the band on the axis: a fresh band pinned on the sample, a band
 * with its edges pushed out, a band with its edges pulled in. Icons at
 * the Luma and Hue buttons' size ("the Set/Widen/Narrow
 * buttons should have icons, and they should be the same size as the
 * Luma/Hue buttons"). The name rides along as the tip and the label.*/
const PICK_MODE_ICONS: [PickMode, string, string, React.ReactNode][] = [
  [
    "replace",
    "Set",
    "Set: start the range over, centered on the sample",
    <svg key="set" width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
      <line x1="0.5" y1="6" x2="11.5" y2="6" stroke="currentColor" strokeWidth="1" opacity="0.35" />
      <rect x="3.5" y="3.5" width="5" height="5" fill="currentColor" />
      <line x1="6" y1="0.5" x2="6" y2="11.5" stroke="currentColor" strokeWidth="1" />
    </svg>,
  ],
  [
    "add",
    "Widen",
    "Widen: grow the range until the sample is inside it",
    <svg key="widen" width="12" height="12" viewBox="0 0 12 12" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="4" y="3.5" width="4" height="5" fill="currentColor" stroke="none" />
      <path d="M3 6H0.5M2 4.2L0.5 6l1.5 1.8" />
      <path d="M9 6h2.5M10 4.2L11.5 6 10 7.8" />
    </svg>,
  ],
  [
    "subtract",
    "Narrow",
    "Narrow: pull the range in until the sample is outside it",
    <svg key="narrow" width="12" height="12" viewBox="0 0 12 12" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="4" y="3.5" width="4" height="5" fill="currentColor" stroke="none" />
      <path d="M0.5 6H3M1.5 4.2L3 6 1.5 7.8" />
      <path d="M11.5 6H9M10.5 4.2L9 6l1.5 1.8" />
    </svg>,
  ],
];

export function LayersSection({ state, dispatch, width }: { state: State; dispatch: D; /** the panel's width, so the depth Levels scales with it */ width?: number }) {
  const [renaming, setRenaming] = useState<string | null>(null);
  // The selected layer whose controls a second click folded away: a
  // click on the selected layer folds them and another opens them, and
  // choosing another layer opens its own (the owner's ask: "clicking
  // it again does nothing").
  const [folded, setFolded] = useState<string | null>(null);
  const layers = layersOf(state);
  const active = state.activeLayer;
  const activeInfo = layers.find((l) => l.id === active);
  const maskNode = activeInfo
    ? state.nodes.find((n) => n.id === activeInfo.maskId)
    : undefined;
  const adjNode = activeInfo ? state.nodes.find((n) => n.id === activeInfo.id) : undefined;
  const maskOverride = maskViewOverriddenBy(state);
  return (
    <div
      style={{ borderBottom: "1px solid var(--line-1)", padding: "9px 0 10px" }}
      data-testid="layers-section"
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          padding: "0 12px 7px",
        }}
      >
        <div className="kicker">Layers</div>
        <div style={{ display: "flex", gap: 4, alignItems: "center" }}>
          {availableMaskTypes(state).map(
            (t) => (
              <button
                key={t}
                className="chip"
                data-testid={`add-layer-${t}`}
                data-hint={`New ${t} layer`}
                aria-label={`New ${t} layer`}
                data-tip={`New ${t} layer`}
                style={{
                  padding: "2px 5px",
                  display: "inline-flex",
                  alignItems: "center",
                }}
                onClick={() => dispatch({ type: "add_layer", maskType: t })}
              >
                {MASK_ICONS[t]}
              </button>
            ),
          )}
        </div>
      </div>
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          gap: 1,
          padding: "0 8px",
        }}
      >
        <button
          data-testid="layer-base"
          onClick={() => dispatch({ type: "set_active_layer", id: null })}
          style={{
            all: "unset",
            cursor: "pointer",
            display: "flex",
            alignItems: "center",
            gap: 8,
            padding: "4px 8px",
            fontSize: 11,
            background: active === null ? "#141f24" : "var(--bg-row)",
            borderLeft:
              active === null
                ? "2px solid var(--accent)"
                : "2px solid transparent",
            color: active === null ? "#cde9f4" : "var(--text-body)",
          }}
        >
          Base
        </button>
        {layers.map((l) => {
          // The switch lives on the exposure node (layerOff), not in
          // its `enabled`: a fresh layer's nodes are bypassed until a
          // slider moves, and that layer is on.
          const enabled = !state.nodes.find((n) => n.id === l.id)?.layerOff;
          return (
          <div
            key={l.id}
            data-testid={`layer-row-${l.id}`}
            data-enabled={enabled}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              padding: "4px 8px",
              fontSize: 11,
              background: active === l.id ? "#141f24" : "var(--bg-row)",
              borderLeft:
                active === l.id
                  ? "2px solid var(--accent)"
                  : "2px solid var(--cat-masking)",
              color: active === l.id ? "#cde9f4" : "var(--text-body)",
              opacity: enabled ? 1 : 0.55,
            }}
          >
            {/* The same dot the Finish layers wear: on is the accent,
                off is a hollow ring. The row dims with it, so a
                bypassed layer reads as bypassed from across the room. */}
            <button
              style={{ all: "unset", cursor: "pointer", width: 12, textAlign: "center" }}
              data-testid={`layer-vis-${l.id}`}
              aria-pressed={enabled}
              aria-label={enabled ? `Hide ${l.name}` : `Show ${l.name}`}
              data-hint={enabled ? "Turn this layer off: its mask and settings stay, it just stops applying" : "Turn this layer back on"}
              onClick={(e) => {
                e.stopPropagation();
                dispatch({ type: "set_layer_enabled", id: l.id, enabled: !enabled });
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
            {renaming === l.id ? (
              <input
                autoFocus
                defaultValue={l.name}
                data-testid={`rename-input-${l.id}`}
                onBlur={(e) => {
                  dispatch({
                    type: "rename_layer",
                    id: l.id,
                    name: e.target.value,
                  });
                  setRenaming(null);
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter") e.currentTarget.blur();
                  if (e.key === "Escape") setRenaming(null);
                }}
                style={{
                  flex: 1,
                  minWidth: 0,
                  background: "var(--bg-app)",
                  border: "1px solid var(--line-4)",
                  color: "var(--text-body)",
                  fontSize: 11,
                  padding: "1px 4px",
                  outline: "none",
                }}
              />
            ) : (
              <button
                style={{
                  all: "unset",
                  cursor: "pointer",
                  flex: 1,
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                }}
                data-testid={`select-${l.id}`}
                data-hint={`Click to select, double-click to rename, ${modLabel("ctrl")}-click to load its mask as the selection`}
                onClick={(e) => {
                  // The layer editors' Cmd-click on the mask thumbnail: the
                  // layer's mask renders into the document selection
                  // as a baked base; the layer keeps its mask.
                  if (e.metaKey || e.ctrlKey) {
                    const m = state.nodes.find(
                      (n) => n.id === maskOfLayer(l.id),
                    );
                    if (!m?.type.endsWith("_mask")) return;
                    publishBusy("LOADING · baking the mask into a selection");
                    void import("../bridge").then(({ bakeMaskRaster }) =>
                      bakeMaskRaster(state, m.id)
                        .then((version) =>
                          dispatch({ type: "load_selection_from_mask", maskId: m.id, version }),
                        )
                        .catch((err) => reportToolError("Selection from Mask", err))
                        .finally(() => publishBusy(null)),
                    );
                    return;
                  }
                  if (state.activeLayer === l.id) {
                    setFolded((f) => (f === l.id ? null : l.id));
                    return;
                  }
                  setFolded(null);
                  dispatch({ type: "set_active_layer", id: l.id });
                }}
                onDoubleClick={() => setRenaming(l.id)}
              >
                {l.name}
              </button>
            )}
            {/* Duplicate and remove, 1.15x the glyphs they were, and spaced as the
section headers space reset from its switch: the header's 10 gap
plus the reset chip's 5 of padding is 15 between glyphs, and 5 + 5 +
5 is the same 15 here. Same hit-area padding as that reset chip.*/}
            <div style={{ display: "flex", alignItems: "center", gap: 5, flex: "none" }}>
              <button
                style={{
                  all: "unset",
                  cursor: "pointer",
                  color: "var(--text-ghost)",
                  padding: "3px 5px",
                  fontSize: 11.5,
                  lineHeight: 1,
                }}
                aria-label={`Duplicate ${l.name}`}
                data-hint="Duplicate this layer"
                data-testid={`duplicate-${l.id}`}
                onClick={() => dispatch({ type: "duplicate_layer", id: l.id })}
              >
                ⧉
              </button>
              <button
                style={{
                  all: "unset",
                  cursor: "pointer",
                  color: "var(--text-ghost)",
                  padding: "3px 5px",
                  fontSize: 12.65,
                  lineHeight: 1,
                }}
                aria-label={`Remove ${l.name}`}
                data-testid={`remove-${l.id}`}
                onClick={() => dispatch({ type: "remove_layer", id: l.id })}
              >
                ✕
              </button>
            </div>
          </div>
          );
        })}
        {/* Object removals get rows of their own. A removal made from the
document selection belongs to no layer, so deleting layers never
touched it. "The effect of the remove persisted
after I deleted the layer." Every removal now has a visible
seat: an eye to compare with and without, and a delete that
heals the chain.*/}
        {state.nodes
          .filter((n) => n.type === "heeler.inpaint" && n.id.startsWith("inpaint_"))
          .map((n) => (
            <div
              key={n.id}
              data-testid={`removal-row-${n.id}`}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 8,
                padding: "4px 8px",
                fontSize: 11,
                background: "var(--bg-row)",
                borderLeft: "2px solid var(--cat-detail)",
                color: "var(--text-body)",
                opacity: n.enabled ? 1 : 0.55,
              }}
            >
              <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                Removed object
              </span>
              <button
                style={{ all: "unset", cursor: "pointer", padding: "0 2px", fontSize: 10, color: n.enabled ? "var(--accent)" : "var(--text-ghost)" }}
                aria-pressed={n.enabled}
                aria-label="Toggle this removal"
                data-hint={n.enabled ? "Show the photograph with the object back, without undoing the removal" : "Apply the removal again"}
                data-testid={`removal-eye-${n.id}`}
                onClick={() => dispatch({ type: "set_enabled", id: n.id, enabled: !n.enabled })}
              >
                {n.enabled ? "●" : "○"}
              </button>
              <button
                style={{ all: "unset", cursor: "pointer", color: "var(--text-ghost)", padding: "0 2px" }}
                aria-label="Delete this removal"
                data-hint="Take the removal out for good: the object comes back"
                data-testid={`removal-delete-${n.id}`}
                onClick={() => dispatch({ type: "remove_inpaint", id: n.id })}
              >
                ✕
              </button>
            </div>
          ))}
      </div>
      {activeInfo && maskNode && folded !== activeInfo.id && (
        <div
          style={{ marginTop: 7, padding: "0 12px 0 18px" }}
          data-testid="layer-mask-controls"
        >
          {/* The layer's own Opacity, first in its block: a setting of
              the whole layer, above the mask that decides where. The
              Finish layers wear theirs at the top of their block too. */}
          {adjNode && (
            <div data-testid="layer-opacity" style={{ marginBottom: 6 }}>
              <LayerOpacitySlider node={adjNode} dispatch={dispatch} />
            </div>
          )}
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              marginBottom: 2,
              gap: 4,
            }}
          >
            <div className="kicker" style={{ flex: 1 }}>
              {activeInfo.maskType} mask
            </div>
            {/* The layer's mask switch (2026-10-01: "yes, build disable mask"): off,
the layer applies everywhere, its mask and Depth mask kept; the glyph
wears a red slash.*/}
            <DevelopMaskToggle mask={maskNode} dispatch={dispatch} />
            <button
              className="chip bare"
              data-testid="mask-reset"
              aria-label="Reset this mask"
              data-hint="Reset this mask to its defaults"
              style={{
                padding: "2px 6px",
                color: "var(--text-ghost)",
                display: "flex",
                alignItems: "center",
              }}
              onClick={() =>
                dispatch({
                  type: "reset_mask",
                  id: maskNode.id,
                  maskType: activeInfo.maskType,
                })
              }
            >
              <ResetIcon />
            </button>
            {/* CLEAR sits between RESET and Show mask (the owner's seating),
smart layers only: it forgets the selection, where RESET puts
dials back.*/}
            {activeInfo.maskType === "smart" && (
              <SmartClearButton state={state} dispatch={dispatch} />
            )}
            {/* ONE Show mask button, the owner's compromise: click shows or hides
the mask in the CURRENT flavor, ALT/CMD-click switches the flavor
(alpha black/white, or the red overlay) app-wide - the Color Sets
eye and eyedropper honor the same flavor. The glyph is the flavor.*/}
            {/* On but not showing: another view has the frame, View depth most
often, so the button wears the warning color and says which view,
and what turning it off will show.*/}
            <button
              className="chip"
              data-testid="mask-view-toggle"
              data-active={state.maskView}
              data-overridden={maskOverride ? "true" : undefined}
              aria-pressed={state.maskView}
              aria-label={
                state.maskRed ? "Show mask as a red overlay" : "Show mask as black and white"
              }
              aria-description={maskOverride ? `On, but ${maskOverride} is showing instead` : undefined}
              data-hint={
                maskOverride
                  ? `Show mask is on, but ${maskOverride} is showing instead. Turn ${maskOverride} off to see this mask${
                      maskOverride === "View depth" ? ", with its depth Levels applied" : ""
                    }`
                  : `Show this mask as the layer uses it, Depth mask included, ${
                      state.maskRed ? "as a red tint over the photograph" : "as black/white"
                    }; ${modLabel("alt")}-click switches between black/white and the red overlay`
              }
              style={{
                ...MASK_CHIP,
                padding: "1px 6px",
                color: maskOverride ? "var(--warn)" : state.maskView ? "var(--accent)" : "var(--text-ghost)",
                borderColor: maskOverride ? "var(--warn)" : state.maskView ? "var(--accent)" : "var(--line-4)",
              }}
              onClick={(e) => {
                if (e.altKey || e.metaKey) {
                  dispatch({ type: "toggle_mask_flavor" });
                  if (!state.maskView) dispatch({ type: "toggle_mask_view" });
                  return;
                }
                dispatch({ type: "toggle_mask_view" });
              }}
            >
              {state.maskRed ? <MaskOverlayIcon /> : <MaskEyeIcon />}
            </button>
            {/* The owner's round-trip: "polish a mask by converting it to a
selection, go into the Polish tool, update the selection, when you
apply the selection it bakes back down into a mask." The conversion
happens IN PLACE, so there is no separate bake-back: the mask's
render is baked in as the selection's base, polish edits it, and
the result simply is the layer's mask. Undo restores the old mask
type whole.*/}
            {activeInfo.maskType !== "selection" && (
              <button
                className="chip"
                data-testid="mask-polish-convert"
                data-hint="Turn this mask into a selection (its current shape baked in) and polish it: brushes, marquees, dials. Undo restores the old mask"
                style={{ ...MASK_CHIP, fontSize: 9, padding: "1px 7px", letterSpacing: ".06em" }}
                // The same door Select > Polish opens on a Develop
                // layer's live mask (polishdoor.ts).
                onClick={() => polishDevelopMask(state, dispatch, maskNode.id)}
              >
                Polish…
              </button>
            )}
          </div>
          {/* Every mask node carries an invert flag; expose it uniformly. */}
          <MaskInvertRow node={maskNode} dispatch={dispatch} />
          {activeInfo.maskType === "selection" && <FeatherFollowsToggle node={maskNode} dispatch={dispatch} />}
          {/* The mask controls sit in a container padded 12px right and
              18px left, so the Levels width is the panel's less 30. */}
          <DepthMaskBlock maskNode={maskNode} state={state} dispatch={dispatch} testid="mask-depth" width={Math.max(220, (width ?? 320) - 30)} />
          {/* Export Mask as Layer, directly below the Depth mask block, whether
the depth mask is on or not (2026-10-01, asked a third time: "The
Export Mask as Layer option underneath Depth mask in adjustment
layers").*/}
          <LayerMaskExportRow state={state} layerId={activeInfo.id} dispatch={dispatch} testid="layer-mask-export" />
          {activeInfo.maskType === "smart" && (
            <SmartModePanel state={state} dispatch={dispatch} withClear={false} />
          )}
          {activeInfo.maskType === "object" && <ObjectMattePanel state={state} dispatch={dispatch} />}
          {activeInfo.maskType === "range" && (
            <RangeMaskTools
              state={state}
              dispatch={dispatch}
              maskNode={maskNode}
            />
          )}
          {activeInfo.maskType === "range" && (
            <RangeHistogram
              src={
                state.images.find((i) => i.id === state.activeImage)?.src ?? ""
              }
              target={state.pickTarget}
              low={maskNode.params.luma_low ?? 0}
              high={maskNode.params.luma_high ?? 1}
              softness={maskNode.params.softness ?? 0.1}
              hueCenter={maskNode.params.hue_center ?? 0}
              hueWidth={maskNode.params.hue_width ?? 180}
            />
          )}
          {/* Shape first: it decides what the sliders below it mean,
              and which of them are worth showing at all. */}
          {activeInfo.maskType === "radial" && (
            <RadialShapePicker node={maskNode} dispatch={dispatch} />
          )}
          {MASK_ROWS[activeInfo.maskType].map((r) => (
            <Slider
              key={r.param}
              label={r.label}
              param={r.param}
              node={maskNode}
              dispatch={dispatch}
              centered={r.centered !== false}
            />
          ))}
          {/* The gizmo's lines take the same color as every tool's lines over the
photograph (2026-09-07: "the Radial adjustment layer ... needs it as
well"), and the Linear layer's the same as the Radial's ("the same
line color and thickness features as the radius shapes"). The
thickness beside the color is the shared row: this photograph's own
where set, the preference otherwise, the one value every overlay
draws at.*/}
          {(activeInfo.maskType === "radial" || activeInfo.maskType === "linear") && (
            <>
              <LinesRow
                lineColor={state.lineColor}
                dispatch={dispatch}
                previewUrl={state.images.find((i) => i.id === state.activeImage)?.src ?? null}
                prefix={activeInfo.maskType}
                subject={activeInfo.maskType === "radial" ? "mask's outline" : "gradient's lines"}
              />
              <LineWidthRow
                state={state}
                dispatch={dispatch}
                prefix={activeInfo.maskType}
                subject={activeInfo.maskType === "radial" ? "mask's outline" : "gradient's lines"}
              />
            </>
          )}
          {/* No selection controls here: the selection split below the
              panes appears on its own while this layer is active, one
              home for adjustment-layer and pixel-layer selections
              alike. The mask-shaping sliders above stay, because they
              are THIS layer's params. */}
          {activeInfo.maskType === "brush" && (
            <>
              <BrushTipPicker state={state} dispatch={dispatch} />
              <div
                style={{
                  fontSize: 10,
                  color: "var(--text-faint)",
                  lineHeight: 1.5,
                }}
              >
                Paint with the Brush tool in the viewer. {modLabel("alt")} erases.
              </div>
            </>
          )}
          <div
            style={{
              fontSize: 11,
              color: "var(--text-ghost)",
              marginTop: 4,
              lineHeight: 1.5,
            }}
          >
            Sections marked with the layer icon below edit this layer only,
            behind its mask. Source and Geometry stay global.
          </div>
        </div>
      )}
    </div>
  );
}

/** Histogram of the source image with the Range mask's window
 * highlighted, so you can see which part of the spectrum the mask is
 * keying on. Luma or hue, following the pick target: the panel used to
 * show the luma bins whichever target was up ("When
 * switching from Luma to Hue the histogram still only shows luma range
 * and not the hue range"). Hue bins are weighted by saturation, so a
 * gray sky does not pile up on red just because gray has a hue of
 * zero.*/
export function RangeHistogram({
  src,
  target,
  low,
  high,
  softness,
  hueCenter,
  hueWidth,
}: {
  src: string;
  target: PickTarget;
  low: number;
  high: number;
  softness: number;
  hueCenter: number;
  hueWidth: number;
}) {
  const [bins, setBins] = useState<{ luma: number[]; hue: number[] } | null>(null);
  useEffect(() => {
    if (!src) return;
    let live = true;
    const img = new Image();
    img.onload = () => {
      try {
        const w = 96;
        const h = Math.max(
          1,
          Math.round(((img.height || 64) / (img.width || 96)) * w),
        );
        const canvas = document.createElement("canvas");
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext("2d");
        if (!ctx) return;
        ctx.drawImage(img, 0, 0, w, h);
        const data = ctx.getImageData(0, 0, w, h).data;
        const luma = new Array(64).fill(0);
        const hue = new Array(64).fill(0);
        for (let i = 0; i < data.length; i += 4) {
          const r = data[i] / 255;
          const g = data[i + 1] / 255;
          const b = data[i + 2] / 255;
          const l = 0.2126 * r + 0.7152 * g + 0.0722 * b;
          luma[Math.min(63, Math.floor(l * 64))]++;
          const mx = Math.max(r, g, b);
          const mn = Math.min(r, g, b);
          const d = mx - mn;
          if (d <= 0 || mx <= 0) continue;
          let hh =
            mx === r ? ((g - b) / d) % 6 : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
          if (hh < 0) hh += 6;
          hue[Math.min(63, Math.floor((hh / 6) * 64))] += d / mx;
        }
        if (live) setBins({ luma, hue });
      } catch {
        // Canvas unavailable (headless tests): render the window overlay only.
      }
    };
    img.src = src;
    return () => {
      live = false;
    };
  }, [src]);
  const shown = bins ? (target === "hue" ? bins.hue : bins.luma) : null;
  const max = shown ? Math.max(...shown, 1) : 1;
  const soft = Math.min(softness, (high - low) / 2);
  // The window, as spans of the axis in 0..1. Luma is one span with a
  // feathered edge at each end. Hue wraps: a window across red is two
  // spans, one at each end of the strip, and the feather there is the
  // same softness read in degrees.
  const spans: { left: number; width: number; soft: number }[] = [];
  if (target === "hue") {
    const width = Math.max(0, Math.min(180, hueWidth));
    const lo = (((hueCenter - width) % 360) + 360) % 360;
    const hi = (((hueCenter + width) % 360) + 360) % 360;
    const s = Math.min(softness, width / 360);
    if (width >= 180) {
      spans.push({ left: 0, width: 1, soft: 0 });
    } else if (lo <= hi) {
      spans.push({ left: lo / 360, width: (hi - lo) / 360, soft: s });
    } else {
      spans.push({ left: lo / 360, width: 1 - lo / 360, soft: s });
      spans.push({ left: 0, width: hi / 360, soft: s });
    }
  } else {
    spans.push({ left: low, width: high - low, soft });
  }
  return (
    <div data-testid="range-histogram" data-target={target} style={{ marginBottom: 6 }}>
      {/* The same dress as the Levels histogram (every histogram
follows one design): its ink well and its bar color, no frame.*/}
      <div
        style={{
          position: "relative",
          height: 44,
          background: "#111214",
          overflow: "hidden",
          display: "flex",
          alignItems: "flex-end",
        }}
      >
        {(shown ?? new Array(64).fill(0)).map((v, i) => (
          <div
            key={i}
            style={{
              flex: 1,
              height: `${(v / max) * 100}%`,
              background: "#33383c",
              minWidth: 0,
            }}
          />
        ))}
        {/* On the hue axis, a strip of the hues themselves along the
            floor, so a bar can be read as a color and not just a
            position. */}
        {target === "hue" && (
          <div
            aria-hidden="true"
            style={{
              position: "absolute",
              left: 0,
              right: 0,
              bottom: 0,
              height: 3,
              background:
                "linear-gradient(90deg, #e0473c, #e0b13c 17%, #6fcf4a 33%, #3cc8c8 50%, #4a6fe0 67%, #c84ad2 83%, #e0473c)",
              opacity: 0.85,
              pointerEvents: "none",
            }}
          />
        )}
        {/* Selected window; soft edges show the feather. */}
        {spans.map((sp, k) => {
          const l0 = Math.max(0, sp.left - sp.soft);
          const r0 = Math.min(1, sp.left + sp.width + sp.soft);
          const roll = sp.soft > 0 ? (sp.soft / Math.max(1e-4, r0 - l0)) * 100 : 0;
          return (
            <div
              key={k}
              data-testid={k === 0 ? "range-histogram-window" : "range-histogram-window-wrap"}
              style={{
                position: "absolute",
                top: 0,
                bottom: 0,
                left: `${l0 * 100}%`,
                width: `${(r0 - l0) * 100}%`,
                // The gradient is the feather, drawn where it acts: the wash fades in
                // across `soft` at each end and is solid over the fully selected
                // middle, so the shape of the band is the shape of the mask. The owner
                // asked for it back after a flat version showed what it was for. The
                // two limit bars ride the outer edge of the roll and close onto the
                // limits exactly when soft is zero.
                background: `linear-gradient(90deg, transparent, rgba(53,184,224,.28) ${roll}%, rgba(53,184,224,.28) ${100 - roll}%, transparent)`,
                borderLeft: "1px solid var(--accent)",
                borderRight: "1px solid var(--accent)",
                pointerEvents: "none",
              }}
            />
          );
        })}
      </div>
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          fontSize: 8,
          color: "var(--text-ghost)",
          letterSpacing: ".06em",
          marginTop: 2,
        }}
      >
        <span>{target === "hue" ? "0°" : "BLACKS"}</span>
        <span>{target === "hue" ? "MASKED HUE RANGE" : "MASKED LUMA RANGE"}</span>
        <span>{target === "hue" ? "360°" : "WHITES"}</span>
      </div>
    </div>
  );
}

/** The layer's Depth block (2026-09-09): the mask multiplied by a
 * window on the depth map, with near, far, feather and an Invert of
 * its own, so a range layer can act only on what is in range AND at
 * that depth, and one layer's inversion never reaches another's. Off
 * by default; the rows unfold when it is on. Shared by the Develop
 * layers and the Finish layers, which both hand it their mask node.*/
/** A mask's Invert switch, one component for Develop's layer mask block
 * and the mask nodes' Inspector faces (features reach their nodes). */
export function MaskInvertRow({ node, dispatch, testid = "mask-invert" }: { node: NodeCard; dispatch: D; testid?: string }) {
  const on = (node.params.invert ?? 0) !== 0;
  const flip = () => dispatch({ type: "set_param", id: node.id, param: "invert", value: on ? 0 : 1 });
  return (
    <div
      data-node={node.id}
      data-param="invert"
      style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 4 }}
    >
      <div className="lbl" style={{ fontSize: 11, color: "var(--text-body)" }}>
        Invert mask
      </div>
      <div
        className="toggle"
        data-on={on}
        data-testid={testid}
        role="switch"
        aria-checked={on}
        aria-label="Invert mask"
        data-hint="Flips the mask: the effect lands where the mask was empty and leaves where it was full"
        tabIndex={0}
        onKeyDown={(e) => {
          if (e.key === " " || e.key === "Enter") {
            e.preventDefault();
            flip();
          }
        }}
        onClick={flip}
      >
        <div className="dot" />
      </div>
    </div>
  );
}

export function DepthMaskBlock({
  maskNode,
  state,
  dispatch,
  testid,
  width,
  subject = "layer",
  showView = true,
}: {
  maskNode: NodeCard;
  state: State;
  dispatch: D;
  testid: string;
  width?: number;
  /** whose mask this is, for the hints: a layer's, or a Color Set's
   * range (2026-09-13: the same block at the foot of every set)*/
  subject?: "layer" | "set";
  showView?: boolean;
}) {
  const on = (maskNode.params.depth_on ?? 0) !== 0;
  const own = subject === "set" ? "this set's range" : "this layer's mask";
  const others = subject === "set" ? "this set only, other sets' depth masks are untouched" : "this layer only, other layers' depth masks are untouched";
  const inverted = (maskNode.params.depth_invert ?? 0) !== 0;
  const bins = useDepthBins(state, on);
  const set = (param: string, value: number) => dispatch({ type: "set_param", id: maskNode.id, param, value });
  return (
    <div data-testid={testid} style={{ margin: "2px 0 6px" }}>
      <div data-node={maskNode.id} data-param="depth_on" style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 4 }}>
        <div style={{ fontSize: 11, color: "var(--text-body)" }}>Depth mask</div>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          {/* The depth Band's picker, beside the eye (depthband.tsx): a
              click on the subject gives this mask its slice of depth. */}
          {showView && <DepthPickButton state={state} dispatch={dispatch} maskId={maskNode.id} testid={`${testid}-pick`} />}
          {on && showView && (
            <DepthViewButton
              depthView={state.depthView}
              onToggle={(flavor) => dispatch({ type: "toggle_depth_view", flavor, mask: maskNode.id })}
              testid={`${testid}-view`}
              red={state.maskRed}
              mask={true}
              maskShown={depthMaskShown(state, maskNode.id)}
              whose={subject === "set" ? "set's range" : "layer's mask"}
              coversMask={maskPreviewNode(state) === maskNode.id}
            />
          )}
          <div
            className="toggle"
            data-on={on}
            data-testid={`${testid}-toggle`}
            role="switch"
            aria-checked={on}
            aria-label="Depth mask"
            data-hint={`Multiplies ${own} by the depth map: the nearest takes full effect, the farthest none; the model computes it when first asked`}
            tabIndex={0}
            onKeyDown={(e) => {
              if (e.key === " " || e.key === "Enter") {
                e.preventDefault();
                set("depth_on", on ? 0 : 1);
              }
            }}
            onClick={() => set("depth_on", on ? 0 : 1)}
          >
            <div className="dot" />
          </div>
        </div>
      </div>
      {on && (
        <>
          {/* The Levels widget on the depth map ("the exact same
histogram widget as found in LEVELS ... No sliders").*/}
          <div style={{ margin: "2px 0 6px" }}>
            <DepthShape
              maskNode={maskNode}
              dispatch={dispatch}
              width={width ?? 272}
              bins={bins}
              testPrefix={testid}
              levels={
                <div data-node={maskNode.id} data-params={Object.values(DEPTH_LEVELS_KEYS).join(" ")}>
                  <LevelsEditor
                    state={state}
                    node={maskNode}
                    dispatch={dispatch}
                    width={width ?? 272}
                    bins={bins}
                    keys={DEPTH_LEVELS_KEYS}
                    falloff={true}
                    testPrefix={`${testid}-levels`}
                    hint={DEPTH_LEVELS_HINT}
                  />
                </div>
              }
            />
          </div>
          <div data-node={maskNode.id} data-param="depth_invert" style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 4 }}>
            <div style={{ fontSize: 11, color: "var(--text-body)" }}>Invert depth</div>
            <div
              className="toggle"
              data-on={inverted}
              data-testid={`${testid}-invert`}
              role="switch"
              aria-checked={inverted}
              aria-label="Invert depth"
              data-hint={`Reads the depth map the other way: the farthest takes the full effect, the nearest none; ${others}`}
              tabIndex={0}
              onKeyDown={(e) => {
                if (e.key === " " || e.key === "Enter") {
                  e.preventDefault();
                  set("depth_invert", inverted ? 0 : 1);
                }
              }}
              onClick={() => set("depth_invert", inverted ? 0 : 1)}
            >
              <div className="dot" />
            </div>
          </div>
        </>
      )}
    </div>
  );
}

/** Levels on the depth map for a section that reads it (2026-09-13:
 * "On Depth Map, Fog, and Depth Lighting add the same levels control
 * that adjustment layers have when Depth mask is turned on"). Fog
 * and Depth Lighting keep their own, applied to the plane as they
 * read it; the Depth Map section's are the map's own, applied to the
 * plane every depth reader is handed, so its histogram is the raw
 * plane's while the others' show the map as it reaches them.*/
export function DepthPlaneLevels({
  node,
  state,
  dispatch,
  testid,
  width,
  hint,
  raw,
}: {
  node: NodeCard;
  state: State;
  dispatch: D;
  testid: string;
  width?: number;
  hint: string;
  raw?: boolean;
}) {
  const bins = useDepthBins(state, true, raw);
  return (
    <div data-testid={testid} style={{ margin: "2px 0 6px" }}>
      <LevelsEditor
        state={state}
        node={node}
        dispatch={dispatch}
        width={width ?? 272}
        bins={bins}
        keys={DEPTH_LEVELS_KEYS}
        falloff={true}
        testPrefix={`${testid}-levels`}
        hint={hint}
      />
    </div>
  );
}

const DEPTH_PLANE_HINTS: Record<string, string> = {
  depthmap: "Levels on the map itself, read by every depth tool and depth mask: below Black is farthest, above White nearest, Gamma bends the depths between",
  fog: "Levels on the map as Fog reads it: below Black no fog, above White the thickest, Gamma bends the depths between; this section only",
  keylight: "Levels on the map as Depth Lighting reads it: below Black the far floor, above White the nearest relief, Gamma bends between; this section only",
};

export function SharpeningRecipeControl({ node, dispatch, select = false }: { node: NodeCard; dispatch: D; select?: boolean }) {
  // The mode first: on a section not built yet it is the write that
  // builds the group (one undo step, switched on), and the switch after
  // it is then already said. On a built node that is off it switches it on.
  const choose = (mode: string) => {
    dispatch({ type: "set_text_param", id: node.id, param: "mode", value: mode });
    if (!node.enabled) dispatch({ type: "set_enabled", id: node.id, enabled: true });
  };
  if (select) return <div className="srow" style={{ gridTemplateColumns: "78px 1fr" }}>
    <div className="lbl">Recipe</div>
    <MenuField testid="node-option-mode" label="Recipe" node={node.id} param="mode" size="regular"
      value={node.textParams?.mode ?? "vivid"} options={RECIPES} fitLabels={RECIPES.map((r) => r.label)}
      onChange={choose} />
  </div>;
  return <div className="srow" style={{ gridTemplateColumns: "78px 1fr" }}>
    <div className="lbl">Recipe</div>
    <div className="zoom-seg" role="group" aria-label="Sharpening recipe" style={{ border: "1px solid var(--line-4)", justifySelf: "start" }}>
      {([ ["vivid", "Vivid", "Inverted blur laid back through Vivid Light"], ["hipass", "Hi Pass", "A desaturated high pass through Overlay"] ] as const).map(([id,label,hint]) =>
        <button key={id} data-active={(node.textParams?.mode ?? "vivid") === id} data-testid={`sharpen-mode-${id}`} data-hint={hint} onClick={() => choose(id)}>{label}</button>)}
    </div>
  </div>;
}

export function Slider({
  label,
  param,
  node,
  dispatch,
  centered = true,
  hint,
  overridden = false,
  onContextMenu,
  tip,
  live = false,
  range,
  flash,
  fit = false,
}: {
  label: string;
  param: string;
  node: NodeCard;
  dispatch: D;
  centered?: boolean;
  /** the letter to press to reach this control, while hinting */
  hint?: string;
  /** what this dial does, for the status line on hover */
  tip?: string;
  /** this is the control the movement keys are driving */
  live?: boolean;
  /** Find a Control just landed here: the same border, but fading out
   * on its own. Separate from `live` because the navigator's outline
   * must stay put while the keys are driving. */
  flash?: boolean;
  /** The label is a name nobody fitted to the 78px column (the graph
   * Inspector's generic rows, worded from the param): ellipsized
   * inside its column with the whole name on hover, so a long one
   * ("Max displacement") never runs into the track. */
  fit?: boolean;
  /** editorial span for THIS control, when the param's usual range is
   * tuned for a different context (typing past it still works) */
  range?: [number, number];
  /** This dial keeps its own value inside the photo's link: drawn
   * with a dotted outline in the edits' orange.*/
  overridden?: boolean;
  onContextMenu?: (e: React.MouseEvent<HTMLDivElement>) => void;
}) {
  const [lo, hi] = range ?? paramRange(param, node.type);
  const [hardLo, hardHi] = hardRange(param, node.type);
  // Unset params display at their registry default, not zero.
  const v = node.params[param] ?? paramDefault(param, node.type);

  /** Write a value straight in, for the typed field. */
  const setValue = (value: number) =>
    dispatch({ type: "set_param", id: node.id, param, value });

  return (
    <div
      className="srow"
      // Named by node AND param. A param name is not unique across the
      // panel: `amount` belongs to both Bend and Unsharp, `radius` to a
      // blur and a brush, `opacity` to every blend. Keyed on the param
      // alone, two of them answer to the same name and whichever the DOM
      // happens to hold first wins.
      data-testid={`slider-${param}`}
      data-node={node.id}
      data-param={param}
      data-live={live || undefined}
      data-override={overridden || undefined}
      data-hint={sliderHint(tip, overridden)}
      onContextMenu={onContextMenu}
      style={{
        position: "relative",
        ...(overridden ? { outline: "1px dotted var(--warn)", outlineOffset: 2, borderRadius: 2 } : {}),
      }}
    >
      {/* The live control is outlined rather than filled: it has to be
findable at a glance without turning into the brightest thing in a
panel full of color. Drawn a few pixels WIDER than the row (The
report: "the left and right edges of the border need a little buffer
space"): the row's box hugs its label and value exactly, and a
border on the box itself sat pressed against both.*/}
      {(live || flash) && (
        <div
          data-testid={`live-outline-${param}`}
          className={live ? undefined : "control-flash"}
          style={{
            position: "absolute",
            top: 0,
            bottom: 0,
            left: -5,
            right: -5,
            border: "1px solid var(--accent)",
            pointerEvents: "none",
          }}
        />
      )}
      {hint && <HintKey hint={hint} testid={`hint-${param}`} />}
      <div className={fit ? "lbl fit" : "lbl"} title={fit ? label : undefined} style={{ opacity: hint ? 0.3 : undefined }}>
        {label}
      </div>
      <TrackSlider
        label={label}
        value={v}
        lo={lo}
        hi={hi}
        centered={centered}
        onBegin={() => dispatch({ type: "begin_gesture", key: `${node.id}.${param}` })}
        onChange={(value) => dispatch({ type: "set_param", id: node.id, param, value })}
        onEnd={() => dispatch({ type: "end_gesture" })}
        // "I should be able to type values in and not just use the
        // slider." A slider is for feel and a number is for precision, and the
        // two want different things: dragging cannot hit 6500 Kelvin on purpose,
        // and typing cannot find the point where a picture looks right. So the
        // readout became the field. It takes the HARD limits, not the slider's:
        // the number beside a control is where a value beyond it gets typed.
        // Handed the track's shown value, so it follows the hand mid-drag.
        readout={(shown) => (
          <ValueField
            param={param}
            value={shown}
            lo={hardLo}
            hi={hardHi}
            beyond={shown < lo || shown > hi}
            onCommit={setValue}
          />
        )}
      />
    </div>
  );
}

/** A Develop layer's Opacity (2026-09-30: "Adjustment layers are
 * missing an opacity slider. That would be a nice touch."). How much
 * of the layer's edit applies, on top of its mask: the engine scales
 * the mask by it on every node the mask gates, so 50 is half the layer
 * everywhere the mask is on. Stored as `opacity` on the layer's own
 * node, missing is 100, so a graph from before reads as it rendered.
 *
 * One component for both faces, the layer's block in Develop and the
 * layer's node in the graph inspector, so the two cannot drift. The
 * mask eye still shows the mask itself: opacity is how much of the
 * layer comes through it, not a change to where. */
export function LayerOpacitySlider({ node, dispatch }: { node: NodeCard; dispatch: D }) {
  return (
    <Slider
      label="Opacity"
      param="opacity"
      node={node}
      dispatch={dispatch}
      centered={false}
      tip="How much of this layer's edit comes through, where its mask lets it; 100 is all of it"
    />
  );
}

/** The number beside a slider, which is also how you set it.
 *
 * Held as text while it is being edited rather than driving the parameter on
 * every keystroke: typing "-" or "0." or clearing the box to start again are
 * all states a number cannot hold, and pushing each of them through as a
 * value makes the picture flicker and the caret jump.
 */
/** The recipe behind a stacked photo: which frames, merged how.
 *
 * Shown only when the open image is a stack. Everything here rewrites
 * the manifest and re-renders, because the merge was never baked: a
 * stack shot as an HDR can become a median a month later without
 * reselecting anything. */
export function StackPanel({ state, dispatch }: { state: State; dispatch: D }) {
  const [info, setInfo] = useState<StackInfo | null>(null);
  const [busy, setBusy] = useState(false);
  // The member list is selectable (click, ctrl-click, shift-click,
  // same grammar as the ribbon) so frames can leave in one gesture.
  // The context menu is where removal lives, : "Remove frames should
  // be from a context menu."
  const [picked, setPicked] = useState<string[]>([]);
  const anchor = useRef<string | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const menuRef = useDismiss<HTMLDivElement>(menu !== null, () => setMenu(null));
  const image = state.activeImage;

  useEffect(() => {
    let live = true;
    setPicked([]);
    setMenu(null);
    void stackInfo(image)
      .then((i) => live && setInfo(i))
      .catch(() => live && setInfo(null));
    return () => {
      live = false;
    };
  }, [image]);

  if (!info) return null;

  const change = (c: { mode?: string; align?: boolean; members?: string[] }) => {
    setBusy(true);
    void updateStack(image, c)
      .then((next) => {
        if (next) setInfo(next);
        // The pixels changed without the graph changing, so nudge the
        // preview: nothing else would know to re-render.
        dispatch({ type: "resume_stack_merge", image });
      })
      .catch((e) => logMsg("error", `Stack update failed: ${String(e)}`))
      .finally(() => setBusy(false));
  };

  return (
    <div
      style={{
        borderBottom: "1px solid var(--line-1)",
        padding: "9px 12px 11px",
      }}
      data-testid="stack-panel"
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          marginBottom: 7,
        }}
      >
        <div
          style={{
            fontSize: 11,
            fontWeight: 600,
            letterSpacing: ".10em",
            color: "#c7ccd0",
            textTransform: "uppercase",
          }}
        >
          Stack
        </div>
        <div
          className="tnum"
          style={{ fontSize: 9, color: "var(--text-ghost)", flex: 1 }}
          data-testid="stack-count"
        >
          {info.members.length} FRAMES
        </div>
        <button
          className="chip"
          data-testid="stack-add-frames"
          data-hint="Append frames from the stack's folder; the picker opens beside it"
          disabled={busy}
          style={{ fontSize: 9, padding: "1px 7px" }}
          onClick={() => {
            setBusy(true);
            void stackAddFrames(image)
              .then((next) => {
                // Null is a canceled dialog: nothing changed, nothing
                // to re-render.
                if (!next) return;
                setInfo(next);
                dispatch({ type: "bump_preview" });
              })
              .catch((e) => logMsg("error", `Add frames failed: ${String(e)}`))
              .finally(() => setBusy(false));
          }}
        >
          + ADD
        </button>
      </div>

      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          marginBottom: 7,
        }}
      >
        <div className="kicker">Merge</div>
        <div
          className="zoom-seg"
          role="group"
          aria-label="Merge mode"
          style={{ border: "1px solid var(--line-4)" }}
        >
          {STACK_KINDS.map((k) => (
            <button
              key={k.mode}
              data-active={info.mode === k.mode}
              data-testid={`stack-mode-${k.mode}`}
              data-hint={k.hint}
              disabled={busy}
              style={{
                fontSize: 9,
                padding: "1px 6px",
                textTransform: "uppercase",
              }}
              onClick={() => change({ mode: k.mode })}
            >
              {k.mode}
            </button>
          ))}
        </div>
      </div>

      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          marginBottom: 7,
        }}
      >
        <div style={{ fontSize: 11, color: "var(--text-body)" }}>
          Align frames
        </div>
        <div
          className="toggle"
          data-on={info.align}
          data-testid="stack-align"
          role="switch"
          aria-checked={info.align}
          aria-label="Align frames"
          data-hint="Line the frames up before merging: right for handheld bursts. Turn OFF for star trails and murmurations, where the moving subject IS the picture"
          tabIndex={0}
          onClick={() => !busy && change({ align: !info.align })}
        >
          <div className="dot" />
        </div>
      </div>

      {info.missing.length > 0 && (
        <div
          style={{
            fontSize: 9,
            color: "var(--accent)",
            lineHeight: 1.5,
            marginBottom: 6,
          }}
          data-testid="stack-missing"
        >
          {info.missing.length} of {info.members.length} frames are missing from
          this folder, so the merge is running without them:{" "}
          {info.missing.join(", ")}
        </div>
      )}

      {/* HDR divides each frame by its exposure as if its light were
          linear. A JPEG still carries the camera's tone curve, so the
          merge is approximate: the stacking review (R3, 2026-10-08)
          measured a camera JPEG two stops over at 4.9 to 7.8 times its
          0 EV frame where the RAW measured 4. Said here, not refused. */}
      {info.mode === "hdr" && (info.rendered?.length ?? 0) > 0 && (
        <div className="help" style={{ color: "var(--accent)", marginBottom: 6 }} data-testid="stack-hdr-rendered">
          {info.rendered!.length === info.members.length
            ? "These frames are finished pictures, not RAW: the camera's tone curve is still in them, so this HDR merge is approximate, by up to about a stop. Merge the RAW files for an accurate result."
            : `${info.rendered!.length} of ${info.members.length} frames are finished pictures, not RAW (${info.rendered!.join(", ")}): their light does not match the RAW frames', so this HDR merge is approximate. Merge only RAW files for an accurate result.`}
        </div>
      )}

      <div
        style={{
          display: "flex",
          flexDirection: "column",
          gap: 2,
          // Ten rows, then it scrolls ("when there are more than 10
          // frames the list should be scrollable"): a hundred-frame trail stack
          // must not push the panel off the bottom. Sized to the 1.15x row
          // type, so ten still show before the bar.
          maxHeight: 170,
          overflowY: "auto",
        }}
        data-testid="stack-members"
      >
        {info.members.map((m) => {
          const selected = picked.includes(m);
          const pick = (e: React.MouseEvent) => {
            if (e.shiftKey && anchor.current) {
              const a = info.members.indexOf(anchor.current);
              const b = info.members.indexOf(m);
              if (a >= 0 && b >= 0) {
                setPicked(info.members.slice(Math.min(a, b), Math.max(a, b) + 1));
                return;
              }
            }
            if (e.metaKey || e.ctrlKey) {
              setPicked(selected ? picked.filter((p) => p !== m) : [...picked, m]);
            } else {
              setPicked(selected && picked.length === 1 ? [] : [m]);
            }
            anchor.current = m;
          };
          return (
            <div
              key={m}
              data-testid={`stack-member-${m}`}
              data-selected={selected}
              onClick={pick}
              onContextMenu={(e) => {
                e.preventDefault();
                // Right-clicking outside the selection moves it there
                // first, same rule as the ribbon: the menu always acts
                // on what is highlighted.
                if (!selected) {
                  setPicked([m]);
                  anchor.current = m;
                }
                setMenu({ x: e.clientX, y: e.clientY });
              }}
              style={{
                // 9 x 1.15, the owner's factor ("Scale fonts of the names of the
                // frames... by 1.15x"): this row lives INSIDE the ui-zoom panel, so
                // the 1.15 is relative to the chrome and right at every zoom step. The
                // context menu is portaled out of the zoom and reads the live step
                // instead (see below).
                fontSize: 10.35,
                cursor: "default",
                padding: "1px 4px",
                borderRadius: 3,
                // flex none, or the column SHRINKS its children to fit maxHeight
                // instead of overflowing into the scrollbar: past thirteen frames
                // every row squeezed to a few pixels and the names clipped to dotted
                // slivers (the owner's screenshot: "The frames list is broken").
                flex: "none",
                background: selected ? "var(--accent-tint)" : undefined,
                color: info.missing.includes(m)
                  ? "var(--reject)"
                  : selected
                    ? "var(--accent)"
                    : "var(--text-faint)",
                whiteSpace: "nowrap",
                overflow: "hidden",
                textOverflow: "ellipsis",
                textDecoration: info.missing.includes(m)
                  ? "line-through"
                  : undefined,
              }}
            >
              {m}
            </div>
          );
        })}
      </div>
      {menu &&
        (() => {
          const chosen = picked.length ? picked : [];
          const tooFew = info.members.length - chosen.length < 2;
          // Members are file names; the ribbon speaks image ids. A
          // frame the folder listing does not carry (filtered out,
          // missing) simply is not selectable there.
          const ribbonIds = chosen
            .map((m) => state.images.find((i) => i.name === m)?.id)
            .filter((id): id is string => !!id);
          // Clamped like every context menu: this one lives in the right
          // panel, so opening at the pointer pushed it off the window's right
          // edge and squeezed the labels (the owner's screenshot). clampMenu
          // flips it to the pointer's left.
          const at = clampMenu(menu, { w: 165, h: 64 }, viewportSize());
          return createPortal(
            <div
              ref={menuRef}
              data-testid="stack-member-menu"
              style={{
                position: "fixed",
                left: at.x,
                top: at.y,
                zIndex: 80,
                display: "flex",
                flexDirection: "column",
                gap: 3,
                background: "var(--bg-panel)",
                border: "1px solid var(--line-4)",
                borderRadius: "var(--radius-btn)",
                boxShadow: "0 10px 28px rgba(0,0,0,.5)",
                padding: 5,
              }}
            >
              <button
                className="chip"
                data-testid="stack-remove-frames"
                disabled={busy || tooFew}
                data-hint={
                  tooFew
                    ? "A stack needs at least two frames; remove fewer, or Move to Trash from the ribbon"
                    : "Take the selected frames out of the merge; the files themselves stay put"
                }
                style={{ fontSize: 9 * chromeZoomFactor(), padding: "3px 9px", textAlign: "left", whiteSpace: "nowrap" }}
                onClick={() => {
                  setMenu(null);
                  setPicked([]);
                  change({ members: info.members.filter((m) => !chosen.includes(m)) });
                }}
              >
                Remove {chosen.length === 1 ? "frame" : `${chosen.length} frames`}
              </button>
              <button
                className="chip"
                data-testid="stack-select-in-ribbon"
                disabled={ribbonIds.length === 0}
                data-hint="Highlight these frames in the thumbnail strip and scroll to them"
                style={{ fontSize: 9 * chromeZoomFactor(), padding: "3px 9px", textAlign: "left", whiteSpace: "nowrap" }}
                onClick={() => {
                  setMenu(null);
                  dispatch({ type: "select_images", ids: ribbonIds });
                  // Center on the first of them; the state handed down is pre-dispatch,
                  // so the active image is patched in. Instant rather than smooth: the
                  // smooth glide left WKWebView painting a blank strip until the mouse
                  // wheel turned (the owner's report), and the instant path carries its
                  // own repaint nudge.
                  revealActiveThumb({ ...state, activeImage: ribbonIds[0] }, dispatch, {
                    expand: true,
                    behavior: "auto",
                  });
                }}
              >
                Select in ribbon
              </button>
            </div>,
            // Portaled to the body, OUT of the panel's ui-zoom: a position fixed
            // element inside a zoomed subtree has its coordinates scaled by the
            // zoom, which painted the menu 1.15x to the right of the pointer (The
            // report: "my mouse was over the name of the frame and the context
            // menu pops up on the other side"). Same escape the thumb menu's
            // FixedMenu makes, for the same reason.
            document.body,
          );
        })()}
    </div>
  );
}

/** How a panorama is projected. Not a cosmetic choice: a cylinder keeps
 * verticals vertical and is right for a single row, a sphere is the only
 * one that survives a full turn or more than one row, and a plane keeps
 * straight lines straight but explodes past about ninety degrees. */
const PANO_SURFACES: { id: string; label: string; hint: string }[] = [
  { id: "auto", label: "Auto", hint: "Pick from how much the frames tilt" },
  {
    id: "cylindrical",
    label: "Cyl",
    hint: "Verticals stay vertical: one row of frames",
  },
  {
    id: "spherical",
    label: "Sph",
    hint: "Survives a full turn and more than one row",
  },
  {
    id: "planar",
    label: "Flat",
    hint: "Straight lines stay straight, under 90 degrees",
  },
];

/** The recipe behind a stitched photo: which frames, projected how.
 *
 * Shown only when the open image is a panorama. Like a stack, nothing
 * here was baked: changing the surface rewrites the manifest and
 * re-stitches, so a panorama made on a cylinder can go on a sphere later
 * without reselecting anything. */
export function PanoPanel({ state, dispatch }: { state: State; dispatch: D }) {
  const [info, setInfo] = useState<PanoInfo | null>(null);
  const [busy, setBusy] = useState(false);
  const image = state.activeImage;

  useEffect(() => {
    let live = true;
    void panoInfo(image)
      .then((i) => live && setInfo(i))
      .catch(() => live && setInfo(null));
    return () => {
      live = false;
    };
  }, [image]);

  if (!info) return null;

  const change = (c: {
    surface?: string;
    gain_compensation?: boolean;
    straighten?: boolean;
  }) => {
    setBusy(true);
    void updatePano(image, c)
      .then((next) => {
        if (next) setInfo(next);
        // The pixels changed without the graph changing, so nudge the
        // preview: nothing else would know to re-render.
        dispatch({ type: "resume_pano_stitch", image });
      })
      .catch((e) => logMsg("error", `Panorama update failed: ${String(e)}`))
      .finally(() => setBusy(false));
  };

  const toggle = (
    label: string,
    on: boolean,
    testid: string,
    hint: string,
    set: () => void,
  ) => (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        marginBottom: 7,
      }}
    >
      <div style={{ fontSize: 11, color: "var(--text-body)" }} data-hint={hint}>
        {label}
      </div>
      <div
        className="toggle"
        data-on={on}
        data-testid={testid}
        role="switch"
        aria-checked={on}
        aria-label={label}
        tabIndex={0}
        onClick={() => !busy && set()}
      >
        <div className="dot" />
      </div>
    </div>
  );

  return (
    <div
      style={{
        borderBottom: "1px solid var(--line-1)",
        padding: "9px 12px 11px",
      }}
      data-testid="pano-panel"
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          marginBottom: 7,
        }}
      >
        <div
          style={{
            fontSize: 11,
            fontWeight: 600,
            letterSpacing: ".10em",
            color: "#c7ccd0",
            textTransform: "uppercase",
          }}
        >
          Panorama
        </div>
        <div
          className="tnum"
          style={{ fontSize: 9, color: "var(--text-ghost)" }}
          data-testid="pano-count"
        >
          {info.members.length} FRAMES
        </div>
      </div>

      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          marginBottom: 7,
        }}
      >
        <div className="kicker">Project</div>
        <div
          className="zoom-seg"
          role="group"
          aria-label="Projection surface"
          style={{ border: "1px solid var(--line-4)" }}
        >
          {PANO_SURFACES.map((s) => (
            <button
              key={s.id}
              data-active={info.surface === s.id}
              data-testid={`pano-surface-${s.id}`}
              data-hint={s.hint}
              disabled={busy}
              style={{
                fontSize: 9,
                padding: "1px 6px",
                textTransform: "uppercase",
              }}
              onClick={() => change({ surface: s.id })}
            >
              {s.label}
            </button>
          ))}
        </div>
      </div>

      {toggle(
        "Match exposure",
        info.gain_compensation,
        "pano-gain",
        "Even out brightness between frames metered separately",
        () => change({ gain_compensation: !info.gain_compensation }),
      )}
      {toggle(
        "Straighten",
        info.straighten,
        "pano-straighten",
        "Level the horizon: nobody pans a camera level",
        () => change({ straighten: !info.straighten }),
      )}

      {info.missing.length > 0 && (
        <div
          style={{
            fontSize: 9,
            color: "var(--accent)",
            lineHeight: 1.5,
            marginBottom: 6,
          }}
          data-testid="pano-missing"
        >
          {info.missing.length} of {info.members.length} frames are missing from
          this folder: {info.missing.join(", ")}
        </div>
      )}

      {/* A canceled stitch stays canceled until asked, so the panel
          offers the way back as well as the card did. */}
      {state.stitchCanceled[state.activeImage] && (
        <div className="help" style={{ color: "var(--accent)", marginBottom: 6, display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }} data-testid="pano-canceled">
          <span>Stitch canceled.</span>
          <button
            className="chip"
            type="button"
            data-testid="pano-stitch-again"
            style={{ fontSize: 11 }}
            onClick={() => {
              const image = state.activeImage;
              void resumePanoStitch(image).then(() => dispatch({ type: "resume_pano_stitch", image }));
            }}
          >
            Stitch again
          </button>
        </div>
      )}

      <div
        style={{ display: "flex", flexDirection: "column", gap: 2 }}
        data-testid="pano-members"
      >
        {info.members.map((m) => (
          <div
            key={m}
            style={{
              fontSize: 9,
              color: info.missing.includes(m)
                ? "var(--reject)"
                : "var(--text-faint)",
              whiteSpace: "nowrap",
              overflow: "hidden",
              textOverflow: "ellipsis",
              textDecoration: info.missing.includes(m)
                ? "line-through"
                : undefined,
            }}
          >
            {m}
          </div>
        ))}
      </div>
    </div>
  );
}

/** Per-band and per-channel weighting for texture, clarity and dehaze,
 * the same treatment grain has. Each slider is a real param on the node,
 * so Graph mode edits the identical values. */
export function DetailAdvanced({
  node,
  dispatch,
}: {
  node: NodeCard;
  dispatch: D;
}) {
  const [open, setOpen] = useState(false);
  const [effect, setEffect] =
    useState<(typeof DETAIL_EFFECTS)[number]>("texture");
  // A weight is "in use" when it is off 100, which is what the badge
  // reports: otherwise the panel gives no sign it is doing anything.
  const touched = DETAIL_EFFECTS.filter((e) =>
    DETAIL_WEIGHTS.some(([w]) => (node.params[`${e}_${w}`] ?? 100) !== 100),
  );

  return (
    <div style={{ marginTop: 8 }} data-testid="detail-advanced">
      <button
        className="chip"
        data-testid="detail-advanced-toggle"
        data-active={open}
        data-hint="Weight texture, clarity and dehaze by tonal band and by channel"
        style={{
          fontSize: 9,
          padding: "2px 8px",
          letterSpacing: ".08em",
          display: "flex",
          alignItems: "center",
          gap: 6,
        }}
        onClick={() => setOpen(!open)}
      >
        <svg
          width="9"
          height="9"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.6"
          style={{ transform: open ? "rotate(90deg)" : "none" }}
        >
          <path d="M9 6l6 6-6 6" />
        </svg>
        ADVANCED
        {touched.length > 0 && (
          <span
            style={{ color: "var(--accent)" }}
            data-testid="detail-advanced-badge"
          >
            {touched.length}
          </span>
        )}
      </button>
      {open && (
        <div style={{ marginTop: 7 }}>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              marginBottom: 6,
            }}
          >
            <div className="kicker">Weight</div>
            <div
              className="zoom-seg"
              role="group"
              aria-label="Detail effect to weight"
              style={{ border: "1px solid var(--line-4)" }}
            >
              {DETAIL_EFFECTS.map((e) => (
                <button
                  key={e}
                  data-active={effect === e}
                  data-testid={`detail-effect-${e}`}
                  style={{
                    fontSize: 9,
                    padding: "1px 7px",
                    textTransform: "capitalize",
                  }}
                  onClick={() => setEffect(e)}
                >
                  {e}
                </button>
              ))}
            </div>
            <button
              className="chip"
              data-testid="detail-advanced-reset"
              data-hint="Put this effect's weights back to even"
              style={{ fontSize: 9, padding: "1px 7px", marginLeft: "auto" }}
              onClick={() =>
                dispatch({
                  type: "set_params",
                  id: node.id,
                  values: Object.fromEntries(
                    DETAIL_WEIGHTS.map(([w]) => [`${effect}_${w}`, 100]),
                  ),
                })
              }
            >
              Even
            </button>
          </div>
          {DETAIL_WEIGHTS.map(([w, label]) => (
            <Slider
              key={`${effect}_${w}`}
              label={label}
              param={`${effect}_${w}`}
              node={node}
              dispatch={dispatch}
              centered={false}
            />
          ))}
          <div
            style={{
              fontSize: 9,
              color: "var(--text-ghost)",
              marginTop: 6,
              lineHeight: 1.5,
            }}
          >
            100 leaves {effect} as the slider above sets it. Lower confines it,
            higher pushes it harder in that band or channel.
          </div>
        </div>
      )}
    </div>
  );
}

/** The strip above the band sliders: each band's setting as a point on
 * a line from fine to broad, raised above the middle or lowered below
 * it, so the five read as one curve at a glance. */
function DetailEqStrip({ node, width }: { node: NodeCard; width: number }) {
  const h = 44;
  const pad = 10;
  const xs = DETAIL_EQ_BANDS.map((_, i) => pad + (i * (width - 2 * pad)) / 4);
  const ys = DETAIL_EQ_BANDS.map(([p]) => h / 2 - ((node.params[p] ?? 0) / 100) * (h / 2 - 5));
  const path = xs.map((x, i) => `${i ? "L" : "M"}${x.toFixed(1)},${ys[i].toFixed(1)}`).join(" ");
  return (
    <svg width={width} height={h + 12} data-testid="detail-eq-strip" aria-hidden="true" style={{ display: "block" }}>
      <line x1={pad} x2={width - pad} y1={h / 2} y2={h / 2} stroke="var(--line-4)" strokeDasharray="2 3" />
      <path d={path} fill="none" stroke="var(--accent)" strokeWidth={1.5} />
      {xs.map((x, i) => (
        <g key={i}>
          <circle cx={x} cy={ys[i]} r={2.5} fill="var(--accent)" />
          <text x={x} y={h + 10} fontSize={8} textAnchor="middle" fill="var(--text-ghost)">
            {DETAIL_EQ_BANDS[i][1]}
          </text>
        </g>
      ))}
    </svg>
  );
}

/** The Detail Equalizer, a fold of its own inside Detail: contrast raised
 * or lowered at five scales of detail, each band with an eye that shows
 * that band alone on the canvas, and the six weights Texture has, shared
 * by every band. Its node (heeler.detail_eq) is built on the first band
 * or weight that moves, right after the Detail node, the way Unsharp
 * builds Sharpen; it follows the selected layer like the rest of Detail. */
export function DetailEqualizer({ state, dispatch, width }: { state: State; dispatch: D; width: number }) {
  const [open, setOpen] = useState(false);
  const [weightsOpen, setWeightsOpen] = useState(false);
  const node = toolNode(state, "detaileq");
  if (!node) return null;
  const built = state.nodes.some((n) => n.id === node.id);
  const moved = DETAIL_EQ_BANDS.filter(([p]) => (node.params[p] ?? 0) !== 0).length;
  const weighted = DETAIL_WEIGHTS.some(([w]) => (node.params[w] ?? 100) !== 100);
  const view = state.detailEqView?.id === node.id && detailEqViewOn(state) ? state.detailEqView.band : null;
  return (
    <div style={{ marginTop: 8 }} data-testid="detail-eq" data-params={DETAIL_EQ_PARAMS}>
      <button
        className="chip"
        data-testid="detail-eq-toggle"
        data-active={open}
        data-hint="Raise or lower contrast at five scales of detail, from the finest texture to broad shapes"
        style={{ fontSize: 9, padding: "2px 8px", letterSpacing: ".08em", display: "flex", alignItems: "center", gap: 6 }}
        onClick={() => setOpen(!open)}
      >
        <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" style={{ transform: open ? "rotate(90deg)" : "none" }}>
          <path d="M9 6l6 6-6 6" />
        </svg>
        EQUALIZER
        {moved > 0 && (
          <span style={{ color: "var(--accent)" }} data-testid="detail-eq-badge">
            {moved}
          </span>
        )}
      </button>
      {open && (
        <div style={{ marginTop: 7 }}>
          <DetailEqStrip node={node} width={Math.max(200, width - 24)} />
          {DETAIL_EQ_BANDS.map(([p, label, tip], i) => (
            <div key={p} style={{ display: "flex", alignItems: "center", gap: 4 }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <Slider label={label} param={p} node={node} dispatch={dispatch} tip={tip} />
              </div>
              <button
                className="chip"
                data-testid={`detail-eq-view-${p}`}
                data-active={view === i + 1}
                disabled={!built}
                aria-label={`View the ${label} band`}
                data-tip={`View the ${label} band`}
                data-hint={
                  built
                    ? `Show only the ${label.toLowerCase()} band's detail, as gray texture`
                    : "Move a band first: the view shows the equalizer's own bands"
                }
                style={{ padding: "2px 6px", display: "inline-flex", opacity: built ? 1 : 0.4 }}
                onClick={() => dispatch({ type: "toggle_detail_eq_view", id: node.id, band: i + 1 })}
              >
                <MaskEyeIcon />
              </button>
            </div>
          ))}
          <div style={{ display: "flex", alignItems: "center", gap: 8, margin: "6px 0 4px" }}>
            <button
              className="chip"
              data-testid="detail-eq-weights-toggle"
              data-active={weightsOpen}
              data-hint="Weight the equalizer by tonal band and by channel"
              style={{ fontSize: 9, padding: "1px 7px", letterSpacing: ".08em" }}
              onClick={() => setWeightsOpen(!weightsOpen)}
            >
              WEIGHTS{weighted ? " \u2022" : ""}
            </button>
            {weightsOpen && (
              <button
                className="chip"
                data-testid="detail-eq-weights-reset"
                data-hint="Put the equalizer's weights back to even"
                style={{ fontSize: 9, padding: "1px 7px", marginLeft: "auto" }}
                onClick={() =>
                  dispatch({ type: "set_params", id: node.id, values: Object.fromEntries(DETAIL_WEIGHTS.map(([w]) => [w, 100])) })
                }
              >
                Even
              </button>
            )}
          </div>
          {weightsOpen &&
            DETAIL_WEIGHTS.map(([w, label]) => (
              <Slider key={w} label={label} param={w} node={node} dispatch={dispatch} centered={false} />
            ))}
          <div style={{ fontSize: 9, color: "var(--text-ghost)", marginTop: 6, lineHeight: 1.5 }}>
            Raise a band to bring out detail at that scale, lower it to soften it. -100 takes the band out.
          </div>
        </div>
      )}
    </div>
  );
}

/** How much of a span from a to b lies on the picture (0..1): a box
 * drawn past the edge is labeled by the part it selects. */
function insidePicture(a: number, b: number): number {
  return Math.max(0, Math.min(1, Math.max(a, b)) - Math.max(0, Math.min(a, b)));
}

function RecipeStub({
  sec,
  state,
  dispatch,
  hint,
  expand,
  extra,
}: {
  sec: SectionSpec;
  /** for the Export checkbox, which an unused section offers too */
  state: State;
  dispatch: D;
  /** the keynav letter, while the section hints are up */
  hint?: string;
  /** the Interface preference: unfold the section as it switches on */
  expand: boolean;
  /** drawn under the title: the section looks, for Tone Equalizer and Recolor */
  extra?: React.ReactNode;
}) {
  const slug = sec.title.toLowerCase().replace(/[^a-z]+/g, "-");
  return (
    // data-section on the stub too: Find a Control scrolls the landing
    // section into view by this attribute, and a section that is OFF
    // renders as this stub - without it, finding "Fog" below the fold
    // opened nothing anyone could see.
    <div data-section={sec.title} style={{ borderBottom: "1px solid var(--line-1)" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, height: 30, padding: "0 12px" }}>
        <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="var(--text-faint)" strokeWidth="2.6">
          <path d="M6 9l6 6 6-6" />
        </svg>
        <div
          style={{
            position: "relative",
            fontSize: 11,
            fontWeight: 600,
            letterSpacing: ".10em",
            textTransform: "uppercase",
            color: hint ? "#60666a" : "#c7ccd0",
            flex: 1,
          }}
        >
          {hint && <HintKey hint={hint} testid={`hint-section-${slug}`} />}
          {sec.title}
        </div>
        {/* The Export checkbox on a section not used yet (2026-09-30:
"every section should have the option for export layer"):
ticking it builds the section's nodes, switched off, and taps
them.*/}
        <SectionExportTick state={state} sec={sec} dispatch={dispatch} />
        <div
          className="toggle"
          data-on={false}
          data-testid={`toggle-${slug}`}
          role="switch"
          aria-checked={false}
          aria-label={`${sec.title} on/off`}
          data-hint={`${sec.title} on/off · builds its nodes the first time`}
          tabIndex={0}
          onClick={() => {
            // The first time is a build, not a toggle.
            powerOnSection(sec, dispatch, expand);
          }}
        >
          <div className="dot" />
        </div>
      </div>
      {extra && <div style={{ padding: "0 12px" }}>{extra}</div>}
    </div>
  );
}

/** The sections that offer looks (src/sectionlooks.ts): previewed from
 * a menu, applied with a click. */
const LOOK_SECTION_TITLES = new Set(["Tone Equalizer", "Recolor"]);

/** Phase 1 of lens profiles: the panel NAMES the database profile the
 * photograph's lens matched, before any correction math exists, so
 * matching can be judged against a real library. */
function LensProfileLine({
  imageId,
  state,
  dispatch,
}: {
  imageId: string;
  state: State;
  dispatch: D;
}) {
  const [hit, setHit] = useState<import("../bridge").LensProfileHit | null | "loading">("loading");
  useEffect(() => {
    let live = true;
    setHit("loading");
    void lensProfileFor(imageId).then((r) => {
      if (live) setHit(r);
    });
    return () => {
      live = false;
    };
  }, [imageId]);
  if (hit === "loading") return null;
  const lens = state.nodes.find((n) => n.type === "heeler.lens_correct");
  // Provenance outranks the database line: when this photo's lens
  // state came from one of the user's own presets, say which one.
  const presetName = lens?.textParams?.lens_preset || "";
  // Same contract as Auto noise: the measurement writes ordinary
  // parameters onto the node, visibly, in one undo step. The graph
  // shows exactly what was applied and the sliders stay free to trim.
  // The file's own correction outranks the database's: it was made for
  // this camera and lens, and applying both would correct twice.
  const fileWarp = hit ? hit.file_warp || null : null;
  const hasProfile = !!hit && !!(fileWarp || hit.model || hit.tca || hit.vig);
  const applyProfile = () => {
    if (!hit || !hasProfile || !lens) return;
    if (fileWarp) {
      dispatch({ type: "set_params", id: lens.id, ...fileWarpValues(fileWarp) });
      logMsg("info", "Lens correction from the file applied");
      return;
    }
    // Every profile parameter is written every time, neutral where this
    // lens has no calibration for it: a reapply after switching photos
    // must never leave the previous lens's coefficients behind.
    const [vr, cr, br, vb, cb, bb] = hit.tca ?? [1, 0, 0, 1, 0, 0];
    const [k1, k2, k3] = hit.vig ?? [0, 0, 0];
    dispatch({
      type: "set_params",
      id: lens.id,
      values: {
        dist_a: hit.a,
        dist_b: hit.b,
        dist_c: hit.c,
        dist_scale: hit.scale,
        tca_vr: vr,
        tca_cr: cr,
        tca_br: br,
        tca_vb: vb,
        tca_cb: cb,
        tca_bb: bb,
        vig_k1: k1,
        vig_k2: k2,
        vig_k3: k3,
      },
      // A database profile supersedes any user preset that was on the
      // node, so the provenance marker clears with it, and any file
      // correction too.
      text: { dist_model: hit.model ?? "none", lens_preset: "", [DNG_WARP]: "" },
    });
    const parts = [
      hit.model && "distortion",
      hit.tca && "CA",
      hit.vig && "vignetting",
    ].filter(Boolean);
    const at = hit.focal != null ? ` at ${hit.focal.toFixed(0)}mm` : "";
    // INFO, restored: this is the MANUAL Apply receipt (the demotion
    // assumed it was the auto-application on photo open, which never
    // logged). "restore to INFO."
    logMsg("info", `Lens profile applied: ${hit.maker} ${hit.name}${at} (${parts.join(" + ")})`);
  };
  const applied =
    !!lens &&
    ((lens.textParams?.dist_model ?? "none") !== "none" || lens.params.tca_vr !== undefined || !!lens.textParams?.[DNG_WARP]);
  return (
    <div style={{ display: "flex", alignItems: "baseline", gap: 6, padding: "1px 0 6px" }}>
      <div
        data-testid="lens-profile-line"
        style={{
          fontSize: 10,
          color: presetName || fileWarp || (hit && hit.matched) ? "var(--text-body)" : "var(--text-ghost)",
          flex: 1,
          minWidth: 0,
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
        }}
        data-hint={
          presetName
            ? `This photo's lens corrections came from your preset "${presetName}"`
            : fileWarp
              ? "This photograph's file carries its own lens correction, made for its camera and lens"
            : hit
              ? hit.matched
                ? hit.calibrated
                  ? "This lens is in the profile database with calibration data"
                  : "This lens is in the profile database, but without calibration data"
                : "This lens is named in the photograph's metadata, but the profile database has no entry for it"
              : "This photograph's metadata names no lens"
        }
      >
        {presetName
          ? `Profile: ${presetName} (preset)`
          : fileWarp
            ? "Profile: from the file"
          : hit
            ? hit.matched
              ? `Profile: ${hit.maker} ${hit.name}`
              : `${hit.name}: no profile`
            : "Profile: no lens in metadata"}
      </div>
      {hasProfile && lens && (
        <button
          className="chip"
          data-testid="lens-profile-apply"
          style={{ fontSize: 9, padding: "1px 8px", flex: "none" }}
          data-hint={
            fileWarp
              ? "Write the file's own lens correction onto the Lens Correction node"
              : "Write this profile's distortion, chromatic aberration and vignetting corrections onto the Lens Correction node"
          }
          onClick={applyProfile}
        >
          {applied ? "REAPPLY" : "APPLY"}
        </button>
      )}
    </div>
  );
}

/** Noise Reduction's Method (2026-09-09): Classic is the luma and
 * chroma pair in the graph, Model is the SCUNet answer blended in.
 * The same two-button idiom as Color's Treatment. Under it, with
 * Model on, the model's own status: the preview answer landing tile
 * by tile, and the full-size run that export needs, asked for here on
 * purpose since it is minutes on the CPU.*/
export function DenoiseMethodRow({ state, dispatch }: { state: State; dispatch: D }) {
  const model = denoiseMethodIsModel(state.nodes);
  const status = useDenoiseStatus();
  const disk = useFullDenoiseStatus(state, model);
  const [dims, setDims] = useState<[number, number] | null>(null);
  useEffect(() => {
    let live = true;
    setDims(null);
    if (!model) return;
    void imageMetadata(state, state.activeImage).then((m) => {
      if (live && m?.width && m?.height) setDims([m.width, m.height]);
    });
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.activeImage, model]);
  const mark = denoiseMark(state);
  const ready = status.ready[mark] ?? { preview: false, full: false };
  const running = status.running?.imageId === state.activeImage ? status.running : null;
  const fullTiles = dims ? denoiseTileCount(dims[0], dims[1]) : null;
  // About 0.6 s per 256 tile on the CPU (2026-09-10, Mac16,5, 48 GiB, release).
  const minutes = fullTiles ? Math.max(1, Math.round((fullTiles * 0.6) / 60)) : null;
  const line = running
    ? running.phase === "checking" ? `Model \u00b7 checking ${running.full ? "full-size" : "preview"} cache`
      : `Model \u00b7 ${running.full ? "full size" : "preview"} \u00b7 tile ${running.done} of ${running.total || "?"}`
    : disk?.error ? "Model \u00b7 full-size cache could not be checked"
    : !disk?.value ? "Model \u00b7 checking full-size cache"
    : disk.value.full ? "Model \u00b7 full size ready on disk"
    : status.failed === mark ? "Model could not finish. Retry when ready."
    : ready.preview
      ? `Model \u00b7 preview ${ready.work === "cached" ? "loaded from disk" : "ready"} \u00b7 full size not yet: ${fullTiles ?? "?"} tiles, about ${minutes ?? "?"} min, run at export or now`
      : "Model \u00b7 waiting for the preview answer";
  return (
    <div style={{ marginTop: 6, marginBottom: 4 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <div className="kicker">Method</div>
        <div className="zoom-seg" role="group" aria-label="Noise reduction method" style={{ border: "1px solid var(--line-4)" }}>
          <button
            data-active={!model}
            data-testid="nr-method-classic"
            data-hint="Classic: a luma and a chroma denoise in the graph, instant, Heeler's own kernel behind two dials"
            style={{ padding: "2px 8px" }}
            onClick={() => dispatch({ type: "set_denoise_method", model: false })}
          >
            Classic
          </button>
          <button
            data-active={model}
            data-testid="nr-method-model"
            data-hint="Model: the SCUNet denoiser's answer blended in by Luminance and Chroma, Detail returning edges; seconds for the preview, minutes at full size"
            style={{ padding: "2px 8px" }}
            onClick={() => dispatch({ type: "set_denoise_method", model: true })}
          >
            Model
          </button>
        </div>
      </div>
      {model && denoiseSectionOn(state.nodes) && (
        <div data-testid="nr-model-status" style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 5 }}>
          {/* The section's only prose, set at the size of the control labels beside
it (2026-09-11: "make the noise reduction help text the same font size
as the labels for the controls"). That is `.srow .lbl`, 11px, so the
row reads as one thing rather than a caption under a panel.*/}
          <div data-testid="nr-model-help" style={{ fontSize: 11, lineHeight: 1.5, color: "var(--text-dim)", flex: 1 }}>{line}</div>
          {status.failed === mark && !running && (
            <button className="chip" data-testid="nr-model-retry" style={{ fontSize: 12, padding: "2px 10px" }} data-hint="Try computing the preview again after the reported problem is resolved" onClick={retryDenoise}>RETRY</button>
          )}
          {ready.preview && disk?.value && !disk.value.full && !running && (
            <button
              className="chip"
              data-testid="nr-model-full"
              data-hint="Run the model over the whole frame now, the size export uses; minutes on the CPU, and export runs it anyway if you do not"
              style={{ fontSize: 12, padding: "2px 10px", flex: "none" }}
              onClick={() => void requestFullDenoise(state, dispatch)}
            >
              FULL SIZE
            </button>
          )}
        </div>
      )}
    </div>
  );
}

/** Measured Auto for Noise Reduction: reads the photograph's own
 * noise floor (engine NLF estimate) and sets Luminance and Chroma from
 * it. Auto writes parameters the
 * user can SEE and override, one undo step; it never drives them as a
 * hidden input. */
function NoiseAutoButton({ state, dispatch }: { state: State; dispatch: D }) {
  const [busy, setBusy] = useState(false);
  return (
    <button
      className="chip"
      data-testid="noise-auto"
      disabled={busy}
      data-hint="Measure this photograph's noise and set both sliders from it"
      style={{ fontSize: 9, padding: "1px 8px", flex: "none" }}
      onClick={() => {
        setBusy(true);
        void (async () => {
          try {
            const est = await estimateNoise(state);
            if (!est) {
              logMsg("warn", "Auto noise needs the app's engine; no estimate available here");
              return;
            }
            const { luma, chroma } = autoNoiseStrengths(est);
            dispatch({ type: "begin_gesture", key: "nr.auto" });
            if (denoiseMethodIsModel(state.nodes)) {
              // The model's two halves take the same measured balance.
              dispatch({ type: "set_param", id: MODEL_DENOISE_ID, param: "luminance", value: luma });
              dispatch({ type: "set_param", id: MODEL_DENOISE_ID, param: "chroma", value: chroma });
            } else {
              dispatch({ type: "set_param", id: "dn_luma_nr", param: "strength", value: luma });
              dispatch({ type: "set_param", id: "dn_color_nr", param: "strength", value: chroma });
            }
            dispatch({ type: "end_gesture" });
            logMsg(
              "info",
              `Auto noise: sigma L ${est.luma_sigma.toFixed(4)} C ${est.chroma_sigma.toFixed(4)} -> Luminance ${luma}, Chroma ${chroma}`,
            );
          } finally {
            setBusy(false);
          }
        })();
      }}
    >
      AUTO
    </button>
  );
}

/** User lens presets: the memory for vintage and unchipped glass.
 * Dial the corrections in once, SAVE under a name; the name is also
 * where aperture lives ("Helios 44-2 f/2"), because these lenses
 * report nothing. Applying writes the complete Lens Correction
 * state in one undo step, neutral where the preset is silent,
 * exactly like the profile APPLY above it.*/
function LensPresetRow({ state, dispatch }: { state: State; dispatch: D }) {
  const [presets, setPresets] = useState<LensPreset[]>([]);
  const [naming, setNaming] = useState<string | null>(null);
  const [chosen, setChosen] = useState("");
  useEffect(() => {
    void loadLensPresets().then((json) => setPresets(parseLensPresets(json)));
  }, []);
  // The dropdown is an action picker, not a stored setting: a photo does
  // not "have" a preset, it has ordinary node parameters. So a photo
  // switch snaps it back to "Preset…". The owner hit the alternative:
  // the previous photo's choice stayed displayed on an unedited photo
  // that had never received it, and re-picking the same entry fired no
  // change event, so it could not even be applied without toggling away
  // and back.
  useEffect(() => {
    setChosen("");
  }, [state.activeImage]);
  const lens = state.nodes.find((n) => n.type === "heeler.lens_correct");
  if (!lens) return null;
  const persist = (next: LensPreset[]) => {
    setPresets(next);
    void saveLensPresets(JSON.stringify(next));
  };
  const field = {
    background: "var(--bg-app)",
    border: "1px solid var(--line-4)",
    color: "var(--text-body)",
    fontSize: 10,
    padding: "1px 4px",
    outline: "none",
  } as const;
  return (
    <div style={{ padding: "0 0 6px" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
        <MenuField
          testid="lens-preset-select"
          label="Lens preset"
          hint="Apply a saved lens preset; one undo step takes it off again"
          size="regular"
          value={chosen}
          placeholder={presets.length ? "Preset…" : "No presets yet"}
          options={presets.map((p) => ({ id: p.id, label: p.name }))}
          fitLabels={[presets.length ? "Preset…" : "No presets yet", ...presets.map((p) => p.name)]}
          onChange={(id) => {
            setChosen(id);
            const p = presets.find((q) => q.id === id);
            if (!p) return;
            const { values, text } = lensPresetValues(p);
            dispatch({ type: "set_params", id: lens.id, values, text });
            logMsg("info", `Lens preset applied: ${p.name}`);
          }}
        />
        <button
          className="chip"
          data-testid="lens-preset-save"
          data-hint="Save this photo's lens corrections as a named preset; saving under an existing name replaces it"
          style={{ fontSize: 9, padding: "1px 8px", flex: "none" }}
          onClick={() => setNaming(naming === null ? "" : null)}
        >
          SAVE
        </button>
        {chosen && (
          <button
            className="chip"
            data-testid="lens-preset-delete"
            data-hint="Delete the selected preset; photos it was applied to keep their corrections"
            style={{ fontSize: 9, padding: "1px 8px", flex: "none" }}
            onClick={() => {
              const p = presets.find((q) => q.id === chosen);
              persist(presets.filter((q) => q.id !== chosen));
              setChosen("");
              if (p) logMsg("info", `Lens preset deleted: ${p.name}`);
            }}
          >
            ×
          </button>
        )}
      </div>
      {naming !== null && (
        <input
          autoFocus
          data-testid="lens-preset-name"
          placeholder="Preset name, e.g. Helios 44-2 f/2"
          value={naming}
          onChange={(e) => setNaming(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && naming.trim()) {
              const preset = captureLensPreset(naming.trim(), lens);
              persist(upsertLensPreset(presets, preset));
              setNaming(null);
              logMsg("info", `Lens preset saved: ${preset.name}`);
            }
            if (e.key === "Escape") setNaming(null);
          }}
          style={{ ...field, width: "100%", marginTop: 4, padding: "2px 5px", boxSizing: "border-box" }}
        />
      )}
    </div>
  );
}

/** Edit history for the active image; lives in the right panel's HISTORY
 * tab, next to ADJUSTMENTS. */
function HistoryTab({ state, dispatch }: { state: State; dispatch: D }) {
  return (
    <div
      style={{
        flex: 1,
        overflowY: "auto",
        display: "flex",
        flexDirection: "column",
        paddingTop: 9,
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          padding: "0 12px 7px",
        }}
      >
        <span
          className="tnum"
          style={{ fontSize: 9, color: "var(--text-ghost)" }}
          data-testid="history-count"
        >
          {state.undoStack.length}/100
        </span>
        <button
          className="chip"
          style={{ fontSize: 9, padding: "1px 7px", letterSpacing: ".08em" }}
          data-testid="clear-history"
          data-hint="Purge undo history for this image (keeps the edit itself)"
          onClick={() => dispatch({ type: "clear_history" })}
        >
          Clear
        </button>
      </div>
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          gap: 1,
          padding: "0 8px",
        }}
        data-testid="history-list"
      >
        <div
          style={{
            padding: "3px 8px",
            fontSize: 10,
            color: "var(--accent)",
            background: "var(--bg-row)",
          }}
        >
          Current
        </div>
        {state.undoStack
          .map((snap, i) => ({ snap, i }))
          .reverse()
          .slice(0, 100)
          .map(({ snap, i }) => (
            <button
              key={i}
              data-testid={`history-${i}`}
              data-hint="Revert to before this step"
              onClick={() => dispatch({ type: "jump_history", index: i })}
              style={{
                all: "unset",
                cursor: "pointer",
                padding: "3px 8px",
                fontSize: 10,
                color: "var(--text-dim)",
              }}
            >
              {snap.label}
            </button>
          ))}
        {state.undoStack.length === 0 && (
          <div
            style={{
              padding: "3px 8px",
              fontSize: 10,
              color: "var(--text-ghost)",
            }}
          >
            No edits yet.
          </div>
        )}
      </div>
    </div>
  );
}

/** Presets tab: containers per preset family. Node groups today; node
 * presets, crop presets, and friends slot in as more containers later. */
/** The selection panel: the select tool's dials and the region history.
 * It rides in the automatic split below the panes, appears with the
 * work, and folds to a bar when asked. */
export function SelectTab({
  state,
  dispatch,
  onMinimize,
}: {
  state: State;
  dispatch: D;
  onMinimize?: () => void;
}) {
  const sel = activeSelectionMask(state);
  return (
    <div
      data-testid="select-tab"
      style={{ display: "flex", flexDirection: "column", minHeight: 0, flex: 1 }}
    >
      {/* A header bar with its own ground, not a kicker floating in the
scroll: the split was reading as one more section of whatever sat
above it. "It doesn't stand out very well." Styled as
the minimized bar is, so folded and unfolded read as the same thing
at two sizes.*/}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 6,
          padding: "6px 12px",
          background: "var(--bg-panel-head)",
          borderBottom: "1px solid var(--line-2)",
          flex: "none",
        }}
      >
        <div data-testid="select-tab-title" className="kicker" style={{ fontSize: 8, flex: 1, color: "var(--accent)" }}>
          Selection
        </div>
        <button
          className="chip"
          data-testid="select-reset"
          data-hint="Put the select tool's dials back the way they ship"
          style={{ fontSize: 9, padding: "1px 7px" }}
          onClick={() => dispatch({ type: "reset_select_settings" })}
        >
          RESET
        </button>
        {onMinimize && (
          <button
            className="chip"
            data-testid="selection-split-min"
            data-hint="Fold the selection panel down to a bar"
            aria-label="Minimize the selection panel"
            style={{ fontSize: 9, padding: "1px 7px" }}
            onClick={onMinimize}
          >
            {/* A drawn bar, not a dash character: the glyph is the fold. */}
            <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" aria-hidden focusable="false" style={{ display: "block" }}>
              <path d="M4 12h16" />
            </svg>
          </button>
        )}
        {/* The door puts the select tool away and closes the panel; the
selection and its layer stay exactly as they are, and arming the
select tool or clicking a layer brings the panel back
(close_selection_split). "should also have a close button
and not just the min button."*/}
        <button
          className="chip"
          data-testid="selection-split-close"
          data-hint="Put the select tool away and close this panel; the selection itself stays"
          aria-label="Close the selection panel"
          style={{ fontSize: 9, padding: "1px 7px" }}
          onClick={() => dispatch({ type: "close_selection_split" })}
        >
          ✕
        </button>
      </div>
      <div
        style={{ padding: "8px 12px 10px", display: "flex", flexDirection: "column", gap: 4, minHeight: 0, overflowY: "auto", flex: 1 }}
      >
      {sel ? (
        <SelectionControls state={state} dispatch={dispatch} node={sel} />
      ) : (
        <div style={{ fontSize: 10, color: "var(--text-faint)", lineHeight: 1.5 }}>
          Arm the select tool and draw in the viewer to start a selection. Every region shows up
          here, editable: reorder them, silence one, or take one back out.
        </div>
      )}
      </div>
    </div>
  );
}

export function PresetsTab({ state, dispatch }: { state: State; dispatch: D }) {
  // The Presets tab: saved LOOKS (the owner's contract, 2026-08-25).
  // Two tree roots - the read-only built-in library and the user's
  // own files - each searchable, folders expanding and collapsing. A
  // click applies (one undo takes it back); the vestigial Node groups
  // listing this replaces logged group creations and applied nothing.
  const [entries, setEntries] = useState<PresetEntry[] | null>(null);
  // The folds live in the session, not in this component: the tab
  // unmounts whenever another tab is shown, and a fold kept here was
  // lost with it ("keep having to expand the presets").
  const collapsed = new Set(state.presetFolds ?? []);
  const [searchBuiltin, setSearchBuiltin] = useState("");
  const [searchUser, setSearchUser] = useState("");
  const [saving, setSaving] = useState(false);
  const [saveName, setSaveName] = useState("");
  const [saveCat, setSaveCat] = useState("");
  const [busy, setBusy] = useState(false);
  const refresh = () => {
    void presetList()
      .then((es) => {
        // The library opens as a shelf of category spines, not a wall of every
        // look ("Built-in categories should be collapsed by
        // default"). Seeded once per session, from the first listing; the
        // reducer ignores a second seeding, so the user's own folds survive
        // every later refresh and every tab switch.
        dispatch({
          type: "seed_preset_folds",
          keys: es.filter((e) => e.builtin && e.category).map((e) => `b|${e.category}`),
        });
        setEntries(es);
      })
      .catch((err) => reportToolError("Presets", err));
  };
  useEffect(refresh, []);

  const apply = (e: PresetEntry) => {
    if (busy) return;
    setBusy(true);
    void presetRead(e.builtin, e.path)
      .then((preset) => {
        dispatch({ type: "apply_preset", preset });
        flashStatus(`Applied "${e.name}"`);
      })
      .catch((err) => reportToolError("Apply preset", err))
      .finally(() => setBusy(false));
  };

  const toggle = (key: string) => dispatch({ type: "toggle_preset_fold", key });

  const section = (builtin: boolean, search: string) => {
    const q = search.trim().toLowerCase();
    const mine = (entries ?? []).filter(
      (e) => e.builtin === builtin && (!q || e.name.toLowerCase().includes(q)),
    );
    const cats = [...new Set(mine.map((e) => e.category))].sort();
    return cats.map((cat) => {
      const key = `${builtin ? "b" : "u"}|${cat}`;
      // Searching flattens the tree open: a filter that hid its own
      // matches inside collapsed folders would read as no results.
      const open = q !== "" || !collapsed.has(key);
      const rows = mine.filter((e) => e.category === cat);
      return (
        <React.Fragment key={key}>
          {cat !== "" && (
            <button
              data-testid={`preset-cat-${builtin ? "b" : "u"}-${cat.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`}
              onClick={() => toggle(key)}
              aria-expanded={open}
              style={{
                all: "unset", cursor: "pointer", display: "flex", alignItems: "center",
                gap: 6, padding: "3px 12px", fontSize: 10, letterSpacing: ".08em",
                textTransform: "uppercase", color: "#969ca0",
              }}
            >
              <svg width="8" height="8" viewBox="0 0 24 24" fill="none" stroke="var(--text-faint)" strokeWidth="3"
                style={{ transform: open ? "none" : "rotate(-90deg)", transition: "transform .1s" }}>
                <path d="M6 9l6 6 6-6" />
              </svg>
              {cat}
            </button>
          )}
          {open &&
            rows.map((e) => (
              <div
                key={e.builtin ? `b${e.path}` : e.path}
                data-testid={`preset-row-${e.name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`}
                style={{
                  display: "flex", alignItems: "center", gap: 6,
                  padding: "3px 12px 3px 26px", fontSize: 11, background: "var(--bg-row)",
                  marginBottom: 1, color: "var(--text-body)",
                }}
              >
                <button
                  style={{ all: "unset", cursor: "pointer", flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
                  data-hint={`Apply "${e.name}": replaces the look, keeps your crop, layers and masks. One undo takes it back`}
                  onClick={() => apply(e)}
                >
                  {e.name}
                </button>
                <button
                  className="chip"
                  data-testid={`preset-export-${e.name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`}
                  data-hint="Save this preset as a file to share"
                  style={{ fontSize: 8, padding: "0 5px" }}
                  onClick={() =>
                    void presetExport(e.builtin, e.path, e.name)
                      .then((dest) => dest && flashStatus(`Exported to ${dest}`))
                      .catch((err) => reportToolError("Export preset", err))
                  }
                >
                  EXPORT
                </button>
                {!e.builtin && (
                  <button
                    className="chip"
                    data-testid={`preset-trash-${e.name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`}
                    data-hint="Move this preset to presets/.trash (nothing is ever deleted)"
                    style={{ fontSize: 9, padding: "0 5px" }}
                    onClick={() =>
                      void presetTrash(e.path)
                        .then(() => {
                          flashStatus(`"${e.name}" moved to presets/.trash`);
                          refresh();
                        })
                        .catch((err) => reportToolError("Trash preset", err))
                    }
                  >
                    ✕
                  </button>
                )}
              </div>
            ))}
        </React.Fragment>
      );
    });
  };

  const searchField = (value: string, onChange: (v: string) => void, testid: string) => (
    <input
      data-testid={testid}
      value={value}
      placeholder="Search"
      aria-label="Search presets"
      onChange={(e) => onChange(e.target.value)}
      style={{
        margin: "2px 12px 6px", padding: "3px 7px", fontSize: 10,
        background: "var(--bg-app)", border: "1px solid var(--line-4)",
        color: "var(--text-body)", outline: "none",
      }}
    />
  );

  const userCats = [...new Set((entries ?? []).filter((e) => !e.builtin).map((e) => e.category))].filter(Boolean);
  // Half the tab each ("split evenly between built-in and
  // user presets"): two fixed shares with their own scrollbars, so a
  // long library can never push Your presets off the bottom.
  return (
    <div style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column", paddingTop: 9 }}>
      <div style={{ flex: "1 1 0", minHeight: 0, display: "flex", flexDirection: "column" }}>
      <div className="kicker" style={{ padding: "0 12px 5px", flex: "none" }} data-testid="preset-root-builtin">
        Built-in
      </div>
      {searchField(searchBuiltin, setSearchBuiltin, "preset-search-builtin")}
      <div style={{ display: "flex", flexDirection: "column", flex: 1, minHeight: 0, overflowY: "auto" }}>{section(true, searchBuiltin)}</div>
      </div>
      <div style={{ flex: "1 1 0", minHeight: 0, display: "flex", flexDirection: "column", borderTop: "1px solid var(--line-1)" }}>
      {/* The two actions are glyphs, like every section header's controls
(2026-09-04): a bookmark with a plus saves the look, a tray with an
arrow into it imports files. Their old words ride at the cursor as
the data-tip name chip; the hint keeps the longer sentence. The
row's gap plus the chips' padding is the same 15 between glyphs the
headers keep between reset and switch.*/}
      <div
        className="kicker"
        style={{ padding: "9px 12px 5px", display: "flex", alignItems: "center", gap: 5, flex: "none" }}
        data-testid="preset-root-user"
      >
        <span style={{ flex: 1 }}>Your presets</span>
        <button
          className="chip bare"
          data-testid="preset-save-open"
          aria-label="Save the current look as a preset"
          aria-pressed={saving}
          data-tip="Save Look…"
          data-hint="Save the current look as a preset: the develop chain without your crop, layers, or masks"
          style={{ padding: "3px 5px", color: saving ? "var(--accent)" : "var(--text-ghost)", display: "flex", alignItems: "center" }}
          onClick={() => setSaving((v) => !v)}
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden focusable="false">
            <path d="M6 3h12v18l-6-4-6 4z" />
            <path d="M12 7v6M9 10h6" />
          </svg>
        </button>
        <button
          className="chip bare"
          data-testid="preset-import"
          aria-label="Import preset files"
          data-tip="Import…"
          data-hint="Import preset files: older formats are migrated, newer ones refused with a message"
          style={{ padding: "3px 5px", color: "var(--text-ghost)", display: "flex", alignItems: "center" }}
          onClick={() =>
            void presetImport()
              .then((r) => {
                if (r.imported.length) flashStatus(`Imported ${r.imported.length} preset${r.imported.length === 1 ? "" : "s"}`);
                for (const [f, why] of r.failed) reportToolError(`Import ${f.split("/").pop()}`, why);
                refresh();
              })
              .catch((err) => reportToolError("Import presets", err))
          }
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden focusable="false">
            <path d="M12 3v11" />
            <path d="M8 10l4 4 4-4" />
            <path d="M4 15v4a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-4" />
          </svg>
        </button>
      </div>
      {saving && (
        <div style={{ display: "flex", gap: 6, padding: "0 12px 6px", alignItems: "center" }}>
          <input
            data-testid="preset-save-name"
            value={saveName}
            placeholder="Name"
            aria-label="Preset name"
            onChange={(e) => setSaveName(e.target.value)}
            style={{ flex: 1, minWidth: 0, padding: "3px 7px", fontSize: 10, background: "var(--bg-app)", border: "1px solid var(--line-4)", color: "var(--text-body)", outline: "none" }}
          />
          <SuggestField
            data-testid="preset-save-category"
            value={saveCat}
            placeholder="Category"
            aria-label="Preset category"
            suggestions={userCats}
            onChange={setSaveCat}
            boxStyle={{ width: 90 }}
            style={{ padding: "3px 7px", fontSize: 10, background: "var(--bg-app)", border: "1px solid var(--line-4)", color: "var(--text-body)", outline: "none" }}
          />
          <button
            className="chip"
            data-testid="preset-save"
            disabled={!saveName.trim()}
            style={{ fontSize: 9, padding: "1px 8px" }}
            onClick={() => {
              const preset = capturePreset(state, saveName.trim());
              void presetSave(saveCat.trim(), saveName.trim(), preset)
                .then(() => {
                  flashStatus(`Saved "${saveName.trim()}"`);
                  setSaving(false);
                  setSaveName("");
                  refresh();
                })
                .catch((err) => reportToolError("Save preset", err));
            }}
          >
            SAVE
          </button>
        </div>
      )}
      {searchField(searchUser, setSearchUser, "preset-search-user")}
      <div style={{ display: "flex", flexDirection: "column", paddingBottom: 12, flex: 1, minHeight: 0, overflowY: "auto" }}>
        {entries !== null &&
          entries.some((e) => !e.builtin) === false &&
          searchUser === "" && (
            <div style={{ fontSize: 10, color: "var(--text-faint)", padding: "0 12px", lineHeight: 1.5 }}>
              Nothing saved yet. The bookmark keeps the current develop as a
              preset; the tray brings in files someone shared.
            </div>
          )}
        {section(false, searchUser)}
      </div>
      </div>
    </div>
  );
}

/** The section header's right-click menu: Pin to top or Unpin. Fixed
 * and clamped in the zoomed panel the way the layer menu is. */
function SectionMenu({
  at,
  title,
  pinned,
  menuRef,
  dispatch,
  onClose,
  override = null,
}: {
  at: { x: number; y: number };
  title: string;
  pinned: boolean;
  menuRef: React.RefObject<HTMLDivElement>;
  dispatch: D;
  onClose: () => void;
  /** inside a link: whether this section is overridden for this photo,
   * and the keys that make it so */
  override?: { on: boolean; keys: string[] } | null;
}) {
  const z = chromeZoomFactor();
  const vp = viewportSize();
  const p = clampMenu({ x: at.x / z, y: at.y / z }, { w: 230, h: override ? 90 : 60 }, { w: vp.w / z, h: vp.h / z });
  return (
    <div
      ref={menuRef}
      className="ctx-menu"
      role="menu"
      aria-label={`${title} section`}
      data-testid="section-menu"
      style={{ position: "fixed", width: 230, left: p.x, top: p.y, zIndex: 60 }}
      onMouseDown={(e) => e.stopPropagation()}
    >
      <div className="hd">{title.toUpperCase()}</div>
      <div className="sep" />
      <div data-hint={sectionPinHint(pinned)}>
        <button
          data-testid="section-menu-pin"
          onClick={() => {
            dispatch({ type: "toggle_pinned_section", title });
            onClose();
          }}
        >
          {pinned ? "Unpin" : "Pin to top"}
        </button>
      </div>
      {override && (
        <div data-hint={override.on ? "This section takes the link's edits again" : "Keeps this section's settings as this photograph has them while the rest of the link's edits land"}>
          <button
            data-testid="section-menu-override"
            style={{ display: "flex", alignItems: "center", gap: 7 }}
            onClick={() => {
              dispatch({ type: "toggle_link_override", keys: override.keys });
              onClose();
            }}
          >
            <LinkIcon />
            {override.on ? "Remove override" : "Override for this photo"}
          </button>
        </div>
      )}
    </div>
  );
}

/** A dial's right-click menu inside a link: one item, the override. */
function ParamMenu({
  at,
  label,
  on,
  menuRef,
  onToggle,
  onClose,
}: {
  at: { x: number; y: number };
  label: string;
  on: boolean;
  menuRef: React.RefObject<HTMLDivElement>;
  onToggle: () => void;
  onClose: () => void;
}) {
  const z = chromeZoomFactor();
  const vp = viewportSize();
  const p = clampMenu({ x: at.x / z, y: at.y / z }, { w: 230, h: 60 }, { w: vp.w / z, h: vp.h / z });
  return (
    <div
      ref={menuRef}
      className="ctx-menu"
      role="menu"
      aria-label={`${label} inside the link`}
      data-testid="param-menu"
      style={{ position: "fixed", width: 230, left: p.x, top: p.y, zIndex: 60 }}
      onMouseDown={(e) => e.stopPropagation()}
    >
      <div className="hd">{label.toUpperCase()}</div>
      <div className="sep" />
      <div data-hint={on ? `${label} takes the link's edits again` : `Keeps ${label} as this photograph has it while the rest of the link's edits land`}>
        <button
          data-testid="param-menu-override"
          style={{ display: "flex", alignItems: "center", gap: 7 }}
          onClick={() => {
            onToggle();
            onClose();
          }}
        >
          <LinkIcon />
          {on ? "Remove override" : `Override ${label} for this photo`}
        </button>
      </div>
    </div>
  );
}

/** The section Export checkbox (2026-09-30). The same box as the Finish layer's; one per section, on every
 * section a switch can build ("every section should have
 * the option for export layer"), used or not.*/
export function SectionExportTick({
  state,
  sec,
  dispatch,
  seat = "panel",
}: {
  state: State;
  sec: SectionSpec;
  dispatch: D;
  /** the section header, or the tapped node's graph inspector */
  seat?: "panel" | "inspector";
}) {
  if (!sectionExportOffered(state, sec)) return null;
  const depth = sec.depthTools === "depthmap";
  const layer = sectionExportLayer(state, sec);
  const layerName = layer ? layersOf(state).find((l) => l.id === layer)?.name : undefined;
  const exported = state.nodes.some((n) => n.id === sectionExportId(sec.title, layer));
  const slug = sec.title.toLowerCase().replace(/[^a-z]+/g, "-");
  return (
    <ExportTick
      id={sec.title}
      testid={seat === "panel" ? `section-export-${slug}` : `inspector-section-export-${slug}-tick`}
      exported={exported}
      adjust={false}
      what={depth ? "the depth map" : `the picture as ${sec.title} leaves it${layerName ? ` on ${layerName}` : ""}`}
      hint={
        depth
          ? {
              off: `Write the depth map into the export as its own layer, in the EXR or as a sibling TIFF. ${DEPTH_EXPORT_CONVENTION}`,
              on: `The depth map writes into the export as its own layer; click to stop. ${DEPTH_EXPORT_CONVENTION}`,
            }
          : undefined
      }
      toggle={(on) => sectionExportCommand(state, sec, on)}
      dispatch={dispatch}
    />
  );
}

function AdjustBody({
  state,
  dispatch,
  frame,
  engine,
  showing,
  width,
}: {
  state: State;
  dispatch: D;
  frame?: string | null;
  engine?: boolean;
  showing: boolean;
  /** the panel's width, so wide controls (the curve plot) sit flush */
  width?: number;
}) {
  // The section header's right-click menu, and the list as filtered.
  const [sectionMenu, setSectionMenu] = useState<{ x: number; y: number; title: string } | null>(null);
  const sectionMenuRef = useDismiss<HTMLDivElement>(sectionMenu !== null, () => setSectionMenu(null));
  const pinnedTitles = state.prefs.pinnedSections;
  const { sections: listed, pinnedCount } = visibleSections(state);
  // Inside a link, sections and dials can be overridden for this photo.
  const linked = linkedWith(state, state.activeImage).length > 0;
  const [paramMenu, setParamMenu] = useState<{ x: number; y: number; nodeId: string; param: string; label: string } | null>(null);
  const paramMenuRef = useDismiss<HTMLDivElement>(paramMenu !== null, () => setParamMenu(null));
  return (
      <div
        style={{
          flex: 1,
          overflowY: "auto",
          display: showing ? "flex" : "none",
          flexDirection: "column",
        }}
      >
        <StackPanel state={state} dispatch={dispatch} />
        <PanoPanel state={state} dispatch={dispatch} />
        <LayersSection state={state} dispatch={dispatch} width={width} />
        {/* Handed to its own window, this folds to a bar rather than
            vanishing, the same way the graph does: the bar is the way
            back. */}
        {state.spectrumsPoppedOut ? (
          <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <div style={{ flex: 1, minWidth: 0 }}>
              <SpectrumBar dispatch={dispatch} />
            </div>
            {/* Same toggle the section chips are: a floating window can
                get lost, and this brings the tool back into the panel. */}
            <button
              className="chip popout"
              data-testid="spectrums-focus"
              data-active
              data-hint="Close the floating window and bring the spectrums back into the panel"
              style={{ flex: "none" }}
              onClick={() => dispatch({ type: "set_spectrums_popped_out", out: false })}
            >
              ⧉
            </button>
          </div>
        ) : (
          <Spectrums
            state={state}
            dispatch={dispatch}
            frame={frame}
            onPopOut={() =>
              dispatch({ type: "set_spectrums_popped_out", out: true })
            }
          />
        )}
        {/* All, Pinned, On (the owner, with a tester: "pinning sections. That way
a user could filter for the sections they use the most"). Pins come
from the header's right-click menu, so the headers stay as they are;
On needs no setup at all.*/}
        <div
          data-testid="section-filter"
          role="group"
          aria-label="Which sections to list"
          style={{ display: "flex", alignItems: "center", gap: 6, padding: "6px 12px 4px" }}
        >
          {(
            [
              ["all", "All", "Every section, the pinned ones first"],
              ["pinned", pinnedTitles.length ? `Pinned ${pinnedTitles.length}` : "Pinned", "Only the sections you pinned; right-click a section's header to pin it"],
              ["on", "On", "Only the sections switched on for this photograph"],
            ] as const
          ).map(([id, label, hint]) => (
            <button
              key={id}
              className="chip"
              data-testid={`section-filter-${id}`}
              data-active={state.sectionFilter === id}
              aria-pressed={state.sectionFilter === id}
              data-hint={hint}
              style={{ fontSize: 9, padding: "1px 8px" }}
              onClick={() => dispatch({ type: "set_section_filter", filter: id })}
            >
              {label}
            </button>
          ))}
          {/* Sections taken out in Preferences: the count, and the way to the
list, so a look this photograph carries is never a mystery
(2026-09-20).*/}
          {hiddenSectionCount(state) > 0 && (
            <button
              className="chip"
              data-testid="section-filter-hidden"
              data-hint="Sections hidden in Preferences > Interface > Adjustment sections; their edits still render. Click to open the list"
              style={{ fontSize: 11, padding: "1px 8px", color: "var(--text-faint)" }}
              onClick={() => dispatch({ type: "open_prefs", landing: "adjust-sections" })}
            >
              {hiddenSectionCount(state)} hidden
            </button>
          )}
          {/* Find a Control, where the sections are (2026-09-09): the Help
menu's search, one glass away from the list it searches.*/}
          <button
            className="chip"
            data-testid="section-filter-find"
            data-active={state.findControlOpen}
            aria-pressed={state.findControlOpen}
            aria-label="Find a Control"
            data-hint="Search every control in the app by name, and go straight to the one you pick"
            style={{ fontSize: 9, padding: "1px 6px", display: "inline-flex", alignItems: "center", marginLeft: "auto" }}
            onClick={() => dispatch({ type: "toggle_find_control" })}
          >
            <svg width="11" height="11" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden focusable="false">
              <circle cx="6.5" cy="6.5" r="4.5" />
              <path d="M10 10l4 4" />
            </svg>
          </button>
        </div>
        {listed.length === 0 && (
          <div data-testid="section-filter-empty" style={{ padding: "10px 12px 14px", fontSize: 10, color: "var(--text-ghost)", lineHeight: 1.6 }}>
            {state.sectionFilter === "pinned"
              ? "No pinned sections yet. Right-click a section's header and choose Pin to top."
              : "Nothing is switched on for this photograph."}
          </div>
        )}
        {sectionMenu && (() => {
          const sec = SECTIONS.find((x) => x.title === sectionMenu.title);
          const ids = sec ? sectionNodeIds(state, sec) : [];
          const keys = ids.map((id) => `node:${id}`);
          return (
            <SectionMenu
              at={sectionMenu}
              title={sectionMenu.title}
              pinned={pinnedTitles.includes(sectionMenu.title)}
              menuRef={sectionMenuRef}
              dispatch={dispatch}
              onClose={() => setSectionMenu(null)}
              override={linked && keys.length > 0 ? { on: keys.some((k) => state.linkOverrides.includes(k)), keys } : null}
            />
          );
        })()}
        {paramMenu && (
          <ParamMenu
            at={paramMenu}
            label={paramMenu.label}
            on={state.linkOverrides.includes(`param:${paramMenu.nodeId}|${paramMenu.param}`)}
            menuRef={paramMenuRef}
            onToggle={() => dispatch({ type: "toggle_link_override", keys: [`param:${paramMenu.nodeId}|${paramMenu.param}`] })}
            onClose={() => setParamMenu(null)}
          />
        )}
        {listed.map((sec, index) => {
          const node = sec.node(state);
          // A recipe's nodes do not exist until it is switched on, so it
          // draws as a title and a switch until they do. Making `node`
          // nullable for every other section instead would push a
          // question through two hundred lines that only applies here.
          const slug = sec.title.toLowerCase().replace(/[^a-z]+/g, "-");
          const closed = state.sectionsClosed.includes(sec.title);
          // The letter for this section, while the section hints are up.
          // Resolved from the same list the key handler reads, so what
          // is shown and what works cannot disagree. Computed before the
          // stub branch below: an OFF section is navigable too (its one
          // target is its switch), so its stub wears the letter.
          const sectionHint =
            state.keynav?.mode === "sections"
              ? (() => {
                  const groups = navSections(state);
                  const at = groups.findIndex((g) => g.section === sec.title);
                  return at < 0
                    ? undefined
                    : assignHints(groups.map((g) => g.section))[at];
                })()
              : undefined;
          // The Color Sets block rides directly below Recolor (2026-09-07: "put Recolor on
          // top of Color Sets"). The csetN pairs still splice into the chain after the
          // bend; the panel order is the reading order, not the chain's. And the Lens
          // Character block below Depth of Field: a menu over the optical sections, no node
          // of its own.
          const withSets = (el: React.ReactNode) =>
            sec.title === "Recolor" ? (
              <React.Fragment key={`${sec.title}-run`}>
                {el}
                <ColorSetsBlock state={state} dispatch={dispatch} width={width} />
              </React.Fragment>
            ) : sec.title === "Depth of Field" ? (
              <React.Fragment key={`${sec.title}-run`}>
                {el}
                <LensCharacterBlock state={state} dispatch={dispatch} />
              </React.Fragment>
            ) : (
              el
            );
          if (!node) {
            // A category that has never been switched on has no node to draw
            // from, which is the point of it: the section is a title and a
            // switch until somebody wants it.
            return withSets(
              sec.recipe || CATEGORY_PIECES[sec.title] ? (
                <RecipeStub
                  key={sec.title}
                  sec={sec}
                  state={state}
                  dispatch={dispatch}
                  hint={sectionHint}
                  expand={state.prefs.expandSectionOnEnable}
                  extra={
                    LOOK_SECTION_TITLES.has(sec.title) ? (
                      <SectionLooks section={sec.title as "Tone Equalizer" | "Recolor"} state={state} dispatch={dispatch} />
                    ) : undefined
                  }
                />
              ) : null,
            );
          }
          return withSets(
            <div
              key={sec.title}
              // A section-level landing (the section itself, a depth
              // chip, a Finish tool) has no row to outline, and used to
              // scroll into view wearing nothing at all. It gets the
              // same border around its own box, fading the same way.
              className={state.controlFlash?.section === sec.title && !state.controlFlash.param ? "section-control-flash" : undefined}
              // Find a Control's landing scrolls by section AND param:
              // a param name is not unique across the panel (see the
              // Slider's own data-node note), so an unscoped
              // [data-param] query can land on another section's row.
              data-section={sec.title}
              data-override={(linked && sectionNodeIds(state, sec).some((id) => state.linkOverrides.includes(`node:${id}`))) || undefined}
              style={{
                borderBottom: "1px solid var(--line-1)",
                // The override wraps the whole section, open or folded
                // ("the dotted orange should surround the entire section when
                // expanded").
                ...(linked && sectionNodeIds(state, sec).some((id) => state.linkOverrides.includes(`node:${id}`))
                  ? { outline: "1px dotted var(--warn)", outlineOffset: -3, borderRadius: 2 }
                  : {}),
              }}
            >
              {/* The seam between the pinned group and the rest: a kicker
                  over the first pinned section, a heavier line under the
                  last, so the two lists read as two lists. */}
              {index === 0 && pinnedCount > 0 && state.sectionFilter !== "pinned" && (
                <div className="kicker" data-testid="pinned-kicker" style={{ fontSize: 8, color: "var(--accent)", padding: "6px 12px 0" }}>
                  PINNED
                </div>
              )}
              <div
                data-testid={`section-header-${slug}`}
                onContextMenu={(e) => {
                  e.preventDefault();
                  setSectionMenu({ x: e.clientX, y: e.clientY, title: sec.title });
                }}
                style={{
                  display: "flex",
                  alignItems: "center",
                  ...(index === pinnedCount - 1 && pinnedCount > 0 && state.sectionFilter !== "pinned" && index < listed.length - 1
                    ? { boxShadow: "0 1px 0 var(--line-hard)" }
                    : {}),
                  // 10 rather than 8, +25% : the header's controls are all glyphs now,
                  // and glyphs need the air that words used to carry with them. The gap
                  // is the ONLY spacing in this row, so pop-out to reset and reset to
                  // switch are the same distance by construction rather than by two
                  // margins agreeing.
                  gap: 10,
                  height: 30,
                  padding: "0 12px",
                }}
              >
                {/* "all the categories have a little arrow next to them
indicating they can be collapsed, yet they can not be." The arrow is the
control now, and so is the title beside it: a nine pixel chevron is a
small thing to hit.*/}
                <button
                  data-testid={`collapse-${slug}`}
                  data-open={!closed}
                  aria-expanded={!closed}
                  aria-label={`${sec.title} section`}
                  // The summary is the hint ("a summary about what the
                  // controls in that section does"); the modifier gestures ride along
                  // after it. The plain click is the chevron's own promise, so it is
                  // not spelled out: the status row is one line, and the gestures only
                  // fit beside the summary without it.
                  data-hint={`${SECTION_BLURBS[sec.title] ?? sec.title} · ${modLabel("alt")} all · ${modLabel("alt")}${isMac() ? "" : "+"}${modLabel("shift")} same state · ${modLabel("ctrl")} ${state.prefs.pinnedSections.includes(sec.title) ? "unpin" : "pin"}`}
                  onClick={(e) => {
                    if (isMac() ? e.metaKey : e.ctrlKey) {
                      dispatch({ type: "toggle_pinned_section", title: sec.title });
                    } else if (e.altKey) {
                      const titles = SECTIONS.filter((other) => !sectionHidden(state, other) && (!e.shiftKey || sectionIsOn(state, other) === sectionIsOn(state, sec))).map((other) => other.title);
                      dispatch({ type: closed ? "open_sections" : "close_sections", titles });
                    } else {
                      dispatch({ type: "toggle_section", title: sec.title });
                    }
                  }}
                  style={{
                    all: "unset",
                    cursor: "pointer",
                    display: "flex",
                    alignItems: "center",
                    gap: 8,
                    flex: 1,
                    minWidth: 0,
                    alignSelf: "stretch",
                  }}
                >
                  <svg
                    width="9"
                    height="9"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="var(--text-faint)"
                    strokeWidth="2.6"
                    style={{
                      transform: closed ? "rotate(-90deg)" : "none",
                      transition: "transform .12s",
                      flex: "none",
                    }}
                  >
                    <path d="M6 9l6 6 6-6" />
                  </svg>
                <div
                  style={{
                    position: "relative",
                    fontSize: 11,
                    fontWeight: 600,
                    letterSpacing: ".10em",
                    textTransform: "uppercase",
                    color: sectionHint ? "#60666a" : "#c7ccd0",
                  }}
                >
                  {sectionHint && (
                    <HintKey
                      hint={sectionHint}
                      testid={`hint-section-${sec.title.toLowerCase().replace(/[^a-z]+/g, "-")}`}
                    />
                  )}
                  {sec.title}
                  {pinnedTitles.includes(sec.title) && (
                    <svg
                      data-testid={`pinned-${slug}`}
                      aria-label="Pinned"
                      width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"
                      style={{ marginLeft: 7, verticalAlign: "-1px", color: "var(--text-ghost)" }}
                    >
                      <path d="M9 4h6l-1 6 3 3v2H7v-2l3-3z" />
                      <path d="M12 15v6" />
                    </svg>
                  )}
                </div>
                </button>
                {/* Curves, Color Wheels and Color Bend open in windows of their own:
same glyph, same place in every header, one thing to learn. The
report: "The pop out icon that Color Blend has should be in the
section header just like Split Tone, Color Wheels, and Curves (for
consistency)."*/}
                {(() => {
                  const tool = TOOL_POPOUTS[sec.title];
                  const isBend = sec.title === "Color Bend";
                  if (!tool && !isBend) return null;
                  const popped = isBend ? state.bendPoppedOut : state.toolPopouts[tool!];
                  return (
                    <button
                      className="chip popout"
                      data-testid={`${isBend ? "bend" : tool}-popout`}
                      data-active={popped || undefined}
                      data-hint={
                        popped
                          ? "Close the floating window and bring this tool back into the panel"
                          : "Open this tool in a larger window of its own"
                      }
                      style={{ flex: "none" }}
                      // A toggle: out, and back. The way back matters most when the floating
                      // window has been lost under other windows. "I can see
                      // someone 'losing' the floating window and not being able to find it."
                      onClick={() =>
                        dispatch(
                          isBend
                            ? { type: "set_bend_popped_out", out: !popped }
                            : { type: "set_tool_popped_out", tool: tool!, out: !popped },
                        )
                      }
                    >
                      ⧉
                    </button>
                  );
                })()}
                {/* Which chain this section is writing to. Without it there
                    is no way to tell a masked edit from a global one.
                    No wrapper around it: an empty flex item still takes
                    a gap on each side, which is why the pop-out sat
                    twice as far from reset as reset does from the
                    switch. */}
                {state.activeLayer && (
                    <span
                      data-testid={`scope-${sec.title.toLowerCase().replace(/[^a-z]+/g, "-")}`}
                      data-scope={sec.layerTool ? "layer" : "global"}
                      role="img"
                      aria-label={sec.layerTool ? "Edits the selected layer" : "Applies to the whole photo"}
                      data-hint={
                        sec.layerTool
                          ? "Edits the selected layer, behind its mask"
                          : "Always applies to the whole photo"
                      }
                      style={{
                        // The glyph's own box plus Reset's padding, so
                        // the two sit on one rhythm.
                        padding: "3px 5px",
                        display: "flex",
                        alignItems: "center",
                        flex: "none",
                        color: sec.layerTool
                          ? "var(--accent)"
                          : "var(--text-ghost)",
                      }}
                    >
                      <ScopeIcon layer={!!sec.layerTool} />
                    </span>
                  )}
                <button
                  className="chip bare"
                  style={{
                    // A word was its own hit area; a nine pixel glyph is
                    // not, so the padding that used to be unnecessary
                    // now is.
                    padding: "3px 5px",
                    color: "var(--text-ghost)",
                    display: "flex",
                    alignItems: "center",
                  }}
                  onClick={() => {
                    // Reset is a VALUES operation and must not change what is switched on.
                    // armed flips a bypassed node on the moment its params say something and
                    // never flips one back, so a reset that passes through a non-neutral moment
                    // leaves the section switched on behind it. "If I turn off
                    // Color Bend and hit reset it still does not reset the color wheel but it
                    // turns on the control." Note who was off; put them back at the end.
                    if (sec.bwHost) dispatch({ type: "begin_gesture", key: "reset-color" });
                    const wasOff = new Set<string>();
                    const remember = (n?: NodeCard | null) => {
                      if (n && !n.enabled) wasOff.add(n.id);
                    };
                    remember(node);
                    sec.rows.forEach((r) => remember(r.node?.(state) ?? node));
                    (sec.alsoToggles?.(state) ?? []).forEach(remember);
                    if (sec.title === "Curves") remember(toolNode(state, "curves"));
                    if (sec.bwHost) remember(toolNode(state, "bw"));
                    sec.rows.forEach((r) => {
                      const target = r.node?.(state) ?? node;
                      // Recipe nodes reset to what the recipe ships,
                      // not to the node type's generic default: the
                      // intensity blends ship at 50, and a Reset that
                      // jumped them to 100 doubled the effect.
                      dispatch({
                        type: "set_param",
                        id: target.id,
                        param: r.param,
                        value:
                          recipeParamDefault(target.id, r.param) ??
                          paramDefault(r.param, target.type),
                      });
                    });
                    // The Console owns its bands the same way.
                    if (sec.title === "Color Tune") {
                      dispatch({
                        type: "set_params",
                        id: node.id,
                        values: {},
                        text: { bands: "" },
                      });
                    }
                    // Recolor owns its curve map and its surfaces, a
                    // verb and a mask choice: reset empties them all.
                    if (sec.title === "Recolor") {
                      dispatch({
                        type: "set_params",
                        id: node.id,
                        values: {},
                        text: { curves: "", surfaces: "", hue_hue_mode: "", by_mask: "", pairs: "" },
                      });
                    }
                    // Depth Lighting owns its rig JSON: colors, types, positions,
                    // per-light strengths. Reset clears the whole rig back to the single
                    // default light ("Reset does not reset light color, or
                    // light settings").
                    if (sec.title === "Depth Lighting") {
                      dispatch({
                        type: "set_params",
                        id: node.id,
                        values: {},
                        text: { lights: "" },
                      });
                    }
                    // Tone Equalizer owns the EQ curve: reset clears the legacy zones and puts the
                    // STARTING layout back rather than an empty plot
                    // ("Resetting Relight clears all points off, instead of the default 3
                    // stops layout" - reset should return to the default, the way every
                    // slider goes back to its default rather than vanishing).
                    if (sec.title === "Tone Equalizer") {
                      dispatch({
                        type: "set_params",
                        id: node.id,
                        values: Object.fromEntries(
                          ["ev_m4", "ev_m3", "ev_m2", "ev_m1", "ev_0", "ev_p1", "ev_p2", "ev_p3", "ev_p4"].map(
                            (p) => [p, 0],
                          ),
                        ),
                        text: {
                          points: serializeEqPoints(
                            EQ_PRESETS.find((p) => p.id === "coarse")!.points,
                          ),
                        },
                      });
                    }
                    // Exposure hosts the Zone System: its reset puts the dials at their
                    // defaults (the rows above) and drops the placement and its picker.
                    // Zones has no reset of its own (2026-09-14): this one and Undo are the
                    // ways back.
                    if (sec.zonesWidget) {
                      dispatch({ type: "arm_zone_place", zone: null });
                    }
                    if (sec.printWidget) {
                      dispatch({ type: "set_params", id: node.id, values: { ...NEUTRAL_PARAMS["heeler.paper"] }, text: { toner: "" } });
                    }
                    // Source's five profile rows live on the Tone Profile node, not the
                    // section's own, so the generic reset above never reached them
                    // (2026-09-14: "reset on Source doesn't work on all properties"). Each
                    // goes back to the default the panel shows for it.
                    if (sec.title === "Source") {
                      const profile = state.nodes.find((n) => n.type === "heeler.tone_profile");
                      if (profile) {
                        dispatch({
                          type: "set_params",
                          id: profile.id,
                          values: Object.fromEntries(
                            SOURCE_ROWS.map((r) => [r.param, paramDefault(r.param, "heeler.tone_profile")]),
                          ),
                        });
                      }
                    }
                    // Tone owns the curve editor: its reset covers curves too.
                    if (sec.title === "Curves") {
                      const curves = toolNode(state, "curves");
                      if (curves)
                        dispatch({ type: "reset_curves", id: curves.id });
                    }
                    // Color Wheels has no slider rows; reset all nine params.
                    if (sec.title === "Color Wheels") {
                      dispatch({
                        type: "set_params",
                        id: node.id,
                        values: Object.fromEntries(
                          ["shadows", "midtones", "highlights"].flatMap((r) =>
                            ["hue", "sat", "lum"].map((p) => [`${r}_${p}`, 0]),
                          ),
                        ),
                      });
                    }
                    // Color hosts the B&W treatment, so its reset owns it:
                    // back to color, with the mixer at its default weights.
                    if (sec.bwHost) {
                      const bw = toolNode(state, "bw");
                      if (bw) {
                        dispatch({
                          type: "set_params",
                          id: bw.id,
                          values: { amount: 0, red: 30, green: 59, blue: 11, hue_curve_on: 1, ir_foliage: 2.4, ir_sky: -2.5, ir_water: -0.8, ir_skin: 0.6, neutral: 10 },
                          // And the hue curve, which rides as text (2026-09-14: "Reset is not
                          // resetting the hue curve"). Empty is the mixer alone.
                          text: { hue_curve: "", filter: "", ir_curve: "", far_filter: "", depth_curve: "" },
                        });
                        // And the film: the treatment's, so its reset.
                        const profileNode = state.nodes.find((n) => n.type === "heeler.tone_profile");
                        if (profileNode) {
                          dispatch({ type: "set_params", id: profileNode.id, values: { development: 0 }, text: { film: "" } });
                        }

                      }
                    }
                    // Color Bend's wheel lives outside its slider rows, exactly like Color
                    // Wheels', and was the one that never got a case here: the source and
                    // target colors survived every reset, which is what the owner saw. Zeroed
                    // together, so the bend reads as unbent rather than as a source pinned to
                    // red.
                    if (sec.title === "Color Bend") {
                      dispatch({
                        type: "set_params",
                        id: node.id,
                        values: { src_hue: 0, src_sat: 0, dst_hue: 0, dst_sat: 0 },
                      });
                    }
                    // Detail's Advanced weights are this section's widget-owned params, the
                    // same position the wheels and curves above are in: written from a
                    // sub-panel, invisible to the row loop, and until this case they survived
                    // a Reset that read as having cleared the section. Back to even, which is
                    // 100. Grid Warp's mesh is a text param the row loop never sees; every
                    // handle back to rest, density kept. "Reset does not reset
                    // grid warp."
                    if (sec.gridWarpWidget) {
                      dispatch({ type: "grid_warp_reset", target: null });
                    }
                    // Geometry's flips are its widget's, not rows: a
                    // Reset puts the photograph back the right way round.
                    if (sec.flipWidget) {
                      const flips = photoFlips(state);
                      if (flips.h) dispatch({ type: "flip_photo", axis: "h" });
                      if (flips.v) dispatch({ type: "flip_photo", axis: "v" });
                      // And upright: the turn back the other way round.
                      const turn = photoTurn(state);
                      if (turn) dispatch({ type: "turn_photo", quarters: (4 - turn) as 1 | 2 | 3 });
                    }
                    // Shape Warp's Reset: every shape's warp back to
                    // rest, the shapes and their placement kept.
                    if (sec.shapeWarpWidget) {
                      dispatch({ type: "shape_warp_reset", target: null });
                    }
                    // Color Checker's fit, placement and patch overrides
                    // live off-row (the matrix and exposure are numbers
                    // the row loop never lists; quad, patches and fit are
                    // text). Reset puts the whole node back to untouched,
                    // the chart choice kept: that is the one answer to
                    // "take this calibration off".
                    if (sec.colorCheckerWidget) {
                      dispatch({
                        type: "set_params",
                        id: node.id,
                        values: { ...NEUTRAL_PARAMS["heeler.color_checker"] },
                        text: { quad: "", patches: "", fit: "" },
                      });
                      if (state.chartPlace) dispatch({ type: "toggle_chart_place", id: node.id });
                    }
                    if (sec.detailEq) {
                      // The Equalizer's bands and weights live off-row.
                      const eq = toolNode(state, "detaileq");
                      if (eq && state.nodes.some((n) => n.id === eq.id))
                        dispatch({ type: "set_params", id: eq.id, values: { ...NEUTRAL_PARAMS["heeler.detail_eq"] } });
                    }
                    if (sec.detailAdvanced) {
                      dispatch({
                        type: "set_params",
                        id: node.id,
                        values: Object.fromEntries(
                          DETAIL_EFFECTS.flatMap((e) =>
                            DETAIL_WEIGHTS.map(([w]) => [`${e}_${w}`, 100]),
                          ),
                        ),
                      });
                    }
                    // The switches, back exactly as they were found.
                    for (const id of wasOff) {
                      dispatch({ type: "set_enabled", id, enabled: false });
                    }
                    if (sec.bwHost) dispatch({ type: "end_gesture" });
                  }}
                  data-testid={`reset-${sec.title.toLowerCase().replace(/[^a-z]+/g, "-")}`}
                  aria-label={`Reset ${sec.title}`}
                  data-hint={`Reset ${sec.title} to its defaults`}
                >
                  <ResetIcon />
                </button>
                {/* The Export checkbox beside the switch, the pair a Finish
layer's row has beside its name (2026-09-30: "the same
toggle to Adjustment sections").*/}
                <SectionExportTick state={state} sec={sec} dispatch={dispatch} />
                {!sec.hideToggle && (() => {
                  // On means ANY of the section's nodes is live, the same set the switch
                  // flips. Reading only the host node showed Curves as on for an unedited
                  // photograph whose graph held no curve at all. "its
                  // misleading showing Curves as 'On' when its not even in the node
                  // graph." Only nodes that are IN the graph count. The rows' stand-ins
                  // (Sharpen and Denoise before their first write) are born on, and
                  // counting them lit Detail whenever its node existed, off or not (The
                  // report: "I am resetting an image and its not turning off").
                  const on = sectionIsOn(state, sec);
                  return (
                  <div
                    className="toggle"
                    data-on={on}
                    data-testid={`toggle-${sec.title.toLowerCase().replace(/[^a-z]+/g, "-")}`}
                    role="switch"
                    aria-checked={on}
                    aria-label={`${sec.title} on/off`}
                    data-hint={`${sec.title} on/off`}
                    tabIndex={0}
                    onClick={() => {
                      const next = !on;
                      // "when a user turns on a category it should auto open", and a
                      // year on, a preference, off by default. Turning one off leaves it open either
                      // way, since you may well be about to turn it back on, and a panel that folds
                      // itself up under the pointer is startling.
                      if (next && state.prefs.expandSectionOnEnable) dispatch({ type: "open_section", title: sec.title });
                      if (sec.recipe) {
                        // A recipe is a subgraph, so its switch splices or
                        // bypasses rather than toggling one node.
                        dispatch({ type: "set_recipe", recipe: sec.recipe, on: next });
                        return;
                      }
                      // Nodes the category owns go through set_category,
                      // which knows they may not exist yet and that turning
                      // the switch off must not take them away.
                      const owned = new Set(
                        (CATEGORY_PIECES[sec.title] ?? []).map((p) => p.id),
                      );
                      // On a layer, a layer tool's switch is the layer's
                      // copy (the node above), which set_enabled builds
                      // behind the mask; set_category would switch on
                      // Base's node, which the layer's user never asked
                      // for.
                      const onLayerCopy = !!state.activeLayer && !!sec.layerTool;
                      if (owned.size && !onLayerCopy)
                        dispatch({ type: "set_category", title: sec.title, on: next });
                      for (const n of [
                        node,
                        ...(sec.alsoToggles?.(state) ?? []),
                      ]) {
                        if (n && !owned.has(n.id))
                          dispatch({
                            type: "set_enabled",
                            id: n.id,
                            enabled: next,
                          });
                      }
                    }}
                  >
                    <div className="dot" />
                  </div>
                  );
                })()}
              </div>
              {/* The looks sit above the section's body (src/sectionlooks.ts). */}
              {LOOK_SECTION_TITLES.has(sec.title) && !closed && (
                <div style={{ padding: "0 12px" }}>
                  <SectionLooks section={sec.title as "Tone Equalizer" | "Recolor"} state={state} dispatch={dispatch} />
                </div>
              )}
              <div
                style={{ padding: "0 12px 9px", display: closed ? "none" : undefined }}
              >
                {sec.title === "Curves" &&
                  (() => {
                    if (state.toolPopouts.curves)
                      return <ToolPopBar tool="curves" label="Curves" dispatch={dispatch} />;
                    // The section's own node is the curve now; when it does not exist yet
                    // the section stubs to a switch before this ever renders. Drawn to the
                    // panel's width: a fixed 272 left the plot's right edge shy of the
                    // other controls. "its right edge is not flush with the
                    // other controls."
                    return (
                      <div style={{ marginBottom: 8 }}>
                        <CurveEditor
                          node={node}
                          dispatch={dispatch}
                          width={Math.max(220, (width ?? 320) - 24)}
                          channelMode={curveModeOf(state)}
                          clipboard={state.curveClipboard}
                          histogramSrc={
                            state.images.find((i) => i.id === state.activeImage)?.src
                          }
                          pickArmed={state.curvePick?.nodeId === node.id}
                          hoverX={
                            state.curvePick?.nodeId === node.id ? state.curveHoverX : null
                          }
                          onTogglePick={(ch) =>
                            dispatch({ type: "arm_curve_pick", nodeId: node.id, channel: ch })
                          }
                        />
                      </div>
                    );
                  })()}
                {sec.title === "Color Wheels" && state.toolPopouts.wheels && (
                  <ToolPopBar tool="wheels" label="Color Wheels" dispatch={dispatch} />
                )}
                {sec.title === "Color Wheels" && !state.toolPopouts.wheels && (
                  <>
                    <div
                      style={{ display: "flex", gap: 8, paddingTop: 4 }}
                      data-testid="develop-wheels"
                    >
                      {(() => {
                        // Same order and labels navSections uses, so the
                        // letter shown is the letter that works.
                        const wheels: [string, string][] = [
                          ["Shadows", "shadows"],
                          ["Mids", "midtones"],
                          ["Highs", "highlights"],
                        ];
                        const hinting =
                          state.keynav?.mode === "controls" &&
                          state.keynav.section === "Color Wheels";
                        const hints = hinting
                          ? assignHints(wheels.map(([n]) => n))
                          : [];
                        return wheels.map(([label, range], i) => (
                          <Wheel
                            key={range}
                            name={label}
                            range={range}
                            node={node}
                            dispatch={dispatch}
                            hint={hinting ? hints[i] : undefined}
                            live={
                              state.keynav?.mode === "adjust" &&
                              state.keynav.target?.section === "Color Wheels" &&
                              state.keynav.target?.param === `${range}_hue`
                            }
                          />
                        ));
                      })()}
                    </div>
                    {/* 10, matching Tone Equalizer's own point hint: the two lines do the same job
one section apart, and this one was a pixel smaller for no reason.*/}
                    <div
                      data-testid="wheels-help"
                      style={{
                        fontSize: 10,
                        color: "var(--text-ghost)",
                        marginTop: 6,
                        lineHeight: 1.5,
                      }}
                    >
                      Drag a puck toward a hue to push that tonal range toward
                      it. The bar under each wheel is that range's brightness.
                    </div>
                  </>
                )}
                {sec.title === "Color Bend" &&
                  // Handed to its own window, this folds to a bar rather
                  // than vanishing, the same way the spectrums and the
                  // graph do. The bar is the way back.
                  (state.bendPoppedOut ? (
                    <BendBar dispatch={dispatch} />
                  ) : (
                    <BendWheel
                      node={node}
                      dispatch={dispatch}
                      frame={frame}
                      engine={engine}
                      masked={isLayerNode(node.id)}
                    />
                  ))}
                {/* "a single Sharpening category with a toggle button to
switch between Vivid and Hi Pass, and other hood that rewires the
node graph."*/}
                {sec.title === "Sharpening" && node && (
                  <SharpeningRecipeControl node={node} dispatch={dispatch} />
                )}
                {sec.detailAdvanced && (
                  <DetailAdvanced node={node} dispatch={dispatch} />
                )}
                {sec.title === "Source" &&
                  (() => {
                    // Only the WB toggle is exposed: the camera color
                    // matrix is a no-op on stocks without an embedded
                    // matrix (all Panasonic RW2s) and read as broken.
                    // The param still exists on the node for graphs.
                    const on = (node.params.camera_wb ?? 1) !== 0;
                    const profile = state.nodes.find(
                      (n) => n.type === "heeler.tone_profile",
                    );
                    const sourceHints =
                      state.keynav?.mode === "controls" &&
                      state.keynav.section === "Source"
                        ? assignHints(SOURCE_ROWS.map((r) => r.label))
                        : [];
                    const liveSource =
                      state.keynav?.mode === "adjust" &&
                      state.keynav.target?.section === "Source"
                        ? state.keynav.target.param
                        : null;
                    return (
                      <div
                        style={{
                          display: "flex",
                          flexDirection: "column",
                          gap: 8,
                          paddingTop: 2,
                        }}
                      >
                        <div
                          style={{
                            display: "flex",
                            alignItems: "center",
                            justifyContent: "space-between",
                          }}
                        >
                          <div
                            style={{ fontSize: 11, color: "var(--text-body)" }}
                          >
                            As-shot white balance
                          </div>
                          <div
                            className="toggle"
                            data-on={on}
                            data-testid="source-camera_wb"
                            role="switch"
                            aria-checked={on}
                            aria-label="As-shot white balance"
                            tabIndex={0}
                            onClick={() =>
                              dispatch({
                                type: "set_param",
                                id: node.id,
                                param: "camera_wb",
                                value: on ? 0 : 1,
                              })
                            }
                          >
                            <div className="dot" />
                          </div>
                        </div>
                        {/* The decoder's three choices (LibRaw highlight reconstruction,
demosaic quality and capture sharpening), as dropdowns one width
(2026-09-29: "It just looks sloppy, make these a dropdown option
menu"). The graph inspector's Source node draws the same rows.*/}
                        {SOURCE_MENU_ROWS.map(([label, param, dflt, choices, name]) => (
                          <SourceMenuRow
                            key={param}
                            label={label}
                            name={name}
                            value={node.textParams?.[param] ?? dflt}
                            choices={choices}
                            testid={`source-${param}`}
                            onChange={(value) =>
                              dispatch({ type: "set_text_param", id: node.id, param, value })
                            }
                          />
                        ))}
                        {/* The Tone Profile's own switch (2026-10-08:
                            a fresh bake showed "profile curve is on in the
                            settings" and Linear changed nothing). A bake,
                            a JPEG, a phone DNG and a composite of finished
                            pictures are born with the profile switched off,
                            and the panel drew its rows as if it were on with
                            no switch to show it or turn it on. Off, the rows
                            step aside: none of them would act. */}
                        {profile && (
                          <div
                            style={{
                              display: "flex",
                              alignItems: "center",
                              justifyContent: "space-between",
                            }}
                          >
                            <div style={{ fontSize: 11, color: "var(--text-body)" }}>
                              Tone profile
                            </div>
                            <div
                              className="toggle"
                              data-on={profile.enabled !== false}
                              data-testid="source-tone-profile-on"
                              role="switch"
                              aria-checked={profile.enabled !== false}
                              aria-label="Tone profile"
                              tabIndex={0}
                              onClick={() =>
                                dispatch({ type: "set_enabled", id: profile.id, enabled: profile.enabled === false })
                              }
                            >
                              <div className="dot" />
                            </div>
                          </div>
                        )}
                        {profile && profile.enabled !== false && (
                          <>
                            <SourceMenuRow
                              label="Profile"
                              name="Tone profile"
                              value={profile.textParams?.mode ?? "standard"}
                              choices={PROFILE_CHOICES}
                              testid="tone-profile"
                              onChange={(value) =>
                                dispatch({ type: "set_text_param", id: profile.id, param: "mode", value })
                              }
                            />
                            {/* Applies in every mode: the lift is about
                                where the meter put the scene, not about
                                the curve drawn over it. */}
                            <Slider
                              label="Baseline"
                              param="baseline_ev"
                              node={profile}
                              dispatch={dispatch}
                              centered
                              hint={sourceHints[0]}
                              tip={ROW_TIPS["Source|Baseline"]}
                              live={liveSource === "baseline_ev"}
                            />
                            {(profile.textParams?.mode ?? "standard") !==
                              "linear" && (
                              <Slider
                                label="Profile amt"
                                param="contrast"
                                node={profile}
                                dispatch={dispatch}
                                centered={false}
                                hint={sourceHints[1]}
                              tip={ROW_TIPS["Source|Profile amt"]}
                                live={liveSource === "contrast"}
                              />
                            )}
                            <Slider
                              label="Toe"
                              param="shadow_toe"
                              node={profile}
                              dispatch={dispatch}
                              centered={false}
                              hint={sourceHints[2]}
                              tip={ROW_TIPS["Source|Toe"]}
                              live={liveSource === "shadow_toe"}
                            />
                            {/* Applies in every mode, linear included:
                                it is about what fits on the screen, not
                                about the look. */}
                            <Slider
                              label="Highlight roll"
                              param="highlight_rolloff"
                              node={profile}
                              dispatch={dispatch}
                              centered={false}
                              hint={sourceHints[3]}
                              tip={ROW_TIPS["Source|Highlight roll"]}
                              live={liveSource === "highlight_rolloff"}
                            />
                            {/* SOURCE_ROWS always declared this row, so
                                the keyboard offered a control the panel
                                never drew; the graph inspector had the
                                slider all along. */}
                            <Slider
                              label="Colorfulness"
                              param="colorfulness"
                              node={profile}
                              dispatch={dispatch}
                              centered
                              hint={sourceHints[4]}
                              tip={ROW_TIPS["Source|Colorfulness"]}
                              live={liveSource === "colorfulness"}
                            />
                            <div
                              style={{
                                fontSize: 9,
                                color: "var(--text-ghost)",
                                lineHeight: 1.5,
                              }}
                            >
                              Base rendering applied before your edits. Baseline
                              is the quiet exposure lift every editor's default
                              profile includes; Toe keeps blacks dense under it.
                              Linear is the raw scene-referred develop; Standard
                              and Film add contrast the way a camera JPEG or
                              another editor's default profile would.
                            </div>
                          </>
                        )}
                      </div>
                    );
                  })()}
                {sec.title === "Grain" && (
                  <div
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 8,
                      margin: "2px 0 7px",
                    }}
                  >
                    <div className="kicker">Pattern</div>
                    {/* A menu, not a row of buttons: side by side they read as tabs
(2026-09-15: "Grain > Pattern should be a dropdown as well").*/}
                    <MenuField
                      testid="grain-pattern"
                      label="Grain pattern"
                      hint="The grain's character: fine, standard or coarse clumps, or cinema's mix of a coarse field under a fine one"
                      node={node.id}
                      param="pattern"
                      size="regular"
                      value={node.textParams?.pattern ?? "standard"}
                      options={GRAIN_PATTERNS}
                      fitLabels={GRAIN_PATTERNS.map((p) => p.label)}
                      onChange={(value) => dispatch({ type: "set_text_param", id: node.id, param: "pattern", value })}
                    />
                  </div>
                )}
                {(() => {
                  // Letters are handed out per section, so they stay
                  // short and the same control keeps the same key.
                  const hinting =
                    state.keynav?.mode === "controls" &&
                    state.keynav.section === sec.title;
                  const rows = sec.rows.filter((r) => !r.when || r.when(state));
                  const hints = hinting
                    ? assignHints(rows.map((r) => r.label))
                    : [];
                  return rows.map((r, i) => {
                    const target = r.node?.(state) ?? node;
                    // Keyed by label, not param: Skin Softening has two
                    // rows that both write `radius` on different nodes,
                    // and duplicate keys made React log an error on
                    // every render of the panel.
                    return (
                      <React.Fragment key={r.label}>
                        {/* Recolor's graph, with the Neutral guard and its
                            strip under it (2026-10-17: "Move the neutral
                            guard below the graph"); Smoothing above. */}
                        {sec.recolorWidget && !closed && r.param === "neutral_guard" &&
                          (() => {
                            const n = sec.node(state);
                            return n ? (
                              <div style={{ margin: "2px 0 6px" }}>
                                <RecolorHost
                                  state={state}
                                  node={n}
                                  allNodes={state.nodes}
                                  clipboard={state.recolorClipboard}
                                  dispatch={dispatch}
                                  width={Math.max(220, (width ?? 320) - 24)}
                                  frame={
                                    frame ??
                                    state.images.find((i) => i.id === state.activeImage)?.src
                                  }
                                  cell={state.recolorCell}
                                  onCell={(c) => dispatch({ type: "set_recolor_cell", cell: c })}
                                  pickArmed={state.recolorPick === n.id}
                                  hoverX={state.recolorPick === n.id ? state.recolorHoverX : null}
                                  onTogglePick={() => dispatch({ type: "toggle_recolor_pick", id: n.id })}
                                  matchArmed={state.recolorMatch?.id === n.id}
                                  onToggleMatch={() => dispatch({ type: "toggle_recolor_match", id: n.id })}
                                  depthView={state.depthView}
                                  depthRed={state.maskRed}
                                  onToggleDepthView={(flavor) => dispatch({ type: "toggle_depth_view", flavor })}
                                />
                                {/* The Around row's one dial, seated with the
                                    row it serves rather than among the node's
                                    globals. */}
                                {state.recolorCell.startsWith("around_") && (
                                  <Slider
                                    label="Around reach"
                                    param="around_radius"
                                    node={n}
                                    dispatch={dispatch}
                                    centered={false}
                                  />
                                )}
                              </div>
                            ) : null;
                          })()}
                        {i === 0 && sec.note && (
                          <div
                            data-testid={`section-note-${sec.title.toLowerCase().replace(/[^a-z]+/g, "-")}`}
                            style={{ fontSize: 9, lineHeight: "12px", color: "var(--text-dim)", margin: "1px 0 5px" }}
                          >
                            {sec.note}
                          </div>
                        )}
                        {r.heading && (
                          <div
                            className="kicker"
                            data-testid={`subsection-${r.heading.toLowerCase().replace(/[^a-z]+/g, "-")}`}
                            style={{ fontSize: 8, marginTop: 7, marginBottom: 1, opacity: 0.75 }}
                          >
                            {r.heading}
                          </div>
                        )}
                        <Slider
                          label={r.label}
                          param={r.param}
                          node={target}
                          overridden={linked && state.linkOverrides.includes(`param:${target.id}|${r.param}`)}
                          onContextMenu={linked ? (e) => {
                            e.preventDefault();
                            e.stopPropagation();
                            setParamMenu({ x: e.clientX, y: e.clientY, nodeId: target.id, param: r.param, label: r.label });
                          } : undefined}
                          dispatch={dispatch}
                          centered={r.centered !== false}
                          range={r.range}
                          tip={ROW_TIPS[`${sec.title}|${r.label}`]}
                          hint={hinting ? hints[i] : undefined}
                          live={
                            state.keynav?.mode === "adjust" &&
                            state.keynav.target?.section === sec.title &&
                            state.keynav.target?.param === r.param
                          }
                          // Find a Control's landing glance, which fades.
                          flash={
                            state.controlFlash?.section === sec.title &&
                            state.controlFlash?.param === r.param
                          }
                        />
                        {/* The Neutral guard on the photograph, under its
                            slider (guardstrip.tsx). */}
                        {sec.recolorWidget && !closed && r.param === "neutral_guard" && (
                          <GuardStrip state={state} node={target} cell={state.recolorCell} dispatch={dispatch} />
                        )}
                        {/* Color pairs: two picked colors' relationship. */}
                        {sec.recolorWidget && !closed && r.param === "neutral_guard" && (
                          <RecolorPairs state={state} node={target} dispatch={dispatch} width={width ?? 320} />
                        )}
                      </React.Fragment>
                    );
                  });
                })()}
                {sec.noiseAuto && <NoiseAutoButton state={state} dispatch={dispatch} />}
                {sec.consoleWidget &&
                  (() => {
                    const n = sec.node(state);
                    return n ? (
                      <div style={{ margin: "2px 0 6px" }}>
                        <ColorConsoleBlock
                          node={n}
                          dispatch={dispatch}
                          width={Math.max(220, (width ?? 320) - 24)}
                          band={state.consoleBand}
                          onBand={(id) => dispatch({ type: "set_console_band", id })}
                          pickArmed={state.consolePick === n.id}
                          pickBand={state.consolePickBand}
                          onTogglePick={(band) => dispatch({ type: "toggle_console_pick", id: n.id, band })}
                          customMax={state.prefs.consoleCustomMax}
                          nameFormat={state.prefs.consoleNameFormat}
                          onNameFormat={(fmt) => dispatch({ type: "set_prefs", prefs: { consoleNameFormat: fmt } })}
                          compact
                        />
                      </div>
                    ) : null;
                  })()}
                {sec.levelsWidget &&
                  (() => {
                    const n = sec.node(state);
                    return n ? (
                      <div style={{ margin: "2px 0 6px" }}>
                        <LevelsEditor
                          state={state}
                          node={n}
                          dispatch={dispatch}
                          width={Math.max(220, (width ?? 320) - 24)}
                          histogramSrc={
                            frame ??
                            state.images.find((i) => i.id === state.activeImage)?.src
                          }
                        />
                      </div>
                    ) : null;
                  })()}
                {sec.depthTools === "flare" &&
                  (() => {
                    const n = sec.node(state);
                    return n ? <StreakRibbon state={state} dispatch={dispatch} node={n} /> : null;
                  })()}
                {sec.detailEq && <DetailEqualizer state={state} dispatch={dispatch} width={width ?? 320} />}
                {sec.zonesWidget && <ZonesBlock state={state} dispatch={dispatch} frame={frame} />}
                {sec.printWidget && <PrintControls node={node} dispatch={dispatch} />}
                {sec.grainFilmWidget && <GrainFrameRow grain={node} dispatch={dispatch} />}
                {sec.grainFilmWidget && <GrainFilmRow grain={node} nodes={state.nodes} dispatch={dispatch} />}
                {sec.eqWidget &&
                  (() => {
                    const n = sec.node(state);
                    return n ? (
                      <div style={{ margin: "2px 0 6px" }}>
                        <EqEditor
                          node={n}
                          dispatch={dispatch}
                          width={Math.max(220, (width ?? 320) - 24)}
                          pickArmed={state.toneEqPick === n.id}
                          hoverX={state.toneEqPick === n.id ? state.toneEqHoverX : null}
                          onTogglePick={() => dispatch({ type: "toggle_tone_eq_pick", id: n.id })}
                          // The LIVE frame, not the thumbnail: the histogram moves as the
                          // points move, which is how each point teaches what it does (the
                          // owner's ask). Thumbnail until the first engine frame lands.
                          histogramSrc={
                            frame ??
                            state.images.find((i) => i.id === state.activeImage)?.src
                          }
                        />
                      </div>
                    ) : null;
                  })()}
                {sec.depthTools && sec.depthTools !== "halation" && (
                  <div style={{ display: "flex", gap: 6, margin: "2px 0 6px", alignItems: "center" }}>
                    {/* The View depth eye sits on EVERY section that reads the map, Depth Map
included: (2026-09-05) wants it in reach while editing, and wants the
eye to say "this section uses the depth map". A deliberate exception to
the one-seat rule.*/}
                    <DepthViewButton depthView={state.depthView} red={state.maskRed}
                      onToggle={(flavor) => dispatch({ type: "toggle_depth_view", flavor })}
                      testid={`depth-view-${sec.depthTools}`} />
                    {/* The wire is the delivery (26.3 Phase 10.3): a
                        section asking for the plane with no wire to a
                        Depth Map renders flat, and says so here rather
                        than looking broken. */}
                    {sec.depthTools !== "depthmap" &&
                      (() => {
                        const n = sec.node(state);
                        if (!depthMapMissing(state, n)) return null;
                        return (
                          <span
                            className="chip"
                            data-testid={`depth-missing-${sec.depthTools}`}
                            data-hint="This section reads the Depth Map through its depth input and no wire carries one: it renders flat. Enable the Depth Map section (or a depth section) to wire it."
                            style={{ fontSize: 11, padding: "2px 8px", cursor: "default" }}
                          >
                            NO DEPTH MAP
                          </span>
                        );
                      })()}
                    {sec.depthTools === "depthmap" &&
                      (() => {
                        const n = sec.node(state);
                        const size = snapDepthSize(n?.params.size);
                        // A photograph whose file carries its own depth
                        // (an OpenEXR Z or mist pass) is read, not
                        // modeled: exact at every size, so Detail has
                        // nothing to choose and the chip says where the
                        // map came from instead.
                        const fromFile = depthFromFile(state);
                        if (fromFile) {
                          return (
                            <span
                              className="chip"
                              data-testid="depth-from-file"
                              data-hint={`The depth map is the file's own ${fromFile} pass, exact to the pixel: nothing to model, so Detail does not apply`}
                              style={{ fontSize: 11, padding: "2px 8px", cursor: "default" }}
                            >
                              FROM FILE
                            </span>
                          );
                        }
                        return (
                          <div
                            className="zoom-seg"
                            role="group"
                            aria-label="Depth detail"
                            style={{ border: "1px solid var(--line-4)" }}
                          >
                            {DEPTH_SIZES.map((s) => (
                              <button
                                key={s}
                                data-testid={`depth-size-${s}`}
                                data-active={size === s || undefined}
                                aria-pressed={size === s}
                                data-hint={
                                  s === 518
                                    ? "Read the scene at the model's own size, 518 px: fastest, the detail every other setting starts from"
                                    : s === 700
                                      ? "Read the scene at 700 px: finer edges, about twice the time"
                                      : "Read the scene at 1036 px: the finest edges, about four times the time and memory"
                                }
                                style={{ fontSize: 9, padding: "2px 7px" }}
                                onClick={() => {
                                  if (!n) return;
                                  dispatch({ type: "set_param", id: n.id, param: "size", value: s });
                                }}
                              >
                                {s}
                              </button>
                            ))}
                          </div>
                        );
                      })()}
                    {sec.depthTools === "depthmap" && (
                      <button
                        className="chip"
                        data-testid="depth-recompute"
                        data-hint={
                          depthFromFile(state)
                            ? "Read the depth pass from the file again and refine it at the current settings"
                            : "Read the scene's depth again from scratch: the model runs fresh and the map is refined at the current settings"
                        }
                        style={{ fontSize: 11, padding: "2px 8px" }}
                        onClick={() => {
                          void depthForget(state)
                            .then(() => dispatch({ type: "recompute_depth" }))
                            .catch((err) => reportToolError("Depth Map", err));
                        }}
                      >
                        RECOMPUTE
                      </button>
                    )}
                    {sec.depthTools === "keylight" && sec.node(state) && passesOf(state)?.normals && (
                      <NormalsChoice state={state} node={sec.node(state)!} dispatch={dispatch} />
                    )}
                    {(sec.depthTools === "keylight" || sec.depthTools === "flare") &&
                      (() => {
                        const n = sec.node(state);
                        const inv = ((n?.params.invert as number) ?? 0) >= 0.5;
                        return (
                          <>
                            <button
                              className="chip"
                              data-testid="keylight-rig"
                              data-active={state.keyLightPick}
                              aria-label="Position lights"
                              data-tip="Position lights"
                              data-hint={`Show the light rig in the viewer: drag a handle to aim, ${modLabel("alt")}-drag up/down for strength (below zero the light emits dark), ${modLabel("shift")}-click removes`}
                              style={{ padding: "2px 6px", display: "inline-flex" }}
                              onClick={() => dispatch({ type: "toggle_keylight_pick" })}
                            >
                              <LightRigIcon />
                            </button>
                            {sec.depthTools === "keylight" && (
                            <>
                            <button
                              className="chip"
                              data-testid="keylight-add"
                              aria-label="Add light"
                              data-tip="Add light"
                              data-hint="Add another light to the rig"
                              style={{ padding: "2px 6px", display: "inline-flex" }}
                              onClick={() => {
                                if (!n) return;
                                // The rig JSON is the whole truth once
                                // it exists, so the first Add seeds it
                                // with the current (legacy) light.
                                const rig = lightsOf(n);
                                const next = [
                                  ...rig,
                                  {
                                    kind: "directional" as const,
                                    azimuth: -135,
                                    elevation: 40,
                                    // A quarter of the way up, where the
                                    // old scale's 50 sat (2026-10-08).
                                    strength: 25,
                                    on: true,
                                    color: "#ffffff",
                                    tx: 0.5,
                                    ty: 0.5,
                                    px: 0.5,
                                    py: 0.5,
                                    depth: 30,
                                    range: 50,
                                    sun_depth: 0,
                                    sun_reach: 50,
                                    flare: false,
                                    flare_strength: 100,
                                  },
                                ];
                                writeLights(dispatch, n, next);
                                dispatch({ type: "select_keylight", index: next.length - 1 });
                                if (!state.keyLightPick) dispatch({ type: "toggle_keylight_pick" });
                              }}
                            >
                              <LightAddIcon />
                            </button>
                            <button
                              className="chip"
                              data-testid="keylight-invert"
                              data-active={inv}
                              aria-label="Invert depth"
                              data-tip="Invert depth"
                              data-hint="Flip the depth: the BACKGROUND becomes the lit relief instead of the subject"
                              style={{ padding: "2px 6px", display: "inline-flex" }}
                              onClick={() =>
                                n &&
                                dispatch({ type: "set_param", id: n.id, param: "invert", value: inv ? 0 : 1 })
                              }
                            >
                              <DepthInvertIcon />
                            </button>
                            </>
                            )}
                          </>
                        );
                      })()}
                    {sec.depthTools === "dof" && (
                      <button
                        className="chip"
                        data-testid="dof-pick"
                        data-active={state.dofPick}
                        aria-label="Set focus"
                        data-tip="Set focus"
                        data-hint="Click the photograph to set what is in focus: the depth under the click becomes the focus distance"
                        style={{ padding: "2px 6px", display: "inline-flex" }}
                        onClick={() => dispatch({ type: "toggle_dof_pick" })}
                      >
                        {/* The eyedropper, not a reticle: the cursor it puts over the photograph
is the dropper, and the two are one picture (2026-09-16: "if the
cursor is going to be an eye dropper so should the icon").*/}
                        <EyedropperIcon size={11} />
                      </button>
                    )}
                  </div>
                )}
                {/* The rig's lines color, shared with every overlay
                    (linecolor.tsx), while the rig is up. */}
                {sec.depthTools === "keylight" && state.keyLightPick && (
                  <>
                    <LinesRow
                      lineColor={state.lineColor}
                      dispatch={dispatch}
                      previewUrl={frame ?? state.images.find((i) => i.id === state.activeImage)?.src ?? null}
                      prefix="keylight"
                      subject="light handles"
                    />
                    {/* And how thick the rig draws, beside the color that draws it
(2026-09-15: "Missing the slider to control the line thickness of the
light's control handles (like with shapes)"): the shapes' own row, so
the rig draws at the one thickness every overlay reads.*/}
                    <LineWidthRow state={state} dispatch={dispatch} prefix="keylight" subject="light handles" />
                  </>
                )}
                {sec.depthTools === "depthmap" && <DepthProgressBar />}
                {(sec.depthTools === "depthmap" || sec.depthTools === "fog" || sec.depthTools === "keylight") &&
                  (() => {
                    const n = sec.node(state);
                    return n ? (
                      <DepthPlaneLevels
                        node={n}
                        state={state}
                        dispatch={dispatch}
                        testid={`depth-plane-${sec.depthTools}`}
                        width={Math.max(220, (width ?? 320) - 24)}
                        hint={DEPTH_PLANE_HINTS[sec.depthTools]}
                        raw={sec.depthTools === "depthmap"}
                      />
                    ) : null;
                  })()}
                {sec.depthTools === "flare" &&
                  (() => {
                    const n = sec.node(state);
                    return n ? <FlarePanel state={state} dispatch={dispatch} node={n} /> : null;
                  })()}
                {sec.depthTools === "halation" &&
                  (() => {
                    const n = sec.node(state);
                    if (!n) return null;
                    const format = n.textParams?.format ?? "35mm";
                    return (
                      <div style={{ display: "flex", gap: 6, margin: "2px 0 6px", alignItems: "center", flexWrap: "wrap" }}>
                        {/* The isolated-regions view: the gated source as
                            the frame, black elsewhere, so the thresholds
                            are tuned against what will bloom. */}
                        <button
                          className="chip"
                          data-testid="halation-view"
                          data-active={state.halationView}
                          aria-label="View isolated regions"
                          data-tip="View isolated regions"
                          data-hint="Show only what will bloom: the thresholded, background-gated highlights as white on black"
                          style={{ padding: "2px 6px", display: "inline-flex" }}
                          onClick={() => dispatch({ type: "toggle_halation_view" })}
                        >
                          <MaskEyeIcon />
                        </button>
                        {/* The wire is the delivery (26.3 Phase 10.3):
                            by-depth halation with no Depth Map wired
                            blooms flat, and says so here. */}
                        {depthMapMissing(state, n) && (
                            <span
                              className="chip"
                              data-testid="depth-missing-halation"
                              data-hint="This section reads the Depth Map through its depth input and no wire carries one: it renders flat. Enable the Depth Map section (or a depth section) to wire it."
                              style={{ fontSize: 11, padding: "2px 8px", cursor: "default" }}
                            >
                              NO DEPTH MAP
                            </span>
                          )}
                        {/* A menu, not a row of buttons (2026-09-15: "When buttons are side by
side it reads like a tab view").*/}
                        <div
                          className="kicker"
                          data-hint="Format: the film gauge the halation is scaled for. A small gauge is enlarged more for viewing, so its halation shows larger; 35mm is the reference"
                        >
                          Format
                        </div>
                        <MenuField
                          testid="halation-format"
                          label="Film format"
                          node={n.id}
                          param="format"
                          size="regular"
                          value={format}
                          options={HALATION_FORMATS}
                          fitLabels={HALATION_FORMATS.map((f) => f.label)}
                          hint={
                            format === "35mm"
                              ? "35mm: the reference gauge, the spread as set"
                              : format === "65mm"
                                ? "65mm: a large gauge, enlarged less, a tighter halation"
                                : `${format}: a small gauge, enlarged more for viewing, a larger and more prominent halation`
                          }
                          onChange={(value) => dispatch({ type: "set_text_param", id: n.id, param: "format", value })}
                        />
                      </div>
                    );
                  })()}
                {sec.depthTools === "keylight" &&
                  (() => {
                    const n = sec.node(state);
                    return n ? (
                      <KeyLightControls state={state} dispatch={dispatch} node={n} />
                    ) : null;
                  })()}
                {sec.flipWidget && <FlipPhotoRow nodes={state.nodes} activeImage={state.activeImage} dispatch={dispatch} />}
                {sec.gridWarpWidget && <GridWarpControls state={state} dispatch={dispatch} frame={frame} />}
                {sec.shapeWarpWidget && <ShapeWarpControls state={state} dispatch={dispatch} frame={frame} />}
                {sec.colorCheckerWidget && <ColorCheckerControls state={state} dispatch={dispatch} frame={frame} />}
                {sec.lensProfile && (
                  <>
                    <LensProfileLine
                      imageId={state.activeImage}
                      state={state}
                      dispatch={dispatch}
                    />
                    <LensPresetRow state={state} dispatch={dispatch} />
                  </>
                )}
                {sec.hasAuto && (
                  // The white balance row. All three of these were chips with no onClick
                  // at all until the owner noticed ("Please wire them in so they actually
                  // do something"); the arithmetic behind them is in src/whitebalance.ts,
                  // mirrored from the engine's own gain model so a solve lands where the
                  // render does.
                  <div style={{ display: "flex", gap: 6, marginTop: 5 }}>
                    <button
                      className="chip"
                      data-testid="wb-auto"
                      data-hint="Balance the whole frame toward neutral, the gray-world way"
                      onClick={() => {
                        if (!frame) {
                          flashStatus("Auto white balance needs a frame on screen");
                          return;
                        }
                        void averageColor(frame).then((avg) => {
                          if (!avg) {
                            flashStatus("Auto white balance could not read the frame");
                            return;
                          }
                          // The frame on screen already carries the
                          // current dials, so the solve composes with
                          // them rather than starting from neutral.
                          const wb = neutralize(avg, {
                            temperature: node.params.temperature ?? 6500,
                            tint: node.params.tint ?? 0,
                          });
                          if (!wb) {
                            flashStatus("Auto white balance found nothing to balance");
                            return;
                          }
                          logDebug(
                            () =>
                              `Auto white balance: ${wb.temperature} K, tint ${wb.tint > 0 ? "+" : ""}${wb.tint}`,
                          );
                          dispatch({ type: "set_params", id: node.id, values: wb });
                        });
                      }}
                    >
                      Auto
                    </button>
                    <button
                      className="chip"
                      data-testid="wb-as-shot"
                      data-hint="Back to the camera's own white balance"
                      onClick={() =>
                        dispatch({ type: "set_params", id: node.id, values: { ...AS_SHOT } })
                      }
                    >
                      As Shot
                    </button>
                    {/* The picture, not the word: it is the same gesture the Curves and
Tone Equalizer pickers offer, so it wears the same eyedropper. The chip
keeps its own padding, so it stays the height of Auto and As Shot
beside it.*/}
                    <button
                      className="chip"
                      data-testid="wb-pick"
                      data-active={state.wbPick === node.id || undefined}
                      aria-pressed={state.wbPick === node.id}
                      aria-label="Eyedropper"
                      data-hint="Click something gray in the photograph and the white balance follows it"
                      style={{ display: "flex", alignItems: "center" }}
                      onClick={() =>
                        dispatch({
                          type: "arm_wb_pick",
                          id: state.wbPick === node.id ? null : node.id,
                        })
                      }
                    >
                      <EyedropperIcon size={12} />
                    </button>
                  </div>
                )}
                {/* Shown whenever the section's body is, switched on or off
(2026-09-09: "I don't see the Classic or Model"): the choice is
made before the switch as often as after it.*/}
                {sec.denoiseMethod && <DenoiseMethodRow state={state} dispatch={dispatch} />}
                {sec.bwHost &&
                  (() => {
                    const bw = toolNode(state, "bw");
                    if (!bw) return null;
                    // Treatment is the amount param, not the enabled flag:
                    // enabled stays a pure bypass so the section switch can
                    // gate B&W without clobbering the treatment choice.
                    const bwOn = (bw.params.amount ?? 0) > 0;
                    return (
                      <div style={{ marginTop: 9 }}>
                        <div
                          style={{
                            display: "flex",
                            alignItems: "center",
                            gap: 8,
                          }}
                        >
                          <div className="kicker">Treatment</div>
                          <div
                            className="zoom-seg"
                            role="group"
                            aria-label="Color treatment"
                            style={{ border: "1px solid var(--line-4)" }}
                          >
                            {/* Icons, not words: three overlapping circles for color, a
half-filled circle for black and white.*/}
                            <button
                              data-active={!bwOn}
                              data-testid="bw-mode-color"
                              aria-label="Color"
                              data-hint="Color: the photograph as shot"
                              style={{ display: "inline-flex", alignItems: "center", padding: "2px 8px" }}
                              onClick={() =>
                                dispatch({
                                  type: "set_param",
                                  id: bw.id,
                                  param: "amount",
                                  value: 0,
                                })
                              }
                            >
                              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden focusable="false">
                                <circle cx="12" cy="8" r="5" />
                                <circle cx="8" cy="15" r="5" />
                                <circle cx="16" cy="15" r="5" />
                              </svg>
                            </button>
                            <button
                              data-active={bwOn}
                              data-testid="bw-mode-bw"
                              aria-label="Black and white"
                              data-hint="Black and white: the channel mixer decides the tones"
                              style={{ display: "inline-flex", alignItems: "center", padding: "2px 8px" }}
                              onClick={() =>
                                dispatch({
                                  type: "set_param",
                                  id: bw.id,
                                  param: "amount",
                                  value: 100,
                                })
                              }
                            >
                              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden focusable="false">
                                <circle cx="12" cy="12" r="8" />
                                <path d="M12 4a8 8 0 0 1 0 16z" fill="currentColor" stroke="none" />
                              </svg>
                            </button>
                          </div>
                        </div>
                        {bwOn && (
                          <div
                            data-testid="bw-mixer"
                            style={{
                              marginTop: 7,
                              paddingLeft: 10,
                              borderLeft: "2px solid var(--line-3)",
                            }}
                          >
                            <div className="kicker" style={{ marginBottom: 2 }}>
                              Black &amp; white mix
                            </div>
                            {/* One component for the whole treatment, the
                                graph inspector's too (bwcontrols.tsx). */}
                            <BwControls bw={bw} nodes={state.nodes} state={state} dispatch={dispatch} width={width} />
                          </div>
                        )}
                      </div>
                    );
                  })()}
              </div>
            </div>,
          );
        })}
      </div>
  );
}

function SimplePanelImpl({
  state: realState,
  dispatch: realDispatch,
  width,
  frame,
  engine,
}: {
  state: State;
  dispatch: D;
  width?: number;
  /** The frame on screen, so Bend can plot this photo's own colors. */
  frame?: string | null;
  /** whether that frame came from the engine or the CSS approximation */
  engine?: boolean;
}) {
  // A switched-off category has no node, so the panel is handed one that
  // does not exist: enough to draw its controls with, and swapped for a real
  // one the instant somebody uses them. Everything below this line reads the
  // same state it always did and cannot tell the difference, which is the
  // point. Nothing here reaches the graph or the engine.
  const previews = previewNodes(realState.nodes);
  const state: State = previews.length
    ? { ...realState, nodes: [...realState.nodes, ...previews] }
    : realState;
  const previewIds = new Set(previews.map((n) => n.id));
  // Stamped with its root: the warp sections publish their wheel and pad
  // motion on THIS function and the viewer listens on its own wrapper,
  // and the live channel (gridwarplive.ts) joins the two only through the
  // root ("You didn't fix the preview in Twist and Pinch").
  // The builds this render's controls already asked for. The previews
  // above are this render's, so a second command in the same event (the
  // Recipe control switches its node on and then sets the mode) still
  // names a preview: the build is not asked for twice.
  const builtNow = new Set<string>();
  const dispatchBuilding: D = withRootDispatch((cmd: Command) => {
    // Touching a control on a category nobody has switched on is switching
    // it on. The alternative is a slider that moves and does nothing, and
    // this app has had enough of those.
    // (The sharpening mode is a text param on the node now, so choosing
    // it names the node and the rule above builds the section.)
    const id = (cmd as { id?: string }).id;
    const build = id && previewIds.has(id) ? buildFor(id) : undefined;
    if (!build) return realDispatch(cmd);
    const key = JSON.stringify(build);
    if (builtNow.has(key)) {
      // The build switched the section on; saying so again would be a
      // second history step for nothing.
      if (cmd.type === "set_enabled" && cmd.enabled) return;
      return realDispatch(cmd);
    }
    builtNow.add(key);
    // The build and the move that caused it are one edit, one undo step,
    // the same step the section's switch makes (reduce: `then`).
    realDispatch({ ...build, then: cmd });
  }, realDispatch);
  const dispatch: D = dispatchBuilding;
  // The tab lives in app state so a key can move between tabs; this is
  // just a shorthand for reading it.
  const [tabMenu, setTabMenu] = useState<{ x: number; y: number; tab: PanelTab } | null>(null);
  const tabMenuRef = useDismiss<HTMLDivElement>(tabMenu !== null, () => setTabMenu(null));
  const topPane = useRef<HTMLDivElement | null>(null);
  const selPane = useRef<HTMLDivElement | null>(null);
  // One entry either way, so the height is known without measuring: the
  // menu is a single row plus the border and padding around it.
  const tabMenuAt = tabMenu
    ? (() => {
        // The panel is CSS-zoomed (.ui-zoom), and a fixed-position menu inside
        // a zoomed subtree measures in zoomed units while the pointer's
        // clientX/Y arrive in viewport pixels. Unscaled, the menu drifted from
        // the tab by the zoom's share of its distance from the origin. The
        // report: "the pop up menu was not near the tab."
        const z =
          parseFloat(
            getComputedStyle(document.documentElement).getPropertyValue("--chrome-zoom"),
          ) || 1;
        const vp = viewportSize();
        const p = clampMenu(
          { x: tabMenu.x / z, y: tabMenu.y / z },
          { w: TAB_MENU_W, h: 40 },
          { w: vp.w / z, h: vp.h / z },
        );
        return { left: p.x, top: p.y };
      })()
    : { left: 0, top: 0 };
  const bottomIds = state.panelBottom;
  // visiblePanelTabs, not PANEL_TABS: a gated tab (Tether with
  // experimental features off) gets no seat in either pane, and the
  // fallbacks below move the active marker off it.
  const shown = visiblePanelTabs(state.prefs);
  const top = shown.filter((t) => !bottomIds.includes(t.id));
  const bottom = shown.filter((t) => bottomIds.includes(t.id));
  const split = bottom.length > 0;
  // The stored active tab can name a tab that has moved to the other
  // pane, so each pane falls back to its own first rather than showing
  // nothing at all.
  const topActive = top.some((t) => t.id === state.panelTab) ? state.panelTab : top[0].id;
  const bottomActive =
    bottom.find((t) => t.id === state.panelTabBottom)?.id ?? bottom[0]?.id ?? "history";

  const pane = (
    tabs: typeof PANEL_TABS,
    active: PanelTab,
    pick: (t: PanelTab) => void,
    testid: string,
  ) => (
    <>
      <PanelTabs
        tabs={tabs}
        active={active}
        onPick={pick}
        onMenu={(t, at) => setTabMenu({ ...at, tab: t })}
        testid={testid}
      />
      {tabs.some((t) => t.id === "layers") && active === "layers" && (
        <ArtLayersTab state={state} dispatch={dispatch} width={width} />
      )}
      {tabs.some((t) => t.id === "history") && active === "history" && (
        <HistoryTab state={state} dispatch={dispatch} />
      )}
      {tabs.some((t) => t.id === "presets") && active === "presets" && (
        <PresetsTab state={state} dispatch={dispatch} />
      )}
      {tabs.some((t) => t.id === "metadata") && active === "metadata" && (
        <MetadataTab state={state} dispatch={dispatch} />
      )}
      {tabs.some((t) => t.id === "tether") && active === "tether" && (
        <TetherTab state={state} dispatch={dispatch} />
      )}
      {tabs.some((t) => t.id === "adjust") && (
        <AdjustBody
          state={state}
          dispatch={dispatch}
          frame={frame}
          engine={engine}
          showing={active === "adjust"}
          width={width}
        />
      )}
    </>
  );

  return (
    // flex none: a 1:1 zoomed viewer must never crush this panel.
    <div
      className="panel-right ui-zoom"
      data-testid="simple-panel"
      style={{
        flex: "none",
        ...(width ? { width } : {}),
        display: "flex",
        flexDirection: "column",
        minHeight: 0,
      }}
    >
      <div
        ref={topPane}
        data-testid="panel-pane-top"
        style={{
          display: "flex",
          flexDirection: "column",
          minHeight: 0,
          // Zero means nobody has dragged the seam yet, and both panes take flex: 1,
          // which is an even split. "I split the panel but it did not
          // split in half, the bottom split is taking up the most room." It was a
          // fixed 340 pixels against a bottom pane that took everything else, so on a
          // tall window the top looked like a sliver.
          ...(split && state.panelSizes.rightSplit > 0
            ? { height: state.panelSizes.rightSplit, flex: "none" }
            : { flex: 1 }),
        }}
      >
        {pane(top, topActive, (t) => dispatch({ type: "set_panel_tab", tab: t }), "panel-tabs")}
      </div>

      {/* "Split the right panel vertically and move the second
tab down to its own view... do not split that panel more than
twice." Two panes is the whole model, so there is no third to
refuse: a tab is down here or it is up there.*/}
      {split && (
        <>
          <PanelDivider
            vertical={false}
            testid="divider-right-split"
            onDelta={(d) =>
              dispatch({
                type: "set_panel_size",
                panel: "rightSplit",
                // Measured, not remembered. "And I can't resize it." The drag
                // handler is registered once on mousedown and so closed over the render it
                // was made in, which meant every delta was added to the same stale number
                // and the seam sprang back. app.tsx's dividers read through a ref for
                // exactly this reason; reading the pane's own height is the same trick and
                // it also starts from wherever an even split happens to have put it.
                size: (topPane.current?.offsetHeight ?? 0) + d,
              })
            }
          />
          <div
            data-testid="panel-pane-bottom"
            style={{
              flex: 1,
              minHeight: 0,
              display: "flex",
              flexDirection: "column",
              borderTop: "1px solid var(--line-2)",
            }}
          >
            {pane(
              bottom,
              bottomActive as PanelTab,
              (t) => dispatch({ type: "set_panel_tab_bottom", tab: t }),
              "panel-tabs-bottom",
            )}
          </div>
        </>
      )}

      {/* The selection, as an automatic split rather than a tab. The owner
tried the tab and called it: "what I think should happen is that the
selection tab automatically goes to split panel all the time... do
not make it its own tab." It appears while the select tool is in
hand or a selection adjustment layer is being worked, and leaves
when they do; presence is derived, with one flag over it: the door
closes it until the select tool is armed or a layer is clicked
(2026-09-22: the door used to step off the layer to get the panel
gone, which read as deselecting everything). It folds to a bar and
back, and a dragged height survives the fold.*/}
      {!state.selectionSplitClosed &&
        (state.tool === "select" ||
          (() => {
            const mask = activeSelectionMask(state);
            return !!mask && ((mask.regions ?? []).some(r => !r.off) ||
              (mask.strokes ?? []).length > 0 || !!mask.textParams?.matte_id);
          })() ||
          (state.activeLayer &&
            state.nodes.find((n) => n.id === maskOfLayer(state.activeLayer!))?.type ===
              "heeler.selection_mask")) &&
        (state.selectionSplitMin ? (
          <button
            data-testid="selection-split-bar"
            data-hint="Bring the selection panel back up"
            onClick={() => dispatch({ type: "toggle_selection_split" })}
            style={{
              all: "unset",
              cursor: "pointer",
              flex: "none",
              display: "flex",
              alignItems: "center",
              gap: 8,
              padding: "5px 12px",
              borderTop: "1px solid var(--line-2)",
              background: "var(--bg-panel-head)",
            }}
          >
            <span className="kicker" style={{ fontSize: 8, flex: 1 }}>Selection</span>
            <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="var(--text-dim)" strokeWidth="2">
              <path d="M18 15l-6-6-6 6" />
            </svg>
          </button>
        ) : (
          <>
            <PanelDivider
              vertical={false}
              testid="divider-selection-split"
              grip
              onDelta={(d) =>
                dispatch({
                  type: "set_panel_size",
                  panel: "selectionSplit",
                  // The divider sits above this pane, so dragging down
                  // shrinks it. Measured, not remembered, same as the
                  // right split's seam.
                  size: (selPane.current?.offsetHeight ?? 0) - d,
                })
              }
            />
            <div
              ref={selPane}
              data-testid="selection-split"
              style={{
                flex: "none",
                height: state.panelSizes.selectionSplit > 0 ? state.panelSizes.selectionSplit : 240,
                overflowY: "auto",
                display: "flex",
                flexDirection: "column",
                borderTop: "1px solid var(--line-2)",
              }}
            >
              <SelectTab
                state={state}
                dispatch={dispatch}
                onMinimize={() => dispatch({ type: "toggle_selection_split" })}
              />
            </div>
          </>
        ))}

      {/* The Inspect panel, docked under everything else while a point
          is inspected (inspect.tsx). */}
      <InspectDock state={state} dispatch={dispatch} />

      {tabMenu && (
        <div
          ref={tabMenuRef}
          className="ctx-menu"
          data-testid="tab-menu"
          // "the split popup is cutoff." These tabs are as far right as
          // the window goes, so a menu opening at the pointer has nowhere to go but
          // off the edge. It opens to the left of the pointer there instead, which
          // is what every desktop menu does.
          style={{ position: "fixed", width: TAB_MENU_W, ...tabMenuAt }}
          onMouseDown={(e) => e.stopPropagation()}
        >
          {bottomIds.includes(tabMenu.tab) ? (
            <button
              data-testid="tab-menu-up"
              onClick={() => {
                dispatch({ type: "move_tab_up", tab: tabMenu.tab });
                setTabMenu(null);
              }}
            >
              Move Back Up
            </button>
          ) : (
            <button
              data-testid="tab-menu-down"
              // The first one splits the panel; the rest join the pane it
              // made. One entry either way, because "split" and "move
              // down" are the same gesture from the user's side.
              onClick={() => {
                dispatch({ type: "move_tab_down", tab: tabMenu.tab });
                setTabMenu(null);
              }}
            >
              {split ? "Move Down" : "Split Panel and Move Down"}
            </button>
          )}
        </div>
      )}
    </div>
  );
}

// Memoized against everything but the view-only fields (see viewmemo.ts):
// panning and zooming re-dispatch at wheel rate and change nothing this
// panel draws.
export const SimplePanel = memo(SimplePanelImpl, panePropsEqual);
