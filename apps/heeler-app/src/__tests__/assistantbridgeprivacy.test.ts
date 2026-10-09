import { expect, it, vi } from "vitest";
const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
import { assistantChat } from "../bridge";
import { clearLog, getEntries, setLogLevel } from "../log";
it("does not persist a server error that echoes the conversation", async () => {
  Object.assign(window, { __TAURI_INTERNALS__: {} });
  invoke.mockRejectedValue("HTTP 400: private question echoed by server");
  clearLog(); setLogLevel("debug");
  try {
    await expect(assistantChat("http://localhost:1234", "test", [{ role: "user", content: "private question" }])).rejects.toContain("private question");
    expect(getEntries().map((e) => e.message).join("\n")).not.toContain("private question");
  } finally {
    setLogLevel("info"); clearLog();
    delete (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
  }
});
