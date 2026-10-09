// Cursors that CSS does not have a name for.
//
// The named set covers move and the four resize directions, which is
// most of what a gizmo needs. It has nothing for "you are about to
// rotate this" or "you are about to change the falloff", and those are
// exactly the two a radial mask most needs to say, because they are the
// two you cannot guess from the shape under the pointer.
//
// Drawn as data URIs rather than shipped as files: they are a dozen
// lines of SVG each, and a cursor that lives next to the code deciding
// when to use it is easier to keep honest.

/** Wraps SVG markup as a cursor, with its hotspot at the middle. */
function cursor(svg: string, size = 26): string {
  const encoded = encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 24 24">${svg}</svg>`,
  );
  const mid = Math.round(size / 2);
  // A named fallback after the URL, so a browser that refuses the image
  // still says something useful rather than showing an arrow.
  return `url("data:image/svg+xml,${encoded}") ${mid} ${mid}, auto`;
}

/** Dark under light, the same trick the overlays use, so the cursor
 * stays visible over a white sky and a black shadow alike. */
const OUTLINED = 'fill="none" stroke="#000" stroke-opacity=".8" stroke-width="4.5" stroke-linecap="round" stroke-linejoin="round"';
const INNER = 'fill="none" stroke="#fff" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"';

/** A three-quarter circle with an arrowhead on the end: the thing you
 * are about to do is turn it. It was a half arc with a squared-off
 * head; the owner, meeting it on the split handles: "A better cursor
 * is those that are 3/4 circle with an arrow on the end. That reads
 * 'rotate'". The arc runs clockwise from the top and the head points
 * the way the motion continues.*/
export const ROTATE_CURSOR = cursor(
  `<g>
    <path d="M12 5a7 7 0 1 1-7 7" ${OUTLINED}/>
    <path d="M2.8 14.4L5 12l2.3 2.4" ${OUTLINED}/>
    <path d="M12 5a7 7 0 1 1-7 7" ${INNER}/>
    <path d="M2.8 14.4L5 12l2.3 2.4" ${INNER}/>
  </g>`,
);

/** Two arrows either side of a soft band: the edge is going to get
 * softer or harder. */
export const FEATHER_CURSOR = cursor(
  `<g>
    <path d="M12 4v6M12 14v6M9.5 6.5L12 4l2.5 2.5M9.5 17.5L12 20l2.5-2.5" ${OUTLINED}/>
    <path d="M5 12h14" ${OUTLINED}/>
    <path d="M12 4v6M12 14v6M9.5 6.5L12 4l2.5 2.5M9.5 17.5L12 20l2.5-2.5" ${INNER}/>
    <path d="M5 12h14" stroke="#fff" stroke-width="1.8" stroke-dasharray="2.5 2" fill="none"/>
  </g>`,
);

/** A ring around a dot: the thing under the pointer is a curve POINT,
 * and it will move where the hand goes. One cursor for Curves,
 * Relight and Recolor alike ("All 3 tools should use the
 * same cursor style for points and tangent handles").*/
export const CURVE_POINT_CURSOR = cursor(
  `<g>
    <circle cx="12" cy="12" r="5.5" ${OUTLINED}/>
    <circle cx="12" cy="12" r="5.5" ${INNER}/>
    <circle cx="12" cy="12" r="1.6" fill="#fff" stroke="#000" stroke-opacity=".8" stroke-width="1"/>
  </g>`,
);

/** A small four-way arrow in narrow lines (the owner's third and
 * final call, after two bigger designs read as "too big and
 * distracting"): the thing under the pointer is a TANGENT handle,
 * free to move any way, and the cursor whispers it instead of
 * shouting.*/
const TAN_OUT = 'fill="none" stroke="#000" stroke-opacity=".75" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"';
const TAN_IN = 'fill="none" stroke="#fff" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"';
export const CURVE_TANGENT_CURSOR = cursor(
  `<g>
    <path d="M12 3v18M3 12h18" ${TAN_OUT}/>
    <path d="M9.5 5.5L12 3l2.5 2.5M9.5 18.5L12 21l2.5-2.5M5.5 9.5L3 12l2.5 2.5M18.5 9.5L21 12l-2.5 2.5" ${TAN_OUT}/>
    <path d="M12 3v18M3 12h18" ${TAN_IN}/>
    <path d="M9.5 5.5L12 3l2.5 2.5M9.5 18.5L12 21l2.5-2.5M5.5 9.5L3 12l2.5 2.5M18.5 9.5L21 12l-2.5 2.5" ${TAN_IN}/>
  </g>`,
  20,
);

/** The nearest named resize cursor to a direction on screen.
 *
 * A named cursor cannot be rotated, so a handle on a shape the user has
 * turned has to pick whichever of the four arrows points closest to the
 * right way. Four is enough: the arrows are 45 degrees apart, so the
 * worst case is off by 22 and still reads as the correct axis.
 *
 * `deg` is measured clockwise from the positive x axis, in screen space
 * where y grows downwards.
 */
export function resizeCursorFor(deg: number): string {
  // Fold to a half turn: an arrow pointing left says the same as one
  // pointing right.
  const a = ((deg % 180) + 180) % 180;
  if (a < 22.5 || a >= 157.5) return "ew-resize";
  if (a < 67.5) return "nwse-resize";
  if (a < 112.5) return "ns-resize";
  return "nesw-resize";
}

/** The eyedropper: a cursor that looks like the tool in hand. Two-tone
 * (black casing, white core) so it reads on any photograph; the
 * hotspot sits on the dropper's tip. The add / remove variants wear a
 * small badge so the held modifier answers "what will this click do"
 * before the click. Every picker that reads the photograph wears it
 * (2026-09-07: the classic picker, not the crosshair, on every one).*/
export function dropperCursor(mode: "center" | "add" | "remove"): string {
  const glyph = "M11 7l6 6M4 20l1-4 9.5-9.5a2.1 2.1 0 013 3L8 19l-4 1zM14.5 3.5l2-2 6 6-2 2";
  const badge =
    mode === "add"
      ? "<circle cx='18' cy='18' r='5.2' fill='black'/><path d='M15.4 18h5.2M18 15.4v5.2' stroke='white' stroke-width='1.6'/>"
      : mode === "remove"
        ? "<circle cx='18' cy='18' r='5.2' fill='black'/><path d='M15.4 18h5.2' stroke='white' stroke-width='1.6'/>"
        : "";
  const svg =
    `<svg xmlns='http://www.w3.org/2000/svg' width='22' height='22' viewBox='0 0 24 24'>` +
    `<path d='${glyph}' fill='none' stroke='black' stroke-width='3.4' stroke-linejoin='round' stroke-linecap='round'/>` +
    `<path d='${glyph}' fill='none' stroke='white' stroke-width='1.5' stroke-linejoin='round' stroke-linecap='round'/>` +
    badge +
    `</svg>`;
  return `url("data:image/svg+xml,${encodeURIComponent(svg)}") 3 20, crosshair`;
}

/** The plain eyedropper, for every picker with no modifier to badge. */
export const PICK_CURSOR = dropperCursor("center");
