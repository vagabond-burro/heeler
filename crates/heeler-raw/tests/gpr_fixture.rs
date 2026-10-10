//! A real GoPro GPR in the default suite: fixtures/GOPR0055.GPR, a HERO7
//! Black frame of a ColorChecker in daylight from raw.pixls.us, released
//! there under CC0 (see fixtures/README.md). The synthetic GPRs elsewhere
//! prove the header handling and the damage paths; this one proves a real
//! VC-5 tile decodes to a real picture, on every run.

const GPR: &[u8] = include_bytes!("fixtures/GOPR0055.GPR");

fn means(rgb: &[u16]) -> [f64; 3] {
    let n = (rgb.len() / 3) as f64;
    let mut m = [0.0; 3];
    for px in rgb.chunks_exact(3) {
        for c in 0..3 {
            m[c] += px[c] as f64;
        }
    }
    m.map(|v| v / n / 65535.0)
}

#[test]
fn the_fixture_is_a_gpr_of_the_size_its_header_names() {
    assert!(heeler_raw::is_gpr(GPR));
    assert_eq!(heeler_raw::dimensions(GPR).unwrap(), (4000, 3000));
}

#[test]
fn a_real_gpr_develops_to_a_picture_at_full_and_half_size() {
    let full = heeler_raw::decode_sensor(GPR).unwrap();
    let half = heeler_raw::decode_sensor_half(GPR).unwrap();
    assert!(full.width >= 3998 && full.height >= 2998, "{}x{}", full.width, full.height);
    assert!(half.width * 2 >= full.width - 2 && half.height * 2 >= full.height - 2, "{}x{}", half.width, half.height);
    let (f, h) = (means(&full.rgb), means(&half.rgb));
    // What this tile decodes to today. A misread tile is a flat field or
    // noise, far from these; the half tier averages the same samples.
    for (got, want) in [(f, FULL_MEANS), (h, FULL_MEANS)] {
        for c in 0..3 {
            assert!((got[c] - want[c]).abs() < 0.004, "{got:?} against {want:?}");
        }
    }
    // Neighbors agree as in a picture, not as in noise.
    let step = full.rgb.chunks_exact(3).zip(full.rgb.chunks_exact(3).skip(1)).map(|(a, b)| (a[1] as f64 - b[1] as f64).abs()).sum::<f64>() / (full.rgb.len() / 3) as f64 / 65535.0;
    assert!(step < 0.03, "step {step}");
}

const FULL_MEANS: [f64; 3] = [0.2298, 0.1600, 0.0978];

#[test]
fn a_gpr_cut_short_says_so_rather_than_developing_garbage() {
    let cut = &GPR[..GPR.len() * 2 / 3];
    assert!(heeler_raw::is_gpr(cut));
    let why = heeler_raw::decode_sensor_half(cut).map(|_| ()).unwrap_err().to_string();
    assert!(why.contains("GoPro GPR"), "{why}");
}
