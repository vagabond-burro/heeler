// The advanced field nodes (2026-09-30: "go ahead with the first batch of
// nodes"): graph-only, so their cards are their whole face. Each card
// must draw the seats its engine ports need and name them the way the
// engine does, or a wire lands on a port the desktop cannot route.
import { describe, expect, it } from "vitest";
import { FIELD_DIAMOND_TYPES, fieldSpliceSeats, makeNode, MASK_IN_TYPES, portName, specFor } from "../nodes";
import { migrateNodes, PARAM_OPTIONS, PARAM_TEXT_DEFAULT } from "../state";

const card = (type: string) => makeNode(specFor(type)!, "n", 0, 0);

describe("field node cards", () => {
  it("Morphology takes a field on its input and gives one", () => {
    const n = card("heeler.morphology");
    expect(MASK_IN_TYPES.has(n.type)).toBe(true);
    expect(n.maskOut).toBe(true);
    expect(n.maskIn).toBe(false);
    expect(portName(n.type, "in")).toBe("in");
  });

  it("Guided Filter draws its guide as the second image", () => {
    const n = card("heeler.guided_filter");
    expect(n.hasIn2).toBe(true);
    expect(n.maskIn).toBe(true);
    expect(n.maskOut).toBe(false);
    expect(portName(n.type, "in2")).toBe("guide");
  });

  it("Guided Filter (Mask) reads the picture and takes its mask on the diamond", () => {
    const n = card("heeler.guided_filter_mask");
    expect(MASK_IN_TYPES.has(n.type)).toBe(false);
    expect(n.hasIn).toBe(true);
    expect(n.maskIn).toBe(true);
    expect(n.maskOut).toBe(true);
    expect(portName(n.type, "mask")).toBe("target");
  });

  it("Edge Field reads the picture and takes a field on the diamond", () => {
    const n = card("heeler.edge_field");
    expect(MASK_IN_TYPES.has(n.type)).toBe(false);
    expect(n.hasIn).toBe(true);
    expect(n.maskIn).toBe(true);
    expect(n.maskOut).toBe(true);
    expect(portName(n.type, "mask")).toBe("field");
  });

  it("Alpha Association draws the alpha diamond, and a saved card keeps it", () => {
    const n = card("heeler.alpha_association");
    expect(n.alphaIn).toBe(true);
    expect(n.maskIn).toBe(false);
    expect(n.maskOut).toBe(false);
    expect(portName(n.type, "alpha")).toBe("alpha");
    expect(migrateNodes([{ ...n, alphaIn: false }])[0].alphaIn).toBe(true);
  });
});

// The second batch (2026-09-30: "queue those up next as they don't
// look too extensive"), the same rule: each card's seats are the ports
// its engine op reads.
describe("advanced node cards, the second batch", () => {
  it("Technical Soft Clip is a picture node with an effect mask", () => {
    const n = card("heeler.soft_clip");
    expect(n.cat).toBe("color");
    expect(n.hasIn).toBe(true);
    expect(n.maskIn).toBe(true);
    expect(n.maskOut).toBe(false);
    expect(portName(n.type, "mask")).toBe("mask");
  });
});

describe("Median / Percentile cards", () => {
  it("the picture form is a picture node with an effect mask", () => {
    const n = card("heeler.median");
    expect(n.cat).toBe("detail");
    expect(n.hasIn).toBe(true);
    expect(n.maskIn).toBe(true);
    expect(n.maskOut).toBe(false);
  });

  it("the mask form takes a field on its input and gives one, and splices into a mask pipe", () => {
    const n = card("heeler.median_mask");
    expect(MASK_IN_TYPES.has(n.type)).toBe(true);
    expect(n.maskOut).toBe(true);
    expect(n.maskIn).toBe(false);
    expect(portName(n.type, "in")).toBe("in");
    expect(fieldSpliceSeats(n)).toEqual({ inSeat: "in" });
  });
});

describe("Chroma Key cards", () => {
  it("the keyer reads the picture and gives a field", () => {
    const n = card("heeler.chroma_key");
    expect(MASK_IN_TYPES.has(n.type)).toBe(false);
    expect(n.hasIn).toBe(true);
    expect(n.maskOut).toBe(true);
    expect(n.maskIn).toBe(false);
  });

  it("the despill is a picture node with an effect mask", () => {
    const n = card("heeler.chroma_key_despill");
    expect(n.cat).toBe("color");
    expect(n.hasIn).toBe(true);
    expect(n.maskIn).toBe(true);
    expect(n.maskOut).toBe(false);
  });
});

describe("Normals from Depth card", () => {
  it("takes a field on its input and gives a picture", () => {
    const n = card("heeler.depth_normals");
    expect(MASK_IN_TYPES.has(n.type)).toBe(true);
    expect(n.hasIn).toBe(true);
    expect(n.maskOut).toBe(false);
    expect(n.hasOut).toBe(true);
    expect(n.maskIn).toBe(false);
    expect(portName(n.type, "in")).toBe("in");
    // A picture out: it never splices into a mask pipe.
    expect(fieldSpliceSeats(n)).toBeNull();
  });
});

describe("Color Transform card", () => {
  it("is a picture node, and offers the engine's spaces both ways", () => {
    const n = card("heeler.color_transform");
    expect(n.cat).toBe("utility");
    expect(n.hasIn).toBe(true);
    expect(n.maskOut).toBe(false);
    const spaces = ["linear_rec709", "srgb", "linear_rec2020", "acescg", "acescct", "aces2065_1", "linear_p3", "display_p3"];
    expect(PARAM_OPTIONS["heeler.color_transform"].from.map((o) => o.id)).toEqual(spaces);
    expect(PARAM_OPTIONS["heeler.color_transform"].to.map((o) => o.id)).toEqual(spaces);
    expect(PARAM_TEXT_DEFAULT["heeler.color_transform"]).toEqual({ from: "linear_rec709", to: "acescg" });
  });
});

describe("Displacement Map card", () => {
  it("reads the picture and takes its X field on the mask diamond, its Y on the alpha diamond", () => {
    const n = card("heeler.displacement_map");
    expect(n.cat).toBe("utility");
    expect(n.hasIn).toBe(true);
    expect(n.maskIn).toBe(true);
    expect(n.alphaIn).toBe(true);
    expect(n.maskOut).toBe(false);
    expect(portName(n.type, "in")).toBe("in");
    expect(portName(n.type, "mask")).toBe("x");
    expect(portName(n.type, "alpha")).toBe("y");
    expect(FIELD_DIAMOND_TYPES.has(n.type)).toBe(true);
    // A saved card keeps its Y seat.
    expect(migrateNodes([{ ...n, alphaIn: false }])[0].alphaIn).toBe(true);
  });
});

describe("Signed Distance Field card", () => {
  it("takes a field on its input and gives one, and splices into a mask pipe", () => {
    const n = card("heeler.distance_field");
    expect(MASK_IN_TYPES.has(n.type)).toBe(true);
    expect(n.maskOut).toBe(true);
    expect(n.maskIn).toBe(false);
    expect(portName(n.type, "in")).toBe("in");
    expect(fieldSpliceSeats(n)).toEqual({ inSeat: "in" });
  });
});
