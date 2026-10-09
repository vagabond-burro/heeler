// Tests ahead of the 26.4.3 second refactor (the refactoring ledger;
// 2026-10-08: "yes, add it and start with the tests"): every path that
// turns the desktop's image row into the app's ImageEntry. Opening a
// folder (loadSessionImages), creating a stack (createStack) or a
// panorama (createPano), and baking (bakeComposite) each copy the row by
// hand; tethered arrivals do too (tether.test.tsx). These pin, path by
// path, every field each one carries today, read the way the app reads
// them: an absent flag is false and an absent link or origin is null.
// The fields a path drops today are not pinned here; that is the bug the
// next commit fixes (a just-made panorama of phone DNGs lost
// phoneRendered until the folder reloaded).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Command, ImageEntry } from "../state";

const invokeMock = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));

import { bakeComposite, createPano, createStack, type FolderImage } from "../bridge";
import { loadSessionImages } from "../ui/chrome";

/** A row with every field the desktop sends set away from its default. */
const FULL: FolderImage = {
  id: "r1",
  name: "MAX_a-b.stack",
  stars: 3,
  flag: "pick",
  edited: true,
  missing: true,
  linkGroup: "g1",
  link_group: "g1",
  renderedBake: true,
  phoneRendered: true,
  renderedFrames: true,
  bakedFrom: "a.jpg",
};
/** A row with only what every row has. */
const SPARSE: FolderImage = { id: "r2", name: "x.jpg", stars: 0, flag: "" };

/** An entry the way the app reads it. */
function meaning(e: ImageEntry) {
  return {
    id: e.id,
    name: e.name,
    stars: e.stars,
    flag: e.flag ?? "",
    edited: !!e.edited,
    missing: !!e.missing,
    linkGroup: e.linkGroup ?? null,
    renderedBake: !!e.renderedBake,
    phoneRendered: !!e.phoneRendered,
    renderedFrames: !!e.renderedFrames,
    bakedFrom: e.bakedFrom ?? null,
    filter: e.filter,
    src: e.src,
  };
}

const CORE = { id: "r1", name: "MAX_a-b.stack", stars: 3, flag: "pick", edited: true, filter: "none", src: "" };
const SPARSE_MEANS = {
  id: "r2", name: "x.jpg", stars: 0, flag: "", edited: false, missing: false, linkGroup: null,
  renderedBake: false, phoneRendered: false, renderedFrames: false, bakedFrom: null, filter: "none", src: "",
};

beforeEach(() => {
  (window as any).__TAURI_INTERNALS__ = { invoke: invokeMock };
  invokeMock.mockReset();
});
afterEach(() => {
  delete (window as any).__TAURI_INTERNALS__;
});

function folderEntries(rows: FolderImage[]): ImageEntry[] {
  const sent: Command[] = [];
  loadSessionImages(rows, (c) => sent.push(c));
  const load = sent.find((c) => c.type === "load_images") as Extract<Command, { type: "load_images" }>;
  return load.images;
}

describe("the image row each path turns into an entry", () => {
  it("opening a folder carries every field", () => {
    expect(meaning(folderEntries([FULL])[0])).toEqual({
      ...CORE, missing: true, linkGroup: "g1", renderedBake: true, phoneRendered: true, renderedFrames: true, bakedFrom: "a.jpg",
    });
    expect(meaning(folderEntries([SPARSE])[0])).toEqual(SPARSE_MEANS);
    // The link group arrives under either spelling.
    expect(folderEntries([{ ...SPARSE, link_group: "g2" }])[0].linkGroup).toBe("g2");
    // The browser build has no thumbnails to fetch: a stand-in picture.
    delete (window as any).__TAURI_INTERNALS__;
    expect(folderEntries([SPARSE])[0].src).not.toBe("");
  });

  it("a new stack carries its identity, rating, edits and how it was rendered", async () => {
    invokeMock.mockResolvedValue(FULL);
    const made = (await createStack(["a", "b"], "max"))!;
    expect(invokeMock.mock.calls[0][0]).toBe("create_stack");
    expect(meaning(made)).toMatchObject({ ...CORE, phoneRendered: true, renderedFrames: true });
    invokeMock.mockResolvedValue(SPARSE);
    expect(meaning((await createStack(["a", "b"], "max"))!)).toEqual(SPARSE_MEANS);
  });

  it("a new panorama the same", async () => {
    invokeMock.mockResolvedValue(FULL);
    const made = (await createPano(["a", "b"]))!;
    expect(invokeMock.mock.calls[0][0]).toBe("create_pano");
    expect(meaning(made)).toMatchObject({ ...CORE, phoneRendered: true, renderedFrames: true });
    invokeMock.mockResolvedValue(SPARSE);
    expect(meaning((await createPano(["a", "b"]))!)).toEqual(SPARSE_MEANS);
  });

  it("a bake carries its identity, rating, edits and its origin", async () => {
    invokeMock.mockResolvedValue(FULL);
    const made = (await bakeComposite("src", "dng", { nodes: [], wires: [] }))!;
    expect(invokeMock.mock.calls[0][0]).toBe("bake_composite");
    expect(meaning(made)).toMatchObject({ ...CORE, renderedBake: true, bakedFrom: "a.jpg" });
    invokeMock.mockResolvedValue(SPARSE);
    expect(meaning((await bakeComposite("src", "dng", { nodes: [], wires: [] }))!)).toEqual(SPARSE_MEANS);
  });

  it("a row with no flag set reads as unflagged on every path", async () => {
    const unflagged = { ...SPARSE, flag: undefined } as unknown as FolderImage;
    invokeMock.mockResolvedValue(unflagged);
    expect((await createStack(["a"], "max"))!.flag).toBe("");
    expect((await createPano(["a"]))!.flag).toBe("");
    expect((await bakeComposite("src", "dng", { nodes: [], wires: [] }))!.flag).toBe("");
  });
});

// Every path carries every field the row has (2026-10-08). A new stack,
// panorama, bake or tethered arrival dropped what its hand-made copy did
// not name: a just-made panorama of phone DNGs lost phoneRendered and
// opened with the RAW Tone Profile until the folder reloaded.
describe("no path drops a field the desktop sent", () => {
  const ALL = { ...CORE, missing: true, linkGroup: "g1", renderedBake: true, phoneRendered: true, renderedFrames: true, bakedFrom: "a.jpg" };
  it("a new stack, a new panorama and a bake carry the whole row", async () => {
    invokeMock.mockResolvedValue(FULL);
    expect(meaning((await createStack(["a", "b"], "max"))!)).toEqual(ALL);
    expect(meaning((await createPano(["a", "b"]))!)).toEqual(ALL);
    expect(meaning((await bakeComposite("src", "dng", { nodes: [], wires: [] }))!)).toEqual(ALL);
  });
});
