// The kind line under a node's name: the TYPE, with where the palette
// lists it (CATEGORY / SECTION / TYPE) in the status line on hover.
//
// 2026-09-30: "when you rename a node its not clear the node type... The
// label under the name should be {CATEGORY}/{TYPE} so no matter what a
// node gets renamed to, we can always tell what type it is." His case
// was a pixel layer's Export checkbox: the Export Layer node takes the
// layer's name ("Pixel 1"), and the Inspector said only "UTILITY NODE".
// Then, 2026-10-01: "the node type label should be updated with
// {CATEGORY}/{SUB CATEGORY}/{TYPE}", and, when that ran off a narrow
// Inspector at 115%, "or, just show the node type and on mouse hover the
// tooltip shows the location".
import { afterEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fireEvent, render, screen } from "@testing-library/react";
import { initialState } from "../data";
import { reduce, artGroup, artLayers, type Command, type NodeCard, type State } from "../state";
import { CATEGORY_LABEL, NODE_CATALOG, NODE_SECTION, RETIRED_TYPES, makeNode, sectionOf, specFor } from "../nodes";
import { BUILTIN_RECIPES, recipeFromGroup } from "../noderecipes";
import { nodeKind, nodeKindLabel, nodeKindLocation } from "../nodekind";
import registryDefaults from "../registry-defaults.json";
import { Inspector } from "../ui/graph";
import { useHint, useHintSource } from "../ui/hints";

const run = (s: State, ...cmds: Command[]): State => cmds.reduce(reduce, s);
const card = (type: string, id: string): NodeCard => makeNode(specFor(type)!, id, 0, 0);

/** Engine types the palette deliberately does not list: built by the
 * Finish tab and the mask plumbing, never added by hand. They still get
 * a kind line (the type id, in words), but a NEW engine type must reach
 * the palette, so its label is the name a person can find there. */
const INTERNAL = new Set(["heeler.layer_warp_mask", "heeler.mask_crop"]);

describe("the kind helper", () => {
  it("names every palette node by its type and locates it as category, section, type", () => {
    for (const spec of NODE_CATALOG) {
      const k = nodeKind(card(spec.type, "x"));
      const sec = sectionOf(spec);
      expect(k.category, spec.type).toBe(CATEGORY_LABEL[sec.family]);
      expect(k.section, `${spec.type} is in no menu section`).toBe(sec.label);
      expect(NODE_SECTION[spec.type], spec.type).toBeDefined();
      expect(k.type, spec.type).toBe(spec.name);
      expect(nodeKindLabel(card(spec.type, "x")), spec.type).toBe(spec.name);
      expect(nodeKindLocation(card(spec.type, "x")), spec.type).toBe(`${CATEGORY_LABEL[sec.family]} / ${sec.label} / ${spec.name}`);
    }
  });

  it("locates a sample from every category the way the add menus list it", () => {
    const loc = (t: string) => nodeKindLocation(card(t, "x"));
    const name = (t: string) => specFor(t)!.name;
    // Source: listed under Source > Geometry though its card wears
    // Utility's stripe.
    expect(loc("heeler.displacement_map")).toBe("Source / Geometry / Displacement Map");
    expect(nodeKindLabel(card("heeler.displacement_map", "x"))).toBe("Displacement Map");
    expect(loc("heeler.crop_rotate")).toBe(`Source / Geometry / ${name("heeler.crop_rotate")}`);
    expect(loc("heeler.exposure")).toBe(`Color / Tone / ${name("heeler.exposure")}`);
    expect(loc("heeler.white_balance")).toBe(`Color / Color / ${name("heeler.white_balance")}`);
    expect(loc("heeler.blur")).toBe(`Detail / Blur & Smooth / ${name("heeler.blur")}`);
    expect(loc("heeler.morphology")).toBe("Masking / Mask Tools / Morphology");
    expect(loc("heeler.channel_extract")).toBe(`Utility / Channels / ${name("heeler.channel_extract")}`);
    expect(loc("heeler.export_layer")).toBe("Utility / Output / Export Layer");
  });

  it("covers every engine type in the registry: three parts when a menu section lists it, two when nothing does", () => {
    for (const type of Object.keys(registryDefaults)) {
      const k = nodeKind({ type, cat: "utility" });
      expect(k.category.length, type).toBeGreaterThan(0);
      expect(k.type.length, type).toBeGreaterThan(0);
      expect(nodeKindLabel({ type, cat: "utility" }), type).toBe(k.type);
      // By the parts, not by splitting on " / ": a type's own name can
      // hold one (Clone / Heal).
      const loc = nodeKindLocation({ type, cat: "utility" });
      expect(loc, type).toBe(NODE_SECTION[type] ? `${k.category} / ${k.section} / ${k.type}` : `${k.category} / ${k.type}`);
      if (!INTERNAL.has(type) && !RETIRED_TYPES.has(type)) {
        expect(specFor(type), `${type} has no palette entry, so no palette name for its kind line`).toBeDefined();
        expect(k.section, `${type} is in no menu section`).not.toBe("");
      }
    }
  });

  it("names a type the palette does not list in words rather than leaving it blank", () => {
    expect(nodeKindLabel({ type: "heeler.layer_warp_mask", cat: "masking" })).toBe("Layer Warp Mask");
    expect(nodeKindLocation({ type: "heeler.layer_warp_mask", cat: "masking" })).toBe("Masking / Layer Warp Mask");
    expect(nodeKindLocation({ type: "heeler.split_tone", cat: "color" })).toBe("Color / Split Tone");
  });

  it("does not care what the node is called", () => {
    const n = { ...card("heeler.export_layer", "x"), name: "Pixel 1" };
    expect(nodeKindLabel(n)).toBe("Export Layer");
    // The name matching the type changes nothing: the line still shows.
    const same: NodeCard = { ...n, name: "Export Layer" };
    expect(nodeKindLabel(same)).toBe("Export Layer");
  });

  it("calls a group a Group, with the tool or recipe it came from, on the line and on hover", () => {
    const plain: NodeCard = { ...card("heeler.blur", "g"), type: "heeler.group", cat: "group", isGroup: true, name: "My stack" };
    expect(nodeKindLabel(plain)).toBe("Group");
    expect(nodeKindLocation(plain)).toBe("Group");
    expect(nodeKindLabel({ ...plain, tool: "sharpening", cat: "detail" })).toBe("Group / Sharpening");
    expect(nodeKindLabel({ ...plain, tool: "skin" })).toBe("Group / Skin Softening");
    const fs = BUILTIN_RECIPES.find((r) => r.id === "frequency_separation")!;
    const renamed: NodeCard = { ...plain, recipe: fs.id, name: "Portrait pass" };
    expect(nodeKindLabel(renamed)).toBe(`Group / ${fs.name}`);
    expect(nodeKindLocation(renamed)).toBe(`Group / ${fs.name}`);
    // A person's own recipe answers by its own name.
    const mine = recipeFromGroup({ ...plain, groupNodes: [] }, "Moody skies", "user_abc");
    expect(nodeKindLabel({ ...plain, recipe: "user_abc" }, [mine])).toBe("Group / Moody skies");
    // A recipe that is gone (deleted from the palette) leaves a group.
    expect(nodeKindLabel({ ...plain, recipe: "user_gone" }, [mine])).toBe("Group");
  });
});

describe("the Inspector header", () => {
  const kindLine = () => screen.getByTestId("inspector-kind");

  it("shows EXPORT LAYER under a pixel layer's export node named after the layer, its location on hover", () => {
    let s = run(initialState(), { type: "art_add_layer", kind: "paint" });
    const l = artLayers(s)[0];
    s = run(s, { type: "art_set_export", id: l.blend.id, on: true });
    const ex = artGroup(s)!.groupNodes!.find((n) => n.type === "heeler.export_layer")!;
    expect(ex.name).toBe(`${l.blend.name} Export Layer`);
    expect(ex.name).not.toBe("Export Layer");
    s = run(s, { type: "open_group", id: "art", frame: { w: 800, h: 600 } } as Command, { type: "select_nodes", ids: [ex.id] });
    render(<Inspector state={s} dispatch={() => {}} frame={null} />);
    expect(kindLine().textContent).toBe("Export Layer");
    // Uppercase is the kicker class's job, not the words'.
    expect(kindLine().className).toContain("kicker");
    expect(kindLine().getAttribute("data-hint")).toBe("Utility / Output / Export Layer");
  });

  it("keeps the kind after a rename, ellipsized with the full location on hover", () => {
    let s = run(initialState(), { type: "add_node", node: card("heeler.displacement_map", "ch") });
    s = run(s, { type: "rename_node", id: "ch", name: "A very long name nobody would ever fit in a narrow inspector" }, { type: "select_nodes", ids: ["ch"] });
    render(<Inspector state={s} dispatch={() => {}} frame={null} />);
    expect(kindLine().textContent).toBe("Displacement Map");
    expect(kindLine().getAttribute("data-hint")).toBe("Source / Geometry / Displacement Map");
    expect(kindLine().style.textOverflow).toBe("ellipsis");
    expect(kindLine().style.whiteSpace).toBe("nowrap");
  });

  it("adds masked after the type, and after the location on hover, when a field feeds the mask", () => {
    const base = run(initialState(), { type: "add_node", node: card("heeler.exposure", "mx") }, { type: "add_node", node: card("heeler.luminance_range_mask", "mm") });
    const s: State = { ...base, wires: [...base.wires, { from: "mm", to: "mx", toPort: "mask" } as State["wires"][number]], selection: ["mx"] };
    render(<Inspector state={s} dispatch={() => {}} frame={null} />);
    const name = specFor("heeler.exposure")!.name;
    expect(kindLine().textContent).toBe(`${name} · masked`);
    expect(kindLine().getAttribute("data-hint")).toBe(`Color / Tone / ${name} · masked`);
  });

  it("names a recipe group by its recipe, with its member count", () => {
    const fs = BUILTIN_RECIPES.find((r) => r.id === "frequency_separation")!;
    let s = run(initialState(), { type: "add_recipe", recipe: fs, x: 0, y: 300, id: "fs" } as Command);
    s = run(s, { type: "rename_node", id: "fs", name: "Skin pass" }, { type: "select_nodes", ids: ["fs"] });
    const g = s.nodes.find((n) => n.id === "fs")!;
    expect(g.name).toBe("Skin pass");
    render(<Inspector state={s} dispatch={() => {}} frame={null} />);
    expect(kindLine().textContent).toBe(`Group / ${fs.name} · ${g.groupNodes!.length} nodes`);
  });

  it("names a plain group Group, with its member count", () => {
    let s = run(initialState(), { type: "select_nodes", ids: ["exposure", "lummask"] }, { type: "group_selection", name: "Mine" });
    const g = s.nodes.find((n) => n.isGroup && n.name === "Mine")!;
    s = run(s, { type: "select_nodes", ids: [g.id] });
    render(<Inspector state={s} dispatch={() => {}} frame={null} />);
    expect(kindLine().textContent).toBe(`Group · ${g.groupNodes!.length} nodes`);
  });

  it("lists each node's type in a multiple selection, its location on hover", () => {
    let s = run(initialState(), { type: "add_node", node: { ...card("heeler.export_layer", "ch"), name: "Pixel 1" } });
    s = run(s, { type: "select_nodes", ids: ["ch", "exposure"] });
    render(<Inspector state={s} dispatch={() => {}} frame={null} />);
    expect(screen.getByTestId("inspector-sel-ch").textContent).toBe("Pixel 1Export Layer");
    expect(screen.getByTestId("inspector-sel-kind-ch").textContent).toBe("Export Layer");
    expect(screen.getByTestId("inspector-sel-kind-ch").getAttribute("data-hint")).toBe("Utility / Output / Export Layer");
  });
});

// 2026-10-01: "I had asked that when mousing over the type label on a
// node (Example: Hue Range Mask) to display the menu category and sub
// category path in the status line". The status line is the app's one
// home for hover text (hints.ts), so the location rides data-hint and
// there is no second, browser tooltip.
describe("the kind line's location in the status line", () => {
  /** The Inspector under the app's hint source, with the status line's
   * reader beside it, as the app root wires them. */
  function WithStatus({ state }: { state: State }) {
    useHintSource();
    const hint = useHint();
    return (
      <>
        <Inspector state={state} dispatch={() => {}} frame={null} />
        <div data-testid="status-line">{hint ?? ""}</div>
      </>
    );
  }
  const status = () => screen.getByTestId("status-line").textContent;

  it("says Masking / Range Masks / Hue Range Mask on hovering a Hue Range Mask's type", () => {
    let s = run(initialState(), { type: "add_node", node: card("heeler.hue_range_mask", "hr") });
    s = run(s, { type: "rename_node", id: "hr", name: "Sky band" }, { type: "select_nodes", ids: ["hr"] });
    render(<WithStatus state={s} />);
    const line = screen.getByTestId("inspector-kind");
    expect(line.textContent).toBe("Hue Range Mask");
    expect(status()).toBe("");
    fireEvent.mouseOver(line);
    expect(status()).toBe("Masking / Range Masks / Hue Range Mask");
    // One hover, not two: no browser tooltip on top of the status line.
    expect(line.hasAttribute("title")).toBe(false);
  });

  it("says Group and the member count for a plain group, and the recipe's name for a recipe group", () => {
    let s = run(initialState(), { type: "select_nodes", ids: ["exposure", "lummask"] }, { type: "group_selection", name: "Mine" });
    const g = s.nodes.find((n) => n.isGroup && n.name === "Mine")!;
    s = run(s, { type: "select_nodes", ids: [g.id] });
    const view = render(<WithStatus state={s} />);
    fireEvent.mouseOver(screen.getByTestId("inspector-kind"));
    expect(status()).toBe(`Group · ${g.groupNodes!.length} nodes`);
    view.unmount();

    const fs = BUILTIN_RECIPES.find((r) => r.id === "frequency_separation")!;
    let r = run(initialState(), { type: "add_recipe", recipe: fs, x: 0, y: 300, id: "fs" } as Command);
    r = run(r, { type: "rename_node", id: "fs", name: "Skin pass" }, { type: "select_nodes", ids: ["fs"] });
    const rg = r.nodes.find((n) => n.id === "fs")!;
    render(<WithStatus state={r} />);
    fireEvent.mouseOver(screen.getByTestId("inspector-kind"));
    expect(status()).toBe(`Group / ${fs.name} · ${rg.groupNodes!.length} nodes`);
  });

  it("says each node's location on hovering its type in a multiple selection", () => {
    let s = run(initialState(), { type: "add_node", node: card("heeler.hue_range_mask", "hr") }, { type: "add_node", node: { ...card("heeler.export_layer", "ex"), name: "Pixel 1" } });
    s = run(s, { type: "select_nodes", ids: ["hr", "ex"] });
    render(<WithStatus state={s} />);
    const hr = screen.getByTestId("inspector-sel-kind-hr");
    expect(hr.hasAttribute("title")).toBe(false);
    fireEvent.mouseOver(hr);
    expect(status()).toBe("Masking / Range Masks / Hue Range Mask");
    fireEvent.mouseOver(screen.getByTestId("inspector-sel-kind-ex"));
    expect(status()).toBe("Utility / Output / Export Layer");
  });
});

it("the type labels keep an explicit readable size in single and multiple selection", () => {
  const a = card("heeler.displacement_map", "review_a");
  const b = card("heeler.distance_field", "review_b");
  const s = { ...initialState(), nodes: [a, b], selection: [a.id] };
  const view = render(<Inspector state={s} dispatch={() => {}} frame={null} />);
  expect(screen.getByTestId("inspector-kind")).toHaveStyle({ fontSize: "11px" });
  view.rerender(<Inspector state={{ ...s, selection: [a.id, b.id] }} dispatch={() => {}} frame={null} />);
  expect(screen.getByTestId(`inspector-sel-kind-${a.id}`)).toHaveStyle({ fontSize: "11px" });
  expect(screen.getByTestId(`inspector-sel-kind-${b.id}`)).toHaveStyle({ fontSize: "11px" });
});

describe("the generic rows' labels", () => {
  // The rows' own stylesheet, so the computed style is the app's.
  let sheet: HTMLStyleElement | null = null;
  afterEach(() => {
    sheet?.remove();
    sheet = null;
  });
  const withTheme = () => {
    sheet = document.createElement("style");
    sheet.textContent = readFileSync(resolve(process.cwd(), "src/theme.css"), "utf8");
    document.head.appendChild(sheet);
  };

  it("Max displacement stays inside its column, ellipsized with the whole name on hover", () => {
    withTheme();
    const n = card("heeler.displacement_map", "dm_rows");
    render(<Inspector state={{ ...initialState(), nodes: [n], selection: [n.id] }} dispatch={() => {}} frame={null} />);
    const row = document.querySelector(`.srow[data-node="dm_rows"][data-param="max_displacement"]`) as HTMLElement;
    expect(row, "the Max displacement row").not.toBeNull();
    const lbl = row.querySelector(".lbl") as HTMLElement;
    expect(lbl.textContent).toBe("Max displacement");
    expect(lbl.getAttribute("title")).toBe("Max displacement");
    const cs = getComputedStyle(lbl);
    expect(cs.overflow).toBe("hidden");
    expect(cs.textOverflow).toBe("ellipsis");
    expect(cs.whiteSpace).toBe("nowrap");
    // The label column is a fixed 78px under the same .ui-zoom as its
    // text, so the fit is the same at every app zoom.
    expect(getComputedStyle(row).gridTemplateColumns.startsWith("78px")).toBe(true);
  });

  it("every generic node's labels fit their column or ellipsize, never running into the control", () => {
    withTheme();
    let checked = 0;
    for (const spec of NODE_CATALOG) {
      const n = card(spec.type, `gen_${checked}`);
      const view = render(<Inspector state={{ ...initialState(), nodes: [n], selection: [n.id] }} dispatch={() => {}} frame={null} />);
      for (const row of document.querySelectorAll<HTMLElement>(`.srow[data-node="${n.id}"]`)) {
        const lbl = row.querySelector<HTMLElement>(":scope > .lbl");
        if (!lbl || !lbl.classList.contains("fit")) continue;
        checked++;
        const cs = getComputedStyle(lbl);
        expect(cs.overflow, `${spec.type} ${lbl.textContent}`).toBe("hidden");
        expect(cs.textOverflow, `${spec.type} ${lbl.textContent}`).toBe("ellipsis");
        // Whole name on hover: the title, or the param's own hint chip.
        expect(lbl.getAttribute("title") ?? lbl.getAttribute("data-tip"), `${spec.type} ${lbl.textContent}`).toBeTruthy();
      }
      view.unmount();
    }
    expect(checked, "generic rows rendered").toBeGreaterThan(50);
    // And every generic slider row the Inspector draws carries the fit.
    const n = card("heeler.displacement_map", "dm_all");
    render(<Inspector state={{ ...initialState(), nodes: [n], selection: [n.id] }} dispatch={() => {}} frame={null} />);
    const labels = [...document.querySelectorAll<HTMLElement>(`.srow[data-node="dm_all"] > .lbl`)];
    expect(labels.length).toBeGreaterThanOrEqual(2);
    for (const l of labels) expect(l.classList.contains("fit"), l.textContent ?? "").toBe(true);
  });
});
