// One section, one layout: Develop's panel, Graph's inspector and the
// popped-out tool windows draw a section's rows and widgets from the same
// definition (SECTIONS), so no face can keep an order of its own
// (2026-10-19, of Recolor: "THe Neutral guard is still above graph and
// pairs are missing. Whether in develop or graph, it should be using the
// same template layout"; then every other tool with a face in more than
// one place).
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { initialState } from "../data";
import { reduce, type Command, type NodeCard, type State } from "../state";
import { STATE_CHANNEL, graphSnapshot, setTransport, type ToolWindowKind, type Transport } from "../popout";
import { SimplePanel } from "../ui/simple";
import { Inspector } from "../ui/graph";
import { ToolWindow } from "../ui/toolwindow";
import { SECTIONS } from "../ui/simpledata";
import { FACE_SECTIONS, faceSectionOf } from "../ui/sectionfaceparts";

const run = (s: State, ...cmds: Command[]) => cmds.reduce(reduce, s);
afterEach(() => {
  cleanup();
  setTransport(null);
});

/** The face's pieces in the order they draw: each dial that writes to
 * the node (data-param on a row) and each widget the definition names
 * (section-widget-<kind>), outermost only, so a widget's own dials count
 * as the widget. Develop's controls for other nodes (Detail's Unsharp on
 * the sharpen node, Color's Treatment on the B&W node) are theirs. */
function order(root: Element | null, node: NodeCard): string[] {
  const marks = [...(root?.querySelectorAll('[data-param], [data-testid^="section-widget-"]') ?? [])].filter((e) =>
    e.hasAttribute("data-param") ? e.closest("[data-node]")?.getAttribute("data-node") === node.id : true,
  );
  return marks
    .filter((e) => !marks.some((o) => o !== e && o.contains(e)))
    .map((e) => (e.hasAttribute("data-param") ? `param:${e.getAttribute("data-param")}` : e.getAttribute("data-testid")!));
}

/** The app with a section switched on and unfolded, and its node. */
function opened(title: string): { s: State; node: NodeCard } {
  const s = run(initialState(), { type: "set_category", title, on: true }, { type: "open_section", title });
  const node = SECTIONS.find((sec) => sec.title === title)!.node(s)!;
  return { s, node };
}

function developOrder(title: string): string[] {
  const { s, node } = opened(title);
  render(<SimplePanel state={{ ...s, mode: "simple" }} dispatch={() => {}} width={320} />);
  const got = order(document.querySelector(`[data-section="${title}"]`), node);
  cleanup();
  return got;
}

const faceId = (title: string) => `section-face-${title.toLowerCase().replace(/[^a-z]+/g, "-")}`;

function graphOrder(title: string): string[] {
  const { s, node } = opened(title);
  const { container } = render(<Inspector state={{ ...s, mode: "advanced", selection: [node.id] }} dispatch={() => {}} frame={null} />);
  const got = order(container.querySelector(`[data-testid="${faceId(title)}"]`), node);
  cleanup();
  return got;
}

/** What each migrated section draws in Develop, said here once more so
 * a change to the definition is a change someone meant. */
const EXPECTED: Record<string, string[]> = {
  Exposure: ["param:exposure", "param:contrast", "param:color_contrast", "param:highlights", "param:shadows", "param:whites", "param:blacks", "section-widget-zones"],
  Color: ["param:temperature", "param:tint", "param:saturation", "param:vibrance", "section-widget-whiteBalance"],
  Levels: ["param:black", "param:white", "param:gamma", "param:black_soft", "param:white_soft", "section-widget-levels"],
  Curves: ["section-widget-curveEditor"],
  Print: ["section-widget-print"],
  "Tone Equalizer": ["param:range_shift", "param:smoothing", "section-widget-toneEq"],
  "Color Wheels": ["section-widget-colorWheels"],
  "Color Tune": ["param:smoothing", "section-widget-colorConsole"],
  "Color Bend": ["section-widget-bendWheel", "param:falloff", "param:amount"],
  Recolor: ["param:smoothing", "section-widget-recolorGraph", "param:neutral_guard", "section-widget-guardStrip", "section-widget-recolorPairs"],
  Detail: ["section-widget-detailAdvanced", "param:texture", "param:clarity", "param:dehaze"],
  Geometry: ["param:angle", "param:aspect", "param:crop_w", "param:crop_h", "param:crop_x", "param:crop_y", "section-widget-flipPhoto"],
};

describe("a section's face", () => {
  it("every node type with a face names a section that exists, and the list here covers each", () => {
    for (const type of Object.keys(FACE_SECTIONS)) expect(faceSectionOf(type), type).toBeDefined();
    expect(Object.keys(EXPECTED).sort()).toEqual(Object.values(FACE_SECTIONS).sort());
  });

  for (const title of Object.keys(EXPECTED)) {
    it(`${title} is the same in Develop and in Graph, from one definition`, () => {
      const develop = developOrder(title);
      expect(develop).toEqual(EXPECTED[title]);
      expect(graphOrder(title)).toEqual(develop);
    });
  }

  it("Color's white balance row is the same three chips in Develop and in Graph", () => {
    const { s, node } = opened("Color");
    const chips = (root: Element | null) =>
      [...(root?.querySelectorAll('[data-testid="section-widget-whiteBalance"] button') ?? [])].map((b) => b.getAttribute("data-testid"));
    render(<SimplePanel state={{ ...s, mode: "simple" }} dispatch={() => {}} width={320} />);
    const develop = chips(document.querySelector('[data-section="Color"]'));
    cleanup();
    const { container } = render(<Inspector state={{ ...s, mode: "advanced", selection: [node.id] }} dispatch={() => {}} frame={null} />);
    expect(develop).toEqual(["wb-auto", "wb-as-shot", "wb-pick"]);
    expect(chips(container.querySelector(`[data-testid="${faceId("Color")}"]`))).toEqual(develop);
  });

  it("Color Wheels in Graph has no chip of its own: the header's reset puts back all nine values", () => {
    let { s, node } = opened("Color Wheels");
    const nine = ["shadows", "midtones", "highlights"].flatMap((r) => ["hue", "sat", "lum"].map((c) => `${r}_${c}`));
    s = run(s, { type: "set_params", id: node.id, values: Object.fromEntries(nine.map((p, i) => [p, (i + 1) / 20])) });
    const sent: Command[] = [];
    render(<Inspector state={{ ...s, mode: "advanced", selection: [node.id] }} dispatch={(c) => sent.push(c)} frame={null} />);
    expect(screen.queryByTestId("wheels-reset")).toBeNull();
    fireEvent.click(screen.getByTestId("inspector-reset"));
    const after = run(s, ...sent).nodes.find((n) => n.id === node.id)!;
    for (const p of nine) expect(after.params[p] ?? 0, p).toBe(0);
  });

  it("Recolor's guard row names its strip and the pairs after it", () => {
    const guard = SECTIONS.find((sec) => sec.title === "Recolor")!.rows.find((r) => r.param === "neutral_guard")!;
    expect(guard.widgets).toEqual({ before: ["recolorGraph"], after: ["guardStrip", "recolorPairs"] });
  });
});

function fakeTransport(): Transport {
  const subs = new Map<string, ((p: unknown) => void)[]>();
  const t: Transport = {
    send(channel, payload) {
      [...(subs.get(channel) ?? [])].forEach((f) => f(payload));
    },
    subscribe(channel, fn) {
      subs.set(channel, [...(subs.get(channel) ?? []), fn]);
      return () => subs.set(channel, (subs.get(channel) ?? []).filter((f) => f !== fn));
    },
  };
  setTransport(t);
  return t;
}

/** Each tool window and the section it draws. */
const WINDOWS: [ToolWindowKind, string][] = [
  ["curves", "Curves"],
  ["wheels", "Color Wheels"],
  ["toneeq", "Tone Equalizer"],
  ["recolor", "Recolor"],
  ["colorconsole", "Color Tune"],
];

describe("a tool window's face", () => {
  for (const [kind, title] of WINDOWS) {
    it(`the ${title} window draws Develop's face`, async () => {
      const { s, node } = opened(title);
      const t = fakeTransport();
      render(<ToolWindow kind={kind} />);
      act(() => t.send(STATE_CHANNEL, graphSnapshot(s)));
      const face = await screen.findByTestId(faceId(title));
      // Color Tune's window seats Smoothing inside its own layout, in the
      // column beside the wheel: the one row the window moves.
      const develop = EXPECTED[title].filter((m) => !(kind === "colorconsole" && m === "param:smoothing"));
      expect(order(face, node)).toEqual(develop);
      if (kind === "colorconsole") expect(face.querySelector('[data-testid="console-smoothing"]')).not.toBeNull();
    });
  }

  it("Color Tune's window names its dials at the panel's size, outside the panel's zoom", async () => {
    const { s } = opened("Color Tune");
    const t = fakeTransport();
    render(<ToolWindow kind="colorconsole" />);
    act(() => t.send(STATE_CHANNEL, graphSnapshot(s)));
    const face = await screen.findByTestId(faceId("Color Tune"));
    for (const id of ["console-smoothing", "console-hue", "console-sat", "console-vib", "console-lum"]) {
      expect(face.querySelector(`[data-testid="${id}"]`)?.className, id).toBe("srow windowed");
    }
    // The size: the panel's 11px times the app zoom the panel wears, and
    // the name and value columns grown by the same, so the track narrows.
    const css = readFileSync(resolve(process.cwd(), "src/theme.css"), "utf8");
    expect(css).toMatch(/\.srow\.windowed \.lbl, \.srow\.windowed \.val \{ font-size: calc\(11px \* var\(--chrome-zoom\)\); \}/);
    expect(css).toMatch(/\.srow\.windowed \{ grid-template-columns: calc\(78px \* var\(--chrome-zoom\)\) 1fr calc\(42px \* var\(--chrome-zoom\)\); \}/);
  });

  it("Color Tune in the panel keeps the panel's rows, inside its zoom", () => {
    const { s } = opened("Color Tune");
    render(<SimplePanel state={{ ...s, mode: "simple" }} dispatch={() => {}} width={320} />);
    const hue = document.querySelector('[data-section="Color Tune"] [data-testid="console-hue"]');
    expect(hue?.className).toBe("srow");
  });
});
