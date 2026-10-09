//! The depth tools: fog, key light, and depth of field, each shaped by
//! the photograph's FARNESS plane (0 near, 1 far; Depth Anything V2
//! Small, computed desktop-side, injected by the executor the way the
//! smart-mask rasters are). Relative depth is all any of them need:
//! fog thickens with farness, the key light shades a heightfield, and
//! depth of field blurs away from a focal plane.
//!
//! Every op here is a PERFECT passthrough at neutral params and
//! without its raster, so a machine that never computed depth renders
//! the photograph plainly instead of erroring.

use std::sync::Arc;

use heeler_graph::Node;

use crate::buffers::{ImageBuf, Value};
use crate::executor::EngineError;
use crate::ops::{hue_rgb, image_input, p, p_bool, to_scene};
use crate::ops_detail::gaussian_blur_wide;

/// The injected farness plane, resampled to the render size. Persisted
/// as a gray image; R carries the value. Since 26.3 Phase 10.3 the
/// plane arrives as a Mask value on the wired `depth` input every depth
/// consumer declares; an empty mask (a wire whose plane was never
/// planted) reads as no plane at all. Black & White, not on the
/// automatic wiring list, still reads its planted raster as an
/// Image.
pub(crate) fn plane_from(
    inputs: &[(String, Value)],
    port_name: &str,
    w: usize,
    h: usize,
) -> Option<Vec<f32>> {
    plane_in_window(inputs, port_name, w, h, None)
}

/// The plane a whole-frame consumer reads under a 1:1 slice. The Depth
/// Map sits on the image chain, below the slice's ROI crop, so in a
/// sharp slice its plane is the PATCH's; a mask measured on the whole
/// frame (a layer's range or brush mask reads the frame ahead of the
/// cut) would stretch that patch over the whole frame. The desktop
/// hands such a node the slice's rect as `depth_roi_x/y/w/h`
/// (2026-09-29, the lemur that stretched under a mask view), and the
/// plane lands on exactly the frame pixels the slice cuts, the same
/// window crop_rotate and mask_crop take. Outside the window the edge
/// values run on; the slice's mask crop discards those pixels.
pub(crate) fn plane_for_node(
    node: &Node,
    inputs: &[(String, Value)],
    port_name: &str,
    w: usize,
    h: usize,
) -> Option<Vec<f32>> {
    let window = node.params.contains_key("depth_roi_w").then(|| {
        let (pw, ph, x0, y0) = crate::frame_window(w, h, [
            p(&node.params, "depth_roi_x", 0.0),
            p(&node.params, "depth_roi_y", 0.0),
            p(&node.params, "depth_roi_w", 1.0),
            p(&node.params, "depth_roi_h", 1.0),
        ]);
        (x0 as isize, y0 as isize, pw, ph)
    });
    // A mask rendered over the frame and a margin past it (ops_masks.rs
    // beyond_render): the plane lies on the frame's pixels and holds at
    // its own edge past them.
    let frame = crate::ops_masks::FrameWindow::from_params(&node.params, w, h);
    let window = if frame.is_whole(w, h) { window } else { Some((-frame.x0, -frame.y0, frame.full_w, frame.full_h)) };
    plane_in_window(inputs, port_name, w, h, window)
}

fn plane_in_window(
    inputs: &[(String, Value)],
    port_name: &str,
    w: usize,
    h: usize,
    window: Option<(isize, isize, usize, usize)>,
) -> Option<Vec<f32>> {
    let (_, v) = inputs
        .iter()
        .find(|(port, _): &&(String, Value)| port == port_name)?;
    let (rw, rh, sample): (usize, usize, Box<dyn Fn(usize) -> f32 + Sync>) = match v {
        Value::Image(r) => (r.width, r.height, Box::new(move |i: usize| r.data[i * 4])),
        Value::Mask(m) => (m.width, m.height, Box::new(move |i: usize| m.data[i])),
    };
    if rw == 0 || rh == 0 {
        return None;
    }
    // The window of this buffer the plane covers, in pixels: the whole
    // buffer unless the caller says otherwise (plane_for_node).
    let (wx, wy, ww, wh) = window.unwrap_or((0, 0, w, h));
    let (ww, wh) = (ww.max(1) as f32, wh.max(1) as f32);
    let mut out = vec![0.0f32; w * h];
    use rayon::prelude::*;
    // PERF: the resample ran serially. Rows are independent, so it now
    // parallelizes over them; each output pixel still lerps the same
    // four taps in the same order (x then y), so bits are unchanged.
    out.par_chunks_mut(w).enumerate().for_each(|(y, row)| {
        let sy = ((y as f32 - wy as f32 + 0.5) * rh as f32 / wh - 0.5).clamp(0.0, (rh - 1) as f32);
        let (y0, fy) = (sy.floor() as usize, sy.fract());
        let y1 = (y0 + 1).min(rh - 1);
        for x in 0..w {
            let sx = ((x as f32 - wx as f32 + 0.5) * rw as f32 / ww - 0.5).clamp(0.0, (rw - 1) as f32);
            let (x0, fx) = (sx.floor() as usize, sx.fract());
            let x1 = (x0 + 1).min(rw - 1);
            let at = |px: usize, py: usize| sample(py * rw + px);
            let top = at(x0, y0) + (at(x1, y0) - at(x0, y0)) * fx;
            let bot = at(x0, y1) + (at(x1, y1) - at(x0, y1)) * fx;
            row[x] = (top + (bot - top) * fy).clamp(0.0, 1.0);
        }
    });
    Some(out)
}

/// The plane a depth consumer drinks (26.3 Phase 10.3): the wired
/// `depth` input. The `raster` fallback serves the op-level callers
/// that hand the plane over directly; the desktop no longer plants a
/// raster for any of these nodes (the slot is removed), only Black &
/// White still plants one and it reads it through plane_from itself.
pub(crate) fn depth_plane(inputs: &[(String, Value)], w: usize, h: usize) -> Option<Vec<f32>> {
    plane_from(inputs, "depth", w, h).or_else(|| plane_from(inputs, "raster", w, h))
}

/// Deterministic fractal value noise in [0, 1]: three octaves of
/// hashed lattice noise, bilinear-smoothed. The fog's texture (real
/// fog is never a uniform veil) - cheap, tileless, and stable across
/// renders because the hash owns all the randomness.
fn fractal_noise(x: f32, y: f32) -> f32 {
    fn hash(ix: i64, iy: i64) -> f32 {
        let mut h = (ix.wrapping_mul(374761393)).wrapping_add(iy.wrapping_mul(668265263)) as u64;
        h = (h ^ (h >> 13)).wrapping_mul(1274126177);
        ((h ^ (h >> 16)) & 0xffff) as f32 / 65535.0
    }
    fn value(x: f32, y: f32) -> f32 {
        let (ix, iy) = (x.floor() as i64, y.floor() as i64);
        let (fx, fy) = (x - x.floor(), y - y.floor());
        let (sx, sy) = (fx * fx * (3.0 - 2.0 * fx), fy * fy * (3.0 - 2.0 * fy));
        let top = hash(ix, iy) + (hash(ix + 1, iy) - hash(ix, iy)) * sx;
        let bot = hash(ix, iy + 1) + (hash(ix + 1, iy + 1) - hash(ix, iy + 1)) * sx;
        top + (bot - top) * sy
    }
    let mut n = 0.0;
    let mut amp = 0.5;
    let mut freq = 1.0;
    for _ in 0..3 {
        n += value(x * freq, y * freq) * amp;
        amp *= 0.5;
        freq *= 2.1;
    }
    n / 0.875
}

fn luma(px: &[f32]) -> f32 {
    0.2126 * px[0] + 0.7152 * px[1] + 0.0722 * px[2]
}

/// The buffer's rect in frame fractions, handed down by the desktop's
/// inject_roi for a 1:1 sharp slice (the whole frame by default), and
/// the FRAME's size in this buffer's pixels. Everything a depth op
/// sizes by the picture (relief, a lamp's reach and its depth axis,
/// the smoothing radius, the fog's texture) is measured against the
/// frame, so a slice renders exactly the crop of the whole
/// (2026-09-13: the artifacts changed as he zoomed).
struct Frame {
    roi: [f32; 4],
    w: f32,
    h: f32,
    short: f32,
}

fn frame_of(node: &Node, w: usize, h: usize) -> Frame {
    let roi = [
        p(&node.params, "roi_x", 0.0),
        p(&node.params, "roi_y", 0.0),
        p(&node.params, "roi_w", 1.0).max(1e-4),
        p(&node.params, "roi_h", 1.0).max(1e-4),
    ];
    let (fw, fh) = (w as f32 / roi[2], h as f32 / roi[3]);
    // The true frame dims are integers: the buffer IS the rect's
    // snapped pixel count, so the division comes back to the frame's
    // integer size. f32 can land it a hair off (630 / f32(630 / 1225)
    // gives 1224.99988), and on a short side whose 0.02 share sits on
    // a rounding boundary the wobble flips the lamp's cell grid and
    // the slice no longer matches the whole render (R2 of the fourth
    // pre-merge review). Snap within a few ULP; a genuinely
    // fractional size keeps its fraction.
    let (fw, fh) = (snap_frame(fw), snap_frame(fh));
    Frame { roi, w: fw, h: fh, short: fw.min(fh) }
}

/// A frame size reconstructed from a buffer and its rect (w / roi_w)
/// snapped back to the integer it was, within a few ULP; a genuinely
/// fractional size keeps its fraction. Shared by every reconstruction
/// in this file, so DoF's disc and swirl center read the same frame
/// Depth Lighting does.
pub(crate) fn snap_frame(v: f32) -> f32 {
    let r = v.round();
    if (v - r).abs() <= v.abs() * 1e-5 + 1e-3 { r } else { v }
}

/// Depth Lighting borrows slopes and fitted gains from outside the
/// visible patch. The desktop keeps that margin in a sharp slice.
/// The chain, in cells: the fit reads the rolled tilt within a
/// radius; the foot roll reads the tilt two radii away (the
/// background's own slope past the foot); the tilt reads its
/// neighbor cell; and the smoothed field reads the cell medians
/// within a radius again. Four radii and a cell, one more for the
/// cell grid's alignment to the frame, then the full-size median's
/// window and the bilinear tap that reads the cell center past a
/// pixel's own. The count was two radii and five cells, which held
/// on the short side of the fixtures and came up four pixels short
/// on a 288 pixel side once the long side's margin was counted in
/// pixels too (R1 of the third pre-merge review); the review's own
/// finding was the bilinear tap. Four radii and two cells measured
/// exact at six sizes; the fourth review's static trace of the chain
/// counts one cell more, so the count is the trace's, four radii and
/// three cells, proven rather than measured, for one cell of margin.
pub fn key_light_reach(short: f32) -> f32 {
    let short = short.max(1.0);
    let full = (0.02 * short).round().max(2.0);
    let scale = (full / 6.0).ceil().max(1.0);
    let radius = (full / scale).round().max(2.0);
    let median = (2.0 * short / 1365.0).round().clamp(2.0, 6.0);
    ((4.0 * radius + 3.0) * scale + median + 1.0) / short
}

/// The measured contract's cliff: an absolute jump of more than this
/// much of the scene's depth between neighbors is a cliff, not a slope
/// (the model path's threshold before it is spread over the smoothing
/// radius). Normals from Depth starts from the same number.
pub(crate) const MEASURED_CLIFF: f32 = 0.15;

/// The slope of `field` at pixel `i` along x or y, in field units per
/// pixel, ONE-SIDED AT A CLIFF: a neighbor across a jump larger than
/// `cliff`, or off the frame, lends no difference, so each surface keeps
/// its own slope to its last pixel and a silhouette stays one pixel
/// wide instead of smearing the jump into a ramp; with neither side
/// usable the pixel is flat. Depth Lighting's measured contract and
/// Normals from Depth both take their slope from here.
pub(crate) fn one_sided_slope(field: &[f32], w: usize, h: usize, i: usize, along_x: bool, cliff: f32) -> f32 {
    let (x, y) = (i % w, i / w);
    let b = field[i];
    let (a, c) = if along_x {
        ((x > 0).then(|| field[i - 1]), (x + 1 < w).then(|| field[i + 1]))
    } else {
        ((y > 0).then(|| field[i - w]), (y + 1 < h).then(|| field[i + w]))
    };
    let side = |n: Option<f32>, sign: f32| n.map(|n| (n - b) * sign).filter(|d| d.abs() <= cliff);
    match (side(a, -1.0), side(c, 1.0)) {
        (Some(dl), Some(dr)) => 0.5 * (dl + dr),
        (Some(d), None) | (None, Some(d)) => d,
        (None, None) => 0.0,
    }
}

/// A depth reader's own Levels on the nearness it is handed
/// (2026-09-13: "the same levels control that adjustment layers have
/// when Depth mask is turned on", on Fog and Depth Lighting): the same
/// map the masks apply in depth_weight_mask. None at identity, so the
/// reader can skip the pass.
pub(crate) fn levels_of(node: &Node) -> Option<DepthLevels> {
    let l = DepthLevels {
        black: p(&node.params, "depth_black", 0.0),
        white: p(&node.params, "depth_white", 1.0),
        gamma: p(&node.params, "depth_gamma", 1.0).max(0.1),
        // The falloffs, as Levels has them (2026-09-13: "a fall off handle
        // to smooth the transition"): a straight ramp cut through the
        // plane's soft edge draws a matte line; the knee rolls into the clip
        // instead.
        soft_b: p(&node.params, "depth_black_soft", 0.0) / 100.0 * 0.25,
        soft_w: p(&node.params, "depth_white_soft", 0.0) / 100.0 * 0.25,
    };
    if l.black == 0.0 && l.white == 1.0 && l.gamma == 1.0 && l.soft_b == 0.0 && l.soft_w == 0.0 {
        None
    } else {
        Some(l)
    }
}

/// The depth Levels: Black, White, Gamma and the two knees, on the
/// normalized axis, exactly as the Levels section's.
#[derive(Clone, Copy)]
pub struct DepthLevels {
    pub black: f32,
    pub white: f32,
    pub gamma: f32,
    pub soft_b: f32,
    pub soft_w: f32,
}

/// The soft clip: a quadratic knee half k wide each side of the point.
pub(crate) fn knee_low(n: f32, k: f32) -> f32 {
    if k <= 0.0 || n >= k {
        n
    } else if n <= -k {
        0.0
    } else {
        (n + k) * (n + k) / (4.0 * k)
    }
}

/// Nearness through the Levels: below Black nothing, above White the
/// full value, Gamma bending the depths between, the knees rolling
/// into either end.
pub fn plane_levels(levels: Option<DepthLevels>, near: f32) -> f32 {
    match levels {
        None => near,
        Some(l) => {
            let mut n = (near - l.black) / (l.white - l.black).max(1e-6);
            n = knee_low(n, l.soft_b);
            n = 1.0 - knee_low(1.0 - n, l.soft_w);
            n.clamp(0.0, 1.0).powf(1.0 / l.gamma)
        }
    }
}

/// Atmosphere by farness: mix toward a fog color with 1-exp falloff,
/// optional far desaturation (aerial perspective).
pub(crate) fn fog(node: &Node, inputs: &[(String, Value)]) -> Result<Value, EngineError> {
    let src = image_input(inputs, "in", &node.id)?;
    let density = p(&node.params, "density", 0.0) / 100.0;
    if density <= 0.0 {
        return Ok(Value::Image(src.clone()));
    }
    let Some(far) = depth_plane(inputs, src.width, src.height) else {
        return Ok(Value::Image(src.clone()));
    };
    // The section's own Levels on the plane, ahead of Start and
    // Falloff: below Black no fog, above White the thickest.
    let far: Vec<f32> = match levels_of(node) {
        Some(levels) => far.iter().map(|f| 1.0 - plane_levels(Some(levels), 1.0 - f.clamp(0.0, 1.0))).collect(),
        None => far,
    };
    let start = p(&node.params, "start", 0.0) / 100.0;
    // Falloff shapes how the fog arrives ("it needs a
    // falloff so the effect tapers off better"): a gamma on the farness
    // before the 1-exp curve, log-mapped so 50 is a straight ramp, low
    // values front-load the fog, high values hold it off then let it
    // roll in late.
    let falloff = p(&node.params, "falloff", 50.0);
    let gamma = 10.0f32.powf((falloff - 50.0) / 50.0);
    let hue = p(&node.params, "fog_hue", 220.0);
    let sat = p(&node.params, "fog_sat", 10.0) / 100.0;
    let desat = p(&node.params, "desat", 0.0) / 100.0;
    // Texture ("Fog could use texture, too"): fractal noise
    // modulating the fog's thickness. Size sets the wavelength (big
    // drifts down to fine wisps) and Shift walks the noise field so two
    // textured fogs never have to look the same ("so not all
    // textured fog will look the same").
    let texture = p(&node.params, "texture", 0.0) / 100.0;
    let tex_size = p(&node.params, "texture_size", 30.0) / 100.0;
    let tex_shift = p(&node.params, "texture_shift", 0.0);
    let frame = frame_of(node, src.width, src.height);
    let wavelength = (frame.short / (1.5 + tex_size * 10.0)).max(1.0);
    // The noise field lives in frame pixels, so a slice's texture is
    // the whole frame's texture, cut.
    let (shift_x, shift_y) = (tex_shift * 7.77 + frame.roi[0] * frame.w / wavelength, tex_shift * 3.33 + frame.roi[1] * frame.h / wavelength);
    // The veil's own brightness ("fog should be able to
    // darken too... that multiplying of light glow for night shots
    // doesn't look good"): high is the daylight veil, low is night haze
    // and smoke, which DARKENS what it covers.
    let level = (p(&node.params, "fog_level", 72.0) / 100.0).clamp(0.02, 0.98);
    let base = to_scene(level);
    let tint = hue_rgb(hue);
    let fog_col = [
        base * (1.0 - sat + sat * tint[0]),
        base * (1.0 - sat + sat * tint[1]),
        base * (1.0 - sat + sat * tint[2]),
    ];
    let mut out = ImageBuf::new(src.width, src.height);
    // PERF: the veil ran serially over the frame. It now parallelizes
    // over pixel chunks; each pixel's math (the gamma powf, the exp
    // falloff, the texture noise, the desat and veil mixes) reads only
    // its own inputs, so every pixel computes the very same sequence of
    // operations as the serial loop, alpha copied through included.
    use rayon::prelude::*;
    out.data
        .par_chunks_mut(4)
        .zip(src.data.par_chunks(4))
        .enumerate()
        .for_each(|(i, (o, px))| {
            let x = ((far[i] - start) / (1.0 - start).max(1e-3)).clamp(0.0, 1.0);
            let mut f = 1.0 - (-3.0 * density * x.powf(gamma)).exp();
            if texture > 0.0 {
                let (px_x, px_y) = ((i % src.width) as f32, (i / src.width) as f32);
                let n = fractal_noise(px_x / wavelength + shift_x, px_y / wavelength + shift_y);
                f = (f * (1.0 + texture * (n * 2.0 - 1.0) * 0.85)).clamp(0.0, 1.0);
            }
            let y = luma(px);
            for c in 0..3 {
                // Aerial perspective first (the far scene loses its own
                // color), then the fog lays over.
                let v = px[c] + (y - px[c]) * (desat * x);
                o[c] = v + (fog_col[c] - v) * f;
            }
            o[3] = px[3];
        });
    Ok(Value::Image(Arc::new(out)))
}

/// One synthetic light. Two kinds ("Light should have a type:
/// point and directional"):
/// - "directional": a sun - azimuth/elevation give the direction, the
/// target (tx, ty) is the gizmo's anchor and the direction's origin;
/// `sun_depth` is the plane it lands hardest on and `sun_reach` how
/// far it carries along depth from there;
/// - "point": a lamp IN the scene at (px, py), `height` above the
/// heightfield, its push fading with `range`.
///
/// Strength is signed either way: negative lights emit dark (the
/// owner, from a node-based color grader).
#[derive(serde::Deserialize)]
struct KeyLightSpec {
    #[serde(default = "default_kind")]
    kind: String,
    #[serde(default = "default_azimuth")]
    azimuth: f32,
    #[serde(default = "default_elevation")]
    elevation: f32,
    /// The light's strength on the scale saved before 2026-10-08,
    /// -200 to 200 (POWER for the scale since).
    #[serde(default)]
    strength: f32,
    /// The light's strength, -100 to 100 (2026-10-08: "it goes to
    /// 200 which is odd (vs 100) and seems arbitrary... Also increase
    /// the calculated strength by 50%"). 100 is three times the light,
    /// where the old scale's 200 was twice it. A light saved before it
    /// carries `strength` alone and is read at half its number: the
    /// same place on the slider, 50% stronger, as the owner chose.
    #[serde(default)]
    power: Option<f32>,
    #[serde(default = "default_half")]
    px: f32,
    #[serde(default = "default_half")]
    py: f32,
    /// The lamp's place along the NEAR-FAR axis: 0 sits at the nearest
    /// thing in frame, 100 at the farthest. ("it seems
    /// that height is actually depth" - he was right; the old name
    /// rides as an alias for rigs saved under it.)
    #[serde(default = "default_height", alias = "height")]
    depth: f32,
    #[serde(default = "default_range")]
    range: f32,
    /// A directional light's own place along the NEAR-FAR axis
    /// (2026-10-03: "We added a depth slider for point light but not
    /// directional. I think this was an oversight"): the plane it lands
    /// hardest on, 0 the nearest thing in frame, 100 the farthest. A sun
    /// has no position, but it always had a depth behavior nobody could
    /// set: hardest on the near relief, a third of that at the far plane.
    /// That is 0 here, the default. Its own field, not `depth`: every
    /// saved directional light carries the lamp's default `depth` of 30,
    /// which must go on meaning nothing to it.
    #[serde(default)]
    sun_depth: f32,
    /// How far a directional light carries along depth from its
    /// plane: 50 is the falloff it always had, 100 lights every plane
    /// evenly (a true sun), and toward 0 it keeps to its own plane.
    #[serde(default = "default_range")]
    sun_reach: f32,
    /// Off keeps the light's settings without its push
    /// ("I should be able to toggle a light on and off").
    #[serde(default = "default_on")]
    on: bool,
    /// The light's color as a display hex ("We need to be
    /// able to color the lights"). White is the neutral it always
    /// was.
    #[serde(default = "default_color")]
    color: String,
}
fn default_on() -> bool {
    true
}
fn default_color() -> String {
    "#ffffff".into()
}

/// A display hex color as a scene-linear tint, white = [1,1,1].
fn tint_of(hex: &str) -> [f32; 3] {
    let h = hex.trim_start_matches('#');
    let byte = |i: usize| {
        u8::from_str_radix(h.get(i..i + 2).unwrap_or("ff"), 16).unwrap_or(255) as f32 / 255.0
    };
    [to_scene(byte(0)), to_scene(byte(2)), to_scene(byte(4))]
}

/// One light's push, signed, through its color. A light that emits
/// adds its tint's share to each channel. A dark light casts a SHADOW
/// of its color: the tint's own channel keeps its light and the others
/// lose theirs, so a red dark light leaves a red shadow. Multiplying
/// the negative push by the tint took the red away instead and left
/// cyan, the complement (2026-09-13: "coloring a light in depth
/// lighting when the Strength is a negative value seems to invert the
/// hue"). The shadow's per-channel share is one minus the tint, lifted
/// by the tint's darkest channel so a white dark light still darkens
/// every channel alike. A pale tint makes a nearly neutral shadow; its
/// small channel differences give that shadow its hue.
fn push_gain(gain: &mut [f32; 3], dev: f32, tint: &[f32; 3]) {
    if dev >= 0.0 {
        for c in 0..3 {
            gain[c] *= 1.0 + dev * tint[c];
        }
    } else {
        let floor = tint[0].min(tint[1]).min(tint[2]);
        for c in 0..3 {
            // Roll off EACH light before composing it. Two negative
            // factors otherwise multiply into a bright positive one.
            gain[c] *= soft_gain(1.0 + dev * (1.0 - tint[c] + floor));
        }
    }
}

fn soft_gain(g: f32) -> f32 {
    if g >= 0.2 { g } else { 0.2 * ((g - 0.2) / 0.2).exp() }
}

/// A fit may only borrow gains its window actually saw. A narrow
/// height range can fit a steep line that becomes an enormous light
/// when evaluated on the other side of a silhouette.
fn fitted_gain(a: f32, b: f32, height: f32, low: f32, high: f32) -> f32 {
    (a + b * height).clamp(low, high)
}
fn default_kind() -> String {
    "directional".into()
}

/// How much a directional light loses across the whole depth range at
/// its default reach: full on the near relief, 0.35 at the far plane.
/// The emphasis `0.35 + 0.65 * height` every directional light has
/// had, as the slope of a line from its plane.
const SUN_FALL: f32 = 0.65;

/// A directional light's depth falloff from its dials, as (the height
/// it lands hardest on, how steep the fall is against the default), or
/// None at the defaults (depth 0, reach 50), where the caller keeps
/// the original expression so no saved photograph moves by a bit.
///
/// Reach 50 is the default slope; from there to 100 the slope eases to
/// nothing, every plane lit alike; from there down to 0 it steepens
/// eightfold, by which point the light is gone a fifth of the depth
/// range from its plane.
fn sun_plane(depth: f32, reach: f32) -> Option<(f32, f32)> {
    let depth = if depth.is_finite() { depth.clamp(0.0, 100.0) } else { 0.0 };
    let reach = if reach.is_finite() { reach.clamp(0.0, 100.0) } else { 50.0 };
    if depth == 0.0 && reach == 50.0 {
        return None;
    }
    let steep = if reach >= 50.0 { (100.0 - reach) / 50.0 } else { 8f32.powf((50.0 - reach) / 50.0) };
    Some((1.0 - depth / 100.0, steep))
}
fn default_azimuth() -> f32 {
    45.0
}
fn default_elevation() -> f32 {
    45.0
}
fn default_half() -> f32 {
    0.5
}
fn default_height() -> f32 {
    50.0
}
fn default_range() -> f32 {
    50.0
}

/// Positioned lights over the 2.5D heightfield: normals from the
/// nearness gradient, shading per light, anchored so flat ground
/// keeps its exposure. The "lights" JSON is the rig when it has any
/// lights; the node's own azimuth/elevation/strength params are the
/// LEGACY single directional and only speak when the JSON is empty,
/// so old graphs render unchanged.
/// A point of a light's power, as a multiple of the light: 100 is three
/// times it (POWER on KeyLightSpec).
const POWER_SCALE: f32 = 3.0 / 100.0;

pub(crate) fn key_light(
    node: &Node,
    inputs: &[(String, Value)],
) -> Result<Value, EngineError> {
    let src = image_input(inputs, "in", &node.id)?;
    let mut lights: Vec<KeyLightSpec> = node
        .params
        .get("lights")
        .and_then(|v| v.as_str())
        .and_then(|raw| serde_json::from_str::<Vec<KeyLightSpec>>(raw).ok())
        .unwrap_or_default();
    if lights.is_empty() {
        lights.push(KeyLightSpec {
            kind: "directional".into(),
            azimuth: p(&node.params, "azimuth", 45.0),
            elevation: p(&node.params, "elevation", 45.0),
            strength: p(&node.params, "strength", 0.0),
            power: None,
            px: 0.5,
            py: 0.5,
            depth: 50.0,
            range: 50.0,
            sun_depth: 0.0,
            sun_reach: 50.0,
            on: true,
            color: "#ffffff".into(),
        });
    }
    // Into a multiple of the light: POWER_SCALE a point of the slider,
    // a light saved on the old scale read at half its number.
    for l in &mut lights {
        l.strength = match l.power {
            Some(power) => power * POWER_SCALE,
            None => l.strength * 0.5 * POWER_SCALE,
        };
    }
    lights.retain(|l| l.on && l.strength.abs() > 1e-3);
    if lights.is_empty() {
        return Ok(Value::Image(src.clone()));
    }
    let Some(far) = depth_plane(inputs, src.width, src.height) else {
        return Ok(Value::Image(src.clone()));
    };
    let (w, h) = (src.width, src.height);
    // The render's own normals, when the desktop planted them out of the
    // photograph's file: unit vectors in the lighting convention, packed
    // (n + 1) / 2 in RGB at whatever size the plant was made. Where the
    // pass has no normal (the background packs to mid gray) the depth
    // estimate below stands in, so the two never leave a seam of nothing.
    let file_normals = inputs.iter().find(|(port, _)| port == "normal").and_then(|(_, v)| v.as_image());
    let file_normal = |x: usize, y: usize| -> Option<(f32, f32, f32)> {
        let img = file_normals?;
        let (rw, rh) = (img.width, img.height);
        let sx = ((x as f32 + 0.5) * rw as f32 / w as f32 - 0.5).clamp(0.0, (rw - 1) as f32);
        let sy = ((y as f32 + 0.5) * rh as f32 / h as f32 - 0.5).clamp(0.0, (rh - 1) as f32);
        let (x0, y0) = (sx.floor() as usize, sy.floor() as usize);
        let (x1, y1) = ((x0 + 1).min(rw - 1), (y0 + 1).min(rh - 1));
        let (fx, fy) = (sx - x0 as f32, sy - y0 as f32);
        let at = |px: usize, py: usize, c: usize| img.data[(py * rw + px) * 4 + c] * 2.0 - 1.0;
        let mut n = [0f32; 3];
        for (c, out) in n.iter_mut().enumerate() {
            let top = at(x0, y0, c) + (at(x1, y0, c) - at(x0, y0, c)) * fx;
            let bot = at(x0, y1, c) + (at(x1, y1, c) - at(x0, y1, c)) * fx;
            *out = top + (bot - top) * fy;
        }
        let len = (n[0] * n[0] + n[1] * n[1] + n[2] * n[2]).sqrt();
        (len > 0.5).then(|| (n[0] / len, n[1] / len, n[2] / len))
    };
    // The normal estimation reads a pixel to EACH side (x.min(w - 2),
    // x.max(1) - 1): under three pixels wide or tall those indices
    // underflow / collapse onto themselves. A frame that small has no
    // relief to shade anyway, so pass it through rather than panic.
    if w < 3 || h < 3 {
        return Ok(Value::Image(src.clone()));
    }
    let ambient = p(&node.params, "ambient", 50.0) / 100.0;
    // p_bool, NOT p: serializeGraph turns flag params into real
    // booleans, and a number-only read answers the default forever.
    // The p_bool comment counts invert among this bug class's prior
    // victims; it just claimed the same flag on a new node.
    let inverted = p_bool(&node.params, "invert", false);
    let frame = frame_of(node, w, h);
    let short = frame.short;
    let relief_px = p(&node.params, "relief", 30.0) / 100.0 * 4.0 * short;
    // The height field: nearness through the section's own Levels
    // (2026-09-13), flipped under Invert.
    let levels = levels_of(node);
    // The executor's mark for a plane the desktop planted out of the
    // photograph's own depth pass (a measured plane): internal, never
    // a spec param, set only on the Node copy this call receives.
    let measured = p(&node.params, "depth_measured", 0.0) > 0.5;
    use rayon::prelude::*;
    let field: Vec<f32> = far
        .par_iter()
        .map(|f| {
            let near = plane_levels(levels, 1.0 - f.clamp(0.0, 1.0));
            if inverted { 1.0 - near } else { near }
        })
        .collect();
    // The lamp's depth axis, sized like its screen reach rather than
    // like the relief drama: with z riding relief_px (four times the
    // short side at full relief), one depth step between lamp and
    // subject dwarfed the lamp's range and starved it, which is why
    // only strength 200 ever showed. Normals keep relief_px; only the
    // lamp distances use this.
    let z_scale = 0.6 * short;
    enum Rig {
        /// `plane` is the light's own depth falloff, (the height it
        /// lands hardest on, how steeply it falls away from it); None
        /// at the defaults, which shade by the emphasis every
        /// directional light always had, bit for bit.
        Directional { dir: [f32; 3], s: f32, tint: [f32; 3], plane: Option<(f32, f32)> },
        Point { pos: [f32; 3], range2: f32, s: f32, tint: [f32; 3] },
    }
    let rigs: Vec<Rig> = lights
        .iter()
        .map(|l| {
            let tint = tint_of(&l.color);
            if l.kind == "point" {
                let range_px = (l.range / 100.0 * short * 1.2).max(8.0);
                // The lamp keeps its HEIGHTFIELD level under Invert, so flipping the
                // field mirrors the lamp to the other end of the scene: a lamp on the
                // subject lands on the background, exactly what the directional
                // emphasis does. The earlier "scene-true" anchoring flipped the lamp
                // WITH the scene, which canceled and made Invert a no-op for lamps
                // ("I click Invert Depth and nothing changes").
                let level = 1.0 - l.depth / 100.0;
                Rig::Point {
                    // The lamp stands in the frame; in a slice, where
                    // the frame's point falls in this buffer.
                    pos: [
                        (l.px - frame.roi[0]) * frame.w,
                        (l.py - frame.roi[1]) * frame.h,
                        level * z_scale + 0.2 * z_scale,
                    ],
                    range2: range_px * range_px,
                    s: l.strength,
                    tint,
                }
            } else {
                let az = l.azimuth.to_radians();
                let el = l.elevation.clamp(5.0, 90.0).to_radians();
                let d = [el.cos() * az.cos(), -el.cos() * az.sin(), el.sin()];
                Rig::Directional {
                    dir: d,
                    s: l.strength,
                    tint,
                    plane: sun_plane(l.sun_depth, l.sun_reach),
                }
            }
        })
        .collect();
    // One pixel's gain from its tilt (height per pixel, relief applied)
    // and its height: the normal, then every rig in order. Shared by
    // the two contracts below; the arithmetic is the model path's,
    // unchanged.
    let shade = |x: usize, y: usize, gx: f32, gy: f32, hgt: f32| -> [f32; 3] {
        let inv = 1.0 / (gx * gx + gy * gy + 1.0).sqrt();
        let (nx, ny, nz) = file_normal(x, y).unwrap_or((-gx * inv, -gy * inv, inv));
        let z = hgt * z_scale;
            // Depth emphasis: a directional key reaches the NEAR relief harder,
            // the way a subject-forward key reads on a set; Invert flips the
            // heightfield, so the emphasis (and every lamp's position in depth)
            // lands on the background instead. This is what makes Invert
            // unmistakable - the normals' mirror alone read as nothing happening
            // ("Invert Depth does not seem to be working").
            let emphasis = 0.35 + 0.65 * hgt;
            let mut gain = [1.0f32; 3];
            for rig in &rigs {
                match rig {
                    Rig::Directional { dir, s, tint, plane } => {
                        // A directional light is ADDITIVE, the lamp's rule (26.3 Phase 9): it
                        // pushes light where it reaches and owes nothing anywhere else, so no
                        // pixel ends below its unlit value at positive strength. The old
                        // anchor, a lit flat surface at MID depth, made every pixel under that
                        // baseline count as dark, so a far plane dimmed as strength rose (The
                        // report: "the background gets darker. Point light does not do this").
                        // Ambient stays as the floor of the term, the spill to surfaces facing
                        // away; the emphasis still lands the light harder near than far, and
                        // negative strength takes light away by the same shape.
                        let lambert = (nx * dir[0] + ny * dir[1] + nz * dir[2]).max(0.0);
                        // The light's own plane and reach, when set:
                        // full on its plane, falling with the distance
                        // in depth from it. Like the lamp's level, the
                        // plane is a HEIGHTFIELD level, so Invert
                        // mirrors it to the other end of the scene.
                        let emphasis = match plane {
                            None => emphasis,
                            Some((level, steep)) => (1.0 - SUN_FALL * steep * (hgt - level).abs()).max(0.0),
                        };
                        push_gain(&mut gain, (ambient + (1.0 - ambient) * lambert) * emphasis * s, tint);
                    }
                    Rig::Point { pos, range2, s, tint } => {
                        // A lamp is ADDITIVE: it pushes light where it reaches and owes
                        // nothing anywhere else. The old sun-style anchor made everywhere the
                        // lamp did NOT reach count as below baseline, so +strength darkened
                        // the frame and negative brightened it ("-200 gets
                        // brighter and 200 is darker").
                        let (dx, dy, dz) = (pos[0] - x as f32, pos[1] - y as f32, pos[2] - z);
                        let d2 = dx * dx + dy * dy + dz * dz;
                        let dlen = d2.sqrt().max(1e-3);
                        let (lx, ly, lz) = (dx / dlen, dy / dlen, dz / dlen);
                        let lambert = (nx * lx + ny * ly + nz * lz).max(0.0);
                        // The depth axis counts EXTRA in the falloff (direction above stays
                        // geometric). With depth and screen distance weighed the same, a lamp
                        // reached across the whole scene at half power and its depth placement
                        // read as mush: the owner's bus scene showed Invert flipping which
                        // plane was closer while the render barely moved. Weighted, a lamp
                        // lights ITS plane and releases the other, and Invert's mirror is
                        // unmistakable.
                        let dzw = 2.5 * dz;
                        let atten = range2 / (range2 + dx * dx + dy * dy + dzw * dzw);
                        push_gain(&mut gain, lambert * atten * s, tint);
                    }
                }
            }
        gain
    };
    // The measured contract: the desktop planted this plane out of the
    // file's own depth pass with the Depth Map's refinement at the
    // identity, and the executor marked the wire. Nothing below is a guess
    // to be cleaned up: no reduced grid, no smoothing, no ripple gate, no
    // step band. The slope is taken at the frame's size from the plane
    // itself, one sided at a cliff (an absolute jump of more than 0.15 of
    // the scene's depth between neighbors, the model path's threshold
    // before it is spread over the smoothing radius) so each surface shades
    // to its last pixel and the silhouette stays one pixel wide; the
    // emphasis and the lamps' distances read the exact height. The
    // estimated contract, everything after this block, is untouched: its
    // tunings are what make a guessed map usable.
    if measured {
        let tilt_exact = |i: usize, along_x: bool| one_sided_slope(&field, w, h, i, along_x, MEASURED_CLIFF);
        let mut out = ImageBuf::new(w, h);
        out.data
            .par_chunks_mut(4)
            .enumerate()
            .for_each(|(i, px)| {
                let (x, y) = (i % w, i / w);
                let gx = tilt_exact(i, true) * relief_px;
                let gy = tilt_exact(i, false) * relief_px;
                let gain = shade(x, y, gx, gy, field[i]);
                for c in 0..3 {
                    px[c] = src.data[i * 4 + c] * gain[c].max(0.0);
                }
                px[3] = src.data[i * 4 + 3];
            });
        return Ok(Value::Image(Arc::new(out)));
    }
    // A cliff is not a slope. Where the plane jumps between a near thing
    // and the far thing behind it, the gradient is an occlusion, not a
    // surface facing the light, and shading it drew a beveled rim around
    // every silhouette (the owner's GoPro, 2026-09-05). The first cure
    // smoothed the field, marked every steep pixel, blurred the mark wide
    // and flattened the normals under it, which traded the bevel for a rim
    // of another kind: a strip along every silhouette, about one percent of
    // the short side wide, where the subject's own relief went flat against
    // its shaded interior (2026-09-13: "halo/borders around subjects"). It
    // also, unnoticed, flattened most of any textured surface, because the
    // model draws hair and cloth as ripples a few hundredths deep, and at
    // relief's scale (over a thousand pixels of height per unit of depth) a
    // ripple is a wall: every pixel of it read as a cliff by a
    // per-short-edge slope, and went flat. Shaded, those ripples are noise.
    //
    // Now the field is smoothed and differentiated WITHIN a surface
    // only, at a scale that keeps a head's roundness and a fold's
    // shape and loses the ripples. The slope limit is 0.15 of the
    // scene's depth over the smoothing radius, divided by that radius
    // for a difference between cells. The bilateral's depth kernel
    // below decides which neighbors share a surface. These are
    // heuristics: close surfaces and a broad ramp can still shade as
    // a bevel. The smoothing is range-limited, two percent of the
    // short side each way, in two passes at a reduced size (the radius
    // never exceeds six cells, bounding the work per reduced pixel)
    // and resampled back: a neighbor across a cliff is left out of
    // the average, so the texture averages away on each side and the
    // step between them stays a step. The slope then drops a
    // difference across a cliff for the other side's, so the shading
    // runs to the last pixel of each surface and only the step itself,
    // the model's own soft edge, comes out flat.
    //
    // The pass also reports how much of each pixel's window lay across
    // a cliff. The step's own pixels reject most of theirs, a surface
    // pixel near the edge a little. Two things hang on that share. The
    // normals go flat with it: on the step a difference just under the
    // threshold, times relief, still tilted the normal all the way over
    // and drew a dotted line along the silhouette. It also weights
    // the fit's samples. The lamps and emphasis read a separate,
    // full-size median field, whose gradient weights the fit's
    // answer below. Those two edge decisions can still disagree.
    let r_full = (0.02 * short).round().max(2.0);
    let scale = ((r_full / 6.0).ceil() as usize).max(1);
    // Cells belong to the frame. Starting them again at a slice's
    // origin moved the smoothed slopes by up to a whole cell on zoom.
    let ox = (frame.roi[0] * frame.w).round().max(0.0) as usize % scale;
    let oy = (frame.roi[1] * frame.h).round().max(0.0) as usize % scale;
    let (lw, lh) = ((w + ox).div_ceil(scale), (h + oy).div_ceil(scale));
    let cell_x = |cx: usize| (cx * scale).saturating_sub(ox).min(w);
    let cell_y = |cy: usize| (cy * scale).saturating_sub(oy).min(h);
    let radius = ((r_full / scale as f32).round() as isize).max(2);
    let range = 0.15f32;
    // The smoothing is a bilateral filter with GAUSSIAN weights in both
    // space and depth. A box window with a hard depth cutoff was not smooth
    // in its membership: the cell straddling a silhouette averages to a
    // value between the two surfaces, near enough to one of them to count
    // as its own, and at exactly one window radius before the edge that
    // cell entered the near side's average and stepped the smoothed field
    // down by a hundredth in one cell, which relief made a full tilt: a
    // detached dark band a window's width before every silhouette under a
    // hard light (the measurement, 2026-09-13). With Gaussian weights
    // nothing enters a window abruptly, and a cell between two surfaces, a
    // few hundredths from either, belongs to neither. The depth kernel is a
    // quartic, not a gaussian: a gaussian's tail still let a jump of twice
    // its sigma through at a seventh, and relief made that seventh a bevel;
    // the quartic keeps a ripple's two hundredths nearly whole and lets
    // nothing through at twice the sigma.
    let sigma_s = (radius as f32 / 2.0).max(1.0);
    let sigma_r = 0.05f32;
    // Per reduced-size pixel: the jump spread over the smoothing
    // radius, which is what the model's step looks like at any size.
    let cliff = range / radius as f32;
    // A cell takes its block's median (review, 2026-09-16). A mean
    // invented a third surface wherever a cell straddled a cliff.
    // With a jump of 0.08 that mixed height was close enough to the
    // near side to enter its bilateral and tilt its last six pixels:
    // gain 0.035 under the hard dark light, against a 0.48 plateau.
    // The median belongs to a surface, so even a small hard step stays
    // a step. Full-size height still places the silhouette; this does
    // not recover relief on subjects narrower than a cell, or repair
    // the model's broad ramps.
    let small: Vec<f32> = (0..lw * lh)
        .into_par_iter()
        .map(|i| {
            let (cx, cy) = (i % lw, i / lw);
            let mut values = Vec::with_capacity(scale * scale);
            for y in cell_y(cy)..cell_y(cy + 1) {
                for x in cell_x(cx)..cell_x(cx + 1) {
                    values.push(field[y * w + x]);
                }
            }
            let mid = values.len() / 2;
            *values.select_nth_unstable_by(mid, f32::total_cmp).1
        })
        .collect();
    let pass = |src: &[f32], along_x: bool| -> (Vec<f32>, Vec<f32>) {
        let rows: Vec<(f32, f32)> = (0..lw * lh)
            .into_par_iter()
            .map(|i| {
                let (x, y) = ((i % lw) as isize, (i / lw) as isize);
                let c = src[i];
                let (mut sum, mut wsum, mut ssum) = (0.0f32, 0.0f32, 0.0f32);
                for k in -radius..=radius {
                    let (sx, sy) = if along_x { (x + k, y) } else { (x, y + k) };
                    if sx < 0 || sy < 0 || sx >= lw as isize || sy >= lh as isize {
                        continue;
                    }
                    let v = src[sy as usize * lw + sx as usize];
                    let ws = (-((k * k) as f32) / (2.0 * sigma_s * sigma_s)).exp();
                    let d = (v - c) / sigma_r;
                    let wr = (-(d * d * d * d)).exp();
                    sum += ws * wr * v;
                    wsum += ws * wr;
                    ssum += ws;
                }
                // The share of the window's weight that lay across a
                // cliff: the step's own cells reject most of theirs.
                (sum / wsum, 1.0 - wsum / ssum)
            })
            .collect();
        rows.into_iter().unzip()
    };
    let (limited_x, across_x) = pass(&small, true);
    let (limited_s, across_y) = pass(&limited_x, false);
    let on_step_s: Vec<f32> = across_x
        .iter()
        .zip(&across_y)
        .map(|(a, b)| crate::ops::smoothstep(0.3, 0.6, a.max(*b)))
        .collect();
    // The HEIGHT the depth emphasis and the lamps read stays at the
    // frame's size, so the silhouette it draws is the plane's own, to the
    // pixel (read from the reduced size instead, the outline came out
    // ragged at cell scale under a strong light: the owner's red lamp on
    // the pavement, 2026-09-13). A median over a small window takes out
    // the single stray pixels the Edges refinement leaves along an edge,
    // and unlike the gaussian it replaced it never crosses a cliff: the
    // blur pulled the far side's height a few pixels onto the near surface
    // and lowered the emphasis there, a dark line two pixels wide along
    // every silhouette under a hard light. Two pixels at the preview's
    // size, and as many more as the frame is larger: the specks live at
    // the plane's own resolution. Run as a median of medians, a row pass
    // then a column pass, which takes a speck out as well as the square
    // window would at a fraction of its taps.
    let r_med = ((2.0 * short / 1365.0).round() as usize).clamp(2, 6);
    let median_pass = |src: &[f32], along_x: bool| -> Vec<f32> {
        (0..w * h)
            .into_par_iter()
            .map(|i| {
                let (x, y) = (i % w, i / w);
                let mut window = [0f32; 13];
                let mut n = 0;
                let (lo, hi) = if along_x { (x.saturating_sub(r_med), (x + r_med).min(w - 1)) } else { (y.saturating_sub(r_med), (y + r_med).min(h - 1)) };
                for k in lo..=hi {
                    window[n] = if along_x { src[y * w + k] } else { src[k * w + x] };
                    n += 1;
                }
                let values = &mut window[..n];
                values.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
                values[n / 2]
            })
            .collect()
    };
    let smooth = median_pass(&median_pass(&field, true), false);
    // The slope from a cell's two neighbors, one-sided at a cliff:
    // the surface's own, or flat when both neighbors are across one.
    // Each side's weight rolls off toward the cliff rather than
    // cutting at it: a hard cut let the cells of the model's step,
    // which sit right at the threshold, flicker between one-sided and
    // flat and drew a dotted line along the silhouette. Taken at the
    // reduced size and resampled as a slope: resampling the height and
    // differentiating it at the frame's size kinked at every cell edge
    // (bilinear is continuous, its derivative is not), and relief made
    // each kink a visible block.
    let slope = |a: f32, b: f32, c: f32| -> f32 {
        let (dl, dr) = (b - a, c - b);
        let wl = 1.0 - crate::ops::smoothstep(0.5 * cliff, cliff, dl.abs());
        let wr = 1.0 - crate::ops::smoothstep(0.5 * cliff, cliff, dr.abs());
        let ws = wl + wr;
        if ws <= 1e-6 { 0.0 } else { (dl * wl + dr * wr) / ws }
    };
    // Height per FULL-size pixel, flat on the step (its share above).
    let tilt = |along_x: bool| -> Vec<f32> {
        (0..lw * lh)
            .into_par_iter()
            .map(|i| {
                if lw < 3 || lh < 3 {
                    return 0.0;
                }
                let (x, y) = (i % lw, i / lw);
                let at = |px: usize, py: usize| limited_s[py * lw + px];
                let (a, b, c) = if along_x {
                    (at(x.max(1) - 1, y), at(x, y), at(x.min(lw - 2) + 1, y))
                } else {
                    (at(x, y.max(1) - 1), at(x, y), at(x, y.min(lh - 2) + 1))
                };
                slope(a, b, c) * (1.0 - on_step_s[i]) / scale as f32
            })
            .collect()
    };
    // The four cell centers surrounding a frame pixel. Reading the
    // small fields here avoids materializing eight full-size copies.
    let taps = |i: usize| {
        let (x, y) = (i % w, i / w);
        let sx = (((x + ox) as f32 + 0.5) / scale as f32 - 0.5).clamp(0.0, (lw - 1) as f32);
        let sy = (((y + oy) as f32 + 0.5) / scale as f32 - 0.5).clamp(0.0, (lh - 1) as f32);
        let (x0, fx) = (sx.floor() as usize, sx.fract());
        let (y0, fy) = (sy.floor() as usize, sy.fract());
        let (x1, y1) = ((x0 + 1).min(lw - 1), (y0 + 1).min(lh - 1));
        ([y0 * lw + x0, y0 * lw + x1, y1 * lw + x0, y1 * lw + x1], fx, fy)
    };
    let blend = |v: [f32; 4], fx: f32, fy: f32| {
        let top = v[0] + (v[1] - v[0]) * fx;
        let bot = v[2] + (v[3] - v[2]) * fx;
        top + (bot - top) * fy
    };
    let (mut tilt_x_s, mut tilt_y_s) = (tilt(true), tilt(false));
    // The foot of a cliff is the cliff's, not relief. The model's edge does not stop
    // where the photograph's does: on the far side of a silhouette the plane bends toward
    // the near object over a few pixels before it drops, a dip of a couple of hundredths
    // that the smoothing spreads over the window, and the slope of that dip, at relief's
    // scale, shaded a bright band along every silhouette on the background (gain 2.10
    // beside 1.68 on the wall behind a child, P1551380). A background surface does not
    // bend toward the thing in front of it at its silhouette; that shape is the model's.
    // So on the FAR side of a cliff, within the window, a slope that descends toward the
    // cliff is taken as the cliff's and rolled off with the cliff's strength. The near
    // side keeps every slope: a convex rim rises toward its silhouette and is real. Cliffs
    // are read on the cells before smoothing, which keeps them sharp. The field here is
    // HEIGHT, nearness: the far side is the lower side, and the model's foot climbs toward
    // the near object, so the slope to roll off is the one rising toward the cliff on the
    // lower side. The walk reaches twice the window: the smoothing spreads the foot's
    // slope a window past the foot itself.
    //
    // Only the EXCESS is the model's (the 2026-09-23 review's R1): a
    // floor receding under a subject, or a wall the camera looks along,
    // climbs toward the silhouette on its own, and the first form of
    // this rule flattened that too within its reach (a real 0.003 per
    // pixel floor lost a quarter of its shading over the last eight
    // pixels). So the background's own slope is read the same distance
    // again away from the cliff, past the foot, and the foot is rolled
    // off toward THAT, not toward flat: a flat wall's foot still goes
    // flat, a sloping floor's foot keeps the floor's slope.
    {
        let reach = 2 * radius;
        let foot = |along_x: bool, tilt_s: &mut Vec<f32>| {
            let rolled: Vec<f32> = (0..lw * lh)
                .into_par_iter()
                .map(|i| {
                    let (x, y) = ((i % lw) as isize, (i / lw) as isize);
                    let at = |px: isize, py: isize| small[py as usize * lw + px as usize];
                    let here = at(x, y);
                    let mut t = tilt_s[i];
                    for dir in [-1isize, 1] {
                        // Walk outward until the first cliff.
                        for k in 1..=reach {
                            let (px, py) = if along_x { (x + dir * k, y) } else { (x, y + dir * k) };
                            let (qx, qy) = if along_x { (px - dir, py) } else { (px, py - dir) };
                            if px < 0 || py < 0 || px >= lw as isize || py >= lh as isize {
                                break;
                            }
                            let jump = at(px, py) - at(qx, qy);
                            let strength = crate::ops::smoothstep(0.5 * cliff, cliff, jump.abs());
                            if strength <= 0.0 {
                                continue;
                            }
                            // The other side of the cliff is higher, nearer:
                            // this cell stands on the far side.
                            let far_side = at(px, py) > here;
                            if far_side {
                                // The background's own slope, read past
                                // the foot on the side away from the cliff.
                                let (rx, ry) = if along_x {
                                    ((x - dir * reach).clamp(0, lw as isize - 1), y)
                                } else {
                                    (x, (y - dir * reach).clamp(0, lh as isize - 1))
                                };
                                let own = tilt_s[ry as usize * lw + rx as usize];
                                // Climbing toward the cliff beyond what the
                                // background does on its own: the excess is
                                // the model's foot.
                                if (t - own) * dir as f32 > 0.0 {
                                    t -= strength * (t - own);
                                }
                            }
                            break;
                        }
                    }
                    t
                })
                .collect();
            tilt_s.copy_from_slice(&rolled);
        };
        foot(true, &mut tilt_x_s);
        foot(false, &mut tilt_y_s);
    }
    // Surfaces flatter than the model can resolve read as flat. The plane
    // carries ripples of a few hundredths across pavement, walls and sky, a
    // quarter of a depth unit over the whole frame, and a lamp near such a
    // surface meets it at a grazing angle where those ripples decide nearly
    // all of its push: the owner's point lamp printed an irregular dark
    // blotch on the pavement (2026-09-13). Shape the model does see, a
    // head, a fold, a curb, slopes one to three depth units per frame. The
    // slope rolls in between a third and nine tenths of a unit per short
    // edge, so the ripples stop tilting the normal and the shape keeps its
    // shading; the height itself, for the emphasis and the lamps'
    // distances, is untouched.
    for i in 0..lw * lh {
        let per_edge = (tilt_x_s[i] * tilt_x_s[i] + tilt_y_s[i] * tilt_y_s[i]).sqrt() * short;
        let f = crate::ops::smoothstep(0.35, 0.9, per_edge);
        tilt_x_s[i] *= f;
        tilt_y_s[i] *= f;
    }
    let level = |x: usize, y: usize| smooth[y * w + x];
    // PERF: the shading parallelizes over pixels; each pixel forms the
    // same differences, the same normal, and the same per-rig gain
    // sequence (rigs visited in order, the per-channel multiplies in
    // the same order) as a serial loop would.
    let gains: Vec<[f32; 3]> = (0..w * h)
        .into_par_iter()
        .map(|i| {
            let (x, y) = (i % w, i / w);
            let (ids, fx, fy) = taps(i);
            let gx = blend(ids.map(|j| tilt_x_s[j]), fx, fy) * relief_px;
            let gy = blend(ids.map(|j| tilt_y_s[j]), fx, fy) * relief_px;
            shade(x, y, gx, gy, level(x, y))
        })
        .collect();
    // The step's own shading is what its side of the edge would have.
    // Flat, the step sat at the unlit gain while both surfaces beside
    // it carried a tilt, and under a hard light that drew a seam along
    // every silhouette; filled with an average of both sides at the
    // reduced size, the outline came out ragged at cell scale under a
    // strong light. So: around each cell, over the smoothing window,
    // the gain of the non-step pixels is fitted as a line in height,
    // and a step pixel takes the fitted gain AT ITS OWN HEIGHT. Near
    // pixels of the ramp get the near side's gain, far ones the far
    // side's, continuously across the model's soft edge, and at the
    // frame's size: the fit is smooth, the height that reads it is
    // the pixel's. Step-ness is the blurred height's own gradient, in
    // units per short edge so it reads the same at the export's size:
    // texture slopes a few units, a silhouette over a hundred.
    let cells = lw * lh;
    // Independent cells accumulate in parallel. Wider moments keep
    // the variance subtraction stable on nearly flat depth planes.
    let sums: Vec<_> = (0..cells).into_par_iter().map(|c| {
        let (cx, cy) = (c % lw, c / lw);
        let wt = (1.0 - on_step_s[c]) as f64;
        let (mut sw, mut sh, mut shh) = (0f64, 0f64, 0f64);
        let (mut sg, mut sgh) = ([0f64; 3], [0f64; 3]);
        let (mut lo, mut hi) = ([f32::INFINITY; 3], [f32::NEG_INFINITY; 3]);
        for y in cell_y(cy)..cell_y(cy + 1) {
            for x in cell_x(cx)..cell_x(cx + 1) {
                let i = y * w + x;
                let hgt = smooth[i] as f64;
                sw += wt;
                sh += wt * hgt;
                shh += wt * hgt * hgt;
                for k in 0..3 {
                    sg[k] += wt * gains[i][k] as f64;
                    sgh[k] += wt * gains[i][k] as f64 * hgt;
                    if wt > 0.0 {
                        lo[k] = lo[k].min(gains[i][k]);
                        hi[k] = hi[k].max(gains[i][k]);
                    }
                }
            }
        }
        (sw, sh, shh, sg, sgh, lo, hi)
    }).collect();
    let boxsum = |v: Vec<f64>| -> Vec<f64> {
        let pass = |src: &[f64], along_x: bool| -> Vec<f64> {
            (0..cells)
                .into_par_iter()
                .map(|i| {
                    let (x, y) = ((i % lw) as isize, (i / lw) as isize);
                    let mut acc = 0f64;
                    for k in -radius..=radius {
                        let (sx, sy) = if along_x { (x + k, y) } else { (x, y + k) };
                        if sx < 0 || sy < 0 || sx >= lw as isize || sy >= lh as isize {
                            continue;
                        }
                        acc += src[sy as usize * lw + sx as usize];
                    }
                    acc
                })
                .collect()
        };
        pass(&pass(&v, true), false)
    };
    let (w_sum, h_sum, hh_sum) = (boxsum(sums.iter().map(|s| s.0).collect()), boxsum(sums.iter().map(|s| s.1).collect()), boxsum(sums.iter().map(|s| s.2).collect()));
    let bounds = |k: usize| {
        let pass = |src: &[[f32; 2]], along_x: bool| -> Vec<[f32; 2]> {
            (0..cells).into_par_iter().map(|i| {
                let (x, y) = ((i % lw) as isize, (i / lw) as isize);
                let mut bound = [f32::INFINITY, f32::NEG_INFINITY];
                for d in -radius..=radius {
                    let (sx, sy) = if along_x { (x + d, y) } else { (x, y + d) };
                    if sx >= 0 && sy >= 0 && sx < lw as isize && sy < lh as isize {
                        let b = src[sy as usize * lw + sx as usize];
                        bound[0] = bound[0].min(b[0]);
                        bound[1] = bound[1].max(b[1]);
                    }
                }
                bound
            }).collect()
        };
        pass(&pass(&sums.iter().map(|s| [s.5[k], s.6[k]]).collect::<Vec<_>>(), true), false)
    };
    let fit: [(Vec<f32>, Vec<f32>, Vec<[f32; 2]>); 3] = std::array::from_fn(|k| {
        let (g_sum, gh_sum) = (boxsum(sums.iter().map(|s| s.3[k]).collect()), boxsum(sums.iter().map(|s| s.4[k]).collect()));
        let mut bounds = bounds(k);
        let mut a = vec![1f32; cells];
        let mut b = vec![0f32; cells];
        for i in 0..cells {
            if w_sum[i] <= 1e-6 {
                bounds[i] = [1.0, 1.0];
                continue;
            }
            let det = w_sum[i] * hh_sum[i] - h_sum[i] * h_sum[i];
            let slope = if det > 1e-6 * w_sum[i] * w_sum[i] {
                (w_sum[i] * gh_sum[i] - h_sum[i] * g_sum[i]) / det
            } else {
                0.0
            };
            b[i] = slope as f32;
            a[i] = ((g_sum[i] - slope * h_sum[i]) / w_sum[i]) as f32;
        }
        (a, b, bounds)
    });
    let mut out = ImageBuf::new(w, h);
    out.data
        .par_chunks_mut(4)
        .enumerate()
        .for_each(|(i, px)| {
            let (x, y) = (i % w, i / w);
            let at = |px: usize, py: usize| smooth[py * w + px];
            let dx = (at(x.min(w - 2) + 1, y) - at(x.max(1) - 1, y)) * 0.5;
            let dy = (at(x, y.min(h - 2) + 1) - at(x, y.max(1) - 1)) * 0.5;
            let hgt = smooth[i];
            let (ids, fx, fy) = taps(i);
            // One decision for the step. The cells' own share put the normals flat
            // at the reduced size while the fit waited on the pixel's gradient,
            // and in the band where the two disagreed a surface lost its tilt's
            // shading without the fit that would have given it back: a dark notch
            // one cell wide on the far side of every silhouette under a hard light
            // (the measured finding, 2026-09-13). Wherever the cells say step, the
            // fit applies; the pixel's gradient adds the ramp's own pixels at the
            // frame's size.
            let step = blend(ids.map(|j| on_step_s[j]), fx, fy);
            let t = crate::ops::smoothstep(20.0, 60.0, (dx * dx + dy * dy).sqrt() * short).max(step);
            for c in 0..3 {
                // Bound each window BEFORE interpolating its answer:
                // interpolated coefficients can extrapolate far beyond
                // both surfaces even when their individual fits are valid.
                let fitted = blend(ids.map(|j| fitted_gain(fit[c].0[j], fit[c].1[j], hgt, fit[c].2[j][0], fit[c].2[j][1])), fx, fy);
                let g = gains[i][c] + (fitted - gains[i][c]) * t;
                // Each light already has its soft floor. The fit is
                // bounded by those positive gains, so only roundoff
                // could take the blend below zero here.
                let g = g.max(0.0);
                px[c] = src.data[i * 4 + c] * g;
            }
            px[3] = src.data[i * 4 + 3];
        });
    Ok(Value::Image(Arc::new(out)))
}

/// The aperture as a kernel: an n-bladed polygon bulged toward a
/// circle by `curve` (0 = hard blades, 1 = round), 1px soft edge.
/// For big radii the tap grid strides so the cost stays bounded; the
/// coverage stays uniform so the disc still reads as a disc.
fn aperture_kernel(radius: f32, blades: u32, curve: f32) -> (Vec<(i32, i32, f32)>, f32) {
    let n = blades.max(3) as f32;
    let r = radius.max(0.6);
    let ri = r.ceil() as i32;
    let stride = ((r / 12.0).floor() as i32).max(1);
    let seg = std::f32::consts::PI / n;
    let mut taps = Vec::new();
    let mut wsum = 0.0f32;
    let mut dy = -ri;
    while dy <= ri {
        let mut dx = -ri;
        while dx <= ri {
            let d = ((dx * dx + dy * dy) as f32).sqrt();
            if d <= r + 1.0 {
                let theta = (dy as f32).atan2(dx as f32);
                let poly = seg.cos() / (theta.rem_euclid(2.0 * seg) - seg).cos();
                let limit = r * (poly + (1.0 - poly) * curve);
                let w = (1.0 - (d - limit)).clamp(0.0, 1.0);
                if w > 0.0 {
                    taps.push((dx, dy, w));
                    wsum += w;
                }
            }
            dx += stride;
        }
        dy += stride;
    }
    (taps, wsum.max(1e-6))
}

/// The disc's character beyond its blades: bubble is the radial weight
/// profile (0 the flat disc, 100 a bright rim over a hollow center, the
/// soap-bubble bokeh), squeeze scales the disc on one axis (negative
/// the anamorphic tall oval, positive wide), and swirl stretches discs
/// tangentially by their distance from the frame center, the spinning
/// field of a Petzval. Zero for all three is the plain kernel, tap for
/// tap.
#[derive(Clone, Copy, Default, PartialEq)]
pub(crate) struct DiscShape {
    pub bubble: f32,
    pub squeeze: f32,
    pub swirl: f32,
}

impl DiscShape {
    fn is_plain(&self) -> bool {
        self.bubble <= 0.0 && self.squeeze == 0.0 && self.swirl <= 0.0
    }
}

/// How many kernel variants the swirl builds: discs are grouped by the
/// angle about the frame center and by how far out they sit.
const SWIRL_SECTORS: usize = 12;
const SWIRL_RINGS: usize = 3;

/// The aperture kernel with its shape applied. `elong` and `angle` are
/// the swirl's tangential stretch and its direction for one variant;
/// 1 and 0 for none. The plain shape hands back aperture_kernel's own
/// taps, so every existing render is unchanged.
fn aperture_kernel_shaped(
    radius: f32,
    blades: u32,
    curve: f32,
    shape: DiscShape,
    elong: f32,
    angle: f32,
) -> (Vec<(i32, i32, f32)>, f32) {
    if shape.is_plain() && (elong - 1.0).abs() < 1e-6 {
        return aperture_kernel(radius, blades, curve);
    }
    let n = blades.max(3) as f32;
    let r = radius.max(0.6);
    // The disc's axes: squeeze on x or y, then the swirl's stretch
    // along `angle`. The kernel's reach is the largest axis.
    let (sx, sy) = if shape.squeeze < 0.0 {
        (1.0, 1.0 - shape.squeeze * 0.8)
    } else {
        (1.0 + shape.squeeze * 0.8, 1.0)
    };
    let reach = r * sx.max(sy) * elong.max(1.0) + 1.0;
    let ri = reach.ceil() as i32;
    let stride = ((r / 12.0).floor() as i32).max(1);
    let seg = std::f32::consts::PI / n;
    let (sa, ca) = angle.sin_cos();
    let mut taps = Vec::new();
    let mut wsum = 0.0f32;
    let mut dy = -ri;
    while dy <= ri {
        let mut dx = -ri;
        while dx <= ri {
            // Undo the swirl's stretch (rotate into its frame, divide
            // the along axis), then the squeeze, to read the plain disc.
            let (fx, fy) = (dx as f32, dy as f32);
            let along = (fx * ca + fy * sa) / elong.max(1.0);
            let across = -fx * sa + fy * ca;
            let ux = (along * ca - across * sa) / sx;
            let uy = (along * sa + across * ca) / sy;
            let d = (ux * ux + uy * uy).sqrt();
            if d <= r + 1.0 {
                let theta = uy.atan2(ux);
                let poly = seg.cos() / (theta.rem_euclid(2.0 * seg) - seg).cos();
                let limit = r * (poly + (1.0 - poly) * curve);
                let mut w = (1.0 - (d - limit)).clamp(0.0, 1.0);
                if w > 0.0 && shape.bubble > 0.0 {
                    // The soap bubble: weight climbs toward the rim.
                    let t = (d / limit.max(1e-3)).clamp(0.0, 1.0);
                    w *= 1.0 - shape.bubble * (1.0 - t * t * t);
                }
                if w > 0.0 {
                    taps.push((dx, dy, w));
                    wsum += w;
                }
            }
            dx += stride;
        }
        dy += stride;
    }
    (taps, wsum.max(1e-6))
}

/// Depth of field with the lens's own vices ("I don't care about
/// cost, the ROI with user will be well worth it"):
/// - the blur is a real aperture gather (blades + blade curve), so
/// highlights become bokeh discs, hard-edged or round;
/// - field curvature bends the focal plane by distance from center,
/// the vintage-lens edge falloff;
/// - fringe splits the channels' focus longitudinally: magenta
/// behind the plane, green in front, only where the image is
/// already out of focus;
/// - glow is spherical aberration's halo: bright in-focus points
/// bleed a soft envelope, the under-corrected wide-open look.
///
/// Passthrough at zero aperture and without a depth plane, as ever.
pub(crate) fn dof(node: &Node, inputs: &[(String, Value)]) -> Result<Value, EngineError> {
    let src = image_input(inputs, "in", &node.id)?;
    let aperture = p(&node.params, "aperture", 0.0) / 100.0;
    if aperture <= 0.0 {
        return Ok(Value::Image(src.clone()));
    }
    let Some(far) = depth_plane(inputs, src.width, src.height) else {
        return Ok(Value::Image(src.clone()));
    };
    let focus = p(&node.params, "focus", 0.0) / 100.0;
    let blades = p(&node.params, "blades", 6.0).round() as u32;
    let blade_curve = p(&node.params, "blade_curve", 100.0) / 100.0;
    let fringe = p(&node.params, "fringe", 0.0) / 100.0;
    let field_curve = p(&node.params, "field_curve", 0.0) / 100.0;
    let glow = p(&node.params, "glow", 0.0) / 100.0;
    let shape = DiscShape {
        bubble: p(&node.params, "bubble", 0.0) / 100.0,
        squeeze: (p(&node.params, "squeeze", 0.0) / 100.0).clamp(-1.0, 1.0),
        swirl: p(&node.params, "swirl", 0.0) / 100.0,
    };
    // The buffer's rect in frame fractions, handed down by the
    // desktop's inject_roi for a 1:1 sharp slice (the whole frame by
    // default). Swirl and field curvature anchor on the FRAME center:
    // without the rect a patch spins and bends about its own center.
    let roi = [
        p(&node.params, "roi_x", 0.0),
        p(&node.params, "roi_y", 0.0),
        p(&node.params, "roi_w", 1.0).max(1e-4),
        p(&node.params, "roi_h", 1.0).max(1e-4),
    ];
    // The layered path is the only path since the cutover ruling
    // (pass 7): the gather design bled symmetrically at depth edges,
    // and the property tests in bench_dof2_chain.rs pin everything it
    // did right - in-focus passthrough, aperture shape, disc energy,
    // HDR, determinism - plus the edge asymmetry it never had.
    Ok(Value::Image(Arc::new(dof_layered(
        &src, &far, aperture, focus, blades, blade_curve, fringe, field_curve, glow, shape, roi,
    ))))
}

// ---------------------------------------------------------------------
// The layered depth of field (pass 7): occlusion-aware by slices.
//
// The gather path above blurs the whole frame at three radii and mixes
// by per-pixel circle of confusion; at a depth discontinuity the mix
// is symmetric, so a sharp foreground smears into a blurred background
// exactly as much as the background haloes over it, and both halves of
// that are wrong. This path instead cuts the signed-defocus axis into
// DOF_SLICES bands, blurs each band's own premultiplied content through
// its own aperture kernel at the band's radius, and composites the
// bands back to front with coverage (a running visibility budget on
// the blurred alpha, see "Alpha and coverage" below). The
// physics fall out of the ordering: a defocused NEAR band's alpha
// spreads past its hard edge and covers what was laid down before it,
// so foreground bokeh spills over the background behind it; a sharp
// near band composites last with unspread alpha, so nothing behind it
// crosses its edge. The asymmetry a real lens shows is the compositing
// order, not a trick.
//
// What deliberately matches the gather path:
// - the CoC mapping itself: focal = focus + field curvature (the same
//   quadratic in distance from center), signed = far - focal, coc =
//   |signed| clamped to [0,1]. dof_planes copies the expression
//   verbatim so the gather path's body stays under glass until the
//   cutover ruling.
// - the aperture: the same aperture_kernel (blades + curve) shapes
//   every band's blur, so a highlight's disc away from depth edges is
//   the same polygon at (to within band quantization) the same radius.
// - the fringe: the sign-of-defocus red/blue split, same 0.35 formula,
//   resolved once per band instead of per pixel (a band's sign is its
//   members' sign to within the band width, and at the focal plane
//   both paths split nothing).
// - the glow stage: unchanged, running downstream on this path's
//   output and coc plane exactly as on the gather path's.
//
// What deliberately differs, beyond the edge asymmetry itself:
// - Radius quantization: the gather path effectively ramps radius by
//   MIXING three full-frame blurs (a mid-coc pixel is a ghost of two
//   disc sizes); this path quantizes coc to DOF_SLICES bands and gives
//   each band one clean disc. Finer steps (16 vs 3), no double-disc
//   ghosting, but a mid-band pixel's disc is the band's disc.
// - Band radius rule: a band blurs at its PLANE-WARD edge radius,
//   max_r * (|center| - half a band), floored at zero, so the band
//   containing the focal plane is exactly the identity and in-focus
//   content passes through untouched - the gather path is exact only
//   at coc == 0 and ghosts immediately off the plane.
// - Alpha and coverage: slices are premultiplied by membership *
//   source alpha, and the composite runs NEAR TO FAR with a running
//   visibility budget: each band is granted w = min(blurred alpha,
//   visibility remaining), so nearer content occludes exactly the
//   share of the pixel it covers and the tent halves of an in-focus
//   pixel (0.5 + 0.5) add up to full opacity. The classic far-to-near
//   "over" with its telescoped product would leave 0.75 coverage
//   there and let the BACKGROUND leak through a sharp foreground edge
//   - the very disease this path exists to cure. Output alpha is the
//   granted coverage (<= 1 by construction); on opaque input it reads
//   1 everywhere except within a pixel or two of a depth seam, where
//   per-band kernel sizes make the blurred coverages sum to slightly
//   less than 1 - physically honest, and the RGB is normalized by the
//   same coverage so no seam darkens.
// - Band order is by signed defocus; with field_curve bending the
//   focal plane per pixel, the order is exact at frame center and an
//   approximation toward the corners (the bands still sort near to far
//   RELATIVE to the local plane, which is the order that matters).
//
// Determinism: every gather accumulates taps in kernel order per
// pixel, the reductions that feed control flow (band bounding boxes)
// are min/max and order-free, and the composite visits bands in a
// fixed far-to-near sequence per pixel. Two renders are identical
// bits.
//
// Scene-linear and HDR-safe throughout: no clamp touches a color
// channel anywhere below (the unclamped-highlight rule); the only
// clamps are on geometry (coordinates), on membership weights (already
// in [0,1] by construction), and on the output ALPHA, never on light.
// ---------------------------------------------------------------------

/// Slice count: the signed-defocus axis [-1, 1] is cut into this many
/// bands. 16 makes the radius quantization step max_r/32 - finer than
/// the gather path's 3-level ramp - while keeping the per-band bounding
/// boxes worth their overhead on real depth maps.
/// The frame-side measures the disc and the halo are built from, as
/// fractions of the frame's short side: the disc at full aperture, the
/// fringe's stretch of it, the swirl's stretch of it at the corner, and
/// the halo's gaussian sigma. Named once so dof_reach cannot drift from
/// the op that draws them.
pub(crate) const DISC_MAX: f32 = 0.03;
pub(crate) const FRINGE_STRETCH: f32 = 0.35;
pub(crate) const SWIRL_STRETCH: f32 = 1.4;
pub(crate) const HALO_SIGMA: f32 = 0.015;

/// How far past any pixel the op reaches for its neighbors, as a
/// fraction of the frame's short side, from the node's raw dials
/// (0..100 as the panel writes them). The desktop's 1:1 patch grows its
/// slice by this so a sharp patch's edge blurs exactly as the fit view
/// does; it calls here rather than copying the constants, which is the
/// only way the margin and the disc stay the same size.
pub fn dof_reach(aperture: f32, fringe: f32, swirl: f32, glow: f32) -> f32 {
    if aperture <= 0.0 {
        return 0.0;
    }
    let stretch = (1.0 + fringe.max(0.0) / 100.0 * FRINGE_STRETCH)
        * (1.0 + swirl.max(0.0) / 100.0 * SWIRL_STRETCH);
    let mut reach = (aperture / 100.0).min(1.0) * DISC_MAX * stretch;
    if glow > 0.0 {
        // Two and a half sigmas of the halo's gaussian.
        reach += 2.5 * HALO_SIGMA;
    }
    reach
}

const DOF_SLICES: usize = 16;

/// The signed-defocus and coc planes, computed with the very same
/// mapping the gather path uses inline (focus plus the quadratic field
/// curvature, signed = far - focal, coc = |signed| clamped). Copied
/// expression for expression rather than shared, so the gather path's
/// bytes stay under glass until the cutover ruling.
fn dof_planes(far: &[f32], w: usize, h: usize, focus: f32, field_curve: f32, roi: [f32; 4]) -> (Vec<f32>, Vec<f32>) {
    let mut signed = vec![0.0f32; w * h];
    let mut coc = vec![0.0f32; w * h];
    use rayon::prelude::*;
    signed
        .par_chunks_mut(w)
        .zip(coc.par_chunks_mut(w))
        .enumerate()
        .for_each(|(y, (s_row, c_row))| {
            for x in 0..w {
                let i = y * w + x;
                // Field curvature: the focal plane bends with the square
                // of the distance from the FRAME center (0 center, ~1
                // corner). The buffer may be a patch of that frame, so
                // the pixel's frame position comes from the roi rect;
                // at the default (the whole frame) fx/fy reduce to
                // x/w and y/h bit for bit.
                let fx = roi[0] + (x as f32 / w as f32) * roi[2];
                let fy = roi[1] + (y as f32 / h as f32) * roi[3];
                let r2 = ((fx - 0.5).powi(2) + (fy - 0.5).powi(2)) * 2.0;
                let focal = (focus + field_curve * 0.6 * r2).clamp(0.0, 1.0);
                let s = far[i] - focal;
                s_row[x] = s;
                c_row[x] = s.abs().clamp(0.0, 1.0);
            }
        });
    (signed, coc)
}

/// Band k's signed-defocus center: DOF_SLICES bands tiling [-1, 1],
/// negative nearer than the focal plane, positive beyond it.
fn dof_slice_center(k: usize) -> f32 {
    ((k as f32 + 0.5) / DOF_SLICES as f32) * 2.0 - 1.0
}

/// Tent membership: 1 at the band center, 0 at both neighbors'
/// centers, so the weights partition unity at every signed defocus and
/// a flat frame's coverage sums to exactly one slice's worth. The
/// centers sit 2/N apart, so the tent's halfwidth is 2/N: narrower
/// would leave the midpoints between centers covered by NOTHING.
fn dof_slice_weight(signed: f32, k: usize) -> f32 {
    (1.0 - (signed - dof_slice_center(k)).abs() * (DOF_SLICES as f32 * 0.5)).max(0.0)
}

/// The band's blur radius: max_r at HALF A TENT plane-ward of the band
/// center (see the design comment), so the two bands straddling the
/// focal plane are exactly zero and the ramp still reaches ~max_r at
/// the ends. A member's true coc sits within one band step of the
/// center, so the disc error is at most max_r/N - finer than the
/// gather path's three-level ghost ramp.
fn dof_slice_radius(k: usize, max_r: f32) -> f32 {
    (max_r * (dof_slice_center(k).abs() - 1.0 / DOF_SLICES as f32)).max(0.0)
}

/// The frame region every band occupies (membership > 0), as
/// (x0, y0, x1, y1) with x1/y1 exclusive, None where a band is empty.
/// One fused scan of the signed plane: a pixel's tent reaches at most
/// the two bands its defocus falls between, so each pixel updates two
/// boxes instead of sixteen scans rereading the plane. The reductions
/// are min/max: exact however rayon splits the rows, which is what
/// keeps the slicing deterministic.
fn dof_slice_bboxes(signed: &[f32], w: usize, h: usize) -> [Option<(usize, usize, usize, usize)>; DOF_SLICES] {
    use rayon::prelude::*;
    const NONE: (usize, usize, usize, usize) = (usize::MAX, usize::MAX, 0, 0);
    let half = 2.0 / DOF_SLICES as f32;
    let row_scan = |y: usize| {
        let mut boxes = [NONE; DOF_SLICES];
        for x in 0..w {
            let s = signed[y * w + x];
            // The candidate bands: the two tent centers bracketing s.
            let t = ((s + 1.0) * (DOF_SLICES as f32 * 0.5) - 0.5)
                .clamp(0.0, (DOF_SLICES - 1) as f32);
            let k0 = t.floor() as usize;
            for k in [k0, (k0 + 1).min(DOF_SLICES - 1)] {
                // The same membership test dof_slice_weight answers:
                // strictly inside the tent.
                if (s - dof_slice_center(k)).abs() < half {
                    let b = &mut boxes[k];
                    b.0 = b.0.min(x);
                    b.1 = b.1.min(y);
                    b.2 = b.2.max(x + 1);
                    b.3 = b.3.max(y + 1);
                }
            }
        }
        boxes
    };
    let merged = (0..h).into_par_iter().map(row_scan).reduce(
        || [NONE; DOF_SLICES],
        |mut a, b| {
            for k in 0..DOF_SLICES {
                a[k].0 = a[k].0.min(b[k].0);
                a[k].1 = a[k].1.min(b[k].1);
                a[k].2 = a[k].2.max(b[k].2);
                a[k].3 = a[k].3.max(b[k].3);
            }
            a
        },
    );
    merged.map(|b| {
        if b.0 == usize::MAX {
            None
        } else {
            Some(b)
        }
    })
}

/// One band's blurred, premultiplied frame, stored only over the
/// region the blur can reach: (x0, y0) is the region's origin in frame
/// coordinates. Outside the region the band is exactly nothing.
struct DofSlice {
    x0: usize,
    y0: usize,
    buf: ImageBuf,
}

/// Blur one band's premultiplied content through its aperture
/// kernel(s), gathering only inside `region`. `premult` holds the
/// band's content over its bounding box at origin (px0, py0) in a
/// fw x fh frame; taps outside the bbox read zero (the membership
/// there is zero by construction) and taps outside the frame clamp to
/// the frame edge first, the old gather's own border policy, so a band
/// living against the frame edge replicates there exactly as the
/// gather path does.
///
/// radii are per channel [r, g, b, a]: the fringe split blurs red and
/// blue through slightly different radii. Channels sharing a radius
/// share one kernel and one gather; the common no-fringe case is a
/// single kernel gathering all four channels, the same shape and tap
/// order bokeh_blur uses.
#[allow(clippy::too_many_arguments)]
fn dof_slice_blur(
    premult: &ImageBuf,
    px0: usize,
    py0: usize,
    fw: usize,
    fh: usize,
    radii: [f32; 4],
    blades: u32,
    curve: f32,
    shape: DiscShape,
    region: (usize, usize, usize, usize),
    roi: [f32; 4],
) -> ImageBuf {
    // The swirl makes the kernel depend on where the pixel sits about
    // the frame center: its variants are built up front, one per
    // sector and ring, and each pixel picks its own below. Without
    // swirl there is one variant and the plain path runs unchanged.
    let variants = if shape.swirl > 0.0 { SWIRL_SECTORS * SWIRL_RINGS } else { 1 };
    let variant_of = |v: usize| -> (f32, f32) {
        if shape.swirl <= 0.0 {
            return (1.0, 0.0);
        }
        let sector = v % SWIRL_SECTORS;
        let ring = v / SWIRL_SECTORS;
        let r_norm = (ring as f32 + 0.5) / SWIRL_RINGS as f32;
        // Tangential: a quarter turn past the pixel's own direction.
        let angle = (sector as f32 + 0.5) / SWIRL_SECTORS as f32 * std::f32::consts::TAU
            + std::f32::consts::FRAC_PI_2;
        (1.0 + shape.swirl * SWIRL_STRETCH * r_norm, angle)
    };
    // One kernel per DISTINCT radius (bitwise) per variant: no fringe
    // and no swirl means one.
    let mut kernels: Vec<(f32, Vec<(i32, i32, f32)>, f32)> = Vec::new();
    let mut kidx = [0usize; 4];
    let mut radius_slots: Vec<f32> = Vec::new();
    for (c, &r) in radii.iter().enumerate() {
        match radius_slots.iter().position(|kr| kr.to_bits() == r.to_bits()) {
            Some(pos) => kidx[c] = pos,
            None => {
                radius_slots.push(r);
                kidx[c] = radius_slots.len() - 1;
            }
        }
    }
    for &r in &radius_slots {
        for v in 0..variants {
            let (elong, angle) = variant_of(v);
            let (taps, wsum) = aperture_kernel_shaped(r, blades, curve, shape, elong, angle);
            kernels.push((r, taps, wsum));
        }
    }
    // kernels[slot * variants + variant]
    // The swirl anchors on the FRAME center (spec-vintage-lens.md's
    // ruling), so a 1:1 sharp slice spins about the same point the fit
    // view does: roi is the buffer's rect in frame fractions, and the
    // frame's own size in buffer pixels follows from it. At the
    // default (the whole frame) every term reduces to fw/2, fh/2 and
    // the old half diagonal, bit for bit.
    let fw_px = snap_frame(fw as f32 / roi[2]);
    let fh_px = snap_frame(fh as f32 / roi[3]);
    let (cx, cy) = ((0.5 - roi[0]) * fw_px, (0.5 - roi[1]) * fh_px);
    let half_diag = ((fw_px * 0.5) * (fw_px * 0.5) + (fh_px * 0.5) * (fh_px * 0.5))
        .sqrt()
        .max(1.0);
    let pick = |gx: usize, gy: usize| -> usize {
        if variants == 1 {
            return 0;
        }
        let dx = gx as f32 + 0.5 - cx;
        let dy = gy as f32 + 0.5 - cy;
        let r_norm = ((dx * dx + dy * dy).sqrt() / half_diag).min(0.999);
        let ring = (r_norm * SWIRL_RINGS as f32) as usize;
        let ang = dy.atan2(dx).rem_euclid(std::f32::consts::TAU);
        let sector = ((ang / std::f32::consts::TAU) * SWIRL_SECTORS as f32) as usize % SWIRL_SECTORS;
        ring * SWIRL_SECTORS + sector
    };
    let max_off = kernels
        .iter()
        .flat_map(|(_, taps, _)| taps.iter())
        .map(|(dx, dy, _)| dx.unsigned_abs().max(dy.unsigned_abs()) as usize)
        .max()
        .unwrap_or(0);
    let (ox0, oy0, ox1, oy1) = region;
    let (ow, oh) = (ox1 - ox0, oy1 - oy0);
    let (pw, ph) = (premult.width, premult.height);
    let single = radius_slots.len() == 1;
    let mut out = ImageBuf::new(ow, oh);
    use rayon::prelude::*;
    out.data
        .par_chunks_mut(ow * 4)
        .enumerate()
        .for_each(|(ry, row)| {
            let gy = oy0 + ry;
            for rx in 0..ow {
                let gx = ox0 + rx;
                let mut acc = [0.0f32; 4];
                // The interior fast path: every tap of the largest
                // kernel lands inside the premult bbox, so no frame
                // clamp and no zero test can fire. Same taps, same
                // order, same sums as the slow path.
                let interior = gx >= px0 + max_off
                    && gx + max_off < px0 + pw
                    && gy >= py0 + max_off
                    && gy + max_off < py0 + ph;
                let variant = pick(gx, gy);
                if single {
                    let (_, taps, wsum) = &kernels[variant];
                    if interior {
                        for (dx, dy, tw) in taps {
                            let s = (((gy as i32 + dy) as usize - py0) * pw
                                + ((gx as i32 + dx) as usize - px0))
                                * 4;
                            for (c, a) in acc.iter_mut().enumerate() {
                                *a += premult.data[s + c] * tw;
                            }
                        }
                    } else {
                        for (dx, dy, tw) in taps {
                            let cx = (gx as i32 + dx).clamp(0, fw as i32 - 1) as usize;
                            let cy = (gy as i32 + dy).clamp(0, fh as i32 - 1) as usize;
                            if cx >= px0 && cx < px0 + pw && cy >= py0 && cy < py0 + ph {
                                let s = ((cy - py0) * pw + (cx - px0)) * 4;
                                for (c, a) in acc.iter_mut().enumerate() {
                                    *a += premult.data[s + c] * tw;
                                }
                            }
                        }
                    }
                    for (c, o) in row[rx * 4..rx * 4 + 4].iter_mut().enumerate() {
                        *o = acc[c] / wsum;
                    }
                } else {
                    // The fringed case: each channel gathers through its
                    // own radius's kernel and normalizes by that
                    // kernel's own weight sum.
                    for k in 0..radius_slots.len() {
                        let (_, taps, _) = &kernels[k * variants + variant];
                        for (dx, dy, tw) in taps {
                            let (sx, sy) = if interior {
                                ((gx as i32 + dx) as usize, (gy as i32 + dy) as usize)
                            } else {
                                (
                                    (gx as i32 + dx).clamp(0, fw as i32 - 1) as usize,
                                    (gy as i32 + dy).clamp(0, fh as i32 - 1) as usize,
                                )
                            };
                            if sx >= px0 && sx < px0 + pw && sy >= py0 && sy < py0 + ph {
                                let s = ((sy - py0) * pw + (sx - px0)) * 4;
                                for c in 0..4 {
                                    if kidx[c] == k {
                                        acc[c] += premult.data[s + c] * tw;
                                    }
                                }
                            }
                        }
                    }
                    for (c, o) in row[rx * 4..rx * 4 + 4].iter_mut().enumerate() {
                        *o = acc[c] / kernels[kidx[c] * variants + variant].2;
                    }
                }
            }
        });
    out
}

/// The layered depth of field itself. Same controls, same CoC mapping,
/// same aperture and glow as the gather path; only the blur's
/// STRUCTURE changes (see the design comment above). Returns the
/// finished frame, glow included.
#[allow(clippy::too_many_arguments)]
fn dof_layered(
    src: &ImageBuf,
    far: &[f32],
    aperture: f32,
    focus: f32,
    blades: u32,
    blade_curve: f32,
    fringe: f32,
    field_curve: f32,
    glow: f32,
    shape: DiscShape,
    roi: [f32; 4],
) -> ImageBuf {
    let (w, h) = (src.width, src.height);
    // Aperture discs and the halo are measured against the FRAME's
    // short side, so a sharp 1:1 slice blurs at the fit view's radius
    // in the same pixels: roi is the buffer's rect in frame fractions,
    // and the divide is exact at the default (the whole frame).
    // Snapped like Depth Lighting's frame: the disc is a continuous
    // size, so the f32 wobble moved nothing visible here, but one
    // reconstruction rule for the file is one fewer thing to reason
    // about (the fourth pre-merge review's R5).
    let short = snap_frame(w as f32 / roi[2]).min(snap_frame(h as f32 / roi[3]));
    let max_r = aperture * short * DISC_MAX;
    use rayon::prelude::*;
    let (signed, coc_plane) = dof_planes(far, w, h, focus, field_curve, roi);

    // Build the bands: bounding box, premultiplied content, blur.
    // Bands are independent, so they build in parallel; collect keeps
    // the order and every reduction inside is order-free, so the band
    // set is deterministic. Empty bands (no memberships anywhere: a
    // photo whose depth never visits that defocus) cost exactly the
    // bbox scan.
    let bboxes = dof_slice_bboxes(&signed, w, h);
    let slices: Vec<Option<DofSlice>> = (0..DOF_SLICES)
        .into_par_iter()
        .map(|k| {
            let (x0, y0, x1, y1) = bboxes[k]?;
            let (bw, bh) = (x1 - x0, y1 - y0);
            // Premultiply: color * coverage, coverage = membership *
            // source alpha. An opaque photograph's coverage is just the
            // tent weight.
            let mut premult = ImageBuf::new(bw, bh);
            premult
                .data
                .par_chunks_mut(bw * 4)
                .enumerate()
                .for_each(|(ry, prow)| {
                    let gy = y0 + ry;
                    for rx in 0..bw {
                        let gx = x0 + rx;
                        let i = gy * w + gx;
                        let cov = dof_slice_weight(signed[i], k) * src.data[i * 4 + 3];
                        for c in 0..3 {
                            prow[rx * 4 + c] = src.data[i * 4 + c] * cov;
                        }
                        prow[rx * 4 + 3] = cov;
                    }
                });
            let r = dof_slice_radius(k, max_r);
            // The fringe split, resolved once per band: red blurs wider
            // behind the plane, blue wider in front, exactly the gather
            // path's sign rule at the band's center.
            let split = fringe * FRINGE_STRETCH * dof_slice_center(k).signum();
            let radii = [
                (r * (1.0 + split)).max(0.0),
                r,
                (r * (1.0 - split)).max(0.0),
                r,
            ];
            // Under half a pixel the aperture gather is the identity
            // (the gather path's own early-out), so the band composites
            // unblurred over just its bbox.
            if radii.iter().all(|&rr| rr < 0.5) {
                return Some(DofSlice { x0, y0, buf: premult });
            }
            // The blur spreads content at most ceil(radius) + 1 taps
            // past the bbox; composite over exactly that reach. Taps
            // of the strided kernel never exceed the kernel radius.
            let pad = radii.iter().fold(0.0f32, |a, &b| a.max(b)).ceil() as usize + 1;
            let region = (
                x0.saturating_sub(pad),
                y0.saturating_sub(pad),
                (x1 + pad).min(w),
                (y1 + pad).min(h),
            );
            let buf = dof_slice_blur(&premult, x0, y0, w, h, radii, blades, blade_curve, shape, region, roi);
            Some(DofSlice {
                x0: region.0,
                y0: region.1,
                buf,
            })
        })
        .collect();

    // Composite near to far with a running visibility budget (see the
    // design comment): each band gets w = min(its blurred coverage,
    // the visibility not already taken by nearer bands), its
    // premultiplied color scaled by w / alpha, so partial tent
    // memberships ADD to full opacity instead of multiplying into a
    // leak. Normalizing by the granted coverage turns the
    // accumulation back into colors; where coverage is full (all but
    // a pixel or two around depth seams) the divide is exact.
    //
    // PERF: the loop is slice-major within a row, not pixel-major:
    // each band visits only the x-span its region covers, so empty and
    // off-row bands cost nothing, and the per-pixel accumulators ride
    // in row-local scratch. Every pixel still spends its visibility in
    // the same fixed near-to-far band order with the same sequence of
    // adds, so the frame is bit for bit the pixel-major loop's.
    let mut out = ImageBuf::new(w, h);
    out.data
        .par_chunks_mut(w * 4)
        .enumerate()
        .for_each(|(y, row)| {
            let mut acc = vec![[0.0f32; 4]; w];
            let mut rem = vec![1.0f32; w];
            for k in 0..DOF_SLICES {
                // The nearest band spends from the budget first.
                let Some(s) = &slices[k] else { continue };
                if y < s.y0 || y - s.y0 >= s.buf.height {
                    continue;
                }
                let qrow = (y - s.y0) * s.buf.width;
                let (sx0, sx1) = (s.x0, (s.x0 + s.buf.width).min(w));
                for x in sx0..sx1 {
                    let r = rem[x];
                    if r <= 0.0 {
                        continue;
                    }
                    let q = (qrow + (x - s.x0)) * 4;
                    let sa = s.buf.data[q + 3];
                    if sa <= 0.0 {
                        continue;
                    }
                    let wgt = sa.min(r);
                    let scale = wgt / sa;
                    for c in 0..3 {
                        acc[x][c] += s.buf.data[q + c] * scale;
                    }
                    acc[x][3] += wgt;
                    rem[x] = r - wgt;
                }
            }
            for x in 0..w {
                // The floor only engages where NO band reaches, which
                // cannot happen (every pixel carries full membership in
                // some band); it exists so the divide is total.
                let a = acc[x][3].max(1e-6);
                for c in 0..3 {
                    row[x * 4 + c] = acc[x][c] / a;
                }
                row[x * 4 + 3] = acc[x][3].clamp(0.0, 1.0);
            }
        });

    // Spherical aberration's halo, verbatim from the gather path: the
    // bright, IN-FOCUS points bleed a soft envelope. Scene-linear
    // addition, coc from this path's own plane.
    if glow > 0.0 {
        let thresh = to_scene(0.82);
        let mut bright = ImageBuf::new(w, h);
        bright.data
            .par_chunks_mut(4)
            .enumerate()
            .for_each(|(i, b)| {
                let coc = coc_plane[i];
                let l = 0.2126 * out.data[i * 4]
                    + 0.7152 * out.data[i * 4 + 1]
                    + 0.0722 * out.data[i * 4 + 2];
                let sharp = (1.0 - coc / 0.15).clamp(0.0, 1.0);
                let lift = ((l - thresh) / thresh.max(1e-3)).clamp(0.0, 4.0) * sharp;
                if lift > 0.0 {
                    for c in 0..3 {
                        b[c] = out.data[i * 4 + c] * lift;
                    }
                    b[3] = 1.0;
                }
            });
        // A fraction of the frame, so the reduced path (see Halation):
        // sigma 60 on a 24 MP export was 1.5 s of direct kernel.
        let halo = gaussian_blur_wide(&bright, (short * HALO_SIGMA).max(2.0));
        out.data
            .par_chunks_mut(4)
            .zip(halo.data.par_chunks(4))
            .for_each(|(o, ha)| {
                for c in 0..3 {
                    o[c] += ha[c] * glow * 0.9;
                }
            });
    }
    out
}

#[cfg(test)]
mod tests {
    /// Bench for the render-pass work: runs the key light over a beauty
    /// and farness plane dumped as raw f32 (HEELER_KEYLIGHT_DUMP names
    /// the folder with beauty.f32, far.f32 and dims.txt; FAR overrides
    /// the plane file) and writes gain.pgm, the gain per pixel as gray
    /// with 1.0 at 128, for a look at what the cliff handling does to an
    /// exact silhouette. MEASURED=1 runs the measured contract, the
    /// mark the executor would plant for a file's own pass. Ignored: a
    /// tool, not a check.
    #[test]
    #[ignore]
    fn keylight_gain_dump() {
        use crate::buffers::{ImageBuf, Value};
        use crate::ops::test_util::{make_node, set_num};
        use std::sync::Arc;
        let Ok(dir) = std::env::var("HEELER_KEYLIGHT_DUMP") else { return };
        let dims = std::fs::read_to_string(format!("{dir}/dims.txt")).unwrap();
        let mut it = dims.split_whitespace().map(|v| v.parse::<usize>().unwrap());
        let (w, h) = (it.next().unwrap(), it.next().unwrap());
        let floats = |name: &str| -> Vec<f32> {
            let b = std::fs::read(name).unwrap();
            b.chunks_exact(4).map(|c| f32::from_le_bytes([c[0], c[1], c[2], c[3]])).collect()
        };
        let far_file = std::env::var("FAR").unwrap_or(format!("{dir}/far.f32"));
        let beauty = floats(&format!("{dir}/beauty.f32"));
        let exact = floats(&format!("{dir}/far.f32"));
        // FAR may be one of the app's cached rasters (16-bit PNG).
        let far: Vec<f32> = if far_file.ends_with(".png") {
            let img = heeler_io::decode_png_raw(&std::fs::read(&far_file).unwrap()).unwrap();
            assert_eq!((img.width, img.height), (w, h));
            img.data.chunks_exact(4).map(|p| p[0]).collect()
        } else {
            floats(&far_file)
        };
        if far_file != format!("{dir}/far.f32") {
            let diffs: Vec<f32> = far.iter().zip(&exact).map(|(a, b)| (a - b).abs()).collect();
            let mean = diffs.iter().sum::<f32>() / diffs.len() as f32;
            let max = diffs.iter().cloned().fold(0f32, f32::max);
            let moved = diffs.iter().filter(|d| **d > 0.02).count() as f32 / diffs.len() as f32 * 100.0;
            println!("plane vs exact: mean {mean:.4}, max {max:.4}, moved past 0.02 at {moved:.1}% of pixels");
            let y = std::env::var("ROW").ok().and_then(|v| v.parse::<usize>().ok()).unwrap_or(h * 3 / 4);
            let row: Vec<String> = (0..w).step_by(w / 48).map(|x| format!("{:.2}|{:.2}", exact[y * w + x], far[y * w + x])).collect();
            println!("row {y} exact|plane: {}", row.join(" "));
        }
        let mut src = ImageBuf::new(w, h);
        src.data.copy_from_slice(&beauty);
        let mut plane = ImageBuf::new(w, h);
        for (i, f) in far.iter().enumerate() {
            plane.data[i * 4] = *f;
            plane.data[i * 4 + 3] = 1.0;
        }
        let mut node = make_node("heeler.key_light");
        set_num(&mut node, "strength", std::env::var("STRENGTH").ok().and_then(|v| v.parse().ok()).unwrap_or(174.0));
        set_num(&mut node, "azimuth", 45.0);
        set_num(&mut node, "elevation", 45.0);
        set_num(&mut node, "ambient", 50.0);
        set_num(&mut node, "relief", 30.0);
        if std::env::var("MEASURED").is_ok_and(|v| v == "1") {
            set_num(&mut node, "depth_measured", 1.0);
        }
        let out = super::key_light(&node, &[("in".to_string(), Value::Image(Arc::new(src.clone()))), ("raster".to_string(), Value::Image(Arc::new(plane)))]).unwrap();
        let out = out.as_image().unwrap();
        let mut pgm = format!("P5\n{w} {h}\n255\n").into_bytes();
        for i in 0..w * h {
            let s = src.data[i * 4 + 1].max(1e-4);
            let g = out.data[i * 4 + 1] / s;
            pgm.push(((g * 128.0).round().clamp(0.0, 255.0)) as u8);
        }
        let name = std::env::var("OUT").unwrap_or(format!("{dir}/gain.pgm"));
        std::fs::write(&name, pgm).unwrap();
        println!("wrote {name}");
    }

    /// The model path, pinned: the measured-plane contract lives in the
    /// same op, and the estimated plane's shading, every tuning of it,
    /// must come out byte for byte what it was before the contract
    /// existed. Three renders over a noisy synthetic plane with a step in
    /// it, at a size that puts the reduced grid at two pixels a cell: the
    /// legacy directional, a rig with a colored point lamp, and the
    /// inverted field through the section's Levels. Their hashes over the
    /// raw f32 bits were bootstrapped from the code as it stood before
    /// this change, before the measured branch; a change to them is a
    /// change to the model path. Platform libms differ in their last bits,
    /// so as with the chain goldens macOS keeps the unsuffixed file and
    /// every other platform keeps its own beside it, through the same
    /// helper the chains use: a platform line carries the macOS hash it
    /// was made against, a deliberate change on the Mac rebases the
    /// platform file (commit it), and a move on one platform alone is
    /// drift and fails. This test compared the platform file as it was, so
    /// the 26.3.1 halo change on the Mac failed every Windows run until
    /// the file was rewritten by hand (2026-09-24: "every time I try to
    /// build on windows this happens").
    #[test]
    fn the_model_path_renders_the_pinned_gains() {
        use crate::golden_baseline;
        use crate::buffers::{ImageBuf, Value};
        use crate::ops::test_util::{make_node, set_num, set_text};
        use std::sync::Arc;
        let (w, h) = (400usize, 300);
        let mut plane = ImageBuf::new(w, h);
        let mut beauty = ImageBuf::new(w, h);
        for y in 0..h {
            for x in 0..w {
                let (fx, fy) = (x as f32 / w as f32, y as f32 / h as f32);
                let mut far = 0.25 + 0.5 * fx + 0.04 * (super::fractal_noise(x as f32 * 0.21, y as f32 * 0.21) - 0.5);
                if (fx - 0.5).powi(2) + (fy - 0.5).powi(2) < 0.05 {
                    far = 0.15 + 0.03 * super::fractal_noise(x as f32 * 0.5, y as f32 * 0.5);
                }
                plane.set_pixel(x, y, [far, far, far, 1.0]);
                let v = 0.2 + 0.3 * fy;
                beauty.set_pixel(x, y, [v, v * 0.9, v * 0.8, 1.0]);
            }
        }
        let inputs = |normal: bool| {
            let mut v = vec![("in".to_string(), Value::Image(Arc::new(beauty.clone()))), ("raster".to_string(), Value::Image(Arc::new(plane.clone())))];
            if normal {
                v.push(("normal".to_string(), Value::Image(Arc::new(ImageBuf::filled(w, h, [0.5, 0.5, 0.5, 1.0])))));
            }
            v
        };
        let hash = |img: &ImageBuf| -> u64 {
            let mut acc: u64 = 0xcbf2_9ce4_8422_2325;
            for v in &img.data {
                acc = (acc ^ v.to_bits() as u64).wrapping_mul(0x0000_0100_0000_01b3);
            }
            acc ^ ((img.width as u64) << 32) ^ img.height as u64
        };
        let mut lines = Vec::new();
        let mut legacy = make_node("heeler.key_light");
        set_num(&mut legacy, "strength", 120.0);
        set_num(&mut legacy, "azimuth", 30.0);
        set_num(&mut legacy, "elevation", 40.0);
        set_num(&mut legacy, "relief", 40.0);
        lines.push(format!("legacy directional {:016x}", hash(super::key_light(&legacy, &inputs(false)).unwrap().as_image().unwrap())));
        let mut rig = make_node("heeler.key_light");
        set_text(
            &mut rig,
            "lights",
            r##"[{"kind":"directional","azimuth":-60,"elevation":25,"strength":-90,"color":"#ff8040"},{"kind":"point","px":0.6,"py":0.45,"depth":30,"range":40,"strength":150,"color":"#80c0ff"}]"##,
        );
        set_num(&mut rig, "ambient", 30.0);
        set_num(&mut rig, "relief", 55.0);
        lines.push(format!("rig with a lamp {:016x}", hash(super::key_light(&rig, &inputs(true)).unwrap().as_image().unwrap())));
        let mut levelled = make_node("heeler.key_light");
        set_num(&mut levelled, "strength", 160.0);
        set_num(&mut levelled, "azimuth", 100.0);
        set_num(&mut levelled, "elevation", 60.0);
        set_num(&mut levelled, "depth_black", 0.1);
        set_num(&mut levelled, "depth_white", 0.85);
        set_num(&mut levelled, "depth_gamma", 1.4);
        levelled.params.insert("invert".into(), heeler_graph::ParamValue::Bool(true));
        lines.push(format!("inverted through levels {:016x}", hash(super::key_light(&levelled, &inputs(false)).unwrap().as_image().unwrap())));
        golden_baseline::check_or_bootstrap("golden_keylight_model_path.txt", golden_baseline::Baseline::Committed, &lines);
    }

    /// The measured contract on an exact plane (the fixture in
    /// miniature): a sphere in front of a floor that recedes upward,
    /// under a directional light from the right. The floor beside the
    /// sphere shades from the floor's own height, so a one-pixel ring
    /// of ground around the sphere reads exactly what the same row
    /// reads far from it (no bright ring, under a light or a dark
    /// light); the sphere's interior carries a lit flank and a dark
    /// flank (no ripple gate flattening its curvature); and the
    /// silhouette is one pixel wide: the last ground pixel is ground,
    /// the first sphere pixel is sphere.
    #[test]
    fn a_measured_sphere_shades_to_its_edge_and_lends_the_ground_nothing() {
        use crate::buffers::{ImageBuf, Value};
        use crate::ops::test_util::{make_node, set_num};
        use std::sync::Arc;
        let (w, h) = (320usize, 240);
        let (cx, cy, r) = (160.0f32, 120.0f32, 60.0f32);
        let mut plane = ImageBuf::new(w, h);
        let mut inside = vec![false; w * h];
        for y in 0..h {
            for x in 0..w {
                let floor = 0.55 + 0.35 * y as f32 / h as f32;
                let r2 = ((x as f32 - cx) / r).powi(2) + ((y as f32 - cy) / r).powi(2);
                let far = if r2 < 1.0 {
                    inside[y * w + x] = true;
                    0.3 - 0.15 * (1.0 - r2).sqrt()
                } else {
                    floor
                };
                plane.set_pixel(x, y, [far, far, far, 1.0]);
            }
        }
        let src = Arc::new(ImageBuf::filled(w, h, [0.3, 0.3, 0.3, 1.0]));
        let plane = Arc::new(plane);
        for strength in [100.0f64, -100.0] {
            let mut node = make_node("heeler.key_light");
            set_num(&mut node, "strength", strength);
            set_num(&mut node, "azimuth", 0.0);
            set_num(&mut node, "elevation", 35.0);
            set_num(&mut node, "ambient", 20.0);
            set_num(&mut node, "depth_measured", 1.0);
            let out = super::key_light(&node, &[("in".to_string(), Value::Image(src.clone())), ("raster".to_string(), Value::Image(plane.clone()))]).unwrap();
            let img = out.as_image().unwrap();
            let gain = |x: usize, y: usize| img.pixel(x, y)[0] / 0.3;
            // The ring: every ground pixel with a sphere pixel beside it.
            let mut ring = 0;
            for y in 1..h - 1 {
                for x in 1..w - 1 {
                    let i = y * w + x;
                    if inside[i] || !(inside[i - 1] || inside[i + 1] || inside[i - w] || inside[i + w]) {
                        continue;
                    }
                    ring += 1;
                    let (here, own) = (gain(x, y), gain(8, y));
                    assert!((here - own).abs() < 1e-4, "strength {strength}: the ground at ({x},{y}) reads {here}, its row {own}");
                }
            }
            assert!(ring > 200, "the ring was found: {ring} pixels");
            // The floor's own slope is in y, so it shades at all.
            assert!((gain(8, 20) - gain(8, h - 20)).abs() > 0.02, "the floor shades from its own height: {} vs {}", gain(8, 20), gain(8, h - 20));
            // The sphere's interior: lit flank on the right, dark on
            // the left, neither flat.
            let (lit, dark, top) = (gain(cx as usize + 40, cy as usize), gain(cx as usize - 40, cy as usize), gain(cx as usize, cy as usize));
            if strength > 0.0 {
                assert!(lit > top + 0.02 && top > dark + 0.02, "a lit-to-dark gradient across the sphere: {lit} {top} {dark}");
            } else {
                assert!(lit < top - 0.02 && top < dark - 0.02, "a dark light darkens the flank that faces it: {lit} {top} {dark}");
            }
            // One pixel wide: along the center row, the last ground
            // pixel is the row's ground, the first sphere pixel is the
            // sphere's own, on both sides.
            let y = cy as usize;
            let mut edges = 0;
            for x in 1..w - 1 {
                let (a, b) = (inside[y * w + x - 1], inside[y * w + x]);
                if a == b {
                    continue;
                }
                edges += 1;
                let (ground_x, sphere_x) = if b { (x - 1, x) } else { (x, x - 1) };
                assert!((gain(ground_x, y) - gain(8, y)).abs() < 1e-4, "the last ground pixel at {ground_x} is ground");
                assert!((gain(sphere_x, y) - gain(8, y)).abs() > 0.02, "the first sphere pixel at {sphere_x} is not ground: {} vs {}", gain(sphere_x, y), gain(8, y));
            }
            assert_eq!(edges, 2);
        }
    }

    /// A planted normals raster steers the key light where the depth map
    /// is flat: normals facing the light brighten, normals facing away
    /// darken, and a pixel the pass leaves empty shades from the depth
    /// estimate.
    #[test]
    fn file_normals_steer_the_key_light() {
        use crate::buffers::{ImageBuf, Value};
        use crate::ops::test_util::{make_node, set_num};
        use std::sync::Arc;
        let (w, h) = (48usize, 32usize);
        let mut node = make_node("heeler.key_light");
        set_num(&mut node, "strength", 100.0);
        set_num(&mut node, "azimuth", 0.0);
        set_num(&mut node, "elevation", 45.0);
        set_num(&mut node, "ambient", 0.0);
        let src = Arc::new(ImageBuf::filled(w, h, [0.5, 0.5, 0.5, 1.0]));
        let flat = Arc::new(ImageBuf::filled(w, h, [0.5, 0.5, 0.5, 1.0]));
        let feed = |normals: Option<ImageBuf>| {
            let mut inputs = vec![("in".to_string(), Value::Image(src.clone())), ("raster".to_string(), Value::Image(flat.clone()))];
            if let Some(n) = normals {
                inputs.push(("normal".to_string(), Value::Image(Arc::new(n))));
            }
            let out = super::key_light(&node, &inputs).unwrap();
            out.as_image().unwrap().pixel(w / 2, h / 2)[0]
        };
        let pack = |n: [f32; 3]| [(n[0] + 1.0) / 2.0, (n[1] + 1.0) / 2.0, (n[2] + 1.0) / 2.0, 1.0];
        let base = feed(None);
        let s = std::f32::consts::FRAC_1_SQRT_2;
        let toward = feed(Some(ImageBuf::filled(w, h, pack([s, 0.0, s]))));
        let away = feed(Some(ImageBuf::filled(w, h, pack([-s, 0.0, s]))));
        let empty = feed(Some(ImageBuf::filled(w, h, pack([0.0, 0.0, 0.0]))));
        assert!(toward > base, "facing the light: {toward} vs {base}");
        assert!(away < base, "facing away: {away} vs {base}");
        assert!((empty - base).abs() < 1e-5, "no normal falls back: {empty} vs {base}");
    }

    use super::*;
    use crate::ops::test_util::{make_node, set_num};
    use heeler_graph::ParamValue;

    /// The plain shape is the plain kernel, tap for tap: every existing
    /// depth-of-field render is unchanged by the disc dials existing.
    #[test]
    fn a_plain_shape_is_the_plain_kernel() {
        for r in [0.8f32, 3.0, 9.5, 20.0] {
            let a = aperture_kernel(r, 6, 1.0);
            let b = aperture_kernel_shaped(r, 6, 1.0, DiscShape::default(), 1.0, 0.0);
            assert_eq!(a.0, b.0, "taps differ at r={r}");
            assert_eq!(a.1.to_bits(), b.1.to_bits());
        }
    }

    /// Bubble puts the weight on the rim; squeeze makes the disc tall;
    /// swirl stretches it along its angle.
    #[test]
    fn the_disc_dials_shape_the_kernel() {
        let flat = aperture_kernel_shaped(10.0, 9, 1.0, DiscShape::default(), 1.0, 0.0).0;
        let bubble = aperture_kernel_shaped(10.0, 9, 1.0, DiscShape { bubble: 1.0, ..Default::default() }, 1.0, 0.0).0;
        let at = |taps: &Vec<(i32, i32, f32)>, x: i32, y: i32| taps.iter().find(|t| t.0 == x && t.1 == y).map(|t| t.2).unwrap_or(0.0);
        assert!(at(&flat, 0, 0) > 0.9 && at(&bubble, 0, 0) < 0.05, "the bubble hollows the center");
        assert!(at(&bubble, 9, 0) > at(&bubble, 4, 0) * 3.0, "and climbs toward the rim");
        let tall = aperture_kernel_shaped(10.0, 9, 1.0, DiscShape { squeeze: -1.0, ..Default::default() }, 1.0, 0.0).0;
        let (fw, fh) = (flat.iter().map(|t| t.0.abs()).max().unwrap(), flat.iter().map(|t| t.1.abs()).max().unwrap());
        let (tw, th) = (tall.iter().map(|t| t.0.abs()).max().unwrap(), tall.iter().map(|t| t.1.abs()).max().unwrap());
        assert!(th > fh && tw == fw, "squeeze -100 makes the disc taller, not wider: {tw}x{th} vs {fw}x{fh}");
        let swirled = aperture_kernel_shaped(10.0, 9, 1.0, DiscShape { swirl: 1.0, ..Default::default() }, 2.0, 0.0).0;
        let (sw, sh) = (swirled.iter().map(|t| t.0.abs()).max().unwrap(), swirled.iter().map(|t| t.1.abs()).max().unwrap());
        assert!(sw >= fw * 2 - 1 && sh <= fh + 1, "elongated twice along its angle: {sw}x{sh}");
    }

    /// The swirl end to end: a highlight near the frame edge blurs into
    /// a tangential streak, one at the center into a round disc.
    #[test]
    fn swirl_stretches_edge_highlights_tangentially() {
        let mut node = make_node("heeler.dof");
        set_num(&mut node, "aperture", 60.0);
        set_num(&mut node, "focus", 0.0);
        set_num(&mut node, "swirl", 100.0);
        let (w, h) = (160usize, 120usize);
        let mut img = ImageBuf::filled(w, h, [0.0, 0.0, 0.0, 1.0]);
        // Two point highlights: one at the center, one on the right
        // edge's mid height (tangential direction is vertical there).
        img.set_pixel(80, 60, [10.0, 10.0, 10.0, 1.0]);
        img.set_pixel(150, 60, [10.0, 10.0, 10.0, 1.0]);
        // A plane far from the focus everywhere.
        let plane = ImageBuf::filled(w, h, [1.0, 1.0, 1.0, 1.0]);
        let out = crate::ops::execute(
            &node,
            &[
                ("in".to_string(), Value::Image(Arc::new(img))),
                ("raster".to_string(), Value::Image(Arc::new(plane))),
            ],
        )
        .unwrap();
        let out = out.as_image().unwrap();
        let extent = |x0: usize, y0: usize, dx: i32, dy: i32| -> usize {
            (1..40)
                .take_while(|&k| {
                    let x = x0 as i32 + dx * k;
                    let y = y0 as i32 + dy * k;
                    x >= 0 && y >= 0 && (x as usize) < w && (y as usize) < h && out.pixel(x as usize, y as usize)[0] > 0.01
                })
                .count()
        };
        let centre_v = extent(80, 60, 0, 1);
        let centre_h = extent(80, 60, 1, 0);
        assert!((centre_v as i32 - centre_h as i32).abs() <= 1, "center disc stays round: {centre_h}x{centre_v}");
        let edge_v = extent(150, 60, 0, 1);
        let edge_h = extent(150, 60, -1, 0);
        assert!(edge_v > edge_h + 2, "edge disc stretches tangentially (vertical here): {edge_h}x{edge_v}");
    }

    /// The swirl anchors on the FRAME center, so a 1:1 sharp slice of
    /// the same graph spins about the same point: the bottom-right
    /// quarter rendered as a patch (roi params set, buffer a quarter of
    /// the pixels) matches the whole-frame render pixel for pixel away
    /// from the patch's clamped edges. field_curve stays 0 here: its
    /// anchor moved too, but coordinate fractions are not powers of
    /// two, so a bent plane would legitimately differ by an ulp.
    #[test]
    fn swirl_on_a_patch_matches_the_whole_frame() {
        let setup = || {
            let mut node = make_node("heeler.dof");
            set_num(&mut node, "aperture", 60.0);
            set_num(&mut node, "focus", 0.0);
            set_num(&mut node, "swirl", 100.0);
            node
        };
        let (w, h) = (160usize, 120usize);
        // Structure the blur can show: two point highlights inside the
        // quarter the patch will cover, clear of its edges.
        let scene = |w: usize, h: usize, at: &[(usize, usize)]| {
            let mut img = ImageBuf::filled(w, h, [0.05, 0.04, 0.03, 1.0]);
            for &(x, y) in at {
                img.set_pixel(x, y, [10.0, 10.0, 10.0, 1.0]);
            }
            img
        };
        let run = |node: &Node, img: ImageBuf| {
            let plane = ImageBuf::filled(img.width, img.height, [1.0, 1.0, 1.0, 1.0]);
            crate::ops::execute(
                node,
                &[
                    ("in".to_string(), Value::Image(Arc::new(img))),
                    ("raster".to_string(), Value::Image(Arc::new(plane))),
                ],
            )
            .unwrap()
        };
        let whole = run(&setup(), scene(w, h, &[(100, 80), (140, 100)]));
        let whole = whole.as_image().unwrap().clone();
        let mut patch_node = setup();
        for (k, v) in [("roi_x", 0.5), ("roi_y", 0.5), ("roi_w", 0.5), ("roi_h", 0.5)] {
            set_num(&mut patch_node, k, v);
        }
        let patch = run(&patch_node, scene(80, 60, &[(20, 20), (60, 40)]));
        let patch = patch.as_image().unwrap();
        // Interior only: within the disc's reach of a patch edge the
        // taps clamp where the whole frame gathers real content (the
        // desktop's clone_reach margin covers exactly this).
        for y in 10..50usize {
            for x in 10..70usize {
                let a = whole.pixel(x + 80, y + 60);
                let b = patch.pixel(x, y);
                assert_eq!(a, b, "patch drifted at {x},{y}: {a:?} vs {b:?}");
            }
        }
        // Field curvature bends the plane about the same frame center,
        // on the same rect: a tolerance here, since the bend's frame
        // fractions are not powers of two and a patch may legitimately
        // differ by an ulp, but a patch bending about its OWN center
        // differs by whole pixels of blur.
        let bent = |mut node: Node, img: ImageBuf| {
            set_num(&mut node, "field_curve", 80.0);
            set_num(&mut node, "focus", 0.5);
            run(&node, img)
        };
        let whole = bent(setup(), scene(w, h, &[(100, 80), (140, 100)]));
        let whole = whole.as_image().unwrap().clone();
        let patch = bent(patch_node.clone(), scene(80, 60, &[(20, 20), (60, 40)]));
        let patch = patch.as_image().unwrap();
        let mut worst = 0.0f32;
        for y in 10..50usize {
            for x in 10..70usize {
                let a = whole.pixel(x + 80, y + 60);
                let b = patch.pixel(x, y);
                for c in 0..3 {
                    worst = worst.max((a[c] - b[c]).abs());
                }
            }
        }
        assert!(worst < 1e-3, "the bent patch drifted from the frame by {worst}");
    }


    fn frame(w: usize, h: usize, v: f32) -> Value {
        let mut img = ImageBuf::new(w, h);
        for px in img.data.chunks_mut(4) {
            px[0] = v;
            px[1] = v;
            px[2] = v;
            px[3] = 1.0;
        }
        Value::Image(Arc::new(img))
    }

    /// Farness ramp left (near) to right (far), as the injected raster.
    fn ramp_raster(w: usize, h: usize) -> (String, Value) {
        let mut img = ImageBuf::new(w, h);
        for y in 0..h {
            for x in 0..w {
                let v = x as f32 / (w - 1) as f32;
                img.set_pixel(x, y, [v, v, v, 1.0]);
            }
        }
        ("raster".to_string(), Value::Image(Arc::new(img)))
    }

    #[test]
    fn every_depth_op_is_a_passthrough_without_its_raster_or_at_neutral() {
        let (w, h) = (16usize, 8);
        for (ty, hot) in [
            ("heeler.fog", ("density", 60.0)),
            ("heeler.key_light", ("strength", 60.0)),
            ("heeler.dof", ("aperture", 60.0)),
        ] {
            // Neutral params, raster present: identity.
            let node = make_node(ty);
            let inputs = vec![("in".to_string(), frame(w, h, 0.25)), ramp_raster(w, h)];
            let run = |n: &Node, i: &[(String, Value)]| match ty {
                "heeler.fog" => fog(n, i).unwrap(),
                "heeler.key_light" => key_light(n, i).unwrap(),
                _ => dof(n, i).unwrap(),
            };
            let out = run(&node, &inputs);
            assert_eq!(out.as_image().unwrap().data[0], 0.25, "{ty} neutral must pass through");
            // Hot params, NO raster: still identity, never an error.
            let mut hot_node = make_node(ty);
            hot_node.params.insert(hot.0.into(), ParamValue::Number(hot.1));
            let bare = vec![("in".to_string(), frame(w, h, 0.25))];
            let out2 = run(&hot_node, &bare);
            assert_eq!(out2.as_image().unwrap().data[0], 0.25, "{ty} without depth must pass through");
        }
    }

    #[test]
    fn fog_thickens_with_farness_and_starts_where_told() {
        let (w, h) = (16usize, 8);
        let mut node = make_node("heeler.fog");
        node.params.insert("density".into(), ParamValue::Number(80.0));
        node.params.insert("fog_sat".into(), ParamValue::Number(0.0));
        let inputs = vec![("in".to_string(), frame(w, h, 0.02)), ramp_raster(w, h)];
        let out = fog(&node, &inputs).unwrap();
        let img = out.as_image().unwrap();
        let near = img.pixel(0, 4)[0];
        let mid = img.pixel(w / 2, 4)[0];
        let farv = img.pixel(w - 1, 4)[0];
        assert!(near < mid && mid < farv, "fog must thicken with farness: {near} {mid} {farv}");
        // start pushes the fog back: the near half goes clean.
        node.params.insert("start".into(), ParamValue::Number(50.0));
        let out2 = fog(&node, &inputs).unwrap();
        assert!((out2.as_image().unwrap().pixel(2, 4)[0] - 0.02).abs() < 1e-4, "before start there is no fog");
    }

    #[test]
    fn the_key_light_shades_slopes_and_leaves_flat_ground_alone() {
        let (w, h) = (64usize, 32);
        let mut node = make_node("heeler.key_light");
        node.params.insert("strength".into(), ParamValue::Number(100.0));
        node.params.insert("azimuth".into(), ParamValue::Number(0.0)); // from the right
        node.params.insert("elevation".into(), ParamValue::Number(35.0));
        // A ridge: near in the middle, far at both sides, a slope of
        // under one depth unit per short edge, the kind the plane
        // carries. The slope facing the light (right flank) must come
        // out brighter than the slope facing away (left flank).
        let mut depth = ImageBuf::new(w, h);
        for y in 0..h {
            for x in 0..w {
                let v = 0.1 + 0.8 * ((x as f32 / (w - 1) as f32) * 2.0 - 1.0).abs();
                depth.set_pixel(x, y, [v, v, v, 1.0]);
            }
        }
        let inputs = vec![
            ("in".to_string(), frame(w, h, 0.3)),
            ("raster".to_string(), Value::Image(Arc::new(depth))),
        ];
        let out = key_light(&node, &inputs).unwrap();
        let img = out.as_image().unwrap();
        let toward = img.pixel(w * 3 / 4, h / 2)[0]; // right flank rises toward the light
        let away = img.pixel(w / 4, h / 2)[0];
        assert!(toward > away, "the flank facing the light must brighten: {toward} vs {away}");
    }

    /// A cliff is not a slope: the step between a near thing and the far
    /// thing behind it must not be shaded as a bevel. The pixels either
    /// side of a hard step come out the same as flat ground far from it,
    /// while the gentle ridge in the test above still shades. The rim that
    /// replaced the bevel (2026-09-13): the subject's own shading must run
    /// to the last pixel before the cliff, not go flat in a band along it.
    /// A floor sloping in y beside a far wall, lit from the right: every
    /// floor pixel on a row shades the same, the ones touching the wall
    /// included.
    #[test]
    fn the_key_light_shades_a_surface_to_its_last_pixel_before_a_cliff() {
        let (w, h) = (240usize, 120);
        let mut node = make_node("heeler.key_light");
        node.params.insert("strength".into(), ParamValue::Number(100.0));
        node.params.insert("azimuth".into(), ParamValue::Number(0.0));
        node.params.insert("elevation".into(), ParamValue::Number(35.0));
        let mut depth = ImageBuf::new(w, h);
        for y in 0..h {
            for x in 0..w {
                // The floor drops 0.8 of the depth over the short edge:
                // shape, not a ripple.
                let v = if x < w / 2 { 0.9 - 0.8 * y as f32 / h as f32 } else { 0.95 };
                depth.set_pixel(x, y, [v, v, v, 1.0]);
            }
        }
        let inputs = vec![
            ("in".to_string(), frame(w, h, 0.3)),
            ("raster".to_string(), Value::Image(Arc::new(depth))),
        ];
        let out = key_light(&node, &inputs).unwrap();
        let img = out.as_image().unwrap();
        let deep = img.pixel(w / 8, h / 2)[0];
        let flat = frame(w, h, 0.3).as_image().unwrap().pixel(0, 0)[0];
        assert!((deep - flat).abs() > 0.01, "the slope must shade at all: {deep} vs {flat}");
        // Exactly the slope's own shading up to the last two pixels,
        // which still shade most of the way: the step's flatness
        // reaches only the pixels whose window it fills.
        // The step's own shading reaches a couple of pixels onto the
        // floor as the emphasis softens; past that, the slope's own.
        for dx in 3..12usize {
            let v = img.pixel(w / 2 - dx, h / 2)[0];
            assert!((v - deep).abs() < 0.01, "a flat band {dx} px before the cliff: {v} vs {deep}");
        }
        // The last two keep most of the slope's shading (no flat band
        // toward flat ground) and do not overshoot it (no bevel); the
        // softened emphasis at the step may move them a little past.
        for dx in 1..3usize {
            let v = img.pixel(w / 2 - dx, h / 2)[0];
            let toward_flat = (v - deep) * (flat - deep).signum();
            assert!(toward_flat < 0.5 * (flat - deep).abs(), "the last pixels go flat: {v} vs {deep} (flat {flat})");
            // The blurred height softens the emphasis over the last
            // pixels (a few percent), which is not a bevel.
            assert!(toward_flat > -0.04, "a bevel at the step: {v} vs {deep}");
        }
    }

    /// Halo item 4: the foot of a cliff on its far side is the cliff's.
    /// A wall at 0.9 dips to 0.87 over the last twenty pixels before the
    /// subject at 0.6 (the model's bleed) and shades flat like the rest
    /// of the wall; the same dip with no cliff after it is shape and
    /// shades; and the subject's own rim rising toward its silhouette
    /// (the near side) keeps its shading.
    #[test]
    fn the_foot_of_a_cliff_shades_as_the_wall_and_the_near_rim_still_shades() {
        // 600 by 300: the op's window is two percent of the short side,
        // six pixels, and the foot is six pixels, as the real plane's ten
        // pixel foot sits inside its twenty-seven pixel window.
        let (w, h) = (600usize, 300usize);
        let mut node = make_node("heeler.key_light");
        // A dark light at 1x, the light this geometry was measured at:
        // the old scale's -100, read at half its number on the power
        // scale since 2026-10-08.
        node.params.insert("strength".into(), ParamValue::Number(-200.0 / 3.0));
        node.params.insert("azimuth".into(), ParamValue::Number(180.0));
        node.params.insert("elevation".into(), ParamValue::Number(35.0));
        let plane = |with_cliff: bool| {
            let mut depth = ImageBuf::new(w, h);
            for y in 0..h {
                for x in 0..w {
                    let v = if x < 300 {
                        0.9
                    } else if x < 306 {
                        // The foot: the wall bends 0.03 toward the subject.
                        0.9 - 0.03 * (x - 300) as f32 / 6.0
                    } else if !with_cliff {
                        0.87
                    } else if x < 340 {
                        // The subject's rim, farther toward its silhouette
                        // (a convex thing seen from the front), long enough
                        // to reach past the window the step itself owns.
                        0.6 + 0.06 * (340 - x) as f32 / 34.0
                    } else {
                        0.6
                    };
                    depth.set_pixel(x, y, [v, v, v, 1.0]);
                }
            }
            depth
        };
        let run = |with_cliff: bool| {
            let inputs = vec![("in".to_string(), frame(w, h, 0.3)), ("raster".to_string(), Value::Image(Arc::new(plane(with_cliff))))];
            key_light(&node, &inputs).unwrap().as_image().unwrap().clone()
        };
        let lit = run(true);
        let no_cliff = run(false);
        let wall = lit.pixel(100, h / 2)[0];
        // Without the cliff the same bend is shape and shades.
        let bent = no_cliff.pixel(303, h / 2)[0];
        let flat = no_cliff.pixel(100, h / 2)[0];
        assert!((bent - flat).abs() > 0.02 * flat, "the bend without a cliff must still shade: {bent} against {flat}");
        // The foot shades as the wall does, all the way to the ramp's
        // own cells: within a few percent (the depth emphasis still
        // reads its height, a 0.03 dip, which is the two percent) and
        // a small fraction of what the same bend shades with no cliff.
        for x in 298..305usize {
            let v = lit.pixel(x, h / 2)[0];
            assert!((v - wall).abs() < 0.03 * wall, "the foot at x={x} shades as relief: {v} against the wall's {wall}");
            assert!((v - wall).abs() < 0.3 * (bent - flat).abs(), "the foot at x={x} still carries the bend: {v} against {wall}, the free bend {bent} against {flat}");
        }
        // The near rim keeps its shading past the step's own window: it
        // differs from the subject's flat interior.
        let rim = lit.pixel(322, h / 2)[0];
        let interior = lit.pixel(500, h / 2)[0];
        assert!((rim - interior).abs() > 0.01 * interior, "the near rim went flat: {rim} against {interior}");
    }

    /// R1 of the 2026-09-23 review: a floor receding under a subject
    /// climbs toward the silhouette on its own, and keeps its shading
    /// up to the cliff. The same floor with no subject on it is the
    /// reference: the foot shades as that does, within a few percent,
    /// where the first form of the rule flattened it.
    #[test]
    fn a_floor_sloping_toward_a_subject_keeps_its_shading_at_the_foot() {
        let (w, h) = (600usize, 300usize);
        let mut node = make_node("heeler.key_light");
        node.params.insert("strength".into(), ParamValue::Number(-100.0));
        node.params.insert("azimuth".into(), ParamValue::Number(180.0));
        node.params.insert("elevation".into(), ParamValue::Number(35.0));
        let plane = |with_subject: bool| {
            let mut depth = ImageBuf::new(w, h);
            for y in 0..h {
                for x in 0..w {
                    // The floor climbs 0.003 a pixel toward x=300, from
                    // 0.0 at x=100 to 0.6, and the subject stands at 0.9.
                    let floor = (0.003 * (x as f32 - 100.0)).clamp(0.0, 0.6);
                    let v = if with_subject && x >= 300 { 0.9 } else { floor };
                    depth.set_pixel(x, y, [v, v, v, 1.0]);
                }
            }
            depth
        };
        let run = |with_subject: bool| {
            let inputs = vec![("in".to_string(), frame(w, h, 0.3)), ("raster".to_string(), Value::Image(Arc::new(plane(with_subject))))];
            key_light(&node, &inputs).unwrap().as_image().unwrap().clone()
        };
        let lit = run(true);
        let free = run(false);
        // The floor shades: far from the subject it differs from flat ground.
        let ground = free.pixel(50, h / 2)[0];
        let slope = free.pixel(250, h / 2)[0];
        assert!((slope - ground).abs() > 0.02 * ground, "the floor must shade: {slope} against {ground}");
        // Up to the foot of the subject it shades as it does without
        // one; the last few pixels are the step's own window, where the
        // smoothed height already rises toward the subject.
        for x in [250usize, 280, 290, 294] {
            let (a, b) = (lit.pixel(x, h / 2)[0], free.pixel(x, h / 2)[0]);
            assert!((a - b).abs() < 0.04 * b, "the floor at x={x} lost its shading beside the subject: {a} against {b}");
        }
    }

    /// The section's own Levels shape the plane it reads: with White
    /// pulled below every nearness the field is all near, and a ridge
    /// that shaded before shades no more.
    #[test]
    fn the_key_light_reads_the_plane_through_its_own_levels() {
        let (w, h) = (64usize, 32);
        let mut node = make_node("heeler.key_light");
        node.params.insert("strength".into(), ParamValue::Number(100.0));
        node.params.insert("azimuth".into(), ParamValue::Number(0.0));
        node.params.insert("elevation".into(), ParamValue::Number(35.0));
        node.params.insert("depth_white".into(), ParamValue::Number(0.1));
        let mut depth = ImageBuf::new(w, h);
        for y in 0..h {
            for x in 0..w {
                let v = 0.2 + 0.6 * ((x as f32 / (w - 1) as f32) * 2.0 - 1.0).abs();
                depth.set_pixel(x, y, [v, v, v, 1.0]);
            }
        }
        let inputs = vec![
            ("in".to_string(), frame(w, h, 0.3)),
            ("raster".to_string(), Value::Image(Arc::new(depth))),
        ];
        let out = key_light(&node, &inputs).unwrap();
        let img = out.as_image().unwrap();
        let toward = img.pixel(w * 3 / 4, h / 2)[0];
        let away = img.pixel(w / 4, h / 2)[0];
        assert!((toward - away).abs() < 1e-5, "leveled flat, the ridge must not shade: {toward} vs {away}");
    }

    /// A red dark light leaves a red shadow on the flank it faces, not
    /// a cyan one; a red emitting light still adds red there.
    #[test]
    fn a_colored_dark_light_shadows_in_its_own_hue() {
        let (w, h) = (64usize, 32);
        let mut depth = ImageBuf::new(w, h);
        for y in 0..h {
            for x in 0..w {
                let v = 0.1 + 0.8 * ((x as f32 / (w - 1) as f32) * 2.0 - 1.0).abs();
                depth.set_pixel(x, y, [v, v, v, 1.0]);
            }
        }
        let inputs = vec![
            ("in".to_string(), frame(w, h, 0.3)),
            ("raster".to_string(), Value::Image(Arc::new(depth))),
        ];
        let lit = |strength: f32| {
            let mut node = make_node("heeler.key_light");
            node.params.insert(
                "lights".into(),
                ParamValue::Text(format!(
                    "[{{\"kind\":\"directional\",\"azimuth\":0,\"elevation\":35,\"strength\":{strength},\"color\":\"#ff0000\"}}]"
                )),
            );
            let out = key_light(&node, &inputs).unwrap();
            out.as_image().unwrap().pixel(w * 3 / 4, h / 2)
        };
        let dark = lit(-100.0);
        assert!(dark[0] < 0.3 || dark[1] < 0.3, "the dark light darkens the flank facing it: {dark:?}");
        assert!(dark[0] > dark[1] && dark[0] > dark[2], "a red dark light's shadow reads red: {dark:?}");
        let bright = lit(100.0);
        assert!(bright[0] > bright[1] && bright[0] > bright[2], "a red light adds red: {bright:?}");
        // A white dark light darkens every channel alike.
        let mut node = make_node("heeler.key_light");
        node.params.insert("strength".into(), ParamValue::Number(-100.0));
        node.params.insert("azimuth".into(), ParamValue::Number(0.0));
        node.params.insert("elevation".into(), ParamValue::Number(35.0));
        let px = key_light(&node, &inputs).unwrap().as_image().unwrap().pixel(w * 3 / 4, h / 2);
        assert!((px[0] - px[1]).abs() < 1e-6 && (px[1] - px[2]).abs() < 1e-6, "white stays neutral: {px:?}");
    }

    /// A 1:1 sharp slice is the crop of the whole render: every rule
    /// sized by the picture reads the frame, not the buffer.
    #[test]
    fn a_slice_of_the_key_light_equals_the_whole_render_cropped() {
        let (w, h) = (240usize, 160);
        let mut photo = ImageBuf::new(w, h);
        let mut depth = ImageBuf::new(w, h);
        for y in 0..h {
            for x in 0..w {
                let v = 0.3 + 0.2 * ((x * 7 + y * 3) % 11) as f32 / 11.0;
                photo.set_pixel(x, y, [v, v, v, 1.0]);
                // A dome in the middle over a floor sloping in y, a wall at the right.
                let (dx, dy) = ((x as f32 - 100.0) / 50.0, (y as f32 - 80.0) / 50.0);
                let dome = (1.0 - dx * dx - dy * dy).max(0.0);
                let far = if x > 190 { 0.95 } else { 0.7 - 0.3 * y as f32 / h as f32 - 0.4 * dome };
                depth.set_pixel(x, y, [far, far, far, 1.0]);
            }
        }
        let rig = r#"[{"kind":"point","px":0.45,"py":0.5,"depth":40,"range":60,"strength":-120},{"kind":"directional","azimuth":30,"elevation":40,"strength":80,"sun_depth":63,"sun_reach":21}]"#;
        let mut node = make_node("heeler.key_light");
        node.params.insert("lights".into(), ParamValue::Text(rig.into()));
        node.params.insert("relief".into(), ParamValue::Number(40.0));
        for measured in [0.0, 1.0] {
        set_num(&mut node, "depth_measured", measured);
        let whole = key_light(&node, &[
            ("in".to_string(), Value::Image(Arc::new(photo.clone()))),
            ("raster".to_string(), Value::Image(Arc::new(depth.clone()))),
        ]).unwrap();
        let whole = whole.as_image().unwrap();
        // The slice: a quarter of the frame, cut from both buffers.
        let (x0, y0, sw, sh) = (60usize, 40usize, 120usize, 80usize);
        let cut = |img: &ImageBuf| {
            let mut out = ImageBuf::new(sw, sh);
            for y in 0..sh {
                for x in 0..sw {
                    out.set_pixel(x, y, img.pixel(x0 + x, y0 + y));
                }
            }
            out
        };
        for (k, v) in [("roi_x", 0.25), ("roi_y", 0.25), ("roi_w", 0.5), ("roi_h", 0.5)] {
            node.params.insert(k.into(), ParamValue::Number(v));
        }
        let slice = key_light(&node, &[
            ("in".to_string(), Value::Image(Arc::new(cut(&photo)))),
            ("raster".to_string(), Value::Image(Arc::new(cut(&depth)))),
        ]).unwrap();
        let slice = slice.as_image().unwrap();
        // Away from the slice's own edges, where the smoothing windows
        // are cut short, the two agree.
        let mut worst = 0f32;
        for y in 12..sh - 12 {
            for x in 12..sw - 12 {
                let a = whole.pixel(x0 + x, y0 + y)[0];
                let b = slice.pixel(x, y)[0];
                worst = worst.max((a - b).abs());
            }
        }
        eprintln!("directional ROI measured={measured}: worst={worst}");
        assert!(worst < 0.02, "a slice must be the whole render cropped: worst {worst}");
        for k in ["roi_x", "roi_y", "roi_w", "roi_h"] { node.params.remove(k); }
        }
    }

    #[test]
    fn a_key_light_slice_keeps_the_frames_reduced_grid() {
        let (w, h) = (1000usize, 720usize); // radius 14, scale 3
        let mut depth = ImageBuf::new(w, h);
        for y in 0..h {
            for x in 0..w {
                let edge = 480.0 + 0.13 * y as f32;
                let v = if (x as f32) < edge {
                    0.15 + 0.75 * y as f32 / h as f32
                } else { 0.94 };
                depth.set_pixel(x, y, [v, v, v, 1.0]);
            }
        }
        let mut node = make_node("heeler.key_light");
        set_num(&mut node, "strength", -180.0);
        set_num(&mut node, "azimuth", 30.0);
        let run = |n: &Node, d: ImageBuf| key_light(n, &[
            ("in".into(), frame(d.width, d.height, 0.3)),
            ("raster".into(), Value::Image(Arc::new(d))),
        ]).unwrap().as_image().unwrap().clone();
        let whole = run(&node, depth.clone());
        // Neither the origin nor the size is a multiple of the cell size.
        let (x0, y0, sw, sh) = (251usize, 181usize, 501usize, 361usize);
        let mut cut = ImageBuf::new(sw, sh);
        for y in 0..sh {
            for x in 0..sw { cut.set_pixel(x, y, depth.pixel(x0 + x, y0 + y)); }
        }
        for (k, v) in [("roi_x", x0 as f32 / w as f32), ("roi_y", y0 as f32 / h as f32),
            ("roi_w", sw as f32 / w as f32), ("roi_h", sh as f32 / h as f32)] {
            set_num(&mut node, k, v as f64);
        }
        let slice = run(&node, cut);
        let mut worst = 0f32;
        for y in 80..sh - 80 {
            for x in 80..sw - 80 {
                worst = worst.max((whole.pixel(x0 + x, y0 + y)[0] - slice.pixel(x, y)[0]).abs());
            }
        }
        assert!(worst < 1e-4, "the cell grid moved with the slice: {worst}");
    }

    #[test]
    fn two_dark_pushes_cannot_turn_into_light() {
        let mut gain = [1.0; 3];
        push_gain(&mut gain, -1.8, &[0.9, 0.85, 0.8]);
        let one = gain;
        push_gain(&mut gain, -1.8, &[0.9, 0.85, 0.8]);
        assert!(gain.iter().all(|g| *g >= 0.0));
        assert!(gain.iter().zip(one).all(|(two, one)| *two <= one), "two dark lights brighten: {one:?} -> {gain:?}");
    }

    #[test]
    fn a_narrow_height_fit_cannot_invent_light_at_a_silhouette() {
        // Two supported heights, 0.500 and 0.504, with gains 1 and 2.
        // Variance 4e-6 clears the 1e-6 guard, but extrapolating that
        // valid line to height 0.8 gives 76, and to 0.2 gives -74.
        let b = (2.0 - 1.0) / (0.504 - 0.5);
        let a = 1.0 - b * 0.5;
        assert!(a + b * 0.8 > 70.0);
        assert!(a + b * 0.2 < -70.0);
        for h in [0.0, 0.2, 0.5, 0.502, 0.504, 0.8, 1.0] {
            let g = fitted_gain(a, b, h, 1.0, 2.0);
            assert!((1.0..=2.0).contains(&g), "unsupported gain {g} at {h}");
        }
        assert!((fitted_gain(a, b, 0.502, 1.0, 2.0) - 1.5).abs() < 1e-4);
    }

    /// the measurement (2026-09-13): a flat near plane before a flat far
    /// plane, lit hard from the right by a dark light. The near plane must
    /// shade as one plateau up to the edge's own ramp, at every jump: a
    /// hard box window drew a detached dark band a window's width before
    /// the edge at a jump of 0.3, and a jump under the old absolute cliff
    /// beveled across the edge.
    #[test]
    fn a_hard_light_draws_no_band_before_a_silhouette_at_any_jump() {
        let (w, h) = (1000usize, 720);
        for jump in [0.08f32, 0.14, 0.3, 0.6] {
            for edge in [501usize, 502, 503] {
                let mut depth = ImageBuf::new(w, h);
                for y in 0..h {
                    for x in 0..w {
                        let v = if x < edge { 0.2 } else { 0.2 + jump };
                        depth.set_pixel(x, y, [v, v, v, 1.0]);
                    }
                }
                let mut node = make_node("heeler.key_light");
                set_num(&mut node, "strength", -180.0);
                set_num(&mut node, "azimuth", 0.0);
                set_num(&mut node, "elevation", 35.0);
                let out = key_light(&node, &[("in".into(), frame(w, h, 0.3)), ("raster".into(), Value::Image(Arc::new(depth)))]).unwrap();
                let img = out.as_image().unwrap();
                let plateau = img.pixel(300, h / 2)[0];
                // Every cell phase, to the last pixel. The old ranges
                // skipped the six pixels carrying the remaining bevel.
                for x in 300..edge {
                    let v = img.pixel(x, h / 2)[0];
                    assert!((v - plateau).abs() < 0.03 * plateau + 0.01, "jump {jump}: a band at x={x}: {v} against the plateau {plateau}");
                }
                // The far plane shades as one plateau too.
                let far = img.pixel(700, h / 2)[0];
                for x in edge..700usize {
                    let v = img.pixel(x, h / 2)[0];
                    assert!((v - far).abs() < 0.03 * far + 0.01, "jump {jump}: a band at x={x}: {v} against the far plateau {far}");
                }
            }
        }
    }

    /// An exact sphere over flat ground (review, 2026-09-16). Mixed
    /// cells gave the ground a ring with a gain error of 0.394. The
    /// median reduces it below 0.17; the fitted step band still leaves
    /// a smaller ring, so this guards the improvement, not a cure for
    /// measured planes. Same geometry as the depth_lab review fixture.
    #[test]
    fn an_exact_sphere_does_not_lend_a_mixed_cells_tilt_to_the_ground() {
        let (w, h) = (1365usize, 2048);
        let mut depth = ImageBuf::filled(w, h, [0.8, 0.8, 0.8, 1.0]);
        for y in 650..1251 {
            for x in 380..981 {
                let r2 = ((x as f32 - 680.0) / 300.0).powi(2) + ((y as f32 - 950.0) / 300.0).powi(2);
                if r2 < 1.0 {
                    let far = 0.4 - 0.2 * (1.0 - r2).sqrt();
                    depth.set_pixel(x, y, [far, far, far, 1.0]);
                }
            }
        }
        let mut node = make_node("heeler.key_light");
        set_num(&mut node, "strength", -180.0);
        set_num(&mut node, "azimuth", 45.0);
        set_num(&mut node, "elevation", 45.0);
        let out = key_light(&node, &[("in".into(), frame(w, h, 0.3)), ("raster".into(), Value::Image(Arc::new(depth)))]).unwrap();
        let img = out.as_image().unwrap();
        let ground = img.pixel(100, 950)[0];
        let mut worst = 0f32;
        for y in 635..1266 {
            for x in 365..996 {
                let r2 = (x as i32 - 680).pow(2) + (y as i32 - 950).pow(2);
                if (300 * 300..=315 * 315).contains(&r2) {
                    worst = worst.max((img.pixel(x, y)[0] - ground).abs());
                }
            }
        }
        assert!(worst < 0.051, "the flat ground borrows the sphere's tilt: scene-linear error {worst}");
    }

    // A measurement fixture for the review, also useful when replacing
    // the edge classifier. Run alone with --ignored --nocapture.
    #[test]
    #[ignore = "manual edge-band diagnostic"]
    fn review_key_light_edges() {
        let (w, h) = (1000usize, 720usize);
        for jump in [0.08f32, 0.14, 0.3, 0.6] {
            let mut depth = ImageBuf::new(w, h);
            for y in 0..h {
                for x in 0..w {
                    let v = if x < 503 { 0.2 } else { 0.2 + jump };
                    depth.set_pixel(x, y, [v, v, v, 1.0]);
                }
            }
            let mut node = make_node("heeler.key_light");
            set_num(&mut node, "strength", -180.0);
            set_num(&mut node, "azimuth", 0.0);
            set_num(&mut node, "elevation", 35.0);
            let out = key_light(&node, &[("in".into(), frame(w, h, 0.3)), ("raster".into(), Value::Image(Arc::new(depth)))]).unwrap();
            let img = out.as_image().unwrap();
            let row: Vec<_> = (475..532).map(|x| img.pixel(x, h / 2)[0] / 0.3).collect();
            eprintln!("jump={jump}: {row:?}");
        }
    }

    /// the measurement (2026-09-13): a plane at a tenth of the frame's size,
    /// cut for a slice with the photograph's own crop op, rounded its window
    /// on its own grid and read a different depth at the same frame pixel.
    /// Cut at the frame's pixel centers it reads exactly what the whole
    /// render reads.
    #[test]
    fn a_low_resolution_plane_cut_for_a_slice_reads_the_frames_pixels() {
        let mut depth = ImageBuf::filled(100, 72, [0.2, 0.2, 0.2, 1.0]);
        for y in 0..72 {
            for x in 50..100 {
                depth.set_pixel(x, y, [0.8, 0.8, 0.8, 1.0]);
            }
        }
        let depth = Arc::new(depth);
        let rect = [251.0 / 1000.0, 181.0 / 720.0, 501.0 / 1000.0, 361.0 / 720.0];
        let whole = plane_from(&[("raster".into(), Value::Image(depth.clone()))], "raster", 1000, 720).unwrap();
        let rounded = crate::ops_geometry::crop_rotate_buf(&depth, 0.0, 0.0, rect);
        let off = plane_from(&[("raster".into(), Value::Image(rounded))], "raster", 501, 361).unwrap();
        assert!((whole[360 * 1000 + 500] - off[(360 - 181) * 501 + 500 - 251]).abs() > 0.05, "the rounded window reproduces the fault");
        let cut = crate::ops_geometry::crop_raster_to_frame(&depth, 1000, 720, rect);
        assert_eq!((cut.width, cut.height), (501, 361));
        let slice = plane_from(&[("raster".into(), Value::Image(cut))], "raster", 501, 361).unwrap();
        for (fx, fy) in [(500usize, 360usize), (260, 190), (700, 500), (505, 300), (495, 420)] {
            let a = whole[fy * 1000 + fx];
            let b = slice[(fy - 181) * 501 + fx - 251];
            assert!((a - b).abs() < 1e-5, "frame pixel ({fx},{fy}): whole {a} slice {b}");
        }
    }

    /// 26.3 Phase 10, slot removal: the wire delivers the plane as a
    /// Mask on the `depth` input where the slot delivered it as an
    /// Image on `raster`; the consumer must read the two identically.
    /// The executor-level comparisons that pinned this while both
    /// paths lived are gone with the slot, so the equivalence stands
    /// here, at the op.
    #[test]
    fn the_depth_input_reads_the_same_plane_the_raster_slot_read() {
        let (w, h) = (8usize, 2);
        let mut ramp_img = ImageBuf::new(w, h);
        for y in 0..h {
            for x in 0..w {
                let v = x as f32 / (w - 1) as f32;
                ramp_img.set_pixel(x, y, [v, v, v, 1.0]);
            }
        }
        let ramp_mask = crate::buffers::MaskBuf {
            width: w,
            height: h,
            data: ramp_img.data.chunks(4).map(|px| px[0]).collect(),
        };
        let mut node = make_node("heeler.fog");
        node.params.insert("density".into(), ParamValue::Number(80.0));
        let by_raster = fog(&node, &[
            ("in".to_string(), frame(w, h, 0.3)),
            ("raster".to_string(), Value::Image(Arc::new(ramp_img))),
        ]).unwrap();
        let by_wire = fog(&node, &[
            ("in".to_string(), frame(w, h, 0.3)),
            ("depth".to_string(), Value::Mask(Arc::new(ramp_mask))),
        ]).unwrap();
        assert_eq!(
            by_raster.as_image().unwrap().data,
            by_wire.as_image().unwrap().data,
            "the wired depth input reads a different plane than the slot it replaced"
        );
    }

    #[test]
    fn fog_reads_the_plane_through_its_own_levels() {
        let (w, h) = (4usize, 4);
        let mut node = make_node("heeler.fog");
        node.params.insert("density".into(), ParamValue::Number(60.0));
        let plane = ImageBuf::filled(w, h, [0.5, 0.5, 0.5, 1.0]);
        let inputs = vec![
            ("in".to_string(), frame(w, h, 0.3)),
            ("raster".to_string(), Value::Image(Arc::new(plane))),
        ];
        let fogged = fog(&node, &inputs).unwrap();
        assert!((fogged.as_image().unwrap().pixel(0, 0)[0] - 0.3).abs() > 0.01, "fog lands at farness 0.5");
        // White below the nearness: everything reads as nearest, no fog.
        node.params.insert("depth_white".into(), ParamValue::Number(0.4));
        let clear = fog(&node, &inputs).unwrap();
        assert!((clear.as_image().unwrap().pixel(0, 0)[0] - 0.3).abs() < 1e-6, "leveled all-near, no fog");
        // Black above it: everything reads as farthest, the thickest fog.
        node.params.insert("depth_white".into(), ParamValue::Number(1.0));
        node.params.insert("depth_black".into(), ParamValue::Number(0.6));
        let thick = fog(&node, &inputs).unwrap();
        assert!(
            (thick.as_image().unwrap().pixel(0, 0)[0] - 0.3).abs() > (fogged.as_image().unwrap().pixel(0, 0)[0] - 0.3).abs(),
            "leveled all-far, thicker than at 0.5"
        );
    }

    #[test]
    fn the_key_light_draws_no_rim_along_an_occlusion() {
        let (w, h) = (240usize, 120);
        let mut node = make_node("heeler.key_light");
        node.params.insert("strength".into(), ParamValue::Number(100.0));
        node.params.insert("azimuth".into(), ParamValue::Number(0.0)); // from the right
        node.params.insert("elevation".into(), ParamValue::Number(35.0));
        let mut depth = ImageBuf::new(w, h);
        for y in 0..h {
            for x in 0..w {
                // Near on the left, far on the right, one hard step.
                let v = if x < w / 2 { 0.2 } else { 0.8 };
                depth.set_pixel(x, y, [v, v, v, 1.0]);
            }
        }
        let inputs = vec![
            ("in".to_string(), frame(w, h, 0.3)),
            ("raster".to_string(), Value::Image(Arc::new(depth))),
        ];
        let out = key_light(&node, &inputs).unwrap();
        let img = out.as_image().unwrap();
        // The near plateau is lit a little more than the far one by
        // design (depth emphasis), and the blurred step blends between
        // the two. A bevel would overshoot: the cliff faces the light,
        // so an unguarded normal lights it brighter than either side.
        let flat_near = img.pixel(w / 8, h / 2)[0];
        let flat_far = img.pixel(w * 7 / 8, h / 2)[0];
        let lo = flat_near.min(flat_far) - 0.004;
        let hi = flat_near.max(flat_far) + 0.004;
        for dx in 0..10usize {
            for v in [img.pixel(w / 2 - 1 - dx, h / 2)[0], img.pixel(w / 2 + dx, h / 2)[0]] {
                assert!(v >= lo && v <= hi, "a rim at {dx}: {v} outside {lo}..{hi}");
            }
        }
    }

    #[test]
    fn the_lens_vices_each_leave_their_signature() {
        let (w, h) = (64usize, 32);
        // Stripes for measurable sharpness, one hot pixel for the glow.
        let mut img = ImageBuf::new(w, h);
        for y in 0..h {
            for x in 0..w {
                let v = if x % 2 == 0 { 0.5 } else { 0.1 };
                img.set_pixel(x, y, [v, v, v, 1.0]);
            }
        }
        img.set_pixel(4, h / 2, [8.0, 8.0, 8.0, 1.0]);
        let base = vec![
            ("in".to_string(), Value::Image(Arc::new(img))),
            ramp_raster(w, h),
        ];
        // Fringe: an out-of-focus edge splits red from blue; in focus
        // it does not.
        let mut node = make_node("heeler.dof");
        node.params.insert("aperture".into(), ParamValue::Number(100.0));
        node.params.insert("focus".into(), ParamValue::Number(0.0));
        node.params.insert("fringe".into(), ParamValue::Number(100.0));
        let out = dof(&node, &base).unwrap();
        let o = out.as_image().unwrap();
        let split_far = (o.pixel(w - 6, h / 2)[0] - o.pixel(w - 6, h / 2)[2]).abs();
        let split_near = (o.pixel(2, h / 2)[0] - o.pixel(2, h / 2)[2]).abs();
        assert!(split_far > split_near + 1e-4, "fringing lives where focus is lost: {split_far} vs {split_near}");
        // Glow: the bright in-focus point bleeds onto its neighbors.
        let mut gn = make_node("heeler.dof");
        gn.params.insert("aperture".into(), ParamValue::Number(40.0));
        gn.params.insert("focus".into(), ParamValue::Number(0.0));
        gn.params.insert("glow".into(), ParamValue::Number(100.0));
        let gout = dof(&gn, &base).unwrap();
        let go = gout.as_image().unwrap();
        let plain = dof(&{
            let mut n = make_node("heeler.dof");
            n.params.insert("aperture".into(), ParamValue::Number(40.0));
            n.params.insert("focus".into(), ParamValue::Number(0.0));
            n
        }, &base)
        .unwrap();
        let po = plain.as_image().unwrap();
        assert!(
            go.pixel(6, h / 2 + 1)[0] > po.pixel(6, h / 2 + 1)[0] + 1e-3,
            "the halo reaches past the point"
        );
        // Field curvature: bend the plane far-ward and the CENTER
        // (near, off-plane) blurs while the corners sharpen.
        let mut fc = make_node("heeler.dof");
        fc.params.insert("aperture".into(), ParamValue::Number(100.0));
        fc.params.insert("focus".into(), ParamValue::Number(0.0));
        fc.params.insert("field_curve".into(), ParamValue::Number(-100.0));
        let fout = dof(&fc, &base).unwrap();
        let fo = fout.as_image().unwrap();
        let contrast = |img: &ImageBuf, x: usize, y: usize| {
            (img.pixel(x, y)[0] - img.pixel(x + 1, y)[0]).abs()
        };
        // With the plane bent nearward at the edges, the near-left
        // corner pixel stays sharper under curvature than without it.
        assert!(
            contrast(fo, 2, 2) + 1e-6 >= contrast(po, 2, 2) * 0.5,
            "field curvature reshapes where sharpness lives"
        );
        // Blade curve: a hard hexagon and a round aperture produce
        // different gathers at the same radius.
        let hexk = aperture_kernel(9.0, 6, 0.0);
        let round = aperture_kernel(9.0, 6, 1.0);
        assert!(hexk.1 < round.1, "the polygon covers less than the circle");
    }

    #[test]
    fn a_second_light_stacks_and_a_negative_one_darkens() {
        let (w, h) = (64usize, 32);
        // The same ridge: near center, far flanks.
        let mut depth = ImageBuf::new(w, h);
        for y in 0..h {
            for x in 0..w {
                let v = 0.1 + 0.8 * ((x as f32 / (w - 1) as f32) * 2.0 - 1.0).abs();
                depth.set_pixel(x, y, [v, v, v, 1.0]);
            }
        }
        let base = vec![
            ("in".to_string(), frame(w, h, 0.3)),
            ("raster".to_string(), Value::Image(Arc::new(depth))),
        ];
        // One DARK light from the right: the right flank must darken.
        let mut node = make_node("heeler.key_light");
        node.params.insert("strength".into(), ParamValue::Number(-80.0));
        node.params.insert("azimuth".into(), ParamValue::Number(0.0));
        node.params.insert("elevation".into(), ParamValue::Number(35.0));
        let out = key_light(&node, &base).unwrap();
        let img = out.as_image().unwrap();
        assert!(
            img.pixel(w * 3 / 4, h / 2)[0] < img.pixel(w / 4, h / 2)[0],
            "a dark light darkens the flank it faces"
        );
        // The rig JSON is the whole truth when present: the same dark
        // light plus a bright one from the LEFT - the left flank must
        // come out brighter than under the dark light alone.
        node.params.insert(
            "lights".into(),
            ParamValue::Text(
                r#"[{"azimuth":0,"elevation":35,"strength":-80},{"azimuth":180,"elevation":35,"strength":80}]"#.into(),
            ),
        );
        let out2 = key_light(&node, &base).unwrap();
        let img2 = out2.as_image().unwrap();
        assert!(
            img2.pixel(w / 4, h / 2)[0] > img.pixel(w / 4, h / 2)[0],
            "the second light adds its own shading"
        );
        // A POINT light close to the left flank lifts its neighborhood
        // more than the far flank ("Light should have a type:
        // point and directional").
        let mut pnode = make_node("heeler.key_light");
        pnode.params.insert(
            "lights".into(),
            ParamValue::Text(
                r#"[{"kind":"point","px":0.25,"py":0.5,"strength":90,"height":60,"range":40}]"#.into(),
            ),
        );
        let pout = key_light(&pnode, &base).unwrap();
        let pimg = pout.as_image().unwrap();
        assert!(
            pimg.pixel(w / 4, h / 2)[0] > pimg.pixel(w * 3 / 4, h / 2)[0],
            "a point light's push fades with distance"
        );
        // A lamp is additive: positive strength BRIGHTENS near the lamp
        // and owes nothing to the far frame ("-200 gets
        // brighter and 200 is darker" - the sun-style anchor made absence
        // of lamp light read as darkness).
        assert!(
            pimg.pixel(w / 4, h / 2)[0] > 0.3,
            "positive lamp strength brightens: {}",
            pimg.pixel(w / 4, h / 2)[0]
        );
        assert!(
            (pimg.pixel(w - 2, h / 2)[0] - 0.3).abs() < 0.05,
            "beyond its reach the lamp changes little: {}",
            pimg.pixel(w - 2, h / 2)[0]
        );
    }

    // 26.3 Phase 9: a directional light only adds, the lamp's rule. The old
    // anchor (a lit flat surface at MID depth) made every pixel whose
    // emphasis sat under that baseline count as dark, so a far plane dimmed
    // as strength rose ("the background gets darker. Point
    // light does not do this").

    /// A flat plane at the far end under a directional light at
    /// positive strength never drops below its unlit value, in any
    /// channel, at any strength.
    #[test]
    fn a_directional_light_never_takes_a_far_plane_below_unlit() {
        let (w, h) = (32usize, 32);
        // Flat, and as far as the plane reaches.
        let mut depth = ImageBuf::new(w, h);
        for y in 0..h {
            for x in 0..w {
                depth.set_pixel(x, y, [1.0, 1.0, 1.0, 1.0]);
            }
        }
        let base = vec![
            ("in".to_string(), frame(w, h, 0.3)),
            ("raster".to_string(), Value::Image(Arc::new(depth))),
        ];
        for strength in [50.0, 100.0, 200.0] {
            let mut node = make_node("heeler.key_light");
            node.params.insert(
                "lights".into(),
                ParamValue::Text(
                    format!(r#"[{{"kind":"directional","azimuth":0,"elevation":35,"strength":{strength}}}]"#).into(),
                ),
            );
            let img = key_light(&node, &base).unwrap();
            let img = img.as_image().unwrap();
            for i in 0..w * h {
                for c in 0..3 {
                    let v = img.data[i * 4 + c];
                    assert!(
                        v >= 0.3 - 1e-6,
                        "strength {strength} took pixel {i} channel {c} below its unlit value: {v} < 0.3"
                    );
                }
            }
        }
    }

    /// The depth emphasis still lands the light harder near than far:
    /// a ramp from near to far under one directional light gains more
    /// at the near end.
    #[test]
    fn a_directional_light_lands_harder_near_than_far() {
        let (w, h) = (64usize, 32);
        let mut depth = ImageBuf::new(w, h);
        for y in 0..h {
            for x in 0..w {
                let v = x as f32 / (w - 1) as f32;
                depth.set_pixel(x, y, [v, v, v, 1.0]);
            }
        }
        let base = vec![
            ("in".to_string(), frame(w, h, 0.3)),
            ("raster".to_string(), Value::Image(Arc::new(depth))),
        ];
        // Mostly overhead, so the ramp's gentle tilt barely plays and
        // what separates near from far is the emphasis.
        let mut node = make_node("heeler.key_light");
        node.params.insert(
            "lights".into(),
            ParamValue::Text(r#"[{"kind":"directional","azimuth":90,"elevation":80,"strength":100}]"#.into()),
        );
        let img = key_light(&node, &base).unwrap();
        let img = img.as_image().unwrap();
        let near = img.pixel(3, h / 2)[0];
        let far = img.pixel(w - 4, h / 2)[0];
        assert!(near > far, "the near end gains more than the far end: {near} vs {far}");
        assert!(far >= 0.3 - 1e-6, "and the far end still adds rather than takes: {far}");
    }

    /// A directional light's Depth and Reach (2026-10-03: "We added a depth
    /// slider for point light but not directional... Also, there is no
    /// Reach"), over the same near-to-far ramp. At the defaults nothing
    /// moves by a bit; Depth 100 lands the light on the far plane, the
    /// mirror of the default; Reach 100 lights every plane alike, a true
    /// sun; a short Reach keeps the light to its own plane and leaves the
    /// other end at its unlit value.
    #[test]
    fn review_directional_defaults_are_bit_exact_on_model_and_measured_planes() {
        use crate::ops::test_util::set_text;
        let (w, h) = (80usize, 64usize);
        let mut photo = ImageBuf::new(w, h);
        let mut depth = ImageBuf::new(w, h);
        for y in 0..h { for x in 0..w {
            let z = 0.1 + 0.7 * x as f32 / w as f32 + 0.05 * (y as f32 * 0.2).sin();
            photo.set_pixel(x, y, [0.2 + x as f32 / 500.0, 0.3, 0.1, 1.0]);
            depth.set_pixel(x, y, [z, z, z, 1.0]);
        }}
        let inputs = vec![("in".into(), Value::Image(Arc::new(photo))), ("raster".into(), Value::Image(Arc::new(depth)))];
        for measured in [0.0, 1.0] {
            let mut node = make_node("heeler.key_light");
            set_num(&mut node, "depth_measured", measured);
            set_text(&mut node, "lights", r#"[{"kind":"directional","azimuth":30,"elevation":40,"strength":80}]"#);
            let old = key_light(&node, &inputs).unwrap();
            set_text(&mut node, "lights", r#"[{"kind":"directional","azimuth":30,"elevation":40,"strength":80,"sun_depth":0,"sun_reach":50}]"#);
            let defaults = key_light(&node, &inputs).unwrap();
            assert_eq!(old.as_image().unwrap().data, defaults.as_image().unwrap().data, "measured={measured}");
        }
    }

    /// Strength's scale (2026-10-08: "it goes to 200 which is odd
    /// (vs 100)... Also increase the calculated strength by 50%"): a
    /// light's `power` runs -100 to 100 and 100 is three times the light;
    /// a light saved before carries `strength` and is read at half its
    /// number (the same place on the slider, 50% stronger), in the rig
    /// and in the legacy single light alike.
    #[test]
    fn power_is_the_scale_and_an_old_strength_reads_at_half_its_number() {
        let (w, h) = (64usize, 32);
        let mut depth = ImageBuf::new(w, h);
        for y in 0..h {
            for x in 0..w {
                let v = x as f32 / (w - 1) as f32;
                depth.set_pixel(x, y, [v, v, v, 1.0]);
            }
        }
        let base = vec![
            ("in".to_string(), frame(w, h, 0.3)),
            ("raster".to_string(), Value::Image(Arc::new(depth))),
        ];
        let rig = |light: &str| {
            let mut node = make_node("heeler.key_light");
            node.params.insert("lights".into(), ParamValue::Text(format!(r#"[{{"kind":"directional","azimuth":90,"elevation":80,{light}}}]"#)));
            key_light(&node, &base).unwrap().as_image().unwrap().data.clone()
        };
        let legacy = |strength: f64| {
            let mut node = make_node("heeler.key_light");
            node.params.insert("strength".into(), ParamValue::Number(strength));
            node.params.insert("azimuth".into(), ParamValue::Number(90.0));
            node.params.insert("elevation".into(), ParamValue::Number(80.0));
            key_light(&node, &base).unwrap().as_image().unwrap().data.clone()
        };
        // An old 150 is the new 75, an old -200 the new -100.
        assert_eq!(rig(r#""strength":150"#), rig(r#""power":75"#));
        assert_eq!(rig(r#""strength":-200"#), rig(r#""power":-100"#));
        assert_eq!(legacy(150.0), rig(r#""power":75"#));
        // Power wins where a light carries both.
        assert_eq!(rig(r#""strength":20,"power":75"#), rig(r#""power":75"#));
        // 100 is three times the light the old 100 was: a light's lift
        // over the unlit value grows with its multiple, so the new 100
        // lifts more than the old scale's top, 200.
        let lift = |d: &[f32]| d.iter().step_by(4).map(|v| v - 0.3).sum::<f32>();
        assert!(lift(&rig(r#""power":100"#)) > lift(&rig(r#""power":66.666664"#)) + 1e-3, "power 100 outshines the old 200");
        assert_eq!(rig(r#""power":0"#), rig(r#""strength":0"#), "zero is no light either way");
    }

    #[test]
    fn a_directional_light_has_a_depth_plane_and_a_reach() {
        let (w, h) = (64usize, 32);
        let mut depth = ImageBuf::new(w, h);
        for y in 0..h {
            for x in 0..w {
                let v = x as f32 / (w - 1) as f32;
                depth.set_pixel(x, y, [v, v, v, 1.0]);
            }
        }
        let base = vec![
            ("in".to_string(), frame(w, h, 0.3)),
            ("raster".to_string(), Value::Image(Arc::new(depth))),
        ];
        let lit = |extra: &str| {
            let mut node = make_node("heeler.key_light");
            node.params.insert(
                "lights".into(),
                // A light at 1x on the power scale (2026-10-08), the
                // light these planes were measured at.
                ParamValue::Text(format!(r#"[{{"kind":"directional","azimuth":90,"elevation":80,"power":33.333333{extra}}}]"#)),
            );
            let img = key_light(&node, &base).unwrap();
            let img = img.as_image().unwrap().clone();
            (img.pixel(3, h / 2)[0], img.pixel(w / 2, h / 2)[0], img.pixel(w - 4, h / 2)[0], img)
        };
        // The defaults, named or not, are the light as it always was,
        // and the lamp's `depth` a directional light carries from the
        // panel's defaults goes on meaning nothing to it.
        let (near, _, far, plain) = lit("");
        assert_eq!(plain.data, lit(r#","sun_depth":0,"sun_reach":50"#).3.data);
        assert_eq!(plain.data, lit(r#","depth":30,"range":50"#).3.data);
        assert!(near > far);
        // Depth 100: the far plane takes what the near plane took, and
        // the near plane what the far plane took.
        let (near_far, _, far_far, _) = lit(r#","sun_depth":100"#);
        assert!(far_far > near_far, "the light lands on the far plane: near {near_far}, far {far_far}");
        assert!((far_far - near).abs() < 0.01 && (near_far - far).abs() < 0.01, "a mirror of the default: {near_far} {far_far} against {near} {far}");
        // Depth 50: the middle of the scene is the brightest.
        let (n, mid, f, _) = lit(r#","sun_depth":50"#);
        assert!(mid > n && mid > f, "the mid plane leads: {n} {mid} {f}");
        // Reach 100: every plane alike, at the strength the light has
        // on its own plane.
        let (n, mid, f, _) = lit(r#","sun_reach":100"#);
        assert!((n - f).abs() < 0.005 && (n - mid).abs() < 0.005, "evenly lit: {n} {mid} {f}");
        assert!(n >= near - 0.005);
        // Reach 0: the near plane keeps the light, the far end keeps
        // its unlit value.
        let (n, _, f, tight) = lit(r#","sun_reach":0"#);
        let (on_plane, before) = (tight.pixel(0, h / 2)[0], plain.pixel(0, h / 2)[0]);
        // (The smoothed height at the frame's edge sits a hair off the
        // plane, and a short reach is steep, hence the allowance.)
        assert!((on_plane - before).abs() < 0.03, "its own plane is lit nearly as before: {on_plane} against {before}");
        assert!(n < near && n > f, "and it falls away faster than the default: {n} against {near}");
        assert!((f - 0.3).abs() < 1e-6, "the far end is left alone: {f}");
        // And a dial outside its range is held to it, never a NaN.
        let (_, _, _, wild) = lit(r#","sun_depth":900,"sun_reach":-40"#);
        assert!(wild.data.iter().all(|v| v.is_finite()));
    }

    /// Negative strength takes light away by the same shape: the far
    /// plane, where the emphasis is least, ends at or above the near
    /// plane, and nothing anywhere ends above its unlit value.
    #[test]
    fn a_negative_directional_takes_more_near_than_far() {
        let (w, h) = (64usize, 32);
        let mut depth = ImageBuf::new(w, h);
        for y in 0..h {
            for x in 0..w {
                let v = x as f32 / (w - 1) as f32;
                depth.set_pixel(x, y, [v, v, v, 1.0]);
            }
        }
        let base = vec![
            ("in".to_string(), frame(w, h, 0.3)),
            ("raster".to_string(), Value::Image(Arc::new(depth))),
        ];
        let mut node = make_node("heeler.key_light");
        node.params.insert(
            "lights".into(),
            ParamValue::Text(r#"[{"kind":"directional","azimuth":90,"elevation":80,"strength":-100}]"#.into()),
        );
        let img = key_light(&node, &base).unwrap();
        let img = img.as_image().unwrap();
        let near = img.pixel(3, h / 2)[0];
        let far = img.pixel(w - 4, h / 2)[0];
        assert!(far >= near - 1e-6, "negative strength takes more near than far: {far} vs {near}");
        assert!(far <= 0.3 + 1e-6, "negative strength adds nothing anywhere: {far}");
        assert!(near < 0.3, "and it does take, at the near end: {near}");
    }

    #[test]
    fn lights_toggle_tint_and_invert_visibly() {
        let (w, h) = (64usize, 32);
        let mut depth = ImageBuf::new(w, h);
        for y in 0..h {
            for x in 0..w {
                let v = x as f32 / (w - 1) as f32;
                depth.set_pixel(x, y, [v, v, v, 1.0]);
            }
        }
        let base = vec![
            ("in".to_string(), frame(w, h, 0.3)),
            ("raster".to_string(), Value::Image(Arc::new(depth))),
        ];
        // Off keeps the settings but not the push.
        let mut node = make_node("heeler.key_light");
        node.params.insert(
            "lights".into(),
            ParamValue::Text(r#"[{"azimuth":0,"elevation":35,"strength":80,"on":false}]"#.into()),
        );
        let off = key_light(&node, &base).unwrap();
        assert_eq!(off.as_image().unwrap().pixel(4, 8)[0], 0.3, "an off light pushes nothing");
        // A red light reddens the flank it brightens.
        node.params.insert(
            "lights".into(),
            ParamValue::Text(r##"[{"azimuth":0,"elevation":35,"strength":80,"color":"#ff2000"}]"##.into()),
        );
        let red = key_light(&node, &base).unwrap();
        let ri = red.as_image().unwrap();
        let lit = (0..w * h / 4)
            .map(|k| (k % w, k / w))
            .max_by(|a, b| {
                ri.pixel(a.0, a.1)[0].partial_cmp(&ri.pixel(b.0, b.1)[0]).unwrap()
            })
            .unwrap();
        assert!(
            ri.pixel(lit.0, lit.1)[0] > ri.pixel(lit.0, lit.1)[2] + 1e-3,
            "a red light's push is red"
        );
        // Invert moves the directional emphasis from near to far.
        node.params.insert(
            "lights".into(),
            ParamValue::Text(r#"[{"azimuth":90,"elevation":80,"strength":100}]"#.into()),
        );
        let normal = key_light(&node, &base).unwrap();
        node.params.insert("invert".into(), ParamValue::Number(1.0));
        let flipped = key_light(&node, &base).unwrap();
        let (n_img, f_img) = (normal.as_image().unwrap(), flipped.as_image().unwrap());
        // Near side (left) brighter than far side under normal; the
        // relationship flips with invert.
        let near_gain_n = n_img.pixel(3, 8)[0];
        let far_gain_n = n_img.pixel(w - 4, 8)[0];
        let near_gain_f = f_img.pixel(3, 8)[0];
        let far_gain_f = f_img.pixel(w - 4, 8)[0];
        assert!(near_gain_n > far_gain_n, "the key reaches the near relief: {near_gain_n} vs {far_gain_n}");
        assert!(far_gain_f > near_gain_f, "inverted, it reaches the far: {near_gain_f} vs {far_gain_f}");
    }

    #[test]
    fn a_lamp_favors_its_depth_and_invert_mirrors_it_to_the_other_end() {
        // Square, so the ramp across it is a slope of one depth unit per
        // short edge: shape the shading reads, not a ripple it rolls off.
        let (w, h) = (32usize, 32);
        let mut depth = ImageBuf::new(w, h);
        for y in 0..h {
            for x in 0..w {
                let v = x as f32 / (w - 1) as f32;
                depth.set_pixel(x, y, [v, v, v, 1.0]);
            }
        }
        let base = vec![
            ("in".to_string(), frame(w, h, 0.3)),
            ("raster".to_string(), Value::Image(Arc::new(depth))),
        ];
        let mut node = make_node("heeler.key_light");
        // A lamp near the NEAR plane, centered, at a middling strength:
        // it must show without the dial pinned at 200 (the old z scale
        // starved lamps of everything but their own depth slice).
        node.params.insert(
            "lights".into(),
            ParamValue::Text(
                r#"[{"kind":"point","px":0.5,"py":0.5,"depth":10,"range":70,"strength":100}]"#.into(),
            ),
        );
        let lit = key_light(&node, &base).unwrap();
        let li = lit.as_image().unwrap();
        let near = li.pixel(4, 16)[0];
        let far = li.pixel(w - 5, 16)[0];
        assert!(near > 0.3 + 0.02, "a mid-strength lamp must visibly light its plane: {near}");
        assert!(near > far, "a near lamp favors the near content: {near} vs {far}");
        // Decisively, not by a whisker: the depth-weighted falloff is
        // what keeps a lamp's plane selection readable on a real
        // photograph (the bus scene's Invert looked like a no-op when
        // the planes differed by only a few percent of gain).
        assert!(
            (near - 0.3) > 2.0 * (far - 0.3).max(0.0),
            "the near plane's push must dominate: {near} vs {far}"
        );
        // Invert mirrors the lamp with the field: the same lamp now
        // favors the far content instead.
        node.params.insert("invert".into(), ParamValue::Number(1.0));
        let flipped = key_light(&node, &base).unwrap();
        let fi = flipped.as_image().unwrap();
        let near_f = fi.pixel(4, 16)[0];
        let far_f = fi.pixel(w - 5, 16)[0];
        assert!(far_f > near_f, "inverted, the lamp lights the far end: {near_f} vs {far_f}");
        assert!(
            (far_f - 0.3) > 2.0 * (near_f - 0.3).max(0.0),
            "inverted, the far plane's push must dominate: {near_f} vs {far_f}"
        );
    }

    #[test]
    fn fog_texture_varies_the_veil_but_keeps_its_reach() {
        let (w, h) = (64usize, 32);
        let mut node = make_node("heeler.fog");
        node.params.insert("density".into(), ParamValue::Number(70.0));
        node.params.insert("fog_sat".into(), ParamValue::Number(0.0));
        node.params.insert("texture".into(), ParamValue::Number(100.0));
        let inputs = vec![("in".to_string(), frame(w, h, 0.02)), ramp_raster(w, h)];
        let out = fog(&node, &inputs).unwrap();
        let img = out.as_image().unwrap();
        // Along one farness column the veil now varies (drifts)...
        let col: Vec<f32> = (0..h).map(|y| img.pixel(w - 2, y)[0]).collect();
        let (lo, hi) = col.iter().fold((1.0f32, 0.0f32), |(l, u), v| (l.min(*v), u.max(*v)));
        assert!(hi - lo > 0.01, "texture must vary the veil: {lo}..{hi}");
        // ...and the near edge stays clean regardless.
        assert!(img.pixel(0, h / 2)[0] < 0.1, "texture never drags fog to the lens");
    }

    #[test]
    fn dof_keeps_the_focal_plane_sharp_and_blurs_away_from_it() {
        let (w, h) = (48usize, 24);
        // A frame with vertical stripes so blur is measurable.
        let mut img = ImageBuf::new(w, h);
        for y in 0..h {
            for x in 0..w {
                let v = if x % 2 == 0 { 1.0 } else { 0.0 };
                img.set_pixel(x, y, [v, v, v, 1.0]);
            }
        }
        let mut node = make_node("heeler.dof");
        node.params.insert("aperture".into(), ParamValue::Number(100.0));
        node.params.insert("focus".into(), ParamValue::Number(0.0)); // near in focus
        let inputs = vec![
            ("in".to_string(), Value::Image(Arc::new(img.clone()))),
            ramp_raster(w, h),
        ];
        let out = dof(&node, &inputs).unwrap();
        let o = out.as_image().unwrap();
        // Contrast between adjacent stripes: crisp near, mushy far.
        let contrast = |x: usize| (o.pixel(x, h / 2)[0] - o.pixel(x + 1, h / 2)[0]).abs();
        assert!(contrast(2) > contrast(w - 4), "far stripes must blur more than near ones");
    }

    #[test]
    fn frame_of_snaps_a_reconstructed_frame_size_back_to_the_integer() {
        // The slice hands the op its buffer's rect in frame fractions,
        // and w / roi_w in f32 can land a hair under the true frame
        // width (630 / f32(630 / 1225) comes back 1224.99988). On a
        // short side whose 0.02 share sits exactly on a rounding
        // boundary that wobble flips the cell grid, and the slice no
        // longer matches the whole render (R2 of the fourth pre-merge
        // review). The true frame dims are always integers, so snap
        // within a few ULP; a genuinely fractional size keeps its
        // fraction.
        use crate::ops::test_util::{make_node, set_num};
        let mut node = make_node("heeler.key_light");
        let f = 630.0f32 / 1225.0f32;
        set_num(&mut node, "roi_w", f as f64);
        set_num(&mut node, "roi_h", f as f64);
        let frame = super::frame_of(&node, 630, 630);
        assert_eq!((frame.w, frame.short), (1225.0, 1225.0));
        set_num(&mut node, "roi_w", 630.0 / 1225.5);
        let frame = super::frame_of(&node, 630, 630);
        assert!(
            (frame.w - 1225.5).abs() < 0.01,
            "a fractional frame size keeps its fraction: {}",
            frame.w
        );
    }

    // The half-res gather approximation measurement that lived here
    // priced a shortcut for the RETIRED gather path and went with it
    // at the cutover: the layered path made the question moot, and
    // the proposal had already been declined by ruling.
}
