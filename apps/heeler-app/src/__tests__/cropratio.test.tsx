// The crop tool's ratio bar (2026-10-07: "It's all crammed in,
// small, hard to read. The dropdown I don't think uses the same font
// sizes as rest of the dropdowns. I think the X:Y should be two
// separate fields [ x ] : [ y ]").
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { CropRatioBar, ratioPair } from "../ui/cropratio";
import { choose, menuRows, menuValue } from "./menuhelp";

const bar = (aspect: number | null, onRatio = vi.fn()) => {
  const view = render(<CropRatioBar aspect={aspect} original={6024 / 4016} onRatio={onRatio} />);
  return { ...view, onRatio, w: screen.getByTestId("crop-aspect-w") as HTMLInputElement, h: screen.getByTestId("crop-aspect-h") as HTMLInputElement };
};

describe("ratioPair", () => {
  it("shows a preset's own numbers, the smallest whole pair, or the ratio to 1", () => {
    expect(ratioPair(null)).toEqual(["", ""]);
    expect(ratioPair(1.5)).toEqual(["3", "2"]);
    expect(ratioPair(9 / 16)).toEqual(["9", "16"]);
    expect(ratioPair(6024 / 4016)).toEqual(["3", "2"]);
    expect(ratioPair(7 / 5)).toEqual(["7", "5"]);
    expect(ratioPair(2.39)).toEqual(["2.39", "1"]);
  });
});

describe("the crop ratio bar", () => {
  it("is the panels' regular dropdown, with an 11px label and two 11px fields", () => {
    const { w, h } = bar(null);
    const menu = screen.getByTestId("crop-aspect");
    expect(menu.style.fontSize).toBe("11px");
    expect(menu.style.padding).toBe("3px 7px 3px 9px");
    expect(screen.getByText("CROP").style.fontSize).toBe("11px");
    for (const field of [w, h]) expect(field.style.fontSize).toBe("11px");
    expect(screen.getByText(":")).toBeInTheDocument();
  });

  it("fills the fields with the ratio in force and empties them for Free", () => {
    const { w, h, rerender, onRatio } = bar(1.5);
    expect([w.value, h.value]).toEqual(["3", "2"]);
    rerender(<CropRatioBar aspect={null} original={1.5} onRatio={onRatio} />);
    expect([w.value, h.value]).toEqual(["", ""]);
  });

  it("applies a typed pair on Enter, and a typo or half a pair not at all", () => {
    const { w, h, onRatio } = bar(null);
    fireEvent.change(w, { target: { value: "5" } });
    fireEvent.keyDown(w, { key: "Enter" });
    expect(onRatio).not.toHaveBeenCalled();
    fireEvent.change(h, { target: { value: "wide" } });
    expect(h.value, "letters never get into the field").toBe("");
    fireEvent.keyDown(h, { key: "Enter" });
    expect(onRatio).not.toHaveBeenCalled();
    fireEvent.change(h, { target: { value: "0" } });
    fireEvent.keyDown(h, { key: "Enter" });
    expect(onRatio).not.toHaveBeenCalled();
    fireEvent.change(h, { target: { value: "7" } });
    fireEvent.keyDown(h, { key: "Enter" });
    expect(onRatio).toHaveBeenCalledWith(5 / 7);
  });

  it("applies when focus leaves the pair, not when it moves from width to height", () => {
    const { w, h, onRatio } = bar(null);
    fireEvent.change(w, { target: { value: "65" } });
    fireEvent.change(h, { target: { value: "24" } });
    fireEvent.blur(w, { relatedTarget: h });
    expect(onRatio).not.toHaveBeenCalled();
    fireEvent.blur(h, { relatedTarget: document.body });
    expect(onRatio).toHaveBeenCalledWith(65 / 24);
  });

  it("keeps the crop tool's keys to itself, and Escape puts the fields back", () => {
    const outside = vi.fn();
    window.addEventListener("keydown", outside);
    const { w, onRatio } = bar(1.5);
    fireEvent.change(w, { target: { value: "16" } });
    fireEvent.keyDown(w, { key: "Escape" });
    expect(w.value).toBe("3");
    fireEvent.keyDown(w, { key: "Enter" });
    expect(outside).not.toHaveBeenCalled();
    // The ratio in force, re-entered, is not a change.
    expect(onRatio).not.toHaveBeenCalled();
    window.removeEventListener("keydown", outside);
  });

  it("offers Free, Original and the shared presets, and a typed ratio reads as custom", () => {
    const { onRatio } = bar(5 / 7);
    const menu = screen.getByTestId("crop-aspect");
    expect(menuValue(menu)).toBe("custom");
    const labels = menuRows(menu).map(([, label]) => label);
    expect(labels.slice(0, 3)).toEqual(["Free", "Original", "1:1"]);
    choose(menu, String(labels.indexOf("16:9")));
    expect(onRatio).toHaveBeenCalledWith(16 / 9);
  });

  it("names a preset before Original when the photograph has that ratio", () => {
    render(<CropRatioBar aspect={1.5} original={1.5} onRatio={() => {}} />);
    const menu = screen.getByTestId("crop-aspect");
    expect(new Map(menuRows(menu)).get(menuValue(menu))).toBe("3:2");
  });

  it("names Original for a ratio no preset has", () => {
    render(<CropRatioBar aspect={1.6} original={1.6} onRatio={() => {}} />);
    const menu = screen.getByTestId("crop-aspect");
    expect(new Map(menuRows(menu)).get(menuValue(menu))).toBe("Original");
  });
});
