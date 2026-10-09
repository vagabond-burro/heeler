//! The Color Tune (designed with 2026-08-23): per-hue-family grading
//! strips, the hue-indexed sibling of the tonal Color Wheels.
//!
//! Six fixed bands sit on the OkLab hues of the sRGB primaries and
//! secondaries (the vectorscope's landmarks), and custom bands are
//! born from an eyedropper pick, because skin is not a constant hue
//! and neither is anything else that matters (the product decision:
//! a Custom band the user picks, not a preset "Skin"). Each band
//! carries a wheel (a 2D pull toward a target hue), a hue shift,
//! saturation, vibrance (saturation weighted toward the band's LESS
//! saturated pixels, so rich color does not clip), and luminance in
//! EV.
//!
//! The Recolor contract holds throughout: OkLCh adjustments at
//! constant companion channels, an exposure multiply for luminance,
//! parallel evaluation against the original pixel (bands cannot feed
//! each other), the chroma gate keeping neutrals out (they have no
//! hue to select by), and a smoothed lookup field so shadow noise
//! stays quiet.

use std::sync::Arc;

use heeler_graph::Node;

use crate::buffers::{ImageBuf, Value};
use crate::color::{linear_to_oklab, oklab_to_linear};
use crate::executor::EngineError;
use crate::ops::{box_blur_pass, image_input, invalid_param, p};

/// The fixed bands: OkLab hue of each sRGB primary and secondary,
/// computed from the published matrices (see the design notes).
pub const FIXED_BANDS: [(&str, f32); 6] = [
    ("r", 29.23),
    ("y", 109.77),
    ("g", 142.50),
    ("c", 194.77),
    ("b", 264.05),
    ("m", 328.36),
];

/// Default half-width of a band's full-strength core; the falloff adds
/// the same again, so neighboring fixed bands (60° apart) meet in a
/// smooth crossfade rather than a gap or a hard seam.
const DEFAULT_WIDTH: f32 = 30.0;
const C_FULL: f32 = 0.3;

struct Band {
    center: f32,
    width: f32,
    wheel_theta: f32,
    wheel_pull: f32,
    hue: f32,
    sat: f32,
    vib: f32,
    lum: f32,
}

fn parse_bands(node: &Node) -> Result<Vec<Band>, String> {
    parse_bands_json(node.params.get("bands").and_then(|v| v.as_str()).unwrap_or(""))
}

/// Whether the grade uses a hue lookup. Neutral custom bands are UI
/// selections, not effects, and must not prevent an otherwise valid bake.
pub fn has_active_bands(json: &str) -> bool {
    parse_bands_json(json).is_ok_and(|bands| !bands.is_empty())
}

fn parse_bands_json(json: &str) -> Result<Vec<Band>, String> {
    if json.trim().is_empty() { return Ok(Vec::new()); }
    let value: serde_json::Value = serde_json::from_str(json).map_err(|e| e.to_string())?;
    let specs = value.as_array().ok_or("bands must be an array")?;
    let mut seen = std::collections::HashSet::new();
    let mut out = Vec::new();
    for spec in specs {
        let Some(s) = spec.as_object() else { continue };
        let Some(id) = s.get("id").and_then(|v| v.as_str()) else { continue };
        let center = if let Some(v) = s.get("center") {
            let Some(c) = v.as_f64().filter(|v| v.is_finite()) else { continue };
            c.rem_euclid(360.0) as f32
        } else {
            let Some((_, c)) = FIXED_BANDS.iter().find(|(fixed, _)| *fixed == id) else { continue };
            *c
        };
        // The UI edits the first valid band with this ID. Applying later
        // duplicates would add an invisible grade that no control owns.
        if !seen.insert(id) { continue; }
        let number = |key: &str, default: f64, lo: f64, hi: f64| {
            s.get(key).and_then(|v| v.as_f64()).filter(|v| v.is_finite())
                .unwrap_or(default).clamp(lo, hi) as f32
        };
        let wheel = s.get("wheel").and_then(|v| v.as_array()).filter(|v| v.len() == 2)
            .and_then(|v| Some([v[0].as_f64()?, v[1].as_f64()?]))
            .filter(|v| v.iter().all(|n| n.is_finite())).unwrap_or([0.0; 2]);
        let scale = wheel[0].abs().max(wheel[1].abs());
        let (x, y, len) = if scale > f32::MAX as f64 {
            ((wheel[0] / scale) as f32, (wheel[1] / scale) as f32, 1.0)
        } else {
            let (x, y) = (wheel[0] as f32, wheel[1] as f32);
            (x, y, (x * x + y * y).sqrt().min(1.0))
        };
        let band = Band {
            center,
            width: number("width", DEFAULT_WIDTH as f64, 5.0, 120.0),
            wheel_theta: y.atan2(x).to_degrees(),
            wheel_pull: len,
            hue: number("hue", 0.0, -60.0, 60.0),
            sat: number("sat", 0.0, -100.0, 100.0),
            vib: number("vib", 0.0, -100.0, 100.0),
            lum: number("lum", 0.0, -2.0, 2.0),
        };
        if band.wheel_pull > 1e-4 || band.hue.abs() > 1e-4 || band.sat.abs() > 1e-4
            || band.vib.abs() > 1e-4 || band.lum.abs() > 1e-4 {
            out.push(band);
        }
    }
    Ok(out)
}

/// Shortest signed angular distance, degrees.
fn hue_delta_deg(a: f32, b: f32) -> f32 {
    let mut d = (a - b).rem_euclid(360.0);
    if d > 180.0 {
        d -= 360.0;
    }
    d
}

/// A band's take on a hue: 1 inside the core, smootherstep falloff over
/// a second width beyond it, 0 elsewhere.
fn band_weight(band: &Band, hue: f32) -> f32 {
    let d = hue_delta_deg(hue, band.center).abs();
    if d <= band.width {
        return 1.0;
    }
    let t = ((d - band.width) / band.width).min(1.0);
    let s = 1.0 - t;
    s * s * (3.0 - 2.0 * s)
}

pub(crate) fn color_console(node: &Node, inputs: &[(String, Value)]) -> Result<Value, EngineError> {
    let src = image_input(inputs, "in", &node.id)?;
    let bands = parse_bands(node).map_err(|e| invalid_param(node, "bands", e))?;
    if bands.is_empty() {
        return Ok(Value::Image(src.clone()));
    }
    let smoothing = p(&node.params, "smoothing", 50.0).clamp(0.0, 100.0) / 100.0;

    let (w, h) = (src.width, src.height);
    let mut la = vec![0.0f32; w * h];
    let mut lb = vec![0.0f32; w * h];
    // PERF: the OkLab plane fill ran serially over the frame. Each
    // element is a pure function of its own source pixel (alpha never
    // enters linear_to_oklab here), so the parallel zip writes bit for
    // bit the same planes.
    use rayon::prelude::*;
    la.par_iter_mut()
        .zip(lb.par_iter_mut())
        .zip(src.data.par_chunks(4))
        .for_each(|((a, b), px)| {
            let lab = linear_to_oklab(px[0].max(0.0), px[1].max(0.0), px[2].max(0.0));
            *a = lab[1];
            *b = lab[2];
        });
    // A share of the FRAME's short side: under a 1:1 slice the buffer is
    // a piece of the frame (frame_short_of reads the rect the desktop
    // hands it), and sized from the piece the lookup was smoothed a
    // fraction as far as the export smooths it.
    // Rounded: the frame's short side is a whole count of pixels, and
    // the rect's division lands a hair under it (120 / 0.6 is 199.99998),
    // which truncated a 4 pixel radius to 3.
    let radius = (crate::ops::frame_short_of(&node.params, w, h).round() * 0.02 * smoothing) as usize;
    if radius > 0 {
        let mut scratch = vec![0.0f32; w * h];
        box_blur_pass(&mut la, &mut scratch, w, h, radius);
        box_blur_pass(&mut lb, &mut scratch, w, h, radius);
    }

    // (The rayon import above, at the plane fill, covers this loop too:
    // a use is visible throughout its whole block.)
    let mut out = ImageBuf::new(w, h);
    out.data
        .par_chunks_mut(4)
        .zip(src.data.par_chunks(4))
        .enumerate()
        .for_each(|(i, (o, s))| {
            let chroma_idx = (la[i] * la[i] + lb[i] * lb[i]).sqrt();
            let hue_idx = lb[i].atan2(la[i]).to_degrees().rem_euclid(360.0);
            // Smoothing selects a stable hue, but cannot lend a colored
            // neighbor's eligibility to an originally neutral pixel.
            let lab = linear_to_oklab(s[0].max(0.0), s[1].max(0.0), s[2].max(0.0));
            let c0 = (lab[1] * lab[1] + lab[2] * lab[2]).sqrt();
            let t = ((chroma_idx.min(c0) - 0.01) / 0.04).clamp(0.0, 1.0);
            let gate = t * t * (3.0 - 2.0 * t);

            let mut dh = 0.0f32;
            let mut sat_scale = 1.0f32;
            let mut ev = 0.0f32;
            if gate > 0.0 {
                let sat_frac = (chroma_idx / C_FULL).min(1.0);
                for band in &bands {
                    let e = band_weight(band, hue_idx) * gate;
                    if e <= 1e-4 {
                        continue;
                    }
                    dh += band.hue * e;
                    // The wheel: pull this band's hues toward the
                    // dragged direction, radius = how much of the way.
                    // The way round is the band's own, measured from its
                    // center and carried to the pixel: measured from each
                    // pixel, a pull toward the band's opposite hue sent
                    // the hues either side of the center round opposite
                    // ways and tore the family in two.
                    let toward = hue_delta_deg(band.wheel_theta, band.center) + hue_delta_deg(band.center, hue_idx);
                    dh += toward * band.wheel_pull * e;
                    sat_scale *= 1.0 + band.sat / 100.0 * e;
                    // Vibrance favors what is not yet saturated.
                    sat_scale *= 1.0 + band.vib / 100.0 * e * (1.0 - sat_frac);
                    ev += band.lum * e;
                }
            }
            if dh == 0.0 && sat_scale == 1.0 && ev == 0.0 {
                o.copy_from_slice(s);
                return;
            }
            let h1 = lab[2].atan2(lab[1]) + dh.clamp(-90.0, 90.0).to_radians();
            let c1 = (c0 * sat_scale.max(0.0)).min(1.5);
            let rgb = oklab_to_linear([lab[0], c1 * h1.cos(), c1 * h1.sin()]);
            let gain = 2f32.powf(ev.clamp(-2.0, 2.0));
            o[0] = rgb[0].max(0.0) * gain;
            o[1] = rgb[1].max(0.0) * gain;
            o[2] = rgb[2].max(0.0) * gain;
            o[3] = s[3];
        });
    Ok(Value::Image(Arc::new(out)))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ops::test_util::{make_node, run_on, set_num, set_text};

    fn px(r: f32, g: f32, b: f32) -> ImageBuf {
        let mut img = ImageBuf::new(1, 1);
        img.data.copy_from_slice(&[r, g, b, 1.0]);
        img
    }

    fn chroma_of(d: &[f32]) -> f32 {
        let lab = linear_to_oklab(d[0], d[1], d[2]);
        (lab[1] * lab[1] + lab[2] * lab[2]).sqrt()
    }

    /// A 1:1 slice is a piece of the frame: handed its rect, the op
    /// smooths the hue lookup as far as the whole frame does, so the
    /// slice's interior matches the whole render's (the 26.3.2 Color
    /// Tune review; sized from the slice it smoothed a quarter as far).
    #[test]
    fn a_slice_smooths_as_far_as_the_frame() {
        // A hue boundary with noise: red left, orange right, speckled.
        let (w, h) = (200usize, 200usize);
        let mut frame = ImageBuf::new(w, h);
        for y in 0..h {
            for x in 0..w {
                let n = (((x * 7919 + y * 104729) % 97) as f32 / 97.0 - 0.5) * 0.06;
                let px = if x < 100 { [0.6 + n, 0.12, 0.1] } else { [0.6, 0.3 + n, 0.08] };
                frame.set_pixel(x, y, [px[0], px[1], px[2], 1.0]);
            }
        }
        let mut node = make_node("heeler.color_console");
        set_text(&mut node, "bands", r#"[{"id":"r","hue":40,"sat":60}]"#);
        set_num(&mut node, "smoothing", 100.0);
        let whole = run_on(&node, frame.clone()).unwrap();
        let whole = whole.as_image().unwrap();
        // The middle half as a slice, with a margin wider than the
        // smoothing (2% of 200 = 4 px): 40..160 on both axes.
        let (x0, s) = (40usize, 120usize);
        let mut piece = ImageBuf::new(s, s);
        for y in 0..s {
            for x in 0..s {
                piece.set_pixel(x, y, frame.pixel(x0 + x, x0 + y));
            }
        }
        let mut sliced = node.clone();
        for (k, v) in [("roi_x", 0.2), ("roi_y", 0.2), ("roi_w", 0.6), ("roi_h", 0.6)] {
            set_num(&mut sliced, k, v);
        }
        let got = run_on(&sliced, piece.clone()).unwrap();
        let got = got.as_image().unwrap();
        let by_piece = run_on(&node, piece).unwrap();
        let by_piece = by_piece.as_image().unwrap();
        let worst = |img: &ImageBuf| {
            let mut m = 0f32;
            for y in 10..s - 10 {
                for x in 10..s - 10 {
                    let (a, b) = (img.pixel(x, y), whole.pixel(x0 + x, x0 + y));
                    for c in 0..3 {
                        m = m.max((a[c] - b[c]).abs());
                    }
                }
            }
            m
        };
        assert!(worst(got) < 1e-5, "the slice's interior differs from the frame's: {}", worst(got));
        assert!(worst(by_piece) > 1e-3, "without its rect the slice smooths less, and it shows: {}", worst(by_piece));
    }

    #[test]
    fn empty_bands_are_the_identity_and_bad_json_is_an_error() {
        let node = make_node("heeler.color_console");
        let img = px(0.5, 0.3, 0.2);
        let out = run_on(&node, img.clone()).unwrap();
        assert_eq!(out.as_image().unwrap().data, img.data);
        let mut bad = make_node("heeler.color_console");
        set_text(&mut bad, "bands", "not json");
        assert!(run_on(&bad, img).is_err());
    }

    #[test]
    fn a_band_grades_its_family_and_leaves_the_others_alone() {
        // Saturation up on the red band: a red saturates, a blue does
        // not, and a gray is protected by the chroma gate.
        let mut node = make_node("heeler.color_console");
        set_text(&mut node, "bands", r#"[{"id":"r","sat":80}]"#);
        let red = px(0.6, 0.15, 0.12);
        let blue = px(0.12, 0.2, 0.6);
        let gray = px(0.4, 0.4, 0.4);
        let r_out = run_on(&node, red.clone()).unwrap();
        assert!(
            chroma_of(&r_out.as_image().unwrap().data) > chroma_of(&red.data) * 1.4,
            "red band did not saturate red"
        );
        let b_out = run_on(&node, blue.clone()).unwrap();
        assert!(
            (chroma_of(&b_out.as_image().unwrap().data) - chroma_of(&blue.data)).abs() < 1e-4,
            "the red band touched blue"
        );
        let g_out = run_on(&node, gray.clone()).unwrap();
        assert_eq!(g_out.as_image().unwrap().data, gray.data);
    }

    #[test]
    fn the_wheel_pulls_hues_toward_its_direction() {
        // Red band's wheel dragged toward the yellow direction at half
        // strength: a red's hue moves toward yellow, roughly halfway.
        let theta = 109.77f32.to_radians();
        let mut node = make_node("heeler.color_console");
        set_text(
            &mut node,
            "bands",
            &format!(
                r#"[{{"id":"r","wheel":[{},{}]}}]"#,
                0.5 * theta.cos(),
                0.5 * theta.sin()
            ),
        );
        let red = px(0.6, 0.15, 0.12);
        let before = linear_to_oklab(0.6, 0.15, 0.12);
        let h0 = before[2].atan2(before[1]).to_degrees().rem_euclid(360.0);
        let out = run_on(&node, red).unwrap();
        let d = &out.as_image().unwrap().data;
        let after = linear_to_oklab(d[0], d[1], d[2]);
        let h1 = after[2].atan2(after[1]).to_degrees().rem_euclid(360.0);
        let moved = hue_delta_deg(h1, h0);
        let wanted = hue_delta_deg(109.77, h0);
        assert!(
            moved > wanted * 0.3 && moved < wanted * 0.7,
            "pull off target: moved {moved} of {wanted}"
        );
    }

    /// Pulling a band toward its opposite hue turns the whole family one
    /// way round. Measured per pixel, hues a few degrees either side of
    /// the center were sent opposite ways, nearly 180 apart.
    #[test]
    fn a_pull_toward_the_opposite_hue_turns_the_family_one_way() {
        let center = 29.23f32;
        let theta = (center + 180.0).to_radians();
        let mut node = make_node("heeler.color_console");
        set_text(&mut node, "bands", &format!(r#"[{{"id":"r","wheel":[{},{}]}}]"#, 0.3 * theta.cos(), 0.3 * theta.sin()));
        let moved = |hue: f32| {
            let h = hue.to_radians();
            let rgb = oklab_to_linear([0.6, 0.12 * h.cos(), 0.12 * h.sin()]);
            let out = run_on(&node, px(rgb[0], rgb[1], rgb[2])).unwrap();
            let d = &out.as_image().unwrap().data;
            let lab = linear_to_oklab(d[0], d[1], d[2]);
            hue_delta_deg(lab[2].atan2(lab[1]).to_degrees().rem_euclid(360.0), hue)
        };
        let (below, above) = (moved(center - 5.0), moved(center + 5.0));
        assert!(below.signum() == above.signum(), "the family tore: {below} and {above}");
        assert!((below - above).abs() < 10.0, "neighbors moved far apart: {below} and {above}");
    }

    #[test]
    fn vibrance_favors_the_pale_over_the_rich() {
        // Same hue, same lightness, both clear of the chroma gate: only
        // the saturation differs, so only the vibrance weighting can
        // explain a different boost.
        let mut node = make_node("heeler.color_console");
        set_text(&mut node, "bands", r#"[{"id":"r","vib":80}]"#);
        let of = |c: f32| {
            let h = 29.23f32.to_radians();
            let rgb = oklab_to_linear([0.6, c * h.cos(), c * h.sin()]);
            px(rgb[0], rgb[1], rgb[2])
        };
        let pale = of(0.08);
        let rich = of(0.25);
        let p_out = run_on(&node, pale.clone()).unwrap();
        let r_out = run_on(&node, rich.clone()).unwrap();
        let p_boost = chroma_of(&p_out.as_image().unwrap().data) / chroma_of(&pale.data);
        let r_boost = chroma_of(&r_out.as_image().unwrap().data) / chroma_of(&rich.data);
        assert!(
            p_boost > r_boost + 0.1,
            "vibrance did not favor the pale: pale x{p_boost:.2} rich x{r_boost:.2}"
        );
    }

    #[test]
    fn a_custom_band_lives_where_it_was_picked() {
        // A custom band centered on a picked orange-skin hue: grades
        // that hue, not the red primary two dozen degrees away... but a
        // NARROW width keeps even the primary out.
        let skin = px(0.5, 0.3, 0.22);
        let lab = linear_to_oklab(0.5, 0.3, 0.22);
        let center = lab[2].atan2(lab[1]).to_degrees().rem_euclid(360.0);
        let mut node = make_node("heeler.color_console");
        set_text(
            &mut node,
            "bands",
            &format!(r#"[{{"id":"c1","center":{center},"width":10,"lum":1.0}}]"#),
        );
        let out = run_on(&node, skin.clone()).unwrap();
        let d = &out.as_image().unwrap().data;
        assert!(d[0] > skin.data[0] * 1.6, "picked band did not lift its hue");
        // The deep red primary sits outside the narrow custom band.
        let red = px(0.65, 0.1, 0.08);
        let out = run_on(&node, red.clone()).unwrap();
        let r = &out.as_image().unwrap().data;
        assert!(
            (r[0] - red.data[0]).abs() < red.data[0] * 0.08,
            "narrow band leaked onto the primary: {r:?}"
        );
    }
}
