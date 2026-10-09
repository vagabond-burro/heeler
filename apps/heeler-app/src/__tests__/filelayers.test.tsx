// The "Layers from File..." import (26.3 Phase 7 import half): the
// image Finish kind, the picker's choices computed from the
// format-neutral passes report, and the reducer that adds one
// referenced layer per chosen entry, top of stack, Normal, 100%, in
// one undo step. The pixels are referenced from the file by page or
// layer name and never copied into the catalog.
import { describe, expect, it } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { initialState } from "../data";
import {
  ART_KINDS,
  artLayers,
  fileLayerChoices,
  reduce,
  type Command,
  type FilePasses,
  type State,
} from "../state";
import { ArtLayersTab } from "../ui/artlayers";
import { FileLayersDialog } from "../ui/filelayers";

function run(s: State, ...cmds: Command[]): State {
  return cmds.reduce(reduce, s);
}

const passes = (over: Partial<FilePasses>): FilePasses => ({
  depth: null,
  mattes: [],
  channels: [],
  normals: null,
  camera: false,
  pages: [],
  layers: [],
  layered: false,
  ...over,
});

describe("the picker's choices", () => {
  it("lists an EXR's RGB layer groups, beauty first", () => {
    const { choices, note } = fileLayerChoices("/ renders/beauty.exr".trim(), passes({ layers: ["", "coat", "shadow"] }));
    expect(choices).toEqual([
      { layer: "", label: "beauty" },
      { layer: "coat", label: "coat" },
      { layer: "shadow", label: "shadow" },
    ]);
    expect(note).toBeNull();
  });

  it("points single channels at the Object mask kind instead of listing them", () => {
    const { choices, note } = fileLayerChoices("/r/a.exr", passes({ layers: ["", "coat"], channels: ["A"], mattes: [{ layer: "crypto", names: ["her"] }] }));
    expect(choices.map((c) => c.layer)).toEqual(["", "coat"]);
    expect(note).toContain("Object");
    expect(note).toContain("mask");
  });

  it("lists a multi-page TIFF's pages, the composite first", () => {
    const { choices, note } = fileLayerChoices("/r/scan.tiff", passes({ pages: ["page 2", "page 3"], channels: ["A"] }));
    expect(choices).toEqual([
      { layer: "", label: "scan" },
      { layer: "page 2", label: "Page 2" },
      { layer: "page 3", label: "Page 3" },
    ]);
    expect(note).toBeNull();
  });

  it("shows a TIFF with a private layer stack as its one composite page, and says why, naming no other app", () => {
    const { choices, note } = fileLayerChoices("/r/psd.tiff", passes({ layered: true, pages: ["page 2"] }));
    expect(choices).toEqual([{ layer: "", label: "psd" }]);
    expect(note).toContain("private layer stack");
    expect(note).not.toMatch(/photoshop/i);
  });

  it("offers any other file as its one picture", () => {
    const { choices, note } = fileLayerChoices("/r/logo.png", null);
    expect(choices).toEqual([{ layer: "", label: "logo" }]);
    expect(note).toBeNull();
  });
});

describe("the image layer kind", () => {
  it("is a File node with a path and a layer, not an adjustment", () => {
    expect(ART_KINDS.image.type).toBe("heeler.file");
    expect(ART_KINDS.image.adjust).toBeUndefined();
  });

  it("opens and closes the picker as view state", () => {
    let s = initialState();
    s = run(s, { type: "open_file_layers", path: "/r/a.exr", passes: passes({ layers: ["", "coat"] }) });
    expect(s.fileLayersOffer?.path).toBe("/r/a.exr");
    expect(s.fileLayersOffer?.choices.map((c) => c.layer)).toEqual(["", "coat"]);
    s = run(s, { type: "close_file_layers" });
    expect(s.fileLayersOffer).toBeNull();
  });
});

describe("art_add_file_layers", () => {
  const addTwo: Command = {
    type: "art_add_file_layers",
    path: "/r/a.exr",
    items: [
      { layer: "", name: "a" },
      { layer: "coat", name: "coat" },
    ],
  };

  it("adds one referenced image layer per entry, top of stack, Normal, 100%", () => {
    const s = run(initialState(), addTwo);
    const ls = artLayers(s);
    expect(ls.length).toBe(2);
    // Render order is bottom first, so the second entry lands on top.
    const [beauty, coat] = ls;
    expect(beauty.content.type).toBe("heeler.file");
    expect(beauty.content.textParams).toMatchObject({ path: "/r/a.exr", layer: "" });
    expect(beauty.content.name).toBe("a");
    expect(beauty.blend.name).toBe("a");
    expect(coat.content.textParams).toMatchObject({ path: "/r/a.exr", layer: "coat" });
    expect(coat.content.name).toBe("coat");
    expect(coat.blend.textParams?.mode ?? "normal").toBe("normal");
    expect(coat.blend.params.opacity).toBe(100);
    // The image kind is a picture: the Export tick is offered.
    expect(coat.content.artKind).toBe("image");
  });

  it("undoes the whole import in one step", () => {
    let s = run(initialState(), addTwo);
    expect(artLayers(s).length).toBe(2);
    s = run(s, { type: "undo" });
    expect(artLayers(s).length).toBe(0);
  });

  it("shows a working Export checkbox on an image layer's row", () => {
    const s = run(initialState(), addTwo);
    const l = artLayers(s)[0];
    const seen: Command[] = [];
    render(<ArtLayersTab state={s} dispatch={(c) => seen.push(c)} />);
    fireEvent.click(screen.getByTestId(`art-export-${l.blend.id}`));
    expect(seen).toEqual([{ type: "art_set_export", id: l.blend.id, on: true }]);
  });
});

describe("the picker dialog", () => {
  const offered = (): State =>
    run(initialState(), {
      type: "open_file_layers",
      path: "/r/a.exr",
      passes: passes({ layers: ["", "coat", "shadow"] }),
    });

  it("adds only the checked entries, each placed on its own size, then closes", async () => {
    const s = offered();
    const seen: Command[] = [];
    render(<FileLayersDialog state={s} dispatch={(c) => seen.push(c)} />);
    fireEvent.click(screen.getByTestId("file-layers-choice-1"));
    fireEvent.click(screen.getByTestId("file-layers-dialog-done"));
    // The dialog closes at once; the layers follow once each entry's
    // size is read (the browser build's probe answers 1500 by 1000,
    // and with no frame measured yet the rest box is the whole frame).
    expect(seen).toEqual([{ type: "close_file_layers" }]);
    await waitFor(() => expect(seen).toHaveLength(2));
    const whole = { x: 0, y: 0, w: 1, h: 1 };
    expect(seen[1]).toEqual({
      type: "art_add_file_layers",
      path: "/r/a.exr",
      items: [
        { layer: "", name: "a", box: whole },
        { layer: "shadow", name: "shadow", box: whole },
      ],
    });
  });

  it("with nothing checked, Done adds nothing", () => {
    const s = offered();
    const seen: Command[] = [];
    render(<FileLayersDialog state={s} dispatch={(c) => seen.push(c)} />);
    for (const i of [0, 1, 2]) fireEvent.click(screen.getByTestId(`file-layers-choice-${i}`));
    fireEvent.click(screen.getByTestId("file-layers-dialog-done"));
    expect(seen).toEqual([{ type: "close_file_layers" }]);
  });

  it("says when single channels went to the Object mask kind", () => {
    const s = run(initialState(), {
      type: "open_file_layers",
      path: "/r/a.exr",
      passes: passes({ layers: ["", "coat"], channels: ["A"] }),
    });
    render(<FileLayersDialog state={s} dispatch={() => {}} />);
    expect(screen.getByTestId("file-layers-note").textContent).toContain("Object");
  });

  it("says why a TIFF with a private layer stack offers one page", () => {
    const s = run(initialState(), {
      type: "open_file_layers",
      path: "/r/psd.tiff",
      passes: passes({ layered: true, pages: ["page 2"] }),
    });
    render(<FileLayersDialog state={s} dispatch={() => {}} />);
    expect(screen.getByTestId("file-layers-note").textContent).toContain("private layer stack");
  });

  it("renders nothing while the offer is closed", () => {
    render(<FileLayersDialog state={initialState()} dispatch={() => {}} />);
    expect(screen.queryByTestId("file-layers-dialog")).toBeNull();
  });
});
