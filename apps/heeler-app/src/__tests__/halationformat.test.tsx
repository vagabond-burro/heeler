import { describe, expect, it } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { App } from "../app";
import { chooseWith, menuValue } from "./menuhelp";

/** Halation's Format is a menu (2026-09-15: "When buttons are side by
 * side it reads like a tab view").*/
describe("Halation's Format menu", () => {
  it("rests at 35mm, writes the gauge, and says what each one does", async () => {
    const user = userEvent.setup();
    render(<App />);
    const header = screen.getByTestId("collapse-halation");
    if (header.getAttribute("aria-expanded") === "false") fireEvent.click(header);
    const menu = screen.getByTestId("halation-format");
    expect(menuValue(menu)).toBe("35mm");
    expect(menu).toHaveAttribute("data-hint", expect.stringMatching(/reference gauge/));
    await chooseWith(user, menu, "16mm");
    expect(menuValue(screen.getByTestId("halation-format"))).toBe("16mm");
    expect(screen.getByTestId("halation-format")).toHaveAttribute("data-hint", expect.stringMatching(/16mm: a small gauge/));
  });
});
