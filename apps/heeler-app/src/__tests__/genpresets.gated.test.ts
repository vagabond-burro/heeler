// The built-in preset library's GENERATOR. Gated: it only writes when
// GEN_PRESETS=1, and otherwise just proves every authored look builds
// and captures cleanly. The looks are authored as COMMANDS over a
// NEUTRAL photograph and captured through capturePreset itself, so
// every built-in is, by construction, a valid sanitized preset of the
// current schema, holding only the nodes its look needs: the library
// can never drift from the app.
//
// Neutral, not the sample session: the first library was authored over
// initialState, whose graph is the wedding sample's own develop
// (exposure +0.62, shadows +35, highlights -42, whites +8 and all 23
// of its nodes), so every look shipped with that push baked in and
// blew out the highs on any bright scene, and carried eight bypassed
// nodes it never used (2026-09-07). The photograph a look is authored
// over is now the one Reset all edits leaves: the five template nodes
// at their defaults, with each category a look touches switched on the
// way the panel's switch does it.
//
// Regenerate after changing a look or the capture rules:
//   GEN_PRESETS=1 npx vitest run src/__tests__/genpresets.gated.test.ts
// then commit apps/heeler-app/src-tauri/presets/builtin.json.

import { describe, expect, it } from "vitest";
// Node built-ins via dynamic import inside the gated write: this
// project's tsconfig has no node types, and only the generation run
// touches the filesystem.
import { initialState } from "../data";
import { NEUTRAL_PARAMS, capturePreset, reduce, type Command, type State } from "../state";

const run = (s: State, ...cmds: Command[]) => cmds.reduce(reduce, s);
const set = (id: string, values: Record<string, number>): Command => ({
  type: "set_params",
  id,
  values,
  text: {},
});
/** The section a node belongs to, for the switch that builds it. The
 * B&W treatment needs no switch: its node is built by the first write
 * that says something, like Sharpen's. */
const SECTION_OF: Record<string, string> = { cbal: "Color Wheels", grain: "Grain", detail: "Detail" };

/** The template a look is authored over: the neutral photograph. */
function neutral(): State {
  const s = initialState();
  return reduce(s, { type: "reset_image_edits", id: s.activeImage! });
}

/** Builds a look: every category its writes touch switched on first,
 * once, in the order the writes name them. */
function author(cmds: Command[]): State {
  const on = new Set<string>();
  const full: Command[] = [];
  for (const c of cmds) {
    const title = c.type === "set_params" ? SECTION_OF[c.id] : undefined;
    if (title && !on.has(title)) {
      on.add(title);
      full.push({ type: "set_category", title, on: true });
    }
    full.push(c);
  }
  return run(neutral(), ...full);
}

/** The library. Values are pushes over the NEUTRAL develop, sized to be
 * seen (the owner, after touring all 25: "push the values a bit
 * further to exaggerate the changes"), and then reined in where the
 * push had been riding a base exposure that no longer exists
 * (2026-09-07: "every preset blows out the highs"). No look lifts
 * exposure past 0.7 EV, and the two that lift it at all are the ones
 * named for it.*/
const LOOKS: { category: string; name: string; cmds: Command[] }[] = [
  // -- Nature: the outdoors, honest but better. --
  { category: "Nature", name: "Meadow", cmds: [
    set("stdcolor", { temperature: 5150, vibrance: 58, saturation: 10 }),
    set("detail", { clarity: 22 }),
    set("exposure", { shadows: 60 }),
  ]},
  { category: "Nature", name: "Golden Field", cmds: [
    set("stdcolor", { temperature: 6600, tint: 12, vibrance: 46 }),
    set("exposure", { highlights: -70, shadows: 60 }),
    set("grain", { intensity: 10 }),
  ]},
  { category: "Nature", name: "Alpine Air", cmds: [
    set("stdcolor", { temperature: 4700 }),
    set("detail", { dehaze: 28, clarity: 25 }),
    set("exposure", { contrast: 38, whites: 20 }),
  ]},
  { category: "Nature", name: "Forest Deep", cmds: [
    set("stdcolor", { temperature: 4950, vibrance: 44 }),
    set("exposure", { contrast: 45, blacks: -34 }),
    set("cbal", { shadows_hue: 150, shadows_sat: 14 }),
  ]},
  { category: "Nature", name: "Coastal Light", cmds: [
    set("stdcolor", { temperature: 4850, tint: -6, vibrance: 52 }),
    set("detail", { dehaze: 14 }),
    set("exposure", { highlights: -75 }),
  ]},
  // -- Vibrance: color forward. --
  { category: "Vibrance", name: "Punch", cmds: [
    set("stdcolor", { vibrance: 75, saturation: 16 }),
    set("detail", { clarity: 28 }),
    set("exposure", { contrast: 50 }),
  ]},
  { category: "Vibrance", name: "Gentle Lift", cmds: [
    set("stdcolor", { vibrance: 52 }),
    set("exposure", { exposure: 0.4, shadows: 62 }),
  ]},
  { category: "Vibrance", name: "Market Colors", cmds: [
    set("stdcolor", { saturation: 28, vibrance: 58, temperature: 5750 }),
    set("exposure", { contrast: 40 }),
  ]},
  { category: "Vibrance", name: "Bloom", cmds: [
    set("stdcolor", { vibrance: 64, tint: 15 }),
    set("exposure", { highlights: -75, whites: 26 }),
  ]},
  { category: "Vibrance", name: "Electric Evening", cmds: [
    set("stdcolor", { vibrance: 70, temperature: 4500 }),
    set("exposure", { contrast: 42 }),
    set("cbal", { highlights_hue: 200, highlights_sat: 16 }),
  ]},
  // -- Cinematic: the graded frame. --
  { category: "Cinematic", name: "Teal Hour", cmds: [
    set("cbal", { shadows_hue: 190, shadows_sat: 26, highlights_hue: 35, highlights_sat: 16 }),
    set("exposure", { contrast: 40, blacks: -32 }),
    set("stdcolor", { saturation: 0 }),
  ]},
  { category: "Cinematic", name: "Night Runner", cmds: [
    set("stdcolor", { temperature: 4400, saturation: -8 }),
    set("exposure", { blacks: -44, contrast: 48 }),
    set("cbal", { shadows_hue: 210, shadows_sat: 20 }),
    set("grain", { intensity: 14 }),
  ]},
  { category: "Cinematic", name: "Neo Noir", cmds: [
    set("stdcolor", { saturation: -24 }),
    set("exposure", { contrast: 58, blacks: -40 }),
    set("cbal", { highlights_hue: 45, highlights_sat: 10 }),
    set("grain", { intensity: 16 }),
  ]},
  { category: "Cinematic", name: "Desert Chrome", cmds: [
    set("stdcolor", { temperature: 6400 }),
    set("detail", { clarity: 30 }),
    set("exposure", { highlights: -85, contrast: 42 }),
    set("cbal", { midtones_hue: 35, midtones_sat: 14 }),
  ]},
  { category: "Cinematic", name: "Steel Morning", cmds: [
    set("stdcolor", { temperature: 4600, saturation: -10 }),
    set("exposure", { contrast: 38 }),
    set("cbal", { shadows_hue: 220, shadows_sat: 16, midtones_hue: 210, midtones_sat: 8 }),
  ]},
  // -- Black & White: the silver looks. --
  { category: "Black & White", name: "Silver Classic", cmds: [
    set("bw", { amount: 100, red: 30, green: 59, blue: 11 }),
    set("exposure", { contrast: 44 }),
  ]},
  { category: "Black & White", name: "High Key", cmds: [
    set("bw", { amount: 100 }),
    set("exposure", { exposure: 0.7, shadows: 75, whites: 28, contrast: 10 }),
  ]},
  { category: "Black & White", name: "Low Key", cmds: [
    set("bw", { amount: 100 }),
    set("exposure", { blacks: -52, contrast: 55, shadows: 32 }),
  ]},
  { category: "Black & White", name: "Newsprint", cmds: [
    set("bw", { amount: 100 }),
    set("exposure", { contrast: 65 }),
    set("grain", { intensity: 46, size: 45 }),
  ]},
  { category: "Black & White", name: "Portrait Silver", cmds: [
    set("bw", { amount: 100, red: 55, green: 35, blue: 10 }),
    set("exposure", { shadows: 58 }),
    set("detail", { clarity: 5 }),
  ]},
  // -- Artistic: looks that admit they are looks. --
  { category: "Artistic", name: "Faded Memory", cmds: [
    set("stdcolor", { saturation: -14, temperature: 6100 }),
    set("exposure", { blacks: 24, highlights: -68, contrast: 4 }),
    set("grain", { intensity: 20 }),
  ]},
  { category: "Artistic", name: "Emberlight", cmds: [
    set("stdcolor", { temperature: 7200, tint: 17, vibrance: 44 }),
    set("exposure", { shadows: 34 }),
    set("cbal", { highlights_hue: 30, highlights_sat: 22 }),
  ]},
  { category: "Artistic", name: "Cyan Dream", cmds: [
    set("stdcolor", { temperature: 5050, saturation: -4 }),
    set("exposure", { contrast: 34 }),
    set("cbal", { midtones_hue: 195, midtones_sat: 20 }),
  ]},
  { category: "Artistic", name: "Cross Wind", cmds: [
    set("stdcolor", { saturation: 14 }),
    set("exposure", { contrast: 44 }),
    set("cbal", { shadows_hue: 90, shadows_sat: 16, highlights_hue: 300, highlights_sat: 14 }),
  ]},
  { category: "Artistic", name: "Matte Story", cmds: [
    set("stdcolor", { saturation: -8, temperature: 5850 }),
    set("exposure", { blacks: 26, contrast: 14 }),
    set("grain", { intensity: 14 }),
  ]},
];

describe("the built-in preset library", () => {
  it("every look builds, captures cleanly, and regenerates on demand", () => {
    const template = new Set(neutral().nodes.map((n) => n.id));
    const out = LOOKS.map((l) => {
      const s = author(l.cmds);
      const preset = capturePreset(s, l.name);
      // Sanity every generation: a chain with an output, no photo
      // facts, no dangling wires.
      expect(preset.nodes.some((n) => n.type === "heeler.output")).toBe(true);
      expect(preset.nodes.some((n) => /^layer_\d+_/.test(n.id))).toBe(false);
      const ids = new Set(preset.nodes.map((n) => n.id));
      expect(preset.wires.every((w) => ids.has(w.from) && ids.has(w.to))).toBe(true);
      // And the library's own contract: nothing bypassed, nothing at
      // its defaults beyond the template, no exposure lift past 0.7 EV.
      for (const n of preset.nodes) {
        expect(n.enabled, `${l.name}: ${n.id} rides along switched off`).not.toBe(false);
        if (template.has(n.id)) continue;
        const neutralParams = NEUTRAL_PARAMS[n.type] ?? {};
        const says = Object.entries(n.params).some(([k, v]) => (neutralParams[k] ?? 0) !== v);
        expect(says, `${l.name}: ${n.id} sits at its defaults and does nothing`).toBe(true);
      }
      const exposure = preset.nodes.find((n) => n.id === "exposure")!.params.exposure ?? 0;
      expect(exposure, `${l.name} lifts exposure by ${exposure}`).toBeLessThanOrEqual(0.7);
      return { category: l.category, preset };
    });
    expect(out).toHaveLength(25);
    const env = (globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env;
    if (env?.GEN_PRESETS === "1") {
      // Specifier through a variable so the app tsconfig (no node
      // types) does not try to resolve the node built-ins.
      const load = (m: string) =>
        import(/* @vite-ignore */ m) as Promise<{
          writeFileSync?: (p: string, d: string) => void;
          resolve?: (...s: string[]) => string;
        }>;
      const cwd = (globalThis as { process?: { cwd(): string } }).process!.cwd();
      return Promise.all([load("fs"), load("path")]).then(([fs, path]) => {
        const dest = path.resolve!(cwd, "src-tauri/presets/builtin.json");
        fs.writeFileSync!(dest, JSON.stringify(out, null, 1));
      });
    }
  });
});
