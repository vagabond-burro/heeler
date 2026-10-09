// A Color Checker fit saved before 2026-09-20 in "To node" mode was
// solved for white balance BEFORE the matrix while the graph applied
// it after (the Color Checker sits before Standard Color). The fix
// changed what a new fit writes; this is what an old one becomes on
// load. The correction is exact: for a diagonal white balance D the
// matrix the graph needs is D^-1 M D, so the picture becomes what the
// calibration measured, without the chart in the frame again. A fit
// stamped with FIT_ORDER already says the graph's order; "In matrix"
// fits carry their balance inside the matrix and never needed this.
import { wbGains } from "./whitebalance";

export const FIT_ORDER = "checker_then_wb";

export interface FitOrderFields {
  temperature: number;
  tint: number;
  matrix?: number[];
  set_wb?: boolean;
  order?: string;
}

/** Whether a stored fit predates the order fix and needs its matrix
 * re-expressed for the graph's order. */
export function fitNeedsOrderFix(fit: FitOrderFields | null | undefined): fit is FitOrderFields {
  return !!fit && fit.set_wb === true && fit.order !== FIT_ORDER;
}

/** D^-1 M D for the fit's own temperature and tint, row-major. */
export function reorderMatrix(matrix: number[], temperature: number, tint: number): number[] {
  const d = wbGains(temperature, tint);
  return matrix.map((v, i) => (v * d[i % 3]) / d[Math.floor(i / 3)]);
}

/** The node's matrix and its stored report, converted together and the
 * report stamped, or both as they were when nothing is owed. */
export function convertLegacyFit<F extends FitOrderFields>(matrix: number[], fit: F): { matrix: number[]; fit: F } {
  if (!fitNeedsOrderFix(fit)) return { matrix, fit };
  const next = reorderMatrix(matrix, fit.temperature, fit.tint);
  return { matrix: next, fit: { ...fit, matrix: next, order: FIT_ORDER } };
}
