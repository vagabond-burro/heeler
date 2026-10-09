// Cancel stitch, as a stack has Cancel merge (2026-10-08: "pano
// stitching is missing a cancel button like stacking has"). The card's
// Cancel names the stitch's job; a canceled stitch says so and offers
// Stitch again, as does the Pano panel, and the panorama is not asked for
// again until then. The desktop's half (stopping between units, the
// canceled mark held per recipe, a cancel never remembered as a failure)
// is in lib.rs and heeler-stitch's pipeline tests.
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { initialState } from "../data";
import { reduce, type Command, type State } from "../state";
import { mockCancels, mockResetOps, mockResumes, type PanoInfo } from "../bridge";

const info: PanoInfo = { surface: "cylindrical", gain_compensation: true, straighten: true, bands: 4, members: ["l.jpg", "r.jpg"], missing: [] };
vi.mock("../bridge", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../bridge")>();
  return { ...actual, panoInfo: vi.fn(async () => info) };
});

import { StitchDialog } from "../ui/stitching";
import { PanoPanel } from "../ui/simple";

afterEach(() => mockResetOps());

const running = (p: Partial<NonNullable<State["stitch"]>> = {}): NonNullable<State["stitch"]> => ({
  image: "pan", fraction: 0.4, stage: "Matching frames 1 and 2", error: null, frames: 2, jobId: "stitch-12", ...p,
});

describe("Cancel stitch", () => {
  it("the running card's Cancel names the stitch's job", () => {
    render(<StitchDialog state={reduce(initialState(), { type: "set_stitch_progress", progress: running() })} dispatch={() => {}} />);
    fireEvent.click(screen.getByTestId("stitch-cancel"));
    expect(screen.getByTestId("stitch-cancel")).toHaveTextContent("Cancel stitch");
    expect(mockCancels).toEqual(["stitch-12"]);
  });

  it("an older backend's stitch, with no job, has no Cancel to offer", () => {
    render(<StitchDialog state={reduce(initialState(), { type: "set_stitch_progress", progress: running({ jobId: undefined }) })} dispatch={() => {}} />);
    expect(screen.queryByTestId("stitch-cancel")).toBeNull();
  });

  it("a canceled stitch says so, and Stitch again lifts the mark first, then asks for it", async () => {
    const sent: Command[] = [];
    let s = reduce(initialState(), { type: "set_stitch_canceled", image: "pan", on: true });
    s = reduce(s, { type: "set_stitch_progress", progress: { image: "pan", fraction: 0.4, stage: "Canceled", error: null, canceled: true } });
    render(<StitchDialog state={s} dispatch={(c) => sent.push(c)} />);
    expect(screen.getByTestId("stitch-title")).toHaveTextContent("Stitch canceled");
    expect(screen.queryByTestId("stitch-bar")).toBeNull();
    fireEvent.click(screen.getByTestId("stitch-again"));
    expect(mockResumes).toEqual(["pan"]);
    await waitFor(() => expect(sent).toEqual([{ type: "resume_pano_stitch", image: "pan" }]));
  });

  it("Close puts the canceled card away and leaves the panorama canceled", () => {
    const sent: Command[] = [];
    const s = reduce(initialState(), { type: "set_stitch_progress", progress: { image: "pan", fraction: 0.4, stage: "Canceled", error: null, canceled: true } });
    render(<StitchDialog state={s} dispatch={(c) => sent.push(c)} />);
    fireEvent.click(screen.getByTestId("stitch-close"));
    expect(sent).toEqual([{ type: "set_stitch_progress", progress: null }]);
  });
});

describe("the canceled mark in state", () => {
  it("is set and lifted per panorama; Stitch again renders again and drops its card", () => {
    let s = reduce(initialState(), { type: "set_stitch_canceled", image: "pan", on: true });
    s = reduce(s, { type: "set_stitch_canceled", image: "other", on: true });
    s = reduce(s, { type: "set_stitch_progress", progress: { image: "pan", fraction: 0.4, stage: "Canceled", error: null, canceled: true } });
    const nonce = s.previewNonce;
    s = reduce(s, { type: "resume_pano_stitch", image: "pan" });
    expect(s.stitchCanceled).toEqual({ other: true });
    expect(s.stitch).toBeNull();
    expect(s.previewNonce).toBe(nonce + 1);
  });

  it("a stitch running for a canceled panorama (its recipe changed) lifts the mark", () => {
    let s = reduce(initialState(), { type: "set_stitch_canceled", image: "pan", on: true });
    s = reduce(s, { type: "set_stitch_progress", progress: running() });
    expect(s.stitchCanceled).toEqual({});
    // The canceled report itself does not.
    s = reduce(s, { type: "set_stitch_canceled", image: "pan", on: true });
    s = reduce(s, { type: "set_stitch_progress", progress: { image: "pan", fraction: 0.4, stage: "Canceled", error: null, canceled: true } });
    expect(s.stitchCanceled).toEqual({ pan: true });
  });
});

describe("the Pano panel", () => {
  it("offers Stitch again for the open panorama while it is canceled, and only then", async () => {
    const sent: Command[] = [];
    const base = { ...initialState(), activeImage: "pan" };
    const view = render(<PanoPanel state={base} dispatch={(c) => sent.push(c)} />);
    await screen.findByTestId("pano-straighten");
    expect(screen.queryByTestId("pano-canceled")).toBeNull();
    view.rerender(<PanoPanel state={reduce(base, { type: "set_stitch_canceled", image: "pan", on: true })} dispatch={(c) => sent.push(c)} />);
    expect(screen.getByTestId("pano-canceled")).toHaveTextContent("Stitch canceled.");
    fireEvent.click(screen.getByTestId("pano-stitch-again"));
    expect(mockResumes).toEqual(["pan"]);
    await waitFor(() => expect(sent).toEqual([{ type: "resume_pano_stitch", image: "pan" }]));
  });
});
