// exportpanel.tsx's values and helpers that are not components, kept apart so
// exportpanel.tsx exports components alone and Vite can refresh it in place as
// it is edited instead of reloading the window.

/** The Size row's choices; the guided tours' export stops read them. */
export const EXPORT_SIZES: [string, number | null][] = [
  ["Full", null],
  ["4096", 4096],
  ["2048", 2048],
  ["1024", 1024],
];
