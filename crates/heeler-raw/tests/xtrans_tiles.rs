//! A full-size X-Trans develop is the same whatever order its tile bands
//! run in. Upstream LibRaw's xtrans_interpolate wrote each tile's
//! finished pixels back into the image the next tile's margin read, so
//! its result depended on the order (and, with OpenMP, on the race); the
//! patched one keeps finished pixels apart and shares the bands between
//! threads. Any X-Trans file shows it; it lives outside the repository,
//! so this is ignored by default:
//!
//!     HEELER_XTRANS_SAMPLE=/path/to/DSCF8848.RAF cargo test --release -p heeler-raw --test xtrans_tiles -- --ignored --nocapture

#[test]
#[ignore]
fn an_xtrans_develop_is_the_same_on_any_number_of_threads() {
    let path = std::env::var("HEELER_XTRANS_SAMPLE").expect("set HEELER_XTRANS_SAMPLE");
    let bytes = std::fs::read(&path).unwrap_or_else(|e| panic!("{path}: {e}"));
    heeler_raw::set_xtrans_threads(1);
    let serial = heeler_raw::decode_sensor(&bytes).unwrap();
    // Several counts, and four twice: with bands handed out as threads
    // free up, each run takes them in its own order.
    for threads in [2, 3, 4, 4, 7] {
        heeler_raw::set_xtrans_threads(threads);
        let run = heeler_raw::decode_sensor(&bytes).unwrap();
        assert_eq!((run.width, run.height), (serial.width, serial.height));
        assert!(run.rgb == serial.rgb, "{threads} threads differ from one");
    }
    heeler_raw::set_xtrans_threads(0);
}
