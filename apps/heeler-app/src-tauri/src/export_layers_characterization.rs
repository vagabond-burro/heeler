//! The export renderer's defensive paths, pinned before it leaves the shell.
use super::*;
use serde_json::json;

fn node(id: &str, ty: &str) -> UiNode {
    UiNode { id: id.into(), node_type: ty.into(), enabled: true, params: HashMap::new() }
}
fn wire(from: &str, to: &str, port: &str) -> UiConnection {
    UiConnection { from: (from.into(), "out".into()), to: (to.into(), port.into()) }
}
fn graph() -> UiGraph {
    UiGraph { graph_id: "characterization".into(), nodes: vec![node("src", "heeler.image_source"), node("out", "heeler.output"), node("tap", "heeler.export_layer")], connections: vec![wire("src", "out", "in")] }
}
fn picture() -> Arc<ImageBuf> { Arc::new(ImageBuf::filled(2, 1, [0.2, 0.4, 0.6, 0.8])) }
fn rendered(ui: &UiGraph) -> Result<(Option<Value>, Vec<ExportLayer>), String> {
    render_export_layers(ui, picture(), &HashMap::new(), |_, _| {})
}

#[test]
fn no_exports_returns_before_building_an_empty_or_invalid_graph() {
    for nodes in [vec![], vec![node("unknown", "heeler.not_registered")]] {
        let ui = UiGraph { graph_id: "empty".into(), nodes, connections: vec![] };
        let (alpha, layers) = rendered(&ui).unwrap();
        assert!(alpha.is_none());
        assert!(layers.is_empty());
    }
}
#[test]
fn an_enabled_unwired_export_has_no_layer() {
    let (alpha, layers) = rendered(&graph()).unwrap();
    assert!(alpha.is_none());
    assert!(layers.is_empty());
}
#[test]
fn a_mask_input_wins_over_image_and_does_not_read_the_alpha_input() {
    let mut ui = graph();
    ui.nodes.push(node("luma", "heeler.luminance_extract"));
    ui.connections.extend([wire("src", "luma", "in"), wire("src", "tap", "image"), wire("luma", "tap", "mask"), wire("src", "tap", "alpha")]);
    let (alpha, layers) = rendered(&ui).unwrap();
    assert!(alpha.is_none());
    assert_eq!(layers.len(), 1);
    assert!(layers[0].alpha.is_none());
    let Value::Mask(mask) = &layers[0].value else { panic!("the mask wins") };
    assert_eq!((mask.width, mask.height), (2, 1));
    let g = build_graph(&ui, &Registry::builtin()).unwrap();
    let sources = HashMap::from([("src".into(), SourceImage { image: picture(), version: 1, measured: false })]);
    let expected = Executor::new().render(&g, "luma", &sources).unwrap();
    assert_eq!(mask.data, expected.as_mask().unwrap().data);
}
#[test]
fn missing_mask_sources_skip_and_a_missing_finish_picture_source_keeps_the_tap() {
    for source in ["finishmask:absent", "layermask:absent", "finish:absent"] {
        let mut ui = graph();
        ui.nodes.last_mut().unwrap().params.insert("source".into(), json!(source));
        ui.connections.push(wire("src", "tap", "image"));
        let (_, layers) = rendered(&ui).unwrap();
        if source == "finish:absent" {
            assert_eq!(layers.len(), 1);
            assert!(layers[0].finish.is_none());
            assert_eq!(layers[0].value.as_image().unwrap().data, picture().data);
        } else { assert!(layers.is_empty(), "{source}"); }
    }
}
#[test]
fn a_develop_source_without_applied_weight_skips_the_mask_export() {
    let mut ui = graph();
    ui.nodes.last_mut().unwrap().params.insert("source".into(), json!("layermask:src"));
    assert!(rendered(&ui).unwrap().1.is_empty());
}
#[test]
fn renderer_propagates_graph_and_executor_errors() {
    let mut ui = graph();
    ui.nodes.push(node("bad", "heeler.not_registered"));
    let expected = build_graph(&ui, &Registry::builtin()).err().unwrap();
    assert_eq!(rendered(&ui).err(), Some(expected));
    let mut ui = graph();
    ui.nodes.push(node("bad", "heeler.invert_mask"));
    ui.connections.push(wire("bad", "tap", "mask"));
    let (g, sources, _) = export_render_setup(&ui, picture(), &HashMap::new()).unwrap();
    let expected = Executor::new().render(&g, "bad", &sources).err().unwrap().to_string();
    assert_eq!(rendered(&ui).err(), Some(expected));
    ui.connections.push(wire("bad", "out", "alpha"));
    assert_eq!(rendered(&ui).err(), Some(Executor::new().render_connection(&g, g.incoming("tap", "mask").unwrap(), &sources).err().unwrap().to_string()));
}
#[test]
fn layer_names_trim_and_fall_back_to_the_node_id() {
    for (param, expected) in [(None, "tap"), (Some(json!("")), "tap"), (Some(json!(" \t\n")), "tap"), (Some(json!(42)), "tap"), (Some(json!("  sky  ")), "sky")] {
        let mut n = node("tap", "heeler.export_layer");
        if let Some(value) = param { n.params.insert("name".into(), value); }
        assert_eq!(export_layer_name(&n), expected);
    }
}
#[test]
fn suffix_search_preserves_existing_names_and_logs_each_collision_in_order() {
    let layer = |name: &str| ExportLayer { name: name.into(), value: Value::Image(picture()), depth: false, part: "rgb".into(), alpha: None, finish: None };
    let layers = vec![layer("sky"), layer("sky-2"), layer("sky-3")];
    let mut logs = Vec::new();
    assert_eq!(unique_layer_name(&layers, "sky", &mut |level, message| logs.push((level.to_string(), message.to_string()))), "sky-4");
    assert_eq!(logs, (2..=4).map(|n| ("warn".into(), format!("two Export Layer nodes named 'sky'; the second writes as 'sky-{n}'"))).collect::<Vec<_>>());
    logs.clear();
    assert_eq!(unique_layer_name(&layers, "cloud", &mut |level, message| logs.push((level.to_string(), message.to_string()))), "cloud");
    assert!(logs.is_empty());
    assert_eq!(layers.iter().map(|l| l.name.as_str()).collect::<Vec<_>>(), ["sky", "sky-2", "sky-3"]);
}
