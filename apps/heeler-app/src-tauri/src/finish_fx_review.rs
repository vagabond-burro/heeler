//! The actual frontend graphs, built and exported by the desktop path.
use super::*;
use serde_json::json;
fn fixtures() -> serde_json::Value { serde_json::from_str(include_str!("../../src/__tests__/fixtures/finish-fx-review.json")).unwrap() }
fn fixture(name: &str) -> UiGraph { serde_json::from_value(fixtures()[name].clone()).unwrap() }
fn photo(size: usize) -> Arc<ImageBuf> { Arc::new(ImageBuf::filled(size, size, [0.18,0.24,0.3,1.0])) }
fn render(ui: &UiGraph, src: Arc<ImageBuf>, extra: &HashMap<String, SourceImage>) -> ImageBuf { render_export(ui,src,extra).unwrap() }
fn image_source(size: usize) -> HashMap<String, SourceImage> { HashMap::from([("art_p1".into(),SourceImage { image: Arc::new(ImageBuf::filled(size,size,[0.6,0.2,0.1,1.0])), version: size as u64, measured: false })]) }
#[test]
fn every_fresh_adjustment_is_neutral_except_invert_and_black_and_white() {
    let src=photo(16);
    // Black & White acts at birth too: the picture goes gray and is no
    // longer the source.
    let gray=render(&fixture("neutral_black_white"),src.clone(),&HashMap::new());
    assert!((gray.data[0]-gray.data[1]).abs()<1e-5 && (gray.data[1]-gray.data[2]).abs()<1e-5,"not gray: {:?}",&gray.data[..3]);
    assert!((gray.data[0]-src.data[0]).abs()>0.01);
    for k in ["exposure","curves","levels","white_balance","color","color_balance"] {
        let out=render(&fixture(&format!("neutral_{k}")),src.clone(),&HashMap::new());
        for (a,b) in out.data.iter().zip(&src.data) { assert!((a-b).abs()<2e-6,"{k}: {a} != {b}"); }
    }
    let out=render(&fixture("neutral_invert"),src.clone(),&HashMap::new());
    for c in 0..3 { let expected=heeler_engine::ops::to_scene(1.0-heeler_engine::ops::to_display(src.data[c])); assert!((out.data[c]-expected).abs()<2e-6); }
}
#[test]
fn finish_exposure_uses_scene_light_and_preserves_alpha() {
    let src=photo(16); let out=render(&fixture("exposure"),src.clone(),&HashMap::new());
    for c in 0..3 { assert!((out.data[c]-src.data[c]*2.0).abs()<2e-6,"channel {c}: {}",out.data[c]); }
    assert_eq!(out.data[3],1.0);
}
#[test]
fn an_adjustment_in_a_group_changes_the_fill_without_growing_its_alpha() {
    let src=photo(16);let out=render(&fixture("group_adjustment"),src.clone(),&HashMap::new());
    for (c,d) in [128.0/255.0,64.0/255.0,32.0/255.0].into_iter().enumerate() {
        let adjusted=heeler_engine::ops::to_display(heeler_engine::ops::to_scene(d)*2.0);
        let expected=heeler_engine::ops::to_scene(0.5*adjusted+0.5*heeler_engine::ops::to_display(src.data[c]));
        assert!((out.data[c]-expected).abs()<2e-6,"channel {c}: {} != {expected}",out.data[c]);
    }
}
#[test]
fn clipped_adjustments_change_only_the_half_opaque_fill_and_compose_in_order() {
    let src=photo(16);let extra=HashMap::new();
    for (name,inverted) in [("clipped_invert",true),("clipped_double_invert",false)] {
        let out=render(&fixture(name),src.clone(),&extra);
        for (c,d) in [128.0/255.0,64.0/255.0,32.0/255.0].into_iter().enumerate() {
            let expected=heeler_engine::ops::to_scene(0.5*if inverted { 1.0-d } else { d }+0.5*heeler_engine::ops::to_display(src.data[c]));
            assert!((out.data[c]-expected).abs()<2e-6,"{name} channel {c}: {} != {expected}",out.data[c]);
        }
    }
}
#[test]
fn a_placed_images_glow_reaches_outside_its_original_extent_and_exports_the_effect() {
    let ui=fixture("image_glow");let src=photo(128);let extra=image_source(32);
    let built=build_graph(&ui,&Registry::builtin()).unwrap();
    let mut sources=extra.clone();sources.insert("review_source".into(),SourceImage { image: src.clone(), version: 1, measured: false });
    let fx=ui.nodes.iter().find(|n|n.node_type=="heeler.fx_glow").unwrap();
    let v=Executor::new().render(&built,&fx.id,&sources).unwrap();let img=v.as_image().unwrap();
    assert_eq!((img.width,img.height),(128,128));assert!(img.pixel(28,64)[3]>0.1,"the glow reaches beyond the picture's placed left edge");
    let (_,layers)=render_export_layers(&ui,src,&extra,|_,_|{}).unwrap();
    assert_eq!(layers.len(),1);let image=layers[0].value.as_image().unwrap();assert_eq!((image.width,image.height),(128,128));
    assert!(image.pixel(28,64)[3]>0.1);
}
#[test]
fn masks_shape_each_effect_before_it_runs() {
    for key in ["shadow","glow","color_overlay","gradient_overlay","bevel","blur"] {
        let ui=fixture(&format!("masked_{key}"));let src=photo(128);let built=build_graph(&ui,&Registry::builtin()).unwrap();
        let sources=HashMap::from([("review_source".into(),SourceImage { image: src.clone(), version: 1, measured: false })]);
        let fx=ui.nodes.iter().find(|n|n.node_type.starts_with("heeler.fx_")||n.node_type=="heeler.blur").unwrap();
        let out=Executor::new().render(&built,&fx.id,&sources).unwrap();
        assert!(out.as_image().unwrap().data.chunks_exact(4).all(|p|p[3]==0.0),"{key}: an empty mask leaves no effect silhouette");
        let composite=render(&ui,src.clone(),&HashMap::new());
        for (a,b) in composite.data.iter().zip(&src.data) { assert!((a-b).abs()<2e-6,"{key}: mask leaves the photo unchanged"); }
    }
}
#[test]
fn every_adjustment_mask_writes_to_exr_and_tiff_without_an_adjustment_picture() {
    let dir=tempfile::tempdir().unwrap();let src=photo(16);
    for k in ["exposure","curves","levels","white_balance","color","color_balance","black_white","invert"] {
        let mut ui=fixture(&format!("neutral_{k}"));
        ui.nodes.iter_mut().find(|n|n.id=="art_b1").unwrap().params.insert("opacity".into(),json!(1));
        let (_,layers)=render_export_layers(&ui,src.clone(),&HashMap::new(),|_,_|{}).unwrap();
        assert_eq!(layers.len(),1,"{k}: the offered picture export is off, only the mask is written");
        assert!(layers[0].value.as_mask().unwrap().data.iter().all(|v|(*v-0.01).abs()<1e-6));
        for (format,ext) in [("exr","exr"),("tiff","tif")] {
            let (alpha,layers)=render_export_layers(&ui,src.clone(),&HashMap::new(),|_,_|{}).unwrap();
            let path=dir.path().join(format!("{k}.{ext}"));
            finish_export(
                crate::ExportInput {
                    graph: &ui,
                    source_path: None,
                    source: src.clone(),
                    smart: &HashMap::new(),
                    keywords: &[],
                    alpha,
                    layers,
                },
                &path,
                crate::ExportOptions {
                    format,
                    quality: 90,
                    max_edge: None,
                    keep_metadata: false,
                    matte: false,
                    scale_percent: None,
                    allow_overwrite: true,
                    dpi: heeler_io::DEFAULT_DPI,
                },
                |_,_|{},
            ).unwrap();
            if format=="exr" {
                let channels=heeler_io::exr_passes::inspect_file(&path).unwrap().channels;
                assert!(channels.iter().any(|c|c.ends_with(".A")&&c.contains("mask")),"{channels:?}");
                let planes=super::export_toggles::exr_planes(path.to_str().unwrap(),&[channels.iter().find(|c|c.contains("mask")&&c.ends_with(".A")).unwrap().as_str()]);
                assert!(planes[0].iter().all(|v|(*v-0.01).abs()<2e-4));
            } else {
                let siblings: Vec<_>=std::fs::read_dir(dir.path()).unwrap().filter_map(Result::ok).map(|e|e.path()).filter(|p|p.file_name().unwrap().to_string_lossy().starts_with(&format!("{k}."))&&p.extension().is_some_and(|e|e=="tif")&&p!=&path).collect();
                assert_eq!(siblings.len(),1);let mask=heeler_io::decode_file(&siblings[0]).unwrap();
                assert!(mask.data.chunks_exact(4).all(|p|(p[0]-0.01).abs()<3e-4),"{k}: TIFF stores the mask weight");
            }
        }
    }
}
#[test]
fn fx_reach_is_reserved_for_one_to_one_slices() {
    for (ty,params,minimum) in [("heeler.fx_shadow",json!({"size":40,"distance":60}),110.0),("heeler.fx_glow",json!({"size":40}),50.0),("heeler.fx_bevel",json!({"size":40}),50.0)] {
        let ui:UiGraph=serde_json::from_value(json!({"graph_id":"reach","nodes":[{"id":"effect","type":ty,"enabled":true,"params":params}],"connections":[]})).unwrap();
        let (x,y)=clone_reach(&ui,Some((6000.0,4000.0)));assert!(x*6000.0>=minimum&&y*4000.0>=minimum,"{ty}: {x}, {y}");
    }
}

#[test]
fn a_warp_with_blur_can_bake_and_keeps_its_traveling_mask() {
    let ui=fixture("warp_blur");
    let ports=warp_bake_ports(&ui,"art_b1").unwrap();
    assert_eq!(ports.len(),3);
    let g=build_graph(&ui,&Registry::builtin()).unwrap();
    for id in ["art_b1","__fx_shape_art_b1"] {
        let mask=g.incoming(id,"mask").unwrap();
        assert_eq!(g.node(&mask.from.0).unwrap().node_type,"heeler.layer_warp_mask");
    }
}

#[test]
fn every_effect_writes_its_alpha_to_exr_and_tiff() {
    let dir=tempfile::tempdir().unwrap(); let src=photo(128);
    for key in ["shadow","glow","color_overlay","gradient_overlay","bevel","blur"] {
        let ui=fixture(&format!("effect_{key}"));
        let (_,layers)=render_export_layers(&ui,src.clone(),&HashMap::new(),|_,_|{}).unwrap();
        assert_eq!(layers.len(),1);
        let expected: Vec<f32>=layers[0].value.as_image().unwrap().data.chunks_exact(4).map(|p|p[3]).collect();
        for (format,ext) in [("exr","exr"),("tiff","tif")] {
            let (alpha,layers)=render_export_layers(&ui,src.clone(),&HashMap::new(),|_,_|{}).unwrap();
            let path=dir.path().join(format!("{key}.{ext}"));
            finish_export(
                crate::ExportInput {
                    graph: &ui,
                    source_path: None,
                    source: src.clone(),
                    smart: &HashMap::new(),
                    keywords: &[],
                    alpha,
                    layers,
                },
                &path,
                crate::ExportOptions {
                    format,
                    quality: 90,
                    max_edge: None,
                    keep_metadata: false,
                    matte: false,
                    scale_percent: None,
                    allow_overwrite: true,
                    dpi: heeler_io::DEFAULT_DPI,
                },
                |_,_|{},
            ).unwrap();
            let actual=if format=="exr" {
                let channels=heeler_io::exr_passes::inspect_file(&path).unwrap().channels;
                let channel=channels.iter().find(|c|c.contains("Pixel")&&c.ends_with(".A")).unwrap();
                super::export_toggles::exr_planes(path.to_str().unwrap(),&[channel.as_str()]).remove(0)
            } else {
                let sibling=std::fs::read_dir(dir.path()).unwrap().filter_map(Result::ok).map(|e|e.path()).find(|p|p.file_name().unwrap().to_string_lossy().starts_with(&format!("{key}."))&&p.extension().is_some_and(|e|e=="tif")&&p!=&path).unwrap();
                heeler_io::decode_file(&sibling).unwrap().data.chunks_exact(4).map(|p|p[3]).collect()
            };
            assert_eq!(actual.len(),expected.len());
            for (a,b) in actual.iter().zip(&expected) { assert!((a-b).abs()<0.002,"{key} {format}: alpha {a} != {b}"); }
        }
    }
}

#[test]
fn each_effects_one_to_one_slice_matches_the_full_render() {
    let src=photo(512);
    for key in ["shadow","glow","color_overlay","gradient_overlay","bevel","blur"] {
        let ui=fixture(&format!("effect_{key}"));
        let full=render(&ui,src.clone(),&HashMap::new());
        let (slice,r)=inject_roi_frame(&ui,[0.5,0.375,0.0625,0.25],(512,512)).expect("a small paint-layer slice is worthwhile");
        let out=render(&slice,src.clone(),&HashMap::new());
        let (x0,y0)=((r[0]*512.0).round() as usize,(r[1]*512.0).round() as usize);
        let mut worst=0.0f32;
        for y in 192..320 { for x in 256..288 { for c in 0..4 { worst=worst.max((out.pixel(x-x0,y-y0)[c]-full.pixel(x,y)[c]).abs()); } } }
        assert!(worst<0.002,"{key}: slice differs by {worst}");
    }
}

#[test]
fn finish_wheel_ranges_do_not_count_exposure_past_a_display_boundary() {
    let ui:UiGraph=serde_json::from_value(json!({"graph_id":"ranges","nodes":[
        {"id":"balance","type":"heeler.color_balance","enabled":true,"params":{}},
        {"id":"display","type":"heeler.to_display","enabled":true,"params":{}},
        {"id":"exposure","type":"heeler.exposure","enabled":true,"params":{"exposure":2}},
        {"id":"output","type":"heeler.output","enabled":true,"params":{}}],
        "connections":[{"from":["balance","out"],"to":["display","in"]},{"from":["display","out"],"to":["exposure","in"]},{"from":["exposure","out"],"to":["output","in"]}]})).unwrap();
    assert_eq!(range_ev_below(&ui,"balance"),0.0);
}
