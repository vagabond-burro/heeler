// The Color Checker section (26.3 Phase 11): a color grader's Color
// Match. The node corrects the camera before anything creative, so its
// seat is after the warps and the depth map, before Color; the section
// is on-demand and pro, and the node ships as a bit-exact passthrough
// until a fit lands.

import { describe, expect, it } from "vitest";
import { initialState, NEUTRAL_NODES, NEUTRAL_WIRES } from "../data";
import { NODE_CATALOG } from "../nodes";
import { CATEGORY_PIECES, CHAIN_ORDER } from "../recipes";
import {
  NEUTRAL_PARAMS,
  PARAM_TEXT_DEFAULT,
  reduce,
  type Command,
  type State
} from "../state";
import { SECTIONS } from "../ui/simple";

const run = (s: State, ...cmds: Command[]) => cmds.reduce(reduce, s);

describe("the Color Checker's place", () => {
  it("sits after the depth map and before Color in the chain", () => {
    expect(CHAIN_ORDER.indexOf("colorchecker")).toBe(CHAIN_ORDER.indexOf("depthmap") + 1);
    expect(CHAIN_ORDER.indexOf("colorchecker")).toBe(CHAIN_ORDER.indexOf("stdcolor") - 1);
    expect(CHAIN_ORDER.indexOf("colorchecker")).toBeGreaterThan(CHAIN_ORDER.indexOf("lens"));
    expect(CHAIN_ORDER.indexOf("colorchecker")).toBeGreaterThan(CHAIN_ORDER.indexOf("gridwarp"));
    expect(CHAIN_ORDER.indexOf("colorchecker")).toBeGreaterThan(CHAIN_ORDER.indexOf("shapewarp"));
  });

  it("is an on-demand section below Lens in the panel", () => {
    const titles = SECTIONS.map((s) => s.title);
    expect(titles.indexOf("Color Checker")).toBe(titles.indexOf("Lens") + 1);
    const sec = SECTIONS.find((s) => s.title === "Color Checker")!;
    expect(sec.rows.map((r) => r.param)).toEqual(["amount", "sample"]);
    expect(CATEGORY_PIECES["Color Checker"].map((p) => p.type)).toEqual(["heeler.color_checker"]);
    expect(CATEGORY_PIECES["Color Checker"][0].id).toBe("colorchecker");
  });

  it("is in the node palette under Source", () => {
    const entry = NODE_CATALOG.find((n) => n.type === "heeler.color_checker");
    expect(entry?.name).toBe("Color Checker");
    expect(entry?.cat).toBe("source");
  });

  it("ships the unit matrix at full amount, a bit-exact passthrough", () => {
    expect(NEUTRAL_PARAMS["heeler.color_checker"]).toEqual({
      m00: 1,
      m01: 0,
      m02: 0,
      m10: 0,
      m11: 1,
      m12: 0,
      m20: 0,
      m21: 0,
      m22: 1,
      exposure: 0,
      amount: 100,
      sample: 40,
    });
    expect(PARAM_TEXT_DEFAULT["heeler.color_checker"].chart).toBe("colorchecker-classic");
  });
});

describe("the Color Checker's birth", () => {
  it("switches on into its seat, neutral, and switches off keeping its numbers", () => {
    const fresh0 = {
      ...initialState(),
      nodes: structuredClone(NEUTRAL_NODES),
      wires: structuredClone(NEUTRAL_WIRES),
    };
    expect(fresh0.nodes.some((n) => n.type === "heeler.color_checker")).toBe(false);
    let s = run(fresh0, { type: "set_category", title: "Color Checker", on: true });
    const node = s.nodes.find((n) => n.type === "heeler.color_checker")!;
    expect(node.id).toBe("colorchecker");
    expect(node.enabled).toBe(true);
    expect(node.params).toMatchObject({ m00: 1, m11: 1, m22: 1, exposure: 0, amount: 100 });
    // The seat: whatever fed Standard Color feeds the checker, and the
    // checker feeds Standard Color.
    expect(s.wires.some((w) => w.from === "colorchecker" && w.to === "stdcolor")).toBe(true);
    expect(s.wires.some((w) => w.to === "colorchecker" && w.kind === "image")).toBe(true);
    s = run(s, { type: "set_category", title: "Color Checker", on: false });
    expect(s.nodes.find((n) => n.id === "colorchecker")!.enabled).toBe(false);
  });
});
