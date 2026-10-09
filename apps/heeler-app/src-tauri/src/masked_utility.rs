//! A mask wired by hand to a Utility node (docs review 2026-10-01: Color
//! Transform, Channel Gain, Channel Mixer, Invert and Blend Mode took a
//! mask in the engine but their cards drew no diamond, so none could be
//! wired). The graph is the app's own: src/__tests__/graphmaskseat.test.ts
//! wires a Radial Mask onto a Color Transform's new diamond through the
//! connect reducer and serializes it. Rendered here at Fit, on the 1:1
//! slice and in the export: the transform applies inside the mask, the
//! photograph stays as it was outside it, and the feather lies between.
use super::*;

const W: usize = 360;
const H: usize = 240;

fn fixture() -> UiGraph {
    named("masked")
}

fn named(name: &str) -> UiGraph {
    let all: serde_json::Map<String, serde_json::Value> =
        serde_json::from_str(include_str!("../../src/__tests__/fixtures/masked-utility.json")).unwrap();
    serde_json::from_value(all[name].clone()).unwrap()
}

/// A saved Grain Field with a mask wired to a diamond the engine has no
/// port for: the load takes the diamond and the wire away (state.ts
/// dropDeadMaskSeats). build_graph had already dropped that wire, so the
/// export before and after the load is the same, pixel for pixel.
#[test]
fn a_dead_mask_seat_taken_away_at_load_changes_nothing_in_the_export() {
    let (before, after) = (named("dead_before"), named("dead_after"));
    let wired = |g: &UiGraph| g.connections.iter().any(|c| c.to.0 == "gf" && c.to.1 == "mask");
    assert!(wired(&before), "the saved graph carries the dead wire");
    assert!(!wired(&after), "the loaded graph does not");
    let (a, b) = (export(&before), export(&after));
    assert_eq!((a.width, a.height), (b.width, b.height));
    assert!(a.data == b.data, "the export is identical before and after the load");
    // And the Grain Field is in the picture, so the comparison means something.
    let off = {
        let mut g = after.clone();
        g.nodes.iter_mut().find(|n| n.id == "gf").unwrap().enabled = false;
        export(&g)
    };
    assert!(a.data.iter().zip(&off.data).any(|(p, q)| (p - q).abs() > 1e-4), "the Grain Field renders");
}

/// The same graph with the mask wire taken off: the transform everywhere.
fn unmasked(ui: &UiGraph) -> UiGraph {
    let mut g = ui.clone();
    let before = g.connections.len();
    g.connections.retain(|c| !(c.to.0 == "ct" && c.to.1 == "mask"));
    assert_eq!(g.connections.len(), before - 1, "the fixture wires the mask to the Color Transform");
    g
}

/// The same graph with the Color Transform bypassed: the photograph.
fn bypassed(ui: &UiGraph) -> UiGraph {
    let mut g = ui.clone();
    g.nodes.iter_mut().find(|n| n.id == "ct").expect("the Color Transform").enabled = false;
    g
}

/// A photograph with a ramp in it, dark enough that the sRGB encode
/// moves every pixel a long way.
fn photograph(w: usize, h: usize) -> Arc<ImageBuf> {
    let mut img = ImageBuf::new(w, h);
    for y in 0..h {
        for x in 0..w {
            let (fx, fy) = ((x as f32 + 0.5) / w as f32, (y as f32 + 0.5) / h as f32);
            img.set_pixel(x, y, [0.04 + 0.2 * fx, 0.06 + 0.15 * fy, 0.1 + 0.1 * (fx + fy) * 0.5, 1.0]);
        }
    }
    Arc::new(img)
}

fn sources(photo: &Arc<ImageBuf>) -> HashMap<String, SourceImage> {
    HashMap::from([("src".to_string(), SourceImage { image: photo.clone(), version: photo.width as u64, measured: false })])
}

fn render_at(ui: &UiGraph, terminal: &str, sources: &HashMap<String, SourceImage>) -> heeler_engine::Value {
    Executor::new().render(&build_graph(ui, &Registry::builtin()).unwrap(), terminal, sources).unwrap()
}

fn render(ui: &UiGraph, sources: &HashMap<String, SourceImage>) -> Arc<ImageBuf> {
    render_at(ui, &terminal_of(ui).unwrap(), sources).as_image().unwrap().clone()
}

fn export(ui: &UiGraph) -> ImageBuf {
    render_export(ui, photograph(W, H), &HashMap::new()).unwrap()
}

/// Per pixel: masked equals the photograph where the mask is 0, the
/// whole transform where it is 1, and lies between in the feather; and
/// there is some of each.
fn gated(label: &str, masked: &ImageBuf, whole: &ImageBuf, off: &ImageBuf, mask: &[f32]) {
    assert_eq!((masked.width, masked.height), (off.width, off.height), "{label}: size");
    assert_eq!(mask.len(), off.width * off.height, "{label}: the mask covers the frame");
    let (mut inside, mut outside) = (0, 0);
    for (i, m) in mask.iter().enumerate() {
        let (a, w, o) = (&masked.data[i * 4..i * 4 + 3], &whole.data[i * 4..i * 4 + 3], &off.data[i * 4..i * 4 + 3]);
        for c in 0..3 {
            if *m <= 0.0 {
                assert!((a[c] - o[c]).abs() < 1e-5, "{label}: outside the mask the photograph is untouched at {i} ({} vs {})", a[c], o[c]);
            } else if *m >= 1.0 {
                assert!((a[c] - w[c]).abs() < 1e-5, "{label}: inside the mask the transform is whole at {i} ({} vs {})", a[c], w[c]);
            } else {
                let (lo, hi) = (o[c].min(w[c]) - 1e-5, o[c].max(w[c]) + 1e-5);
                assert!(a[c] >= lo && a[c] <= hi, "{label}: the feather lies between at {i}");
            }
        }
        if *m >= 1.0 {
            inside += 1;
            assert!((w[0] - o[0]).abs() > 0.02, "{label}: the transform moves the pixel it is let through");
        }
        if *m <= 0.0 {
            outside += 1;
        }
    }
    assert!(inside > 100 && outside > 100, "{label}: the mask has an inside ({inside}) and an outside ({outside})");
}

#[test]
fn a_masked_color_transform_applies_only_inside_its_mask_at_fit() {
    let ui = fixture();
    let photo = photograph(W / 4, H / 4);
    let ui_fit = inject_px_scale(&ui, 0.25);
    let src = sources(&photo);
    let mask = render_at(&ui_fit, "rm", &src).as_mask().expect("the Radial Mask renders a mask").data.clone();
    gated("Fit", &render(&ui_fit, &src), &render(&unmasked(&ui_fit), &src), &render(&bypassed(&ui_fit), &src), &mask);
}

#[test]
fn a_masked_color_transform_applies_only_inside_its_mask_in_the_export() {
    let ui = fixture();
    let mask = render_at(&ui, "rm", &sources(&photograph(W, H))).as_mask().expect("a mask").data.clone();
    gated("export", &export(&ui), &export(&unmasked(&ui)), &export(&bypassed(&ui)), &mask);
}

/// The 1:1 slice over the mask's edge is the export's pixels under it,
/// and it is gated: it differs from the unmasked graph's slice.
#[test]
fn a_masked_color_transform_on_the_1_1_slice_is_the_exports_pixels() {
    let ui = fixture();
    let slice = |g: &UiGraph| {
        let (roi, rect) = inject_roi_frame(g, [0.3, 0.25, 0.4, 0.45], (W, H)).expect("a slice");
        (render(&roi, &sources(&photograph(W, H))), rect)
    };
    let (patch, rect) = slice(&ui);
    let out = export(&ui);
    let (pw, ph, x0, y0) = heeler_engine::frame_window(out.width, out.height, rect.map(|v| v as f32));
    assert_eq!((patch.width, patch.height), (pw, ph), "1:1 size");
    let mut worst = 0.0f32;
    for y in 0..patch.height {
        for x in 0..patch.width {
            let (a, b) = (patch.pixel(x, y), out.pixel(x + x0, y + y0));
            worst = (0..3).map(|c| (a[c] - b[c]).abs()).fold(worst, f32::max);
        }
    }
    assert!(worst < 1e-5, "the slice differs from the export by {worst}");
    let (whole, _) = slice(&unmasked(&ui));
    let (off, _) = slice(&bypassed(&ui));
    let differs = |a: &ImageBuf, b: &ImageBuf| a.data.iter().zip(&b.data).any(|(p, q)| (p - q).abs() > 0.02);
    assert!(differs(&patch, &whole), "the slice is gated: outside the mask it is not the whole transform");
    assert!(differs(&patch, &off), "the slice is gated: inside the mask the transform applies");
}
