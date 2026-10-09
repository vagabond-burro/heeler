import { expect, it, vi } from "vitest";
vi.mock("../bridge", async (original) => ({
  ...await original<typeof import("../bridge")>(),
  assistantChat: async () => JSON.stringify({ steps: [
    { stop: "private words copied from the question", say: "private answer" },
    { stop: "mode.develop", say: "Open Develop." },
  ] }),
}));
import { askTour } from "../tour";
import { clearLog, getEntries, setLogLevel } from "../log";
it("logs counts without an invented stop's model text", async () => {
  clearLog();
  setLogLevel("debug");
  try {
    await askTour({ address: "test", model: "test", question: "How do I edit?", answer: "Open Develop.", chapters: [], guide: [], budget: 9000 });
    const lines = getEntries().map((e) => e.message).join("\n");
    expect(lines).toContain("dropped 1");
    expect(lines).not.toContain("private words");
    expect(lines).not.toContain("private answer");
  } finally { setLogLevel("info"); clearLog(); }
});
