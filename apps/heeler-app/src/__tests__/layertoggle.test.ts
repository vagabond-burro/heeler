// A Develop layer switches off as one thing, and the webview's own
// right-click menu stays off the screen.

import { describe, expect, it } from "vitest";
import { initialState } from "../data";
import { reduce, type Command, type State } from "../state";
import { guardContextMenu } from "../platform";

const run = (s: State, ...cmds: Command[]) => cmds.reduce(reduce, s);

describe("the layer switch", () => {
  it("bypasses the exposure node and every tool behind it, never the mask", () => {
    // "We need an enable toggle on Adjustment layers to
    // be able to toggle them on and off."
    let s = run(initialState(), { type: "add_layer", maskType: "radial" });
    const adj = s.activeLayer!;
    const mask = adj.replace("_adj", "_mask");
    // A tool spliced in behind the exposure node, so the group has
    // more than one member to switch.
    s = run(s, { type: "set_param", id: `${adj.replace("_adj", "")}_levels`, param: "gamma", value: 1.4 });
    const tool = s.nodes.find((n) => n.id === `${adj.replace("_adj", "")}_levels`);
    expect(tool, "the levels tool was not materialized on the layer").toBeDefined();
    const byId = (id: string) => s.nodes.find((n) => n.id === id)!;
    // A fresh layer's exposure node is bypassed until a slider moves;
    // the layer itself is on.
    expect(byId(adj).enabled).toBe(false);
    expect(byId(adj).layerOff).toBeUndefined();
    expect(byId(tool!.id).enabled).toBe(true);
    s = run(s, { type: "set_layer_enabled", id: adj, enabled: false });
    expect(byId(adj).layerOff).toEqual([tool!.id]);
    expect(byId(adj).enabled).toBe(false);
    expect(byId(tool!.id).enabled).toBe(false);
    expect(byId(mask).enabled).toBe(true);
    // A slider moved while the layer is off lands, and waits: it does
    // not switch that one node back on under a layer that reads off.
    s = run(s, { type: "set_param", id: adj, param: "exposure", value: 0.5 });
    expect(byId(adj).enabled).toBe(false);
    expect(byId(adj).params.exposure).toBe(0.5);
    // Back on: the tool that was on comes back, and the exposure node
    // that now says something comes on with it.
    s = run(s, { type: "set_layer_enabled", id: adj, enabled: true });
    expect(byId(adj).layerOff).toBeUndefined();
    expect(byId(adj).enabled).toBe(true);
    expect(byId(tool!.id).enabled).toBe(true);
    // Undoable either way, and pinned to the switch's OWN snapshot: the
    // undo must revert the re-enable and nothing else, so the exposure
    // write that landed while the layer was off survives it. (Before
    // set_layer_enabled joined UNDOABLE this block still passed, because
    // the undo popped the set_param snapshot, which also reads as
    // "layer off"; the exposure assertion is the one that cannot pass
    // by that accident.)
    s = run(s, { type: "undo" });
    expect(byId(adj).layerOff).toBeDefined();
    expect(byId(tool!.id).enabled).toBe(false);
    expect(byId(adj).params.exposure).toBe(0.5);
    // And back: redo re-applies the switch, layer and live tool on.
    s = run(s, { type: "redo" });
    expect(byId(adj).layerOff).toBeUndefined();
    expect(byId(adj).enabled).toBe(true);
    expect(byId(tool!.id).enabled).toBe(true);
  });

  it("switching the same way twice is a no-op, not a history entry", () => {
    let s = run(initialState(), { type: "add_layer", maskType: "radial" });
    const adj = s.activeLayer!;
    const before = s;
    s = run(s, { type: "set_layer_enabled", id: adj, enabled: true });
    expect(s).toBe(before);
  });

  it("ignores an id that is not a layer", () => {
    const s = initialState();
    expect(run(s, { type: "set_layer_enabled", id: "nope_adj", enabled: false })).toBe(s);
  });
});

describe("the context menu guard", () => {
  // "when I right click I get a small popup that has
  // 'Reload'. I am guessing this is the underlying [browser engine]
  // bleeding through on the release builds."
  const fire = (el: Element, init: MouseEventInit = {}) => {
    const e = new MouseEvent("contextmenu", { bubbles: true, cancelable: true, ...init });
    Object.defineProperty(e, "target", { value: el });
    return e;
  };

  it("stops the native menu on plain chrome", () => {
    const div = document.createElement("div");
    document.body.appendChild(div);
    const e = fire(div);
    expect(guardContextMenu(e)).toBe(true);
    expect(e.defaultPrevented).toBe(true);
    div.remove();
  });

  it("leaves it alone in a text field, where Cut, Copy and Paste live", () => {
    const input = document.createElement("input");
    document.body.appendChild(input);
    const e = fire(input);
    expect(guardContextMenu(e)).toBe(false);
    expect(e.defaultPrevented).toBe(false);
    input.remove();
  });

  it("keeps Inspect Element reachable in a dev build, behind Alt", () => {
    const div = document.createElement("div");
    document.body.appendChild(div);
    expect(guardContextMenu(fire(div, { altKey: true }), true)).toBe(false);
    // Alt alone does nothing in a shipped build.
    expect(guardContextMenu(fire(div, { altKey: true }), false)).toBe(true);
    div.remove();
  });
});
