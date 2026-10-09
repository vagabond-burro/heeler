// The assistant's reading of the user guide. Two things decide
// what a question is answered from, both built on this computer:
//
// 1. The table of contents: every chapter's path, title and one line,
// sent with the question so the model names the chapters it needs.
// 2026-09-28: a keyword match alone answered "darken the sky" about a
// color photograph from the Black and White chapter. Measured against
// his Qwen3 30B the same day, the model's choice held the right chapter
// far more often than any word match. 2. A local ranking of SECTIONS,
// not whole chapters: each chapter is split at its headings and every
// section scored BM25-style, with headings and titles counting above
// body text and rare words above common ones. The chosen chapters' best
// sections go first, then the best sections of other chapters, within
// the budget, so one long chapter cannot crowd out the rest. When the
// model's choice cannot be read, the ranking alone chooses.
//
// Nothing here is learned or stored, and nothing leaves the computer
// except what the Console sends to the user's own model server.

import type { Chapter, Workspace } from "./assistant";

// -- words ----------------------------------------------------------------

const STOP = new Set(
  ("the a an and or but to of in on at for with from by is are was were be been it this that these those how what when where why " +
    "which who do does did can could should would will my me you your we our its as if then than so not no yes into about " +
    "heeler use using get make there here have has had any some all more most like just want need way please thing things " +
    "also only one each other them they their very too much many out off without rest else whole")
    .split(" "),
);

/** A light stemmer: enough that "darken" meets "dark", "selection"
 * meets "select" and "layers" meets "layer", applied the same way to
 * the question and the guide, so it only has to be consistent. */
export function stem(word: string): string {
  let w = word;
  if (w.length <= 3) return w;
  if (w.endsWith("ies") && w.length > 4) w = `${w.slice(0, -3)}y`;
  else if (/(sses|xes|ches|shes)$/.test(w)) w = w.slice(0, -2);
  else if (w.endsWith("s") && !w.endsWith("ss") && !w.endsWith("us") && w.length > 3) w = w.slice(0, -1);
  if (w.endsWith("ing") && w.length > 5) w = w.slice(0, -3);
  else if (w.endsWith("ed") && w.length > 4) w = w.slice(0, -2);
  else if (w.endsWith("ion") && w.length > 6) w = w.slice(0, -3);
  else if (w.endsWith("ly") && w.length > 5) w = w.slice(0, -2);
  if (w.endsWith("e") && w.length > 4) w = w.slice(0, -1);
  if (/[^aeiou]en$/.test(w) && w.length >= 6) w = w.slice(0, -2);
  return w;
}

/** The stemmed words of a text, stop words left out, in order. */
export function words(text: string): string[] {
  const out: string[] = [];
  for (const w of text.toLowerCase().replace(/[’']s\b/g, "").match(/[a-z0-9]+/g) ?? []) {
    if (w.length < 2 || STOP.has(w)) continue;
    out.push(stem(w));
  }
  return out;
}

/** Pairs of neighboring words, so "white balance" or "back up" (the
 * guide's "backup") is matched as a phrase and weighed by how rare the
 * phrase is. */
function pairs(ws: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i + 1 < ws.length; i++) out.push(`${ws[i]} ${ws[i + 1]}`);
  return out;
}

/** A photographer's word for what the guide names otherwise, each
 * mapped to the guide's own words (stemmed), weighed at half. Only
 * words the guide provably uses for the same thing. */
const ALSO: Record<string, string[]> = {
  bw: ["black", "white"],
  mono: ["black", "white"],
  monochrome: ["black", "white"],
  grayscale: ["black", "white"],
  greyscale: ["black", "white"],
  iso: ["nois"],
  grainy: ["nois"],
  denois: ["nois"],
  crook: ["straight"],
  tilt: ["straight"],
  horizon: ["straight", "level"],
  bokeh: ["depth", "field"],
  undo: ["history"],
  revert: ["history"],
  earlier: ["history"],
  previous: ["history"],
  retouch: ["remov", "heal"],
  // A dust spot is Heal's (and Clone's) work: Finish's Pixel layer and
  // its toolbar name the tools, never the dust.
  dust: ["heal", "clon"],
  distract: ["remov", "object"],
  face: ["local", "smart"],
  person: ["local", "subject"],
  // "Select the cheetah" is the Smart Selection tools' job.
  select: ["smart"],
  subject: ["smart", "select"],
  cutout: ["select", "mask"],
  stitch: ["panorama"],
  pano: ["panorama"],
  hdr: ["stack"],
  bracket: ["stack", "hdr"],
  jpg: ["jpeg"],
  // A named color is a hue: "a red car to blue" is Recolor's and Color
  // Tune's work, which speak of hues and color families.
  ...Object.fromEntries(["red", "yellow", "green", "cyan", "blue", "purpl", "magenta", "pink"].map((c) => [c, ["hue", "family", "recolor"]])),
  temperatur: ["temp"],
  warm: ["temp"],
  orang: ["temp", "white balanc"],
};

// -- sections ---------------------------------------------------------------

export interface Section {
  file: string;
  /** the chapter's title */
  chapter: string;
  /** the heading this section sits under, "" for the chapter's opening */
  heading: string;
  /** position in the chapter, for putting sections back in order */
  order: number;
  /** the section as the model reads it, its heading line included */
  text: string;
}

/** A chapter cut at its headings (#, ##, ###), never inside a code
 * block. The opening, before the first sub-heading, is its own section
 * under the chapter's title. */
export function splitSections(c: Chapter): Section[] {
  const out: Section[] = [];
  let heading = "";
  let lines: string[] = [];
  let fenced = false;
  const flush = () => {
    const text = lines.join("\n").trim();
    if (text) out.push({ file: c.file, chapter: c.title, heading, order: out.length, text });
    lines = [];
  };
  for (const line of c.text.split("\n")) {
    if (/^\s*```/.test(line)) fenced = !fenced;
    const m = !fenced && /^(#{1,4})\s+(.*)$/.exec(line);
    if (m) {
      if (m[1].length === 1) {
        // The chapter's own title opens its first section.
        if (lines.some((l) => l.trim())) flush();
        lines.push(line);
        continue;
      }
      flush();
      heading = m[2].replace(/[`*]/g, "").trim();
    }
    lines.push(line);
  }
  flush();
  return out;
}

interface Indexed {
  s: Section;
  title: Map<string, number>;
  head: Map<string, number>;
  body: Map<string, number>;
  len: number;
}

export interface GuideIndex {
  chapters: Chapter[];
  sections: Indexed[];
  df: Map<string, number>;
  avgLen: number;
}

function counts(ws: string[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const w of ws) m.set(w, (m.get(w) ?? 0) + 1);
  return m;
}

function withPairs(ws: string[]): string[] {
  return [...ws, ...pairs(ws)];
}

/** Pages that are not guidance: other people's license texts. */
export const NOT_GUIDANCE = new Set(["legal/third-party-notices.md", "legal/cddl.md"]);

/** The guide, cut into sections and counted once per session. */
export function indexGuide(guide: Chapter[]): GuideIndex {
  const chapters = guide.filter((c) => !NOT_GUIDANCE.has(c.file));
  const sections: Indexed[] = [];
  const df = new Map<string, number>();
  let total = 0;
  for (const c of chapters) {
    const title = counts(withPairs(words(c.title)));
    for (const s of splitSections(c)) {
      const head = counts(withPairs(words(s.heading)));
      const bodyWords = words(s.text);
      const body = counts(withPairs(bodyWords));
      const seen = new Set([...title.keys(), ...head.keys(), ...body.keys()]);
      for (const w of seen) df.set(w, (df.get(w) ?? 0) + 1);
      sections.push({ s, title, head, body, len: bodyWords.length });
      total += bodyWords.length;
    }
  }
  return { chapters, sections, df, avgLen: sections.length ? total / sections.length : 1 };
}

const K1 = 1.2;
const B = 0.75;
const W_TITLE = 2.5;
const W_HEAD = 3;
const PAIR_WEIGHT = 0.6;

export interface Scored {
  s: Section;
  score: number;
}

/** The question's terms with their weights: its words, its phrases,
 * and the guide's words for a photographer's (ALSO) at half. */
function queryTerms(question: string): Map<string, number> {
  const ws = words(question);
  const q = new Map<string, number>();
  for (const w of ws) q.set(w, 1);
  // A pair is rarer than either word, so its idf alone is large; at
  // full weight two common words side by side ("without changing")
  // outranked the one word that mattered.
  for (const p of pairs(ws)) q.set(p, PAIR_WEIGHT);
  // "back up" is the guide's "backup": a pair written as one word.
  for (let i = 0; i + 1 < ws.length; i++) {
    const joined = stem(`${ws[i]}${ws[i + 1]}`);
    if (!q.has(joined)) q.set(joined, 1);
  }
  for (const w of ws) {
    for (const a of ALSO[w] ?? []) if (!q.has(a)) q.set(a, 0.5);
  }
  return q;
}

/** How much more a section of the graph's chapters (graph/..., the node
 * reference among them) counts when the user is in the graph: there a
 * question is answered in nodes and wires (2026-09-28).*/
export const GRAPH_LEAN = 3;
/** And how much less in Develop, unless the question itself is about the
 * graph: there "add grain" is the Grain section, not the Grain node. */
export const DEVELOP_GRAPH_LEAN = 0.5;

/** Words that make a question about the graph wherever it is asked. */
const GRAPH_WORDS = /\b(graph|node|nodes|wire|wires|wiring|port|ports)\b/i;

/** Words that make a question about Develop wherever it is asked ("add
 * a gradient layer in Finish" asked in the graph). */
const DEVELOP_WORDS = /\b(develop|adjustments|finish|sections?|sliders?|layers?)\b/i;

/** The workspace's lean on a section's score. */
export function leanFor(file: string, workspace: Workspace | null | undefined, question = ""): number {
  if (!file.startsWith("graph/")) return 1;
  if (workspace === "Graph" || workspace === "Canvas") return DEVELOP_WORDS.test(question) ? 1 : GRAPH_LEAN;
  if (workspace === "Develop" && !GRAPH_WORDS.test(question)) return DEVELOP_GRAPH_LEAN;
  return 1;
}

/** Every section scored against the question, best first; sections
 * that share no word with it are left out. `workspace` leans the score
 * toward the chapters that say how where the user is (leanFor). */
export function scoreSections(question: string, index: GuideIndex, workspace: Workspace | null = null): Scored[] {
  const q = queryTerms(question);
  const n = index.sections.length;
  const out: Scored[] = [];
  for (const x of index.sections) {
    let score = 0;
    for (const [t, weight] of q) {
      const d = index.df.get(t);
      if (!d) continue;
      const tf = W_TITLE * (x.title.get(t) ?? 0) + W_HEAD * (x.head.get(t) ?? 0) + (x.body.get(t) ?? 0);
      if (tf === 0) continue;
      const idf = Math.log(1 + (n - d + 0.5) / (d + 0.5));
      score += weight * idf * ((tf * (K1 + 1)) / (tf + K1 * (1 - B + (B * x.len) / index.avgLen)));
    }
    if (score > 0) out.push({ s: x.s, score: score * leanFor(x.s.file, workspace, question) });
  }
  return out.sort((a, b) => b.score - a.score || a.s.file.localeCompare(b.s.file) || a.s.order - b.s.order);
}

/** Chapters by their best sections: the best one, and half the next,
 * so a chapter with two sections on the question outranks one with a
 * single stray mention. */
export function rankChapters(scored: Scored[]): string[] {
  const per = new Map<string, number[]>();
  for (const x of scored) {
    const l = per.get(x.s.file) ?? [];
    if (l.length < 2) l.push(x.score);
    per.set(x.s.file, l);
  }
  return [...per.entries()]
    .map(([file, l]) => ({ file, score: l[0] + 0.5 * (l[1] ?? 0) }))
    .sort((a, b) => b.score - a.score || a.file.localeCompare(b.file))
    .map((x) => x.file);
}

// -- the material ---------------------------------------------------------------

/** How much of the guide goes with one question, in characters (about
 * a quarter of that in tokens). The whole guide is over 300,000
 * characters, which no small local model holds, and LM Studio loads
 * many models with a 4,096 token context by default; this leaves room
 * for the instructions, the question, the history and the answer
 * inside that. */
export const GUIDE_BUDGET = 9000;
/** A larger context, when the server says the model has one, lets the
 * budget grow to this and no further: more text slows a local model
 * and thins its attention without adding much the best sections miss. */
export const GUIDE_BUDGET_MAX = 24000;
/** At most this many chapters chosen, by the model or the ranking. */
export const MAX_CHOSEN = 3;
/** When the ranking chooses alone, it takes this many chapters whole
 * (their best sections first) and adds the best sections of others. */
const LOCAL_CHOSEN = 2;
/** A section from a chapter nobody chose is shortened past this. */
const EXTRA_SECTION_MAX = 1500;
/** At most this many sections from one chapter nobody chose. */
const EXTRA_PER_CHAPTER = 2;
/** A section from a chapter nobody chose scores at least this share of
 * the best section's score. */
const EXTRA_SCORE_FLOOR = 0.25;
/** At most this many sections from chapters nobody chose, however
 * large the budget: past a handful they thin the model's attention
 * more than they add. */
const EXTRA_SECTIONS = 8;

/** The budget for a model whose context the server reported, in
 * tokens. The same 4,096 tokens the default is tuned for gives the
 * default; a larger context grows it, never past GUIDE_BUDGET_MAX. */
export function budgetFor(contextTokens: number | null | undefined): number {
  if (!contextTokens || !Number.isFinite(contextTokens) || contextTokens <= 4096) return GUIDE_BUDGET;
  // Beyond 4,096 tokens, three characters per spare token, the rest
  // kept for the conversation and the answer.
  const grown = GUIDE_BUDGET + Math.floor((contextTokens - 4096) * 3 * 0.6);
  return Math.min(GUIDE_BUDGET_MAX, grown);
}

function shorten(text: string, room: number): string {
  if (text.length <= room) return text;
  const cut = text.slice(0, room);
  const para = cut.lastIndexOf("\n\n");
  const at = para > room * 0.5 ? para : Math.max(cut.lastIndexOf(". ") + 1, Math.floor(room * 0.8));
  return `${text.slice(0, at).trim()}\n[shortened]`;
}

export interface Material {
  /** the chapters sent, each with only the sections chosen for it, in
   * the chapter's own order */
  chapters: Chapter[];
  /** which of them were chosen (by the model, or by the ranking when
   * the model's choice could not be read) */
  chosen: string[];
}

/** What goes with the question: the chosen chapters' sections, best
 * first, each chapter with its opening, then the best sections of other
 * chapters, all within the budget. With no chapters chosen, the
 * ranking chooses. */
export function gatherMaterial(
  question: string,
  index: GuideIndex,
  chosen: string[] = [],
  budget = GUIDE_BUDGET,
  workspace: Workspace | null = null,
): Material {
  const scored = scoreSections(question, index, workspace);
  const known = new Set(index.chapters.map((c) => c.file));
  let picks = chosen.filter((f, i) => known.has(f) && chosen.indexOf(f) === i).slice(0, MAX_CHOSEN);
  if (picks.length === 0) picks = rankChapters(scored).slice(0, LOCAL_CHOSEN);
  const scoreOf = new Map(scored.map((x) => [x.s, x.score]));
  const taken = new Map<string, { s: Section; text: string }[]>();
  let left = budget;
  const take = (s: Section, room: number) => {
    const text = shorten(s.text, room);
    const l = taken.get(s.file) ?? [];
    l.push({ s, text });
    taken.set(s.file, l);
    left -= text.length + 2;
  };

  // The chosen chapters share half the budget, what one leaves unused
  // passing to the next and, at the end, to the sections elsewhere
  // (half, not more: with more, two chosen chapters crowded out the
  // one section that answered "brighten just the face").
  let share = Math.floor(budget * 0.5);
  picks.forEach((file, i) => {
    const room0 = Math.floor(share / (picks.length - i));
    let room = room0;
    const secs = index.sections
      .filter((x) => x.s.file === file)
      .map((x) => x.s)
      .sort((a, b) => (a.order === 0 ? -1 : b.order === 0 ? 1 : (scoreOf.get(b) ?? 0) - (scoreOf.get(a) ?? 0) || a.order - b.order));
    for (const s of secs) {
      if (room < 300 || left < 300) break;
      // A section that says nothing to the question comes only whole
      // and only if it fits: the opening always, the rest by score.
      if (s.order !== 0 && !scoreOf.has(s) && s.text.length > room) continue;
      const before = left;
      take(s, Math.min(room, left));
      room -= before - left;
    }
    share -= room0 - room;
  });

  // Then the best sections anywhere else, down to a fraction of the
  // best score: past that a section shares a word with the question
  // and nothing more (with a larger budget, the privacy policy came
  // along with "remove a dust spot").
  // The agreements come only when chosen: their clauses share words
  // with any question ("select", "remove") and answer none of them.
  const extra = new Map<string, number>();
  const floor = (scored[0]?.score ?? 0) * EXTRA_SCORE_FLOOR;
  let extras = 0;
  for (const x of scored) {
    if (left < 300 || x.score < floor || extras >= EXTRA_SECTIONS) break;
    if (picks.includes(x.s.file) || x.s.file.startsWith("legal/")) continue;
    extras++;
    const n = extra.get(x.s.file) ?? 0;
    if (n >= EXTRA_PER_CHAPTER) continue;
    extra.set(x.s.file, n + 1);
    take(x.s, Math.min(EXTRA_SECTION_MAX, left));
  }

  const titles = new Map(index.chapters.map((c) => [c.file, c.title]));
  const order = [...picks.filter((f) => taken.has(f)), ...[...taken.keys()].filter((f) => !picks.includes(f))];
  const chapters = order.map((file) => ({
    file,
    title: titles.get(file) ?? file,
    text: taken
      .get(file)!
      .sort((a, b) => a.s.order - b.s.order)
      .map((t) => t.text)
      .join("\n\n"),
  }));
  return { chapters, chosen: picks.filter((f) => taken.has(f)) };
}

// -- the table of contents ----------------------------------------------------

function cutAt(s: string, max: number): string {
  if (s.length <= max) return s;
  const cut = s.slice(0, max);
  return `${cut.slice(0, Math.max(cut.lastIndexOf(" "), max - 15)).replace(/[,;.]$/, "")}...`;
}

/** How much the table of contents says of each chapter. "lean" goes
 * with a model whose context is unknown or 4,096 tokens; "full"
 * when the server reports more (the owner's Qwen3 is loaded at
 * 8,192).*/
export type TocDetail = "lean" | "full";

const TOC: Record<TocDetail, { summary: number; sentences: boolean; headings: number }> = {
  lean: { summary: 55, sentences: false, headings: 0 },
  full: { summary: 100, sentences: true, headings: 60 },
};

/** One chapter's line: its opening, without links, images or emphasis,
 * and without the title it usually starts with ("Sky Rescue identifies"
 * reads "identifies" after the title), cut at a word near `max`
 * characters. `sentences` keeps going past the first sentence of the
 * opening paragraph, where a chapter often names its tools ("A Pixel
 * layer is a transparent canvas... Paint, Clone, Heal"). Empty when the
 * opening says nothing a title does not ("Effective date"). */
export function summaryLine(text: string, title: string, max = TOC.lean.summary, sentences = false): string {
  const paras = text.split(/\n\s*\n/).map((p) => p.trim());
  const para = paras.find((p) => p && !p.startsWith("#") && !/^!\[/.test(p) && !/^\|/.test(p) && !/^```/.test(p)) ?? "";
  let s = para
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/[*_`]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!sentences) {
    const end = s.search(/[.:](\s|$)/);
    if (end > 0) s = s.slice(0, end);
  }
  const t = title.toLowerCase();
  const m = /^(?:(?:a|an|the)\s+)?/i.exec(s);
  const rest = s.slice(m ? m[0].length : 0);
  if (rest.toLowerCase().startsWith(t) && rest.length > t.length + 1) s = rest.slice(t.length).trim();
  s = s.replace(/[.:]$/, "");
  if (s.length < 25) return "";
  return cutAt(s, max);
}

/** Headings that name a part of every chapter, not what a chapter is
 * about. */
const GENERIC_HEADINGS = new Set(["controls", "notes", "keys", "reset", "edges", "the lines' color", "order", "pages", "effects", "method"]);

/** The whole guide in a few lines a model can choose from: every
 * chapter's path, its title where the path does not already say it,
 * and a line from its opening; with room ("full"), the names of its
 * main sections too, which say more about what a chapter covers than
 * its first sentence ("Ratings and flags"). Measured by the test: it
 * goes with every question, and "lean" leaves room for the rest inside
 * a 4,096 token context. */
export function tableOfContents(guide: Chapter[], detail: TocDetail = "lean"): string {
  const d = TOC[detail];
  return guide
    .filter((c) => !NOT_GUIDANCE.has(c.file))
    .map((c) => {
      const base = c.file.replace(/^.*\//, "").replace(/\.md$/, "");
      const slug = c.title.toLowerCase().replace(/&/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
      const parts = [c.file];
      if (slug !== base) parts.push(c.title);
      // The API reference and the agreements are found by their titles;
      // their openings and headings are function names and clause
      // numbers, which a model choosing chapters does not need.
      if (/^(scripting\/reference|legal)\/./.test(c.file) && !c.file.endsWith("README.md")) return parts.join(": ");
      const line = summaryLine(c.text, c.title, d.summary, d.sentences);
      if (line) parts.push(line);
      if (d.headings > 0) {
        const heads = [...c.text.matchAll(/^##\s+(.+)$/gm)]
          .map((m) => m[1].replace(/\s*\(`[^`]*`\)/g, "").replace(/[`*]/g, "").trim())
          .filter((h) => !GENERIC_HEADINGS.has(h.toLowerCase()));
        if (heads.length) parts.push(`[${cutAt(heads.join(", "), d.headings)}]`);
      }
      return parts.join(": ");
    })
    .join("\n");
}

/** The chapters a model named in its first reply, as guide paths that
 * exist, at most MAX_CHOSEN; empty when the reply cannot be read, and
 * then the ranking chooses. Accepts {"chapters": [...]}, a bare list,
 * either inside a code fence, and paths written with a leading "./". */
export function parseChosen(reply: string, known: Set<string>): string[] {
  const text = reply.replace(/```(?:json)?/gi, "");
  const candidates: unknown[] = [];
  const obj = text.match(/\{[\s\S]*\}/);
  const arr = text.match(/\[[\s\S]*\]/);
  for (const m of [obj, arr]) {
    if (!m) continue;
    try {
      candidates.push(JSON.parse(m[0]));
    } catch {
      // not JSON; the next shape, or nothing
    }
  }
  for (const c of candidates) {
    const list = Array.isArray(c) ? c : c && typeof c === "object" ? (c as Record<string, unknown>).chapters : null;
    if (!Array.isArray(list)) continue;
    const out: string[] = [];
    for (const f of list) {
      if (typeof f !== "string") continue;
      const file = f.trim().replace(/^\.?\//, "");
      if (known.has(file) && !out.includes(file)) out.push(file);
    }
    if (out.length > 0) return out.slice(0, MAX_CHOSEN);
  }
  return [];
}
