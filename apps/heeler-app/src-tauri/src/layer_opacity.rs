//! A Develop layer's Opacity (2026-09-30: "Adjustment layers are
//! missing an opacity slider. That would be a nice touch."). The graphs
//! are the app's own: src/__tests__/layeropacity.test.tsx builds a
//! radial layer at Exposure +1 through the reducer and pins its
//! serialization at 0, 50 and 100 percent, with no opacity at all (a
//! graph from before), and with a second node of the layer (the Color
//! section marked LAYER) gated by the same mask. Rendered here at Fit,
//! on the 1:1 slice and in the export: 0 is no effect, 50 half of it,
//! 100 and the old graph the whole of it.
use super::*;

const W: usize = 360;
const H: usize = 240;

fn fixture(name: &str) -> UiGraph {
    let all: serde_json::Map<String, serde_json::Value> =
        serde_json::from_str(include_str!("../../src/__tests__/fixtures/layer-opacity.json")).unwrap();
    serde_json::from_value(all[name].clone()).unwrap()
}

/// A photograph with color and a ramp in it, so exposure and
/// saturation both have something to move.
fn photograph(w: usize, h: usize) -> Arc<ImageBuf> {
    let mut img = ImageBuf::new(w, h);
    for y in 0..h {
        for x in 0..w {
            let (fx, fy) = ((x as f32 + 0.5) / w as f32, (y as f32 + 0.5) / h as f32);
            img.set_pixel(x, y, [0.05 + 0.2 * fx, 0.08 + 0.1 * fy, 0.12 + 0.05 * (fx + fy), 1.0]);
        }
    }
    Arc::new(img)
}

/// The layer's nodes bypassed: the photograph as it is without it.
fn without_layer(ui: &UiGraph) -> UiGraph {
    let mut g = ui.clone();
    for n in &mut g.nodes {
        if n.id.starts_with("layer_") && !n.id.ends_with("_mask") {
            n.enabled = false;
        }
    }
    g
}

/// The layer's own result, the output fed straight from the layer's
/// last node: what the layer did before the tone profile's curve bends
/// it, where half the weight is exactly half the change.
fn at_layer(ui: &UiGraph) -> UiGraph {
    let mut g = ui.clone();
    let tail = g
        .connections
        .iter()
        .find(|c| c.from.0.starts_with("layer_") && !g.nodes.iter().any(|n| n.id == c.to.0 && n.id.starts_with("layer_")) && c.to.1 == "in")
        .map(|c| c.from.clone())
        .expect("the layer hands on to the chain");
    g.connections.retain(|c| !(c.to.0 == "output" && c.to.1 == "in"));
    g.connections.push(UiConnection { from: tail, to: ("output".into(), "in".into()) });
    g
}

fn sources(photo: &Arc<ImageBuf>) -> HashMap<String, SourceImage> {
    HashMap::from([("src".to_string(), SourceImage { image: photo.clone(), version: photo.width as u64, measured: false })])
}

fn render(ui: &UiGraph, sources: &HashMap<String, SourceImage>) -> Arc<ImageBuf> {
    let terminal = terminal_of(ui).unwrap();
    Executor::new().render(&build_graph(ui, &Registry::builtin()).unwrap(), &terminal, sources).unwrap().as_image().unwrap().clone()
}

fn export(ui: &UiGraph) -> ImageBuf {
    render_export(ui, photograph(W, H), &HashMap::new()).unwrap()
}

fn fit(ui: &UiGraph) -> Arc<ImageBuf> {
    render(&inject_px_scale(ui, 0.25), &sources(&photograph(W / 4, H / 4)))
}

/// The 1:1 slice over the layer's edge, and the export's pixels under it.
fn slice(ui: &UiGraph) -> (Arc<ImageBuf>, ImageBuf, (usize, usize)) {
    let (roi, rect) = inject_roi_frame(ui, [0.3, 0.25, 0.4, 0.45], (W, H)).expect("a slice");
    let patch = render(&roi, &sources(&photograph(W, H)));
    let out = export(ui);
    let (pw, ph, x0, y0) = heeler_engine::frame_window(out.width, out.height, rect.map(|v| v as f32));
    assert_eq!((patch.width, patch.height), (pw, ph), "1:1 size");
    (patch, out, (x0, y0))
}

/// Per pixel and channel, what `on` changed against `off`.
fn change(on: &ImageBuf, off: &ImageBuf) -> Vec<f32> {
    assert_eq!((on.width, on.height), (off.width, off.height));
    on.data.chunks(4).zip(off.data.chunks(4)).flat_map(|(a, b)| (0..3).map(move |c| a[c] - b[c])).collect()
}

fn largest(v: &[f32]) -> f32 {
    v.iter().fold(0.0f32, |m, x| m.max(x.abs()))
}

/// 0 is nothing, 100 and no opacity at all are the whole layer, and 50
/// is half of it: exactly half at the layer's own output, and strictly
/// between none and all after the tone profile.
fn holds(label: &str, draw: &dyn Fn(&UiGraph) -> Vec<f32>) {
    let (p0, p50, p100, old) = (fixture("p0"), fixture("p50"), fixture("p100"), fixture("old"));
    let off = draw(&without_layer(&old));
    let full = change(&as_image(&draw(&p100)), &as_image(&off));
    assert!(largest(&full) > 0.02, "{label}: the layer at 100 changes the picture");
    assert!(largest(&change(&as_image(&draw(&p0)), &as_image(&off))) < 1e-6, "{label}: 0 is no effect");
    assert!(largest(&change(&as_image(&draw(&old)), &as_image(&draw(&p100)))) < 1e-6, "{label}: an old graph is 100");
    let half = change(&as_image(&draw(&p50)), &as_image(&off));
    for (h, f) in half.iter().zip(&full) {
        assert!(h.abs() <= f.abs() + 1e-6 && h * f >= 0.0, "{label}: 50 lies between none and all ({h} of {f})");
    }
    let at = |g: &UiGraph| draw(&at_layer(g));
    let off = at(&without_layer(&old));
    let full = change(&as_image(&at(&p100)), &as_image(&off));
    let half = change(&as_image(&at(&p50)), &as_image(&off));
    let worst = half.iter().zip(&full).fold(0.0f32, |m, (h, f)| m.max((h - f * 0.5).abs()));
    assert!(worst < 1e-5, "{label}: 50 is half the layer's change, off by {worst}");
    assert!(largest(&full) > 0.02, "{label}: the layer's own change is there to halve");
}

// The drawing closures hand back pixels with their size as a header,
// so one checker serves every path.
fn pack(img: &ImageBuf) -> Vec<f32> {
    let mut v = vec![img.width as f32, img.height as f32];
    v.extend_from_slice(&img.data);
    v
}
fn as_image(v: &[f32]) -> ImageBuf {
    ImageBuf { width: v[0] as usize, height: v[1] as usize, data: v[2..].to_vec() }
}

#[test]
fn opacity_scales_the_layer_at_fit() {
    holds("Fit", &|g| pack(&fit(g)));
}

#[test]
fn opacity_scales_the_layer_in_the_export() {
    holds("export", &|g| pack(&export(g)));
}

#[test]
fn opacity_scales_the_layer_on_the_1_1_slice_and_the_slice_is_the_export() {
    holds("1:1", &|g| pack(&slice(g).0));
    for name in ["p0", "p50", "p100"] {
        let (patch, out, (x0, y0)) = slice(&fixture(name));
        let mut worst = 0.0f32;
        for y in 2..patch.height - 2 {
            for x in 2..patch.width - 2 {
                let (a, b) = (patch.pixel(x, y), out.pixel(x + x0, y + y0));
                worst = (0..3).map(|c| (a[c] - b[c]).abs()).fold(worst, f32::max);
            }
        }
        assert!(worst < 1e-5, "{name}: the slice differs from the export by {worst}");
    }
}

/// Every node the layer's mask gates takes the opacity, not only the
/// layer's own node: at 0 the layer's Color section does nothing either,
/// and the 1:1 slice (which gives each mask wire a crop of its own)
/// agrees.
#[test]
fn opacity_reaches_every_node_the_layer_gates() {
    let (tool, p0) = (fixture("tool_old"), fixture("tool_p0"));
    for (label, draw) in [
        ("Fit", Box::new(|g: &UiGraph| pack(&fit(g))) as Box<dyn Fn(&UiGraph) -> Vec<f32>>),
        ("export", Box::new(|g: &UiGraph| pack(&export(g)))),
        ("1:1", Box::new(|g: &UiGraph| pack(&slice(g).0))),
    ] {
        let off = as_image(&draw(&without_layer(&tool)));
        assert!(largest(&change(&as_image(&draw(&tool)), &off)) > 0.02, "{label}: the layer changes the picture");
        assert!(largest(&change(&as_image(&draw(&p0)), &off)) < 1e-6, "{label}: at 0 no node of the layer applies");
    }
    let weights = layer_mask_weights(&p0);
    assert_eq!(weights.get("layer_1_adj"), Some(&0.0));
    assert_eq!(weights.get("layer_1_color"), Some(&0.0));
    assert!(layer_mask_weights(&tool).is_empty(), "an old graph stamps nothing");
}

/// The mask eye shows the mask, not the weight: the mask node renders
/// the same at 0 as at 100.
#[test]
fn the_mask_renders_the_same_at_any_opacity() {
    let mask = |g: &UiGraph| {
        let out = Executor::new().render(&build_graph(g, &Registry::builtin()).unwrap(), "layer_1_mask", &sources(&photograph(W, H))).unwrap();
        out.as_mask().expect("a mask").data.clone()
    };
    let (a, b) = (mask(&fixture("p0")), mask(&fixture("p100")));
    assert!(a.iter().any(|v| *v > 0.5), "the mask is on somewhere");
    assert_eq!(a, b);
}
