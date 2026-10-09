// The Smart Mask node's face in the Graph Inspector, and its card's
// words. 2026-10-01: "Is smart mask working correctly? I don't see it
// generating a mask. Also, I don't see an invert option."
//
// A Smart Mask added in the Graph wore the generic face: a Mode menu,
// Threshold and Feather. Choosing Subject or Sky there only wrote the
// mode; nothing ever ran the model, so the render found no raster for
// the recipe and planted nothing, and the mask stayed black. Invert,
// Expand and the Depth block had no seat at all. The face now wears
// what Develop's Smart layer wears, aimed at this node: the mode
// buttons (Subject and Sky run the model on the press, as in Develop),
// a state line with Detect for a one-shot that has no pixels yet, the
// viewer pick for Click, the dials, Invert, and the Depth mask block.

import React, { useEffect, useRef, useState } from "react";
import { smartClick, smartModelStatus, smartRasterStatus, type SmartModels } from "../bridge";
import { modLabel } from "../platform";
import type { Command, NodeCard, State } from "../state";
import { parseSmartPoints, subjectAim } from "../smartpoints";
import { reportToolError } from "./hints";
import { DepthMaskBlock, MASK_ROWS, MaskInvertRow, Slider } from "./simple";
import { SmartModePanel, activeSmartMask } from "./smarttool";
import { publishBusy } from "./statusbar";

type D = React.Dispatch<Command>;

/** The smart models' standing for a face or a card: asked when `ask`
 * turns true and again whenever `refresh` changes (the graph passes
 * Preferences' open flag, so an install there is seen on the way back).
 * Null until the answer lands, and in the browser mock. */
export function useSmartModels(ask: boolean, refresh: unknown = 0): SmartModels | null {
  const [models, setModels] = useState<SmartModels | null>(null);
  useEffect(() => {
    if (!ask) return;
    let live = true;
    void smartModelStatus()
      .then((m) => {
        if (live) setModels(m);
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [ask, refresh]);
  return models;
}

/** Whether the model a Smart mask's mode needs is missing here: SAM for
 * every mode, except Subject, which BiRefNet answers when it is
 * installed (lib.rs smart_compute). Not known yet is not missing. */
export function smartModelMissing(models: SmartModels | null, mode: string): boolean {
  if (!models?.sam) return false;
  if (mode === "subject" && models.matte?.installed) return false;
  return !models.sam.installed;
}

/** The words a Smart Mask card wears under its picture when the mask is
 * empty for a reason the black picture cannot tell (the badge the spec
 * promises): the model is missing, or nothing has been asked of it yet.
 * Empty when there is nothing to say. */
export function smartCardNote(n: NodeCard, models: SmartModels | null): string {
  if (n.type !== "heeler.smart_mask" || !n.enabled) return "";
  const mode = n.textParams?.mode || "click";
  if (smartModelMissing(models, mode)) return "Model not installed: mask empty";
  if ((n.textParams?.model ?? "") !== "") return "";
  if (mode === "subject" || mode === "sky") return "Not detected yet: Detect in the Inspector";
  if ((n.textParams?.prompts || "[]") === "[]") return "No clicks yet: mask empty";
  return "";
}

const ONE_SHOT: Record<string, string> = { subject: "the subject", sky: "the sky" };

/** A Smart Mask node's state line and its one action: Detect for Subject
 * and Sky (for a graph that arrived with the mode set and no pixels: an
 * assistant's, another machine's, or one made with the old Mode menu),
 * the viewer pick for Click, aimed at this node, and plain words with
 * the way to Preferences > Models when the model is missing. */
export function SmartNodeStatus({
  node,
  state,
  dispatch,
  canPick,
}: {
  node: NodeCard;
  state: State;
  dispatch: D;
  /** a viewer is at hand to click: not in the popped-out graph window */
  canPick: boolean;
}) {
  const models = useSmartModels(true, state.prefsOpen);
  const [busy, setBusy] = useState(false);
  const [cached, setCached] = useState<boolean | null>(null);
  const mode = node.textParams?.mode || "click";
  const prompts = node.textParams?.prompts || "[]";
  const model = node.textParams?.model ?? "";
  const aim = mode === "subject" ? (node.textParams?.aim ?? "") : "";
  const asked = mode !== "click" || prompts !== "[]";
  const generation = useRef(0);
  const detecting = useRef(false);
  useEffect(() => {
    setBusy(false);
    setCached(null);
    return () => {
      generation.current++;
      if (detecting.current) publishBusy(null);
      detecting.current = false;
    };
  }, [state.activeImage, node.id, mode, prompts]);
  // Is the raster for exactly this recipe here? The question the
  // viewer's badge asks (smart_raster_status).
  useEffect(() => {
    if (!asked) {
      setCached(null);
      return;
    }
    let live = true;
    void smartRasterStatus(state.activeImage, node.id, mode, prompts, model, aim)
      .then((ok) => {
        if (live) setCached(ok);
      })
      .catch(() => {
        if (live) setCached(false);
      });
    return () => {
      live = false;
    };
  }, [state.activeImage, node.id, mode, prompts, model, aim, asked, busy]);
  const missing = smartModelMissing(models, mode);
  const detect = () => {
    const request = generation.current;
    detecting.current = true;
    setBusy(true);
    publishBusy("DETECTING · the model is computing the mask");
    // Subject asks the middle of the frame on screen when no aim is
    // stored yet, as the panel's Subject button does.
    const at = mode === "subject" ? aim || subjectAim(state) : "";
    if (mode === "subject" && !aim) dispatch({ type: "set_text_param", id: node.id, param: "aim", value: at });
    void (mode === "subject"
      ? smartClick(state.activeImage, node.id, prompts, mode, at)
      : smartClick(state.activeImage, node.id, prompts, mode))
      .then((used) => {
        if (generation.current === request) dispatch({ type: "set_text_param", id: node.id, param: "model", value: used });
      })
      .catch((err) => {
        if (generation.current === request) reportToolError("Smart selection", err);
      })
      .finally(() => {
        if (generation.current !== request) return;
        detecting.current = false;
        publishBusy(null);
        setBusy(false);
      });
  };
  const armed = state.tool === "smart" && activeSmartMask(state)?.id === node.id;
  const line: React.CSSProperties = { fontSize: 11, color: "var(--text-faint)", lineHeight: 1.45, flex: 1, minWidth: 0 };
  const row: React.CSSProperties = { display: "flex", alignItems: "center", gap: 8, margin: "2px 0 8px" };
  const chip: React.CSSProperties = { fontSize: 11, padding: "1px 8px", flex: "none" };
  if (missing) {
    return (
      <div data-testid="smart-node-missing" style={row}>
        <span style={line}>Empty until the Smart selection model is installed, in Preferences &gt; Models.</span>
        <button
          type="button"
          className="chip"
          style={chip}
          data-testid="smart-node-get-model"
          data-hint="Opens Preferences at Models, where the Smart selection model installs"
          onClick={() => dispatch({ type: "open_prefs", landing: "model-inventory" })}
        >
          Get the model
        </button>
      </div>
    );
  }
  if (busy) {
    return (
      <div data-testid="smart-node-busy" style={row}>
        <span style={line}>Detecting...</span>
      </div>
    );
  }
  if (mode === "subject" || mode === "sky") {
    const what = ONE_SHOT[mode];
    const done = cached === true;
    return (
      <div data-testid="smart-node-status" data-state={done ? "detected" : "not-detected"} style={row}>
        <span style={line}>
          {done ? `Detected: this mask is ${what}.` : `Not detected yet: the mask stays empty until Detect finds ${what}.`}
        </span>
        <button
          type="button"
          className="chip"
          style={chip}
          data-testid="smart-node-detect"
          data-hint={`Detect: the model finds ${what} in this photograph and makes it this mask`}
          onClick={detect}
        >
          {done ? "Detect again" : "Detect"}
        </button>
      </div>
    );
  }
  // Click: clicks saved with no pixels here (another machine, a cleared
  // cache) recompute from the clicks; otherwise the pick.
  const clicks = parseSmartPoints(prompts).length;
  const stale = clicks > 0 && cached === false;
  return (
    <div data-testid="smart-node-status" data-state={stale ? "not-computed" : clicks === 0 ? "no-clicks" : "clicked"} style={row}>
      <span style={line}>
        {stale
          ? "Clicks saved, mask not computed on this machine."
          : clicks === 0
            ? `Empty until you click the photograph: a click adds, ${modLabel("alt")}-click takes away.`
            : `Selected by ${clicks} click${clicks === 1 ? "" : "s"}.`}
      </span>
      {stale && (
        <button
          type="button"
          className="chip"
          style={chip}
          data-testid="smart-node-detect"
          data-hint="Recompute: the model makes this mask again from the saved clicks"
          onClick={detect}
        >
          Recompute
        </button>
      )}
      {canPick && (
        <button
          type="button"
          className="chip"
          style={chip}
          data-testid="smart-node-pick"
          data-active={armed}
          aria-pressed={armed}
          data-hint={
            armed
              ? "Clicks on the photograph go to this mask now; press again to put the click tool down"
              : `Click to select: clicks on the photograph go to this mask, ${modLabel("alt")}-click takes away`
          }
          onClick={() => {
            if (!armed) dispatch({ type: "select_nodes", ids: [node.id] });
            dispatch({ type: "set_tool", tool: "smart" });
          }}
        >
          Click to select
        </button>
      )}
    </div>
  );
}

/** Every control a Smart Mask node offers, in workflow order: what to
 * select (the mode buttons, Develop's own, aimed at this node) and its
 * state, then the dials that shape it, Invert, and the Depth mask. The
 * same components Develop's Smart layer mounts (features reach their
 * nodes). Without a state (a test with none) the mode and depth rows,
 * which need the photograph, stand down. */
export function SmartMaskFace({
  node,
  state,
  dispatch,
  canPick,
  width,
}: {
  node: NodeCard;
  state?: State;
  dispatch: D;
  canPick: boolean;
  width?: number;
}) {
  return (
    <div data-testid="smart-node-face">
      {state && (
        <div data-node={node.id} data-param="mode">
          <SmartModePanel state={state} dispatch={dispatch} mask={node} />
        </div>
      )}
      {state && <SmartNodeStatus node={node} state={state} dispatch={dispatch} canPick={canPick} />}
      {MASK_ROWS.smart.map((r) => (
        <Slider key={r.param} label={r.label} param={r.param} node={node} dispatch={dispatch} centered={r.centered !== false} />
      ))}
      <MaskInvertRow node={node} dispatch={dispatch} testid="smart-node-invert" />
      {state && (
        <DepthMaskBlock maskNode={node} state={state} dispatch={dispatch} testid="smart-node-depth" width={width} showView={canPick} />
      )}
    </div>
  );
}
