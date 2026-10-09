// Lens Character: one preset across the optical sections, in one step.
import { describe, expect, it } from "vitest";
import { initialState } from "../data";
import { CATEGORY_PIECES } from "../recipes";
import {
  LENS_CHARACTERS,
  NEUTRAL_PARAMS,
  PARAM_RANGE,
  spliceOut,
  characterApertureDoor,
  characterFlareDoor,
  reduce,
  suggestLensCharacter,
  type Command,
  type NodeCard,
  type State
} from "../state";


const run = (s: State, ...cmds: Command[]) => cmds.reduce(reduce, s);
const node = (s: State, id: string) => s.nodes.find((n) => n.id === id);

describe("lens character", () => {
  it("every preset names sections that exist and dials those sections' nodes carry", () => {
    for (const c of LENS_CHARACTERS) {
      for (const [title, write] of Object.entries(c.writes)) {
        const pieces = CATEGORY_PIECES[title];
        expect(pieces, `${c.id} names an unknown section ${title}`).toBeDefined();
        const neutral = NEUTRAL_PARAMS[pieces![0].type] ?? {};
        for (const k of Object.keys(write.values ?? {})) {
          const known = k in neutral || k in PARAM_RANGE;
          expect(known, `${c.id}/${title} writes an unknown dial ${k}`).toBe(true);
        }
      }
      expect(c.writes["Depth of Field"], `${c.id} must write Depth of Field, the stamp's home`).toBeDefined();
    }
  });

  it("leaves the sections it wrote folded as they were", () => {
    // Every written section springing open at once was "a
    // bit much to take in". The summary says what was set; the sections
    // keep their fold.
    const before = initialState();
    const after = run(before, { type: "apply_lens_character", id: "helios" });
    expect(after.sectionsClosed).toEqual(before.sectionsClosed);
    for (const title of Object.keys(LENS_CHARACTERS[0].writes)) {
      if (before.sectionsClosed.includes(title)) expect(after.sectionsClosed).toContain(title);
    }
  });

  it("applies across sections, builds the ones that are off, stamps, and undoes in one step", () => {
    const start = initialState();
    // The demo carries the depth tools off; Halation and the flare too.
    // Strip Recolor entirely so a section gets built on the way.
    const bare = { ...start, nodes: start.nodes.filter((n) => n.id !== "recolor"), wires: start.wires.filter((w) => w.from !== "recolor" && w.to !== "recolor") } as State;
    const s = run(bare, { type: "apply_lens_character", id: "helios" });
    const dof = s.nodes.find((n) => n.id === "dof")!;
    expect(dof.enabled).toBe(true);
    expect(dof.params.swirl).toBe(80);
    expect(dof.textParams?.character).toBe("helios");
    expect(s.nodes.find((n) => n.id === "halation")!.enabled).toBe(true);
    expect(s.nodes.find((n) => n.id === "vignette")!.params.vignette).toBe(-45);
    const recolor = s.nodes.find((n) => n.id === "recolor");
    expect(recolor, "Recolor was built on the way").toBeDefined();
    expect(JSON.parse(recolor!.textParams!.curves)).toHaveProperty("lum_temp");
    // The aperture is the photograph's: untouched.
    expect(dof.params.aperture).toBe(0);
    // One undo step puts all of it back.
    const back = run(s, { type: "undo" });
    expect(back.nodes.find((n) => n.id === "dof")!.params.swirl).toBe(0);
    expect(back.nodes.some((n) => n.id === "recolor")).toBe(false);
  });

  it("merges the coating curve into Recolor's cells rather than replacing them", () => {
    let s = initialState();
    s = run(s, { type: "set_category", title: "Recolor", on: true });
    s = run(s, { type: "set_text_param", id: "recolor", param: "curves", value: '{"hue_sat":[{"x":0,"y":50},{"x":180,"y":0}]}' });
    s = run(s, { type: "apply_lens_character", id: "takumar" });
    const curves = JSON.parse(s.nodes.find((n) => n.id === "recolor")!.textParams!.curves);
    expect(Object.keys(curves).sort()).toEqual(["hue_sat", "lum_temp"]);
  });

  it("suggests from the lens name and stays quiet otherwise", () => {
    expect(suggestLensCharacter("Helios 44-2 58mm f/2")).toBe("helios");
    expect(suggestLensCharacter("Asahi Super-Takumar 50mm")).toBe("takumar");
    expect(suggestLensCharacter("Jupiter-9 85mm f/2")).toBe("jupiter9");
    expect(suggestLensCharacter("Canon 50mm f/0.95")).toBe("canon095");
    expect(suggestLensCharacter("XF 35mm F1.4 R")).toBeNull();
    expect(suggestLensCharacter(null)).toBeNull();
  });

  it("writes only what a source supports: no neutral padding for leak coverage", () => {
    // The leak is closed by the apply taking the previous character's
    // writes back, not by every character writing every dial any
    // character touches. So a lens with nothing to say about a dial
    // says nothing: no bloom 0, no empty ribbon, no clarity 0.
    for (const c of LENS_CHARACTERS) {
      // A bloom is a fact only when there is one (the uncoated lens's).
      expect(c.writes.Halation?.values?.bloom ?? 1, `${c.id} pads halation bloom`).not.toBe(0);
      // A ribbon is a fact only when there is one (the anamorphic's).
      expect(c.writes["Lens Flare"]?.text?.streak_stops ?? "x", `${c.id} pads the ribbon`).not.toBe("");
      for (const [title, write] of Object.entries(c.writes)) {
        for (const [k, v] of Object.entries(write.values ?? {})) {
          const neutral = NEUTRAL_PARAMS[CATEGORY_PIECES[title]![0].type]?.[k];
          // A neutral write is padding unless the fact is "this lens has
          // none of it" where its neighbors have some: distortion 0 and
          // swirl 0 are such facts, the streak dials at their defaults are not.
          if (v === neutral && ["anamorphic", "streak_size", "streak_length", "streak_taper", "streak_noise", "clarity", "bloom"].includes(k))
            throw new Error(`${c.id}/${title}/${k} writes its neutral ${v}`);
        }
      }
    }
  });

  it("takes the previous character's writes back to what they overwrote before writing the next", () => {
    // Helios writes Detail clarity -5 and a warm coating curve; Petzval
    // writes neither. The user had clarity at 7 and a curve of their
    // own. After Helios then Petzval, clarity is 7 again and only the
    // user's curve is left, while a dial the user set in a section no
    // character writes (Grain) is untouched throughout.
    let s = run(initialState(), { type: "set_category", title: "Grain", on: true });
    s = run(s, { type: "set_param", id: "grain", param: "intensity", value: 33 });
    s = run(s, { type: "set_category", title: "Detail", on: true });
    s = run(s, { type: "set_param", id: "detail", param: "clarity", value: 7 });
    s = run(s, { type: "set_category", title: "Recolor", on: true });
    s = run(s, { type: "set_text_param", id: "recolor", param: "curves", value: '{"hue_sat":[{"x":0,"y":10},{"x":180,"y":-10}]}' });
    s = run(s, { type: "apply_lens_character", id: "helios" });
    expect(node(s, "detail")!.params.clarity).toBe(-5);
    expect(Object.keys(JSON.parse(node(s, "recolor")!.textParams!.curves)).sort()).toEqual(["hue_sat", "lum_temp"]);
    s = run(s, { type: "apply_lens_character", id: "petzval" });
    expect(node(s, "detail")!.params.clarity).toBe(7);
    expect(Object.keys(JSON.parse(node(s, "recolor")!.textParams!.curves)).sort()).toEqual(["hue_sat", "lum_temp"]);
    expect(node(s, "grain")!.params.intensity).toBe(33);
    // Petzval then Canon (no coating curve at all): only the user's curve.
    s = run(s, { type: "apply_lens_character", id: "canon095" });
    expect(Object.keys(JSON.parse(node(s, "recolor")!.textParams!.curves))).toEqual(["hue_sat"]);
    // The aperture the door opened is not a character's write: it stays.
    s = run(s, { type: "set_param", id: "dof", param: "aperture", value: 40 });
    s = run(s, { type: "apply_lens_character", id: "helios" });
    expect(node(s, "dof")!.params.aperture).toBe(40);
  });

  it("applying a character after another lands on the second's look, not a blend", () => {
    // The leak, made concrete: anamorphic's streak used to survive every
    // later character because none of them wrote the streak dials. Now
    // the apply takes the previous character's writes back first, so
    // every section the second character writes reads exactly as it
    // does applied alone, and a section only the first one built is
    // switched off rather than left on and empty.
    const strip = (n: NodeCard) => {
      const { character_prior: _p, ...text } = n.textParams ?? {};
      return { ...n, textParams: text };
    };
    for (const a of LENS_CHARACTERS) {
      for (const b of LENS_CHARACTERS) {
        if (a === b) continue;
        const viaA = run(initialState(), { type: "apply_lens_character", id: a.id }, { type: "apply_lens_character", id: b.id });
        const direct = run(initialState(), { type: "apply_lens_character", id: b.id });
        for (const n of direct.nodes) {
          const m = viaA.nodes.find((x) => x.id === n.id);
          expect(strip(m!), `${a.id} then ${b.id}: ${n.id} should equal ${b.id} alone`).toEqual(strip(n));
        }
        for (const m of viaA.nodes) {
          if (direct.nodes.some((n) => n.id === m.id)) continue;
          expect(m.enabled, `${a.id} then ${b.id}: ${m.id} left on`).toBe(false);
        }
      }
    }
  });
});

describe("the lens character doors", () => {
  // The rig the flare chip writes: one point light at the frame's
  // brightest point, flare on at the character's strength, strength 0
  // because the door adds a flare, not a relight.
  const RIG = JSON.stringify([
    {
      kind: "point",
      azimuth: 45,
      elevation: 45,
      strength: 0,
      on: true,
      color: "#ffffff",
      tx: 0.5,
      ty: 0.5,
      px: 0.7,
      py: 0.3,
      depth: 30,
      range: 50,
      flare: true,
      flare_strength: 100,
    },
  ]);
  const LIGHT = JSON.parse(RIG)[0] as Record<string, unknown>;

  it("every character carries a cited wide-open aperture for the door", () => {
    for (const c of LENS_CHARACTERS) {
      expect(c.aperture, `${c.id} aperture on the 0..100 dial`).toBeGreaterThan(0);
      expect(c.aperture, `${c.id} aperture on the 0..100 dial`).toBeLessThanOrEqual(100);
    }
  });

  it("the apply still writes no aperture and no flaring light", () => {
    // The doors exist because the apply must not
    // (aperture is a photograph decision, not a lens fact). The
    // pinned aperture assertion above stands; this adds the light
    // half.
    const s = run(initialState(), { type: "apply_lens_character", id: "helios" });
    expect(s.nodes.find((n) => n.id === "dof")!.params.aperture).toBe(0);
    for (const id of ["keylight", "flare"]) {
      const raw = s.nodes.find((n) => n.id === id)!.textParams?.lights ?? "[]";
      expect(JSON.parse(raw).some((l: { flare?: boolean }) => l.flare), `${id} gained a flaring light`).toBe(false);
    }
  });

  it("the aperture door shows only with a character applied and the aperture still at zero", () => {
    expect(characterApertureDoor(initialState())).toBeNull();
    let s = run(initialState(), { type: "apply_lens_character", id: "helios" });
    expect(characterApertureDoor(s)?.character.id).toBe("helios");
    expect(characterApertureDoor(s)?.face).toBe("aperture");
    // An open aperture with no focus yet turns the same chip into its
    // second face (no automatic retry; one explicit click for
    // the focus), and a focus closes it, whoever set either.
    s = run(s, { type: "set_param", id: "dof", param: "aperture", value: 40 });
    expect(characterApertureDoor(s)?.face).toBe("focus");
    s = run(s, { type: "set_param", id: "dof", param: "focus", value: 52 });
    expect(characterApertureDoor(s)).toBeNull();
  });

  it("the aperture door stays hidden on a graph with no Depth of Field node", () => {
    const applied = run(initialState(), { type: "apply_lens_character", id: "helios" });
    const bare = {
      ...applied,
      nodes: applied.nodes.filter((n) => n.id !== "dof"),
      wires: applied.wires.filter((w) => w.from !== "dof" && w.to !== "dof"),
    } as State;
    expect(characterApertureDoor(bare)).toBeNull();
  });

  it("the aperture click writes aperture and focus, and undoes in one step of its own", () => {
    const applied = run(initialState(), { type: "apply_lens_character", id: "helios" });
    const ch = LENS_CHARACTERS.find((c) => c.id === "helios")!;
    // Exactly the command the chip dispatches (lenscharacter.tsx).
    const s = run(applied, { type: "set_params", id: "dof", values: { aperture: ch.aperture, focus: 52 } });
    const dof = s.nodes.find((n) => n.id === "dof")!;
    expect(dof.params.aperture).toBe(ch.aperture);
    expect(dof.params.focus).toBe(52);
    expect(dof.enabled).toBe(true);
    // One undo takes the door's write back; the apply under it stands.
    const back = run(s, { type: "undo" });
    const backDof = back.nodes.find((n) => n.id === "dof")!;
    expect(backDof.params.aperture).toBe(0);
    expect(backDof.params.swirl).toBe(80);
    expect(backDof.textParams?.character).toBe("helios");
    // And the door shows again.
    expect(characterApertureDoor(back)?.character.id).toBe("helios");
  });

  it("the flare door shows only when a character is applied and no rig light flares", () => {
    expect(characterFlareDoor(initialState())).toBeNull();
    let s = run(initialState(), { type: "apply_lens_character", id: "helios" });
    expect(characterFlareDoor(s)?.id).toBe("helios");
    // A non-flaring light does not close the door.
    s = run(s, {
      type: "set_text_param",
      id: "keylight",
      param: "lights",
      value: JSON.stringify([{ kind: "point", on: true, flare: false }]),
    });
    expect(characterFlareDoor(s)?.id).toBe("helios");
    // A flaring light that is OFF does not close it either.
    s = run(s, {
      type: "set_text_param",
      id: "keylight",
      param: "lights",
      value: JSON.stringify([{ kind: "point", on: false, flare: true }]),
    });
    expect(characterFlareDoor(s)?.id).toBe("helios");
    // A live flaring light does.
    s = run(s, { type: "set_text_param", id: "keylight", param: "lights", value: RIG });
    expect(characterFlareDoor(s)).toBeNull();
  });

  it("the flare door shows with no Depth Lighting node, and the click builds it", () => {
    // A photograph that never touched Depth Lighting is the commonest
    // one whose flare signature cannot show; the door must open there.
    const applied = run(initialState(), { type: "apply_lens_character", id: "helios" });
    const bare = {
      ...applied,
      nodes: applied.nodes.filter((n) => n.id !== "keylight"),
      wires: spliceOut(applied.wires, "keylight"),
    } as State;
    expect(characterFlareDoor(bare)?.id).toBe("helios");
    const s = run(bare, { type: "add_character_flare_light", light: LIGHT });
    const keylight = node(s, "keylight")!;
    expect(keylight.enabled).toBe(true);
    expect(s.wires.some((w) => w.to === "keylight" && w.toPort === "in")).toBe(true);
    expect(JSON.parse(keylight.textParams!.lights)).toHaveLength(1);
    expect(characterFlareDoor(s)).toBeNull();
    // One undo takes the light AND the built section back.
    const back = run(s, { type: "undo" });
    expect(node(back, "keylight")).toBeUndefined();
  });

  it("the flare light lands on both rig nodes and undoes in one step of its own", () => {
    const applied = run(initialState(), { type: "apply_lens_character", id: "helios" });
    // Exactly the command the chip dispatches.
    const s = run(applied, { type: "add_character_flare_light", light: LIGHT });
    for (const id of ["keylight", "flare"]) {
      const lights = JSON.parse(s.nodes.find((n) => n.id === id)!.textParams!.lights);
      expect(lights, `${id} holds the rig`).toHaveLength(1);
      expect(lights[0]).toMatchObject({ flare: true, flare_strength: 100, px: 0.7, py: 0.3, power: 0 });
    }
    const back = run(s, { type: "undo" });
    for (const id of ["keylight", "flare"]) {
      const raw = back.nodes.find((n) => n.id === id)!.textParams?.lights ?? "[]";
      expect(JSON.parse(raw), `${id}'s rig is empty again`).toHaveLength(0);
    }
    // The apply under the door stands: the character's flare dials.
    expect(back.nodes.find((n) => n.id === "flare")!.params.veil).toBe(35);
  });
});
