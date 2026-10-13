// The lens correction runs ahead of the crop (2026.5.3): it describes the
// lens, so it reads the whole frame the camera recorded. A graph saved
// with the crop feeding the lens is turned round as it loads, the way the
// desktop turns round a saved graph it renders itself (lib.rs
// lens_before_crop, a_saved_crop_then_lens_is_read_lens_first).
import { describe, expect, it } from "vitest";
import { lensBeforeCrop, migrateGraph, type NodeCard, type Wire } from "../state";

const card = (id: string, type: string): NodeCard =>
  ({ id, type, name: id, cat: "source", x: 0, y: 0, enabled: true, params: {}, hasIn: true, hasOut: true }) as NodeCard;

const NODES: NodeCard[] = [
  card("src", "heeler.image_source"),
  card("crop", "heeler.crop_rotate"),
  card("lens", "heeler.lens_correct"),
  card("late", "heeler.exposure"),
  card("output", "heeler.output"),
  card("tap", "heeler.exposure"),
  card("m", "heeler.brush_mask"),
];

const OLD: Wire[] = [
  { from: "src", to: "crop", toPort: "in", kind: "image" },
  { from: "crop", to: "lens", toPort: "in", kind: "image" },
  { from: "lens", to: "late", toPort: "in", kind: "image" },
  { from: "late", to: "output", toPort: "in", kind: "image" },
  { from: "crop", to: "tap", toPort: "in", kind: "image" },
  { from: "m", to: "lens", toPort: "mask", kind: "mask" },
];

const feed = (wires: Wire[], to: string, port = "in") => wires.find((w) => w.to === to && w.toPort === port)?.from;

describe("the lens correction ahead of the crop", () => {
  it("turns a saved crop-then-lens round, leaving everything else on either node", () => {
    const out = lensBeforeCrop(NODES, OLD);
    expect(feed(out, "lens")).toBe("src");
    expect(feed(out, "crop")).toBe("lens");
    expect(feed(out, "late")).toBe("crop");
    expect(feed(out, "tap"), "the crop's other reader stays on the crop").toBe("crop");
    expect(feed(out, "lens", "mask"), "a mask on the lens stays on the lens").toBe("m");
    expect(out).toHaveLength(OLD.length);
    // A graph already in order comes back as it was, the same array.
    expect(lensBeforeCrop(NODES, out)).toBe(out);
    // Without the pair wired that way there is nothing to do.
    const noLens = OLD.filter((w) => w.from !== "lens" && w.to !== "lens");
    expect(lensBeforeCrop(NODES, noLens)).toBe(noLens);
  });

  it("happens as a saved graph loads", () => {
    const { wires } = migrateGraph(NODES, OLD);
    expect(feed(wires, "lens")).toBe("src");
    expect(feed(wires, "crop")).toBe("lens");
  });
});
