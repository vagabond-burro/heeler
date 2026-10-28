// The film crops as built-in ratios: 1.85, 2.00, 2.35, 2.39,
// 2.40, 2.50 and 2.76, named by their decimals, in a group of their own
// in the crop bar and the Photo menu, with a swap for the portrait form.
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { CropRatioBar } from "../ui/cropratio";
import { ratioLabel, ratioPair } from "../ui/cropratioparts";
import { initialState, NEUTRAL_NODES, NEUTRAL_WIRES } from "../data";
import { cropIsInside, cropRectOf } from "../cropfit";
import { noteSourceSize } from "../framemap";
import { CINEMA_FROM, CINEMA_RATIOS, CROP_RATIOS, cropNode, cropRatioNameReserved, fitCropToAspect, keepCropInside, reduce, type State } from "../state";
import { menuRows } from "./menuhelp";

const FILM = ["1.85", "2.00", "2.35", "2.39", "2.40", "2.50", "2.76"];

describe("the film crops", () => {
  it("are shipped ratios, after the common ones, named by their decimals", () => {
    expect(CINEMA_RATIOS.map(([label]) => label)).toEqual(FILM);
    expect(CROP_RATIOS.slice(CINEMA_FROM)).toEqual(CINEMA_RATIOS);
    for (const [label, ratio] of CINEMA_RATIOS) expect(ratio).toBe(Number(label));
    expect(cropRatioNameReserved("2.39")).toBe(true);
  });

  it("hold the crop exactly: 2.39 is 2.39 wide to 1 high within a pixel", () => {
    const dims = { w: 6000, h: 4000 };
    for (const [, ratio] of CINEMA_RATIOS) {
      const fit = fitCropToAspect({ crop_x: 0, crop_y: 0, crop_w: 1, crop_h: 1 }, ratio, dims)!;
      const [w, h] = [Math.round(fit.crop_w * dims.w), Math.round(fit.crop_h * dims.h)];
      expect(Math.abs(w - ratio * h), `${ratio}: ${w}x${h}`).toBeLessThanOrEqual(ratio);
    }
  });

  it("read as their decimal to 1 in the fields and on the crop, and on their side as 1 to it", () => {
    expect(ratioPair(2.39)).toEqual(["2.39", "1"]);
    expect(ratioPair(2)).toEqual(["2.00", "1"]);
    expect(ratioPair(1 / 2.39)).toEqual(["1", "2.39"]);
    expect(ratioLabel(2.39)).toBe("2.39");
    expect(ratioLabel(2)).toBe("2.00");
    expect(ratioLabel(1 / 2.76)).toBe("1:2.76");
    expect(ratioLabel(1.5)).toBe("3:2");
    expect(ratioLabel(null)).toBeNull();
    expect(ratioLabel(1366 / 768, [{ name: "Laptop", w: 1366, h: 768 }])).toBe("Laptop");
  });
});

describe("the crop bar", () => {
  it("lists the film crops under a rule of their own, and the saved ratios under another", () => {
    render(<CropRatioBar aspect={null} original={1.5} onRatio={() => {}} saved={[{ name: "Laptop", w: 1366, h: 768 }]} />);
    const menu = screen.getByTestId("crop-aspect");
    const labels = menuRows(menu).map(([, label]) => label);
    for (const label of FILM) expect(labels).toContain(label);
    fireEvent.click(menu);
    const list = screen.getByTestId("crop-aspect-menu");
    const row = within(list).getByTestId(`crop-aspect-option-${labels.indexOf("1.85")}`);
    expect(row.previousElementSibling?.getAttribute("aria-hidden")).toBe("true");
    const saved = within(list).getByTestId(`crop-aspect-option-${labels.indexOf("Laptop")}`);
    expect(saved.previousElementSibling?.getAttribute("aria-hidden")).toBe("true");
    const common = within(list).getByTestId(`crop-aspect-option-${labels.indexOf("3:2")}`);
    expect(common.previousElementSibling?.getAttribute("role")).toBe("option");
  });

  it("swaps a held ratio to its other side, and has nothing to swap when free or square", () => {
    const onRatio = vi.fn();
    const { rerender } = render(<CropRatioBar aspect={2.39} original={1.5} onRatio={onRatio} />);
    fireEvent.click(screen.getByTestId("crop-aspect-swap"));
    expect(onRatio).toHaveBeenCalledWith(1 / 2.39);
    rerender(<CropRatioBar aspect={1 / 2.39} original={1.5} onRatio={onRatio} />);
    fireEvent.click(screen.getByTestId("crop-aspect-swap"));
    expect(onRatio).toHaveBeenLastCalledWith(2.39);
    rerender(<CropRatioBar aspect={null} original={1.5} onRatio={onRatio} />);
    expect(screen.getByTestId("crop-aspect-swap")).toBeDisabled();
    rerender(<CropRatioBar aspect={1} original={1.5} onRatio={onRatio} />);
    expect(screen.getByTestId("crop-aspect-swap")).toBeDisabled();
  });
});

describe("a ratio chosen on a straightened picture", () => {
  const ID = "cinemaratios_photo";
  noteSourceSize(ID, 6000, 4000);
  const at = (stay: boolean, angle: number): State => {
    const base = initialState();
    const s: State = { ...base, activeImage: ID, nodes: structuredClone(NEUTRAL_NODES), wires: structuredClone(NEUTRAL_WIRES), prefs: { ...base.prefs, cropStayInside: stay } };
    return reduce(s, { type: "set_param", id: cropNode(s).id, param: "angle", value: angle });
  };

  it("stays on the picture with Stay inside: an upright 1:2.39 is the largest of that ratio there", () => {
    const s = at(true, 12);
    const crop = cropRectOf(cropNode(s).params);
    const fit = fitCropToAspect(crop, 1 / 2.39, { w: 6000, h: 4000 })!;
    const proposed = { ...crop, ...fit };
    expect(cropIsInside(proposed, 1.5, 12)).toBe(false);
    const held = keepCropInside(s, proposed);
    expect(cropIsInside(held, 1.5, 12)).toBe(true);
    expect((held.crop_w * 1.5) / held.crop_h).toBeCloseTo(1 / 2.39, 9);
  });

  it("goes where the ratio puts it with the setting off", () => {
    const s = at(false, 12);
    const crop = cropRectOf(cropNode(s).params);
    const proposed = { ...crop, ...fitCropToAspect(crop, 1 / 2.39, { w: 6000, h: 4000 })! };
    expect(keepCropInside(s, proposed)).toEqual(proposed);
  });
});
