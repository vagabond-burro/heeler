import { act, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { _clearFlashForTests, flashStatus, setHint, useHint } from "../ui/hints";

function Row() {
  return <span data-testid="row">{useHint() ?? ""}</span>;
}

afterEach(() => {
  _clearFlashForTests();
  setHint(null);
  vi.useRealTimers();
});

describe("the status row", () => {
  it("shows a flash over the hover hint, then hands the row back", () => {
    // On clone and heal refusing a stroke: a notification "down in the
    // status line... show up for like 5 seconds then return to the
    // navigation tips".
    vi.useFakeTimers();
    setHint("Scroll zooms");
    render(<Row />);
    expect(screen.getByTestId("row")).toHaveTextContent("Scroll zooms");

    act(() => flashStatus("Heal: ALT-click somewhere first to set the source."));
    expect(screen.getByTestId("row")).toHaveTextContent("ALT-click");

    act(() => void vi.advanceTimersByTime(4900));
    expect(screen.getByTestId("row")).toHaveTextContent("ALT-click");

    act(() => void vi.advanceTimersByTime(200));
    expect(screen.getByTestId("row")).toHaveTextContent("Scroll zooms");
  });

  it("hands back whatever the pointer moved onto while it was up", () => {
    // The hover hint keeps updating underneath a flash; it just does not
    // get the row until the flash is done with it.
    vi.useFakeTimers();
    render(<Row />);
    act(() => flashStatus("Clone: ALT-click somewhere first to set the source."));
    act(() => setHint("Straighten: drag a line along the horizon"));
    expect(screen.getByTestId("row")).toHaveTextContent("ALT-click");
    act(() => void vi.advanceTimersByTime(5100));
    expect(screen.getByTestId("row")).toHaveTextContent("Straighten");
  });

  it("restarts the clock rather than stacking flashes", () => {
    vi.useFakeTimers();
    render(<Row />);
    act(() => flashStatus("first"));
    act(() => void vi.advanceTimersByTime(4000));
    act(() => flashStatus("second"));
    act(() => void vi.advanceTimersByTime(4000));
    expect(screen.getByTestId("row")).toHaveTextContent("second");
    act(() => void vi.advanceTimersByTime(1200));
    expect(screen.getByTestId("row")).toHaveTextContent("");
  });
});
