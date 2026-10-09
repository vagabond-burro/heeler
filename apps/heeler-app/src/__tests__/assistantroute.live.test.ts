// Where the user is, against a real model server, run by hand only:
//   HEELER_ASSISTANT_LIVE=http://canyonlands.local:1234 \
//   HEELER_ASSISTANT_MODEL=qwen/qwen3-30b-a3b-2507 npx vitest run src/__tests__/assistantroute.live.test.ts
// Skipped in every default run (the suites stay offline).
//
// "routing": the routing call alone (routeMessages, parseChosen) over the
// guide's 34 questions with no workspace (as before) and in Develop, and
// over the workspace set (src/assistantworkspace.json) in Develop and in
// Graph; each counted right when the chapters it chose hold every
// expected one. HEELER_LIVE_PART=answers instead asks HEELER_LIVE_QUESTIONS
// (a | list, five of the workspace set by default) in Develop and in
// Graph through the whole question (askGuide, then askTour) and prints
// the answers and the tours for the record.

import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";

const ADDRESS = process.env.HEELER_ASSISTANT_LIVE ?? "";
const MODEL = process.env.HEELER_ASSISTANT_MODEL ?? "qwen/qwen3-30b-a3b-2507";
const PART = process.env.HEELER_LIVE_PART ?? "routing";

function guideFiles(): Record<string, string> {
  const GUIDE_DIR = resolve(process.cwd(), "../../docs/user-guide");
  const out: Record<string, string> = {};
  const walk = (dir: string, pre: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const rel = pre ? `${pre}/${e.name}` : e.name;
      if (e.isDirectory()) walk(`${dir}/${e.name}`, rel);
      else if (e.name.endsWith(".md")) out[rel] = readFileSync(`${dir}/${e.name}`, "utf8");
    }
  };
  walk(GUIDE_DIR, "");
  return out;
}

vi.mock("../bridge", async (importOriginal) => {
  const real = (await importOriginal()) as Record<string, unknown>;
  let cached: Record<string, string> | null = null;
  const files = () => (cached ??= guideFiles());
  return {
    ...real,
    listDocs: async () =>
      Object.entries(files())
        .map(([file, text]) => ({ file, title: text.split("\n").find((l) => l.startsWith("# "))?.slice(2).trim() ?? file }))
        .sort((a, b) => a.file.localeCompare(b.file)),
    readDoc: async (file: string) => files()[file] ?? null,
    assistantChat: async (address: string, model: string, messages: { role: string; content: string }[], temperature?: number) => {
      const r = await fetch(`${address}/v1/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model, messages, ...(temperature === undefined ? {} : { temperature }) }),
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const j = (await r.json()) as { choices: { message: { content: string } }[] };
      return j.choices[0].message.content;
    },
  };
});

import { askGuide, loadGuide, routeMessages, type PhotoFacts, type WhereFacts } from "../assistant";
import { budgetFor, GUIDE_BUDGET, parseChosen, tableOfContents } from "../assistantguide";
import { assistantChat } from "../bridge";
import { NODE_CATALOG } from "../nodes";
import { askTour, isHowTo } from "../tour";
import { nodeChapter } from "../tourstops";
import questions from "../assistantquestions.json";
import set from "../assistantworkspace.json";

type Expect = string | string[];
const satisfied = (expect: Expect[], files: string[]) => expect.every((x) => (Array.isArray(x) ? x : [x]).some((f) => files.includes(f)));

/** A color photograph, as the app's facts say it. */
const COLOR: PhotoFacts = { fileType: "RW2", mono: false, develop: ["Exposure", "Color"], finish: [] };

function whereFor(workspace: "Develop" | "Graph", selected?: string[]): WhereFacts {
  if (workspace === "Develop") return { workspace, tab: "Adjustments", layer: "Base (the whole photograph)" };
  const kinds = (selected ?? []).map((t) => {
    const spec = NODE_CATALOG.find((n) => n.type === t)!;
    return { kind: spec.name, type: t, ref: nodeChapter(spec) };
  });
  return { workspace, ...(kinds.length ? { selected: kinds } : {}) };
}

async function contextTokens(): Promise<number | null> {
  try {
    const r = await fetch(`${ADDRESS}/api/v0/models/${MODEL}`);
    const j = (await r.json()) as { loaded_context_length?: number };
    return j.loaded_context_length ?? null;
  } catch {
    return null;
  }
}

describe.skipIf(!ADDRESS || PART !== "routing")("where the user is, the routing call live", () => {
  it("routes the question sets per workspace", async () => {
    const guide = await loadGuide();
    const known = new Set(guide.map((c) => c.file));
    const tokens = await contextTokens();
    const toc = tableOfContents(guide, budgetFor(tokens) > GUIDE_BUDGET ? "full" : "lean");
    const route = async (q: string, where: WhereFacts | null) => parseChosen(await assistantChat(ADDRESS, MODEL, routeMessages([], q, toc, COLOR, where), 0), known);
    const tally: Record<string, number> = {};
    const lines: string[] = [];
    const run = async (label: string, q: string, expect: Expect[], where: WhereFacts | null) => {
      const chosen = await route(q, where);
      const ok = satisfied(expect, chosen);
      tally[label] = (tally[label] ?? 0) + (ok ? 1 : 0);
      lines.push(`${ok ? "  ok " : "MISS "}[${label}] ${q} -> ${chosen.join(", ")}`);
    };
    for (const q of questions.questions) {
      await run("34 none", q.q, q.expect as Expect[], null);
      await run("34 Develop", q.q, q.expect as Expect[], whereFor("Develop"));
    }
    for (const q of set.questions) {
      if (q.develop) await run("set Develop", q.q, q.develop as Expect[], whereFor("Develop"));
      await run("set Graph", q.q, q.graph as Expect[], whereFor("Graph", q.selected));
    }
    console.log([...lines, "", ...Object.entries(tally).map(([k, v]) => `${k}: ${v}`)].join("\n"));
    expect(Object.keys(tally).length).toBe(4);
  }, 3_600_000);
});

const DEFAULT = ["How do I desaturate the reds?", "How do I darken the sky?", "How do I add grain?", "How do I blur only the background?", "What does this node do?"];

describe.skipIf(!ADDRESS || PART !== "answers")("where the user is, answers and tours live", () => {
  it("answers and tours in Develop and in Graph", async () => {
    const guide = await loadGuide();
    const tokens = await contextTokens();
    const asked = (process.env.HEELER_LIVE_QUESTIONS ?? "").split("|").map((q) => q.trim()).filter(Boolean);
    for (const question of asked.length ? asked : DEFAULT) {
      const entry = set.questions.find((q) => q.q === question);
      for (const ws of ["Develop", "Graph"] as const) {
        if (ws === "Develop" && entry && !entry.develop) continue;
        const where = whereFor(ws, entry?.selected);
        const t0 = Date.now();
        const answer = await askGuide({ address: ADDRESS, model: MODEL, question, history: [], facts: COLOR, where, contextTokens: tokens });
        const t1 = Date.now();
        let dropped = "";
        const tour = isHowTo(question)
          ? await askTour({
              address: ADDRESS,
              model: MODEL,
              question,
              answer: answer.reply,
              chapters: answer.material.chapters,
              guide,
              budget: budgetFor(tokens),
              workspace: ws,
              selected: where.selected?.map((n) => n.type),
              onDropped: (r) => { dropped = r; },
            })
          : null;
        const t2 = Date.now();
        console.log(
          [
            `\n=== [${ws}] ${question}`,
            `chapters: ${answer.material.chapters.map((c) => c.file).join(", ")} (routed: ${answer.routed})`,
            `answer (${((t1 - t0) / 1000).toFixed(1)} s): ${answer.reply.replace(/\n+/g, " / ")}`,
            isHowTo(question) ? `tour (${((t2 - t1) / 1000).toFixed(1)} s): ${tour ? "VALID" : `DROPPED: ${dropped}`}` : "tour: not a how-to",
            ...(tour?.steps ?? []).map((s, i) => `  ${i + 1}. ${s.stop}${s.from ? ` from ${s.from}` : ""}${s.to ? ` to ${s.to}` : ""}: ${s.say}`),
          ].join("\n"),
        );
      }
    }
    expect(true).toBe(true);
  }, 3_600_000);
});
