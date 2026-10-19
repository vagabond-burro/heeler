// docsviewer.tsx's values and helpers that are not components, kept apart so
// docsviewer.tsx exports components alone and Vite can refresh it in place as
// it is edited instead of reloading the window.

/** Block-level rendering: the shapes these docs actually use.
 *
 * Counted, rather than guessed: the guide carries 50 blockquotes (the
 * screenshot placeholders), 33 images, 3 tables, no headings past h3,
 * no horizontal rules and no nested lists. Everything below is one of
 * those; anything else would be a feature with nothing to render. */
/** A heading's anchor, the way the guide's own links spell it: lower
 * case, words joined by hyphens, markdown and punctuation dropped, so
 * "## Zones" answers to "#zones" and "## The order of work" to
 * "#the-order-of-work". */
export function docSlug(heading: string): string {
  return heading
    .replace(/[`*_]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/** Where a query matched, and enough of the line around it to recognize
 * the page from. */
export interface DocHit {
  file: string;
  title: string;
  excerpt: string;
}

/** Searches titles and bodies. Bodies are already in hand: the viewer
 * reads every page to build its tree, so search costs nothing extra and
 * covers the whole guide rather than only the headings. */
export function searchDocs(query: string, texts: Map<string, string>, titles: Map<string, string>): DocHit[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const out: DocHit[] = [];
  for (const [file, text] of texts) {
    const title = titles.get(file) ?? file;
    const line = text
      .split(/\r?\n/)
      .find((l) => l.toLowerCase().includes(q) && !l.startsWith("#"));
    const inTitle = title.toLowerCase().includes(q);
    if (!line && !inTitle) continue;
    const raw = (line ?? "").replace(/[*`>|]/g, "").trim();
    out.push({
      file,
      title,
      excerpt: raw.length > 150 ? `${raw.slice(0, 150)}…` : raw,
    });
  }
  // A title match is what you were looking for; a body match is where
  // the words happen to appear.
  return out.sort((a, b) => {
    const at = a.title.toLowerCase().includes(q) ? 0 : 1;
    const bt = b.title.toLowerCase().includes(q) ? 0 : 1;
    return at - bt || a.file.localeCompare(b.file);
  });
}
