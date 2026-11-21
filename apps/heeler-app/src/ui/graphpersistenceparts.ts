import type { ImportedEdits } from "../bridge";

/** The line under the missing-edits notice after an import. */
export function importedLine(r: ImportedEdits, name: (id: string) => string): string {
  const n = (k: number, one: string, many: string) => `${k} ${k === 1 ? one : many}`;
  const parts = [`${n(r.imported.length, "photograph's edits", "photographs' edits")} copied in from ${r.source}.`];
  if (r.kept.length) parts.push(`${n(r.kept.length, "photograph already has", "photographs already have")} edits on this computer and kept them.`);
  if (r.unreadable.length) parts.push(`${n(r.unreadable.length, "file there is", "files there are")} damaged and was left out: ${r.unreadable.map(name).join(", ")}.`);
  if (r.still_missing.length) parts.push(`${n(r.still_missing.length, "edited photograph still has", "edited photographs still have")} no edits here.`);
  return parts.join(" ");
}
