//! Export settings at the writer boundary and the shared wire contracts.
use super::*;
use serde_json::json;

fn graph() -> UiGraph {
    serde_json::from_value(json!({
        "graph_id": "dpi-review",
        "nodes": [
            { "id": "src", "type": "heeler.image_source", "enabled": true, "params": {} },
            { "id": "output", "type": "heeler.output", "enabled": true, "params": {} }
        ],
        "connections": [{"from": ["src", "out"], "to": ["output", "in"]}]
    })).unwrap()
}

fn tiff_dpi(bytes: &[u8]) -> Option<u32> {
    let at = u32::from_le_bytes(bytes[4..8].try_into().unwrap()) as usize;
    let count = u16::from_le_bytes(bytes[at..at + 2].try_into().unwrap()) as usize;
    (0..count).find_map(|i| {
        let e = &bytes[at + 2 + i * 12..at + 14 + i * 12];
        if u16::from_le_bytes(e[..2].try_into().unwrap()) != 282 { return None; }
        let off = u32::from_le_bytes(e[8..12].try_into().unwrap()) as usize;
        let n = u32::from_le_bytes(bytes[off..off + 4].try_into().unwrap());
        let d = u32::from_le_bytes(bytes[off + 4..off + 8].try_into().unwrap());
        Some(n / d)
    })
}

#[test]
fn export_writer_keeps_resize_alpha_and_metadata_settings() {
    let dir = tempfile::tempdir().unwrap();
    let source = Arc::new(ImageBuf::filled(8, 6, [0.3, 0.2, 0.1, 0.25]));
    let source_path = dir.path().join("source.jpg");
    std::fs::write(&source_path, heeler_io::encode_jpeg(&source, 90).unwrap()).unwrap();
    for (i, (edge, scale, keep, expected_size)) in [
        (Some(4), None, true, (4, 3)),
        (None, Some(50.0), false, (4, 3)),
        (None, None, true, (8, 6)),
    ].into_iter().enumerate() {
        let dest = dir.path().join(format!("resize-{i}.png"));
        finish_export(
            crate::ExportInput {
                graph: &graph(),
                source_path: Some(&source_path),
                source: source.clone(),
                smart: &HashMap::new(),
                keywords: &["Print".into()],
                alpha: None,
                layers: Vec::new(),
            },
            &dest,
            crate::ExportOptions {
                format: "png16",
                quality: 73,
                max_edge: edge,
                keep_metadata: keep,
                matte: false,
                scale_percent: scale,
                allow_overwrite: false,
                dpi: 240,
            },
            |_, _| {},
        ).unwrap();
        let bytes = std::fs::read(&dest).unwrap();
        let back = heeler_io::decode_bytes(&bytes).unwrap();
        assert_eq!((back.width, back.height), expected_size);
        assert!((back.data[3] - 0.25).abs() < 0.0001);
        assert_eq!(bytes.windows(5).any(|w| w == b"Print"), keep);
    }
    let before = std::fs::read(&source_path).unwrap();
    let error = finish_export(
        crate::ExportInput {
            graph: &graph(),
            source_path: Some(&source_path),
            source,
            smart: &HashMap::new(),
            keywords: &[],
            alpha: None,
            layers: Vec::new(),
        },
        &source_path,
        crate::ExportOptions {
            format: "jpeg",
            quality: 90,
            max_edge: None,
            keep_metadata: false,
            matte: false,
            scale_percent: None,
            allow_overwrite: true,
            dpi: 240,
        },
        |_, _| {},
    ).unwrap_err();
    assert!(error.contains("refusing to export over"));
    assert_eq!(std::fs::read(source_path).unwrap(), before);
}

#[test]
fn tiff_siblings_share_the_beautys_print_resolution() {
    let dir = tempfile::tempdir().unwrap();
    let source = Arc::new(ImageBuf::filled(8, 6, [0.3, 0.2, 0.1, 1.0]));
    for format in ["tiff", "tiff32"] {
        let dest = dir.path().join(format!("{format}.tif"));
        let layers = vec![
            ExportLayer { name: "picture".into(), value: Value::Image(source.clone()), depth: false, part: "rgb".into(), alpha: None, finish: None },
            ExportLayer { name: "mask".into(), value: Value::Image(source.clone()), depth: false, part: "alpha".into(), alpha: None, finish: None },
        ];
        finish_export(
            crate::ExportInput {
                graph: &graph(),
                source_path: None,
                source: source.clone(),
                smart: &HashMap::new(),
                keywords: &[],
                alpha: None,
                layers,
            },
            &dest,
            crate::ExportOptions {
                format,
                quality: 90,
                max_edge: None,
                keep_metadata: false,
                matte: false,
                scale_percent: None,
                allow_overwrite: false,
                dpi: 240,
            },
            |_, _| {},
        ).unwrap();
        for file in [dest, dir.path().join(format!("{format}.picture.tif")), dir.path().join(format!("{format}.mask.tif"))] {
            assert_eq!(tiff_dpi(&std::fs::read(file).unwrap()), Some(240));
        }
    }
}

#[test]
fn export_resolution_contract_agrees_with_rust_containers() {
    let contract: serde_json::Value = serde_json::from_str(include_str!("../../../../crates/heeler-io/export-resolution.json")).unwrap();
    assert_eq!(contract["defaultDpi"].as_u64(), Some(heeler_io::DEFAULT_DPI as u64));
    assert_eq!(contract["maxDpi"].as_u64(), Some(heeler_io::resolution::MAX_DPI as u64));
}

#[test]
fn develop_layer_adjustments_agree_with_the_shared_frontend_contract() {
    let contract: serde_json::Value = serde_json::from_str(include_str!("../../src/layer-id-contract.json")).unwrap();
    for row in contract.as_array().unwrap() {
        let id = row["id"].as_str().unwrap();
        assert_eq!(is_develop_layer_adj(id), row["adj"].as_bool().unwrap(), "{id:?}");
    }
}

#[test]
fn preset_layer_names_follow_the_shared_frontend_contract() {
    let contract: serde_json::Value = serde_json::from_str(include_str!("../../src/layer-id-contract.json")).unwrap();
    for row in contract.as_array().unwrap() {
        let id = row["id"].as_str().unwrap();
        // Finish has its own reserved namespace; this fixture compares Develop only.
        if id.starts_with("art_") { continue; }
        let raw = json!({"schema": 1, "name": "Layer contract", "nodes": [
            {"id": id, "type": "heeler.exposure"},
            {"id": "output", "type": "heeler.output"},
        ]}).to_string();
        let result = vet_preset(&raw);
        if row["node"].as_bool().unwrap() {
            assert!(result.unwrap_err().contains("reserved"), "{id:?}");
        } else {
            assert!(result.is_ok(), "{id:?}: {result:?}");
        }
    }
}
