//! Small DNGs made in code, for the tests that hold the develop to
//! LibRaw's without a camera file: a Bayer mosaic in lossless JPEG tiles
//! or uncompressed strips, with the levels, white balance, matrices and
//! orientation a test asks for.

/// A lossless JPEG of `lines` (each `width * comps` samples), coded
/// with predictor `psv` and one Huffman table (categories 0 and 1 in two
/// bits, the rest in five), a restart marker every `restart` MCUs.
pub fn lossless_jpeg(lines: &[Vec<u16>], width: usize, comps: usize, precision: u8, psv: u8, restart: usize) -> Vec<u8> {
    let mut out = vec![0xff, 0xd8];
    let seg = |out: &mut Vec<u8>, tag: u8, body: &[u8]| {
        out.extend_from_slice(&[0xff, tag]);
        out.extend_from_slice(&((body.len() + 2) as u16).to_be_bytes());
        out.extend_from_slice(body);
    };
    let mut sof = vec![precision];
    sof.extend_from_slice(&(lines.len() as u16).to_be_bytes());
    sof.extend_from_slice(&(width as u16).to_be_bytes());
    sof.push(comps as u8);
    for c in 0..comps {
        sof.extend_from_slice(&[c as u8 + 1, 0x11, 0]);
    }
    seg(&mut out, 0xc3, &sof);
    // Categories 0..=16: a canonical code of lengths 2 (0, 1), then 5.
    let mut counts = [0u8; 16];
    counts[1] = 2;
    counts[4] = 15;
    let mut dht = vec![0u8];
    dht.extend_from_slice(&counts);
    dht.extend(0..17u8);
    seg(&mut out, 0xc4, &dht);
    if restart > 0 {
        seg(&mut out, 0xdd, &(restart as u16).to_be_bytes());
    }
    let mut sos = vec![comps as u8];
    for c in 0..comps {
        sos.extend_from_slice(&[c as u8 + 1, 0]);
    }
    sos.extend_from_slice(&[psv, 0, 0]);
    seg(&mut out, 0xda, &sos);
    // Codes: category 0 is 00, 1 is 01, 2.. are 5 bits from 10000.
    let code = |cat: u32| -> (u32, u32) { if cat < 2 { (cat, 2) } else { (0b10000 + cat - 2, 5) } };
    struct W {
        acc: u64,
        nbits: u32,
        data: Vec<u8>,
    }
    impl W {
        fn byte(&mut self, b: u8) {
            self.data.push(b);
            if b == 0xff {
                self.data.push(0);
            }
        }
        fn put(&mut self, v: u32, n: u32) {
            self.acc = (self.acc << n) | (v as u64 & ((1u64 << n) - 1));
            self.nbits += n;
            while self.nbits >= 8 {
                let b = (self.acc >> (self.nbits - 8)) as u8;
                self.byte(b);
                self.nbits -= 8;
            }
        }
        /// Pads the last byte with ones (F.1.2.3).
        fn flush(&mut self) {
            if self.nbits > 0 {
                let pad = 8 - self.nbits;
                self.put((1 << pad) - 1, pad);
            }
        }
    }
    let mut w = W { acc: 0, nbits: 0, data: Vec::new() };
    let n = comps;
    let initial = 1i32 << (precision - 1);
    let restart_lines = if restart == 0 { usize::MAX } else { restart / width };
    let mut marker = 0u8;
    for (y, l) in lines.iter().enumerate() {
        let since = if restart == 0 { y } else { y % restart_lines };
        if restart > 0 && y > 0 && since == 0 {
            // Close the interval: pad, marker.
            w.flush();
            w.data.extend_from_slice(&[0xff, 0xd0 + marker]);
            marker = (marker + 1) & 7;
        }
        for i in 0..width * n {
            let v = l[i] as i32;
            let p = if i < n {
                if since == 0 { initial } else { lines[y - 1][i] as i32 }
            } else if since == 0 || psv == 1 {
                l[i - n] as i32
            } else {
                let (a, b, c) = (l[i - n] as i32, lines[y - 1][i] as i32, lines[y - 1][i - n] as i32);
                match psv {
                    2 => b,
                    3 => c,
                    4 => a + b - c,
                    5 => a + ((b - c) >> 1),
                    6 => b + ((a - c) >> 1),
                    _ => (a + b) >> 1,
                }
            };
            let mut d = (v - p).rem_euclid(65536);
            if d >= 32768 {
                d -= 65536;
            }
            if d == -32768 {
                let (c, l) = code(16);
                w.put(c, l);
                continue;
            }
            let cat = 32 - d.unsigned_abs().leading_zeros();
            let (c, len) = code(cat);
            w.put(c, len);
            if cat > 0 {
                let bits = if d < 0 { (d - 1) as u32 } else { d as u32 };
                w.put(bits, cat);
            }
        }
    }
    w.flush();
    out.extend_from_slice(&w.data);
    out.extend_from_slice(&[0xff, 0xd9]);
    out
}

/// What a synthetic DNG holds.
pub struct Spec<'a> {
    pub width: usize,
    pub height: usize,
    /// Tiles of this size in lossless JPEG (two samples a JPEG pixel),
    /// or None for uncompressed strips of 16-bit samples.
    pub tile: Option<(usize, usize)>,
    /// Uncompressed strips in this many bits a sample, packed (10, 12,
    /// 14) or whole (8, 16). Ignored for tiles.
    pub bits: u16,
    /// Colors of the raw image's first two rows and columns.
    pub cfa: [u8; 4],
    pub orientation: u16,
    /// ActiveArea: top, left, bottom, right.
    pub active: Option<[u32; 4]>,
    /// BlackLevelRepeatDim and BlackLevel (rationals over 256).
    pub black: ((u16, u16), Vec<u32>),
    pub white: u32,
    pub linearization: Option<Vec<u16>>,
    pub neutral: [f64; 3],
    /// ColorMatrix1 (illuminant A) and ColorMatrix2 (D65).
    pub matrices: [[f64; 9]; 2],
    /// OpcodeList2 and OpcodeList3 bytes, if any.
    pub opcodes2: Option<Vec<u8>>,
    pub opcodes3: Option<Vec<u8>>,
    pub pixel: &'a dyn Fn(usize, usize) -> u16,
}

impl Default for Spec<'_> {
    fn default() -> Self {
        Spec {
            width: 64,
            height: 48,
            tile: Some((32, 16)),
            bits: 16,
            cfa: [0, 1, 1, 2],
            orientation: 1,
            active: None,
            black: ((1, 1), vec![256 * 256]),
            white: 16383,
            linearization: None,
            neutral: [0.48, 1.0, 0.62],
            matrices: [
                [1.0085, -0.5130, -0.1153, -0.3525, 1.0115, 0.3980, -0.0151, 0.0328, 0.7332],
                [0.8087, -0.2542, -0.1151, -0.3882, 1.2350, 0.1689, -0.0857, 0.1516, 0.6408],
            ],
            opcodes2: None,
            opcodes3: None,
            pixel: &|_, _| 0,
        }
    }
}

/// A pattern with gradients, texture and edges in every direction, and
/// a patch past white for the highlights, in 14 bits plus a black of
/// 256: for tests that want a photograph-like mosaic.
pub fn scene(y: usize, x: usize) -> u16 {
    let n = ((x as u32).wrapping_mul(2_654_435_761) ^ (y as u32).wrapping_mul(2_246_822_519)) >> 20;
    if (20..30).contains(&x) && (12..22).contains(&y) {
        return 16383;
    }
    let ring = (((x as f64 - 40.0).powi(2) + (y as f64 - 30.0).powi(2)).sqrt() * 0.9).sin();
    let base = 256.0 + 3000.0 + 2500.0 * ring + (x * 37 + y * 11) as f64 % 4000.0;
    let edge = if (x + y) % 23 < 3 { 2500.0 } else { 0.0 };
    (base + edge + (n % 400) as f64).min(16383.0) as u16
}

pub fn cfa_dng(s: &Spec) -> Vec<u8> {
    let (w, h) = (s.width, s.height);
    // The raw image's pieces.
    let mut pieces: Vec<Vec<u8>> = Vec::new();
    let (pw, ph) = match s.tile {
        Some((tw, th)) => {
            for tr in 0..h.div_ceil(th) {
                for tc in 0..w.div_ceil(tw) {
                    let lines: Vec<Vec<u16>> = (0..th)
                        .map(|r| (0..tw).map(|c| {
                            let (y, x) = (tr * th + r, tc * tw + c);
                            if y < h && x < w { (s.pixel)(y, x) } else { 0 }
                        }).collect())
                        .collect();
                    pieces.push(lossless_jpeg(&lines, tw / 2, 2, 16, 1, 0));
                }
            }
            (tw, th)
        }
        None => {
            let rows = 16;
            for r0 in (0..h).step_by(rows) {
                let mut out = Vec::new();
                for y in r0..(r0 + rows).min(h) {
                    let (mut acc, mut have) = (0u64, 0u32);
                    for x in 0..w {
                        let v = (s.pixel)(y, x) as u64;
                        match s.bits {
                            8 => out.push(v as u8),
                            16 => out.extend_from_slice(&(v as u16).to_le_bytes()),
                            b => {
                                acc = acc << b | (v & ((1 << b) - 1));
                                have += b as u32;
                                while have >= 8 {
                                    out.push((acc >> (have - 8)) as u8);
                                    have -= 8;
                                }
                            }
                        }
                    }
                    if have > 0 {
                        out.push((acc << (8 - have)) as u8);
                    }
                }
                pieces.push(out);
            }
            (w, rows)
        }
    };
    let short = |v: &[u16]| v.iter().flat_map(|x| x.to_le_bytes()).collect::<Vec<u8>>();
    let long = |v: &[u32]| v.iter().flat_map(|x| x.to_le_bytes()).collect::<Vec<u8>>();
    let srational = |v: &[f64]| v.iter().flat_map(|&a| [((a * 10000.0).round() as i32).to_le_bytes(), 10000i32.to_le_bytes()].concat()).collect::<Vec<u8>>();
    let rational = |v: &[f64]| v.iter().flat_map(|&a| [((a * 1_000_000.0).round() as u32).to_le_bytes(), 1_000_000u32.to_le_bytes()].concat()).collect::<Vec<u8>>();
    let tiled = s.tile.is_some();
    let bits = if tiled { 16 } else { s.bits };
    let mut e: Vec<(u16, u16, u32, Vec<u8>)> = vec![
        (254, 4, 1, long(&[0])),
        (256, 4, 1, long(&[w as u32])),
        (257, 4, 1, long(&[h as u32])),
        (258, 3, 1, short(&[bits])),
        (259, 3, 1, short(&[if tiled { 7 } else { 1 }])),
        (262, 3, 1, short(&[32803])),
        (271, 2, 7, b"Heeler\0".to_vec()),
        (272, 2, 5, b"Test\0".to_vec()),
        (274, 3, 1, short(&[s.orientation])),
        (277, 3, 1, short(&[1])),
        (284, 3, 1, short(&[1])),
        (33421, 3, 2, short(&[2, 2])),
        (33422, 1, 4, s.cfa.to_vec()),
        (50706, 1, 4, vec![1, 4, 0, 0]),
        (50708, 2, 12, b"Heeler Test\0".to_vec()),
        (50710, 1, 3, vec![0, 1, 2]),
        (50711, 3, 1, short(&[1])),
        (50713, 3, 2, short(&[s.black.0 .0, s.black.0 .1])),
        (50714, 5, s.black.1.len() as u32, s.black.1.iter().flat_map(|&b| [b.to_le_bytes(), 256u32.to_le_bytes()].concat()).collect()),
        (50717, 4, 1, long(&[s.white])),
        (50721, 10, 9, srational(&s.matrices[0])),
        (50722, 10, 9, srational(&s.matrices[1])),
        (50728, 5, 3, rational(&s.neutral)),
        (50778, 3, 1, short(&[17])),
        (50779, 3, 1, short(&[21])),
    ];
    if let Some(t) = &s.linearization {
        e.push((50712, 3, t.len() as u32, short(t)));
    }
    if let Some(a) = s.active {
        e.push((50829, 4, 4, long(&a)));
    }
    if let Some(o) = &s.opcodes2 {
        e.push((51009, 7, o.len() as u32, o.clone()));
    }
    if let Some(o) = &s.opcodes3 {
        e.push((51022, 7, o.len() as u32, o.clone()));
    }
    let n = pieces.len() as u32;
    if tiled {
        e.push((322, 4, 1, long(&[pw as u32])));
        e.push((323, 4, 1, long(&[ph as u32])));
        e.push((324, 4, n, vec![0; 4 * n as usize]));
        e.push((325, 4, n, long(&pieces.iter().map(|p| p.len() as u32).collect::<Vec<_>>())));
    } else {
        e.push((273, 4, n, vec![0; 4 * n as usize]));
        e.push((278, 4, 1, long(&[ph as u32])));
        e.push((279, 4, n, long(&pieces.iter().map(|p| p.len() as u32).collect::<Vec<_>>())));
    }
    e.sort_by_key(|x| x.0);
    // Header, directory, out-of-line values, then the pieces.
    let dir = 8usize;
    let values_at = dir + 2 + 12 * e.len() + 4;
    let values_len: usize = e.iter().map(|x| if x.3.len() > 4 { x.3.len() + (x.3.len() & 1) } else { 0 }).sum();
    let mut piece_at = values_at + values_len;
    let offsets: Vec<u32> = pieces.iter().map(|p| {
        let at = piece_at as u32;
        piece_at += p.len();
        at
    }).collect();
    let mut out = b"II*\0".to_vec();
    out.extend_from_slice(&(dir as u32).to_le_bytes());
    out.extend_from_slice(&(e.len() as u16).to_le_bytes());
    let mut values = Vec::new();
    for (tag, typ, count, mut v) in e {
        if tag == 324 || tag == 273 {
            v = long(&offsets);
        }
        out.extend_from_slice(&tag.to_le_bytes());
        out.extend_from_slice(&typ.to_le_bytes());
        out.extend_from_slice(&count.to_le_bytes());
        if v.len() <= 4 {
            v.resize(4, 0);
            out.extend_from_slice(&v);
        } else {
            out.extend_from_slice(&((values_at + values.len()) as u32).to_le_bytes());
            let pad = v.len() & 1;
            values.extend_from_slice(&v);
            values.extend(std::iter::repeat_n(0, pad));
        }
    }
    out.extend_from_slice(&0u32.to_le_bytes());
    out.extend_from_slice(&values);
    for p in &pieces {
        out.extend_from_slice(p);
    }
    out
}

/// One DNG opcode's bytes: its ID, version 1.3, flags 0, and parameters.
fn opcode(id: u32, params: &[u8]) -> Vec<u8> {
    let mut op = Vec::new();
    for v in [id, 0x0103_0000, 0, params.len() as u32] {
        op.extend_from_slice(&v.to_be_bytes());
    }
    op.extend_from_slice(params);
    op
}

/// A GainMap opcode: an area (top, left, bottom, right), a first plane
/// and plane count, row and column pitches, and a grid of `points` (rows,
/// columns) by `map_planes` gains spread evenly over the whole image.
pub fn gain_map(area: [u32; 4], planes: [u32; 2], pitch: [u32; 2], points: [u32; 2], map_planes: u32, gains: &[f32]) -> Vec<u8> {
    let mut p = Vec::new();
    for v in [area[0], area[1], area[2], area[3], planes[0], planes[1], pitch[0], pitch[1], points[0], points[1]] {
        p.extend_from_slice(&v.to_be_bytes());
    }
    let spacing = |n: u32| if n > 1 { 1.0 / (n - 1) as f64 } else { 1.0 };
    for v in [spacing(points[0]), spacing(points[1]), 0.0, 0.0] {
        p.extend_from_slice(&v.to_be_bytes());
    }
    p.extend_from_slice(&map_planes.to_be_bytes());
    for g in gains {
        p.extend_from_slice(&g.to_be_bytes());
    }
    opcode(9, &p)
}

/// A FixVignetteRadial opcode: k0 to k4 and the center (fractions).
pub fn vignette(k: [f64; 5], cx: f64, cy: f64) -> Vec<u8> {
    let p: Vec<u8> = k.iter().chain(&[cx, cy]).flat_map(|v| v.to_be_bytes()).collect();
    opcode(3, &p)
}

/// An opcode list of `ops`.
pub fn opcode_list(ops: &[Vec<u8>]) -> Vec<u8> {
    let mut l = (ops.len() as u32).to_be_bytes().to_vec();
    for op in ops {
        l.extend_from_slice(op);
    }
    l
}
