//! Says what an OpenEXR holds the way Heeler sees it: the part and
//! channels chosen as the beauty, the primaries, and every pass the
//! render-pass phases will read.
//!
//!     cargo run -p heeler-io --example exr_inspect -- FILE.exr [MORE.exr ...]
//!
//! With --decode it also reads the beauty and prints its value range,
//! which is the quickest check that a file's color survives intake.

use heeler_io::exr_passes::{self, Beauty};

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let decode = args.iter().any(|a| a == "--decode");
    for path in args.iter().filter(|a| *a != "--decode") {
        println!("==== {path}");
        let bytes = match std::fs::read(path) {
            Ok(b) => b,
            Err(e) => { println!("  cannot read: {e}"); continue; }
        };
        if !exr_passes::is_exr(&bytes) {
            println!("  not an OpenEXR file");
            continue;
        }
        let info = match exr_passes::inspect(&bytes) {
            Ok(i) => i,
            Err(e) => { println!("  {e}"); continue; }
        };
        println!("  {} x {}, part {}", info.width, info.height, info.part);
        match &info.beauty {
            Beauty::Rgb { r, g, b, a } => println!("  beauty: {r} {g} {b}{}", a.as_ref().map(|a| format!(" alpha {a}")).unwrap_or_default()),
            Beauty::Luminance { y, a } => println!("  beauty: luminance {y}{}", a.as_ref().map(|a| format!(" alpha {a}")).unwrap_or_default()),
            Beauty::None => println!("  beauty: none (passes only, opens as a gray plate)"),
        }
        println!("  primaries: {}", info.primaries.known_name().unwrap_or("custom chromaticities"));
        match &info.depth {
            Some(d) => println!("  depth: {} ({})", d.name, if d.metric { "metric Z" } else { "normalized mist" }),
            None => println!("  depth: none"),
        }
        match &info.normals {
            Some(n) => println!("  normals: {} {} {}", n[0], n[1], n[2]),
            None => println!("  normals: none"),
        }
        for c in &info.cryptomattes {
            println!("  cryptomatte {}: {} ranks, {} names", c.layer, c.ranks.len(), c.entries.len());
            for e in c.entries.iter().take(12) {
                println!("      {:08x}  {}", e.hash, e.name);
            }
            if c.entries.len() > 12 {
                println!("      ... {} more", c.entries.len() - 12);
            }
        }
        for m in &info.mattes {
            println!("  matte channel: {m}");
        }
        println!("  {} channels in the part", info.channels.len());
        if decode {
            match exr_passes::decode_beauty(&bytes) {
                Ok(img) => {
                    let (mut lo, mut hi) = (f32::INFINITY, f32::NEG_INFINITY);
                    for px in img.data.chunks_exact(4) {
                        for c in &px[..3] { lo = lo.min(*c); hi = hi.max(*c); }
                    }
                    println!("  beauty decoded: {} x {}, RGB range {lo:.4} .. {hi:.4}", img.width, img.height);
                }
                Err(e) => println!("  beauty decode failed: {e}"),
            }
        }
    }
}
