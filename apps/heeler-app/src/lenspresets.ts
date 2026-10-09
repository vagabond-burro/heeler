// User lens presets: named snapshots of the COMPLETE Lens Correction
// state, for the vintage and unchipped glass no profile database will
// ever cover. A preset is static on purpose: the lenses it exists for
// write no focal length or aperture, so the name is where "f/2" lives.
// Perspective is deliberately not captured (the product decision):
// keystone is a fact about the photo, not the lens.

import type { NodeCard } from "./state";

export interface LensPreset {
  id: string;
  name: string;
  params: Record<string, number>;
  text: Record<string, string>;
}

/** Every numeric parameter a preset carries, with its neutral value.
 * This list is the contract: capture reads exactly these, apply writes
 * exactly these. Unknown keys in a stored preset are dropped (a later
 * version may retire a parameter), missing keys apply as neutral, so a
 * photo can never inherit half of one lens and half of another. */
export const LENS_NEUTRAL: Record<string, number> = {
  distortion: 0,
  ca_red: 0,
  ca_blue: 0,
  vignette: 0,
  vignette_mid: 50,
  dist_a: 0,
  dist_b: 0,
  dist_c: 0,
  dist_scale: 1,
  tca_vr: 1,
  tca_cr: 0,
  tca_br: 0,
  tca_vb: 1,
  tca_cb: 0,
  tca_bb: 0,
  vig_k1: 0,
  vig_k2: 0,
  vig_k3: 0,
};

export const LENS_TEXT_NEUTRAL: Record<string, string> = { dist_model: "none" };

/** The provenance marker: which preset a photo's lens state came from.
 * Written on apply, cleared by a lensfun profile apply, shown by the
 * panel's profile line. Deliberately NOT part of the capture contract:
 * a preset records corrections, not the name of an older preset. */
export const LENS_PRESET_MARKER = "lens_preset";

/** The Lens Correction node's current state as a preset. Only the
 * contracted keys are read; anything else on the node is not lens
 * correction and does not belong to the lens. */
export function captureLensPreset(name: string, node: NodeCard, id?: string): LensPreset {
  const params: Record<string, number> = {};
  for (const key of Object.keys(LENS_NEUTRAL)) {
    const v = node.params[key];
    params[key] = typeof v === "number" && Number.isFinite(v) ? v : LENS_NEUTRAL[key];
  }
  const text: Record<string, string> = {};
  for (const key of Object.keys(LENS_TEXT_NEUTRAL)) {
    text[key] = node.textParams?.[key] ?? LENS_TEXT_NEUTRAL[key];
  }
  return { id: id ?? `lp${Date.now()}`, name, params, text };
}

/** What applying a preset writes: the full contracted parameter set,
 * neutral where the preset is silent, nothing where the preset says
 * something this build has never heard of. */
export function lensPresetValues(preset: LensPreset): {
  values: Record<string, number>;
  text: Record<string, string>;
} {
  const values: Record<string, number> = {};
  for (const key of Object.keys(LENS_NEUTRAL)) {
    const v = preset.params?.[key];
    values[key] = typeof v === "number" && Number.isFinite(v) ? v : LENS_NEUTRAL[key];
  }
  const text: Record<string, string> = {};
  for (const key of Object.keys(LENS_TEXT_NEUTRAL)) {
    const v = preset.text?.[key];
    text[key] = typeof v === "string" && v ? v : LENS_TEXT_NEUTRAL[key];
  }
  // Applying stamps the photo with where these numbers came from.
  text[LENS_PRESET_MARKER] = preset.name;
  return { values, text };
}

/** Parse a stored preset list, tolerating anything: a corrupt blob is
 * an empty list, not a failure. The next save overwrites it. */
export function parseLensPresets(json: string | null): LensPreset[] {
  if (!json) return [];
  try {
    const parsed: unknown = JSON.parse(json);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (p): p is LensPreset =>
        !!p &&
        typeof p === "object" &&
        typeof (p as LensPreset).id === "string" &&
        typeof (p as LensPreset).name === "string" &&
        !!(p as LensPreset).params &&
        typeof (p as LensPreset).params === "object",
    );
  } catch {
    return [];
  }
}

/** Save semantics: a name identifies a preset, so saving under an
 * existing name (case-insensitive) replaces it in place; a new name
 * appends. That is what a name means. */
export function upsertLensPreset(list: LensPreset[], preset: LensPreset): LensPreset[] {
  const at = list.findIndex((p) => p.name.trim().toLowerCase() === preset.name.trim().toLowerCase());
  if (at < 0) return [...list, preset];
  const next = [...list];
  next[at] = { ...preset, id: list[at].id };
  return next;
}
