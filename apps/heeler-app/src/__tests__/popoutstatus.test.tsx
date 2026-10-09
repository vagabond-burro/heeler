import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import userEvent from "@testing-library/user-event";
import { App } from "../app";
import { BendWindow } from "../ui/bendwindow";
import { ConsoleWindow } from "../ui/consolewindow";
import { ToolWindow } from "../ui/toolwindow";
import { _clearFlashForTests } from "../ui/hints";
import { setTransport } from "../popout";

afterEach(() => {
  _clearFlashForTests();
  setTransport(null);
});

/* "the status line doesn't print help info when using a
 * pop-out window." Every pop-out carries the same status row now, so
 * a hinted control explains itself where it is.*/
describe("every pop-out window prints its hints", () => {
  it("the Color Bend window", () => {
    render(<BendWindow />);
    fireEvent.mouseOver(screen.getByTestId("bend-dock"));
    expect(screen.getByTestId("bend-window-hint")).toHaveTextContent("Put the color wheel back in the panel");
  });

  it("a tool window", () => {
    render(<ToolWindow kind="curves" />);
    fireEvent.mouseOver(screen.getByTestId("tool-window-dock"));
    expect(screen.getByTestId("tool-window-hint")).toHaveTextContent("Put this tool back in the panel");
  });

  it("the console window", () => {
    render(<ConsoleWindow />);
    const hinted = screen.getByTestId("console-window").querySelector("[data-hint]");
    expect(hinted).not.toBeNull();
    fireEvent.mouseOver(hinted!);
    expect(screen.getByTestId("console-window-hint").textContent).not.toBe("");
  });
});

describe("Canvas with the graph in its own window", () => {
  it("shows the same way back Graph mode has, and the bar brings the graph home", async () => {
    const user = userEvent.setup();
    render(<App />);
    await user.click(screen.getByRole("tablist", { name: /workspace mode/i }).children[2]);
    await user.click(screen.getByTestId("menu-window"));
    await user.click(screen.getByTestId("menu-window-graph"));
    expect(screen.getByTestId("graph-dock")).toBeInTheDocument();
    await user.click(screen.getByTestId("graph-dock"));
    expect(screen.queryByTestId("graph-dock")).not.toBeInTheDocument();
    expect(screen.getByTestId("canvas-graph-layer")).toBeInTheDocument();
  });
});
