import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { App } from "../app";
import { saveUiSettings } from "../bridge";

afterEach(async () => { await saveUiSettings("{}"); });

const openPosition = () => {
  fireEvent.click(screen.getByTestId("menu-view"));
  fireEvent.click(screen.getByTestId("menu-view-navigator-position"));
};

it("View > Navigator Position places the Navigator in one of four corners, the header has no button for it", () => {
  // "The View menu should have a sub menu for Navigator Position that has
  // the 4 options. Remove the Navigator button from the canvas header."
  render(<App />);
  expect(screen.queryByTestId("btn-navigator")).toBeNull();
  openPosition();
  const rows = ["tl", "tr", "bl", "br"].map((c) => screen.getByTestId(`menu-view-navigator-${c}`));
  expect(rows.map((r) => r.textContent?.replace("✓", ""))).toEqual(["Top Left", "Top Right", "Bottom Left", "Bottom Right"]);
  expect(rows.map((r) => r.getAttribute("aria-checked"))).toEqual(["false", "false", "false", "true"]);
  fireEvent.click(screen.getByTestId("menu-view-navigator-tl"));
  expect(screen.queryByTestId("menu-view-navigator-position-list")).toBeNull();
  openPosition();
  expect(screen.getByTestId("menu-view-navigator-tl")).toHaveAttribute("aria-checked", "true");
  expect(screen.getByTestId("menu-view-navigator-br")).toHaveAttribute("aria-checked", "false");
});
