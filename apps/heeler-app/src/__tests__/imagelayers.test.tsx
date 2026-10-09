// Finish image layers (2026-09-30: "some new finish layers. We already
// had file and catalog for nodes. Expose these as layers, that a user
// can bring in an image. They will need to have transform controls
// (which we already have nodes for) so a user can interactively position
// on the canvas.").
//
// What is held here: each kind of image layer and the graph it builds;
// the transform's arithmetic, typed or dragged, landing on the same four
// corners the engine reads; one undo per drag; Escape and Enter; the
// handles' pointer math at device pixel ratios 1, 1.5 and 2 and under a
// UI zoom; save and reload; a missing file in words; and the Pro gate.
import { afterEach, describe, expect, it } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { initialState } from "../data";
import {
  artFindLayer,
  artLayers,
  artMaskOf,
  cropNode,
  isPlacedLayer,
  layerBox,
  layerQuad,
  reduce,
  transformBox,
  type Command,
  type State
} from "../state";
import { runCommand } from "../commands";
import { loadGraph, saveGraph, serializeGraph } from "../bridge";
import { cornersOf } from "../quadmap";
import {
  applyPlacement,
  crossing,
  fittedBox,
  flipQuad,
  noteFrameAspect,
  placementOf,
  scaleByHandle,
  snapMove,
  type Pt,
} from "../imagelayers";
import { CatalogLayerDialog, ImageLayerControls, TransformFields } from "../ui/imagelayers";
import { TransformOverlay, framePoint } from "../ui/overlays";
import { previewSourceBox } from "../ui/transformpreview";


function run(s: State, ...cmds: Command[]): State {
  return cmds.reduce(reduce, s);
}

/** A 3:2 frame, as the viewer notes it for the photo on screen, with
 * the Finish tab up (its tools are only in hand while it is). */
function framed(s: State = initialState()): State {
  noteFrameAspect(s.activeImage, 1.5);
  return { ...s, mode: "simple", panelTab: "layers" };
}

/** A 2:1 picture's rest box in that 3:2 frame: full width, 0.75 high. */
const REST = { x: 0, y: 0.125, w: 1, h: 0.75 };

function withFileLayer(s: State = framed()): { s: State; id: string } {
  const out = run(s, {
    type: "art_add_image_layer",
    source: { kind: "file", path: "/pictures/logo.png" },
    name: "logo",
    box: REST,
  });
  return { s: out, id: out.artActive! };
}

const close = (a: Pt[], b: Pt[]) =>
  a.forEach((p, i) => {
    expect(p[0]).toBeCloseTo(b[i][0], 6);
    expect(p[1]).toBeCloseTo(b[i][1], 6);
  });

describe("adding an image layer", () => {
  it("from a file: a File node in display space under a blend that places it", () => {
    const { s, id } = withFileLayer();
    const layer = artLayers(s).find((l) => l.blend.id === id)!;
    expect(layer.content.type).toBe("heeler.file");
    expect(layer.content.artKind).toBe("image");
    expect(layer.content.textParams).toMatchObject({ path: "/pictures/logo.png", layer: "", space: "display" });
    expect(layer.blend.textParams).toMatchObject({ fit: "place", mode: "normal" });
    expect(layer.blend.name).toBe("logo");
    expect(isPlacedLayer(s, id)).toBe(true);
    // Centered and fitted: on its rest box, nothing moved yet.
    expect(layerBox(s, id)).toEqual(REST);
    close(layerQuad(s, id) as Pt[], [[0, 0.125], [1, 0.125], [1, 0.875], [0, 0.875]]);
  });

  it("from the catalog: a Catalog node, developed, in display space", () => {
    const s0 = framed();
    const other = s0.images.find((i) => i.id !== s0.activeImage)!;
    const s = run(s0, { type: "art_add_image_layer", source: { kind: "catalog", image: other.id }, name: other.name, box: REST });
    const layer = artLayers(s).find((l) => l.blend.id === s.artActive)!;
    expect(layer.content.type).toBe("heeler.catalog");
    expect(layer.content.artKind).toBe("catalog_image");
    expect(layer.content.textParams).toMatchObject({ image: other.id, mode: "developed", space: "display" });
    expect(layer.blend.textParams?.fit).toBe("place");
  });

  it("is one undo step", () => {
    const { s } = withFileLayer();
    expect(artLayers(s)).toHaveLength(1);
    expect(artLayers(run(s, { type: "undo" }))).toHaveLength(0);
  });

  it("builds the graph the engine renders: file into the blend's layer port, the corners on the blend", () => {
    const { s, id } = withFileLayer();
    const g = serializeGraph(s) as unknown as { nodes: { id: string; type: string; params: Record<string, unknown> }[]; connections: { from: [string, string]; to: [string, string] }[] };
    const content = artFindLayer(s, id)!.content.id;
    const file = g.nodes.find((n) => n.id === content)!;
    expect(file.type).toBe("heeler.file");
    expect(file.params).toMatchObject({ path: "/pictures/logo.png", space: "display" });
    const blend = g.nodes.find((n) => n.id === id)!;
    expect(blend.params).toMatchObject({ fit: "place", warp_bx: 0, warp_by: 0.125, warp_bw: 1, warp_bh: 0.75, warp_x2: 1, warp_y2: 0.875 });
    // The layer on the blend's second image, which the desktop reads as
    // its "blend" port.
    expect(g.connections.some((c) => c.from[0] === content && c.to[0] === id && c.to[1] === "fg")).toBe(true);
  });

  it("a layer clipped to an image layer clips to the picture where it was placed", () => {
    const { s, id } = withFileLayer();
    const moved = run(s, {
      type: "art_set_quad",
      id,
      box: REST,
      corners: [[0.1, 0.2], [0.5, 0.2], [0.5, 0.4], [0.1, 0.4]],
    });
    const withFill = run(moved, { type: "art_add_layer", kind: "fill" });
    const fill = withFill.artActive!;
    const clipped = run(withFill, { type: "art_clip_layer", id: fill, clip: true });
    const g = serializeGraph(clipped) as unknown as { nodes: { id: string; params: Record<string, unknown> }[] };
    expect(g.nodes.find((n) => n.id === fill)!.params.clip_place).toBe(
      "place;0,0.125,1,0.75,0.1,0.2,0.5,0.2,0.5,0.4,0.1,0.4,1.5",
    );
    // A layer clipped to a plain, unmoved layer carries nothing extra.
    const plain = run(framed(), { type: "art_add_layer", kind: "fill" }, { type: "art_add_layer", kind: "fill" });
    const top = plain.artActive!;
    const g2 = serializeGraph(run(plain, { type: "art_clip_layer", id: top, clip: true })) as unknown as { nodes: { id: string; params: Record<string, unknown> }[] };
    expect(g2.nodes.find((n) => n.id === top)!.params.clip_place).toBeUndefined();
  });

  it("duplicates like any layer: the copy above, same picture and place, its own mask", () => {
    const { s, id } = withFileLayer();
    const moved = run(
      s,
      { type: "art_set_quad", id, box: REST, corners: [[0.1, 0.2], [0.5, 0.2], [0.5, 0.4], [0.1, 0.4]] },
      { type: "art_add_mask", id, kind: "brush" } as Command,
    );
    const dup = run(moved, { type: "art_duplicate_layer", id });
    const ls = artLayers(dup);
    expect(ls).toHaveLength(2);
    const copy = ls[1];
    expect(copy.blend.id).not.toBe(id);
    expect(dup.artActive).toBe(copy.blend.id);
    expect(copy.content.textParams).toMatchObject({ path: "/pictures/logo.png", space: "display" });
    expect(copy.blend.name).toBe("logo copy");
    expect(layerQuad(dup, copy.blend.id)).toEqual(layerQuad(moved, id));
    expect(isPlacedLayer(dup, copy.blend.id)).toBe(true);
    // Its own mask, wired to its own blend.
    const mask = artMaskOf(dup, copy.blend.id);
    expect(mask).toBeDefined();
    expect(mask!.id).not.toBe(artMaskOf(dup, id)!.id);
    const g = serializeGraph(dup) as unknown as { connections: { from: [string, string]; to: [string, string] }[] };
    expect(g.connections.some((c) => c.from[0] === mask!.id && c.to[0] === copy.blend.id && c.to[1] === "mask")).toBe(true);
    // One undo step, and deleting the copy leaves the original.
    expect(artLayers(run(dup, { type: "undo" }))).toHaveLength(1);
    const removed = run(dup, { type: "art_remove_layer", id: copy.blend.id });
    expect(artLayers(removed).map((l) => l.blend.id)).toEqual([id]);
  });

  it("measures the Transform tool's box from the rest box, not the visible pixels", () => {
    const { s, id } = withFileLayer();
    expect(transformBox(s, id)).toEqual(REST);
    // And the drag preview maps the whole picture onto the corners.
    expect(previewSourceBox(s, id)).toEqual({ x: 0, y: 0, w: 1, h: 1 });
  });

  it("the panel's image menu opens the catalog picker, and a pick makes the layer", async () => {
    const s = run(framed(), { type: "open_catalog_layer_pick" });
    const other = s.images.find((i) => i.id !== s.activeImage && !i.missing)!;
    const seen: Command[] = [];
    render(<CatalogLayerDialog state={s} dispatch={(c) => seen.push(c)} />);
    fireEvent.click(screen.getByTestId(`catalog-pick-${other.id}`));
    await waitFor(() => expect(seen.some((c) => c.type === "art_add_image_layer")).toBe(true));
    const add = seen.find((c) => c.type === "art_add_image_layer") as Extract<Command, { type: "art_add_image_layer" }>;
    expect(add.source).toEqual({ kind: "catalog", image: other.id });
    // The browser build's probe answers 1500 by 1000: the same shape as
    // the frame, so it fills it.
    expect(add.box).toEqual({ x: 0, y: 0, w: 1, h: 1 });
    expect(seen).toContainEqual({ type: "close_catalog_layer_pick" });
  });
});

describe("the arithmetic", () => {
  it("fits a picture inside the frame, centered, its own shape kept", () => {
    expect(fittedBox(2000, 1000, 1.5)).toEqual(REST);
    const tall = fittedBox(1000, 2000, 1.5);
    expect(tall.h).toBe(1);
    expect(tall.w).toBeCloseTo(1 / 3, 9);
    expect(tall.x).toBeCloseTo(1 / 3, 9);
    // Unknown sizes fill the frame, the engine's reading of no box.
    expect(fittedBox(0, 0, 1.5)).toEqual({ x: 0, y: 0, w: 1, h: 1 });
  });

  it("reads a quad as position, size and angle, and writes it back", () => {
    const quad: Pt[] = [[0, 0.125], [1, 0.125], [1, 0.875], [0, 0.875]];
    expect(placementOf(quad, REST, 1.5)).toMatchObject({ x: 50, y: 50, sx: 100, sy: 100, rotate: 0, mirrored: false });
    const moved = applyPlacement(quad, REST, 1.5, { x: 30, y: 40 });
    expect(placementOf(moved, REST, 1.5)).toMatchObject({ x: expect.closeTo(30, 6), y: expect.closeTo(40, 6), sx: expect.closeTo(100, 6) });
    const turned = applyPlacement(moved, REST, 1.5, { rotate: 30 });
    const p = placementOf(turned, REST, 1.5);
    expect(p.rotate).toBeCloseTo(30, 6);
    // A turn in pixels, not a shear in fractions: the sides stay square
    // and the size stays put on a 3:2 frame.
    expect(p.sx).toBeCloseTo(100, 6);
    expect(p.sy).toBeCloseTo(100, 6);
    expect(p.x).toBeCloseTo(30, 6);
    const halved = applyPlacement(turned, REST, 1.5, { sx: 50 });
    expect(placementOf(halved, REST, 1.5)).toMatchObject({ sx: expect.closeTo(50, 6), sy: expect.closeTo(100, 6), rotate: expect.closeTo(30, 6) });
    const locked = applyPlacement(turned, REST, 1.5, { sx: 50 }, true);
    expect(placementOf(locked, REST, 1.5)).toMatchObject({ sx: expect.closeTo(50, 6), sy: expect.closeTo(50, 6) });
  });

  it("flips on the layer's own axis, and a flip reads as mirrored at the same angle", () => {
    const quad: Pt[] = [[0.2, 0.2], [0.6, 0.2], [0.6, 0.6], [0.2, 0.6]];
    const flipped = flipQuad(quad, "h");
    expect(flipped[0]).toEqual([0.6, 0.2]);
    const p = placementOf(flipped, { x: 0.2, y: 0.2, w: 0.4, h: 0.4 }, 1);
    expect(p.mirrored).toBe(true);
    expect(p.rotate).toBe(0);
    expect(flipQuad(flipQuad(quad, "v"), "v")).toEqual(quad);
  });

  it("an edge scales its own axis from the opposite edge; Shift keeps proportions", () => {
    const quad: Pt[] = [[0.2, 0.2], [0.6, 0.2], [0.6, 0.6], [0.2, 0.6]];
    // The right edge (e1) pulled from 0.6 to 0.8: left edge stays.
    const wide = scaleByHandle(quad, "e1", [0.8, 0.4], 1, { uniform: false, fromCenter: false });
    close(wide, [[0.2, 0.2], [0.8, 0.2], [0.8, 0.6], [0.2, 0.6]]);
    const both = scaleByHandle(quad, "e1", [0.8, 0.4], 1, { uniform: true, fromCenter: false });
    close(both, [[0.2, 0.1], [0.8, 0.1], [0.8, 0.7], [0.2, 0.7]]);
    // Option holds the center.
    const centered = scaleByHandle(quad, "e1", [0.8, 0.4], 1, { uniform: false, fromCenter: true });
    close(centered, [[0, 0.2], [0.8, 0.2], [0.8, 0.6], [0, 0.6]]);
  });

  it("snaps a move to the frame's center and edges within the tolerance", () => {
    const quad: Pt[] = [[0.2, 0.2], [0.6, 0.2], [0.6, 0.6], [0.2, 0.6]];
    // Center at 0.4; moved by 0.095 lands 0.005 short of the middle.
    const snap = snapMove(quad, 0.095, 0, [0.01, 0.01]);
    expect(snap.dx).toBeCloseTo(0.1, 9);
    expect(snap.guides.x).toEqual([0.5]);
    // The left edge to the frame's left.
    expect(snapMove(quad, -0.195, 0, [0.01, 0.01]).dx).toBeCloseTo(-0.2, 9);
    // Nothing near: the move as it was.
    const free = snapMove(quad, 0.05, 0.03, [0.01, 0.01]);
    expect(free).toEqual({ dx: 0.05, dy: 0.03, guides: { x: [], y: [] } });
  });
});

/** The overlay mounted over a 300 by 200 frame at the given DPR and CSS
 * zoom, the way the viewer mounts it round a placed layer. */
function mountOverlay(
  s: State,
  id: string,
  seen: Command[],
  opts: { dpr?: number; zoom?: number; lock?: boolean; aspect?: number } = {},
) {
  const dpr = opts.dpr ?? 1;
  const zoom = opts.zoom ?? 1;
  Object.defineProperty(window, "devicePixelRatio", { value: dpr, configurable: true });
  const r = render(
    <TransformOverlay
      blendId={id}
      box={transformBox(s, id)}
      quad={layerQuad(s, id) as Pt[]}
      mode="transform"
      dispatch={(c) => seen.push(c)}
      aspect={opts.aspect ?? 1.5}
      lock={opts.lock}
    />,
  );
  const root = screen.getByTestId("transform-overlay-transform");
  // Layout size in offsets; the client rect is the zoomed one, as a
  // CSS zoom on an ancestor makes it, and currentCSSZoom says so.
  Object.defineProperty(root, "offsetWidth", { value: 300, configurable: true });
  Object.defineProperty(root, "offsetHeight", { value: 200, configurable: true });
  Object.defineProperty(root, "currentCSSZoom", { value: zoom, configurable: true });
  root.getBoundingClientRect = () =>
    ({ left: 10 * zoom, top: 20 * zoom, width: 300 * zoom, height: 200 * zoom, right: 310 * zoom, bottom: 220 * zoom }) as DOMRect;
  return { r, root, at: (fx: number, fy: number) => ({ clientX: (10 + fx * 300) * zoom, clientY: (20 + fy * 200) * zoom }) };
}

function lastQuad(seen: Command[]): Pt[] {
  const w = [...seen].reverse().find((c) => c.type === "art_set_quad") as { corners: Pt[] } | undefined;
  if (!w) throw new Error("no quad written");
  return w.corners;
}

const nextFrame = () => new Promise((r) => requestAnimationFrame(() => r(null)));

describe("the handles on the canvas", () => {
  afterEach(() => Object.defineProperty(window, "devicePixelRatio", { value: 1, configurable: true }));

  for (const dpr of [1, 1.5, 2]) {
    for (const zoom of [1, 1.15]) {
      it(`a drag lands the same corners at DPR ${dpr} and UI zoom ${zoom}`, async () => {
        const { s, id } = withFileLayer();
        const seen: Command[] = [];
        const { root, at, r } = mountOverlay(s, id, seen, { dpr, zoom });
        // The pointer maps to the frame the same at every ratio and zoom.
        const p = framePoint(at(0.25, 0.75), root);
        expect(p[0]).toBeCloseTo(0.25, 9);
        expect(p[1]).toBeCloseTo(0.75, 9);
        // Bottom-right corner (1, 0.875) pulled to (0.8, 0.7): the top-left
        // stays, each side scales on its own.
        fireEvent.mouseDown(screen.getByTestId("transform-handle-2"), at(1, 0.875));
        fireEvent.mouseMove(root, { ...at(0.8, 0.7), buttons: 1 });
        fireEvent.mouseUp(root);
        close(lastQuad(seen), [[0, 0.125], [0.8, 0.125], [0.8, 0.7], [0, 0.7]]);
        r.unmount();
        await nextFrame();
      });
    }
  }

  it("draws edge handles and turning rings, and places handles by percent, not pixels", () => {
    const { s, id } = withFileLayer();
    mountOverlay(s, id, [], { dpr: 2 });
    for (const k of [0, 1, 2, 3]) expect(screen.getByTestId(`transform-edge-${k}`)).toBeInTheDocument();
    expect(screen.getByTestId("transform-edge-1").style.left).toBe("100%");
    expect(screen.getByTestId("transform-edge-1").style.top).toBe("50%");
    expect(screen.getByTestId("transform-handle-0").style.top).toBe("12.5%");
    for (const i of [0, 1, 2, 3]) expect(screen.getByTestId(`transform-rotate-zone-${i}`)).toBeInTheDocument();
  });

  it("drags a layer past the frame's edge, which the clamped pointer used to stop", async () => {
    const { s, id } = withFileLayer();
    const seen: Command[] = [];
    const { root, at } = mountOverlay(s, id, seen);
    fireEvent.mouseDown(screen.getByTestId("transform-body"), at(0.5, 0.5));
    fireEvent.mouseMove(root, { ...at(1.3, 0.5), buttons: 1, metaKey: true });
    fireEvent.mouseUp(root);
    expect(lastQuad(seen)[0][0]).toBeCloseTo(0.8, 6);
  });

  it("snaps the move to the frame's center and shows the line while it holds", () => {
    const { s, id } = withFileLayer();
    const seen: Command[] = [];
    const { root, at } = mountOverlay(s, id, seen);
    fireEvent.mouseDown(screen.getByTestId("transform-body"), at(0.5, 0.5));
    // Three screen pixels right of center: inside the six-pixel snap.
    fireEvent.mouseMove(root, { ...at(0.51, 0.5), buttons: 1 });
    expect(screen.getByTestId("transform-guide-x").style.display).toBe("");
    fireEvent.mouseUp(root);
    expect(lastQuad(seen)[0][0]).toBeCloseTo(0, 9);
    expect(screen.getByTestId("transform-guide-x").style.display).toBe("none");
  });

  it("turns the layer from the ring outside a corner", () => {
    const { s, id } = withFileLayer();
    const seen: Command[] = [];
    const { root, at } = mountOverlay(s, id, seen);
    fireEvent.mouseDown(screen.getByTestId("transform-rotate-zone-1"), at(1, 0.125));
    fireEvent.mouseMove(root, { ...at(1.2, 0.5), buttons: 1 });
    fireEvent.mouseUp(root);
    const p = placementOf(lastQuad(seen), REST, 1.5);
    expect(Math.abs(p.rotate)).toBeGreaterThan(10);
    expect(p.sx).toBeCloseTo(100, 4);
    expect(p.x).toBeCloseTo(50, 6);
  });

  it("keeps proportions with the lock, and Shift frees them for one drag", () => {
    const { s, id } = withFileLayer();
    const seen: Command[] = [];
    const { root, at } = mountOverlay(s, id, seen, { lock: true });
    fireEvent.mouseDown(screen.getByTestId("transform-handle-2"), at(1, 0.875));
    fireEvent.mouseMove(root, { ...at(0.5, 0.8), buttons: 1 });
    fireEvent.mouseUp(root);
    const p = placementOf(lastQuad(seen), REST, 1.5);
    expect(p.sx).toBeCloseTo(p.sy, 6);
    seen.length = 0;
    fireEvent.mouseDown(screen.getByTestId("transform-handle-2"), at(1, 0.875));
    fireEvent.mouseMove(root, { ...at(0.5, 0.8), buttons: 1, shiftKey: true });
    fireEvent.mouseUp(root);
    const q = placementOf(lastQuad(seen), REST, 1.5);
    expect(q.sx).toBeCloseTo(50, 4);
    expect(q.sy).not.toBeCloseTo(50, 1);
  });
});

describe("numbers and handles are one transform", () => {
  it("a typed move and the same move dragged write the same render request", async () => {
    const { s, id } = withFileLayer();
    // Typed: X from 50 to 30.
    const typed: Command[] = [];
    const t = render(<TransformFields state={s} blendId={id} dispatch={(c) => typed.push(c)} />);
    const x = screen.getByTestId(`art-xform-x-${id}`);
    fireEvent.focus(x);
    fireEvent.change(x, { target: { value: "30" } });
    fireEvent.keyDown(x, { key: "Enter" });
    t.unmount();
    const byNumber = run(s, ...typed);
    // Dragged: the body moved a fifth of the frame left, snapping off.
    const dragged: Command[] = [];
    const { root, at } = mountOverlay(s, id, dragged);
    fireEvent.mouseDown(screen.getByTestId("transform-body"), at(0.5, 0.5));
    fireEvent.mouseMove(root, { ...at(0.3, 0.5), buttons: 1, metaKey: true });
    fireEvent.mouseUp(root);
    const byHand = run(s, ...dragged);
    const blend = (st: State) =>
      (serializeGraph(st) as unknown as { nodes: { id: string; params: Record<string, number> }[] }).nodes.find((n) => n.id === id)!.params;
    for (const k of ["warp_bx", "warp_by", "warp_bw", "warp_bh", "warp_x0", "warp_y0", "warp_x1", "warp_y1", "warp_x2", "warp_y2", "warp_x3", "warp_y3"]) {
      expect(blend(byNumber)[k]).toBeCloseTo(blend(byHand)[k], 9);
    }
    expect(blend(byHand).warp_x0).toBeCloseTo(-0.2, 9);
  });

  it("a whole drag is one undo step", () => {
    const { s, id } = withFileLayer();
    const seen: Command[] = [];
    const { root, at } = mountOverlay(s, id, seen);
    fireEvent.mouseDown(screen.getByTestId("transform-body"), at(0.5, 0.5));
    for (const fx of [0.45, 0.4, 0.35, 0.3]) {
      fireEvent.mouseMove(root, { ...at(fx, 0.5), buttons: 1, metaKey: true });
    }
    fireEvent.mouseUp(root);
    const after = run(s, ...seen);
    expect(layerQuad(after, id)[0][0]).toBeCloseTo(-0.2, 9);
    const undone = run(after, { type: "undo" });
    close(layerQuad(undone, id) as Pt[], layerQuad(s, id) as Pt[]);
  });

  it("reset and the typed angle each write one quad", () => {
    const { s: base, id } = withFileLayer();
    const s = run(base, { type: "art_set_quad", id, box: REST, corners: [[1, 0.125], [0, 0.125], [0, 0.875], [1, 0.875]] });
    const seen: Command[] = [];
    render(<TransformFields state={s} blendId={id} dispatch={(c) => seen.push(c)} />);
    fireEvent.click(screen.getByTestId(`art-xform-reset-${id}`));
    close(lastQuad(seen), [[0, 0.125], [1, 0.125], [1, 0.875], [0, 0.875]]);
    const angle = screen.getByTestId(`art-xform-rotate-${id}`);
    fireEvent.focus(angle);
    fireEvent.change(angle, { target: { value: "90" } });
    fireEvent.keyDown(angle, { key: "Enter" });
    expect(placementOf(lastQuad(seen), REST, 1.5).rotate).toBeCloseTo(90, 6);
  });
});

describe("Escape and Enter", () => {
  it("Escape puts the corners back as the tool found them; Enter keeps them", () => {
    const { s: base, id } = withFileLayer();
    const armed = run(base, { type: "set_tool", tool: "transform" });
    const moved = run(armed, {
      type: "art_set_quad",
      id,
      box: REST,
      corners: [[0.1, 0.1], [0.5, 0.1], [0.5, 0.4], [0.1, 0.4]],
    });
    const out: Command[] = [];
    runCommand("tool.cancel", moved, (c) => out.push(c));
    const canceled = run(moved, ...out);
    expect(canceled.tool).toBe("none");
    close(layerQuad(canceled, id) as Pt[], layerQuad(base, id) as Pt[]);
    const kept: Command[] = [];
    runCommand("tool.apply", moved, (c) => kept.push(c));
    const applied = run(moved, ...kept);
    expect(applied.tool).toBe("none");
    expect(layerQuad(applied, id)[0]).toEqual([0.1, 0.1]);
  });
});

describe("the picture going missing", () => {
  it("says the file is missing and where it was, and offers to relink", async () => {
    const s = run(framed(), {
      type: "art_add_image_layer",
      source: { kind: "file", path: "/Volumes/Old/missing-logo.png" },
      name: "logo",
      box: REST,
    });
    const layer = artLayers(s).find((l) => l.blend.id === s.artActive)!;
    render(<ImageLayerControls layer={layer} active state={s} dispatch={() => {}} />);
    const note = await screen.findByTestId(`art-image-missing-${layer.blend.id}`);
    expect(note.textContent).toContain("missing");
    expect(note.textContent).toContain("/Volumes/Old/missing-logo.png");
    const relink = screen.getByTestId(`art-image-choose-${layer.blend.id}`);
    expect(relink.getAttribute("aria-label")).toBe("Relink");
    expect(relink.getAttribute("data-hint")).toMatch(/^Relink: /);
    expect(relink.querySelector('[data-testid="xform-icon-relink"]')).not.toBeNull();
  });

  it("another picture keeps the placement and its own proportions", () => {
    const { s, id } = withFileLayer();
    const moved = run(s, {
      type: "art_set_quad",
      id,
      box: REST,
      corners: applyPlacement(layerQuad(s, id) as Pt[], REST, 1.5, { x: 30 }),
    });
    // A square picture this time: its rest box is 2/3 wide, centered.
    const square = fittedBox(1000, 1000, 1.5);
    const out = run(moved, { type: "art_image_source", id, source: { kind: "file", path: "/pictures/square.png" }, box: square });
    expect(artFindLayer(out, id)!.content.textParams?.path).toBe("/pictures/square.png");
    const p = placementOf(layerQuad(out, id) as Pt[], layerBox(out, id), 1.5);
    expect(p.x).toBeCloseTo(30, 6);
    expect(p.sx).toBeCloseTo(100, 6);
    expect(p.sy).toBeCloseTo(100, 6);
  });
});

// 2026-09-30: "yes, fix the frame shape issue for Finish layers". A
// placed picture keeps its own proportions and its place when the frame
// changes shape: its center stays at the same fraction of the frame and
// its size in short sides (placedOnFrame, the engine's
// placement_on_frame).
describe("the frame's shape changing under a placed picture", () => {
  /** A square picture on the 3:2 frame: 0.2 of its width is 0.3 of its
   * height, centered at (0.7, 0.7). */
  const SQUARE = { x: 0.6, y: 0.55, w: 0.2, h: 0.3 };
  function withSquare(): { s: State; id: string } {
    const s = run(framed(), {
      type: "art_add_image_layer",
      source: { kind: "file", path: "/pictures/square.png" },
      name: "square",
      box: SQUARE,
    });
    return { s, id: s.artActive! };
  }
  /** A quad's sides in units of the frame's short side, and its center. */
  function measure(q: Pt[], aspect: number) {
    const short = Math.min(aspect, 1);
    const side = (a: Pt, b: Pt) => Math.hypot((b[0] - a[0]) * aspect, b[1] - a[1]) / short;
    return { across: side(q[0], q[1]), down: side(q[0], q[3]), center: crossing(q) };
  }
  const blendParams = (st: State, id: string) =>
    (serializeGraph(st) as unknown as { nodes: { id: string; params: Record<string, number> }[] }).nodes.find((n) => n.id === id)!.params;

  it("is written with the shape of the frame it was placed on", () => {
    const { s, id } = withSquare();
    expect(blendParams(s, id).warp_aspect).toBe(1.5);
  });

  for (const [what, aspect] of [["a crop to 1:1", 1], ["a crop to 16:9", 16 / 9], ["the crop turned a quarter (2:3)", 2 / 3]] as const) {
    it(`stays square, as large and in its place after ${what}`, () => {
      const { s, id } = withSquare();
      const before = placementOf(layerQuad(s, id) as Pt[], layerBox(s, id), 1.5);
      noteFrameAspect(s.activeImage, aspect);
      const q = layerQuad(s, id) as Pt[];
      const m = measure(q, aspect);
      expect(m.across).toBeCloseTo(0.3, 9);
      expect(m.down).toBeCloseTo(0.3, 9);
      expect(m.center[0]).toBeCloseTo(0.7, 9);
      expect(m.center[1]).toBeCloseTo(0.7, 9);
      // The typed fields read the same numbers they read on 3:2.
      const p = placementOf(q, layerBox(s, id), aspect);
      for (const k of ["x", "y", "sx", "sy", "rotate"] as const) expect(p[k]).toBeCloseTo(before[k], 9);
      expect(p.sx).toBeCloseTo(100, 6);
      expect(p.sy).toBeCloseTo(100, 6);
      expect(p.x).toBeCloseTo(70, 6);
      expect(p.y).toBeCloseTo(70, 6);
      expect(p.rotate).toBe(0);
      noteFrameAspect(s.activeImage, 1.5);
    });
  }

  it("a crop is not an edit to the layer, and undo across it puts everything back", () => {
    const { s, id } = withSquare();
    const before = layerQuad(s, id);
    const cropped = run(s, { type: "set_params", id: cropNode(s).id, values: { crop_x: 1 / 6, crop_w: 2 / 3 } });
    // The viewer notes the cropped frame's shape when it shows it.
    noteFrameAspect(s.activeImage, 1);
    expect(artFindLayer(cropped, id)!.carrier.params).toEqual(artFindLayer(s, id)!.carrier.params);
    const m = measure(layerQuad(cropped, id) as Pt[], 1);
    expect(m.across).toBeCloseTo(0.3, 9);
    expect(m.down).toBeCloseTo(0.3, 9);
    const undone = run(cropped, { type: "undo" });
    noteFrameAspect(s.activeImage, 1.5);
    expect(cropNode(undone).params.crop_w ?? 1).toBe(1);
    close(layerQuad(undone, id) as Pt[], before as Pt[]);
    // And redo: the crop again, the square still square.
    const redone = run(undone, { type: "redo" });
    noteFrameAspect(s.activeImage, 1);
    expect(measure(layerQuad(redone, id) as Pt[], 1).across).toBeCloseTo(0.3, 9);
    noteFrameAspect(s.activeImage, 1.5);
  });

  it("typed numbers and the handles agree on the cropped frame, and a write stamps it", async () => {
    const { s, id } = withSquare();
    noteFrameAspect(s.activeImage, 1);
    // Typed: X from 70 to 40.
    const typed: Command[] = [];
    const t = render(<TransformFields state={s} blendId={id} dispatch={(c) => typed.push(c)} />);
    const x = screen.getByTestId(`art-xform-x-${id}`);
    fireEvent.focus(x);
    fireEvent.change(x, { target: { value: "40" } });
    fireEvent.keyDown(x, { key: "Enter" });
    t.unmount();
    const byNumber = run(s, ...typed);
    // The handles sit where the fields say, and a body drag of the same
    // move writes the same corners.
    const dragged: Command[] = [];
    const { root, at, r } = mountOverlay(s, id, dragged, { aspect: 1 });
    // The overlay measures from the carried box, not the 3:2 numbers.
    expect(transformBox(s, id)).toEqual(layerBox(s, id));
    fireEvent.mouseDown(screen.getByTestId("transform-body"), at(0.7, 0.7));
    fireEvent.mouseMove(root, { ...at(0.4, 0.7), buttons: 1, metaKey: true });
    fireEvent.mouseUp(root);
    r.unmount();
    await nextFrame();
    const byHand = run(s, ...dragged);
    const a = blendParams(byNumber, id);
    const b = blendParams(byHand, id);
    for (const k of ["warp_bx", "warp_by", "warp_bw", "warp_bh", "warp_x0", "warp_y0", "warp_x1", "warp_y1", "warp_x2", "warp_y2", "warp_x3", "warp_y3", "warp_aspect"]) {
      expect(a[k]).toBeCloseTo(b[k], 9);
    }
    // Written on the 1:1 frame now, and still square there.
    expect(a.warp_aspect).toBe(1);
    const p = placementOf(layerQuad(byNumber, id) as Pt[], layerBox(byNumber, id), 1);
    expect(p.x).toBeCloseTo(40, 6);
    expect(p.y).toBeCloseTo(70, 6);
    expect(p.sx).toBeCloseTo(100, 6);
    expect(p.sy).toBeCloseTo(100, 6);
    noteFrameAspect(s.activeImage, 1.5);
  });

  it("Paste Edits onto a portrait photograph keeps it square and in the same place", () => {
    const { s, id } = withSquare();
    const copied = run(s, { type: "copy_edits" });
    const portrait = run(copied, { type: "select_image", id: "4866" });
    expect(portrait.activeImage).not.toBe(s.activeImage);
    noteFrameAspect(portrait.activeImage, 2 / 3);
    const pasted = run(portrait, { type: "paste_edits" });
    const layer = artLayers(pasted).find((l) => l.blend.id === id);
    expect(layer).toBeDefined();
    const m = measure(layerQuad(pasted, id) as Pt[], 2 / 3);
    expect(m.across).toBeCloseTo(0.3, 9);
    expect(m.down).toBeCloseTo(0.3, 9);
    expect(m.center[0]).toBeCloseTo(0.7, 9);
    expect(m.center[1]).toBeCloseTo(0.7, 9);
    // The numbers traveled as they were; the target reads them onto its
    // own shape, as the engine does.
    expect(blendParams(pasted, id).warp_aspect).toBe(1.5);
  });

  it("a graph saved before the rule reads its corners as plain fractions", () => {
    const { s, id } = withSquare();
    const old = structuredClone(s);
    delete artFindLayer(old, id)!.carrier.params.warp_aspect;
    noteFrameAspect(s.activeImage, 1);
    close(layerQuad(old, id) as Pt[], cornersOf(SQUARE));
    noteFrameAspect(s.activeImage, 1.5);
  });

  it("a layer clipped to the square carries its frame shape to the engine", () => {
    const { s } = withSquare();
    const withFill = run(s, { type: "art_add_layer", kind: "fill" });
    const fill = withFill.artActive!;
    const clipped = run(withFill, { type: "art_clip_layer", id: fill, clip: true });
    const [fit, nums] = (blendParams(clipped, fill).clip_place as unknown as string).split(";");
    expect(fit).toBe("place");
    const got = nums.split(",").map(Number);
    const want = [0.6, 0.55, 0.2, 0.3, 0.6, 0.55, 0.8, 0.55, 0.8, 0.85, 0.6, 0.85, 1.5];
    expect(got).toHaveLength(13);
    got.forEach((v, i) => expect(v).toBeCloseTo(want[i], 9));
  });

  it("a layer that is not a placed picture keeps plain fractions, like its content", () => {
    const s = run(framed(), { type: "art_add_layer", kind: "paint" });
    const id = s.artActive!;
    const moved = run(s, { type: "art_set_quad", id, box: { x: 0, y: 0, w: 1, h: 1 }, corners: [[0.1, 0.1], [0.6, 0.1], [0.6, 0.6], [0.1, 0.6]] });
    expect(blendParams(moved, id).warp_aspect ?? 0).toBe(0);
    noteFrameAspect(s.activeImage, 1);
    close(layerQuad(moved, id) as Pt[], [[0.1, 0.1], [0.6, 0.1], [0.6, 0.6], [0.1, 0.6]]);
    noteFrameAspect(s.activeImage, 1.5);
  });
});

describe("save and reload", () => {
  it("round-trips the layer, its source and its corners through the saved graph", async () => {
    const { s, id } = withFileLayer();
    const moved = run(s, {
      type: "art_set_quad",
      id,
      box: REST,
      corners: [[0.1, 0.2], [0.5, 0.2], [0.5, 0.4], [0.1, 0.4]],
    });
    const imageId = "imagelayers-roundtrip";
    await saveGraph(imageId, { nodes: moved.nodes, wires: moved.wires });
    const saved = await loadGraph(imageId);
    expect(saved).not.toBeNull();
    const reloaded = { ...moved, nodes: saved!.nodes as State["nodes"], wires: saved!.wires as State["wires"] };
    expect(isPlacedLayer(reloaded, id)).toBe(true);
    expect(layerQuad(reloaded, id)).toEqual(layerQuad(moved, id));
    expect(artFindLayer(reloaded, id)!.content.textParams).toMatchObject({ path: "/pictures/logo.png", space: "display" });
    expect(serializeGraph(reloaded)).toEqual(serializeGraph(moved));
    // The engine's shape rides in the file, the way headless and batch
    // renders read it.
    const render_ = (saved as unknown as { render: { nodes: { id: string; params: Record<string, unknown> }[] } }).render;
    expect(render_.nodes.find((n) => n.id === id)!.params).toMatchObject({ fit: "place", warp_x0: 0.1 });
  });
});
