// keylightgizmo.tsx's values and helpers that are not components, kept apart so
// keylightgizmo.tsx exports components alone and Vite can refresh it in place as
// it is edited instead of reloading the window.
import React from "react";
import { type Command, type NodeCard } from "../state";

export type D = React.Dispatch<Command>;

export type KeyLight = {
  kind: "directional" | "point";
  azimuth: number;
  elevation: number;
  strength: number;
  /** Off keeps the light's settings without its push. */
  on: boolean;
  /** Display hex; white is neutral. */
  color: string;
  /** directional: the target the gizmo anchors on (display only). */
  tx: number;
  ty: number;
  /** point: where the lamp sits, its place along the near-far axis (0
   * nearest, 100 farthest - "height is actually depth"),
   * and how far its push reaches.*/
  px: number;
  py: number;
  depth: number;
  range: number;
  /** directional: the plane it lands hardest on along the near-far axis
   * (0 nearest, the light as it always was; 100 farthest), and how far
   * it carries along depth from there (50 the falloff it always had, 100
   * every plane alike). Its own pair, not the lamp's: every saved
   * directional light carries the lamp's default depth of 30, which goes
   * on meaning nothing to it (2026-10-03: "We added a depth slider for
   * point light but not directional").*/
  sun_depth: number;
  sun_reach: number;
  /** the Lens Flare section draws this light's flare*/
  flare: boolean;
  /** this light's flare intensity, relative to the section's */
  flare_strength: number;
};

export const LIGHT_DEFAULTS: Omit<KeyLight, "azimuth" | "elevation" | "strength"> = {
  kind: "directional",
  on: true,
  color: "#ffffff",
  tx: 0.5,
  ty: 0.5,
  px: 0.5,
  py: 0.5,
  depth: 30,
  range: 50,
  sun_depth: 0,
  sun_reach: 50,
  flare: false,
  flare_strength: 100,
};

/** The rig: the lights JSON when it has any, else the node's legacy
 * single-directional params seeded into rig shape. */
export function lightsOf(node: NodeCard): KeyLight[] {
  let list: Partial<KeyLight>[] = [];
  try {
    list = JSON.parse(node.textParams?.lights ?? "[]") as Partial<KeyLight>[];
  } catch {
    list = [];
  }
  if (list.length === 0) {
    return [
      {
        ...LIGHT_DEFAULTS,
        azimuth: (node.params.azimuth as number) ?? 45,
        elevation: (node.params.elevation as number) ?? 45,
        strength: oldStrength((node.params.strength as number) ?? 0),
      },
    ];
  }
  return list.map((l) => {
    const { power, ...rest } = l as Partial<KeyLight> & { power?: number };
    return {
      ...LIGHT_DEFAULTS,
      azimuth: 45,
      elevation: 45,
      // Rigs saved under the old name carry over.
      ...("height" in rest ? { depth: (rest as { height?: number }).height } : {}),
      ...rest,
      strength: typeof power === "number" ? power : oldStrength(rest.strength ?? 0),
    };
  }) as KeyLight[];
}

/** Strength's range: -100 to 100, saved as each light's `power`
 * (2026-10-08: "it goes to 200 which is odd (vs 100) and seems
 * arbitrary... Also increase the calculated strength by 50%"); the
 * engine reads 100 as three times the light (ops_depth POWER_SCALE). */
export const STRENGTH_MAX = 100;

/** A strength saved before, on the old -200 to 200 scale, in the new
 * one: half the number, the same place on the slider, 50% stronger as
 * the owner chose (the engine reads it the same way). */
export function oldStrength(saved: number): number {
  return saved / 2;
}

/** Writes the WHOLE rig. Once this runs, the JSON is the truth and
 * the legacy params go quiet (the engine's rule). */
export function writeLights(dispatch: D, node: NodeCard, lights: KeyLight[]) {
  dispatch({
    type: "set_text_param",
    id: node.id,
    param: "lights",
    // Strength is saved as power, the scale since 2026-10-08, and the
    // old key goes so nothing reads it twice.
    value: JSON.stringify(lights.map(({ strength, ...rest }) => ({ ...rest, power: strength }))),
  });
  if (lights.length === 0) {
    // Emptying the rig must not resurrect the legacy params light.
    dispatch({ type: "set_params", id: node.id, values: { strength: 0 }, text: {} });
  }
}

/** Where a light's FLARE comes from, in frame coordinates: the engine's
 * light_position, mirrored. A point lamp flares where it stands; a
 * directional light has no place, only a direction, so its flare
 * comes from where that direction meets the frame edge, its elevation
 * setting how far past the edge the source sits. Drawn in the rig so
 * the handle (an aiming control) and the source (where the flare is)
 * stop being mistaken for each other. */
export function flareSourceOf(l: KeyLight, aspect: number): [number, number] {
  if (l.kind === "point") return [l.px, l.py];
  const a = (l.azimuth * Math.PI) / 180;
  const dir: [number, number] = [Math.cos(a) / Math.max(1e-6, aspect), -Math.sin(a)];
  const tx = Math.abs(dir[0]) > 1e-6 ? 0.5 / Math.abs(dir[0]) : Infinity;
  const ty = Math.abs(dir[1]) > 1e-6 ? 0.5 / Math.abs(dir[1]) : Infinity;
  const t = Math.min(tx, ty) * (1 + (Math.min(90, Math.max(0, l.elevation)) / 90) * 0.8);
  return [0.5 + dir[0] * t, 0.5 + dir[1] * t];
}
