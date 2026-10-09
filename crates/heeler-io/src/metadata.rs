//! Everything the file says about itself, named.
//!
//! 2026-09-23: "The metadata is lacking. I know there is a lot more stored in metadata",
//! with a reference metadata reader's listing of an iPhone JPEG beside it, and "it
//! should show the user whatever it finds." `exif.rs` reads the dozen readings the
//! catalog stores and the Camera block shows; this walks the same containers and hands
//! back every entry it can name, grouped the way that reader groups them: the TIFF and
//! Exif directories, GPS, the XMP packet, the ICC profile's header, and a few derived
//! facts. A tag the table does not know is still shown, by its number, with its value:
//! the file said it, so the panel shows it.
//!
//! Maker notes are the one thing left folded. Every maker's is a private
//! format, most are offset-relative to a base only that maker knows, and
//! reading Apple's or Sony's wrongly would print numbers that are not
//! readings. The panel says the note is there and how big it is.
//!
//! Same rule as `exif.rs`: original code, no third-party crate, the same
//! TIFF primitives.

use crate::exif::{Tiff, ASCII, BYTE, LONG, RATIONAL, SHORT, SLONG, SRATIONAL, UNDEFINED};

/// One line of the listing: which group it belongs to, what it is
/// called, and its value as a person would read it.
#[derive(Debug, Clone, PartialEq)]
pub struct MetaEntry {
    pub group: String,
    pub name: String,
    pub value: String,
    /// The reading before display rounding, for the derived facts (a
    /// scale factor from a focal length shown to a tenth would be off
    /// by a tenth itself). None for anything that is not a number.
    pub value_num: Option<f64>,
}

fn entry(group: &str, name: impl Into<String>, value: impl Into<String>) -> MetaEntry {
    MetaEntry { group: group.into(), name: name.into(), value: value.into(), value_num: None }
}

// --- the tag tables ------------------------------------------------------

/// TIFF and Exif tags, by number, as the reference metadata reader names them.
fn exif_tag_name(tag: u16) -> Option<&'static str> {
    Some(match tag {
        0x00fe => "Subfile Type",
        0x0100 => "Image Width",
        0x0101 => "Image Height",
        0x0102 => "Bits Per Sample",
        0x0103 => "Compression",
        0x0106 => "Photometric Interpretation",
        0x010e => "Image Description",
        0x010f => "Make",
        0x0110 => "Camera Model Name",
        0x0111 => "Strip Offsets",
        0x0112 => "Orientation",
        0x0115 => "Samples Per Pixel",
        0x0116 => "Rows Per Strip",
        0x0117 => "Strip Byte Counts",
        0x011a => "X Resolution",
        0x011b => "Y Resolution",
        0x011c => "Planar Configuration",
        0x0128 => "Resolution Unit",
        0x0131 => "Software",
        0x0132 => "Modify Date",
        0x013b => "Artist",
        0x013c => "Host Computer",
        0x013e => "White Point",
        0x013f => "Primary Chromaticities",
        0x014a => "Sub IFD",
        0x0201 => "Thumbnail Offset",
        0x0202 => "Thumbnail Length",
        0x0211 => "Y Cb Cr Coefficients",
        0x0212 => "Y Cb Cr Sub Sampling",
        0x0213 => "Y Cb Cr Positioning",
        0x0214 => "Reference Black White",
        0x02bc => "XMP",
        0x4746 => "Rating",
        0x4749 => "Rating Percent",
        0x8298 => "Copyright",
        0x829a => "Exposure Time",
        0x829d => "F Number",
        0x83bb => "IPTC",
        0x8769 => "Exif Offset",
        0x8773 => "ICC Profile",
        0x8822 => "Exposure Program",
        0x8824 => "Spectral Sensitivity",
        0x8825 => "GPS Info",
        0x8827 => "ISO",
        0x8828 => "Opto-Electric Conv Factor",
        0x882a => "Time Zone Offset",
        0x8830 => "Sensitivity Type",
        0x8831 => "Standard Output Sensitivity",
        0x8832 => "Recommended Exposure Index",
        0x8833 => "ISO Speed",
        0x9000 => "Exif Version",
        0x9003 => "Date/Time Original",
        0x9004 => "Create Date",
        0x9010 => "Offset Time",
        0x9011 => "Offset Time Original",
        0x9012 => "Offset Time Digitized",
        0x9101 => "Components Configuration",
        0x9102 => "Compressed Bits Per Pixel",
        0x9201 => "Shutter Speed Value",
        0x9202 => "Aperture Value",
        0x9203 => "Brightness Value",
        0x9204 => "Exposure Compensation",
        0x9205 => "Max Aperture Value",
        0x9206 => "Subject Distance",
        0x9207 => "Metering Mode",
        0x9208 => "Light Source",
        0x9209 => "Flash",
        0x920a => "Focal Length",
        0x9214 => "Subject Area",
        0x927c => "Maker Note",
        0x9286 => "User Comment",
        0x9290 => "Sub Sec Time",
        0x9291 => "Sub Sec Time Original",
        0x9292 => "Sub Sec Time Digitized",
        0x9400 => "Ambient Temperature",
        0x9401 => "Humidity",
        0x9402 => "Pressure",
        0x9403 => "Water Depth",
        0x9404 => "Acceleration",
        0x9405 => "Camera Elevation Angle",
        0x9c9b => "XP Title",
        0x9c9c => "XP Comment",
        0x9c9d => "XP Author",
        0x9c9e => "XP Keywords",
        0x9c9f => "XP Subject",
        0xa000 => "Flashpix Version",
        0xa001 => "Color Space",
        0xa002 => "Exif Image Width",
        0xa003 => "Exif Image Height",
        0xa004 => "Related Sound File",
        0xa005 => "Interop Offset",
        0xa20b => "Flash Energy",
        0xa20e => "Focal Plane X Resolution",
        0xa20f => "Focal Plane Y Resolution",
        0xa210 => "Focal Plane Resolution Unit",
        0xa214 => "Subject Location",
        0xa215 => "Exposure Index",
        0xa217 => "Sensing Method",
        0xa300 => "File Source",
        0xa301 => "Scene Type",
        0xa302 => "CFA Pattern",
        0xa401 => "Custom Rendered",
        0xa402 => "Exposure Mode",
        0xa403 => "White Balance",
        0xa404 => "Digital Zoom Ratio",
        0xa405 => "Focal Length In 35mm Format",
        0xa406 => "Scene Capture Type",
        0xa407 => "Gain Control",
        0xa408 => "Contrast",
        0xa409 => "Saturation",
        0xa40a => "Sharpness",
        0xa40c => "Subject Distance Range",
        0xa420 => "Image Unique ID",
        0xa430 => "Owner Name",
        0xa431 => "Serial Number",
        0xa432 => "Lens Info",
        0xa433 => "Lens Make",
        0xa434 => "Lens Model",
        0xa435 => "Lens Serial Number",
        0xa460 => "Composite Image",
        0xa461 => "Composite Image Count",
        0xa462 => "Composite Image Exposure Times",
        0xa500 => "Gamma",
        0xc4a5 => "Print IM",
        0xc612 => "DNG Version",
        0xc613 => "DNG Backward Version",
        0xc614 => "Unique Camera Model",
        0xc615 => "Localized Camera Model",
        0xc621 => "Color Matrix 1",
        0xc622 => "Color Matrix 2",
        0xc623 => "Camera Calibration 1",
        0xc624 => "Camera Calibration 2",
        0xc627 => "Analog Balance",
        0xc628 => "As Shot Neutral",
        0xc629 => "As Shot White XY",
        0xc62a => "Baseline Exposure",
        0xc62b => "Baseline Noise",
        0xc62c => "Baseline Sharpness",
        0xc62f => "Camera Serial Number",
        0xc630 => "DNG Lens Info",
        0xc65a => "Calibration Illuminant 1",
        0xc65b => "Calibration Illuminant 2",
        0xc68b => "Original Raw File Name",
        0xc6f4 => "Profile Calibration Signature",
        0xc6f8 => "Profile Name",
        0xc6fe => "Profile Copyright",
        0xc716 => "Preview Application Name",
        0xc717 => "Preview Application Version",
        0xc71a => "Preview Color Space",
        0xc71b => "Preview Date Time",
        _ => return None,
    })
}

/// The GPS directory's tags.
fn gps_tag_name(tag: u16) -> Option<&'static str> {
    Some(match tag {
        0x0000 => "GPS Version ID",
        0x0001 => "GPS Latitude Ref",
        0x0002 => "GPS Latitude",
        0x0003 => "GPS Longitude Ref",
        0x0004 => "GPS Longitude",
        0x0005 => "GPS Altitude Ref",
        0x0006 => "GPS Altitude",
        0x0007 => "GPS Time Stamp",
        0x0008 => "GPS Satellites",
        0x0009 => "GPS Status",
        0x000a => "GPS Measure Mode",
        0x000b => "GPS DOP",
        0x000c => "GPS Speed Ref",
        0x000d => "GPS Speed",
        0x000e => "GPS Track Ref",
        0x000f => "GPS Track",
        0x0010 => "GPS Img Direction Ref",
        0x0011 => "GPS Img Direction",
        0x0012 => "GPS Map Datum",
        0x0013 => "GPS Dest Latitude Ref",
        0x0014 => "GPS Dest Latitude",
        0x0015 => "GPS Dest Longitude Ref",
        0x0016 => "GPS Dest Longitude",
        0x0017 => "GPS Dest Bearing Ref",
        0x0018 => "GPS Dest Bearing",
        0x0019 => "GPS Dest Distance Ref",
        0x001a => "GPS Dest Distance",
        0x001b => "GPS Processing Method",
        0x001c => "GPS Area Information",
        0x001d => "GPS Date Stamp",
        0x001e => "GPS Differential",
        0x001f => "GPS Horizontal Positioning Error",
        _ => return None,
    })
}

/// The enumerated tags, in words. A number the table does not know is
/// shown as the number: "Metering Mode: 7" is still a reading.
fn enumerated(tag: u16, v: u32) -> Option<&'static str> {
    Some(match (tag, v) {
        (0x0112, 1) => "Horizontal (normal)",
        (0x0112, 2) => "Mirror horizontal",
        (0x0112, 3) => "Rotate 180",
        (0x0112, 4) => "Mirror vertical",
        (0x0112, 5) => "Mirror horizontal and rotate 270 CW",
        (0x0112, 6) => "Rotate 90 CW",
        (0x0112, 7) => "Mirror horizontal and rotate 90 CW",
        (0x0112, 8) => "Rotate 270 CW",
        (0x0128, 1) => "None",
        (0x0128, 2) => "inches",
        (0x0128, 3) => "cm",
        (0x0103, 1) => "Uncompressed",
        (0x0103, 6) => "JPEG (old-style)",
        (0x0103, 7) => "JPEG",
        (0x0103, 8) => "Adobe Deflate",
        (0x0103, 34892) => "Lossy JPEG",
        (0x0106, 1) => "BlackIsZero",
        (0x0106, 2) => "RGB",
        (0x0106, 6) => "YCbCr",
        (0x0106, 32803) => "Color Filter Array",
        (0x0106, 34892) => "Linear Raw",
        (0x0213, 1) => "Centered",
        (0x0213, 2) => "Co-sited",
        (0x8822, 0) => "Not Defined",
        (0x8822, 1) => "Manual",
        (0x8822, 2) => "Program AE",
        (0x8822, 3) => "Aperture-priority AE",
        (0x8822, 4) => "Shutter speed priority AE",
        (0x8822, 5) => "Creative (Slow speed)",
        (0x8822, 6) => "Action (High speed)",
        (0x8822, 7) => "Portrait",
        (0x8822, 8) => "Landscape",
        (0x8822, 9) => "Bulb",
        (0x8830, 1) => "Standard Output Sensitivity",
        (0x8830, 2) => "Recommended Exposure Index",
        (0x8830, 3) => "ISO Speed",
        (0x8830, 4) => "Standard Output Sensitivity and Recommended Exposure Index",
        (0x9207, 0) => "Unknown",
        (0x9207, 1) => "Average",
        (0x9207, 2) => "Center-weighted average",
        (0x9207, 3) => "Spot",
        (0x9207, 4) => "Multi-spot",
        (0x9207, 5) => "Multi-segment",
        (0x9207, 6) => "Partial",
        (0x9208, 0) => "Unknown",
        (0x9208, 1) => "Daylight",
        (0x9208, 2) => "Fluorescent",
        (0x9208, 3) => "Tungsten (Incandescent)",
        (0x9208, 4) => "Flash",
        (0x9208, 9) => "Fine Weather",
        (0x9208, 10) => "Cloudy",
        (0x9208, 11) => "Shade",
        (0x9208, 17) => "Standard Light A",
        (0x9208, 18) => "Standard Light B",
        (0x9208, 19) => "Standard Light C",
        (0x9208, 20) => "D55",
        (0x9208, 21) => "D65",
        (0x9208, 22) => "D75",
        (0x9208, 23) => "D50",
        (0x9208, 255) => "Other",
        (0xa001, 1) => "sRGB",
        (0xa001, 2) => "Adobe RGB",
        (0xa001, 0xffff) => "Uncalibrated",
        (0xa210, 2) => "inches",
        (0xa210, 3) => "cm",
        (0xa217, 1) => "Not defined",
        (0xa217, 2) => "One-chip color area",
        (0xa217, 3) => "Two-chip color area",
        (0xa217, 4) => "Three-chip color area",
        (0xa217, 5) => "Color sequential area",
        (0xa217, 7) => "Trilinear",
        (0xa217, 8) => "Color sequential linear",
        (0xa401, 0) => "Normal",
        (0xa401, 1) => "Custom",
        (0xa401, 2) => "HDR (no original saved)",
        (0xa401, 3) => "HDR (original saved)",
        (0xa401, 4) => "Original (for HDR)",
        (0xa401, 6) => "Panorama",
        (0xa401, 7) => "Portrait HDR",
        (0xa401, 8) => "Portrait",
        (0xa402, 0) => "Auto",
        (0xa402, 1) => "Manual",
        (0xa402, 2) => "Auto bracket",
        (0xa403, 0) => "Auto",
        (0xa403, 1) => "Manual",
        (0xa406, 0) => "Standard",
        (0xa406, 1) => "Landscape",
        (0xa406, 2) => "Portrait",
        (0xa406, 3) => "Night",
        (0xa406, 4) => "Other",
        (0xa407, 0) => "None",
        (0xa407, 1) => "Low gain up",
        (0xa407, 2) => "High gain up",
        (0xa407, 3) => "Low gain down",
        (0xa407, 4) => "High gain down",
        (0xa408, 0) | (0xa409, 0) | (0xa40a, 0) => "Normal",
        (0xa408, 1) | (0xa40a, 1) => "Low",
        (0xa408, 2) | (0xa40a, 2) => "High",
        (0xa409, 1) => "Low",
        (0xa409, 2) => "High",
        (0xa40c, 0) => "Unknown",
        (0xa40c, 1) => "Macro",
        (0xa40c, 2) => "Close",
        (0xa40c, 3) => "Distant",
        (0xa300, 1) => "Film Scanner",
        (0xa300, 2) => "Reflection Print Scanner",
        (0xa300, 3) => "Digital Camera",
        (0xa301, 1) => "Directly photographed",
        (0xa460, 0) => "Unknown",
        (0xa460, 1) => "Not a Composite Image",
        (0xa460, 2) => "General Composite Image",
        (0xa460, 3) => "Composite Image Captured While Shooting",
        _ => return None,
    })
}

/// The Flash tag is a bit field, and the reference reader's phrasing is the one
/// photographers have read for twenty years.
fn flash_words(v: u32) -> String {
    // Bit 0 fired; bits 1 and 2 the return light; bits 3 and 4 the
    // mode; bit 5 no flash function; bit 6 red-eye reduction.
    let fired = v & 1 != 0;
    let mode = match (v >> 3) & 3 {
        1 => Some("On"),
        2 => Some("Off"),
        3 => Some("Auto"),
        _ => None,
    };
    let mut parts: Vec<String> = Vec::new();
    if let Some(m) = mode {
        parts.push(m.to_string());
    }
    parts.push(if fired { "Fired".into() } else { "Did not fire".into() });
    match (v >> 1) & 3 {
        2 => parts.push("Return not detected".into()),
        3 => parts.push("Return detected".into()),
        _ => {}
    }
    if v & 0x20 != 0 {
        parts.push("No flash function".into());
    }
    if v & 0x40 != 0 {
        parts.push("Red-eye reduction".into());
    }
    parts.join(", ")
}

// --- reading -------------------------------------------------------------

/// Which directory a walk is in: the words the group is filed under, and
/// which name table applies.
#[derive(Clone, Copy, PartialEq)]
enum Dir {
    Ifd0,
    Exif,
    Gps,
    Interop,
    Sub,
    /// An RW2's first directory: Panasonic's own raw tags under the
    /// low numbers, with a handful of standard TIFF tags among them.
    /// Named by Panasonic's table, never by the TIFF one, which would
    /// print "Planar Configuration 586" for a white balance reading.
    PanasonicRaw,
    /// Panasonic's maker note: a plain IFD after a twelve-byte header, offsets on the
    /// outer TIFF's base, private tag meanings that the reference metadata reader has
    /// documented for twenty years. The owner's cameras are Panasonic, and this is where
    /// the lens, the serial numbers, the photo style and the camera's attitude live
    /// (2026-09-23: "exif pulls RW2 fine", with the listing).
    PanasonicNote,
}

impl Dir {
    fn group(self) -> &'static str {
        match self {
            Dir::Ifd0 => "EXIF",
            Dir::Exif => "EXIF",
            Dir::Gps => "GPS",
            Dir::Interop => "Interop",
            Dir::Sub => "Sub IFD",
            Dir::PanasonicRaw => "Panasonic",
            Dir::PanasonicNote => "Panasonic",
        }
    }
}



/// A Panasonic note entry's value: the generated table (in
/// panasonic_tags.rs) says which tags are text, which are signed
/// whatever the file stored, which carry a plain scale, and what the
/// enumerations mean; a few forms the table cannot express (a dotted
/// firmware version, a stopwatch) are here by tag.
fn panasonic_note_value(t: &Tiff, tag: u16, e: usize, kind: u16, n: u32) -> Option<String> {
    use crate::panasonic_tags::{note_enum, note_scale, note_signed, note_string};
    if kind == ASCII {
        return t.ascii(e, kind, n);
    }
    let raw = |max: usize| -> Option<&[u8]> {
        let at = t.value_at(e, kind, n)?;
        t.bytes.get(at..(at + (n as usize).min(max)).min(t.bytes.len()))
    };
    match tag {
        // Four version bytes, dotted: "0.3.0.0".
        0x02 | 0x60 => {
            let b = raw(4)?;
            return Some(b.iter().map(|x| x.to_string()).collect::<Vec<_>>().join("."));
        }
        // Four ASCII digits.
        0x26 | 0x8000 => {
            let b = raw(4)?;
            return Some(String::from_utf8_lossy(b).trim_matches(char::from(0)).to_string());
        }
        // Centiseconds as a stopwatch.
        0x29 => {
            let v = *numbers(t, e, kind, n).first()? as u64;
            return Some(format!("{:02}:{:02}:{:02}.{:02}", v / 360_000, (v / 6_000) % 60, (v / 100) % 60, v % 100));
        }
        _ => {}
    }
    if note_string(tag) || matches!(tag, 0x25 | 0x65 | 0x66 | 0x67 | 0x69 | 0x6b | 0x6d | 0x6f | 0x80) {
        let b = raw(128)?;
        let end = b.iter().position(|&c| c == 0).unwrap_or(b.len());
        let s = String::from_utf8_lossy(&b[..end]).trim().to_string();
        return Some(if s.is_empty() { "(empty)".into() } else { s });
    }
    // Binary dumps, folded.
    if matches!(tag, 0x21 | 0x4e | 0x61) || (kind == UNDEFINED && n > 4) {
        return Some(format!("({n} bytes)"));
    }
    let mut v = numbers(t, e, kind, n);
    if v.is_empty() {
        return None;
    }
    if note_signed(tag) && kind == SHORT {
        for x in v.iter_mut() {
            *x = f64::from(*x as u16 as i16);
        }
    }
    if let Some(scale) = note_scale(tag) {
        for x in v.iter_mut() {
            *x = if scale < 0.0 { -*x / -scale } else { *x / scale };
        }
    }
    if v.len() == 1 {
        if let Some(word) = note_enum(tag, v[0] as i64) {
            return Some(word.to_string());
        }
        return Some(num(v[0]));
    }
    Some(v.iter().take(16).map(|x| num(*x)).collect::<Vec<_>>().join(" "))
}


/// A number as a person writes it: an integer when it is one, else up
/// to four decimals with the trailing zeros gone.
fn num(v: f64) -> String {
    if v.is_finite() && (v - v.round()).abs() < 1e-9 && v.abs() < 1e12 {
        format!("{}", v.round() as i64)
    } else {
        let s = format!("{v:.4}");
        s.trim_end_matches('0').trim_end_matches('.').to_string()
    }
}

/// Reads every value of an entry as f64, whatever its type.
fn numbers(t: &Tiff, e: usize, kind: u16, n: u32) -> Vec<f64> {
    let Some(at) = t.value_at(e, kind, n) else { return Vec::new() };
    let n = n.min(64) as usize;
    let mut out = Vec::with_capacity(n);
    for k in 0..n {
        let v = match kind {
            BYTE | UNDEFINED => t.bytes.get(at + k).map(|&b| b as f64),
            SHORT => t.u16_at(at + k * 2).map(f64::from),
            6 => t.bytes.get(at + k).map(|&b| f64::from(b as i8)),
            8 => t.u16_at(at + k * 2).map(|x| f64::from(x as i16)),
            LONG => t.u32_at(at + k * 4).map(f64::from),
            11 => t.u32_at(at + k * 4).map(|x| f64::from(f32::from_bits(x))),
            12 => {
                let (lo, hi) = (t.u32_at(at + k * 8), t.u32_at(at + k * 8 + 4));
                match (lo, hi) {
                    (Some(lo), Some(hi)) => Some(if t.little {
                        f64::from_bits((u64::from(hi) << 32) | u64::from(lo))
                    } else {
                        f64::from_bits((u64::from(lo) << 32) | u64::from(hi))
                    }),
                    _ => None,
                }
            }
            SLONG => t.i32_at(at + k * 4).map(f64::from),
            RATIONAL => {
                let (a, b) = (t.u32_at(at + k * 8), t.u32_at(at + k * 8 + 4));
                match (a, b) {
                    (Some(a), Some(b)) if b != 0 => Some(a as f64 / b as f64),
                    (Some(_), Some(_)) => Some(0.0),
                    _ => None,
                }
            }
            SRATIONAL => {
                let (a, b) = (t.i32_at(at + k * 8), t.i32_at(at + k * 8 + 4));
                match (a, b) {
                    (Some(a), Some(b)) if b != 0 => Some(a as f64 / b as f64),
                    (Some(_), Some(_)) => Some(0.0),
                    _ => None,
                }
            }
            _ => None,
        };
        match v {
            Some(v) => out.push(v),
            None => break,
        }
    }
    out
}

/// The first rational, as written (numerator and denominator), for the
/// tags whose display depends on the fraction and not on its value.
fn first_ratio(t: &Tiff, e: usize, kind: u16, n: u32) -> Option<(i64, i64)> {
    if kind != RATIONAL && kind != SRATIONAL {
        return None;
    }
    let at = t.value_at(e, kind, n)?;
    if kind == SRATIONAL {
        Some((t.i32_at(at)? as i64, t.i32_at(at + 4)? as i64))
    } else {
        Some((t.u32_at(at)? as i64, t.u32_at(at + 4)? as i64))
    }
}

/// Degrees, minutes, seconds from a GPS triple, as "45 deg 58' 59.11\"".
fn dms(v: &[f64]) -> Option<String> {
    let (d, m, s) = (*v.first()?, *v.get(1).unwrap_or(&0.0), *v.get(2).unwrap_or(&0.0));
    // Some phones write minutes as a decimal and no seconds.
    let (m, s) = if s == 0.0 && m.fract() != 0.0 { (m.floor(), (m - m.floor()) * 60.0) } else { (m, s) };
    Some(format!("{} deg {}' {:.2}\"", num(d), num(m), s))
}

/// A version tag written as four ASCII digits in an UNDEFINED field.
fn version_digits(t: &Tiff, e: usize, kind: u16, n: u32) -> Option<String> {
    let at = t.value_at(e, kind, n)?;
    let raw = t.bytes.get(at..at + n.min(8) as usize)?;
    if raw.iter().all(|b| b.is_ascii_digit()) {
        Some(String::from_utf8_lossy(raw).into_owned())
    } else {
        None
    }
}

/// One entry's value, in words: the enumerations, the photographer's
/// forms for exposure, and the plain numbers for everything else.
fn format_value(dir: Dir, t: &Tiff, tag: u16, e: usize, kind: u16, n: u32) -> Option<String> {
    if dir == Dir::PanasonicNote {
        return panasonic_note_value(t, tag, e, kind, n);
    }
    if kind == ASCII {
        let text = t.ascii(e, kind, n)?;
        if dir == Dir::Gps {
            let word = match (tag, text.as_str()) {
                (0x0001 | 0x0013, "N") => "North",
                (0x0001 | 0x0013, "S") => "South",
                (0x0003 | 0x0015, "E") => "East",
                (0x0003 | 0x0015, "W") => "West",
                (0x000c | 0x0019, "K") => if tag == 0x000c { "km/h" } else { "Kilometers" },
                (0x000c, "M") => "mph",
                (0x0019, "M") => "Miles",
                (0x000c | 0x0019, "N") => if tag == 0x000c { "knots" } else { "Nautical Miles" },
                (0x000e | 0x0010 | 0x0017, "T") => "True North",
                (0x000e | 0x0010 | 0x0017, "M") => "Magnetic North",
                (0x0009, "A") => "Measurement Active",
                (0x0009, "V") => "Measurement Void",
                (0x000a, "2") => "2-Dimensional Measurement",
                (0x000a, "3") => "3-Dimensional Measurement",
                _ => return Some(text),
            };
            return Some(word.to_string());
        }
        return Some(text);
    }
    if dir == Dir::Gps {
        let v = numbers(t, e, kind, n);
        return match tag {
            0x0000 => Some(v.iter().map(|x| num(*x)).collect::<Vec<_>>().join(".")),
            0x0002 | 0x0004 | 0x0014 | 0x0016 => dms(&v),
            0x0005 => Some(match v.first().map(|x| *x as u32) {
                Some(0) => "Above Sea Level".into(),
                Some(1) => "Below Sea Level".into(),
                _ => v.iter().map(|x| num(*x)).collect::<Vec<_>>().join(" "),
            }),
            0x0006 => v.first().map(|x| format!("{} m", num(*x))),
            0x0007 => (v.len() == 3).then(|| format!("{:02}:{:02}:{:02}", v[0] as u32, v[1] as u32, v[2] as u32)),
            0x001f => v.first().map(|x| format!("{} m", num(*x))),
            _ => Some(v.iter().map(|x| num(*x)).collect::<Vec<_>>().join(" ")),
        };
    }
    match tag {
        0x829a => {
            // Exposure time as the camera wrote it: 1/76, or 2.5 for a
            // long one.
            let (a, b) = first_ratio(t, e, kind, n)?;
            if a == 0 || b == 0 {
                return Some("0".into());
            }
            let v = a as f64 / b as f64;
            return Some(if v < 1.0 { format!("1/{}", num(1.0 / v)) } else { num(v) });
        }
        0x829d | 0x9202 | 0x9205 => {
            let v = *numbers(t, e, kind, n).first()?;
            // Aperture Value is APEX; F Number is the f-stop itself.
            let f = if tag == 0x829d { v } else { 2f64.powf(v / 2.0) };
            return Some(num((f * 10.0).round() / 10.0));
        }
        0x9201 => {
            let v = *numbers(t, e, kind, n).first()?;
            let secs = 2f64.powf(-v);
            return Some(if secs < 1.0 { format!("1/{}", num((1.0 / secs).round())) } else { num(secs) });
        }
        0x920a => {
            let v = *numbers(t, e, kind, n).first()?;
            return Some(format!("{} mm", num((v * 10.0).round() / 10.0)));
        }
        0xa405 => {
            let v = *numbers(t, e, kind, n).first()?;
            return Some(format!("{} mm", num(v)));
        }
        0x9204 => {
            let v = *numbers(t, e, kind, n).first()?;
            return Some(if v > 0.0 { format!("+{}", num(v)) } else { num(v) });
        }
        0x9206 => {
            let v = *numbers(t, e, kind, n).first()?;
            return Some(format!("{} m", num(v)));
        }
        0x9209 => return numbers(t, e, kind, n).first().map(|v| flash_words(*v as u32)),
        0x9000 | 0xa000 => {
            if let Some(v) = version_digits(t, e, kind, n) {
                return Some(v);
            }
        }
        0x9101 => {
            let v = numbers(t, e, kind, n);
            let name = |c: f64| match c as u32 {
                0 => "-",
                1 => "Y",
                2 => "Cb",
                3 => "Cr",
                4 => "R",
                5 => "G",
                6 => "B",
                _ => "?",
            };
            return Some(v.iter().map(|c| name(*c)).collect::<Vec<_>>().join(", "));
        }
        0xa432 => {
            let v = numbers(t, e, kind, n);
            if v.len() == 4 {
                let f = |x: f64| num((x * 100.0).round() / 100.0);
                return Some(format!("{}-{}mm f/{}-{}", f(v[0]), f(v[1]), f(v[2]), f(v[3])));
            }
        }
        0x927c => {
            let at = t.value_at(e, kind, n)?;
            let maker = t
                .bytes
                .get(at..at + 16)
                .map(|b| {
                    let end = b.iter().position(|&c| c == 0 || !c.is_ascii_graphic() && c != b' ').unwrap_or(b.len());
                    String::from_utf8_lossy(&b[..end]).trim().to_string()
                })
                .filter(|s| s.len() >= 3);
            return Some(match maker {
                Some(m) => format!("{m} ({n} bytes)"),
                None => format!("({n} bytes)"),
            });
        }
        0x9286 => {
            // User Comment: an eight-byte character code, then the text.
            let at = t.value_at(e, kind, n)?;
            let raw = t.bytes.get(at..at + n as usize)?;
            let text = if raw.len() > 8 && (raw.starts_with(b"ASCII\0\0\0") || raw.starts_with(b"\0\0\0\0\0\0\0\0")) {
                &raw[8..]
            } else {
                raw
            };
            let s = String::from_utf8_lossy(text).trim_matches(char::from(0)).trim().to_string();
            return if s.is_empty() { None } else { Some(s) };
        }
        _ => {}
    }
    if (kind == UNDEFINED && !(n == 1 && matches!(tag, 0xa300 | 0xa301))) || (kind == BYTE && n > 16) {
        return Some(format!("({n} bytes)"));
    }
    let v = numbers(t, e, kind, n);
    if v.is_empty() {
        return None;
    }
    if v.len() == 1 {
        if dir == Dir::PanasonicRaw {
            use crate::panasonic_tags::{raw_enum, raw_scale};
            let x = v[0];
            // Gamma is stored scaled by 1024, 256 or 100 depending on
            // the body (the reference reader's rule): 586 is 2.29.
            if tag == 0x011c {
                let d = if x >= 1024.0 { 1024.0 } else if x >= 256.0 { 256.0 } else { 100.0 };
                return Some(num(x / d));
            }
            if let Some(scale) = raw_scale(tag) {
                return Some(num(x / scale));
            }
            if let Some(word) = raw_enum(tag, x as i64) {
                return Some(word.to_string());
            }
            if tag == 0x0112 {
                if let Some(word) = enumerated(tag, x as u32) {
                    return Some(word.to_string());
                }
            }
            return Some(num(x));
        }
        if let Some(word) = enumerated(tag, v[0] as u32) {
            return Some(word.to_string());
        }
        return Some(num(v[0]));
    }
    let shown: Vec<String> = v.iter().take(16).map(|x| num(*x)).collect();
    let more = if v.len() > 16 { format!(" ... ({} values)", n) } else { String::new() };
    Some(format!("{}{more}", shown.join(" ")))
}

/// Walks one directory into `out`, returning the sub-directories to
/// follow with the kind each one is.
fn walk_ifd(t: &Tiff, ifd: usize, dir: Dir, out: &mut Vec<MetaEntry>) -> Vec<(usize, Dir)> {
    let mut follow = Vec::new();
    let Some(count) = t.u16_at(ifd) else { return follow };
    for i in 0..count.min(512) as usize {
        let e = ifd + 2 + i * 12;
        let (Some(tag), Some(kind), Some(n)) = (t.u16_at(e), t.u16_at(e + 2), t.u32_at(e + 4)) else { continue };
        // Pointers to other directories are followed, not listed.
        match (dir, tag) {
            (_, 0x8769) | (_, 0x8825) | (_, 0xa005) | (Dir::Ifd0, 0x014a) | (Dir::Sub, 0x014a) => {
                let next = match tag {
                    0x8769 => Dir::Exif,
                    0x8825 => Dir::Gps,
                    0xa005 => Dir::Interop,
                    _ => Dir::Sub,
                };
                if let Some(at) = t.value_at(e, kind, n) {
                    if kind == LONG {
                        for k in 0..n.min(8) as usize {
                            if let Some(v) = t.u32_at(at + k * 4) {
                                follow.push((v as usize, next));
                            }
                        }
                    }
                }
                continue;
            }
            _ => {}
        }
        // The XMP packet, when a TIFF carries it as a tag: read as XMP.
        if tag == 0x02bc && matches!(kind, BYTE | UNDEFINED | ASCII) {
            if let Some(at) = t.value_at(e, kind, n) {
                if let Some(raw) = t.bytes.get(at..(at + n as usize).min(t.bytes.len())) {
                    out.extend(xmp_entries(&String::from_utf8_lossy(raw)));
                }
            }
            continue;
        }
        // An RW2's embedded JPEG carries the Exif block the camera
        // really wrote, lens and maker note included; the outer
        // directories are the raw's own. Read it whole.
        if dir == Dir::PanasonicRaw && tag == 0x002e {
            if let Some(at) = t.value_at(e, kind, n) {
                let end = (at + n as usize).min(t.bytes.len());
                if let Some(jpeg) = t.bytes.get(at..end) {
                    if jpeg.starts_with(&[0xff, 0xd8, 0xff]) {
                        out.extend(read_all_metadata(jpeg).into_iter().filter(|m| m.group != "Derived"));
                    }
                }
            }
            continue;
        }
        if tag == 0x927c && dir == Dir::Exif {
            if let Some(at) = t.value_at(e, kind, n) {
                if t.bytes.get(at..at + 12) == Some(b"Panasonic\0\0\0".as_ref()) {
                    let _ = walk_ifd(t, at + 12, Dir::PanasonicNote, out);
                    continue;
                }
            }
        }
        let name = match dir {
            Dir::Gps => gps_tag_name(tag),
            Dir::PanasonicNote => crate::panasonic_tags::note_name(tag),
            Dir::Interop => match tag {
                0x0001 => Some("Interop Index"),
                0x0002 => Some("Interop Version"),
                _ => None,
            },
            Dir::PanasonicRaw => crate::panasonic_tags::raw_name(tag),
            _ => exif_tag_name(tag),
        };
        // Panasonic's private low tags in an RW2's first directory, and
        // any other maker's, would read as nonsense under the TIFF
        // names; only named tags and the clearly-EXIF range are shown
        // by name, the rest by number.
        let name = name.map(|s| s.to_string()).unwrap_or_else(|| format!("Tag 0x{tag:04x}"));
        if let Some(value) = format_value(dir, t, tag, e, kind, n) {
            let mut m = entry(dir.group(), name, value);
            if matches!(dir, Dir::Exif | Dir::Ifd0) && matches!(tag, 0x920a | 0xa405 | 0xa002 | 0xa003 | 0x0100 | 0x0101) {
                m.value_num = numbers(t, e, kind, n).first().copied();
            }
            out.push(m);
        }
    }
    follow
}

/// Every named entry of a TIFF stream, IFD0 first, then its Exif, GPS
/// and Interop directories and any SubIFDs.
pub(crate) fn tiff_entries(bytes: &[u8]) -> Vec<MetaEntry> {
    let little = match bytes.get(0..2) {
        Some(b"II") => true,
        Some(b"MM") => false,
        _ => return Vec::new(),
    };
    let t = Tiff { bytes, little };
    let Some(ifd0) = t.u32_at(4).map(|v| v as usize) else { return Vec::new() };
    if ifd0 < 8 || ifd0 >= bytes.len() {
        return Vec::new();
    }
    // Panasonic writes 0x55 where the magic goes, and its first
    // directory is its own.
    let first = if t.u16_at(2) == Some(0x55) { Dir::PanasonicRaw } else { Dir::Ifd0 };
    let mut out = vec![entry("EXIF", "Exif Byte Order", if little { "Little-endian (Intel, II)" } else { "Big-endian (Motorola, MM)" })];
    let mut thumbnail = Vec::new();
    let mut queue = vec![(ifd0, first)];
    let mut seen = std::collections::HashSet::new();
    while !queue.is_empty() {
        let (ifd, dir) = queue.remove(0);
        if ifd == 0 || ifd >= bytes.len() || !seen.insert(ifd) || seen.len() > 24 {
            continue;
        }
        let more = walk_ifd(&t, ifd, dir, &mut out);
        queue.extend(more);
        // IFD0's next-directory pointer is the thumbnail's IFD1: read,
        // but as the thumbnail's, so its Image Width is not the photo's.
        if dir == Dir::Ifd0 {
            if let Some(count) = t.u16_at(ifd) {
                if let Some(next) = t.u32_at(ifd + 2 + count.min(512) as usize * 12) {
                    if next != 0 {
                        let mut thumb = Vec::new();
                        let _ = walk_ifd(&t, next as usize, Dir::Ifd0, &mut thumb);
                        for mut m in thumb {
                            m.group = "Thumbnail".into();
                            thumbnail.push(m);
                        }
                        seen.insert(next as usize);
                    }
                }
            }
        }
    }
    out.extend(thumbnail);
    out
}

// --- the other segments of a JPEG ----------------------------------------

/// Every APP segment of a JPEG, up to the first scan: (marker, body).
fn jpeg_segments(bytes: &[u8]) -> Vec<(u8, &[u8])> {
    let mut out = Vec::new();
    if bytes.get(0..2) != Some(&[0xFF, 0xD8]) {
        return out;
    }
    let mut at = 2usize;
    while at + 4 <= bytes.len() {
        if bytes[at] != 0xFF {
            break;
        }
        let marker = bytes[at + 1];
        if marker == 0xDA || marker == 0xD9 {
            break;
        }
        let len = u16::from_be_bytes([bytes[at + 2], bytes[at + 3]]) as usize;
        if len < 2 {
            break;
        }
        let Some(body) = bytes.get(at + 4..at + 2 + len) else { break };
        out.push((marker, body));
        at += 2 + len;
    }
    out
}

/// The XMP packet's simple properties: attributes and one-level
/// elements on the description, by their prefixed names. The packet is
/// XML and this is not an XML parser; it reads what every camera and
/// every editor writes in the common form, and leaves nested structures
/// (a face region's coordinates, a history list) as the count of what
/// they hold.
pub fn xmp_entries(xml: &str) -> Vec<MetaEntry> {
    let mut out = Vec::new();
    let doc = xml;
    // Attributes: prefix:Name="value" anywhere on an rdf:Description.
    let mut at = 0usize;
    while let Some(p) = doc[at..].find("<rdf:Description") {
        let start = at + p;
        let Some(endrel) = doc[start..].find('>') else { break };
        let tag = &doc[start..start + endrel];
        for (k, v) in attributes(tag) {
            if k.starts_with("xmlns") || k == "rdf:about" || v.is_empty() {
                continue;
            }
            out.push(entry("XMP", xmp_name(&k), unescape(&v)));
        }
        at = start + endrel + 1;
    }
    // Elements, in one pass with a stack (a search for each element's
    // closing tag was quadratic on a packet of unclosed tags; the
    // review measured 2.6 s on 384 KB). An element whose content is
    // text gives one line; one whose content is a list gives its items
    // joined, or their count when the items are structures; a
    // structure's own children give their lines. Bounded by element
    // count and depth, so no packet can make this expensive.
    const MAX_ELEMENTS: usize = 4096;
    const MAX_DEPTH: usize = 64;
    struct Frame {
        name: String,
        inner_at: usize,
        children: bool,
        items: Vec<String>,
        item_count: usize,
    }
    let mut stack: Vec<Frame> = Vec::new();
    let mut at = 0usize;
    let mut seen = 0usize;
    while let Some(p) = doc[at..].find('<') {
        let start = at + p;
        let rest = &doc[start + 1..];
        let Some(close) = rest.find('>') else { break };
        let head = &rest[..close];
        at = start + 1 + close + 1;
        if head.starts_with('?') || head.starts_with('!') {
            continue;
        }
        if let Some(closing) = head.strip_prefix('/') {
            let name = closing.trim();
            // Pop to the matching open tag; an unmatched close is skipped.
            let Some(depth) = stack.iter().rposition(|f| f.name == name) else { continue };
            let frames: Vec<Frame> = stack.drain(depth..).collect();
            let frame = frames.into_iter().next().expect("drained from depth");
            let inner = &doc[frame.inner_at..start];
            let structural = name.starts_with("rdf:") || name.starts_with("x:");
            if name == "rdf:li" {
                if let Some(parent) = stack.last_mut() {
                    parent.item_count += 1;
                    if !frame.children {
                        let text = inner.trim();
                        if !text.is_empty() {
                            parent.items.push(unescape(text));
                        }
                    }
                }
                continue;
            }
            if let Some(parent) = stack.last_mut() {
                parent.children = true;
            }
            if structural {
                // rdf:Bag, rdf:Seq, rdf:Alt hand their items up.
                if let Some(parent) = stack.last_mut() {
                    parent.items.extend(frame.items);
                    parent.item_count += frame.item_count;
                }
                continue;
            }
            if !name.contains(':') {
                continue;
            }
            if frame.item_count > 0 {
                if !frame.items.is_empty() {
                    out.push(entry("XMP", xmp_name(name), frame.items.join(", ")));
                } else {
                    out.push(entry("XMP", xmp_name(name), format!("({} items)", frame.item_count)));
                }
            } else if !frame.children {
                let text = inner.trim();
                if !text.is_empty() {
                    out.push(entry("XMP", xmp_name(name), unescape(text)));
                }
            }
            continue;
        }
        let name = head.split_whitespace().next().unwrap_or("").to_string();
        if name.is_empty() {
            continue;
        }
        if head.ends_with('/') {
            // Self-closing: attributes only, already read above; it is
            // a child of whatever holds it.
            if let Some(parent) = stack.last_mut() {
                parent.children = true;
                if name == "rdf:li" {
                    parent.item_count += 1;
                }
            }
            continue;
        }
        seen += 1;
        if seen > MAX_ELEMENTS || stack.len() >= MAX_DEPTH {
            break;
        }
        stack.push(Frame { name, inner_at: at, children: false, items: Vec::new(), item_count: 0 });
    }
    out
}

/// The name="value" pairs of one tag's text, quotes of either kind,
/// spaces inside a value kept.
fn attributes(tag: &str) -> Vec<(String, String)> {
    let mut out = Vec::new();
    let b = tag.as_bytes();
    let mut i = tag.find(|c: char| c.is_ascii_whitespace()).unwrap_or(tag.len());
    while i < b.len() {
        while i < b.len() && b[i].is_ascii_whitespace() {
            i += 1;
        }
        let name_start = i;
        while i < b.len() && b[i] != b'=' && !b[i].is_ascii_whitespace() && b[i] != b'/' && b[i] != b'>' {
            i += 1;
        }
        let name = &tag[name_start..i];
        while i < b.len() && b[i].is_ascii_whitespace() { i += 1; }
        if name.is_empty() || i >= b.len() || b[i] != b'=' {
            i += tag[i..].chars().next().map_or(1, char::len_utf8);
            continue;
        }
        i += 1;
        while i < b.len() && b[i].is_ascii_whitespace() { i += 1; }
        let Some(&quote) = b.get(i) else { break };
        if quote != b'"' && quote != b'\'' {
            continue;
        }
        i += 1;
        let value_start = i;
        while i < b.len() && b[i] != quote {
            i += 1;
        }
        out.push((name.to_string(), tag[value_start..i.min(b.len())].to_string()));
        i += 1;
    }
    out
}

/// "xmp:CreatorTool" as "Creator Tool", "photoshop:DateCreated" as
/// "Date Created": the name past the prefix, split at its capitals.
fn xmp_name(qualified: &str) -> String {
    let name = qualified.rsplit(':').next().unwrap_or(qualified);
    let mut out = String::new();
    let chars: Vec<char> = name.chars().collect();
    for (i, c) in chars.iter().enumerate() {
        if i == 0 {
            out.extend(c.to_uppercase());
            continue;
        }
        if c.is_uppercase() && (chars[i - 1].is_lowercase() || chars.get(i + 1).is_some_and(|n| n.is_lowercase())) {
            out.push(' ');
        }
        out.push(*c);
    }
    out
}

fn unescape(s: &str) -> String {
    s.replace("&amp;", "&").replace("&lt;", "<").replace("&gt;", ">").replace("&quot;", "\"").replace("&apos;", "'")
}

/// The header of an ICC profile, in words: what the reference reader prints before
/// the tag table.
pub fn icc_entries(b: &[u8]) -> Vec<MetaEntry> {
    let mut out = Vec::new();
    if b.len() < 132 || b.get(36..40) != Some(b"acsp") {
        return out;
    }
    let four = |at: usize| String::from_utf8_lossy(&b[at..at + 4]).trim_matches(char::from(0)).trim().to_string();
    let u32be = |at: usize| u32::from_be_bytes([b[at], b[at + 1], b[at + 2], b[at + 3]]);
    let g = "ICC Profile";
    let cmm = four(4);
    if !cmm.is_empty() {
        out.push(entry(g, "Profile CMM Type", cmm));
    }
    out.push(entry(g, "Profile Version", format!("{}.{}.{}", b[8], b[9] >> 4, b[9] & 15)));
    let class = match &b[12..16] {
        b"scnr" => "Input Device Profile",
        b"mntr" => "Display Device Profile",
        b"prtr" => "Output Device Profile",
        b"link" => "Device Link Profile",
        b"spac" => "Color Space Conversion Profile",
        b"abst" => "Abstract Profile",
        b"nmcl" => "Named Color Profile",
        _ => "",
    };
    if !class.is_empty() {
        out.push(entry(g, "Profile Class", class));
    }
    out.push(entry(g, "Color Space Data", four(16)));
    out.push(entry(g, "Profile Connection Space", four(20)));
    let year = u16::from_be_bytes([b[24], b[25]]);
    if year > 0 {
        out.push(entry(
            g,
            "Profile Date Time",
            format!(
                "{:04}:{:02}:{:02} {:02}:{:02}:{:02}",
                year,
                u16::from_be_bytes([b[26], b[27]]),
                u16::from_be_bytes([b[28], b[29]]),
                u16::from_be_bytes([b[30], b[31]]),
                u16::from_be_bytes([b[32], b[33]]),
                u16::from_be_bytes([b[34], b[35]])
            ),
        ));
    }
    let platform = four(40);
    if !platform.is_empty() {
        out.push(entry(g, "Primary Platform", platform));
    }
    let manufacturer = four(48);
    if !manufacturer.is_empty() {
        out.push(entry(g, "Device Manufacturer", manufacturer));
    }
    let model = four(52);
    if !model.is_empty() {
        out.push(entry(g, "Device Model", model));
    }
    out.push(
        entry(
            g,
            "Rendering Intent",
            match u32be(64) {
                0 => "Perceptual",
                1 => "Media-Relative Colorimetric",
                2 => "Saturation",
                3 => "ICC-Absolute Colorimetric",
                _ => "Unknown",
            },
        ),
    );
    // The description tag, in either of its two encodings.
    let count = u32be(128) as usize;
    for k in 0..count.min(256) {
        let at = 132 + k * 12;
        if at + 12 > b.len() {
            break;
        }
        let sig = &b[at..at + 4];
        let off = u32be(at + 4) as usize;
        let size = u32be(at + 8) as usize;
        let Some(tag) = off.checked_add(size).and_then(|end| b.get(off..end)) else { continue };
        let name = match sig {
            b"desc" => "Profile Description",
            b"cprt" => "Profile Copyright",
            _ => continue,
        };
        if let Some(text) = icc_text(tag) {
            out.push(entry(g, name, text));
        }
    }
    out
}

/// A 'desc' (v2), 'text' or 'mluc' (v4) tag's text.
fn icc_text(tag: &[u8]) -> Option<String> {
    let kind = tag.get(0..4)?;
    let u32be = |at: usize| tag.get(at..at + 4).map(|s| u32::from_be_bytes([s[0], s[1], s[2], s[3]]));
    let clean = |s: String| {
        let s = s.trim_matches(char::from(0)).trim().to_string();
        (!s.is_empty()).then_some(s)
    };
    match kind {
        b"desc" => {
            let n = u32be(8)? as usize;
            let raw = tag.get(12..12 + n)?;
            clean(String::from_utf8_lossy(raw).into_owned())
        }
        b"text" => clean(String::from_utf8_lossy(tag.get(8..)?).into_owned()),
        b"mluc" => {
            let len = u32be(20)? as usize;
            let off = u32be(24)? as usize;
            let raw = tag.get(off..off + len)?;
            let units: Vec<u16> = raw.chunks_exact(2).map(|c| u16::from_be_bytes([c[0], c[1]])).collect();
            clean(String::from_utf16_lossy(&units))
        }
        _ => None,
    }
}

// --- the whole listing ----------------------------------------------------

/// Everything the file says about itself, grouped and named. The
/// containers are the ones `read_exif` knows: a JPEG's APP segments (the
/// EXIF stream, the XMP packet, the ICC profile, the MPF directory), a
/// Fuji RAF's embedded JPEG, a PNG's eXIf and iTXt chunks, a CR3's CMT
/// boxes, and a bare TIFF-based file (DNG, NEF, ARW, CR2, RW2, TIFF).
pub fn read_all_metadata(bytes: &[u8]) -> Vec<MetaEntry> {
    let mut out = Vec::new();
    let segments = jpeg_segments(bytes);
    if !segments.is_empty() {
        for (marker, body) in &segments {
            match marker {
                0xE0 if body.starts_with(b"JFIF\0") && body.len() >= 7 => {
                    out.push(entry("File", "JFIF Version", format!("{}.{:02}", body[5], body[6])));
                }
                0xE1 if body.starts_with(b"Exif\0\0") => {
                    out.extend(tiff_entries(&body[6..]));
                }
                0xE1 if body.starts_with(b"http://ns.adobe.com/xap/1.0/\0") => {
                    let xml = String::from_utf8_lossy(&body[29..]);
                    out.extend(xmp_entries(&xml));
                }
                0xE2 if body.starts_with(b"ICC_PROFILE\0") && body.len() > 14 => {
                    // The first chunk carries the header and the tag
                    // table; a profile in several chunks has its
                    // description in the first one too.
                    if body[12] == 1 {
                        out.extend(icc_entries(&body[14..]));
                    }
                }
                0xE2 if body.starts_with(b"MPF\0") => {
                    let count = tiff_entries(&body[4..])
                        .iter()
                        .find(|m| m.name == "Tag 0xb001")
                        .and_then(|m| m.value.parse::<u32>().ok());
                    if let Some(n) = count {
                        out.push(entry("File", "Number Of Images", n.to_string()));
                    }
                }
                _ => {}
            }
        }
        return with_derived(out);
    }
    if let Some(jpeg) = crate::exif::raf_jpeg(bytes) {
        return with_derived(read_all_metadata(jpeg));
    }
    if bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        if let Some(stream) = crate::exif::png_exif(bytes) {
            out.extend(tiff_entries(stream));
        }
        if let Some(xml) = crate::exif::png_xmp(bytes) {
            out.extend(xmp_entries(&xml));
        }
        return with_derived(out);
    }
    if let Some(streams) = crate::exif::bmff_tiff_streams(bytes) {
        for s in streams {
            out.extend(tiff_entries(s));
        }
        return with_derived(out);
    }
    with_derived(tiff_entries(bytes))
}

/// The reference reader's "Composite" facts: the ones a photographer reads first,
/// worked out from the readings above.
fn with_derived(out: Vec<MetaEntry>) -> Vec<MetaEntry> {
    // One line per group and name, first reading kept: an RW2's outer
    // Exif directory and its embedded JPEG's both say the shutter.
    let mut seen = std::collections::HashSet::new();
    let mut out: Vec<MetaEntry> = out.into_iter().filter(|m| seen.insert((m.group.clone(), m.name.clone(), m.value.clone()))).collect();
    let find = |name: &str, group: &str| out.iter().find(|m| m.group == group && m.name == name).map(|m| m.value.clone());
    // An RW2's Exif image size is its embedded JPEG's; the raw's own is
    // in Panasonic's note.
    let w = find("Panasonic Image Width", "Panasonic")
        .or_else(|| find("Exif Image Width", "EXIF"))
        .or_else(|| find("Image Width", "EXIF"))
        .and_then(|v| v.parse::<f64>().ok());
    let h = find("Panasonic Image Height", "Panasonic")
        .or_else(|| find("Exif Image Height", "EXIF"))
        .or_else(|| find("Image Height", "EXIF"))
        .and_then(|v| v.parse::<f64>().ok());
    let mut derived = Vec::new();
    if let (Some(w), Some(h)) = (w, h) {
        derived.push(entry("Derived", "Image Size", format!("{}x{}", num(w), num(h))));
        derived.push(entry("Derived", "Megapixels", format!("{:.1}", w * h / 1e6)));
    }
    let find_num = |name: &str, group: &str| out.iter().find(|m| m.group == group && m.name == name).and_then(|m| m.value_num);
    if let (Some(f), Some(f35)) = (find("Focal Length", "EXIF"), find("Focal Length In 35mm Format", "EXIF")) {
        derived.push(entry("Derived", "Focal Length 35mm Equiv", format!("{f} (35 mm equivalent: {f35})")));
        // From the readings, not the rounded text: 120 over 15.66 is
        // 7.7, over the shown 15.7 it would be 7.6.
        if let (Some(a), Some(b)) = (find_num("Focal Length", "EXIF"), find_num("Focal Length In 35mm Format", "EXIF")) {
            if a > 0.0 {
                derived.push(entry("Derived", "Scale Factor To 35 mm Equivalent", format!("{:.1}", b / a)));
            }
        }
    }
    if let (Some(lat), Some(lon)) = (find("GPS Latitude", "GPS"), find("GPS Longitude", "GPS")) {
        let la = find("GPS Latitude Ref", "GPS").unwrap_or_default();
        let lo = find("GPS Longitude Ref", "GPS").unwrap_or_default();
        let hemi = |r: &str, pos: &str, neg: &str| {
            if r.starts_with(neg) { neg[..1].to_string() } else if r.starts_with(pos) { pos[..1].to_string() } else { String::new() }
        };
        derived.push(entry(
            "Derived",
            "GPS Position",
            format!("{lat} {}, {lon} {}", hemi(&la, "North", "South"), hemi(&lo, "East", "West")).replace("  ", " ").trim().to_string(),
        ));
    }
    out.extend(derived);
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn le16(v: u16) -> [u8; 2] {
        v.to_le_bytes()
    }

    /// A little-endian TIFF with IFD0, an Exif directory and a GPS
    /// directory, every value inline or in a shared value area.
    fn photograph() -> Vec<u8> {
        type F = (u16, u16, u32, Vec<u8>);
        let ascii = |tag: u16, s: &str| -> F {
            let mut b = s.as_bytes().to_vec();
            b.push(0);
            (tag, ASCII, b.len() as u32, b)
        };
        let short = |tag: u16, v: u16| -> F { (tag, SHORT, 1, le16(v).to_vec()) };
        let long = |tag: u16, v: u32| -> F { (tag, LONG, 1, v.to_le_bytes().to_vec()) };
        let ratio = |tag: u16, pairs: &[(u32, u32)]| -> F {
            let mut b = Vec::new();
            for (n, d) in pairs {
                b.extend_from_slice(&n.to_le_bytes());
                b.extend_from_slice(&d.to_le_bytes());
            }
            (tag, RATIONAL, pairs.len() as u32, b)
        };
        let sratio = |tag: u16, n: i32, d: i32| -> F {
            let mut b = n.to_le_bytes().to_vec();
            b.extend_from_slice(&d.to_le_bytes());
            (tag, SRATIONAL, 1, b)
        };
        let undef = |tag: u16, b: &[u8]| -> F { (tag, UNDEFINED, b.len() as u32, b.to_vec()) };

        // Layout: header 8, IFD0, Exif IFD, GPS IFD, then values.
        let ifd0: Vec<F> = vec![
            ascii(0x010f, "Apple"),
            ascii(0x0110, "iPhone 15 Pro Max"),
            short(0x0112, 1),
            short(0x0128, 2),
            ascii(0x0131, "18.6.2"),
            ascii(0x0132, "2025:08:23 13:39:13"),
            short(0x0213, 1),
        ];
        let exif: Vec<F> = vec![
            ratio(0x829a, &[(1, 76)]),
            ratio(0x829d, &[(28, 10)]),
            short(0x8822, 2),
            short(0x8827, 250),
            undef(0x9000, b"0232"),
            sratio(0x9204, 0, 1),
            short(0x9207, 3),
            short(0x9209, 16),
            ratio(0x920a, &[(157, 10)]),
            undef(0x927c, b"Apple iOS\0\0\x01MM\0\x10"),
            short(0xa001, 0xffff),
            long(0xa002, 4032),
            long(0xa003, 3024),
            short(0xa401, 8),
            short(0xa405, 120),
            ratio(0xa432, &[(222, 100), (1566, 100), (178, 100), (28, 10)]),
            ascii(0xa434, "iPhone 15 Pro Max back triple camera 15.66mm f/2.8"),
            short(0xffee, 7),
            undef(0xa301, b"\x01"),
        ];
        let gps: Vec<F> = vec![
            ascii(0x0001, "N"),
            ratio(0x0002, &[(45, 1), (58, 1), (5911, 100)]),
            ascii(0x0003, "W"),
            ratio(0x0004, &[(84, 1), (15, 1), (1502, 100)]),
            (0x0005, BYTE, 1, vec![0]),
            ratio(0x0006, &[(1795, 10)]),
        ];
        let dir_len = |d: &[F]| 2 + d.len() * 12 + 4;
        let ifd0_at = 8usize;
        let exif_at = ifd0_at + dir_len(&ifd0) + 2 * 12; // two pointer entries added to ifd0
        let gps_at = exif_at + dir_len(&exif);
        let values_at = gps_at + dir_len(&gps);
        let mut values = Vec::new();
        let write = |mut fields: Vec<F>, values: &mut Vec<u8>| -> Vec<u8> {
            fields.sort_by_key(|f| f.0);
            let mut out = Vec::new();
            out.extend_from_slice(&le16(fields.len() as u16));
            for (tag, kind, count, payload) in &fields {
                out.extend_from_slice(&le16(*tag));
                out.extend_from_slice(&le16(*kind));
                out.extend_from_slice(&count.to_le_bytes());
                if payload.len() <= 4 {
                    let mut inline = payload.clone();
                    inline.resize(4, 0);
                    out.extend_from_slice(&inline);
                } else {
                    out.extend_from_slice(&((values_at + values.len()) as u32).to_le_bytes());
                    values.extend_from_slice(payload);
                    if values.len() % 2 == 1 {
                        values.push(0);
                    }
                }
            }
            out.extend_from_slice(&0u32.to_le_bytes());
            out
        };
        let mut ifd0 = ifd0;
        ifd0.push(long(0x8769, exif_at as u32));
        ifd0.push(long(0x8825, gps_at as u32));
        let d0 = write(ifd0, &mut values);
        let d1 = write(exif, &mut values);
        let d2 = write(gps, &mut values);
        assert_eq!(8 + d0.len(), exif_at);
        assert_eq!(exif_at + d1.len(), gps_at);
        let mut out = Vec::new();
        out.extend_from_slice(b"II");
        out.extend_from_slice(&le16(42));
        out.extend_from_slice(&(ifd0_at as u32).to_le_bytes());
        out.extend_from_slice(&d0);
        out.extend_from_slice(&d1);
        out.extend_from_slice(&d2);
        out.extend_from_slice(&values);
        out
    }

    fn value_of(list: &[MetaEntry], group: &str, name: &str) -> Option<String> {
        list.iter().find(|m| m.group == group && m.name == name).map(|m| m.value.clone())
    }

    #[test]
    fn every_directory_is_walked_and_named_the_way_the_reference_reader_names_it() {
        let list = read_all_metadata(&photograph());
        let v = |g: &str, n: &str| value_of(&list, g, n);
        assert_eq!(v("EXIF", "Make").as_deref(), Some("Apple"));
        assert_eq!(v("EXIF", "Camera Model Name").as_deref(), Some("iPhone 15 Pro Max"));
        assert_eq!(v("EXIF", "Orientation").as_deref(), Some("Horizontal (normal)"));
        assert_eq!(v("EXIF", "Resolution Unit").as_deref(), Some("inches"));
        assert_eq!(v("EXIF", "Y Cb Cr Positioning").as_deref(), Some("Centered"));
        assert_eq!(v("EXIF", "Exposure Time").as_deref(), Some("1/76"));
        assert_eq!(v("EXIF", "F Number").as_deref(), Some("2.8"));
        assert_eq!(v("EXIF", "Exposure Program").as_deref(), Some("Program AE"));
        assert_eq!(v("EXIF", "ISO").as_deref(), Some("250"));
        assert_eq!(v("EXIF", "Exif Version").as_deref(), Some("0232"));
        assert_eq!(v("EXIF", "Exposure Compensation").as_deref(), Some("0"));
        assert_eq!(v("EXIF", "Metering Mode").as_deref(), Some("Spot"));
        assert_eq!(v("EXIF", "Flash").as_deref(), Some("Off, Did not fire"));
        assert_eq!(v("EXIF", "Focal Length").as_deref(), Some("15.7 mm"));
        assert_eq!(v("EXIF", "Maker Note").as_deref(), Some("Apple iOS (16 bytes)"));
        assert_eq!(v("EXIF", "Color Space").as_deref(), Some("Uncalibrated"));
        assert_eq!(v("EXIF", "Custom Rendered").as_deref(), Some("Portrait"));
        assert_eq!(v("EXIF", "Focal Length In 35mm Format").as_deref(), Some("120 mm"));
        assert_eq!(v("EXIF", "Lens Info").as_deref(), Some("2.22-15.66mm f/1.78-2.8"));
        assert_eq!(v("EXIF", "Lens Model").as_deref(), Some("iPhone 15 Pro Max back triple camera 15.66mm f/2.8"));
        // A tag the table does not know is still shown, by number.
        assert_eq!(v("EXIF", "Tag 0xffee").as_deref(), Some("7"));
        // The pointers are followed, not listed.
        assert!(v("EXIF", "Exif Offset").is_none());
        assert!(v("EXIF", "GPS Info").is_none());
        // GPS, in degrees, minutes and seconds.
        assert_eq!(v("GPS", "GPS Latitude Ref").as_deref(), Some("North"));
        assert_eq!(v("GPS", "GPS Latitude").as_deref(), Some("45 deg 58' 59.11\""));
        assert_eq!(v("GPS", "GPS Longitude").as_deref(), Some("84 deg 15' 15.02\""));
        assert_eq!(v("GPS", "GPS Altitude Ref").as_deref(), Some("Above Sea Level"));
        assert_eq!(v("GPS", "GPS Altitude").as_deref(), Some("179.5 m"));
        // Derived.
        assert_eq!(v("Derived", "Image Size").as_deref(), Some("4032x3024"));
        assert_eq!(v("Derived", "Megapixels").as_deref(), Some("12.2"));
        assert_eq!(v("Derived", "Scale Factor To 35 mm Equivalent").as_deref(), Some("7.6"));
        assert_eq!(v("Derived", "GPS Position").as_deref(), Some("45 deg 58' 59.11\" N, 84 deg 15' 15.02\" W"));
        assert_eq!(v("EXIF", "Scene Type").as_deref(), Some("Directly photographed"));
        // IFD0 before Exif before GPS, as the reference reader lists them.
        let g: Vec<&str> = list.iter().map(|m| m.group.as_str()).collect();
        let first = |name: &str| g.iter().position(|x| *x == name).unwrap();
        assert!(first("EXIF") < first("GPS") && first("GPS") < first("Derived"));
    }

    #[test]
    fn a_jpeg_lists_its_xmp_packet_and_icc_profile_beside_the_exif() {
        let tiff = photograph();
        let xmp = concat!(
            "<?xpacket begin='' id='W5M0MpCehiHzreSzNTczkc9d'?>",
            "<x:xmpmeta xmlns:x='adobe:ns:meta/'><rdf:RDF xmlns:rdf='http://www.w3.org/1999/02/22-rdf-syntax-ns#'>",
            "<rdf:Description rdf:about='' xmlns:xmp='http://ns.adobe.com/xap/1.0/' xmlns:dc='http://purl.org/dc/elements/1.1/' ",
            "xmp:CreatorTool=\"18.6.2\" photoshop:DateCreated=\"2025:08:23 13:39:13\">",
            "<dc:subject><rdf:Bag><rdf:li>wedding</rdf:li><rdf:li>smith &amp; co</rdf:li></rdf:Bag></dc:subject>",
            "<xmp:Rating>4</xmp:Rating>",
            "</rdf:Description></rdf:RDF></x:xmpmeta><?xpacket end='w'?>"
        );
        // A v2 profile: header, one 'desc' tag.
        let desc_text = b"Display P3";
        let mut desc = b"desc\0\0\0\0".to_vec();
        desc.extend_from_slice(&(desc_text.len() as u32 + 1).to_be_bytes());
        desc.extend_from_slice(desc_text);
        desc.push(0);
        let mut icc = vec![0u8; 128];
        let tag_at = 128 + 4 + 12;
        icc[0..4].copy_from_slice(&((tag_at + desc.len()) as u32).to_be_bytes());
        icc[4..8].copy_from_slice(b"appl");
        icc[8] = 4;
        icc[12..16].copy_from_slice(b"mntr");
        icc[16..20].copy_from_slice(b"RGB ");
        icc[20..24].copy_from_slice(b"XYZ ");
        icc[24..26].copy_from_slice(&2022u16.to_be_bytes());
        icc[26..28].copy_from_slice(&1u16.to_be_bytes());
        icc[28..30].copy_from_slice(&1u16.to_be_bytes());
        icc[36..40].copy_from_slice(b"acsp");
        icc[40..44].copy_from_slice(b"APPL");
        icc[48..52].copy_from_slice(b"appl");
        icc[64..68].copy_from_slice(&0u32.to_be_bytes());
        icc.extend_from_slice(&1u32.to_be_bytes());
        icc.extend_from_slice(b"desc");
        icc.extend_from_slice(&(tag_at as u32).to_be_bytes());
        icc.extend_from_slice(&(desc.len() as u32).to_be_bytes());
        icc.extend_from_slice(&desc);

        let seg = |marker: u8, body: &[u8]| {
            let mut s = vec![0xFF, marker];
            s.extend_from_slice(&((body.len() + 2) as u16).to_be_bytes());
            s.extend_from_slice(body);
            s
        };
        let mut jpeg = vec![0xFF, 0xD8];
        jpeg.extend(seg(0xE0, b"JFIF\0\x01\x01\0\0\x48\0\x48\0\0"));
        let mut app1 = b"Exif\0\0".to_vec();
        app1.extend_from_slice(&tiff);
        jpeg.extend(seg(0xE1, &app1));
        let mut xmp_seg = b"http://ns.adobe.com/xap/1.0/\0".to_vec();
        xmp_seg.extend_from_slice(xmp.as_bytes());
        jpeg.extend(seg(0xE1, &xmp_seg));
        let mut icc_seg = b"ICC_PROFILE\0\x01\x01".to_vec();
        icc_seg.extend_from_slice(&icc);
        jpeg.extend(seg(0xE2, &icc_seg));
        jpeg.extend_from_slice(&[0xFF, 0xDA, 0, 2, 0xFF, 0xD9]);

        let list = read_all_metadata(&jpeg);
        let v = |g: &str, n: &str| value_of(&list, g, n);
        assert_eq!(v("File", "JFIF Version").as_deref(), Some("1.01"));
        assert_eq!(v("EXIF", "Make").as_deref(), Some("Apple"));
        assert_eq!(v("GPS", "GPS Altitude").as_deref(), Some("179.5 m"));
        assert_eq!(v("XMP", "Creator Tool").as_deref(), Some("18.6.2"));
        assert_eq!(v("XMP", "Date Created").as_deref(), Some("2025:08:23 13:39:13"));
        assert_eq!(v("XMP", "Subject").as_deref(), Some("wedding, smith & co"));
        assert_eq!(v("XMP", "Rating").as_deref(), Some("4"));
        assert_eq!(v("ICC Profile", "Profile CMM Type").as_deref(), Some("appl"));
        assert_eq!(v("ICC Profile", "Profile Version").as_deref(), Some("4.0.0"));
        assert_eq!(v("ICC Profile", "Profile Class").as_deref(), Some("Display Device Profile"));
        assert_eq!(v("ICC Profile", "Color Space Data").as_deref(), Some("RGB"));
        assert_eq!(v("ICC Profile", "Profile Date Time").as_deref(), Some("2022:01:01 00:00:00"));
        assert_eq!(v("ICC Profile", "Rendering Intent").as_deref(), Some("Perceptual"));
        assert_eq!(v("ICC Profile", "Profile Description").as_deref(), Some("Display P3"));
        // Nothing, honestly, from a file with nothing to say.
        assert!(read_all_metadata(&[0u8; 64]).is_empty());
        assert!(read_all_metadata(b"").is_empty());
    }

    #[test]
    fn an_rw2s_first_directory_reads_by_panasonics_table_and_its_xmp_tag_as_xmp() {
        // Header magic 0x55, IFD0 with sensor size, a white balance
        // level, the make, and an XMP tag.
        let xmp = b"<rdf:Description xmp:Rating=\"5\"/>";
        let entries: Vec<(u16, u16, u32, Vec<u8>)> = vec![
            (0x0002, SHORT, 1, 6072u16.to_le_bytes().to_vec()),
            (0x0024, SHORT, 1, 535u16.to_le_bytes().to_vec()),
            (0x011c, SHORT, 1, 586u16.to_le_bytes().to_vec()),
            (0x010f, ASCII, 10, b"Panasonic\0".to_vec()),
            (0x02bc, BYTE, xmp.len() as u32, xmp.to_vec()),
        ];
        let ifd_at = 8usize;
        let values_at = ifd_at + 2 + entries.len() * 12 + 4;
        let mut values = Vec::new();
        let mut dir = Vec::new();
        dir.extend_from_slice(&le16(entries.len() as u16));
        for (tag, kind, count, payload) in &entries {
            dir.extend_from_slice(&le16(*tag));
            dir.extend_from_slice(&le16(*kind));
            dir.extend_from_slice(&count.to_le_bytes());
            if payload.len() <= 4 {
                let mut inline = payload.clone();
                inline.resize(4, 0);
                dir.extend_from_slice(&inline);
            } else {
                dir.extend_from_slice(&((values_at + values.len()) as u32).to_le_bytes());
                values.extend_from_slice(payload);
            }
        }
        dir.extend_from_slice(&0u32.to_le_bytes());
        let mut rw2 = b"II".to_vec();
        rw2.extend_from_slice(&le16(0x55));
        rw2.extend_from_slice(&(ifd_at as u32).to_le_bytes());
        rw2.extend_from_slice(&dir);
        rw2.extend_from_slice(&values);
        let list = read_all_metadata(&rw2);
        assert_eq!(value_of(&list, "Panasonic", "Sensor Width").as_deref(), Some("6072"));
        assert_eq!(value_of(&list, "Panasonic", "WB Red Level").as_deref(), Some("535"));
        assert_eq!(value_of(&list, "Panasonic", "Gamma").as_deref(), Some("2.2891"), "586 over 256, not Planar Configuration");
        assert_eq!(value_of(&list, "Panasonic", "Make").as_deref(), Some("Panasonic"));
        assert_eq!(value_of(&list, "XMP", "Rating").as_deref(), Some("5"));
        assert!(value_of(&list, "EXIF", "Planar Configuration").is_none());
    }

    #[test]
    fn panasonics_maker_note_reads_by_its_own_table() {
        // Inline values only, since this builder cannot know absolute
        // offsets: the lens name is short on purpose.
        let mut note = b"Panasonic\0\0\0".to_vec();
        let fields: Vec<(u16, u16, u32, [u8; 4])> = vec![
            (0x02, UNDEFINED, 4, [0, 3, 0, 0]),
            (0x03, SHORT, 1, [2, 0, 0, 0]),
            (0x1a, SHORT, 1, [2, 0, 0, 0]),
            (0x29, LONG, 1, 5757u32.to_le_bytes()),
            (0x51, ASCII, 4, *b"60mm"),
            (0x89, SHORT, 1, [1, 0, 0, 0]),
            (0x90, 8, 1, [(-18i16).to_le_bytes()[0], (-18i16).to_le_bytes()[1], 0, 0]),
            (0x91, SHORT, 1, [74, 0, 0, 0]),
            (0x9f, SHORT, 1, [0, 0, 0, 0]),
            (0xbe, SHORT, 1, [1, 0, 0, 0]),
            (0xad, SHORT, 2, [3, 0, 0xfe, 0xff]),
        ];
        note.extend_from_slice(&le16(fields.len() as u16));
        for (tag, kind, count, inline) in &fields {
            note.extend_from_slice(&le16(*tag));
            note.extend_from_slice(&le16(*kind));
            note.extend_from_slice(&count.to_le_bytes());
            note.extend_from_slice(inline);
        }
        note.extend_from_slice(&0u32.to_le_bytes());
        // A TIFF whose Exif directory holds only the note.
        let ifd0_at = 8usize;
        let exif_at = ifd0_at + 2 + 12 + 4;
        let values_at = exif_at + 2 + 12 + 4;
        let mut out = b"II".to_vec();
        out.extend_from_slice(&le16(42));
        out.extend_from_slice(&(ifd0_at as u32).to_le_bytes());
        out.extend_from_slice(&le16(1));
        out.extend_from_slice(&le16(0x8769));
        out.extend_from_slice(&le16(LONG));
        out.extend_from_slice(&1u32.to_le_bytes());
        out.extend_from_slice(&(exif_at as u32).to_le_bytes());
        out.extend_from_slice(&0u32.to_le_bytes());
        out.extend_from_slice(&le16(1));
        out.extend_from_slice(&le16(0x927c));
        out.extend_from_slice(&le16(UNDEFINED));
        out.extend_from_slice(&(note.len() as u32).to_le_bytes());
        out.extend_from_slice(&(values_at as u32).to_le_bytes());
        out.extend_from_slice(&0u32.to_le_bytes());
        out.extend_from_slice(&note);
        let list = read_all_metadata(&out);
        let v = |n: &str| value_of(&list, "Panasonic", n);
        assert_eq!(v("Firmware Version").as_deref(), Some("0.3.0.0"));
        assert_eq!(v("White Balance").as_deref(), Some("Daylight"));
        assert_eq!(v("Image Stabilization").as_deref(), Some("On, Optical"));
        assert_eq!(v("Time Since Power On").as_deref(), Some("00:00:57.57"));
        assert_eq!(v("Lens Type").as_deref(), Some("60mm"));
        assert_eq!(v("Photo Style").as_deref(), Some("Standard or Custom"));
        assert_eq!(v("Roll Angle").as_deref(), Some("-1.8"));
        assert_eq!(v("Pitch Angle").as_deref(), Some("-7.4"), "nose-up positive, as the reference reader shows it");
        // The review's catches (2026-09-23): 0xbe's words start at one,
        // 0xad is Highlight Shadow, both read off the reference reader's own table.
        assert_eq!(v("Long Exposure NR Used").as_deref(), Some("No"));
        assert_eq!(v("Highlight Shadow").as_deref(), Some("3 -2"));
        assert!(v("Time Stamp").is_none());
        assert_eq!(v("Shutter Type").as_deref(), Some("Mechanical"));
        assert!(value_of(&list, "EXIF", "Maker Note").is_none(), "decoded, not folded");
    }

    #[test]
    fn the_xmp_reader_splits_names_and_counts_what_it_cannot_flatten() {
        assert_eq!(xmp_name("xmp:CreatorTool"), "Creator Tool");
        assert_eq!(xmp_name("photoshop:DateCreated"), "Date Created");
        assert_eq!(xmp_name("exif:GPSAltitude"), "GPS Altitude");
        assert_eq!(xmp_name("xmp:Rating"), "Rating");
        assert_eq!(xmp_name("dc:subject"), "Subject");
        let list = xmp_entries(
            "<rdf:Description xmlns:x='a'><mwg-rs:Regions><rdf:Bag><rdf:li><rdf:Description mwg-rs:Type='Focus'/></rdf:li></rdf:Bag></mwg-rs:Regions></rdf:Description>",
        );
        assert_eq!(value_of(&list, "XMP", "Regions").as_deref(), Some("(1 items)"));
        assert_eq!(value_of(&list, "XMP", "Type").as_deref(), Some("Focus"));
    }

    #[test]
    fn flash_reads_the_way_the_reference_reader_prints_it() {
        assert_eq!(flash_words(0), "Did not fire");
        assert_eq!(flash_words(1), "Fired");
        assert_eq!(flash_words(16), "Off, Did not fire");
        assert_eq!(flash_words(25), "Auto, Fired");
        assert_eq!(flash_words(32), "Did not fire, No flash function");
        assert_eq!(flash_words(0x4d), "On, Fired, Return not detected, Red-eye reduction");
        assert_eq!(flash_words(0x4f), "On, Fired, Return detected, Red-eye reduction");
    }

    #[test]
    fn png_xmp_without_exif_is_listed_and_truncated_chunks_are_safe() {
        let xml = "<rdf:Description xmp:Rating='4'/>";
        let mut png = b"\x89PNG\r\n\x1a\n\0\0\0\0IEND\0\0\0\0".to_vec();
        crate::exif::embed_png_xmp(&mut png, xml);
        assert_eq!(value_of(&read_all_metadata(&png), "XMP", "Rating").as_deref(), Some("4"));
        let keyword = b"XML:com.adobe.xmp\0";
        for n in 0..5 {
            let mut body = keyword.to_vec();
            body.extend(vec![0; n]);
            let mut broken = b"\x89PNG\r\n\x1a\n".to_vec();
            broken.extend((body.len() as u32).to_be_bytes());
            broken.extend(b"iTXt");
            broken.extend(body);
            broken.extend([0; 4]);
            assert!(crate::exif::png_xmp(&broken).is_none_or(|v| v.is_empty()));
        }
    }

    #[test]
    fn metadata_readers_tolerate_random_truncated_and_hostile_buffers() {
        let seed = photograph();
        let mut rng = 0x61724eu32;
        for trial in 0..512 {
            let mut bytes = seed[..trial.min(seed.len())].to_vec();
            if trial % 2 == 0 {
                for b in &mut bytes {
                    rng ^= rng << 13; rng ^= rng >> 17; rng ^= rng << 5;
                    *b ^= rng as u8;
                }
            }
            let _ = read_all_metadata(&bytes);
            let _ = jpeg_segments(&bytes);
            let _ = icc_entries(&bytes);
            let _ = icc_text(&bytes);
            let _ = crate::exif::png_xmp(&bytes);
            let _ = crate::exif::bmff_tiff_streams(&bytes);
            let t = Tiff { bytes: &bytes, little: trial % 2 == 0 };
            for kind in 1..=12 {
                let _ = numbers(&t, 0, kind, trial as u32);
                let _ = first_ratio(&t, 0, kind, trial as u32);
                let _ = version_digits(&t, 0, kind, trial as u32);
            }
            let text = String::from_utf8_lossy(&bytes);
            let _ = xmp_entries(&text);
            let _ = attributes(&text);
        }
        for text in ["<rdf:Description x:Rating='unfinished", "<x:Tag", "<rdf:Description x:Ġ='v'>", "<rdf:Description x:Rating = '4'/>"] {
            let _ = xmp_entries(text);
        }
        assert_eq!(value_of(&xmp_entries("<rdf:Description xmp:Rating = '4'/>"), "XMP", "Rating").as_deref(), Some("4"));
        let mut icc = vec![0; 144];
        icc[36..40].copy_from_slice(b"acsp");
        icc[128..132].copy_from_slice(&1u32.to_be_bytes());
        icc[132..136].copy_from_slice(b"desc");
        icc[136..144].fill(255);
        let _ = icc_entries(&icc);
        let mut mluc = vec![255; 28]; mluc[..4].copy_from_slice(b"mluc");
        assert!(icc_text(&mluc).is_none());
        let nested = format!("{}text{}", "<x:a>".repeat(200), "</x:a>".repeat(200));
        let _ = xmp_entries(&nested);
    }

    /// The listing over a real file, printed, for the eye. Gated on a
    /// path; never part of the suite.
    #[test]
    #[ignore]
    fn real_file_listing() {
        let Ok(path) = std::env::var("HEELER_META_SAMPLE") else { return };
        let bytes = std::fs::read(path).unwrap();
        for m in read_all_metadata(&bytes) {
            eprintln!("{:<12} {:<36} {}", m.group, m.name, m.value);
        }
    }
}
