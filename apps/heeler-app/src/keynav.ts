// Keyboard navigation for the develop controls, in the manner of Vimium.
//
// The idea is that adjusting a photograph should not require the mouse
// to travel to a 4 pixel slider handle. Press F and every section wears
// a letter; press the letter and its controls wear letters; press that
// and the control is live, with, and. moving it. So EXPOSURE >
// SHADOWS is "F E S", typed without looking.
//
// This file is only the model: which targets exist, what letter each
// one gets, and how far a keystroke moves a value. It holds no React and
// no DOM, which is what makes the awkward parts (unique letters, step
// sizes that suit both a -100..100 slider and a 2000..10000 one) testable
// as plain functions.

/** switch: a section that is currently OFF, whose one reachable control
 * is its power switch. Landing on it and pressing the movement keys
 * flips the section on (d) or off (a), after which the section's real
 * controls exist to navigate. */
export type NavKind = "slider" | "wheel" | "switch";

export interface NavTarget {
  section: string;
  label: string;
  param: string;
  kind: NavKind;
  /** the node this control writes to, resolved when the target list is built */
  nodeId: string;
}

export interface NavState {
  /** sections: picking a section. controls: picking one inside it.
   * adjust: a control is live and the movement keys apply. */
  mode: "sections" | "controls" | "adjust";
  /** the chosen section, once there is one */
  section: string | null;
  /** the live control, in adjust mode */
  target: NavTarget | null;
}

export const NAV_START: NavState = { mode: "sections", section: null, target: null };

/** The keys that move a live control.
 *
 * "change the hotkeys for doing keyboard changes to Adjustments from
 * , to a / . to d / ; to s / ' to w. I think that will help keep
 * their fingers in a more comfortable spot."
 *
 * WASD, minus the W and S swap: D and A move the value along, W and S
 * move a color wheel's puck up and down. The punctuation they replaced
 * sat under the right little finger, which is a long way from J and K.
 *
 * Named rather than typed out at the point of use, because the registry
 * has to advertise the same four keys and a keyboard shortcut that is
 * declared in one place and implemented in another is how the bracket
 * keys got away with doing nothing for two rounds.
 */
export const NUDGE_KEYS = { less: "a", more: "d", down: "s", up: "w" } as const;

/** Keys never handed out as hints, because they mean something else
 * while navigating.
 *
 * The movement keys are deliberately NOT in here, though the first
 * version of this had them. A hint letter is only ever read while picking
 * a section or a control, and the movement keys are only ever read once
 * one is live: the two can never be pressed in the same mode, so there is
 * nothing to collide. Reserving them cost four of the most guessable
 * initials in the panel (Shadows, Whites, Saturation, Detail) to prevent
 * a collision that cannot happen, which the hint tests said out loud.
 *
 * The punctuation that used to be listed here was never doing anything
 * either: `assignHints` only ever considers A-Z and 0-9.
 *
 * F stays reserved even though the mode no longer reads it: an
 * unclaimed key falls through to the app's shortcuts, and F is Fit
 * there. Keeping it out of the hints means F fits the photograph
 * with the letters up or down, one meaning everywhere.
 */
const RESERVED = new Set(["J", "K", "F"]);

/** Punctuation as it arrives when shift is held.
 *
 * A keyboard does not report "comma plus shift", it reports "less than",
 * so a shifted punctuation key is a different key and any match against
 * it fails. Shift here only ever means a smaller step, so it is
 * normalized away.
 *
 * The movement keys are letters now and get this for free by being
 * lowercased, so nothing currently depends on this table. It stays
 * because it is the correct thing for `handleKey` to do with any key it
 * is handed, and the moment a punctuation binding comes back the absence
 * of it is a silent failure while shift is down.
 */
const UNSHIFT: Record<string, string> = {
  "<": ",",
  ">": ".",
  '"': "'",
  ":": ";",
};

/** The key as the model wants to see it. */
export function normalizeKey(key: string): string {
  return UNSHIFT[key] ?? key;
}

/** Gives each label a unique key, preferring its own initial.
 *
 * The initial is what someone will guess, so it wins where it can. Where
 * two labels in one group start alike (Temp and Tint) the second falls
 * through to its next distinct letter rather than both being renumbered,
 * so the common case stays guessable and only the collision pays.
 */
export function assignHints(labels: string[]): string[] {
  const taken = new Set<string>();
  const out: string[] = [];
  for (const label of labels) {
    let key = "";
    for (const ch of label.toUpperCase()) {
      if (!/[A-Z0-9]/.test(ch)) continue;
      if (!taken.has(ch) && !RESERVED.has(ch)) {
        key = ch;
        break;
      }
    }
    if (!key) {
      // Every letter of the label is spoken for. Digits are never a
      // guess anyone would make, which is exactly why they are the
      // fallback rather than the scheme.
      for (let d = 1; d <= 9; d++) {
        if (!taken.has(String(d))) {
          key = String(d);
          break;
        }
      }
    }
    taken.add(key);
    out.push(key);
  }
  return out;
}

/** How far one keystroke moves a control.
 *
 * The owner asked for tens, with shift for units. That is exactly right
 * for the -100..100 sliders that most of the panel is made of, and
 * nonsense for the others: ten units of Exposure is twice its whole
 * range, and ten units of Temperature is invisible. Expressed as a
 * twentieth of the range it comes out at exactly ten and one for
 * -100..100, and stays sensible everywhere else.
 */
export function stepFor(range: [number, number], fine: boolean): number {
  const span = Math.abs(range[1] - range[0]);
  if (span <= 0) return fine ? 0.01 : 0.1;
  return fine ? span / 200 : span / 20;
}

/** Rounds a stepped value so a slider does not end up at 4.799999999. */
export function quantize(value: number, step: number): number {
  const places = step >= 1 ? 0 : Math.min(4, Math.ceil(-Math.log10(step)) + 1);
  return Number(value.toFixed(places));
}

/** Moves a color wheel's puck in a straight line.
 *
 * A wheel stores an angle and a radius, and moving those directly is
 * miserable to drive: the angle sweeps the puck around a circle rather
 * than sideways, the radius pushes it outward along whatever direction
 * it happens to be pointing (right at hue 0, left at hue 180), and at
 * the center the angle moves nothing at all because the radius is zero.
 * The owner drove it and described exactly that.
 *
 * So the keys move the puck in x and y, and the angle and radius are
 * worked out afterwards. Right is right wherever the puck is, and up is
 * up. Screen y grows downward, which is why the vertical axis is
 * negated on the way in and out: the wheel draws the puck with
 * sin(hue) going down the screen.
 */
export function moveWheel(
  hue: number,
  sat: number,
  axis: "x" | "y",
  delta: number,
  step: number
): { hue: number; sat: number } {
  const rad = (hue * Math.PI) / 180;
  let x = sat * Math.cos(rad);
  // Up is positive here and down the screen there.
  let y = -sat * Math.sin(rad);
  if (axis === "x") x += delta * step;
  else y += delta * step;

  const radius = Math.min(100, Math.hypot(x, y));
  // Dead center has no angle to speak of; keeping the old one stops the
  // hue snapping to zero every time the puck passes through the middle.
  const angle = radius < 1e-9 ? hue : (Math.atan2(-y, x) * 180) / Math.PI;
  return { hue: Math.round(angle), sat: Math.round(radius) };
}

export interface SectionTargets {
  section: string;
  targets: NavTarget[];
}

/** Flattens the panel into what the keyboard can reach.
 *
 * Sections with nothing in them are dropped: offering a letter that
 * leads to an empty list is worse than not offering it, because the
 * user presses it and nothing appears to happen.
 */
export function buildTargets(sections: SectionTargets[]): SectionTargets[] {
  return sections.filter((s) => s.targets.length > 0);
}

/** Every control in order, for j and k. */
export function flatten(sections: SectionTargets[]): NavTarget[] {
  return sections.flatMap((s) => s.targets);
}

/** Moves to the next or previous control, stopping at the ends.
 *
 * Wrapping would be defensible here and it is not worth it: someone
 * holding j to walk the panel wants to arrive at the bottom and stop,
 * not to find themselves back at Exposure without noticing.
 */
export function step(all: NavTarget[], current: NavTarget | null, delta: number): NavTarget | null {
  if (all.length === 0) return null;
  if (!current) return delta > 0 ? all[0] : all[all.length - 1];
  const at = all.findIndex((t) => t.section === current.section && t.param === current.param);
  if (at < 0) return all[0];
  return all[Math.min(all.length - 1, Math.max(0, at + delta))];
}

/** What the status row says while navigating. The keys are on screen
 * because a mode nobody can see the exit from is a trap. */
export function legend(nav: NavState): string {
  if (nav.mode === "sections")
    return "Focus a section · letter to choose · alt+letter folds · esc cancels";
  if (nav.mode === "controls") {
    return `${nav.section} · letter to choose a control · esc cancels`;
  }
  const wheel = nav.target?.kind === "wheel";
  if (nav.target?.kind === "switch") {
    return [`${nav.target.section} is off`, "d turns it on", "j k next", "backspace sections", "esc done"].join(" · ");
  }
  return [
    `${nav.target?.section} ${nav.target?.label}`,
    wheel ? "a d left right · s w down up" : "a d adjust",
    "shift for fine",
    "j k next",
    "backspace sections",
    "esc done",
  ].join(" · ");
}

/** The result of a keypress while navigating: what the model becomes,
 * and what the caller should do about it.
 *
 * Returned rather than performed, because the same decision has to be
 * testable without a React tree behind it.
 */
export type NavAction =
  | { kind: "state"; nav: NavState | null }
  | { kind: "nudge"; nav: NavState; target: NavTarget; axis: "x" | "y"; delta: number }
  /** ALT + a section's letter while picking sections: fold it shut. The
   * report: "this would give us a way to collapse sections without
   * using the mouse." Navigation stays in sections mode, hints still
   * up.*/
  | { kind: "fold"; section: string };

/** One keypress against the model. Null means the caller should ignore
 * the key entirely and let it through. */
export function handleKey(
  nav: NavState,
  sections: SectionTargets[],
  rawKey: string,
  shift: boolean,
  alt = false
): NavAction | null {
  const key = normalizeKey(rawKey);
  if (key === "Escape") return { kind: "state", nav: null };

  const all = flatten(sections);

  if (nav.mode === "sections") {
    const hints = assignHints(sections.map((s) => s.section));
    const at = hints.indexOf(key.toUpperCase());
    if (at < 0) return null;
    const chosen = sections[at];
    // ALT folds instead of entering: the keyboard's way to tidy the
    // panel. The mode stays, so several sections fold in a row.
    if (alt) return { kind: "fold", section: chosen.section };
    // A section with one control is not worth a second question.
    if (chosen.targets.length === 1) {
      return { kind: "state", nav: { mode: "adjust", section: chosen.section, target: chosen.targets[0] } };
    }
    return { kind: "state", nav: { mode: "controls", section: chosen.section, target: null } };
  }

  if (nav.mode === "controls") {
    const group = sections.find((s) => s.section === nav.section);
    if (!group) return { kind: "state", nav: null };
    const hints = assignHints(group.targets.map((t) => t.label));
    const at = hints.indexOf(key.toUpperCase());
    if (at < 0) return null;
    return {
      kind: "state",
      nav: { mode: "adjust", section: group.section, target: group.targets[at] },
    };
  }

  // Adjusting.
  if (key === "j" || key === "k") {
    const next = step(all, nav.target, key === "j" ? 1 : -1);
    return { kind: "state", nav: { ...nav, section: next?.section ?? nav.section, target: next } };
  }
  // Back to the section letters without leaving the mode (Escape
  // leaves outright). This lived on F when F was also the entry key;
  // F belongs to Fit now, in the mode and out of it, and Backspace is
  // the key that already means "step back".
  if (key === "Backspace") return { kind: "state", nav: NAV_START };
  if (!nav.target) return null;

  const nudge = (axis: "x" | "y", delta: number): NavAction => ({
    kind: "nudge",
    nav,
    target: nav.target!,
    axis,
    delta,
  });
  // Lowercased, because shift means a finer step and a shifted letter is
  // a different key. The punctuation these replaced needed UNSHIFT for
  // the same reason; letters get it for free.
  const moved = key.toLowerCase();
  if (moved === NUDGE_KEYS.more) return nudge("x", 1);
  if (moved === NUDGE_KEYS.less) return nudge("x", -1);
  // The second axis only exists on a wheel; on a slider these keys mean
  // nothing and are better ignored than quietly doing the first axis.
  if (nav.target.kind === "wheel") {
    if (moved === NUDGE_KEYS.up) return nudge("y", 1);
    if (moved === NUDGE_KEYS.down) return nudge("y", -1);
  }
  return null;
}
