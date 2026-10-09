// The 26.4.3 full review's R5: Escape in the middle of a drag put the
// tool down but left the drag's gesture held, and everything that waits
// out a held gesture (the guard strip, Polish's pending work, the depth
// tool, the ROI patch) waited until some later drag began and ended.
// Putting the tool down ends the drag that was in its hand.
import { describe, expect, it } from "vitest";
import { initialState } from "../data";
import { reduce, type Command, type State } from "../state";

const run = (s: State, ...cmds: Command[]): State => cmds.reduce(reduce, s);
const develop = (): State => reduce(initialState(), { type: "select_image", id: "4869" });

describe("putting a tool down mid-drag ends the drag", () => {
  it("Escape (cancel_tool) mid-crop drops the held gesture", () => {
    const s = run(develop(), { type: "set_tool", tool: "crop" }, { type: "begin_gesture", key: "crop.batch" });
    expect(s.gesture).toBe("crop.batch");
    const next = reduce(s, { type: "cancel_tool" });
    expect(next.tool).toBe("none");
    expect(next.gesture, "the crop drag outlived its tool").toBeNull();
    expect(next.gesturePushed).toBe(false);
  });

  it("toggling the tool off mid-drag (Enter, the chip) drops it too", () => {
    const s = run(develop(), { type: "set_tool", tool: "crop" }, { type: "begin_gesture", key: "crop.batch" });
    const next = reduce(s, { type: "set_tool", tool: "crop" });
    expect(next.tool).toBe("none");
    expect(next.gesture).toBeNull();
  });

  it("a gesture with no tool change is left alone", () => {
    const s = run(develop(), { type: "begin_gesture", key: "slider.exposure" });
    const next = reduce(s, { type: "cancel_tool" });
    expect(next.gesture).toBe("slider.exposure");
  });
});
