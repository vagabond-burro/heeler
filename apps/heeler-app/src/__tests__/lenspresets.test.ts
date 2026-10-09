import { describe, expect, it } from "vitest";
import {
  captureLensPreset,
  LENS_NEUTRAL,
  lensPresetValues,
  parseLensPresets,
  upsertLensPreset,
} from "../lenspresets";
import { initialState } from "../data";
import { reduce, type State } from "../state";

function lensOf(s: State) {
  return s.nodes.find((n) => n.type === "heeler.lens_correct")!;
}

describe("lens presets", () => {
  it("capture then apply is the identity on the node", () => {
    // The whole point: dial in a vintage lens once, get exactly that
    // state back on any other photo.
    let s = reduce(initialState(), {
      type: "set_params",
      id: "lens",
      values: { distortion: -12, vignette: 30, dist_a: 0.02, tca_vr: 1.0006 },
      text: { dist_model: "ptlens" },
    });
    const saved = captureLensPreset("Helios 44-2 f/2", lensOf(s), "lp1");
    // A different photo's lens node, carrying some OTHER lens's state.
    s = reduce(s, {
      type: "set_params",
      id: "lens",
      values: { distortion: 40, vignette: 0, dist_a: 0, tca_vr: 1, vig_k1: -0.9 },
      text: { dist_model: "none" },
    });
    const { values, text } = lensPresetValues(saved);
    s = reduce(s, { type: "set_params", id: "lens", values, text });
    const lens = lensOf(s);
    expect(lens.params.distortion).toBe(-12);
    expect(lens.params.vignette).toBe(30);
    expect(lens.params.dist_a).toBeCloseTo(0.02);
    expect(lens.params.tca_vr).toBeCloseTo(1.0006);
    // The other lens's vignetting did NOT survive: apply writes the
    // full contract, neutral where the preset is silent.
    expect(lens.params.vig_k1).toBe(0);
    expect(lens.textParams?.dist_model).toBe("ptlens");
    // The photo is stamped with where its numbers came from, so the
    // panel can say so when the photo comes back.
    expect(lens.textParams?.lens_preset).toBe("Helios 44-2 f/2");
    // But capturing a NEW preset from this node does not embed the old
    // marker: a preset records corrections, not provenance.
    const again = captureLensPreset("Another", lens, "lp9");
    expect("lens_preset" in again.text).toBe(false);
  });

  it("unknown stored keys are dropped and missing keys neutralize", () => {
    // A preset saved by a future build (or a corrupted one) must apply
    // as lens correction, not as arbitrary parameter injection.
    const { values, text } = lensPresetValues({
      id: "x",
      name: "odd",
      params: { distortion: 5, retired_knob: 99, exposure: 4 },
      text: { dist_model: "poly3", mystery: "boo" },
    });
    expect(values.distortion).toBe(5);
    expect("retired_knob" in values).toBe(false);
    expect("exposure" in values).toBe(false);
    expect(values.dist_scale).toBe(1);
    expect(values.tca_vr).toBe(1);
    expect(text.dist_model).toBe("poly3");
    expect("mystery" in text).toBe(false);
    // The contract covers every parameter, every time.
    expect(Object.keys(values).sort()).toEqual(Object.keys(LENS_NEUTRAL).sort());
  });

  it("round-trips through the stored JSON shape and shrugs at corruption", () => {
    const p = captureLensPreset("XF50 wide open", lensOf(initialState()), "lp2");
    const back = parseLensPresets(JSON.stringify([p]));
    expect(back).toEqual([p]);
    expect(parseLensPresets(null)).toEqual([]);
    expect(parseLensPresets("not json {")).toEqual([]);
    expect(parseLensPresets('{"a":1}')).toEqual([]);
    expect(parseLensPresets('[{"junk":true}, 3]')).toEqual([]);
  });

  it("saving under an existing name replaces, keeping the old id", () => {
    const a = captureLensPreset("Takumar 50", lensOf(initialState()), "lpA");
    const b = { ...captureLensPreset("takumar 50", lensOf(initialState()), "lpB"), params: { ...a.params, distortion: 7 } };
    const list = upsertLensPreset(upsertLensPreset([], a), b);
    expect(list.length).toBe(1);
    expect(list[0].id).toBe("lpA");
    expect(list[0].params.distortion).toBe(7);
    // A genuinely new name appends.
    const c = captureLensPreset("Jupiter-8", lensOf(initialState()), "lpC");
    expect(upsertLensPreset(list, c).length).toBe(2);
  });
});
