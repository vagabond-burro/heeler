// Preferences > Models (2026-10-29): "replace the labels for INSTALL
// and REMOVE with icons. Also, show a summary of the total size of
// installed models. Also, below the models list, ... a section that
// briefly explains what each model is for".

import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { initialState } from "../data";
import { reduce, type Command } from "../state";
import { Preferences } from "../ui/preferences";
import { MODEL_USES, modelBytes } from "../ui/preferencesparts";

const status = (id: string, label: string, bytes: number, installed: boolean) => ({
  id, label, bytes, installed, license: "MIT", url: `https://example.test/${id}`, version: "1",
});
vi.mock("../bridge", async (importOriginal) => {
  const real = await importOriginal<typeof import("../bridge")>();
  return {
    ...real,
    smartModelStatus: vi.fn(async () => ({
      sam: status("sam2_1_hiera_tiny", "Segment Anything 2.1 (Tiny)", 155_610_424, true),
      matte: status("birefnet_dynamic", "BiRefNet dynamic (subject matte)", 972_495_971, true),
      fill: status("lama", "LaMa (inpainting)", 208_044_816, false),
      refine: status("vitmatte", "ViTMatte (edge refinement)", 103_885_865, false),
      depth: status("depth_anything_v2_small", "Depth Anything V2 Small (scene depth)", 99_060_839, true),
      normals: status("moge_2_vits_normal", "MoGe-2 ViT-S (surface normals)", 140_852_051, false),
      denoise: status("scunet_color_real_psnr", "SCUNet (noise reduction)", 76_936_854, false),
    })),
  };
});

const openModels = () => {
  const sent: Command[] = [];
  render(<Preferences state={reduce(initialState(), { type: "open_prefs" })} dispatch={((c: Command) => sent.push(c)) as never} />);
  fireEvent.click(screen.getByTestId("prefs-tab-models"));
  return sent;
};

describe("Preferences > Models", () => {
  it("installs and removes from icons that say which model in their names", async () => {
    openModels();
    const remove = await screen.findByTestId("prefs-model-remove-birefnet_dynamic");
    expect(remove.textContent).toBe("");
    expect(remove.querySelector("svg")).not.toBeNull();
    expect(remove).toHaveAttribute("aria-label", "Remove BiRefNet dynamic (subject matte)");
    // The remove hint names what waits for the model again.
    expect(remove.getAttribute("data-hint")).toContain("View depth fitted to the subject");
    const install = screen.getByTestId("prefs-model-install-lama");
    expect(install.textContent).toBe("");
    expect(install).toHaveAttribute("aria-label", "Install LaMa (inpainting)");
    // The icon still opens the consent card first.
    fireEvent.click(install);
    expect(screen.getByTestId("prefs-install-lama-consent")).toBeInTheDocument();
  });

  it("sums the installed models under the table", async () => {
    openModels();
    const total = await screen.findByTestId("prefs-models-total");
    // 155.6 + 972.5 + 99.1 MB.
    expect(total.textContent).toBe("3 of 7 installed · 1.2 GB on disk");
    expect(modelBytes(99_060_839)).toBe("99 MB");
    expect(modelBytes(972_495_971)).toBe("972 MB");
    expect(modelBytes(1_227_167_234)).toBe("1.2 GB");
  });

  it("says what each listed model is for, below the table", async () => {
    openModels();
    await screen.findByTestId("prefs-models-total");
    const uses = screen.getByTestId("prefs-model-uses");
    for (const id of ["sam2_1_hiera_tiny", "birefnet_dynamic", "lama", "vitmatte", "depth_anything_v2_small", "moge_2_vits_normal", "scunet_color_real_psnr"]) {
      expect(within(uses).getByTestId(`prefs-model-use-${id}`).textContent).toBe(MODEL_USES[id]);
    }
    // Only the models the table lists.
    expect(within(uses).queryByTestId("prefs-model-use-florence_2_base")).toBeNull();
    expect(within(uses).getByText("Depth Anything V2 Small")).toBeInTheDocument();
    // The table comes first.
    const table = screen.getByRole("table", { name: "Downloaded models" });
    expect(table.compareDocumentPosition(uses) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("has a use for every model the desktop can list", () => {
    for (const id of ["sam2_1_hiera_tiny", "mobile_sam", "birefnet_dynamic", "birefnet_lite", "lama", "vitmatte", "depth_anything_v2_small", "depth_anything_3_mono_large", "moge_2_vits_normal", "scunet_color_real_psnr", "florence_2_base"]) {
      expect(MODEL_USES[id], id).toMatch(/\.$/);
    }
  });
});
