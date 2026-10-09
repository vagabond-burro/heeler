import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { useDialogFocus } from "../ui/dialogfocus";

function Harness() {
  const ref = useDialogFocus(true);
  return (
    <>
      <div ref={ref} role="dialog" aria-label="A dialog">
        <button>inside</button>
      </div>
      {/* A MenuSurface renders through a portal: outside the dialog's
          subtree, but opened from a button inside it. */}
      <div role="menu">
        <button role="menuitem">a menu item</button>
      </div>
      <button>somewhere else</button>
    </>
  );
}

describe("a dialog owning focus", () => {
  it("lets a portal menu keep focus and pulls it back from anything else", () => {
    render(<Harness />);
    expect(document.activeElement).toBe(screen.getByText("inside"));
    screen.getByText("a menu item").focus();
    expect(document.activeElement).toBe(screen.getByText("a menu item"));
    screen.getByText("somewhere else").focus();
    expect(document.activeElement).toBe(screen.getByText("inside"));
  });
});
