//! The export layers' writers, through `finish_export` as every caller
//! reaches them: each kind of layer into its EXR channels and its TIFF
//! sibling, 16-bit and float, at the frame's size and the export's print
//! resolution, and the names a taken one moves to. The layers are built
//! by hand, so a kind no graph in the other tests produces (a depth-fed
//! picture, an empty mask, a Finish layer in a group, out-of-range color)
//! is written here too.
use super::*;
use serde_json::json;

fn graph() -> UiGraph {
    serde_json::from_value(json!({
        "graph_id": "export-layers-writer",
        "nodes": [
            { "id": "src", "type": "heeler.image_source", "enabled": true, "params": {} },
            { "id": "output", "type": "heeler.output", "enabled": true, "params": {} }
        ],
        "connections": [{"from": ["src", "out"], "to": ["output", "in"]}]
    }))
    .unwrap()
}

/// A 4x2 beauty, so every 2x1 layer below is resampled onto the frame.
fn beauty() -> Arc<ImageBuf> {
    Arc::new(ImageBuf::filled(4, 2, [0.3, 0.2, 0.1, 1.0]))
}

fn picture(rgba: [f32; 4]) -> Value {
    Value::Image(Arc::new(ImageBuf::filled(2, 1, rgba)))
}

fn mask(v: f32) -> Value {
    Value::Mask(Arc::new(MaskBuf { width: 2, height: 1, data: vec![v; 2] }))
}

fn layer(name: &str, value: Value, depth: bool, part: &str, alpha: Option<Value>, finish: Option<FinishMeta>) -> ExportLayer {
    ExportLayer { name: name.into(), value, depth, part: part.into(), alpha, finish }
}

fn in_sky() -> Option<FinishMeta> {
    Some(FinishMeta { mode: "screen".into(), opacity: 62.5, group: "Sky".into() })
}

/// One of every kind a TIFF sibling is written from.
fn every_kind() -> Vec<ExportLayer> {
    vec![
        layer("mask", mask(0.4), false, "alpha", None, None),
        layer("cut", picture([0.9, 0.8, 0.7, 0.35]), false, "alpha", None, None),
        layer("cutwired", picture([0.9, 0.8, 0.7, 0.35]), false, "alpha", Some(mask(0.15)), None),
        layer("cutpicture", picture([0.9, 0.8, 0.7, 0.35]), false, "alpha", Some(picture([0.1, 0.1, 0.1, 0.55])), None),
        layer("depthpicture", picture([0.5, 0.25, 1.0, 0.6]), true, "rgb", None, None),
        layer("empty", empty_mask(0, 0), false, "alpha", None, None),
        layer("wide", empty_mask(2, 0), false, "alpha", None, None),
        layer("tall", empty_mask(0, 2), false, "alpha", None, None),
        layer("plain", picture([0.5, 0.25, 0.0, 0.7]), false, "rgb", None, None),
        layer("over", picture([2.0, -0.5, 0.25, 0.7]), false, "rgb", None, None),
        layer("wired", picture([0.5, 0.25, 0.0, 0.7]), false, "rgb", Some(mask(0.2)), None),
        layer("paint", picture([1.5, -0.2, 0.5, 0.8]), false, "rgb", None, in_sky()),
    ]
}

/// Not heeler_io::DEFAULT_DPI, so a sibling that fell back to the
/// default instead of the export's own setting would show it.
const DPI: u32 = 240;

fn empty_mask(width: usize, height: usize) -> Value {
    Value::Mask(Arc::new(MaskBuf { width, height, data: Vec::new() }))
}

struct Written {
    path: String,
    log: Vec<String>,
}

fn export(dest: &Path, format: &str, layers: Vec<ExportLayer>, keep_metadata: bool, allow_overwrite: bool) -> Written {
    export_alpha(dest, format, layers, keep_metadata, allow_overwrite, None)
}

/// `export` with the Output node's alpha port wired to `alpha`.
fn export_alpha(dest: &Path, format: &str, layers: Vec<ExportLayer>, keep_metadata: bool, allow_overwrite: bool, alpha: Option<Value>) -> Written {
    let mut log = Vec::new();
    let keywords = vec!["kept".to_string()];
    let path = finish_export(
        crate::ExportInput {
            graph: &graph(),
            source_path: None,
            source: beauty(),
            smart: &HashMap::new(),
            keywords: &keywords,
            alpha,
            layers,
        },
        dest,
        crate::ExportOptions {
            format,
            quality: 90,
            max_edge: None,
            keep_metadata,
            matte: false,
            scale_percent: None,
            allow_overwrite,
            dpi: DPI,
        },
        |level, msg| log.push(format!("{level}: {msg}")),
    )
    .unwrap();
    Written { path, log }
}

/// A sibling's first directory: samples a pixel, bits a sample, the
/// pixel values, the description and the print resolution.
struct Tiff {
    samples: usize,
    bits: usize,
    values: Vec<f32>,
    description: String,
    dpi: Option<u32>,
}

fn tiff(path: &Path) -> Tiff {
    let bytes = std::fs::read(path).unwrap();
    assert_eq!(&bytes[..2], b"II", "{path:?} is little-endian TIFF");
    let u16_at = |at: usize| u16::from_le_bytes(bytes[at..at + 2].try_into().unwrap()) as usize;
    let u32_at = |at: usize| u32::from_le_bytes(bytes[at..at + 4].try_into().unwrap()) as usize;
    let ifd = u32_at(4);
    let field = |tag: usize| (0..u16_at(ifd)).map(|i| ifd + 2 + i * 12).find(|&at| u16_at(at) == tag);
    // A SHORT or a LONG, by the entry's own type.
    let number = |tag: usize| {
        let at = field(tag).unwrap();
        if u16_at(at + 2) == 3 { u16_at(at + 8) } else { u32_at(at + 8) }
    };
    let (w, h) = (number(256), number(257));
    let samples = number(277);
    let strip = number(273);
    let count = number(279);
    let bits = count * 8 / (w * h * samples);
    let values = match bits {
        16 => bytes[strip..strip + count].chunks_exact(2).map(|b| u16::from_le_bytes(b.try_into().unwrap()) as f32 / 65535.0).collect(),
        32 => bytes[strip..strip + count].chunks_exact(4).map(|b| f32::from_le_bytes(b.try_into().unwrap())).collect(),
        other => panic!("{path:?}: {other} bits a sample"),
    };
    let description = field(270)
        .map(|at| {
            let (n, off) = (u32_at(at + 4), u32_at(at + 8));
            String::from_utf8_lossy(&bytes[off..off + n]).trim_end_matches('\0').to_string()
        })
        .unwrap_or_default();
    let dpi = field(282).map(|at| {
        let off = u32_at(at + 8);
        (u32_at(off) / u32_at(off + 4)) as u32
    });
    Tiff { samples, bits, values, description, dpi }
}

fn close(got: &[f32], want: &[f32], what: &str) {
    assert_eq!(got.len(), want.len(), "{what}: {got:?} against {want:?}");
    for (g, w) in got.iter().zip(want) {
        assert!((g - w).abs() < 1e-4, "{what}: {got:?} against {want:?}");
    }
}

/// Eight pixels of one value, or of one RGBA.
fn grey8(v: f32) -> Vec<f32> {
    vec![v; 8]
}

fn rgba8(px: [f32; 4]) -> Vec<f32> {
    px.repeat(8)
}

#[test]
fn float_tiff_siblings_write_each_kinds_plane_at_the_frame_and_the_print_resolution() {
    let dir = tempfile::tempdir().unwrap();
    let dest = dir.path().join("photo.tif");
    export(&dest, "tiff32", every_kind(), false, false);
    let sibling = |name: &str| tiff(&dir.path().join(format!("photo.{name}.tif")));
    // The grays: the mask as it is, an image's alpha half its fourth
    // sample or the wired alpha (a mask, or a picture's own fourth
    // sample), a depth-fed picture its luma, and an empty mask black.
    let luma = 0.2126 * 0.5 + 0.7152 * 0.25 + 0.0722 * 1.0;
    for (name, want) in [("mask", 0.4), ("cut", 0.35), ("cutwired", 0.15), ("cutpicture", 0.55), ("depthpicture", luma), ("empty", 0.0), ("wide", 0.0), ("tall", 0.0)] {
        let t = sibling(name);
        assert_eq!((t.samples, t.bits), (1, 32), "{name} is a float gray");
        close(&t.values, &grey8(want), name);
        assert_eq!(t.dpi, Some(DPI), "{name} carries the export's print resolution");
        assert!(t.description.contains("float gray"), "{name}: {}", t.description);
    }
    // The pictures: scene-linear as they are, no clamp, the alpha the
    // wired one when the node names one.
    for (name, want) in [("plain", [0.5, 0.25, 0.0, 0.7]), ("over", [2.0, -0.5, 0.25, 0.7]), ("wired", [0.5, 0.25, 0.0, 0.2])] {
        let t = sibling(name);
        assert_eq!((t.samples, t.bits), (4, 32), "{name} is float RGBA");
        close(&t.values, &rgba8(want), name);
        assert_eq!(t.dpi, Some(DPI), "{name} carries the export's print resolution");
        assert_eq!(t.description, format!("Heeler export layer: {name}"));
    }
    // A Finish layer is clamped and linearized; alpha is coverage.
    let t = sibling("paint");
    assert_eq!((t.samples, t.bits), (4, 32));
    close(&t.values, &rgba8([1.0, 0.0, heeler_io::srgb_to_linear(0.5), 0.8]), "paint");
    assert_eq!(t.dpi, Some(DPI));
    assert_eq!(
        t.description,
        "Heeler Finish layer 'paint': mode=screen, opacity=62.5, group=Sky - record only, no reader acts on it; painted display-referred, linearized into scene-linear here, a linear merge will not reproduce the composite"
    );
}

#[test]
fn sixteen_bit_tiff_siblings_pick_the_encoder_each_kind_takes() {
    let dir = tempfile::tempdir().unwrap();
    let dest = dir.path().join("photo.tif");
    export(&dest, "tiff", every_kind(), false, false);
    let sibling = |name: &str| tiff(&dir.path().join(format!("photo.{name}.tif")));
    let srgb = heeler_io::linear_to_srgb;
    let luma = 0.2126 * 0.5 + 0.7152 * 0.25 + 0.0722 * 1.0;
    // The grays are display-encoded like the beauty.
    for (name, want) in [("mask", 0.4), ("cut", 0.35), ("cutwired", 0.15), ("cutpicture", 0.55), ("depthpicture", luma), ("empty", 0.0), ("wide", 0.0), ("tall", 0.0)] {
        let t = sibling(name);
        assert_eq!((t.samples, t.bits), (1, 16), "{name} is a 16-bit gray");
        close(&t.values, &grey8(srgb(want)), name);
        assert_eq!(t.dpi, Some(DPI), "{name} carries the export's print resolution");
    }
    // A picture through the sRGB curve, alpha linear; the encoder clamps.
    for (name, want) in [
        ("plain", [srgb(0.5), srgb(0.25), 0.0, 0.7]),
        ("over", [1.0, 0.0, srgb(0.25), 0.7]),
        ("wired", [srgb(0.5), srgb(0.25), 0.0, 0.2]),
    ] {
        let t = sibling(name);
        assert_eq!((t.samples, t.bits), (4, 16), "{name} is 16-bit RGBA");
        close(&t.values, &rgba8(want), name);
        assert_eq!(t.dpi, Some(DPI), "{name} carries the export's print resolution");
        assert_eq!(t.description, format!("Heeler export layer: {name}"));
    }
    // A Finish layer keeps its display values, no curve.
    let t = sibling("paint");
    assert_eq!((t.samples, t.bits), (4, 16));
    close(&t.values, &rgba8([1.0, 0.0, 0.5, 0.8]), "paint");
    assert_eq!(t.dpi, Some(DPI), "the display-referred sibling carries the print resolution too");
    assert_eq!(
        t.description,
        "Heeler Finish layer 'paint': mode=screen, opacity=62.5, group=Sky - record only, no reader acts on it; display-referred, a linear merge will not reproduce the composite"
    );
}

/// A sibling takes the destination's extension as the main file was
/// written by it, lowercased, and moves past a taken name even when the
/// main file's Replace? was honored; the log names both.
#[test]
fn siblings_follow_the_destinations_extension_and_never_overwrite() {
    let dir = tempfile::tempdir().unwrap();
    let dest = dir.path().join("photo.TIFF");
    std::fs::write(&dest, b"replaced").unwrap();
    let taken = dir.path().join("photo.mask.tiff");
    std::fs::write(&taken, b"not ours").unwrap();
    let w = export(&dest, "tiff", vec![layer("mask", mask(0.4), false, "alpha", None, None), layer("cut", mask(0.5), false, "alpha", None, None)], false, true);
    assert_eq!(w.path, dest.to_string_lossy());
    assert_ne!(std::fs::read(&dest).unwrap(), b"replaced", "the main file's Replace? was honored");
    assert_eq!(std::fs::read(&taken).unwrap(), b"not ours", "a sibling never overwrites");
    close(&tiff(&dir.path().join("photo.mask-2.tiff")).values, &grey8(heeler_io::linear_to_srgb(0.4)), "the moved sibling");
    close(&tiff(&dir.path().join("photo.cut.tiff")).values, &grey8(heeler_io::linear_to_srgb(0.5)), "the free sibling");
    let moved = format!("info: {} already exists; writing {} instead", taken.display(), dir.path().join("photo.mask-2.tiff").display());
    assert_eq!(w.log.iter().filter(|m| m.contains("already exists")).collect::<Vec<_>>(), vec![&moved], "{:?}", w.log);
}

/// The name's extension picks the main file's container (the format only
/// fills in a name without one), so the layers follow the container that
/// was written, not the format asked for. They followed the format: a
/// "tiff" export named photo.png wrote a PNG beside TIFF bytes named
/// photo.mask.png, and said nothing, while a "png" export named
/// other.tif wrote a TIFF and dropped its layers as needing TIFF.
#[test]
fn layers_follow_the_container_the_name_picks() {
    let dir = tempfile::tempdir().unwrap();
    let one = || vec![layer("mask", mask(0.4), false, "alpha", None, None)];
    let png = dir.path().join("photo.png");
    let w = export(&png, "tiff", one(), false, false);
    assert!(std::fs::read(&png).unwrap().starts_with(b"\x89PNG"), "the name picked PNG");
    let mut names: Vec<String> = std::fs::read_dir(dir.path()).unwrap().map(|e| e.unwrap().file_name().to_string_lossy().into_owned()).collect();
    names.sort();
    assert_eq!(names, vec!["photo.png".to_string()], "no TIFF bytes under a .png name");
    assert!(w.log.contains(&"warn: layer 'mask' needs TIFF or EXR; not written".to_string()), "{:?}", w.log);

    let tif = dir.path().join("other.tif");
    let w = export(&tif, "png", one(), false, false);
    assert!(std::fs::read(&tif).unwrap().starts_with(b"II*\0"), "the name picked TIFF");
    close(&tiff(&dir.path().join("other.mask.tif")).values, &grey8(heeler_io::linear_to_srgb(0.4)), "the layer beside the TIFF");
    assert!(!w.log.iter().any(|m| m.contains("needs TIFF")), "{:?}", w.log);
}

/// .tif and .tiff are the one container: a guard that knew only one
/// spelling passed every test before this (the 26.5.1 review's M1).
#[test]
fn layers_follow_either_spelling_of_a_tiff() {
    let dir = tempfile::tempdir().unwrap();
    for (format, name) in [("png", "a.tiff"), ("tiff", "b.TIFF"), ("jpeg", "c.Tif")] {
        let dest = dir.path().join(name);
        let w = export(&dest, format, vec![layer("mask", mask(0.4), false, "alpha", None, None)], false, false);
        assert!(!w.log.iter().any(|m| m.contains("needs TIFF")), "{name}: {:?}", w.log);
        let ext = dest.extension().unwrap().to_string_lossy().into_owned();
        let stem = dest.file_stem().unwrap().to_string_lossy().into_owned();
        close(&tiff(&dir.path().join(format!("{stem}.mask.{ext}"))).values, &grey8(heeler_io::linear_to_srgb(0.4)), name);
    }
}

/// The wired alpha follows the container the name picks too. Asked by
/// the format, a "jpeg" export named .tif wrote a TIFF without its alpha
/// and logged that the format carried none, and a "tiff" export named
/// .jpg never said its alpha was dropped (the 26.5.1 review).
#[test]
fn the_wired_alpha_follows_the_container_the_name_picks() {
    let dir = tempfile::tempdir().unwrap();
    let alpha = || Some(Value::Mask(Arc::new(MaskBuf { width: 4, height: 2, data: vec![0.5; 8] })));
    let tif = dir.path().join("cut.tif");
    let w = export_alpha(&tif, "jpeg", Vec::new(), false, false, alpha());
    let t = tiff(&tif);
    assert_eq!(t.samples, 4, "the TIFF carries the alpha");
    assert!((t.values[3] - 0.5).abs() < 0.01, "at the wired value: {:?}", &t.values[..4]);
    assert!(!w.log.iter().any(|m| m.contains("carries no alpha")), "{:?}", w.log);

    let jpg = dir.path().join("flat.jpg");
    let w = export_alpha(&jpg, "tiff", Vec::new(), false, false, alpha());
    assert!(std::fs::read(&jpg).unwrap().starts_with(&[0xFF, 0xD8]), "the name picked JPEG");
    assert!(w.log.iter().any(|m| m.contains("carries no alpha")), "{:?}", w.log);
}

#[test]
fn exr_layers_pack_each_kind_and_move_a_taken_name() {
    let dir = tempfile::tempdir().unwrap();
    let dest = dir.path().join("photo.exr");
    let layers = vec![
        layer("far", mask(0.3), true, "alpha", None, None),
        layer("mist-2", mask(0.6), false, "alpha", None, None),
        layer("mist-3", mask(0.7), false, "alpha", None, None),
        layer("farpicture", picture([0.1, 0.2, 0.3, 0.45]), true, "rgb", None, None),
        layer("cut", picture([0.9, 0.8, 0.7, 0.35]), false, "alpha", None, None),
        layer("cutwired", picture([0.9, 0.8, 0.7, 0.35]), false, "alpha", Some(mask(0.15)), None),
        layer("empty", Value::Mask(Arc::new(MaskBuf { width: 0, height: 0, data: Vec::new() })), false, "alpha", None, None),
        layer("paint", picture([1.5, -0.2, 0.5, 0.8]), false, "rgb", None, in_sky()),
    ];
    let w = export(&dest, "exr", layers, true, false);
    let p = Path::new(&w.path);
    // Depth is the mist name, so the second depth-fed layer moves past
    // mist-2 and mist-3, which other layers already hold, and the log
    // says so.
    assert_eq!(
        w.log.iter().filter(|m| m.contains("is written as")).collect::<Vec<_>>(),
        vec!["info: export layer 'mist' is written as 'mist-4': the name was taken"],
    );
    assert!(w.log.contains(&"info: the EXR carries no camera record or keywords; nothing was embedded".to_string()), "{:?}", w.log);
    let info = heeler_io::exr_passes::inspect_file(p).unwrap();
    let mut channels = info.channels.clone();
    channels.sort();
    assert_eq!(
        channels,
        ["A", "B", "G", "R", "cut.A", "cutwired.A", "empty.A", "mist-2.A", "mist-3.A", "mist-4.Z", "mist.Z", "paint.A", "paint.B", "paint.G", "paint.R"]
    );
    let names = ["mist.Z", "mist-2.A", "mist-4.Z", "cut.A", "cutwired.A", "empty.A", "paint.A", "mist-3.A"];
    let planes = heeler_io::exr_passes::read_planes_file(p, 0, &names).unwrap();
    // Depth reads the plane's fourth sample (a mask's own value), f32.
    assert_eq!(planes[0], grey8(0.3));
    for (plane, want, what) in [
        (&planes[1], 0.6, "a mask layer"),
        (&planes[2], 0.45, "a depth-fed picture's alpha"),
        (&planes[3], 0.35, "an alpha half's own alpha"),
        (&planes[4], 0.15, "an alpha half's wired alpha"),
        (&planes[5], 0.0, "an empty mask"),
        (&planes[6], 0.8, "a Finish layer's alpha"),
        (&planes[7], 0.7, "a mask layer"),
    ] {
        assert!(plane.iter().all(|v| (v - want).abs() < 0.002), "{what}: {plane:?}");
    }
    // A Finish layer's color is clamped and linearized; straight again
    // in Heeler.
    let back = heeler_io::exr_passes::decode_layer_file(p, "paint").unwrap();
    let want = [1.0, 0.0, heeler_io::srgb_to_linear(0.5), 0.8];
    for (x, y) in [(0, 0), (3, 1)] {
        for c in 0..4 {
            assert!((back.pixel(x, y)[c] - want[c]).abs() < 0.003, "paint {c}: {:?}", back.pixel(x, y));
        }
    }
    // The record: mode, opacity and the group a Finish layer is in.
    let attr = |k: &str| heeler_io::exr_passes::header_text_file(p, k);
    assert_eq!(attr("heeler.layer.paint.mode").as_deref(), Some("screen"));
    assert_eq!(attr("heeler.layer.paint.opacity").as_deref(), Some("62.5"));
    assert_eq!(attr("heeler.layer.paint.group").as_deref(), Some("Sky"));
    assert_eq!(attr("heeler.layer.cut.mode"), None, "only a Finish layer carries a record");
}

#[test]
fn an_exr_without_kept_metadata_says_nothing_of_it() {
    let dir = tempfile::tempdir().unwrap();
    let w = export(&dir.path().join("photo.exr"), "exr", vec![layer("mask", mask(0.4), false, "alpha", None, None)], false, false);
    assert!(!w.log.iter().any(|m| m.contains("nothing was embedded")), "{:?}", w.log);
}

#[test]
fn the_export_resolution_is_not_the_default() {
    assert_ne!(DPI, heeler_io::DEFAULT_DPI, "the sibling checks above would pass on a fallback to the default");
}

/// Three depth-fed layers all resolve to mist with every suffix free:
/// the second takes mist-2, the first free suffix, and the third
/// mist-3, past the name the second just took.
#[test]
fn exr_suffixes_start_at_two_and_skip_the_names_they_just_gave() {
    let dir = tempfile::tempdir().unwrap();
    let layers = vec![
        layer("near", mask(0.2), true, "alpha", None, None),
        layer("middle", mask(0.5), true, "alpha", None, None),
        layer("far", mask(0.8), true, "alpha", None, None),
    ];
    let w = export(&dir.path().join("photo.exr"), "exr", layers, false, false);
    assert_eq!(
        w.log.iter().filter(|m| m.contains("is written as")).collect::<Vec<_>>(),
        vec![
            "info: export layer 'mist' is written as 'mist-2': the name was taken",
            "info: export layer 'mist' is written as 'mist-3': the name was taken",
        ],
    );
    let planes = heeler_io::exr_passes::read_planes_file(Path::new(&w.path), 0, &["mist.Z", "mist-2.Z", "mist-3.Z"]).unwrap();
    // Only mist itself is written f32; the renamed layers are half.
    for (plane, want) in planes.iter().zip([0.2, 0.5, 0.8]) {
        assert!(plane.iter().all(|v| (v - want).abs() < 0.002), "{want}: {plane:?}");
    }
}
