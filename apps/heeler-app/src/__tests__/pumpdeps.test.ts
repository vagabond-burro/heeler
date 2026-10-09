import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

/** The render pump re-renders the frame when one of the fields in its
 * wake object changes. previewTarget decides WHAT the frame shows from
 * session fields, so every field it reads must be in that object, or a
 * view's dial changes the target and nothing re-renders (2026-09-15:
 * "Tolerance slider doesn't change anything"). Read off the sources,
 * so a field added to one and not the other fails here.*/
describe("the render pump wakes on everything previewTarget reads", () => {
  it("lists every session field the target selector touches", () => {
    const state = readFileSync(resolve(process.cwd(), "src/state.ts"), "utf8");
    const app = readFileSync(resolve(process.cwd(), "src/app.tsx"), "utf8");
    // previewTarget and the helpers it calls on the state.
    const fns = ["export function previewTarget(", "function collisionSuffix("];
    const reads = new Set<string>();
    for (const head of fns) {
      const at = state.indexOf(head);
      expect(at, head).toBeGreaterThan(-1);
      const body = state.slice(at, state.indexOf("\n}\n", at));
      for (const m of body.matchAll(/\bs\.([a-zA-Z_]+)/g)) reads.add(m[1]);
    }
    const wakeAt = app.indexOf("const wake: Record<string, unknown> = {");
    expect(wakeAt).toBeGreaterThan(-1);
    const wake = app.slice(wakeAt, app.indexOf("};", wakeAt));
    for (const field of reads) {
      expect(wake, `pump wakes on ${field}`).toMatch(new RegExp(`\\b${field}:`));
    }
    expect(reads.has("collisionTolerance")).toBe(true);
  });
});
