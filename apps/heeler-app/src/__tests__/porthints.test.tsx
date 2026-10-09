// Ports name themselves. "Whenever I hover an input or
// output, a tooltip below the mouse should read {Node
// name}.{attribute} and the status bar should also show that plus a
// brief message about the supported input and output data."
import { describe, expect, it } from "vitest";
import React from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { initialState } from "../data";
import { reduce } from "../state";
import { portHint, portName } from "../nodes";
import { NodeEditor } from "../ui/graph";
import { CursorTip } from "../ui/cursortip";

describe("what a port is called", () => {
  it("prints the engine's name after the dot, so the second input is what it is", () => {
    expect(portHint({ name: "Exposure", type: "heeler.exposure" }, "in").tip).toBe("Exposure.in");
    expect(portHint({ name: "Exposure", type: "heeler.exposure" }, "out").tip).toBe("Exposure.out");
    expect(portHint({ name: "Exposure", type: "heeler.exposure" }, "mask").tip).toBe("Exposure.mask");
    expect(portName("heeler.merge", "in")).toBe("base");
    expect(portName("heeler.merge", "in2")).toBe("fg");
    expect(portName("heeler.blend", "in2")).toBe("blend");
    expect(portName("heeler.luma_chroma_join", "in2")).toBe("chroma");
    expect(portName("heeler.logic", "in2")).toBe("fg");
  });

  it("says what data the port takes or gives, rgb or alpha", () => {
    // An image node's input wants rgb; a logic node's input wants a field.
    expect(portHint({ name: "Exposure", type: "heeler.exposure" }, "in").hint).toMatch(/^Exposure\.in · Image input: takes rgb/);
    expect(portHint({ name: "Compare", type: "heeler.compare" }, "in").hint).toMatch(/^Compare\.in · Field input: takes alpha/);
    expect(portHint({ name: "Exposure", type: "heeler.exposure" }, "mask").hint).toMatch(/Mask input: takes alpha/);
    expect(portHint({ name: "Exposure", type: "heeler.exposure" }, "out").hint).toMatch(/Image output: rgb/);
    expect(portHint({ name: "Luminance Mask", type: "heeler.luminance_range_mask" }, "maskOut").hint).toMatch(/Field output: alpha/);
  });
});

describe("the ports on the canvas", () => {
  const Harness = () => {
    const [s, d] = React.useReducer(reduce, initialState());
    return (
      <>
        <CursorTip />
        <NodeEditor state={s} dispatch={d} />
      </>
    );
  };

  it("carry the tip and the status hint, the mask input included", () => {
    render(<Harness />);
    const inPort = screen.getByTestId("in-port-exposure");
    expect(inPort.getAttribute("data-tip")).toBe("Exposure.in");
    expect(inPort.getAttribute("data-hint")).toMatch(/^Exposure\.in · Image input/);
    expect(inPort.hasAttribute("data-tip-below")).toBe(true);
    expect(screen.getByTestId("out-port-src").getAttribute("data-tip")).toBe("Image Source.out");
    // The diamond at the bottom left never said what it was.
    const maskIn = screen.getByTestId("mask-in-port-exposure");
    expect(maskIn.getAttribute("data-tip")).toBe("Exposure.mask");
    expect(maskIn.getAttribute("data-hint")).toMatch(/Mask input: takes alpha/);
    // The diamond on a masking node's right is its field output.
    const maskOut = screen.getByTestId("mask-port-lummask");
    expect(maskOut.getAttribute("data-tip")).toMatch(/\.out$/);
    expect(maskOut.getAttribute("data-hint")).toMatch(/Field output: alpha/);
    // Merge's inputs are base and fg, the way the engine names them.
    expect(screen.getByTestId("in-port-merge").getAttribute("data-tip")).toBe("Merge.base");
    expect(screen.getByTestId("in2-port-merge").getAttribute("data-tip")).toBe("Merge.fg");
  });

  it("the tip sits below the pointer, not above it", async () => {
    render(<Harness />);
    const port = screen.getByTestId("in-port-exposure");
    fireEvent.mouseOver(port, { clientX: 300, clientY: 200 });
    fireEvent.mouseMove(port, { clientX: 300, clientY: 200 });
    const tip = await screen.findByTestId("cursor-tip");
    expect(tip).toHaveTextContent("Exposure.in");
    expect(parseInt(tip.style.top)).toBeGreaterThan(200);
  });
});
