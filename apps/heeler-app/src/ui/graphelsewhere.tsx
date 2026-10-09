import type { Command } from "../state";
import { closeGraphWindow } from "../popout";

/** While the graph is out in its own window its pane collapses to this
 * bar along the bottom, giving the whole height to the viewer. The bar
 * IS the control: clicking it anywhere brings the graph back. */
export function GraphElsewhere({ dispatch }: { dispatch: (cmd: Command) => void }) {
  return (
    <button
      data-testid="graph-dock"
      data-hint="Bring the node graph back into this window"
      onClick={() => {
        void closeGraphWindow();
        dispatch({ type: "set_graph_popped_out", out: false });
      }}
      style={{
        all: "unset",
        boxSizing: "border-box",
        cursor: "pointer",
        flex: "none",
        height: 26,
        width: "100%",
        display: "flex",
        alignItems: "center",
        gap: 8,
        padding: "0 12px",
        background: "var(--bg-panel)",
        borderTop: "1px solid var(--line-hard)",
        fontSize: 9,
        letterSpacing: ".10em",
        color: "var(--text-ghost)",
      }}
    >
      <svg
        width="10"
        height="10"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2.4"
      >
        <path d="M6 15l6-6 6 6" />
      </svg>
      <span>GRAPH IS IN ITS OWN WINDOW</span>
      <span style={{ flex: 1 }} />
      <span style={{ color: "var(--accent)" }}>BRING IT BACK</span>
    </button>
  );
}

