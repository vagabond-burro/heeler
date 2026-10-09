// Where a node is, in every text the assistant shows or reads
// (2026-10-01: "I did some tests and in the text instructions where to
// find a node in the menu it did not include the full menu path (it
// used the old menu paths before add sub-categories)"). A node's place
// is category > section > node (nodes.ts nodeMenuPath), the same in the
// guide's node reference, the tour's add-node steps, the stops the tour
// model reads, the answer's rules, the selected nodes' facts, and any
// answer or step sentence a model writes. The Tauri invoke is mocked;
// nothing here reaches a server.

import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));

import {
  askGuide,
  MENU_PATH_ANSWER,
  resetAssistantConfigForTests,
  resetAssistantPhotoForTests,
  resetGuideForTests,
  selectedNodeText,
  systemPrompt,
} from "../assistant";
import { initialState } from "../data";
import { fixMenuPaths, menuPathMentions } from "../menupaths";
import { CATEGORY_LABEL, menuTree, NODE_CATALOG, nodeMenuPath, RETIRED_TYPES } from "../nodes";
import { checkTour, stopLine } from "../tour";
import { nodeSlug, STOP_BY_ID, TOUR_STOPS } from "../tourstops";

const SRC = resolve(process.cwd(), "src");
const GUIDE_DIR = resolve(process.cwd(), "../../docs/user-guide");

function guidePages(): { file: string; text: string }[] {
  const out: { file: string; text: string }[] = [];
  const walk = (dir: string, pre: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const rel = pre ? `${pre}/${e.name}` : e.name;
      if (e.isDirectory()) walk(`${dir}/${e.name}`, rel);
      else if (e.name.endsWith(".md") && !rel.startsWith("legal/")) out.push({ file: rel, text: readFileSync(`${dir}/${e.name}`, "utf8") });
    }
  };
  walk(GUIDE_DIR, "");
  return out;
}

const LIVE = NODE_CATALOG.filter((n) => !RETIRED_TYPES.has(n.type));
const CATEGORIES = ["Source", "Color", "Detail", "Masking", "Utility"];

/** Every menu path in a text that names a node and is not its full
 * path, and every node named by its category alone: "**File** node
 * (Source)", "**Chroma Key** in the Masking nodes", "**Measure** under
 * **Utility**", "Channel in the Utility menu". */
function slips(text: string): string[] {
  const out = menuPathMentions(text).filter((m) => !m.ok).map((m) => `${m.said} (want ${m.want})`);
  const prose = text.replace(/```[\s\S]*?```/g, "");
  const names = [...LIVE].sort((a, b) => b.name.length - a.name.length);
  const cats = CATEGORIES.join("|");
  for (const spec of names) {
    const name = spec.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const path = nodeMenuPath(spec.type)!;
    const forms = [
      new RegExp(`\\*\\*${name}\\*\\*(?: node)? \\((?:\\*\\*)?(?:${cats})(?:\\*\\*)?\\)`, "g"),
      new RegExp(`\\*\\*${name}\\*\\*(?: node)?,? (?:is )?(?:in|under) (?:the )?(?:\\*\\*)?(?:${cats})(?:\\*\\*)?(?: nodes| menu| category)?(?![\\w >])`, "g"),
      new RegExp(`\\b${name}(?: node)? (?:is )?(?:in|under) the (?:${cats}) (?:nodes|menu|category)\\b`, "g"),
    ];
    for (const re of forms) for (const m of prose.matchAll(re)) out.push(`${m[0]} (want ${path})`);
  }
  return out;
}

describe("nodeMenuPath", () => {
  it("is the path the menus draw, for every node they list", () => {
    let n = 0;
    for (const family of menuTree()) {
      for (const section of family.sections) {
        for (const spec of section.nodes) {
          if (RETIRED_TYPES.has(spec.type)) continue;
          expect(nodeMenuPath(spec.type)).toBe(`${family.label} > ${section.label} > ${spec.name}`);
          n++;
        }
      }
    }
    expect(n).toBe(LIVE.length);
    expect(nodeMenuPath("heeler.morphology")).toBe("Masking > Mask Tools > Morphology");
    expect(nodeMenuPath("heeler.channel_extract")).toBe("Utility > Channels > Channel");
    expect(nodeMenuPath("heeler.displacement_map")).toBe("Source > Geometry > Displacement Map");
    // Listed under a category other than its stripe's.
    expect(LIVE.find((s) => s.type === "heeler.transform")!.cat).toBe("utility");
    expect(nodeMenuPath("heeler.transform")).toBe("Source > Geometry > Transform");
    expect(nodeMenuPath("heeler.not_a_node")).toBeNull();
  });
});

describe("fixMenuPaths", () => {
  it("puts the full path in place of an old one, and the node's menu name in place of its type", () => {
    expect(fixMenuPaths("Choose Add > Utility > Channel Extract, then wire it.")).toBe("Choose Add > Utility > Channels > Channel, then wire it.");
    expect(fixMenuPaths("It is in Utility > Measure.")).toBe("It is in Utility > Math & Logic > Measure.");
    expect(fixMenuPaths("Node > Utility > Transform moves it.")).toBe("Node > Source > Geometry > Transform moves it.");
    expect(fixMenuPaths("Choose **Masking > Morphology**.")).toBe("Choose **Masking > Mask Tools > Morphology**.");
    expect(fixMenuPaths("Choose **Add** > **Masking** > **Morphology**.")).toBe("Choose **Add** > **Masking > Mask Tools > Morphology**.");
    expect(fixMenuPaths("Add > Detail > Detail")).toBe("Add > Detail > Sharpen & Detail > Detail");
  });

  it("leaves full paths, sections, wiring and code alone", () => {
    const same = [
      "Choose Node > Masking > Mask Tools > Morphology.",
      "Masking > Mask Tools > Morphology",
      "The Utility > Output section holds Output and Export Layer.",
      "Gamut Map sits in **Utility > Color Space**, Measure in **Utility > Math & Logic**.",
      "Choose Add > Utility > Color Space.",
      "Source > Blend Mode (Hard Light, 60%) > Output",
      "Source > Exposure > Curves > Output",
      "Help > About Heeler",
      "```\nUtility > Measure\n```",
    ];
    for (const t of same) expect(fixMenuPaths(t)).toBe(t);
  });
});

describe("the guide names every node by its full path", () => {
  const pages = guidePages();

  it("has no old or partial menu path naming a node, anywhere", () => {
    const found = pages.flatMap((p) => slips(p.text).map((s) => `${p.file}: ${s}`));
    expect(found).toEqual([]);
  });

  it("gives every node in the node reference a Menu line with its full path", () => {
    const ref = pages.filter((p) => p.file.startsWith("graph/nodes/") && p.file !== "graph/nodes/README.md");
    const seen = new Set<string>();
    for (const p of ref) {
      // An entry: a ### heading, or a bullet naming a type.
      const entries = p.text.split(/\n(?=### )/);
      for (const entry of entries) {
        const head = entry.split("\n")[0];
        const heads = [...head.matchAll(/`(heeler\.\w+)`/g)].map((m) => m[1]);
        if (heads.length > 0 || /\(a group\)$/.test(head)) {
          const types = heads.length > 0 ? heads : head.startsWith("### Sharpening") ? ["heeler.sharpening"] : ["heeler.skin_soften"];
          const menu = /^- \*\*Menu:\*\* (.+)\.$/m.exec(entry)?.[1];
          expect(menu, `${p.file}: ${head}`).toBe(types.map((t) => nodeMenuPath(t)).join("; "));
          types.forEach((t) => seen.add(t));
        }
        for (const line of entry.split("\n").filter((l) => l.startsWith("- **") && /`heeler\.\w+`/.test(l))) {
          const t = /`(heeler\.\w+)`/.exec(line)![1];
          expect(line, p.file).toContain(nodeMenuPath(t)!);
          seen.add(t);
        }
      }
    }
    expect(LIVE.filter((s) => !seen.has(s.type)).map((s) => s.type)).toEqual([]);
  });

  it("is in each chapter of the category the menus list it under", () => {
    for (const spec of LIVE) {
      const family = nodeMenuPath(spec.type)!.split(" > ")[0];
      const page = pages.find((p) => p.file === `graph/nodes/${family.toLowerCase()}.md`)!;
      expect(page.text, spec.type).toContain(`- **Menu:** `);
      expect(page.text.includes(nodeMenuPath(spec.type)!), spec.type).toBe(true);
    }
    expect(Object.values(CATEGORY_LABEL)).toEqual(expect.arrayContaining(CATEGORIES));
  });
});

describe("the assistant's own words name the full path", () => {
  const state = initialState();

  it("every add-node stop says where its node is, in what the model reads and under every step", () => {
    const adds = TOUR_STOPS.filter((s) => s.id.startsWith("graph.add.") && s.nodeType);
    expect(adds.length).toBe(LIVE.length - 2);
    for (const stop of adds) {
      const path = nodeMenuPath(stop.nodeType!)!;
      expect(stop.id).toBe(`graph.add.${nodeSlug(stop.nodeType!)}`);
      expect(stopLine(stop)).toContain(path);
      expect(stop.how?.(state)).toContain(`Node > ${path}`);
    }
  });

  it("a step sentence with an old path is shown with the full one", () => {
    const r = checkTour('{"steps": [{"stop": "graph.add.channel_extract", "say": "Choose Add > Utility > Channel Extract."}]}');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.steps[0].say).toBe("Choose Add > Utility > Channels > Channel.");
    expect(STOP_BY_ID.get("graph.add.channel_extract")!.how!(state)).toContain("Utility > Channels > Channel");
  });

  it("no tour stop, tour fixture or assistant fixture names a node by an old or partial path", () => {
    const texts: string[] = [];
    for (const s of TOUR_STOPS) {
      texts.push(s.name, s.about);
      if (s.how) texts.push(s.how(state));
      if (s.way) texts.push(s.way(state));
    }
    for (const f of ["tourquestions.json", "assistantquestions.json", "assistantworkspace.json"]) texts.push(readFileSync(`${SRC}/${f}`, "utf8"));
    const found = texts.flatMap(slips);
    expect(found).toEqual([]);
  });

  it("the answer's rules ask for the full path, and a selected node's facts give it", () => {
    expect(systemPrompt([{ file: "graph/nodes/masking.md", title: "Masking nodes", text: "x" }])).toContain(MENU_PATH_ANSWER);
    expect(MENU_PATH_ANSWER).toContain("Masking > Mask Tools > Morphology");
    expect(selectedNodeText({ kind: "Measure", type: "heeler.measure" })).toBe("Measure (heeler.measure, in the menus Utility > Math & Logic > Measure)");
  });
});

describe("an answer from the model", () => {
  beforeEach(() => {
    (window as any).__TAURI_INTERNALS__ = { invoke: (name: string, args?: Record<string, unknown>) => invoke(name, args) };
    resetAssistantConfigForTests();
    resetAssistantPhotoForTests();
    resetGuideForTests();
  });
  afterEach(() => {
    invoke.mockReset();
    delete (window as any).__TAURI_INTERNALS__;
    resetGuideForTests();
  });

  it("comes back with the full path where the model wrote an old one", async () => {
    const DOCS: Record<string, string> = { "graph/nodes/utility.md": "# Utility nodes\n\n### Channel (`heeler.channel_extract`)\n\n- **Menu:** Utility > Channels > Channel.\n" };
    let n = 0;
    invoke.mockImplementation(async (name: string, args?: Record<string, unknown>) => {
      if (name === "list_docs") return Object.keys(DOCS).map((file) => ({ file, title: DOCS[file].split("\n")[0].slice(2) }));
      if (name === "read_doc") return DOCS[String(args?.file)];
      if (name === "assistant_chat") return ++n === 1 ? '{"chapters": ["graph/nodes/utility.md"]}' : "1. Choose Add > Utility > Channel Extract.\nSources: graph/nodes/utility.md";
      if (name.startsWith("assistant_")) throw new Error(`unexpected command ${name}`);
      return null;
    });
    const r = await askGuide({
      address: "http://localhost:1234",
      model: "m",
      question: "Where is the channel extract node?",
      history: [],
      facts: { fileType: "JPG", mono: false, develop: [], finish: [] },
      contextTokens: null,
    });
    expect(r.reply).toContain("Choose Add > Utility > Channels > Channel.");
    expect(r.reply).not.toContain("Utility > Channel Extract");
  });
});

it.each([
  "Use `Utility > Measure` as the literal test input.",
  'You wrote "Utility > Measure"; here is the current location.',
  "You wrote 'Utility > Measure'; here is the current location.",
  "> Utility > Measure\n\nThat was the old label.",
  "~~~text\nUtility > Measure\n~~~",
  "````text\n```\nUtility > Measure\n```\n````",
  "    Utility > Measure",
])("preserves quoted words and code: %s", (text) => {
  expect(fixMenuPaths(text)).toBe(text);
  expect(fixMenuPaths(text + "\n\nChoose Utility > Measure.")).toBe(text + "\n\nChoose Utility > Math & Logic > Measure.");
});
