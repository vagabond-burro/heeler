// A Color Checker fit from before the order fix (2026-09-20) is re-
// expressed for the graph's order on load, exactly; a wire that does
// not say which output of a two-output node it takes is marked.
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { initialState, NEUTRAL_NODES, NEUTRAL_WIRES } from "../data";
import { reduce, wireLacksPort, type Command, type State, type Wire } from "../state";
import { makeNode, specFor } from "../nodes";
import { NodeEditor } from "../ui/graph";
import { wbGains } from "../whitebalance";
import { FIT_ORDER, convertLegacyFit, fitNeedsOrderFix, reorderMatrix, type FitOrderFields } from "../checkerfit";

const run = (s: State, ...cmds: Command[]) => cmds.reduce(reduce, s);
const OLD = [1.05, -0.08, 0.03, 0.02, 1.0, -0.02, -0.05, 0.04, 1.01];
const legacyFit = (set_wb: boolean): FitOrderFields & { exposure: number; wb_in_matrix: boolean } => ({ temperature: 3800, tint: 8, exposure: 0.2, matrix: OLD, set_wb, wb_in_matrix: !set_wb });

describe("the fit order correction", () => {
  it("is exact: white balance after the new matrix equals the old matrix after white balance", () => {
    const d = wbGains(3800, 8);
    const next = reorderMatrix(OLD, 3800, 8);
    const apply = (m: number[], v: number[]) => [0, 1, 2].map((r) => m[r * 3] * v[0] + m[r * 3 + 1] * v[1] + m[r * 3 + 2] * v[2]);
    for (const raw of [[0.2, 0.4, 0.1], [0.9, 0.05, 0.3], [0.5, 0.5, 0.5]]) {
      const intended = apply(OLD, raw.map((v, c) => v * d[c]));
      const rendered = apply(next, raw).map((v, c) => v * d[c]);
      for (let c = 0; c < 3; c++) expect(rendered[c]).toBeCloseTo(intended[c], 9);
    }
    // A neutral balance changes nothing.
    expect(reorderMatrix(OLD, 6500, 0).map((v) => +v.toFixed(9))).toEqual(OLD.map((v) => +v.toFixed(9)));
  });

  it("owes a conversion only to an unstamped To node fit, and stamps what it converts", () => {
    expect(fitNeedsOrderFix(legacyFit(true))).toBe(true);
    expect(fitNeedsOrderFix(legacyFit(false))).toBe(false);
    expect(fitNeedsOrderFix({ ...legacyFit(true), order: FIT_ORDER })).toBe(false);
    expect(fitNeedsOrderFix(null)).toBe(false);
    const done = convertLegacyFit(OLD, legacyFit(true));
    expect(done.fit.order).toBe(FIT_ORDER);
    expect(done.fit.matrix).toEqual(done.matrix);
    expect(done.matrix).not.toEqual(OLD);
    const kept = convertLegacyFit(OLD, legacyFit(false));
    expect(kept.matrix).toBe(OLD);
  });

  it("converts a saved graph's node on load and leaves a stamped or In matrix one alone", () => {
    const base = initialState();
    const keys = ["m00", "m01", "m02", "m10", "m11", "m12", "m20", "m21", "m22"];
    const withFit = (fit: object) => ({
      ...base,
      nodes: base.nodes.map((n) =>
        n.type === "heeler.color_checker"
          ? { ...n, enabled: true, params: { ...n.params, ...Object.fromEntries(keys.map((k, i) => [k, OLD[i]])) }, textParams: { ...n.textParams, fit: JSON.stringify(fit) } }
          : n,
      ),
    });
    expect(base.nodes.some((n) => n.type === "heeler.color_checker")).toBe(true);
    const legacy = run(withFit(legacyFit(true)), { type: "convert_legacy_fits" });
    const node = legacy.nodes.find((n) => n.type === "heeler.color_checker")!;
    const expected = reorderMatrix(OLD, 3800, 8);
    keys.forEach((k, i) => expect(node.params[k]).toBeCloseTo(expected[i], 12));
    const report = JSON.parse(node.textParams!.fit);
    expect(report.order).toBe(FIT_ORDER);
    expect(report.matrix).toEqual(expected);
    // Once: a second pass is a no-op, by identity.
    expect(run(legacy, { type: "convert_legacy_fits" })).toBe(legacy);
    // In matrix fits and stamped fits are not touched.
    const inMatrix = withFit(legacyFit(false));
    expect(run(inMatrix, { type: "convert_legacy_fits" })).toBe(inMatrix);
    const stamped = withFit({ ...legacyFit(true), order: FIT_ORDER });
    expect(run(stamped, { type: "convert_legacy_fits" })).toBe(stamped);
  });
});

describe("a wire with no port from a two-output node", () => {
  it("is the mask-kind wire from Depth Map or File with nothing recorded, and nothing else", () => {
    const w = (extra: Partial<Wire>): Wire => ({ from: "dm", to: "exposure", toPort: "mask", kind: "mask", ...extra });
    expect(wireLacksPort(w({}), { type: "heeler.depth_map" })).toBe(true);
    expect(wireLacksPort(w({}), { type: "heeler.file" })).toBe(true);
    expect(wireLacksPort(w({ fromPort: "depth" }), { type: "heeler.depth_map" })).toBe(false);
    expect(wireLacksPort(w({ kind: "image", toPort: "in" }), { type: "heeler.depth_map" })).toBe(false);
    expect(wireLacksPort(w({}), { type: "heeler.exposure" })).toBe(false);
    expect(wireLacksPort(w({}), undefined)).toBe(false);
  });

  it("is drawn marked in the graph, and says so in its hint", () => {
    const s0 = initialState();
    const dm = makeNode(specFor("heeler.depth_map")!, "dm", 500, 300);
    const s: State = {
      ...s0,
      nodes: [...structuredClone(NEUTRAL_NODES).filter((n) => n.id !== "dm"), dm],
      wires: [...structuredClone(NEUTRAL_WIRES), { from: "dm", to: "exposure", toPort: "mask", kind: "mask" }],
    };
    render(<NodeEditor state={s} dispatch={() => {}} />);
    expect(screen.getByTestId("wire-unnamed-dm-exposure")).toBeInTheDocument();
    expect(screen.getByTestId("wire-hit-dm-exposure-mask").getAttribute("data-hint")).toMatch(/does not say which output/);
    // The same wire with its port named is an ordinary wire.
    const named: State = { ...s, wires: s.wires.map((w) => (w.from === "dm" ? { ...w, fromPort: "depth" as const } : w)) };
    render(<NodeEditor state={named} dispatch={() => {}} />);
    expect(screen.queryAllByTestId("wire-unnamed-dm-exposure")).toHaveLength(1);
  });
});
