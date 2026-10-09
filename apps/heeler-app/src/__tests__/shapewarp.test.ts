import { describe, expect, it } from "vitest";
import {
  composeShapeGesture,
  newShape,
  parseShapes,
  restShape,
  serializeShapes,
  shapeAt,
  shapeDistance,
  shapeFrom,
  shapeHolds,
  shapeMoves,
  shapeTransformed,
  shapeWeight,
  shapesDisplacement,
  shapesForward,
  shapesIdentity,
} from "../shapewarp";

describe("shape warp's shapes", () => {
  it("read their JSON the way the engine does, and write it back rounded", () => {
    const list = parseShapes('[{"cx":0.2,"dx":0.1,"name":"Eye"},{"enabled":false},{"radius":"no"},7,null]');
    expect(list).toHaveLength(3);
    expect(list[0]).toMatchObject({ id: "shape_1", name: "Eye", cx: 0.2, dx: 0.1, radius: 0.25, scaleY: 1 });
    expect(list[1].enabled).toBe(false);
    expect(list[2].radius).toBe(0.25);
    expect(parseShapes("junk")).toEqual([]);
    expect(parseShapes(undefined)).toEqual([]);
    // scale_y follows scale when absent, and an f32 overflow is refused.
    expect(shapeFrom({ scale: 2 }, "a").scaleY).toBe(2);
    expect(shapeFrom({ dx: 1e100 }, "a").dx).toBe(0);
    const back = JSON.parse(serializeShapes([{ ...list[0], dx: 0.123456789 }]));
    expect(back[0].dx).toBe(0.123457);
    expect(back[0].scale_y).toBe(1);
    // A fresh shape takes the next free number.
    const fresh = newShape(list);
    // Born unnamed: the row reads its outline and its place until
    // somebody types a name of their own.
    expect(fresh).toMatchObject({ id: "shape_4", name: "", cx: 0.5, cy: 0.5 });
    // Numbered past the list's length, skipping ids already taken.
    expect(newShape([{ ...fresh, id: "shape_2" }]).id).toBe("shape_3");
  });

  it("takes any of the Radial layer's outlines, with the engine's distance field", () => {
    // Parsed by name, junk to the ellipse; the knob under its own key.
    expect(shapeFrom({ shape: "cross", shape_amount: 0.2 }, "a")).toMatchObject({ shape: "cross", shapeAmount: 0.2, amount: 1 });
    expect(shapeFrom({ shape: "blob" }, "a").shape).toBe("ellipse");
    expect(shapeFrom({ shape_amount: 7 }, "a").shapeAmount).toBe(1);
    expect(JSON.parse(serializeShapes([shapeFrom({ shape: "trapeze", shape_amount: 0.3 }, "a")]))[0]).toMatchObject({ shape: "trapeze", shape_amount: 0.3 });
    // The field, term for term with ops_masks.rs: negative inside.
    expect(shapeDistance("ellipse", 0, 0, 0.5)).toBe(-1);
    expect(shapeDistance("rectangle", 0.95, 0.95, 0.5)).toBeLessThan(0);
    expect(shapeDistance("ellipse", 0.95, 0.95, 0.5)).toBeGreaterThan(0);
    expect(shapeDistance("cross", 0.9, 0, 0.5)).toBeLessThan(0);
    expect(shapeDistance("cross", 0.9, 0.9, 0.5)).toBeGreaterThan(0);
    expect(shapeDistance("crescent", -0.9, 0, 0.5)).toBeGreaterThan(0);
    expect(shapeDistance("crescent", 0.5, 0, 0.5)).toBeLessThan(0);
    expect(shapeDistance("semicircle", 0, 0.5, 0.5)).toBeLessThan(0);
    expect(shapeDistance("semicircle", 0, -0.5, 0.5)).toBeGreaterThan(0);
    expect(shapeDistance("triangle", 0, 0, 0.5)).toBeLessThan(0);
    expect(shapeDistance("trapeze", 0.9, -0.9, 1)).toBeGreaterThan(0);
    expect(shapeDistance("trapeze", 0.9, 0.9, 1)).toBeLessThan(0);
    // A square shape reaches its corner where the disc does not.
    const square = shapeFrom({ shape: "rectangle", cx: 0.5, cy: 0.5, radius: 0.2, feather: 0 }, "sq");
    expect(shapeWeight(square, 0.5 + 0.2 * 0.95, 0.5 + 0.2 * 0.95, 1)).toBe(1);
    expect(shapeWeight({ ...square, shape: "ellipse" }, 0.5 + 0.2 * 0.95, 0.5 + 0.2 * 0.95, 1)).toBe(0);
  });

  it("the falloff is the radial mask's: one inside, feathering to zero, round on a wide frame", () => {
    const s = shapeFrom({ cx: 0.5, cy: 0.5, radius: 0.2, feather: 0.5 }, "a");
    expect(shapeWeight(s, 0.5, 0.5, 1)).toBeCloseTo(1, 6);
    expect(shapeWeight(s, 0.95, 0.5, 1)).toBe(0);
    const mid = shapeWeight(s, 0.5 + 0.2 * 0.75, 0.5, 1);
    expect(mid).toBeGreaterThan(0.3);
    expect(mid).toBeLessThan(0.7);
    // On a 2:1 frame the shape is a circle in square space: a tenth
    // of the width right equals a fifth of the height down.
    expect(shapeWeight(s, 0.6, 0.5, 2)).toBeCloseTo(shapeWeight(s, 0.5, 0.7, 2), 6);
  });

  it("a twist is a turn on a wide frame, a pinch runs along the shape's own axes, and shapes share the pull", () => {
    const s = shapeFrom({ cx: 0.5, cy: 0.5, radius: 0.5, angle: 90 }, "a");
    const t = shapeTransformed(s, 0.6, 0.5, 2);
    expect(t[0]).toBeCloseTo(0.5, 5);
    expect(t[1]).toBeCloseTo(0.7, 5);
    // A pinch on a shape turned 90 degrees stretches along y.
    const p = shapeFrom({ cx: 0.5, cy: 0.5, radius: 0.5, rotation: 90, scale: 2 }, "a");
    const q = shapeTransformed(p, 0.5, 0.6, 1);
    expect(q[0]).toBeCloseTo(0.5, 5);
    expect(q[1]).toBeCloseTo(0.7, 5);
    // A pull, and over it a shape at rest: the shape at rest displaces
    // nothing, so it takes no part and the pull is itself.
    const pull = shapeFrom({ cx: 0.5, cy: 0.5, radius: 0.3, feather: 0, dx: 0.2 }, "pull");
    const still = shapeFrom({ cx: 0.5, cy: 0.5, radius: 0.3, feather: 0 }, "still");
    expect(shapesDisplacement([pull], 0.5, 0.5, 1)[0]).toBeCloseTo(0.2, 6);
    expect(shapesDisplacement([pull, still], 0.5, 0.5, 1)[0]).toBeCloseTo(0.2, 6);
    expect(shapesDisplacement([pull, still], 0.05, 0.05, 1)).toEqual([0, 0]);
    // A shape asked to hold keeps the picture where it reaches, and
    // the frontend's field says so exactly as the engine's does.
    const holder = shapeFrom({ cx: 0.5, cy: 0.5, radius: 0.3, feather: 0, hold: true }, "hold");
    expect(shapesDisplacement([pull, holder], 0.5, 0.5, 1)).toEqual([0, 0]);
    expect(shapeHolds(holder)).toBe(true);
    expect(shapeMoves({ ...holder, dx: 0.2 })).toBe(false);
    // Amount eases it; disabled removes it.
    expect(shapesDisplacement([{ ...pull, amount: 0.5 }], 0.5, 0.5, 1)[0]).toBeCloseTo(0.1, 6);
    expect(shapesDisplacement([{ ...pull, enabled: false }], 0.5, 0.5, 1)).toEqual([0, 0]);
    expect(shapesForward([pull], 1)(0.5, 0.5)[0]).toBeCloseTo(0.7, 6);
    expect(shapeMoves(still)).toBe(false);
    expect(shapesIdentity([still])).toBe(true);
    expect(shapesIdentity([pull])).toBe(false);
    expect(restShape(pull)).toMatchObject({ dx: 0, dy: 0, angle: 0, scale: 1, scaleY: 1, cx: 0.5, radius: 0.3 });
  });

  it("a gesture composes into the shape's warp, and the topmost shape under a point is found", () => {
    const s = shapeFrom({ dx: 0.1, angle: 10, scale: 2, scale_y: 1 }, "a");
    const g = composeShapeGesture(s, { dx: 0.05, dy: -0.05, angle: Math.PI / 2, scale: 0.5, scaleY: 3 });
    expect(g.dx).toBeCloseTo(0.15, 9);
    expect(g.dy).toBeCloseTo(-0.05, 9);
    expect(g.angle).toBeCloseTo(100, 6);
    expect(g.scale).toBeCloseTo(1, 9);
    expect(g.scaleY).toBeCloseTo(3, 9);
    const a = shapeFrom({ cx: 0.3, cy: 0.5, radius: 0.2, feather: 0 }, "a");
    const b = shapeFrom({ cx: 0.4, cy: 0.5, radius: 0.2, feather: 0 }, "b");
    expect(shapeAt([a, b], 0.35, 0.5, 1)?.id).toBe("b");
    expect(shapeAt([a, b], 0.15, 0.5, 1)?.id).toBe("a");
    expect(shapeAt([a, b], 0.9, 0.9, 1)).toBeNull();
    expect(shapeAt([{ ...b, enabled: false }, a], 0.55, 0.5, 1)).toBeNull();
  });
});


it("repairs duplicate and missing ids without stealing later explicit ids", () => {
  const shapes = parseShapes('[{}, {"id":"shape_1"}, {"id":"shape_1"}, {"id":"shape_3"}]');
  expect(new Set(shapes.map((s) => s.id)).size).toBe(4);
  expect(shapes[1].id).toBe("shape_1");
  expect(shapes[3].id).toBe("shape_3");
  expect(parseShapes(serializeShapes(shapes))).toEqual(shapes);
});


it("copy edits keeps the target's shapes and their chain seat", async () => {
  const { initialState } = await import("../data");
  const { reduce, pasteGraphKeepingWarp, shapeWarpShapes } = await import("../state");
  const make = (name: string) => reduce(reduce(initialState(), { type: "shape_warp_add" }), { type: "shape_warp_rename", id: "shape_1", name });
  const donor = make("Donor");
  const target = make("Target");
  const pasted = pasteGraphKeepingWarp(donor, target);
  expect(shapeWarpShapes({ ...target, ...pasted })[0].name).toBe("Target");
  expect(pasted.wires.filter((w) => w.from === "shapewarp" || w.to === "shapewarp")).toEqual(target.wires.filter((w) => w.from === "shapewarp" || w.to === "shapewarp"));
  expect(pasteGraphKeepingWarp(donor, initialState()).nodes.some((n) => n.type === "heeler.shape_warp")).toBe(false);
});

it("adding to a bypassed shape node enables it", async () => {
  const { initialState } = await import("../data");
  const { reduce } = await import("../state");
  let state = reduce(initialState(), { type: "shape_warp_add" });
  state = reduce(state, { type: "set_enabled", id: "shapewarp", enabled: false });
  state = reduce(state, { type: "shape_warp_add" });
  expect(state.nodes.find((n) => n.id === "shapewarp")!.enabled).toBe(true);
});


it("presets preserve Shape Warp bypass and neutralize foreign shapes", async () => {
  const { initialState } = await import("../data");
  const { reduce, capturePreset, shapeWarpShapes } = await import("../state");
  const donor = reduce(initialState(), { type: "shape_warp_add" });
  const preset = capturePreset(donor, "Look");
  const target = reduce(donor, { type: "set_enabled", id: "shapewarp", enabled: false });
  const applied = reduce(target, { type: "apply_preset", preset });
  expect(applied.nodes.find((n) => n.id === "shapewarp")!.enabled).toBe(false);
  expect(shapeWarpShapes(applied)).toEqual(shapeWarpShapes(target));
  const foreign = { ...preset, nodes: donor.nodes };
  const clean = reduce(initialState(), { type: "apply_preset", preset: foreign });
  expect(shapeWarpShapes(clean)).toEqual([]);
  expect(clean.nodes.find((n) => n.id === "shapewarp")!.enabled).toBe(false);
});


it("Escape restores a warp's original bypass state", async () => {
  const { initialState } = await import("../data");
  const { reduce, shapeWarpShapes } = await import("../state");
  let state = reduce(initialState(), { type: "shape_warp_add" });
  state = reduce(state, { type: "shape_warp_set", id: "shape_1", patch: { dx: 0.1 } });
  state = reduce(state, { type: "set_enabled", id: "shapewarp", enabled: false });
  state = reduce(state, { type: "set_tool", tool: "shapewarp" });
  state = reduce(state, { type: "shape_warp_set", id: "shape_1", patch: { dx: 0.2 } });
  state = reduce(state, { type: "cancel_tool" });
  expect(state.nodes.find((n) => n.id === "shapewarp")!.enabled).toBe(false);
  expect(shapeWarpShapes(state)[0].dx).toBe(0.1);
});
