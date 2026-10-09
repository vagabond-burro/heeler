//! Halation: bright highlights bleed a colored mist into their
//! surroundings, the way light scatters back through film's base and
//! fogs the emulsion around a bright source. Scene-linear, after
//! Depth of Field and before the Tone Profile, so the bloom rolls
//! into the highlights the profile then shapes.
//!
//! The source is luminance above a threshold, gated by how dark the
//! surroundings are (halation is hard to see against a bright backdrop,
//! so the gate keeps it to high-contrast borders), optionally weighted
//! by the depth plane; it is blurred at the spread with a kernel that
//! runs from a ring (a Gaussian minus a narrower one) to a plain
//! Gaussian by diffusion, tinted by hue and saturation, boosted on blue
//! sources by blue compensation, scaled by strength; a second, wider,
//! neutral pass is the bloom; both add, and mix blends the sum over the
//! frame. The "view" param renders the gated source instead, for tuning
//! the thresholds against exactly what will bloom.
use std::sync::Arc;

use heeler_graph::Node;

use crate::buffers::{luma, ImageBuf, Value};
use crate::executor::EngineError;
use crate::ops::{image_input, p};
use crate::ops_depth::depth_plane;
use crate::ops_detail::gaussian_blur_wide;

/// The film format's enlargement, relative to 35mm: a smaller gauge is
/// blown up more for viewing, so its halation reads larger.
fn format_scale(name: &str) -> f32 {
    match name {
        "8mm" => 2.6,
        "16mm" => 1.7,
        "65mm" => 0.6,
        _ => 1.0,
    }
}

fn hue_rgb(deg: f32) -> [f32; 3] {
    let h = deg.rem_euclid(360.0) / 60.0;
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

pub(crate) fn halation(node: &Node, inputs: &[(String, Value)]) -> Result<Value, EngineError> {
    let src = image_input(inputs, "in", &node.id)?;
    let amount = p(&node.params, "amount", 100.0) / 100.0;
    let mix = p(&node.params, "mix", 100.0) / 100.0;
    let bloom = p(&node.params, "bloom", 0.0) / 100.0;
    let view = node.params.get("view").and_then(|v| v.as_str()).unwrap_or("");
    let showing = view == "source";
    if !showing && (amount <= 0.0 || mix <= 0.0) && bloom <= 0.0 {
        return Ok(Value::Image(src.clone()));
    }
    let (w, h) = (src.width, src.height);
    if w == 0 || h == 0 {
        return Ok(Value::Image(src.clone()));
    }
    // The patch of the full frame this render is; sizes are fractions of
    // the full frame's short side.
    let rw = p(&node.params, "roi_w", 1.0).max(1e-4);
    let rh = p(&node.params, "roi_h", 1.0).max(1e-4);
    let short = (w as f32 / rw).min(h as f32 / rh);
    let format = node.params.get("format").and_then(|v| v.as_str()).unwrap_or("35mm");
    let scale = format_scale(format);
    let threshold_stops = p(&node.params, "threshold", 50.0) / 100.0 * 4.0; // 0..4 stops above gray
    let cut = 0.18 * 2f32.powf(threshold_stops);
    let background = p(&node.params, "background", 50.0) / 100.0;
    let by_depth = p(&node.params, "by_depth", 0.0) / 100.0;
    let radius = (p(&node.params, "radius", 4.0) / 100.0 * short * scale).max(0.5);
    let diffusion = p(&node.params, "diffusion", 60.0) / 100.0;
    let hue = p(&node.params, "hue", 18.0);
    let saturation = p(&node.params, "saturation", 70.0) / 100.0;
    let blue_comp = p(&node.params, "blue_comp", 0.0) / 100.0;
    let bloom_radius = (p(&node.params, "bloom_radius", 20.0) / 100.0 * short * scale).max(0.5);
    let plane = if by_depth != 0.0 { depth_plane(inputs, w, h) } else { None };

    // The source plane: light above the cut, in the light's own color
    // (kept so a blue source can be told from a warm one), in R, G, B,
    // with the raw excess luminance in A.
    use rayon::prelude::*;
    let mut source = ImageBuf::new(w, h);
    source.data.par_chunks_mut(4).zip(src.data.par_chunks(4)).enumerate().for_each(|(i, (o, s))| {
        let y = luma(s[0], s[1], s[2]);
        let over = (y - cut).max(0.0);
        // An infinite input would put NaN through the blurs and land as
        // a black hole under the final clamp; it blooms as nothing.
        if over <= 0.0 || !over.is_finite() {
            return;
        }
        let mut k = over / y.max(1e-6);
        if let Some(pl) = plane.as_ref() {
            let far = pl[i];
            k *= (1.0 + by_depth * (2.0 * far - 1.0)).clamp(0.0, 2.0);
        }
        o[0] = s[0] * k;
        o[1] = s[1] * k;
        o[2] = s[2] * k;
        o[3] = over;
    });
    // The background gate: the local mean of the SURROUNDINGS' light over
    // the spread; where it is bright the bloom is hidden. The surroundings
    // are the light below the cut, and the source itself casts no vote at
    // all: counted even at the cut, a large highlight (a window, the sky)
    // read as its own bright backdrop and lost the halo at its own edge,
    // the one place film halates most (2026-09-09: "Agreed, proceed"). A
    // small source barely moved the old average, so small sources look as
    // they did.
    if background > 0.0 {
        let mut lum = ImageBuf::new(w, h);
        lum.data.par_chunks_mut(4).zip(src.data.par_chunks(4)).for_each(|(o, s)| {
            let y = luma(s[0], s[1], s[2]);
            o[0] = if y < cut { y } else { 0.0 };
            o[3] = 1.0;
        });
        let local = gaussian_blur_wide(&lum, radius);
        source.data.par_chunks_mut(4).zip(local.data.par_chunks(4)).for_each(|(o, l)| {
            // Dark around: gate 1. As bright as the cut: gate 0.
            let dark = (1.0 - (l[0] / cut).clamp(0.0, 1.0)).powf(0.5);
            let g = 1.0 - background * (1.0 - dark);
            o[0] *= g;
            o[1] *= g;
            o[2] *= g;
            o[3] *= g;
        });
    }
    if showing {
        // The isolated regions: the gated source as gray, black elsewhere.
        let peak = source.data.chunks(4).map(|px| px[3]).fold(0.0f32, f32::max).max(1e-6);
        let mut out = ImageBuf::new(w, h);
        for (o, s) in out.data.chunks_mut(4).zip(source.data.chunks(4)) {
            let v = (s[3] / peak).clamp(0.0, 1.0);
            o[0] = v;
            o[1] = v;
            o[2] = v;
            o[3] = 1.0;
        }
        return Ok(Value::Image(Arc::new(out)));
    }

    // The halo: a ring (wide minus narrow) at low diffusion, a plain
    // Gaussian at high, mixed by diffusion. Every blur here is a fraction
    // of the frame, so the reduced path (gaussian_blur_wide): the direct
    // kernel at these sigmas was the 4-second render of the owner's demo.
    // No halo work at amount 0: only the bloom is asked for.
    let halo_on = amount > 0.0;
    let wide = if halo_on { Some(gaussian_blur_wide(&source, radius)) } else { None };
    let ring_part = 1.0 - diffusion;
    let narrow = if halo_on && ring_part > 0.0 { Some(gaussian_blur_wide(&source, radius * 0.45)) } else { None };
    let tint = {
        let c = hue_rgb(hue);
        [1.0 + (c[0] - 1.0) * saturation, 1.0 + (c[1] - 1.0) * saturation, 1.0 + (c[2] - 1.0) * saturation]
    };
    let bloomed = if bloom > 0.0 { Some(gaussian_blur_wide(&source, bloom_radius)) } else { None };
    let mut out = ImageBuf::new(w, h);
    out.data
        .par_chunks_mut(4)
        .enumerate()
        .for_each(|(i, o)| {
            let s = &src.data[i * 4..i * 4 + 4];
            let mut halo = match wide.as_ref() {
                Some(wd) => [wd.data[i * 4], wd.data[i * 4 + 1], wd.data[i * 4 + 2]],
                None => [0.0, 0.0, 0.0],
            };
            if let Some(n) = narrow.as_ref() {
                let nv = &n.data[i * 4..i * 4 + 4];
                for c in 0..3 {
                    // The ring: what the wide blur has that the narrow lacks.
                    halo[c] = halo[c] * diffusion + (halo[c] - nv[c]).max(0.0) * ring_part;
                }
            }
            // Blue compensation: a source that is bluer than it is red
            // would neutralize a warm halo; lift its halo to keep it seen.
            let blueness = (halo[2] - halo[0]).max(0.0) / (halo[0] + halo[1] + halo[2]).max(1e-6);
            let comp = 1.0 + blue_comp * 2.0 * blueness;
            let lum_halo = luma(halo[0], halo[1], halo[2]) * comp * amount;
            let mut add = [lum_halo * tint[0], lum_halo * tint[1], lum_halo * tint[2]];
            if let Some(b) = bloomed.as_ref() {
                let bv = &b.data[i * 4..i * 4 + 4];
                let lb = luma(bv[0], bv[1], bv[2]) * bloom;
                add[0] += lb;
                add[1] += lb;
                add[2] += lb;
            }
            o[0] = (s[0] + add[0] * mix).max(0.0);
            o[1] = (s[1] + add[1] * mix).max(0.0);
            o[2] = (s[2] + add[2] * mix).max(0.0);
            o[3] = s[3];
        });
    Ok(Value::Image(Arc::new(out)))
}

/// Whether a halation node wants the depth plane: its desktop planting rule.
pub fn halation_wants_depth(params: &std::collections::HashMap<String, serde_json::Value>) -> bool {
    params.get("by_depth").and_then(|v| v.as_f64()).unwrap_or(0.0) != 0.0
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ops::test_util::{make_node, run_on, set_num, set_text};
    use crate::ops_detail::gaussian_blur;

    /// Timing at preview size, run by hand: cargo test -p heeler-engine
    /// --release halation_timing -- --ignored --nocapture
    #[test]
    #[ignore]
    fn halation_timing() {
        let (w, h) = (2000usize, 1333usize);
        let mut img = ImageBuf::filled(w, h, [0.1, 0.1, 0.1, 1.0]);
        for y in (0..h).step_by(97) {
            for x in (0..w).step_by(89) {
                img.set_pixel(x, y, [6.0, 5.0, 4.0, 1.0]);
            }
        }
        let cases: &[(&str, &[(&str, f64)])] = &[
            ("defaults (radius 4, background 50, diffusion 60, bloom 0)", &[]),
            ("no background gate", &[("background", 0.0)]),
            ("diffusion 100 (no narrow pass)", &[("diffusion", 100.0)]),
            ("bloom 30 (bloom_radius 20)", &[("bloom", 30.0)]),
            ("radius 10", &[("radius", 10.0)]),
            ("radius 10, bloom 30", &[("radius", 10.0), ("bloom", 30.0)]),
        ];
        for (label, params) in cases {
            let mut node = make_node("heeler.halation");
            for (k, v) in params.iter() {
                set_num(&mut node, k, *v);
            }
            let t = std::time::Instant::now();
            let _ = run_on(&node, img.clone()).unwrap();
            eprintln!("{:>8.0} ms  {}", t.elapsed().as_secs_f64() * 1000.0, label);
        }
        let t = std::time::Instant::now();
        let _ = gaussian_blur(&img, 53.0);
        eprintln!("{:>8.0} ms  one gaussian_blur sigma 53 (radius 4% of 1333)", t.elapsed().as_secs_f64() * 1000.0);
        let t = std::time::Instant::now();
        let _ = gaussian_blur(&img, 267.0);
        eprintln!("{:>8.0} ms  one gaussian_blur sigma 267 (bloom 20% of 1333)", t.elapsed().as_secs_f64() * 1000.0);
    }

    fn scene(w: usize, h: usize, base: f32, spots: &[(usize, usize, [f32; 3])]) -> ImageBuf {
        let mut img = ImageBuf::filled(w, h, [base, base, base, 1.0]);
        for &(x, y, c) in spots {
            img.set_pixel(x, y, [c[0], c[1], c[2], 1.0]);
        }
        img
    }

    #[test]
    fn nothing_below_the_threshold_blooms_and_a_highlight_blooms_around_itself() {
        let mut node = make_node("heeler.halation");
        set_num(&mut node, "threshold", 50.0); // 2 stops over gray: cut 0.72
        set_num(&mut node, "background", 0.0);
        set_num(&mut node, "radius", 6.0);
        set_num(&mut node, "diffusion", 100.0);
        set_num(&mut node, "saturation", 0.0);
        let dim = scene(64, 64, 0.05, &[(32, 32, [0.5, 0.5, 0.5])]);
        let out = run_on(&node, dim.clone()).unwrap();
        assert_eq!(out.as_image().unwrap().data, dim.data, "a highlight under the cut does nothing");
        let bright = scene(64, 64, 0.05, &[(32, 32, [8.0, 8.0, 8.0])]);
        let out = run_on(&node, bright).unwrap();
        let out = out.as_image().unwrap();
        let at = |x: usize, y: usize| out.pixel(x, y)[1] - 0.05;
        assert!(at(35, 32) > 0.01, "light leaks beside the highlight: {}", at(35, 32));
        assert!((at(35, 32) - at(29, 32)).abs() < 1e-4 && (at(32, 35) - at(32, 29)).abs() < 1e-4, "symmetric");
        assert!(at(35, 32) > at(40, 32) && at(40, 32) > at(50, 32), "falls off with distance");
        assert!(at(60, 60) < 1e-3, "nothing far away");
    }

    #[test]
    fn the_halo_is_warm_by_default_and_the_ring_hollows_the_middle() {
        let mut warm = make_node("heeler.halation");
        set_num(&mut warm, "background", 0.0);
        set_num(&mut warm, "radius", 6.0);
        set_num(&mut warm, "diffusion", 100.0);
        let bright = scene(64, 64, 0.05, &[(32, 32, [8.0, 8.0, 8.0])]);
        let out = run_on(&warm, bright.clone()).unwrap();
        let px = out.as_image().unwrap().pixel(36, 32);
        assert!(px[0] > px[2] * 1.3, "the default halo is red-orange: {px:?}");
        // The ring: at zero diffusion the halo is stronger away from the
        // source than the plain blur puts it, relative to its center.
        let mut ring = make_node("heeler.halation");
        set_num(&mut ring, "background", 0.0);
        set_num(&mut ring, "radius", 6.0);
        set_num(&mut ring, "diffusion", 0.0);
        set_num(&mut ring, "saturation", 0.0);
        let r = run_on(&ring, bright.clone()).unwrap();
        let r = r.as_image().unwrap();
        let g = run_on(&{ let mut n = make_node("heeler.halation"); set_num(&mut n, "background", 0.0); set_num(&mut n, "radius", 6.0); set_num(&mut n, "diffusion", 100.0); set_num(&mut n, "saturation", 0.0); n }, bright).unwrap();
        let g = g.as_image().unwrap();
        let ratio = |img: &ImageBuf| (img.pixel(38, 32)[1] - 0.05) / (img.pixel(33, 32)[1] - 0.05).max(1e-6);
        assert!(ratio(r) > ratio(g) * 1.5, "the ring carries more of its light outward: {} vs {}", ratio(r), ratio(g));
    }

    #[test]
    fn the_background_gate_hides_a_bloom_against_a_bright_field() {
        let mut node = make_node("heeler.halation");
        set_num(&mut node, "radius", 6.0);
        set_num(&mut node, "saturation", 0.0);
        set_num(&mut node, "background", 100.0);
        let on_dark = scene(64, 64, 0.02, &[(32, 32, [8.0, 8.0, 8.0])]);
        let on_light = scene(64, 64, 0.7, &[(32, 32, [8.0, 8.0, 8.0])]);
        let d = run_on(&node, on_dark).unwrap();
        let l = run_on(&node, on_light).unwrap();
        let dd = d.as_image().unwrap().pixel(36, 32)[1] - 0.02;
        let ll = l.as_image().unwrap().pixel(36, 32)[1] - 0.7;
        assert!(dd > ll * 4.0, "dark surroundings bloom, bright ones barely: {dd} vs {ll}");
    }

    #[test]
    fn a_large_highlight_does_not_hide_its_own_halo() {
        // A 16x16 window on a dark field: with the gate at full, its
        // edge blooms the same as with the gate off, since the window's
        // own light is not its backdrop. The old gate read the window's
        // mean as bright surroundings and cut the halo at its edge.
        let dark = 0.02;
        let mut img = ImageBuf::filled(96, 96, [dark, dark, dark, 1.0]);
        for y in 40..56 {
            for x in 40..56 {
                img.set_pixel(x, y, [8.0, 8.0, 8.0, 1.0]);
            }
        }
        let mut gated = make_node("heeler.halation");
        set_num(&mut gated, "radius", 6.0);
        set_num(&mut gated, "saturation", 0.0);
        set_num(&mut gated, "background", 100.0);
        let mut open = gated.clone();
        set_num(&mut open, "background", 0.0);
        let g = run_on(&gated, img.clone()).unwrap();
        let o = run_on(&open, img).unwrap();
        let halo = |v: &Value| v.as_image().unwrap().pixel(60, 48)[1] - dark;
        let (hg, ho) = (halo(&g), halo(&o));
        assert!(ho > 0.01, "the window blooms with the gate off: {ho}");
        assert!(hg > ho * 0.9, "and as much with the gate at full: {hg} vs {ho}");
    }

    #[test]
    fn blue_compensation_and_depth_weighting_lift_what_would_be_lost() {
        let mut plain = make_node("heeler.halation");
        set_num(&mut plain, "background", 0.0);
        set_num(&mut plain, "radius", 6.0);
        let mut comp = make_node("heeler.halation");
        set_num(&mut comp, "background", 0.0);
        set_num(&mut comp, "radius", 6.0);
        set_num(&mut comp, "blue_comp", 100.0);
        let blue = scene(64, 64, 0.05, &[(32, 32, [1.0, 2.0, 12.0])]);
        let a = run_on(&plain, blue.clone()).unwrap();
        let b = run_on(&comp, blue).unwrap();
        let (ra, rb) = (a.as_image().unwrap().pixel(36, 32)[0] - 0.05, b.as_image().unwrap().pixel(36, 32)[0] - 0.05);
        assert!(rb > ra * 1.5, "blue compensation lifts a blue source's halo: {ra} vs {rb}");
        // By depth: the same highlight far blooms more than near.
        let mut deep = make_node("heeler.halation");
        set_num(&mut deep, "background", 0.0);
        set_num(&mut deep, "radius", 6.0);
        set_num(&mut deep, "by_depth", 100.0);
        let img = scene(64, 64, 0.05, &[(32, 32, [8.0, 8.0, 8.0])]);
        let run = |far: f32| {
            let plane = ImageBuf::filled(64, 64, [far, far, far, 1.0]);
            let out = crate::ops::execute(&deep, &[("in".to_string(), Value::Image(Arc::new(img.clone()))), ("raster".to_string(), Value::Image(Arc::new(plane)))]).unwrap();
            out.as_image().unwrap().pixel(36, 32)[1] - 0.05
        };
        let (far, near) = (run(1.0), run(0.0));
        assert!(far > 0.005 && far > near * 3.0 + 1e-4, "far blooms more than near: {far} vs {near}");
    }

    #[test]
    fn the_source_view_shows_the_gated_regions_and_formats_scale_the_spread() {
        let mut node = make_node("heeler.halation");
        set_num(&mut node, "background", 0.0);
        set_text(&mut node, "view", "source");
        let img = scene(32, 32, 0.05, &[(16, 16, [8.0, 8.0, 8.0])]);
        let out = run_on(&node, img.clone()).unwrap();
        let out = out.as_image().unwrap();
        assert!((out.pixel(16, 16)[0] - 1.0).abs() < 1e-5 && out.pixel(2, 2)[0] == 0.0, "the source, white where it blooms, black elsewhere");
        let mut small = make_node("heeler.halation");
        set_num(&mut small, "background", 0.0);
        set_num(&mut small, "radius", 4.0);
        set_num(&mut small, "saturation", 0.0);
        set_text(&mut small, "format", "8mm");
        let mut large = make_node("heeler.halation");
        set_num(&mut large, "background", 0.0);
        set_num(&mut large, "radius", 4.0);
        set_num(&mut large, "saturation", 0.0);
        set_text(&mut large, "format", "65mm");
        let big = scene(64, 64, 0.05, &[(32, 32, [8.0, 8.0, 8.0])]);
        let s = run_on(&small, big.clone()).unwrap();
        let l = run_on(&large, big).unwrap();
        let (ss, ll) = (s.as_image().unwrap().pixel(44, 32)[1] - 0.05, l.as_image().unwrap().pixel(44, 32)[1] - 0.05);
        assert!(ss > ll * 2.0 + 1e-4, "8mm spreads farther than 65mm: {ss} vs {ll}");
    }
}
