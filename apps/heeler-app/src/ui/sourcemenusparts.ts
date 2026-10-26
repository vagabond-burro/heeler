// sourcemenus.tsx's values and helpers that are not components, kept apart so
// sourcemenus.tsx exports components alone and Vite can refresh it in place as
// it is edited instead of reloading the window.
import { PARAM_OPTIONS } from "../state";

/** A menu choice. `experimental` marks one that works but is not yet
 * right: chosen, its row shows the Experimental chip beside the menu. */
export type Choice = { id: string; label: string; hint: string; experimental?: string };

export const HIGHLIGHT_HINTS: Record<string, string> = {
  clip: "Cut blown channels at sensor white: blown areas stay flat white",
  blend: "Fill a blown channel from the two that survived: blown areas stay neutral and keep their detail (the default)",
};

export const SOURCE_SHARPENING_HINTS: Record<string, string> = {
  off: "The RAW as the demosaic leaves it, no capture sharpening",
  low: "A light capture sharpening, for soft subjects and high ISO",
  standard: "Restores the fine detail the sensor and lens soften, like other editors' RAW default",
  high: "Crisper fine texture, for landscapes and architecture at base ISO",
};

export const PROFILE_HINTS: Record<string, string> = {
  linear: "Flattest start: scene-linear, no contrast curve",
  standard: "A conventional camera and editor starting contrast",
  film: "A film-like base contrast under every later edit",
};

export const withHints = (options: { id: string; label: string }[], hints: Record<string, string>): Choice[] =>
  options.map((o) => ({ ...o, hint: hints[o.id] ?? o.label }));

export const sourceOptions = (param: string) => PARAM_OPTIONS["heeler.image_source"]?.[param] ?? [];

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

/** Clip and Blend: LibRaw's Rebuild left with LibRaw (2026-10-26), and
 * a document saved with it develops with Clip. */
export const HIGHLIGHT_CHOICES: Choice[] = withHints(sourceOptions("highlights"), HIGHLIGHT_HINTS);

export const SHARPENING_CHOICES = withHints(sourceOptions("sharpening"), SOURCE_SHARPENING_HINTS);

/** Every label in the given menus, once each: the list the fields fit. */
export const fitOf = (...menus: Choice[][]): string[] => [
  ...new Set(menus.flatMap((m) => m.map((o) => o.label))),
];

/** The Source section's four menus fit the longest word in all four. */
export const SOURCE_FIT = fitOf(HIGHLIGHT_CHOICES, SHARPENING_CHOICES, PROFILE_CHOICES);

/** The image source's decoder rows, in the order both seats show them:
 * [label, param, default, choices, accessible name]. (The Demosaic row
 * left with LibRaw's other demosaics, 2026-10-26.) */
export const SOURCE_MENU_ROWS = [
  ["Highlights", "highlights", "blend", HIGHLIGHT_CHOICES, "Highlight reconstruction"],
  ["Sharpening", "sharpening", "standard", SHARPENING_CHOICES, "Capture sharpening"],
] as const;
