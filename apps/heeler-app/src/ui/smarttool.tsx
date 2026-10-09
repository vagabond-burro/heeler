// The smart-mask click tool.
//
// Armed whenever a Smart layer is active: click adds, ALT-click
// subtracts, each click refining the same mask. The prompts live on
// the mask node as normalized coordinates (the recipe, portable and
// undoable); the raster is computed backend-side against the cached
// per-image embedding, and the completion write of the `model` param
// is what both records provenance and triggers the render that shows
// the new mask.
//
// The first arming on a machine without the model shows the consent
// card instead of a dead tool: the model's name, license, size and
// source, and nothing downloads until the button is pressed
// (spec: nothing fetched silently).

import { isPrimaryPress } from "./pointerguard";
import React, { useEffect, useRef, useState } from "react";
import {
  bakeMaskRaster,
  inpaintFill,
  smartClick,
  smartMatte,
  smartModelDownload,
  smartModelStatus,
  smartRasterStatus,
  smartSelect,
  type SmartModels,
} from "../bridge";
import { logMsg } from "../log";
import { reportToolError } from "./hints";
import { DepthViewIcon, MaskEyeIcon, MaskOverlayIcon, SmartIcon } from "./panelicons";
import { ModelConsentCard } from "./modelconsent";
import { modLabel } from "../platform";
import type { Command, NodeCard, State } from "../state";
import { activeSelectionMask, artLayers, artMaskNode, removalPending, maskViewOverriddenBy, smartMaskInHand } from "../state";
import { publishBusy } from "./statusbar";
import { parseSmartPoints, smartMarkersOn, smartPromptAt, subjectAim } from "../smartpoints";

type D = React.Dispatch<Command>;

/** CLEAR on its own, so the Layers panel can seat it where the owner
 * asked: between RESET and Show mask. Forgets every click and the
 * computed mask in one undoable step.*/
export function SmartClearButton({ state, dispatch, inRow = false, mask: aimed }: { state: State; dispatch: D; inRow?: boolean; mask?: NodeCard }) {
  const mask = aimed ?? activeSmartMask(state);
  if (!mask) return null;
  const prompts = mask.textParams?.prompts ?? "[]";
  const mode = mask.textParams?.mode ?? "click";
  const hasSelection =
    prompts !== "[]" || (mask.textParams?.model ?? "") !== "" || mode !== "click" || (mask.regions ?? []).length > 0;
  // A picture since 2026-09-29 ("make the Clear button
  // an icon too"), the Console's Clear: square like the mode and
  // action buttons in the smart row, and at the mask header's 18 px
  // chip height where it sits between Reset and Show mask.
  const button = (
    <button
      className={inRow ? undefined : "chip small"}
      style={inRow ? SMART_ICON_BUTTON : { display: "inline-flex", alignItems: "center", justifyContent: "center", width: 18, height: 18, padding: 0, boxSizing: "border-box" }}
      data-testid="smart-clear"
      disabled={!hasSelection}
      aria-label="Clear"
      data-tip="Clear"
      data-hint="Clear: start the selection over, forgetting every click, the mode, and the computed mask"
      onClick={() =>
        // The MODE resets too. It used to stay, and clearing a one-shot
        // selection did nothing visible: sky mode with no prompts is the same
        // recipe that computed the sky, so the old raster kept right on
        // planting. "I could click clear but it didn't do
        // anything."
        dispatch({
          type: "set_params",
          id: mask.id,
          values: {},
          text: { mode: "click", prompts: "[]", model: "" },
          // The shapes drawn on it with the selection tools go with
          // the clicks: they edited the selection being forgotten.
          clearRegions: true,
        })
      }
    >
      <SmartIcon id="clear" />
    </button>
  );
  return inRow ? (
    <div className="zoom-seg act" style={{ border: "1px solid var(--line-4)" }}>
      {button}
    </div>
  ) : (
    button
  );
}

/** The ONE Show Mask eye, as a seatable chip: click shows or hides
 * the mask in the current flavor, ALT/CMD-click switches the
 * app-wide flavor, glyph is the flavor - everywhere it appears. The
 * report: "like we did in other places, set that button to toggle
 * to overlay when the modifier key is used. To keep everything
 * consistent."*/
export function MaskViewButton({ state, dispatch, padding = "1px 6px" }: {
  state: State;
  dispatch: D;
  /** a Finish layer's button strip pads it like the icon buttons beside it */
  padding?: string;
}) {
  const override = state.maskView ? maskViewOverriddenBy(state) : null;
  return (
    <button
      className="chip"
      data-testid="mask-view-chip"
      data-overridden={override ? "true" : undefined}
      data-active={state.maskView}
      data-tip="Show mask"
      aria-pressed={state.maskView}
      aria-label={
        state.maskRed ? "Show mask as a red overlay" : "Show mask as black and white"
      }
      data-hint={`${override ? `Show mask is on, but ${override} is showing instead. Turn it off to see the mask. ` : ""}Show this mask ${
        state.maskRed ? "as a red tint over the photograph" : "as black/white"
      }; ${modLabel("alt")}-click switches between black/white and the red overlay`}
      style={{
        padding,
        color: override ? "var(--warn)" : state.maskView ? "var(--accent)" : "var(--text-ghost)",
        borderColor: override ? "var(--warn)" : state.maskView ? "var(--accent)" : "var(--line-4)",
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
  );
}

/** Whether a click on a depth eye is the modifier click: ALT, or CMD
 * as the layer mask eye accepts. */
export function depthEyeModifier(e: { altKey: boolean; metaKey: boolean } | undefined): boolean {
  return !!e && (e.altKey || e.metaKey);
}

/** The depth eye's status-line hint, one sentence set for every seat.
 * `mask`: the eye sits in a Depth mask block, where the modifier shows
 * that block's own mask. */
export function depthEyeHint({ red, mask = false, covering = false, maskShown = false, whose = "layer's mask" }: {
  red: boolean; mask?: boolean; covering?: boolean; maskShown?: boolean;
  /** what the block's mask is called: "layer's mask" or "set's range" */
  whose?: string;
}): string {
  const alt = modLabel("alt");
  if (maskShown) {
    return `This ${whose} shows ${red ? "in red" : "black/white"}, depth mask applied; click to see the depth map over it, ${alt}-click for ${red ? "black/white" : "red"}`;
  }
  if (covering) {
    return `Showing the depth map over this ${whose}: its mask view stays on, hidden while View depth is. Turn View depth off to see the mask, depth mask applied`;
  }
  if (mask) {
    return `Show the depth map ${red ? "as a red tint over the photograph" : "as black/white"}, white near; ${alt}-click shows this ${whose} in red, depth mask applied`;
  }
  return `Show the depth map ${red ? "as a red tint over the photograph" : "as black/white"}, white near, flipping with Invert Depth; ${alt}-click switches black/white and the red overlay`;
}

/** One depth view switch, shared wherever the map is read. A click
 * shows the depth map in the app-wide mask flavor; the modifier click
 * flips the flavor, the layer mask eye's contract (2026-09-29: "when
 * holding a modifier and you click it shows the red overlay"). The
 * glyph is the flavor, as on the mask eye. Pressed means View depth is
 * on and nothing else: in a Depth mask block the modifier click shows
 * the block's mask through its own mask eye, which is the eye that
 * lights.*/
export function DepthViewButton({ depthView, onToggle, testid, coversMask = false, red = false, mask = false, maskShown = false, whose }: {
  depthView: boolean;
  /** `flavor`: the click came with the modifier */
  onToggle: (flavor: boolean) => void;
  testid: string;
  /** Show mask is on too: say that the depth map takes the frame over
   * it*/
  coversMask?: boolean;
  /** the app-wide flavor is the red overlay */
  red?: boolean;
  /** the eye sits in a Depth mask block */
  mask?: boolean;
  /** that block's own mask is what the frame shows */
  maskShown?: boolean;
  /** what the block's mask is called in the hints */
  whose?: string;
}) {
  const on = depthView;
  return (
    <button className="chip" data-testid={testid} data-active={on}
      data-flavor={red ? "red" : "bw"}
      aria-pressed={on} aria-label="View depth" data-tip="View depth"
      data-hint={depthEyeHint({ red, mask, covering: depthView && coversMask, maskShown: maskShown && !depthView, whose })}
      style={{ padding: "2px 6px", display: "inline-flex", alignItems: "center" }}
      onClick={(e) => onToggle(depthEyeModifier(e))}>
      {red ? <MaskOverlayIcon /> : <DepthViewIcon />}
    </button>
  );
}

/** The dab-preview toggle as an icon chip, beside the eye. The
 * report: "make buttons (with icons) for Dab preview." Off keeps
 * the ring.*/
export function DabPreviewButton({ state, dispatch }: { state: State; dispatch: D }) {
  return (
    <button
      className="chip"
      data-testid="brush-show-dab"
      data-active={state.brushShowDab}
      data-tip="Dab preview"
      aria-pressed={state.brushShowDab}
      aria-label="Dab preview"
      data-hint="The soft dab under the cursor showing what a stroke will leave; off keeps just the ring"
      style={{
        padding: "1px 6px",
        color: state.brushShowDab ? "var(--accent)" : "var(--text-ghost)",
        borderColor: state.brushShowDab ? "var(--accent)" : "var(--line-4)",
      }}
      onClick={() => {
        const show = !state.brushShowDab;
        void import("../uiprefs").then(({ setUiPref }) => setUiPref("brushShowDab", show));
        dispatch({ type: "set_brush_show_dab", show });
      }}
    >
      {/* A soft dot inside the ring: the dab itself. */}
      <svg width="11" height="11" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" aria-hidden="true">
        <circle cx="8" cy="8" r="6" />
        <circle cx="8" cy="8" r="2.6" fill="currentColor" stroke="none" opacity="0.75" />
      </svg>
    </button>
  );
}

/** Carries the fill for Select > Remove Object: the menu command
 * splices the Inpaint (undoable graph surgery); this runner notices
 * the spliced node still waiting for its fill and runs the model
 * against the graph that now carries it - the same two-step the
 * panel chip used to drive, homeless no more since the chip moved
 * out of the selection panel ("If Remove is for
 * generative fill content then why have it here?"). Consent before
 * any download, as ever.*/
export function RemoveRunner({ state, dispatch }: { state: State; dispatch: D }) {
  const pending = state.nodes.filter(
    (n) =>
      n.type === "heeler.inpaint" &&
      n.id.startsWith("inpaint_") &&
      (n.textParams?.fill_id ?? "") === "",
  );
  // The Finish flavor ("if I am working in Finish tab, the
  // results should end up in a Fill layer"): a Fill layer whose
  // selection- snapshot mask names its source and whose fill has not
  // landed. The fill BRUSH's layers are FillRunner's; the source
  // pointer is what marks a layer as this runner's.
  const artPending = artLayers(state)
    .map((l) => ({
      blendId: l.blend.id,
      contentId: l.content.id,
      content: l.content,
      mask: artMaskNode(state, `art_m_${l.blend.id}`),
    }))
    .filter(
      (x) =>
        x.content.type === "heeler.inpaint" &&
        (x.content.textParams?.fill_id ?? "") === "" &&
        (x.mask?.textParams?.source ?? "") !== "",
    );
  const attempted = useRef<Record<string, boolean>>({});
  const [filling, setFilling] = useState(false);
  const [needModel, setNeedModel] = useState(false);
  const [models, setModels] = useState<SmartModels | null>(null);
  const [downloading, setDownloading] = useState(false);
  useEffect(() => {
    if (!needModel) return;
    let live = true;
    void smartModelStatus().then((m) => {
      if (live) setModels(m);
    });
    return () => {
      live = false;
    };
  }, [needModel, downloading]);
  useEffect(() => {
    if (filling) return;
    // The Finish flavor runs the same two phases against its layer:
    // bake the source into the layer mask's base, then fill the
    // content against it.
    //
    // The attempt latch keys on IMAGE and BAKE, never the bare layer
    // id: Finish layer ids are REUSED after a delete (delete art_b1,
    // the next layer is art_b1 again), and a bare-id latch made the
    // second removal bake its hole and then silently skip its fill
    // forever. "It creates the layer, then nothing." The
    // baked pointer is unique per snapshot, so it is the honest key.
    const artKey = (x: (typeof artPending)[number]) =>
      `${state.activeImage}|${x.blendId}|${x.mask?.textParams?.matte_id ?? ""}`;
    // Prune latches whose work item is gone: a deleted layer or a
    // healed splice takes its latch with it, so re-doing the same
    // removal retries honestly. Only items still pending (a fill that
    // errored and stayed empty) keep their latch, which is the loop
    // the latch exists to stop.
    const liveKeys = new Set([
      ...artPending.map(artKey),
      ...pending.map((n) => `${state.activeImage}|${n.id}`),
    ]);
    for (const k of Object.keys(attempted.current)) {
      if (!liveKeys.has(k)) delete attempted.current[k];
    }
    const artDue = artPending.find((x) => !attempted.current[artKey(x)]);
    if (artDue && artDue.mask) {
      if ((artDue.mask.textParams?.matte_id ?? "") === "") {
        setFilling(true);
        publishBusy("REMOVING · snapshotting the selection");
        void bakeMaskRaster(state, artDue.mask.textParams!.source!)
          .then((version) => {
            dispatch({
              type: "set_text_param",
              id: artDue.mask!.id,
              param: "matte_id",
              value: `baked:${version}`,
            });
          })
          .catch((err) => reportToolError("Remove", err))
          .finally(() => {
            publishBusy(null);
            setFilling(false);
          });
        return;
      }
      attempted.current[artKey(artDue)] = true;
      setFilling(true);
      publishBusy("REMOVING · the model is filling the hole");
      void inpaintFill(state, artDue.contentId, artDue.mask.id)
        .then((fillId) => {
          setNeedModel(false);
          dispatch({ type: "art_content_set", id: artDue.blendId, param: "fill_id", value: fillId });
          dispatch({ type: "art_content_set", id: artDue.blendId, param: "model", value: "lama" });
        })
        .catch((err) => {
          if (String(err).includes("model not installed")) {
            setNeedModel(true);
            delete attempted.current[artKey(artDue)];
          } else {
            reportToolError("Remove", err);
          }
        })
        .finally(() => {
          publishBusy(null);
          setFilling(false);
        });
      return;
    }
    // Same latch rule for the chain flavor: ids are unique per splice
    // within one image, but the SAME id recurs across photographs, so
    // the image rides the key or photo B's removal inherits photo A's
    // attempt.
    const due = pending.find((n) => !attempted.current[`${state.activeImage}|${n.id}`]);
    if (!due) return;
    // The source rides on the node: suffixed ids (inpaint_sel_doc_2)
    // stopped spelling the mask. Legacy nodes still do.
    const maskId = due.textParams?.source ?? due.id.replace(/^inpaint_/, "");
    const hole = state.nodes.find((n) => n.id === due.id.replace(/^inpaint_/, "inpaint_m_"));
    // Two phases. An empty hole pointer means the snapshot has not
    // been baked yet: render the SOURCE mask (smart, drawn, brushed -
    // any of them), persist it, and point the hole's baked base at
    // it. The state change re-fires this effect, and the second pass
    // runs the fill against a graph whose hole is now real. (The
    // pre-bake smart-clone snapshot path is gone; every hole is a
    // baked selection now.)
    if (hole && hole.type === "heeler.selection_mask" && (hole.textParams?.matte_id ?? "") === "") {
      setFilling(true);
      publishBusy("REMOVING \u00b7 snapshotting the selection");
      void bakeMaskRaster(state, maskId)
        .then((version) => {
          dispatch({
            type: "set_text_param",
            id: hole.id,
            param: "matte_id",
            value: `baked:${version}`,
          });
        })
        .catch((err) => reportToolError("Remove", err))
        .finally(() => {
          publishBusy(null);
          setFilling(false);
        });
      return;
    }
    attempted.current[`${state.activeImage}|${due.id}`] = true;
    setFilling(true);
    publishBusy("REMOVING \u00b7 the model is filling the hole");
    void inpaintFill(state, due.id)
      .then((fillId) => {
        setNeedModel(false);
        dispatch({
          type: "set_params",
          id: due.id,
          values: {},
          text: { fill_id: fillId, model: "lama" },
        });
      })
      .catch((err) => {
        if (String(err).includes("model not installed")) {
          setNeedModel(true);
          delete attempted.current[`${state.activeImage}|${due.id}`]; // retry after the download
        } else {
          reportToolError("Remove", err);
        }
      })
      .finally(() => {
        publishBusy(null);
        setFilling(false);
      });
    // The hole pointers ride the key: phase one writes matte_id and
    // the effect must re-fire for phase two, the fill.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    pending
      .map((n) => {
        const h = state.nodes.find(
          (k) => k.id === n.id.replace(/^inpaint_/, "inpaint_m_"),
        );
        return `${n.id}:${h?.textParams?.matte_id ?? ""}`;
      })
      .join("|"),
    artPending
      .map((x) => `${x.blendId}:${x.mask?.textParams?.matte_id ?? ""}`)
      .join("|"),
    filling,
  ]);
  if (pending.length === 0 && artPending.length === 0) return null;
  return (
    <>
      {filling && (
        <div
          data-testid="remove-busy"
          style={{
            position: "absolute", left: 8, bottom: 8, fontSize: 9, letterSpacing: ".1em",
            color: "#c2c7cb", background: "rgba(0,0,0,.5)", padding: "2px 7px",
          }}
        >
          REMOVING…
        </div>
      )}
      {needModel && models && (
        <div
          data-testid="smart-fill-consent"
          style={{
            position: "fixed", left: "50%", bottom: 76, transform: "translateX(-50%)",
            background: "var(--bg-panel)", border: "1px solid var(--line-4)",
            padding: "10px 14px", maxWidth: 360, fontSize: 10, zIndex: 40,
            color: "var(--text-body)", lineHeight: 1.55,
          }}
        >
          <div style={{ fontSize: 11, letterSpacing: ".1em", marginBottom: 4 }}>
            REMOVE NEEDS ITS MODEL
          </div>
          <div style={{ color: "var(--text-faint)" }}>
            {models.fill.label} · {Math.round(models.fill.bytes / 1e6)} MB · {models.fill.license}
          </div>
          <div style={{ color: "var(--text-faint)", overflowWrap: "anywhere", marginTop: 2 }}>
            From {models.fill.url}
          </div>
          <button
            className="chip small"
            data-testid="smart-fill-download"
            disabled={downloading}
            style={{ fontSize: 10, padding: "2px 12px", marginTop: 8 }}
            onClick={() => {
              setDownloading(true);
              void smartModelDownload("lama")
                .then(() => {
                  logMsg("info", "LaMa installed");
                  setNeedModel(false);
                })
                .catch((err) => reportToolError("Download", err))
                .finally(() => setDownloading(false));
            }}
          >
            {downloading ? "DOWNLOADING…" : "DOWNLOAD"}
          </button>
        </div>
      )}
    </>
  );
}

/** The six smart mask buttons' one size: a square around a 14 px
 * picture, the same for the modes and the actions. Words at 11px made
 * the row about 240 px wide and it wrapped at the default panel; as
 * pictures both sets take about 140 px and stay on one line down to
 * the narrowest Develop panel (2026-09-29: "replace all 6 button
 * labels with icons, that should reduce their horizontal width").
 * Inline, so it outranks the .zoom-seg button's `all: unset` and
 * padding.*/
export const SMART_ICON_BUTTON: React.CSSProperties = {
  width: 20,
  height: 20,
  padding: 0,
  boxSizing: "border-box",
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
};

/** The smart layer's PANEL controls: the mode (click / subject /
 * sky), Remove, and (unless the caller seats it elsewhere) Clear.
 * In the panel, not overlaid on the photograph (chips
 * on the image "can be hard to see").*/
export function SmartModePanel({
  state,
  dispatch,
  withClear = true,
  mask: aimed,
}: {
  state: State;
  dispatch: D;
  /** the Layers panel seats CLEAR in its own header row instead */
  withClear?: boolean;
  /** the node this panel works on: a Smart Mask node's Inspector face
   * aims it at that node; absent, the smart mask in hand */
  mask?: NodeCard;
}) {
  const [busy, setBusy] = useState(false);
  const [models, setModels] = useState<SmartModels | null>(null);
  const [matteConsent, setMatteConsent] = useState(false);
  const [matting, setMatting] = useState(false);
  useEffect(() => {
    let live = true;
    void smartModelStatus().then((m) => {
      if (live) setModels(m);
    });
    return () => {
      live = false;
    };
  }, [matteConsent, matting]);
  const mask = aimed ?? activeSmartMask(state);
  if (!mask) return null;
  const mode = mask.textParams?.mode ?? "click";
  const prompts = mask.textParams?.prompts ?? "[]";
  const hasSelection = prompts !== "[]" || (mask.textParams?.model ?? "") !== "";
  const compute = (m: string, pts: string, aim = "") => {
    setBusy(true);
    publishBusy("SELECTING \u00b7 the model is computing the mask");
    void (m === "subject" ? smartClick(state.activeImage, mask.id, pts, m, aim) : smartClick(state.activeImage, mask.id, pts, m))
      .then((used) => {
        dispatch({ type: "set_text_param", id: mask.id, param: "model", value: used });
      })
      .catch((err) => reportToolError("Smart selection", err))
      .finally(() => {
        publishBusy(null);
        setBusy(false);
      });
  };
  return (
    <div data-testid="smart-modes" style={{ display: "flex", alignItems: "center", gap: 4, margin: "2px 0 6px", flexWrap: "wrap" }}>
      {/* Each mode its own one-button group, 4 px apart, the actions'
spacing (2026-09-29: "add the same padding between
click/subject/sky that refine/remove/to-mask have").*/}
      <div role="group" aria-label="Smart selection mode" style={{ display: "flex", alignItems: "center", gap: 4, flex: "none" }}>
        {/* Pictures, not words: the name rides aria-label and the cursor
            tip, and the status line hint leads with it. */}
        {([
          ["click", "Click"],
          ["subject", "Subject"],
          ["sky", "Sky"],
        ] as const).map(([id, label]) => (
          <div key={id} className="zoom-seg" style={{ border: "1px solid var(--line-4)" }}>
          <button
            data-testid={`smart-mode-${id}`}
            data-active={mode === id}
            aria-pressed={mode === id}
            disabled={busy}
            aria-label={label}
            data-tip={label}
            data-hint={
              id === "click"
                ? `Click: select by clicking the photo; a click adds, ${modLabel("alt")}-click subtracts`
                : id === "subject"
                  ? "Subject: selects the main subject in one shot, no clicks needed"
                  : "Sky: selects the sky in one shot"
            }
            style={SMART_ICON_BUTTON}
            onClick={() => {
              dispatch({ type: "set_text_param", id: mask.id, param: "mode", value: id });
              if (id === "subject") {
                // Aimed at the middle of the frame on screen, stored
                // beside the clicks so they survive the switch
                // (smartpoints.ts subjectAim).
                const aim = subjectAim(state);
                dispatch({ type: "set_text_param", id: mask.id, param: "aim", value: aim });
                compute(id, "[]", aim);
              } else if (id !== "click") compute(id, "[]");
            }}
          >
            <SmartIcon id={id} />
          </button>
          </div>
        ))}
      </div>
      {(busy || matting) && (
        <span style={{ fontSize: 9, color: "var(--text-faint)", letterSpacing: ".08em" }}>
          {matting ? "REFINING…" : "COMPUTING…"}
        </span>
      )}
      {/* The actions, at the mode buttons' own size (one square, a picture in
each, since 2026-09-29) and pushed to the right edge with the space
between the two sets (2026-09-29: "The refine/remove/to mask buttons
should be the same size as click/subject/sky. Right align them to the
view so there is space between the two sets of buttons."). Each is a
one-button group of the same class, so its height, lettering and
padding cannot drift from Click's; when the row is too narrow the set
wraps whole to its own right-aligned line rather than shrinking.*/}
      <div
        data-testid="smart-actions"
        style={{ display: "flex", alignItems: "center", gap: 4, marginLeft: "auto", flex: "none" }}
      >
        {/* REFINE (named by "is 'Matte' the right word? Aren't we
trying to Refine or Polish here?"): ViTMatte re-reads the
selection's edge, the same pass Selection Polish runs. A later
click or mode change recomputes from the base model and the
refinement falls away, ready to run again.*/}
        <div className="zoom-seg act" style={{ border: "1px solid var(--line-4)" }}>
          <button
            data-testid="smart-matte"
            data-active={(mask.textParams?.model ?? "").endsWith("+vitmatte")}
            aria-pressed={(mask.textParams?.model ?? "").endsWith("+vitmatte")}
            disabled={busy || matting || !hasSelection}
            aria-label="Refine"
            data-tip="Refine"
            data-hint={
              (mask.textParams?.model ?? "").endsWith("+vitmatte")
                ? "Refine: sharpens the selection's edge again"
                : "Refine: sharpens the selection's edge with the matting model: hair, fur, ridgelines"
            }
            style={SMART_ICON_BUTTON}
            onClick={() => {
              const refine = models?.refine ?? null;
              if (refine && !refine.installed) {
                setMatteConsent(true);
                return;
              }
              setMatting(true);
              publishBusy("REFINING \u00b7 the matting model is at the edge");
              void (mode === "subject"
                ? smartMatte(state.activeImage, mask.id, mode, prompts, mask.textParams?.model ?? "", mask.textParams?.aim ?? "")
                : smartMatte(state.activeImage, mask.id, mode, prompts, mask.textParams?.model ?? ""))
                .then((used) => {
                  dispatch({ type: "set_text_param", id: mask.id, param: "model", value: used });
                })
                .catch((err) => reportToolError("Refine", err))
                .finally(() => {
                  publishBusy(null);
                  setMatting(false);
                });
            }}
          >
            <SmartIcon id="refine" />
          </button>
        </div>
        {/* Remove, back by the owner's ruling once it finally explained itself:
"If I had better understood that from the beginning I would have
said to leave that Remove button... what was hard was the way these
buttons were ordered and the status line help text is not clear."
The order is the workflow - select, refine, then what the selection
becomes - and every hint leads with the outcome. The Select menu
door stays too.*/}
        <div className="zoom-seg act" style={{ border: "1px solid var(--line-4)" }}>
          <button
            data-testid="smart-remove"
            disabled={busy || matting || !hasSelection || removalPending(state, mask.id)}
            aria-label="Remove"
            data-tip="Remove"
            data-hint={
              removalPending(state, mask.id)
                ? "Remove: a removal from this selection is still computing"
                : "Remove: erases what is selected from the photograph; the model fills the hole from the surroundings"
            }
            style={SMART_ICON_BUTTON}
            onClick={() =>
              dispatch(
                state.panelTab === "layers"
                  ? { type: "art_remove_from_selection", maskId: mask.id }
                  : { type: "add_inpaint_for", maskId: mask.id },
              )
            }
          >
            <SmartIcon id="remove" />
          </button>
        </div>
        {/* The exit ramp ("I think the best thing to do is turn the
smart selection into a mask, but I don't see that option"): bake the
computed selection into an ordinary pixel mask, the kind Add layer
mask makes (2026-09-30: "drop the live mask, make To Mask a pixel
mask"). No model runs; the raster the smart tools computed becomes
the mask's pixels and the brush paints from there. One-way by design
- undo is the way back.*/}
        <div className="zoom-seg act" style={{ border: "1px solid var(--line-4)" }}>
          <button
            data-testid="smart-to-mask"
            disabled={busy || matting || !hasSelection}
            aria-label="To Mask"
            data-tip="To Mask"
            data-hint="To Mask: turns this selection into an ordinary black and white mask you paint by hand"
            style={SMART_ICON_BUTTON}
            onClick={() => {
              setBusy(true);
              publishBusy("TO MASK \u00b7 baking the selection");
              void bakeMaskRaster(state, mask.id)
                .then((version) =>
                  dispatch({ type: "convert_mask_to_pixels", maskId: mask.id, version }),
                )
                .catch((err) => reportToolError("To Mask", err))
                .finally(() => {
                  publishBusy(null);
                  setBusy(false);
                });
            }}
          >
            <SmartIcon id="toMask" />
          </button>
        </div>
        {withClear && <SmartClearButton state={state} dispatch={dispatch} inRow mask={mask} />}
      </div>
      {/* No removed-freeze any more, and no note explaining one. The Remove
owns a SNAPSHOT of the selection (see add_inpaint_for), so nothing
about a past removal has any claim on the live selection. On the
freeze: "I click to select, I should be able to clear that. I should
be able to refine it." Yes.*/}
      {/* The matte model's consent line, same contract as the fill's. */}
      {matteConsent && models?.refine && !models.refine.installed && (
        <div
          data-testid="smart-matte-consent"
          style={{ flexBasis: "100%", fontSize: 9, color: "var(--text-faint)", lineHeight: 1.5 }}
        >
          The matte needs {models.refine.label} · {Math.round(models.refine.bytes / 1e6)} MB ·{" "}
          {models.refine.license}
          <div style={{ overflowWrap: "anywhere" }}>From {models.refine.url}</div>
          <button
            className="chip small"
            data-testid="smart-matte-download"
            disabled={busy || matting}
            style={{ marginTop: 2 }}
            onClick={() => {
              setMatting(true);
              void smartModelDownload("vitmatte")
                .then(() => {
                  logMsg("info", "ViTMatte installed");
                  setMatteConsent(false);
                })
                .catch((err) => reportToolError("Download", err))
                .finally(() => setMatting(false));
            }}
          >
            DOWNLOAD
          </button>
        </div>
      )}
    </div>
  );
}

/** The smart mask in hand: the active Develop layer's, the active
 * Finish layer's (art masks hang off the group boundary as
 * art_m_<id> nodes), or a directly selected one - so the panel and
 * the click tool follow the user across every surface. */
export function activeSmartMask(s: State) {
  // One resolver in state.ts, which the marching ants and Polish read
  // too (antsSources).
  return smartMaskInHand(s);
}

export function SmartClickOverlay({
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
  const [status, setStatus] = useState<SmartModels | null | "loading">("loading");
  const [downloading, setDownloading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [cached, setCached] = useState(true);
  useEffect(() => {
    let live = true;
    void smartModelStatus().then((s) => {
      if (live) setStatus(s);
    });
    return () => {
      live = false;
    };
  }, [downloading]);

  const mask = activeSmartMask(state);
  const maskId = mask?.id ?? "";
  const prompts = mask?.textParams?.prompts ?? "[]";
  const mode = mask?.textParams?.mode ?? "click";
  // Subject's aim is part of its recipe (lib.rs smart_recipe_prompts).
  const aim = mode === "subject" ? (mask?.textParams?.aim ?? "") : "";
  // The badge's question: is the raster for exactly this recipe here? A
  // graph from another machine carries clicks but no pixels, and the
  // answer must be visible, never silent.
  useEffect(() => {
    if (!maskId || (mode === "click" && prompts === "[]")) {
      setCached(true);
      return;
    }
    let live = true;
    void smartRasterStatus(
      state.activeImage,
      maskId,
      mode,
      prompts,
      mask?.textParams?.model ?? "",
      aim,
    ).then((ok) => {
      if (live) setCached(ok);
    });
    return () => {
      live = false;
    };
  }, [state.activeImage, maskId, mode, prompts, aim, busy]);
  if (!mask) return null;

  const models = status !== "loading" ? status : null;
  const needsModel = models !== null && !models.sam.installed;
  // The matte upgrade offer: subject mode works via SAM regardless,
  // but BiRefNet's soft edges are the real thing.
  const offerMatte = models !== null && models.sam.installed && !models.matte.installed;

  return (
    <div
      data-testid="smart-overlay"
      style={{ position: "absolute", inset: 0, cursor: busy ? "progress" : "crosshair" }}
      onMouseDown={(e) => {
        if (!isPrimaryPress(e) || needsModel || busy || mode !== "click") return;
        e.stopPropagation();
        const [nx, ny] = norm(e, e.currentTarget);
        if (nx < 0 || nx > 1 || ny < 0 || ny > 1) return;
        // Stored on the photograph, where the model reads it (smartpoints.ts).
        const at = smartPromptAt(state, [nx, ny]);
        if (!at) return;
        const prompts: { x: number; y: number; positive: boolean }[] = (() => {
          try {
            const cur: unknown = JSON.parse(mask.textParams?.prompts ?? "[]");
            return Array.isArray(cur) ? (cur as never[]) : [];
          } catch {
            return [];
          }
        })();
        prompts.push({ x: at[0], y: at[1], positive: !e.altKey });
        const json = JSON.stringify(prompts);
        // The recipe first (undoable, portable), then the compute;
        // the model write on completion triggers the showing render.
        dispatch({ type: "set_text_param", id: mask.id, param: "prompts", value: json });
        setBusy(true);
        publishBusy("SELECTING \u00b7 the model is computing the mask");
        void smartClick(state.activeImage, mask.id, json)
          .then((used) => {
            dispatch({ type: "set_text_param", id: mask.id, param: "model", value: used });
          })
          .catch((err) => reportToolError("Smart selection", err))
          .finally(() => {
            publishBusy(null);
            setBusy(false);
          });
      }}
    >
      {/* The matte upgrade offer, only when subject is the mode and
          only the soft-matte model is missing: consent in place, with
          the name, size, license and source right here. */}
      {mode === "subject" && offerMatte && models !== null && (
        <div
          data-testid="smart-matte-offer"
          style={{
            position: "absolute", left: 8, top: 34, maxWidth: 340,
            background: "rgba(0,0,0,.6)", padding: "5px 8px",
            fontSize: 9, color: "#c2c7cb", lineHeight: 1.5,
          }}
          onMouseDown={(e) => e.stopPropagation()}
        >
          Better mattes: {models.matte.label} · {Math.round(models.matte.bytes / 1e6)} MB ·{" "}
          {models.matte.license}
          <div style={{ overflowWrap: "anywhere", color: "var(--text-faint)" }}>
            From {models.matte.url}
          </div>
          <button
            className="chip small"
            data-testid="smart-matte-download"
            disabled={downloading}
            style={{ marginTop: 3 }}
            onClick={() => {
              setDownloading(true);
              void smartModelDownload("birefnet_lite")
                .then(() => logMsg("info", "BiRefNet Lite installed"))
                .catch((err) => reportToolError("Download", err))
                .finally(() => setDownloading(false));
            }}
          >
            {downloading ? "DOWNLOADING…" : "DOWNLOAD"}
          </button>
        </div>
      )}
      {/* Click markers: where the mask has been told, and told not.
          Only the click mode has any, and the Select menu can put
          them away (Show Smart Clicks). */}
      {mode === "click" && state.selectShowClicks && (() => {
        try {
          const pts = parseSmartPoints(mask.textParams?.prompts);
          const on = smartMarkersOn(state, pts);
          return pts.map((p, i) => on[i] && (
            <div
              key={i}
              data-testid={`smart-point-${i}`}
              style={{
                position: "absolute",
                left: `${on[i]![0] * 100}%`,
                top: `${on[i]![1] * 100}%`,
                width: 11,
                height: 11,
                marginLeft: -5.5,
                marginTop: -5.5,
                borderRadius: "50%",
                border: `2px solid ${p.positive ? "#7ec25b" : "#c25b5b"}`,
                background: "rgba(0,0,0,.45)",
                pointerEvents: "none",
              }}
            />
          ));
        } catch {
          return null;
        }
      })()}
      {/* The consent card, when the tool is armed but the model is not
          here: name, license, size, source, and an explicit button. */}
      {needsModel && models !== null && (
        <ModelConsentCard
          title="SMART SELECTION NEEDS ITS MODEL"
          model={models.sam}
          testid="smart"
          downloading={downloading}
          place={{ position: "absolute", left: "50%", top: "50%", transform: "translate(-50%,-50%)" }}
          onDownload={() => {
            setDownloading(true);
            void smartModelDownload()
              .then(() => logMsg("info", "Smart selection model installed"))
              .catch((err) => reportToolError("Download", err))
              .finally(() => setDownloading(false));
          }}
          secondary={{
            label: "NOT NOW",
            testid: "smart-not-now",
            onClick: () => dispatch({ type: "set_tool", tool: "none" }),
          }}
        />
      )}
      {/* The uncomputed badge: clicks exist, pixels do not (a graph
          from another machine, or a cleared cache). One button
          recomputes from the recipe. */}
      {!cached && !busy && !needsModel && (
        <div
          data-testid="smart-uncomputed"
          style={{
            position: "absolute", left: 8, bottom: 8, display: "flex", gap: 6, alignItems: "center",
            fontSize: 9, letterSpacing: ".1em", color: "#c2c7cb",
            background: "rgba(0,0,0,.55)", padding: "3px 7px",
          }}
        >
          MASK NOT COMPUTED ON THIS MACHINE
          <button
            className="chip small"
            data-testid="smart-recompute"
            onMouseDown={(e) => e.stopPropagation()}
            onClick={() => {
              setBusy(true);
              publishBusy("SELECTING \u00b7 the model is computing the mask");
              void (mode === "subject" ? smartClick(state.activeImage, mask.id, prompts, mode, aim) : smartClick(state.activeImage, mask.id, prompts, mode))
                .then((used) => {
                  dispatch({ type: "set_text_param", id: mask.id, param: "model", value: used });
                })
                .catch((err) => reportToolError("Smart selection", err))
                .finally(() => {
                  publishBusy(null);
                  setBusy(false);
                });
            }}
          >
            RECOMPUTE
          </button>
        </div>
      )}
      {busy && (
        <div
          data-testid="smart-busy"
          style={{
            position: "absolute", left: 8, bottom: 8, fontSize: 9, letterSpacing: ".1em",
            color: "#c2c7cb", background: "rgba(0,0,0,.5)", padding: "2px 7px",
          }}
        >
          COMPUTING…
        </div>
      )}
    </div>
  );
}

/** The smart models pointed at the DOCUMENT SELECTION: Select >
 * Selection Tools > Click / Subject / Sky. "These
 * don't create layers or anything, they just create selections
 * only."
 *
 * Same models, different landing: the computed raster becomes the
 * selection's baked base (matte_id "baked:<hex>"), so the ants trace
 * it, every drawn region composes on top, and the graph gains nothing
 * but the selection it already had. Mounted while the select tool is
 * armed with the Smart click method; a subject or sky pick from the
 * menu sets the mode on the node and the one-shot runs from here, so
 * the consent card, the busy chip and the compute all live in one
 * seat whichever door was used. */
export function SmartSelectOverlay({
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
  const [status, setStatus] = useState<SmartModels | null | "loading">("loading");
  const [downloading, setDownloading] = useState(false);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let live = true;
    void smartModelStatus().then((s) => {
      if (live) setStatus(s);
    });
    return () => {
      live = false;
    };
  }, [downloading]);

  const sel = activeSelectionMask(state);
  const selId = sel?.id ?? "";
  // "" after a Deselect and absent on a fresh node both mean click.
  const mode = sel?.textParams?.mode || "click";
  const prompts = sel?.textParams?.prompts || "[]";
  const matte = sel?.textParams?.matte_id ?? "";
  // The menu's ask counter. Without it, re-picking
  // Subject after a compute had landed was indistinguishable from the
  // render after a FAILED one: same mode, same unbaked base, same
  // recipe, so the latch below swallowed the re-pick - and the menu
  // had already cleared the baked base, so the pick destroyed the
  // smart selection instead of recomputing it. The counter lives in
  // UI state rather than on the node: undo can rewind the bake but
  // never the ask, so no depth of undo re-fires a compute.
  const want = state.smartAsk;
  const models = status !== "loading" ? status : null;
  const needsModel = models !== null && !models.sam.installed;

  const compute = (m: string, pts: string) => {
    setBusy(true);
    publishBusy("SELECTING · the model is computing the selection");
    // Subject asks the SAM fallback at the middle of the frame on
    // screen (smartpoints.ts subjectAim); the baked base is keyed by
    // the answer, so the aim needs no seat on the selection.
    void (m === "subject" ? smartSelect(state.activeImage, selId, m, pts, subjectAim(state)) : smartSelect(state.activeImage, selId, m, pts))
      .then((hex) => {
        dispatch({ type: "set_text_param", id: selId, param: "matte_id", value: `baked:${hex}` });
      })
      .catch((err) => reportToolError("Smart selection", err))
      .finally(() => {
        publishBusy(null);
        setBusy(false);
      });
  };

  // The one-shots. The menu writes the mode, clears the base and
  // stamps the ask; an unbaked subject or sky mode with a fresh stamp
  // is a compute that has not happened yet. The latch keeps a failed
  // compute from retrying every render, and the stamp is what lets a
  // deliberate re-pick through it.
  const attempted = useRef("");
  const recipe = `${state.activeImage}|${selId}|${mode}|${want}`;
  useEffect(() => {
    // Gated on a KNOWN missing model, never on the status being in
    // hand: the browser mock's status is null forever, and waiting on
    // it left subject and sky computing nothing at all there. A
    // compute racing a missing model just errors, and the consent
    // card lands when the status does.
    if (!selId || busy || needsModel || status === "loading") return;
    if (mode !== "subject" && mode !== "sky") return;
    if (matte.startsWith("baked:")) return;
    if (attempted.current === recipe) return;
    attempted.current = recipe;
    compute(mode, "[]");
    // compute closes over the freshest props already.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [recipe, mode, matte, busy, needsModel, status === "loading"]);

  if (!sel) return null;

  return (
    <div
      data-testid="smart-select-overlay"
      style={{ position: "absolute", inset: 0, cursor: busy ? "progress" : "crosshair" }}
      onMouseDown={(e) => {
        if (!isPrimaryPress(e) || needsModel || busy || mode !== "click") return;
        e.stopPropagation();
        const [nx, ny] = norm(e, e.currentTarget as HTMLElement);
        if (nx < 0 || nx > 1 || ny < 0 || ny > 1) return;
        // Stored on the photograph, where the model reads it (smartpoints.ts).
        const at = smartPromptAt(state, [nx, ny]);
        if (!at) return;
        const pts: { x: number; y: number; positive: boolean }[] = (() => {
          try {
            const cur: unknown = JSON.parse(prompts);
            return Array.isArray(cur) ? (cur as never[]) : [];
          } catch {
            return [];
          }
        })();
        pts.push({ x: at[0], y: at[1], positive: !e.altKey });
        const json = JSON.stringify(pts);
        // The recipe first (undoable, portable), then the compute; the
        // baked pointer landing is what shows the new selection.
        dispatch({ type: "set_text_param", id: selId, param: "mode", value: "click" });
        dispatch({ type: "set_text_param", id: selId, param: "prompts", value: json });
        compute("click", json);
      }}
    >
      {/* Click markers: where the selection has been told, and told
          not. Only the click mode has any, and the Select menu can
          put them away (Show Smart Clicks). */}
      {mode === "click" && state.selectShowClicks && (() => {
        try {
          const pts = parseSmartPoints(prompts);
          const on = smartMarkersOn(state, pts);
          return pts.map((p, i) => on[i] && (
            <div
              key={i}
              data-testid={`smart-select-point-${i}`}
              style={{
                position: "absolute",
                left: `${on[i]![0] * 100}%`,
                top: `${on[i]![1] * 100}%`,
                width: 11,
                height: 11,
                marginLeft: -5.5,
                marginTop: -5.5,
                borderRadius: "50%",
                border: `2px solid ${p.positive ? "#7ec25b" : "#c25b5b"}`,
                background: "rgba(0,0,0,.45)",
                pointerEvents: "none",
              }}
            />
          ));
        } catch {
          return null;
        }
      })()}
      {/* The same consent card the smart layers show: nothing
          downloads until the button is pressed. */}
      {needsModel && models !== null && (
        <ModelConsentCard
          title="SMART SELECTION NEEDS ITS MODEL"
          model={models.sam}
          testid="smart"
          downloading={downloading}
          place={{ position: "absolute", left: "50%", top: "50%", transform: "translate(-50%,-50%)" }}
          onDownload={() => {
            setDownloading(true);
            void smartModelDownload()
              .then(() => logMsg("info", "Smart selection model installed"))
              .catch((err) => reportToolError("Download", err))
              .finally(() => setDownloading(false));
          }}
          secondary={{
            label: "NOT NOW",
            testid: "smart-not-now",
            onClick: () => dispatch({ type: "set_tool", tool: "none" }),
          }}
        />
      )}
      {busy && (
        <div
          data-testid="smart-select-busy"
          style={{
            position: "absolute", left: 8, bottom: 8, fontSize: 9, letterSpacing: ".1em",
            color: "#c2c7cb", background: "rgba(0,0,0,.5)", padding: "2px 7px",
          }}
        >
          COMPUTING…
        </div>
      )}
    </div>
  );
}
