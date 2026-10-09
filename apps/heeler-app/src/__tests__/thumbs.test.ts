// Thumbnails on demand (2026-09-19): a cell asks when it is on screen,
// withdraws the ask when it leaves first, a folder open queues
// nothing, and the decodes in flight stay few so the rest of the app
// keeps answering.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const pending = new Map<string, (src: string | null) => void>();
const sent = new Map<string, unknown>();
vi.mock("../bridge", async (original) => ({
  ...await original<Record<string, unknown>>(),
  isTauri: () => true,
  loadThumbnail: (id: string, _edge: number, graph?: unknown) => {
    sent.set(id, graph);
    return new Promise<string | null>((resolve) => pending.set(id, resolve));
  },
}));

import type { Command } from "../state";
import { beginThumbSession, resetThumbsForTests, setThumbnailGraphs, thumbQueueForTests, unwantThumb, wantThumb } from "../thumbs";
import { loadSessionImages } from "../ui/chrome";

const got: Command[] = [];
const dispatch = (c: Command) => { got.push(c); };

beforeEach(() => {
  got.length = 0;
  pending.clear();
  sent.clear();
  resetThumbsForTests();
});
afterEach(() => resetThumbsForTests());

async function settle(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe("thumbnails on demand", () => {
  it("a folder open queues no decode at all", () => {
    const files = Array.from({ length: 100 }, (_, i) => ({ id: `img${i}`, name: `${i}.NEF`, stars: 0, flag: "" as const }));
    loadSessionImages(files, dispatch);
    expect(got[0].type).toBe("load_images");
    expect(pending.size).toBe(0);
    expect(thumbQueueForTests()).toMatchObject({ queued: [], inFlight: [], requested: 0 });
  });

  it("cells on screen ask, three decode at once, the rest wait their turn", async () => {
    beginThumbSession(dispatch, 480);
    for (let i = 0; i < 6; i++) wantThumb(`img${i}`);
    expect(thumbQueueForTests().inFlight).toEqual(["img0", "img1", "img2"]);
    expect(thumbQueueForTests().queued).toEqual(["img3", "img4", "img5"]);
    expect(got[got.length - 1]).toEqual({ type: "set_thumb_progress", progress: { done: 0, total: 3 } });
    pending.get("img1")!("data:one");
    await settle();
    expect(got).toContainEqual({ type: "set_thumb", id: "img1", src: "data:one" });
    expect(thumbQueueForTests().inFlight).toEqual(["img0", "img2", "img3"]);
    // Asked twice is asked once.
    wantThumb("img4");
    expect(thumbQueueForTests().queued).toEqual(["img4", "img5"]);
  });

  it("a cell that scrolls away before its turn withdraws the ask; one decoding finishes", async () => {
    beginThumbSession(dispatch, 480);
    for (let i = 0; i < 5; i++) wantThumb(`img${i}`);
    unwantThumb("img4");
    unwantThumb("img0");
    expect(thumbQueueForTests().queued).toEqual(["img3"]);
    expect(thumbQueueForTests().inFlight).toContain("img0");
    pending.get("img0")!("data:zero");
    await settle();
    expect(got).toContainEqual({ type: "set_thumb", id: "img0", src: "data:zero" });
  });

  it("a new session drops the old folder's asks and its late answers", async () => {
    beginThumbSession(dispatch, 480);
    wantThumb("old");
    beginThumbSession(dispatch, 480);
    expect(thumbQueueForTests().queued).toEqual([]);
    pending.get("old")!("data:late");
    await settle();
    expect(got.some((c) => c.type === "set_thumb")).toBe(false);
    // The progress line clears with the session.
    expect(got[got.length - 1]).toEqual({ type: "set_thumb_progress", progress: null });
  });

  it("late decodes release capacity for the new folder", async () => {
    beginThumbSession(dispatch, 480);
    for (const id of ["old-a", "old-b", "old-c"]) wantThumb(id);
    beginThumbSession(dispatch, 480);
    wantThumb("new");
    expect(pending.has("new")).toBe(false);
    pending.get("old-a")!("data:stale");
    await settle();
    expect(pending.has("new")).toBe(true);
    pending.get("new")!("data:new");
    pending.get("old-b")!(null);
    pending.get("old-c")!(null);
    await settle();
    expect(got.filter((c) => c.type === "set_thumb")).toEqual([
      { type: "set_thumb", id: "new", src: "data:new" },
    ]);
  });

  it("an old answer cannot clear a new session's in-flight marker for the same image", async () => {
    beginThumbSession(dispatch, 480);
    wantThumb("same");
    const oldAnswer = pending.get("same")!;
    beginThumbSession(dispatch, 480);
    wantThumb("same");
    const newAnswer = pending.get("same")!;
    oldAnswer("data:stale");
    await settle();
    expect(thumbQueueForTests().inFlight).toEqual(["same"]);
    wantThumb("same");
    expect(pending.get("same")).toBe(newAnswer);
    newAnswer("data:current");
    await settle();
  });

  it("a failed decode counts as done and the progress line clears at the end", async () => {
    beginThumbSession(dispatch, 480);
    wantThumb("a");
    wantThumb("b");
    pending.get("a")!(null);
    pending.get("b")!("data:b");
    await settle();
    expect(got.filter((c) => c.type === "set_thumb")).toHaveLength(1);
    expect(got[got.length - 1]).toEqual({ type: "set_thumb_progress", progress: null });
  });

  // a merge has no embedded preview, and its thumbnail was the undeveloped
  // merge, well under the viewer. The cell's ask carries the graph the app
  // says the photograph renders through.
  it("a photograph the app gives a graph asks with it; the rest ask bare", () => {
    setThumbnailGraphs((id) => (id === "merge" ? { graph_id: "merge_ui", nodes: [], connections: [] } : null));
    beginThumbSession(dispatch, 480);
    wantThumb("merge");
    wantThumb("raw");
    expect(sent.get("merge")).toEqual({ graph_id: "merge_ui", nodes: [], connections: [] });
    expect(sent.has("raw")).toBe(true);
    expect(sent.get("raw")).toBeUndefined();
  });
});
