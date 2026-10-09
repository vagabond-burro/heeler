// The wire drag's precomputed cycle test (dragCycleCheck) answers
// pipeFits exactly as the per-call graph walk (createsCycle) does, on
// every pair of cards and every drawn seat of a graph with chains, a
// diamond and a near-loop. The drag's per-move port lighting reads it
// once per gesture instead of walking the graph per port per card.
import { describe, expect, it } from "vitest";
import { makeNode, specFor } from "../nodes";
import type { NodeCard, Wire } from "../state";
import { dragCycleCheck, drawnSeats, pipeFits } from "../ui/graph";

const card = (type: string, id: string) => makeNode(specFor(type)!, id, 0, 0);

/** A graph with a chain, a diamond rejoin, and a Merge with two
 * inputs, plus an existing pipe to lift. */
function topology() {
  const nodes: NodeCard[] = [
    card("heeler.image_source", "src"),
    card("heeler.exposure", "a"),
    card("heeler.levels", "b"),
    card("heeler.blur", "c"),
    card("heeler.merge", "m"),
    card("heeler.sharpen", "d"),
    card("heeler.math", "f1"),
    card("heeler.math", "f2"),
    card("heeler.invert_mask", "inv"),
  ];
  const wires: Wire[] = [
    { from: "src", to: "a", toPort: "in", kind: "image" },
    { from: "a", to: "b", toPort: "in", kind: "image" },
    { from: "a", to: "c", toPort: "in", kind: "image" },
    { from: "b", to: "m", toPort: "in", kind: "image" },
    { from: "c", to: "m", toPort: "in2", kind: "image" },
    { from: "m", to: "d", toPort: "in", kind: "image" },
    { from: "f1", to: "inv", toPort: "mask", kind: "mask" },
    { from: "inv", to: "b", toPort: "mask", kind: "mask" },
  ];
  return { nodes, wires };
}

describe("dragCycleCheck", () => {
  it("answers pipeFits as the per-call walk does, from the output end", () => {
    const { nodes, wires } = topology();
    for (const src of nodes) {
      for (const kind of ["image", "mask"] as const) {
        const cycle = dragCycleCheck(wires, { from: src.id });
        for (const dst of nodes) {
          for (const seat of drawnSeats(dst)) {
            expect(pipeFits(wires, src, kind, dst, seat, undefined, cycle), `${src.id} -> ${dst.id}.${seat} (${kind})`).toBe(
              pipeFits(wires, src, kind, dst, seat),
            );
          }
        }
      }
    }
  });

  it("answers pipeFits as the per-call walk does, from the input end", () => {
    const { nodes, wires } = topology();
    for (const dst of nodes) {
      for (const seat of drawnSeats(dst)) {
        const cycle = dragCycleCheck(wires, { to: dst.id });
        for (const src of nodes) {
          for (const kind of ["image", "mask"] as const) {
            expect(pipeFits(wires, src, kind, dst, seat, undefined, cycle), `${src.id} -> ${dst.id}.${seat} (${kind})`).toBe(
              pipeFits(wires, src, kind, dst, seat),
            );
          }
        }
      }
    }
  });

  it("answers with the lifted pipe left out, as the per-call walk does", () => {
    const { nodes, wires } = topology();
    // Lifting b->m leaves b feeding nothing, so a pipe from d (two
    // links downstream of m) to b no longer closes a loop.
    const lifted = wires.find((w) => w.from === "b" && w.to === "m")!;
    const d = nodes.find((n) => n.id === "d")!;
    const b = nodes.find((n) => n.id === "b")!;
    const cycle = dragCycleCheck(wires, { from: "d", lifted });
    expect(pipeFits(wires, d, "image", b, "in", lifted, cycle)).toBe(pipeFits(wires, d, "image", b, "in", lifted));
    expect(pipeFits(wires, d, "image", b, "in", lifted)).toBe(true);
    // With the pipe in place it would be a loop.
    expect(pipeFits(wires, d, "image", b, "in")).toBe(false);
  });

  it("treats a card's own card as a loop, as createsCycle does", () => {
    const { wires } = topology();
    const cycle = dragCycleCheck(wires, { from: "a" })!;
    expect(cycle("a", "a")).toBe(true);
    const back = dragCycleCheck(wires, { to: "a" })!;
    expect(back("a", "a")).toBe(true);
  });
});
