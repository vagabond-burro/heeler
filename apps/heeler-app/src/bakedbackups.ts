// What a baked picture costs a backup (2026-10-01: "I would say alert
// the user and give the choice to them. I would lean towards it being
// on by default. maybe even alert the user during bake that these take
// up more for backups").
//
// Layer via Copy and Bake Warp keep a picture file the new layer reads.
// While Preferences > Backup > Keep baked pictures in backups is on (the
// default), every recovery bundle carries a copy of it (recovery.rs),
// so the bake says how much it adds, from the file's own size after
// the write (the desktop's LayerCopy.bytes). The dialog closes the
// moment the file is written, so the number goes to the status line,
// which stays for a few seconds whether or not a dialog showed; the
// dialog, while it runs, says the picture will be kept. Off, the bake
// says nothing: the switch already told the user what off means, and a
// line repeating a choice they made on every bake is noise.

/** The switch's two hints, outcome first. */
export const BAKED_BACKUP_HINTS = {
  on: "Recovery bundles carry Layer via Copy and Bake Warp pictures, so a backup can restore those layers",
  off: "Recovery bundles are smaller, but a baked or copied layer whose picture is lost cannot come back",
} as const;

/** A file size as the status line says it: whole megabytes from ten
 * up, one decimal below that, and "under 0.1 MB" for a sliver. Decimal
 * megabytes, as the system file browsers count a file. */
export function megabytes(bytes: number): string {
  const mb = bytes / 1e6;
  if (mb >= 10) return `${Math.round(mb)} MB`;
  if (mb >= 0.1) return `${(Math.round(mb * 10) / 10).toFixed(1)} MB`;
  return "under 0.1 MB";
}

/** The status line after a bake or a copy lands, while the pictures
 * are kept in backups; null when they are not (or the size is not
 * known). */
export function bakeBackupNotice(what: string, bytes: number | undefined, kept: boolean): string | null {
  if (!kept || !(typeof bytes === "number" && bytes > 0)) return null;
  const size = megabytes(bytes);
  const amount = size.startsWith("under") ? size : `about ${size}`;
  return `${what}: this picture adds ${amount} to each recovery bundle (Preferences > Backup)`;
}

/** The bake dialog's line while it runs, with the pictures kept. */
export const BAKE_DIALOG_BACKUP_LINE = "The picture is kept in each recovery bundle; the status line gives its size once it is saved.";
