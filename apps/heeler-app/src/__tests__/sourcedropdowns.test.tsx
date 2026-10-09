// 2026-09-29, with two screenshots: "1. first screenshot is the smart
// adjustment layers. The refine/remove/ to mask buttons should be the
// same size as click/subject/sky. Right align them to the view so there
// is space between the two sets of buttons. 2. second screenshot is
// Adjustments > Source. There are four options with buttons of different
// width and count. It just looks sloppy, make these a dropdown option
// menu. This also means you should update Preferences > File & Import to
// also be a dropdown option menu as well." And then: "make sure the
// dropdowns are all the same width (defaulting to the length of the
// longest word in all 4)".
//
// jsdom lays nothing out, so the width is pinned by construction: every
// field sizes itself from the same list of labels (MenuField's
// fitLabels, a hidden grid stack), carries no pixel width of its own,
// and the list holds every choice in all four menus. The browser build
// is where the equal widths were measured.

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { App } from "../app";
import { initialState } from "../data";
import { makeNode, specFor } from "../nodes";
import { NEUTRAL_PARAMS, PARAM_OPTIONS, reduce, type Command, type State } from "../state";
import { NodeParams } from "../ui/graph";
import { Preferences } from "../ui/preferences";
import { SmartModePanel } from "../ui/smarttool";

vi.mock("../bridge", async (importOriginal) => {
  const real = await importOriginal<typeof import("../bridge")>();
  return { ...real, smartModelStatus: vi.fn(async () => null) };
});

afterEach(() => cleanup());

const run = (s: State, ...cmds: Command[]) => cmds.reduce(reduce, s);

/** Every label in the four Source menus, written out here rather than
 * read from the component, so a menu that loses a choice fails. */
const ALL_SOURCE_LABELS = [
  ...(PARAM_OPTIONS["heeler.image_source"].highlights ?? []),
  ...(PARAM_OPTIONS["heeler.image_source"].demosaic ?? []),
  ...(PARAM_OPTIONS["heeler.image_source"].sharpening ?? []),
].map((o) => o.label).concat(["Linear", "Standard", "Film"]);
const LONGEST = ALL_SOURCE_LABELS.reduce((a, b) => (b.length > a.length ? b : a));

const fitOf = (el: HTMLElement) =>
  el.querySelector<HTMLElement>("[data-fit-labels]")?.dataset.fitLabels?.split("|") ?? [];

function openSource() {
  const fold = screen.getByTestId("collapse-source");
  if (fold.getAttribute("data-open") !== "true") fireEvent.click(fold);
}

describe("Develop's Source section", () => {
  it("draws its four choices as dropdowns of one width that fits the longest label in all four", () => {
    render(<App />);
    openSource();
    const fields = ["source-highlights", "source-demosaic", "source-sharpening", "tone-profile"].map((id) =>
      screen.getByTestId(id),
    );
    // No segmented buttons left behind.
    expect(screen.queryByTestId("source-sharpening-standard")).toBeNull();
    expect(screen.queryByTestId("tone-profile-standard")).toBeNull();
    const first = fitOf(fields[0]);
    expect(first).toContain(LONGEST);
    for (const label of ALL_SOURCE_LABELS) expect(first).toContain(label);
    for (const f of fields) {
      expect(f.getAttribute("aria-haspopup")).toBe("listbox");
      expect(fitOf(f)).toEqual(first);
      // Sized by the labels alone: no per-field pixel width to differ.
      expect(f.style.width).toBe("");
      expect(f.style.minWidth).toBe("");
      // At the panel's row size, not the toolbar's 9.5px.
      expect(f.style.fontSize).toBe("11px");
    }
  });

  it("shows the choice's outcome-first hint on the field and on each row", () => {
    render(<App />);
    openSource();
    const field = screen.getByTestId("source-highlights");
    expect(field).toHaveAttribute("data-value", "clip");
    expect(field.getAttribute("data-hint")).toBe("Cut blown channels at sensor white");
    fireEvent.click(field);
    expect(screen.getByTestId("source-highlights-option-rebuild").getAttribute("data-hint")).toBe(
      "Reconstruct blown areas, rolling their color off",
    );
  });
});

describe("the Source node in the graph inspector", () => {
  const node = (type: string) => ({
    ...makeNode(specFor(type)!, "n1", 0, 0),
    params: { ...(NEUTRAL_PARAMS[type] ?? {}) },
  });

  it("uses the same dropdowns, fitted to the same labels as Develop's", () => {
    render(<NodeParams node={node("heeler.image_source")} dispatch={() => {}} />);
    for (const id of ["highlights", "demosaic", "sharpening"]) {
      const f = screen.getByTestId(`inspector-source-${id}`);
      expect(fitOf(f)).toContain(LONGEST);
      expect(fitOf(f)).toEqual(expect.arrayContaining(ALL_SOURCE_LABELS));
    }
  });

  it("is keyboard reachable: the arrows open the list and move, Enter chooses, one command", () => {
    const got: Command[] = [];
    render(<NodeParams node={node("heeler.image_source")} dispatch={(c) => got.push(c)} />);
    const field = screen.getByTestId("inspector-source-demosaic");
    field.focus();
    fireEvent.keyDown(field, { key: "ArrowDown" });
    const standard = screen.getByTestId("inspector-source-demosaic-option-standard");
    expect(document.activeElement).toBe(standard);
    fireEvent.keyDown(standard, { key: "ArrowDown" });
    const fine = screen.getByTestId("inspector-source-demosaic-option-fine");
    expect(document.activeElement).toBe(fine);
    fireEvent.click(fine); // what Enter does on a focused button
    expect(got).toEqual([{ type: "set_text_param", id: "n1", param: "demosaic", value: "fine" }]);
    expect(screen.queryByTestId("inspector-source-demosaic-menu")).toBeNull();
    expect(document.activeElement).toBe(field);
  });

  it("Escape closes the list and hands focus back to the field", () => {
    render(<NodeParams node={node("heeler.image_source")} dispatch={() => {}} />);
    const field = screen.getByTestId("inspector-source-highlights");
    field.focus();
    fireEvent.keyDown(field, { key: "ArrowDown" });
    fireEvent.keyDown(document.activeElement!, { key: "Escape" });
    expect(screen.queryByTestId("inspector-source-highlights-menu")).toBeNull();
    expect(document.activeElement).toBe(field);
  });
});

describe("Preferences > Import & Files", () => {
  it("offers the RAW defaults as the same dropdowns, one width for both", () => {
    const sent: Command[] = [];
    const state = run(initialState(), { type: "open_prefs" });
    render(<Preferences state={state} dispatch={((c: Command) => sent.push(c)) as never} />);
    fireEvent.click(screen.getByTestId("prefs-tab-import"));
    const profile = screen.getByTestId("prefs-raw-profile");
    const sharpening = screen.getByTestId("prefs-raw-sharpening");
    expect(profile).toHaveAttribute("aria-haspopup", "listbox");
    expect(fitOf(profile)).toEqual(fitOf(sharpening));
    expect(fitOf(profile)).toEqual(expect.arrayContaining(["Linear", "Standard", "Film", "Off", "Low", "High"]));
    fireEvent.click(profile);
    fireEvent.click(screen.getByTestId("prefs-raw-profile-option-film"));
    expect(sent).toContainEqual({ type: "set_ui_setting", key: "rawProfile", value: "film" });
  });
});

describe("the smart mask's action buttons", () => {
  it("are Click's size and push to the right edge of the row", async () => {
    const s = run(initialState(), { type: "add_layer", maskType: "smart" });
    render(<SmartModePanel state={s} dispatch={() => {}} />);
    await waitFor(() => screen.getByTestId("smart-modes"));
    const click = screen.getByTestId("smart-mode-click");
    for (const id of ["smart-matte", "smart-remove", "smart-to-mask"]) {
      const b = screen.getByTestId(id);
      // The same element, class and group class as Click: nothing of
      // its own to make it smaller (the old chip.small was 9px).
      expect(b.className).toBe(click.className);
      expect(b.getAttribute("style")).toBe(click.getAttribute("style"));
      expect(b.parentElement!.classList.contains("zoom-seg")).toBe(true);
      expect(b.parentElement!.style.border).toBe(click.parentElement!.style.border);
      expect(b.classList.contains("chip")).toBe(false);
    }
    const actions = screen.getByTestId("smart-actions");
    expect(actions.style.marginLeft).toBe("auto");
    // Wraps whole rather than shrinking.
    expect(actions.style.flex).toBe("0 0 auto");
    expect(screen.getByTestId("smart-modes").style.flexWrap).toBe("wrap");
  });
});
