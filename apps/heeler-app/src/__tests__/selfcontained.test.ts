// Comments explain their reasons where the code lives. References to
// private history and personal attributions cannot survive an archive.

import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const REPO = resolve(process.cwd(), "../..");
const TEXT = /(?:\.(?:tsx?|[cm]?js|rs|cpp|py|sh|zsh|css|html|svg|toml|json|ya?ml|md|txt|xml|ps1|CDDL|dtd|pub)$|(?:^|\/)(?:LICENSE|\.gitignore|\.gitattributes)$)/;
const CHECKS = {
  docs: /\bdocs\//,
  hash: /(?:\b[A-Za-z][A-Za-z-]*[,:]?\s+|\(|^\s*(?:\/\/[\/!]?|\*)\s+)[`']?([a-f\d]{7,10})\b/gi,
  issue: /\bissues?\s+#?\d+\b|\bissues\/\d+\b|\b[\w.-]+\/[\w.-]+#\d+\b|(?<!\w)#\d+\b/i,
  history: /in git history/i,
  name: /\bE[d]\b(?!\d)|Casper[s]en/,
  review: /\bthe (?:review agent|reviewer|primary assistant|agent)\b/i,
};
type Check = keyof typeof CHECKS;
type Hit = { file: string; line: number; pattern: Check; text: string };

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if ((e.isDirectory() && e.name.startsWith(".")) || e.name === "node_modules" || e.name === "target") continue;
    const full = `${dir}/${e.name}`;
    if (e.isDirectory()) out.push(...walk(full));
    else if (e.isFile() && TEXT.test(e.name)) out.push(full.slice(REPO.length + 1));
  }
  return out;
}

function trackedFiles(): string[] {
  try {
    return execFileSync("git", ["ls-files", "-z"], { cwd: REPO, encoding: "utf8", maxBuffer: 64 << 20 }).split("\0").filter(Boolean);
  } catch {
    return walk(REPO);
  }
}

function excluded(file: string): boolean {
  return file.startsWith("third_party/")
    || file === "docs\/user-guide/legal/third-party-notices.md"
    || /\.lock$/.test(file)
    || (/\.json$/.test(file) && (/fixtures?\/|__tests__\//.test(file)
      || /\/(?:assistantworkspace|tourquestions)\.json$/.test(file)));
}

/** Comment and docstring lines, with test descriptions included. String
 * contents are skipped so a URL or a color value cannot be a comment. */
function commentText(file: string, text: string): Map<number, string> {
  const lines = new Map<number, string>();
  const starts = [0, ...Array.from(text.matchAll(/\n/g), (m) => m.index! + 1)];
  const at = (offset: number) => {
    let lo = 0, hi = starts.length;
    while (lo + 1 < hi) {
      const mid = (lo + hi) >>> 1;
      if (starts[mid] <= offset) lo = mid;
      else hi = mid;
    }
    return lo + 1;
  };
  const add = (start: number, end: number) => {
    text.slice(start, end).split("\n").forEach((piece, i) => {
      if (piece) lines.set(at(start) + i, `${lines.get(at(start) + i) ?? ""} ${piece}`);
    });
  };
  if (/\.(?:tsx?|[cm]?js)$/.test(file)) {
    const src = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
    const ranges = new Map<number, number>();
    const visit = (node: ts.Node) => {
      for (const r of [...(ts.getLeadingCommentRanges(text, node.pos) ?? []), ...(ts.getTrailingCommentRanges(text, node.end) ?? [])]) ranges.set(r.pos, r.end);
      if (ts.isCallExpression(node) && /^(?:it|test|describe)(?:\.|$)/.test(node.expression.getText(src))) {
        const arg = node.arguments[0];
        if (arg && (ts.isStringLiteral(arg) || ts.isNoSubstitutionTemplateLiteral(arg))) ranges.set(arg.getStart(src), arg.end);
      }
      for (const child of node.getChildren(src)) visit(child);
    };
    visit(src);
    for (const [start, end] of ranges) add(start, end);
  } else if (/\.(?:rs|cpp|css)$/.test(file)) {
    let i = 0;
    while (i < text.length) {
      if (text.startsWith("//", i)) {
        const end = text.indexOf("\n", i);
        const stop = end < 0 ? text.length : end;
        add(i, stop); i = stop; continue;
      }
      if (text.startsWith("/*", i)) {
        const start = i;
        let depth = 1; i += 2;
        while (i < text.length && depth) {
          if (text.startsWith("/*", i)) { depth++; i += 2; }
          else if (text.startsWith("*/", i)) { depth--; i += 2; }
          else i++;
        }
        add(start, i); continue;
      }
      const raw = /^b?r(\#*)"/.exec(text.slice(i, i + 32));
      if (raw && !/[A-Za-z0-9_]/.test(text[i - 1] ?? "")) {
        const close = '"' + raw[1];
        const end = text.indexOf(close, i + raw[0].length);
        i = end < 0 ? text.length : end + close.length; continue;
      }
      if (text[i] === '"') {
        i++;
        while (i < text.length && text[i] !== '"') i += text[i] === "\\" ? 2 : 1;
        i++; continue;
      }
      const char = /^'(\\.[^']*|[^\\'])'/.exec(text.slice(i, i + 20));
      if (char) { i += char[0].length; continue; }
      i++;
    }
  } else if (file.endsWith(".py")) {
    const tokens = /"""[\s\S]*?"""|'''[\s\S]*?'''|"(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*'|#[^\n]*/g;
    for (const m of text.matchAll(tokens)) {
      const prefix = text.slice(text.lastIndexOf("\n", m.index!) + 1, m.index!);
      if (m[0].startsWith("#") || (/^\s*[rRuU]*$/.test(prefix) && (m[0].startsWith('"""') || m[0].startsWith("'''")))) add(m.index!, m.index! + m[0].length);
    }
  } else if (/\.(?:html|xml|svg)$/.test(file)) {
    for (const m of text.matchAll(/<!--[\s\S]*?-->/g)) add(m.index!, m.index! + m[0].length);
  } else if (/\.(?:sh|zsh|ps1|toml|ya?ml)$/.test(file) || file === ".gitignore" || file === ".gitattributes") {
    const tokens = /"""[\s\S]*?"""|'''[\s\S]*?'''|"(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*'|(?<!\S)#[^\n]*/g;
    for (const m of text.matchAll(tokens)) if (m[0].startsWith("#")) add(m.index!, m.index! + m[0].length);
  }
  return lines;
}

// Exact runtime uses are kept because they load, publish or verify a
// document. Each exemption is confined to that operation's source line.
const RUNTIME: { file: string; text: string; why: string }[] = [
  {"file": "apps/heeler-app/scripts/docshots.mjs", "text": "const OUT = process.env.DOCS_OUT ?? new URL(\"../../../docs\/user-guide/assets/screenshots\", import.meta.url).pathname;", "why": "writes guide screenshots"},
  {"file": "apps/heeler-app/scripts/readmeshots.mjs", "text": "const OUT = process.env.README_OUT ?? new URL(\"../../../docs\/readme\", import.meta.url).pathname;", "why": "writes the README's figures"},
  {"file": "apps/heeler-app/src-tauri/src/recipe_files/tests.rs", "text": "    let guide = include_str!(\"../../../../../docs\/user-guide/graph/recipes.md\");", "why": "reads or verifies the shipped guide"},
  {"file": "apps/heeler-app/src-tauri/tauri.conf.json", "text": "      \"../../../docs\/user-guide\": \"docs\/user-guide\",", "why": "bundles the shipped guide"},
  {"file": "apps/heeler-app/src-tauri/tests/third_party_notices.rs", "text": "    let page = std::fs::read_to_string(repo_root().join(\"docs\/user-guide/legal/third-party-notices.md\"))", "why": "reads or verifies the shipped guide"},
  {"file": "apps/heeler-app/src-tauri/tests/third_party_notices.rs", "text": "        .expect(\"docs\/user-guide/legal/third-party-notices.md exists; run scripts/third_party_notices.py\");", "why": "reads or verifies the shipped guide"},
  {"file": "apps/heeler-app/src-tauri/tests/third_party_notices.rs", "text": "    let page = std::fs::read_to_string(repo_root().join(\"docs\/user-guide/legal/third-party-notices.md\")).expect(\"the page\");", "why": "reads or verifies the shipped guide"},
  {"file": "apps/heeler-app/src/__tests__/agreement.test.tsx", "text": "const GUIDE = resolve(process.cwd(), \"../../docs\/user-guide\");", "why": "reads or verifies the shipped guide"},
  {"file": "apps/heeler-app/src/__tests__/app.test.tsx", "text": "    expect(body.querySelector(\"code\")?.textContent).toBe(\"docs\/user-guide\");", "why": "reads or verifies the shipped guide"},
  {"file": "apps/heeler-app/src/__tests__/assistantguide.test.tsx", "text": "const GUIDE_DIR = resolve(process.cwd(), \"../../docs\/user-guide\");", "why": "reads or verifies the shipped guide"},
  {"file": "apps/heeler-app/src/__tests__/assistantroute.live.test.ts", "text": "  const GUIDE_DIR = resolve(process.cwd(), \"../../docs\/user-guide\");", "why": "reads or verifies the shipped guide"},
  {"file": "apps/heeler-app/src/__tests__/assistantwhere.test.tsx", "text": "const GUIDE_DIR = resolve(process.cwd(), \"../../docs\/user-guide\");", "why": "reads or verifies the shipped guide"},
  {"file": "apps/heeler-app/src/__tests__/dashes.test.ts", "text": "  { path: \"docs\/user-guide/legal/third-party-notices.md\", why: \"verbatim license texts\" },", "why": "reads or verifies the shipped guide"},
  {"file": "apps/heeler-app/src/__tests__/duplicatekey.test.tsx", "text": "    const root = resolve(process.cwd(), \"../../docs\/user-guide\");", "why": "reads or verifies the shipped guide"},
  {"file": "apps/heeler-app/src/__tests__/finishcopyreview.test.ts", "text": "import news from \"../../../../docs\/whats-new.md?raw\";", "why": "reads, links or verifies the shipped release notes"},
  {"file": "apps/heeler-app/src/__tests__/finishcopyreview.test.ts", "text": "import imageGuide from \"../../../../docs\/user-guide/finish/image-layer.md?raw\";", "why": "reads or verifies the shipped guide"},
  {"file": "apps/heeler-app/src/__tests__/finishcopyreview.test.ts", "text": "import warpGuide from \"../../../../docs\/user-guide/finish/warp-layer.md?raw\";", "why": "reads or verifies the shipped guide"},
  {"file": "apps/heeler-app/src/__tests__/graphreviewcopy.test.ts", "text": "const guide = (name: string) => readFileSync(`../../docs\/user-guide/graph/nodes/${name}.md`, \"utf8\");", "why": "reads or verifies the shipped guide"},
  {"file": "apps/heeler-app/src/__tests__/graphreviewcopy.test.ts", "text": "  const notes = readFileSync(\"../../docs\/whats-new.md\", \"utf8\");", "why": "reads, links or verifies the shipped release notes"},
  {"file": "apps/heeler-app/src/__tests__/maskcopy.test.ts", "text": "import news from \"../../../../docs\/whats-new.md?raw\";", "why": "reads, links or verifies the shipped release notes"},
  {"file": "apps/heeler-app/src/__tests__/maskcopy.test.ts", "text": "import guide from \"../../../../docs\/user-guide/finish/masks-selections.md?raw\";", "why": "reads or verifies the shipped guide"},
  {"file": "apps/heeler-app/src/__tests__/menupaths.test.ts", "text": "const GUIDE_DIR = resolve(process.cwd(), \"../../docs\/user-guide\");", "why": "reads or verifies the shipped guide"},
  {"file": "apps/heeler-app/src/__tests__/nodemenugroups.test.tsx", "text": "  const GUIDE = resolve(process.cwd(), \"../../docs\/user-guide/graph/nodes\");", "why": "reads or verifies the shipped guide"},
  {"file": "apps/heeler-app/src/__tests__/otherapps.test.ts", "text": "      ...walk(resolve(REPO, \"docs\/user-guide\"), [\".md\"])", "why": "reads or verifies the shipped guide"},
  {"file": "apps/heeler-app/src/__tests__/otherapps.test.ts", "text": "      resolve(REPO, \"docs\/whats-new.md\"),", "why": "reads, links or verifies the shipped release notes"},
  {"file": "apps/heeler-app/src/__tests__/otherapps.test.ts", "text": "      resolve(REPO, \"docs\/store-listing.md\"),", "why": "verifies publication copy"},
  {"file": "apps/heeler-app/src/__tests__/releasecopy.test.ts", "text": " const notes=readFileSync(resolve(root,\"docs\/whats-new.md\"),\"utf8\").split(\"## 2026.3.1\")[1].split(\"\\n## \")[0];", "why": "reads, links or verifies the shipped release notes"},
  {"file": "apps/heeler-app/src/__tests__/tour.live.test.ts", "text": "  const GUIDE_DIR = resolve(process.cwd(), \"../../docs\/user-guide\");", "why": "reads or verifies the shipped guide"},
  {"file": "apps/heeler-app/src/__tests__/tour.test.tsx", "text": "const GUIDE_DIR = resolve(process.cwd(), \"../../docs\/user-guide\");", "why": "reads or verifies the shipped guide"},
  {"file": "apps/heeler-app/src/__tests__/tourstops.test.tsx", "text": "const GUIDE = resolve(process.cwd(), \"../../docs\/user-guide\");", "why": "reads or verifies the shipped guide"},
  {"file": "apps/heeler-app/src/__tests__/tourstops.test.tsx", "text": "  const spec = readFileSync(resolve(process.cwd(), \"../../docs\/spec-agentic.md\"), \"utf8\");", "why": "tests the tour contract against the actual specification"},
  {"file": "apps/heeler-app/src/__tests__/userguide.test.ts", "text": "const ROOT = resolve(process.cwd(), \"../../docs\/user-guide\");", "why": "reads or verifies the shipped guide"},
  {"file": "apps/heeler-app/src/__tests__/userguide.test.ts", "text": "  const whatsNew = readFileSync(resolve(process.cwd(), \"../../docs\/whats-new.md\"), \"utf8\");", "why": "reads, links or verifies the shipped release notes"},
  {"file": "apps/heeler-app/src/bridge.ts", "text": "    \"The real guide ships with the installed app and renders here from its `docs\/user-guide` folder.\",", "why": "preview message identifies the rendered guide folder"},
  {"file": "crates/heeler-raw/src/lib.rs", "text": "            .join(\"../../docs\/user-guide/legal/open-source.md\");", "why": "reads or verifies the shipped guide"},
  {"file": "crates/heeler-raw/src/lib.rs", "text": "            std::path::Path::new(env!(\"CARGO_MANIFEST_DIR\")).join(\"../../docs\/user-guide/legal/cddl.md\"),", "why": "reads or verifies the shipped guide"},
  {"file": "scripts/check_user_guide_links.py", "text": "GUIDE = ROOT / 'docs\/user-guide'", "why": "reads or verifies the shipped guide"},
  {"file": "scripts/check_user_guide_links.py", "text": "    for page in [*pages, ROOT / 'docs\/whats-new.md']:", "why": "reads, links or verifies the shipped release notes"},
  {"file": "scripts/libraw_source.py", "text": "    print(\"Publish both files at the URL named in docs\/user-guide/legal/open-source.md,\")", "why": "prints the source publication destination required by the guide"},
  {"file": "scripts/linux-setup.sh", "text": "    no Linux equivalent wired up. See docs\/user-guide/legal/open-source.md.", "why": "prints the bundled license information location"},
  {"file": "scripts/release.py", "text": "    \"([how to use them](https://www.heeler.app/docs\/ask-an-ai/))\"", "why": "publishes a guide help link"},
];


function hits(file: string, text: string): Hit[] {
  if (excluded(file) || !TEXT.test(file)) return [];
  const comments = file.endsWith(".md") ? new Map<number, string>() : commentText(file, text);
  const out: Hit[] = [];
  text.split("\n").forEach((line, i) => {
    for (const pattern of Object.keys(CHECKS) as Check[]) {
      if (pattern !== "name" && (file.endsWith(".md") || (pattern !== "docs" && !comments.has(i + 1)))) continue;
      if (pattern === "docs" && RUNTIME.some((r) => r.file === file && r.text === line)) continue;
      // This quote numbers a requested capability, not an external issue.
      const prose = pattern === "name" || pattern === "docs" ? line : comments.get(i + 1) ?? "";
      const said = pattern === "issue" && file === "apps/heeler-app/src-tauri/src/recovery.rs"
        ? prose.replace(/#4 (?=Recovery should be testable on your end")/, "") : prose;
      const check = CHECKS[pattern];
      check.lastIndex = 0;
      const match = pattern === "hash"
        ? [...said.matchAll(CHECKS.hash)].some((m) => /[a-f]/i.test(m[1]) && /\d/.test(m[1]))
        : check.test(said);
      if (match) out.push({ file, line: i + 1, pattern, text: line.trim() });
    }
  });
  return out;
}

const FOUND = trackedFiles().flatMap((file) => {
  if (excluded(file) || !TEXT.test(file)) return [];
  try { return hits(file, readFileSync(resolve(REPO, file), "utf8")); }
  catch { return []; } // tracked but deleted in the working tree
});

describe("source comments stand on their own", () => {
  for (const pattern of Object.keys(CHECKS) as Check[]) {
    it(`${pattern} references are absent`, () => {
      const found = FOUND.filter((h) => h.pattern === pattern);
      expect(found, found.map((h) => `${h.file}:${h.line}: ${h.text}`).join("\n")).toEqual([]);
    });
  }
});
