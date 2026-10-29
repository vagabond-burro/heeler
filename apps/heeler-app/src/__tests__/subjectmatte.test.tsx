// BiRefNet dynamic as the subject matte (2026.7): it is the model
// Preferences offers and the matte status names, while Lite, the
// earlier matte, still answers Subject where it is the one on disk and
// is listed only while it is there, to be removed, never offered.

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { initialState } from "../data";
import { reduce, type Command } from "../state";
import { Preferences } from "../ui/preferences";
import { smartModelMissing } from "../ui/smartnodeparts";
import type { SmartModels } from "../bridge";

let liteInstalled = false;
let dynamicInstalled = false;
const model = (id: string, installed: boolean, label = id, bytes = 1) => ({
  id, installed, label, license: "MIT", url: "https://example.test/m", bytes, version: "1",
});
const status = (): SmartModels => ({
  sam: model("mobile_sam", false),
  matte: model("birefnet_dynamic", dynamicInstalled, "BiRefNet dynamic (subject matte)", 972_495_971),
  lite: model("birefnet_lite", liteInstalled, "BiRefNet Lite (subject matte)", 224_005_088),
  fill: model("lama", false),
  refine: model("vitmatte", false),
  depth: model("depth_anything_v2_small", false),
  denoise: model("scunet_color_real_psnr", false),
  florence: model("florence_2_base", false),
});

vi.mock("../bridge", async (importOriginal) => {
  const real = await importOriginal<typeof import("../bridge")>();
  return { ...real, smartModelStatus: vi.fn(async () => status()) };
});

afterEach(() => {
  cleanup();
  liteInstalled = false;
  dynamicInstalled = false;
});

function openModels() {
  const state = reduce(initialState(), { type: "open_prefs" });
  render(<Preferences state={state} dispatch={((_: Command) => {}) as never} />);
  fireEvent.click(screen.getByTestId("prefs-tab-models"));
}

describe("the subject matte in Preferences", () => {
  it("offers BiRefNet dynamic with its size, and never offers Lite", async () => {
    openModels();
    const install = await screen.findByTestId("prefs-model-install-birefnet_dynamic");
    expect(screen.getByTestId("prefs-model-birefnet_dynamic")).toHaveTextContent("BiRefNet dynamic (subject matte)");
    expect(screen.queryByTestId("prefs-model-birefnet_lite")).toBeNull();
    fireEvent.click(install);
    expect(screen.getByTestId("prefs-install-birefnet_dynamic-consent").textContent).toContain("972 MB");
  });

  it("lists Lite while it is on disk, with REMOVE and no INSTALL", async () => {
    liteInstalled = true;
    openModels();
    await screen.findByTestId("prefs-model-remove-birefnet_lite");
    expect(screen.queryByTestId("prefs-model-install-birefnet_lite")).toBeNull();
    expect(screen.getByTestId("prefs-model-install-birefnet_dynamic")).toBeInTheDocument();
  });
});

describe("the Subject mode's model", () => {
  it("is not missing while either matte is installed, even without SAM", () => {
    expect(smartModelMissing(status(), "subject")).toBe(true);
    liteInstalled = true;
    expect(smartModelMissing(status(), "subject")).toBe(false);
    expect(smartModelMissing(status(), "sky")).toBe(true);
    liteInstalled = false;
    dynamicInstalled = true;
    expect(smartModelMissing(status(), "subject")).toBe(false);
    expect(smartModelMissing(status(), "subject", "mobile_sam")).toBe(true);
    expect(smartModelMissing(status(), "subject", "mobile_sam+vitmatte")).toBe(true);
    expect(smartModelMissing(status(), "subject", "birefnet_lite+vitmatte")).toBe(false);
    // A desktop older than dynamic answers without a lite entry.
    const older = { ...status(), lite: undefined, matte: model("birefnet_lite", false) };
    expect(smartModelMissing(older, "subject")).toBe(true);
  });
});
