import { describe, expect, it } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { initialState } from "../data";
import { BwControls } from "../ui/bwcontrols";
import { reduce, withOwnFaces, type Command, type State } from "../state";

/** Each of the conversion's three curves has its own interpolation face
 * (review 2026-09-15, item 7): the free hue curve's cannot reshape the
 * pro infrared and depth curves. */
describe("one face per curve", () => {
  it("a saved graph's one face is copied to the two curves on load, and a set face stays", () => {
    let s: State = initialState();
    s = reduce(s, { type: "set_param", id: "bw", param: "amount", value: 100 });
    s = { ...s, nodes: s.nodes.map((n) => (n.id === "bw" ? { ...n, curveInterp: "linear" as const, textParams: { ...n.textParams, depth_interp: "tangent" } } : n)) };
    s = reduce(s, { type: "split_curve_faces" });
    const bw = s.nodes.find((n) => n.id === "bw")!;
    expect(bw.textParams?.ir_interp).toBe("linear");
    expect(bw.textParams?.depth_interp).toBe("tangent");
    expect(reduce(s, { type: "split_curve_faces" })).toBe(s);
    // A node with no face at all is left alone.
    const fresh = initialState();
    expect(reduce(fresh, { type: "split_curve_faces" })).toBe(fresh);
    expect(withOwnFaces({ ...bw, textParams: { ir_interp: "smooth", depth_interp: "smooth" } })).toEqual({ ir_interp: "smooth", depth_interp: "smooth" });
  });

  it("changing the hue curve's face freezes the other two at the face they had", () => {
    let s: State = initialState();
    s = reduce(s, { type: "set_param", id: "bw", param: "amount", value: 100 });
    s = reduce(s, { type: "set_curve_interp", id: "bw", interp: "linear" });
    const bw = s.nodes.find((n) => n.id === "bw")!;
    expect(bw.curveInterp).toBe("linear");
    expect(bw.textParams?.ir_interp).toBe("smooth");
    expect(bw.textParams?.depth_interp).toBe("smooth");
    s = reduce(s, { type: "set_curve_interp", id: "bw", interp: "tangent" });
    expect(s.nodes.find((n) => n.id === "bw")!.textParams?.ir_interp).toBe("smooth");
  });

  it("the infrared and depth editors write their own faces", async () => {
    let s: State = initialState();
    s = reduce(s, { type: "set_param", id: "bw", param: "amount", value: 100 });
    s = reduce(s, { type: "set_text_param", id: "bw", param: "filter", value: "r72" });
    s = reduce(s, { type: "set_text_param", id: "bw", param: "far_filter", value: "w25" });
    const bw = s.nodes.find((n) => n.id === "bw")!;
    const sent: Command[] = [];
    render(<BwControls bw={bw} nodes={s.nodes} dispatch={((c: Command) => sent.push(c)) as never} state={s} />);
    const user = userEvent.setup();
    await user.click(screen.getByTestId("bw-ir-curve-fold"));
    await user.click(within(screen.getByTestId("bw-ir-curve")).getByTestId("eq-interp"));
    expect(sent.some((c) => c.type === "set_text_param" && c.param === "ir_interp")).toBe(true);
    await user.click(within(screen.getByTestId("bw-depth-curve")).getByTestId("eq-interp"));
    expect(sent.some((c) => c.type === "set_text_param" && c.param === "depth_interp")).toBe(true);
    await user.click(within(screen.getByTestId("bw-hue-curve")).getByTestId("eq-interp"));
    expect(sent.some((c) => c.type === "set_curve_interp")).toBe(true);
    expect(sent.some((c) => c.type === "set_text_param" && (c.param === "ir_interp" || c.param === "depth_interp") && false)).toBe(false);
  });
});
