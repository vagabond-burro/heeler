import { describe, expect, it } from "vitest";
import { initialState } from "../data";
import { capturePreset, reduce } from "../state";

describe("folder graph replacement", () => {
  it.each([false, true])("clears graph pointers and an unfinished gesture (empty=%s)", (empty) => {
    const before = { ...initialState(), csetDropper: 1, csetMaskView: 1,
      probeNode: "exposure", gesture: "cset1.pick", gesturePushed: true };
    const next = reduce(before, { type: "load_images", images: empty ? [] : before.images });
    expect(next.csetDropper).toBeNull();
    expect(next.csetMaskView).toBeNull();
    expect(next.probeNode).toBeNull();
    expect(next.gesture).toBeNull();
    expect(next.gesturePushed).toBe(false);
  });
});


describe("depth picker graph ownership", () => {
  it.each(["image", "folder", "take", "preset"])("clears the focus and light arms on a %s replacement", (change) => {
    const seed = reduce(initialState(), { type: "new_take" });
    const before = { ...seed, dofPick: true, keyLightPick: true, keyLightSel: 2 };
    const next = change === "image" ? reduce(before, { type: "select_image", id: "4875" })
      : change === "folder" ? reduce(before, { type: "load_images", images: before.images })
      : change === "take" ? reduce(before, { type: "switch_take", takeId: "take_1" })
      : reduce(before, { type: "apply_preset", preset: capturePreset(initialState(), "Fresh") });
    expect(next).not.toBe(before);
    expect(next.dofPick).toBe(false);
    expect(next.keyLightPick).toBe(false);
    expect(next.keyLightSel).toBeNull();
  });
});
