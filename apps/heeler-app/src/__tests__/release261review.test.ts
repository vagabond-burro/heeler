import { afterEach, describe, expect, it, vi } from "vitest";
import { initialState } from "../data";
import { PROFILE_DEFAULTS, type ImageEntry } from "../state";

const picture = (id: string, phoneRendered = false): ImageEntry => ({ id, name: `${id}.DNG`, phoneRendered, stars: 0, flag: "", edited: false, filter: "none", src: "" });
afterEach(() => { vi.doUnmock("../bridge"); vi.resetModules(); });

describe("26.4.1 unopened batch sources", () => {
  it("catches up an untouched phone profile while preserving camera and hand edited profiles", async () => {
    const seen: { id: string; graph: { nodes: { type: string; enabled: boolean }[] } }[] = [];
    const profiles = new Map(["phone", "camera", "edited"].map(id => [id, {
      nodes: [{ id: "tone", type: "heeler.tone_profile", name: "Tone Profile", cat: "tone", x: 0, y: 0, enabled: true,
        params: { ...PROFILE_DEFAULTS, contrast: id === "edited" ? 140 : 100, colorfulness: 0, development: 0 }, textParams: { mode: "standard" } }], wires: [],
    }]));
    vi.doMock("../bridge", async () => ({
      ...await vi.importActual<typeof import("../bridge")>("../bridge"),
      loadGraph: async (id: string) => structuredClone(profiles.get(id)),
      exportTo: async (graph: typeof seen[number]["graph"], id: string, dest: string) => { seen.push({ id, graph }); return dest; },
    }));
    vi.resetModules();
    const { runExport } = await import("../export");
    const images = [picture("phone", true), picture("camera"), picture("edited", true)];
    const s = { ...initialState(), activeImage: "other", images };
    const result = await runExport(s, images, "/review", { format: "exr", quality: 100, maxEdge: null, template: "{name}", keepMetadata: true }, () => {});
    expect(result.failed).toEqual([]);
    expect(seen.map(({ id, graph }) => [id, graph.nodes.find(n => n.type === "heeler.tone_profile")?.enabled])).toEqual([
      ["phone", false], ["camera", true], ["edited", true],
    ]);
    expect(profiles.get("phone")!.nodes[0].enabled).toBe(true);
  });
});

it("a stopped batch reports the number attempted, including graph failures", async () => {
  const progress: { done: number; total: number; current: string }[] = [];
  let attempted = 0;
  vi.doMock("../bridge", async () => ({
    ...await vi.importActual<typeof import("../bridge")>("../bridge"),
    loadGraph: async () => { attempted++; throw new Error("unreadable graph"); },
  }));
  vi.resetModules();
  const { runExport } = await import("../export");
  const images = [picture("one"), picture("two"), picture("three")];
  const s = { ...initialState(), activeImage: "other", images };
  const result = await runExport(s, images, "/review", { format: "tiff32", quality: 100, maxEdge: null, template: "same", keepMetadata: true }, p => progress.push(p), () => attempted === 1);
  expect(result.failed).toHaveLength(1);
  expect(progress).toEqual([{ done: 0, total: 3, current: "same.tif" }, { done: 1, total: 3, current: "" }]);
});

it("an unopened phone with a chosen film exports the same graph as the viewer", async () => {
  const { reduce } = await import("../state");
  const { serializeGraph } = await import("../bridge");
  let s = initialState();
  const phone = picture("phone-film", true);
  s = { ...s, activeImage: phone.id, images: [phone], nodes: s.nodes.map(n => n.type === "heeler.tone_profile" ? { ...n, enabled: false } : n) };
  const profile = s.nodes.find(n => n.type === "heeler.tone_profile")!;
  s = reduce(s, { type: "set_param", id: "bw", param: "amount", value: 100 });
  s = reduce(s, { type: "set_text_param", id: profile.id, param: "film", value: "rolleiir" });
  const expected = serializeGraph(s);
  expect(expected.nodes.find(n => n.type === "heeler.tone_profile")?.enabled).toBe(true);
  let actual: unknown;
  vi.doMock("../bridge", async () => ({
    ...await vi.importActual<typeof import("../bridge")>("../bridge"),
    loadGraph: async () => ({ nodes: s.nodes, wires: s.wires }),
    exportTo: async (graph: unknown, _id: string, dest: string) => { actual = graph; return dest; },
  }));
  vi.resetModules();
  const { runExport } = await import("../export");
  await runExport({ ...s, activeImage: "other" }, [phone], "/review", { format: "exr", quality: 100, maxEdge: null, template: "{name}", keepMetadata: true }, () => {});
  expect(actual).toEqual(expected);
});

it("serializing a live phone graph for Bake retains a profile explicitly switched on", async () => {
  const { serializeLoadedGraph } = await import("../bridge");
  const s = initialState();
  const live = { nodes: s.nodes.map(n => n.type === "heeler.tone_profile" ? { ...n, enabled: true } : n), wires: s.wires };
  const graph = serializeLoadedGraph("phone-live", live, picture("phone-live", true));
  expect(graph.nodes.find(n => n.type === "heeler.tone_profile")!.enabled).toBe(true);
});

it("the persisted headless graph retains a chosen phone Film", async () => {
  const { reduce } = await import("../state");
  const { saveGraph, loadGraphResult, serializeGraph } = await import("../bridge");
  const phone = picture("phone-saved-film", true);
  let s = { ...initialState(), activeImage: phone.id, images: [phone] };
  s = { ...s, nodes: s.nodes.map(n => n.type === "heeler.tone_profile" ? { ...n, enabled: false } : n) };
  s = reduce(s, { type: "set_param", id: "bw", param: "amount", value: 100 });
  s = reduce(s, { type: "set_text_param", id: s.nodes.find(n => n.type === "heeler.tone_profile")!.id, param: "film", value: "rolleiir" });
  const expected = serializeGraph(s);
  expect(expected.nodes.find(n => n.type === "heeler.tone_profile")?.enabled).toBe(true);
  await saveGraph(phone.id, { nodes: s.nodes, wires: s.wires }, true, undefined, false, phone);
  const saved = await loadGraphResult(phone.id);
  expect(saved.status).toBe("ready");
  if (saved.status === "ready") expect((saved.graph as unknown as { render: unknown }).render).toEqual(expected);
});
