//! More of Canon's C-RAW coding (crx.rs): the second version's map of
//! quantizers as LibRaw reads it, every subband's step from that map and
//! its record, and the frames whose image header states encoding 3 (the
//! raw burst frames), whose four planes are not the 2 by 2 pattern's
//! sites but a luma, two color differences and the difference of the two
//! greens. Each rule was found from the files' data against LibRaw's
//! frame (the steps and the color transform from LibRaw's frame taken
//! apart again, the map's opening by changing its first bits in copies of
//! a file and reading the steps LibRaw then used).
//!
//! The map (`decode_quant_map`): 24 bits holding 1, then the base
//! quantizer plus 2 in 7 bits, then a bit that is 0. The entries follow
//! line by line with the lossless coding's tools: no runs, K starting at
//! 2 and carried from line to line; the first line's first entry is 0 and
//! not coded, the rest of that line predicted by the entry to the left,
//! the lines below by median edge detection; no entry is held to a range
//! (LibRaw takes the negative ones as they are).
//!
//! A subband's step (`step`, `map_steps`): q is the base plus the map's
//! entry for the coefficient, S the scaling of crx::quant_step before its
//! division by 64, and the record's field f and offset o (its third and
//! fourth words) give ((S / 32) f / 8) + o, each division rounded down,
//! and 1 at least. A band whose field is 0 and offset 1 is thus not
//! quantized, and fields 4, 8 and 16 give the steps crx::map_steps gives.
//!
//! Encoding 3 (`rebuild_plane`, `ycc_sites`): each plane is one tile of
//! ten subbands as in the other encodings, but the plane whose record
//! (0xFF12) lacks bit 27 of its second word codes its lowest band as a
//! high band is coded (crx::decode_band) and scales it by its step, and
//! no plane is held to the sample range until the four are combined.

use crate::crx::{self, Band, QuantMap};
use crate::Error;

/// H.265's scaling (ITU-T H.265, 8.6.3), by q's remainder after 6.
const SCALE: [i64; 6] = [40, 45, 51, 57, 64, 72];

/// The largest q taken (as crx::quant_step).
const MAX_Q: i32 = 6 * 24;

/// A second-version C-RAW tile's map of quantizers for a level 1 of `rows`
/// rows (a line for each) and a level 3 `width` wide (an entry for each of
/// its columns), as the notes at the top state it. The map must end in its
/// stated size's last byte.
pub fn decode_quant_map(data: &[u8], width: usize, rows: usize) -> Result<QuantMap, Error> {
    if width == 0 || rows == 0 {
        return Err(Error::Unsupported("a C-RAW quantizer map of no size"));
    }
    let mut br = crx::Bits::new(data);
    if br.bits(24) != 1 {
        return Err(Error::Unsupported("a C-RAW quantizer map's header not read here"));
    }
    let base = br.bits(7) as i32 - 2;
    if br.bit() {
        return Err(Error::Unsupported("a C-RAW quantizer map's header not read here"));
    }
    let mut k = 2;
    let mut entries = Vec::with_capacity(width * rows);
    let mut prev = vec![0i32; width];
    let mut cur = Vec::with_capacity(width);
    for y in 0..rows {
        let first = y == 0;
        cur.clear();
        for x in 0..width {
            if first && x == 0 {
                cur.push(0);
                continue;
            }
            let b = prev[x];
            let (a, c) = if x > 0 { (cur[x - 1], prev[x - 1]) } else { (b, b) };
            let p = if first {
                a
            } else if c >= a.max(b) {
                a.min(b)
            } else if c <= a.min(b) {
                a.max(b)
            } else {
                a + b - c
            };
            let q = br.zeros()?;
            let s = if q >= crx::ESCAPE_ZEROS { br.bits(crx::ESCAPE_BITS) } else { (q << k) | br.bits(k) };
            cur.push(p + crx::error(s));
            let n = if first || x + 1 >= width { s } else { (s + 2 * (prev[x + 1] - prev[x]).unsigned_abs()) >> 1 };
            k = crx::next_k(k, n);
            if k > 31 {
                return Err(Error::Corrupt("a C-RAW quantizer map's Rice parameter out of range"));
            }
        }
        entries.extend_from_slice(&cur);
        std::mem::swap(&mut prev, &mut cur);
    }
    let bits = br.at * 8 - br.have as usize;
    if bits > data.len() * 8 || bits + 8 <= data.len() * 8 {
        return Err(Error::Unsupported("a C-RAW quantizer map not ending where its size states"));
    }
    Ok(QuantMap { base, width, lines: rows, entries, bits })
}

/// A subband's quantizer as its record (0xFF13) states it: the field (the
/// third word's low 19 bits) and the offset (the fourth word, signed).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct BandQuant {
    pub field: u32,
    pub offset: i32,
}

/// The step of a coefficient whose quantizer is `q` (base plus entry) in a
/// band quantized as `quant` says (the notes at the top).
pub fn step(q: i32, quant: BandQuant) -> i32 {
    let q = q.clamp(0, MAX_Q) as usize;
    let scaled = SCALE[q % 6] << (q / 6);
    ((((scaled >> 5) * quant.field as i64) >> 3) + quant.offset as i64).max(1) as i32
}

/// Each coefficient's step (crx::reconstruct_plane_with's, and
/// `rebuild_plane`'s) from a tile's map and its ten bands' quantizers, in
/// the file's order (LL3, HL3, LH3, HH3, ..., HH1). The entry of a level-1
/// coefficient is its row's line's at its column over 4; of a level-2 one
/// the mean of its two level-1 rows' entries at its column over 2, of a
/// level-3 one (the lowest band's too) the mean of its four level-1 rows'
/// at its column, each mean rounded down; rows past the map take its last
/// line, columns past it its last column.
pub fn map_steps(map: &QuantMap, quants: [BandQuant; 10]) -> impl Fn(usize, usize, usize, usize) -> i32 + Sync + '_ {
    let (w, last) = (map.width, map.lines.saturating_sub(1));
    let entry = move |r: usize, c: usize| map.entries[r.min(last) * w + c.min(w - 1)];
    move |_t, i, r, c| {
        let quant = quants[i];
        if quant.field == 0 {
            return quant.offset.max(1);
        }
        let entry = match i {
            7..=9 => entry(r, c / 4),
            4..=6 => (entry(2 * r, c / 2) + entry(2 * r + 1, c / 2)) >> 1,
            _ => (entry(4 * r, c) + entry(4 * r + 1, c) + entry(4 * r + 2, c) + entry(4 * r + 3, c)) >> 2,
        };
        step(map.base + entry, quant)
    }
}

/// Whether a plane's record (0xFF12, its second word) codes the plane's
/// lowest band as a lossless plane is (bit 27 set, every plane of the
/// encodings crx.rs reads) or as a high band (encoding 3's green
/// difference).
pub fn low_band_lossless(plane_word: u32) -> bool {
    plane_word & 0x0800_0000 != 0
}

/// One plane of a one-tile C-RAW frame, `width` by `height`, from its ten
/// bands in the file's order, each scaled by `step` (the tile, the band's
/// index, the coefficient's row and column) and rebuilt level by level as
/// crx::reconstruct_plane_with rebuilds a tile, but not held to the sample
/// range: the lowest band is decoded as a lossless plane of `bits` bits
/// where `low_lossless`, else as a high band.
pub fn rebuild_plane(bands: &[Band; 10], width: usize, height: usize, bits: u32, low_lossless: bool, step: &(dyn Fn(usize, usize, usize, usize) -> i32 + Sync)) -> Result<Vec<i32>, Error> {
    if width < 2 || height < 2 {
        return Err(Error::Unsupported("a C-RAW plane this small"));
    }
    // Each level's columns and rows, low then high.
    let mut cols = [(0usize, 0usize); crx::LEVELS + 1];
    let mut rows = [(0usize, 0usize); crx::LEVELS + 1];
    let (mut w, mut h) = (width, height);
    for l in 1..=crx::LEVELS {
        cols[l] = (w.div_ceil(2), w / 2);
        rows[l] = (h.div_ceil(2), h / 2);
        (w, h) = (cols[l].0, rows[l].0);
    }
    let decode = |i: usize, w: usize, h: usize| -> Result<Vec<i32>, Error> {
        if i == 0 && low_lossless {
            return crx::decode_low_band(bands[0].data, w, h, bits);
        }
        let mut v = crx::decode_band(bands[i].data, w, h)?;
        for (r, line) in v.chunks_exact_mut(w).enumerate() {
            for (c, coefficient) in line.iter_mut().enumerate() {
                *coefficient *= step(0, i, r, c);
            }
        }
        Ok(v)
    };
    let mut low = decode(0, cols[crx::LEVELS].0, rows[crx::LEVELS].0)?;
    for level in (1..=crx::LEVELS).rev() {
        let ((cl, ch), (rl, rh)) = (cols[level], rows[level]);
        let i = 1 + 3 * (crx::LEVELS - level);
        let hl = decode(i, ch, rl)?;
        let lh = decode(i + 1, cl, rh)?;
        let hh = decode(i + 2, ch, rh)?;
        // Rows: low coefficients at even places, high at odd ones; the low
        // half down the columns (LL and HL), then the high half (LH, HH).
        let (w, h) = (cl + ch, rl + rh);
        let mut lines = vec![0i32; w * h];
        for (r, line) in lines.chunks_exact_mut(w).enumerate() {
            let (lo, hi) = if r % 2 == 0 { (&low[r / 2 * cl..][..cl], &hl[r / 2 * ch..][..ch]) } else { (&lh[r / 2 * cl..][..cl], &hh[r / 2 * ch..][..ch]) };
            for (c, v) in line.iter_mut().enumerate() {
                *v = if c % 2 == 0 { lo[c / 2] } else { hi[c / 2] };
            }
        }
        let row_low: Vec<bool> = (0..w).map(|c| c % 2 == 0).collect();
        crx::inverse_lines(&mut lines, w, &row_low);
        // Columns: low rows at even places, high rows at odd ones.
        let mut columns = vec![0i32; w * h];
        for (r, line) in lines.chunks_exact(w).enumerate() {
            for (c, &v) in line.iter().enumerate() {
                columns[c * h + r] = v;
            }
        }
        let col_low: Vec<bool> = (0..h).map(|r| r % 2 == 0).collect();
        crx::inverse_lines(&mut columns, h, &col_low);
        low = vec![0i32; w * h];
        for (c, column) in columns.chunks_exact(h).enumerate() {
            for (r, &v) in column.iter().enumerate() {
                low[r * w + c] = v;
            }
        }
    }
    Ok(low)
}

/// Encoding 3's four planes (in the file's order: luma Y, the blue
/// difference Cb, the green difference D, the red difference Cr, the two
/// differences about half the range) as the 2 by 2 pattern's sites, row by
/// row: the site at the pattern's top left, top right, bottom left, bottom
/// right. As found against LibRaw's frame (every sample of the corpus's
/// burst frames), with Cb and Cr taken less half the range, it is the
/// inverse of ITU-R BT.2020's luma and color differences in steps of
/// 1/1024, each product sum rounded by adding 512 and shifting down by 10:
/// the top left Y + ((1510 Cr + 512) >> 10), the bottom right
/// Y + ((1927 Cb + 512) >> 10), and with
/// G = Y + ((-168 Cb - 585 Cr + 512) >> 10) the top right
/// G + ((D + 1) >> 1), the bottom left that less D. Each is held to 0 and
/// 2^bits - 1.
pub fn ycc_sites(planes: [&[i32]; 4], bits: u32) -> [Vec<u16>; 4] {
    let (half, max) = (1i64 << (bits - 1), (1i64 << bits) - 1);
    let n = planes.iter().map(|p| p.len()).min().unwrap_or(0);
    let mut out: [Vec<u16>; 4] = std::array::from_fn(|_| Vec::with_capacity(n));
    let samples = planes[0].iter().zip(planes[1]).zip(planes[2]).zip(planes[3]);
    for (((&y, &cb), &d), &cr) in samples {
        let (y, cb, d, cr) = (y as i64, cb as i64 - half, d as i64, cr as i64 - half);
        let g = y + ((-168 * cb - 585 * cr + 512) >> 10);
        let g1 = g + ((d + 1) >> 1);
        let sites = [y + ((1510 * cr + 512) >> 10), g1, g1 - d, y + ((1927 * cb + 512) >> 10)];
        for (o, v) in out.iter_mut().zip(sites) {
            o.push(v.clamp(0, max) as u16);
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn steps_are_the_files_steps() {
        // Fields 4, 8 and 16 with offset 0 are crx::map_steps's steps; a
        // field of 0 with offset 1 is not quantized.
        for q in 0..=MAX_Q {
            let s = SCALE[q as usize % 6] << (q / 6);
            assert_eq!(step(q, BandQuant { field: 4, offset: 0 }) as i64, (s >> 6).max(1));
            assert_eq!(step(q, BandQuant { field: 8, offset: 0 }) as i64, (s >> 5).max(1));
            assert_eq!(step(q, BandQuant { field: 16, offset: 0 }) as i64, ((s >> 5) * 2).max(1));
            assert_eq!(step(q, BandQuant { field: 0, offset: 1 }), 1);
        }
        // Encoding 3's, measured in a burst frame (base 12): the green
        // difference's fields 12, 13, 25 and 44 at entries 0 to 7.
        let measured = [(12, [7, 7, 9, 10, 12, 13, 15, 16]), (13, [8, 8, 9, 11, 13, 14, 16, 17]), (25, [15, 15, 18, 21, 25, 28, 31, 34])];
        for (field, want) in measured {
            assert_eq!(std::array::from_fn::<i32, 8, _>(|e| step(12 + e as i32, BandQuant { field, offset: 0 })), want, "field {field}");
        }
        assert_eq!([12, 16, 17, 18, 19].map(|q| step(q, BandQuant { field: 44, offset: 0 })), [27, 44, 49, 55, 60]);
        // The color differences' level 2, offset -5: never below 1.
        assert_eq!([12, 15, 16, 17, 18, 19].map(|q| step(q, BandQuant { field: 8, offset: -5 })), [1, 2, 3, 4, 5, 6]);
        assert_eq!([12, 19].map(|q| step(q, BandQuant { field: 4, offset: -5 })), [1, 1]);
    }

    /// A map coded as `decode_quant_map`'s notes state it.
    fn encode_quant_map(base: i32, map: &[Vec<i32>]) -> Vec<u8> {
        let symbol = |e: i32| if e >= 0 { (e as u32) << 1 } else { ((-e) as u32) * 2 - 1 };
        let width = map[0].len();
        let mut out: Vec<bool> = Vec::new();
        let put = |out: &mut Vec<bool>, v: u32, n: u32| (0..n).rev().for_each(|i| out.push(v >> i & 1 == 1));
        put(&mut out, 1, 24);
        put(&mut out, (base + 2) as u32, 7);
        put(&mut out, 0, 1);
        let mut k = 2;
        let mut prev = vec![0i32; width];
        for (y, row) in map.iter().enumerate() {
            let first = y == 0;
            for x in 0..width {
                if first && x == 0 {
                    continue;
                }
                let b = prev[x];
                let (a, c) = if x > 0 { (row[x - 1], prev[x - 1]) } else { (b, b) };
                let p = if first {
                    a
                } else if c >= a.max(b) {
                    a.min(b)
                } else if c <= a.min(b) {
                    a.max(b)
                } else {
                    a + b - c
                };
                let s = symbol(row[x] - p);
                if s >> k >= crx::ESCAPE_ZEROS {
                    out.extend((0..crx::ESCAPE_ZEROS).map(|_| false));
                    out.push(true);
                    put(&mut out, s, crx::ESCAPE_BITS);
                } else {
                    out.extend((0..s >> k).map(|_| false));
                    out.push(true);
                    put(&mut out, s & ((1 << k) - 1), k);
                }
                let n = if first || x + 1 >= width { s } else { (s + 2 * (prev[x + 1] - prev[x]).unsigned_abs()) >> 1 };
                k = crx::next_k(k, n);
            }
            prev = row.clone();
        }
        out.chunks(8).map(|c| c.iter().enumerate().fold(0u8, |v, (i, &b)| v | (b as u8) << (7 - i))).collect()
    }

    #[test]
    fn quantizer_maps_decode_as_they_were_coded() {
        let mut seed = 4242u32;
        let mut noise = move || {
            seed = seed.wrapping_mul(1_103_515_245).wrapping_add(12345);
            seed >> 16
        };
        // The first line's first entry is 0; the others may be anything,
        // negative ones too.
        let map: Vec<Vec<i32>> = (0..40).map(|y| (0..37).map(|x| if (x, y) == (0, 0) || y == 3 { 0 } else { [0, 4, 7, 4, -1, 30][noise() as usize % 6] }).collect()).collect();
        for base in [12, 20, 42] {
            let got = decode_quant_map(&encode_quant_map(base, &map), 37, 40).unwrap();
            assert_eq!((got.base, got.width, got.lines), (base, 37, 40));
            assert!(got.entries == map.concat(), "base {base}");
        }
        // A header whose bit after the base is set is not read, nor a map
        // that does not end where its size states.
        let mut flagged = encode_quant_map(20, &map);
        flagged[3] |= 1;
        assert!(decode_quant_map(&flagged, 37, 40).is_err());
        let mut long = encode_quant_map(20, &map);
        long.extend([0xff; 2]);
        assert!(decode_quant_map(&long, 37, 40).is_err());
    }

    #[test]
    fn level_entries_are_means_of_level_1_lines() {
        // Two map columns, four lines: entries 0, 4, 7, 1 down column 0.
        let map = QuantMap { base: 12, width: 2, lines: 4, entries: vec![0, 0, 4, 0, 7, 0, 1, 0], bits: 0 };
        let q = BandQuant { field: 8, offset: 0 };
        let steps = map_steps(&map, [q; 10]);
        let s = |e: i32| step(12 + e, q);
        assert_eq!([0, 1, 2, 3, 9].map(|r| steps(0, 7, r, 0)), [s(0), s(4), s(7), s(1), s(1)]);
        assert_eq!([0, 1].map(|r| steps(0, 4, r, 1)), [s(2), s(4)]);
        assert_eq!(steps(0, 0, 0, 0), s(3));
        let unquantized = map_steps(&map, [BandQuant { field: 0, offset: 1 }; 10]);
        assert_eq!(unquantized(0, 9, 1, 0), 1);
    }

    #[test]
    fn ycc_sites_invert_the_transform() {
        // A neutral gray at the black level and a colored sample, as a
        // burst frame's planes and LibRaw's sites hold them.
        let planes: [&[i32]; 4] = [&[2048, 3622], &[8192, 7966], &[0, -3], &[8192, 7765]];
        let sites = ycc_sites(planes, 14);
        assert_eq!(sites.each_ref().map(|s| s[0]), [2048; 4]);
        let (y, cb, d, cr) = (3622i64, 7966 - 8192i64, -3i64, 7765 - 8192i64);
        let g = y + ((-168 * cb - 585 * cr + 512) >> 10);
        let g1 = g + ((d + 1) >> 1);
        assert_eq!(sites.each_ref().map(|s| s[1] as i64), [y + ((1510 * cr + 512) >> 10), g1, g1 - d, y + ((1927 * cb + 512) >> 10)]);
        // Held to the range: a red past the white, a red below 0.
        let held = ycc_sites([&[16000, 100], &[8192, 8192], &[0, 0], &[12000, 0]], 14);
        assert_eq!((held[0][0], held[0][1], held[3][0]), (16383, 0, 16000));
    }
}
