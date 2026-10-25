//! GoPro's VC-5 codec (SMPTE ST 2073), as a GPR file holds its raw image:
//! one tile, decoded here to the 16-bit Bayer samples the DNG around it
//! describes. A port of GoPro's VC-5 decoder (MIT license option,
//! (C) 2018 GoPro Inc.), the path its GPR reader takes for a raw tile, and
//! held to that decoder's output sample for sample.
//!
//! The bitstream is read as big-endian 32-bit words, top bit first. It is
//! a sequence of segments, a 16-bit tag and a 16-bit value, starting with
//! the marker "VC-5". A negative tag is optional (its negation is the
//! tag). The header names the image width and height (which must be the
//! DNG's), the image format (raw), the 2x2 pattern, and four channels.
//! Small chunks (a tag with bit 14 set, the value their length in
//! segments) carry the unique image identifier and such, and are skipped
//! when optional; large chunks (bit 13, eight more bits of length in the
//! tag's low byte) with both bits set are codeblocks: one subband each.
//!
//! Each channel is a component array half the image's width and height:
//! the sum of the two greens, red less green, blue less green (each about
//! a midpoint of 2048), and the difference of the greens. It is coded as
//! three levels of a spatial wavelet, ten subbands in all: the lowpass
//! band of the smallest wavelet (raw values of the lowpass precision,
//! 16 bits unless a tag says otherwise), then the three highpass bands of
//! each wavelet from the smallest up. A highpass band is runs and values
//! in one Huffman codebook (GoPro's codebook 17), a value's sign bit after
//! its code, and ends with a band end code; its values are expanded by a
//! cubic companding curve and multiplied by the band's quantization. Each
//! wavelet, once its four bands are in, is inverted (a three-tap filter,
//! vertical then horizontal, with border filters at the edges) into the
//! lowpass band of the next larger one, and the largest into the
//! component array; a prescale shift per level says whether that step
//! also undoes a scaling the encoder applied.
//!
//! The four arrays are then recombined into red, the greens and blue,
//! clipped to 12 bits, and taken through GoPro's log curve to 16-bit
//! linear values, which are shifted down to 14 bits for an RGGB sensor
//! and 12 for any other (GBRG), as GoPro's reader asks for.
//!
//! The highpass decoding is sequential, as the bitstream is; the inverse
//! wavelets and the final recombination are computed rows at a time in
//! parallel, each output row from its own inputs, so the result is the
//! same however the work is split.

use std::sync::OnceLock;

use heeler_engine::memory;
use rayon::prelude::*;

use crate::Error;

/// The tile's samples, `width` by `height`, row after row: an RGGB sensor
/// (`rggb`) decodes to 14-bit samples, any other to GBRG 12-bit ones, as
/// GoPro's GPR reader asks of its decoder. The width and height are the
/// DNG's: a bitstream naming another size is refused before it sizes an
/// allocation.
pub fn decode(tile: &[u8], width: usize, height: usize, rggb: bool) -> Result<Vec<u16>, Error> {
    if width == 0 || height == 0 {
        return Err(Error::Corrupt("an empty VC-5 image"));
    }
    let mut decoder = Decoder::new(tile, width, height);
    decoder.parse()?;
    decoder.finish(rggb)
}

/// The start of every VC-5 bitstream, "VC-5".
const START_MARKER: u32 = 0x5643_2D35;

// Tags (codec.h).
const IMAGE_WIDTH: i32 = 20;
const IMAGE_HEIGHT: i32 = 21;
const BITS_PER_COMPONENT: i32 = 101;
const CHANNEL_COUNT: i32 = 12;
const CHANNEL_NUMBER: i32 = 62;
const SUBBAND_NUMBER: i32 = 48;
const LOWPASS_PRECISION: i32 = 35;
const QUANTIZATION: i32 = 53;
const PRESCALE_SHIFT: i32 = 109;
const CHANNEL_WIDTH: i32 = 104;
const CHANNEL_HEIGHT: i32 = 105;
const PATTERN_WIDTH: i32 = 106;
const PATTERN_HEIGHT: i32 = 107;
const COMPONENTS_PER_SAMPLE: i32 = 108;
const IMAGE_FORMAT: i32 = 84;
const MAX_BITS_PER_COMPONENT: i32 = 102;
const LARGE_CODEBLOCK: i32 = 0x6000;
const SMALL_CHUNK: i32 = 0x4000;
const LARGE_CHUNK: i32 = 0x2000;
const INVERSE_PERMUTATION: i32 = 0x4001;
const INVERSE_TRANSFORM: i32 = 0x4002;
const INVERSE_TRANSFORM_16: i32 = 0x4003;
const UNIQUE_IMAGE_IDENTIFIER: i32 = 0x4004;

/// The image format of a raw (CFA) image.
const IMAGE_FORMAT_RAW: i32 = 4;

/// The header parameters that must each appear at most once: their bits
/// in the decoder's record of those seen.
fn header_mask(tag: i32) -> u16 {
    match tag {
        IMAGE_WIDTH => 1,
        IMAGE_HEIGHT => 1 << 1,
        CHANNEL_COUNT => 1 << 2,
        IMAGE_FORMAT => 1 << 4,
        PATTERN_WIDTH => 1 << 5,
        PATTERN_HEIGHT => 1 << 6,
        COMPONENTS_PER_SAMPLE => 1 << 7,
        MAX_BITS_PER_COMPONENT => 1 << 8,
        _ => 0,
    }
}

const MAX_CHANNELS: usize = 4;
const WAVELETS: usize = 3;
const SUBBANDS: u16 = 10;

/// The wavelet that holds each subband, and the band within it.
const SUBBAND_WAVELET: [usize; 10] = [2, 2, 2, 2, 1, 1, 1, 0, 0, 0];
const SUBBAND_BAND: [usize; 10] = [0, 1, 2, 3, 1, 2, 3, 1, 2, 3];

/// The bitstream: whole words read from the tile, as the reference reads
/// them, so that every alignment the syntax asks for lands where it does
/// there. A read past the end yields zeros and marks the stream overrun,
/// which fails the decode.
struct Bits<'a> {
    data: &'a [u8],
    /// Bytes taken from the tile, a word or a byte at a time.
    pos: usize,
    /// The bits not yet read, from the top down: `count` of them.
    buffer: u32,
    count: u32,
    overrun: bool,
}

impl<'a> Bits<'a> {
    fn new(data: &'a [u8]) -> Self {
        Bits { data, pos: 0, buffer: 0, count: 0, overrun: false }
    }

    fn word_at(&self, at: usize) -> Option<u32> {
        let b = self.data.get(at..at.checked_add(4)?)?;
        Some(u32::from_be_bytes([b[0], b[1], b[2], b[3]]))
    }

    fn fill(&mut self) {
        match self.word_at(self.pos) {
            Some(w) => self.buffer = w,
            None => {
                self.buffer = 0;
                self.overrun = true;
            }
        }
        self.pos += 4;
        self.count = 32;
    }

    /// The next `n` bits (at most 32), right aligned.
    fn get(&mut self, n: u32) -> u32 {
        debug_assert!(n <= 32);
        if n == 0 {
            return 0;
        }
        if n <= self.count {
            let bits = self.buffer >> (32 - n);
            // A shift by the whole word leaves the word, as the hardware's.
            self.buffer = self.buffer.wrapping_shl(n);
            self.count -= n;
            bits
        } else {
            let mut bits = self.buffer >> (32 - n);
            let low = n - self.count;
            self.fill();
            bits |= self.buffer >> (32 - low);
            self.buffer = if low < 32 { self.buffer << low } else { 0 };
            self.count -= low;
            bits
        }
    }

    /// The next 32 bits without reading them, zeros past the end.
    #[inline]
    fn peek(&self) -> u32 {
        if self.count == 32 {
            self.buffer
        } else {
            self.buffer | (self.word_at(self.pos).unwrap_or(0) >> self.count)
        }
    }

    fn align_byte(&mut self) {
        let n = self.count % 8;
        self.get(n);
    }

    /// Drops what is left of the current word, unless it is all left.
    fn align_word(&mut self) {
        let n = self.count;
        if 0 < n && n < 32 {
            self.get(n);
        }
    }

    /// To the next segment, counted as the reference counts it: the bytes
    /// taken from the tile plus those still in the bit buffer.
    fn align_segment(&mut self) {
        self.align_byte();
        let mut bytes = (self.count / 8) as usize + self.pos;
        while !bytes.is_multiple_of(4) {
            self.get(8);
            bytes += 1;
        }
    }
}

/// Codebook 17: each code's length in bits, its bits, the run length and
/// the value (a magnitude; a run of zero is a marker, 1 the band end).
/// The codes run shortest first, which the lookup relies on.
#[rustfmt::skip]
const CODEBOOK: [(u8, u32, u32, i32); 264] = [
    (1, 0x00000000, 1, 0), (2, 0x00000002, 1, 1), (3, 0x00000007, 1, 2), (5, 0x00000019, 1, 3),
    (6, 0x00000030, 1, 4), (6, 0x00000036, 1, 5), (7, 0x0000006F, 1, 8), (7, 0x00000063, 1, 6),
    (7, 0x00000069, 12, 0), (7, 0x0000006B, 1, 7), (8, 0x000000D1, 20, 0), (8, 0x000000D4, 1, 9),
    (8, 0x000000DC, 1, 10), (9, 0x00000189, 1, 11), (9, 0x0000018A, 32, 0), (9, 0x000001A0, 1, 12),
    (9, 0x000001AB, 1, 13), (10, 0x00000377, 1, 18), (10, 0x00000310, 1, 14), (10, 0x00000316, 1, 15),
    (10, 0x00000343, 60, 0), (10, 0x00000354, 1, 16), (10, 0x00000375, 1, 17), (11, 0x00000623, 1, 19),
    (11, 0x00000684, 1, 20), (11, 0x00000685, 100, 0), (11, 0x000006AB, 1, 21), (11, 0x000006EC, 1, 22),
    (12, 0x00000DDB, 1, 29), (12, 0x00000C5C, 1, 24), (12, 0x00000C5E, 1, 25), (12, 0x00000C44, 1, 23),
    (12, 0x00000D55, 1, 26), (12, 0x00000DD1, 1, 27), (12, 0x00000DD3, 1, 28), (13, 0x00001BB5, 1, 35),
    (13, 0x0000188B, 1, 30), (13, 0x000018BB, 1, 31), (13, 0x000018BF, 180, 0), (13, 0x00001AA8, 1, 32),
    (13, 0x00001BA0, 1, 33), (13, 0x00001BA5, 320, 0), (13, 0x00001BA4, 1, 34), (14, 0x00003115, 1, 36),
    (14, 0x00003175, 1, 37), (14, 0x0000317D, 1, 38), (14, 0x00003553, 1, 39), (14, 0x00003768, 1, 40),
    (15, 0x00006E87, 1, 46), (15, 0x00006ED3, 1, 47), (15, 0x000062E8, 1, 42), (15, 0x000062F8, 1, 43),
    (15, 0x00006228, 1, 41), (15, 0x00006AA4, 1, 44), (15, 0x00006E85, 1, 45), (16, 0x0000C453, 1, 48),
    (16, 0x0000C5D3, 1, 49), (16, 0x0000C5F3, 1, 50), (16, 0x0000DDA4, 1, 53), (16, 0x0000DD08, 1, 51),
    (16, 0x0000DD0C, 1, 52), (17, 0x0001BB4B, 1, 61), (17, 0x0001BB4A, 1, 60), (17, 0x00018BA5, 1, 55),
    (17, 0x00018BE5, 1, 56), (17, 0x0001AA95, 1, 57), (17, 0x0001AA97, 1, 58), (17, 0x000188A4, 1, 54),
    (17, 0x0001BA13, 1, 59), (18, 0x00031748, 1, 62), (18, 0x000317C8, 1, 63), (18, 0x00035528, 1, 64),
    (18, 0x0003552C, 1, 65), (18, 0x00037424, 1, 66), (18, 0x00037434, 1, 67), (18, 0x00037436, 1, 68),
    (19, 0x00062294, 1, 69), (19, 0x00062E92, 1, 70), (19, 0x00062F92, 1, 71), (19, 0x0006AA52, 1, 72),
    (19, 0x0006AA5A, 1, 73), (19, 0x0006E86A, 1, 75), (19, 0x0006E86E, 1, 76), (19, 0x0006E84A, 1, 74),
    (20, 0x000C452A, 1, 77), (20, 0x000C5D27, 1, 78), (20, 0x000C5F26, 1, 79), (20, 0x000D54A6, 1, 80),
    (20, 0x000D54B6, 1, 81), (20, 0x000DD096, 1, 82), (20, 0x000DD0D6, 1, 83), (20, 0x000DD0DE, 1, 84),
    (21, 0x00188A56, 1, 85), (21, 0x0018BA4D, 1, 86), (21, 0x0018BE4E, 1, 87), (21, 0x0018BE4F, 1, 88),
    (21, 0x001AA96E, 1, 89), (21, 0x001BA12E, 1, 90), (21, 0x001BA12F, 1, 91), (21, 0x001BA1AF, 1, 92),
    (21, 0x001BA1BF, 1, 93), (22, 0x0037435D, 1, 99), (22, 0x0037437D, 1, 100), (22, 0x00317498, 1, 94),
    (22, 0x0035529C, 1, 95), (22, 0x0035529D, 1, 96), (22, 0x003552DE, 1, 97), (22, 0x003552DF, 1, 98),
    (23, 0x0062E933, 1, 102), (23, 0x0062295D, 1, 101), (23, 0x006AA53D, 1, 103), (23, 0x006AA53F, 1, 105),
    (23, 0x006AA53E, 1, 104), (23, 0x006E86B9, 1, 106), (23, 0x006E86F8, 1, 107), (24, 0x00D54A79, 1, 111),
    (24, 0x00C5D265, 1, 109), (24, 0x00C452B8, 1, 108), (24, 0x00DD0D71, 1, 113), (24, 0x00D54A78, 1, 110),
    (24, 0x00DD0D70, 1, 112), (24, 0x00DD0DF2, 1, 114), (24, 0x00DD0DF3, 1, 115), (25, 0x0188A5F6, 1, 225),
    (25, 0x0188A5F5, 1, 189), (25, 0x0188A5F4, 1, 188), (25, 0x0188A5F3, 1, 203), (25, 0x0188A5F2, 1, 202),
    (25, 0x0188A5F1, 1, 197), (25, 0x0188A5F0, 1, 207), (25, 0x0188A5EF, 1, 169), (25, 0x0188A5EE, 1, 223),
    (25, 0x0188A5ED, 1, 159), (25, 0x0188A5AA, 1, 235), (25, 0x0188A5E3, 1, 152), (25, 0x0188A5DF, 1, 192),
    (25, 0x0188A589, 1, 179), (25, 0x0188A5DD, 1, 201), (25, 0x0188A578, 1, 172), (25, 0x0188A5E0, 1, 149),
    (25, 0x0188A588, 1, 178), (25, 0x0188A5D6, 1, 120), (25, 0x0188A5DB, 1, 219), (25, 0x0188A5E1, 1, 150),
    (25, 0x0188A587, 1, 127), (25, 0x0188A59A, 1, 211), (25, 0x0188A5C4, 1, 125), (25, 0x0188A5EC, 1, 158),
    (25, 0x0188A586, 1, 247), (25, 0x0188A573, 1, 238), (25, 0x0188A59C, 1, 163), (25, 0x0188A5C8, 1, 228),
    (25, 0x0188A5FB, 1, 183), (25, 0x0188A5A1, 1, 217), (25, 0x0188A5EB, 1, 168), (25, 0x0188A5A8, 1, 122),
    (25, 0x0188A584, 1, 128), (25, 0x0188A5D2, 1, 249), (25, 0x0188A599, 1, 187), (25, 0x0188A598, 1, 186),
    (25, 0x0188A583, 1, 136), (25, 0x018BA4C9, 1, 181), (25, 0x0188A5D0, 1, 255), (25, 0x0188A594, 1, 230),
    (25, 0x0188A582, 1, 135), (25, 0x0188A5CB, 1, 233), (25, 0x0188A5D8, 1, 222), (25, 0x0188A5E7, 1, 145),
    (25, 0x0188A581, 1, 134), (25, 0x0188A5EA, 1, 167), (25, 0x0188A5A9, 1, 248), (25, 0x0188A5A6, 1, 209),
    (25, 0x0188A580, 1, 243), (25, 0x0188A5A0, 1, 216), (25, 0x0188A59D, 1, 164), (25, 0x0188A5C3, 1, 140),
    (25, 0x0188A57F, 1, 157), (25, 0x0188A5C0, 1, 239), (25, 0x0188A5DE, 1, 191), (25, 0x0188A5D4, 1, 251),
    (25, 0x0188A57E, 1, 156), (25, 0x0188A5C2, 1, 139), (25, 0x0188A592, 1, 242), (25, 0x0188A5CD, 1, 133),
    (25, 0x0188A57D, 1, 162), (25, 0x0188A5A3, 1, 213), (25, 0x0188A5E8, 1, 165), (25, 0x0188A5A2, 1, 212),
    (25, 0x0188A57C, 1, 227), (25, 0x0188A58E, 1, 198), (25, 0x0188A5B3, 1, 236), (25, 0x0188A5B2, 1, 234),
    (25, 0x0188A5B1, 1, 117), (25, 0x0188A5B0, 1, 215), (25, 0x0188A5AF, 1, 124), (25, 0x0188A5AE, 1, 123),
    (25, 0x0188A5AD, 1, 254), (25, 0x0188A5AC, 1, 253), (25, 0x0188A5AB, 1, 148), (25, 0x0188A5DA, 1, 218),
    (25, 0x0188A5E4, 1, 146), (25, 0x0188A5E5, 1, 147), (25, 0x0188A5D9, 1, 224), (25, 0x0188A5B5, 1, 143),
    (25, 0x0188A5BC, 1, 184), (25, 0x0188A5BD, 1, 185), (25, 0x0188A5E9, 1, 166), (25, 0x0188A5CC, 1, 132),
    (25, 0x0188A585, 1, 129), (25, 0x0188A5D3, 1, 250), (25, 0x0188A5E2, 1, 151), (25, 0x0188A595, 1, 119),
    (25, 0x0188A596, 1, 193), (25, 0x0188A5B8, 1, 176), (25, 0x0188A590, 1, 245), (25, 0x0188A5C9, 1, 229),
    (25, 0x0188A5A4, 1, 206), (25, 0x0188A5E6, 1, 144), (25, 0x0188A5A5, 1, 208), (25, 0x0188A5CE, 1, 137),
    (25, 0x0188A5BF, 1, 241), (25, 0x0188A572, 1, 237), (25, 0x0188A59B, 1, 190), (25, 0x0188A5BE, 1, 240),
    (25, 0x0188A5C7, 1, 131), (25, 0x0188A5CA, 1, 232), (25, 0x0188A5D5, 1, 252), (25, 0x0188A57B, 1, 171),
    (25, 0x0188A58D, 1, 205), (25, 0x0188A58C, 1, 204), (25, 0x0188A58B, 1, 118), (25, 0x0188A58A, 1, 214),
    (25, 0x018BA4C8, 1, 180), (25, 0x0188A5C5, 1, 126), (25, 0x0188A5FA, 1, 182), (25, 0x0188A5BB, 1, 175),
    (25, 0x0188A5C1, 1, 141), (25, 0x0188A5CF, 1, 138), (25, 0x0188A5B9, 1, 177), (25, 0x0188A5B6, 1, 153),
    (25, 0x0188A597, 1, 194), (25, 0x0188A5FE, 1, 160), (25, 0x0188A5D7, 1, 121), (25, 0x0188A5BA, 1, 174),
    (25, 0x0188A591, 1, 246), (25, 0x0188A5C6, 1, 130), (25, 0x0188A5DC, 1, 200), (25, 0x0188A57A, 1, 170),
    (25, 0x0188A59F, 1, 221), (25, 0x0188A5F9, 1, 196), (25, 0x0188A5B4, 1, 142), (25, 0x0188A5A7, 1, 210),
    (25, 0x0188A58F, 1, 199), (25, 0x0188A5FD, 1, 155), (25, 0x0188A5B7, 1, 154), (25, 0x0188A593, 1, 244),
    (25, 0x0188A59E, 1, 220), (25, 0x0188A5F8, 1, 195), (25, 0x0188A5FF, 1, 161), (25, 0x0188A5FC, 1, 231),
    (25, 0x0188A579, 1, 173), (25, 0x0188A5F7, 1, 226), (26, 0x03114BA2, 1, 116), (26, 0x03114BA3, 0, 1),
];

/// Codes looked up by their first `LOOKUP_BITS` bits: the first code of at
/// most that length they begin with, in codebook order, or `NO_CODE`.
const LOOKUP_BITS: u32 = 12;
const NO_CODE: u16 = u16::MAX;

/// The longest code: what a search that matches none has read.
const LONGEST: u32 = CODEBOOK[CODEBOOK.len() - 1].0 as u32;

struct Codes {
    lookup: Vec<u16>,
    /// The first code longer than the lookup's bits.
    long: usize,
}

fn codes() -> &'static Codes {
    static CODES: OnceLock<Codes> = OnceLock::new();
    CODES.get_or_init(|| {
        let mut lookup = vec![NO_CODE; 1 << LOOKUP_BITS];
        let mut long = CODEBOOK.len();
        for (i, &(size, bits, _, _)) in CODEBOOK.iter().enumerate() {
            let size = size as u32;
            if size > LOOKUP_BITS {
                long = long.min(i);
                continue;
            }
            let shift = LOOKUP_BITS - size;
            for slot in &mut lookup[(bits << shift) as usize..((bits + 1) << shift) as usize] {
                if *slot == NO_CODE {
                    *slot = i as u16;
                }
            }
        }
        Codes { lookup, long }
    })
}

impl Codes {
    /// The entry whose code the next bits begin with: the shortest, and of
    /// those the first in the codebook, as a search of it in order finds.
    #[inline]
    fn find(&self, next: u32) -> Option<usize> {
        let i = self.lookup[(next >> (32 - LOOKUP_BITS)) as usize];
        if i != NO_CODE {
            return Some(i as usize);
        }
        CODEBOOK[self.long..]
            .iter()
            .position(|&(size, bits, _, _)| next >> (32 - size as u32) == bits)
            .map(|i| i + self.long)
    }

    /// A run length and value, without a sign.
    fn run_value(&self, bits: &mut Bits) -> Result<(u32, i32), Error> {
        let Some(i) = self.find(bits.peek()) else {
            bits.get(LONGEST);
            return Err(Error::Corrupt("a VC-5 code not in the codebook"));
        };
        let (size, _, count, value) = CODEBOOK[i];
        bits.get(size as u32);
        Ok((count, value))
    }

    /// A run length and signed value: a value other than zero is followed
    /// by its sign bit, one for negative.
    #[inline]
    fn signed_run(&self, bits: &mut Bits) -> Result<(u32, i32), Error> {
        let next = bits.peek();
        let Some(i) = self.find(next) else {
            bits.get(LONGEST);
            return Err(Error::Corrupt("a VC-5 code not in the codebook"));
        };
        let (size, _, count, value) = CODEBOOK[i];
        let size = size as u32;
        if value == 0 {
            bits.get(size);
            return Ok((count, 0));
        }
        // The longest code and its sign are within the 32 bits looked at.
        let negative = (next >> (31 - size)) & 1 == 1;
        bits.get(size + 1);
        Ok((count, if negative { -value } else { value }))
    }
}

/// One wavelet of a channel: four bands of `width` by `height`, which of
/// them are decoded, and the highpass bands' quantization.
struct Wavelet {
    width: usize,
    height: usize,
    mask: u32,
    quant: [i32; 4],
    data: Vec<i16>,
}

impl Wavelet {
    /// None when either dimension is zero, which no band can be.
    fn new(width: usize, height: usize) -> Result<Option<Wavelet>, Error> {
        if width == 0 || height == 0 {
            return Ok(None);
        }
        let data = memory::vector(4 * width * height, 0i16, "VC-5 wavelet")?;
        Ok(Some(Wavelet { width, height, mask: 0, quant: [0; 4], data }))
    }

    fn band(&self, band: usize) -> &[i16] {
        let n = self.width * self.height;
        &self.data[band * n..(band + 1) * n]
    }

    fn band_mut(&mut self, band: usize) -> &mut [i16] {
        let n = self.width * self.height;
        &mut self.data[band * n..(band + 1) * n]
    }
}

struct Decoder<'a> {
    bits: Bits<'a>,
    expected_width: i64,
    expected_height: i64,
    // What the segments have said so far.
    channel_count: usize,
    channel_number: u16,
    subband_number: u16,
    image_width: u16,
    image_height: u16,
    image_format: i32,
    pattern_width: u16,
    pattern_height: u16,
    lowpass_precision: u32,
    quantization: u16,
    prescale: [u16; WAVELETS],
    /// The latest segment was a header parameter, or a codeblock.
    header: bool,
    codeblock: bool,
    header_mask: u16,
    header_finished: bool,
    allocated: bool,
    transform: [[Option<Wavelet>; WAVELETS]; MAX_CHANNELS],
}

/// The codec's errors, in this crate's terms.
const SYNTAX: Error = Error::Corrupt("VC-5 bitstream syntax");
const DIMENSIONS: Error = Error::Corrupt("a VC-5 image size other than the file's");
const PATTERN: Error = Error::Corrupt("a VC-5 pattern other than 2x2");
const ENDS_EARLY: Error = Error::Corrupt("the VC-5 tile ends early");

impl<'a> Decoder<'a> {
    fn new(tile: &'a [u8], width: usize, height: usize) -> Self {
        Decoder {
            bits: Bits::new(tile),
            expected_width: width as i64,
            expected_height: height as i64,
            channel_count: 0,
            channel_number: 0,
            subband_number: 0,
            image_width: 0,
            image_height: 0,
            image_format: 0,
            pattern_width: 0,
            pattern_height: 0,
            lowpass_precision: 16,
            quantization: 0,
            prescale: [0; WAVELETS],
            header: false,
            codeblock: false,
            header_mask: 0,
            header_finished: false,
            allocated: false,
            transform: Default::default(),
        }
    }

    /// Reads segments until every channel's largest wavelet is complete.
    fn parse(&mut self) -> Result<(), Error> {
        let marker = (self.bits.get(16) << 16) | self.bits.get(16);
        if marker != START_MARKER {
            return Err(Error::Corrupt("no VC-5 start marker"));
        }
        loop {
            let tag = self.bits.get(16) as u16 as i16;
            let value = self.bits.get(16) as u16 as i16;
            // A stream that ran out decodes zeros, never the picture.
            if self.bits.overrun {
                return Err(ENDS_EARLY);
            }
            self.update(tag, value)?;
            if self.bits.overrun {
                return Err(ENDS_EARLY);
            }
            if self.complete() && !self.header {
                return Ok(());
            }
        }
    }

    fn complete(&self) -> bool {
        self.transform[..self.channel_count].iter().all(|t| t[0].as_ref().is_some_and(|w| w.mask == 0xF))
    }

    /// One segment, and whatever it brings with it.
    fn update(&mut self, tag: i16, value: i16) -> Result<(), Error> {
        self.header = false;
        self.codeblock = false;
        let mut optional = false;
        let mut tag = tag;
        if tag < 0 {
            tag = tag.wrapping_neg();
            optional = true;
        }
        let tag = tag as i32;
        let v = value as i32;
        let mut chunk_size = 0usize;
        match tag {
            CHANNEL_COUNT => {
                if !(0 < v && v <= MAX_CHANNELS as i32) {
                    return Err(SYNTAX);
                }
                self.channel_count = v as usize;
                self.header = true;
            }
            IMAGE_WIDTH => {
                if v as i64 != self.expected_width {
                    return Err(DIMENSIONS);
                }
                self.image_width = value as u16;
                self.header = true;
            }
            IMAGE_HEIGHT => {
                if v as i64 != self.expected_height {
                    return Err(DIMENSIONS);
                }
                self.image_height = value as u16;
                self.header = true;
            }
            SUBBAND_NUMBER => {
                if !(0..SUBBANDS as i32).contains(&v) {
                    return Err(SYNTAX);
                }
                self.subband_number = v as u16;
            }
            QUANTIZATION => self.quantization = value as u16,
            LOWPASS_PRECISION => {
                if !(8..=32).contains(&v) {
                    return Err(Error::Corrupt("a VC-5 lowpass precision out of range"));
                }
                self.lowpass_precision = v as u32;
            }
            CHANNEL_NUMBER => {
                if !(0..MAX_CHANNELS as i32).contains(&v) {
                    return Err(SYNTAX);
                }
                self.channel_number = v as u16;
            }
            // The component precision decodes nothing differently.
            BITS_PER_COMPONENT => {}
            PRESCALE_SHIFT => {
                for (i, p) in self.prescale.iter_mut().enumerate() {
                    *p = ((v >> (14 - 2 * i)) & 3) as u16;
                }
            }
            IMAGE_FORMAT => {
                self.image_format = v;
                self.header = true;
            }
            PATTERN_WIDTH | PATTERN_HEIGHT => {
                if v != 2 {
                    return Err(PATTERN);
                }
                if tag == PATTERN_WIDTH {
                    self.pattern_width = 2;
                } else {
                    self.pattern_height = 2;
                }
                self.header = true;
            }
            COMPONENTS_PER_SAMPLE | MAX_BITS_PER_COMPONENT => self.header = true,
            // The image format sets the channel sizes; they are not coded.
            CHANNEL_WIDTH | CHANNEL_HEIGHT => return Err(SYNTAX),
            _ => {
                if tag & (SMALL_CHUNK | LARGE_CHUNK) != 0 {
                    chunk_size = (v & 0xFFFF) as usize;
                    if tag & LARGE_CHUNK != 0 {
                        chunk_size += ((tag & 0xFF) as usize) << 16;
                    }
                }
                if tag & LARGE_CODEBLOCK == LARGE_CODEBLOCK {
                    self.codeblock = true;
                } else if tag == UNIQUE_IMAGE_IDENTIFIER {
                    if !optional {
                        return Err(SYNTAX);
                    }
                    self.unique_identifier(chunk_size)?;
                } else if tag == INVERSE_TRANSFORM || tag == INVERSE_PERMUTATION {
                    if optional {
                        return Err(SYNTAX);
                    }
                    self.component_chunk(chunk_size, tag == INVERSE_TRANSFORM)?;
                } else if tag == INVERSE_TRANSFORM_16 {
                    return Err(Error::Unsupported("a VC-5 16-bit inverse component transform"));
                } else {
                    // Any other large chunk is read into, as if not there.
                    if tag & LARGE_CHUNK != 0 {
                        optional = true;
                        chunk_size = 0;
                    }
                    if !optional {
                        return Err(SYNTAX);
                    }
                    if chunk_size > 0 {
                        let end = self.bits.pos + 4 * chunk_size;
                        if end > self.bits.data.len() {
                            self.bits.overrun = true;
                        }
                        self.bits.pos = end;
                    }
                }
            }
        }

        if self.header {
            // An optional header parameter is taken as it stands.
            if !optional {
                if self.header_finished {
                    return Err(SYNTAX);
                }
                let mask = header_mask(tag);
                if self.header_mask & mask != 0 {
                    return Err(Error::Corrupt("a VC-5 header parameter given twice"));
                }
                self.header_mask |= mask;
            }
        } else if !self.header_finished {
            self.header_finished = true;
        }

        // The wavelets are sized once the header is done.
        if self.header_finished && !self.allocated {
            self.allocate()?;
            self.allocated = true;
        }

        if self.codeblock {
            let channel = self.channel_number as usize;
            if channel >= self.channel_count {
                return Err(SYNTAX);
            }
            let subband = self.subband_number as usize;
            let result = self.decode_subband(channel, subband);
            self.subband_number += 1;
            if self.subband_number == SUBBANDS {
                self.channel_number += 1;
                self.subband_number = 0;
            }
            return result;
        }
        Ok(())
    }

    /// The unique image identifier: a UMID label, its length and instance
    /// number, the image sequence's identifier and the image's number.
    fn unique_identifier(&mut self, chunk_size: usize) -> Result<(), Error> {
        const LABEL: [u8; 12] = [0x06, 0x0A, 0x2B, 0x34, 0x01, 0x01, 0x01, 0x05, 0x01, 0x01, 0x01, 0x20];
        if chunk_size != 9 {
            return Err(SYNTAX);
        }
        let mut label = [0u8; 12];
        for b in &mut label {
            *b = self.bits.get(8) as u8;
        }
        if label != LABEL {
            return Err(Error::Corrupt("a VC-5 unique image identifier without its label"));
        }
        if self.bits.get(8) != 0x13 || self.bits.get(24) != 0 {
            return Err(SYNTAX);
        }
        for _ in 0..16 {
            self.bits.get(8);
        }
        self.bits.get(32);
        Ok(())
    }

    /// The inverse component transform or permutation, which a raw image
    /// decodes without: read past, with the padding to the chunk's end.
    fn component_chunk(&mut self, chunk_size: usize, transform: bool) -> Result<(), Error> {
        let components = self.pattern_width as usize * self.pattern_height as usize + 2;
        let used = if transform { (components + 2) * components } else { components };
        for _ in 0..used {
            self.bits.get(8);
        }
        // The padding is read in one go, its bit count in a byte.
        let padding = (chunk_size * 4).wrapping_sub(used) as i32;
        let count = (8 * padding) as u8 as u32;
        if count > 32 {
            return Err(Error::Unsupported("a VC-5 component chunk of this size"));
        }
        self.bits.get(count);
        Ok(())
    }

    /// Every channel's three wavelets, from the image's size and format.
    fn allocate(&mut self) -> Result<(), Error> {
        for channel in 0..self.channel_count {
            if self.image_width == 0 || self.image_height == 0 {
                return Err(DIMENSIONS);
            }
            if self.pattern_width == 0 || self.pattern_height == 0 {
                return Err(PATTERN);
            }
            if self.image_format != IMAGE_FORMAT_RAW {
                return Err(Error::Unsupported("a VC-5 image format other than raw"));
            }
            let (mut w, mut h) = (self.image_width as usize / 2, self.image_height as usize / 2);
            for i in 0..WAVELETS {
                (w, h) = (w.div_ceil(2), h.div_ceil(2));
                self.transform[channel][i] = Wavelet::new(w, h)?;
            }
        }
        Ok(())
    }

    /// One codeblock: a subband of the current channel, and the inverse of
    /// its wavelet once all four of that wavelet's bands are in.
    fn decode_subband(&mut self, channel: usize, subband: usize) -> Result<(), Error> {
        let index = SUBBAND_WAVELET[subband];
        let band = SUBBAND_BAND[subband];
        let precision = self.lowpass_precision;
        let quantization = self.quantization as i32;
        let bits = &mut self.bits;
        let Some(wavelet) = self.transform[channel][index].as_mut() else {
            return Err(Error::Corrupt("a VC-5 band of a wavelet never sized"));
        };
        let mut result = if subband > 0 {
            let result = highpass(bits, wavelet.band_mut(band));
            if result.is_ok() {
                wavelet.mask |= 1 << band;
            }
            wavelet.quant[band] = quantization;
            result
        } else {
            for v in wavelet.band_mut(0) {
                *v = bits.get(precision) as i16;
            }
            bits.align_segment();
            wavelet.mask |= 1;
            Ok(())
        };
        if wavelet.mask == 0xF {
            result = self.reconstruct(channel, index);
        }
        result
    }

    /// The lowpass band of the next larger wavelet, from this one.
    fn reconstruct(&mut self, channel: usize, index: usize) -> Result<(), Error> {
        if index == 0 {
            return Ok(());
        }
        let prescale = self.prescale[index];
        let (lower, upper) = self.transform[channel].split_at_mut(index);
        let (Some(output), Some(input)) = (lower[index - 1].as_mut(), upper[0].as_ref()) else {
            return Err(Error::Corrupt("a VC-5 wavelet never sized"));
        };
        let (ow, oh) = (output.width, output.height);
        invert_into(input, prescale, output.band_mut(0), ow, oh)?;
        output.mask |= 1;
        Ok(())
    }

    /// The image: each channel's largest wavelet inverted into its
    /// component array, rows at a time, and the four recombined into the
    /// Bayer samples.
    fn finish(self, rggb: bool) -> Result<Vec<u16>, Error> {
        if self.channel_count != MAX_CHANNELS {
            return Err(Error::Unsupported("a VC-5 image of other than four channels"));
        }
        let (width, height) = (self.image_width as usize, self.image_height as usize);
        if width % 2 != 0 || height % 2 != 0 {
            return Err(Error::Unsupported("a VC-5 image of odd size"));
        }
        let (cw, ch) = (width / 2, height / 2);
        let mut bands = Vec::with_capacity(MAX_CHANNELS);
        for t in &self.transform {
            let w = t[0].as_ref().ok_or(Error::Corrupt("a VC-5 wavelet never sized"))?;
            bands.push(Bands::new(w, cw, ch)?);
        }
        let prescale = self.prescale[0];
        // The log curve's 16 bits, down to the sensor's.
        let shift = if rggb { 16 - 14 } else { 16 - 12 };
        let curve = log_curve();
        let iw = bands[0].width;
        let mut out = memory::vector(width * height, 0u16, "VC-5 image")?;
        // Each input row makes two component rows, so four image rows.
        out.par_chunks_mut(4 * width * BLOCK).enumerate().for_each(|(k, chunk)| {
            let mut scratch: Vec<Scratch> = (0..MAX_CHANNELS).map(|_| Scratch::new(iw)).collect();
            let mut rows = vec![[vec![0i16; cw], vec![0i16; cw]]; MAX_CHANNELS];
            for (j, quad) in chunk.chunks_mut(4 * width).enumerate() {
                let r = k * BLOCK + j;
                let both = quad.len() == 4 * width;
                for c in 0..MAX_CHANNELS {
                    let s = &mut scratch[c];
                    vertical(&bands[c], r, s);
                    let [even, odd] = &mut rows[c];
                    horizontal(&s.low[0], &s.high[0], even, prescale);
                    if both {
                        horizontal(&s.low[1], &s.high[1], odd, prescale);
                    }
                }
                for (i, pair) in quad.chunks_mut(2 * width).enumerate() {
                    let row = |c: usize| &rows[c][i][..];
                    pack(row(0), row(1), row(2), row(3), pair, rggb, shift, curve);
                }
            }
        });
        Ok(out)
    }
}

/// Input rows each parallel task inverts.
const BLOCK: usize = 8;

/// A highpass band: runs and values to its end, then the band end code,
/// aligned as the band trailer is.
fn highpass(bits: &mut Bits, data: &mut [i16]) -> Result<(), Error> {
    let codes = codes();
    bits.align_segment();
    let mut at = 0;
    while at < data.len() {
        let (count, value) = codes.signed_run(bits)?;
        let count = count as usize;
        if count > data.len() - at {
            return Err(Error::Corrupt("a VC-5 run past the end of its band"));
        }
        data[at..at + count].fill(value as i16);
        at += count;
        if bits.overrun {
            return Err(ENDS_EARLY);
        }
    }
    let (count, value) = codes.run_value(bits)?;
    if !(count == 0 || value == 1) {
        return Err(Error::Corrupt("a VC-5 band without its end code"));
    }
    bits.align_word();
    bits.align_segment();
    Ok(())
}

/// A highpass band's values expanded and dequantized: a table for the
/// magnitudes the codebook codes, the formula beyond them.
struct Dequant {
    table: [i16; 511],
    quant: i32,
}

impl Dequant {
    fn new(quant: i32) -> Self {
        let mut table = [0i16; 511];
        for (i, t) in table.iter_mut().enumerate() {
            *t = dequantize(i as i32 - 255, quant);
        }
        Dequant { table, quant }
    }

    #[inline]
    fn row(&self, src: &[i16], dst: &mut [i16]) {
        for (d, &s) in dst.iter_mut().zip(src) {
            let i = s as i32 + 255;
            *d = if (0..511).contains(&i) { self.table[i as usize] } else { dequantize(s as i32, self.quant) };
        }
    }
}

/// The cubic companding curve undone, f(x) = x + x^3 * 768 / 255^3 in
/// magnitude, then the quantization.
fn dequantize(value: i32, quant: i32) -> i16 {
    let magnitude = value.abs();
    let mut cubic = magnitude as f64;
    cubic *= magnitude as f64;
    cubic *= magnitude as f64;
    cubic *= 768.0;
    cubic /= (255 * 255 * 255) as f64;
    let magnitude = magnitude + cubic as i32;
    let value = match value.signum() {
        1 => quant.wrapping_mul(magnitude),
        -1 => quant.wrapping_mul(magnitude).wrapping_neg(),
        _ => 0,
    };
    clamp_pixel(value)
}

#[inline]
fn clamp_pixel(v: i32) -> i16 {
    v.clamp(i16::MIN as i32, i16::MAX as i32) as i16
}

/// A wavelet's bands as its inverse reads them.
struct Bands<'a> {
    ll: &'a [i16],
    lh: &'a [i16],
    hl: &'a [i16],
    hh: &'a [i16],
    width: usize,
    height: usize,
    dequant: [Dequant; 3],
}

impl<'a> Bands<'a> {
    /// Checked against the size of what it inverts into: the filters read
    /// three rows and columns at the borders.
    fn new(w: &'a Wavelet, out_width: usize, out_height: usize) -> Result<Self, Error> {
        if w.width < 3 || w.height < 3 {
            return Err(Error::Unsupported("a VC-5 image this small"));
        }
        if out_width.div_ceil(2) != w.width || out_height.div_ceil(2) != w.height {
            return Err(Error::Corrupt("VC-5 wavelets of mismatched sizes"));
        }
        Ok(Bands {
            ll: w.band(0),
            lh: w.band(1),
            hl: w.band(2),
            hh: w.band(3),
            width: w.width,
            height: w.height,
            dequant: [Dequant::new(w.quant[1]), Dequant::new(w.quant[2]), Dequant::new(w.quant[3])],
        })
    }
}

/// One task's rows: three dequantized rows of the first highpass band, one
/// each of the other two, and the vertical inverse's even and odd rows of
/// lowpass and highpass results.
struct Scratch {
    lh: [Vec<i16>; 3],
    hl: Vec<i16>,
    hh: Vec<i16>,
    low: [Vec<i16>; 2],
    high: [Vec<i16>; 2],
}

impl Scratch {
    fn new(width: usize) -> Self {
        let row = || vec![0i16; width];
        Scratch { lh: [row(), row(), row()], hl: row(), hh: row(), low: [row(), row()], high: [row(), row()] }
    }
}

/// The inverse wavelet into the lowpass band of the next larger wavelet,
/// `ow` by `oh`, two output rows to an input row.
fn invert_into(input: &Wavelet, prescale: u16, out: &mut [i16], ow: usize, oh: usize) -> Result<(), Error> {
    let bands = Bands::new(input, ow, oh)?;
    let iw = bands.width;
    out[..ow * oh].par_chunks_mut(2 * ow * BLOCK).enumerate().for_each(|(k, chunk)| {
        let mut s = Scratch::new(iw);
        for (j, pair) in chunk.chunks_mut(2 * ow).enumerate() {
            vertical(&bands, k * BLOCK + j, &mut s);
            let (even, odd) = pair.split_at_mut(ow);
            horizontal(&s.low[0], &s.high[0], even, prescale);
            if !odd.is_empty() {
                horizontal(&s.low[1], &s.high[1], odd, prescale);
            }
        }
    });
    Ok(())
}

/// The vertical inverse for input row `r`: the lowpass and first highpass
/// bands filtered down their columns (border filters on the first and
/// last rows), the second and third highpass bands added and subtracted.
fn vertical(b: &Bands, r: usize, s: &mut Scratch) {
    let w = b.width;
    let last = b.height - 1;
    fn row(band: &[i16], w: usize, i: usize) -> &[i16] {
        &band[i * w..(i + 1) * w]
    }
    // The three rows filtered, top to bottom.
    let rows = if r == 0 {
        [0, 1, 2]
    } else if r == last {
        [last - 2, last - 1, last]
    } else {
        [r - 1, r, r + 1]
    };
    let [lq, hlq, hhq] = &b.dequant;
    for (line, &i) in s.lh.iter_mut().zip(&rows) {
        lq.row(row(b.lh, w, i), line);
    }
    hlq.row(row(b.hl, w, r), &mut s.hl);
    hhq.row(row(b.hh, w, r), &mut s.hh);
    let (l0, l1, l2) = (row(b.ll, w, rows[0]), row(b.ll, w, rows[1]), row(b.ll, w, rows[2]));
    let [h0, h1, h2] = &s.lh;
    let [even_low, odd_low] = &mut s.low;
    let [even_high, odd_high] = &mut s.high;
    let pair = |a0: i32, a1: i32, a2: i32, high: i32| -> (i16, i16) {
        let (even, odd) = if r == 0 {
            (((11 * a0 - 4 * a1 + a2 + 4) >> 3) + high, ((5 * a0 + 4 * a1 - a2 + 4) >> 3) - high)
        } else if r == last {
            (((5 * a2 + 4 * a1 - a0 + 4) >> 3) + high, ((11 * a2 - 4 * a1 + a0 + 4) >> 3) - high)
        } else {
            (((a0 - a2 + 4) >> 3) + a1 + high, ((a2 - a0 + 4) >> 3) + a1 - high)
        };
        (clamp_pixel(even >> 1), clamp_pixel(odd >> 1))
    };
    for c in 0..w {
        (even_low[c], odd_low[c]) = pair(l0[c] as i32, l1[c] as i32, l2[c] as i32, s.hl[c] as i32);
        (even_high[c], odd_high[c]) = pair(h0[c] as i32, h1[c] as i32, h2[c] as i32, s.hh[c] as i32);
    }
}

/// The horizontal inverse of one row of lowpass and highpass results into
/// `out`, whose width may be one short of twice theirs. A prescale above
/// one undoes the encoder's scaling (a shift of one for a prescale of
/// two) and keeps signed 16-bit values; otherwise the results are halved
/// and clipped to 14 bits.
fn horizontal(low: &[i16], high: &[i16], out: &mut [i16], prescale: u16) {
    if prescale > 1 {
        horizontal_with::<true>(low, high, out, if prescale == 2 { 1 } else { 0 });
    } else {
        horizontal_with::<false>(low, high, out, 0);
    }
}

#[inline(always)]
fn horizontal_with<const DESCALE: bool>(low: &[i16], high: &[i16], out: &mut [i16], shift: u32) {
    let finish = |v: i32| -> i16 {
        if DESCALE {
            clamp_pixel(v << shift)
        } else {
            (v >> 1).clamp(0, (1 << 14) - 1) as i16
        }
    };
    let w = low.len();
    let last = w - 1;
    let l = |i: usize| low[i] as i32;
    let h = |i: usize| high[i] as i32;
    out[0] = finish(((11 * l(0) - 4 * l(1) + l(2) + 4) >> 3) + h(0));
    out[1] = finish(((5 * l(0) + 4 * l(1) - l(2) + 4) >> 3) - h(0));
    let (body, _) = out[2..].split_at_mut(2 * (last - 1));
    for (c, o) in (1..last).zip(body.chunks_exact_mut(2)) {
        let (prev, here, next) = (l(c - 1), l(c), l(c + 1));
        o[0] = finish(((prev - next + 4) >> 3) + here + h(c));
        o[1] = finish(((next - prev + 4) >> 3) + here - h(c));
    }
    out[2 * last] = finish(((5 * l(last) + 4 * l(last - 1) - l(last - 2) + 4) >> 3) + h(last));
    if 2 * last + 1 < out.len() {
        out[2 * last + 1] = finish(((11 * l(last) - 4 * l(last - 1) + l(last - 2) + 4) >> 3) - h(last));
    }
}

/// One row of 2x2 Bayer quads, two image rows, from a row of each
/// component: the green sum, red and blue less green, and the green
/// difference, the last three about 2048. The inverse wavelet's values are
/// read as the unsigned components they encode.
#[allow(clippy::too_many_arguments)]
fn pack(gs: &[i16], rg: &[i16], bg: &[i16], gd: &[i16], out: &mut [u16], rggb: bool, shift: u32, curve: &[u16; 4096]) {
    let width = out.len() / 2;
    let (top, bottom) = out.split_at_mut(width);
    let clip = |v: i32| v.clamp(0, 4095) as usize;
    for (x, (t, b)) in top.chunks_exact_mut(2).zip(bottom.chunks_exact_mut(2)).enumerate() {
        let s = gs[x] as u16 as i32;
        let r = rg[x] as u16 as i32 - 2048;
        let bl = bg[x] as u16 as i32 - 2048;
        let d = gd[x] as u16 as i32 - 2048;
        let red = curve[clip(2 * r + s)] >> shift;
        let blue = curve[clip(2 * bl + s)] >> shift;
        let g1 = curve[clip(s + d)] >> shift;
        let g2 = curve[clip(s - d)] >> shift;
        if rggb {
            (t[0], t[1], b[0], b[1]) = (red, g1, g2, blue);
        } else {
            (t[0], t[1], b[0], b[1]) = (g1, blue, red, g2);
        }
    }
}

/// GoPro's log curve from 12-bit coded values to 16-bit linear ones,
/// 65535 (113^(x/4095) - 1) / 112, computed in double precision and
/// rounded to single before it is truncated, as GoPro's decoder fills it.
fn log_curve() -> &'static [u16; 4096] {
    static CURVE: OnceLock<[u16; 4096]> = OnceLock::new();
    CURVE.get_or_init(|| {
        let mut curve = [0u16; 4096];
        for (i, c) in curve.iter_mut().enumerate() {
            let input = i as f32;
            let output = (65535.0 * (113.0f64.powf(input as f64 / 4095.0) - 1.0) / 112.0) as f32;
            *c = (output as i32).min(65535) as u16;
        }
        curve
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A header in big-endian tag and value pairs after the marker.
    fn header(w: u16, h: u16) -> Vec<u8> {
        let mut v = b"VC-5".to_vec();
        for (tag, value) in [(12u16, 4u16), (20, w), (21, h), (84, 4), (106, 2), (107, 2), (108, 1)] {
            v.extend_from_slice(&tag.to_be_bytes());
            v.extend_from_slice(&value.to_be_bytes());
        }
        v.resize(4096, 0);
        v
    }

    #[test]
    fn a_tile_that_is_no_vc5_stream_is_an_error() {
        let mut seed = 7u32;
        let junk: Vec<u8> = (0..4096)
            .map(|_| {
                seed = seed.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
                (seed >> 24) as u8
            })
            .collect();
        for tile in [&b""[..], b"\0", b"VC-5", &junk[..16], &junk[..]] {
            assert!(decode(tile, 64, 64, true).is_err(), "{} bytes", tile.len());
        }
        // A header and nothing after it: the stream runs out.
        assert!(decode(&header(64, 64)[..32], 64, 64, true).is_err());
        assert!(decode(&header(64, 64), 64, 64, false).is_err());
    }

    #[test]
    fn a_header_naming_another_size_is_refused() {
        for (w, h) in [(0xFFFF, 64), (64, 0xFFFF), (66, 64), (64, 62)] {
            assert!(matches!(decode(&header(w, h), 64, 64, true), Err(e) if e.to_string().contains("size other")), "{w}x{h}");
        }
    }

    #[test]
    fn the_codebook_runs_shortest_first() {
        assert!(CODEBOOK.windows(2).all(|p| p[0].0 <= p[1].0));
        assert!(CODEBOOK.iter().all(|&(size, bits, _, _)| bits >> size == 0));
    }
}
