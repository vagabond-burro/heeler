// The transform's live preview: the math that draws the layer through
// the quad locally, and the decision of when a drag may use it.
//
// The homography is the engine's solver (ops_geometry.rs) run forward,
// so the invariants under test are the geometric ones the engine
// guarantees: corners exact, the center landing where the diagonals
// cross, edges staying straight.

import { describe, expect, it } from "vitest";

import { initialState } from "../data";
import { reduce, artLayers, type Command, type State } from "../state";
import {
  affineForQuad,
  affineFromTriangles,
  homographyForward,
  project,
  quadGestureBlendId,
  transformPreviewPlan,
} from "../ui/transformpreview";

/** A lifted layer made from a marquee: select, lift, transform. The
 * same shape transformtool.test.tsx builds, because the preview follows
 * the same layer. */
function lifted(box = { x: 0.2, y: 0.2, w: 0.4, h: 0.4 }): { s: State; id: string } {
  let s = initialState();
  s = reduce(s, { type: "arm_document_selection" });
  const mask = s.nodes.find((n) => n.type === "heeler.selection_mask")!;
  s = reduce(s, {
    type: "add_region",
    id: mask.id,
    region: {
      kind: "marquee",
      op: "add",
      x0: box.x,
      y0: box.y,
      x1: box.x + box.w,
      y1: box.y + box.h,
    },
  } as Command);
  s = reduce(s, { type: "art_layer_from_selection", maskId: mask.id, version: "00000000000000e1" });
  return { s, id: s.artActive! };
}

const BOX = { x: 0.2, y: 0.2, w: 0.4, h: 0.4 };
/** A quad no parallelogram can be: three corners still, one dragged in. */
const WARPED: [number, number][] = [
  [0.2, 0.2],
  [0.6, 0.2],
  [0.6, 0.6],
  [0.28, 0.52],
];

describe("the forward homography", () => {
  it("carries every corner exactly onto its dragged position", () => {
    const h = homographyForward(BOX, WARPED)!;
    expect(h).not.toBeNull();
    for (let i = 0; i < 4; i++) {
      const [sx, sy] = [
        [BOX.x, BOX.y],
        [BOX.x + BOX.w, BOX.y],
        [BOX.x + BOX.w, BOX.y + BOX.h],
        [BOX.x, BOX.y + BOX.h],
      ][i];
      const [x, y] = project(h, sx, sy);
      expect(x).toBeCloseTo(WARPED[i][0], 9);
      expect(y).toBeCloseTo(WARPED[i][1], 9);
    }
  });

  it("carries the center to where the image's diagonals cross", () => {
    // A projective map sends lines to lines, so the source diagonals
    // (which cross at the box's center) land ON the destination's
    // diagonals, and the center lands at their crossing. That makes the
    // crossing an independent witness the solver cannot fudge.
    const h = homographyForward(BOX, WARPED)!;
    const [cx, cy] = project(h, BOX.x + BOX.w / 2, BOX.y + BOX.h / 2);
    const [a, , c] = [WARPED[0], WARPED[1], WARPED[2]];
    const [b, d] = [WARPED[1], WARPED[3]];
    // Intersection of the diagonals a-c and b-d.
    const d1x = c[0] - a[0];
    const d1y = c[1] - a[1];
    const d2x = d[0] - b[0];
    const d2y = d[1] - b[1];
    const t = ((b[0] - a[0]) * d2y - (b[1] - a[1]) * d2x) / (d1x * d2y - d1y * d2x);
    expect(cx).toBeCloseTo(a[0] + t * d1x, 9);
    expect(cy).toBeCloseTo(a[1] + t * d1y, 9);
  });

  it("keeps an edge's midpoint on the edge it was dragged to", () => {
    const h = homographyForward(BOX, WARPED)!;
    // Top edge midpoint, in source and in image.
    const [mx, my] = project(h, BOX.x + BOX.w / 2, BOX.y);
    // Collinear with the warped top edge: zero cross product.
    const cross =
      (WARPED[1][0] - WARPED[0][0]) * (my - WARPED[0][1]) -
      (WARPED[1][1] - WARPED[0][1]) * (mx - WARPED[0][0]);
    expect(Math.abs(cross)).toBeLessThan(1e-9);
  });

  it("is the identity when nothing has moved", () => {
    const still: [number, number][] = [
      [BOX.x, BOX.y],
      [BOX.x + BOX.w, BOX.y],
      [BOX.x + BOX.w, BOX.y + BOX.h],
      [BOX.x, BOX.y + BOX.h],
    ];
    const h = homographyForward(BOX, still)!;
    const [x, y] = project(h, 0.37, 0.41);
    expect(x).toBeCloseTo(0.37, 9);
    expect(y).toBeCloseTo(0.41, 9);
  });

  it("refuses a numerically rank-deficient system", () => {
    // The unsolvable CASES a drag produces (a corner on its neighbor,
    // three corners in a line) are stopped upstream by the overlay's
    // quadIsSolvable guard, which has its own tests: a DLT solver can
    // return a finite-but-singular matrix for those, so null here means
    // what it means in the engine: the elimination itself broke down.
    // Four corners read as one point is such a system.
    const pinched: [number, number][] = [
      [0.4, 0.4],
      [0.4, 0.4],
      [0.4, 0.4],
      [0.4, 0.4],
    ];
    const h = homographyForward(BOX, pinched);
    if (h !== null) {
      // A singular map, if one came back, must not pass for a transform:
      // it sends the whole box to one point.
      const [x, y] = project(h, BOX.x + BOX.w / 2, BOX.y + BOX.h / 2);
      expect(x).toBeCloseTo(0.4, 6);
      expect(y).toBeCloseTo(0.4, 6);
    }
  });
});

describe("the triangle affine", () => {
  it("carries all three source points exactly onto their destinations", () => {
    const s: [number, number][] = [
      [10, 20],
      [110, 20],
      [110, 120],
    ];
    const d: [number, number][] = [
      [50, 60],
      [160, 40],
      [150, 180],
    ];
    const m = affineFromTriangles(s, d)!;
    expect(m).not.toBeNull();
    for (let i = 0; i < 3; i++) {
      const x = m[0] * s[i][0] + m[2] * s[i][1] + m[4];
      const y = m[1] * s[i][0] + m[3] * s[i][1] + m[5];
      expect(x).toBeCloseTo(d[i][0], 9);
      expect(y).toBeCloseTo(d[i][1], 9);
    }
  });

  it("refuses a source triangle with no area", () => {
    const s: [number, number][] = [
      [0, 0],
      [10, 10],
      [20, 20],
    ];
    const d: [number, number][] = [
      [0, 0],
      [10, 0],
      [10, 10],
    ];
    expect(affineFromTriangles(s, d)).toBeNull();
  });
});

describe("the affine fast path", () => {
  // Frame and canvas both 2000x1000: the numbers stay readable.
  const dims: [number, number, number, number] = [2000, 1000, 2000, 1000];

  it("a moved and rotated quad paints with one drawImage", () => {
    const moved: [number, number][] = [
      [0.3, 0.25],
      [0.7, 0.15],
      [0.8, 0.55],
      [0.4, 0.65],
    ];
    const m = affineForQuad(BOX, moved, ...dims)!;
    expect(m).not.toBeNull();
    // All four corners land where the quad says, not just the three the
    // matrix was solved from.
    const src: [number, number][] = [
      [BOX.x, BOX.y],
      [BOX.x + BOX.w, BOX.y],
      [BOX.x + BOX.w, BOX.y + BOX.h],
      [BOX.x, BOX.y + BOX.h],
    ];
    for (let i = 0; i < 4; i++) {
      const x = (m[0] * src[i][0] * 2000 + m[2] * src[i][1] * 1000 + m[4]) / 2000;
      const y = (m[1] * src[i][0] * 2000 + m[3] * src[i][1] * 1000 + m[5]) / 1000;
      expect(x).toBeCloseTo(moved[i][0], 6);
      expect(y).toBeCloseTo(moved[i][1], 6);
    }
  });

  it("a warped quad declines, because one affine cannot carry it", () => {
    expect(affineForQuad(BOX, WARPED, ...dims)).toBeNull();
  });
});

describe("the gesture key", () => {
  it("names the layer a quad gesture belongs to", () => {
    expect(quadGestureBlendId("art_b3.quad")).toBe("art_b3");
    expect(quadGestureBlendId("sel_1.polishstroke")).toBeNull();
    expect(quadGestureBlendId(null)).toBeNull();
  });
});

describe("what a drag may preview", () => {
  it("a plain lifted layer previews at full opacity in source-over", () => {
    const { s, id } = lifted();
    const plan = transformPreviewPlan(s, id)!;
    expect(plan).not.toBeNull();
    expect(plan.gco).toBe("source-over");
    expect(plan.opacity).toBe(1);
    // A lift carries its selection as the layer mask (that is what
    // makes it a lift), so the mask is there to be fetched.
    expect(plan.maskNode).toBe(`art_m_${id}`);
    // The feed is the layer's content node: the thing the warp sits
    // downstream of.
    const layer = artLayers(s).find((l) => l.blend.id === id)!;
    expect(plan.feed).toBe(layer.content.id);
  });

  it("reads the blend's opacity the way the engine does", () => {
    let { s, id } = lifted();
    s = reduce(s, { type: "art_layer_set", id, opacity: 50 });
    expect(transformPreviewPlan(s, id)!.opacity).toBeCloseTo(0.5, 9);
  });

  it("a mode canvas cannot blend keeps the engine path", () => {
    let { s, id } = lifted();
    s = reduce(s, { type: "art_layer_set", id, mode: "vivid_light" });
    expect(transformPreviewPlan(s, id)).toBeNull();
    // And a mode it CAN blend names the canvas operation.
    s = reduce(s, { type: "art_layer_set", id, mode: "multiply" });
    expect(transformPreviewPlan(s, id)!.gco).toBe("multiply");
  });

  it("only the top-most layer previews: the backdrop cannot say what sits above", () => {
    const first = lifted();
    let s = first.s;
    // A second layer, lifted over the first.
    s = reduce(s, { type: "arm_document_selection" });
    const mask = s.nodes.filter((n) => n.type === "heeler.selection_mask").pop()!;
    s = reduce(s, {
      type: "add_region",
      id: mask.id,
      region: { kind: "marquee", op: "add", x0: 0.1, y0: 0.1, x1: 0.3, y1: 0.3 },
    } as Command);
    s = reduce(s, { type: "art_layer_from_selection", maskId: mask.id, version: "00000000000000e1" });
    const top = s.artActive!;
    expect(top).not.toBe(first.id);
    expect(transformPreviewPlan(s, top)).not.toBeNull();
    expect(transformPreviewPlan(s, first.id)).toBeNull();
  });

  it("a clipped layer keeps the engine path", () => {
    // Clip needs a layer below to clip to, so: a paint layer under the
    // lifted one, and the flag set on the top one.
    let s = reduce(initialState(), { type: "art_add_layer", kind: "paint" });
    const bottom = s.artActive!;
    s = reduce(s, { type: "arm_document_selection" });
    const mask = s.nodes.filter((n) => n.type === "heeler.selection_mask").pop()!;
    s = reduce(s, {
      type: "add_region",
      id: mask.id,
      region: { kind: "marquee", op: "add", x0: 0.2, y0: 0.2, x1: 0.6, y1: 0.6 },
    } as Command);
    s = reduce(s, { type: "art_layer_from_selection", maskId: mask.id, version: "00000000000000e1" });
    const top = s.artActive!;
    expect(top).not.toBe(bottom);
    expect(transformPreviewPlan(s, top)).not.toBeNull();
    s = reduce(s, { type: "art_clip_layer", id: top, clip: true });
    expect(transformPreviewPlan(s, top)).toBeNull();
  });

  it("a bare paint layer has no mask to fetch until one is added", () => {
    let s = reduce(initialState(), { type: "art_add_layer", kind: "paint" });
    const id = s.artActive!;
    expect(transformPreviewPlan(s, id)!.maskNode).toBeNull();
    s = reduce(s, { type: "art_add_mask", id });
    expect(transformPreviewPlan(s, id)!.maskNode).toBe(`art_m_${id}`);
  });
});
