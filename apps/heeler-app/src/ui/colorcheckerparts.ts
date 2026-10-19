// colorchecker.tsx's values and helpers that are not components, kept apart so
// colorchecker.tsx exports components alone and Vite can refresh it in place as
// it is edited instead of reloading the window.
import { PRESET_SCHEMA, type NodeCard, type PresetFile } from "../state";
import { type PatchReport } from "../bridge";
import { type Pt, type Quad } from "../quadmap";

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
