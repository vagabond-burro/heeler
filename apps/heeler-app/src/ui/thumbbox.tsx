// The box a thumbnail lives in, in the filmstrip, the list and the
// grid: it asks for its picture when it comes into view and withdraws
// the ask when it leaves before the decode started (src/thumbs.ts).
// Without an IntersectionObserver (the test runner's DOM) it asks at
// once, which is what a screen that shows everything would do.

import React, { useEffect, useRef } from "react";
import { PHOTO } from "../data";
import { unwantThumb, wantThumb } from "../thumbs";

/** How far past the edge of the screen a cell counts as coming: about a
 * row of the grid or a few cells of the strip, so a scroll lands on
 * pictures that are already there. */
const LOOKAHEAD = "320px";

export function ThumbBox({
  id,
  src,
  children,
  pending,
  style,
}: {
  id: string;
  src: string;
  /** the picture, drawn when `src` is set */
  children: React.ReactNode;
  /** what stands in until then */
  pending: React.ReactNode;
  style?: React.CSSProperties;
}) {
  const box = useRef<HTMLDivElement>(null);
  // The browser build starts every entry on the demo picture; that is
  // a stand-in, not an answer, so the box still asks (and the mock
  // thumbnails the tests plant can land).
  const has = src !== "" && src !== PHOTO;
  useEffect(() => {
    if (has) return;
    const el = box.current;
    if (!el || typeof IntersectionObserver === "undefined") {
      wantThumb(id);
      return () => unwantThumb(id);
    }
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (e.isIntersecting) wantThumb(id);
          else unwantThumb(id);
        }
      },
      { rootMargin: LOOKAHEAD },
    );
    io.observe(el);
    return () => {
      io.disconnect();
      unwantThumb(id);
    };
  }, [id, has]);
  return (
    <div ref={box} style={{ width: "100%", height: "100%", ...style }}>
      {has ? children : pending}
    </div>
  );
}
