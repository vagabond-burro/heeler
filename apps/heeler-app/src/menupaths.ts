// A node's place in the add menus, in text the assistant shows.
//
// 2026-10-01: "I did some tests and in the text instructions where to
// find a node in the menu it did not include the full menu path (it
// used the old menu paths before add sub-categories)." Since the menus
// were split into sections (nodes.ts NODE_SECTIONS), a node is category
// > section > node ("Masking > Mask Tools > Morphology"), and a few are
// listed under a category other than their stripe's (Transform in
// Source > Geometry). The guide's node reference gives every node its
// Menu line; this finds a path in a model's words that names a node and
// is not its full path, "Utility > Channel Extract" or "Add > Utility >
// Measure", and puts the full one in its place.
//
// A ">" is also how the example networks draw a wire ("Source >
// Exposure > Output"), so a chain counts as a menu path only when it
// says so: it starts at the Add or Node menu, or at a category with a
// section of that category after it, or at Masking or Utility (which
// no wiring line starts with: neither is a node's name). Code blocks are
// left alone.

import { CATEGORY_LABEL, NODE_CATALOG, NODE_SECTIONS, RETIRED_TYPES, nodeMenuPath } from "./nodes";

const FAMILIES = new Map(
  (Object.entries(CATEGORY_LABEL) as [string, string][]).filter(([cat]) => cat !== "group").map(([cat, label]) => [label, cat]),
);

/** Categories that are also a node's name or the wiring's word for the
 * photograph ("Source > Blend Mode"): a chain starting at one of them is
 * a menu path only with a menu word or a section after it. */
const AMBIGUOUS = new Set(["Source", "Color", "Detail"]);

const sectionsOf = (label: string) => NODE_SECTIONS.filter((s) => CATEGORY_LABEL[s.family] === label).map((s) => s.label);

/** Every name a node goes by in a path: its own, and its type in words
 * ("Channel Extract" for heeler.channel_extract, which the menus call
 * Channel) unless that is another node's name. Longest first, so
 * "Channel Join" wins over "Channel". */
const NAMES: { name: string; type: string }[] = (() => {
  const live = NODE_CATALOG.filter((n) => !RETIRED_TYPES.has(n.type));
  const own = new Set(live.map((n) => n.name.toLowerCase()));
  const out = live.map((n) => ({ name: n.name, type: n.type }));
  for (const n of live) {
    const words = n.type.replace(/^heeler\./, "").split("_").map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");
    if (!own.has(words.toLowerCase())) out.push({ name: words, type: n.type });
  }
  return out.sort((a, b) => b.name.length - a.name.length);
})();

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** The node a path's last part starts with, and how long that name is. */
function nodeAtStart(part: string): { type: string; length: number } | null {
  for (const n of NAMES) {
    const m = new RegExp(`^${escapeRe(n.name)}(?![A-Za-z0-9])`, "i").exec(part);
    if (m) return { type: n.type, length: m[0].length };
  }
  return null;
}

export interface MenuPathMention {
  /** where the path starts (its category) and ends (its node's name) */
  start: number;
  end: number;
  /** the path as written, without bold marks */
  said: string;
  type: string;
  /** the full path, nodes.ts nodeMenuPath */
  want: string;
  ok: boolean;
}

/** One ">" chain, its parts not yet told apart. */
const CHAIN = /[A-Za-z0-9&/()'*][A-Za-z0-9&/()'* -]*?(?:\s*>\s*[A-Za-z0-9&/()'*][A-Za-z0-9&/()'* -]*)+/g;
/** Preserve examples and quotations verbatim. Fence length matters:
 * three backticks inside a four-backtick example do not close it. */
function literalRanges(text: string): [number, number][] {
  const ranges: [number, number][] = [];
  let fence: { char: string; length: number; start: number } | null = null;
  for (const line of text.matchAll(/[^\n]*(?:\n|$)/g)) {
    const at = line.index!;
    const marker = /^ {0,3}(`{3,}|~{3,})(.*)/.exec(line[0]);
    if (fence) {
      if (marker && marker[1][0] === fence.char && marker[1].length >= fence.length && !marker[2].trim()) {
        ranges.push([fence.start, at + line[0].length]);
        fence = null;
      }
    } else if (marker) {
      fence = { char: marker[1][0], length: marker[1].length, start: at };
    } else if (/^(?: {0,3}>| {4}|\t)/.test(line[0])) {
      ranges.push([at, at + line[0].length]);
    }
  }
  if (fence) ranges.push([fence.start, text.length]);
  // Code spans close only with a run of the same length. Quoted prose
  // includes the user's old menu labels, which are evidence, not advice.
  for (const m of text.matchAll(/(`+)([\s\S]*?)\1(?!`)|"[^"\n]*"|(?<![A-Za-z])'[^'\n]*'(?![A-Za-z])/g)) {
    ranges.push([m.index!, m.index! + m[0].length]);
  }
  return ranges;
}

type Part = { text: string; at: number };

/** A part that is only a menu's word: a category, a section, Add or
 * Node. Any other part ends a path (a node's name, with whatever words
 * follow it), and its own last word may start the next one ("... File
 * in the menu bar (Add > Source > ..."). */
const LABELS = new Set(["Add", "Node", ...FAMILIES.keys(), ...NODE_SECTIONS.map((s) => s.label)]);

/** One run of parts as a menu path naming a node, or null. */
function mention(text: string, parts: Part[]): MenuPathMention | null {
  // The first part ends in a menu word or a category: "choose Add".
  const head = /(?:^|[^A-Za-z])(Add|Node|Source|Color|Detail|Masking|Utility)$/.exec(parts[0].text);
  if (!head) return null;
  const menu = head[1] === "Add" || head[1] === "Node";
  if (menu && (!parts[1] || !FAMILIES.has(parts[1].text))) return null;
  const cat = menu ? parts[1].text : head[1];
  const catAt = menu ? parts[1].at : parts[0].at + parts[0].text.length - head[1].length;
  const rest = parts.slice(menu ? 2 : 1);
  if (rest.length === 0) return null;
  const last = rest[rest.length - 1];
  const node = nodeAtStart(last.text);
  if (!node) return null;
  const middle = rest.slice(0, -1).map((p) => p.text);
  const sections = sectionsOf(cat);
  // A category and one of its sections, with no node after: a section
  // named, not a node ("Utility > Output", "Color > Color", and "Utility
  // > Color Space", which is not the Color node).
  const named = text.slice(last.at, last.at + node.length);
  const section = sections.find((s) => new RegExp(`^${escapeRe(s)}(?![A-Za-z0-9])`, "i").test(last.text));
  if (middle.length === 0 && section && section.length >= named.length) return null;
  if (!menu) {
    const sectioned = middle.length > 0 && middle.every((p) => sections.includes(p));
    if (!sectioned && (middle.length > 0 || AMBIGUOUS.has(cat))) return null;
  }
  const said = [cat, ...middle, named].join(" > ");
  const want = nodeMenuPath(node.type)!;
  return { start: catAt, end: last.at + node.length, said, type: node.type, want, ok: said === want };
}

/** Every menu path in a text that names a node (outside code blocks),
 * with whether it is that node's full path. */
export function menuPathMentions(text: string): MenuPathMention[] {
  const literals = literalRanges(text);
  const out: MenuPathMention[] = [];
  const take = (chain: Part[]) => {
    const found = chain.length > 1 ? mention(text, chain) : null;
    if (found && !literals.some(([a, b]) => found.start < b && found.end > a)) out.push(found);
  };
  for (const line of text.matchAll(/[^\n]+/g)) {
    for (const m of line[0].matchAll(CHAIN)) {
      const at0 = line.index! + m.index!;
      // The parts, with their offsets in the text, bold marks aside.
      const parts: Part[] = [];
      for (const p of m[0].matchAll(/[^>]+/g)) {
        const raw = p[0];
        const lead = raw.length - raw.replace(/^[\s*]+/, "").length;
        parts.push({ text: raw.replace(/^[\s*]+/, "").replace(/[\s*]+$/, ""), at: at0 + p.index! + lead });
      }
      let chain: Part[] = [parts[0]];
      for (const p of parts.slice(1)) {
        chain.push(p);
        if (LABELS.has(p.text)) continue;
        take(chain);
        chain = [p];
      }
      take(chain);
    }
  }
  return out;
}

/** The text with every menu path that names a node made its full path
 * (bold marks inside it dropped). */
export function fixMenuPaths(text: string): string {
  const bad = menuPathMentions(text).filter((m) => !m.ok);
  let out = text;
  for (const m of bad.reverse()) out = `${out.slice(0, m.start)}${m.want}${out.slice(m.end)}`;
  return out;
}
