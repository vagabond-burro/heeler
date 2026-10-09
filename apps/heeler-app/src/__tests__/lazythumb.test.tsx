// The Catalog picker's lazy thumbnail swallows a failed fetch: an
// unreadable merge or a catalog hiccup leaves the cell empty, not an
// unhandled rejection per cell per mount.

import { cleanup, render } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { LazyThumb } from "../ui/graph";

const native = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => native);

afterEach(() => {
  cleanup();
  delete (window as any).__TAURI_INTERNALS__;
  native.invoke.mockReset();
});

it("a failed thumbnail fetch is caught, not an unhandled rejection", async () => {
  (window as any).__TAURI_INTERNALS__ = { invoke: native.invoke };
  native.invoke.mockRejectedValue(new Error("catalog busy"));
  const rejections: unknown[] = [];
  const onRejection = (reason: unknown) => rejections.push(reason);
  // jsdom's process type hides the EventEmitter half the runtime has.
  const proc = process as unknown as { on(e: string, f: (r: unknown) => void): void; removeListener(e: string, f: (r: unknown) => void): void };
  proc.on("unhandledRejection", onRejection);
  try {
    render(<LazyThumb id="outside-folder" />);
    // The fetch fires on mount (no IntersectionObserver in jsdom) and
    // rejects; an unhandled rejection reports on a later macrotask.
    await new Promise((r) => setTimeout(r, 30));
    expect(native.invoke).toHaveBeenCalledWith("load_thumbnail", { imageId: "outside-folder", edge: 240 });
    expect(rejections).toEqual([]);
  } finally {
    proc.removeListener("unhandledRejection", onRejection);
  }
});
