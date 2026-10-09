// The status row every pop-out window carries: the hint under the
// pointer, the way the main window's status bar prints it. A pop-out
// has no viewer and no status bar of its own, so without this row the
// hints on its controls explain themselves to nobody
// ("the status line doesn't print help info when using a pop-out
// window"). One component, so every window speaks the same hint
// language.
import { useHint } from "./hints";

export function PopoutStatusRow({ testid }: { testid: string }) {
  const hint = useHint();
  return (
    <div
      data-testid={testid}
      className="ui-zoom tnum"
      role="status"
      aria-live="polite"
      style={{
        flex: "none", height: 22, display: "flex", alignItems: "center", padding: "0 12px",
        borderTop: "1px solid var(--line-1)", background: "var(--bg-panel)",
        fontSize: 10, color: "var(--text-dim)", letterSpacing: ".02em",
        overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
      }}
    >
      {hint ?? ""}
    </div>
  );
}
