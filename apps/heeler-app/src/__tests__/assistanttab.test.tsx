// The assistant, phase 1: the Console's Assistant tab, and Help
// answers that link their chapters. The Tauri invoke is mocked;
// nothing here reaches a server.

import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));

import {
  askGuide,
  assistantReady,
  citations,
  modelKey,
  resetAssistantConfigForTests,
  resetAssistantPhotoForTests,
  resetGuideForTests,
  setAssistantConfig,
  setAssistantPhoto,
  setPictureProvider,
} from "../assistant";
import { CMD_CHANNEL, setTransport, type Transport } from "../popout";
import { ConsolePanel } from "../ui/console";
import { _resetAssistantTabForTests, clearAssistantConversation } from "../ui/assistanttab";

type Handler = (args: Record<string, unknown> | undefined) => unknown;

/** The guided tour's call, which follows a how-to answer (src/tour.ts). */
const isTourCall = (args: Record<string, unknown> | undefined) =>
  ((args?.messages as { content: string }[] | undefined)?.[0]?.content ?? "").includes("into a guided tour");

/** Answers invoke by command name. The rest of the dialog asks its
 * own questions (the catalog update policy); those answer null. An
 * assistant command the test did not list rejects, so it is loud. */
function backend(handlers: Record<string, Handler>) {
  invoke.mockImplementation(async (name: string, args?: Record<string, unknown>) => {
    const h = handlers[name];
    if (!h) {
      if (name.startsWith("assistant_")) throw new Error(`unexpected command ${name}`);
      return null;
    }
    return h(args);
  });
}

beforeEach(() => {
  // The module mock answers bridge.ts; the internals answer the same
  // mock when @tauri-apps/api/core is reached by another module path
  // (a node_modules that is a link resolves to two ids).
  (window as any).__TAURI_INTERNALS__ = { invoke: (name: string, args?: Record<string, unknown>) => invoke(name, args) };
  resetAssistantConfigForTests();
  resetAssistantPhotoForTests();
  resetGuideForTests();
  _resetAssistantTabForTests();
});

afterEach(() => {
  cleanup();
  delete (window as any).__TAURI_INTERNALS__;
  invoke.mockReset();
  setTransport(null);
  setPictureProvider(null);
});

describe("the Console's Assistant tab", () => {
  const READY = { enabled: true, address: "http://localhost:1234", model: "m", validated: "http://localhost:1234" };

  // Free for questions (2026-09-28): the tab is there on a free copy
  // too; the reducer's tier gate is what refuses Pro changes.
  it("appears when on and saved with a validated address and model", () => {
    expect(assistantReady(READY)).toBe(true);
    expect(assistantReady({ ...READY, enabled: false })).toBe(false);
    expect(assistantReady({ ...READY, model: "" })).toBe(false);
    // An address edited after Validate waits for the next Validate.
    expect(assistantReady({ ...READY, address: "http://localhost:11434" })).toBe(false);

    backend({ assistant_validate: () => ({ kind: "connected", address: "127.0.0.1:1234", models: [{ id: "m", tested: false }] }) });
    render(<ConsolePanel open windowed dispatch={() => {}} />);
    expect(screen.queryByTestId("console-tab-assistant")).toBeNull();
    act(() => setAssistantConfig(READY));
    expect(screen.getByTestId("console-tab-assistant")).toBeInTheDocument();
  });

  it("stays, and says so, when the server has gone away", async () => {
    const sent: unknown[] = [];
    setTransport({ send: (ch, p) => { if (ch === CMD_CHANNEL) sent.push(p); }, subscribe: () => () => {} } as Transport);
    backend({ assistant_validate: () => ({ kind: "nothingAnswering", address: "127.0.0.1:1234" }) });
    setAssistantConfig(READY);
    render(<ConsolePanel open windowed dispatch={() => {}} />);
    fireEvent.click(screen.getByTestId("console-tab-assistant"));
    const offline = await screen.findByTestId("assistant-offline");
    expect(offline).toHaveTextContent("Not connected. Nothing answers at 127.0.0.1:1234");
    fireEvent.click(screen.getByTestId("assistant-open-prefs"));
    expect(sent).toEqual([{ type: "open_prefs", landing: "assistant-server" }]);
  });

  const DOCS: Record<string, string> = {
    "README.md": "# Heeler user guide\n\n1. [Export](export.md)\n",
    "export.md": "# Export\n\n![Export](assets/x.png)\n\nQuick Export writes one JPEG of the photograph on screen.\n\n## Size\n\nLong edge in pixels.\n",
    "library.md": "# Library\n\nFolders and collections.\n",
    "adjustments/sky-rescue.md": "# Sky Rescue\n\nSky Rescue identifies bright sky-like tones and applies highlight recovery.\n\n## Controls\n\n- **Recovery** pulls the selected highlights back.\n",
    "adjustments/black-and-white.md": "# Black and White\n\nThe sky, the sky, the sky: a red filter darkens a blue sky in mono.\n",
  };
  const docsBackend = {
    list_docs: () => Object.keys(DOCS).map((file) => ({ file, title: DOCS[file].split("\n")[0].slice(2) })),
    read_doc: (args: Record<string, unknown> | undefined) => DOCS[String(args?.file)],
  };

  it("answers in two calls: chapters from the table of contents, then the answer, with the chapter linked", async () => {
    const sent: unknown[] = [];
    setTransport({ send: (ch, p) => { if (ch === CMD_CHANNEL) sent.push(p); }, subscribe: () => () => {} } as Transport);
    const calls: { messages: { role: string; content: string }[]; temperature?: number }[] = [];
    backend({
      assistant_validate: () => ({ kind: "connected", address: "127.0.0.1:1234", models: [{ id: "m", tested: false }] }),
      assistant_context_length: () => null,
      ...docsBackend,
      assistant_chat: (args) => {
        expect(args?.address).toBe("http://localhost:1234");
        expect(args?.model).toBe("m");
        if (isTourCall(args)) return '{"steps": []}';
        calls.push({ messages: args?.messages as never, temperature: args?.temperature as number | undefined });
        if (calls.length === 1) return '```json\n{"chapters": ["export.md"]}\n```';
        return "Use **Quick Export** in the title bar:\n\n1. Pick a photograph.\n2. Press *Quick Export*.\n\nSources: export.md";
      },
    });
    setAssistantConfig(READY);
    setAssistantPhoto({ fileType: "RW2", mono: false, develop: ["Exposure"], finish: [] });
    render(<ConsolePanel open windowed dispatch={() => {}} />);
    fireEvent.click(screen.getByTestId("console-tab-assistant"));
    expect(screen.getByTestId("assistant-intro")).toHaveTextContent("Answers come from the user guide");
    fireEvent.change(screen.getByTestId("assistant-input"), { target: { value: "How do I export a JPEG?" } });
    fireEvent.click(screen.getByTestId("assistant-ask"));
    const cite = await screen.findByTestId("assistant-cite");
    expect(cite).toHaveAttribute("data-file", "export.md");
    expect(cite).toHaveTextContent("Export");

    // The first call: the table of contents and the photograph's facts,
    // at temperature 0, asking for JSON.
    expect(calls).toHaveLength(2);
    const route = calls[0];
    expect(route.temperature).toBe(0);
    expect(route.messages[0].content).toContain("TABLE OF CONTENTS");
    expect(route.messages[0].content).toContain("adjustments/sky-rescue.md: identifies bright sky-like tones");
    expect(route.messages[0].content).toContain("File type: RW2");
    // A line per chapter, never a chapter's body.
    expect(route.messages[0].content).not.toContain("Long edge in pixels");
    expect(route.messages[1]).toEqual({ role: "user", content: "Question: How do I export a JPEG?" });

    // The second: the chosen chapter first, as data, screenshots left
    // out, with the facts; then the question.
    const answer = calls[1].messages;
    expect(answer[0].role).toBe("system");
    expect(answer[0].content).toContain("Color: in color");
    expect(answer[0].content.indexOf("--- CHAPTER export.md (Export) ---")).toBeGreaterThan(0);
    expect(answer[0].content).toContain("Quick Export writes one JPEG");
    expect(answer[0].content).not.toContain("assets/x.png");
    expect(answer[answer.length - 1]).toEqual({ role: "user", content: "How do I export a JPEG?" });

    // Displayed as markdown, without the Sources line (the link says it).
    const shown = screen.getByTestId("assistant-answer");
    expect(shown.querySelector("strong")).toHaveTextContent("Quick Export");
    expect(shown.querySelectorAll("ol li")).toHaveLength(2);
    expect(shown).not.toHaveTextContent("Sources:");
    expect(shown).not.toHaveTextContent("**");
    fireEvent.click(cite);
    expect(sent).toEqual([{ type: "open_docs", file: "export.md" }]);
    // Clear starts over; nothing was kept anywhere else.
    fireEvent.click(screen.getByTestId("assistant-clear"));
    expect(screen.queryByTestId("assistant-turn-assistant")).toBeNull();
  });

  // 2026-09-28: "capturing luma and color stats about the image
  // (histogram data) to send to LM Studio would help out a lot".
  it("measures the picture when a question is asked, and sends the report with the answer call only", async () => {
    const calls: string[] = [];
    let measured = 0;
    backend({
      assistant_validate: () => ({ kind: "connected", address: "127.0.0.1:1234", models: [{ id: "m", tested: false }] }),
      assistant_context_length: () => null,
      ...docsBackend,
      assistant_chat: (args) => {
        calls.push((args?.messages as { content: string }[])[0].content);
        return calls.length % 2 === 1 ? '{"chapters": ["export.md"]}' : "Quick Export.\nSources: export.md";
      },
    });
    setPictureProvider(async () => {
      measured++;
      return "THE PICTURE, MEASURED (test)\nMean brightness -1.2 EV";
    });
    setAssistantConfig(READY);
    setAssistantPhoto({ fileType: "RW2", mono: false, develop: ["Exposure"], finish: [] });
    render(<ConsolePanel open windowed dispatch={() => {}} />);
    fireEvent.click(screen.getByTestId("console-tab-assistant"));
    // Nothing is measured until a question is asked.
    expect(measured).toBe(0);
    fireEvent.change(screen.getByTestId("assistant-input"), { target: { value: "Is my photo underexposed?" } });
    fireEvent.click(screen.getByTestId("assistant-ask"));
    await screen.findByTestId("assistant-answer");
    expect(measured).toBe(1);
    expect(calls[0]).not.toContain("THE PICTURE, MEASURED");
    expect(calls[1]).toContain("THE PICTURE, MEASURED (test)\nMean brightness -1.2 EV");
    expect(calls[1]).toContain("and the numbers under THE PICTURE, MEASURED");
    expect(calls[1]).toContain("never claim to see what they cannot show");
    // With no photograph open, nothing is measured or sent.
    act(() => setAssistantPhoto(null));
    fireEvent.change(screen.getByTestId("assistant-input"), { target: { value: "How do I export?" } });
    fireEvent.click(screen.getByTestId("assistant-ask"));
    await vi.waitFor(() => expect(screen.getAllByTestId("assistant-answer")).toHaveLength(2));
    expect(measured).toBe(1);
    expect(calls[3]).not.toContain("THE PICTURE, MEASURED");
  });

  // 2026-09-28: Florence-2, running inside Heeler, is the
  // assistant's vision.
  it("sends Florence-2's description with the answer call only, with the question, and the caveat", async () => {
    const calls: string[] = [];
    const questions: string[] = [];
    backend({
      assistant_validate: () => ({ kind: "connected", address: "127.0.0.1:1234", models: [{ id: "m", tested: false }] }),
      assistant_context_length: () => null,
      ...docsBackend,
      assistant_chat: (args) => {
        calls.push((args?.messages as { content: string }[])[0].content);
        return calls.length % 2 === 1 ? '{"chapters": ["export.md"]}' : "Use Smart Selection.\nSources: export.md";
      },
    });
    setPictureProvider(async (question) => {
      questions.push(question);
      return { report: "THE PICTURE, MEASURED (test)", vision: "WHAT IS IN THE PICTURE (test)\nDescription: a cat on hay.", florence: "ok" };
    });
    setAssistantConfig(READY);
    setAssistantPhoto({ fileType: "JPG", mono: false, develop: [], finish: [] });
    render(<ConsolePanel open windowed dispatch={() => {}} />);
    fireEvent.click(screen.getByTestId("console-tab-assistant"));
    fireEvent.change(screen.getByTestId("assistant-input"), { target: { value: "Select this cheetah's face?" } });
    fireEvent.click(screen.getByTestId("assistant-ask"));
    await screen.findByTestId("assistant-answer");
    expect(questions).toEqual(["Select this cheetah's face?"]);
    expect(calls[0]).not.toContain("WHAT IS IN THE PICTURE");
    expect(calls[1]).toContain("WHAT IS IN THE PICTURE (test)\nDescription: a cat on hay.");
    expect(calls[1]).toContain("it has called a cheetah a leopard and a serval");
    expect(calls[1]).toContain("a description, not sight");
    // Installed: no hint.
    expect(screen.queryByTestId("assistant-vision-hint")).toBeNull();
  });

  it("adds nothing when Florence-2 is not installed, and says once where to get it", async () => {
    const calls: string[] = [];
    const sent: unknown[] = [];
    setTransport({ send: (ch, p) => { if (ch === CMD_CHANNEL) sent.push(p); }, subscribe: () => () => {} } as Transport);
    backend({
      assistant_validate: () => ({ kind: "connected", address: "127.0.0.1:1234", models: [{ id: "m", tested: false }] }),
      assistant_context_length: () => null,
      ...docsBackend,
      assistant_chat: (args) => {
        calls.push((args?.messages as { content: string }[])[0].content);
        return calls.length % 2 === 1 ? '{"chapters": ["export.md"]}' : "Quick Export.\nSources: export.md";
      },
    });
    setPictureProvider(async () => ({ report: "THE PICTURE, MEASURED (test)", vision: null, florence: "missing" }));
    setAssistantConfig(READY);
    setAssistantPhoto({ fileType: "JPG", mono: false, develop: [], finish: [] });
    render(<ConsolePanel open windowed dispatch={() => {}} />);
    fireEvent.click(screen.getByTestId("console-tab-assistant"));
    const ask = async (q: string, answers: number) => {
      fireEvent.change(screen.getByTestId("assistant-input"), { target: { value: q } });
      fireEvent.click(screen.getByTestId("assistant-ask"));
      await vi.waitFor(() => expect(screen.getAllByTestId("assistant-answer")).toHaveLength(answers));
    };
    expect(screen.queryByTestId("assistant-vision-hint")).toBeNull();
    await ask("What should I fix?", 1);
    expect(calls[1]).toContain("THE PICTURE, MEASURED (test)");
    expect(calls[1]).not.toContain("WHAT IS IN THE PICTURE");
    expect(calls[1]).toContain("You cannot see the photograph: you know only the facts");
    // One line, not a dialog, with the way to Preferences.
    const hint = screen.getByTestId("assistant-vision-hint");
    expect(hint).toHaveTextContent("Let the assistant know what is in your photograph: the Florence-2 download in Preferences > Assistant");
    expect(screen.queryByRole("dialog")).toBeNull();
    fireEvent.click(screen.getByTestId("assistant-vision-hint-open"));
    expect(sent).toEqual([{ type: "open_prefs", landing: "assistant-florence" }]);
    // It stays through the next question, not twice.
    await ask("And the shadows?", 2);
    expect(screen.getAllByTestId("assistant-vision-hint")).toHaveLength(1);
    // Dismissed, it is not shown again this session, nor after a clear.
    fireEvent.click(screen.getByTestId("assistant-vision-hint-dismiss"));
    expect(screen.queryByTestId("assistant-vision-hint")).toBeNull();
    await ask("And the sky?", 3);
    expect(screen.queryByTestId("assistant-vision-hint")).toBeNull();
    act(() => clearAssistantConversation());
    await ask("What should I fix?", 1);
    expect(screen.queryByTestId("assistant-vision-hint")).toBeNull();
  });

  it("falls back to the local ranking when the first reply is not JSON", async () => {
    const calls: { role: string; content: string }[][] = [];
    backend({
      ...docsBackend,
      assistant_chat: (args) => {
        calls.push(args?.messages as never);
        return calls.length === 1 ? "I would look at {the Sky Rescue chapter" : "Sky Rescue.\nSources: adjustments/sky-rescue.md";
      },
    });
    const r = await askGuide({
      address: "http://localhost:1234",
      model: "m",
      question: "How can I darken the sky?",
      history: [],
      facts: { fileType: "JPG", mono: false, develop: [], finish: [] },
      contextTokens: null,
    });
    expect(r.routed).toBe(false);
    expect(calls).toHaveLength(2);
    // The ranking chose (what it chooses over the real guide is the
    // question set's test, assistantguide.test.tsx), and its choice
    // went with the question.
    expect(r.material.chosen.length).toBeGreaterThan(0);
    expect(r.material.chosen).toContain("adjustments/sky-rescue.md");
    expect(calls[1][0].content).toContain(`--- CHAPTER ${r.material.chosen[0]} (`);
    expect(r.reply).toContain("Sky Rescue");
  });

  it("falls back as well when the first reply names no real chapter, and when the first call fails", async () => {
    let n = 0;
    backend({
      ...docsBackend,
      assistant_chat: () => {
        n++;
        if (n === 1) return '{"chapters": ["made-up.md"]}';
        if (n === 3) throw "The server refused the question (HTTP 500)";
        return "Answer. Sources: export.md";
      },
    });
    const ask = () => askGuide({ address: "http://localhost:1234", model: "m", question: "export a JPEG", history: [], facts: null, contextTokens: null });
    const a = await ask();
    expect(a.routed).toBe(false);
    expect(a.material.chosen).toContain("export.md");
    const b = await ask();
    expect(b.routed).toBe(false);
    expect(b.reply).toBe("Answer. Sources: export.md");
  });

  it("uses a larger context when the server reports one, and asks again at the default size if refused", async () => {
    const sizes: number[] = [];
    let answers = 0;
    backend({
      ...docsBackend,
      assistant_chat: (args) => {
        const m = args?.messages as { role: string; content: string }[];
        if (m[0].content.includes("TABLE OF CONTENTS")) return '{"chapters": ["adjustments/sky-rescue.md"]}';
        sizes.push(m[0].content.length);
        answers++;
        if (answers === 1) throw "The server refused the question (HTTP 400): context length exceeded";
        return "Sky Rescue. Sources: adjustments/sky-rescue.md";
      },
    });
    const r = await askGuide({ address: "http://localhost:1234", model: "m", question: "darken the sky", history: [], facts: null, contextTokens: 8192 });
    expect(r.routed).toBe(true);
    expect(answers).toBe(2);
    // The same material both times here: the fixture guide is smaller
    // than either budget (the budgets are budgetFor's test).
    expect(sizes).toHaveLength(2);
    expect(r.reply).toContain("Sky Rescue");
  });

  it("says why a question went unanswered", async () => {
    backend({
      assistant_validate: () => ({ kind: "connected", address: "127.0.0.1:1234", models: [{ id: "m", tested: false }] }),
      list_docs: () => [],
      assistant_chat: () => { throw "The server refused the question (HTTP 400): No model loaded"; },
    });
    setAssistantConfig(READY);
    render(<ConsolePanel open windowed dispatch={() => {}} />);
    fireEvent.click(screen.getByTestId("console-tab-assistant"));
    fireEvent.change(screen.getByTestId("assistant-input"), { target: { value: "Where is crop?" } });
    fireEvent.keyDown(screen.getByTestId("assistant-input"), { key: "Enter" });
    expect(await screen.findByTestId("assistant-turn-error")).toHaveTextContent("No model loaded");
  });
});

describe("the citations", () => {
  it("reads the chapters a reply names, and only real ones", () => {
    const known = new Set(["export.md", "adjustments/curves.md"]);
    const r = citations("Try Curves (adjustments/curves.md).\nSources: export.md, made-up.md", known);
    expect(r.files).toEqual(["adjustments/curves.md", "export.md"]);
    expect(r.text).toBe("Try Curves (adjustments/curves.md).");
  });

  it("matches model names as the Rust side does", () => {
    expect(modelKey("Qwen3-VL-4B-Instruct@q4_k_m")).toBe("qwen3-vl-4b-instruct");
    expect(modelKey("moondream2:q8_0")).toBe("moondream2");
    expect(modelKey("smolvlm2-2.2b-instruct-mlx-4bit")).toBe("smolvlm2-2.2b-instruct");
    expect(modelKey("qwen3-vl-2b")).not.toBe(modelKey("qwen3-vl-4b"));
  });
});

