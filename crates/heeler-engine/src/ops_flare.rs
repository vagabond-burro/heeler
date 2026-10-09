//! Lens Flare: the optical signature of a lens for the lights
//! already in the Depth Lighting rig. The node carries a copy of
//! the rig (the panel writes both nodes) and its own look; for
//! every light that flares it draws the source glow, the
//! diffraction rays, the chain of aperture ghosts down the axis
//! through the frame center, the anamorphic streak and the veiling
//! glare, and ADDS them to the frame in scene-linear light. It sits
//! after Depth of Field (the flare happens in the lens; the scene's
//! defocus must not soften it) and before the Tone Profile, which
//! rolls the added light into the highlights the way a real flare
//! blooms.
//!
//! Depth: the light is in the scene, two ways. A light's VISIBILITY is
//! the fraction of its core disc whose planted farness plane reads
//! farther than the light's depth, so something nearer than the light
//! hides it and every element, being an image of the source, fades
//! with it. And the core, the rays and the streak are masked PER PIXEL
//! by the same test, so a foreground object between the light and the
//! camera cuts the glow at its silhouette rather than being overlaid
//! by it ("a lens flare will get obscured by foreground
//! objects between the light source and camera. That is a window of
//! opportunity"). Ghosts and veil are formed inside the lens, so an
//! object at their screen position does not block them; they follow
//! the source's visibility alone. Without a plane the flare renders in
//! full.
//!
//! Everything is analytic and measured in fractions of the FULL
//! frame's short side, so the same numbers draw the same flare at fit
//! size, at 1:1 in a sharp slice (the roi_* params map the patch), and
//! in the export.
use std::sync::Arc;

use heeler_graph::Node;

use crate::buffers::{ImageBuf, Value};
use crate::executor::EngineError;
use crate::ops::{image_input, p, to_scene};
use crate::ops_depth::depth_plane;
use crate::ops_retouch::{ParsedStops, Stop};

/// One light of the rig, as the flare reads it. The key light's own
/// fields plus the two this node adds; every field defaults so any
/// saved rig parses.
#[derive(serde::Deserialize)]
struct FlareLight {
    #[serde(default = "d_kind")]
    kind: String,
    #[serde(default = "d_45")]
    azimuth: f32,
    #[serde(default = "d_45")]
    elevation: f32,
    #[serde(default = "d_half")]
    px: f32,
    #[serde(default = "d_half")]
    py: f32,
    #[serde(default = "d_depth", alias = "height")]
    depth: f32,
    #[serde(default = "d_true")]
    on: bool,
    #[serde(default = "d_white")]
    color: String,
    #[serde(default)]
    flare: bool,
    #[serde(default = "d_100")]
    flare_strength: f32,
}
fn d_kind() -> String { "directional".into() }
fn d_45() -> f32 { 45.0 }
fn d_half() -> f32 { 0.5 }
fn d_depth() -> f32 { 50.0 }
fn d_true() -> bool { true }
fn d_white() -> String { "#ffffff".into() }
fn d_100() -> f32 { 100.0 }

fn tint_of(hex: &str) -> [f32; 3] {
    let h = hex.trim_start_matches('#');
    let byte = |i: usize| u8::from_str_radix(h.get(i..i + 2).unwrap_or("ff"), 16).unwrap_or(255) as f32 / 255.0;
    [to_scene(byte(0)), to_scene(byte(2)), to_scene(byte(4))]
}

/// A hue on the wheel as scene-linear rgb, for the ghosts' advancing
/// tints: saturated, so the chain reads as the colored discs a real
/// zoom throws.
fn hue_rgb(deg: f32) -> [f32; 3] {
    let h = deg.rem_euclid(360.0) / 60.0;
    let x = 1.0 - (h % 2.0 - 1.0).abs();
    let (r, g, b) = match h as u32 {
        0 => (1.0, x, 0.0),
        1 => (x, 1.0, 0.0),
        2 => (0.0, 1.0, x),
        3 => (0.0, x, 1.0),
        4 => (x, 0.0, 1.0),
        _ => (1.0, 0.0, x),
    };
    [r, g, b]
}

fn smoothstep(t: f32) -> f32 {
    let t = t.clamp(0.0, 1.0);
    t * t * (3.0 - 2.0 * t)
}

/// Where a light sits, in FULL-frame normalized coordinates, and its
/// depth 0..1 (farness). A point lamp is where it says. A directional
/// light is the sun: it flares from where its direction meets the
/// frame edge, and its elevation is how far PAST the edge the source
/// sits ("sell the effect of faking a Z axis"); it is
/// behind everything, so depth 1.
fn light_position(l: &FlareLight, aspect: f32) -> ([f32; 2], f32) {
    if l.kind == "point" {
        return ([l.px, l.py], (l.depth / 100.0).clamp(0.0, 1.0));
    }
    // Azimuth: 0 lights from the right, 90 from above (the key light's
    // convention), so the source lies in direction (cos, -sin) from the
    // center in a square frame; the aspect stretches x.
    let a = l.azimuth.to_radians();
    let dir = [a.cos() / aspect.max(1e-6), -a.sin()];
    // The step to the frame edge along dir from the center.
    let tx = if dir[0].abs() > 1e-6 { 0.5 / dir[0].abs() } else { f32::INFINITY };
    let ty = if dir[1].abs() > 1e-6 { 0.5 / dir[1].abs() } else { f32::INFINITY };
    let t_edge = tx.min(ty);
    // Just past the edge when low, well beyond it when high: at the
    // default 45 the source sits four tenths of the way past, close
    // enough for the core and rays to reach in.
    let beyond = 1.0 + (l.elevation.clamp(0.0, 90.0) / 90.0) * 0.8;
    let t = t_edge * beyond;
    ([0.5 + dir[0] * t, 0.5 + dir[1] * t], 1.0)
}

/// Deterministic value noise in 0..1 on an integer lattice, bilinear
/// between corners: the streak's breakup ("artifacts of
/// the streak where it's thicker in some places than others, and more
/// dense, not just a noise"). Integer hashing rather than a sin trick,
/// so every platform draws the same structure and renders stay
/// bit-identical.
fn lattice(x: i32, y: i32) -> f32 {
    let mut h = (x as u32).wrapping_mul(0x9E37_79B1) ^ (y as u32).wrapping_mul(0x85EB_CA77);
    h ^= h >> 15;
    h = h.wrapping_mul(0x2C1B_3C6D);
    h ^= h >> 12;
    (h & 0xFFFF) as f32 / 65535.0
}
fn value_noise(x: f32, y: f32) -> f32 {
    let (x0, y0) = (x.floor(), y.floor());
    let (fx, fy) = (x - x0, y - y0);
    let (sx, sy) = (fx * fx * (3.0 - 2.0 * fx), fy * fy * (3.0 - 2.0 * fy));
    let (ix, iy) = (x0 as i32, y0 as i32);
    let a = lattice(ix, iy);
    let b = lattice(ix + 1, iy);
    let c = lattice(ix, iy + 1);
    let d = lattice(ix + 1, iy + 1);
    let top = a + (b - a) * sx;
    let bot = c + (d - c) * sx;
    top + (bot - top) * sy
}

/// The streak's color ribbon: the node's `streak_stops` (the gradient
/// layer's stop list, positions 0..100 from the source to the streak's
/// end), else its single `streak_color`. Sampled in display space like
/// the gradient op, then brought to scene light.
fn streak_ribbon(node: &Node) -> ParsedStops {
    let raw = node.params.get("streak_stops").and_then(|v| v.as_str()).unwrap_or("");
    if !raw.trim().is_empty() {
        if let Ok(mut list) = serde_json::from_str::<Vec<Stop>>(raw) {
            if list.len() >= 2 {
                list.sort_by(|a, b| a.pos.partial_cmp(&b.pos).unwrap_or(std::cmp::Ordering::Equal));
                return ParsedStops::new(&list);
            }
        }
    }
    let color = node.params.get("streak_color").and_then(|v| v.as_str()).unwrap_or("#5aa0ff").to_string();
    ParsedStops::new(&[
        Stop { pos: 0.0, color: color.clone(), alpha: 100.0, mid: 50.0 },
        Stop { pos: 100.0, color, alpha: 100.0, mid: 50.0 },
    ])
}

/// Signed-distance-ish inside test for a regular polygon of `n` sides
/// and apothem `r` centered at the origin, rotated by `rot`: the
/// radius of the polygon in the point's direction, so `dist / radius`
/// is below one inside.
fn polygon_ratio(dx: f32, dy: f32, n: u32, r: f32, rot: f32) -> f32 {
    let dist = (dx * dx + dy * dy).sqrt();
    if r <= 0.0 {
        return f32::INFINITY;
    }
    let sector = std::f32::consts::TAU / n.max(3) as f32;
    let ang = dy.atan2(dx) - rot;
    let local = ang.rem_euclid(sector) - sector / 2.0;
    let radius_here = r / local.cos().max(1e-3);
    dist / radius_here
}

pub(crate) fn flare(node: &Node, inputs: &[(String, Value)]) -> Result<Value, EngineError> {
    let src = image_input(inputs, "in", &node.id)?;
    let intensity = p(&node.params, "intensity", 100.0) / 100.0;
    let mut lights: Vec<FlareLight> = node
        .params
        .get("lights")
        .and_then(|v| v.as_str())
        .and_then(|raw| serde_json::from_str::<Vec<FlareLight>>(raw).ok())
        .unwrap_or_default();
    lights.retain(|l| l.on && l.flare && l.flare_strength > 0.0);
    if lights.is_empty() || intensity <= 0.0 {
        return Ok(Value::Image(src.clone()));
    }
    let (w, h) = (src.width, src.height);
    if w == 0 || h == 0 {
        return Ok(Value::Image(src.clone()));
    }
    // The patch this buffer is of the full frame (the ROI splice sets
    // these); whole frame when unset. Positions are full-frame
    // normalized, sizes are fractions of the full frame's short side.
    let rx = p(&node.params, "roi_x", 0.0);
    let ry = p(&node.params, "roi_y", 0.0);
    let rw = p(&node.params, "roi_w", 1.0).max(1e-4);
    let rh = p(&node.params, "roi_h", 1.0).max(1e-4);
    let full_w = w as f32 / rw;
    let full_h = h as f32 / rh;
    let short = full_w.min(full_h);
    let aspect = full_w / full_h;
    // Full-frame normalized point to this buffer's pixel space.
    let to_px = |n: [f32; 2]| -> [f32; 2] { [(n[0] - rx) * full_w, (n[1] - ry) * full_h] };

    let temp = p(&node.params, "temp", 0.0) / 100.0;
    let size_px = (p(&node.params, "size", 6.0) / 100.0 * short).max(0.5);
    let softness = p(&node.params, "softness", 50.0) / 100.0;
    let rays = p(&node.params, "rays", 0.0).round().max(0.0) as u32;
    let ray_len = (p(&node.params, "ray_length", 30.0) / 100.0 * short).max(1.0);
    let ray_soft = p(&node.params, "ray_softness", 30.0) / 100.0;
    let rotation = p(&node.params, "rotation", 0.0).to_radians();
    let ghosts = p(&node.params, "ghosts", 0.0).round().max(0.0) as u32;
    let ghost_spacing = p(&node.params, "ghost_spacing", 100.0) / 100.0;
    let ghost_size = p(&node.params, "ghost_size", 6.0) / 100.0 * short;
    let blades = p(&node.params, "blades", 7.0).round().clamp(3.0, 12.0) as u32;
    let dispersion = p(&node.params, "dispersion", 30.0) / 100.0;
    let ghost_opacity = p(&node.params, "ghost_opacity", 60.0) / 100.0;
    let anamorphic = p(&node.params, "anamorphic", 0.0) / 100.0;
    // The streak's shape: thickness and reach as fractions of the short
    // side, the taper toward its ends, its angle, and its offset from
    // the source along and across its own axis.
    let streak_size = (p(&node.params, "streak_size", 1.5) / 100.0 * short).max(0.5);
    let streak_len = (p(&node.params, "streak_length", 60.0) / 100.0 * short).max(1.0);
    let streak_taper = p(&node.params, "streak_taper", 30.0) / 100.0;
    let streak_noise = p(&node.params, "streak_noise", 0.0) / 100.0;
    let streak_angle = p(&node.params, "streak_angle", 0.0).to_radians();
    let (streak_sin, streak_cos) = streak_angle.sin_cos();
    let streak_offset = p(&node.params, "streak_offset", 0.0) / 100.0 * short;
    let streak_shift = p(&node.params, "streak_shift", 0.0) / 100.0 * short;
    let ribbon = streak_ribbon(node);
    let veil = p(&node.params, "veil", 20.0) / 100.0;
    let veil_radius = (p(&node.params, "veil_radius", 40.0) / 100.0 * short).max(1.0);
    let veil_depth = p(&node.params, "veil_depth", 0.0) / 100.0;
    let occlusion = p(&node.params, "occlusion", 100.0) / 100.0;
    let occlusion_soft = p(&node.params, "occlusion_soft", 30.0) / 100.0 * 0.5;
    let plane = if occlusion > 0.0 || veil_depth != 0.0 { depth_plane(inputs, w, h) } else { None };
    let centre = to_px([0.5, 0.5]);

    struct Ready {
        pos: [f32; 2],
        tint: [f32; 3],
        gain: f32,
        /// the light's farness 0..1, for the per-pixel cut
        depth: f32,
    }
    let mut ready: Vec<Ready> = Vec::new();
    for l in &lights {
        let (npos, depth) = light_position(l, aspect);
        let pos = to_px(npos);
        // Visibility: the share of the core disc that is nearer to the
        // camera than the light is hidden. Sampled on a grid over the
        // disc, inside the frame only; a light wholly off-frame is
        // never occluded by what is in it.
        let mut vis = 1.0;
        if let (Some(pl), true) = (plane.as_ref(), occlusion > 0.0) {
            let mut seen = 0.0f32;
            let mut n = 0.0f32;
            let steps = 9;
            for j in 0..steps {
                for i in 0..steps {
                    let ox = (i as f32 + 0.5) / steps as f32 * 2.0 - 1.0;
                    let oy = (j as f32 + 0.5) / steps as f32 * 2.0 - 1.0;
                    if ox * ox + oy * oy > 1.0 {
                        continue;
                    }
                    let x = pos[0] + ox * size_px;
                    let y = pos[1] + oy * size_px;
                    if x < 0.0 || y < 0.0 || x >= w as f32 || y >= h as f32 {
                        continue;
                    }
                    let far = pl[y as usize * w + x as usize];
                    // Farther than the light (or as far) is see-through.
                    seen += smoothstep((far - depth + occlusion_soft) / (2.0 * occlusion_soft).max(1e-4));
                    n += 1.0;
                }
            }
            if n > 0.0 {
                let raw = seen / n;
                vis = 1.0 - occlusion * (1.0 - raw);
            }
        }
        let gain = intensity * (l.flare_strength / 100.0) * vis;
        if gain <= 0.0 {
            continue;
        }
        let mut tint = tint_of(&l.color);
        tint[0] *= 1.0 + 0.25 * temp;
        tint[2] *= 1.0 - 0.25 * temp;
        ready.push(Ready { pos, tint, gain, depth });
    }
    if ready.is_empty() {
        return Ok(Value::Image(src.clone()));
    }

    let k_core = 2.0 - softness; // 2: a disc's edge; 1: a haze
    let sector = if rays > 0 { std::f32::consts::TAU / rays as f32 } else { 0.0 };
    let ray_width = if rays > 0 { (ray_soft * sector / 2.0).max(0.02) } else { 1.0 };

    use rayon::prelude::*;
    let mut out = ImageBuf::new(w, h);
    out.data
        .par_chunks_mut(w * 4)
        .zip(src.data.par_chunks(w * 4))
        .enumerate()
        .for_each(|(y, (orow, srow))| {
            let fy = y as f32 + 0.5;
            for x in 0..w {
                let fx = x as f32 + 0.5;
                let i = x * 4;
                let mut add = [0.0f32; 3];
                for l in &ready {
                    let dx = fx - l.pos[0];
                    let dy = fy - l.pos[1];
                    let dist = (dx * dx + dy * dy).sqrt();
                    // Core.
                    let mut v = (-(dist / size_px).powf(k_core)).exp();
                    // Rays: angular gaussians about the star's spokes,
                    // fading out along the length.
                    if rays > 0 && dist > 0.0 {
                        let ang = dy.atan2(dx) - rotation;
                        let local = ang.rem_euclid(sector);
                        let dtheta = local.min(sector - local);
                        let along = (-(dist / ray_len)).exp();
                        v += 0.6 * (-(dtheta / ray_width).powi(2)).exp() * along;
                    }
                    // Anamorphic streak: a ribbon through the light (or
                    // offset from it), turned by its angle, tapering
                    // toward its ends, grained by its artifacts, colored
                    // along its length by the ribbon.
                    let mut streak = 0.0;
                    let mut streak_rgb = [0.0f32; 3];
                    if anamorphic > 0.0 {
                        // Into the streak's own frame.
                        let ax = dx * streak_cos + dy * streak_sin - streak_offset;
                        let ay = -dx * streak_sin + dy * streak_cos - streak_shift;
                        let u = (ax.abs() / streak_len).min(1.0);
                        // Breakup: structure along the streak, not grain.
                        // Two slow noises along its length, one swelling
                        // and thinning the thickness (knots and thin
                        // stretches), one making it denser and sparser.
                        let mut thick_k = 1.0;
                        let mut dense = 1.0;
                        if streak_noise > 0.0 {
                            let along_px = ax / (0.06 * short);
                            let nt = value_noise(along_px, 3.7) * 0.7 + value_noise(along_px * 2.3, 11.1) * 0.3;
                            let nd = value_noise(along_px * 1.6 + 50.0, 7.9) * 0.7 + value_noise(along_px * 4.1 + 50.0, 19.3) * 0.3;
                            thick_k = 1.0 + streak_noise * 1.4 * (nt - 0.5);
                            dense = 1.0 - streak_noise * 0.85 * (1.0 - nd);
                        }
                        let thick = (streak_size * thick_k * (1.0 - streak_taper * u)).max(streak_size * 0.1);
                        let across = (-(ay / thick).powi(2)).exp();
                        // Full to two thirds of the reach, then a smooth
                        // fall to nothing exactly at the end, so the
                        // ribbon's 100 is the streak's visible end.
                        let along = if u < 0.66 { 1.0 } else { 1.0 - smoothstep((u - 0.66) / 0.34) };
                        streak = anamorphic * 0.8 * across * along * dense.max(0.0);
                        if streak > 0.0 {
                            let (rgb, alpha) = ribbon.sample(u);
                            streak *= alpha;
                            streak_rgb = [to_scene(rgb[0]), to_scene(rgb[1]), to_scene(rgb[2])];
                        }
                    }
                    // The foreground cut: this pixel's plane against the
                    // light's depth. Nearer hides the source's direct
                    // image (core, rays, streak) here, by the Occlusion
                    // group's strength, feathered by its softness.
                    if occlusion > 0.0 {
                        if let Some(pl) = plane.as_ref() {
                            let far = pl[y * w + x];
                            let open = smoothstep((far - l.depth + occlusion_soft) / (2.0 * occlusion_soft).max(1e-4));
                            let k = 1.0 - occlusion * (1.0 - open);
                            v *= k;
                            streak *= k;
                        }
                    }
                    // Veil: the wide low glare, weighted by depth if asked.
                    let mut vv = veil * 0.25 * (-(dist / veil_radius).powi(2)).exp();
                    if veil_depth != 0.0 {
                        if let Some(pl) = plane.as_ref() {
                            let far = pl[y * w + x];
                            vv *= (1.0 + veil_depth * (2.0 * far - 1.0)).clamp(0.0, 2.0);
                        }
                    }
                    let base = (v + vv) * l.gain;
                    add[0] += base * l.tint[0] + streak * l.gain * streak_rgb[0];
                    add[1] += base * l.tint[1] + streak * l.gain * streak_rgb[1];
                    add[2] += base * l.tint[2] + streak * l.gain * streak_rgb[2];
                    // Ghosts: aperture images mirrored through the center.
                    for g in 1..=ghosts {
                        let f = g as f32 / ghosts as f32;
                        let cx = centre[0] + f * ghost_spacing * (centre[0] - l.pos[0]);
                        let cy = centre[1] + f * ghost_spacing * (centre[1] - l.pos[1]);
                        let r = ghost_size * (1.0 - 0.6 * f);
                        if r <= 0.0 {
                            continue;
                        }
                        let gx = fx - cx;
                        let gy = fy - cy;
                        if gx * gx + gy * gy > (r * 1.4) * (r * 1.4) {
                            continue;
                        }
                        let hue = hue_rgb(g as f32 * 47.0 + 200.0);
                        let strength = ghost_opacity * 0.35 * (1.0 - 0.5 * f) * l.gain;
                        // Dispersion: the polygon sampled at three sizes,
                        // one per channel, fringes the edge.
                        for c in 0..3 {
                            let scale = 1.0 + dispersion * 0.08 * (1.0 - c as f32);
                            let ratio = polygon_ratio(gx, gy, blades, r * scale, rotation);
                            let inside = 1.0 - smoothstep((ratio - 0.85) / 0.3);
                            let mix = 0.5 * hue[c] + 0.5 * l.tint[c];
                            add[c] += inside * strength * mix;
                        }
                    }
                }
                orow[i] = (srow[i] + add[0]).max(0.0);
                orow[i + 1] = (srow[i + 1] + add[1]).max(0.0);
                orow[i + 2] = (srow[i + 2] + add[2]).max(0.0);
                orow[i + 3] = srow[i + 3];
            }
        });
    Ok(Value::Image(Arc::new(out)))
}

/// Whether a flare node's rig and dials want the depth plane: the
/// desktop's planting rule.
pub fn flare_wants_depth(params: &std::collections::HashMap<String, serde_json::Value>) -> bool {
    let num = |k: &str, d: f64| params.get(k).and_then(|v| v.as_f64()).unwrap_or(d);
    num("occlusion", 100.0) > 0.0 || num("veil_depth", 0.0) != 0.0
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ops::test_util::{make_node, run_on, set_num, set_text};

    fn frame(w: usize, h: usize, v: f32) -> ImageBuf {
        ImageBuf::filled(w, h, [v, v, v, 1.0])
    }
    fn rig(px: f32, py: f32, depth: f32) -> String {
        format!(r##"[{{"kind":"point","px":{px},"py":{py},"depth":{depth},"on":true,"color":"#ffffff","flare":true,"flare_strength":100}}]"##)
    }
    fn added(out: &ImageBuf, base: f32, x: usize, y: usize) -> f32 {
        out.pixel(x, y)[1] - base
    }

    #[test]
    fn no_flaring_light_is_the_identity() {
        let img = frame(32, 24, 0.2);
        let plain = make_node("heeler.flare");
        assert_eq!(run_on(&plain, img.clone()).unwrap().as_image().unwrap().data, img.data);
        let mut off = make_node("heeler.flare");
        set_text(&mut off, "lights", r#"[{"kind":"point","px":0.5,"py":0.5,"on":true,"flare":false}]"#);
        assert_eq!(run_on(&off, img.clone()).unwrap().as_image().unwrap().data, img.data);
        let mut zero = make_node("heeler.flare");
        set_text(&mut zero, "lights", &rig(0.5, 0.5, 50.0));
        set_num(&mut zero, "intensity", 0.0);
        assert_eq!(run_on(&zero, img.clone()).unwrap().as_image().unwrap().data, img.data);
    }

    #[test]
    fn the_core_is_brightest_at_the_light_and_symmetric() {
        let mut node = make_node("heeler.flare");
        set_text(&mut node, "lights", &rig(0.5, 0.5, 100.0));
        set_num(&mut node, "veil", 0.0);
        let out = run_on(&node, frame(64, 64, 0.1)).unwrap();
        let out = out.as_image().unwrap();
        let at = |x: usize, y: usize| added(out, 0.1, x, y);
        let peak = at(32, 32);
        assert!(peak > 0.5, "the core adds light at the light: {peak}");
        assert!(at(32, 32) >= at(36, 32) && at(36, 32) > at(44, 32), "falls off with distance");
        // The light sits on the pixel boundary at 32.0, so the mirror of
        // pixel 32 + k is pixel 31 - k.
        assert!((at(36, 32) - at(27, 32)).abs() < 1e-4 && (at(32, 36) - at(32, 27)).abs() < 1e-4, "symmetric");
        // Added, never taken: nothing goes below the frame.
        assert!(out.data.chunks(4).all(|px| px[0] >= 0.1 - 1e-6));
    }

    #[test]
    fn ghosts_walk_away_from_the_light_through_the_centre() {
        let mut node = make_node("heeler.flare");
        // Light top-left; one ghost at full spacing lands mirrored
        // through the center, bottom-right.
        set_text(&mut node, "lights", &rig(0.25, 0.25, 100.0));
        set_num(&mut node, "veil", 0.0);
        set_num(&mut node, "size", 1.0);
        set_num(&mut node, "ghosts", 1.0);
        set_num(&mut node, "ghost_spacing", 100.0);
        set_num(&mut node, "ghost_size", 8.0);
        set_num(&mut node, "ghost_opacity", 100.0);
        let out = run_on(&node, frame(80, 80, 0.1)).unwrap();
        let out = out.as_image().unwrap();
        let bright = |x: usize, y: usize| out.pixel(x, y).iter().take(3).sum::<f32>() - 0.3;
        assert!(bright(60, 60) > 0.02, "ghost at the mirrored spot: {}", bright(60, 60));
        assert!(bright(60, 20) < 1e-3 && bright(20, 60) < 1e-3, "and nowhere else off the axis");
    }

    #[test]
    fn occlusion_reads_the_plane_around_the_light() {
        let mut node = make_node("heeler.flare");
        set_text(&mut node, "lights", &rig(0.5, 0.5, 50.0));
        set_num(&mut node, "veil", 0.0);
        set_num(&mut node, "occlusion_soft", 0.0);
        let img = frame(48, 48, 0.1);
        let run = |plane: Option<ImageBuf>| -> f32 {
            let mut inputs = vec![("in".to_string(), Value::Image(Arc::new(img.clone())))];
            if let Some(pl) = plane {
                inputs.push(("raster".to_string(), Value::Image(Arc::new(pl))));
            }
            let out = crate::ops::execute(&node, &inputs).unwrap();
            out.as_image().unwrap().pixel(24, 24)[1] - 0.1
        };
        let open = run(None);
        // Everything nearer than the light (farness 0.2 < 0.5): hidden.
        let wall = run(Some(ImageBuf::filled(48, 48, [0.2, 0.2, 0.2, 1.0])));
        // Everything farther (0.9 > 0.5): open.
        let sky = run(Some(ImageBuf::filled(48, 48, [0.9, 0.9, 0.9, 1.0])));
        assert!(open > 0.5, "no plane: full flare {open}");
        assert!(wall < 1e-3, "a wall in front hides the light: {wall}");
        assert!((sky - open).abs() < 1e-4, "sky behind changes nothing: {sky} vs {open}");
        // Half the disc covered, half the light.
        let mut half = ImageBuf::filled(48, 48, [0.9, 0.9, 0.9, 1.0]);
        for y in 0..48 {
            for x in 0..24 {
                half.set_pixel(x, y, [0.2, 0.2, 0.2, 1.0]);
            }
        }
        let h = run(Some(half));
        assert!((h - open / 2.0).abs() < open * 0.15, "half covered, about half: {h} vs {open}");
    }

    /// The foreground cut: a wall nearer than the light over the left
    /// half of the frame. The light stands on the right, fully
    /// visible, so the flare is at full strength there; on the wall's
    /// pixels the glow is gone, not painted over the wall.
    #[test]
    fn a_foreground_object_cuts_the_glow_at_its_silhouette() {
        let mut node = make_node("heeler.flare");
        set_text(&mut node, "lights", &rig(0.75, 0.5, 50.0));
        set_num(&mut node, "size", 25.0);
        set_num(&mut node, "softness", 100.0);
        set_num(&mut node, "veil", 0.0);
        set_num(&mut node, "occlusion_soft", 0.0);
        let img = frame(64, 32, 0.1);
        let mut plane = ImageBuf::filled(64, 32, [0.9, 0.9, 0.9, 1.0]);
        for y in 0..32 {
            for x in 0..32 {
                plane.set_pixel(x, y, [0.2, 0.2, 0.2, 1.0]);
            }
        }
        let render = |pl: Option<ImageBuf>| {
            let mut inputs = vec![("in".to_string(), Value::Image(Arc::new(img.clone())))];
            if let Some(p) = pl {
                inputs.push(("raster".to_string(), Value::Image(Arc::new(p))));
            }
            let out = crate::ops::execute(&node, &inputs).unwrap();
            out.as_image().unwrap().clone()
        };
        let open = render(None);
        let cut = render(Some(plane));
        // The right side (open plane) is unchanged; the left side (the
        // wall) gets no glow, though the haze reaches there unoccluded.
        assert!((cut.pixel(50, 16)[1] - open.pixel(50, 16)[1]).abs() < 1e-4, "open side unchanged");
        assert!(open.pixel(20, 16)[1] - 0.1 > 0.02, "the haze reaches the left when nothing is in the way");
        assert!((cut.pixel(20, 16)[1] - 0.1).abs() < 1e-4, "the wall hides it: {}", cut.pixel(20, 16)[1]);
    }

    #[test]
    fn a_directional_light_flares_from_the_edge_its_azimuth_names() {
        let mut node = make_node("heeler.flare");
        // From the right, low: the source sits just past the right
        // edge, so the right edge is lit and the left is not.
        set_text(&mut node, "lights", r#"[{"kind":"directional","azimuth":0,"elevation":5,"on":true,"flare":true}]"#);
        set_num(&mut node, "size", 20.0);
        set_num(&mut node, "veil", 0.0);
        let out = run_on(&node, frame(64, 32, 0.1)).unwrap();
        let out = out.as_image().unwrap();
        assert!(added(out, 0.1, 62, 16) > added(out, 0.1, 2, 16) + 0.05, "right edge brighter than left");
    }

    #[test]
    fn a_patch_matches_the_whole_frame_and_scale_is_by_the_short_side() {
        let setup = || {
            let mut node = make_node("heeler.flare");
            set_text(&mut node, "lights", &rig(0.3, 0.4, 100.0));
            set_num(&mut node, "rays", 6.0);
            set_num(&mut node, "ghosts", 3.0);
            node
        };
        let node = setup();
        let whole = run_on(&node, frame(80, 60, 0.1)).unwrap();
        let whole = whole.as_image().unwrap().clone();
        // The bottom-right quarter as a patch.
        let mut patch_node = setup();
        for (k, v) in [("roi_x", 0.5), ("roi_y", 0.5), ("roi_w", 0.5), ("roi_h", 0.5)] {
            set_num(&mut patch_node, k, v);
        }
        let patch = run_on(&patch_node, frame(40, 30, 0.1)).unwrap();
        let patch = patch.as_image().unwrap();
        for y in 0..30 {
            for x in 0..40 {
                let a = whole.pixel(x + 40, y + 30);
                let b = patch.pixel(x, y);
                assert!((a[0] - b[0]).abs() < 1e-4, "patch drifted at {x},{y}: {a:?} vs {b:?}");
            }
        }
        // Twice the pixels, the same picture at half resolution.
        let big = run_on(&node, frame(160, 120, 0.1)).unwrap();
        let big = big.as_image().unwrap();
        assert!((big.pixel(48, 64)[1] - whole.pixel(24, 32)[1]).abs() < 0.02);
    }

    /// The streak: colored by its ribbon from the source outward, turned
    /// by its angle, and moved by its offset.
    #[test]
    fn the_streak_wears_its_ribbon_turns_and_moves() {
        let base = || {
            let mut node = make_node("heeler.flare");
            set_text(&mut node, "lights", &rig(0.5, 0.5, 100.0));
            set_num(&mut node, "size", 0.5);
            set_num(&mut node, "softness", 0.0);
            set_num(&mut node, "veil", 0.0);
            set_num(&mut node, "anamorphic", 100.0);
            set_num(&mut node, "streak_size", 3.0);
            set_num(&mut node, "streak_length", 45.0);
            set_num(&mut node, "streak_taper", 0.0);
            node
        };
        // Red at the source, blue at the end.
        let mut node = base();
        set_text(&mut node, "streak_stops", r##"[{"pos":0,"color":"#ff0000","alpha":100,"mid":50},{"pos":100,"color":"#0000ff","alpha":100,"mid":50}]"##);
        let out = run_on(&node, frame(100, 50, 0.0)).unwrap();
        let out = out.as_image().unwrap();
        let near = out.pixel(54, 25);
        let far = out.pixel(70, 25);
        assert!(near[0] > near[2] * 2.0, "near the source the streak is red: {near:?}");
        assert!(far[2] > far[0] * 2.0, "toward the end it is blue: {far:?}");
        // Off the streak's line there is nothing (the core is a dot).
        assert!(out.pixel(70, 40).iter().take(3).sum::<f32>() < 1e-3);
        // Turned to vertical, the light lands above and below instead.
        let mut vert = base();
        set_num(&mut vert, "streak_angle", 90.0);
        let v = run_on(&vert, frame(100, 100, 0.0)).unwrap();
        let v = v.as_image().unwrap();
        assert!(v.pixel(50, 70)[2] > 0.05 && v.pixel(70, 50)[2] < 1e-3, "vertical streak");
        // Shifted across, the line moves with it.
        let mut shifted = base();
        set_num(&mut shifted, "streak_shift", 20.0);
        let sh = run_on(&shifted, frame(100, 50, 0.0)).unwrap();
        let sh = sh.as_image().unwrap();
        assert!(sh.pixel(70, 35)[2] > 0.05 && sh.pixel(70, 25)[2] < 1e-3, "shifted streak");
        // Tapered, the end is thinner than the middle.
        let mut tapered = base();
        set_num(&mut tapered, "streak_taper", 100.0);
        let t = run_on(&tapered, frame(100, 50, 0.0)).unwrap();
        let t = t.as_image().unwrap();
        assert!(t.pixel(56, 27)[2] > t.pixel(85, 27)[2] * 3.0, "taper narrows the end");
        // The reach is the visible end: full until two thirds, nothing past it.
        let full = run_on(&base(), frame(100, 50, 0.0)).unwrap();
        let full = full.as_image().unwrap();
        // The reach here is 45% of the short side, 22 px: full at 5 and
        // 12 px out, nothing at 26.
        assert!((full.pixel(55, 25)[2] - full.pixel(62, 25)[2]).abs() < 1e-3, "held full to two thirds of the reach");
        assert!(full.pixel(76, 25)[2] < 1e-3, "nothing past the reach");
        // Breakup varies the streak's thickness and density along its
        // length, never below zero, and leaves a clean streak alone at 0.
        let mut broken = base();
        set_num(&mut broken, "streak_noise", 100.0);
        set_num(&mut broken, "streak_length", 90.0);
        let n = run_on(&broken, frame(200, 60, 0.0)).unwrap();
        let n = n.as_image().unwrap();
        // Thickness: how far from the line the streak still reads, per column.
        let width_at = |x: usize| (0..30).filter(|d| n.pixel(x, 30 + d)[2] > 0.02).count();
        // Inside the held-full stretch (the reach is 54 px here, full to
        // 36 px out), so the fall at the end is not mistaken for breakup.
        let widths: Vec<usize> = (103..134).step_by(3).map(width_at).collect();
        let (wmin, wmax) = (*widths.iter().min().unwrap(), *widths.iter().max().unwrap());
        assert!(wmax >= wmin + 2, "thickness should swell and thin: {widths:?}");
        let row: Vec<f32> = (103..134).map(|x| n.pixel(x, 30)[2]).collect();
        let (mn, mx) = row.iter().fold((f32::MAX, f32::MIN), |(a, b), v| (a.min(*v), b.max(*v)));
        assert!(mx > mn * 1.3 && mn >= 0.0, "density modulates: {mn} .. {mx}");
        let clean = run_on(&{ let mut c = base(); set_num(&mut c, "streak_length", 90.0); c }, frame(200, 60, 0.0)).unwrap();
        let clean = clean.as_image().unwrap();
        let cw: Vec<usize> = (103..134).step_by(3).map(|x| (0..30).filter(|d| clean.pixel(x, 30 + d)[2] > 0.02).count()).collect();
        assert!(cw.iter().max().unwrap() - cw.iter().min().unwrap() <= 1, "a clean streak keeps its thickness: {cw:?}");
    }

    #[test]
    fn renders_are_deterministic() {
        let mut node = make_node("heeler.flare");
        set_text(&mut node, "lights", &rig(0.6, 0.3, 80.0));
        set_num(&mut node, "rays", 14.0);
        set_num(&mut node, "ghosts", 6.0);
        set_num(&mut node, "anamorphic", 50.0);
        set_num(&mut node, "streak_noise", 60.0);
        let a = run_on(&node, frame(50, 40, 0.2)).unwrap();
        let b = run_on(&node, frame(50, 40, 0.2)).unwrap();
        assert_eq!(a.as_image().unwrap().data, b.as_image().unwrap().data);
    }
}
