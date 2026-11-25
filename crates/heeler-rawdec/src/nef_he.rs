//! Nikon's High Efficiency coding (High Efficiency and High Efficiency
//! star), the raw strip of the Z 8, Z 9, Z f, Z6 III, Z5 II, Z50 II and
//! ZR among others: a codestream in the manner of JPEG XS (ISO/IEC 21122)
//! that holds the mosaic as four planes of half its width and height, one
//! for each site of the 2 by 2 pattern.
//!
//! The stream: SOC (FF10), then the main header's segments, each a marker,
//! a 16-bit length that counts itself, and a body: CAP (FF50); PIH (FF12),
//! the picture's header; CDT (FF13), three bytes a component, the last its
//! horizontal and vertical wavelet levels in a nibble each; WGT (FF14), a
//! gain and a priority for each band. Then slices, each a header (FF20, a
//! length of 4, the slice's index) and its precincts, and EOC (FF11).
//!
//! The planes: component 0 is a luma on the sites of the green beside red,
//! 1 a red difference on red's, 2 the two greens' difference on the other
//! green's, 3 a blue difference on blue's. 0, 1 and 3 have five horizontal
//! wavelet levels and one vertical (the reversible 5/3 lifting), 2 none.
//!
//! A precinct is two rows of each plane, so four of the sensor: 12 bytes
//! (its body's length in 24 bits, a quantizer Q, a refinement R, then two
//! bits for each band, most significant first: bit 0 whether the band has
//! significance flags, bit 1 whether its counts are predicted from the row
//! above), then eight packets: the first row's of components 0 to 3, then
//! the second's. A decomposed component's first row is the vertical low
//! band, cut into the coarsest horizontal low band and each level's high
//! band from the coarsest out; its second is the vertical high band, cut
//! once. Component 2's rows are two rows of the plane as they are. Bands
//! are numbered in that order, component 2's one band serving both rows,
//! and a band's truncation is T = Q - gain - (1 where priority < R), held
//! to 0 to 15.
//!
//! A packet: 7 bytes (a bit that marks raw coding, not read here; the
//! lengths in bytes of its data in 20 bits, of its counts in 20, of its
//! signs in 15), then four runs of bits, each most significant first and
//! padded to a byte. The coefficients go in groups of four, each band
//! padded to whole groups. First the significance flags of the bands that
//! have them: one for every eight groups, set where none of them has a
//! count coded. Then each coded group's count in unary (ones, then a
//! zero), u: the group's bit planes are M = T + u, or for a predicted band
//! a step from P, the larger of T and the same group's M in the row
//! above (0 at a slice's start): none for 0, then down 1, up 1, down 2, up
//! 2 for as long as down reaches T, and upward only past that. Then the
//! magnitudes, M - T planes for each group, a plane the group's four bits,
//! the highest plane first. Then a sign for every coefficient that is not
//! zero, set for negative.
//!
//! A magnitude m of n planes stands for m * floor(2^(17+n) / (2^(n+1) -
//! 1)) >> (16 - T), then shifted up by the header's fractional bits. The
//! horizontal levels are undone in each row, the vertical one over the
//! whole plane, across precincts and slices; only the counts' prediction
//! starts again at a slice, which is what lets the slices decode side by
//! side. The four planes turn into the four sites by lifting steps over
//! each site's four nearest of another kind, the frame's edges repeated
//! (`sites`), and a table takes each value to the sensor's 14 bits.
//!
//! The table (nef_he_curve.bin, 81792 16-bit little-endian numbers, for
//! values from -32768 up) was measured: each coded value paired with the
//! sample a raw converter's uncompressed DNG of the same file holds at
//! that site. Every entry was seen. The cameras' files reach 55589 of
//! them, over 1.24 billion sites; the rest lie below the black level or
//! between the sparse values of the brightest highlights. Three frames
//! made for the purpose reach all 81792: a ramp through every coded value,
//! written in place of a camera file's stream with nothing truncated and
//! the modes the cameras use, on files from three bodies, converted like
//! any other. The three agree with each other at every entry, and with
//! the cameras' files at every entry those reach. A value below the
//! table's first takes its first (0) and one past its last its last
//! (16383), as the converter's DNGs have them.
//!
//! Held to that converter's DNGs to the bit, every site, on 43 files from
//! the seven bodies above, in both modes and every image area, and on the
//! three made frames. A stream unlike those (other header fields,
//! raw-coded packets) is declined.

use std::sync::atomic::AtomicBool;

use rayon::prelude::*;

use crate::{stopped, Error};

const SOC: u16 = 0xff10;
const EOC: u16 = 0xff11;
const PIH: u16 = 0xff12;
const CDT: u16 = 0xff13;
const WGT: u16 = 0xff14;
const SLH: u16 = 0xff20;
const CAP: u16 = 0xff50;

/// The table from coded values to the sensor's, and the coded value its
/// first entry stands for, negated.
static CURVE: &[u8] = include_bytes!("nef_he_curve.bin");
const CURVE_LEN: usize = 81792;
const CURVE_BIAS: i32 = 32768;

/// The most bands a precinct's header has mode bits for.
const BANDS: usize = 28;

const DECLINED: Error = Error::Unsupported("a Nikon High Efficiency frame of a layout not read here");
const SHORT: Error = Error::Corrupt("a Nikon High Efficiency frame that ends early");

/// Whether a NEF's raw strip is a High Efficiency codestream: SOC, then
/// CAP.
pub fn is_stream(strip: &[u8]) -> bool {
    strip.starts_with(&[0xff, 0x10, 0xff, 0x50])
}

struct Header {
    width: usize,
    height: usize,
    /// Coefficients in a group, and groups under one significance flag.
    group: usize,
    flagged: usize,
    fractional: u32,
    /// Each component's horizontal and vertical levels.
    levels: [(usize, usize); 4],
    gains: Vec<u8>,
    priorities: Vec<u8>,
    /// Where the first slice's header starts.
    body: usize,
}

fn be16(d: &[u8], at: usize) -> Result<u16, Error> {
    d.get(at..at + 2).map(|b| u16::from_be_bytes([b[0], b[1]])).ok_or(SHORT)
}

fn header(cs: &[u8]) -> Result<Header, Error> {
    if be16(cs, 0)? != SOC {
        return Err(DECLINED);
    }
    let (mut at, mut pih, mut cap) = (2, None, false);
    let (mut levels, mut gains, mut priorities) = (Vec::new(), Vec::new(), Vec::new());
    loop {
        let marker = be16(cs, at)?;
        if marker == SLH {
            break;
        }
        let len = be16(cs, at + 2)? as usize;
        if len < 2 {
            return Err(Error::Corrupt("a Nikon High Efficiency header segment shorter than its length"));
        }
        let body = cs.get(at + 4..at + 2 + len).ok_or(SHORT)?;
        match marker {
            CAP => cap = true,
            PIH => pih = Some(body),
            CDT => {
                // Three bytes a component: its depth, its sampling (1 by
                // 1), its levels.
                if body.len() % 3 != 0 || body.chunks_exact(3).any(|c| c[1] != 0x11) {
                    return Err(DECLINED);
                }
                levels.extend(body.chunks_exact(3).map(|c| ((c[2] >> 4) as usize, (c[2] & 15) as usize)));
            }
            WGT => {
                gains.extend(body.chunks_exact(2).map(|p| p[0]));
                priorities.extend(body.chunks_exact(2).map(|p| p[1]));
            }
            _ => return Err(DECLINED),
        }
        at += 2 + len;
    }
    let pih = pih.filter(|p| p.len() >= 24).ok_or(DECLINED)?;
    let n = |k: usize| u16::from_be_bytes([pih[k], pih[k + 1]]) as usize;
    let (width, height) = (n(8), n(10));
    let levels: [(usize, usize); 4] = levels.try_into().map_err(|_| DECLINED)?;
    // The fields every file seen holds, and the only ones read here: four
    // components; precincts the frame's width; byte 21 (0x10) unexplained;
    // the uniform quantizer, the signs in a run of their own, significance
    // by zero residuals, no raw mode chosen by the packet; a frame of whole
    // precincts; at most one vertical level, and none without a vertical
    // one.
    let read = cap
        && pih[16] == 4
        && n(12) == 0
        && pih[21] == 0x10
        && pih[23] & 0x7f == 0x14
        && width >= 2
        && width % 2 == 0
        && height >= 4
        && height % 4 == 0
        && levels.iter().all(|&(x, y)| y == 1 || (x == 0 && y == 0))
        && pih[17] >= 1
        && pih[17] <= 16
        && pih[18] >= 1
        && !gains.is_empty();
    if !read {
        return Err(DECLINED);
    }
    if u32::from_be_bytes([pih[0], pih[1], pih[2], pih[3]]) as usize != cs.len() {
        return Err(Error::Corrupt("a Nikon High Efficiency frame of another length than it states"));
    }
    Ok(Header { width, height, group: pih[17] as usize, flagged: pih[18] as usize, fractional: (pih[20] >> 4) as u32, levels, gains, priorities, body: at })
}

/// A band within a packet: its coefficients, its groups, its place in the
/// weights and the precinct's modes, and the row of counts it predicts
/// from.
#[derive(Clone, Debug)]
struct Band {
    width: usize,
    groups: usize,
    weight: usize,
    history: usize,
}

/// A packet: one row of one component.
#[derive(Clone, Debug)]
struct Packet {
    component: usize,
    line: usize,
    bands: Vec<Band>,
}

struct Layout {
    packets: Vec<Packet>,
    /// The groups in each row of counts.
    histories: Vec<usize>,
}

/// A row's length after each horizontal level: n, half of it rounded up,
/// and so on.
fn level_lengths(n: usize, levels: usize) -> Vec<usize> {
    let mut v = vec![n];
    for _ in 0..levels {
        v.push(v[v.len() - 1].div_ceil(2));
    }
    v
}

/// The packets of a precinct in their order, and each one's bands (the
/// module's notes).
fn layout(h: &Header) -> Result<Layout, Error> {
    let wc = h.width / 2;
    let (mut packets, mut histories) = (Vec::new(), Vec::new());
    let mut flat: [Option<(usize, usize)>; 4] = [None; 4];
    for line in 0..2 {
        for (ci, &(lx, ly)) in h.levels.iter().enumerate() {
            let widths = if ly == 0 {
                vec![wc]
            } else if line == 0 {
                let n = level_lengths(wc, lx);
                std::iter::once(n[lx]).chain((1..=lx).rev().map(|k| n[k - 1] - n[k])).collect()
            } else {
                vec![wc.div_ceil(2), wc / 2]
            };
            let bands = widths
                .into_iter()
                .map(|width| {
                    let groups = width.div_ceil(h.group);
                    let (weight, history) = flat[ci].filter(|_| ly == 0).unwrap_or_else(|| {
                        histories.push(groups);
                        let ids = (histories.len() - 1, histories.len() - 1);
                        if ly == 0 {
                            flat[ci] = Some(ids);
                        }
                        ids
                    });
                    Band { width, groups, weight, history }
                })
                .collect();
            packets.push(Packet { component: ci, line, bands });
        }
    }
    if histories.len() != h.gains.len() || histories.len() > BANDS {
        return Err(DECLINED);
    }
    Ok(Layout { packets, histories })
}

/// One of a packet's runs of bits, most significant first.
struct Bits<'a> {
    data: &'a [u8],
    at: usize,
}

impl Bits<'_> {
    /// The next 32 bits without taking them, zeros past the end.
    #[inline]
    fn peek(&self) -> u32 {
        let i = self.at >> 3;
        let word = match self.data.get(i..i + 8) {
            Some(b) => u64::from_be_bytes(b.try_into().unwrap()),
            None => self.data[i.min(self.data.len())..].iter().enumerate().fold(0, |w, (k, &b)| w | (b as u64) << (56 - 8 * k)),
        };
        ((word << (self.at & 7)) >> 32) as u32
    }

    /// The next `n` bits, at most 16.
    #[inline]
    fn take(&mut self, n: usize) -> Result<u32, Error> {
        if self.at + n > self.data.len() * 8 {
            return Err(SHORT);
        }
        let v = self.peek() >> (32 - n);
        self.at += n;
        Ok(v)
    }

    /// The ones before the next zero, the zero taken too.
    #[inline]
    fn unary(&mut self) -> Result<i32, Error> {
        let mut u = 0;
        loop {
            let ones = self.peek().leading_ones() as usize;
            u += ones as i32;
            if ones < 32 {
                self.at += ones + 1;
                return if self.at > self.data.len() * 8 { Err(SHORT) } else { Ok(u) };
            }
            self.at += 32;
            if self.at >= self.data.len() * 8 {
                return Err(SHORT);
            }
        }
    }

    fn bytes_used(&self) -> usize {
        self.at.div_ceil(8)
    }
}

/// A magnitude of `planes` bit planes above the truncation `t`, as the
/// value it stands for.
#[inline]
fn dequantize(mag: u32, planes: u32, t: u32) -> i32 {
    let n = planes.min(15);
    let scale = (1u64 << (17 + n)) / ((1u64 << (n + 1)) - 1);
    ((mag as u64 * scale) >> (16 - t)) as i32
}

/// A packet's buffers, kept from one to the next.
#[derive(Default)]
struct Work {
    counts: Vec<u8>,
    planes: Vec<u8>,
    coded: Vec<bool>,
    coeffs: Vec<i32>,
}

/// The packet at `at`: its coefficients into `work.coeffs`, each band at
/// its groups' place; where the packet ends.
fn packet(cs: &[u8], at: usize, packet: &Packet, h: &Header, truncations: &[u8; BANDS], modes: &[u8; BANDS], history: &mut [Vec<u8>], work: &mut Work) -> Result<usize, Error> {
    const LENGTHS: Error = Error::Corrupt("a Nikon High Efficiency packet whose lengths disagree with its counts");
    let head = cs.get(at..at + 7).ok_or(SHORT)?;
    let v = head.iter().fold(0u64, |v, &b| v << 8 | b as u64);
    if v >> 55 != 0 {
        return Err(Error::Unsupported("a Nikon High Efficiency frame with raw-coded packets"));
    }
    let (len_data, len_count, len_sign) = ((v >> 35 & 0xfffff) as usize, (v >> 15 & 0xfffff) as usize, (v & 0x7fff) as usize);
    let (ng, ss) = (h.group, h.flagged);
    let flags: usize = packet.bands.iter().filter(|b| modes[b.weight] & 1 != 0).map(|b| b.groups.div_ceil(ss)).sum();
    let p_count = at + 7 + flags.div_ceil(8);
    let p_data = p_count + len_count;
    let p_sign = p_data + len_data;
    let end = p_sign + len_sign;
    if end > cs.len() {
        return Err(SHORT);
    }
    let groups: usize = packet.bands.iter().map(|b| b.groups).sum();
    work.counts.clear();
    work.planes.clear();
    work.coded.clear();
    work.coeffs.clear();
    work.coeffs.resize(groups * ng, 0);
    // The significance flags: a set one, and its groups have no count
    // coded.
    let mut sig = Bits { data: &cs[at + 7..p_count], at: 0 };
    for b in &packet.bands {
        if modes[b.weight] & 1 == 0 {
            work.coded.resize(work.coded.len() + b.groups, true);
            continue;
        }
        for g in (0..b.groups).step_by(ss) {
            let coded = sig.take(1)? == 0;
            work.coded.resize(work.coded.len() + ss.min(b.groups - g), coded);
        }
    }
    // The counts.
    let mut counts = Bits { data: &cs[p_count..p_data], at: 0 };
    let (mut any, mut gi, mut data_bits) = (false, 0, 0usize);
    for b in &packet.bands {
        let t = truncations[b.weight] as i32;
        let predicted = modes[b.weight] & 2 != 0;
        let above = &history[b.history];
        for &up in &above[..b.groups] {
            let u = if work.coded[gi] {
                any = true;
                counts.unary()?
            } else {
                0
            };
            let m = if predicted {
                let top = (up as i32).max(t);
                let room = top - t;
                top + if u <= 2 * room {
                    if u & 1 == 1 { -((u + 1) / 2) } else { u / 2 }
                } else {
                    u - room
                }
            } else {
                t + u
            };
            if !(0..=31).contains(&m) {
                return Err(Error::Corrupt("a Nikon High Efficiency count past 31 bit planes"));
            }
            let n = (m - t).max(0);
            work.counts.push(m as u8);
            work.planes.push(n as u8);
            data_bits += n as usize * ng;
            gi += 1;
        }
    }
    if (if any { counts.bytes_used() } else { 0 }) != len_count || data_bits.div_ceil(8) != len_data {
        return Err(LENGTHS);
    }
    // The magnitudes: a plane the group's bits, the highest plane first.
    let mut data = Bits { data: &cs[p_data..p_sign], at: 0 };
    let mut nonzero = 0usize;
    for (c, &n) in work.coeffs.chunks_exact_mut(ng).zip(&work.planes) {
        for _ in 0..n {
            let plane = data.take(ng)?;
            for (j, x) in c.iter_mut().enumerate() {
                *x = *x << 1 | (plane >> (ng - 1 - j) & 1) as i32;
            }
        }
        nonzero += c.iter().filter(|&&x| x != 0).count();
    }
    if nonzero.div_ceil(8) != len_sign {
        return Err(LENGTHS);
    }
    // The signs, and each magnitude to its value.
    let mut signs = Bits { data: &cs[p_sign..end], at: 0 };
    let mut gi = 0;
    for b in &packet.bands {
        let t = truncations[b.weight] as u32;
        for g in 0..b.groups {
            let n = work.planes[gi] as u32;
            if n != 0 {
                for x in &mut work.coeffs[gi * ng..(gi + 1) * ng] {
                    if *x != 0 {
                        let v = dequantize(*x as u32, n, t) << h.fractional;
                        *x = if signs.take(1)? == 1 { v.wrapping_neg() } else { v };
                    }
                }
            }
            history[b.history][g] = work.counts[gi];
            gi += 1;
        }
    }
    Ok(end)
}

/// One level of the 5/3 lifting undone: `low` the even samples, `high`
/// the odd, the ends repeated.
fn inverse_53(low: &[i32], high: &[i32], out: &mut [i32]) {
    let (nl, nh) = (low.len(), high.len());
    if nh == 0 {
        out.copy_from_slice(low);
        return;
    }
    for k in 0..nl {
        out[2 * k] = low[k] - ((high[k.saturating_sub(1)] + high[k.min(nh - 1)] + 2) >> 2);
    }
    for k in 0..nh {
        out[2 * k + 1] = high[k] + ((out[2 * k] + out[if k + 1 < nl { 2 * k + 2 } else { 2 * k }]) >> 1);
    }
}

/// A slice: where its first precinct starts, and how many it has.
struct Slice {
    at: usize,
    precincts: usize,
}

/// The stream's slices, found from each precinct's stated length.
fn slices(cs: &[u8], h: &Header) -> Result<Vec<Slice>, Error> {
    let expected = h.height / 4;
    let (mut at, mut found, mut slices) = (h.body, 0, Vec::<Slice>::new());
    loop {
        match be16(cs, at)? {
            EOC => break,
            SLH => {
                if be16(cs, at + 4)? as usize != slices.len() {
                    return Err(Error::Corrupt("a Nikon High Efficiency slice out of its order"));
                }
                at += 6;
                slices.push(Slice { at, precincts: 0 });
            }
            _ => {
                let head = cs.get(at..at + 3).ok_or(SHORT)?;
                let slice = slices.last_mut().ok_or(SHORT)?;
                if found == expected {
                    return Err(Error::Corrupt("a Nikon High Efficiency frame of more precincts than its rows"));
                }
                slice.precincts += 1;
                found += 1;
                at += 12 + ((head[0] as usize) << 16 | (head[1] as usize) << 8 | head[2] as usize);
            }
        }
    }
    if found != expected {
        return Err(Error::Corrupt("a Nikon High Efficiency frame of fewer precincts than its rows"));
    }
    Ok(slices)
}

/// A slice's precincts into `out`: eight rows of the planes' width for
/// each, a component's two after the one before's, the horizontal levels
/// undone (a decomposed component's first row then its vertical low band,
/// its second the high).
fn slice(cs: &[u8], h: &Header, layout: &Layout, s: &Slice, out: &mut [i32]) -> Result<(), Error> {
    let wc = h.width / 2;
    let mut history: Vec<Vec<u8>> = layout.histories.iter().map(|&g| vec![0u8; g]).collect();
    let mut work = Work::default();
    let (mut a, mut b) = (vec![0i32; wc], vec![0i32; wc]);
    let mut at = s.at;
    for rows in out.chunks_exact_mut(8 * wc) {
        let head = cs.get(at..at + 12).ok_or(SHORT)?;
        let end = at + 12 + ((head[0] as usize) << 16 | (head[1] as usize) << 8 | head[2] as usize);
        let (quant, refine) = (head[3] as i32, head[4]);
        let mode_bits = head[5..12].iter().fold(0u64, |v, &b| v << 8 | b as u64);
        let (mut modes, mut truncations) = ([0u8; BANDS], [0u8; BANDS]);
        for i in 0..h.gains.len() {
            modes[i] = (mode_bits >> (54 - 2 * i) & 3) as u8;
            truncations[i] = (quant - h.gains[i] as i32 - (h.priorities[i] < refine) as i32).clamp(0, 15) as u8;
        }
        let mut p = at + 12;
        for pk in &layout.packets {
            p = packet(cs, p, pk, h, &truncations, &modes, &mut history, &mut work)?;
            let row = &mut rows[(2 * pk.component + pk.line) * wc..][..wc];
            if h.levels[pk.component].1 == 0 {
                row.copy_from_slice(&work.coeffs[..wc]);
                continue;
            }
            // From the coarsest band out, each at its groups' place.
            let (mut offset, mut have) = (0, 0);
            for band in &pk.bands {
                let src = &work.coeffs[offset..offset + band.width];
                if have == 0 {
                    a[..band.width].copy_from_slice(src);
                } else {
                    inverse_53(&a[..have], src, &mut b[..have + band.width]);
                    std::mem::swap(&mut a, &mut b);
                }
                have += band.width;
                offset += band.groups * h.group;
            }
            row.copy_from_slice(&a[..wc]);
        }
        // Zeros fill a precinct to its stated length.
        if p > end || cs.get(p..end).ok_or(SHORT)?.iter().any(|&b| b != 0) {
            return Err(Error::Corrupt("a Nikon High Efficiency precinct of another length than it states"));
        }
        at = end;
    }
    Ok(())
}

/// A plane read with its edges repeated outward.
#[derive(Clone, Copy)]
struct Grid<'a> {
    d: &'a [i32],
    w: usize,
    h: usize,
}

impl<'a> Grid<'a> {
    fn new(d: &'a [i32], w: usize, h: usize) -> Self {
        Grid { d, w, h }
    }

    #[inline]
    fn at(&self, r: isize, c: isize) -> i32 {
        self.d[r.clamp(0, self.h as isize - 1) as usize * self.w + c.clamp(0, self.w as isize - 1) as usize]
    }
}

/// The sums the lifting steps between the planes and the sites take: for
/// the site at row `r`, column `c` of its plane, its four nearest sites of
/// another kind in the mosaic (red at the top left of each 2 by 2, the
/// greens beside and below it, blue opposite).
mod sums {
    use super::Grid;

    /// For the green beside red: the other green's four, on its diagonals.
    #[inline]
    pub fn second_green(g2: Grid, r: isize, c: isize) -> i32 {
        g2.at(r, c) + g2.at(r, c + 1) + g2.at(r - 1, c) + g2.at(r - 1, c + 1)
    }

    /// For the other green: the first green's four, on its diagonals.
    #[inline]
    pub fn first_green(g1: Grid, r: isize, c: isize) -> i32 {
        g1.at(r, c - 1) + g1.at(r, c) + g1.at(r + 1, c - 1) + g1.at(r + 1, c)
    }

    /// For the green beside red: red left and right, blue above and below.
    #[inline]
    pub fn beside_first(red: Grid, blue: Grid, r: isize, c: isize) -> i32 {
        red.at(r, c) + red.at(r, c + 1) + blue.at(r - 1, c) + blue.at(r, c)
    }

    /// For the other green: red above and below, blue left and right.
    #[inline]
    pub fn beside_second(red: Grid, blue: Grid, r: isize, c: isize) -> i32 {
        red.at(r, c) + red.at(r + 1, c) + blue.at(r, c - 1) + blue.at(r, c)
    }

    /// For red: its four greens.
    #[inline]
    pub fn around_red(g1: Grid, g2: Grid, r: isize, c: isize) -> i32 {
        g1.at(r, c - 1) + g1.at(r, c) + g2.at(r - 1, c) + g2.at(r, c)
    }

    /// For blue: its four greens.
    #[inline]
    pub fn around_blue(g1: Grid, g2: Grid, r: isize, c: isize) -> i32 {
        g2.at(r, c) + g2.at(r, c + 1) + g1.at(r, c) + g1.at(r + 1, c)
    }
}

/// The frame's coded values before the table: for each row `r` of the
/// planes, the sensor's rows 2r and 2r + 1 handed to `put`; rows from
/// `rows` on are left out.
fn coded(cs: &[u8], h: &Header, rows: usize, stop: Option<&AtomicBool>, put: impl Fn(usize, &[i32], &[i32]) + Sync) -> Result<(), Error> {
    let layout = layout(h)?;
    let (wc, hc) = (h.width / 2, h.height / 2);
    let slices = slices(cs, h)?;
    // Every precinct's eight rows, the slices side by side.
    let mut bands = vec![0i32; hc / 2 * 8 * wc];
    let mut parts = Vec::with_capacity(slices.len());
    let mut rest = &mut bands[..];
    for s in &slices {
        let (part, after) = rest.split_at_mut(s.precincts * 8 * wc);
        parts.push(part);
        rest = after;
    }
    parts.into_par_iter().zip(&slices).try_for_each(|(part, s)| {
        stopped(stop)?;
        slice(cs, h, &layout, s, part)
    })?;
    stopped(stop)?;
    // The vertical level undone over each whole plane: a precinct's first
    // row of a component the low band's, its second the high's.
    let planes: Vec<Vec<i32>> = (0..4)
        .into_par_iter()
        .map(|ci| {
            let row = |k: usize, line: usize| &bands[(8 * k + 2 * ci + line) * wc..][..wc];
            let mut out = vec![0i32; wc * hc];
            let n = hc / 2;
            if h.levels[ci].1 == 0 {
                for (r, o) in out.chunks_exact_mut(wc).enumerate() {
                    o.copy_from_slice(row(r / 2, r % 2));
                }
                return out;
            }
            for k in 0..n {
                let (low, up, down) = (row(k, 0), row(k.saturating_sub(1), 1), row(k, 1));
                for (x, o) in out[2 * k * wc..][..wc].iter_mut().enumerate() {
                    *o = low[x] - ((up[x] + down[x] + 2) >> 2);
                }
            }
            for k in 0..n {
                let (above, rest) = out[2 * k * wc..].split_at_mut(wc);
                let (odd, rest) = rest.split_at_mut(wc);
                let below = if k + 1 < n { &rest[..wc] } else { &above[..] };
                for (x, o) in odd.iter_mut().enumerate() {
                    *o = row(k, 1)[x] + ((above[x] + below[x]) >> 1);
                }
            }
            out
        })
        .collect();
    drop(bands);
    stopped(stop)?;
    let [mut luma, red, mut green, blue]: [Vec<i32>; 4] = planes.try_into().map_err(|_| DECLINED)?;
    sites(&mut luma, &red, &mut green, &blue, wc, hc);
    stopped(stop)?;
    // Red and blue from their differences and their four greens.
    let grid = |d| Grid::new(d, wc, hc);
    let (g1, g2, cr, cb) = (grid(&luma), grid(&green), grid(&red), grid(&blue));
    (0..hc.min(rows.div_ceil(2))).into_par_iter().for_each_init(
        || (vec![0i32; 2 * wc], vec![0i32; 2 * wc]),
        |(top, bottom), r| {
            let ri = r as isize;
            for c in 0..wc {
                let ci = c as isize;
                top[2 * c] = cr.at(ri, ci) + (sums::around_red(g1, g2, ri, ci) >> 2);
                top[2 * c + 1] = g1.at(ri, ci);
                bottom[2 * c] = g2.at(ri, ci);
                bottom[2 * c + 1] = cb.at(ri, ci) + (sums::around_blue(g1, g2, ri, ci) >> 2);
            }
            put(r, top, bottom);
        },
    );
    Ok(())
}

/// The greens from the luma and the greens' difference, each in its
/// plane's place: the first green without its share of the difference;
/// the other from the difference and the first's four; then both without
/// their share of the red and blue differences beside them.
fn sites(luma: &mut [i32], red: &[i32], green: &mut [i32], blue: &[i32], w: usize, h: usize) {
    let rows = |plane: &mut [i32], f: &(dyn Fn(isize, isize) -> i32 + Sync)| {
        plane.par_chunks_exact_mut(w).enumerate().for_each(|(r, row)| {
            for (c, v) in row.iter_mut().enumerate() {
                *v += f(r as isize, c as isize);
            }
        });
    };
    let dg = Grid::new(green, w, h);
    rows(luma, &|r, c| -(sums::second_green(dg, r, c) >> 3));
    let g1 = Grid::new(luma, w, h);
    rows(green, &|r, c| sums::first_green(g1, r, c) >> 2);
    let (cr, cb) = (Grid::new(red, w, h), Grid::new(blue, w, h));
    rows(luma, &|r, c| -(sums::beside_first(cr, cb, r, c) >> 3));
    rows(green, &|r, c| -(sums::beside_second(cr, cb, r, c) >> 3));
}

/// The frame's first `rows` rows, the slices across the cores, handed row
/// by row to `put`; Canceled between slices and stages once `stop` is set.
/// `width` and `height` are the frame's as the file's directory states
/// them, which the stream must agree with.
pub fn decode(strip: &[u8], width: usize, height: usize, rows: usize, stop: Option<&AtomicBool>, put: impl Fn(usize, &[u16]) + Sync) -> Result<(), Error> {
    let h = header(strip)?;
    if (h.width, h.height) != (width, height) || CURVE.len() != 2 * CURVE_LEN {
        return Err(DECLINED);
    }
    let table = |row: &[i32], out: &mut [u16]| {
        for (o, &v) in out.iter_mut().zip(row) {
            let i = v.saturating_add(CURVE_BIAS).clamp(0, CURVE_LEN as i32 - 1) as usize;
            *o = u16::from_le_bytes([CURVE[2 * i], CURVE[2 * i + 1]]);
        }
    };
    let line = |r: usize, top: &[i32], bottom: &[i32]| {
        let mut out = vec![0u16; width];
        table(top, &mut out);
        put(2 * r, &out);
        if 2 * r + 1 < rows {
            table(bottom, &mut out);
            put(2 * r + 1, &out);
        }
    };
    coded(strip, &h, rows, stop, line)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Bits written most significant first.
    #[derive(Default)]
    struct Writer {
        bytes: Vec<u8>,
        bits: usize,
    }

    impl Writer {
        fn put(&mut self, v: u32, n: usize) {
            for i in (0..n).rev() {
                if self.bits % 8 == 0 {
                    self.bytes.push(0);
                }
                *self.bytes.last_mut().unwrap() |= ((v >> i & 1) as u8) << (7 - self.bits % 8);
                self.bits += 1;
            }
        }
    }

    /// One level of the 5/3 lifting: the odd samples predicted, then the
    /// even ones updated.
    fn forward_53(x: &[i32]) -> (Vec<i32>, Vec<i32>) {
        let n = x.len();
        let high: Vec<i32> = (0..n / 2).map(|k| x[2 * k + 1] - ((x[2 * k] + x[if 2 * k + 2 < n { 2 * k + 2 } else { 2 * k }]) >> 1)).collect();
        let low = (0..n.div_ceil(2)).map(|k| if high.is_empty() { x[2 * k] } else { x[2 * k] + ((high[k.saturating_sub(1)] + high[k.min(high.len() - 1)] + 2) >> 2) }).collect();
        (low, high)
    }

    /// The four sites' planes as the four coded planes: `sites` and the
    /// last step of `coded`, the other way round.
    fn planes_of(r: &[i32], g1: &[i32], g2: &[i32], b: &[i32], w: usize, h: usize) -> [Vec<i32>; 4] {
        let grid = |d| Grid::new(d, w, h);
        let each = |f: &dyn Fn(isize, isize) -> i32| -> Vec<i32> { (0..h).flat_map(|r| (0..w).map(move |c| (r, c))).map(|(r, c)| f(r as isize, c as isize)).collect() };
        let at = |d: &[i32], r: isize, c: isize| d[r as usize * w + c as usize];
        let cr = each(&|y, x| at(r, y, x) - (sums::around_red(grid(g1), grid(g2), y, x) >> 2));
        let cb = each(&|y, x| at(b, y, x) - (sums::around_blue(grid(g1), grid(g2), y, x) >> 2));
        let g1p = each(&|y, x| at(g1, y, x) + (sums::beside_first(grid(&cr), grid(&cb), y, x) >> 3));
        let g2p = each(&|y, x| at(g2, y, x) + (sums::beside_second(grid(&cr), grid(&cb), y, x) >> 3));
        let dg = each(&|y, x| at(&g2p, y, x) - (sums::first_green(grid(&g1p), y, x) >> 2));
        let luma = each(&|y, x| at(&g1p, y, x) + (sums::second_green(grid(&dg), y, x) >> 3));
        [luma, cr, dg, cb]
    }

    /// A frame coded as the module's notes state it, nothing truncated (Q
    /// 0, no fractional bits), each band's two mode bits changing from
    /// precinct to precinct, a slice every 16 precincts.
    fn encode(sites: [&[i32]; 4], width: usize, height: usize) -> Vec<u8> {
        let (wc, hc) = (width / 2, height / 2);
        let levels = [(5, 1), (5, 1), (0, 0), (5, 1)];
        let mut cs = vec![0xff, 0x10, 0xff, 0x50, 0, 4, 0, 0];
        let mut pih = vec![0u8; 26];
        pih[8..10].copy_from_slice(&(width as u16).to_be_bytes());
        pih[10..12].copy_from_slice(&(height as u16).to_be_bytes());
        (pih[15], pih[16], pih[17], pih[18], pih[21], pih[23]) = (16, 4, 4, 8, 0x10, 0x14);
        let pih_at = cs.len() + 4;
        cs.extend([0xff, 0x12, 0, 28]);
        cs.extend(&pih);
        cs.extend([0xff, 0x13, 0, 14]);
        cs.extend(levels.iter().flat_map(|&(x, y)| [14, 0x11, (x << 4 | y) as u8]));
        cs.extend([0xff, 0x14, 0, 52]);
        cs.extend([0u8; 50]);
        let h = Header { width, height, group: 4, flagged: 8, fractional: 0, levels, gains: vec![0; 25], priorities: vec![0; 25], body: cs.len() };
        let layout = layout(&h).unwrap();
        // Each component's rows: the vertical level, then for a precinct
        // its low row cut into bands and its high row cut once.
        let planes = planes_of(sites[0], sites[1], sites[2], sites[3], wc, hc);
        let column = |p: &[i32], x: usize| -> Vec<i32> { (0..hc).map(|r| p[r * wc + x]).collect() };
        let split: Vec<(Vec<i32>, Vec<i32>)> = planes
            .iter()
            .map(|p| {
                let (mut low, mut high) = (vec![0; wc * hc / 2], vec![0; wc * hc / 2]);
                for x in 0..wc {
                    let (l, hi) = forward_53(&column(p, x));
                    for k in 0..hc / 2 {
                        low[k * wc + x] = l[k];
                        high[k * wc + x] = hi[k];
                    }
                }
                (low, high)
            })
            .collect();
        let mut history: Vec<Vec<u8>> = layout.histories.iter().map(|&g| vec![0u8; g]).collect();
        for precinct in 0..hc / 2 {
            if precinct % 16 == 0 {
                cs.extend([0xff, 0x20, 0, 4]);
                cs.extend(((precinct / 16) as u16).to_be_bytes());
                history.iter_mut().for_each(|r| r.fill(0));
            }
            let modes: Vec<u8> = (0..25).map(|i| ((i + precinct) % 4) as u8).collect();
            let mut body = Vec::new();
            for pk in &layout.packets {
                let ci = pk.component;
                let row = |d: &[i32], k: usize| d[k * wc..(k + 1) * wc].to_vec();
                // The packet's bands, coarsest first.
                let bands: Vec<Vec<i32>> = if levels[ci].1 == 0 {
                    vec![row(&planes[ci], 2 * precinct + pk.line)]
                } else if pk.line == 1 {
                    let (l, hi) = forward_53(&row(&split[ci].1, precinct));
                    vec![l, hi]
                } else {
                    let mut out = Vec::new();
                    let mut low = row(&split[ci].0, precinct);
                    for _ in 0..levels[ci].0 {
                        let (l, hi) = forward_53(&low);
                        out.push(hi);
                        low = l;
                    }
                    out.push(low);
                    out.reverse();
                    out
                };
                let (mut sig, mut counts, mut data, mut signs) = (Writer::default(), Writer::default(), Writer::default(), Writer::default());
                for (band, coeffs) in pk.bands.iter().zip(&bands) {
                    assert_eq!(band.width, coeffs.len());
                    let mode = modes[band.weight];
                    let mut padded = coeffs.clone();
                    padded.resize(band.groups * 4, 0);
                    let m: Vec<i32> = padded.chunks(4).map(|g| g.iter().map(|v| 32 - v.unsigned_abs().leading_zeros() as i32).max().unwrap()).collect();
                    let u: Vec<i32> = (0..band.groups)
                        .map(|g| {
                            let top = history[band.history][g] as i32;
                            match (mode & 2 != 0, m[g] - top) {
                                (false, _) => m[g],
                                (true, 0) => 0,
                                (true, d) if d < 0 => -2 * d - 1,
                                (true, d) if d <= top => 2 * d,
                                (true, d) => d + top,
                            }
                        })
                        .collect();
                    for g in (0..band.groups).step_by(8) {
                        let run = &u[g..(g + 8).min(band.groups)];
                        let skip = mode & 1 != 0 && run.iter().all(|&v| v == 0);
                        if mode & 1 != 0 {
                            sig.put(skip as u32, 1);
                        }
                        if !skip {
                            run.iter().for_each(|&v| {
                                (0..v).for_each(|_| counts.put(1, 1));
                                counts.put(0, 1);
                            });
                        }
                    }
                    for (g, group) in padded.chunks(4).enumerate() {
                        for plane in (0..m[g]).rev() {
                            group.iter().for_each(|v| data.put(v.unsigned_abs() >> plane & 1, 1));
                        }
                        group.iter().filter(|&&v| v != 0).for_each(|&v| signs.put((v < 0) as u32, 1));
                        history[band.history][g] = m[g] as u8;
                    }
                }
                let lengths = (data.bytes.len() as u64) << 35 | (counts.bytes.len() as u64) << 15 | signs.bytes.len() as u64;
                body.extend(&lengths.to_be_bytes()[1..]);
                for run in [sig, counts, data, signs] {
                    body.extend(run.bytes);
                }
            }
            // A precinct's length, Q 0, R 0, the modes; a zero to fill.
            body.push(0);
            cs.extend(&(body.len() as u32).to_be_bytes()[1..]);
            cs.extend([0, 0]);
            let bits = modes.iter().enumerate().fold(0u64, |v, (i, &m)| v | (m as u64) << (54 - 2 * i));
            cs.extend(&bits.to_be_bytes()[1..]);
            cs.extend(body);
        }
        cs.extend([0xff, 0x11]);
        let len = cs.len() as u32;
        cs[pih_at..pih_at + 4].copy_from_slice(&len.to_be_bytes());
        cs
    }

    /// A frame of two slices and a part of a third: smooth, with jumps.
    fn frame(width: usize, height: usize) -> [Vec<i32>; 4] {
        let mut seed = 7u32;
        let mut noise = move || {
            seed = seed.wrapping_mul(1_103_515_245).wrapping_add(12345);
            (seed >> 16) as i32
        };
        std::array::from_fn(|site| (0..width / 2 * (height / 2)).map(|i| if i % 13 == site { noise() % 3000 - 300 } else { 900 * site as i32 + 3 * (i % (width / 2)) as i32 + noise() % 50 - 500 }).collect())
    }

    #[test]
    fn a_frame_decodes_as_it_was_coded() {
        for (width, height) in [(40, 136), (38, 8), (2, 4)] {
            let (wc, hc) = (width / 2, height / 2);
            let f = frame(width, height);
            let cs = encode([&f[0], &f[1], &f[2], &f[3]], width, height);
            let h = header(&cs).unwrap();
            assert_eq!(slices(&cs, &h).unwrap().len(), (hc / 2).div_ceil(16));
            let got = std::sync::Mutex::new(vec![(Vec::new(), Vec::new()); hc]);
            coded(&cs, &h, height, None, |r, top, bottom| got.lock().unwrap()[r] = (top.to_vec(), bottom.to_vec())).unwrap();
            for (r, (top, bottom)) in got.into_inner().unwrap().iter().enumerate() {
                for c in 0..wc {
                    let i = r * wc + c;
                    assert_eq!([top[2 * c], top[2 * c + 1], bottom[2 * c], bottom[2 * c + 1]], [f[0][i], f[1][i], f[2][i], f[3][i]], "{width} by {height}, row {r}, column {c}");
                }
            }
        }
    }

    #[test]
    fn the_table_takes_coded_values_to_the_sensors() {
        let (width, height) = (40, 8);
        let f = frame(width, height);
        let cs = encode([&f[0], &f[1], &f[2], &f[3]], width, height);
        let entry = |v: i32| {
            let i = (v + CURVE_BIAS).clamp(0, CURVE_LEN as i32 - 1) as usize;
            u16::from_le_bytes([CURVE[2 * i], CURVE[2 * i + 1]])
        };
        let got = std::sync::Mutex::new(vec![Vec::new(); height]);
        // Rows below the area asked for are not handed over.
        decode(&cs, width, height, 5, None, |r, line| got.lock().unwrap()[r] = line.to_vec()).unwrap();
        let got = got.into_inner().unwrap();
        assert!(got[5..].iter().all(|r| r.is_empty()));
        for (r, line) in got[..5].iter().enumerate() {
            for (c, &v) in line.iter().enumerate() {
                assert_eq!(v, entry(f[2 * (r % 2) + c % 2][r / 2 * (width / 2) + c / 2]), "row {r}, column {c}");
            }
        }
        // Another frame size than the directory's is declined.
        assert!(matches!(decode(&cs, width, height + 4, height, None, |_, _| ()), Err(Error::Unsupported(_))));
    }

    #[test]
    fn the_table_rises_from_black_to_the_depths_top() {
        let entry = |i: usize| u16::from_le_bytes([CURVE[2 * i], CURVE[2 * i + 1]]);
        assert_eq!(CURVE.len(), 2 * CURVE_LEN);
        assert!((1..CURVE_LEN).all(|i| entry(i) >= entry(i - 1)));
        // From 0 to 14 bits' top, a step at a time: no sensor value is
        // skipped, so none is out of a file's reach.
        assert_eq!((entry(0), entry(CURVE_LEN - 1)), (0, 16383));
        assert!((1..CURVE_LEN).all(|i| entry(i) - entry(i - 1) <= 1));
        // The black level every file states, where the coded values
        // reach it.
        assert_eq!((entry(15851), entry(16384), entry(16498), entry(16499)), (1008, 1008, 1008, 1009));
    }

    #[test]
    fn a_damaged_stream_is_reported() {
        let (width, height) = (40, 72);
        let f = frame(width, height);
        let cs = encode([&f[0], &f[1], &f[2], &f[3]], width, height);
        let run = |cs: &[u8]| decode(cs, width, height, height, None, |_, _| ());
        assert!(run(&cs).is_ok());
        // Cut short, and a count's bit turned.
        assert!(matches!(run(&cs[..cs.len() - 40]), Err(Error::Corrupt(_))));
        let h = header(&cs).unwrap();
        let mut turned = cs.clone();
        turned[h.body + 6 + 12 + 7] ^= 0x80;
        assert!(matches!(run(&turned), Err(Error::Corrupt(_))));
        // A raw-coded packet, and another progression, are declined.
        let mut raw = cs.clone();
        raw[h.body + 6 + 12] |= 0x80;
        assert!(matches!(run(&raw), Err(Error::Unsupported(_))));
        let mut other = cs.clone();
        other[8 + 4 + 21] = 0;
        assert!(matches!(run(&other), Err(Error::Unsupported(_))));
    }

    #[test]
    fn a_magnitude_stands_for_its_planes_top() {
        // One plane above a truncation of 3: 1 stands for 8 * 4 / 3.
        assert_eq!(dequantize(1, 1, 3), 10);
        // Nothing truncated: every magnitude itself.
        assert!((1..=15u32).all(|n| (1..1u32 << n).step_by(7).all(|m| dequantize(m, n, 0) == m as i32)));
        // The series a + a/2^(n+1) + a/4^(n+1)..., a the magnitude shifted
        // up by the truncation, summed by shifts: the same for every
        // count a 16-bit value reaches.
        for n in 1..=15u32 {
            for t in 0..=15 - n {
                for m in 1..1u32 << n {
                    let (mut d, mut sum) = ((m as u64) << t, 0u64);
                    while d > 0 {
                        sum += d;
                        d >>= n + 1;
                    }
                    assert_eq!(dequantize(m, n, t) as u64, sum, "{m} of {n} planes above {t}");
                }
            }
        }
    }

    #[test]
    fn rows_halve_rounding_up() {
        assert_eq!(level_lengths(4140, 5), vec![4140, 2070, 1035, 518, 259, 130]);
    }
}
