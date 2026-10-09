// The pieces effects are built out of.
//
// "Is it not possible to have generic utility nodes that support
// gain adjustments on a single channel? [...] I want to go beyond 'here is a
// grain node' and rather show the user 'this is how grain effects are built'
// to educate and empower them."
//
// None of the math here is new. Every line of it was already inside the
// grain op, doing the same arithmetic on the same numbers, with no way to
// see it or reuse it. Pulling it out is what turns one opaque node into a
// group somebody can open, read, take apart, and build a different effect
// out of. A user who wants grain that only touches the blue channel in the
// shadows should not need us to ship a slider for it.
//
// They are deliberately small. A node that does one thing is a node whose
// name tells you what it does.

use std::sync::Arc;

use heeler_graph::Node;

use crate::buffers::{luma, Value};
use crate::executor::EngineError;
use crate::ops::{image_input, p, range_weights};

/// Which channel a gain applies to.
fn channel_index(name: &str) -> Option<usize> {
    match name {
        "red" => Some(0),
        "green" => Some(1),
        "blue" => Some(2),
        _ => None,
    }
}

/// The Channel Mixer: each output channel as a weighted sum of all
/// three inputs, the full 3x3 that Channel Gain is one diagonal cell
/// of.
///
/// `preserve_gray` (on by default) rescales each row to sum to 100%,
/// so neutrals stay neutral however wild the weights: the constraint
/// that turns a channel mixer from a brightness trap into a color
/// tool. Turn it off and the raw weights apply, which is how the
/// classic red-channel-only monochrome looks are built.
pub(crate) fn channel_mixer(
    node: &Node,
    inputs: &[(String, Value)],
) -> Result<Value, EngineError> {
    let src = image_input(inputs, "in", &node.id)?;
    const NAMES: [[&str; 3]; 3] = [
        ["mix_rr", "mix_rg", "mix_rb"],
        ["mix_gr", "mix_gg", "mix_gb"],
        ["mix_br", "mix_bg", "mix_bb"],
    ];
    let mut m = [[0.0f32; 3]; 3];
    for (r, row) in NAMES.iter().enumerate() {
        for (c, name) in row.iter().enumerate() {
            let ident = if r == c { 100.0 } else { 0.0 };
            m[r][c] = p(&node.params, name, ident).clamp(-200.0, 200.0) / 100.0;
        }
    }
    let preserve = p(&node.params, "preserve_gray", 1.0) >= 0.5;
    if preserve {
        for row in &mut m {
            let sum = row[0] + row[1] + row[2];
            if sum.abs() > 1e-4 {
                for v in row.iter_mut() {
                    *v /= sum;
                }
            }
        }
    }
    if m == [[1.0, 0.0, 0.0], [0.0, 1.0, 0.0], [0.0, 0.0, 1.0]] {
        return Ok(Value::Image(src.clone()));
    }
    let out = crate::ops::map_rgb(src, |r, g, b| {
        [
            m[0][0] * r + m[0][1] * g + m[0][2] * b,
            m[1][0] * r + m[1][1] * g + m[1][2] * b,
            m[2][0] * r + m[2][1] * g + m[2][2] * b,
        ]
    });
    Ok(Value::Image(std::sync::Arc::new(out)))
}

/// Gain on a single channel, or on all three at once through luma.
///
/// The six grain sliders are six of these. So are the three lift/gamma/gain
/// wheels, and so is anything else that says "more of this color". A gain
/// of 100 means unchanged, matching every other percentage in the app, so
/// somebody reading the graph does not have to remember that this one is out
/// of one while the rest are out of a hundred.
///
/// Takes an optional mask, which is what makes it composable: the tonal
/// gains are this same node with a tone mask on the side.
pub(crate) fn channel_gain(
    node: &Node,
    inputs: &[(String, Value)],
) -> Result<Value, EngineError> {
    let src = image_input(inputs, "in", &node.id)?;
    let gain = p(&node.params, "gain", 100.0) / 100.0;
    let channel = node
        .params
        .get("channel")
        .and_then(|v| v.as_str())
        .unwrap_or("luma")
        .to_string();
    if gain == 1.0 {
        return Ok(Value::Image(src.clone()));
    }
    // A mask on the side scales the gain per pixel: no mask is the same as a
    // mask of one everywhere, which is why the two paths are one path.
    let mask = inputs
        .iter()
        .find(|(port, _)| port == "mask")
        .and_then(|(_, v)| match v {
            Value::Image(m) => Some(m.clone()),
            _ => None,
        });

    use rayon::prelude::*;
    let mut out = (**src).clone();
    let only = channel_index(&channel);
    out.data
        .par_chunks_mut(4)
        .enumerate()
        .for_each(|(px, o)| {
            let m = mask
                .as_ref()
                .map(|m| m.data[px * 4].clamp(0.0, 1.0))
                .unwrap_or(1.0);
            // Interpolated by the mask rather than multiplied by it, so a
            // mask of zero leaves the pixel alone instead of erasing it.
            let g = 1.0 + (gain - 1.0) * m;
            match only {
                Some(c) => o[c] *= g,
                None => {
                    for c in 0..3 {
                        o[c] *= g;
                    }
                }
            }
        });
    Ok(Value::Image(Arc::new(out)))
}

/// A mask covering one part of the tonal range.
///
/// The shadow, midtone and highlight weights the grain op computed inline,
/// available as a mask anybody can wire to anything. `bell` is the fourth
/// one: the response that says an effect belongs in the midtones and fades
/// out at both ends, which is the shape film grain actually has and which
/// was previously a magic expression in the middle of a loop.
pub(crate) fn tone_mask(node: &Node, inputs: &[(String, Value)]) -> Result<Value, EngineError> {
    let src = image_input(inputs, "in", &node.id)?;
    let range = node
        .params
        .get("range")
        .and_then(|v| v.as_str())
        .unwrap_or("midtones")
        .to_string();

    let range_gain = 2f32.powf(p(&node.params, "range_ev", 0.0));
    use rayon::prelude::*;
    let mut out = (**src).clone();
    out.data.par_chunks_mut(4).for_each(|o| {
        let y = luma(o[0], o[1], o[2]);
        let l = y.clamp(0.0, 1.0);
        let weights = range_weights(y * range_gain);
        let w = match range.as_str() {
            "shadows" => weights[0],
            "highlights" => weights[2],
            // The midtone response film grain has: strongest at half a stop
            // either side of middle gray, gone at both ends but never all
            // the way, since clean black and clean white look synthetic.
            "bell" => 0.35 + 0.65 * (4.0 * l * (1.0 - l)),
            _ => weights[1],
        };
        for c in 0..3 {
            o[c] = w;
        }
        o[3] = 1.0;
    });
    Ok(Value::Image(Arc::new(out)))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::buffers::ImageBuf;
    use crate::ops::test_util::{make_node, set_num, set_text};

    fn flat(v: f32) -> Value {
        let mut b = ImageBuf::new(8, 8);
        for px in 0..8 * 8 {
            for c in 0..3 {
                b.data[px * 4 + c] = v;
            }
            b.data[px * 4 + 3] = 1.0;
        }
        Value::Image(Arc::new(b))
    }

    fn first(v: &Value) -> [f32; 3] {
        match v {
            Value::Image(b) => [b.data[0], b.data[1], b.data[2]],
            _ => panic!("not an image"),
        }
    }

    #[test]
    fn the_mixer_swaps_channels_and_preserve_gray_holds_neutrals() {
        use crate::ops::test_util::run_on;
        // Red output taken entirely from green, off-constraint.
        let mut node = make_node("heeler.channel_mixer");
        set_num(&mut node, "mix_rr", 0.0);
        set_num(&mut node, "mix_rg", 100.0);
        let mut img = ImageBuf::new(1, 1);
        img.data.copy_from_slice(&[0.6, 0.2, 0.1, 1.0]);
        let out = run_on(&node, img.clone()).unwrap();
        let d = &out.as_image().unwrap().data;
        assert!((d[0] - 0.2).abs() < 1e-6, "{d:?}");
        assert!((d[1] - 0.2).abs() < 1e-6);

        // Wild weights WITH preserve_gray: a gray pixel stays exactly
        // itself, because every row renormalizes to one.
        let mut wild = make_node("heeler.channel_mixer");
        set_num(&mut wild, "mix_rr", 180.0);
        set_num(&mut wild, "mix_rg", -60.0);
        set_num(&mut wild, "mix_rb", 40.0);
        set_num(&mut wild, "mix_gr", 30.0);
        let mut gray = ImageBuf::new(1, 1);
        gray.data.copy_from_slice(&[0.4, 0.4, 0.4, 1.0]);
        let out = run_on(&wild, gray.clone()).unwrap();
        let d = &out.as_image().unwrap().data;
        for c in 0..3 {
            assert!((d[c] - 0.4).abs() < 1e-5, "gray moved: {d:?}");
        }
        // Same weights with the constraint off: gray is no longer safe,
        // which is the whole difference the switch makes.
        set_num(&mut wild, "preserve_gray", 0.0);
        let out = run_on(&wild, gray.clone()).unwrap();
        assert!((out.as_image().unwrap().data[0] - 0.4).abs() > 0.05);

        // Untouched defaults are the identity, bit for bit.
        let idle = make_node("heeler.channel_mixer");
        let same = run_on(&idle, img.clone()).unwrap();
        assert_eq!(same.as_image().unwrap().data, img.data);
    }

    #[test]
    fn a_gain_of_one_hundred_changes_nothing() {
        // The unit of every percentage in this app. A gain node sitting at
        // its default in the middle of a group must be invisible, or opening
        // a group would change the picture.
        let mut n = make_node("heeler.channel_gain");
        set_num(&mut n, "gain", 100.0);
        let out = channel_gain(&n, &[("in".into(), flat(0.5))]).unwrap();
        assert_eq!(first(&out), [0.5, 0.5, 0.5]);
    }

    #[test]
    fn a_channel_gain_touches_only_its_channel() {
        let mut n = make_node("heeler.channel_gain");
        set_num(&mut n, "gain", 200.0);
        set_text(&mut n, "channel", "red");
        let out = channel_gain(&n, &[("in".into(), flat(0.4))]).unwrap();
        let px = first(&out);
        assert!((px[0] - 0.8).abs() < 1e-6, "red should double: {px:?}");
        assert_eq!([px[1], px[2]], [0.4, 0.4], "green and blue untouched");
    }

    #[test]
    fn luma_is_every_channel_at_once() {
        let mut n = make_node("heeler.channel_gain");
        set_num(&mut n, "gain", 50.0);
        let out = channel_gain(&n, &[("in".into(), flat(0.6))]).unwrap();
        for v in first(&out) {
            assert!((v - 0.3).abs() < 1e-6);
        }
    }

    #[test]
    fn a_mask_of_zero_leaves_the_pixel_alone() {
        // Interpolated, not multiplied. Multiplying by the mask would make
        // an unmasked area black rather than unchanged, which is the whole
        // difference between a mask and a wipe.
        let mut n = make_node("heeler.channel_gain");
        set_num(&mut n, "gain", 300.0);
        let mut m = ImageBuf::new(8, 8);
        for px in 0..8 * 8 {
            m.data[px * 4] = 0.0;
        }
        let out = channel_gain(
            &n,
            &[
                ("in".into(), flat(0.5)),
                ("mask".into(), Value::Image(Arc::new(m))),
            ],
        )
        .unwrap();
        assert_eq!(first(&out), [0.5, 0.5, 0.5]);
    }

    #[test]
    fn the_tone_ranges_pick_out_the_tones_they_name() {
        let dark = |range: &str, v: f32| {
            let mut n = make_node("heeler.tone_mask");
            set_text(&mut n, "range", range);
            first(&tone_mask(&n, &[("in".into(), flat(v))]).unwrap())[0]
        };
        assert!(dark("shadows", 0.02) > dark("shadows", 0.9));
        assert!(dark("highlights", 0.95) > dark("highlights", 0.05));
        assert!(dark("midtones", 0.5) > dark("midtones", 0.98));
        // The bell never reaches zero: clean black grain looks synthetic.
        assert!(dark("bell", 0.0) > 0.0);
        assert!(dark("bell", 0.5) > dark("bell", 0.0));
    }

    /// The claim the whole decomposition rests on.
    ///
    /// "The Grain node is the dashboard of a car when in
    /// Develop, Graph mode is actually going under the hood." A dashboard
    /// that reads differently from the engine underneath it is worse than no
    /// dashboard, so the pieces wired together have to land where the one
    /// node lands.
    ///
    /// Not bit-identical, and it cannot be: the single node sums the three
    /// tonal weights and multiplies once, while three gain nodes in a row
    /// each multiply where they apply. Both are one at their defaults and
    /// both give the user's number in the band it belongs to; they differ
    /// only where two bands overlap. This holds them to the same picture.
    #[test]
    fn the_pieces_wired_up_land_where_the_one_node_lands() {
        use crate::ops::execute;

        let src = {
            let mut b = ImageBuf::new(32, 32);
            for px in 0..32 * 32 {
                // A ramp, so every tonal band is represented.
                let v = (px % 32) as f32 / 31.0;
                for c in 0..3 {
                    b.data[px * 4 + c] = v;
                }
                b.data[px * 4 + 3] = 1.0;
            }
            Arc::new(b)
        };

        let mut one = make_node("heeler.grain");
        set_num(&mut one, "intensity", 60.0);
        set_num(&mut one, "size", 20.0);
        let whole = execute(&one, &[("in".into(), Value::Image(src.clone()))])
            .unwrap()
            .as_image()
            .unwrap()
            .clone();

        // The same thing out of parts: field, then the bell as the blend's
        // mask, then add at the intensity asked for. The six gains are at
        // their defaults here, which is the case that has to match exactly.
        let mut field_node = make_node("heeler.noise");
        set_num(&mut field_node, "size", 20.0);
        let field = execute(&field_node, &[("in".into(), Value::Image(src.clone()))]).unwrap();

        let mut bell = make_node("heeler.tone_mask");
        set_text(&mut bell, "range", "bell");
        let bell_mask = execute(&bell, &[("in".into(), Value::Image(src.clone()))]).unwrap();

        let mut add = make_node("heeler.blend");
        set_text(&mut add, "mode", "add");
        set_num(&mut add, "opacity", 60.0);
        let built = execute(
            &add,
            &[
                ("base".into(), Value::Image(src.clone())),
                ("blend".into(), field),
                ("mask".into(), bell_mask),
            ],
        )
        .unwrap()
        .as_image()
        .unwrap()
        .clone();

        let mut worst = 0.0f32;
        for i in 0..32 * 32 {
            worst = worst.max((whole.data[i * 4] - built.data[i * 4]).abs());
        }
        assert!(
            worst < 1e-5,
            "the group and the node disagree by {worst}, which the user would see",
        );
    }

    #[test]
    fn a_real_mask_buffer_gates_the_blend_too() {
        // Art-layer masks arrive as Value::Mask; only images were read
        // before, so a brush mask on a layer blend did nothing.
        use crate::buffers::MaskBuf;
        use crate::ops::execute;
        let mut n = make_node("heeler.blend");
        set_text(&mut n, "mode", "normal");
        let mut m = MaskBuf::new(8, 8);
        for x in 0..8 {
            for y in 0..8 {
                m.data[y * 8 + x] = if x < 4 { 1.0 } else { 0.0 };
            }
        }
        let out = execute(
            &n,
            &[
                ("base".into(), flat(0.25)),
                ("blend".into(), flat(0.75)),
                ("mask".into(), Value::Mask(Arc::new(m))),
            ],
        )
        .unwrap();
        let img = out.as_image().unwrap();
        assert!((img.pixel(1, 4)[0] - 0.75).abs() < 1e-5, "masked-in side blends");
        assert!((img.pixel(6, 4)[0] - 0.25).abs() < 1e-5, "masked-out side is base");
    }

    #[test]
    fn a_transparent_top_leaves_the_base_alone() {
        // Paint layers are transparent where nobody painted; the blend
        // reads the top's alpha, so bare canvas means "base shows
        // through", never "blend with black".
        use crate::ops::execute;
        let mut n = make_node("heeler.blend");
        set_text(&mut n, "mode", "normal");
        let mut top = ImageBuf::new(8, 8);
        // Left half: opaque white paint. Right half: untouched canvas.
        for y in 0..8 {
            for x in 0..8 {
                let i = (y * 8 + x) * 4;
                if x < 4 {
                    top.data[i..i + 4].copy_from_slice(&[1.0, 1.0, 1.0, 1.0]);
                }
            }
        }
        let out = execute(
            &n,
            &[
                ("base".into(), flat(0.25)),
                ("blend".into(), Value::Image(Arc::new(top))),
            ],
        )
        .unwrap();
        let img = out.as_image().unwrap();
        assert!((img.pixel(1, 4)[0] - 1.0).abs() < 1e-5, "painted side blends");
        assert!(
            (img.pixel(6, 4)[0] - 0.25).abs() < 1e-5,
            "transparent side is untouched base, got {}",
            img.pixel(6, 4)[0]
        );
    }

    #[test]
    fn a_blend_mask_of_zero_is_a_blend_that_did_not_happen() {
        // The mask port was declared on the blend spec long before anything
        // read it, so a mask wired to a blend did nothing at all.
        use crate::ops::execute;
        let mut n = make_node("heeler.blend");
        set_text(&mut n, "mode", "add");
        let mut m = ImageBuf::new(8, 8);
        for px in 0..8 * 8 {
            m.data[px * 4] = 0.0;
        }
        let out = execute(
            &n,
            &[
                ("base".into(), flat(0.25)),
                ("blend".into(), flat(0.5)),
                ("mask".into(), Value::Image(Arc::new(m))),
            ],
        )
        .unwrap();
        assert_eq!(first(&out), [0.25, 0.25, 0.25]);
    }

    #[test]
    fn the_three_ranges_cover_the_whole_tonal_scale() {
        // They are a partition, so an effect split across all three and put
        // back together is the effect at full strength, not a dip somewhere
        // in the middle of the ramp.
        for step in 0..=20 {
            let l = step as f32 / 20.0;
            let sum: f32 = ["shadows", "midtones", "highlights"]
                .iter()
                .map(|r| {
                    let mut n = make_node("heeler.tone_mask");
                    set_text(&mut n, "range", r);
                    first(&tone_mask(&n, &[("in".into(), flat(l))]).unwrap())[0]
                })
                .sum();
            assert!((sum - 1.0).abs() < 1e-5, "at {l} the ranges summed to {sum}");
        }
    }
}
