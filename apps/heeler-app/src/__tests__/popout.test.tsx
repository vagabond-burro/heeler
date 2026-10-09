import { afterEach, describe, expect, it, vi } from "vitest";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { App } from "../app";
import { GraphWindow } from "../ui/graphwindow";
import { Inspector } from "../ui/graph";
import { SpectrumWindow } from "../ui/spectrumwindow";
import { TakesWindow } from "../ui/takeswindow";
import { dragTrack } from "./trackdrive";
// Static, like App and GraphWindow above: a dynamic import after some
// other test's vi.resetModules() loads a FRESH module graph whose
// transport is a different instance than the one setTransport poked,
// and the window then talks on a bus nobody is listening to.
import { ToolWindow } from "../ui/toolwindow";
import { announceConsoleWindow, consoleWindowLive } from "../ui/console";
import { fireEvent } from "@testing-library/react";
import { initialState } from "../data";
import {
  CMD_CHANNEL,
  DOCK_CHANNEL,
  SPECTRUM_LABEL,
  TAKES_LABEL,
  STATE_CHANNEL,
  STATE_REQUEST,
  applySnapshot,
  followPopout,
  graphSnapshot,
  openConsoleWindow,
  reportPresentation,
  setTransport,
  windowRole,
  type Transport,
} from "../popout";
import { getEntries } from "../log";
import { reduce, type State } from "../state";
import { toolMemberId } from "../recipes";
import { _clearFlashForTests, currentFlash } from "../ui/hints";

/** In-process stand-in for Tauri events: everything subscribed to a
 * channel hears everything sent on it, which is how the real transport
 * behaves across windows. */
function fakeTransport() {
  const subs = new Map<string, ((p: unknown) => void)[]>();
  const sent: { channel: string; payload: unknown }[] = [];
  const t: Transport & { sent: typeof sent } = {
    sent,
    send(channel, payload) {
      sent.push({ channel, payload });
      [...(subs.get(channel) ?? [])].forEach((f) => f(payload));
    },
    subscribe(channel, fn) {
      const list = subs.get(channel) ?? [];
      list.push(fn);
      subs.set(channel, list);
      return () => subs.set(channel, (subs.get(channel) ?? []).filter((f) => f !== fn));
    },
  };
  setTransport(t);
  return t;
}

afterEach(() => {
  _clearFlashForTests();
  setTransport(null);
});

describe("graph pop-out", () => {
  it("reads its role from the query string", () => {
    expect(windowRole("")).toBe("main");
    expect(windowRole("?view=graph")).toBe("graph");
    expect(windowRole("?view=graph&x=1")).toBe("graph");
    expect(windowRole("?view=canvas")).toBe("main");
    // Every pop-out role, not just the graph. This knew only about
    // "graph", so ?view=spectrum quietly loaded a second copy of the
    // whole app: inside Tauri the window label covers for it, but in a
    // browser it made the window impossible to open at all.
    expect(windowRole("?view=spectrum")).toBe("spectrum");
    expect(windowRole("?view=spectrum&x=1")).toBe("spectrum");
  });

  it("falls back to the main role when the window cannot be identified", async () => {
    const { resolveWindowRole } = await import("../popout");
    // No Tauri and no query string: this is the main window.
    await expect(resolveWindowRole()).resolves.toBe("main");
  });

  it("a snapshot carries the graph but not the baggage", () => {
    let s = initialState();
    s = reduce(s, { type: "select_nodes", ids: ["cbal"] });
    s = reduce(s, { type: "set_param", id: "exposure", param: "exposure", value: 1 });
    const snap = graphSnapshot(s) as Record<string, unknown>;
    expect(snap.nodes).toBe(s.nodes);
    expect(snap.wires).toBe(s.wires);
    expect(snap.selection).toEqual(["cbal"]);
    // The other images' saved graphs and the undo stacks are the bulk of
    // the state and mean nothing to the graph surface.
    expect(snap.graphs).toBeUndefined();
    expect(snap.undoStack).toBeUndefined();

    const rebuilt = applySnapshot(initialState(), graphSnapshot(s));
    expect(rebuilt.nodes).toEqual(s.nodes);
    expect(rebuilt.undoStack).toEqual([]);
  });

  it("the popped-out window renders the main window's graph and sends edits back", async () => {
    const user = userEvent.setup();
    fakeTransport();
    // The main window has to be listening before the graph window opens.
    render(<App />);
    await user.click(screen.getByRole("tablist", { name: /workspace mode/i }).children[1]);
    await user.click(screen.getByTestId("graph-popout"));

    // Its pane has collapsed to the dock bar, so there is exactly one
    // node editor in play once the graph window mounts. The bar takes
    // the divider's place too: there is nothing left to resize.
    expect(screen.getByTestId("graph-dock")).toHaveTextContent(/bring it back/i);
    expect(screen.queryByTestId("node-editor")).not.toBeInTheDocument();
    expect(screen.queryByTestId("divider-graph")).not.toBeInTheDocument();

    render(<GraphWindow />);
    // Mounting announced itself, the main window answered with a
    // snapshot, and the graph drew.
    expect(screen.queryByTestId("graph-window-waiting")).not.toBeInTheDocument();
    const editor = screen.getByTestId("node-editor");
    expect(within(editor).getByTestId("node-exposure")).toBeInTheDocument();

    // An edit made out there is reduced back here: click a node, and the
    // selection that comes back is the main window's.
    await user.click(within(editor).getByTestId("node-cbal"));
    const inspector = within(screen.getByTestId("graph-window")).getByTestId("inspector");
    expect(inspector).toHaveTextContent(/color balance/i);
    // And the spectrums sit under its header, reading the main window's
    // frame over the channel (2026-09-08: "the pop out graph view's
    // inspector does not show the histogram").
    expect(within(inspector).getByTestId("spectrums")).toBeInTheDocument();
  });

  it("deletes a member through the thin client while the main window has its group open", async () => {
    const user = userEvent.setup();
    const t = fakeTransport();
    render(<App />);
    await user.click(screen.getByRole("tablist", { name: /workspace mode/i }).children[1]);
    act(() => t.send(CMD_CHANNEL, { type: "set_category", title: "Sharpening", on: true }));
    act(() => t.send(CMD_CHANNEL, { type: "open_group", id: "sharpening" }));
    await user.click(screen.getByTestId("graph-popout"));
    render(<GraphWindow />);
    const win = screen.getByTestId("graph-window");
    const id = toolMemberId("sharpening", "sharp", "inv");
    const snapshot = () => t.sent.filter((m) => m.channel === STATE_CHANNEL).slice(-1)[0].payload as State;
    const before = snapshot();
    expect(before.openedGroup).toBe("sharpening");
    const card = within(win).getByTestId(`node-${id}`);
    await user.click(card);
    fireEvent.contextMenu(card);
    // The graph's context menu sits on its window's body (portaled and
    // pinned to the window since 2026-10-01), not inside the graph.
    await user.click(within(screen.getByTestId("context-menu")).getByRole("menuitem", { name: "Delete" }));
    await waitFor(() => expect(within(win).queryByTestId(`node-${id}`)).toBeNull());
    expect(t.sent.some((m) => m.channel === CMD_CHANNEL &&
      (m.payload as { type: string; ids?: string[] }).type === "delete_nodes" &&
      (m.payload as { ids: string[] }).ids.includes(id))).toBe(true);
    const after = snapshot();
    expect(after.openedGroup).toBe("sharpening");
    expect(after.wires).toEqual(before.wires);
    expect(after.nodes.find((n) => n.id === "sharpening")!.groupNodes!.some((n) => n.id === id)).toBe(false);
    act(() => t.send(CMD_CHANNEL, { type: "undo" }));
    await waitFor(() => expect(within(win).getByTestId(`node-${id}`)).toBeInTheDocument());
  });

  it("only one window shows the inspector, and the bar hands it over", async () => {
    const user = userEvent.setup();
    fakeTransport();
    render(<App />);
    await user.click(screen.getByRole("tablist", { name: /workspace mode/i }).children[1]);
    // Docked, the main window owns it and there is no bar.
    expect(screen.getAllByTestId("inspector")).toHaveLength(1);
    expect(screen.queryByTestId("inspector-bar")).not.toBeInTheDocument();

    await user.click(screen.getByTestId("graph-popout"));
    render(<GraphWindow />);

    // Popped out, the graph window takes the inspector and the main
    // window folds to a spine. Never two of them.
    expect(screen.getAllByTestId("inspector")).toHaveLength(1);
    const graphWin = screen.getByTestId("graph-window");
    expect(within(graphWin).getByTestId("inspector")).toBeInTheDocument();
    expect(screen.getAllByTestId("inspector-bar")).toHaveLength(1);
    expect(within(graphWin).queryByTestId("inspector-bar")).not.toBeInTheDocument();

    // Clicking the main window's bar takes it back, and the graph
    // window's own inspector folds away in the same move.
    await user.click(screen.getByTestId("inspector-bar"));
    expect(screen.getAllByTestId("inspector")).toHaveLength(1);
    expect(within(graphWin).getByTestId("inspector-bar")).toBeInTheDocument();
    expect(within(graphWin).queryByTestId("inspector")).not.toBeInTheDocument();

    // And back out again from the graph window's side.
    await user.click(within(graphWin).getByTestId("inspector-bar"));
    expect(within(graphWin).getByTestId("inspector")).toBeInTheDocument();
    expect(screen.getAllByTestId("inspector")).toHaveLength(1);
  });

  it("docking returns the inspector to the main window", async () => {
    const user = userEvent.setup();
    fakeTransport();
    render(<App />);
    await user.click(screen.getByRole("tablist", { name: /workspace mode/i }).children[1]);
    await user.click(screen.getByTestId("graph-popout"));
    expect(screen.getByTestId("inspector-bar")).toBeInTheDocument();
    await user.click(screen.getByTestId("graph-dock"));
    // The bar has nowhere to live once the graph window is gone.
    expect(screen.queryByTestId("inspector-bar")).not.toBeInTheDocument();
    expect(screen.getByTestId("inspector")).toBeInTheDocument();
  });

  it("the graph window wears the app's own header, not the OS one", () => {
    fakeTransport();
    render(<GraphWindow />);
    const bar = screen.getByTestId("graph-window-bar");
    // Frameless: the window's own controls and mark have to be here, and
    // the bar has to be draggable or the window cannot be moved at all.
    expect(within(bar).getByTestId("app-icon")).toBeInTheDocument();
    expect(within(bar).getByTestId("window-controls")).toBeInTheDocument();
    expect(within(bar).getByTestId("win-minimize")).toBeInTheDocument();
    expect(within(bar).getByTestId("win-toggleMaximize")).toBeInTheDocument();
    expect(within(bar).getByTestId("win-close")).toBeInTheDocument();
    expect(bar).toHaveAttribute("data-tauri-drag-region");
  });

  it("the graph window waits rather than inventing a graph", () => {
    fakeTransport(); // nobody listening: no main window in this test
    render(<GraphWindow />);
    expect(screen.getByTestId("graph-window-waiting")).toBeInTheDocument();
    expect(screen.queryByTestId("node-editor")).not.toBeInTheDocument();
  });

  it("docking from either side puts the editor back", async () => {
    const user = userEvent.setup();
    const t = fakeTransport();
    render(<App />);
    await user.click(screen.getByRole("tablist", { name: /workspace mode/i }).children[1]);

    // Out and back by clicking the collapsed bar itself, which is the
    // whole control rather than a button sitting on one.
    await user.click(screen.getByTestId("graph-popout"));
    expect(screen.getByTestId("graph-dock")).toBeInTheDocument();
    await user.click(screen.getByTestId("graph-dock"));
    expect(screen.getByTestId("node-editor")).toBeInTheDocument();
    expect(screen.getByTestId("divider-graph")).toBeInTheDocument();

    // Out again, then closed from the graph window's side: the main
    // window has to notice, or its pane stays collapsed forever.
    await user.click(screen.getByTestId("graph-popout"));
    expect(screen.getByTestId("graph-dock")).toBeInTheDocument();
    act(() => t.send(DOCK_CHANNEL, true));
    expect(screen.getByTestId("node-editor")).toBeInTheDocument();
  });

  it("the spectrums come back however the window went away", async () => {
    // "the Close button doesn't bring the Spectrums back to the
    // Adjustment tab." The window's own Bring It Back button worked; its
    // title-bar close reported nothing, because the Rust destroy handler
    // named the graph window alone. Both paths arrive here as the same
    // message now, so this covers the close as well as the button.
    const user = userEvent.setup();
    const t = fakeTransport();
    render(<App />);

    await user.click(screen.getByTestId("spectrums-popout"));
    expect(screen.getByTestId("spectrum-bar")).toBeInTheDocument();
    expect(screen.queryByTestId("spectrums")).not.toBeInTheDocument();

    act(() => t.send(DOCK_CHANNEL, SPECTRUM_LABEL));
    expect(screen.getByTestId("spectrums")).toBeInTheDocument();
    expect(screen.queryByTestId("spectrum-bar")).not.toBeInTheDocument();
  });

  it("the takes window reviews the takes: stars, notes and compare go home, and the dropdown stays a switcher", async () => {
    const user = userEvent.setup();
    const t = fakeTransport();
    render(<App />);
    // Two takes, the second with a note the dropdown must not show.
    fireEvent.click(screen.getByTestId("new-take"));
    await user.click(screen.getByTestId("takes-popout"));
    render(<TakesWindow />);
    const win = await screen.findByTestId("takes-window");
    expect(await within(win).findByTestId("takes-window-count")).toHaveTextContent("2 TAKES");

    // Stars: the thumbnails' scale, clicking the held star clears.
    await user.click(within(win).getByTestId("take-star-take_2-4"));
    expect(t.sent).toContainEqual({ channel: CMD_CHANNEL, payload: { type: "set_take_rating", takeId: "take_2", rating: 4 } });
    expect(await within(win).findByTestId("take-star-take_2-4")).toHaveAttribute("data-on", "true");
    await user.click(within(win).getByTestId("take-star-take_2-4"));
    expect(t.sent).toContainEqual({ channel: CMD_CHANNEL, payload: { type: "set_take_rating", takeId: "take_2", rating: 0 } });

    // Notes: a draft while typing, written home on blur.
    const note = within(win).getByTestId("takes-window-note-take_2");
    await user.type(note, "client asked for drama");
    expect(t.sent.some((m) => m.channel === CMD_CHANNEL && (m.payload as { type: string }).type === "update_take")).toBe(false);
    fireEvent.blur(note);
    expect(t.sent).toContainEqual({ channel: CMD_CHANNEL, payload: { type: "update_take", takeId: "take_2", name: "Take 2", note: "client asked for drama" } });

    // Compare is picked here with room to see it.
    await user.click(within(win).getByTestId("takes-window-compare-take_1"));
    expect(t.sent).toContainEqual({ channel: CMD_CHANNEL, payload: { type: "toggle_multi_take", takeId: "take_1" } });

    // The dropdown in the main window shows the name alone.
    await user.click(screen.getByTestId("takes-dropdown"));
    expect(screen.getByTestId("takes-list")).not.toHaveTextContent("client asked for drama");

    // Docking clears the flag, like every other pop-out.
    act(() => t.send(DOCK_CHANNEL, TAKES_LABEL));
    expect(screen.getByTestId("takes-popout")).toHaveAttribute("data-active", "false");
  });

  it("the spectrum window carries the Harmony controls, and they edit the session", async () => {
    // The pop-out mounted the wheel on a throwaway initialState with no
    // dispatch, so the Harmony row (mode buttons, strength, anchor) did
    // not exist out there: a dead window that looked like a working one.
    const user = userEvent.setup();
    const t = fakeTransport();
    render(<App />);
    await user.click(screen.getByTestId("spectrums-popout"));
    render(<SpectrumWindow />);
    const win = await screen.findByTestId("spectrum-window");

    // The row shows once the snapshot has landed, and the mode buttons
    // are commands home, not local state.
    await user.click(within(win).getByTestId("spectrum-harmony"));
    await user.click(await within(win).findByTestId("harmony-triad"));
    expect(t.sent).toContainEqual({
      channel: CMD_CHANNEL,
      payload: { type: "set_harmony", value: { mode: "triad" } },
    });
    // The answer rides the snapshot back: the window's own copy shows
    // the mode the main window reduced.
    await waitFor(() =>
      expect(within(win).getByTestId("harmony-triad")).toHaveAttribute("data-active", "true"),
    );

    // Strength is a drag on the house track.
    dragTrack(within(win).getByTestId("harmony-strength"), 80);
    expect(t.sent).toContainEqual({
      channel: CMD_CHANNEL,
      payload: { type: "set_harmony", value: { strength: 80 } },
    });

    // The anchor is set by pressing on the ring (and dragging), and that
    // path works in the pop-out too: 6 o'clock on the wheel is hue 90.
    const canvas = within(win).getByTestId("spectrum-canvas");
    canvas.getBoundingClientRect = () =>
      ({ left: 0, top: 0, right: 400, bottom: 400, width: 400, height: 400, x: 0, y: 0, toJSON() {} }) as DOMRect;
    fireEvent.mouseDown(canvas, { button: 0, clientX: 200, clientY: 400 });
    expect(t.sent).toContainEqual({
      channel: CMD_CHANNEL,
      payload: { type: "set_harmony", value: { anchor: 90 } },
    });
  });

  it("docking one pop-out leaves the other alone", async () => {
    // The two windows share a channel, so a message meant for one must
    // not unfold the other.
    const user = userEvent.setup();
    const t = fakeTransport();
    render(<App />);
    await user.click(screen.getByTestId("spectrums-popout"));
    await user.click(screen.getByRole("tablist", { name: /workspace mode/i }).children[1]);
    await user.click(screen.getByTestId("graph-popout"));

    act(() => t.send(DOCK_CHANNEL, SPECTRUM_LABEL));
    expect(screen.getByTestId("graph-dock")).toBeInTheDocument();

    act(() => t.send(DOCK_CHANNEL, "graph"));
    expect(screen.getByTestId("node-editor")).toBeInTheDocument();
  });

  it("state only goes out while the graph is actually popped out", async () => {
    const user = userEvent.setup();
    const t = fakeTransport();
    render(<App />);
    await user.click(screen.getByRole("tablist", { name: /workspace mode/i }).children[1]);
    const snapshots = () => t.sent.filter((m) => m.channel === STATE_CHANNEL).length;
    expect(snapshots()).toBe(0);

    await user.click(screen.getByTestId("graph-popout"));
    const after = snapshots();
    expect(after).toBeGreaterThan(0);
    // Docked again, edits stop being broadcast.
    await user.click(screen.getByTestId("graph-dock"));
    const docked = snapshots();
    act(() => t.send(CMD_CHANNEL, { type: "set_param", id: "exposure", param: "exposure", value: 2 }));
    expect(snapshots()).toBe(docked);
  });

  it("answers a window that asks for state instead of making it wait", async () => {
    /// "There's some lag when popping out the color blend. It
    /// says 'waiting on main window' and takes a couple seconds to load
    /// the wheel."
    ///
    /// Structural, not slow code. A snapshot goes out when the state
    /// CHANGES, and the change that opened the window has come and gone
    /// by the time the webview has booted and subscribed to anything, so
    /// it waited for whatever got edited next.
    const t = fakeTransport();
    render(<App />);
    const snapshots = () => t.sent.filter((m) => m.channel === STATE_CHANNEL).length;
    const before = snapshots();
    act(() => t.send(STATE_REQUEST, true));
    expect(snapshots()).toBe(before + 1);
    // And it answers with the state as it is now, not as it was when the
    // listener was registered.
    const sent = t.sent.filter((m) => m.channel === STATE_CHANNEL).pop()!;
    expect((sent.payload as { nodes: unknown[] }).nodes.length).toBeGreaterThan(0);
  });

  it("a snapshot leaves the thumbnails behind", async () => {
    // Every thumbnail the library has loaded sits in images[].src as a
    // base64 data URL, and this snapshot goes out on every change: once
    // per mousemove while a handle is dragged. Sending a folder of
    // thumbnails sixty times a second to a window drawing a color wheel
    // was most of the cost of having the window open.
    let s = initialState();
    const ids = s.images.slice(0, 3).map((i) => i.id);
    for (const id of ids) s = reduce(s, { type: "set_thumb", id, src: "data:image/jpeg;base64,AAAA" });
    s = { ...s, activeImage: ids[0] };

    const snap = graphSnapshot(s);
    // The open photograph keeps its thumbnail: the graph window draws it
    // beside the node cards.
    expect(snap.images.find((i) => i.id === ids[0])!.src).toBe("data:image/jpeg;base64,AAAA");
    expect(snap.images.find((i) => i.id === ids[1])!.src).toBe("");
    // Everything else about the list survives, so nothing that reads it
    // notices.
    expect(snap.images.length).toBe(s.images.length);
    expect(snap.images.map((i) => i.name)).toEqual(s.images.map((i) => i.name));
    // And the state itself is untouched: this is a copy for sending.
    expect(s.images.find((i) => i.id === ids[1])!.src).toBe("data:image/jpeg;base64,AAAA");
  });

  it("taking a pop-out back from the panel closes its window", async () => {
    /// "I clicked the button in the main window to bring
    /// the Bend circle back but it did not close the pop out."
    ///
    /// The close only ever ran when the request came FROM the window, so
    /// the panel's own bar flipped the flag and left the window sitting
    /// there showing a wheel the panel had already taken back. The
    /// spectrums had the identical hole in the identical place.
    const user = userEvent.setup();
    vi.resetModules();
    const closedBend = vi.fn(async () => {});
    const closedSpectrum = vi.fn(async () => {});
    vi.doMock("../popout", async () => {
      const actual = await vi.importActual<typeof import("../popout")>("../popout");
      return {
        ...actual,
        openBendWindow: vi.fn(async () => {}),
        openSpectrumWindow: vi.fn(async () => {}),
        closeBendWindow: closedBend,
        closeSpectrumWindow: closedSpectrum,
      };
    });
    const { App: Fresh } = await import("../app");
    fakeTransport();
    render(<Fresh />);

    await user.click(screen.getByTestId("spectrums-popout"));
    closedSpectrum.mockClear();
    await user.click(screen.getByTestId("spectrum-bar"));
    expect(screen.getByTestId("spectrums")).toBeInTheDocument();
    expect(closedSpectrum).toHaveBeenCalled();

    await user.click(screen.getByTestId("bend-popout"));
    closedBend.mockClear();
    await user.click(screen.getByTestId("bend-bar"));
    expect(screen.getByTestId("bend-wheel")).toBeInTheDocument();
    expect(closedBend).toHaveBeenCalled();
    vi.doUnmock("../popout");
    vi.resetModules();
  });

  it("falls back to a plain popup when there is no Tauri", async () => {
    const open = vi.spyOn(window, "open").mockImplementation(() => ({ closed: false, focus() {}, close(this: { closed: boolean }) { this.closed = true; } }) as unknown as Window);
    const { openGraphWindow, closeGraphWindow } = await import("../popout");
    await openGraphWindow();
    expect(open).toHaveBeenCalledWith(expect.stringContaining("view=graph"), "heeler-graph", expect.any(String));
    await closeGraphWindow();
    open.mockRestore();
  });

  /// (2026-09-15): "When the LIBRARY is collapsed the pop out button
  /// doesn't work. The graph popout flashes open and closes again." The
  /// button opened the window itself (to remember its opener) and the
  /// flag's effect opened it again; on the Rust side the second build
  /// found the label taken and failed, and the failure path dropped the
  /// flag and closed the window the first had made. One request now.
  it("popping the graph out asks for the window once", async () => {
    const open = vi.spyOn(window, "open").mockImplementation(() => ({ closed: false, focus() {}, close(this: { closed: boolean }) { this.closed = true; } }) as unknown as Window);
    try {
      const user = userEvent.setup();
      fakeTransport();
      render(<App />);
      await user.click(screen.getByRole("tablist", { name: /workspace mode/i }).children[1]);
      await user.click(screen.getByRole("button", { name: /collapse library/i }));
      await user.click(screen.getByTestId("graph-popout"));
      expect(screen.getByTestId("graph-dock")).toBeInTheDocument();
      expect(open).toHaveBeenCalledTimes(1);
      // Docking from the bar closes it without asking to open again.
      await user.click(screen.getByTestId("graph-dock"));
      expect(screen.getByTestId("node-editor")).toBeInTheDocument();
      expect(open).toHaveBeenCalledTimes(1);
    } finally {
      open.mockRestore();
    }
  });

  /// Review 2026-09-15: "a focus failure can close an existing pop-out".
  /// The Rust side now answers with what it did; a window that exists
  /// but would not come forward is open, and the flag has to stay.
  it("a window that exists but would not come forward keeps its flag and says so", async () => {
    // Static imports, like the rest of this file: a dynamic one can land
    // on a second module graph whose flash is not the one read here.
    const before = getEntries().length;
    let failures = 0;
    // The open resolves with a note: followPopout sees no rejection, so
    // the flag stands and the window with it.
    followPopout(true, "Graph", async () => reportPresentation("Graph", { existed: true, note: "could not be focused: no focus" }), async () => {}, () => failures++);
    await new Promise((r) => setTimeout(r, 0));
    expect(failures).toBe(0);
    const entries = getEntries().slice(before);
    expect(entries.some((e) => e.level === "warn" && /Graph window is open but could not be focused/.test(e.message))).toBe(true);
    expect(currentFlash() ?? "").toMatch(/could not be focused/);
    // A clean open says nothing.
    const quiet = getEntries().length;
    reportPresentation("Graph", { existed: false, note: null });
    expect(getEntries().length).toBe(quiet);
    // A rejection is still a failed open, and still clears the flag.
    followPopout(true, "Graph", async () => { throw new Error("a webview could not be built"); }, async () => {}, () => failures++);
    await new Promise((r) => setTimeout(r, 0));
    expect(failures).toBe(1);
  });

  it("an unreachable transport is a no-op, not a crash", () => {
    setTransport(null);
    // jsdom has no BroadcastChannel and no Tauri: sending must simply
    // drop, so the app runs headless exactly as before.
    expect(() => render(<App />)).not.toThrow();
    expect(screen.getByTestId("topbar")).toBeInTheDocument();
  });
});

describe("adjustment tool pop-outs", () => {
  /// "Just like the Color Bend, make the following
  /// adjustment tools able to pop out to larger floating windows...
  /// actually render new controls that scale."
  it("knows every tool role by query string, straight from the registry", () => {
    expect(windowRole("?view=curves")).toBe("curves");
    expect(windowRole("?view=wheels")).toBe("wheels");
    expect(windowRole("?view=toneeq")).toBe("toneeq");
    expect(windowRole("?view=recolor")).toBe("recolor");
    // Retired windows fall back to main rather than resurrecting.
    expect(windowRole("?view=splittone")).toBe("main");
  });

  it("popping out folds the wheels to a bar, and the window draws them bigger", async () => {
    const user = userEvent.setup();
    const t = fakeTransport();
    render(<App />);
    await user.click(screen.getByTestId("wheels-popout"));
    expect(screen.getByTestId("wheels-bar")).toBeInTheDocument();
    expect(screen.queryByTestId("develop-wheels")).not.toBeInTheDocument();

    render(<ToolWindow kind="wheels" />);
    // findBy, not getBy: the snapshot lands through an effect chain.
    const win = await screen.findByTestId("toolwindow-wheels");
    expect(screen.queryByTestId("tool-window-waiting")).not.toBeInTheDocument();
    // Redrawn at window size, not the panel's 86px disc stretched.
    const wheel = within(win).getByTestId("wheel-midtones");
    expect(parseInt(wheel.style.width)).toBeGreaterThan(86);

    // An edit out there is a command sent home, not a local mutation.
    const before = t.sent.filter((m) => m.channel === CMD_CHANNEL).length;
    fireEvent.pointerDown(wheel, { clientX: 4, clientY: 4, pointerId: 1 });
    expect(t.sent.filter((m) => m.channel === CMD_CHANNEL).length).toBeGreaterThan(before);
  });

  it("the curves window redraws the plot, points and all, at window size", async () => {
    const user = userEvent.setup();
    fakeTransport();
    render(<App />);
    await user.click(screen.getByTestId("curves-popout"));
    expect(screen.getByTestId("curves-bar")).toBeInTheDocument();

    render(<ToolWindow kind="curves" />);
    // Curves ships switched off now; the window's own switch is the way
    // in, which makes this test walk the same road a person does.
    const user2 = userEvent.setup();
    await user2.click(await screen.findByTestId("tool-window-power"));
    const plot = await screen.findByTestId("curve-plot");
    expect(Number(plot.getAttribute("width"))).toBeGreaterThan(272);
    // The handles grew with the plot instead of staying panel-sized specks,
    // at two thirds of the plot's own growth: the full ratio read as heavy
    // (2026-09-15: "the line thickness could be two thirds what it is now
    // on the curve, and the point radius could be two thirds").
    const W = Number(plot.getAttribute("width"));
    const r = Number(screen.getAllByTestId(/curve-point-/)[0].getAttribute("r"));
    expect(r).toBeGreaterThan(4.5);
    expect(r).toBeCloseTo(4.5 * ((2 / 3) * (W / 272)), 3);
    const curve = plot.querySelector("polyline[stroke]") ?? plot.querySelector("path[stroke]");
    expect(Number(curve!.getAttribute("stroke-width"))).toBeCloseTo(1.6 * ((2 / 3) * (W / 272)), 3);
  });

  // Split Tone retired 2026-08-23: Recolor's Lum▸Hue and the Color
  // Wheels cover its jobs; its window went with it.

  it("the window's own button and the panel bar both bring a tool back", async () => {
    const user = userEvent.setup();
    fakeTransport();
    render(<App />);
    await user.click(screen.getByTestId("wheels-popout"));
    render(<ToolWindow kind="wheels" />);
    // From the window: DOCK with the label, and the panel unfolds.
    await user.click(await screen.findByTestId("tool-window-dock"));
    await waitFor(() => expect(screen.queryByTestId("wheels-bar")).not.toBeInTheDocument());
    expect(screen.getByTestId("develop-wheels")).toBeInTheDocument();
    // Out again, back from the panel's own bar.
    await user.click(screen.getByTestId("wheels-popout"));
    await user.click(await screen.findByTestId("wheels-bar"));
    await waitFor(() => expect(screen.getByTestId("develop-wheels")).toBeInTheDocument());
  });
});

describe("a tool window before its node exists", () => {
  /// A photograph's graph only grows a tool's node when the tool is
  /// first switched on, so a pop-out can arrive before its node
  /// exists. The owner's real graphs had no curves node at all; the
  /// window was an unexplained void. It offers the section's power
  /// switch.
  it("shows the power switch, and the switch builds the section", async () => {
    const user = userEvent.setup();
    const t = fakeTransport();
    render(<ToolWindow kind="curves" />);
    const bare = initialState();
    const snap = graphSnapshot({
      ...bare,
      nodes: bare.nodes.filter((n) => n.type !== "heeler.curves"),
    });
    act(() => t.send(STATE_CHANNEL, snap));
    expect(await screen.findByTestId("tool-window-off")).toHaveTextContent(/not been used/i);
    // A node that exists but is not enabled shows the same screen; the
    // window never enables anything on its own. "I want the
    // '... has not been used on this photograph yet.' message with the
    // option to turn it on."
    const off = graphSnapshot({
      ...bare,
      nodes: bare.nodes.map((n) => (n.id === "curves" ? { ...n, enabled: false } : n)),
    });
    act(() => t.send(STATE_CHANNEL, off));
    expect(await screen.findByTestId("tool-window-off")).toHaveTextContent(/not been used/i);
    act(() => t.send(STATE_CHANNEL, snap));
    await user.click(screen.getByTestId("tool-window-power"));
    const cmds = t.sent.filter((m) => m.channel === CMD_CHANNEL).map((m) => m.payload);
    expect(cmds).toContainEqual({ type: "set_category", title: "Curves", on: true });
    // The rebuilt, switched-on graph arrives and the plot replaces the
    // switch.
    const on = graphSnapshot({
      ...bare,
      nodes: bare.nodes.map((n) => (n.id === "curves" ? { ...n, enabled: true } : n)),
    });
    act(() => t.send(STATE_CHANNEL, on));
    expect(await screen.findByTestId("curve-plot")).toBeInTheDocument();
    expect(screen.queryByTestId("tool-window-off")).not.toBeInTheDocument();
  });
});

describe("a tool window with a layer selected", () => {
  /// Second-pass Color Tune review, 26.3.2: the Color Tune and Relight
  /// windows found the FIRST node of their type in the graph, which is
  /// the main chain's, while the panel beside them worked the selected
  /// layer's own. An edit made out in the window landed on a node the
  /// user was not looking at. Curves and Color Wheels already resolved
  /// theirs through toolNode; these two follow.
  const layeredSnapshot = (type: string) => {
    let s = initialState();
    s = {
      ...s,
      nodes: s.nodes.map((n) => (n.type === type ? { ...n, enabled: true } : n)),
    };
    s = reduce(s, { type: "add_layer", maskType: "brush" });
    if (s.activeLayer !== "layer_1_adj") throw new Error("the layer did not take");
    return graphSnapshot(s);
  };

  it("the Color Tune window works the layer's own console, not the main chain's", async () => {
    const t = fakeTransport();
    render(<ToolWindow kind="colorconsole" />);
    act(() => t.send(STATE_CHANNEL, layeredSnapshot("heeler.color_console")));
    // The layer's console is untouched, so the window shows its stand-in:
    // the pad is there, switched off until first touch.
    const pad = await screen.findByTestId("console-pad-r");
    fireEvent.keyDown(pad, { key: "ArrowRight" });
    const writes = t.sent
      .filter((m) => m.channel === CMD_CHANNEL)
      .map((m) => m.payload as { type: string; id?: string })
      .filter((c) => c.type === "set_text_param");
    expect(writes.length).toBeGreaterThan(0);
    expect(writes.every((c) => c.id === "layer_1_colorconsole")).toBe(true);
  });

  it("the Relight window's dials are the layer's own too", async () => {
    const t = fakeTransport();
    render(<ToolWindow kind="toneeq" />);
    act(() => t.send(STATE_CHANNEL, layeredSnapshot("heeler.tone_eq")));
    const dial = await screen.findByTestId("slider-range_shift");
    expect(dial.getAttribute("data-node")).toBe("layer_1_toneeq");
  });
});

describe("the curve editor across a window boundary", () => {
  const curveNode = {
    id: "curves", type: "heeler.curves", name: "Curves", cat: "color",
    x: 0, y: 0, enabled: true, params: {}, curves: {}, hasIn: true, hasOut: true,
  } as never;

  /// From a pop-out every edit crosses to the main window and echoes
  /// back a beat later; drawing from the prop alone meant a drag right
  /// after an add read stale points. "I click to add a
  /// point, drag it. Click to add a second point and the first point
  /// disappears."
  it("an edit renders immediately from the local echo, before the round trip lands", async () => {
    const { CurveEditor } = await import("../ui/editors");
    // A dispatch that goes nowhere, like a round trip still in flight.
    render(<CurveEditor node={curveNode} dispatch={() => {}} />);
    expect(screen.getAllByTestId(/curve-point-/)).toHaveLength(2);
    fireEvent(screen.getByTestId("curve-plot"), new MouseEvent("pointerdown", { bubbles: true, clientX: 0.5, clientY: 0.4 }));
    fireEvent(window, new MouseEvent("pointerup", {}));
    // Three points on screen though the node prop never changed.
    expect(screen.getAllByTestId(/curve-point-/)).toHaveLength(3);
    // And a second add still sees the first: four, not three.
    fireEvent(screen.getByTestId("curve-plot"), new MouseEvent("pointerdown", { bubbles: true, clientX: 0.8, clientY: 0.6 }));
    fireEvent(window, new MouseEvent("pointerup", {}));
    expect(screen.getAllByTestId(/curve-point-/)).toHaveLength(4);
  });

  /// The echo retires when the prop moves off what it held at commit
  /// time, not only when it lands exactly on the echo. Retiring on an
  /// exact match alone meant a change from anywhere else (a Reset in
  /// the main window, an undo, another window's edit) never reached the
  /// screen: the stale echo kept winning the draw forever.
  it("a change that is not the echo's round trip still retires the echo", async () => {
    const { CurveEditor } = await import("../ui/editors");
    const { rerender } = render(<CurveEditor node={curveNode} dispatch={() => {}} />);
    fireEvent(screen.getByTestId("curve-plot"), new MouseEvent("pointerdown", { bubbles: true, clientX: 0.5, clientY: 0.4 }));
    fireEvent(window, new MouseEvent("pointerup", {}));
    // The echo: three points, though the node prop never changed.
    expect(screen.getAllByTestId(/curve-point-/)).toHaveLength(3);
    // Then a curve bent somewhere else arrives: five points, not the
    // echo's three and not the round trip of them. The fresh prop wins.
    const foreign = {
      // Spread off a plain record: curveNode is cast `as never` above,
      // and `never` is not a spreadable type.
      ...(curveNode as unknown as Record<string, unknown>),
      curves: { rgb: [[0, 0], [0.25, 0.5], [0.5, 0.6], [0.75, 0.9], [1, 1]] },
    } as never;
    rerender(<CurveEditor node={foreign} dispatch={() => {}} />);
    expect(screen.getAllByTestId(/curve-point-/)).toHaveLength(5);
  });

  /// The middle case the two-way rules got wrong: a landing of an
  /// OLDER edit of our own must not retire the echo, or a mid-drag
  /// handle snaps back a frame on every landing and rubber-bands after
  /// release while the queue drains. Only the newest of ours, or an
  /// outside edit, retires it.
  it("an older in-flight landing keeps the echo; the newest retires it", async () => {
    const { CurveEditor } = await import("../ui/editors");
    const sent: unknown[] = [];
    const { rerender } = render(
      <CurveEditor node={curveNode} dispatch={(c: unknown) => sent.push(c)} />,
    );
    // Two quick edits: add a point, then drag it somewhere else.
    fireEvent(screen.getByTestId("curve-plot"), new MouseEvent("pointerdown", { bubbles: true, clientX: 0.5, clientY: 0.4 }));
    fireEvent(window, new MouseEvent("pointermove", { clientX: 0.5, clientY: 0.2 }));
    fireEvent(window, new MouseEvent("pointerup", {}));
    const curves = sent
      .filter((c) => (c as { type: string }).type === "set_curve")
      .map((c) => (c as { curve: [number, number][] }).curve);
    expect(curves.length).toBeGreaterThanOrEqual(2);
    const first = curves[0];
    const last = curves[curves.length - 1];
    const withCurve = (curve: unknown) =>
      ({
        ...(curveNode as unknown as Record<string, unknown>),
        curves: { rgb: curve },
      }) as never;

    // The FIRST edit lands: still ours, still older than the echo. The
    // handle must hold the drag position, not snap back to the add.
    rerender(<CurveEditor node={withCurve(first)} dispatch={() => {}} />);
    const at = (i: number) => screen.getByTestId(`curve-point-${i}`).getAttribute("cy");
    expect(at(1)).not.toBe(String((1 - first[1][1]) * 150));
    expect(at(1)).toBe(String((1 - last[1][1]) * 150));

    // The NEWEST lands: caught up, echo retires, prop draws.
    rerender(<CurveEditor node={withCurve(last)} dispatch={() => {}} />);
    expect(at(1)).toBe(String((1 - last[1][1]) * 150));
  });

  it("the pop-out carries the eyedropper, armed through the main window", async () => {
    const user = userEvent.setup();
    const t = fakeTransport();
    render(<ToolWindow kind="curves" />);
    const lit = initialState();
    act(() =>
      t.send(
        STATE_CHANNEL,
        graphSnapshot({
          ...lit,
          nodes: lit.nodes.map((n) => (n.id === "curves" ? { ...n, enabled: true } : n)),
        }),
      ),
    );
    const pick = await screen.findByTestId("curve-pick");
    await user.click(pick);
    const cmds = t.sent.filter((m) => m.channel === CMD_CHANNEL).map((m) => m.payload);
    expect(cmds.some((c) => (c as { type: string }).type === "arm_curve_pick")).toBe(true);
  });
});

describe("finding a lost floating window", () => {
  /// "I can see someone 'losing' the floating window and not
  /// being able to find it." While a tool is out, its header chip stays as
  /// the way back, and clicking it again re-opens the window, which the
  /// Rust side raises and focuses, so a buried window is one toggle away.
  it("the header chip is a toggle: out with one click, back with the next", async () => {
    const user = userEvent.setup();
    fakeTransport();
    render(<App />);
    await user.click(screen.getByTestId("wheels-popout"));
    expect(screen.getByTestId("wheels-bar")).toBeInTheDocument();
    // Still there, now as the way BACK. "the pop out button
    // is not closing the pop out and bringing the tool back to the main
    // UI."
    const chip = screen.getByTestId("wheels-popout");
    expect(chip).toHaveAttribute("data-hint", expect.stringMatching(/back into the panel/i));
    await user.click(chip);
    expect(screen.queryByTestId("wheels-bar")).not.toBeInTheDocument();
    expect(screen.getByTestId("develop-wheels")).toBeInTheDocument();
  });

  it("the spectrums bar grows the same way back while popped", async () => {
    const user = userEvent.setup();
    fakeTransport();
    render(<App />);
    await user.click(screen.getByTestId("spectrums-popout"));
    expect(screen.getByTestId("spectrum-bar")).toBeInTheDocument();
    await user.click(screen.getByTestId("spectrums-focus"));
    expect(screen.queryByTestId("spectrum-bar")).not.toBeInTheDocument();
  });
});

describe("a dock notice for a window nobody here owns", () => {
  /// The Rust side reports EVERY destroyed pop-out on the dock channel,
  /// the console window included, and the handler's catch-all used to
  /// read any unrecognized label as the graph: closing the console
  /// folded the graph back into its panel while its window was still
  /// open, and the snapshot push stopped feeding it. Only the graph's
  /// own signals (its legacy `true`, or its label from the Rust side)
  /// may dock the graph.
  it("closing the console does not dock the graph", async () => {
    const user = userEvent.setup();
    const t = fakeTransport();
    render(<App />);
    await user.click(screen.getByRole("tablist", { name: /workspace mode/i }).children[1]);
    await user.click(screen.getByTestId("graph-popout"));
    expect(screen.getByTestId("graph-dock")).toBeInTheDocument();

    // The console window going away, as reported by label.
    act(() => t.send(DOCK_CHANNEL, "console"));
    expect(screen.getByTestId("graph-dock")).toBeInTheDocument();

    // While the graph's own word for it still docks, both spellings.
    act(() => t.send(DOCK_CHANNEL, "graph"));
    expect(screen.queryByTestId("graph-dock")).not.toBeInTheDocument();
    await user.click(screen.getByTestId("graph-popout"));
    act(() => t.send(DOCK_CHANNEL, true));
    expect(screen.queryByTestId("graph-dock")).not.toBeInTheDocument();
  });

  it("docking a graph opened from Window returns focus to the surviving menu button", async () => {
    const user = userEvent.setup();
    const open = vi.spyOn(window, "open").mockImplementation(() => ({ closed: false, focus() {}, close(this: { closed: boolean }) { this.closed = true; } }) as unknown as Window);
    const t = fakeTransport();
    render(<App />);
    try {
      await user.click(screen.getByRole("tablist", { name: /workspace mode/i }).children[1]);
      await user.click(screen.getByTestId("menu-window"));
      screen.getByTestId("menu-window-graph").focus();
      await user.keyboard("{Enter}");
      expect(screen.getByTestId("graph-dock")).toBeInTheDocument();
      screen.getByTestId("menu-file").focus();
      act(() => t.send(DOCK_CHANNEL, "graph"));
      await waitFor(() => expect(document.activeElement).toBe(screen.getByTestId("menu-window")));
      expect(open).toHaveBeenCalledOnce();
    } finally { open.mockRestore(); }
  });

  it("a destroyed graph or console window returns focus to its opener", async () => {
    // The Rust side reports an OS-level close (title bar, Alt+F4,
    // taskbar) on the dock channel. Spectrum, bend and the tool windows
    // route that through their close helpers, which restore focus; the
    // graph and console branches only flipped state, stranding the
    // keyboard user with focus nowhere.
    const user = userEvent.setup();
    const open = vi.spyOn(window, "open").mockImplementation(() => ({ closed: false, focus() {}, close(this: { closed: boolean }) { this.closed = true; } }) as unknown as Window);
    const t = fakeTransport();
    render(<App />);
    try {
      await user.click(screen.getByRole("tablist", { name: /workspace mode/i }).children[1]);
      const graphOpener = screen.getByTestId("graph-popout");
      graphOpener.focus();
      await user.click(graphOpener);
      expect(screen.getByTestId("graph-dock")).toBeInTheDocument();
      (document.body as HTMLElement).focus();
      act(() => t.send(DOCK_CHANNEL, "graph"));
      // The docked panel rerenders, so the opener may be a fresh node:
      // assert by testid, not object identity.
      await waitFor(() => expect(document.activeElement).toBe(screen.getByTestId("graph-popout")));

      const consoleAnchor = screen.getByTestId("graph-popout");
      consoleAnchor.focus();
      await act(async () => { await openConsoleWindow(); });
      (document.body as HTMLElement).focus();
      act(() => t.send(DOCK_CHANNEL, "console"));
      await waitFor(() => expect(document.activeElement).toBe(screen.getByTestId("graph-popout")));
    } finally {
      open.mockRestore();
    }
  });
});

describe("popping out never switches a tool on", () => {
  /// "Right now, if I click the pop out it enables the tool
  /// automatically. I don't want that." The flag flips and nothing
  /// else; the window's own switch is the only way a pop-out enables.
  it("the graph is untouched by the flag, missing node or off node alike", () => {
    let s = initialState();
    s = { ...s, nodes: s.nodes.filter((n) => n.type !== "heeler.color_balance") };
    const popped = reduce(s, { type: "set_tool_popped_out", tool: "wheels", out: true });
    expect(popped.nodes).toBe(s.nodes);

    let t = initialState();
    t = { ...t, nodes: t.nodes.map((n) => (n.id === "curves" ? { ...n, enabled: false } : n)) };
    const out = reduce(t, { type: "set_tool_popped_out", tool: "curves", out: true });
    expect(out.nodes.find((n) => n.id === "curves")!.enabled).toBe(false);
  });
});

describe("browser popups keep their handles", () => {
  /// Dev-server behavior only: without a handle, the browser transport
  /// could open a window it could never close or raise, so docking left
  /// the popup on screen and re-popping opened a duplicate. The bend,
  /// spectrum and graph pairs now share the tool windows' pattern:
  /// reuse-or-focus on open, close-and-forget on close.
  it("re-opening focuses the existing window; closing lets a fresh one open", async () => {
    const { openBendWindow, closeBendWindow, openGraphWindow, closeGraphWindow } =
      await import("../popout");
    const fake = () => {
      const w = { closed: false, focus: vi.fn(), close: vi.fn() };
      (w.close as ReturnType<typeof vi.fn>).mockImplementation(() => {
        w.closed = true;
      });
      return w as unknown as Window;
    };
    const opened: ReturnType<typeof fake>[] = [];
    const open = vi.spyOn(window, "open").mockImplementation(() => {
      const w = fake();
      opened.push(w);
      return w;
    });
    try {
      await openBendWindow();
      expect(open).toHaveBeenCalledTimes(1);
      // The second ask raises the first window instead of doubling it.
      await openBendWindow();
      expect(open).toHaveBeenCalledTimes(1);
      expect((opened[0] as unknown as { focus: ReturnType<typeof vi.fn> }).focus).toHaveBeenCalled();
      // Docking closes it, and the next ask starts fresh.
      await closeBendWindow();
      expect((opened[0] as unknown as { close: ReturnType<typeof vi.fn> }).close).toHaveBeenCalled();
      await openBendWindow();
      expect(open).toHaveBeenCalledTimes(2);

      // The graph pair rides the same rails.
      await openGraphWindow();
      await openGraphWindow();
      const graphOpens = open.mock.calls.filter((c) => c[1] === "heeler-graph").length;
      expect(graphOpens).toBe(1);
      await closeGraphWindow();
      await openGraphWindow();
      expect(open.mock.calls.filter((c) => c[1] === "heeler-graph").length).toBe(2);
      await closeGraphWindow();
      await closeBendWindow();
    } finally {
      open.mockRestore();
    }
  });
});

describe("the console's death notice", () => {
  /// The console window announces its own close from beforeunload, but
  /// that broadcast rides an async send and can die with the webview.
  /// The Rust side's dock report always arrives; it clears the flag so
  /// the toggle opens a fresh window instead of "closing" a ghost. The
  /// report: "when I went to re-open Console by clicking the Console
  /// button next to the quick export, nothing happened."
  it("a dock report for the console clears windowLive", async () => {
    const t = fakeTransport();
    render(<App />);
    announceConsoleWindow(true);
    expect(consoleWindowLive()).toBe(true);
    act(() => t.send(DOCK_CHANNEL, "console"));
    expect(consoleWindowLive()).toBe(false);
  });
});

describe("the dock button", () => {
  it("is one icon-only control of one size in every popped-out window", async () => {
    const { DockButton } = await import("../ui/chrome");
    const { render, screen } = await import("@testing-library/react");
    render(
      <>
        <DockButton testid="dock-a" hint="Put the spectrums back in the panel" onClick={() => {}} />
        <DockButton testid="dock-b" hint="Put this tool back in the panel" onClick={() => {}} />
      </>,
    );
    for (const id of ["dock-a", "dock-b"]) {
      const b = screen.getByTestId(id);
      expect(b.textContent).toBe("");
      expect(b.querySelector("svg")).not.toBeNull();
      expect(b.style.width).toBe("30px");
      expect(b.style.height).toBe("20px");
      expect(b.getAttribute("aria-label")).toBe(b.getAttribute("data-hint"));
    }
  });
});

describe("the Inspector's frame and its pickers", () => {
  /// 2026-09-08: "the pop out graph view's inspector does not show the
  /// histogram." The frame drives the spectrums and the widgets'
  /// histograms; the pickers are a separate question, answered by
  /// whether the window has a viewer to click.
  it("plots a frame without offering a picker when told there is no viewer", () => {
    let s = reduce(initialState(), { type: "set_category", title: "Curves", on: true });
    s = reduce(s, { type: "select_nodes", ids: ["curves"] });
    const frame = "data:image/png;base64,x";
    // No frame: no spectrums, and nothing to pick from either.
    const bare = render(<Inspector state={s} dispatch={() => {}} />);
    expect(screen.queryByTestId("spectrums")).not.toBeInTheDocument();
    expect(screen.queryByTestId("curve-pick")).not.toBeInTheDocument();
    bare.unmount();
    // The main window: a frame and a viewer, so both.
    const main = render(<Inspector state={s} dispatch={() => {}} frame={frame} />);
    expect(screen.getByTestId("spectrums")).toBeInTheDocument();
    expect(screen.getByTestId("curve-pick")).toBeInTheDocument();
    main.unmount();
    // The popped-out graph window: the main window's frame, no viewer.
    render(<Inspector state={s} dispatch={() => {}} frame={frame} pickers={false} />);
    expect(screen.getByTestId("spectrums")).toBeInTheDocument();
    expect(screen.queryByTestId("curve-pick")).not.toBeInTheDocument();
  });
});

it("the Spectrum window shows the wheel's guidance in its own status row", async () => {
  const t = fakeTransport();
  render(<SpectrumWindow />);
  act(() => t.send(STATE_CHANNEL, graphSnapshot(initialState())));
  fireEvent.click(screen.getByTestId("spectrum-harmony"));
  fireEvent.mouseOver(screen.getByTestId("spectrum-canvas"));
  expect(screen.getByTestId("spectrum-window-hint")).toHaveTextContent("Pick a family above");
});
