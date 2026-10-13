//! picture_dimensions answers from the header what a develop hands
//! back: the visible picture, not the sensor's whole readout, which is
//! what dimensions reports for admission.

const CR2: &[u8] = include_bytes!("fixtures/IMG_3310.CR2");
const GPR: &[u8] = include_bytes!("fixtures/GOPR0055.GPR");

#[test]
fn picture_dimensions_are_the_developed_size() {
    for (name, bytes) in [("CR2", CR2), ("GPR", GPR)] {
        let developed = heeler_raw::decode_sensor(bytes).unwrap();
        assert_eq!(heeler_raw::picture_dimensions(bytes).unwrap(), (developed.width, developed.height), "{name}");
    }
    // The G11's readout carries masked margins the picture does not.
    let (rw, rh) = heeler_raw::dimensions(CR2).unwrap();
    let (pw, ph) = heeler_raw::picture_dimensions(CR2).unwrap();
    assert!(rw > pw && rh > ph, "readout {rw}x{rh}, picture {pw}x{ph}");
}

#[test]
fn picture_dimensions_refuse_what_libraw_cannot_open() {
    assert!(heeler_raw::picture_dimensions(b"not a raw file at all").is_err());
}
