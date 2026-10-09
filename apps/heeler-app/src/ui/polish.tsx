// Polishing a selection.
//
// "In other apps this was a window that opened up and showed
// the selected areas as red overlay. This helped clean up the rough
// edges with marquee selections... I wonder tho, instead of having a pop
// up if we can use the current viewport, temp hide Adjustments panel,
// bring up a Polish selection panel so its not like you have to leave
// the main window."
//
// In the viewport, and it is the right call. Polishing means zooming past
// 100% and panning around an edge, and all of that already exists here:
// the zoom tiers, the proxy cache, the view rotation, the pointer
// mapping that survives a rotated canvas. A pop-out would have to
// reimplement every bit of it to end up somewhere worse, and it would
// take the photograph out of the room while you judge an edge against it.

import { isPrimaryPress, primaryHeld } from "./pointerguard";
import React, { memo, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { panePropsEqual } from "./viewmemo";
import { REFINE_EDGE_GLYPH } from "./panelicons";
import type { Command, State } from "../state";
import { usePickSessions } from "../picksession";
import { DOC_SEL_ID, POLISH_VIEWS, activeSelectionMask, artMaskNode } from "../state";
import { TrackSlider, ValueField } from "./track";
import {
  bakeLayerMask,
  cancelPolishMatteFull,
  hasMatteStrokes,
  matteRecipeOf,
  polishMatte,
  polishMatteFull,
  smartModelDownload,
  smartModelStatus,
  type SmartModels,
} from "../bridge";
import { logMsg } from "../log";
import { flashStatus, reportToolError } from "./hints";
import { ModelConsentCard } from "./modelconsent";
import { FeatherFollowsToggle } from "./featherfollows";
import { publishBusy } from "./statusbar";
import { watchOp } from "./opprogress";
import { clearFullPasses, markFullPassDue } from "../fullpass";
import { IDENTITY_VIEW, norm, normFree, type ViewTransform } from "./overlays";
import { useDragFollow } from "./dragfollow";
import { maskOfLayer } from "../layerids";

type D = React.Dispatch<Command>;

/** The whole-edge ViTMatte refinement, sitting in the polish
 * toolbar. A plain ACTION, not a toggle: press it and the model
 * re-reads the entire selection boundary; press it again and it
 * re-runs. The matte brush covers the local case by itself, so this
 * button exists for the one thing a stroke cannot trigger (refining
 * everything at once), and undo is how a matte comes off. It used
 * to light up and toggle, and the owner called the confusion:
 * "since Smart Matte will always turn on why not turn it on
 * transparently and why have it as a button?"*/
export function PolishMatteButton({ state, dispatch }: { state: State; dispatch: D }) {
  const sel = activeSelectionMask(state);
  const sessions = usePickSessions(state, dispatch);
  const [busy, setBusy] = useState(false);
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
  if (!sel) return null;
  const run = () => {
    const current = sessions.state();
    if (current.activeImage !== state.activeImage ||
        current.activeTakes[current.activeImage] !== state.activeTakes[state.activeImage] ||
        JSON.stringify(artMaskNode(current, sel.id)) !== JSON.stringify(sel)) return;
    const session = sessions.start("polish", {
      aim: (s) => artMaskNode(s, sel.id),
    });
    setBusy(true);
    markMatting(sel.id, true);
    publishBusy("REFINING \u00b7 the matting model is at the edge");
    const wasBaked = (sel.textParams?.matte_id ?? "").startsWith("baked:");
    void polishMatte(state, sel.id)
      .then((id) => {
        if (!session.stillMine()) return;
        setNeedModel(false);
        session.dispatch(
          wasBaked
            ? { type: "point_matte_at_bake", id: sel.id, version: id }
            : { type: "set_text_param", id: sel.id, param: "matte_id", value: id },
        );
      })
      .catch((err) => {
        if (String(err).includes("model not installed")) {
          setNeedModel(true);
        } else {
          reportToolError("Refine", err);
        }
      })
      .finally(() => {
        publishBusy(null);
        setBusy(false);
        markMatting(sel.id, false);
      });
  };
  return (
    <>
      <button
        className="chip"
        data-testid="art-polish-matte"
        disabled={busy}
        aria-label="Smart matte"
        data-tip="Refine edge"
        data-hint={
          busy
            ? "The model is reading the edge"
            : "Refine the whole edge with the matting model: hair, fur, the fine boundary the brushes cannot reach. Undo takes it back off"
        }
        style={{ padding: "3px 6px", display: "inline-flex" }}
        onClick={() => {
          if (busy) return;
          run();
        }}
      >
        {/* A head's dome with flyaway strands: the case the matte
            exists for, drawn literally. */}
        <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" aria-hidden="true">
          {REFINE_EDGE_GLYPH}
        </svg>
      </button>
      {busy && (
        <div
          data-testid="matte-oneshot-busy"
          style={{
            position: "fixed", left: 8, bottom: 8, fontSize: 9, letterSpacing: ".1em",
            color: "#c2c7cb", background: "rgba(0,0,0,.5)", padding: "2px 7px", zIndex: 40,
          }}
        >
          MATTING…
        </div>
      )}
      {needModel && models && (
        <MatteConsentCard
          models={models}
          downloading={downloading}
          onDownload={() => {
            setDownloading(true);
            void smartModelDownload("vitmatte")
              .then(() => {
                logMsg("info", "ViTMatte installed");
                setNeedModel(false);
                run();
              })
              .catch((err) => reportToolError("Download", err))
              .finally(() => setDownloading(false));
          }}
        />
      )}
    </>
  );
}

/** Keeps every brushed matte current: a matte stroke marks the band
 * where the edge needs re-reading, and a beat after the stroke lands
 * the model resolves it and the refined raster replaces the node's
 * base. This is what retired the classical matte sampler: its cost
 * grew with every stroke until the render queue drowned (the owner
 * watched 400ms become 4s per preview), so now the engine treats
 * matte strokes as free and the model pays once per finished stroke,
 * off the render path. Modeled on FillRunner: per-node watermarks,
 * debounce, latest wins, consent before any download.*/
export function PolishMatteRunner({ state, dispatch }: { state: State; dispatch: D }) {
  const sessions = usePickSessions(state, dispatch);
  const ownerKey = JSON.stringify([state.activeImage, state.activeTakes[state.activeImage]]);
  const targets = state.nodes.filter(
    (n) =>
      n.type === "heeler.selection_mask" &&
      // BAKED bases refine too now: the Rust side keeps the pointer in
      // its coarse graph and keys the result by it, so the model reads
      // the converted selection instead of clobbering it. The landing
      // differs (point_matte_at_bake consumes the geometry into a new
      // base) but the trigger is the same: a matte stroke.
      (n.strokes ?? []).some(
        (s) => !["foreground", "background", "feather"].includes((s as { mode?: string }).mode ?? ""),
      ),
  );
  const lastRun = useRef<Record<string, string>>({});
  const [matting, setMatting] = useState(false);
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
  // Reschedule a queued read when any protected node setting changes.
  // Otherwise validation could cancel its timer without starting a replacement.
  const pendingKey = ownerKey + JSON.stringify(targets);
  useEffect(() => {
    if (state.gesture !== null || matting) return;
    const due = targets.find((n) => matteRecipeOf(n) !== lastRun.current[`${ownerKey}:${n.id}`]);
    if (!due) return;
    const recipe = matteRecipeOf(due);
    const runKey = `${ownerKey}:${due.id}`;
    const session = sessions.start("polish", {
      aim: (s) => artMaskNode(s, due.id),
    });
    const timer = window.setTimeout(() => {
      if (!session.stillMine()) return;
      lastRun.current[runKey] = recipe;
      setMatting(true);
      markMatting(due.id, true);
      const wasBaked = (due.textParams?.matte_id ?? "").startsWith("baked:");
      void polishMatte(state, due.id)
        .then((id) => {
          if (!session.stillMine()) {
            delete lastRun.current[runKey];
            return;
          }
          setNeedModel(false);
          session.dispatch(
            wasBaked
              ? { type: "point_matte_at_bake", id: due.id, version: id }
              : { type: "set_text_param", id: due.id, param: "matte_id", value: id },
          );
        })
        .catch((err) => {
          if (String(err).includes("model not installed")) {
            setNeedModel(true);
            delete lastRun.current[runKey]; // retry after the download
          } else {
            reportToolError("Refine", err);
          }
        })
        .finally(() => {
          setMatting(false);
          markMatting(due.id, false);
        });
    }, 450);
    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingKey, state.gesture, matting]);
  if (targets.length === 0) return null;
  return (
    <>
      {matting && (
        <div
          data-testid="matte-busy"
          style={{
            position: "absolute", left: 8, bottom: 8, fontSize: 9, letterSpacing: ".1em",
            color: "#c2c7cb", background: "rgba(0,0,0,.5)", padding: "2px 7px",
          }}
        >
          MATTING…
        </div>
      )}
      {needModel && models && (
        <MatteConsentCard
          models={models}
          downloading={downloading}
          onDownload={() => {
            setDownloading(true);
            void smartModelDownload("vitmatte")
              .then(() => {
                logMsg("info", "ViTMatte installed");
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

// The preview reads in flight, by selection: the Refine edge button's
// and the brush runner's. Apply's full-resolution pass waits for them,
// since it re-solves the answer they are about to land.
const mattingNow = new Map<string, number>();
const mattingSubs = new Set<() => void>();
let mattingEpoch = 0;

/** Marks a preview matte read starting (on) or ending (off) on a node. */
export function markMatting(id: string, on: boolean): void {
  const n = (mattingNow.get(id) ?? 0) + (on ? 1 : -1);
  if (n > 0) mattingNow.set(id, n);
  else mattingNow.delete(id);
  mattingEpoch++;
  mattingSubs.forEach((f) => f());
}

/** Whether a preview matte read is running on a node right now. */
export function isMatting(id: string): boolean {
  return (mattingNow.get(id) ?? 0) > 0;
}

function useMattingEpoch(): number {
  return useSyncExternalStore(
    (f) => {
      mattingSubs.add(f);
      return () => {
        mattingSubs.delete(f);
      };
    },
    () => mattingEpoch,
  );
}

/** What a full-resolution pass was asked for: the photograph, its take,
 * and the selection's matte recipe. An undo or a new stroke changes it,
 * and a pass for the old one is canceled. */
function fullKeyOf(state: State, node: State["nodes"][number]): string {
  return JSON.stringify([
    state.activeImage,
    state.activeTakes[state.activeImage],
    node.textParams?.matte_id ?? "",
    matteRecipeOf(node),
  ]);
}

/** Apply's other half (2026-09-29: "yes, do the full resolution fix").
 * The brush and Refine edge solve on the 2048 px preview so a stroke
 * answers in a second and a half; at Apply the desktop solves the same
 * matte again over the photograph's own pixels, in tiles, and every
 * render from then on (Fit, 1:1, export) uses that answer. The wait is
 * on the progress row, with Cancel. It waits for a preview read still
 * in flight (it re-solves what that read is about to land), a second
 * Apply cancels the first on the desktop, and an undo or a new edit to
 * the selection while it runs cancels it here. A photograph switch is
 * not a cancel: a running pass finishes under its own photograph, and a
 * waiting Apply runs when its photograph comes back on screen. When the
 * preview matte has to stay (no model, not enough memory), the status
 * row says so.*/
export function PolishFullRunner({ state, dispatch }: { state: State; dispatch: D }) {
  const epoch = useMattingEpoch();
  // Taken asks: an Apply from before this runner mounted is not redone.
  const taken = useRef(state.matteApply?.seq ?? 0);
  const running = useRef<{ key: string; image: string; node: string } | null>(null);
  // Applies still waiting: on a preview read in flight, or on their
  // photograph coming back on screen (the pass solves from the state of
  // the photograph on screen, so away from it it cannot start; but a
  // switch no more drops a waiting Apply than it cancels a running one,
  // since dropping it left the user returning to soft hair at 1:1 with
  // nothing said; the quality review, stage 2). One entry per selection.
  const pending = useRef<{ image: string; node: string }[]>([]);
  // The photograph on screen now, for a pass that lands after a switch.
  const onScreen = useRef(state.activeImage);
  onScreen.current = state.activeImage;
  const ask = state.matteApply;
  // While a pass is taken and not finished, it is due (fullpass.ts): a
  // To Mask on that selection waits for it and bakes from its answer.
  const settle = (p: { image: string; node: string }) => {
    if (running.current?.image === p.image && running.current.node === p.node) return;
    if (pending.current.some((q) => q.image === p.image && q.node === p.node)) return;
    markFullPassDue(p.image, p.node, false);
  };
  useEffect(() => clearFullPasses, []);
  useEffect(() => {
    if (ask && ask.seq !== taken.current) {
      taken.current = ask.seq;
      pending.current = [
        ...pending.current.filter((q) => q.image !== ask.image || q.node !== ask.node),
        { image: ask.image, node: ask.node },
      ];
      markFullPassDue(ask.image, ask.node, true);
    }
    if (state.tool === "polish") {
      // Polishing the photograph on screen again supersedes its Applies.
      const dropped = pending.current.filter((q) => q.image === state.activeImage);
      pending.current = pending.current.filter((q) => q.image !== state.activeImage);
      for (const q of dropped) settle(q);
    }
    const p = pending.current.find((q) => q.image === state.activeImage);
    if (!p) return;
    const node = artMaskNode(state, p.node);
    if (!node || !(node.textParams?.matte_id ?? "")) {
      pending.current = pending.current.filter((q) => q !== p);
      settle(p);
      return;
    }
    const baked = (node.textParams?.matte_id ?? "").startsWith("baked:");
    // A landing on its way: wait for it (this effect runs again when it
    // lands, since the node and the in-flight marks change).
    if (isMatting(node.id) || (baked && hasMatteStrokes(node.strokes))) return;
    pending.current = pending.current.filter((q) => q !== p);
    const key = fullKeyOf(state, node);
    running.current = { key, image: p.image, node: node.id };
    void watchOp("matte", () => polishMatteFull(state, node.id))
      .then((answer) => {
        if (running.current?.key === key) running.current = null;
        if (answer.status === "done") {
          // Nothing in the graph changed, but what the render plants did.
          // On another photograph the twin waits on disk for a return.
          if (onScreen.current === p.image) dispatch({ type: "poke_render" });
        } else if (answer.status === "kept") {
          flashStatus(answer.message, 8000);
          logMsg("warn", answer.message);
        } else if (answer.status === "wait") {
          pending.current = [...pending.current.filter((q) => q !== p), p];
        }
        settle(p);
      })
      .catch((err) => {
        if (running.current?.key === key) running.current = null;
        settle(p);
        reportToolError("Full-resolution matte", err);
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ask?.seq, epoch, state.nodes, state.activeImage, state.tool]);
  // An undo or a new stroke on the selection while the pass runs: what
  // it solves is no longer wanted, so it stops (it would only ever store
  // the answer for its own recipe, never for the new one). Another
  // photograph on screen is not that: the pass keeps its answer under
  // its own photograph and recipe, so it runs on and the twin is there
  // when the user comes back; canceling threw away the six seconds
  // Apply had asked for, with nothing said (the quality review, stage 1).
  useEffect(() => {
    const r = running.current;
    if (!r || state.activeImage !== r.image) return;
    const node = artMaskNode(state, r.node);
    if (!node || fullKeyOf(state, node) !== r.key) {
      running.current = null;
      void cancelPolishMatteFull(r.image, r.node);
      settle(r);
    }
  });
  return null;
}

/** Apply's landing for a Finish layer's mask polish (State.polishLayer):
 * the polished document selection becomes the layer's mask, as Mask from
 * selection makes it (bake_layer_mask, "replace"), and the reducer puts
 * the document selection back (polish_layer_mask_land). Mounted after
 * PolishFullRunner, and a beat later than its effect besides, so a
 * full-resolution pass that Apply asked for is due before this bake
 * looks, and the bake waits for it (fullpass.ts) and keeps the
 * photograph's resolution. */
export function PolishLayerRunner({ state, dispatch }: { state: State; dispatch: D }) {
  const taken = useRef(0);
  const latest = useRef(state);
  latest.current = state;
  const ask = state.polishLayer?.applying ?? 0;
  useEffect(() => {
    const pass = state.polishLayer;
    if (!pass || ask === 0 || ask === taken.current) return;
    taken.current = ask;
    publishBusy("POLISH · putting the refined edge back on the layer");
    void Promise.resolve()
      .then(() => bakeLayerMask(latest.current, DOC_SEL_ID, pass.maskId, undefined, "replace"))
      .then((version) => dispatch({ type: "polish_layer_mask_land", seq: ask, version }))
      .catch((err) => {
        reportToolError("Polish mask", err);
        dispatch({ type: "polish_layer_mask_land", seq: ask });
      })
      .finally(() => publishBusy(null));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ask]);
  return null;
}

/** The download-consent card both matte surfaces show: name, size,
 * license, source, nothing fetched silently. */
function MatteConsentCard({
  models,
  downloading,
  onDownload,
}: {
  models: SmartModels;
  downloading: boolean;
  onDownload: () => void;
}) {
  return (
    <ModelConsentCard
      title="THE MATTE NEEDS ITS MODEL"
      model={models.refine}
      testid="matte"
      downloading={downloading}
      place={{ position: "fixed", left: "50%", bottom: 76, transform: "translateX(-50%)", zIndex: 40 }}
      onDownload={onDownload}
    />
  );
}

/** How the mask is painted over the photograph, per view mode.
 *
 * Returned rather than branched inline so the four modes sit next to
 * each other and read as a set: each is a color, and whether it marks
 * what is selected or what is not.
 */
export function polishPaint(view: string): {
  tint: [number, number, number];
  /** true paints where the mask IS, false paints where it is not */
  onSelected: boolean;
  strength: number;
  /** fill the frame first, for the modes that replace the picture */
  base?: [number, number, number];
} {
  switch (view) {
    case "black":
      return { tint: [0, 0, 0], onSelected: false, strength: 1 };
    case "white":
      return { tint: [255, 255, 255], onSelected: false, strength: 1 };
    case "mask":
      return { tint: [255, 255, 255], onSelected: true, strength: 1, base: [0, 0, 0] };
    default:
      // Red over the photograph at half strength, so the picture stays
      // legible underneath. Judging an edge against a color you cannot
      // see through is the thing this mode exists to avoid.
      return { tint: [214, 64, 64], onSelected: true, strength: 0.5 };
  }
}

/** Draws the mask over the frame, and takes brush strokes on top of it. */
export function PolishOverlay({
  state,
  dispatch,
  maskUrl,
  nodeId,
  view = IDENTITY_VIEW,
}: {
  state: State;
  dispatch: D;
  maskUrl: string | null;
  nodeId: string;
  view?: ViewTransform;
}) {
  const root = useRef<HTMLDivElement | null>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const [box, setBox] = useState<[number, number]>([0, 0]);
  const [hover, setHover] = useState<[number, number] | null>(null);
  const pts = useRef<[number, number][]>([]);
  const drawing = useRef(false);
  const [live, setLive] = useState<[number, number][]>([]);

  // The mask arrives from the engine as an image, so it is read into a
  // canvas and recolored; its luminance is the coverage.
  useEffect(() => {
    const el = canvas.current;
    const [w, h] = box;
    if (!el || w <= 0 || h <= 0) return;
    const dpr = window.devicePixelRatio || 1;
    el.width = Math.round(w * dpr);
    el.height = Math.round(h * dpr);
    const ctx = el.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    if (!maskUrl) return;
    const paint = polishPaint(state.polishView);
    let live = true;
    const img = new Image();
    img.onload = () => {
      if (!live) return;
      const scratch = document.createElement("canvas");
      scratch.width = Math.max(1, Math.round(w));
      scratch.height = Math.max(1, Math.round(h));
      const sctx = scratch.getContext("2d", { willReadFrequently: true });
      if (!sctx) return;
      sctx.drawImage(img, 0, 0, scratch.width, scratch.height);
      let data: ImageData;
      try {
        data = sctx.getImageData(0, 0, scratch.width, scratch.height);
      } catch {
        // A tainted frame cannot be read back; the matte simply does not
        // draw rather than taking the viewer down.
        return;
      }
      const out = sctx.createImageData(scratch.width, scratch.height);
      for (let i = 0; i < scratch.width * scratch.height; i++) {
        const cov = data.data[i * 4] / 255;
        const a = (paint.onSelected ? cov : 1 - cov) * paint.strength;
        out.data[i * 4] = paint.tint[0];
        out.data[i * 4 + 1] = paint.tint[1];
        out.data[i * 4 + 2] = paint.tint[2];
        out.data[i * 4 + 3] = Math.round(a * 255);
      }
      sctx.putImageData(out, 0, 0);
      if (paint.base) {
        ctx.fillStyle = "rgb(" + paint.base.join(",") + ")";
        ctx.fillRect(0, 0, w, h);
      }
      ctx.drawImage(scratch, 0, 0, w, h);
    };
    img.src = maskUrl;
    return () => {
      live = false;
    };
  }, [maskUrl, box, state.polishView]);

  const commit = () => {
    if (!drawing.current) return;
    drawing.current = false;
    if (pts.current.length) {
      // Another region on the selection, not a change to the pixels, so
      // it undoes and can be removed from the list like anything else.
      dispatch({
        type: "add_region",
        id: nodeId,
        region: {
          kind: "brush",
          op: state.polishAdd ? "add" : "subtract",
          points: pts.current,
          radius: state.polishRadius,
        },
      });
    }
    pts.current = [];
    setLive([]);
  };

  // The stroke follows the pointer off the canvas, its points where the
  // brush really is (normFree), so it can reach the frame's edge
  // (dragfollow.ts).
  const strokeTo = (e: { clientX: number; clientY: number; buttons: number }) => {
    if (!drawing.current) return;
    // The release was heard nowhere (off the window, over a menu): the
    // stroke ends there instead of following the hover.
    if (!primaryHeld(e)) {
      commit();
      return;
    }
    pts.current = [...pts.current, normFree(e, root.current!, view)];
    setLive([...pts.current]);
  };
  const followed = useDragFollow<MouseEvent>({ move: strokeTo, up: commit });

  const [w, h] = box;
  const r = Math.max(1, state.polishRadius * Math.min(w || 1, h || 1));
  const path = (points: [number, number][]) =>
    points.map(([x, y]) => x * w + "," + y * h).join(" ");

  return (
    <div
      ref={(el) => {
        root.current = el;
        if (el && el.clientWidth > 0 && (el.clientWidth !== box[0] || el.clientHeight !== box[1])) {
          setBox([el.clientWidth, el.clientHeight]);
        }
      }}
      data-testid="polish-overlay"
      data-view={state.polishView}
      style={{ position: "absolute", inset: 0, cursor: "none" }}
      onMouseDown={(e) => {
        if (!isPrimaryPress(e)) return;
        e.stopPropagation();
        drawing.current = true;
        pts.current = [norm(e, e.currentTarget as HTMLElement, view)];
        setLive([...pts.current]);
        followed.start();
      }}
      onMouseMove={(e) => {
        setHover(norm(e, e.currentTarget as HTMLElement, view));
        if (!followed.active()) strokeTo(e);
      }}
      onMouseUp={() => { if (!followed.active()) commit(); }}
      // Leaving ends no stroke: the window follows it.
      onMouseLeave={() => setHover(null)}
    >
      <canvas
        data-testid="polish-matte"
        ref={canvas}
        style={{
          position: "absolute",
          inset: 0,
          width: "100%",
          height: "100%",
          pointerEvents: "none",
        }}
      />
      {w > 0 && (
        <svg
          width={w}
          height={h}
          viewBox={"0 0 " + w + " " + h}
          style={{ position: "absolute", inset: 0, pointerEvents: "none" }}
        >
          {/* The stroke in progress, so a drag reads as painting rather
              than as nothing happening until you let go. */}
          {live.length > 1 && (
            <polyline
              data-testid="polish-live"
              points={path(live)}
              fill="none"
              stroke={state.polishAdd ? "rgba(255,255,255,.5)" : "rgba(0,0,0,.5)"}
              strokeWidth={r * 2}
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          )}
          {hover && (
            <g data-testid="polish-cursor" data-add={state.polishAdd || undefined}>
              {/* Dark under light, so the ring reads over a bright edge
                  and a dark one alike; dashed and red while erasing. */}
              <circle
                cx={hover[0] * w}
                cy={hover[1] * h}
                r={r}
                fill="none"
                stroke="rgba(0,0,0,.75)"
                strokeWidth={3}
              />
              <circle
                cx={hover[0] * w}
                cy={hover[1] * h}
                r={r}
                fill="none"
                stroke={state.polishAdd ? "#fff" : "var(--reject)"}
                strokeWidth={1.2}
                strokeDasharray={state.polishAdd ? undefined : "5 4"}
              />
            </g>
          )}
        </svg>
      )}
    </div>
  );
}

/** The registry's defaults for the matte dials, for a selection node
 * from before they existed. */
const POLISH_PARAM_DEFAULTS: Record<string, number> = { matte_contrast: 25, matte_reach: 50 };

/** The panel that takes the Adjustments panel's place while polishing. */
function PolishPanelImpl({ state, dispatch }: { state: State; dispatch: D }) {
  const mask = state.activeLayer
    ? state.nodes.find((n) => n.id === maskOfLayer(state.activeLayer!))
    : undefined;
  // A selection from before the matte dials carries neither param; the
  // registry's defaults stand in so the dial shows what the engine does.
  const param = (p: string) => mask?.params[p] ?? POLISH_PARAM_DEFAULTS[p] ?? 0;
  const setParam = (p: string, v: number) =>
    mask && dispatch({ type: "set_param", id: mask.id, param: p, value: v });

  // `scale` is what the value field shows per unit: the edge dials are
  // 0..1 shown as 0..100, the matte dials are 0..100 as they are.
  // The two matte dials say when they are off (review R2 and R3,
  // 2026-09-23): Reach is the brush's, so it does nothing without a
  // matte stroke; on a converted (baked) selection, coverage already,
  // Contrast shapes the next brushed refinement and nothing before it.
  const matteStrokes = hasMatteStrokes(mask?.strokes);
  const baked = (mask?.textParams?.matte_id ?? "").startsWith("baked:");
  const reachOff = !matteStrokes
    ? "Paint with the matte brush first: Reach says how far past a stroke a strand is followed"
    : null;
  const contrastOff = baked && !matteStrokes
    ? "A converted selection is coverage already: paint with the matte brush to refine it, and Contrast shapes that refinement"
    : null;

  const slider = (label: string, p: string, min: number, max: number, hint: string, scale = 100, off: string | null = null) => (
    <div className="srow" style={{ gridTemplateColumns: "78px 1fr 42px" }} data-off={off ? "true" : undefined}>
      <div className="lbl" style={off ? { color: "var(--text-ghost)" } : undefined}>{label}</div>
      <TrackSlider
        label={label}
        lo={min}
        hi={max}
        step={scale === 100 ? 0.01 : 1}
        testid={"polish-" + p}
        hint={off ?? hint}
        value={param(p)}
        disabled={off !== null}
        onBegin={() => mask && dispatch({ type: "begin_gesture", key: `${mask.id}.${p}` })}
        onChange={(v) => setParam(p, v)}
        onEnd={() => dispatch({ type: "end_gesture" })}
      />
      <ValueField
        param={label.toLowerCase()}
        value={param(p)}
        lo={min}
        hi={max}
        scale={scale}
        display={(v) => String(Math.round(v))}
        testid={`polish-${p}-value`}
        onCommit={(v) => off === null && setParam(p, v)}
      />
    </div>
  );

  return (
    <div
      data-testid="polish-panel"
      style={{ padding: "10px 12px", display: "flex", flexDirection: "column", gap: 7 }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <div className="kicker" style={{ flex: 1 }}>
          Polish selection
        </div>
        <button
          className="chip"
          data-testid="polish-done"
          data-hint="Go back to the adjustments"
          style={{ fontSize: 9, padding: "2px 9px" }}
          onClick={() => dispatch({ type: "set_polish_open", open: false })}
        >
          DONE
        </button>
      </div>

      <div className="srow" style={{ gridTemplateColumns: "78px 1fr" }}>
        <div className="lbl">View</div>
        <div
          className="zoom-seg"
          role="group"
          aria-label="Polish view"
          style={{ border: "1px solid var(--line-4)" }}
        >
          {POLISH_VIEWS.map((v) => (
            <button
              key={v.id}
              data-active={state.polishView === v.id}
              data-testid={"polish-view-" + v.id}
              data-hint={v.hint}
              style={{ fontSize: 9, padding: "1px 5px", whiteSpace: "nowrap", flex: "none" }}
              onClick={() => dispatch({ type: "set_polish_view", view: v.id })}
            >
              {v.label}
            </button>
          ))}
        </div>
      </div>

      {/* Three different jobs, in the order they run. Grow moves the
          edge, smooth rounds off the jags without moving the straight
          parts, feather softens without moving anything. */}
      {slider("Grow", "grow", -1, 1, "Push the edge outward, or inward below zero")}
      {slider("Smooth", "smooth", 0, 1, "Round off the jagged bits a hand-drawn edge leaves")}
      {slider("Feather", "feather", 0, 1, "Soften the edge without moving it")}
      {mask && <FeatherFollowsToggle node={mask} dispatch={dispatch} testid="polish-feather-guided" />}
      {/* A layer editor's Refine has four settings and Heeler had three of
them on a dial; the engine always ran the fourth (2026-09-29:
"refine gives some better options"). It touches only the soft part
of the edge, so it sits after Feather, which is what makes one.*/}
      {slider(
        "Ramp",
        "ramp",
        -100,
        100,
        "Take the soft part of the edge in (below zero) or let more of it into the selection (above zero); fully in and fully out never move",
        1,
      )}
      {/* The matte's two dials (2026-09-22: "we can't always rely on one
setting to accommodate every photo"). Contrast is live in the engine
on the planted base; Reach is part of the matte's recipe, so a change
re-reads the edge a beat after the drag.*/}
      {slider(
        "Contrast",
        "matte_contrast",
        0,
        100,
        "How decided the refined edge is: low keeps the model's soft haze around hair, high cuts hard at the half-way line",
        1,
        contrastOff,
      )}
      {slider(
        "Reach",
        "matte_reach",
        0,
        100,
        "How far past the brush a strand is followed: 0 keeps the matte to where you painted, 100 follows a strand up to one brush radius beyond; re-reads the edge",
        1,
        reachOff,
      )}

      <div className="srow" style={{ gridTemplateColumns: "78px 1fr" }}>
        <div className="lbl">Brush</div>
        <div
          className="zoom-seg"
          role="group"
          aria-label="Polish brush mode"
          style={{ border: "1px solid var(--line-4)" }}
        >
          <button
            data-active={state.polishAdd}
            data-testid="polish-add"
            data-hint="Paint areas into the selection"
            style={{ fontSize: 9, padding: "1px 7px" }}
            onClick={() => dispatch({ type: "set_polish_add", add: true })}
          >
            Add
          </button>
          <button
            data-active={!state.polishAdd}
            data-testid="polish-erase"
            data-hint="Paint areas out of the selection"
            style={{ fontSize: 9, padding: "1px 7px" }}
            onClick={() => dispatch({ type: "set_polish_add", add: false })}
          >
            Erase
          </button>
        </div>
      </div>
      <div className="srow" style={{ gridTemplateColumns: "78px 1fr 42px" }}>
        <div className="lbl">Brush size</div>
        <TrackSlider
          label="Polish brush size"
          lo={0.002}
          hi={0.3}
          step={0.002}
          testid="polish-radius"
          hint="Size of the polish brush"
          value={state.polishRadius}
          onChange={(radius) => dispatch({ type: "set_polish_radius", radius })}
        />
        <ValueField
          param="polish brush size"
          value={state.polishRadius}
          lo={0.002}
          hi={0.3}
          scale={200}
          display={(v) => String(Math.round(v))}
          testid="polish-radius-value"
          onCommit={(radius) => dispatch({ type: "set_polish_radius", radius })}
        />
      </div>

      <div style={{ fontSize: 9, color: "var(--text-ghost)", lineHeight: 1.6, marginTop: 2 }}>
        Zoom and pan as usual while you work. Every stroke is another region on the selection, so
        anything here can be undone or taken off the list afterwards.
      </div>
    </div>
  );
}

// Memoized against everything but the view-only fields (see viewmemo.ts):
// polish is exactly when deep-zoom panning happens, and none of it
// changes what this panel draws.
export const PolishPanel = memo(PolishPanelImpl, panePropsEqual);
