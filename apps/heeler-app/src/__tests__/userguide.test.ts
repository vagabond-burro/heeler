// The shipped guide, checked as content rather than as code.
//
// The viewer builds its sidebar from the guide's own README links, so
// the guide is now a program of a kind: a README that links a page that
// does not exist is a dead entry in the contents, and a page no README
// links is a page a reader can only find by accident. Neither shows up
// in a component test against a mock, because the mock is correct by
// construction.
//
// So this runs the real builder over the real shipped guide, which is
// the only place those two faults can be caught before the owner finds
// them.

import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { buildDocTree, docLinks, flattenDocs, resolveDocPath } from "../docstree";
import { LEGAL_MENU_LABEL, OPEN_SOURCE_FILE, OPEN_SOURCE_MENU_PATH } from "../legaldocs";

const ROOT = resolve(process.cwd(), "../../docs/user-guide");

/** Every .md under the guide, as the Rust side lists them: relative
 * paths, forward slashes, title from the first heading. */
function collect(dir = ROOT, prefix = ""): { file: string; title: string }[] {
  const out: { file: string; title: string }[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      out.push(...collect(`${dir}/${entry.name}`, rel));
      continue;
    }
    if (!entry.name.endsWith(".md")) continue;
    const text = readFileSync(`${dir}/${entry.name}`, "utf8");
    const title = text.split(/\r?\n/).find((l) => l.startsWith("# "))?.slice(2).trim() ?? rel;
    out.push({ file: rel, title });
  }
  return out.sort((a, b) => a.file.localeCompare(b.file));
}

const DOCS = collect();
const textOf = async (file: string) => {
  try {
    return readFileSync(`${ROOT}/${file}`, "utf8");
  } catch {
    return null;
  }
};

describe("the guide as shipped", () => {
  it("is there, and is a tree rather than a folder of files", () => {
    expect(DOCS.length).toBeGreaterThan(40);
    expect(DOCS.map((d) => d.file)).toContain("README.md");
    // Three levels deep, which is what the sidebar has to carry.
    expect(DOCS.some((d) => d.file.split("/").length === 3)).toBe(true);
  });

  it("gives every page a heading to be named by", () => {
    // The title in the sidebar is the page's own first heading; without
    // one the reader gets a filename.
    const unnamed = DOCS.filter((d) => d.title === d.file);
    expect(unnamed).toEqual([]);
  });

  it("links nothing that is not there", async () => {
    // A README pointing at a page that does not exist is a dead line in
    // the contents, and the reader finds it before anyone else does.
    const known = new Set(DOCS.map((d) => d.file));
    const broken: string[] = [];
    for (const doc of DOCS) {
      const text = (await textOf(doc.file))!;
      for (const link of docLinks(doc.file, text)) {
        if (!known.has(link)) broken.push(`${doc.file} -> ${link}`);
      }
    }
    expect(broken).toEqual([]);
  });

  it("puts every page somewhere a reader can reach", async () => {
    const tree = await buildDocTree(DOCS, textOf);
    const placed = flattenDocs(tree).map((n) => n.file);
    expect(new Set(placed).size).toBe(DOCS.length);
    for (const doc of DOCS) expect(placed, doc.file).toContain(doc.file);
  });

  it("nests the chapters the guide says it has", async () => {
    const tree = await buildDocTree(DOCS, textOf);
    const top = tree.map((n) => n.file);
    // The README's own "Start here" order, which is the order the
    // sidebar draws and the order a new reader is meant to follow.
    expect(top[0]).toBe("README.md");
    expect(top).toContain("library.md");
    expect(top).toContain("export.md");
    expect(top).toContain("graph/README.md");
    expect(top).toContain("scripting/README.md");
    expect(top).toContain("adjustments/README.md");
    expect(top).toContain("finish/README.md");
    // Menus comes before Export, because the guide introduces the menu
    // bar before it gets to writing files.
    expect(top.indexOf("menus.md")).toBeLessThan(top.indexOf("export.md"));
  });

  it("carries the scripting reference as a branch of a branch", async () => {
    // The deepest thing in the guide, and the reason the column had to
    // grow a tree and a scrollbar at all.
    const tree = await buildDocTree(DOCS, textOf);
    const scripting = tree.find((n) => n.file === "scripting/README.md")!;
    const reference = scripting.children.find((n) => n.file === "scripting/reference/README.md")!;
    expect(reference).toBeDefined();
    expect(reference.children.length).toBeGreaterThan(4);
    expect(reference.children.map((n) => n.file)).toContain("scripting/reference/catalog.md");
  });

  it("lists the Adjustments pages alphabetically, the treatment among them", async () => {
    // The list used to follow the panel's order, source to geometry.
    // (2026-09-15): "make sure the sub pages under Adjustments tab is
    // ordered alphabetically". The panel keeps its workflow order; the
    // sidebar reads the README's list, so the README is what sorts.
    const tree = await buildDocTree(DOCS, textOf);
    const adjust = tree.find((n) => n.file === "adjustments/README.md")!;
    const titles = adjust.children.map((n) => n.title);
    expect(titles).toEqual([...titles].sort((a, b) => a.localeCompare(b, "en", { sensitivity: "base" })));
    expect(titles[0]).toBe("Black and White");
    expect(adjust.children.map((n) => n.file)).toContain("adjustments/black-and-white.md");
  });

  // LibRaw ships under CDDL-1.0, which obliges Heeler to carry the
  // notice and say where the source is. The About box tells people the
  // menu path to it in prose, and prose does not fail to compile.
  //
  // It has already broken once: the guide became a tree, only the tree
  // is bundled, and the notice was left behind in the old flat folder,
  // so the About box went on citing a page that no longer shipped. This
  // walks the path it prints, segment by segment, against the guide as
  // it actually ships.
  describe("the open source notices the About box points at", () => {
    it("ships, in the guide, under the menu path About prints", () => {
      const [help, folder, page] = OPEN_SOURCE_MENU_PATH.split(" > ");
      expect(help).toBe("Help");
      // The middle segment is the Help menu item that opens the folder.
      expect(folder).toBe(LEGAL_MENU_LABEL);
      // The last segment is the page's own first heading, which is what
      // the viewer's sidebar labels it with.
      const entry = DOCS.find((d) => d.file === OPEN_SOURCE_FILE);
      expect(entry, `${OPEN_SOURCE_FILE} must ship with the guide`).toBeDefined();
      expect(entry!.title).toBe(page);
    });

    it("is reachable from the guide's own contents, not only by search", async () => {
      const tree = await buildDocTree(DOCS, textOf);
      const legal = tree.find((n) => n.file === "legal/README.md");
      expect(legal, "the legal folder is linked from the guide root").toBeDefined();
      const files = legal!.children.map((n) => n.file);
      expect(files).toContain(OPEN_SOURCE_FILE);
      // The license text travels with the notice that cites it. The
      // obligation is to carry it, not to link to a download.
      expect(files).toContain("legal/cddl.md");
    });

    it("names the license and where the source is published", () => {
      // The Rust side asserts this against the version actually built
      // (heeler-raw, the_licence_page_names_the_libraw_that_is_actually_built).
      // Here it is only that the move did not lose the two facts the
      // obligation turns on.
      const text = readFileSync(`${ROOT}/${OPEN_SOURCE_FILE}`, "utf8");
      expect(text).toContain("CDDL");
      expect(text).toContain("https://www.heeler.app/source/libraw/");
    });
  });

  it("shows a real file behind every figure", async () => {
    // The screenshots are captured by scripts/docshots.mjs and the
    // markdown references them by hand, which is two things that can
    // disagree: a renamed capture, a typoed path, a figure written
    // before its capture ran. The viewer falls back to alt text when
    // the bytes cannot arrive, so a broken reference LOOKS like a
    // caption and nobody reports it.
    const broken: string[] = [];
    for (const doc of DOCS) {
      const text = (await textOf(doc.file))!;
      for (const m of text.matchAll(/!\[[^\]]*\]\(([^)\s]+)\)/g)) {
        const path = resolveDocPath(doc.file, m[1]);
        try {
          readFileSync(`${ROOT}/${path}`, "utf8");
        } catch {
          broken.push(`${doc.file} -> ${m[1]}`);
        }
      }
    }
    expect(broken).toEqual([]);
  });

  it("keeps the remaining screenshot placeholders to the pages that earned them", async () => {
    // 53 of the guide's 56 placeholders are real figures now. What is
    // left needs what a headless capture cannot stage: a second OS
    // window (the graph pop-out) and the Python console pop-out. This
    // list is the ratchet: a NEW placeholder appearing anywhere else
    // means a feature shipped without its figure.
    const holding: string[] = [];
    for (const doc of DOCS) {
      const text = (await textOf(doc.file))!;
      if (/^> \*\*Screenshot placeholder/m.test(text)) holding.push(doc.file);
    }
    expect(holding.sort()).toEqual(["graph/groups-popout.md", "scripting/README.md"]);
  });

  it("keeps every link relative to the page it is written in", async () => {
    // The one class of link that resolves differently depending on
    // where you stand: a sibling reference from inside a folder.
    const text = (await textOf("adjustments/README.md"))!;
    expect(docLinks("adjustments/README.md", text)).toContain("adjustments/source.md");
    expect(resolveDocPath("scripting/reference/catalog.md", "../../export.md")).toBe("export.md");
  });
});

 it("places recovery beside the library chapter that owns catalogs, and describes both backup scopes", () => {
   const readme = readFileSync(`${ROOT}/README.md`, "utf8");
   expect(readme.indexOf("(library.md)")).toBeLessThan(readme.indexOf("(recovery.md)"));
   expect(readme.indexOf("(recovery.md)")).toBeLessThan(readme.indexOf("(thumbnails.md)"));
   const guide = readFileSync(`${ROOT}/recovery.md`, "utf8");
   expect(guide.indexOf("## Catalog backup")).toBeLessThan(guide.indexOf("## Recovery bundle"));
   expect(guide.indexOf("## Recovery bundle")).toBeLessThan(guide.indexOf("## Verify recovery bundle"));
   for (const text of ["SHA-256", ".partial", "heeler-desktop recovery verify", "heeler-desktop recovery restore", "not copied into the bundle", "depth rasters", "matte rasters"]) expect(guide).toContain(text);
 });

it("documents tagged input, fallback and the unchanged output space", () => {
  const guide = readFileSync(`${ROOT}/export.md`, "utf8");
  for (const wording of ["Reading tagged photographs", "linear sRGB", "Display P3", "Adobe RGB", "ProPhoto", "LUT-based", "source filename", "Export profiles remain sRGB"]) expect(guide).toContain(wording);
});


it("links a present-tense accessibility checklist with platform-specific manual checks", () => {
  const page=readFileSync(`${ROOT}/accessibility.md`,"utf8");
  expect(readFileSync(`${ROOT}/README.md`,"utf8")).toContain("(accessibility.md)");
  for(const term of ["VoiceOver","Narrator","Exposure","Color Tune","Preferences","Segmented controls","Catalogs and recovery","Pop-out faces","Menus and context menus","Recovery notice and status"])
    expect(page).toContain(term);
  expect(page.match(/- \[ \]/g)?.length).toBeGreaterThanOrEqual(12);
});

// What's New is shipped content too, and its top section is the
// version the build shows: the workspace Cargo.toml's YY.UPDATE.PATCH,
// read the way display_version puts the century back and drops a zero
// patch. The 26.4.2 bump shipped with no 2026.4.2 section at all,
// which this now pins.
it("What's New has a section for the version the code carries", () => {
  const cargo = readFileSync(resolve(process.cwd(), "../../Cargo.toml"), "utf8");
  const v = cargo.match(/^\[workspace\.package\][\s\S]*?^version = "(\d+)\.(\d+)\.(\d+)"$/m);
  expect(v, "the workspace version in Cargo.toml").not.toBeNull();
  const display = `20${v![1]}.${v![2]}${v![3] === "0" ? "" : `.${v![3]}`}`;
  const whatsNew = readFileSync(resolve(process.cwd(), "../../docs/whats-new.md"), "utf8");
  expect(whatsNew).toContain(`## ${display}`);
});
