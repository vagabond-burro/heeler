//! Cross-crate integration: a node group extracted from one graph is
//! instantiated into another and executed by the engine.

use std::collections::HashMap;
use std::sync::Arc;

use heeler_engine::{Executor, ImageBuf, SourceImage};
use heeler_graph::group::{apply_instance, GroupDef};
use heeler_graph::{Graph, ParamValue, Registry, Section};

#[test]
fn extracted_group_executes_in_a_new_graph() {
    let registry = Registry::builtin();

    // Template graph: the "look" is exposure +1 EV followed by levels
    // gamma 2. Extract those two nodes as a group.
    let mut template = Graph::new("template");
    for (t, id) in [
        ("heeler.image_source", "src"),
        ("heeler.exposure", "e"),
        ("heeler.levels", "l"),
    ] {
        template
            .add_node(registry.instantiate(t, id, Section::Creative).unwrap())
            .unwrap();
    }
    template.connect("src", "out", "e", "in").unwrap();
    template.connect("e", "out", "l", "in").unwrap();
    template.set_param("e", "exposure", ParamValue::Number(1.0)).unwrap();
    template.set_param("l", "gamma", ParamValue::Number(2.0)).unwrap();

    let def = GroupDef::extract(&template, "Bright Look", &["e", "l"]).unwrap();

    // Fresh image graph: source -> [group] -> output.
    let mut graph = Graph::new("img_1_v1");
    graph
        .add_node(registry.instantiate("heeler.image_source", "photo", Section::RawFoundation).unwrap())
        .unwrap();
    graph
        .add_node(registry.instantiate("heeler.output", "out", Section::Output).unwrap())
        .unwrap();

    let inst = def.instantiate("look_");
    apply_instance(&mut graph, &inst).unwrap();

    let (in_node, in_port) = &inst.inputs["e.in"];
    let (out_node, out_port) = &inst.outputs["l.out"];
    graph.connect("photo", "out", in_node, in_port).unwrap();
    graph.connect(out_node, out_port, "out", "in").unwrap();

    let mut sources = HashMap::new();
    sources.insert(
        "photo".to_string(),
        SourceImage {
            image: Arc::new(ImageBuf::filled(2, 2, [0.2, 0.2, 0.2, 1.0])),
            version: 1,
            measured: false,
        },
    );

    let mut exec = Executor::new();
    let value = exec.render(&graph, "out", &sources).unwrap();
    let px = value.as_image().unwrap().pixel(0, 0);

    // 0.2 doubled by +1 EV = 0.4, then gamma 2 on the display axis
    // (Levels reads as the screen shows, like Curves): sqrt of the
    // encoded value, decoded back to scene.
    let to_display = |v: f32| if v <= 0.0031308 { v * 12.92 } else { 1.055 * v.powf(1.0 / 2.4) - 0.055 };
    let to_scene = |v: f32| if v <= 0.04045 { v / 12.92 } else { ((v + 0.055) / 1.055).powf(2.4) };
    let expected = to_scene(to_display(0.4f32).powf(0.5));
    assert!((px[0] - expected).abs() < 1e-5, "{} != {expected}", px[0]);
}
