// The Lens Flare section's own controls: the preset menu with the
// photograph's suggestion, the source choice (Rig lights, Bright
// spots), which lights in the Depth Lighting rig flare, the found
// sources' switches, and the Match chip for Depth of Field's blade
// count. The look
// dials are ordinary section rows; the rig is Depth Lighting's,
// mirrored onto this node by the reducer.

import React, { useEffect, useMemo, useRef, useState } from "react";
import { flareSpots, imageMetadata, serializeGraph } from "../bridge";
import { reportToolError } from "./hints";
import { FLARE_PRESETS, suggestFlarePreset, toolNode, type Command, type NodeCard, type State } from "../state";
import { lightsOf, writeLights } from "./keylightgizmoparts";
import { RibbonEditor } from "./ribbon";
import type { GradStop } from "./gradientstopsparts";
import { MenuField } from "./menufield";
import { readSpots, readSpotsOff, readStreakStops, spotIsOff, toggleSpotOff, writeSpots } from "./flareparts";

type D = React.Dispatch<Command>;

export function FlarePanel({ state, dispatch, node }: { state: State; dispatch: D; node: NodeCard }) {
  const keylight = toolNode(state, "keylight");
  const lights = keylight ? lightsOf(keylight) : [];
  const flaring = lights.filter((l) => l.flare && l.on).length;
  const preset = node.textParams?.preset ?? "";
  // The photograph's own suggestion, from its focal length and lens.
  const [suggested, setSuggested] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    void imageMetadata(state, state.activeImage)
      .then((m) => {
        if (!live) return;
        const focal = m?.focal ? parseFloat(String(m.focal)) : null;
        setSuggested(suggestFlarePreset(Number.isFinite(focal as number) ? focal : null, m?.lens ?? null));
      })
      .catch(() => {});
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.activeImage]);
  // The look dials the preset owns: apply writes exactly these.
  const applyPreset = (id: string) => {
    const p = FLARE_PRESETS.find((x) => x.id === id);
    if (!p) return;
    dispatch({ type: "set_params", id: node.id, values: { ...p.params }, text: { preset: id, ...(p.text ?? {}) } });
  };
  const edited =
    preset !== "" &&
    (() => {
      const p = FLARE_PRESETS.find((x) => x.id === preset);
      return !!p && Object.entries(p.params).some(([k, v]) => (node.params[k] ?? v) !== v);
    })();
  // Depth of Field's blade count against ours, when both are on.
  // The rig is Depth Lighting's, and the two sections switch on their
  // own: a flare without relighting is a thing to want. Said, so a
  // switched-off Depth Lighting with a flare still showing is not a
  // mystery.
  const relightOn = !!keylight && keylight.enabled && state.nodes.some((n) => n.id === keylight.id);
  const dof = toolNode(state, "dof");
  const dofOn = !!dof && dof.enabled && state.nodes.some((n) => n.id === dof.id);
  const dofBlades = dofOn ? Math.round((dof!.params.blades as number) ?? 6) : null;
  const ourBlades = Math.round((node.params.blades as number) ?? 7);
  // The source choice: a flare from before it has neither param and is
  // Rig lights alone.
  const rigOn = ((node.params.rig as number) ?? 1) >= 0.5;
  const brightOn = ((node.params.bright as number) ?? 0) >= 0.5;
  const spots = readSpots(node.textParams?.spots);
  const spotsOff = readSpotsOff(node.textParams?.spots_off);
  return (
    <div data-testid="flare-panel" style={{ display: "flex", flexDirection: "column", gap: 5, margin: "2px 0 6px" }}>
      <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
        <span style={{ fontSize: 9, letterSpacing: ".08em", color: "var(--text-dim)" }}>LENS</span>
        <MenuField
          testid="flare-preset"
          label="Lens preset"
          hint="A lens's flare character: the look dials, not the rig. Suggested from the photograph's focal length and lens name, never applied by itself"
          node={node.id}
          param="preset"
          size="regular"
          value={preset}
          placeholder={preset === "" ? "Choose a lens…" : "Custom"}
          options={FLARE_PRESETS.map((p) => ({
            id: p.id,
            label: `${p.name}${p.id === suggested ? " · suggested" : ""}${p.id === preset && edited ? " · edited" : ""}`,
          }))}
          onChange={applyPreset}
        />
      </div>
      {/* Where the flare's sources come from: the rig's lights, the
          photograph's own bright spots, or both (2026.7: "The owner
          expected the photo's own bright spots to flare"). */}
      <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
        <span style={{ fontSize: 9, letterSpacing: ".08em", color: "var(--text-dim)" }}>SOURCES</span>
        {(
          [
            ["rig", "Rig lights", rigOn, "Depth Lighting's lights with their flare switch on"],
            ["bright", "Bright spots", brightOn, "The photograph's own light sources: lamps, headlights, a sun in frame. No Depth Lighting needed"],
          ] as const
        ).map(([param, label, on, what]) => (
          <button
            key={param}
            className="chip"
            data-testid={`flare-source-${param}`}
            aria-pressed={on}
            data-active={on}
            data-hint={on ? `${what}. Click to stop them flaring` : `Flare from ${what.charAt(0).toLowerCase()}${what.slice(1)}`}
            style={{ fontSize: 9, padding: "0 6px" }}
            onClick={() => dispatch({ type: "set_param", id: node.id, param, value: on ? 0 : 1 })}
          >
            {label}
          </button>
        ))}
      </div>
      {!rigOn ? null : lights.length === 0 || !keylight ? (
        <div data-testid="flare-no-lights" style={{ fontSize: 9, color: "var(--text-faint)", lineHeight: 1.5 }}>
          No light to flare: add one in Depth Lighting.
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
          {lights.map((l, i) => (
            <div key={i} style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 10 }}>
              <button
                className="chip"
                data-testid={`flare-light-${i}`}
                aria-pressed={l.flare}
                data-hint={l.flare ? "This light flares; click to stop it" : "Let this light flare"}
                style={{ fontSize: 9, padding: "0 6px", color: l.flare ? "var(--accent)" : "var(--text-ghost)" }}
                onClick={() =>
                  writeLights(dispatch, keylight, lights.map((k, j) => (j === i ? { ...k, flare: !k.flare } : k)))
                }
              >
                {l.flare ? "\u25cf" : "\u25cb"}
              </button>
              <span style={{ color: l.on ? "var(--text-body)" : "var(--text-ghost)" }}>
                {`Light ${i + 1} · ${l.kind}${l.on ? "" : " (off)"}`}
              </span>
            </div>
          ))}
          {flaring === 0 && !brightOn && (
            <div data-testid="flare-none-flaring" style={{ fontSize: 9, color: "var(--text-faint)", lineHeight: 1.5 }}>
              No light is flaring: switch one on above.
            </div>
          )}
          {flaring > 0 && !relightOn && (
            <div data-testid="flare-relight-off" style={{ fontSize: 9, color: "var(--text-faint)", lineHeight: 1.5 }}>
              Depth Lighting is off: its lights do not relight the scene, but they still flare here.
            </div>
          )}
        </div>
      )}
      {/* The found sources, brightest first, one switch each: a
          source that should not flare is dropped here without raising
          the threshold, and stays off as the dials move (keyed by where
          it is). */}
      {brightOn && (
        <div data-testid="flare-spots" style={{ display: "flex", flexDirection: "column", gap: 2 }}>
          {spots.length === 0 ? (
            <div data-testid="flare-no-spots" style={{ fontSize: 9, color: "var(--text-faint)", lineHeight: 1.5 }}>
              No bright spot found: lower Threshold or Min size.
            </div>
          ) : (
            spots.map((sp, i) => {
              const on = !spotIsOff(sp, spotsOff);
              return (
                <div key={`${sp.x},${sp.y}`} style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 10 }}>
                  <button
                    className="chip"
                    data-testid={`flare-spot-${i}`}
                    aria-pressed={on}
                    data-hint={on ? "This bright spot flares; click to stop it" : "Let this bright spot flare"}
                    style={{ fontSize: 9, padding: "0 6px", color: on ? "var(--accent)" : "var(--text-ghost)" }}
                    onClick={() =>
                      dispatch({ type: "set_text_param", id: node.id, param: "spots_off", value: JSON.stringify(toggleSpotOff(sp, spotsOff)) })
                    }
                  >
                    {on ? "\u25cf" : "\u25cb"}
                  </button>
                  <span
                    aria-hidden
                    style={{
                      width: 8,
                      height: 8,
                      borderRadius: 4,
                      background: `rgb(${sp.color.map((c) => Math.round(255 * Math.pow(Math.max(0, Math.min(1, c)), 1 / 2.2))).join(",")})`,
                    }}
                  />
                  <span style={{ color: on ? "var(--text-body)" : "var(--text-ghost)" }}>
                    {`Spot ${i + 1} · ${Math.round(sp.x * 100)}%, ${Math.round(sp.y * 100)}% · ${Math.round(sp.strength * 100)}`}
                  </span>
                </div>
              );
            })
          )}
        </div>
      )}
      {/* One aperture per lens: when Depth of Field is on and disagrees,
          say so and offer the match. An explicit click, one node
          written, undoable on its own (the rule against cross-section
          writes). */}
      {dofBlades !== null && dofBlades !== ourBlades && (
        <div data-testid="flare-blades-mismatch" style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 9, color: "var(--text-faint)" }}>
          <span>{`Depth of Field is drawing ${dofBlades} blades`}</span>
          <button
            className="chip"
            data-testid="flare-blades-match"
            data-hint="Set Depth of Field's blade count to this flare's, so bokeh and ghosts share one aperture"
            style={{ fontSize: 9, padding: "0 6px" }}
            onClick={() => dispatch({ type: "set_param", id: dof!.id, param: "blades", value: Math.min(9, ourBlades) })}
          >
            Match
          </button>
        </div>
      )}
    </div>
  );
}

/** Finds Lens Flare's Bright spots for every flare that asks (on,
 * Bright spots on) and writes them onto its node: once per photograph
 * and input, after a gesture ends. The desktop keys its cache by the
 * flare's input and the dials, so a re-ask after an edit elsewhere is
 * a key, not a render; the node keeps the list, so the fit view, 1:1
 * slices and the export draw the same sources. */
export function FlareSpotsRunner({ state, dispatch }: { state: State; dispatch: D }) {
  const asking = state.nodes.filter((n) => n.type === "heeler.flare" && n.enabled && ((n.params.bright as number) ?? 0) >= 0.5);
  const ids = asking.map((n) => n.id).join(",");
  // What the answer depends on: the graph without the lists the answer
  // itself writes (else every write would ask again).
  const mark = useMemo(() => {
    if (!ids || !state.activeImage) return "";
    const bare = state.nodes.map((n) =>
      n.type === "heeler.flare" ? { ...n, textParams: { ...n.textParams, spots: "", spots_off: "" } } : n,
    );
    return `${state.activeImage}|${ids}|${JSON.stringify(serializeGraph({ ...state, nodes: bare }))}`;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ids, state.activeImage, state.nodes, state.wires]);
  const latest = useRef(state);
  latest.current = state;
  const asked = useRef("");
  useEffect(() => {
    if (!mark || state.gesture !== null || asked.current === mark) return;
    const image = state.activeImage;
    let live = true;
    const t = setTimeout(() => {
      asked.current = mark;
      for (const id of ids.split(",")) {
        void flareSpots(latest.current, id)
          .then((found) => {
            if (live) dispatch({ type: "flare_spots_found", id, image, spots: writeSpots(found) });
          })
          .catch((err) => reportToolError("Lens Flare", err));
      }
    }, 120);
    return () => {
      live = false;
      clearTimeout(t);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mark, state.gesture]);
  return null;
}

/** The anamorphic streak's color ribbon: a stop list from the source
 * (0) to the streak's end (100), the gradient layer's shape, edited
 * inline under the Anamorphic dials. Empty means the single streak
 * color. "not a solid color, it should be a color ribbon
 * to set gradients from the light source to edge."*/
export function StreakRibbon({ state, dispatch, node }: { state: State; dispatch: D; node: NodeCard }) {
  void state;
  const single = node.textParams?.streak_color ?? "#5aa0ff";
  const stops = readStreakStops(node.textParams?.streak_stops, single);
  const custom = (node.textParams?.streak_stops ?? "").trim() !== "";
  const write = (next: GradStop[]) =>
    dispatch({ type: "set_text_param", id: node.id, param: "streak_stops", value: JSON.stringify(next) });
  return (
    <div data-testid="flare-streak-ribbon" style={{ margin: "2px 0 8px", display: "flex", flexDirection: "column", gap: 3 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
        <span style={{ fontSize: 9, letterSpacing: ".08em", color: "var(--text-dim)" }}>STREAK COLOR</span>
        <span style={{ fontSize: 9, color: "var(--text-ghost)" }}>source on the left, the streak's end on the right</span>
        {custom && (
          <button
            className="chip"
            data-testid="flare-streak-clear"
            data-hint="Back to one color along the whole streak"
            style={{ fontSize: 9, padding: "0 6px", marginLeft: "auto" }}
            onClick={() => dispatch({ type: "set_text_param", id: node.id, param: "streak_stops", value: "" })}
          >
            Single
          </button>
        )}
      </div>
      <RibbonEditor
        testid="flare-streak"
        stops={stops}
        onChange={write}
        onBegin={() => dispatch({ type: "begin_gesture", key: `${node.id}.streak_stops` })}
        onEnd={() => dispatch({ type: "end_gesture" })}
      />
    </div>
  );
}
