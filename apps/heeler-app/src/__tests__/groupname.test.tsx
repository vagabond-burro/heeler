// Save selection as group offers a name for what is selected, fresh each
// time (2026-10-10: "why does the node recipe name when saving always
// default to 'Cinematic Portrait Grade'?"). The dialog started at the
// mockup's name for every group, and kept whatever was typed last; Save
// as Recipe offers the group's name, so every recipe got it too.
import { describe, it, expect } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { initialState } from "../data";
import { defaultGroupName, type NodeCard, type State } from "../state";
import { GroupDialog } from "../ui/graph";

const card = (id: string, name: string, x: number, extra: Partial<NodeCard> = {}): NodeCard =>
  ({ id, type: "heeler.blur", name, cat: "detail", x, y: 0, enabled: true, params: {}, hasIn: true, hasOut: true, ...extra }) as NodeCard;

describe("the group's offered name", () => {
  it("names the selected nodes left to right, three at most and a count of the rest", () => {
    const nodes = [card("c", "Levels", 300), card("a", "Blur", 100), card("b", "Curves", 200), card("d", "Grain", 400)];
    expect(defaultGroupName({ nodes, selection: ["a", "c"] })).toBe("Blur + Levels");
    expect(defaultGroupName({ nodes, selection: ["a", "b", "c", "d"] })).toBe("Blur + Curves + Levels + 1 more");
  });

  it("is unique among the groups there, and Group N when nothing selected has a name", () => {
    const nodes = [card("a", "Blur", 100), card("b", "Levels", 200), card("g", "Blur + Levels", 0, { isGroup: true }), card("h", "Group 1", 0, { isGroup: true })];
    expect(defaultGroupName({ nodes, selection: ["a", "b"] })).toBe("Blur + Levels 2");
    expect(defaultGroupName({ nodes, selection: [] })).toBe("Group 2");
  });
});

describe("Save selection as group", () => {
  it("opens with the offered name and no description, each time", () => {
    const nodes = [card("a", "Blur", 100), card("b", "Levels", 200)];
    const open = (selection: string[], groupDialogOpen: boolean): State => ({ ...initialState(), nodes, selection, groupDialogOpen });
    const { rerender } = render(<GroupDialog state={open(["a", "b"], true)} dispatch={() => {}} />);
    const name = () => screen.getByTestId("group-name") as HTMLInputElement;
    expect(name().value).toBe("Blur + Levels");
    expect(name().value).not.toMatch(/Cinematic/);
    fireEvent.change(name(), { target: { value: "My look" } });
    fireEvent.change(screen.getByLabelText("Group description"), { target: { value: "old note" } });
    rerender(<GroupDialog state={open(["a"], false)} dispatch={() => {}} />);
    rerender(<GroupDialog state={open(["a"], true)} dispatch={() => {}} />);
    expect(name().value).toBe("Blur");
    expect((screen.getByLabelText("Group description") as HTMLTextAreaElement).value).toBe("");
  });
});
