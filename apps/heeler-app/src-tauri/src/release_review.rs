use super::*;
#[test]
fn in_place_rewrite_changes_the_source_and_settle_identity() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("own.dng");
    let when = std::time::SystemTime::UNIX_EPOCH + std::time::Duration::from_secs(1_700_000_000);
    let write = |byte| {
        std::fs::write(&path, vec![byte; 70000]).unwrap();
        std::fs::File::options()
            .write(true)
            .open(&path)
            .unwrap()
            .set_modified(when)
            .unwrap();
    };
    let key = || {
        source_version_key_for_path(
            Some(path.clone()),
            "own",
            heeler_io::RawSourceOpts::default(),
            0,
        )
    };
    write(1u8);
    let first = key();
    assert_eq!(key(), first);
    std::fs::write(dir.path().join("own.xmp"), b"own sidecar rating").unwrap();
    assert_eq!(key(), first, "a sidecar does not change the source pixels");
    // A rewrite inside the same second, one millisecond on: a new
    // source. (A rewrite that keeps the exact time as well as the
    // length is served from the remembered head by design: no
    // photograph tool changes pixels and restores the time.)
    std::fs::write(&path, vec![2u8; 70000]).unwrap();
    std::fs::File::options().write(true).open(&path).unwrap()
        .set_modified(when + std::time::Duration::from_millis(1)).unwrap();
    assert_ne!(key(), first, "a rewrite with a new time is a new source, even within the second");
}

#[test]
fn a_forced_memory_fallback_cannot_be_remembered_as_a_settle() {
    let seen = Mutex::new(std::collections::HashSet::new());
    for _ in 0..2 {
        let (_, notice) = memory::with_budget(1024 * 1024, || {
            retry_preview(None, |tier| {
                let edge = tier.unwrap_or(8192);
                memory::Job::admit(edge * edge * 2, "own fallback test")
                    .map(|_| ())
                    .map_err(|e| e.to_string())
            })
        })
        .unwrap();
        assert!(notice.is_some());
        let mut meta = PreviewResult {
            source_identity: Some("own".into()),
            memory_notice: None,
            mime: "image/jpeg".into(),
            ms: 0,
            image_id: "own".into(),
            backend: "cpu".into(),
            roi: None,
            frame: None,
        };
        note_reduced_frame(&mut meta, notice, "own.jpg", &seen);
        assert!(meta.source_identity.is_none());
    }
}

#[test]
fn a_measured_pass_rewrite_changes_its_own_raster_identity() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("own.exr");
    let when = std::time::UNIX_EPOCH + std::time::Duration::from_secs(1_700_000_000);
    let write = |v| {
        std::fs::write(&path, [v; 4096]).unwrap();
        std::fs::File::options()
            .write(true)
            .open(&path)
            .unwrap()
            .set_modified(when)
            .unwrap();
    };
    write(1u8);
    let first = file_depth_key(&path);
    // A re-render one millisecond later, the same second and length:
    // whole-second stamps missed it.
    std::fs::write(&path, [2u8; 4096]).unwrap();
    std::fs::File::options().write(true).open(&path).unwrap()
        .set_modified(when + std::time::Duration::from_millis(1)).unwrap();
    assert_ne!(first, file_depth_key(&path));
}

#[test]
fn recipe_picture_pass_through_keeps_its_file_branch_scale() {
    let fixtures: serde_json::Value = serde_json::from_str(include_str!(
        "../../src/__tests__/fixtures/tool-groups.json"
    ))
    .unwrap();
    for name in ["vivid", "hipass", "skin"] {
        let mut graph: UiGraph = serde_json::from_value(fixtures[name].clone()).unwrap();
        graph
            .nodes
            .iter_mut()
            .find(|n| n.id == "src")
            .unwrap()
            .node_type = "heeler.file".into();
        let scaled = inject_px_scales(&graph, 0.25, &HashMap::from([("src".into(), 0.5)]));
        let mut checked = 0;
        for node in &scaled.nodes {
            if [
                "heeler.blur",
                "heeler.high_pass",
                "heeler.merge",
                "heeler.blend",
            ]
            .contains(&node.node_type.as_str())
                && graph.connections.iter().any(|c| c.to.0 == node.id)
            {
                assert_eq!(
                    node.params.get("px_scale").and_then(|v| v.as_f64()),
                    Some(0.5),
                    "{name}: {}",
                    node.id
                );
                checked += 1;
            }
        }
        assert!(checked >= 3);
    }
}
