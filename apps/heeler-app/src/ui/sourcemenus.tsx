// The Source section's four choices as dropdowns, one component for
// every seat: Develop's Source section, the graph inspector's Source
// node, and the two RAW defaults in Preferences > Import & Files.
//
// 2026-09-29, on the four rows of segmented buttons: "There are four
// options with buttons of different width and count. It just looks
// sloppy, make these a dropdown option menu. This also means you should
// update Preferences > File & Import to also be a dropdown option menu
// as well." And then: "make sure the dropdowns are all the same width
// (defaulting to the length of the longest word in all 4)". The width
// comes from the labels themselves (MenuField's fitLabels), so renaming
// an option keeps every field fitting and every field the same.

import { PARAM_OPTIONS } from "../state";
import { MenuField } from "./menufield";
import type React from "react";

type Choice = { id: string; label: string; hint: string };

const HIGHLIGHT_HINTS: Record<string, string> = {
  clip: "Cut blown channels at sensor white",
  blend: "Fill a blown channel from the two that survived",
  rebuild: "Reconstruct blown areas, rolling their color off",
};

const DEMOSAIC_HINTS: Record<string, string> = {
  fast: "Linear interpolation: quickest, softest",
  standard: "The decoder's default quality",
  fine: "DHT: slowest, resolves fine detail best",
};

export const SOURCE_SHARPENING_HINTS: Record<string, string> = {
  off: "The RAW as the demosaic leaves it, no capture sharpening",
  low: "A light capture sharpening, for soft subjects and high ISO",
  standard: "Restores the fine detail the sensor and lens soften, like other editors' RAW default",
  high: "Crisper fine texture, for landscapes and architecture at base ISO",
};

const PROFILE_HINTS: Record<string, string> = {
  linear: "Flattest start: scene-linear, no contrast curve",
  standard: "A conventional camera and editor starting contrast",
  film: "A film-like base contrast under every later edit",
};

const withHints = (options: { id: string; label: string }[], hints: Record<string, string>): Choice[] =>
  options.map((o) => ({ ...o, hint: hints[o.id] ?? o.label }));

const sourceOptions = (param: string) => PARAM_OPTIONS["heeler.image_source"]?.[param] ?? [];

/** The tone profile's modes; a text param with no PARAM_OPTIONS entry
 * of its own, so named here once for Develop, the inspector and
 * Preferences alike. */
export const PROFILE_CHOICES: Choice[] = withHints(
  [
    { id: "linear", label: "Linear" },
    { id: "standard", label: "Standard" },
    { id: "film", label: "Film" },
  ],
  PROFILE_HINTS,
);

export const HIGHLIGHT_CHOICES = withHints(sourceOptions("highlights"), HIGHLIGHT_HINTS);
export const DEMOSAIC_CHOICES = withHints(sourceOptions("demosaic"), DEMOSAIC_HINTS);
export const SHARPENING_CHOICES = withHints(sourceOptions("sharpening"), SOURCE_SHARPENING_HINTS);

/** Every label in the given menus, once each: the list the fields fit. */
export const fitOf = (...menus: Choice[][]): string[] => [
  ...new Set(menus.flatMap((m) => m.map((o) => o.label))),
];

/** The Source section's four menus fit the longest word in all four. */
export const SOURCE_FIT = fitOf(HIGHLIGHT_CHOICES, DEMOSAIC_CHOICES, SHARPENING_CHOICES, PROFILE_CHOICES);

/** The image source's three decoder rows, in the order both seats show
 * them: [label, param, default, choices, accessible name]. */
export const SOURCE_MENU_ROWS = [
  ["Highlights", "highlights", "clip", HIGHLIGHT_CHOICES, "Highlight reconstruction"],
  ["Demosaic", "demosaic", "standard", DEMOSAIC_CHOICES, "Demosaic quality"],
  ["Sharpening", "sharpening", "standard", SHARPENING_CHOICES, "Capture sharpening"],
] as const;

/** One labeled row: the kicker in its column and the menu. The column is
 * 78px, the selection panel's label column: at 68 "SHARPENING" in the
 * kicker's letter spacing ran into its menu. */
export function SourceMenuRow({
  label,
  name,
  value,
  choices,
  testid,
  onChange,
  fit = SOURCE_FIT,
  after,
  labelSize,
}: {
  label: string;
  /** the accessible name, which can say more than the kicker */
  name: string;
  value: string;
  choices: Choice[];
  testid: string;
  onChange: (id: string) => void;
  /** the labels the field fits; the Source menus' own by default, and
   * a Finish warp's Type fits its two */
  fit?: string[];
  /** what the row holds after the menu: a Finish warp's Add shape */
  after?: React.ReactNode;
  /** the kicker's size where its panel's other labels are larger than
   * the theme's kicker (a Finish warp's, at the warp sections' 11px) */
  labelSize?: number;
}) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
      <div className="kicker" style={{ width: 78, flex: "none", fontSize: labelSize }}>
        {label}
      </div>
      <MenuField
        testid={testid}
        label={name}
        value={value}
        options={choices}
        onChange={onChange}
        size="regular"
        fitLabels={fit}
      />
      {after}
    </div>
  );
}
