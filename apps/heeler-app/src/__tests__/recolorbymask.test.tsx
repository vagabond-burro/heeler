// Recolor's BY-Mask source menu lost its clear row when the native
// select became a MenuField (2026-10-06): the old "Choose a mask…"
// <option> was a real row that dispatched by_mask="", clearing the
// axis, and a MenuField placeholder cannot be chosen. The prompt is a
// placeholder while nothing is chosen; once a mask is, a None row
// clears it, the same shape Film's and Tether's menus use.
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { RecolorBlock } from "../ui/recolor";
import { choose, menuRows } from "./menuhelp";
import { initialState } from "../data";
import { reduce, type NodeCard } from "../state";

const MASK = {
  id: "smart_mask",
  type: "heeler.smart_mask",
  name: "Subject",
  cat: "masking",
  x: 0,
  y: 0,
  enabled: true,
  params: {},
} as NodeCard;

function block(byMask: string) {
  const node = reduce(initialState(), { type: "set_category", title: "Recolor", on: true }).nodes.find(
    (n) => n.id === "recolor",
  )!;
  const dispatch = vi.fn();
  render(
    <RecolorBlock
      node={{ ...node, textParams: { ...node.textParams, ...(byMask ? { by_mask: byMask } : {}) } }}
      allNodes={[MASK]}
      dispatch={dispatch}
      cell="mask_sat"
      onCell={() => {}}
    />,
  );
  return dispatch;
}

describe("Recolor's BY-Mask source menu", () => {
  it("shows the prompt as a placeholder while nothing is chosen, with no dead None row", () => {
    block("");
    const field = screen.getByTestId("recolor-by-mask");
    expect(field.textContent).toContain("Choose a mask…");
    expect(menuRows(field).map(([id]) => id)).toEqual(["smart_mask"]);
  });

  it("offers None once a mask is chosen, and choosing it clears the axis", () => {
    const dispatch = block("smart_mask");
    const field = screen.getByTestId("recolor-by-mask");
    expect(menuRows(field)[0]).toEqual(["", "None"]);
    choose(field, "");
    expect(dispatch).toHaveBeenCalledWith({
      type: "set_text_param",
      id: "recolor",
      param: "by_mask",
      value: "",
    });
  });
});
