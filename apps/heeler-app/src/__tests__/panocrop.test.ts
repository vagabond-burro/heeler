import { beforeEach, expect, it, vi } from "vitest";
import { initialState } from "../data";
import { cropNode, reduce, type State } from "../state";

const backend = vi.hoisted(() => ({ crop: vi.fn() }));
vi.mock("../bridge", async (original) => ({
  ...await original<typeof import("../bridge")>(),
  panoAutoCrop: backend.crop,
}));
import { forgetPanoCrops, offerPanoCrop } from "../panocrop";

const CROP: [number, number, number, number] = [0.01, 0.08, 0.97, 0.8];

function opened(): { get: () => State; dispatch: (c: Parameters<typeof reduce>[1]) => void } {
  let s: State = { ...initialState(), activeImage: "pan" };
  return { get: () => s, dispatch: (c) => { s = reduce(s, c); } };
}

const crop = (s: State) => {
  const p = cropNode(s).params;
  return [p.crop_x, p.crop_y, p.crop_w, p.crop_h];
};

beforeEach(() => {
  forgetPanoCrops();
  backend.crop.mockReset().mockResolvedValue(CROP);
});

it("a panorama nobody has edited opens on the rectangle it fills, as an ordinary crop", async () => {
  const doc = opened();
  await offerPanoCrop("pan", doc.get, doc.dispatch, true);
  expect(crop(doc.get())).toEqual(CROP);
  // A real Crop & Rotate node, which Undo takes back out.
  expect(doc.get().nodes.some((n) => n.type === "heeler.crop_rotate")).toBe(true);
  doc.dispatch({ type: "undo" });
  expect(crop(doc.get())).toEqual([0, 0, 1, 1]);
  await offerPanoCrop("pan", doc.get, doc.dispatch, false);
  expect(crop(doc.get())).toEqual([0, 0, 1, 1]);
});

it("an edited panorama keeps the crop it has", async () => {
  const doc = opened();
  await offerPanoCrop("pan", doc.get, doc.dispatch, false);
  expect(crop(doc.get())).toEqual([0, 0, 1, 1]);
});

it("a re-stitch moves the starting crop, but never one the user set", async () => {
  const doc = opened();
  await offerPanoCrop("pan", doc.get, doc.dispatch, true);
  backend.crop.mockResolvedValue([0.02, 0.1, 0.95, 0.75]);
  await offerPanoCrop("pan", doc.get, doc.dispatch, false);
  expect(crop(doc.get())).toEqual([0.02, 0.1, 0.95, 0.75]);

  doc.dispatch({ type: "set_params", id: cropNode(doc.get()).id, values: { crop_x: 0.3, crop_w: 0.5 } });
  backend.crop.mockResolvedValue(CROP);
  await offerPanoCrop("pan", doc.get, doc.dispatch, false);
  expect(crop(doc.get())).toEqual([0.3, 0.1, 0.5, 0.75]);
});

it("switching the option off takes the starting crop back out", async () => {
  const doc = opened();
  await offerPanoCrop("pan", doc.get, doc.dispatch, true);
  backend.crop.mockResolvedValue(null);
  await offerPanoCrop("pan", doc.get, doc.dispatch, false);
  expect(crop(doc.get())).toEqual([0, 0, 1, 1]);
});

it("an answer for a photograph no longer open changes nothing", async () => {
  const doc = opened();
  await offerPanoCrop("pan", () => ({ ...doc.get(), activeImage: "other" }), doc.dispatch, true);
  expect(crop(doc.get())).toEqual([0, 0, 1, 1]);
});

it("an answer from before auto-crop was switched off does not put the crop back", async () => {
  // The opening request can outlive the switch by minutes on a slow stitch.
  const doc = opened();
  let answer!: (crop: [number, number, number, number]) => void;
  backend.crop.mockImplementationOnce(() => new Promise((resolve) => { answer = resolve; })).mockResolvedValueOnce(null);
  const opening = offerPanoCrop("pan", doc.get, doc.dispatch, true);
  await offerPanoCrop("pan", doc.get, doc.dispatch, false);
  answer(CROP);
  await opening;
  expect(crop(doc.get())).toEqual([0, 0, 1, 1]);
});

it("an edit made while the stitch was still running keeps the panorama uncropped", async () => {
  const doc = opened();
  let answer!: (crop: [number, number, number, number]) => void;
  backend.crop.mockImplementationOnce(() => new Promise((resolve) => { answer = resolve; }));
  let edited = false;
  const current = () => ({ ...doc.get(), images: [{ ...doc.get().images[0], id: "pan", edited }] }) as State;
  const opening = offerPanoCrop("pan", current, doc.dispatch, true);
  edited = true;
  answer(CROP);
  await opening;
  expect(crop(doc.get())).toEqual([0, 0, 1, 1]);
});
