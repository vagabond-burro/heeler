import { describe, expect, it } from "vitest";
import { initialState } from "../data";
import { reduce, type Command, type State } from "../state";

const run = (s: State, ...cmds: Command[]) => cmds.reduce(reduce, s);

describe("take ratings", () => {

  it("rate a take on the thumbnails' scale, clamp it, and clear it with 0", () => {
    const s = run(initialState(), { type: "new_take" });
    const img = s.activeImage;
    const rated = reduce(s, { type: "set_take_rating", takeId: "take_2", rating: 4 });
    expect(rated.takes[img].find((t) => t.id === "take_2")!.rating).toBe(4);
    expect(rated.undoStack.length).toBe(s.undoStack.length);
    const high = reduce(rated, { type: "set_take_rating", takeId: "take_2", rating: 9 });
    expect(high.takes[img].find((t) => t.id === "take_2")!.rating).toBe(5);
    const cleared = reduce(high, { type: "set_take_rating", takeId: "take_2", rating: 0 });
    expect(cleared.takes[img].find((t) => t.id === "take_2")!.rating).toBeUndefined();
    expect(reduce(cleared, { type: "set_take_rating", takeId: "nope", rating: 3 })).toBe(cleared);
  });

  it("the rating survives a switch and a rename", () => {
    let s = run(initialState(), { type: "new_take" }, { type: "set_take_rating", takeId: "take_2", rating: 3 });
    s = run(s, { type: "switch_take", takeId: "take_1" }, { type: "update_take", takeId: "take_2", name: "Warm", note: "keep" });
    const t2 = s.takes[s.activeImage].find((t) => t.id === "take_2")!;
    expect(t2.rating).toBe(3);
    expect(t2.name).toBe("Warm");
    expect(t2.note).toBe("keep");
  });
});
