use std::{sync::Arc, time::Instant};
use heeler_engine::{ops, ImageBuf, Value};
use heeler_graph::{Node, ParamValue, Registry, Section};
fn node(ty: &str, params: &[(&str, f64)]) -> Node {
    let mut n = Registry::builtin().instantiate(ty, "review", Section::Creative).unwrap();
    for (k, v) in params { n.params.insert((*k).into(), ParamValue::Number(*v)); }
    n
}
fn run(n: &Node, img: ImageBuf) -> Arc<ImageBuf> {
    ops::execute(n, &[("in".into(), Value::Image(Arc::new(img)))]).unwrap().as_image().unwrap().clone()
}
fn square(size: usize) -> ImageBuf {
    let mut img = ImageBuf::new(size, size);
    for y in size/4..size*3/4 { for x in size/4..size*3/4 { img.set_pixel(x, y, [0.5, 0.4, 0.2, 1.0]); } }
    img
}
#[test]
fn fx_pixel_scale_matches_reduced_parameters() {
    for ty in ["heeler.fx_shadow", "heeler.fx_glow", "heeler.fx_bevel"] {
        let a = run(&node(ty, &[("size", 16.0), ("distance", 8.0), ("px_scale", 0.5), ("depth", 100.0)]), square(128));
        let b = run(&node(ty, &[("size", 8.0), ("distance", 4.0), ("depth", if ty.ends_with("bevel") { 50.0 } else { 100.0 })]), square(128));
        assert_eq!(a.data, b.data, "{ty}: preview scale must reach size, offset and bevel slope");
    }
}
#[test]
fn fx_preview_matches_the_export_resampled() {
    for (ty,kind) in [("heeler.fx_shadow",""),("heeler.fx_glow",""),("heeler.fx_bevel",""),("heeler.fx_color_overlay",""),("heeler.fx_gradient_overlay",""),("heeler.blur","gaussian"),("heeler.blur","box"),("heeler.blur","motion")] {
        let mut full=node(ty, &[("size",24.0),("distance",16.0),("radius",8.0),("opacity",75.0)]);
        if !kind.is_empty() { full.params.insert("kind".into(),ParamValue::Text(kind.into())); }
        let mut preview=full.clone();preview.params.insert("px_scale".into(),ParamValue::Number(0.5));
        let a=run(&full,square(256));let b=run(&preview,square(128));
        // Compare visible, premultiplied channels: hidden RGB at alpha
        // zero is not a visible difference. A 2x2 box is the reduction.
        let mut worst = 0.0f32;
        for y in 0..128 { for x in 0..128 { for c in 0..4 {
            let mut full = 0.0;
            for dy in 0..2 { for dx in 0..2 { let p = a.pixel(x*2+dx,y*2+dy); full += if c == 3 { p[3] } else { p[c]*p[3] }; } }
            let p = b.pixel(x,y); let half = if c == 3 { p[3] } else { p[c]*p[3] };
            worst = worst.max((full/4.0-half).abs());
        } } }
        assert!(worst < 0.045, "{ty}/{kind}: worst resampled error {worst}");
    }
}
#[test]
fn shadow_at_frame_edge_matches_a_larger_transparent_canvas() {
    for inner in [0.0, 1.0] {
        let mut small = ImageBuf::new(64,64); let mut large = ImageBuf::new(128,128);
        // The shifted shape passes beyond the right edge then softens
        // back into it. Cutting before blur would lose this light.
        for y in 20..44 { for x in 55..64 { small.set_pixel(x,y,[0.4,0.4,0.4,1.0]); large.set_pixel(x+32,y+32,[0.4,0.4,0.4,1.0]); } }
        let n = node("heeler.fx_shadow", &[("size",16.0),("distance",8.0),("angle",180.0),("inner",inner)]);
        let a = run(&n,small); let b = run(&n,large);
        let mut worst = 0.0f32;
        for y in 0..64 { for x in 0..64 { for c in 0..4 { worst=worst.max((a.pixel(x,y)[c]-b.pixel(x+32,y+32)[c]).abs()); } } }
        assert!(worst < 1e-5, "inner {inner}: canvas edge error {worst}");
    }
}
#[test]
fn a_one_percent_blend_is_one_percent_and_mask_export_agrees() {
    let n = node("heeler.blend", &[("opacity",1.0)]);
    let inputs = [("base".into(),Value::Image(Arc::new(ImageBuf::filled(2,2,[0.0,0.0,0.0,1.0])))),("blend".into(),Value::Image(Arc::new(ImageBuf::filled(2,2,[1.0,1.0,1.0,1.0]))))];
    let out = ops::execute(&n,&inputs).unwrap();
    assert!((out.as_image().unwrap().data[0]-0.01).abs()<1e-6);
    assert!((ops::blend_mask_weight(&n,&inputs).unwrap().data[0]-0.01).abs()<1e-6);
}
#[test]
fn a_neutral_adjustment_keeps_partial_coverage_exactly() {
    let n = node("heeler.blend", &[("adjustment",1.0)]);
    let source = Arc::new(ImageBuf::filled(2,2,[0.4,0.5,0.6,0.5]));
    let out = ops::execute(&n,&[("base".into(),Value::Image(source.clone())),("blend".into(),Value::Image(source.clone()))]).unwrap();
    assert_eq!(out.as_image().unwrap().data,source.data);
}
#[test]
#[ignore = "24 MP timing, run explicitly with one test thread"]
fn finish_fx_cost_24mp() {
    for (ty, p) in [("heeler.blur",vec![("radius",200.0)]),("heeler.fx_shadow",vec![("size",250.0),("distance",250.0)])] {
        let mut src=ImageBuf::new(6000,4000);
        for y in 1000..3000 { for x in 1500..4500 { src.set_pixel(x,y,[0.5,0.5,0.5,1.0]); } }
        let n=node(ty,&p); let start=Instant::now(); let out=run(&n,src);
        println!("{ty} 24 MP {} ms, alpha {}",start.elapsed().as_millis(),out.pixel(4502,2000)[3]);
    }
}

#[test]
fn transparent_gradient_overlay_stops_leave_the_layer_color_unchanged() {
    let mut n=node("heeler.fx_gradient_overlay",&[]);
    n.params.insert("stops".into(),ParamValue::Text(r##"[{"pos":0,"color":"#ff0000","alpha":0,"mid":50},{"pos":100,"color":"#0000ff","alpha":0,"mid":50}]"##.into()));
    let src=ImageBuf::filled(16,16,[0.4,0.5,0.6,0.5]);
    assert_eq!(run(&n,src.clone()).data,src.data);
}
