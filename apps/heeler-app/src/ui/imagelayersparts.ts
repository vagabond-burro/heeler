// imagelayers.tsx's values and helpers that are not components, kept apart so
// imagelayers.tsx exports components alone and Vite can refresh it in place as
// it is edited instead of reloading the window.
import React from "react";
import type { ArtLayer, Command, ImageLayerSource, State } from "../state";
import { artGroupMembers, artLayers, editOrigin, unbakeableWarp } from "../state";
import { imageLayerProbe, pickImageFile, type ImageLayerProbe } from "../bridge";
import { fittedBox, frameAspectFor, type Rect } from "../imagelayers";

export type D = React.Dispatch<Command>;

/** The rest box for a probed picture in this photograph's frame, or
 * null when the picture is not there (the layer then fills the frame
 * until it is relinked). */
export function restBoxFor(state: Pick<State, "activeImage">, probe: ImageLayerProbe): Rect | null {
  if (probe.missing || !(probe.width > 0) || !(probe.height > 0)) return null;
  const aspect = frameAspectFor(state.activeImage) ?? probe.width / probe.height;
  return fittedBox(probe.width, probe.height, aspect);
}

export function stem(path: string): string {
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

/** The missing line of a layer whose picture Heeler kept (Layer via
 * Copy, Bake Warp): what is gone, where it was, and the one way a
 * backup would have had it. */
export function keptMissingLine(path: string): string {
  return `The picture Heeler kept for this layer is missing. It was at ${path}. Recovery bundles carry it only while Keep baked pictures in backups is on (Preferences > Backup).`;
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
