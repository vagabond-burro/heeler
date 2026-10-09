import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { EqEditor } from "../ui/eqeditor";
import type { NodeCard } from "../state";

const bw = {
  id: "bw",
  type: "heeler.black_white",
  name: "Black & White",
  cat: "color",
  x: 0,
  y: 0,
  enabled: true,
  params: { amount: 100 },
  hasIn: true,
  hasOut: true,
} as NodeCard;
const pts = [0, 60, 120, 180, 240, 300].map((x) => ({ x, y: 0 }));

describe("the hue curve's ghost point (2026-09-14)", () => {
  it("rides the curve at the hovered hue while the eyedropper is armed, and only then", () => {
    const armed = render(
      <EqEditor node={bw} dispatch={(() => {}) as never} domain={[0, 360]} yRange={[-2, 2]} periodic points={pts} onPoints={() => {}} pickArmed onTogglePick={() => {}} pickTestId="bw-pick" hoverX={142} noPresets noInterp />,
    );
    expect(armed.queryByTestId("eq-ghost")).not.toBeNull();
    expect(armed.getByTestId("bw-pick")).toHaveAttribute("aria-pressed", "true");
    armed.unmount();
    const idle = render(
      <EqEditor node={bw} dispatch={(() => {}) as never} domain={[0, 360]} yRange={[-2, 2]} periodic points={pts} onPoints={() => {}} pickArmed={false} onTogglePick={() => {}} pickTestId="bw-pick" hoverX={142} noPresets noInterp />,
    );
    expect(idle.queryByTestId("eq-ghost")).toBeNull();
    idle.unmount();
    const nothing = render(
      <EqEditor node={bw} dispatch={(() => {}) as never} domain={[0, 360]} yRange={[-2, 2]} periodic points={pts} onPoints={() => {}} pickArmed onTogglePick={() => {}} pickTestId="bw-pick" hoverX={null} noPresets noInterp />,
    );
    expect(nothing.queryByTestId("eq-ghost")).toBeNull();
  });
});
