//! Writes LibRaw's whole unpacked frame of a raw file, for working out a
//! coding from the data: OUT gets the frame's samples as little-endian
//! 16-bit words, row by row. Prints the frame's width and height, then
//! what LibRaw read when it opened the file: the image area (top, left,
//! width, height), the camera's white balance, the black levels (common,
//! then per CFA site), the white level and the orientation; and the black
//! LibRaw subtracts at the image area's top left 2 by 2 sites once the
//! file is unpacked.
//!
//!   cargo run --release -p heeler-raw --example rawframe -- FILE [OUT]
fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let bytes = std::fs::read(&args[0]).expect("FILE");
    let (w, h, frame) = heeler_raw::libraw_frame(&bytes).expect("LibRaw's frame");
    if let Some(out) = args.get(1) {
        let out_bytes: Vec<u8> = frame.iter().flat_map(|v| v.to_le_bytes()).collect();
        std::fs::write(out, out_bytes).expect("OUT");
    }
    println!("{w} {h}");
    let f = heeler_raw::linear_dng::libraw_facts(&bytes, heeler_raw::DevelopOpts::default()).expect("LibRaw's facts");
    println!(
        "area {} {} {} {} cam_mul {:?} black {} cblack {:?} maximum {} flip {}",
        f.top_margin, f.left_margin, f.width, f.height, f.cam_mul, f.black, &f.cblack[..4], f.maximum, f.flip
    );
    let b = heeler_raw::libraw_black_unpacked_8x8(&bytes).expect("LibRaw's black");
    println!("unpacked black {:?}", [b[0][0], b[0][1], b[1][0], b[1][1]]);
}
