// 2026-09-29: "the 6 buttons in smart adjustment layers don't scale down
// well when the app window scale is 150% and the adjustment view is
// horizontally scaled down. replace all 6 button labels with icons, that
// should reduce their horizontal width".
//
// jsdom lays nothing out, so the one-line promise is pinned by
// construction: every button states its own square size inline, and the
// row's width follows from those sizes, the groups' borders and the gaps
// (the .zoom-seg gap read from theme.css itself). Measured in the browser
// build (offsetWidth, the zoom-safe reading): the words made the two sets
// 140 and 181 px wide, which wrapped at every panel width up to 320 (the row gets 289 there); the
// pictures make them 66 and 73 px, one line in the 229 px the row gets
// at the Develop panel's minimum, at 115 and at 150 percent alike (the
// panel's width is in the zoomed space, so the zoom does not change it).

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { initialState } from "../data";
import { reduce, type Command, type State } from "../state";
import { SmartModePanel } from "../ui/smarttool";

vi.mock("../bridge", async (importOriginal) => {
  const real = await importOriginal<typeof import("../bridge")>();
  return { ...real, smartModelStatus: vi.fn(async () => null) };
});

afterEach(() => cleanup());

const run = (s: State, ...cmds: Command[]) => cmds.reduce(reduce, s);

const SIX = [
  ["smart-mode-click", "Click", "click"],
  ["smart-mode-subject", "Subject", "subject"],
  ["smart-mode-sky", "Sky", "sky"],
  ["smart-matte", "Refine", "refine"],
  ["smart-remove", "Remove", "remove"],
  ["smart-to-mask", "To Mask", "toMask"],
] as const;

/** What the Smart mask row gets at the Develop panel's minimum: the
 * panel less the section's side padding and the scroll gutter, 31 px
 * measured in the browser build (row 229 px in a 260 px panel). */
const ROW_INSET = 31;

async function renderPanel() {
  const s = run(initialState(), { type: "add_layer", maskType: "smart" });
  render(<SmartModePanel state={s} dispatch={() => {}} />);
  await waitFor(() => screen.getByTestId("smart-modes"));
}

describe("the smart mask's six buttons", () => {
  it("are pictures named for a screen reader and the status line", async () => {
    await renderPanel();
    for (const [testid, name, icon] of SIX) {
      const b = screen.getByTestId(testid);
      // A picture and no words.
      expect(b.querySelector(`svg[data-testid="smart-icon-${icon}"]`)).not.toBeNull();
      expect(b.textContent).toBe("");
      // The name stays: for a screen reader, the cursor tip, and first
      // in the hint, then the outcome.
      expect(b.getAttribute("aria-label")).toBe(name);
      expect(screen.getByRole("button", { name })).toBe(b);
      expect(b.getAttribute("data-tip")).toBe(name);
      expect(b.getAttribute("data-hint")!.startsWith(`${name}: `)).toBe(true);
      expect(b.getAttribute("data-hint")!.length).toBeGreaterThan(name.length + 12);
      // The picture is decoration; the button carries the name.
      expect(b.querySelector("svg")!.getAttribute("aria-hidden")).toBe("true");
    }
  });

  it("share one square size, the modes at the left and the actions at the right edge", async () => {
    await renderPanel();
    const buttons = SIX.map(([id]) => screen.getByTestId(id));
    const style = buttons[0].getAttribute("style");
    for (const b of buttons) {
      expect(b.getAttribute("style")).toBe(style);
      expect(b.style.width).toBe(b.style.height);
      expect(parseFloat(b.style.width)).toBeGreaterThan(0);
      expect(b.style.padding).toBe("0px");
    }
    const modes = screen.getByRole("group", { name: "Smart selection mode" });
    const actions = screen.getByTestId("smart-actions");
    for (const b of buttons.slice(0, 3)) expect(modes.contains(b)).toBe(true);
    for (const b of buttons.slice(3)) {
      expect(actions.contains(b)).toBe(true);
      expect(modes.contains(b)).toBe(false);
    }
    expect(actions.style.marginLeft).toBe("auto");
  });

  it("fit one line at the Develop panel's minimum width, and wrap whole rather than shrink", async () => {
    // The narrowest the Develop panel goes: a drag to zero clamps there.
    const narrow = run(initialState(), { type: "set_panel_size", panel: "right", size: 0 }).panelSizes.right;
    expect(narrow).toBeLessThan(300);
    await renderPanel();
    const css = readFileSync(resolve(process.cwd(), "src/theme.css"), "utf8");
    const segGap = parseFloat(/\.zoom-seg \{[^}]*gap: ([\d.]+)px/.exec(css)![1]);
    const px = (v: string) => parseFloat(v);
    const border = (el: HTMLElement) => px(/(\d+)px/.exec(el.style.border)?.[1] ?? "0");
    const row = screen.getByTestId("smart-modes");
    const modes = screen.getByRole("group", { name: "Smart selection mode" });
    const actions = screen.getByTestId("smart-actions");
    const widthOf = (id: string) => px(screen.getByTestId(id).style.width);

    // Each mode and each action is its own one-button group, 4 px
    // apart, and Clear rides with the actions.
    const groupW = (ids: string[], gap: number) =>
      ids.reduce((w, id) => w + widthOf(id) + 2 * border(screen.getByTestId(id).parentElement!), 0) +
      (ids.length - 1) * gap;
    expect(segGap).toBeGreaterThanOrEqual(0);
    const modesW = groupW(SIX.slice(0, 3).map(([id]) => id), px(modes.style.gap));
    const actionsW = groupW([...SIX.slice(3).map(([id]) => id), "smart-clear"], px(actions.style.gap));
    const oneLine = modesW + px(row.style.gap) + actionsW;
    expect(Number.isFinite(oneLine)).toBe(true);
    expect(oneLine).toBeLessThanOrEqual(narrow - ROW_INSET);
    // Too narrow even so, the actions move whole to their own line.
    expect(row.style.flexWrap).toBe("wrap");
    expect(actions.style.flex).toBe("0 0 auto");
  });

  it("space Click, Subject and Sky as the actions are spaced, and Clear is a picture too", async () => {
    // 2026-09-29: "make the Clear button an icon too and add the same padding
    // between click/subject/sky that refine/remove/to-mask have".
    await renderPanel();
    const modes = screen.getByRole("group", { name: "Smart selection mode" });
    const actions = screen.getByTestId("smart-actions");
    expect(modes.style.gap).toBe(actions.style.gap);
    for (const [id] of SIX) {
      const seg = screen.getByTestId(id).parentElement!;
      expect(seg.classList.contains("zoom-seg")).toBe(true);
      expect(seg.children).toHaveLength(1);
    }
    const clear = screen.getByTestId("smart-clear");
    expect(clear.textContent).toBe("");
    expect(clear.querySelector('svg[data-testid="smart-icon-clear"]')).not.toBeNull();
    expect(clear.getAttribute("aria-label")).toBe("Clear");
    expect(clear.getAttribute("data-hint")).toMatch(/^Clear: /);
    expect(clear.getAttribute("style")).toBe(screen.getByTestId("smart-mode-click").getAttribute("style"));
    expect(actions.contains(clear)).toBe(true);
  });

  it("Click's picture is the crosshair Click arms on the photograph", async () => {
    await renderPanel();
    const click = screen.getByTestId("smart-icon-click");
    // A plus opened at the middle: four strokes, none through the center.
    const d = click.querySelector("path")!.getAttribute("d")!;
    expect(d.match(/M/g)).toHaveLength(4);
    const src = readFileSync(resolve(process.cwd(), "src/ui/smarttool.tsx"), "utf8");
    expect(src).toContain('cursor: busy ? "progress" : "crosshair"');
  });
});
