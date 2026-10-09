// The DEBUG log tier: a per-session verbosity switch for bug reports
// ("if a user has issues... I can ask them to switch
// over to DEBUG, recreate the problem, and then copy all the log
// data out"). The contract under test: INFO drops debug lines AT THE
// SOURCE (the closure form never even builds its string), DEBUG
// captures them, the level starts at INFO (it resets by
// construction: it is module memory, never persisted), and the
// scrubber shortens paths.

import { afterEach, describe, expect, it } from "vitest";
import {
  addLogCatalogRoot,
  clearLog,
  getEntries,
  getLogLevel,
  logDebug,
  logMsg,
  setLogHome,
  setLogLevel,
} from "../log";

afterEach(() => {
  setLogLevel("info");
  clearLog();
});

describe("the DEBUG verbosity tier", () => {
  it("starts at INFO, and INFO drops debug lines without building them", () => {
    expect(getLogLevel()).toBe("info");
    let built = false;
    logDebug(() => {
      built = true;
      return "expensive line";
    });
    logDebug("plain line");
    expect(built).toBe(false);
    expect(getEntries().length).toBe(0);
  });

  it("DEBUG captures both forms, and flipping back drops again", () => {
    setLogLevel("debug");
    logDebug(() => "lazy line");
    logDebug("plain line");
    expect(getEntries().map((e) => e.message)).toEqual(["lazy line", "plain line"]);
    expect(getEntries().every((e) => e.level === "debug")).toBe(true);
    setLogLevel("info");
    logDebug("after the switch");
    expect(getEntries().length).toBe(2);
  });

  it("a debug line arriving through logMsg is dropped at INFO too", () => {
    // The Rust side can race a toggle: its line reaches logMsg with
    // level debug after the UI already flipped back.
    logMsg("debug", "raced line");
    expect(getEntries().length).toBe(0);
  });
});

describe("the path scrubber", () => {
  it("home reads as ~ at every level; catalog roots shorten debug lines", () => {
    setLogHome("/Users/someone");
    addLogCatalogRoot("/Volumes/Photos2/2026 Wedding");
    logMsg("warn", "Expected at /Users/someone/Photography/P1551346.RW2");
    setLogLevel("debug");
    logDebug("decoded /Volumes/Photos2/2026 Wedding/P1551346.RW2 in 512ms");
    logMsg("info", "queued /Volumes/Photos2/2026 Wedding/P1551346.RW2");
    const msgs = getEntries().map((e) => e.message);
    expect(msgs[0]).toBe("Expected at ~/Photography/P1551346.RW2");
    expect(msgs[1]).toBe("decoded [catalog]/P1551346.RW2 in 512ms");
    // Root-relative is a DEBUG-line courtesy; user-facing levels keep
    // the fuller (home-scrubbed) path, which repair messages need.
    expect(msgs[2]).toBe("queued /Volumes/Photos2/2026 Wedding/P1551346.RW2");
  });
});

describe("the transport's debug lines and the log channel", () => {
  it("never mentions the channels that carry the log itself", async () => {
    // On flipping DEBUG on: "immediately 3000 of these... I can't clear
    // all these messages." Every log line broadcasts over the console
    // channel; a transport debug line about that send creates another
    // line to send, an unbounded chain. The quiet set is the firebreak,
    // and it must keep covering both console channels.
    const { TRANSPORT_DEBUG_QUIET, CONSOLE_LOG_CHANNEL, CONSOLE_PY_CHANNEL } = await import(
      "../popout"
    );
    expect(TRANSPORT_DEBUG_QUIET.has(CONSOLE_LOG_CHANNEL)).toBe(true);
    expect(TRANSPORT_DEBUG_QUIET.has(CONSOLE_PY_CHANNEL)).toBe(true);
  });
});

describe("the log store's wake-ups leave the render stack alone", () => {
  it("notifies subscribers on a microtask, coalesced, never synchronously", async () => {
    // The reducer's debug spine runs INSIDE React's render, and a
    // synchronous notify made the status bar set state mid-render (the
    // owner's console: "Cannot update a component (StatusBar) while
    // rendering a different component (App)"). Entries still land
    // synchronously; only the wake-up waits for the stack to unwind.
    const { subscribeLog } = await import("../log");
    let calls = 0;
    const off = subscribeLog(() => {
      calls += 1;
    });
    try {
      logMsg("info", "first");
      logMsg("info", "second");
      expect(getEntries().length).toBe(2);
      expect(calls).toBe(0);
      await Promise.resolve();
      expect(calls).toBe(1);
    } finally {
      off();
    }
  });
});

describe("the reducer spine's once-per-command rule", () => {
  it("the same command object logs once, however many times React reduces it", async () => {
    // React invokes a reducer eagerly on dispatch and again during the
    // render: the WeakSet keeps each command OBJECT to one line, and a
    // fresh identical object is a new command and gets its own.
    const { reduce } = await import("../state");
    const { initialState } = await import("../data");
    setLogLevel("debug");
    const s = initialState();
    const cmd = { type: "select_image", id: "4867" } as const;
    reduce(s, cmd);
    reduce(s, cmd);
    expect(
      getEntries().filter((e) => e.message.startsWith("reduce: select_image")).length,
    ).toBe(1);
    reduce(s, { type: "select_image", id: "4867" });
    expect(
      getEntries().filter((e) => e.message.startsWith("reduce: select_image")).length,
    ).toBe(2);
  });
});
