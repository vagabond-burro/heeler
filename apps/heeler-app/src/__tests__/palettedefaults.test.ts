// the defaults half: a Luminance Mask added from the node palette showed
// Low 0.00, High 0.00, Feather 0.00 in the Inspector, where its registry
// says 0, 1 and 0.1. A palette node arrives with empty params, the
// Inspector shows an unset dial at paramDefault, and nothing paramDefault
// consulted knew this type, so it fell to the table keyed on the word and
// then to zero. The same happened to about twenty dials on other palette
// nodes (Channel Gain's gain, Smart Mask's threshold, the logic family,
// Bevel, Gradient, Output's quality). These sweep every palette node type
// against the engine's registry.
import { describe, expect, it } from "vitest";
import { reduce, REGISTRY_DEFAULTS, TYPE_NUM_PARAMS, type State } from "../state";
import { makeNode, NODE_CATALOG } from "../nodes";
import { initialState } from "../data";
import { paramDefault } from "../ui/simple";

/** num(...) and flag(...) inside each type_name block of spec.rs, the
 * same parse state.test.ts makes, flags as 0 and 1. */
async function registryFromSpec(): Promise<Record<string, Record<string, number>>> {
  const { readFileSync } = await import("node:fs");
  const { resolve } = await import("node:path");
  const spec = readFileSync(resolve(process.cwd(), "../../crates/heeler-graph/src/spec.rs"), "utf8");
  const registry: Record<string, Record<string, number>> = {};
  for (const m of spec.matchAll(/type_name:\s*"([^"]+)"\.into\(\),(.*?)inputs:/gs)) {
    const [, type, body] = m;
    for (const pm of body.matchAll(/num\("(\w+)",\s*([-\d.]+),/g)) (registry[type] ??= {})[pm[1]] = Number(pm[2]);
    for (const pm of body.matchAll(/flag\("(\w+)",\s*(true|false)\)/g)) (registry[type] ??= {})[pm[1]] = pm[2] === "true" ? 1 : 0;
  }
  return registry;
}

/** The deliberate deviations, each with its reason where it lives:
 * PARAM_DEFAULT_BY_TYPE (the shipped look, full B&W strength) and
 * NEUTRAL_PARAMS (a photograph starts undenoised; grain's frame sizing is
 * opted into by fresh graphs, and missing means the legacy pixel size). */
const DELIBERATE = new Set([
  "heeler.tone_profile.baseline_ev",
  "heeler.tone_profile.shadow_toe",
  "heeler.tone_profile.highlight_rolloff",
  "heeler.black_white.amount",
  "heeler.model_denoise.luminance",
  "heeler.model_denoise.chroma",
  "heeler.grain.by_frame",
]);

function addFromPalette(type: string): { s: State; id: string } {
  const spec = NODE_CATALOG.find((n) => n.type === type)!;
  const id = `palette_${type.replace("heeler.", "")}`;
  // What addNodeAt dispatches: makeNode's empty params, placed beside.
  const s = reduce(initialState(), { type: "add_node", node: makeNode(spec, id, 40, 40), place: "at" });
  return { s, id };
}

describe("a node placed from the palette carries its registry defaults", () => {
  it("the frontend's registry mirror is the registry spec.rs declares", async () => {
    const parsed = await registryFromSpec();
    expect(Object.keys(parsed).length).toBeGreaterThan(40);
    const wrong: string[] = [];
    for (const [type, params] of Object.entries(parsed)) {
      for (const [p, d] of Object.entries(params)) {
        if (REGISTRY_DEFAULTS[type]?.[p] !== d) wrong.push(`${type}.${p}: mirror ${REGISTRY_DEFAULTS[type]?.[p]}, spec ${d}`);
      }
    }
    expect(wrong, wrong.join("\n")).toEqual([]);
  });

  it("a Luminance Mask from the palette reads Low 0, High 1, Feather 0.1", () => {
    const { s, id } = addFromPalette("heeler.luminance_range_mask");
    const n = s.nodes.find((k) => k.id === id)!;
    expect(n.params.low).toBe(0);
    expect(n.params.high).toBe(1);
    expect(n.params.feather).toBeCloseTo(0.1, 9);
    expect(paramDefault("high", n.type)).toBe(1);
    expect(paramDefault("feather", n.type)).toBeCloseTo(0.1, 9);
  });

  it("every palette node type shows and stores its registry defaults", async () => {
    const registry = await registryFromSpec();
    const wrong: string[] = [];
    let checked = 0;
    for (const spec of NODE_CATALOG) {
      const declared = registry[spec.type];
      if (!declared) continue;
      const { s, id } = addFromPalette(spec.type);
      const n = s.nodes.find((k) => k.id === id)!;
      for (const [p, d] of Object.entries(declared)) {
        if (DELIBERATE.has(`${spec.type}.${p}`)) continue;
        checked++;
        const stored = n.params[p];
        const shown = stored ?? paramDefault(p, spec.type);
        if (Math.abs(shown - d) > 1e-9) wrong.push(`${spec.type}.${p}: shows ${shown}, registry ${d}`);
        // Every dial the Inspector offers is written, not left for the
        // display to guess.
        if ((TYPE_NUM_PARAMS[spec.type] ?? []).includes(p) && stored === undefined) {
          wrong.push(`${spec.type}.${p}: an Inspector dial left unset`);
        }
      }
    }
    expect(checked).toBeGreaterThan(200);
    expect(wrong, wrong.join("\n")).toEqual([]);
  });
});
