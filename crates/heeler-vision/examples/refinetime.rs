//! How long the export's depth refinement steps take on a full-size
//! frame (61 MP, the ARW the console log names). Run by hand in release.
fn main() {
    let (w, h) = (9504usize, 6336usize);
    let t = std::time::Instant::now();
    let small: Vec<f32> = (0..518 * 345).map(|i| (i % 518) as f32 / 518.0).collect();
    let far = heeler_vision::resize_plane(&small, 518, 345, w, h);
    println!("resize_plane: {:.0} ms", t.elapsed().as_secs_f64() * 1000.0);
    let guide: Vec<f32> = (0..w * h * 4).map(|i| ((i as u32).wrapping_mul(2654435761) >> 8) as f32 / 16777216.0).collect();
    let t = std::time::Instant::now();
    let mut rgb = vec![0.0f32; w * h * 3];
    for (i, px) in guide.chunks(4).enumerate() {
        for c in 0..3 {
            rgb[i * 3 + c] = { let v = px[c].max(0.0); if v <= 0.0031308 { v * 12.92 } else { 1.055 * v.powf(1.0 / 2.4) - 0.055 } }.min(1.0) * 255.0;
        }
    }
    println!("rgb loop: {:.0} ms", t.elapsed().as_secs_f64() * 1000.0);
    let t = std::time::Instant::now();
    let out = heeler_vision::refine_depth(&far, &rgb, w, h, 0.5, 0.25);
    println!("refine_depth: {:.0} ms ({})", t.elapsed().as_secs_f64() * 1000.0, out.len());
    let mut hash: u64 = 0xcbf29ce484222325;
    for v in out.iter().chain(&far) {
        hash = (hash ^ v.to_bits() as u64).wrapping_mul(0x100000001b3);
    }
    println!("hash {hash:016x}");
}
