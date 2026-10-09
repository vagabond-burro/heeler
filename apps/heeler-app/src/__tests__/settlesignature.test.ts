import { expect, it } from "vitest";
import { initialState } from "../data";
import { settleSignature } from "../app";
import { serializeGraph } from "../bridge";
import { cropPreviewGraph } from "../state";

it("distinguishes equal-length graph JSON with the same djb2 hash", () => {
  const base = initialState();
  const at = (exposure: number) => ({ ...base, nodes: base.nodes.map(n => n.id === "exposure" ? { ...n, params: { ...n.params, exposure } } : n) });
  const a = at(0.520561469), b = at(0.972183134);
  const hash = (s: string) => { let h = 5381; for (const c of s) h = (h * 33 + c.charCodeAt(0)) | 0; return h; };
  const aj = JSON.stringify(serializeGraph(a)), bj = JSON.stringify(serializeGraph(b));
  expect(aj).not.toBe(bj); expect(aj.length).toBe(bj.length); expect(hash(aj)).toBe(hash(bj));
  expect(settleSignature(a)).not.toBe(settleSignature(b));
});

it("serializes the same state repeatedly without changing its signature", () => {
  const state = initialState();
  expect(settleSignature(state)).toBe(settleSignature(state));
  expect(settleSignature(structuredClone(state))).toBe(settleSignature(state));
});

it.each([
  ["image", (s: ReturnType<typeof initialState>) => ({ ...s, activeImage: "own-other-image" })],
  ["native refresh", (s: ReturnType<typeof initialState>) => ({ ...s, previewNonce: s.previewNonce + 1 })],
  ["view target", (s: ReturnType<typeof initialState>) => ({ ...s, probeNode: "exposure" })],
  ["gamut view", (s: ReturnType<typeof initialState>) => ({ ...s, gamutView: !s.gamutView })],
  ["overlay color", (s: ReturnType<typeof initialState>) => ({ ...s, prefs: { ...s.prefs, maskOverlayColor: "cyan" as const } })],
  ["overlay opacity", (s: ReturnType<typeof initialState>) => ({ ...s, brushOverlayStrength: 0.8 })],
  ["JPEG quality", (s: ReturnType<typeof initialState>) => ({ ...s, prefs: { ...s.prefs, settleQuality: "sharper" as const } })],
] as const)("rejects a cached request after %s changes", (_name, change) => {
  const state = initialState();
  expect(settleSignature(change(state))).not.toBe(settleSignature(state));
});

it("signs the crop stand-in actually sent to the renderer", () => {
  const state = initialState();
  const cropped = { ...state, nodes: state.nodes.map(n => n.type === "heeler.crop_rotate" ? { ...n, params: { ...n.params, crop_x: 0.2, crop_w: 0.6 } } : n) };
  const standIn = { ...cropped, ...cropPreviewGraph(cropped) };
  expect(settleSignature(cropped)).not.toBe(settleSignature(standIn));
});

it("includes serialized mask raster revision parameters at the same edit clock", () => {
  const state = initialState();
  const withRevision = (revision: number) => ({ ...state, nodes: [...state.nodes, { ...state.nodes[0], id: "own-mask", type: "heeler.selection_mask", params: { raster_version: revision } }] });
  expect(settleSignature(withRevision(1))).not.toBe(settleSignature(withRevision(2)));
});

it("distinguishes the mask overlay from its monochrome view at the same clock", () => {
  const state = { ...initialState(), probeNode: null, activeLayer: "own_adj", maskView: true };
  expect(settleSignature({ ...state, maskRed: false })).not.toBe(settleSignature({ ...state, maskRed: true }));
});

it("keeps the signature across a window step and a gesture edge change: the settle is the whole photograph whatever the stage", () => {
  const state = initialState();
  const wider = { ...state, view: { ...state.view, stagePx: { w: 3300, h: 2000 } }, prefs: { ...state.prefs, previewEdge: 4096 as const, gesturePreviewEdge: 512 as const } };
  expect(settleSignature(wider)).toBe(settleSignature(state));
});

it("keeps a pixel identity across edit counters while signing the graph itself", () => {
  const s = initialState();
  expect(settleSignature({ ...s, renderVersion: s.renderVersion + 2 })).toBe(settleSignature(s));
});
