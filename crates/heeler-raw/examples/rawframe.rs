//! Writes LibRaw's whole unpacked frame of a raw file, for working out a
//! coding from the data: OUT gets the frame's samples as little-endian
//! 16-bit words, row by row, and the frame's width and height are printed.
//!
//!   cargo run --release -p heeler-raw --example rawframe -- FILE OUT
fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let bytes = std::fs::read(&args[0]).expect("FILE");
    let (w, h, frame) = heeler_raw::libraw_frame(&bytes).expect("LibRaw's frame");
    let out: Vec<u8> = frame.iter().flat_map(|v| v.to_le_bytes()).collect();
    std::fs::write(&args[1], out).expect("OUT");
    println!("{w} {h}");
}
