// A panorama's starting crop: the largest rectangle the stitched picture
// fills (the backend's pano_auto_crop), applied as an ordinary Crop &
// Rotate crop so it can be widened again and nothing is discarded.
//
// Applied only to a crop nobody chose: the full frame of a panorama no
// one has edited, or the crop this module gave it earlier this session
// (a re-stitch moves the edges, and the crop follows). A crop the user
// set stays theirs.

import type { Command, State } from "./state";
import { cropNode } from "./state";
import { panoAutoCrop } from "./bridge";

export type Crop = [number, number, number, number];

const FULL: Crop = [0, 0, 1, 1];

/** The crop this session gave each panorama, by photograph. */
const given = new Map<string, Crop>();
/** The newest crop request for each panorama. A slow answer from before a
 * recipe change or an Auto-crop switch must not overwrite its successor. */
const requested = new Map<string, number>();

function cropOf(s: State): Crop {
  const p = cropNode(s).params;
  return [p.crop_x ?? 0, p.crop_y ?? 0, p.crop_w ?? 1, p.crop_h ?? 1];
}

function same(a: Crop, b: Crop): boolean {
  return a.every((v, i) => Math.abs(v - b[i]) < 1e-6);
}

function setCrop(s: State, c: Crop): Command {
  return { type: "set_params", id: cropNode(s).id, values: { crop_x: c[0], crop_y: c[1], crop_w: c[2], crop_h: c[3] } };
}

/** Asks for the panorama's starting crop and applies it where nobody
 * chose a crop. `fresh` says the photograph had no edits when it was
 * opened. With no starting crop to give (the option off, or nothing to
 * cut away), a crop this module gave goes back to the full frame. */
export async function offerPanoCrop(
  image: string,
  current: () => State,
  dispatch: (c: Command) => void,
  fresh: boolean,
): Promise<void> {
  const request = (requested.get(image) ?? 0) + 1;
  requested.set(image, request);
  const rect = await panoAutoCrop(image);
  if (requested.get(image) !== request) return;
  const s = current();
  if (s.activeImage !== image) return;
  const p = cropNode(s).params;
  // A rotated or turned frame's fractions are of a different picture.
  if ((p.angle ?? 0) !== 0 || (p.turn ?? 0) !== 0) return;
  const now = cropOf(s);
  const before = given.get(image);
  const ours = before !== undefined && same(now, before);
  if (!rect) {
    if (ours) {
      dispatch(setCrop(s, FULL));
      given.delete(image);
    }
    return;
  }
  // Fresh at opening is not enough: the answer can take minutes, and an
  // edit made meanwhile means somebody has edited it after all.
  const untouched = fresh && !(s.images.find((i) => i.id === image)?.edited ?? false);
  if (!(ours || (untouched && same(now, FULL)))) return;
  given.set(image, rect);
  if (!same(now, rect)) dispatch(setCrop(s, rect));
}

/** Forgets what this session gave, for tests. */
export function forgetPanoCrops(): void {
  given.clear();
  requested.clear();
}
