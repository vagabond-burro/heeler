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
  rebuild: "Experimental: reconstruct blown areas further; it can tint a blown sky",
};

export const DEMOSAIC_HINTS: Record<string, string> = {
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

/** Rebuild is LibRaw's own reconstruction, and on a blown sky it tints
 * what it rebuilds cyan at every strength (2026-10-10, measured on the
 * fixture in heeler-raw's highlight_neutrality.rs), so it stays on offer
 * marked experimental and blend is the default. */
export const HIGHLIGHT_CHOICES: Choice[] = withHints(sourceOptions("highlights"), HIGHLIGHT_HINTS).map((o) =>
  o.id === "rebuild" ? { ...o, experimental: "Rebuild is experimental: it can tint a blown sky (cyan, in testing). Blend keeps blown areas neutral." } : o,
);

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
  ["Highlights", "highlights", "blend", HIGHLIGHT_CHOICES, "Highlight reconstruction"],
  ["Demosaic", "demosaic", "standard", DEMOSAIC_CHOICES, "Demosaic quality"],
  ["Sharpening", "sharpening", "standard", SHARPENING_CHOICES, "Capture sharpening"],
] as const;
