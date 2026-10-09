use heeler_io::resolution::{clamp_dpi, normalize_dpi, MAX_DPI};
use heeler_io::DEFAULT_DPI;

#[test]
fn numeric_resolution_matches_the_ui_rounding_bounds_and_defaults() {
    for (input, expected) in [
        (None, DEFAULT_DPI),
        (Some(f64::NAN), DEFAULT_DPI),
        (Some(f64::INFINITY), DEFAULT_DPI),
        (Some(f64::NEG_INFINITY), DEFAULT_DPI),
        (Some(0.0), 1),
        (Some(-5.0), 1),
        (Some(240.4), 240),
        (Some(240.5), 241),
        (Some(1.0e100), MAX_DPI),
        (Some(-1.0e100), 1),
    ] {
        assert_eq!(normalize_dpi(input), expected, "{input:?}");
    }
    assert_eq!(clamp_dpi(0), 1);
    assert_eq!(clamp_dpi(u32::MAX), MAX_DPI);
}
