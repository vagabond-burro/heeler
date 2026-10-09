// Glyphs for the selection methods and the four things a region can do.
//
// On the Finish toolbar: "the user should be able to change
// selection types by clicking and hold the selection tool... To save
// space, replace the text labels with icon equivalents."
//
// Two rules held throughout. The method glyphs say how you DRAW: a
// dashed box, an oval, a pen nib, a loop, a magnet. The op glyphs all
// say the same sentence in the same grammar, two overlapping squares
// with the kept part solid, so the four read as one family and the
// difference between them is the only thing that moves. Drawn as
// outlines at the same 16-unit box and 1.4 stroke as the rest of the
// toolbar, so nothing here looks pasted in from another set.

import React from "react";

const METHOD: Record<string, React.ReactNode> = {
  rect: <rect x="2.5" y="3.5" width="11" height="9" strokeDasharray="2.4 1.8" />,
  ellipse: <ellipse cx="8" cy="8" rx="5.5" ry="4.5" strokeDasharray="2.4 1.8" />,
  // A nib with its two handles out, which is the one thing this tool
  // does that no other selection method can.
  pen: (
    <>
      <path d="M3 12.5c0-4 2.2-7 5-7s5 3 5 7" />
      <circle cx="8" cy="5.5" r="1.4" fill="currentColor" stroke="none" />
      <path d="M4.4 8.2h7.2" strokeWidth="0.9" opacity="0.75" />
    </>
  ),
  // A hand-drawn loop that does not quite close, because that is what a
  // freehand loop looks like before the app closes it for you.
  freehand: <path d="M11.5 11.8c-3.6 2.2-8.4.6-9-3C1.8 4.5 6.6 1.6 10.3 3.2c2.6 1.1 3.6 4 2.2 5.6-1.2 1.4-3.6.9-3.9-.8" />,
  magnetic: (
    <>
      <path d="M4 12.5V7a4 4 0 0 1 8 0v5.5" />
      <path d="M4 10.2h3M9 10.2h3" />
    </>
  ),
  // The color brush: a brush with a dotted trail, since what it leaves
  // behind is a selection rather than paint.
  paint: (
    <>
      <path d="M10 2.6l3.4 3.4-5.6 5.6-3.4-3.4z" />
      <path d="M4.4 8.2L2.5 13.5l5.3-1.9" strokeDasharray="1.8 1.4" />
    </>
  ),
  // The wand, with the sparkle that says "and everything like it".
  wand: (
    <>
      <path d="M3 13l7-7" />
      <path d="M11.5 2.5v3M13 4h-3M12.5 7.5l1.5 1.5M9.5 9.5l-1 1" strokeWidth="1.1" />
    </>
  ),
  // Corner brackets around a blob: the frame finds the thing inside it.
  region: (
    <>
      <path d="M2.5 5V2.5H5M11 2.5h2.5V5M13.5 11v2.5H11M5 13.5H2.5V11" />
      <path d="M6 9.5c-.8-1.6.3-3.4 2-3.4s2.9 1.7 2.1 3.3c-.6 1.2-2 1.6-3 .9" />
    </>
  ),
};

/** Two squares, offset. `keep` says which parts are drawn solid. */
function OpGlyph({ keep }: { keep: "a" | "both" | "a-minus-b" | "overlap" }) {
  const A = { x: 2.2, y: 2.2, w: 8, h: 8 };
  const B = { x: 5.8, y: 5.8, w: 8, h: 8 };
  const solid = { fill: "currentColor", stroke: "none", opacity: 0.85 };
  return (
    <>
      {keep === "a" && <rect x={A.x} y={A.y} width={A.w} height={A.h} {...solid} />}
      {keep === "both" && (
        <>
          <rect x={A.x} y={A.y} width={A.w} height={A.h} {...solid} />
          <rect x={B.x} y={B.y} width={B.w} height={B.h} {...solid} />
        </>
      )}
      {keep === "a-minus-b" && (
        // A with B bitten out of it: drawn as the L, so what is gone is
        // gone rather than merely paler.
        <path
          d={`M${A.x} ${A.y}h${A.w}v${B.y - A.y}h${A.x + A.w - B.x}v${A.y + A.h - B.y}h${-A.w}z`}
          {...solid}
        />
      )}
      {keep === "overlap" && (
        <rect x={B.x} y={B.y} width={A.x + A.w - B.x} height={A.y + A.h - B.y} {...solid} />
      )}
      {/* The outlines always: they are the frame the fill is read
          against, and without them "subtract" and "new" look alike. */}
      <rect x={A.x} y={A.y} width={A.w} height={A.h} />
      {keep !== "a" && <rect x={B.x} y={B.y} width={B.w} height={B.h} />}
    </>
  );
}

const OP: Record<string, React.ReactNode> = {
  replace: <OpGlyph keep="a" />,
  add: <OpGlyph keep="both" />,
  subtract: <OpGlyph keep="a-minus-b" />,
  intersect: <OpGlyph keep="overlap" />,
};

function Icon({ children, size = 13 }: { children: React.ReactNode; size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      // Pinned in CSS as well as attributes: a flex parent under CSS zoom can
      // stretch an svg that only states its size in attributes, and WebKit is
      // the engine that does it. "the mode icon for intersect is
      // stretched to the width of the view."
      style={{ width: size, height: size, flex: "none" }}
    >
      {children}
    </svg>
  );
}

/** The glyph for a selection method, or the plain marquee box if the id
 * is one this does not know. */
export function MethodIcon({ id, size }: { id: string; size?: number }) {
  return <Icon size={size}>{METHOD[id] ?? METHOD.rect}</Icon>;
}

/** The glyph for what a region does to the selection it lands in. */
export function OpIcon({ id, size }: { id: string; size?: number }) {
  return <Icon size={size}>{OP[id] ?? OP.replace}</Icon>;
}
