// The status line says the hotkey along with the help.
// "When this mouse hovers any tool that has a hotkey, display that
// hotkey along with the help message in the status bar." Controls
// name their command with data-hint-cmd and the LIVE binding is
// printed, so a remap shows the moment it lands; a key outside the
// registry rides data-hint-key as a literal; an unbound command adds
// nothing.

import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { setHintOverrides, useHint, useHintSource } from "../ui/hints";

function Probe(props: { hint?: string; cmd?: string; hintKey?: string }) {
  useHintSource();
  const hint = useHint();
  return (
    <>
      <div
        data-testid="control"
        data-hint={props.hint}
        data-hint-cmd={props.cmd}
        data-hint-key={props.hintKey}
      />
      <div data-testid="line">{hint ?? ""}</div>
    </>
  );
}

const hover = () => fireEvent.mouseOver(screen.getByTestId("control"));

describe("hotkeys in the status line", () => {
  afterEach(() => setHintOverrides({}));

  it("a command's default binding rides along with the help", () => {
    render(<Probe hint="Eyedropper: sample the photo" cmd="tool.pick" />);
    hover();
    expect(screen.getByTestId("line").textContent).toBe("Eyedropper: sample the photo (I)");
  });

  it("a remap shows the binding in force, not the default", () => {
    setHintOverrides({ "tool.pick": "Shift+K" });
    render(<Probe hint="Eyedropper: sample the photo" cmd="tool.pick" />);
    hover();
    expect(screen.getByTestId("line").textContent).toBe("Eyedropper: sample the photo (Shift+K)");
  });

  it("an unbound command adds nothing", () => {
    // view.before_after ships unbound on purpose.
    render(<Probe hint="Toggle the untouched original" cmd="view.before_after" />);
    hover();
    expect(screen.getByTestId("line").textContent).toBe("Toggle the untouched original");
  });

  it("a literal key outside the registry rides data-hint-key", () => {
    render(<Probe hint="Review the selected photos four at a time" hintKey="C" />);
    hover();
    expect(screen.getByTestId("line").textContent).toBe(
      "Review the selected photos four at a time (C)",
    );
  });
});
