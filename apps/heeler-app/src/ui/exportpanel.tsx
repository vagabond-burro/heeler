// The Export panel: batch export with presets, in the right-hand column.
//
// It takes over the Adjustments column rather than opening a dialog, so
// the ribbon stays visible and reachable: choosing what to export is
// culling, and culling happens in the ribbon. Closing it folds it to a
// thin bar rather than removing it, the same way the graph pop-out
// leaves a bar behind, so the way back is where it was.

import React, { useEffect, useState } from "react";
import type { Command, ImageEntry, State } from "../state";
import {
  STARTER_PRESETS,
  collisions,
  destinationFor,
  exportTargets,
  logExportFailures,
  runExport,
  type ExportPreset,
  type ExportSettings,
} from "../export";
import { ART_ID, exportDpi } from "../state";
import { loadExportPresets, pickExportFolder, saveExportPresets } from "../bridge";
import { logMsg } from "../log";
import { TrackSlider, ValueField } from "./track";
import exportResolution from "../../../../crates/heeler-io/export-resolution.json";
import { MenuField } from "./menufield";

type D = React.Dispatch<Command>;

/** The export formats, in the menu's order. */
const EXPORT_FORMATS = [
  { id: "jpeg", label: "JPEG" },
  { id: "webp", label: "WebP" },
  { id: "png", label: "PNG" },
  { id: "png16", label: "PNG 16-bit" },
  { id: "tiff", label: "TIFF 16-bit" },
  { id: "tiff32", label: "TIFF 32-bit float" },
  { id: "dng", label: "Linear DNG" },
  { id: "exr", label: "EXR (multi-channel)" },
];

/** The Size row's choices; the guided tours' export stops read them. */
export const EXPORT_SIZES: [string, number | null][] = [
  ["Full", null],
  ["4096", 4096],
  ["2048", 2048],
  ["1024", 1024],
];

/** The rail the panel lives behind. It is always there, open or shut,
 * and the bar you click to open is the bar you click to close: the same
 * bargain the Library rail makes on the other side of the window. A
 * separate CLOSE button inside the panel put the way out somewhere the
 * way in never was. */
export function ExportBar({ open, dispatch }: { open: boolean; dispatch: D }) {
  return (
    <button
      className="railbar right ui-zoom"
      data-testid="export-bar"
      aria-pressed={open}
      aria-label={open ? "Collapse export" : "Expand export"}
      data-hint={open ? "Fold the export panel to a bar" : "Open the export panel"}
      data-hint-cmd="file.export"
      onClick={() => dispatch({ type: "toggle_export" })}
    >
      <span>EXPORT</span>
    </button>
  );
}

export function ExportPanel({ state, dispatch }: { state: State; dispatch: D }) {
  // The settings ARE the active batch group's: each tab keeps its own,
  // which is the whole point of the tabs. Editing a control edits the
  // group, so switching tabs switches every control at once.
  const queue = state.exportQueue;
  const group = queue.groups[queue.active];
  const settings = group.settings;
  const setSettings = (next: ExportSettings) =>
    dispatch({ type: "export_group_settings", settings: next });
  const [renamingTab, setRenamingTab] = useState<{ index: number; name: string } | null>(null);
  // "Batches should be able to have their own output
  // folders." The folder lives on the group, same as its settings; a
  // panel-local one silently shared a destination between tabs that share
  // nothing else.
  const dir = group.folder;
  const setDir = (folder: string | null) => dispatch({ type: "export_group_folder", folder });
  const [presets, setPresets] = useState<ExportPreset[]>(STARTER_PRESETS);
  const [presetName, setPresetName] = useState<string | null>(null);
  const [running, setRunning] = useState<{ done: number; total: number; current: string } | null>(
    null
  );
  const [report, setReport] = useState<string | null>(null);
  const stop = React.useRef(false);

  useEffect(() => {
    void loadExportPresets().then((json) => {
      if (!json) return;
      try {
        const parsed = JSON.parse(json) as ExportPreset[];
        if (Array.isArray(parsed) && parsed.length > 0) setPresets(parsed);
      } catch {
        // A corrupt preset list is not worth failing over; the starters
        // are perfectly good and the next save will overwrite it.
      }
    });
  }, []);

  const persist = (next: ExportPreset[]) => {
    setPresets(next);
    void saveExportPresets(JSON.stringify(next));
  };

  // The queue outranks the selection: an empty queue exports what is
  // selected (the original behavior), a filled one exports exactly
  // what was queued, in its order. The queue carries its own records,
  // so photos stay exportable whatever folder or collection the
  // library is showing right now; the view only lends thumbnails.
  const byId = new Map(state.images.map((i) => [i.id, i]));
  const queued: ImageEntry[] = group.queued.map((p) => ({
    id: p.id,
    name: p.name,
    stars: p.stars,
    flag: p.flag,
    edited: false,
    filter: byId.get(p.id)?.filter ?? "",
    src: byId.get(p.id)?.src ?? "",
  }));
  const fromQueue = queued.length > 0;
  const targets = fromQueue ? queued : exportTargets(state);
  const clashes = collisions(settings, targets);
  const preview =
    targets.length > 0
      ? destinationFor(dir ?? "…", settings, targets[0], 0, targets.length)
      : null;

  const run = async () => {
    if (targets.length === 0 || running !== null) return;
    // No folder on this batch yet: ask now, remember on the batch, and
    // keep going. A disabled button was the old answer, and a disabled
    // button dimmed to 35% still reads as "click me" at the end of a long
    // day; the owner clicked, nothing happened.
    let out = dir;
    if (!out) {
      out = await pickExportFolder();
      if (!out) return; // canceled: their call, no scolding
      setDir(out);
    }
    stop.current = false;
    setReport(null);
    setRunning({ done: 0, total: targets.length, current: "" });
    const result = await runExport(
      state,
      targets,
      out,
      settings,
      (p) => setRunning(p),
      () => stop.current
    );
    setRunning(null);
    const failed = result.failed.length;
    // Reasons first, then the summary: the console reads bottom-up.
    logExportFailures(result.failed);
    const msg =
      failed === 0
        ? `Exported ${result.written.length} image${result.written.length === 1 ? "" : "s"} to ${out}`
        : `Exported ${result.written.length}, ${failed} failed: ${result.failed
            .map((f) => f.name)
            .join(", ")}`;
    setReport(msg);
    logMsg(failed === 0 ? "info" : "warn", msg);
  };

  // JPEG and WebP are the two that spend quality for bytes; the rest
  // keep every bit and the dial means nothing to them.
  const lossy = settings.format === "jpeg" || settings.format === "webp";
  const row = (label: string, children: React.ReactNode) => (
    <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
      <div className="kicker" style={{ width: 58, flex: "none" }}>{label}</div>
      {children}
    </div>
  );

  const header = (
    <div
      style={{
        padding: "11px 12px 10px",
        borderBottom: "1px solid var(--line-1)",
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
      }}
    >
      <div className="kicker" style={{ letterSpacing: ".16em" }}>Export</div>
    </div>
  );
  return (
    <div className="panel-col ui-zoom" style={{ width: state.panelSizes.right }} data-testid="export-panel">
      {header}

      <div style={{ flex: 1, overflowY: "auto", padding: "10px 12px 14px" }}>
        <div style={{ fontSize: 11, color: "var(--text-body)", marginBottom: 10 }} data-testid="export-count">
          {targets.length === 0
            ? "Nothing selected"
            : `${targets.length} image${targets.length === 1 ? "" : "s"}`}
          {fromQueue ? (
            <span style={{ color: "var(--text-ghost)" }}> · queued in {group.name}</span>
          ) : (
            state.imageSelection.length > 1 && (
              <span style={{ color: "var(--text-ghost)" }}> · from the selection</span>
            )
          )}
        </div>

        {row(
          "Preset",
          <MenuField
            testid="export-preset"
            label="Export preset"
            hint="Load a saved export preset into these settings"
            size="regular"
            value=""
            placeholder={presets.length ? "Choose…" : "No presets yet"}
            options={presets.map((p) => ({ id: p.id, label: p.name }))}
            onChange={(id) => {
              const p = presets.find((x) => x.id === id);
              // Presets saved before the metadata option existed load
              // with it on, matching the default; presets saved before
              // the matte existed load with it off. Both still set the
              // field: a saved spread carries matte, and leaving it out
              // here kept whatever the tab happened to have.
              if (p) setSettings({ format: p.format, quality: p.quality, maxEdge: p.maxEdge, template: p.template, keepMetadata: p.keepMetadata ?? true, matte: p.matte ?? false, dpi: exportDpi(p.dpi) });
            }}
          />
        )}

        {/* One dropdown, not six buttons: the row was congested and a
            seventh format would have burst it. The hint follows the
            chosen format, so the row still teaches what each one is
            for. */}
        {row(
          "Format",
          <MenuField
            testid="export-format"
            label="Export format"
            size="regular"
            value={settings.format}
            options={EXPORT_FORMATS}
            fitLabels={EXPORT_FORMATS.map((f) => f.label)}
            hint={
              settings.format === "png16" || settings.format === "tiff"
                ? "16 bits per channel: the archival formats, for files going somewhere else to be graded or printed"
                : settings.format === "tiff32"
                  ? "32-bit float, scene-linear: the compositing format. No camera record or keywords are carried"
                  : settings.format === "exr"
                    ? "One file, many layers: the beauty plus every Export Layer node as a named layer, 16-bit float (depth in 32). No camera record or keywords are carried"
                    : settings.format === "dng"
                      ? "Linear DNG: the edit baked into a raw-like file another editor can develop further"
                      : settings.format === "webp"
                        ? "The web's format: JPEG quality at roughly half the bytes"
                        : "What the finished file is: JPEG for sharing, the rest for archives and other software"
            }
            onChange={(format) => setSettings({ ...settings, format: format as typeof settings.format })}
          />
        )}

        {/* Always rendered, disabled when the format ignores it.
"the batch tabs shift up and down" when this row came and went
with the format; a row that grays out keeps every control exactly
where the hand left it.*/}
        {/* A slider, not three presets. "I think 'Quality' should be
a slider. That's usually how other apps handle it." It is a continuous
dial in the encoder and always was; offering 80, 92 and 100 made it
look like three modes and put 85 out of reach. Same stay-in-place
bargain as before: grayed for the formats that keep every bit, never
removed.*/}
        {row(
          "Quality",
          <>
            <div className="strack-flex">
              <TrackSlider
                label="Export quality"
                testid="export-quality"
                value={settings.quality}
                lo={1}
                hi={100}
                step={1}
                disabled={!lossy}
                hint={
                  lossy
                    ? "How hard the encoder squeezes. 92 is where most people stop being able to tell; below 70 it starts to show on skies and skin."
                    : "Quality is a lossy-format dial; PNG, TIFF and DNG keep every bit whatever it says."
                }
                onChange={(v) => setSettings({ ...settings, quality: Math.round(v) })}
              />
            </div>
            <span
              className="tnum"
              data-testid="export-quality-value"
              style={{
                width: 20, flex: "none", textAlign: "right", fontSize: 10,
                color: lossy ? "var(--text-body)" : "var(--text-ghost)",
              }}
            >
              {settings.quality}
            </span>
          </>
        )}

        {/* Background removal: the graph's Smart mask becomes the alpha
channel. Same stay-in-place bargain as Quality: grayed for formats
that cannot carry alpha, never removed.*/}
        {row(
          "Matte",
          <button
            className="chip"
            data-testid="export-matte"
            data-active={
              !!settings.matte &&
              (settings.format === "png" || settings.format === "png16" || settings.format === "tiff" || settings.format === "tiff32" || settings.format === "exr")
            }
            disabled={
              settings.format !== "png" && settings.format !== "png16" && settings.format !== "tiff" && settings.format !== "tiff32" && settings.format !== "exr"
            }
            aria-pressed={!!settings.matte}
            data-hint={
              settings.format === "png" || settings.format === "png16" || settings.format === "tiff" || settings.format === "tiff32" || settings.format === "exr"
                ? "Transparent background: the photograph matted through its Smart mask. Needs a Smart layer with a computed mask."
                : "Transparency needs an alpha format: PNG, TIFF or EXR"
            }
            // "in the Export view I would scale up the buttons and the
            // fonts for Matte, Size, Metadata." So they stop hand-shrinking
            // themselves and take the size .chip and .zoom-seg already draw, the
            // same fix the Library panel's header buttons had.
            style={{
              opacity:
                settings.format === "png" || settings.format === "png16" || settings.format === "tiff" || settings.format === "tiff32" || settings.format === "exr"
                  ? 1
                  : 0.35,
            }}
            onClick={() => setSettings({ ...settings, matte: !settings.matte })}
          >
            {settings.matte ? "Transparent" : "Opaque"}
          </button>
        )}

        {/* What the graph's export wiring adds to the file (26.3 Phase
            8): the Output card's alpha diamond and each wired Export
            Layer node. The line says where those bytes can land, so a
            JPEG export of a layered graph never silently drops them. */}
        {(() => {
          const output = state.nodes.find((n) => n.type === "heeler.output");
          const alphaWired = !!output && state.wires.some((w) => w.to === output.id && w.toPort === "alpha");
          // Finish-sourced Export Layer nodes live INSIDE the Finish
          // group (26.3 Phase 8), so the count reads both homes: the
          // top level for hand-placed nodes, the group's members for
          // the checkbox's. A node counts when something feeds it.
          const art = state.nodes.find((n) => n.id === ART_ID && n.isGroup);
          const finishCount = (art?.groupNodes ?? []).filter(
            (n) => n.type === "heeler.export_layer" && n.enabled && (art?.groupWires ?? []).some((w) => w.to === n.id),
          ).length;
          const layers =
            state.nodes.filter(
              (n) => n.type === "heeler.export_layer" && n.enabled && state.wires.some((w) => w.to === n.id),
            ).length + finishCount;
          const alphaOk =
            settings.format === "png" || settings.format === "png16" ||
            settings.format === "tiff" || settings.format === "tiff32" || settings.format === "exr";
          return (
            <>
              {layers > 0 && (
                <div
                  data-testid="export-layers-line"
                  style={{ fontSize: 10, color: settings.format === "exr" || settings.format === "tiff" || settings.format === "tiff32" ? "var(--text-faint)" : "var(--accent)", lineHeight: 1.5 }}
                >
                  {settings.format === "exr"
                    ? `${layers} export layer${layers === 1 ? "" : "s"}, one EXR`
                    : settings.format === "tiff" || settings.format === "tiff32"
                      ? `${layers} export layer${layers === 1 ? "" : "s"}, ${layers} sibling TIFF${layers === 1 ? "" : "s"}`
                      : `${layers} export layer${layers === 1 ? "" : "s"} need${layers === 1 ? "s" : ""} TIFF or EXR; ${settings.format.toUpperCase()} drops them`}
                </div>
              )}
              {alphaWired && !alphaOk && (
                <div data-testid="export-alpha-warning" style={{ fontSize: 10, color: "var(--accent)", lineHeight: 1.5 }}>
                  The wired alpha needs PNG, TIFF or EXR; {settings.format.toUpperCase()} drops it
                </div>
              )}
            </>
          );
        })()}

        {row(
          "Size",
          <div className="zoom-seg" role="group" aria-label="Export size" style={{ border: "1px solid var(--line-4)" }}>
            {EXPORT_SIZES.map(([label, edge]) => (
              <button
                key={label}
                data-active={settings.maxEdge === edge}
                data-testid={`export-size-${label.toLowerCase()}`}
                onClick={() => setSettings({ ...settings, maxEdge: edge })}
              >
                {label}
              </button>
            ))}
          </div>
        )}

        {row(
          "DPI",
          <ValueField
            param="export_dpi"
            testid="export-dpi"
            label="Export DPI"
            hint="The print resolution the file declares, metadata kept or stripped. The pixels stay the same; only the size a print shop or layout program reads changes. Heeler does not apply this setting to DNG and EXR exports"
            value={exportDpi(settings.dpi)}
            lo={1}
            hi={exportResolution.maxDpi}
            display={String}
            step={1}
            onCommit={(v) => setSettings({ ...settings, dpi: exportDpi(v) })}
          />
        )}

        {row(
          "Metadata",
          <div className="zoom-seg" role="group" aria-label="Export metadata" style={{ border: "1px solid var(--line-4)" }}>
            {([["Keep", true], ["Strip", false]] as const).map(([label, keep]) => (
              <button
                key={label}
                data-active={settings.keepMetadata === keep}
                data-testid={`export-metadata-${label.toLowerCase()}`}
                data-hint={
                  keep
                    ? "Camera, lens and exposure ride along in the file"
                    : "No EXIF: nothing about the camera, the place or the time leaves with the file"
                }
                onClick={() => setSettings({ ...settings, keepMetadata: keep })}
              >
                {label}
              </button>
            ))}
          </div>
        )}

        {row(
          "Name",
          <input
            data-testid="export-template"
            value={settings.template}
            onChange={(e) => setSettings({ ...settings, template: e.target.value })}
            style={{
              flex: 1, background: "var(--bg-app)", border: "1px solid var(--line-4)",
              color: "var(--text-body)", fontSize: 10, padding: "2px 5px", outline: "none",
            }}
          />
        )}
        {/* Half again the size of the panel's fine print (2026-09-09:
"nearly impossible to read").*/}
        <div style={{ fontSize: 13.5, color: "var(--text-ghost)", lineHeight: 1.5, marginBottom: 8 }}>
          {"{name} {n} {stars} {flag}"}
        </div>

        {row(
          "Folder",
          <button
            className="chip"
            data-testid="export-folder"
            data-hint="Choose where the files go"
            // 1.15x, and the sample path below it with it: this is a path, and a
            // path you cannot read is a path you cannot check before writing
            // forty files into it.
            style={{ fontSize: 10.35, padding: "3px 9px", flex: 1, textAlign: "left" }}
            onClick={() => void pickExportFolder().then((d) => d && setDir(d))}
          >
            {dir ?? "Choose…"}
          </button>
        )}

        {preview && (
          <div
            data-testid="export-preview"
            style={{
              fontSize: 10.35, color: "var(--text-faint)", lineHeight: 1.6, marginBottom: 8,
              wordBreak: "break-all",
            }}
          >
            {preview}
          </div>
        )}

        {clashes.length > 0 && (
          <div
            data-testid="export-collision"
            // Same misuse as Color Bend's help line: the accent means
            // ACTIVE, and this is a caution. Amber is what caution
            // looks like here, and the palette says so in as many
            // words.
            style={{ fontSize: 9, color: "var(--warn)", lineHeight: 1.5, marginBottom: 8 }}
          >
            {clashes.length} name{clashes.length === 1 ? "" : "s"} repeat
            {clashes.length === 1 ? "s" : ""} under this pattern. The run suffixes the extras
            -2, -3 rather than overwrite anything; add {"{n}"} to name them yourself.
          </div>
        )}

        {/* The queue: batch groups as tabs, each with its own settings (the
controls above edit whichever tab is active), and the queued photos
as a reorderable list. "instead of mixing and matching
in the list... a tab of batch groups."*/}
        <div style={{ borderTop: "1px solid var(--line-1)", margin: "2px 0 8px", paddingTop: 8 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 4, flexWrap: "wrap", marginBottom: 6 }}>
            {queue.groups.map((g, i) =>
              renamingTab?.index === i ? (
                <input
                  key={g.id}
                  autoFocus
                  value={renamingTab.name}
                  data-testid="export-tab-rename"
                  onChange={(e) => setRenamingTab({ index: i, name: e.target.value })}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && renamingTab.name.trim()) {
                      dispatch({ type: "export_group_rename", index: i, name: renamingTab.name });
                      setRenamingTab(null);
                    }
                    if (e.key === "Escape") setRenamingTab(null);
                  }}
                  onBlur={() => setRenamingTab(null)}
                  style={{
                    width: 84, background: "var(--bg-app)", border: "1px solid var(--line-4)",
                    color: "var(--text-body)", fontSize: 11, padding: "2px 6px", outline: "none",
                  }}
                />
              ) : (
                <button
                  key={g.id}
                  className="chip"
                  data-testid={`export-tab-${i}`}
                  data-active={i === queue.active || undefined}
                  data-hint="A batch group: its photos export with this tab's settings (double-click renames)"
                  // The Metadata Keep/Strip segment's size ("Increase the
                  // size of the Batch # [+] [x] buttons to match").
                  style={{
                    fontSize: 11, padding: "3px 9px",
                    color: i === queue.active ? "var(--accent)" : undefined,
                    borderColor: i === queue.active ? "var(--accent-dim)" : undefined,
                  }}
                  onClick={() => dispatch({ type: "export_group_select", index: i })}
                  onDoubleClick={() => setRenamingTab({ index: i, name: g.name })}
                >
                  {g.name}
                  {g.queued.length > 0 && (
                    <span className="tnum" style={{ marginLeft: 5, color: "var(--text-ghost)" }}>
                      {g.queued.length}
                    </span>
                  )}
                </button>
              )
            )}
            <button
              className="chip"
              data-testid="export-tab-new"
              data-hint="New batch group with its own settings"
              style={{ fontSize: 11, padding: "3px 9px" }}
              onClick={() => dispatch({ type: "export_group_new" })}
            >
              +
            </button>
            {/* Always offered: deleting the only batch replaces it with a fresh one,
which is the fast way to clear a queue. "I want to delete
the first to quickly clear all images and I can't."*/}
            <button
              className="chip"
              data-testid="export-tab-remove"
              data-hint={
                queue.groups.length > 1
                  ? "Remove this batch group (photos stay in the catalog)"
                  : "Delete this batch; a fresh empty one takes its place"
              }
              style={{ fontSize: 11, padding: "3px 9px" }}
              onClick={() => dispatch({ type: "export_group_remove", index: queue.active })}
            >
              ✕
            </button>
          </div>
          <div
            data-testid="export-queue-list"
            style={{ maxHeight: 170, overflowY: "auto", display: "flex", flexDirection: "column", gap: 3 }}
          >
            {group.queued.length === 0 && (
              <div style={{ fontSize: 13.5, color: "var(--text-ghost)", lineHeight: 1.5 }}>
                Queue photos here: right-click a thumbnail and choose Add to
                Export Queue, or use the Photo menu. An empty queue exports
                the current selection.
              </div>
            )}
            {group.queued.map((p, i) => {
              // The record travels with the queue; the current view only
              // lends a thumbnail when it happens to have one.
              const entry = byId.get(p.id);
              return (
                <div
                  key={p.id}
                  data-testid={`export-queue-item-${p.id}`}
                  style={{
                    display: "flex", alignItems: "center", gap: 7,
                    padding: "2px 4px", background: "var(--bg-app)",
                    border: "1px solid var(--line-1)",
                  }}
                >
                  {entry?.src ? (
                    <img
                      src={entry.src}
                      alt=""
                      style={{ width: 34, height: 23, objectFit: "cover", flex: "none", filter: entry.filter || undefined }}
                    />
                  ) : (
                    <div style={{ width: 34, height: 23, flex: "none", background: "var(--bg-panel)" }} />
                  )}
                  <span
                    style={{
                      flex: 1, fontSize: 9.5, overflow: "hidden",
                      textOverflow: "ellipsis", whiteSpace: "nowrap",
                      color: "var(--text-body)",
                    }}
                  >
                    {p.name}
                  </span>
                  <button
                    className="chip"
                    data-testid={`export-queue-up-${p.id}`}
                    disabled={i === 0}
                    style={{ fontSize: 9, padding: "0 5px" }}
                    onClick={() => dispatch({ type: "export_queue_move", from: i, to: i - 1 })}
                  >
                    ▲
                  </button>
                  <button
                    className="chip"
                    data-testid={`export-queue-down-${p.id}`}
                    disabled={i === group.queued.length - 1}
                    style={{ fontSize: 9, padding: "0 5px" }}
                    onClick={() => dispatch({ type: "export_queue_move", from: i, to: i + 1 })}
                  >
                    ▼
                  </button>
                  <button
                    className="chip"
                    data-testid={`export-queue-remove-${p.id}`}
                    aria-label={`Remove ${p.name} from the queue`}
                    style={{ fontSize: 9, padding: "0 5px" }}
                    onClick={() => dispatch({ type: "export_queue_remove", id: p.id })}
                  >
                    ✕
                  </button>
                </div>
              );
            })}
          </div>
        </div>

        <div style={{ display: "flex", gap: 6, marginBottom: 10 }}>
          {/* The panel's go button, and the only control in here that writes
anything to disk. The owner, once the segmented controls had given
the solid accent back: "Looking in Export, should the 'Export #' be a
solid accent color?" It should, and that is now the whole rule: a
filled block of accent means the act, never the state. It wears the
top bar's own export class so the two doors onto the same errand look
like one errand, at this panel's smaller size.*/}
          <button
            className="btn-export"
            data-testid="export-run"
            disabled={targets.length === 0 || running !== null}
            data-hint={
              dir
                ? undefined
                : "No folder on this batch yet: asks where to write, then exports"
            }
            // + PRESET's size and case, so the row reads as one row (The
            // report: "the Export # button uses a different font size from +
            // PRESET. The Export label should also be all caps").
            style={{ fontSize: 10.35, padding: "4px 12px", letterSpacing: ".06em" }}
            onClick={() => void run()}
          >
            {running ? "EXPORTING…" : `EXPORT ${targets.length || ""}`.trim()}
          </button>
          {running && (
            <button
              className="chip"
              data-testid="export-stop"
              style={{ fontSize: 10.35, padding: "4px 11px" }}
              onClick={() => {
                stop.current = true;
              }}
            >
              STOP
            </button>
          )}
          <button
            className="chip"
            data-testid="export-save-preset"
            data-hint="Save these settings as a preset"
            style={{ fontSize: 10.35, padding: "4px 11px" }}
            onClick={() => setPresetName(presetName === null ? "" : null)}
          >
            + PRESET
          </button>
        </div>

        {presetName !== null && (
          <div style={{ display: "flex", gap: 6, marginBottom: 10 }}>
            <input
              autoFocus
              data-testid="export-preset-name"
              placeholder="Preset name"
              value={presetName}
              onChange={(e) => setPresetName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && presetName.trim()) {
                  persist([
                    ...presets,
                    { ...settings, id: `p${Date.now()}`, name: presetName.trim() },
                  ]);
                  setPresetName(null);
                }
                if (e.key === "Escape") setPresetName(null);
              }}
              style={{
                flex: 1, background: "var(--bg-app)", border: "1px solid var(--line-4)",
                color: "var(--text-body)", fontSize: 10, padding: "2px 5px", outline: "none",
              }}
            />
          </div>
        )}

        {running && (
          <div data-testid="export-progress" style={{ marginBottom: 8 }}>
            <div style={{ height: 3, background: "var(--bg-app)", border: "1px solid var(--line-2)" }}>
              <div
                data-testid="export-progress-bar"
                style={{
                  width: `${Math.round((running.done / Math.max(1, running.total)) * 100)}%`,
                  height: "100%",
                  background: "var(--accent)",
                }}
              />
            </div>
            <div className="tnum" style={{ fontSize: 9, color: "var(--text-ghost)", marginTop: 4 }}>
              {running.done}/{running.total} {running.current}
            </div>
          </div>
        )}

        {report && (
          <div
            data-testid="export-report"
            style={{ fontSize: 9, color: "var(--text-faint)", lineHeight: 1.6, wordBreak: "break-all" }}
          >
            {report}
          </div>
        )}
      </div>
    </div>
  );
}
