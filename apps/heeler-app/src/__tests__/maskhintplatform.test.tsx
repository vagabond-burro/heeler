import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { initialState } from "../data";
import { reduce } from "../state";
import { listColorSets } from "../colorsets";
import { setMacForTests } from "../platform";
import { ColorSetTools } from "../ui/colorsets";
import { DodgeToolButton } from "../ui/dodgetool";
import { SmartModePanel } from "../ui/smarttool";

afterEach(() => { cleanup(); setMacForTests(null); });
it.each([true, false])("mask and brush hints name the platform modifier (Mac %s)", (mac) => {
  setMacForTests(mac);
  const s = reduce(initialState(), { type: "add_color_set" });
  const smart = reduce(initialState(), { type: "add_layer", maskType: "smart" });
  render(<><ColorSetTools set={listColorSets(s.nodes)[0]} dispatch={() => {}} dropperArmed={false} maskShown={false} red={false} />
    <DodgeToolButton state={s} dispatch={() => {}} /><SmartModePanel state={smart} dispatch={() => {}} /></>);
  const hints = [screen.getByTestId("dropper-color-set-1"), screen.getByTestId("smart-mode-click"),
    ...document.querySelectorAll('[data-hint*="Paint light"]')];
  expect(hints).toHaveLength(3);
  for (const el of hints) {
    expect(el.getAttribute("data-hint")).toContain(mac ? "⌥" : "ALT");
    if (mac) expect(el.getAttribute("data-hint")).not.toMatch(/\bALT\b/);
  }
});

// Stage 2 of the masks review: two more hints spelled ALT on a Mac, the
// Recolor surface's footer and the Object mask panel's help line.
import { makeNode, specFor } from "../nodes";
import { SurfaceEditor } from "../ui/surface";
import { ObjectMattePanel } from "../ui/mattetool";
import type { FilePasses } from "../state";

it.each([true, false])("the surface footer and the object mask help name the platform modifier (Mac %s)", (mac) => {
  setMacForTests(mac);
  const passes: FilePasses = {
    depth: null, mattes: [{ layer: "ViewLayer.CryptoObject", names: ["Ground", "Suzanne"] }],
    channels: [], normals: null, camera: false, pages: [], layers: [], layered: false,
  };
  let s = reduce(initialState(), { type: "add_layer", maskType: "object" });
  s = reduce(s, { type: "file_passes_known", image: s.activeImage, passes });
  s = reduce(s, { type: "set_text_param", id: s.activeLayer!.replace("_adj", "_mask"), param: "layer", value: "ViewLayer.CryptoObject" });
  const recolor = makeNode(specFor("heeler.recolor")!, "rc", 0, 0);
  render(<>
    <ObjectMattePanel state={s} dispatch={() => {}} />
    <SurfaceEditor node={recolor} dispatch={() => {}} id="huelum_hue" range={[-100, 100]} unit="" snap={1} />
  </>);
  const help = document.querySelector(".help")?.textContent ?? "";
  const footer = screen.getByText(/Drag a cell up or down/).textContent ?? "";
  for (const text of [help, footer]) {
    expect(text).toContain(mac ? "⌥" : "ALT");
    if (mac) expect(text).not.toMatch(/\b(ALT|Alt)\b/);
  }
  expect(help).toContain("take one out");
});
