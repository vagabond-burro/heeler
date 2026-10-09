// The Inspector's controls against Develop's, tool by tool. The
// report: "The controls, button sizes, font sizes, etc should all
// match what is in Develop. It should look no different... I am
// concerned that some tools may not have the same layout of
// controls." These pin the parity fixes: the rows Develop had that
// the Inspector was missing, and the names both surfaces must share.

import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { initialState } from "../data";
import { makeNode, specFor } from "../nodes";
import { NEUTRAL_PARAMS, reduce, type Command } from "../state";
import { NodeParams } from "../ui/graph";

// Params seeded the way the add-node reducer seeds them: a bare
// makeNode has none, and a generic panel draws rows from the instance.
const node = (type: string) => ({
  ...makeNode(specFor(type)!, "n1", 0, 0),
  params: { ...(NEUTRAL_PARAMS[type] ?? {}) },
});

describe("inspector parity with Develop", () => {
  it("levels offers all five of Develop's rows, falloffs included", () => {
    render(<NodeParams node={node("heeler.levels")} dispatch={() => {}} />);
    for (const label of ["Black point", "White point", "Gamma", "Black falloff", "White falloff"]) {
      expect(screen.getByText(label)).toBeTruthy();
    }
  });

  it("geometry offers Aspect like Develop's Geometry section", () => {
    render(<NodeParams node={node("heeler.crop_rotate")} dispatch={() => {}} />);
    expect(screen.getByText("Aspect")).toBeTruthy();
  });

  it("exposure uses Develop's names and its Contrast and Range headings", () => {
    render(<NodeParams node={node("heeler.exposure")} dispatch={() => {}} />);
    expect(screen.getByText("Luminance")).toBeTruthy();
    expect(screen.queryByText("Contrast", { selector: ".kicker" })).toBeTruthy();
    expect(screen.getByTestId("subsection-range")).toBeTruthy();
  });

  it("the source node offers Develop's Highlights and Demosaic seats", () => {
    const got: Command[] = [];
    render(<NodeParams node={node("heeler.image_source")} dispatch={(c) => got.push(c)} />);
    fireEvent.click(screen.getByTestId("inspector-source-highlights"));
    fireEvent.click(screen.getByTestId("inspector-source-highlights-option-rebuild"));
    fireEvent.click(screen.getByTestId("inspector-source-demosaic"));
    fireEvent.click(screen.getByTestId("inspector-source-demosaic-option-fine"));
    // Capture sharpening's seat (2026-09-29), Standard until chosen.
    expect(screen.getByTestId("inspector-source-sharpening")).toHaveAttribute("data-value", "standard");
    fireEvent.click(screen.getByTestId("inspector-source-sharpening"));
    fireEvent.click(screen.getByTestId("inspector-source-sharpening-option-high"));
    expect(got).toEqual([
      { type: "set_text_param", id: "n1", param: "highlights", value: "rebuild" },
      { type: "set_text_param", id: "n1", param: "demosaic", value: "fine" },
      { type: "set_text_param", id: "n1", param: "sharpening", value: "high" },
    ]);
  });

  it("a linear tone profile hides Profile amt, like Develop's Source block", () => {
    const n = node("heeler.tone_profile");
    render(<NodeParams node={n} dispatch={() => {}} />);
    expect(screen.getByText("Profile amt")).toBeTruthy();
    render(
      <NodeParams node={{ ...n, textParams: { mode: "linear" } }} dispatch={() => {}} />,
    );
    expect(screen.getAllByText("Profile amt").length).toBe(1);
  });

  it("generic nodes wear Develop's labels: vignette's Amount, dof's Focus distance", () => {
    render(<NodeParams node={node("heeler.vignette")} dispatch={() => {}} />);
    expect(screen.getByText("Amount")).toBeTruthy();
    expect(screen.getByText("Midpoint")).toBeTruthy();
    render(<NodeParams node={node("heeler.dof")} dispatch={() => {}} />);
    expect(screen.getByText("Focus distance")).toBeTruthy();
    expect(screen.getByText("Fringing")).toBeTruthy();
  });

  it("the linear and radial masks carry Develop's LINES and THICKNESS rows", () => {
    // the Linear layer's lines take the Radial's color and thickness,
    // and a Develop control sits on its node too.
    for (const [type, prefix] of [
      ["heeler.linear_mask", "linear"],
      ["heeler.radial_mask", "radial"],
    ] as const) {
      const got: Command[] = [];
      const { unmount } = render(<NodeParams node={node(type)} dispatch={(c) => got.push(c)} appState={initialState()} />);
      expect(screen.getByTestId(`${prefix}-lines`)).toBeTruthy();
      expect((screen.getByTestId(`${prefix}-line-width`) as HTMLInputElement).value).toBe("2");
      fireEvent.click(screen.getByTestId(`${prefix}-line-auto`));
      fireEvent.click(screen.getByTestId(`${prefix}-line-width-pref`));
      expect(got).toEqual([
        { type: "set_line_color", hue: null, luma: null },
        { type: "set_photo_line_width", width: 0 },
      ]);
      unmount();
    }
  });

  it("a lone color grade offers Vibrance, the full paired set", () => {
    render(<NodeParams node={node("heeler.color_grade")} dispatch={() => {}} />);
    expect(screen.getByText("Vibrance")).toBeTruthy();
  });
});

describe("inspector eyedroppers", () => {
  // With app state (a window that has a viewer), the widgets offer the
  // same pickers Develop does, armed for THIS node; without it (the
  // popped-out graph window, which has no photograph to click) they
  // hide. "it should be implemented to maintain parity
  // between the 3 modes."
  it("relight's zone picker arms for the selected node, and hides stateless", () => {
    const got: Command[] = [];
    const s = initialState();
    render(
      <NodeParams node={node("heeler.tone_eq")} dispatch={(c) => got.push(c)} appState={s} />,
    );
    fireEvent.click(screen.getByTestId("tone-eq-pick"));
    expect(got).toContainEqual({ type: "toggle_tone_eq_pick", id: "n1" });

    render(<NodeParams node={node("heeler.tone_eq")} dispatch={() => {}} />);
    expect(screen.getAllByTestId("tone-eq-pick").length).toBe(1);
  });

  it("the pick arm is per node: same node disarms, another re-aims", () => {
    let s = initialState();
    s = reduce(s, { type: "toggle_tone_eq_pick", id: "a" });
    expect(s.toneEqPick).toBe("a");
    s = reduce(s, { type: "toggle_tone_eq_pick", id: "b" });
    expect(s.toneEqPick).toBe("b");
    s = reduce(s, { type: "toggle_tone_eq_pick", id: "b" });
    expect(s.toneEqPick).toBe(null);
    s = reduce(s, { type: "toggle_recolor_pick", id: "r1" });
    expect(s.recolorPick).toBe("r1");
    s = reduce(s, { type: "toggle_console_pick", id: "c1" });
    expect(s.consolePick).toBe("c1");
  });

  it("curves offers the channel eyedropper and aims it at the node", () => {
    const got: Command[] = [];
    render(
      <NodeParams
        node={node("heeler.curves")}
        dispatch={(c) => got.push(c)}
        appState={initialState()}
      />,
    );
    fireEvent.click(screen.getByTestId("curve-pick"));
    expect(got.some((c) => c.type === "arm_curve_pick" && (c as { nodeId?: string }).nodeId === "n1")).toBe(true);
  });
});
