//! Pull one JPEG XL tile out of a DNG and ask jxl-oxide what it is,
//! separately from any DNG plumbing.
//!
//!     cargo run -p heeler-io --example jxltile -- <file.dng> [tile index|all]
//!
//! This is what isolated the float-DNG failure to jxl-oxide rather than
//! to our container parsing: the tiles are valid JPEG XL codestreams
//! (they start ff 0a), jxl-oxide parses their headers happily, and then
//! 52 of 150 fail to render with an ANS verification error while the
//! other 98 succeed. `all` is the mode that produces that count, and the
//! count is the argument: an unsupported feature fails every tile, a
//! decoder bug fails some. Re-run it when jxl-oxide next updates.

use std::path::Path;

fn u16_at(b: &[u8], at: usize, le: bool) -> u32 {
    let v = [b[at], b[at + 1]];
    if le { u16::from_le_bytes(v) as u32 } else { u16::from_be_bytes(v) as u32 }
}
fn u32_at(b: &[u8], at: usize, le: bool) -> u32 {
    let v = [b[at], b[at + 1], b[at + 2], b[at + 3]];
    if le { u32::from_le_bytes(v) } else { u32::from_be_bytes(v) }
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let path = Path::new(&args[0]);
    let want: usize = args.get(1).and_then(|s| s.parse().ok()).unwrap_or(0);
    let b = std::fs::read(path).unwrap();
    let le = &b[..2] == b"II";

    // Walk to the first JXL raw IFD and grab its tile table.
    let size = |t: u32| match t {
        1 | 2 | 6 | 7 => 1,
        3 | 8 => 2,
        4 | 9 | 11 => 4,
        5 | 10 | 12 => 8,
        _ => 0,
    };
    let entries = |off: usize| -> Vec<(u16, u32, u32, usize)> {
        let n = u16_at(&b, off, le) as usize;
        (0..n)
            .filter_map(|i| {
                let p = off + 2 + i * 12;
                let (tag, typ, cnt) =
                    (u16_at(&b, p, le) as u16, u16_at(&b, p + 2, le), u32_at(&b, p + 4, le));
                let s = size(typ);
                if s == 0 {
                    return None;
                }
                let at = if s * cnt as usize <= 4 { p + 8 } else { u32_at(&b, p + 8, le) as usize };
                Some((tag, typ, cnt, at))
            })
            .collect()
    };
    let ifd0 = entries(u32_at(&b, 4, le) as usize);
    let mut candidates: Vec<usize> = Vec::new();
    if let Some((_, _, cnt, at)) = ifd0.iter().find(|(t, ..)| *t == 330) {
        for k in 0..*cnt as usize {
            candidates.push(u32_at(&b, at + k * 4, le) as usize);
        }
    }
    for off in candidates {
        let en = entries(off);
        let comp = en.iter().find(|(t, ..)| *t == 259).map(|(_, typ, _, at)| {
            if *typ == 3 { u16_at(&b, *at, le) } else { u32_at(&b, *at, le) }
        });
        if comp != Some(52546) {
            continue;
        }
        let sub = en
            .iter()
            .find(|(t, ..)| *t == 254)
            .map(|(_, _, _, at)| u32_at(&b, *at, le))
            .unwrap_or(0);
        if sub & 1 != 0 {
            continue;
        }
        let Some((_, _, cnt, at)) = en.iter().find(|(t, ..)| *t == 324) else { continue };
        let Some((_, _, _, at2)) = en.iter().find(|(t, ..)| *t == 325) else { continue };
        let n = *cnt as usize;
        println!("raw IFD @{off}, {n} tiles");
        for (label, tag) in [("BitsPerSample", 258u16), ("SampleFormat", 339)] {
            if let Some((_, typ, c, a)) = en.iter().find(|(t, ..)| *t == tag) {
                let v = if *typ == 3 { u16_at(&b, *a, le) } else { u32_at(&b, *a, le) };
                println!("  {label} = {v} (count {c})");
            }
        }
        // "all" scans every tile and counts what renders, which is how
        // you tell an unsupported feature (nothing works) from a decoder
        // bug (most things work).
        if std::env::args().any(|a| a == "all") {
            let (mut ok, mut bad) = (0usize, 0usize);
            let mut first_error = String::new();
            for k in 0..n {
                let o = u32_at(&b, at + k * 4, le) as usize;
                let l = u32_at(&b, at2 + k * 4, le) as usize;
                match jxl_oxide::JxlImage::builder()
                    .read(&b[o..o + l])
                    .and_then(|i| i.render_frame(0))
                {
                    Ok(_) => ok += 1,
                    Err(e) => {
                        bad += 1;
                        if first_error.is_empty() {
                            first_error = format!("{e}");
                        }
                    }
                }
            }
            println!("  tiles: {ok} rendered, {bad} failed, of {n}");
            if bad > 0 {
                println!("  first failure: {first_error}");
            }
            return;
        }
        let off_t = u32_at(&b, at + want * 4, le) as usize;
        let len_t = u32_at(&b, at2 + want * 4, le) as usize;
        let src = &b[off_t..off_t + len_t];
        println!("  tile {want}: offset {off_t}, {len_t} bytes, head {:02x?}", &src[..8]);

        match jxl_oxide::JxlImage::builder().read(src) {
            Err(e) => println!("  builder().read FAILED: {e}"),
            Ok(img) => {
                println!("  parsed: {} x {}", img.width(), img.height());
                let h = img.image_header();
                println!("  bit depth: {:?}", h.metadata.bit_depth);
                println!("  xyb encoded: {}", h.metadata.xyb_encoded);
                println!("  color encoding: {:?}", h.metadata.colour_encoding);
                if let Some(fh) = img.frame_header(0) {
                    println!("  frame encoding: {:?}", fh.encoding);
                    println!("  frame bit depth: {:?}", fh.bit_depth);
                    println!("  frame flags: {:?}", fh.flags);
                    println!("  do_ycbcr: {}", fh.do_ycbcr);
                }
                match img.render_frame(0) {
                    Ok(r) => {
                        let fb = r.image_all_channels();
                        println!("  RENDER OK: {} x {} x {}", fb.width(), fb.height(), fb.channels());
                    }
                    Err(e) => println!("  RENDER FAILED: {e}"),
                }
            }
        }
        return;
    }
    println!("no JPEG XL raw IFD found");
}
