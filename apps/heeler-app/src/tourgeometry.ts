// Where a tour's stop is on screen, measured from layout offsets rather
// than client rects. The panels sit inside CSS zoom (.ui-zoom, and the
// graph's own zoom layer), and in the native WKWebView
// getBoundingClientRect and scrollIntoView were not reliable inside it
// (the thumbnail strip: measured from offsetTop against the scroller's
// scrollTop instead). So the rectangle is built up the tree from
// offsetLeft and offsetTop, each scaled by its element's effective
// zoom, less every ancestor's scroll, through every ancestor's 2D
// transform (the graph's pan, the Finish toolbar's centering).

/** One element on the way from the target up, as the math needs it.
 * `x` and `y` are this element's border box relative to its parent's,
 * in screen pixels (layout, before scroll and transforms); `scrollX`
 * and `scrollY` are its own scroll, in screen pixels; `matrix` its 2D
 * transform (a, b, c, d, e, f, translation already in screen pixels)
 * about `origin` (screen pixels, from its border box's corner). The
 * last frame is positioned against the viewport. */
export interface Frame {
  x: number;
  y: number;
  scrollX: number;
  scrollY: number;
  matrix: [number, number, number, number, number, number] | null;
  origin: [number, number];
}

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

type Point = [number, number];

function apply(m: Frame["matrix"], o: Frame["origin"], p: Point): Point {
  if (!m) return p;
  const [a, b, c, d, e, f] = m;
  const x = p[0] - o[0];
  const y = p[1] - o[1];
  return [o[0] + a * x + c * y + e, o[1] + b * x + d * y + f];
}

/** The target's box on screen: its corners carried up through every
 * frame (frames[0] is the target itself), then the bounding box of the
 * four. `w` and `h` are the target's size in screen pixels. */
export function rectFromFrames(frames: Frame[], w: number, h: number): Rect {
  let pts: Point[] = [
    [0, 0],
    [w, 0],
    [0, h],
    [w, h],
  ];
  for (let i = 0; i < frames.length; i++) {
    const f = frames[i];
    // Its own transform, in its own box.
    pts = pts.map((p) => apply(f.matrix, f.origin, p));
    // Into the parent's box, less the parent's scroll.
    const parent = frames[i + 1];
    pts = pts.map(([x, y]) => [x + f.x - (parent?.scrollX ?? 0), y + f.y - (parent?.scrollY ?? 0)]);
  }
  const xs = pts.map((p) => p[0]);
  const ys = pts.map((p) => p[1]);
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  return { x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y };
}

/** How the DOM is read, so tests can hand in elements with offsets and
 * styles of their own (jsdom lays nothing out). */
export interface Reader {
  style(el: Element): { zoom: string; transform: string; transformOrigin: string; position: string };
}

const domReader: Reader = {
  style: (el) => getComputedStyle(el),
};

/** Its own zoom times every ancestor's. */
export function effectiveZoom(el: Element | null, read: Reader = domReader): number {
  let z = 1;
  for (let e = el; e; e = e.parentElement) {
    const v = parseFloat(read.style(e).zoom);
    if (Number.isFinite(v) && v > 0) z *= v;
  }
  return z;
}

function matrixOf(transform: string): Frame["matrix"] {
  if (!transform || transform === "none") return null;
  const m = /^matrix\(([^)]+)\)$/.exec(transform.trim());
  if (!m) return null;
  const v = m[1].split(",").map((n) => parseFloat(n));
  return v.length === 6 && v.every(Number.isFinite) ? (v as Frame["matrix"]) : null;
}

/** Where an element's border box sits against its offsetParent chain's
 * root, in screen pixels: layout only, no scroll, no transform. Each
 * offset is in its own element's zoomed units, so each is scaled by
 * that element's effective zoom. */
function layoutOrigin(el: HTMLElement, read: Reader): Point {
  let x = 0;
  let y = 0;
  for (let e: HTMLElement | null = el; e; ) {
    const z = effectiveZoom(e, read);
    x += e.offsetLeft * z;
    y += e.offsetTop * z;
    const p = e.offsetParent as HTMLElement | null;
    if (p) {
      const pz = effectiveZoom(p, read);
      x += (p.clientLeft || 0) * pz;
      y += (p.clientTop || 0) * pz;
    }
    e = p;
  }
  return [x, y];
}

/** The frames from an element up to the viewport. A fixed element ends
 * the chain: it is placed against the viewport. */
export function framesOf(el: HTMLElement, read: Reader = domReader): Frame[] {
  const frames: Frame[] = [];
  let e: HTMLElement | null = el;
  while (e) {
    const style = read.style(e);
    const z = effectiveZoom(e, read);
    const parent: HTMLElement | null = style.position === "fixed" ? null : e.parentElement;
    const mine = layoutOrigin(e, read);
    const theirs = parent ? layoutOrigin(parent, read) : [0, 0];
    const [ox, oy] = (style.transformOrigin || "0 0").split(" ").map((n) => parseFloat(n) || 0);
    const m = matrixOf(style.transform);
    frames.push({
      x: mine[0] - theirs[0],
      y: mine[1] - theirs[1],
      scrollX: (e.scrollLeft || 0) * z,
      scrollY: (e.scrollTop || 0) * z,
      matrix: m ? [m[0], m[1], m[2], m[3], m[4] * z, m[5] * z] : null,
      origin: [ox * z, oy * z],
    });
    if (!parent || parent === document.documentElement) break;
    e = parent;
  }
  return frames;
}

/** The element's box on screen, from offsets. */
export function measure(el: HTMLElement, read: Reader = domReader): Rect {
  const z = effectiveZoom(el, read);
  return rectFromFrames(framesOf(el, read), el.offsetWidth * z, el.offsetHeight * z);
}

/** The nearest ancestor that scrolls, or null. */
function scroller(el: HTMLElement): HTMLElement | null {
  for (let e = el.parentElement; e && e !== document.body; e = e.parentElement) {
    if (e.scrollHeight > e.clientHeight + 1) {
      const o = getComputedStyle(e).overflowY;
      if (o === "auto" || o === "scroll") return e;
    }
  }
  return null;
}

/** Where a scroller should scroll so a stop sits roughly in its middle,
 * or null to leave it. All in the scroller's own units: `top` and
 * `height` are the stop's place in the scrolled content, `scrollTop`,
 * `clientHeight` and `scrollHeight` the scroller's. Left alone while
 * the stop is wholly in the middle three fifths; moved when any of it
 * is in the top or bottom fifth or off screen (2026-09-28: a Treatment
 * stop at the bottom of the Adjustments panel put the card almost off
 * the window). Not exact: clamped to what the content can scroll.*/
export function scrollTargetFor(m: { top: number; height: number; scrollTop: number; clientHeight: number; scrollHeight: number }): number | null {
  const fifth = m.clientHeight / 5;
  const from = m.top - m.scrollTop;
  const to = from + m.height;
  if (from >= fifth && to <= m.clientHeight - fifth) return null;
  const max = Math.max(0, m.scrollHeight - m.clientHeight);
  const want = Math.round(m.top + m.height / 2 - m.clientHeight / 2);
  const next = Math.min(max, Math.max(0, want));
  return Math.abs(next - m.scrollTop) < 1 ? null : next;
}

/** Scrolls the element's scroller so the element sits near its middle,
 * measuring its place from offsets within the scroller (both in the
 * scroller's own zoom) against scrollTop: no scrollIntoView and no
 * client rects, which WKWebView misreports inside .ui-zoom. View
 * state only.*/
export function revealInScroller(el: HTMLElement, read: Reader = domReader): void {
  const box = scroller(el);
  if (!box) return;
  const zEl = effectiveZoom(el, read);
  const zBox = effectiveZoom(box, read);
  const top = (layoutOrigin(el, read)[1] - layoutOrigin(box, read)[1]) / zBox - (box.clientTop || 0);
  const height = (el.offsetHeight * zEl) / zBox;
  const next = scrollTargetFor({ top, height, scrollTop: box.scrollTop, clientHeight: box.clientHeight, scrollHeight: box.scrollHeight });
  if (next !== null) box.scrollTop = next;
}

/** Where the tour's card goes: beside the holes where it fits, else on
 * the other side, below or above, and always inside the window with a
 * margin, so its NEXT, BACK and STOP row can never leave the screen.
 *
 * `avoid` are areas the card should leave in view as well: the whole
 * node card that owns each spotlighted port, both nodes of a wire
 * (2026-09-29: the card sat over the Luminance Mask whose input port it
 * pointed at, "making it hard to see"). The places tried are around the
 * holes and the nodes together, around the holes alone, around each
 * hole and node, then the window's corners and edges. The first that
 * covers neither a hole nor a node wins; else the one that covers no
 * hole and the least of the nodes; a hole is covered only when no place
 * clears every hole, and then the least of it.*/
export function placeCard(
  holes: Rect[],
  card: { w: number; h: number },
  view: { w: number; h: number },
  opts: { margin?: number; gap?: number; avoid?: Rect[] } = {},
): { left: number; top: number } {
  const margin = opts.margin ?? 8;
  const gap = opts.gap ?? 18;
  const avoid = holes.length > 0 ? (opts.avoid ?? []) : [];
  const maxLeft = Math.max(margin, view.w - margin - card.w);
  const maxTop = Math.max(margin, view.h - margin - card.h);
  const clamp = (left: number, top: number) => ({
    left: Math.min(maxLeft, Math.max(margin, left)),
    top: Math.min(maxTop, Math.max(margin, top)),
  });
  if (holes.length === 0) return clamp((view.w - card.w) / 2, view.h / 3);
  const unionOf = (rs: Rect[]) =>
    rs.reduce((a, r) => {
      const x = Math.min(a.x, r.x);
      const y = Math.min(a.y, r.y);
      return { x, y, w: Math.max(a.x + a.w, r.x + r.w) - x, h: Math.max(a.y + a.h, r.y + r.h) - y };
    });
  // Around one box: right, left, below, above. Beside it the card
  // starts level with the box's top and slides up to stay inside;
  // below or above, it lines up with the box's left edge.
  const around = (b: Rect) => [
    { left: b.x + b.w + gap, top: b.y, fits: b.x + b.w + gap + card.w <= view.w - margin },
    { left: b.x - gap - card.w, top: b.y, fits: b.x - gap - card.w >= margin },
    { left: b.x, top: b.y + b.h + gap, fits: b.y + b.h + gap + card.h <= view.h - margin },
    { left: b.x, top: b.y - gap - card.h, fits: b.y - gap - card.h >= margin },
  ];
  const all = [...holes, ...avoid];
  const candidates = [
    ...around(unionOf(all)),
    ...(avoid.length > 0 ? around(unionOf(holes)) : []),
    ...(all.length > 1 ? all.flatMap(around) : []),
  ]
    .filter((c) => c.fits)
    .map((c) => clamp(c.left, c.top));
  const midX = (view.w - card.w) / 2;
  const midY = (view.h - card.h) / 2;
  candidates.push(
    clamp(view.w - margin - card.w, view.h - margin - card.h),
    clamp(margin, view.h - margin - card.h),
    clamp(view.w - margin - card.w, margin),
    clamp(margin, margin),
    clamp(midX, view.h - margin - card.h),
    clamp(midX, margin),
    clamp(margin, midY),
    clamp(view.w - margin - card.w, midY),
  );
  const areaOver = (p: { left: number; top: number }, rs: Rect[]) => {
    let area = 0;
    for (const h of rs) {
      const w = Math.min(p.left + card.w, h.x + h.w) - Math.max(p.left, h.x);
      const hh = Math.min(p.top + card.h, h.y + h.h) - Math.max(p.top, h.y);
      if (w > 0 && hh > 0) area += w * hh;
    }
    return area;
  };
  let best = candidates[0];
  let bestHole = Infinity;
  let bestNode = Infinity;
  for (const c of candidates) {
    const hole = areaOver(c, holes);
    const node = areaOver(c, avoid);
    if (hole === 0 && node === 0) return c;
    if (hole < bestHole || (hole === bestHole && node < bestNode)) {
      best = c;
      bestHole = hole;
      bestNode = node;
    }
  }
  return best;
}
