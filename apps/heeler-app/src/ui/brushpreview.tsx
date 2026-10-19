// The brush, drawn as itself.
//
// "it should preview the actual brush like [the layer
// editors] do. Especially for the textured brushes. Otherwise we
// are just guessing."
//
// So the pixels come from the engine, through the same sweep the paint
// goes through (brush_cover.rs), rather than being approximated here. A preview
// reimplemented in TypeScript would agree with the engine right up until
// one of them changed, and agreeing is the entire job.

import { useCallback } from "react";
import { paintCoverage, useTipPreview } from "./brushpreviewparts";

/** The dab, at a fixed size, for the Brush panel. The layer editors
 * both put one next to the picker, and it is the fastest way to tell
 * splatter from dry media without painting a test stroke first. */
export function BrushPreview({
  tip,
  hardness,
  textureScale,
  textureDepth,
  textureAngle = 0,
  flow = 1,
  px = 46,
  tint,
}: {
  tip: string;
  hardness: number;
  textureScale: number;
  textureDepth: number;
  textureAngle?: number;
  flow?: number;
  px?: number;
  /** The color this brush lays down where it is going to be used. The
   * panel swatch is the same dab as the cursor, so it has to agree with
   * it: red on a mask, where the brush paints coverage rather than a
   * color anyone chose. */
  tint?: [number, number, number];
}) {
  const { data, size, pending } = useTipPreview(tip, hardness, textureScale, textureDepth, 96, textureAngle);
  // Callback ref, not an effect on a ref: the canvas only exists once
  // the data has arrived, and an effect keyed on the data alone can run
  // before the canvas is in the tree and then never again. That is
  // exactly how the cursor mounted a blank canvas.
  const attach = useCallback(
    (el: HTMLCanvasElement | null) => paintCoverage(el, data, size, tint ?? [255, 255, 255], flow),
    [data, size, flow, tint],
  );
  return (
    <div
      data-testid="brush-preview"
      data-tip={tip}
      // The tint as text, so a test can see what color the dab is
      // wearing without a canvas.
      data-tint={tint ? tint.join(",") : undefined}
      title={`${tip} brush`}
      style={{
        width: px,
        height: px,
        flex: "none",
        // A checker so a soft edge reads as transparency rather than as
        // a gray brush.
        background:
          "repeating-conic-gradient(#232120 0% 25%, #1a1918 0% 50%) 50% / 8px 8px",
        border: "1px solid var(--line-3)",
      }}
    >
      {data ? (
        <canvas ref={attach} style={{ width: "100%", height: "100%", display: "block" }} />
      ) : pending ? (
        // Waiting on the first answer. The checker behind this box already
        // reads as "nothing here yet", and claiming there is no engine
        // while one is being asked is worse than saying nothing at all.
        <div data-testid="brush-preview-pending" style={{ width: "100%", height: "100%" }} />
      ) : (
        // No engine (browser build): say so rather than showing an empty
        // box that looks like a brush painting nothing.
        <div
          data-testid="brush-preview-unavailable"
          style={{
            width: "100%",
            height: "100%",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            fontSize: 11,
            color: "var(--text-ghost)",
            textAlign: "center",
            lineHeight: 1.2,
          }}
        >
          no
          <br />
          engine
        </div>
      )}
    </div>
  );
}
