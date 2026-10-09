import { describe, expect, it } from "vitest";
import { initialState } from "../data";
import { cropNode, reduce, TOOL_SESSION_DEFAULTS, type Command, type State } from "../state";

const run = (s: State, ...cmds: Command[]) => cmds.reduce(reduce, s);

/* : "When I access tools like Crop and Recolor the parameters and
 * settings are retained from the last time I used them (same session).
 * It's off putting. Especially the crop tool when going between images
 * of different orientations."*/
describe("the tools start each photograph at their defaults", () => {
  const other = (s: State) => s.images.find((i) => i.id !== s.activeImage)!.id;

  it("a photo switch puts every tool session setting back, the cursor in hand", () => {
    const s0 = initialState();
    const worked = run(
      s0,
      { type: "set_tool", tool: "crop" },
      { type: "set_crop_aspect", aspect: 1.5 },
      { type: "set_recolor_cell", cell: "sat_sat" },
      { type: "set_console_band", id: "b" },
      { type: "set_clone_source", at: [0.3, 0.4] },
      { type: "toggle_brush_swap" },
      { type: "set_select_op", op: "subtract" },
      { type: "set_pick_mode", mode: "add" },
    );
    expect(worked.cropAspect).toBe(1.5);
    expect(worked.recolorCell).toBe("sat_sat");
    const next = reduce(worked, { type: "select_image", id: other(worked) });
    expect(next.tool).toBe("none");
    expect(next.toolRevert).toBeNull();
    expect(next.cropAspect).toBeNull();
    expect(next.recolorCell).toBe("hue_sat");
    expect(next.consoleBand).toBe(s0.consoleBand);
    expect(next.cloneSource).toBeNull();
    expect(next.brushSwap).toBe(false);
    expect(next.selectOp).toBe(s0.selectOp);
    expect(next.pickMode).toBe(s0.pickMode);
    // And the defaults a switch applies are the ones the app opens on.
    for (const [key, value] of Object.entries(TOOL_SESSION_DEFAULTS)) {
      expect(next[key as keyof State], key).toEqual(value);
      expect(s0[key as keyof State], key).toEqual(value);
    }
  });

  it("Escape on the next photograph cannot put the last photograph's crop on it", () => {
    const s0 = initialState();
    const a = s0.activeImage;
    const b = other(s0);
    const cropAt = (st: State, x: number): Command[] => [
      { type: "set_tool", tool: "crop" },
      { type: "set_params", id: cropNode(st).id, values: { crop_x: x, crop_y: 0.1, crop_w: 0.5, crop_h: 0.6 } },
      { type: "set_tool", tool: "crop" },
    ];
    // B has a crop of its own; A gets another, and the tool is armed
    // again on A, so its Escape snapshot is A's crop.
    let s = run(s0, { type: "select_image", id: b }, { type: "graph_settled", id: b });
    s = run(s, ...cropAt(s, 0.05));
    s = run(s, { type: "select_image", id: a }, { type: "graph_settled", id: a });
    s = run(s, ...cropAt(s, 0.2), { type: "set_tool", tool: "crop" });
    expect(s.toolRevert?.params?.crop_x).toBe(0.2);
    s = reduce(s, { type: "select_image", id: b });
    expect(cropNode(s).params.crop_x).toBe(0.05);
    s = reduce(s, { type: "cancel_tool" });
    expect(cropNode(s).params.crop_x).toBe(0.05);
  });

  it("Preferences, the remembered settings and the brush's feel stay as they were", () => {
    const s0 = initialState();
    const worked = run(
      s0,
      { type: "set_select_method", method: "magnetic" },
      { type: "set_brush_radius", radius: 0.12 },
      { type: "set_prefs", prefs: { autosaveDelayMs: 1500 } },
    );
    const next = reduce(worked, { type: "select_image", id: other(worked) });
    expect(next.selectMethod).toBe("magnetic");
    expect(next.brushRadius).toBe(0.12);
    expect(next.prefs).toBe(worked.prefs);
    expect(next.shapeMode).toBe(worked.shapeMode);
  });

  it("choosing the photograph already open changes nothing", () => {
    const s = run(initialState(), { type: "set_crop_aspect", aspect: 1.5 }, { type: "set_tool", tool: "crop" });
    expect(reduce(s, { type: "select_image", id: s.activeImage })).toBe(s);
  });
});
