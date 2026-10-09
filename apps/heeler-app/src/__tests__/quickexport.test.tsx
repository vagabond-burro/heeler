// The title-bar EXPORT button is a quick export, not a second door to
// the export panel. "I don't think we need the big yellow
// EXPORT button that does the same thing as the sidebar. UNLESS you
// turn that into a quick Export. It can default to JPG but if you hold
// ALT key with the mouse over it turns to a PNG export."

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";
import { App } from "../app";
import { mockExportedLog, mockResetExports } from "../bridge";
import { dragTrack } from "./trackdrive";

beforeEach(() => mockResetExports());

describe("the quick export button", () => {
  it("shows the export glyph with JPG, and PNG while ALT is down", () => {
    render(<App />);
    const btn = () => screen.getByTestId("btn-export");
    // The word EXPORT became an icon; the format text is the label now.
    expect(btn()).toHaveTextContent("JPG");
    fireEvent.keyDown(window, { key: "Alt" });
    expect(btn()).toHaveTextContent("PNG");
    fireEvent.keyUp(window, { key: "Alt" });
    expect(btn()).toHaveTextContent("JPG");
  });

  it("a click exports a JPG, an ALT click a PNG", async () => {
    render(<App />);
    fireEvent.click(screen.getByTestId("btn-export"));
    await waitFor(() => expect(mockExportedLog()).toHaveLength(1));
    expect(mockExportedLog()[0].format).toBe("jpeg");

    fireEvent.click(screen.getByTestId("btn-export"), { altKey: true });
    await waitFor(() => expect(mockExportedLog()).toHaveLength(2));
    expect(mockExportedLog()[1].format).toBe("png");
  });

  /// Right-click or Ctrl/Cmd+click: both, because on a Mac Ctrl+click
  /// IS a right-click, which settles the either-or.
  it("right-click and Ctrl+click open the settings, not an export", async () => {
    render(<App />);
    fireEvent.contextMenu(screen.getByTestId("btn-export"));
    expect(screen.getByTestId("quick-export-menu")).toBeInTheDocument();
    // Dismiss, then the other gesture.
    fireEvent.mouseDown(document.body);
    expect(screen.queryByTestId("quick-export-menu")).not.toBeInTheDocument();
    fireEvent.click(screen.getByTestId("btn-export"), { ctrlKey: true });
    expect(screen.getByTestId("quick-export-menu")).toBeInTheDocument();
    expect(mockExportedLog()).toHaveLength(0);
  });

  it("the settings adjust quality and size and export from there", async () => {
    const user = userEvent.setup();
    render(<App />);
    fireEvent.contextMenu(screen.getByTestId("btn-export"));
    dragTrack(screen.getByTestId("quick-quality"), 80);
    await user.click(screen.getByTestId("quick-size-percent"));
    fireEvent.change(screen.getByTestId("quick-size-value"), { target: { value: "50" } });
    await user.click(screen.getByTestId("quick-export-jpg"));
    await waitFor(() => expect(mockExportedLog()).toHaveLength(1));
    expect(mockExportedLog()[0].format).toBe("jpeg");
    expect(screen.queryByTestId("quick-export-menu")).not.toBeInTheDocument();
  });
});
