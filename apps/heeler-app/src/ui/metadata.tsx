// What is known about the photograph in front of you.
//
// "When thumbnail panel is not expanded, we need a way to
// see metadata about the current image, that is where the right panel
// comes back in."
//
// Two halves, kept visibly apart. The workspace's own (rating, flag,
// whether it has been edited, which take is live) is ours and changes as
// you work. The camera's is a record of a moment and never changes at
// all. Mixing them into one list would suggest you could edit the ISO.

import React, { useEffect, useState } from "react";
import type { Command, State } from "../state";
import {
  allKeywords,
  imageKeywords,
  imageMetadata,
  imageMetadataAll,
  setImageKeywords,
  writeImageMetadata,
  type ImageMeta,
  type MetaLine,
} from "../bridge";
import { logDebug, logMsg } from "../log";
import { SuggestField } from "./suggestfield";

type D = React.Dispatch<Command>;

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

/** The value column is text you may want: a serial number, a lens
 * name, a GPS position to paste somewhere. Labels stay UI (the
 * blanket user-select none), values opt back in. 2026-09-23: "I
 * asked for the labels of controls and other text to not be
 * selectable. I think the values of metadata can be selectable."*/
const SELECTABLE: React.CSSProperties = { WebkitUserSelect: "text", userSelect: "text", cursor: "text" };

/** One label column for the whole tab, sized for the listing's longest
 * names, so the workspace and camera rows line up with everything
 * below them (2026-09-23: "Fix alignment throughout the Metadata
 * view... The two sections above should be matching").*/
const LABEL_COLUMN = "138px 1fr";

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div
      data-testid={`meta-row-${label.toLowerCase()}`}
      style={{ display: "grid", gridTemplateColumns: LABEL_COLUMN, gap: 8, padding: "2px 0" }}
    >
      <div className="lbl" style={{ color: "var(--text-ghost)", letterSpacing: ".06em", textTransform: "uppercase", overflow: "hidden", textOverflow: "ellipsis" }} title={label}>
        {label}
      </div>
      <div className="help tnum" data-testid="meta-value" style={{ color: "var(--text-body)", wordBreak: "break-word", ...SELECTABLE }}>
        {value}
      </div>
    </div>
  );
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

/** Everything the file says about itself (2026-09-23: "it should show
 * the user whatever it finds", and two thirds of the panel stood
 * empty). Every group the reader found, filtered by a field once the
 * list is long, which it always is on a camera file.*/
function AllMetadata({ lines, loaded }: { lines: MetaLine[]; loaded: boolean }) {
  const [filter, setFilter] = useState("");
  const needle = filter.trim().toLowerCase();
  const shown = needle
    ? lines.filter((l) => l.name.toLowerCase().includes(needle) || l.value.toLowerCase().includes(needle) || l.group.toLowerCase().includes(needle))
    : lines;
  const groups = groupLines(shown);
  return (
    <div data-testid="meta-all">
      <div className="lbl" style={{ marginBottom: 5 }}>
        File metadata
      </div>
      {lines.length > 12 && (
        <input
          data-testid="meta-filter"
          value={filter}
          placeholder="Filter by name or value"
          aria-label="Filter the metadata"
          onChange={(e) => setFilter(e.target.value)}
          style={{
            width: "100%", boxSizing: "border-box", background: "var(--bg-app)",
            border: "1px solid var(--line-4)", color: "var(--text-body)",
            padding: "3px 6px", outline: "none", marginBottom: 6,
          }}
        />
      )}
      {lines.length === 0 ? (
        <div className="help" data-testid="meta-all-none">
          {loaded ? "Nothing beyond the camera readings in this file." : "Reading…"}
        </div>
      ) : groups.length === 0 ? (
        <div className="help" data-testid="meta-all-none">Nothing matches.</div>
      ) : (
        groups.map((g) => (
          <div key={g.group} data-testid={`meta-group-${g.group.toLowerCase().replace(/[^a-z]+/g, "-")}`} style={{ marginTop: 6 }}>
            <div className="lbl" style={{ letterSpacing: ".08em", marginBottom: 1 }}>{g.group.toUpperCase()}</div>
            {g.lines.map((l, i) => (
              <Row key={`${l.name}-${i}`} label={l.name} value={l.value} />
            ))}
          </div>
        ))
      )}
    </div>
  );
}

/** Free-text keywords on the active photograph: chips, an input that
 * adds on Enter, autocomplete against every keyword the catalog knows.
 * Writes go straight through (catalog plus sidecar); there is no save
 * button anywhere else in Heeler and none here. */
function KeywordsField({ imageId }: { imageId: string }) {
  const [keywords, setKeywords] = useState<string[]>([]);
  const [known, setKnown] = useState<string[]>([]);
  const [draft, setDraft] = useState("");

  useEffect(() => {
    let live = true;
    void imageKeywords(imageId).then((k) => live && setKeywords(k));
    void allKeywords().then((k) => live && setKnown(k));
    return () => {
      live = false;
    };
  }, [imageId]);

  const commit = (next: string[]) => {
    setKeywords(next);
    void setImageKeywords(imageId, next).then(() => allKeywords().then(setKnown));
  };

  const add = () => {
    const kw = draft.trim();
    if (!kw) return;
    setDraft("");
    if (keywords.some((k) => k.toLowerCase() === kw.toLowerCase())) return;
    commit([...keywords, kw]);
  };

  return (
    <div data-testid="keywords-field">
      <div className="kicker" style={{ fontSize: 8, marginBottom: 5 }}>
        Keywords
      </div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 4, marginBottom: 5 }}>
        {keywords.length === 0 && (
          <span style={{ fontSize: 10, color: "var(--text-ghost)" }}>No keywords yet.</span>
        )}
        {keywords.map((k) => (
          <span
            key={k}
            data-testid={`keyword-${k}`}
            style={{
              display: "inline-flex", alignItems: "center", gap: 5,
              fontSize: 10, padding: "1px 4px 1px 7px",
              border: "1px solid var(--line-4)", background: "var(--bg-app)",
              color: "var(--text-body)",
            }}
          >
            {k}
            <button
              style={{ all: "unset", cursor: "pointer", color: "var(--text-ghost)" }}
              aria-label={`Remove keyword ${k}`}
              data-testid={`keyword-remove-${k}`}
              onClick={() => commit(keywords.filter((x) => x !== k))}
            >
              ✕
            </button>
          </span>
        ))}
      </div>
      <SuggestField
        data-testid="keyword-input"
        aria-label="Add a keyword"
        value={draft}
        placeholder="Add a keyword…"
        suggestions={known.filter((k) => !keywords.includes(k))}
        onChange={setDraft}
        onKeyDown={(e) => {
          if (e.key === "Enter") add();
        }}
        onBlur={add}
        boxStyle={{ width: "100%" }}
        style={{
          background: "var(--bg-app)",
          border: "1px solid var(--line-4)", color: "var(--text-body)",
          fontSize: 10, padding: "3px 6px", outline: "none",
        }}
      />
    </div>
  );
}

export function MetadataTab({ state, dispatch }: { state: State; dispatch: D }) {
  const [meta, setMeta] = useState<ImageMeta | null>(null);
  const [all, setAll] = useState<{ id: string; lines: MetaLine[] } | null>(null);
  const [busy, setBusy] = useState(false);
  const id = state.activeImage;

  // The full listing, once per photograph: it never changes while the
  // photograph is open, so the rating and flag re-reads above leave it.
  useEffect(() => {
    if (!id) {
      setAll(null);
      return;
    }
    let live = true;
    void imageMetadataAll(id).then((lines) => {
      if (live) setAll({ id, lines });
    });
    return () => {
      live = false;
    };
  }, [id]);

  // Re-read when the photograph changes, and when its rating or flag does:
  // those come from the catalog, so the panel would otherwise show the
  // rating the photograph had when it was opened.
  const img = state.images.find((i) => i.id === id);
  const workspaceSig = `${id}|${img?.stars ?? 0}|${img?.flag ?? ""}|${img?.edited ?? false}`;
  useEffect(() => {
    if (!id) {
      setMeta(null);
      return;
    }
    let live = true;
    void imageMetadata(state, id).then((m) => {
      if (live) setMeta(m);
    });
    return () => {
      live = false;
    };
  }, [workspaceSig]);

  const takes = state.takes[id ?? ""] ?? [];
  const activeTake = state.activeTakes[id ?? ""] ?? "";

  const writeOut = () => {
    if (!id) return;
    setBusy(true);
    void writeImageMetadata(
      id,
      activeTake,
      takes.map((t) => [t.id, t.name, t.note ?? "", t.rating ?? 0] as [string, string, string, number]),
    )
      .then((path) => {
        if (path) logDebug(() => `Wrote ${path}`);
        else logMsg("info", "Writing metadata needs the desktop app.");
        return imageMetadata(state, id).then(setMeta);
      })
      .catch((e) => logMsg("error", `Could not write metadata: ${String(e)}`))
      .finally(() => setBusy(false));
  };

  if (!id) {
    return (
      <div data-testid="metadata-tab" style={{ padding: "10px 12px", fontSize: 10, color: "var(--text-ghost)" }}>
        No photograph open.
      </div>
    );
  }

  const camera = meta ? cameraRows(meta).filter((r) => r.value) : [];
  const file = meta ? fileRows(meta).filter((r) => r.value) : [];

  return (
    <div
      data-testid="metadata-tab"
      style={{ padding: "10px 12px", overflowY: "auto", display: "flex", flexDirection: "column", gap: 10 }}
    >
      <div>
        <div className="kicker" style={{ fontSize: 8, marginBottom: 5 }}>
          This workspace
        </div>
        <Row label="Name" value={meta?.name ?? img?.name ?? ""} />
        {(meta?.baked_from ?? img?.bakedFrom) && <Row label="Baked from" value={meta?.baked_from ?? img?.bakedFrom ?? ""} />}
        <Row label="Rating" value={img ? "★".repeat(img.stars) + "☆".repeat(5 - img.stars) : ""} />
        <Row
          label="Status"
          value={img?.flag === "pick" ? "Pick" : img?.flag === "reject" ? "Reject" : "None"}
        />
        <Row label="Edited" value={img?.edited ? "Yes" : "No"} />
        <Row
          label="Takes"
          value={
            takes.length
              ? `${takes.length}, showing ${takes.find((t) => t.id === activeTake)?.name ?? takes[0].name}`
              : "1"
          }
        />
        {file.map((r) => (
          <Row key={r.label} {...r} />
        ))}
      </div>

      <KeywordsField imageId={id} />

      <div>
        <div className="kicker" style={{ fontSize: 8, marginBottom: 5 }}>
          Camera
        </div>
        {/* Only what is actually there. A scanned negative has no
            aperture, and twelve blank rows read as something failing to
            load rather than as a file with nothing to say. */}
        {camera.length === 0 ? (
          <div data-testid="meta-none" style={{ fontSize: 10, color: "var(--text-ghost)", lineHeight: 1.6 }}>
            {meta ? "No camera data in this file." : "Reading…"}
          </div>
        ) : (
          camera.map((r) => <Row key={r.label} {...r} />)
        )}
      </div>

      <AllMetadata lines={all?.id === id ? all.lines : []} loaded={all?.id === id} />

      {/* "write out custom metadata about the version number and
notes that were set during editing." Beside the photograph, never into
it, and only when asked: a sidecar appearing next to every RAW you
merely looked at would be its own kind of rude.*/}
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <button
          className="chip"
          data-testid="meta-write"
          data-hint="Write the rating, flag and takes to an XMP file beside the photograph"
          disabled={busy}
          style={{ fontSize: 9, padding: "2px 9px", flex: "none" }}
          onClick={writeOut}
        >
          {busy ? "WRITING…" : "WRITE SIDECAR"}
        </button>
        <span data-testid="meta-sidecar-state" style={{ fontSize: 9, color: "var(--text-ghost)" }}>
          {meta?.sidecar ? "XMP on disk" : "no XMP yet"}
        </span>
      </div>
      <div style={{ fontSize: 9, color: "var(--text-ghost)", lineHeight: 1.6 }}>
        The rating and status go out as standard XMP, so other photo apps read them.
        Takes and their notes go in Heeler's own namespace. Your photograph is never written to.
      </div>
    </div>
  );
}
