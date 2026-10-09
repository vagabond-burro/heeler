// The viewer while the photograph is still decoding.
//
// "I still occasionally see 'Photograph in view'
// placeholder text when images are trying to load it is brief. I
// would like this replaced with the Heeler logo and loading bar."

import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { initialState } from "../data";
import { Viewer } from "../ui/viewer";

describe("the viewer with nothing to show yet", () => {
  it("shows the mark and a loading bar, not a broken image", () => {
    const s = initialState();
    const loading = {
      ...s,
      images: s.images.map((i) =>
        i.id === s.activeImage ? { ...i, src: "" } : i,
      ),
    };
    render(<Viewer state={loading} dispatch={() => {}} />);
    expect(screen.getByTestId("viewer-loading")).toBeInTheDocument();
    expect(screen.queryByTestId("viewer-image")).not.toBeInTheDocument();
    const bar = screen.getByTestId("viewer-loading").querySelector(".viewer-loading-bar");
    expect(bar).not.toBeNull();
  });

  it("shows the photograph the moment there is one", () => {
    render(<Viewer state={initialState()} dispatch={() => {}} />);
    expect(screen.getByTestId("viewer-image")).toBeInTheDocument();
    expect(screen.queryByTestId("viewer-loading")).not.toBeInTheDocument();
  });
});
