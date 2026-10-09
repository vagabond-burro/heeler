import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useState } from "react";
import { initialState } from "../data";
import { reduce, type State, type Command } from "../state";
import { GraphPersistence } from "../ui/graphpersistence";
import { autosaves, flushAutosave } from "../autosave";
const native = vi.hoisted(() => ({ load: vi.fn(), save: vi.fn(), good: vi.fn(), close: undefined as undefined | ((event: { preventDefault(): void }) => Promise<void>), destroy: vi.fn() }));
vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow: () => ({ onCloseRequested: async (f: typeof native.close) => { native.close = f; return () => {}; }, destroy: native.destroy }) }));
vi.mock("../bridge", async original => ({ ...await original<Record<string, unknown>>(), isTauri: () => true, loadGraphResult: native.load, saveGraph: native.save, loadLastGoodGraph: native.good, renderThumbnail: vi.fn().mockResolvedValue(null) }));
let commands: Command[] = [];
let send: (c: Command) => void;
let current: () => State;
function Harness({ start }: { start: State }) {
  const [state, setState] = useState(start);
  send = command => { commands.push(command); setState(s => reduce(s, command)); };
  current = () => state;
  return <GraphPersistence state={state} dispatch={send} />;
}
const settle = async () => { await act(async () => {}); };
const deferred = <T,>() => { let resolve!: (v: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; };
beforeEach(() => {
  commands = []; native.load.mockReset().mockResolvedValue({ status: "absent" }); native.save.mockReset().mockResolvedValue(undefined);
  native.good.mockReset(); native.destroy.mockReset().mockResolvedValue(undefined); native.close = undefined;
});
afterEach(async () => { native.save.mockResolvedValue(undefined); await act(async () => { await flushAutosave(); }); });

/// "a profile is applied to the thumbnail... they look
/// right in the canvas but the thumbnail is blown out." The debounced
/// save's thumbnail rendered through the LIVE graph, which after a
/// quick photo switch is the next photograph's, a RAW's profile on a
/// JPEG; and the catalog kept that thumbnail. The render goes through
/// the graph that was written.
it("the autosave thumbnail renders through the saved graph, not the photo that is live when it flushes", async () => {
  const { renderThumbnail } = await import("../bridge");
  const thumb = renderThumbnail as unknown as ReturnType<typeof vi.fn>;
  thumb.mockClear();
  let s = reduce(initialState(), { type: "load_images", images: [
    { id: "j", name: "street.jpg", stars: 0, flag: "", edited: false, filter: "none", src: "" },
    { id: "r", name: "street.NEF", stars: 0, flag: "", edited: false, filter: "none", src: "" },
  ] });
  expect(s.activeImage).toBe("j");
  expect(s.nodes.find((n) => n.type === "heeler.tone_profile")!.enabled).toBe(false);
  render(<Harness start={s} />); await settle();
  // An edit on the JPEG arms its save; the RAW is picked before it fires.
  await act(async () => { send({ type: "set_param", id: "exposure", param: "exposure", value: 0.5 }); });
  await act(async () => { send({ type: "select_image", id: "r" }); });
  await act(async () => { await flushAutosave(); });
  await settle();
  const calls = thumb.mock.calls.filter((c: unknown[]) => c[1] === "j");
  expect(calls.length).toBeGreaterThan(0);
  for (const [state] of calls as [State, string][]) {
    expect(state.activeImage).toBe("j");
    expect(state.nodes.find((n) => n.type === "heeler.tone_profile")!.enabled).toBe(false);
  }
});

it("an old thumbnail cannot land after a linked reset", async () => {
  const { renderThumbnail } = await import("../bridge");
  const thumb = vi.mocked(renderThumbnail);
  const pendingThumb = deferred<string | null>();
  thumb.mockReturnValueOnce(pendingThumb.promise);
  const base = initialState();
  const s = reduce(base, { type: "set_link_group", ids: [base.activeImage, "4866"], group: "review" });
  const view = render(<Harness start={s} />); await settle();
  await act(async () => send({ type: "set_param", id: "exposure", param: "exposure", value: 1.25 }));
  await act(async () => { await flushAutosave(); });
  await act(async () => send({ type: "reset_image_edits", id: s.activeImage }));
  commands = [];
  await act(async () => pendingThumb.resolve("stale-thumbnail"));
  expect(commands.some(c => c.type === "set_thumb" && c.src === "stale-thumbnail")).toBe(false);
  view.unmount();
});

/// undoing a reset of the open photograph saves its edits again, with
/// the edited badge on (the catalog mark rides the save).
it("undo after resetting the open photograph saves its edits back with the badge", async () => {
  const s = initialState();
  const view = render(<Harness start={s} />); await settle();
  await act(async () => send({ type: "set_param", id: "exposure", param: "exposure", value: 1.25 }));
  await act(async () => { await flushAutosave(); });
  await act(async () => send({ type: "reset_image_edits", id: s.activeImage }));
  await act(async () => send({ type: "reset_settled", id: s.activeImage }));
  await act(async () => send({ type: "undo" }));
  native.save.mockClear();
  await act(async () => { await flushAutosave(); });
  const writes = native.save.mock.calls.filter(c => c[0] === s.activeImage);
  expect(writes.length).toBe(1);
  expect(writes[0][1].nodes.find((n: any) => n.id === "exposure").params.exposure).toBe(1.25);
  expect(writes[0][2]).toBe(true);
  view.unmount();
});

it("reset of a linked thumbnail saves factory around the active member's override", async () => {
  const base = initialState();
  let s = reduce(base, { type: "set_link_group", ids: [base.activeImage, "4866"], group: "review" });
  s = reduce(s, { type: "toggle_link_override", keys: ["node:exposure"] });
  const view = render(<Harness start={s} />); await settle();
  await act(async () => {
    send({ type: "set_param", id: "exposure", param: "exposure", value: 1.25 });
    send({ type: "set_param", id: "stdcolor", param: "temperature", value: 5000 });
  });
  await act(async () => send({ type: "reset_image_edits", id: "4866" }));
  expect(current().resetPending).not.toContain(s.activeImage);
  // The reset is one step on the open photograph's history.
  expect(current().undoStack[current().undoStack.length - 1]?.label).toBe("Reset Edits");
  await act(async () => { await flushAutosave(); });
  const writes = native.save.mock.calls.filter(c => c[0] === s.activeImage);
  const own = writes[writes.length - 1][1];
  expect(own.nodes.find((n: any) => n.id === "exposure").params.exposure).toBe(1.25);
  expect(own.nodes.find((n: any) => n.id === "stdcolor").params.temperature).toBe(6500);
  view.unmount();
});
it("does not autosave defaults while a graph read is unresolved or invalid", async () => {
  const read = deferred<any>(); native.load.mockReturnValue(read.promise);
  const s = initialState(); const view = render(<Harness start={s} />); await settle();
  expect(autosaves.pendingImage()).toBeNull(); expect(native.save).not.toHaveBeenCalled();
  await act(async () => read.resolve({ status: "blocked", path: "photo.json", error: "invalid JSON", broken: "photo.123.broken", last_good: false }));
  expect(screen.getByText(/Automatic saving is paused/)).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Use previous saved edits" })).toBeDisabled();
  expect(screen.getByRole("button", { name: "Use previous saved edits" }).parentElement).toHaveAttribute("data-hint");
  await act(async () => { await flushAutosave(); }); expect(native.save).not.toHaveBeenCalled(); view.unmount();
});
it.each(["absent", "ready", "blocked"])("every end of a graph read settles the render pump's hold: %s", async status => {
  const s = initialState();
  const answer = status === "ready" ? { status, graph: { nodes: s.nodes, wires: s.wires } }
    : status === "blocked" ? { status, path: "photo.json", error: "invalid JSON", broken: "photo.123.broken", last_good: false }
    : { status };
  const read = deferred<any>(); native.load.mockReturnValue(read.promise);
  const view = render(<Harness start={{ ...s, graphLoading: s.activeImage }} />); await settle();
  expect(commands.filter(c => c.type === "graph_settled")).toEqual([]);
  await act(async () => read.resolve(answer));
  expect(commands.filter(c => c.type === "graph_settled")).toEqual([{ type: "graph_settled", id: s.activeImage }]);
  view.unmount();
});
it.each(["first photo, list reloaded", "photo re-selected in the same batch as the reload"])("a folder reload under the open photo re-reads its graph instead of autosaving the template: %s", async variant => {
  // The owner's edits from days ago on P2578574 were replaced on disk by
  // the template, the edited badge still on: re-opening the folder from
  // the shortlist reloads the image list (the live graph becomes the
  // template, the stash is cleared) and lands on the photo already open,
  // so activeImage never changed, the read effect never re-ran, and the
  // autosave persisted the template within 400ms.
  const s0 = initialState();
  const target = variant.startsWith("first") ? s0.images[0].id : s0.images[1].id;
  const edited = { nodes: s0.nodes.map(n => n.id === "exposure" ? { ...n, params: { ...n.params, exposure: 2 } } : n), wires: s0.wires };
  native.load.mockResolvedValue({ status: "ready", graph: edited });
  const view = render(<Harness start={reduce(s0, { type: "select_image", id: target })} />); await settle();
  expect(commands.filter(c => c.type === "replace_graph")).toHaveLength(1);
  const readsBefore = native.load.mock.calls.length;
  await act(async () => {
    send({ type: "load_images", images: s0.images });
    if (!variant.startsWith("first")) send({ type: "select_image", id: target });
  });
  await settle();
  // The reload asked for the graph again, and the edits are back.
  expect(native.load.mock.calls.length).toBeGreaterThan(readsBefore);
  expect(commands.filter(c => c.type === "replace_graph")).toHaveLength(2);
  await act(async () => { await flushAutosave(); });
  expect(native.save).toHaveBeenCalled();
  // Whatever was saved carries the edits, never the template.
  for (const call of native.save.mock.calls) {
    const exposure = call[1].nodes.find((n: any) => n.id === "exposure");
    expect(exposure.params.exposure).toBe(2);
  }
  view.unmount();
});
it("a graph answer for the previous photograph cannot replace the new one", async () => {
  const read = deferred<any>(); native.load.mockReturnValueOnce(read.promise).mockResolvedValue({ status: "absent" });
  const s = initialState(); const view = render(<Harness start={s} />); await settle();
  await act(async () => send({ type: "select_image", id: "4875" }));
  await act(async () => read.resolve({ status: "ready", graph: { nodes: s.nodes, wires: s.wires } }));
  expect(commands.filter(c => c.type === "replace_graph")).toEqual([]); view.unmount();
});
it("a take change during a read cannot silently overwrite either edit", async () => {
  const read = deferred<any>(); native.load.mockReturnValue(read.promise); const s = initialState();
  const view = render(<Harness start={s} />); await settle();
  await act(async () => send({ type: "new_take" }));
  await act(async () => read.resolve({ status: "ready", graph: { nodes: s.nodes, wires: s.wires } }));
  expect(commands.filter(c => c.type === "replace_graph")).toEqual([]);
  expect(screen.getByText(/edit changed while saved edits were being read/)).toBeInTheDocument();
  expect(autosaves.pendingImage()).toBeNull(); view.unmount();
});
it("unmount prevents a late loaded graph from dispatching or arming a save", async () => {
  const read = deferred<any>(); native.load.mockReturnValue(read.promise); const s = initialState();
  const view = render(<Harness start={s} />); await settle(); view.unmount();
  await act(async () => read.resolve({ status: "ready", graph: { nodes: s.nodes, wires: s.wires } }));
  expect(commands).toEqual([]); expect(native.save).not.toHaveBeenCalled();
});
it("the close handler keeps the window open with a named error and Retry writes the retained payload", async () => {
  const view = render(<Harness start={initialState()} />); await settle();
  native.save.mockRejectedValueOnce(new Error("photo.nef: disk full"));
  await act(async () => native.close!({ preventDefault: vi.fn() }));
  expect(native.destroy).not.toHaveBeenCalled(); expect(screen.getByText(/photo.nef: disk full/)).toBeInTheDocument();
  await act(async () => fireEvent.click(screen.getByRole("button", { name: "Retry save" })));
  expect(native.save).toHaveBeenCalledTimes(2); expect(native.save.mock.calls[0][3]).toBe(native.save.mock.calls[1][3]);
  await act(async () => native.close!({ preventDefault: vi.fn() })); expect(native.destroy).toHaveBeenCalledTimes(1); view.unmount();
});
it.each([false, true])("explicit recovery uses the chosen payload and enables saving only after rereading: previous=%s", async previous => {
  const s = initialState(); const good = { nodes: s.nodes, wires: s.wires, activeVersion: "recovered" };
  native.good.mockResolvedValue(good);
  native.load.mockResolvedValueOnce({ status: "blocked", path: "photo.json", error: "invalid", broken: "photo.123.broken", last_good: true }).mockResolvedValue({ status: "ready", graph: good });
  const view = render(<Harness start={s} />); await settle();
  await act(async () => fireEvent.click(screen.getByRole("button", { name: previous ? "Use previous saved edits" : "Save current edit instead" })));
  expect(native.save.mock.calls[0][4]).toBe(true);
  expect(native.save.mock.calls[0][1].activeVersion).toBe(previous ? "recovered" : s.activeTakes[s.activeImage] ?? "take_1");
  expect(screen.queryByText(/Automatic saving is paused/)).not.toBeInTheDocument(); view.unmount();
});

it("close during a graph read is prevented without discarding the edit", async () => {
  const read = deferred<any>(); native.load.mockReturnValue(read.promise);
  const view = render(<Harness start={initialState()} />); await settle();
  const event = { preventDefault: vi.fn() }; await act(async () => native.close!(event));
  expect(event.preventDefault).toHaveBeenCalled(); expect(native.destroy).not.toHaveBeenCalled();
  expect(screen.getByText(/Saved edits are still being read/)).toBeInTheDocument();
  view.unmount(); await act(async () => read.resolve({ status: "absent" }));
});
it("an edit made while the previous saved copy is read cancels recovery", async () => {
  const s = initialState(); const read = deferred<any>(); native.good.mockReturnValue(read.promise);
  native.load.mockResolvedValue({ status: "blocked", path: "photo.json", error: "invalid", broken: "photo.123.broken", last_good: true });
  const view = render(<Harness start={s} />); await settle();
  fireEvent.click(screen.getByRole("button", { name: "Use previous saved edits" }));
  await act(async () => send({ type: "new_take" }));
  await act(async () => read.resolve({ nodes: s.nodes, wires: s.wires }));
  expect(native.save).not.toHaveBeenCalled(); expect(screen.getByText(/edit changed during recovery/)).toBeInTheDocument(); view.unmount();
});


it("saves a linked edit that arrives before the member's graph read finishes", async () => {
  const s0 = initialState();
  const pending = deferred<any>();
  const disk = { nodes: structuredClone(s0.nodes), wires: s0.wires };
  disk.nodes.find(n => n.id === "exposure")!.params.exposure = 2;
  native.load.mockImplementation((id: string) => id === "4866" ? pending.promise : Promise.resolve({ status: "ready", graph: { nodes: s0.nodes, wires: s0.wires } }));
  const s = reduce(s0, { type: "set_link_group", ids: [s0.activeImage, "4866"], group: "g" });
  const view = render(<Harness start={s} />);
  await settle();
  await act(async () => { send({ type: "set_param", id: "exposure", param: "exposure", value: Number(s0.nodes.find(n => n.id === "exposure")!.params.exposure) + 0.5 }); });
  await act(async () => pending.resolve({ status: "ready", graph: disk }));
  await settle();
  await act(async () => { await flushAutosave(); });
  const calls = native.save.mock.calls.filter(([id]) => id === "4866");
  expect(calls.length).toBeGreaterThan(0);
  expect(calls[calls.length - 1][1].nodes.find((n: any) => n.id === "exposure").params.exposure).toBeCloseTo(2.5);
  view.unmount();
});

it("a link edit and switch in one batch retain the unsaved member stash", async () => {
  const s0 = initialState();
  const disk = { nodes: structuredClone(s0.nodes), wires: s0.wires };
  disk.nodes.find(n => n.id === "exposure")!.params.exposure = 2;
  native.load.mockImplementation((id: string) => Promise.resolve({ status: "ready", graph: id === "4866" ? disk : { nodes: s0.nodes, wires: s0.wires } }));
  let s = reduce(s0, { type: "set_link_group", ids: [s0.activeImage, "4866"], group: "g" });
  s = reduce(s, { type: "stash_graphs", graphs: { "4866": disk } });
  const view = render(<Harness start={s} />);
  await settle();
  await act(async () => {
    send({ type: "set_param", id: "exposure", param: "exposure", value: Number(s0.nodes.find(n => n.id === "exposure")!.params.exposure) + 0.5 });
    send({ type: "select_image", id: "4866" });
  });
  await settle();
  await act(async () => { await flushAutosave(); });
  const calls = native.save.mock.calls.filter(([id]) => id === "4866");
  expect(calls.length).toBeGreaterThan(0);
  expect(calls[calls.length - 1][1].nodes.find((n: any) => n.id === "exposure").params.exposure).toBeCloseTo(2.5);
  view.unmount();
});

it("replays a deferred link edit when its photograph is opened", async () => {
  const s0 = initialState();
  const pending = deferred<any>();
  const disk = { nodes: structuredClone(s0.nodes), wires: s0.wires };
  disk.nodes.find(n => n.id === "exposure")!.params.exposure = 2;
  // The member's read is parked: the edit queues instead of mirroring,
  // and the photograph is opened before the read lands, so the replay
  // must come from the load path's settle, not from a stash.
  native.load.mockImplementation((id: string) => id === "4866" ? pending.promise : Promise.resolve({ status: "ready", graph: { nodes: s0.nodes, wires: s0.wires } }));
  const s = reduce(s0, { type: "set_link_group", ids: [s0.activeImage, "4866"], group: "g" });
  const view = render(<Harness start={s} />);
  await settle();
  await act(async () => { send({ type: "set_param", id: "exposure", param: "exposure", value: Number(s0.nodes.find(n => n.id === "exposure")!.params.exposure) + 0.5 }); });
  await act(async () => { send({ type: "select_image", id: "4866" }); });
  await act(async () => pending.resolve({ status: "ready", graph: disk }));
  await settle();
  await act(async () => { await flushAutosave(); });
  const calls = native.save.mock.calls.filter(([id]) => id === "4866");
  expect(calls.length).toBeGreaterThan(0);
  expect(calls[calls.length - 1][1].nodes.find((n: any) => n.id === "exposure").params.exposure).toBeCloseTo(2.5);
  view.unmount();
});

it("replays a deferred link edit when the opened photograph was never saved", async () => {
  const s0 = initialState();
  const pending = deferred<any>();
  native.load.mockImplementation((id: string) => id === "4866" ? pending.promise : Promise.resolve({ status: "ready", graph: { nodes: s0.nodes, wires: s0.wires } }));
  const s = reduce(s0, { type: "set_link_group", ids: [s0.activeImage, "4866"], group: "g" });
  const view = render(<Harness start={s} />);
  await settle();
  await act(async () => { send({ type: "set_param", id: "exposure", param: "exposure", value: Number(s0.nodes.find(n => n.id === "exposure")!.params.exposure) + 0.5 }); });
  await act(async () => { send({ type: "select_image", id: "4866" }); });
  await act(async () => pending.resolve({ status: "absent" }));
  await settle();
  await act(async () => { await flushAutosave(); });
  const calls = native.save.mock.calls.filter(([id]) => id === "4866");
  expect(calls.length).toBeGreaterThan(0);
  const { freshNodesFor } = await import("../state");
  const base = Number(freshNodesFor(s, "4866").find(n => n.id === "exposure")!.params.exposure);
  expect(calls[calls.length - 1][1].nodes.find((n: any) => n.id === "exposure").params.exposure).toBeCloseTo(base + 0.5);
  view.unmount();
});

it("a pending link queue does not refuse the close; the console names the photographs", async () => {
  const { getEntries } = await import("../log");
  const s0 = initialState();
  const parked = deferred<any>();
  native.load.mockImplementation((id: string) => id === "4866" ? parked.promise : Promise.resolve({ status: "ready", graph: { nodes: s0.nodes, wires: s0.wires } }));
  const s = reduce(s0, { type: "set_link_group", ids: [s0.activeImage, "4866"], group: "g" });
  const name = s.images.find(i => i.id === "4866")!.name;
  const view = render(<Harness start={s} />);
  await settle();
  await act(async () => { send({ type: "set_param", id: "exposure", param: "exposure", value: Number(s0.nodes.find(n => n.id === "exposure")!.params.exposure) + 0.5 }); });
  await settle();
  await act(async () => native.close!({ preventDefault: vi.fn() }));
  expect(native.destroy).toHaveBeenCalledTimes(1);
  expect(getEntries().some(e => e.level === "warn" && e.message.includes("Linked edits for") && e.message.includes(name))).toBe(true);
  view.unmount();
});

it("a link edit and switch in one batch leaves the dirty list once the opened photo's own save lands", async () => {
  const s0 = initialState();
  const disk = { nodes: structuredClone(s0.nodes), wires: s0.wires };
  native.load.mockImplementation((id: string) => Promise.resolve({ status: "ready", graph: id === "4866" ? disk : { nodes: s0.nodes, wires: s0.wires } }));
  const s = reduce(s0, { type: "set_link_group", ids: [s0.activeImage, "4866"], group: "g" });
  const view = render(<Harness start={s} />);
  await settle();
  await act(async () => {
    send({ type: "set_param", id: "exposure", param: "exposure", value: Number(s0.nodes.find(n => n.id === "exposure")!.params.exposure) + 0.5 });
    send({ type: "select_image", id: "4866" });
  });
  await settle();
  // 4866 became active in the same batch that dirtied it: the member
  // effect skips the active photo, so only its own save can clear it.
  expect(current().linkDirty).toContain("4866");
  await act(async () => { await flushAutosave(); });
  expect(current().linkDirty ?? []).not.toContain("4866");
  view.unmount();
});

it("a member's save clears its dirty mark only when no newer edit arrived", async () => {
  const s0 = initialState();
  native.load.mockImplementation((id: string) => Promise.resolve({ status: "ready", graph: { nodes: s0.nodes, wires: s0.wires } }));
  const s = reduce(s0, { type: "set_link_group", ids: [s0.activeImage, "4866"], group: "g" });
  const exposure = () => Number(s0.nodes.find(n => n.id === "exposure")!.params.exposure);
  const gate1 = deferred<unknown>(); const gate2 = deferred<unknown>();
  let saves = 0;
  native.save.mockImplementation((id: string) => id === "4866" ? (++saves === 1 ? gate1.promise : gate2.promise) : Promise.resolve());
  const view = render(<Harness start={s} />);
  await settle();
  await act(async () => { send({ type: "set_param", id: "exposure", param: "exposure", value: exposure() + 0.5 }); });
  await settle();
  expect(current().linkDirty).toContain("4866");
  let flushed!: Promise<boolean>;
  await act(async () => { flushed = flushAutosave(); });
  // A newer edit lands while the first write is still in flight: the
  // acknowledgment names the graph that was written, which is no
  // longer the graph in memory, so the mark must stay.
  await act(async () => { send({ type: "set_param", id: "exposure", param: "exposure", value: exposure() + 1.0 }); });
  await act(async () => { (gate1 as any).resolve(undefined); });
  await settle();
  expect(current().linkDirty).toContain("4866");
  await act(async () => { (gate2 as any).resolve(undefined); });
  await act(async () => { await flushed; });
  expect(current().linkDirty ?? []).not.toContain("4866");
  view.unmount();
});

/// The pre-merge review's F1: with quad edit up and no photograph open,
/// the quad early-return marks the empty id ready and the save effect
/// armed an autosave for it: the owner's graphs directory held a file
/// literally named ".json", a five-node default graph for image id "".
/// No photograph, no save.
it("never autosaves the empty image id", async () => {
  const s = { ...initialState(), activeImage: "", quadEdit: { ids: ["a", "b"], driver: "a", pinned: [] } };
  const view = render(<Harness start={s} />);
  await settle();
  // An edit against no photo still runs the save effect's body.
  await act(async () => { send({ type: "set_param", id: "exposure", param: "exposure", value: 0.5 }); });
  await settle();
  await act(async () => { await flushAutosave(); });
  expect(native.save.mock.calls.map((c) => c[0])).not.toContain("");
  view.unmount();
});

it("does not load the stray empty-id graph when no photograph is open", async () => {
  const s = { ...initialState(), activeImage: "", images: [] };
  native.load.mockResolvedValue({ status: "ready", graph: { nodes: s.nodes, wires: s.wires } });
  const view = render(<Harness start={s} />); await settle();
  expect(native.load).not.toHaveBeenCalledWith("");
  expect(commands.some(c => c.type === "replace_graph")).toBe(false);
  view.unmount();
});

it("removing a dirty photograph flushes its edit without saving an empty id", async () => {
  const base = initialState();
  const s = { ...base, images: base.images.filter(i => i.id === base.activeImage) };
  const view = render(<Harness start={s} />); await settle();
  await act(async () => send({ type: "set_param", id: "exposure", param: "exposure", value: 1.25 }));
  await act(async () => send({ type: "remove_images", ids: [s.activeImage] }));
  await act(async () => { await flushAutosave(); });
  // Removing the last ribbon entry currently retains its active id.
  expect(current().activeImage).toBe(s.activeImage);
  await act(async () => send({ type: "select_image", id: "" }));
  await act(async () => { await flushAutosave(); });
  expect(native.save.mock.calls.some(([id, g]) => id === s.activeImage && g.nodes.some((n: any) => n.id === "exposure" && n.params.exposure === 1.25))).toBe(true);
  expect(native.save.mock.calls.map(c => c[0])).not.toContain("");
  view.unmount();
});

it("a quad driver switch flushes the outgoing graph and saves only real ids", async () => {
  const base = initialState();
  const other = base.images.find(i => i.id !== base.activeImage)!.id;
  const s: State = { ...base, quadEdit: { ids: [base.activeImage, other], driver: base.activeImage, pinned: [] },
    quadGraphs: { [other]: { nodes: structuredClone(base.nodes), wires: structuredClone(base.wires), backdrops: [] } } };
  const view = render(<Harness start={s} />); await settle();
  await act(async () => send({ type: "set_param", id: "exposure", param: "exposure", value: 1.75 }));
  await act(async () => send({ type: "quad_anchor", id: other }));
  await settle(); await act(async () => { await flushAutosave(); });
  expect(current().activeImage).toBe(other);
  expect(native.save.mock.calls.some(([id, g]) => id === base.activeImage && g.nodes.some((n: any) => n.id === "exposure" && n.params.exposure === 1.75))).toBe(true);
  expect(native.save.mock.calls.map(c => c[0])).not.toContain("");
  view.unmount();
});

it("returning to a photograph after the empty id reads it and autosaves again", async () => {
  // A, then no photograph, then A: the guard for the empty id left the
  // last read standing, so the way back matched it, skipped the read
  // and kept the autosave blocked for A.
  const s = initialState();
  const a = s.activeImage;
  const view = render(<Harness start={s} />); await settle();
  await act(async () => send({ type: "select_image", id: "" })); await settle();
  await act(async () => send({ type: "select_image", id: a })); await settle();
  native.save.mockClear();
  await act(async () => send({ type: "set_param", id: "exposure", param: "exposure", value: 0.5 }));
  await act(async () => { await flushAutosave(); });
  expect(native.save.mock.calls.some(([id, g]) => id === a && g.nodes.some((n: any) => n.id === "exposure" && n.params.exposure === 0.5))).toBe(true);
  view.unmount();
});

/// 2026-09-28: "I don't want to add a hidden node to the photo...
/// Something like line thickness should not be tied to a specific
/// node." A photograph's own thickness is kept in its file beside the
/// graph, and setting it on an unedited photograph gives it no badge.
it("a photograph's own line thickness is saved beside its graph, with no node and no edited badge", async () => {
  const base = initialState();
  const s = { ...base, images: base.images.map((i) => ({ ...i, edited: false })) };
  const view = render(<Harness start={s} />); await settle();
  await act(async () => { await flushAutosave(); });
  native.save.mockClear();
  await act(async () => send({ type: "set_photo_line_width", width: 5 }));
  await act(async () => { await flushAutosave(); });
  const writes = native.save.mock.calls.filter(c => c[0] === s.activeImage);
  expect(writes.length).toBe(1);
  expect(writes[0][1].lineWidth).toBe(5);
  expect(writes[0][1].nodes.some((n: any) => n.type === "heeler.shape_warp")).toBe(false);
  expect(writes[0][1].nodes.some((n: any) => "line_width" in (n.params ?? {}))).toBe(false);
  expect(writes[0][2]).toBe(false);
  expect(current().images.find((i) => i.id === s.activeImage)!.edited).toBe(false);
  // Preference: the file follows the preference again.
  native.save.mockClear();
  await act(async () => send({ type: "set_photo_line_width", width: 0 }));
  await act(async () => { await flushAutosave(); });
  const back = native.save.mock.calls.filter(c => c[0] === s.activeImage);
  expect(back.length).toBe(1);
  expect("lineWidth" in back[0][1]).toBe(false);
  view.unmount();
});

it("a read puts the file's line thickness back, and a file without one follows the preference", async () => {
  const s = initialState();
  native.load.mockImplementation(async (id: string) =>
    id === s.activeImage
      ? { status: "ready", graph: { nodes: s.nodes, wires: s.wires, lineWidth: 6 } }
      : id === "4866"
        ? { status: "ready", graph: { nodes: s.nodes, wires: s.wires } }
        : { status: "absent" });
  // 4866 held a thickness this session; its file has none.
  const view = render(<Harness start={{ ...s, photoLineWidth: { "4866": 3, "4867": 4 } }} />); await settle();
  expect(current().photoLineWidth[s.activeImage]).toBe(6);
  await act(async () => send({ type: "select_image", id: "4866" })); await settle();
  expect(current().photoLineWidth["4866"]).toBeUndefined();
  // A photograph with no file keeps what this session set.
  await act(async () => send({ type: "select_image", id: "4867" })); await settle();
  expect(current().photoLineWidth["4867"]).toBe(4);
  // And the first photograph kept its own across the switches.
  expect(current().photoLineWidth[s.activeImage]).toBe(6);
  view.unmount();
});

it("a reset marker restores the photograph's line thickness without restoring edits", async () => {
  const s = initialState();
  native.load.mockResolvedValue({ status: "absent", revision: 3, lineWidth: 6 });
  const view = render(<Harness start={{ ...s, images: s.images.map(i => ({ ...i, edited: false })) }} />);
  await settle();
  expect(current().photoLineWidth[s.activeImage]).toBe(6);
  await act(async () => { await flushAutosave(); });
  expect(native.save.mock.calls[native.save.mock.calls.length - 1][2]).toBe(false);
  view.unmount();
});

it("a line thickness changed during a saved graph read wins over the old file", async () => {
  const s = initialState();
  const pending = deferred<any>();
  native.load.mockReturnValue(pending.promise);
  const view = render(<Harness start={s} />); await settle();
  await act(async () => send({ type: "set_photo_line_width", width: 7 }));
  await act(async () => pending.resolve({ status: "ready", graph: { nodes: s.nodes, wires: s.wires, lineWidth: 2 } }));
  await settle();
  expect(current().photoLineWidth[s.activeImage]).toBe(7);
  view.unmount();
});

/// "Saved edits are still being read" refused the close
/// of a catalog whose open view had no photographs. With nothing open
/// there is nothing to read: the check compared no photograph ("") with
/// no read (null) and called them different.
it("closes with no photograph open: an empty collection has nothing being read", async () => {
  const s = reduce(initialState(), { type: "load_images", images: [] });
  expect(s.activeImage).toBe("");
  const view = render(<Harness start={s} />); await settle();
  const event = { preventDefault: vi.fn() }; await act(async () => native.close!(event));
  expect(screen.queryByText(/Saved edits are still being read/)).not.toBeInTheDocument();
  expect(native.destroy).toHaveBeenCalledTimes(1); view.unmount();
});
