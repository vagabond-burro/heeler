// The menu bar catches up with the thumbnail's right-click (The
// report: "Photo menu should have the same Move to Trash and Relink
// tools as the context menu"), and the Select menu learns the
// toolbar's ways of making a selection.

import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import userEvent from "@testing-library/user-event";
import { App } from "../app";
import { Viewer } from "../ui/viewer";
import { initialState } from "../data";
import { reduce, SELECT_METHODS, type State } from "../state";
import { menuValue } from "./menuhelp";

describe("the Photo menu's file errands", () => {
  it("carries Move to Trash, and Relink grayed until something is missing", async () => {
    const user = userEvent.setup();
    render(<App />);
    await user.click(screen.getByTestId("menu-photo"));
    expect(screen.getByTestId("menu-photo-trash")).toBeEnabled();
    // Nothing in the sample library is missing, so Relink grays rather
    // than inviting a re-point of files that are where they should be.
    expect(screen.getByTestId("menu-photo-relink")).toBeDisabled();
  });
});

describe("the Select menu's three submenus", () => {
  it("Interactive Selection lists every toolbar method and arms the one you pick", async () => {
    const user = userEvent.setup();
    render(<App />);
    await user.click(screen.getByTestId("menu-select"));
    fireEvent.mouseEnter(screen.getByTestId("menu-select-interactive").parentElement!);
    // The geometry methods; the model picks live in Smart Selection.
    for (const m of SELECT_METHODS.filter((x) => x.id !== "smart")) {
      expect(screen.getByTestId(`menu-select-tool-${m.id}`)).toBeInTheDocument();
    }
    expect(screen.queryByTestId("menu-select-tool-smart")).not.toBeInTheDocument();
    await user.click(screen.getByTestId("menu-select-tool-freehand"));
    // The pick armed the select tool: the selection panel opens with
    // the work, the same as arming from the toolbar. Interactive is
    // where the tool and its cursor come from.
    expect(screen.getByTestId("select-tab")).toBeInTheDocument();
  });

  it("Smart Selection holds the model picks, and one stamps the mode", async () => {
    const user = userEvent.setup();
    render(<App />);
    await user.click(screen.getByTestId("menu-select"));
    fireEvent.mouseEnter(screen.getByTestId("menu-select-smart").parentElement!);
    // The smart three, selections only. "Have a divider
    // below the current selections and then have the 3 selection
    // tools for Click, Subject, and Sky."
    for (const id of ["click", "subject", "sky"]) {
      expect(screen.getByTestId(`menu-select-smart-${id}`)).toBeInTheDocument();
    }
    await user.click(screen.getByTestId("menu-select-smart-subject"));
    // The panel opens with the method in hand, and the document
    // selection carries the one-shot mode for the overlay to run.
    expect(screen.getByTestId("select-tab")).toBeInTheDocument();
    expect(menuValue(screen.getByTestId("select-method"))).toBe("smart");
  });

  it("Select by makes the selection without arming a tool", async () => {
    const user = userEvent.setup();
    render(<App />);
    await user.click(screen.getByTestId("menu-select"));
    fireEvent.mouseEnter(screen.getByTestId("menu-select-by").parentElement!);
    // Labels drop the prefix; the submenu says it.
    expect(screen.getByTestId("menu-select-luma")).toHaveTextContent("Luma Range");
    await user.click(screen.getByTestId("menu-select-luma"));
    // The range went into a document selection the command started and
    // the dialog opened on it...
    expect(screen.getByTestId("select-range-dialog")).toBeInTheDocument();
    // No tool is armed, but the active selection keeps its controls
    // available. Panel presence does not imply a tool cursor.
    expect((window as unknown as { __heeler: { state: () => State } }).__heeler.state().tool).toBe("none");
    expect(screen.getByTestId("select-tab")).toBeInTheDocument();
  });
});

/* The viewer keeps drawing the document selection's ants whatever tool
 * is in hand (2026-09-10: Select by must not arm the select tool, and
 * the ants must still show). jsdom cannot decode the frame's pixels,
 * so a range region has nothing to trace here; a marquee region's
 * outline is pure geometry and traces either way. What this pins is
 * the gating: the viewer considers the active selection mask precisely
 * when the tool is NOT select or polish, so a guard on state.tool
 * would turn this red.*/
describe("the document selection's ants without the select tool", () => {
  it("renders them with the tool untouched", () => {
    let s = reduce(initialState(), { type: "ensure_document_selection" });
    s = reduce(s, {
      type: "add_region",
      id: "sel_doc",
      region: { kind: "marquee", op: "replace", shape: "rect", x0: 0.1, y0: 0.1, x1: 0.6, y1: 0.6 },
    });
    expect(s.tool).not.toBe("select");
    render(<Viewer state={s} dispatch={() => {}} />);
    expect(screen.queryAllByTestId(/^ants-/).length).toBeGreaterThan(0);
  });
});
