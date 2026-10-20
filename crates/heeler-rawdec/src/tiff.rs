//! TIFF 6.0 directories, as DNG and most raw containers use them: the
//! header, IFD0's chain, every SubIFD and the EXIF directory, and typed
//! reads of an entry's values. Every read is bounds-checked; a value
//! that does not fit the file reads as absent.

#[derive(Clone, Copy)]
pub struct Tiff<'a> {
    d: &'a [u8],
    le: bool,
}

/// One directory entry: its tag, type, count and where its values start
/// (inside the entry when they fit in four bytes, else at the offset the
/// entry holds).
#[derive(Clone, Copy, Debug)]
pub struct Entry {
    pub tag: u16,
    pub typ: u16,
    pub count: u32,
    at: usize,
}

#[derive(Clone, Debug, Default)]
pub struct Ifd {
    /// Where the directory starts in the file.
    pub offset: usize,
    entries: Vec<Entry>,
}

impl Entry {
    /// Where the entry's values start in the file.
    pub fn offset(&self) -> usize {
        self.at
    }
}

impl Ifd {
    pub fn get(&self, tag: u16) -> Option<Entry> {
        self.entries.iter().find(|e| e.tag == tag).copied()
    }
}

/// The size of one value of a TIFF field type, 0 for a type it does not
/// define.
fn type_size(typ: u16) -> usize {
    match typ {
        1 | 2 | 6 | 7 => 1,
        3 | 8 => 2,
        4 | 9 | 11 | 13 => 4,
        5 | 10 | 12 => 8,
        _ => 0,
    }
}

/// The deepest SubIFD nesting followed and the most directories read: a
/// loop in a damaged file ends here.
const MAX_DEPTH: u32 = 4;
const MAX_IFDS: usize = 128;

impl<'a> Tiff<'a> {
    /// The file's byte order from its header, or None when it is not
    /// TIFF-shaped (II or MM, then 42).
    pub fn new(d: &'a [u8]) -> Option<Self> {
        let le = match d.get(..2)? {
            b"II" => true,
            b"MM" => false,
            _ => return None,
        };
        let t = Tiff { d, le };
        (t.u16(2)? == 42).then_some(t)
    }

    pub fn data(&self) -> &'a [u8] {
        self.d
    }

    pub fn u16(&self, at: usize) -> Option<u16> {
        let b = self.d.get(at..at.checked_add(2)?)?;
        Some(if self.le { u16::from_le_bytes([b[0], b[1]]) } else { u16::from_be_bytes([b[0], b[1]]) })
    }

    pub fn u32(&self, at: usize) -> Option<u32> {
        let b = self.d.get(at..at.checked_add(4)?)?;
        let b = [b[0], b[1], b[2], b[3]];
        Some(if self.le { u32::from_le_bytes(b) } else { u32::from_be_bytes(b) })
    }

    /// The directory at `at` and the offset of the next one in its chain.
    pub fn ifd(&self, at: usize) -> Option<(Ifd, usize)> {
        let n = self.u16(at)? as usize;
        let mut entries = Vec::with_capacity(n);
        for i in 0..n {
            let e = at + 2 + i * 12;
            let (tag, typ, count) = (self.u16(e)?, self.u16(e + 2)?, self.u32(e + 4)?);
            let size = type_size(typ).checked_mul(count as usize)?;
            let at = if size <= 4 { e + 8 } else { self.u32(e + 8)? as usize };
            entries.push(Entry { tag, typ, count, at });
        }
        Some((Ifd { offset: at, entries }, self.u32(at + 2 + n * 12).unwrap_or(0) as usize))
    }

    /// IFD0's chain, then each directory's SubIFDs (330) and EXIF
    /// directory (34665), depth first, each directory once.
    pub fn ifds(&self) -> Vec<Ifd> {
        let mut out = Vec::new();
        let mut seen = std::collections::HashSet::new();
        let mut todo: Vec<(usize, u32)> = self.u32(4).map(|o| vec![(o as usize, 0)]).unwrap_or_default();
        while let Some((at, depth)) = todo.pop() {
            if at < 8 || depth > MAX_DEPTH || out.len() >= MAX_IFDS || !seen.insert(at) {
                continue;
            }
            let Some((ifd, next)) = self.ifd(at) else { continue };
            // The chain's next directory after this one's children.
            todo.push((next, depth));
            for tag in [34665u16, 330] {
                if let Some(e) = ifd.get(tag) {
                    for o in self.uints(&e).unwrap_or_default().into_iter().rev() {
                        todo.push((o as usize, depth + 1));
                    }
                }
            }
            out.push(ifd);
        }
        out
    }

    /// The bytes an entry's values occupy.
    pub fn bytes(&self, e: &Entry) -> Option<&'a [u8]> {
        let size = type_size(e.typ).checked_mul(e.count as usize)?;
        self.d.get(e.at..e.at.checked_add(size)?)
    }

    /// An entry's BYTE, SHORT or LONG (or IFD) values.
    pub fn uints(&self, e: &Entry) -> Option<Vec<u32>> {
        let b = self.bytes(e)?;
        let n = e.count as usize;
        match e.typ {
            1 | 7 => Some(b.iter().map(|&v| v as u32).collect()),
            3 => (0..n).map(|i| self.u16(e.at + i * 2).map(u32::from)).collect(),
            4 | 13 => (0..n).map(|i| self.u32(e.at + i * 4)).collect(),
            _ => None,
        }
    }

    pub fn uint(&self, e: &Entry) -> Option<u32> {
        self.uints(e)?.first().copied()
    }

    /// An entry's values of any numeric type as f64: integers, signed
    /// integers, rationals and floats.
    pub fn reals(&self, e: &Entry) -> Option<Vec<f64>> {
        self.bytes(e)?;
        let n = e.count as usize;
        let at = e.at;
        (0..n)
            .map(|i| match e.typ {
                1 | 7 => self.d.get(at + i).map(|&v| v as f64),
                6 => self.d.get(at + i).map(|&v| v as i8 as f64),
                3 => self.u16(at + i * 2).map(|v| v as f64),
                8 => self.u16(at + i * 2).map(|v| v as i16 as f64),
                4 | 13 => self.u32(at + i * 4).map(|v| v as f64),
                9 => self.u32(at + i * 4).map(|v| v as i32 as f64),
                5 => Some(self.u32(at + i * 8)? as f64 / self.u32(at + i * 8 + 4)? as f64),
                10 => Some(self.u32(at + i * 8)? as i32 as f64 / self.u32(at + i * 8 + 4)? as i32 as f64),
                11 => self.u32(at + i * 4).map(|v| f32::from_bits(v) as f64),
                12 => {
                    let (a, b) = (self.u32(at + i * 8)? as u64, self.u32(at + i * 8 + 4)? as u64);
                    Some(f64::from_bits(if self.le { b << 32 | a } else { a << 32 | b }))
                }
                _ => None,
            })
            .collect()
    }

    /// An ASCII entry, up to its first NUL, trimmed.
    pub fn ascii(&self, e: &Entry) -> Option<String> {
        let b = self.bytes(e)?;
        let end = b.iter().position(|&c| c == 0).unwrap_or(b.len());
        Some(String::from_utf8_lossy(&b[..end]).trim().to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A little-endian TIFF with one directory holding the given entries
    /// (values of four bytes or fewer only).
    fn tiny(entries: &[(u16, u16, u32, [u8; 4])]) -> Vec<u8> {
        let mut d = b"II*\0".to_vec();
        d.extend_from_slice(&8u32.to_le_bytes());
        d.extend_from_slice(&(entries.len() as u16).to_le_bytes());
        for (tag, typ, count, v) in entries {
            d.extend_from_slice(&tag.to_le_bytes());
            d.extend_from_slice(&typ.to_le_bytes());
            d.extend_from_slice(&count.to_le_bytes());
            d.extend_from_slice(v);
        }
        d.extend_from_slice(&0u32.to_le_bytes());
        d
    }

    #[test]
    fn reads_short_and_long_values_in_place() {
        let d = tiny(&[(256, 4, 1, 6000u32.to_le_bytes()), (258, 3, 2, [12, 0, 14, 0])]);
        let t = Tiff::new(&d).unwrap();
        let ifds = t.ifds();
        assert_eq!(ifds.len(), 1);
        assert_eq!(t.uint(&ifds[0].get(256).unwrap()), Some(6000));
        assert_eq!(t.uints(&ifds[0].get(258).unwrap()), Some(vec![12, 14]));
    }

    #[test]
    fn a_value_past_the_end_reads_as_absent() {
        let d = tiny(&[(273, 4, 4, 4000u32.to_le_bytes())]);
        let t = Tiff::new(&d).unwrap();
        assert_eq!(t.uints(&t.ifds()[0].get(273).unwrap()), None);
    }

    #[test]
    fn a_directory_that_points_at_itself_is_read_once() {
        let mut d = tiny(&[(256, 4, 1, 1u32.to_le_bytes())]);
        let n = d.len();
        d[n - 4..].copy_from_slice(&8u32.to_le_bytes());
        assert_eq!(Tiff::new(&d).unwrap().ifds().len(), 1);
    }

    #[test]
    fn not_a_tiff() {
        assert!(Tiff::new(b"\xff\xd8\xff\xe0").is_none());
        assert!(Tiff::new(b"II").is_none());
    }
}
