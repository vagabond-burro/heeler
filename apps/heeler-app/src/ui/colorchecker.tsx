// The Color Checker's panel controls and its viewport chart tool
// (26.3 Phase 11).
//
// The controls ride in two seats, one shared component: the Develop
// section and the node's inspector face. They offer the chart dropdown
// and the Place chart button; the fit itself (Calibrate) lands with the
// sampler.
//
// The overlay draws over the photograph while chartPlace is armed: the
// chart quad (four draggable corners, TL TR BR BL order, stored as image
// fractions in the node's quad text param), the patch grid mapped through
// the quad's projective map, and a sample circle per patch tinted with
// the reference color. The circle is defined in chart space and drawn
// through the quad, so under perspective it becomes an ellipse, exactly
// the region the sampler averages; its size is the node's sample param
// (percent of the cell), which a drag on any circle's rim scales for
// every patch together. A patch click excludes it from the fit (or takes
// it back in); a patch drag nudges its center, for a chart whose print
// drifted off its grid. Both overrides live in the patches text param as
// {"nudged": {"3": [x, y]}, "excluded": [4, 7]} with absolute centers.

import { isPrimaryPress } from "./pointerguard";
import { useDragFollow } from "./dragfollow";
import React, { useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  colorCheckerNode,
  shapeLineWidth,
  toolNode,
  PRESET_SCHEMA,
  type Command,
  type NodeCard,
  type PresetFile,
  type State,
} from "../state";
import {
  chartCalibrate,
  imageMetadata,
  presetList,
  presetRead,
  presetSave,
  type PatchReport,
  type PresetEntry,
} from "../bridge";
import { usePickSessions } from "../picksession";
import { FIT_ORDER, convertLegacyFit, fitNeedsOrderFix } from "../checkerfit";
import { loadCharts, chartById, type ChartDef } from "../charts";
import { ChartEditor } from "./charteditor";
import { solveHomography, mapPoint, type Pt, type Quad } from "../quadmap";
import { LinesRow, LineWidthRow, resolveLineColor, useAutoLineColor } from "./linecolor";
import { lineColorCss } from "../gridwarp";
import { TrackSlider, ValueField } from "./track";
import { flashStatus, reportToolError } from "./hints";
import { MenuField } from "./menufield";

type D = React.Dispatch<Command>;

/** The quad a fresh placement starts from, before any corner moves. */
export const DEFAULT_QUAD: Quad = [
  [0.2, 0.2],
  [0.8, 0.2],
  [0.8, 0.8],
  [0.2, 0.8],
];

/** The node's quad, or the default when none has been written yet.
 * Corner order is TL, TR, BR, BL, the order quadmap.ts uses everywhere. */
export function quadOf(node: NodeCard): Quad {
  const raw = node.textParams?.quad ?? "";
  if (!raw) return DEFAULT_QUAD;
  try {
    const q = JSON.parse(raw);
    if (
      Array.isArray(q) &&
      q.length === 4 &&
      q.every((p) => Array.isArray(p) && p.length === 2 && p.every((v) => Number.isFinite(v)))
    ) {
      return q as Quad;
    }
  } catch {
    // A hand-edited or half-written param falls back to the default.
  }
  return DEFAULT_QUAD;
}

/** The node's sample param: the sample circle's diameter as a percent
 * of the cell, clamped to the param's range. The overlay draws it and
 * the sampler measures it, one number for both. */
export function sampleOf(node: NodeCard): number {
  return Math.min(90, Math.max(10, node.params.sample ?? 40));
}

export interface PatchOverrides {
  /** Patch index to its hand-placed center, absolute image fractions. */
  nudged: Record<number, Pt>;
  excluded: number[];
}

export function patchesOf(node: NodeCard): PatchOverrides {
  const raw = node.textParams?.patches ?? "";
  if (!raw) return { nudged: {}, excluded: [] };
  try {
    const p = JSON.parse(raw);
    const nudged: Record<number, Pt> = {};
    for (const [k, v] of Object.entries(p.nudged ?? {})) {
      const i = Number(k);
      if (Number.isInteger(i) && Array.isArray(v) && v.length === 2 && v.every((x) => Number.isFinite(x))) {
        nudged[i] = v as Pt;
      }
    }
    const excluded = Array.isArray(p.excluded)
      ? p.excluded.filter((i: unknown) => Number.isInteger(i))
      : [];
    return { nudged, excluded };
  } catch {
    return { nudged: {}, excluded: [] };
  }
}

/** The fit report the node keeps in its fit text param: the fit fields,
 * the panel rows, and the provenance (chart, photo, camera, when). */
export interface StoredFit {
  temperature: number;
  tint: number;
  exposure: number;
  matrix: number[];
  wb_in_matrix: boolean;
  residuals: [number, number][];
  mean_de: number;
  illuminant: string;
  flagged: number[];
  fitted: number;
  note: string;
  patches: PatchReport[];
  chart: string;
  photo: string;
  camera: string | null;
  when: string;
  set_wb: boolean;
  /** The calibration preset this fit came from, when applied rather
   * than fitted on this photograph (Phase 11's saved calibrations). */
  name?: string;
  /** FIT_ORDER once the matrix is expressed for the graph's order, the
   * checker before Standard Color; absent on fits from before the fix,
   * which convert_legacy_fits re-expresses on load (2026-09-20). */
  order?: string;
}

/** The node's stored fit report, or null before the first Calibrate. */
export function reportOf(node: NodeCard): StoredFit | null {
  const raw = node.textParams?.fit ?? "";
  if (!raw) return null;
  try {
    const f = JSON.parse(raw);
    if (typeof f.mean_de !== "number" || !Array.isArray(f.patches)) return null;
    return f as StoredFit;
  } catch {
    return null;
  }
}

/** A calibration as a preset: only this node's matrix, exposure, chart
 * id and fit report travel. The quad and the patch overrides belong to
 * the photograph the chart was shot in, and Amount is the user's dial. */
export function calibrationPreset(node: NodeCard, name: string): PresetFile {
  const keys = ["m00", "m01", "m02", "m10", "m11", "m12", "m20", "m21", "m22", "exposure"];
  return {
    schema: PRESET_SCHEMA,
    name,
    nodes: [
      {
        ...structuredClone(node),
        params: Object.fromEntries(keys.map((k) => [k, node.params[k] ?? 0])),
        textParams: {
          chart: node.textParams?.chart ?? "colorchecker-classic",
          fit: node.textParams?.fit ?? "",
        },
        enabled: true,
      },
    ],
    wires: [],
  };
}

/** The patches the last fit flagged (clipped or glare), read off the
 * node's fit report so the overlay can outline them. Empty before the
 * first Calibrate. */
export function flaggedOf(node: NodeCard): Set<number> {
  const raw = node.textParams?.fit ?? "";
  if (!raw) return new Set();
  try {
    const f = JSON.parse(raw);
    return new Set(Array.isArray(f.flagged) ? f.flagged.filter((i: unknown) => Number.isInteger(i)) : []);
  } catch {
    return new Set();
  }
}

function useChartList(refreshKey: unknown) {
  const [charts, setCharts] = useState<ChartDef[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let live = true;
    setError(null);
    loadCharts().then((list) => {
      if (live) setCharts(list);
    }, (e) => {
      if (live) setError(String(e));
    });
    return () => { live = false; };
  }, [refreshKey, attempt]);
  return { charts, error, retry: () => setAttempt((n) => n + 1) };
}

function ChartLoadError({ error, retry }: { error: string | null; retry: () => void }) {
  if (!error) return null;
  return <div role="alert" className="help" style={{ pointerEvents: "auto", position: "relative", zIndex: 1 }}>
    Could not load charts: {error} <button data-testid="charts-retry" onClick={retry}>Retry</button>
  </div>;
}

/** The section's and the inspector's shared controls: which chart, and
 * the button that raises the viewport overlay. `amount` adds the house
 * Amount slider for the inspector face; the panel gets its Amount from
 * the section's ordinary slider row instead. */
export function ColorCheckerControls({
  state,
  dispatch,
  amount = false,
  frame = null,
}: {
  state: State;
  dispatch: D;
  amount?: boolean;
  /** the frame on screen, for the lines' automatic color */
  frame?: string | null;
}) {
  const node = colorCheckerNode(state);
  const picks = usePickSessions(state, dispatch);
  const [editorOpen, setEditorOpen] = useState(false);
  const { charts, error: chartsError, retry: retryCharts } = useChartList(editorOpen);
  // Calibration callbacks keep their own component lifetime guard.
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const chartId = node.textParams?.chart || "colorchecker-classic";
  const [setWb, setSetWb] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The panel's placeholder for an unbuilt section and the stand-in both
  // read off, so enabled alone is the section's truth in either seat:
  // Calibrate only makes sense once the section is really on.
  const live = node.enabled;

  const calibrationSession = () => picks.start("calibration", {
    aim: (s) => colorCheckerNode(s).id,
    settings: (s) => [s.nodes, s.wires],
  });
  const calibrate = async () => {
    const session = calibrationSession();
    setBusy(true);
    setError(null);
    try {
      const overrides = patchesOf(node);
      const answer = await chartCalibrate(
        state,
        chartId,
        quadOf(node),
        overrides.nudged,
        overrides.excluded,
        setWb,
      );
      if (!session.stillMine()) return;
      const m = answer.fit.matrix;
      session.dispatch({
        type: "set_params",
        id: node.id,
        values: {
          m00: m[0], m01: m[1], m02: m[2],
          m10: m[3], m11: m[4], m12: m[5],
          m20: m[6], m21: m[7], m22: m[8],
          exposure: answer.fit.exposure,
        },
      });
      // The White Balance node stays the seat for WB: with the chip on,
      // the fit's temperature and tint are written there and the matrix
      // carries none of it.
      if (setWb && !answer.fit.wb_in_matrix) {
        const wb = toolNode(state, "color");
        if (wb && state.nodes.some((n) => n.id === wb.id)) {
          session.dispatch({
            type: "set_params",
            id: wb.id,
            values: {
              temperature: Math.round(answer.fit.temperature),
              tint: Math.round(answer.fit.tint),
            },
          });
        }
      }
      const report: StoredFit = {
        ...answer.fit,
        patches: answer.patches,
        chart: chartId,
        photo: state.activeImage,
        camera: answer.camera,
        when: new Date().toISOString(),
        set_wb: setWb,
        order: FIT_ORDER,
      };
      session.dispatch({ type: "set_text_param", id: node.id, param: "fit", value: JSON.stringify(report) });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const report = reportOf(node);

  // Saved calibrations: presets in the Calibrations folder of the
  // presets base, listed here and in the Presets tab alike.
  const [savingCal, setSavingCal] = useState(false);
  const [calName, setCalName] = useState("");
  const [calibrations, setCalibrations] = useState<PresetEntry[]>([]);
  const [calPick, setCalPick] = useState("");
  const [cameraWarn, setCameraWarn] = useState<string | null>(null);
  const refreshCalibrations = () => {
    void presetList()
      .then((list) => setCalibrations(list.filter((e) => !e.builtin && e.category === "Calibrations")))
      .catch(() => {});
  };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(refreshCalibrations, []);

  const saveCalibration = async () => {
    const name = calName.trim();
    if (!name) return;
    try {
      await presetSave("Calibrations", name, calibrationPreset(node, name));
      flashStatus(`Saved calibration "${name}"`);
      setSavingCal(false);
      setCalName("");
      refreshCalibrations();
    } catch (e) {
      reportToolError("Save calibration", e);
    }
  };

  const applyCalibration = async () => {
    const entry = calibrations.find((c) => c.path === calPick);
    if (!entry) return;
    const session = calibrationSession();
    try {
      const preset = await presetRead(entry.builtin, entry.path);
      const src = preset.nodes.find((n) => n.type === "heeler.color_checker");
      if (!src) {
        reportToolError("Apply calibration", `"${entry.name}" holds no Color Checker`);
        return;
      }
      const diag = ["m00", "m11", "m22"];
      let matrix = ["m00", "m01", "m02", "m10", "m11", "m12", "m20", "m21", "m22"].map(
        (k) => src.params[k] ?? (diag.includes(k) ? 1 : 0),
      );
      // The apply is recorded in the fit report: the calibration's name,
      // its fitted-on camera kept, so the panel can warn on a different
      // camera without refusing.
      let stored = src.textParams?.fit ? JSON.parse(src.textParams.fit) : {};
      stored.name = entry.name;
      // A calibration saved before the order fix converts as it is
      // applied, the way a saved graph's does on load.
      if (fitNeedsOrderFix(stored)) {
        const converted = convertLegacyFit(matrix, stored);
        matrix = converted.matrix;
        stored = converted.fit;
      }
      const meta = await imageMetadata(state, state.activeImage).catch(() => null);
      if (!session.stillMine()) return;
      const current = meta?.camera ?? null;
      if (stored.camera && current && stored.camera !== current) {
        setCameraWarn(`"${entry.name}" was fitted on a ${stored.camera}; this photograph is from a ${current}.`);
      } else {
        setCameraWarn(null);
      }
      session.dispatch({
        type: "apply_calibration",
        name: entry.name,
        matrix,
        exposure: src.params.exposure ?? 0,
        chart: src.textParams?.chart ?? "colorchecker-classic",
        fit: JSON.stringify(stored),
      });
      flashStatus(`Applied calibration "${entry.name}"`);
    } catch (e) {
      reportToolError("Apply calibration", e);
    }
  };

  return (
    <div
      data-testid="colorchecker-controls"
      style={{ display: "flex", flexDirection: "column", gap: 4, margin: "2px 0 6px" }}
    >
      <ChartLoadError error={chartsError} retry={retryCharts} />
      <div className="kicker" data-testid="colorchecker-kicker-chart" style={{ marginTop: 6, marginBottom: 1, opacity: 0.75 }}>
        CHART
      </div>
      {/* Laid out as the work goes (2026-09-19: "all controls are lumped
together"): the chart and its placement, then the calibration and
what to do with it, then the lines' look.*/}
      <MenuField
          testid="colorchecker-chart"
          label="Which chart was photographed"
          hint="The chart in the photograph; its published values are what the fit aims at"
          node={node.id}
          param="chart"
          size="regular"
          value={chartId}
          options={charts.map((c) => ({ id: c.id, label: c.name }))}
          onChange={(value) => dispatch({ type: "set_text_param", id: node.id, param: "chart", value })}
        />
      <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
        <button
          className="chip"
          data-testid="colorchecker-place"
          aria-pressed={state.chartPlace}
          data-hint="Show the chart grid over the photo; drag the corners onto the chart's corners"
          onClick={() =>
            // The bargain every control in this panel makes: the command
            // names the node, and an off section is built on the way
            // through the panel's dispatch.
            dispatch({ type: "toggle_chart_place", id: node.id })
          }
        >
          {state.chartPlace ? "Done" : "Place chart"}
        </button>
        <button
          className="chip"
          data-testid="colorchecker-custom-chart"
          data-hint="Build a chart of your own: grid, targets from the palette or a datasheet, saved beside the built-ins"
          onClick={() => setEditorOpen(true)}
        >
          Custom chart...
        </button>
      </div>
      {editorOpen && (
        <ChartEditor
          dispatch={dispatch}
          nodeId={node.id}
          currentChart={charts.find((c) => c.id === chartId) ?? null}
          onClose={() => setEditorOpen(false)}
        />
      )}
      <div className="kicker" data-testid="colorchecker-kicker-calibration" style={{ marginTop: 6, marginBottom: 1, opacity: 0.75 }}>
        CALIBRATION
      </div>
      {/* Where the fit's white balance goes is a choice between two places,
not a switch: drawn as one, with both named, so the status line
never reads it as a toggle (2026-09-19).*/}
      <div className="srow" style={{ gridTemplateColumns: "78px 1fr", height: "auto", minHeight: 24 }}>
        <div className="lbl">White balance</div>
        <div
          className="zoom-seg"
          role="group"
          aria-label="Where the fit's white balance goes"
          data-testid="colorchecker-setwb"
          data-active={setWb}
          style={{ border: "1px solid var(--line-4)", width: "fit-content" }}
        >
          <button
            data-testid="colorchecker-wb-node"
            data-active={setWb}
            aria-pressed={setWb}
            data-hint="To the White Balance node: the fit sets its Temp and Tint, and you can still move them"
            onClick={() => setSetWb(true)}
          >
            To node
          </button>
          <button
            data-testid="colorchecker-wb-matrix"
            data-active={!setWb}
            aria-pressed={!setWb}
            data-hint="Into the matrix: the White Balance node is left alone and the whole correction lives in this section"
            onClick={() => setSetWb(false)}
          >
            In matrix
          </button>
        </div>
      </div>
      <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
        <button
          className="chip"
          data-testid="colorchecker-calibrate"
          disabled={busy || !live}
          data-hint={
            live
              ? "Sample the chart through the quad and fit the matrix"
              : "Switch the Color Checker on first"
          }
          onClick={() => void calibrate()}
        >
          {busy ? "Calibrating..." : "Calibrate"}
        </button>
      </div>
      {error && (
        <div data-testid="colorchecker-error" className="help" style={{ color: "var(--text-warn, #c66)" }}>
          {error}
        </div>
      )}
      {cameraWarn && (
        <div
          data-testid="colorchecker-camera-warn"
          className="help" style={{ color: "var(--text-warn, #c66)" }}
        >
          {cameraWarn}
        </div>
      )}
      {report && <CalibrationReport report={report} />}
      <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
        <button
          className="chip"
          data-testid="colorchecker-save-calibration"
          disabled={!report}
          data-hint="Save this calibration: matrix, exposure, chart and report, nothing about this photo's placement"
          onClick={() => setSavingCal(!savingCal)}
        >
          Save calibration...
        </button>
        {calibrations.length > 0 && (
          <>
            <MenuField
              testid="colorchecker-calibrations"
              label="Saved calibrations"
              hint="A saved calibration applies its matrix and exposure to this photo"
              size="regular"
              value={calPick}
              placeholder="Calibrations…"
              options={calibrations.map((c) => ({ id: c.path, label: c.name }))}
              onChange={setCalPick}
            />
            <button
              className="chip"
              data-testid="colorchecker-apply-calibration"
              disabled={!calPick}
              onClick={() => void applyCalibration()}
            >
              Apply
            </button>
          </>
        )}
      </div>
      {savingCal && report && (
        <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
          <input
            data-testid="colorchecker-cal-name"
            value={calName}
            placeholder="Calibration name"
            aria-label="Calibration name"
            onChange={(e) => setCalName(e.target.value)}
            style={{
              flex: 1,
              minWidth: 0,
              padding: "3px 7px",
              background: "var(--bg-app)",
              border: "1px solid var(--line-4)",
              color: "var(--text-body)",
              outline: "none",
            }}
          />
          <button
            className="chip"
            data-testid="colorchecker-cal-save"
            disabled={!calName.trim()}
            style={{ padding: "1px 8px" }}
            onClick={() => void saveCalibration()}
          >
            SAVE
          </button>
        </div>
      )}
      <div className="kicker" data-testid="colorchecker-kicker-lines" style={{ marginTop: 6, marginBottom: 1, opacity: 0.75 }}>
        CHART LINES
      </div>
      <LinesRow lineColor={state.lineColor} dispatch={dispatch} previewUrl={frame} prefix="colorchecker" subject="chart lines" />
      <LineWidthRow state={state} dispatch={dispatch} prefix="colorchecker" subject="chart lines" />
      {amount && (
        <>
          <div className="srow">
            <div className="lbl">Amount</div>
            <TrackSlider
              label="Amount"
              testid="colorchecker-amount"
              value={node.params.amount ?? 100}
              lo={0}
              hi={100}
              centered={false}
              onBegin={() => dispatch({ type: "begin_gesture", key: `${node.id}.amount` })}
              onChange={(v) => dispatch({ type: "set_param", id: node.id, param: "amount", value: Math.round(v) })}
              onEnd={() => dispatch({ type: "end_gesture" })}
            />
            <ValueField
              param="colorchecker-amount"
              value={Math.round(node.params.amount ?? 100)}
              lo={0}
              hi={100}
              display={(v) => String(Math.round(v))}
              onCommit={(v) => dispatch({ type: "set_param", id: node.id, param: "amount", value: Math.round(v) })}
            />
          </div>
          {/* The sample circle's size, the inspector's seat for it: the
              panel's own row comes from the section's slider rows, like
              Amount's. One value, drawn by the overlay, measured by the
              sampler. */}
          <div className="srow">
            <div className="lbl">Sample</div>
            <TrackSlider
              label="Sample"
              testid="colorchecker-sample"
              value={sampleOf(node)}
              lo={10}
              hi={90}
              centered={false}
              onBegin={() => dispatch({ type: "begin_gesture", key: `${node.id}.sample` })}
              onChange={(v) => dispatch({ type: "set_param", id: node.id, param: "sample", value: Math.round(v) })}
              onEnd={() => dispatch({ type: "end_gesture" })}
            />
            <ValueField
              param="colorchecker-sample"
              value={Math.round(sampleOf(node))}
              lo={10}
              hi={90}
              display={(v) => String(Math.round(v))}
              onCommit={(v) => dispatch({ type: "set_param", id: node.id, param: "sample", value: Math.round(v) })}
            />
          </div>
        </>
      )}
    </div>
  );
}

/** The viewport overlay: the chart quad, its patch grid, and the sample
 * circles, all mapped through the quad's projective map so a tilted chart
 * reads square-on. Mounted from the viewer while chartPlace is armed. */
export function ChartToolOverlay({
  state,
  dispatch,
  node,
  norm,
  previewUrl = null,
}: {
  state: State;
  dispatch: D;
  node: NodeCard;
  norm: (e: { clientX: number; clientY: number }, el: HTMLElement) => [number, number];
  /** the frame on screen, for the lines' automatic color */
  previewUrl?: string | null;
}) {
  const { charts, error: chartsError, retry: retryCharts } = useChartList(node.id);
  const chart = chartById(charts, node.textParams?.chart || "colorchecker-classic");
  const quad = quadOf(node);
  const overrides = patchesOf(node);
  const flagged = flaggedOf(node);
  const excluded = new Set(overrides.excluded);
  const overlay = useRef<HTMLDivElement>(null);
  const drag = useRef<
    | { kind: "corner"; index: number }
    | { kind: "patch"; index: number; moved: boolean }
    | { kind: "rim"; index: number }
    | null
  >(null);
  // The rim drag in progress (the patch it started on), in state rather
  // than the ref because the readout has to re-render with the value.
  const [rimDrag, setRimDrag] = useState<number | null>(null);
  const [dims, setDims] = useState<[number, number]>([0, 0]);
  useLayoutEffect(() => {
    const el = overlay.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    setDims((d) => (Math.abs(r.width - d[0]) > 0.5 || Math.abs(r.height - d[1]) > 0.5 ? [r.width, r.height] : d));
  });
  const auto = useAutoLineColor(previewUrl);
  const line = resolveLineColor(state.lineColor, auto);
  const ink = (alpha: number) => lineColorCss(line.hue, line.luma, line.sat, alpha);
  // Every line the tool draws takes the shared line thickness: the
  // preference, or this photograph's own where the row set one. The
  // corner handles scale with it so a thick line still has a handle
  // that reads as a handle.
  const lw = shapeLineWidth(state);
  const handle = 8 + 2 * lw;

  const writeQuad = (q: Quad) =>
    dispatch({ type: "set_text_param", id: node.id, param: "quad", value: JSON.stringify(q) });
  const writePatches = (p: PatchOverrides) =>
    dispatch({ type: "set_text_param", id: node.id, param: "patches", value: JSON.stringify(p) });

  // The drag in hand's own move, release and loss. A drag lost to a
  // window blur or an unmount (the 26.4.3 full review's R6) ends its
  // gesture and stops following, where it used to hold both; a patch
  // drag cut short toggles nothing.
  const dragHandlers = useRef<{ move: (ev: PointerEvent) => void; up: () => void; lost: () => void } | null>(null);
  const followed = useDragFollow<PointerEvent>(
    {
      move: (ev) => dragHandlers.current?.move(ev),
      up: () => dragHandlers.current?.up(),
      lost: () => dragHandlers.current?.lost(),
    },
    "pointer",
  );

  const beginCorner = (e: React.PointerEvent, index: number) => {
    if (!isPrimaryPress(e)) return;
    e.stopPropagation();
    e.preventDefault();
    const el = overlay.current;
    if (!el) return;
    dispatch({ type: "begin_gesture", key: `${node.id}.quad` });
    drag.current = { kind: "corner", index };
    const move = (ev: PointerEvent) => {
      const d = drag.current;
      if (!d || d.kind !== "corner") return;
      const [nx, ny] = norm(ev, el);
      const q = quadOf(node).map((p, i) => (i === d.index ? ([nx, ny] as Pt) : p)) as Quad;
      writeQuad(q);
    };
    const up = () => {
      drag.current = null;
      dragHandlers.current = null;
      dispatch({ type: "end_gesture" });
    };
    dragHandlers.current = { move, up, lost: up };
    followed.start();
  };

  const beginPatch = (e: React.PointerEvent, index: number) => {
    if (!isPrimaryPress(e)) return;
    e.stopPropagation();
    e.preventDefault();
    const el = overlay.current;
    if (!el) return;
    const startX = e.clientX;
    const startY = e.clientY;
    drag.current = { kind: "patch", index, moved: false };
    let gestured = false;
    const move = (ev: PointerEvent) => {
      const d = drag.current;
      if (!d || d.kind !== "patch") return;
      // A click that traveled is a nudge, not a toggle, judged in
      // client pixels so it means the same at any zoom. The gesture
      // starts on the first move past the threshold so a plain click
      // stays one undo step of its own.
      if (!d.moved && Math.hypot(ev.clientX - startX, ev.clientY - startY) < 4) return;
      if (!gestured) {
        dispatch({ type: "begin_gesture", key: `${node.id}.patches` });
        gestured = true;
      }
      d.moved = true;
      const [nx, ny] = norm(ev, el);
      const cur = patchesOf(node);
      writePatches({ ...cur, nudged: { ...cur.nudged, [d.index]: [nx, ny] } });
    };
    const up = () => {
      const d = drag.current;
      drag.current = null;
      dragHandlers.current = null;
      if (gestured) dispatch({ type: "end_gesture" });
      if (d && d.kind === "patch" && !d.moved) {
        const cur = patchesOf(node);
        const ex = cur.excluded.includes(d.index)
          ? cur.excluded.filter((i) => i !== d.index)
          : [...cur.excluded, d.index];
        writePatches({ ...cur, excluded: ex });
      }
    };
    const lost = () => {
      drag.current = null;
      dragHandlers.current = null;
      if (gestured) dispatch({ type: "end_gesture" });
    };
    dragHandlers.current = { move, up, lost };
    followed.start();
  };

  // Chart-space (unit square, u across columns, v down rows) onto the
  // quad and back. A degenerate quad has no map; the outline still draws
  // so the corner being dragged can be pulled back out of the fold.
  const h = solveHomography(
    [
      [0, 0],
      [1, 0],
      [1, 1],
      [0, 1],
    ],
    quad,
  );
  const hBack = solveHomography(quad, [
    [0, 0],
    [1, 0],
    [1, 1],
    [0, 1],
  ]);
  // The circle is defined in chart space, the same region the sampler
  // averages: a nudged center inverse-maps, exactly as the sampler's
  // does, so one distance test serves both ends.
  const chartCentre = (i: number): Pt | null => {
    if (!chart) return null;
    if (overrides.nudged[i]) return hBack ? mapPoint(hBack, overrides.nudged[i]) : null;
    const c = i % chart.cols;
    const r = Math.floor(i / chart.cols);
    return [(c + 0.5) / chart.cols, (r + 0.5) / chart.rows];
  };
  const centre = (i: number): Pt | null => {
    const cc = chartCentre(i);
    return cc && h ? mapPoint(h, cc) : null;
  };
  // The cell size on screen, from the quad's average edge lengths, for
  // the rim drag's distance math.
  const quadW = dims[0] * (Math.hypot(quad[1][0] - quad[0][0], quad[1][1] - quad[0][1]) + Math.hypot(quad[2][0] - quad[3][0], quad[2][1] - quad[3][1])) / 2;
  const quadH = dims[1] * (Math.hypot(quad[3][0] - quad[0][0], quad[3][1] - quad[0][1]) + Math.hypot(quad[2][0] - quad[1][0], quad[2][1] - quad[1][1])) / 2;
  const sample = sampleOf(node);
  // The circle's semi-axes in chart space: sample is the diameter as a
  // percent of the cell. Drawn through the quad, so under perspective it
  // becomes an ellipse, the region the sampler samples.
  const au = chart ? sample / 200 / chart.cols : 0;
  const av = chart ? sample / 200 / chart.rows : 0;
  // Fraction coordinates inside the svg's 0..1 viewBox: the ellipse
  // needs no pixel measurements, and non-scaling-stroke keeps the ink
  // honest under the anisotropic stretch.
  const ellipsePath = (cc: Pt): string => {
    let d = "";
    for (let k = 0; k <= 28; k++) {
      const t = (k / 28) * Math.PI * 2;
      const q = mapPoint(h!, [cc[0] + au * Math.cos(t), cc[1] + av * Math.sin(t)]);
      d += `${k === 0 ? "M" : "L"}${q[0].toFixed(4)},${q[1].toFixed(4)}`;
    }
    return d + " Z";
  };

  // A rim drag scales every circle together, since a chart's patches are
  // uniform: the pointer's distance from the center IS the new diameter,
  // written as the sample param with the number shown while dragging.
  const beginRim = (e: React.PointerEvent, index: number) => {
    if (!isPrimaryPress(e)) return;
    e.stopPropagation();
    e.preventDefault();
    const el = overlay.current;
    if (!el || !chart || !h || !dims[0]) return;
    const c = centre(index);
    const cellPx = Math.min(quadW / chart.cols, quadH / chart.rows);
    if (!c || !cellPx) return;
    dispatch({ type: "begin_gesture", key: `${node.id}.sample` });
    drag.current = { kind: "rim", index };
    setRimDrag(index);
    const move = (ev: PointerEvent) => {
      const d = drag.current;
      if (!d || d.kind !== "rim") return;
      const [nx, ny] = norm(ev, el);
      const dist = Math.hypot((nx - c[0]) * dims[0], (ny - c[1]) * dims[1]);
      dispatch({
        type: "set_param",
        id: node.id,
        param: "sample",
        value: Math.min(90, Math.max(10, Math.round((dist / cellPx) * 200))),
      });
    };
    const up = () => {
      drag.current = null;
      setRimDrag(null);
      dispatch({ type: "end_gesture" });
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  const pct = (p: Pt): [string, string] => [`${p[0] * 100}%`, `${p[1] * 100}%`];

  return (
    <div ref={overlay} data-testid="chart-tool-overlay" style={{ position: "absolute", inset: 0, pointerEvents: "none" }}>
      <ChartLoadError error={chartsError} retry={retryCharts} />
      <svg
        width="100%"
        height="100%"
        viewBox="0 0 1 1"
        preserveAspectRatio="none"
        style={{ position: "absolute", inset: 0, overflow: "visible" }}
        aria-hidden="true"
      >
        <polygon
          data-testid="chart-quad-outline"
          points={quad.map((p) => pct(p).join(",")).join(" ")}
          fill="none"
          stroke={ink(0.85)}
          strokeWidth={lw}
          vectorEffect="non-scaling-stroke"
        />
        {h &&
          chart &&
          Array.from({ length: chart.cols - 1 }, (_, k) => {
            const u = (k + 1) / chart.cols;
            const [x1, y1] = pct(mapPoint(h, [u, 0]));
            const [x2, y2] = pct(mapPoint(h, [u, 1]));
            return <line key={`v${k}`} x1={x1} y1={y1} x2={x2} y2={y2} stroke={ink(0.4)} strokeWidth={Math.max(1, lw * 0.66)} vectorEffect="non-scaling-stroke" />;
          })}
        {h &&
          chart &&
          Array.from({ length: chart.rows - 1 }, (_, k) => {
            const v = (k + 1) / chart.rows;
            const [x1, y1] = pct(mapPoint(h, [0, v]));
            const [x2, y2] = pct(mapPoint(h, [1, v]));
            return <line key={`h${k}`} x1={x1} y1={y1} x2={x2} y2={y2} stroke={ink(0.4)} strokeWidth={Math.max(1, lw * 0.66)} vectorEffect="non-scaling-stroke" />;
          })}
        {chart &&
          h &&
          chart.patches.map((p, i) => {
            const cc = chartCentre(i);
            if (!cc) return null;
            const isExcluded = excluded.has(i);
            const isFlagged = flagged.has(i);
            const [r, g, b] = p.rgb;
            const untargeted = p.target === false;
            const d = ellipsePath(cc);
            return (
              <g key={i}>
                <path
                  data-testid={`chart-patch-${i}`}
                  d={d}
                  onPointerDown={(e) => beginPatch(e, i)}
                  // A control with no target draws hollow: there is no
                  // reference color to tint it with.
                  fill={untargeted ? "none" : `rgb(${Math.round(r * 255)}, ${Math.round(g * 255)}, ${Math.round(b * 255)})`}
                  fillOpacity={isExcluded ? 0.25 : untargeted ? 0.35 : 0.45}
                  stroke={ink(0.9)}
                  strokeWidth={lw}
                  strokeDasharray={isFlagged || untargeted ? "4 3" : undefined}
                  vectorEffect="non-scaling-stroke"
                  style={{ cursor: "pointer", pointerEvents: "auto" }}
                >
                  <title>{`${p.name}${untargeted ? " (no target: ignored by the fit)" : ""}${isExcluded ? " (excluded from the fit)" : ""}${isFlagged ? " (flagged: clipped or glare)" : ""}`}</title>
                </path>
                {/* The rim is its own hit area: a fat invisible stroke
                    over the circle's edge, so a grab there sizes the
                    samples and a grab inside still moves or excludes the
                    patch. */}
                <path
                  data-testid={`chart-rim-${i}`}
                  d={d}
                  fill="none"
                  stroke="rgba(0,0,0,0)"
                  strokeWidth={9}
                  vectorEffect="non-scaling-stroke"
                  onPointerDown={(e) => beginRim(e, i)}
                  style={{ cursor: "nwse-resize", pointerEvents: "stroke" }}
                >
                  <title>Sample size: drag to size every circle together</title>
                </path>
              </g>
            );
          })}
      </svg>
      {rimDrag !== null &&
        (() => {
          const c = centre(rimDrag);
          if (!c) return null;
          return (
            <div
              data-testid="chart-sample-readout"
              className="help"
              style={{
                position: "absolute",
                left: `${c[0] * 100}%`,
                top: `${c[1] * 100}%`,
                transform: "translate(-50%, -150%)",
                color: ink(1),
                textShadow: "0 0 3px rgba(0,0,0,0.8)",
                pointerEvents: "none",
              }}
            >
              {Math.round(sample)}%
            </div>
          );
        })()}
      {quad.map((p, i) => (
        <div
          key={i}
          data-testid={`chart-corner-${i}`}
          title="Chart corner: drag onto the chart's corner"
          onPointerDown={(e) => beginCorner(e, i)}
          style={{
            position: "absolute",
            left: `${p[0] * 100}%`,
            top: `${p[1] * 100}%`,
            width: handle,
            height: handle,
            marginLeft: -handle / 2,
            marginTop: -handle / 2,
            cursor: "grab",
            pointerEvents: "auto",
            borderRadius: 2,
            transform: "rotate(45deg)",
            background: ink(0.9),
            border: "1px solid rgba(0, 0, 0, 0.55)",
          }}
        />
      ))}
    </div>
  );
}

/** One swatch of a patch row: the measured color before, the corrected
 * color after, both sRGB-encoded by the desktop. */
function Swatch({ rgb, title }: { rgb: [number, number, number]; title: string }) {
  const [r, g, b] = rgb.map((v) => Math.round(Math.max(0, Math.min(1, v)) * 255));
  return (
    <span
      title={title}
      style={{
        display: "inline-block",
        width: 10,
        height: 10,
        borderRadius: 2,
        background: `rgb(${r}, ${g}, ${b})`,
        border: "1px solid var(--line-4)",
      }}
    />
  );
}

/** The panel report after a Calibrate: the mean and the worst patches
 * first, a before/after swatch pair per patch, the illuminant guess,
 * and the provenance (which camera, when). Flagged patches say why. */
function CalibrationReport({ report }: { report: StoredFit }) {
  const shown = report.patches.slice(0, 8);
  const rest = report.patches.length - shown.length;
  return (
    <div data-testid="colorchecker-report" style={{ display: "flex", flexDirection: "column", gap: 2 }}>
      <div className="help" style={{ color: "var(--text-body)" }}>
        {report.mean_de === 0 && report.fitted === 0
          ? report.note
          : `Mean dE ${report.mean_de.toFixed(1)} over ${report.fitted} patches · ${report.illuminant} light`}
      </div>
      {report.note && report.fitted > 0 && (
        <div className="help" style={{ color: "var(--text-faint)" }}>{report.note}</div>
      )}
      {shown.map((p) => (
        <div
          key={p.index}
          data-testid={`colorchecker-residual-${p.index}`}
          className="help" style={{ display: "flex", gap: 6, alignItems: "center", color: "var(--text-body)" }}
        >
          <Swatch rgb={p.before} title={`${p.name} as shot`} />
          <Swatch rgb={p.after} title={`${p.name} corrected`} />
          <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {p.name}
          </span>
          <span style={{ color: "var(--text-faint)" }}>
            {p.flag ? p.flag : `dE ${p.de!.toFixed(1)}`}
          </span>
        </div>
      ))}
      {rest > 0 && (
        <div className="help" style={{ color: "var(--text-faint)" }}>and {rest} more, all closer</div>
      )}
      <div data-testid="colorchecker-provenance" className="help" style={{ color: "var(--text-faint)" }}>
        {report.name
          ? `${report.name}${report.camera ? ` (fitted on ${report.camera})` : ""}`
          : report.camera
            ? `Fitted on ${report.camera}`
            : "Fitted on this photograph"}
        {` · ${report.when.slice(0, 10)}`}
      </div>
    </div>
  );
}
