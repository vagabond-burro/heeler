// Merges and panoramas in the ribbon: their faces, and the one delete
// this app performs.
//
// On a stack made minutes earlier: "I just stacked a new image for
// testing and it did not create a thumbnail" (older ones had them, from
// a folder load). And: "we do need a 'Delete Stack' or 'Delete
// Panorama' (context aware menu item) for these types of images...
// should only be visible for these types, never for actual files."

import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { initialState } from "../data";
import type { Command, ImageEntry, State } from "../state";
import { isComposite, isPano, isStack } from "../state";
import { mockResetThumbnails, mockSetThumbnail } from "../bridge";
import { Ribbon, compositeLabel, thumbnailForNew } from "../ui/chrome";

const composite = (id: string, name: string): ImageEntry => ({
  id,
  name,
  stars: 0,
  flag: "",
  edited: false,
  missing: false,
  filter: "none",
  src: "",
});

/** A ribbon holding one merge, one stitch and the sample photographs. */
function withComposites(): State {
  const s = initialState();
  return {
    ...s,
    images: [...s.images, composite("hdr1", "HDR_a-c.stack"), composite("pan1", "PANO_a-d.pano")],
  };
}

beforeEach(() => mockResetThumbnails());
afterEach(() => mockResetThumbnails());

describe("what counts as a composite", () => {
  it("knows a stack, a panorama, and the old extension", () => {
    expect(isStack({ name: "HDR_a-c.stack" })).toBe(true);
    expect(isStack({ name: "OLD.heelerstack" })).toBe(true);
    expect(isPano({ name: "PANO_a-d.pano" })).toBe(true);
    expect(isComposite({ name: "DSC_0001.NEF" })).toBe(false);
  });

  it("names the selection the way the menu should say it", () => {
    const s = withComposites();
    expect(compositeLabel(s, ["hdr1"])).toBe("Stack");
    expect(compositeLabel(s, ["pan1"])).toBe("Panorama");
    // Mixed takes the word that covers both rather than picking a side.
    expect(compositeLabel(s, ["hdr1", "pan1"])).toBe("Merge");
  });
});

describe("a freshly made composite gets a face", () => {
  it("asks the bridge for the thumbnail and puts it in the ribbon", async () => {
    // The catalog renders it through the manifest on first ask; before
    // this, nothing asked until the folder was opened again.
    mockSetThumbnail("hdr1", "data:image/jpeg;base64,AAAA");
    const sent: Command[] = [];
    await thumbnailForNew("hdr1", ((c: Command) => sent.push(c)) as never);
    expect(sent).toEqual([
      { type: "set_thumb", id: "hdr1", src: "data:image/jpeg;base64,AAAA" },
    ]);
  });

  it("says nothing when there is no thumbnail to be had", async () => {
    const sent: Command[] = [];
    await thumbnailForNew("hdr1", ((c: Command) => sent.push(c)) as never);
    expect(sent).toEqual([]);
  });
});

// Nothing deletes a composite any more, and nothing needs to.
//
// A .stack is a few hundred bytes of recipe, but it is a file in the
// user's folder, and the argument for deleting it (it is only settings,
// the frames are right there) is an argument about what is lost, not
// about who owns it. The owner, closing that out: "The reasoning is to
// remove ALL code related to deleting files. Even if we limit Heeler to
// delete only panoramas and stacks, its still deleting from disk. I am
// trying to manage risk here."
//
// So a merge goes where a photograph goes: renamed into the .trash
// beside it, catalog row intact, Put Back available. One seat, one
// behavior, and no removal in the codebase to reason about.
describe("a merge leaves the same way a photograph does", () => {
  const openMenu = (s: State, id: string, dispatch: (c: Command) => void) => {
    render(<Ribbon state={s} dispatch={dispatch as never} />);
    fireEvent.contextMenu(screen.getByTestId(`thumb-${id}`));
  };

  it("offers Move to Trash and nothing that deletes", () => {
    const s = withComposites();
    openMenu({ ...s, imageSelection: ["hdr1"], activeImage: "hdr1" }, "hdr1", () => {});
    expect(screen.getByTestId("thumb-menu-trash")).toBeInTheDocument();
    expect(screen.queryByTestId("thumb-menu-delete-composite")).not.toBeInTheDocument();
  });

  it("offers the same one seat for an ordinary photograph", () => {
    const s = withComposites();
    openMenu({ ...s, imageSelection: ["4866"], activeImage: "4866" }, "4866", () => {});
    expect(screen.getByTestId("thumb-menu-trash")).toBeInTheDocument();
    expect(screen.queryByTestId("thumb-menu-delete-composite")).not.toBeInTheDocument();
  });

  it("asks for a merge the way it asks for anything else", () => {
    const s = withComposites();
    const sent: Command[] = [];
    openMenu({ ...s, imageSelection: ["pan1"], activeImage: "pan1" }, "pan1", (c) => sent.push(c));
    fireEvent.click(screen.getByTestId("thumb-menu-trash"));
    expect(sent.some((c) => c.type === "ask_confirm" && c.action.kind === "trash_images")).toBe(true);
    // And no command in the app can ask for a deletion any more.
    expect(sent.some((c) => JSON.stringify(c).includes("delete_composites"))).toBe(false);
  });
});

describe("the menu stays inside the window", () => {
  /** jsdom measures everything as zero, so the menu states its height
   * the way a real one would. */
  const withHeight = (h: number) => {
    const real = Element.prototype.getBoundingClientRect;
    Element.prototype.getBoundingClientRect = function () {
      return { x: 0, y: 0, top: 0, left: 0, right: 170, bottom: h, width: 170, height: h, toJSON() {} } as DOMRect;
    };
    return () => {
      Element.prototype.getBoundingClientRect = real;
    };
  };

  it("a tall menu opened low is lifted so its last item is on screen", () => {
    // "The context menu when right clicking a thumbnail gets cut
    // off by the main window the vertical position of the thumbnail is too
    // low." jsdom's window is 768 tall; a 560px menu at y=700 has to move.
    const restore = withHeight(560);
    try {
      const s = withComposites();
      render(<Ribbon state={s} dispatch={(() => {}) as never} />);
      fireEvent.contextMenu(screen.getByTestId("thumb-4866"), { clientX: 40, clientY: 700 });
      const menu = screen.getByTestId("thumb-menu");
      const top = parseFloat(menu.style.top);
      expect(top + 560).toBeLessThanOrEqual(window.innerHeight);
      expect(top).toBeGreaterThanOrEqual(0);
      // And it never grows past the window, whatever it holds.
      expect(parseFloat(menu.style.maxHeight)).toBeLessThanOrEqual(window.innerHeight);
    } finally {
      restore();
    }
  });

  it("a menu taller than the window scrolls instead of losing its tail", () => {
    const restore = withHeight(2000);
    try {
      const s = withComposites();
      render(<Ribbon state={s} dispatch={(() => {}) as never} />);
      fireEvent.contextMenu(screen.getByTestId("thumb-4866"), { clientX: 40, clientY: 600 });
      const menu = screen.getByTestId("thumb-menu");
      expect(menu.style.overflowY).toBe("auto");
      expect(parseFloat(menu.style.maxHeight)).toBeLessThanOrEqual(window.innerHeight);
    } finally {
      restore();
    }
  });
});
