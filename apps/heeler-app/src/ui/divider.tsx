// The draggable seam between two panels.
//
// Lived inside app.tsx until the right panel learned to split, which put a
// second caller in ui/. Importing app.tsx from a panel it renders would be
// a cycle, so it moved here rather than being written twice.

import { useRef, useState } from "react";
import { useDragFollow } from "./dragfollow";

/** A resize handle. `vertical` means it separates left from right and so
 * is dragged sideways; without it, top from bottom. */
export function PanelDivider({
  vertical,
  testid,
  onDelta,
  grip = false,
}: {
  vertical: boolean;
  testid: string;
  onDelta: (d: number) => void;
  /** a seam above a docked pane (Selection, Inspect): a bar of its own
   * with a grip in the middle, so it reads as something to drag rather
   * than as one more line between sections (2026-10-18: "needs to be
   * more pronounced with an obvious handle for grabbing and dragging") */
  grip?: boolean;
}) {
  // The window carries the drag to its release; a drag lost to a blur or
  // an unmount stops there (the 26.4.3 full review's R6), where it kept
  // resizing panels as the pointer moved, button up.
  const last = useRef(0);
  const [hot, setHot] = useState(false);
  const followed = useDragFollow<MouseEvent>({
    move: (ev) => {
      const cur = vertical ? ev.clientX : ev.clientY;
      if (cur !== last.current) onDelta(cur - last.current);
      last.current = cur;
    },
    up: () => {},
    lost: () => {},
  });
  return (
    <div
      data-testid={testid}
      role="separator"
      aria-orientation={vertical ? "vertical" : "horizontal"}
      data-grip={grip || undefined}
      style={
        grip && !vertical
          ? {
              flex: "none",
              height: 9,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              background: "var(--bg-panel-head)",
              borderTop: "1px solid var(--line-4)",
              borderBottom: "1px solid var(--line-hard)",
              cursor: "row-resize",
              zIndex: 5,
            }
          : {
              flex: "none",
              width: vertical ? 5 : undefined,
              height: vertical ? undefined : 5,
              // Pulled back over its neighbors so the grab area is wider than
              // the line it draws.
              margin: vertical ? "0 -2px" : "-2px 0",
              cursor: vertical ? "col-resize" : "row-resize",
              zIndex: 5,
            }
      }
      onMouseEnter={grip ? () => setHot(true) : undefined}
      onMouseLeave={grip ? () => setHot(false) : undefined}
      onMouseDown={(e) => {
        e.preventDefault();
        last.current = vertical ? e.clientX : e.clientY;
        followed.start();
      }}
    >
      {grip && !vertical && (
        <span
          aria-hidden="true"
          data-testid={`${testid}-grip`}
          style={{ width: 28, height: 3, borderRadius: 2, background: hot ? "var(--text-dim)" : "var(--text-ghost)" }}
        />
      )}
    </div>
  );
}
