// The bakes' progress dialog (2026-09-30: "Bake Warp was really slow. I
// think a dialog should pop up with a progress bar if this is a slow
// process otherwise the user will think something is wrong.").
//
// Held here: a bake that runs past half a second shows a modal dialog,
// portaled to the body, with its plain line, a bar and the stage the
// desktop reports, and a bake that lands sooner shows nothing; the
// dialog's Cancel reaches the desktop's cancel registry, and a canceled
// Bake Warp leaves the Warp layer and the undo history exactly as they
// were, whether the desktop answers "Bake canceled" or its result lands
// as Cancel is pressed; New Layer via Copy runs under the same dialog.
// The desktop's half (nothing written once canceled, the settle in
// flight giving way) is src-tauri/src/warp_bake.rs.
//
// Every test builds its own state and reads only what it made.
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { initialState, NEUTRAL_NODES, NEUTRAL_WIRES } from "../data";
import { artLayers, reduce, type Command, type State } from "../state";
import { runBakeWarp } from "../layeractions";
import { BAKE_DIALOG_DELAY_MS, BakeProgressDialog, OpProgressOverlay, clearAllOps, watchBake } from "../ui/opprogress";
import { mockResetOps } from "../bridge";
import { noteFrameAspect } from "../imagelayers";
import { BAKE_DIALOG_BACKUP_LINE } from "../bakedbackups";

// The event bus the Tauri listen path lands on, so a test can emit what
// the desktop's bake reports (opprogress.test.tsx's harness).
const bus = vi.hoisted(() => new Map<string, ((e: { payload: unknown }) => void)[]>());
vi.mock("@tauri-apps/api/event", () => ({
  emit: async (channel: string, payload: unknown) => {
    for (const fn of bus.get(channel) ?? []) fn({ payload });
  },
  listen: async (channel: string, fn: (e: { payload: unknown }) => void) => {
    const list = bus.get(channel) ?? [];
    list.push(fn);
    bus.set(channel, list);
    return () => bus.set(channel, (bus.get(channel) ?? []).filter((f) => f !== fn));
  },
}));
const invokeMock = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));

async function report(done: number, total: number, message: string, id = "bake-3") {
  const { emit } = await import("@tauri-apps/api/event");
  await act(async () => {
    await emit("heeler:progress", { op: "bake", id, done, total, message });
  });
}

const wait = (ms: number) => act(() => new Promise((r) => setTimeout(r, ms)));

afterEach(() => {
  cleanup();
  clearAllOps();
  mockResetOps();
  bus.clear();
  invokeMock.mockReset();
  delete (window as any).__TAURI_INTERNALS__;
});

function tauri() {
  (window as any).__TAURI_INTERNALS__ = { invoke: invokeMock };
}

describe("baking a stack that has to merge first", () => {
  // 2026-10-08: the merge's card showed behind the Bake dialog;
  // "close the backing dialog, show the stacking dialog, then show a
  // baking progress dialog".
  const merge = { jobId: "stack-41", image: "stk", done: 120, total: 675, pass: 0, passes: 1, frames: 675, missing: 0, mode: "min", full: true, elapsedMs: 4000 };
  it("shows the merge's card in the bake's dialog at once, then the bake's bar", async () => {
    tauri();
    const view = render(<BakeProgressDialog merge={merge} />);
    let land!: (v: string) => void;
    const done = watchBake("Baking stk.stack", () => new Promise<string>((r) => (land = r)));
    await report(0, 2, "Reading the photograph", "bake-merge-1");
    // At once, no half-second wait: the merge is the long part.
    const card = screen.getByTestId("bake-merge");
    expect(card).toHaveAttribute("aria-modal", "true");
    expect(card).toHaveTextContent("Merging 675 frames");
    expect(card).toHaveTextContent("Cancel merge");
    expect(screen.queryByTestId("bake-dialog")).toBeNull();
    // The merge lands: the bake's own bar.
    view.rerender(<BakeProgressDialog merge={null} />);
    await report(1, 2, "Rendering the edits and writing the file", "bake-merge-1");
    await wait(BAKE_DIALOG_DELAY_MS + 80);
    expect(screen.queryByTestId("bake-merge")).toBeNull();
    expect(screen.getByTestId("bake-dialog-stage")).toHaveTextContent("Rendering the edits and writing the file");
    await act(async () => land("baked"));
    await done;
  });

  it("Escape on the merge's card cancels the merge and the bake waiting on it", async () => {
    tauri();
    render(<BakeProgressDialog merge={merge} />);
    const done = watchBake("Baking stk.stack", () => new Promise<string>(() => {}));
    await report(0, 2, "Reading the photograph", "bake-merge-2");
    fireEvent.keyDown(screen.getByTestId("bake-merge"), { key: "Escape" });
    await waitFor(() => {
      const canceled = invokeMock.mock.calls.filter(([cmd]) => cmd === "cancel_operation").map(([, a]) => (a as { id: string }).id);
      expect(canceled).toEqual(expect.arrayContaining(["stack-41", "bake-merge-2"]));
    });
    void done;
  });

  it("puts the merge's card over the canvas, where the canvas's own card would be", async () => {
    tauri();
    const stage = document.createElement("div");
    stage.dataset.testid = "viewer-stage";
    stage.getBoundingClientRect = () => ({ left: 300, top: 60, width: 1000, height: 800, right: 1300, bottom: 860, x: 300, y: 60, toJSON: () => ({}) }) as DOMRect;
    document.body.appendChild(stage);
    try {
      render(<BakeProgressDialog merge={merge} />);
      const done = watchBake("Baking stk.stack", () => new Promise<string>(() => {}));
      await report(0, 2, "Reading the photograph", "bake-merge-3");
      const card = screen.getByTestId("stack-merge");
      expect(card.style.left).toBe("800px");
      expect(card.style.top).toBe("460px");
      void done;
    } finally {
      stage.remove();
    }
  });

  it("shows nothing for a merge while no bake is running", () => {
    render(<BakeProgressDialog merge={merge} />);
    expect(screen.queryByTestId("bake-merge")).toBeNull();
  });
});

describe("the bake's dialog", () => {
  it("shows for a bake that runs past half a second, portaled to the body, and goes when it lands", async () => {
    tauri();
    let land!: (v: string) => void;
    render(
      <div className="ui-zoom" data-testid="zoomed">
        <BakeProgressDialog />
        <OpProgressOverlay />
      </div>,
    );
    const done = watchBake("Baking the warp at full size", () => new Promise<string>((r) => (land = r)));
    await report(1, 6, "Rendering the layers below at full size");
    // Not yet: a quick bake flashes nothing.
    expect(screen.queryByTestId("bake-dialog")).toBeNull();
    await wait(BAKE_DIALOG_DELAY_MS + 80);
    const dialog = screen.getByTestId("bake-dialog");
    expect(dialog).toHaveAttribute("aria-modal", "true");
    expect(screen.getByTestId("bake-dialog-title")).toHaveTextContent("Baking the warp at full size");
    expect(screen.getByTestId("bake-dialog-stage")).toHaveTextContent("Rendering the layers below at full size");
    expect(screen.getByTestId("bake-dialog-bar")).toHaveStyle({ width: "17%" });
    // On the body, outside the zoomed panel (the ui-zoom trap), and not
    // a row of the overlay as well.
    expect(screen.getByTestId("zoomed").contains(dialog)).toBe(false);
    expect(dialog.closest("body")).toBe(document.body);
    expect(screen.queryByTestId("op-progress")).toBeNull();
    await report(4, 6, "Baking the warp at full size");
    expect(screen.getByTestId("bake-dialog-bar")).toHaveStyle({ width: "67%" });
    await act(async () => land("kept"));
    await expect(done).resolves.toBe("kept");
    expect(screen.queryByTestId("bake-dialog")).toBeNull();
  });

  it("says under its title what the bake's launcher hands it, and nothing when handed nothing", async () => {
    tauri();
    render(<BakeProgressDialog />);
    let land!: (v: string) => void;
    const done = watchBake("Baking the warp at full size", () => new Promise<string>((r) => (land = r)), BAKE_DIALOG_BACKUP_LINE);
    await report(1, 6, "Rendering the layers below at full size", "bake-note");
    await wait(BAKE_DIALOG_DELAY_MS + 80);
    expect(screen.getByTestId("bake-dialog-note")).toHaveTextContent(BAKE_DIALOG_BACKUP_LINE);
    await act(async () => land("kept"));
    await done;
    const again = watchBake("Baking the warp at full size", () => new Promise<string>((r) => (land = r)));
    await report(1, 6, "Rendering the layers below at full size", "bake-plain");
    await wait(BAKE_DIALOG_DELAY_MS + 80);
    expect(screen.getByTestId("bake-dialog")).toBeInTheDocument();
    expect(screen.queryByTestId("bake-dialog-note")).toBeNull();
    await act(async () => land("kept"));
    await again;
  });

  it("never shows for a bake that lands within half a second", async () => {
    tauri();
    render(<BakeProgressDialog />);
    let land!: (v: string) => void;
    const done = watchBake("Baking the warp at full size", () => new Promise<string>((r) => (land = r)));
    await report(1, 6, "Rendering the layers below at full size");
    await wait(BAKE_DIALOG_DELAY_MS / 3);
    expect(screen.queryByTestId("bake-dialog")).toBeNull();
    await act(async () => land("kept"));
    await expect(done).resolves.toBe("kept");
    await wait(BAKE_DIALOG_DELAY_MS);
    expect(screen.queryByTestId("bake-dialog")).toBeNull();
  });
});

function fresh(): State {
  noteFrameAspect("bake_progress", 1.5);
  return {
    ...initialState(),
    activeImage: "bake_progress",
    mode: "simple",
    panelTab: "layers",
    nodes: structuredClone(NEUTRAL_NODES),
    wires: structuredClone(NEUTRAL_WIRES),
  };
}

/** A Pixel layer under a Warp layer, the Warp layer active, the tool
 * down; and a dispatch that runs the reducer over a held state. */
function warpLayer() {
  const s = [{ type: "art_add_layer", kind: "paint" }, { type: "art_add_layer", kind: "warp" }, { type: "set_tool", tool: "none" }].reduce(
    (st, c) => reduce(st, c as Command),
    fresh(),
  );
  const blend = artLayers(s)[1].blend.id;
  let current = s;
  const sent: Command[] = [];
  const dispatch = (c: Command) => {
    sent.push(c);
    current = reduce(current, c);
  };
  return { s, blend, dispatch, sent, latest: () => current };
}

describe("Cancel", () => {
  for (const answer of ["Bake canceled", "lands anyway"] as const) {
    it(`leaves the Warp layer and the undo history as they were (${answer})`, async () => {
      tauri();
      let settle!: (v: unknown) => void;
      let fail!: (e: unknown) => void;
      invokeMock.mockImplementation(async (cmd: string) => {
        if (cmd === "bake_warp_layer") return new Promise((res, rej) => ((settle = res), (fail = rej)));
        return null;
      });
      const { s, blend, dispatch, sent, latest } = warpLayer();
      render(<BakeProgressDialog />);
      runBakeWarp(s, dispatch, blend);
      await waitFor(() => expect(invokeMock).toHaveBeenCalledWith("bake_warp_layer", expect.objectContaining({ carrierId: blend })));
      await report(1, 6, "Rendering the layers below at full size", "bake-9");
      await wait(BAKE_DIALOG_DELAY_MS + 80);
      fireEvent.click(screen.getByTestId("bake-dialog-cancel"));
      await waitFor(() => expect(invokeMock).toHaveBeenCalledWith("cancel_operation", { id: "bake-9" }));
      await act(async () => {
        if (answer === "Bake canceled") fail("Bake canceled");
        else settle({ path: "/kept/feedfeedfeedfeed.tif", box: [0, 0, 1, 1], aspect: 1.5, width: 6000, height: 4000 });
      });
      await waitFor(() => expect(screen.queryByTestId("bake-dialog")).toBeNull());
      await wait(20);
      // Nothing but a fresh look at the preview: the layer, its graph
      // and the history are the ones the bake started from.
      expect(sent.map((c) => c.type)).toEqual(["bump_preview"]);
      expect(latest().nodes).toEqual(s.nodes);
      expect(latest().undoStack).toBe(s.undoStack);
      expect(artLayers(latest())[1].content.type).toBe("heeler.layer_warp");
    });
  }

  it("a bake left alone lays its image layer down in the Warp layer's seat, one undo step", async () => {
    tauri();
    invokeMock.mockImplementation(async (cmd: string) =>
      cmd === "bake_warp_layer" ? { path: "/kept/feedfeedfeedfeed.tif", box: [0, 0, 1, 1], aspect: 1.5, width: 6000, height: 4000 } : null,
    );
    const { s, blend, dispatch, sent, latest } = warpLayer();
    runBakeWarp(s, dispatch, blend);
    await waitFor(() => expect(sent.map((c) => c.type)).toEqual(["art_bake_warp"]));
    expect(latest().undoStack.length).toBe(s.undoStack.length + 1);
    expect(artLayers(latest())[1].content.type).not.toBe("heeler.layer_warp");
  });
});

it("the bake dialog owns keyboard focus, traps Tab and cancels on Escape", async () => {
  tauri();
  render(<><button data-testid="bake-opener">Bake</button><BakeProgressDialog /></>);
  const opener = screen.getByTestId("bake-opener");
  opener.focus();
  let land!: (v: string) => void;
  const done = watchBake("Baking the warp at full size", () => new Promise<string>((r) => { land = r; }));
  await report(1, 6, "Rendering", "bake-keyboard");
  await wait(BAKE_DIALOG_DELAY_MS + 40);
  const cancel = screen.getByTestId("bake-dialog-cancel");
  expect(document.activeElement).toBe(cancel);
  fireEvent.keyDown(cancel, { key: "Tab" });
  expect(document.activeElement).toBe(cancel);
  const behind = vi.fn();
  window.addEventListener("keydown", behind);
  try {
    fireEvent.keyDown(cancel, { key: "ArrowRight" });
    expect(behind).not.toHaveBeenCalled();
    fireEvent.keyDown(cancel, { key: "Escape" });
    await waitFor(() => expect(invokeMock).toHaveBeenCalledWith("cancel_operation", { id: "bake-keyboard" }));
    await act(async () => land("late answer"));
    await expect(done).resolves.toBeNull();
    expect(document.activeElement).toBe(opener);
  } finally {
    window.removeEventListener("keydown", behind);
  }
});
