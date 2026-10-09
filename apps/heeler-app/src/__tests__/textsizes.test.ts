// The text size rule: no inline fontSize below 11px in ui/*.tsx; help
// text, lists and reports use the shared .help class at 12px/1.5 and
// labels the .lbl class at 11px. 2026-09-19: "I don't know why all
// agents keep defaulting to this barely readable font size."
//
// The legacy allowlist is the tree as the rule landed: those files may
// keep their small sizes until their own cleanup, but no file joins
// them, and the two files the rule was written for, the chart editor
// and the Color Checker's controls, are clean and stay out.

import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";

const UI = resolve(process.cwd(), "src/ui");

/** Inline sizes: `fontSize: 10` and `fontSize: "10px"` alike. */
const INLINE_SIZE = /fontSize:\s*["']?([0-9]+(?:\.[0-9]+)?)/g;

/** Small sizes found in a file, for messages and the allowlist check. */
function smallSizes(file: string): number[] {
  const text = readFileSync(resolve(UI, file), "utf8");
  return [...text.matchAll(INLINE_SIZE)].map((m) => Number(m[1])).filter((v) => v < 11);
}

/** The tree as the rule landed (2026-09-19), alphabetically. Files here
 * keep their legacy sizes; nothing new may join. */
const LEGACY: string[] = [
  "artlayers.tsx",
  "bend.tsx",
  "bendwindow.tsx",
  "bwcontrols.tsx",
  "canvas.tsx",
  "catalogui.tsx",
  "catalogview.tsx",
  "channelchips.tsx",
  "chrome.tsx",
  "colorconsole.tsx",
  "colorsets.tsx",
  "console.tsx",
  "cursortip.tsx",
  "depthtool.tsx",
  "docsviewer.tsx",
  "editors.tsx",
  "eqeditor.tsx",
  "exportpanel.tsx",
  "filltool.tsx",
  "findcontrol.tsx",
  "flare.tsx",
  "gradientstops.tsx",
  "grainfilm.tsx",
  "graph.tsx",
  "graphelsewhere.tsx",
  "hintkey.tsx",
  "keylightgizmo.tsx",
  "lenscharacter.tsx",
  "menufield.tsx",
  "metadata.tsx",
  "nodepalette.tsx",
  "polish.tsx",
  "popoutstatus.tsx",
  "preferences.tsx",
  "quadedit.tsx",
  "recolor.tsx",
  "ribbon.tsx",
  "ribbontable.tsx",
  "selectdialogs.tsx",
  "simple.tsx",
  "smarttool.tsx",
  "spectrum.tsx",
  "splash.tsx",
  "splitview.tsx",
  "surface.tsx",
  "tagrow.tsx",
  "takeswindow.tsx",
  "tether.tsx",
  "toolwindow.tsx",
  "updates.tsx",
  "viewer.tsx",
  "viewface.tsx",
  "zones.tsx",
];

describe("text sizes", () => {
  it("no ui file outside the legacy allowlist has an inline fontSize under 11px", () => {
    const offenders: string[] = [];
    for (const file of readdirSync(UI).filter((f) => f.endsWith(".tsx"))) {
      const small = smallSizes(file);
      if (small.length > 0 && !LEGACY.includes(file)) {
        offenders.push(`${file} (${small.length} under 11px: ${small.join(", ")})`);
      }
    }
    expect(offenders, `files with inline sizes under 11px outside the legacy allowlist:\n${offenders.join("\n")}`).toEqual([]);
  });

  it("the chart editor and the Color Checker are clean and stay out of the legacy list", () => {
    for (const file of ["charteditor.tsx", "colorchecker.tsx"]) {
      expect(LEGACY, `${file} must never be allowlisted`).not.toContain(file);
      const text = readFileSync(resolve(UI, file), "utf8");
      // These two carry no inline fontSize at all: the shared classes
      // (.help, .lbl) and inheritance say every size.
      expect(text.match(/fontSize:/), `${file} should say its sizes through the theme`).toBeNull();
    }
  });

  it("new code adds no new small text: the Phase 10 depth chips read at 11px", () => {
    // The allowlist exempts whole legacy files, but it was written for the
    // sizes that were already there when the rule landed. The depth chips
    // (FROM FILE, Recompute, NO DEPTH MAP; 26.3 Phase 10) are new code
    // inside a legacy file and still have to meet the rule.
    const text = readFileSync(resolve(UI, "simple.tsx"), "utf8");
    const chips = [
      ...text.matchAll(/data-testid=[^\n]*depth-(?:from-file|recompute|missing)[\s\S]{0,400}?style=\{\{([^}]*)\}\}/g),
    ];
    expect(chips.length, "the Phase 10 depth chips should exist in simple.tsx").toBeGreaterThanOrEqual(4);
    const small: string[] = [];
    for (const chip of chips) {
      for (const m of chip[1].matchAll(INLINE_SIZE)) {
        if (Number(m[1]) < 11) small.push(`${chip[0].slice(0, 60)}... fontSize ${m[1]}`);
      }
    }
    expect(small, `new chips with an inline size under 11px:\n${small.join("\n")}`).toEqual([]);
  });

  it("the legacy list names real files that still need it, so it shrinks rather than rots", () => {
    const files = new Set(readdirSync(UI));
    const stale = LEGACY.filter((f) => !files.has(f));
    expect(stale, `allowlisted files that no longer exist: ${stale.join(", ")}`).toEqual([]);
    const clean = LEGACY.filter((f) => files.has(f) && smallSizes(f).length === 0);
    expect(clean, `allowlisted files that are clean now; drop them from the list: ${clean.join(", ")}`).toEqual([]);
  });
});
