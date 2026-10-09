// Every user-facing param a node declares has a control in its
// Inspector face. 2026-10-01, on a Smart Mask added in the Graph: "I
// don't see an invert option. I was testing assistant and it mentioned
// to use 'invert control' on the node, but I do not see this control.
// Is it missing from the UI?" It was: the face drew Mode, Threshold
// and Feather, and Invert, Expand and the Depth block had no seat. The
// faces say which param each row writes (data-param on the row,
// data-params on a widget that writes several, the convention the
// publish menu already reads), so this walks every node the palette
// offers, renders the Inspector over it, and names each declared param
// nothing on the face answers for.
//
// The first run found, besides the Smart Mask: every other mask's
// Invert and Depth mask block, the Radial Mask's Shape, Depth
// Lighting's Invert depth, the File's Space and a Shadow's Distance, all
// unreachable on the node and all seated now.

import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { initialState } from "../data";
import { NODE_CATALOG, makeNode, specFor } from "../nodes";
import registryDefaults from "../registry-defaults.json";
import { NEUTRAL_PARAMS, PARAM_OPTIONS, type NodeCard, type State } from "../state";
import { Inspector } from "../ui/graph";

vi.mock("../bridge", async (importOriginal) => {
  const real = await importOriginal<typeof import("../bridge")>();
  return { ...real, smartModelStatus: vi.fn(async () => null), smartRasterStatus: vi.fn(async () => true) };
});

afterEach(cleanup);

const DEFAULTS = registryDefaults as Record<string, Record<string, number>>;

const ROI = "the region the node's gizmo draws in the viewer (its box), written by the gizmo, not a number to type";

/** Params that are no hand control on purpose, each with its reason.
 * Keyed `type.param`, or `type.*` for a whole family. */
const NOT_HAND_CONTROLS: Record<string, string> = {
  "heeler.standard_color.exposure":
    "carried by Color before Exposure had its own node; the engine still reads it so older graphs render unchanged, and Develop's Color section (Temp, Tint, Saturation, Vibrance) never offers it",
  "heeler.standard_color.contrast": "as exposure: the Exposure node's control now, read here only for older graphs",
  "heeler.standard_color.texture*": "carried by Color before the Detail node (2026-09-02); older graphs only, the Detail node seats them",
  "heeler.standard_color.clarity*": "as texture: the Detail node seats them",
  "heeler.standard_color.dehaze*": "as texture: the Detail node seats them",
  "heeler.model_denoise.method":
    "Noise Reduction's remembered method choice (Model or not), written by the Develop section's method menu; the node exists only while Model is the method",
  "heeler.color_checker.m*": "the fitted matrix, the chart fit's output (Place chart and Amount are the face's controls), not hand dials",
  "heeler.tone_eq.ev_*": "the legacy zone values, read only when the curve's points are empty; the EQ editor writes points",
  "heeler.brush_mask.base_invert":
    "the polarity a converted selection's base is laid in with, set by To Mask and Add layer mask; Invert mask is the hand control",
  "heeler.blend.place_pad": "a placed picture's padding, written by the Finish layer's placement",
  "heeler.blend.warp_*": "a placed picture's corners and box, written by the Transform gizmo and its fields on a placed layer",
  "heeler.flare.roi_*": ROI,
  "heeler.halation.roi_*": ROI,
  "heeler.paint.roi_*": ROI,
  "heeler.clone.roi_*": ROI,
  "heeler.gradient.roi_*": ROI,
  "heeler.fx_gradient_overlay.roi_*": ROI,
};

/** A face that shows a row only for some choice gets rendered once more
 * with that choice made, so the row is checked, not excused. */
const VARIANTS: Record<string, { text?: Record<string, string>; state?: Partial<State> }[]> = {
  // The Infrared fold (the four materials and Neutral), shown for an
  // infrared filter.
  "heeler.black_white": [{ text: { filter: "r72" } }],
  // The shape's amount, for the shapes it does something to.
  "heeler.radial_mask": [{ text: { shape: "cross" } }],
  // Around's reach, while an Around cell is the one being edited.
  "heeler.recolor": [{ state: { recolorCell: "around_hue" } as Partial<State> }],
};

/** An excuse key's type and param pattern: "heeler.blend.warp_*". */
const splitKey = (key: string): [string, string] => {
  const cut = key.indexOf(".", "heeler.".length);
  return [key.slice(0, cut), key.slice(cut + 1)];
};
const matches = (pat: string, p: string) => (pat.endsWith("*") ? p.startsWith(pat.slice(0, -1)) : p === pat);

const excused = (type: string, p: string): boolean =>
  Object.keys(NOT_HAND_CONTROLS).some((k) => {
    const [t, pat] = splitKey(k);
    return t === type && matches(pat, p);
  });

function faceParams(type: string, variant: { text?: Record<string, string>; state?: Partial<State> } = {}): Set<string> {
  const card = makeNode(specFor(type)!, "n1", 0, 0);
  const node: NodeCard = {
    ...card,
    // The Depth block folds away while off; on, its rows show.
    params: { ...(DEFAULTS[type] ?? {}), ...(NEUTRAL_PARAMS[type] ?? {}), ...("depth_on" in (DEFAULTS[type] ?? {}) ? { depth_on: 1 } : {}) },
    textParams: { ...(card.textParams ?? {}), ...(variant.text ?? {}) },
  };
  const s = initialState();
  const appState: State = { ...s, ...(variant.state ?? {}), nodes: [...s.nodes, node], selection: [node.id] };
  // The whole Inspector, frame given so it is the main window's (a
  // viewer to click): the face and the Node block under it, which
  // carries Opacity for every node that has one.
  const { container } = render(<Inspector state={appState} dispatch={() => {}} frame={null} />);
  const seen = new Set<string>();
  container.querySelectorAll<HTMLElement>("[data-param]").forEach((el) => seen.add(el.dataset.param!));
  container
    .querySelectorAll<HTMLElement>("[data-params]")
    .forEach((el) => el.dataset.params!.split(/\s+/).forEach((p) => p && seen.add(p)));
  cleanup();
  return seen;
}

describe("every declared param has a seat on its node's face", () => {
  it("every palette node's Inspector answers for each param it declares, or the param is excused with a reason", () => {
    const gaps: string[] = [];
    for (const spec of NODE_CATALOG) {
      const declared = [...Object.keys(DEFAULTS[spec.type] ?? {}), ...Object.keys(PARAM_OPTIONS[spec.type] ?? {})];
      if (declared.length === 0) continue;
      const seen = faceParams(spec.type);
      for (const v of VARIANTS[spec.type] ?? []) faceParams(spec.type, v).forEach((p) => seen.add(p));
      const missing = declared.filter((p) => !seen.has(p) && !excused(spec.type, p));
      if (missing.length) gaps.push(`${spec.type}: ${missing.join(", ")}`);
    }
    expect(gaps).toEqual([]);
  });

  it("every excuse names a param some node still declares", () => {
    // An excuse outliving its param would quietly excuse a new one.
    for (const key of Object.keys(NOT_HAND_CONTROLS)) {
      const [type, pat] = splitKey(key);
      expect(Object.keys(DEFAULTS[type] ?? {}).some((p) => matches(pat, p)), key).toBe(true);
    }
  });
});
