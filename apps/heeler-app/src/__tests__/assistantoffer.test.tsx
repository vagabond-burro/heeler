// The offer to show, after every answer, built on yes (2026-09-29:
// "what it should do after giving me directions is ask something like
// 'Say yes if you would like for me to show you?' then if I say yes
// build the steps. This should be an option after every prompt,
// considering it is possible to show something. If the user can't be
// shown then just be explicit about it"). The conversation is asked
// here as its own owner (src/assistantchat.ts, role "local"), with the
// walk's host over the real reducer, so a tour made is walked here. The
// invoke is mocked; nothing reaches a server.

import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));

import { resetAssistantConfigForTests, resetAssistantPhotoForTests, resetGuideForTests, setAssistantConfig } from "../assistant";
import { askAssistant, chatSnapshot, pendingOffer, showTour, _resetAssistantChatForTests } from "../assistantchat";
import { initialState } from "../data";
import { reduce, type State } from "../state";
import { DECLINED_LINE, isNo, isShowRequest, isYes, OFFER_LINE, SORRY_LINE } from "../tour";
import { currentWalk, resetToursForTests, setTourHost } from "../tourwalk";
import { AssistantTab } from "../ui/assistanttab";

const READY = { enabled: true, address: "http://localhost:1234", model: "m", validated: "http://localhost:1234" };
const DOCS: Record<string, string> = {
  "README.md": "# Heeler user guide\n",
  "adjustments/black-and-white.md": "# Black and White\n\nSet Treatment to black and white in Color.\n",
};

/** Each answer the model gives, by the question it answers. */
const ANSWERS: Record<string, string> = {
  bw: "Open **Color** and set **Treatment** to black and white.\nSources: adjustments/black-and-white.md",
  infrared: "Open the **Color** section, set **Treatment** to Infrared, then raise **Red** in the mix.\nSources: adjustments/black-and-white.md",
  what: "A Treatment is the look the Color section gives the photograph.\nSources: adjustments/black-and-white.md",
};
const GOOD_TOUR = '{"steps": [{"stop": "section.color", "say": "Open Color."}, {"stop": "bw.treatment", "say": "Choose black and white."}]}';

let tourReply = GOOD_TOUR;
/** every model call's system prompt, in order */
const calls: string[] = [];

beforeEach(() => {
  (window as any).__TAURI_INTERNALS__ = { invoke: (name: string, args?: Record<string, unknown>) => invoke(name, args) };
  resetAssistantConfigForTests();
  resetAssistantPhotoForTests();
  resetGuideForTests();
  _resetAssistantChatForTests();
  resetToursForTests();
  calls.length = 0;
  tourReply = GOOD_TOUR;
  invoke.mockImplementation(async (name: string, args?: Record<string, unknown>) => {
    if (name === "assistant_validate") return { kind: "connected", address: "127.0.0.1:1234", models: [{ id: "m", tested: false }] };
    if (name === "assistant_context_length") return null;
    if (name === "list_docs") return Object.keys(DOCS).map((file) => ({ file, title: DOCS[file].split("\n")[0].slice(2) }));
    if (name === "read_doc") return DOCS[String(args?.file)];
    if (name === "assistant_chat") {
      const messages = args?.messages as { role: string; content: string }[];
      const system = messages[0].content;
      calls.push(system);
      if (system.includes("TABLE OF CONTENTS")) return '{"chapters": ["adjustments/black-and-white.md"]}';
      if (system.includes("into a guided tour")) return tourReply;
      const q = messages[messages.length - 1].content;
      return q.includes("simulate infrared") ? ANSWERS.infrared : q.includes("What is a Treatment") ? ANSWERS.what : ANSWERS.bw;
    }
    return null;
  });
  setAssistantConfig(READY);
});

afterEach(() => {
  cleanup();
  delete (window as any).__TAURI_INTERNALS__;
  invoke.mockReset();
  resetToursForTests();
  _resetAssistantChatForTests();
});

const tourCalls = () => calls.filter((c) => c.includes("into a guided tour")).length;

/** A question asked, waited out to its answer. */
async function say(q: string) {
  const before = chatSnapshot().turns.length;
  act(() => askAssistant(q));
  await vi.waitFor(() => {
    expect(chatSnapshot().busy).toBe(false);
    expect(chatSnapshot().turns.length).toBeGreaterThan(before + 1);
  });
  return chatSnapshot().turns[chatSnapshot().turns.length - 1];
}

/** The main window's walk, over the real reducer, in Develop. */
function host() {
  let s: State = initialState();
  setTourHost({ getState: () => s, dispatch: (c) => { s = reduce(s, c); } });
}

describe("the replies Heeler reads itself", () => {
  it("yes, no and show me, short replies only", () => {
    for (const y of ["yes", "Yes!", "sure", "ok", "Okay.", "show me", "please", "yes please", "Sure, thanks", "go ahead", "yeah", "Let’s do it"]) expect(isYes(y), y).toBe(true);
    for (const n of ["no", "yes I want to know how to crop a photo to a square", "How do I crop?", "thanks", "", "maybe"]) expect(isYes(n), n).toBe(false);
    for (const n of ["no", "No thanks.", "nope", "not now", "maybe later", "no, thank you"]) expect(isNo(n), n).toBe(true);
    for (const y of ["yes", "no I meant the Grain section, how do I add grain", "know"]) expect(isNo(y), y).toBe(false);
    for (const s of ["show me", "Can you show me?", "give me a tour", "please show me"]) expect(isShowRequest(s), s).toBe(true);
    for (const s of ["yes", "show me how to crop a photograph to a square", "ok"]) expect(isShowRequest(s), s).toBe(false);
  });
});

describe("the offer, after every answer", () => {
  it("ends an answer with directions with the offer, and makes nothing before yes", async () => {
    render(<AssistantTab />);
    const t = await say("How do I make a photo black and white?");
    expect(t.tour).toBe("offered");
    expect(pendingOffer()).toBe(1);
    expect(screen.getByTestId("assistant-offer-line")).toHaveTextContent(OFFER_LINE);
    expect(screen.getByTestId("assistant-show-me")).toBeInTheDocument();
    expect(tourCalls()).toBe(0);
  });

  it("offers again after a follow-up, and yes to it makes that tour and walks it", async () => {
    host();
    await say("How do I make a photo black and white?");
    const t = await say("how do I simulate infrared?");
    expect(t.tour).toBe("offered");
    expect(tourCalls()).toBe(0);
    render(<AssistantTab />);
    // Only the last answer's offer is pending: one offer line, and a
    // SHOW ME on each answer.
    expect(screen.getAllByTestId("assistant-offer-line")).toHaveLength(1);
    expect(screen.getAllByTestId("assistant-show-me")).toHaveLength(2);
    act(() => askAssistant("yes"));
    // The building state while the tour call runs.
    expect(chatSnapshot().turns[3].tour).toBe("building");
    expect(screen.getByTestId("assistant-tour-building")).toBeInTheDocument();
    await vi.waitFor(() => expect(chatSnapshot().busy).toBe(false));
    expect(tourCalls()).toBe(1);
    const made = chatSnapshot().turns[3].tour;
    expect(typeof made).toBe("object");
    // The tour made is of the follow-up, and it is walking.
    expect(calls[calls.length - 1]).toContain("into a guided tour");
    expect(currentWalk()?.tour).toEqual(made);
    // The yes shows as the user's turn, and no answer of the model's.
    expect(chatSnapshot().turns.map((x) => x.role)).toEqual(["user", "assistant", "user", "assistant", "user"]);
    expect(pendingOffer()).toBeNull();
  });

  it("no declines the offer: a reply of Heeler's own, no tour made, and a later yes is a question", async () => {
    await say("How do I make a photo black and white?");
    const t = await say("no thanks");
    expect(t).toEqual({ role: "assistant", text: DECLINED_LINE, local: true });
    expect(pendingOffer()).toBeNull();
    expect(tourCalls()).toBe(0);
    const before = calls.length;
    await say("yes");
    // Asked of the model, as any question: the route and the answer.
    expect(calls.length).toBe(before + 2);
    expect(tourCalls()).toBe(0);
  });

  it("a new question clears the pending offer: its own answer is offered, and yes then takes that one", async () => {
    host();
    await say("How do I make a photo black and white?");
    await say("What is a Treatment?");
    // An answer with no directions: no offer, nothing pending.
    expect(chatSnapshot().turns[3].tour).toBeUndefined();
    expect(pendingOffer()).toBeNull();
    const before = calls.length;
    await say("yes");
    expect(calls.length).toBe(before + 2);
    expect(tourCalls()).toBe(0);
    expect(currentWalk()).toBeNull();
  });

  it("asking to be shown an answer with no directions says the sorry line, exactly", async () => {
    render(<AssistantTab />);
    await say("What is a Treatment?");
    expect(screen.queryByTestId("assistant-offer")).toBeNull();
    const t = await say("can you show me?");
    expect(t).toEqual({ role: "assistant", text: SORRY_LINE, local: true });
    expect(SORRY_LINE).toBe("I'm sorry, I can't give you a tour of this, but I can answer another question.");
    expect(tourCalls()).toBe(0);
    // Heeler's own line carries no warning about citing no chapter.
    expect(screen.queryByTestId("assistant-uncited")).toBeNull();
  });

  it("a tour that cannot be made answers yes with the sorry line, and the offer is gone", async () => {
    tourReply = '{"steps": [{"stop": "bw.magic", "say": "x"}]}';
    render(<AssistantTab />);
    await say("How do I make a photo black and white?");
    const t = await say("sure");
    expect(tourCalls()).toBe(1);
    expect(t).toEqual({ role: "assistant", text: SORRY_LINE, local: true });
    expect(chatSnapshot().turns[1].tour).toBe("none");
    expect(screen.queryByTestId("assistant-show-me")).toBeNull();
  });

  it("a graph plan that cannot be made whole answers yes with the sorry line, and no repair reaches the chat", async () => {
    // A Tone Profile the answer never names: dropped, and nothing is left.
    tourReply = '{"steps": [{"stop": "graph.add.tone_profile", "say": "Add a Tone Profile."}, {"stop": "graph.splice", "from": "node.tone_profile", "say": "Drop it on the wire."}]}';
    host();
    await say("How do I make a photo black and white?");
    const t = await say("yes");
    expect(tourCalls()).toBe(1);
    expect(t).toEqual({ role: "assistant", text: SORRY_LINE, local: true });
    expect(currentWalk()).toBeNull();
    for (const turn of chatSnapshot().turns) expect(turn.text).not.toMatch(/tour plan|dropped|Tone Profile/);
  });

  it("SHOW ME makes the tour as yes does, once: a second press walks the tour made", async () => {
    host();
    await say("How do I make a photo black and white?");
    act(() => showTour(1));
    await vi.waitFor(() => expect(chatSnapshot().busy).toBe(false));
    expect(tourCalls()).toBe(1);
    expect(typeof chatSnapshot().turns[1].tour).toBe("object");
    expect(currentWalk()).not.toBeNull();
    act(() => showTour(1));
    expect(tourCalls()).toBe(1);
  });
});
