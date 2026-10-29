// The one face every model-download consent card wears. Five surfaces
// drew their own (Depth, the Polish matte, Fill, and two smart
// selection cards) and each invented its own type sizes, from a 20px
// body down to a 10px one. "Standardize the dialog for
// model downloads... find the one with the largest font size and use
// it as the base for all", which makes the Depth tools' card the
// template. And one place for all of them: the middle of the window
// (2026-10-29: "make sure all consent prompts are centered in the
// screen"), where some stood above the status bar, some at the foot of
// the photograph, one in its top left corner and two inline in
// Preferences. The card is put on the page itself, not in its caller,
// so a turned or zoomed canvas, a scrolled panel or the Preferences
// dialog cannot carry it off center, and it stands over all of them.
import { createPortal } from "react-dom";
import type { CSSProperties } from "react";
import type { SmartModelStatus } from "../bridge";
import { useDownloadPercent } from "./modelconsentparts";

export function ModelConsentCard({
  title,
  model,
  testid,
  downloading,
  onDownload,
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
  /** an optional second button, e.g. smart selection's NOT NOW */
  secondary?: { label: string; testid: string; onClick: () => void };
}) {
  const percent = useDownloadPercent(model.id, downloading);
  const card = (
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
        ...CONSENT_PLACE,
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
          {downloading ? (percent === null ? "DOWNLOADING…" : `DOWNLOADING ${percent}%`) : "DOWNLOAD"}
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
      {downloading && percent !== null && (
        <div
          data-testid={`${testid}-progress`}
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={percent}
          style={{ height: 3, background: "var(--line-4)", marginTop: 10 }}
        >
          <div style={{ width: `${percent}%`, height: "100%", background: "var(--text-body)" }} />
        </div>
      )}
    </div>
  );
  return typeof document !== "undefined" && document.body ? createPortal(card, document.body) : card;
}

/** The middle of the window, over Preferences (80) and the menus, under
 * the progress sheets and the splash. Clear of the window's edges on a
 * narrow window. */
const CONSENT_PLACE: CSSProperties = {
  position: "fixed",
  left: "50%",
  top: "50%",
  transform: "translate(-50%, -50%)",
  zIndex: 300,
  width: "max-content",
  maxWidth: "min(560px, calc(100vw - 32px))",
  boxSizing: "border-box",
  boxShadow: "0 10px 32px rgba(0,0,0,.6)",
};
