import { act, render } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import { useState } from "react";
import { initialState } from "../data";
import { reduce, type Command, type State } from "../state";
import { ResetAftermath } from "../ui/resetaftermath";

const native = vi.hoisted(() => ({ reset: vi.fn(), save: vi.fn(), thumb: vi.fn() }));
vi.mock("../bridge", async (original) => ({
  ...(await original<Record<string, unknown>>()),
  isTauri: () => true,
  resetImageEdits: native.reset,
  saveGraph: native.save,
  renderThumbnail: native.thumb,
}));
vi.mock("../ui/chrome", () => ({ refreshLibrary: vi.fn().mockResolvedValue(undefined) }));

let commands: Command[] = [];
let send: (c: Command) => void;
function Harness({ start }: { start: State }) {
  const [state, setState] = useState(start);
  send = (command) => { commands.push(command); setState((s) => reduce(s, command)); };
  return <ResetAftermath state={state} dispatch={send} />;
}
const settle = async () => { await act(async () => {}); };
const deferred = <T,>() => { let resolve!: (v: T) => void; const promise = new Promise<T>((r) => { resolve = r; }); return { promise, resolve }; };
const exposureOf = (nodes: unknown[]) => (nodes as State["nodes"]).find((n) => n.id === "exposure")!.params.exposure;

beforeEach(() => {
  commands = [];
  native.reset.mockReset();
  native.save.mockReset().mockResolvedValue(undefined);
  native.thumb.mockReset().mockImplementation((s: State) => Promise.resolve(`exposure ${exposureOf(s.nodes)}`));
});

/* : "I reset an image's edits and realized I made a mistake and reset
 * the wrong image. I hit undo and it did not restore the edits. On one
 * occasion it actually added the icon to the thumbnail, but there were
 * no edits on the image." Undo of a reset made from the thumbnail
 * while another photograph is open writes the archived edits back,
 * even when the archive is still being made, with the badge on and a
 * thumbnail of the edits, not of factory.*/
it("undoing a thumbnail reset writes the archived edits back, badge and thumbnail with them", async () => {
  let s = initialState();
  const a = s.activeImage;
  const b = s.images.find((i) => i.id !== a)!.id;
  s = [
    // Its saved graph read (graph_settled), so the stash is its edits.
    { type: "select_image", id: b },
    { type: "graph_settled", id: b },
    { type: "set_param", id: "exposure", param: "exposure", value: 1.5 },
    { type: "select_image", id: a },
  ].reduce((st, c) => reduce(st, c as Command), s);
  const archive = deferred<string | null>();
  native.reset.mockReturnValue(archive.promise);
  const view = render(<Harness start={s} />);
  await settle();
  await act(async () => send({ type: "reset_image_edits", ids: [b] }));
  expect(native.reset).toHaveBeenCalledWith(b);
  await act(async () => send({ type: "undo" }));
  // Waits for the archive the reset is still making.
  expect(native.save).not.toHaveBeenCalled();
  const saved = { nodes: s.defaultGraph.nodes, wires: s.defaultGraph.wires, versions: [{ id: "take_1", nodes: [], wires: [] }, { id: "take_2", nodes: [], wires: [] }], activeVersion: "take_1", revision: 7 };
  await act(async () => archive.resolve(JSON.stringify(saved)));
  await settle();
  expect(native.save).toHaveBeenCalledTimes(1);
  const [id, doc, edited] = native.save.mock.calls[0];
  expect(id).toBe(b);
  expect(edited).toBe(true);
  // The graph the editor held for B goes over the file's, which keeps
  // its takes.
  expect(exposureOf(doc.nodes)).toBe(1.5);
  expect(doc.versions.map((v: { id: string }) => v.id)).toEqual(["take_1", "take_2"]);
  expect(exposureOf(doc.versions[0].nodes)).toBe(1.5);
  const thumbs = commands.filter((c): c is Extract<Command, { type: "set_thumb" }> => c.type === "set_thumb" && c.id === b);
  expect(thumbs[thumbs.length - 1].src).toBe("exposure 1.5");
  view.unmount();
});

it("a photograph the editor never read gets the archived document back as it was", async () => {
  let s = initialState();
  const a = s.activeImage;
  const c = s.images.find((i) => i.id !== a)!.id;
  // Edited on disk in an earlier session; nothing of it in memory.
  s = { ...s, images: s.images.map((i) => (i.id === c ? { ...i, edited: true } : i)), graphs: {} };
  const nodes = structuredClone(s.defaultGraph.nodes);
  nodes.find((n) => n.id === "exposure")!.params.exposure = -0.75;
  native.reset.mockResolvedValue(JSON.stringify({ nodes, wires: s.defaultGraph.wires, activeVersion: "take_1", revision: 4 }));
  const view = render(<Harness start={s} />);
  await settle();
  await act(async () => send({ type: "reset_image_edits", id: c }));
  await settle();
  await act(async () => send({ type: "undo" }));
  await settle();
  expect(native.save).toHaveBeenCalledTimes(1);
  expect(native.save.mock.calls[0][0]).toBe(c);
  expect(exposureOf(native.save.mock.calls[0][1].nodes)).toBe(-0.75);
  expect(native.save.mock.calls[0][2]).toBe(true);
  view.unmount();
});

it("redo before the write-back lands leaves the photograph reset", async () => {
  let s = initialState();
  const a = s.activeImage;
  const b = s.images.find((i) => i.id !== a)!.id;
  s = [
    { type: "select_image", id: b },
    { type: "set_param", id: "exposure", param: "exposure", value: 1 },
    { type: "select_image", id: a },
  ].reduce((st, c) => reduce(st, c as Command), s);
  const archive = deferred<string | null>();
  native.reset.mockReturnValueOnce(archive.promise).mockResolvedValue(null);
  const view = render(<Harness start={s} />);
  await settle();
  await act(async () => send({ type: "reset_image_edits", id: b }));
  await act(async () => send({ type: "undo" }));
  await act(async () => send({ type: "redo" }));
  await act(async () => archive.resolve(JSON.stringify({ nodes: s.defaultGraph.nodes, wires: s.defaultGraph.wires })));
  await settle();
  expect(native.save).not.toHaveBeenCalled();
  view.unmount();
});

it("undo redo undo while the original archive is pending retains the original document", async () => {
  let s = initialState();
  const id = s.images.find(i => i.id !== s.activeImage)!.id;
  s = { ...s, images: s.images.map(i => i.id === id ? { ...i, edited: true } : i), graphs: {} };
  const nodes = structuredClone(s.defaultGraph.nodes);
  nodes.find(n => n.id === "exposure")!.params.exposure = 1.75;
  const archive = deferred<string | null>();
  native.reset.mockReturnValueOnce(archive.promise).mockResolvedValue(null);
  const view = render(<Harness start={s} />);
  await act(async () => send({ type: "reset_image_edits", id }));
  await act(async () => send({ type: "undo" }));
  await act(async () => send({ type: "redo" }));
  await act(async () => archive.resolve(JSON.stringify({ nodes, wires: s.defaultGraph.wires })));
  await settle();
  await act(async () => send({ type: "undo" }));
  await settle();
  expect(native.save).toHaveBeenCalledTimes(1);
  expect(exposureOf(native.save.mock.calls[0][1].nodes)).toBe(1.75);
  view.unmount();
});

it("a completed old restore cannot remove a newer redo archive", async () => {
  let s = initialState();
  const id = s.images.find(i => i.id !== s.activeImage)!.id;
  s = { ...s, images: s.images.map(i => i.id === id ? { ...i, edited: true } : i), graphs: {} };
  const nodes = structuredClone(s.defaultGraph.nodes);
  nodes.find(n => n.id === "exposure")!.params.exposure = 1.25;
  const saved = JSON.stringify({ nodes, wires: s.wires });
  native.reset.mockResolvedValue(saved);
  const pendingSave = deferred<void>();
  native.save.mockReturnValueOnce(pendingSave.promise).mockResolvedValue(undefined);
  const view = render(<Harness start={s} />);
  await act(async () => send({ type: "reset_image_edits", id }));
  await act(async () => send({ type: "undo" }));
  expect(native.save).toHaveBeenCalledTimes(1);
  await act(async () => send({ type: "redo" }));
  await act(async () => pendingSave.resolve());
  await act(async () => send({ type: "undo" }));
  await settle();
  expect(native.save).toHaveBeenCalledTimes(2);
  expect(exposureOf(native.save.mock.calls[1][1].nodes)).toBe(1.25);
  view.unmount();
});
