// The View Transform's curve face: drawn from the shared mirror, and
// grabbable. The math itself is pinned in viewtransform.test.ts; this
// file checks the face exists in the inspector and that dragging it
// edits the same params the sliders do.

import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { makeNode, specFor } from "../nodes";
import type { Command } from "../state";
import { NodeParams } from "../ui/graph";

const vtNode = () => makeNode(specFor("heeler.view_transform")!, "vt", 0, 0);

describe("the view transform face", () => {
  it("renders in the inspector with its readout", () => {
    render(<NodeParams node={vtNode()} dispatch={() => {}} />);
    expect(screen.getByTestId("vt-face")).toBeTruthy();
    expect(screen.getByTestId("vt-readout").textContent).toContain("EV +0.0");
    expect(screen.getByTestId("vt-readout").textContent).toContain("SIGMOID");
  });

  it("dragging the curve sideways trims exposure, and vertically moves contrast", () => {
    const got: Command[] = [];
    render(<NodeParams node={vtNode()} dispatch={(c) => got.push(c)} />);
    const grab = screen.getByTestId("vt-grab");
    fireEvent.mouseDown(grab, { clientX: 100, clientY: 60 });
    // Pulling right by one EV's worth of pixels and up by 20px.
    const pxPerEv = (280 - 22) / 18;
    fireEvent.mouseMove(window, { clientX: 100 + pxPerEv, clientY: 40 });
    fireEvent.mouseUp(window);

    expect(got[0]).toEqual({ type: "begin_gesture", key: "vt.face" });
    const set = got.find((c) => c.type === "set_params") as Extract<Command, { type: "set_params" }>;
    expect(set.id).toBe("vt");
    // Curve pulled right = the trim goes down; up = more contrast.
    expect(set.values.exposure_ev).toBeCloseTo(-1, 5);
    expect(set.values.contrast).toBe(130);
  });

  it("the filmic white point is its own handle", () => {
    const node = { ...vtNode(), textParams: { mode: "filmic" } };
    const got: Command[] = [];
    render(<NodeParams node={node} dispatch={(c) => got.push(c)} />);
    const white = screen.getByTestId("vt-white");
    fireEvent.mouseDown(white, { clientX: 100, clientY: 5 });
    const pxPerEv = (280 - 22) / 18;
    fireEvent.mouseMove(window, { clientX: 100 + 2 * pxPerEv, clientY: 5 });
    fireEvent.mouseUp(window);
    const set = got.find((c) => c.type === "set_params") as Extract<Command, { type: "set_params" }>;
    expect(set.values.white_ev).toBeCloseTo(8, 5);
  });
});
