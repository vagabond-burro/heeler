import { expect, it } from "vitest";
import news from "../../../../docs/whats-new.md?raw";
import guide from "../../../../docs/user-guide/finish/masks-selections.md?raw";
import { fitAnts } from "../ui/maskants";

it("the copy qualifies the ants' distance bound when the display budget coarsens it", () => {
  const loop: [number, number][] = Array.from({ length: 256 }, (_, i) => {
    const a = i * Math.PI / 128;
    return [0.5 + 0.4 * Math.cos(a), 0.5 + 0.4 * Math.sin(a)];
  });
  expect(fitAnts([loop], 2048, 2048, 8).eps).toBeGreaterThan(1 / 3);
  expect(news).toMatch(/normally within a third of a working-mask pixel/);
  expect(news).toMatch(/display budget/);
  expect(guide).toMatch(/display budget/);
  expect(guide).toMatch(/at 1:1, the photograph's own/);
  expect(guide).toMatch(/outside the painted area and the Reach corridor/);
});
