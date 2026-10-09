import { flushAutosave, pendingAutosaveImage } from "../autosave";
// Quad edit: up to four photos taking the same adjustments at once.
//
// The settled design, after the owner's underexposed-frame example
// ("one was a little under exposed so you turn it up to balance it out
// then start the batch edit"): edits mirror as RELATIVE deltas onto
// each member's own values, always; ALT-click pins a pane out of the
// mirroring; the driver is the first selected photo and a pane click
// re-anchors.

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { App } from "../app";
import userEvent from "@testing-library/user-event";
import { initialState } from "../data";
import { reduce, type Command, type NodeCard, type State } from "../state";
import { loadGraph, mockResetGraphs, saveGraph } from "../bridge";
import { openQuadEdit, persistQuadMembers, queueQuadMembers } from "../quadedit";
import { QuadEditView } from "../ui/quadedit";

const run = (s: State, ...cmds: Command[]) => cmds.reduce(reduce, s);

beforeEach(() => mockResetGraphs());
afterEach(() => cleanup());

const grade = (nodes: NodeCard[]) =>
  nodes.find((n) => n.id === "portra")!.params.grade_strength;

/** A quad of the active photo and two more; 4866 starts with its grade
 * balanced down to 40 while the driver sits at 78. */
function quad(): State {
  const s0 = initialState();
  const balanced = structuredClone(s0.nodes);
  balanced.find((n) => n.id === "portra")!.params.grade_strength = 40;
  return run(s0, {
    type: "open_quad_edit",
    ids: [s0.activeImage, "4866", "4867"],
    graphs: {
      "4866": { nodes: balanced, wires: structuredClone(s0.wires) },
      "4867": { nodes: structuredClone(s0.nodes), wires: structuredClone(s0.wires) },
    },
  });
}

describe("Edit Together says why it is grayed", () => {
  /// "if there are too many selected photos then the
  /// status line should say as much when the mouse hovers that menu
  /// item."
  it("names the count when more than four are selected, on the Photo menu and the thumbnail's menu", async () => {
    const user = userEvent.setup();
    render(<App />);
    const thumbs = screen.getAllByTestId(/^thumb-\d+$/);
    await user.click(thumbs[0]);
    fireEvent.click(thumbs[4], { shiftKey: true });
    await user.click(screen.getByTestId("menu-photo"));
    const item = screen.getByTestId("menu-photo-quad");
    expect(item).toBeDisabled();
    expect(item.parentElement!.getAttribute("data-hint")).toMatch(/That is 5 selected; it takes two to four/);
    await user.keyboard("{Escape}");
    fireEvent.contextMenu(thumbs[0]);
    const row = screen.getByTestId("thumb-menu-quad");
    expect(row).toBeDisabled();
    expect(row.parentElement!.getAttribute("data-hint")).toMatch(/That is 5 photographs; Edit Together takes two to four/);
  });
});

describe("reset inside a quad", () => {
  /// "Reset all edits not working when editing 4 together.
  /// The thumbnails appeared to update but when I clicked on each of the
  /// other images in the canvas their edits were not reset." The member's
  /// live copy lives in quadGraphs, and close_quad_edit copies it back
  /// over graphs, so resetting only the stash was undone on the way out.
  it("resets a member's live quad copy, so the reset survives closing quad edit", () => {
    const s = quad();
    // What a reset photograph's graph looks like: the driver reset, as
    // the shape to compare the member against.
    const factory = reduce(s, { type: "reset_image_edits", id: s.activeImage }).nodes;
    const shape = (nodes: NodeCard[]) => nodes.map((n) => `${n.id}:${JSON.stringify(n.params)}`).sort();
    expect(grade(s.quadGraphs["4866"].nodes)).toBe(40);
    const reset = reduce(s, { type: "reset_image_edits", id: "4866" });
    expect(shape(reset.quadGraphs["4866"].nodes)).toEqual(shape(factory));
    expect(reset.images.find((i) => i.id === "4866")!.edited).toBe(false);
    // The driver's own graph and the other member are untouched.
    expect(grade(reset.nodes)).toBe(grade(s.nodes));
    expect(reset.quadGraphs["4867"]).toBe(s.quadGraphs["4867"]);
    const closed = reduce(reset, { type: "close_quad_edit" });
    expect(shape(closed.graphs["4866"].nodes)).toEqual(shape(factory));
  });
});

describe("opening and closing", () => {
  it("takes two to four photos, first one drives", () => {
    const s = quad();
    expect(s.quadEdit).not.toBeNull();
    expect(s.quadEdit!.driver).toBe(s.activeImage);
    expect(s.quadEdit!.pinned).toEqual([]);
    expect(Object.keys(s.quadGraphs).sort()).toEqual(["4866", "4867"]);
    expect(s.imageSelection).toEqual(s.quadEdit!.ids);
  });

  it("refuses one photo, five photos, and Graph mode", () => {
    const s0 = initialState();
    expect(run(s0, { type: "open_quad_edit", ids: ["4871"], graphs: {} }).quadEdit).toBeNull();
    expect(
      run(s0, {
        type: "open_quad_edit",
        ids: ["4871", "4866", "4867", "4868", "4869"],
        graphs: {},
      }).quadEdit,
    ).toBeNull();
    const graphMode = { ...s0, mode: "advanced" as const };
    expect(
      reduce(graphMode, { type: "open_quad_edit", ids: ["4871", "4866"], graphs: {} }).quadEdit,
    ).toBeNull();
  });

  it("closing folds the members back into the per-photo stash", () => {
    const s = run(quad(), { type: "close_quad_edit" });
    expect(s.quadEdit).toBeNull();
    expect(s.quadGraphs).toEqual({});
    expect(grade(s.graphs["4866"].nodes)).toBe(40);
  });

  it("walking to another photo or leaving simple mode closes it", () => {
    const away = run(quad(), { type: "select_image", id: "4869" });
    expect(away.quadEdit).toBeNull();
    expect(away.graphs["4866"]).toBeDefined();
    const graphMode = run(quad(), { type: "set_mode", mode: "advanced" });
    expect(graphMode.quadEdit).toBeNull();
    expect(graphMode.graphs["4866"]).toBeDefined();
  });
});

describe("the mirroring", () => {
  it("a slider move lands as a delta on each member's own value", () => {
    // Driver 78 -> 88 is +10: the balanced member keeps its head start.
    const s = run(quad(), {
      type: "set_param",
      id: "portra",
      param: "grade_strength",
      value: 88,
    });
    expect(grade(s.nodes)).toBe(88);
    expect(grade(s.quadGraphs["4866"].nodes)).toBe(50); // 40 + 10
    expect(grade(s.quadGraphs["4867"].nodes)).toBe(88); // 78 + 10
  });

  it("undo mirrors the compensating delta back", () => {
    const s = run(
      quad(),
      { type: "set_param", id: "portra", param: "grade_strength", value: 88 },
      { type: "undo" },
    );
    expect(grade(s.nodes)).toBe(78);
    expect(grade(s.quadGraphs["4866"].nodes)).toBe(40);
  });

  it("a pinned pane sits the edit out", () => {
    const s = run(
      quad(),
      { type: "quad_toggle_pin", id: "4866" },
      { type: "set_param", id: "portra", param: "grade_strength", value: 88 },
    );
    expect(s.quadEdit!.pinned).toEqual(["4866"]);
    expect(grade(s.quadGraphs["4866"].nodes)).toBe(40); // untouched
    expect(grade(s.quadGraphs["4867"].nodes)).toBe(88);
    // Unpinning is the same click again; the driver can never be pinned.
    const unpinned = run(s, { type: "quad_toggle_pin", id: "4866" });
    expect(unpinned.quadEdit!.pinned).toEqual([]);
    expect(run(s, { type: "quad_toggle_pin", id: s.quadEdit!.driver }).quadEdit!.pinned).toEqual([
      "4866",
    ]);
  });

  it("a flag param copies whole instead of drifting", () => {
    // invert is a 0/1 toggle in number clothes: 0->1 must not become
    // 1->2 on a member that was already inverted.
    const s0 = quad();
    const preInverted = structuredClone(s0.quadGraphs["4866"].nodes);
    preInverted.find((n) => n.id === "portra")!.params.invert = 1;
    const s1 = {
      ...s0,
      quadGraphs: { ...s0.quadGraphs, "4866": { ...s0.quadGraphs["4866"], nodes: preInverted } },
    };
    const s = reduce(s1 as State, { type: "set_param", id: "portra", param: "invert", value: 1 });
    expect(s.quadGraphs["4866"].nodes.find((n) => n.id === "portra")!.params.invert).toBe(1);
    expect(s.quadGraphs["4867"].nodes.find((n) => n.id === "portra")!.params.invert).toBe(1);
  });
});

describe("anchoring", () => {
  it("clicking a pane makes it the driver, graphs swapped", () => {
    const edited = run(quad(), {
      type: "set_param",
      id: "portra",
      param: "grade_strength",
      value: 88,
    });
    const s = run(edited, { type: "quad_anchor", id: "4866" });
    expect(s.quadEdit!.driver).toBe("4866");
    expect(s.activeImage).toBe("4866");
    expect(grade(s.nodes)).toBe(50); // the member's own graph is live now
    expect(s.quadGraphs["4866"]).toBeUndefined();
    expect(grade(s.quadGraphs[edited.quadEdit!.driver].nodes)).toBe(88);
    // Undo history stays with the graph it was recorded against.
    expect(s.undoStack).toEqual([]);
  });

  it("edits after the swap still mirror, from the new driver", () => {
    const s = run(
      quad(),
      { type: "quad_anchor", id: "4866" },
      { type: "set_param", id: "portra", param: "grade_strength", value: 45 },
    );
    // New driver went 40 -> 45; the old driver's member copy moves +5.
    expect(grade(s.nodes)).toBe(45);
    expect(grade(s.quadGraphs[initialState().activeImage].nodes)).toBe(83);
  });
});

describe("the view", () => {
  it("shows a pane per photo, driver marked, DONE and Escape leave", () => {
    const s = quad();
    const sent: Command[] = [];
    render(
      <QuadEditView
        state={s}
        dispatch={((c: Command) => sent.push(c)) as never}
        previewUrl={null}
        quadFrames={{}}
      />,
    );
    for (const id of s.quadEdit!.ids) {
      expect(screen.getByTestId(`quad-pane-${id}`)).toBeInTheDocument();
    }
    expect(screen.getByTestId(`quad-driving-${s.quadEdit!.driver}`)).toBeInTheDocument();
    fireEvent.click(screen.getByTestId("quad-done"));
    fireEvent.keyDown(window, { key: "Escape" });
    expect(sent).toEqual([{ type: "close_quad_edit" }, { type: "close_quad_edit" }]);
  });

  it("a click re-anchors, an ALT-click pins, and the badge shows", () => {
    const s = quad();
    const sent: Command[] = [];
    const view = render(
      <QuadEditView
        state={s}
        dispatch={((c: Command) => sent.push(c)) as never}
        previewUrl={null}
        quadFrames={{}}
      />,
    );
    fireEvent.click(screen.getByTestId("quad-pane-4866"));
    fireEvent.click(screen.getByTestId("quad-pane-4867"), { altKey: true });
    // Clicking the driver anchors nothing: it already drives.
    fireEvent.click(screen.getByTestId(`quad-pane-${s.quadEdit!.driver}`));
    expect(sent).toEqual([
      { type: "quad_anchor", id: "4866" },
      { type: "quad_toggle_pin", id: "4867" },
    ]);
    view.unmount();

    const pinned = run(s, { type: "quad_toggle_pin", id: "4867" });
    render(
      <QuadEditView state={pinned} dispatch={(() => {}) as never} previewUrl={null} quadFrames={{}} />,
    );
    expect(screen.getByTestId("quad-pin-4867")).toBeInTheDocument();
    expect(screen.getByTestId("quad-pane-4867")).toHaveAttribute("data-pinned");
  });
});

describe("the async side", () => {
  it("opening pulls member graphs from their files", async () => {
    await saveGraph("4866", { nodes: [{ id: "n1" }], wires: [] });
    const s0 = initialState();
    const sent: Command[] = [];
    await openQuadEdit(s0, (c) => sent.push(c), [s0.activeImage, "4866"]);
    const open = sent.find((c) => c.type === "open_quad_edit") as Extract<
      Command,
      { type: "open_quad_edit" }
    >;
    expect(open).toBeDefined();
    expect(open.ids).toEqual([s0.activeImage, "4866"]);
    expect(open.graphs["4866"].nodes).toEqual([{ id: "n1" }]);
    // The driver was already active: no photo switch, no mode switch.
    expect(sent.some((c) => c.type === "select_image")).toBe(false);
    expect(sent.some((c) => c.type === "set_mode")).toBe(false);
  });

  it("opening from elsewhere switches photo and mode first", async () => {
    const s0 = { ...initialState(), mode: "advanced" as const };
    const sent: Command[] = [];
    await openQuadEdit(s0 as State, (c) => sent.push(c), ["4866", "4867"]);
    expect(sent[0]).toEqual({ type: "set_mode", mode: "simple" });
    expect(sent[1]).toEqual({ type: "select_image", id: "4866" });
    expect(sent[2].type).toBe("open_quad_edit");
  });

  it("persisting writes each member's file and marks it edited", async () => {
    const s = run(quad(), {
      type: "set_param",
      id: "portra",
      param: "grade_strength",
      value: 88,
    });
    const sent: Command[] = [];
    await persistQuadMembers(s, (c) => sent.push(c));
    await waitFor(async () => {
      const g = (await loadGraph("4866")) as any;
      expect(g).not.toBeNull();
      expect(grade(g.nodes)).toBe(50);
    });
    expect(sent).toContainEqual({ type: "mark_edited", id: "4866" });
    expect(sent).toContainEqual({ type: "mark_edited", id: "4867" });
  });
});

it("leaving quad edit inside the debounce window keeps member writes for close", async () => {
  const s = run(initialState(), { type: "open_quad_edit", ids: ["4871", "4866"], graphs: {} });
  const commands: Command[] = [];
  queueQuadMembers(s, c => commands.push(c), 3000);
  expect(pendingAutosaveImage()).not.toBeNull();
  const closed = reduce(s, { type: "close_quad_edit" });
  expect(closed.quadEdit).toBeNull();
  await flushAutosave();
  for (const id of Object.keys(s.quadGraphs).filter(id => id !== s.activeImage)) {
    expect(await loadGraph(id)).not.toBeNull();
  }
  expect(pendingAutosaveImage()).toBeNull();
});
