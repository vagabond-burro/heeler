import { render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { initialState } from "../data";
import { reduce } from "../state";
import { EqEditor } from "../ui/eqeditor";

// 2026-10-06: the console logged "Encountered two children with the
// same key" from EqEditor under Black and White. Its gridlines sat at
// min, min/2, 0, max/2 and max, so a range that starts at 0 (the depth
// curve's 0 to 100) drew three lines at 0, all keyed 0, and three "0"
// labels on top of each other.
describe("the EQ editor's gridlines", () => {
  afterEach(() => vi.restoreAllMocks());

  const editor = (yRange: [number, number]) => {
    const node = reduce(initialState(), { type: "set_category", title: "Recolor", on: true }).nodes.find((n) => n.id === "recolor")!;
    return <EqEditor node={node} dispatch={(() => {}) as never} domain={[0, 100]} xTicks={[0, 50, 100]} yRange={yRange} yUnit="% far" points={[{ x: 0, y: 50 }, { x: 100, y: 50 }]} onPoints={() => {}} noPresets noInterp />;
  };

  it("draws each level once on a range that starts at 0, with no duplicate keys", () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const view = render(editor([0, 100]));
    expect(errors.mock.calls.filter((c) => String(c[0]).includes("same key"))).toEqual([]);
    expect(view.getAllByText("0% far")).toHaveLength(1);
    expect(view.getByText("+50% far")).toBeTruthy();
    expect(view.getByText("+100% far")).toBeTruthy();
  });

  it("keeps all five levels on a range around 0", () => {
    const view = render(editor([-2, 2]));
    for (const label of ["-2% far", "-1% far", "0% far", "+1% far", "+2% far"]) expect(view.getAllByText(label)).toHaveLength(1);
  });
});
