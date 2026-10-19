// suggestfield.tsx's values and helpers that are not components, kept apart so
// suggestfield.tsx exports components alone and Vite can refresh it in place as
// it is edited instead of reloading the window.

/** How many suggestions the list shows at most. */
export const SHOWN = 8;

/** The suggestions for `typed`: every one containing it, case aside,
 * the exact match left out (it is already in the field). */
export function suggestionsFor(all: string[], typed: string): string[] {
  const q = typed.trim().toLowerCase();
  return all.filter((s) => s.toLowerCase().includes(q) && s.toLowerCase() !== q).slice(0, SHOWN);
}
