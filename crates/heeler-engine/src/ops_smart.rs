//! The Smart Mask op: the engine's half of smart selection, which
//! knows NOTHING about ML. It receives the model's soft raster as an
//! injected "raster" input (the executor plants it from the desktop's
//! cache, the way sources are planted) and applies the post-dials:
//! threshold, expand, feather, invert. No raster means an empty mask,
//! never an error: a graph opened on a machine without the model
//! still renders, and the UI wears the badge.

use std::sync::Arc;

use heeler_graph::Node;

use crate::buffers::{MaskBuf, Value};
use crate::executor::EngineError;
use crate::ops::{box_blur_pass, image_input, p, p_bool};

/// The soft band around the threshold: a hard step aliases the mask
/// edge, and SAM's confidence falls off over a few percent anyway.
const EDGE: f32 = 0.05;

fn smoothstep(lo: f32, hi: f32, v: f32) -> f32 {
    let t = ((v - lo) / (hi - lo)).clamp(0.0, 1.0);
    t * t * (3.0 - 2.0 * t)
}

pub(crate) fn smart_mask(node: &Node, inputs: &[(String, Value)]) -> Result<Value, EngineError> {
    let src = image_input(inputs, "in", &node.id)?;
    let (w, h) = (src.width, src.height);
    let raster = inputs.iter().find(|(port, _)| port == "raster").and_then(|(_, v)| v.as_image());

    let mut mask = MaskBuf::new(w, h);
    let Some(raster) = raster else {
        // No computed raster: empty, visible, never silent; the
        // desktop side badges it. Shapes added on it still show, and
        // invert still applies: an inverted nothing is everything, and
        // the dial must not read dead.
        crate::ops_selection::combine_drawn_shapes(node, inputs, src, &mut mask)?;
        if p_bool(&node.params, "invert", false) {
            for v in &mut mask.data {
                *v = 1.0;
            }
        }
        crate::ops_masks::depth_weight_mask(node, inputs, &mut mask);
        return Ok(Value::Mask(Arc::new(mask)));
    };

    // The raster arrives at whatever resolution the model ran at (the
    // preview tier); the render may be at another. Bilinear sample of
    // the R channel bridges them.
    // PERF: the resample, the threshold cut, the expand re-cut and the
    // invert below all ran serially; each is per-pixel pure (the resample
    // reads the same four texels and lerps in the same order per pixel),
    // so the parallel rows and maps are bit for bit.
    use rayon::prelude::*;
    resample_r(raster, &mut mask);

    // Threshold: the dial cuts the model's confidence surface, soft
    // over a small band so the edge stays an edge and not a staircase.
    let t = (p(&node.params, "threshold", 50.0).clamp(0.0, 100.0) / 100.0).clamp(EDGE, 1.0 - EDGE);
    mask.data.par_iter_mut().for_each(|v| {
        *v = smoothstep(t - EDGE, t + EDGE, *v);
    });

    // Expand or contract: blur the cut mask, then re-cut it low (grow)
    // or high (shrink). Blur radius carries the amount, so the control
    // is continuous and its cost tracks its size.
    let expand = p(&node.params, "expand", 0.0).clamp(-100.0, 100.0);
    if expand != 0.0 {
        let radius = ((expand.abs() / 100.0) * 0.08 * w.min(h) as f32).max(1.0) as usize;
        let mut scratch = vec![0.0f32; w * h];
        box_blur_pass(&mut mask.data, &mut scratch, w, h, radius);
        let cut = if expand > 0.0 { 0.12 } else { 0.88 };
        mask.data.par_iter_mut().for_each(|v| {
            *v = smoothstep(cut - 0.1, cut + 0.1, *v);
        });
    }

    // The shapes drawn on the mask with the selection tools (2026-10-02:
    // "I tried switching to the selection tool and doing a subtract
    // selection to remove the extra selection but it didn't work"):
    // combined onto the model's cut, after its threshold and expand, which
    // are about the model's confidence, and before the feather and invert,
    // which are about the final shape.
    crate::ops_selection::combine_drawn_shapes(node, inputs, src, &mut mask)?;

    // Feather: the soft edge, after any morphology so it feathers the
    // final shape. Three box passes read as gaussian.
    let feather = p(&node.params, "feather", 0.0).clamp(0.0, 100.0);
    if feather > 0.0 {
        let radius = ((feather / 100.0) * 0.06 * w.min(h) as f32).max(1.0) as usize;
        let mut scratch = vec![0.0f32; w * h];
        for _ in 0..3 {
            box_blur_pass(&mut mask.data, &mut scratch, w, h, radius);
        }
    }

    if p_bool(&node.params, "invert", false) {
        mask.data.par_iter_mut().for_each(|v| {
            *v = 1.0 - *v;
        });
    }
    crate::ops_masks::depth_weight_mask(node, inputs, &mut mask);
    Ok(Value::Mask(Arc::new(mask)))
}

/// The raster's R channel, bilinearly sampled to the mask's size.
fn resample_r(raster: &crate::buffers::ImageBuf, mask: &mut MaskBuf) {
    use rayon::prelude::*;
    let (w, h) = (mask.width, mask.height);
    let (rw, rh) = (raster.width, raster.height);
    mask.data
        .par_chunks_mut(w)
        .enumerate()
        .for_each(|(y, mask_row)| {
            let sy = ((y as f32 + 0.5) * rh as f32 / h as f32 - 0.5).clamp(0.0, (rh - 1) as f32);
            let y0 = sy.floor() as usize;
            let y1 = (y0 + 1).min(rh - 1);
            let fy = sy - y0 as f32;
            for x in 0..w {
                let sx = ((x as f32 + 0.5) * rw as f32 / w as f32 - 0.5).clamp(0.0, (rw - 1) as f32);
                let x0 = sx.floor() as usize;
                let x1 = (x0 + 1).min(rw - 1);
                let fx = sx - x0 as f32;
                let at = |px: usize, py: usize| raster.data[(py * rw + px) * 4];
                let top = at(x0, y0) + (at(x1, y0) - at(x0, y0)) * fx;
                let bot = at(x0, y1) + (at(x1, y1) - at(x0, y1)) * fx;
                mask_row[x] = top + (bot - top) * fy;
            }
        });
}

/// The Object Mask op: the coverage a renderer wrote for the chosen
/// objects, served as a mask. Fed like the Smart Mask, by a raster the
/// desktop planted, but with no threshold and no expand: a
/// Cryptomatte's partial coverage IS the anti-aliased edge, and
/// cutting it would put back the staircase the renderer removed.
/// Feather and invert remain, and the Depth block. No raster (a
/// photograph whose file carries no such matte, or names not chosen
/// yet) is an empty mask, never an error.
pub(crate) fn matte_mask(node: &Node, inputs: &[(String, Value)]) -> Result<Value, EngineError> {
    use rayon::prelude::*;
    let src = image_input(inputs, "in", &node.id)?;
    let (w, h) = (src.width, src.height);
    let raster = inputs.iter().find(|(port, _)| port == "raster").and_then(|(_, v)| v.as_image());
    let mut mask = MaskBuf::new(w, h);
    if let Some(raster) = raster {
        resample_r(raster, &mut mask);
    }
    // Shapes drawn on it with the selection tools, as on a Smart mask.
    crate::ops_selection::combine_drawn_shapes(node, inputs, src, &mut mask)?;
    let feather = p(&node.params, "feather", 0.0).clamp(0.0, 100.0);
    if feather > 0.0 && (raster.is_some() || mask.data.iter().any(|v| *v != 0.0)) {
        let radius = ((feather / 100.0) * 0.06 * w.min(h) as f32).max(1.0) as usize;
        let mut scratch = vec![0.0f32; w * h];
        for _ in 0..3 {
            box_blur_pass(&mut mask.data, &mut scratch, w, h, radius);
        }
    }
    if p_bool(&node.params, "invert", false) {
        mask.data.par_iter_mut().for_each(|v| {
            *v = 1.0 - *v;
        });
    }
    crate::ops_masks::depth_weight_mask(node, inputs, &mut mask);
    Ok(Value::Mask(Arc::new(mask)))
}

/// The Inpaint op: serve the desktop-computed fill, resampled to the
/// render size; the executor's generic mask blending composites it
/// through the hole mask, and without a raster the node is a perfect
/// passthrough (visible via the UI badge, never an error). The
/// amendment's scope lives one level up: the raster ONLY ever exists
/// for a mask the user made.
pub(crate) fn inpaint(node: &Node, inputs: &[(String, Value)]) -> Result<Value, EngineError> {
    let src = image_input(inputs, "in", &node.id)?;
    // No hole, no fill - for the WIRE life: a chain-spliced Remove whose
    // mask wire is gone (its source deleted, say) must not keep serving
    // its raster over the whole frame; the owner hit exactly this. A
    // LAYER-life fill is different: the Finish layer's own mask gates
    // visibility at the blend, so the content serves unmasked and the
    // layer machinery owns its lifecycle.
    let layer_life = node
        .params
        .get("hole")
        .and_then(|v| v.as_str())
        .is_some_and(|h| h == "layer");
    let has_hole = layer_life || inputs.iter().any(|(port, _)| port == "mask");
    let raster = inputs.iter().find(|(port, _)| port == "raster").and_then(|(_, v)| v.as_image());
    let Some(raster) = raster.filter(|_| has_hole) else {
        return Ok(Value::Image(src.clone()));
    };
    let (w, h) = (src.width, src.height);
    if (raster.width, raster.height) == (w, h) {
        return Ok(Value::Image(raster.clone()));
    }
    let (rw, rh) = (raster.width, raster.height);
    let mut out = crate::buffers::ImageBuf::new(w, h);
    // PERF: the resample ran serially; each output pixel reads the same
    // four texels per channel and lerps in the same order, alpha
    // included, so the parallel rows are bit for bit.
    use rayon::prelude::*;
    out.data
        .par_chunks_mut(w * 4)
        .enumerate()
        .for_each(|(y, out_row)| {
            let sy = ((y as f32 + 0.5) * rh as f32 / h as f32 - 0.5).clamp(0.0, (rh - 1) as f32);
            let y0 = sy.floor() as usize;
            let y1 = (y0 + 1).min(rh - 1);
            let fy = sy - y0 as f32;
            for x in 0..w {
                let sx = ((x as f32 + 0.5) * rw as f32 / w as f32 - 0.5).clamp(0.0, (rw - 1) as f32);
                let x0 = sx.floor() as usize;
                let x1 = (x0 + 1).min(rw - 1);
                let fx = sx - x0 as f32;
                for c in 0..4 {
                    let at = |px: usize, py: usize| raster.data[(py * rw + px) * 4 + c];
                    let top = at(x0, y0) + (at(x1, y0) - at(x0, y0)) * fx;
                    let bot = at(x0, y1) + (at(x1, y1) - at(x0, y1)) * fx;
                    out_row[x * 4 + c] = top + (bot - top) * fy;
                }
            }
        });
    Ok(Value::Image(std::sync::Arc::new(out)))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::buffers::ImageBuf;
    use crate::ops::test_util::{make_node, set_num};

    fn feed(w: usize, h: usize) -> (String, Value) {
        ("in".to_string(), Value::Image(Arc::new(ImageBuf::new(w, h))))
    }

    /// A raster image with the soft mask in R: a filled square of
    /// confidence 0.9 on a 0.1 ground.
    fn raster(w: usize, h: usize, x0: usize, y0: usize, x1: usize, y1: usize) -> (String, Value) {
        let mut img = ImageBuf::new(w, h);
        for y in 0..h {
            for x in 0..w {
                let inside = x >= x0 && x < x1 && y >= y0 && y < y1;
                let v = if inside { 0.9 } else { 0.1 };
                img.set_pixel(x, y, [v, v, v, 1.0]);
            }
        }
        (String::from("raster"), Value::Image(Arc::new(img)))
    }

    fn area(m: &Value) -> f32 {
        let m = m.as_mask().unwrap();
        m.data.iter().filter(|v| **v > 0.5).count() as f32
    }

    #[test]
    fn the_object_mask_serves_coverage_uncut() {
        let node = make_node("heeler.matte_mask");
        // Nothing planted: empty, and inverted nothing is everything.
        let out = matte_mask(&node, &[feed(32, 16)]).unwrap();
        assert!(out.as_mask().unwrap().data.iter().all(|v| *v == 0.0));
        // A planted coverage raster is served as it is, resampled:
        // the 0.9 stays 0.9 and the 0.1 stays 0.1, no threshold cut.
        let out = matte_mask(&node, &[feed(200, 100), raster(100, 50, 25, 10, 75, 40)]).unwrap();
        let m = out.as_mask().unwrap();
        assert!((m.data[(50 * 200) + 100] - 0.9).abs() < 1e-5, "inside keeps its partial cover");
        assert!((m.data[(5 * 200) + 5] - 0.1).abs() < 1e-5, "outside keeps its floor");
        let mut inv = make_node("heeler.matte_mask");
        set_num(&mut inv, "invert", 1.0);
        let out = matte_mask(&inv, &[feed(200, 100), raster(100, 50, 25, 10, 75, 40)]).unwrap();
        assert!((out.as_mask().unwrap().data[(50 * 200) + 100] - 0.1).abs() < 1e-5);
        // Feather softens the edge: a pixel just outside the square rises.
        let mut soft = make_node("heeler.matte_mask");
        set_num(&mut soft, "feather", 40.0);
        let out = matte_mask(&soft, &[feed(200, 100), raster(100, 50, 25, 10, 75, 40)]).unwrap();
        assert!(out.as_mask().unwrap().data[(50 * 200) + 48] > 0.15);
    }

    #[test]
    fn no_raster_renders_empty_and_never_errors() {
        let node = make_node("heeler.smart_mask");
        let out = smart_mask(&node, &[feed(64, 48)]).unwrap();
        let m = out.as_mask().unwrap();
        assert_eq!((m.width, m.height), (64, 48));
        assert!(m.data.iter().all(|v| *v == 0.0));
    }

    #[test]
    fn the_raster_is_resampled_to_the_render_size_and_cut_by_threshold() {
        let node = make_node("heeler.smart_mask");
        // Raster at "preview" 100x50, render at 200x100: the square
        // lands scaled.
        let out = smart_mask(&node, &[feed(200, 100), raster(100, 50, 25, 10, 75, 40)]).unwrap();
        let m = out.as_mask().unwrap();
        assert!(m.data[(50 * 200) + 100] > 0.9, "inside the square");
        assert!(m.data[(5 * 200) + 5] < 0.1, "outside it");
        // A threshold above the raster's confidence empties it.
        let mut strict = make_node("heeler.smart_mask");
        set_num(&mut strict, "threshold", 95.0);
        let out = smart_mask(&strict, &[feed(200, 100), raster(100, 50, 25, 10, 75, 40)]).unwrap();
        assert_eq!(area(&out), 0.0);
    }

    #[test]
    fn expand_grows_shrink_shrinks_and_feather_softens() {
        let base = smart_mask(
            &make_node("heeler.smart_mask"),
            &[feed(200, 100), raster(200, 100, 80, 30, 120, 70)],
        )
        .unwrap();
        let mut grow = make_node("heeler.smart_mask");
        set_num(&mut grow, "expand", 60.0);
        let grown = smart_mask(&grow, &[feed(200, 100), raster(200, 100, 80, 30, 120, 70)]).unwrap();
        let mut shrink = make_node("heeler.smart_mask");
        set_num(&mut shrink, "expand", -60.0);
        let shrunk =
            smart_mask(&shrink, &[feed(200, 100), raster(200, 100, 80, 30, 120, 70)]).unwrap();
        assert!(area(&grown) > area(&base) * 1.15, "{} !> {}", area(&grown), area(&base));
        assert!(area(&shrunk) < area(&base) * 0.85, "{} !< {}", area(&shrunk), area(&base));

        // Feather turns the hard edge into a ramp: count in-between
        // values.
        let mut soft = make_node("heeler.smart_mask");
        set_num(&mut soft, "feather", 50.0);
        let feathered =
            smart_mask(&soft, &[feed(200, 100), raster(200, 100, 80, 30, 120, 70)]).unwrap();
        let mid = feathered
            .as_mask()
            .unwrap()
            .data
            .iter()
            .filter(|v| **v > 0.15 && **v < 0.85)
            .count();
        let mid_base =
            base.as_mask().unwrap().data.iter().filter(|v| **v > 0.15 && **v < 0.85).count();
        assert!(mid > mid_base * 4, "feather should widen the in-between band: {mid} vs {mid_base}");
    }

    /// The inpaint op: passthrough without a raster, the raster (sized
    /// to the render) with one; the hole compositing is the executor's
    /// generic mask blend, tested there.
    #[test]
    fn inpaint_serves_the_raster_or_passes_through() {
        let node = make_node("heeler.inpaint");
        let src = {
            let mut img = ImageBuf::new(4, 4);
            for px in img.data.chunks_mut(4) {
                px.copy_from_slice(&[0.3, 0.3, 0.3, 1.0]);
            }
            ("in".to_string(), Value::Image(Arc::new(img)))
        };
        // from_ref: one input, no clone.
        let out = inpaint(&node, std::slice::from_ref(&src)).unwrap();
        assert!(out.as_image().unwrap().data.iter().step_by(4).all(|v| (*v - 0.3).abs() < 1e-6));

        // A half-res raster arrives at render size.
        let mut r = ImageBuf::new(2, 2);
        for px in r.data.chunks_mut(4) {
            px.copy_from_slice(&[0.8, 0.1, 0.1, 1.0]);
        }
        // Without a hole mask the raster must NOT serve: a fill whose
        // mask was deleted is a fill of nothing.
        let orphan = inpaint(
            &node,
            &[src.clone(), ("raster".to_string(), Value::Image(Arc::new(r.clone())))],
        )
        .unwrap();
        assert!(
            orphan.as_image().unwrap().data.iter().step_by(4).all(|v| (*v - 0.3).abs() < 1e-6),
            "no hole, no fill"
        );
        // The layer life serves unmasked: the Finish blend gates it.
        let mut layer_node = make_node("heeler.inpaint");
        crate::ops::test_util::set_text(&mut layer_node, "hole", "layer");
        let served = inpaint(
            &layer_node,
            &[
                ("in".to_string(), Value::Image(Arc::new(ImageBuf::filled(4, 4, [0.3, 0.3, 0.3, 1.0])))),
                ("raster".to_string(), Value::Image(Arc::new(r.clone()))),
            ],
        )
        .unwrap();
        assert!((served.as_image().unwrap().data[0] - 0.8).abs() < 1e-5);
        let hole = {
            let mut m = crate::buffers::MaskBuf::new(4, 4);
            m.data.fill(1.0);
            ("mask".to_string(), Value::Mask(Arc::new(m)))
        };
        let out = inpaint(
            &node,
            &[src, hole, ("raster".to_string(), Value::Image(Arc::new(r)))],
        )
        .unwrap();
        let img = out.as_image().unwrap();
        assert_eq!((img.width, img.height), (4, 4));
        assert!((img.data[0] - 0.8).abs() < 1e-5);
    }

    #[test]
    fn invert_flips_the_answer() {
        let mut node = make_node("heeler.smart_mask");
        set_num(&mut node, "invert", 1.0);
        let out = smart_mask(&node, &[feed(64, 48)]).unwrap();
        assert!(out.as_mask().unwrap().data.iter().all(|v| *v == 1.0));
    }

    /// A shape drawn on a Smart or Object mask with the selection tools
    /// combines onto the coverage (2026-10-02: a Subtract over the
    /// over-selected part "didn't work"): a Subtract rectangle takes the
    /// subject out where it is drawn and nowhere else, at every size the
    /// mask renders; an Add puts its shape in; an Intersect keeps only what
    /// is inside it; invert flips the result.
    #[test]
    fn a_shape_drawn_on_a_smart_or_object_mask_combines_with_it() {
        use crate::ops::test_util::set_text;
        // The subject covers x 0.25..0.75, y 0.2..0.8 of the frame; the
        // Subtract is the right part of it and beyond, x 0.6..1.0.
        let sub = r#"[{"kind":"marquee","op":"subtract","x0":0.6,"y0":0.0,"x1":1.0,"y1":1.0}]"#;
        let add = r#"[{"kind":"marquee","op":"add","x0":0.0,"y0":0.0,"x1":0.1,"y1":0.1}]"#;
        let cut = r#"[{"kind":"marquee","op":"intersect","x0":0.0,"y0":0.0,"x1":0.5,"y1":1.0}]"#;
        for ty in ["heeler.smart_mask", "heeler.matte_mask"] {
            for (w, h) in [(200usize, 100usize), (800, 400)] {
                let at = |m: &Value, fx: f32, fy: f32| {
                    let m = m.as_mask().unwrap();
                    m.data[((fy * h as f32) as usize) * w + (fx * w as f32) as usize]
                };
                let render = |regions: &str, invert: bool| {
                    let mut node = make_node(ty);
                    set_text(&mut node, "regions", regions);
                    if invert {
                        set_num(&mut node, "invert", 1.0);
                    }
                    let f = if ty == "heeler.smart_mask" { smart_mask } else { matte_mask };
                    f(&node, &[feed(w, h), raster(100, 50, 25, 10, 75, 40)]).unwrap()
                };
                let plain = render("[]", false);
                let taken = render(sub, false);
                let label = format!("{ty} at {w}x{h}");
                assert!(at(&plain, 0.7, 0.5) > 0.5, "{label}: the subject is there before the shape");
                assert!(at(&taken, 0.7, 0.5) < 1e-6, "{label}: the Subtract takes it out where drawn");
                assert_eq!(at(&taken, 0.4, 0.5), at(&plain, 0.4, 0.5), "{label}: and nowhere else");
                assert_eq!(at(&taken, 0.1, 0.1), at(&plain, 0.1, 0.1), "{label}: outside stays");
                let added = render(add, false);
                assert!((at(&added, 0.05, 0.05) - 1.0).abs() < 1e-6, "{label}: an Add puts its shape in");
                let kept = render(cut, false);
                assert!(at(&kept, 0.7, 0.5) < 1e-6 && at(&kept, 0.4, 0.5) > 0.5, "{label}: an Intersect keeps what is inside it");
                let flipped = render(sub, true);
                assert!((at(&flipped, 0.7, 0.5) - 1.0).abs() < 1e-6, "{label}: invert flips the result, the shape included");
            }
        }
        // No raster yet: an Add shape still shows.
        let mut node = make_node("heeler.smart_mask");
        set_text(&mut node, "regions", r#"[{"kind":"marquee","op":"add","x0":0.0,"y0":0.0,"x1":0.5,"y1":1.0}]"#);
        let out = smart_mask(&node, &[feed(64, 32)]).unwrap();
        assert!((out.as_mask().unwrap().data[16 * 64 + 8] - 1.0).abs() < 1e-6);
    }
}
