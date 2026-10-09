// Every link the assistant offers opens the Help viewer in the MAIN
// window, over the transport, and nothing navigates a webview
// (2026-09-28: "I lost the console after I click to learn about
// exposure next ... When I clicked the button to learn more in the user
// guide, the guide didn't open"). The chapter links under an answer and
// the Learn more buttons in the Console send open_docs; a Learn more
// question goes into the conversation; the main window's end card opens
// the chapter there, and a question there is answered in the Console,
// which is opened or brought forward. No anchor anywhere, and the
// page's location never moves.

import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));

import { resetAssistantConfigForTests, resetGuideForTests, setAssistantConfig } from "../assistant";
import { chatSnapshot, _resetAssistantChatForTests, _seedForTests } from "../assistantchat";
import { initialState } from "../data";
import { CMD_CHANNEL, RAISING_COMMANDS, openConsoleWindow, raiseThisWindow, setTransport, type Transport } from "../popout";
import { reduce, type Command, type State } from "../state";
import { resetToursForTests, setTourHost, startTourHere, tourStop, type Tour } from "../tourwalk";
import { ConsolePanel } from "../ui/console";
import { TourOverlay } from "../ui/touroverlay";

const READY = { enabled: true, address: "http://localhost:1234", model: "m", validated: "http://localhost:1234" };

const TOUR: Tour = {
  id: "t-links",
  question: "How do I make a photo black and white?",
  steps: [{ stop: "mode.develop", say: "Go to Develop." }],
  followUps: [
    { label: "How Black and White works", kind: "help", file: "adjustments/black-and-white.md" },
    { label: "Exposure", kind: "ask", question: "How do I use Exposure?" },
  ],
};

let sent: { ch: string; p: any }[] = [];

beforeEach(() => {
  (window as any).__TAURI_INTERNALS__ = { invoke: (name: string, args?: Record<string, unknown>) => invoke(name, args) };
  invoke.mockImplementation(async (name: string) => {
    if (name === "assistant_validate") return { kind: "connected", address: "127.0.0.1:1234", models: [{ id: "m", tested: false }] };
    if (name === "list_docs") return [];
    // The model is slow: a question asked here stays asked.
    if (name === "assistant_chat") return new Promise(() => {});
    return null;
  });
  sent = [];
  setTransport({ send: (ch, p) => sent.push({ ch, p }), subscribe: () => () => {} } as Transport);
  resetAssistantConfigForTests();
  resetGuideForTests();
  _resetAssistantChatForTests();
  setAssistantConfig(READY);
});

afterEach(() => {
  cleanup();
  delete (window as any).__TAURI_INTERNALS__;
  invoke.mockReset();
  setTransport(null);
  resetToursForTests();
  _resetAssistantChatForTests();
  vi.restoreAllMocks();
});

/** A click the way a user makes one, with its default action free to
 * run (an anchor's would be a navigation): the page's location must
 * not move. */
function click(el: HTMLElement): void {
  const before = window.location.href;
  act(() => {
    el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  });
  expect(window.location.href).toBe(before);
}

describe("the Console's links", () => {
  it("chapter links and Learn more open Help in the main window, a Learn more question is asked here, and nothing navigates", () => {
    _seedForTests(
      [
        { role: "user", text: "How do I make a photo black and white?" },
        {
          role: "assistant",
          // A model's own link and markup stay text: no anchor is made.
          text: "Set **Treatment**. See [Exposure](adjustments/exposure.md) or <a href=\"https://example.com\">this</a>.",
          cites: [{ file: "adjustments/black-and-white.md", title: "Black and White" }],
          tour: TOUR,
        },
      ],
      { [TOUR.id]: "finished" },
    );
    const { container } = render(<ConsolePanel open windowed dispatch={() => {}} />);
    fireEvent.click(screen.getByTestId("console-tab-assistant"));
    expect(container.querySelectorAll("a")).toHaveLength(0);
    // Plain buttons, never a submit that a form around them could turn
    // into a page load.
    const tab = screen.getByTestId("assistant-output");
    for (const b of Array.from(tab.querySelectorAll("button"))) expect(b.type).toBe("button");

    click(screen.getByTestId("assistant-cite"));
    click(screen.getByTestId("assistant-follow-0"));
    const cmds = sent.filter((m) => m.ch === CMD_CHANNEL).map((m) => m.p);
    expect(cmds).toEqual([
      { type: "open_docs", file: "adjustments/black-and-white.md" },
      { type: "open_docs", file: "adjustments/black-and-white.md" },
    ]);
    // Help commands bring the main window forward when they arrive.
    for (const c of cmds) expect(RAISING_COMMANDS.has(c.type)).toBe(true);

    click(screen.getByTestId("assistant-follow-1"));
    expect(chatSnapshot().turns[2]).toEqual({ role: "user", text: "How do I use Exposure?" });
    expect(screen.getAllByTestId("assistant-turn-user")[1]).toHaveTextContent("How do I use Exposure?");
    // The Console is still here, whole.
    expect(screen.getByTestId("console-panel")).toBeInTheDocument();
    expect(container.querySelectorAll("a")).toHaveLength(0);
  });
});

describe("the tour's end card in the main window", () => {
  function ended(consoleWindowOpen: boolean) {
    let s: State = { ...reduce(initialState(), { type: "set_mode", mode: "advanced" }), consoleWindowOpen };
    const dispatched: Command[] = [];
    const dispatch = (c: Command) => {
      dispatched.push(c);
      s = reduce(s, c);
    };
    setTourHost({ getState: () => s, dispatch });
    act(() => {
      startTourHere(TOUR);
    });
    const view = render(<TourOverlay state={s} dispatch={dispatch} />);
    act(() => tourStop());
    return { dispatched, view };
  }

  it("Learn more opens the chapter here, and a question is asked into the conversation and the Console is opened for it", () => {
    const { dispatched, view } = ended(false);
    expect(screen.getByTestId("tour-end")).toHaveTextContent("Tour stopped.");
    expect(view.baseElement.querySelectorAll("[data-testid=tour-card] a")).toHaveLength(0);
    click(screen.getByTestId("tour-follow-0"));
    expect(dispatched).toContainEqual({ type: "open_docs", file: "adjustments/black-and-white.md" });
    // The card closes; ask again from a fresh end.
    cleanup();
    const second = ended(false);
    click(screen.getByTestId("tour-follow-1"));
    expect(chatSnapshot().turns[0]).toEqual({ role: "user", text: "How do I use Exposure?" });
    expect(chatSnapshot().reveal).toBe(true);
    expect(second.dispatched).toContainEqual({ type: "set_console_window", open: true });
    // Nothing went to another window to be asked: the conversation is
    // this window's.
    expect(sent.some((m) => m.ch === "heeler:tour-ask")).toBe(false);
  });
});

describe("windows come forward, and are never loaded again", () => {
  it("an open Console is raised, not opened a second time", async () => {
    const popup = { closed: false, focus: vi.fn(), close: vi.fn() } as unknown as Window;
    delete (window as any).__TAURI_INTERNALS__;
    const open = vi.spyOn(window, "open").mockReturnValue(popup);
    await openConsoleWindow();
    await openConsoleWindow();
    expect(open).toHaveBeenCalledTimes(1);
    expect((popup.focus as any).mock.calls.length).toBe(1);
  });

  it("the main window raises itself for Help and Preferences", () => {
    delete (window as any).__TAURI_INTERNALS__;
    const focus = vi.spyOn(window, "focus").mockImplementation(() => {});
    raiseThisWindow();
    expect(focus).toHaveBeenCalledTimes(1);
    expect([...RAISING_COMMANDS].sort()).toEqual(["open_docs", "open_prefs"]);
  });
});
