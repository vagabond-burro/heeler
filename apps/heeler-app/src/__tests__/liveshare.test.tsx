// Live shares and the static gallery, frontend half.
//
// "Would it be possible to have an option that when
// broadcasting that it refreshes when an image updates? What if I
// want someone to view the edits from a browser on their ipad." And
// the web-gallery wish: "pushing out pre-made web galleries that
// were ready for upload."
//
// The Rust side (versioned manifest, /live page, atomic swaps, the
// static generator) carries its own tests in serve.rs; these cover the
// app's half: the LIVE opt-in on the banner, the settled-edit debounce
// feeding serve_update, and the gallery action writing the folder.

import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { App } from "../app";
import { initialState } from "../data";
import { reduce } from "../state";
import { mockServeUpdates, serveStart, serveStop } from "../bridge";
import { _clearFlashForTests} from "../ui/hints";

vi.mock("../bridge", async () => {
  const actual = await vi.importActual<typeof import("../bridge")>("../bridge");
  return {
    ...actual,
    pickExportFolder: vi.fn(async () => "mock://gallery"),
    writeGallery: vi.fn(async () => {}),
  };
});

describe("the LIVE share option", () => {
  beforeEach(async () => {
    mockServeUpdates.length = 0;
    await serveStop();
  });

  it("is a plain state flag, off by default", () => {
    let s = initialState();
    expect(s.serveLive).toBe(false);
    s = reduce(s, { type: "toggle_serve_live" });
    expect(s.serveLive).toBe(true);
  });

  it("the banner grows the LIVE chip, and edits feed the share once settled", async () => {
    await serveStart("Family", [{ id: "4866", name: "DSC_04866.NEF" }], "mock://dir");
    const user = userEvent.setup();
    render(<App />);
    const banner = await screen.findByTestId("serve-banner");
    expect(within(banner).getByText(/SERVING · Family/)).toBeInTheDocument();

    await user.click(screen.getByTestId("serve-live"));
    expect(screen.getByTestId("serve-live")).toHaveAttribute("data-active", "true");
    expect(within(banner).getByText(/proofing view/)).toBeInTheDocument();

    // A real edit lands; the debounce settles; the share hears about
    // the ACTIVE image, marked live for the proofing page.
    const before = mockServeUpdates.length;
    const slider = within(screen.getByTestId("slider-exposure")).getByRole("slider");
    fireEvent.keyDown(slider, { key: "ArrowRight" });
    await waitFor(
      () => expect(mockServeUpdates.length).toBeGreaterThan(before),
      { timeout: 2500 }
    );
    const last = mockServeUpdates[mockServeUpdates.length - 1];
    expect(last.makeLive).toBe(true);
    expect(last.imageId).toBeTruthy();
  });

  it("without LIVE, edits never touch the share", async () => {
    await serveStart("Family", [{ id: "4866", name: "DSC_04866.NEF" }], "mock://dir");
    render(<App />);
    await screen.findByTestId("serve-banner");
    const slider = within(screen.getByTestId("slider-exposure")).getByRole("slider");
    fireEvent.keyDown(slider, { key: "ArrowRight" });
    await new Promise((r) => setTimeout(r, 1200));
    expect(mockServeUpdates).toHaveLength(0);
  });
});

describe("the static gallery action", () => {
  it("renders the collection and writes the gallery files", async () => {
    const bridge = await import("../bridge");
    const user = userEvent.setup();
    render(<App />);
    // Build a collection with the active image in it.
    await user.click(screen.getByTestId("new-collection"));
    await user.type(screen.getByTestId("new-collection-name"), "Web{Enter}");
    const add = await screen.findByTestId(/collection-add-/);
    await user.click(add);
    const globe = screen.getByTestId(/collection-gallery-/);
    await user.click(globe);
    await waitFor(() =>
      expect(vi.mocked(bridge.writeGallery)).toHaveBeenCalledWith(
        "mock://gallery",
        "Web",
        expect.arrayContaining([expect.objectContaining({ id: expect.any(String) })])
      )
    );
  });
});
