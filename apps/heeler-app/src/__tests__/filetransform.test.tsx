// The File and Transform nodes, and Duplicate.
//
// (2026-09-01): "Add the two new nodes. Also, we need an context
// menu item (and hotkey) to duplicate the selected node(s)."
import { describe, expect, it, afterEach, vi } from "vitest";
import React from "react";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { NEUTRAL_NODES, NEUTRAL_WIRES, initialState } from "../data";
import { NEUTRAL_PARAMS, NODE_H, NODE_W, PARAM_TEXT_DEFAULT, PROFILE_DEFAULTS, capturePreset, duplicable, paramRange, reduce, type Command, type NodeCard, type State } from "../state";
import { serializeBeforeGraph } from "../bridge";
import { makeNode, portHint, specFor } from "../nodes";
import { COMMANDS, conflicts } from "../hotkeys";
import { runCommand } from "../commands";
import { Inspector, NodeEditor } from "../ui/graph";

const native = vi.hoisted(() => ({ invoke: vi.fn(async (_name: string): Promise<any> => null) }));
vi.mock("@tauri-apps/api/core", () => native);
afterEach(() => {
  delete (window as any).__TAURI_INTERNALS__;
  native.invoke.mockClear();
  native.invoke.mockImplementation(async (_name: string): Promise<any> => null);
});

function run(s: State, ...cmds: Command[]): State {
  return cmds.reduce(reduce, s);
}
const fresh = (): State => {
  const s = initialState();
  return { ...s, nodes: structuredClone(NEUTRAL_NODES), wires: structuredClone(NEUTRAL_WIRES) };
};

describe("the File node", () => {
  it("is a source: no input, an image out, and a path to choose", () => {
    const n = makeNode(specFor("heeler.file")!, "file_1", 0, 0);
    expect(n.hasIn).toBe(false);
    expect(n.hasOut).toBe(true);
    expect(n.maskIn).toBeFalsy();
    expect(PARAM_TEXT_DEFAULT["heeler.file"]).toEqual({ path: "" });
    expect(portHint(n, "out").tip).toBe("File.out");
  });

  it("shows its file on the card and offers the picker in the inspector", () => {
    let s = fresh();
    s = run(
      s,
      { type: "add_node", node: makeNode(specFor("heeler.file")!, "file_1", 0, 300) },
      { type: "set_text_param", id: "file_1", param: "path", value: "/Users/user/Pictures/texture.png" },
      { type: "select_nodes", ids: ["file_1"] },
    );
    const Harness = () => {
      const [st, d] = React.useReducer(reduce, s);
      return (
        <>
          <NodeEditor state={st} dispatch={d} />
          <Inspector state={st} dispatch={d} />
        </>
      );
    };
    render(<Harness />);
    expect(screen.getByTestId("source-file-file_1").textContent).toBe("texture.png");
    expect(screen.getByTestId("file-node-name").textContent).toBe("texture.png");
    expect(screen.getByTestId("file-node-choose")).toBeInTheDocument();
  });

  it("shows its own picture on the card, never the photograph's", () => {
    let s = fresh();
    s = run(s, { type: "add_node", node: makeNode(specFor("heeler.file")!, "file_1", 0, 300) });
    const Harness = () => {
      const [st, d] = React.useReducer(reduce, s);
      return <NodeEditor state={st} dispatch={d} />;
    };
    render(<Harness />);
    const card = screen.getByTestId("node-file_1");
    // No file: an empty frame that says so, and no borrowed photo.
    expect(card.querySelector("[data-testid='file-thumb-empty']")?.textContent).toBe("No file");
    expect(card.querySelector("img")).toBeNull();
    // The photograph's cards still show the photograph.
    expect(screen.getByTestId("node-src").querySelector("img")).not.toBeNull();
  });

  it("leaves its path behind when the look is saved as a preset", () => {
    let s = fresh();
    s = run(
      s,
      { type: "add_node", node: makeNode(specFor("heeler.file")!, "file_1", 0, 300) },
      { type: "set_text_param", id: "file_1", param: "path", value: "/Users/user/Pictures/texture.png" },
    );
    const preset = capturePreset(s, "Textured");
    expect(preset.nodes.find((n) => n.id === "file_1")!.textParams?.path).toBe("");
  });
});

describe("the Transform node", () => {
  it("is a utility with one image in and out, at identity by default", () => {
    const n = makeNode(specFor("heeler.transform")!, "t1", 0, 0);
    expect(n.hasIn && n.hasOut).toBe(true);
    expect(n.maskIn).toBeFalsy();
    expect(NEUTRAL_PARAMS["heeler.transform"]).toEqual({
      move_x: 0, move_y: 0, size: 100, rotate: 0, pivot_x: 50, pivot_y: 50,
    });
    // Its size runs past the frame; grain's `size` does not.
    expect(paramRange("size", "heeler.transform")).toEqual([1, 400]);
    expect(paramRange("rotate", "heeler.transform")).toEqual([-180, 180]);
  });

  it("offers every dial in the inspector", () => {
    let s = fresh();
    s = run(
      s,
      { type: "add_node", node: makeNode(specFor("heeler.transform")!, "t1", 0, 300) },
      { type: "select_nodes", ids: ["t1"] },
    );
    render(<Inspector state={s} dispatch={() => {}} />);
    for (const p of ["move_x", "move_y", "size", "rotate", "pivot_x", "pivot_y"]) {
      expect(screen.getByTestId(`slider-${p}`), p).toBeInTheDocument();
    }
  });
});

describe("Duplicate", () => {
  it("copies the selection, offset, with the wires among the copies only", () => {
    let s = fresh();
    s = run(s, { type: "duplicate_nodes", ids: ["stdcolor", "exposure"] });
    const copies = s.nodes.filter((n) => !NEUTRAL_NODES.some((k) => k.id === n.id));
    expect(copies.map((c) => c.type).sort()).toEqual(["heeler.exposure", "heeler.standard_color"]);
    const color = copies.find((c) => c.type === "heeler.standard_color")!;
    const orig = s.nodes.find((n) => n.id === "stdcolor")!;
    // The copies move as one block, their spacing kept, clear of every card
    // (2026-09-28: a step down and right landed on the original).
    const origExp = s.nodes.find((n) => n.id === "exposure")!;
    const exposureCopy = copies.find((c) => c.type === "heeler.exposure")!;
    expect(exposureCopy.x - color.x).toBe(origExp.x - orig.x);
    expect(exposureCopy.y - color.y).toBe(origExp.y - orig.y);
    for (const c of copies) {
      for (const n of s.nodes.filter((k) => k.id !== c.id)) {
        expect(Math.abs(c.x - n.x) >= NODE_W || Math.abs(c.y - n.y) >= NODE_H).toBe(true);
      }
    }
    expect(color.params).toEqual(orig.params);
    expect(color.id).not.toBe("stdcolor");
    // The wire between the two originals is copied between the two copies.
    const exposure = copies.find((c) => c.type === "heeler.exposure")!;
    expect(s.wires.some((w) => w.from === color.id && w.to === exposure.id)).toBe(true);
    // Nothing from outside the pair reaches a copy, and the copies feed nothing.
    expect(s.wires.some((w) => w.to === color.id && w.from === "src")).toBe(false);
    expect(s.wires.some((w) => w.from === exposure.id && w.to !== color.id)).toBe(false);
    // The copies are the selection now.
    expect(s.selection.sort()).toEqual([color.id, exposure.id].sort());
    // One undo step.
    const back = run(s, { type: "undo" });
    expect(back.nodes).toHaveLength(NEUTRAL_NODES.length);
  });

  it("refuses the photograph, the output and a layer's own cards", () => {
    expect(duplicable("src")).toBe(false);
    expect(duplicable("output")).toBe(false);
    expect(duplicable("layer_1_adj")).toBe(false);
    expect(duplicable("art_m_3")).toBe(false);
    expect(duplicable("exposure")).toBe(true);
    const s = run(fresh(), { type: "duplicate_nodes", ids: ["src", "output"] });
    expect(s.nodes).toHaveLength(NEUTRAL_NODES.length);
  });

  it("is on the context menu and on Ctrl+D in the graph", () => {
    let s = fresh();
    s = run(s, { type: "select_nodes", ids: ["exposure"] });
    const box: { s: State } = { s };
    const Harness = () => {
      const [st, d] = React.useReducer(reduce, s);
      box.s = st;
      return <NodeEditor state={st} dispatch={d} />;
    };
    render(<Harness />);
    fireEvent.contextMenu(screen.getByTestId("graph-surface"), { clientX: 300, clientY: 200 });
    fireEvent.click(screen.getByTestId("menu-duplicate"));
    expect(box.s.nodes).toHaveLength(NEUTRAL_NODES.length + 1);

    const key = COMMANDS.find((h) => h.id === "edit.duplicate")!;
    expect(key.scope).toBe("graph");
    expect(key.binding).toBe("Ctrl+D");
    // Deselect in Develop shares the chord in another scope: a handover,
    // not a clash.
    expect(conflicts({}).get("Ctrl+D") ?? []).toHaveLength(0);

    const sent: Command[] = [];
    const handled = runCommand("edit.duplicate", { ...s, mode: "advanced" }, (c: Command) => sent.push(c));
    expect(handled).toBe(true);
    expect(sent).toEqual([{ type: "duplicate_nodes", ids: ["exposure"] }]);
  });
});

describe("a second picture of another shape", () => {
  it("meets Merge and Blend by a fit choice: new cards fit, saved ones keep stretching", async () => {
    const { PARAM_OPTIONS } = await import("../state");
    for (const type of ["heeler.merge", "heeler.blend"]) {
      // Blend adds "place" for Finish image layers (2026-09-30): the
      // picture on its transform's corners.
      expect(PARAM_OPTIONS[type].fit.map((o) => o.id)).toEqual(
        type === "heeler.blend" ? ["fit", "fill", "stretch", "none", "place"] : ["fit", "fill", "stretch", "none"],
      );
      // Absent key means the old behavior, so a saved graph does not
      // change; a card from the palette carries the choice itself.
      expect(PARAM_TEXT_DEFAULT[type].fit).toBe("stretch");
      expect(makeNode(specFor(type)!, "n", 0, 0).textParams?.fit).toBe("fit");
    }
  });
});

describe("the wires meet the dots", () => {
  it("ends every wire at the center of its port", async () => {
    const { portCenter, inputColor, CHANNEL_PORT } = await import("../ui/graph");
    const card = makeNode(specFor("heeler.exposure")!, "e", 100, 200);
    // The in port is drawn at left -4, top 35 inside a 1px border, 7px
    // square: its center is half a pixel in and 39.5 down.
    expect(portCenter(card, "in")).toEqual({ x: 100.5, y: 239.5 });
    expect(portCenter(card, "out")).toEqual({ x: 100 + 140 - 0.5, y: 239.5 });
    expect(portCenter(card, "mask")).toEqual({ x: 109, y: 200 + 78 - 1 });
    const join = makeNode(specFor("heeler.channel_join")!, "j", 0, 0);
    expect(inputColor(join, "in")).toBe(CHANNEL_PORT.r);
    expect(inputColor(join, "in2")).toBe(CHANNEL_PORT.g);
    expect(inputColor(join, "in3")).toBe(CHANNEL_PORT.b);
    expect(inputColor(card, "in")).toBe("#6b7178");
  });
});

describe("Blend Mode's opacity", () => {
  it("is a live slider on a card fresh from the palette", () => {
    let s = fresh();
    s = run(
      s,
      { type: "add_node", node: makeNode(specFor("heeler.blend")!, "bl1", 0, 300) },
      { type: "select_nodes", ids: ["bl1"] },
    );
    expect(s.nodes.find((n) => n.id === "bl1")!.params.opacity).toBe(100);
    render(<Inspector state={s} dispatch={() => {}} />);
    expect(screen.getByTestId("slider-opacity")).toBeInTheDocument();
    expect(screen.queryByTestId("opacity-none")).toBeNull();
  });
});

describe("the Catalog node", () => {
  /// "What about an input node from another image in the
  /// catalog? ... Sometimes people like to create double exposure
  /// effects."
  it("is a source with a photo and a mode, developed by default", () => {
    const n = makeNode(specFor("heeler.catalog")!, "cat_1", 0, 0);
    expect(n.hasIn).toBe(false);
    expect(n.hasOut).toBe(true);
    expect(PARAM_TEXT_DEFAULT["heeler.catalog"]).toEqual({ image: "", mode: "developed" });
  });

  it("walks folders like the tree: Up, subfolders, then this folder's photographs", async () => {
    const { mockAddSubfolder } = await import("../bridge");
    let s = fresh();
    // A session with a folder on screen, one level below the tree's root
    // (the mock library's folders live under "mock:/").
    const root = "mock:/";
    const here = "mock://wedding";
    mockAddSubfolder(here, "Ceremony");
    s = {
      ...s,
      activeFolderPath: here,
      folderTree: { name: "mock", path: root, expanded: true, children: null },
      folders: [{ id: 1, name: "Wedding", path: here, count: 3, lastOpened: 0 }],
    };
    s = run(
      s,
      { type: "add_node", node: makeNode(specFor("heeler.catalog")!, "cat_1", 0, 300) },
      { type: "select_nodes", ids: ["cat_1"] },
    );
    render(<Inspector state={s} dispatch={() => {}} />);
    fireEvent.click(screen.getByTestId("catalog-node-choose"));
    // Mode sits above the browser; the browser scrolls inside a bound.
    const mode = screen.getByRole("button", { name: "Mode" });
    const picker = screen.getByTestId("catalog-picker");
    expect(mode.compareDocumentPosition(picker) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    const list = screen.getByTestId("catalog-picker-list");
    expect(list.style.maxHeight).toBe("260px");
    expect(list.style.overflowY).toBe("auto");
    // Opens in the folder on screen, with its subfolder above its photos.
    expect(screen.getByTestId("catalog-picker-folder").textContent).toBe("wedding");
    expect(await screen.findByTestId("catalog-folder-Ceremony")).toBeInTheDocument();
    const other = s.images.find((i) => i.id !== s.activeImage)!;
    expect(screen.getByTestId(`catalog-pick-${other.id}`)).toBeInTheDocument();
    expect(screen.queryByTestId(`catalog-pick-${s.activeImage}`)).toBeNull();
    // Grid by default; the list view shows names, on the same two
    // glyphs the ribbon switches with.
    expect(screen.getByTestId("catalog-picker-photos").style.display).toBe("grid");
    expect(screen.getByTestId("catalog-picker-view-grid").getAttribute("data-active")).toBe("true");
    fireEvent.click(screen.getByTestId("catalog-picker-view-list"));
    expect(screen.getByTestId(`catalog-pick-${other.id}`).textContent).toContain(other.name);
    fireEvent.click(screen.getByTestId("catalog-picker-view-grid"));
    // Up goes to the root, which the catalog has not scanned: it says so
    // and points at the Library. Up from the root goes nowhere.
    const up = screen.getByTestId("catalog-picker-up");
    expect(up).not.toBeDisabled();
    fireEvent.click(up);
    expect(screen.getByTestId("catalog-picker-folder").textContent).toBe("mock:");
    expect((await screen.findByTestId("catalog-picker-unscanned")).textContent).toMatch(/Open this folder in the Library/);
    expect(screen.getByTestId("catalog-picker-up")).toBeDisabled();
    // Nothing about the session moved.
    expect(s.activeFolderPath).toBe(here);
  });

  it("keeps the folder walk usable while a folder's photographs are still reading", async () => {
    const { mockAddSubfolder } = await import("../bridge");
    let s = fresh();
    const root = "mock:/";
    const here = "mock://wedding";
    const ceremony = "mock://wedding/Ceremony";
    mockAddSubfolder(here, "Ceremony");
    s = {
      ...s,
      activeFolderPath: here,
      folderTree: { name: "mock", path: root, expanded: true, children: null },
      folders: [{ id: 1, name: "Wedding", path: here, count: 3, lastOpened: 0 }],
    };
    s = run(
      s,
      { type: "add_node", node: makeNode(specFor("heeler.catalog")!, "cat_1", 0, 300) },
      { type: "select_nodes", ids: ["cat_1"] },
    );
    (window as any).__TAURI_INTERNALS__ = { invoke: native.invoke };
    // The injected delay stands in for the slow catalog read:
    // the photographs promise stays unresolved while the
    // user keeps walking folders. Against the old synchronous command
    // the whole webview would wait on the read.
    let release!: () => void;
    const read = new Promise<any>(r => { release = () => r(null); });
    native.invoke.mockImplementation((name: string) => {
      if (name === "catalog_folder_images") return read;
      if (name === "list_subfolders") return Promise.resolve([{ name: "Ceremony", path: ceremony }]);
      return Promise.resolve(null);
    });
    render(<Inspector state={s} dispatch={() => {}} />);
    fireEvent.click(screen.getByTestId("catalog-node-choose"));
    fireEvent.click(screen.getByTestId("catalog-picker-up"));
    await waitFor(() => expect(native.invoke.mock.calls.some(([n]) => n === "catalog_folder_images")).toBe(true));
    // The walk does not wait on the read: the subfolder rows render,
    // the list scrolls, and a row still goes down a level.
    const list = screen.getByTestId("catalog-picker-list");
    expect(await screen.findByTestId("catalog-folder-Ceremony")).toBeInTheDocument();
    fireEvent.scroll(list, { target: { scrollTop: 120 } });
    fireEvent.click(screen.getByTestId("catalog-folder-Ceremony"));
    expect(screen.getByTestId("catalog-picker-folder").textContent).toBe("Ceremony");
    await act(async () => { release(); });
  });

  it("picks another photograph by name, never this one", () => {
    let s = fresh();
    s = run(
      s,
      { type: "add_node", node: makeNode(specFor("heeler.catalog")!, "cat_1", 0, 300) },
      { type: "select_nodes", ids: ["cat_1"] },
    );
    const sent: Command[] = [];
    render(<Inspector state={s} dispatch={((c: Command) => sent.push(c)) as never} />);
    expect(screen.getByTestId("catalog-node-name").textContent).toBe("No photograph chosen");
    fireEvent.click(screen.getByTestId("catalog-node-choose"));
    // Every other photo is offered; the active one is not.
    expect(screen.queryByTestId(`catalog-pick-${s.activeImage}`)).toBeNull();
    const other = s.images.find((i) => i.id !== s.activeImage)!;
    expect(screen.getByTestId(`catalog-pick-${other.id}`)).toBeInTheDocument();
    // The filter narrows by name.
    fireEvent.change(screen.getByTestId("catalog-picker-search"), { target: { value: "zzz-no-such" } });
    expect(screen.getByTestId("catalog-picker-empty")).toBeInTheDocument();
    fireEvent.change(screen.getByTestId("catalog-picker-search"), { target: { value: other.name.slice(0, 4) } });
    fireEvent.click(screen.getByTestId(`catalog-pick-${other.id}`));
    expect(sent).toContainEqual({ type: "set_text_param", id: "cat_1", param: "image", value: other.id });
  });

  it("names the photo on the card and shows its rendered thumbnail", () => {
    let s = fresh();
    const other = s.images.find((i) => i.id !== s.activeImage)!;
    s = run(
      s,
      { type: "add_node", node: makeNode(specFor("heeler.catalog")!, "cat_1", 0, 300) },
      { type: "set_text_param", id: "cat_1", param: "image", value: other.id },
    );
    const Harness = () => {
      const [st, d] = React.useReducer(reduce, s);
      return <NodeEditor state={st} dispatch={d} />;
    };
    render(<Harness />);
    expect(screen.getByTestId("source-file-cat_1").textContent).toBe(other.name);
    const card = screen.getByTestId("node-cat_1");
    if (other.src) expect(card.querySelector("[data-testid='catalog-thumb-cat_1']")).not.toBeNull();
    else expect(card.querySelector("[data-testid='catalog-thumb-empty']")).not.toBeNull();
    // The reference is this catalog's; a preset leaves it behind.
    expect(capturePreset(s, "Double").nodes.find((n) => n.id === "cat_1")!.textParams?.image).toBe("");
  });
});

describe("the color key beside the graph", () => {
  it("names its stripe in the status bar and opens the palette to that category", async () => {
    const { paletteItems } = await import("../ui/nodepalette");
    const s = fresh();
    const sent: Command[] = [];
    const Harness = () => <NodeEditor state={s} dispatch={((c: Command) => sent.push(c)) as never} />;
    render(<Harness />);
    const masking = screen.getByTestId("legend-masking");
    expect(masking.getAttribute("data-hint")).toMatch(/^Masking nodes wear this stripe/);
    fireEvent.click(masking);
    expect(sent).toContainEqual({ type: "open_palette", cat: "masking" });
    // Groups are made, not added: the glyph explains and does not open.
    expect(screen.getByTestId("legend-group")).toBeDisabled();
    expect(screen.getByTestId("legend-group").getAttribute("data-hint")).toMatch(/Ctrl\+G/);
    // The palette narrowed to a category lists only that category.
    const items = paletteItems("", [], 10, "masking");
    expect(items.length).toBeGreaterThan(3);
    expect(items.every((i) => i.cat === "masking")).toBe(true);
    // A search inside it still stays inside it.
    expect(paletteItems("blur", [], 10, "masking")).toEqual([]);
    expect(paletteItems("mask", [], 10, "masking").every((i) => i.cat === "masking")).toBe(true);
  });
});

describe("review fixes", () => {
  it("a drop lands on the nearest port, edge pixels included", async () => {
    const { inputAt, inputY } = await import("../ui/graph");
    const join = makeNode(specFor("heeler.channel_join")!, "j", 0, 100);
    expect(inputAt(join, 100 + inputY(join, "in"))).toBe("in");
    expect(inputAt(join, 100 + inputY(join, "in3"))).toBe("in3");
    expect(inputAt(join, 100 + inputY(join, "in2") + 3)).toBe("in2");
    const merge = makeNode(specFor("heeler.merge")!, "m", 0, 0);
    expect(inputAt(merge, inputY(merge, "in2") + 1)).toBe("in2");
    expect(inputAt(merge, inputY(merge, "in") + 1)).toBe("in");
  });

  it("Up respects the root as a folder, not as a prefix", async () => {
    const { parentFolder } = await import("../ui/graph");
    expect(parentFolder("/photos/2026/wedding", "/photos")).toBe("/photos/2026");
    expect(parentFolder("/photos/2026", "/photos")).toBe("/photos");
    expect(parentFolder("/photos", "/photos")).toBeNull();
    expect(parentFolder("/photos", "/photos/")).toBeNull();
    expect(parentFolder("/photos2/a", "/photos")).toBeNull();
    expect(parentFolder("C:\\shots\\2026", "C:\\shots")).toBe("C:\\shots");
  });

  it("the before pane keeps the crop even when a duplicate crop card sorts first", () => {
    let s = fresh();
    s = run(s, { type: "select_image", id: "4869" });
    s = { ...s, nodes: structuredClone(NEUTRAL_NODES), wires: structuredClone(NEUTRAL_WIRES) };
    s = run(
      s,
      { type: "set_param", id: "crop", param: "crop_w", value: 0.5 },
      { type: "duplicate_nodes", ids: ["crop"] },
    );
    const dup = s.nodes.find((n) => n.type === "heeler.crop_rotate" && n.id !== "crop")!;
    s = { ...s, nodes: [dup, ...s.nodes.filter((n) => n.id !== dup.id)] };
    const before = serializeBeforeGraph(s, "4869") as unknown as {
      nodes: { id: string; type: string; params: Record<string, number> }[];
      connections: { from: string[]; to: string[] }[];
    };
    const crop = before.nodes.find((n) => n.type === "heeler.crop_rotate")!;
    expect(crop.params.crop_w).toBe(0.5);
    expect(before.connections.some((c) => c.to[0] === crop.id)).toBe(true);
  });

  it("a load keeps a Merge the user made theirs", async () => {
    const { migrateGraph } = await import("../state");
    const s = fresh();
    const srcOut = s.wires.find((w) => w.from === "src" && w.kind === "image")!;
    const nodes = [
      ...s.nodes,
      { id: "portra", type: "heeler.group", name: "Portra Grade", cat: "group", x: 0, y: 0, enabled: true, params: {}, isGroup: true, hasOut: true } as NodeCard,
      { id: "merge", type: "heeler.merge", name: "Merge", cat: "utility", x: 0, y: 0, enabled: true, params: { opacity: 72 }, hasIn: true, hasIn2: true, hasOut: true, maskIn: true } as NodeCard,
      makeNode(specFor("heeler.radial_mask")!, "rad", 0, 0),
    ];
    const wires = [
      ...s.wires.filter((w) => w !== srcOut),
      { from: "src", to: "merge", toPort: "in", kind: "image" } as const,
      { from: "portra", to: "merge", toPort: "in2", kind: "group" } as const,
      { from: "merge", to: srcOut.to, toPort: srcOut.toPort, kind: "image" } as const,
      { from: "rad", to: "merge", toPort: "mask", kind: "mask" } as const,
    ];
    const out = migrateGraph(nodes, wires);
    expect(out.nodes.some((n) => n.id === "merge")).toBe(true);
    // The mask wire marked it as theirs; Merge has no mask port in the
    // engine, so the wire (which build_graph always dropped) goes with
    // the dead diamond, and the merge stays on every later load.
    expect(out.wires.some((w) => w.from === "rad" && w.to === "merge")).toBe(false);
    expect(out.nodes.find((n) => n.id === "merge")!.maskIn).toBeFalsy();
    expect(out.nodes.some((n) => n.id === "portra")).toBe(false);
    const again = migrateGraph(out.nodes, out.wires);
    expect(again.nodes.some((n) => n.id === "merge")).toBe(true);
  });
});

describe("Reset on a node", () => {
  it("puts every dial, choice and curve back and leaves strokes and the switch alone", async () => {
    const { nodeResetValues } = await import("../ui/simple");
    let s = initialState();
    s = run(
      s,
      { type: "set_param", id: "exposure", param: "exposure", value: 1.5 },
      { type: "set_enabled", id: "exposure", enabled: false },
      { type: "set_curve", id: "curves", channel: "rgb", curve: [[0, 0.2], [1, 1]] },
      { type: "set_text_param", id: "profile", param: "mode", value: "linear" },
      { type: "set_param", id: "profile", param: "baseline_ev", value: 0 },
    );
    const exposure = s.nodes.find((n) => n.id === "exposure")!;
    s = run(s, { type: "reset_node", id: "exposure", ...nodeResetValues(exposure) });
    expect(s.nodes.find((n) => n.id === "exposure")!.params.exposure).toBe(0);
    // The switch is state, not a setting.
    expect(s.nodes.find((n) => n.id === "exposure")!.enabled).toBe(false);
    const curves = s.nodes.find((n) => n.id === "curves")!;
    s = run(s, { type: "reset_node", id: "curves", ...nodeResetValues(curves) });
    expect(s.nodes.find((n) => n.id === "curves")!.curves).toEqual({});
    // The profile resets to the SHIPPED look, the way its section does.
    const profile = s.nodes.find((n) => n.id === "profile")!;
    s = run(s, { type: "reset_node", id: "profile", ...nodeResetValues(profile) });
    const back = s.nodes.find((n) => n.id === "profile")!;
    expect(back.params.baseline_ev).toBe(PROFILE_DEFAULTS.baseline_ev);
    expect(back.textParams?.mode).toBe("standard");
    // One undo step each.
    const undone = run(s, { type: "undo" });
    expect(undone.nodes.find((n) => n.id === "profile")!.params.baseline_ev).toBe(0);
  });

  it("is in the inspector beside the switch and on the context menu", () => {
    let s = fresh();
    s = run(s, { type: "set_param", id: "exposure", param: "exposure", value: 2 }, { type: "select_nodes", ids: ["exposure"] });
    const sent: Command[] = [];
    render(<Inspector state={s} dispatch={((c: Command) => sent.push(c)) as never} />);
    fireEvent.click(screen.getByTestId("inspector-reset"));
    expect(sent.some((c) => c.type === "reset_node" && c.id === "exposure" && c.values.exposure === 0)).toBe(true);
    const box: { s: State } = { s };
    const Harness = () => {
      const [st, d] = React.useReducer(reduce, s);
      box.s = st;
      return <NodeEditor state={st} dispatch={d} />;
    };
    render(<Harness />);
    fireEvent.contextMenu(screen.getByTestId("graph-surface"), { clientX: 300, clientY: 200 });
    fireEvent.click(screen.getByTestId("menu-reset"));
    expect(box.s.nodes.find((n) => n.id === "exposure")!.params.exposure).toBe(0);
  });
});

describe("a node made of wiring", () => {
  it("explains its ports and what feeds them instead of saying it has nothing", () => {
    let s = initialState();
    s = run(
      s,
      { type: "add_node", node: makeNode(specFor("heeler.conditional")!, "cond", 0, 300) },
      { type: "connect", wire: { from: "exposure", to: "cond", toPort: "in", kind: "image" } },
      { type: "connect", wire: { from: "lummask", to: "cond", toPort: "mask", kind: "mask" } },
      { type: "select_nodes", ids: ["cond"] },
    );
    render(<Inspector state={s} dispatch={() => {}} />);
    expect(screen.queryByTestId("node-no-params")).toBeNull();
    const guide = screen.getByTestId("port-guide");
    expect(guide.textContent).toMatch(/made of its wiring/);
    expect(screen.getByTestId("port-guide-in").textContent).toMatch(/in.*else branch.*Exposure/);
    expect(screen.getByTestId("port-guide-in2").textContent).toMatch(/fg.*then branch.*nothing wired/);
    expect(screen.getByTestId("port-guide-mask").textContent).toMatch(/mask.*condition.*Luminosity|mask.*condition/);
    expect(screen.getByTestId("port-guide-mask").textContent).not.toMatch(/nothing wired/);
  });
});

describe("Detail's own node", () => {
  it("is off and out of the graph until its switch builds it after Color", () => {
    let s = fresh();
    expect(s.nodes.some((n) => n.type === "heeler.detail")).toBe(false);
    s = run(s, { type: "set_category", title: "Detail", on: true });
    const detail = s.nodes.find((n) => n.type === "heeler.detail")!;
    expect(detail.enabled).toBe(true);
    expect(detail.params.texture).toBe(0);
    expect(detail.params.clarity_shadows).toBe(100);
    expect(s.wires.some((w) => w.from === "stdcolor" && w.to === "detail")).toBe(true);
  });

  it("a saved graph with detail on its Color node is split on load, values moved", async () => {
    const { migrateGraph } = await import("../state");
    let s = fresh();
    const nodes = s.nodes.map((n) =>
      n.id === "stdcolor" ? { ...n, params: { ...n.params, texture: 30, clarity: -10, dehaze: 0, clarity_shadows: 60 } } : n,
    );
    const out = migrateGraph(nodes, s.wires);
    const detail = out.nodes.find((n) => n.type === "heeler.detail")!;
    expect(detail).toBeTruthy();
    expect(detail.params).toMatchObject({ texture: 30, clarity: -10, clarity_shadows: 60 });
    const color = out.nodes.find((n) => n.id === "stdcolor")!;
    expect(color.params.texture).toBe(0);
    expect(color.params.clarity).toBe(0);
    expect(color.params.clarity_shadows).toBe(100);
    expect(out.wires.some((w) => w.from === "stdcolor" && w.to === detail.id)).toBe(true);
    // A Color node with nothing on its detail dials builds nothing.
    const clean = migrateGraph(s.nodes, s.wires);
    expect(clean.nodes.some((n) => n.type === "heeler.detail")).toBe(false);
  });

  it("a layer's Color node hands its detail to a layer Detail tool", async () => {
    const { migrateGraph, layersOf } = await import("../state");
    let s = run(fresh(), { type: "add_layer", maskType: "radial" });
    s = run(s, { type: "set_param", id: "layer_1_color", param: "clarity", value: 25 });
    const out = migrateGraph(s.nodes, s.wires);
    const tool = out.nodes.find((n) => n.id === "layer_1_detail")!;
    expect(tool).toBeTruthy();
    expect(tool.params.clarity).toBe(25);
    expect(out.nodes.find((n) => n.id === "layer_1_color")!.params.clarity).toBe(0);
    expect(out.wires.some((w) => w.from === "layer_1_color" && w.to === "layer_1_detail")).toBe(true);
    expect(out.wires.some((w) => w.from === "layer_1_mask" && w.to === "layer_1_detail" && w.toPort === "mask")).toBe(true);
    expect(layersOf({ ...s, nodes: out.nodes } as State).map((l) => l.id)).toEqual(["layer_1_adj"]);
  });

  it("a bypassed Color node splits into a bypassed Detail node", async () => {
    // The switch is part of the edit: a Color node that was off rendered
    // no detail, so the Detail it hands its dials to must arrive off too.
    const { migrateGraph } = await import("../state");
    let s = fresh();
    const nodes = s.nodes.map((n) =>
      n.id === "stdcolor" ? { ...n, enabled: false, params: { ...n.params, texture: 30 } } : n,
    );
    const out = migrateGraph(nodes, s.wires);
    const detail = out.nodes.find((n) => n.type === "heeler.detail")!;
    expect(detail.enabled).toBe(false);
    expect(detail.params.texture).toBe(30);
    expect(out.nodes.find((n) => n.id === "stdcolor")!.enabled).toBe(false);
    // And a layer's copy follows the same rule.
    let l = run(fresh(), { type: "add_layer", maskType: "radial" });
    l = run(l, { type: "set_param", id: "layer_1_color", param: "clarity", value: 25 });
    l = run(l, { type: "set_enabled", id: "layer_1_color", enabled: false });
    const outL = migrateGraph(l.nodes, l.wires);
    expect(outL.nodes.find((n) => n.id === "layer_1_detail")!.enabled).toBe(false);
  });
});

describe("Detail's switch", () => {
  it("reads off when its node is off, whatever the stand-ins say", async () => {
    const { SimplePanel } = await import("../ui/simple");
    let s = fresh();
    s = run(s, { type: "set_category", title: "Detail", on: true });
    s = run(s, { type: "set_enabled", id: "detail", enabled: false });
    render(<SimplePanel state={s} dispatch={(() => {}) as never} />);
    expect(screen.getByTestId("toggle-detail").getAttribute("data-on")).toBe("false");
  });
});

describe("the Detail split reaches every consumer", () => {
  it("a Color node feeding two branches hands both to the Detail node", async () => {
    const { migrateGraph } = await import("../state");
    let s = fresh();
    s = run(s, { type: "add_node", node: makeNode(specFor("heeler.blend")!, "bl", 600, 400) });
    s = run(s, { type: "connect", wire: { from: "stdcolor", to: "bl", toPort: "in2", kind: "image" } });
    const nodes = s.nodes.map((n) => (n.id === "stdcolor" ? { ...n, params: { ...n.params, clarity: 20 } } : n));
    const out = migrateGraph(nodes, s.wires);
    const detail = out.nodes.find((n) => n.type === "heeler.detail")!;
    expect(out.wires.some((w) => w.from === detail.id && w.to === "bl" && w.toPort === "in2")).toBe(true);
    expect(out.wires.some((w) => w.from === "stdcolor" && w.to === "bl")).toBe(false);
    expect(out.wires.filter((w) => w.from === "stdcolor")).toHaveLength(1);
  });

  it("a demo Merge the user retuned is theirs and stays", async () => {
    const { migrateGraph } = await import("../state");
    const s = fresh();
    const srcOut = s.wires.find((w) => w.from === "src" && w.kind === "image")!;
    const nodes = [
      ...s.nodes,
      { id: "merge", type: "heeler.merge", name: "Merge", cat: "utility", x: 0, y: 0, enabled: true, params: { opacity: 40 }, hasIn: true, hasIn2: true, hasOut: true } as NodeCard,
    ];
    const wires = [
      ...s.wires.filter((w) => w !== srcOut),
      { from: "src", to: "merge", toPort: "in", kind: "image" } as const,
      { from: "merge", to: srcOut.to, toPort: srcOut.toPort, kind: "image" } as const,
    ];
    expect(migrateGraph(nodes, wires).nodes.some((n) => n.id === "merge")).toBe(true);
  });
});
