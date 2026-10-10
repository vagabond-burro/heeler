// The crop bar's aspect ratio calculator (2026-10-09: "a button on the
// right side of the crop toolbar ... an icon of a calculator ... opens
// the 'aspect ratio calculator' where a user enters in a resolution and
// it calculates the aspect ratio. It has a button that will apply the
// aspect ratio to the crop. Users should be able to save custom aspect
// ratios").
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { App } from "../app";
import { CropRatioBar, resolutionRatio } from "../ui/cropratio";
import { CROP_RATIOS, CROP_RATIO_NAME_MAX, cropRatioList, reduce, savedCropRatios, type SavedCropRatio } from "../state";
import { initialState } from "../data";
import { uiSettingsCommands, uiSettingsSnapshot } from "../settings";
import { menuRows, menuValue } from "./menuhelp";

describe("resolutionRatio", () => {
  it("reduces a resolution to its lowest terms and gives the ratio", () => {
    expect(resolutionRatio(1920, 1080)).toEqual({ label: "16:9", ratio: 1920 / 1080 });
    expect(resolutionRatio(6000, 4000)?.label).toBe("3:2");
    expect(resolutionRatio(1080, 1920)?.label).toBe("9:16");
    expect(resolutionRatio(1366, 768)?.label).toBe("683:384");
    expect(resolutionRatio(4096, 4096)?.label).toBe("1:1");
  });

  it("reads sides that are not whole numbers as the ratio to 1, and refuses nonsense", () => {
    expect(resolutionRatio(2.39, 1)?.label).toBe("2.39:1");
    expect(resolutionRatio(16.5, 9)?.label).toBe("1.8333:1");
    // Four places, so a near-square decimal does not read as square.
    expect(resolutionRatio(1000.4, 1000)?.label).toBe("1.0004:1");
    for (const [w, h] of [[0, 1080], [1920, 0], [-5, 3], [Number.NaN, 2], [Infinity, 2]]) expect(resolutionRatio(w, h)).toBeNull();
    // Finite sides, but a ratio no crop can hold (1e308 over 1e-308 is
    // Infinity, which collapsed the crop to no height).
    for (const [w, h] of [[1e308, 1e-308], [1, 5000], [5000, 1]]) expect(resolutionRatio(w, h)).toBeNull();
    expect(resolutionRatio(1000, 1)?.label).toBe("1000:1");
  });
});

describe("saved crop ratios", () => {
  it("keep only named, positive, finite ratios, one per name, from a hand-edited file", () => {
    expect(savedCropRatios(undefined)).toEqual([]);
    expect(savedCropRatios("16:9")).toEqual([]);
    expect(
      savedCropRatios([
        { name: " HD ", w: 1920, h: 1080 },
        { name: "HD", w: 1, h: 1 },
        { name: "", w: 2, h: 1 },
        { name: "zero", w: 0, h: 1 },
        { name: "nan", w: Number.NaN, h: 1 },
        { name: "text", w: "4", h: 3 },
        null,
        { name: "x".repeat(50), w: 2, h: 1 },
        { name: "huge", w: 1e308, h: 1e-308 },
        { name: "16:9", w: 16, h: 9 },
        { name: "Original", w: 3, h: 2 },
        { name: "free", w: 3, h: 2 },
      ]),
    ).toEqual([
      { name: "HD", w: 1920, h: 1080 },
      { name: "x".repeat(CROP_RATIO_NAME_MAX), w: 2, h: 1 },
    ]);
  });

  it("follow the shipped ratios in the one list every menu offers", () => {
    const list = cropRatioList({ cropRatios: [{ name: "Cinema", w: 2.39, h: 1 }] });
    expect(list.slice(0, CROP_RATIOS.length)).toEqual(CROP_RATIOS);
    expect(list[CROP_RATIOS.length]).toEqual(["Cinema", 2.39]);
  });

  it("are a preference: set_prefs cleans them and the settings file carries them", () => {
    let s = reduce(initialState(), { type: "set_prefs", prefs: { cropRatios: [{ name: "HD", w: 1920, h: 1080 }, { name: "bad", w: -1, h: 1 }] as SavedCropRatio[] } });
    expect(s.prefs.cropRatios).toEqual([{ name: "HD", w: 1920, h: 1080 }]);
    const restored = uiSettingsCommands(JSON.stringify(uiSettingsSnapshot(s))).reduce(reduce, initialState());
    expect(restored.prefs.cropRatios).toEqual([{ name: "HD", w: 1920, h: 1080 }]);
    s = reduce(s, { type: "set_prefs", prefs: { paletteRecents: 12 } });
    expect(s.prefs.cropRatios).toEqual([{ name: "HD", w: 1920, h: 1080 }]);
  });
});

const calc = (saved: SavedCropRatio[] = [], resolution: [number, number] | null = [6024, 4016]) => {
  const onRatio = vi.fn();
  const onSaved = vi.fn();
  const view = render(<CropRatioBar aspect={null} original={1.5} onRatio={onRatio} resolution={resolution} saved={saved} onSaved={onSaved} />);
  return { ...view, onRatio, onSaved };
};
const type = (testid: string, value: string) => fireEvent.change(screen.getByTestId(testid), { target: { value } });

describe("the aspect ratio calculator", () => {
  it("sits at the right end of the crop bar behind a calculator button", () => {
    calc();
    const row = screen.getByTestId("crop-aspects");
    const button = screen.getByTestId("crop-calc");
    expect(row.lastElementChild).toContainElement(button);
    expect(button).toHaveAccessibleName("Aspect ratio calculator");
    expect(button.querySelector("svg")).not.toBeNull();
    expect(screen.queryByTestId("crop-calc-panel")).toBeNull();
    expect(button).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(button);
    expect(screen.getByTestId("crop-calc-panel")).toBeInTheDocument();
    expect(button).toHaveAttribute("aria-expanded", "true");
    expect(button).toHaveAttribute("aria-controls", screen.getByTestId("crop-calc-panel").id);
    expect(screen.getByTestId("crop-calc-result")).toHaveAttribute("aria-live", "polite");
    fireEvent.click(button);
    expect(screen.queryByTestId("crop-calc-panel")).toBeNull();
  });

  it("works out the ratio of a resolution and applies it to the crop", () => {
    const { onRatio } = calc();
    fireEvent.click(screen.getByTestId("crop-calc"));
    expect(screen.getByTestId("crop-calc-apply")).toBeDisabled();
    expect(screen.getByTestId("crop-calc-result")).toHaveTextContent("Enter a width and height");
    type("crop-calc-w", "1920");
    type("crop-calc-h", "1080");
    expect(screen.getByTestId("crop-calc-result")).toHaveTextContent("16:9");
    expect(screen.getByTestId("crop-calc-result")).toHaveTextContent("1.778:1");
    fireEvent.click(screen.getByTestId("crop-calc-apply"));
    expect(onRatio).toHaveBeenCalledWith(1920 / 1080);
    // Enter in a size field applies too.
    type("crop-calc-w", "1080");
    fireEvent.keyDown(screen.getByTestId("crop-calc-h"), { key: "Enter" });
    expect(onRatio).toHaveBeenLastCalledWith(1);
  });

  it("offers the photograph's own size", () => {
    calc();
    fireEvent.click(screen.getByTestId("crop-calc"));
    expect(screen.getByTestId("crop-calc-w")).toHaveAttribute("placeholder", "6024");
    fireEvent.click(screen.getByTestId("crop-calc-photo"));
    expect(screen.getByTestId("crop-calc-result")).toHaveTextContent("3:2");
  });

  it("saves a ratio under a name, or under its ratio when unnamed, and replaces one of the same name", () => {
    const { onSaved, rerender, onRatio } = calc();
    fireEvent.click(screen.getByTestId("crop-calc"));
    expect(screen.getByTestId("crop-calc-save")).toBeDisabled();
    type("crop-calc-w", "1920");
    type("crop-calc-h", "1080");
    type("crop-calc-name", "HD video");
    fireEvent.click(screen.getByTestId("crop-calc-save"));
    expect(onSaved).toHaveBeenLastCalledWith([{ name: "HD video", w: 1920, h: 1080 }]);
    expect(screen.getByTestId("crop-calc-name")).toHaveValue("");
    // Unnamed, a ratio a shipped label already offers is saved under its
    // size, not as a second 16:9.
    expect(screen.getByTestId("crop-calc-name")).toHaveAttribute("placeholder", "1920×1080");
    fireEvent.click(screen.getByTestId("crop-calc-save"));
    expect(onSaved).toHaveBeenLastCalledWith([{ name: "1920×1080", w: 1920, h: 1080 }]);
    // One no shipped label offers is saved under its ratio.
    type("crop-calc-w", "1366");
    type("crop-calc-h", "768");
    fireEvent.click(screen.getByTestId("crop-calc-save"));
    expect(onSaved).toHaveBeenLastCalledWith([{ name: "683:384", w: 1366, h: 768 }]);
    // The crop menus' own names are refused.
    for (const reserved of ["16:9", "Free", "original"]) {
      type("crop-calc-name", reserved);
      expect(screen.getByTestId("crop-calc-save"), reserved).toBeDisabled();
    }
    type("crop-calc-name", "");
    type("crop-calc-w", "1920");
    type("crop-calc-h", "1080");

    const saved = [{ name: "HD video", w: 1920, h: 1080 }];
    rerender(<CropRatioBar aspect={null} original={1.5} onRatio={onRatio} resolution={[6024, 4016]} saved={saved} onSaved={onSaved} />);
    type("crop-calc-w", "1280");
    type("crop-calc-h", "720");
    type("crop-calc-name", "HD video");
    expect(screen.getByTestId("crop-calc-save")).toHaveTextContent("Replace");
    fireEvent.keyDown(screen.getByTestId("crop-calc-name"), { key: "Enter" });
    expect(onSaved).toHaveBeenLastCalledWith([{ name: "HD video", w: 1280, h: 720 }]);
  });

  it("lists the saved ratios to apply or delete, and the crop menu offers them", () => {
    const saved = [{ name: "Cinema", w: 2.39, h: 1 }, { name: "Story", w: 1080, h: 1920 }];
    const { onRatio, onSaved } = calc(saved);
    fireEvent.click(screen.getByTestId("crop-calc"));
    const list = screen.getByTestId("crop-calc-saved");
    expect(within(list).getByTestId("crop-calc-saved-Story")).toHaveTextContent("1080 × 1920");
    fireEvent.click(within(list).getByTestId("crop-calc-saved-Story"));
    expect(onRatio).toHaveBeenCalledWith(1080 / 1920);
    fireEvent.click(within(list).getByTestId("crop-calc-delete-Cinema"));
    expect(onSaved).toHaveBeenCalledWith([{ name: "Story", w: 1080, h: 1920 }]);
    const labels = menuRows(screen.getByTestId("crop-aspect")).map(([, label]) => label);
    expect(labels.slice(-2)).toEqual(["Cinema", "Story"]);
  });

  it("keeps its typing from the crop tool's Enter and Escape, and Escape closes it", () => {
    calc();
    const outside = vi.fn();
    window.addEventListener("keydown", outside);
    fireEvent.click(screen.getByTestId("crop-calc"));
    type("crop-calc-w", "1920");
    fireEvent.keyDown(screen.getByTestId("crop-calc-w"), { key: "Enter" });
    fireEvent.keyDown(screen.getByTestId("crop-calc-name"), { key: "a" });
    expect(outside).not.toHaveBeenCalled();
    // Escape closes the panel and reaches nothing else (the app's Cancel
    // Tool, which put the crop away with it), from a field or a button.
    fireEvent.keyDown(screen.getByTestId("crop-calc-w"), { key: "Escape" });
    expect(screen.queryByTestId("crop-calc-panel")).toBeNull();
    fireEvent.click(screen.getByTestId("crop-calc"));
    fireEvent.keyDown(screen.getByTestId("crop-calc-apply"), { key: "Escape" });
    expect(screen.queryByTestId("crop-calc-panel")).toBeNull();
    expect(outside).not.toHaveBeenCalled();
    window.removeEventListener("keydown", outside);
  });

  it("Escape closes it from anywhere, not only from inside, and gives focus back to its button", () => {
    // On the Mac a clicked button does not take focus, so after opening
    // the panel by click the key arrives at the page, not the panel; the
    // app's Cancel Tool then put the crop away (the 26.5.1 review).
    calc();
    const outside = vi.fn();
    window.addEventListener("keydown", outside);
    fireEvent.click(screen.getByTestId("crop-calc"));
    (document.activeElement as HTMLElement | null)?.blur();
    fireEvent.keyDown(document.body, { key: "Escape" });
    expect(screen.queryByTestId("crop-calc-panel")).toBeNull();
    expect(outside).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(screen.getByTestId("crop-calc"));
    // Closed, Escape is the app's again.
    fireEvent.keyDown(document.body, { key: "Escape" });
    expect(outside).toHaveBeenCalledTimes(1);
    window.removeEventListener("keydown", outside);
  });

  it("takes only numbers in its size fields and the crop bar's W:H fields", () => {
    calc();
    fireEvent.click(screen.getByTestId("crop-calc"));
    for (const id of ["crop-calc-w", "crop-calc-h", "crop-aspect-w", "crop-aspect-h"]) {
      type(id, "12");
      for (const bad of ["12a", "wide", "1.2.3", "-4", "1e5", "12 "]) {
        type(id, bad);
        expect(screen.getByTestId(id), `${id}: ${bad}`).toHaveValue("12");
      }
      type(id, "12.5");
      expect(screen.getByTestId(id)).toHaveValue("12.5");
      type(id, "");
      expect(screen.getByTestId(id)).toHaveValue("");
    }
  });

  it("keeps a saved ratio near a preset as itself, not as the preset", () => {
    // 683:384 is within 0.001 of 16:9: it read as 16:9, and leaving the
    // W:H fields put 16:9 back (the 26.5.1 review).
    const onRatio = vi.fn();
    const saved = [{ name: "1366", w: 1366, h: 768 }];
    render(<CropRatioBar aspect={1366 / 768} original={1.5} onRatio={onRatio} saved={saved} onSaved={() => {}} />);
    const select = screen.getByTestId("crop-aspect");
    expect(new Map(menuRows(select)).get(menuValue(select))).toBe("1366");
    expect(screen.getByTestId("crop-aspect-w")).toHaveValue("683");
    expect(screen.getByTestId("crop-aspect-h")).toHaveValue("384");
    fireEvent.blur(screen.getByTestId("crop-aspect-h"));
    expect(onRatio).not.toHaveBeenCalled();
  });

  it("closes when the pointer goes down outside it", () => {
    calc();
    fireEvent.click(screen.getByTestId("crop-calc"));
    fireEvent.mouseDown(document.body);
    expect(screen.queryByTestId("crop-calc-panel")).toBeNull();
  });
});

describe("in the app", () => {
  it("a ratio saved in the calculator holds the crop and joins Photo > Crop to Aspect Ratio", async () => {
    const user = userEvent.setup();
    render(<App />);
    await user.click(screen.getByTestId("menu-photo"));
    fireEvent.mouseEnter(screen.getByTestId("menu-photo-crop").parentElement!);
    await user.click(screen.getByTestId("menu-photo-cropinit"));
    await user.click(screen.getByTestId("crop-calc"));
    await user.type(screen.getByTestId("crop-calc-w"), "2048");
    await user.type(screen.getByTestId("crop-calc-h"), "858");
    await user.type(screen.getByTestId("crop-calc-name"), "Scope");
    await user.click(screen.getByTestId("crop-calc-save"));
    await user.click(screen.getByTestId("crop-calc-apply"));
    const select = screen.getByTestId("crop-aspect");
    expect(new Map(menuRows(select)).get(menuValue(select))).toBe("Scope");

    await user.click(screen.getByTestId("menu-photo"));
    fireEvent.mouseEnter(screen.getByTestId("menu-photo-crop").parentElement!);
    fireEvent.mouseEnter(screen.getByTestId("menu-photo-aspect").parentElement!);
    expect(screen.getByTestId("menu-photo-aspect-saved-0")).toHaveTextContent("Scope");
  });

  it("Escape in the calculator closes it and leaves the crop tool up", async () => {
    const user = userEvent.setup();
    render(<App />);
    await user.click(screen.getByTestId("menu-photo"));
    fireEvent.mouseEnter(screen.getByTestId("menu-photo-crop").parentElement!);
    await user.click(screen.getByTestId("menu-photo-cropinit"));
    await user.click(screen.getByTestId("crop-calc"));
    await user.type(screen.getByTestId("crop-calc-w"), "1920");
    await user.type(screen.getByTestId("crop-calc-h"), "1080");
    // From a button, where the shortcuts do listen (a text field is
    // typing, which they leave alone): Apply, then Escape, as found.
    await user.click(screen.getByTestId("crop-calc-apply"));
    await user.keyboard("{Escape}");
    expect(screen.queryByTestId("crop-calc-panel")).toBeNull();
    expect(screen.getByTestId("crop-overlay")).toBeInTheDocument();
    // With the panel shut, Escape is Cancel Tool again.
    await user.click(screen.getByTestId("crop-calc"));
    await user.click(screen.getByTestId("crop-calc"));
    await user.keyboard("{Escape}");
    expect(screen.queryByTestId("crop-overlay")).toBeNull();
  });
});
