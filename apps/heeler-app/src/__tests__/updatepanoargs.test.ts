// The Pano panel's switches reach the backend: Tauri reads a command's
// arguments by their camelCase names and drops any other name without a
// word, so a switch sent as auto_crop wrote the recipe back unchanged and
// stayed on however often it was clicked (2026-10-29: "I am just sitting
// here clicking away and nothing is happening").

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { updatePano } from "../bridge";

const native = vi.hoisted(() => ({ invoke: vi.fn(async (): Promise<unknown> => ({})) }));
vi.mock("@tauri-apps/api/core", () => native);
afterEach(() => { delete (window as any).__TAURI_INTERNALS__; });

/** update_pano's parameters as Tauri names them for the caller. */
function commandArgs(): string[] {
  const rust = readFileSync(resolve(process.cwd(), "src-tauri/src/lib.rs"), "utf8");
  const sig = rust.slice(rust.indexOf("async fn update_pano("), rust.indexOf(") -> Result<PanoInfo"));
  return [...sig.matchAll(/(\w+): /g)].map((m) => m[1]).filter((n) => n !== "app").map((n) => n.replace(/_(\w)/g, (_, c: string) => c.toUpperCase()));
}

it("every Pano switch is sent under a name update_pano reads", async () => {
  (window as any).__TAURI_INTERNALS__ = { invoke: native.invoke };
  const names = commandArgs();
  expect(names).toContain("autoCrop");
  await updatePano("pan", { surface: "planar", gain_compensation: false, straighten: false, bands: 3, members: ["a", "b"], lens_correction: false, auto_crop: false });
  const calls = native.invoke.mock.calls as unknown as [string, Record<string, unknown>][];
  const [command, args] = calls[calls.length - 1];
  expect(command).toBe("update_pano");
  const sent = Object.entries(args).filter(([, v]) => v !== undefined);
  for (const [key] of sent) expect(names, key).toContain(key);
  expect(Object.fromEntries(sent)).toEqual({ imageId: "pan", surface: "planar", gainCompensation: false, straighten: false, bands: 3, members: ["a", "b"], lensCorrection: false, autoCrop: false });
});
