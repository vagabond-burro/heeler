//! The nodes that let a graph do what a layer stack does.
//!
//! The owner asked for three sharpening recipes out of the layer editors,
//! built as nodes rather than layers, and then made the call that matters
//! most here: "Adding more nodes means adding more capabilities rather
//! than rewiring something unnatural to how the engine was working just
//! to match [the layer editor]."
//!
//! Which is why the color-space conversion is two visible nodes instead
//! of something the blend node does behind your back. Overlay and Vivid
//! Light are defined on display-referred values between 0 and 1. This
//! engine works scene-linear, where those same formulas produce a
//! different and much harsher picture, Vivid Light especially since it is
//! a divide. So a recipe that wants a layer editor's numbers moves into display
//! space, does its work, and comes back, and you can see it doing that in
//! the graph and take it apart.
//!
//! The pay-off is that this is not sharpening machinery. It is a general
//! capability: any chain at all can be moved into display space and back.

use std::sync::Arc;

use heeler_graph::Node;

use crate::buffers::{luma, ImageBuf, Value};
use crate::executor::EngineError;
use crate::ops::{image_input, p};

/// The layer editors both label their blur controls "Radius" in pixels, and a
/// gaussian has no radius, it has a sigma. Their Radius IS the sigma (a
/// scientific imaging tool's Gaussian Blur documents its sigma as the same as
/// theirs; the 2026-09-23 Sharpening review measured the recipe both ways and
/// found this mapping reproduces the tutorials' numbers where radius over
/// three read three times soft), so a radius of 20 here softens by the same
/// amount as a radius of 20 there. Until 2026-09-23 this returned a third of
/// the radius; the saved numbers stayed as they were and now blur as the
/// tutorial they came from meant them to (nobody has bought Heeler
/// yet, no migration).
pub fn sigma_for_radius(radius: f32) -> f32 {
    radius.max(0.0)
}

/// sRGB opto-electronic transfer: scene-linear to display-encoded.
fn encode(c: f32) -> f32 {
    // Clamped, and deliberately: display-referred means 0 to 1 by
    // definition. Anything brighter than white is already at white by the
    // time it is in this space, which is why a sharpening block belongs
    // after the tone profile rather than before it.
    let c = c.clamp(0.0, 1.0);
    if c <= 0.0031308 {
        12.92 * c
    } else {
        1.055 * c.powf(1.0 / 2.4) - 0.055
    }
}

fn decode(c: f32) -> f32 {
    let c = c.clamp(0.0, 1.0);
    if c <= 0.04045 {
        c / 12.92
    } else {
        ((c + 0.055) / 1.055).powf(2.4)
    }
}

/// A scene-linear picture in the Finish stack's display space: the same
/// encode the stack's To Display node applies to the photograph, so a
/// File or Catalog source whose `space` is "display" (a Finish image
/// layer, 2026-09-30) composites as itself. Alpha is untouched.
pub fn display_encode_image(src: &ImageBuf) -> ImageBuf {
    map_rgb(src, encode)
}

/// Applies a per-channel function to RGB, leaving alpha alone.
fn map_rgb(src: &ImageBuf, f: impl Fn(f32) -> f32 + Send + Sync) -> ImageBuf {
    let mut out = ImageBuf::new(src.width, src.height);
    use rayon::prelude::*;
    out.data.par_chunks_mut(4).enumerate().for_each(|(px, o)| {
        let i = px * 4;
        for c in 0..3 {
            o[c] = f(src.data[i + c]);
        }
        o[3] = src.data[i + 3];
    });
    out
}

pub(crate) fn to_display(node: &Node, inputs: &[(String, Value)]) -> Result<Value, EngineError> {
    let src = image_input(inputs, "in", &node.id)?;
    let gamma = p(&node.params, "gamma", 0.0);
    // A plain power curve is offered as well as sRGB, since some
    // recipes and most older tutorials assume 2.2 flat.
    let out = if gamma > 0.0 {
        map_rgb(&src, move |c| c.clamp(0.0, 1.0).powf(1.0 / gamma))
    } else {
        map_rgb(&src, encode)
    };
    Ok(Value::Image(Arc::new(out)))
}

pub(crate) fn to_scene(node: &Node, inputs: &[(String, Value)]) -> Result<Value, EngineError> {
    let src = image_input(inputs, "in", &node.id)?;
    let gamma = p(&node.params, "gamma", 0.0);
    let mut out = if gamma > 0.0 {
        map_rgb(&src, move |c| c.clamp(0.0, 1.0).powf(gamma))
    } else {
        map_rgb(&src, decode)
    };
    if let Some(reference) = inputs.iter().find(|(p, _)| p == "reference").and_then(|(_, v)| v.as_image()) {
        if reference.width == out.width && reference.height == out.height {
            for (o, original) in out.data.chunks_exact_mut(4).zip(reference.data.chunks_exact(4)) {
                for c in 0..3 { o[c] += (original[c] - 1.0).max(0.0); }
            }
        }
    }
    Ok(Value::Image(Arc::new(out)))
}

/// 1 minus the value, which is only the inversion anybody means when the
/// numbers are display-encoded. That is the other half of why the
/// conversion nodes exist.
pub(crate) fn invert(node: &Node, inputs: &[(String, Value)]) -> Result<Value, EngineError> {
    let src = image_input(inputs, "in", &node.id)?;
    let amount = p(&node.params, "amount", 1.0).clamp(0.0, 1.0);
    let out = map_rgb(&src, move |c| {
        let inverted = 1.0 - c.clamp(0.0, 1.0);
        c + (inverted - c) * amount
    });
    Ok(Value::Image(Arc::new(out)))
}

/// Straight alpha in, straight alpha out, premultiplied in between. A
/// paint layer is transparent black where nobody painted; averaging that
/// black in was a dark fringe inside every stroke's edge, and copying
/// the center pixel's alpha meant the blur could never spread past the
/// painted footprint. On an opaque photograph this is the identity.
fn premultiply(src: &ImageBuf) -> ImageBuf {
    let mut out = src.clone();
    use rayon::prelude::*;
    out.data.par_chunks_mut(4).for_each(|p| {
        let a = p[3];
        for c in 0..3 {
            p[c] *= a;
        }
    });
    out
}

fn unpremultiply(src: &ImageBuf) -> ImageBuf {
    let mut out = src.clone();
    use rayon::prelude::*;
    out.data.par_chunks_mut(4).for_each(|p| {
        let a = p[3];
        if a > 1e-6 {
            for c in 0..3 {
                // ACCURACY: this used to clamp to [0, 1], which existed for division
                // safety but quietly deleted light: a 2.0 scene-linear highlight came
                // out of any Blur node at 1.0 even with alpha exactly 1 (audit
                // finding, pinned by the detail bench; the owner ruled to fix it). The
                // zero floor stays, the ceiling goes: an unpremultiplied value is a
                // weighted average of the source colors and has no business being
                // capped at display white.
                p[c] = (p[c] / a).max(0.0);
            }
        } else {
            for c in 0..3 {
                p[c] = 0.0;
            }
        }
    });
    out
}

/// A straight average over a square window, done separably.
///
/// Boxier than a gaussian on purpose: it keeps a flat top, which is what
/// makes it read as defocus rather than as softening, and it is what people
/// reach for when they want the blur itself to be visible. All four
/// channels blur: the caller hands over premultiplied data, so coverage
/// softens along with color.
fn box_blur(src: &ImageBuf, radius: usize) -> ImageBuf {
    use rayon::prelude::*;
    if radius == 0 {
        return src.clone();
    }
    let pass = |input: &ImageBuf, horizontal: bool| -> ImageBuf {
        let mut out = ImageBuf::new(input.width, input.height);
        let (w, h) = (input.width as isize, input.height as isize);
        let r = radius as isize;
        // PERF: the two passes used to run serially row by row. They now
        // parallelize over rows; each output pixel still accumulates its
        // 2r+1 taps in the same ascending-k order and divides by the same
        // n, so every pixel's bits are exactly what the serial loop made.
        out.data
            .par_chunks_mut(input.width * 4)
            .enumerate()
            .for_each(|(y, out_row)| {
                let y = y as isize;
                for x in 0..w {
                    let mut acc = [0.0f32; 4];
                    let mut n = 0.0f32;
                    for k in -r..=r {
                        let (sx, sy) = if horizontal { (x + k, y) } else { (x, y + k) };
                        let sx = sx.clamp(0, w - 1) as usize;
                        let sy = sy.clamp(0, h - 1) as usize;
                        let i = (sy * input.width + sx) * 4;
                        for c in 0..4 {
                            acc[c] += input.data[i + c];
                        }
                        n += 1.0;
                    }
                    let o = (x as usize) * 4;
                    for c in 0..4 {
                        out_row[o + c] = acc[c] / n;
                    }
                }
            });
        out
    };
    pass(&pass(src, true), false)
}

/// A streak along one direction, which is what a moving camera leaves.
/// Four channels, like box_blur: the caller's data is premultiplied.
fn motion_blur(src: &ImageBuf, length: f32, angle_deg: f32) -> ImageBuf {
    use rayon::prelude::*;
    let steps = (length.round() as isize).max(1);
    let rad = angle_deg.to_radians();
    let (dx, dy) = (rad.cos(), rad.sin());
    let mut out = ImageBuf::new(src.width, src.height);
    let (w, h) = (src.width as f32, src.height as f32);
    // PERF: the sample loop used to run serially over the whole frame.
    // It now parallelizes over rows; each output pixel still walks the
    // same centered tap sequence (k from -steps/2 to steps/2) with the
    // same clamps and the same divide, so the bits are unchanged.
    out.data
        .par_chunks_mut(src.width * 4)
        .enumerate()
        .for_each(|(y, out_row)| {
            for x in 0..src.width {
                let mut acc = [0.0f32; 4];
                let mut n = 0.0f32;
                // Centered on the pixel, so the streak does not shift the
                // picture sideways as well as smearing it.
                for k in -steps / 2..=steps / 2 {
                    let sx = (x as f32 + dx * k as f32).clamp(0.0, w - 1.0) as usize;
                    let sy = (y as f32 + dy * k as f32).clamp(0.0, h - 1.0) as usize;
                    let i = (sy * src.width + sx) * 4;
                    for c in 0..4 {
                        acc[c] += src.data[i + c];
                    }
                    n += 1.0;
                }
                let o = x * 4;
                for c in 0..4 {
                    out_row[o + c] = acc[c] / n;
                }
            }
        });
    out
}

pub(crate) fn blur(node: &Node, inputs: &[(String, Value)]) -> Result<Value, EngineError> {
    let src = image_input(inputs, "in", &node.id)?;
    let radius = p(&node.params, "radius", 0.0).max(0.0) * crate::ops::px_scale(&node.params);
    if radius <= 0.0 {
        return Ok(Value::Image(src.clone()));
    }
    // "Blur - this is too generic, it should have properties like
    // blur type (Gaussian, Box, Motion, etc)." One node, three characters,
    // which is the shape a node should have: the choice is a property rather
    // than three nodes to pick between. The lenient flavor of the same lookup
    // the split uses: an unknown kind is a gaussian, because that is an honest
    // answer to "blur this" and a saved graph must not stop rendering over a
    // spelling.
    let kind = crate::ops::choice(node, "kind")?;
    let kind = kind.as_str();
    // PERF: for box and motion blurs, premultiply/unpremultiply are both
    // the identity when the frame is opaque (every alpha exactly 1.0)
    // and every RGB is nonnegative, so the two whole-frame passes are
    // skipped. Branch by branch: premultiply multiplies each channel by
    // 1.0, which is exact in f32; the blur then averages 1.0 alphas to
    // exactly 1.0 (box and motion sum n ones, an integer well under
    // 2^24, and divide by the same n); unpremultiply's divide by 1.0 is
    // exact and its zero floor is the identity on the nonnegative
    // averages nonnegative inputs produce, and alpha passes through
    // untouched. (The condition used to demand RGB in [0,1] because
    // unpremultiply clamped to display white; since the highlight
    // ruling removed that ceiling, opaque HDR frames take the fast path
    // too.) The gaussian arm keeps the full round trip: its kernel sum
    // is not provably 1.0 in f32, so the blurred alpha can land an ulp
    // off 1.0 and unpremultiply's divide would change bits. The scan is
    // one parallel pass that short-circuits on the first offender.
    let skip_wrap = matches!(kind, "box" | "motion") && {
        use rayon::prelude::*;
        src.data.par_chunks(4).all(|p| {
            p[3] == 1.0 && p[0] >= 0.0 && p[1] >= 0.0 && p[2] >= 0.0
        })
    };
    if skip_wrap {
        let out = match kind {
            "box" => box_blur(&src, radius.round() as usize),
            _ => motion_blur(&src, radius * 2.0, p(&node.params, "angle", 0.0)),
        };
        return Ok(Value::Image(Arc::new(out)));
    }
    // Premultiplied in between: the Finish Blur effect runs on layer
    // content, which is straight-alpha and transparent where nobody
    // painted. Blurring the straight channels averaged transparent
    // black into every stroke edge, and the old per-pixel alpha copy
    // kept the blur from spreading past the painted footprint.
    let pre = premultiply(&src);
    let out = match kind {
        "box" => box_blur(&pre, radius.round() as usize),
        "motion" => motion_blur(
            &pre,
            radius * 2.0,
            p(&node.params, "angle", 0.0),
        ),
        _ => gaussian_blur_rgba_any_sigma(&pre, sigma_for_radius(radius)),
    };
    Ok(Value::Image(Arc::new(unpremultiply(&out))))
}

/// The premultiplied Gaussian for any sigma: direct up to the width
/// the wide path takes over at, reduced past it (the 2026-09-23
/// Sharpening review's R2: radius 200 on a 6000x4000 frame took 2.1 s
/// on the direct path and 15 ms on the wide one, a 131-frame stall on
/// a drag). The wide path blurs RGB and copies alpha through, so past
/// the threshold the alpha rides in a buffer of its own and is blurred
/// the same way; an opaque frame sees no difference.
fn gaussian_blur_rgba_any_sigma(pre: &ImageBuf, sigma: f32) -> ImageBuf {
    if sigma <= crate::ops_detail::WIDE_BLUR_SIGMA {
        return crate::ops_detail::gaussian_blur_rgba(pre, sigma);
    }
    let mut out = crate::ops_detail::gaussian_blur_wide(pre, sigma);
    let alpha_plane = map_rgb(pre, |_| 0.0);
    let mut alpha_as_rgb = alpha_plane;
    for px in alpha_as_rgb.data.chunks_mut(4) {
        let a = px[3];
        px[0] = a;
        px[1] = a;
        px[2] = a;
    }
    let alpha_blurred = crate::ops_detail::gaussian_blur_wide(&alpha_as_rgb, sigma);
    for (o, a) in out.data.chunks_mut(4).zip(alpha_blurred.data.chunks(4)) {
        o[3] = a[0];
    }
    out
}

/// The High Pass filter as the reference layer editor's is: what is left of the picture
/// once everything softer than the radius has been taken out of it,
/// at HALF strength over mid-gray.
///
/// `0.5 + (src - blur(src)) / 2`, so a flat area comes out mid-gray and only
/// edges depart from it. Mid-gray is exactly the value Overlay and Vivid Light
/// leave alone, which is what makes the result usable as a sharpening layer
/// rather than a brightness change. The half is measured, not chosen
/// (2026-09-23, through the reference editor's scripting bridge, a 64/191 step
/// and a one-pixel line under its High Pass at radius 5, 10 and 25): the
/// residual fits 0.51 of the difference at every radius within half a level,
/// and the blur's sigma is the radius. The owner's recipes and their numbers
/// (Skin Softening's 20 px and 4 px, Hi Pass sharpening) come from layer
/// editor practice, and at full strength every one of them read twice as
/// strong as the tutorial ("it is clear that hi pass is working
/// differently").
pub(crate) fn high_pass(node: &Node, inputs: &[(String, Value)]) -> Result<Value, EngineError> {
    let src = image_input(inputs, "in", &node.id)?;
    let radius = p(&node.params, "radius", 3.0).max(0.0) * crate::ops::px_scale(&node.params);
    Ok(Value::Image(Arc::new(high_pass_buf(&src, radius))))
}

/// The High Pass node's work on a buffer, shared with the Sharpening
/// and Skin Softening tools below so the three cannot drift.
fn high_pass_buf(src: &ImageBuf, radius: f32) -> ImageBuf {
    if radius <= 0.0 {
        return map_rgb(src, |_| 0.5);
    }
    let blurred = crate::ops_detail::gaussian_blur_wide(src, sigma_for_radius(radius));
    let mut out = ImageBuf::new(src.width, src.height);
    use rayon::prelude::*;
    out.data.par_chunks_mut(4).enumerate().for_each(|(px, o)| {
        let i = px * 4;
        for c in 0..3 {
            o[c] = ((src.data[i + c] - blurred.data[i + c]) * 0.5 + 0.5).clamp(0.0, 1.0);
        }
        o[3] = src.data[i + 3];
    });
    out
}

/// The Blur node's gaussian path on a buffer: premultiplied, blurred
/// with the alpha, and divided back out, exactly as `blur` does it.
fn gaussian_like_blur_node(src: &ImageBuf, radius: f32) -> ImageBuf {
    if radius <= 0.0 {
        return src.clone();
    }
    let pre = premultiply(src);
    unpremultiply(&gaussian_blur_rgba_any_sigma(&pre, sigma_for_radius(radius)))
}

/// The Blend node over an opaque base, the path every Develop blend
/// takes: `b + (blended - b) * a`, with `a` the opacity scaled by the
/// top's alpha, and the alpha composed the same way the node composes
/// it. Written out here so the two tools below render bit for bit
/// what their recipe chains rendered.
fn blend_opaque(base: &ImageBuf, top: &ImageBuf, mode: BlendMode, opacity: f32) -> ImageBuf {
    let mut out = ImageBuf::new(base.width, base.height);
    use rayon::prelude::*;
    out.data.par_chunks_mut(4).enumerate().for_each(|(px, o)| {
        let i = px * 4;
        let a = opacity * top.data[i + 3].clamp(0.0, 1.0);
        let ba = base.data[i + 3].clamp(0.0, 1.0);
        let b3 = [base.data[i], base.data[i + 1], base.data[i + 2]];
        let t3 = [top.data[i], top.data[i + 1], top.data[i + 2]];
        let blended = blend_pixel_mode(mode, b3, t3);
        for c in 0..3 {
            o[c] = b3[c] + (blended[c] - b3[c]) * a;
        }
        o[3] = a + ba * (1.0 - a);
    });
    out
}

/// Legacy render-blob compatibility. The app constructs editable groups.
/// Keep this Gaussian recipe in step with those real utility nodes so
/// a saved headless graph does not retain the abandoned guided base.
pub(crate) fn sharpening(node: &Node, inputs: &[(String, Value)]) -> Result<Value, EngineError> {
    let src = image_input(inputs, "in", &node.id)?;
    let radius = p(&node.params, "radius", 3.0).max(0.0) * crate::ops::px_scale(&node.params);
    let intensity = (p(&node.params, "intensity", 50.0) / 100.0).clamp(0.0, 1.0);
    // Off is off, to the bit. The trip through display encoding below
    // clamps at white, so even a no-op pass would bring a specular
    // highlight home at 1.0; the free-tier Unsharp returns early for
    // the same reason.
    if intensity <= 0.0 {
        return Ok(Value::Image(src.clone()));
    }
    let hipass = node.params.get("mode").and_then(|v| v.as_str()) == Some("hipass");
    let display = map_rgb(&src, encode);
    let top = if hipass {
        high_pass_buf(&desaturate_buf(&display, 1.0), radius)
    } else {
        let blurred = gaussian_like_blur_node(&invert_buf(&display, 1.0), radius);
        blend_opaque(&display, &blurred, BlendMode::VividLight, 1.0)
    };
    let over = blend_opaque(&display, &top, BlendMode::Overlay, intensity);
    let keep = (p(&node.params, "keep_color", 100.0) / 100.0).clamp(0.0, 1.0);
    let lum = blend_opaque(&display, &over, BlendMode::Luminosity, 1.0);
    let kept = blend_opaque(&over, &lum, BlendMode::Normal, keep);
    Ok(Value::Image(Arc::new(decode_keeping_highlights(&kept, &src))))
}

/// Back to scene, keeping what was past white. The recipes are
/// display-referred, so they never saw anything past white: a pixel
/// that WAS past white keeps its own scene value plus the signal the
/// recipe computed at its clamped place, so a specular highlight
/// survives, still treated, instead of coming home at 1.0. Pixels in
/// range decode exactly as before, so a migrated graph renders what it
/// rendered everywhere the recipe could see (the 2026-09-23 Sharpening
/// review's fix 1 and R6).
fn decode_keeping_highlights(over: &ImageBuf, src: &ImageBuf) -> ImageBuf {
    let mut out = ImageBuf::new(over.width, over.height);
    use rayon::prelude::*;
    out.data
        .par_chunks_mut(4)
        .enumerate()
        .for_each(|(px, o)| {
            let i = px * 4;
            for c in 0..3 {
                let d = decode(over.data[i + c]);
                let s = src.data[i + c];
                o[c] = if s > 1.0 { s + (d - 1.0) } else { d };
            }
            o[3] = over.data[i + 3];
        });
    out
}

/// Skin Softening as ONE node, for the same reason: the owner's third
/// recipe ("smooth out skin blemishes, yet recover detail"), which was
/// to display, invert, high pass at `softening`, blur at
/// `detail_back`, a Vivid Light blend over the picture, that over the
/// picture at `strength`, to scene. Same steps, same order, same
/// encoding; the mask is the executor's, so a face mask scopes it.
pub(crate) fn skin_soften(node: &Node, inputs: &[(String, Value)]) -> Result<Value, EngineError> {
    let src = image_input(inputs, "in", &node.id)?;
    let softening = p(&node.params, "softening", 8.0).max(0.0);
    let detail_back = p(&node.params, "detail_back", 4.0).max(0.0);
    let strength = (p(&node.params, "strength", 50.0) / 100.0).clamp(0.0, 1.0);
    // Off is off, to the bit, as with Sharpening: the display trip
    // clamps at white.
    if strength <= 0.0 {
        return Ok(Value::Image(src.clone()));
    }
    let display = map_rgb(&src, encode);
    let inverted = invert_buf(&display, 1.0);
    let passed = high_pass_buf(&inverted, softening);
    let blurred = gaussian_like_blur_node(&passed, detail_back);
    let vivid = blend_opaque(&display, &blurred, BlendMode::VividLight, 1.0);
    let over = blend_opaque(&display, &vivid, BlendMode::Normal, strength);
    Ok(Value::Image(Arc::new(decode_keeping_highlights(&over, &src))))
}

/// The Invert node's arithmetic on a buffer, kept as the node writes
/// it (`c + (inverted - c) * amount`) rather than simplified, since a
/// simplification is a rounding step the recipe never took.
fn invert_buf(src: &ImageBuf, amount: f32) -> ImageBuf {
    map_rgb(src, move |c| {
        let inverted = 1.0 - c.clamp(0.0, 1.0);
        c + (inverted - c) * amount
    })
}

/// The Desaturate node's arithmetic on a buffer, likewise verbatim.
fn desaturate_buf(src: &ImageBuf, amount: f32) -> ImageBuf {
    let mut out = ImageBuf::new(src.width, src.height);
    use rayon::prelude::*;
    out.data.par_chunks_mut(4).enumerate().for_each(|(px, o)| {
        let i = px * 4;
        let l = luma(src.data[i], src.data[i + 1], src.data[i + 2]);
        for c in 0..3 {
            let v = src.data[i + c];
            o[c] = v + (l - v) * amount;
        }
        o[3] = src.data[i + 3];
    });
    out
}

/// Takes the color out, keeping the brightness.
///
/// Separate from black_white, which is a look with per-channel weights you
/// dial in. This is the mechanical one a recipe asks for when it says
/// "completely desaturate".
pub(crate) fn desaturate(node: &Node, inputs: &[(String, Value)]) -> Result<Value, EngineError> {
    let src = image_input(inputs, "in", &node.id)?;
    let amount = p(&node.params, "amount", 1.0).clamp(0.0, 1.0);
    let mut out = ImageBuf::new(src.width, src.height);
    use rayon::prelude::*;
    out.data.par_chunks_mut(4).enumerate().for_each(|(px, o)| {
        let i = px * 4;
        let l = luma(src.data[i], src.data[i + 1], src.data[i + 2]);
        for c in 0..3 {
            let v = src.data[i + c];
            o[c] = v + (l - v) * amount;
        }
        o[3] = src.data[i + 3];
    });
    Ok(Value::Image(Arc::new(out)))
}

/// A blend mode, resolved once.
///
/// The owner reported blend modes being slow to edit. The formulas were
/// fine; the dispatch was not. Matching on a string means comparing bytes
/// against nine candidates, and it was happening once per channel per pixel:
/// on a 24 megapixel frame that is seventy million string comparisons to
/// answer a question that has the same answer every time. Resolved once
/// before the loop, the match inside is a jump on a small integer.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BlendMode {
    Normal,
    Multiply,
    Screen,
    Add,
    Overlay,
    HardLight,
    VividLight,
    LinearLight,
    SoftLight,
    Darken,
    Lighten,
    Difference,
    Exclusion,
    ColorBurn,
    ColorDodge,
    // The non-separable four: computed on the whole pixel, not per
    // channel, by recombining hue/saturation/luminosity between the
    // base and the top the way the W3C compositing spec (and the layer
    // editors) do.
    Hue,
    Saturation,
    Color,
    Luminosity,
}

impl BlendMode {
    pub fn parse(mode: &str) -> BlendMode {
        match mode {
            "multiply" => BlendMode::Multiply,
            "screen" => BlendMode::Screen,
            "add" => BlendMode::Add,
            "overlay" => BlendMode::Overlay,
            "hard_light" => BlendMode::HardLight,
            "vivid_light" => BlendMode::VividLight,
            "linear_light" => BlendMode::LinearLight,
            "soft_light" => BlendMode::SoftLight,
            "darken" => BlendMode::Darken,
            "lighten" => BlendMode::Lighten,
            "difference" => BlendMode::Difference,
            "exclusion" => BlendMode::Exclusion,
            "color_burn" => BlendMode::ColorBurn,
            "color_dodge" => BlendMode::ColorDodge,
            "hue" => BlendMode::Hue,
            "saturation" => BlendMode::Saturation,
            "color" => BlendMode::Color,
            "luminosity" => BlendMode::Luminosity,
            _ => BlendMode::Normal,
        }
    }

    /// The modes that recombine whole pixels rather than channels.
    pub fn is_component(self) -> bool {
        matches!(
            self,
            BlendMode::Hue | BlendMode::Saturation | BlendMode::Color | BlendMode::Luminosity
        )
    }

    /// Whether this mode needs both sides between 0 and 1 to mean anything.
    pub fn wants_display(self) -> bool {
        matches!(
            self,
            BlendMode::Overlay
                | BlendMode::HardLight
                | BlendMode::VividLight
                | BlendMode::LinearLight
                | BlendMode::SoftLight
                | BlendMode::Darken
                | BlendMode::Lighten
                | BlendMode::Difference
                | BlendMode::Exclusion
                | BlendMode::ColorBurn
                | BlendMode::ColorDodge
                | BlendMode::Hue
                | BlendMode::Saturation
                | BlendMode::Color
                | BlendMode::Luminosity
        )
    }
}

/// One channel of one blend mode.
///
/// `b` is the base, `t` is what is being laid over it. The formulas are
/// the standard ones, which assume both are display-referred: that is what
/// the conversion nodes are for.
pub fn blend_channel(mode: &str, b: f32, t: f32) -> f32 {
    blend_channel_mode(BlendMode::parse(mode), b, t)
}

/// The same, with the mode already resolved. This is the one the per-pixel
/// loop calls.
pub fn blend_channel_mode(mode: BlendMode, b: f32, t: f32) -> f32 {
    match mode {
        BlendMode::Multiply => b * t,
        BlendMode::Screen => 1.0 - (1.0 - b) * (1.0 - t),
        BlendMode::Add => b + t,
        // Multiply the dark half, screen the light half, judged by the
        // base. Contrast, keeping the base's blacks and whites.
        BlendMode::Overlay => {
            if b <= 0.5 {
                2.0 * b * t
            } else {
                1.0 - 2.0 * (1.0 - b) * (1.0 - t)
            }
        }
        // Overlay with the roles swapped: judged by the top layer.
        BlendMode::HardLight => {
            if t <= 0.5 {
                2.0 * b * t
            } else {
                1.0 - 2.0 * (1.0 - b) * (1.0 - t)
            }
        }
        // Burn below the midpoint, dodge above it, and the reason it is
        // the sharpening mode: a top layer at exactly mid-gray leaves the
        // base alone, and everything either side of that is a very steep
        // change. An inverted blur laid over its own original with this
        // cancels to gray wherever the picture is smooth and departs from
        // gray exactly at the edges.
        BlendMode::VividLight => {
            if t <= 0.5 {
                if t <= 0.0 {
                    0.0
                } else {
                    (1.0 - (1.0 - b) / (2.0 * t)).max(0.0)
                }
            } else if t >= 1.0 {
                1.0
            } else {
                (b / (2.0 * (1.0 - t))).min(1.0)
            }
        }
        // The same shape done by addition rather than division: gentler,
        // and it cannot blow out.
        BlendMode::LinearLight => b + 2.0 * t - 1.0,
        // Soft light, the W3C/SVG formulation, which is the one the layer
        // editors match closely enough that nobody can tell.
        BlendMode::SoftLight => {
            if t <= 0.5 {
                b - (1.0 - 2.0 * t) * b * (1.0 - b)
            } else {
                let d = if b <= 0.25 {
                    ((16.0 * b - 12.0) * b + 4.0) * b
                } else {
                    b.sqrt()
                };
                b + (2.0 * t - 1.0) * (d - b)
            }
        }
        BlendMode::Darken => b.min(t),
        BlendMode::Lighten => b.max(t),
        BlendMode::Difference => (b - t).abs(),
        BlendMode::Exclusion => b + t - 2.0 * b * t,
        BlendMode::ColorBurn => {
            if t <= 0.0 {
                0.0
            } else {
                1.0 - ((1.0 - b) / t).min(1.0)
            }
        }
        BlendMode::ColorDodge => {
            if t >= 1.0 {
                1.0
            } else {
                (b / (1.0 - t)).min(1.0)
            }
        }
        // Component modes have no per-channel meaning; the pixel loop
        // must route them through blend_pixel_mode. Falling through to
        // "top wins" keeps a mis-routed call visible instead of silent.
        BlendMode::Hue | BlendMode::Saturation | BlendMode::Color | BlendMode::Luminosity => t,
        BlendMode::Normal => t,
    }
}

/// The non-separable modes, per the W3C compositing spec (which is the
/// formulation the layer editors match): hue, saturation, color, luminosity
/// recombine whole pixels from the base's and top's HSL components.
pub fn blend_pixel_mode(mode: BlendMode, b: [f32; 3], t: [f32; 3]) -> [f32; 3] {
    fn lum(c: [f32; 3]) -> f32 {
        0.3 * c[0] + 0.59 * c[1] + 0.11 * c[2]
    }
    fn clip_color(c: [f32; 3]) -> [f32; 3] {
        let l = lum(c);
        let n = c[0].min(c[1]).min(c[2]);
        let x = c[0].max(c[1]).max(c[2]);
        let mut out = c;
        if n < 0.0 {
            for v in &mut out {
                *v = l + (*v - l) * l / (l - n).max(1e-6);
            }
        }
        if x > 1.0 {
            for v in &mut out {
                *v = l + (*v - l) * (1.0 - l) / (x - l).max(1e-6);
            }
        }
        out
    }
    fn set_lum(c: [f32; 3], l: f32) -> [f32; 3] {
        let d = l - lum(c);
        clip_color([c[0] + d, c[1] + d, c[2] + d])
    }
    fn sat(c: [f32; 3]) -> f32 {
        c[0].max(c[1]).max(c[2]) - c[0].min(c[1]).min(c[2])
    }
    fn set_sat(c: [f32; 3], s: f32) -> [f32; 3] {
        // Indices of min, mid, max.
        let mut idx = [0usize, 1, 2];
        idx.sort_by(|&a, &b| c[a].partial_cmp(&c[b]).unwrap_or(std::cmp::Ordering::Equal));
        let (lo, mid, hi) = (idx[0], idx[1], idx[2]);
        let mut out = [0.0f32; 3];
        if c[hi] > c[lo] {
            out[mid] = (c[mid] - c[lo]) * s / (c[hi] - c[lo]);
            out[hi] = s;
        }
        out
    }
    match mode {
        BlendMode::Hue => set_lum(set_sat(t, sat(b)), lum(b)),
        BlendMode::Saturation => set_lum(set_sat(b, sat(t)), lum(b)),
        BlendMode::Color => set_lum(t, lum(b)),
        BlendMode::Luminosity => set_lum(b, lum(t)),
        // Separable modes answer per channel; this is only defined for
        // the four above.
        _ => [
            blend_channel_mode(mode, b[0], t[0]),
            blend_channel_mode(mode, b[1], t[1]),
            blend_channel_mode(mode, b[2], t[2]),
        ],
    }
}

/// Whether a mode needs both sides between 0 and 1 to mean anything.
///
/// Every one of these is a piecewise formula split at the midpoint, or a
/// divide by the distance from white. Hand them a scene-linear value of
/// 6.0 and they do not produce a harsher version of the effect, they
/// produce nonsense. Worth being able to ask, so the app can say so
/// rather than rendering something inexplicable.
pub fn mode_wants_display(mode: &str) -> bool {
    BlendMode::parse(mode).wants_display()
}

#[cfg(test)]
mod tests {
    /// The registry declares which answers a choice parameter has, and
    /// the engine is what actually answers them. Nothing else ties the
    /// two together, so this does: a mode on the list that parse() has
    /// never heard of would silently render as Normal, and a mode parse
    /// knows that the list omits is a capability no picker can reach.
    ///
    /// That second half is not hypothetical. The graph inspector offered
    /// nine of the nineteen modes and the layer stack offered all
    /// nineteen, which nobody decided; the list is now one place, and
    /// this is what keeps it honest.
    #[test]
    fn every_declared_blend_mode_is_one_the_engine_parses() {
        let registry = heeler_graph::Registry::builtin();
        let spec = registry.get("heeler.blend").unwrap();
        let declared = &spec.params.iter().find(|p| p.name == "mode").unwrap().choices;
        assert!(!declared.is_empty(), "blend mode should declare its choices");
        for mode in declared {
            if mode == "normal" {
                continue;
            }
            assert_ne!(
                super::BlendMode::parse(mode),
                super::BlendMode::Normal,
                "the registry offers '{mode}', which the engine reads as Normal"
            );
        }
        // And nothing the engine understands is left off the list, which
        // is how ten modes became unreachable from one of the pickers.
        for mode in [
            "multiply", "screen", "add", "overlay", "hard_light", "vivid_light", "linear_light",
            "soft_light", "darken", "lighten", "difference", "exclusion", "color_burn",
            "color_dodge", "hue", "saturation", "color", "luminosity",
        ] {
            assert!(
                declared.iter().any(|c| c == mode),
                "the engine parses '{mode}', which the registry does not offer"
            );
        }
    }

    use super::*;
    use crate::ops::test_util::{make_node, set_num, set_text};
    use std::sync::Arc;

    #[test]
    fn the_separable_modes_match_their_reference_formulas() {
        let cases: [(&str, f32, f32, f32); 8] = [
            ("darken", 0.6, 0.3, 0.3),
            ("lighten", 0.6, 0.3, 0.6),
            ("difference", 0.6, 0.3, 0.3),
            ("exclusion", 0.5, 0.5, 0.5),
            ("color_burn", 0.5, 0.5, 0.0),
            ("color_dodge", 0.25, 0.5, 0.5),
            ("color_burn", 0.5, 0.0, 0.0),
            ("color_dodge", 0.5, 1.0, 1.0),
        ];
        for (mode, b, t, want) in cases {
            let got = blend_channel(mode, b, t);
            assert!((got - want).abs() < 1e-5, "{mode}({b},{t}) = {got}, want {want}");
        }
    }

    #[test]
    fn the_component_modes_recombine_pixels_the_spec_way() {
        let red: [f32; 3] = [0.8, 0.1, 0.1];
        let gray: [f32; 3] = [0.5, 0.5, 0.5];
        let lum = |c: [f32; 3]| 0.3 * c[0] + 0.59 * c[1] + 0.11 * c[2];
        // Color mode: the top's color at the base's luminosity.
        let colored = blend_pixel_mode(BlendMode::Color, gray, red);
        assert!((lum(colored) - lum(gray)).abs() < 1e-3, "color keeps base luma");
        assert!(colored[0] > colored[1], "and takes the top's hue");
        // Luminosity: the base's color at the top's luminosity.
        let lummed = blend_pixel_mode(BlendMode::Luminosity, red, gray);
        assert!((lum(lummed) - lum(gray)).abs() < 1e-3, "luminosity takes top luma");
        // Saturation of a gray top drains the base's color.
        let drained = blend_pixel_mode(BlendMode::Saturation, red, gray);
        assert!((drained[0] - drained[1]).abs() < 1e-3, "gray top desaturates");
        // Hue keeps base luma and saturation but takes top hue.
        let hued = blend_pixel_mode(BlendMode::Hue, red, [0.1, 0.1, 0.9]);
        assert!((lum(hued) - lum(red)).abs() < 1e-3, "hue keeps base luma");
        assert!(hued[2] > hued[0], "and points the top's way");
    }

    fn flat(w: usize, h: usize, v: f32) -> ImageBuf {
        let mut b = ImageBuf::new(w, h);
        for px in 0..w * h {
            for c in 0..3 {
                b.data[px * 4 + c] = v;
            }
            b.data[px * 4 + 3] = 1.0;
        }
        b
    }

    #[test]
    fn display_and_back_is_the_picture_you_started_with() {
        // The whole point of them being a pair.
        for v in [0.0, 0.002, 0.18, 0.5, 0.9, 1.0] {
            let there = encode(v);
            assert!((decode(there) - v).abs() < 1e-5, "{v} came back as {}", decode(there));
        }
        // Middle gray lands near where everyone expects it to.
        assert!((encode(0.18) - 0.461).abs() < 0.005);
    }

    #[test]
    fn mid_grey_over_anything_with_vivid_light_changes_nothing() {
        // This is the property the sharpening recipes are built on: the
        // high-pass layer is gray wherever the picture is smooth, and gray
        // has to be a no-op or the whole frame would shift.
        for b in [0.0, 0.2, 0.5, 0.8, 1.0] {
            assert!(
                (blend_channel("vivid_light", b, 0.5) - b).abs() < 1e-5,
                "vivid light moved {b}",
            );
            assert!((blend_channel("overlay", b, 0.5) - b).abs() < 1e-5, "overlay moved {b}");
        }
    }

    #[test]
    fn vivid_light_does_not_divide_by_zero() {
        // A top layer of pure black or pure white is a division by zero in
        // the naive formula, and a NaN in a picture is a black hole.
        for b in [0.0, 0.5, 1.0] {
            for t in [0.0, 1.0] {
                let v = blend_channel("vivid_light", b, t);
                assert!(v.is_finite(), "vivid light({b},{t}) was not finite");
                assert!((0.0..=1.0).contains(&v), "vivid light({b},{t}) = {v}");
            }
        }
    }

    #[test]
    fn overlay_keeps_the_ends_and_steepens_the_middle() {
        // Black stays black and white stays white, whatever is laid over
        // them; that is what makes it a contrast move rather than a fade.
        assert!((blend_channel("overlay", 0.0, 0.9) - 0.0).abs() < 1e-6);
        assert!((blend_channel("overlay", 1.0, 0.1) - 1.0).abs() < 1e-6);
        // And a bright top layer lifts a mid tone.
        assert!(blend_channel("overlay", 0.6, 0.8) > 0.6);
        assert!(blend_channel("overlay", 0.4, 0.2) < 0.4);
    }

    #[test]
    fn the_modes_that_need_display_space_say_so() {
        for m in ["overlay", "vivid_light", "soft_light", "hard_light", "linear_light"] {
            assert!(mode_wants_display(m), "{m}");
        }
        // These are linear-safe: multiplying light by light is meaningful.
        for m in ["normal", "multiply", "screen", "add"] {
            assert!(!mode_wants_display(m), "{m}");
        }
    }

    #[test]
    fn a_high_pass_of_something_flat_is_flat_grey() {
        // Nothing to separate out, so nothing to sharpen with, and mid
        // gray is the value that changes nothing downstream.
        let img = flat(8, 8, 0.42);
        let mut node = make_node("heeler.high_pass");
        set_num(&mut node, "radius", 4.0);
        let out = high_pass(&node, &[("in".into(), Value::Image(Arc::new(img)))]).unwrap();
        let img = out.as_image().unwrap();
        for px in 0..8 * 8 {
            assert!((img.data[px * 4] - 0.5).abs() < 1e-3, "{}", img.data[px * 4]);
        }
    }

    #[test]
    fn a_high_pass_keeps_the_edge_and_throws_away_the_rest() {
        // Half black, half white: the only thing a high pass should find
        // is the seam down the middle.
        let mut img = ImageBuf::new(16, 4);
        for y in 0..4 {
            for x in 0..16 {
                let v = if x < 8 { 0.2 } else { 0.8 };
                for c in 0..3 {
                    img.data[(y * 16 + x) * 4 + c] = v;
                }
                img.data[(y * 16 + x) * 4 + 3] = 1.0;
            }
        }
        let mut node = make_node("heeler.high_pass");
        set_num(&mut node, "radius", 2.0);
        let out = high_pass(&node, &[("in".into(), Value::Image(Arc::new(img)))]).unwrap();
        let hp = out.as_image().unwrap();
        let at = |x: usize| hp.pixel(x, 2)[0];
        // Far from the edge: flat, so gray.
        assert!((at(0) - 0.5).abs() < 0.02, "left edge was {}", at(0));
        assert!((at(15) - 0.5).abs() < 0.02, "right edge was {}", at(15));
        // Either side of the seam: dark on the dark side, light on the
        // light side, which is exactly the halo that reads as sharpness.
        assert!(at(7) < 0.45, "dark side of the seam was {}", at(7));
        assert!(at(8) > 0.55, "light side of the seam was {}", at(8));
    }

    #[test]
    fn radius_is_the_pixel_count_the_tutorials_mean() {
        // A layer editor's Radius is the sigma, so a radius of 20 here has to
        // soften like a radius of 20 there or every number in every
        // tutorial is wrong (it read three times soft until 2026-09-23).
        assert!((sigma_for_radius(3.0) - 3.0).abs() < 1e-6);
        assert!((sigma_for_radius(20.0) - 20.0).abs() < 1e-6);
        assert_eq!(sigma_for_radius(0.0), 0.0);
        assert_eq!(sigma_for_radius(-5.0), 0.0);
    }

    #[test]
    fn desaturate_leaves_brightness_where_it_was() {
        let mut img = ImageBuf::new(2, 1);
        img.data[..4].copy_from_slice(&[0.8, 0.2, 0.1, 1.0]);
        img.data[4..].copy_from_slice(&[0.1, 0.6, 0.9, 1.0]);
        let node = make_node("heeler.desaturate");
        let out = desaturate(&node, &[("in".into(), Value::Image(Arc::new(img.clone())))]).unwrap();
        let g = out.as_image().unwrap();
        for px in 0..2 {
            let l = luma(
                img.data[px * 4],
                img.data[px * 4 + 1],
                img.data[px * 4 + 2],
            );
            // Gray, and at the brightness it had.
            assert!((g.data[px * 4] - l).abs() < 1e-5);
            assert!((g.data[px * 4] - g.data[px * 4 + 1]).abs() < 1e-6);
            assert!((g.data[px * 4 + 1] - g.data[px * 4 + 2]).abs() < 1e-6);
        }
    }

    #[test]
    fn invert_is_reversible_and_can_be_dialled() {
        let img = flat(4, 4, 0.3);
        let node = |amount: f64| {
            let mut n = make_node("heeler.invert");
            set_num(&mut n, "amount", amount);
            n
        };
        let once = invert(&node(1.0), &[("in".into(), Value::Image(Arc::new(img.clone())))]).unwrap();
        let flipped = once.as_image().unwrap();
        assert!((flipped.data[0] - 0.7).abs() < 1e-6);
        let twice = invert(&node(1.0), &[("in".into(), Value::Image(flipped.clone()))]).unwrap();
        assert!((twice.as_image().unwrap().data[0] - 0.3).abs() < 1e-6);
        // Half way is half way, so the node can be faded rather than only
        // switched.
        let half = invert(&node(0.5), &[("in".into(), Value::Image(Arc::new(img)))]).unwrap();
        assert!((half.as_image().unwrap().data[0] - 0.5).abs() < 1e-6);
    }

    /// A paint layer is straight-alpha: transparent black where nobody
    /// painted. The three blur flavors used to average that black in
    /// (a dark fringe inside every stroke's edge) and copy the center
    /// pixel's alpha (so the blur could never spread past the painted
    /// footprint). Blurring premultiplied and un-premultiplying on the
    /// way out spreads color with its coverage, which is what a layer
    /// blur means everywhere else.
    #[test]
    fn blur_on_a_partly_transparent_layer_spreads_colour_not_black() {
        // One opaque red pixel in a sea of nothing.
        let mut img = ImageBuf::new(9, 9);
        img.set_pixel(4, 4, [1.0, 0.0, 0.0, 1.0]);
        // Motion only spreads along its angle, so it gets a neighbor on
        // the streak; the other two get one above the dot.
        for (kind, at) in [("gaussian", (4usize, 2usize)), ("box", (4, 2)), ("motion", (6, 4))] {
            let mut node = make_node("heeler.blur");
            set_num(&mut node, "radius", 3.0);
            set_text(&mut node, "kind", kind);
            let out = blur(&node, &[("in".into(), Value::Image(Arc::new(img.clone())))]).unwrap();
            let b = out.as_image().unwrap();
            let near = b.pixel(at.0, at.1);
            assert!(
                near[3] > 0.01,
                "{kind}: the blur never left the dot's footprint (alpha {})",
                near[3]
            );
            assert!(
                near[0] > 0.9,
                "{kind}: the spread darkened to {}, averaging the transparent black in",
                near[0]
            );
        }
        // An opaque photograph is alpha 1 everywhere: premultiplying is
        // the identity there, so a Develop blur must not move.
        let photo = flat(8, 8, 0.42);
        let mut node = make_node("heeler.blur");
        set_num(&mut node, "radius", 3.0);
        let out = blur(&node, &[("in".into(), Value::Image(Arc::new(photo)))]).unwrap();
        let b = out.as_image().unwrap();
        for px in 0..8 * 8 {
            assert!((b.data[px * 4] - 0.42).abs() < 1e-3, "opaque moved: {}", b.data[px * 4]);
            assert!(b.data[px * 4 + 3] > 0.99, "opaque lost alpha");
        }
    }
    /// A picture with edges and color for the sharpening tests: a
    /// gradient with a hard step and a colored patch, opaque.
    fn textured(w: usize, h: usize) -> ImageBuf {
        let mut img = ImageBuf::new(w, h);
        for y in 0..h {
            for x in 0..w {
                let i = (y * w + x) * 4;
                let g = x as f32 / w as f32;
                let step = if x > w / 2 { 0.35 } else { 0.0 };
                let patch = if (6..10).contains(&x) && (4..8).contains(&y) { 0.25 } else { 0.0 };
                img.data[i] = (0.08 + g * 0.5 + step + patch).min(1.0);
                img.data[i + 1] = (0.10 + g * 0.3 + step).min(1.0);
                img.data[i + 2] = (0.12 + g * 0.2 + step - patch * 0.4).clamp(0.0, 1.0);
                img.data[i + 3] = 1.0;
            }
        }
        img
    }

    fn node_with(ty: &str, nums: &[(&str, f64)], texts: &[(&str, &str)]) -> Node {
        let mut n = crate::ops::test_util::make_node(ty);
        for (k, v) in nums {
            crate::ops::test_util::set_num(&mut n, k, *v);
        }
        for (k, v) in texts {
            crate::ops::test_util::set_text(&mut n, k, v);
        }
        n
    }

    fn exec1(ty: &str, nums: &[(&str, f64)], texts: &[(&str, &str)], input: &Arc<ImageBuf>) -> Arc<ImageBuf> {
        let n = node_with(ty, nums, texts);
        crate::ops::execute(&n, &[("in".to_string(), Value::Image(input.clone()))])
            .unwrap()
            .as_image()
            .unwrap()
            .clone()
    }

    fn exec_blend(mode: &str, opacity: f64, base: &Arc<ImageBuf>, top: &Arc<ImageBuf>) -> Arc<ImageBuf> {
        let n = node_with("heeler.blend", &[("opacity", opacity)], &[("mode", mode)]);
        crate::ops::execute(
            &n,
            &[
                ("base".to_string(), Value::Image(base.clone())),
                ("blend".to_string(), Value::Image(top.clone())),
            ],
        )
        .unwrap()
        .as_image()
        .unwrap()
        .clone()
    }

    #[test]
    fn legacy_sharpening_matches_the_gaussian_recipe() {
        let (w, h) = (192usize, 16usize);
        let mut img = ImageBuf::new(w, h);
        for y in 0..h {
            for x in 0..w {
                let base = if x < w / 2 { 0.65 } else { 0.15 };
                let tex = 0.03 * (((x * 7 + y * 3) % 5) as f32 / 4.0 - 0.5) * 2.0;
                let v = crate::ops::to_scene((base + tex).clamp(0.0, 1.0));
                img.set_pixel(x, y, [v, v, v, 1.0]);
            }
        }
        let src = Arc::new(img);
        let display = exec1("heeler.to_display", &[], &[], &src);
        for (mode, hipass) in [("vivid", false), ("hipass", true)] {
            let chain = if hipass {
                let desat = exec1("heeler.desaturate", &[("amount", 1.0)], &[], &display);
                let hp = exec1("heeler.high_pass", &[("radius", 3.0)], &[], &desat);
                let over = exec_blend("overlay", 100.0, &display, &hp);
                exec1("heeler.to_scene", &[], &[], &over)
            } else {
                let inv = exec1("heeler.invert", &[("amount", 1.0)], &[], &display);
                let blurred = exec1("heeler.blur", &[("radius", 3.0), ("angle", 0.0)], &[("kind", "gaussian")], &inv);
                let vivid = exec_blend("vivid_light", 100.0, &display, &blurred);
                let over = exec_blend("overlay", 100.0, &display, &vivid);
                exec1("heeler.to_scene", &[], &[], &over)
            };
            let tool = exec1("heeler.sharpening", &[("radius", 3.0), ("intensity", 100.0), ("keep_color", 0.0)], &[("mode", mode)], &src);
            assert!(tool.data.iter().zip(&chain.data).all(|(a,b)| (a-b).abs()<2e-6), "{mode}: legacy rendering must match the editable Gaussian recipe");
        }
    }

    #[test]
    fn skin_softening_matches_the_recipe_chain_tap_for_tap() {
        let src = Arc::new(textured(24, 16));
        let display = exec1("heeler.to_display", &[], &[], &src);
        let inv = exec1("heeler.invert", &[("amount", 1.0)], &[], &display);
        // Radii sized to the 24-pixel plane (the recipe's own 8 and 4
        // would blur the whole of it since the radius became the sigma).
        let hp = exec1("heeler.high_pass", &[("radius", 2.5)], &[], &inv);
        let blurred = exec1("heeler.blur", &[("radius", 1.25), ("angle", 0.0)], &[("kind", "gaussian")], &hp);
        let vivid = exec_blend("vivid_light", 100.0, &display, &blurred);
        let over = exec_blend("normal", 50.0, &display, &vivid);
        let chain = exec1("heeler.to_scene", &[], &[], &over);
        let tool = exec1(
            "heeler.skin_soften",
            &[("softening", 2.5), ("detail_back", 1.25), ("strength", 50.0)],
            &[],
            &src,
        );
        assert_eq!(tool.data, chain.data, "skin softening drifted from the recipe");
        // Strength 0 is the picture untouched, to the encode round trip.
        let off = exec1("heeler.skin_soften", &[("strength", 0.0)], &[], &src);
        for (a, b) in off.data.iter().zip(src.data.iter()) {
            assert!((a - b).abs() < 2e-6, "{a} vs {b}");
        }
        // And it softens: the patch's edge contrast drops.
        let i = (6 * 24 + 5) * 4;
        let j = (6 * 24 + 6) * 4;
        assert!((tool.data[j] - tool.data[i]).abs() < (src.data[j] - src.data[i]).abs());
    }

    /// A vertical step edge, scene-linear, opaque: the derived-values
    /// fixture for the math tests below.
    fn step_edge(w: usize, h: usize, lo_display: f32, hi_display: f32) -> ImageBuf {
        let mut img = ImageBuf::new(w, h);
        let lo = crate::ops::to_scene(lo_display);
        let hi = crate::ops::to_scene(hi_display);
        for y in 0..h {
            for x in 0..w {
                let v = if x < w / 2 { lo } else { hi };
                img.set_pixel(x, y, [v, v, v, 1.0]);
            }
        }
        img
    }

    /// The recipe, computed again from scratch in one dimension: a
    /// vertical edge smoothed horizontally is a one-dimensional problem,
    /// so the reference below convolves the Gaussian along the row with
    /// its own Gaussian weights (clamped at the ends, as the engine's are) and
    /// applies the blend formulas itself. Nothing here calls the
    /// engine's filter or blend code, which is the point of the pin.
    fn reference_sharpen_row(
        row_scene: &[f32],
        radius: f32,
        intensity: f32,
        hipass: bool,
    ) -> Vec<f32> {
        let display: Vec<f32> = row_scene.iter().map(|&c| encode(c)).collect();
        let n = display.len() as isize;
        // Independent, clamped one-dimensional Gaussian convolution.
        let base = |values: &[f32]| -> Vec<f32> {
            let reach = (radius * 2.5).ceil() as isize;
            let kernel: Vec<f32> = (-reach..=reach).map(|k| (-(k*k) as f32 / (2.0*radius*radius)).exp()).collect();
            let sum: f32 = kernel.iter().sum();
            (0..n).map(|x| (-reach..=reach).zip(&kernel).map(|(k,w)| values[(x+k).clamp(0,n-1) as usize]*w/sum).sum()).collect()
        };
        let blurred = if radius <= 0.0 {
            display.iter().map(|&c| 1.0 - c).collect::<Vec<f32>>()
        } else if hipass {
            base(&display)
        } else {
            base(&display).iter().map(|&c| 1.0 - c).collect()
        };
        (0..display.len())
            .map(|x| {
                let b = display[x];
                let t = if hipass {
                    if radius <= 0.0 {
                        0.5
                    } else {
                        ((b - blurred[x]) * 0.5 + 0.5).clamp(0.0, 1.0)
                    }
                } else if radius <= 0.0 {
                    1.0 - b
                } else {
                    blend_channel_mode(BlendMode::VividLight, b, blurred[x])
                };
                let blended = blend_channel_mode(BlendMode::Overlay, b, t);
                let over = b + (blended - b) * intensity;
                decode(over)
            })
            .collect()
    }

    #[test]
    fn a_step_edge_sharpens_by_the_derived_amount() {
        // 0.2 to 0.8 display, both modes, and the node's row must land
        // on the independently derived one.
        let img = step_edge(64, 8, 0.2, 0.8);
        let src = Arc::new(img);
        for (mode, hipass) in [("vivid", false), ("hipass", true)] {
            let out = exec1(
                "heeler.sharpening",
                &[("radius", 3.0), ("intensity", 100.0)],
                &[("mode", mode)],
                &src,
            );
            let row: Vec<f32> = (0..64).map(|x| src.pixel(x, 3)[0]).collect();
            let want = reference_sharpen_row(&row, 3.0, 1.0, hipass);
            for x in 0..64 {
                let got = out.pixel(x, 3)[0];
                assert!(
                    (got - want[x]).abs() < 2e-3,
                    "{mode} at x={x}: got {got}, derived {}",
                    want[x]
                );
            }
            // And the edge really sharpened: the seam is steeper and
            // both sides overshoot.
            let seam_before = src.pixel(33, 3)[0] - src.pixel(31, 3)[0];
            let seam_after = out.pixel(33, 3)[0] - out.pixel(31, 3)[0];
            assert!(seam_after > seam_before, "{mode} did not steepen the seam");
            assert!(out.pixel(31, 3)[0] < src.pixel(31, 3)[0], "{mode}: no dark overshoot");
            assert!(out.pixel(32, 3)[0] > src.pixel(32, 3)[0], "{mode}: no bright overshoot");
        }
    }

    #[test]
    fn luminosity_clips_a_saturated_color_at_the_requested_brightness() {
        // The W3C non-separable reference for red at display luma 0.8.
        // A source above white clips to the same hue here; recipe groups
        // preserve its original scene headroom at the To Scene reference.
        for base in [[1.0, 0.0, 0.0], [2.0, 0.0, 0.0]] {
            let got = blend_pixel_mode(BlendMode::Luminosity, base, [0.8; 3]);
            for (a,b) in got.into_iter().zip([1.0, 5.0/7.0, 5.0/7.0]) {
                assert!((a-b).abs() < 1e-6);
            }
        }
    }

    #[test]
    fn a_flat_field_and_a_gradient_sharpen_to_themselves() {
        // Flat: no edges, so nothing to add. Gradient: the blur of a
        // ramp is the ramp, so the high pass is gray and the inverted
        // blur is the ramp's own negative - both recipes idle.
        let flat = Arc::new(flat(16, 16, 0.42));
        let mut grad = ImageBuf::new(64, 8);
        for y in 0..8 {
            for x in 0..64 {
                let v = crate::ops::to_scene(0.1 + 0.6 * x as f32 / 63.0);
                grad.set_pixel(x, y, [v, v, v, 1.0]);
            }
        }
        let grad = Arc::new(grad);
        for mode in ["vivid", "hipass"] {
            for (name, src) in [("flat", flat.clone()), ("gradient", grad.clone())] {
                let out = exec1(
                    "heeler.sharpening",
                    &[("radius", 3.0), ("intensity", 100.0)],
                    &[("mode", mode)],
                    &src,
                );
                // Interior only: a clamped tap at the frame's edge is a
                // different question than the recipe's math (the box
                // reaches six pixels at this radius).
                for x in 8..56 {
                    let got = out.pixel(x, 4)[0];
                    let want = src.pixel(x, 4)[0];
                    assert!(
                        (got - want).abs() < 2e-3,
                        "{mode} on {name} moved x={x}: {want} -> {got}"
                    );
                }
            }
        }
    }

    #[test]
    fn vivid_light_of_the_inverted_picture_is_mid_grey() {
        // Why radius 0 is safe in Vivid: over its own negative, every
        // interior value lands on the gray that Overlay ignores.
        let mut b = 0.02f32;
        while b < 0.98 {
            let t = blend_channel_mode(BlendMode::VividLight, b, 1.0 - b);
            assert!((t - 0.5).abs() < 1e-6, "vivid({b}, {}) = {t}", 1.0 - b);
            b += 0.03;
        }
    }

    #[test]
    fn radius_zero_is_the_identity_in_both_modes() {
        // Vivid at 0: the inverted blur is the inversion itself, which
        // Vivid Light turns to flat gray (pinned above). Hi Pass at 0 is
        // flat gray by construction. Gray over Overlay is the picture.
        let src = Arc::new(textured(24, 16));
        for mode in ["vivid", "hipass"] {
            let out = exec1(
                "heeler.sharpening",
                &[("radius", 0.0), ("intensity", 100.0)],
                &[("mode", mode)],
                &src,
            );
            for (a, b) in out.data.iter().zip(src.data.iter()) {
                assert!((a - b).abs() < 2e-5, "{mode} at radius 0: {b} -> {a}");
            }
        }
    }

    #[test]
    fn flat_white_survives_the_vivid_guards() {
        // The guard values at t = 0 and t = 1 look dangerous on their
        // own (vivid(1, 0) answers 0), but t = 0 means the whole blur
        // footprint was white, so b = 1 too, and Overlay pins both ends:
        // no hard step for the blur to reveal as banding.
        let white = Arc::new(flat(16, 16, 1.0));
        let black = Arc::new(flat(16, 16, 0.0));
        for (name, src, want) in [("white", white, 1.0), ("black", black, 0.0)] {
            let out = exec1(
                "heeler.sharpening",
                &[("radius", 3.0), ("intensity", 100.0)],
                &[("mode", "vivid")],
                &src,
            );
            for px in 0..16 * 16 {
                assert!(
                    (out.data[px * 4] - want).abs() < 1e-5,
                    "{name} moved: {}",
                    out.data[px * 4]
                );
            }
        }
    }

    #[test]
    fn intensity_is_the_recipes_linear_blend_in_display_space() {
        // Half intensity is the midpoint between off and full - in the
        // display encoding the blend runs in, which is the curve the
        // recipes and the tutorials mean.
        let src = Arc::new(textured(24, 16));
        for mode in ["vivid", "hipass"] {
            let half = exec1("heeler.sharpening", &[("radius", 3.0), ("intensity", 50.0)], &[("mode", mode)], &src);
            let full = exec1("heeler.sharpening", &[("radius", 3.0), ("intensity", 100.0)], &[("mode", mode)], &src);
            for px in 0..24 * 16 {
                for c in 0..3 {
                    let i = px * 4 + c;
                    let d0 = encode(src.data[i].min(1.0));
                    let dh = encode(half.data[i]);
                    let d1 = encode(full.data[i]);
                    let mid = d0 + (d1 - d0) * 0.5;
                    assert!(
                        (dh - mid).abs() < 1e-4,
                        "{mode} px {px} ch {c}: half {dh} is not the midpoint {mid}"
                    );
                }
            }
        }
    }

    #[test]
    fn intensity_zero_hands_the_picture_back_bit_for_bit() {
        // Off must be off, including above white: a specular highlight
        // sits past 1.0 in scene-linear, and a trip through the clamped
        // display recipe would bring it back at white.
        let mut img = textured(24, 16);
        img.data[0] = 2.0;
        img.data[5] = 3.5;
        let src = Arc::new(img);
        for mode in ["vivid", "hipass"] {
            let out = exec1(
                "heeler.sharpening",
                &[("radius", 3.0), ("intensity", 0.0)],
                &[("mode", mode)],
                &src,
            );
            assert_eq!(out.data, src.data, "{mode} at intensity 0 moved the picture");
        }
    }

    #[test]
    fn a_highlight_above_white_survives_sharpening() {
        // A flat super-white field has no edges, so there is nothing to
        // add: the highlight must come back at its own value, not at 1.
        let mut img = ImageBuf::new(8, 8);
        for px in 0..64 {
            img.data[px * 4] = 2.5;
            img.data[px * 4 + 1] = 2.5;
            img.data[px * 4 + 2] = 2.5;
            img.data[px * 4 + 3] = 1.0;
        }
        let src = Arc::new(img);
        for mode in ["vivid", "hipass"] {
            let out = exec1(
                "heeler.sharpening",
                &[("radius", 3.0), ("intensity", 100.0)],
                &[("mode", mode)],
                &src,
            );
            for px in 0..64 {
                assert!(
                    (out.data[px * 4] - 2.5).abs() < 1e-4,
                    "{mode} clamped the highlight to {}",
                    out.data[px * 4]
                );
            }
        }
    }

    #[test]
    fn a_super_white_edge_still_sharpens_without_losing_its_value() {
        // A step from mid gray to 2.0 scene-linear. The bright side is
        // past white, so the display recipe has no headroom there: the
        // sharpening shows as the dark side's dip, and the highlight
        // right at the seam keeps its 2.0 instead of clamping to white
        // (a display-referred editor has nothing above white to give
        // either - the overshoot on that side simply does not exist).
        let mut img = ImageBuf::new(64, 8);
        let mid = crate::ops::to_scene(0.5);
        for y in 0..8 {
            for x in 0..64 {
                let v = if x < 32 { mid } else { 2.0 };
                img.set_pixel(x, y, [v, v, v, 1.0]);
            }
        }
        let src = Arc::new(img);
        for mode in ["vivid", "hipass"] {
            let out = exec1(
                "heeler.sharpening",
                &[("radius", 3.0), ("intensity", 100.0)],
                &[("mode", mode)],
                &src,
            );
            // Far right: untouched highlight, still 2.0.
            assert!((out.pixel(63, 4)[0] - 2.0).abs() < 1e-4, "{mode}: far highlight {}", out.pixel(63, 4)[0]);
            // At the seam's bright side: carried through, not clamped.
            assert!((out.pixel(33, 4)[0] - 2.0).abs() < 1e-4, "{mode}: seam highlight {}", out.pixel(33, 4)[0]);
            // The edge still sharpened: the dark side dips.
            let dip = out.pixel(31, 4)[0];
            assert!(dip < mid, "{mode}: dark side did not dip ({dip} vs {mid})");
        }
    }

    /// A pixel radius is the photograph's pixels: on a reduced buffer the
    /// desktop writes px_scale and the op blurs that fraction of it, so
    /// radius 10 at px_scale 0.5 is radius 5 at 1, for Blur, High Pass
    /// and the unsharp Sharpen alike.
    #[test]
    fn a_pixel_radius_scales_with_the_buffer() {
        let src = Arc::new(textured(48, 32));
        for (ty, extra) in [("heeler.blur", vec![("kind", "gaussian")]), ("heeler.high_pass", vec![])] {
            let scaled = exec1(ty, &[("radius", 10.0), ("px_scale", 0.5)], &extra, &src);
            let plain = exec1(ty, &[("radius", 5.0)], &extra, &src);
            assert_eq!(scaled.data, plain.data, "{ty}");
            let unscaled = exec1(ty, &[("radius", 10.0)], &extra, &src);
            assert_ne!(unscaled.data, plain.data, "{ty}: radius 10 and 5 must differ");
        }
        let scaled = exec1("heeler.sharpen", &[("amount", 100.0), ("radius", 2.0), ("px_scale", 0.5)], &[], &src);
        let plain = exec1("heeler.sharpen", &[("amount", 100.0), ("radius", 1.0)], &[], &src);
        assert_eq!(scaled.data, plain.data, "sharpen");
    }

    /// R6 of the 2026-09-23 review: Skin Softening keeps a highlight
    /// past white and hands the picture back bit for bit at Strength 0.
    #[test]
    fn skin_softening_keeps_highlights_and_is_off_at_strength_zero() {
        let mut img = textured(24, 16);
        img.data[0] = 2.0;
        img.data[5] = 3.5;
        let src = Arc::new(img);
        let off = exec1("heeler.skin_soften", &[("softening", 8.0), ("detail_back", 4.0), ("strength", 0.0)], &[], &src);
        assert_eq!(off.data, src.data, "strength 0 moved the picture");
        let mut flat = ImageBuf::new(8, 8);
        for px in 0..64 {
            flat.data[px * 4..px * 4 + 4].copy_from_slice(&[2.5, 2.5, 2.5, 1.0]);
        }
        let on = exec1("heeler.skin_soften", &[("softening", 8.0), ("detail_back", 4.0), ("strength", 100.0)], &[], &Arc::new(flat));
        for px in 0..64 {
            assert!((on.data[px * 4] - 2.5).abs() < 1e-4, "the highlight came home at {}", on.data[px * 4]);
        }
    }

    /// The green rim (2026-09-23, the jaguar's spots): the Vivid recipe
    /// pushes each channel on its own, and beside a dark spot on tan fur the
    /// cyan shadow pixels come out a rim of another hue. A Luminosity blend
    /// of the recipe over the picture keeps the hue and the sharpening: on a
    /// synthetic tan surface with a dark spot whose shadow edge is cyan, the
    /// recipe alone moves the edge's hue by more than the blend leaves, and
    /// the blend still steepens the edge.
    #[test]
    fn a_luminosity_blend_keeps_the_edges_hue_and_the_sharpening() {
        let (w, h) = (128usize, 32usize);
        let mut img = ImageBuf::new(w, h);
        for y in 0..h {
            for x in 0..w {
                // Tan fur, a cyan-leaning shadow over four pixels, then the dark spot.
                let px = if x < 60 {
                    [0.55, 0.42, 0.28]
                } else if x < 64 {
                    [0.10, 0.14, 0.14]
                } else {
                    [0.02, 0.02, 0.02]
                };
                img.set_pixel(x, y, [px[0], px[1], px[2], 1.0]);
            }
        }
        let src = Arc::new(img);
        let exec = |ty: &str, nums: &[(&str, f64)], texts: &[(&str, &str)], input: &Arc<ImageBuf>| exec1(ty, nums, texts, input);
        let display = exec("heeler.to_display", &[], &[], &src);
        let inv = exec("heeler.invert", &[("amount", 1.0)], &[], &display);
        let blurred = exec("heeler.blur", &[("radius", 6.0), ("angle", 0.0)], &[("kind", "gaussian")], &inv);
        let vivid = exec_blend("vivid_light", 100.0, &display, &blurred);
        let over = exec_blend("overlay", 100.0, &display, &vivid);
        let recipe = exec("heeler.to_scene", &[], &[], &over);
        let lum = exec_blend("luminosity", 100.0, &display, &over);
        let kept = exec("heeler.to_scene", &[], &[], &lum);
        // Hue as the chroma direction: (r - g, b - g) normalized.
        let hue = |p: [f32; 4]| {
            let (a, b) = (p[0] - p[1], p[2] - p[1]);
            let n = (a * a + b * b).sqrt().max(1e-6);
            (a / n, b / n)
        };
        let dot = |u: (f32, f32), v: (f32, f32)| u.0 * v.0 + u.1 * v.1;
        for x in [61usize, 62] {
            let before = hue(src.pixel(x, 16));
            let alone = dot(before, hue(recipe.pixel(x, 16)));
            let with = dot(before, hue(kept.pixel(x, 16)));
            assert!(with > alone + 0.05 && with > 0.98, "x={x}: the blend keeps the hue ({with}) where the recipe alone moves it ({alone})");
        }
        // And the edge is still sharper than the source under the blend.
        let step = |img: &ImageBuf| (img.pixel(59, 16)[1] - img.pixel(64, 16)[1]).abs();
        assert!(step(&kept) > step(&src) * 1.2, "the blend kept the sharpening: {} against {}", step(&kept), step(&src));
    }

    /// R2 of the 2026-09-23 review: past the wide path's threshold the
    /// blur is the reduced one, and the picture does not step at the
    /// switch. Radius 12 blurs at sigma 12 on the direct path, radius
    /// 12.2 on the wide one; a smooth picture must read the same
    /// through the High Pass node and the Blur node within a percent.
    #[test]
    fn the_blur_does_not_step_where_the_wide_path_takes_over() {
        let mut img = ImageBuf::new(256, 128);
        for y in 0..128 {
            for x in 0..256 {
                let v = 0.3 + 0.2 * ((x as f32) * 0.05).sin() * ((y as f32) * 0.07).cos();
                img.set_pixel(x, y, [v, v * 0.9, v * 0.8, 1.0]);
            }
        }
        let src = Arc::new(img);
        for (ty, extra) in [("heeler.high_pass", vec![]), ("heeler.blur", vec![("kind", "gaussian")])] {
            let direct = exec1(ty, &[("radius", 12.0)], &extra, &src);
            let wide = exec1(ty, &[("radius", 12.2)], &extra, &src);
            let worst = direct.data.iter().zip(wide.data.iter()).map(|(a, b)| (a - b).abs()).fold(0.0f32, f32::max);
            assert!(worst < 1e-2, "{ty} steps by {worst} where the wide path takes over");
        }
    }

}

/// The picture below, as this layer's own pixels.
///
/// The node a "Selection to layer" makes. A layer editor copies the
/// pixels into the new layer and you carry a second set of them around; here the
/// layer holds an instruction to take what is underneath, and the layer
/// mask decides how much of it. So the file grows by a node rather than
/// by a frame, and if the develop underneath changes the lifted pixels
/// change with it instead of going stale, which is the same bargain the
/// rest of this stack makes.
///
/// Opaque out, deliberately: the clipping is the layer mask's job, and
/// doing it here as well would make two places to look when a layer shows
/// the wrong shape.
pub(crate) fn lift(node: &Node, inputs: &[(String, Value)]) -> Result<Value, EngineError> {
    use rayon::prelude::*;
    let src = image_input(inputs, "in", &node.id)?;
    let mut out = ImageBuf::new(src.width, src.height);
    // PERF: the RGB copy ran serially pixel by pixel. It now parallels
    // over pixel chunks; each output pixel copies the same three channels
    // verbatim and writes the same 1.0 alpha, so bits are unchanged.
    out.data
        .par_chunks_mut(4)
        .zip(src.data.par_chunks(4))
        .for_each(|(o, s)| {
            o[..3].copy_from_slice(&s[..3]);
            o[3] = 1.0;
        });
    Ok(Value::Image(std::sync::Arc::new(out)))
}
