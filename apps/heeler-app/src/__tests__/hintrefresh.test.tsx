// A control whose hint changes when it is used says its new hint
// without the pointer leaving and coming back: the RGB chip in Curves
// and the histogram reads as CMY the moment Option-click flips it.

import { act, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it } from "vitest";
import { useHint, useHintSource } from "../ui/hints";

function Probe() {
  useHintSource();
  const hint = useHint();
  const [ink, setInk] = useState(false);
  return (
    <>
      <button
        data-testid="chip"
        data-hint={ink ? "Back to RGB" : "Show as CMY"}
        onClick={() => setInk((v) => !v)}
      />
      <div data-testid="line">{hint ?? ""}</div>
    </>
  );
}

describe("the status line after a click", () => {
  it("reads the hovered control's new hint once the click has rendered", async () => {
    render(<Probe />);
    const chip = screen.getByTestId("chip");
    fireEvent.mouseOver(chip);
    expect(screen.getByTestId("line").textContent).toBe("Show as CMY");
    fireEvent.click(chip);
    await act(() => new Promise((r) => requestAnimationFrame(() => r(null))));
    expect(screen.getByTestId("line").textContent).toBe("Back to RGB");
  });

  it("a click elsewhere after the pointer left brings nothing back", async () => {
    render(<Probe />);
    const chip = screen.getByTestId("chip");
    fireEvent.mouseOver(chip);
    fireEvent.mouseLeave(document);
    fireEvent.click(chip);
    await act(() => new Promise((r) => requestAnimationFrame(() => r(null))));
    expect(screen.getByTestId("line").textContent).toBe("");
  });
});

// A click can remove its own control, for example closing a menu.
it("clears a removed control's hint after its click", async () => {
  function Closing() {
    useHintSource();
    const hint = useHint();
    const [open, setOpen] = useState(true);
    return <>{open && <button data-testid="close" data-hint="Close this menu" onClick={() => setOpen(false)} />}<output>{hint}</output></>;
  }
  const r = render(<Closing />);
  const button = r.getByTestId("close");
  fireEvent.mouseOver(button);
  fireEvent.click(button);
  await act(() => new Promise((resolve) => requestAnimationFrame(resolve)));
  expect(r.container.querySelector("output")!.textContent).toBe("");
});
