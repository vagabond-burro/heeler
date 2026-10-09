/** The Zone System's ruler, in the Exposure section on any photograph,
 * color or mono (2026-09-14: "Could this not apply non black and white
 * photos?"): eleven swatches, 0 to X, black to white with Zone V at
 * middle gray, with a histogram of the picture's tones by zone above
 * them. Hover a zone and the frame lights the pixels in it; the eye
 * shows the whole frame posterized to its zones, a spot meter reading
 * the scene. Click a zone to arm the placement: the next click on the
 * photograph lands that spot on the zone by Exposure. Choose another
 * zone and click a second spot, and the Tone Profile's contrast (the
 * development) lands it with the first held: expose for the shadows,
 * develop for the highlights. A fold in the Exposure section, closed
 * until opened; the Exposure reset and Undo are the ways back, there
 * is no reset here.*/

import { useEffect, useState } from "react";
import { ZONES, ZONE_NAMES, zoneCentre, zoneOfSrgb } from "../blackwhite";
import { developmentDial } from "../film";
import { nodeThumbs } from "../bridge";
import type { Command, State } from "../state";
import { renderedSource, chainTerminalId } from "../state";

type D = React.Dispatch<Command>;

/** The share of the frame in each zone, peak-normalized, read off the
 * frame on screen the way the Levels histogram is; null without one. */
export function useZoneBins(src: string | undefined | null): number[] | null {
  const [bins, setBins] = useState<number[] | null>(null);
  useEffect(() => {
    if (!src) {
      setBins(null);
      return;
    }
    let live = true;
    const img = new Image();
    img.onload = () => {
      try {
        const c = document.createElement("canvas");
        const scale = Math.min(1, 128 / (img.width || 128));
        c.width = Math.max(1, Math.round((img.width || 128) * scale));
        c.height = Math.max(1, Math.round((img.height || 64) * scale));
        const ctx = c.getContext("2d")!;
        ctx.drawImage(img, 0, 0, c.width, c.height);
        const d = ctx.getImageData(0, 0, c.width, c.height).data;
        const b = new Array<number>(ZONES).fill(0);
        for (let i = 0; i < d.length; i += 4) {
          if (d[i + 3] === 0) continue;
          b[zoneOfSrgb(d[i] / 255, d[i + 1] / 255, d[i + 2] / 255)]++;
        }
        const peak = Math.max(...b, 1);
        if (live) setBins(b.map((v) => v / peak));
      } catch {
        if (live) setBins(null);
      }
    };
    img.src = src;
    return () => {
      live = false;
    };
  }, [src]);
  return bins;
}

/** A small plain render of the chain's end, on the edit clock, for
 * the bars: the frame on screen is the overlay while a zone view is
 * up or a zone is hovered, and counting the overlay's paint was the
 * bars lying (review 2026-09-15, item 4). Null until it lands, or
 * without an engine, when the caller falls back to the frame it has. */
/** The plain render's edge: what the bars downscale to. */
export const BARS_EDGE = 128;

function usePlainEndThumb(state: State, wanted: boolean): string | null {
  const terminal = chainTerminalId(state.nodes, state.wires) ?? null;
  const [thumb, setThumb] = useState<string | null>(null);
  useEffect(() => {
    if (!wanted || !terminal) {
      setThumb(null);
      return;
    }
    let live = true;
    const t = window.setTimeout(() => {
      // At the size the bars count at, which also tells this request
      // from the Hue curve's 200 px source in the tests.
      void nodeThumbs(state, [terminal], BARS_EDGE).then((got) => {
        if (!live) return;
        setThumb(got?.[terminal] ?? null);
      });
    }, 250);
    return () => {
      live = false;
      window.clearTimeout(t);
    };
    // The edit clock and the photograph are what change the picture;
    // the state object itself changes on every keystroke, and the
    // views must not re-render the bars, which is the point.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.renderVersion, state.activeImage, terminal, wanted]);
  return thumb;
}

export function ZonesBlock({ state, dispatch, frame }: { state: State; dispatch: D; frame?: string | null }) {
  const armed = state.zonePlace;
  const open = state.zonesOpen;
  const plain = usePlainEndThumb(state, open);
  // A view on screen (a zone lit, the Zones eye) paints the frame, so
  // the bars never read it: the plain render, or nothing until it
  // lands rather than a count of the paint.
  const viewUp = state.zonesView || state.zoneHover !== null;
  const bins = useZoneBins(open ? (plain ?? (viewUp ? null : frame)) : null);
  const zoneName = (k: number | null) => (k === null ? "" : ZONE_NAMES[k]);
  // The development the second spot moves: the film's when a stock is
  // on the profile, Exposure's Luminance otherwise.
  const dev = developmentDial(state.nodes, renderedSource(state)) === "film" ? "Film > Development" : "Exposure > Luminance";
  return (
    <div data-testid="bw-zones" style={{ marginTop: 10 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: open ? 3 : 0 }}>
        {/* The fold's own button: the chevron and the name, the panel's
            disclosure idiom (the preset browser's folders). */}
        <button
          data-testid="bw-zones-fold"
          onClick={() => dispatch({ type: "toggle_zones_fold" })}
          aria-expanded={open}
          aria-label="Zones"
          data-hint={open ? "Fold the Zone System away" : "The Zone System: place a spot on a zone and Exposure's dials move to put it there"}
          style={{
            all: "unset", cursor: "pointer", display: "flex", alignItems: "center", gap: 6,
            fontSize: 10, letterSpacing: ".08em", textTransform: "uppercase", color: "#969ca0",
          }}
        >
          <svg width="8" height="8" viewBox="0 0 24 24" fill="none" stroke="var(--text-faint)" strokeWidth="3"
            style={{ transform: open ? "none" : "rotate(-90deg)", transition: "transform .1s" }}>
            <path d="M6 9l6 6 6-6" />
          </svg>
          Zones
        </button>
        {open && (
          <button
            className="chip"
            data-testid="bw-zones-view"
            data-active={state.zonesView || undefined}
            aria-pressed={state.zonesView}
            aria-label="Show the zone map"
            data-hint="Zone map: the picture posterized to its eleven zones, a spot meter reading the whole scene"
            style={{ padding: "0 7px", display: "inline-flex", alignItems: "center" }}
            onClick={() => dispatch({ type: "toggle_zones_view" })}
          >
            <svg width="13" height="11" viewBox="0 0 13 11" fill="none" stroke="currentColor" strokeWidth="1.2" aria-hidden="true">
              <rect x="1" y="2" width="11" height="7" rx="1" />
              <path d="M4.5 2v7M8.5 2v7" />
            </svg>
          </button>
        )}
      </div>
      {open && (
        <>
          <div
            data-testid="bw-zone-ruler"
            role="group"
            aria-label="Zones"
            style={{ display: "grid", gridTemplateColumns: `repeat(${ZONES}, 1fr)`, gap: 1 }}
            onMouseLeave={() => dispatch({ type: "set_zone_hover", zone: null })}
          >
            {/* The histogram by zone: where the picture's tones sit, and
                what a placement moves. */}
            {Array.from({ length: ZONES }, (_, k) => (
              <div key={`h${k}`} data-testid={`bw-zone-bar-${k}`} style={{ height: 22, display: "flex", alignItems: "flex-end" }}>
                <div style={{ width: "100%", height: `${Math.round((bins?.[k] ?? 0) * 22)}px`, background: "var(--accent)", opacity: 0.8 }} />
              </div>
            ))}
            {Array.from({ length: ZONES }, (_, k) => {
              const v = Math.round(zoneCentre(k) * 255);
              const isArmed = armed?.zone === k;
              const placed = armed?.first?.zone === k;
              return (
                <button
                  key={k}
                  data-testid={`bw-zone-${k}`}
                  data-active={isArmed || undefined}
                  data-placed={placed || undefined}
                  aria-pressed={isArmed}
                  aria-label={`Zone ${ZONE_NAMES[k]}`}
                  data-hint={
                    isArmed
                      ? `Zone ${ZONE_NAMES[k]} is chosen: now click the spot on the photograph that should be this tone. Click here again to put the picker down.`
                      : armed?.first
                        ? `Choose Zone ${ZONE_NAMES[k]} for the second spot, then click that spot on the photograph; ${dev} moves so both hold`
                        : `Zone ${ZONE_NAMES[k]}: hover to see it on the photograph; click to choose it, then click the spot that should be this tone and Exposure > Exposure moves`
                  }
                  style={{
                    height: 18,
                    padding: 0,
                    border: isArmed ? "2px solid var(--accent)" : placed ? "2px solid #f0a020" : "1px solid var(--line-4)",
                    background: `rgb(${v} ${v} ${v})`,
                    cursor: "pointer",
                  }}
                  onMouseEnter={() => dispatch({ type: "set_zone_hover", zone: k })}
                  onClick={() => dispatch({ type: "arm_zone_place", zone: k })}
                />
              );
            })}
            {Array.from({ length: ZONES }, (_, k) => (
              <div key={`n${k}`} style={{ fontSize: 8, textAlign: "center", color: "var(--text-ghost)", letterSpacing: ".04em" }}>
                {ZONE_NAMES[k]}
              </div>
            ))}
          </div>
          <div
            data-testid="bw-zones-help"
            style={{ fontSize: 10, color: "var(--text-ghost)", letterSpacing: ".05em", marginTop: 3, lineHeight: 1.5 }}
          >
            {armed?.first && armed.zone !== null
              ? `Zone ${zoneName(armed.zone)} chosen for the second spot. Click that spot on the photograph: ${dev} moves so it lands and Zone ${zoneName(armed.first.zone)} holds.`
              : armed?.first
                ? `Zone ${zoneName(armed.first.zone)} placed (Exposure > Exposure moved). NEXT: click the zone on this ruler for a second spot, then click that spot; ${dev} will move so both hold. Or Escape to stop here.`
                : armed
                  ? `Zone ${zoneName(armed.zone)} chosen. NEXT: click the spot on the photograph that should be this tone; Exposure > Exposure moves so it is.`
                  : "1 \u00b7 click a zone here \u00b7 2 \u00b7 click the spot on the photograph that should be that tone (Exposure > Exposure moves) \u00b7 3 \u00b7 optional: another zone here, then a second spot (" + dev + " moves so both hold)"}
          </div>
        </>
      )}
    </div>
  );
}
