// lummask.tsx's values and helpers that are not components, kept apart so
// lummask.tsx exports components alone and Vite can refresh it in place as
// it is edited instead of reloading the window.
import { type LevelsWindow } from "./levels";
import { type LevelsKeys } from "./levelsparts";

export const LUMMASK_KEYS: LevelsKeys = { black: "low", white: "high" };

export const LUMMASK_WINDOW: LevelsWindow = { feather: "feather", invert: "invert" };
