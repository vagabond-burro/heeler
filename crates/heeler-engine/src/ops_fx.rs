//! Layer effects: shadow, glow, overlays and bevel.
//!
//! Every one of these is a function of the layer's ALPHA. That is the
//! whole design: a paint layer knows where it is and where it is not,
//! so "just outside the edge" (shadow and glow) and "just inside
//! it" (inner shadow, bevel) are all derived rather than authored, and
//! nothing here needs a second buffer of stored pixels.
//!
//! Effects are nodes on a chain, so a layer can carry two glows at
//! different radii and change their order while editing the photograph.

use std::sync::Arc;

use heeler_graph::Node;

use crate::buffers::{ImageBuf, Value};
use crate::executor::EngineError;
use crate::ops::{image_input, p, p_bool, px_scale};
use crate::ops_detail::gaussian_blur_wide;
use crate::ops_masks::parse_hex_display;

/// The layer's alpha, blurred and optionally shifted, as its own plane.
///
/// Shifting before blurring rather than after is what makes a dropped
/// shadow soften around its offset instead of smearing towards it.
///
/// Sigma is HALF the size, not the third a blur radius uses. The blur
/// convention puts the stated radius at the far tail, which is right
/// when you are softening a picture and wrong when you are spreading an
/// edge: a shadow of size 12 has to be visible twelve pixels out, not
/// almost gone. The result is then gained to saturation, so the spread
/// sits solid against the shape and tapers outward, which is the shape
/// every app's shadow and glow actually have.
///
/// `gain` is that saturation. The bevel asks for 1.0 instead: it reads
/// the SLOPE of this plane as a surface normal, and a saturated plane
/// is flat, which would light nothing at all.
fn spread_alpha(
    src: &ImageBuf,
    radius: f32,
    dx: f32,
    dy: f32,
    invert: bool,
    gain: f32,
) -> Vec<f32> {
    let (w, h) = (src.width, src.height);
    // Keep the shifted silhouette beyond the frame while it softens
    // back into view. Clamp-to-edge on the original frame turned a
    // border pixel into a bar, and cutting before blur lost shadows.
    let sigma = radius / 2.0;
    let pad = (2.5 * sigma).ceil() as usize + dx.abs().ceil().max(dy.abs().ceil()) as usize + 1;
    let (pw, ph) = (w + 2 * pad, h + 2 * pad);
    let mut plane = ImageBuf::new(pw, ph);
    let alpha_at = |x: i64, y: i64| {
        if x < 0 || y < 0 || x >= w as i64 || y >= h as i64 { 0.0 }
        else { src.pixel(x as usize, y as usize)[3].clamp(0.0, 1.0) }
    };
    use rayon::prelude::*;
    plane.data.par_chunks_mut(pw * 4).enumerate().for_each(|(y, row)| {
        for x in 0..pw {
            // Fractional offsets survive a reduced preview instead of
            // rounding to different photograph pixels at each tier.
            let fx = x as f32 - pad as f32 - dx;
            let fy = y as f32 - pad as f32 - dy;
            let (ix, iy) = (fx.floor() as i64, fy.floor() as i64);
            let (tx, ty) = (fx - ix as f32, fy - iy as f32);
            let a = alpha_at(ix, iy) * (1.0 - tx) * (1.0 - ty)
                + alpha_at(ix + 1, iy) * tx * (1.0 - ty)
                + alpha_at(ix, iy + 1) * (1.0 - tx) * ty
                + alpha_at(ix + 1, iy + 1) * tx * ty;
            row[x * 4] = if invert { 1.0 - a } else { a };
            row[x * 4 + 3] = 1.0;
        }
    });
    if radius >= 0.5 {
        // Wide effects use the same reduced Gaussian as wide Blur,
        // rather than hundreds of taps per full-resolution pixel.
        plane = gaussian_blur_wide(&plane, sigma.max(0.3));
    }
    let mut out = vec![0.0f32; w * h];
    out.par_chunks_mut(w).enumerate().for_each(|(y, row)| {
        for (x, o) in row.iter_mut().enumerate() {
            *o = (plane.data[((y + pad) * pw + x + pad) * 4] * gain).clamp(0.0, 1.0);
        }
    });
    out
}

fn color_of(node: &Node, key: &str, fallback: [f32; 3]) -> [f32; 3] {
    node.params
        .get(key)
        .and_then(|v| v.as_str())
        .and_then(parse_hex_display)
        .unwrap_or(fallback)
}

/// Shadow and glow: the same effect pointed two ways.
///
/// Outer lays color under the layer where the spread alpha reaches
/// past it; inner lays color over the layer where the surround's
/// spread reaches in. A glow is a shadow with no offset, which is why
/// both node types run this.
pub(crate) fn shadow(node: &Node, inputs: &[(String, Value)]) -> Result<Value, EngineError> {
    let src = image_input(inputs, "in", &node.id)?;
    let (w, h) = (src.width, src.height);
    let scale = px_scale(&node.params);
    let size = p(&node.params, "size", 12.0).max(0.0) * scale;
    let distance = p(&node.params, "distance", 0.0).max(0.0) * scale;
    let angle = p(&node.params, "angle", 135.0).to_radians();
    let opacity = (p(&node.params, "opacity", 75.0) / 100.0).clamp(0.0, 1.0);
    let inner = p_bool(&node.params, "inner", false);
    let color = color_of(node, "color", [0.0, 0.0, 0.0]);
    // Screen coordinates: y grows downward, so a 135-degree light puts
    // its shadow down and to the right the way every app draws it.
    let (dx, dy) = (-distance * angle.cos(), distance * angle.sin());

    let spread = spread_alpha(src, size, dx, dy, inner, 2.0);
    let mut out = ImageBuf::new(w, h);
    // PERF: the composite ran serially with a src.pixel() call (and its
    // bounds math) per pixel. It now parallelizes over pixel chunks and
    // indexes the source directly; each pixel runs the same inner/outer
    // branch on the same inputs, so bits are unchanged.
    use rayon::prelude::*;
    out.data
        .par_chunks_mut(4)
        .zip(src.data.par_chunks(4))
        .zip(spread.par_iter())
        .for_each(|((o, px), &sp)| {
            let la = px[3];
            let s = sp * opacity;
            if inner {
                // Inside the layer only, over the top of it.
                let k = (s * la).clamp(0.0, 1.0);
                for c in 0..3 {
                    o[c] = px[c] + (color[c] - px[c]) * k;
                }
                o[3] = la;
            } else {
                // Under the layer: the layer composites over the shadow.
                let out_a = la + s * (1.0 - la);
                for c in 0..3 {
                    o[c] = (px[c] * la + color[c] * s * (1.0 - la)) / out_a.max(1e-6);
                }
                o[3] = out_a;
            }
        });
    Ok(Value::Image(Arc::new(out)))
}

/// A flat color over the layer, kept inside its own alpha.
pub(crate) fn color_overlay(node: &Node, inputs: &[(String, Value)]) -> Result<Value, EngineError> {
    let src = image_input(inputs, "in", &node.id)?;
    let opacity = (p(&node.params, "opacity", 100.0) / 100.0).clamp(0.0, 1.0);
    let color = color_of(node, "color", [0.5, 0.5, 0.5]);
    let mut out = (**src).clone();
    // PERF: the tint ran serially; it is a per-pixel lerp on the pixel's
    // own channels, so the parallel chunks compute the same values.
    use rayon::prelude::*;
    out.data.par_chunks_mut(4).for_each(|o| {
        for c in 0..3 {
            let v = o[c];
            o[c] = v + (color[c] - v) * opacity;
        }
    });
    Ok(Value::Image(Arc::new(out)))
}

/// A gradient over the layer, kept inside its own alpha. Shares the
/// gradient layer's stop machinery, so the midpoint weighting and the
/// frame-relative geometry are the same here as there.
pub(crate) fn gradient_overlay(
    node: &Node,
    inputs: &[(String, Value)],
) -> Result<Value, EngineError> {
    let src = image_input(inputs, "in", &node.id)?;
    let (w, h) = (src.width, src.height);
    let opacity = (p(&node.params, "opacity", 100.0) / 100.0).clamp(0.0, 1.0);
    let angle = p(&node.params, "angle", 0.0).to_radians();
    let radial = node
        .params
        .get("shape")
        .and_then(|v| v.as_str())
        .map(|s| s == "radial")
        .unwrap_or(false);
    let stops = crate::ops_retouch::ParsedStops::new(&crate::ops_retouch::stops_of(node));
    let mut out = (**src).clone();
    // PERF: gradient_t re-reads the four roi params out of the map on
    // every pixel (plus re-deriving aspect/sin/cos/span) and sample_stops
    // re-parsed every stop's hex string per pixel, which at frame size
    // costs far more than the gradient math itself. GradientGeom and
    // ParsedStops hoist both, holding gradient_t's exact expression order,
    // then the rows run in parallel: each pixel's t is an independent
    // pure function of (x, y) and the hoisted constants, and the lerp
    // into out is per-pixel too, so every bit matches the serial loop,
    // alpha untouched exactly as before.
    let geom = crate::ops_retouch::GradientGeom::new(node, w, h, radial, angle);
    use rayon::prelude::*;
    out.data.par_chunks_mut(w * 4).enumerate().for_each(|(y, out_row)| {
        for x in 0..w {
            let t = geom.t(x, y, w, h);
            let (g, stop_alpha) = stops.sample(t);
            for c in 0..3 {
                let v = out_row[x * 4 + c];
                out_row[x * 4 + c] = v + (g[c] - v) * opacity * stop_alpha;
            }
        }
    });
    Ok(Value::Image(Arc::new(out)))
}

/// Bevel and emboss: light the layer as though its alpha were a hill.
///
/// The slope of the blurred alpha is the surface normal, so an edge
/// facing the light takes the highlight and the opposite edge takes the
/// shadow. Depth is how steep the hill is, size how far it is rounded
/// off before the slope is measured.
pub(crate) fn bevel(node: &Node, inputs: &[(String, Value)]) -> Result<Value, EngineError> {
    let src = image_input(inputs, "in", &node.id)?;
    let (w, h) = (src.width, src.height);
    let scale = px_scale(&node.params);
    let size = p(&node.params, "size", 6.0).max(1.0) * scale;
    let depth = (p(&node.params, "depth", 100.0) / 100.0).max(0.0) * scale;
    let angle = p(&node.params, "angle", 135.0).to_radians();
    let opacity = (p(&node.params, "opacity", 75.0) / 100.0).clamp(0.0, 1.0);
    let hi = color_of(node, "highlight", [1.0, 1.0, 1.0]);
    let lo = color_of(node, "shadow", [0.0, 0.0, 0.0]);
    // Which way the light COMES FROM, which is the opposite of the way
    // a shadow at this angle falls: at 135 degrees the light is up and
    // to the left, so a shadow drops down and to the right and the
    // upper-left edge is the one that catches the light.
    let (lx, ly) = (angle.cos(), -angle.sin());

    let a = spread_alpha(src, size, 0.0, 0.0, false, 1.0);
    let at = |x: usize, y: usize| a[y.min(h - 1) * w + x.min(w - 1)];
    let mut out = (**src).clone();
    // PERF: the lighting pass ran serially. It now parallelizes over
    // rows; each pixel reads the same four spread taps and its own
    // source pixel, and the slope math per pixel is the serial loop's,
    // so bits are unchanged.
    use rayon::prelude::*;
    out.data.par_chunks_mut(w * 4).enumerate().for_each(|(y, row)| {
        for x in 0..w {
            let xm = x.saturating_sub(1);
            let ym = y.saturating_sub(1);
            let gx = at((x + 1).min(w - 1), y) - at(xm, y);
            let gy = at(x, (y + 1).min(h - 1)) - at(x, ym);
            // The beveled surface tilts AWAY from the shape's center,
            // so its normal is the negated alpha gradient. Positive
            // where that normal faces the light, negative where it
            // faces away; a flat interior has no slope and no lighting.
            let lit = -(gx * lx + gy * ly) * depth * 4.0;
            let i = x * 4;
            let la = row[i + 3];
            if la <= 0.0 || lit.abs() < 1e-4 {
                continue;
            }
            let k = (lit.abs().min(1.0)) * opacity * la;
            let target = if lit > 0.0 { hi } else { lo };
            for c in 0..3 {
                let v = row[i + c];
                row[i + c] = v + (target[c] - v) * k;
            }
        }
    });
    Ok(Value::Image(Arc::new(out)))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ops::test_util::*;
    use heeler_graph::ParamValue;

    /// An opaque square in the middle of a transparent canvas: the
    /// shape every one of these effects is a function of.
    fn square(size: usize) -> ImageBuf {
        let mut img = ImageBuf::new(size, size);
        let (lo, hi) = (size / 4, size * 3 / 4);
        for y in lo..hi {
            for x in lo..hi {
                img.set_pixel(x, y, [0.5, 0.5, 0.5, 1.0]);
            }
        }
        img
    }

    fn set(node: &mut heeler_graph::Node, k: &str, v: f64) {
        node.params.insert(k.into(), ParamValue::Number(v));
    }

    #[test]
    fn an_outer_shadow_lands_outside_the_layer_and_offset() {
        let mut node = make_node("heeler.fx_shadow");
        set(&mut node, "size", 4.0);
        set(&mut node, "distance", 6.0);
        set(&mut node, "angle", 135.0);
        set(&mut node, "opacity", 100.0);
        let out = run_on(&node, square(64)).unwrap();
        let img = out.as_image().unwrap();
        // Down and to the right of the square's bottom-right corner.
        assert!(img.pixel(50, 50)[3] > 0.2, "shadow fell where the light says");
        // Up and to the left is where the light comes from: nothing.
        assert!(img.pixel(12, 12)[3] < 0.05, "and nowhere on the lit side");
        // The layer itself is untouched in the middle.
        let mid = img.pixel(32, 32);
        assert!((mid[0] - 0.5).abs() < 0.01 && mid[3] > 0.99);
    }

    #[test]
    fn an_inner_shadow_stays_inside_and_never_grows_the_layer() {
        let mut node = make_node("heeler.fx_shadow");
        set(&mut node, "size", 5.0);
        set(&mut node, "distance", 0.0);
        set(&mut node, "opacity", 100.0);
        node.params.insert("inner".into(), ParamValue::Bool(true));
        let plain = square(64);
        let out = run_on(&node, plain.clone()).unwrap();
        let img = out.as_image().unwrap();
        // Alpha is exactly what it was: an inner effect cannot spread.
        for i in 0..64 * 64 {
            assert_eq!(img.data[i * 4 + 3], plain.data[i * 4 + 3]);
        }
        // Darker just inside the edge than in the middle.
        assert!(img.pixel(18, 32)[0] < img.pixel(32, 32)[0] - 0.05);
    }

    #[test]
    fn a_glow_is_a_shadow_with_nowhere_to_fall() {
        let mut node = make_node("heeler.fx_glow");
        set(&mut node, "size", 5.0);
        set(&mut node, "opacity", 100.0);
        let out = run_on(&node, square(64)).unwrap();
        let img = out.as_image().unwrap();
        // Even on every side, since there is no offset.
        let l = img.pixel(13, 32)[3];
        let r = img.pixel(50, 32)[3];
        let t = img.pixel(32, 13)[3];
        assert!(l > 0.1 && (l - r).abs() < 0.02 && (l - t).abs() < 0.02, "{l} {r} {t}");
    }

    #[test]
    fn the_overlays_recolour_only_where_the_layer_is() {
        let mut node = make_node("heeler.fx_color_overlay");
        set(&mut node, "opacity", 100.0);
        set_text(&mut node, "color", "#0000ff");
        let out = run_on(&node, square(48)).unwrap();
        let img = out.as_image().unwrap();
        assert!(img.pixel(24, 24)[2] > 0.9 && img.pixel(24, 24)[0] < 0.1);
        // Alpha is untouched, so nothing appears outside the shape.
        assert_eq!(img.pixel(2, 2)[3], 0.0);

        let mut grad = make_node("heeler.fx_gradient_overlay");
        set(&mut grad, "opacity", 100.0);
        set_text(&mut grad, "color_a", "#000000");
        set_text(&mut grad, "color_b", "#ffffff");
        let out = run_on(&grad, square(48)).unwrap();
        let img = out.as_image().unwrap();
        assert!(img.pixel(13, 24)[0] < img.pixel(34, 24)[0], "dark to light across");
        assert_eq!(img.pixel(2, 2)[3], 0.0);
    }

    #[test]
    fn a_bevel_lights_one_edge_and_shades_the_other() {
        let mut node = make_node("heeler.fx_bevel");
        set(&mut node, "size", 4.0);
        set(&mut node, "depth", 100.0);
        set(&mut node, "angle", 135.0);
        set(&mut node, "opacity", 100.0);
        let out = run_on(&node, square(64)).unwrap();
        let img = out.as_image().unwrap();
        // Light from the upper left: the top-left inside edge lifts,
        // the bottom-right inside edge drops.
        let lit = img.pixel(17, 32)[0];
        let shaded = img.pixel(46, 32)[0];
        assert!(lit > 0.55, "lit edge brightened, got {lit}");
        assert!(shaded < 0.45, "opposite edge darkened, got {shaded}");
        // Alpha never changes: a bevel is lighting, not spreading.
        assert_eq!(img.pixel(2, 2)[3], 0.0);
    }
}

#[cfg(test)]
mod wiring_tests {
    use super::*;
    use crate::ops::test_util::*;

    #[test]
    fn gradient_overlay_reaches_the_layer_through_the_registry() {
        // Through make_node, which instantiates from the registry the
        // same way a real graph does: if a param is named differently
        // in the spec than the op reads it, this is where it shows.
        let mut node = make_node("heeler.fx_gradient_overlay");
        set_text(&mut node, "color_a", "#ff0000");
        set_text(&mut node, "color_b", "#0000ff");
        let mut img = ImageBuf::new(32, 8);
        for y in 0..8 {
            for x in 0..32 {
                img.set_pixel(x, y, [0.5, 0.5, 0.5, 1.0]);
            }
        }
        let out = run_on(&node, img).unwrap();
        let img = out.as_image().unwrap();
        let left = img.pixel(1, 4);
        let right = img.pixel(30, 4);
        assert!(left[0] > 0.8 && left[2] < 0.2, "left is the first stop: {left:?}");
        assert!(right[2] > 0.8 && right[0] < 0.2, "right is the second: {right:?}");
    }
}
