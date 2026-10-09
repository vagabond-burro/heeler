// Depth Lighting's Strength runs -100 to 100 (2026-10-08: "it goes to
// 200 which is odd (vs 100) and seems arbitrary... Also increase the
// calculated strength by 50%"). Each light saves it as `power`; a light
// saved before carries `strength` on the old -200 to 200 scale and reads
// at half its number, the same place on the slider and, in the engine,
// 50% stronger (ops_depth.rs power_is_the_scale_...). The engine and the
// app must agree on both keys.
import { describe, expect, it } from "vitest";
import type { Command, NodeCard } from "../state";
import { nodeWantsDepth, reduce } from "../state";
import { initialState } from "../data";
import { STRENGTH_MAX, lightsOf, writeLights } from "../ui/keylightgizmo";

const node = (lights: unknown[] | null, params: Record<string, number> = {}): NodeCard =>
  ({ id: "keylight", type: "heeler.key_light", name: "Depth Lighting", cat: "light", x: 0, y: 0, enabled: true, params, textParams: lights ? { lights: JSON.stringify(lights) } : {} }) as unknown as NodeCard;

describe("a light's strength", () => {
  it("adding a character flare preserves a legacy single light", () => {
    const built = reduce(initialState(), { type: "add_character_flare_light", light: { strength: 0, flare: true } });
    const before = { ...built, nodes: built.nodes.map((n) => n.id === "keylight"
      ? { ...n, params: { ...n.params, strength: 120, azimuth: -30, elevation: 60 }, textParams: { ...n.textParams, lights: "[]" } }
      : n) };
    const after = reduce(before, { type: "add_character_flare_light", light: { kind: "point", strength: 0, flare: true } });
    const n = after.nodes.find((n) => n.id === "keylight")!;
    expect(lightsOf(n).map((l) => l.strength)).toEqual([60, 0]);
    expect(lightsOf(n)[0]).toMatchObject({ azimuth: -30, elevation: 60 });
    expect(reduce(after, { type: "undo" }).nodes).toEqual(before.nodes);
  });
  it("a new character flare light saves its UI strength as power", () => {
    const s = reduce(initialState(), { type: "add_character_flare_light", light: { kind: "point", strength: 25, flare: true } });
    for (const id of ["keylight", "flare"]) {
      const n = s.nodes.find((n) => n.id === id)!;
      const saved = JSON.parse(n.textParams!.lights)[0];
      expect(saved.power).toBe(25);
      expect(saved).not.toHaveProperty("strength");
      expect(lightsOf(n)[0].strength).toBe(25);
    }
  });
  it("is read from power, and an old strength at half its number", () => {
    const lights = lightsOf(node([{ kind: "directional", power: 75 }, { kind: "point", strength: 150 }, { kind: "point", strength: -200 }]));
    expect(lights.map((l) => l.strength)).toEqual([75, 75, -100]);
    // A light carrying both reads power.
    expect(lightsOf(node([{ power: 40, strength: 180 }]))[0].strength).toBe(40);
    // The legacy single light too.
    expect(lightsOf(node(null, { strength: 120, azimuth: 30, elevation: 40 }))[0].strength).toBe(60);
  });

  it("is written as power alone, so nothing reads it twice", () => {
    const got: Command[] = [];
    const n = node([{ kind: "point", strength: 150 }]);
    writeLights((c: Command) => got.push(c), n, lightsOf(n));
    const saved = JSON.parse((got[0] as Extract<Command, { type: "set_text_param" }>).value)[0];
    expect(saved.power).toBe(75);
    expect("strength" in saved).toBe(false);
    // And reads back the same.
    expect(lightsOf(node([saved]))[0].strength).toBe(75);
  });

  it("runs to 100 either way", () => {
    expect(STRENGTH_MAX).toBe(100);
  });

  it("counts for depth by power, and by an old strength", () => {
    expect(nodeWantsDepth(node([{ power: 20 }]))).toBe(true);
    expect(nodeWantsDepth(node([{ strength: 20 }]))).toBe(true);
    expect(nodeWantsDepth(node([{ power: 0, strength: 50 }]))).toBe(false);
  });
});
