import * as status from "../ui/statusbar";
import { describe, expect, it, vi } from "vitest";
import { initialState } from "../data";
import { capturePreset, reduce, type Command } from "../state";
import { PickSessions } from "../picksession";

const armed = () => reduce(initialState(), { type: "arm_wb_pick", id: "stdcolor" });
const aim = {
  aim: (s: ReturnType<typeof armed>) => s.wbPick,
  settings: (s: ReturnType<typeof armed>) => s.nodes.find((n) => n.id === "stdcolor")?.params,
  // Production sessions name the dropper they answer through, so its
  // disarm ends them even batched with a same-value re-arm.
  arm: "wbPick" as const,
};

describe("sample session ownership", () => {
  it("newer clicks win even when the old answer returns last", async () => {
    const writes: Command[] = [];
    const sessions = new PickSessions(armed(), (c) => writes.push(c));
    let answer!: () => void;
    const old = sessions.start("wb", aim);
    const pending = new Promise<void>((r) => { answer = r; }).then(() => old.dispatch({ type: "arm_wb_pick", id: null }));
    const next = sessions.start("wb", aim);
    expect(next.token).not.toBe(old.token);
    answer();
    expect(await pending).toBe(false);
    expect(next.stillMine()).toBe(true);
    expect(writes).toEqual([]);
  });
  it("equal settings survive unrelated node rebuilding", () => {
    const s = armed();
    const sessions = new PickSessions(s, () => {});
    const pick = sessions.start("wb", aim);
    sessions.update({ ...s, nodes: structuredClone(s.nodes) }, () => {});
    expect(pick.stillMine()).toBe(true);
  });
  it("a manual target edit cancels permanently", () => {
    const s = armed();
    const sessions = new PickSessions(s, () => {});
    const pick = sessions.start("wb", aim);
    sessions.update(reduce(s, { type: "set_param", id: "stdcolor", param: "temperature", value: 4000 }), () => {});
    expect(pick.stillMine()).toBe(false);
    sessions.update(s, () => {});
    expect(pick.stillMine()).toBe(false);
  });
  it.each(["image", "take", "preset", "rearm", "delete"])("batched %s changes cannot revive an old token", (change) => {
    const s = armed();
    const sessions = new PickSessions(s, () => {});
    const pick = sessions.start("wb", aim);
    let next = s;
    if (change === "image") {
      next = reduce(reduce(s, { type: "select_image", id: "4875" }), { type: "select_image", id: s.activeImage });
    } else if (change === "take") {
      next = reduce(reduce(s, { type: "new_take" }), { type: "switch_take", takeId: "take_1" });
    } else if (change === "preset") {
      next = reduce(s, { type: "apply_preset", preset: capturePreset(s, "same look") });
    } else if (change === "delete") {
      const node = s.nodes.find((n) => n.id === "stdcolor")!;
      next = reduce(reduce(s, { type: "delete_nodes", ids: [node.id] }), { type: "add_node", node });
    } else {
      next = reduce(s, { type: "arm_wb_pick", id: null });
    }
    next = reduce(next, { type: "arm_wb_pick", id: "stdcolor" });
    sessions.update(next, () => {});
    expect(pick.stillMine()).toBe(false);
  });
  it("a stale gesture end leaves a newer gesture alone", () => {
    const sessions = new PickSessions(armed(), () => {});
    const pick = sessions.start("wb", aim);
    pick.beginGesture("stdcolor.batch");
    const next = reduce(sessions.state(), { type: "begin_gesture", key: "exposure.exposure" });
    sessions.update(next, () => {});
    pick.cancel();
    expect(sessions.state().gesture).toBe("exposure.exposure");
    expect(reduce(next, { type: "end_gesture", owner: pick.token })).toBe(next);
  });
  it("unmount disposes listeners and guards delayed dispatch", () => {
    const writes: Command[] = [];
    const sessions = new PickSessions(armed(), (c) => writes.push(c));
    const pick = sessions.start("wb", aim);
    let calls = 0;
    pick.listen("mousemove", () => calls++);
    sessions.dispose();
    window.dispatchEvent(new MouseEvent("mousemove"));
    expect(calls).toBe(0);
    expect(pick.dispatch({ type: "arm_wb_pick", id: null })).toBe(false);
    expect(writes).toEqual([]);
  });
});


it("an old completion cannot clear a newer pick's busy message", () => {
  const publish = vi.spyOn(status, "publishBusy");
  const sessions = new PickSessions(armed(), () => {});
  const old = sessions.start("wb", aim);
  const clearOld = old.busy("reading old pick");
  const current = sessions.start("wb", aim);
  current.busy("reading new pick");
  const count = publish.mock.calls.length;
  clearOld();
  expect(publish).toHaveBeenCalledTimes(count);
  expect(publish).toHaveBeenLastCalledWith("reading new pick");
  sessions.dispose();
  expect(publish).toHaveBeenLastCalledWith(null);
  publish.mockRestore();
});


it("an unrelated typed edit ends an owned sweep without folding into its undo", () => {
  const sessions = new PickSessions(armed(), () => {});
  const before = sessions.state().undoStack.length;
  const pick = sessions.start("wb", aim);
  pick.beginGesture("stdcolor.batch");
  pick.dispatch({ type: "set_params", id: "stdcolor", values: { temperature: 5000 } });
  const typed = reduce(sessions.state(), { type: "set_param", id: "exposure", param: "exposure", value: 2 });
  sessions.update(typed, () => {});
  expect(pick.stillMine()).toBe(false);
  expect(typed.gesture).toBeNull();
  expect(typed.undoStack).toHaveLength(before + 2);
  const undone = reduce(typed, { type: "undo" });
  expect(undone.nodes.find((n) => n.id === "stdcolor")!.params.temperature).toBe(5000);
});

it("a completed one-shot pick does not cancel a read it never aimed at", () => {
  // The failing pair, seen in the app: open a Lens Character door (its
  // answer is a slow depth read, aimed at the dof node and nothing else),
  // then land an armed white-balance pick. The pick's own completion
  // disarm must end the pick's session only; the depth read never touched
  // a picker arm, so nothing about the disarm is aimed at it.
  const s = armed();
  const sessions = new PickSessions(s, () => {});
  const read = sessions.start("aperture", {
    aim: (v) => v.nodes.some((n) => n.id === "dof"),
    settings: (v) => v.nodes.find((n) => n.id === "dof")?.params,
  });
  const pick = sessions.start("wb", {
    aim: (v) => [v.wbPick, v.nodes.some((n) => n.id === "stdcolor")],
    settings: (v) => v.nodes.find((n) => n.id === "stdcolor")?.params,
    arm: "wbPick",
  });
  sessions.update(reduce(s, { type: "arm_wb_pick", id: null }), () => {});
  expect(pick.stillMine()).toBe(false);
  expect(read.stillMine()).toBe(true);
  // The reverse still holds: disarming the dropper a session DOES aim at,
  // batched with a same-value rearm, ends that session.
  const pick2 = sessions.start("wb", {
    aim: (v) => [v.wbPick, v.nodes.some((n) => n.id === "stdcolor")],
    arm: "wbPick",
  });
  const rearmed = reduce(reduce(sessions.state(), { type: "arm_wb_pick", id: null }), { type: "arm_wb_pick", id: "stdcolor" });
  sessions.update(rearmed, () => {});
  expect(pick2.stillMine()).toBe(false);
});

describe("reuse: a hover's session survives the next move", () => {
  it("hands back the live session on its slot and starts a fresh one only once it is no longer ours", () => {
    const s0 = reduce(initialState(), { type: "arm_wb_pick", id: "stdcolor" });
    const picks = new PickSessions(s0, () => {});
    const a = picks.reuse("hover", { aim: (v) => v.wbPick, arm: "wbPick" });
    const b = picks.reuse("hover", { aim: (v) => v.wbPick, arm: "wbPick" });
    expect(b).toBe(a);
    expect(a.stillMine()).toBe(true);
    // Disarmed: the old session is over, and the next reuse is new.
    picks.update(reduce(s0, { type: "arm_wb_pick", id: null }), () => {});
    expect(a.stillMine()).toBe(false);
    const c = picks.reuse("hover", { aim: (v) => v.wbPick, arm: "wbPick" });
    expect(c).not.toBe(a);
  });
});
