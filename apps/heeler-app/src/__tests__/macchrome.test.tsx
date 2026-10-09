// macOS window chrome: the OS paints native traffic lights over the
// app's own bar (titleBarStyle Overlay), so the bar reserves room on
// the left and the custom Windows-style controls disappear, letting
// the mode tabs, console and export buttons slide to the corner. The
// report: "otherwise you're going to have this odd game in the
// top-right corner on macOS."
import { render, screen } from "@testing-library/react";
import { describe, expect, it, afterEach } from "vitest";
import { App } from "../app";
import { setMacForTests } from "../platform";

describe("macOS window chrome", () => {
  afterEach(() => setMacForTests(null));

  it("on a Mac the custom controls yield to the traffic lights", () => {
    setMacForTests(true);
    render(<App />);
    // No second set of window controls in the corner.
    expect(screen.queryByTestId("window-controls")).not.toBeInTheDocument();
    // The bar leaves room where the OS draws the lights.
    expect(screen.getByTestId("mac-inset")).toBeInTheDocument();
  });

  it("everywhere else the custom controls stay and no room is wasted", () => {
    setMacForTests(false);
    render(<App />);
    expect(screen.getByTestId("window-controls")).toBeInTheDocument();
    expect(screen.queryByTestId("mac-inset")).not.toBeInTheDocument();
  });
});
