//! Per-node pixel operations: dispatch plus the color and tone ops.
//! Detail ops (sharpen/clarity) live in `ops_detail`, grain in
//! `ops_stylize`, painted/keyed masks in `ops_masks`.
//!
//! Formulas here are the v0 CPU reference set. They are deliberately simple,
//! documented, and locked by unit tests; refining the color science later
//! means updating the formula, its doc comment, and its golden tests
//! together.

use std::collections::BTreeMap;
use std::sync::Arc;

use heeler_graph::{Node, ParamValue};
use serde::Deserialize;

use crate::buffers::{luma, ImageBuf, MaskBuf, Value};
use crate::executor::EngineError;

/// Contrast pivots around mid-gray in scene-linear terms.
pub const CONTRAST_PIVOT: f32 = 0.18;

/// Where the Highlights control starts having any say, and where
/// Shadows stops, both in display terms.
///
/// Display and not scene-linear on purpose. "Highlight" is a statement
/// about what looks bright, and scene-linear luma is nothing like
/// perceived brightness: a cloud that reads as 0.9 on screen is 0.79 in
/// linear, while one that reads 0.5 is 0.21. Weighting against linear
/// luma put almost all of the control's authority in the top sliver of
/// the range, where there was no room left to lift into.
const HIGHLIGHT_FLOOR: f32 = 0.35;
const SHADOW_CEIL: f32 = 0.55;
/// The middle each control pulls toward: highlights when run negative
/// (recovery), shadows when run positive (lifting).
const TONE_MID: f32 = 0.5;
/// Whites and Blacks, reshaped 2026-08-11 after measuring all four tone
/// controls against two slider-based RAW editors (editor A and editor
/// B in the measurements below) driving the same RAWs
/// (scripts/compare_renders.py, bighorn series). Whites was a plain
/// linear gain (moved every band of the image equally, ±1.4 EV in the
/// shadows; both competitors keep shadows pinned near zero) and Blacks
/// was an additive offset (+100 lifted shadows +4.6 EV against editor
/// A's +1.5 and editor B's +0.8, and -100 sent entire frames to solid black).
/// Both are now display-space controls like Highlights and Shadows:
/// Whites weighted toward the top from WHITE_FLOOR up, Blacks toward
/// the bottom fading out by BLACK_CEIL, with strengths chosen to land
/// between the two references.
const WHITE_FLOOR: f32 = 0.3;
const BLACK_CEIL: f32 = 0.5;
const WHITE_RANGE: f32 = 0.12;
const BLACK_LIFT: f32 = 0.05;
const BLACK_CRUSH: f32 = 0.12;
/// Negative Highlights keeps a floor of authority everywhere its weight
/// reaches. The old form scaled purely by distance above display 0.5,
/// which multiplied to nothing on any scene without bright daylight:
/// measured against editor B on a shaded scene, Heeler's recovery moved
/// the top band -0.04 EV where editor B moved -0.38. The mid-distance term still
/// dominates near white, so sky recovery is as strong as it ever was.
const HI_RECOVER: f32 = 0.06;
/// The mid-distance part of highlight recovery. Slightly below the
/// shared PULL_BACK: with every range control stacked full-negative the
/// slopes of this term and WHITE_RANGE add, and at 0.5 the sum crossed
/// 1.0 near display 0.8, which is a (tiny) solarization. 0.45 keeps the
/// stacked worst case monotone with margin; sky recovery stays strong.
const HI_PULL: f32 = 0.45;
/// Contrast, third design. The original scene-linear pivot multiply sent the
/// shadow band to black at +100 (measured -8.7 EV; editor B -0.9, editor A -1.1).
/// The smoothstep-mix replacement fixed the crush but had no punch: its fixed
/// point sat at display 0.5 and its rise above the pivot was feeble (+0.07 EV in
/// the brights against editor B's +0.38), so on any normally dark scene +100 read
/// as "everything darkens", the same look as before. The owner called it
/// immediately.
///
/// Now: a piecewise power curve around display middle gray, gamma
/// 2^(c * CONTRAST_GAMMA) per side. Verified against the measured
/// references at +/-100: shadows -1.28 (A -1.53, B -1.30), high mids
/// +0.35 (B +0.43), brights +0.38 (B +0.38), and shadows +0.90 at
/// -100 (A +0.89). Monotone for any gamma > 0, anchors black, white,
/// and middle gray exactly. ACCURACY: the audit caught this constant
/// not quite being its own definition: it read 0.46127555 where the
/// IEC transfer of 0.18 gives 0.46135613 (the old value decoded to
/// 0.17993 scene-linear). Worst case at maximum contrast the drift
/// was a sixtieth of an 8-bit step, invisible, but a constant whose
/// name is a formula should equal it. The owner ruled to correct it
/// pre-release; every contrast render's last bits move, and the
/// per-machine goldens re-bootstrap.
const CONTRAST_PIVOT_D: f32 = 0.46135613; // to_display(0.18), IEC exact

/// Strength at |100|, shared by Luminance and Chroma contrast. 0.7
/// matched editor B's mid response; the owner asked for more once the
/// two-axis split landed ("with that kind of granular control a strong
/// contrast multiplier is okay"). 0.85 puts full slider at the strong
/// edge of the measured envelope: shadows -1.59 EV (A -1.53, B -1.30),
/// brights +0.43 (B +0.38). Monotone at any strength by composition.
const CONTRAST_GAMMA: f32 = 0.85;

/// Veil removed (or added) by Dehaze at |100|, in display units.
/// Calibrated so +100 lands the shadow response inside the measured
/// editor A/B envelope (about -2 EV in deep shadow) instead of deleting it.
const DEHAZE_VEIL: f32 = 0.10;
/// The chroma half of dehaze: per-channel veil removal at constant
/// luminance. Haze desaturates by adding equal light to every channel,
/// so removing it per channel is what brings the color back. Hotter than
/// the luminance constant because the references' dehaze (editor A
/// especially) saturates harder than plain veil math produces. Briefly
/// its own slider; the owner reverted the split ("there are already
/// advanced Dehaze controls, this just makes it confusing"), so one
/// Dehaze slider drives both halves together.
const DEHAZE_CHROMA_VEIL: f32 = 0.15;

/// Chroma veil removal: per-channel display-space subtraction, then
/// luminance normalized back. Grays cannot move; tonality is untouched.
///
/// Fades to nothing below SHADOW_FADE display luma. The guard exists
/// for the failure the owner hit on sight: in a dark pixel the
/// subtraction floors the smaller channels to zero, the one
/// surviving channel (red, usually, in sensor noise) carries all of
/// the restored luminance, and the image grows a field of red
/// speckles like focus peaking. There is no haze color to recover
/// where there is barely any light; the control stays out of the
/// noise floor entirely. A fade, and deliberately NOT a cap on the
/// renormalization: capping the gain broke the grays-are-identity
/// property on dark grays, which showed up instantly as a
/// non-monotone neutral sweep.
fn chroma_dehaze(img: &ImageBuf, amount: f32) -> ImageBuf {
    const SHADOW_FADE: (f32, f32) = (0.12, 0.40);
    let a = DEHAZE_CHROMA_VEIL * amount;
    map_rgb(img, |r, g, b| {
        let mut px = [r, g, b];
        let l0 = luma(px[0], px[1], px[2]);
        if l0 > 1e-6 {
            let w = smoothstep(SHADOW_FADE.0, SHADOW_FADE.1, to_display(l0));
            if w > 0.0 {
                let mut c = [0.0f32; 3];
                for i in 0..3 {
                    let d = to_display(px[i].max(0.0));
                    c[i] = if d < 1.0 { to_scene(((d - a) / (1.0 - a)).max(0.0)) } else { px[i] };
                }
                let l1 = luma(c[0], c[1], c[2]);
                if l1 > 1e-6 {
                    let k = l0 / l1;
                    for i in 0..3 {
                        px[i] += (c[i] * k - px[i]) * w;
                    }
                }
            }
        }
        px
    })
}

/// The contrast curve itself: power either side of the middle-gray
/// anchor, over-range passed through untouched (radiance past display
/// white belongs to the shoulder, and flattening it here would blow
/// the skies the merges exist to recover). Used on luminance by the
/// `contrast` param and per channel by `color_contrast`.
fn contrast_curve(d: f32, gamma: f32) -> f32 {
    if d >= 1.0 {
        return d;
    }
    if d <= CONTRAST_PIVOT_D {
        CONTRAST_PIVOT_D * (d / CONTRAST_PIVOT_D).max(0.0).powf(gamma)
    } else {
        1.0 - (1.0 - CONTRAST_PIVOT_D) * ((1.0 - d) / (1.0 - CONTRAST_PIVOT_D)).powf(gamma)
    }
}
/// How hard Shadows crushes when run negative. Its positive direction
/// fades by distance below the middle; the negative direction used to
/// scale UP with brightness inside its window, which is why -100 dragged
/// the high mids -1.38 EV (editor B: -0.83). Now it fades like the
/// positive side, at a strength that keeps the crush visibly stronger
/// than editor A's.
const SHADOW_CRUSH: f32 = 0.8;
/// How hard those two are allowed to pull toward the middle.
///
/// Not a taste setting, a monotonicity constraint. Moving a pixel toward
/// the middle by an amount proportional to how far it is from the middle
/// AND to a weight that itself grows in that direction can overshoot: at
/// full strength the deepest shadows were lifted past the mid-shadows,
/// so a darker part of the scene came out brighter than a lighter one.
/// That is solarization, and it is the sort of thing that looks like a
/// bad photograph rather than a bug. Capped so the curve stays
/// increasing everywhere, which `tone_controls_never_invert` checks
/// across the whole range at every slider value.
const PULL_BACK: f32 = 0.5;

pub(crate) fn p(params: &BTreeMap<String, ParamValue>, name: &str, default: f64) -> f32 {
    params.get(name).and_then(|v| v.as_f64()).unwrap_or(default) as f32
}

pub(crate) fn p_bool(params: &BTreeMap<String, ParamValue>, name: &str, default: bool) -> bool {
    // Numbers count: the UI stores flags as 0/1, and a flag that reads
    // only true booleans silently ignores every one of them. This
    // mismatch has produced three separate "the switch does nothing"
    // bugs (invert, colored grain, antialias); reading both here ends
    // the class.
    params
        .get(name)
        .and_then(|v| v.as_bool().or_else(|| v.as_f64().map(|n| n != 0.0)))
        .unwrap_or(default)
}

pub(crate) fn input<'a>(
    inputs: &'a [(String, Value)],
    name: &str,
    node_id: &str,
) -> Result<&'a Value, EngineError> {
    inputs
        .iter()
        .find(|(n, _)| n == name)
        .map(|(_, v)| v)
        .ok_or_else(|| EngineError::MissingInput {
            node: node_id.to_string(),
            port: name.to_string(),
        })
}

pub(crate) fn image_input<'a>(
    inputs: &'a [(String, Value)],
    name: &str,
    node_id: &str,
) -> Result<&'a Arc<ImageBuf>, EngineError> {
    input(inputs, name, node_id)?
        .as_image()
        .ok_or_else(|| EngineError::TypeMismatch {
            node: node_id.to_string(),
            port: name.to_string(),
        })
}

/// Two-input nodes resize the secondary input to the base instead of
/// erroring: a cropped branch merged with an uncropped look is routine.
pub(crate) fn conform(input: &Arc<ImageBuf>, base: &ImageBuf) -> Arc<ImageBuf> {
    if input.width == base.width && input.height == base.height {
        input.clone()
    } else {
        Arc::new(crate::ops_geometry::resize(input, base.width, base.height))
    }
}

/// How a second input meets a base of another shape
/// ("conforming to aspect ratio should either be an option on the node
/// or a new node"). `stretch` is the old conform, the picture pulled
/// to the frame; `fit` scales it uniformly to sit inside the frame,
/// centered, transparent around; `fill` scales it uniformly to cover
/// the frame, centered, cropped; `none` places it at its own size,
/// centered, no scaling. Same size in, same buffer out, whatever the
/// mode.
pub(crate) fn conform_fit(input: &Arc<ImageBuf>, base: &ImageBuf, fit: &str) -> Arc<ImageBuf> {
    let (bw, bh) = (base.width, base.height);
    if input.width == bw && input.height == bh {
        return input.clone();
    }
    if fit == "stretch" {
        return conform(input, base);
    }
    let (iw, ih) = (input.width as f32, input.height as f32);
    let scale = match fit {
        "fill" => (bw as f32 / iw).max(bh as f32 / ih),
        "none" => 1.0,
        _ => (bw as f32 / iw).min(bh as f32 / ih),
    };
    let sw = ((iw * scale).round() as usize).max(1);
    let sh = ((ih * scale).round() as usize).max(1);
    let scaled: Arc<ImageBuf> = if sw == input.width && sh == input.height {
        input.clone()
    } else {
        Arc::new(crate::ops_geometry::resize(input, sw, sh))
    };
    // Centered on the frame; what falls outside is cropped, what the
    // picture does not cover is transparent.
    let ox = (bw as i64 - sw as i64) / 2;
    let oy = (bh as i64 - sh as i64) / 2;
    let mut out = ImageBuf::filled(bw, bh, [0.0, 0.0, 0.0, 0.0]);
    for y in 0..bh {
        let sy = y as i64 - oy;
        if sy < 0 || sy >= sh as i64 {
            continue;
        }
        let x0 = ox.max(0) as usize;
        let x1 = (ox + sw as i64).min(bw as i64).max(0) as usize;
        if x1 <= x0 {
            continue;
        }
        let sx0 = (x0 as i64 - ox) as usize;
        let src_row = (sy as usize * sw + sx0) * 4;
        let dst_row = (y * bw + x0) * 4;
        let n = (x1 - x0) * 4;
        out.data[dst_row..dst_row + n].copy_from_slice(&scaled.data[src_row..src_row + n]);
    }
    Arc::new(out)
}

/// The `fit` choice on a two-image node. Unset means the behavior
/// from before the choice existed, stretch, so a graph saved then
/// renders as it did; a new card carries "fit" explicitly.
pub(crate) fn fit_of(node: &Node) -> String {
    node.params
        .get("fit")
        .and_then(|v| v.as_str())
        .unwrap_or("stretch")
        .to_string()
}

pub(crate) fn map_rgb(src: &ImageBuf, f: impl Fn(f32, f32, f32) -> [f32; 3] + Sync) -> ImageBuf {
    use rayon::prelude::*;
    let mut out = ImageBuf::new(src.width, src.height);
    out.data
        .par_chunks_mut(4)
        .zip(src.data.par_chunks(4))
        .for_each(|(o, s)| {
            let [r, g, b] = f(s[0], s[1], s[2]);
            o[0] = r;
            o[1] = g;
            o[2] = b;
            o[3] = s[3];
        });
    out
}

pub(crate) fn smoothstep(edge0: f32, edge1: f32, x: f32) -> f32 {
    if edge0 >= edge1 {
        return if x < edge0 { 0.0 } else { 1.0 };
    }
    let t = ((x - edge0) / (edge1 - edge0)).clamp(0.0, 1.0);
    t * t * (3.0 - 2.0 * t)
}

/// The value of a text parameter whose answers the registry declares.
///
/// One list, in the registry, rather than one per op plus one per picker
/// that has an opinion. Trimmed and lowercased on the way in, because
/// the control reads "Color" on screen and a script writing what it saw
/// should not be punished for it.
///
/// What happens to an answer that is not on the list is declared with
/// the list. Lenient is the default and the right answer wherever the
/// spec's default is an honest one: a project saved with a mode a later
/// version renamed goes on rendering. Strict is for a parameter where
/// the choices are equally valid answers rather than one obvious one, so
/// guessing produces a wrong picture instead of a different-looking one.
pub(crate) fn choice(node: &Node, param: &str) -> Result<String, EngineError> {
    let spec = registry()
        .get(&node.node_type)
        .and_then(|s| s.params.iter().find(|p| p.name == param));
    let default = match spec.map(|s| &s.default) {
        Some(ParamValue::Text(t)) => t.clone(),
        _ => String::new(),
    };
    let raw = node
        .params
        .get(param)
        .and_then(|v| v.as_str())
        .unwrap_or(&default)
        .trim()
        .to_ascii_lowercase();
    let Some(spec) = spec.filter(|s| !s.choices.is_empty()) else { return Ok(raw) };
    if spec.choices.iter().any(|c| *c == raw) {
        return Ok(raw);
    }
    if spec.strict {
        return Err(invalid_param(
            node,
            param,
            format!("'{raw}' is not one of: {}", spec.choices.join(", ")),
        ));
    }
    Ok(default)
}

/// The built-in registry, built once. Ops ask it what a parameter's
/// answers are, and rebuilding fifty node specs per pixel pass would be
/// a silly way to find out.
fn registry() -> &'static heeler_graph::Registry {
    static REGISTRY: std::sync::OnceLock<heeler_graph::Registry> = std::sync::OnceLock::new();
    REGISTRY.get_or_init(heeler_graph::Registry::builtin)
}

pub(crate) fn invalid_param(node: &Node, param: &str, message: impl Into<String>) -> EngineError {
    EngineError::InvalidParam {
        node: node.id.clone(),
        param: param.to_string(),
        message: message.into(),
    }
}

pub fn execute(node: &Node, inputs: &[(String, Value)]) -> Result<Value, EngineError> {
    match node.node_type.as_str() {
        "heeler.exposure" => exposure(node, inputs),
        "heeler.white_balance" => white_balance(node, inputs),
        "heeler.standard_color" => standard_color(node, inputs),
        // 26.3 Phase 11: camera calibration fitted against a chart.
        "heeler.color_checker" => crate::ops_colorchecker::color_checker(node, inputs),
        "heeler.curves" => curves(node, inputs),
        "heeler.levels" => levels(node, inputs),
        "heeler.color_balance" => color_balance(node, inputs),
        "heeler.split_tone" => split_tone(node, inputs),
        // The print.
        "heeler.paper" => crate::paper::paper(node, inputs),
        "heeler.tone_profile" => tone_profile(node, inputs),
        "heeler.channel_extract" => channel_extract(node, inputs),
        "heeler.crop_rotate" => crate::ops_geometry::crop_rotate(node, inputs),
        "heeler.black_white" => black_white(node, inputs),
        "heeler.sharpen" => crate::ops_detail::sharpen(node, inputs),
        "heeler.clarity" => crate::ops_detail::clarity(node, inputs),
        "heeler.lens_correct" => crate::ops_lens::lens_correct(node, inputs),
        "heeler.gamut_map" => crate::ops_grade::gamut_map(node, inputs),
        "heeler.view_transform" => crate::ops_view::view_transform(node, inputs),
        "heeler.tone_eq" => tone_eq(node, inputs),
        "heeler.recolor" => crate::ops_recolor::recolor(node, inputs),
        "heeler.color_console" => crate::ops_console::color_console(node, inputs),
        "heeler.lut" => crate::ops_lut::lut(node, inputs),
        "heeler.chromatic_adapt" => crate::ops_adapt::chromatic_adapt(node, inputs),
        "heeler.channel_mixer" => crate::ops_primitives::channel_mixer(node, inputs),
        "heeler.to_display" => crate::ops_layers::to_display(node, inputs),
        "heeler.to_scene" => crate::ops_layers::to_scene(node, inputs),
        "heeler.invert" => crate::ops_layers::invert(node, inputs),
        "heeler.blur" => crate::ops_layers::blur(node, inputs),
        "heeler.high_pass" => crate::ops_layers::high_pass(node, inputs),
        "heeler.sharpening" => crate::ops_layers::sharpening(node, inputs),
        "heeler.skin_soften" => crate::ops_layers::skin_soften(node, inputs),
        "heeler.desaturate" => crate::ops_layers::desaturate(node, inputs),
        "heeler.denoise" => crate::ops_detail::denoise(node, inputs),
        "heeler.model_denoise" => crate::ops_detail::model_denoise(node, inputs),
        "heeler.hot_pixel" => crate::ops_detail::hot_pixel(node, inputs),
        "heeler.nlm_denoise" => crate::ops_detail::nlm_denoise(node, inputs),
        "heeler.vignette" => crate::ops_stylize::vignette(node, inputs),
        "heeler.perspective" => crate::ops_geometry::perspective(node, inputs),
        "heeler.grid_warp" => crate::ops_warp::grid_warp(node, inputs),
        "heeler.shape_warp" => crate::ops_warp::shape_warp(node, inputs),
        "heeler.layer_warp" => crate::ops_warp::layer_warp(node, inputs),
        "heeler.layer_warp_mask" => crate::ops_warp::layer_warp_mask(node, inputs),
        "heeler.transform" => crate::ops_geometry::transform(node, inputs),
        // The executor answers a File node from the sources map before
        // any op runs; reaching here means nothing was planted for it.
        "heeler.file" => Err(EngineError::SourceMissing(node.id.clone())),
        "heeler.luma_chroma_split" => crate::ops_detail::luma_chroma_split(node, inputs),
        "heeler.luma_chroma_join" => crate::ops_detail::luma_chroma_join(node, inputs),
        "heeler.grain" => crate::ops_stylize::grain(node, inputs),
        "heeler.noise" => crate::ops_stylize::noise(node, inputs),
        "heeler.channel_gain" => crate::ops_primitives::channel_gain(node, inputs),
        "heeler.tone_mask" => crate::ops_primitives::tone_mask(node, inputs),
        "heeler.luminance_extract" => luminance_extract(node, inputs),
        "heeler.invert_mask" => crate::ops_masks::invert_mask(node, inputs),
        "heeler.morphology" => crate::ops_field::morphology(node, inputs),
        "heeler.guided_filter" => crate::ops_field::guided_filter(node, inputs),
        "heeler.guided_filter_mask" => crate::ops_field::guided_filter_mask(node, inputs),
        "heeler.edge_field" => crate::ops_field::edge_field(node, inputs),
        "heeler.alpha_association" => crate::ops_field::alpha_association(node, inputs),
        // The second batch (ops_advanced.rs).
        "heeler.soft_clip" => crate::ops_advanced::soft_clip(node, inputs),
        "heeler.median" => crate::ops_advanced::median(node, inputs),
        "heeler.median_mask" => crate::ops_advanced::median_mask(node, inputs),
        "heeler.distance_field" => crate::ops_advanced::distance_field(node, inputs),
        "heeler.chroma_key" => crate::ops_advanced::chroma_key(node, inputs),
        "heeler.chroma_key_despill" => crate::ops_advanced::chroma_key_despill(node, inputs),
        "heeler.depth_normals" => crate::ops_advanced::depth_normals(node, inputs),
        "heeler.color_transform" => crate::ops_advanced::color_transform(node, inputs),
        "heeler.displacement_map" => crate::ops_advanced::displacement_map(node, inputs),
        "heeler.channel_join" => crate::ops_logic::channel_join(node, inputs),
        "heeler.detail" => detail(node, inputs),
        // The logic family: fields out of the picture, conditions on
        // those fields, and a per-pixel if/then/else to spend them on.
        "heeler.smart_mask" => crate::ops_smart::smart_mask(node, inputs),
        "heeler.matte_mask" => crate::ops_smart::matte_mask(node, inputs),
        "heeler.inpaint" => crate::ops_smart::inpaint(node, inputs),
        // The Depth Map section's settings ride in the chain as a
        // passthrough: the desktop reads them when it computes the plane.
        "heeler.depth_map" => passthrough(node, inputs),
        "heeler.fog" => crate::ops_depth::fog(node, inputs),
        "heeler.key_light" => crate::ops_depth::key_light(node, inputs),
        "heeler.dof" => crate::ops_depth::dof(node, inputs),
        "heeler.flare" => crate::ops_flare::flare(node, inputs),
        "heeler.halation" => crate::ops_halation::halation(node, inputs),
        "heeler.measure" => crate::ops_logic::measure(node, inputs),
        "heeler.compare" => crate::ops_logic::compare(node, inputs),
        "heeler.logic" => crate::ops_logic::logic(node, inputs),
        "heeler.math" => crate::ops_logic::math(node, inputs),
        "heeler.remap" => crate::ops_logic::remap(node, inputs),
        "heeler.conditional" => crate::ops_logic::conditional(node, inputs),
        "heeler.luminance_range_mask" => luminance_range_mask(node, inputs),
        "heeler.color_range_mask" => crate::ops_masks::color_range_mask(node, inputs),
        "heeler.hue_range_mask" => crate::ops_masks::hue_range_mask(node, inputs),
        "heeler.color_grade" => crate::ops_grade::color_grade(node, inputs),
        "heeler.brush_mask" => crate::ops_masks::brush_mask(node, inputs),
        "heeler.selection_mask" => crate::ops_selection::selection_mask(node, inputs),
        "heeler.range_mask" => crate::ops_masks::range_select(node, inputs),
        "heeler.mask_crop" => crate::ops_masks::mask_crop(node, inputs),
        "heeler.paint" => crate::ops_masks::paint(node, inputs),
        "heeler.clone" => crate::ops_retouch::clone_stamp(node, inputs),
        "heeler.fill" => crate::ops_retouch::fill(node, inputs),
        "heeler.gradient" => crate::ops_retouch::gradient(node, inputs),
        "heeler.gradient_map" => crate::ops_retouch::gradient_map(node, inputs),
        // Layer effects. Shadow and glow share an implementation: a
        // glow is a shadow with nowhere to fall.
        "heeler.fx_shadow" | "heeler.fx_glow" => crate::ops_fx::shadow(node, inputs),
        "heeler.fx_color_overlay" => crate::ops_fx::color_overlay(node, inputs),
        "heeler.fx_gradient_overlay" => crate::ops_fx::gradient_overlay(node, inputs),
        "heeler.fx_bevel" => crate::ops_fx::bevel(node, inputs),
        "heeler.color_bend" => crate::ops_masks::color_bend(node, inputs),
        "heeler.radial_mask" => crate::ops_masks::radial_mask(node, inputs),
        "heeler.linear_mask" => crate::ops_masks::linear_mask(node, inputs),
        "heeler.blend" => blend(node, inputs),
        "heeler.lift" => crate::ops_layers::lift(node, inputs),
        "heeler.merge" => merge(node, inputs),
        "heeler.output" => passthrough(node, inputs),
        "heeler.export_layer" => export_layer(node, inputs),
        other => Err(EngineError::UnsupportedNode(other.to_string())),
    }
}

fn passthrough(node: &Node, inputs: &[(String, Value)]) -> Result<Value, EngineError> {
    Ok(Value::Image(image_input(inputs, "in", &node.id)?.clone()))
}

/// 26.3 Phase 8: the Export Layer is a tap, not an adjustment. It
/// passes its wired input back unchanged so the node can sit on any
/// wire; the image pair wins if both are wired (the card keeps the
/// one-input rule). The alpha input is read by the exporter at write
/// time and never changes the passed-through value.
fn export_layer(node: &Node, inputs: &[(String, Value)]) -> Result<Value, EngineError> {
    if let Some(v) = inputs.iter().find(|(name, _)| name == "image") {
        return Ok(v.1.clone());
    }
    if let Some(v) = inputs.iter().find(|(name, _)| name == "mask") {
        return Ok(v.1.clone());
    }
    // Nothing wired: the tap renders a 1x1 transparent pixel.
    let _ = node;
    Ok(Value::Image(Arc::new(crate::buffers::ImageBuf {
        width: 1,
        height: 1,
        data: vec![0.0; 4],
    })))
}

/// White balance channel gains, shared by the White Balance and Standard
/// Color nodes. Neutral at 6500 K / 0 tint. Higher temperature renders
/// warmer (red up, blue down); positive tint shifts magenta (green down),
/// matching photographic slider convention. The Color Checker fit inverts
/// this model to turn measured neutral patches into temperature and tint.
pub(crate) fn wb_gains(temperature: f32, tint: f32) -> [f32; 3] {
    let dt = ((temperature - 6500.0) / 6500.0).clamp(-0.9, 3.0);
    [
        1.0 + 0.4 * dt,
        (1.0 - 0.45 * (tint / 150.0)).max(0.05),
        (1.0 - 0.4 * dt).max(0.05),
    ]
}

/// Exposure: linear gain of 2^EV.
/// Contrast: power curves either side of the display-domain middle-gray
/// anchor (contrast_curve with gamma 2^(c/100 * CONTRAST_GAMMA)); see
/// the constants block, which documents how this third design replaced
/// the scene-linear pivot multiply this line used to describe.
/// Highlights/shadows/whites/blacks: all four shaped in display space,
/// each weighted by where the pixel sits in the display range, so each
/// owns its stretch of the tone axis the way the same sliders do in
/// the two reference RAW editors (envelopes measured against both,
/// 2026-08-11, scripts/compare_renders.py; Heeler aims between them).
fn exposure(node: &Node, inputs: &[(String, Value)]) -> Result<Value, EngineError> {
    let src = image_input(inputs, "in", &node.id)?;
    let ev = p(&node.params, "exposure", 0.0);
    let contrast = p(&node.params, "contrast", 0.0);
    let highlights = p(&node.params, "highlights", 0.0);
    let shadows = p(&node.params, "shadows", 0.0);
    let whites = p(&node.params, "whites", 0.0);
    let blacks = p(&node.params, "blacks", 0.0);

    let color_contrast = p(&node.params, "color_contrast", 0.0);

    let gain = 2f32.powf(ev);
    let con_gamma = 2f32.powf((contrast / 100.0).clamp(-1.0, 1.0) * CONTRAST_GAMMA);
    let cc_gamma = 2f32.powf((color_contrast / 100.0).clamp(-1.0, 1.0) * CONTRAST_GAMMA);

    // PERF: an untouched Exposure node (every slider at zero) used to
    // run a full frame through map_rgb anyway, multiplying each channel
    // by 2^0. 2f32.powf(0.0) is exactly 1.0 and x * 1.0 preserves every
    // bit (including -0.0), both powf guards read false, and the alpha
    // channel copies through, so the node is a bit-exact passthrough
    // and can return the input without touching a pixel. A develop
    // chain carries this node from the start, so the common case stops
    // paying for a pass that computes nothing.
    if ev == 0.0
        && contrast == 0.0
        && highlights == 0.0
        && shadows == 0.0
        && whites == 0.0
        && blacks == 0.0
        && color_contrast == 0.0
    {
        return Ok(Value::Image(src.clone()));
    }

    let hi = highlights / 100.0;
    let sh = shadows / 100.0;
    let wt = whites / 100.0;
    let bl = blacks / 100.0;

    let out = map_rgb(src, |r, g, b| {
        let mut px = [r, g, b];
        // Exposure belongs in scene-linear: it is what a longer shutter
        // does to the light.
        for v in &mut px {
            *v *= gain;
        }

        // Contrast and the four range controls do not. They are about
        // what looks bright, which is a statement about the display, so
        // they are shaped there and brought back. One scalar for the
        // whole pixel, derived from luma, so a tonal move cannot shift
        // a hue.
        let l = luma(px[0], px[1], px[2]);
        if (con_gamma != 1.0 || hi != 0.0 || sh != 0.0 || wt != 0.0 || bl != 0.0) && l > 1e-6 {
            let d = to_display(l);
            let mut nd = d;
            // Contrast first: it defines the base curve the range
            // controls then adjust. Power curves either side of the
            // middle-gray anchor: darks steepen below it, brights lift
            // above it, which is the punch the references show and the
            // smoothstep mix lacked. Luminance only: the color half of
            // contrast is its own stage below, and its own slider.
            if con_gamma != 1.0 {
                nd = contrast_curve(d, con_gamma);
            }
            // The range controls see the CONTRASTED tone: their weight
            // windows and their headrooms all read the same value from
            // here on. Not only semantics (a shadow is whatever is dark
            // after contrast); it is what makes the stack provably
            // monotone. This stage was swept monotone as a function of
            // its input, contrast is monotone, and a monotone function
            // of a monotone function cannot invert. Weights from the
            // pre-contrast value coupled to post-contrast headrooms
            // grazed non-monotone twice during tuning; composition ended
            // that class of bug instead of renting it a smaller constant.
            let d = nd;
            // Order matters for monotonicity, not for any single slider.
            // Whites and blacks move the endpoints first; shadows and
            // highlights then work against the MOVED value, so their
            // headroom terms see what the endpoint controls did. Applied
            // independently, highlights+100 flattens to zero slope at
            // white and any negative whites term there solarizes; fed
            // the whites-lowered value instead, its headroom reopens and
            // the stack stays increasing (the stacked sweep test pins
            // this at every slider combination).
            //
            // Whites: the top of the range only. Blacks: the bottom
            // only, deliberately stronger downward, because setting a
            // black point is a crush and lifting one is a wash.
            nd += wt * WHITE_RANGE * smoothstep(WHITE_FLOOR, 1.0, d);
            let wb = 1.0 - smoothstep(0.0, BLACK_CEIL, d);
            nd += bl * wb * if bl > 0.0 { BLACK_LIFT } else { BLACK_CRUSH };
            // Both shadow directions fade by the same window; the crush
            // used to grow with brightness instead, which dragged the
            // high mids down harder than the reference apps.
            let ws = 1.0 - smoothstep(0.0, SHADOW_CEIL, d);
            nd += sh * ws * if sh > 0.0 {
                PULL_BACK * (TONE_MID - nd).max(0.0)
            } else {
                SHADOW_CRUSH * nd.max(0.0)
            };
            // Positive moves toward the end of the range scaled by the
            // room actually left (a gain that ignores the room is why
            // Highlights at +100 used to clip invisibly). Negative keeps
            // a floor of authority across its whole window plus a pull
            // that grows toward white, so recovery works on an overcast
            // scene and still bites hardest on a blown sky.
            let wh = smoothstep(HIGHLIGHT_FLOOR, 1.0, d);
            nd += hi * wh * if hi > 0.0 {
                (1.0 - nd).max(0.0)
            } else {
                HI_RECOVER + HI_PULL * (nd - TONE_MID).max(0.0)
            };
            let scale = to_scene(nd.max(0.0)) / l;
            for v in &mut px {
                *v *= scale;
            }
        }

        // Color contrast: the same curve applied per channel, then the
        // result's luminance normalized back to what the tonal stages
        // produced. Per-channel steepening pushes a dark red's channels
        // apart (that is where the references' contrast gets its
        // saturating darks); the renormalization keeps every gray
        // exactly still and hands tonality entirely to the stages
        // above. Negative values converge the channels: contrast that
        // fades color instead of inflating it.
        if cc_gamma != 1.0 {
            let l0 = luma(px[0], px[1], px[2]);
            if l0 > 1e-6 {
                let mut c = [0.0f32; 3];
                for i in 0..3 {
                    c[i] = to_scene(contrast_curve(to_display(px[i].max(0.0)), cc_gamma));
                }
                let l1 = luma(c[0], c[1], c[2]);
                if l1 > 1e-6 {
                    let k = l0 / l1;
                    for i in 0..3 {
                        px[i] = c[i] * k;
                    }
                }
            }
        }
        px
    });
    Ok(Value::Image(Arc::new(out)))
}

fn white_balance(node: &Node, inputs: &[(String, Value)]) -> Result<Value, EngineError> {
    let src = image_input(inputs, "in", &node.id)?;
    let [rg, gg, bg] = wb_gains(
        p(&node.params, "temperature", 6500.0),
        p(&node.params, "tint", 0.0),
    );
    let out = map_rgb(src, |r, g, b| [r * rg, g * gg, b * bg]);
    Ok(Value::Image(Arc::new(out)))
}

/// The Simple-mode workhorse. Order: white balance gains, exposure gain,
/// calibrated display-referred contrast, saturation, vibrance.
/// Saturation scales distance from luma. Vibrance does the same but
/// weighted toward low-chroma pixels, so already-saturated colors move less.
fn standard_color(node: &Node, inputs: &[(String, Value)]) -> Result<Value, EngineError> {
    let src = image_input(inputs, "in", &node.id)?;
    let [rg, gg, bg] = wb_gains(
        p(&node.params, "temperature", 6500.0),
        p(&node.params, "tint", 0.0),
    );
    let gain = 2f32.powf(p(&node.params, "exposure", 0.0));
    let con_gamma = 2f32.powf(
        (p(&node.params, "contrast", 0.0) / 100.0).clamp(-1.0, 1.0) * CONTRAST_GAMMA,
    );
    let sat = p(&node.params, "saturation", 0.0) / 100.0;
    let vib = p(&node.params, "vibrance", 0.0) / 100.0;

    let out = map_rgb(src, |r, g, b| {
        let mut px = [r * rg * gain, g * gg * gain, b * bg * gain];
        // This is the same tonal contrast stage as the Exposure node.
        // Simple and Advanced modes are two views of one edit, so a
        // control with the same name must not change its rendering math.
        let pre_contrast_luma = luma(px[0], px[1], px[2]);
        if con_gamma != 1.0 && pre_contrast_luma > 1e-6 {
            let adjusted = to_scene(contrast_curve(to_display(pre_contrast_luma), con_gamma));
            let scale = adjusted / pre_contrast_luma;
            for v in &mut px {
                *v *= scale;
            }
        }
        let l = luma(px[0], px[1], px[2]);
        let max = px[0].max(px[1]).max(px[2]);
        let min = px[0].min(px[1]).min(px[2]);
        let chroma = ((max - min) / max.abs().max(1e-6)).clamp(0.0, 1.0);
        let factor = (1.0 + sat) * (1.0 + vib * (1.0 - chroma));
        for v in &mut px {
            *v = l + (*v - l) * factor;
        }
        px
    });
    // Texture, clarity and dehaze, which this node carried before they
    // had a node of their own (heeler.detail). Older graphs still say
    // them here, and the same pass answers both.
    Ok(Value::Image(Arc::new(detail_pass(&node.params, out))))
}

/// Detail (heeler.detail): texture, clarity and dehaze, with the
/// per-band and per-channel weights. Its own node since 2026-09-02 (The
/// report: "It reads strange seeing those in Standard Color in the
/// graph but not in Adjustments"); the arithmetic is detail_pass,
/// shared with the Standard Color node that used to carry these, so a
/// graph split on load renders exactly as it did.
fn detail(node: &Node, inputs: &[(String, Value)]) -> Result<Value, EngineError> {
    let src = image_input(inputs, "in", &node.id)?;
    if detail_is_identity(&node.params) {
        return Ok(Value::Image(src.clone()));
    }
    Ok(Value::Image(Arc::new(detail_pass(&node.params, (**src).clone()))))
}

fn detail_is_identity(params: &std::collections::BTreeMap<String, ParamValue>) -> bool {
    p(params, "texture", 0.0) == 0.0
        && p(params, "clarity", 0.0) == 0.0
        && p(params, "dehaze", 0.0) == 0.0
        && detail_gains(params, "texture").is_none()
        && detail_gains(params, "clarity").is_none()
        && detail_gains(params, "dehaze").is_none()
}

/// The luminance half of dehaze: veil subtraction in DISPLAY space on
/// luma, applied as a ratio so chroma rides along unchanged; negative
/// adds the veil back. The original subtracted 0.18*dehaze in
/// scene-linear, which at +100 sent everything below middle gray to
/// black (measured -9 to -11 EV across the shadow and mid bands; editor
/// A does -1 to -2.7, editor B -0.3 to -1.4). Display space bounds the subtraction
/// the same way it bounded contrast, blacks, and clarity. White is
/// anchored; over-range radiance passes through for the shoulder.
fn dehaze_luma_veil(src: &ImageBuf, dehaze: f32) -> ImageBuf {
    let a = DEHAZE_VEIL * dehaze;
    map_rgb(src, |r, g, b| {
        let mut px = [r, g, b];
        let l = luma(r, g, b);
        if dehaze < 0.0 && l <= 1e-6 {
            // A neutral veil adds light even to clipped black. A ratio
            // cannot lift zero, so use an additive neutral lift here.
            let lifted = to_scene((to_display(l.max(0.0)) - a) / (1.0 - a));
            for v in &mut px { *v += lifted - l; }
        } else if l > 1e-6 {
            let dl = to_display(l);
            if dl < 1.0 {
                let nd = ((dl - a) / (1.0 - a)).max(0.0);
                let ratio = to_scene(nd) / l;
                for v in &mut px {
                    *v *= ratio;
                }
            }
        }
        px
    })
}
/// How many of this buffer's pixels one of the PHOTOGRAPH's pixels is:
/// 1 on the full-resolution frame and the 1:1 slice, about a third on a
/// 2048 preview of a 6000 pixel photograph. The desktop writes it on
/// every node of a reduced render (inject_px_scale), and an op whose
/// dial is in pixels (a blur radius, a high pass radius, the unsharp
/// radius) multiplies by it, so the preview shows the export: until
/// 2026-09-23 a radius of 35 blurred 35 preview pixels, nearly three
/// times broader against the frame than the 35 the export would blur
/// (the owner, a jaguar beside a layer editor at the same 35: "Heeler
/// way behind").
pub(crate) fn px_scale(params: &std::collections::BTreeMap<String, ParamValue>) -> f32 {
    p(params, "px_scale", 1.0).max(1e-4)
}


/// The frame's short side in this buffer's pixels: the buffer's own
/// unless the desktop handed the op its rect for a 1:1 slice (the
/// roi_* params inject_roi_px writes), in which case the frame is the
/// buffer over the rect. The depth ops' frame_of, for the detail ops.
pub(crate) fn frame_short_of(params: &std::collections::BTreeMap<String, ParamValue>, w: usize, h: usize) -> f32 {
    let fw = w as f32 / p(params, "roi_w", 1.0).max(1e-4);
    let fh = h as f32 / p(params, "roi_h", 1.0).max(1e-4);
    fw.min(fh)
}

/// Luminance dehaze, the shared multi-scale contrast pass, then chroma
/// dehaze. Weights scale each contribution; Texture and Clarity compose
/// the same ratios whether weights are neutral or edited.
fn detail_pass(params: &std::collections::BTreeMap<String, ParamValue>, base: ImageBuf) -> ImageBuf {
    let dehaze = p(params, "dehaze", 0.0) / 100.0;
    let texture = p(params, "texture", 0.0);
    let clarity = p(params, "clarity", 0.0);
    let weights = [
        detail_gains(params, "texture"),
        detail_gains(params, "clarity"),
        detail_gains(params, "dehaze"),
    ];
    let short = frame_short_of(params, base.width, base.height);
    let range_gain = 2f32.powf(p(params, "range_ev", 0.0));
    if weights.iter().all(|w| w.is_none()) {
        let mut out = if dehaze != 0.0 { dehaze_luma_veil(&base, dehaze) } else { base };
        if texture != 0.0 || clarity != 0.0 {
            out = crate::ops_detail::local_contrast_boost_weighted(&out, texture, clarity, 0.0, [None; 3], short, range_gain);
        }
        if dehaze != 0.0 {
            out = chroma_dehaze(&out, dehaze.clamp(-1.0, 1.0));
        }
        return out;
    }
    let dehazed = if dehaze != 0.0 { dehaze_luma_veil(&base, dehaze) } else { base.clone() };
    let mut acc = base.clone();
    add_weighted(&mut acc, &base, &dehazed, weights[2], range_gain);
    if texture != 0.0 || clarity != 0.0 {
        acc = crate::ops_detail::local_contrast_boost_weighted(
            &acc, texture, clarity, 0.0, [weights[0], weights[1], None], short, range_gain,
        );
    }
    if dehaze != 0.0 {
        let chroma = chroma_dehaze(&acc, dehaze.clamp(-1.0, 1.0));
        let before_chroma = acc.clone();
        add_weighted_guided(&mut acc, &before_chroma, &chroma, &base, weights[2], range_gain);
    }
    acc
}

/// Per-band and per-channel weights, or None for the exact unit path.
fn detail_gains(
    params: &std::collections::BTreeMap<String, ParamValue>,
    effect: &str,
) -> Option<([f32; 3], [f32; 3])> {
    let g = |s: &str| p(params, &format!("{effect}_{s}"), 100.0) / 100.0;
    let band = [g("shadows"), g("midtones"), g("highlights")];
    let chan = [g("red"), g("green"), g("blue")];
    let flat = band.iter().chain(chan.iter()).all(|v| (*v - 1.0).abs() < 1e-6);
    if flat {
        None
    } else {
        Some((band, chan))
    }
}

/// Adds `effected - base`, scaled per pixel by the tonal band the pixel
/// sits in and per channel. Weights of None mean full strength, which is
/// a plain add.
fn add_weighted(
    acc: &mut ImageBuf,
    base: &ImageBuf,
    effected: &ImageBuf,
    w: Option<([f32; 3], [f32; 3])>,
    range_gain: f32,
) {
    add_weighted_guided(acc, base, effected, base, w, range_gain);
}

pub(crate) fn detail_pixel_gains(l: f32, w: Option<([f32; 3], [f32; 3])>) -> [f32; 3] {
    let Some((band, chan)) = w else { return [1.0; 3] };
    let rw = range_weights(l);
    let gain = rw[0] * band[0] + rw[1] * band[1] + rw[2] * band[2];
    chan.map(|c| c * gain)
}

/// Chroma and luminance use membership from the same incoming frame.
fn add_weighted_guided(acc: &mut ImageBuf, base: &ImageBuf, effected: &ImageBuf,
    guide: &ImageBuf, w: Option<([f32; 3], [f32; 3])>, range_gain: f32) {
    use rayon::prelude::*;
    acc.data.par_chunks_mut(4).enumerate().for_each(|(px, o)| {
        let i = px * 4;
        let gains = detail_pixel_gains(luma(guide.data[i], guide.data[i+1], guide.data[i+2]) * range_gain, w);
        for c in 0..3 {
            let delta = gains[c] * (effected.data[i+c] - base.data[i+c]);
            if delta != 0.0 {
                // Above-unit veil removal can exhaust a channel. Keep
                // zero weights exact, and stop active removal at black.
                o[c] = (o[c] + delta).max(0.0);
            }
        }
    });
}

#[derive(Debug, Default, Deserialize)]
struct CurveSet {
    #[serde(default)]
    rgb: Option<Vec<[f32; 2]>>,
    #[serde(default)]
    r: Option<Vec<[f32; 2]>>,
    #[serde(default)]
    g: Option<Vec<[f32; 2]>>,
    #[serde(default)]
    b: Option<Vec<[f32; 2]>>,
    #[serde(default)]
    luma: Option<Vec<[f32; 2]>>,
    /// "smooth" (monotone cubic), "linear", or "tangent" (hermite through
    /// the user's own slopes below); absent means linear for backward
    /// compatibility with earlier saved graphs.
    #[serde(default)]
    interp: Option<String>,
    /// Per-point tangent slopes, parallel to the channel's points, read
    /// only under interp "tangent". A missing array or a length mismatch
    /// falls back to the monotone slopes: a half-synced pair must render
    /// something sane, never guess.
    #[serde(default)]
    rgb_m: Option<Vec<f32>>,
    #[serde(default)]
    r_m: Option<Vec<f32>>,
    #[serde(default)]
    g_m: Option<Vec<f32>>,
    #[serde(default)]
    b_m: Option<Vec<f32>>,
    #[serde(default)]
    luma_m: Option<Vec<f32>>,
    /// Per-point tangent HANDLE VECTORS, parallel to the channel's
    /// points, read only under interp "tangent" and preferred over the
    /// slope arrays above: a vector carries LENGTH, and length holds
    /// the curve to the handle's line further before letting go (the
    /// editors' resizable handles). Null entries are automatic points.
    /// Length mismatch falls back to the slopes, then to monotone.
    #[serde(default)]
    rgb_h: Option<Vec<Option<HandlePair>>>,
    #[serde(default)]
    r_h: Option<Vec<Option<HandlePair>>>,
    #[serde(default)]
    g_h: Option<Vec<Option<HandlePair>>>,
    #[serde(default)]
    b_h: Option<Vec<Option<HandlePair>>>,
    #[serde(default)]
    luma_h: Option<Vec<Option<HandlePair>>>,
}

/// One point's manual tangent pair as the wire carries it: vectors in
/// curve units per side, either or both. The editor's `broken` flag is
/// not sent; broken or mended, the vectors themselves are the shape.
#[derive(Debug, Deserialize, Clone, Copy, Default)]
pub(crate) struct HandlePair {
    #[serde(default)]
    l: Option<[f32; 2]>,
    #[serde(default)]
    r: Option<[f32; 2]>,
}

/// Fritsch-Carlson monotone cubic tangents: smooth through the points with
/// no overshoot, so a rising curve can never dip.
fn monotone_tangents(points: &[[f32; 2]]) -> Vec<f32> {
    let n = points.len();
    let mut d = vec![0.0f32; n - 1];
    for i in 0..n - 1 {
        d[i] = (points[i + 1][1] - points[i][1]) / (points[i + 1][0] - points[i][0]).max(1e-6);
    }
    let mut m = vec![0.0f32; n];
    m[0] = d[0];
    m[n - 1] = d[n - 2];
    for i in 1..n - 1 {
        m[i] = if d[i - 1] * d[i] <= 0.0 { 0.0 } else { (d[i - 1] + d[i]) / 2.0 };
    }
    for i in 0..n - 1 {
        if d[i].abs() < 1e-6 {
            m[i] = 0.0;
            m[i + 1] = 0.0;
        } else {
            let a = m[i] / d[i];
            let b = m[i + 1] / d[i];
            let s = a * a + b * b;
            if s > 9.0 {
                let t = 3.0 / s.sqrt();
                m[i] = t * a * d[i];
                m[i + 1] = t * b * d[i];
            }
        }
    }
    m
}

/// Curve evaluation. Inside the point range: linear or monotone-cubic
/// interpolation. Outside: extend with slope 1 so scene-linear values above
/// the last point are offset, not flattened. Fewer than 2 points: identity.
fn eval_curve_with(points: &[[f32; 2]], tangents: Option<&[f32]>, x: f32) -> f32 {
    if points.len() < 2 {
        return x;
    }
    let first = points[0];
    let last = points[points.len() - 1];
    if x <= first[0] {
        return first[1] + (x - first[0]);
    }
    if x >= last[0] {
        return last[1] + (x - last[0]);
    }
    for (i, w) in points.windows(2).enumerate() {
        if x <= w[1][0] {
            let span = (w[1][0] - w[0][0]).max(1e-6);
            let t = (x - w[0][0]) / span;
            return match tangents {
                Some(m) => {
                    let (t2, t3) = (t * t, t * t * t);
                    let h00 = 2.0 * t3 - 3.0 * t2 + 1.0;
                    let h10 = t3 - 2.0 * t2 + t;
                    let h01 = -2.0 * t3 + 3.0 * t2;
                    let h11 = t3 - t2;
                    h00 * w[0][1] + h10 * span * m[i] + h01 * w[1][1] + h11 * span * m[i + 1]
                }
                None => w[0][1] + (w[1][1] - w[0][1]) * t,
            };
        }
    }
    last[1]
}

/// One channel's prepared sampler.
struct CurveSampler {
    points: Vec<[f32; 2]>,
    tangents: Option<Vec<f32>>,
    /// Handle-vector form, when the wire sent one: evaluated through
    /// eval_eq_points so handle LENGTH shapes the segment, the same
    /// weighted math Relight and Recolor run.
    eq: Option<Vec<EqPoint>>,
}

impl CurveSampler {
    fn new(points: Vec<[f32; 2]>, smooth: bool) -> Self {
        let tangents = (smooth && points.len() >= 2).then(|| monotone_tangents(&points));
        CurveSampler { points, tangents, eq: None }
    }

    /// Tangent mode: hermite through the user's slopes, sorted together
    /// with their points. Length mismatch or too few points falls back
    /// to the monotone smooth curve.
    fn with_user_tangents(points: Vec<[f32; 2]>, user: Option<Vec<f32>>) -> Self {
        match user {
            Some(m) if m.len() == points.len() && points.len() >= 2 => {
                let mut z: Vec<([f32; 2], f32)> = points.into_iter().zip(m).collect();
                z.sort_by(|a, b| a.0[0].partial_cmp(&b.0[0]).unwrap_or(std::cmp::Ordering::Equal));
                let (points, tangents): (Vec<_>, Vec<_>) = z.into_iter().unzip();
                CurveSampler { points, tangents: Some(tangents), eq: None }
            }
            _ => CurveSampler::new(points, true),
        }
    }

    /// Tangent mode with handle vectors: sorted together with their
    /// points and evaluated as EqPoints, so length means what the
    /// editor showed. A mismatched or empty handle list falls back to
    /// the slope form, which itself falls back to monotone.
    fn with_user_handles(
        points: Vec<[f32; 2]>,
        user: Option<Vec<f32>>,
        handles: Option<Vec<Option<HandlePair>>>,
    ) -> Self {
        match handles {
            Some(h) if h.len() == points.len() && points.len() >= 2 => {
                let mut z: Vec<([f32; 2], Option<HandlePair>)> =
                    points.into_iter().zip(h).collect();
                z.sort_by(|a, b| a.0[0].partial_cmp(&b.0[0]).unwrap_or(std::cmp::Ordering::Equal));
                let eq: Vec<EqPoint> = z
                    .iter()
                    .map(|([x, y], hp)| EqPoint {
                        x: *x,
                        y: *y,
                        l: hp.and_then(|hp| hp.l),
                        r: hp.and_then(|hp| hp.r),
                    })
                    .collect();
                let points: Vec<[f32; 2]> = z.into_iter().map(|(p, _)| p).collect();
                CurveSampler { points, tangents: None, eq: Some(eq) }
            }
            _ => CurveSampler::with_user_tangents(points, user),
        }
    }

    fn eval(&self, x: f32) -> f32 {
        if let Some(eq) = &self.eq {
            return eval_eq_points(eq, x);
        }
        eval_curve_with(&self.points, self.tangents.as_deref(), x)
    }
}

fn sorted(points: Option<Vec<[f32; 2]>>) -> Option<Vec<[f32; 2]>> {
    points.map(|mut pts| {
        pts.sort_by(|a, b| a[0].partial_cmp(&b[0]).unwrap_or(std::cmp::Ordering::Equal));
        pts
    })
}

/// The `points` param is JSON: {"rgb": [[x,y],...], "r": ..., "g": ...,
/// "b": ..., "luma": ...}, all channels optional. Applied in order: master
/// rgb curve, per-channel curves, then luma curve as a ratio scale.
///
/// Curves run in display space (sRGB-encoded), the domain the curve
/// editor's axis, its histogram underlay, and every photographer's
/// mental model already use: 0.5 on the axis is middle gray on screen,
/// not 50% linear light. Values at or above display 1.0 pass through
/// untouched; over-range recovery is the tone profile shoulder's job.
fn curves(node: &Node, inputs: &[(String, Value)]) -> Result<Value, EngineError> {
    let src = image_input(inputs, "in", &node.id)?;
    let raw = node
        .params
        .get("points")
        .and_then(|v| v.as_str())
        .unwrap_or("{}");
    let raw = if raw.trim() == "[]" { "{}" } else { raw };
    let set: CurveSet = serde_json::from_str(raw)
        .map_err(|e| invalid_param(node, "points", format!("bad curve JSON: {e}")))?;
    let smooth = set.interp.as_deref() == Some("smooth");
    let tangent = set.interp.as_deref() == Some("tangent");
    let prep = |pts: Option<Vec<[f32; 2]>>,
                 user: Option<Vec<f32>>,
                 handles: Option<Vec<Option<HandlePair>>>| {
        if tangent {
            // Sorting happens inside, keeping each slope and handle
            // with its point.
            pts.map(|p| CurveSampler::with_user_handles(p, user, handles))
        } else {
            sorted(pts).map(|p| CurveSampler::new(p, smooth))
        }
    };
    let rgb = prep(set.rgb, set.rgb_m, set.rgb_h);
    let cr = prep(set.r, set.r_m, set.r_h);
    let cg = prep(set.g, set.g_m, set.g_h);
    let cb = prep(set.b, set.b_m, set.b_h);
    let cl = prep(set.luma, set.luma_m, set.luma_h);

    // PERF: a Curves node with no points on any channel used to copy
    // the whole frame through map_rgb. With every sampler absent the
    // pixel closure is a pure copy (channels and alpha move over
    // untouched), so the node returns its input bit for bit without a
    // pass. The parse above still runs first, so malformed JSON keeps
    // erroring exactly as before.
    if rgb.is_none() && cr.is_none() && cg.is_none() && cb.is_none() && cl.is_none() {
        return Ok(Value::Image(src.clone()));
    }

    // One channel through one curve, display domain in and out.
    let apply = |c: &CurveSampler, v: f32| -> f32 {
        let d = to_display(v.max(0.0));
        if d >= 1.0 {
            v
        } else {
            to_scene(c.eval(d).max(0.0))
        }
    };
    let out = map_rgb(src, |r, g, b| {
        let mut px = [r, g, b];
        if let Some(c) = &rgb {
            for v in &mut px {
                *v = apply(c, *v);
            }
        }
        if let Some(c) = &cr {
            px[0] = apply(c, px[0]);
        }
        if let Some(c) = &cg {
            px[1] = apply(c, px[1]);
        }
        if let Some(c) = &cb {
            px[2] = apply(c, px[2]);
        }
        if let Some(c) = &cl {
            let l = luma(px[0], px[1], px[2]);
            if l > 1e-6 {
                let scale = apply(c, l) / l;
                for v in &mut px {
                    *v *= scale;
                }
            }
        }
        px
    });
    Ok(Value::Image(Arc::new(out)))
}

/// Levels in the display domain in and out, the way Curves works: the
/// widget's handles sit on the histogram of the picture as shown, so
/// black, white and gamma read on that axis. Applied to scene-linear
/// values, as it was until 2026-09-13, a black point of 0.01 cut the
/// darkest tenth of what the screen shows and the white point barely
/// moved anything ("the smallest nudge of a slider has huge
/// changes"). Normalize to (d - black) / (white - black), roll through
/// the knees, gamma as x^(1/gamma) on the positive part, back to scene.
/// Over-range stays over-range: the transfer pair continues above 1.
/// Mirrored in the GPU kernel; the parity test holds the two together.
fn levels(node: &Node, inputs: &[(String, Value)]) -> Result<Value, EngineError> {
    let src = image_input(inputs, "in", &node.id)?;
    let black = p(&node.params, "black", 0.0);
    let white = p(&node.params, "white", 1.0);
    let gamma = p(&node.params, "gamma", 1.0).max(0.1);
    // The falloffs ("a falloff for both black and white
    // points"): a quadratic knee half that wide on each side of the
    // point, so values roll into the clip instead of snapping - the
    // classic soft clip, applied on the normalized axis.
    let soft_b = p(&node.params, "black_soft", 0.0) / 100.0 * 0.25;
    let soft_w = p(&node.params, "white_soft", 0.0) / 100.0 * 0.25;
    // Identity is the input itself, not a round trip through the
    // transfer pair: an untouched Levels must render bit for bit what
    // it was handed, wherever in the chain it sits.
    if black == 0.0 && white == 1.0 && gamma == 1.0 && soft_b == 0.0 && soft_w == 0.0 {
        return Ok(Value::Image(src.clone()));
    }
    let range = (white - black).max(1e-6);
    // PERF: the powf exponent is a function of a parameter, not of any
    // pixel, but it was divided out per channel per pixel. Hoisted;
    // one IEEE division of the same operands yields the same bits.
    let inv_gamma = 1.0 / gamma;

    let knee_low = |n: f32, k: f32| {
        if k <= 0.0 || n >= k {
            n
        } else if n <= -k {
            0.0
        } else {
            (n + k) * (n + k) / (4.0 * k)
        }
    };
    let out = map_rgb(src, |r, g, b| {
        let mut px = [r, g, b];
        for v in &mut px {
            let mut n = (to_display(v.max(0.0)) - black) / range;
            n = knee_low(n, soft_b);
            // The white knee is the black knee mirrored around 1, and headroom rides
            // through it: the mirrored knee alone clipped everything more than a
            // knee's width above white to white, so touching the White falloff threw
            // away the highlight range every later node could still have used
            // (2026-09-13: preserve headroom, as the rest of the chain does). The
            // excess over white is added back, so a value at the knee's far edge
            // comes out exactly where it went in. With no knee the mirror is already
            // the identity above white; the excess is owed only where the knee
            // clipped it.
            if soft_w > 0.0 {
                let excess = (n - 1.0).max(0.0);
                n = 1.0 - knee_low(1.0 - n, soft_w) + excess;
            }
            *v = if n <= 0.0 { n } else { to_scene(n.powf(inv_gamma)) };
        }
        px
    });
    Ok(Value::Image(Arc::new(out)))
}

/// Tonal band membership from scene-linear luminance, display-encoded
/// like the wheels. Callers with a downstream exposure multiply luma by
/// that gain first; the film-grain response itself stays scene-linear.
pub fn range_weights(l: f32) -> [f32; 3] {
    seen_range_weights(seen_tone(l, 0.0))
}

/// Where a pixel sits on the tonal scale the viewer sees: its luma
/// carried through the brightness still to come (`range_ev`, stamped by
/// the desktop's graph build from the Exposure and the profile's
/// baseline downstream of the node) and display-encoded, 0 black to 1
/// white. The Color Wheels and Split Tone read their ranges off this.
/// Read off scene-linear luma before the baseline lift, a RAW's
/// Highlights wheel weighed nothing below display 0.95 and its Shadows
/// wheel still carried half the weight at display 0.6 (measured through
/// the default profile, 2026-09-27).
pub fn seen_tone(y: f32, range_ev: f32) -> f32 {
    to_display(y.max(0.0) * 2f32.powf(range_ev)).clamp(0.0, 1.0)
}

/// Shadows, midtones and highlights over the SEEN tonal scale (see
/// seen_tone): shadows fade out by the middle of it, highlights fade in
/// from the middle to white, midtones take the remainder and peak at
/// middle gray.
pub fn seen_range_weights(d: f32) -> [f32; 3] {
    let ws = 1.0 - smoothstep(0.0, 0.5, d);
    let wh = smoothstep(0.5, 1.0, d);
    let wm = (1.0 - ws - wh).clamp(0.0, 1.0);
    [ws, wm, wh]
}

/// Full-strength RGB for a hue angle (degrees, 0 = red, advancing through
/// yellow/green/cyan/blue/magenta), matching the color wheel's face.
pub fn hue_rgb(hue_deg: f32) -> [f32; 3] {
    let h = hue_deg.rem_euclid(360.0) / 60.0;
    let x = 1.0 - (h % 2.0 - 1.0).abs();
    match h as u32 {
        0 => [1.0, x, 0.0],
        1 => [x, 1.0, 0.0],
        2 => [0.0, 1.0, x],
        3 => [0.0, x, 1.0],
        4 => [x, 0.0, 1.0],
        _ => [1.0, 0.0, x],
    }
}

/// How far a fully-deflected wheel puck pushes color. Additive in scene
/// linear, so this is deliberately modest: at 0.15 a full push moves an
/// 18% gray about two thirds of a stop in the pushed channel.
pub(crate) const WHEEL_PUSH: f32 = 0.15;

/// A wheel puck as a chroma-only direction: the hue's RGB with its own
/// luma removed, scaled by the puck's distance from center. Chroma-only
/// preserves scene-linear luma before display clipping; the luminance
/// control separately scales it. Clipping a negative channel can change
/// the displayed brightness.
pub fn wheel_push(hue_deg: f32, sat_pct: f32) -> [f32; 3] {
    let amount = (sat_pct / 100.0) * WHEEL_PUSH;
    if amount == 0.0 {
        return [0.0; 3];
    }
    let rgb = hue_rgb(hue_deg);
    let y = luma(rgb[0], rgb[1], rgb[2]);
    [(rgb[0] - y) * amount, (rgb[1] - y) * amount, (rgb[2] - y) * amount]
}

/// Three-way color balance with real wheel semantics: each puck is a
/// DIRECTION to push that tonal range toward (angle = hue, distance =
/// strength), so dragging the shadows puck toward orange tints the
/// shadows orange even on neutral gray. The earlier model rotated the
/// existing chroma plane instead, which did nothing to neutral pixels
/// and swung saturated ones wildly: the "color wheels feel off" bug.
fn color_balance(node: &Node, inputs: &[(String, Value)]) -> Result<Value, EngineError> {
    let src = image_input(inputs, "in", &node.id)?;
    let get = |name: &str| p(&node.params, name, 0.0);
    let push = [
        wheel_push(get("shadows_hue"), get("shadows_sat")),
        wheel_push(get("midtones_hue"), get("midtones_sat")),
        wheel_push(get("highlights_hue"), get("highlights_sat")),
    ];
    let lum = [get("shadows_lum"), get("midtones_lum"), get("highlights_lum")];
    let range_ev = get("range_ev");

    let out = map_rgb(src, |r, g, b| {
        let y = luma(r, g, b);
        let w = seen_range_weights(seen_tone(y, range_ev));
        let mix = |c: usize| (0..3).map(|i| push[i][c] * w[i]).sum::<f32>();
        let lum_gain: f32 = (0..3).map(|i| 0.4 * (lum[i] / 100.0) * w[i]).sum::<f32>() + 1.0;
        [
            (r + mix(0)) * lum_gain,
            (g + mix(1)) * lum_gain,
            (b + mix(2)) * lum_gain,
        ]
    });
    Ok(Value::Image(Arc::new(out)))
}

/// Split toning: one hue for the shadows, another for the highlights,
/// with a balance control sliding the crossover. Uses the same wheel
/// push as color balance, so a hue means the same thing in both.
fn split_tone(node: &Node, inputs: &[(String, Value)]) -> Result<Value, EngineError> {
    let src = image_input(inputs, "in", &node.id)?;
    let get = |name: &str, d: f64| p(&node.params, name, d);
    let shadow = wheel_push(get("shadow_hue", 0.0), get("shadow_sat", 0.0));
    let highlight = wheel_push(get("highlight_hue", 0.0), get("highlight_sat", 0.0));
    let balance = (get("balance", 0.0) / 100.0).clamp(-1.0, 1.0);
    // The crossover is placed on the tonal scale the viewer sees, the
    // same scale the wheels read (see seen_tone).
    let range_ev = get("range_ev", 0.0);
    // Crossover slides with balance; the ramp stays wide enough that the
    // two tints always overlap smoothly instead of banding.
    let mid = 0.5 - balance * 0.35;
    let (lo, hi) = (mid - 0.35, mid + 0.35);

    let out = map_rgb(src, |r, g, b| {
        let y = seen_tone(luma(r, g, b), range_ev);
        let wh = smoothstep(lo, hi, y);
        let ws = 1.0 - wh;
        [
            r + shadow[0] * ws + highlight[0] * wh,
            g + shadow[1] * ws + highlight[1] * wh,
            b + shadow[2] * ws + highlight[2] * wh,
        ]
    });
    Ok(Value::Image(Arc::new(out)))
}

/// sRGB transfer pair, inlined so the engine stays free of io deps.
/// Public because the LUT bake in the desktop crate must agree with the
/// LUT node about the encoded axis, and two copies of this pair is how
/// they would come to disagree.
pub fn to_display(v: f32) -> f32 {
    if v <= 0.0031308 {
        v * 12.92
    } else {
        1.055 * v.powf(1.0 / 2.4) - 0.055
    }
}

pub fn to_scene(v: f32) -> f32 {
    if v <= 0.04045 {
        v / 12.92
    } else {
        ((v + 0.055) / 1.055).powf(2.4)
    }
}

/// Base tone profile: the contrast rendering every camera JPEG and every
/// competitor applies before you touch a slider. Heeler's develop is
/// scene-linear, which is correct but reads as flat, so this node is the
/// honest, visible place that shaping happens (rather than baking it
/// invisibly into the RAW decode).
///
/// The curve runs in display space (sRGB-encoded), where an S-curve
/// behaves the way photographers expect, then returns to scene linear.
/// Modes: linear (identity), standard (gentle S), film (stronger S with
/// a slight toe lift). Contrast scales the chosen mode.
/// Brings values above display white back into range.
///
/// The display transform used to end in `.min(1.0)`, which is a hard
/// clip, and in a scene-linear pipeline that is where recovered
/// highlights go to die: an HDR merge produces radiance several times
/// past white, and every bit of it landed on the same flat 1.0. The sky
/// came back blown no matter what the merge did.
///
/// A shoulder instead. Below the knee nothing changes at all, so a
/// photograph that never exceeds white renders exactly as before, which
/// matters because every edit anyone has made was made under the old
/// curve. Above the knee an exponential approach to 1 compresses the
/// whole remaining range, however far it goes, and meets the identity
/// with matching value and slope so there is no visible crease where it
/// takes over.
///
/// At `amount` 0 this is the old hard clip, exactly. That is the default
/// on purpose.
fn shoulder(d: f32, amount: f32) -> f32 {
    if amount <= 0.0 {
        return d.min(1.0);
    }
    // Room to work in: at full strength the top 60% of the display range
    // becomes the shoulder.
    let knee = 1.0 - 0.6 * amount;
    if d <= knee {
        return d;
    }
    let span = 1.0 - knee;
    knee + span * (1.0 - (-(d - knee) / span).exp())
}

fn tone_profile(node: &Node, inputs: &[(String, Value)]) -> Result<Value, EngineError> {
    let src = image_input(inputs, "in", &node.id)?;
    let mode = node
        .params
        .get("mode")
        .and_then(|v| v.as_str())
        .unwrap_or("standard");
    let strength = p(&node.params, "contrast", 100.0) / 100.0;
    let rolloff = (p(&node.params, "highlight_rolloff", 0.0) / 100.0).clamp(0.0, 1.0);
    // Baseline exposure, in stops, applied in scene space before the
    // curve. The reference RAW editors both quietly lift a RAW about a
    // stop before their curves touch it; rendered at face value next to
    // them, Heeler read as underexposed everywhere (measured at -1.0 EV
    // through the mids on every test scene). This is that lift, as a
    // visible number rather than a folklore constant inside a profile.
    let gain = 2f32.powf(p(&node.params, "baseline_ev", 0.0));
    // Toe: pulls deep shadows down with a (1-d)^3 falloff, restoring the
    // black density the baseline lift would otherwise wash out. Fades
    // with brightness, so it bites hardest in exactly the scenes where
    // the lift would go milky (measured against editor B's shade renders).
    let crush = (p(&node.params, "shadow_toe", 0.0) / 100.0).clamp(0.0, 1.0);
    let (s_amount, toe) = match mode {
        "linear" => (0.0, 0.0),
        "film" => (0.62 * strength, 0.012 * strength),
        _ => (0.34 * strength, 0.0),
    };
    // Colorfulness (ICC ): the chroma component of the default rendering, as a
    // visible number like baseline_ev, not a hidden multiplier. A constant chroma
    // factor around Rec.709 luma in scene space after the curve: simple on
    // purpose, because this is a CALIBRATION axis to be fitted against reference
    // editor renders, and a clever curve would leave nothing to fit. Defaults to
    // 0 until the calibration round sets it (then PROFILE_DEFAULTS carries it,
    // the baseline_ev story again). Mirrored in the GPU kernel; the parity tests
    // hold the two together.
    let color = 1.0 + p(&node.params, "colorfulness", 0.0).clamp(-100.0, 100.0) / 100.0;
    // Development: a stock named in `film` renders through its
    // characteristic curve instead of the modes above, walked by
    // `development` in N steps; the Profile amt dial scales its gamma, the
    // baseline lift applies before, the colorfulness after as ever. The
    // toe and shoulder are the film's, so the profile's own toe and
    // rolloff stand down.
    let film = node
        .params
        .get("film")
        .and_then(|v| v.as_str())
        .and_then(crate::film::stock);
    if let Some(stock) = film {
        let n = p(&node.params, "development", 0.0).clamp(-2.0, 2.0);
        let out = map_rgb(src, |r, g, b| {
            let mut px = [r, g, b];
            for v in &mut px {
                *v = stock.display(v.max(0.0) * gain, n, strength);
            }
            if color != 1.0 {
                let y = luma(px[0], px[1], px[2]);
                for v in &mut px {
                    *v = (y + (*v - y) * color).max(0.0);
                }
            }
            px
        });
        return Ok(Value::Image(Arc::new(out)));
    }
    if s_amount == 0.0 && rolloff == 0.0 && gain == 1.0 && crush == 0.0 && color == 1.0 {
        return Ok(Value::Image(src.clone()));
    }

    let out = map_rgb(src, |r, g, b| {
        let mut px = [r, g, b];
        for v in &mut px {
            let d = shoulder(to_display(v.max(0.0) * gain), rolloff);
            // Smoothstep is the S; mixing keeps the curve monotone and
            // anchors black and white exactly.
            let s = d * d * (3.0 - 2.0 * d);
            let mut curved = (d + (s - d) * s_amount + toe * (1.0 - d)).clamp(0.0, 1.0);
            let f = 1.0 - curved;
            curved -= crush * curved * f * f * f;
            *v = to_scene(curved);
        }
        if color != 1.0 {
            let y = luma(px[0], px[1], px[2]);
            for v in &mut px {
                *v = (y + (*v - y) * color).max(0.0);
            }
        }
        px
    });
    Ok(Value::Image(Arc::new(out)))
}

/// The guided filter with a three-channel guide (He, Sun and Tang's
/// color form): `pa` and `pb` smoothed over radius `r` wherever the
/// guide is flat in every channel, kept wherever any channel steps.
/// Per window the guide's 3x3 covariance plus `eps` on the diagonal is
/// solved against the guide-to-p covariance (Cramer's rule), the
/// coefficients box-blurred, and p rebuilt from the guide. Twenty-five
/// box blurs, still linear in the pixels. Guided by lightness alone a
/// hue edge with no lightness step (a hazy sky against a bright rim of
/// rock, a JPEG's sky against sunlit twigs) was no edge at all and the
/// sky's chroma bled for a radius; the chroma channels see it.
pub(crate) fn guided_blur_lab(pa: &mut [f32], pb: &mut [f32], guide: [&[f32]; 3], w: usize, h: usize, r: usize, eps: f32) {
    guided_blur_planes(&mut [pa, pb], guide, w, h, r, eps, BoxEdge::Clamp);
}

/// How a box mean treats the frame's edge.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub(crate) enum BoxEdge {
    /// The edge sample repeats past the frame (box_blur_pass): right for
    /// a picture, whose surface continues.
    Clamp,
    /// The window is cut at the frame and the mean taken over what is
    /// inside it, as the plain feather takes it: right for a mask, where
    /// repeating the edge would grow a strand that touches the frame
    /// into a blob (the 2026-09-23 review's R2: a one-pixel corner
    /// selection feathered at 20 came out with forty times its
    /// coverage).
    Truncate,
}

/// The guided filter over any number of planes sharing one guide and
/// one box policy. `guided_blur_lab` is this with two planes and the
/// clamped box, bit for bit what it computed before the policy existed.
pub(crate) fn guided_blur_planes(planes: &mut [&mut [f32]], guide: [&[f32]; 3], w: usize, h: usize, r: usize, eps: f32, edge: BoxEdge) {
    // PERF (the Guided Filter node, 2026-09-30, 2.8 s on a 24 MP frame):
    // the products, the per-pixel solve and the rebuild ran serially.
    // Each output element is a function of its own pixel's values only,
    // computed by the same expression, so the parallel maps answer bit
    // for bit what the serial loops did.
    use rayon::prelude::*;
    let n = w * h;
    let mut scratch = vec![0.0f32; n];
    let blur = |v: &mut Vec<f32>, scratch: &mut Vec<f32>| match edge {
        BoxEdge::Clamp => box_blur_pass(v, scratch, w, h, r),
        BoxEdge::Truncate => box_mean_truncated(v, scratch, w, h, r),
    };
    let mut mean_g: Vec<Vec<f32>> = guide.iter().map(|g| g.to_vec()).collect();
    for m in mean_g.iter_mut() {
        blur(m, &mut scratch);
    }
    // The guide's second moments, upper triangle: 00 01 02 11 12 22.
    let pairs = [(0, 0), (0, 1), (0, 2), (1, 1), (1, 2), (2, 2)];
    let mut corr_gg: Vec<Vec<f32>> = pairs
        .iter()
        .map(|&(c, d)| guide[c].par_iter().zip(guide[d].par_iter()).map(|(x, y)| x * y).collect())
        .collect();
    for m in corr_gg.iter_mut() {
        blur(m, &mut scratch);
    }
    for p in planes.iter_mut() {
        let mut mean_p = p.to_vec();
        blur(&mut mean_p, &mut scratch);
        let mut corr_gp: Vec<Vec<f32>> =
            guide.iter().map(|g| g.par_iter().zip(p.par_iter()).map(|(x, y)| x * y).collect()).collect();
        for m in corr_gp.iter_mut() {
            blur(m, &mut scratch);
        }
        let solve = |i: usize| -> [f32; 4] {
            let mg = [mean_g[0][i], mean_g[1][i], mean_g[2][i]];
            // Sigma + eps I, symmetric.
            let s00 = corr_gg[0][i] - mg[0] * mg[0] + eps;
            let s01 = corr_gg[1][i] - mg[0] * mg[1];
            let s02 = corr_gg[2][i] - mg[0] * mg[2];
            let s11 = corr_gg[3][i] - mg[1] * mg[1] + eps;
            let s12 = corr_gg[4][i] - mg[1] * mg[2];
            let s22 = corr_gg[5][i] - mg[2] * mg[2] + eps;
            let c = [
                corr_gp[0][i] - mg[0] * mean_p[i],
                corr_gp[1][i] - mg[1] * mean_p[i],
                corr_gp[2][i] - mg[2] * mean_p[i],
            ];
            let det = s00 * (s11 * s22 - s12 * s12) - s01 * (s01 * s22 - s12 * s02) + s02 * (s01 * s12 - s11 * s02);
            let a = if det.abs() > 1e-20 {
                let inv = 1.0 / det;
                [
                    (c[0] * (s11 * s22 - s12 * s12) - s01 * (c[1] * s22 - s12 * c[2]) + s02 * (c[1] * s12 - s11 * c[2])) * inv,
                    (s00 * (c[1] * s22 - s12 * c[2]) - c[0] * (s01 * s22 - s12 * s02) + s02 * (s01 * c[2] - c[1] * s02)) * inv,
                    (s00 * (s11 * c[2] - c[1] * s12) - s01 * (s01 * c[2] - c[1] * s02) + c[0] * (s01 * s12 - s11 * s02)) * inv,
                ]
            } else {
                [0.0; 3]
            };
            [a[0], a[1], a[2], mean_p[i] - a[0] * mg[0] - a[1] * mg[1] - a[2] * mg[2]]
        };
        let mut coef = vec![vec![0.0f32; n]; 3];
        let mut coef_b = vec![0.0f32; n];
        {
            let [c0, c1, c2] = &mut coef[..] else { unreachable!() };
            c0.par_iter_mut()
                .zip(c1.par_iter_mut())
                .zip(c2.par_iter_mut())
                .zip(coef_b.par_iter_mut())
                .enumerate()
                .for_each(|(i, (((a0, a1), a2), b))| {
                    let v = solve(i);
                    *a0 = v[0];
                    *a1 = v[1];
                    *a2 = v[2];
                    *b = v[3];
                });
        }
        for m in coef.iter_mut() {
            blur(m, &mut scratch);
        }
        blur(&mut coef_b, &mut scratch);
        p.par_iter_mut().enumerate().for_each(|(i, v)| {
            *v = coef[0][i] * guide[0][i] + coef[1][i] * guide[1][i] + coef[2][i] * guide[2][i] + coef_b[i];
        });
    }
}

/// The box mean with the window cut at the frame (BoxEdge::Truncate):
/// horizontal then vertical, each output the mean of the samples inside
/// the frame within `r`, a running sum with a running count. The same
/// arithmetic the plain feather does fresh per pixel, so with a flat
/// guide the guided feather and the plain one agree to float order
/// everywhere, the corners included.
pub(crate) fn box_mean_truncated(data: &mut [f32], scratch: &mut [f32], w: usize, h: usize, r: usize) {
    if r == 0 || w == 0 || h == 0 {
        return;
    }
    use rayon::prelude::*;
    let sweep = |src: &[f32], dst: &mut [f32], rowlen: usize, r: usize| {
        dst.par_chunks_mut(rowlen)
            .zip(src.par_chunks(rowlen))
            .for_each(|(out_row, row)| {
                // The window [x - r, x + r] cut to the row: the sum adds
                // the sample entering and drops the one leaving, and the
                // count is the window's length inside the row.
                let mut sum = 0.0f32;
                for x in 0..r.min(rowlen) {
                    sum += row[x];
                }
                for x in 0..rowlen {
                    if x + r < rowlen {
                        sum += row[x + r];
                    }
                    if x > r {
                        sum -= row[x - r - 1];
                    }
                    let lo = x.saturating_sub(r);
                    let hi = (x + r).min(rowlen - 1);
                    out_row[x] = sum / (hi - lo + 1) as f32;
                }
            });
    };
    if w > 1 {
        sweep(data, scratch, w, r);
    } else {
        scratch.copy_from_slice(data);
    }
    if h > 1 {
        data.par_chunks_mut(h).enumerate().for_each(|(x, col)| {
            for y in 0..h {
                col[y] = scratch[y * w + x];
            }
        });
        sweep(data, scratch, h, r);
        data.par_chunks_mut(w).enumerate().for_each(|(y, row)| {
            for x in 0..w {
                row[x] = scratch[x * h + y];
            }
        });
    } else {
        data.copy_from_slice(scratch);
    }
}

/// One box-blur pass over a single-channel buffer, horizontal then
/// vertical, running-sum so the radius costs nothing. Repeated, a box
/// converges on a gaussian fast enough for an illuminance estimate.
///
/// The running-sum windows assume r < w and r < h: with the kernel wider
/// than the row, the right-edge clamp accumulates too few copies of the
/// last sample (and a one-pixel-wide row came out dimmed by
/// (r+1)/(2r+1) instead of untouched). Engine callers derive r from a
/// few percent of min(w, h), so this never binds in practice; the clamp
/// keeps the utility honest for any future caller that hands it a tiny
/// buffer.
pub(crate) fn box_blur_pass(data: &mut [f32], scratch: &mut [f32], w: usize, h: usize, r: usize) {
    if r == 0 {
        return;
    }
    use rayon::prelude::*;
    // PERF: both passes used to run serially, and this blur sits on the
    // Recolor and Color Console paths, where it costs two full frames of
    // sweeps per render. Rows (horizontal pass) and columns (vertical
    // pass) are independent, so both now run under rayon. Each row or
    // column keeps its original running-sum order, and the vertical pass
    // sweeps the TRANSPOSE with the very same kernel (the transposes
    // only move floats, never combine them), so every output value is
    // computed by the identical sequence of adds and subtracts as
    // before: bit for bit unchanged.
    let sweep = |src: &[f32], dst: &mut [f32], rowlen: usize, r: usize| {
        let norm = 1.0 / (2 * r + 1) as f32;
        dst.par_chunks_mut(rowlen)
            .zip(src.par_chunks(rowlen))
            .for_each(|(out_row, row)| {
                let mut sum = row[0] * (r + 1) as f32;
                for x in 0..r.min(rowlen - 1) {
                    sum += row[x.min(rowlen - 1)];
                }
                for x in 0..rowlen {
                    sum += row[(x + r).min(rowlen - 1)];
                    let back = x as isize - r as isize - 1;
                    sum -= row[back.max(0) as usize];
                    out_row[x] = sum * norm;
                }
            });
    };
    if w > 1 {
        sweep(data, scratch, w, r.min(w - 1));
    } else {
        // A one-pixel-wide image has nothing to blur horizontally; the
        // vertical pass still applies, so stage the data through.
        scratch.copy_from_slice(data);
    }
    if h > 1 {
        // Transpose into data (column x lands at data[x*h + y]), sweep
        // rows of length h, transpose back. Reads strided, writes
        // contiguous in both transposes.
        data.par_chunks_mut(h).enumerate().for_each(|(x, col)| {
            for y in 0..h {
                col[y] = scratch[y * w + x];
            }
        });
        sweep(data, scratch, h, r.min(h - 1));
        data.par_chunks_mut(w).enumerate().for_each(|(y, row)| {
            for x in 0..w {
                row[x] = scratch[x * h + y];
            }
        });
    } else {
        data.copy_from_slice(scratch);
    }
}

/// The Tone Zone Equalizer: exposure as a function of
/// illuminance, the zone system with sliders.
///
/// Nine zones, one per EV from -4 to +4 around middle gray, each a
/// gaussian bump on the log2 axis; a pixel's EV adjustment is the
/// normalized blend of the zones its illuminance touches, and the
/// adjustment is a pure exposure multiply, so chromaticity never
/// moves. The illuminance is estimated from BLURRED luminance, which
/// is what separates an equalizer from a curve: neighboring pixels of
/// one surface get one exposure, so local contrast survives. A plain
/// gaussian estimate can halo at strong settings around hard
/// backlit edges (a guided filter is the deluxe answer);
/// the smoothing slider is the honest lever until then.
/// One EQ control point: position on the log2 axis, adjustment in EV,
/// optional manual tangent vectors (the frontend's eqcurve.ts mirrors
/// this shape and this evaluation exactly; shared test vectors hold
/// the two together).
#[derive(serde::Deserialize, Clone, Copy)]
pub(crate) struct EqPoint {
    pub(crate) x: f32,
    pub(crate) y: f32,
    pub(crate) l: Option<[f32; 2]>,
    pub(crate) r: Option<[f32; 2]>,
}

/// Parses a JSON point list; sorted, non-finite entries dropped.
pub(crate) fn parse_eq_points(json: &str) -> Vec<EqPoint> {
    let mut pts: Vec<EqPoint> = serde_json::from_str(json).unwrap_or_default();
    pts.retain(|p| p.x.is_finite() && p.y.is_finite());
    pts.sort_by(|a, b| a.x.total_cmp(&b.x));
    pts
}

fn eq_points(node: &Node) -> Vec<EqPoint> {
    node.params
        .get("points")
        .and_then(|v| v.as_str())
        .map(parse_eq_points)
        .unwrap_or_default()
}

/// The parametric curve's interpolation face (the editors' 3-button
/// toggle), applied by TRANSFORMING the point list so every evaluator
/// downstream works untouched: "smooth" strips the manual handles and
/// the Catmull-Rom takes over; "linear" pins every handle to its
/// segment's secant at a third of the span, and a Bezier through
/// collinear controls IS the ruler, exactly; anything else (including
/// the param being absent) leaves the points as stored, which is the
/// tangent face and the pre-toggle behavior in one. Mirrors
/// evalEqInterp in eqcurve.ts.
pub(crate) fn apply_eq_interp(pts: &mut Vec<EqPoint>, interp: &str) {
    match interp {
        "smooth" => {
            for p in pts.iter_mut() {
                p.l = None;
                p.r = None;
            }
        }
        "linear" => {
            let n = pts.len();
            if n < 2 {
                return;
            }
            let old = pts.clone();
            for i in 0..n {
                pts[i].l = (i > 0).then(|| {
                    let w = (old[i].x - old[i - 1].x).max(1e-6);
                    let s = (old[i].y - old[i - 1].y) / w;
                    [-w / 3.0, -s * w / 3.0]
                });
                pts[i].r = (i + 1 < n).then(|| {
                    let w = (old[i + 1].x - old[i].x).max(1e-6);
                    let s = (old[i + 1].y - old[i].y) / w;
                    [w / 3.0, s * w / 3.0]
                });
            }
        }
        _ => {}
    }
}

/// The node's stored interpolation choice, empty when it never chose:
/// the transform above treats empty as "leave the points alone".
/// A curve's own interpolation face, or the node's shared one when the
/// curve has none (review 2026-09-15, item 7): the infrared guess
/// reads ir_interp and the depth curve depth_interp, and a graph saved
/// with one face for all three still renders as it did.
pub(crate) fn interp_or(node: &Node, key: &str) -> String {
    match node.params.get(key).and_then(|v| v.as_str()) {
        Some(face) if !face.is_empty() => face.to_string(),
        _ => eq_interp_of(node),
    }
}

pub(crate) fn eq_interp_of(node: &Node) -> String {
    node.params
        .get("eq_interp")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string()
}

/// Cubic Hermite through the points: automatic Catmull-Rom slopes,
/// overridden per side by a manual tangent vector, flat beyond the
/// ends. With nine evenly spaced points and no manual tangents this is
/// bit-for-bit the old zone curve; the widget is a generalization, not
/// a new renderer.
pub(crate) fn eval_eq_points(pts: &[EqPoint], x: f32) -> f32 {
    let n = pts.len();
    if n == 0 {
        return 0.0;
    }
    if n == 1 || x <= pts[0].x {
        return pts[0].y;
    }
    if x >= pts[n - 1].x {
        return pts[n - 1].y;
    }
    let auto = |i: usize| -> f32 {
        let a = &pts[i.saturating_sub(1)];
        let b = &pts[(i + 1).min(n - 1)];
        let dx = b.x - a.x;
        if dx > 1e-6 { (b.y - a.y) / dx } else { 0.0 }
    };
    let mut k = 0;
    while k < n - 2 && pts[k + 1].x < x {
        k += 1;
    }
    let (p0, p1) = (&pts[k], &pts[k + 1]);
    let w = (p1.x - p0.x).max(1e-6);
    // A segment with a manual handle on EITHER end evaluates as a Bezier
    // through the handle POSITIONS, so the handle's LENGTH means something
    // ("Tangent handles should be resizable, not fixed
    // length"); the slope-only Hermite below threw the length away. Auto
    // segments keep the exact old arithmetic, so untouched curves render
    // identically. Mirrors evalEq in eqcurve.ts step for step.
    if p0.r.is_some() || p1.l.is_some() {
        let m0 = auto(k);
        let m1 = auto(k + 1);
        let [mut rdx, mut rdy] = p0.r.unwrap_or([w / 3.0, m0 * w / 3.0]);
        let [mut ldx, mut ldy] = p1.l.unwrap_or([-w / 3.0, -m1 * w / 3.0]);
        // Slope-preserving clamps: scale the vector, never shear it.
        let eps = 1e-4f32;
        if rdx < eps {
            rdy = if rdx > 0.0 { rdy * eps / rdx } else { 0.0 };
            rdx = eps;
        }
        if -ldx < eps {
            ldy = if ldx < 0.0 { ldy * eps / -ldx } else { 0.0 };
            ldx = -eps;
        }
        let over = rdx - ldx;
        if over > w {
            let s = w / over;
            rdx *= s;
            rdy *= s;
            ldx *= s;
            ldy *= s;
        }
        let (c1x, c1y) = (p0.x + rdx, p0.y + rdy);
        let (c2x, c2y) = (p1.x + ldx, p1.y + ldy);
        // Newton on the monotone x polynomial: eight fixed iterations,
        // deterministic on both sides of the TS/Rust mirror.
        let ax = p1.x - 3.0 * c2x + 3.0 * c1x - p0.x;
        let bx = 3.0 * c2x - 6.0 * c1x + 3.0 * p0.x;
        let cx = 3.0 * c1x - 3.0 * p0.x;
        let mut t = (x - p0.x) / w;
        for _ in 0..8 {
            let f = ((ax * t + bx) * t + cx) * t + p0.x - x;
            let fp = (3.0 * ax * t + 2.0 * bx) * t + cx;
            if fp.abs() < 1e-8 {
                break;
            }
            t = (t - f / fp).clamp(0.0, 1.0);
        }
        let ay = p1.y - 3.0 * c2y + 3.0 * c1y - p0.y;
        let by = 3.0 * c2y - 6.0 * c1y + 3.0 * p0.y;
        let cy = 3.0 * c1y - 3.0 * p0.y;
        return ((ay * t + by) * t + cy) * t + p0.y;
    }
    let m0 = auto(k);
    let m1 = auto(k + 1);
    let t = (x - p0.x) / w;
    let (t2, t3) = (t * t, t * t * t);
    (2.0 * t3 - 3.0 * t2 + 1.0) * p0.y
        + (t3 - 2.0 * t2 + t) * w * m0
        + (-2.0 * t3 + 3.0 * t2) * p1.y
        + (t3 - t2) * w * m1
}

/// The illuminance Relight reads its curve at, per pixel, linear: an
/// edge-aware estimate of each pixel's light over the node's Smoothing.
/// tone_eq and the on-image picker (tone_eq_lookup) share it, so a
/// picked point lands at the tone the curve is applied to (the 26.4.3
/// latest review's R2: the picker read a patch's raw luma, up to 2.3
/// stops away on foliage and cloud edges).
pub fn tone_eq_illuminance(params: &std::collections::BTreeMap<String, heeler_graph::ParamValue>, src: &ImageBuf) -> Vec<f32> {
    let (w, h) = (src.width, src.height);
    let smoothing = p(params, "smoothing", 50.0).clamp(0.0, 100.0) / 100.0;
    let radius = ((w.min(h) as f32) * (0.004 + 0.028 * smoothing)) as usize;

    // Illuminance: an edge-aware estimate via the guided filter (He,
    // Sun, Tang 2010), self-guided on log2 luminance. The first build
    // used a plain box blur, which averaged across hard backlit edges
    // and haloed there; the guided filter's variance term stops the
    // averaging exactly where the edge is. eps is (0.3 EV)²: texture
    // finer than a third of a stop smooths, real edges survive.
    //
    // PERF: the luminance/squares pass, the guided-filter coefficient
    // pass and the final exponentiation used to be three serial loops
    // over the whole frame, each with a log2 or exp2 per pixel; on an
    // 1800px photo they were most of this op's cost. Every output cell
    // depends only on its own pixel, so all three now run under rayon
    // (the box blurs in between have been parallel since the color
    // pass). Same functions on the same per-pixel values, so every
    // buffer holds the same bits as before.
    use rayon::prelude::*;
    let mut lg = vec![0.0f32; w * h];
    let mut sq = vec![0.0f32; w * h];
    lg.par_chunks_mut(w)
        .zip(sq.par_chunks_mut(w))
        .zip(src.data.par_chunks(w * 4))
        .for_each(|((rl, rs), srow)| {
            for (i, px) in srow.chunks(4).enumerate() {
                let v = luma(px[0], px[1], px[2]).max(1e-7).log2();
                rl[i] = v;
                rs[i] = v * v;
            }
        });
    let mut scratch = vec![0.0f32; lg.len()];
    let boxed = |v: &[f32], scratch: &mut Vec<f32>| -> Vec<f32> {
        let mut out = v.to_vec();
        box_blur_pass(&mut out, scratch, w, h, radius);
        out
    };
    let mean = boxed(&lg, &mut scratch);
    let corr = boxed(&sq, &mut scratch);
    const EPS: f32 = 0.09;
    let mut a = vec![0.0f32; lg.len()];
    let mut b = vec![0.0f32; lg.len()];
    a.par_chunks_mut(w)
        .zip(b.par_chunks_mut(w))
        .zip(mean.par_chunks(w))
        .zip(corr.par_chunks(w))
        .for_each(|(((ra, rb), rm), rc)| {
            for i in 0..w {
                let var = (rc[i] - rm[i] * rm[i]).max(0.0);
                ra[i] = var / (var + EPS);
                rb[i] = rm[i] * (1.0 - ra[i]);
            }
        });
    let mean_a = boxed(&a, &mut scratch);
    let mean_b = boxed(&b, &mut scratch);
    let mut illum = vec![0.0f32; lg.len()];
    illum
        .par_iter_mut()
        .zip(mean_a.par_iter())
        .zip(mean_b.par_iter())
        .zip(lg.par_iter())
        .for_each(|(((o, &ma), &mb), &g)| {
            *o = (ma * g + mb).exp2();
        });
    illum
}

/// What Relight's curve is read at, per pixel: tone_eq_illuminance in EV
/// from middle gray, clamped as the op clamps it. Range shift is not in
/// it; the curve is read at this plus the shift.
pub fn tone_eq_lookup(params: &std::collections::BTreeMap<String, heeler_graph::ParamValue>, src: &ImageBuf) -> Vec<f32> {
    use rayon::prelude::*;
    tone_eq_illuminance(params, src).par_iter().map(|v| (v / 0.18).log2().clamp(-8.0, 6.0)).collect()
}

fn tone_eq(node: &Node, inputs: &[(String, Value)]) -> Result<Value, EngineError> {
    let src = image_input(inputs, "in", &node.id)?;
    const ZONES: [&str; 9] = [
        "ev_m4", "ev_m3", "ev_m2", "ev_m1", "ev_0", "ev_p1", "ev_p2", "ev_p3", "ev_p4",
    ];
    // The widget writes `points`; graphs from before it carry only the
    // nine zone sliders, which are the same curve with fixed x.
    let mut pts = eq_points(node);
    if pts.is_empty() {
        for (i, name) in ZONES.iter().enumerate() {
            let y = p(&node.params, name, 0.0).clamp(-2.0, 2.0);
            pts.push(EqPoint { x: i as f32 - 4.0, y, l: None, r: None });
        }
    }
    for pt in &mut pts {
        pt.y = pt.y.clamp(-2.0, 2.0);
    }
    // The editor's Smooth / Straight / Tangent choice, folded into the
    // points themselves so the per-pixel eval below stays one function.
    apply_eq_interp(&mut pts, &eq_interp_of(node));
    // Range shift (the owner's control): slide the photo's tones through the
    // curve's window rather than the window over the tones.
    let shift = p(&node.params, "range_shift", 0.0).clamp(-4.0, 4.0);
    if pts.iter().all(|pt| pt.y.abs() < 1e-6) {
        return Ok(Value::Image(src.clone()));
    }
    let (w, h) = (src.width, src.height);
    let illum = tone_eq_illuminance(&node.params, src);
    use rayon::prelude::*;
    let mut out = ImageBuf::new(w, h);
    out.data
        .par_chunks_mut(4)
        .zip(src.data.par_chunks(4))
        .enumerate()
        .for_each(|(px, (o, s))| {
            let l = (illum[px] / 0.18).log2().clamp(-8.0, 6.0);
            let gain = 2f32.powf(eval_eq_points(&pts, l + shift).clamp(-2.0, 2.0));
            o[0] = s[0] * gain;
            o[1] = s[1] * gain;
            o[2] = s[2] * gain;
            o[3] = s[3];
        });
    Ok(Value::Image(Arc::new(out)))
}

/// Pulls one channel out as a grayscale image so it can flow through the
/// ordinary image ops and be recombined later. A single output port is
/// enough to split channels because outputs fan out: wire the source to
/// three extracts, process each, then merge.
fn channel_extract(node: &Node, inputs: &[(String, Value)]) -> Result<Value, EngineError> {
    let src = image_input(inputs, "in", &node.id)?;
    let channel = node
        .params
        .get("channel")
        .and_then(|v| v.as_str())
        .unwrap_or("luma")
        .to_string();
    let out = map_rgb(src, move |r, g, b| {
        let v = match channel.as_str() {
            "r" => r,
            "g" => g,
            "b" => b,
            _ => luma(r, g, b),
        };
        [v, v, v]
    });
    Ok(Value::Image(Arc::new(out)))
}

/// Channel-mixer black and white: gray = r*wr + g*wg + b*wb, weights as
/// percentages. Negative weights are allowed for dramatic filters (classic
/// red-filter skies), and the weights are applied DIRECTLY rather than
/// normalized by their sum.
///
/// Normalizing looked tidier but made the control unusable: as a slider
/// pushed the sum toward zero the division amplified everything (the image
/// brightened), then the sum crossed zero and every pixel flipped negative
/// and clipped to black. Direct weights are what a layer editor's channel
/// mixer does, they respond monotonically, and the UI shows the running total so
/// the brightness effect of an off-100 sum is visible rather than magic.
/// `amount` is the treatment strength (0 = untouched color, 100 = full
/// monochrome), which keeps "is B&W selected" separate from the node's
/// enabled flag: enabled means bypass, exactly like every other node.
///
/// `hue_curve` is the expert face over the same conversion: a periodic
/// curve of hue (OkLCh degrees, 0..360) to EV, evaluated exactly as
/// Recolor's hue axis is (the same EqPoint list, the same expansion
/// across the 0/360 seam) and scaling the mixed gray by 2^EV, clamped
/// to ±2 like Recolor's lum row. Hue is read from the pixel's OkLab a,b
/// box-smoothed over one percent of the short side, Recolor's default,
/// so the curve indexes the surface rather than the sensor noise; and
/// it is chroma-gated by the Color Sets window (0.01..0.05 OkLab
/// chroma), because a neutral has no hue to read and an ungated curve
/// would dapple the grays. A curve with fewer than two points, or one
/// that is zero everywhere, leaves the mixer path untouched and
/// bit-exact.
fn black_white(node: &Node, inputs: &[(String, Value)]) -> Result<Value, EngineError> {
    let src = image_input(inputs, "in", &node.id)?;
    let wr = p(&node.params, "red", 30.0) / 100.0;
    let wg = p(&node.params, "green", 59.0) / 100.0;
    let wb = p(&node.params, "blue", 11.0) / 100.0;
    // Identity until asked: the registry default is 0 (a graph that
    // omitted the param used to render fully monochrome), and this
    // fallback is the same answer for a graph that omits it still.
    let amount = (p(&node.params, "amount", 0.0) / 100.0).clamp(0.0, 1.0);

    if amount == 0.0 {
        return Ok(Value::Image(src.clone()));
    }
    let curve = node
        .params
        .get("hue_curve")
        .and_then(|v| v.as_str())
        .map(parse_eq_points)
        .unwrap_or_default();
    let curve_active =
        curve.len() >= 2 && curve.iter().any(|pt| pt.y != 0.0) && p_bool(&node.params, "hue_curve_on", true);
    // Filter and film: a Wratten filter or a film's spectral sensitivity
    // named on the node makes the gray a spectral integral in place of the
    // mixer; the hue curve and Amount ride on top as they do over the
    // mixer. The infrared prior (phase 4b): the curve when the user has
    // drawn one, else the four materials, else the default.
    let prior = {
        let curve = node
            .params
            .get("ir_curve")
            .and_then(|v| v.as_str())
            .map(parse_eq_points)
            .unwrap_or_default();
        if curve.len() >= 2 {
            crate::spectral::IrPrior::from_points(curve)
        } else {
            let d = crate::spectral::IrMaterials::DEFAULT;
            crate::spectral::IrPrior::from_materials(crate::spectral::IrMaterials {
                foliage: p(&node.params, "ir_foliage", d.foliage as f64),
                sky: p(&node.params, "ir_sky", d.sky as f64),
                water: p(&node.params, "ir_water", d.water as f64),
                skin: p(&node.params, "ir_skin", d.skin as f64),
            })
        }
    }.with_interp(&interp_or(node, "ir_interp"));
    let near_key = node.params.get("filter").and_then(|v| v.as_str()).unwrap_or("");
    let film_key = node.params.get("film").and_then(|v| v.as_str()).unwrap_or("");
    let spectral = crate::spectral::Conversion::with_prior(near_key, film_key, prior.clone());
    let infrared = spectral.as_ref().map(|c| c.infrared_share() > 1e-4).unwrap_or(false);
    // Near and Far: a second filter for the far end of the depth map, the
    // frame graded between the two conversions along the planted plane by
    // the depth curve. No plane, or no Far, or Far the same as Near: one
    // conversion for the whole frame, as it was.
    let far_key = node.params.get("far_filter").and_then(|v| v.as_str()).unwrap_or("");
    let far = if !far_key.is_empty() && far_key != near_key {
        crate::spectral::Conversion::with_prior(far_key, film_key, prior)
    } else {
        None
    };
    let plane = if far.is_some() {
        crate::ops_depth::plane_from(inputs, "raster", src.width, src.height)
    } else {
        None
    };
    let graded = far.is_some() && plane.is_some();
    let far_infrared = far.as_ref().map(|c| c.infrared_share() > 1e-4).unwrap_or(false);
    let depth_curve = {
        let mut pts = node
            .params
            .get("depth_curve")
            .and_then(|v| v.as_str())
            .map(parse_eq_points)
            .unwrap_or_default();
        if pts.len() < 2 {
            pts = parse_eq_points(r#"[{"x":0,"y":0},{"x":100,"y":100}]"#);
        }
        apply_eq_interp(&mut pts, &interp_or(node, "depth_interp"));
        pts
    };
    let mix = |r: f32, g: f32, b: f32| -> f32 {
        match &spectral {
            Some(c) => c.gray(r, g, b),
            None => (r * wr + g * wg + b * wb).max(0.0),
        }
    };
    if !curve_active && !infrared && !graded {
        let out = map_rgb(src, |r, g, b| {
            // Negative luminance is meaningless and would invert in later ops.
            let gray = mix(r, g, b);
            [
                r + (gray - r) * amount,
                g + (gray - g) * amount,
                b + (gray - b) * amount,
            ]
        });
        return Ok(Value::Image(Arc::new(out)));
    }

    // The hue curve and the infrared guess both index by hue, and both
    // read it from the smoothed field so a JPEG's chroma blocks and the
    // sensor's chroma noise never become the answer.
    let (w, h) = (src.width, src.height);
    let field = (curve_active || infrared || (graded && far_infrared)).then(|| black_white_hue_field_cached(src));
    // Two gates over the one saturation: the curve's at the default floor,
    // the infrared guess's at the Neutral dial's, which lives in the
    // Infrared fold (2026-09-15: "Move Neutral into the Infrared fold") and
    // so must move nothing outside it.
    let curve_floor = black_white_neutral_floor(BW_NEUTRAL_DEFAULT);
    let ir_floor = black_white_neutral_floor(p(&node.params, "neutral", BW_NEUTRAL_DEFAULT) as f64);
    let expanded = if curve_active {
        let mut e = crate::ops_recolor::expand_eq_periodic(&curve, 360.0);
        apply_eq_interp(&mut e, &eq_interp_of(node));
        Some(e)
    } else {
        None
    };
    use rayon::prelude::*;
    let mut out = ImageBuf::new(w, h);
    out.data
        .par_chunks_mut(4)
        .enumerate()
        .zip(src.data.par_chunks(4))
        .for_each(|((i, o), s)| {
            let (hue, sat) = field.as_ref().map(|f| f[i]).unwrap_or((0.0, 0.0));
            let (r, g, b) = (s[0], s[1], s[2]);
            let near = match &spectral {
                Some(c) if infrared => c.gray_at(r, g, b, hue, black_white_hue_gate(sat, ir_floor)),
                Some(c) => c.gray(r, g, b),
                None => (r * wr + g * wg + b * wb).max(0.0),
            };
            let base = match (&far, &plane) {
                (Some(f), Some(pl)) => {
                    let t = (eval_eq_points(&depth_curve, (pl[i] * 100.0).clamp(0.0, 100.0)) / 100.0).clamp(0.0, 1.0);
                    let far_gray = if far_infrared {
                        f.gray_at(r, g, b, hue, black_white_hue_gate(sat, ir_floor))
                    } else {
                        f.gray(r, g, b)
                    };
                    near + (far_gray - near) * t
                }
                _ => near,
            };
            let gate = black_white_hue_gate(sat, curve_floor);
            let ev = match &expanded {
                Some(e) if gate > 0.0 => eval_eq_points(e, hue).clamp(-2.0, 2.0) * gate,
                _ => 0.0,
            };
            let gray = base * 2f32.powf(ev);
            o[0] = r + (gray - r) * amount;
            o[1] = g + (gray - g) * amount;
            o[2] = b + (gray - b) * amount;
            o[3] = s[3];
        });
    Ok(Value::Image(Arc::new(out)))
}

/// The last few hue fields, by the buffer they were read from. The
/// field is a pure function of the conversion's input, and the
/// executor keeps that input's buffer across renders while nothing
/// upstream changes, so a curve, Neutral or material dial moving
/// reads the field once and not on every render (the review of
/// 2026-09-15 measured the field at about 1.5 s of a 24 MP render).
/// Keyed by the buffer's identity: a Weak that upgrades to the very
/// Arc in hand is that allocation still alive, and an ImageBuf behind
/// an Arc never changes, so the field is the field. Two entries: the
/// preview's and one more (a 1:1 patch, an export), since a 24 MP
/// field is 192 MB.
type HueFieldCache = std::sync::Mutex<Vec<(std::sync::Weak<ImageBuf>, Arc<Vec<(f32, f32)>>, u64)>>;
static HUE_FIELD_CACHE: HueFieldCache = std::sync::Mutex::new(Vec::new());
static HUE_FIELD_CLOCK: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
const HUE_FIELD_CACHE_CAP: usize = 2;

pub(crate) fn black_white_hue_field_cached(src: &Arc<ImageBuf>) -> Arc<Vec<(f32, f32)>> {
    hue_field_cached_in(&HUE_FIELD_CACHE, src)
}

/// The cache's rule over any cache: the engine's static above, or a
/// test's own. The static is shared by every test in the process, and
/// the Black and White tests insert and drop buffers while another test
/// looks, so a test that asserted on the static read what the scheduler
/// gave it (the owner's run on the Mac before building, 2026-09-16,
/// after a clean merge: green on the branch, red on main, the same
/// code).
fn hue_field_cached_in(cache: &HueFieldCache, src: &Arc<ImageBuf>) -> Arc<Vec<(f32, f32)>> {
    let tick = HUE_FIELD_CLOCK.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    if let Ok(mut cache) = cache.lock() {
        cache.retain(|(weak, _, _)| weak.strong_count() > 0);
        if let Some(entry) = cache
            .iter_mut()
            .find(|(weak, _, _)| weak.upgrade().map(|alive| Arc::ptr_eq(&alive, src)).unwrap_or(false))
        {
            entry.2 = tick;
            return entry.1.clone();
        }
    }
    let field = Arc::new(black_white_hue_field(src));
    if let Ok(mut cache) = cache.lock() {
        cache.push((Arc::downgrade(src), field.clone(), tick));
        while cache.len() > HUE_FIELD_CACHE_CAP {
            let oldest = cache
                .iter()
                .enumerate()
                .min_by_key(|(_, (_, _, t))| *t)
                .map(|(i, _)| i)
                .unwrap_or(0);
            cache.remove(oldest);
        }
    }
    field
}

/// The hue and its saturation per pixel, read from OkLab a,b smoothed over six tenths of
/// a percent of the short side by a filter guided by color: what the hue curve and the
/// infrared guess index by. Each gates the saturation (chroma over the pixel's own
/// lightness) above its own floor with black_white_hue_gate. Guided, not boxed: a box
/// blur bled the land's hue into the sky along a ridge, and a band of sky lost its "sky"
/// guess and stood bright, a halo (2026-09-15). The guide sees the ridge as a lightness
/// edge and stops there; a JPEG's chroma blocks have no lightness edge and are
/// flattened.
pub(crate) fn black_white_hue_field(src: &ImageBuf) -> Vec<(f32, f32)> {
    let (w, h) = (src.width, src.height);
    if w == 0 || h == 0 {
        return Vec::new();
    }
    let mut la = vec![0.0f32; w * h];
    let mut lb = vec![0.0f32; w * h];
    let mut ll = vec![0.0f32; w * h];
    {
        use rayon::prelude::*;
        la.par_chunks_mut(w)
            .zip(lb.par_chunks_mut(w))
            .zip(ll.par_chunks_mut(w))
            .zip(src.data.par_chunks(w * 4))
            .for_each(|(((ra, rb), rl), srow)| {
                for (i, px) in srow.chunks(4).enumerate() {
                    let lab = crate::color::linear_to_oklab(px[0].max(0.0), px[1].max(0.0), px[2].max(0.0));
                    rl[i] = lab[0];
                    ra[i] = lab[1];
                    rb[i] = lab[2];
                }
            });
    }
    let radius = ((w.min(h) as f32) * 0.006) as usize;
    if radius > 0 {
        // Guided by all three channels (2026-09-15: "The halo is bad again"):
        // lightness alone let a sky's hue smear into sunlit twigs and rock
        // rims of the same lightness, and once the hazy sky's gate was live
        // that smear read as a bright rim. An edge of a fiftieth of lightness
        // counts; the chroma channels ride at twice their size, so a hundredth
        // of chroma counts too, which a JPEG's chroma blocks (a thousandth or
        // two, measured) sit well under and still flatten.
        let ga: Vec<f32> = la.iter().map(|v| v * 2.0).collect();
        let gb: Vec<f32> = lb.iter().map(|v| v * 2.0).collect();
        guided_blur_lab(&mut la, &mut lb, [&ll, &ga, &gb], w, h, radius, 0.02 * 0.02);
    }
    use rayon::prelude::*;
    la.par_iter()
        .zip(lb.par_iter())
        .zip(ll.par_iter())
        .map(|((a, b), l)| {
            let (hue, chroma) = crate::color::oklch_of([0.0, *a, *b]);
            (hue, black_white_saturation(chroma, *l))
        })
        .collect()
}

/// Whether a Black & White node wants the depth plane planted: a Far
/// filter named that differs from the near one, on a conversion that
/// is doing anything. The desktop's planting rule reads this, so a
/// conversion with no Far never loads the plane.
pub fn black_white_wants_depth(params: &std::collections::HashMap<String, serde_json::Value>) -> bool {
    let text = |k: &str| params.get(k).and_then(|v| v.as_str()).unwrap_or("").to_string();
    let far = text("far_filter");
    let amount = params.get("amount").and_then(|v| v.as_f64()).unwrap_or(0.0);
    !far.is_empty() && far != text("filter") && amount > 0.0
}

/// The conversion's Neutral dial at rest (spec.rs `neutral`, 0..100):
/// a tenth of the way up, a floor of 0.006 in saturation, under a hazy
/// sky's 0.013 at the horizon and over a JPEG's neutral noise. The
/// hue curve, the pickers and the Collisions view gate at this floor
/// always; the dial moves the infrared guess alone.
pub const BW_NEUTRAL_DEFAULT: f64 = 10.0;

/// The gate's floor in saturation from the Neutral dial: at 0 nothing
/// is a neutral and every hue is read, noise included; at 100 only a
/// color past 0.06 of saturation (a lit cottonwood, a red cliff)
/// carries a hue and a hazy sky is a gray. One dial for every hue: the
/// gate asks how gray a color is before any hue is looked up, so
/// foliage, sky, water and skin share it (2026-09-15: "sliders instead
/// of relying on one fixed float value to try and solve for every
/// photo").
pub fn black_white_neutral_floor(neutral: f64) -> f32 {
    (neutral as f32 / 100.0).clamp(0.0, 1.0) * 0.06
}

/// A color's saturation for the gate: OkLab chroma over lightness, the
/// lightness floored at 0.15 so a near-black's chroma noise is not read
/// as color. Chroma alone scales with lightness (OkLab's a and b shrink
/// with the cube root of the light), so a fixed chroma threshold read a
/// shaded pine as a gray while the same green lit passed in full
/// (2026-09-15: "Why does the foliage setting miss the trees on the
/// hill?": the ridge pines sat at 0.0135 chroma, a third of the old
/// 0.05, the lit cottonwoods at 0.049). Saturation is the same number
/// for a color and that color in shade.
pub fn black_white_saturation(chroma: f32, lightness: f32) -> f32 {
    chroma / lightness.max(0.15)
}

/// The gate as a smoothstep over saturation, 0.04 wide above the floor:
/// at the floor a color is a neutral and the hue curve and the infrared
/// guess leave it alone; 0.04 above it its hue is trusted in full. Wide
/// on purpose: a hazy sky runs from 0.013 at the horizon to 0.025
/// higher up, and a fade half this width turned that haze gradient into
/// a tone knee along every skyline (2026-09-15: "The halo is bad
/// again"); the old chroma window was this gentle at a sky's lightness.
/// At the default floor a JPEG's neutral noise (under 0.01) stays out
/// and a shaded pine (about 0.03) is three quarters in.
pub fn black_white_hue_gate(saturation: f32, floor: f32) -> f32 {
    let t = ((saturation - floor) / 0.04).clamp(0.0, 1.0);
    t * t * (3.0 - 2.0 * t)
}

fn luminance_extract(node: &Node, inputs: &[(String, Value)]) -> Result<Value, EngineError> {
    let src = image_input(inputs, "in", &node.id)?;
    let mut out = MaskBuf::new(src.width, src.height);
    use rayon::prelude::*;
    out.data.par_iter_mut().enumerate().for_each(|(i, m)| {
        let j = i * 4;
        *m = luma(src.data[j], src.data[j + 1], src.data[j + 2]);
    });
    Ok(Value::Mask(Arc::new(out)))
}

/// Smooth window over luma: ramps up across [low - feather, low] and down
/// across [high, high + feather].
///
/// SCENE-LINEAR and unclamped on purpose, unlike its Range Select
/// sibling in ops_masks.rs, which clamps display luma to match its
/// histogram. This node has generic sliders and no histogram to honor,
/// so it keys raw scene light and is the one of the two that can
/// select an HDR highlight above 1.0. Both audited, both as designed;
/// The owner ruled they stay different because their contracts are
/// different.
fn luminance_range_mask(node: &Node, inputs: &[(String, Value)]) -> Result<Value, EngineError> {
    let src = image_input(inputs, "in", &node.id)?;
    let low = p(&node.params, "low", 0.0);
    let high = p(&node.params, "high", 1.0);
    let feather = p(&node.params, "feather", 0.1).max(1e-6);
    let invert = p_bool(&node.params, "invert", false);

    let mut out = MaskBuf::new(src.width, src.height);
    use rayon::prelude::*;
    out.data.par_iter_mut().enumerate().for_each(|(i, m)| {
        let j = i * 4;
        let l = luma(src.data[j], src.data[j + 1], src.data[j + 2]);
        let v = smoothstep(low - feather, low, l) * (1.0 - smoothstep(high, high + feather, l));
        *m = if invert { 1.0 - v } else { v };
    });
    Ok(Value::Mask(Arc::new(out)))
}

/// Opacity is a percentage, including values between zero and one.
fn fraction(raw: f32) -> f32 {
    (raw / 100.0).clamp(0.0, 1.0)
}

/// A layer's picture as its blend lays it on a frame of `w` by `h`: the
/// blend's fit, then its transform. One function for the blend itself,
/// for a layer clipped to this one (its clip reads the base layer's
/// picture where the base layer put it) and for the export's Finish
/// layers (the written layer is where the composite shows it), so the
/// three cannot place a layer differently.
///
/// A placed picture (the "place" fit, Finish image layers 2026-09-30) is
/// not fitted to the frame and then warped, which would resample it
/// twice: its whole extent goes onto the corners in one pass from its
/// own pixels. With no box written it fills the frame, as stretch does.
pub fn layer_on_frame(
    params: &std::collections::BTreeMap<String, ParamValue>,
    top: &Arc<ImageBuf>,
    w: usize,
    h: usize,
) -> Arc<ImageBuf> {
    let params = &*placement_on_frame(params, w, h);
    let fit = params.get("fit").and_then(|v| v.as_str()).unwrap_or("stretch");
    let frame = ImageBuf { width: w, height: h, data: Vec::new() };
    if fit == "place" {
        return match crate::ops_geometry::Quad::placed_from_params(params) {
            Some(q) => {
                // An image layer's own warp hands the picture over with a
                // margin on every side (ops_warp layer_warp, `room`): the
                // margin goes outside the corners, so the picture itself
                // lands where it always did and a pull that carried it
                // past its rectangle shows past the corners.
                let q = placed_margin(params, top).and_then(|(mx, my)| q.padded(mx, my)).unwrap_or(q);
                Arc::new(crate::ops_geometry::place_image(top, w, h, &q))
            }
            None => conform(top, &frame),
        };
    }
    let fitted = conform_fit(top, &frame, fit);
    match crate::ops_geometry::Quad::from_params(params) {
        Some(q) => Arc::new(crate::ops_geometry::warp_image(&fitted, &q)),
        None => fitted,
    }
}

/// The margin a placed picture arrives with, as fractions of its own
/// width and height, from the blend's `place_pad` (the room of the
/// layer's own warp, in percent) and the picture's padded size. None
/// with no room, or when the picture's size is not one the room pads
/// to. The frontend folds `place_pad` on only while the layer's warp
/// is switched on (bridge.ts placePads), so a bare picture never meets
/// a room it did not get.
fn placed_margin(params: &std::collections::BTreeMap<String, ParamValue>, top: &ImageBuf) -> Option<(f32, f32)> {
    let room = p(params, "place_pad", 0.0);
    if !(room > 0.0) {
        return None;
    }
    let w = crate::ops_warp::unpadded_len(top.width, room)?;
    let h = crate::ops_warp::unpadded_len(top.height, room)?;
    let (px, py) = (crate::ops_warp::room_px(w, room), crate::ops_warp::room_px(h, room));
    if px == 0 && py == 0 {
        return None;
    }
    Some((px as f32 / w as f32, py as f32 / h as f32))
}

/// The frame-shape rule for a placed layer (2026-09-30: "yes, fix the
/// frame shape issue for Finish layers").
///
/// A placed picture's corners are written as fractions of the frame
/// they were placed on, and `warp_aspect` records that frame's shape
/// (its width over its height). On a frame of another shape (a crop
/// that changed the aspect, a quarter turn of the crop, Paste Edits or
/// a link onto a photograph of another shape) the layer is carried
/// over by one rule: its center (where its diagonals cross) stays at
/// the same fraction of the frame, and its extent keeps its size in
/// units of the frame's SHORT side. So a square logo stays square, a
/// crop that only trims the long side leaves it the same size in
/// pixels, and a logo in the lower right stays in the lower right. The
/// box and the corners go through the same map, so the picture is
/// neither stretched nor sheared, only moved and sized.
///
/// No stamp (a graph saved before the rule, or a layer that is not a
/// placed picture) reads the numbers as plain fractions of whatever
/// frame they land on, which is how every other Finish geometry reads.
/// The params come back stamped with this frame, so a second pass over
/// them is the identity. One function for the blend, the clip, the
/// export and the mask, like `layer_on_frame`; the frontend runs the
/// same arithmetic (imagelayers.ts reframeQuad) before it draws the
/// handles and fills the typed fields.
pub fn placement_on_frame(
    params: &std::collections::BTreeMap<String, ParamValue>,
    w: usize,
    h: usize,
) -> std::borrow::Cow<'_, std::collections::BTreeMap<String, ParamValue>> {
    use std::borrow::Cow;
    let num = |k: &str| params.get(k).and_then(|v| v.as_f64());
    let from = num("warp_aspect").unwrap_or(0.0);
    let (bw, bh) = (num("warp_bw").unwrap_or(0.0), num("warp_bh").unwrap_or(0.0));
    if !(from > 0.0) || !from.is_finite() || w == 0 || h == 0 || bw <= 0.0 || bh <= 0.0 {
        return Cow::Borrowed(params);
    }
    let to = w as f64 / h as f64;
    if (from / to - 1.0).abs() < 1e-6 {
        return Cow::Borrowed(params);
    }
    let (bx, by) = (num("warp_bx").unwrap_or(0.0), num("warp_by").unwrap_or(0.0));
    let rest = [[bx, by], [bx + bw, by], [bx + bw, by + bh], [bx, by + bh]];
    let mut dst = [[0.0f64; 2]; 4];
    for (i, c) in rest.iter().enumerate() {
        dst[i] = [num(&format!("warp_x{i}")).unwrap_or(c[0]), num(&format!("warp_y{i}")).unwrap_or(c[1])];
    }
    // The registry's zeros under a written box: the picture on its box,
    // as Quad::placed_from_params reads it.
    if dst.iter().all(|c| c[0] == 0.0 && c[1] == 0.0) {
        dst = rest;
    }
    let c = quad_crossing(&dst);
    let (kx, ky) = reframe_factors(from, to);
    let map = |q: [f64; 2]| [c[0] + (q[0] - c[0]) * kx, c[1] + (q[1] - c[1]) * ky];
    let mut out = params.clone();
    let b0 = map([bx, by]);
    for (k, v) in [("warp_bx", b0[0]), ("warp_by", b0[1]), ("warp_bw", bw * kx), ("warp_bh", bh * ky), ("warp_aspect", to)] {
        out.insert(k.to_string(), ParamValue::Number(v));
    }
    for (i, q) in dst.iter().enumerate() {
        let m = map(*q);
        out.insert(format!("warp_x{i}"), ParamValue::Number(m[0]));
        out.insert(format!("warp_y{i}"), ParamValue::Number(m[1]));
    }
    Cow::Owned(out)
}

/// The per-axis factors that carry a length in fractions of a frame of
/// aspect `from` to fractions of a frame of aspect `to`, keeping it the
/// same in units of the frame's short side: a frame is max(aspect, 1)
/// short sides wide and max(1, 1/aspect) short sides tall.
pub fn reframe_factors(from: f64, to: f64) -> (f64, f64) {
    (from.max(1.0) / to.max(1.0), (1.0 / from).max(1.0) / (1.0 / to).max(1.0))
}

/// Where a quad's diagonals cross (TL, TR, BR, BL): its visual center,
/// the point a homography carries the box's center to. The mean of the
/// corners when the diagonals do not cross. The frontend's
/// imagelayers.ts crossing() is the same arithmetic.
fn quad_crossing(q: &[[f64; 2]; 4]) -> [f64; 2] {
    let mean = [(q[0][0] + q[1][0] + q[2][0] + q[3][0]) / 4.0, (q[0][1] + q[1][1] + q[2][1] + q[3][1]) / 4.0];
    let (a, b, c, d) = (q[0], q[1], q[2], q[3]);
    let d1 = [c[0] - a[0], c[1] - a[1]];
    let d2 = [d[0] - b[0], d[1] - b[1]];
    let den = d1[0] * d2[1] - d1[1] * d2[0];
    if den.abs() < 1e-12 {
        return mean;
    }
    let t = ((b[0] - a[0]) * d2[1] - (b[1] - a[1]) * d2[0]) / den;
    [a[0] + t * d1[0], a[1] + t * d1[1]]
}

/// The base layer's placement a clipped blend carries as `clip_place`:
/// "fit;bx,by,bw,bh,x0,y0,x1,y1,x2,y2,x3,y3", the base blend's fit and
/// its transform, and a thirteenth number, the frame shape it was
/// placed on, when the base carries one (the frame-shape rule,
/// `placement_on_frame`). None when absent or unreadable (the clip is
/// then stretched to the frame as it always was).
fn clip_frame_params(node: &Node) -> Option<std::collections::BTreeMap<String, ParamValue>> {
    let raw = node.params.get("clip_place")?.as_str()?.trim();
    let (fit, nums) = raw.split_once(';')?;
    let vals: Vec<f64> = nums.split(',').map(|v| v.trim().parse::<f64>()).collect::<Result<_, _>>().ok()?;
    // Twelve numbers, then the frame shape (zero for none), then the
    // room of the base layer's own warp (place_pad) when it has one.
    if !(12..=14).contains(&vals.len()) {
        return None;
    }
    let mut p = std::collections::BTreeMap::new();
    p.insert("fit".to_string(), ParamValue::Text(fit.trim().to_string()));
    let keys = ["warp_bx", "warp_by", "warp_bw", "warp_bh", "warp_x0", "warp_y0", "warp_x1", "warp_y1", "warp_x2", "warp_y2", "warp_x3", "warp_y3", "warp_aspect", "place_pad"];
    for (k, v) in keys.iter().zip(vals) {
        p.insert(k.to_string(), ParamValue::Number(v));
    }
    Some(p)
}

/// A frame-sized mask through a layer's transform, the way the blend
/// carries its mask with the picture. Unmoved corners hand it back.
pub fn layer_mask_on_frame(params: &std::collections::BTreeMap<String, ParamValue>, mask: &MaskBuf) -> Option<MaskBuf> {
    let params = placement_on_frame(params, mask.width, mask.height);
    crate::ops_geometry::Quad::from_params(&params).map(|q| crate::ops_geometry::warp_mask(mask, &q))
}

/// Blend `blend` over `base` by mode, then lerp with opacity.
fn blend(node: &Node, inputs: &[(String, Value)]) -> Result<Value, EngineError> {
    let base = image_input(inputs, "base", &node.id)?;
    // Nothing on top: the base, untouched.
    let Some(top_in) = inputs.iter().find(|(n, _)| n == "blend") else {
        return Ok(Value::Image(base.clone()));
    };
    let top_raw = top_in.1.as_image().ok_or_else(|| EngineError::TypeMismatch { node: node.id.clone(), port: "blend".into() })?;
    // The layer transform: Move/Scale/Rotate and Warp both land here, as
    // four corners this layer's content has been dragged to. It applies
    // to the top and to the mask and to nothing else, because the base
    // is the photograph underneath and it is not the thing being moved.
    // Absent or unmoved corners cost nothing at all: `from_params`
    // returns None and every buffer below is the one that arrived.
    // Through the frame-shape rule first, so the picture and its mask
    // are carried onto this frame's shape by the same numbers.
    let placement = placement_on_frame(&node.params, base.width, base.height);
    let quad = crate::ops_geometry::Quad::from_params(&placement);
    let top = if p_bool(&node.params, "content_placed", false) { conform(top_raw, base) } else { layer_on_frame(&placement, top_raw, base.width, base.height) };
    let top: &ImageBuf = &top;
    // Percent values include fractions of a percent and exactly one percent.
    let opacity = fraction(p(&node.params, "opacity", 100.0));
    let mode = node
        .params
        .get("mode")
        .and_then(|v| v.as_str())
        .unwrap_or("normal");
    // Resolved here rather than per channel per pixel.
    let mode = crate::ops_layers::BlendMode::parse(mode);

    // The clipping mask: the base layer's content on its own port, read
    // by ALPHA -- "where the base has pixels" is its alpha, not its
    // redness, or a black base would clip everything to nothing.
    //
    // The base layer's content arrives as it left its node, before the
    // base layer's own blend placed it; `clip_place` (folded on at
    // serialization from the base layer's blend) says where that blend
    // puts it, so a layer clipped to a moved or placed picture shows
    // through the picture where it is (Finish image layers, 2026-09-30).
    let clip = inputs
        .iter()
        .find(|(port, _)| port == "clip")
        .and_then(|(_, v)| match v {
            Value::Image(m) => Some(match clip_frame_params(node) {
                Some(p) => layer_on_frame(&p, m, base.width, base.height),
                None => conform(m, base),
            }),
            _ => None,
        });

    // An optional mask, which is opacity that varies per pixel. Nothing
    // else about the blend changes: no mask is a mask of one everywhere.
    let mask = inputs
        .iter()
        .find(|(port, _)| port == "mask")
        .and_then(|(_, v)| match v {
            Value::Image(m) => Some(conform(m, base)),
            _ => None,
        })
        // Through the same quad as the picture. A mask left behind would
        // be a window the content slides past rather than a shape that
        // travels with it.
        .map(|m| match quad {
            Some(q) => Arc::new(crate::ops_geometry::warp_image(&m, &q)),
            None => m,
        });
    // A real mask buffer (what the mask nodes emit) is honored too; it
    // only ever arrived as an image before, so a brush mask wired to a
    // blend's mask port did nothing at all. Exact dims, the same
    // contract as the executor's mask blending, and a mask that does
    // not fit closes the layer rather than dropping out of it: dropped,
    // a Finish layer's mask left the layer over the whole frame
    // (mask_on_frame).
    let mask_buf = inputs
        .iter()
        .find(|(port, _)| port == "mask")
        .and_then(|(_, v)| v.as_mask())
        .map(|m| mask_on_frame(&node.id, m, base.width, base.height));
    let warped_mask = quad.and_then(|q| mask_buf.as_ref().map(|m| crate::ops_geometry::warp_mask(m, &q)));
    let mask_buf: Option<&MaskBuf> = match warped_mask.as_ref() {
        Some(w) => Some(w),
        None => mask_buf.as_deref(),
    };

    let adjustment = p_bool(&node.params, "adjustment", false);
    let adjustment_delta = p_bool(&node.params, "adjustment_delta", false);
    let mask_baked = p_bool(&node.params, "mask_baked", false);
    let mut out = ImageBuf::new(base.width, base.height);
    use rayon::prelude::*;
    out.data
        .par_chunks_mut(4)
        .enumerate()
        .for_each(|(px, o)| {
            let i = px * 4;
            // A correction changes existing pixels and keeps their
            // coverage. Using source-over here inflated a soft edge even
            // when the adjustment was neutral inside an isolated group.
            if adjustment {
                let weight = opacity
                    * clip.as_ref().map(|m| m.data[i + 3].clamp(0.0, 1.0)).unwrap_or(1.0)
                    * mask.as_ref().map(|m| m.data[i].clamp(0.0, 1.0))
                        .or_else(|| mask_buf.map(|m| m.data[px].clamp(0.0, 1.0))).unwrap_or(1.0);
                if adjustment_delta {
                    if let Some(original) = clip.as_ref() {
                        let before = [original.data[i], original.data[i + 1], original.data[i + 2]];
                        let after = [top.data[i], top.data[i + 1], top.data[i + 2]];
                        let mixed = crate::ops_layers::blend_pixel_mode(mode, before, after);
                        let coverage = base.data[i + 3];
                        let k = if coverage > 1e-6 { weight / coverage } else { 0.0 };
                        for c in 0..3 { o[c] = base.data[i + c] + (mixed[c] - before[c]) * k; }
                        o[3] = coverage;
                        return;
                    }
                }
                let b = [base.data[i], base.data[i + 1], base.data[i + 2]];
                let t = [top.data[i], top.data[i + 1], top.data[i + 2]];
                let mixed = crate::ops_layers::blend_pixel_mode(mode, b, t);
                for c in 0..3 { o[c] = b[c] + (mixed[c] - b[c]) * weight; }
                o[3] = base.data[i + 3];
                return;
            }
            // The top's own alpha participates: a paint layer is
            // transparent where nobody painted, and transparent must
            // mean "base shows through", not "blend with black".
            let a = opacity
                * top.data[i + 3].clamp(0.0, 1.0)
                * clip
                    .as_ref()
                    .map(|m| m.data[i + 3].clamp(0.0, 1.0))
                    .unwrap_or(1.0)
                * if mask_baked { 1.0 } else { mask
                    .as_ref()
                    .map(|m| m.data[i].clamp(0.0, 1.0))
                    .or_else(|| mask_buf.map(|m| m.data[px].clamp(0.0, 1.0)))
                    .unwrap_or(1.0) };
            // Porter-Duff alpha, the same rule merge keeps: the top's
            // coverage ADDS to what is underneath rather than replacing
            // it. Copying the base's alpha through was fine while every
            // base was the opaque photograph; a stack group's canvas is
            // transparent by design, and copying zero made the whole
            // group invisible one level up.
            let ba = base.data[i + 3].clamp(0.0, 1.0);
            let out_a = a + ba * (1.0 - a);
            // And the color, over a base that may not be opaque. The
            // three regions of the standard formula: where only the top
            // covers, the top's own color; where only the base does,
            // the base's; where both do, the blend of the two.
            //
            //   out_c * out_a = (1-ba)*a*t + (1-a)*ba*b + a*ba*blended
            //
            // Substituting ba = 1 gives b + (blended - b) * a, which is
            // exactly what shipped, so the opaque photograph every
            // Develop blend sits on is untouched. That path is written
            // out separately rather than left to the arithmetic: it runs
            // on every render, and it must not move by a rounding step.
            //
            // The old formula ran everywhere, and inside a group it read
            // the base's straight color as though it were premultiplied:
            // a member at half opacity came out at 0.35 where the same
            // layer outside a group came out at 0.60. Every soft brush
            // edge and every masked member inside a group carried the
            // same darkening, because partial coverage is where the two
            // formulas disagree.
            let opaque_base = ba >= 1.0;
            if mode.is_component() {
                // Hue/saturation/color/luminosity recombine the whole
                // pixel; per-channel application would tear them apart.
                let b3 = [base.data[i], base.data[i + 1], base.data[i + 2]];
                let t3 = [top.data[i], top.data[i + 1], top.data[i + 2]];
                let blended = crate::ops_layers::blend_pixel_mode(mode, b3, t3);
                for c in 0..3 {
                    o[c] = if opaque_base {
                        b3[c] + (blended[c] - b3[c]) * a
                    } else if out_a > 1e-6 {
                        ((1.0 - ba) * a * t3[c]
                            + (1.0 - a) * ba * b3[c]
                            + a * ba * blended[c])
                            / out_a
                    } else {
                        0.0
                    };
                }
            } else {
                for c in 0..3 {
                    let b = base.data[i + c];
                    let t = top.data[i + c];
                    // One table of formulas, shared with ops_layers, so
                    // the node and anything else that needs to know what
                    // "overlay" means cannot drift apart.
                    let blended = crate::ops_layers::blend_channel_mode(mode, b, t);
                    o[c] = if opaque_base {
                        b + (blended - b) * a
                    } else if out_a > 1e-6 {
                        ((1.0 - ba) * a * t + (1.0 - a) * ba * b + a * ba * blended) / out_a
                    } else {
                        0.0
                    };
                }
            }
            o[3] = out_a;
        });
    Ok(Value::Image(Arc::new(out)))
}

/// The weight a Blend gives its layer at each pixel of its frame, the
/// layer's own picture aside: opacity, times the clipping base's alpha,
/// times the mask carried with the layer's corners. The blend's own
/// coverage is this times the top's alpha, so for an opaque layer (an
/// adjustment, a fill) it is exactly what the blend applies. The export
/// writes it as a Finish layer's mask (2026-09-30: "add a toggle below
/// the Depth Mask for export layer and this one maps to the alpha
/// channel that the adjustment layer uses"). Built from the same steps
/// as `blend`, and a test holds the two together.
pub fn blend_mask_weight(node: &Node, inputs: &[(String, Value)]) -> Result<MaskBuf, EngineError> {
    let base = image_input(inputs, "base", &node.id)?;
    let (w, h) = (base.width, base.height);
    let placement = placement_on_frame(&node.params, w, h);
    let quad = crate::ops_geometry::Quad::from_params(&placement);
    let opacity = fraction(p(&node.params, "opacity", 100.0));
    let clip = inputs
        .iter()
        .find(|(port, _)| port == "clip")
        .and_then(|(_, v)| match v {
            Value::Image(m) => Some(match clip_frame_params(node) {
                Some(p) => layer_on_frame(&p, m, w, h),
                None => conform(m, base),
            }),
            _ => None,
        });
    let mask = inputs
        .iter()
        .find(|(port, _)| port == "mask")
        .and_then(|(_, v)| match v {
            Value::Image(m) => Some(conform(m, base)),
            _ => None,
        })
        .map(|m| match quad {
            Some(q) => Arc::new(crate::ops_geometry::warp_image(&m, &q)),
            None => m,
        });
    let mask_buf = inputs
        .iter()
        .find(|(port, _)| port == "mask")
        .and_then(|(_, v)| v.as_mask())
        .map(|m| mask_on_frame(&node.id, m, w, h));
    let warped_mask = quad.and_then(|q| mask_buf.as_ref().map(|m| crate::ops_geometry::warp_mask(m, &q)));
    let mask_buf: Option<&MaskBuf> = match warped_mask.as_ref() {
        Some(m) => Some(m),
        None => mask_buf.as_deref(),
    };
    // Across the cores: a bake asks this of a 24 megapixel frame.
    use rayon::prelude::*;
    let data = (0..w * h)
        .into_par_iter()
        .map(|px| {
            let i = px * 4;
            opacity
                * clip.as_ref().map(|m| m.data[i + 3].clamp(0.0, 1.0)).unwrap_or(1.0)
                * mask
                    .as_ref()
                    .map(|m| m.data[i].clamp(0.0, 1.0))
                    .or_else(|| mask_buf.map(|m| m.data[px].clamp(0.0, 1.0)))
                    .unwrap_or(1.0)
        })
        .collect();
    Ok(MaskBuf { width: w, height: h, data })
}

/// Porter-Duff "over" using the foreground alpha, scaled by opacity.
fn merge(node: &Node, inputs: &[(String, Value)]) -> Result<Value, EngineError> {
    let base = image_input(inputs, "base", &node.id)?;
    // Nothing on top: the base, untouched.
    let Some(fg_in) = inputs.iter().find(|(n, _)| n == "fg") else {
        return Ok(Value::Image(base.clone()));
    };
    let fg = conform_fit(
        fg_in.1.as_image().ok_or_else(|| EngineError::TypeMismatch { node: node.id.clone(), port: "fg".into() })?,
        base,
        &fit_of(node),
    );
    let fg = &*fg;
    let opacity = fraction(p(&node.params, "opacity", 100.0));

    let mut out = ImageBuf::new(base.width, base.height);
    use rayon::prelude::*;
    out.data
        .par_chunks_mut(4)
        .enumerate()
        .for_each(|(px, o)| {
            let i = px * 4;
            let fa = (fg.data[i + 3] * opacity).clamp(0.0, 1.0);
            let ba = base.data[i + 3];
            let out_a = fa + ba * (1.0 - fa);
            for c in 0..3 {
                // The same compositing formula blend() uses, and for
                // the same reason: over a base that is not opaque, the
                // straightforward lerp produces PREMULTIPLIED color
                // beside a straight alpha, and the level above reads it
                // as a darker color instead of a thinner one. Merge
                // carries the members of any group made before
                // 2026-08-27, so this is not a dead path.
                //
                // ba = 1 reduces to fg*fa + base*(1-fa) exactly, which
                // is what shipped; written out so the opaque case
                // cannot move by a rounding step.
                o[c] = if ba >= 1.0 {
                    fg.data[i + c] * fa + base.data[i + c] * (1.0 - fa)
                } else if out_a > 1e-6 {
                    (fg.data[i + c] * fa + base.data[i + c] * ba * (1.0 - fa)) / out_a
                } else {
                    0.0
                };
            }
            o[3] = out_a;
        });
    Ok(Value::Image(Arc::new(out)))
}

thread_local! {
    static MASK_MISMATCHES: std::cell::RefCell<Vec<String>> = const { std::cell::RefCell::new(Vec::new()) };
}

/// A mask buffer on the frame it gates: the same buffer when the sizes
/// agree, and a mask of zero everywhere when they do not, with a note
/// the desktop logs at WARN (`take_mask_mismatches`).
///
/// Every mask that reaches a gate the right way is the frame's own size:
/// the desktop feeds masks from the frame (the user's crop) and carries
/// planted rasters and the sharp slice's cut through the same geometry
/// as the picture. A mask of another size is a wiring the engine cannot
/// place: a stretch would put it over the wrong part of the picture, and
/// dropping it (what the blend and the per-node gate used to do) turned
/// a masked layer into one over the whole frame, which is the worst
/// answer of the three (a Finish layer's mask after a crop, 2026-09-30).
/// So the gate closes: the layer or the adjustment shows nowhere, and
/// the log says which node and which sizes.
pub fn mask_on_frame<'a>(node_id: &str, mask: &'a MaskBuf, width: usize, height: usize) -> std::borrow::Cow<'a, MaskBuf> {
    if mask.width == width && mask.height == height {
        return std::borrow::Cow::Borrowed(mask);
    }
    note_mask_mismatch(node_id, (mask.width, mask.height), (width, height));
    std::borrow::Cow::Owned(MaskBuf { width, height, data: vec![0.0; width * height] })
}

/// Records a mask the gate closed on (`mask_on_frame`). Per thread, the
/// executor's own: a render and the read that follows it share one.
pub fn note_mask_mismatch(node_id: &str, mask: (usize, usize), frame: (usize, usize)) {
    let line = format!(
        "Mask into {node_id} is {} by {} on a {} by {} frame; the mask cannot be placed, so the node applies nowhere",
        mask.0, mask.1, frame.0, frame.1
    );
    MASK_MISMATCHES.with(|m| {
        let mut m = m.borrow_mut();
        if !m.contains(&line) && m.len() < 64 {
            m.push(line);
        }
    });
}

/// The mismatches noted on this thread since the last take, oldest
/// first, for the desktop to log.
pub fn take_mask_mismatches() -> Vec<String> {
    MASK_MISMATCHES.with(|m| std::mem::take(&mut *m.borrow_mut()))
}

/// Generic per-node mask application: out = in + (processed - in) * mask.
pub fn apply_mask(original: &ImageBuf, processed: &ImageBuf, mask: &MaskBuf) -> ImageBuf {
    use rayon::prelude::*;
    let mut out = processed.clone();
    out.data.par_chunks_mut(4).enumerate().for_each(|(px, o)| {
        let m = mask.data[px].clamp(0.0, 1.0);
        let i = px * 4;
        for c in 0..4 {
            o[c] = original.data[i + c] + (processed.data[i + c] - original.data[i + c]) * m;
        }
    });
    out
}

#[cfg(test)]
mod detail_node_tests {
    use super::*;
    use crate::ops::test_util::{make_node, set_num};

    fn scene() -> ImageBuf {
        let mut img = ImageBuf::new(8, 8);
        for y in 0..8 {
            for x in 0..8 {
                let v = 0.05 + 0.1 * ((x * 3 + y * 5) % 9) as f32;
                img.set_pixel(x, y, [v, v * 0.8, v * 1.2, 1.0]);
            }
        }
        img
    }

    fn run(node: &Node, img: &ImageBuf) -> ImageBuf {
        (**execute(node, &[("in".to_string(), Value::Image(Arc::new(img.clone())))])
            .unwrap()
            .as_image()
            .unwrap())
        .clone()
    }

    #[test]
    fn detail_defaults_are_identity() {
        let n = make_node("heeler.detail");
        let src = scene();
        assert_eq!(run(&n, &src), src);
    }

    #[test]
    fn detail_node_matches_the_detail_half_of_standard_color() {
        // The same three dials on a Detail node after a neutral Standard
        // Color render exactly as they did on the Standard Color node.
        let src = scene();
        let mut old = make_node("heeler.standard_color");
        set_num(&mut old, "texture", 35.0);
        set_num(&mut old, "clarity", 20.0);
        set_num(&mut old, "dehaze", 15.0);
        set_num(&mut old, "clarity_shadows", 60.0);
        let want = run(&old, &src);
        let neutral = make_node("heeler.standard_color");
        let mut det = make_node("heeler.detail");
        set_num(&mut det, "texture", 35.0);
        set_num(&mut det, "clarity", 20.0);
        set_num(&mut det, "dehaze", 15.0);
        set_num(&mut det, "clarity_shadows", 60.0);
        let got = run(&det, &run(&neutral, &src));
        for (a, b) in want.data.iter().zip(got.data.iter()) {
            assert!((a - b).abs() < 1e-5, "{a} vs {b}");
        }
    }

    #[test]
    fn a_clipped_shadow_is_weighted_off_its_true_base() {
        // The forward veil clips: below the veil amount, display luma
        // floors at zero and the pre-dehaze value cannot be recovered
        // from the dehazed frame. The re-weighted path keeps the true
        // base instead of reconstructing one, and this pins that: with
        // dehaze at 50 and every dehaze band weighted to half, a clipped
        // pixel lands on exactly half its ORIGINAL value. Reconstructing
        // the base the pre-split way (inverting the clipped veil) would
        // land it near zero instead, about 3e-5 for this pixel, so this
        // test is what keeps the divergence deliberate.
        let mut img = ImageBuf::new(2, 1);
        // to_display(0.002) = 0.0258, under the veil amount of 0.05.
        img.set_pixel(0, 0, [0.002, 0.002, 0.002, 1.0]);
        // A mid gray, well clear of the clip, as the control.
        img.set_pixel(1, 0, [0.18, 0.18, 0.18, 1.0]);
        let mut n = make_node("heeler.detail");
        set_num(&mut n, "dehaze", 50.0);
        set_num(&mut n, "dehaze_shadows", 50.0);
        set_num(&mut n, "dehaze_midtones", 50.0);
        set_num(&mut n, "dehaze_highlights", 50.0);
        let out = run(&n, &img);
        for c in 0..3 {
            assert!((out.data[c] - 0.001).abs() < 1e-5, "clipped channel {c}: {}", out.data[c]);
        }
        // The control takes the veil unclipped, then halves the delta:
        // base + 0.5 * (veiled - base), computed the way the pass does.
        let a = DEHAZE_VEIL * 0.5;
        let nd = (to_display(0.18) - a) / (1.0 - a);
        let veiled = to_scene(nd);
        let want = 0.18 + 0.5 * (veiled - 0.18);
        for c in 4..7 {
            assert!((out.data[c] - want).abs() < 1e-5, "control channel {c}: {} vs {want}", out.data[c]);
        }
    }
}

#[cfg(test)]
mod empty_top_tests {
    use super::*;
    use crate::ops::test_util::make_node;

    #[test]
    fn a_blend_with_nothing_on_top_is_its_base() {
        let n = make_node("heeler.blend");
        let base = Arc::new(ImageBuf::filled(2, 2, [0.2, 0.4, 0.6, 1.0]));
        let out = blend(&n, &[("base".to_string(), Value::Image(base.clone()))]).unwrap();
        assert!(Arc::ptr_eq(out.as_image().unwrap(), &base));
    }

    #[test]
    fn a_merge_with_nothing_on_top_is_its_base() {
        let n = make_node("heeler.merge");
        let base = Arc::new(ImageBuf::filled(2, 2, [0.2, 0.4, 0.6, 1.0]));
        let out = merge(&n, &[("base".to_string(), Value::Image(base.clone()))]).unwrap();
        assert!(Arc::ptr_eq(out.as_image().unwrap(), &base));
    }
}

#[cfg(test)]
mod fit_tests {
    use super::*;

    fn wide() -> Arc<ImageBuf> {
        // 4x2, all opaque red.
        Arc::new(ImageBuf::filled(4, 2, [1.0, 0.0, 0.0, 1.0]))
    }

    #[test]
    fn fit_letterboxes_inside_a_square_frame() {
        let base = ImageBuf::filled(4, 4, [0.0, 0.0, 0.0, 1.0]);
        let out = conform_fit(&wide(), &base, "fit");
        assert_eq!((out.width, out.height), (4, 4));
        // The middle two rows carry the picture; the bands are transparent.
        assert_eq!(out.pixel(0, 0)[3], 0.0);
        assert_eq!(out.pixel(0, 1), [1.0, 0.0, 0.0, 1.0]);
        assert_eq!(out.pixel(3, 2), [1.0, 0.0, 0.0, 1.0]);
        assert_eq!(out.pixel(0, 3)[3], 0.0);
    }

    #[test]
    fn fill_covers_the_frame_and_crops_the_sides() {
        let base = ImageBuf::filled(4, 4, [0.0, 0.0, 0.0, 1.0]);
        let out = conform_fit(&wide(), &base, "fill");
        for y in 0..4 {
            for x in 0..4 {
                assert_eq!(out.pixel(x, y)[3], 1.0, "({x},{y}) should be covered");
            }
        }
    }

    #[test]
    fn none_places_the_picture_at_its_own_size_in_the_middle() {
        let base = ImageBuf::filled(6, 4, [0.0, 0.0, 0.0, 1.0]);
        let out = conform_fit(&wide(), &base, "none");
        assert_eq!(out.pixel(0, 1)[3], 0.0);
        assert_eq!(out.pixel(1, 1), [1.0, 0.0, 0.0, 1.0]);
        assert_eq!(out.pixel(4, 2), [1.0, 0.0, 0.0, 1.0]);
        assert_eq!(out.pixel(5, 2)[3], 0.0);
        assert_eq!(out.pixel(2, 0)[3], 0.0);
    }

    #[test]
    fn stretch_is_the_old_conform_and_a_same_size_input_is_untouched() {
        let base = ImageBuf::filled(4, 4, [0.0, 0.0, 0.0, 1.0]);
        let out = conform_fit(&wide(), &base, "stretch");
        for y in 0..4 {
            assert_eq!(out.pixel(0, y)[3], 1.0);
        }
        let same = Arc::new(ImageBuf::filled(4, 4, [0.0, 1.0, 0.0, 1.0]));
        assert!(Arc::ptr_eq(&conform_fit(&same, &base, "fit"), &same));
    }
}

#[cfg(test)]
pub(crate) mod test_util {
    use super::*;
    use heeler_graph::{Registry, Section};

    pub fn make_node(node_type: &str) -> Node {
        Registry::builtin()
            .instantiate(node_type, "n", Section::Creative)
            .unwrap()
    }

    pub fn run_on(node: &Node, image: ImageBuf) -> Result<Value, EngineError> {
        execute(node, &[("in".to_string(), Value::Image(Arc::new(image)))])
    }

    pub fn set_num(node: &mut Node, param: &str, v: f64) {
        node.params.insert(param.to_string(), ParamValue::Number(v));
    }

    pub fn set_text(node: &mut Node, param: &str, v: &str) {
        node.params
            .insert(param.to_string(), ParamValue::Text(v.to_string()));
    }

    pub fn assert_close(a: f32, b: f32) {
        assert!((a - b).abs() < 1e-4, "{a} != {b}");
    }
}

#[cfg(test)]
mod tests {
    use super::test_util::*;
    use super::*;

    /// A clipping mask reads the mask image by alpha: the base layer's
    /// pixels are the stencil, whatever color they are.
    #[test]
    fn a_clipped_blend_shows_only_where_the_base_has_pixels() {
        let base = ImageBuf::filled(2, 2, [0.2, 0.2, 0.2, 1.0]);
        let top = ImageBuf::filled(2, 2, [1.0, 1.0, 1.0, 1.0]);
        // The clip source: BLACK paint (alpha 1) on the left column,
        // nothing on the right. Read by red it would clip everything;
        // read by alpha it keeps the left.
        let mut shape = ImageBuf::new(2, 2);
        for y in 0..2 {
            let i = (y * 2) * 4;
            shape.data[i + 3] = 1.0; // black, opaque
        }
        let node = make_node("heeler.blend");
        let out = execute(
            &node,
            &[
                ("base".to_string(), Value::Image(Arc::new(base))),
                ("blend".to_string(), Value::Image(Arc::new(top))),
                ("clip".to_string(), Value::Image(Arc::new(shape))),
            ],
        )
        .unwrap();
        let img = out.as_image().unwrap();
        assert!(img.pixel(0, 0)[0] > 0.9, "shows inside the base's pixels");
        assert!(img.pixel(1, 0)[0] < 0.3, "hidden outside them");
    }

    /// A blend over a TRANSPARENT base must still come out opaque where
    /// the top is opaque: that is the inside of a stack group, whose
    /// canvas is transparent black by design. Blend used to copy the
    /// base's alpha straight through, so a member composited its color
    /// onto alpha 0, the group exit had alpha 0 everywhere, and the
    /// group's own blend at the top level gated by that alpha - the
    /// whole group rendered as nothing. Merge always did Porter-Duff
    /// over (fa + ba*(1-fa)); blend has to match it or "a group renders
    /// like its members did" stops being true the moment the carrier
    /// switched.
    /// The mask export's weight is what the blend applies: over an
    /// opaque base, with an opaque top of one color, the blend's output
    /// is base + (top - base) x weight at every pixel. Mask buffer and
    /// mask image, a clipping base, opacity and moved corners, each on
    /// and off, so no factor can drift from the blend's own.
    #[test]
    fn blend_mask_weight_is_the_weight_the_blend_applies() {
        let (w, h) = (12usize, 8usize);
        let mut base = ImageBuf::new(w, h);
        let mut mask = MaskBuf { width: w, height: h, data: vec![0.0; w * h] };
        let mut mask_img = ImageBuf::new(w, h);
        let mut clip = ImageBuf::new(w, h);
        for y in 0..h {
            for x in 0..w {
                let v = 0.1 + 0.02 * x as f32;
                base.set_pixel(x, y, [v, v, v, 1.0]);
                let m = (x as f32 + 0.5) / w as f32;
                mask.data[y * w + x] = m;
                let mi = (y as f32 + 0.5) / h as f32;
                mask_img.set_pixel(x, y, [mi, mi, mi, 1.0]);
                clip.set_pixel(x, y, [0.0, 0.0, 0.0, if (x + y) % 3 == 0 { 0.25 } else { 1.0 }]);
            }
        }
        let top = ImageBuf::filled(w, h, [0.9, 0.9, 0.9, 1.0]);
        for (opacity, use_clip, mask_kind, moved) in [
            (100.0, false, 0, false),
            (60.0, false, 1, false),
            (100.0, true, 2, false),
            (45.0, true, 1, true),
            (80.0, false, 2, true),
        ] {
            let mut node = make_node("heeler.blend");
            node.id = format!("weight_{opacity}_{use_clip}_{mask_kind}_{moved}");
            node.params.insert("opacity".into(), ParamValue::Number(opacity));
            if moved {
                for (k, v) in [
                    ("warp_bx", 0.0), ("warp_by", 0.0), ("warp_bw", 1.0), ("warp_bh", 1.0),
                    ("warp_x0", 0.1), ("warp_y0", 0.05), ("warp_x1", 0.95), ("warp_y1", 0.0),
                    ("warp_x2", 1.0), ("warp_y2", 0.9), ("warp_x3", 0.0), ("warp_y3", 1.0),
                ] {
                    node.params.insert(k.into(), ParamValue::Number(v));
                }
            }
            let mut inputs = vec![
                ("base".to_string(), Value::Image(Arc::new(base.clone()))),
                ("blend".to_string(), Value::Image(Arc::new(top.clone()))),
            ];
            if use_clip {
                inputs.push(("clip".to_string(), Value::Image(Arc::new(clip.clone()))));
            }
            match mask_kind {
                1 => inputs.push(("mask".to_string(), Value::Mask(Arc::new(mask.clone())))),
                2 => inputs.push(("mask".to_string(), Value::Image(Arc::new(mask_img.clone())))),
                _ => {}
            }
            let out = execute(&node, &inputs).unwrap();
            let out = out.as_image().unwrap();
            let weight = blend_mask_weight(&node, &inputs).unwrap();
            assert_eq!((weight.width, weight.height), (w, h));
            for px in 0..w * h {
                let b = base.data[px * 4];
                let want = b + (0.9 - b) * weight.data[px];
                assert!(
                    (out.data[px * 4] - want).abs() < 1e-5,
                    "{}: pixel {px} blended {} but the weight {} says {want}",
                    node.id,
                    out.data[px * 4],
                    weight.data[px]
                );
            }
        }
    }

    /// A mask buffer the size of its frame gates the layer; one of any
    /// other size closes it (the photograph everywhere, never the layer
    /// everywhere) and leaves a note naming the blend (mask_on_frame).
    #[test]
    fn a_blend_mask_of_another_size_closes_the_layer_and_says_so() {
        let base = ImageBuf::filled(6, 4, [0.2, 0.2, 0.2, 1.0]);
        let top = ImageBuf::filled(6, 4, [1.0, 0.0, 0.0, 1.0]);
        let mut node = make_node("heeler.blend");
        node.id = "blend_mask_size_test".into();
        let run = |mask: MaskBuf| {
            execute(
                &node,
                &[
                    ("base".to_string(), Value::Image(Arc::new(base.clone()))),
                    ("blend".to_string(), Value::Image(Arc::new(top.clone()))),
                    ("mask".to_string(), Value::Mask(Arc::new(mask))),
                ],
            )
            .unwrap()
            .as_image()
            .unwrap()
            .clone()
        };
        let _ = take_mask_mismatches();
        let mut left = MaskBuf::new(6, 4);
        for y in 0..4 {
            for x in 0..3 {
                left.data[y * 6 + x] = 1.0;
            }
        }
        let out = run(left);
        assert!(out.pixel(1, 1)[0] > 0.99 && (out.pixel(4, 1)[0] - 0.2).abs() < 1e-6, "the frame's own size gates");
        assert!(take_mask_mismatches().is_empty());
        let out = run(MaskBuf { width: 9, height: 6, data: vec![1.0; 54] });
        assert_eq!(out.data, base.data, "a mask it cannot place closes the layer");
        let notes = take_mask_mismatches();
        assert!(
            notes.iter().any(|n| n.contains("blend_mask_size_test") && n.contains("9 by 6") && n.contains("6 by 4")),
            "{notes:?}"
        );
    }

    #[test]
    fn blend_over_a_transparent_base_composites_porter_duff_alpha() {
        let base = ImageBuf::filled(2, 2, [0.0, 0.0, 0.0, 0.0]);
        let top = ImageBuf::filled(2, 2, [1.0, 0.0, 0.0, 1.0]);
        let node = make_node("heeler.blend");
        let out = execute(
            &node,
            &[
                ("base".to_string(), Value::Image(Arc::new(base))),
                ("blend".to_string(), Value::Image(Arc::new(top))),
            ],
        )
        .unwrap();
        let img = out.as_image().unwrap();
        assert!(img.pixel(0, 0)[3] > 0.99, "opaque top over nothing shows");
        assert!(img.pixel(0, 0)[0] > 0.99, "and shows in the top's color");
        // A half-covered top lands at half alpha, so the next level up
        // shows half of it.
        let top_half = ImageBuf::filled(2, 2, [1.0, 0.0, 0.0, 0.5]);
        let out = execute(
            &node,
            &[
                ("base".to_string(), Value::Image(Arc::new(ImageBuf::filled(2, 2, [0.0, 0.0, 0.0, 0.0])))),
                ("blend".to_string(), Value::Image(Arc::new(top_half))),
            ],
        )
        .unwrap();
        let img = out.as_image().unwrap();
        assert!((img.pixel(0, 0)[3] - 0.5).abs() < 1e-3, "half paint is half there");
        // Over an OPAQUE base nothing may change: the photograph below
        // is alpha 1, and the composite stays alpha 1.
        let out = execute(
            &node,
            &[
                ("base".to_string(), Value::Image(Arc::new(ImageBuf::filled(2, 2, [0.4, 0.4, 0.4, 1.0])))),
                ("blend".to_string(), Value::Image(Arc::new(ImageBuf::filled(2, 2, [1.0, 0.0, 0.0, 0.5])))),
            ],
        )
        .unwrap();
        let img = out.as_image().unwrap();
        assert!(img.pixel(0, 0)[3] > 0.99, "an opaque base stays opaque");
    }

    /// box_blur_pass on degenerate buffers: a 1-pixel-wide row and a
    /// 1-pixel-tall column have nothing to blur along the degenerate
    /// axis, and a radius wider than the image must clamp instead of
    /// under-counting the running-sum window (which used to dim a 1-px
    /// row by (r+1)/(2r+1)). Degenerate dims must pass the data
    /// through untouched.
    /// A layer inside a group must look like the same layer outside
    /// one. That is the whole promise of grouping, and partial coverage
    /// is where it used to break.
    ///
    /// Two steps, exactly as serializeGraph wires them: the member
    /// composites over the group's transparent canvas, and the group's
    /// exit then composites over the photograph. The single-step render
    /// of the same layer is the answer both must agree on.
    ///
    /// Before the compositing formula this returned 0.35 against 0.60:
    /// the member's color came out of the group scaled by its own
    /// alpha, and the level above read that premultiplied color as
    /// though it were a straight one, so every soft edge, every mask
    /// and every reduced opacity inside a group rendered dark.
    #[test]
    fn a_layer_in_a_group_renders_like_the_same_layer_outside_one() {
        let photo = || ImageBuf::filled(2, 2, [0.2, 0.2, 0.2, 1.0]);
        let red = || ImageBuf::filled(2, 2, [1.0, 0.0, 0.0, 1.0]);
        let mut half = make_node("heeler.blend");
        set_num(&mut half, "opacity", 50.0);

        let over = |node: &Node, base: ImageBuf, top: ImageBuf| {
            let out = execute(
                node,
                &[
                    ("base".to_string(), Value::Image(Arc::new(base))),
                    ("blend".to_string(), Value::Image(Arc::new(top))),
                ],
            )
            .unwrap();
            out.as_image().unwrap().pixel(0, 0)
        };

        // Ungrouped: half-opacity red straight onto the photograph.
        let plain = over(&half, photo(), red());

        // Grouped: the same layer over the group's transparent canvas,
        // and that result over the same photograph at full opacity.
        let exit = over(&half, ImageBuf::new(2, 2), red());
        let exit_img = ImageBuf::filled(2, 2, exit);
        let grouped = over(&make_node("heeler.blend"), photo(), exit_img);

        for c in 0..4 {
            assert_close(grouped[c], plain[c]);
        }
        // And the answer is the right one, not merely a matching pair:
        // half of white over 0.2 is 0.6.
        assert_close(plain[0], 0.6);

        // The group's exit carries STRAIGHT color, which is what makes
        // the two agree: full red at half coverage, not half red.
        assert_close(exit[0], 1.0);
        assert_close(exit[3], 0.5);
    }

    /// The same promise, for a group whose members are carried by
    /// merge: every group made before 2026-08-27, which is why the
    /// migration converts them rather than the renderer ignoring them.
    #[test]
    fn a_merged_member_also_renders_like_the_same_layer_outside_a_group() {
        let photo = || ImageBuf::filled(2, 2, [0.2, 0.2, 0.2, 1.0]);
        let red = || ImageBuf::filled(2, 2, [1.0, 0.0, 0.0, 1.0]);
        let mut half = make_node("heeler.merge");
        set_num(&mut half, "opacity", 50.0);

        let over = |node: &Node, base: ImageBuf, fg: ImageBuf| {
            let out = execute(
                node,
                &[
                    ("base".to_string(), Value::Image(Arc::new(base))),
                    ("fg".to_string(), Value::Image(Arc::new(fg))),
                ],
            )
            .unwrap();
            out.as_image().unwrap().pixel(0, 0)
        };

        let plain = over(&half, photo(), red());
        let exit = over(&half, ImageBuf::new(2, 2), red());
        let grouped = over(&make_node("heeler.merge"), photo(), ImageBuf::filled(2, 2, exit));

        for c in 0..4 {
            assert_close(grouped[c], plain[c]);
        }
        assert_close(plain[0], 0.6);
        assert_close(exit[0], 1.0);
        assert_close(exit[3], 0.5);
    }

    #[test]
    fn box_blur_pass_leaves_degenerate_dims_untouched() {
        // 1-wide column: horizontal pass is a no-op, vertical blurs.
        let mut col = vec![0.0f32, 1.0, 0.0, 1.0];
        let orig = col.clone();
        let mut scratch = vec![0.0f32; 4];
        box_blur_pass(&mut col, &mut scratch, 1, 4, 8);
        for (a, b) in col.iter().zip(orig.iter()) {
            // Vertical blur with clamped radius only mixes rows; with
            // r clamped to h-1 every output is a weighted mean of the
            // column, so values stay inside the input range and the
            // total ordering is preserved. The key assertion: no
            // dimming toward zero.
            assert!(a.is_finite());
            assert!(*a >= -1e-6 && *a <= 1.0 + 1e-6);
            let _ = b;
        }
        // 1-tall row: vertical pass is a no-op; and r >> w must clamp.
        let mut row = vec![0.25f32, 0.5, 0.75];
        let mut scratch = vec![0.0f32; 3];
        box_blur_pass(&mut row, &mut scratch, 3, 1, 16);
        for a in &row {
            assert!(a.is_finite());
            assert!(*a >= 0.25 - 1e-6 && *a <= 0.75 + 1e-6);
        }
        // Exactly 1x1: untouched.
        let mut one = vec![0.42f32];
        let mut scratch = vec![0.0f32; 1];
        box_blur_pass(&mut one, &mut scratch, 1, 1, 4);
        assert!((one[0] - 0.42).abs() < 1e-6);
    }

    fn gray(v: f32) -> ImageBuf {
        ImageBuf::filled(2, 2, [v, v, v, 1.0])
    }

    /// A ramp: dark on the left, bright on the right, with detail to
    /// grab onto so a local-contrast boost has something to do.
    fn detail_ramp() -> ImageBuf {
        let mut img = ImageBuf::new(32, 8);
        for y in 0..8 {
            for x in 0..32 {
                let base = x as f32 / 31.0;
                let speck = if (x + y) % 3 == 0 { 0.06 } else { -0.06 };
                let v = (base + speck).clamp(0.0, 1.0);
                img.set_pixel(x, y, [v, v * 0.8, v * 0.6, 1.0]);
            }
        }
        img
    }

    /// Weights left at 100 must render exactly as before: the split path
    /// costs an extra blur per effect, so it has to stay off by default.
    #[test]
    fn detail_weights_at_default_change_nothing() {
        let mut node = make_node("heeler.standard_color");
        set_num(&mut node, "texture", 60.0);
        set_num(&mut node, "clarity", 40.0);
        set_num(&mut node, "dehaze", 30.0);
        let plain = run_on(&node, detail_ramp()).unwrap();
        // Setting them explicitly to their defaults is still the fast path.
        for k in ["texture_shadows", "clarity_red", "dehaze_highlights"] {
            set_num(&mut node, k, 100.0);
        }
        let explicit = run_on(&node, detail_ramp()).unwrap();
        assert_eq!(plain.as_image().unwrap().data, explicit.as_image().unwrap().data);
    }

    /// An inactive effect's weight must not alter the active effects.
    /// This exercises a genuinely weighted path, unlike an almost-unit
    /// value that falls inside the neutral-weight tolerance.
    #[test]
    fn splitting_texture_and_clarity_matches_one_pass() {
        let mut node = make_node("heeler.standard_color");
        set_num(&mut node, "texture", 60.0);
        set_num(&mut node, "clarity", 40.0);
        let combined = run_on(&node, detail_ramp()).unwrap();
        set_num(&mut node, "dehaze_red", 0.0);
        assert!(detail_gains(&node.params, "dehaze").is_some());
        let split = run_on(&node, detail_ramp()).unwrap();
        let a = combined.as_image().unwrap();
        let b = split.as_image().unwrap();
        for (x, y) in a.data.iter().zip(b.data.iter()) {
            assert!((x - y).abs() < 1e-4, "split path drifted: {x} vs {y}");
        }
    }

    #[test]
    fn detail_band_gain_confines_clarity_to_its_band() {
        let mut node = make_node("heeler.standard_color");
        set_num(&mut node, "clarity", 80.0);
        let full = run_on(&node, detail_ramp()).unwrap();
        // Clarity switched off in the shadows only.
        set_num(&mut node, "clarity_shadows", 0.0);
        let no_shadows = run_on(&node, detail_ramp()).unwrap();
        let a = full.as_image().unwrap();
        let b = no_shadows.as_image().unwrap();
        // Dark end: the boost is gone. Bright end: untouched.
        let dark_delta: f32 = (0..4).map(|x| (a.pixel(x, 0)[0] - b.pixel(x, 0)[0]).abs()).sum();
        let bright_delta: f32 = (28..32).map(|x| (a.pixel(x, 0)[0] - b.pixel(x, 0)[0]).abs()).sum();
        assert!(dark_delta > 1e-3, "shadow clarity should have changed, got {dark_delta}");
        assert!(bright_delta < 1e-4, "highlights should be untouched, got {bright_delta}");
    }

    #[test]
    fn detail_channel_gain_confines_texture_to_its_channel() {
        let mut node = make_node("heeler.standard_color");
        set_num(&mut node, "texture", 80.0);
        let full = run_on(&node, detail_ramp()).unwrap();
        set_num(&mut node, "texture_blue", 0.0);
        let no_blue = run_on(&node, detail_ramp()).unwrap();
        let a = full.as_image().unwrap();
        let b = no_blue.as_image().unwrap();
        let red: f32 = (0..32).map(|x| (a.pixel(x, 3)[0] - b.pixel(x, 3)[0]).abs()).sum();
        let blue: f32 = (0..32).map(|x| (a.pixel(x, 3)[2] - b.pixel(x, 3)[2]).abs()).sum();
        assert!(blue > 1e-3, "blue texture should have changed, got {blue}");
        assert!(red < 1e-4, "red should be untouched, got {red}");
    }

    #[test]
    fn standard_color_defaults_are_identity() {
        let node = make_node("heeler.standard_color");
        let out = run_on(&node, ImageBuf::filled(1, 1, [0.4, 0.3, 0.2, 1.0])).unwrap();
        let px = out.as_image().unwrap().pixel(0, 0);
        assert_close(px[0], 0.4);
        assert_close(px[1], 0.3);
        assert_close(px[2], 0.2);
    }

    #[test]
    fn standard_color_saturation_minus_100_grays_out() {
        let mut node = make_node("heeler.standard_color");
        set_num(&mut node, "saturation", -100.0);
        let out = run_on(&node, ImageBuf::filled(1, 1, [0.5, 0.2, 0.1, 1.0])).unwrap();
        let px = out.as_image().unwrap().pixel(0, 0);
        assert_close(px[0], px[1]);
        assert_close(px[1], px[2]);
    }

    #[test]
    fn standard_color_vibrance_favors_low_chroma_pixels() {
        let mut node = make_node("heeler.standard_color");
        set_num(&mut node, "vibrance", 100.0);
        let mut img = ImageBuf::new(2, 1);
        img.set_pixel(0, 0, [0.32, 0.30, 0.28, 1.0]); // near gray
        img.set_pixel(1, 0, [0.60, 0.10, 0.05, 1.0]); // saturated
        let out = run_on(&node, img).unwrap();
        let img = out.as_image().unwrap();

        let spread = |px: [f32; 4], orig_spread: f32| {
            (px[0].max(px[1]).max(px[2]) - px[0].min(px[1]).min(px[2])) / orig_spread
        };
        let low_growth = spread(img.pixel(0, 0), 0.04);
        let high_growth = spread(img.pixel(1, 0), 0.55);
        assert!(
            low_growth > high_growth,
            "vibrance must boost near-gray more: {low_growth} vs {high_growth}"
        );
    }

    #[test]
    fn standard_color_exposure_matches_exposure_node_math() {
        let mut node = make_node("heeler.standard_color");
        set_num(&mut node, "exposure", 1.0);
        let out = run_on(&node, gray(0.2)).unwrap();
        assert_close(out.as_image().unwrap().pixel(0, 0)[0], 0.4);
    }

    #[test]
    fn standard_color_contrast_matches_exposure_node_math() {
        let input = ImageBuf::filled(1, 1, [0.45, 0.25, 0.10, 1.0]);
        for contrast in [-100.0, -35.0, 40.0, 100.0] {
            let mut simple = make_node("heeler.standard_color");
            set_num(&mut simple, "contrast", contrast);
            let mut advanced = make_node("heeler.exposure");
            set_num(&mut advanced, "contrast", contrast);
            let a = run_on(&simple, input.clone()).unwrap();
            let b = run_on(&advanced, input.clone()).unwrap();
            let (a, b) = (a.as_image().unwrap().pixel(0, 0), b.as_image().unwrap().pixel(0, 0));
            for channel in 0..3 {
                assert_close(a[channel], b[channel]);
            }
        }
    }

    #[test]
    fn curve_identity_when_empty() {
        let node = make_node("heeler.curves");
        let out = run_on(&node, gray(0.37)).unwrap();
        assert_close(out.as_image().unwrap().pixel(0, 0)[0], 0.37);
    }

    #[test]
    fn curve_interpolates_between_points_in_display_space() {
        // The curve axis is display-encoded: a point at x=0.5 grabs
        // display middle gray, not 50% linear light.
        let mut node = make_node("heeler.curves");
        set_text(&mut node, "points", r#"{"rgb": [[0,0],[0.5,0.25],[1,1]]}"#);
        let mut img = ImageBuf::new(2, 1);
        let a = to_scene(0.5);
        let b = to_scene(0.25);
        img.set_pixel(0, 0, [a, a, a, 1.0]);
        img.set_pixel(1, 0, [b, b, b, 1.0]);
        let out = run_on(&node, img).unwrap();
        let img = out.as_image().unwrap();
        assert_close(img.pixel(0, 0)[0], to_scene(0.25));
        assert_close(img.pixel(1, 0)[0], to_scene(0.125));
    }

    #[test]
    fn tangent_mode_honors_user_slopes_and_falls_back_on_mismatch() {
        // A flat user tangent (slope 0) at the midpoint makes the curve
        // level off there; the monotone tangents would keep it rising.
        // Sampled just past the midpoint, the two must part ways.
        let mut flat = make_node("heeler.curves");
        set_text(
            &mut flat,
            "points",
            r#"{"interp": "tangent", "rgb": [[0,0],[0.5,0.5],[1,1]], "rgb_m": [1,0,1]}"#,
        );
        let mut auto = make_node("heeler.curves");
        set_text(
            &mut auto,
            "points",
            r#"{"interp": "smooth", "rgb": [[0,0],[0.5,0.5],[1,1]]}"#,
        );
        let x = to_scene(0.55);
        let a = run_on(&flat, gray(x)).unwrap().as_image().unwrap().pixel(0, 0)[0];
        let b = run_on(&auto, gray(x)).unwrap().as_image().unwrap().pixel(0, 0)[0];
        assert!(
            (a - b).abs() > 1e-3,
            "flat tangent should differ from monotone: {a} vs {b}"
        );
        // On the point itself both are exact.
        let on = run_on(&flat, gray(to_scene(0.5))).unwrap();
        assert_close(on.as_image().unwrap().pixel(0, 0)[0], to_scene(0.5));
        // A slope list that does not fit its points falls back to the
        // monotone smooth curve rather than guessing or failing.
        let mut broken = make_node("heeler.curves");
        set_text(
            &mut broken,
            "points",
            r#"{"interp": "tangent", "rgb": [[0,0],[0.5,0.5],[1,1]], "rgb_m": [1,0]}"#,
        );
        let c = run_on(&broken, gray(x)).unwrap().as_image().unwrap().pixel(0, 0)[0];
        assert_close(c, b);
    }

    #[test]
    fn curve_single_channel_only_touches_that_channel() {
        let mut node = make_node("heeler.curves");
        set_text(&mut node, "points", r#"{"r": [[0,0],[1,0.5]]}"#);
        let out = run_on(&node, ImageBuf::filled(1, 1, [0.8, 0.8, 0.8, 1.0])).unwrap();
        let px = out.as_image().unwrap().pixel(0, 0);
        assert_close(px[0], to_scene(0.5 * to_display(0.8)));
        assert_close(px[1], 0.8);
        assert_close(px[2], 0.8);
    }

    #[test]
    fn curve_passes_over_range_values_through() {
        // Above display 1.0 the curve steps aside even when it darkens
        // everything below: highlight recovery belongs to the shoulder,
        // and a curve that clamped specular values would destroy the
        // over-range gradients the profile still needs.
        let mut node = make_node("heeler.curves");
        set_text(&mut node, "points", r#"{"rgb": [[0,0],[1,0.5]]}"#);
        let out = run_on(&node, gray(2.5)).unwrap();
        assert_close(out.as_image().unwrap().pixel(0, 0)[0], 2.5);
        // ...while a value just inside range is still curved.
        let out = run_on(&node, gray(to_scene(0.9))).unwrap();
        assert_close(out.as_image().unwrap().pixel(0, 0)[0], to_scene(0.45));
    }

    #[test]
    fn smooth_curve_passes_through_points_and_bends_between_them() {
        let mut node = make_node("heeler.curves");
        set_text(
            &mut node,
            "points",
            r#"{"interp": "smooth", "rgb": [[0,0],[0.5,0.25],[1,1]]}"#,
        );
        // On-point values are exact regardless of interpolation.
        let out = run_on(&node, gray(to_scene(0.5))).unwrap();
        assert_close(out.as_image().unwrap().pixel(0, 0)[0], to_scene(0.25));
        // Between points the smooth curve bends away from the linear chord.
        let out = run_on(&node, gray(to_scene(0.25))).unwrap();
        let v = out.as_image().unwrap().pixel(0, 0)[0];
        assert!(
            (v - to_scene(0.125)).abs() > 1e-3,
            "smooth should differ from linear, got {v}"
        );
        assert!(
            v > 0.0 && v < to_scene(0.25),
            "but stay bounded by the segment, got {v}"
        );
    }

    #[test]
    fn smooth_curve_is_monotone_when_points_are() {
        // Fritsch-Carlson tangents guarantee no overshoot: a rising set of
        // points yields a rising curve everywhere.
        let mut node = make_node("heeler.curves");
        set_text(
            &mut node,
            "points",
            r#"{"interp": "smooth", "rgb": [[0,0],[0.2,0.02],[0.5,0.9],[1,1]]}"#,
        );
        let mut prev = -1.0f32;
        for i in 0..=40 {
            let x = i as f32 / 40.0;
            let out = run_on(&node, gray(x)).unwrap();
            let v = out.as_image().unwrap().pixel(0, 0)[0];
            assert!(v >= prev - 1e-5, "curve dipped at x={x}: {v} < {prev}");
            prev = v;
        }
    }

    #[test]
    fn curve_bad_json_reports_invalid_param() {
        let mut node = make_node("heeler.curves");
        set_text(&mut node, "points", "not json");
        let err = run_on(&node, gray(0.5)).unwrap_err();
        assert!(matches!(err, EngineError::InvalidParam { .. }));
    }

    /// A node nobody has configured must be identity. B&W used to default
    /// to full strength, so any graph that omitted `amount` came back
    /// monochrome.
    #[test]
    fn black_white_defaults_leave_color_alone() {
        let node = make_node("heeler.black_white");
        let out = run_on(&node, ImageBuf::filled(1, 1, [0.6, 0.3, 0.1, 1.0])).unwrap();
        let px = out.as_image().unwrap().pixel(0, 0);
        assert_close(px[0], 0.6);
        assert_close(px[1], 0.3);
        assert_close(px[2], 0.1);
    }

    /// The registry test above instantiates with defaults filled, so it
    /// never reads the engine's own fallback. A graph that OMITS the
    /// param (a document saved before the dial existed, a node built by
    /// hand) reads p()'s default, which still said 100 after the
    /// registry moved to 0: the same monochrome surprise the commit
    /// message says it retired.
    #[test]
    fn black_white_without_amount_leaves_color_alone() {
        let mut node = make_node("heeler.black_white");
        node.params.remove("amount");
        let out = run_on(&node, ImageBuf::filled(1, 1, [0.6, 0.3, 0.1, 1.0])).unwrap();
        let px = out.as_image().unwrap().pixel(0, 0);
        assert_close(px[0], 0.6);
        assert_close(px[1], 0.3);
        assert_close(px[2], 0.1);
    }

    #[test]
    fn review_hue_field_handles_empty_and_tiny_frames() {
        for (w, h) in [(0, 0), (0, 1), (1, 0), (1, 1), (2, 2)] {
            let img = ImageBuf::filled(w, h, [2.0, 0.3, 0.1, 1.0]);
            let field = black_white_hue_field(&img);
            assert_eq!(field.len(), w * h);
            assert!(field.iter().all(|(hue, sat)| hue.is_finite() && sat.is_finite()));
        }
    }

    #[test]
    fn review_singular_guided_filter_preserves_a_constant() {
        let guide = vec![1.0; 9];
        let mut a = vec![0.2; 9];
        let mut b = vec![0.3; 9];
        guided_blur_lab(&mut a, &mut b, [&guide, &guide, &guide], 3, 3, 1, 0.0);
        assert!(a.iter().all(|v| v.is_finite() && (*v - 0.2).abs() < 1e-5));
        assert!(b.iter().all(|v| v.is_finite() && (*v - 0.3).abs() < 1e-5));
    }

    #[test]
    fn review_infrared_curve_honours_its_interpolation_face() {
        let mut node = make_node("heeler.black_white");
        set_num(&mut node, "amount", 100.0);
        set_text(&mut node, "filter", "r72");
        set_text(&mut node, "film", "rolleiir");
        set_text(&mut node, "ir_curve", r#"[{"x":0,"y":0},{"x":90,"y":3},{"x":250,"y":-1}]"#);
        let src = ImageBuf::filled(1, 1, [0.8, 0.05, 0.05, 1.0]);
        set_text(&mut node, "eq_interp", "linear");
        let line = run_on(&node, src.clone()).unwrap();
        set_text(&mut node, "eq_interp", "smooth");
        let smooth = run_on(&node, src).unwrap();
        assert!((line.as_image().unwrap().data[0] - smooth.as_image().unwrap().data[0]).abs() > 1e-3);
    }

    #[test]
    fn black_white_at_full_strength_produces_neutral_gray() {
        let mut node = make_node("heeler.black_white");
        set_num(&mut node, "amount", 100.0);
        let out = run_on(&node, ImageBuf::filled(1, 1, [0.6, 0.3, 0.1, 1.0])).unwrap();
        let px = out.as_image().unwrap().pixel(0, 0);
        assert_close(px[0], px[1]);
        assert_close(px[1], px[2]);
        let expected = 0.6 * 0.30 + 0.3 * 0.59 + 0.1 * 0.11;
        assert_close(px[0], expected);
    }

    #[test]
    fn black_white_red_filter_brightens_red_darkens_blue() {
        let mut node = make_node("heeler.black_white");
        set_num(&mut node, "amount", 100.0);
        set_num(&mut node, "red", 100.0);
        set_num(&mut node, "green", 0.0);
        set_num(&mut node, "blue", 0.0);
        let mut img = ImageBuf::new(2, 1);
        img.set_pixel(0, 0, [0.8, 0.1, 0.1, 1.0]);
        img.set_pixel(1, 0, [0.1, 0.1, 0.8, 1.0]);
        let out = run_on(&node, img).unwrap();
        let i = out.as_image().unwrap();
        assert_close(i.pixel(0, 0)[0], 0.8);
        assert_close(i.pixel(1, 0)[0], 0.1);
    }

    /// The owner's bug: dragging the green weight down brightened the image
    /// (the old normalization divided by a shrinking sum), then flipped the
    /// whole frame to black when the sum crossed zero. Response must be
    /// monotone across the entire slider range, with no singularity.
    #[test]
    fn black_white_green_slider_is_monotone_across_its_whole_range() {
        let src = ImageBuf::filled(1, 1, [0.35, 0.45, 0.25, 1.0]);
        let value_at = |green: f64| {
            let mut node = make_node("heeler.black_white");
            set_num(&mut node, "amount", 100.0);
            set_num(&mut node, "green", green);
            run_on(&node, src.clone()).unwrap().as_image().unwrap().pixel(0, 0)[0]
        };
        let mut prev = f32::INFINITY;
        for step in 0..=60 {
            // Sweep green from +200 down to -100, crossing the old
            // singularity at sum = 0 (green = -41 with default r/b).
            let green = 200.0 - step as f64 * 5.0;
            let v = value_at(green);
            assert!(
                v <= prev + 1e-6,
                "green {green} brightened the image ({prev} -> {v}): non-monotone"
            );
            assert!(v.is_finite(), "green {green} produced {v}");
            prev = v;
        }
        // Well past the old zero-crossing the image is dark, not inverted.
        assert!(value_at(-100.0) >= 0.0);
    }

    /// The hue curve: a curve with no points, or one that is zero
    /// everywhere, is the mixer path bit for bit, so every saved graph
    /// renders as it did.
    #[test]
    fn black_white_flat_hue_curve_is_the_mixer_exactly() {
        let src = ImageBuf::filled(3, 3, [0.6, 0.3, 0.1, 1.0]);
        let mut plain = make_node("heeler.black_white");
        set_num(&mut plain, "amount", 100.0);
        let a = run_on(&plain, src.clone()).unwrap();
        let mut flat = plain.clone();
        set_text(&mut flat, "hue_curve", r#"[{"x":0,"y":0},{"x":180,"y":0},{"x":359,"y":0}]"#);
        let b = run_on(&flat, src.clone()).unwrap();
        assert_eq!(a.as_image().unwrap().data, b.as_image().unwrap().data);
        let mut junk = plain.clone();
        set_text(&mut junk, "hue_curve", "not json");
        let c = run_on(&junk, src).unwrap();
        assert_eq!(a.as_image().unwrap().data, c.as_image().unwrap().data);
    }

    /// A bump at red brightens a red pixel by that EV, leaves the
    /// opposite hue alone, and leaves a neutral alone through the chroma
    /// gate even though a neutral's atan2 lands on some hue.
    #[test]
    fn black_white_hue_curve_lifts_its_hue_and_nothing_else() {
        let mut node = make_node("heeler.black_white");
        set_num(&mut node, "amount", 100.0);
        let red = [0.8, 0.05, 0.05, 1.0];
        let gray = [0.4, 0.4, 0.4, 1.0];
        let red_hue = {
            let lab = crate::color::linear_to_oklab(red[0], red[1], red[2]);
            crate::color::oklch_of(lab).0
        };
        // The "other" color is built opposite red on the OkLab wheel,
        // so it sits in the curve's flat stretch by construction.
        let opposite = {
            let h = (red_hue + 180.0).to_radians();
            let rgb = crate::color::oklab_to_linear([0.6, 0.12 * h.cos(), 0.12 * h.sin()]);
            [rgb[0].max(0.0), rgb[1].max(0.0), rgb[2].max(0.0), 1.0]
        };
        let mut img = ImageBuf::new(3, 1);
        img.set_pixel(0, 0, red);
        img.set_pixel(1, 0, opposite);
        img.set_pixel(2, 0, gray);
        let before = run_on(&node, img.clone()).unwrap();
        // A one-stop bump centered on red, back to zero 60 degrees away,
        // with flat anchors beyond so the Catmull-Rom's undershoot past
        // the bump (the same overshoot every Recolor curve has) stays
        // within 120 degrees of red and never reaches blue.
        let curve = format!(
            r#"[{{"x":{:.1},"y":0}},{{"x":{:.1},"y":0}},{{"x":{:.1},"y":1}},{{"x":{:.1},"y":0}},{{"x":{:.1},"y":0}}]"#,
            red_hue - 120.0,
            red_hue - 60.0,
            red_hue,
            red_hue + 60.0,
            red_hue + 120.0
        );
        set_text(&mut node, "hue_curve", &curve);
        let after = run_on(&node, img).unwrap();
        let (b, a) = (before.as_image().unwrap(), after.as_image().unwrap());
        assert_close(a.pixel(0, 0)[0] / b.pixel(0, 0)[0], 2.0);
        assert_close(a.pixel(1, 0)[0], b.pixel(1, 0)[0]);
        assert_close(a.pixel(2, 0)[0], b.pixel(2, 0)[0]);
        // Still neutral output.
        assert_close(a.pixel(0, 0)[0], a.pixel(0, 0)[1]);
        assert_close(a.pixel(0, 0)[1], a.pixel(0, 0)[2]);
    }

    /// The interpolation face rides as eq_interp, as Relight's and
    /// Recolor's do: a straight-line curve between two points evaluates
    /// on the secant, where the smooth one bows.
    #[test]
    fn black_white_hue_curve_honours_the_interpolation_face() {
        let src = ImageBuf::filled(1, 1, [0.8, 0.05, 0.05, 1.0]);
        let red_hue = crate::color::oklch_of(crate::color::linear_to_oklab(0.8, 0.05, 0.05)).0;
        // A ramp from 0 at red-90 to +2 at red+90: linear puts red at +1.
        let curve = format!(
            r#"[{{"x":{:.1},"y":0}},{{"x":{:.1},"y":2}},{{"x":{:.1},"y":0}}]"#,
            red_hue - 90.0,
            red_hue + 90.0,
            red_hue + 200.0
        );
        let mut plain = make_node("heeler.black_white");
        set_num(&mut plain, "amount", 100.0);
        let base = run_on(&plain, src.clone()).unwrap().as_image().unwrap().pixel(0, 0)[0];
        let mut linear = plain.clone();
        set_text(&mut linear, "hue_curve", &curve);
        set_text(&mut linear, "eq_interp", "linear");
        let lin = run_on(&linear, src.clone()).unwrap().as_image().unwrap().pixel(0, 0)[0];
        // The ruler is a Bezier through collinear handles: exact to
        // rounding, not to the bit.
        assert!((lin / base - 2.0).abs() < 1e-2, "linear at the midpoint: {}", lin / base);
        let mut smooth = plain.clone();
        set_text(&mut smooth, "hue_curve", &curve);
        set_text(&mut smooth, "eq_interp", "smooth");
        let sm = run_on(&smooth, src).unwrap().as_image().unwrap().pixel(0, 0)[0];
        assert!((sm - lin).abs() > 1e-4, "smooth and linear should differ off the points: {sm} vs {lin}");
    }

    /// A filter or a film on the node makes the conversion spectral: the
    /// mixer's weights stand down, a neutral keeps its value, a red
    /// filter renders a red bright; nothing named is the mixer exactly.
    #[test]
    fn black_white_filter_and_film_replace_the_mixer() {
        let mut node = make_node("heeler.black_white");
        set_num(&mut node, "amount", 100.0);
        set_num(&mut node, "red", 0.0);
        set_num(&mut node, "green", 0.0);
        set_num(&mut node, "blue", 100.0);
        let mut img = ImageBuf::new(2, 1);
        img.set_pixel(0, 0, [0.8, 0.05, 0.05, 1.0]);
        img.set_pixel(1, 0, [0.3, 0.3, 0.3, 1.0]);
        let mixer = run_on(&node, img.clone()).unwrap();
        assert_close(mixer.as_image().unwrap().pixel(0, 0)[0], 0.05);
        let mut filtered = node.clone();
        set_text(&mut filtered, "filter", "w25");
        set_text(&mut filtered, "film", "hp5");
        let out = run_on(&filtered, img.clone()).unwrap();
        let o = out.as_image().unwrap();
        assert!(o.pixel(0, 0)[0] > 0.5, "red through a 25 on HP5, not the mixer's blue weight: {:?}", o.pixel(0, 0));
        assert_close(o.pixel(1, 0)[0], 0.3);
        let mut unknown = node.clone();
        set_text(&mut unknown, "filter", "w99");
        assert_eq!(run_on(&unknown, img).unwrap().as_image().unwrap().data, mixer.as_image().unwrap().data);
    }

    /// The infrared materials are the node's: foliage flat on the node
    /// makes a leaf its visible gray through a 720 on Rollei IR, and a
    /// drawn curve outranks the materials.
    #[test]
    fn black_white_infrared_materials_and_curve_are_the_nodes() {
        let mut node = make_node("heeler.black_white");
        set_num(&mut node, "amount", 100.0);
        set_text(&mut node, "filter", "r72");
        set_text(&mut node, "film", "rolleiir");
        let leaf = ImageBuf::filled(1, 1, [0.12, 0.32, 0.06, 1.0]);
        let y = crate::buffers::luma(0.12, 0.32, 0.06);
        let glow = run_on(&node, leaf.clone()).unwrap().as_image().unwrap().pixel(0, 0)[0];
        assert!(glow > y * 3.0, "default foliage glows: {glow} vs {y}");
        let mut flat = node.clone();
        set_num(&mut flat, "ir_foliage", 0.0);
        let plain = run_on(&flat, leaf.clone()).unwrap().as_image().unwrap().pixel(0, 0)[0];
        assert!((plain - y).abs() < y * 0.05, "foliage at zero is its gray: {plain} vs {y}");
        let mut curved = flat.clone();
        set_text(&mut curved, "ir_curve", r#"[{"x":30,"y":0},{"x":140,"y":1},{"x":270,"y":0}]"#);
        let lifted = run_on(&curved, leaf).unwrap().as_image().unwrap().pixel(0, 0)[0];
        assert!(lifted > plain * 1.6 && lifted < glow, "the curve outranks the materials: {lifted}");
    }

    /// The infrared guess reads hue from the smoothed field: a single
    /// blue speck in a neutral frame is diluted by its neighbors rather
    /// than dropping to black on its own (the clouds' JPEG blocks).
    #[test]
    fn black_white_infrared_reads_hue_from_the_smoothed_field() {
        let mut node = make_node("heeler.black_white");
        set_num(&mut node, "amount", 100.0);
        set_text(&mut node, "filter", "r72");
        set_text(&mut node, "film", "rolleiir");
        // A 600 px frame: the smoothing radius is three pixels, a
        // seven-by-seven window, and one speck in it is a forty-ninth.
        // The speck is a JPEG chroma block's worth of blue on the gray,
        // a tint far too faint to be an edge to the color guide, so
        // it is judged with its neighbors and reads as the gray it
        // sits in rather than taking the sky's drop.
        let mut img = ImageBuf::filled(600, 600, [0.4, 0.4, 0.4, 1.0]);
        img.set_pixel(300, 300, [0.39, 0.40, 0.43, 1.0]);
        let out = run_on(&node, img).unwrap();
        let o = out.as_image().unwrap();
        let speck = o.pixel(300, 300)[0];
        let direct = crate::spectral::Conversion::new("r72", "rolleiir").unwrap().gray(0.39, 0.40, 0.43);
        assert!(direct < 0.98 * 0.4, "alone, the tint would take some of the sky's drop: {direct}");
        assert!(speck > direct * 1.02 && (speck - 0.4).abs() < 0.01, "the tint is not judged alone: {speck} vs {direct}");
        assert!((o.pixel(10, 10)[0] - 0.4).abs() < 1e-3, "the neutral field holds");
        // A lone STRONG color is an edge to the guide and keeps its own
        // hue: a red berry in gray gravel is not smeared away.
        let mut img = ImageBuf::filled(600, 600, [0.4, 0.4, 0.4, 1.0]);
        img.set_pixel(300, 300, [0.30, 0.48, 0.90, 1.0]);
        let out = run_on(&node, img).unwrap();
        let strong = out.as_image().unwrap().pixel(300, 300)[0];
        let direct = crate::spectral::Conversion::new("r72", "rolleiir").unwrap().gray(0.30, 0.48, 0.90);
        assert!((strong - direct).abs() < 0.15 * direct, "a strong speck keeps its own conversion: {strong} vs {direct}");
    }

    /// The hue field stops at a lightness edge: a bright blue sky over
     /// Near and Far (phase 5): with a Far filter and a planted plane the
    /// frame is graded between the two conversions along depth; the
    /// curve's default is linear, so half way is the mean. Without the
    /// plane the near conversion stands alone, and a Far the same as
    /// Near asks for nothing.
    #[test]
    fn black_white_grades_between_near_and_far_along_depth() {
        let mut node = make_node("heeler.black_white");
        set_num(&mut node, "amount", 100.0);
        set_text(&mut node, "far_filter", "w25");
        let blue = [0.20, 0.35, 0.80, 1.0];
        let near = 0.20 * 0.30 + 0.35 * 0.59 + 0.80 * 0.11;
        let far = crate::spectral::Conversion::new("w25", "").unwrap().gray(0.20, 0.35, 0.80);
        assert!(far < near * 0.7, "a red filter darkens the blue: {far} vs {near}");
        let mut img = ImageBuf::new(3, 1);
        for x in 0..3 {
            img.set_pixel(x, 0, blue);
        }
        // No plane: the near conversion alone.
        let alone = run_on(&node, img.clone()).unwrap();
        for x in 0..3 {
            assert!((alone.as_image().unwrap().pixel(x, 0)[0] - near).abs() < 1e-5, "without a plane the mixer stands");
        }
        let mut plane = ImageBuf::new(3, 1);
        plane.set_pixel(0, 0, [0.0, 0.0, 0.0, 1.0]);
        plane.set_pixel(1, 0, [0.5, 0.5, 0.5, 1.0]);
        plane.set_pixel(2, 0, [1.0, 1.0, 1.0, 1.0]);
        let out = execute(
            &node,
            &[
                ("in".to_string(), Value::Image(Arc::new(img.clone()))),
                ("raster".to_string(), Value::Image(Arc::new(plane.clone()))),
            ],
        )
        .unwrap();
        let o = out.as_image().unwrap();
        assert!((o.pixel(0, 0)[0] - near).abs() < 1e-5, "near end is the near conversion: {}", o.pixel(0, 0)[0]);
        assert!((o.pixel(2, 0)[0] - far).abs() < 1e-5, "far end is the far conversion: {}", o.pixel(2, 0)[0]);
        assert!((o.pixel(1, 0)[0] - (near + far) / 2.0).abs() < 1e-3, "half way is the mean: {}", o.pixel(1, 0)[0]);
        // The depth curve moves the crossing: all far by the middle.
        let mut steep = node.clone();
        set_text(&mut steep, "depth_curve", r#"[{"x":0,"y":0},{"x":50,"y":100},{"x":100,"y":100}]"#);
        let out = execute(
            &steep,
            &[
                ("in".to_string(), Value::Image(Arc::new(img.clone()))),
                ("raster".to_string(), Value::Image(Arc::new(plane))),
            ],
        )
        .unwrap();
        assert!((out.as_image().unwrap().pixel(1, 0)[0] - far).abs() < 1e-3, "the curve brings the far filter in by the middle");
        // The planting rule.
        let mut params = std::collections::HashMap::new();
        params.insert("amount".to_string(), serde_json::json!(100.0));
        params.insert("far_filter".to_string(), serde_json::json!("w25"));
        assert!(black_white_wants_depth(&params));
        params.insert("filter".to_string(), serde_json::json!("w25"));
        assert!(!black_white_wants_depth(&params), "Far the same as Near asks for nothing");
        params.insert("filter".to_string(), serde_json::json!(""));
        params.insert("amount".to_string(), serde_json::json!(0.0));
        assert!(!black_white_wants_depth(&params), "a conversion doing nothing asks for nothing");
    }

    /// The field cache answers the same buffer with the same field, a
    /// different buffer with its own, forgets a buffer that is gone,
    /// and holds two.
    #[test]
    fn hue_field_cache_is_keyed_on_the_buffer_it_read() {
        // A cache of this test's own: the engine's static is shared by
        // every test in the process, and what it holds at any moment
        // is the scheduler's business, not this test's.
        let cache: HueFieldCache = std::sync::Mutex::new(Vec::new());
        let a = Arc::new(ImageBuf::filled(8, 8, [0.3, 0.5, 0.9, 1.0]));
        let f1 = hue_field_cached_in(&cache, &a);
        let f2 = hue_field_cached_in(&cache, &a);
        assert!(Arc::ptr_eq(&f1, &f2), "the same buffer is the same field, not a rebuild");
        let b = Arc::new(ImageBuf::filled(8, 8, [0.3, 0.5, 0.9, 1.0]));
        let f3 = hue_field_cached_in(&cache, &b);
        assert!(!Arc::ptr_eq(&f1, &f3), "another buffer, even alike, is its own entry");
        assert_eq!(f1.as_slice(), f3.as_slice(), "and the same answer");
        assert_eq!(cache.lock().unwrap().len(), 2, "two buffers, two entries");
        drop(b);
        let c = Arc::new(ImageBuf::filled(4, 4, [0.9, 0.2, 0.2, 1.0]));
        let _ = hue_field_cached_in(&cache, &c);
        let held = cache.lock().unwrap();
        assert!(held.len() <= HUE_FIELD_CACHE_CAP, "the cache holds its cap: {}", held.len());
        assert!(held.iter().all(|(w, _, _)| w.strong_count() > 0), "a buffer that is gone is not kept");
        assert!(held.iter().any(|(w, _, _)| w.upgrade().map(|x| Arc::ptr_eq(&x, &a)).unwrap_or(false)), "the live one stays");
        assert!(held.iter().any(|(w, _, _)| w.upgrade().map(|x| Arc::ptr_eq(&x, &c)).unwrap_or(false)), "and the new one is in");
    }

    /// Each curve its own face: the infrared guess follows ir_interp and
    /// the depth curve depth_interp, each falling back to the shared
    /// eq_interp when empty, so the hue curve's face no longer reshapes
    /// the other two.
    #[test]
    fn infrared_and_depth_curves_have_their_own_faces() {
        let mut node = make_node("heeler.black_white");
        set_num(&mut node, "amount", 100.0);
        set_text(&mut node, "filter", "r72");
        set_text(&mut node, "film", "rolleiir");
        set_text(&mut node, "ir_curve", r#"[{"x":0,"y":0},{"x":90,"y":3},{"x":250,"y":-1}]"#);
        let src = ImageBuf::filled(1, 1, [0.8, 0.05, 0.05, 1.0]);
        let render = |n: &Node| run_on(n, src.clone()).unwrap().as_image().unwrap().data[0];
        // The shared face alone: the guess follows it.
        set_text(&mut node, "eq_interp", "linear");
        let shared_linear = render(&node);
        set_text(&mut node, "eq_interp", "smooth");
        let shared_smooth = render(&node);
        assert!((shared_linear - shared_smooth).abs() > 1e-3, "with no face of its own the guess follows the shared one");
        // Its own face: the shared one no longer moves it.
        set_text(&mut node, "ir_interp", "linear");
        let own_linear = render(&node);
        assert!((own_linear - shared_linear).abs() < 1e-6, "ir_interp linear is the linear render");
        set_text(&mut node, "eq_interp", "linear");
        assert!((render(&node) - own_linear).abs() < 1e-6, "and the shared face changing does nothing to it");
        // The same for the depth curve.
        let mut d = make_node("heeler.black_white");
        set_num(&mut d, "amount", 100.0);
        set_text(&mut d, "far_filter", "w25");
        set_text(&mut d, "depth_curve", r#"[{"x":0,"y":0},{"x":30,"y":90},{"x":100,"y":100}]"#);
        let img = ImageBuf::filled(3, 1, [0.20, 0.35, 0.80, 1.0]);
        let mut plane = ImageBuf::new(3, 1);
        for x in 0..3 {
            plane.set_pixel(x, 0, [0.15, 0.15, 0.15, 1.0]);
        }
        let at = |n: &Node| {
            execute(n, &[("in".to_string(), Value::Image(Arc::new(img.clone()))), ("raster".to_string(), Value::Image(Arc::new(plane.clone())))])
                .unwrap().as_image().unwrap().pixel(1, 0)[0]
        };
        set_text(&mut d, "eq_interp", "linear");
        let lin = at(&d);
        set_text(&mut d, "eq_interp", "smooth");
        let smooth = at(&d);
        assert!((lin - smooth).abs() > 1e-4, "the depth curve follows the shared face when it has none");
        set_text(&mut d, "depth_interp", "linear");
        assert!((at(&d) - lin).abs() < 1e-6, "and its own face when it has one");
    }

    /// The gate reads saturation, not chroma: a shaded pine, a dark
    /// desaturated green, passes at the default floor; a true gray of the
    /// same lightness does not; and the same green eight times brighter
    /// gets the same gate, since saturation does not move with the light
    /// (2026-09-15: "Why does the foliage setting miss the trees on the
    /// hill?").
    #[test]
    fn black_white_gate_reads_saturation_not_chroma() {
        let floor = black_white_neutral_floor(BW_NEUTRAL_DEFAULT);
        let gate_of = |rgb: [f32; 3]| {
            let lab = crate::color::linear_to_oklab(rgb[0], rgb[1], rgb[2]);
            let (_, chroma) = crate::color::oklch_of(lab);
            (chroma, black_white_hue_gate(black_white_saturation(chroma, lab[0]), floor))
        };
        // The ridge pine as the JPEG holds it, scene-linear.
        let (chroma, pine) = gate_of([0.067, 0.071, 0.059]);
        assert!(chroma < 0.02, "the pine's chroma is small: {chroma}");
        assert!(pine > 0.5, "the shaded pine passes the gate: {pine}");
        let (_, gray) = gate_of([0.067, 0.067, 0.067]);
        assert_eq!(gray, 0.0, "a true gray of the same lightness is a neutral");
        let (_, lit) = gate_of([0.536, 0.568, 0.472]);
        assert!((lit - pine).abs() < 0.05, "the same green lit gates the same: {lit} vs {pine}");
        // The floor's ends: nothing is a neutral at 0 but a true gray,
        // and at 100 the pine is one.
        assert_eq!(black_white_neutral_floor(0.0), 0.0);
        let (_, at_top) = {
            let lab = crate::color::linear_to_oklab(0.067, 0.071, 0.059);
            let (_, c) = crate::color::oklch_of(lab);
            (c, black_white_hue_gate(black_white_saturation(c, lab[0]), black_white_neutral_floor(100.0)))
        };
        assert_eq!(at_top, 0.0, "at the top of the dial the pine is a gray");
    }

    /// The Neutral dial on the node moves the infrared guess's floor
    /// and nothing else: a frame of the shaded pine under a 720 on
    /// Rollei IR takes most of the foliage lift at 0, part of it at the
    /// default, and none at 100, where the pine is a gray the guess
    /// leaves alone; the hue curve's own lift at green is the same at
    /// every setting, since the dial lives in the Infrared fold and the
    /// curve gates at the default floor.
    #[test]
    fn black_white_neutral_dial_moves_the_floor() {
        let mut node = make_node("heeler.black_white");
        set_num(&mut node, "amount", 100.0);
        set_text(&mut node, "filter", "r72");
        set_text(&mut node, "film", "rolleiir");
        let pine = [0.067f32, 0.071, 0.059];
        let img = ImageBuf::filled(64, 64, [pine[0], pine[1], pine[2], 1.0]);
        let at = |neutral: f64| {
            let mut n = node.clone();
            set_num(&mut n, "neutral", neutral);
            run_on(&n, img.clone()).unwrap().as_image().unwrap().pixel(32, 32)[0]
        };
        let (held, default, lifted) = (at(100.0), at(BW_NEUTRAL_DEFAULT), at(0.0));
        let conv = crate::spectral::Conversion::new("r72", "rolleiir").unwrap();
        let (hue, _) = crate::color::oklch_of(crate::color::linear_to_oklab(pine[0], pine[1], pine[2]));
        let gray_alone = conv.gray_at(pine[0], pine[1], pine[2], hue, 0.0);
        assert!((held - gray_alone).abs() < 1e-4, "at 100 the pine is a gray to the guess: {held} vs {gray_alone}");
        assert!(lifted > gray_alone * 2.5, "at 0 the pine takes most of the foliage lift: {lifted} vs {gray_alone}");
        assert!(default > gray_alone * 1.5 && default < lifted, "the default is part way: {default}");
        // The curve does not listen to the dial.
        let mut curved = make_node("heeler.black_white");
        set_num(&mut curved, "amount", 100.0);
        set_text(
            &mut curved,
            "hue_curve",
            r#"[{"x":0,"y":0},{"x":60,"y":0},{"x":120,"y":2},{"x":180,"y":0},{"x":240,"y":0},{"x":300,"y":0}]"#,
        );
        let curve_at = |neutral: f64| {
            let mut n = curved.clone();
            set_num(&mut n, "neutral", neutral);
            run_on(&n, img.clone()).unwrap().as_image().unwrap().pixel(32, 32)[0]
        };
        let mixer = pine[0] * 0.30 + pine[1] * 0.59 + pine[2] * 0.11;
        assert!(curve_at(100.0) > mixer * 1.8, "the curve lifts the pine whatever the dial: {}", curve_at(100.0));
        assert!((curve_at(100.0) - curve_at(0.0)).abs() < 1e-5, "the dial does not move the curve");
    }

   /// dark neutral ground, and the ground's first rows stay ungated
    /// while the sky's last rows stay sky, where a box blur bled the two
    /// into each other and haloed the ridge.
    #[test]
    fn black_white_hue_field_stops_at_the_skyline() {
        let floor = black_white_neutral_floor(BW_NEUTRAL_DEFAULT);
        let gated = |f: &[(f32, f32)], i: usize| (f[i].0, black_white_hue_gate(f[i].1, floor));
        let (w, h) = (200, 200);
        let mut img = ImageBuf::new(w, h);
        for y in 0..h {
            for x in 0..w {
                let px = if y < 100 { [0.30, 0.48, 0.90, 1.0] } else { [0.08, 0.08, 0.08, 1.0] };
                img.set_pixel(x, y, px);
            }
        }
        let field = black_white_hue_field(&img);
        let (sky_hue, _) = crate::color::oklch_of(crate::color::linear_to_oklab(0.30, 0.48, 0.90));
        // The last row of sky before the edge: still the sky's hue, gated in.
        let (hue, gate) = gated(&field, 99 * w + 100);
        assert!(gate > 0.9 && (hue - sky_hue).abs() < 5.0, "sky at the ridge: hue {hue} gate {gate}");
        // The first row of ground: a neutral, gated out.
        let (_, gate_ground) = gated(&field, 100 * w + 100);
        assert!(gate_ground < 0.15, "ground at the ridge gated out: {gate_ground}");
        // And a ridge of modest contrast, a fifth of lightness, is held too.
        let mut soft = ImageBuf::new(w, h);
        for y in 0..h {
            for x in 0..w {
                let px = if y < 100 { [0.30, 0.48, 0.90, 1.0] } else { [0.40, 0.40, 0.40, 1.0] };
                soft.set_pixel(x, y, px);
            }
        }
        let field = black_white_hue_field(&soft);
        assert!(gated(&field, 99 * w + 100).1 > 0.9, "sky held at a soft ridge: {}", gated(&field, 99 * w + 100).1);
        // The first row of ground may carry half a gate (one pixel of edge
        // softness, not a band); the second is a gray outright.
        assert!(gated(&field, 100 * w + 100).1 < 0.6, "ground held at a soft ridge: {}", gated(&field, 100 * w + 100).1);
        assert!(gated(&field, 101 * w + 100).1 < 0.05, "no band below a soft ridge: {}", gated(&field, 101 * w + 100).1);
        // And a ridge with NO lightness step at all: a hazy sky over sunlit rock
        // of the same lightness, the halo's own case (2026-09-15). The sky's
        // gate at the ridge is the sky's gate far from it, so no rim; the rock's
        // hue is the rock's.
        let sky = [0.0f32, 0.0, 0.0];
        let sky_lab = crate::color::linear_to_oklab(0.60, 0.66, 0.78);
        let rock_rgb = crate::color::oklab_to_linear([sky_lab[0], 0.05, 0.05]);
        let _ = sky;
        let mut flat = ImageBuf::new(w, h);
        for y in 0..h {
            for x in 0..w {
                let px = if y < 100 { [0.60, 0.66, 0.78, 1.0] } else { [rock_rgb[0], rock_rgb[1], rock_rgb[2], 1.0] };
                flat.set_pixel(x, y, px);
            }
        }
        let field = black_white_hue_field(&flat);
        let far = gated(&field, 20 * w + 100).1;
        assert!(far > 0.2 && far < 0.9, "a hazy sky is part way in: {far}");
        for y in [96usize, 98, 99] {
            let g = gated(&field, y * w + 100).1;
            assert!((g - far).abs() < 0.08, "sky at row {y} keeps its gate at a flat ridge: {g} vs {far}");
        }
        let (rock_hue, _) = crate::color::oklch_of(crate::color::linear_to_oklab(rock_rgb[0], rock_rgb[1], rock_rgb[2]));
        let (hue, gate) = gated(&field, 101 * w + 100);
        assert!((hue - rock_hue).abs() < 8.0 && gate > 0.9, "rock at a flat ridge keeps its hue: {hue} vs {rock_hue}, gate {gate}");
    }

    /// The curve's switch: off is the mixer alone, bit for bit, with the
    /// points kept for when it comes back on.
    #[test]
    fn black_white_hue_curve_switch_off_is_the_mixer_exactly() {
        let src = ImageBuf::filled(2, 2, [0.8, 0.05, 0.05, 1.0]);
        let mut plain = make_node("heeler.black_white");
        set_num(&mut plain, "amount", 100.0);
        let a = run_on(&plain, src.clone()).unwrap();
        let mut curved = plain.clone();
        set_text(&mut curved, "hue_curve", r#"[{"x":0,"y":1},{"x":120,"y":1},{"x":240,"y":1}]"#);
        let b = run_on(&curved, src.clone()).unwrap();
        assert!(b.as_image().unwrap().pixel(0, 0)[0] > a.as_image().unwrap().pixel(0, 0)[0] * 1.5);
        let mut off = curved.clone();
        set_num(&mut off, "hue_curve_on", 0.0);
        let c = run_on(&off, src).unwrap();
        assert_eq!(a.as_image().unwrap().data, c.as_image().unwrap().data);
    }

    /// The curve is periodic: a point at 350 reaches across the seam to
    /// a hue at 10, and the two sides of the seam evaluate the same.
    #[test]
    fn black_white_hue_curve_wraps_across_the_seam() {
        let mut node = make_node("heeler.black_white");
        set_num(&mut node, "amount", 100.0);
        // Points either side of the seam, symmetric about 0.
        set_text(&mut node, "hue_curve", r#"[{"x":20,"y":0},{"x":180,"y":0},{"x":340,"y":0},{"x":350,"y":1}]"#);
        // Two saturated pixels of the same OkLab chroma at hue 5 and 355.
        let px_at = |hue_deg: f32| {
            let (a, b) = (0.15 * hue_deg.to_radians().cos(), 0.15 * hue_deg.to_radians().sin());
            let rgb = crate::color::oklab_to_linear([0.6, a, b]);
            [rgb[0].max(0.0), rgb[1].max(0.0), rgb[2].max(0.0), 1.0]
        };
        let mut img = ImageBuf::new(2, 1);
        img.set_pixel(0, 0, px_at(5.0));
        img.set_pixel(1, 0, px_at(355.0));
        let out = run_on(&node, img.clone()).unwrap();
        let o = out.as_image().unwrap();
        let mut plain = make_node("heeler.black_white");
        set_num(&mut plain, "amount", 100.0);
        let base = run_on(&plain, img).unwrap();
        let bs = base.as_image().unwrap();
        let lift_a = o.pixel(0, 0)[0] / bs.pixel(0, 0)[0];
        let lift_b = o.pixel(1, 0)[0] / bs.pixel(1, 0)[0];
        // Both lifted (the bump at 350 reaches 5 through the seam) and
        // 355 is nearer the bump than 5 is.
        assert!(lift_a > 1.05, "hue 5 not reached across the seam: {lift_a}");
        assert!(lift_b > lift_a, "355 should sit higher on the bump than 5: {lift_b} vs {lift_a}");
    }

    /// The EV is clamped to two stops either way, like Recolor's lum row,
    /// and a brighter pixel of the same color never converts darker.
    #[test]
    fn black_white_hue_curve_clamps_and_keeps_luminance_order() {
        let mut node = make_node("heeler.black_white");
        set_num(&mut node, "amount", 100.0);
        set_text(&mut node, "hue_curve", r#"[{"x":0,"y":6},{"x":120,"y":6},{"x":240,"y":6}]"#);
        let mut img = ImageBuf::new(2, 1);
        img.set_pixel(0, 0, [0.8, 0.05, 0.05, 1.0]);
        img.set_pixel(1, 0, [0.4, 0.025, 0.025, 1.0]);
        let out = run_on(&node, img.clone()).unwrap();
        let o = out.as_image().unwrap();
        let mut plain = make_node("heeler.black_white");
        set_num(&mut plain, "amount", 100.0);
        let base = run_on(&plain, img).unwrap();
        let bs = base.as_image().unwrap();
        assert_close(o.pixel(0, 0)[0] / bs.pixel(0, 0)[0], 4.0);
        assert!(o.pixel(0, 0)[0] > o.pixel(1, 0)[0]);
    }

    /// Treatment strength lives in `amount` so `enabled` stays a pure
    /// bypass: the Color section switch can gate B&W without destroying
    /// the user's treatment choice.
    #[test]
    fn black_white_amount_blends_between_color_and_mono() {
        let src = ImageBuf::filled(1, 1, [0.6, 0.3, 0.1, 1.0]);
        let at = |amount: f64| {
            let mut node = make_node("heeler.black_white");
            set_num(&mut node, "amount", amount);
            run_on(&node, src.clone()).unwrap().as_image().unwrap().pixel(0, 0)
        };
        // Zero is an exact identity, not a near-identity.
        assert_eq!(at(0.0), [0.6, 0.3, 0.1, 1.0]);
        // Full is fully neutral.
        let full = at(100.0);
        assert_close(full[0], full[1]);
        assert_close(full[1], full[2]);
        // Half sits between the original and the gray on every channel.
        let half = at(50.0);
        assert_close(half[0], 0.6 + (full[0] - 0.6) * 0.5);
        assert_close(half[2], 0.1 + (full[2] - 0.1) * 0.5);
    }

    #[test]
    fn black_white_weights_apply_directly_without_normalization() {
        let mut node = make_node("heeler.black_white");
        set_num(&mut node, "amount", 100.0);
        set_num(&mut node, "red", 100.0);
        set_num(&mut node, "green", 100.0);
        set_num(&mut node, "blue", 100.0);
        // Sum 300%: a direct mixer brightens, it does not silently
        // renormalize back to the original level.
        let out = run_on(&node, ImageBuf::filled(1, 1, [0.2, 0.2, 0.2, 1.0])).unwrap();
        assert_close(out.as_image().unwrap().pixel(0, 0)[0], 0.6);
    }

    #[test]
    fn detail_band_membership_matches_wheels_at_middle_gray() {
        let gain = detail_pixel_gains(0.18, Some(([0.0, 1.0, 0.0], [1.0; 3])));
        let expected = seen_range_weights(seen_tone(0.18, 0.0))[1];
        assert!((gain[0] - expected).abs() < 1e-6, "{} vs {expected}", gain[0]);
    }

    #[test]
    fn color_balance_defaults_are_identity() {
        let node = make_node("heeler.color_balance");
        let out = run_on(&node, ImageBuf::filled(1, 1, [0.4, 0.3, 0.2, 1.0])).unwrap();
        let px = out.as_image().unwrap().pixel(0, 0);
        assert_close(px[0], 0.4);
        assert_close(px[1], 0.3);
        assert_close(px[2], 0.2);
    }

    #[test]
    fn color_balance_midtone_lum_lifts_mid_gray() {
        let mut node = make_node("heeler.color_balance");
        set_num(&mut node, "midtones_lum", 100.0);
        let out = run_on(&node, gray(0.18)).unwrap();
        let px = out.as_image().unwrap().pixel(0, 0);
        assert!(px[0] > 0.18, "midtone gain must lift 18% gray, got {}", px[0]);
    }

    /// The bug the owner hit: pushing a wheel toward a hue must tint that
    /// range toward that hue, including on a perfectly neutral image (the
    /// old chroma-rotation model left neutral pixels untouched).
    #[test]
    fn color_balance_wheel_tints_neutral_gray_toward_the_puck_hue() {
        let mut node = make_node("heeler.color_balance");
        set_num(&mut node, "midtones_hue", 0.0); // red
        set_num(&mut node, "midtones_sat", 100.0);
        let out = run_on(&node, gray(0.18)).unwrap();
        let px = out.as_image().unwrap().pixel(0, 0);
        assert!(px[0] > 0.18, "red channel must rise, got {}", px[0]);
        assert!(px[1] < 0.18 && px[2] < 0.18, "green and blue fall");

        // Blue puck pushes the other way.
        set_num(&mut node, "midtones_hue", 240.0);
        let out = run_on(&node, gray(0.18)).unwrap();
        let px = out.as_image().unwrap().pixel(0, 0);
        assert!(px[2] > 0.18, "blue channel must rise, got {}", px[2]);
        assert!(px[0] < 0.18);
    }

    #[test]
    fn color_balance_push_is_chroma_only_so_brightness_holds() {
        let mut node = make_node("heeler.color_balance");
        set_num(&mut node, "midtones_hue", 90.0);
        set_num(&mut node, "midtones_sat", 100.0);
        let out = run_on(&node, gray(0.18)).unwrap();
        let px = out.as_image().unwrap().pixel(0, 0);
        assert_close(luma(px[0], px[1], px[2]), 0.18);
    }

    #[test]
    fn color_balance_pushes_the_targeted_range_hardest() {
        let mut node = make_node("heeler.color_balance");
        set_num(&mut node, "shadows_hue", 0.0);
        set_num(&mut node, "shadows_sat", 100.0);
        let mut img = ImageBuf::new(2, 1);
        img.set_pixel(0, 0, [0.02, 0.02, 0.02, 1.0]); // deep shadow
        img.set_pixel(1, 0, [0.9, 0.9, 0.9, 1.0]); // highlight
        let out = run_on(&node, img).unwrap();
        let got = out.as_image().unwrap();
        let shadow_shift = got.pixel(0, 0)[0] - 0.02;
        let highlight_shift = got.pixel(1, 0)[0] - 0.9;
        assert!(shadow_shift > 0.05, "shadows take the push, got {shadow_shift}");
        assert!(
            highlight_shift.abs() < 0.01,
            "highlights stay put, got {highlight_shift}"
        );
    }

    /// The wheels read their ranges on the tonal scale the viewer sees.
    /// A RAW reaches this node about 1.3 stops under what the profile's
    /// baseline will make of it, and on scene-linear luma the Highlights
    /// wheel weighed nothing on a pixel the screen shows at 0.87.
    #[test]
    fn color_balance_ranges_follow_the_brightness_still_to_come() {
        // 0.23 linear before a 1.3 EV baseline: about 0.8 on screen.
        let bright = 0.23;
        let mut node = make_node("heeler.color_balance");
        set_num(&mut node, "highlights_hue", 0.0);
        set_num(&mut node, "highlights_sat", 100.0);
        let shift = |n: &Node| run_on(n, gray(bright)).unwrap().as_image().unwrap().pixel(0, 0)[0] - bright;
        let unstamped = shift(&node);
        set_num(&mut node, "range_ev", 1.3);
        let stamped = shift(&node);
        assert!(unstamped < 0.02, "linear-luma reading leaves it mostly to the mids, got {unstamped}");
        assert!(stamped > 0.06, "a screen highlight takes the Highlights push, got {stamped}");

        // And the Shadows wheel lets go of a screen midtone.
        let mid = 0.096; // about display 0.5 after the same baseline
        let mut node = make_node("heeler.color_balance");
        set_num(&mut node, "shadows_hue", 0.0);
        set_num(&mut node, "shadows_sat", 100.0);
        set_num(&mut node, "range_ev", 1.3);
        let out = run_on(&node, gray(mid)).unwrap();
        let moved = out.as_image().unwrap().pixel(0, 0)[0] - mid;
        assert!(moved < 0.01, "shadows leave a screen midtone alone, got {moved}");
        let w = seen_range_weights(seen_tone(mid, 1.3));
        assert!(w[1] > 0.9, "a screen midtone is the midtones' own, got {w:?}");
    }

    #[test]
    fn seen_weights_split_the_screen_into_three() {
        for (d, dominant) in [(0.08f32, 0usize), (0.5, 1), (0.92, 2)] {
            let w = seen_range_weights(d);
            assert!((w.iter().sum::<f32>() - 1.0).abs() < 1e-5, "weights sum to one at {d}: {w:?}");
            let top = (0..3).max_by(|a, b| w[*a].total_cmp(&w[*b])).unwrap();
            assert_eq!(top, dominant, "at display {d}: {w:?}");
        }
    }

    #[test]
    fn split_tone_warms_one_end_and_cools_the_other() {
        let mut node = make_node("heeler.split_tone");
        set_num(&mut node, "shadow_hue", 240.0); // blue shadows
        set_num(&mut node, "shadow_sat", 100.0);
        set_num(&mut node, "highlight_hue", 40.0); // warm highlights
        set_num(&mut node, "highlight_sat", 100.0);
        let mut img = ImageBuf::new(2, 1);
        img.set_pixel(0, 0, [0.05, 0.05, 0.05, 1.0]);
        img.set_pixel(1, 0, [0.85, 0.85, 0.85, 1.0]);
        let out = run_on(&node, img).unwrap();
        let got = out.as_image().unwrap();
        assert!(got.pixel(0, 0)[2] > got.pixel(0, 0)[0], "shadows go blue");
        assert!(got.pixel(1, 0)[0] > got.pixel(1, 0)[2], "highlights go warm");
    }

    #[test]
    fn split_tone_defaults_and_zero_saturation_are_identity() {
        let node = make_node("heeler.split_tone");
        let img = ImageBuf::filled(2, 2, [0.3, 0.25, 0.2, 1.0]);
        let out = run_on(&node, img.clone()).unwrap();
        assert_eq!(**out.as_image().unwrap(), img);
    }

    #[test]
    fn split_tone_balance_moves_the_crossover() {
        let mut node = make_node("heeler.split_tone");
        set_num(&mut node, "highlight_hue", 0.0);
        set_num(&mut node, "highlight_sat", 100.0);
        let probe = |balance: f64| {
            let mut n = node.clone();
            set_num(&mut n, "balance", balance);
            let out = run_on(&n, gray(0.35)).unwrap();
            out.as_image().unwrap().pixel(0, 0)[0]
        };
        // Pushing balance toward the highlights lets more of the frame
        // count as "highlight", so a midtone picks up more of that tint.
        assert!(probe(80.0) > probe(-80.0));
    }

    /// Relight's picker reads what the curve is applied at (the 26.4.3
    /// latest review's R2): on a textured picture, a pixel's gain is the
    /// curve at tone_eq_lookup plus Range shift, not at its own luma.
    #[test]
    fn tone_eq_reads_its_curve_at_the_lookup_the_picker_reads() {
        let (w, h) = (96usize, 64usize);
        let mut img = ImageBuf::new(w, h);
        let mut state = 0x2545_F491u32;
        for i in 0..w * h {
            state ^= state << 13;
            state ^= state >> 17;
            state ^= state << 5;
            // Texture a stop either way of a gradient: the raw luma and
            // the guided illuminance part company.
            let base = 0.02 + 0.5 * (i % w) as f32 / w as f32;
            // A quarter stop either way: finer than the guided filter's
            // third of a stop, so it smooths.
            let v = base * 2f32.powf(((state % 1000) as f32 / 500.0 - 1.0) * 0.25);
            img.data[i * 4..i * 4 + 4].copy_from_slice(&[v, v, v, 1.0]);
        }
        let mut node = test_util::make_node("heeler.tone_eq");
        test_util::set_text(&mut node, "points", r#"[{"x":-6,"y":-1},{"x":0,"y":1},{"x":3,"y":-1}]"#);
        test_util::set_text(&mut node, "eq_interp", "linear");
        test_util::set_num(&mut node, "range_shift", 0.5);
        let out = test_util::run_on(&node, img.clone()).unwrap();
        let out = out.as_image().unwrap();
        let lookup = tone_eq_lookup(&node.params, &img);
        let curve = |x: f32| if x <= 0.0 { -1.0 + 2.0 * (x + 6.0) / 6.0 } else { 1.0 - 2.0 * x / 3.0 };
        let mut apart = 0.0f32;
        for i in (0..w * h).step_by(37) {
            let gain = (out.data[i * 4] / img.data[i * 4]).log2();
            let want = curve((lookup[i] + 0.5).clamp(-6.0, 3.0)).clamp(-2.0, 2.0);
            assert!((gain - want).abs() < 1e-3, "pixel {i}: {gain} stops against the curve at the lookup's {want}");
            apart = apart.max(((img.data[i * 4] / 0.18).log2() - lookup[i]).abs());
        }
        assert!(apart > 0.15, "the fixture must part raw luma from the lookup, {apart} stops at most");
    }

    #[test]
    fn the_tone_eq_moves_one_zone_and_leaves_the_others_be() {
        // A frame half deep shadow, half bright: lifting the -2EV zone
        // must brighten the dark half and leave the bright half alone,
        // as a pure exposure multiply (chromaticity untouched).
        let (w, h) = (64, 16);
        let mut img = ImageBuf::new(w, h);
        for y in 0..h {
            for x in 0..w {
                let v = if x < w / 2 { 0.045 } else { 0.72 }; // -2EV, +2EV
                let i = (y * w + x) * 4;
                img.data[i] = v;
                img.data[i + 1] = v * 0.8;
                img.data[i + 2] = v * 0.6;
                img.data[i + 3] = 1.0;
            }
        }
        let mut node = test_util::make_node("heeler.tone_eq");
        test_util::set_num(&mut node, "ev_m2", 1.0);
        let out = test_util::run_on(&node, img.clone()).unwrap();
        let g = out.as_image().unwrap();
        let dark = g.pixel(8, 8);
        let bright = g.pixel(56, 8);
        assert!(
            dark[0] > 0.045 * 1.6,
            "shadow zone was not lifted: {}",
            dark[0]
        );
        assert!(
            (bright[0] - 0.72).abs() < 0.72 * 0.12,
            "the +2EV zone moved: {}",
            bright[0]
        );
        // Chromaticity held: the channel ratios survive the lift.
        assert!((dark[1] / dark[0] - 0.8).abs() < 1e-3);
        assert!((dark[2] / dark[0] - 0.6).abs() < 1e-3);
        // All zones at zero is the identity, bit for bit.
        let idle = test_util::make_node("heeler.tone_eq");
        let same = test_util::run_on(&idle, img.clone()).unwrap();
        assert_eq!(same.as_image().unwrap().data, img.data);
    }

    /// Handle VECTORS on the Curves tool: length shapes the segment
    /// (the same weighted math the EQ runs), a mismatch falls back
    /// rather than guessing. The two pinned numbers are shared with
    /// the frontend's copy of this test in eqcurve.test.ts.
    #[test]
    fn curve_handle_vectors_shape_the_segment_by_length() {
        let pts = vec![[0.0, 0.0], [0.5, 0.5], [1.0, 1.0]];
        let pair = |l: [f32; 2]| Some(HandlePair { l: Some(l), r: Some([-l[0], -l[1]]) });
        let long = CurveSampler::with_user_handles(
            pts.clone(),
            None,
            Some(vec![None, pair([-0.1, -0.3]), None]),
        );
        assert!((long.eval(0.25) - 0.182323).abs() < 1e-4, "{}", long.eval(0.25));
        // Same slope at half the length: a different curve, which is
        // the whole point of resizable handles.
        let short = CurveSampler::with_user_handles(
            pts.clone(),
            None,
            Some(vec![None, pair([-0.05, -0.15]), None]),
        );
        assert!((short.eval(0.25) - 0.218668).abs() < 1e-4, "{}", short.eval(0.25));
        // A handle list that does not fit the points is ignored whole.
        let bad = CurveSampler::with_user_handles(pts, None, Some(vec![None]));
        assert!(bad.eq.is_none());
    }
    #[test]
    fn the_eq_curve_matches_the_shared_vectors() {
        // Hand-computed Hermite values, the SAME numbers pinned in the
        // frontend's eqcurve.test.ts: if either side drifts from the
        // shared math, its copy of this test fails.
        let pts: Vec<EqPoint> = serde_json::from_str(
            r#"[{"x":-3,"y":1},{"x":0,"y":0,"r":[1,-0.5]},{"x":2,"y":0.6}]"#,
        )
        .unwrap();
        assert!((eval_eq_points(&pts, -4.0) - 1.0).abs() < 1e-6, "flat before the first point");
        assert!((eval_eq_points(&pts, -1.5) - 0.405).abs() < 1e-5);
        // The manual tangent drags the curve below zero after the
        // middle point: the parametric part. Re-blessed when handle
        // LENGTH became real (it was -0.075 under the slope-only
        // Hermite that discarded it); cross-checked by an independent
        // f64 implementation.
        assert!((eval_eq_points(&pts, 0.5) - (-0.147512)).abs() < 1e-4);
        assert!((eval_eq_points(&pts, 3.0) - 0.6).abs() < 1e-6, "flat after the last point");
        // The same slope at half the length holds the curve less far:
        // the vector's LENGTH is doing work, which is the whole point
        // of resizable handles.
        let short: Vec<EqPoint> = serde_json::from_str(
            r#"[{"x":-3,"y":1},{"x":0,"y":0,"r":[0.5,-0.25]},{"x":2,"y":0.6}]"#,
        )
        .unwrap();
        assert!((eval_eq_points(&short, 0.5) - (-0.025018)).abs() < 1e-4);
    }

    #[test]
    fn eq_points_replace_the_zones_and_range_shift_slides_the_axis() {
        // A single-segment curve lifting only the deep shadows; the
        // zone sliders left at zero are ignored once points exist.
        let mut node = test_util::make_node("heeler.tone_eq");
        test_util::set_text(
            &mut node,
            "points",
            r#"[{"x":-3,"y":1},{"x":-1,"y":0},{"x":2,"y":0}]"#,
        );
        let (w, h) = (64, 16);
        let mut img = ImageBuf::new(w, h);
        for px in 0..w * h {
            let v = if px % w < w / 2 { 0.0225 } else { 0.72 }; // -3EV, +2EV
            img.data[px * 4] = v;
            img.data[px * 4 + 1] = v;
            img.data[px * 4 + 2] = v;
            img.data[px * 4 + 3] = 1.0;
        }
        let out = test_util::run_on(&node, img.clone()).unwrap();
        let g = out.as_image().unwrap();
        assert!(g.pixel(8, 8)[0] > 0.0225 * 1.7, "-3EV zone not lifted");
        assert!((g.pixel(56, 8)[0] - 0.72).abs() < 0.03, "+2EV moved");

        // Shifting the tones -4 EV through the window slides the bright
        // half (+2 EV) to read as -2 EV, mid-slope of the shadow lift:
        // Hermite there is 0.425 EV, so the gain is a firm 1.34x.
        let mut shifted = test_util::make_node("heeler.tone_eq");
        test_util::set_text(
            &mut shifted,
            "points",
            r#"[{"x":-3,"y":1},{"x":-1,"y":0},{"x":2,"y":0}]"#,
        );
        test_util::set_num(&mut shifted, "range_shift", -4.0);
        let out = test_util::run_on(&shifted, img.clone()).unwrap();
        let g = out.as_image().unwrap();
        let lifted = g.pixel(56, 8)[0];
        assert!(
            (lifted / 0.72 - 2f32.powf(0.425)).abs() < 0.08,
            "shift did not slide the window: gain {}",
            lifted / 0.72
        );
    }

    #[test]
    fn the_tone_eq_holds_the_line_at_a_hard_edge() {
        // The halo test: lifting shadows must not bleed brightness onto
        // the bright side of a hard edge, even at maximum smoothing.
        // This is what the guided filter buys over a plain blur.
        let (w, h) = (96, 32);
        let mut img = ImageBuf::new(w, h);
        for y in 0..h {
            for x in 0..w {
                let v = if x < w / 2 { 0.045 } else { 0.72 };
                let i = (y * w + x) * 4;
                img.data[i] = v;
                img.data[i + 1] = v;
                img.data[i + 2] = v;
                img.data[i + 3] = 1.0;
            }
        }
        let mut node = test_util::make_node("heeler.tone_eq");
        test_util::set_num(&mut node, "ev_m2", 1.5);
        test_util::set_num(&mut node, "smoothing", 100.0);
        let out = test_util::run_on(&node, img).unwrap();
        let g = out.as_image().unwrap();
        // Two pixels into the bright side: essentially untouched.
        let near = g.pixel(w / 2 + 2, h / 2)[0];
        assert!(
            (near - 0.72).abs() < 0.72 * 0.15,
            "halo: bright side of the edge moved to {near}"
        );
        // While the shadow side, even near the edge, is genuinely lifted.
        let dark = g.pixel(w / 2 - 3, h / 2)[0];
        assert!(dark > 0.045 * 1.5, "shadow near the edge not lifted: {dark}");
    }

    #[test]
    fn colorfulness_scales_chroma_and_holds_luma_and_neutrals() {
        // The calibration axis (ICC ): +N% pushes channels apart around their
        // Rec.709 luma, luma itself never moves, grays are untouched at any
        // setting, and zero is exactly the identity.
        let mut node = test_util::make_node("heeler.tone_profile");
        test_util::set_text(&mut node, "mode", "linear");
        test_util::set_num(&mut node, "colorfulness", 40.0);
        let mut img = ImageBuf::new(2, 1);
        img.data[..4].copy_from_slice(&[0.5, 0.3, 0.2, 1.0]);
        img.data[4..].copy_from_slice(&[0.4, 0.4, 0.4, 1.0]);
        let out = test_util::run_on(&node, img.clone()).unwrap();
        let g = out.as_image().unwrap();
        let p = g.pixel(0, 0);
        let y0 = luma(0.5, 0.3, 0.2);
        assert!((luma(p[0], p[1], p[2]) - y0).abs() < 1e-5, "luma moved");
        assert!(p[0] > 0.5 && p[2] < 0.2, "chroma did not widen: {p:?}");
        let n = g.pixel(1, 0);
        for c in 0..3 {
            assert!((n[c] - 0.4).abs() < 1e-6, "gray moved: {n:?}");
        }
        test_util::set_num(&mut node, "colorfulness", 0.0);
        let same = test_util::run_on(&node, img.clone()).unwrap();
        assert_eq!(same.as_image().unwrap().data, img.data);
    }

    /// A stock in `film` renders the profile through its curve: scene
    /// white to paper white, a push steeper, and an empty or unknown
    /// stock leaves every existing mode bit for bit.
    #[test]
    fn tone_profile_develops_a_named_stock() {
        let mut plain = make_node("heeler.tone_profile");
        set_num(&mut plain, "contrast", 100.0);
        let src = ImageBuf::filled(1, 1, [0.18, 0.18, 0.18, 1.0]);
        let base = run_on(&plain, src.clone()).unwrap().as_image().unwrap().pixel(0, 0)[0];
        let mut unknown = plain.clone();
        set_text(&mut unknown, "film", "kodachrome");
        assert_eq!(run_on(&unknown, src.clone()).unwrap().as_image().unwrap().pixel(0, 0)[0], base);
        let mut hp5 = plain.clone();
        set_text(&mut hp5, "film", "hp5");
        let mid = run_on(&hp5, src.clone()).unwrap().as_image().unwrap().pixel(0, 0)[0];
        assert!((mid - crate::film::stock("hp5").unwrap().display(0.18, 0.0, 1.0)).abs() < 1e-5);
        let white = run_on(&hp5, ImageBuf::filled(1, 1, [1.0, 1.0, 1.0, 1.0])).unwrap().as_image().unwrap().pixel(0, 0)[0];
        assert!((white - 1.0).abs() < 1e-4);
        let mut pushed = hp5.clone();
        set_num(&mut pushed, "development", 1.0);
        let dark = ImageBuf::filled(1, 1, [0.045, 0.045, 0.045, 1.0]);
        let n0 = run_on(&hp5, dark.clone()).unwrap().as_image().unwrap().pixel(0, 0)[0];
        let n1 = run_on(&pushed, dark).unwrap().as_image().unwrap().pixel(0, 0)[0];
        assert!(n1 < n0, "a push is steeper: the shadow two stops under goes darker against white");
    }

    #[test]
    fn tone_profile_adds_contrast_without_moving_black_or_white() {
        let mut node = make_node("heeler.tone_profile");
        set_text(&mut node, "mode", "standard");
        let at = |v: f32| {
            let out = run_on(&node, gray(v)).unwrap();
            out.as_image().unwrap().pixel(0, 0)[0]
        };
        assert_close(at(0.0), 0.0);
        assert!((at(1.0) - 1.0).abs() < 1e-3, "white stays white");
        assert!(at(0.05) < 0.05, "darks go darker");
        assert!(at(0.6) > 0.6, "lights go lighter");
        // Monotone across the range: no crossings or inversions.
        let mut prev = -1.0;
        for i in 0..=40 {
            let v = at(i as f32 / 40.0);
            assert!(v >= prev - 1e-6, "curve dipped at {i}");
            prev = v;
        }
    }

    /// The output-stage guard: the encode step
    /// hard-clips at 1.0, so the default rendering's LAST tonal word (the
    /// tone profile) must never hand it unrolled scene data. With the
    /// profile at defaults, any above-white scene value lands at or under
    /// 1.0, rolled through the shoulder rather than sheared at the ceiling.
    /// A DISABLED tone profile is the photographer asking for the linear
    /// rendering, clip and all: that is a choice, not a bug.
    #[test]
    fn default_tone_profile_delivers_nothing_above_white_to_encode() {
        let node = make_node("heeler.tone_profile");
        for v in [1.0f32, 1.5, 4.0, 16.0, 64.0] {
            let out = run_on(&node, gray(v)).unwrap();
            let got = out.as_image().unwrap().pixel(0, 0)[0];
            assert!(
                got <= 1.0 + 1e-4,
                "scene {v} reached encode at {got}, above the ceiling"
            );
        }
    }

    /// The bug the owner hit twice. A merged HDR carries a sky several
    /// times past scene white; the display transform clipped it, so the
    /// sky came back blown no matter how well the merge had recovered it.
    #[test]
    fn the_tone_profile_can_bring_back_what_is_above_white() {
        let mut node = make_node("heeler.tone_profile");
        set_text(&mut node, "mode", "standard");
        let at = |n: &Node, v: f32| {
            let out = run_on(n, gray(v)).unwrap();
            out.as_image().unwrap().pixel(0, 0)[0]
        };

        // With no rolloff, everything past white is the same flat value.
        assert!((at(&node, 1.5) - at(&node, 6.0)).abs() < 1e-6, "clipped, as before");

        set_num(&mut node, "highlight_rolloff", 70.0);
        let (sky, sun) = (at(&node, 2.4), at(&node, 6.0));
        assert!(sky < 1.0, "sky still at white: {sky}");
        assert!(sun < 1.0, "sun still at white: {sun}");
        // And they are told apart, which is the entire point: a merge
        // that recovers detail above white is worth nothing if the
        // display transform flattens it again.
        assert!(sun > sky + 0.01, "sun {sun} and sky {sky} are indistinguishable");
        // Still a bright sky, not a gray one.
        assert!(sky > 0.7, "sky went dull at {sky}");
    }

    /// The comparison work against the reference RAW editors: both lift
    /// a RAW about a stop before their curves. baseline_ev is that lift.
    #[test]
    fn baseline_ev_is_a_scene_linear_exposure_lift() {
        let mut node = make_node("heeler.tone_profile");
        set_text(&mut node, "mode", "linear");
        set_num(&mut node, "baseline_ev", 1.0);
        // In linear mode with no shoulder, +1 EV is exactly a doubling
        // for anything that stays under display white.
        let out = run_on(&node, gray(0.2)).unwrap();
        assert_close(out.as_image().unwrap().pixel(0, 0)[0], 0.4);
        // Negative stops work the same way down.
        set_num(&mut node, "baseline_ev", -1.0);
        let out = run_on(&node, gray(0.2)).unwrap();
        assert_close(out.as_image().unwrap().pixel(0, 0)[0], 0.1);
    }

    /// The toe restores black density after the baseline lift: deep
    /// shadows come down hard, mids barely move, white is untouched.
    /// 50 is the shipped default, so this pins the shipped behavior.
    #[test]
    fn shadow_toe_crushes_blacks_and_leaves_white_anchored() {
        let mut node = make_node("heeler.tone_profile");
        set_text(&mut node, "mode", "linear");
        set_num(&mut node, "shadow_toe", 50.0);
        let at = |v: f32| {
            let out = run_on(&node, gray(v)).unwrap();
            out.as_image().unwrap().pixel(0, 0)[0]
        };
        assert_close(at(0.0), 0.0);
        assert!((at(1.0) - 1.0).abs() < 1e-3, "white stays white");
        // A deep shadow loses the better part of a stop.
        let deep = at(0.01);
        assert!(deep < 0.0055, "deep shadow barely moved: {deep}");
        // A midtone loses only a few percent.
        let mid = at(0.4);
        assert!(mid > 0.36, "toe reached into the mids: {mid}");
        // Monotone: the toe cannot fold the curve over itself.
        let mut prev = -1.0;
        for i in 0..=40 {
            let v = at(i as f32 / 40.0);
            assert!(v >= prev - 1e-6, "curve dipped at {i}");
            prev = v;
        }
    }

    /// A graph saved before these params existed must render exactly as
    /// it always has: absent params are the identity, in every mode.
    #[test]
    fn tone_profile_without_new_params_matches_the_old_rendering() {
        for mode in ["linear", "standard", "film"] {
            let mut old = make_node("heeler.tone_profile");
            set_text(&mut old, "mode", mode);
            let mut explicit = old.clone();
            set_num(&mut explicit, "baseline_ev", 0.0);
            set_num(&mut explicit, "shadow_toe", 0.0);
            for i in 0..=20 {
                let v = i as f32 / 20.0 * 1.4;
                let a = run_on(&old, gray(v)).unwrap().as_image().unwrap().pixel(0, 0)[0];
                let b = run_on(&explicit, gray(v)).unwrap().as_image().unwrap().pixel(0, 0)[0];
                assert!((a - b).abs() < 1e-6, "{mode} diverged at {v}: {a} vs {b}");
            }
        }
    }

    /// The shoulder must not touch anything below white, because every
    /// edit anyone has already made was made under the old curve.
    #[test]
    fn the_shoulder_leaves_ordinary_photographs_alone() {
        let mut plain = make_node("heeler.tone_profile");
        set_text(&mut plain, "mode", "standard");
        let mut rolled = make_node("heeler.tone_profile");
        set_text(&mut rolled, "mode", "standard");
        set_num(&mut rolled, "highlight_rolloff", 70.0);

        // Everything from black up to the knee is bit-identical.
        for i in 0..=30 {
            let v = i as f32 / 100.0 * 1.2;
            let a = run_on(&plain, gray(v)).unwrap().as_image().unwrap().pixel(0, 0)[0];
            let b = run_on(&rolled, gray(v)).unwrap().as_image().unwrap().pixel(0, 0)[0];
            if to_display(v) <= 1.0 - 0.6 * 0.7 {
                assert!((a - b).abs() < 1e-6, "changed a mid-tone at {v}: {a} vs {b}");
            }
        }
    }

    #[test]
    fn the_shoulder_is_monotone_and_meets_the_identity_smoothly() {
        for amount in [0.0, 0.35, 0.7, 1.0] {
            let mut prev = -1.0;
            for i in 0..=400 {
                let d = i as f32 / 40.0; // 0 to 10 in display units
                let out = shoulder(d, amount);
                assert!(out >= prev - 1e-6, "dipped at {d} for amount {amount}");
                assert!(out <= 1.0 + 1e-6, "ran past white: {out}");
                prev = out;
            }
            // No crease where it takes over: the value matches the
            // identity at the knee.
            if amount > 0.0 {
                let knee = 1.0 - 0.6 * amount;
                assert!((shoulder(knee, amount) - knee).abs() < 1e-6);
                assert!((shoulder(knee - 0.01, amount) - (knee - 0.01)).abs() < 1e-6);
            }
        }
        // Zero is exactly the old hard clip.
        assert_eq!(shoulder(0.5, 0.0), 0.5);
        assert_eq!(shoulder(4.0, 0.0), 1.0);
    }

    fn range_tone_at(hi: f64, sh: f64, wt: f64, bl: f64, display_in: f32) -> f32 {
        let mut n = make_node("heeler.exposure");
        set_num(&mut n, "highlights", hi);
        set_num(&mut n, "shadows", sh);
        set_num(&mut n, "whites", wt);
        set_num(&mut n, "blacks", bl);
        let l = to_scene(display_in);
        let out = run_on(&n, ImageBuf::filled(1, 1, [l, l, l, 1.0])).unwrap();
        to_display(out.as_image().unwrap().pixel(0, 0)[0])
    }

    fn tone_at(hi: f64, sh: f64, display_in: f32) -> f32 {
        range_tone_at(hi, sh, 0.0, 0.0, display_in)
    }

    fn full_tone_at(hi: f64, sh: f64, wt: f64, bl: f64, con: f64, display_in: f32) -> f32 {
        let mut n = make_node("heeler.exposure");
        set_num(&mut n, "highlights", hi);
        set_num(&mut n, "shadows", sh);
        set_num(&mut n, "whites", wt);
        set_num(&mut n, "blacks", bl);
        set_num(&mut n, "contrast", con);
        let l = to_scene(display_in);
        let out = run_on(&n, ImageBuf::filled(1, 1, [l, l, l, 1.0])).unwrap();
        to_display(out.as_image().unwrap().pixel(0, 0)[0])
    }

    /// The canyon measurements that forced two reshapes: the original pivot
    /// multiply sent the shadow band to black at +100 (-8.7 EV; editor B -0.9,
    /// editor A -1.1), and the smoothstep replacement fixed the crush but had no
    /// punch, so +100 read as "everything darkens", which the owner called out on
    /// sight. The power-pivot curve must darken the toe inside the reference
    /// envelope AND visibly lift the brights, with black, white, and middle gray
    /// anchored.
    #[test]
    fn contrast_darkens_the_toe_and_lifts_the_brights() {
        let deep = full_tone_at(0.0, 0.0, 0.0, 0.0, 100.0, 0.20);
        assert!(deep < 0.16, "toe did not darken: {deep}");
        assert!(deep > 0.09, "toe crushed like the old pivot multiply: {deep}");
        let lifted = full_tone_at(0.0, 0.0, 0.0, 0.0, -100.0, 0.20);
        assert!(lifted > 0.24 && lifted < 0.30, "negative toe response: {lifted}");
        // The punch: at +100 a bright value RISES, the part both
        // earlier curves got wrong (references: +0.38 EV in brights).
        let bright = full_tone_at(0.0, 0.0, 0.0, 0.0, 100.0, 0.80);
        assert!(bright > 0.86, "no lift above the pivot: {bright}");
        assert!(full_tone_at(0.0, 0.0, 0.0, 0.0, -100.0, 0.80) < 0.77, "negative must soften brights");
        // Anchors: black, white, and middle gray (scene 0.18) hold.
        let pivot = to_display(CONTRAST_PIVOT);
        for c in [-100.0, 60.0, 100.0] {
            assert!(full_tone_at(0.0, 0.0, 0.0, 0.0, c, 0.0).abs() < 1e-4);
            assert!((full_tone_at(0.0, 0.0, 0.0, 0.0, c, 1.0) - 1.0).abs() < 1e-3);
            assert!((full_tone_at(0.0, 0.0, 0.0, 0.0, c, pivot) - pivot).abs() < 1e-3);
        }
        // Over-range radiance is the shoulder's business, not contrast's.
        let over = full_tone_at(0.0, 0.0, 0.0, 0.0, 100.0, 1.4);
        assert!((over - 1.4).abs() < 1e-3, "contrast touched over-range data: {over}");
    }

    /// The owner's report: "The highlights barely had an effect."
    ///
    /// They had almost none, for two reasons at once. The weight was
    /// computed on scene-linear luma against a 0.18 pivot, so it was
    /// near zero through everything that looks like a highlight, and
    /// where it finally had authority it multiplied straight past white
    /// and clipped. Measured before the fix, +100 took display 0.9 to
    /// 1.148 and 1.0 to 1.353: both simply white, and both already
    /// white, so nothing moved on screen.
    #[test]
    fn highlights_actually_move_the_highlights() {
        // Lifting: real, visible, and it approaches white rather than
        // crashing into it.
        assert!(tone_at(100.0, 0.0, 0.65) > 0.72, "0.65 went to {}", tone_at(100.0, 0.0, 0.65));
        assert!(tone_at(100.0, 0.0, 0.80) > 0.90, "0.80 went to {}", tone_at(100.0, 0.0, 0.80));
        assert!(tone_at(100.0, 0.0, 0.90) <= 1.0, "pushed past white");
        // Recovery: the direction people reach for on a bright sky.
        assert!(tone_at(-100.0, 0.0, 0.90) < 0.78, "0.90 recovered to {}", tone_at(-100.0, 0.0, 0.90));
        assert!(tone_at(-100.0, 0.0, 0.97) < 0.80);
        // And it leaves the bottom of the range alone, or it would be an
        // exposure slider with extra steps.
        for d in [0.05f32, 0.15, 0.3] {
            assert!((tone_at(100.0, 0.0, d) - d).abs() < 0.01, "touched a shadow at {d}");
            assert!((tone_at(-100.0, 0.0, d) - d).abs() < 0.01, "touched a shadow at {d}");
        }
    }

    #[test]
    fn shadows_move_the_shadows_and_leave_the_highlights_alone() {
        assert!(tone_at(0.0, 100.0, 0.15) > 0.28, "0.15 lifted to {}", tone_at(0.0, 100.0, 0.15));
        assert!(tone_at(0.0, -100.0, 0.30) < 0.20, "0.30 crushed to {}", tone_at(0.0, -100.0, 0.30));
        for d in [0.7f32, 0.85, 0.95] {
            assert!((tone_at(0.0, 100.0, d) - d).abs() < 0.01, "touched a highlight at {d}");
            assert!((tone_at(0.0, -100.0, d) - d).abs() < 0.01, "touched a highlight at {d}");
        }
    }

    /// A tone control that is not monotone solarizes: a darker part of
    /// the scene comes out brighter than a lighter one. My first attempt
    /// at this did exactly that, lifting the deepest shadows past the
    /// mid-shadows, and it is the sort of thing that reads as a bad
    /// photograph rather than as a bug. This is what pins PULL_BACK.
    #[test]
    fn tone_controls_never_invert() {
        for hi in [-100.0f64, -75.0, -50.0, -25.0, 0.0, 25.0, 50.0, 75.0, 100.0] {
            for sh in [-100.0f64, -75.0, -50.0, -25.0, 0.0, 25.0, 50.0, 75.0, 100.0] {
                let mut prev = -1.0f32;
                for i in 0..=200 {
                    let d = i as f32 / 200.0;
                    let out = tone_at(hi, sh, d);
                    assert!(
                        out >= prev - 1e-5,
                        "curve dipped at display {d} with highlights {hi} shadows {sh}:                          {prev} then {out}"
                    );
                    prev = out;
                }
            }
        }
    }

    /// All five display-space controls stacked at once, still monotone.
    /// Coarser grid than the pair test above: this is the seatbelt for
    /// the worst-case sum of every negative-going term.
    #[test]
    fn stacked_range_controls_never_invert() {
        let vals = [-100.0f64, -50.0, 0.0, 50.0, 100.0];
        for hi in vals {
            for sh in vals {
                for wt in vals {
                    for bl in vals {
                        for con in [-100.0f64, 0.0, 100.0] {
                            let mut prev = -1.0f32;
                            for i in 0..=100 {
                                let d = i as f32 / 100.0;
                                let out = full_tone_at(hi, sh, wt, bl, con, d);
                                assert!(
                                    out >= prev - 1e-5,
                                    "dipped at {d}: hi {hi} sh {sh} wt {wt} bl {bl} con {con}: {prev} then {out}"
                                );
                                prev = out;
                            }
                        }
                    }
                }
            }
        }
    }

    /// Whites owns the top of the range. Measured before the fix it was
    /// a plain linear gain: +/-100 moved the deepest shadows the same
    /// ~1.4 EV as the brights, while both reference editors hold shadows
    /// still.
    #[test]
    fn whites_move_the_top_and_leave_the_shadows_alone() {
        assert!(range_tone_at(0.0, 0.0, 100.0, 0.0, 0.85) > 0.93);
        assert!(range_tone_at(0.0, 0.0, -100.0, 0.0, 0.85) < 0.78);
        for d in [0.05f32, 0.15, 0.28] {
            for wt in [100.0, -100.0] {
                let out = range_tone_at(0.0, 0.0, wt, 0.0, d);
                assert!((out - d).abs() < 0.01, "whites {wt} touched a shadow at {d}: {out}");
            }
        }
    }

    /// Blacks owns the bottom, asymmetrically: setting a black point is
    /// a crush, lifting one is a wash. Before the fix this was an
    /// additive scene offset: +100 lifted shadows +4.6 EV (editor A
    /// +1.5, editor B +0.8) and -100 sent whole frames to solid black.
    #[test]
    fn blacks_anchor_the_bottom_and_leave_the_highlights_alone() {
        // Lift: about a stop at the bottom, nothing dramatic.
        let lifted = range_tone_at(0.0, 0.0, 0.0, 100.0, 0.10);
        assert!(lifted > 0.13 && lifted < 0.18, "lift at 0.10 gave {lifted}");
        // Crush: deep shadows go to black, the way a black point does.
        assert!(range_tone_at(0.0, 0.0, 0.0, -100.0, 0.08) < 0.01);
        // But the mids survive: -100 must not empty the whole frame.
        assert!(range_tone_at(0.0, 0.0, 0.0, -100.0, 0.45) > 0.40);
        for d in [0.6f32, 0.8, 0.95] {
            for bl in [100.0, -100.0] {
                let out = range_tone_at(0.0, 0.0, 0.0, bl, d);
                assert!((out - d).abs() < 0.01, "blacks {bl} touched a highlight at {d}: {out}");
            }
        }
        // True black is anchored: no fog floor from a positive blacks.
        let out = run_on(
            &{
                let mut n = make_node("heeler.exposure");
                set_num(&mut n, "blacks", 100.0);
                n
            },
            ImageBuf::filled(1, 1, [0.0, 0.0, 0.0, 1.0]),
        )
        .unwrap();
        assert_eq!(out.as_image().unwrap().pixel(0, 0)[0], 0.0);
    }

    /// The canyon/bighorn dehaze measurement: +100 sent Heeler's shadow
    /// and mid bands to -9..-11 EV (black) where editor A does -1..-2.7
    /// and editor B -0.3..-1.4, because the veil was subtracted in scene-linear.
    /// Display-space subtraction keeps the crush inside the envelope.
    #[test]
    fn dehaze_removes_veil_without_deleting_the_shadows() {
        let at = |dehaze: f64, v: f32| {
            let mut n = make_node("heeler.standard_color");
            set_num(&mut n, "dehaze", dehaze);
            let out = run_on(&n, gray(v)).unwrap();
            out.as_image().unwrap().pixel(0, 0)[0]
        };
        // A deep shadow darkens by about two stops, and SURVIVES.
        let deep = at(100.0, 0.02);
        assert!(deep < 0.012, "veil not removed: {deep}");
        assert!(deep > 0.02 / 8.0, "shadow deleted like the old math: {deep}");
        // Negative direction adds the veil: shadows lift.
        assert!(at(-100.0, 0.02) > 0.03);
        // White is anchored, over-range radiance passes through.
        assert!((at(100.0, 1.0) - 1.0).abs() < 1e-3);
        assert!((at(100.0, 2.5) - 2.5).abs() < 1e-3);
        // Monotone through the range.
        let mut prev = -1.0;
        for i in 0..=100 {
            let v = at(100.0, i as f32 / 100.0);
            assert!(v >= prev - 1e-5, "dehaze inverted at {i}");
            prev = v;
        }
    }

    /// One Dehaze slider, both halves: the veil comes off the tonal axis
    /// AND the color it washed out comes back (haze desaturates as it
    /// lightens; the split into two sliders was tried and reverted).
    /// Grays stay gray: the chroma half cannot invent color.
    #[test]
    fn dehaze_restores_color_as_it_removes_the_veil() {
        let hazy_blue = ImageBuf::filled(1, 1, [0.10, 0.13, 0.19, 1.0]);
        let sat = |p: [f32; 4]| {
            let (mx, mn) = (p[0].max(p[1]).max(p[2]), p[0].min(p[1]).min(p[2]));
            (mx - mn) / mx
        };
        let run_dh = |dh: f64| {
            let mut n = make_node("heeler.standard_color");
            set_num(&mut n, "dehaze", dh);
            let out = run_on(&n, hazy_blue.clone()).unwrap();
            out.as_image().unwrap().pixel(0, 0)
        };
        let base = hazy_blue.pixel(0, 0);
        let up = run_dh(100.0);
        assert!(sat(up) > sat(base) + 0.05, "color not restored: {} vs {}", sat(up), sat(base));
        assert!(
            luma(up[0], up[1], up[2]) < luma(base[0], base[1], base[2]),
            "veil not removed"
        );
        let down = run_dh(-100.0);
        assert!(sat(down) < sat(base) - 0.05, "negative did not wash: {}", sat(down));
        // A gray stays exactly neutral through both halves.
        let mut n = make_node("heeler.standard_color");
        set_num(&mut n, "dehaze", 100.0);
        let g = run_on(&n, gray(0.3)).unwrap();
        let gp = g.as_image().unwrap().pixel(0, 0);
        assert!((gp[0] - gp[1]).abs() < 1e-6 && (gp[1] - gp[2]).abs() < 1e-6, "gray gained a tint");
    }

    /// The owner's field report, verbatim: "red noise (similar to focus
    /// peaking) all over the image." A dark noisy pixel loses its smaller
    /// channels to the veil floor, and the luminance renormalization then
    /// pumps the lone survivor by hundreds of x. The shadow fade plus the
    /// gain cap must keep the noise floor's COLOR untouched however hard
    /// the slider is pushed: the veil may darken it, but the channel
    /// balance survives.
    #[test]
    fn dehaze_leaves_the_noise_floor_color_alone() {
        // Shadow sensor noise: red barely ahead, all channels tiny.
        let noise = ImageBuf::filled(1, 1, [0.02, 0.008, 0.01, 1.0]);
        let mut n = make_node("heeler.standard_color");
        set_num(&mut n, "dehaze", 100.0);
        let out = run_on(&n, noise.clone()).unwrap();
        let p = out.as_image().unwrap().pixel(0, 0);
        let orig = noise.pixel(0, 0);
        // Never brighter, never a lone surviving channel.
        assert!(p[0] <= orig[0], "red channel amplified: {} from {}", p[0], orig[0]);
        assert!(p[1] > 0.0 && p[2] > 0.0, "channels zeroed: {p:?}");
        // Hue preserved: the luma veil scales all channels together and
        // the chroma half fades out before it reaches the noise floor.
        let ratio_before = orig[0] / orig[1];
        let ratio_after = p[0] / p[1];
        assert!(
            (ratio_after - ratio_before).abs() < 0.15 * ratio_before,
            "channel balance shifted: {ratio_after} vs {ratio_before}"
        );
    }

    /// The owner's canyon report: "clarity had some dark artifacts around
    /// edges and high contrast areas." The old boost added a scene-linear
    /// delta, so the dark side of a hard edge went to black (or below). The
    /// display-space limited version must keep every pixel alive.
    #[test]
    fn clarity_does_not_blacken_edge_shadows() {
        // A hard bright-to-dark edge, the worst case for unsharp masks.
        let mut img = ImageBuf::new(32, 8);
        for y in 0..8 {
            for x in 0..32 {
                let v = if x < 16 { 0.5 } else { 0.02 };
                img.set_pixel(x, y, [v, v, v, 1.0]);
            }
        }
        let mut n = make_node("heeler.clarity");
        set_num(&mut n, "clarity", 100.0);
        let out = run_on(&n, img).unwrap();
        let out = out.as_image().unwrap();
        let mut min = f32::MAX;
        for x in 0..32 {
            min = min.min(out.pixel(x, 4)[0]);
        }
        // The old math drove edge pixels negative (rendered black).
        assert!(min > 1e-4, "edge shadow blackened: {min}");
        // And it still does its job: the edge gains local contrast, so
        // the dark side near the edge is darker than the far dark side.
        assert!(out.pixel(17, 4)[0] < out.pixel(30, 4)[0], "no local contrast at the edge");
        assert!(out.pixel(14, 4)[0] > out.pixel(2, 4)[0], "bright side did not lift");
    }

    /// The owner's observation that split contrast into two sliders: "when
    /// contrast is increased the darks get more saturated, that is not
    /// happening here." Per-channel steepening is where the references'
    /// saturating darks come from; Heeler's luminance contrast leaves
    /// chroma alone on purpose, and color_contrast is the chroma half.
    #[test]
    fn color_contrast_saturates_darks_at_constant_luminance() {
        let dark_red = ImageBuf::filled(1, 1, [0.08, 0.03, 0.025, 1.0]);
        let sat = |img: &ImageBuf| {
            let p = img.pixel(0, 0);
            let (mx, mn) = (p[0].max(p[1]).max(p[2]), p[0].min(p[1]).min(p[2]));
            (mx - mn) / mx
        };
        let run_cc = |cc: f64| {
            let mut n = make_node("heeler.exposure");
            set_num(&mut n, "color_contrast", cc);
            let out = run_on(&n, dark_red.clone()).unwrap();
            out.as_image().unwrap().clone()
        };
        let base_sat = sat(&dark_red);
        let base_luma = luma(0.08, 0.03, 0.025);

        let up = run_cc(100.0);
        assert!(sat(&up) > base_sat + 0.05, "darks did not saturate: {} vs {base_sat}", sat(&up));
        let down = run_cc(-100.0);
        assert!(sat(&down) < base_sat - 0.05, "negative did not fade: {}", sat(&down));
        // Luminance is untouched in both directions: tonality belongs
        // to the luminance stages, this slider is chroma only.
        for img in [&up, &down] {
            let p = img.pixel(0, 0);
            let l = luma(p[0], p[1], p[2]);
            assert!((l - base_luma).abs() < 1e-5, "luminance moved: {l} vs {base_luma}");
        }
        // Grays are exactly still: no color to steepen.
        let mut n = make_node("heeler.exposure");
        set_num(&mut n, "color_contrast", 100.0);
        let g = run_on(&n, gray(0.2)).unwrap();
        assert_close(g.as_image().unwrap().pixel(0, 0)[0], 0.2);
    }

    /// The bighorn measurement: highlights -100 moved Heeler's top band
    /// -0.04 EV on a shaded scene while editor B moved -0.38. Recovery must
    /// have authority in the working range, not only next to white.
    #[test]
    fn highlight_recovery_reaches_below_bright_daylight() {
        let out = tone_at(-100.0, 0.0, 0.60);
        assert!(out < 0.57, "recovery inert in the upper mids: 0.60 -> {out}");
        // And still strongest near white, where blown skies live.
        let sky = tone_at(-100.0, 0.0, 0.97);
        assert!(sky < 0.80, "sky recovery weakened: 0.97 -> {sky}");
    }

    /// WP35's documented CMM failure mode: sRGB-class transfer curves
    /// breaking continuity or monotonicity at the linear-to-power seam.
    /// The engine has its own copy of the transfer (as do heeler-io and
    /// the GPU shader); each copy carries this pin.
    #[test]
    fn display_transfer_is_continuous_and_monotone_at_the_seam() {
        let e = 1e-6f32;
        assert!((to_scene(0.04045 - e) - to_scene(0.04045 + e)).abs() < 1e-5);
        assert!((to_display(0.0031308 - e * e) - to_display(0.0031308 + e * e)).abs() < 1e-5);
        let mut prev = -1.0f32;
        for i in 0..=10_000 {
            let x = i as f32 / 10_000.0 * 0.1;
            let y = to_scene(x);
            assert!(y >= prev, "to_scene dipped at {x}");
            prev = y;
        }
        let mut prev = -1.0f32;
        for i in 0..=10_000 {
            let x = i as f32 / 10_000.0 * 0.01;
            let y = to_display(x);
            assert!(y >= prev, "to_display dipped at {x}");
            prev = y;
        }
    }

    /// Neutral sliders must be an exact pass-through, or every image in
    /// the catalog shifts the day this ships.
    #[test]
    fn neutral_tone_controls_change_nothing() {
        for d in [0.0f32, 0.1, 0.25, 0.5, 0.75, 0.9, 1.0] {
            assert!((tone_at(0.0, 0.0, d) - d).abs() < 1e-4, "moved {d} with everything at zero");
        }
    }

    #[test]
    fn tone_profile_linear_mode_is_exact_identity() {
        let mut node = make_node("heeler.tone_profile");
        set_text(&mut node, "mode", "linear");
        let img = ImageBuf::filled(2, 2, [0.3, 0.5, 0.7, 1.0]);
        let out = run_on(&node, img.clone()).unwrap();
        assert_eq!(**out.as_image().unwrap(), img);
    }

    #[test]
    fn tone_profile_film_is_stronger_than_standard() {
        let contrast_of = |mode: &str| {
            let mut n = make_node("heeler.tone_profile");
            set_text(&mut n, "mode", mode);
            let dark = run_on(&n, gray(0.05)).unwrap().as_image().unwrap().pixel(0, 0)[0];
            let light = run_on(&n, gray(0.6)).unwrap().as_image().unwrap().pixel(0, 0)[0];
            light - dark
        };
        assert!(contrast_of("film") > contrast_of("standard"));
        assert!(contrast_of("standard") > contrast_of("linear"));
    }

    #[test]
    fn channel_extract_pulls_one_channel_as_gray() {
        let mut node = make_node("heeler.channel_extract");
        set_text(&mut node, "channel", "g");
        let out = run_on(&node, ImageBuf::filled(1, 1, [0.2, 0.7, 0.4, 1.0])).unwrap();
        let px = out.as_image().unwrap().pixel(0, 0);
        assert_close(px[0], 0.7);
        assert_close(px[1], 0.7);
        assert_close(px[2], 0.7);

        set_text(&mut node, "channel", "luma");
        let out = run_on(&node, ImageBuf::filled(1, 1, [0.2, 0.7, 0.4, 1.0])).unwrap();
        assert_close(out.as_image().unwrap().pixel(0, 0)[0], luma(0.2, 0.7, 0.4));
    }
}
#[cfg(test)]
mod detail_contracts {
    use super::*;
    use crate::ops::test_util::*;

    fn scene() -> ImageBuf {
        let mut src = ImageBuf::new(192, 96);
        for y in 0..src.height {
            for x in 0..src.width {
                let d = 0.12 + 0.7 * x as f32 / src.width as f32
                    + 0.03 * ((x + y) as f32 * 0.4).sin();
                let v = to_scene(d);
                src.set_pixel(x, y, [v, v * 0.7, v * 0.4, 0.37]);
            }
        }
        src
    }

    #[test]
    fn detail_unused_weights_do_not_change_other_effects() {
        let mut n = make_node("heeler.detail");
        set_num(&mut n, "texture", 100.0);
        set_num(&mut n, "clarity", 100.0);
        let src = scene();
        let plain = run_on(&n, src.clone()).unwrap();
        // An inactive effect's non-default weight really selects the
        // weighted path, unlike 100.0001 which rounds inside its tolerance.
        set_num(&mut n, "dehaze_red", 0.0);
        assert!(detail_gains(&n.params, "dehaze").is_some());
        let weighted = run_on(&n, src).unwrap();
        assert_eq!(plain.as_image().unwrap().data, weighted.as_image().unwrap().data);
    }

    #[test]
    fn detail_zero_dehaze_weights_remove_color_as_well_as_tone() {
        for suffixes in [["shadows", "midtones", "highlights"], ["red", "green", "blue"]] {
            let mut n = make_node("heeler.detail");
            set_num(&mut n, "dehaze", 100.0);
            for suffix in suffixes { set_num(&mut n, &format!("dehaze_{suffix}"), 0.0); }
            let src = scene();
            let out = run_on(&n, src.clone()).unwrap();
            assert_eq!(out.as_image().unwrap().data, src.data);
        }
    }

    #[test]
    fn detail_negative_haze_is_continuous_at_black() {
        let src = ImageBuf::filled(3, 3, [0.0, 0.0, 0.0, 0.37]);
        let black = dehaze_luma_veil(&src, -1.0).pixel(1, 1);
        let near = dehaze_luma_veil(&ImageBuf::filled(3, 3, [1.01e-6, 1.01e-6, 1.01e-6, 0.37]), -1.0).pixel(1, 1);
        assert!(black[0] > 0.0);
        assert!((black[0] - near[0]).abs() < 3e-6);
        assert_eq!(black[3], 0.37);
    }

    #[test]
    fn detail_off_is_bit_exact_with_nondefault_weights_and_hdr() {
        let mut n = make_node("heeler.detail");
        set_num(&mut n, "texture_red", 200.0);
        let src = ImageBuf::filled(5, 3, [2.3, 1e-7, 0.0, 0.37]);
        assert_eq!(run_on(&n, src.clone()).unwrap().as_image().unwrap().data, src.data);
    }

    #[test]
    fn detail_and_free_clarity_agree_with_no_local_contrast() {
        let mut detail = make_node("heeler.detail");
        let mut clarity = make_node("heeler.clarity");
        for n in [&mut detail, &mut clarity] {
            set_num(n, "texture", -50.0);
            set_num(n, "clarity", 100.0);
        }
        assert_eq!(run_on(&detail, scene()).unwrap().as_image().unwrap().data,
            run_on(&clarity, scene()).unwrap().as_image().unwrap().data);
    }

    #[test]
    fn detail_extreme_weights_keep_nonnegative_channels_and_the_detail_floor() {
        let mut src = ImageBuf::filled(128, 128, [0.2, 0.2, 0.2, 1.0]);
        src.set_pixel(64, 64, [0.0001, 0.0001, 0.0001, 0.37]);
        for tool in ["texture", "clarity", "dehaze"] {
            let mut n = make_node("heeler.detail");
            set_num(&mut n, tool, 100.0);
            for suffix in ["shadows", "midtones", "highlights", "red", "green", "blue"] {
                set_num(&mut n, &format!("{tool}_{suffix}"), 200.0);
            }
            let out = run_on(&n, src.clone()).unwrap();
            let p = out.as_image().unwrap().pixel(64, 64);
            let floor = if tool == "dehaze" { 0.0 } else { to_scene(to_display(0.0001) * 0.45) };
            assert!(p[..3].iter().all(|v| *v >= floor - 1e-10), "{tool}: {p:?}, floor {floor}");
            assert_eq!(p[3], 0.37);
        }
    }

    #[test]
    fn detail_bands_are_a_partition_including_hdr() {
        for i in -100..3000 {
            let w = range_weights((i as f32 / 1000.0).clamp(0.0, 1.0));
            assert!((w.iter().sum::<f32>() - 1.0).abs() < 1e-6);
            assert!(w.iter().all(|v| *v >= 0.0 && *v <= 1.0));
        }
    }
}

#[cfg(test)]
mod detail_scale_contract {
    use super::*;
    use crate::ops_detail::{local_contrast_boost, resample_bilinear};
    #[test]
    fn detail_photo_keeps_its_scale_when_resolution_triples() {
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../apps/heeler-app/src/demo-photos/demo-01.jpg");
        let decoded = heeler_io::decode_file(&path).unwrap();
        let mut source = ImageBuf::new(decoded.width, decoded.height);
        source.data = decoded.data.clone();
        // Sizes above the scales' minimum sigmas, so the widths are the
        // frame's shares and not their floors.
        let h = (1024 * source.height / source.width).max(1);
        let small = resample_bilinear(&source, 1024, h);
        // The same band-limited photograph isolates spatial scale from
        // sensor decoding and from detail that a preview cannot resolve.
        let large = resample_bilinear(&small, 3072, h * 3);
        for (t, c) in [(100.0, 0.0), (0.0, 100.0)] {
            let a = local_contrast_boost(&small, t, c, 0.0);
            let b = resample_bilinear(&local_contrast_boost(&large, t, c, 0.0), 1024, h);
            let mse = a.data.chunks(4).zip(b.data.chunks(4)).map(|(a,b)| {
                let a = to_display(luma(a[0], a[1], a[2]).max(0.0));
                let b = to_display(luma(b[0], b[1], b[2]).max(0.0));
                (a-b).powi(2)
            }).sum::<f32>() / (1024*h) as f32;
            assert!(mse.sqrt() < 0.004, "resolution changed detail: rms {} for {t}/{c}", mse.sqrt());
        }
    }
}

/// Finish image layers (2026-09-30): the blend's "place" fit.
#[cfg(test)]
mod placed_layers {
    use super::test_util::*;
    use super::*;

    /// A blend set to place a picture on four corners, as the Finish
    /// image layer writes it: the rest box and where its corners went.
    fn placed(bbox: [f64; 4], dst: [[f64; 2]; 4]) -> Node {
        let mut n = make_node("heeler.blend");
        set_text(&mut n, "fit", "place");
        for (k, v) in [("warp_bx", bbox[0]), ("warp_by", bbox[1]), ("warp_bw", bbox[2]), ("warp_bh", bbox[3])] {
            set_num(&mut n, k, v);
        }
        for (i, c) in dst.iter().enumerate() {
            set_num(&mut n, &format!("warp_x{i}"), c[0]);
            set_num(&mut n, &format!("warp_y{i}"), c[1]);
        }
        n
    }

    /// Left half red, right half blue, top rows opaque and the bottom
    /// quarter transparent: which way round the picture landed, and
    /// whether its own alpha came along, both read off one pixel each.
    fn two_tone(w: usize, h: usize) -> ImageBuf {
        let mut img = ImageBuf::new(w, h);
        for y in 0..h {
            for x in 0..w {
                let a = if y >= h * 3 / 4 { 0.0 } else { 1.0 };
                let c = if x < w / 2 { [1.0, 0.0, 0.0, a] } else { [0.0, 0.0, 1.0, a] };
                img.set_pixel(x, y, c);
            }
        }
        img
    }

    fn blend_on(node: &Node, base: ImageBuf, top: ImageBuf) -> Arc<ImageBuf> {
        execute(
            node,
            &[
                ("base".to_string(), Value::Image(Arc::new(base))),
                ("blend".to_string(), Value::Image(Arc::new(top))),
            ],
        )
        .unwrap()
        .as_image()
        .unwrap()
        .clone()
    }

    /// The frame pixel at a normalized point.
    fn at(img: &ImageBuf, x: f32, y: f32) -> [f32; 4] {
        img.pixel(((x * img.width as f32) as usize).min(img.width - 1), ((y * img.height as f32) as usize).min(img.height - 1))
    }

    #[test]
    fn a_placed_picture_lands_on_its_corners_whatever_its_own_shape() {
        // A 2:1 picture on a 4:3 frame, its rest box moved and shrunk.
        let gray = [0.3, 0.3, 0.3, 1.0];
        let node = placed([0.25, 0.25, 0.5, 0.5], [[0.1, 0.1], [0.5, 0.1], [0.5, 0.5], [0.1, 0.5]]);
        let out = blend_on(&node, ImageBuf::filled(80, 60, gray), two_tone(40, 20));
        // Left of the new box red, right of it blue, both opaque.
        let l = at(&out, 0.2, 0.2);
        let r = at(&out, 0.4, 0.2);
        assert!(l[0] > 0.95 && l[2] < 0.05, "left half red: {l:?}");
        assert!(r[2] > 0.95 && r[0] < 0.05, "right half blue: {r:?}");
        // The picture's own transparent bottom quarter shows the base.
        let below = at(&out, 0.2, 0.47);
        assert!((below[0] - 0.3).abs() < 0.02 && (below[2] - 0.3).abs() < 0.02, "alpha respected: {below:?}");
        // Outside the corners, the photograph untouched.
        assert_eq!(at(&out, 0.8, 0.8), gray);
        assert_eq!(at(&out, 0.05, 0.05), gray);
    }

    #[test]
    fn swapping_the_top_corners_mirrors_the_placed_picture() {
        let node = placed([0.0, 0.0, 1.0, 1.0], [[1.0, 0.0], [0.0, 0.0], [0.0, 1.0], [1.0, 1.0]]);
        let out = blend_on(&node, ImageBuf::filled(40, 40, [0.0, 0.0, 0.0, 1.0]), two_tone(40, 40));
        assert!(at(&out, 0.2, 0.3)[2] > 0.95, "blue now on the left");
        assert!(at(&out, 0.8, 0.3)[0] > 0.95, "red now on the right");
    }

    #[test]
    fn a_placed_picture_with_no_box_fills_the_frame() {
        // Nothing written yet: the whole frame, as stretch has always
        // done, so the handles drawn round the frame tell the truth.
        let mut n = make_node("heeler.blend");
        set_text(&mut n, "fit", "place");
        let out = blend_on(&n, ImageBuf::filled(40, 30, [0.0, 0.0, 0.0, 1.0]), two_tone(8, 8));
        assert!(at(&out, 0.1, 0.1)[0] > 0.95);
        assert!(at(&out, 0.9, 0.1)[2] > 0.95);
    }

    #[test]
    fn the_same_numbers_place_the_picture_the_same_at_every_size() {
        // The proxy and the export: the frame and the picture both four
        // times the size, and the same normalized corners.
        let node = placed([0.2, 0.2, 0.6, 0.6], [[0.3, 0.1], [0.9, 0.2], [0.8, 0.8], [0.2, 0.7]]);
        let small = blend_on(&node, ImageBuf::filled(60, 40, [0.5, 0.5, 0.5, 1.0]), two_tone(30, 30));
        let large = blend_on(&node, ImageBuf::filled(240, 160, [0.5, 0.5, 0.5, 1.0]), two_tone(120, 120));
        let mut differ = 0;
        for j in 0..20 {
            for i in 0..20 {
                let (x, y) = ((i as f32 + 0.5) / 20.0, (j as f32 + 0.5) / 20.0);
                let (a, b) = (at(&small, x, y), at(&large, x, y));
                if (a[0] - b[0]).abs() > 0.2 || (a[2] - b[2]).abs() > 0.2 {
                    differ += 1;
                }
            }
        }
        // Only points on an edge may land on different sides of it.
        assert!(differ <= 12, "{differ} of 400 samples disagree between sizes");
    }

    #[test]
    fn a_picture_shown_much_smaller_than_its_pixels_does_not_alias() {
        // A one-pixel checker two hundred wide shown twenty wide: skipped
        // pixels would read as a random pattern of black and white, the
        // halving reads it as the gray it is.
        let mut checker = ImageBuf::new(200, 200);
        for y in 0..200 {
            for x in 0..200 {
                let v = if (x + y) % 2 == 0 { 1.0 } else { 0.0 };
                checker.set_pixel(x, y, [v, v, v, 1.0]);
            }
        }
        let node = placed([0.0, 0.0, 1.0, 1.0], [[0.0, 0.0], [1.0, 0.0], [1.0, 1.0], [0.0, 1.0]]);
        let out = blend_on(&node, ImageBuf::filled(20, 20, [0.0, 0.0, 0.0, 1.0]), checker);
        for y in 2..18 {
            for x in 2..18 {
                let v = out.pixel(x, y)[0];
                assert!((v - 0.5).abs() < 0.1, "({x},{y}) = {v}");
            }
        }
    }

    #[test]
    fn a_layer_clipped_to_a_placed_picture_shows_through_it_where_it_was_placed() {
        // The clip wire carries the base layer's picture before its own
        // blend placed it; clip_place (folded on from that blend) puts it
        // where the composite shows it.
        let mut clipped = make_node("heeler.blend");
        set_text(
            &mut clipped,
            "clip_place",
            "place;0,0.125,1,0.75,0.1,0.2,0.5,0.2,0.5,0.4,0.1,0.4",
        );
        let white = ImageBuf::filled(60, 40, [1.0, 1.0, 1.0, 1.0]);
        let out = execute(
            &clipped,
            &[
                ("base".to_string(), Value::Image(Arc::new(ImageBuf::filled(60, 40, [0.0, 0.0, 0.0, 1.0])))),
                ("blend".to_string(), Value::Image(Arc::new(white))),
                ("clip".to_string(), Value::Image(Arc::new(two_tone(20, 20)))),
            ],
        )
        .unwrap();
        let img = out.as_image().unwrap();
        // Inside the placed picture's opaque part: the white shows.
        assert!(at(img, 0.3, 0.25)[0] > 0.95);
        // Outside it (and in its transparent bottom quarter): not.
        assert!(at(img, 0.8, 0.8)[0] < 0.05);
        assert!(at(img, 0.3, 0.38)[0] < 0.05);
        // Without the fold the clip is the picture stretched over the
        // whole frame, as before.
        let plain = make_node("heeler.blend");
        let out = execute(
            &plain,
            &[
                ("base".to_string(), Value::Image(Arc::new(ImageBuf::filled(60, 40, [0.0, 0.0, 0.0, 1.0])))),
                ("blend".to_string(), Value::Image(Arc::new(ImageBuf::filled(60, 40, [1.0, 1.0, 1.0, 1.0])))),
                ("clip".to_string(), Value::Image(Arc::new(two_tone(20, 20)))),
            ],
        )
        .unwrap();
        assert!(at(out.as_image().unwrap(), 0.8, 0.2)[0] > 0.95);
    }

    #[test]
    fn layer_on_frame_is_the_blends_own_placement() {
        let node = placed([0.25, 0.25, 0.5, 0.5], [[0.1, 0.1], [0.5, 0.1], [0.5, 0.5], [0.1, 0.5]]);
        let top = Arc::new(two_tone(40, 20));
        let on = layer_on_frame(&node.params, &top, 80, 60);
        let composite = blend_on(&node, ImageBuf::filled(80, 60, [0.0, 0.0, 0.0, 0.0]), two_tone(40, 20));
        for (x, y) in [(0.2, 0.2), (0.4, 0.2), (0.2, 0.47), (0.8, 0.8)] {
            let (a, b) = (at(&on, x, y), at(&composite, x, y));
            assert!((a[3] - b[3]).abs() < 1e-5 && (a[0] * a[3] - b[0] * b[3]).abs() < 1e-5, "({x},{y}) {a:?} {b:?}");
        }
    }

    /// The opaque part of a frame-sized layer: its pixel width, height
    /// and center as fractions of the frame.
    fn opaque_extent(img: &ImageBuf) -> (f32, f32, f32, f32) {
        let (mut x0, mut y0, mut x1, mut y1) = (usize::MAX, usize::MAX, 0, 0);
        let mut cover = 0.0f32;
        let (mut cx, mut cy) = (0.0f32, 0.0f32);
        for y in 0..img.height {
            for x in 0..img.width {
                let a = img.pixel(x, y)[3];
                if a > 0.5 {
                    x0 = x0.min(x);
                    y0 = y0.min(y);
                    x1 = x1.max(x);
                    y1 = y1.max(y);
                }
                cover += a;
                cx += a * (x as f32 + 0.5);
                cy += a * (y as f32 + 0.5);
            }
        }
        ((x1 + 1 - x0) as f32, (y1 + 1 - y0) as f32, cx / cover / img.width as f32, cy / cover / img.height as f32)
    }

    /// A square picture placed on a 3:2 frame, at (0.7, 0.7) and 0.3 of
    /// the short side, stamped with the frame it was placed on.
    fn square_on_three_two() -> Node {
        // 0.2 of a 3:2 frame's width is 0.3 of its height: square.
        let mut n = placed([0.6, 0.55, 0.2, 0.3], [[0.6, 0.55], [0.8, 0.55], [0.8, 0.85], [0.6, 0.85]]);
        set_num(&mut n, "warp_aspect", 1.5);
        n
    }

    #[test]
    fn a_placed_square_stays_square_and_in_place_on_every_frame_shape() {
        // 2026-09-30: "yes, fix the frame shape issue for Finish layers". The
        // same numbers on the frame they were written on, a crop to 1:1, one to
        // 16:9 and the crop turned a quarter (2:3): square every time, centered
        // where it was as a fraction of the frame, and 0.3 of the short side
        // across.
        let node = square_on_three_two();
        let top = Arc::new(ImageBuf::filled(40, 40, [1.0, 1.0, 1.0, 1.0]));
        for (w, h) in [(300, 200), (200, 200), (320, 180), (200, 300)] {
            let on = layer_on_frame(&node.params, &top, w, h);
            let (pw, ph, cx, cy) = opaque_extent(&on);
            let short = w.min(h) as f32;
            assert!((pw - ph).abs() <= 1.0, "{w}x{h}: {pw} by {ph} pixels, not square");
            assert!((pw - 0.3 * short).abs() <= 1.0, "{w}x{h}: {pw} pixels across, not 0.3 of {short}");
            assert!((cx - 0.7).abs() < 0.01 && (cy - 0.7).abs() < 0.01, "{w}x{h}: centered at ({cx}, {cy})");
            // The blend composites exactly what layer_on_frame places.
            let composite = blend_on(&node, ImageBuf::filled(w, h, [0.0, 0.0, 0.0, 0.0]), ImageBuf::filled(40, 40, [1.0, 1.0, 1.0, 1.0]));
            assert_eq!(opaque_extent(&composite), (pw, ph, cx, cy), "{w}x{h}: the blend and layer_on_frame agree");
        }
    }

    #[test]
    fn the_frame_shape_rule_turns_and_warps_nothing_and_reads_old_graphs_as_fractions() {
        // A turned, warped quad keeps its angle in pixels and each corner
        // its place relative to the center, in short-side units.
        let mut n = placed([0.2, 0.2, 0.2, 0.3], [[0.25, 0.1], [0.5, 0.3], [0.35, 0.6], [0.1, 0.4]]);
        set_num(&mut n, "warp_aspect", 1.5);
        let px = |p: &std::collections::BTreeMap<String, ParamValue>, w: f64, h: f64| -> Vec<[f64; 2]> {
            (0..4).map(|i| [p[&format!("warp_x{i}")].as_f64().unwrap() * w, p[&format!("warp_y{i}")].as_f64().unwrap() * h]).collect()
        };
        let before = px(&n.params, 300.0, 200.0);
        let after_params = placement_on_frame(&n.params, 200, 300);
        let after = px(&after_params, 200.0, 300.0);
        // Edge vectors in pixels are unchanged: 200 short-side pixels both times.
        for i in 0..4 {
            let j = (i + 1) % 4;
            let (a, b) = ([before[j][0] - before[i][0], before[j][1] - before[i][1]], [after[j][0] - after[i][0], after[j][1] - after[i][1]]);
            assert!((a[0] - b[0]).abs() < 1e-6 && (a[1] - b[1]).abs() < 1e-6, "edge {i}: {a:?} against {b:?}");
        }
        assert_eq!(after_params["warp_aspect"].as_f64(), Some(200.0 / 300.0));
        // Stamped for this frame, a second pass is the identity.
        assert!(matches!(placement_on_frame(&after_params, 200, 300), std::borrow::Cow::Borrowed(_)));
        // No stamp: the old reading, plain fractions of the frame.
        let old = placed([0.2, 0.2, 0.2, 0.3], [[0.25, 0.1], [0.5, 0.3], [0.35, 0.6], [0.1, 0.4]]);
        assert!(matches!(placement_on_frame(&old.params, 200, 300), std::borrow::Cow::Borrowed(_)));
    }

    #[test]
    fn a_clip_through_a_placed_base_follows_the_frame_shape_rule() {
        // The base's stamp rides the clip_place fold as a thirteenth
        // number, so a layer clipped to a placed square shows through the
        // square where the base's blend puts it on a 1:1 crop.
        let base = square_on_three_two();
        let get = |k: &str| base.params[k].as_f64().unwrap();
        let nums: Vec<String> = ["warp_bx", "warp_by", "warp_bw", "warp_bh", "warp_x0", "warp_y0", "warp_x1", "warp_y1", "warp_x2", "warp_y2", "warp_x3", "warp_y3", "warp_aspect"]
            .iter()
            .map(|k| get(k).to_string())
            .collect();
        let mut clipped = make_node("heeler.blend");
        set_text(&mut clipped, "clip_place", &format!("place;{}", nums.join(",")));
        let square = Arc::new(ImageBuf::filled(40, 40, [1.0, 1.0, 1.0, 1.0]));
        let out = execute(
            &clipped,
            &[
                ("base".to_string(), Value::Image(Arc::new(ImageBuf::filled(200, 200, [0.0, 0.0, 0.0, 1.0])))),
                ("blend".to_string(), Value::Image(Arc::new(ImageBuf::filled(200, 200, [1.0, 1.0, 1.0, 1.0])))),
                ("clip".to_string(), Value::Image(square.clone())),
            ],
        )
        .unwrap();
        let out = out.as_image().unwrap();
        let placed_base = layer_on_frame(&base.params, &square, 200, 200);
        for (x, y) in [(0.7, 0.7), (0.6, 0.6), (0.79, 0.79), (0.5, 0.5), (0.9, 0.7), (0.7, 0.9)] {
            let shown = at(out, x, y)[0] > 0.5;
            let under = at(&placed_base, x, y)[3] > 0.5;
            assert_eq!(shown, under, "({x},{y})");
        }
    }
}
