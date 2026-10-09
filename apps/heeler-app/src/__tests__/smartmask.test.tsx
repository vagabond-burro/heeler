// Smart selection P1's frontend half: the Smart layer type, the
// click tool's recipe writes, and the consent card. The model itself
// is pinned by the vision crate's gated test; nothing here needs it.

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { initialState } from "../data";
import { artMaskNode, reduce, toolForMaskType, type Command, type State } from "../state";
import { RemoveRunner, SmartClickOverlay, SmartModePanel, SmartSelectOverlay } from "../ui/smarttool";

vi.mock("../bridge", async (importOriginal) => {
  const real = await importOriginal<typeof import("../bridge")>();
  return {
    ...real,
    smartModelStatus: vi.fn(async () => ({
      sam: {
        id: "mobile_sam",
        installed: mockInstalled,
        label: "Segment Anything (MobileSAM)",
        license: "Apache-2.0",
        url: "https://example.test/model.zip",
        bytes: 36_655_105,
      },
      matte: {
        id: "birefnet_lite",
        installed: mockMatte,
        label: "BiRefNet Lite (subject matte)",
        license: "MIT",
        url: "https://example.test/matte.onnx",
        bytes: 224_005_088,
      },
      fill: {
        id: "lama",
        installed: mockFill,
        label: "LaMa (inpainting)",
        license: "Apache-2.0",
        url: "https://example.test/lama.onnx",
        bytes: 208_044_816,
      },
      refine: {
        id: "vitmatte",
        installed: mockRefine,
        label: "ViTMatte (edge refinement)",
        license: "Apache-2.0 weights, MIT code",
        url: "https://example.test/vitmatte.onnx",
        bytes: 103_885_865,
      },
    })),
    inpaintFill: vi.fn(async () => "fill123"),
    smartModelDownload: vi.fn(async () => {}),
    smartClick: vi.fn(async () => "mobile_sam"),
    smartMatte: vi.fn(async () => "mobile_sam+vitmatte"),
    smartRasterStatus: vi.fn(async () => mockCached),
    smartSelect: vi.fn(async () => "cafecafecafecafe"),
  };
});
let mockInstalled = true;
let mockCached = true;
let mockMatte = true;
let mockFill = true;
let mockRefine = true;

const run = (s: State, ...cmds: Command[]) => cmds.reduce(reduce, s);

beforeEach(() => {
  mockInstalled = true;
  mockCached = true;
  mockMatte = true;
  mockFill = true;
  mockRefine = true;
  vi.clearAllMocks();
});

describe("the Smart layer", () => {
  it("builds a smart_mask node with the recipe params from birth", () => {
    const s = run(initialState(), { type: "add_layer", maskType: "smart" });
    const mask = s.nodes.find((n) => n.id === s.activeLayer!.replace("_adj", "_mask"))!;
    expect(mask.type).toBe("heeler.smart_mask");
    expect(mask.textParams).toEqual({ mode: "click", prompts: "[]", model: "" });
    expect(mask.params.threshold).toBe(50);
    // Creating the layer arms the click tool, like brush arms brush.
    expect(s.tool).toBe("smart");
    expect(toolForMaskType("smart", "none")).toBe("smart");
  });
});

describe("the click overlay", () => {
  const withSmart = () => run(initialState(), { type: "add_layer", maskType: "smart" });
  const norm = (e: { clientX: number; clientY: number }) =>
    [e.clientX / 100, e.clientY / 100] as [number, number];

  it("renders only over an active smart layer", () => {
    const { rerender } = render(
      <SmartClickOverlay state={withSmart()} dispatch={() => {}} norm={norm} />,
    );
    expect(screen.getByTestId("smart-overlay")).toBeTruthy();
    rerender(<SmartClickOverlay state={initialState()} dispatch={() => {}} norm={norm} />);
    expect(screen.queryByTestId("smart-overlay")).toBeNull();
  });

  it("a click writes the prompt to the node; ALT writes a negative", async () => {
    const s = withSmart();
    const maskId = s.activeLayer!.replace("_adj", "_mask");
    const got: Command[] = [];
    render(<SmartClickOverlay state={s} dispatch={(c) => got.push(c)} norm={norm} />);
    // Let the status resolve so the click path is open.
    await screen.findByTestId("smart-overlay");
    fireEvent.mouseDown(screen.getByTestId("smart-overlay"), { clientX: 40, clientY: 60, button: 0 });
    const write = got.find(
      (c) => c.type === "set_text_param" && c.param === "prompts",
    ) as Extract<Command, { type: "set_text_param" }>;
    expect(write.id).toBe(maskId);
    expect(JSON.parse(write.value)).toEqual([{ x: 0.4, y: 0.6, positive: true }]);

    // One compute at a time: the overlay holds clicks while busy, so
    // wait for the first decode's promise to settle before the next.
    await waitFor(() => expect(screen.queryByTestId("smart-busy")).toBeNull());
    got.length = 0;
    fireEvent.mouseDown(screen.getByTestId("smart-overlay"), {
      clientX: 10, clientY: 20, button: 0, altKey: true,
    });
    const neg = got.find(
      (c) => c.type === "set_text_param" && c.param === "prompts",
    ) as Extract<Command, { type: "set_text_param" }>;
    expect(JSON.parse(neg.value).pop()).toEqual({ x: 0.1, y: 0.2, positive: false });
  });

  it("shows existing clicks as markers", () => {
    let s = withSmart();
    const maskId = s.activeLayer!.replace("_adj", "_mask");
    s = run(s, {
      type: "set_text_param",
      id: maskId,
      param: "prompts",
      value: JSON.stringify([
        { x: 0.5, y: 0.5, positive: true },
        { x: 0.2, y: 0.2, positive: false },
      ]),
    });
    const { rerender } = render(
      <SmartClickOverlay state={s} dispatch={() => {}} norm={norm} />,
    );
    expect(screen.getByTestId("smart-point-0")).toBeTruthy();
    expect(screen.getByTestId("smart-point-1")).toBeTruthy();
    // The Select menu can put the dots away ("maybe an
    // option in the Select menu to toggle the dots visibility
    // off?"); the prompts themselves stay, only their marks go.
    const quiet = run(s, { type: "set_ui_setting", key: "selectShowClicks", value: false });
    rerender(<SmartClickOverlay state={quiet} dispatch={() => {}} norm={norm} />);
    expect(screen.queryByTestId("smart-point-0")).toBeNull();
  });

  it("clicks with no pixels wear the badge, and RECOMPUTE asks again", async () => {
    mockCached = false;
    let s = withSmart();
    const maskId = s.activeLayer!.replace("_adj", "_mask");
    const prompts = JSON.stringify([{ x: 0.5, y: 0.5, positive: true }]);
    s = run(s, { type: "set_text_param", id: maskId, param: "prompts", value: prompts });
    const got: Command[] = [];
    render(<SmartClickOverlay state={s} dispatch={(c) => got.push(c)} norm={norm} />);
    const badge = await screen.findByTestId("smart-uncomputed");
    expect(badge.textContent).toContain("NOT COMPUTED");
    fireEvent.click(screen.getByTestId("smart-recompute"));
    const { smartClick } = await import("../bridge");
    expect(vi.mocked(smartClick)).toHaveBeenCalledWith(s.activeImage, maskId, prompts, "click");
  });

  it("the one-shot chips (in the PANEL, ) set the mode and compute", async () => {
    const s = withSmart();
    const maskId = s.activeLayer!.replace("_adj", "_mask");
    const got: Command[] = [];
    render(<SmartModePanel state={s} dispatch={(c) => got.push(c)} />);
    await screen.findByTestId("smart-modes");
    fireEvent.click(screen.getByTestId("smart-mode-sky"));
    expect(got).toContainEqual({ type: "set_text_param", id: maskId, param: "mode", value: "sky" });
    const { smartClick } = await import("../bridge");
    expect(vi.mocked(smartClick)).toHaveBeenCalledWith(s.activeImage, maskId, "[]", "sky");
    // And the chips are NOT on the photograph any more: the overlay
    // renders markers and cards, never the mode row.
    render(<SmartClickOverlay state={s} dispatch={() => {}} norm={norm} />);
    expect(screen.getAllByTestId("smart-modes")).toHaveLength(1);
  });

  it("CLEAR sits between RESET and Show mask in the Layers panel", async () => {
    // The owner's seating. The header row for a smart layer runs
    // Reset, Clear, Show mask, in that order.
    const { App } = await import("../app");
    const { default: userEvent } = await import("@testing-library/user-event");
    const user = userEvent.setup();
    render(<App />);
    await user.click(screen.getByTestId("add-layer-smart"));
    const reset = screen.getByTestId("mask-reset");
    const clear = screen.getByTestId("smart-clear");
    const show = screen.getByTestId("mask-view-toggle");
    const row = reset.parentElement!;
    const order = [...row.children];
    expect(order.indexOf(clear)).toBeGreaterThan(order.indexOf(reset));
    expect(order.indexOf(clear)).toBeLessThan(order.indexOf(show));
  });

  it("CLEAR forgets the selection in one undoable step", async () => {
    let s = withSmart();
    const maskId = s.activeLayer!.replace("_adj", "_mask");
    s = run(s, {
      type: "set_params",
      id: maskId,
      values: {},
      text: { prompts: JSON.stringify([{ x: 0.5, y: 0.5, positive: true }]), model: "mobile_sam" },
    });
    const got: Command[] = [];
    render(<SmartModePanel state={s} dispatch={(c) => got.push(c)} />);
    fireEvent.click(screen.getByTestId("smart-clear"));
    // The mode resets with the rest: sky with no prompts is the same
    // recipe that computed the sky, and clearing everything BUT the mode
    // left the old raster planting. "I could click clear but
    // it didn't do anything."
    expect(got).toContainEqual({
      type: "set_params",
      id: maskId,
      values: {},
      text: { mode: "click", prompts: "[]", model: "" },
      // The shapes drawn on it with the selection tools go too.
      clearRegions: true,
    });
    // With nothing selected, CLEAR has nothing to do.
    const fresh = withSmart();
    render(<SmartModePanel state={fresh} dispatch={() => {}} />);
    const clears = screen.getAllByTestId("smart-clear");
    expect((clears[clears.length - 1] as HTMLButtonElement).disabled).toBe(true);
  });

  it("MATTE refines the computed selection and signs the model for it", async () => {
    // The owner's sky test: "What is missing is that smart matte that
    // selection polish does to refine that selection masking around the
    // mountains." One press: the refined raster lands under
    // "<base>+vitmatte", which is provenance and cache key at once.
    let s = withSmart();
    const maskId = s.activeLayer!.replace("_adj", "_mask");
    s = run(s, {
      type: "set_params",
      id: maskId,
      values: {},
      text: { mode: "sky", prompts: "[]", model: "mobile_sam" },
    });
    const got: Command[] = [];
    render(<SmartModePanel state={s} dispatch={(c) => got.push(c)} />);
    fireEvent.click(screen.getByTestId("smart-matte"));
    const { smartMatte } = await import("../bridge");
    await waitFor(() => expect(vi.mocked(smartMatte)).toHaveBeenCalledWith(
      s.activeImage, maskId, "sky", "[]", "mobile_sam",
    ));
    await waitFor(() =>
      expect(got).toContainEqual({
        type: "set_text_param",
        id: maskId,
        param: "model",
        value: "mobile_sam+vitmatte",
      }),
    );
  });

  it("MATTE with nothing computed is disabled, and asks consent for its model", async () => {
    // No selection yet: nothing to refine.
    const fresh = withSmart();
    render(<SmartModePanel state={fresh} dispatch={() => {}} />);
    expect((screen.getByTestId("smart-matte") as HTMLButtonElement).disabled).toBe(true);

    // Model missing: the consent line, nothing fetched silently.
    mockRefine = false;
    let s = withSmart();
    const maskId = s.activeLayer!.replace("_adj", "_mask");
    s = run(s, {
      type: "set_params",
      id: maskId,
      values: {},
      text: { mode: "subject", prompts: "[]", model: "birefnet_lite" },
    });
    render(<SmartModePanel state={s} dispatch={() => {}} />);
    const mattes = screen.getAllByTestId("smart-matte");
    await waitFor(() =>
      expect((mattes[mattes.length - 1] as HTMLButtonElement).disabled).toBe(false),
    );
    fireEvent.click(mattes[mattes.length - 1]);
    await screen.findByTestId("smart-matte-consent");
    expect(screen.getByTestId("smart-matte-consent").textContent).toContain("ViTMatte");
    const { smartMatte, smartModelDownload } = await import("../bridge");
    expect(vi.mocked(smartMatte)).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId("smart-matte-download"));
    await waitFor(() =>
      expect(vi.mocked(smartModelDownload)).toHaveBeenCalledWith("vitmatte"),
    );
  });

  it("a fresh mask with no clicks wears no badge", async () => {
    mockCached = false;
    render(<SmartClickOverlay state={withSmart()} dispatch={() => {}} norm={norm} />);
    await screen.findByTestId("smart-overlay");
    expect(screen.queryByTestId("smart-uncomputed")).toBeNull();
  });

  it("subject mode without the matte model offers the upgrade, consented", async () => {
    mockMatte = false;
    let s = withSmart();
    const maskId = s.activeLayer!.replace("_adj", "_mask");
    s = run(s, { type: "set_text_param", id: maskId, param: "mode", value: "subject" });
    render(<SmartClickOverlay state={s} dispatch={() => {}} norm={norm} />);
    const offer = await screen.findByTestId("smart-matte-offer");
    expect(offer.textContent).toContain("BiRefNet");
    expect(offer.textContent).toContain("224 MB");
    expect(offer.textContent).toContain("MIT");
    const { smartModelDownload } = await import("../bridge");
    fireEvent.click(screen.getByTestId("smart-matte-download"));
    expect(vi.mocked(smartModelDownload)).toHaveBeenCalledWith("birefnet_lite");
  });

  it("the completion write records the model that answered", async () => {
    const { smartClick } = await import("../bridge");
    vi.mocked(smartClick).mockResolvedValueOnce("birefnet_lite");
    let s = withSmart();
    const maskId = s.activeLayer!.replace("_adj", "_mask");
    s = run(s, { type: "set_text_param", id: maskId, param: "mode", value: "subject" });
    const got: Command[] = [];
    render(<SmartModePanel state={s} dispatch={(c) => got.push(c)} />);
    await screen.findByTestId("smart-modes");
    // Re-picking SUBJECT recomputes; the write carries what came back.
    fireEvent.click(screen.getByTestId("smart-mode-subject"));
    await waitFor(() =>
      expect(got).toContainEqual({
        type: "set_text_param",
        id: maskId,
        param: "model",
        value: "birefnet_lite",
      }),
    );
  });

  it("without the model, the consent card names everything and blocks clicks", async () => {
    mockInstalled = false;
    const got: Command[] = [];
    render(<SmartClickOverlay state={withSmart()} dispatch={(c) => got.push(c)} norm={norm} />);
    const card = await screen.findByTestId("smart-consent");
    expect(card.textContent).toContain("MobileSAM");
    expect(card.textContent).toContain("Apache-2.0");
    expect(card.textContent).toContain("37 MB");
    expect(card.textContent).toContain("example.test");
    fireEvent.mouseDown(screen.getByTestId("smart-overlay"), { clientX: 40, clientY: 60, button: 0 });
    expect(got.filter((c) => c.type === "set_text_param")).toHaveLength(0);
    // NOT NOW puts the tool down instead of leaving a dead crosshair.
    fireEvent.click(screen.getByTestId("smart-not-now"));
    expect(got).toContainEqual({ type: "set_tool", tool: "none" });
  });
});

describe("REMOVE: the fill through the selection", () => {
  const withSelected = () => {
    let s = run(initialState(), { type: "add_layer", maskType: "smart" });
    const maskId = s.activeLayer!.replace("_adj", "_mask");
    s = run(s, {
      type: "set_params",
      id: maskId,
      values: {},
      text: { prompts: JSON.stringify([{ x: 0.5, y: 0.5, positive: true }]), model: "mobile_sam" },
    });
    return { s, maskId };
  };

  it("the splice puts an Inpaint at the end of the chain, its hole a snapshot", () => {
    const { s: s0, maskId } = withSelected();
    const s = run(s0, { type: "add_inpaint_for", maskId });
    const id = `inpaint_${maskId}`;
    const node = s.nodes.find((n) => n.id === id)!;
    expect(node.type).toBe("heeler.inpaint");
    const output = s.nodes.find((n) => n.type === "heeler.output")!;
    expect(s.wires.some((w) => w.from === id && w.to === output.id)).toBe(true);
    // The hole is a baked-selection SNAPSHOT (empty pointer until the
    // runner bakes the source's render); the live mask is not wired in
    // at all, so it stays the user's - and any mask type can be the
    // source now. "What is missing is doing an inpaint from
    // a selection."
    const holeId = `inpaint_m_${maskId}`;
    const hole = s.nodes.find((n) => n.id === holeId)!;
    expect(hole.type).toBe("heeler.selection_mask");
    expect(hole.textParams?.matte_id).toBe("");
    expect(s.wires.some((w) => w.from === holeId && w.to === id && w.toPort === "mask")).toBe(true);
    expect(s.wires.some((w) => w.from === maskId && w.to === id)).toBe(false);
    // Editing the live selection afterwards never reaches the hole.
    const edited = run(s, {
      type: "set_text_param",
      id: maskId,
      param: "prompts",
      value: '[{"x":0.1,"y":0.1,"positive":true}]',
    });
    expect(edited.nodes.find((n) => n.id === holeId)!.textParams).toEqual(hole.textParams);
    // Undoable graph surgery, and idempotent: asking twice splices once.
    expect(s.undoStack.length).toBeGreaterThan(s0.undoStack.length);
    expect(run(s, { type: "add_inpaint_for", maskId })).toBe(s);
  });

  it("a Remove never freezes the selection: the hole is a snapshot", () => {
    // The selection should stay clearable and refinable after object
    // removal. The removal owns a copy of the selection as it was; the
    // live one stays his.
    const { s: s0, maskId } = withSelected();
    const s = run(s0, { type: "add_inpaint_for", maskId });
    render(<SmartModePanel state={s} dispatch={() => {}} />);
    expect(screen.queryByTestId("smart-removed-note")).toBeNull();
    for (const id of ["smart-mode-click", "smart-mode-subject", "smart-mode-sky", "smart-matte", "smart-clear"]) {
      expect((screen.getByTestId(id) as HTMLButtonElement).disabled).toBe(false);
    }
  });

  it("a DRAWN selection feeds Remove Object too", async () => {
    // "What is missing is doing an inpaint from a
    // selection" - and then, seeing it: "okay that was the Remove
    // Object. Until now I did not understand what it was for."
    const { runCommand } = await import("../commands");
    let s = run(initialState(), { type: "add_layer", maskType: "selection" });
    const maskId = s.activeLayer!.replace("_adj", "_mask");
    s = run(s, {
      type: "add_region",
      id: maskId,
      region: {
        kind: "path",
        op: "replace",
        points: [[0.2, 0.2], [0.8, 0.2], [0.8, 0.8], [0.2, 0.8]],
      },
    });
    // The TAB routes the result ("context matters"):
    // Adjustments splices the chain, Finish makes a Fill layer.
    const got: Command[] = [];
    expect(runCommand("select.remove_object", s, (c) => got.push(c))).toBe(true);
    expect(got).toContainEqual({ type: "add_inpaint_for", maskId });
    const inFinish = run(s, { type: "set_panel_tab", tab: "layers" });
    const art: Command[] = [];
    expect(runCommand("select.remove_object", inFinish, (c) => art.push(c))).toBe(true);
    expect(art).toContainEqual({ type: "art_remove_from_selection", maskId });
    // An empty drawn selection refuses.
    const fresh = run(initialState(), { type: "add_layer", maskType: "selection" });
    expect(runCommand("select.remove_object", fresh, () => {})).toBe(false);
  });

  /** The selection panel's door (2026-09-22): "when I click the [X] to
   * put the select tool away everything deselects", against the hint
   * that says the selection itself stays. The door used to step off the
   * layer, and set_active_layer dropped the layer's pick with it. Now
   * the tool goes away, the panel closes, and the layer, its selection
   * and its pick stay; the select tool or a layer click reopens the
   * panel.*/
  it("closing the selection panel puts the tool away and keeps the layer and its selection", () => {
    let s = run(initialState(), { type: "add_layer", maskType: "selection" });
    const adjId = s.activeLayer!;
    const maskId = adjId.replace("_adj", "_mask");
    // A new selection layer arms the select tool by itself.
    expect(s.tool).toBe("select");
    s = run(s, { type: "add_region", id: maskId, region: { kind: "path", op: "replace", points: [[0.2, 0.2], [0.8, 0.2], [0.8, 0.8]] } });
    const regions = s.nodes.find((n) => n.id === maskId)!.regions;
    const picks = s.selection;
    s = run(s, { type: "close_selection_split" });
    expect(s.tool).toBe("none");
    expect(s.selectionSplitClosed).toBe(true);
    expect(s.activeLayer).toBe(adjId);
    expect(s.selection).toEqual(picks);
    expect(s.nodes.find((n) => n.id === maskId)!.regions).toEqual(regions);
    // With no select tool in hand the door only closes the panel.
    const again = run(s, { type: "close_selection_split" });
    expect(again.tool).toBe("none");
    expect(again.activeLayer).toBe(adjId);
    // The select tool reopens it; so does a layer click.
    expect(run(s, { type: "set_tool", tool: "select" }).selectionSplitClosed).toBe(false);
    expect(run(s, { type: "set_active_layer", id: adjId }).selectionSplitClosed).toBe(false);
    expect(run(s, { type: "arm_document_selection" }).selectionSplitClosed).toBe(false);
    // A tool that is not the select tool leaves it closed.
    expect(run(s, { type: "set_tool", tool: "crop" }).selectionSplitClosed).toBe(true);
  });

  it("a Finish removal is a Fill layer: baked hole mask, filled content", async () => {
    // "if I am working in Finish tab, the results should
    // end up in a Fill layer." The layer's mask snapshots the
    // selection (baked, like the chain flavor's hole); the content
    // is the model's fill; delete the layer and the object comes
    // back.
    const { artLayers, removalPending } = await import("../state");
    const { s: s0, maskId } = withSelected();
    let cur = run(s0, { type: "art_remove_from_selection", maskId });
    const layer = artLayers(cur).find((l) => l.content.type === "heeler.inpaint")!;
    expect(layer.content.name).toBe("Removed object");
    const artMask = artMaskNode(cur, `art_m_${layer.blend.id}`)!;
    expect(artMask.textParams?.source).toBe(maskId);
    expect(artMask.textParams?.matte_id).toBe("");
    expect(removalPending(cur, maskId)).toBe(true);
    // The creation is ONE undo, checked before the runner adds its
    // own history entries.
    const undone = run(cur, { type: "undo" });
    expect(artLayers(undone).some((l) => l.content.type === "heeler.inpaint")).toBe(false);
    // The runner bakes the source into the mask, then fills against it.
    const dispatch = (c: Command) => {
      cur = reduce(cur, c);
      rerender(<RemoveRunner state={cur} dispatch={dispatch} />);
    };
    const { rerender, unmount } = render(<RemoveRunner state={cur} dispatch={dispatch} />);
    await waitFor(() =>
      expect(artMaskNode(cur, artMask.id)!.textParams?.matte_id).toBe(
        "baked:beefbeefbeefbeef",
      ),
    );
    await waitFor(() => {
      const l = artLayers(cur).find((k) => k.blend.id === layer.blend.id)!;
      expect(l.content.textParams?.fill_id).toBe("fill123");
      expect(l.content.textParams?.model).toBe("lama");
    });
    expect(removalPending(cur, maskId)).toBe(false);
    unmount();
  });

  it("a reused layer id fills again: the attempt latch dies with the layer", async () => {
    // Finish layer ids are REUSED after a delete (delete art_b1, the next
    // layer is art_b1 again). The runner's attempt latch keyed on the bare
    // id, so the second removal baked its hole and silently skipped its
    // fill. "It creates the layer, then nothing."
    const { artLayers } = await import("../state");
    const { s: s0, maskId } = withSelected();
    let cur = run(s0, { type: "art_remove_from_selection", maskId });
    const dispatch = (c: Command) => {
      cur = reduce(cur, c);
      rerender(<RemoveRunner state={cur} dispatch={dispatch} />);
    };
    const { rerender, unmount } = render(<RemoveRunner state={cur} dispatch={dispatch} />);
    const firstBlend = artLayers(cur).find((l) => l.content.type === "heeler.inpaint")!.blend.id;
    await waitFor(() =>
      expect(
        artLayers(cur).find((l) => l.blend.id === firstBlend)!.content.textParams?.fill_id,
      ).toBe("fill123"),
    );
    // Delete the layer, remove the same selection again: same id, and
    // the fill must land a second time.
    dispatch({ type: "art_remove_layer", id: firstBlend });
    dispatch({ type: "art_remove_from_selection", maskId });
    const second = artLayers(cur).find((l) => l.content.type === "heeler.inpaint")!;
    expect(second.blend.id).toBe(firstBlend);
    await waitFor(() =>
      expect(
        artLayers(cur).find((l) => l.blend.id === firstBlend)!.content.textParams?.fill_id,
      ).toBe("fill123"),
    );
    unmount();
  });

  it("Selection from Mask: any mask's render loads as the document selection", async () => {
    // The last leg of the round trip: To Mask turns a selection into
    // a mask; this turns any mask back into THE selection - a baked
    // base on the document selection, editable on top, source mask
    // untouched. The layer editors' Cmd-click on the thumbnail.
    const { DOC_SEL_ID, selectionLoadSource } = await import("../state");
    let s = run(initialState(), { type: "add_layer", maskType: "brush" });
    const maskId = s.activeLayer!.replace("_adj", "_mask");
    expect(selectionLoadSource(s)?.id).toBe(maskId);
    const before = s;
    s = run(s, { type: "load_selection_from_mask", maskId, version: "00000000000000aa" });
    const doc = s.nodes.find((n) => n.id === DOC_SEL_ID)!;
    expect(doc.textParams?.matte_id).toBe("baked:00000000000000aa");
    expect(doc.regions).toEqual([]);
    // The source mask is untouched, the selection is in hand.
    expect(s.nodes.find((n) => n.id === maskId)!.type).toBe("heeler.brush_mask");
    expect(s.selection).toEqual([DOC_SEL_ID]);
    expect(s.tool).toBe("select");
    // A loaded selection has substance: Remove Object accepts it.
    const { removeObjectSource } = await import("../commands");
    expect(removeObjectSource(s)?.id).toBe(DOC_SEL_ID);
    // ONE undo takes exactly this step back.
    const undone = run(s, { type: "undo" });
    expect(undone.nodes.find((n) => n.id === DOC_SEL_ID)?.textParams?.matte_id).toBe(
      before.nodes.find((n) => n.id === DOC_SEL_ID)?.textParams?.matte_id,
    );
    // Loading the document selection into itself refuses.
    expect(run(s, { type: "load_selection_from_mask", maskId: DOC_SEL_ID, version: "bb" })).toBe(s);
  });

  it("putting the mask tools down sheds an Edit-layer-mask pick", () => {
    // The polish pick-leak's Finish cousin: "Edit layer mask" picks
    // the art mask and arms a tool; ending the flow must unpick, or
    // the art mask outranks the active layer in activeSelectionMask
    // for the rest of the session.
    let s = run(initialState(), { type: "art_add_layer", kind: "paint" });
    const blendId = s.artActive!;
    s = run(s, { type: "art_add_mask", id: blendId, kind: "brush" });
    const maskId = `art_m_${blendId}`;
    s = run(s, { type: "select_nodes", ids: [maskId] }, { type: "set_tool", tool: "select" });
    expect(s.selection).toContain(maskId);
    // Switching between mask tools keeps the flow alive...
    s = run(s, { type: "set_tool", tool: "brush" });
    expect(s.selection).toContain(maskId);
    // ...and leaving them ends it, pick and all.
    s = run(s, { type: "set_tool", tool: "crop" });
    expect(s.selection).not.toContain(maskId);
  });

  it("deleting a Finish layer takes removals sourced from its mask", () => {
    // The owner made this shape live: pick a Finish layer's mask, Remove
    // in Adjustments, and the splice's source is the ART mask. Deleting
    // that layer must take the removal along and heal the chain, the
    // rule develop layers already follow. Two removals from one mask sit
    // adjacent, so the heal has to walk through both.
    let s = run(
      initialState(),
      { type: "art_add_layer", kind: "paint" },
    );
    const blendId = s.artActive!;
    s = run(s, { type: "art_add_mask", id: blendId, kind: "brush" });
    const maskId = `art_m_${blendId}`;
    s = run(s, { type: "add_stroke", id: maskId, stroke: { points: [[0.3, 0.3]], radius: 0.1, hardness: 1, flow: 1 } });
    s = run(s, { type: "add_inpaint_for", maskId });
    s = run(s, {
      type: "set_params",
      id: `inpaint_${maskId}`,
      values: {},
      text: { fill_id: "f1", model: "lama" },
    });
    s = run(s, { type: "add_inpaint_for", maskId });
    expect(s.nodes.some((n) => n.id === `inpaint_${maskId}_2`)).toBe(true);
    const cut = run(s, { type: "art_remove_layer", id: blendId });
    for (const id of [
      `inpaint_${maskId}`, `inpaint_m_${maskId}`,
      `inpaint_${maskId}_2`, `inpaint_m_${maskId}_2`,
    ]) {
      expect(cut.nodes.some((n) => n.id === id)).toBe(false);
    }
    // The chain healed: output still eats a live image feed.
    const feed = cut.wires.find((w) => w.to === "output" && w.kind === "image");
    expect(feed).toBeTruthy();
    expect(cut.nodes.some((n) => n.id === feed!.from)).toBe(true);
  });

  it("one selection, many removals: a finished fill never blocks the next", () => {
    // The owner, second object, same document selection node: "I have
    // a selection made... Nothing happens." The removal was keyed to
    // the mask's id, so the first Remove locked the door for good.
    const { s: s0, maskId } = withSelected();
    let s = run(s0, { type: "add_inpaint_for", maskId });
    // Still computing: a second ask is a double click, refused.
    expect(run(s, { type: "add_inpaint_for", maskId })).toBe(s);
    // The fill lands; the same mask sources a fresh removal, suffixed.
    s = run(s, {
      type: "set_params",
      id: `inpaint_${maskId}`,
      values: {},
      text: { fill_id: "f1", model: "lama" },
    });
    s = run(s, { type: "add_inpaint_for", maskId });
    const second = s.nodes.find((n) => n.id === `inpaint_${maskId}_2`);
    expect(second).toBeTruthy();
    // The suffixed removal spells its source in params, not its id,
    // and owns its own snapshot hole.
    expect(second!.textParams?.source).toBe(maskId);
    expect(s.nodes.some((n) => n.id === `inpaint_m_${maskId}_2`)).toBe(true);
  });

  it("every removal wears a row: an eye to compare, a delete that heals", async () => {
    // "The effect of the remove persisted after I deleted the
    // layer. Even after I created and deleted a new Cutout layer." A
    // document-selection removal belongs to no layer, so it needs its own
    // seat and its own delete.
    const { LayersSection } = await import("../ui/simple");
    const { s: s0, maskId } = withSelected();
    const s = run(s0, { type: "add_inpaint_for", maskId });
    const inId = `inpaint_${maskId}`;
    const got: Command[] = [];
    const { unmount } = render(<LayersSection state={s} dispatch={(c: Command) => got.push(c)} />);
    expect(screen.getByTestId(`removal-row-${inId}`)).toBeTruthy();
    fireEvent.click(screen.getByTestId(`removal-eye-${inId}`));
    expect(got).toContainEqual({ type: "set_enabled", id: inId, enabled: false });
    fireEvent.click(screen.getByTestId(`removal-delete-${inId}`));
    expect(got).toContainEqual({ type: "remove_inpaint", id: inId });
    unmount();
    // The reducer unsplices both nodes and heals the chain: the
    // output eats from whatever fed the inpaint, and undo restores
    // the removal whole.
    const cut = run(s, { type: "remove_inpaint", id: inId });
    expect(cut.nodes.some((n) => n.id === inId)).toBe(false);
    expect(cut.nodes.some((n) => n.id === `inpaint_m_${maskId}`)).toBe(false);
    const feed = cut.wires.find((w) => w.to === "output" && w.kind === "image");
    expect(feed).toBeTruthy();
    expect(feed!.from).not.toBe(inId);
    const back = run(cut, { type: "undo" });
    expect(back.nodes.some((n) => n.id === inId)).toBe(true);
  });

  it("the drawn-selection panel carries no Remove chip", async () => {
    // The chip earned a seat once, then lost it to its own name: beside a
    // list of regions, "Remove" read as "remove the selection". The
    // report: "We already have that as a menu items and it's a but
    // confusing because I thought it mean 'remove selection'." Select >
    // Remove Object stays the one door.
    const { SelectionControls } = await import("../ui/simple");
    let s = run(initialState(), { type: "add_layer", maskType: "selection" });
    const maskId = s.activeLayer!.replace("_adj", "_mask");
    s = run(s, {
      type: "add_region",
      id: maskId,
      region: { kind: "marquee", op: "replace", shape: "rect", x0: 0.2, y0: 0.2, x1: 0.8, y1: 0.8 },
    });
    const node = s.nodes.find((n) => n.id === maskId)!;
    const { unmount } = render(
      <SelectionControls state={s} dispatch={() => {}} node={node} />,
    );
    expect(screen.queryByTestId("selection-remove")).not.toBeInTheDocument();
    // The mode group hugs its four buttons rather than stretching its
    // border across the panel. "The intersect button
    // extends to the right edge of the panel."
    expect(
      (screen.getByRole("group", { name: "Selection mode" }) as HTMLElement).style.width,
    ).toBe("fit-content");
    unmount();
  });

  it("the runner bakes the hole first, then fills against it", async () => {
    const { s: s0, maskId } = withSelected();
    let cur = run(s0, { type: "add_inpaint_for", maskId });
    const dispatch = (c: Command) => {
      cur = reduce(cur, c);
      rerender(<RemoveRunner state={cur} dispatch={dispatch} />);
    };
    const { rerender } = render(<RemoveRunner state={cur} dispatch={dispatch} />);
    const holeId = `inpaint_m_${maskId}`;
    // Phase one: the hole's baked pointer lands (browser bridge mocks
    // the bake).
    await waitFor(() =>
      expect(cur.nodes.find((n) => n.id === holeId)!.textParams?.matte_id).toBe(
        "baked:beefbeefbeefbeef",
      ),
    );
    // Phase two: the fill lands on the inpaint node.
    await waitFor(() => {
      const node = cur.nodes.find((n) => n.id === `inpaint_${maskId}`);
      expect(node?.textParams?.fill_id).toBe("fill123");
    });
  });

  it("Remove sits in the panel again, and the menu door still works", async () => {
    // The chip left when its purpose was opaque and returned by the
    // owner's ruling once it explained itself: "If I had better
    // understood that from the beginning I would have said to leave that
    // Remove button."
    const { s, maskId } = withSelected();
    const got: Command[] = [];
    render(<SmartModePanel state={s} dispatch={(c) => got.push(c)} />);
    fireEvent.click(screen.getByTestId("smart-remove"));
    expect(got).toContainEqual({ type: "add_inpaint_for", maskId });
    const { runCommand } = await import("../commands");
    const viaMenu: Command[] = [];
    expect(runCommand("select.remove_object", s, (c) => viaMenu.push(c))).toBe(true);
    expect(viaMenu).toContainEqual({ type: "add_inpaint_for", maskId });
    // No selection computed: both doors refuse rather than splicing a
    // hole that selects nothing.
    const fresh = run(initialState(), { type: "add_layer", maskType: "smart" });
    expect(runCommand("select.remove_object", fresh, () => {})).toBe(false);
  });

  it("Remove Object splices, the runner fills, and the fill is recorded", async () => {
    const { s: s0, maskId } = withSelected();
    const { runCommand } = await import("../commands");
    let cur = s0;
    const dispatch = (c: Command) => {
      cur = reduce(cur, c);
      rerender(<RemoveRunner state={cur} dispatch={dispatch} />);
    };
    const { rerender } = render(<RemoveRunner state={cur} dispatch={dispatch} />);
    runCommand("select.remove_object", cur, dispatch);
    const nodeId = `inpaint_${maskId}`;
    await waitFor(() => {
      const node = cur.nodes.find((n) => n.id === nodeId);
      expect(node?.textParams?.fill_id).toBe("fill123");
      expect(node?.textParams?.model).toBe("lama");
    });
    const { inpaintFill } = await import("../bridge");
    // The graph the backend saw CONTAINED the spliced node.
    const stateArg = vi.mocked(inpaintFill).mock.calls[0][0] as State;
    expect(stateArg.nodes.some((n) => n.id === nodeId)).toBe(true);
  });

  it("without the fill model, the runner shows consent instead of failing", async () => {
    mockFill = false;
    const { inpaintFill } = await import("../bridge");
    // Persistent, not Once: the runner retries after a model error,
    // and a one-shot rejection would let the retry "succeed" and
    // dismiss the consent card mid-assertion.
    vi.mocked(inpaintFill).mockRejectedValue(new Error("model not installed"));
    try {
      const { s: s0, maskId } = withSelected();
      let s = run(s0, { type: "add_inpaint_for", maskId });
      // The hole already baked: the runner goes straight to the fill.
      s = run(s, {
        type: "set_text_param",
        id: `inpaint_m_${maskId}`,
        param: "matte_id",
        value: "baked:00000000000000ff",
      });
      render(<RemoveRunner state={s} dispatch={() => {}} />);
      const consent = await screen.findByTestId("smart-fill-consent");
      expect(consent.textContent).toContain("LaMa");
      expect(consent.textContent).toContain("208 MB");
      const { smartModelDownload } = await import("../bridge");
      fireEvent.click(screen.getByTestId("smart-fill-download"));
      expect(vi.mocked(smartModelDownload)).toHaveBeenCalledWith("lama");
    } finally {
      vi.mocked(inpaintFill).mockImplementation(async () => "fill123");
    }
  });
});

describe("a deleted layer takes its Remove with it", () => {
  it("remove_layer cascades the dependent Inpaint and heals both gaps", () => {
    let s = run(initialState(), { type: "add_layer", maskType: "smart" });
    const adjId = s.activeLayer!;
    const maskId = adjId.replace("_adj", "_mask");
    s = run(s, { type: "add_inpaint_for", maskId });
    const output = s.nodes.find((n) => n.type === "heeler.output")!;
    const inpaintId = `inpaint_${maskId}`;
    const feed = s.wires.find((w) => w.to === inpaintId && w.toPort === "in")!.from;

    const before = s;
    s = run(s, { type: "remove_layer", id: adjId });
    // The layer AND the Remove are gone; nothing dangles.
    expect(s.nodes.some((n) => n.id === inpaintId)).toBe(false);
    expect(s.nodes.some((n) => n.id === maskId)).toBe(false);
    expect(s.wires.some((w) => w.to === inpaintId || w.from === inpaintId)).toBe(false);
    // The chain healed around the Remove's splice: what fed it now
    // feeds the output.
    expect(s.wires.some((w) => w.from === feed && w.to === output.id)).toBe(true);
    // And undo restores the whole arrangement in one step.
    const back = run(s, { type: "undo" });
    expect(back.nodes.some((n) => n.id === inpaintId)).toBe(true);
    expect(back.wires.length).toBe(before.wires.length);
  });
});

describe("To Mask: a Smart mask becomes a pixel mask", () => {
  it("converts in place, the brush's mask wearing the baked render", async () => {
    // 2026-09-30: "I expect when I clicked To Mask that it made a regular
    // black and white mask"; "drop the live mask, make To Mask a pixel
    // mask". The conversion is in place, undoable whole; a Develop Smart
    // layer becomes a Brush layer.
    let s = run(initialState(), { type: "add_layer", maskType: "smart" });
    const maskId = s.activeLayer!.replace("_adj", "_mask");
    s = run(s, {
      type: "set_params",
      id: maskId,
      values: {},
      text: { mode: "sky", prompts: "[]", model: "mobile_sam" },
    });
    const before = s;
    s = run(s, { type: "convert_mask_to_pixels", maskId, version: "00000000000000ff" });
    const mask = s.nodes.find((n) => n.id === maskId)!;
    expect(mask.type).toBe("heeler.brush_mask");
    expect(mask.textParams?.matte_id).toBe("baked:00000000000000ff");
    expect(mask.strokes).toEqual([]);
    // A Develop brush reveals where painted: the base is laid in as it is.
    expect(mask.params.invert).toBe(0);
    expect(mask.params.base_invert).toBe(0);
    // The brush in hand, pointed at the mask it now is.
    expect(s.tool).toBe("brush");
    expect(s.selection).toContain(maskId);
    // One undo puts the smart mask back whole.
    const undone = run(s, { type: "undo" });
    expect(undone.nodes.find((n) => n.id === maskId)!.type).toBe("heeler.smart_mask");
    // A pixel mask is already one; the command refuses.
    expect(run(s, { type: "convert_mask_to_pixels", maskId, version: "00" })).toBe(s);

    // The chip drives the flow: bake (mocked by the browser bridge),
    // then the conversion lands with the baked version.
    const got: Command[] = [];
    render(<SmartModePanel state={before} dispatch={(c) => got.push(c)} />);
    const chip = screen.getByTestId("smart-to-mask") as HTMLButtonElement;
    expect(chip.disabled).toBe(false);
    fireEvent.click(chip);
    await waitFor(() =>
      expect(got).toContainEqual({
        type: "convert_mask_to_pixels",
        maskId,
        version: "beefbeefbeefbeef",
      }),
    );
  });

  it("a Finish art mask converts too, keeping Add layer mask's polarity", () => {
    // Art masks carry hasOut where develop masks carry maskOut; the type
    // decides. A Finish mask is inverted (painting hides) with the base
    // laid in as its complement, so it still shows the selection.
    let s = run(initialState(), { type: "art_add_layer", kind: "paint" });
    s = run(s, { type: "art_add_mask", id: s.artActive!, kind: "smart" });
    const maskId = `art_m_${s.artActive}`;
    s = run(s, {
      type: "set_params",
      id: maskId,
      values: {},
      text: { mode: "sky", prompts: "[]", model: "mobile_sam" },
    });
    s = run(s, { type: "convert_mask_to_pixels", maskId, version: "1b" });
    const mask = artMaskNode(s, maskId)!;
    expect(mask.type).toBe("heeler.brush_mask");
    expect(mask.textParams?.matte_id).toBe("baked:1b");
    expect(mask.params.invert).toBe(1);
    expect(mask.params.base_invert).toBe(1);
    // The Polish door is the Develop panel's: a Finish mask never becomes
    // a live selection.
    expect(run(s, { type: "convert_mask_to_selection", maskId, version: "2c" })).toBe(s);
  });

  it("a brush mask converts the same way, from the develop panel", () => {
    let s = run(initialState(), { type: "add_layer", maskType: "brush" });
    const maskId = s.activeLayer!.replace("_adj", "_mask");
    s = run(s, { type: "convert_mask_to_selection", maskId, version: "0a" });
    const mask = s.nodes.find((n) => n.id === maskId)!;
    expect(mask.type).toBe("heeler.selection_mask");
    expect(mask.textParams?.matte_id).toBe("baked:0a");
    expect(mask.strokes).toEqual([]);
  });
});

describe("mask brush ergonomics", () => {
  it("X swaps the brush polarity while a brush is up, and only then", async () => {
    // "I think the X hotkey was used to switch back and forth
    // between Black and White brush." Sticky, layer-editor style; ALT still
    // inverts momentarily relative to it.
    const { runCommand } = await import("../commands");
    let s = run(initialState(), { type: "set_tool", tool: "brush" });
    expect(s.brushSwap).toBe(false);
    const got: Command[] = [];
    expect(runCommand("brush.swap", s, (c) => got.push(c))).toBe(true);
    s = got.reduce(reduce, s);
    expect(s.brushSwap).toBe(true);
    // No brush up: the key falls through (to Reject, which owns X).
    const idle = run(initialState(), { type: "set_tool", tool: "none" });
    expect(runCommand("brush.swap", idle, () => {})).toBe(false);
  });

  it("deleting a mask puts the mask brush down; the paint tool stays", () => {
    // "deleting a mask should hide the brush
    // settings if the paint brush is not the actively selected
    // tool."
    let s = run(initialState(), { type: "art_add_layer", kind: "paint" });
    const layerId = s.artActive!;
    s = run(s, { type: "art_add_mask", id: layerId });
    s = run(s, { type: "select_nodes", ids: [`art_m_${layerId}`] });
    s = run(s, { type: "set_tool", tool: "brush" });
    s = run(s, { type: "art_remove_mask", id: layerId });
    expect(s.tool).toBe("none");
    // Painting the LAYER is unaffected: the layer is still there. With
    // the Finish pane up, where the paint tool lives.
    let p = run(initialState(), { type: "set_panel_tab", tab: "layers" }, { type: "art_add_layer", kind: "paint" });
    p = run(p, { type: "art_add_mask", id: p.artActive! });
    p = run(p, { type: "set_tool", tool: "paint" });
    p = run(p, { type: "art_remove_mask", id: p.artActive! });
    expect(p.tool).toBe("paint");
  });
});

describe("the Layers panel mask eye", () => {
  it("points the preview at the active Finish layer's mask", async () => {
    // On the smart sky: "missing a way for me to preview the mask with
    // an overlay or alpha mask." The develop panel had the eye; the
    // Layers panel had masks but nothing to point it at.
    const { maskPreviewNode } = await import("../state");
    let s = run(initialState(), { type: "set_panel_tab", tab: "layers" });
    s = run(s, { type: "art_add_layer", kind: "paint" });
    s = run(s, { type: "art_add_mask", id: s.artActive!, kind: "smart" });
    expect(maskPreviewNode(s)).toBeNull();
    s = run(s, { type: "toggle_mask_view" });
    expect(maskPreviewNode(s)).toBe(`art_m_${s.artActive}`);
    // Off the Layers tab the develop rules stand unchanged.
    const dev = run(s, { type: "set_panel_tab", tab: "adjust" });
    expect(maskPreviewNode(dev)).not.toBe(`art_m_${s.artActive}`);
  });
});

describe("the app-wide mask flavor", () => {
  it("every mask preview honors it - layer view and Color Sets alike - and probes never do", async () => {
    const { maskOverlayWanted } = await import("../state");
    let s = run(initialState(), { type: "add_layer", maskType: "radial" });
    s = { ...s, maskRed: true, maskView: true };
    expect(maskOverlayWanted(s)).toBe(true);
    // On second look: the Color Sets eye SHOULD follow the current flavor
    // ("the alpha mask or overlay that is shown with eyedropper is based
    // on the current set masking type").
    const cset = run(s, { type: "add_color_set" });
    expect(cset.nodes.some((n) => n.id === "cset1_mask")).toBe(true);
    const withEye = { ...cset, maskRed: true, maskView: false, csetMaskView: 1 };
    expect(maskOverlayWanted(withEye)).toBe(true);
    expect(maskOverlayWanted({ ...withEye, maskRed: false })).toBe(false);
    // The armed dropper alone shows nothing since the owner's
    // overrule: "It should not default to mask on, only when the mask
    // button is toggled on while using the picker."
    expect(maskOverlayWanted({ ...cset, maskRed: true, maskView: false, csetDropper: 1 })).toBe(false);
    // A probe outranks everything and stays untinted.
    expect(maskOverlayWanted({ ...s, probeNode: "exposure" })).toBe(false);
    // No mask view showing at all: flavor alone tints nothing.
    expect(maskOverlayWanted({ ...initialState(), maskRed: true })).toBe(false);
    // And the flip is a pure flip: view state untouched.
    const flipped = run(s, { type: "toggle_mask_flavor" });
    expect(flipped.maskRed).toBe(false);
    expect(flipped.maskView).toBe(true);
  });
});

describe("smart selections, not layers (Select > Smart Selection)", () => {
  // "I think we are missing smart selections in 'Select >
  // Selection Tools'... These don't create layers or anything, they
  // just create selections only."
  const armed = (...extra: Command[]) =>
    run(
      initialState(),
      { type: "set_select_method", method: "smart" },
      { type: "arm_document_selection" },
      ...extra,
    );

  it("a subject pick computes once and lands as the selection's baked base", async () => {
    const s = armed({ type: "set_text_param", id: "sel_doc", param: "mode", value: "subject" });
    const got: Command[] = [];
    render(
      <SmartSelectOverlay state={s} dispatch={(c: Command) => got.push(c)} norm={() => [0.5, 0.5]} />,
    );
    await waitFor(() => {
      expect(got).toContainEqual({
        type: "set_text_param",
        id: "sel_doc",
        param: "matte_id",
        value: "baked:cafecafecafecafe",
      });
    });
    const { smartSelect } = await import("../bridge");
    // Aimed at the frame's middle: the photograph's own, uncropped.
    expect(vi.mocked(smartSelect)).toHaveBeenCalledWith(s.activeImage, "sel_doc", "subject", "[]", JSON.stringify({ x: 0.5, y: 0.5 }));
    // A selection only: applying every dispatch grows no layer and no
    // smart mask node.
    const after = got.reduce(reduce, s);
    expect(after.nodes.filter((n) => n.type === "heeler.smart_mask")).toHaveLength(0);
    expect(after.nodes).toHaveLength(s.nodes.length);
  });

  it("picking the same one-shot again recomputes, instead of just dropping the base", async () => {
    // Regression coverage for the latch swallowing a re-pick.
    // The menu clears the base on every pick; without the ask
    // counter the state after a re-pick was byte-identical to the
    // state after a failed compute, so the latch blocked the recompute
    // and the pick had only destroyed the selection it meant to redo.
    // The ask lives in UI state, never the undo stack, so rewinding
    // the bake at any depth is not answered by a compute.
    const { smartSelect } = await import("../bridge");
    vi.mocked(smartSelect).mockClear();
    const s = armed({ type: "set_text_param", id: "sel_doc", param: "mode", value: "subject" });
    const got: Command[] = [];
    const dispatch = (c: Command) => got.push(c);
    const { rerender } = render(<SmartSelectOverlay state={s} dispatch={dispatch} norm={() => [0.5, 0.5]} />);
    await waitFor(() => expect(vi.mocked(smartSelect)).toHaveBeenCalledTimes(1));
    // The bake lands.
    const baked = got.reduce(reduce, s);
    // An undone bake is NOT a fresh ask: the counter is unchanged, so
    // undo is not answered by an immediate recompute over itself.
    const undone = run(
      baked,
      { type: "set_text_param", id: "sel_doc", param: "matte_id", value: "" },
    );
    rerender(<SmartSelectOverlay state={undone} dispatch={dispatch} norm={() => [0.5, 0.5]} />);
    await new Promise((r) => setTimeout(r, 50));
    expect(vi.mocked(smartSelect)).toHaveBeenCalledTimes(1);
    // The menu's second pick: base cleared and the ask counted,
    // exactly as menu-select-smart-subject dispatches them.
    const repicked = run(
      baked,
      { type: "set_text_param", id: "sel_doc", param: "matte_id", value: "" },
      { type: "smart_select_ask" },
    );
    rerender(<SmartSelectOverlay state={repicked} dispatch={dispatch} norm={() => [0.5, 0.5]} />);
    await waitFor(() => expect(vi.mocked(smartSelect)).toHaveBeenCalledTimes(2));
  });

  it("clicks write prompts on the selection and rebake it", async () => {
    const s = armed();
    const got: Command[] = [];
    render(
      <SmartSelectOverlay state={s} dispatch={(c: Command) => got.push(c)} norm={() => [0.25, 0.75]} />,
    );
    // The overlay waits for the model status before taking clicks.
    await waitFor(() =>
      expect(screen.getByTestId("smart-select-overlay")).toBeInTheDocument(),
    );
    fireEvent.mouseDown(screen.getByTestId("smart-select-overlay"), { button: 0 });
    expect(got).toContainEqual({
      type: "set_text_param",
      id: "sel_doc",
      param: "prompts",
      value: JSON.stringify([{ x: 0.25, y: 0.75, positive: true }]),
    });
    await waitFor(() =>
      expect(
        got.some((c) => c.type === "set_text_param" && c.param === "matte_id"),
      ).toBe(true),
    );
  });

  it("Deselect drops the baked base and the smart recipe with it", () => {
    let s = armed(
      { type: "set_text_param", id: "sel_doc", param: "mode", value: "subject" },
      { type: "set_text_param", id: "sel_doc", param: "matte_id", value: "baked:cafecafecafecafe" },
      { type: "set_text_param", id: "sel_doc", param: "prompts", value: '[{"x":0.1,"y":0.1,"positive":true}]' },
    );
    // A baked base does not derive from the geometry, so left behind
    // it kept the selection alive through its own Deselect.
    s = run(s, { type: "clear_regions", id: "sel_doc" });
    const n = s.nodes.find((nd) => nd.id === "sel_doc")!;
    expect(n.textParams?.matte_id).toBe("");
    expect(n.textParams?.prompts).toBe("");
    expect(n.textParams?.mode).toBe("");
  });

  it("the consent card guards this door too, and nothing computes past it", async () => {
    mockInstalled = false;
    const { smartSelect } = await import("../bridge");
    vi.mocked(smartSelect).mockClear();
    const s = armed({ type: "set_text_param", id: "sel_doc", param: "mode", value: "sky" });
    render(<SmartSelectOverlay state={s} dispatch={() => {}} norm={() => [0, 0]} />);
    await screen.findByTestId("smart-consent");
    expect(vi.mocked(smartSelect)).not.toHaveBeenCalled();
  });
});

describe("the smart base in the Selection list", () => {
  // "What I would expect to see after using any of these 3
  // is marching ants and a selection region added to the Selection
  // list at the bottom of the right view." The ants ride the viewer;
  // the list gets this row.
  const withBase = (mode: string, prompts = "[]") => {
    let s = run(
      initialState(),
      { type: "set_select_method", method: "smart" },
      { type: "arm_document_selection" },
      { type: "set_text_param", id: "sel_doc", param: "mode", value: mode },
      { type: "set_text_param", id: "sel_doc", param: "prompts", value: prompts },
      { type: "set_text_param", id: "sel_doc", param: "matte_id", value: "baked:cafecafecafecafe" },
    );
    return { s, node: s.nodes.find((n) => n.id === "sel_doc")! };
  };

  it("shows a row naming the mode, and hides the draw-first hint", async () => {
    const { SelectionControls } = await import("../ui/simple");
    const { s, node } = withBase("subject");
    render(<SelectionControls state={s} dispatch={() => {}} node={node} />);
    expect(screen.getByTestId("region-smart-base").textContent).toContain("Smart · Subject");
    expect(screen.queryByText(/Draw in the viewer/)).not.toBeInTheDocument();
  });

  it("counts clicks for the click flavor", async () => {
    const { SelectionControls } = await import("../ui/simple");
    const { s, node } = withBase(
      "click",
      JSON.stringify([
        { x: 0.2, y: 0.2, positive: true },
        { x: 0.6, y: 0.6, positive: false },
      ]),
    );
    render(<SelectionControls state={s} dispatch={() => {}} node={node} />);
    expect(screen.getByTestId("region-smart-base").textContent).toContain("Smart · 2 clicks");
  });

  it("its ✕ drops the base and the recipe in one undoable step", async () => {
    const { SelectionControls } = await import("../ui/simple");
    const { s, node } = withBase("sky");
    const got: Command[] = [];
    render(<SelectionControls state={s} dispatch={(c: Command) => got.push(c)} node={node} />);
    fireEvent.click(screen.getByTestId("region-smart-delete"));
    expect(got).toContainEqual({
      type: "set_params",
      id: "sel_doc",
      values: {},
      text: { matte_id: "", prompts: "", mode: "" },
    });
  });
});


it("the selection door can reopen after undo, photo and take switches, and layout restore", () => {
  let s = run(initialState(), { type: "add_layer", maskType: "selection" });
  const id = s.activeLayer!.replace("_adj", "_mask");
  s = run(s, { type: "set_param", id, param: "feather", value: 0.2 }, { type: "close_selection_split" });
  const undone = run(s, { type: "undo" });
  expect(run(undone, { type: "arm_document_selection" }).selectionSplitClosed).toBe(false);
  const restored = run(s, { type: "restore_layout", layout: { selectionSplitMin: false } });
  expect(run(restored, { type: "set_tool", tool: "select" }).selectionSplitClosed).toBe(false);
  const other = s.images.find((i) => i.id !== s.activeImage)!;
  expect(other).toBeDefined();
  const switched = run(s, { type: "select_image", id: other.id });
  expect(switched.activeImage).toBe(other.id);
  expect(run(switched, { type: "arm_document_selection" }).selectionSplitClosed).toBe(false);
  let taken = run(s, { type: "new_take", name: "Review door" });
  const oldTake = taken.takes[s.activeImage].find((t) => t.id !== taken.activeTakes[s.activeImage])!.id;
  taken = run(taken, { type: "switch_take", takeId: oldTake });
  expect(taken.activeTakes[s.activeImage]).toBe(oldTake);
  expect(run(taken, { type: "arm_document_selection" }).selectionSplitClosed).toBe(false);
});
