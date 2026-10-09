//! The names an Export checkbox's layer carries into the file
//! (2026-10-01: "since the node name is arbitrary we should not use the
//! same name of the node its exporting, be explicit something like
//! "Curves Export Layer" and not just "Curves""). The card now reads
//! "<what> Export Layer"; the layer in the file must stay the plain name
//! a compositor wants. The frontend's names for all four kinds, from
//! cards named the new way and the old way, are in export-names.json
//! (exporttoggles.test.tsx writes it from the bridge's own
//! serialization); here they go through a real EXR and TIFF export and
//! come back out of the written files.
use super::finish_mask_crop::{fixture, graph_for, photograph, picture, planted, Footprint, H, W};
use super::*;
use serde_json::json;

fn names() -> serde_json::Value {
    serde_json::from_str(include_str!("../../src/__tests__/fixtures/export-names.json")).unwrap()
}

/// The fixture's Fill layer with a Depth mask (Depth Map on the chain),
/// one Export Layer node of each kind grafted on the way the reducer
/// wires them, named and parted as the frontend serializes them.
fn graph(kinds: &serde_json::Value, foot: &Footprint, pic: &Path) -> UiGraph {
    let (mut ui, _) = graph_for(fixture()["mask_depth"].clone(), [0.0, 0.0, 0.0, 1.0, 1.0], foot, pic, None);
    let dm = ui.nodes.iter().find(|n| n.node_type == "heeler.depth_map").unwrap().id.clone();
    let mut add = |id: &str, kind: &str, source: String, from: (&str, &str), to: &str| {
        let k = &kinds[kind];
        ui.nodes.push(UiNode {
            id: id.into(),
            node_type: "heeler.export_layer".into(),
            enabled: true,
            params: serde_json::from_value(json!({ "name": k["name"], "part": k["part"], "source": source })).unwrap(),
        });
        ui.connections.push(UiConnection { from: (from.0.into(), from.1.into()), to: (id.into(), to.into()) });
    };
    // A section tap: the picture leaving a node on the chain.
    add("dev_x_curves", "develop", "develop:Curves".into(), (&dm, "out"), "image");
    add("dev_x_depth_map", "depth", "develop:Depth Map".into(), (&dm, "depth"), "mask");
    add("art_x_art_b1", "finish", "finish:art_b1".into(), ("art_p1", "out"), "image");
    add("art_xm_art_b1", "mask", "finishmask:art_b1".into(), ("art_p1", "out"), "image");
    ui
}

#[test]
fn an_export_checkbox_writes_the_plain_name_into_exr_and_tiff_for_new_and_old_cards() {
    let all = names();
    let dir = tempfile::tempdir().unwrap();
    let pic = picture(dir.path());
    let photo = photograph(W, H);
    let foot = Footprint::of([0.0, 0.0, 0.0, 1.0, 1.0]);
    for era in ["new", "old"] {
        let kinds = &all[era];
        let name = |k: &str| kinds[k]["name"].as_str().unwrap().to_string();
        // The fixture is the plain name, never the card's label.
        for k in ["develop", "depth", "finish", "mask"] {
            assert!(!name(k).contains("Export Layer"), "{era} {k}: the bridge sent the card's label '{}'", name(k));
        }
        let ui = graph(kinds, &foot, &pic);
        let mut extra = planted(&ui, &photo, &foot);
        extra.remove("src");
        let out = dir.path().join(era);
        std::fs::create_dir_all(&out).unwrap();

        // EXR: every layer by its name, the depth tap as mist.Z.
        let (alpha, layers) = render_export_layers(&ui, photo.clone(), &extra, |_, _| {}).unwrap();
        let written = finish_export(
            crate::ExportInput {
                graph: &ui,
                source_path: None,
                source: photo.clone(),
                smart: &extra,
                keywords: &[],
                alpha,
                layers,
            },
            &out.join("shot.exr"),
            crate::ExportOptions {
                format: "exr",
                quality: 90,
                max_edge: None,
                keep_metadata: false,
                matte: false,
                scale_percent: None,
                allow_overwrite: true,
                dpi: heeler_io::DEFAULT_DPI,
            },
            |_, _| {},
        )
            .unwrap();
        let channels = heeler_io::exr_passes::inspect_file(Path::new(&written)).unwrap().channels;
        let mut want: Vec<String> = ["R", "G", "B"].iter().map(|c| format!("{}.{c}", name("develop"))).collect();
        want.extend(["R", "G", "B", "A"].iter().map(|c| format!("{}.{c}", name("finish"))));
        want.push(format!("{}.A", name("mask")));
        want.push("mist.Z".into());
        for w in &want {
            assert!(channels.contains(w), "{era}: the EXR lacks {w}; it has {channels:?}");
        }
        assert!(!channels.iter().any(|c| c.contains("Export Layer")), "{era}: a card label reached the EXR: {channels:?}");

        // TIFF: one sibling per layer, named after the layer.
        let (alpha, layers) = render_export_layers(&ui, photo.clone(), &extra, |_, _| {}).unwrap();
        finish_export(
            crate::ExportInput {
                graph: &ui,
                source_path: None,
                source: photo.clone(),
                smart: &extra,
                keywords: &[],
                alpha,
                layers,
            },
            &out.join("shot.tif"),
            crate::ExportOptions {
                format: "tiff",
                quality: 90,
                max_edge: None,
                keep_metadata: false,
                matte: false,
                scale_percent: None,
                allow_overwrite: true,
                dpi: heeler_io::DEFAULT_DPI,
            },
            |_, _| {},
        )
            .unwrap();
        let files: Vec<String> = std::fs::read_dir(&out)
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().to_string())
            .filter(|f| f.starts_with("shot.") && !f.ends_with(".exr"))
            .collect();
        for k in ["develop", "depth", "finish", "mask"] {
            let stem = format!("shot.{}.", safe_file_name(&name(k)));
            assert!(files.iter().any(|f| f.starts_with(&stem)), "{era} {k}: no sibling named {stem}*; the folder has {files:?}");
        }
        assert_eq!(files.len(), 5, "{era}: the beauty and four siblings: {files:?}");
        assert!(!files.iter().any(|f| f.contains("Export Layer")), "{era}: a card label reached a sibling name: {files:?}");
    }
}
