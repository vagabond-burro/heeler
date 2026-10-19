// Color's white balance row: Auto, As Shot and the eyedropper. Declared
// on the Color section (its `whiteBalance` widget), so Develop's section
// and the Color node in Graph draw the same row. All three were chips
// with no onClick at all until the owner noticed ("Please wire them in
// so they actually do something"); the arithmetic behind them is in
// src/whitebalance.ts, mirrored from the engine's own gain model so a
// solve lands where the render does.
import type { Command, NodeCard, State } from "../state";
import { logDebug } from "../log";
import { AS_SHOT, averageColor, neutralize } from "../whitebalance";
import { flashStatus } from "./hints";
import { EyedropperIcon } from "./panelicons";

/** `frame` is the frame on screen, rendered with the current dials;
 * without the app's state (no viewer to click) the eyedropper hides. */
export function WhiteBalanceRow({
  node,
  dispatch,
  state,
  frame,
}: {
  node: NodeCard;
  dispatch: (c: Command) => void;
  state?: State;
  frame?: string | null;
}) {
  return (
    <div data-testid="wb-row" style={{ display: "flex", gap: 6, marginTop: 5 }}>
      <button
        className="chip"
        data-testid="wb-auto"
        data-hint="Balance the whole frame toward neutral, the gray-world way"
        onClick={() => {
          if (!frame) {
            flashStatus("Auto white balance needs a frame on screen");
            return;
          }
          void averageColor(frame).then((avg) => {
            if (!avg) {
              flashStatus("Auto white balance could not read the frame");
              return;
            }
            // The frame on screen already carries the current dials, so
            // the solve composes with them rather than starting from
            // neutral.
            const wb = neutralize(avg, {
              temperature: node.params.temperature ?? 6500,
              tint: node.params.tint ?? 0,
            });
            if (!wb) {
              flashStatus("Auto white balance found nothing to balance");
              return;
            }
            logDebug(() => `Auto white balance: ${wb.temperature} K, tint ${wb.tint > 0 ? "+" : ""}${wb.tint}`);
            dispatch({ type: "set_params", id: node.id, values: wb });
          });
        }}
      >
        Auto
      </button>
      <button
        className="chip"
        data-testid="wb-as-shot"
        data-hint="Back to the camera's own white balance"
        onClick={() => dispatch({ type: "set_params", id: node.id, values: { ...AS_SHOT } })}
      >
        As Shot
      </button>
      {/* The picture, not the word: it is the same gesture the Curves and
          Tone Equalizer pickers offer, so it wears the same eyedropper.
          The chip keeps its own padding, so it stays the height of Auto
          and As Shot beside it. */}
      {state && (
        <button
          className="chip"
          data-testid="wb-pick"
          data-active={state.wbPick === node.id || undefined}
          aria-pressed={state.wbPick === node.id}
          aria-label="Eyedropper"
          data-hint="Click something gray in the photograph and the white balance follows it"
          style={{ display: "flex", alignItems: "center" }}
          onClick={() => dispatch({ type: "arm_wb_pick", id: state.wbPick === node.id ? null : node.id })}
        >
          <EyedropperIcon size={12} />
        </button>
      )}
    </div>
  );
}
