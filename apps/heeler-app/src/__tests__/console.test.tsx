// The Console's Python tab: a scratchboard editor over the scripting
// bridge.
//
// The owner, across three messages: a Python console with output on
// top and input below; then "the lower half should be more of a
// scratchboard where someone can write functions and loops. They
// should highlight the code the wish to run and press CTRL+ENTER";
// then 3D-package style tabs, loading scripts into tabs, saving back
// to disk, and crash-safe persistence of the text. Plus "IDE style
// coloring".
//
// The mock bridge is not Python, but it keeps the CONTRACT the real
// driver keeps: persistent namespace, the last expression's value,
// print to out, NameError to err. These tests exercise the console
// against that contract, so they hold against the real interpreter too.

import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setMacForTests } from "../platform";
import {
  ConsolePanel,
  _resetPyConsoleForTests,
  _restoreScratchForTests,
  highlightPython,
} from "../ui/console";
import { mockScripts, pyReset } from "../bridge";
import { _clearFlashForTests } from "../ui/hints";
import { clearLog, getLogLevel, logMsg, setLogLevel } from "../log";
import { choose } from "./menuhelp";

async function openPython(dispatch = vi.fn()) {
  const user = userEvent.setup();
  render(<ConsolePanel open dispatch={dispatch} />);
  await user.click(screen.getByTestId("console-tab-python"));
  return user;
}

function board(): HTMLTextAreaElement {
  return screen.getByTestId("py-input") as HTMLTextAreaElement;
}

/** Puts code on the scratchboard (replacing what was there), selects
 * all of it, and runs the selection with Ctrl+Enter. */
async function run(user: ReturnType<typeof userEvent.setup>, code: string) {
  const input = board();
  await user.clear(input);
  await user.click(input);
  await user.paste(code);
  input.setSelectionRange(0, input.value.length);
  fireEvent.keyDown(input, { key: "Enter", ctrlKey: true });
}

describe("the scratchboard runs what you highlight", () => {
  beforeEach(async () => {
    _resetPyConsoleForTests();
    await pyReset();
  });

  it("opens on the log, and the tabs swap both body and header chips", async () => {
    const user = await openPython();
    expect(board()).toBeInTheDocument();
    expect(screen.getByText(/already connected to this session/)).toBeInTheDocument();
    expect(screen.getByTestId("py-open")).toBeInTheDocument();
    expect(screen.queryByTestId("console-copy")).not.toBeInTheDocument();
    await user.click(screen.getByTestId("console-tab-log"));
    expect(screen.getByTestId("console-copy")).toBeInTheDocument();
    expect(screen.queryByTestId("py-input")).not.toBeInTheDocument();
  });

  it("a highlighted expression answers with its value, and the code stays put", async () => {
    const user = await openPython();
    await run(user, "1 + 1");
    expect((await screen.findByTestId("py-in")).textContent).toContain("1 + 1");
    expect((await screen.findByTestId("py-val")).textContent).toBe("2");
    // A scratchboard, not a command line: running must not eat the code.
    expect(board()).toHaveValue("1 + 1");
  });

  it("a multi-line block answers with its LAST expression", async () => {
    const user = await openPython();
    await run(user, "x = 3\nx * 4");
    expect((await screen.findByTestId("py-val")).textContent).toBe("12");
  });

  it("with nothing highlighted, Ctrl+Enter runs the caret's line", async () => {
    const user = await openPython();
    const input = board();
    await user.click(input);
    await user.paste("x = 21\nx * 2");
    input.setSelectionRange(3, 3);
    fireEvent.keyDown(input, { key: "Enter", ctrlKey: true });
    // Only the assignment ran: no value yet.
    expect((await screen.findByTestId("py-in")).textContent).toContain("x = 21");
    expect(screen.queryByTestId("py-val")).not.toBeInTheDocument();
    input.setSelectionRange(input.value.length, input.value.length);
    fireEvent.keyDown(input, { key: "Enter", ctrlKey: true });
    expect((await screen.findByTestId("py-val")).textContent).toBe("42");
  });

  it("print lands in out, errors land in err, and the session survives them", async () => {
    const user = await openPython();
    await run(user, "print('hail')");
    expect((await screen.findByTestId("py-out")).textContent).toBe("hail");
    await run(user, "boom");
    expect((await screen.findByTestId("py-err")).textContent).toContain("NameError");
    await run(user, "2 + 3");
    expect((await screen.findByTestId("py-val")).textContent).toBe("5");
  });

  it("Reset starts a fresh interpreter: yesterday's names are gone", async () => {
    const user = await openPython();
    await run(user, "x = 21");
    await user.click(screen.getByTestId("py-reset"));
    await screen.findByText("# session reset");
    await run(user, "x");
    expect((await screen.findByTestId("py-err")).textContent).toContain("NameError");
  });

  it("Enter auto-indents, one step deeper after a colon; Tab indents", async () => {
    const user = await openPython();
    const input = board();
    await user.click(input);
    await user.paste("def f():");
    await user.keyboard("{Enter}");
    expect(input).toHaveValue("def f():\n    ");
    await user.paste("return 1");
    await user.keyboard("{Enter}");
    // A plain line keeps its own indent.
    expect(input).toHaveValue("def f():\n    return 1\n    ");
    fireEvent.keyDown(input, { key: "Tab" });
    expect(input.value.endsWith("        ")).toBe(true);
  });

  it("the scrollback survives a trip through the log tab", async () => {
    const user = await openPython();
    await run(user, "1 + 1");
    await screen.findByTestId("py-val");
    await user.click(screen.getByTestId("console-tab-log"));
    await user.click(screen.getByTestId("console-tab-python"));
    expect(screen.getByTestId("py-val").textContent).toBe("2");
  });
});

describe("scratch tabs, 3D-package style", () => {
  beforeEach(async () => {
    _resetPyConsoleForTests();
    await pyReset();
  });

  // The chosen state speaks one language everywhere: accent lettering
  // with a visible accent seat. Colors are asserted on the buttons
  // themselves, because WKWebView does not inherit through un-set
  // buttons (the Collections lesson).
  it("the active mode tab and scratch tab wear the accent", async () => {
    const user = await openPython();
    const py = screen.getByTestId("console-tab-python");
    const log = screen.getByTestId("console-tab-log");
    expect(py.style.color).toBe("var(--accent)");
    expect(py.style.borderBottom).toContain("var(--accent)");
    expect(log.style.color).toBe("var(--text-ghost)");
    await user.click(screen.getByTestId("py-tab-add"));
    const on = screen.getByTestId("py-tab-1");
    const off = screen.getByTestId("py-tab-0");
    expect(on.style.color).toBe("var(--accent)");
    expect(on.style.border).toContain("var(--accent)");
    expect(on.style.background).toContain("var(--accent-tint)");
    expect(off.style.color).toBe("var(--text-ghost)");
  });

  it("tabs hold separate scripts and switching keeps both", async () => {
    const user = await openPython();
    await user.click(board());
    await user.paste("a = 1");
    await user.click(screen.getByTestId("py-tab-add"));
    expect(board()).toHaveValue("");
    await user.click(board());
    await user.paste("b = 2");
    await user.click(screen.getByTestId("py-tab-0"));
    expect(board()).toHaveValue("a = 1");
    await user.click(screen.getByTestId("py-tab-1"));
    expect(board()).toHaveValue("b = 2");
  });

  it("closing the active tab falls back to its neighbor", async () => {
    const user = await openPython();
    await user.click(screen.getByTestId("py-tab-add"));
    await user.click(board());
    await user.paste("doomed");
    await user.click(screen.getByTestId("py-tab-close"));
    expect(screen.queryByTestId("py-tab-1")).not.toBeInTheDocument();
    expect(board()).toHaveValue("");
  });

  it("Open loads a script from disk into its own tab; Run runs the tab", async () => {
    const user = await openPython();
    await user.click(screen.getByTestId("py-open"));
    expect(await screen.findByText("mock.heeler")).toBeInTheDocument();
    expect(board()).toHaveValue(mockScripts["mock.heeler"]);
    await user.click(screen.getByTestId("py-run-tab"));
    // The scrollback names the tab rather than echoing the whole file.
    expect((await screen.findByTestId("py-in")).textContent).toContain("# run mock.heeler");
    expect((await screen.findByTestId("py-out")).textContent).toBe("from disk");
  });

  it("Save as writes a new file; Save updates it in place", async () => {
    const user = await openPython();
    await user.click(board());
    await user.paste("x = 5");
    await user.click(screen.getByTestId("py-save-as"));
    await screen.findByText("# saved saved.heeler");
    expect(mockScripts["saved.heeler"]).toBe("x = 5");
    // The tab takes the file's name and belongs to it now.
    expect(screen.getByText("saved.heeler")).toBeInTheDocument();
    await user.click(board());
    await user.paste("\ny = 6");
    await user.click(screen.getByTestId("py-save"));
    await screen.findAllByText(/# saved saved.heeler/);
    expect(mockScripts["saved.heeler"]).toBe("x = 5\ny = 6");
  });

  it("every keystroke persists, and a fresh start recovers it", async () => {
    const user = await openPython();
    await user.click(board());
    await user.paste("precious = True");
    const stored = JSON.parse(localStorage.getItem("heeler.py.scratch")!);
    expect(stored.tabs[0].text).toBe("precious = True");
    // The crash: module state dies, localStorage does not.
    _resetPyConsoleForTests();
    localStorage.setItem(
      "heeler.py.scratch",
      JSON.stringify({ tabs: [{ name: "Recovered", text: "z = 9", path: null, saved: null }], active: 0 })
    );
    _restoreScratchForTests();
    await user.click(screen.getByTestId("console-tab-log"));
    await user.click(screen.getByTestId("console-tab-python"));
    expect(board()).toHaveValue("z = 9");
    expect(screen.getByText("Recovered")).toBeInTheDocument();
  });
});

describe("the console as an OS window", () => {
  beforeEach(async () => {
    _resetPyConsoleForTests();
    await pyReset();
  });

  it("windowed mode fills, drops the float chrome, and keeps both tabs", async () => {
    const user = userEvent.setup();
    render(<ConsolePanel open windowed dispatch={() => {}} />);
    const panel = screen.getByTestId("console-panel");
    expect(panel.style.inset).toBe("0");
    // No pop-out-again chip, and the header doubles as the undecorated
    // window's titlebar (Tauri drag region). Close stays: it is the
    // window's only close button.
    expect(screen.queryByTestId("console-popout")).not.toBeInTheDocument();
    expect(screen.getByTestId("console-drag")).toHaveAttribute("data-tauri-drag-region");
    expect(screen.getByTestId("console-close")).toBeInTheDocument();
    await user.click(screen.getByTestId("console-tab-python"));
    expect(screen.getByTestId("py-input")).toBeInTheDocument();
  });

  it("the sync carries entries both ways", async () => {
    const { connectPySync } = await import("../ui/console");
    render(<ConsolePanel open dispatch={() => {}} />);

    // A fake channel: what one window sends, the other ingests.
    const sent: unknown[] = [];
    let deliver: ((p: { entry?: { kind: string; text: string } }) => void) | null = null;
    connectPySync(
      (p) => sent.push(p),
      (fn) => {
        deliver = fn as typeof deliver;
      }
    );
    const user = userEvent.setup();
    await user.click(screen.getByTestId("console-tab-python"));
    const input = screen.getByTestId("py-input");
    await user.clear(input);
    await user.click(input);
    await user.paste("1 + 1");
    (input as HTMLTextAreaElement).setSelectionRange(0, 5);
    const { fireEvent } = await import("@testing-library/react");
    fireEvent.keyDown(input, { key: "Enter", ctrlKey: true });
    await screen.findByTestId("py-val");
    // The run's entries went out on the channel...
    expect(sent.length).toBeGreaterThan(0);
    // ...and an entry arriving FROM the channel shows in the scrollback.
    deliver!({ entry: { kind: "out", text: "from the other window" } });
    expect(await screen.findByText("from the other window")).toBeInTheDocument();
  });
});

describe("IDE style coloring", () => {
  const colorOf = (code: string, text: string) =>
    highlightPython(code).find((s) => s.text === text)?.color;

  it("keywords, strings, numbers, builtins and comments each get a color", () => {
    const code = "import heeler  # the client\nh = heeler.connect('x', 21)\nprint(h)";
    expect(colorOf(code, "import")).toBeTruthy();
    expect(colorOf(code, "# the client")).toBeTruthy();
    expect(colorOf(code, "'x'")).toBeTruthy();
    expect(colorOf(code, "21")).toBeTruthy();
    expect(colorOf(code, "print")).toBeTruthy();
    const distinct = new Set(
      ["import", "# the client", "'x'", "21", "print"].map((t) => colorOf(code, t))
    );
    expect(distinct.size).toBe(5);
  });

  it("plain identifiers stay uncolored, and nothing is lost in the split", () => {
    const code = "frobnicate = weird_name + 1";
    expect(colorOf(code, "frobnicate")).toBeUndefined();
    expect(highlightPython(code).map((s) => s.text).join("")).toBe(code);
  });

  it("an unclosed string colors to the end of the line instead of exploding", () => {
    const spans = highlightPython("s = 'oops");
    expect(spans.map((s) => s.text).join("")).toBe("s = 'oops");
    expect(spans.find((s) => s.text === "'oops")?.color).toBeTruthy();
  });
});


describe("the log tab's filters and the Debug chip", () => {
  // The audit's usability gap: at a debug session's volume the console
  // needs a level filter and a substring filter to stay copyable.
  // Filters are display-only; Copy all keeps the whole buffer.
  beforeEach(() => {
    _clearFlashForTests();
    clearLog();
    setLogLevel("info");
  });

  it("filters by level floor and by substring, count reflecting both", () => {
    logMsg("info", "opened folder alpha");
    logMsg("warn", "a file moved");
    logMsg("error", "a render failed");
    render(<ConsolePanel open dispatch={() => {}} />);
    expect(screen.getAllByTestId("console-entry").length).toBe(3);
    choose(screen.getByTestId("log-level-filter"), "warn");
    expect(screen.getAllByTestId("console-entry").length).toBe(2);
    choose(screen.getByTestId("log-level-filter"), "all");
    fireEvent.change(screen.getByTestId("log-search"), { target: { value: "folder" } });
    expect(screen.getAllByTestId("console-entry").length).toBe(1);
    expect(screen.getByText(/1 of 3/)).toBeInTheDocument();
  });

  it("keeps the count in a status bar under the log, out of the title row (it wrapped at 150%)", () => {
    logMsg("info", "opened folder alpha");
    logMsg("warn", "a file moved");
    render(<ConsolePanel open dispatch={() => {}} />);
    // The title row carries the tabs and the filters, not the count.
    expect(screen.getByTestId("console-drag").textContent).not.toMatch(/message/);
    const status = screen.getByTestId("console-status");
    expect(status.textContent).toBe("2 messages");
    expect(status.style.whiteSpace).toBe("nowrap");
    fireEvent.change(screen.getByTestId("log-search"), { target: { value: "folder" } });
    expect(screen.getByTestId("console-status").textContent).toBe("1 of 2 messages shown");
  });

  it("the Debug chip flips the level both ways", () => {
    render(<ConsolePanel open dispatch={() => {}} />);
    expect(getLogLevel()).toBe("info");
    fireEvent.click(screen.getByTestId("log-debug-toggle"));
    expect(getLogLevel()).toBe("debug");
    fireEvent.click(screen.getByTestId("log-debug-toggle"));
    expect(getLogLevel()).toBe("info");
  });
});

describe("saving the log", () => {
  it("offers an icon-only Save with a tooltip beside Copy and Clear", () => {
    render(<ConsolePanel open dispatch={() => {}} />);
    const save = screen.getByTestId("console-save");
    expect(save.getAttribute("aria-label")).toBe("Save the log to a file");
    expect(save.getAttribute("data-hint")).toMatch(/^Save every line in the buffer/);
    expect(save.textContent).toBe("");
    expect(save.querySelector("svg")).not.toBeNull();
  });
});

// Docs review 2026-10-01: the Run button and the empty board said
// Ctrl+Enter on a Mac too. They name the platform's key now, and that
// key is the one bound: Command with Enter on a Mac, Control elsewhere.
describe("the run key is named for the platform and is the key bound", () => {
  beforeEach(async () => {
    _resetPyConsoleForTests();
    await pyReset();
  });
  afterEach(() => setMacForTests(null));

  for (const mac of [true, false]) {
    it(mac ? "on a Mac: Command+Enter, named with the Command symbol" : "elsewhere: CTRL+Enter", async () => {
      setMacForTests(mac);
      const user = await openPython();
      const label = screen.getByTestId("py-run-tab").getAttribute("aria-label") ?? "";
      const intro = screen.getByText(/already connected to this session/).textContent ?? "";
      for (const words of [label, intro]) {
        if (mac) {
          expect(words).toContain("⌘Enter");
          expect(words).not.toMatch(/ctrl/i);
        } else {
          expect(words).toContain("CTRL+Enter");
          expect(words).not.toContain("⌘");
        }
      }
      const input = board();
      await user.click(input);
      await user.paste("6 * 7");
      input.setSelectionRange(0, input.value.length);
      fireEvent.keyDown(input, { key: "Enter", ...(mac ? { metaKey: true } : { ctrlKey: true }) });
      expect((await screen.findByTestId("py-val")).textContent).toBe("42");
    });
  }
});
