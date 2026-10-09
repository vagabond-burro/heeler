//! The sRGB profile Heeler embeds in exports.
//!
//! Generated, not shipped as an asset, and definitely not read from the
//! OS: the ubiquitous Windows "sRGB Color Space Profile.icm" is the one
//! ICC documents as internally inconsistent (WP26's "type 5"), giving
//! different results per CMM. This is a minimal, well-formed ICC v2
//! matrix/TRC display profile built from the IEC 61966-2-1 constants:
//! D50-adapted primaries, D50 media white (full adaptation, WP26's
//! "type 1", the variant that agrees with the v4 profile), and a
//! 1024-point transfer table. v2 rather than v4 on purpose: it is the
//! compatibility-safe choice for files headed to browsers and mixed
//! consumers.
//!
//! Everything here is fixed data, so the profile bytes are identical on
//! every run and every machine, which is what makes them testable.

use std::sync::OnceLock;

/// D50-adapted sRGB primaries (Bradford), the canonical ICC values.
pub(crate) const R_XYZ: [f64; 3] = [0.436081, 0.222504, 0.013931];
pub(crate) const G_XYZ: [f64; 3] = [0.385071, 0.716888, 0.097077];
pub(crate) const B_XYZ: [f64; 3] = [0.143082, 0.060608, 0.713949];
/// D50 white point, the ICC PCS illuminant.
const D50: [f64; 3] = [0.9642, 1.0, 0.8249];

const DESC: &str = "Heeler sRGB (IEC 61966-2-1)";
const CPRT: &str = "No copyright, use freely";
const TRC_POINTS: usize = 1024;

fn s15f16(v: f64) -> [u8; 4] {
    (((v * 65536.0).round()) as i32).to_be_bytes()
}

fn xyz_tag(v: [f64; 3]) -> Vec<u8> {
    let mut t = Vec::with_capacity(20);
    t.extend_from_slice(b"XYZ ");
    t.extend_from_slice(&[0; 4]);
    for c in v {
        t.extend_from_slice(&s15f16(c));
    }
    t
}

fn curv_tag() -> Vec<u8> {
    let mut t = Vec::with_capacity(12 + TRC_POINTS * 2);
    t.extend_from_slice(b"curv");
    t.extend_from_slice(&[0; 4]);
    t.extend_from_slice(&(TRC_POINTS as u32).to_be_bytes());
    for i in 0..TRC_POINTS {
        let x = i as f32 / (TRC_POINTS - 1) as f32;
        let linear = crate::srgb_to_linear(x).clamp(0.0, 1.0);
        t.extend_from_slice(&((linear * 65535.0).round() as u16).to_be_bytes());
    }
    t
}

/// v2 textDescriptionType: ASCII string plus the fixed-size Unicode and
/// ScriptCode fields the type drags along even when empty.
fn desc_tag(text: &str) -> Vec<u8> {
    let ascii = text.as_bytes();
    let mut t = Vec::new();
    t.extend_from_slice(b"desc");
    t.extend_from_slice(&[0; 4]);
    t.extend_from_slice(&((ascii.len() as u32) + 1).to_be_bytes());
    t.extend_from_slice(ascii);
    t.push(0);
    t.extend_from_slice(&[0; 4]); // Unicode language code
    t.extend_from_slice(&[0; 4]); // Unicode count
    t.extend_from_slice(&[0; 2]); // ScriptCode code
    t.push(0); // Macintosh count
    t.extend_from_slice(&[0; 67]); // Macintosh description
    t
}

fn text_tag(text: &str) -> Vec<u8> {
    let mut t = Vec::new();
    t.extend_from_slice(b"text");
    t.extend_from_slice(&[0; 4]);
    t.extend_from_slice(text.as_bytes());
    t.push(0);
    t
}

fn build() -> Vec<u8> {
    // Tag payloads first; offsets fall out of their sizes. The three TRC
    // tags share one payload, which is allowed and keeps the file small.
    let curve = curv_tag();
    let payloads: Vec<(&[u8; 4], Vec<u8>)> = vec![
        (b"desc", desc_tag(DESC)),
        (b"cprt", text_tag(CPRT)),
        (b"wtpt", xyz_tag(D50)),
        (b"rXYZ", xyz_tag(R_XYZ)),
        (b"gXYZ", xyz_tag(G_XYZ)),
        (b"bXYZ", xyz_tag(B_XYZ)),
    ];
    let trc_sigs: [&[u8; 4]; 3] = [b"rTRC", b"gTRC", b"bTRC"];
    let tag_count = payloads.len() + trc_sigs.len();
    let table_end = 128 + 4 + tag_count * 12;

    // Lay out payloads 4-byte aligned after the tag table.
    let mut body = Vec::new();
    let mut entries: Vec<([u8; 4], u32, u32)> = Vec::new();
    for (sig, payload) in &payloads {
        while (table_end + body.len()) % 4 != 0 {
            body.push(0);
        }
        entries.push((**sig, (table_end + body.len()) as u32, payload.len() as u32));
        body.extend_from_slice(payload);
    }
    while (table_end + body.len()) % 4 != 0 {
        body.push(0);
    }
    let curve_at = (table_end + body.len()) as u32;
    body.extend_from_slice(&curve);
    for sig in trc_sigs {
        entries.push((*sig, curve_at, curve.len() as u32));
    }

    let size = (table_end + body.len()) as u32;
    let mut p = Vec::with_capacity(size as usize);
    // Header, 128 bytes.
    p.extend_from_slice(&size.to_be_bytes());
    p.extend_from_slice(&[0; 4]); // preferred CMM: none
    p.extend_from_slice(&0x02100000u32.to_be_bytes()); // version 2.1.0
    p.extend_from_slice(b"mntr");
    p.extend_from_slice(b"RGB ");
    p.extend_from_slice(b"XYZ ");
    for v in [2026u16, 8, 11, 0, 0, 0] {
        p.extend_from_slice(&v.to_be_bytes()); // creation date
    }
    p.extend_from_slice(b"acsp");
    p.extend_from_slice(&[0; 4]); // platform: none
    p.extend_from_slice(&[0; 4]); // flags
    p.extend_from_slice(&[0; 4]); // device manufacturer
    p.extend_from_slice(&[0; 4]); // device model
    p.extend_from_slice(&[0; 8]); // device attributes
    p.extend_from_slice(&[0; 4]); // rendering intent: perceptual
    for c in D50 {
        p.extend_from_slice(&s15f16(c)); // PCS illuminant
    }
    p.extend_from_slice(&[0; 4]); // creator
    p.resize(128, 0); // profile ID and reserved: zero is permitted
    // Tag table.
    p.extend_from_slice(&(tag_count as u32).to_be_bytes());
    for (sig, off, len) in &entries {
        p.extend_from_slice(sig);
        p.extend_from_slice(&off.to_be_bytes());
        p.extend_from_slice(&len.to_be_bytes());
    }
    p.extend_from_slice(&body);
    debug_assert_eq!(p.len(), size as usize);
    p
}

/// The profile bytes, built once. ~2.5 KB per tagged export.
pub fn srgb_profile() -> &'static [u8] {
    static PROFILE: OnceLock<Vec<u8>> = OnceLock::new();
    PROFILE.get_or_init(build)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn u32_at(p: &[u8], at: usize) -> u32 {
        u32::from_be_bytes(p[at..at + 4].try_into().unwrap())
    }

    fn tag(p: &[u8], sig: &[u8; 4]) -> (usize, usize) {
        let count = u32_at(p, 128) as usize;
        for i in 0..count {
            let e = 132 + i * 12;
            if &p[e..e + 4] == sig {
                return (u32_at(p, e + 4) as usize, u32_at(p, e + 8) as usize);
            }
        }
        panic!("tag {sig:?} missing");
    }

    #[test]
    fn the_profile_is_structurally_sound() {
        let p = srgb_profile();
        assert_eq!(u32_at(p, 0) as usize, p.len(), "declared size matches");
        assert_eq!(&p[36..40], b"acsp", "profile signature");
        assert_eq!(&p[12..16], b"mntr");
        assert_eq!(&p[16..20], b"RGB ");
        assert_eq!(&p[20..24], b"XYZ ");
        for sig in [b"desc", b"cprt", b"wtpt", b"rXYZ", b"gXYZ", b"bXYZ", b"rTRC", b"gTRC", b"bTRC"] {
            let (off, len) = tag(p, sig);
            assert!(off + len <= p.len(), "tag {sig:?} inside the file");
            assert_eq!(off % 4, 0, "tag {sig:?} aligned");
        }
    }

    #[test]
    fn the_matrix_columns_sum_to_the_white_point() {
        // rXYZ + gXYZ + bXYZ must equal D50, or white does not map to
        // white and every CMM renders a cast. This is the property that
        // makes the Windows system profile untrustworthy.
        let p = srgb_profile();
        let read_xyz = |sig: &[u8; 4]| -> [f64; 3] {
            let (off, _) = tag(p, sig);
            [0, 1, 2].map(|i| {
                i32::from_be_bytes(p[off + 8 + i * 4..off + 12 + i * 4].try_into().unwrap()) as f64
                    / 65536.0
            })
        };
        let (r, g, b) = (read_xyz(b"rXYZ"), read_xyz(b"gXYZ"), read_xyz(b"bXYZ"));
        let wtpt = read_xyz(b"wtpt");
        for i in 0..3 {
            let sum = r[i] + g[i] + b[i];
            assert!((sum - D50[i]).abs() < 0.002, "column {i}: {sum} vs D50 {}", D50[i]);
            assert!((wtpt[i] - D50[i]).abs() < 0.0001, "white point is D50");
        }
    }

    #[test]
    fn the_curve_is_the_srgb_transfer_and_monotone() {
        let p = srgb_profile();
        let (off, len) = tag(p, b"rTRC");
        assert_eq!(&p[off..off + 4], b"curv");
        let count = u32_at(p, off + 8) as usize;
        assert_eq!(len, 12 + count * 2);
        let entry = |i: usize| -> f64 {
            u16::from_be_bytes(p[off + 12 + i * 2..off + 14 + i * 2].try_into().unwrap()) as f64
                / 65535.0
        };
        assert_eq!(entry(0), 0.0, "black maps to black");
        assert!((entry(count - 1) - 1.0).abs() < 1e-6, "white maps to white");
        let mut prev = -1.0;
        for i in 0..count {
            let v = entry(i);
            assert!(v >= prev, "curve dipped at {i}");
            prev = v;
        }
        // Spot-check mid-curve against the actual transfer.
        let mid = entry(count / 2);
        let expect = crate::srgb_to_linear(((count / 2) as f32) / (count - 1) as f32) as f64;
        assert!((mid - expect).abs() < 0.001, "mid: {mid} vs {expect}");
        // All three channels share the identical curve.
        assert_eq!(tag(p, b"rTRC"), tag(p, b"gTRC"));
        assert_eq!(tag(p, b"rTRC"), tag(p, b"bTRC"));
    }
}
