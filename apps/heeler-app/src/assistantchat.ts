// The assistant's conversation, kept in the MAIN window for as long as
// Heeler runs. 2026-09-28: "keeping a history of the chat until Heeler
// closes would be nice."
//
// The Console is a window of its own and can be closed, reopened,
// reloaded or popped in and out; anything it keeps in its own memory
// goes with it. So the main window owns the conversation and does the
// asking (the model calls run in its webview, where a Console closing
// mid-answer cannot orphan them), and the Console shows a copy: every
// change is sent to it as a whole snapshot, and what the user does there
// (ask, stop, clear, dismiss the hint) comes back as a request. A
// Console that opens says hello and is sent the conversation so far.
// Nothing is written anywhere: it ends when Heeler quits, or on Clear.
//
// With nothing connected (a test, a single window) the module is its own
// owner and asks locally, which is the same code the main window runs.

import type { AssistantMessage } from "./bridge";
import { assistantContextLength } from "./bridge";
import { askGuide, assistantConfig, assistantPhoto, citations, currentWhere, loadGuide, requestPicture, type Chapter } from "./assistant";
import { budgetFor } from "./assistantguide";
import { askTour, canShow, DECLINED_LINE, isNo, isShowRequest, isYes, SORRY_LINE } from "./tour";
import { onTourStatus, requestTour, startTourHere, tourHostState, type Tour, type WalkStatus } from "./tourwalk";
import type { Workspace } from "./assistant";
import { logDebug } from "./log";
import type { Transport } from "./popout";

export interface Turn {
  role: "user" | "assistant" | "error";
  text: string;
  /** guide files the answer cites, with their titles */
  cites?: { file: string; title: string }[];
  /** An answer's guided tour (2026-09-29: offered after every answer
   * whose directions can be shown, built only on yes): "offered" (SHOW
   * ME, and while it is the last turn the offer line and a pending
   * "yes"), "building" (the tour call running), the tour made, or
   * "none" (it could not be made whole; the sorry line follows).*/
  tour?: Tour | "offered" | "building" | "none";
  /** a reply Heeler gave itself (to "no", or the sorry line), not the
   * model's: it cites no chapter and needs no warning for it */
  local?: boolean;
}

export type VisionHint = "unseen" | "showing" | "done";

/** Everything the Console draws, as one value. */
export interface ChatSnapshot {
  turns: Turn[];
  busy: boolean;
  /** The Florence-2 hint (a line, never a dialog): shown after the
   * first question of the session asked with a photograph open while
   * Florence-2 is not installed, until dismissed or the conversation is
   * cleared, and never again this session. */
  visionHint: VisionHint;
  /** each tour's walk as the main window last reported it */
  tours: Record<string, WalkStatus>;
  /** each tour's step count as the walk counted it when it started in
   * the main window (the steps already done left out) */
  tourSteps: Record<string, number>;
  /** the main window asked the Console to show the Assistant tab (a
   * Learn more question chosen there); cleared when the Console says it
   * has */
  reveal: boolean;
}

const EMPTY: ChatSnapshot = { turns: [], busy: false, visionHint: "unseen", tours: {}, tourSteps: {}, reveal: false };

let snap: ChatSnapshot = EMPTY;
/** What went to the model, for the next question's history. The owner's
 * alone: the Console never needs it. */
let history: AssistantMessage[] = [];
/** Bumped by Stop and Clear: a reply that arrives for an older ask is
 * dropped. The server may still finish it; Heeler stops listening. */
let ask = 0;
/** The model's loaded context in tokens, when the server said (LM
 * Studio does); null keeps the budget tuned for 4,096 tokens. Keyed by
 * address and model, so a change of either asks again. */
let context: { key: string; tokens: number | null } | null = null;

/** What each offered tour is made from, by its answer's turn, kept by
 * The owner until the user says yes (or Clear). */
interface TourMaterial {
  question: string;
  answer: string;
  chapters: Chapter[];
  guide: Chapter[];
  workspace: Workspace | null;
  selected?: string[];
  budget: number;
}
const offers = new Map<number, TourMaterial>();

let ver = 0;
const subs = new Set<() => void>();

/** "local": owner, nothing connected. "main": owner, serving a Console.
 * "console": a copy of the main window's. */
let role: "local" | "main" | "console" = "local";
let link: Transport | null = null;

const SNAPSHOT = "heeler:assistant-chat";
const REQUEST = "heeler:assistant-chat-do";

type Request =
  | { do: "hello" }
  | { do: "ask"; question: string; about?: string }
  | { do: "stop" }
  | { do: "clear" }
  | { do: "dismiss-hint" }
  | { do: "revealed" }
  | { do: "show"; turn: number }
  | { do: "context"; key: string; tokens: number | null };

function set(next: Partial<ChatSnapshot>): void {
  snap = { ...snap, ...next };
  ver++;
  if (role === "main") link?.send(SNAPSHOT, snap);
  for (const fn of subs) fn();
}

export function chatSnapshot(): ChatSnapshot {
  return snap;
}

export function chatVersion(): number {
  return ver;
}

export function subscribeChat(fn: () => void): () => void {
  subs.add(fn);
  return () => subs.delete(fn);
}

const revealListeners = new Set<() => void>();

/** The Console's panel: switch to the Assistant tab when the main window
 * asks a question for the user. */
export function onRevealAssistant(fn: () => void): () => void {
  revealListeners.add(fn);
  return () => revealListeners.delete(fn);
}

function request(r: Request): void {
  link?.send(REQUEST, r);
}

// -- what the user does -----------------------------------------------------------

/** Asks a question: here when this window owns the conversation, else of
 * the main window. A question while one is being answered is ignored,
 * as the ASK button is. */
export function askAssistant(question: string, about?: string): void {
  if (role === "console") {
    if (!snap.busy) request({ do: "ask", question, ...(about ? { about } : {}) });
    return;
  }
  if (!snap.busy) void askHere(question, about);
}

/** SHOW ME on an answer: its tour starts, or is made first when it was
 * only offered. */
export function showTour(turn: number): void {
  const t = snap.turns[turn]?.tour;
  if (t && typeof t === "object") {
    startTour(t);
    return;
  }
  if (role === "console") {
    if (!snap.busy) request({ do: "show", turn });
    return;
  }
  if (!snap.busy) void buildTour(turn);
}

/** The offer that "yes" answers: the last turn, an answer whose tour
 * is offered and not yet made. */
export function pendingOffer(s: ChatSnapshot = snap): number | null {
  const i = s.turns.length - 1;
  return i >= 0 && s.turns[i].role === "assistant" && s.turns[i].tour === "offered" ? i : null;
}

/** What a follow-up typed on the tour's end card carries to the model:
 * the tour just walked, so "and then?" has something to follow. The
 * conversation shows the question as typed. */
export function tourContext(tour: Tour): string {
  const steps = tour.steps.map((s, i) => `${i + 1}. ${s.say}`).join(" ");
  return `(Asked right after the guided tour for "${tour.question}", whose steps were: ${steps})`;
}

export function stopAssistant(): void {
  if (role === "console") request({ do: "stop" });
  else stopHere();
}

export function clearAssistantConversation(): void {
  if (role === "console") request({ do: "clear" });
  else clearHere();
}

export function dismissVisionHint(): void {
  if (role === "console") request({ do: "dismiss-hint" });
  else set({ visionHint: "done" });
}

/** The model's context as the tab read it, for the owner's budget. */
export function noteContext(key: string, tokens: number | null): void {
  if (role === "console") request({ do: "context", key, tokens });
  else context = { key, tokens };
}

export function knownContext(key: string): boolean {
  return context?.key === key;
}

/** The main window: ask for the user and have the Console show it. */
export function askAndReveal(question: string, about?: string): void {
  askAssistant(question, about);
  if (role !== "console") set({ reveal: true });
}

// -- the owner --------------------------------------------------------------------

function clearHere(): void {
  history = [];
  offers.clear();
  ask++;
  set({ turns: [], busy: false, visionHint: snap.visionHint === "showing" ? "done" : snap.visionHint });
}

function stopHere(): void {
  ask++;
  // A tour being made goes back to being offered.
  const turns = snap.turns.map((t) => (t.tour === "building" ? { ...t, tour: "offered" as const } : t));
  set({ busy: false, turns: [...turns, { role: "error", text: "Stopped. The server may finish the answer on its own; Heeler is no longer waiting for it." }] });
}

/** A tour made: walked here when this window walks tours (the main
 * window), else asked of the main window. */
function startTour(tour: Tour): void {
  if (role === "console" || !startTourHere(tour)) requestTour(tour);
}

function setTurn(i: number, patch: Partial<Turn>): void {
  set({ turns: snap.turns.map((t, j) => (j === i ? { ...t, ...patch } : t)) });
}

/** The user said yes, or pressed SHOW ME: the tour is made now, from
 * the answer's material, and walked; if it cannot be made whole, the
 * sorry line. Nothing is made before this. */
async function buildTour(turn: number): Promise<void> {
  const t = snap.turns[turn];
  if (!t || t.tour !== "offered") return;
  const m = offers.get(turn);
  const mine = ++ask;
  if (!m) {
    setTurn(turn, { tour: "none" });
    set({ turns: [...snap.turns, { role: "assistant", text: SORRY_LINE, local: true }] });
    return;
  }
  const c = assistantConfig();
  setTurn(turn, { tour: "building" });
  set({ busy: true });
  try {
    const made = await askTour({
      address: c.address,
      model: c.model,
      ...m,
      // The graph as it is now in the main window, for the plan's
      // check (played on a copy, never on this).
      graph: tourHostState(),
    }).catch(() => null);
    if (mine !== ask) return;
    if (!made) {
      setTurn(turn, { tour: "none" });
      set({ turns: [...snap.turns, { role: "assistant", text: SORRY_LINE, local: true }] });
      return;
    }
    setTurn(turn, { tour: made });
    startTour(made);
  } finally {
    if (mine === ask) set({ busy: false });
  }
}

/** A short reply to the answer before it, handled here without the
 * model: yes to an offer makes the tour, no declines it, and asking to
 * be shown what cannot be shown gets the sorry line. True when handled. */
function replyHere(shown: string): boolean {
  const i = snap.turns.length - 1;
  const last = snap.turns[i];
  if (!last || last.role !== "assistant" || last.local) return false;
  const you: Turn = { role: "user", text: shown };
  if (last.tour === "offered" && isYes(shown)) {
    set({ turns: [...snap.turns, you] });
    void buildTour(i);
    return true;
  }
  if (last.tour === "offered" && isNo(shown)) {
    set({ turns: [...snap.turns, you, { role: "assistant", text: DECLINED_LINE, local: true }] });
    return true;
  }
  if (isShowRequest(shown)) {
    if (last.tour && typeof last.tour === "object") {
      set({ turns: [...snap.turns, you] });
      startTour(last.tour);
      return true;
    }
    if (last.tour === undefined || last.tour === "none") {
      set({ turns: [...snap.turns, you, { role: "assistant", text: SORRY_LINE, local: true }] });
      return true;
    }
  }
  return false;
}

async function askHere(shown: string, about?: string): Promise<void> {
  if (!about && replyHere(shown)) return;
  const c = assistantConfig();
  const mine = ++ask;
  // The model reads the question with what it follows; the
  // conversation shows it as asked.
  const question = about ? `${shown}\n\n${about}` : shown;
  set({ busy: true, turns: [...snap.turns, { role: "user", text: shown }] });
  try {
    const key = `${c.address} ${c.model}`;
    // The main window reads the context itself when no tab has yet.
    if (role === "main" && c.model && context?.key !== key) {
      const tokens = await assistantContextLength(c.address, c.model).catch(() => null);
      context = { key, tokens };
      if (mine !== ask) return;
    }
    const tokens = context?.key === key ? context.tokens : null;
    // The picture report, measured now from the frame on screen, and
    // Florence-2's description of what is in it when it is installed,
    // with a photograph open (src/assistantpicture.ts,
    // src/assistantvision.ts), in one request.
    const facts = assistantPhoto();
    // Where the user is, read now, here in the main window: the answer
    // and the tour are given in that workspace's terms.
    const where = currentWhere();
    const got = facts ? await requestPicture(question) : null;
    if (mine !== ask) return;
    // What was read from the picture for this question, at DEBUG
    // (2026-09-29: "log Florence's description too"): the numbers and
    // Florence-2's description and regions, as the model will read them.
    // Never the question or the answer: the conversation stays out of the
    // log.
    if (facts) logDebug(() => pictureLogLine(got));
    if (got?.florence === "missing" && snap.visionHint === "unseen") set({ visionHint: "showing" });
    const { reply, material } = await askGuide({
      address: c.address,
      model: c.model,
      question,
      history,
      facts,
      picture: got?.report ?? null,
      vision: got?.vision ?? null,
      where,
      contextTokens: tokens,
    });
    if (mine !== ask) return;
    const guide = await loadGuide();
    const titles = new Map(guide.map((g: Chapter) => [g.file, g.title]));
    const { text, files } = citations(reply, new Set(titles.keys()), titles);
    history = [...history, { role: "user", content: question }, { role: "assistant", content: reply }];
    const at = snap.turns.length;
    // The offer, after every answer whose directions a tour could show
    // (the question asks how, or the answer gives steps, and a stop of
    // Heeler's list fits them). Nothing is made until the user says
    // yes: the material is kept for then.
    const workspace = where?.workspace ?? null;
    const selected = where?.selected?.map((n) => n.type);
    const offer = canShow({ question: shown, answer: text, chapters: material.chapters, max: 400, workspace, selected });
    if (offer) {
      offers.set(at, { question, answer: text, chapters: material.chapters, guide, workspace, selected, budget: budgetFor(tokens) });
    }
    set({ turns: [...snap.turns, { role: "assistant", text, cites: files.map((file) => ({ file, title: titles.get(file) ?? file })), ...(offer ? { tour: "offered" as const } : {}) }] });
  } catch (e) {
    if (mine !== ask) return;
    set({ turns: [...snap.turns, { role: "error", text: String(e).replace(/^Error:\s*/, "") }] });
  } finally {
    if (mine === ask) set({ busy: false });
  }
}

// -- between the windows ----------------------------------------------------------

/** The main window serves the conversation; the Console window shows it.
 * Returns the disconnect. */
export function connectAssistantChat(which: "main" | "console", transport: Transport): () => void {
  link = transport;
  if (which === "main") {
    role = "main";
    const off = transport.subscribe(REQUEST, (r: Request) => {
      if (!r || typeof r !== "object") return;
      if (r.do === "hello") transport.send(SNAPSHOT, snap);
      else if (r.do === "ask" && typeof r.question === "string") askAssistant(r.question, typeof r.about === "string" ? r.about : undefined);
      else if (r.do === "stop") stopHere();
      else if (r.do === "clear") clearHere();
      else if (r.do === "dismiss-hint") set({ visionHint: "done" });
      else if (r.do === "revealed") { if (snap.reveal) set({ reveal: false }); }
      else if (r.do === "show" && typeof r.turn === "number") showTour(r.turn);
      else if (r.do === "context" && typeof r.key === "string") context = { key: r.key, tokens: typeof r.tokens === "number" ? r.tokens : null };
    });
    // The walk's status, kept with the conversation, so a Console that
    // opens after a tour ended still offers Learn more.
    const offStatus = onTourStatus((id, status, steps) =>
      set({ tours: { ...snap.tours, [id]: status }, ...(typeof steps === "number" ? { tourSteps: { ...snap.tourSteps, [id]: steps } } : {}) }),
    );
    transport.send(SNAPSHOT, snap);
    return () => {
      off();
      offStatus();
      if (link === transport) link = null;
      role = "local";
    };
  }
  role = "console";
  const off = transport.subscribe(SNAPSHOT, (next: ChatSnapshot) => {
    if (!next || !Array.isArray(next.turns)) return;
    snap = { ...EMPTY, ...next };
    ver++;
    for (const fn of subs) fn();
    if (snap.reveal) {
      for (const fn of revealListeners) fn();
      request({ do: "revealed" });
    }
  });
  request({ do: "hello" });
  return () => {
    off();
    if (link === transport) link = null;
    role = "local";
  };
}

/** Test hook: a conversation as if it had been asked. */
export function _seedForTests(turns: Turn[], tours: Record<string, WalkStatus> = {}): void {
  set({ turns, tours });
}

/** Test hook: an offered turn's material, as an answer would keep it. */
export function _seedOfferForTests(turn: number, material: TourMaterial): void {
  offers.set(turn, material);
}

/** Test hook: an empty conversation and nothing connected. */
export function _resetAssistantChatForTests(): void {
  snap = EMPTY;
  history = [];
  offers.clear();
  ask++;
  context = null;
  role = "local";
  link = null;
  ver++;
  for (const fn of subs) fn();
}

/** The DEBUG line for what was read from the picture: Florence-2's
 * status, its caption and detected objects, and the picture report.
 * Grounding can echo the question, so only the separate log text is safe. */
export function pictureLogLine(got: { report?: string | null; vision?: string | null; visionLog?: string; florence?: string } | null): string {
  if (!got) return "assistant: nothing was read from the picture (no reply from the main window in time)";
  return [
    `assistant: read from the picture (Florence-2 ${got.florence ?? "not asked"})`,
    got.visionLog ?? "(no Florence-2 description)",
    got.report ? got.report : "(no picture report)",
  ].join("\n");
}
