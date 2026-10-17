//! A reduced preview shows a frame-sized grain as strong as the export
//! does at the preview's size: the export rendered whole and area
//! downscaled to the preview's edge, against the preview rendered at
//! that size with the desktop's pixel scale. Before, the preview's fade
//! below a pixel left a 2048 preview of a 24 MP frame with half the
//! grain and a small preview with a third, so a new edit's grain looked
//! missing in the canvas. At the export's own size nothing changes.
use heeler_engine::{executor::Executor, ImageBuf, SourceImage, Value};
use heeler_graph::{Graph, ParamValue, Registry, Section};
use std::collections::HashMap;
use std::sync::Arc;

fn spread(img: &ImageBuf) -> f64 {
    let v: Vec<f64> = img.data.chunks(4).map(|p| p[1] as f64).collect();
    let m = v.iter().sum::<f64>() / v.len() as f64;
    (v.iter().map(|x| (x - m).powi(2)).sum::<f64>() / v.len() as f64).sqrt()
}

fn grain(w: usize, h: usize, size: f64, by_frame: bool, px_scale: Option<f64>) -> ImageBuf {
    let r = Registry::builtin();
    let mut g = Graph::new("grain");
    g.add_node(r.instantiate("heeler.image_source", "src", Section::Creative).unwrap()).unwrap();
    let mut n = r.instantiate("heeler.grain", "n", Section::Creative).unwrap();
    n.params.insert("intensity".into(), ParamValue::Number(50.0));
    n.params.insert("size".into(), ParamValue::Number(size));
    n.params.insert("by_frame".into(), ParamValue::Number(if by_frame { 1.0 } else { 0.0 }));
    if let Some(s) = px_scale {
        n.params.insert("px_scale".into(), ParamValue::Number(s));
    }
    g.add_node(n).unwrap();
    g.connect("src", "out", "n", "in").unwrap();
    let src = Arc::new(ImageBuf::filled(w, h, [0.18, 0.18, 0.18, 1.0]));
    let sources = HashMap::from([("src".to_string(), SourceImage { image: src, version: 1, measured: false })]);
    match Executor::new().render(&g, "n", &sources).unwrap() {
        Value::Image(i) => (*i).clone(),
        Value::Mask(_) => unreachable!(),
    }
}

#[test]
fn a_reduced_preview_shows_the_exports_grain() {
    let (fw, fh) = (3000, 2000);
    for size in [25.0, 60.0, 100.0] {
        let export = grain(fw, fh, size, true, None);
        for edge in [600, 1024, 1500] {
            let shown = heeler_engine::downscale::downscale_area(&export, edge);
            let preview = grain(shown.width, shown.height, size, true, Some(shown.height as f64 / fh as f64));
            let ratio = spread(&preview) / spread(&shown);
            assert!((0.95..1.05).contains(&ratio), "size {size} at {edge}: the preview's grain is {ratio:.3} of the export's");
        }
    }
}

#[test]
fn the_export_and_a_saved_pixel_grain_are_unchanged() {
    // px_scale 1 is the export's own size; a graph saved before
    // Enlargement keeps its pixel grain at any scale.
    let export = grain(400, 300, 25.0, true, None);
    let at_one = grain(400, 300, 25.0, true, Some(1.0));
    assert_eq!(export.data, at_one.data);
    let pixel = grain(400, 300, 25.0, false, None);
    let pixel_scaled = grain(400, 300, 25.0, false, Some(0.3));
    assert_eq!(pixel.data, pixel_scaled.data);
}
