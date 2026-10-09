//! What the camera wrote down.
//!
//! "Metadata, we need metadata support. To be able to access
//! metadata from the source files and display it to the user."
//!
//! Original code, no third-party EXIF crate. There is already a TIFF
//! directory walker in this crate for finding embedded previews, and EXIF
//! is a TIFF directory: the same handful of primitives read both, and one
//! fewer dependency is one fewer license to think about.
//!
//! Two containers carry it. A TIFF-based file (DNG, NEF, ARW, CR2, and
//! plain TIFF) opens with the TIFF header itself. A JPEG carries the whole
//! TIFF stream inside an APP1 segment, offsets and all, so once the
//! segment is found the reading is identical. CR3 is ISO-BMFF: Canon
//! parks the same TIFF streams inside a uuid box in `moov` (CMT1 holds
//! IFD0, CMT2 the Exif directory), so reading it is a box walk followed
//! by the same TIFF reader as everything else.
//!
//! Everything is optional. A file with no EXIF at all is normal (a
//! scanned negative, a render, a screenshot), and the honest answer is an
//! empty record rather than a pile of zeroes that look like readings.

/// One rational, kept as it was written.
///
/// Not divided out on the way in: a shutter speed is 1/250, and a camera
/// says so with a numerator of 1 and a denominator of 250. Turning that
/// into 0.004 and back again is how you end up displaying 1/249.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Ratio {
    pub num: i64,
    pub den: i64,
}

impl Ratio {
    pub fn value(self) -> f64 {
        if self.den == 0 {
            0.0
        } else {
            self.num as f64 / self.den as f64
        }
    }
}

/// What the camera recorded, as far as it can be read.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Exif {
    pub rendered_bake: bool,
    pub original_raw_file_name: Option<String>,
    pub make: Option<String>,
    pub model: Option<String>,
    pub lens: Option<String>,
    /// as written: "2024:03:11 17:42:08"
    pub shot_at: Option<String>,
    pub iso: Option<u32>,
    pub aperture: Option<Ratio>,
    pub shutter: Option<Ratio>,
    pub focal_length: Option<Ratio>,
    /// the 35mm equivalent, when the camera bothered to work it out
    pub focal_35: Option<u32>,
    pub exposure_bias: Option<Ratio>,
    /// 1 to 8, the TIFF orientation
    pub orientation: Option<u16>,
    pub width: Option<u32>,
    pub height: Option<u32>,
    /// Panasonic's sensor crop borders [top, left, bottom, right]: the
    /// only frame size an RW2 declares (it carries no standard width or
    /// height tag at all). Raw as read; judged for plausibility by the
    /// caller, because these tag numbers are unassigned in a plain TIFF
    /// and could be anything in another maker's file.
    pub sensor_borders: Option<[u32; 4]>,
    pub artist: Option<String>,
    pub copyright: Option<String>,
}

impl Exif {
    /// Whether anything at all was found. An empty record is a real
    /// answer, and the panel says "no camera data" rather than showing
    /// twelve blank rows.
    pub fn is_empty(&self) -> bool {
        *self == Exif::default()
    }

    /// The camera, as one line. "NIKON CORPORATION" + "NIKON Z 7" is how
    /// the file puts it and not how anybody says it.
    pub fn camera(&self) -> Option<String> {
        match (&self.make, &self.model) {
            (Some(make), Some(model)) => {
                let make = make.trim();
                let model = model.trim();
                // Most makers repeat themselves in the model field.
                if model.to_ascii_lowercase().starts_with(&first_word(make).to_ascii_lowercase()) {
                    Some(model.to_string())
                } else {
                    Some(format!("{make} {model}"))
                }
            }
            (None, Some(model)) => Some(model.trim().to_string()),
            (Some(make), None) => Some(make.trim().to_string()),
            (None, None) => None,
        }
    }
}

fn first_word(s: &str) -> &str {
    s.split_whitespace().next().unwrap_or(s)
}

/// A shutter speed the way a photographer says it.
pub fn format_shutter(r: Ratio) -> String {
    let v = r.value();
    if v <= 0.0 {
        return String::new();
    }
    if v >= 1.0 {
        // Whole seconds keep the decimal only when it earns it.
        if (v - v.round()).abs() < 0.05 {
            format!("{}s", v.round() as i64)
        } else {
            format!("{v:.1}s")
        }
    } else {
        format!("1/{}", (1.0 / v).round() as i64)
    }
}

/// f/2.8, and never f/2.80.
pub fn format_aperture(r: Ratio) -> String {
    let v = r.value();
    if v <= 0.0 {
        return String::new();
    }
    if (v * 10.0).round() % 10.0 == 0.0 {
        format!("f/{}", v.round() as i64)
    } else {
        format!("f/{v:.1}")
    }
}

pub fn format_focal(r: Ratio) -> String {
    let v = r.value();
    if v <= 0.0 {
        return String::new();
    }
    format!("{} mm", v.round() as i64)
}

/// Exposure compensation, which needs its sign shown even when positive.
pub fn format_bias(r: Ratio) -> String {
    let v = r.value();
    if v.abs() < 0.005 {
        return "0 EV".into();
    }
    format!("{v:+.1} EV")
}

// Field types.
pub(crate) const BYTE: u16 = 1;
pub(crate) const ASCII: u16 = 2;
pub(crate) const SHORT: u16 = 3;
pub(crate) const LONG: u16 = 4;
pub(crate) const RATIONAL: u16 = 5;
pub(crate) const UNDEFINED: u16 = 7;
pub(crate) const SLONG: u16 = 9;
pub(crate) const SRATIONAL: u16 = 10;

// --- writing -----------------------------------------------------------
//
// "Metadata is not being preserved. This should be an option
// for users." Exports used to carry nothing but the encoder's bare JFIF
// header, which is where a photograph goes to become "JFIFVersion 1.02,
// X-Resolution 1 dpi". The writer below rebuilds a clean EXIF block from
// the parsed record rather than copying the source's APP1 wholesale: the
// original block drags along a stale embedded thumbnail, maker notes
// with absolute offsets, and an orientation flag describing a rotation
// the render has already baked in.

/// One directory entry. pub(crate) so the TIFF export writer in bake.rs
/// can lay the same Exif directory down inside a TIFF file: the record a
/// camera made is the same record whatever container carries it.
pub(crate) struct Entry {
    pub(crate) tag: u16,
    pub(crate) kind: u16,
    pub(crate) count: u32,
    pub(crate) payload: Vec<u8>,
}

fn w_ascii(tag: u16, text: &str) -> Entry {
    let mut payload = text.as_bytes().to_vec();
    payload.push(0);
    Entry { tag, kind: ASCII, count: payload.len() as u32, payload }
}

fn w_short(tag: u16, v: u16) -> Entry {
    Entry { tag, kind: SHORT, count: 1, payload: v.to_le_bytes().to_vec() }
}

fn w_long(tag: u16, v: u32) -> Entry {
    Entry { tag, kind: LONG, count: 1, payload: v.to_le_bytes().to_vec() }
}

fn w_ratio(tag: u16, r: Ratio) -> Entry {
    let mut payload = (r.num.clamp(0, u32::MAX as i64) as u32).to_le_bytes().to_vec();
    payload.extend_from_slice(&(r.den.clamp(0, u32::MAX as i64) as u32).to_le_bytes());
    Entry { tag, kind: RATIONAL, count: 1, payload }
}

fn w_sratio(tag: u16, r: Ratio) -> Entry {
    let mut payload = (r.num.clamp(i32::MIN as i64, i32::MAX as i64) as i32)
        .to_le_bytes()
        .to_vec();
    payload
        .extend_from_slice(&(r.den.clamp(i32::MIN as i64, i32::MAX as i64) as i32).to_le_bytes());
    Entry { tag, kind: SRATIONAL, count: 1, payload }
}

/// One directory: count, sorted entries, next-IFD 0, out-of-line values
/// appended to `values` with offsets measured from the TIFF origin.
pub(crate) fn write_dir(mut entries: Vec<Entry>, values_at: usize, values: &mut Vec<u8>) -> Vec<u8> {
    entries.sort_by_key(|e| e.tag);
    let mut out = Vec::new();
    out.extend_from_slice(&(entries.len() as u16).to_le_bytes());
    for e in &entries {
        out.extend_from_slice(&e.tag.to_le_bytes());
        out.extend_from_slice(&e.kind.to_le_bytes());
        out.extend_from_slice(&e.count.to_le_bytes());
        if e.payload.len() <= 4 {
            let mut inline = e.payload.clone();
            inline.resize(4, 0);
            out.extend_from_slice(&inline);
        } else {
            out.extend_from_slice(&((values_at + values.len()) as u32).to_le_bytes());
            values.extend_from_slice(&e.payload);
            if values.len() & 1 == 1 {
                values.push(0);
            }
        }
    }
    out.extend_from_slice(&0u32.to_le_bytes());
    out
}

/// Dimensions and print resolution of the rendered file, after orientation and resize.
#[derive(Clone, Copy)]
pub struct ExifExportOptions {
    pub width: u32,
    pub height: u32,
    pub dpi: u32,
}

/// The camera's record as a fresh little-endian TIFF stream, the form
/// both a JPEG APP1 body (after "Exif\0\0") and a PNG eXIf chunk carry.
///
/// `width`/`height` are the EXPORT's pixels, not the source's, and
/// orientation is written as 1: the render already stands upright.
pub fn write_exif_tiff(exif: &Exif, options: ExifExportOptions) -> Vec<u8> {
    let ExifExportOptions { width, height, dpi } = options;
    let dpi = crate::resolution::clamp_dpi(dpi);
    let mut ifd0: Vec<Entry> = Vec::new();
    if let Some(v) = &exif.make {
        ifd0.push(w_ascii(0x010f, v));
    }
    if let Some(v) = &exif.model {
        ifd0.push(w_ascii(0x0110, v));
    }
    ifd0.push(w_short(0x0112, 1)); // orientation: already applied
    ifd0.push(w_ratio(0x011a, Ratio { num: dpi as i64, den: 1 })); // XResolution
    ifd0.push(w_ratio(0x011b, Ratio { num: dpi as i64, den: 1 })); // YResolution
    ifd0.push(w_short(0x0128, 2)); // ResolutionUnit: inch
    ifd0.push(w_ascii(0x0131, "Heeler")); // Software
    if let Some(v) = &exif.shot_at {
        ifd0.push(w_ascii(0x0132, v));
    }
    if let Some(v) = &exif.artist {
        ifd0.push(w_ascii(0x013b, v));
    }
    if let Some(v) = &exif.copyright {
        ifd0.push(w_ascii(0x8298, v));
    }

    let sub = exif_sub_entries(exif, width, height);

    // Layout: header, IFD0 (with the Exif pointer), Exif IFD, values.
    let dir_len = |n: usize| 2 + n * 12 + 4;
    let ifd0_at = 8usize;
    let exif_at = ifd0_at + dir_len(ifd0.len() + 1);
    let values_at = exif_at + dir_len(sub.len());
    ifd0.push(w_long(0x8769, exif_at as u32));

    let mut values = Vec::new();
    let dir0 = write_dir(ifd0, values_at, &mut values);
    // Both directories share one value region; dir0's values are already
    // in `values`, so the sub-directory's offsets continue after them.
    let dir1 = write_dir(sub, values_at, &mut values);

    let mut out = Vec::with_capacity(values_at + values.len());
    out.extend_from_slice(b"II");
    out.extend_from_slice(&42u16.to_le_bytes());
    out.extend_from_slice(&(ifd0_at as u32).to_le_bytes());
    out.extend_from_slice(&dir0);
    out.extend_from_slice(&dir1);
    out.extend_from_slice(&values);
    out
}

/// The Exif directory itself (shutter, aperture, ISO and friends), as
/// entries any TIFF-layout writer can place. `width`/`height` are the
/// pixels of the file being written. Split out of write_exif_tiff so the
/// 16-bit TIFF export carries the identical record as a real in-file Exif
/// directory instead of not carrying one at all.
pub(crate) fn exif_sub_entries(exif: &Exif, width: u32, height: u32) -> Vec<Entry> {
    let mut sub: Vec<Entry> = Vec::new();
    if let Some(v) = exif.shutter {
        sub.push(w_ratio(0x829a, v));
    }
    if let Some(v) = exif.aperture {
        sub.push(w_ratio(0x829d, v));
    }
    if let Some(v) = exif.iso {
        sub.push(w_short(0x8827, v.min(u16::MAX as u32) as u16));
    }
    if let Some(v) = &exif.shot_at {
        sub.push(w_ascii(0x9003, v));
    }
    if let Some(v) = exif.exposure_bias {
        sub.push(w_sratio(0x9204, v));
    }
    if let Some(v) = exif.focal_length {
        sub.push(w_ratio(0x920a, v));
    }
    sub.push(w_long(0xa002, width)); // PixelXDimension
    sub.push(w_long(0xa003, height)); // PixelYDimension
    if let Some(v) = exif.focal_35 {
        sub.push(w_short(0xa405, v.min(u16::MAX as u32) as u16));
    }
    if let Some(v) = &exif.lens {
        sub.push(w_ascii(0xa434, v));
    }
    sub
}

fn type_size(kind: u16) -> usize {
    match kind {
        BYTE | ASCII | UNDEFINED | 6 => 1,
        // 8 is SSHORT, which maker notes use for angles; 11 and 12 the
        // floats, which the listing reads and nothing here ever did.
        SHORT | 8 => 2,
        LONG | SLONG | 11 => 4,
        RATIONAL | SRATIONAL | 12 => 8,
        _ => 0,
    }
}

pub(crate) struct Tiff<'a> {
    pub(crate) bytes: &'a [u8],
    pub(crate) little: bool,
}

impl<'a> Tiff<'a> {
    pub(crate) fn u16_at(&self, at: usize) -> Option<u16> {
        let b = self.bytes.get(at..at + 2)?;
        Some(if self.little {
            u16::from_le_bytes([b[0], b[1]])
        } else {
            u16::from_be_bytes([b[0], b[1]])
        })
    }

    pub(crate) fn u32_at(&self, at: usize) -> Option<u32> {
        let b = self.bytes.get(at..at + 4)?;
        let a = [b[0], b[1], b[2], b[3]];
        Some(if self.little { u32::from_le_bytes(a) } else { u32::from_be_bytes(a) })
    }

    pub(crate) fn i32_at(&self, at: usize) -> Option<i32> {
        self.u32_at(at).map(|v| v as i32)
    }

    /// Where an entry's value actually lives: inline when it fits in the
    /// four bytes of the entry, out of line otherwise.
    pub(crate) fn value_at(&self, entry: usize, kind: u16, count: u32) -> Option<usize> {
        let bytes = type_size(kind).checked_mul(count as usize)?;
        if bytes == 0 {
            return None;
        }
        if bytes <= 4 {
            Some(entry + 8)
        } else {
            self.u32_at(entry + 8).map(|v| v as usize)
        }
    }

    pub(crate) fn ascii(&self, entry: usize, kind: u16, count: u32) -> Option<String> {
        if kind != ASCII || count == 0 {
            return None;
        }
        let at = self.value_at(entry, kind, count)?;
        let raw = self.bytes.get(at..at + count as usize)?;
        let end = raw.iter().position(|&b| b == 0).unwrap_or(raw.len());
        let text = String::from_utf8_lossy(&raw[..end]).trim().to_string();
        if text.is_empty() {
            None
        } else {
            Some(text)
        }
    }

    pub(crate) fn integer(&self, entry: usize, kind: u16, count: u32) -> Option<u32> {
        let at = self.value_at(entry, kind, count)?;
        match kind {
            SHORT => self.u16_at(at).map(u32::from),
            LONG => self.u32_at(at),
            BYTE => self.bytes.get(at).map(|&b| u32::from(b)),
            _ => None,
        }
    }

    pub(crate) fn ratio(&self, entry: usize, kind: u16, count: u32) -> Option<Ratio> {
        if kind != RATIONAL && kind != SRATIONAL {
            return None;
        }
        let at = self.value_at(entry, kind, count)?;
        if kind == SRATIONAL {
            Some(Ratio { num: self.i32_at(at)? as i64, den: self.i32_at(at + 4)? as i64 })
        } else {
            Some(Ratio { num: self.u32_at(at)? as i64, den: self.u32_at(at + 4)? as i64 })
        }
    }
}

/// Reads one directory into `out`, returning any sub-directory pointers
/// worth following.
fn read_ifd(t: &Tiff, ifd: usize, out: &mut Exif) -> Vec<usize> {
    let mut follow = Vec::new();
    let Some(count) = t.u16_at(ifd) else { return follow };
    // A corrupt directory can claim tens of thousands of entries; a real
    // one has dozens.
    for i in 0..count.min(512) as usize {
        let e = ifd + 2 + i * 12;
        let (Some(tag), Some(kind), Some(n)) = (t.u16_at(e), t.u16_at(e + 2), t.u32_at(e + 4))
        else {
            continue;
        };
        match tag {
            // A rendered bake says so twice: its Software tag, which other
            // programs often rewrite when they save a file, and its XMP
            // (RENDERED_XMP), which they keep. Either one is enough.
            305 => out.rendered_bake |= t.ascii(e, kind, n).as_deref() == Some("Heeler Rendered Bake"),
            TAG_XMP => {
                let packet = t.value_at(e, kind, n).and_then(|at| t.bytes.get(at..at.checked_add(n as usize)?));
                out.rendered_bake |= packet.is_some_and(|p| p.windows(RENDERED_XMP.len()).any(|w| w == RENDERED_XMP.as_bytes()));
            }
            50827 => out.original_raw_file_name = t.ascii(e, kind, n),
            0x010f => out.make = t.ascii(e, kind, n).or(out.make.take()),
            0x0110 => out.model = t.ascii(e, kind, n).or(out.model.take()),
            0x0112 => out.orientation = t.integer(e, kind, n).map(|v| v as u16).or(out.orientation),
            0x0132 | 0x9003 => {
                // DateTime is when the file was written; DateTimeOriginal
                // is when the shutter fired. The second one wins, and it
                // is read second in tag order.
                if let Some(v) = t.ascii(e, kind, n) {
                    out.shot_at = Some(v);
                }
            }
            0x013b => out.artist = t.ascii(e, kind, n).or(out.artist.take()),
            0x8298 => out.copyright = t.ascii(e, kind, n).or(out.copyright.take()),
            0x0100 | 0xa002 => out.width = t.integer(e, kind, n).or(out.width),
            0x0101 | 0xa003 => out.height = t.integer(e, kind, n).or(out.height),
            0x829a => out.shutter = t.ratio(e, kind, n).or(out.shutter),
            0x829d => out.aperture = t.ratio(e, kind, n).or(out.aperture),
            0x8827 => out.iso = t.integer(e, kind, n).or(out.iso),
            // Panasonic's own ISO tag, in the RW2's first directory. Only
            // used when the standard one is absent, since 0x0017 is
            // unassigned in a plain TIFF and could be anything at all in
            // another maker's file.
            0x0017 => {
                if out.iso.is_none() {
                    out.iso = t.integer(e, kind, n).filter(|v| (25..=1_000_000).contains(v));
                }
            }
            // Panasonic's sensor crop borders, the RW2's only statement
            // of frame size. Same caution as the ISO tag above: stored
            // raw, trusted only as a last resort by source_dimensions.
            0x0004..=0x0007 => {
                if let Some(v) = t.integer(e, kind, n) {
                    let b = out.sensor_borders.get_or_insert([0; 4]);
                    b[(tag - 0x0004) as usize] = v;
                }
            }
            0x9204 => out.exposure_bias = t.ratio(e, kind, n).or(out.exposure_bias),
            0x920a => out.focal_length = t.ratio(e, kind, n).or(out.focal_length),
            0xa405 => out.focal_35 = t.integer(e, kind, n).or(out.focal_35),
            0xa434 | 0xfdea => {
                // "NO-LENS" is Panasonic's sentinel for unchipped glass,
                // not a name; keep whatever the MakerNote already gave.
                if let Some(v) = t.ascii(e, kind, n).filter(|v| v != "NO-LENS") {
                    out.lens = Some(v);
                }
            }
            // Panasonic's JpgFromRaw: the RW2 embeds a full JPEG, and on the owner's
            // bodies its Exif block is the ONLY place the MakerNote (and so the lens
            // name) is written; the outer directories carry neither. 0x2e is
            // unassigned in a plain TIFF, so the payload must actually be a JPEG
            // before it is trusted.
            0x002e => {
                if out.lens.is_none() {
                    if let Some(at) = t.value_at(e, kind, n) {
                        let end = (at + n as usize).min(t.bytes.len());
                        if let Some(jpeg) = t.bytes.get(at..end) {
                            if jpeg.starts_with(&[0xff, 0xd8, 0xff]) {
                                if let Some(p) =
                                    find(&jpeg[..jpeg.len().min(4096)], b"Exif\0\0")
                                {
                                    if let Some(inner) = read_tiff(&jpeg[p + 6..]) {
                                        out.lens = inner.lens;
                                    }
                                }
                            }
                        }
                    }
                }
            }
            // Panasonic's MakerNote. On the owner's bodies the lens name lives ONLY
            // here (tag 0x51): the standard LensModel tag is absent for the Sigma
            // 60-600 and "NO-LENS" for adapted glass. The note is a normal IFD with
            // private tag meanings, and its value offsets use the same TIFF base, so
            // the shared readers apply; only 0x51 is taken, nothing else trusted.
            0x927c => {
                if let Some(at) = t.value_at(e, kind, n) {
                    if t.bytes.get(at..at + 12) == Some(b"Panasonic\0\0\0".as_ref()) {
                        read_panasonic_note(t, at + 12, out);
                    }
                }
            }
            // The Exif and GPS sub-directories, and the SubIFDs a RAW
            // hangs its real image off.
            0x8769 | 0x014a => {
                if let Some(at) = t.value_at(e, kind, n) {
                    if kind == LONG && n == 1 {
                        if let Some(v) = t.u32_at(at) {
                            follow.push(v as usize);
                        }
                    } else if kind == LONG {
                        for k in 0..n.min(8) as usize {
                            if let Some(v) = t.u32_at(at + k * 4) {
                                follow.push(v as usize);
                            }
                        }
                    }
                }
            }
            _ => {}
        }
    }
    follow
}

/// First position of `needle` in `hay`, the str::find of byte slices.
fn find(hay: &[u8], needle: &[u8]) -> Option<usize> {
    hay.windows(needle.len()).position(|w| w == needle)
}

/// The Panasonic MakerNote directory: standard IFD layout, private tag
/// meanings, so nothing generic is read from it. Tag 0x51 is the lens
/// name, and it only fills in when no standard tag named one.
fn read_panasonic_note(t: &Tiff, ifd: usize, out: &mut Exif) {
    if out.lens.is_some() {
        return;
    }
    let Some(count) = t.u16_at(ifd) else { return };
    for i in 0..count.min(512) as usize {
        let e = ifd + 2 + i * 12;
        let (Some(tag), Some(kind), Some(n)) = (t.u16_at(e), t.u16_at(e + 2), t.u32_at(e + 4))
        else {
            continue;
        };
        if tag == 0x0051 {
            out.lens = t.ascii(e, kind, n).filter(|v| v != "NO-LENS");
            return;
        }
    }
}

/// Reads EXIF out of a TIFF stream that starts at `bytes[0]`.
fn read_tiff(bytes: &[u8]) -> Option<Exif> {
    let little = match bytes.get(0..2)? {
        b"II" => true,
        b"MM" => false,
        _ => return None,
    };
    let t = Tiff { bytes, little };
    // Any magic, not just 42.
    //
    // "it's not pulling any metadata from my .RW2 files."
    // Panasonic writes 0x55 where the spec says 42, and some Olympus
    // variants write something else again, and every one of them lays its
    // directories out exactly like a TIFF. Requiring 42 turned every RW2
    // away at the door.
    //
    // This crate already knew that: the orientation reader two hundred
    // lines up says so in a comment and has a test for it. I did not reuse
    // it, which is the whole of the bug.
    //
    // The offset is checked instead, which is the thing that actually has
    // to be true for any of this to be readable.
    let ifd0 = t.u32_at(4)? as usize;
    if ifd0 < 8 || ifd0 >= bytes.len() {
        return None;
    }
    let mut out = Exif::default();
    let mut queue = vec![ifd0];
    let mut seen = std::collections::HashSet::new();
    // Breadth-first over IFD0, its Exif sub-directory and any SubIFDs,
    // bounded because a malformed file can point a directory at itself.
    while let Some(ifd) = queue.pop() {
        if ifd == 0 || ifd >= bytes.len() || !seen.insert(ifd) || seen.len() > 16 {
            continue;
        }
        queue.extend(read_ifd(&t, ifd, &mut out));
    }
    Some(out)
}

/// Finds the TIFF stream inside a JPEG's APP1 segment.
fn jpeg_exif(bytes: &[u8]) -> Option<&[u8]> {
    if bytes.get(0..2)? != [0xFF, 0xD8] {
        return None;
    }
    let mut at = 2usize;
    // Walk the segment chain rather than scanning for "Exif": the string
    // can appear inside the image data of a file that has no EXIF at all.
    while at + 4 <= bytes.len() {
        if bytes[at] != 0xFF {
            return None;
        }
        let marker = bytes[at + 1];
        // Start of scan: everything after this is entropy-coded data.
        if marker == 0xDA || marker == 0xD9 {
            return None;
        }
        let len = u16::from_be_bytes([bytes[at + 2], bytes[at + 3]]) as usize;
        if len < 2 {
            return None;
        }
        let body = bytes.get(at + 4..at + 2 + len)?;
        if marker == 0xE1 && body.starts_with(b"Exif\0\0") {
            return body.get(6..);
        }
        at += 2 + len;
    }
    None
}

/// Finds the TIFF stream inside a PNG's eXIf chunk (PNG carries it bare,
/// without the JPEG's "Exif\0\0" prefix). Heeler writes this chunk on
/// export, so its own exports read back through the same panel.
pub(crate) fn png_exif(bytes: &[u8]) -> Option<&[u8]> {
    const SIG: [u8; 8] = [0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A];
    if bytes.get(0..8)? != SIG {
        return None;
    }
    let mut at = 8usize;
    while at + 8 <= bytes.len() {
        let len = u32::from_be_bytes(bytes.get(at..at + 4)?.try_into().ok()?) as usize;
        let kind = bytes.get(at + 4..at + 8)?;
        if kind == b"eXIf" {
            return bytes.get(at + 8..at + 8 + len);
        }
        if kind == b"IEND" {
            return None;
        }
        at += 12 + len; // length + type + data + crc
    }
    None
}

/// Everything the camera wrote, from a file's bytes.
///
/// Returns an empty record rather than an error when there is nothing to
/// read: a photograph with no EXIF is a photograph, not a failure. The
/// embedded JPEG inside a Fuji RAF, which is where Fuji parks the whole
/// EXIF record. RAF is its own container, not TIFF: sixteen ASCII bytes
/// of magic, version and serial strings, then a directory of offsets,
/// with the embedded JPEG's offset and length as big-endian u32s at 84
/// and 88. That JPEG is a complete file with an ordinary APP1, so the
/// JPEG walk takes it from there. "I have a RAF image open
/// and it's not reading the metadata."
pub(crate) fn raf_jpeg(bytes: &[u8]) -> Option<&[u8]> {
    if !bytes.starts_with(b"FUJIFILMCCD-RAW ") {
        return None;
    }
    let off = u32::from_be_bytes(bytes.get(84..88)?.try_into().ok()?) as usize;
    let len = u32::from_be_bytes(bytes.get(88..92)?.try_into().ok()?) as usize;
    // Clamped, not rejected, past the buffer: the metadata reader is
    // handed the file's head, and the EXIF sits in the JPEG's first
    // kilobytes; the same bargain the CR3 walk makes below.
    let end = off.checked_add(len)?.min(bytes.len());
    let slice = bytes.get(off..end)?;
    // A JPEG or nothing: a corrupt directory must not feed garbage on.
    slice.starts_with(&[0xFF, 0xD8]).then_some(slice)
}

/// Bumped whenever the reader learns to extract something it could not
/// before (a new tag, a new maker note, a new container). Caches that
/// store readings keep this number beside them and treat any record
/// written by an older reader as a miss, so a parser improvement
/// reaches files scanned before it. It has been needed twice already:
/// the CR3 fix left every CR3 serving cached emptiness, and the
/// Panasonic lens-name support left older records showing focal and
/// aperture with the lens fossilized at None ("Metadata is
/// not picking up the lens model"). Forgetting to bump this is how the
/// third one happens.
pub const EXIF_READER_VERSION: i64 = 1;

pub fn read_exif(bytes: &[u8]) -> Exif {
    if let Some(stream) = jpeg_exif(bytes) {
        if let Some(exif) = read_tiff(stream) {
            return exif;
        }
    }
    if let Some(jpeg) = raf_jpeg(bytes) {
        if let Some(exif) = jpeg_exif(jpeg).and_then(read_tiff) {
            return exif;
        }
    }
    if let Some(stream) = png_exif(bytes) {
        if let Some(exif) = read_tiff(stream) {
            return exif;
        }
    }
    if let Some(exif) = bmff_exif(bytes) {
        return exif;
    }
    read_tiff(bytes).unwrap_or_default()
}

/// A PNG's XMP packet, from its iTXt chunk keyed XML:com.adobe.xmp
/// (uncompressed, which is how every writer writes it).
pub(crate) fn png_xmp(bytes: &[u8]) -> Option<String> {
    if bytes.get(0..8)? != b"\x89PNG\r\n\x1a\n" {
        return None;
    }
    let mut at = 8usize;
    while at + 8 <= bytes.len() {
        let len = u32::from_be_bytes([bytes[at], bytes[at + 1], bytes[at + 2], bytes[at + 3]]) as usize;
        let kind = bytes.get(at + 4..at + 8)?;
        let data = bytes.get(at + 8..at + 8 + len)?;
        if kind == b"iTXt" && data.starts_with(b"XML:com.adobe.xmp\0") {
            // keyword NUL compression-flag compression-method language NUL translated NUL text
            let rest = data.get(b"XML:com.adobe.xmp\0".len()..)?;
            if rest.first() == Some(&0) {
                let rest = rest.get(2..)?;
                let lang_end = rest.iter().position(|&b| b == 0)?;
                let rest = &rest[lang_end + 1..];
                let tr_end = rest.iter().position(|&b| b == 0)?;
                return Some(String::from_utf8_lossy(&rest[tr_end + 1..]).into_owned());
            }
        }
        if kind == b"IEND" {
            break;
        }
        at += 12 + len;
    }
    None
}

/// Canon's metadata uuid inside a CR3's moov box.
const CANON_META_UUID: [u8; 16] = [
    0x85, 0xc0, 0xb6, 0x87, 0x82, 0x0f, 0x11, 0xe0, 0x81, 0x11, 0xf4, 0xce, 0x46, 0x2b, 0x6a, 0x48,
];

/// One ISO-BMFF box: (type, payload range), or None past the end.
///
/// Size 1 means a 64-bit largesize follows the type; size 0 means "to
/// the end of the enclosing box". Both occur in real CR3s: the mdat
/// holding the sensor data is routinely past 4GB on video-capable
/// bodies.
fn bmff_box(bytes: &[u8], at: usize) -> Option<(&[u8], std::ops::Range<usize>, usize)> {
    if at + 8 > bytes.len() {
        return None;
    }
    let size32 = u32::from_be_bytes(bytes[at..at + 4].try_into().ok()?) as u64;
    let kind = &bytes[at + 4..at + 8];
    let (payload_start, size) = if size32 == 1 {
        if at + 16 > bytes.len() {
            return None;
        }
        (at + 16, u64::from_be_bytes(bytes[at + 8..at + 16].try_into().ok()?))
    } else if size32 == 0 {
        (at + 8, (bytes.len() - at) as u64)
    } else {
        (at + 8, size32)
    };
    let end = at.checked_add(usize::try_from(size).ok()?)?;
    if end <= at {
        return None;
    }
    // Clamped, not rejected, when the box runs past the buffer. The
    // metadata reader is handed the file's first megabyte, and a CR3's
    // moov can declare more than that while keeping the CMT boxes in
    // its first few kilobytes; refusing the whole box for a tail we
    // never needed would refuse the metadata too. A payload cut short
    // is caught downstream: the TIFF reader checks every offset.
    let end = end.min(bytes.len());
    Some((kind, payload_start.min(end)..end, end))
}

/// EXIF out of a CR3 (or any BMFF file that parks TIFF the same way).
///
/// "the following are not loading metadata from .CR3 files."
/// The walk: moov, then Canon's uuid, then the CMT boxes, each of which
/// is a complete TIFF stream the ordinary reader takes from there. CMT1
/// is IFD0 (camera, orientation), CMT2 the Exif directory (exposure,
/// lens); both are read and merged because neither alone is the whole
/// record. The CMT boxes of a CR3, each a whole TIFF stream, for the
/// listing.
pub(crate) fn bmff_tiff_streams(bytes: &[u8]) -> Option<Vec<&[u8]>> {
    if bytes.get(4..8) != Some(b"ftyp") {
        return None;
    }
    let mut moov: Option<std::ops::Range<usize>> = None;
    let mut at = 0usize;
    while let Some((kind, payload, next)) = bmff_box(bytes, at) {
        if kind == b"moov" {
            moov = Some(payload);
            break;
        }
        at = next;
    }
    let moov = moov?;
    let mut meta: Option<std::ops::Range<usize>> = None;
    let mut at = moov.start;
    while at < moov.end {
        let Some((kind, payload, next)) = bmff_box(bytes, at) else { break };
        if kind == b"uuid" && bytes.get(payload.start..payload.start + 16) == Some(&CANON_META_UUID[..]) {
            meta = Some(payload.start + 16..payload.end);
            break;
        }
        at = next;
    }
    let meta = meta?;
    let mut out = Vec::new();
    let mut at = meta.start;
    while at < meta.end {
        let Some((kind, payload, next)) = bmff_box(bytes, at) else { break };
        if matches!(kind, b"CMT1" | b"CMT2" | b"CMT3" | b"CMT4") {
            out.push(&bytes[payload]);
        }
        at = next;
    }
    Some(out)
}

fn bmff_exif(bytes: &[u8]) -> Option<Exif> {
    // A BMFF file opens with an ftyp box; anything else is not one.
    if bytes.get(4..8) != Some(b"ftyp") {
        return None;
    }
    let mut moov: Option<std::ops::Range<usize>> = None;
    let mut at = 0usize;
    while let Some((kind, payload, next)) = bmff_box(bytes, at) {
        if kind == b"moov" {
            moov = Some(payload);
            break;
        }
        at = next;
    }
    let moov = moov?;
    // Canon's uuid box, inside moov.
    let mut meta: Option<std::ops::Range<usize>> = None;
    let mut at = moov.start;
    while at < moov.end {
        let Some((kind, payload, next)) = bmff_box(bytes, at) else { break };
        if kind == b"uuid"
            && bytes.get(payload.start..payload.start + 16) == Some(&CANON_META_UUID[..])
        {
            meta = Some(payload.start + 16..payload.end);
            break;
        }
        at = next;
    }
    let meta = meta?;
    // The CMT boxes: each payload is a full TIFF stream.
    let mut out = Exif::default();
    let mut found = false;
    let mut at = meta.start;
    while at < meta.end {
        let Some((kind, payload, next)) = bmff_box(bytes, at) else { break };
        if matches!(kind, b"CMT1" | b"CMT2" | b"CMT4") {
            if let Some(part) = read_tiff(&bytes[payload]) {
                merge_exif(&mut out, part);
                found = true;
            }
        }
        at = next;
    }
    found.then_some(out)
}

/// Fills the gaps in `into` from `from`, never overwriting a reading.
///
/// CMT1 and CMT2 split one record across two streams; read in order,
/// first answer wins, which keeps IFD0's orientation authoritative if a
/// later directory carries a copy.
fn merge_exif(into: &mut Exif, from: Exif) {
    macro_rules! take {
        ($field:ident) => {
            if into.$field.is_none() {
                into.$field = from.$field;
            }
        };
    }
    take!(make);
    take!(model);
    take!(lens);
    take!(shot_at);
    take!(iso);
    take!(aperture);
    take!(shutter);
    take!(focal_length);
    take!(focal_35);
    take!(exposure_bias);
    take!(orientation);
    take!(width);
    take!(height);
    take!(artist);
    take!(copyright);
}

/// Splices an EXIF APP1 into an encoded JPEG, right after SOI, ahead of
/// the encoder's JFIF APP0 (which is what cameras produce too). No-op on
/// anything that is not a JPEG.
pub fn embed_jpeg_exif(jpeg: &mut Vec<u8>, exif_tiff: &[u8]) {
    if jpeg.get(0..2) != Some(&[0xFF, 0xD8][..]) {
        return;
    }
    let mut seg = Vec::with_capacity(exif_tiff.len() + 10);
    seg.extend_from_slice(&[0xFF, 0xE1]);
    seg.extend_from_slice(&((exif_tiff.len() + 8) as u16).to_be_bytes());
    seg.extend_from_slice(b"Exif\0\0");
    seg.extend_from_slice(exif_tiff);
    // An APP1 body larger than a segment can hold would need chunking;
    // the minimal record written here is a few hundred bytes.
    if exif_tiff.len() + 8 > u16::MAX as usize {
        return;
    }
    jpeg.splice(2..2, seg);
}

/// A minimal XMP packet carrying the image's keywords as dc:subject,
/// the interop bag every DAM reads. Exports carry the catalog's tags
/// this way: EXIF has no standard keywords field worth the name, and
/// XMP-in-APP1 is where the catalog editors and file browsers all look.
pub fn xmp_keywords_packet(keywords: &[String]) -> String {
    XmpPacket { keywords, rating: None, derived_from: None, captured_at: None, rendered: false }.build()
}

/// The XMP property a rendered bake carries (2026-10-08: "Reset
/// should not set the tone profile active if the metadata in the XMP
/// says otherwise"): the picture is already rendered, so it opens with
/// the Tone Profile off. Read wherever a TIFF or DNG's XMP is (tag 700);
/// the Software tag says the same and is the older of the two.
pub const RENDERED_XMP: &str = "<heeler:Rendered>True</heeler:Rendered>";

/// Where IFD0's XMP packet (tag 700) lives: the offset and length of its
/// value, however far into the file that is. A listing reads only the
/// head of a DNG looking for the bake marker, and a metadata rewrite can
/// leave the directory entry in place while moving the value past what
/// was read; this says where the one follow-up read should look. Only
/// IFD0 is walked, because that is where the bake writers stamp it. Not
/// an Exif field: is_empty() compares the whole struct against default,
/// and a stray tag 700 must not make an otherwise empty reading look
/// full.
pub fn xmp_extent(bytes: &[u8]) -> Option<(usize, usize)> {
    let little = match bytes.get(0..2)? {
        b"II" => true,
        b"MM" => false,
        _ => return None,
    };
    let t = Tiff { bytes, little };
    let ifd0 = t.u32_at(4)? as usize;
    if ifd0 < 8 || ifd0 >= bytes.len() {
        return None;
    }
    let count = t.u16_at(ifd0)?.min(512) as usize;
    for i in 0..count {
        let e = ifd0 + 2 + i * 12;
        if t.u16_at(e) == Some(TAG_XMP) {
            let (Some(kind), Some(n)) = (t.u16_at(e + 2), t.u32_at(e + 4)) else {
                return None;
            };
            return Some((t.value_at(e, kind, n)?, n as usize));
        }
    }
    None
}

/// Shared export and bake packet. Origin fields are element text, never XML attributes.
pub struct XmpPacket<'a> {
    pub keywords: &'a [String],
    pub rating: Option<u8>,
    pub derived_from: Option<&'a str>,
    pub captured_at: Option<&'a str>,
    /// A rendered bake: writes RENDERED_XMP.
    pub rendered: bool,
}

impl XmpPacket<'_> {
    pub fn build(&self) -> String {
        let esc = |s: &str| s.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;");
        let items: String = self.keywords.iter().map(|k| format!("<rdf:li>{}</rdf:li>", esc(k))).collect();
        let rating = self.rating.map(|r| format!("<xmp:Rating>{}</xmp:Rating>", r.min(5))).unwrap_or_default();
        let origin = self.derived_from.map(|name| {
            let date = self.captured_at.map(|date| {
                // EXIF's local capture time has no timezone to invent.
                let date = date.replacen(':', "-", 2).replacen(' ', "T", 1);
                format!("<xmp:CreateDate>{}</xmp:CreateDate>", esc(&date))
            }).unwrap_or_default();
            format!("<xmpMM:DerivedFrom rdf:parseType=\"Resource\"><stRef:filePath>{}</stRef:filePath>{date}</xmpMM:DerivedFrom>", esc(name))
        }).unwrap_or_default();
        let rendered = if self.rendered { RENDERED_XMP } else { "" };
        format!(
            "<?xpacket begin=\"\u{feff}\" id=\"W5M0MpCehiHzreSzNTczkc9d\"?>\
             <x:xmpmeta xmlns:x=\"adobe:ns:meta/\">\
             <rdf:RDF xmlns:rdf=\"http://www.w3.org/1999/02/22-rdf-syntax-ns#\">\
             <rdf:Description rdf:about=\"\" xmlns:dc=\"http://purl.org/dc/elements/1.1/\" \
             xmlns:xmp=\"http://ns.adobe.com/xap/1.0/\" xmlns:xmpMM=\"http://ns.adobe.com/xap/1.0/mm/\" \
             xmlns:stRef=\"http://ns.adobe.com/xap/1.0/sType/ResourceRef#\" xmlns:heeler=\"https://heeler.app/ns/1.0/\">\
             <dc:subject><rdf:Bag>{items}</rdf:Bag></dc:subject>{rating}{origin}{rendered}\
             </rdf:Description></rdf:RDF></x:xmpmeta><?xpacket end=\"w\"?>"
        )
    }
}

/// Splices an XMP APP1 segment into an encoded JPEG, after whatever
/// APP1 is already there (EXIF first is the convention readers expect).
/// No-op on anything that is not a JPEG or a packet too big for one
/// segment.
pub fn embed_jpeg_xmp(jpeg: &mut Vec<u8>, xmp: &str) {
    if jpeg.get(0..2) != Some(&[0xFF, 0xD8][..]) {
        return;
    }
    const HEADER: &[u8] = b"http://ns.adobe.com/xap/1.0/\0";
    let body_len = HEADER.len() + xmp.len();
    if body_len + 2 > u16::MAX as usize {
        return;
    }
    let mut seg = Vec::with_capacity(body_len + 4);
    seg.extend_from_slice(&[0xFF, 0xE1]);
    seg.extend_from_slice(&((body_len + 2) as u16).to_be_bytes());
    seg.extend_from_slice(HEADER);
    seg.extend_from_slice(xmp.as_bytes());
    // After the EXIF APP1 when one exists, else right after SOI.
    let mut at = 2usize;
    while at + 4 <= jpeg.len() && jpeg[at] == 0xFF && jpeg[at + 1] == 0xE1 {
        let len = u16::from_be_bytes([jpeg[at + 2], jpeg[at + 3]]) as usize;
        at += 2 + len;
    }
    jpeg.splice(at..at, seg);
}

/// The same packet into a PNG, as the iTXt chunk XMP specifies
/// (keyword "XML:com.adobe.xmp", uncompressed), just before IEND.
pub fn embed_png_xmp(png: &mut Vec<u8>, xmp: &str) {
    const SIG: [u8; 8] = [0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A];
    if png.get(0..8) != Some(&SIG[..]) {
        return;
    }
    let mut body = Vec::new();
    body.extend_from_slice(b"XML:com.adobe.xmp\0");
    body.extend_from_slice(&[0, 0]); // uncompressed, method 0
    body.extend_from_slice(b"\0\0"); // no language, no translated keyword
    body.extend_from_slice(xmp.as_bytes());
    let mut at = 8usize;
    while at + 8 <= png.len() {
        let len = u32::from_be_bytes(png[at..at + 4].try_into().unwrap()) as usize;
        if &png[at + 4..at + 8] == b"IEND" {
            let mut chunk = Vec::with_capacity(body.len() + 12);
            chunk.extend_from_slice(&(body.len() as u32).to_be_bytes());
            chunk.extend_from_slice(b"iTXt");
            chunk.extend_from_slice(&body);
            let crc = png_crc(&chunk[4..]);
            chunk.extend_from_slice(&crc.to_be_bytes());
            png.splice(at..at, chunk);
            return;
        }
        at += 12 + len;
    }
}

/// An EXIF stream that says nothing but the resolution: for a container
/// with no other place to declare it (WebP, resolution.rs), and no camera
/// record to carry.
pub(crate) fn resolution_exif_tiff(dpi: u32) -> Vec<u8> {
    let ifd0 = vec![
        w_ratio(0x011a, Ratio { num: dpi as i64, den: 1 }), // XResolution
        w_ratio(0x011b, Ratio { num: dpi as i64, den: 1 }), // YResolution
        w_short(0x0128, 2),                                 // ResolutionUnit: inch
    ];
    let values_at = 8 + 2 + ifd0.len() * 12 + 4;
    let mut values = Vec::new();
    let dir = write_dir(ifd0, values_at, &mut values);
    let mut out = Vec::with_capacity(values_at + values.len());
    out.extend_from_slice(b"II");
    out.extend_from_slice(&42u16.to_le_bytes());
    out.extend_from_slice(&8u32.to_le_bytes());
    out.extend_from_slice(&dir);
    out.extend_from_slice(&values);
    out
}

/// CRC-32 as PNG defines it. Ten lines beat a dependency.
pub(crate) fn png_crc(data: &[u8]) -> u32 {
    let mut crc = 0xFFFF_FFFFu32;
    for &b in data {
        crc ^= b as u32;
        for _ in 0..8 {
            crc = if crc & 1 != 0 { (crc >> 1) ^ 0xEDB8_8320 } else { crc >> 1 };
        }
    }
    !crc
}

/// Splices an eXIf chunk into an encoded PNG, just before IEND. No-op on
/// anything that is not a PNG.
pub fn embed_png_exif(png: &mut Vec<u8>, exif_tiff: &[u8]) {
    const SIG: [u8; 8] = [0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A];
    if png.get(0..8) != Some(&SIG[..]) {
        return;
    }
    // Find IEND by walking chunks, the same way the reader does.
    let mut at = 8usize;
    while at + 8 <= png.len() {
        let len = u32::from_be_bytes(png[at..at + 4].try_into().unwrap()) as usize;
        if &png[at + 4..at + 8] == b"IEND" {
            let mut chunk = Vec::with_capacity(exif_tiff.len() + 12);
            chunk.extend_from_slice(&(exif_tiff.len() as u32).to_be_bytes());
            chunk.extend_from_slice(b"eXIf");
            chunk.extend_from_slice(exif_tiff);
            let crc = png_crc(&chunk[4..]);
            chunk.extend_from_slice(&crc.to_be_bytes());
            png.splice(at..at, chunk);
            return;
        }
        at += 12 + len;
    }
}

/// The XMP tag a TIFF container carries in IFD0, where every reader
/// looks for it. The bake writers stamp it at encode time, so the
/// directory keeps its place at the head of the file.
pub(crate) const TAG_XMP: u16 = 700;

#[cfg(test)]
mod tests {
    use super::*;

    /// The catalog's tags ride into exports as XMP dc:subject, in a
    /// segment other tools actually read, and the file stays decodable.
    /// "could we make sure that tags export as well with images?"
    /// A rendered bake keeps its identity when another program rewrites
    /// its Software tag (2026-10-08: "Reset should not set the tone
    /// profile active if the metadata in the XMP says otherwise"): the
    /// XMP's heeler:Rendered says it on its own, and a file with neither
    /// marker is no bake.
    #[test]
    fn a_rendered_bake_is_known_by_its_xmp_when_its_software_tag_is_rewritten() {
        let px = heeler_engine::buffers::ImageBuf::filled(8, 8, [0.4, 0.3, 0.2, 1.0]);
        let marked = XmpPacket { keywords: &[], rating: None, derived_from: Some("a.tif"), captured_at: None, rendered: true }.build();
        assert!(marked.contains(RENDERED_XMP));
        let plain = XmpPacket { keywords: &[], rating: None, derived_from: Some("a.tif"), captured_at: None, rendered: false }.build();
        assert!(!plain.contains("heeler:Rendered"));
        // Another program saves the file: same length, another name.
        let rewrite = |mut bytes: Vec<u8>| {
            let at = bytes.windows(20).position(|w| w == b"Heeler Rendered Bake").expect("the Software tag");
            bytes[at..at + 20].copy_from_slice(b"A metadata tool 3.1 ");
            bytes
        };
        let bake = crate::encode_baked_dng(&px, None, &marked, "a.tif").unwrap();
        assert!(read_exif(&bake).rendered_bake, "a fresh bake, both markers");
        assert!(read_exif(&rewrite(bake)).rendered_bake, "its XMP alone keeps it a rendered bake");
        let unmarked = rewrite(crate::encode_baked_dng(&px, None, &plain, "a.tif").unwrap());
        assert!(!read_exif(&unmarked).rendered_bake, "neither marker: not a rendered bake");
    }

    #[test]
    fn keywords_embed_as_xmp_and_the_files_still_decode() {
        let mut img = heeler_engine::ImageBuf::new(8, 8);
        for px in img.data.chunks_exact_mut(4) {
            px.copy_from_slice(&[0.5, 0.4, 0.3, 1.0]);
        }
        let kw = vec!["wedding".to_string(), "smith & sons".to_string()];
        let xmp = xmp_keywords_packet(&kw);
        assert!(xmp.contains("<rdf:li>wedding</rdf:li>"));
        assert!(xmp.contains("smith &amp; sons"), "XML metacharacters are escaped");

        let mut jpeg = crate::encode_jpeg(&img, 90).unwrap();
        embed_jpeg_xmp(&mut jpeg, &xmp);
        let hay = String::from_utf8_lossy(&jpeg);
        assert!(hay.contains("ns.adobe.com/xap/1.0"), "the XMP APP1 is present");
        assert!(hay.contains("wedding"));
        assert!(crate::decode_bytes(&jpeg).is_ok(), "the JPEG survives the splice");

        let mut png = crate::encode_png(&img).unwrap();
        embed_png_xmp(&mut png, &xmp);
        let hay = String::from_utf8_lossy(&png);
        assert!(hay.contains("XML:com.adobe.xmp"));
        assert!(crate::decode_bytes(&png).is_ok(), "the PNG survives the chunk");
    }

    /// The same tags into the TIFF containers: tag 700 in IFD0, written
    /// at encode time, and everything the file already said still
    /// readable afterwards.
    #[test]
    fn keywords_embed_into_tiff_and_dng_as_tag_700() {
        let mut img = heeler_engine::ImageBuf::new(8, 8);
        for px in img.data.chunks_exact_mut(4) {
            px.copy_from_slice(&[0.5, 0.4, 0.3, 1.0]);
        }
        let kw = vec!["wedding".to_string()];
        let xmp = xmp_keywords_packet(&kw);

        let mut exif = Exif::default();
        exif.make = Some("Canon".to_string());
        for (name, bytes) in [
            ("tiff", crate::encode_tiff16_export(&img, crate::TiffExportOptions { exif: Some(&exif), xmp: Some(&xmp), ..Default::default() }).unwrap()),
            ("dng", crate::encode_dng_with_xmp(&img, None, Some(&xmp)).unwrap()),
        ] {
            let hay = String::from_utf8_lossy(&bytes);
            assert!(hay.contains("<rdf:li>wedding</rdf:li>"), "{name}: the packet is present");
            // A DNG is raw sensor arithmetic no general decoder claims;
            // its integrity check is the directory walk below.
            if name == "tiff" {
                assert!(
                    crate::decode_bytes(&bytes).is_ok(),
                    "{name}: the file survives with its keywords"
                );
            }
            // The packet is wired into IFD0, not just lying in the file.
            let t = Tiff { bytes: &bytes, little: true };
            let ifd0 = t.u32_at(4).unwrap() as usize;
            let count = t.u16_at(ifd0).unwrap() as usize;
            let found = (0..count).any(|i| t.u16_at(ifd0 + 2 + i * 12) == Some(TAG_XMP));
            assert!(found, "{name}: IFD0 carries tag 700");
        }

        // The TIFF's camera record is there beside the keywords.
        let tif = crate::encode_tiff16_export(&img, crate::TiffExportOptions { exif: Some(&exif), xmp: Some(&xmp), ..Default::default() }).unwrap();
        assert_eq!(read_exif(&tif).make.as_deref(), Some("Canon"));
    }

    /// A little-endian TIFF holding exactly the tags asked for, built the
    /// way a camera would: IFD0 with a pointer to an Exif directory.
    fn tiff(ifd0: &[(u16, u16, u32, Vec<u8>)], exif: &[(u16, u16, u32, Vec<u8>)]) -> Vec<u8> {
        tiff_magic(ifd0, exif, 42)
    }

    /// The same, with whatever the maker put where the spec says 42.
    fn tiff_magic(
        ifd0: &[(u16, u16, u32, Vec<u8>)],
        exif: &[(u16, u16, u32, Vec<u8>)],
        magic: u16,
    ) -> Vec<u8> {
        // Layout: header, IFD0, exif IFD, then the out-of-line values.
        let dir_len = |n: usize| 2 + n * 12 + 4;
        let ifd0_at = 8usize;
        let has_exif = !exif.is_empty();
        let ifd0_entries = ifd0.len() + usize::from(has_exif);
        let exif_at = ifd0_at + dir_len(ifd0_entries);
        let values_at = exif_at + if has_exif { dir_len(exif.len()) } else { 0 };

        let mut values: Vec<u8> = Vec::new();
        let write_dir = |fields: &[(u16, u16, u32, Vec<u8>)],
                             extra: Option<(u16, u16, u32, Vec<u8>)>,
                             values: &mut Vec<u8>|
         -> Vec<u8> {
            let mut all: Vec<(u16, u16, u32, Vec<u8>)> = fields.to_vec();
            if let Some(e) = extra {
                all.push(e);
            }
            all.sort_by_key(|f| f.0);
            let mut out = Vec::new();
            out.extend_from_slice(&(all.len() as u16).to_le_bytes());
            for (tag, kind, count, payload) in &all {
                out.extend_from_slice(&tag.to_le_bytes());
                out.extend_from_slice(&kind.to_le_bytes());
                out.extend_from_slice(&count.to_le_bytes());
                if payload.len() <= 4 {
                    let mut inline = payload.clone();
                    inline.resize(4, 0);
                    out.extend_from_slice(&inline);
                } else {
                    out.extend_from_slice(&((values_at + values.len()) as u32).to_le_bytes());
                    values.extend_from_slice(payload);
                    if values.len() & 1 == 1 {
                        values.push(0);
                    }
                }
            }
            out.extend_from_slice(&0u32.to_le_bytes());
            out
        };

        let pointer = has_exif
            .then(|| (0x8769u16, LONG, 1u32, (exif_at as u32).to_le_bytes().to_vec()));
        let dir0 = write_dir(ifd0, pointer, &mut values);
        let dir1 = if has_exif { write_dir(exif, None, &mut values) } else { Vec::new() };

        let mut out = Vec::new();
        out.extend_from_slice(b"II");
        out.extend_from_slice(&magic.to_le_bytes());
        out.extend_from_slice(&(ifd0_at as u32).to_le_bytes());
        out.extend_from_slice(&dir0);
        out.extend_from_slice(&dir1);
        out.extend_from_slice(&values);
        out
    }

    fn ascii_field(tag: u16, text: &str) -> (u16, u16, u32, Vec<u8>) {
        let mut b = text.as_bytes().to_vec();
        b.push(0);
        (tag, ASCII, b.len() as u32, b)
    }
    fn short_field(tag: u16, v: u16) -> (u16, u16, u32, Vec<u8>) {
        (tag, SHORT, 1, v.to_le_bytes().to_vec())
    }
    fn ratio_field(tag: u16, num: u32, den: u32) -> (u16, u16, u32, Vec<u8>) {
        let mut b = num.to_le_bytes().to_vec();
        b.extend_from_slice(&den.to_le_bytes());
        (tag, RATIONAL, 1, b)
    }

    #[test]
    fn the_panasonic_makernote_names_the_lens_the_standard_tag_wont() {
        // The owner's RW2s: the standard LensModel tag is absent (Sigma
        // 60-600) or the literal "NO-LENS" (adapted glass); the real name
        // lives in MakerNote tag 0x51. The note is an IFD sharing the outer
        // TIFF's offset base; the inline-value case is exercised because this
        // builder cannot know absolute offsets.
        let mut note = b"Panasonic\0\0\0".to_vec();
        note.extend_from_slice(&1u16.to_le_bytes());
        note.extend_from_slice(&0x0051u16.to_le_bytes());
        note.extend_from_slice(&ASCII.to_le_bytes());
        note.extend_from_slice(&4u32.to_le_bytes());
        note.extend_from_slice(b"60mm");
        note.extend_from_slice(&0u32.to_le_bytes());
        let x = read_exif(&tiff(
            &[ascii_field(0x010f, "Panasonic")],
            &[(0x927c, UNDEFINED, note.len() as u32, note), ascii_field(0xa434, "NO-LENS")],
        ));
        assert_eq!(x.lens.as_deref(), Some("60mm"));
    }

    fn a_photograph() -> Vec<u8> {
        tiff(
            &[
                ascii_field(0x010f, "NIKON CORPORATION"),
                ascii_field(0x0110, "NIKON Z 7"),
                short_field(0x0112, 6),
                ascii_field(0x0132, "2024:03:11 17:42:08"),
            ],
            &[
                ratio_field(0x829a, 1, 250),
                ratio_field(0x829d, 28, 10),
                short_field(0x8827, 400),
                ratio_field(0x920a, 85, 1),
                short_field(0xa405, 85),
                ascii_field(0xa434, "NIKKOR Z 85mm f/1.8 S"),
                ascii_field(0x9003, "2024:03:11 17:42:08"),
            ],
        )
    }

    #[test]
    fn reads_what_the_camera_wrote() {
        let x = read_exif(&a_photograph());
        assert_eq!(x.make.as_deref(), Some("NIKON CORPORATION"));
        assert_eq!(x.model.as_deref(), Some("NIKON Z 7"));
        assert_eq!(x.lens.as_deref(), Some("NIKKOR Z 85mm f/1.8 S"));
        assert_eq!(x.iso, Some(400));
        assert_eq!(x.orientation, Some(6));
        assert_eq!(x.shutter, Some(Ratio { num: 1, den: 250 }));
        assert_eq!(x.aperture, Some(Ratio { num: 28, den: 10 }));
        assert_eq!(x.focal_length, Some(Ratio { num: 85, den: 1 }));
        assert_eq!(x.focal_35, Some(85));
        assert_eq!(x.shot_at.as_deref(), Some("2024:03:11 17:42:08"));
        assert!(!x.is_empty());
    }


    /// A minimal BMFF box: size + fourcc + payload.
    fn bmff(kind: &[u8; 4], payload: &[u8]) -> Vec<u8> {
        let mut out = Vec::with_capacity(payload.len() + 8);
        out.extend_from_slice(&((payload.len() + 8) as u32).to_be_bytes());
        out.extend_from_slice(kind);
        out.extend_from_slice(payload);
        out
    }

    /// A synthetic CR3, structured the way Canon structures the real
    /// thing: ftyp, then moov holding the metadata uuid, holding the CMT
    /// boxes, each of which is a complete TIFF stream.
    fn cr3(cmt1: &[u8], cmt2: &[u8]) -> Vec<u8> {
        let mut uuid_payload = CANON_META_UUID.to_vec();
        uuid_payload.extend_from_slice(&bmff(b"CMT1", cmt1));
        uuid_payload.extend_from_slice(&bmff(b"CMT2", cmt2));
        let moov = bmff(b"moov", &bmff(b"uuid", &uuid_payload));
        let mut out = bmff(b"ftyp", b"crx \x00\x00\x00\x01isomcrx ");
        out.extend_from_slice(&moov);
        // The sensor data the reader must walk past without reading.
        out.extend_from_slice(&bmff(b"mdat", &[0u8; 64]));
        out
    }

    #[test]
    fn a_cr3_reads_camera_and_exposure_from_its_cmt_boxes() {
        // "the following are not loading metadata from .CR3 files."
        // CR3 is ISO-BMFF, and the module used to say so and stop. CMT1 carries
        // IFD0, CMT2 the Exif directory; both are TIFF streams once found, and
        // both halves make one record.
        let cmt1 = tiff(
            &[
                ascii_field(0x010f, "Canon"),
                ascii_field(0x0110, "Canon EOS R5"),
                short_field(0x0112, 8),
            ],
            &[],
        );
        // In a real CR3 the exposure tags sit at CMT2's own top level.
        let cmt2 = tiff(
            &[
                ratio_field(0x829a, 1, 250),
                ratio_field(0x829d, 28, 10),
                short_field(0x8827, 400),
                ascii_field(0xa434, "RF24-70mm F2.8 L IS USM"),
            ],
            &[],
        );
        let x = read_exif(&cr3(&cmt1, &cmt2));
        assert_eq!(x.camera().as_deref(), Some("Canon EOS R5"));
        assert_eq!(x.orientation, Some(8));
        assert_eq!(x.iso, Some(400));
        assert_eq!(x.shutter, Some(Ratio { num: 1, den: 250 }));
        assert_eq!(x.lens.as_deref(), Some("RF24-70mm F2.8 L IS USM"));
    }

    #[test]
    fn a_bmff_file_without_canon_boxes_reads_as_empty_rather_than_wrong() {
        // An HEIC or a stranger's CRX variant walks the same container;
        // finding nothing must be an empty record, not a misreading.
        let mut out = bmff(b"ftyp", b"heic\x00\x00\x00\x01mif1");
        out.extend_from_slice(&bmff(b"moov", &bmff(b"trak", &[0u8; 16])));
        assert!(read_exif(&out).is_empty());
    }

    #[test]
    fn a_cr3_with_a_largesize_mdat_before_moov_still_reads() {
        // Video-capable bodies write 64-bit box sizes; the walk has to
        // step over one without losing its place.
        let cmt1 = tiff(&[ascii_field(0x0110, "Canon EOS R6")], &[]);
        let mut uuid_payload = CANON_META_UUID.to_vec();
        uuid_payload.extend_from_slice(&bmff(b"CMT1", &cmt1));
        let mut out = bmff(b"ftyp", b"crx ");
        // A largesize box: size=1, then the real 64-bit size.
        let body = [0u8; 32];
        out.extend_from_slice(&1u32.to_be_bytes());
        out.extend_from_slice(b"mdat");
        out.extend_from_slice(&((body.len() + 16) as u64).to_be_bytes());
        out.extend_from_slice(&body);
        out.extend_from_slice(&bmff(b"moov", &bmff(b"uuid", &uuid_payload)));
        let x = read_exif(&out);
        assert_eq!(x.model.as_deref(), Some("Canon EOS R6"));
    }

    #[test]
    fn a_truncated_moov_still_yields_its_early_cmt_boxes() {
        // The metadata reader is handed the file's first megabyte, and a
        // real CR3's moov declares more than the buffer holds while the
        // CMT boxes sit in its first few kilobytes. A walk that rejected
        // the truncated box rejected the metadata with it.
        let cmt1 = tiff(&[ascii_field(0x0110, "Canon EOS R7")], &[]);
        let mut uuid_payload = CANON_META_UUID.to_vec();
        uuid_payload.extend_from_slice(&bmff(b"CMT1", &cmt1));
        let uuid = bmff(b"uuid", &uuid_payload);
        let mut out = bmff(b"ftyp", b"crx ");
        // moov claims far more than the buffer will carry.
        out.extend_from_slice(&(1_000_000u32 + 8).to_be_bytes());
        out.extend_from_slice(b"moov");
        out.extend_from_slice(&uuid);
        out.extend_from_slice(&[0u8; 256]); // a sliver of the rest
        let x = read_exif(&out);
        assert_eq!(x.model.as_deref(), Some("Canon EOS R7"));
    }

    #[test]
    fn a_panasonic_raw_is_read_despite_its_header() {
        // "it's not pulling any metadata from my .RW2 files." Panasonic
        // writes 0x55 where the spec says 42. Every directory after that is laid
        // out exactly like a TIFF, so requiring 42 rejected the whole file for the
        // sake of one byte.
        //
        // This crate already knew: the orientation reader accepts any magic
        // and has its own test saying why. Not reusing that was the bug.
        let bytes = tiff_magic(
            &[
                ascii_field(0x010f, "Panasonic"),
                ascii_field(0x0110, "DC-S5M2"),
                short_field(0x0112, 1),
            ],
            &[
                ratio_field(0x829a, 1, 160),
                ratio_field(0x829d, 40, 10),
                short_field(0x8827, 200),
            ],
            0x55,
        );
        let x = read_exif(&bytes);
        assert_eq!(x.camera().as_deref(), Some("Panasonic DC-S5M2"));
        assert_eq!(x.iso, Some(200));
        assert_eq!(format_shutter(x.shutter.unwrap()), "1/160");
        assert_eq!(format_aperture(x.aperture.unwrap()), "f/4");
    }

    #[test]
    fn panasonics_own_iso_tag_is_a_fallback_and_only_that() {
        // RW2 keeps an ISO in tag 0x0017 of its first directory. Useful
        // when there is no standard one, but 0x0017 is unassigned in a
        // plain TIFF and could be anything in another maker's file, so the
        // standard tag always wins.
        let only_panasonic = tiff_magic(&[short_field(0x0017, 3200)], &[], 0x55);
        assert_eq!(read_exif(&only_panasonic).iso, Some(3200));

        let both = tiff_magic(&[short_field(0x0017, 3200)], &[short_field(0x8827, 800)], 0x55);
        assert_eq!(read_exif(&both).iso, Some(800), "the standard tag should win");
    }

    #[test]
    fn a_header_pointing_nowhere_is_still_refused() {
        // Accepting any magic must not turn into accepting anything at all.
        // The offset is the thing that has to be true for a file to be
        // readable, so that is what is checked instead.
        let mut bytes = tiff_magic(&[ascii_field(0x0110, "X")], &[], 0x55);
        bytes[4..8].copy_from_slice(&999_999u32.to_le_bytes());
        assert!(read_exif(&bytes).is_empty());
        // And an offset inside the header itself is nonsense too.
        bytes[4..8].copy_from_slice(&2u32.to_le_bytes());
        assert!(read_exif(&bytes).is_empty());
    }

    #[test]
    fn the_same_file_inside_a_jpeg_reads_the_same() {
        // A JPEG carries the whole TIFF stream in an APP1 segment,
        // offsets and all, so only finding it differs.
        let stream = a_photograph();
        let mut body = b"Exif\0\0".to_vec();
        body.extend_from_slice(&stream);
        let mut jpeg = vec![0xFF, 0xD8];
        jpeg.extend_from_slice(&[0xFF, 0xE1]);
        jpeg.extend_from_slice(&((body.len() + 2) as u16).to_be_bytes());
        jpeg.extend_from_slice(&body);
        jpeg.extend_from_slice(&[0xFF, 0xDA, 0x00, 0x02]);

        let x = read_exif(&jpeg);
        assert_eq!(x.model.as_deref(), Some("NIKON Z 7"));
        assert_eq!(x.iso, Some(400));
    }

    #[test]
    fn a_fuji_raf_reads_through_its_embedded_jpeg() {
        // The same APP1-wrapped stream as the JPEG test, parked where
        // RAF's directory says the embedded JPEG lives.
        let stream = a_photograph();
        let mut body = b"Exif\0\0".to_vec();
        body.extend_from_slice(&stream);
        let mut jpeg = vec![0xFF, 0xD8];
        jpeg.extend_from_slice(&[0xFF, 0xE1]);
        jpeg.extend_from_slice(&((body.len() + 2) as u16).to_be_bytes());
        jpeg.extend_from_slice(&body);
        jpeg.extend_from_slice(&[0xFF, 0xDA, 0x00, 0x02]);

        let mut raf = b"FUJIFILMCCD-RAW 0201FF129502".to_vec();
        raf.resize(84, 0);
        let off = 120u32;
        raf.extend_from_slice(&off.to_be_bytes());
        raf.extend_from_slice(&(jpeg.len() as u32).to_be_bytes());
        raf.resize(off as usize, 0);
        raf.extend_from_slice(&jpeg);

        let x = read_exif(&raf);
        assert_eq!(x.model.as_deref(), Some("NIKON Z 7"));
        assert_eq!(x.iso, Some(400));

        // A directory pointing at garbage stays silent rather than
        // feeding it onward.
        let mut bad = raf.clone();
        bad[off as usize] = 0x00; // no JPEG magic where promised
        assert!(read_exif(&bad).is_empty());
    }

    #[test]
    fn a_file_with_nothing_to_say_says_nothing() {
        // A scan, a render, a screenshot. Empty is the honest answer; a
        // pile of zeroes would look like readings.
        assert!(read_exif(b"not an image at all").is_empty());
        assert!(read_exif(&[]).is_empty());
        // A JPEG with no APP1 must not have its image data scanned for
        // something that looks like a TIFF header.
        let bare = [0xFF, 0xD8, 0xFF, 0xDA, 0x00, 0x02, b'I', b'I', 42, 0];
        assert!(read_exif(&bare).is_empty());
    }

    #[test]
    fn a_directory_pointing_at_itself_does_not_hang() {
        // Malformed files exist, and a reader that loops on one takes the
        // whole library panel down with it.
        let mut bytes = tiff(&[ascii_field(0x0110, "X")], &[]);
        // Point IFD0 at itself.
        let ifd0 = 8usize;
        let count = u16::from_le_bytes([bytes[ifd0], bytes[ifd0 + 1]]) as usize;
        let next = ifd0 + 2 + count * 12;
        bytes[next..next + 4].copy_from_slice(&(ifd0 as u32).to_le_bytes());
        assert_eq!(read_exif(&bytes).model.as_deref(), Some("X"));
    }

    /// The owner's export test read back "JFIFVersion 1.02, X-Resolution 1
    /// dpi" and nothing else. The writer exists so an export carries the
    /// camera's record; this drives it through both real containers and
    /// reads it back with the same parser the metadata panel uses.
    #[test]
    fn written_exif_reads_back_from_both_containers() {
        let record = Exif {
            rendered_bake: false,
            original_raw_file_name: None,
            make: Some("Panasonic".into()),
            model: Some("DC-S5M2".into()),
            lens: Some("LUMIX S 20-60mm F3.5-5.6".into()),
            shot_at: Some("2026:06:14 09:12:33".into()),
            iso: Some(640),
            aperture: Some(Ratio { num: 40, den: 10 }),
            shutter: Some(Ratio { num: 1, den: 160 }),
            focal_length: Some(Ratio { num: 20, den: 1 }),
            focal_35: Some(20),
            exposure_bias: Some(Ratio { num: -1, den: 3 }),
            orientation: Some(6), // the source was rotated...
            width: Some(9999),    // ...and these describe the source,
            height: Some(9999),   // not the export
            sensor_borders: None,
            artist: Some("A. Photographer".into()),
            copyright: Some("(c) A. Photographer".into()),
        };
        let img = crate::tests_support_image();
        // JPEG: encode, splice, decode-read.
        let mut jpeg = crate::encode_jpeg(&img, 90).unwrap();
        crate::embed_jpeg_exif(&mut jpeg, &write_exif_tiff(&record, crate::ExifExportOptions { width: 16, height: 8, dpi: crate::DEFAULT_DPI }));
        let back = read_exif(&jpeg);
        assert_eq!(back.camera().as_deref(), Some("Panasonic DC-S5M2"));
        assert_eq!(back.lens, record.lens);
        assert_eq!(back.iso, record.iso);
        assert_eq!(back.shutter, record.shutter);
        assert_eq!(back.aperture, record.aperture);
        assert_eq!(back.exposure_bias, record.exposure_bias);
        assert_eq!(back.shot_at, record.shot_at);
        assert_eq!(back.artist, record.artist);
        assert_eq!(back.copyright, record.copyright);
        // The export stands upright and reports its own size.
        assert_eq!(back.orientation, Some(1));
        assert_eq!((back.width, back.height), (Some(16), Some(8)));
        // The file is still a JPEG that decodes.
        assert!(crate::decode_bytes(&jpeg).is_ok());

        // PNG: same record through the eXIf chunk.
        let mut png = crate::encode_png(&img).unwrap();
        crate::embed_png_exif(&mut png, &write_exif_tiff(&record, crate::ExifExportOptions { width: 16, height: 8, dpi: crate::DEFAULT_DPI }));
        let back = read_exif(&png);
        assert_eq!(back.camera().as_deref(), Some("Panasonic DC-S5M2"));
        assert_eq!(back.iso, record.iso);
        assert_eq!(back.orientation, Some(1));
        assert!(crate::decode_bytes(&png).is_ok());
    }

    #[test]
    fn an_empty_record_still_writes_a_valid_block() {
        // Even a file with no camera data gets orientation, resolution
        // (the "1 dpi" fix), software, and the export's dimensions.
        let tiff = write_exif_tiff(&Exif::default(), crate::ExifExportOptions { width: 800, height: 600, dpi: crate::DEFAULT_DPI });
        let x = read_tiff(&tiff).unwrap();
        assert_eq!(x.orientation, Some(1));
        assert_eq!((x.width, x.height), (Some(800), Some(600)));
    }

    #[test]
    fn the_camera_is_one_line_rather_than_two_fields() {
        let both = Exif {
            make: Some("NIKON CORPORATION".into()),
            model: Some("NIKON Z 7".into()),
            ..Exif::default()
        };
        // Most makers repeat themselves; saying it twice reads as a bug.
        assert_eq!(both.camera().as_deref(), Some("NIKON Z 7"));
        let split = Exif {
            make: Some("Hasselblad".into()),
            model: Some("X2D 100C".into()),
            ..Exif::default()
        };
        assert_eq!(split.camera().as_deref(), Some("Hasselblad X2D 100C"));
        assert_eq!(Exif::default().camera(), None);
    }

    #[test]
    fn readings_are_shown_the_way_photographers_say_them() {
        assert_eq!(format_shutter(Ratio { num: 1, den: 250 }), "1/250");
        assert_eq!(format_shutter(Ratio { num: 1, den: 3 }), "1/3");
        assert_eq!(format_shutter(Ratio { num: 2, den: 1 }), "2s");
        assert_eq!(format_shutter(Ratio { num: 25, den: 10 }), "2.5s");
        assert_eq!(format_shutter(Ratio { num: 0, den: 1 }), "");

        // f/2.8, and never f/2.80 or f/3.
        assert_eq!(format_aperture(Ratio { num: 28, den: 10 }), "f/2.8");
        assert_eq!(format_aperture(Ratio { num: 4, den: 1 }), "f/4");
        assert_eq!(format_focal(Ratio { num: 85, den: 1 }), "85 mm");
        // Compensation needs its sign even when it is positive.
        assert_eq!(format_bias(Ratio { num: 1, den: 3 }), "+0.3 EV");
        assert_eq!(format_bias(Ratio { num: -2, den: 3 }), "-0.7 EV");
        assert_eq!(format_bias(Ratio { num: 0, den: 1 }), "0 EV");
        // A denominator of zero is a corrupt field, not a division.
        assert_eq!(Ratio { num: 1, den: 0 }.value(), 0.0);
    }
}
