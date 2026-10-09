// The draggable seam between two panels.
//
// Lived inside app.tsx until the right panel learned to split, which put a
// second caller in ui/. Importing app.tsx from a panel it renders would be
// a cycle, so it moved here rather than being written twice.

import { useRef } from "react";
import { useDragFollow } from "./dragfollow";

/** A resize handle. `vertical` means it separates left from right and so
 * is dragged sideways; without it, top from bottom. */
export function PanelDivider({
  vertical,
  testid,
  onDelta,
}: {
  vertical: boolean;
  testid: string;
  onDelta: (d: number) => void;
}) {
  // The window carries the drag to its release; a drag lost to a blur or
  // an unmount stops there (the 26.4.3 full review's R6), where it kept
  // resizing panels as the pointer moved, button up.
  const last = useRef(0);
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
      style={{
        flex: "none",
        width: vertical ? 5 : undefined,
        height: vertical ? undefined : 5,
        // Pulled back over its neighbors so the grab area is wider than
        // the line it draws.
        margin: vertical ? "0 -2px" : "-2px 0",
        cursor: vertical ? "col-resize" : "row-resize",
        zIndex: 5,
      }}
      onMouseDown={(e) => {
        e.preventDefault();
        last.current = vertical ? e.clientX : e.clientY;
        followed.start();
      }}
    />
  );
}
