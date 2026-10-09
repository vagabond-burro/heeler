// Links inside the guide that name a heading: "exposure.md#zones" and
// "#zones". (2026-09-15) saw one rendered as "Exposure
// (exposure.md#zones)", text with the target in brackets, because the
// viewer took an href ending in ".md" as the mark of a page link.

import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { Markdown, docSlug } from "../ui/docsviewer";

describe("anchored links in the guide", () => {
  it("a link to a heading on another page opens that page and carries the anchor", () => {
    const openDoc = vi.fn();
    render(<Markdown text="See [Exposure](exposure.md#zones) for Zones." from="adjustments/black-and-white.md" openDoc={openDoc} />);
    const link = screen.getByText("Exposure");
    expect(link.tagName).toBe("A");
    expect(link).toHaveAttribute("data-doc-link", "adjustments/exposure.md");
    expect(link).toHaveAttribute("data-doc-anchor", "zones");
    // The target is not printed beside the label.
    expect(screen.queryByText(/exposure\.md/)).toBeNull();
    fireEvent.click(link);
    expect(openDoc).toHaveBeenCalledWith("adjustments/exposure.md", "zones");
  });

  it("a link to a heading on this page opens this page at the heading", () => {
    const openDoc = vi.fn();
    render(<Markdown text="Below, [the print](#print)." from="adjustments/black-and-white.md" openDoc={openDoc} />);
    fireEvent.click(screen.getByText("the print"));
    expect(openDoc).toHaveBeenCalledWith("adjustments/black-and-white.md", "print");
  });

  it("a plain page link still opens with no anchor, and an outside link stays text", () => {
    const openDoc = vi.fn();
    render(<Markdown text="[Print](print.md) and [the site](https://www.heeler.app/docs.md)." from="adjustments/README.md" openDoc={openDoc} />);
    fireEvent.click(screen.getByText("Print"));
    expect(openDoc).toHaveBeenCalledWith("adjustments/print.md", undefined);
    expect(screen.getByText("the site").tagName).not.toBe("A");
  });

  it("headings carry the id the links name", () => {
    render(<Markdown text={"## Zones\n\n## The order of work\n\n### `heeler` API"} openDoc={() => {}} />);
    expect(document.getElementById("doc-zones")).toHaveTextContent("Zones");
    expect(document.getElementById("doc-the-order-of-work")).toBeTruthy();
    expect(document.getElementById("doc-heeler-api")).toBeTruthy();
    expect(docSlug("Black and White")).toBe("black-and-white");
  });
});
