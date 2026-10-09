// The one face every model-download consent card wears. Five surfaces
// drew their own (Depth, the Polish matte, Fill, and two smart
// selection cards) and each invented its own type sizes, from a 20px
// body down to a 10px one. "Standardize the dialog for
// model downloads... find the one with the largest font size and use
// it as the base for all", which makes the Depth tools' card the
// template. Placement stays the caller's: each surface knows where it
// can afford to stand, so the card takes a `place` style and
// standardizes everything inside the border.
import type { CSSProperties } from "react";
import type { SmartModelStatus } from "../bridge";

export function ModelConsentCard({
  title,
  model,
  testid,
  downloading,
  onDownload,
  place,
  secondary,
}: {
  /** the all-caps headline, e.g. "THE DEPTH TOOLS NEED THEIR MODEL" */
  title: string;
  model: SmartModelStatus;
  /** testid prefix: the card is `${testid}-consent`, the button
   * `${testid}-download`, so every surface keeps its existing ids */
  testid: string;
  downloading: boolean;
  onDownload: () => void;
  /** position, offsets and z-index only; the caller owns where the
   * card stands (fixed above the status bar, centered in a tool's
   * viewport) and nothing else */
  place: CSSProperties;
  /** an optional second button, e.g. smart selection's NOT NOW */
  secondary?: { label: string; testid: string; onClick: () => void };
}) {
  return (
    <div
      data-testid={`${testid}-consent`}
      // Cards that stand over a click surface must not let a stray
      // press fall through into the tool beneath them.
      onMouseDown={(e) => e.stopPropagation()}
      style={{
        background: "var(--bg-panel)",
        border: "1px solid var(--line-4)",
        padding: "14px 18px",
        maxWidth: 560,
        fontSize: 20,
        color: "var(--text-body)",
        lineHeight: 1.5,
        ...place,
      }}
    >
      <div style={{ letterSpacing: ".08em", marginBottom: 3 }}>{title}</div>
      <div style={{ color: "var(--text-faint)" }}>
        {model.label} · {Math.round(model.bytes / 1e6)} MB · {model.license}
      </div>
      <div style={{ color: "var(--text-faint)", overflowWrap: "anywhere", marginTop: 2 }}>
        From {model.url}
      </div>
      <div style={{ display: "flex", gap: 8, marginTop: 10 }}>
        <button
          className="chip"
          data-testid={`${testid}-download`}
          disabled={downloading}
          style={{ fontSize: 15, padding: "4px 16px" }}
          onClick={onDownload}
        >
          {downloading ? "DOWNLOADING…" : "DOWNLOAD"}
        </button>
        {secondary && (
          <button
            className="chip"
            data-testid={secondary.testid}
            style={{ fontSize: 15, padding: "4px 16px" }}
            onClick={secondary.onClick}
          >
            {secondary.label}
          </button>
        )}
      </div>
    </div>
  );
}
