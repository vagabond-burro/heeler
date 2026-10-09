// The hue curve's eyedropper end to end, with a live sample: the mock
// bridge's sampleImage answers nothing, so the wiring is only proven
// with one that answers a color.
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

vi.mock("../bridge", async (importOriginal) => {
  const real = (await importOriginal()) as Record<string, unknown>;
  return {
    ...real,
    // A saturated red under the cursor, scene-linear.
    sampleImage: vi.fn(async () => ({
      luma: 0.5,
      hue: 0,
      sat: 0.9,
      r: 0.8,
      g: 0.05,
      b: 0.05,
      luma_linear: 0.2,
      source: "toneeq",
    })),
  };
});

import { App } from "../app";
import { chooseWith, menuRows } from "./menuhelp";

describe("the hue curve's eyedropper, end to end", () => {
  it("arms from the chip, rides a ghost on hover, and a press-and-drag writes the curve", async () => {
    const user = userEvent.setup();
    render(<App />);
    await user.click(screen.getByTestId("bw-mode-bw"));
    const curve = screen.getByTestId("bw-hue-curve");
    expect(within(curve).queryByTestId("eq-ghost")).toBeNull();
    await user.click(within(curve).getByTestId("bw-pick"));
    expect(within(curve).getByTestId("bw-pick")).toHaveAttribute("aria-pressed", "true");
    const overlay = screen.getByTestId("bw-pick-overlay");
    fireEvent.mouseMove(overlay, { clientX: 40, clientY: 40 });
    await waitFor(() => expect(within(curve).queryByTestId("eq-ghost")).not.toBeNull());
    // Press: a point is planted at red at once (the six at rest carry no
    // point near 29 degrees). Then drag up: it rises and the curve is written.
    // The X and Y fields carry eq-point- ids too; the circles are the points.
    const circles = () => within(curve).getAllByTestId(/^eq-point-/).filter((el) => el.tagName === "circle");
    const before = circles().map((p) => Number(p.getAttribute("cy")));
    fireEvent.mouseDown(overlay, { button: 0, clientX: 40, clientY: 200 });
    await waitFor(() => expect(circles().length).toBe(before.length + 1));
    fireEvent(window, new MouseEvent("mousemove", { clientX: 40, clientY: 80 }));
    await waitFor(() => {
      const after = circles().map((p) => Number(p.getAttribute("cy")));
      expect(Math.min(...after)).toBeLessThan(Math.min(...before) - 5);
    });
    fireEvent(window, new MouseEvent("mouseup", {}));
    // Still armed for the next hue.
    expect(screen.queryByTestId("bw-pick-overlay")).not.toBeNull();
  });

  it("offers the hue layouts and the interpolation faces, as Relight and Recolor do (2026-09-14)", async () => {
    const user = userEvent.setup();
    render(<App />);
    await user.click(screen.getByTestId("bw-mode-bw"));
    const curve = screen.getByTestId("bw-hue-curve");
    const layout = within(curve).getByRole("button", { name: "Curve layout" });
    const labels = menuRows(layout).map(([, l]) => l);
    expect(labels).toContain("Every 180°");
    expect(labels).toContain("Every 90°");
    expect(labels).toContain("Every 60°");
    expect(labels).toContain("Every 30°");
    await chooseWith(user, layout, "opposite");
    await waitFor(() =>
      expect(within(curve).getAllByTestId(/^eq-point-/).filter((el) => el.tagName === "circle").length).toBe(2),
    );
    await chooseWith(user, layout, "half");
    await waitFor(() =>
      expect(within(curve).getAllByTestId(/^eq-point-/).filter((el) => el.tagName === "circle").length).toBe(12),
    );
    expect(within(curve).queryByText("Smooth") ?? within(curve).queryByLabelText(/Smooth/)).not.toBeNull();
  });

  it("the curve's switch turns its effect off and on without touching the points", async () => {
    const user = userEvent.setup();
    render(<App />);
    await user.click(screen.getByTestId("bw-mode-bw"));
    const curve = screen.getByTestId("bw-hue-curve");
    const sw = within(curve).getByTestId("bw-hue-on");
    expect(sw).toHaveAttribute("aria-checked", "true");
    const n = within(curve).getAllByTestId(/^eq-point-/).filter((el) => el.tagName === "circle").length;
    await user.click(sw);
    expect(within(curve).getByTestId("bw-hue-on")).toHaveAttribute("aria-checked", "false");
    expect(within(curve).getAllByTestId(/^eq-point-/).filter((el) => el.tagName === "circle").length).toBe(n);
    await user.click(within(curve).getByTestId("bw-hue-on"));
    expect(within(curve).getByTestId("bw-hue-on")).toHaveAttribute("aria-checked", "true");
  });
});
