// The spelling rule, enforced. 2026-09-27: "let's avoid the british
// spelling of any word, for the sake of consistency." That covers
// everything people read: comments, string literals, test names and the
// docs, not only customer copy. What it cannot cover is a name code
// refers to (renaming identifiers, test ids and saved keys is a
// separate, riskier change), so the scan reads comments, strings and
// Markdown prose and leaves code positions alone. A compound identifier
// (colourMode, normalise_depth) is never a word here.
//
// If this fails, write the US form (color, gray, center, license,
// canceled, normalize, and so on). If the British form is a name the
// code or a saved file depends on, add it to KEPT with its reason.

import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const REPO = resolve(process.cwd(), "../..");

const OUR = /(colour|behaviour|neighbour|favour|honour|flavour|rumour|harbour|labour|humour|armour|vapour|odour|savour|endeavour|vigour|rigour)/;
const EXACT = new Set([
  "grey", "greys", "greyed", "greying", "greyness", "greyscale", "greyish",
  "centre", "centres", "centred", "centring", "centreline", "recentre", "recentred",
  "fibre", "fibres", "litre", "litres", "theatre", "calibre", "spectre", "lustre", "sombre",
  "licence", "licences",
  "catalogue", "catalogues", "catalogued", "cataloguing", "cataloguer",
  "analyse", "analysed", "analysing", "paralyse", "catalyse", "analogue",
  "artefact", "artefacts", "judgement", "judgements", "acknowledgement", "acknowledgements",
  "maths", "defence", "offence", "pretence", "programme", "programmes", "whilst", "amongst",
  "aluminium", "cheque", "anticlockwise",
  "labelled", "labelling", "relabelled", "levelled", "levelling", "modelled", "modelling", "modeller",
  "cancelled", "cancelling", "cancellable", "travelled", "travelling", "signalled", "signalling",
  "dialled", "dialling", "bevelled", "channelled", "fuelled", "totalled", "tunnelled", "stencilled",
  "portalled", "counselled", "marshalled", "equalled",
]);
const ISE =
  /^(un|re|de|ortho)*(normal|recogn|organ|initial|serial|optim|minim|maxim|real|summar|visual|final|util|priorit|custom|standard|categor|stabil|special|apolog|critic|harmon|capital|central|regular|discret|token|binar|rational|anonym|memo|polar|amort|legal|synchron|parameter|parametr|linear|local|neutral|general|equal|digit|random|raster|poster|quant|solar|vector|character|parallel|author|sanit|synthes|emphas|colour|favour|modern|symbol|global|motor|fertil|steril|vapor|miniatur|energ|item|jeopard|mobil|patron|penal|scrutin|subsid|summar|theor|trivial|victim|vandal)is(e|es|ed|ing|ation|ations|er|ers|able)$/;
const METRE = /metres?$/;

export function british(word: string): boolean {
  // A capital after the first letter is an identifier (colourMode),
  // not a word; ALL CAPS is a word written loud.
  if (word.slice(1) !== word.slice(1).toLowerCase() && word !== word.toUpperCase()) return false;
  const w = word.toLowerCase();
  return OUR.test(w) || EXACT.has(w) || ISE.test(w) || METRE.test(w);
}

type Region = [number, number];

/** Where people read words in a source file: comments and string
 * literals, found by a small lexer that knows each language's
 * comments, quotes, Rust raw strings and lifetimes, and JavaScript
 * regex literals. JSX text is caught separately, by shape. */
function readable(text: string, ext: string): Region[] {
  const out: Region[] = [];
  const n = text.length;
  const slash = [".rs", ".ts", ".tsx", ".js", ".mjs", ".css"].includes(ext);
  const hash = [".py", ".sh", ".toml"].includes(ext);
  const js = [".ts", ".tsx", ".js", ".mjs"].includes(ext);
  let i = 0;
  let lastSig = "";
  while (i < n) {
    const c = text[i];
    if (slash && text.startsWith("//", i)) {
      const j = text.indexOf("\n", i);
      const e = j < 0 ? n : j;
      out.push([i, e]);
      i = e;
      continue;
    }
    if (slash && text.startsWith("/*", i)) {
      let depth = 1;
      let j = i + 2;
      while (j < n && depth) {
        if (ext === ".rs" && text.startsWith("/*", j)) { depth++; j += 2; }
        else if (text.startsWith("*/", j)) { depth--; j += 2; }
        else j++;
      }
      out.push([i, j]);
      i = j;
      continue;
    }
    if (hash && c === "#") {
      const j = text.indexOf("\n", i);
      const e = j < 0 ? n : j;
      out.push([i, e]);
      i = e;
      continue;
    }
    if (ext === ".css") { i++; continue; }
    if (js && c === "/" && (lastSig === "" || "(,=:[!&|?{};+-*%<>~^".includes(lastSig) || /\b(return|typeof|case)\s*$/.test(text.slice(Math.max(0, i - 8), i)))) {
      // a regex literal: skip it whole, classes and escapes included
      let j = i + 1;
      let cls = false;
      while (j < n && text[j] !== "\n") {
        if (text[j] === "\\") { j += 2; continue; }
        if (text[j] === "[") cls = true;
        else if (text[j] === "]") cls = false;
        else if (text[j] === "/" && !cls) break;
        j++;
      }
      i = j + 1;
      lastSig = "/";
      continue;
    }
    if (ext === ".rs" && c === "r" && /^r#*"/.test(text.slice(i, i + 8)) && !/[\w]/.test(text[i - 1] ?? "")) {
      const hashes = /^r(#*)"/.exec(text.slice(i, i + 8))![1];
      const end = text.indexOf(`"${hashes}`, i + 2 + hashes.length);
      const e = end < 0 ? n : end + 1 + hashes.length;
      out.push([i, e]);
      i = e;
      lastSig = '"';
      continue;
    }
    if (ext === ".py" && (text.startsWith('"""', i) || text.startsWith("'''", i))) {
      const q = text.slice(i, i + 3);
      const end = text.indexOf(q, i + 3);
      const e = end < 0 ? n : end + 3;
      out.push([i, e]);
      i = e;
      lastSig = '"';
      continue;
    }
    const rustChar = ext === ".rs" && c === "'" && /^'(\\.[^']*|[^'\\])'/.test(text.slice(i, i + 12));
    if (c === '"' || c === "`" || (c === "'" && ext !== ".rs") || rustChar) {
      let j = i + 1;
      while (j < n) {
        if (text[j] === "\\") { j += 2; continue; }
        if (text[j] === c) break;
        if (text[j] === "\n" && c !== "`" && ext !== ".rs" && ext !== ".py") break;
        j++;
      }
      out.push([i, j + 1]);
      i = j + 1;
      lastSig = c;
      continue;
    }
    if (!/\s/.test(c)) lastSig = /[\w$]/.test(c) ? "a" : c;
    i++;
  }
  return out;
}

/** Markdown prose: everything but fenced blocks, code spans, link
 * targets, bare addresses and HTML tags. */
function prose(text: string): Region[] {
  const skip: Region[] = [];
  for (const m of text.matchAll(/^(```|~~~)[^\n]*\n[\s\S]*?^\1[^\n]*$/gm)) skip.push([m.index!, m.index! + m[0].length]);
  const inSkip = (p: number) => skip.some(([s, e]) => p >= s && p < e);
  for (const re of [/`[^`\n]+`/g, /\]\([^)\s]*\)|https?:\/\/\S+|<[a-z][^>\n]*>/g]) {
    for (const m of text.matchAll(re)) if (!inSkip(m.index!)) skip.push([m.index!, m.index! + m[0].length]);
  }
  skip.sort((a, b) => a[0] - b[0]);
  const out: Region[] = [];
  let pos = 0;
  for (const [s, e] of skip) {
    if (s < pos) continue;
    out.push([pos, s]);
    pos = e;
  }
  out.push([pos, text.length]);
  return out;
}

const WORD = /(?<![A-Za-z0-9_])[A-Za-z]+(?![A-Za-z0-9_])/g;
const KEYWORDS = new Set(["let", "const", "var", "mut", "fn", "function", "return", "if", "else", "struct", "enum", "type", "new", "await", "of", "in", "as", "typeof"]);

export function findBritish(text: string, ext: string): { word: string; line: number; at: number }[] {
  const found: { word: string; line: number; at: number }[] = [];
  const lineOf = (p: number) => text.slice(0, p).split("\n").length;
  const regions = ext === ".md" ? prose(text) : readable(text, ext);
  for (const [s, e] of regions) {
    const chunk = text.slice(s, e);
    for (const m of chunk.matchAll(WORD)) {
      const at = s + m.index!;
      if (!british(m[0])) continue;
      // A qualified name or a call named in a comment is code.
      if (/(::|\.)$/.test(text.slice(at - 2, at)) || text[at + m[0].length] === "(") continue;
      // A `code span` inside a comment is code too.
      if (ext !== ".md") {
        const lineStart = text.lastIndexOf("\n", at - 1) + 1;
        if ((text.slice(Math.max(lineStart, s), at).match(/`/g) ?? []).length % 2 === 1 && !text.slice(s, s + 1).match(/`/)) continue;
      }
      found.push({ word: m[0], line: lineOf(at), at });
    }
  }
  if (ext === ".tsx") {
    // JSX text sits in code position; it reads as a run of plain words.
    const inRegion = (p: number) => regions.some(([s, e]) => p >= s && p < e);
    for (const m of text.matchAll(WORD)) {
      const at = m.index!;
      if (!british(m[0]) || inRegion(at)) continue;
      const before = /([A-Za-z]+)\s+$/.exec(text.slice(Math.max(0, at - 40), at));
      const after = /^\s+([A-Za-z]+)/.exec(text.slice(at + m[0].length, at + m[0].length + 40));
      const next = text[at + m[0].length] ?? "";
      if (before && after && before[1] === before[1].toLowerCase() && after[1] === after[1].toLowerCase()
        && !KEYWORDS.has(before[1]) && !KEYWORDS.has(after[1]) && !"(:=.".includes(next)) {
        found.push({ word: m[0], line: lineOf(at), at });
      }
    }
  }
  return found;
}

/** Kept on purpose. Each entry names the file (relative to the repo),
 * a piece of the line the British form sits on, and why it stays. */
const KEPT: { file: string; line: string; why: string }[] = [
  { file: "apps/heeler-app/src/ui/charteditor.tsx", line: 'data-testid="charteditor-colour-', why: "data-testid values, which tests and tooling address by name" },
  { file: "apps/heeler-app/src/__tests__/charttool.test.tsx", line: '"charteditor-colour-', why: "the chart editor's data-testid values, asserted by name" },
  { file: "apps/heeler-app/src/__tests__/film.test.tsx", line: '"film-modelled-on"', why: "checks the retired element's old test id is gone, so it names it as it was" },
  { file: "apps/heeler-app/src/__tests__/releasecopy.test.ts", line: "for(const stale of [", why: "asserts the old British copy is gone from the source, so it quotes it" },
];

const SKIP_FILES: { file: RegExp; why: string }[] = [
  { file: /^docs\/reviews\//, why: "review records, historical, left as written" },
  { file: /^docs\/review-[^/]*\.md$/, why: "review records, historical, left as written" },
  { file: /^docs\/user-guide\/legal\/third-party-notices\.md$/, why: "generated; other people's license texts reproduced verbatim" },
  { file: /^apps\/heeler-app\/src\/__tests__\/spelling\.test\.ts$/, why: "this scanner names the British forms it hunts for" },
];

function walk(dir: string, exts: string[]): string[] {
  const out: string[] = [];
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const entry of entries) {
    if (["node_modules", "target", "gen", "dist"].includes(entry.name) || entry.name.startsWith(".")) continue;
    const full = `${dir}/${entry.name}`;
    if (entry.isDirectory()) out.push(...walk(full, exts));
    else if (exts.some((e) => entry.name.endsWith(e))) out.push(full);
  }
  return out;
}

function scopedFiles(): string[] {
  const code = [".ts", ".tsx", ".rs", ".py", ".sh", ".mjs", ".css", ".toml", ".md"];
  const files = [
    ...walk(`${REPO}/apps/heeler-app/src`, code),
    ...walk(`${REPO}/apps/heeler-app/src-tauri`, code),
    ...walk(`${REPO}/crates`, code),
    ...walk(`${REPO}/scripts`, code),
    ...walk(`${REPO}/docs`, [".md"]),
    ...readdirSync(REPO).filter((f) => f.endsWith(".md")).map((f) => `${REPO}/${f}`),
  ];
  return files.map((f) => f.slice(REPO.length + 1)).filter((f) => !SKIP_FILES.some((s) => s.file.test(f)));
}

describe("US spelling", () => {
  it("knows the British forms and leaves identifiers alone", () => {
    for (const w of ["colour", "Colours", "grey", "centred", "licence", "normalise", "recognised", "modelled", "cancelled", "behaviour", "neighbourhood", "nanometres", "GREY"]) {
      expect(british(w), w).toBe(true);
    }
    for (const w of ["color", "gray", "center", "license", "normalize", "canceled", "promise", "noise", "otherwise", "exercise", "colourMode", "advertise", "synthesis"]) {
      expect(british(w), w).toBe(false);
    }
  });

  it("reads comments, strings and JSX text, not code", () => {
    const ts = [
      "const colour = 1; // the colour here",
      'const s = "a grey card"; const re = /["`]/g; const t = `no centre`;',
      "<p>the neighbouring color comes</p>",
      "normalise(x); a.colour; // call normalise() and `colour` in a span",
    ].join("\n");
    expect(findBritish(ts, ".tsx").map((f) => f.word).sort()).toEqual(["centre", "colour", "grey", "neighbouring"]);
    const rs = "let colour = x; // colour\nfn f<'a>(g: &'a str) -> &'a str { \"centred\" }\n";
    expect(findBritish(rs, ".rs").map((f) => f.word).sort()).toEqual(["centred", "colour"]);
  });

  it("holds at zero across the code, the scripts and the docs", () => {
    const offenders: string[] = [];
    for (const file of scopedFiles()) {
      const text = readFileSync(`${REPO}/${file}`, "utf8");
      const ext = file.slice(file.lastIndexOf("."));
      const lines = text.split("\n");
      for (const f of findBritish(text, ext)) {
        const line = lines[f.line - 1];
        if (KEPT.some((k) => k.file === file && line.includes(k.line))) continue;
        offenders.push(`${file}:${f.line}: ${f.word}`);
      }
    }
    expect(offenders, offenders.join("\n")).toEqual([]);
  });
});
