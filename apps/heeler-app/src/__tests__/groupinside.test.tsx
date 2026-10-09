// Inside an opened group the cards are the group's members, and they
// must behave as cards do at the top level: a click inspects the node,
// in Graph mode and in Canvas mode, and the engine is asked for their
// thumbnails (2026-09-23, inside the Sharpening group: "the settings
// didn't open for that node", "the inverted node does not show the
// image inverted").

import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

vi.mock("../bridge", async (importOriginal) => {
  const real = (await importOriginal()) as Record<string, unknown>;
  return {
    ...real,
    nodeThumbs: vi.fn(async (_s: unknown, ids: string[]) => Object.fromEntries(ids.map((id) => [id, "data:image/png;base64,thumb"]))),
  };
});

import { App } from "../app";
import { nodeThumbs } from "../bridge";
import { CanvasMode } from "../ui/canvas";
import { initialState } from "../data";
import { reduce, type Command } from "../state";
import { sharpeningGroup } from "../recipes";
import { menuValue } from "./menuhelp";

describe("inside an opened group", () => {
  it("disabled members and a disabled group cannot show stale thumbnails", async () => {
    const g = sharpeningGroup("review_thumbs", 0, 0, { enabled: true });
    let s = { ...initialState(), activeImage: "review_owned_photo", nodes: [g], wires: [], openedGroup: g.id };
    vi.mocked(nodeThumbs).mockClear();
    const view = render(<CanvasMode state={s} dispatch={() => {}} />);
    await screen.findByTestId("node-thumb-sharp_blur_review_thumbs");
    const asked = vi.mocked(nodeThumbs).mock.calls.flatMap(([, ids]) => ids);
    expect(asked).not.toContain("sharp_hp_review_thumbs");
    s = { ...s, nodes: [{ ...g, enabled: false }], renderVersion: s.renderVersion + 1 };
    view.rerender(<CanvasMode state={s} dispatch={() => {}} />);
    expect(screen.queryByTestId("node-thumb-sharp_blur_review_thumbs")).not.toBeInTheDocument();
    expect(screen.getByTestId("node-sharp_blur_review_thumbs").querySelector(".thumb img")).toBeNull();
  });

  it("a thumbnail omitted by the engine clears the previous answer", async () => {
    const g = sharpeningGroup("review_missing_thumb", 0, 0, { enabled: true });
    const s = { ...initialState(), activeImage: "review_missing_photo", nodes: [g], wires: [], openedGroup: g.id };
    const view = render(<CanvasMode state={s} dispatch={() => {}} />);
    await screen.findByTestId("node-thumb-sharp_blur_review_missing_thumb");
    vi.mocked(nodeThumbs).mockResolvedValueOnce({});
    view.rerender(<CanvasMode state={{ ...s, renderVersion: s.renderVersion + 1 }} dispatch={() => {}} />);
    await waitFor(() => expect(screen.queryByTestId("node-thumb-sharp_blur_review_missing_thumb")).not.toBeInTheDocument());
  });
  it("Canvas uses the inspector face for Blend and the group's published controls", () => {
    let s = reduce(initialState(), { type: "set_category", title: "Sharpening", on: true });
    s = reduce(s, { type: "open_group", id: "sharpening" });
    s = reduce(s, { type: "select_nodes", ids: ["sharp_over_sharpening"] });
    const view = render(<CanvasMode state={s} dispatch={() => {}} />);
    expect(menuValue(screen.getByTestId("node-option-mode"))).toBe("overlay");
    s = reduce(s, { type: "open_group", id: null });
    s = reduce(s, { type: "select_nodes", ids: ["sharpening"] });
    view.rerender(<CanvasMode state={s} dispatch={() => {}} />);
    expect(menuValue(screen.getByTestId("node-option-mode"))).toBe("vivid");
    expect(screen.getByTestId("published-keep-color")).toBeInTheDocument();
  });

  it("Graph mode: clicking a member inspects it, and the thumbnails are asked for the members", async () => {
    const user = userEvent.setup();
    render(<App />);
    await user.click(screen.getByTestId("toggle-sharpening"));
    await user.click(screen.getByRole("tablist", { name: /workspace mode/i }).children[1]);
    vi.mocked(nodeThumbs).mockClear();
    fireEvent.doubleClick(screen.getByTestId("node-sharpening"));
    const blur = await screen.findByTestId("node-sharp_blur_sharpening");
    fireEvent.mouseDown(blur);
    // The inspector shows the Blur node's own dials.
    expect(screen.getByTestId("slider-radius")).toBeInTheDocument();
    expect(blur.getAttribute("data-selected")).toBe("true");
    // And the engine is asked for the members' pictures, the Invert and
    // the Blur among them, which it can answer since the flattened graph
    // keeps their ids.
    await waitFor(() => {
      const asked = vi.mocked(nodeThumbs).mock.calls.flatMap(([, ids]) => ids);
      expect(asked).toContain("sharp_inv_sharpening");
      expect(asked).toContain("sharp_blur_sharpening");
    });
  });

  it("Canvas mode: a selected member gets the settings card", () => {
    let s = reduce(initialState(), { type: "set_category", title: "Sharpening", on: true });
    s = reduce(s, { type: "open_group", id: "sharpening" } as unknown as Command);
    s = reduce(s, { type: "select_nodes", ids: ["sharp_blur_sharpening"] } as Command);
    render(<CanvasMode state={s} dispatch={() => {}} />);
    expect(screen.getByLabelText("Close settings")).toBeInTheDocument();
    expect(screen.getByTestId("slider-radius")).toBeInTheDocument();
  });
});
