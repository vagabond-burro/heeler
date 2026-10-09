import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
const guide = (name: string) => readFileSync(`../../docs/user-guide/graph/nodes/${name}.md`, "utf8");
it("distance guidance distinguishes discrete centers from a continuous outline", () => {
  expect(guide("masking")).toContain("nearest opposite pixel center");
  expect(guide("masking")).toContain("approximation at corners");
});
it("median guidance states the finite quantization range", () => {
  expect(guide("detail")).toContain("65536");
  expect(guide("detail")).toContain("Negative values share the lowest bin");
});
it("release copy does not promise a continuous exact distance", () => {
  const notes = readFileSync("../../docs/whats-new.md", "utf8");
  expect(notes).not.toContain("turns a mask into the exact distance from its edge");
});

// Stage 2 of the graph review: a first sentence says what the node is for.
it("Alpha Association opens with what it is used for, not what it is", () => {
  const utility = guide("utility");
  expect(utility).not.toContain("What a picture's transparency is, and how its color relates to it.");
  expect(utility).toMatch(/## Alpha Association[^\n]*\n\n(Takes a picture's transparency out as a field|[^\n]*premultiplies)/);
});
