import { describe, expect, it } from "vitest";
import { initialState } from "../data";
import { reduce, type Command, type State } from "../state";

const run = (s: State, ...cmds: Command[]) => cmds.reduce(reduce, s);

/* (2026-09-13): "I had an eyedropper tool that had not been canceled.
 * I went into Depth Lighting and was trying to edit the light's
 * position but the cursor was stuck on eyedropper. I had to cancel
 * out of light editing, and hit ESC (felt like more than once) to get
 * the eyedropper to cancel out."*/
describe("one cursor at a time", () => {
  it("arming a picker puts every other picker away, companions included", () => {
    const s0 = initialState();
    const dropper = reduce(s0, { type: "arm_cset_dropper", n: 1 });
    expect(dropper.csetDropper).toBe(1);
    const light = reduce(dropper, { type: "toggle_keylight_pick" });
    expect(light.keyLightPick).toBe(true);
    expect(light.csetDropper).toBeNull();
    const wb = reduce(light, { type: "arm_wb_pick", id: "stdcolor" });
    expect(wb.wbPick).toBe("stdcolor");
    expect(wb.keyLightPick).toBe(false);
    const curve = run(wb, { type: "arm_curve_pick", nodeId: "curves", channel: "luma" }, { type: "set_curve_hover", x: 0.5 });
    expect(curve.curvePick).toEqual({ nodeId: "curves", channel: "luma" });
    expect(curve.curveHoverX).toBe(0.5);
    expect(curve.wbPick).toBeNull();
    const console_ = reduce(curve, { type: "toggle_console_pick", id: "colorconsole" });
    expect(console_.consolePick).toBe("colorconsole");
    expect(console_.curvePick).toBeNull();
    expect(console_.curveHoverX).toBeNull();
    // Putting the armed picker away by its own toggle arms nothing.
    const off = reduce(console_, { type: "toggle_console_pick", id: "colorconsole" });
    expect(off.consolePick).toBeNull();
    expect(off.consolePickBand).toBeNull();
  });

  it("picking up a viewer tool puts the pickers away; putting one down does not, and a view is not a tool", () => {
    const s0 = initialState();
    const armed = reduce(s0, { type: "arm_wb_pick", id: "stdcolor" });
    const brush = reduce(armed, { type: "set_tool", tool: "brush" });
    expect(brush.tool).toBe("brush");
    expect(brush.wbPick).toBeNull();
    const rearmed = reduce(brush, { type: "arm_wb_pick", id: "stdcolor" });
    expect(rearmed.wbPick).toBe("stdcolor");
    expect(rearmed.tool).toBe("brush");
    const down = reduce(rearmed, { type: "set_tool", tool: "brush" });
    expect(down.tool).toBe("none");
    expect(down.wbPick).toBe("stdcolor");
    const dropper = reduce(s0, { type: "arm_cset_dropper", n: 1 });
    expect(reduce(dropper, { type: "toggle_cset_mask_view", n: 1 }).csetDropper).toBe(1);
    expect(reduce(dropper, { type: "toggle_depth_view" }).csetDropper).toBe(1);
    expect(reduce(dropper, { type: "undo" }).csetDropper).toBe(1);
  });
});
