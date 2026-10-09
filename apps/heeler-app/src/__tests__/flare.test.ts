// The lens flare on the app side: one rig on two nodes, presets that
// touch only the look, the chain seat, and the suggestion that stays a
// suggestion.

import { describe, expect, it } from "vitest";
import { initialState } from "../data";
import { CATEGORY_PIECES, CHAIN_ORDER } from "../recipes";
import { FLARE_PRESETS, LAYER_TOOLS, reduce, suggestFlarePreset, type Command, type State } from "../state";
import { flareSourceOf, lightsOf } from "../ui/keylightgizmo";
import { readStreakStops } from "../ui/flare";
import { ribbonColorAt } from "../ui/ribbon";

const run = (s: State, ...cmds: Command[]) => cmds.reduce(reduce, s);
const RIG = '[{"kind":"point","px":0.3,"py":0.4,"depth":60,"on":true,"color":"#ffffff","flare":true,"flare_strength":120}]';

describe("the lens flare", () => {
  it("sits after Depth of Field and before the bend, as its own category", () => {
    expect(CHAIN_ORDER.indexOf("flare")).toBe(CHAIN_ORDER.indexOf("dof") + 1);
    expect(CHAIN_ORDER.indexOf("flare")).toBeLessThan(CHAIN_ORDER.indexOf("profile"));
    expect(CATEGORY_PIECES["Lens Flare"][0].type).toBe("heeler.flare");
  });

  it("is born with Depth Lighting's rig, and a rig write lands on both nodes", () => {
    let s = initialState();
    // The demo graph carries both nodes switched off; a fresh photo's
    // graph carries neither until a section comes on. Both paths keep
    // one rig: the mirror when the flare node exists, the seed when
    // the section builds it.
    s = run(s, { type: "set_text_param", id: "keylight", param: "lights", value: RIG });
    expect(s.nodes.find((n) => n.id === "flare")!.textParams?.lights).toBe(RIG);
    // The seed: a graph without the flare node builds it from the rig.
    const bare = { ...s, nodes: s.nodes.filter((n) => n.id !== "flare"), wires: s.wires.map((w) => (w.to === "flare" ? { ...w, to: "bend" } : w)).filter((w) => w.from !== "flare") };
    const grown = run(bare as State, { type: "set_category", title: "Lens Flare", on: true });
    const built = grown.nodes.find((n) => n.id === "flare")!;
    expect(built.textParams?.lights).toBe(RIG);
    // Born wearing Modern prime, so the first flare has rays and ghosts.
    expect(built.textParams?.preset).toBe("prime");
    expect(built.params.rays).toBe(FLARE_PRESETS.find((f) => f.id === "prime")!.params.rays);
    s = run(s, { type: "set_category", title: "Lens Flare", on: true });
    const flare = s.nodes.find((n) => n.id === "flare")!;
    expect(flare.enabled).toBe(true);
    expect(flare.textParams?.lights).toBe(RIG);
    // From either side.
    const RIG2 = RIG.replace('"flare":true', '"flare":false');
    s = run(s, { type: "set_text_param", id: "keylight", param: "lights", value: RIG2 });
    expect(s.nodes.find((n) => n.id === "flare")!.textParams?.lights).toBe(RIG2);
    s = run(s, { type: "set_text_param", id: "flare", param: "lights", value: RIG });
    expect(s.nodes.find((n) => n.id === "keylight")!.textParams?.lights).toBe(RIG);
    // One undo step for the pair.
    s = run(s, { type: "undo" });
    expect(s.nodes.find((n) => n.id === "keylight")!.textParams?.lights).toBe(RIG2);
    expect(s.nodes.find((n) => n.id === "flare")!.textParams?.lights).toBe(RIG2);
  });

  it("reads the new rig fields with defaults, so every saved rig opens", () => {
    const node = { id: "k", type: "heeler.key_light", textParams: { lights: '[{"kind":"point"}]' }, params: {} } as never;
    const [l] = lightsOf(node);
    expect(l.flare).toBe(false);
    expect(l.flare_strength).toBe(100);
  });

  it("a preset names only look params, never the rig, intensity or the scene", () => {
    const forbidden = ["intensity", "temp", "occlusion", "occlusion_soft", "veil_depth", "lights"];
    for (const p of FLARE_PRESETS) {
      for (const k of Object.keys(p.params)) {
        expect(forbidden, `${p.id} writes ${k}`).not.toContain(k);
        expect(LAYER_TOOLS.flare.params, `${p.id} names an unknown dial ${k}`).toHaveProperty(k);
      }
      for (const k of Object.keys(p.text ?? {})) {
        expect(["streak_stops", "streak_color"], `${p.id} writes text ${k}`).toContain(k);
      }
    }
    // The anamorphic preset carries its ribbon, and it parses.
    const ana = FLARE_PRESETS.find((p) => p.id === "anamorphic")!;
    expect(JSON.parse(ana.text!.streak_stops).length).toBeGreaterThanOrEqual(2);
    expect(new Set(FLARE_PRESETS.map((p) => p.id)).size).toBe(FLARE_PRESETS.length);
  });

  it("suggests a lens from the metadata and nothing else", () => {
    expect(suggestFlarePreset(50, "50mm f/1.4")).toBe("prime");
    expect(suggestFlarePreset(35, "24-70mm f/2.8")).toBe("zoom");
    expect(suggestFlarePreset(16, "16mm")).toBe("wide");
    expect(suggestFlarePreset(200, "200mm")).toBe("tele");
    expect(suggestFlarePreset(null, null)).toBe("prime");
  });

  it("draws the flare where the engine puts it: a point where it stands, a sun past its edge", () => {
    const base = lightsOf({ id: "k", type: "heeler.key_light", textParams: { lights: '[{"kind":"point","px":0.3,"py":0.7}]' }, params: {} } as never)[0];
    expect(flareSourceOf(base, 1.5)).toEqual([0.3, 0.7]);
    // From the right (azimuth 0), low: just past the right edge, level
    // with the center.
    const sun = { ...base, kind: "directional" as const, azimuth: 0, elevation: 5 };
    const [sx, sy] = flareSourceOf(sun, 1.5);
    expect(sx).toBeGreaterThan(1);
    expect(sx).toBeLessThan(1.1);
    expect(sy).toBeCloseTo(0.5, 6);
    // Higher sits farther out.
    expect(flareSourceOf({ ...sun, elevation: 90 }, 1.5)[0]).toBeGreaterThan(sx);
  });

  it("the streak ribbon reads its stops, or the single color as two", () => {
    expect(readStreakStops("", "#5aa0ff")).toEqual([
      { pos: 0, color: "#5aa0ff", alpha: 100, mid: 50 },
      { pos: 100, color: "#5aa0ff", alpha: 100, mid: 50 },
    ]);
    // Stored order, so a stop dragged past its neighbor keeps its row.
    const stops = readStreakStops('[{"pos":100,"color":"#0000ff"},{"pos":0,"color":"#ff0000","alpha":80}]', "#000000");
    expect(stops.map((s) => s.pos)).toEqual([100, 0]);
    expect(stops[1].alpha).toBe(80);
    expect(stops[0].mid).toBe(50);
    expect(readStreakStops("nope", "#123456")[0].color).toBe("#123456");
  });

  it("the ribbon reads its color between stops, in stored order", () => {
    const stops = [
      { pos: 100, color: "#0000ff", alpha: 100, mid: 50 },
      { pos: 0, color: "#ff0000", alpha: 100, mid: 50 },
    ];
    expect(ribbonColorAt(stops, 0)).toBe("#ff0000");
    expect(ribbonColorAt(stops, 100)).toBe("#0000ff");
    expect(ribbonColorAt(stops, 50)).toBe("#800080");
    expect(ribbonColorAt(stops, -5)).toBe("#ff0000");
  });
});
