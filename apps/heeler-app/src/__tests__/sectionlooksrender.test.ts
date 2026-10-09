// A held section look rides in the viewer's render requests and in no
// other request (src/sectionlooks.ts, the owner 2026-09-30). The engine
// is the native invoke, mocked, so each test reads exactly what was
// sent.
import { afterEach, beforeEach, expect, it, vi } from "vitest";
const native = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: native.invoke }));
import { exportImage, releaseSettleFrames, renderPreview, renderRoi, settleWanted } from "../bridge";
import { initialState } from "../data";
import { lookById } from "../sectionlooks";
import { reduce, type Command, type State } from "../state";

function envelope() {
  const json = new TextEncoder().encode(
    JSON.stringify({ mime: "image/jpeg", ms: 1, image_id: "review", backend: "cpu", roi: [0, 0, 1, 1], frame: [100, 100], source_identity: "s" }),
  );
  const out = new Uint8Array(8 + json.length + 3);
  out.set([72, 80, 82, 86]);
  new DataView(out.buffer).setUint32(4, json.length, true);
  out.set(json, 8);
  out.set([255, 216, 217], 8 + json.length);
  return out.buffer;
}

let serial = 0;
beforeEach(() => {
  vi.stubGlobal("__TAURI_INTERNALS__", {});
  const NativeURL = URL;
  vi.stubGlobal("URL", class extends NativeURL {
    static createObjectURL = vi.fn(() => `blob:look-${++serial}`);
    static revokeObjectURL = vi.fn();
  });
  native.invoke.mockReset().mockImplementation(async (cmd: string) => (cmd === "render_preview" ? envelope() : "/out/x.jpg"));
});
afterEach(() => {
  releaseSettleFrames();
  vi.unstubAllGlobals();
});

const run = (s: State, ...cmds: Command[]) => cmds.reduce(reduce, s);

function freePhoto(): State {
  const s = initialState();
  return { ...s, activeImage: "review", nodes: structuredClone(s.defaultGraph.nodes), wires: structuredClone(s.defaultGraph.wires) };
}

type Sent = { graph: { nodes: { id: string; enabled: boolean; params: Record<string, unknown> }[] }; fast?: boolean; fullRes?: boolean };
const sent = (i = -1): Sent => {
  const calls = native.invoke.mock.calls;
  return calls[(i + calls.length) % calls.length][1] as Sent;
};
const toneeqIn = (args: Sent) => args.graph.nodes.find((n) => n.id === "toneeq");

it("holding a look puts it in the preview request at the gesture tier; letting go takes it out", async () => {
  const s = freePhoto();
  const look = lookById("relight-low-key")!;
  const held = run(s, { type: "preview_section_look", id: look.id });
  await renderPreview(held);
  const during = sent();
  expect(toneeqIn(during)?.enabled).toBe(true);
  expect(toneeqIn(during)?.params.points).toBe(look.text.points);
  expect(during.fast).toBe(true);
  // The follow-up frame of the same look, at the preview tier.
  await renderPreview(held, { lookSharp: true });
  expect(toneeqIn(sent())?.params.points).toBe(look.text.points);
  expect(sent().fast).toBe(false);
  // Let go: the photograph's own graph, at the ordinary tier.
  const back = run(held, { type: "preview_section_look", id: null });
  await renderPreview(back);
  expect(toneeqIn(sent())).toBeUndefined();
  expect(sent().fast).toBe(false);
});

it("the 1:1 slice carries the look while it is held", async () => {
  const held = run(freePhoto(), { type: "preview_section_look", id: "recolor-deep-skies" });
  const patch = await renderRoi(held, [0, 0, 1, 1]);
  const recolor = sent().graph.nodes.find((n) => n.id === "recolor");
  expect(recolor?.params.curves).toBe(lookById("recolor-deep-skies")!.text.curves);
  expect(patch?.look).toContain("recolor-deep-skies");
});

it("an export during the hold and after it is the photograph's own graph", async () => {
  const s = freePhoto();
  const opts = { format: "jpeg" as const, quality: 90, maxEdge: null, keepMetadata: false };
  await exportImage(s, opts);
  const before = JSON.stringify(sent().graph);
  const held = run(s, { type: "preview_section_look", id: "relight-open-shadows" });
  await exportImage(held, opts);
  expect(native.invoke.mock.calls[native.invoke.mock.calls.length - 1][0]).toBe("export_image");
  expect(JSON.stringify(sent().graph)).toBe(before);
  const back = run(held, { type: "preview_section_look", id: null });
  await exportImage(back, opts);
  expect(JSON.stringify(sent().graph)).toBe(before);
});

it("no full-resolution settle is spent on a held look", () => {
  const s = { ...freePhoto(), prefs: { ...freePhoto().prefs, settledPreview: "full" as const } };
  expect(settleWanted(s)).toBe(true);
  expect(settleWanted(run(s, { type: "preview_section_look", id: "relight-low-key" }))).toBe(false);
});
