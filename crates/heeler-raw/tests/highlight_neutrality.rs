//! Blown highlights develop neutral, not pink (2026-10-10: a reviewer found
//! a pink cast in the clipped sky of a raw in a Lightroom clone, where
//! Lightroom rolls it off to white, and called it the failure of almost
//! every raw editor built that way). The cast comes from scaling red and
//! blue by the white balance past a clipped green; LibRaw's clip mode cuts
//! every channel at the sensor's white after the balance, and blend fills
//! a clipped channel from the others, so both stay neutral, and the
//! unclipped mode that does not is never offered (shim.cpp).
//!
//! fixtures/IMG_3310.CR2 is a Canon PowerShot G11 street under an overcast,
//! blown sky, about a fifth of the frame at the sensor's white; CC0 from
//! raw.pixls.us (see fixtures/README.md). The blown region is the pixels
//! at white in any channel under clip, and every mode is measured on those
//! same pixels.

const CR2: &[u8] = include_bytes!("fixtures/IMG_3310.CR2");

/// What the blown region looks like in one mode: its share of the frame,
/// each channel's mean over its brightest, and the share that is pink
/// (green clearly under both red and blue).
fn blown(mode: i32, at: Option<&[bool]>) -> (Vec<bool>, f64, [f64; 3], f64) {
    let img = heeler_raw::decode_sensor_with(CR2, heeler_raw::DevelopOpts { half_size: true, highlight: mode, ..Default::default() }).unwrap();
    let h = img.headroom.max(1.0) as f64;
    let px: Vec<[f64; 3]> = img.rgb.chunks_exact(3).map(|p| [p[0] as f64 / 65535.0 * h, p[1] as f64 / 65535.0 * h, p[2] as f64 / 65535.0 * h]).collect();
    let mask: Vec<bool> = match at {
        Some(m) => m.to_vec(),
        None => px.iter().map(|v| v[0].max(v[1]).max(v[2]) >= 0.999).collect(),
    };
    let (mut n, mut pink, mut sum) = (0usize, 0usize, [0f64; 3]);
    for (v, _) in px.iter().zip(&mask).filter(|(_, m)| **m) {
        let mx = v[0].max(v[1]).max(v[2]);
        for c in 0..3 {
            sum[c] += v[c] / mx;
        }
        if v[1] < 0.97 * v[0] && v[1] < 0.97 * v[2] {
            pink += 1;
        }
        n += 1;
    }
    let share = n as f64 / px.len() as f64;
    (mask, share, sum.map(|s| s / n.max(1) as f64), pink as f64 / n.max(1) as f64)
}

/// No channel far under the brightest on average, and almost no pixel
/// with green under both red and blue.
fn assert_neutral(label: &str, mean: [f64; 3], pink: f64) {
    for (c, name) in mean.iter().zip(["red", "green", "blue"]) {
        assert!(*c > 0.94, "{label}: {name} averages {c:.3} of the brightest channel over the blown sky: {mean:?}");
    }
    assert!(pink < 0.005, "{label}: {:.2}% of the blown sky is pink", pink * 100.0);
}

#[test]
fn a_blown_sky_develops_neutral_in_clip_and_blend() {
    let (mask, share, mean, pink) = blown(0, None);
    assert!(share > 0.15, "the fixture's blown sky is {:.1}% of the frame, expected about a fifth", share * 100.0);
    assert_neutral("clip", mean, pink);
    let (_, _, mean, pink) = blown(2, Some(&mask));
    assert_neutral("blend", mean, pink);
}
