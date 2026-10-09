// The palette, held to the rules it was chosen under.
//
// Heeler's chrome drifted warm one eyedropper at a time until it looked
// like another RAW editor: grays running up to +10 red over blue, and an amber
// accent sitting 11.8 dE from the Color category, close enough that a
// highlight could be mistaken for a category marker. None of that was a
// decision anybody made; it accumulated. These tests are the guard rail,
// because "the grays are cool" is a measurable claim and a comment in a
// stylesheet is not.

import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

// Read from disk, not through Vite. `?raw` on a stylesheet returns an
// empty string here because the vitest config sets `css: false`, and an
// empty string makes these tests pass without checking anything, which
// is worse than not having them. Types for the two Node calls are
// declared in node-shim.d.ts beside this file.
const src = (rel: string) => readFileSync(resolve(process.cwd(), "src", rel), "utf8");
const CSS = src("theme.css");
const SPECTRUM = src("ui/spectrum.tsx");

/** Every `--name: #hex` in the:root block. */
function tokens(): Record<string, string> {
  const root = CSS.slice(CSS.indexOf(":root {"), CSS.indexOf("}", CSS.indexOf(":root {")));
  const out: Record<string, string> = {};
  for (const m of root.matchAll(/(--[a-z0-9-]+):\s*(#[0-9a-fA-F]{3,6})\s*;/g)) {
    out[m[1]] = m[2].toLowerCase();
  }
  return out;
}

function rgb(hex: string): [number, number, number] {
  const h = hex.length === 4
    ? `#${hex[1]}${hex[1]}${hex[2]}${hex[2]}${hex[3]}${hex[3]}`
    : hex;
  return [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16)) as [number, number, number];
}

/** CIELAB, so "different color" can be a number rather than an opinion. */
function lab(hex: string): [number, number, number] {
  const [r8, g8, b8] = rgb(hex);
  const lin = (c: number) => {
    const s = c / 255;
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  const [r, g, b] = [lin(r8), lin(g8), lin(b8)];
  const x = (r * 0.4124 + g * 0.3576 + b * 0.1805) / 0.9505;
  const y = r * 0.2126 + g * 0.7152 + b * 0.0722;
  const z = (r * 0.0193 + g * 0.1192 + b * 0.9505) / 1.089;
  const f = (t: number) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
  const [fx, fy, fz] = [f(x), f(y), f(z)];
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}

function deltaE(a: string, b: string): number {
  const [la, aa, ba] = lab(a);
  const [lb, ab, bb] = lab(b);
  return Math.hypot(la - lb, aa - ab, ba - bb);
}

describe("the palette holds its shape", () => {
  it("keeps the viewer surround strictly neutral", () => {
    // This is the one that is not taste. The photograph is judged
    // against this color, and a tinted surround shifts where the eye
    // puts neutral, which is the whole job of a white balance control.
    const [r, g, b] = rgb(tokens()["--bg-viewer"]);
    expect([r, g, b]).toEqual([r, r, r]);
    expect(g).toBe(r);
    expect(b).toBe(r);
  });

  it("never lets a chrome gray run warm", () => {
    const t = tokens();
    const greys = Object.keys(t).filter((k) =>
      /^--(bg|line|text|slider|node-border|wire|hover)/.test(k) && k !== "--line-hard",
    );
    expect(greys.length).toBeGreaterThan(15);
    const warm = greys
      .map((k) => [k, t[k], rgb(t[k])] as const)
      .filter(([, , [r, , b]]) => r > b)
      .map(([k, hex, [r, , b]]) => `${k} ${hex} is +${r - b} red over blue`);
    expect(warm).toEqual([]);
  });

  it("keeps the accent far enough from every category color", () => {
    // The failure this prevents: the old accent sat 11.8 dE from
    // --cat-color, so an accent highlight and a Color node marker were
    // the same color to anyone not comparing them side by side.
    const t = tokens();
    const cats = Object.keys(t).filter((k) => k.startsWith("--cat-"));
    expect(cats.length).toBeGreaterThan(4);
    const tooClose = cats
      .map((k) => [k, deltaE(t["--accent"], t[k])] as const)
      .filter(([, d]) => d < 20)
      .map(([k, d]) => `${k} is only ${d.toFixed(1)} dE from --accent`);
    expect(tooClose).toEqual([]);
  });

  it("keeps pick and reject apart from the accent too", () => {
    // They mark photographs, and the accent marks the one you are on.
    // Those appear on the same thumbnail at the same time.
    const t = tokens();
    for (const k of ["--pick", "--reject"]) {
      expect(deltaE(t["--accent"], t[k])).toBeGreaterThan(20);
    }
  });

  it("has no --gold left to mean two things at once", () => {
    // --gold marked both "active" and "this photo is picked", while
    // --pick also meant picked. One meaning, one token.
    expect(CSS).not.toMatch(/--gold/);
  });

  it("has no old amber accent left anywhere it is not meant to be", () => {
    // Two spellings, and the sweep that cleaned this up first only knew
    // about one. #e0a247 was also written as rgba(224,162,71,...), which
    // a hex search cannot see, and that is how the Range Layer histogram
    // and the harmony fan kept their orange after the palette changed.
    // Both spellings are checked here.
    const ALLOWED = new Set([
      "theme.css",          // --warn, and amber is what caution looks like
      "ui/console.tsx",     // the Python syntax scheme's number color
      "ui/keylightgizmo.tsx", // a warm key light, which is the light's color
    ]);
    const offenders: string[] = [];
    const walk = (dir: string, prefix: string) => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const rel = prefix ? `${prefix}/${e.name}` : e.name;
        if (e.isDirectory()) {
          if (e.name !== "__tests__" && e.name !== "node_modules") walk(`${dir}/${e.name}`, rel);
          continue;
        }
        if (!/\.(ts|tsx|css)$/.test(e.name) || ALLOWED.has(rel)) continue;
        const text = readFileSync(`${dir}/${e.name}`, "utf8");
        if (/#e0a247/i.test(text)) offenders.push(`${rel} (#e0a247)`);
        if (/rgba?\(\s*224\s*,\s*162\s*,\s*71/.test(text)) offenders.push(`${rel} (rgba 224,162,71)`);
      }
    };
    walk(resolve(process.cwd(), "src"), "");
    expect(offenders).toEqual([]);
  });

  it("spells the accent the same way on canvas as in the stylesheet", () => {
    // Canvas cannot read a CSS variable, so spectrum.tsx carries the
    // accent as a literal. Two spellings of one color drift apart.
    const accent = tokens()["--accent"];
    expect(SPECTRUM).toContain(accent);
  });
});

// Corners and hover.
//
// "Slightly rounded corners on buttons ... need to consider
// buttons that have connected edges, the only rounded corners should be
// the buttons on the left and right ends", and "On-hover background
// color - a desaturated and dark version of the accent. We kind of use
// this on some buttons already when selected so not sure if this will
// be a distraction".
//
// Both are measurable claims, so both are held to a number here rather
// than to a comment. The distraction worry is the interesting one: the
// test below is what stops a later eyedropper from walking hover up into
// the tint that already means "this control is on".

/** Every declaration inside the first rule whose selector matches. */
function rule(selector: string): string {
  const at = CSS.indexOf(`\n${selector} {`);
  if (at < 0) throw new Error(`no rule for ${selector}`);
  return CSS.slice(at, CSS.indexOf("}", at));
}

describe("corners", () => {
  it("keeps every control on one radius token", () => {
    // A hand-written pixel radius on a control is how two buttons end up
    // different shapes; the token is the whole point.
    for (const sel of [".chip", ".btn-export", ".btn-assistant", ".seg", ".zoom-seg", ".hud"]) {
      expect(rule(sel)).toMatch(/border-radius:\s*var\(--radius-btn\)/);
    }
  });

  it("rounds a connected group only at its two ends", () => {
    // The seam between two segments has to keep reading as a seam. Each
    // group rounds its first child leftward, its last child rightward,
    // and an only child on all four corners.
    for (const group of [".seg button", ".zoom-seg button", ".hud > *"]) {
      expect(rule(`${group}:first-child`))
        .toBe(`\n${group}:first-child { border-radius: var(--radius-btn-inner) 0 0 var(--radius-btn-inner); `);
      expect(rule(`${group}:last-child`))
        .toBe(`\n${group}:last-child { border-radius: 0 var(--radius-btn-inner) var(--radius-btn-inner) 0; `);
      expect(rule(`${group}:only-child`))
        .toBe(`\n${group}:only-child { border-radius: var(--radius-btn-inner); `);
    }
  });

  it("keeps the inner radius one pixel under the outer one", () => {
    // Which is what a 1px border leaves behind. Equal radii read as a
    // gap at the corner of every group box.
    const px = (name: string) => {
      const m = CSS.match(new RegExp(`${name}:\\s*(\\d+)px`));
      return Number(m![1]);
    };
    expect(px("--radius-btn") - px("--radius-btn-inner")).toBe(1);
  });
});

describe("hover never wears the color that means active", () => {
  it("is the accent's hue, desaturated and darkened", () => {
    const t = tokens();
    const [hr, , hb] = rgb(t["--hover-bg"]);
    // Same family as the accent: cool, blue over red, like the rest of
    // the chrome.
    expect(hb).toBeGreaterThan(hr);
    // Desaturated: nothing like the accent's spread between channels.
    const [ar, , ab] = rgb(t["--accent"]);
    expect(hb - hr).toBeLessThan((ab - ar) / 3);
    // And dark: under the panel-head gray it sits on top of, in red.
    expect(hr).toBeLessThan(rgb(t["--bg-panel-head"])[0] + 6);
  });

  it("stays clear of the tint that says a control is on", () => {
    // rgba(accent, .13) over --bg-panel is what a selected chip shows.
    // Hover has to stay under it, or the pointer starts announcing
    // things as active that are not.
    const t = tokens();
    const over = (a: number) =>
      rgb(t["--bg-panel"]).map((c, i) => Math.round(c + (rgb(t["--accent"])[i] - c) * a));
    const selected = over(0.13);
    const [hr, hg, hb] = rgb(t["--hover-bg"]);
    expect(hb).toBeLessThan(selected[2]);
    // Far enough under to tell apart, close enough to read as the same
    // idea rather than a second color.
    const gap = Math.hypot(hr - selected[0], hg - selected[1], hb - selected[2]);
    expect(gap).toBeGreaterThan(4);
    expect(gap).toBeLessThan(24);
  });

  it("is visible against the surfaces it appears on", () => {
    // The first attempt was two points off --bg-panel, which is a hover
    // state you cannot see.
    const t = tokens();
    const [hr, hg, hb] = rgb(t["--hover-bg"]);
    for (const bg of ["--bg-panel", "--bg-app", "--bg-panel-head"]) {
      const [br, bg2, bb] = rgb(t[bg]);
      expect(Math.hypot(hr - br, hg - bg2, hb - bb)).toBeGreaterThan(12);
    }
  });

  it("never overrides an on-state, whatever the source order", () => {
    // These buttons carry `all: unset` inline and their state selectors
    // are no more specific than a bare:hover, so the exclusion has to
    // be written into the selector rather than assumed from position.
    // The color lift makes this sharper than it was: without the
    // exclusion, hovering an armed chip would repaint its accent
    // lettering gray.
    expect(CSS).toContain('.chip:hover:not(:disabled):not([data-active="true"])');
    expect(CSS).toContain('.seg button:hover:not([aria-pressed="true"])');
    expect(CSS).toContain('.zoom-seg button:hover:not([data-active="true"])');
    expect(CSS).toContain('.hud button:hover:not([data-active="true"])');
    expect(CSS).toContain('.railbar:hover:not([aria-pressed="true"])');
    expect(CSS).toContain('.viewer-toolbar button:hover:not([data-active="true"])');
  });

  it("lifts an armed control along its own color rather than into gray", () => {
    // An active chip is accent-lettered. The pointer takes it a half
    // step up the accent, not sideways into the hover grays.
    expect(rule('.chip[data-active="true"]:hover:not(:disabled)'))
      .toMatch(/color:\s*var\(--accent-hover\)/);
  });
});

describe("the text lifts with the background", () => {
  // "Since the background is a bit brighter we want to make
  // sure the font, or icon, luminance proportionally adjusts as well."
  // Which is measurable: hold the contrast RATIO, and the hovered
  // control reads exactly as legible as it did at rest.

  /** WCAG relative luminance. */
  function relLum(hex: string): number {
    const lin = (c: number) => {
      const s = c / 255;
      return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
    };
    const [r, g, b] = rgb(hex).map(lin);
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  }
  function contrast(fg: string, bg: string): number {
    const [a, b] = [relLum(fg) + 0.05, relLum(bg) + 0.05];
    return Math.max(a, b) / Math.min(a, b);
  }

  const PAIRS: [string, string][] = [
    ["--text-mid", "--hover-text-mid"],
    ["--text-dim", "--hover-text-dim"],
    ["--text-faint", "--hover-text-faint"],
    ["--text-ghost", "--hover-text-ghost"],
  ];

  it("holds every tone's contrast ratio across the highlight", () => {
    const t = tokens();
    for (const [base, hover] of PAIRS) {
      const atRest = contrast(t[base], t["--bg-panel"]);
      const hovered = contrast(t[hover], t["--hover-bg"]);
      // Within a twentieth of a ratio point: this is arithmetic, not
      // taste, so it should land almost exactly.
      expect(Math.abs(hovered - atRest)).toBeLessThan(0.05);
    }
  });

  it("actually raises each tone rather than holding the ratio by standing still", () => {
    const t = tokens();
    for (const [base, hover] of PAIRS) {
      expect(relLum(t[hover])).toBeGreaterThan(relLum(t[base]));
      // The lift came out at +10 to +12 per channel across the whole
      // ladder, the same order as the background's own lift. A tone
      // that drifts far off that is a tone somebody eyeballed.
      const lift = rgb(t[hover]).map((c, i) => c - rgb(t[base])[i]);
      for (const d of lift) expect(d).toBeGreaterThanOrEqual(8);
      for (const d of lift) expect(d).toBeLessThanOrEqual(14);
    }
  });

  it("lifts the channel row from its own dimmer resting tone", () => {
    // The histogram's off-channels rest at the ghost rather than the
    // mid, so the generic chip lift would have overshot them. The extra
    // :not() is what makes this rule win on specificity instead of on
    // where it happens to sit in the file.
    expect(CSS).toContain(
      '.chip.channel:not([data-active="true"]):hover:not(:disabled) { color: var(--hover-text-ghost); }',
    );
    // And the resting color has to be in the stylesheet at all: inline,
    // no:hover could reach it, which is the bug this fixes.
    expect(CSS).toContain('.chip.channel:not([data-active="true"]):not(:hover)');
  });

  it("never answers the pointer on a control that cannot be pressed", () => {
    // The menus stopped hiding what does not apply and started graying
    // it, which put a column of unpressable rows under the pointer for
    // the first time. Nothing here styled:disabled at all, so every one
    // of them was drawn like a live item and took the live hover with
    // it: the pointer saying "press me" about a row that cannot be.
    expect(rule(".ctx-menu button:disabled"))
      .toMatch(/color:\s*var\(--text-ghost\)/);
    expect(CSS).toContain(".ctx-menu button:hover:not(:disabled)");
    for (const sel of [
      '.seg button:hover:not([aria-pressed="true"]):not(:disabled)',
      '.zoom-seg button:hover:not([data-active="true"]):not(:disabled)',
      '.hud button:hover:not([data-active="true"]):not(:disabled)',
    ]) {
      expect(CSS).toContain(sel);
    }
  });

  it("marks a hovered-but-off row in a color that does not mean pressable", () => {
    // It still has to show WHICH row the status line is describing,
    // since that is where a grayed item explains itself. A plain gray
    // lift, not the accent-tinted one every live control wears.
    const t = tokens();
    const off = rgb(t["--hover-bg-off"]);
    const on = rgb(t["--hover-bg"]);
    // The live hover leans blue over red; the off one is near neutral,
    // which is what keeps the two apart at a glance.
    expect(on[2] - on[0]).toBeGreaterThan(12);
    expect(off[2] - off[0]).toBeLessThan(6);
    // And it is still a lift, or it would say nothing at all.
    expect(off[0]).toBeGreaterThan(rgb(t["--bg-panel-head"])[0]);
  });

  it("answers the pointer on the bars that fold panels away, open or shut", () => {
    // An OPEN rail is still the button you press to shut it, and it had
    // no hover at all: the pointer went dead over the one rail that was
    // showing. The fold bar under the thumbnails had none either, being
    // an inline `all: unset` that no stylesheet rule could reach.
    expect(rule('.railbar[aria-pressed="true"]:hover'))
      .toMatch(/background:\s*var\(--accent-tint\)/);
    expect(rule(".foldbar:hover")).toMatch(/background:\s*var\(--hover-bg\)/);
    // Color, not just background: the glyph and the label inherit it,
    // so the lift reaches the whole control.
    expect(rule(".foldbar:hover")).toMatch(/color:\s*var\(--hover-text-dim\)/);
  });

  it("says 'this mode is selected' without borrowing the export button's block of accent", () => {
    // "it might be confusing for the selected mode to be the
    // full highlight color because the quick export is that color. Maybe
    // instead using the color scheme that the color channels in the
    // histogram use." A solid block of accent is what export IS, and
    // export is a thing you do; a mode is a thing you are in.
    const seg = rule('.seg button[aria-pressed="true"]');
    expect(seg).toMatch(/color:\s*var\(--accent\)/);
    expect(seg).toMatch(/background:\s*var\(--accent-tint\)/);
    // The outline is an inset shadow, not a border: these segments sit
    // flush inside one box, and a real border on the selected one would
    // shove its neighbors sideways every time the mode changed.
    expect(seg).toMatch(/box-shadow:\s*inset 0 0 0 1px var\(--accent\)/);
    expect(seg).not.toMatch(/background:\s*var\(--accent\)\s*;/);
    // Which is the same treatment the channel row wears, on purpose.
    expect(rule('.chip[data-active="true"]')).toMatch(/background:\s*var\(--accent-tint\)/);
  });

  it("gives every segmented control the same selected state, not just the mode switcher", () => {
    // The 35 in-panel toggles (Fit/100%, export size, selection mode,
    // demosaic quality, and the rest) were a solid block of accent with
    // dark ink: byte for byte what the JPG export button is. A solid
    // block of accent should mean the button that DOES something, not
    // "this option is picked".
    const seg = rule('.seg button[aria-pressed="true"]');
    const zoom = rule('.zoom-seg button[data-active="true"]');
    for (const decl of [
      /background:\s*var\(--accent-tint\)/,
      /color:\s*var\(--accent\)/,
      /box-shadow:\s*inset 0 0 0 1px var\(--accent\)/,
    ]) {
      expect(seg).toMatch(decl);
      expect(zoom).toMatch(decl);
    }
    // And neither of them takes the export button's fill any more.
    const solid = rule(".btn-export");
    expect(solid).toMatch(/background:\s*var\(--accent\)/);
    expect(zoom).not.toMatch(/background:\s*var\(--accent\)\s*;/);
    // Which leaves the fill meaning exactly one thing, so it owes the
    // states any button owes: brighter under the pointer, faded when
    // there is nothing to export.
    expect(CSS).toContain(".btn-export:hover:not(:disabled)");
    expect(rule(".btn-export:disabled")).toMatch(/opacity:\s*0\.35/);
  });

  it("puts the accent on the live panel tab's glyph, not only under it", () => {
    // "The icon of the tabs (Adjustments, Finish, etc) should
    // be the accent color." The strip already carried the accent as an
    // underline and then drew the glyph itself in plain white, so the part
    // of the tab you actually look at was the part saying nothing.
    const live = rule('.paneltab[data-active="true"]');
    expect(live).toMatch(/color:\s*var\(--accent\)/);
    expect(live).toMatch(/border-bottom-color:\s*var\(--accent\)/);
    // And the strip answers the pointer at all, which it could not
    // while every one of these carried an inline `all: unset`.
    expect(CSS).toContain('.paneltab:hover:not([data-active="true"])');
  });

  it("gives the bare glyph buttons in a row the same treatment", () => {
    // "The icon buttons on collections is not highlighting on
    // mouse-hover." They were inline `all: unset`, which no stylesheet
    // rule can reach; .rowbtn is the class that fixes it for good.
    expect(rule(".rowbtn:hover")).toMatch(/background:\s*var\(--hover-bg\)/);
    expect(rule(".rowbtn:hover")).toMatch(/color:\s*var\(--hover-text-dim\)/);
    // At rest they sit at --text-dim, not the ghost: these went 10px to
    // 13 for readability, and a bigger glyph in the darkest gray the
    // palette has is a bigger smudge rather than a clearer picture (The
    // report: "that black is awful").
    expect(rule(".rowbtn")).toMatch(/color:\s*var\(--text-dim\)/);
  });
});

// Readable, or it is not writing.
//
// The old --text-ghost drew unreadable dark glyphs over a dark
// background, regardless of the color name.
//
// He is right, and the part worth keeping is that it was measurable the
// whole time. Against the panel head --text-ghost ran 2.60:1 and
// --text-faint 3.20:1, where 4.5:1 is the point at which small text
// becomes readable at all; four of the palette's seven grays, and
// twenty-seven hand-written hexes scattered through the components,
// were being spent under that line.
//
// So the floor is a number now rather than an eye, and it is checked
// two ways: the tokens, and the literals that bypass them.
describe("nothing writes in a color you cannot read", () => {
  /** WCAG relative luminance and contrast. */
  function relLum(hex: string): number {
    const lin = (c: number) => {
      const s = c / 255;
      return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
    };
    const [r, g, b] = rgb(hex).map(lin);
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  }
  function contrast(fg: string, bg: string): number {
    const [a, b] = [relLum(fg) + 0.05, relLum(bg) + 0.05];
    return Math.max(a, b) / Math.min(a, b);
  }

  /** Small text needs this much, and every gray in here is small text. */
  const FLOOR = 4.5;

  it("holds every text tone to the floor, on every surface it can land on", () => {
    const t = tokens();
    const surfaces = ["--bg-panel", "--bg-app", "--bg-row", "--bg-panel-head", "--bg-node"];
    const failures: string[] = [];
    for (const name of Object.keys(t).filter((k) => k.startsWith("--text-"))) {
      for (const s of surfaces) {
        const c = contrast(t[name], t[s]);
        if (c < FLOOR) failures.push(`${name} on ${s}: ${c.toFixed(2)}:1`);
      }
    }
    expect(failures).toEqual([]);
  });

  it("holds the hover tones to it too, on the color they appear over", () => {
    const t = tokens();
    const failures: string[] = [];
    for (const name of Object.keys(t).filter((k) => k.startsWith("--hover-text-"))) {
      const c = contrast(t[name], t["--hover-bg"]);
      if (c < FLOOR) failures.push(`${name}: ${c.toFixed(2)}:1`);
    }
    expect(failures).toEqual([]);
  });

  it("lets no component write its own unreadable gray", () => {
    // The tokens are only half of it: twenty-seven components were
    // spelling a gray out by hand and so could never be fixed by
    // fixing the palette. This is the half that catches the next one.
    //
    // Scans `color:` only. A stroke or a fill is a plot line, a wire or
    // a cursor outline, which are drawings rather than writing and are
    // judged by eye against the picture they sit on.
    const OVER_ACCENT = new Set([
      // Dark ink ON the accent, which is the inverse case: measured
      // against the panel it looks black, and against the chip it
      // sits on it is 8:1.
      "#0f1517",
    ]);
    const MEANS_SOMETHING = new Set([
      // A hue that carries information rather than a level of gray:
      // the category color of a masking node, and the blown-highlight
      // warning. Both clear 4:1 and neither can move without changing
      // what it says.
      "#8f7ab8",
      "#e05252",
    ]);
    const NOT_CHROME = new Set([
      // A new gradient stop's starting color. It is picture data that
      // happens to be spelled the same way a style is, and it is judged
      // against the photograph, not against a panel.
      "#808080",
    ]);
    const head = tokens()["--bg-panel-head"];
    const files = readdirSync(resolve(process.cwd(), "src/ui")).filter((f) => f.endsWith(".tsx"));
    const failures: string[] = [];
    for (const f of files) {
      const text = readFileSync(resolve(process.cwd(), "src/ui", f), "utf8");
      for (const m of text.matchAll(/color:\s*"(#[0-9a-fA-F]{6})"/g)) {
        const hex = m[1].toLowerCase();
        if (OVER_ACCENT.has(hex) || MEANS_SOMETHING.has(hex) || NOT_CHROME.has(hex)) continue;
        const c = contrast(hex, head);
        if (c < FLOOR) failures.push(`ui/${f}: ${hex} at ${c.toFixed(2)}:1`);
      }
    }
    expect(failures).toEqual([]);
  });
});
