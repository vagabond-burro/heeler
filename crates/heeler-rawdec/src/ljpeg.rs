//! Lossless JPEG (ITU-T T.81, process 14: Huffman coded, predictive),
//! the compression of most DNG raw images and of several cameras' own
//! formats. Written from the specification: SOF3 gives the precision,
//! size and components, DHT the Huffman tables, SOS the predictor
//! (1 to 7) and point transform, DRI the restart interval.
//!
//! One scan, every component interleaved with one sample each to an MCU
//! (sampling factors of 1), which is what raw images use. Rows come out
//! one at a time, the components interleaved, to a caller's closure.

use crate::Error;

/// A frame header and scan header, read before the entropy-coded data.
#[derive(Clone, Debug)]
pub struct Frame {
    /// Sample precision in bits (2 to 16).
    pub precision: u32,
    /// Lines in the frame.
    pub height: usize,
    /// Samples a line, for each component.
    pub width: usize,
    /// Components interleaved in each line.
    pub components: usize,
    /// The scan's predictor selection value, 1 to 7.
    pub predictor: u32,
    /// The point transform (Pt): samples are coded shifted right by it.
    pub point_transform: u32,
    /// MCUs between restart markers, 0 for none.
    pub restart: usize,
    /// Where the entropy-coded data starts.
    data: usize,
    /// The Huffman table each component decodes with.
    table: Vec<usize>,
}

/// How many leading bits of the code stream index the fast table: a code
/// this short decodes with one lookup, and when its difference bits fit
/// too (nearly every one in a raw file), the difference with it.
const FAST_BITS: u32 = 12;

/// A fast table entry: the bits a lookup consumes, the code's length and
/// symbol, and the difference when the entry holds it whole.
#[derive(Clone, Copy, Default)]
struct Fast {
    /// Code and difference bits together when `whole`, else 0.
    total: u8,
    /// The code's length, 0 for a code longer than FAST_BITS.
    len: u8,
    symbol: u8,
    whole: bool,
    diff: i32,
}

/// One DC Huffman table: a lookup on the next FAST_BITS bits for short
/// codes and the canonical code bounds for longer ones (T.81 F.2.2.3).
#[derive(Clone)]
struct Huffman {
    fast: Vec<Fast>,
    /// The largest code of each length, -1 for none.
    maxcode: [i32; 18],
    /// The first symbol index of each length, less that length's first code.
    valoffset: [i32; 18],
    symbols: Vec<u8>,
}

impl Huffman {
    /// A table from a DHT segment's 16 counts and its symbols.
    fn new(counts: &[u8; 16], symbols: &[u8]) -> Result<Self, Error> {
        if symbols.iter().any(|&s| s > 16) || symbols.is_empty() {
            return Err(Error::Corrupt("a Huffman symbol outside 0..=16"));
        }
        let mut fast = vec![Fast::default(); 1 << FAST_BITS];
        let mut maxcode = [-1i32; 18];
        let mut valoffset = [0i32; 18];
        let (mut code, mut k) = (0u32, 0usize);
        for len in 1..=16u32 {
            let n = counts[len as usize - 1] as usize;
            valoffset[len as usize] = k as i32 - code as i32;
            for _ in 0..n {
                if code >= 1 << len {
                    return Err(Error::Corrupt("an overfull Huffman table"));
                }
                if len <= FAST_BITS {
                    let shift = FAST_BITS - len;
                    let base = (code << shift) as usize;
                    let s = symbols[k] as u32;
                    for (i, e) in fast[base..base + (1 << shift)].iter_mut().enumerate() {
                        *e = Fast { total: 0, len: len as u8, symbol: s as u8, whole: false, diff: 0 };
                        if s == 0 || s == 16 {
                            *e = Fast { total: len as u8, whole: true, diff: if s == 16 { 32768 } else { 0 }, ..*e };
                        } else if len + s <= FAST_BITS {
                            // The difference's bits follow the code in the
                            // same index.
                            let v = ((i as u32) >> (shift - s)) as i32 & ((1 << s) - 1);
                            let diff = if v < 1 << (s - 1) { v - (1 << s) + 1 } else { v };
                            *e = Fast { total: (len + s) as u8, whole: true, diff, ..*e };
                        }
                    }
                }
                code += 1;
                k += 1;
            }
            if n > 0 {
                maxcode[len as usize] = code as i32 - 1;
            }
            code <<= 1;
        }
        maxcode[17] = i32::MAX;
        Ok(Huffman { fast, maxcode, valoffset, symbols: symbols.to_vec() })
    }
}

/// The entropy-coded bits, most significant first, with the stuffed
/// zero after each 0xFF removed. At a marker it stops and supplies zero
/// bits, which a well-formed scan never consumes.
struct Bits<'a> {
    data: &'a [u8],
    at: usize,
    acc: u64,
    count: u32,
    marker: bool,
}

impl<'a> Bits<'a> {
    #[inline(always)]
    fn refill(&mut self) {
        // Eight bytes at once while none of them is 0xFF: the whole bytes
        // that fit go in, the rest wait.
        if !self.marker {
            if let Some(b) = self.data.get(self.at..self.at + 8) {
                let x = u64::from_be_bytes(b.try_into().unwrap());
                let inv = !x;
                let has_ff = inv.wrapping_sub(0x0101_0101_0101_0101) & !inv & 0x8080_8080_8080_8080;
                if has_ff == 0 && self.count <= 56 {
                    let n = (64 - self.count) / 8;
                    let keep = 8 * n;
                    self.acc |= (x >> (64 - keep)) << (64 - keep - self.count);
                    self.count += keep;
                    self.at += n as usize;
                    return;
                }
            }
        }
        while self.count <= 56 {
            let byte = if self.marker {
                0
            } else {
                match self.data.get(self.at) {
                    Some(&0xff) => match self.data.get(self.at + 1) {
                        Some(0) => {
                            self.at += 2;
                            0xff
                        }
                        _ => {
                            self.marker = true;
                            0
                        }
                    },
                    Some(&b) => {
                        self.at += 1;
                        b
                    }
                    None => {
                        self.marker = true;
                        0
                    }
                }
            };
            self.acc |= (byte as u64) << (56 - self.count);
            self.count += 8;
        }
    }

    #[inline(always)]
    fn peek(&self, n: u32) -> u32 {
        (self.acc >> (64 - n)) as u32
    }

    #[inline(always)]
    fn skip(&mut self, n: u32) {
        self.acc <<= n;
        self.count -= n;
    }

    /// One difference: its category through `h`, then that many bits,
    /// extended to a signed value (T.81 F.2.2.1). Category 16 is 32768
    /// with no bits following (H.1.2.2).
    #[inline(always)]
    fn diff(&mut self, h: &Huffman) -> Result<i32, Error> {
        if self.count < 32 {
            self.refill();
        }
        let e = h.fast[self.peek(FAST_BITS) as usize];
        if e.whole {
            self.skip(e.total as u32);
            return Ok(e.diff);
        }
        let s = if e.len != 0 {
            self.skip(e.len as u32);
            e.symbol as u32
        } else {
            self.slow(h)?
        };
        if s == 0 {
            return Ok(0);
        }
        if s == 16 {
            return Ok(32768);
        }
        if self.count < s {
            self.refill();
        }
        let v = self.peek(s) as i32;
        self.skip(s);
        Ok(if v < 1 << (s - 1) { v - (1 << s) + 1 } else { v })
    }

    /// A code longer than the fast table: compare against each length's
    /// largest code in turn (T.81 F.2.2.3).
    #[cold]
    fn slow(&mut self, h: &Huffman) -> Result<u32, Error> {
        let mut len = FAST_BITS + 1;
        while len <= 16 {
            let code = self.peek(len) as i32;
            if code <= h.maxcode[len as usize] {
                self.skip(len);
                let i = (code + h.valoffset[len as usize]) as usize;
                return h.symbols.get(i).map(|&s| s as u32).ok_or(Error::Corrupt("a Huffman code past its table"));
            }
            len += 1;
        }
        Err(Error::Corrupt("an undefined Huffman code"))
    }

    /// Past the restart marker the coder put at an interval's end: the
    /// bits left in the current byte are padding.
    fn restart(&mut self) -> Result<(), Error> {
        self.acc = 0;
        self.count = 0;
        self.marker = false;
        // Fill bytes (0xFF) may precede the marker.
        while self.data.get(self.at) == Some(&0xff) && self.data.get(self.at + 1) == Some(&0xff) {
            self.at += 1;
        }
        match self.data.get(self.at..self.at + 2) {
            Some([0xff, m]) if (0xd0..=0xd7).contains(m) => {
                self.at += 2;
                Ok(())
            }
            _ => Err(Error::Corrupt("a restart marker missing")),
        }
    }
}

fn be16(d: &[u8], at: usize) -> Result<usize, Error> {
    d.get(at..at + 2).map(|b| (b[0] as usize) << 8 | b[1] as usize).ok_or(Error::Corrupt("a JPEG segment past the end"))
}

/// The frame and its tables, from the markers before the scan.
fn headers(data: &[u8]) -> Result<(Frame, Vec<Option<Huffman>>), Error> {
    if data.get(..2) != Some(&[0xff, 0xd8]) {
        return Err(Error::Corrupt("not a JPEG stream"));
    }
    let mut at = 2;
    let mut tables: Vec<Option<Huffman>> = vec![None, None, None, None];
    let mut sof: Option<(u32, usize, usize, Vec<u8>)> = None;
    let mut restart = 0;
    loop {
        // Fill bytes before a marker are allowed (B.1.1.2).
        while data.get(at) == Some(&0xff) && data.get(at + 1) == Some(&0xff) {
            at += 1;
        }
        let marker = be16(data, at)?;
        if marker >> 8 != 0xff {
            return Err(Error::Corrupt("a JPEG marker expected"));
        }
        let len = be16(data, at + 2)?;
        let body = data.get(at + 4..at + 2 + len).ok_or(Error::Corrupt("a JPEG segment past the end"))?;
        match marker {
            0xffc3 => {
                if body.len() < 6 {
                    return Err(Error::Corrupt("a short frame header"));
                }
                let n = body[5] as usize;
                if n == 0 || n > 4 || body.len() < 6 + 3 * n {
                    return Err(Error::Corrupt("a frame header's components"));
                }
                let mut ids = Vec::with_capacity(n);
                for c in 0..n {
                    let (id, sampling) = (body[6 + 3 * c], body[7 + 3 * c]);
                    if sampling != 0x11 {
                        return Err(Error::Unsupported("subsampled lossless JPEG"));
                    }
                    ids.push(id);
                }
                sof = Some((body[0] as u32, be16(body, 1)?, be16(body, 3)?, ids));
            }
            0xffc0..=0xffcf if marker != 0xffc4 && marker != 0xffc8 && marker != 0xffcc => {
                return Err(Error::Unsupported("a JPEG process other than lossless Huffman"));
            }
            0xffc4 => {
                let mut p = 0;
                while p < body.len() {
                    let class_id = body[p];
                    let counts: [u8; 16] = body.get(p + 1..p + 17).ok_or(Error::Corrupt("a short Huffman table"))?.try_into().unwrap();
                    let n: usize = counts.iter().map(|&c| c as usize).sum();
                    let symbols = body.get(p + 17..p + 17 + n).ok_or(Error::Corrupt("a short Huffman table"))?;
                    if class_id >> 4 != 0 || class_id & 15 > 3 {
                        return Err(Error::Corrupt("a Huffman table class or slot"));
                    }
                    tables[(class_id & 15) as usize] = Some(Huffman::new(&counts, symbols)?);
                    p += 17 + n;
                }
            }
            0xffdd => restart = be16(body, 0)?,
            0xffda => {
                let (precision, height, width, ids) = sof.ok_or(Error::Corrupt("a scan before its frame"))?;
                let n = *body.first().ok_or(Error::Corrupt("a short scan header"))? as usize;
                if n != ids.len() || body.len() < 4 + 2 * n {
                    return Err(Error::Unsupported("a scan of fewer components than its frame"));
                }
                let mut table = Vec::with_capacity(n);
                for c in 0..n {
                    // Components in the scan's order, which is the frame's
                    // for every raw writer; a reordered scan is declined.
                    if body[1 + 2 * c] != ids[c] {
                        return Err(Error::Unsupported("a scan in another component order"));
                    }
                    let t = (body[2 + 2 * c] >> 4) as usize;
                    if tables.get(t).is_none_or(|t| t.is_none()) {
                        return Err(Error::Corrupt("a scan's Huffman table missing"));
                    }
                    table.push(t);
                }
                let predictor = body[1 + 2 * n] as u32;
                let point_transform = (body[3 + 2 * n] & 15) as u32;
                if !(1..=7).contains(&predictor) {
                    return Err(Error::Corrupt("a lossless predictor outside 1..=7"));
                }
                if !(2..=16).contains(&precision) || point_transform >= precision || width == 0 || height == 0 {
                    return Err(Error::Corrupt("a frame's precision or size"));
                }
                let frame = Frame { precision, height, width, components: n, predictor, point_transform, restart, data: at + 2 + len, table };
                return Ok((frame, tables));
            }
            0xffd9 => return Err(Error::Corrupt("an image with no scan")),
            _ => {}
        }
        at += 2 + len;
    }
}

/// The frame header alone.
pub fn frame(data: &[u8]) -> Result<Frame, Error> {
    headers(data).map(|(f, _)| f)
}

/// Decodes the scan, handing each line (width times components samples,
/// the components interleaved) to `line` with its index. Samples are as
/// coded: a point transform is not undone, and is declined unless 0.
pub fn decode(data: &[u8], mut line: impl FnMut(usize, &[u16])) -> Result<Frame, Error> {
    let (f, tables) = headers(data)?;
    if f.point_transform != 0 {
        return Err(Error::Unsupported("a lossless point transform"));
    }
    if f.restart != 0 && f.restart % f.width != 0 {
        return Err(Error::Unsupported("a restart interval that is not whole lines"));
    }
    let huff: Vec<&Huffman> = f.table.iter().map(|&t| tables[t].as_ref().unwrap()).collect();
    lines(&f, &huff, data, f.data, 0, f.height, &mut line)?;
    Ok(f)
}

/// Decodes `count` lines from byte `at` of `data`, the first of them
/// line `y0`, which starts the scan or a restart interval.
fn lines(f: &Frame, huff: &[&Huffman], data: &[u8], at: usize, y0: usize, count: usize, line: &mut impl FnMut(usize, &[u16])) -> Result<(), Error> {
    let (w, n) = (f.width, f.components);
    let samples = w * n;
    let restart_lines = if f.restart == 0 { usize::MAX } else { f.restart / w };
    let mut bits = Bits { data, at, acc: 0, count: 0, marker: false };
    let mut prev = vec![0u16; samples];
    let mut cur = vec![0u16; samples];
    let initial = 1u16 << (f.precision - f.point_transform - 1);
    let mut since_restart = 0usize;
    for y in y0..y0 + count {
        if since_restart == restart_lines {
            bits.restart()?;
            since_restart = 0;
        }
        // The first line of the scan or of a restart interval predicts
        // from the left only, its first sample from the midpoint
        // (H.1.2.1); a later line's first sample from the one above.
        let first = since_restart == 0;
        for c in 0..n {
            let d = bits.diff(huff[c])?;
            let p = if first { initial } else { prev[c] };
            cur[c] = p.wrapping_add(d as u16);
        }
        if first || f.predictor == 1 {
            let mut i = n;
            if n == 2 {
                let (h0, h1) = (huff[0], huff[1]);
                while i < samples {
                    let d0 = bits.diff(h0)?;
                    let d1 = bits.diff(h1)?;
                    cur[i] = cur[i - 2].wrapping_add(d0 as u16);
                    cur[i + 1] = cur[i - 1].wrapping_add(d1 as u16);
                    i += 2;
                }
            } else {
                while i < samples {
                    for c in 0..n {
                        let d = bits.diff(huff[c])?;
                        cur[i + c] = cur[i + c - n].wrapping_add(d as u16);
                    }
                    i += n;
                }
            }
        } else {
            for i in (n..samples).step_by(n) {
                for c in 0..n {
                    let d = bits.diff(huff[c])?;
                    let (a, b, cc) = (cur[i + c - n] as i32, prev[i + c] as i32, prev[i + c - n] as i32);
                    let p = match f.predictor {
                        2 => b,
                        3 => cc,
                        4 => a + b - cc,
                        5 => a + ((b - cc) >> 1),
                        6 => b + ((a - cc) >> 1),
                        _ => (a + b) >> 1,
                    };
                    cur[i + c] = (p as u16).wrapping_add(d as u16);
                }
            }
        }
        line(y, &cur);
        std::mem::swap(&mut prev, &mut cur);
        since_restart += 1;
    }
    Ok(())
}

/// Decodes a scan with restart markers at whole lines across the cores,
/// each restart interval from its own marker, into `out` (height lines of
/// width times components samples), the same samples `decode` hands over.
/// None when the scan has no restart markers, or not one an interval.
pub fn decode_intervals(data: &[u8], out: &mut [u16]) -> Result<Option<Frame>, Error> {
    use rayon::prelude::*;
    let (f, tables) = headers(data)?;
    if f.point_transform != 0 || f.restart == 0 || f.restart % f.width != 0 {
        return Ok(None);
    }
    let samples = f.width * f.components;
    if out.len() < f.height * samples {
        return Err(Error::Corrupt("a scan larger than its buffer"));
    }
    let per = f.restart / f.width;
    let intervals = f.height.div_ceil(per);
    // Where each interval's codes start: the scan's, then just past each
    // restart marker (a 0xff byte before 0xd0 to 0xd7; stuffed bytes are
    // 0xff 0x00).
    let mut starts = Vec::with_capacity(intervals);
    starts.push(f.data);
    let mut i = f.data;
    while starts.len() < intervals && i + 1 < data.len() {
        if data[i] == 0xff && (0xd0..=0xd7).contains(&data[i + 1]) {
            starts.push(i + 2);
            i += 2;
        } else {
            i += 1;
        }
    }
    if starts.len() != intervals {
        return Ok(None);
    }
    let huff: Vec<&Huffman> = f.table.iter().map(|&t| tables[t].as_ref().unwrap()).collect();
    out[..f.height * samples].par_chunks_mut(per * samples).zip(starts.par_iter()).enumerate().try_for_each(|(k, (chunk, &at))| {
        let y0 = k * per;
        let count = per.min(f.height - y0);
        lines(&f, &huff, data, at, y0, count, &mut |y, l: &[u16]| chunk[(y - y0) * samples..][..samples].copy_from_slice(l))
    })?;
    Ok(Some(f))
}

/// How many codes the scan's Huffman tables take to repeat: 1 where every
/// component shares a table, else the shortest cycle of the components'
/// tables.
pub fn table_period(f: &Frame) -> usize {
    let n = f.table.len().max(1);
    (1..=n).find(|&p| n % p == 0 && (0..n).all(|i| f.table[i] == f.table[i % p])).unwrap_or(n)
}

/// Decodes a scan whose lines can be rebuilt independently (predictor 1,
/// no restart markers) across the cores, into `out` (height lines of
/// width times components samples), the same samples `decode` hands
/// over. None when the scan is not of that kind; the caller decodes it in
/// order then.
///
/// A Huffman code stream can be read from any bit, and a reader that
/// starts mid-code falls into step with the true code boundaries within
/// a few codes. So the stream is cut into pieces and each is read from
/// its own start at once; then, in order, each piece is read from its
/// true first code (where the piece before it ended) only until that
/// reading meets a code boundary of the piece's own, after which the two
/// agree and the piece's own reading is kept (or the whole piece is read
/// again if they never meet within the codes it remembers). Where the
/// components take different tables (a CR2's two), a piece does not know
/// which component its first code belongs to, so it is read once for
/// each place in the tables' cycle, and a reading is kept only from a
/// boundary where both the bit and the place agree with the true reading.
/// The differences then become samples a line at a time, the lines side
/// by side, once the first sample of each line (predicted from the line
/// above) is known.
pub fn decode_parallel(data: &[u8], out: &mut [u16]) -> Result<Option<Frame>, Error> {
    use rayon::prelude::*;
    let (f, tables) = headers(data)?;
    if f.point_transform != 0 || f.restart != 0 || f.predictor != 1 {
        return Ok(None);
    }
    let n = f.components;
    let samples = f.width * n;
    let total = f.height * samples;
    if out.len() < total {
        return Err(Error::Corrupt("a scan larger than its buffer"));
    }
    // The table for each place in the cycle.
    let period = table_period(&f);
    let huff: Vec<&Huffman> = (0..period).map(|k| tables[f.table[k]].as_ref().unwrap()).collect();
    // The entropy-coded data runs to the first marker.
    let raw = &data[f.data..];
    let end = raw.windows(2).position(|w| w[0] == 0xff && w[1] != 0).unwrap_or(raw.len());
    let raw = &raw[..end];
    let bits = destuff(raw)?;
    let total_bits = (bits.len() - 8) * 8;
    if total_bits == 0 {
        return Err(Error::Corrupt("a scan with no data"));
    }
    let pieces = rayon::current_num_threads().max(1) * 4;
    let span = (total_bits / pieces).max(1 << 14);
    let starts: Vec<usize> = (0..total_bits).step_by(span).collect();
    /// How many code boundaries a piece remembers to fall into step by.
    const SYNC: usize = 4096;
    /// A piece read from a bit, its first code taken at one place of the
    /// tables' cycle.
    struct Reading {
        /// Where in the cycle its first code is.
        phase: usize,
        diffs: Vec<u16>,
        bounds: Vec<usize>,
        exit: usize,
        ok: bool,
    }
    impl Reading {
        /// The place in the cycle after its last code.
        fn exit_phase(&self, period: usize) -> usize {
            (self.phase + self.diffs.len()) % period
        }
    }
    struct Piece {
        /// Codes read from the true start before the readings meet.
        head: Vec<u16>,
        /// One reading a place in the cycle (just the one once settled).
        readings: Vec<Reading>,
        /// The reading kept and the code it is kept from.
        kept: (usize, usize),
    }
    let read = |from: usize, until: usize, phase: usize, remember: usize| -> Reading {
        let mut r = Flat { data: &bits, pos: from };
        let mut p = Reading { phase, diffs: Vec::with_capacity((until - from) / 4), bounds: Vec::with_capacity(remember.min(SYNC)), exit: from, ok: true };
        let mut k = phase;
        while r.pos < until && r.pos < total_bits {
            if p.bounds.len() < remember {
                p.bounds.push(r.pos);
            }
            match r.diff(huff[k]) {
                Ok(d) => p.diffs.push(d as u16),
                Err(_) => {
                    p.ok = false;
                    break;
                }
            }
            k = if k + 1 == period { 0 } else { k + 1 };
        }
        p.exit = r.pos;
        p
    };
    let mut read_pieces: Vec<Piece> = starts
        .par_iter()
        .enumerate()
        .map(|(i, &from)| {
            let until = starts.get(i + 1).copied().unwrap_or(total_bits);
            let readings = if i == 0 { vec![read(from, until, 0, 0)] } else { (0..period).into_par_iter().map(|q| read(from, until, q, SYNC)).collect() };
            Piece { head: Vec::new(), readings, kept: (0, 0) }
        })
        .collect();
    // In order: each piece kept from where the one before it truly ended.
    if !read_pieces[0].readings[0].ok && read_pieces.len() > 1 {
        return Err(Error::Corrupt("an undefined Huffman code"));
    }
    let mut at = read_pieces[0].readings[0].exit;
    let mut phase = read_pieces[0].readings[0].exit_phase(period);
    let count = read_pieces.len();
    for i in 1..count {
        let until = starts.get(i + 1).copied().unwrap_or(total_bits);
        // Read from the true start until it meets a code boundary of one
        // of the piece's readings at the same place in the cycle. A reading
        // that broke (one from a false start can meet a code no table has)
        // is left out; a piece no reading meets within the codes it
        // remembers is read again.
        let mut met = None;
        let mut head = Vec::new();
        {
            let p = &read_pieces[i];
            let mut r = Flat { data: &bits, pos: at };
            let mut k = phase;
            let mut j: Vec<usize> = p.readings.iter().map(|q| q.bounds.partition_point(|&b| b < at)).collect();
            'walk: loop {
                let mut open = false;
                for (q, reading) in p.readings.iter().enumerate() {
                    if !reading.ok {
                        continue;
                    }
                    while j[q] < reading.bounds.len() && reading.bounds[j[q]] < r.pos {
                        j[q] += 1;
                    }
                    if j[q] < reading.bounds.len() {
                        open = true;
                        if reading.bounds[j[q]] == r.pos && (reading.phase + j[q]) % period == k {
                            met = Some((q, j[q]));
                            break 'walk;
                        }
                    }
                }
                if !open {
                    break;
                }
                match r.diff(huff[k]) {
                    Ok(d) => head.push(d as u16),
                    Err(_) => break,
                }
                k = if k + 1 == period { 0 } else { k + 1 };
            }
        }
        let p = &mut read_pieces[i];
        match met {
            Some(kept) => {
                p.kept = kept;
                p.head = head;
            }
            None => {
                p.readings = vec![read(at, until, phase, 0)];
                p.kept = (0, 0);
                p.head = Vec::new();
            }
        }
        let reading = &p.readings[p.kept.0];
        if !reading.ok && i + 1 < count {
            return Err(Error::Corrupt("an undefined Huffman code"));
        }
        at = reading.exit;
        phase = reading.exit_phase(period);
    }
    // The readings kept, without the others.
    let read_pieces: Vec<(Vec<u16>, Reading, usize)> = read_pieces
        .into_iter()
        .map(|mut p| {
            let (q, k) = p.kept;
            (p.head, p.readings.swap_remove(q), k)
        })
        .collect();
    // Each piece's differences in place, then the lines rebuilt.
    let mut offsets = Vec::with_capacity(read_pieces.len());
    let mut sum = 0usize;
    for (head, reading, k) in &read_pieces {
        offsets.push(sum);
        sum += head.len() + reading.diffs.len() - k;
    }
    if sum < total {
        return Err(Error::Corrupt("a scan shorter than its frame"));
    }
    {
        let out = crate::ahd::Out(out.as_mut_ptr());
        read_pieces.par_iter().zip(&offsets).for_each(|((head, reading, k), &o)| {
            if o >= total {
                return;
            }
            let mut o = o;
            for src in [&head[..], &reading.diffs[*k..]] {
                let len = src.len().min(total.saturating_sub(o));
                // SAFETY: the pieces' ranges are disjoint and inside the
                // first `total` samples of `out`.
                unsafe { std::ptr::copy_nonoverlapping(src.as_ptr(), out.at(o), len) };
                o += len;
            }
        });
    }
    drop(read_pieces);
    // The first sample of each component on each line, in order: the one
    // above it plus its difference, the first line's from the midpoint.
    let initial = 1u16 << (f.precision - 1);
    let mut firsts = vec![0u16; f.height * n];
    for y in 0..f.height {
        for c in 0..n {
            let above = if y == 0 { initial } else { firsts[(y - 1) * n + c] };
            firsts[y * n + c] = above.wrapping_add(out[y * samples + c]);
        }
    }
    out[..total].par_chunks_mut(samples).zip(firsts.par_chunks(n)).for_each(|(line, first)| {
        line[..n].copy_from_slice(first);
        for i in n..line.len() {
            line[i] = line[i - n].wrapping_add(line[i]);
        }
    });
    Ok(Some(f))
}

/// The entropy-coded bytes with each stuffed zero removed, eight zero
/// bytes after them so a reader can always load eight at once; the
/// pieces copied side by side.
fn destuff(raw: &[u8]) -> Result<Vec<u8>, Error> {
    use rayon::prelude::*;
    let pieces = rayon::current_num_threads().max(1) * 2;
    let mut cuts: Vec<usize> = (0..pieces).map(|i| raw.len() * i / pieces).collect();
    // Never cut between a 0xFF and its stuffed zero.
    for c in cuts.iter_mut().skip(1) {
        if *c > 0 && raw[*c - 1] == 0xff {
            *c += 1;
        }
    }
    cuts.push(raw.len());
    cuts.dedup();
    let ranges: Vec<(usize, usize)> = cuts.windows(2).map(|w| (w[0], w[1].max(w[0]))).collect();
    let stuffed: Vec<usize> = ranges.par_iter().map(|&(a, b)| raw[a..b].iter().filter(|&&v| v == 0xff).count()).collect();
    let mut at = Vec::with_capacity(ranges.len());
    let mut len = 0;
    for (&(a, b), &k) in ranges.iter().zip(&stuffed) {
        at.push(len);
        len += b - a - k;
    }
    let mut out = heeler_engine::memory::vector(len + 8, 0u8, "lossless JPEG bits")?;
    let ptr = crate::ahd::OutBytes(out.as_mut_ptr());
    ranges.par_iter().zip(&at).for_each(|(&(a, b), &o)| {
        let mut w = o;
        let mut i = a;
        while i < b {
            let v = raw[i];
            // SAFETY: each piece writes its own range of the output.
            unsafe { *ptr.at(w) = v };
            w += 1;
            i += if v == 0xff { 2 } else { 1 };
        }
    });
    Ok(out)
}

/// A bit reader over destuffed bytes (eight spare bytes at the end):
/// each read loads the eight bytes under the position and shifts.
struct Flat<'a> {
    data: &'a [u8],
    pos: usize,
}

impl Flat<'_> {
    #[inline(always)]
    fn peek(&self) -> u64 {
        let b = self.pos >> 3;
        let x = u64::from_be_bytes(self.data[b..b + 8].try_into().unwrap());
        x << (self.pos & 7)
    }

    #[inline(always)]
    fn diff(&mut self, h: &Huffman) -> Result<i32, Error> {
        let top = self.peek();
        let e = h.fast[(top >> (64 - FAST_BITS)) as usize];
        if e.whole {
            self.pos += e.total as usize;
            return Ok(e.diff);
        }
        let (len, s) = if e.len != 0 {
            (e.len as u32, e.symbol as u32)
        } else {
            let mut len = FAST_BITS + 1;
            loop {
                if len > 16 {
                    return Err(Error::Corrupt("an undefined Huffman code"));
                }
                let code = (top >> (64 - len)) as i32;
                if code <= h.maxcode[len as usize] {
                    let i = (code + h.valoffset[len as usize]) as usize;
                    break (len, *h.symbols.get(i).ok_or(Error::Corrupt("a Huffman code past its table"))? as u32);
                }
                len += 1;
            }
        };
        self.pos += len as usize;
        if s == 0 {
            return Ok(0);
        }
        if s == 16 {
            return Ok(32768);
        }
        let v = ((top << len) >> (64 - s)) as i32;
        self.pos += s as usize;
        Ok(if v < 1 << (s - 1) { v - (1 << s) + 1 } else { v })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::synthetic::lossless_jpeg as encode;

    fn pattern(width: usize, comps: usize, height: usize, precision: u8) -> Vec<Vec<u16>> {
        let max = (1u32 << precision) - 1;
        (0..height)
            .map(|y| {
                (0..width * comps)
                    .map(|i| {
                        let h = (i as u32).wrapping_mul(2_654_435_761) ^ (y as u32).wrapping_mul(2_246_822_519);
                        let smooth = (i as u32 * 37 + y as u32 * 11) % (max + 1);
                        if h % 13 == 0 { (h >> 7) & max } else { smooth }
                    } as u16)
                    .collect()
            })
            .collect()
    }

    #[test]
    fn every_predictor_round_trips() {
        for psv in 1..=7u8 {
            for comps in [1usize, 2, 3, 4] {
                let lines = pattern(23, comps, 9, 14);
                let data = encode(&lines, 23, comps, 14, psv, 0);
                let mut got = Vec::new();
                decode(&data, |_, l| got.push(l.to_vec())).unwrap();
                assert_eq!(got, lines, "predictor {psv}, {comps} components");
            }
        }
    }

    #[test]
    fn restart_intervals_reset_the_predictors() {
        let lines = pattern(16, 2, 12, 12);
        let data = encode(&lines, 16, 2, 12, 1, 16 * 3);
        let mut got = Vec::new();
        decode(&data, |_, l| got.push(l.to_vec())).unwrap();
        assert_eq!(got, lines);
    }

    #[test]
    fn the_parallel_decode_reads_components_with_their_own_tables() {
        // Two tables, alternating by component (a CR2's), and four
        // components on two (a cycle of two in four places); large enough
        // that pieces start on either table.
        use crate::synthetic::lossless_jpeg_tables;
        for (w, h, comps) in [(400usize, 300usize, 2usize), (300, 400, 4), (257, 211, 2)] {
            let lines = pattern(w, comps, h, 14);
            let data = lossless_jpeg_tables(&lines, w, comps, 14, 1, 0, 2);
            assert_eq!(table_period(&frame(&data).unwrap()), 2);
            let mut serial = Vec::new();
            decode(&data, |_, l| serial.extend_from_slice(l)).unwrap();
            assert_eq!(serial, lines.concat(), "{w} by {h}, {comps} components: the serial decode");
            let mut par = vec![0u16; w * comps * h];
            assert!(decode_parallel(&data, &mut par).unwrap().is_some());
            assert!(par == serial, "{w} by {h}, {comps} components");
        }
    }

    #[test]
    fn restart_intervals_decode_side_by_side_as_in_order() {
        // An interval of one line and of three (the last one short), under
        // predictors that read the line above.
        for (per, predictor) in [(1usize, 1u8), (3, 1), (1, 6), (3, 4)] {
            let (w, h, comps) = (40usize, 13usize, 3usize);
            let lines = pattern(w, comps, h, 14);
            let data = encode(&lines, w, comps, 14, predictor, w * per);
            let mut serial = Vec::new();
            decode(&data, |_, l| serial.extend_from_slice(l)).unwrap();
            let mut par = vec![0u16; w * comps * h];
            assert!(decode_intervals(&data, &mut par).unwrap().is_some());
            assert_eq!(par, serial, "{per} lines an interval, predictor {predictor}");
        }
        let plain = encode(&pattern(8, 2, 4, 12), 8, 2, 12, 1, 0);
        assert!(decode_intervals(&plain, &mut vec![0; 64]).unwrap().is_none(), "no restart markers");
    }

    #[test]
    fn sixteen_bit_samples_wrap_and_category_sixteen_is_32768() {
        let lines = vec![vec![0u16, 32768, 65535, 0, 32768, 1], vec![65535, 0, 40000, 7, 0, 65535]];
        let data = encode(&lines, 3, 2, 16, 1, 0);
        let mut got = Vec::new();
        decode(&data, |_, l| got.push(l.to_vec())).unwrap();
        assert_eq!(got, lines);
    }

    #[test]
    fn the_parallel_decode_is_the_serial_one() {
        // Large enough to be cut into many pieces, with long codes, rare
        // stuffed bytes and 16-bit wrap.
        for (w, h, comps, precision) in [(400usize, 300usize, 2usize, 14u8), (257, 211, 1, 16), (300, 400, 4, 12)] {
            let lines = pattern(w, comps, h, precision);
            let data = encode(&lines, w, comps, precision, 1, 0);
            let mut serial = Vec::new();
            decode(&data, |_, l| serial.extend_from_slice(l)).unwrap();
            let mut par = vec![0u16; w * comps * h];
            assert!(decode_parallel(&data, &mut par).unwrap().is_some());
            assert_eq!(par, serial, "{w}x{h}, {comps} components, {precision} bits");
        }
        // Another predictor or restart markers go in order.
        let lines = pattern(40, 2, 20, 12);
        assert!(decode_parallel(&encode(&lines, 40, 2, 12, 6, 0), &mut vec![0; 1600]).unwrap().is_none());
        assert!(decode_parallel(&encode(&lines, 40, 2, 12, 1, 40), &mut vec![0; 1600]).unwrap().is_none());
    }

    #[test]
    fn a_truncated_stream_never_panics() {
        let lines = pattern(40, 2, 20, 14);
        let data = encode(&lines, 40, 2, 14, 1, 0);
        let mut out = vec![0u16; 40 * 2 * 20];
        for cut in (0..data.len()).step_by(7) {
            let _ = decode(&data[..cut], |_, _| {});
            let _ = decode_parallel(&data[..cut], &mut out);
        }
    }
}
