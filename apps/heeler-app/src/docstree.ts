// The shape of the user guide's navigation, worked out from the guide.
//
// The docs are a tree now, and a tree needs an order. It could have
// come from filenames, the way the old flat chapter files carried
// "10-", "60a-" prefixes, but the new guide already states its order in
// prose: every folder's README links its children in the sequence a
// reader should meet them.
//
//   1. [Source](source.md)
//   2. [Exposure](exposure.md)
//
// So that IS the manifest. Nothing in the app decides what comes after
// what, which means adding a page is editing one README and nothing
// else, and the sidebar can never disagree with the page it mirrors.
//
// Anything a README forgot still appears, sorted, under the folder it
// lives in: a doc that shipped is a doc the reader can reach, whether
// or not somebody remembered to link it.

import { readDoc, type DocEntry } from "./bridge";

export interface DocNode {
  /** path relative to the guide root, forward slashes */
  file: string;
  title: string;
  children: DocNode[];
}

/** Resolves a link found in `from` against the guide root.
 *
 * Relative paths are the whole reason this exists: "source.md" inside
 * adjustments/README.md is adjustments/source.md, and "../export.md" is
 * export.md. Getting this wrong is a sidebar that navigates to nothing.
 */
export function resolveDocPath(from: string, href: string): string {
  if (href.startsWith("/")) return href.slice(1);
  const base = from.includes("/") ? from.slice(0, from.lastIndexOf("/")).split("/") : [];
  const out = [...base];
  for (const part of href.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") out.pop();
    else out.push(part);
  }
  return out.join("/");
}

/** The .md links in a document, in the order they appear, deduplicated
 * and resolved against the guide root. Anchors and external URLs are
 * not pages and drop out here. */
export function docLinks(from: string, text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(/\[[^\]]*\]\(([^)\s]+)\)/g)) {
    const href = m[1];
    if (!href.endsWith(".md") || /^[a-z]+:\/\//i.test(href)) continue;
    const path = resolveDocPath(from, href);
    if (!out.includes(path)) out.push(path);
  }
  return out;
}

/** The folder a doc lives in, "" for the guide's root. */
function folderOf(file: string): string {
  return file.includes("/") ? file.slice(0, file.lastIndexOf("/")) : "";
}

/**
 * Builds the sidebar tree.
 *
 * Walks out from the root README following its links in order. A link
 * to a folder's README becomes a branch and is followed in turn; a link
 * to a page becomes a leaf. `read` is injected so this is testable
 * without a backend and so the caller controls caching.
 */
export async function buildDocTree(
  entries: DocEntry[],
  read: (file: string) => Promise<string | null> = readDoc,
  root = "README.md",
): Promise<DocNode[]> {
  const byFile = new Map(entries.map((e) => [e.file, e]));
  const placed = new Set<string>();
  const cache = new Map<string, string>();
  const textOf = async (file: string) => {
    if (!cache.has(file)) cache.set(file, (await read(file)) ?? "");
    return cache.get(file)!;
  };

  // Headings are markdown, so a title can arrive wearing it: the
  // scripting chapter calls itself "Complete `heeler` API reference".
  // The sidebar draws plain text, and backticks in a contents list read
  // as a typo rather than as code.
  const title = (file: string) =>
    (byFile.get(file)?.title ?? file).replace(/[`*]/g, "").trim();

  /** A branch for `readme`, its children in the order it links them. */
  const branch = async (readme: string, depth: number): Promise<DocNode> => {
    placed.add(readme);
    const node: DocNode = { file: readme, title: title(readme), children: [] };
    // Depth is a guard against a pair of READMEs that link each other:
    // the guide is three levels deep and nothing legitimate goes past
    // five, so a cycle stops rather than hanging the dialog.
    if (depth > 5) return node;
    const here = folderOf(readme);
    for (const link of docLinks(readme, await textOf(readme))) {
      if (placed.has(link) || !byFile.has(link)) continue;
      // Only downward. A page linking sideways to another chapter is
      // a cross-reference, not a claim to own it, and following those
      // would file half the guide under whoever mentioned it first.
      const there = folderOf(link);
      const inside = here === "" ? true : there === here || there.startsWith(`${here}/`);
      if (!inside) continue;
      node.children.push(
        link.endsWith("/README.md") || link === "README.md"
          ? await branch(link, depth + 1)
          : ((placed.add(link), { file: link, title: title(link), children: [] }) as DocNode),
      );
    }
    return node;
  };

  const rootNode = byFile.has(root) ? await branch(root, 0) : null;
  const tree: DocNode[] = rootNode ? [rootNode, ...rootNode.children] : [];
  // The root's own children are lifted to the top level: the guide's
  // README is a welcome page, not a folder everything hides inside.
  if (rootNode) rootNode.children = [];

  // Whatever no README claimed, under a heading naming its folder, so
  // a page that shipped is always reachable even if the prose forgot
  // it. Sorted, because there is no stated order to honor.
  const orphans = entries.filter((e) => !placed.has(e.file)).sort((a, b) => a.file.localeCompare(b.file));
  for (const entry of orphans) {
    const parent = tree.find((n) => folderOf(n.file) === folderOf(entry.file) && n.file.endsWith("README.md"));
    const node: DocNode = { file: entry.file, title: entry.title, children: [] };
    if (parent) parent.children.push(node);
    else tree.push(node);
  }
  return tree;
}

/** Depth-first walk, which is the order the sidebar draws in and the
 * order keyboard navigation and search results follow. */
export function flattenDocs(nodes: DocNode[]): DocNode[] {
  return nodes.flatMap((n) => [n, ...flattenDocs(n.children)]);
}
