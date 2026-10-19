// metadata.tsx's values and helpers that are not components, kept apart so
// metadata.tsx exports components alone and Vite can refresh it in place as
// it is edited instead of reloading the window.
import { type ImageMeta, type MetaLine } from "../bridge";

/** Bytes as a person would say them. */
export function humanSize(bytes: number): string {
  if (bytes <= 0) return "";
  const units = ["B", "KB", "MB", "GB"];
  let v = bytes;
  let u = 0;
  while (v >= 1024 && u < units.length - 1) {
    v /= 1024;
    u += 1;
  }
  // No decimal on bytes and kilobytes: "1.0 KB" is noise.
  return u <= 1 ? `${Math.round(v)} ${units[u]}` : `${v.toFixed(1)} ${units[u]}`;
}

/** EXIF writes "2024:03:11 17:42:08", which nothing else on earth does. */
export function humanShotAt(raw: string | null | undefined): string {
  if (!raw) return "";
  const m = /^(\d{4}):(\d{2}):(\d{2})[ T](\d{2}):(\d{2})/.exec(raw.trim());
  if (!m) return raw.trim();
  return `${m[1]}-${m[2]}-${m[3]} ${m[4]}:${m[5]}`;
}

/** What the camera recorded, in the order the panel shows it.
 *
 * Exported because the column view draws the same fields as columns and
 * the two must not drift into disagreeing about what "Shutter" means.
 *
 * The pixel dimensions and the file size are deliberately NOT in here.
 * They are facts about the file, not readings off a camera, and putting
 * them in this list meant a scan with no EXIF at all still showed two
 * rows under "Camera" and so never said it had no camera data. A test
 * caught that, which is the whole reason the two lists are separate.
 */
export function cameraRows(m: ImageMeta): { label: string; value: string }[] {
  return [
    { label: "Camera", value: m.camera ?? "" },
    { label: "Lens", value: m.lens ?? "" },
    { label: "Taken", value: humanShotAt(m.shot_at) },
    { label: "Shutter", value: m.shutter ?? "" },
    { label: "Aperture", value: m.aperture ?? "" },
    { label: "ISO", value: m.iso ? String(m.iso) : "" },
    { label: "Focal", value: m.focal ?? "" },
    { label: "Exposure", value: m.exposure_bias ?? "" },
    { label: "Artist", value: m.artist ?? "" },
    { label: "Copyright", value: m.copyright ?? "" },
  ];
}

/** What the file is, as opposed to what it is a picture of. */
export function fileRows(m: ImageMeta): { label: string; value: string }[] {
  return [
    { label: "Pixels", value: m.width && m.height ? `${m.width} × ${m.height}` : "" },
    { label: "On disk", value: humanSize(m.size) },
  ];
}

/** The listing's groups, in the order the file put them: EXIF, GPS,
 * XMP, ICC Profile, Derived, and whatever else a file carries. */
export function groupLines(lines: MetaLine[]): { group: string; lines: MetaLine[] }[] {
  const out: { group: string; lines: MetaLine[] }[] = [];
  for (const l of lines) {
    const g = out.find((x) => x.group === l.group);
    if (g) g.lines.push(l);
    else out.push({ group: l.group, lines: [l] });
  }
  return out;
}
