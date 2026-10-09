// 2026-09-30, Preferences at 150 percent app scale: "Export > Never
// overwrite an existing file: the checkbox and help text are pushed up
// against each other." "Scripting > Media server share link: the two
// options for 'With token' and 'Just IP and port' should be a dropdown
// option menu." "Models > Depth map detail: the 3 options for 518, 700,
// and 1036 should be a dropdown option menu." "Editing & Brush > Mask
// overlay color: is there any way to make the 4 color options a dropdown
// option menu but keep the color dots with labels?"
//
// jsdom lays nothing out, so the fitted width is pinned by construction
// (MenuField's fitLabels, as sourcedropdowns.test.tsx does) and the
// switch's room by its cell holding nothing else. The browser build is
// where the 115 and 150 percent layouts were measured.

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { initialState } from "../data";
import { reduce, type Command, type State } from "../state";
import { MenuField } from "../ui/menufield";
import { Preferences } from "../ui/preferences";

afterEach(() => cleanup());

function open(prefs: Partial<State["prefs"]> = {}) {
  const sent: Command[] = [];
  const s0 = reduce(initialState(), { type: "open_prefs" });
  const state = { ...s0, prefs: { ...s0.prefs, ...prefs } };
  render(<Preferences state={state} dispatch={((c: Command) => sent.push(c)) as never} />);
  return sent;
}

const fitOf = (field: HTMLElement) =>
  field.querySelector<HTMLElement>("[data-fit-labels]")?.dataset.fitLabels?.split("|") ?? null;

/** What the Import & Files dropdowns wear: the regular 11px size, the
 * fitted width, no pixel width of their own. One category mounts at a
 * time, so the Import field is read first and the field on another
 * tab is held to it.*/
function importLook() {
  fireEvent.click(screen.getByTestId("prefs-tab-import"));
  const raw = screen.getByTestId("prefs-raw-profile");
  return { fontSize: raw.style.fontSize, padding: raw.style.padding };
}
function looksLike(field: HTMLElement, look: { fontSize: string; padding: string }) {
  expect(field).toHaveAttribute("aria-haspopup", "listbox");
  expect(field.style.fontSize).toBe(look.fontSize);
  expect(field.style.padding).toBe(look.padding);
  expect(field.style.minWidth).toBe("");
}

describe("Media server share link", () => {
  it("is a dropdown of the two link styles, fitted to the longer, one save per pick", () => {
    const sent = open({ serveSimpleLink: false });
    const look = importLook();
    fireEvent.click(screen.getByTestId("prefs-tab-scripting"));
    const field = screen.getByTestId("prefs-serve-link");
    looksLike(field, look);
    expect(field.dataset.value).toBe("token");
    expect(field.textContent).toContain("With token");
    expect(fitOf(field)).toEqual(["With token", "Just IP and port"]);
    expect(field.getAttribute("data-hint")).toBe("Protects the next media share with an access token");
    // The old segmented buttons are gone.
    expect(screen.queryByTestId("prefs-serve-token")).toBeNull();
    fireEvent.click(field);
    const simple = screen.getByTestId("prefs-serve-link-option-simple");
    expect(simple.getAttribute("data-hint")).toBe("Uses only the IP address and port on a trusted network");
    expect(screen.getByTestId("prefs-serve-link-option-token")).toHaveAttribute("aria-selected", "true");
    fireEvent.click(simple);
    expect(sent.filter((c) => c.type === "set_prefs")).toEqual([{ type: "set_prefs", prefs: { serveSimpleLink: true } }]);
  });

  it("shows Just IP and port when that is saved, and picks the token back", () => {
    const sent = open({ serveSimpleLink: true });
    fireEvent.click(screen.getByTestId("prefs-tab-scripting"));
    const field = screen.getByTestId("prefs-serve-link");
    expect(field.dataset.value).toBe("simple");
    fireEvent.click(field);
    fireEvent.click(screen.getByTestId("prefs-serve-link-option-token"));
    expect(sent).toEqual([{ type: "set_prefs", prefs: { serveSimpleLink: false } }]);
  });
});

describe("Depth map detail", () => {
  it("is a dropdown of 518, 700 and 1036 with each outcome as its hint", () => {
    const sent = open({ depthSize: 700 });
    const look = importLook();
    fireEvent.click(screen.getByTestId("prefs-tab-models"));
    const field = screen.getByTestId("prefs-depth-size");
    looksLike(field, look);
    expect(field.dataset.value).toBe("700");
    expect(fitOf(field)).toEqual(["518", "700", "1036"]);
    expect(field.getAttribute("data-hint")).toMatch(/^New photographs read the scene at 700 px/);
    expect(screen.queryByTestId("prefs-depth-size-1036")).toBeNull();
    fireEvent.click(field);
    const rows = screen.getAllByRole("option").map((o) => o.textContent);
    expect(rows).toEqual(["518", "700", "1036"]);
    expect(screen.getByTestId("prefs-depth-size-option-518").getAttribute("data-hint")).toMatch(/model's own 518 px: fastest/);
    expect(screen.getByTestId("prefs-depth-size-option-1036").getAttribute("data-hint")).toMatch(/four times the time and memory/);
    fireEvent.click(screen.getByTestId("prefs-depth-size-option-1036"));
    expect(sent).toEqual([{ type: "set_prefs", prefs: { depthSize: 1036 } }]);
  });
});

describe("Mask overlay color", () => {
  const COLORS = [
    ["red", "Red", "rgb(220,64,58)"],
    ["magenta", "Magenta", "rgb(218,72,190)"],
    ["cyan", "Cyan", "rgb(48,190,210)"],
    ["green", "Green", "rgb(74,190,105)"],
  ] as const;

  it("is a dropdown whose field shows the chosen color's dot beside its name", () => {
    open({ maskOverlayColor: "magenta" });
    const look = importLook();
    fireEvent.click(screen.getByTestId("prefs-tab-brush"));
    const field = screen.getByTestId("prefs-mask-color");
    looksLike(field, look);
    expect(field.dataset.value).toBe("magenta");
    expect(fitOf(field)).toEqual(COLORS.map(([, label]) => label));
    const dot = screen.getByTestId("prefs-mask-color-swatch");
    expect(dot.dataset.swatch).toBe("rgb(218,72,190)");
    expect(dot.style.borderRadius).toBe("50%");
    // The dot sits before the name, inside the field, outside the
    // fitted label stack, so the fitted width counts it.
    expect(dot.parentElement).toBe(field);
    const labels = field.querySelector<HTMLElement>("[data-fit-labels]")!;
    expect(dot.compareDocumentPosition(labels) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(labels.textContent).toContain("Magenta");
    expect(screen.queryByTestId("prefs-mask-color-red")).toBeNull();
  });

  it("lists every color with its own dot and name, and saves one pick as one command", () => {
    const sent = open({ maskOverlayColor: "red" });
    fireEvent.click(screen.getByTestId("prefs-tab-brush"));
    fireEvent.click(screen.getByTestId("prefs-mask-color"));
    for (const [id, label, rgb] of COLORS) {
      const row = screen.getByTestId(`prefs-mask-color-option-${id}`);
      const dot = screen.getByTestId(`prefs-mask-color-option-${id}-swatch`);
      expect(dot.parentElement).toBe(row);
      expect(dot.dataset.swatch).toBe(rgb);
      expect(row.textContent).toBe(label);
      expect(row.getAttribute("data-hint")).toBe(`Uses ${label.toLowerCase()} for mask overlays and brush washes`);
    }
    fireEvent.click(screen.getByTestId("prefs-mask-color-option-cyan"));
    expect(sent).toEqual([{ type: "set_prefs", prefs: { maskOverlayColor: "cyan" } }]);
  });
});

describe("MenuField's swatch", () => {
  it("is drawn only when an option has one, so other callers are unchanged", () => {
    render(
      <MenuField
        testid="plain"
        label="Plain"
        size="regular"
        value="a"
        options={[
          { id: "a", label: "A" },
          { id: "b", label: "B" },
        ]}
        onChange={() => {}}
      />,
    );
    fireEvent.click(screen.getByTestId("plain"));
    expect(document.querySelector("[data-swatch]")).toBeNull();
  });

  it("keeps its slot in the field when the chosen option has no color", () => {
    render(
      <MenuField
        testid="mixed"
        label="Mixed"
        size="regular"
        fitLabels={["None", "Blue"]}
        value="none"
        options={[
          { id: "none", label: "None" },
          { id: "blue", label: "Blue", swatch: "rgb(0,0,255)" },
        ]}
        onChange={() => {}}
      />,
    );
    const slot = screen.getByTestId("mixed-swatch");
    expect(slot.dataset.swatch).toBe("");
    expect(slot.style.width).toBe("8px");
  });
});

describe("Never overwrite an existing file", () => {
  it("gives the switch its own cell and says everything in one description", () => {
    const sent = open();
    fireEvent.click(screen.getByTestId("prefs-tab-export"));
    const row = screen.getByTestId("prefs-row-export-overwrite");
    const toggle = screen.getByTestId("prefs-export-overwrite");
    // The switch is the control cell itself, beside nothing: the label
    // is its grid neighbor, the way Deleting reconnects and every other
    // switch row is drawn.
    const grid = toggle.parentElement!;
    expect(grid.style.display).toBe("grid");
    expect([...grid.children]).toHaveLength(2);
    expect(grid.children[1]).toBe(toggle);
    expect(toggle.textContent).toBe("");
    expect(toggle).toHaveAttribute("aria-label", "Never overwrite an existing file");
    // One description, holding every fact the two texts held.
    const texts = [...row.querySelectorAll("div, span")].filter(
      (e) => e.children.length === 0 && (e.textContent ?? "").length > 40,
    );
    expect(texts).toHaveLength(1);
    const words = texts[0].textContent!;
    expect(words).toContain("next free name");
    expect(words).toContain("-2, -3");
    expect(words).toContain("save dialog's Replace? is honored");
    expect(words).toContain("never writes over a photograph in your library");
    expect(row.textContent!.match(/photograph in your library/g)).toHaveLength(1);
    fireEvent.click(toggle);
    expect(sent).toEqual([{ type: "set_prefs", prefs: { exportNeverOverwrite: false } }]);
  });

  it("never lets a switch shrink beside text", () => {
    // The owner's screenshot drew the switch squeezed to a sliver against
    // its text at 150 percent; the class keeps its 20 px in any flex row.
    const css = readFileSync(resolve(process.cwd(), "src/theme.css"), "utf8");
    const rule = css.match(/^\.toggle \{[^}]*\}/m)![0];
    expect(rule).toContain("width: 20px");
    expect(rule).toContain("flex: none");
  });
});
