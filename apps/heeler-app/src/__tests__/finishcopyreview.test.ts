import { expect, it } from "vitest";
import news from "../../../../docs/whats-new.md?raw";
import imageGuide from "../../../../docs/user-guide/finish/image-layer.md?raw";
import warpGuide from "../../../../docs/user-guide/finish/warp-layer.md?raw";
import "../app";
import { toolbarWraps } from "../ui/finishnew";
import { MASK_EXPORT_HINT } from "../ui/exporttick";

it("the toolbar copy describes the narrow-panel wrap the layout uses", () => {
  expect(toolbarWraps(160, 120, 65)).toBe(true);
  expect(news).not.toContain("The row keeps to one line at every app zoom.");
  expect(news).toMatch(/Group and Delete.*second row/);
});
it("both image-bake guides disclose the reduced-resolution fallback", () => {
  for (const guide of [imageGuide, warpGuide]) {
    expect(guide).toMatch(/full-size.*(?:decode|decoding).*memory/);
    expect(guide).toMatch(/preview-sized pixels/);
    expect(guide).toMatch(/Console/);
  }
});
it("the exported-mask hints include clipping, as the exported weight does", () => {
  expect(MASK_EXPORT_HINT.off).toMatch(/clipping/);
  expect(MASK_EXPORT_HINT.on).toMatch(/clipping/);
});
