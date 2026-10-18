//! A full-size Bayer develop's AHD is the same across the cores as
//! LibRaw's own one-after-another ahd_interpolate, to the bit, at any
//! number of threads: the shim runs LibRaw's own tile steps, each worker
//! with its own zeroed buffer, and a tile reads only the sensor values
//! the others leave as they were. The repository's clipped-sky Canon G11
//! raw (CC0, raw.pixls.us); a highlight mode and a run asked to the
//! default count twice, since workers take tile rows as they free up.
use std::sync::Mutex;

/// The switches are process-wide; the tests in this file take turns.
static SERIAL: Mutex<()> = Mutex::new(());

fn fixture() -> Vec<u8> {
    std::fs::read(std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/IMG_3310.CR2")).unwrap()
}

#[test]
fn the_parallel_ahd_is_libraws_own_to_the_bit() {
    let _turn = SERIAL.lock().unwrap_or_else(|e| e.into_inner());
    let bytes = fixture();
    for highlight in [0, 2] {
        let opts = heeler_raw::DevelopOpts { highlight, ..heeler_raw::DevelopOpts::default() };
        heeler_raw::set_parallel_ahd(false);
        let own = heeler_raw::decode_sensor_with(&bytes, opts).unwrap();
        heeler_raw::set_parallel_ahd(true);
        for threads in [1, 2, 3, 8, 0, 0] {
            heeler_raw::set_ahd_threads(threads);
            let run = heeler_raw::decode_sensor_with(&bytes, opts).unwrap();
            assert_eq!((run.width, run.height), (own.width, own.height));
            assert!(run.rgb == own.rgb, "highlight {highlight}, {threads} threads: differs from LibRaw's own AHD");
        }
        heeler_raw::set_ahd_threads(0);
    }
}

#[test]
fn a_demosaic_other_than_ahd_is_left_to_libraw() {
    // Linear and DHT are LibRaw's own whatever the switch says.
    let _turn = SERIAL.lock().unwrap_or_else(|e| e.into_inner());
    let bytes = fixture();
    for demosaic in [0, 11] {
        let opts = heeler_raw::DevelopOpts { demosaic, ..heeler_raw::DevelopOpts::default() };
        heeler_raw::set_parallel_ahd(false);
        let own = heeler_raw::decode_sensor_with(&bytes, opts).unwrap();
        heeler_raw::set_parallel_ahd(true);
        let run = heeler_raw::decode_sensor_with(&bytes, opts).unwrap();
        assert!(run.rgb == own.rgb, "demosaic {demosaic}");
    }
}

#[test]
fn a_bayer_develop_fits_the_worker_slice_it_estimates() {
    let _turn = SERIAL.lock().unwrap_or_else(|e| e.into_inner());
    let bytes = fixture();
    heeler_raw::set_parallel_ahd(true);
    heeler_raw::set_ahd_threads(3);
    for highlight in [0, 2] {
        let opts = heeler_raw::DevelopOpts { highlight, ..Default::default() };
        let needed = heeler_raw::develop_bytes(&bytes, opts).unwrap();
        let job = heeler_engine::memory::Job::admit(needed, "develop worker test").unwrap();
        let image = job.worker(needed).run(|| heeler_raw::decode_sensor_with(&bytes, opts)).unwrap();
        assert!(!image.rgb.is_empty());
    }
    heeler_raw::set_ahd_threads(0);
}
