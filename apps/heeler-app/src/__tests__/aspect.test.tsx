// Geometry grows Aspect.
//
// "I think the Adjustments > Geometry tools are missing Distortion
// and Aspect adjustments." Aspect is new: a crop_rotate param, a slider-based RAW
// editor's Transform convention (negative widens, positive heightens). Distortion
// already exists on the lens node and stays there; the section contract (a
// section's switch bypasses every node it writes) is why it cannot simply be
// re-homed under Geometry's toggle.

import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { App } from "../app";
import { initialState } from "../data";
import { migrateNodes, OFF_BY_DEFAULT, reduce } from "../state";
import { serializeGraph } from "../bridge";

function openAllSections() {
  for (const title of OFF_BY_DEFAULT) {
    const slug = title.toLowerCase().replace(/[^a-z]+/g, "-");
    const btn = screen.queryByTestId(`collapse-${slug}`);
    if (btn && btn.getAttribute("data-open") !== "true") fireEvent.click(btn);
  }
}

describe("Geometry's Aspect control", () => {
  it("renders in the Geometry section and drives the crop node", () => {
    render(<App />);
    openAllSections();
    const slider = within(screen.getByTestId("slider-aspect")).getByRole("slider");
    fireEvent.keyDown(slider, { key: "ArrowRight" });
    expect(Number(slider.getAttribute("aria-valuenow"))).toBeGreaterThan(0);
  });

  it("writes to the crop node and serializes for the engine", () => {
    let s = initialState();
    const crop = s.nodes.find((n) => n.type === "heeler.crop_rotate")!;
    expect(crop.params.aspect).toBe(0);
    s = reduce(s, { type: "set_param", id: crop.id, param: "aspect", value: -40 });
    const sent = serializeGraph(s).nodes.find((n: { id: string }) => n.id === crop.id);
    expect((sent?.params as Record<string, unknown>).aspect).toBe(-40);
  });

  it("a graph saved before Aspect existed gains it at identity", () => {
    const old = initialState().nodes.map((n) =>
      n.type === "heeler.crop_rotate"
        ? { ...n, params: { angle: 3, crop_x: 0, crop_y: 0, crop_w: 1, crop_h: 1 } }
        : n
    );
    const migrated = migrateNodes(old);
    const crop = migrated.find((n) => n.type === "heeler.crop_rotate")!;
    expect(crop.params.aspect).toBe(0);
    // What was set survives the backfill untouched.
    expect(crop.params.angle).toBe(3);
  });
});
