// Every card draws its mask diamond exactly when its node takes a mask
// in the engine. Docs review 2026-10-01: Color Transform, Channel Gain,
// Channel Mixer, Invert and Blend Mode took a mask in the engine but
// drew no diamond (nodes.ts skipped the mask input for every Utility
// node), so no mask could be wired to them; and Noise, Depth Map and
// the layer effects drew one the engine has no port for, so a mask
// wired there was dropped by build_graph and did nothing. The engine's
// inputs come from src/registry-inputs.json, which the desktop holds to
// the registry (lib.rs the_registry_inputs_mirror_matches_the_engine_
// registry). The desktop renders this file's fixture: a masked Color
// Transform applies only inside its mask at Fit, on the 1:1 slice and
// in the export (src-tauri/src/masked_utility.rs).
//   GEN_FIXTURE=1 npx vitest run graphmaskseat
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import expected from "./fixtures/masked-utility.json";
import { serializeGraph } from "../bridge";
import { initialState } from "../data";
import { MASK_IN_TYPES, NODE_CATALOG, RETIRED_TYPES, engineTakesMask, makeNode, portName, specFor } from "../nodes";
import inputs from "../registry-inputs.json";
import { dropDeadMaskSeats, migrateGraph, migrateNodes, reduce, seatTakes, type Command, type NodeCard, type State, type Wire } from "../state";
import { drawnSeats, pipeFits, sourceSeat } from "../ui/graph";

const engine = inputs as Record<string, Record<string, string>>;
const card = (type: string, id: string, x: number, y: number) => makeNode(specFor(type)!, id, x, y);
const run = (s: State, ...cmds: Command[]): State => cmds.reduce(reduce, s);

/** Engine types no card is made for: the group (a UI construct), and
 * the nodes the desktop splices in itself (nodes.test's palette list). */
const NOT_CARDS = new Set(["heeler.group", "heeler.mask_crop", "heeler.layer_warp_mask"]);

/** The five the review named. */
const NAMED = ["heeler.color_transform", "heeler.channel_gain", "heeler.channel_mixer", "heeler.invert", "heeler.blend"];

describe("the mask diamond follows the engine", () => {
  it("every registry node: a node the engine masks has a card mask seat, and a card mask seat has an engine mask", () => {
    const wrong: string[] = [];
    let checked = 0;
    for (const type of Object.keys(engine)) {
      if (NOT_CARDS.has(type) || RETIRED_TYPES.has(type)) continue;
      const spec = specFor(type);
      expect(spec, `${type} is offered in the palette`).toBeDefined();
      const c = makeNode(spec!, "n", 0, 0);
      // The port the card's diamond stands for, by the engine's name.
      const port = portName(type, "mask");
      const masks = engine[type][port] === "mask";
      if (MASK_IN_TYPES.has(type)) {
        // The field IS the input on these: drawn as "in", never twice.
        if (c.maskIn && type !== "heeler.invert_mask") wrong.push(`${type}: an operand node draws a mask diamond`);
      } else if (!!c.maskIn !== masks) {
        wrong.push(`${type}: card ${c.maskIn ? "draws" : "lacks"} the diamond, engine ${masks ? "takes" : "has no"} "${port}"`);
      }
      checked++;
    }
    expect(wrong).toEqual([]);
    expect(checked).toBeGreaterThan(100);
  });

  it("the review's five draw the diamond, and a field lands there from either end of the hand", () => {
    for (const type of NAMED) {
      const dst = card(type, "dst", 400, 300);
      expect(dst.maskIn, type).toBe(true);
      expect(engineTakesMask(type), type).toBe(true);
      expect(drawnSeats(dst), type).toContain("mask");
      // The type rule the connect reducer and both ends of a drag read.
      expect(seatTakes(dst, "mask", true), type).toBe(true);
      expect(seatTakes(dst, "mask", false), type).toBe(false);
      for (const from of [card("heeler.luminance_range_mask", "from", 40, 40), card("heeler.radial_mask", "from", 40, 40), card("heeler.math", "from", 40, 40)]) {
        expect(sourceSeat("mask", from)).not.toBeNull();
        const s: State = { ...initialState(), nodes: [from, dst], wires: [], undoStack: [], redoStack: [] };
        // Output first lights the diamond; input first lights the
        // output: the same pipeFits answers both.
        expect(pipeFits(s.wires, from, "mask", dst, "mask"), `${from.type} into ${type}`).toBe(true);
        const wire: Wire = { from: "from", to: "dst", toPort: "mask", kind: "mask" };
        expect(run(s, { type: "connect", wire }).wires, `${from.type} into ${type}`).toEqual([wire]);
      }
    }
  });

  it("a saved card without the diamond gains it, and a card that has it is left as it is", () => {
    const saved = card("heeler.color_transform", "ct", 0, 0);
    delete (saved as Partial<NodeCard>).maskIn;
    const [healed] = migrateNodes([saved]);
    expect(healed.maskIn).toBe(true);
    const fresh = card("heeler.color_transform", "ct", 0, 0);
    expect(migrateNodes([fresh])[0].maskIn).toBe(true);
  });

  it("every palette node's card agrees with engineTakesMask", () => {
    for (const spec of NODE_CATALOG) {
      if (RETIRED_TYPES.has(spec.type)) continue;
      expect(!!makeNode(spec, "n", 0, 0).maskIn, spec.type).toBe(engineTakesMask(spec.type));
    }
  });
});

/** A photograph saved before 2026-10-01: a Grain Field placed from the
 * palette, its dead diamond fed by a Radial Mask, into the Output. */
function savedWithDeadSeat(): State {
  const gf = { ...card("heeler.noise", "gf", 300, 40), maskIn: true };
  const rm = card("heeler.radial_mask", "rm", 40, 240);
  return {
    ...initialState(),
    activeImage: "img",
    nodes: [card("heeler.image_source", "src", 40, 40), gf, rm, card("heeler.output", "output", 560, 40)],
    wires: [
      { from: "src", to: "gf", toPort: "in", kind: "image" },
      { from: "src", to: "rm", toPort: "in", kind: "image" },
      { from: "gf", to: "output", toPort: "in", kind: "image" },
      { from: "rm", to: "gf", toPort: "mask", kind: "mask" },
    ],
    undoStack: [],
    redoStack: [],
  };
}

describe("a saved diamond the engine has no port for", () => {
  it("loads gone, with the wire into it, at the top level and inside a group; nothing else moves", () => {
    const s = savedWithDeadSeat();
    const migrated = migrateGraph(s.nodes, s.wires);
    const gf = migrated.nodes.find((n) => n.id === "gf")!;
    expect(gf.maskIn).toBeFalsy();
    expect(migrated.wires.some((w) => w.to === "gf" && w.toPort === "mask")).toBe(false);
    // Every other wire and every number is as saved.
    expect(migrated.wires).toEqual(s.wires.filter((w) => !(w.to === "gf" && w.toPort === "mask")));
    expect(gf.params).toEqual(s.nodes.find((n) => n.id === "gf")!.params);
    // A live diamond stays, and so does its wire.
    const ct = card("heeler.color_transform", "ct", 0, 0);
    const live = migrateGraph([...s.nodes, ct], [...s.wires, { from: "rm", to: "ct", toPort: "mask", kind: "mask" }]);
    expect(live.nodes.find((n) => n.id === "ct")!.maskIn).toBe(true);
    expect(live.wires).toContainEqual({ from: "rm", to: "ct", toPort: "mask", kind: "mask" });
    // Inside a group (a layer effect placed by hand, fed by a mask).
    const fx = { ...card("heeler.fx_glow", "glow", 0, 0), maskIn: true };
    const inner = card("heeler.radial_mask", "inner_rm", 0, 100);
    const group: NodeCard = {
      id: "grp",
      type: "heeler.group",
      name: "Glow group",
      cat: "group",
      x: 300,
      y: 300,
      enabled: true,
      params: {},
      hasIn: true,
      hasOut: true,
      isGroup: true,
      groupNodes: [fx, inner],
      groupWires: [{ from: "inner_rm", to: "glow", toPort: "mask", kind: "mask" }],
    };
    const grouped = migrateGraph([...s.nodes, group], s.wires);
    const g = grouped.nodes.find((n) => n.id === "grp")!;
    expect(g.groupNodes!.find((n) => n.id === "glow")!.maskIn).toBeFalsy();
    expect(g.groupWires).toEqual([]);
    // A graph with no dead seat comes back as the same arrays.
    const clean = [card("heeler.image_source", "src", 0, 0), ct];
    const cleanWires: Wire[] = [{ from: "src", to: "ct", toPort: "in", kind: "image" }];
    expect(dropDeadMaskSeats(clean, cleanWires)).toEqual({ nodes: clean, wires: cleanWires });
    expect(dropDeadMaskSeats(clean, cleanWires).nodes).toBe(clean);
  });
});

describe("the desktop's pixel fixture", () => {
  it("a Color Transform gated by a Radial Mask wired by the connect reducer", () => {
    const ct = card("heeler.color_transform", "ct", 300, 40);
    ct.textParams = { ...ct.textParams, from: "linear_rec709", to: "srgb" };
    const rm = card("heeler.radial_mask", "rm", 40, 240);
    rm.params = { ...rm.params, center_x: 0.5, center_y: 0.5, radius: 0.3, feather: 0.2 };
    const base: State = {
      ...initialState(),
      activeImage: "img",
      nodes: [card("heeler.image_source", "src", 40, 40), ct, rm, card("heeler.output", "output", 560, 40)],
      wires: [
        { from: "src", to: "ct", toPort: "in", kind: "image" },
        { from: "src", to: "rm", toPort: "in", kind: "image" },
        { from: "ct", to: "output", toPort: "in", kind: "image" },
      ],
      undoStack: [],
      redoStack: [],
    };
    const masked = run(base, { type: "connect", wire: { from: "rm", to: "ct", toPort: "mask", kind: "mask" } });
    expect(masked.wires).toContainEqual({ from: "rm", to: "ct", toPort: "mask", kind: "mask" });
    // And a saved dead diamond with its wire, before and after the load:
    // the desktop renders both and finds them identical.
    const saved = savedWithDeadSeat();
    const loaded = migrateGraph(saved.nodes, saved.wires);
    const fixtures = {
      masked: serializeGraph(masked),
      dead_before: serializeGraph(saved),
      dead_after: serializeGraph({ ...saved, ...loaded }),
    };
    expect(fixtures.masked.connections).toContainEqual({ from: ["rm", "out"], to: ["ct", "mask"] });
    expect(fixtures.dead_before.connections).toContainEqual({ from: ["rm", "out"], to: ["gf", "mask"] });
    expect(fixtures.dead_after.connections).not.toContainEqual({ from: ["rm", "out"], to: ["gf", "mask"] });
    if (process.env.GEN_FIXTURE) {
      writeFileSync(resolve(process.cwd(), "src/__tests__/fixtures/masked-utility.json"), JSON.stringify(fixtures, null, 1) + "\n");
    }
    expect(fixtures).toEqual(expected);
  });
});
