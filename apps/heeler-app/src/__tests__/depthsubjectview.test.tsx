// View depth fitted to the subject (2026-10-29: "I thought DA Large for
// depth maps would actually pull out details from the subject's face").
// The owl's relief was in the map, a sliver of grays between the perch
// and the background; the Subject chip spreads the view's grays over
// the subject's own depth. A view: the map the tools read is unchanged.

import { useReducer } from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { initialState, NEUTRAL_NODES, NEUTRAL_WIRES } from "../data";
import { maskOverlayWanted, previewTarget, reduce, type Command, type State } from "../state";
import { SubjectFitRunner } from "../ui/depthtool";
import { SimplePanel } from "../ui/simple";
import * as bridge from "../bridge";

vi.mock("../bridge", async (importOriginal) => {
  const real = await importOriginal<typeof import("../bridge")>();
  return {
    ...real,
    depthSubject: vi.fn(),
    smartModelDownload: vi.fn(async () => {}),
    smartModelStatus: vi.fn(async () => ({
      lite: { id: "birefnet_lite", installed: false, label: "BiRefNet Lite (subject matte)", bytes: 224_005_088, license: "MIT", url: "https://example.test/lite.onnx", version: "1" },
    })),
  };
});

const run = (s: State, ...cmds: Command[]) => cmds.reduce(reduce, s);
const fresh = (): State => ({ ...initialState(), nodes: structuredClone(NEUTRAL_NODES), wires: structuredClone(NEUTRAL_WIRES), sectionsClosed: [] });

beforeEach(() => vi.clearAllMocks());

describe("the depth view's Subject fit", () => {
  it("brings the view up fitted to the subject, and back to the scene's grays on a second click", () => {
    let s = run(fresh(), { type: "set_category", title: "Depth Map", on: true });
    expect(previewTarget(s)).toBeNull();
    s = run(s, { type: "toggle_depth_view_subject" });
    expect(s.depthView).toBe(true);
    expect(previewTarget(s)).toBe("__depth__@subject");
    // Still the depth view to everything that asks: the red flavor tints with it.
    expect(maskOverlayWanted({ ...s, maskRed: true })).toBe(true);
    s = run(s, { type: "toggle_depth_view_subject" });
    expect(s.depthView).toBe(true);
    expect(previewTarget(s)).toBe("__depth__");
    // The eye puts the view away; the fit is kept for the next time.
    s = run(s, { type: "toggle_depth_view_subject" }, { type: "toggle_depth_view" });
    expect(previewTarget(s)).toBeNull();
    s = run(s, { type: "toggle_depth_view" });
    expect(previewTarget(s)).toBe("__depth__@subject");
  });

  it("is a chip beside the Depth Map section's eye", () => {
    function Harness() {
      const [state, dispatch] = useReducer(reduce, run(fresh(), { type: "set_category", title: "Depth Map", on: true }));
      return (
        <>
          <span data-testid="target">{previewTarget(state) ?? "none"}</span>
          <SimplePanel state={state} dispatch={dispatch} />
        </>
      );
    }
    render(<Harness />);
    const chip = screen.getByTestId("depth-view-subject");
    expect(chip).toHaveAttribute("aria-pressed", "false");
    expect(chip.getAttribute("data-hint")).toMatch(/Only the view changes/);
    fireEvent.click(chip);
    expect(screen.getByTestId("depth-view-subject")).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByTestId("target").textContent).toBe("__depth__@subject");
    // The other depth sections carry the eye alone.
    expect(screen.queryAllByTestId("depth-view-subject")).toHaveLength(1);
  });
});

describe("the subject matte runner", () => {
  const fitted = () => run(fresh(), { type: "set_category", title: "Depth Map", on: true }, { type: "toggle_depth_view_subject" });

  it("finds the subject once while the fit is up and pokes a render when the model ran", async () => {
    vi.mocked(bridge.depthSubject).mockResolvedValue({ version: "v", work: "model" });
    const got: Command[] = [];
    const s = fitted();
    const view = render(<SubjectFitRunner state={s} dispatch={(c) => got.push(c)} />);
    await waitFor(() => expect(got).toContainEqual({ type: "poke_render" }));
    view.rerender(<SubjectFitRunner state={reduce(s, { type: "poke_render" })} dispatch={(c) => got.push(c)} />);
    expect(bridge.depthSubject).toHaveBeenCalledTimes(1);
  });

  it("asks nothing for the scene's grays or with the view down", () => {
    const s = run(fresh(), { type: "set_category", title: "Depth Map", on: true }, { type: "toggle_depth_view" });
    render(<SubjectFitRunner state={s} dispatch={() => {}} />);
    render(<SubjectFitRunner state={run(fitted(), { type: "toggle_depth_view" })} dispatch={() => {}} />);
    expect(bridge.depthSubject).not.toHaveBeenCalled();
  });

  it("asks for consent before the subject model downloads", async () => {
    vi.mocked(bridge.depthSubject).mockRejectedValue("model not installed");
    render(<SubjectFitRunner state={fitted()} dispatch={() => {}} />);
    await waitFor(() => expect(screen.getByTestId("depth-subject-consent")).toBeInTheDocument());
    expect(screen.getByTestId("depth-subject-consent").textContent).toContain("BiRefNet Lite");
  });
});
