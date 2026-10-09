//! Generates placeholder app icons for the Tauri shell (simplified flat
//! rendition of the split-head icon: plate, steel/amber halves, split line).
//! The real icon set gets rasterized from assets/icon/heeler-icon.svg before
//! release; these exist so dev and bundle builds have valid icon files.
//!
//! Run: cargo run -p heeler-io --example make_app_icons

use heeler_engine::ImageBuf;
use heeler_io::{encode_png, srgb_to_linear};

fn lin(c: [f32; 3]) -> [f32; 4] {
    [srgb_to_linear(c[0]), srgb_to_linear(c[1]), srgb_to_linear(c[2]), 1.0]
}

fn icon(size: usize) -> ImageBuf {
    let s = size as f32;
    let mut img = ImageBuf::new(size, size);
    let plate = lin([0.08, 0.086, 0.094]);
    let steel = lin([0.357, 0.427, 0.494]);
    let amber = lin([0.812, 0.569, 0.251]);
    let line = lin([0.933, 0.949, 0.961]);
    for y in 0..size {
        for x in 0..size {
            let (fx, fy) = (x as f32 / s, y as f32 / s);
            // Rounded-plate mask (superellipse-ish corner cut).
            let (cx, cy) = ((fx - 0.5).abs(), (fy - 0.5).abs());
            let corner = (cx - 0.30).max(0.0).powi(2) + (cy - 0.30).max(0.0).powi(2);
            if corner > 0.030 {
                img.set_pixel(x, y, [0.0, 0.0, 0.0, 0.0]);
                continue;
            }
            // Head silhouette: triangle-ish ears + face block.
            let in_face = fy > 0.30 && fy < 0.82 && cx < 0.26 - (fy - 0.30) * 0.22;
            let in_ear = fy <= 0.34 && fy > 0.12 && cx > 0.06 && cx < 0.30 && (0.34 - fy) < (cx - 0.04) * 1.4;
            let px = if in_face || in_ear {
                if (fx - 0.5).abs() < 0.006 { line } else if fx < 0.5 { steel } else { amber }
            } else if (fx - 0.5).abs() < 0.004 && fy > 0.08 && fy < 0.92 {
                line
            } else {
                plate
            };
            img.set_pixel(x, y, px);
        }
    }
    img
}

fn main() {
    let dir = std::path::Path::new("apps/heeler-app/src-tauri/icons");
    std::fs::create_dir_all(dir).expect("mkdir icons");
    for (size, name) in [(32usize, "32x32.png"), (128, "128x128.png"), (256, "128x128@2x.png"), (512, "icon.png")] {
        let bytes = encode_png(&icon(size)).expect("png");
        std::fs::write(dir.join(name), bytes).expect("write png");
    }
    // ICO: single 256px PNG-compressed entry, hand-rolled header.
    let png = encode_png(&icon(256)).expect("png");
    let mut ico: Vec<u8> = vec![0, 0, 1, 0, 1, 0];
    ico.extend_from_slice(&[0, 0, 0, 0, 1, 0, 32, 0]); // 256x256, planes 1, 32bpp
    ico.extend_from_slice(&(png.len() as u32).to_le_bytes());
    ico.extend_from_slice(&22u32.to_le_bytes());
    ico.extend_from_slice(&png);
    std::fs::write(dir.join("icon.ico"), ico).expect("write ico");
    println!("wrote icons to {}", dir.display());
}
