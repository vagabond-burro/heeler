// Regressions from the 2026-09-15 review of the 26.2 series: tags as keyboard buttons
// in every seat, the two tag boxes agreeing, the rig's handles at the thickest outline,
// the radial grab under rotation and zoom, the sweep across 180 degrees, a click
// between close curve points, and a thick zero-reach grip holding still.

import { useReducer } from "react";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { initialState } from "../data";
import { reduce, SHAPE_LINE_WIDTH_RANGE, toolNode, type Command, type State } from "../state";
import { CatalogView } from "../ui/catalogview";
import { FilterControls, Ribbon } from "../ui/chrome";
import { KeyLightGizmo } from "../ui/keylightgizmo";
import { CurveEditor } from "../ui/editors";
import { RadialOverlay } from "../ui/overlays";
import { mockResetKeywords, setImageKeywords } from "../bridge";

afterEach(() => { vi.restoreAllMocks(); mockResetKeywords(); });

it.each(["grid", "thumbs", "list"])("%s ratings are keyboard buttons outside the photo button", async seat => {
  const user = userEvent.setup();
  let latest: State;
  function Harness() {
    const [state, dispatch] = useReducer(reduce, {
      ...initialState(), imageSelection: ["4866", "4867"],
      ribbonExpanded: seat === "grid", ribbonView: seat === "list" ? "list" : "thumbs",
    } as State);
    latest = state;
    return seat === "grid" ? <CatalogView state={state} dispatch={dispatch} /> : <Ribbon state={state} dispatch={dispatch} />;
  }
  render(<Harness />);
  const star = screen.getByTestId("star-4866-4");
  expect(star.tagName).toBe("BUTTON");
  expect(star.parentElement!.closest("button, [role=button]")).toBeNull();
  star.focus();
  await user.keyboard("{Enter}");
  expect(latest!.images.filter(i => ["4866", "4867"].includes(i.id)).map(i => i.stars)).toEqual([4, 4]);
  const outside = screen.getByTestId("star-4868-2");
  outside.focus();
  await user.keyboard(" ");
  expect(latest!.images.find(i => i.id === "4868")!.stars).toBe(2);
  expect(latest!.imageSelection).toEqual(["4866", "4867"]);
  const flag = screen.getByTestId("flag-4866-pick");
  flag.focus();
  await user.keyboard("{Enter}");
  expect(latest!.images.filter(i => ["4866", "4867"].includes(i.id)).map(i => i.flag)).toEqual(["", ""]);
  await user.keyboard("{Enter}");
  expect(latest!.images.filter(i => ["4866", "4867"].includes(i.id)).map(i => i.flag)).toEqual(["pick", "pick"]);
  if (seat === "grid") {
    await user.dblClick(star);
    expect(latest!.ribbonExpanded).toBe(true);
  }
});

it("the mounted tag seats refresh suggestions and agree after applying a term", async () => {
  function Harness() {
    const [state, dispatch] = useReducer(reduce, initialState());
    return <><FilterControls state={state} dispatch={dispatch} inline /><FilterControls state={state} dispatch={dispatch} /></>;
  }
  render(<Harness />);
  await act(async () => { await setImageKeywords("4866", ["new-tag"]); });
  const [row, popover] = screen.getAllByTestId("filter-tag");
  // The suggestions are SuggestField's own rows now, not a <datalist>
  // (2026-10-06, one dropdown in the app).
  const offered = (field: HTMLElement) => within(field.parentElement!).queryByTestId("filter-tag-suggestion-new-tag");
  fireEvent.focus(row);
  await waitFor(() => expect(offered(row)).not.toBeNull());
  fireEvent.change(row, { target: { value: "new-tag" } });
  fireEvent.keyDown(row, { key: "Enter" });
  await waitFor(() => expect(popover).toHaveValue("new-tag"));
  // The popover's field holds the term already, and a field never
  // suggests what it holds; typing the start of it shows it is offered.
  fireEvent.focus(popover);
  fireEvent.change(popover, { target: { value: "new" } });
  await waitFor(() => expect(offered(popover)).not.toBeNull());
});

it("maximum rig thickness preserves the fill and the centers of discs and the reach grip", () => {
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({ left: 0, top: 0, width: 400, height: 200 } as DOMRect);
  let s = reduce(initialState(), { type: "set_text_param", id: "keylight", param: "lights", value: JSON.stringify([
    { kind: "directional", strength: 0, flare: true, on: true },
    { kind: "point", px: .5, py: .5, strength: 0, range: 50, flare: true, on: true },
  ]) });
  s = { ...s, keyLightSel: 1 };
  render(<KeyLightGizmo state={s} dispatch={() => {}} node={toolNode(s, "keylight")!} norm={() => [0, 0]} lineWidth={SHAPE_LINE_WIDTH_RANGE[1]} />);
  for (const [id, minimumFill] of [["keylight-handle-1", 8], ["keylight-target-0", 6], ["keylight-reach-1", 6]] as const) {
    const style = screen.getByTestId(id).style;
    const size = parseFloat(style.width);
    expect(size - 2 * parseFloat(style.borderWidth)).toBeGreaterThanOrEqual(minimumFill);
    expect(parseFloat(style.marginLeft)).toBe(-size / 2);
    expect(parseFloat(style.marginTop)).toBe(-size / 2);
  }
  const source = screen.getByTestId("keylight-flare-source-0").querySelector("circle")!;
  expect(Number(source.getAttribute("r")) - Number(source.getAttribute("stroke-width")) / 2).toBeGreaterThan(2.5);
  const pointSource = screen.getByTestId("keylight-flare-source-1").querySelector("circle")!;
  const discRadius = parseFloat(screen.getByTestId("keylight-handle-1").style.width) / 2;
  expect(Number(pointSource.getAttribute("r")) - Number(pointSource.getAttribute("stroke-width")) / 2).toBeGreaterThan(discRadius);

});

function radialBox() {
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({ left: 0, top: 0, width: 400, height: 200 } as DOMRect);
  for (const [key, value] of [["clientWidth", 400], ["clientHeight", 200], ["offsetWidth", 400], ["offsetHeight", 200]] as const) {
    vi.spyOn(HTMLElement.prototype, key, "get").mockReturnValue(value);
  }
}

it("off-center radial grabs preserve their offset on a rotated, zoomed, non-square frame", () => {
  radialBox();
  const sent: Command[] = [];
  const node = { ...toolNode(initialState(), "curves")!, params: { center_x: .5, center_y: .5, radius: .4, feather: 0, rotation: 25 } };
  render(<RadialOverlay node={node} dispatch={c => sent.push(c)} view={{ rotation: 90, zoom: 2 }} />);
  const overlay = screen.getByTestId("radial-overlay");
  fireEvent.mouseDown(overlay, { clientX: 220, clientY: 120 });
  expect(sent.some(c => c.type === "set_params")).toBe(false);
  fireEvent.mouseMove(overlay, { buttons: 1, clientX: 260, clientY: 140 });
  fireEvent.mouseUp(overlay);
  const move = sent.find((c): c is Extract<Command, { type: "set_params" }> => c.type === "set_params")!;
  expect(move.values.center_x).toBeCloseTo(.525);
  expect(move.values.center_y).toBeCloseTo(.4);
});

it("the radial sweep crosses 180 continuously and Shift snaps the absolute angle", () => {
  radialBox();
  const sent: Command[] = [];
  const node = { ...toolNode(initialState(), "curves")!, params: { center_x: .5, center_y: .5, radius: .2, feather: 0, rotation: 23 } };
  render(<RadialOverlay node={node} dispatch={c => sent.push(c)} />);
  const overlay = screen.getByTestId("radial-overlay");
  const pointer = (degrees: number) => ({ clientX: 200 + 60 * Math.cos(degrees * Math.PI / 180), clientY: 100 + 60 * Math.sin(degrees * Math.PI / 180) });
  fireEvent.mouseMove(overlay, pointer(179));
  fireEvent.mouseDown(overlay, pointer(179));
  expect(overlay).toHaveAttribute("data-zone", "rotate");
  fireEvent.mouseMove(overlay, { buttons: 1, ...pointer(-179) });
  fireEvent.mouseMove(overlay, { buttons: 1, shiftKey: true, ...pointer(-177) });
  fireEvent.mouseUp(overlay);
  const values = sent.filter((c): c is Extract<Command, { type: "set_params" }> => c.type === "set_params").map(c => c.values.rotation);
  expect(values[0]).toBeCloseTo(25);
  expect(values[1]).toBe(30);
});


it("a click between close curve points adds a point in a large pop-out", () => {
  const node = { ...toolNode(initialState(), "curves")!, curves: { rgb: [[0, 0], [.48, .5], [.52, .5], [1, 1]] as [number, number][] } };
  render(<CurveEditor node={node} dispatch={() => {}} width={724} height={454} />);
  const plot = screen.getByTestId("curve-plot");
  plot.getBoundingClientRect = () => ({ left: 0, top: 0, width: 724, height: 454 }) as DOMRect;
  expect(screen.getAllByTestId(/^curve-point-\d+$/).length).toBe(4);
  fireEvent(plot, new MouseEvent("pointerdown", { bubbles: true, clientX: 362, clientY: 227 }));
  fireEvent(window, new MouseEvent("pointerup"));
  expect(screen.getAllByTestId(/^curve-point-\d+$/).length).toBe(5);
});

it("a thick zero-reach grip keeps its range when the pointer has not moved", () => {
  radialBox();
  let state = reduce(initialState(), { type: "set_text_param", id: "keylight", param: "lights", value: JSON.stringify([{ kind: "point", px: .5, py: .5, range: 0, strength: 0 }]) });
  state = { ...state, keyLightSel: 0 };
  const sent: Command[] = [];
  render(<KeyLightGizmo state={state} dispatch={c => sent.push(c)} node={toolNode(state, "keylight")!} norm={e => [e.clientX / 400, e.clientY / 200]} lineWidth={8} />);
  const grip = screen.getByTestId("keylight-reach-0");
  const at = { clientX: parseFloat(grip.style.left) * 4, clientY: parseFloat(grip.style.top) * 2 };
  fireEvent(grip, new MouseEvent("pointerdown", { bubbles: true, ...at }));
  fireEvent(window, new MouseEvent("pointermove", at));
  fireEvent(window, new MouseEvent("pointerup"));
  const write = sent.find((c): c is Extract<Command, { type: "set_text_param" }> => c.type === "set_text_param")!;
  expect(JSON.parse(write.value)[0].range).toBe(0);
});
