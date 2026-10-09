// "Feather follows the picture": the selection's Feather guided by the
// photograph, so hair and fur keep their shape where the picture has an
// edge and a plain feather everywhere else. One component for the
// Selection Mask block under Layers, the Polish panel and the graph
// inspector, so the three seats cannot drift.

import React from "react";
import type { Command, NodeCard } from "../state";

type D = React.Dispatch<Command>;

export const FEATHER_FOLLOWS_LABEL = "Feather follows the picture";
export const FEATHER_FOLLOWS_HINT =
  "Soften the edge along the photograph's own edges: hair and fur keep their shape where the picture has an edge, a plain feather elsewhere";

export function FeatherFollowsToggle({ node, dispatch, testid = "mask-feather-guided" }: { node: NodeCard; dispatch: D; testid?: string }) {
  const on = (node.params.feather_guided ?? 0) !== 0;
  return (
    <div data-node={node.id} data-param="feather_guided" style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 4 }}>
      <div style={{ fontSize: 11, color: "var(--text-body)" }} data-hint={FEATHER_FOLLOWS_HINT}>
        {FEATHER_FOLLOWS_LABEL}
      </div>
      <div
        className="toggle"
        data-on={on}
        data-testid={testid}
        data-hint={FEATHER_FOLLOWS_HINT}
        role="switch"
        aria-checked={on}
        aria-label={FEATHER_FOLLOWS_LABEL}
        tabIndex={0}
        onKeyDown={(e) => {
          if (e.key === " " || e.key === "Enter") {
            e.preventDefault();
            e.stopPropagation();
            dispatch({ type: "set_param", id: node.id, param: "feather_guided", value: on ? 0 : 1 });
          }
        }}
        onClick={() => dispatch({ type: "set_param", id: node.id, param: "feather_guided", value: on ? 0 : 1 })}
      >
        <div className="dot" />
      </div>
    </div>
  );
}
