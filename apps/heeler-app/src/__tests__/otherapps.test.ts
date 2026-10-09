// No other app is named in what Heeler publishes (2026-10-06: "I just
// noticed you had referred to lightroom in the documentation. Remove
// that", then "Remove any other app's name"). The user guide ships inside
// the app and on the website, What's New opens in the app, and the
// release notes go out with every build, so a name there means an
// emergency rebuild. The Microsoft Store listing is public the same way,
// and the words a user reads in the app hold the same line.
//
// Format and color space names (OpenEXR, DNG, Adobe RGB) are standards,
// not apps, and are not on the list.

import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const NAME_LIST = [
  "Lightroom", "Capture ?One", "Photoshop", "Affinity", "DaVinci", "Resolve-style", "\\bResolve's",
  "\\bNuke\\b", "Blender", "\\bArnold\\b", "V-Ray", "\\bFinder\\b", "exiftool", "Adobe Bridge",
  "digiKam", "darktable", "RawTherapee", "\\bGIMP\\b", "Luminar", "Silver Efex", "DNG Converter",
  "Camera Raw", "\\bDxO\\b", "Topaz", "Adobe(?! RGB)",
];

const NAMES = new RegExp(NAME_LIST.join("|"), "i");

// The docs-wide scan leaves "Camera Raw" out of the case-insensitive list:
// "camera RAW" is ordinary prose there (a camera's RAW file), while the
// app's name is always capitalized and is caught by CAMERA_RAW below.
const NAMES_DOCS = new RegExp(NAME_LIST.filter((n) => n !== "Camera Raw").join("|"), "i");
const CAMERA_RAW = /\bCamera Raw\b/;

// Lines the 2026-10-06 scrub read and kept: data recorded from sample files
// (EXR attribute rows, XMP key rows, the DNG MIME type, a raw.pixls.us
// corpus folder name) and the evidence file names inside the 26.3.1
// review's measurements. A line matching one of these is a kept record, not
// a mention; any other line must not name an app at all.
const KEPT_DATA_LINES = [
  /^\|[^|]*\|\s*(OpenEXR:|XMP-)/, // a metadata key row recorded from a sample file
  /image\/x-adobe-dng/, // the DNG MIME type, recorded from files
  /^\| Adobe DNG Converter \|/, // a raw.pixls.us corpus folder name
  /`exiftool(-ids-all)?\.json`/, // evidence file names in the 26.3.1 review record
];

const REPO = resolve(process.cwd(), "../..");

function walk(dir: string, exts: string[]): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
    const full = `${dir}/${entry.name}`;
    if (entry.isDirectory()) out.push(...walk(full, exts));
    else if (exts.some((e) => entry.name.endsWith(e))) out.push(full);
  }
  return out;
}

describe("no other app is named", () => {
  it("in the user guide, What's New, the release notes or the Store listing", () => {
    const files = [
      ...walk(resolve(REPO, "docs/user-guide"), [".md"])
        // Other people's license texts, reproduced verbatim.
        .filter((f) => !f.endsWith("/legal/third-party-notices.md")),
      resolve(REPO, "NOTES.md"),
      resolve(REPO, "docs/whats-new.md"),
      resolve(REPO, "docs/store-listing.md"),
    ];
    const found: string[] = [];
    for (const file of files) {
      readFileSync(file, "utf8").split("\n").forEach((line, i) => {
        if (NAMES.test(line)) found.push(`${file.slice(REPO.length + 1)}:${i + 1}: ${line.trim().slice(0, 100)}`);
      });
    }
    expect(found, found.join("\n")).toEqual([]);
  });

  it("in any string the app shows", () => {
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
          said = node.text;
        } else if (ts.isJsxText(node)) {
          said = node.getText(src);
        }
        if (said !== null && NAMES.test(said)) {
          const { line } = src.getLineAndCharacterOfPosition(node.getStart(src));
          found.push(`${file}:${line + 1}: ${said.trim().slice(0, 80)}`);
        }
        ts.forEachChild(node, visit);
      };
      visit(src);
    }
    expect(found, found.join("\n")).toEqual([]);
  });

  it("in any Markdown or JSON document the repository keeps", () => {
    // The DPI review landed after the 2026-10-06 scrub and named the
    // reference metadata reader and the two reference layer editors in its
    // report and evidence files; nothing watched documents outside the
    // user guide, so the suite stayed green. Scan all of it.
    const files = walk(resolve(REPO, "docs"), [".md", ".json"])
      // Other people's license texts, reproduced verbatim.
      .filter((f) => !f.endsWith("/legal/third-party-notices.md"));
    const found: string[] = [];
    for (const file of files) {
      readFileSync(file, "utf8").split("\n").forEach((line, i) => {
        if (KEPT_DATA_LINES.some((r) => r.test(line))) return;
        if (NAMES_DOCS.test(line) || CAMERA_RAW.test(line)) {
          found.push(`${file.slice(REPO.length + 1)}:${i + 1}: ${line.trim().slice(0, 100)}`);
        }
      });
    }
    expect(found, found.join("\n")).toEqual([]);
  });
});
