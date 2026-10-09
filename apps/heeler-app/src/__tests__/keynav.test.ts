import { describe, expect, it } from "vitest";
import {
  NAV_START,
  assignHints,
  flatten,
  handleKey,
  legend,
  moveWheel,
  quantize,
  step,
  stepFor,
  type NavTarget,
  type SectionTargets,
} from "../keynav";

const t = (section: string, label: string, param: string, kind: "slider" | "wheel" = "slider"): NavTarget => ({
  section,
  label,
  param,
  kind,
  nodeId: "n",
});

const PANEL: SectionTargets[] = [
  {
    section: "Exposure",
    targets: [
      t("Exposure", "Exposure", "exposure"),
      t("Exposure", "Contrast", "contrast"),
      t("Exposure", "Shadows", "shadows"),
    ],
  },
  {
    section: "Color",
    targets: [
      t("Color", "Temp", "temperature"),
      t("Color", "Tint", "tint"),
      t("Color", "Midtones", "midtones_hue", "wheel"),
    ],
  },
];

describe("hint letters", () => {
  it("gives everything its own initial where it can", () => {
    expect(assignHints(["Exposure", "Contrast", "Shadows", "Whites", "Blacks"])).toEqual([
      "E",
      "C",
      "S",
      "W",
      "B",
    ]);
  });

  /// The guessable case has to stay guessable: only the collision pays,
  /// and it pays by falling through to its own next letter rather than
  /// both labels being renumbered into something nobody can predict.
  it("falls through to the next distinct letter on a collision", () => {
    expect(assignHints(["Temp", "Tint", "Saturation", "Vibrance"])).toEqual(["T", "I", "S", "V"]);
    expect(assignHints(["Shadows", "Sharpening"])).toEqual(["S", "H"]);
  });

  it("never hands out a key that means something else while navigating", () => {
    // J and K move between controls, F restarts the jump. A control
    // labeled "Jump" cannot own J or the two would fight.
    const hints = assignHints(["Jump", "Kelvin", "Fade"]);
    expect(hints).not.toContain("J");
    expect(hints).not.toContain("K");
    expect(hints).not.toContain("F");
    expect(new Set(hints).size).toBe(3);
  });

  it("falls back to digits when a label has no letters left", () => {
    const hints = assignHints(["Aa", "Aa", "Aa"]);
    expect(hints[0]).toBe("A");
    expect(new Set(hints).size).toBe(3);
    expect(hints[1]).toMatch(/[0-9]/);
  });

  it("is unique across a whole real panel section", () => {
    for (const group of PANEL) {
      const hints = assignHints(group.targets.map((x) => x.label));
      expect(new Set(hints).size).toBe(hints.length);
    }
  });
});

describe("step sizes", () => {
  /// The owner asked for tens with shift for units, which is exactly
  /// right for the sliders most of the panel is made of.
  it("is ten and one on a -100..100 slider", () => {
    expect(stepFor([-100, 100], false)).toBe(10);
    expect(stepFor([-100, 100], true)).toBe(1);
  });

  /// And nonsense on the others, which is why it is expressed as a
  /// fraction of the range rather than as a constant: ten units of
  /// Exposure is twice its whole travel.
  it("scales to ranges where ten units would be absurd", () => {
    const coarse = stepFor([-5, 5], false);
    expect(coarse).toBeGreaterThan(0);
    expect(coarse).toBeLessThan(1);
    // Temperature the other way: ten units of 8000 is invisible.
    expect(stepFor([2000, 10000], false)).toBeGreaterThan(100);
  });

  it("always moves less on fine than on coarse", () => {
    for (const range of [[-100, 100], [-5, 5], [0, 1], [2000, 10000]] as [number, number][]) {
      expect(stepFor(range, true)).toBeLessThan(stepFor(range, false));
      expect(stepFor(range, true)).toBeGreaterThan(0);
    }
  });

  it("rounds so a slider does not land on 4.799999999", () => {
    expect(quantize(4.8000000001, 0.05)).toBe(4.8);
    expect(quantize(17.000000002, 10)).toBe(17);
  });
});

/// The owner drove the wheel keys and could not control them: "," swept
/// the puck round in a circle instead of moving it left, "'" went right
/// and then later went left, and from the center nothing moved at all.
/// All three are the same cause. A wheel stores an angle and a radius,
/// and nudging those directly is not a direction, it is a polar
/// coordinate.
describe("moving a color wheel", () => {
  /// Where the puck actually sits on screen, by the same formula the
  /// wheel draws it with. Screen y grows downward.
  const puck = (hue: number, sat: number) => ({
    x: sat * Math.cos((hue * Math.PI) / 180),
    y: sat * Math.sin((hue * Math.PI) / 180),
  });

  it("moves right, left, up and down from the center", () => {
    const right = moveWheel(0, 0, "x", 1, 5);
    expect(puck(right.hue, right.sat).x).toBeCloseTo(5, 5);
    expect(puck(right.hue, right.sat).y).toBeCloseTo(0, 5);

    const left = moveWheel(0, 0, "x", -1, 5);
    expect(puck(left.hue, left.sat).x).toBeCloseTo(-5, 5);

    // Up on screen is a smaller y.
    const up = moveWheel(0, 0, "y", 1, 5);
    expect(puck(up.hue, up.sat).y).toBeCloseTo(-5, 5);
    const down = moveWheel(0, 0, "y", -1, 5);
    expect(puck(down.hue, down.sat).y).toBeCloseTo(5, 5);
  });

  /// The one that made it unusable: "'" went right at one hue and left
  /// at another, because it was pushing outward along whatever direction
  /// the puck happened to be pointing.
  it("goes the same way wherever the puck already is", () => {
    for (const hue of [0, 45, 90, 137, 180, -90, -179]) {
      const before = puck(hue, 60);
      const up = moveWheel(hue, 60, "y", 1, 5);
      const after = puck(up.hue, up.sat);
      expect(after.y).toBeLessThan(before.y);
      // And it did not wander sideways while doing it. Within a unit and
      // a half rather than exactly, because hue and saturation are stored
      // as integers (the same integers a mouse drag writes), so a round
      // trip through them is good to about half a pixel on an 86 pixel
      // wheel.
      expect(Math.abs(after.x - before.x)).toBeLessThan(1.5);

      const rightBefore = puck(hue, 60);
      const right = moveWheel(hue, 60, "x", 1, 5);
      const rightAfter = puck(right.hue, right.sat);
      expect(rightAfter.x).toBeGreaterThan(rightBefore.x);
      expect(Math.abs(rightAfter.y - rightBefore.y)).toBeLessThan(1.5);
    }
  });

  /// "the, and. key moved the ring around in circles but it only
  /// stopped at 180". Repeated presses have to keep going the same
  /// way and stop at the rim, not orbit.
  it("keeps going the same way when held, and stops at the rim", () => {
    let hue = 0;
    let sat = 0;
    let last = -Infinity;
    for (let i = 0; i < 40; i++) {
      const moved = moveWheel(hue, sat, "x", 1, 5);
      hue = moved.hue;
      sat = moved.sat;
      const x = puck(hue, sat).x;
      expect(x).toBeGreaterThanOrEqual(last - 1e-6);
      last = x;
    }
    // Pinned to the rim rather than orbiting or running off.
    expect(sat).toBe(100);
    expect(Math.abs(hue)).toBeLessThan(1);
  });

  it("passing through the center does not lose the hue", () => {
    // Straight down from the middle and back up again: the puck ends
    // where it started rather than snapping to red on the way through.
    const down = moveWheel(0, 5, "x", -1, 5);
    expect(down.sat).toBe(0);
    // Still a real angle to carry on from.
    expect(Number.isFinite(down.hue)).toBe(true);
  });

  it("saturation never leaves 0..100", () => {
    for (const [h, sv, axis, d] of [
      [0, 100, "x", 1],
      [180, 100, "x", -1],
      [90, 100, "y", -1],
      [0, 0, "x", -1],
    ] as [number, number, "x" | "y", number][]) {
      const moved = moveWheel(h, sv, axis, d, 20);
      expect(moved.sat).toBeGreaterThanOrEqual(0);
      expect(moved.sat).toBeLessThanOrEqual(100);
    }
  });
});

describe("moving between controls", () => {
  it("j and k walk the whole panel, across section boundaries", () => {
    const all = flatten(PANEL);
    let cur = step(all, null, 1);
    expect(cur!.label).toBe("Exposure");
    for (let i = 0; i < 3; i++) cur = step(all, cur, 1);
    // Walked out of Exposure and into Color.
    expect(cur!.section).toBe("Color");
  });

  it("stops at the ends rather than wrapping", () => {
    const all = flatten(PANEL);
    expect(step(all, all[0], -1)).toBe(all[0]);
    expect(step(all, all[all.length - 1], 1)).toBe(all[all.length - 1]);
  });
});

describe("the key model", () => {
  it("F E S lands on Exposure > Shadows", () => {
    // Already in section mode: F is what got us here.
    let nav = NAV_START;
    const a = handleKey(nav, PANEL, "E", false)!;
    expect(a.kind).toBe("state");
    nav = (a as { nav: NonNullable<typeof nav> }).nav;
    expect(nav.mode).toBe("controls");
    expect(nav.section).toBe("Exposure");

    const b = handleKey(nav, PANEL, "S", false)!;
    nav = (b as { nav: NonNullable<typeof nav> }).nav;
    expect(nav.mode).toBe("adjust");
    expect(nav.target!.label).toBe("Shadows");
  });

  /// Asking which control when there is only one is a keystroke that
  /// can only have one answer.
  it("skips the second question when a section holds one control", () => {
    const single: SectionTargets[] = [{ section: "Detail", targets: [t("Detail", "Texture", "texture")] }];
    const a = handleKey(NAV_START, single, "D", false)!;
    const nav = (a as { nav: NonNullable<typeof NAV_START> }).nav;
    expect(nav.mode).toBe("adjust");
    expect(nav.target!.label).toBe("Texture");
  });

  it("escape leaves at any depth", () => {
    for (const nav of [
      NAV_START,
      { mode: "controls" as const, section: "Color", target: null },
      { mode: "adjust" as const, section: "Color", target: t("Color", "Temp", "temperature") },
    ]) {
      expect(handleKey(nav, PANEL, "Escape", false)).toEqual({ kind: "state", nav: null });
    }
  });

  it("a letter that means nothing is passed through rather than eaten", () => {
    // Returning null lets the key reach the rest of the app, so a mode
    // nobody meant to be in does not silently swallow every shortcut.
    expect(handleKey(NAV_START, PANEL, "Z", false)).toBeNull();
  });

  /// The bug the owner found, in its new clothes. A keyboard does not
  /// report "the key plus shift", it reports the shifted character: for the
  /// punctuation these keys used to be that meant "<" instead of ",", and
  /// for letters it means "A" instead of "a". Either way the match fails
  /// and the movement keys silently do nothing while shift is held, which
  /// is exactly when a fine step is wanted. Worth pinning precisely,
  /// because a synthetic event with key "a" and shiftKey true is a thing no
  /// real keyboard produces, and testing with one is how the bug survived
  /// being checked the first time.
  it("the shifted spelling of a movement key still moves", () => {
    const nav = { mode: "adjust" as const, section: "Exposure", target: PANEL[0].targets[0] };
    expect(handleKey(nav, PANEL, "A", true)).toMatchObject({ kind: "nudge", axis: "x", delta: -1 });
    expect(handleKey(nav, PANEL, "D", true)).toMatchObject({ kind: "nudge", axis: "x", delta: 1 });

    const wheel = { mode: "adjust" as const, section: "Color", target: PANEL[1].targets[2] };
    expect(handleKey(wheel, PANEL, "W", true)).toMatchObject({ axis: "y", delta: 1 });
    expect(handleKey(wheel, PANEL, "S", true)).toMatchObject({ axis: "y", delta: -1 });
    expect(handleKey(wheel, PANEL, "s", false)).toMatchObject({ axis: "y", delta: -1 });
  });

  it("normalizeKey only touches the punctuation that shift rewrites", async () => {
    const { normalizeKey } = await import("../keynav");
    expect(normalizeKey("<")).toBe(",");
    expect(normalizeKey(">")).toBe(".");
    expect(normalizeKey('"')).toBe("'");
    expect(normalizeKey(":")).toBe(";");
    // Letters are already what they are: a shifted E is still E, and
    // rewriting it would break the section and control hints.
    expect(normalizeKey("E")).toBe("E");
    expect(normalizeKey("Escape")).toBe("Escape");
    expect(normalizeKey("j")).toBe("j");
  });

  /// ", to a / . to d / ; to s / ' to w. I think that will help keep
  /// their fingers in a more comfortable spot." The old keys sat under
  /// the right little finger, a long way from J and K.
  it("A and D nudge, and shift is the caller's business to read", () => {
    const nav = { mode: "adjust" as const, section: "Exposure", target: PANEL[0].targets[0] };
    const up = handleKey(nav, PANEL, "d", false)!;
    expect(up).toMatchObject({ kind: "nudge", axis: "x", delta: 1 });
    const down = handleKey(nav, PANEL, "a", false)!;
    expect(down).toMatchObject({ kind: "nudge", axis: "x", delta: -1 });
    // The keys they replaced no longer do anything, or a stale habit
    // would keep half working.
    expect(handleKey(nav, PANEL, ".", false)).toBeNull();
    expect(handleKey(nav, PANEL, ",", false)).toBeNull();
  });

  /// The registry is what the menus and the hotkey editor advertise, so
  /// it has to name the keys the navigator actually matches on. This is
  /// the seam the bracket keys got away with for two rounds: declared in
  /// one place, implemented in another, agreeing with neither.
  it("the registry advertises the keys the navigator answers to", async () => {
    const { bindingFor } = await import("../hotkeys");
    expect(bindingFor("develop.nudge.down", {})).toBe("A");
    expect(bindingFor("develop.nudge.up", {})).toBe("D");
    expect(bindingFor("develop.nudge.y_down", {})).toBe("S");
    expect(bindingFor("develop.nudge.y_up", {})).toBe("W");
  });

  /// A wheel is two dimensional and a slider is not. Quietly moving hue
  /// when someone reaches for the second axis on a slider would be
  /// worse than doing nothing.
  it("the second axis exists on a wheel and nowhere else", () => {
    const onWheel = { mode: "adjust" as const, section: "Color", target: PANEL[1].targets[2] };
    expect(handleKey(onWheel, PANEL, "w", false)).toMatchObject({ axis: "y", delta: 1 });
    expect(handleKey(onWheel, PANEL, "s", false)).toMatchObject({ axis: "y", delta: -1 });

    const onSlider = { mode: "adjust" as const, section: "Exposure", target: PANEL[0].targets[0] };
    expect(handleKey(onSlider, PANEL, "w", false)).toBeNull();
    expect(handleKey(onSlider, PANEL, "s", false)).toBeNull();
  });

  /// A hint letter and a movement key can never be pressed in the same
  /// mode: hints pick a section or a control, movement applies once one is
  /// live. The first version of this change reserved A, D, S and W out of
  /// the hint pool to prevent a collision that cannot happen, and paid for
  /// it with four of the most guessable initials in the panel.
  it("the movement keys do not cost the panel its initials", () => {
    expect(assignHints(["Shadows", "Whites", "Detail", "Amount"])).toEqual(["S", "W", "D", "A"]);
    // And a control whose hint is S is still reachable by S while
    // choosing, even though S moves a wheel down once one is live.
    const s = handleKey(NAV_START, PANEL, "E", false)!;
    const nav = (s as { nav: NonNullable<typeof NAV_START> }).nav;
    const chosen = handleKey(nav, PANEL, "S", false)!;
    expect((chosen as { nav: NonNullable<typeof NAV_START> }).nav.target!.label).toBe("Shadows");
  });

  it("Backspace restarts the jump from inside adjust mode; F falls through to Fit", () => {
    // The restart lived on F while F was also the entry key. F is Fit
    // everywhere now, so inside the mode it goes unclaimed (and the
    // app's shortcuts catch it), and Backspace is the step back.
    const nav = { mode: "adjust" as const, section: "Exposure", target: PANEL[0].targets[0] };
    const a = handleKey(nav, PANEL, "Backspace", false)!;
    expect((a as { nav: typeof NAV_START }).nav.mode).toBe("sections");
    expect(handleKey(nav, PANEL, "f", false)).toBeNull();
  });
});

describe("the legend", () => {
  /// A mode with no visible way out is a trap, so the keys are on screen
  /// at every depth.
  it("always says how to leave", () => {
    const states = [
      NAV_START,
      { mode: "controls" as const, section: "Color", target: null },
      { mode: "adjust" as const, section: "Color", target: PANEL[1].targets[0] },
      { mode: "adjust" as const, section: "Color", target: PANEL[1].targets[2] },
    ];
    for (const nav of states) {
      expect(legend(nav).toLowerCase()).toContain("esc");
    }
  });

  it("names the live control and its keys", () => {
    const slider = legend({ mode: "adjust", section: "Color", target: PANEL[1].targets[0] });
    expect(slider).toContain("Temp");
    expect(slider).toContain("a d");

    // A wheel advertises directions, not a color model: the keys move
    // the puck, and hue and saturation are what falls out of where it
    // lands.
    const wheel = legend({ mode: "adjust", section: "Color", target: PANEL[1].targets[2] });
    expect(wheel).toContain("down up");
    expect(wheel).toContain("left right");
  });
});
