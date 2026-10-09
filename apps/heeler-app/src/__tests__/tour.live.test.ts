// Guided tours against a real model server, run by hand only:
//   HEELER_ASSISTANT_LIVE=http://canyonlands.local:1234 \
//   HEELER_ASSISTANT_MODEL=qwen/qwen3-30b-a3b-2507 npx vitest run src/__tests__/tour.live.test.ts
// HEELER_TOUR_WORKSPACE=Graph asks them in the Graph workspace, and
// HEELER_TOUR_FOLLOWUP="How do I simulate infrared?" asks that as a
// follow-up typed on the end card of the first question's tour.
// Skipped in every default run (the suites stay offline). Each question
// goes through the same two calls a Console question takes (askGuide),
// then whether the answer is offered a tour (canShow), then the tour call
// (askTour), over the real guide read from disk; the offer, the plan
// before and after the network repair (src/tourplan.ts), whether each
// validated and why a reply was dropped are printed for the record.

import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";

const ADDRESS = process.env.HEELER_ASSISTANT_LIVE ?? "";
const MODEL = process.env.HEELER_ASSISTANT_MODEL ?? "qwen/qwen3-30b-a3b-2507";
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
      (globalThis as { lastReply?: string }).lastReply = j.choices[0].message.content;
      return j.choices[0].message.content;
    },
  };
});

import { askGuide, loadGuide, type Workspace } from "../assistant";
import { budgetFor } from "../assistantguide";
import { tourContext } from "../assistantchat";
import { initialState } from "../data";
import { reduce } from "../state";
import { askTour, canShow, checkTour, MAX_STEPS, OFFER_LINE } from "../tour";
import { repairPlan } from "../tourplan";
import type { Tour } from "../tourwalk";

const QUESTIONS = (process.env.HEELER_TOUR_QUESTIONS ?? "")
  .split("|")
  .map((q) => q.trim())
  .filter(Boolean);
const DEFAULT = [
  "How do I make a photo black and white?",
  "How do I crop to 16:9?",
  "How do I export a JPEG 2048 pixels on the long side?",
  "How do I remove a dust spot?",
  "How do I add a node that lowers saturation in the graph?",
  "How do I use the red channel as a mask in the node graph?",
  "How do I insert a node between two connected nodes in the graph?",
];

async function contextTokens(): Promise<number | null> {
  try {
    const r = await fetch(`${ADDRESS}/api/v0/models/${MODEL}`);
    const j = (await r.json()) as { loaded_context_length?: number };
    return j.loaded_context_length ?? null;
  } catch {
    return null;
  }
}

const WORKSPACE = (process.env.HEELER_TOUR_WORKSPACE ?? "") as Workspace | "";
const FOLLOWUP = process.env.HEELER_TOUR_FOLLOWUP ?? "";

const line = (st: { stop: string; from?: string; to?: string }) => [st.stop, st.from, st.to].filter(Boolean).join(" ");

describe.skipIf(!ADDRESS)("guided tours, live", () => {
  it("generates the tours", async () => {
    const tokens = await contextTokens();
    const guide = await loadGuide();
    const workspace = WORKSPACE || null;
    let graph = initialState();
    if (workspace === "Graph") graph = reduce(graph, { type: "set_mode", mode: "advanced" });
    let history: { role: "user" | "assistant"; content: string }[] = [];
    let last: Tour | null = null;
    const asks = [...(QUESTIONS.length ? QUESTIONS : DEFAULT).map((q) => ({ q, follow: false })), ...(FOLLOWUP ? [{ q: FOLLOWUP, follow: true }] : [])];
    for (const { q: shown, follow } of asks) {
      // A follow-up is typed on the end card: it carries the tour just
      // walked, and the conversation so far.
      const question: string = follow && last ? `${shown}\n\n${tourContext(last)}` : shown;
      const t0 = Date.now();
      const answer = await askGuide({
        address: ADDRESS,
        model: MODEL,
        question,
        history: follow ? history : [],
        facts: null,
        where: workspace ? { workspace } : null,
        contextTokens: tokens,
      });
      const t1 = Date.now();
      const offered = canShow({ question: shown, answer: answer.reply, chapters: answer.material.chapters, max: 400, workspace });
      let dropped = "";
      const tour: Tour | null = offered
        ? await askTour({
            address: ADDRESS,
            model: MODEL,
            question,
            answer: answer.reply,
            chapters: answer.material.chapters,
            guide,
            budget: budgetFor(tokens),
            workspace,
            graph,
            onDropped: (r) => { dropped = r; },
          })
        : null;
      const t2 = Date.now();
      const raw = (globalThis as { lastReply?: string }).lastReply ?? "";
      const checked = offered ? checkTour(raw) : null;
      const plan = checked?.ok ? repairPlan(checked.steps, { answer: answer.reply, graph, say: (x) => x, maxSteps: MAX_STEPS + 4 }) : null;
      console.log(
        [
          `\n=== ${follow ? "(follow-up) " : ""}${shown}${workspace ? ` [${workspace}]` : ""}`,
          `chapters: ${answer.material.chapters.map((c) => c.file).join(", ")}`,
          `answer (${((t1 - t0) / 1000).toFixed(1)} s): ${answer.reply.replace(/\n+/g, " / ").slice(0, 900)}`,
          `offer: ${offered ? OFFER_LINE : "none (no directions that can be shown)"}`,
          ...(offered
            ? [
                `plan before repair: ${checked?.ok ? checked.steps.map(line).join(", ") : `failed the check: ${checked && !checked.ok ? checked.reason : ""}`}`,
                ...(checked?.ok && checked.dropped.length ? [`steps dropped on their own: ${checked.dropped.join("; ")}`] : []),
                ...(plan ? [`repairs: ${plan.repairs.join(" / ") || "none"}`, `plan after repair: ${plan.steps.map(line).join(", ")}${plan.whole ? "" : ` (not whole: ${plan.missing.join("; ")})`}`] : []),
                `tour (${((t2 - t1) / 1000).toFixed(1)} s): ${tour ? "VALID" : `DROPPED (the sorry line): ${dropped}\n  raw: ${raw}`}`,
              ]
            : []),
          ...(tour?.steps ?? []).map((st, i) => `  ${i + 1}. ${line(st)}: ${st.say}`),
        ].join("\n"),
      );
      history = [...history, { role: "user", content: question }, { role: "assistant", content: answer.reply }];
      if (tour) last = tour;
      expect(checkTour("{}").ok).toBe(false);
    }
  }, 1_800_000);
});
