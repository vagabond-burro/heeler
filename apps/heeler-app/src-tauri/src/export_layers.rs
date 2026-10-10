//! Export layers rendered from the beauty's graph and sources.
use super::*;

/// One named extra layer of an export (26.3 Phase 8): what an Export
/// Layer node's wired input rendered to, with enough of its origin
/// kept for the writers. A depth-fed layer is EXR's mist.Z and a
/// TIFF sibling gray alike; an image layer's `part` picks its rgb or
/// its own alpha. The node's wired alpha input, when present, REPLACES
/// the written layer's alpha, the same rule the Output node's alpha
/// port applies to the beauty.
pub(crate) struct ExportLayer {
    pub name: String,
    pub value: Value,
    pub depth: bool,
    pub part: String,
    pub alpha: Option<Value>,
    /// Present when the Finish tab's Export checkbox made the node:
    /// the layer is display-referred, and the writers treat it so.
    pub finish: Option<FinishMeta>,
}

/// The Output node's wired alpha port and every enabled Export Layer
/// node, rendered through ONE executor and the beauty's own sources, so
/// a mask feeding both a layer and the beauty's alpha computes once
/// (26.3 Phase 8). Nothing wired, nothing rendered: the guard runs
/// before the graph is even built.
pub(crate) fn render_export_layers(
    ui: &UiGraph,
    source: Arc<ImageBuf>,
    extra: &HashMap<String, SourceImage>,
    mut log: impl FnMut(&str, &str),
) -> Result<(Option<Value>, Vec<ExportLayer>), String> {
    let output = ui.nodes.iter().find(|n| n.node_type == "heeler.output");
    let alpha_wired = output.is_some_and(|o| ui.connections.iter().any(|c| c.to.0 == o.id && c.to.1 == "alpha"));
    let layer_nodes: Vec<&UiNode> = ui
        .nodes
        .iter()
        .filter(|n| n.node_type == "heeler.export_layer" && n.enabled)
        .collect();
    if !alpha_wired && layer_nodes.is_empty() {
        return Ok((None, Vec::new()));
    }
    let _job = Job::admit(
        // The beauty's own admission covers the graph; one layer
        // buffer over it is what the extras can add.
        memory::bytes(source.width, source.height, 1, 48).map_err(|e| e.to_string())?,
        "export alpha and layers",
    )
    .map_err(|e| e.to_string())?;
    let (g, sources, _terminal) = export_render_setup(ui, source, extra)?;
    let mut exec = Executor::new();

    let alpha = match output {
        Some(o) => match g.incoming(&o.id, "alpha") {
            Some(conn) => Some(exec.render_connection(&g, conn, &sources).map_err(|e| e.to_string())?),
            None => None,
        },
        None => None,
    };

    let mut layers: Vec<ExportLayer> = Vec::new();
    for n in layer_nodes {
        let source = n.params.get("source").and_then(|v| v.as_str()).unwrap_or("");
        // A Finish layer's mask (2026-09-30): the weight its blend applies,
        // opacity, clipping and the mask carried with the layer, rendered
        // from the blend's own inputs by the engine's own reading
        // (blend_mask_weight), so the gray written is the gray the composite
        // used. The node's wire is the Graph's picture of where it hangs; it
        // is not what is written.
        if let Some(blend_id) = source.strip_prefix("finishmask:") {
            let Some(blend) = g.node(blend_id) else { continue };
            let mut inputs: Vec<(String, Value)> = Vec::new();
            for port in ["base", "blend", "clip", "mask"] {
                if let Some(c) = g.incoming(blend_id, port) {
                    inputs.push((port.to_string(), exec.render_connection(&g, c, &sources).map_err(|e| e.to_string())?));
                }
            }
            let weight = heeler_engine::ops::blend_mask_weight(blend, &inputs).map_err(|e| e.to_string())?;
            let named = export_layer_name(n);
            let name = unique_layer_name(&layers, &named, &mut log);
            layers.push(ExportLayer {
                name,
                value: Value::Mask(Arc::new(weight)),
                depth: false,
                part: "alpha".into(),
                alpha: None,
                finish: None,
            });
            continue;
        }
        // A Develop adjustment layer's mask (2026-10-01: "The Export Mask as
        // Layer option underneath Depth mask in adjustment layers"): the weight
        // the layer's own node is applied through, its mask with the Depth mask
        // in it, times its Opacity (the mask_weight build_graph stamped), read
        // from the node's own inputs by the executor's own steps
        // (applied_mask_weight). Every section the layer carries is gated by the
        // same mask at the same weight. The wire from the mask is the Graph's
        // picture.
        if let Some(layer_id) = source.strip_prefix("layermask:") {
            let Some(adj) = g.node(layer_id) else { continue };
            let mut inputs: Vec<(String, Value)> = Vec::new();
            for port in ["in", "mask"] {
                if let Some(c) = g.incoming(layer_id, port) {
                    inputs.push((port.to_string(), exec.render_connection(&g, c, &sources).map_err(|e| e.to_string())?));
                }
            }
            let Some(weight) = heeler_engine::applied_mask_weight(adj, &inputs) else { continue };
            let named = export_layer_name(n);
            let name = unique_layer_name(&layers, &named, &mut log);
            layers.push(ExportLayer {
                name,
                value: Value::Mask(Arc::new(weight)),
                depth: false,
                part: "alpha".into(),
                alpha: None,
                finish: None,
            });
            continue;
        }
        // One input wired, by the node's own rule; the mask half wins
        // when a saved graph carries both.
        let conn = g.incoming(&n.id, "mask").or_else(|| g.incoming(&n.id, "image"));
        let Some(conn) = conn else { continue };
        let mut value = exec.render_connection(&g, conn, &sources).map_err(|e| e.to_string())?;
        // A Finish-sourced node (26.3 Phase 8 milestone 3) taps the
        // layer's content, before its blend: the blend's opacity and
        // the layer's mask are folded into the written alpha here, so
        // the file's layer carries the layer's coverage, not the naked
        // content's. The mode cannot fold into pixels and rides as
        // metadata instead.
        let finish = source.strip_prefix("finish:").and_then(|blend_id| {
            let blend = ui.nodes.iter().find(|b| b.id == blend_id)?;
            let mode = blend
                .params
                .get("mode")
                .and_then(|v| v.as_str())
                .unwrap_or("normal")
                .to_string();
            let opacity = blend.params.get("opacity").and_then(|v| v.as_f64()).unwrap_or(100.0) as f32;
            // The frontend folds the layer's Finish group onto the node
            // at serialization, so this record is never stale.
            let group = n.params.get("group").and_then(|v| v.as_str()).unwrap_or("").to_string();
            Some((blend_id.to_string(), FinishMeta { mode, opacity, group }))
        });
        // The folded alpha: the tapped image's own, the layer mask
        // multiplied in, the blend's opacity applied. A mask tap has no
        // alpha beyond itself and skips all of this.
        let mut alpha: Option<Value> = None;
        // A layer its blend places or moves (a Finish image layer, or any
        // layer the Transform tool has moved) is written where the
        // composite shows it, on the frame, with its mask carried the
        // same way: the engine's own placement, not the naked content
        // (Finish image layers, 2026-09-30).
        let placed_by = finish.as_ref().and_then(|(blend_id, _)| {
            let b = g.node(blend_id)?;
            let fit = b.params.get("fit").and_then(|v| v.as_str()).unwrap_or("stretch");
            let boxed = b.params.get("warp_bw").and_then(|v| v.as_f64()).unwrap_or(0.0) > 0.0;
            (b.params.get("content_placed").and_then(|v| v.as_f64()).unwrap_or(0.0) == 0.0 && (fit == "place" || boxed)).then(|| (blend_id.clone(), b.params.clone()))
        });
        if let (Some((blend_id, params)), "image", Value::Image(img)) = (&placed_by, conn.to.1.as_str(), &value) {
            if let Some(bc) = g.incoming(blend_id, "base") {
                let frame = exec.render_connection(&g, bc, &sources).map_err(|e| e.to_string())?;
                if let Value::Image(f) = &frame {
                    value = Value::Image(heeler_engine::ops::layer_on_frame(params, img, f.width, f.height));
                }
            }
        }
        if let Some((blend_id, meta)) = &finish {
            if conn.to.1 == "image" {
                if let Value::Image(img) = &value {
                    let mut a: Vec<f32> = img.data.chunks_exact(4).map(|px| px[3]).collect();
                    if let Some(mc) = g.incoming(blend_id, "mask").filter(|_| g.node(blend_id).and_then(|b| b.params.get("mask_baked")).and_then(|v| v.as_f64()).unwrap_or(0.0) == 0.0) {
                        let mut mv = exec.render_connection(&g, mc, &sources).map_err(|e| e.to_string())?;
                        // A mask buffer of another size closes the layer,
                        // the blend's own rule (mask_on_frame), so the
                        // written alpha is the composite's and not a
                        // stretch of a mask the blend refused.
                        if let Value::Mask(m) = &mv {
                            if let std::borrow::Cow::Owned(closed) = heeler_engine::ops::mask_on_frame(blend_id, m, img.width, img.height) {
                                mv = Value::Mask(Arc::new(closed));
                            }
                        }
                        // The mask travels with the picture, as in the blend.
                        match (&placed_by, &mv) {
                            (Some((_, params)), Value::Mask(m)) if (m.width, m.height) == (img.width, img.height) => {
                                if let Some(w) = heeler_engine::ops::layer_mask_on_frame(params, m) {
                                    mv = Value::Mask(Arc::new(w));
                                }
                            }
                            (Some((_, params)), Value::Image(mi)) => {
                                // A mask arriving as a picture: the blend
                                // stretches it to the frame and moves it
                                // by the corners, never places it.
                                let mut by_quad = params.clone();
                                by_quad.insert("fit".into(), heeler_graph::ParamValue::Text("stretch".into()));
                                mv = Value::Image(heeler_engine::ops::layer_on_frame(&by_quad, mi, img.width, img.height));
                            }
                            _ => {}
                        }
                        let (plane, mw, mh) = match &mv {
                            Value::Mask(m) => (m.data.clone(), m.width, m.height),
                            Value::Image(mi) => (
                                mi.data.chunks_exact(4).map(|px| px[3]).collect::<Vec<f32>>(),
                                mi.width,
                                mi.height,
                            ),
                        };
                        if mw > 0 && mh > 0 {
                            let scaled = if (mw, mh) == (img.width, img.height) {
                                plane
                            } else {
                                heeler_vision::resize_plane(&plane, mw, mh, img.width, img.height)
                            };
                            for (x, m) in a.iter_mut().zip(scaled.iter()) {
                                *x *= m.clamp(0.0, 1.0);
                            }
                        }
                    }
                    // The carrier's weight includes clipping and opacity.
                    // Its own mask has already shaped an FX input, so
                    // keep that baked shape while still folding clipping.
                    if let Some(cc) = g.incoming(blend_id, "clip") {
                        let clipped = exec.render_connection(&g, cc, &sources).map_err(|e| e.to_string())?;
                        let base = Value::Image(Arc::new(ImageBuf::filled(img.width, img.height, [0.0, 0.0, 0.0, 1.0])));
                        let mut carrier = g.node(blend_id).unwrap().clone();
                        carrier.params.insert("opacity".into(), heeler_graph::ParamValue::Number(100.0));
                        let weight = heeler_engine::ops::blend_mask_weight(&carrier, &[("base".into(), base), ("clip".into(), clipped)]).map_err(|e| e.to_string())?;
                        for (v, c) in a.iter_mut().zip(weight.data) { *v *= c; }
                    }
                    let op = (meta.opacity / 100.0).clamp(0.0, 1.0);
                    if op < 1.0 {
                        for x in a.iter_mut() {
                            *x *= op;
                        }
                    }
                    alpha = Some(Value::Mask(MaskBuf { width: img.width, height: img.height, data: a }.into()));
                }
            }
        }
        // The alpha input is meaningful with the image pair (26.3
        // Phase 8): the written layer's alpha, replacing what the wire
        // carried - and replacing the Finish fold above with it, which
        // is the replacement rule ("a wired alpha replaces that too").
        if conn.to.1 == "image" {
            if let Some(ac) = g.incoming(&n.id, "alpha") {
                alpha = Some(exec.render_connection(&g, ac, &sources).map_err(|e| e.to_string())?);
            }
        }
        let named = export_layer_name(n);
        let name = unique_layer_name(&layers, &named, &mut log);
        layers.push(ExportLayer {
            name,
            value,
            depth: conn.from.1 == "depth",
            part: n
                .params
                .get("part")
                .and_then(|v| v.as_str())
                .unwrap_or("rgb")
                .to_string(),
            alpha,
            finish: finish.map(|(_, m)| m),
        });
    }
    Ok((alpha, layers))
}

/// An Export Layer node's written name. Empty names the card's label,
/// which the frontend folds into the param at serialization; an offline
/// or hand-built graph falls back to the node id.
fn export_layer_name(n: &UiNode) -> String {
    n.params
        .get("name")
        .and_then(|v| v.as_str())
        .filter(|s| !s.trim().is_empty())
        .map(|s| s.trim().to_string())
        .unwrap_or_else(|| n.id.clone())
}

/// Two layers of one name collide in every container, so the second
/// earns a suffix and the log says it happened.
fn unique_layer_name(layers: &[ExportLayer], named: &str, log: &mut impl FnMut(&str, &str)) -> String {
    let mut name = named.to_string();
    let mut suffix = 2;
    while layers.iter().any(|c| c.name == name) {
        log("warn", &format!("two Export Layer nodes named '{named}'; the second writes as '{named}-{suffix}'"));
        name = format!("{named}-{suffix}");
        suffix += 1;
    }
    name
}

/// A layer's value as one gray plane at the frame's size (26.3 Phase
/// 8): a mask resamples; an image layer's alpha half reads the fourth
/// sample; its rgb half reads as luma, the honest gray of a color
/// plane. EXR's rgb layers do not come through here - they keep their
/// three planes.
fn grey_plane_of(value: &Value, part: &str, w: usize, h: usize) -> Vec<f32> {
    let (plane, sw, sh) = match value {
        Value::Mask(m) => (m.data.clone(), m.width, m.height),
        Value::Image(i) if part == "alpha" => {
            (i.data.chunks_exact(4).map(|px| px[3]).collect(), i.width, i.height)
        }
        Value::Image(i) => (
            i.data
                .chunks_exact(4)
                .map(|px| 0.2126 * px[0] + 0.7152 * px[1] + 0.0722 * px[2])
                .collect(),
            i.width,
            i.height,
        ),
    };
    if sw == 0 || sh == 0 {
        return vec![0.0; w * h];
    }
    heeler_vision::resize_plane(&plane, sw, sh, w, h)
}

/// The alpha an export layer writes (26.3 Phase 8): the wired alpha
/// input when the node names one, the tapped image's own fourth sample
/// otherwise; a mask tap has no alpha beyond itself. One plane at the
/// frame's size.
fn layer_alpha(ch: &ExportLayer, w: usize, h: usize) -> Option<Vec<f32>> {
    match (&ch.alpha, &ch.value) {
        (Some(a), _) => Some(grey_plane_of(a, "alpha", w, h)),
        (None, Value::Image(i)) => Some(heeler_vision::resize_plane(
            &i.data.chunks_exact(4).map(|px| px[3]).collect::<Vec<f32>>(),
            i.width,
            i.height,
            w,
            h,
        )),
        (None, Value::Mask(_)) => None,
    }
}

/// An image tap's picture at the frame's size, RGBA (26.3 Phase 8):
/// the tapped image resampled, its alpha the wired alpha input when
/// the node names one.
fn layer_image_of(ch: &ExportLayer, w: usize, h: usize) -> ImageBuf {
    let Value::Image(i) = &ch.value else {
        return ImageBuf::new(w, h);
    };
    let plane = |c: usize| {
        heeler_vision::resize_plane(
            &i.data.chunks_exact(4).map(|px| px[c]).collect::<Vec<f32>>(),
            i.width,
            i.height,
            w,
            h,
        )
    };
    let (r, g, b) = (plane(0), plane(1), plane(2));
    let a = layer_alpha(ch, w, h).unwrap_or_else(|| vec![1.0; w * h]);
    let mut buf = ImageBuf::new(w, h);
    for px in 0..w * h {
        buf.data[px * 4] = r[px];
        buf.data[px * 4 + 1] = g[px];
        buf.data[px * 4 + 2] = b[px];
        buf.data[px * 4 + 3] = a[px];
    }
    buf
}

/// An export layer's EXR layer (26.3 Phase 8): depth-fed is the layer
/// `mist` with the leaf Z (f32, the writer's rule); a mask is one
/// `<name>.A`; an image's rgb half is `<name>.R/G/B` with `<name>.A`
/// alongside - the wired alpha input when the node names one, the
/// image's own alpha otherwise; an image's alpha half is the same A
/// alone.
fn exr_layer_of(ch: &ExportLayer, w: usize, h: usize) -> heeler_io::exr_passes::Layer {
    if ch.depth {
        // Heeler's plane is farness, 0 near to 1 far, not a metric
        // distance: written under the mist name, which readers (this
        // one included) take as a normalized depth, where a depth.Z
        // would be inverted as 1/z on the way back in.
        return heeler_io::exr_passes::Layer {
            name: "mist".into(),
            channels: vec![("Z".into(), grey_plane_of(&ch.value, "alpha", w, h))],
        };
    }
    match &ch.value {
        Value::Image(i) if ch.part != "alpha" => {
            let plane = |c: usize| {
                let p: Vec<f32> = i.data.chunks_exact(4).map(|px| px[c]).collect();
                heeler_vision::resize_plane(&p, i.width, i.height, w, h)
            };
            let (mut r, mut g, mut b) = (plane(0), plane(1), plane(2));
            // A Finish-sourced layer is display-referred and the EXR is
            // scene-linear, so its color planes linearize on the way
            // in. Alpha is coverage, not color, and stays as it is.
            if ch.finish.is_some() {
                for px in r.iter_mut().chain(g.iter_mut()).chain(b.iter_mut()) {
                    *px = heeler_io::srgb_to_linear(px.clamp(0.0, 1.0));
                }
            }
            let mut channels = vec![("R".into(), r), ("G".into(), g), ("B".into(), b)];
            if let Some(a) = layer_alpha(ch, w, h) {
                channels.push(("A".into(), a));
            }
            heeler_io::exr_passes::Layer {
                name: ch.name.clone(),
                channels,
            }
        }
        Value::Image(_) => heeler_io::exr_passes::Layer {
            name: ch.name.clone(),
            channels: vec![("A".into(), layer_alpha(ch, w, h).unwrap_or_else(|| grey_plane_of(&ch.value, "alpha", w, h)))],
        },
        _ => heeler_io::exr_passes::Layer {
            name: ch.name.clone(),
            channels: vec![("A".into(), grey_plane_of(&ch.value, &ch.part, w, h))],
        },
    }
}

/// The EXR (26.3 Phase 8): one file with everything packed - the beauty
/// as rgba (A is the alpha port's, 1.0 unwired), each Export Layer node
/// a layer, a depth-fed layer as mist.Z. Scene-linear, unbounded, no
/// OETF; the header says Rec.709 and which Heeler wrote it.
/// write_layers takes the path, not bytes, so this container stands
/// alone; siblings and metadata splices do not apply.
pub(crate) fn write_exr(
    dest: &Path,
    image: &ImageBuf,
    layers: &[ExportLayer],
    log: &mut impl FnMut(&str, &str),
) -> Result<(), String> {
    let (w, h) = (image.width, image.height);
    let mut packed = vec![heeler_io::exr_passes::Layer {
        name: String::new(),
        channels: vec![
            ("R".into(), image.data.chunks_exact(4).map(|px| px[0]).collect()),
            ("G".into(), image.data.chunks_exact(4).map(|px| px[1]).collect()),
            ("B".into(), image.data.chunks_exact(4).map(|px| px[2]).collect()),
            ("A".into(), image.data.chunks_exact(4).map(|px| px[3]).collect()),
        ],
    }];
    // Two layers resolving to one name (two depth-fed layers both
    // become mist) would refuse the whole file; the second is
    // suffixed and the log says so.
    let mut taken: std::collections::HashSet<String> = packed.iter().map(|l| l.name.clone()).collect();
    for ch in layers {
        let mut layer = exr_layer_of(ch, w, h);
        if !taken.insert(layer.name.clone()) {
            let mut n = 2;
            while taken.contains(&format!("{}-{n}", layer.name)) {
                n += 1;
            }
            let renamed = format!("{}-{n}", layer.name);
            log("info", &format!("export layer '{}' is written as '{renamed}': the name was taken", layer.name));
            layer.name = renamed;
            taken.insert(layer.name.clone());
        }
        packed.push(layer);
    }
    // A Finish layer's mode, opacity and group ride in the header
    // as a record (26.3 Phase 8); no reader acts on them, and the
    // docs say so. The display-space composite is not reproducible
    // by a linear merge, which is exactly what the record is for.
    let mut attrs: Vec<(String, String)> = Vec::new();
    for ch in layers {
        let Some(f) = &ch.finish else { continue };
        attrs.push((format!("heeler.layer.{}.mode", ch.name), f.mode.clone()));
        attrs.push((format!("heeler.layer.{}.opacity", ch.name), format!("{}", f.opacity)));
        if !f.group.is_empty() {
            attrs.push((format!("heeler.layer.{}.group", ch.name), f.group.clone()));
        }
    }
    heeler_io::exr_passes::write_layers_with_attributes(dest, w, h, &packed, &attrs).map_err(|e| e.to_string())
}

/// The export layers' TIFF form (26.3 Phase 8): one sibling per layer
/// beside the main file at `dest`, named in the extension `ext` the main
/// file was written by, at the main file's size, and only when that
/// extension made the main file a TIFF. A sibling NEVER
/// overwrites, even when the main file's Replace? was honored: that
/// answer covered the one name, not names nobody was asked about.
///
/// The siblings take the same ExportOptions the main file was written
/// from, so a setting the main file honors is already in hand here; the
/// print resolution once reached the main file and missed its siblings
/// (26.4.2).
pub(crate) fn write_tiff_siblings(
    dest: &Path,
    ext: &str,
    (w, h): (usize, usize),
    layers: &[ExportLayer],
    options: &ExportOptions<'_>,
    log: &mut impl FnMut(&str, &str),
) -> Result<(), String> {
    // The container the main file was written in, which the name's
    // extension picked; the format only says float or 16-bit.
    if !matches!(ext, "tif" | "tiff") || layers.is_empty() {
        return Ok(());
    }
    let stem = dest.file_stem().and_then(|s| s.to_str()).unwrap_or("export");
    let parent = dest.parent().map(|p| p.to_path_buf()).unwrap_or_default();
    for ch in layers {
        let bytes = tiff_sibling(ch, w, h, options)?;
        // A layer label can contain path separators. It remains
        // verbatim in metadata, but its sibling is one filename.
        let want = parent.join(format!("{stem}.{}.{}", safe_file_name(&ch.name), ext));
        // unclobbered assumes a taken name (the main file only calls
        // it once Replace? is settled), so a free name is kept here.
        let path = if want.exists() { unclobbered(&want) } else { want.clone() };
        if path != want {
            log("info", &format!("{} already exists; writing {} instead", want.display(), path.display()));
        }
        write_named(&path, &bytes)?;
    }
    Ok(())
}

/// One layer's sibling, 16-bit display-encoded for a 16-bit main file,
/// 32-bit scene-linear float for a float one. A mask tap is a gray, the
/// depth layer a gray like any other; an image tap writes its picture as
/// RGBA through the layer encoders, the wired alpha input replacing the
/// image's own fourth sample when the node names one. Every setting the
/// encoders take is read from `options` here, once, for every kind.
fn tiff_sibling(ch: &ExportLayer, w: usize, h: usize, options: &ExportOptions<'_>) -> Result<Vec<u8>, String> {
    let float = options.format == "tiff32";
    let dpi = Some(options.dpi);
    match &ch.value {
        Value::Image(_) if !ch.depth && ch.part != "alpha" => {
            let mut buf = layer_image_of(ch, w, h);
            // A Finish-sourced layer is display-referred (26.3
            // Phase 8 milestone 3): the 16-bit sibling keeps the
            // values as they are, no curve; the float sibling
            // linearizes, the way the EXR does. The description
            // records mode, opacity and group and says no reader
            // acts on them - a linear merge will not reproduce
            // the display-space composite. The space words match
            // the pixels: the float sibling was linearized, so
            // only the 16-bit one is called display-referred.
            let description = |space: &str| match &ch.finish {
                Some(f) => format!(
                    "Heeler Finish layer '{}': mode={}, opacity={}, group={} - record only, no reader acts on it; {space}, a linear merge will not reproduce the composite",
                    ch.name, f.mode, f.opacity, f.group
                ),
                None => format!("Heeler export layer: {}", ch.name),
            };
            if float {
                if ch.finish.is_some() {
                    for px in buf.data.chunks_exact_mut(4) {
                        px[0] = heeler_io::srgb_to_linear(px[0].clamp(0.0, 1.0));
                        px[1] = heeler_io::srgb_to_linear(px[1].clamp(0.0, 1.0));
                        px[2] = heeler_io::srgb_to_linear(px[2].clamp(0.0, 1.0));
                    }
                }
                heeler_io::encode_tiff32f_layer(&buf, &description("painted display-referred, linearized into scene-linear here"), dpi)
            } else if ch.finish.is_some() {
                heeler_io::encode_tiff16_layer_display(&buf, &description("display-referred"), dpi)
            } else {
                heeler_io::encode_tiff16_layer(&buf, &description(""), dpi)
            }
        }
        _ => {
            let plane = grey_plane_of(&ch.value, &ch.part, w, h);
            // An image tap on its alpha part writes the wired
            // alpha when the node names one.
            let plane = match (&ch.value, ch.alpha.is_some()) {
                (Value::Image(_), true) if ch.part == "alpha" => {
                    layer_alpha(ch, w, h).unwrap_or(plane)
                }
                _ => plane,
            };
            if float {
                heeler_io::encode_tiff32f_grey(&plane, w, h, dpi)
            } else {
                heeler_io::encode_tiff16_grey(&plane, w, h, dpi)
            }
        }
    }
    .map_err(|e| e.to_string())
}

#[cfg(test)]
#[path = "export_layers_characterization.rs"]
mod characterization;
#[cfg(test)]
#[path = "export_layers_review.rs"]
mod review;
#[cfg(test)]
#[path = "export_layers_writer.rs"]
mod writer;

#[cfg(test)]
pub(crate) mod tests {
    use super::*;

    /// 26.3 Phase 8's graph: a beauty, its alpha port fed by a Luminance
    /// Extract, two mask layers, one image layer and one depth-fed
    /// layer. `depth_plant` stands in for the desktop's planted
    /// `{dm}@depth` slot.
    fn export_layer_graph() -> UiGraph {
        let node = |id: &str, ty: &str, params: &[(&str, serde_json::Value)]| UiNode {
            id: id.into(),
            node_type: ty.into(),
            enabled: true,
            params: params.iter().map(|(k, v)| (k.to_string(), v.clone())).collect(),
        };
        UiGraph {
            graph_id: "t".into(),
            nodes: vec![
                node("src", "heeler.image_source", &[]),
                node("dm", "heeler.depth_map", &[]),
                node("lm", "heeler.luminance_extract", &[]),
                node("out", "heeler.output", &[]),
                node("chm1", "heeler.export_layer", &[("name", serde_json::json!("sky"))]),
                node("chm2", "heeler.export_layer", &[("name", serde_json::json!("subject"))]),
                node("chimg", "heeler.export_layer", &[("name", serde_json::json!("grade"))]),
                node("chd", "heeler.export_layer", &[("name", serde_json::json!("farness"))]),
            ],
            connections: vec![
                UiConnection { from: ("src".into(), "out".into()), to: ("dm".into(), "in".into()) },
                UiConnection { from: ("src".into(), "out".into()), to: ("lm".into(), "in".into()) },
                UiConnection { from: ("src".into(), "out".into()), to: ("out".into(), "in".into()) },
                UiConnection { from: ("lm".into(), "out".into()), to: ("out".into(), "alpha".into()) },
                UiConnection { from: ("lm".into(), "out".into()), to: ("chm1".into(), "mask".into()) },
                UiConnection { from: ("lm".into(), "out".into()), to: ("chm2".into(), "mask".into()) },
                // The image half rides the card's primary input, "in",
                // the way the frontend sends it.
                UiConnection { from: ("src".into(), "out".into()), to: ("chimg".into(), "in".into()) },
                UiConnection { from: ("dm".into(), "depth".into()), to: ("chd".into(), "mask".into()) },
            ],
        }
    }

    /// A 2x1 source: red pixel, green pixel. Luma 0.2126 and 0.7152.
    fn export_layer_source() -> Arc<ImageBuf> {
        let mut img = ImageBuf::new(2, 1);
        img.set_pixel(0, 0, [1.0, 0.0, 0.0, 1.0]);
        img.set_pixel(1, 0, [0.0, 1.0, 0.0, 1.0]);
        Arc::new(img)
    }

    fn depth_plant() -> HashMap<String, SourceImage> {
        let mut plane = ImageBuf::new(2, 1);
        plane.set_pixel(0, 0, [0.25, 0.25, 0.25, 1.0]);
        plane.set_pixel(1, 0, [0.75, 0.75, 0.75, 1.0]);
        HashMap::from([("dm@depth".to_string(), SourceImage { image: Arc::new(plane), version: 1, measured: false })])
    }

    /// Read a sibling gray's first directory: one sample a pixel, and
    /// the pixel values back out of the strip.
    fn grey_tiff_pixels(bytes: &[u8]) -> (u16, Vec<f32>) {
        assert_eq!(&bytes[..2], b"II", "a TIFF sibling is little-endian TIFF");
        let ifd = u32::from_le_bytes(bytes[4..8].try_into().unwrap()) as usize;
        let entries = u16::from_le_bytes(bytes[ifd..ifd + 2].try_into().unwrap()) as usize;
        let field = |tag: u16| {
            (0..entries)
                .map(|i| ifd + 2 + i * 12)
                .find(|&at| u16::from_le_bytes(bytes[at..at + 2].try_into().unwrap()) == tag)
                .map(|at| &bytes[at..at + 12])
        };
        let samples = u16::from_le_bytes(field(277).unwrap()[8..10].try_into().unwrap());
        let strip = u32::from_le_bytes(field(273).unwrap()[8..12].try_into().unwrap()) as usize;
        let count = u32::from_le_bytes(field(279).unwrap()[8..12].try_into().unwrap()) as usize;
        let values = bytes[strip..strip + count]
            .chunks_exact(2)
            .map(|b| u16::from_le_bytes(b.try_into().unwrap()) as f32 / 65535.0)
            .collect();
        (samples, values)
    }

    #[test]
    fn export_layers_pack_one_exr() {
        let dir = tempfile::tempdir().unwrap();
        let dest = dir.path().join("photo.exr");
        let ui = export_layer_graph();
        let smart = depth_plant();
        let (alpha, layers) = render_export_layers(&ui, export_layer_source(), &smart, |_, _| {}).unwrap();
        let written = finish_export(
            crate::ExportInput {
                graph: &ui,
                source_path: None,
                source: export_layer_source(),
                smart: &smart,
                keywords: &[],
                alpha,
                layers,
            },
            &dest,
            crate::ExportOptions {
                format: "exr",
                quality: 90,
                max_edge: None,
                keep_metadata: true,
                matte: false,
                scale_percent: None,
                allow_overwrite: false,
                dpi: heeler_io::DEFAULT_DPI,
            },
            |_, _| {},
        )
        .unwrap();
        let info = heeler_io::exr_passes::inspect_file(Path::new(&written)).unwrap();
        for name in ["R", "G", "B", "A", "sky.A", "subject.A", "grade.R", "grade.G", "grade.B", "grade.A", "mist.Z"] {
            assert!(info.channels.iter().any(|c| c == name), "missing channel {name}");
        }
        // No stray layer named after the depth layer's card: the port
        // decides the name, not the node.
        assert!(!info.channels.iter().any(|c| c.starts_with("farness")), "depth-fed writes mist.Z, farness under the mist name");

        let names = ["R", "G", "B", "A", "sky.A", "subject.A", "grade.R", "grade.G", "grade.B", "grade.A", "mist.Z"];
        let planes = heeler_io::exr_passes::read_planes_file(Path::new(&written), 0, &names).unwrap();
        let close = |a: f32, b: f32, what: &str| assert!((a - b).abs() < 0.002, "{what}: {a} vs {b}");
        // The beauty is the source itself, premultiplied in the file by
        // the alpha the port supplied (the convention; Heeler reads it
        // back straight).
        close(planes[0][0], 1.0 * planes[3][0], "beauty R of the red pixel");
        close(planes[1][1], 1.0 * planes[3][1], "beauty G of the green pixel");
        // The alpha port's mask IS the beauty's A: Rec.709 luma.
        close(planes[3][0], 0.2126, "alpha of the red pixel");
        close(planes[3][1], 0.7152, "alpha of the green pixel");
        // Both mask layers carry the same mask.
        close(planes[4][0], 0.2126, "sky.A of the red pixel");
        close(planes[5][1], 0.7152, "subject.A of the green pixel");
        // The image layer packs the source's rgb.
        close(planes[6][0], 1.0, "grade.R of the red pixel");
        close(planes[7][1], 1.0, "grade.G of the green pixel");
        close(planes[8][0], 0.0, "grade.B of the red pixel");
        // No alpha input wired: the layer keeps the wire's own alpha.
        close(planes[9][0], 1.0, "grade.A of the red pixel");
        close(planes[9][1], 1.0, "grade.A of the green pixel");
        // Depth stays f32, so it is the planted plane bit for bit.
        assert_eq!(planes[10], vec![0.25, 0.75], "depth.Z is the planted plane");
    }

    /// Two Export Layer nodes named the same collide in every container:
    /// the second writes under a suffixed name and the log says so,
    /// rather than dropping one or refusing the file.
    #[test]
    fn two_export_layers_of_one_name_write_both_with_a_suffix() {
        let dir = tempfile::tempdir().unwrap();
        let dest = dir.path().join("photo.exr");
        let mut ui = export_layer_graph();
        ui.nodes.iter_mut().find(|n| n.id == "chm2").unwrap().params.insert("name".into(), serde_json::json!("sky"));
        let mut logs: Vec<String> = Vec::new();
        let (alpha, layers) = render_export_layers(&ui, export_layer_source(), &depth_plant(), |_, m| logs.push(m.to_string())).unwrap();
        let names: Vec<&str> = layers.iter().map(|l| l.name.as_str()).collect();
        assert_eq!(names, vec!["sky", "sky-2", "grade", "farness"], "the second 'sky' is suffixed, nothing dropped");
        assert!(logs.iter().any(|m| m.contains("two Export Layer nodes named 'sky'")), "the log says it happened: {logs:?}");
        let written = finish_export(
            crate::ExportInput {
                graph: &ui,
                source_path: None,
                source: export_layer_source(),
                smart: &depth_plant(),
                keywords: &[],
                alpha,
                layers,
            },
            &dest,
            crate::ExportOptions {
                format: "exr",
                quality: 90,
                max_edge: None,
                keep_metadata: true,
                matte: false,
                scale_percent: None,
                allow_overwrite: false,
                dpi: heeler_io::DEFAULT_DPI,
            },
            |_, _| {},
        )
        .unwrap();
        let info = heeler_io::exr_passes::inspect_file(Path::new(&written)).unwrap();
        for name in ["sky.A", "sky-2.A"] {
            assert!(info.channels.iter().any(|c| c == name), "missing channel {name}");
        }
    }

    #[test]
    fn export_layers_write_siblings_for_tiff() {
        let dir = tempfile::tempdir().unwrap();
        let dest = dir.path().join("photo.tif");
        // A sibling name already taken: somebody's file, never ours to
        // replace, even mid-export. The layer moves to a free name.
        let taken = dir.path().join("photo.subject.tif");
        std::fs::write(&taken, b"not ours").unwrap();
        let ui = export_layer_graph();
        let smart = depth_plant();
        let (alpha, layers) = render_export_layers(&ui, export_layer_source(), &smart, |_, _| {}).unwrap();
        let written = finish_export(
            crate::ExportInput {
                graph: &ui,
                source_path: None,
                source: export_layer_source(),
                smart: &smart,
                keywords: &[],
                alpha,
                layers,
            },
            &dest,
            crate::ExportOptions {
                format: "tiff",
                quality: 90,
                max_edge: None,
                keep_metadata: true,
                matte: false,
                scale_percent: None,
                allow_overwrite: false,
                dpi: heeler_io::DEFAULT_DPI,
            },
            |_, _| {},
        )
        .unwrap();
        // The beauty carries the alpha port as a fourth sample.
        let bytes = std::fs::read(&written).unwrap();
        let ifd = u32::from_le_bytes(bytes[4..8].try_into().unwrap()) as usize;
        let entries = u16::from_le_bytes(bytes[ifd..ifd + 2].try_into().unwrap()) as usize;
        let samples = (0..entries)
            .map(|i| ifd + 2 + i * 12)
            .find(|&at| u16::from_le_bytes(bytes[at..at + 2].try_into().unwrap()) == 277)
            .map(|at| u16::from_le_bytes(bytes[at + 8..at + 10].try_into().unwrap()));
        assert_eq!(samples, Some(4), "the beauty carries its alpha");
        // Mask and depth layers are sibling grays, the image layer an
        // RGBA sibling (26.3 Phase 8). The taken name is sidestepped,
        // not replaced.
        assert_eq!(
            std::fs::read(dir.path().join("photo.subject.tif")).unwrap(),
            b"not ours",
            "an existing sibling is never overwritten"
        );
        for (name, file) in [
            ("sky", "photo.sky.tif"),
            ("subject", "photo.subject-2.tif"),
            ("farness", "photo.farness.tif"),
        ] {
            let sibling = dir.path().join(file);
            assert!(sibling.exists(), "missing sibling for {name}");
            let (samples, values) = grey_tiff_pixels(&std::fs::read(&sibling).unwrap());
            assert_eq!(samples, 1, "{name} is a one-sample gray");
            assert_eq!(values.len(), 2, "{name} at the beauty's size");
        }
        // The image tap's sibling is RGBA: red and green, both opaque.
        let grade = dir.path().join("photo.grade.tif");
        assert!(grade.exists(), "missing sibling for grade");
        let (samples, values) = grey_tiff_pixels(&std::fs::read(&grade).unwrap());
        assert_eq!(samples, 4, "an image tap's sibling is RGBA");
        assert_eq!(values.len(), 8, "two pixels of RGBA");
        let close = |a: f32, b: f32, what: &str| assert!((a - b).abs() < 0.001, "{what}: {a} vs {b}");
        close(values[0], 1.0, "grade R of the red pixel");
        close(values[1], 0.0, "grade G of the red pixel");
        close(values[3], 1.0, "grade A of the red pixel");
        close(values[4], 0.0, "grade R of the green pixel");
        close(values[5], 1.0, "grade G of the green pixel");
        // Sky is the mask, display-encoded like the beauty: luma 0.2126
        // through the sRGB curve.
        let (_, sky) = grey_tiff_pixels(&std::fs::read(dir.path().join("photo.sky.tif")).unwrap());
        let want = heeler_io::linear_to_srgb(0.2126);
        assert!((sky[0] - want).abs() < 0.001, "sky sibling: {} vs {want}", sky[0]);
        // Farness is the planted depth plane as a gray.
        let (_, far) = grey_tiff_pixels(&std::fs::read(dir.path().join("photo.farness.tif")).unwrap());
        let want = heeler_io::linear_to_srgb(0.25);
        assert!((far[0] - want).abs() < 0.001, "farness sibling: {} vs {want}", far[0]);
    }

    /// A Develop layer's section box (2026-10-03: "at the end of the day
    /// everything is a node network. The export process should be processing
    /// nodes in order"): the Export Layer taps the layer's own node, so what
    /// is written is the picture at that point, the layer's edit applied
    /// through its mask, and nothing downstream.
    #[test]
    fn an_export_layer_on_a_develop_layers_node_writes_the_picture_at_that_node() {
        let node = |id: &str, ty: &str, params: &[(&str, serde_json::Value)]| UiNode {
            id: id.into(),
            node_type: ty.into(),
            enabled: true,
            params: params.iter().map(|(k, v)| (k.to_string(), v.clone())).collect(),
        };
        let wire = |from: (&str, &str), to: (&str, &str)| UiConnection {
            from: (from.0.into(), from.1.into()),
            to: (to.0.into(), to.1.into()),
        };
        let graph = |with_later: bool, with_tap: bool| {
            let mut nodes = vec![
                node("src", "heeler.image_source", &[]),
                node("layer_1_mask", "heeler.luminance_extract", &[]),
                node("layer_1_adj", "heeler.exposure", &[("exposure", serde_json::json!(1.0))]),
                node("out", "heeler.output", &[]),
            ];
            let mut connections = vec![
                wire(("src", "out"), ("layer_1_mask", "in")),
                wire(("src", "out"), ("layer_1_adj", "in")),
                wire(("layer_1_mask", "out"), ("layer_1_adj", "mask")),
            ];
            if with_later {
                nodes.push(node("later", "heeler.exposure", &[("exposure", serde_json::json!(-2.0))]));
                connections.push(wire(("layer_1_adj", "out"), ("later", "in")));
                connections.push(wire(("later", "out"), ("out", "in")));
            } else {
                connections.push(wire(("layer_1_adj", "out"), ("out", "in")));
            }
            if with_tap {
                // As the section's box makes it: source, tap and layer
                // ride along as text the engine does not read.
                nodes.push(node("dev_x_layer_1_adj_exposure", "heeler.export_layer", &[
                    ("name", serde_json::json!("Sky Exposure")),
                    ("source", serde_json::json!("develop:Exposure")),
                    ("tap", serde_json::json!("layer_1_adj")),
                    ("layer", serde_json::json!("layer_1_adj")),
                ]));
                connections.push(wire(("layer_1_adj", "out"), ("dev_x_layer_1_adj_exposure", "in")));
            }
            UiGraph { graph_id: "t".into(), nodes, connections }
        };
        let none = HashMap::new();
        let (_, layers) = render_export_layers(&graph(true, true), export_layer_source(), &none, |_, _| {}).unwrap();
        assert_eq!(layers.len(), 1);
        assert_eq!(layers[0].name, "Sky Exposure");
        let Value::Image(written) = &layers[0].value else { panic!("the layer is a picture") };
        // The picture as the layer leaves it: the same graph ending at
        // the layer's node.
        let at_the_layer = render_export(&graph(false, false), export_layer_source(), &none).unwrap();
        for (a, b) in written.data.iter().zip(&at_the_layer.data) {
            assert!((a - b).abs() < 1e-5, "written {a}, at the layer {b}");
        }
        // Through the mask: the green pixel (mask 0.72) is lifted more
        // than the red one (mask 0.21), and neither is the source.
        let source = export_layer_source();
        let lift = |x: usize, c: usize| written.pixel(x, 0)[c] / source.pixel(x, 0)[c];
        assert!(lift(1, 1) > lift(0, 0) + 0.2, "green {} against red {}", lift(1, 1), lift(0, 0));
        assert!(lift(0, 0) > 1.05);
        // And not the Output's picture, which the later node darkened.
        let beauty = render_export(&graph(true, true), export_layer_source(), &none).unwrap();
        assert!(beauty.pixel(1, 0)[1] < written.pixel(1, 0)[1] * 0.5);
        // The tap changes nothing downstream.
        let untapped = render_export(&graph(true, false), export_layer_source(), &none).unwrap();
        assert_eq!(beauty.data, untapped.data);
    }

    #[test]
    fn review_checked_develop_exposure_and_curves_write_readable_exr_and_tiff_layers() {
        // Generated by the frontend's actual sectionExportCommand and
        // serializeGraph, in layersectionexport.test.tsx.
        let ui: UiGraph = serde_json::from_str(include_str!("../test-data/review-layer-sections.json")).unwrap();
        let mut source = ImageBuf::new(2, 1);
        source.set_pixel(0, 0, [0.05, 0.1, 0.2, 1.0]);
        source.set_pixel(1, 0, [0.2, 0.15, 0.1, 1.0]);
        let source = Arc::new(source);
        let smart = HashMap::new();
        let dir = tempfile::tempdir().unwrap();
        for format in ["exr", "tiff"] {
            let (alpha, layers) = render_export_layers(&ui, source.clone(), &smart, |_, _| {}).unwrap();
            assert_eq!(layers.iter().map(|l| l.name.as_str()).collect::<Vec<_>>(), ["Sky Exposure", "Sky Curves"]);
            let expected: Vec<_> = layers.iter().map(|l| (l.name.clone(), l.value.as_image().unwrap().clone())).collect();
            assert!(expected[0].1.pixel(0, 0)[0] > source.pixel(0, 0)[0]);
            assert!(expected[1].1.pixel(0, 0)[0] < expected[0].1.pixel(0, 0)[0]);
            let dest = dir.path().join(if format == "exr" { "review.exr" } else { "review.tif" });
            let written = finish_export(
                crate::ExportInput {
                    graph: &ui,
                    source_path: None,
                    source: source.clone(),
                    smart: &smart,
                    keywords: &[],
                    alpha,
                    layers,
                },
                &dest,
                crate::ExportOptions {
                    format,
                    quality: 90,
                    max_edge: None,
                    keep_metadata: true,
                    matte: false,
                    scale_percent: None,
                    allow_overwrite: false,
                    dpi: heeler_io::DEFAULT_DPI,
                },
                |_, _| {},
            ).unwrap();
            for (name, expected) in expected {
                if format == "exr" {
                    let channel = format!("{name}.R");
                    let values = heeler_io::exr_passes::read_planes_file(Path::new(&written), 0, &[channel.as_str()]).unwrap();
                    for (x, value) in values[0].iter().enumerate() {
                        assert!((value - expected.pixel(x, 0)[0]).abs() < 0.001, "{name}: {value}");
                    }
                } else {
                    let sibling = dir.path().join(format!("review.{name}.tif"));
                    let actual = heeler_io::decode_any(&sibling).unwrap();
                    for (a, b) in actual.data.iter().zip(&expected.data) {
                        assert!((a - b).abs() < 0.001, "{name}: {a} vs {b}");
                    }
                }
            }
        }
    }

    #[test]
    fn tiff_layer_names_stay_in_one_sibling_filename() {
        let dir = tempfile::tempdir().unwrap();
        let dest = dir.path().join("photo.tif");
        let mut ui = export_layer_graph();
        let layer = ui.nodes.iter_mut().find(|n| n.id == "chimg").unwrap();
        layer.params.insert("name".into(), serde_json::json!("Sky / blue"));
        let smart = depth_plant();
        let (alpha, layers) = render_export_layers(&ui, export_layer_source(), &smart, |_, _| {}).unwrap();
        finish_export(
            crate::ExportInput {
                graph: &ui,
                source_path: None,
                source: export_layer_source(),
                smart: &smart,
                keywords: &[],
                alpha,
                layers,
            },
            &dest,
            crate::ExportOptions {
                format: "tiff",
                quality: 90,
                max_edge: None,
                keep_metadata: false,
                matte: false,
                scale_percent: None,
                allow_overwrite: false,
                dpi: heeler_io::DEFAULT_DPI,
            },
            |_, _| {},
        ).unwrap();
        assert!(dir.path().join("photo.Sky _ blue.tif").is_file());
        assert!(std::fs::read_dir(dir.path()).unwrap().all(|e| e.unwrap().path().is_file()));
    }

    #[test]
    fn a_png_export_carries_the_alpha_port_and_names_dropped_layers() {
        let dir = tempfile::tempdir().unwrap();
        let dest = dir.path().join("photo.png");
        let ui = export_layer_graph();
        let smart = depth_plant();
        let mut logged: Vec<String> = Vec::new();
        let (alpha, layers) = render_export_layers(&ui, export_layer_source(), &smart, |_, _| {}).unwrap();
        let written = finish_export(
            crate::ExportInput {
                graph: &ui,
                source_path: None,
                source: export_layer_source(),
                smart: &smart,
                keywords: &[],
                alpha,
                layers,
            },
            &dest,
            crate::ExportOptions {
                format: "png",
                quality: 90,
                max_edge: None,
                keep_metadata: true,
                matte: false,
                scale_percent: None,
                allow_overwrite: false,
                dpi: heeler_io::DEFAULT_DPI,
            },
            |level, msg| logged.push(format!("{level}: {msg}")),
        )
        .unwrap();
        // Beauty plus alpha; the layer nodes are named as dropped.
        let decoded = heeler_io::decode_png_raw(&std::fs::read(&written).unwrap()).unwrap();
        assert!((decoded.pixel(0, 0)[3] - 0.2126).abs() < 0.01, "png alpha is the port's");
        assert!((decoded.pixel(1, 0)[3] - 0.7152).abs() < 0.01, "png alpha is the port's");
        for name in ["sky", "subject", "grade", "farness"] {
            assert!(logged.iter().any(|m| m.contains(name) && m.contains("not written")), "drop logged for {name}");
        }
        assert!(std::fs::read_dir(dir.path()).unwrap().count() == 1, "no siblings for png");
    }

    #[test]
    fn a_disabled_export_layer_writes_nothing() {
        let dir = tempfile::tempdir().unwrap();
        let dest = dir.path().join("photo.exr");
        let mut ui = export_layer_graph();
        ui.nodes.iter_mut().find(|n| n.id == "chm2").unwrap().enabled = false;
        let smart = depth_plant();
        let (alpha, layers) = render_export_layers(&ui, export_layer_source(), &smart, |_, _| {}).unwrap();
        let written = finish_export(
            crate::ExportInput {
                graph: &ui,
                source_path: None,
                source: export_layer_source(),
                smart: &smart,
                keywords: &[],
                alpha,
                layers,
            },
            &dest,
            crate::ExportOptions {
                format: "exr",
                quality: 90,
                max_edge: None,
                keep_metadata: true,
                matte: false,
                scale_percent: None,
                allow_overwrite: false,
                dpi: heeler_io::DEFAULT_DPI,
            },
            |_, _| {},
        )
        .unwrap();
        let info = heeler_io::exr_passes::inspect_file(Path::new(&written)).unwrap();
        assert!(info.channels.iter().any(|c| c == "sky.A"));
        assert!(!info.channels.iter().any(|c| c.starts_with("subject")), "a disabled layer writes nothing");
    }

    /// 26.3 Phase 8 milestone 3's graph: what the Finish tab's Export
    /// checkbox serializes to. An exposure stands in for the paint
    /// canvas (a neutral passthrough of the source), its blend carries
    /// the layer's mode and opacity, the layer's mask sits on the
    /// blend's mask port, and the Export Layer node taps the content
    /// with `source` pointing back at the blend.
    pub(crate) fn finish_layer_graph() -> UiGraph {
        let node = |id: &str, ty: &str, params: &[(&str, serde_json::Value)]| UiNode {            id: id.into(),
            node_type: ty.into(),
            enabled: true,
            params: params.iter().map(|(k, v)| (k.to_string(), v.clone())).collect(),
        };
        UiGraph {
            graph_id: "t".into(),
            nodes: vec![
                node("src", "heeler.image_source", &[]),
                node("cnt", "heeler.exposure", &[]),
                node("lm", "heeler.luminance_extract", &[]),
                node(
                    "blend1",
                    "heeler.blend",
                    &[("mode", serde_json::json!("soft_light")), ("opacity", serde_json::json!(50.0))],
                ),
                node(
                    "ex",
                    "heeler.export_layer",
                    &[
                        ("name", serde_json::json!("Pixel 1")),
                        ("source", serde_json::json!("finish:blend1")),
                        ("group", serde_json::json!("")),
                    ],
                ),
                node("out", "heeler.output", &[]),
            ],
            connections: vec![
                UiConnection { from: ("src".into(), "out".into()), to: ("cnt".into(), "in".into()) },
                UiConnection { from: ("src".into(), "out".into()), to: ("lm".into(), "in".into()) },
                UiConnection { from: ("src".into(), "out".into()), to: ("out".into(), "in".into()) },
                // The layer's own mask, on the blend it belongs to.
                UiConnection { from: ("lm".into(), "out".into()), to: ("blend1".into(), "mask".into()) },
                // The checkbox's tap: the content, before the blend.
                UiConnection { from: ("cnt".into(), "out".into()), to: ("ex".into(), "in".into()) },
            ],
        }
    }

    /// A 2x1 source with mid-tone values, so display-referred and
    /// scene-linear are tellingly different numbers.
    pub(crate) fn finish_layer_source() -> Arc<ImageBuf> {
        let mut img = ImageBuf::new(2, 1);
        img.set_pixel(0, 0, [0.5, 0.25, 0.0, 1.0]);
        img.set_pixel(1, 0, [1.0, 0.5, 1.0, 1.0]);
        Arc::new(img)
    }

    /// Read a float TIFF's first directory: samples per pixel, and the
    /// values back out of the strip.
    fn f32_tiff_pixels(bytes: &[u8]) -> (u16, Vec<f32>) {
        assert_eq!(&bytes[..2], b"II", "a TIFF sibling is little-endian TIFF");
        let ifd = u32::from_le_bytes(bytes[4..8].try_into().unwrap()) as usize;
        let entries = u16::from_le_bytes(bytes[ifd..ifd + 2].try_into().unwrap()) as usize;
        let field = |tag: u16| {
            (0..entries)
                .map(|i| ifd + 2 + i * 12)
                .find(|&at| u16::from_le_bytes(bytes[at..at + 2].try_into().unwrap()) == tag)
                .map(|at| &bytes[at..at + 12])
        };
        let samples = u16::from_le_bytes(field(277).unwrap()[8..10].try_into().unwrap());
        let strip = u32::from_le_bytes(field(273).unwrap()[8..12].try_into().unwrap()) as usize;
        let count = u32::from_le_bytes(field(279).unwrap()[8..12].try_into().unwrap()) as usize;
        let values = bytes[strip..strip + count]
            .chunks_exact(4)
            .map(|b| f32::from_le_bytes(b.try_into().unwrap()))
            .collect();
        (samples, values)
    }

    #[test]
    fn a_finish_sourced_layer_writes_display_referred_with_the_record() {
        let dir = tempfile::tempdir().unwrap();
        let dest = dir.path().join("photo.exr");
        let ui = finish_layer_graph();
        let (alpha, layers) = render_export_layers(&ui, finish_layer_source(), &HashMap::new(), |_, _| {}).unwrap();
        assert_eq!(layers.len(), 1, "one Finish layer ticked, one layer");
        assert_eq!(layers[0].name, "Pixel 1");
        let written = finish_export(
            crate::ExportInput {
                graph: &ui,
                source_path: None,
                source: finish_layer_source(),
                smart: &HashMap::new(),
                keywords: &[],
                alpha,
                layers,
            },
            &dest,
            crate::ExportOptions {
                format: "exr",
                quality: 90,
                max_edge: None,
                keep_metadata: true,
                matte: false,
                scale_percent: None,
                allow_overwrite: false,
                dpi: heeler_io::DEFAULT_DPI,
            },
            |_, _| {},
        )
        .unwrap();
        let names = ["Pixel 1.R", "Pixel 1.G", "Pixel 1.B", "Pixel 1.A"];
        let planes = heeler_io::exr_passes::read_planes_file(Path::new(&written), 0, &names).unwrap();
        let close = |a: f32, b: f32, what: &str| assert!((a - b).abs() < 0.002, "{what}: {a} vs {b}");
        // Display-referred color linearized into the scene-linear EXR,
        // and premultiplied by the layer's alpha in the file, the
        // convention a compositor merges by; Layers from File brings it
        // back straight.
        close(planes[0][0], heeler_io::srgb_to_linear(0.5) * planes[3][0], "R of the first pixel");
        close(planes[1][0], heeler_io::srgb_to_linear(0.25) * planes[3][0], "G of the first pixel");
        close(planes[0][1], 1.0 * planes[3][1], "R of the second pixel");
        let back = heeler_io::exr_passes::decode_layer_file(Path::new(&written), "Pixel 1").unwrap();
        close(back.pixel(0, 0)[0], heeler_io::srgb_to_linear(0.5), "R of the first pixel, straight again in Heeler");
        // The layer's mask (luma) and the blend's 50% opacity are
        // folded into the written alpha; alpha is coverage and does
        // not linearize.
        let luma0 = 0.2126 * 0.5 + 0.7152 * 0.25;
        let luma1 = 0.2126 + 0.7152 * 0.5 + 0.0722;
        close(planes[3][0], (luma0 * 0.5) as f32, "A of the first pixel");
        close(planes[3][1], (luma1 * 0.5) as f32, "A of the second pixel");
        // The record rides in the header: mode and opacity, and no
        // group attribute for a layer in no group.
        let p = Path::new(&written);
        assert_eq!(
            heeler_io::exr_passes::header_text_file(p, "heeler.layer.Pixel 1.mode").as_deref(),
            Some("soft_light"),
        );
        assert_eq!(
            heeler_io::exr_passes::header_text_file(p, "heeler.layer.Pixel 1.opacity").as_deref(),
            Some("50"),
        );
        assert_eq!(heeler_io::exr_passes::header_text_file(p, "heeler.layer.Pixel 1.group"), None);
    }

    #[test]
    fn a_finish_sourced_tiff_sibling_keeps_display_values() {
        let dir = tempfile::tempdir().unwrap();
        let ui = finish_layer_graph();
        // The 16-bit sibling: display-referred values as they are, no
        // curve, and the record in the description tag.
        let dest = dir.path().join("photo.tif");
        let (alpha, layers) = render_export_layers(&ui, finish_layer_source(), &HashMap::new(), |_, _| {}).unwrap();
        finish_export(
            crate::ExportInput {
                graph: &ui,
                source_path: None,
                source: finish_layer_source(),
                smart: &HashMap::new(),
                keywords: &[],
                alpha,
                layers,
            },
            &dest,
            crate::ExportOptions {
                format: "tiff",
                quality: 90,
                max_edge: None,
                keep_metadata: true,
                matte: false,
                scale_percent: None,
                allow_overwrite: false,
                dpi: heeler_io::DEFAULT_DPI,
            },
            |_, _| {},
        )
        .unwrap();
        let sibling = dir.path().join("photo.Pixel 1.tif");
        assert!(sibling.exists(), "the sibling is named after the Finish layer");
        let bytes = std::fs::read(&sibling).unwrap();
        let (samples, values) = grey_tiff_pixels(&bytes);
        assert_eq!(samples, 4, "a Finish layer sibling is RGBA");
        let close = |a: f32, b: f32, what: &str| assert!((a - b).abs() < 0.001, "{what}: {a} vs {b}");
        close(values[0], 0.5, "R as it was, no sRGB curve");
        close(values[1], 0.25, "G as it was, no sRGB curve");
        let luma0 = 0.2126 * 0.5 + 0.7152 * 0.25;
        close(values[3], (luma0 * 0.5) as f32, "A carries the mask and the opacity");
        let hay = String::from_utf8_lossy(&bytes);
        assert!(hay.contains("Heeler Finish layer 'Pixel 1': mode=soft_light, opacity=50"), "the description records the blend");
        assert!(hay.contains("record only"), "the description says no reader acts on it");
        // The float sibling: linearized, the way the EXR is.
        let dest32 = dir.path().join("photo32.tif");
        let (alpha, layers) = render_export_layers(&ui, finish_layer_source(), &HashMap::new(), |_, _| {}).unwrap();
        finish_export(
            crate::ExportInput {
                graph: &ui,
                source_path: None,
                source: finish_layer_source(),
                smart: &HashMap::new(),
                keywords: &[],
                alpha,
                layers,
            },
            &dest32,
            crate::ExportOptions {
                format: "tiff32",
                quality: 90,
                max_edge: None,
                keep_metadata: true,
                matte: false,
                scale_percent: None,
                allow_overwrite: false,
                dpi: heeler_io::DEFAULT_DPI,
            },
            |_, _| {},
        )
        .unwrap();
        let bytes32 = std::fs::read(dir.path().join("photo32.Pixel 1.tif")).unwrap();
        let (samples32, values32) = f32_tiff_pixels(&bytes32);
        assert_eq!(samples32, 4, "the float sibling is RGBA");
        close(values32[0], heeler_io::srgb_to_linear(0.5), "float R linearized");
        close(values32[3], (luma0 * 0.5) as f32, "float A stays coverage");
        // The float sibling's pixels were linearized, so its own
        // description never calls them display-referred; the 16-bit
        // sibling above keeps both the display values and the words.
        let hay32 = String::from_utf8_lossy(&bytes32);
        assert!(hay32.contains("linearized into scene-linear"), "the float sibling's description matches its pixels");
        assert!(!hay32.contains("; display-referred,"), "a linearized sibling never claims display-referred pixels");
    }

    #[test]
    fn the_transparent_toggle_yields_to_a_wired_alpha_port() {
        let dir = tempfile::tempdir().unwrap();
        let dest = dir.path().join("photo.png");
        let ui = export_layer_graph();
        // matte on, no Smart mask planted: the toggle alone would export
        // opaque with a warning. The wired port wins instead.
        let (alpha, layers) = render_export_layers(&ui, export_layer_source(), &HashMap::new(), |_, _| {}).unwrap();
        let written = finish_export(
            crate::ExportInput {
                graph: &ui,
                source_path: None,
                source: export_layer_source(),
                smart: &HashMap::new(),
                keywords: &[],
                alpha,
                layers,
            },
            &dest,
            crate::ExportOptions {
                format: "png",
                quality: 90,
                max_edge: None,
                keep_metadata: true,
                matte: true,
                scale_percent: None,
                allow_overwrite: false,
                dpi: heeler_io::DEFAULT_DPI,
            },
            |_, _| {},
        )
        .unwrap();
        let decoded = heeler_io::decode_png_raw(&std::fs::read(&written).unwrap()).unwrap();
        assert!((decoded.pixel(0, 0)[3] - 0.2126).abs() < 0.01, "the port, not the toggle");
    }

    /// 26.3 Phase 8: a selection wired to the Export Layer's alpha input
    /// REPLACES the written layer's alpha, in the EXR and as a TIFF
    /// sibling alike (sending a selection to a layer for
    /// export). The wire's own rgb is untouched.
    #[test]
    fn an_image_taps_wired_alpha_is_the_written_layers_alpha() {
        let dir = tempfile::tempdir().unwrap();
        let mut ui = export_layer_graph();
        ui.connections.push(UiConnection {
            from: ("lm".into(), "out".into()),
            to: ("chimg".into(), "alpha".into()),
        });
        let smart = depth_plant();

        // EXR: grade.A is the selection, not the wire's own alpha.
        let dest = dir.path().join("photo.exr");
        let (alpha, layers) = render_export_layers(&ui, export_layer_source(), &smart, |_, _| {}).unwrap();
        let written = finish_export(
            crate::ExportInput {
                graph: &ui,
                source_path: None,
                source: export_layer_source(),
                smart: &smart,
                keywords: &[],
                alpha,
                layers,
            },
            &dest,
            crate::ExportOptions {
                format: "exr",
                quality: 90,
                max_edge: None,
                keep_metadata: true,
                matte: false,
                scale_percent: None,
                allow_overwrite: false,
                dpi: heeler_io::DEFAULT_DPI,
            },
            |_, _| {},
        )
        .unwrap();
        let planes = heeler_io::exr_passes::read_planes_file(Path::new(&written), 0, &["grade.R", "grade.A"]).unwrap();
        // In the file the wire's R rides premultiplied by the selection.
        assert!((planes[0][0] - 1.0 * planes[1][0]).abs() < 0.002, "grade.R is the wire's, premultiplied by grade.A: {}", planes[0][0]);
        assert!((planes[1][0] - 0.2126).abs() < 0.002, "grade.A is the selection: {}", planes[1][0]);
        assert!((planes[1][1] - 0.7152).abs() < 0.002, "grade.A is the selection: {}", planes[1][1]);

        // TIFF: the RGBA sibling's fourth sample is the selection,
        // display-encoded like the beauty.
        let dest = dir.path().join("photo.tif");
        let (alpha, layers) = render_export_layers(&ui, export_layer_source(), &smart, |_, _| {}).unwrap();
        finish_export(
            crate::ExportInput {
                graph: &ui,
                source_path: None,
                source: export_layer_source(),
                smart: &smart,
                keywords: &[],
                alpha,
                layers,
            },
            &dest,
            crate::ExportOptions {
                format: "tiff",
                quality: 90,
                max_edge: None,
                keep_metadata: true,
                matte: false,
                scale_percent: None,
                allow_overwrite: false,
                dpi: heeler_io::DEFAULT_DPI,
            },
            |_, _| {},
        )
        .unwrap();
        let (samples, values) = grey_tiff_pixels(&std::fs::read(dir.path().join("photo.grade.tif")).unwrap());
        assert_eq!(samples, 4, "an image tap's sibling is RGBA");
        // TIFF alpha stores linear (the sRGB curve is for color), so
        // the fourth sample is the selection value as rendered.
        assert!((values[3] - 0.2126).abs() < 0.001, "grade sibling A of the red pixel: {}", values[3]);
        assert!((values[7] - 0.7152).abs() < 0.001, "grade sibling A of the green pixel: {}", values[7]);
        assert!((values[0] - 1.0).abs() < 0.001, "grade sibling R stays the wire's: {}", values[0]);
    }

}
