// The lens correction a DNG carries for itself (WarpRectilinear): read
// by the desktop, shown in the Lens section as the profile, on by
// default for a photograph opened with no saved edits, and taken by a
// pick exactly where the engine takes it.
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { initialState } from "../data";
import { reduce } from "../state";
import { DNG_WARP, lensPresetValues } from "../lenspresets";
import { lensSourceOf } from "../pickgeometry";

const WARP = JSON.stringify({ cx: 0.5, cy: 0.5, planes: [[1.25, 0, 0, 0, 0, 0]] });

vi.mock("../bridge", async (original) => ({
  ...(await original<typeof import("../bridge")>()),
  lensProfileFor: vi.fn(async () => ({
    name: "",
    maker: "",
    matched: false,
    calibrated: false,
    model: null,
    a: 0,
    b: 0,
    c: 0,
    scale: 1,
    focal: null,
    tca: null,
    vig: null,
    file_warp: WARP,
  })),
}));

describe("a file's own lens correction", () => {
  it("is taken by a pick where the engine takes it", () => {
    // ops_lens.rs a_dng_warp_takes_each_pixel_from_where_its_polynomial_says:
    // on an 81 by 61 frame, pixel (64, 46) shows the light from (70, 50).
    const map = lensSourceOf({ dng_warp: WARP }, 81, 61)!;
    const [u, v] = map([(64 + 0.5) / 81, (46 + 0.5) / 61]);
    expect(u * 81 - 0.5).toBeCloseTo(70, 5);
    expect(v * 61 - 0.5).toBeCloseTo(50, 5);
    // An identity, a blank and a broken one bend nothing.
    expect(lensSourceOf({ dng_warp: JSON.stringify({ cx: 0.5, cy: 0.5, planes: [[1, 0, 0, 0, 0, 0]] }) }, 81, 61)!([0.3, 0.3])[0]).toBeCloseTo(0.3, 6);
    expect(lensSourceOf({ dng_warp: "" }, 81, 61)).toBeNull();
    expect(lensSourceOf({ dng_warp: "{" }, 81, 61)).toBeNull();
  });

  it("builds the Lens section with it in one undo step, only for the photo on screen and only once", () => {
    // A photograph with no saved edits: the template, which builds the
    // Lens section only on demand.
    const sample = initialState();
    const s = { ...sample, nodes: structuredClone(sample.defaultGraph.nodes), wires: structuredClone(sample.defaultGraph.wires) };
    expect(s.nodes.some((n) => n.type === "heeler.lens_correct")).toBe(false);
    const on = reduce(s, { type: "apply_file_lens_warp", imageId: s.activeImage, warp: WARP });
    const lens = on.nodes.find((n) => n.type === "heeler.lens_correct")!;
    expect(lens.textParams?.[DNG_WARP]).toBe(WARP);
    expect(lens.textParams?.dist_model).toBe("none");
    expect(lens.params.distortion).toBe(0);
    expect(on.undoStack.length).toBe(s.undoStack.length + 1);
    const undone = reduce(on, { type: "undo" });
    expect(undone.nodes.find((n) => n.type === "heeler.lens_correct")?.textParams?.[DNG_WARP] ?? "").toBe("");
    // Another photo by the time the file was read: nothing happens.
    expect(reduce(s, { type: "apply_file_lens_warp", imageId: "someone-else", warp: WARP })).toBe(s);
    // A Lens Correction node already there (the user got to it first).
    expect(reduce(on, { type: "apply_file_lens_warp", imageId: s.activeImage, warp: "{}" })).toBe(on);
  });

  it("gives way to a lens preset, which is the whole lens state", () => {
    const applied = lensPresetValues({ id: "p", name: "Mine", params: { distortion: 10 }, text: {} });
    expect(applied.text[DNG_WARP]).toBe("");
  });

  it("is named as the profile, ahead of the database, and Apply writes it", async () => {
    const { App } = await import("../app");
    render(<App />);
    // The sample photograph has a Lens Correction node of its own, so
    // nothing went on by itself: the file's correction is named and
    // offered. (On by default is the no-saved-edits path in
    // graphpersistence.tsx, which needs the desktop; its command is the
    // reducer test above.)
    expect(await screen.findByText("Profile: from the file")).toBeTruthy();
    const apply = screen.getByTestId("lens-profile-apply");
    expect(apply).toHaveTextContent(/^APPLY$/);
    fireEvent.click(apply);
    expect(screen.getByTestId("lens-profile-apply")).toHaveTextContent("REAPPLY");
  });
});
