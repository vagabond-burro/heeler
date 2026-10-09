import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";
import { App } from "../app";
import { initialState } from "../data";
import { CHAIN_ORDER } from "../recipes";
import { MODEL_DENOISE_ID, denoiseMethodIsModel, denoiseSectionOn, reduce, type Command, type State } from "../state";
import { SECTIONS, sectionIsOn } from "../ui/simple";
import { denoiseTileCount } from "../bridge";

const run = (s: State, ...cmds: Command[]) => cmds.reduce(reduce, s);
const node = (s: State, id: string) => s.nodes.find((n) => n.id === id);

/* (2026-09-09): Noise Reduction's Method, Classic or Model, the
 * model being SCUNet's answer blended in by the same two dials plus
 * Detail. The model node sits first after the source, so the answer
 * the desktop computed from the source is the picture it sees.*/
describe("Noise Reduction's Model method", () => {
  beforeEach(() => {
  });

  it("puts the model node first after the source and swaps it for the classic pair under the one switch", () => {
    expect(CHAIN_ORDER.indexOf("modeldenoise")).toBe(CHAIN_ORDER.indexOf("src") + 1);
    const s0 = initialState();
    // Choosing Model with the section off: the node exists, remembers
    // the choice, and stays off with the section.
    const chosen = reduce(s0, { type: "set_denoise_method", model: true });
    const md = node(chosen, MODEL_DENOISE_ID)!;
    expect(md.type).toBe("heeler.model_denoise");
    expect(md.enabled).toBe(false);
    expect(md.params).toMatchObject({ luminance: 50, chroma: 50, detail: 50, method: 1 });
    expect(denoiseMethodIsModel(chosen.nodes)).toBe(true);
    expect(denoiseSectionOn(chosen.nodes)).toBe(false);
    // Wired straight after the source.
    const feed = chosen.wires.find((w) => w.to === MODEL_DENOISE_ID)!;
    expect(feed.from).toBe("src");
    expect(chosen.wires.some((w) => w.from === MODEL_DENOISE_ID)).toBe(true);
    // The section's switch now drives the model node; the classic
    // pair stays bypassed.
    const on = reduce(chosen, { type: "set_recipe", recipe: "denoise", on: true });
    expect(node(on, MODEL_DENOISE_ID)!.enabled).toBe(true);
    expect(node(on, "dn_luma_nr")?.enabled ?? false).toBe(false);
    expect(denoiseSectionOn(on.nodes)).toBe(true);
    const sec = SECTIONS.find((x) => x.title === "Noise Reduction")!;
    expect(sectionIsOn(on, sec)).toBe(true);
    const shown = sec.rows.filter((r) => !r.when || r.when(on));
    expect(shown.map((r) => r.label)).toEqual(["Luminance", "Chroma", "Edge detail"]);
    expect(shown.every((r) => r.node!(on)!.id === MODEL_DENOISE_ID)).toBe(true);
    // Back to Classic while on: the pair takes over, the model node rests.
    const classic = reduce(on, { type: "set_denoise_method", model: false });
    expect(node(classic, MODEL_DENOISE_ID)!.enabled).toBe(false);
    expect(node(classic, MODEL_DENOISE_ID)!.params.method).toBe(0);
    expect(node(classic, "dn_luma_nr")!.enabled).toBe(true);
    expect(sectionIsOn(classic, sec)).toBe(true);
    // Off in Model: everything rests, the choice stays.
    const off = run(classic, { type: "set_denoise_method", model: true }, { type: "set_recipe", recipe: "denoise", on: false });
    expect(node(off, MODEL_DENOISE_ID)!.enabled).toBe(false);
    expect(denoiseMethodIsModel(off.nodes)).toBe(true);
    expect(sectionIsOn(off, sec)).toBe(false);
    // Undoable, as a graph edit is.
    expect(reduce(chosen, { type: "undo" }).nodes.some((n) => n.id === MODEL_DENOISE_ID)).toBe(false);
  });

  it("counts the model's tiles the way the desktop plans them", () => {
    expect(denoiseTileCount(256, 256)).toBe(1);
    expect(denoiseTileCount(512, 512)).toBe(3 * 3);
    expect(denoiseTileCount(2048, 1365)).toBe(11 * 7);
    expect(denoiseTileCount(6000, 4000)).toBe(31 * 21);
  });

  it("the section offers Classic and Model, and Model shows the three dials and its status line", async () => {
    const user = userEvent.setup();
    render(<App />);
    fireEvent.click(screen.getByTestId("toggle-noise-reduction"));
    await user.click(screen.getByTestId("section-header-noise-reduction"));
    const body = () => within(screen.getByTestId("section-header-noise-reduction").parentElement!);
    expect(body().getByTestId("nr-method-classic")).toHaveAttribute("data-active", "true");
    expect(body().queryByTestId("nr-model-status")).toBeNull();
    // Classic: the pair, both writing `strength` on their own nodes.
    expect(body().getAllByTestId("slider-strength")).toHaveLength(2);
    await user.click(body().getByTestId("nr-method-model"));
    expect(body().getByTestId("nr-method-model")).toHaveAttribute("data-active", "true");
    for (const p of ["luminance", "chroma", "detail"]) expect(body().getByTestId(`slider-${p}`)).toBeInTheDocument();
    expect(body().queryAllByTestId("slider-strength")).toHaveLength(0);
    expect(within(body().getByTestId("nr-model-status")).getByText(/Model/)).toBeInTheDocument();
    await user.click(body().getByTestId("nr-method-classic"));
    expect(body().getAllByTestId("slider-strength")).toHaveLength(2);
    // Switched off again, the Method row stays where the body is
    // ("I don't see the Classic or Model"); only the
    // model's status line waits for the switch.
    fireEvent.click(body().getByTestId("toggle-noise-reduction"));
    expect(body().getByTestId("nr-method-classic")).toBeInTheDocument();
    await user.click(body().getByTestId("nr-method-model"));
    expect(body().queryByTestId("nr-model-status")).toBeNull();
    fireEvent.click(body().getByTestId("toggle-noise-reduction"));
    expect(body().getByTestId("nr-model-status")).toBeInTheDocument();
  });
});


it("keys model work by the actual source text choices", async () => {
  const { denoiseMark } = await import("../ui/denoisetool");
  const s = initialState();
  const changed = (key: string, value: string) => ({ ...s, nodes: s.nodes.map(n => n.type === "heeler.image_source" ? { ...n, textParams: { ...n.textParams, [key]: value } } : n) });
  expect(denoiseMark(changed("highlights", "rebuild"))).not.toBe(denoiseMark(s));
  expect(denoiseMark(changed("demosaic", "fine"))).not.toBe(denoiseMark(s));
});

it("reads its help text at the size of the control labels", async () => {
  // 2026-09-11: first "increase the font size of the help text in Noise
  // Reduction by 1.5x", then "make the noise reduction help text the
  // same font size as the labels for the controls". That is `.srow .lbl`
  // in theme.css, 11px; the chips beside it stay at 12.
  const user = userEvent.setup({ advanceTimers: () => {} });
  render(<App />);
  fireEvent.click(screen.getByTestId("toggle-noise-reduction"));
  await user.click(screen.getByTestId("section-header-noise-reduction"));
  const body = () => within(screen.getByTestId("section-header-noise-reduction").parentElement!);
  await user.click(body().getByTestId("nr-method-model"));
  // Read the label's size from the stylesheet rather than typing the
  // number twice: jsdom loads no CSS, so the rule itself is the only
  // honest source, and moving it moves this assertion with it.
  const css = readFileSync(resolve(process.cwd(), "src/theme.css"), "utf8");
  const labelSize = /\.srow \.lbl\s*\{[^}]*font-size:\s*(\d+(?:\.\d+)?)px/.exec(css)![1];
  expect(body().getByTestId("nr-model-help").style.fontSize).toBe(`${labelSize}px`);
});
