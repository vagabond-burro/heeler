// The assistant's conversation lives in the main window until Heeler
// quits (src/assistantchat.ts; 2026-09-28: "keeping a history of the
// chat until Heeler closes would be nice"). Each window is its own copy
// of the modules here (vi.resetModules between imports), joined by an
// in-memory transport that never echoes to the sender, the way the Tauri
// transport behaves: so closing a Console and opening another is a fresh
// page, as it is in the app. The invoke is mocked; nothing here reaches
// a server, and nothing is written anywhere.

import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));

import type { Transport } from "../popout";

const READY = { enabled: true, address: "http://localhost:1234", model: "m", validated: "http://localhost:1234" };
const DOCS: Record<string, string> = {
  "README.md": "# Heeler user guide\n\n1. [Export](export.md)\n",
  "export.md": "# Export\n\nQuick Export writes one JPEG of the photograph on screen.\n",
};

/** Windows joined by one bus; a window never hears its own sends. */
function bus() {
  const subs: { ch: string; fn: (p: unknown) => void; owner: string }[] = [];
  return (owner: string): Transport => ({
    send(ch, p) {
      const copy = p === undefined ? p : JSON.parse(JSON.stringify(p));
      for (const s of [...subs]) if (s.ch === ch && s.owner !== owner) s.fn(copy);
    },
    subscribe(ch, fn) {
      const e = { ch, fn, owner };
      subs.push(e);
      return () => {
        const i = subs.indexOf(e);
        if (i >= 0) subs.splice(i, 1);
      };
    },
  });
}

/** One window's copy of the modules. */
async function windowModules() {
  vi.resetModules();
  const chat = await import("../assistantchat");
  const assistant = await import("../assistant");
  const consoleUi = await import("../ui/console");
  assistant.setAssistantConfig(READY);
  return { chat, assistant, ConsolePanel: consoleUi.ConsolePanel };
}

const chats: { messages: { role: string; content: string }[] }[] = [];
const commands: string[] = [];
/** every model call's system prompt, in order */
const calls: string[] = [];

beforeEach(() => {
  (window as any).__TAURI_INTERNALS__ = { invoke: (name: string, args?: Record<string, unknown>) => invoke(name, args) };
  chats.length = 0;
  commands.length = 0;
  calls.length = 0;
  invoke.mockImplementation(async (name: string, args?: Record<string, unknown>) => {
    commands.push(name);
    if (name === "assistant_validate") return { kind: "connected", address: "127.0.0.1:1234", models: [{ id: "m", tested: false }] };
    if (name === "assistant_context_length") return null;
    if (name === "list_docs") return Object.keys(DOCS).map((file) => ({ file, title: DOCS[file].split("\n")[0].slice(2) }));
    if (name === "read_doc") return DOCS[String(args?.file)];
    if (name === "assistant_chat") {
      const messages = args?.messages as { role: string; content: string }[];
      calls.push(messages[0].content);
      if (messages[0].content.includes("TABLE OF CONTENTS")) return '{"chapters": ["export.md"]}';
      // A how-to's guided tour (src/tour.ts): none here.
      if (messages[0].content.includes("into a guided tour")) return '{"steps": []}';
      chats.push({ messages });
      return `Answer ${chats.length}: use **Quick Export**.\nSources: export.md`;
    }
    return null;
  });
});

afterEach(() => {
  cleanup();
  delete (window as any).__TAURI_INTERNALS__;
  invoke.mockReset();
});

async function askInConsole(q: string, answers: number) {
  fireEvent.change(screen.getByTestId("assistant-input"), { target: { value: q } });
  fireEvent.click(screen.getByTestId("assistant-ask"));
  await vi.waitFor(() => expect(screen.getAllByTestId("assistant-answer")).toHaveLength(answers));
}

describe("the conversation, kept in the main window", () => {
  it("survives the Console closing and a new one opening, continues the same history, and Clear empties both", async () => {
    const port = bus();
    const main = await windowModules();
    const offMain = main.chat.connectAssistantChat("main", port("main"));

    // The first Console: a question asked there is answered by the main
    // window, and both hold it.
    const first = await windowModules();
    const offFirst = first.chat.connectAssistantChat("console", port("console-1"));
    render(<first.ConsolePanel open windowed dispatch={() => {}} />);
    fireEvent.click(screen.getByTestId("console-tab-assistant"));
    await askInConsole("How do I export a JPEG?", 1);
    expect(screen.getByTestId("assistant-answer")).toHaveTextContent("Answer 1");
    expect(main.chat.chatSnapshot().turns.map((t) => t.role)).toEqual(["user", "assistant"]);

    // The Console closes: its page and its modules are gone.
    cleanup();
    offFirst();

    // A new Console opens: a fresh page, which asks and is sent the
    // conversation so far, chapter link and all, without asking again.
    const second = await windowModules();
    const offSecond = second.chat.connectAssistantChat("console", port("console-2"));
    render(<second.ConsolePanel open windowed dispatch={() => {}} />);
    fireEvent.click(screen.getByTestId("console-tab-assistant"));
    expect(screen.getByTestId("assistant-answer")).toHaveTextContent("Answer 1");
    expect(screen.getByTestId("assistant-cite")).toHaveAttribute("data-file", "export.md");
    expect(chats).toHaveLength(1);

    // A question asked now continues the same conversation: the model
    // is sent the first question and its answer.
    await askInConsole("And a TIFF?", 2);
    const history = chats[1].messages.map((m) => m.content);
    expect(history).toContain("How do I export a JPEG?");
    expect(history.some((c) => c.startsWith("Answer 1"))).toBe(true);
    expect(history[history.length - 1]).toBe("And a TIFF?");

    // Clear, in the Console: both windows are empty.
    act(() => {
      fireEvent.click(screen.getByTestId("assistant-clear"));
    });
    expect(main.chat.chatSnapshot().turns).toEqual([]);
    expect(second.chat.chatSnapshot().turns).toEqual([]);
    expect(screen.queryByTestId("assistant-answer")).toBeNull();

    // And the next question starts a new history.
    await askInConsole("How do I export?", 1);
    expect(chats[2].messages.map((m) => m.content)).not.toContain("How do I export a JPEG?");

    // Nothing was written anywhere: only reads and the model.
    for (const c of commands) expect(["assistant_validate", "assistant_context_length", "list_docs", "read_doc", "assistant_chat"]).toContain(c);
    offSecond();
    offMain();
  });

  it("reads where the user is in the main window when a question is asked from the Console, and every call says it", async () => {
    const port = bus();
    const main = await windowModules();
    const tour = await import("../tour");
    const offMain = main.chat.connectAssistantChat("main", port("main"));
    let where: import("../assistant").WhereFacts = { workspace: "Graph", selected: [{ kind: "Curves", type: "heeler.curves" }] };
    main.assistant.setWhereProvider(() => where);
    const con = await windowModules();
    const offCon = con.chat.connectAssistantChat("console", port("console"));
    render(<con.ConsolePanel open windowed dispatch={() => {}} />);
    fireEvent.click(screen.getByTestId("console-tab-assistant"));
    await askInConsole("How do I export a JPEG?", 1);
    await vi.waitFor(() => expect(main.chat.chatSnapshot().busy).toBe(false));
    // The tour is made when asked for, still read where the user was.
    expect(calls).toHaveLength(2);
    fireEvent.click(screen.getByTestId("assistant-show-me"));
    await vi.waitFor(() => expect(calls).toHaveLength(3));
    await vi.waitFor(() => expect(main.chat.chatSnapshot().busy).toBe(false));
    const [route, answer, tourCall] = calls;
    expect(route).toContain(main.assistant.ROUTE_GRAPH);
    expect(route).toContain("Selected in the graph: Curves (heeler.curves)");
    expect(answer).toContain(main.assistant.WHERE_ANSWER.Graph);
    expect(answer).toContain("Selected node: Curves (heeler.curves, in the menus Color > Tone > Curves)");
    expect(tourCall).toContain(tour.TOUR_WHERE.Graph);
    // Moved to Develop: the next question is read there, at its asking.
    where = { workspace: "Develop", tab: "Adjustments", layer: "Base (the whole photograph)" };
    calls.length = 0;
    // Two answers so far: the first, and the sorry line for its tour
    // (the model made none here).
    await askInConsole("How do I export a PNG?", 3);
    await vi.waitFor(() => expect(main.chat.chatSnapshot().busy).toBe(false));
    fireEvent.click(screen.getByTestId("assistant-show-me"));
    await vi.waitFor(() => expect(calls).toHaveLength(3));
    expect(calls[0]).toContain(main.assistant.ROUTE_DEVELOP);
    expect(calls[1]).toContain("Right panel tab: Adjustments");
    expect(calls[1]).toContain(main.assistant.WHERE_ANSWER.Develop);
    expect(calls[2]).toContain(tour.TOUR_WHERE.Develop);
    main.assistant.setWhereProvider(null);
    offCon();
    offMain();
  });

  it("asks from the main window into the same conversation, and the Console shows the Assistant tab for it", async () => {
    const port = bus();
    const main = await windowModules();
    const offMain = main.chat.connectAssistantChat("main", port("main"));
    const con = await windowModules();
    const offCon = con.chat.connectAssistantChat("console", port("console"));
    render(<con.ConsolePanel open windowed dispatch={() => {}} />);
    // The Console is on its Log tab.
    expect(screen.queryByTestId("assistant-output")).toBeNull();
    act(() => main.chat.askAndReveal("How do I use Exposure?", "(Asked right after the guided tour.)"));
    // The tab switches to the Assistant, and the question is there as
    // typed; the model reads it with the tour's context.
    expect(await screen.findByTestId("assistant-output")).toBeInTheDocument();
    await vi.waitFor(() => expect(screen.getAllByTestId("assistant-answer")).toHaveLength(1));
    expect(screen.getByTestId("assistant-turn-user")).toHaveTextContent("How do I use Exposure?");
    expect(screen.getByTestId("assistant-turn-user")).not.toHaveTextContent("guided tour");
    const last = chats[0].messages[chats[0].messages.length - 1].content;
    expect(last).toContain("How do I use Exposure?");
    expect(last).toContain("(Asked right after the guided tour.)");
    // Seen: the main window stops asking for the tab.
    expect(main.chat.chatSnapshot().reveal).toBe(false);
    offCon();
    offMain();
  });

  it("counts a tour's steps in the Console as the walk does: the steps already done when it starts left out ('it still read 8 steps')", async () => {
    const port = bus();
    const main = await windowModules();
    const walk = await import("../tourwalk");
    const overlay = await import("../ui/touroverlay");
    const offMain = main.chat.connectAssistantChat("main", port("main"));
    const offToursMain = walk.connectTours("main", port("main-tours"));
    // Seven steps as the model wrote them; the first two (Develop,
    // Adjustments) are where the user already is.
    const tour = {
      id: "t7",
      question: "How do I make it black and white?",
      steps: [
        { stop: "mode.develop", say: "Go to Develop." },
        { stop: "tab.adjust", say: "Open Adjustments." },
        { stop: "section.color", say: "Open the Color section." },
        { stop: "bw.treatment", say: "Choose black and white." },
        { stop: "bw.mix.red", say: "Raise Red." },
        { stop: "bw.mix.green", say: "Lower Green." },
        { stop: "bw.mix.blue", say: "Lower Blue." },
      ],
      followUps: [],
    };
    main.chat._seedForTests([{ role: "assistant", text: "Answer.", cites: [], tour }]);
    const data = await import("../data");
    const state = await import("../state");
    let s = state.reduce(data.initialState(), { type: "close_sections", titles: ["Color"] });
    walk.setTourHost({ getState: () => s, dispatch: (c) => { s = state.reduce(s, c); } });

    const con = await windowModules();
    const conWalk = await import("../tourwalk");
    const offCon = con.chat.connectAssistantChat("console", port("console"));
    const offToursCon = conWalk.connectTours("console", port("console-tours"));
    render(<con.ConsolePanel open windowed dispatch={() => {}} />);
    fireEvent.click(screen.getByTestId("console-tab-assistant"));
    // Before it starts, no number: which steps are done is decided when
    // it starts, in the main window.
    expect(screen.getByTestId("assistant-tour")).not.toHaveTextContent(/\d+ steps?/);
    act(() => fireEvent.click(screen.getByTestId("assistant-show-me")));
    render(<overlay.TourOverlay state={s} dispatch={() => {}} />);
    expect(screen.getByTestId("tour-count")).toHaveTextContent("STEP 1 OF 5");
    await vi.waitFor(() => expect(screen.getByTestId("assistant-tour")).toHaveTextContent("The tour is running in the main window, 5 steps."));
    expect(main.chat.chatSnapshot().tourSteps.t7).toBe(5);
    offToursCon();
    offCon();
    offToursMain();
    offMain();
    walk.resetToursForTests();
  });

  it("keeps a tour's end with the conversation, so a Console opened afterwards still offers Learn more", async () => {
    const port = bus();
    const main = await windowModules();
    const walk = await import("../tourwalk");
    const offMain = main.chat.connectAssistantChat("main", port("main"));
    // A tour, as the conversation holds it, walked here and stopped.
    const tour = { id: "t9", question: "q", steps: [{ stop: "mode.develop", say: "Go to Develop." }], followUps: [{ label: "How Workspaces works", kind: "help" as const, file: "workspaces.md" }] };
    main.chat._seedForTests([{ role: "assistant", text: "Answer.", cites: [], tour }]);
    const data = await import("../data");
    const state = await import("../state");
    let s = state.reduce(data.initialState(), { type: "set_mode", mode: "advanced" });
    walk.setTourHost({ getState: () => s, dispatch: (c) => { s = state.reduce(s, c); } });
    walk.startTourHere(tour);
    walk.tourStop();
    expect(main.chat.chatSnapshot().tours.t9).toBe("stopped");

    const con = await windowModules();
    const offCon = con.chat.connectAssistantChat("console", port("console"));
    render(<con.ConsolePanel open windowed dispatch={() => {}} />);
    fireEvent.click(screen.getByTestId("console-tab-assistant"));
    expect(screen.getByTestId("assistant-learn-more")).toHaveTextContent("How Workspaces works");
    offCon();
    offMain();
    walk.resetToursForTests();
  });
});
