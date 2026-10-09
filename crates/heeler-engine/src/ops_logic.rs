//! The logic family: nodes that turn the picture into numbers, compare
//! and combine those numbers, and turn the answer back into an edit.
//!
//! The lineage is a layer editor's Blend If, unbundled. "it was
//! inspired by Blend If... having the node-based version of that would be
//! powerful. Then I started to consider what if we could extend that past
//! just blending, what if it could drive color correction as well." Blend If
//! is three fixed choices (the channel to read, the range to keep, the
//! feather on the handles) bolted onto layer compositing alone. As nodes,
//! each of those choices is a wire: measure picks the channel (and adds hue,
//! chroma and saturation, which Blend If never offered), compare is the
//! threshold with the split-handle feather (softness), and the resulting
//! condition plugs into the mask port of ANY edit (a channel gain, a grade,
//! a relight) or into the conditional node for the full if/then/else between
//! two branches.
//!
//! "Node Graph is considered to be advanced... if someone
//! nodes exposed more settings for granular controls than what is
//! available in Adjustments then that is a good thing." And on
//! conditionals: "imagine being able to define conditional logic on
//! image edits... 'if red is greater than X, then set blue to Y' is sort
//! of a simple example, but I want to build out something that is truly
//! advanced."
//!
//! That sentence is exactly what these six nodes build, as composable
//! pieces rather than one monolithic "script" node:
//!
//! measure image -> field of numbers (red, luma, hue, ...) compare field
//! -> 0/1 mask ("red greater than X", feathered) logic mask
//! AND/OR/XOR/SUBTRACT mask math field arithmetic: add, multiply,
//! divide, power, ... remap field shaping: window, gamma, output range
//! conditional mask picks per pixel between two images (if/then/else)
//!
//! "If red is greater than X, then set blue to Y" wires up as:
//!
//! source -> measure(metric=red) -> compare(op=gt, level=X) --+ source ->
//! channel_gain(channel=blue, gain=Y) --+ | source
//! ----------------------------------------+ | conditional: in=source,
//! fg=channel_gain, mask=compare
//!
//! Composable beats an embedded expression language on purpose: every
//! intermediate is a real wire the user can watch in mask view, the
//! executor's content-hash cache memoizes each piece, and no parser or
//! evaluator dependency enters the tree (the repo bars new crates
//! without need, and the GPL family outright).
//!
//! Conventions shared by the whole family:
//!
//! - Fields are single-channel f32, one per pixel, NOT clamped to 0..1
//!   unless a node says so. Masks and fields are the same value at the
//!   ports (Mask and Channel wires intermate), so a field can be
//!   negative or above 1 right up until something consumes it as a
//!   mask, at which point the consumer clamps (apply_mask does).
//! - Every node is identity or inert at its defaults: measure reads
//!   luma untouched, compare is a half split, logic/math pass operand a
//!   through, remap is the identity window, conditional with no
//!   condition is the else branch. A freshly placed node never changes
//!   the picture.
//! - Inputs are all optional. A logic node with one side wired is a
//!   pass-through for that side; a math node with nothing wired is a
//!   constant-field generator; compare/remap with nothing wired produce
//!   a zero field (a mask of nothing, the safe answer downstream).

use std::sync::Arc;

use heeler_graph::Node;

use crate::buffers::{luma, MaskBuf, Value};
use crate::color::{linear_to_oklab, oklch_of};
use crate::executor::EngineError;
use crate::ops::{box_blur_pass, image_input, p, p_bool};

/// Reads an optional Mask/Channel input: the single-channel field on
/// the named port, or None when the port is unwired. Mask and Channel
/// wires both arrive as Value::Mask, so one read serves both.
fn field_input<'a>(inputs: &'a [(String, Value)], name: &str) -> Option<&'a Arc<MaskBuf>> {
    inputs.iter().find(|(n, _)| n == name)?.1.as_mask()
}

/// A field of `v` everywhere: the implicit value of an unwired operand.
fn uniform(width: usize, height: usize, v: f32) -> MaskBuf {
    let mut out = MaskBuf::new(width, height);
    out.data.fill(v);
    out
}

/// Measure (heeler.measure): one number per pixel, chosen by `metric`.
///
/// This is the front door of the whole family: everything downstream
/// (compare, math, logic) works on the field this node (or any mask
/// node) produces. The metrics, in the units they answer in:
///
/// - luma / red / green / blue: scene-linear channel values, 0..1 in
///   the sane range and above 1 in the highlights of an unclipped RAW.
///   luma is Rec.709, the same weighting every other mask in the app
///   keys on, so a compare on luma agrees with a luminance range mask.
/// - hue: OkLCh hue divided by 360, so a full turn reads 0..1 and a
///   level of 0.08 is "about orange". Neutral pixels have no hue;
///   they report 0 rather than NaN, because NaN in a field is a land
///   mine under every later comparison.
/// - chroma: OkLCh C, scaled by 1/0.4 so the most saturated color a
///   display can show lands near 1.0. Not clamped: a camera can see
///   more chroma than a screen, and clipping the field here would
///   make "chroma greater than 1" unanswerable.
/// - saturation: (max - min) / max over the linear channels, the HSV
///   sense of the word, 0 on neutrals and on pure black. Chosen over
///   OkLab's C/L because that ratio explodes exactly where users probe
///   saturation most: deep shadow.
///
/// `smoothing` box-blurs the field by that many pixels before anyone
/// sees it. A measured field is per-pixel and noisy; a condition on
/// raw red tears along sensor noise, while the same condition on a
/// 20px-smoothed field reads as the region the user meant.
pub(crate) fn measure(node: &Node, inputs: &[(String, Value)]) -> Result<Value, EngineError> {
    let src = image_input(inputs, "in", &node.id)?;
    let metric = node
        .params
        .get("metric")
        .and_then(|v| v.as_str())
        .unwrap_or("luma")
        .to_string();
    let mut out = MaskBuf::new(src.width, src.height);
    // PERF: the metric ran serially over the frame. Each output element
    // is a pure function of its own source pixel,
    // so the parallel zip computes bit for bit what the serial loop did.
    use rayon::prelude::*;
    out.data
        .par_iter_mut()
        .enumerate()
        .for_each(|(px, o)| {
        let r = src.data[px * 4];
        let g = src.data[px * 4 + 1];
        let b = src.data[px * 4 + 2];
        *o = match metric.as_str() {
            // The picture's transparency, untouched: a recipe that takes
            // an image apart by channel hands it back to Channel Join.
            "alpha" => src.data[px * 4 + 3],
            "red" => r,
            "green" => g,
            "blue" => b,
            "hue" => {
                // oklch_of answers (hue, chroma): hue in degrees, NaN-free
                // by atan2 but meaningless on neutrals, where we report 0.
                let (h, c) = oklch_of(linear_to_oklab(r, g, b));
                if h.is_finite() && c > 1e-6 { h / 360.0 } else { 0.0 }
            }
            "chroma" => {
                // oklch_of answers (hue, chroma); hue is the first half.
                let (_, c) = oklch_of(linear_to_oklab(r, g, b));
                if c.is_finite() { c / 0.4 } else { 0.0 }
            }
            "saturation" => {
                let hi = r.max(g).max(b);
                let lo = r.min(g).min(b);
                if hi > 1e-6 { ((hi - lo) / hi).max(0.0) } else { 0.0 }
            }
            // "luma", and any spelling a saved graph carried from before
            // a rename: falling back to luma keeps the render alive,
            // which is the rule for choices everywhere in this engine.
            _ => luma(r, g, b),
        };
        });
    // smoothing is a radius in pixels, matching how Blur labels it; a
    // slider of 0 skips the pass entirely, so the default stays exact.
    let radius = p(&node.params, "smoothing", 0.0).max(0.0).round() as usize;
    if radius > 0 && !out.data.is_empty() {
        let mut scratch = vec![0.0f32; out.data.len()];
        box_blur_pass(&mut out.data, &mut scratch, out.width, out.height, radius);
    }
    Ok(Value::Mask(Arc::new(out)))
}

/// Compare (heeler.compare): the "if" half of a conditional edit.
///
/// Reads the field on "in" and answers, per pixel, how true the
/// comparison is: 0 or 1 at softness 0, feathered across the threshold
/// when softness is above 0. A feathered condition is usually what a
/// photograph wants: a hard `red > 0.5` tiles the edit along sensor
/// noise; the same comparison with softness 0.05 reads as a region.
///
/// - gt / ge: smoothstep over [level - s/2, level + s/2]. Hard gt is
///   strictly greater; ge admits equality. Soft, the two share a shape:
///   the feather has no edge to be strict about.
/// - lt / le: the mirror image.
/// - eq / neq: a triangle of half-width `softness` around level (and
///   its complement). eq at softness 0 would select a set of measure
///   zero (literally no pixels), so the band is floored at 0.001,
///   which keeps a forgotten slider from reading as "node is broken".
///
/// Two-operand comparisons ("red greater than BLUE") are not a mode
/// here but an idiom, deliberately: math(subtract) then compare(gt, 0)
/// says it with the pieces already on the table, and the subtracted
/// field stays visible on its own wire.
pub(crate) fn compare(node: &Node, inputs: &[(String, Value)]) -> Result<Value, EngineError> {
    let a = field_input(inputs, "in");
    let op = node
        .params
        .get("op")
        .and_then(|v| v.as_str())
        .unwrap_or("gt")
        .to_string();
    let level = p(&node.params, "level", 0.5);
    let softness = p(&node.params, "softness", 0.0).clamp(0.0, 1.0);
    // Nothing wired: a mask of no pixels, so a conditional downstream
    // takes its else branch everywhere rather than erroring.
    let Some(a) = a else {
        return Ok(Value::Mask(Arc::new(MaskBuf::new(1, 1))));
    };
    let mut out = MaskBuf::new(a.width, a.height);
    // PERF: the comparison ran serially over the field. Each output
    // element depends only on its own input element, so the parallel
    // zip answers bit for bit what the serial loop answered.
    use rayon::prelude::*;
    out.data
        .par_iter_mut()
        .zip(a.data.par_iter())
        .for_each(|(o, &v)| {
        *o = match op.as_str() {
            "lt" | "le" => soft_step(softness, level, v, true, op == "le"),
            "eq" | "neq" => {
                let half = softness.max(0.001);
                let t = (1.0 - (v - level).abs() / half).clamp(0.0, 1.0);
                if op == "eq" { t } else { 1.0 - t }
            }
            // "gt" (default), "ge", and rescued spellings.
            _ => soft_step(softness, level, v, false, op == "ge"),
        };
        });
    Ok(Value::Mask(Arc::new(out)))
}

/// One comparison, shared shape for gt/ge/lt/le. `invert` flips the
/// direction (lt/le), `inclusive` only matters for the hard edge.
fn soft_step(softness: f32, level: f32, v: f32, invert: bool, inclusive: bool) -> f32 {
    if softness <= 0.0 {
        let yes = if invert {
            if inclusive { v <= level } else { v < level }
        } else if inclusive {
            v >= level
        } else {
            v > level
        };
        return if yes { 1.0 } else { 0.0 };
    }
    let half = softness * 0.5;
    let t = ((v - (level - half)) / softness).clamp(0.0, 1.0);
    // Hermite smoothstep: zero slope at both ends, so the feathered
    // condition meets "fully false" and "fully true" without a kink.
    let s = t * t * (3.0 - 2.0 * t);
    if invert {
        1.0 - s
    } else {
        s
    }
}

/// Logic (heeler.logic): two conditions in, one out.
///
/// Fuzzy rather than boolean, because masks are feathered: and = min,
/// or = max, xor = |a - b|, subtract = clamp(a - b, 0, 1). On hard 0/1
/// masks these are exactly the boolean gates; on feathered masks they
/// are the extensions that keep feathers sensible (an and of two 0.5
/// edges is 0.5, not a coin flip). NOT is deliberately absent: the
/// invert_mask node already owns it, and one way to do a thing beats
/// two.
///
/// One side unwired passes the other side through untouched, so a
/// logic node parked in a graph mid-construction is inert rather than
/// a hole. Both unwired answers "nothing": a zero field.
pub(crate) fn logic(node: &Node, inputs: &[(String, Value)]) -> Result<Value, EngineError> {
    let a = field_input(inputs, "in");
    let b = field_input(inputs, "fg");
    let op = node
        .params
        .get("op")
        .and_then(|v| v.as_str())
        .unwrap_or("and")
        .to_string();
    match (a, b) {
        (Some(a), None) => Ok(Value::Mask(a.clone())),
        (None, Some(b)) => Ok(Value::Mask(b.clone())),
        (None, None) => Ok(Value::Mask(Arc::new(MaskBuf::new(1, 1)))),
        (Some(a), Some(b)) => {
            if a.width != b.width || a.height != b.height {
                return Err(EngineError::SizeMismatch {
                    node: node.id.clone(),
                });
            }
            let mut out = MaskBuf::new(a.width, a.height);
            for (o, (&x, &y)) in out.data.iter_mut().zip(a.data.iter().zip(b.data.iter())) {
                *o = match op.as_str() {
                    "or" => x.max(y),
                    "xor" => (x - y).abs(),
                    "subtract" => (x - y).clamp(0.0, 1.0),
                    // "and", and rescued spellings.
                    _ => x.min(y),
                };
            }
            Ok(Value::Mask(Arc::new(out)))
        }
    }
}

/// Channel Join (heeler.channel_join): three fields become an image.
///
/// "r", "g" and "b" are each optional and read as zero when unwired,
/// so a single field on "r" is a red picture and nothing wired at all
/// is a 1x1 black. The wired fields must agree on size, the same rule
/// Logic and Math hold their operands to. Alpha is one everywhere
/// unless a field arrives on "alpha" (node recipes, 2026-09-30: a
/// recipe that takes an image apart hands its transparency back, read
/// by Measure's alpha metric), clamped to 0..1 there because an alpha
/// outside it is not a coverage any later node can composite.
pub(crate) fn channel_join(node: &Node, inputs: &[(String, Value)]) -> Result<Value, EngineError> {
    let planes = [field_input(inputs, "r"), field_input(inputs, "g"), field_input(inputs, "b"), field_input(inputs, "alpha")];
    let Some(first) = planes.iter().flatten().next() else {
        return Ok(Value::Image(Arc::new(crate::buffers::ImageBuf::filled(
            1,
            1,
            [0.0, 0.0, 0.0, 1.0],
        ))));
    };
    let (w, h) = (first.width, first.height);
    if planes
        .iter()
        .flatten()
        .any(|m| m.width != w || m.height != h)
    {
        return Err(EngineError::SizeMismatch {
            node: node.id.clone(),
        });
    }
    let mut out = crate::buffers::ImageBuf::filled(w, h, [0.0, 0.0, 0.0, 1.0]);
    for (c, plane) in planes.iter().enumerate() {
        let Some(m) = plane else { continue };
        for (px, &v) in m.data.iter().enumerate() {
            out.data[px * 4 + c] = if c == 3 { v.clamp(0.0, 1.0) } else { v };
        }
    }
    Ok(Value::Image(Arc::new(out)))
}

/// Math (heeler.math): arithmetic on fields.
///
/// Operands are the field on "in" (a) and the field on "fg" (b); with
/// "fg" unwired, b is the `constant` parameter as a uniform field, so
/// "multiply the red measurement by 2" and "multiply red by blue" are
/// the same node. With BOTH unwired the node is a constant-field
/// generator, which is how a conditional gets its "set blue to Y" Y.
///
/// The output is `op(a, b) * scale + offset`, UNCLAMPED. Fields are
/// allowed to live outside 0..1 precisely so math can be done on them
/// (a subtract that floored at zero could not tell "red much less than
/// blue" from "red a little less"; a compare downstream can). Whatever
/// finally consumes the field as a mask clamps it there.
///
/// - divide answers 0 where b is 0. An infinity in a field becomes NaN
///   smears two nodes later (0 * inf), and a hole is easier to see and
///   to reason about than a smear.
/// - power clamps its base at 0: fractional exponents on negative
///   bases are NaN, and no photograph ever meant that.
/// - difference is |a - b|, the symmetric distance; subtract keeps the
///   sign for fields that are headed into another math node.
///
/// Defaults are identity: add, constant 0, scale 1, offset 0 passes a
/// through byte for byte.
pub(crate) fn math(node: &Node, inputs: &[(String, Value)]) -> Result<Value, EngineError> {
    let a = field_input(inputs, "in");
    let b = field_input(inputs, "fg");
    let op = node
        .params
        .get("op")
        .and_then(|v| v.as_str())
        .unwrap_or("add")
        .to_string();
    let constant = p(&node.params, "constant", 0.0);
    let scale = p(&node.params, "scale", 1.0);
    let offset = p(&node.params, "offset", 0.0);
    // Unwired sides degrade to uniform fields: a to 0 (addition's
    // identity, so a lone b survives), b to the constant param.
    let (width, height) = match (a, b) {
        (Some(a), Some(b)) => {
            if a.width != b.width || a.height != b.height {
                return Err(EngineError::SizeMismatch {
                    node: node.id.clone(),
                });
            }
            (a.width, a.height)
        }
        (Some(a), None) => (a.width, a.height),
        (None, Some(b)) => (b.width, b.height),
        // Nothing at all: a 1x1 constant field. Downstream, a
        // conditional's mask blend checks dimensions against its
        // images and declines to blend on a mismatch, so a stray
        // constant field fails safe rather than tiling a lie.
        (None, None) => {
            let v = constant * scale + offset;
            return Ok(Value::Mask(Arc::new(uniform(1, 1, v))));
        }
    };
    let mut out = MaskBuf::new(width, height);
    for px in 0..out.data.len() {
        let x = a.map(|f| f.data[px]).unwrap_or(0.0);
        let y = b.map(|f| f.data[px]).unwrap_or(constant);
        let v = match op.as_str() {
            "subtract" => x - y,
            "multiply" => x * y,
            "divide" => {
                if y.abs() > 1e-9 {
                    x / y
                } else {
                    0.0
                }
            }
            "min" => x.min(y),
            "max" => x.max(y),
            "difference" => (x - y).abs(),
            "power" => x.max(0.0).powf(y),
            // "add", and rescued spellings.
            _ => x + y,
        };
        out.data[px] = v * scale + offset;
    }
    Ok(Value::Mask(Arc::new(out)))
}

/// Remap (heeler.remap): reshapes a field before a compare consumes it.
///
/// The levels control, for masks: pull the [in_low, in_high] window out
/// to [out_low, out_high] with a gamma in between (same convention as
/// the Levels node: gamma 2 brightens). It is the answer to "the
/// condition is right but the edge is in the wrong place": measure
/// luma, remap the 0.2..0.4 shadow band out to the full range, and
/// compare against 0.5 to draw a clean line through it.
///
/// `clamp` (on by default, and identity-preserving there) pins the
/// result to 0..1 for feeding a mask port. Off, the field may overshoot
/// (the point of the node when a later math node needs headroom).
/// Defaults are the identity window, so a fresh remap changes nothing.
pub(crate) fn remap(node: &Node, inputs: &[(String, Value)]) -> Result<Value, EngineError> {
    let a = field_input(inputs, "in");
    let in_low = p(&node.params, "in_low", 0.0);
    let in_high = p(&node.params, "in_high", 1.0);
    let gamma = p(&node.params, "gamma", 1.0).max(0.01);
    let out_low = p(&node.params, "out_low", 0.0);
    let out_high = p(&node.params, "out_high", 1.0);
    let clamp = p_bool(&node.params, "clamp", true);
    let Some(a) = a else {
        return Ok(Value::Mask(Arc::new(MaskBuf::new(1, 1))));
    };
    // A collapsed window is a step, not a divide-by-zero: everything
    // below in_low maps to out_low, everything at or above to out_high.
    let span = (in_high - in_low).max(1e-6);
    let mut out = MaskBuf::new(a.width, a.height);
    for (o, &v) in out.data.iter_mut().zip(a.data.iter()) {
        let t = ((v - in_low) / span).clamp(0.0, 1.0).powf(1.0 / gamma);
        let mut r = out_low + t * (out_high - out_low);
        if clamp {
            r = r.clamp(0.0, 1.0);
        }
        *o = r;
    }
    Ok(Value::Mask(Arc::new(out)))
}

/// Conditional (heeler.conditional): the per-pixel if/then/else.
///
///   in   = the else branch (what passes when the condition is false)
///   fg   = the then branch (what passes when the condition is true)
///   mask = the condition field, 0 = fully else, 1 = fully then
///
/// The op itself only picks the branch IMAGE (fg when a condition is
/// wired, else otherwise) because the per-pixel select already exists
/// and already lives in exactly one place: the executor's
/// blend_through_mask, which blends any node's result back toward its
/// "in" image by the mask on its "mask" port. Pointed at this node
/// that mechanism IS the conditional: mask 1 keeps the fg result,
/// mask 0 falls back to in, and a feathered condition from compare
/// crossfades the two branches instead of tiling. Reusing it keeps the
/// blending math, the dimension guard, and the cache behavior shared
/// with every masked adjustment rather than forked here.
///
/// Deliberate consequences, all by design:
/// - No condition wired: the else branch passes untouched. A parked
///   conditional is inert.
/// - Disabled: the executor's passthrough forwards the first image
///   input, which is "in": a switched-off conditional is its else
///   branch, the only answer that is never a surprise.
/// - fg a different size than in is a wiring error, and the safe
///   answer to a wiring error is the else branch.
pub(crate) fn conditional(node: &Node, inputs: &[(String, Value)]) -> Result<Value, EngineError> {
    let else_img = image_input(inputs, "in", &node.id)?;
    let condition = field_input(inputs, "mask");
    let then_img = inputs
        .iter()
        .find(|(n, _)| n == "fg")
        .and_then(|(_, v)| v.as_image());
    match (condition, then_img) {
        (Some(_), Some(then)) => {
            if then.width != else_img.width || then.height != else_img.height {
                // Branches that disagree on size cannot be selected
                // between per pixel; else is the failure that looks
                // like "the condition fired nowhere" instead of a
                // half-canvas smear.
                return Ok(Value::Image(else_img.clone()));
            }
            Ok(Value::Image(then.clone()))
        }
        _ => Ok(Value::Image(else_img.clone())),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::buffers::ImageBuf;
    use heeler_graph::{ParamValue, Registry, Section};
    use std::collections::BTreeMap;

    fn make_node(node_type: &str) -> Node {
        Registry::builtin()
            .instantiate(node_type, "t", Section::Creative)
            .unwrap()
    }

    fn set_num(n: &mut Node, key: &str, v: f64) {
        n.params.insert(key.into(), ParamValue::Number(v));
    }

    fn set_text(n: &mut Node, key: &str, v: &str) {
        n.params.insert(key.into(), ParamValue::Text(v.into()));
    }

    fn img(px: [f32; 4]) -> Value {
        Value::Image(Arc::new(ImageBuf::filled(2, 2, px)))
    }

    fn field(vals: &[f32], w: usize, h: usize) -> Value {
        let mut m = MaskBuf::new(w, h);
        m.data.copy_from_slice(vals);
        Value::Mask(Arc::new(m))
    }

    fn mask_of(v: Value) -> Arc<MaskBuf> {
        v.as_mask().unwrap().clone()
    }

    // --- channel join ----------------------------------------------

    #[test]
    fn channel_join_puts_each_field_in_its_channel_with_alpha_one() {
        let n = make_node("heeler.channel_join");
        let out = channel_join(
            &n,
            &[
                ("r".into(), field(&[1.0, 0.0, 0.5, 0.25], 2, 2)),
                ("g".into(), field(&[0.0, 1.0, 0.5, 0.25], 2, 2)),
                ("b".into(), field(&[0.0, 0.0, 1.0, 0.25], 2, 2)),
            ],
        )
        .unwrap();
        let img = out.as_image().unwrap();
        assert_eq!(img.pixel(0, 0), [1.0, 0.0, 0.0, 1.0]);
        assert_eq!(img.pixel(1, 0), [0.0, 1.0, 0.0, 1.0]);
        assert_eq!(img.pixel(0, 1), [0.5, 0.5, 1.0, 1.0]);
        assert_eq!(img.pixel(1, 1), [0.25, 0.25, 0.25, 1.0]);
    }

    #[test]
    fn channel_join_reads_an_unwired_plane_as_zero_and_nothing_as_black() {
        let n = make_node("heeler.channel_join");
        let red = channel_join(&n, &[("r".into(), field(&[0.75], 1, 1))]).unwrap();
        assert_eq!(red.as_image().unwrap().pixel(0, 0), [0.75, 0.0, 0.0, 1.0]);
        let none = channel_join(&n, &[]).unwrap();
        let img = none.as_image().unwrap();
        assert_eq!((img.width, img.height), (1, 1));
        assert_eq!(img.pixel(0, 0), [0.0, 0.0, 0.0, 1.0]);
    }

    #[test]
    fn channel_join_refuses_planes_of_different_sizes() {
        let n = make_node("heeler.channel_join");
        let err = channel_join(
            &n,
            &[
                ("r".into(), field(&[1.0, 1.0, 1.0, 1.0], 2, 2)),
                ("b".into(), field(&[1.0], 1, 1)),
            ],
        )
        .unwrap_err();
        assert!(matches!(err, EngineError::SizeMismatch { .. }));
    }

    #[test]
    fn channel_join_takes_its_alpha_from_the_alpha_plane() {
        let n = make_node("heeler.channel_join");
        let out = channel_join(
            &n,
            &[
                ("r".into(), field(&[-0.5, 2.0], 2, 1)),
                ("alpha".into(), field(&[0.25, 1.5], 2, 1)),
            ],
        )
        .unwrap();
        let img = out.as_image().unwrap();
        // Color stays signed and unclamped; alpha is clamped to a
        // coverage.
        assert_eq!(img.pixel(0, 0), [-0.5, 0.0, 0.0, 0.25]);
        assert_eq!(img.pixel(1, 0), [2.0, 0.0, 0.0, 1.0]);
    }

    #[test]
    fn measure_alpha_reads_the_transparency_raw() {
        let mut n = make_node("heeler.measure");
        set_text(&mut n, "metric", "alpha");
        let out = mask_of(measure(&n, &[("in".into(), img([0.7, 0.2, 0.1, 0.4]))]).unwrap());
        assert_eq!(out.data[0], 0.4);
    }

    // --- measure ---------------------------------------------------

    #[test]
    fn measure_defaults_read_luma_and_change_nothing_else() {
        let n = make_node("heeler.measure");
        let out = mask_of(measure(&n, &[("in".into(), img([1.0, 0.0, 0.0, 1.0]))]).unwrap());
        // Rec.709, the same weighting the luminance masks key on.
        assert!((out.data[0] - 0.2126).abs() < 1e-4);
    }

    #[test]
    fn measure_red_reads_the_channel_raw() {
        let mut n = make_node("heeler.measure");
        set_text(&mut n, "metric", "red");
        let out = mask_of(measure(&n, &[("in".into(), img([0.7, 0.2, 0.1, 1.0]))]).unwrap());
        assert!((out.data[0] - 0.7).abs() < 1e-6);
    }

    #[test]
    fn measure_hue_of_pure_red_is_zero_and_neutral_is_not_nan() {
        let mut n = make_node("heeler.measure");
        set_text(&mut n, "metric", "hue");
        let red = mask_of(measure(&n, &[("in".into(), img([1.0, 0.0, 0.0, 1.0]))]).unwrap());
        // OkLCh hue of primary red is ~29 degrees, so near 0.08 of a turn.
        assert!(red.data[0] > 0.05 && red.data[0] < 0.12, "{}", red.data[0]);
        let gray = mask_of(measure(&n, &[("in".into(), img([0.2, 0.2, 0.2, 1.0]))]).unwrap());
        assert!(gray.data[0].is_finite());
    }

    #[test]
    fn measure_saturation_distinguishes_neutral_from_vivid() {
        let mut n = make_node("heeler.measure");
        set_text(&mut n, "metric", "saturation");
        let gray = mask_of(measure(&n, &[("in".into(), img([0.4, 0.4, 0.4, 1.0]))]).unwrap());
        let red = mask_of(measure(&n, &[("in".into(), img([0.8, 0.1, 0.1, 1.0]))]).unwrap());
        assert!(gray.data[0] < 1e-6);
        assert!((red.data[0] - 0.875).abs() < 1e-3);
    }

    #[test]
    fn measure_smoothing_blurs_the_field() {
        // A single hot pixel in a 9x9 field: unsmoothed it stands alone,
        // smoothed by radius 4 it averages out to the mean of the box.
        let mut data = vec![0.0f32; 9 * 9 * 4];
        data[(4 * 9 + 4) * 4] = 1.0;
        let mut buf = ImageBuf::new(9, 9);
        buf.data = data;
        let mut n = make_node("heeler.measure");
        set_text(&mut n, "metric", "red");
        let hard = mask_of(measure(&n, &[("in".into(), Value::Image(Arc::new(buf.clone())))]).unwrap());
        assert!((hard.data[4 * 9 + 4] - 1.0).abs() < 1e-6);
        set_num(&mut n, "smoothing", 4.0);
        let soft = mask_of(measure(&n, &[("in".into(), Value::Image(Arc::new(buf)))]).unwrap());
        assert!(soft.data[4 * 9 + 4] < 0.2, "{}", soft.data[4 * 9 + 4]);
        assert!(soft.data[4 * 9 + 4] > 0.0);
    }

    // --- compare ----------------------------------------------------

    #[test]
    fn compare_gt_is_a_hard_step_at_zero_softness() {
        let mut n = make_node("heeler.compare");
        set_num(&mut n, "level", 0.5);
        let f = field(&[0.4, 0.5, 0.6, 1.0], 2, 2);
        let out = mask_of(compare(&n, &[("in".into(), f)]).unwrap());
        assert_eq!(out.data, vec![0.0, 0.0, 1.0, 1.0]);
    }

    #[test]
    fn compare_lt_mirrors_gt() {
        let mut n = make_node("heeler.compare");
        set_text(&mut n, "op", "lt");
        set_num(&mut n, "level", 0.5);
        let f = field(&[0.4, 0.6, 0.0, 1.0], 2, 2);
        let out = mask_of(compare(&n, &[("in".into(), f)]).unwrap());
        assert_eq!(out.data, vec![1.0, 0.0, 1.0, 0.0]);
    }

    #[test]
    fn compare_ge_admits_equality_where_gt_does_not() {
        let mut n = make_node("heeler.compare");
        set_num(&mut n, "level", 0.5);
        let f = field(&[0.5, 0.5, 0.5, 0.5], 2, 2);
        let gt = mask_of(compare(&n, &[("in".into(), f.clone())]).unwrap());
        set_text(&mut n, "op", "ge");
        let ge = mask_of(compare(&n, &[("in".into(), f)]).unwrap());
        assert!(gt.data.iter().all(|&v| v == 0.0));
        assert!(ge.data.iter().all(|&v| v == 1.0));
    }

    #[test]
    fn compare_softness_feathers_the_threshold() {
        let mut n = make_node("heeler.compare");
        set_num(&mut n, "level", 0.5);
        set_num(&mut n, "softness", 0.2);
        // Band is [0.4, 0.6]: 0.5 sits dead center at 0.5, 0.45 at the
        // smoothstep quarter point, 0.7 is fully in.
        let f = field(&[0.45, 0.5, 0.7, 0.3], 2, 2);
        let out = mask_of(compare(&n, &[("in".into(), f)]).unwrap());
        assert!((out.data[0] - 0.15625).abs() < 1e-4);
        assert!((out.data[1] - 0.5).abs() < 1e-6);
        assert!((out.data[2] - 1.0).abs() < 1e-6);
        assert!((out.data[3] - 0.0).abs() < 1e-6);
    }

    #[test]
    fn compare_eq_selects_a_band_and_never_nothing() {
        let mut n = make_node("heeler.compare");
        set_text(&mut n, "op", "eq");
        set_num(&mut n, "level", 0.5);
        // Softness 0 floored to 0.001: only exact hits score.
        let f = field(&[0.5, 0.4, 0.0, 1.0], 2, 2);
        let out = mask_of(compare(&n, &[("in".into(), f)]).unwrap());
        assert!((out.data[0] - 1.0).abs() < 1e-6);
        assert!(out.data[1] == 0.0);
    }

    #[test]
    fn compare_unwired_is_a_mask_of_nothing() {
        let n = make_node("heeler.compare");
        let out = mask_of(compare(&n, &[]).unwrap());
        assert!(out.data.iter().all(|&v| v == 0.0));
    }

    // ACCURACY: the Sky Rescue recipe (recipes.ts skyPieces/skyWires)
    // wires Measure(luma) straight off the chain feed and Compares
    // gt 0.55, feathered 0.15, and its comment says the threshold
    // "judges the display-shaped photograph the user is looking at, not
    // a scene-linear number". It does not: measure's luma is Rec.709
    // over the raw channels on the wire, and the wire at the splice is
    // scene-linear (tone_profile and curves both convert back with
    // to_scene on the way out; heeler.output is a passthrough; the
    // sharpen and skin blocks add their own to_display nodes precisely
    // because the feed is scene-linear). A mid gray of 0.4 scene-linear
    // reads about 0.665 on screen, ABOVE 0.55: judged display-shaped,
    // the rescue would fire; judged scene-linear, as it actually is, it
    // does not. This pins the actual semantics so the finding stands on
    // a render, not on a reading. (The recipe comment, not the engine,
    // is what needs the correction.)
    #[test]
    fn sky_rescue_threshold_reads_scene_linear_not_display() {
        let mut m = make_node("heeler.measure");
        set_text(&mut m, "metric", "luma");
        let mut c = make_node("heeler.compare");
        set_text(&mut c, "op", "gt");
        set_num(&mut c, "level", 0.55);
        set_num(&mut c, "softness", 0.15);
        // Uniform 0.4 scene-linear gray: 0.665 once display-shaped.
        let measured = mask_of(measure(&m, &[("in".into(), img([0.4, 0.4, 0.4, 1.0]))]).unwrap());
        assert!(measured.data.iter().all(|&v| (v - 0.4).abs() < 1e-6));
        let mask = mask_of(compare(&c, &[("in".into(), Value::Mask(measured))]).unwrap());
        assert!(mask.data.iter().all(|&v| v == 0.0));
        // A 0.7 scene-linear sky clears the feathered band's top
        // (0.625): fully selected.
        let bright = mask_of(measure(&m, &[("in".into(), img([0.7, 0.7, 0.7, 1.0]))]).unwrap());
        let mask = mask_of(compare(&c, &[("in".into(), Value::Mask(bright))]).unwrap());
        assert!(mask.data.iter().all(|&v| v == 1.0));
    }

    // --- logic ------------------------------------------------------

    #[test]
    fn logic_and_or_xor_subtract_are_fuzzy_gates() {
        let a = field(&[1.0, 0.4, 0.0, 0.7], 2, 2);
        let b = field(&[1.0, 0.8, 1.0, 0.2], 2, 2);
        let run = |op: &str| {
            let mut n = make_node("heeler.logic");
            set_text(&mut n, "op", op);
            mask_of(logic(&n, &[("in".into(), a.clone()), ("fg".into(), b.clone())]).unwrap())
                .data
                .clone()
        };
        assert_eq!(run("and"), vec![1.0, 0.4, 0.0, 0.2]);
        assert_eq!(run("or"), vec![1.0, 0.8, 1.0, 0.7]);
        assert_eq!(run("xor"), vec![0.0, 0.4, 1.0, 0.5]);
        assert_eq!(run("subtract"), vec![0.0, 0.0, 0.0, 0.5]);
    }

    #[test]
    fn logic_with_one_side_unwired_passes_the_other() {
        let a = field(&[0.25, 0.75, 0.0, 1.0], 2, 2);
        let mut n = make_node("heeler.logic");
        set_text(&mut n, "op", "and");
        let out = mask_of(logic(&n, &[("in".into(), a.clone())]).unwrap());
        assert_eq!(out.data, a.as_mask().unwrap().data);
        let out = mask_of(logic(&n, &[("fg".into(), a)]).unwrap());
        assert_eq!(out.data, vec![0.25, 0.75, 0.0, 1.0]);
    }

    #[test]
    fn logic_size_mismatch_is_an_error_not_a_smear() {
        let a = field(&[1.0; 4], 2, 2);
        let b = field(&[1.0; 9], 3, 3);
        let n = make_node("heeler.logic");
        let err = logic(&n, &[("in".into(), a), ("fg".into(), b)]).unwrap_err();
        assert!(matches!(err, EngineError::SizeMismatch { .. }));
    }

    // --- math -------------------------------------------------------

    #[test]
    fn math_defaults_are_identity_on_a() {
        let n = make_node("heeler.math");
        let a = field(&[0.1, 0.5, 0.9, 2.0], 2, 2);
        let out = mask_of(math(&n, &[("in".into(), a)]).unwrap());
        assert_eq!(out.data, vec![0.1, 0.5, 0.9, 2.0]);
    }

    #[test]
    fn math_ops_and_constant_operand() {
        let a = field(&[0.5, 2.0, 0.0, 4.0], 2, 2);
        let run = |op: &str, constant: f64| {
            let mut n = make_node("heeler.math");
            set_text(&mut n, "op", op);
            set_num(&mut n, "constant", constant);
            mask_of(math(&n, &[("in".into(), a.clone())]).unwrap()).data.clone()
        };
        assert_eq!(run("add", 0.25), vec![0.75, 2.25, 0.25, 4.25]);
        assert_eq!(run("subtract", 0.5), vec![0.0, 1.5, -0.5, 3.5]);
        assert_eq!(run("multiply", 2.0), vec![1.0, 4.0, 0.0, 8.0]);
        assert_eq!(run("min", 1.0), vec![0.5, 1.0, 0.0, 1.0]);
        assert_eq!(run("max", 1.0), vec![1.0, 2.0, 1.0, 4.0]);
        assert_eq!(run("difference", 1.5), vec![1.0, 0.5, 1.5, 2.5]);
        // 2^3, 4^0.5, and the base clamp keeps negatives out of NaN.
        assert_eq!(run("power", 3.0), vec![0.125, 8.0, 0.0, 64.0]);
    }

    #[test]
    fn math_divide_by_zero_is_zero_not_infinity() {
        let mut n = make_node("heeler.math");
        set_text(&mut n, "op", "divide");
        set_num(&mut n, "constant", 0.0);
        let a = field(&[1.0, 5.0, 0.0, 2.0], 2, 2);
        let out = mask_of(math(&n, &[("in".into(), a)]).unwrap());
        assert!(out.data.iter().all(|v| v.is_finite() && *v == 0.0));
    }

    #[test]
    fn math_scale_and_offset_apply_last() {
        let mut n = make_node("heeler.math");
        set_text(&mut n, "op", "add");
        set_num(&mut n, "constant", 0.5);
        set_num(&mut n, "scale", 2.0);
        set_num(&mut n, "offset", -1.0);
        let a = field(&[0.5, 0.0, 1.0, 0.25], 2, 2);
        let out = mask_of(math(&n, &[("in".into(), a)]).unwrap());
        // (a + 0.5) * 2 - 1, elementwise.
        assert_eq!(out.data, vec![1.0, 0.0, 2.0, 0.5]);
    }

    #[test]
    fn math_unwired_is_a_constant_field() {
        let mut n = make_node("heeler.math");
        set_num(&mut n, "constant", 0.75);
        let out = mask_of(math(&n, &[]).unwrap());
        assert!(out.data.iter().all(|&v| v == 0.75));
    }

    // --- remap ------------------------------------------------------

    #[test]
    fn remap_defaults_are_identity() {
        let n = make_node("heeler.remap");
        let a = field(&[0.0, 0.25, 0.5, 1.0], 2, 2);
        let out = mask_of(remap(&n, &[("in".into(), a)]).unwrap());
        for (o, e) in out.data.iter().zip([0.0, 0.25, 0.5, 1.0]) {
            assert!((o - e).abs() < 1e-6, "{o} != {e}");
        }
    }

    #[test]
    fn remap_window_and_output_range() {
        let mut n = make_node("heeler.remap");
        set_num(&mut n, "in_low", 0.2);
        set_num(&mut n, "in_high", 0.4);
        let a = field(&[0.0, 0.2, 0.3, 0.4], 2, 2);
        let out = mask_of(remap(&n, &[("in".into(), a)]).unwrap());
        for (o, e) in out.data.iter().zip([0.0, 0.0, 0.5, 1.0]) {
            assert!((o - e).abs() < 1e-5, "{o} != {e}");
        }
        set_num(&mut n, "out_low", 1.0);
        set_num(&mut n, "out_high", 0.0);
        let a = field(&[0.3, 0.2, 0.4, 0.0], 2, 2);
        let out = mask_of(remap(&n, &[("in".into(), a)]).unwrap());
        for (o, e) in out.data.iter().zip([0.5, 1.0, 0.0, 1.0]) {
            assert!((o - e).abs() < 1e-5, "{o} != {e}");
        }
    }

    #[test]
    fn remap_gamma_matches_the_levels_convention() {
        let mut n = make_node("heeler.remap");
        set_num(&mut n, "gamma", 2.0);
        let a = field(&[0.25, 0.5, 0.75, 1.0], 2, 2);
        let out = mask_of(remap(&n, &[("in".into(), a)]).unwrap());
        assert!((out.data[1] - 0.5f32.powf(0.5)).abs() < 1e-5);
    }

    #[test]
    fn remap_unclamped_allows_headroom() {
        let mut n = make_node("heeler.remap");
        set_num(&mut n, "out_high", 3.0);
        n.params.insert("clamp".into(), ParamValue::Bool(false));
        let a = field(&[1.0, 0.5, 0.0, 0.75], 2, 2);
        let out = mask_of(remap(&n, &[("in".into(), a)]).unwrap());
        assert!((out.data[0] - 3.0).abs() < 1e-5);
        assert!((out.data[1] - 1.5).abs() < 1e-5);
    }

    // --- conditional -------------------------------------------------

    #[test]
    fn conditional_without_a_condition_is_the_else_branch() {
        let n = make_node("heeler.conditional");
        let else_img = img([0.2, 0.2, 0.2, 1.0]);
        let then_img = img([0.9, 0.9, 0.9, 1.0]);
        let out = conditional(
            &n,
            &[("in".into(), else_img.clone()), ("fg".into(), then_img)],
        )
        .unwrap();
        assert_eq!(out.as_image().unwrap().pixel(0, 0), [0.2, 0.2, 0.2, 1.0]);
        // The executor's blend_through_mask performs the per-pixel select;
        // a rig-level test in executor.rs proves the two halves together.
        let _ = else_img;
    }

    #[test]
    fn conditional_with_a_condition_returns_the_then_branch_for_blending() {
        let n = make_node("heeler.conditional");
        let cond = field(&[1.0, 0.0, 0.5, 1.0], 2, 2);
        let out = conditional(
            &n,
            &[
                ("in".into(), img([0.2, 0.2, 0.2, 1.0])),
                ("fg".into(), img([0.9, 0.9, 0.9, 1.0])),
                ("mask".into(), cond),
            ],
        )
        .unwrap();
        // The op hands back "then" whole; blend_through_mask mixes it
        // toward "else" by the condition field.
        assert_eq!(out.as_image().unwrap().pixel(0, 0), [0.9, 0.9, 0.9, 1.0]);
    }

    #[test]
    fn conditional_with_mismatched_branches_fails_to_else() {
        let n = make_node("heeler.conditional");
        let cond = field(&[1.0; 4], 2, 2);
        let then = Value::Image(Arc::new(ImageBuf::filled(3, 3, [0.9, 0.9, 0.9, 1.0])));
        let out = conditional(
            &n,
            &[
                ("in".into(), img([0.2, 0.2, 0.2, 1.0])),
                ("fg".into(), then),
                ("mask".into(), cond),
            ],
        )
        .unwrap();
        assert_eq!(out.as_image().unwrap().width, 2);
        assert_eq!(out.as_image().unwrap().pixel(0, 0), [0.2, 0.2, 0.2, 1.0]);
    }

    /// The registry carries the family with the documented defaults:
    /// the palette cross-check test on the desktop side requires every
    /// one of these types to exist here.
    #[test]
    fn registry_declares_the_whole_family() {
        let r = Registry::builtin();
        for (t, params) in [
            ("heeler.measure", &["metric", "smoothing"][..]),
            ("heeler.compare", &["op", "level", "softness"][..]),
            ("heeler.logic", &["op"][..]),
            ("heeler.math", &["op", "constant", "scale", "offset"][..]),
           
                ("heeler.remap",
                &["in_low", "in_high", "gamma", "out_low", "out_high", "clamp"][..],
            ),
            ("heeler.conditional", &[][..]),
        ] {
            let spec = r.get(t).unwrap_or_else(|| panic!("missing spec for {t}"));
            for p in params {
                assert!(spec.params.iter().any(|s| s.name == *p), "{t} missing {p}");
            }
        }
        // The ports the frontend wires against: conditional takes its
        // then branch on "fg" (where the UI's second image input lands)
        // and its condition on "mask".
        let c = r.get("heeler.conditional").unwrap();
        assert!(c.inputs.iter().any(|p| p.name == "fg" && p.optional));
        assert!(c.inputs.iter().any(|p| p.name == "mask" && p.optional));
        // And the family's second mask operand rides "fg" the same way.
        for t in ["heeler.logic", "heeler.math"] {
            let s = r.get(t).unwrap();
            assert!(s.inputs.iter().any(|p| p.name == "fg" && p.optional), "{t}");
        }
    }

    /// Keep BTreeMap referenced: params in these tests are inserted
    /// directly, and the import stays honest.
    #[test]
    fn params_maps_are_btree() {
        let n = make_node("heeler.math");
        let _: &BTreeMap<String, ParamValue> = &n.params;
    }
}
