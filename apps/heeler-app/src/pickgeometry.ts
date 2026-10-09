import type { Pt } from "./quadmap";
import { meshFromParams, sourceOf, sourceOfField } from "./gridwarp";
import { parseShapes, shapesDisplacement } from "./shapewarp";

type Graph = {
  nodes: { id: string; type: string; enabled: boolean; params: Record<string, unknown> }[];
  connections: { from: string[]; to: string[] }[];
};

/** Undo the rendered image chain before reading original-file identifiers.
 * Display pan, zoom and view rotation have already been undone by norm(). */
export function sourcePoint(graph: Graph, size: Pt, point: Pt): Pt | null {
  return sourceMapOf(graph, size)(point);
}

/** sourcePoint's walk, built once for many points. */
export function sourceMapOf(graph: Graph, size: Pt): (point: Pt) => Pt | null {
  const chain: Graph["nodes"] = [];
  const seen = new Set<string>();
  let node = graph.nodes.find((n) => n.type === "heeler.output");
  while (node && !seen.has(node.id)) {
    seen.add(node.id);
    chain.unshift(node);
    // A blend's picture below arrives on "base" in an engine graph and
    // on "in" in the app's (a Finish layer's blend): either is the
    // chain. Reading "base" alone stopped the walk at the first Finish
    // layer, so with any Finish layer on the photograph a Smart click
    // and the eyedroppers skipped the crop and the warps (found by the
    // flips, 2026-10-01).
    const feed = graph.connections.find(
      (w) => w.to[0] === node!.id && (w.to[1] === "in" || (node!.type === "heeler.blend" && w.to[1] === "base")),
    );
    node = graph.nodes.find((n) => n.id === feed?.from[0]);
  }
  let [width, height] = size;
  const undo: ((p: Pt) => Pt)[] = [];
  const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
  for (const n of chain.filter((n) => n.enabled)) {
    const num = (k: string, d: number) => typeof n.params[k] === "number" ? n.params[k] as number : d;
    const str = (k: string) => typeof n.params[k] === "string" ? n.params[k] as string : "";
    const frameW = width, frameH = height;
    const warpEdges = (p: Pt): Pt => str("edges") === "transparent" ? p :
      [clamp(p[0], .5/frameW, 1-.5/frameW), clamp(p[1], .5/frameH, 1-.5/frameH)];
    if (n.type === "heeler.crop_rotate") {
      // Photo > Flip: the crop op flips the photograph before it turns
      // and cuts it, so undoing the crop lands on the flipped
      // photograph and one more mirror lands on the photograph itself.
      // Pushed first, so it runs after the crop's own undo.
      const fh = num("flip_h", 0) >= 0.5, fv = num("flip_v", 0) >= 0.5;
      if (fh || fv) undo.push(([u, v]) => [fh ? 1 - u : u, fv ? 1 - v : v]);
      const w = width, h = height;
      const x = clamp(num("crop_x", 0), 0, .95), y = clamp(num("crop_y", 0), 0, .95);
      const cw = clamp(num("crop_w", 1), .05, 1-x), ch = clamp(num("crop_h", 1), .05, 1-y);
      width = Math.max(1, Math.round(w*cw)); height = Math.max(1, Math.round(h*ch));
      const ow = width, oh = height;
      const angle = -num("angle", 0)*Math.PI/180, aspect = num("aspect", 0)/100;
      // The whole photograph, straight: nothing to undo, and a click on
      // an uncropped photograph keeps its exact numbers.
      if (angle === 0 && aspect === 0 && x === 0 && y === 0 && cw === 1 && ch === 1) continue;
      const ox = angle === 0 && aspect === 0 ? Math.min(Math.round(x*w), w-ow) : x*w;
      const oy = angle === 0 && aspect === 0 ? Math.min(Math.round(y*h), h-oh) : y*h;
      undo.push(([u,v]) => {
        const dx = ox + ow/2 + (u-.5)*ow/(aspect < 0 ? 1-aspect : 1) - w/2;
        const dy = oy + oh/2 + (v-.5)*oh/(aspect > 0 ? 1+aspect : 1) - h/2;
        return [.5 + (dx*Math.cos(angle)-dy*Math.sin(angle))/w, .5 + (dx*Math.sin(angle)+dy*Math.cos(angle))/h];
      });
    } else if (n.type === "heeler.lens_correct") {
      const undoLens = lensSourceOf(n.params, width, height);
      if (undoLens) undo.push(undoLens);
    } else if (n.type === "heeler.grid_warp") {
      const mesh = meshFromParams(num("cols",4), num("rows",3), str("cols_u"), str("rows_v"), str("mesh"), str("lattice"));
      undo.push(([u,v]) => warpEdges(sourceOf(mesh,u,v)));
    } else if (n.type === "heeler.shape_warp") {
      const shapes = parseShapes(str("shapes")), aspect = width/height;
      undo.push(([u,v]) => warpEdges(sourceOfField((x,y) => shapesDisplacement(shapes,x,y,aspect),u,v)));
    }

  }
  undo.reverse();
  return (point: Pt) => {
    const mapped = undo.reduce((p, f) => f(p), point);
    return mapped.every(Number.isFinite) ? mapped : null;
  };
}

/** The lens correction's geometry as a map from its output to the point
 * it samples, both in fractions of its frame: the green channel's map
 * in ops_lens.rs lens_correct (the manual distortion, then the profile's
 * model), which is the one a planted raster takes (lib.rs
 * lens_geometry_buf). Null when the node bends nothing. The fringe and
 * vignette terms move no pixel across the frame and are left out. */
export function lensSourceOf(params: Record<string, unknown>, width: number, height: number): ((p: Pt) => Pt) | null {
  const num = (k: string, d: number) => (typeof params[k] === "number" && Number.isFinite(params[k]) ? (params[k] as number) : d);
  const clampTo = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
  const k = clampTo(num("distortion", 0), -100, 100) / 1000;
  const model = typeof params.dist_model === "string" ? params.dist_model : "none";
  const a = num("dist_a", 0), b = num("dist_b", 0), c = num("dist_c", 0);
  const scale = clampTo(num("dist_scale", 1), 0.1, 4);
  const factor = (ru: number): number | null => {
    const r2 = ru * ru;
    if (model === "poly3") return 1 - a + a * r2;
    if (model === "poly5") return 1 + a * r2 + b * r2 * r2;
    if (model === "ptlens") return a * r2 * ru + b * r2 + c * ru + (1 - a - b - c);
    return null;
  };
  const profiled = factor(0.5) !== null && (Math.abs(a) > 1e-9 || Math.abs(b) > 1e-9 || Math.abs(c) > 1e-9);
  if (Math.abs(k) <= 1e-9 && !profiled) return null;
  const cx = (width - 1) / 2, cy = (height - 1) / 2;
  const norm = Math.max(Math.hypot(cx, cy), 1e-6);
  const short = Math.max(Math.min(cx, cy), 1e-6);
  return ([u, v]) => {
    // A pixel center's offset from the op's center, in pixels.
    const dx = (u - 0.5) * width, dy = (v - 0.5) * height;
    const d = Math.hypot(dx, dy);
    const r = d / norm;
    const sp = profiled ? (factor((d / short) * scale) ?? 1) : 1;
    const s = sp * (1 + k * r * r);
    // The op clamps its sample to the edge pixels' centers.
    return [
      clampTo(0.5 + (u - 0.5) * s, 0.5 / width, 1 - 0.5 / width),
      clampTo(0.5 + (v - 0.5) * s, 0.5 / height, 1 - 0.5 / height),
    ];
  };
}

/** Where a point of the photograph shows on the rendered frame, in
 * fractions of each: sourcePoint's inverse, found by Newton's method on
 * sourcePoint's own walk so the two cannot disagree (a crop, a turn and
 * the stretch dial are affine and land in one step; a warp takes a
 * few). Null when the point is not on the frame: cropped away, or
 * pulled off it by a warp. */
export function framePoint(graph: Graph, size: Pt, photo: Pt): Pt | null {
  const toSource = sourceMapOf(graph, size);
  let p: Pt = [0.5, 0.5];
  const h = 1e-5;
  for (let i = 0; i < 40; i++) {
    const at = toSource(p);
    if (!at) return null;
    const rx = at[0] - photo[0];
    const ry = at[1] - photo[1];
    if (Math.hypot(rx, ry) < 1e-10) break;
    const ax = toSource([p[0] + h, p[1]]);
    const ay = toSource([p[0], p[1] + h]);
    if (!ax || !ay) return null;
    const j00 = (ax[0] - at[0]) / h, j10 = (ax[1] - at[1]) / h;
    const j01 = (ay[0] - at[0]) / h, j11 = (ay[1] - at[1]) / h;
    const det = j00 * j11 - j01 * j10;
    if (!(Math.abs(det) > 1e-12)) return null;
    p = [p[0] - (j11 * rx - j01 * ry) / det, p[1] - (j00 * ry - j10 * rx) / det];
    if (!p.every(Number.isFinite)) return null;
  }
  const back = toSource(p);
  if (!back || Math.hypot(back[0] - photo[0], back[1] - photo[1]) > 1e-6) return null;
  return p[0] >= 0 && p[0] <= 1 && p[1] >= 0 && p[1] <= 1 ? p : null;
}
