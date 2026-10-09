// What was read from the picture goes in the DEBUG log (2026-09-29:
// "log Florence's description too"), the numbers and Florence-2's
// description as the model reads them, never the conversation.

import { describe, expect, it } from "vitest";

import { describeForAssistant } from "../assistantvision";
import { pictureLogLine } from "../assistantchat";

describe("the picture's DEBUG line", () => {
  it("carries Florence-2's description and the picture report", () => {
    const line = pictureLogLine({
      florence: "ok",
      visionLog: "WHAT IS IN THE PICTURE\nDescription: a man in a red hoodie in the desert.",
      report: "THE PICTURE, MEASURED\nMean brightness +0.3 EV",
    });
    expect(line).toContain("Florence-2 ok");
    expect(line).toContain("a man in a red hoodie in the desert");
    expect(line).toContain("Mean brightness +0.3 EV");
  });

  it("says plainly what is missing", () => {
    expect(pictureLogLine({ florence: "missing", vision: null, report: "R" })).toContain("(no Florence-2 description)");
    expect(pictureLogLine(null)).toContain("nothing was read from the picture");
  });

  it("has no place for the question or the answer", () => {
    // The function takes only what was read from the picture.
    expect(pictureLogLine.length).toBe(1);
    const line = pictureLogLine({ florence: "none", vision: null, report: null });
    expect(line.split("\n")).toHaveLength(3);
  });
});

it("never logs found or missing phrases taken from a question", async () => {
  const vision = await describeForAssistant({
    frameUrl: "test", frame: Promise.resolve(null),
    question: "Find my secret tattoo and the hidden scar",
    describe: async () => [
      { truncated: false, text: "A person outdoors.", regions: [] },
      { truncated: false, text: "", regions: [] },
      { truncated: false, text: "the secret tattoo", regions: [{ label: "the secret tattoo", x0: 0, y0: 0, x1: 1, y1: 1 }] },
      { truncated: false, text: "", regions: [] },
    ],
  });
  expect(vision.text).toContain("secret tattoo");
  expect(vision.text).toContain("hidden scar");
  const line = pictureLogLine({ vision: vision.text, visionLog: vision.logText, florence: vision.status });
  expect(line).toContain("A person outdoors.");
  expect(line).not.toContain("secret tattoo");
  expect(line).not.toContain("hidden scar");
});
