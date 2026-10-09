import { describe, expect, it } from "vitest";
import { CATEGORY_ORDER, NODE_CATALOG, byCategory, makeNode, searchNodes, specFor } from "../nodes";
import type { NodeCard } from "../state";
import { paletteItems, clampRecents, RECENTS_MIN, RECENTS_MAX } from "../ui/nodepalette";

describe("the node catalog", () => {
  it("has no duplicates and every entry is complete", () => {
    const types = NODE_CATALOG.map((n) => n.type);
    expect(new Set(types).size).toBe(types.length);
    for (const n of NODE_CATALOG) {
      expect(n.type.startsWith("heeler.")).toBe(true);
      expect(n.name.length).toBeGreaterThan(0);
      expect(n.blurb.length).toBeGreaterThan(0);
      expect(CATEGORY_ORDER).toContain(n.cat);
    }
  });

  it("groups by category in a sensible order and loses nothing", () => {
    const groups = byCategory();
    expect(groups.map((g) => g.cat)).toEqual(CATEGORY_ORDER.filter((c) =>
      NODE_CATALOG.some((n) => n.cat === c)
    ));
    const flattened = groups.flatMap((g) => g.nodes);
    expect(flattened).toHaveLength(NODE_CATALOG.length);
  });

  /// A node added with no params renders on the engine's own defaults,
  /// which is the entire reason the catalog does not carry a second copy
  /// of every default value.
  it("makes a node with no params at all", () => {
    const spec = specFor("heeler.grain")!;
    const node = makeNode(spec, "grain_1", 40, 60);
    expect(node.params).toEqual({});
    expect(node).toMatchObject({ id: "grain_1", type: "heeler.grain", x: 40, y: 60, enabled: true });
  });

  /// A two-image node placed by hand needs somewhere to put the second
  /// image. The flag used to be set only by the demo graph and the layer
  /// builder, so a Merge dragged out of the palette had one port and
  /// quietly ignored anything aimed at its lower half.
  it("draws a second input on the nodes that take two images", () => {
    for (const type of ["heeler.merge", "heeler.blend", "heeler.luma_chroma_join", "heeler.conditional"]) {
      expect(makeNode(specFor(type)!, "a", 0, 0).hasIn2).toBe(true);
    }
    expect(makeNode(specFor("heeler.luma_chroma_split")!, "b", 0, 0).hasIn2).toBe(false);
  });

  /// The logic family's ports: measure/compare/logic/math/remap produce
  /// masks or fields (their out dot drags mask pipes), logic and math
  /// take a second operand (a lower-half input), and the conditional
  /// draws the condition port that carries its if.
  it("draws the logic family's ports", () => {
    for (const type of ["heeler.measure", "heeler.compare", "heeler.logic", "heeler.math", "heeler.remap"]) {
      expect(makeNode(specFor(type)!, "a", 0, 0).maskOut).toBe(true);
    }
    for (const type of ["heeler.logic", "heeler.math"]) {
      expect(makeNode(specFor(type)!, "b", 0, 0).hasIn2).toBe(true);
    }
    const cond = makeNode(specFor("heeler.conditional")!, "c", 0, 0);
    expect(cond.maskIn).toBe(true);
    expect(cond.maskOut).toBe(false);
  });

  /// New cards are the easy half. A Merge somebody placed by hand before
  /// the flag existed was saved without it, and would keep showing one
  /// port and keep swallowing the second wire forever.
  it("heals a saved card that predates the second port", async () => {
    const { migrateNodes } = await import("../state");
    const saved = [
      { id: "m", type: "heeler.merge", name: "Merge", cat: "utility", x: 0, y: 0, enabled: true, params: {}, hasIn: true, hasOut: true },
      { id: "b", type: "heeler.blur", name: "Blur", cat: "detail", x: 0, y: 0, enabled: true, params: {}, hasIn: true, hasOut: true, maskIn: true },
    ] as NodeCard[];
    const healed = migrateNodes(saved);
    expect(healed[0].hasIn2).toBe(true);
    // And a one-image node is not given a port it has nowhere to put.
    // Left untouched rather than written to false: a migration that
    // rewrites every card it looks at makes needless work for everything
    // downstream that compares them.
    expect(healed[1].hasIn2).toBeFalsy();
    expect(healed[1]).toBe(saved[1]);
  });

  it("wires the ends of the chain correctly", () => {
    // A source takes nothing in; the output gives nothing out.
    expect(makeNode(specFor("heeler.image_source")!, "a", 0, 0).hasIn).toBe(false);
    expect(makeNode(specFor("heeler.output")!, "b", 0, 0).hasOut).toBe(false);
    // A mask produces a mask rather than an image.
    expect(makeNode(specFor("heeler.radial_mask")!, "c", 0, 0).maskOut).toBe(true);
    // And a color node accepts one.
    expect(makeNode(specFor("heeler.curves")!, "d", 0, 0).maskIn).toBe(true);
  });
});

describe("palette search", () => {
  it("puts an exact prefix first", () => {
    expect(searchNodes("gra")[0].type).toBe("heeler.grain");
    expect(searchNodes("curv")[0].type).toBe("heeler.curves");
  });

  /// Nobody types the spaces, so "cbal" has to find Color Balance.
  it("matches initials and skipped letters", () => {
    expect(searchNodes("cbal").map((s) => s.type)).toContain("heeler.color_balance");
    expect(searchNodes("bw").map((s) => s.type)).toContain("heeler.black_white");
  });

  it("falls back to what a node is for", () => {
    // "vignette" is nobody's node name, but it is what someone means.
    expect(searchNodes("noise").map((s) => s.type)).toContain("heeler.denoise");
    // The luma/color pair is reached the same way: nobody hunting for
    // color noise knows to look for the word "luma".
    expect(searchNodes("noise").map((s) => s.type)).toContain("heeler.luma_chroma_split");
    expect(searchNodes("straighten").map((s) => s.type)).toContain("heeler.crop_rotate");
  });

  it("finds nothing rather than everything for nonsense", () => {
    expect(searchNodes("zzzz")).toEqual([]);
    expect(searchNodes("   ")).toEqual([]);
  });
});

describe("the palette shortlist", () => {
  it("shows what was used most recently, most recent first", () => {
    const items = paletteItems("", ["heeler.grain", "heeler.curves"], 10);
    expect(items[0].type).toBe("heeler.grain");
    expect(items[1].type).toBe("heeler.curves");
  });

  /// An empty palette on first use looks broken, so it fills out from
  /// the catalog until there is a history to show.
  it("is never empty, even with no history", () => {
    const items = paletteItems("", [], 10);
    expect(items).toHaveLength(10);
  });

  it("honors the limit and does not repeat a recent node", () => {
    const items = paletteItems("", ["heeler.grain"], 6);
    expect(items).toHaveLength(6);
    expect(items.filter((i) => i.type === "heeler.grain")).toHaveLength(1);
  });

  it("searching ignores the shortlist entirely", () => {
    const items = paletteItems("levels", ["heeler.grain"], 10);
    expect(items[0].type).toBe("heeler.levels");
  });

  /// The owner asked for 5 to 20. A preference that silently accepts 0
  /// or 500 is a preference that can break the palette.
  it("clamps the shortlist size to what was asked for", () => {
    expect(clampRecents(10)).toBe(10);
    expect(clampRecents(1)).toBe(RECENTS_MIN);
    expect(clampRecents(500)).toBe(RECENTS_MAX);
    expect(clampRecents(NaN)).toBeGreaterThanOrEqual(RECENTS_MIN);
    expect(clampRecents(7.6)).toBe(8);
  });
});

describe("the node menus read alphabetically", () => {
  it("every category's list is sorted by name, case aside", () => {
    for (const group of byCategory()) {
      const names = group.nodes.map((n) => n.name);
      const sorted = [...names].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }));
      expect(names, group.label).toEqual(sorted);
    }
  });
});
