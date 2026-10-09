/** The black and white treatment's controls, once (2026-09-14:
 * "all Adjustments does is take the controls for each node and wrap
 * them in collapsible sections... I fear you've been doing this in the
 * least effective way by making duplicates"). The Develop panel
 * mounts this inside Color's treatment block; the graph inspector
 * mounts it on the Black & White node. One component, one order: the
 * mixer, the Hue curve, Film with its Development, the Filter.
 *
 * Film and Development are the Tone Profile's params, found among the
 * nodes handed in, because the treatment is where a user reaches for
 * them; the profile's own node shows the same two through FilmBlock.
 *
 * With `state` (the panel, or the inspector while the app is up) the
 * pickers, the Collisions eye and the input histogram are live; without
 * it (a bare inspector) the curve and the menus still edit the node. */

import { bwDefaultPoints } from "../blackwhite";
import { parseEqPoints, recolorLayouts, serializeEqPoints } from "../eqcurve";
import { IR_DEFAULTS, IR_MATERIALS, filmStock, irPriorPoints } from "../film";
import { isInfrared, wrattenFilter } from "../filters";
import { useState } from "react";
import type { Command, NodeCard, State } from "../state";
import { EqEditor } from "./eqeditor";
import { FilmBlock } from "./film";
import { FilterMenu } from "./filtermenu";
import { useHueSourceThumb } from "./huesource";
import { ResetIcon } from "./panelicons";
import { Slider } from "./simple";
import { COLLISION_TOLERANCE_MAX, collisionBins, renderedSource } from "../state";
import { TrackSlider } from "./track";
import { DepthViewButton } from "./smarttool";

type D = React.Dispatch<Command>;

export function BwControls({
  bw,
  nodes,
  dispatch,
  state,
  width,
}: {
  bw: NodeCard;
  nodes: NodeCard[];
  dispatch: D;
  state?: State;
  width?: number;
}) {
  const profile = nodes.find((n) => n.type === "heeler.tone_profile");
  // The stock the conversion develops on: the profile's when there is
  // one, the conversion's own when there is not (the serializer's rule,
  // and a conversion with no profile below keeps the film it carries).
  const filmKey = profile ? (profile.textParams?.film ?? "") : (bw.textParams?.film ?? "");
  const spectral =
    wrattenFilter(bw.textParams?.filter) !== null || filmStock(filmKey) !== null;
  // Near and Far share the one film (the engine builds both conversions
  // on it), so the fold's test reads the same key for both.
  const infrared = isInfrared(bw.textParams?.filter, filmKey) || isInfrared(bw.textParams?.far_filter, filmKey);
  const [irCurveOpen, setIrCurveOpen] = useState(false);
  const irStored = parseEqPoints(bw.textParams?.ir_curve);
  const irDrawn = irStored.length >= 2;
  const stored = parseEqPoints(bw.textParams?.hue_curve);
  const pts = stored.length >= 2 ? stored : bwDefaultPoints();
  const inputThumb = useHueSourceThumb(state, bw.id);
  const fallback = state?.images.find((i) => i.id === state.activeImage)?.src;
  const curveOn = (bw.params.hue_curve_on ?? 1) !== 0;
  const farKey = bw.textParams?.far_filter ?? "";
  const farOn = wrattenFilter(farKey) !== null && farKey !== (bw.textParams?.filter ?? "");
  const depthStored = parseEqPoints(bw.textParams?.depth_curve);
  const depthPts = depthStored.length >= 2 ? depthStored : [{ x: 0, y: 0 }, { x: 100, y: 100 }];
  const total = Math.round((bw.params.red ?? 30) + (bw.params.green ?? 59) + (bw.params.blue ?? 11));
  const off = Math.abs(total - 100) > 2;
  return (
    <>
      <Slider label="Strength" param="amount" node={bw} dispatch={dispatch} centered={false} />
      {/* The weights stand down while a filter or a stock makes the
conversion spectral, and say so in the status line (2026-09-15:
"why are the Red Green and Blue sliders grayed out?").*/}
      <div
        data-testid="bw-mixer-weights"
        style={spectral ? { opacity: 0.45 } : undefined}
        data-hint={
          spectral
            ? "The mixer's weights stand down while a Filter or a Film is on: the gray is the color's spectrum through them. Set both to None to mix by weight again"
            : undefined
        }
      >
        {(["red", "green", "blue"] as const).map((p) => (
          <Slider key={p} label={p[0].toUpperCase() + p.slice(1)} param={p} node={bw} dispatch={dispatch} />
        ))}
      </div>
      {/* Weights apply directly, so the total is the overall brightness
          of the conversion: 100% keeps the original level. */}
      <div
        data-testid="bw-total"
        style={{ display: "flex", justifyContent: "space-between", fontSize: 9, marginTop: 3, color: off ? "var(--accent)" : "var(--text-ghost)" }}
        data-hint={off ? "Weights total away from 100% brighten or darken the conversion" : "Weights total 100%: brightness matches the original"}
      >
        <span style={{ letterSpacing: ".08em" }}>TOTAL</span>
        <span className="tnum">{total}%</span>
      </div>
      {/* The hue curve: the expert face over the same conversion, with its
switch, the Collisions eye, its own reset, the eyedropper and Separate
as the editor's chips, and the input's hues as bars under the curve.*/}
      <div data-testid="bw-hue-curve" style={{ marginTop: 8 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 2 }}>
          <div className="kicker">Hue</div>
          <div
            className="toggle"
            data-on={curveOn}
            data-testid="bw-hue-on"
            data-node={bw.id}
            data-param="hue_curve_on"
            role="switch"
            aria-checked={curveOn}
            aria-label="Hue curve on"
            data-hint="Switch the hue curve off to see the picture without it; the points stay"
            tabIndex={0}
            onClick={() => dispatch({ type: "set_param", id: bw.id, param: "hue_curve_on", value: curveOn ? 0 : 1 })}
          >
            <div className="dot" />
          </div>
          {state && (
            <button
              className="chip"
              data-testid="bw-collision-view"
              data-active={state.collisionView || undefined}
              aria-pressed={state.collisionView}
              aria-label="Show the colors that merge"
              data-hint="Collisions: the colors that land on one gray, each painted in its own hue over the picture dimmed; push them apart with the curve or Separate"
              style={{ padding: "0 7px", display: "inline-flex", alignItems: "center" }}
              onClick={() => dispatch({ type: "toggle_collision_view" })}
            >
              <svg width="13" height="11" viewBox="0 0 13 11" fill="none" stroke="currentColor" strokeWidth="1.3" aria-hidden="true">
                <circle cx="4.6" cy="5.5" r="3.2" />
                <circle cx="8.4" cy="5.5" r="3.2" />
              </svg>
            </button>
          )}
          <button
            className="chip bare"
            data-testid="bw-hue-reset"
            aria-label="Reset the hue curve"
            data-hint="Reset the hue curve to flat; the mixer keeps its weights"
            style={{ marginLeft: "auto", padding: "2px 6px", color: "var(--text-ghost)", display: "flex", alignItems: "center" }}
            onClick={() => dispatch({ type: "set_text_param", id: bw.id, param: "hue_curve", value: "" })}
          >
            <ResetIcon />
          </button>
        </div>
        {/* The Collisions view's tolerance (2026-09-15): how far apart two grays
may be and still count as one collision, shown while the view is up or
Separate is armed, since that is when it means anything. Session state,
not a node param: a view's setting, like the view itself.*/}
        {state && (state.collisionView || state.bwSeparate) && (
          <div data-testid="bw-collision-tolerance" style={{ display: "flex", alignItems: "center", gap: 8, margin: "2px 0 4px" }}>
            <div
              className="kicker"
              data-hint="Tolerance: how far apart two grays may be and still count as one collision, either side, as a share of the tonal range. Wider finds colors that nearly merge; the rest is one of the view's bins, about three percent"
            >
              Tolerance
            </div>
            <div style={{ flex: 1 }}>
              <TrackSlider
                label="Collision tolerance"
                lo={0}
                hi={COLLISION_TOLERANCE_MAX}
                step={1}
                testid="bw-collision-tolerance-range"
                hint="How far apart two grays may be and still count as one collision, either side, as a share of the tonal range"
                value={state.collisionTolerance}
                onChange={(percent) => dispatch({ type: "set_collision_tolerance", percent })}
              />
            </div>
            <span style={{ fontSize: 10, color: "var(--text-dim)", minWidth: 44, textAlign: "right" }} data-testid="bw-collision-tolerance-value">
              ±{state.collisionTolerance}% ({collisionBins(state.collisionTolerance)})
            </span>
          </div>
        )}
        <div style={{ opacity: curveOn ? 1 : 0.45, transition: "opacity .15s" }}>
          <EqEditor
            node={bw}
            dispatch={dispatch}
            width={Math.max(220, (width ?? 320) - 34)}
            height={120}
            domain={[0, 360]}
            xTicks={[0, 60, 120, 180, 240, 300]}
            yRange={[-2, 2]}
            yUnit="EV"
            periodic
            histogramSrc={inputThumb ?? fallback}
            histChannel="hue"
            axisBackground="hue"
            spectrumBars
            points={pts}
            onPoints={(next) => dispatch({ type: "set_text_param", id: bw.id, param: "hue_curve", value: serializeEqPoints(next) })}
            presets={recolorLayouts("hue")}
            helpInStatus
            minPoints={2}
            pickArmed={state?.bwPick ?? false}
            onTogglePick={state ? () => dispatch({ type: "toggle_bw_pick" }) : undefined}
            pickTestId="bw-pick"
            pickLabel="Pick a hue from the photo"
            pickHint="Pick a hue on the photo: hover to see where it sits on the curve, click and drag up or down to lift or drop it"
            hoverX={state?.bwPick ? state.bwHoverHue : null}
            matchArmed={state ? state.bwSeparate !== null : false}
            onToggleMatch={state ? () => dispatch({ type: "toggle_bw_separate" }) : undefined}
            matchTestId="bw-separate"
            matchLabel="Separate two colors"
            matchHint="Separate: click one color, then another that lands on the same gray; the curve pushes them half a stop apart"
          />
        </div>
      </div>
      {/* Film (idea 4), then the filter in front of it (idea 5), below
          the curve: the stock the negative is developed as and its
          development, on the Tone Profile; the Wratten filter on the
          conversion. */}
      {profile && (
        <div data-testid="bw-film" style={{ marginTop: 8 }}>
          <FilmBlock node={profile} dispatch={dispatch} parked={!!state && !profile.enabled && !renderedSource(state)} />
          <Slider
            label="Development"
            param="development"
            node={profile}
            dispatch={dispatch}
            tip="Development time in N steps: N+1 is a push, steeper and a touch faster; N-1 a pull, flatter"
          />
        </div>
      )}
      <FilterMenu bw={bw} nodes={nodes} dispatch={dispatch} />
      {/* Near and Far: a second filter for the far end of the depth map, the
frame graded between the two conversions along depth by the curve
under it. The Filter above is the near end. The View depth eye rides
the row, since the row is the depth reader here, not the Color
section that hosts the treatment.*/}
      <FilterMenu
        bw={bw}
        nodes={nodes}
        dispatch={dispatch}
        testid="bw-far"
        param="far_filter"
        label="Far"
        noneLabel="Same as Filter"
        about="Far: the filter on the far end of the depth map, with the Filter above on the near end; the conversion grades between the two along depth, a red on the subject and a yellow on the distant sky. Same as Filter: one conversion for the whole frame. Needs the depth map"
        trailing={
          state ? (
            <DepthViewButton depthView={state.depthView} red={state.maskRed} onToggle={(flavor) => dispatch({ type: "toggle_depth_view", flavor })} testid="depth-view-bw" />
          ) : undefined
        }
      />
      {farOn && (
        <div data-testid="bw-depth-curve" style={{ marginTop: 4 }}>
          <EqEditor
            node={bw}
            dispatch={dispatch}
            width={Math.max(220, (width ?? 320) - 34)}
            height={90}
            domain={[0, 100]}
            xTicks={[0, 50, 100]}
            yRange={[0, 100]}
            yUnit="% far"
            axisBackground="depth"
            xEndLabels={["NEAR", "FAR"]}
            points={depthPts}
            interpParam="depth_interp"
            onPoints={(next) => dispatch({ type: "set_text_param", id: bw.id, param: "depth_curve", value: serializeEqPoints(next) })}
            helpInStatus
            minPoints={2}
          />
        </div>
      )}
      {/* Infrared (phase 4b): the guess past 700 nm as four materials, and the
curve that outranks them when drawn. An artistic tool, said so in
every hint (2026-09-14: "The user can't rely on this feature for
accurate simulation... Heeler isn't going to course correct them").*/}
      {infrared && (
        <div data-testid="bw-infrared" style={{ marginTop: 8 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 2 }}>
            <div
              className="kicker"
              data-hint="Infrared: the sensor recorded nothing past 700 nm, so what these films see is a guess from each color's hue, an artistic tool and not a simulation. These four dials change the guess; the curve behind them is the guess itself."
            >
              Infrared
            </div>
            <button
              className="chip"
              data-testid="bw-ir-curve-fold"
              data-active={irCurveOpen || undefined}
              aria-pressed={irCurveOpen}
              aria-label="The infrared guess as a curve"
              data-hint={
                irDrawn
                  ? "The guess as a curve of hue to stops; drawn, so it outranks the four dials. Reset it to have the dials back."
                  : "The guess as a curve of hue to stops, opening on what the four dials say; move a point and the curve takes over from them."
              }
              style={{ padding: "0 7px", display: "inline-flex", alignItems: "center", fontSize: 9 }}
              onClick={() => setIrCurveOpen((o) => !o)}
            >
              Curve{irDrawn ? " \u25cf" : ""}
            </button>
            <button
              className="chip bare"
              data-testid="bw-ir-reset"
              aria-label="Reset the infrared guess"
              data-hint="Reset the infrared guess: the four dials to the Wood effect's defaults, the curve undrawn"
              style={{ marginLeft: "auto", padding: "2px 6px", color: "var(--text-ghost)", display: "flex", alignItems: "center" }}
              onClick={() => dispatch({ type: "set_params", id: bw.id, values: { ...IR_DEFAULTS }, text: { ir_curve: "" } })}
            >
              <ResetIcon />
            </button>
          </div>
          <div style={irDrawn ? { opacity: 0.45 } : undefined} data-testid="bw-ir-materials">
            {IR_MATERIALS.map((m) => (
              <Slider key={m.key} label={m.label} param={m.key} node={bw} dispatch={dispatch} tip={m.tip} />
            ))}
          </div>
          {/* Neutral (2026-09-15: "sliders instead of relying on one fixed float
value to try and solve for every photo", then "Move Neutral into the
Infrared fold"): the guess's floor, one dial for every material,
since the gate is asked before any hue is looked up. Not dimmed by a
drawn curve: the curve outranks the four stops, not the floor.*/}
          <Slider
            label="Neutral"
            param="neutral"
            node={bw}
            dispatch={dispatch}
            centered={false}
            tip="How gray a color must be before the infrared guess leaves it alone: lower it to reach shaded, hazy colors (pines on a far ridge, a pale sky), raise it to hold them as the grays they are in the file"
          />
          {irCurveOpen && (
            <div data-testid="bw-ir-curve" style={{ marginTop: 4 }}>
              <EqEditor
                node={bw}
                dispatch={dispatch}
                width={Math.max(220, (width ?? 320) - 34)}
                height={110}
                domain={[0, 360]}
                xTicks={[0, 60, 120, 180, 240, 300]}
                yRange={[-4, 4]}
                yUnit="EV"
                periodic
                histogramSrc={inputThumb ?? fallback}
                histChannel="hue"
                axisBackground="hue"
                spectrumBars
                points={irDrawn ? irStored : irPriorPoints(bw.params)}
                interpParam="ir_interp"
                onPoints={(next) => dispatch({ type: "set_text_param", id: bw.id, param: "ir_curve", value: serializeEqPoints(next) })}
                presets={recolorLayouts("hue")}
                helpInStatus
                minPoints={2}
              />
            </div>
          )}
        </div>
      )}
    </>
  );
}
