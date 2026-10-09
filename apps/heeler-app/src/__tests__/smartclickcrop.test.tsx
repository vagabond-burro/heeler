// A Smart click on a cropped photograph asks the model about the
// content under the pointer (2026-09-30). The model reads the click on
// the photograph, upright and uncropped; the pointer is a fraction of
// the frame. These click through the real overlays on photographs
// cropped straight, to another shape, turned and stretched, and check
// the stored click is the photograph's point under the pointer, by the
// crop op's own reading (framemap.ts frameToSource, independent of the
// walk the tool uses). A re-crop leaves the click where it is, on the
// content. The graphs are pinned for the desktop's pixel test
// (src-tauri/src/smart_click_crop.rs), which prompts a stand-in model
// with the stored click and renders the mask at Fit, 1:1 and export.
// After a deliberate change to what the reducer builds, regenerate:
//   GEN_FIXTURE=1 npx vitest run smartclickcrop

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import expected from "./fixtures/smart-click-crop.json";
import { initialState, NEUTRAL_NODES, NEUTRAL_WIRES } from "../data";
import { reduce, type Command, type State } from "../state";
import { serializeGraph } from "../bridge";
import { applyAffine, cropGeomOfParams, frameToSource, invertAffine, noteSourceSize } from "../framemap";
import { SmartClickOverlay, SmartModePanel, SmartSelectOverlay } from "../ui/smarttool";
import expectedAim from "./fixtures/smart-subject-aim.json";

vi.mock("../bridge", async (importOriginal) => {
  const real = await importOriginal<typeof import("../bridge")>();
  const model = { installed: true, label: "", license: "", url: "", bytes: 1 };
  return {
    ...real,
    smartModelStatus: vi.fn(async () => ({
      sam: { id: "mobile_sam", ...model },
      matte: { id: "birefnet_lite", ...model },
      fill: { id: "lama", ...model },
      refine: { id: "vitmatte", ...model },
    })),
    smartClick: vi.fn(async () => "mobile_sam"),
    smartSelect: vi.fn(async () => "cafecafecafecafe"),
    smartRasterStatus: vi.fn(async () => true),
  };
});

beforeEach(() => vi.clearAllMocks());

const IMAGE = "smart_click_crop";
/** The photograph: 600 by 400 pixels, the object off center, so a
 * click stored as a frame fraction lands beside it on the photograph. */
const W = 600;
const H = 400;
const OBJECT = [0.6, 0.56, 0.72, 0.74];
const CENTER: [number, number] = [(OBJECT[0] + OBJECT[2]) / 2, (OBJECT[1] + OBJECT[3]) / 2];

/** angle, stretch dial, x, y, w, h */
const CROPS: Record<string, [number, number, number, number, number, number]> = {
  straight: [0, 0, 0.35, 0.3, 0.6, 0.65],
  // 300 by 300 pixels: a square.
  square: [0, 0, 0.45, 0.25, 0.5, 0.75],
  rotated: [8, 0, 0.3, 0.3, 0.65, 0.65],
  stretched: [0, 30, 0.35, 0.3, 0.6, 0.65],
};
const cropValues = (c: number[]) => ({ angle: c[0], aspect: c[1], crop_x: c[2], crop_y: c[3], crop_w: c[4], crop_h: c[5] });

const run = (s: State, ...cmds: Command[]) => cmds.reduce(reduce, s);

function fresh(): State {
  noteSourceSize(IMAGE, W, H);
  return { ...initialState(), activeImage: IMAGE, nodes: structuredClone(NEUTRAL_NODES), wires: structuredClone(NEUTRAL_WIRES) };
}

/** Where the crop op shows a point of the photograph, in fractions of
 * the frame: the inverse of its own reading. */
function onFrame(c: number[], p: [number, number]): [number, number] {
  const g = cropGeomOfParams(cropValues(c));
  return applyAffine(invertAffine(frameToSource(g, W / H)), p);
}

/** A Develop Smart layer that brightens, then the crop. */
function smartLayer(c: number[]): State {
  let s = run(fresh(), { type: "add_layer", maskType: "smart" });
  s = run(s, { type: "set_param", id: s.activeLayer!, param: "exposure", value: 2 });
  return run(s, { type: "set_params", id: "crop", values: cropValues(c) });
}

/** The viewer's pointer mapping, pan and zoom already undone: client
 * pixels over a 1000 pixel frame. */
const norm = (e: { clientX: number; clientY: number }) => [e.clientX / 1000, e.clientY / 1000] as [number, number];

async function clickAt(overlay: "smart-overlay" | "smart-select-overlay", at: [number, number]) {
  fireEvent.mouseDown(await screen.findByTestId(overlay), { clientX: at[0] * 1000, clientY: at[1] * 1000, button: 0 });
}

function promptsOf(got: Command[], id: string) {
  const w = got.filter((c) => c.type === "set_text_param" && c.id === id && c.param === "prompts").pop() as
    | Extract<Command, { type: "set_text_param" }>
    | undefined;
  return JSON.parse(w?.value ?? "[]") as { x: number; y: number; positive: boolean }[];
}

/** One click on the object where the frame shows it, through the real
 * overlay; the state after every write the overlay made. */
async function clickObject(c: number[]): Promise<State> {
  const s = smartLayer(c);
  const mid = s.activeLayer!.replace("_adj", "_mask");
  const got: Command[] = [];
  const { unmount } = render(<SmartClickOverlay state={s} dispatch={(cmd) => got.push(cmd)} norm={norm} />);
  await clickAt("smart-overlay", onFrame(c, CENTER));
  await waitFor(() => expect(got.some((cmd) => cmd.type === "set_text_param" && cmd.param === "model")).toBe(true));
  unmount();
  const pts = promptsOf(got, mid);
  expect(pts).toHaveLength(1);
  return run(s, ...got);
}

describe("a Smart click on a cropped photograph", () => {
  it.each(Object.keys(CROPS))("prompts the model at the photograph's point under the pointer, %s", async (name) => {
    const s = await clickObject(CROPS[name]);
    const mid = s.activeLayer!.replace("_adj", "_mask");
    const [p] = JSON.parse(s.nodes.find((n) => n.id === mid)!.textParams!.prompts);
    // Within a tenth of a pixel of the object's center on the photograph.
    expect(Math.abs(p.x - CENTER[0]) * W).toBeLessThan(0.1);
    expect(Math.abs(p.y - CENTER[1]) * H).toBeLessThan(0.1);
    expect(p.positive).toBe(true);
    // The marker is drawn where the click was made.
    render(<SmartClickOverlay state={s} dispatch={() => {}} norm={norm} />);
    const dot = await screen.findByTestId("smart-point-0");
    const at = onFrame(CROPS[name], CENTER);
    expect(parseFloat(dot.style.left)).toBeCloseTo(at[0] * 100, 3);
    expect(parseFloat(dot.style.top)).toBeCloseTo(at[1] * 100, 3);
  });

  it("the document selection's Smart click is stored the same way", async () => {
    const c = CROPS.rotated;
    const s = run(fresh(), { type: "set_params", id: "crop", values: cropValues(c) }, { type: "set_select_method", method: "smart" }, { type: "arm_document_selection" });
    const got: Command[] = [];
    render(<SmartSelectOverlay state={s} dispatch={(cmd) => got.push(cmd)} norm={norm} />);
    await clickAt("smart-select-overlay", onFrame(c, CENTER));
    const [p] = promptsOf(got, "sel_doc");
    expect(Math.abs(p.x - CENTER[0]) * W).toBeLessThan(0.1);
    expect(Math.abs(p.y - CENTER[1]) * H).toBeLessThan(0.1);
    const { smartSelect } = await import("../bridge");
    expect(vi.mocked(smartSelect)).toHaveBeenCalledWith(IMAGE, "sel_doc", "click", JSON.stringify([p]));
  });

  it("a re-crop keeps the click on the content: same prompt, marker on the object", async () => {
    const clicked = await clickObject(CROPS.straight);
    const mid = clicked.activeLayer!.replace("_adj", "_mask");
    const before = clicked.nodes.find((n) => n.id === mid)!.textParams!.prompts;
    for (const c of [CROPS.square, CROPS.rotated, CROPS.stretched]) {
      const s = run(clicked, { type: "set_params", id: "crop", values: cropValues(c) });
      // The recipe, and so the raster's key and a recompute's ask, is
      // unchanged: the model is asked about the same content.
      expect(s.nodes.find((n) => n.id === mid)!.textParams!.prompts).toBe(before);
      const { unmount } = render(<SmartClickOverlay state={s} dispatch={() => {}} norm={norm} />);
      const dot = await screen.findByTestId("smart-point-0");
      const at = onFrame(c, CENTER);
      expect(parseFloat(dot.style.left)).toBeCloseTo(at[0] * 100, 3);
      expect(parseFloat(dot.style.top)).toBeCloseTo(at[1] * 100, 3);
      unmount();
    }
    // A RECOMPUTE after the re-crop sends the same click.
    const { smartClick } = await import("../bridge");
    vi.mocked(smartClick).mockClear();
    const s = run(clicked, { type: "set_params", id: "crop", values: cropValues(CROPS.square) });
    render(<SmartClickOverlay state={s} dispatch={() => {}} norm={norm} />);
    await screen.findByTestId("smart-overlay");
    // A second click after the re-crop joins the first on the same grid.
    await clickAt("smart-overlay", onFrame(CROPS.square, [0.62, 0.6]));
    await waitFor(() => expect(vi.mocked(smartClick)).toHaveBeenCalled());
    const sent = JSON.parse(vi.mocked(smartClick).mock.calls[0][2]);
    expect(sent[0]).toEqual(JSON.parse(before)[0]);
    expect(Math.abs(sent[1].x - 0.62) * W).toBeLessThan(0.1);
    expect(Math.abs(sent[1].y - 0.6) * H).toBeLessThan(0.1);
  });

  it("a click cropped out of the frame keeps prompting and shows no marker", async () => {
    const clicked = await clickObject(CROPS.straight);
    const mid = clicked.activeLayer!.replace("_adj", "_mask");
    const s = run(clicked, { type: "set_params", id: "crop", values: cropValues([0, 0, 0, 0, 0.4, 0.4]) });
    expect(s.nodes.find((n) => n.id === mid)!.textParams!.prompts).toBe(clicked.nodes.find((n) => n.id === mid)!.textParams!.prompts);
    render(<SmartClickOverlay state={s} dispatch={() => {}} norm={norm} />);
    await screen.findByTestId("smart-overlay");
    expect(screen.queryByTestId("smart-point-0")).toBeNull();
  });

  it("an uncropped photograph stores the pointer's own numbers", async () => {
    const s = run(fresh(), { type: "add_layer", maskType: "smart" });
    const mid = s.activeLayer!.replace("_adj", "_mask");
    const got: Command[] = [];
    render(<SmartClickOverlay state={s} dispatch={(cmd) => got.push(cmd)} norm={norm} />);
    await clickAt("smart-overlay", [0.37, 0.61]);
    expect(promptsOf(got, mid)).toEqual([{ x: 0.37, y: 0.61, positive: true }]);
  });

  it("pins the clicked graphs for the desktop's pixel test", async () => {
    const fixtures: Record<string, unknown> = {};
    for (const [name, c] of Object.entries(CROPS)) fixtures[name] = serializeGraph(await clickObject(c));
    // Clicked on the straight crop, then cropped square.
    const recropped = run(await clickObject(CROPS.straight), { type: "set_params", id: "crop", values: cropValues(CROPS.square) });
    fixtures.recropped = serializeGraph(recropped);
    if (process.env.GEN_FIXTURE) {
      writeFileSync(resolve(process.cwd(), "src/__tests__/fixtures/smart-click-crop.json"), JSON.stringify(fixtures, null, 1) + "\n");
    }
    expect(fixtures).toEqual(expected);
  });
});

// Subject without the matte model falls back to SAM with one prompt,
// which aimed at the middle of the uncropped photograph. The panel now
// aims it at the middle of the frame on screen, on the photograph like
// a click, in the node's own `aim` text param, never in the clicks: the
// clicks made before stay for a switch back to Click. The graph is
// pinned for the desktop's test (src-tauri/src/finish_mask_crop.rs,
// subject_with_only_sam_asks_about_the_middle_of_the_crop), which
// prompts a stand-in SAM there.
describe("Subject on a cropped photograph", () => {
  /** The subject, off the photograph's middle, as the desktop has it. */
  const SUBJECT = [0.66, 0.6, 0.86, 0.84];
  /** A crop centered on the subject. */
  const AROUND: number[] = [0, 0, 0.56, 0.5, 0.4, 0.44];

  async function subjectPicked(): Promise<{ s: State; mid: string; clicks: string }> {
    let s = run(fresh(), { type: "add_layer", maskType: "smart" });
    const mid = s.activeLayer!.replace("_adj", "_mask");
    const clicks = JSON.stringify([{ x: 0.2, y: 0.3, positive: true }]);
    s = run(s, { type: "set_text_param", id: mid, param: "prompts", value: clicks }, { type: "set_params", id: "crop", values: cropValues(AROUND) });
    const got: Command[] = [];
    const { unmount } = render(<SmartModePanel state={s} dispatch={(cmd) => got.push(cmd)} />);
    fireEvent.click(await screen.findByTestId("smart-mode-subject"));
    await waitFor(() => expect(got.some((cmd) => cmd.type === "set_text_param" && cmd.param === "model")).toBe(true));
    unmount();
    return { s: run(s, ...got), mid, clicks };
  }

  it("aims at the middle of the crop, on the photograph, beside the clicks", async () => {
    const { s, mid, clicks } = await subjectPicked();
    const node = s.nodes.find((n) => n.id === mid)!;
    expect(node.textParams!.mode).toBe("subject");
    const aim = JSON.parse(node.textParams!.aim);
    // The crop's middle on the photograph, within a tenth of a pixel.
    expect(Math.abs(aim.x - (AROUND[2] + AROUND[4] / 2)) * W).toBeLessThan(0.1);
    expect(Math.abs(aim.y - (AROUND[3] + AROUND[5] / 2)) * H).toBeLessThan(0.1);
    expect(aim.x > SUBJECT[0] && aim.x < SUBJECT[2] && aim.y > SUBJECT[1] && aim.y < SUBJECT[3]).toBe(true);
    // The compute was asked with the aim, and the clicks stayed put.
    const { smartClick } = await import("../bridge");
    expect(vi.mocked(smartClick)).toHaveBeenCalledWith(IMAGE, mid, "[]", "subject", node.textParams!.aim);
    expect(node.textParams!.prompts).toBe(clicks);
  });

  it("switching back to Click keeps the clicks", async () => {
    const { s, mid, clicks } = await subjectPicked();
    const got: Command[] = [];
    render(<SmartModePanel state={s} dispatch={(cmd) => got.push(cmd)} />);
    fireEvent.click(await screen.findByTestId("smart-mode-click"));
    const back = run(s, ...got);
    const node = back.nodes.find((n) => n.id === mid)!;
    expect(node.textParams!.mode).toBe("click");
    expect(node.textParams!.prompts).toBe(clicks);
  });

  it("pins the picked graph for the desktop's test", async () => {
    const fixtures = { subject: serializeGraph((await subjectPicked()).s) };
    if (process.env.GEN_FIXTURE) {
      writeFileSync(resolve(process.cwd(), "src/__tests__/fixtures/smart-subject-aim.json"), JSON.stringify(fixtures, null, 1) + "\n");
    }
    expect(fixtures).toEqual(expectedAim);
  });
});
