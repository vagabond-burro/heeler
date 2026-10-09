// The ribbon says how many photographs are selected (2026-10-08:
// "it's hard to tell how many images are selected in the ribbon"). Only
// a selection of two or more is counted, the case a merge, a batch
// export or a sync acts on. It wears the accent color at the size of the
// shown/total count beside it ("the same font size as the XX/YY
// label").
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { App } from "../app";

describe("the ribbon's selection count", () => {
  it("counts a selection of two or more, follows it, and goes for one", () => {
    render(<App />);
    const thumbs = screen.getAllByTestId(/^thumb-[0-9]+$/);
    expect(screen.queryByTestId("ribbon-selected")).toBeNull();
    fireEvent.click(thumbs[0]);
    expect(screen.queryByTestId("ribbon-selected")).toBeNull();
    fireEvent.click(thumbs[2], { ctrlKey: true });
    expect(screen.getByTestId("ribbon-selected")).toHaveTextContent("2 selected");
    fireEvent.click(thumbs[3], { ctrlKey: true });
    fireEvent.click(thumbs[5], { ctrlKey: true });
    expect(screen.getByTestId("ribbon-selected")).toHaveTextContent("4 selected");
    fireEvent.click(thumbs[1]);
    expect(screen.queryByTestId("ribbon-selected")).toBeNull();
  });

  it("wears the accent color at the shown/total count's size", () => {
    render(<App />);
    const thumbs = screen.getAllByTestId(/^thumb-[0-9]+$/);
    fireEvent.click(thumbs[0]);
    fireEvent.click(thumbs[1], { ctrlKey: true });
    const count = screen.getByTestId("ribbon-selected");
    expect(count.style.fontSize).toBe(screen.getByTestId("filter-count").style.fontSize);
    // Both at the text-size rule's 11px minimum ("make both 11px").
    expect(count.style.fontSize).toBe("11px");
    expect(count.style.color).toBe("var(--accent)");
  });
});
