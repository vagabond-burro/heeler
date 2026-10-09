//! The owner's hand checks, run on a real photograph (2026-10-01: "The
//! canyon RAW, once /Volumes/DATA is mounted: a strong masked warp and
//! repair strokes across the edge of the 1:1 view, compared with the
//! export"). The fixture tests (warp_bake.rs, finish_warps.rs,
//! heal_slice_parity.rs) hold these paths on smooth synthetic pictures;
//! here the same graphs, built as the reducer builds them, go over a
//! sharp RAW at its full 20 to 24 megapixels:
//!
//! - a masked Finish Warp layer, Shapes: an ellipse on a cliff dragged
//!   far (it folds and covers what lies ahead) and pinched, and a second
//!   shape pushed past the frame's edge; a Grid Warp with a handle
//!   dragged across its neighbor and an edge handle moved, masked;
//! - a Pixel layer with clone and heal strokes whose sources lie outside
//!   the 1:1 rectangle, a heal and a paint stroke crossing its edges, a
//!   blur stroke on its edge and a clone on the frame's corner.
//!
//! Each is measured as the viewer gets it: the 1:1 slice (or the whole
//! frame, when the slice declines) over several rectangles against the
//! export cropped, and Fit against the export reduced, at the fixture
//! tests' quarter (the photograph reduced four by four, its pixel scale
//! on the graph) and at the app's own Fit (the 2048 preview decode).
//! A sharp photograph is never its own quarter size bit for bit, so
//! every Fit number comes with the same number for the graph without
//! the layer (the baseline), and the bounded check runs on the
//! photograph smoothed until the Fit render's bilinear tap keeps its
//! detail, where the fixture tests' bounds (FIT, FIT_PAINTED, the
//! stretched mask edge) apply as they are.
//!
//! Ignored, and a no-op without the file (use a COPY of the RAW):
//!   HEELER_CANYON=<RAW> HEELER_CANYON_OUT=<dir for crops>
//!   cargo test -p heeler-desktop --lib canyon_ -- --ignored --nocapture --test-threads=1
//! canyon_cost times the decode, every tier and the bakes; run it in
//! release (--release) and in the dev profile.
use super::*;
use serde_json::json;
use std::path::{Path, PathBuf};
use std::time::Instant;

fn canyon() -> Option<PathBuf> {
    let p = std::env::var_os("HEELER_CANYON").map(PathBuf::from).filter(|p| p.is_file());
    if p.is_none() {
        eprintln!("HEELER_CANYON not set or missing: skipped");
    }
    p
}

fn out_dir() -> PathBuf {
    let out = PathBuf::from(std::env::var("HEELER_CANYON_OUT").unwrap_or_else(|_| "/tmp/heeler-canyon".into()));
    std::fs::create_dir_all(&out).unwrap();
    out
}

fn load(raw: &Path) -> (Arc<ImageBuf>, heeler_io::RawSourceOpts, u128) {
    let ui: UiGraph = serde_json::from_str(super::quality_probe::FRESH_GRAPH).unwrap();
    let opts = source_opts_of(&ui);
    let t = Instant::now();
    let img = heeler_io::decode_any_with(raw, opts).unwrap();
    (Arc::new(img), opts, t.elapsed().as_millis())
}

fn uptime() -> String {
    std::process::Command::new("uptime").output().map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string()).unwrap_or_default()
}

// ---- Graphs ------------------------------------------------------------

/// The fresh graph a never-edited RAW opens with, with one Finish layer
/// on it as the reducer lays one down: To Display, the layer, its
/// blend (and the blend's mask, painted on the photograph), To Scene.
fn finish(layer: serde_json::Value, mask_regions: Option<serde_json::Value>) -> UiGraph {
    let mut g: serde_json::Value = serde_json::from_str(super::quality_probe::FRESH_GRAPH).unwrap();
    let nodes = g["nodes"].as_array_mut().unwrap();
    nodes.push(json!({"id": "art_in", "type": "heeler.to_display", "label": "To Display", "enabled": true, "params": {}, "x": 24, "y": 96}));
    nodes.push(layer);
    nodes.push(json!({"id": "art_b1", "type": "heeler.blend", "label": "Layer 1", "enabled": true, "params": {"opacity": 100, "mode": "normal"}, "x": 64, "y": 340}));
    nodes.push(json!({"id": "art_out", "type": "heeler.to_scene", "label": "To Scene", "enabled": true, "params": {}, "x": 324, "y": 96}));
    if let Some(regions) = &mask_regions {
        let regions = regions.to_string();
        let base = json!({"antialias": 1, "regions": regions, "strokes": "[]"}).to_string();
        nodes.push(json!({"id": "art_m_art_b1", "type": "heeler.brush_mask", "label": "Layer Mask", "enabled": true,
            "params": {"invert": true, "base_invert": 1, "base_selection": base, "strokes": "[]", "regions": regions}, "x": 64, "y": 458}));
    }
    let conns = g["connections"].as_array_mut().unwrap();
    conns.retain(|c| !(c["from"][0] == json!("profile") && c["to"][0] == json!("output")));
    for (f, t) in [
        (("profile", "out"), ("art_in", "in")),
        (("art_in", "out"), ("art_p1", "in")),
        (("art_in", "out"), ("art_b1", "in")),
        (("art_p1", "out"), ("art_b1", "fg")),
        (("art_b1", "out"), ("art_out", "in")),
        (("art_out", "out"), ("output", "in")),
    ] {
        conns.push(json!({"from": [f.0, f.1], "to": [t.0, t.1]}));
    }
    if mask_regions.is_some() {
        conns.push(json!({"from": ["src", "out"], "to": ["art_m_art_b1", "in"]}));
        conns.push(json!({"from": ["art_m_art_b1", "out"], "to": ["art_b1", "mask"]}));
    }
    serde_json::from_value(g).unwrap()
}

/// The picture with no layer: the fresh graph.
fn bare() -> UiGraph {
    serde_json::from_str(super::quality_probe::FRESH_GRAPH).unwrap()
}

fn warp_node(kind: &str, shapes: &str, mesh: &str) -> serde_json::Value {
    json!({"id": "art_p1", "type": "heeler.layer_warp", "label": "Warp 1", "enabled": true,
        "params": {"cols": 4, "rows": 3, "room": 25, "space": "frame", "cols_u": "", "rows_v": "", "mesh": mesh,
            "lattice": "", "shapes": shapes, "edges": "clamp", "kind": kind}, "x": 64, "y": 220})
}

fn ellipse(x0: f64, y0: f64, x1: f64, y1: f64) -> serde_json::Value {
    json!({"kind": "marquee", "op": "add", "x0": x0, "y0": y0, "x1": x1, "y1": y1, "shape": "ellipse"})
}

/// A strong Shapes warp: an ellipse on the left cliff dragged far left
/// over the plain (the head folds over what lies ahead of it) and
/// pinched (narrower, taller), and a second shape at the right edge
/// pushed out past the frame and enlarged. Masked round both.
fn shapes_warp() -> UiGraph {
    let shapes = json!([
        {"id": "shape_1", "enabled": true, "shape": "ellipse", "shape_amount": 0.5, "cx": 0.42, "cy": 0.63, "radius": 0.1,
         "feather": 0.3, "aspect": 1, "rotation": 0, "dx": -0.16, "dy": 0.02, "angle": 0, "scale": 0.7, "scale_y": 1.25, "amount": 1, "hold": false},
        {"id": "shape_2", "enabled": true, "shape": "ellipse", "shape_amount": 0.5, "cx": 0.92, "cy": 0.68, "radius": 0.08,
         "feather": 0.3, "aspect": 1, "rotation": 0, "dx": 0.07, "dy": -0.02, "angle": 0, "scale": 1.3, "scale_y": 1.3, "amount": 1, "hold": false}
    ])
    .to_string();
    finish(warp_node("shapes", &shapes, "[]"), Some(json!([ellipse(0.3, 0.5, 0.56, 0.77), ellipse(0.8, 0.58, 1.0, 0.8)])))
}

/// Grid Warp, 4 by 3: the second handle of the second row dragged 0.3
/// of the frame right, across its neighbor 0.25 away (the grid folds),
/// and the right edge's handle on the third row pulled in. Masked round
/// the fold and round the edge handle.
fn grid_warp() -> UiGraph {
    let mut d = vec![0.0f64; 40];
    d[12] = 0.3; // vertex 6: row 1, column 1, dx
    d[28] = -0.06; // vertex 14: row 2, column 4 (the right edge), dx
    d[29] = 0.03;
    let mesh = serde_json::to_string(&d).unwrap();
    finish(warp_node("grid", "[]", &mesh), Some(json!([ellipse(0.1, 0.18, 0.8, 0.5), ellipse(0.78, 0.55, 1.0, 0.8)])))
}

/// The Pixel layer's repair strokes round the 1:1 rectangle STROKES_RECT.
fn repair() -> UiGraph {
    let strokes = json!([
        // Clone inside the rectangle, its source far outside it (the mesa).
        {"points": [[0.45, 0.66]], "radius": 0.04, "hardness": 0.8, "flow": 1, "src_dx": 0.3, "src_dy": -0.25},
        // Heal across the rectangle's left edge, its source on the plain.
        {"points": [[0.3, 0.62], [0.3, 0.66]], "radius": 0.05, "hardness": 0.8, "flow": 1, "src_dx": -0.2, "src_dy": 0.15, "heal": true},
        // Heal inside, its source in the sky.
        {"points": [[0.5, 0.71]], "radius": 0.03, "hardness": 0.8, "flow": 1, "src_dx": 0.0, "src_dy": -0.4, "heal": true},
        // Paint crossing the bottom and the right edges.
        {"points": [[0.35, 0.7], [0.5, 0.78], [0.62, 0.74]], "radius": 0.015, "hardness": 0.8, "flow": 1, "color": "#3366cc"},
        // Blur on the right edge.
        {"points": [[0.6, 0.58], [0.6, 0.64]], "radius": 0.03, "hardness": 0.8, "flow": 1, "blur": true, "blur_strength": 1.0},
        // Clone on the frame's bottom left corner, its source on the cliff.
        {"points": [[0.05, 0.95]], "radius": 0.04, "hardness": 0.8, "flow": 1, "src_dx": 0.4, "src_dy": -0.3}
    ])
    .to_string();
    finish(json!({"id": "art_p1", "type": "heeler.paint", "label": "Pixel 1", "enabled": true, "params": {"strokes": strokes}, "x": 64, "y": 220}), None)
}

/// 1:1 rectangles (fractions of the frame) for the warps: across the
/// dragged head's leading ring, its trailing side, the edge shape on
/// the frame's right edge, the top left corner, the grid's fold and the
/// grid's edge handle.
const WARP_RECTS: [[f64; 4]; 6] = [
    [0.15, 0.52, 0.25, 0.18],
    [0.35, 0.55, 0.25, 0.18],
    [0.75, 0.6, 0.25, 0.18],
    [0.0, 0.0, 0.25, 0.18],
    [0.3, 0.25, 0.3, 0.18],
    [0.75, 0.55, 0.25, 0.2],
];
/// The 1:1 rectangle the repair strokes are placed round, then one to
/// its right (the paint and the blur cross into it) and the frame's
/// bottom left corner (the corner clone).
const STROKE_RECTS: [[f64; 4]; 3] = [[0.3, 0.55, 0.3, 0.2], [0.55, 0.6, 0.3, 0.2], [0.0, 0.8, 0.3, 0.2]];

// ---- Rendering ---------------------------------------------------------

fn sources_for(ui: &UiGraph, image: &Arc<ImageBuf>) -> HashMap<String, SourceImage> {
    let mut sources = HashMap::new();
    for n in ui.nodes.iter().filter(|n| n.node_type == "heeler.image_source" || n.node_type == "heeler.group") {
        sources.insert(n.id.clone(), SourceImage { image: image.clone(), version: image.width as u64, measured: false });
    }
    sources
}

fn render_node(ui: &UiGraph, node: &str, image: &Arc<ImageBuf>, exec: &mut Executor) -> Value {
    let g = build_graph(ui, &Registry::builtin()).unwrap();
    exec.render(&g, node, &sources_for(ui, image)).unwrap()
}

/// What the viewer gets at 1:1 for `rect`: the slice, rendered as
/// render_preview_attempt renders it (the full source, a full-tier
/// executor), and the rect of the frame it covers; the whole frame
/// when the slice declines.
fn one_to_one(ui: &UiGraph, full: &Arc<ImageBuf>, rect: [f64; 4]) -> (Arc<ImageBuf>, [f64; 4], bool) {
    let (graph, actual, sliced) = match inject_roi_for_view(ui, rect, (full.width, full.height), None) {
        Some((g, a)) => (g, a, true),
        None => (ui.clone(), [0.0, 0.0, 1.0, 1.0], false),
    };
    let mut exec = full_tier_executor(None);
    let v = render_node(&graph, &terminal_of(&graph).unwrap(), full, &mut exec);
    (v.as_image().unwrap().clone(), actual, sliced)
}

fn srgb(v: f32) -> f32 {
    let v = v.clamp(0.0, 1.0);
    if v <= 0.003_130_8 { v * 12.92 } else { 1.055 * v.powf(1.0 / 2.4) - 0.055 }
}

/// The Finish stack's encoding (its To Display node's curve), where its
/// layers composite and where warp_bake.rs compares Fit.
fn encoded(img: &ImageBuf) -> ImageBuf {
    let mut out = img.clone();
    out.data.par_chunks_exact_mut(4).for_each(|px| {
        for c in px.iter_mut().take(3) {
            *c = srgb(*c);
        }
    });
    out
}

/// Four by four box reduction, warp_bake.rs's `reduced`.
fn reduce4(ex: &ImageBuf) -> ImageBuf {
    let (w, h) = (ex.width / 4, ex.height / 4);
    let mut out = ImageBuf::new(w, h);
    out.data.par_chunks_exact_mut(w * 4).enumerate().for_each(|(y, row)| {
        for x in 0..w {
            let mut s = [0.0f32; 4];
            for j in 0..4 {
                for i in 0..4 {
                    let p = ex.pixel(x * 4 + i, y * 4 + j);
                    for c in 0..4 {
                        s[c] += p[c] / 16.0;
                    }
                }
            }
            row[x * 4..x * 4 + 4].copy_from_slice(&s);
        }
    });
    out
}

/// The photograph low-passed (three box passes of radius 6, a Gaussian
/// of sigma about 6.5 full pixels, 1.6 Fit pixels): the canyon's
/// structure and contrast with no detail the Fit render's bilinear tap
/// loses, the kind of picture the fixture tests' bounds are made for.
///
/// Where a warp or a clone moves the picture by a fraction of a Fit
/// pixel, Fit reads the Fit picture through the bilinear tap, which
/// keeps cos(pi / L) of a wave L Fit pixels long at half a pixel; the
/// export moves its own pixels and reduced keeps it whole (ops_warp.rs
/// a_picture_moved_a_fraction_of_a_fit_pixel_loses_what_the_bilinear_
/// tap_loses). That is the picture's own detail at a quarter of the
/// size, which no resampling of the Fit picture gets back, and not the
/// gap this check is for. Smoothed by radius 3 (sigma 0.87 Fit pixels),
/// the canyon kept enough of it at four to six Fit pixels to leave Fit
/// 0.035 off where the Grid warp squeezes the cliff, 0.029 where the
/// heal and the clone read their sources, past the bound on 595, 32 and
/// 777 pixels of the three layers, all in the picture's texture; at
/// radius 6 a wave four Fit pixels long keeps 4% of its swing, and none
/// of the three passes the bound there. Every gap this check has found
/// (the mask's band, the marquee's quarters, the folded head's speckle)
/// shows on either picture: they come from the geometry, not the
/// picture's detail.
fn smoothed(img: &ImageBuf) -> ImageBuf {
    let (w, h) = (img.width, img.height);
    let mut a = img.clone();
    let r = 6usize;
    for _ in 0..3 {
        // Rows.
        let src = a.clone();
        a.data.par_chunks_exact_mut(w * 4).enumerate().for_each(|(y, row)| {
            for x in 0..w {
                let (x0, x1) = (x.saturating_sub(r), (x + r).min(w - 1));
                let mut s = [0.0f32; 4];
                for xx in x0..=x1 {
                    let p = src.pixel(xx, y);
                    for c in 0..4 {
                        s[c] += p[c];
                    }
                }
                let n = (x1 - x0 + 1) as f32;
                for c in 0..4 {
                    row[x * 4 + c] = s[c] / n;
                }
            }
        });
        // Columns.
        let src = a.clone();
        a.data.par_chunks_exact_mut(w * 4).enumerate().for_each(|(y, row)| {
            let (y0, y1) = (y.saturating_sub(r), (y + r).min(h - 1));
            let n = (y1 - y0 + 1) as f32;
            for x in 0..w {
                let mut s = [0.0f32; 4];
                for yy in y0..=y1 {
                    let p = src.pixel(x, yy);
                    for c in 0..4 {
                        s[c] += p[c];
                    }
                }
                for c in 0..4 {
                    row[x * 4 + c] = s[c] / n;
                }
            }
        });
    }
    a
}

use rayon::prelude::*;

// ---- Numbers -----------------------------------------------------------

/// Max and mean absolute difference per channel over a window, and the
/// worst pixel (in `a`'s coordinates).
struct Diff {
    max: [f32; 3],
    mean: [f32; 3],
    at: (usize, usize),
}
impl Diff {
    fn worst(&self) -> f32 {
        self.max.iter().copied().fold(0.0, f32::max)
    }
}
impl std::fmt::Display for Diff {
    fn fmt(&self, f: &mut std::fmt::Formatter) -> std::fmt::Result {
        write!(
            f,
            "max r/g/b {:.2e} {:.2e} {:.2e}, mean {:.2e} {:.2e} {:.2e}, worst at ({}, {})",
            self.max[0], self.max[1], self.max[2], self.mean[0], self.mean[1], self.mean[2], self.at.0, self.at.1
        )
    }
}

/// a over (ax, ay, w, h) against b over (bx, by, w, h).
fn diff(a: &ImageBuf, ax: usize, ay: usize, b: &ImageBuf, bx: usize, by: usize, w: usize, h: usize) -> Diff {
    let mut d = Diff { max: [0.0; 3], mean: [0.0; 3], at: (0, 0) };
    let mut sum = [0.0f64; 3];
    let mut worst = 0.0f32;
    for y in 0..h {
        for x in 0..w {
            let (p, q) = (a.pixel(ax + x, ay + y), b.pixel(bx + x, by + y));
            let mut m = 0.0f32;
            for c in 0..3 {
                let e = (p[c] - q[c]).abs();
                d.max[c] = d.max[c].max(e);
                sum[c] += e as f64;
                m = m.max(e);
            }
            if m > worst {
                worst = m;
                d.at = (ax + x, ay + y);
            }
        }
    }
    for c in 0..3 {
        d.mean[c] = (sum[c] / (w * h) as f64) as f32;
    }
    d
}

fn px_rect(rect: [f64; 4], w: usize, h: usize) -> (usize, usize, usize, usize) {
    // The pixels the rect covers: its start and its end each rounded.
    let (x, y) = ((w as f64 * rect[0]).round() as usize, (h as f64 * rect[1]).round() as usize);
    let (x1, y1) = (((w as f64 * (rect[0] + rect[2])).round() as usize).min(w), ((h as f64 * (rect[1] + rect[3])).round() as usize).min(h));
    (x, y, x1 - x, y1 - y)
}

/// Side by side: each panel sRGB-encoded (or already encoded), with a
/// difference panel amplified, 6 px of gray between.
fn sheet(panels: &[&ImageBuf], encode: bool, amplify: f32, path: &Path) {
    let (w, h) = (panels[0].width, panels[0].height);
    let gap = 6;
    let n = panels.len() + 1;
    let mut out = ImageBuf::filled(w * n + gap * (n - 1), h, [0.5, 0.5, 0.5, 1.0]);
    let get = |img: &ImageBuf, x: usize, y: usize| {
        let p = img.pixel(x, y);
        if encode { [srgb(p[0]), srgb(p[1]), srgb(p[2])] } else { [p[0], p[1], p[2]] }
    };
    for y in 0..h {
        for x in 0..w {
            for (k, img) in panels.iter().enumerate() {
                let p = get(img, x, y);
                out.set_pixel(k * (w + gap) + x, y, [p[0], p[1], p[2], 1.0]);
            }
            let (a, b) = (get(panels[0], x, y), get(panels[1], x, y));
            let d = [(a[0] - b[0]).abs() * amplify, (a[1] - b[1]).abs() * amplify, (a[2] - b[2]).abs() * amplify];
            out.set_pixel((n - 1) * (w + gap) + x, y, [d[0].min(1.0), d[1].min(1.0), d[2].min(1.0), 1.0]);
        }
    }
    std::fs::write(path, heeler_io::encode_png_raw(&out).unwrap()).unwrap();
}

/// Nearest neighbor, `k` times, so single pixels show.
fn zoom(img: &ImageBuf, k: usize) -> ImageBuf {
    let mut out = ImageBuf::new(img.width * k, img.height * k);
    for y in 0..out.height {
        for x in 0..out.width {
            out.set_pixel(x, y, img.pixel(x / k, y / k));
        }
    }
    out
}

fn window(img: &ImageBuf,x: usize, y: usize, w: usize, h: usize) -> ImageBuf {
    let (x, y) = (x.min(img.width.saturating_sub(w)), y.min(img.height.saturating_sub(h)));
    let mut out = ImageBuf::new(w, h);
    for j in 0..h {
        for i in 0..w {
            out.set_pixel(i, j, img.pixel(x + i, y + j));
        }
    }
    out
}

// ---- 1:1 ---------------------------------------------------------------

/// The 1:1 view of each rect against the export cropped. Answers the
/// worst difference over all of them.
fn check_one_to_one(name: &str, ui: &UiGraph, full: &Arc<ImageBuf>, export: &ImageBuf, rects: &[[f64; 4]], out: &Path) -> f32 {
    let mut worst = 0.0f32;
    let mut whole: Option<Arc<ImageBuf>> = None;
    for (k, &rect) in rects.iter().enumerate() {
        let t = Instant::now();
        let (patch, actual, sliced) = if let (Some(w), None) = (&whole, inject_roi_for_view(ui, rect, (full.width, full.height), None)) {
            (w.clone(), [0.0, 0.0, 1.0, 1.0], false)
        } else {
            one_to_one(ui, full, rect)
        };
        let ms = t.elapsed().as_millis();
        if !sliced {
            whole = Some(patch.clone());
        }
        let (fw, fh) = (export.width, export.height);
        let (pw, ph, px, py) = heeler_engine::frame_window(fw, fh, actual.map(|v| v as f32));
        assert_eq!((patch.width, patch.height), (pw, ph), "{name}: the patch is the rect it says");
        let (sx, sy, sw, sh) = px_rect(rect, fw, fh);
        if !(sx >= px && sy >= py && sx + sw <= px + pw && sy + sh <= py + ph) {
            eprintln!("{name} 1:1 rect {k}: FINDING the patch {pw}x{ph} at ({px},{py}) does not hold the asked {sw}x{sh} at ({sx},{sy}); compared over their overlap");
        }
        let (ox, oy) = (sx.max(px), sy.max(py));
        let (sw, sh) = ((sx + sw).min(px + pw) - ox, (sy + sh).min(py + ph) - oy);
        let (sx, sy) = (ox, oy);
        let d = diff(&patch, sx - px, sy - py, export, sx, sy, sw, sh);
        eprintln!(
            "{name} 1:1 rect {k} {rect:?} ({sw}x{sh} at {sx},{sy}): {} ({}x{} at {px},{py}, {ms} ms): {d}",
            if sliced { "slice" } else { "whole frame (slice declined)" },
            pw,
            ph
        );
        worst = worst.max(d.worst());
        // The crop: 480 by 360 round the rect's worst pixel, or its
        // middle when it is exact.
        let (cx, cy) = if d.worst() > 0.0 { d.at } else { (sx + sw / 2, sy + sh / 2) };
        let (cw, ch) = (480usize, 360usize);
        let (x0, y0) = (cx.saturating_sub(cw / 2).max(sx).min(sx + sw - cw), cy.saturating_sub(ch / 2).max(sy).min(sy + sh - ch));
        let a = window(&patch, x0 - px, y0 - py, cw, ch);
        let b = window(export, x0, y0, cw, ch);
        sheet(&[&a, &b], true, 50.0, &out.join(format!("{name}_1to1_rect{k}.png")));
    }
    worst
}

// ---- Fit ---------------------------------------------------------------

/// warp_bake.rs's bounds, as they are there.
const FIT: f32 = 0.012;
const FIT_PAINTED: f32 = 0.02;

/// warp_bake.rs's stretched_mask_edge on any warp field, with the
/// warp's own re-read of the mask: where the warp moves the layer's
/// carried mask and stretches it k times (k at least one), 0.5 (1 -
/// 1/(2k)) of the layer's step against the picture below may come on
/// top of FIT, pixel by pixel, at the carried mask's partial pixels
/// alone.
///
/// The mask is area samples, its antialiased edge a pixel wide at every
/// size, so at Fit four export pixels wide. Where the warp moves it by a
/// fraction of a pixel, the warp reads those samples through its
/// bilinear tap, which spreads an edge that sits mid-pixel over the two
/// pixels either side: a quarter of the step off the moved edge's own
/// coverage at half a pixel, at every size in that size's pixels. In the
/// export that is a quarter of an export pixel and the reduction takes
/// it out; at Fit it stays (ops_warp.rs a_mask_edge_moved_a_fraction_of_
/// a_fit_pixel_is_a_quarter_step_off_at_most measures 0.25 exactly
/// against the analytic coverage, the export reduced within 0.02). So
/// Fit's edge is two of its source pixels wide, 2k of its own where the
/// warp stretches it, against the export reduced's one: two ramps up the
/// same step, which part by at most half of one less their widths'
/// ratio. warp_bake.rs's fixtures stay inside its 0.5 (1 - 1/k); the
/// canyon's mask edges (a marquee mid-pixel, moved half a Fit pixel by
/// the Grid warp's edge handle) do not, and need the quarter.
fn stretched_mask_edge(field: &dyn heeler_engine::WarpField, mask: &MaskBuf, live: &ImageBuf, below: &ImageBuf) -> Vec<f32> {
    let (w, h) = (live.width, live.height);
    assert_eq!((mask.width, mask.height), (w, h));
    let (fw, fh) = (w as f32, h as f32);
    let aspect = fw / fh;
    let forward = |u: f32, v: f32| {
        let d = field.field(u, v, aspect);
        [(u + d[0]) * fw, (v + d[1]) * fh]
    };
    // The stretch at each pixel, and whether the warp moves the mask
    // there at all (its source is not the pixel itself; where it is, the
    // tap reads the samples at their own centers, exactly).
    let stretch: Vec<(f32, bool)> = (0..w * h)
        .into_par_iter()
        .map(|i| {
            let (u, v) = (((i % w) as f32 + 0.5) / fw, ((i / w) as f32 + 0.5) / fh);
            let s = heeler_engine::ops_warp::source_of(field, u, v, aspect);
            let moved = ((s[0] - u) * fw).hypot((s[1] - v) * fh) > 1e-3;
            let e = 0.25;
            let (p, px, py) = (forward(s[0], s[1]), forward(s[0] + e / fw, s[1]), forward(s[0], s[1] + e / fh));
            let (a, b, c, d) = ((px[0] - p[0]) / e, (py[0] - p[0]) / e, (px[1] - p[1]) / e, (py[1] - p[1]) / e);
            let (t, q) = (a * a + b * b + c * c + d * d, (a * d - b * c).powi(2));
            (((t + (t * t - 4.0 * q).max(0.0).sqrt()) * 0.5).sqrt(), moved)
        })
        .collect();
    let mut extra = vec![0.0f32; w * h];
    for y in 1..h - 1 {
        for x in 1..w - 1 {
            let (mut partial, mut k, mut step, mut moved) = (false, 0.0f32, 0.0f32, false);
            for j in y - 1..=y + 1 {
                for i in x - 1..=x + 1 {
                    let m = mask.data[j * w + i];
                    partial |= m > 0.02 && m < 0.98;
                    k = k.max(stretch[j * w + i].0);
                    moved |= stretch[j * w + i].1;
                    for c in 0..3 {
                        step = step.max((live.pixel(i, j)[c] - below.pixel(i, j)[c]).abs());
                    }
                }
            }
            if partial && moved {
                extra[y * w + x] = 0.5 * (1.0 - 1.0 / (2.0 * k.max(1.0))) * step;
            }
        }
    }
    extra
}

fn warp_field_of(ui: &UiGraph) -> Option<Box<dyn heeler_engine::WarpField>> {
    let n = ui.nodes.iter().find(|n| n.node_type == "heeler.layer_warp")?;
    let text = |k: &str| n.params.get(k).and_then(|v| v.as_str()).unwrap_or("").to_string();
    if text("kind") == "grid" {
        Some(Box::new(heeler_engine::GridMesh::from_params(4.0, 3.0, "", "", &text("mesh"))))
    } else {
        Some(Box::new(heeler_engine::ShapeWarp::from_text(&text("shapes"))))
    }
}

struct FitResult {
    /// worst over the frame (one pixel in), mean, with the layer
    with: Diff,
    /// the same for the picture with no layer
    baseline: Diff,
    /// pixels over their bound (FIT or FIT_PAINTED, plus the stretched
    /// mask edge, plus the baseline's own error at the pixel)
    over: usize,
    /// the worst excess past the bound, and where
    excess: (f32, usize, usize),
    /// the worst |Fit - export reduced| where the layer changes the export
    in_layer: f32,
    /// the baseline's worst over the same pixels
    in_layer_base: f32,
    region: usize,
}

/// Fit at the fixture tests' quarter: the photograph reduced four by
/// four, the pixel scale 0.25 on the graph, against the export reduced
/// four by four, both in the Finish stack's encoding. The bound per
/// pixel: FIT (FIT_PAINTED for a Pixel layer) plus the stretched mask
/// edge, plus the baseline's own error at that pixel (what the picture
/// with no layer is off there; zero on a picture smooth at Fit).
fn check_fit(name: &str, ui: &UiGraph, full: &Arc<ImageBuf>, export: &ImageBuf, base_export: &ImageBuf, painted: bool, out: &Path) -> FitResult {
    let quarter = Arc::new(reduce4(full));
    let scaled = inject_px_scale(ui, 0.25);
    let fit = |g: &UiGraph| -> Arc<ImageBuf> {
        let v = render_node(g, &terminal_of(g).unwrap(), &quarter, &mut Executor::new());
        v.as_image().unwrap().clone()
    };
    let f = encoded(&fit(&scaled));
    let red = reduce4(&encoded(export));
    let f0 = encoded(&fit(&inject_px_scale(&bare(), 0.25)));
    let red0 = reduce4(&encoded(base_export));
    let (w, h) = (f.width.min(red.width), f.height.min(red.height));
    let with = diff(&f, 1, 1, &red, 1, 1, w - 2, h - 2);
    let baseline = diff(&f0, 1, 1, &red0, 1, 1, w - 2, h - 2);
    // The mask's carried edge, when the layer is a masked warp.
    let extra = match (warp_field_of(ui), warp_bake_ports(ui, "art_b1").ok().and_then(|p| p.get(2).cloned())) {
        (Some(field), Some(mask_port)) => {
            let m = render_node(&scaled, &mask_port, &quarter, &mut Executor::new());
            let m = m.as_mask().expect("the carried mask").as_ref().clone();
            Some(stretched_mask_edge(field.as_ref(), &m, &f, &f0))
        }
        _ => None,
    };
    let bound = if painted { FIT_PAINTED } else { FIT };
    let (mut over, mut excess, mut in_layer, mut in_layer_base, mut region) = (0usize, (0.0f32, 0, 0), 0.0f32, 0.0f32, 0usize);
    for y in 1..h - 1 {
        for x in 1..w - 1 {
            let e = |a: &ImageBuf, b: &ImageBuf| (0..3).map(|c| (a.pixel(x, y)[c] - b.pixel(x, y)[c]).abs()).fold(0.0f32, f32::max);
            let (d, d0) = (e(&f, &red), e(&f0, &red0));
            let changed = e(&red, &red0) > 1e-4 || e(&f, &f0) > 1e-4;
            if changed {
                region += 1;
                in_layer = in_layer.max(d);
                in_layer_base = in_layer_base.max(d0);
            }
            let allow = bound + extra.as_ref().map(|v| v[y * w + x]).unwrap_or(0.0) + d0;
            if d > allow {
                over += 1;
                if d - allow > excess.0 {
                    excess = (d - allow, x, y);
                }
            }
        }
    }
    eprintln!(
        "{name} Fit@quarter {}x{}: with the layer {with}\n    no layer {baseline}\n    where the layer acts ({region} px): worst {in_layer:.4} (no layer there {in_layer_base:.4}); over the bound ({bound} + mask edge + baseline): {over} px, worst excess {:.4} at ({}, {})",
        w, h, excess.0, excess.1, excess.2
    );
    // Crops round the worst pixel where the layer acts, or the worst.
    let at = if excess.0 > 0.0 { (excess.1, excess.2) } else { with.at };
    let (cw, ch) = (320usize, 240usize);
    let (x0, y0) = (at.0.saturating_sub(cw / 2), at.1.saturating_sub(ch / 2));
    sheet(&[&window(&f, x0, y0, cw, ch), &window(&red, x0, y0, cw, ch)], false, 20.0, &out.join(format!("{name}_fit_worst.png")));
    // Close up: 48 by 36 Fit pixels round the worst, eight times, and
    // the export at full size over the same ground, twice.
    let (zx, zy) = (at.0.saturating_sub(24).min(w - 48), at.1.saturating_sub(18).min(h - 36));
    sheet(&[&zoom(&window(&f, zx, zy, 48, 36), 8), &zoom(&window(&red, zx, zy, 48, 36), 8)], false, 20.0, &out.join(format!("{name}_fit_zoom.png")));
    let ex = encoded(&window(export, zx * 4, zy * 4, 192, 144));
    let ex0 = encoded(&window(base_export, zx * 4, zy * 4, 192, 144));
    sheet(&[&zoom(&ex, 2), &zoom(&ex0, 2)], false, 5.0, &out.join(format!("{name}_fit_zoom_export.png")));
    FitResult { with, baseline, over, excess, in_layer, in_layer_base, region }
}

/// The app's own Fit: the 2048 preview decode reduced to 2048, the
/// pixel scale its short side over the photograph's, against the export
/// reduced to the same size by the same area reduction, in the Finish
/// stack's encoding. Numbers only (with the picture with no layer the
/// same way): the preview decode is not the full decode reduced.
fn check_app_fit(name: &str, ui: &UiGraph, raw: &Path, opts: heeler_io::RawSourceOpts, full: &Arc<ImageBuf>, export: &ImageBuf, base_export: &ImageBuf, out: &Path) {
    let pre = Arc::new(downscale(&heeler_io::decode_preview_at(raw, opts, 2048).unwrap(), 2048));
    let scale = px_scale_for(&pre, Some(full.width.min(full.height) as f32));
    let render = |g: &UiGraph| -> ImageBuf {
        let g = inject_px_scale(g, scale);
        let v = render_node(&g, &terminal_of(&g).unwrap(), &pre, &mut Executor::new());
        encoded(v.as_image().unwrap())
    };
    let (f, f0) = (render(ui), render(&bare()));
    let red = heeler_engine::downscale::resize_area(&encoded(export), f.width, f.height);
    let red0 = heeler_engine::downscale::resize_area(&encoded(base_export), f.width, f.height);
    let (w, h) = (f.width, f.height);
    let with = diff(&f, 1, 1, &red, 1, 1, w - 2, h - 2);
    let base = diff(&f0, 1, 1, &red0, 1, 1, w - 2, h - 2);
    let (mut in_layer, mut in_base) = (0.0f32, 0.0f32);
    for y in 1..h - 1 {
        for x in 1..w - 1 {
            let e = |a: &ImageBuf, b: &ImageBuf| (0..3).map(|c| (a.pixel(x, y)[c] - b.pixel(x, y)[c]).abs()).fold(0.0f32, f32::max);
            if e(&red, &red0) > 1e-4 || e(&f, &f0) > 1e-4 {
                in_layer = in_layer.max(e(&f, &red));
                in_base = in_base.max(e(&f0, &red0));
            }
        }
    }
    eprintln!(
        "{name} Fit@app {}x{} (px_scale {scale:.4}): with the layer {with}\n    no layer {base}\n    where the layer acts: worst {in_layer:.4} (no layer there {in_base:.4})",
        w, h
    );
    let (cw, ch) = (320usize, 240usize);
    let (x0, y0) = (with.at.0.saturating_sub(cw / 2), with.at.1.saturating_sub(ch / 2));
    sheet(&[&window(&f, x0, y0, cw, ch), &window(&red, x0, y0, cw, ch)], false, 20.0, &out.join(format!("{name}_appfit_worst.png")));
}

/// One graph through every check on one photograph.
fn run_all(name: &str, ui: &UiGraph, full: &Arc<ImageBuf>, base_export: &ImageBuf, rects: &[[f64; 4]], painted: bool, out: &Path) -> (f32, FitResult) {
    let t = Instant::now();
    let export = render_export(ui, full.clone(), &HashMap::new()).unwrap();
    eprintln!("{name}: export {}x{} in {} ms", export.width, export.height, t.elapsed().as_millis());
    let moved = diff(&export, 0, 0, base_export, 0, 0, export.width, export.height);
    eprintln!("{name}: the layer moves the export by {moved}");
    assert!(moved.worst() > 0.05, "{name}: the layer must change the picture for the check to mean anything");
    let one = check_one_to_one(name, ui, full, &export, rects, out);
    let fit = check_fit(name, ui, full, &export, base_export, painted, out);
    assert!(heeler_engine::ops::take_mask_mismatches().is_empty(), "{name}: a mask met a picture of another size");
    (one, fit)
}

/// The checks, on the canyon as decoded and on the canyon smoothed to a
/// Fit pixel. Panics (after printing every number) when a bound breaks:
/// the 1:1 view off the export by more than 1e-5 anywhere, or, on the
/// smoothed canyon, Fit off the export reduced past its bound anywhere.
///
/// Where it stands (2026-10-01, P1032466.RW2): a clean run passes.
/// - 1:1 equals the export to the bit for both warps (they render the
///   whole frame) and for the repair slice (2.2e-5 off on the smoothed
///   canyon and 9.4e-5 on the sharp one, at the heal across the slice's
///   edge, until the strokes were measured in the frame's own pixels and
///   moved into the patch by whole pixels, ops_masks.rs FrameWindow).
/// - Fit, smoothed canyon, worst where the layer acts: Shapes 0.011,
///   Grid 0.118 (on its mask's edge, inside the allowance), repair 0.019
///   (bound 0.02), none past its bound. Before: the Grid warp 0.375 past
///   on 2566 pixels where its mask's ellipse ends on the frame's right
///   edge and the warp stretched the mask's last column past the frame
///   into a band (ops_masks.rs beyond_render: past the frame the mask is
///   what its geometry says), then along its mask's edge where a
///   marquee's pixels came in quarters (ops_selection.rs fill_marquee)
///   and where the warp re-reads the mask's area samples a fraction of a
///   pixel off (stretched_mask_edge, the quarter); the Shapes warp 0.157
///   past on 1184 pixels, a speckle of background through the pinched,
///   dragged head where the fold's solve found no source or the wrong
///   one (ops_warp.rs ShapeWarp::seeds, seam_pixel); the repair 0.009
///   past on 32 pixels, the picture's detail re-read at a fraction of a
///   Fit pixel (smoothed). The same harness on the parent: Shapes 0.151
///   past on 355 pixels, Grid 0.283 past on 1136, the repair's 1:1 2.1e-5
///   off.
/// - The sharp canyon's numbers are printed, not bounded: a sharp
///   photograph is never its own quarter size.
#[test]
#[ignore]
fn canyon_one_to_one_and_fit_match_the_export() {
    let Some(raw) = canyon() else { return };
    let out = out_dir();
    eprintln!("load: {}", uptime());
    let (full, opts, ms) = load(&raw);
    eprintln!("decode {}x{} in {ms} ms", full.width, full.height);
    let cases: [(&str, UiGraph, &[[f64; 4]], bool); 3] =
        [("shapes", shapes_warp(), &WARP_RECTS, false), ("grid", grid_warp(), &WARP_RECTS, false), ("repair", repair(), &STROKE_RECTS, true)];
    let mut broken = Vec::new();
    for (picture, image) in [("sharp", full.clone()), ("smooth", Arc::new(smoothed(&full)))] {
        let base_export = render_export(&bare(), image.clone(), &HashMap::new()).unwrap();
        for (name, ui, rects, painted) in &cases {
            let label = format!("{picture}_{name}");
            if std::env::var("HEELER_CANYON_ONLY").is_ok_and(|only| !only.split(',').any(|o| label.contains(o))) {
                continue;
            }
            let (one, fit) = run_all(&label, ui, &image, &base_export, rects, *painted, &out);
            if one > 1e-5 {
                broken.push(format!("{label}: 1:1 off the export by {one}"));
            }
            if picture == "smooth" && fit.over > 0 {
                broken.push(format!("{label}: Fit over its bound at {} px, worst excess {}", fit.over, fit.excess.0));
            }
            let _ = (fit.with.worst(), fit.baseline.worst(), fit.in_layer, fit.in_layer_base, fit.region);
            if picture == "sharp" {
                let export = render_export(ui, image.clone(), &HashMap::new()).unwrap();
                check_app_fit(&label, ui, &raw, opts, &image, &export, &base_export, &out);
            }
        }
    }
    eprintln!("load: {}", uptime());
    assert!(broken.is_empty(), "{broken:#?}");
}

// ---- The causes, on synthetic pictures ---------------------------------

/// A smooth picture with structure a warp visibly moves.
fn synthetic(w: usize, h: usize) -> Arc<ImageBuf> {
    let mut img = ImageBuf::new(w, h);
    for y in 0..h {
        for x in 0..w {
            let (fx, fy) = ((x as f32 + 0.5) / w as f32, (y as f32 + 0.5) / h as f32);
            let t = (fx * std::f32::consts::TAU * 5.0).sin() * (fy * std::f32::consts::TAU * 3.0).sin();
            let v = 0.25 + 0.15 * t + 0.3 * fx;
            img.set_pixel(x, y, [v, v * 0.9, v * 0.8, 1.0]);
        }
    }
    Arc::new(img)
}

/// grid_warp's warp (its right edge's handle pulled in, so the right
/// edge reads from past the frame) with its mask's second region
/// swapped for `edge`.
fn grid_warp_with(edge: serde_json::Value) -> UiGraph {
    let mut d = vec![0.0f64; 40];
    d[12] = 0.3;
    d[28] = -0.06;
    d[29] = 0.03;
    let mesh = serde_json::to_string(&d).unwrap();
    finish(warp_node("grid", "[]", &mesh), Some(json!([ellipse(0.1, 0.18, 0.8, 0.5), edge])))
}

/// A Warp layer's carried mask at the export and at Fit (a quarter, the
/// pixel scale on the graph), and the Fit pixels whose source lies past
/// the frame's right edge by more than a Fit pixel, with their source.
fn carried_past_the_edge(ui: &UiGraph, w: usize, h: usize) -> (MaskBuf, MaskBuf, Vec<(usize, usize, [f32; 2])>) {
    let full = synthetic(w, h);
    let quarter = Arc::new(reduce4(&full));
    let port = warp_bake_ports(ui, "art_b1").unwrap()[2].clone();
    let at = |g: &UiGraph, img: &Arc<ImageBuf>| render_node(g, &port, img, &mut Executor::new()).as_mask().expect("the carried mask").as_ref().clone();
    let (export, fit) = (at(ui, &full), at(&inject_px_scale(ui, 0.25), &quarter));
    let field = warp_field_of(ui).unwrap();
    let (fw, fh) = (quarter.width, quarter.height);
    let mut past = Vec::new();
    for y in 1..fh - 1 {
        for x in 1..fw - 1 {
            let s = heeler_engine::ops_warp::source_of(field.as_ref(), (x as f32 + 0.5) / fw as f32, (y as f32 + 0.5) / fh as f32, w as f32 / h as f32);
            if s[0] > 1.0 + 1.0 / fw as f32 {
                past.push((x, y, s));
            }
        }
    }
    (export, fit, past)
}

fn reduced_at(m: &MaskBuf, x: usize, y: usize) -> f32 {
    let mut r = 0.0f32;
    for j in 0..4 {
        for i in 0..4 {
            r += m.data[(y * 4 + j) * m.width + x * 4 + i] / 16.0;
        }
    }
    r
}

/// Grid gap (canyon, 2026-10-01): a warp that pulls the frame's edge in
/// reads its mask from past the frame. Its mask's ellipse ends on the
/// frame's edge, and the mask's last column (a sliver of the ellipse a
/// pixel wide, four times as wide at Fit) was stretched into a band
/// across the layer, a different band at every size: 0.375 off the
/// export reduced on the canyon. Past the frame the mask is what its
/// geometry says there (ops_masks.rs beyond_render): nothing past an
/// ellipse that ends on the edge, at every size.
#[test]
fn a_mask_ending_on_the_frame_edge_is_not_stretched_past_it() {
    let (w, h) = (1600usize, 1200usize);
    let ui = grid_warp_with(ellipse(0.78, 0.55, 1.0, 0.8));
    let (export, fit, past) = carried_past_the_edge(&ui, w, h);
    assert!(past.len() > 100, "the warp reads past the frame's edge");
    let (mut worst_export, mut worst_gap) = ((0.0f32, 0, 0), (0.0f32, 0, 0));
    for &(x, y, _) in &past {
        let r = reduced_at(&export, x, y);
        if r > worst_export.0 {
            worst_export = (r, x, y);
        }
        let d = (fit.data[y * fit.width + x] - r).abs();
        if d > worst_gap.0 {
            worst_gap = (d, x, y);
        }
    }
    assert!(worst_export.0 <= 0.02, "past the frame the export's mask is the ellipse's (nothing): {worst_export:?}");
    assert!(worst_gap.0 <= 0.02, "past the frame Fit's mask is the export's reduced: {worst_gap:?}");
}

/// The other side of the same rule: a rectangle whose side lies on the
/// frame's edge (Select All, a marquee dragged to the edge) reaches on
/// past it, so what the warp pulls in from past the edge is masked as
/// the edge is, at every size.
#[test]
fn a_rectangle_on_the_frame_edge_reaches_past_it() {
    let (w, h) = (1600usize, 1200usize);
    let ui = grid_warp_with(json!({"kind": "marquee", "op": "add", "x0": 0.78, "y0": 0.55, "x1": 1.0, "y1": 0.8, "shape": "rect"}));
    let (export, fit, past) = carried_past_the_edge(&ui, w, h);
    let inside: Vec<_> = past.iter().filter(|(_, _, s)| s[1] > 0.56 && s[1] < 0.79).collect();
    assert!(inside.len() > 50, "the warp reads past the frame's edge beside the rectangle");
    for &&(x, y, s) in &inside {
        let (r, f) = (reduced_at(&export, x, y), fit.data[y * fit.width + x]);
        assert!(r >= 0.98 && f >= 0.98, "past the edge beside the rectangle the mask is on: export {r}, Fit {f} at ({x}, {y}), source {s:?}");
    }
}

// ---- Cost --------------------------------------------------------------

fn timed<T>(label: &str, f: impl FnOnce() -> T) -> T {
    let t = Instant::now();
    let v = f();
    eprintln!("  {label}: {} ms", t.elapsed().as_millis());
    v
}

/// The cost of the canyon: the cold decode and the preview decode, each
/// tier's render with the warps and the strokes (Fit cold and warm on
/// one executor as the session's, a 1:1 slice, the settle's whole frame,
/// the export), Bake Warp's stages, and a whole-frame Layer via Copy.
/// A measurement, not a check. Run in release and in the dev profile.
#[test]
#[ignore]
fn canyon_cost() {
    let Some(raw) = canyon() else { return };
    eprintln!("load before: {}", uptime());
    let (full, opts, ms) = load(&raw);
    eprintln!("cold decode {}x{}: {ms} ms", full.width, full.height);
    let pre = timed("preview decode @2048", || Arc::new(downscale(&heeler_io::decode_preview_at(&raw, opts, 2048).unwrap(), 2048)));
    let scale = px_scale_for(&pre, Some(full.width.min(full.height) as f32));
    for (name, ui, rect) in [("bare", bare(), STROKE_RECTS[0]), ("shapes warp", shapes_warp(), WARP_RECTS[0]), ("grid warp", grid_warp(), WARP_RECTS[4]), ("repair strokes", repair(), STROKE_RECTS[0])] {
        eprintln!("{name}:");
        let g = inject_px_scale(&ui, scale);
        let mut session = Executor::new();
        timed("Fit, cold", || render_node(&g, &terminal_of(&g).unwrap(), &pre, &mut session));
        timed("Fit, again (cached)", || render_node(&g, &terminal_of(&g).unwrap(), &pre, &mut session));
        let sliced = inject_roi_for_view(&ui, rect, (full.width, full.height), None).is_some();
        timed(if sliced { "1:1 slice" } else { "1:1 (slice declined: whole frame)" }, || one_to_one(&ui, &full, rect));
        timed("settle (whole frame, full tier)", || {
            let mut exec = full_tier_executor(None);
            render_node(&ui, &terminal_of(&ui).unwrap(), &full, &mut exec)
        });
        timed("export", || render_export(&ui, full.clone(), &HashMap::new()).unwrap());
    }
    // Bake Warp, the shapes warp, stage by stage (warp_bake.rs's
    // bake_warp_stage_timings on the canyon).
    let dir = tempfile::tempdir().unwrap();
    let before = shapes_warp();
    eprintln!("bake warp (shapes, masked):");
    let t0 = Instant::now();
    let ports = warp_bake_ports(&before, "art_b1").unwrap();
    let sources = sources_for(&before, &full);
    let g = build_graph(&before, &Registry::builtin()).unwrap();
    let mut exec = Executor::new();
    let mut rendered = Vec::new();
    for (i, id) in ports.iter().enumerate() {
        let v = timed(&format!("render port {i} ({id})"), || exec.render(&g, id, &sources).unwrap());
        rendered.push((v, Executor::key_of(&g, id, &sources).unwrap_or(0)));
    }
    let (cut, key) = timed("cut", || warp_bake_cut(&before, "art_b1", rendered).unwrap());
    eprintln!("  cut is {}x{} of {:?}", cut.image.width, cut.image.height, cut.frame);
    let bytes = timed("encode", || heeler_io::encode_tiff16_display_untagged(&cut.image, "timing").unwrap());
    eprintln!("  {} MB", bytes.len() >> 20);
    timed("keep (encode and write)", || layer_copy::keep_picture(dir.path(), key, &cut, "timing").unwrap());
    eprintln!("  bake total {} ms", t0.elapsed().as_millis());
    drop((cut, bytes, exec));
    // Layer via Copy over the whole frame: a marquee round everything.
    eprintln!("layer via copy (whole frame):");
    let t0 = Instant::now();
    let mut ui: serde_json::Value = serde_json::from_str(super::quality_probe::FRESH_GRAPH).unwrap();
    ui["nodes"].as_array_mut().unwrap().push(json!({"id": "sel_doc", "type": "heeler.selection_mask", "label": "Selection", "enabled": true,
        "params": {"antialias": true, "regions": json!([{"kind": "marquee", "op": "add", "x0": 0.0, "y0": 0.0, "x1": 1.0, "y1": 1.0}]).to_string()}, "x": 0, "y": 0}));
    // The picture under the Finish layers, in their encoding, as
    // layer-via-copy.json's picture copies read it (To Display).
    ui["nodes"].as_array_mut().unwrap().push(json!({"id": "art_in", "type": "heeler.to_display", "label": "To Display", "enabled": true, "params": {}, "x": 24, "y": 96}));
    ui["connections"].as_array_mut().unwrap().push(json!({"from": ["src", "out"], "to": ["sel_doc", "in"]}));
    ui["connections"].as_array_mut().unwrap().push(json!({"from": ["profile", "out"], "to": ["art_in", "in"]}));
    let ui: UiGraph = serde_json::from_value(ui).unwrap();
    let g = build_graph(&ui, &Registry::builtin()).unwrap();
    let sources = sources_for(&ui, &full);
    let mut exec = Executor::new();
    let sel = timed("render selection", || exec.render(&g, "sel_doc", &sources).unwrap());
    let pic = timed("render picture", || exec.render(&g, "art_in", &sources).unwrap());
    let (cut, _) = timed("cut", || layer_copy_cut(&ui, sel, pic, None).unwrap());
    eprintln!("  cut is {}x{}", cut.image.width, cut.image.height);
    let kept = timed("keep (encode and write)", || layer_copy::keep_copy(dir.path(), 0xc0c0, &cut).unwrap());
    eprintln!("  {} MB, total {} ms", kept.bytes >> 20, t0.elapsed().as_millis());
    eprintln!("load after: {}", uptime());
}
