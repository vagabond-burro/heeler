// Finish image layers (2026-09-30: "some new finish layers. We already
// had file and catalog for nodes. Expose these as layers, that a user
// can bring in an image. They will need to have transform controls
// (which we already have nodes for) so a user can interactively position
// on the canvas.").
//
// The seats here: bringing a picture in (from a file on disk or from a
// photograph of this catalog), the layer's source line with its missing
// notice, and the typed transform fields. The fields are one component
// drawn in the Layers panel and on the layer's blend node in the graph
// inspector, the same arithmetic (imagelayers.ts) under both, writing
// the same art_set_quad the canvas handles write.

import React, { useEffect, useState } from "react";
import type { ArtLayer, Command, ImageLayerSource, State } from "../state";
import { artGroupMembers, artLayers, editOrigin, editWarpCommand, imageLayerWarp, layerBox, layerQuad, unbakeableWarp, warpEditing } from "../state";
import { FinishWarpControls, editWarpWords } from "./finishwarp";
import { imageLayerProbe, pickImageFile, type ImageLayerProbe } from "../bridge";
import {
  applyPlacement,
  fittedBox,
  frameAspectFor,
  isAffine,
  isRotatedRect,
  placementOf,
  restQuad,
  type Pt,
  type Rect,
} from "../imagelayers";
import { CatalogChooser } from "./graph";
import { Shell } from "./selectdialogs";
import { ValueField } from "./simple";
import { ResetIcon, UNBAKE_WARP_GLYPH, XformIcon } from "./panelicons";
import { UNBAKE_WARP_HINT } from "../layeractions";
import { modLabel } from "../platform";

type D = React.Dispatch<Command>;

/** The rest box for a probed picture in this photograph's frame, or
 * null when the picture is not there (the layer then fills the frame
 * until it is relinked). */
export function restBoxFor(state: Pick<State, "activeImage">, probe: ImageLayerProbe): Rect | null {
  if (probe.missing || !(probe.width > 0) || !(probe.height > 0)) return null;
  const aspect = frameAspectFor(state.activeImage) ?? probe.width / probe.height;
  return fittedBox(probe.width, probe.height, aspect);
}

function stem(path: string): string {
  return (path.split(/[\\/]/).pop() ?? path).replace(/\.[^.]+$/, "") || "Image";
}

/** A file from disk as a new image layer, centered and fitted. */
export async function placeImageFile(state: State, dispatch: D, path: string, layer = ""): Promise<void> {
  const probe = await imageLayerProbe({ kind: "file", path, layer });
  dispatch({
    type: "art_add_image_layer",
    expected: editOrigin(state),
    source: { kind: "file", path, layer },
    name: stem(path),
    box: restBoxFor(state, probe),
  });
}

/** Layer > Image Layer from File, and the panel's menu entry: the open
 * dialog, then the layer. */
export async function addImageLayerFromFile(state: State, dispatch: D): Promise<void> {
  const path = await pickImageFile();
  if (path) await placeImageFile(state, dispatch, path);
}

/** A photograph of this catalog as a new image layer, through its own
 * edits, centered and fitted. */
export async function placeCatalogImage(state: State, dispatch: D, image: string, name: string): Promise<void> {
  const probe = await imageLayerProbe({ kind: "catalog", image });
  dispatch({
    type: "art_add_image_layer",
    expected: editOrigin(state),
    source: { kind: "catalog", image },
    name: stem(name),
    box: restBoxFor(state, probe),
  });
}

/** "Image from Catalog": the Catalog node's folder browser, open, and
 * a pick makes the layer. */
export function CatalogLayerDialog({ state, dispatch }: { state: State; dispatch: D }) {
  if (!state.catalogLayerPick) return null;
  const close = () => dispatch({ type: "close_catalog_layer_pick" });
  return (
    <Shell
      testid="catalog-layer-dialog"
      title="Image from Catalog"
      blurb="Pick a photograph: it comes in as an image layer through its own edits, centered and fitted, and follows those edits when they change."
      onCancel={close}
      onDone={close}
    >
      <CatalogChooser
        chosen=""
        embedded
        session={{ ...state, treeRoot: state.folderTree?.path ?? null }}
        onPick={(id, name) => {
          void placeCatalogImage(state, dispatch, id, name);
          close();
        }}
      />
    </Shell>
  );
}

/** The layer's picture as a source, read off its content node. */
export function imageSourceOf(layer: Pick<ArtLayer, "content">): ImageLayerSource {
  const c = layer.content;
  return c.type === "heeler.catalog"
    ? { kind: "catalog", image: c.textParams?.image ?? "" }
    : { kind: "file", path: c.textParams?.path ?? "", layer: c.textParams?.layer ?? "" };
}

/** Whether a Finish layer is an image layer. */
export function isImageLayer(layer: Pick<ArtLayer, "content">): boolean {
  return layer.content.artKind === "image" || layer.content.artKind === "catalog_image";
}

/** The probe for a source, asked again when the source changes. */
function useProbe(src: ImageLayerSource): ImageLayerProbe | null {
  const key = JSON.stringify(src);
  const [probe, setProbe] = useState<ImageLayerProbe | null>(null);
  useEffect(() => {
    let live = true;
    void imageLayerProbe(src).then((p) => {
      if (live) setProbe(p);
    });
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return probe;
}

const LINE: React.CSSProperties = { fontSize: 11, color: "var(--text-body)" };

/** The missing line of a layer whose picture Heeler kept (Layer via
 * Copy, Bake Warp): what is gone, where it was, and the one way a
 * backup would have had it. */
export function keptMissingLine(path: string): string {
  return `The picture Heeler kept for this layer is missing. It was at ${path}. Recovery bundles carry it only while Keep baked pictures in backups is on (Preferences > Backup).`;
}

/** An image layer's own controls, while its settings are open
 * (2026-09-30: an Image layer opens and closes like an adjustment):
 * which picture, its transform, and its own warp's settings. A
 * missing file is said either way, open or closed.
 *
 * `active` is the layer's settings being open: selected, with Expand
 * settings on select on, or opened with its chevron. */
export function ImageLayerControls({
  layer,
  active: open,
  state,
  dispatch,
}: {
  layer: Pick<ArtLayer, "blend" | "content">;
  /** the layer's settings are open */
  active: boolean;
  state: State;
  dispatch: D;
}) {
  const id = layer.blend.id;
  const src = imageSourceOf(layer);
  const probe = useProbe(src);
  const warp = imageLayerWarp(state, id);
  // New Layer via Copy's and Bake Warp's pixels: a file Heeler keeps,
  // named by a hash, so the line says where the pixels came from instead.
  const origin = layer.content.textParams?.origin;
  const kept =
    origin === "copy"
      ? { line: "Copied from a selection", hint: "Pixels copied from inside a selection with New Layer via Copy, kept by Heeler beside its other saved inputs" }
      : origin === "bake"
        ? { line: "Baked from a warp", hint: "What a Warp layer showed when it was baked with Bake Warp, kept by Heeler beside its other saved inputs" }
        : null;
  const rechoose = async (next: ImageLayerSource) => {
    const p = await imageLayerProbe(next);
    dispatch({ type: "art_image_source", expected: editOrigin(state), id, source: next, box: restBoxFor(state, p) });
  };
  // Closed, a row of nothing would still take the row's gap.
  if (!open && !probe?.missing) return null;
  return (
    <div
      data-testid={`art-image-${id}`}
      onMouseDown={(e) => e.stopPropagation()}
      style={{ display: "flex", flexDirection: "column", gap: 6 }}
    >
      {!open ? null : src.kind === "file" ? (
        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <div
            data-testid={`art-image-name-${id}`}
            data-hint={
              kept ? kept.hint : src.path || "No file chosen yet"
            }
            style={{ ...LINE, flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
          >
            {kept ? kept.line : src.path ? (src.path.split(/[\\/]/).pop() ?? src.path) : "No file chosen"}
          </div>
          {(() => {
            // RELINK when the file has gone missing, CHOOSE otherwise:
            // two names for one seat, each its own picture.
            const relink = !!(probe?.missing && src.path);
            const name = relink ? "Relink" : "Choose";
            return (
              <button
                className="chip"
                data-testid={`art-image-choose-${id}`}
                data-kind={relink ? "relink" : "choose"}
                aria-label={name}
                data-tip={name}
                data-hint={
                  relink
                    ? "Relink: find the file where it is now; the layer keeps its place"
                    : "Choose: put another picture in this layer, where this one sits"
                }
                style={ICON_CHIP}
                onClick={() => {
                  void pickImageFile().then((p) => {
                    if (p) void rechoose({ kind: "file", path: p, layer: "" });
                  });
                }}
              >
                <XformIcon id={relink ? "relink" : "choose"} />
              </button>
            );
          })()}
        </div>
      ) : (
        <CatalogChooser
          chosen={src.image}
          session={{ ...state, treeRoot: state.folderTree?.path ?? null }}
          onPick={(image) => void rechoose({ kind: "catalog", image })}
        />
      )}
      {probe?.missing && (
        <div data-testid={`art-image-missing-${id}`} style={{ fontSize: 12, color: "var(--warn)", lineHeight: 1.4, wordBreak: "break-all" }}>
          {/* A kept picture lost (a recovery bundle made with Keep baked
              pictures in backups off, restored where the old store is
              gone): say what it was and why a backup may not have it. */}
          {kept && src.kind === "file" && src.path ? keptMissingLine(src.path) : probe.missing}
        </div>
      )}
      {open && <TransformFields state={state} blendId={id} dispatch={dispatch} />}
      {/* The picture's own warp, when it has one: the Type, the Room, then that
type's grid or shapes, in the picture's space, moving with the layer.
The Warp layer's rule (2026-09-30, the Edit button): shown with the
layer's open settings, and arming its tool stays the Edit Warp button
in the transform row above.*/}
      {open && warp && <FinishWarpControls state={state} dispatch={dispatch} target={warp.id} open />}
      {/* Unbake (2026-10-01: "go ahead with 1 and 2", 2 being "keep the warp's
settings on the baked layer so it can be unbaked"): the baked layer's
last seat, where Bake Warp sat on the Warp layer; the right-click menu
and the Layer menu carry it too (layeractions.ts, one wording). Only on a
layer Bake Warp made.*/}
      {open && <UnbakeButton state={state} dispatch={dispatch} carrier={id} testid={`art-image-unbake-${id}`} />}
    </div>
  );
}

/** Unbake's button, one component for its two panel seats: the baked
 * layer's settings in the Layers panel and its picture node in the graph
 * inspector (features reach their nodes), as Bake Warp's sits on the
 * Warp layer and its warp node. Nothing on a layer Bake Warp did not
 * make. */
export function UnbakeButton({ state, dispatch, carrier, testid }: { state: State; dispatch: D; carrier: string; testid: string }) {
  if (!unbakeableWarp(state, carrier)) return null;
  return (
    <div style={{ display: "flex", justifyContent: "flex-end" }}>
      <button
        className="chip"
        data-testid={testid}
        aria-label="Unbake"
        data-hint={UNBAKE_WARP_HINT}
        onClick={() => dispatch({ type: "art_unbake_warp", id: carrier })}
        style={{ padding: "3px 6px", display: "inline-flex", alignItems: "center", gap: 4 }}
      >
        <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          {UNBAKE_WARP_GLYPH}
        </svg>
        Unbake
      </button>
    </div>
  );
}

/** The carrier of the Finish layer whose picture node is `contentId`,
 * top level or in a group, when Unbake can act on it. */
export function unbakeCarrierOf(state: State, contentId: string): string | null {
  for (const l of artLayers(state)) {
    if (l.content.id === contentId) return unbakeableWarp(state, l.blend.id) ? l.blend.id : null;
    if (l.content.isGroup) {
      const m = artGroupMembers(l.content).find((x) => x.content.id === contentId);
      if (m) return unbakeableWarp(state, m.merge.id) ? m.merge.id : null;
    }
  }
  return null;
}

const FIELD_ROW: React.CSSProperties = {
  display: "grid",
  gridTemplateColumns: "44px 1fr 44px 1fr",
  alignItems: "center",
  gap: 6,
};

/** A placed layer's transform as numbers: position, size and angle,
 * with Keep Proportions beside them. One seat for each, in the Layers
 * panel and on the blend node in the graph inspector (features reach
 * their nodes). A typed number is one undo step; the fields write the
 * corners the canvas handles write, so the two can never disagree.
 *
 * The handles themselves (Transform, Skew, Perspective, Warp) are the
 * Finish toolbar's Transform slot, and the flips sit above the canvas
 * (2026-10-01: "We already have transform and warp on the toolbar. So
 * there is redundancy with having these buttons on the layers ... The
 * flip buttons should be on the canvas header for all layers.").*/
export function TransformFields({ state, blendId, dispatch }: { state: State; blendId: string; dispatch: D }) {
  const aspect = frameAspectFor(state.activeImage) ?? 1;
  const box = layerBox(state, blendId);
  const quad = layerQuad(state, blendId) as Pt[];
  const p = placementOf(quad, box, aspect);
  const lock = state.transformLock;
  const warp = imageLayerWarp(state, blendId);
  const write = (corners: Pt[]) => dispatch({ type: "art_set_quad", id: blendId, box, corners });
  const set = (next: Parameters<typeof applyPlacement>[3]) => write(applyPlacement(quad, box, aspect, next, lock));
  const num = (v: number, d = 1) => v.toFixed(d);
  // What the quad still is. A turned (or flipped) rectangle reads
  // exactly; a skew leaves a parallelogram, whose W, H and Angle are its
  // top and left edges; a distort or perspective leaves neither, and
  // W, H and Angle say "distorted" rather than a number that describes
  // no edge in particular. Typing one there still sizes or turns the
  // whole shape as it stands.
  const shape: "rect" | "skewed" | "distorted" = isRotatedRect(quad, aspect)
    ? "rect"
    : isAffine(quad, aspect)
      ? "skewed"
      : "distorted";
  const field = (
    key: "x" | "y" | "sx" | "sy" | "rotate",
    value: number,
    lo: number,
    hi: number,
    hint: string,
  ) => (
    <ValueField
      param={key}
      value={value}
      lo={lo}
      hi={hi}
      display={(v) => (shape === "distorted" && key !== "x" && key !== "y" ? "distorted" : num(v))}
      testid={`art-xform-${key}-${blendId}`}
      hint={hint}
      onCommit={(v) => set({ [key]: v })}
    />
  );
  const shift = modLabel("shift");
  const iconButton = (b: {
    key: string;
    name: string;
    icon: React.ReactNode;
    hint: string;
    onClick: () => void;
    active?: boolean;
  }) => (
    <button
      key={b.key}
      className="chip"
      data-testid={`art-xform-${b.key}-${blendId}`}
      data-active={b.active || undefined}
      aria-pressed={b.active === undefined ? undefined : b.active}
      aria-label={b.name}
      data-tip={b.name}
      data-hint={b.hint}
      style={ICON_CHIP}
      onClick={b.onClick}
    >
      {b.icon}
    </button>
  );
  const lbl = (t: string) => (
    <span className="lbl" style={{ fontSize: 11 }}>
      {t}
    </span>
  );
  return (
    <div data-testid={`art-xform-${blendId}`} data-shape={shape} style={{ display: "flex", flexDirection: "column", gap: 5 }}>
      <div style={FIELD_ROW}>
        {lbl("X %")}
        {field("x", p.x, -400, 500, "Moves the picture across the frame; 50 centers it")}
        {lbl("Y %")}
        {field("y", p.y, -400, 500, "Moves the picture up and down the frame; 50 centers it")}
      </div>
      <div style={FIELD_ROW}>
        {lbl("W %")}
        {field("sx", p.sx, 0.1, 5000, "Sizes the picture across; 100 is fitted inside the frame")}
        {lbl("H %")}
        {field("sy", p.sy, 0.1, 5000, "Sizes the picture down; 100 is fitted inside the frame")}
      </div>
      <div style={FIELD_ROW}>
        {lbl("Angle")}
        {field("rotate", p.rotate, -180, 180, "Turns the picture about its center, in degrees clockwise")}
        <span />
        <span>
          {iconButton({
            key: "lock",
            name: "Keep Proportions",
            icon: <XformIcon id={lock ? "lock" : "unlock"} />,
            active: lock,
            hint: lock
              ? `Keep Proportions: on, so sizes keep the picture's shape; click to size each side on its own`
              : `Keep Proportions: sizes keep the picture's shape (${shift} does it for one drag)`,
            onClick: () => dispatch({ type: "set_transform_lock", on: !lock }),
          })}
        </span>
      </div>
      <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
        {/* The picture's own warp (2026-09-30: "build both, A for image
layers"): a grid or shapes on the picture itself, before it is
placed, so it moves with every transform. Collapsed until edited,
like a Warp layer (2026-09-30: "with an additional button to go into
edit mode which then expands to show the controls"): with no warp the
button adds one straight into edit mode; with one it opens and closes
edit mode, and Remove Warp takes it away.*/}
        {warp
          ? (() => {
              const editing = warpEditing(state, warp.id);
              const words = editWarpWords(editing, true);
              return iconButton({
                key: "warp",
                name: words.label,
                icon: <XformIcon id="meshWarp" />,
                active: editing,
                hint: words.hint,
                onClick: () => dispatch(editWarpCommand(state, warp.id)),
              });
            })()
          : iconButton({
              key: "warp",
              name: "Warp",
              icon: <XformIcon id="meshWarp" />,
              hint: "Warp: bend the picture itself with a grid or shapes, even past its own edges; it moves with the layer",
              onClick: () => dispatch({ type: "art_layer_warp", id: blendId, on: true, edit: true }),
            })}
        {warp &&
          iconButton({
            key: "unwarp",
            name: "Remove Warp",
            icon: <XformIcon id="unwarp" />,
            hint: "Remove Warp: the picture goes back to its own shape; the transform stays",
            onClick: () => dispatch({ type: "art_layer_warp", id: blendId, on: false }),
          })}
        {iconButton({
          key: "reset",
          name: "Reset",
          icon: <ResetIcon size={13} />,
          hint: "Reset: puts the picture back square, centered and fitted, as it arrived",
          onClick: () => write(restQuad(box)),
        })}
      </div>
      {shape === "skewed" && (
        <div className="help" data-testid={`art-xform-warped-${blendId}`} style={{ fontSize: 12 }}>
          Skewed: the sides lean, so W and H are its top and left edges and the angle is its top edge&apos;s.
        </div>
      )}
      {shape === "distorted" && (
        <div className="help" data-testid={`art-xform-warped-${blendId}`} style={{ fontSize: 12 }}>
          Distorted: the corners are out of square, so there is no one width, height or angle. X and Y are its center; a typed size or angle sizes or turns the shape as it stands, and Reset squares it.
        </div>
      )}
    </div>
  );
}

/** The row's picture buttons, square, the chip's own look. Inline so it
 * outranks the chip's padding, as the smart mask's buttons do. */
const ICON_CHIP: React.CSSProperties = {
  width: 22,
  height: 20,
  padding: 0,
  boxSizing: "border-box",
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  flex: "none",
};
