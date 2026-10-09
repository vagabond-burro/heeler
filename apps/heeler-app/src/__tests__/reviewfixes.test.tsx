// The second review's findings, pinned by the tests it did not bring.
//
// Accepted: renderVersion (the render pump no longer pays a full
// engine re-render for a node drag), the group boundary keeping one
// wire per SENDER rather than per port, the group dialog's description
// finally landing somewhere, dead graph-sidebar buttons wired or
// removed, and brush strokes ending where the pointer released.
//
// Adjusted during acceptance: the Add button opens the ADD palette
// (the review pointed it at /-search, which selects existing nodes),
// and the stroke-endpoint fix's call site passed a MouseEvent where a
// point belonged, which made the fix a no-op; it now passes the
// normalized pointer position.

import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { initialState } from "../data";
import { flattenGroups, reduce, type Command, type State } from "../state";
import { App } from "../app";
import { GroupDialog } from "../ui/graph";
import { BrushOverlay } from "../ui/overlays";

describe("renderVersion: the pump's key", () => {
  const v = (s: State) => s.renderVersion;

  it("bumps for edits the engine can see", () => {
    let s = initialState();
    const before = v(s);
    s = reduce(s, { type: "set_param", id: "exposure", param: "exposure", value: 1 });
    expect(v(s)).toBeGreaterThan(before);
    const afterParam = v(s);
    s = reduce(s, { type: "set_enabled", id: "grain", enabled: false });
    expect(v(s)).toBeGreaterThan(afterParam);
    // Undo restores old pixels, which is a render too.
    const afterToggle = v(s);
    s = reduce(s, { type: "undo" });
    expect(v(s)).toBeGreaterThan(afterToggle);
  });

  it("stays put for layout, names, tints and notes", () => {
    let s = initialState();
    const before = v(s);
    s = reduce(s, { type: "move_node", id: "exposure", x: 500, y: 500 });
    s = reduce(s, { type: "rename_node", id: "exposure", name: "Sunlight" });
    s = reduce(s, { type: "set_node_tint", id: "exposure", tint: "#a55" });
    s = reduce(s, { type: "set_node_note", id: "exposure", note: "the key light" });
    expect(v(s)).toBe(before);
    // And view state was never in the pump's world to begin with.
    s = reduce(s, { type: "set_zoom", zoom: "fit" });
    expect(v(s)).toBe(before);
  });
});

describe("grouping keeps every sender", () => {
  it("two masks feeding two members on the same port both survive", () => {
    // lummask already feeds Color Balance's mask port; wire brushmask
    // into Exposure's the ordinary way, giving two senders on the same
    // port name: exactly the case the old per-port dedupe silently
    // halved.
    let s = initialState();
    s = reduce(s, {
      type: "connect",
      wire: { from: "brushmask", to: "exposure", toPort: "mask", kind: "mask" },
    });
    const masksBefore = s.wires.filter(
      (w) => w.kind === "mask" && ["cbal", "exposure"].includes(w.to)
    );
    expect(masksBefore).toHaveLength(2);
    s = reduce(s, { type: "select_nodes", ids: ["cbal", "exposure"] });
    s = reduce(s, { type: "group_selection", name: "Graded" });
    const gid = s.nodes.find((n) => n.name === "Graded")!.id;
    const toGroup = s.wires.filter((w) => w.to === gid && w.kind === "mask");
    expect(toGroup).toHaveLength(2);
    expect(new Set(toGroup.map((w) => w.from))).toEqual(new Set(["lummask", "brushmask"]));

    // And the flattener sends each one home by its sender, so the
    // engine renders what was wired before the group existed.
    const flat = flattenGroups(s.nodes, s.wires);
    const routed = flat.wires.filter((w) => w.kind === "mask" && ["cbal", "exposure"].includes(w.to));
    expect(routed.find((w) => w.to === "cbal")?.from).toBe("lummask");
    expect(routed.find((w) => w.to === "exposure")?.from).toBe("brushmask");
  });
});

describe("the group dialog's description", () => {
  it("lands on the group node as its note", () => {
    let s = initialState();
    s = reduce(s, { type: "select_nodes", ids: ["stdcolor", "cbal"] });
    s = reduce(s, { type: "group_selection", name: "Warmth", note: "  skin first  " });
    expect(s.nodes.find((n) => n.name === "Warmth")!.note).toBe("skin first");
    // No description stays no note, not an empty string on every group.
    let s2 = initialState();
    s2 = reduce(s2, { type: "select_nodes", ids: ["stdcolor", "cbal"] });
    s2 = reduce(s2, { type: "group_selection", name: "Plain", note: "   " });
    expect(s2.nodes.find((n) => n.name === "Plain")!.note).toBeUndefined();
  });

  it("the dialog reads its textarea instead of discarding it", async () => {
    const user = userEvent.setup();
    const sent: Command[] = [];
    const s = { ...initialState(), groupDialogOpen: true, selection: ["stdcolor", "cbal"] };
    render(<GroupDialog state={s} dispatch={(c) => sent.push(c)} />);
    await user.type(screen.getByLabelText("Group description"), "cool the shadows");
    await user.click(screen.getByTestId("dialog-save-group"));
    const cmd = sent.find((c) => c.type === "group_selection") as
      | { type: "group_selection"; note?: string }
      | undefined;
    expect(cmd?.note).toBe("cool the shadows");
  });
});

describe("the graph sidebar's Add button", () => {
  it("opens the add palette, not the find-and-select search", async () => {
    const user = userEvent.setup();
    render(<App />);
    await user.click(screen.getByRole("tablist", { name: /workspace mode/i }).children[1]);
    await user.click(screen.getByTestId("palette-add"));
    expect(screen.getByTestId("node-palette")).toBeInTheDocument();
    expect(screen.queryByTestId("graph-search")).not.toBeInTheDocument();
  });
});

describe("a stroke ends where the pointer released", () => {
  const overlaySized = () => {
    const overlay = screen.getByTestId("brush-overlay");
    Object.defineProperty(overlay, "clientWidth", { value: 400, configurable: true });
    Object.defineProperty(overlay, "clientHeight", { value: 300, configurable: true });
    Object.defineProperty(overlay, "offsetWidth", { value: 400, configurable: true });
    Object.defineProperty(overlay, "offsetHeight", { value: 300, configurable: true });
    overlay.getBoundingClientRect = () =>
      ({ left: 0, top: 0, width: 400, height: 300, right: 400, bottom: 300, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect;
    return overlay;
  };

  const node = { id: "b", type: "heeler.brush_mask", strokes: [] } as never;

  it("appends the release point when it is past the last move", () => {
    const sent: Command[] = [];
    render(<BrushOverlay node={node} radius={0.1} dispatch={(c) => sent.push(c)} tip="circle" />);
    const overlay = overlaySized();
    fireEvent.mouseDown(overlay, { clientX: 100, clientY: 100, buttons: 1 });
    fireEvent.mouseMove(overlay, { clientX: 200, clientY: 150, buttons: 1 });
    fireEvent.mouseUp(overlay, { clientX: 300, clientY: 225 });
    const stroke = (sent.find((c) => c.type === "add_stroke") as { stroke: { points: [number, number][] } }).stroke;
    const last = stroke.points[stroke.points.length - 1];
    expect(last[0]).toBeCloseTo(0.75, 5);
    expect(last[1]).toBeCloseTo(0.75, 5);
  });

  it("does not duplicate the point when the release matches the last move", () => {
    const sent: Command[] = [];
    render(<BrushOverlay node={node} radius={0.1} dispatch={(c) => sent.push(c)} tip="circle" />);
    const overlay = overlaySized();
    fireEvent.mouseDown(overlay, { clientX: 100, clientY: 100, buttons: 1 });
    fireEvent.mouseMove(overlay, { clientX: 200, clientY: 150, buttons: 1 });
    fireEvent.mouseUp(overlay, { clientX: 200, clientY: 150 });
    const stroke = (sent.find((c) => c.type === "add_stroke") as { stroke: { points: [number, number][] } }).stroke;
    expect(stroke.points).toHaveLength(2);
  });
});
