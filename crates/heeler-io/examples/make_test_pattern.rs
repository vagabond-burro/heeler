//! Generates assets/test-pattern.png: a TV-test-card style target for
//! exercising color, tone, and mask features against known values.
//!
//! Layout (1920 x 1080):
//! - Top 40%: eight 75%-saturation color bars (white, yellow, cyan, green,
//!   magenta, red, blue, black)
//! - Next 15%: the same bars at 100% saturation
//! - Next 15%: continuous horizontal hue sweep
//! - Next 15%: continuous grayscale ramp (black to white, linear in sRGB)
//! - Bottom 15%: 11-step gray staircase plus skin-tone patches
//!
//! Run: cargo run -p heeler-io --example make_test_pattern

use heeler_engine::ImageBuf;
use heeler_io::{encode_png, srgb_to_linear};

const W: usize = 1920;
const H: usize = 1080;

fn fill_rect(buf: &mut ImageBuf, x0: usize, y0: usize, x1: usize, y1: usize, srgb: [f32; 3]) {
    let px = [
        srgb_to_linear(srgb[0]),
        srgb_to_linear(srgb[1]),
        srgb_to_linear(srgb[2]),
        1.0,
    ];
    for y in y0..y1.min(buf.height) {
        for x in x0..x1.min(buf.width) {
            buf.set_pixel(x, y, px);
        }
    }
}

fn hue_to_rgb(h: f32) -> [f32; 3] {
    let h = (h % 360.0) / 60.0;
    let x = 1.0 - (h % 2.0 - 1.0).abs();
    match h as u32 {
        0 => [1.0, x, 0.0],
        1 => [x, 1.0, 0.0],
        2 => [0.0, 1.0, x],
        3 => [0.0, x, 1.0],
        4 => [x, 0.0, 1.0],
        _ => [1.0, 0.0, x],
    }
}

fn main() {
    let mut img = ImageBuf::new(W, H);

    let bars: [[f32; 3]; 8] = [
        [1.0, 1.0, 1.0],
        [1.0, 1.0, 0.0],
        [0.0, 1.0, 1.0],
        [0.0, 1.0, 0.0],
        [1.0, 0.0, 1.0],
        [1.0, 0.0, 0.0],
        [0.0, 0.0, 1.0],
        [0.0, 0.0, 0.0],
    ];

    // 75% bars.
    let y75 = (H as f32 * 0.40) as usize;
    for (i, c) in bars.iter().enumerate() {
        let x0 = i * W / 8;
        let x1 = (i + 1) * W / 8;
        fill_rect(&mut img, x0, 0, x1, y75, [c[0] * 0.75, c[1] * 0.75, c[2] * 0.75]);
    }

    // 100% bars.
    let y100 = (H as f32 * 0.55) as usize;
    for (i, c) in bars.iter().enumerate() {
        let x0 = i * W / 8;
        let x1 = (i + 1) * W / 8;
        fill_rect(&mut img, x0, y75, x1, y100, *c);
    }

    // Hue sweep.
    let y_hue = (H as f32 * 0.70) as usize;
    for x in 0..W {
        let rgb = hue_to_rgb(x as f32 / W as f32 * 360.0);
        fill_rect(&mut img, x, y100, x + 1, y_hue, rgb);
    }

    // Grayscale ramp.
    let y_ramp = (H as f32 * 0.85) as usize;
    for x in 0..W {
        let v = x as f32 / (W - 1) as f32;
        fill_rect(&mut img, x, y_hue, x + 1, y_ramp, [v, v, v]);
    }

    // 11-step staircase on the left 2/3, skin tones on the right 1/3.
    let steps = 11;
    let stair_w = W * 2 / 3;
    for i in 0..steps {
        let v = i as f32 / (steps - 1) as f32;
        let x0 = i * stair_w / steps;
        let x1 = (i + 1) * stair_w / steps;
        fill_rect(&mut img, x0, y_ramp, x1, H, [v, v, v]);
    }
    let skins: [[f32; 3]; 4] = [
        [0.96, 0.80, 0.69],
        [0.78, 0.57, 0.45],
        [0.55, 0.37, 0.26],
        [0.35, 0.24, 0.17],
    ];
    for (i, s) in skins.iter().enumerate() {
        let x0 = stair_w + i * (W - stair_w) / 4;
        let x1 = stair_w + (i + 1) * (W - stair_w) / 4;
        fill_rect(&mut img, x0, y_ramp, x1, H, *s);
    }

    let bytes = encode_png(&img).expect("encode test pattern");
    let out = std::path::Path::new("assets/test-pattern.png");
    std::fs::write(out, bytes).expect("write test pattern");
    println!("wrote {} ({}x{})", out.display(), W, H);
}
