// The custom chart editor (26.3 Phase 11): a chart of your own, built
// over the photograph. The user sets rows and columns, clicks a cell,
// and assigns it a target from the palette (every patch of every
// built-in chart, grouped by source) or a color of their own, typed
// as sRGB hex or as Lab from the card's datasheet, the two modes
// converting into each other through the engine's D50 Lab math
// (labconvert.ts). A cell left untargeted saves as a control with
// no value: the overlay still draws it, the sampler still reads it, and
// the fit ignores it.
//
// The save composes the same chart file format the built-ins ship in and
// hands it to the desktop's chart_save, which validates it with the
// engine's parser and writes it into the charts folder of the presets
// base. Import and export ride the same doors as presets.

import React, { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { chartExport, chartImport, chartSave, type PaletteTarget } from "../bridge";
import { addChart, loadPalette, reloadCharts } from "../charts";
import { hexToLabD50, labD50ToHex, labD50ToSrgb } from "../labconvert";
import { ValueField } from "./track";
import { flashStatus, reportToolError } from "./hints";
import type { Command } from "../state";

type D = React.Dispatch<Command>;

/** One cell's assignment: a palette target or a hand-entered Lab value.
 * `neutral` marks the grays the fit's white balance leans on. */
export interface CellTarget {
  /** What the report calls the patch: the palette name, or the cell
   * address for a hand-entered Lab value. */
  label: string;
  lab: [number, number, number];
  /** sRGB-encoded display color for the cell's swatch. */
  rgb: [number, number, number];
  neutral: boolean;
}

/** The cell address, spreadsheet style: row letter, column number. */
export function cellAddress(rows: number, cols: number, i: number): string {
  const r = Math.floor(i / cols);
  const c = i % cols;
  void rows;
  return `${String.fromCharCode(65 + r)}${c + 1}`;
}

const MIN_GRID = 1;
const MAX_ROWS = 12;
const MAX_COLS = 14;

export function ChartEditor({
  dispatch,
  nodeId,
  currentChart,
  onClose,
}: {
  dispatch: D;
  /** The Color Checker node's id: saving selects the new chart on it. */
  nodeId: string;
  /** The chart the dropdown shows now, for the Export chip. */
  currentChart: { id: string; name: string } | null;
  onClose: () => void;
}) {
  const [name, setName] = useState("");
  const dialogRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    dialogRef.current?.querySelector<HTMLElement>('input, button:not(:disabled)')?.focus();
    return () => { if (opener?.isConnected) opener.focus(); };
  }, []);
  const [rows, setRows] = useState(4);
  const [cols, setCols] = useState(6);
  const [cells, setCells] = useState<(CellTarget | null)[]>(() => Array(4 * 6).fill(null));
  // The cell the target column is aimed at. A chart always has one, so
  // the column is live from the first frame: the editor opens on A1.
  const [picked, setPicked] = useState(0);
  const [palette, setPalette] = useState<PaletteTarget[]>([]);
  // The custom color block: one value in two modes, hex or Lab, each
  // converting into the other through the engine's D50 Lab math.
  const [colourMode, setColourMode] = useState<"hex" | "lab">("hex");
  const [hex, setHex] = useState("#808080");
  const [labL, setLabL] = useState("50");
  const [labA, setLabA] = useState("0");
  const [labB, setLabB] = useState("0");
  useEffect(() => {
    let live = true;
    loadPalette().then((p) => {
      if (live) setPalette(p);
    });
    return () => {
      live = false;
    };
  }, []);

  /** Resize the grid, keeping every assignment whose row and column
   * still exist. */
  const resize = (nr: number, nc: number) => {
    nr = Math.max(MIN_GRID, Math.min(MAX_ROWS, Math.round(nr)));
    nc = Math.max(MIN_GRID, Math.min(MAX_COLS, Math.round(nc)));
    setCells((prev) => {
      const next: (CellTarget | null)[] = Array(nr * nc).fill(null);
      for (let r = 0; r < Math.min(nr, rows); r++) {
        for (let c = 0; c < Math.min(nc, cols); c++) {
          next[r * nc + c] = prev[r * cols + c] ?? null;
        }
      }
      return next;
    });
    setRows(nr);
    setCols(nc);
    // A smaller grid may have dropped the cell in hand; keep the last one.
    setPicked((p) => Math.min(p, nr * nc - 1));
  };

  const assign = (i: number, t: CellTarget | null) =>
    setCells((prev) => prev.map((c, k) => (k === i ? t : c)));

  /** The Lab fields as a value, or null when one is not a number. */
  const labFromFields = (): [number, number, number] | null => {
    const l = Number(labL);
    const a = Number(labA);
    const b = Number(labB);
    return [l, a, b].every(Number.isFinite) ? [l, a, b] : null;
  };

  /** The hex field's channels, 0..1 encoded, or null when the text is
   * not a color. */
  const hexChannels = (): [number, number, number] | null => {
    const m = /^#?([0-9a-fA-F]{6})$/.exec(hex.trim());
    if (!m) return null;
    const v = parseInt(m[1], 16);
    return [((v >> 16) & 255) / 255, ((v >> 8) & 255) / 255, (v & 255) / 255];
  };

  /** The live swatch: what the fit will aim at, in the mode in hand. */
  const colourSwatch = (() => {
    const rgb = colourMode === "hex" ? hexChannels() : labFromFields() && labD50ToSrgb(labFromFields()!);
    return rgb ? `rgb(${rgb.map((v) => Math.round(Math.max(0, Math.min(1, v)) * 255)).join(", ")})` : null;
  })();

  /** Switching modes converts the value across, so nothing typed is
   * lost: hex fills the Lab fields, Lab rewrites the hex field. */
  const switchColourMode = (m: "hex" | "lab") => {
    if (m === colourMode) return;
    if (m === "lab") {
      const lab = hexToLabD50(hex);
      if (lab) {
        setLabL(String(Math.round(lab[0] * 10) / 10));
        setLabA(String(Math.round(lab[1] * 10) / 10));
        setLabB(String(Math.round(lab[2] * 10) / 10));
      }
    } else {
      const lab = labFromFields();
      if (lab) setHex(labD50ToHex(lab));
    }
    setColourMode(m);
  };

  /** The typed color becomes the cell's target: Lab D50 for the chart
   * file, the display color for the swatch. An exact gray (equal hex
   * channels, or a and b at zero) marks the cell a neutral. */
  const setColour = (i: number) => {
    if (colourMode === "hex") {
      const lab = hexToLabD50(hex);
      const rgb = hexChannels();
      if (!lab || !rgb) return;
      assign(i, { label: cellAddress(rows, cols, i), lab, rgb, neutral: rgb[0] === rgb[1] && rgb[1] === rgb[2] });
    } else {
      const lab = labFromFields();
      if (!lab) return;
      assign(i, { label: cellAddress(rows, cols, i), lab, rgb: labD50ToSrgb(lab), neutral: lab[1] === 0 && lab[2] === 0 });
    }
  };

  const [filter, setFilter] = useState("");
  // The palette, grouped by source chart in palette order (the Classic
  // first), narrowed by the filter field the list earns past a dozen
  // entries.
  const paletteGroups: { chart: string; entries: PaletteTarget[] }[] = [];
  {
    const needle = filter.trim().toLowerCase();
    for (const p of palette) {
      if (needle && !p.name.toLowerCase().includes(needle)) continue;
      const g = paletteGroups.find((g) => g.chart === p.chart);
      if (g) g.entries.push(p);
      else paletteGroups.push({ chart: p.chart, entries: [p] });
    }
  }

  const hasNeutral = cells.some((t) => t?.neutral);

  const save = async () => {
    const nm = name.trim();
    if (!nm) return;
    const slug = nm.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
    const id = `custom-${slug || "chart"}`;
    const patches = cells.map((t, i) =>
      t ? { name: t.label, lab: t.lab } : { name: cellAddress(rows, cols, i), lab: null },
    );
    const neutrals = cells.flatMap((t, i) => (t && t.neutral ? [i] : []));
    const json = JSON.stringify({ id, name: nm, rows, cols, source: "Custom chart", neutrals, skin: [], patches });
    try {
      const def = await chartSave(json);
      addChart(def);
      dispatch({ type: "set_text_param", id: nodeId, param: "chart", value: def.id });
      flashStatus(`Saved chart "${nm}"`);
      onClose();
    } catch (e) {
      reportToolError("Save chart", e);
    }
  };

  const doImport = async () => {
    try {
      const report = await chartImport();
      await reloadCharts();
      if (report.failed.length > 0) {
        reportToolError("Import charts", report.failed.map(([f, why]) => `${f}: ${why}`).join("; "));
      } else if (report.imported.length > 0) {
        flashStatus(`Imported ${report.imported.join(", ")}`);
      }
    } catch (e) {
      reportToolError("Import charts", e);
    }
  };

  const doExport = async () => {
    if (!currentChart) return;
    try {
      const dest = await chartExport(currentChart.id, currentChart.name);
      if (dest) flashStatus(`Exported chart to ${dest}`);
    } catch (e) {
      reportToolError("Export chart", e);
    }
  };

  const field: React.CSSProperties = {
    width: 44,
    padding: "3px 5px",
    background: "var(--bg-app)",
    border: "1px solid var(--line-4)",
    color: "var(--text-body)",
    outline: "none",
  };

  // To the body, like the chrome's menus (chrome.tsx FixedMenu): this
  // renders from inside the Develop panel, which already wears .ui-zoom,
  // so in place the box took that zoom twice and the inset:0 backdrop
  // was scaled with it. At the largest UI size the dialog then stood
  // wider than the window with its top cut off. Portaled, the one
  // .ui-zoom below applies once and the backdrop is the real viewport.
  const dialog = (
    <div
      ref={dialogRef}
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.preventDefault();
          e.stopPropagation();
          onClose();
        } else if (e.key === "Tab") {
          const items = Array.from(e.currentTarget.querySelectorAll<HTMLElement>(
            'button:not(:disabled), input:not(:disabled), select:not(:disabled), [tabindex="0"]',
          ));
          const first = items[0], last = items[items.length - 1];
          if (e.shiftKey && document.activeElement === first) {
            e.preventDefault(); last?.focus();
          } else if (!e.shiftKey && document.activeElement === last) {
            e.preventDefault(); first?.focus();
          }
        }
      }}
      role="dialog"
      aria-modal="true"
      aria-label="Custom chart"
      data-testid="charteditor"
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 130,
        background: "rgba(12,11,10,.78)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      <div
        className="ui-zoom"
        style={{
          // Two columns want the width one did not. Both bounds are
          // divided by the chrome zoom, because a vw or vh inside a
          // .ui-zoom wrapper is scaled by it again (nodepalette.tsx does
          // the same): without that, a wide dialog at a large UI size
          // runs past the window instead of stopping at it.
          width: "min(760px, calc((100vw - 24px) / var(--chrome-zoom)))",
          maxHeight: "calc((100vh - 32px) / var(--chrome-zoom))",
          overflowY: "auto",
          display: "flex",
          flexDirection: "column",
          gap: 8,
          background: "var(--bg-panel)",
          border: "1px solid #3a3735",
          boxShadow: "0 24px 60px rgba(0,0,0,.7)",
          padding: "14px 16px",
        }}
      >
        <div style={{ fontWeight: 600, letterSpacing: ".12em", color: "var(--text-hi)" }}>
          CUSTOM CHART
        </div>
        <div className="help">
          Set the grid, click a cell, and give it a target from the palette or a Lab value from the
          card's datasheet. A cell with no target is ignored by the fit.
        </div>
        <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
          <input
            data-testid="charteditor-name"
            value={name}
            placeholder="Chart name"
            aria-label="Chart name"
            onChange={(e) => setName(e.target.value)}
            style={{ ...field, flex: 1, width: undefined }}
          />
          <label className="lbl" style={{ display: "flex", gap: 4, alignItems: "center" }}>
            Rows
            <span style={{ width: 30, display: "inline-block" }}>
              <ValueField
                param="charteditor-rows"
                value={rows}
                lo={MIN_GRID}
                hi={MAX_ROWS}
                step={1}
                display={(v) => String(Math.round(v))}
                testid="charteditor-rows"
                hint="Rows in the chart's grid, 1 to 12; drag sideways, use the arrows, or type"
                onCommit={(v) => resize(Math.round(v), cols)}
              />
            </span>
          </label>
          <label className="lbl" style={{ display: "flex", gap: 4, alignItems: "center" }}>
            Cols
            <span style={{ width: 30, display: "inline-block" }}>
              <ValueField
                param="charteditor-cols"
                value={cols}
                lo={MIN_GRID}
                hi={MAX_COLS}
                step={1}
                display={(v) => String(Math.round(v))}
                testid="charteditor-cols"
                hint="Columns in the chart's grid, 1 to 14; drag sideways, use the arrows, or type"
                onCommit={(v) => resize(rows, Math.round(v))}
              />
            </span>
          </label>
        </div>
        {/* The grid and its targets side by side (26.3.1): the column of
            colors stands beside the chart instead of unfolding below it, so
            it is there before any cell is clicked and picking a cell never
            resizes the dialog under the pointer. */}
        <div style={{ display: "flex", gap: 12, alignItems: "flex-start" }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div
              data-testid="charteditor-grid"
              style={{
                display: "grid",
                gridTemplateColumns: `repeat(${cols}, 1fr)`,
                gap: 3,
              }}
            >
              {cells.map((t, i) => (
                <button
                  key={i}
                  data-testid={`charteditor-cell-${i}`}
                  title={`${cellAddress(rows, cols, i)}${t ? `: ${t.label}` : ": no target"}`}
                  onClick={() => setPicked(i)}
                  style={{
                    aspectRatio: "1",
                    minWidth: 0,
                    padding: 0,
                    cursor: "pointer",
                    background: t
                      ? `rgb(${t.rgb.map((v) => Math.round(Math.max(0, Math.min(1, v)) * 255)).join(", ")})`
                      : "transparent",
                    border: `1.5px ${t ? "solid" : "dashed"} ${picked === i ? "var(--text-hi)" : "var(--line-4)"}`,
                    boxSizing: "border-box",
                  }}
                />
              ))}
            </div>
          </div>
          <div
            data-testid="charteditor-picker"
            style={{ width: 268, flexShrink: 0, display: "flex", flexDirection: "column", gap: 6 }}
          >
            <div className="help" style={{ color: "var(--text-body)" }}>
              Target for {cellAddress(rows, cols, picked)}
            </div>
            {palette.length > 12 && (
              <input
                data-testid="charteditor-palette-filter"
                value={filter}
                placeholder="Filter colors by name"
                aria-label="Filter colors by name"
                onChange={(e) => setFilter(e.target.value)}
                style={{ ...field, width: undefined }}
              />
            )}
            <div
              data-testid="charteditor-palette"
              style={{ display: "flex", flexDirection: "column", gap: 4, minHeight: 120, maxHeight: 260, overflowY: "auto" }}
            >
              {paletteGroups.map((g) => (
                <div key={g.chart}>
                  <div
                    data-testid={`charteditor-palette-group-${g.chart}`}
                    className="lbl"
                    style={{ letterSpacing: ".08em", marginBottom: 1 }}
                  >
                    {g.chart.toUpperCase()}
                  </div>
                  {g.entries.map((p) => (
                    <button
                      key={p.key}
                      data-testid={`charteditor-target-${p.key}`}
                      title={`${p.name}, ${p.chart}`}
                      onClick={() => assign(picked, { label: p.name, lab: p.lab, rgb: p.rgb, neutral: p.neutral })}
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: 6,
                        width: "100%",
                        background: "none",
                        border: "none",
                        padding: "1px 2px",
                        cursor: "pointer",
                        color: "var(--text-body)",
                      }}
                    >
                      <span
                        style={{
                          width: 12,
                          height: 12,
                          borderRadius: 2,
                          flexShrink: 0,
                          background: `rgb(${p.rgb.map((v) => Math.round(v * 255)).join(", ")})`,
                          border: "1px solid var(--line-4)",
                        }}
                      />
                      <span style={{ flex: 1, textAlign: "left", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                        {p.name}
                      </span>
                      <span className="lbl" style={{ flexShrink: 0 }}>{p.chart}</span>
                    </button>
                  ))}
                </div>
              ))}
            </div>
            {/* A color of your own, typed as sRGB hex or as Lab from the
                card's datasheet. The two modes are one value: switching
                converts through the engine's D50 Lab math (labconvert.ts),
                and the swatch shows what the fit will aim at. */}
            <div style={{ display: "flex", gap: 4, alignItems: "center", flexWrap: "wrap" }}>
              <button
                className="chip"
                data-testid="charteditor-colour-hex"
                aria-pressed={colourMode === "hex"}
                data-hint="Type the color as sRGB hex"
                onClick={() => switchColourMode("hex")}
              >
                Hex
              </button>
              <button
                className="chip"
                data-testid="charteditor-colour-lab"
                aria-pressed={colourMode === "lab"}
                data-hint="Type the color as Lab from the card's datasheet"
                onClick={() => switchColourMode("lab")}
              >
                Lab
              </button>
              {colourMode === "hex" ? (
                <input
                  data-testid="charteditor-hex"
                  value={hex}
                  placeholder="#rrggbb"
                  aria-label="Color as sRGB hex"
                  onChange={(e) => setHex(e.target.value)}
                  style={{ ...field, width: 64 }}
                />
              ) : (
                <>
                  <label className="lbl" style={{ display: "flex", gap: 3, alignItems: "center" }}>
                    L
                    <input
                      data-testid="charteditor-lab-l"
                      value={labL}
                      placeholder="0 to 100"
                      aria-label="L"
                      onChange={(e) => setLabL(e.target.value)}
                      style={field}
                    />
                  </label>
                  <label className="lbl" style={{ display: "flex", gap: 3, alignItems: "center" }}>
                    a
                    <input
                      data-testid="charteditor-lab-a"
                      value={labA}
                      placeholder="-128 to 127"
                      aria-label="a"
                      onChange={(e) => setLabA(e.target.value)}
                      style={field}
                    />
                  </label>
                  <label className="lbl" style={{ display: "flex", gap: 3, alignItems: "center" }}>
                    b
                    <input
                      data-testid="charteditor-lab-b"
                      value={labB}
                      placeholder="-128 to 127"
                      aria-label="b"
                      onChange={(e) => setLabB(e.target.value)}
                      style={field}
                    />
                  </label>
                </>
              )}
              <span
                data-testid="charteditor-colour-swatch"
                title="The color the fit will aim at"
                style={{
                  width: 14,
                  height: 14,
                  borderRadius: 2,
                  flexShrink: 0,
                  background: colourSwatch ?? "transparent",
                  border: `1px ${colourSwatch ? "solid" : "dashed"} var(--line-4)`,
                }}
              />
              <button className="chip" data-testid="charteditor-colour-set" onClick={() => setColour(picked)}>
                Set color
              </button>
              <button
                className="chip"
                data-testid="charteditor-clear"
                data-hint="Clear this cell's target"
                onClick={() => assign(picked, null)}
              >
                Clear
              </button>
            </div>
          </div>
        </div>
        {!hasNeutral && (
          <div data-testid="charteditor-no-neutral" className="help" style={{ color: "var(--text-warn, #c66)" }}>
            No gray control: the fit cannot set white balance from this chart.
          </div>
        )}
        <div style={{ display: "flex", gap: 6, alignItems: "center", marginTop: 4 }}>
          <button className="chip" data-testid="charteditor-import" onClick={() => void doImport()}>
            Import...
          </button>
          {currentChart && (
            <button
              className="chip"
              data-testid="charteditor-export"
              data-hint={`Write ${currentChart.name}'s chart file out to share it`}
              onClick={() => void doExport()}
            >
              Export current
            </button>
          )}
          <span style={{ flex: 1 }} />
          <button className="chip" data-testid="charteditor-cancel" onClick={onClose}>
            Cancel
          </button>
          <button
            className="chip"
            data-testid="charteditor-save"
            disabled={!name.trim()}
            onClick={() => void save()}
          >
            Save chart
          </button>
        </div>
      </div>
    </div>
  );
  return typeof document !== "undefined" && document.body ? createPortal(dialog, document.body) : dialog;
}
