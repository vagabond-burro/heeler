//! A DNG's GainMap opcodes (OpcodeList2) reach the develop: the gains
//! multiply the sensor values above black, on the CFA sites each map's
//! pitch names, before demosaic. Built here as a flat 64 by 48 RGGB
//! frame, every site 1064 over a black of 64, so a gain shows up
//! exactly in the developed channel means.

const W: u32 = 64;
const H: u32 = 48;

/// One GainMap opcode with a single gain over the whole frame: `area`
/// is top, left, bottom, right; `pitch` rows then columns.
fn gain_map(area: [u32; 4], pitch: [u32; 2], gain: f32) -> Vec<u8> {
    let mut p = Vec::new();
    for v in [area[0], area[1], area[2], area[3], 0, 1, pitch[0], pitch[1], 1, 1] {
        p.extend_from_slice(&v.to_be_bytes());
    }
    for v in [1.0f64, 1.0, 0.0, 0.0] {
        p.extend_from_slice(&v.to_be_bytes());
    }
    p.extend_from_slice(&1u32.to_be_bytes());
    p.extend_from_slice(&gain.to_be_bytes());
    let mut op = Vec::new();
    for v in [9u32, 0x0103_0000, 0, p.len() as u32] {
        op.extend_from_slice(&v.to_be_bytes());
    }
    op.extend_from_slice(&p);
    op
}

fn opcode_list(ops: &[Vec<u8>]) -> Vec<u8> {
    let mut l = (ops.len() as u32).to_be_bytes().to_vec();
    for op in ops {
        l.extend_from_slice(op);
    }
    l
}

/// An uncompressed 16-bit RGGB DNG, little endian, with `opcodes` as
/// its OpcodeList2 when given.
fn cfa_dng(opcodes: Option<Vec<u8>>) -> Vec<u8> {
    let pixels: Vec<u8> = (0..W * H).flat_map(|_| 1064u16.to_le_bytes()).collect();
    // (tag, type, count, out-of-line bytes or inline value)
    enum V {
        Inline(u32),
        Data(Vec<u8>),
    }
    let rational = |pairs: &[(i32, i32)]| pairs.iter().flat_map(|(n, d)| [n.to_le_bytes(), d.to_le_bytes()].concat()).collect::<Vec<u8>>();
    let mut entries: Vec<(u16, u16, u32, V)> = vec![
        (254, 4, 1, V::Inline(0)),
        (256, 4, 1, V::Inline(W)),
        (257, 4, 1, V::Inline(H)),
        (258, 3, 1, V::Inline(16)),
        (259, 3, 1, V::Inline(1)),
        (262, 3, 1, V::Inline(32803)),
        (271, 2, 5, V::Data(b"Test\0".to_vec())),
        (272, 2, 5, V::Data(b"Flat\0".to_vec())),
        (273, 4, 1, V::Inline(0)), // filled in below
        (277, 3, 1, V::Inline(1)),
        (278, 4, 1, V::Inline(H)),
        (279, 4, 1, V::Inline(pixels.len() as u32)),
        (284, 3, 1, V::Inline(1)),
        (33421, 3, 2, V::Inline(2 | 2 << 16)),
        (33422, 1, 4, V::Inline(u32::from_le_bytes([0, 1, 1, 2]))),
        (50706, 1, 4, V::Inline(u32::from_le_bytes([1, 4, 0, 0]))),
        (50708, 2, 10, V::Data(b"Test Flat\0".to_vec())),
        (50714, 4, 1, V::Inline(64)),
        (50717, 4, 1, V::Inline(4095)),
        // XYZ to linear sRGB: the camera sees in sRGB's own primaries,
        // so the develop's color conversion is the identity and a gain
        // on one CFA color stays in that channel.
        (50721, 10, 9, V::Data(rational(&[(32406, 10000), (-15372, 10000), (-4986, 10000), (-9689, 10000), (18758, 10000), (415, 10000), (557, 10000), (-2040, 10000), (10570, 10000)]))),
        (50728, 5, 3, V::Data(rational(&[(1, 1), (1, 1), (1, 1)]))),
        (50778, 3, 1, V::Inline(21)),
    ];
    if let Some(list) = opcodes {
        entries.push((51009, 7, list.len() as u32, V::Data(list)));
    }
    entries.sort_by_key(|e| e.0);
    let ifd_len = 2 + entries.len() * 12 + 4;
    let mut extra = Vec::new();
    let extra_at = 8 + ifd_len;
    let mut ifd = (entries.len() as u16).to_le_bytes().to_vec();
    let mut strip_entry = 0;
    for (tag, kind, count, v) in &entries {
        ifd.extend_from_slice(&tag.to_le_bytes());
        ifd.extend_from_slice(&kind.to_le_bytes());
        ifd.extend_from_slice(&count.to_le_bytes());
        match v {
            V::Inline(x) => {
                if *tag == 273 {
                    strip_entry = ifd.len();
                }
                ifd.extend_from_slice(&x.to_le_bytes());
            }
            V::Data(d) if d.len() <= 4 => {
                let mut b = d.clone();
                b.resize(4, 0);
                ifd.extend_from_slice(&b);
            }
            V::Data(d) => {
                ifd.extend_from_slice(&((extra_at + extra.len()) as u32).to_le_bytes());
                extra.extend_from_slice(d);
                if extra.len() % 2 == 1 {
                    extra.push(0);
                }
            }
        }
    }
    ifd.extend_from_slice(&0u32.to_le_bytes());
    let strip_at = (extra_at + extra.len()) as u32;
    ifd[strip_entry..strip_entry + 4].copy_from_slice(&strip_at.to_le_bytes());
    let mut out = b"II".to_vec();
    out.extend_from_slice(&42u16.to_le_bytes());
    out.extend_from_slice(&8u32.to_le_bytes());
    out.extend_from_slice(&ifd);
    out.extend_from_slice(&extra);
    out.extend_from_slice(&pixels);
    out
}

/// Mean of each developed channel over the middle of the frame, away
/// from the demosaic's border.
fn means(bytes: &[u8]) -> [f64; 3] {
    let img = heeler_raw::decode_sensor(bytes).unwrap();
    assert_eq!((img.width, img.height), (W as usize, H as usize));
    let mut m = [0f64; 3];
    let mut n = 0f64;
    for y in 12..36 {
        for x in 16..48 {
            for c in 0..3 {
                m[c] += img.rgb[(y * img.width + x) * 3 + c] as f64;
            }
            n += 1.0;
        }
    }
    m.map(|v| v / n)
}

#[test]
fn a_gain_map_scales_the_sensor_values_above_black() {
    let plain = means(&cfa_dng(None));
    assert!(plain.iter().all(|v| *v > 1000.0), "the fixture develops: {plain:?}");
    // Gain 2 on every site. Applied above black the develop doubles;
    // applied to the raw count it would be 2128 - 64 over 1000, 2.064.
    let doubled = means(&cfa_dng(Some(opcode_list(&[gain_map([0, 0, H, W], [1, 1], 2.0)]))));
    for c in 0..3 {
        let ratio = doubled[c] / plain[c];
        assert!((ratio - 2.0).abs() < 0.01, "channel {c}: {ratio:.4}");
    }
}

#[test]
fn a_gain_map_reaches_only_the_sites_its_pitch_names() {
    // RGGB: the red sites are the even rows and columns.
    let plain = means(&cfa_dng(None));
    let red = means(&cfa_dng(Some(opcode_list(&[gain_map([0, 0, H, W], [2, 2], 1.5)]))));
    let ratio = [red[0] / plain[0], red[1] / plain[1], red[2] / plain[2]];
    assert!((ratio[0] - 1.5).abs() < 0.01, "red {ratio:?}");
    assert!((ratio[1] - 1.0).abs() < 0.01 && (ratio[2] - 1.0).abs() < 0.01, "green and blue {ratio:?}");
}

#[test]
fn a_file_without_gain_maps_develops_as_before() {
    // An opcode list holding only other opcodes changes nothing.
    let mut other = Vec::new();
    for v in [3u32, 0x0103_0000, 1, 4, 0] {
        other.extend_from_slice(&v.to_be_bytes());
    }
    assert_eq!(means(&cfa_dng(None)), means(&cfa_dng(Some(opcode_list(&[other])))));
}
