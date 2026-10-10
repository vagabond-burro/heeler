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
    expect(resolutionRatio(16.5, 9)?.label).toBe("1.833:1");
    for (const [w, h] of [[0, 1080], [1920, 0], [-5, 3], [Number.NaN, 2], [Infinity, 2]]) expect(resolutionRatio(w, h)).toBeNull();
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
    fireEvent.click(button);
    expect(screen.getByTestId("crop-calc-panel")).toBeInTheDocument();
    expect(button).toHaveAttribute("aria-pressed", "true");
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
    fireEvent.click(screen.getByTestId("crop-calc-save"));
    expect(onSaved).toHaveBeenLastCalledWith([{ name: "16:9", w: 1920, h: 1080 }]);

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
