// The Finish fill brush, living as its OWN LAYER ("do
// Fill brushes make their own layer?"). The layer's content is the
// model's fill of the picture below (hole:"layer"), its mask holds
// the strokes and gates the blend, so hide / reorder / opacity /
// delete all behave like any layer and deleting the layer takes the
// fill with it. Arming the tool creates a Fill layer when the active
// layer is not one; each finished stroke re-runs the fill for its
// layer.

import React, { useEffect, useRef, useState } from "react";
import { inpaintFill, smartModelDownload, smartModelStatus, type SmartModels } from "../bridge";
import { logMsg } from "../log";
import { reportToolError } from "./hints";
import { ModelConsentCard } from "./modelconsent";
import { MODEL_FILL_GLYPH } from "./panelicons";
import { artLayers, artMaskNode, type Command, type State } from "../state";
import { publishBusy } from "./statusbar";

type D = React.Dispatch<Command>;

/** Every Fill layer in the stack: blend id, content (inpaint) id, and
 * the stroke mask's id. */
export function fillLayers(s: State): { blendId: string; contentId: string; maskId: string }[] {
  return artLayers(s)
    .filter((l) => l.content.type === "heeler.inpaint")
    .map((l) => ({ blendId: l.blend.id, contentId: l.content.id, maskId: `art_m_${l.blend.id}` }));
}

/** The active Fill layer, when the active Finish layer is one. */
export function activeFillLayer(s: State) {
  return fillLayers(s).find((l) => l.blendId === s.artActive);
}

export function FillToolButton({ state, dispatch }: { state: State; dispatch: D }) {
  const armed = state.tool === "fill";
  return (
    <button
      className="chip"
      data-testid="art-tool-fill"
      data-active={armed}
      aria-label="Fill"
      data-tip="Fill brush"
      data-hint="Paint over a problem and the model fills it from the surroundings; the fill lives on its own layer"
      style={{ padding: "3px 6px", display: "inline-flex" }}
      onClick={() => {
        if (armed) {
          dispatch({ type: "set_tool", tool: "none" });
          return;
        }
        if (activeFillLayer(state)) {
          dispatch({ type: "set_tool", tool: "fill" });
          return;
        }
        // No fill layer in hand: the brush makes its own (and arms).
        dispatch({ type: "art_add_fill_layer" });
      }}
    >
      {/* A patch being smoothed over: the hole and the strokes closing it. */}
      <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" aria-hidden="true">
        {MODEL_FILL_GLYPH}
      </svg>
    </button>
  );
}

/** Keeps every Fill layer's fill current: a beat after a finished
 * stroke on a layer's stroke mask, the model re-fills that layer.
 * Renders the busy line and, when the model is missing, the consent
 * card - name, size, license, source, nothing fetched silently. */
export function FillRunner({ state, dispatch }: { state: State; dispatch: D }) {
  const layers = fillLayers(state);
  const strokesOf = (maskId: string) =>
    JSON.stringify(artMaskNode(state, maskId)?.strokes ?? []);
  // One watermark per layer, so two Fill layers refill independently.
  const lastRun = useRef<Record<string, string>>({});
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
  const pendingKey = layers
    .map((l) => `${l.blendId}:${strokesOf(l.maskId)}`)
    .join("|");
  useEffect(() => {
    if (state.gesture !== null || filling) return;
    const due = layers.find((l) => {
      const strokes = strokesOf(l.maskId);
      return strokes !== "[]" && strokes !== lastRun.current[l.blendId];
    });
    if (!due) return;
    const strokes = strokesOf(due.maskId);
    const timer = window.setTimeout(() => {
      lastRun.current[due.blendId] = strokes;
      setFilling(true);
      publishBusy("FILLING \u00b7 the model is filling the strokes");
      void inpaintFill(state, due.contentId, due.maskId)
        .then((fillId) => {
          setNeedModel(false);
          dispatch({
            type: "art_content_set",
            id: due.blendId,
            param: "fill_id",
            value: fillId,
          });
          dispatch({
            type: "art_content_set",
            id: due.blendId,
            param: "model",
            value: "lama",
          });
        })
        .catch((err) => {
          if (String(err).includes("model not installed")) {
            setNeedModel(true);
            delete lastRun.current[due.blendId]; // retry after the download
          } else {
            reportToolError("Fill", err);
          }
        })
        .finally(() => {
          publishBusy(null);
          setFilling(false);
        });
    }, 450);
    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingKey, state.gesture, filling]);
  if (layers.length === 0) return null;
  return (
    <>
      {filling && (
        <div
          data-testid="fill-busy"
          style={{
            position: "absolute", left: 8, bottom: 8, fontSize: 9, letterSpacing: ".1em",
            color: "#c2c7cb", background: "rgba(0,0,0,.5)", padding: "2px 7px",
          }}
        >
          FILLING…
        </div>
      )}
      {needModel && models && (
        <ModelConsentCard
          title="THE FILL NEEDS ITS MODEL"
          model={models.fill}
          testid="fill"
          downloading={downloading}
          place={{ position: "absolute", left: "50%", bottom: 16, transform: "translateX(-50%)" }}
          onDownload={() => {
            setDownloading(true);
            void smartModelDownload("lama")
              .then(() => {
                logMsg("info", "LaMa installed");
                setNeedModel(false);
              })
              .catch((err) => reportToolError("Download", err))
              .finally(() => setDownloading(false));
          }}
        />
      )}
    </>
  );
}
