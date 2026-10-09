// The assistant's reading of the guide (src/assistantguide.ts), the
// photograph's facts (src/assistantphoto.ts) and the answer's display
// (src/ui/assistantmarkdown.tsx). The question set runs over the real
// bundled guide; nothing here reaches a server.

import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { buildMessages, citations, MONO_ANSWER, MONO_ROUTE, photoFactsText, plainChapter, routePrompt, systemPrompt, type Chapter } from "../assistant";
import {
  budgetFor,
  gatherMaterial,
  GUIDE_BUDGET,
  GUIDE_BUDGET_MAX,
  indexGuide,
  parseChosen,
  splitSections,
  stem,
  summaryLine,
  tableOfContents
} from "../assistantguide";
import { photoFactsOf} from "../assistantphoto";
import set from "../assistantquestions.json";
import { initialState } from "../data";
import { type NodeCard } from "../state";
import { AssistantMarkdown } from "../ui/assistantmarkdown";

afterEach(cleanup);

const GUIDE_DIR = resolve(process.cwd(), "../../docs/user-guide");

/** The guide as loadGuide reads it: every page but the two license
 * texts, titled by its first heading, screenshots left out. */
function realGuide(): Chapter[] {
  const out: Chapter[] = [];
  const walk = (dir: string, pre: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const rel = pre ? `${pre}/${e.name}` : e.name;
      if (e.isDirectory()) walk(`${dir}/${e.name}`, rel);
      else if (e.name.endsWith(".md") && rel !== "legal/third-party-notices.md" && rel !== "legal/cddl.md") {
        const raw = readFileSync(`${dir}/${e.name}`, "utf8");
        const title = raw.split("\n").find((l) => l.startsWith("# "))?.slice(2).trim() ?? rel;
        out.push({ file: rel, title, text: plainChapter(raw) });
      }
    }
  };
  walk(GUIDE_DIR, "");
  return out.sort((a, b) => a.file.localeCompare(b.file));
}

type Expect = string | string[];
const satisfied = (expect: Expect[], files: string[]) =>
  expect.every((x) => (Array.isArray(x) ? x : [x]).some((f) => files.includes(f)));

describe("the question set, over the real guide", () => {
  const guide = realGuide();
  const index = indexGuide(guide);
  const known = new Set(guide.map((c) => c.file));

  it("names only chapters that exist", () => {
    for (const q of set.questions) {
      for (const f of (q.expect as Expect[]).flat()) expect(known.has(f), `${q.q}: ${f}`).toBe(true);
    }
    expect(set.questions.length).toBeGreaterThanOrEqual(20);
  });

  it("lands every expected chapter in the material the local ranking alone sends", () => {
    const misses: string[] = [];
    for (const q of set.questions) {
      const m = gatherMaterial(q.q, index);
      const files = m.chapters.map((c) => c.file);
      if (!satisfied(q.expect as Expect[], files)) misses.push(`${q.q} -> ${files.join(", ")}`);
      expect(m.chapters.reduce((n, c) => n + c.text.length, 0)).toBeLessThanOrEqual(GUIDE_BUDGET + 200);
    }
    expect(misses).toEqual([]);
  });

  it("answers the sky about a color photograph from Sky Rescue, not Black and White", () => {
    const m = gatherMaterial("How can I darken the sky to balance the photo?", index);
    const files = m.chapters.map((c) => c.file);
    expect(files).toContain("adjustments/sky-rescue.md");
    // The long chapter that says "sky" most is no longer first, and
    // cannot take the budget: other chapters still come.
    expect(files[0]).not.toBe("adjustments/black-and-white.md");
    expect(files.length).toBeGreaterThanOrEqual(3);
  });

  it("puts the chapters the model chose first, each with its opening, and fills with the best sections elsewhere", () => {
    const m = gatherMaterial("How can I darken the sky?", index, ["adjustments/black-and-white.md", "made-up.md"]);
    expect(m.chosen).toEqual(["adjustments/black-and-white.md"]);
    expect(m.chapters[0].file).toBe("adjustments/black-and-white.md");
    expect(m.chapters[0].text.startsWith("# Black and White")).toBe(true);
    // Chosen, it gets half the budget, not all of it.
    expect(m.chapters[0].text.length).toBeLessThanOrEqual(GUIDE_BUDGET / 2 + 100);
    expect(m.chapters.map((c) => c.file)).toContain("adjustments/sky-rescue.md");
  });

  it("keeps the table of contents lean enough for a 4,096 token context", () => {
    const lean = tableOfContents(guide);
    const full = tableOfContents(guide, "full");
    // Measured 2026-09-28: lean 6,854 characters (about 1,700 tokens),
    // full 13,473 (about 3,400, sent only when the server reports a
    // larger context). The margins are for the guide growing.
    expect(lean.length).toBeLessThan(8000);
    expect(full.length).toBeLessThan(15000);
    const lines = lean.split("\n");
    expect(lines.length).toBe(guide.length);
    for (const c of guide) expect(lines.some((l) => l.startsWith(`${c.file}`))).toBe(true);
    expect(lean).not.toContain("third-party-notices");
    expect(lean).toContain("adjustments/sky-rescue.md: identifies bright sky-like tones");
    // Full mode keeps going past the first sentence, where a chapter
    // names its tools.
    expect(full).toMatch(/finish\/pixel-layer\.md: .*Clone, Heal/);
  });
});

describe("the retrieval's parts", () => {
  it("stems so that a question meets the guide's words", () => {
    expect(stem("darken")).toBe(stem("dark"));
    expect(stem("selection")).toBe(stem("select"));
    expect(stem("layers")).toBe(stem("layer"));
    expect(stem("sharpening")).toBe(stem("sharpen"));
  });

  it("cuts a chapter at its headings, never inside a code block", () => {
    const secs = splitSections({
      file: "x.md",
      title: "X",
      text: "# X\n\nOpening.\n\n## One\n\nBody one.\n\n```\n# not a heading\n```\n\n### Two\n\nBody two.",
    });
    expect(secs.map((s) => s.heading)).toEqual(["", "One", "Two"]);
    expect(secs[0].text).toBe("# X\n\nOpening.");
    expect(secs[1].text).toContain("# not a heading");
  });

  it("reads the model's chosen chapters, and only real ones", () => {
    const known = new Set(["export.md", "adjustments/sky-rescue.md", "a.md", "b.md", "c.md"]);
    expect(parseChosen('{"chapters": ["adjustments/sky-rescue.md", "export.md"]}', known)).toEqual(["adjustments/sky-rescue.md", "export.md"]);
    expect(parseChosen('```json\n["./export.md", "nope.md"]\n```', known)).toEqual(["export.md"]);
    expect(parseChosen('Here you go: {"chapters": ["a.md", "b.md", "c.md", "export.md"]}', known)).toEqual(["a.md", "b.md", "c.md"]);
    expect(parseChosen("I would read Sky Rescue.", known)).toEqual([]);
    expect(parseChosen('{"chapters": ["nope.md"]}', known)).toEqual([]);
    expect(parseChosen('{"chapters": [', known)).toEqual([]);
  });

  it("grows the budget only when the server reports a larger context", () => {
    expect(budgetFor(null)).toBe(GUIDE_BUDGET);
    expect(budgetFor(4096)).toBe(GUIDE_BUDGET);
    expect(budgetFor(8192)).toBeGreaterThan(GUIDE_BUDGET);
    expect(budgetFor(8192)).toBeLessThan(8192 * 3);
    expect(budgetFor(262144)).toBe(GUIDE_BUDGET_MAX);
  });

  it("writes a chapter's line without the title it starts with", () => {
    expect(summaryLine("# Sky Rescue\n\nSky Rescue identifies bright sky-like tones. More.", "Sky Rescue")).toBe("identifies bright sky-like tones");
    expect(summaryLine("# Legal\n\nEffective date: today.", "Legal")).toBe("");
  });
});

describe("what the model is told", () => {
  it("says what it knows of the photograph, and nothing more", () => {
    const text = photoFactsText({ fileType: "RW2", mono: false, develop: ["Exposure", "Sky Rescue"], finish: [] });
    expect(text).toContain("File type: RW2");
    expect(text).toContain("Color: in color");
    expect(text.toLowerCase()).not.toContain("black and white");
    expect(text).toContain("Develop sections on: Exposure, Sky Rescue");
    expect(text).toContain("Finish layers on: none");
    expect(photoFactsText(null)).toContain("No photograph is open.");
    expect(photoFactsText({ fileType: "JPG", mono: true, develop: [], finish: ["x".repeat(80)] })).toContain(`${"x".repeat(40)}...`);
  });

  it("asks for the most direct tool, no unasked mode, honesty about not seeing, and titles", () => {
    const p = systemPrompt([{ file: "a.md", title: "A", text: "# A" }], { fileType: "RW2", mono: false, develop: [], finish: [] });
    expect(p).toContain("most direct tool");
    expect(p).toContain("Never assume a treatment or mode the user did not mention");
    expect(p).toContain("You cannot see the photograph");
    expect(p).toContain("Smart Selection");
    expect(p).toContain("say that the guide does not cover it");
    expect(p).toContain("by their titles");
    expect(p).toContain("THE OPEN PHOTOGRAPH");
    expect(p).toContain("--- CHAPTER a.md (A) ---");
  });

  // 2026-09-28: with black and white on, "How can I darken the sky to
  // balance the photo?" still went to Sky Rescue. One sentence, only in
  // mono, fixed it against his Qwen3; any black and white wording for a
  // color photograph made color answers worse.
  it("points a black and white photograph at the mix, and never mentions black and white for a color one", () => {
    const toc = "adjustments/sky-rescue.md: identifies bright sky-like tones\nexport.md: Export: writes files";
    const chapters: Chapter[] = [{ file: "adjustments/sky-rescue.md", title: "Sky Rescue", text: "# Sky Rescue\n\nRecovery." }];
    const mono = { fileType: "RW2", mono: true, develop: ["Exposure", "Color"], finish: [] };
    const color = { ...mono, mono: false };
    expect(routePrompt(toc, mono)).toContain(MONO_ROUTE);
    expect(MONO_ROUTE).toContain("the Black and White chapter's mix comes first");
    expect(systemPrompt(chapters, mono)).toContain(MONO_ANSWER);
    expect(MONO_ANSWER).toContain("lower Blue");
    for (const p of [routePrompt(toc, color), systemPrompt(chapters, color), routePrompt(toc, null), systemPrompt(chapters, null)]) {
      expect(p.toLowerCase()).not.toContain("black and white");
      expect(p.toLowerCase()).not.toContain("black-and-white");
    }
  });

  it("reads the facts from the edit: the conversion, the sections on, the Finish layers on, the file type", () => {
    const s = initialState();
    const image = { ...s.images[0], id: "p1", name: "P1000123.RW2" };
    const bw: NodeCard = { id: "bw_test", type: "heeler.black_white", name: "Black & White", cat: "color", x: 0, y: 0, enabled: true, params: { amount: 100 } };
    const state = { ...s, images: [image], activeImage: "p1", nodes: [...s.nodes.filter((n) => n.type !== "heeler.black_white"), bw] };
    const facts = photoFactsOf(state)!;
    expect(facts.fileType).toBe("RW2");
    expect(facts.mono).toBe(true);
    expect(facts.develop).not.toContain("Source");
    expect(facts.finish).toEqual([]);
    expect(JSON.stringify(facts)).not.toContain("P1000123");
    const off = photoFactsOf({ ...state, nodes: state.nodes.map((n) => (n.id === "bw_test" ? { ...n, enabled: false } : n)) })!;
    expect(off.mono).toBe(false);
    expect(photoFactsOf({ ...state, activeImage: "" })).toBeNull();
  });
});

describe("the answer as displayed", () => {
  it("renders bold, italic, code and lists, and never HTML", () => {
    const { container } = render(
      <AssistantMarkdown text={"Use **Sky Rescue** and *Recovery*, set `Threshold`.\n\n1. Turn it on.\n2. Move **Threshold**.\n\n- snake_case stays\n- <b>raw</b> stays text"} />,
    );
    expect(container.querySelectorAll("strong")).toHaveLength(2);
    expect(container.querySelector("strong")?.textContent).toBe("Sky Rescue");
    expect(container.querySelector("em")?.textContent).toBe("Recovery");
    expect(container.querySelector("code")?.textContent).toBe("Threshold");
    expect(container.querySelectorAll("ol li")).toHaveLength(2);
    expect(container.querySelectorAll("ul li")).toHaveLength(2);
    expect(container.textContent).toContain("snake_case stays");
    expect(container.querySelector("b")).toBeNull();
    expect(container.textContent).toContain("<b>raw</b> stays text");
  });

  it("takes the model's sources line out of the text and keeps its chapters as links", () => {
    const known = new Set(["adjustments/sky-rescue.md", "adjustments/color-tune.md"]);
    const titles = new Map([["adjustments/sky-rescue.md", "Sky Rescue"], ["adjustments/color-tune.md", "Color Tune"]]);
    const r = citations("Use Sky Rescue.\n\n**Chapter used:** Color Tune\nSources: adjustments/sky-rescue.md", known, titles);
    expect(r.text).toBe("Use Sky Rescue.");
    expect(r.files).toEqual(["adjustments/sky-rescue.md", "adjustments/color-tune.md"]);
    expect(citations("Fine.\n*Sources:* Sky Rescue (adjustments/sky-rescue.md)", known, titles).text).toBe("Fine.");
  });
});

it("drops oversized earlier answers rather than exceeding the conversation budget", () => {
  const history: import("../bridge").AssistantMessage[] = [
    { role: "user", content: "How do I export?" },
    { role: "assistant", content: "An earlier long answer. ".repeat(10000) },
  ];
  const messages = buildMessages(history, "How do I crop?", []);
  expect(messages.some((m) => m.content.includes("An earlier long answer."))).toBe(false);
  expect(messages[messages.length - 1]?.content).toBe("How do I crop?");
  expect(messages.filter((m) => m.role === "user")).toHaveLength(1);
});
