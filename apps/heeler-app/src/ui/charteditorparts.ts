// charteditor.tsx's values and helpers that are not components, kept apart so
// charteditor.tsx exports components alone and Vite can refresh it in place as
// it is edited instead of reloading the window.

/** The cell address, spreadsheet style: row letter, column number. */
export function cellAddress(rows: number, cols: number, i: number): string {
  const r = Math.floor(i / cols);
  const c = i % cols;
  void rows;
  return `${String.fromCharCode(65 + r)}${c + 1}`;
}
