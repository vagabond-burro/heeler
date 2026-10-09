import { it, expect } from "vitest";
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import expected from "./fixtures/tool-groups.json";
import { initialState } from "../data";
import { serializeGraph } from "../bridge";
import { sharpeningGroup, skinGroup } from "../recipes";

// The desktop's pixel contracts (src-tauri/src/groups_review.rs) render
// the fixture, so the fixture must be what the app serializes today.
// After a deliberate change to a recipe, regenerate it:
//   GEN_FIXTURE=1 npx vitest run review-fixture
it("serialized tool groups match the desktop pixel fixtures", () => {
  const s = initialState();
  const groups = [
    sharpeningGroup("review_sharpening", 0, 0, { enabled: true, mode: "vivid" }),
    sharpeningGroup("review_sharpening", 0, 0, { enabled: true, mode: "hipass" }),
    skinGroup("review_skin", 0, 0, { enabled: true }),
  ];
  const fixtures = Object.fromEntries(
    groups.map((g) => [
      g.tool === "skin" ? "skin" : g.textParams!.mode,
      serializeGraph({
        ...s,
        activeImage: "review_fixture",
        nodes: [s.nodes.find((n) => n.id === "src")!, g, s.nodes.find((n) => n.id === "output")!],
        wires: [
          { from: "src", to: g.id, toPort: "in", kind: "image" },
          { from: g.id, to: "output", toPort: "in", kind: "image" },
        ],
      }),
    ]),
  );
  if (process.env.GEN_FIXTURE) {
    writeFileSync(resolve(process.cwd(), "src/__tests__/fixtures/tool-groups.json"), JSON.stringify(fixtures, null, 2) + "\n");
  }
  expect(fixtures).toEqual(expected);
});
