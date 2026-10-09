import { describe, expect, it } from "vitest";
import { initialState } from "../data";
import { reduce, type Command, type State } from "../state";

const run = (s: State, ...cmds: Command[]) => cmds.reduce(reduce, s);

/* "When I disable this section I expect Position Lights
 * to turn off as well." The arms that put handles over a section's
 * node come down with the node, whichever switch turned it off.*/
describe("depth arms follow their section", () => {

  const armed = () => ({
    ...run(initialState(), { type: "set_category", title: "Depth Lighting", on: true }),
    keyLightPick: true,
    keyLightSel: 1,
  });

  it("the Depth Lighting section switch takes Position Lights down", () => {
    const before = armed();
    expect(before.nodes.some((n) => n.id === "keylight" && n.enabled)).toBe(true);
    const off = reduce(before, { type: "set_category", title: "Depth Lighting", on: false });
    expect(off.keyLightPick).toBe(false);
    expect(off.keyLightSel).toBeNull();
    // Switching it back on does not raise the rig by itself.
    const on = reduce(off, { type: "set_category", title: "Depth Lighting", on: true });
    expect(on.keyLightPick).toBe(false);
  });

  it("the node's own enable dot does the same", () => {
    const off = reduce(armed(), { type: "set_enabled", id: "keylight", enabled: false });
    expect(off.keyLightPick).toBe(false);
    expect(off.keyLightSel).toBeNull();
  });

  it("an unrelated switch leaves the rig up", () => {
    const next = reduce(armed(), { type: "set_category", title: "Vignette", on: true });
    expect(next.keyLightPick).toBe(true);
    expect(next.keyLightSel).toBe(1);
  });

  it("the Depth of Field switch takes the focus pick down", () => {
    const before = { ...run(initialState(), { type: "set_category", title: "Depth of Field", on: true }), dofPick: true };
    const off = reduce(before, { type: "set_category", title: "Depth of Field", on: false });
    expect(off.dofPick).toBe(false);
  });
});
