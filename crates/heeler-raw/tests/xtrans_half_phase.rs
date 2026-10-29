//! A half-size X-Trans develop fills the all-green ninth of its pixels,
//! whatever the top-left corner holds. LibRaw used to find that ninth
//! from the pixel values and, on a dark, noisy corner, filled the wrong
//! one: the real all-green ninth kept R = B = 0 and the whole Fit
//! preview went green against the full-size develop. The sample that
//! showed it is a Fujifilm X70 frame, DSCF8848.RAF (ISO 6400, dark),
//! which lives outside the repository, so this is ignored by default:
//!
//!     HEELER_XTRANS_SAMPLE=/path/to/DSCF8848.RAF cargo test -p heeler-raw --test xtrans_half_phase -- --ignored --nocapture

/// Whole-frame mean of each channel, as fractions of full scale.
fn means(img: &heeler_raw::SensorImage) -> [f64; 3] {
    let n = (img.rgb.len() / 3) as f64;
    let mut m = [0.0; 3];
    for px in img.rgb.chunks_exact(3) {
        for c in 0..3 {
            m[c] += px[c] as f64;
        }
    }
    m.map(|v| v / n / 65535.0)
}

#[test]
#[ignore]
fn the_half_size_develop_fills_the_right_ninth() {
    let path = std::env::var("HEELER_XTRANS_SAMPLE").expect("set HEELER_XTRANS_SAMPLE");
    let bytes = std::fs::read(&path).unwrap_or_else(|e| panic!("{path}: {e}"));
    let half = heeler_raw::decode_sensor_half(&bytes).unwrap();
    let full = heeler_raw::decode_sensor(&bytes).unwrap();

    // No phase of the half-size grid is left without red and blue.
    // Before the fix one phase was, in every one of its pixels.
    let mut zero = [[0usize; 3]; 3];
    let mut count = [[0usize; 3]; 3];
    for y in 0..half.height {
        for x in 0..half.width {
            let i = (y * half.width + x) * 3;
            count[y % 3][x % 3] += 1;
            if half.rgb[i] == 0 && half.rgb[i + 2] == 0 {
                zero[y % 3][x % 3] += 1;
            }
        }
    }
    for r in 0..3 {
        for c in 0..3 {
            let share = zero[r][c] as f64 / count[r][c] as f64;
            println!("phase ({r}, {c}): R = B = 0 in {:.1}%", share * 100.0);
            assert!(share < 0.05, "phase ({r}, {c}) has R = B = 0 in {:.1}% of its pixels", share * 100.0);
        }
    }

    // And the half-size picture has no cast against the full-size one.
    // The unfilled ninth took a ninth off the red and the blue, both
    // ratios near 0.89. Above 1 the check is looser: the camera's
    // calibration pulls a quarter of this dark frame's half-size blue
    // samples below zero (its blue row takes off 0.72 of green) and the
    // clip at zero lifts their mean. A half-size pixel's red and blue are
    // one sample each, noisier than the full-size demosaic's, so more of
    // them clip, and half-size B/G reads about 6% above full size where
    // before the clip the two agree within 1%.
    let (h, f) = (means(&half), means(&full));
    let rg = (h[0] / h[1]) / (f[0] / f[1]);
    let bg = (h[2] / h[1]) / (f[2] / f[1]);
    println!("half / full: R/G {rg:.3}, B/G {bg:.3}");
    assert!((0.97..1.10).contains(&rg), "half-size R/G is {rg:.3} of full-size");
    assert!((0.97..1.10).contains(&bg), "half-size B/G is {bg:.3} of full-size");
}
