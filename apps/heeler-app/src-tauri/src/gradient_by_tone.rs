//! The Gradient layer's By tone shape, which took over the Finish
//! Gradient Map adjustment (2026-09-30: "having a Gradient Map
//! adjustment layer is redundant with the Gradient layer", then "do the
//! merge with a By tone shape"). A Gradient Map layer in a graph the
//! desktop reads arrives as a Gradient layer set to By tone
//! (gradient_maps_by_tone), and it must render the picture the Gradient
//! Map layer rendered: on a ramp, for the map's default colors and a
//! custom three-stop map, at Fit, at 1:1 and in the export.
use super::*;
use serde_json::json;

const W: usize = 512;
const H: usize = 96;

/// A ramp from black to white across the frame in scene-linear light,
/// with a tinted band so the luma key is not one channel alone.
fn ramp(w: usize, h: usize) -> Arc<ImageBuf> {
    let mut img = ImageBuf::new(w, h);
    for y in 0..h {
        for x in 0..w {
            let v = (x as f32 + 0.5) / w as f32;
            let px = if y * 3 < h { [v, v * 0.7, (v * 1.2).min(1.0), 1.0] } else { [v, v, v, 1.0] };
            img.set_pixel(x, y, px);
        }
    }
    Arc::new(img)
}

/// A Finish stack holding one Gradient Map layer, as the Layer menu
/// built it and the frontend serialized it before 2026-09-30, behind a
/// whole-frame crop (the 1:1 slice's anchor).
fn saved_graph(map: serde_json::Value, opacity: f64) -> serde_json::Value {
    json!({
        "graph_id": "gradient_by_tone",
        "nodes": [
            { "id": "src", "type": "heeler.image_source", "enabled": true, "params": {} },
            { "id": "crop", "type": "heeler.crop_rotate", "enabled": true,
              "params": { "angle": 0, "aspect": 0, "crop_x": 0, "crop_y": 0, "crop_w": 1, "crop_h": 1 } },
            { "id": "art_in", "type": "heeler.to_display", "enabled": true, "params": {} },
            { "id": "art_p1", "type": "heeler.gradient_map", "enabled": true, "params": map },
            { "id": "art_b1", "type": "heeler.blend", "enabled": true, "params": { "opacity": opacity, "mode": "normal" } },
            { "id": "art_out", "type": "heeler.to_scene", "enabled": true, "params": {} },
            { "id": "output", "type": "heeler.output", "enabled": true, "params": {} }
        ],
        "connections": [
            { "from": ["src", "out"], "to": ["crop", "in"] },
            { "from": ["crop", "out"], "to": ["art_in", "in"] },
            { "from": ["art_in", "out"], "to": ["art_p1", "in"] },
            { "from": ["art_in", "out"], "to": ["art_b1", "in"] },
            { "from": ["art_p1", "out"], "to": ["art_b1", "fg"] },
            { "from": ["art_b1", "out"], "to": ["art_out", "in"] },
            { "from": ["art_out", "out"], "to": ["output", "in"] }
        ]
    })
}

/// The graph exactly as saved, without the conversion every read runs:
/// the Gradient Map layer the way it rendered before.
fn as_before(g: &serde_json::Value) -> UiGraph {
    let w: UiGraphWire = serde_json::from_value(g.clone()).unwrap();
    UiGraph { graph_id: w.graph_id, nodes: w.nodes, connections: w.connections }
}

fn render(ui: &UiGraph, photo: &Arc<ImageBuf>) -> Arc<ImageBuf> {
    let sources = HashMap::from([("src".to_string(), SourceImage { image: photo.clone(), version: photo.width as u64, measured: false })]);
    let terminal = terminal_of(ui).unwrap();
    Executor::new().render(&build_graph(ui, &Registry::builtin()).unwrap(), &terminal, &sources).unwrap().as_image().unwrap().clone()
}

fn worst(a: &ImageBuf, b: &ImageBuf) -> f32 {
    assert_eq!((a.width, a.height), (b.width, b.height));
    a.data.iter().zip(b.data.iter()).map(|(x, y)| (x - y).abs()).fold(0.0f32, f32::max)
}

/// Every tier the desktop renders: the converted layer against the
/// Gradient Map layer it was, within float rounding (measured at most
/// 3e-7, a fiftieth of a 16-bit step), and the picture actually changed.
fn renders_as_before(map: serde_json::Value, opacity: f64, label: &str) {
    let g = saved_graph(map, opacity);
    let before = as_before(&g);
    let after: UiGraph = serde_json::from_value(g).unwrap();
    let layer = after.nodes.iter().find(|n| n.id == "art_p1").unwrap();
    assert_eq!(layer.node_type, "heeler.gradient", "{label}: the layer reads as a Gradient");
    assert_eq!(layer.params["shape"], json!("tone"), "{label}: set to By tone");
    let stops: Vec<serde_json::Value> = serde_json::from_str(layer.params["stops"].as_str().unwrap()).unwrap();
    assert_eq!(stops.len(), 3, "{label}: dark, middle and bright stops");

    let full = ramp(W, H);
    // The export, which is the settle's whole frame too.
    let old = render_export(&before, full.clone(), &HashMap::new()).unwrap();
    let new = render_export(&after, full.clone(), &HashMap::new()).unwrap();
    let d = worst(&old, &new);
    assert!(d < 2e-6, "{label}, export: By tone differs from the Gradient Map by {d}");
    let mut untouched = Executor::new();
    let plain = untouched
        .render(&build_graph(&as_before(&saved_graph(json!({}), 0.0)), &Registry::builtin()).unwrap(), "output", &HashMap::from([("src".to_string(), SourceImage { image: full.clone(), version: 1, measured: false })]))
        .unwrap();
    assert!(worst(&new, plain.as_image().unwrap()) > 0.05, "{label}: the layer changes the picture");

    // Fit: the photograph a quarter the size, the pixel scale on.
    let small = ramp(W / 4, H / 4);
    let d = worst(&render(&inject_px_scale(&before, 0.25), &small), &render(&inject_px_scale(&after, 0.25), &small));
    assert!(d < 2e-6, "{label}, Fit: By tone differs from the Gradient Map by {d}");

    // 1:1: a slice of the frame, against the old layer's slice and the
    // new layer's own export.
    let slice = [0.3, 0.2, 0.4, 0.6];
    let (roi_before, _) = inject_roi_frame(&before, slice, (W, H)).unwrap();
    let (roi_after, rect) = inject_roi_frame(&after, slice, (W, H)).unwrap();
    let (a, b) = (render(&roi_before, &full), render(&roi_after, &full));
    let d = worst(&a, &b);
    assert!(d < 2e-6, "{label}, 1:1: By tone differs from the Gradient Map by {d}");
    let (pw, ph, x0, y0) = heeler_engine::frame_window(new.width, new.height, rect.map(|v| v as f32));
    assert_eq!((b.width, b.height), (pw, ph), "{label}, 1:1 size");
    let mut off = 0.0f32;
    for y in 0..ph {
        for x in 0..pw {
            let (p, q) = (b.pixel(x, y), new.pixel(x + x0, y + y0));
            off = (0..3).map(|c| (p[c] - q[c]).abs()).fold(off, f32::max);
        }
    }
    assert!(off < 1e-5, "{label}, 1:1: the slice differs from the export by {off}");
}

#[test]
fn a_gradient_map_layer_renders_the_same_as_a_by_tone_gradient_with_its_defaults() {
    // The Finish Layer menu's Gradient Map as it was made.
    renders_as_before(
        json!({ "midpoint": 50, "amount": 100, "color_lo": "#1b2a44", "color_mid": "#808080", "color_hi": "#f0e0c0" }),
        100.0,
        "default map",
    );
}

#[test]
fn a_custom_three_stop_gradient_map_layer_renders_the_same_by_tone() {
    renders_as_before(
        json!({ "midpoint": 30, "amount": 100, "color_lo": "#10305a", "color_mid": "#c04020", "color_hi": "#fff4a0" }),
        100.0,
        "custom map",
    );
    // Amount and the layer's opacity, which multiply.
    renders_as_before(
        json!({ "midpoint": 72, "amount": 60, "color_lo": "#000000", "color_mid": "#2080c0", "color_hi": "#ffffff" }),
        70.0,
        "custom map at amount 60, opacity 70",
    );
}

#[test]
fn a_gradient_map_node_outside_a_layer_stays_a_gradient_map() {
    // The graph's own Gradient Map node, on the picture's chain: it is
    // not a Finish layer, and it keeps its type and numbers.
    let ui: UiGraph = serde_json::from_value(json!({
        "graph_id": "gradient_map_node",
        "nodes": [
            { "id": "src", "type": "heeler.image_source", "enabled": true, "params": {} },
            { "id": "gm", "type": "heeler.gradient_map", "enabled": true, "params": { "midpoint": 40 } },
            { "id": "output", "type": "heeler.output", "enabled": true, "params": {} }
        ],
        "connections": [
            { "from": ["src", "out"], "to": ["gm", "in"] },
            { "from": ["gm", "out"], "to": ["output", "in"] }
        ]
    }))
    .unwrap();
    let gm = ui.nodes.iter().find(|n| n.id == "gm").unwrap();
    assert_eq!(gm.node_type, "heeler.gradient_map");
    assert_eq!(gm.params["midpoint"], json!(40));
}

#[test]
fn a_by_tone_gradient_bakes_to_a_lut_as_the_gradient_map_did() {
    // Without the crop, which a LUT cannot hold either.
    let mut g = saved_graph(json!({}), 100.0);
    g["nodes"].as_array_mut().unwrap().retain(|n| n["id"] != json!("crop"));
    let wires = g["connections"].as_array_mut().unwrap();
    wires.retain(|c| c["to"][0] != json!("crop"));
    for c in wires.iter_mut() {
        if c["from"][0] == json!("crop") {
            c["from"] = json!(["src", "out"]);
        }
    }
    let ui: UiGraph = serde_json::from_value(g).unwrap();
    assert_eq!(lut_bake_refusal(&ui, "art_b1", 17), None, "By tone is a per-color look");
    // Across the frame it is still a position, which a LUT cannot hold.
    let mut linear = ui.clone();
    for n in &mut linear.nodes {
        if n.id == "art_p1" {
            n.params.insert("shape".into(), json!("linear"));
        }
    }
    assert!(lut_bake_refusal(&linear, "art_b1", 17).is_some());
}
