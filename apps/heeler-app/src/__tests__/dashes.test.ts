// The dash rule, enforced. The owner writes without em- or en-dashes
// and ruled that the repo should too ("Yes enforce the no em-dash
// rule"). It started as a ratchet over the source trees' comments;
// once the last ones were rewritten, every tracked text file in the
// repository holds at zero, so a dash anywhere new fails the suite.
//
// This file spells the two characters only as escapes (\u2013, \u2014)
// so it passes its own scan.

import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const DASHES = /[\u2013\u2014]/g; // en-dash, em-dash
/** A dash however a shipped string spells it: the character, a JS
 * escape left in source, or an HTML entity in JSX text. */
const SHOWN_DASH = /[\u2013\u2014]|\\u201[34]|\\u\{201[34]\}|&[mn]dash;|&#821[12];|&#x201[34];/i;

/** The string literals of a Rust file with their line numbers, comments
 * skipped. Handles "..." with escapes, r"..." and r#"..."#, and char
 * literals well enough not to mistake '"' for a string's start. */
function rustStrings(src: string): { text: string; line: number }[] {
  const out: { text: string; line: number }[] = [];
  let i = 0;
  let line = 1;
  const n = src.length;
  while (i < n) {
    const c = src[i];
    if (c === "\n") { line++; i++; continue; }
    if (c === "/" && src[i + 1] === "/") {
      while (i < n && src[i] !== "\n") i++;
      continue;
    }
    if (c === "/" && src[i + 1] === "*") {
      let depth = 1;
      i += 2;
      while (i < n && depth > 0) {
        if (src[i] === "\n") line++;
        if (src[i] === "/" && src[i + 1] === "*") { depth++; i += 2; continue; }
        if (src[i] === "*" && src[i + 1] === "/") { depth--; i += 2; continue; }
        i++;
      }
      continue;
    }
    // Raw strings: r"..." or r#"..."# (any number of #), b-prefixed too.
    const raw = /^b?r(#*)"/.exec(src.slice(i, i + 12));
    if (raw && !/[A-Za-z0-9_]/.test(src[i - 1] ?? "")) {
      const close = `"${raw[1]}`;
      const start = i + raw[0].length;
      const end = src.indexOf(close, start);
      const stop = end < 0 ? n : end;
      out.push({ text: src.slice(start, stop), line });
      for (let k = i; k < stop; k++) if (src[k] === "\n") line++;
      i = stop + close.length;
      continue;
    }
    if (c === "\"") {
      const at = line;
      let j = i + 1;
      while (j < n && src[j] !== "\"") {
        if (src[j] === "\\") j++;
        else if (src[j] === "\n") line++;
        j++;
      }
      out.push({ text: src.slice(i + 1, j), line: at });
      i = j + 1;
      continue;
    }
    // A char literal ('x', '\'', '"'), not a lifetime ('a).
    if (c === "'") {
      const m = /^'(\\.[^']*|[^\\'])'/u.exec(src.slice(i, i + 12));
      if (m) { i += m[0].length; continue; }
    }
    i++;
  }
  return out;
}

function walk(dir: string, exts: string[]): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === "target" || entry.name.startsWith(".")) continue;
    const full = `${dir}/${entry.name}`;
    if (entry.isDirectory()) out.push(...walk(full, exts));
    else if (exts.some((e) => entry.name.endsWith(e))) out.push(full);
  }
  return out;
}

function offenders(root: string, exts: string[]): { file: string; count: number }[] {
  return walk(root, exts)
    .map((file) => ({ file, count: (readFileSync(file, "utf8").match(DASHES) ?? []).length }))
    .filter((f) => f.count > 0);
}

const REPO = resolve(process.cwd(), "../..");

/** The text file types the rule covers, by extension. Binary formats
 * (images, models, fonts) are not read. */
const TEXT = [
  ".ts", ".tsx", ".js", ".mjs", ".cjs", ".rs", ".py", ".sh", ".css", ".html", ".svg",
  ".toml", ".json", ".yml", ".yaml", ".md", ".txt", ".xml", ".lock",
];

/** Tracked paths that keep their dashes, each for a stated reason. The
 * rule is for the words Heeler writes; these are words it does not. A
 * path ending in "/" exempts a whole directory. */
const EXEMPT: { path: string; why: string }[] = [
  // Vendored code and data (LibRaw, the lensfun database), kept byte for
  // byte as upstream ships them so an update stays a plain replacement.
  { path: "third_party/", why: "vendored upstream sources" },
  // Other people's license texts, reproduced verbatim because the
  // licenses ask for exactly that.
  { path: "docs/user-guide/legal/third-party-notices.md", why: "verbatim license texts" },
];

/** Every tracked file, repo-relative. Falls back to walking the tree
 * (minus node_modules, target and dot directories) where git is absent,
 * such as an exported source archive. */
function trackedFiles(): string[] {
  try {
    return execFileSync("git", ["ls-files", "-z"], { cwd: REPO, encoding: "utf8", maxBuffer: 64 << 20 })
      .split("\0")
      .filter(Boolean);
  } catch {
    return walk(REPO, TEXT).map((f) => f.slice(REPO.length + 1));
  }
}

describe("no em-dashes or en-dashes", () => {
  it("every tracked text file in the repository holds at zero", () => {
    const found: string[] = [];
    for (const rel of trackedFiles()) {
      if (!TEXT.some((e) => rel.endsWith(e))) continue;
      if (EXEMPT.some((x) => (x.path.endsWith("/") ? rel.startsWith(x.path) : rel === x.path))) continue;
      let text: string;
      try {
        text = readFileSync(resolve(REPO, rel), "utf8");
      } catch {
        continue; // tracked but deleted in the working tree
      }
      text.split("\n").forEach((line, i) => {
        if (line.match(DASHES)) found.push(`${rel}:${i + 1}: ${line.trim().slice(0, 100)}`);
      });
    }
    expect(found, found.join("\n")).toEqual([]);
  });

  // The trees are also held on their own, without git, so the source
  // cannot slip even where the repository-wide scan falls back to a walk.
  it("the TypeScript tree holds at zero, comments included", () => {
    const found = offenders(resolve(process.cwd(), "src"), [".ts", ".tsx"]);
    expect(found, found.map((f) => `${f.file} (${f.count})`).join("\n")).toEqual([]);
  });

  it("the Rust tree holds at zero, comments included", () => {
    const found = [
      ...offenders(resolve(process.cwd(), "src-tauri/src"), [".rs"]),
      ...offenders(resolve(process.cwd(), "../../crates"), [".rs"]),
    ];
    expect(found, found.map((f) => `${f.file} (${f.count})`).join("\n")).toEqual([]);
  });

  // The ratchets that came before counted the character only, never a
  // JS escape or an HTML entity (&mdash;) that prints the same
  // dash, and a dash in a string the user reads could ride under the
  // ceiling as long as an old comment somewhere had shed one: the hint
  // "~ (em dash) hide nodes" on the Finish canvas sat there for months.
  // What the user reads holds at zero, however it is spelled.
  it("no string Heeler shows, in TypeScript, JSX or JSON, carries one", () => {
    const found: string[] = [];
    for (const file of walk(resolve(process.cwd(), "src"), [".ts", ".tsx"])) {
      if (file.includes("/__tests__/") || /\.test\.tsx?$/.test(file)) continue;
      const text = readFileSync(file, "utf8");
      const src = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
      const visit = (node: ts.Node) => {
        let said: string | null = null;
        if (
          ts.isStringLiteral(node) ||
          ts.isNoSubstitutionTemplateLiteral(node) ||
          ts.isTemplateHead(node) ||
          ts.isTemplateMiddle(node) ||
          ts.isTemplateTail(node)
        ) {
          // The cooked text decodes escapes; the source catches entities.
          said = `${node.text} ${node.getText(src)}`;
        } else if (ts.isJsxText(node)) {
          said = node.getText(src);
        }
        if (said !== null && SHOWN_DASH.test(said)) {
          const { line } = src.getLineAndCharacterOfPosition(node.getStart(src));
          found.push(`${file}:${line + 1}: ${node.getText(src).trim().slice(0, 80)}`);
        }
        ts.forEachChild(node, visit);
      };
      visit(src);
    }
    // JSON shipped with the app (method tables, assistant prompts,
    // registry defaults). tourquestions.json is the tour test's fixture
    // of model replies, and one reply carries a dash on purpose: the
    // tour has to turn a model's dash into a comma (tour.ts).
    for (const file of walk(resolve(process.cwd(), "src"), [".json"])) {
      if (file.includes("/__tests__/") || file.endsWith("/tourquestions.json")) continue;
      const strings: string[] = [];
      JSON.stringify(JSON.parse(readFileSync(file, "utf8")), (_k, v) => {
        if (typeof v === "string") strings.push(v);
        return v;
      });
      for (const s of strings) if (SHOWN_DASH.test(s)) found.push(`${file}: ${s.slice(0, 80)}`);
    }
    expect(found, found.join("\n")).toEqual([]);
  });

  it("no Rust string literal carries one", () => {
    // Messages from the engine reach the status line and the Console.
    // A small lexer: comments are skipped, ordinary and raw strings are
    // read, and \u{2014} counts as the dash it prints.
    const found: string[] = [];
    const files = [
      ...walk(resolve(process.cwd(), "src-tauri/src"), [".rs"]),
      ...walk(resolve(process.cwd(), "../../crates"), [".rs"]),
    ];
    for (const file of files) {
      for (const lit of rustStrings(readFileSync(file, "utf8"))) {
        if (SHOWN_DASH.test(lit.text) || /\\u\{201[34]\}/i.test(lit.text)) {
          found.push(`${file}:${lit.line}: ${lit.text.slice(0, 80)}`);
        }
      }
    }
    expect(found, found.join("\n")).toEqual([]);
  });
});
