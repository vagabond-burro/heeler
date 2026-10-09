//! Polish at the photograph's own resolution (2026-09-29: "yes, do the
//! full resolution fix").
//!
//! The matte brush and the Refine edge button solve on the 2048 px
//! preview, which is what keeps a stroke's feedback to a second and a
//! half. The engine then stretched that answer about three times over
//! for 1:1, the settle render and export, so hair that a layer editor keeps
//! crisp at 100 percent was soft in Heeler. At Apply the same question
//! is asked again at full resolution, in overlapping tiles along the
//! stroke (heeler-vision's refine_brushed_full and refine_guided_full),
//! and the answer is kept as a full-resolution raster: the TWIN of the
//! preview raster, keyed by the same recipe version, so undo, redo,
//! takes, copy and paste, linked photographs and Reset Edits carry it
//! exactly as they carry the preview raster, with nothing new in the
//! graph. Planting picks the twin for any render that has one: at the
//! photograph's size for a full render, brought down by area to the
//! render's own size for the preview, so Fit and 1:1 show one matte.
//!
//! A converted (baked) selection loses its strokes at each landing (the
//! refined answer becomes the new base), so each landing leaves a small
//! record beside its raster (MatteStep): the base it refined, the
//! geometry it consumed, the strokes and the dials. Apply walks those
//! records back to a base with no record (the Subject selection itself,
//! or a base an earlier Apply already solved at full resolution) and
//! replays them at full resolution.

use super::*;

/// A selection matte at the photograph's own size, a byte a pixel.
pub(crate) struct FullMatte {
    pub width: usize,
    pub height: usize,
    pub data: Vec<u8>,
}

/// Which raster a render wants from a full-resolution matte: decided by
/// the frame planted for the render (Auto), or said by a caller that
/// plants no frame: an export (Full) or a thumbnail (Preview).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum MatteTier {
    Auto,
    Full,
    Preview,
}

/// The long side a preview-tier matte is planted at when no frame says
/// otherwise: the preview's own (preview_source).
const PREVIEW_EDGE: usize = 2048;

/// Full mattes held decoded in the session: the photograph on screen
/// and one more (a byte a pixel, 24 MB for 24 MP).
const FULL_MATTES_KEPT: usize = 2;

/// Planted planes held in the session: the photograph-size plane (one,
/// 16 bytes a pixel) and the preview-size copies.
const PLANES_KEPT: usize = 3;

/// The twin's own version: the file it is kept in, and never a version
/// the preview raster could have.
pub(crate) fn full_matte_version(want: u64) -> u64 {
    fnv1a64(format!("fullres|{want:016x}").as_bytes())
}

/// Where a twin is kept: under the retained roof, where the Storage
/// clear never looks. A full-resolution solve cannot be rebuilt from
/// the graph without Apply, so it is not a cache.
pub(crate) fn full_matte_path(base: &Path, want: u64) -> PathBuf {
    retained_raster_path(base, full_matte_version(want))
}

/// Where a baked landing's record is kept, beside its raster.
pub(crate) fn matte_step_path(base: &Path, version: u64) -> PathBuf {
    retained_raster_dir(base).join(format!("{version:016x}.matte.json"))
}

/// One brushed (or one-shot) landing on a converted selection: what the
/// full-resolution replay needs that the node no longer carries.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub(crate) struct MatteStep {
    /// The baked base this landing refined, as hex.
    pub parent: String,
    /// The regions it consumed into the new base, as the frontend
    /// serialized them.
    pub regions: String,
    /// Every stroke on the node at the landing (the matte ones are the
    /// band; the rest stay on the node and the engine applies them).
    pub strokes: String,
    pub reach: u32,
    pub contrast: u32,
}

pub(crate) fn record_matte_step(base: &Path, version: u64, step: &MatteStep) -> Result<(), String> {
    let path = matte_step_path(base, version);
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    let bytes = serde_json::to_vec(step).map_err(|e| e.to_string())?;
    std::fs::write(&path, bytes).map_err(|e| e.to_string())
}

pub(crate) fn read_matte_step(base: &Path, version: u64) -> Option<MatteStep> {
    let bytes = std::fs::read(matte_step_path(base, version)).ok()?;
    serde_json::from_slice(&bytes).ok()
}

/// Writes a twin: to a sibling name first and renamed into place, so a
/// reader never meets half a file under the real name.
pub(crate) fn write_full_matte(base: &Path, want: u64, m: &FullMatte) -> Result<(), String> {
    let bytes = heeler_io::encode_png_gray8(&m.data, m.width, m.height).map_err(|e| e.to_string())?;
    let path = full_matte_path(base, want);
    let dir = path.parent().ok_or("no folder for the matte")?;
    std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    let partial = dir.join(format!("{:016x}.png.partial", full_matte_version(want)));
    std::fs::write(&partial, bytes).map_err(|e| e.to_string())?;
    std::fs::rename(&partial, &path).map_err(|e| e.to_string())
}

pub(crate) fn read_full_matte(base: &Path, want: u64) -> Option<FullMatte> {
    let bytes = std::fs::read(full_matte_path(base, want)).ok()?;
    let (width, height, data) = heeler_io::decode_png_gray8(&bytes).ok()?;
    Some(FullMatte { width, height, data })
}

/// The session's twin for `want`, read from disk once and kept.
pub(crate) fn full_matte_for(session: &mut Session, base: Option<&Path>, want: u64) -> Option<Arc<FullMatte>> {
    if let Some(i) = session.full_mattes.iter().position(|(v, _)| *v == want) {
        let entry = session.full_mattes.remove(i);
        let m = entry.1.clone();
        session.full_mattes.push(entry);
        return Some(m);
    }
    let m = Arc::new(read_full_matte(base?, want)?);
    remember_full_matte(session, want, m.clone());
    Some(m)
}

pub(crate) fn remember_full_matte(session: &mut Session, want: u64, m: Arc<FullMatte>) {
    session.full_mattes.retain(|(v, _)| *v != want);
    session.full_mattes.push((want, m));
    while session.full_mattes.len() > FULL_MATTES_KEPT {
        session.full_mattes.remove(0);
    }
}

/// The size a preview-tier plane takes: the matte's aspect at the
/// preview's long side, never larger than the matte.
fn preview_dims(w: usize, h: usize, edge: usize) -> (usize, usize) {
    let long = w.max(h);
    if long <= edge {
        return (w, h);
    }
    let s = edge as f64 / long as f64;
    (((w as f64 * s).round() as usize).max(1), ((h as f64 * s).round() as usize).max(1))
}

/// The size to plant a twin at for this render: the photograph's for a
/// full render or an export, the frame's own for a preview (the whole
/// photograph at a smaller size, so the aspect matches), the preview
/// edge otherwise.
pub(crate) fn plant_dims(tier: MatteTier, frame: Option<(usize, usize)>, w: usize, h: usize) -> (usize, usize) {
    match tier {
        MatteTier::Full => (w, h),
        MatteTier::Preview => preview_dims(w, h, PREVIEW_EDGE),
        MatteTier::Auto => match frame {
            None => (w, h),
            Some((fw, fh)) if fw >= w || fh >= h => (w, h),
            Some((fw, fh)) => {
                let same_shape = ((fw as f64 / fh.max(1) as f64) - (w as f64 / h.max(1) as f64)).abs()
                    < 0.01 * (w as f64 / h.max(1) as f64);
                if same_shape && fw > 0 && fh > 0 {
                    (fw, fh)
                } else {
                    preview_dims(w, h, PREVIEW_EDGE)
                }
            }
        },
    }
}

/// Plants the twin of `want` for node `node_id`, when there is one, at
/// the size this render wants it. Answers whether it planted: false
/// leaves the preview raster's planting to run as before (no twin, or
/// no memory for the photograph-size plane, which the log says).
#[allow(clippy::too_many_arguments)]
pub(crate) fn plant_full_matte(
    session: &mut Session,
    base: Option<&Path>,
    node_id: &str,
    want: u64,
    tier: MatteTier,
    frame: Option<(usize, usize)>,
    sources: &mut HashMap<String, SourceImage>,
) -> bool {
    let Some(m) = full_matte_for(session, base, want) else { return false };
    let (tw, th) = plant_dims(tier, frame, m.width, m.height);
    let version = fnv1a64(format!("fullmatte|{want:016x}|{tw}x{th}").as_bytes());
    let image = if let Some(i) = session.full_matte_planes.iter().position(|(v, _)| *v == version) {
        let entry = session.full_matte_planes.remove(i);
        let image = entry.1.clone();
        session.full_matte_planes.push(entry);
        image
    } else {
        let Some(image) = matte_plane(&m, tw, th) else {
            return false;
        };
        let image = Arc::new(image);
        // One photograph-size plane at a time: they are 16 bytes a pixel.
        if (tw, th) == (m.width, m.height) {
            session
                .full_matte_planes
                .retain(|(_, p)| (p.width, p.height) != (m.width, m.height));
        }
        session.full_matte_planes.push((version, image.clone()));
        while session.full_matte_planes.len() > PLANES_KEPT {
            session.full_matte_planes.remove(0);
        }
        image
    };
    sources.insert(node_id.to_string(), SourceImage { image, version, measured: false });
    true
}

/// The twin as the engine's raster at (tw, th): the bytes themselves at
/// the photograph's size, an area average below it. None when the
/// memory budget refuses the plane.
fn matte_plane(m: &FullMatte, tw: usize, th: usize) -> Option<ImageBuf> {
    let mut out = ImageBuf::try_new(tw, th).ok()?;
    if (tw, th) == (m.width, m.height) {
        for (px, v) in out.data.chunks_mut(4).zip(m.data.iter()) {
            let v = *v as f32 / 255.0;
            px[0] = v;
            px[1] = v;
            px[2] = v;
            px[3] = 1.0;
        }
    } else {
        let plane: Vec<f32> = m.data.iter().map(|v| *v as f32 / 255.0).collect();
        let small = heeler_vision::area_downsample(&plane, m.width, m.height, tw, th);
        for (px, v) in out.data.chunks_mut(4).zip(small.iter()) {
            px[0] = *v;
            px[1] = *v;
            px[2] = *v;
            px[3] = 1.0;
        }
    }
    Some(out)
}

/// A matte-brush stroke as the node carries it.
#[derive(Clone, Debug, Deserialize)]
pub(crate) struct BandStroke {
    pub points: Vec<[f32; 2]>,
    pub radius: f32,
    #[serde(default)]
    pub mode: String,
}

/// The matte strokes of a strokes JSON: every mode the engine does not
/// apply itself, with points.
pub(crate) fn matte_strokes_of(strokes_json: &str) -> Result<Vec<BandStroke>, String> {
    Ok(serde_json::from_str::<Vec<BandStroke>>(strokes_json)
        .map_err(|e| format!("bad strokes: {e}"))?
        .into_iter()
        .filter(|s| !matches!(s.mode.as_str(), "foreground" | "background" | "feather") && !s.points.is_empty())
        .collect())
}

/// The strokes' coverage at (w, h): discs along each polyline at the
/// brush radius (a fraction of the short side), stepped at half a
/// radius so the capsule has no gaps. The preview pass and the
/// full-resolution pass stamp the same band, each at its own size.
pub(crate) fn stamp_band(strokes: &[BandStroke], w: usize, h: usize) -> Vec<f32> {
    let short = w.min(h) as f32;
    let mut band = vec![0.0f32; w * h];
    let mut stamp = |px: f32, py: f32, r: f32| {
        let (cx, cy) = (px * w as f32, py * h as f32);
        let r = r.max(1.0);
        let x0 = ((cx - r).floor().max(0.0)) as usize;
        let y0 = ((cy - r).floor().max(0.0)) as usize;
        let x1 = ((cx + r).ceil().max(0.0) as usize).min(w.saturating_sub(1));
        let y1 = ((cy + r).ceil().max(0.0) as usize).min(h.saturating_sub(1));
        if x0 > x1 || y0 > y1 {
            return;
        }
        for y in y0..=y1 {
            for x in x0..=x1 {
                let d2 = (x as f32 - cx).powi(2) + (y as f32 - cy).powi(2);
                if d2 <= r * r {
                    band[y * w + x] = 1.0;
                }
            }
        }
    };
    for s in strokes {
        let r = s.radius * short;
        for pair in s.points.windows(2) {
            let (a, b) = (pair[0], pair[1]);
            let dist = ((b[0] - a[0]) * w as f32).hypot((b[1] - a[1]) * h as f32);
            let steps = ((dist / (r * 0.5).max(1.0)).ceil() as usize).max(1);
            for i in 0..=steps {
                let t = i as f32 / steps as f32;
                stamp(a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, r);
            }
        }
        if s.points.len() == 1 {
            stamp(s.points[0][0], s.points[0][1], r);
        }
    }
    band
}

/// The widest matte stroke's radius in pixels at (w, h).
pub(crate) fn band_radius_px(strokes: &[BandStroke], w: usize, h: usize) -> f32 {
    let short = w.min(h) as f32;
    strokes.iter().map(|s| s.radius * short).fold(0.0f32, f32::max)
}

/// What Apply's full-resolution pass says back.
#[derive(Clone, Debug, Serialize, PartialEq)]
pub struct MatteFullAnswer {
    /// "done" (the twin is on disk and planting), "kept" (the preview
    /// matte stays, `message` says why), "canceled", "wait" (a brush
    /// landing is still on its way; ask again after it), or "none"
    /// (nothing on this selection was refined by the model).
    pub status: String,
    pub message: String,
    pub tiles: usize,
    pub ms: u64,
    pub width: usize,
    pub height: usize,
}

impl MatteFullAnswer {
    pub(crate) fn said(status: &str, message: impl Into<String>) -> Self {
        MatteFullAnswer { status: status.into(), message: message.into(), tiles: 0, ms: 0, width: 0, height: 0 }
    }
}

/// The job of one node's full-resolution pass, by "image|node", so a
/// second Apply on the same selection cancels the first and an undo can
/// cancel it by name.
pub(crate) fn matte_job_key(image_id: &str, node_id: &str) -> String {
    format!("{image_id}|{node_id}")
}

/// One pass at a time: two would hold two photographs' worth of planes
/// and two model arenas. A second waits here, and gives up at once if
/// it was canceled while it waited.
pub(crate) fn full_matte_gate() -> &'static Mutex<()> {
    static GATE: std::sync::OnceLock<Mutex<()>> = std::sync::OnceLock::new();
    GATE.get_or_init(|| Mutex::new(()))
}

/// The chain of landings to replay for a node's current matte, oldest
/// first, and the base the first one refined. None when there is
/// nothing to replay.
pub(crate) fn baked_chain(base: &Path, want: u64) -> Option<(u64, Vec<(u64, MatteStep)>)> {
    let mut steps = Vec::new();
    let mut v = want;
    let mut seen = std::collections::HashSet::new();
    loop {
        if !seen.insert(v) || steps.len() > 512 {
            return None;
        }
        // A base an earlier Apply already solved at full resolution is
        // where the replay starts, not something to solve again.
        if v != want && full_matte_path(base, v).exists() {
            break;
        }
        let Some(step) = read_matte_step(base, v) else { break };
        let parent = u64::from_str_radix(&step.parent, 16).ok()?;
        steps.push((v, step));
        v = parent;
    }
    if steps.is_empty() {
        return None;
    }
    steps.reverse();
    Some((v, steps))
}

/// The pixels a one-shot's preview answer changed, at full resolution:
/// where the preview matte differs from the preview-scale selection,
/// widened by three preview pixels, carried up by nearest neighbor.
fn guided_unknown(preview: &[f32], coarse_small: &[f32], pw: usize, ph: usize, w: usize, h: usize) -> Vec<bool> {
    let changed: Vec<bool> = preview.iter().zip(coarse_small).map(|(p, c)| (p - c).abs() > 2.0 / 255.0).collect();
    let r = 3usize;
    let mut rows = vec![false; pw * ph];
    for y in 0..ph {
        for x in 0..pw {
            let (x0, x1) = (x.saturating_sub(r), (x + r).min(pw - 1));
            rows[y * pw + x] = (x0..=x1).any(|xx| changed[y * pw + xx]);
        }
    }
    let mut grown = vec![false; pw * ph];
    for y in 0..ph {
        let (y0, y1) = (y.saturating_sub(r), (y + r).min(ph - 1));
        for x in 0..pw {
            grown[y * pw + x] = (y0..=y1).any(|yy| rows[yy * pw + x]);
        }
    }
    let mut out = vec![false; w * h];
    for y in 0..h {
        let sy = ((y as f64 + 0.5) * ph as f64 / h as f64) as usize;
        for x in 0..w {
            let sx = ((x as f64 + 0.5) * pw as f64 / w as f64) as usize;
            out[y * w + x] = grown[sy.min(ph - 1) * pw + sx.min(pw - 1)];
        }
    }
    out
}

/// The bounding box of the set pixels of `on`, grown by `margin` and
/// kept in the frame: (x, y, w, h). None when nothing is set.
fn region_of(on: impl Fn(usize) -> bool, w: usize, h: usize, margin: usize) -> Option<(usize, usize, usize, usize)> {
    let (mut x0, mut y0, mut x1, mut y1) = (w, h, 0usize, 0usize);
    for y in 0..h {
        for x in 0..w {
            if on(y * w + x) {
                x0 = x0.min(x);
                y0 = y0.min(y);
                x1 = x1.max(x);
                y1 = y1.max(y);
            }
        }
    }
    if x0 > x1 {
        return None;
    }
    let (x0, y0) = (x0.saturating_sub(margin), y0.saturating_sub(margin));
    let (x1, y1) = ((x1 + margin).min(w - 1), (y1 + margin).min(h - 1));
    Some((x0, y0, x1 - x0 + 1, y1 - y0 + 1))
}

fn crop_plane<T: Copy>(src: &[T], w: usize, r: (usize, usize, usize, usize), channels: usize) -> Vec<T> {
    let (x0, y0, rw, rh) = r;
    let mut out = Vec::with_capacity(rw * rh * channels);
    for y in y0..y0 + rh {
        out.extend_from_slice(&src[(y * w + x0) * channels..(y * w + x0 + rw) * channels]);
    }
    out
}

/// What the full-resolution pass needs from the photograph: its
/// display-encoded pixels at the frame the selection reads, as bytes.
pub(crate) fn display_bytes(img: &ImageBuf) -> Vec<u8> {
    let mut rgb = vec![0u8; img.width * img.height * 3];
    for (i, px) in img.data.chunks(4).enumerate() {
        for c in 0..3 {
            rgb[i * 3 + c] = (heeler_engine::ops::to_display(px[c].max(0.0)).min(1.0) * 255.0).round() as u8;
        }
    }
    rgb
}

/// One stretch of the replay: the coarse selection it starts from and
/// the landings solved together over it. A landing that consumed drawn
/// regions starts a new stretch (its coarse is the regions over the
/// answer so far, which the engine renders); consecutive brush landings
/// share one pass over the union of their strokes, since the model's
/// answer under a stroke does not depend on the selection there.
pub(crate) struct Stretch {
    pub parent_render: bool,
    pub regions: String,
    pub strokes: Vec<BandStroke>,
    pub reach: u32,
    pub contrast: u32,
    /// The landing versions whose preview answers guide a one-shot.
    pub versions: Vec<u64>,
    pub one_shot: bool,
}

pub(crate) fn stretches_of(steps: &[(u64, MatteStep)]) -> Result<Vec<Stretch>, String> {
    let mut out: Vec<Stretch> = Vec::new();
    for (i, (version, step)) in steps.iter().enumerate() {
        let strokes = matte_strokes_of(&step.strokes)?;
        let has_regions = step.regions.trim() != "[]" && !step.regions.trim().is_empty();
        let one_shot = strokes.is_empty();
        let joins = i > 0
            && !has_regions
            && !one_shot
            && out.last().is_some_and(|s| !s.one_shot && s.reach == step.reach && s.contrast == step.contrast);
        if joins {
            let last = out.last_mut().expect("checked");
            last.strokes.extend(strokes);
            last.versions.push(*version);
        } else {
            out.push(Stretch {
                parent_render: i == 0 || has_regions,
                regions: step.regions.clone(),
                strokes,
                reach: step.reach,
                contrast: step.contrast,
                versions: vec![*version],
                one_shot,
            });
        }
    }
    Ok(out)
}

/// The full-resolution pass for one selection, start to finish. Runs on
/// a worker thread; reports on the progress row under `job` and stops
/// between tiles when `job` is canceled.
pub(crate) fn run_full_matte(
    app: &tauri::AppHandle,
    graph: &UiGraph,
    image_id: &str,
    node_id: &str,
    job: &str,
) -> Result<MatteFullAnswer, String> {
    let started = std::time::Instant::now();
    let base = vision_base(app)?;
    let node = graph.nodes.iter().find(|n| n.id == node_id).ok_or("the selection is not in the graph")?;
    if node.node_type != "heeler.selection_mask" {
        return Ok(MatteFullAnswer::said("none", ""));
    }
    let text = |k: &str| node.params.get(k).and_then(|v| v.as_str()).unwrap_or("").to_string();
    let matte_id = text("matte_id");
    if matte_id.is_empty() {
        return Ok(MatteFullAnswer::said("none", ""));
    }
    let want = smart_want(image_id, node, depth_recipe(graph), None);
    if full_matte_path(&base, want).exists() {
        return Ok(MatteFullAnswer::said("done", "already at full resolution"));
    }
    let baked = matte_id.starts_with("baked:");
    let node_strokes = text("strokes");
    let pending = matte_strokes_of(if node_strokes.is_empty() { "[]" } else { &node_strokes })?;
    if baked && !pending.is_empty() {
        return Ok(MatteFullAnswer::said("wait", "a brush stroke is still being read"));
    }
    if !heeler_vision::installed(&base, &heeler_vision::VITMATTE) {
        return Ok(MatteFullAnswer::said(
            "kept",
            "The full-resolution matte needs the matting model, which is not installed, so the preview-resolution matte stays",
        ));
    }
    // The landings to replay and the base under the first.
    let (root, steps) = if baked {
        match baked_chain(&base, want) {
            Some(c) => c,
            None => return Ok(MatteFullAnswer::said("none", "")),
        }
    } else {
        let regions = text("regions");
        (
            0,
            vec![(
                want,
                MatteStep {
                    parent: String::new(),
                    regions: if regions.is_empty() { "[]".into() } else { regions },
                    strokes: if node_strokes.is_empty() { "[]".into() } else { node_strokes.clone() },
                    reach: matte_reach(&node.params),
                    contrast: matte_contrast_of(&node.params),
                },
            )],
        )
    };
    // A plain selection's Refine edge answer is what a one-shot replay
    // is guided by; with no preview answer for the recipe on screen (the
    // selection changed since, and renders classically), there is
    // nothing refined to redo.
    if !baked && pending.is_empty() && !smart_raster_lookup(&base, want).exists() {
        return Ok(MatteFullAnswer::said("none", ""));
    }
    let stretches = stretches_of(&steps)?;
    let in_feed = graph
        .connections
        .iter()
        .find(|c| c.to.0 == node_id && c.to.1 == "in")
        .map(|c| c.from.0.clone())
        .ok_or("the selection has no image input")?;

    progress::emit(app, "matte", job, 0, 0, "Reading the photograph at full resolution for the matte");
    let opts = source_opts_of(graph);
    let source = full_source(app, image_id, opts)?;
    // The budget: the pass's planes (coarse, answer, band, the region's
    // working copies) at 32 bytes a pixel of the photograph, and the
    // model's working set for one tile (under a gigabyte at 768 px,
    // measured on the lemur).
    let need = memory::sum([
        memory::bytes(source.width, source.height, 1, 32).map_err(|e| e.to_string())?,
        1024 * 1024 * 1024,
    ])
    .map_err(|e| e.to_string())?;
    let _admitted = match Job::admit(need, "full-resolution matte") {
        Ok(j) => j,
        Err(e) => {
            return Ok(MatteFullAnswer::said(
                "kept",
                format!("There is not enough memory for the full-resolution matte, so the preview-resolution matte stays ({e})"),
            ))
        }
    };
    let registry = Registry::builtin();
    let full_version = source_version(&source_version_key(app, image_id, opts), true, source.width.max(source.height));
    // A fresh executor: the pass's full-resolution intermediates go when
    // it ends instead of crowding the session's preview cache.
    let mut exec = Executor::new();
    let mut rgb: Option<Vec<u8>> = None;
    let (mut w, mut h) = (0usize, 0usize);
    let mut current: Option<Vec<f32>> = None;
    let mut tiles_run = 0usize;
    let parts = stretches.len();
    // Its own model session, dropped when the pass ends: a session keeps
    // its arena for its life, and the preview's shared one must not
    // carry a full-resolution pass's working set after it.
    let mut refiner: Option<heeler_vision::Refiner> = None;
    let result = (|| -> Result<Option<Vec<f32>>, String> {
        for (k, st) in stretches.iter().enumerate() {
            if progress::is_cancelled(job) {
                return Ok(None);
            }
            // The coarse selection this stretch refines.
            let coarse: Vec<f32> = if st.parent_render || current.is_none() {
                let mut cg = graph.clone();
                if let Some(n) = cg.nodes.iter_mut().find(|n| n.id == node_id) {
                    let matte = if baked {
                        serde_json::json!(format!("baked:{}", if k == 0 { format!("{root:016x}") } else { "0".repeat(16) }))
                    } else {
                        serde_json::json!("")
                    };
                    for (key, v) in [
                        ("strokes", serde_json::json!("[]")),
                        ("regions", serde_json::json!(st.regions.clone())),
                        ("matte_id", matte),
                        ("feather", serde_json::json!(0.0)),
                        ("grow", serde_json::json!(0.0)),
                        ("smooth", serde_json::json!(0.0)),
                        ("ramp", serde_json::json!(0.0)),
                        ("invert", serde_json::json!(false)),
                        ("antialias", serde_json::json!(true)),
                    ] {
                        n.params.insert(key.to_string(), v);
                    }
                }
                let mut sources = HashMap::new();
                for n in cg.nodes.iter().filter(|n| n.node_type == "heeler.image_source" || n.node_type == "heeler.group") {
                    sources.insert(n.id.clone(), SourceImage { image: source.clone(), version: full_version, measured: false });
                }
                let g = plant_and_build(app, image_id, &cg, &registry, &source, true, &mut sources)?;
                with_session(app, |s| {
                    plant_smart_rasters_at(s, Some(&base), &cg, image_id, &mut sources, MatteTier::Full);
                    Ok(())
                })?;
                if let (true, Some(prev)) = (baked && k > 0, current.as_ref()) {
                    // The answer so far is this stretch's base: planted as
                    // the node's raster, its regions drawn over it.
                    let mut img = ImageBuf::try_new(w, h).map_err(|e| e.to_string())?;
                    for (px, v) in img.data.chunks_mut(4).zip(prev.iter()) {
                        px[0] = *v;
                        px[1] = *v;
                        px[2] = *v;
                        px[3] = 1.0;
                    }
                    let version = fnv1a64(format!("fullmatte-stretch|{want:016x}|{k}").as_bytes());
                    sources.insert(node_id.to_string(), SourceImage { image: Arc::new(img), version, measured: false });
                }
                if rgb.is_none() {
                    let img_v = exec.render(&g, &in_feed, &sources).map_err(|e| e.to_string())?;
                    let img = img_v.as_image().ok_or("the selection's feed is not an image")?;
                    (w, h) = (img.width, img.height);
                    rgb = Some(display_bytes(img));
                }
                let mask_v = exec.render(&g, node_id, &sources).map_err(|e| e.to_string())?;
                match &mask_v {
                    Value::Mask(m) if (m.width, m.height) == (w, h) => m.data.clone(),
                    Value::Mask(m) => heeler_vision::resize_plane(&m.data, m.width, m.height, w, h),
                    Value::Image(mi) => {
                        let plane: Vec<f32> = mi.data.chunks(4).map(|px| px[0]).collect();
                        heeler_vision::resize_plane(&plane, mi.width, mi.height, w, h)
                    }
                }
            } else {
                current.take().expect("checked")
            };
            let rgb_full = rgb.as_ref().expect("rendered with the first stretch");
            let haze = ((heeler_vision::HAZE_REACH as f32) * (w.max(h) as f32 / PREVIEW_EDGE as f32).max(1.0)).round() as usize;
            let label = if parts > 1 { format!(" (part {} of {parts})", k + 1) } else { String::new() };
            let mut progress_fn = |d: usize, t: usize| {
                progress::emit(
                    app,
                    "matte",
                    job,
                    d as u64,
                    t as u64,
                    format!("Refining the matte at full resolution{label}: tile {} of {t}", (d + 1).min(t.max(1))),
                );
            };
            let cancel = || progress::is_cancelled(job);
            let mut fo = heeler_vision::FullOptions {
                tile: heeler_vision::FULL_TILE,
                overlap: heeler_vision::FULL_OVERLAP,
                progress: &mut progress_fn,
                cancel: &cancel,
            };
            if refiner.is_none() {
                refiner = Some(heeler_vision::Refiner::load(&base, &heeler_vision::VITMATTE).map_err(|e| e.to_string())?);
            }
            let refiner = refiner.as_mut().expect("just loaded");
            let mut out = coarse.clone();
            if !st.one_shot {
                let band = stamp_band(&st.strokes, w, h);
                let chase = matte_chase_px(st.reach, band_radius_px(&st.strokes, w, h));
                let margin = chase.ceil() as usize + haze + heeler_vision::FULL_OVERLAP;
                if let Some(r) = region_of(|i| band[i] > 0.5, w, h, margin) {
                    let (alpha, n) = match heeler_vision::refine_brushed_full(
                        refiner,
                        &crop_plane(rgb_full, w, r, 3),
                        &crop_plane(&coarse, w, r, 1),
                        &crop_plane(&band, w, r, 1),
                        r.2,
                        r.3,
                        chase,
                        haze,
                        &mut fo,
                    ) {
                        Ok(a) => a,
                        Err(heeler_vision::VisionError::Canceled) => return Ok(None),
                        Err(e) => return Err(e.to_string()),
                    };
                    tiles_run += n;
                    paste(&mut out, w, r, &alpha);
                }
            } else {
                // The one-shot: its preview answer says where to look.
                let version = *st.versions.last().expect("one landing");
                let bytes = std::fs::read(smart_raster_lookup(&base, version))
                    .map_err(|_| "the preview matte this refines is missing".to_string())?;
                let p = heeler_io::decode_png_raw(&bytes).map_err(|e| e.to_string())?;
                let preview: Vec<f32> = p.data.chunks(4).map(|px| px[0]).collect();
                let small = heeler_vision::area_downsample(&coarse, w, h, p.width, p.height);
                let unknown = guided_unknown(&preview, &small, p.width, p.height, w, h);
                if let Some(r) = region_of(|i| unknown[i], w, h, heeler_vision::FULL_OVERLAP) {
                    let (alpha, n) = match heeler_vision::refine_guided_full(
                        refiner,
                        &crop_plane(rgb_full, w, r, 3),
                        &crop_plane(&coarse, w, r, 1),
                        &crop_plane(&unknown, w, r, 1),
                        r.2,
                        r.3,
                        haze,
                        &mut fo,
                    ) {
                        Ok(a) => a,
                        Err(heeler_vision::VisionError::Canceled) => return Ok(None),
                        Err(e) => return Err(e.to_string()),
                    };
                    tiles_run += n;
                    paste(&mut out, w, r, &alpha);
                }
            }
            // On a baked base the landing's Contrast was applied to the
            // pixels the model answered, once (polish_matte).
            if baked {
                for (a, c) in out.iter_mut().zip(coarse.iter()) {
                    if (*a - *c).abs() > 1e-6 {
                        *a = stretch_alpha(*a, st.contrast);
                    }
                }
            }
            current = Some(out);
        }
        Ok(current.take())
    })();
    drop(refiner);
    drop(exec);
    let Some(alpha) = result? else {
        return Ok(MatteFullAnswer::said("canceled", "The full-resolution matte was canceled; the preview-resolution matte stays"));
    };
    if progress::is_cancelled(job) {
        return Ok(MatteFullAnswer::said("canceled", "The full-resolution matte was canceled; the preview-resolution matte stays"));
    }
    let matte = FullMatte {
        width: w,
        height: h,
        data: alpha.iter().map(|v| (v.clamp(0.0, 1.0) * 255.0).round() as u8).collect(),
    };
    write_full_matte(&base, want, &matte)?;
    let matte = Arc::new(matte);
    with_session(app, |s| {
        remember_full_matte(s, want, matte);
        Ok(())
    })?;
    Ok(MatteFullAnswer {
        status: "done".into(),
        message: String::new(),
        tiles: tiles_run,
        ms: started.elapsed().as_millis() as u64,
        width: w,
        height: h,
    })
}

/// Whether a bake of `node_id` (To Mask, Selection from Mask, a
/// removal's snapshot) renders at the photograph's own size: the node is
/// a selection whose current recipe has a full-resolution twin
/// (2026-09-29: "go with option B for To Mask"). The twin is keyed by
/// the recipe the graph says now, so a twin solved for any other recipe
/// never qualifies.
pub(crate) fn bake_has_twin(base: &Path, graph: &UiGraph, image_id: &str, node_id: &str) -> bool {
    let Some(n) = graph.nodes.iter().find(|n| n.id == node_id) else { return false };
    // A selection with a matte, or a pixel mask with a base (a bake made
    // at the photograph's size keeps its twin too).
    let based = match n.node_type.as_str() {
        "heeler.selection_mask" => n.params.get("matte_id").and_then(|v| v.as_str()).is_some_and(|m| !m.is_empty()),
        "heeler.brush_mask" => wants_planted_raster(n),
        _ => false,
    };
    if !based {
        return false;
    }
    full_matte_path(base, smart_want(image_id, n, depth_recipe(graph), None)).is_file()
}

/// Waits while `running` says a selection's full-resolution pass is
/// still going, polling every `step`. A bake asked for while the pass
/// runs waits for its answer rather than baking the preview's matte and
/// racing the pass: when the pass lands, the twin is there and the bake
/// is made from it; when it is canceled or keeps the preview matte, the
/// bake is the preview's, as before. Answers whether it waited.
pub(crate) fn wait_for_pass(running: impl Fn() -> bool, step: std::time::Duration) -> bool {
    let mut waited = false;
    while running() {
        waited = true;
        std::thread::sleep(step);
    }
    waited
}

/// A kept bake: the version the converted mask points at, the raster
/// the preview plants (and the polish brush reads), and, for a bake made
/// at the photograph's size, the full-size raster kept as that version's
/// twin.
pub(crate) struct Baked {
    pub version: u64,
    pub preview: ImageBuf,
    pub full: Option<FullMatte>,
}

fn gray_raster(plane: &[f32], w: usize, h: usize) -> ImageBuf {
    let mut raster = ImageBuf::new(w, h);
    for (px, v) in raster.data.chunks_mut(4).zip(plane.iter()) {
        let v = v.clamp(0.0, 1.0);
        px[0] = v;
        px[1] = v;
        px[2] = v;
        px[3] = 1.0;
    }
    raster
}

/// Keeps a bake under the retained roof. A preview-size bake is written
/// as it always was. A full-size bake (from a selection with a twin) is
/// kept as the new version's twin, a byte a pixel like every twin, and
/// its preview raster is the area average of those same bytes at the
/// preview's size: exactly what planting the twin for a preview makes,
/// so Fit and 1:1 show one mask, and the polish brush, which reads the
/// preview raster, works on the same mask.
pub(crate) fn store_bake(base: &Path, plane: &[f32], w: usize, h: usize, content_key: u64, full: bool) -> Result<Baked, String> {
    // Keyed by the render's own content key: baking the same state
    // twice lands on the same file. A full-size bake is another raster.
    let version = if full {
        fnv1a64(format!("bake|full|{content_key}").as_bytes())
    } else {
        fnv1a64(format!("bake|{content_key}").as_bytes())
    };
    let (preview, twin) = if full {
        let twin = FullMatte {
            width: w,
            height: h,
            data: plane.iter().map(|v| (v.clamp(0.0, 1.0) * 255.0).round() as u8).collect(),
        };
        let (pw, ph) = preview_dims(w, h, PREVIEW_EDGE);
        let bytes: Vec<f32> = twin.data.iter().map(|v| *v as f32 / 255.0).collect();
        let small = if (pw, ph) == (w, h) { bytes } else { heeler_vision::area_downsample(&bytes, w, h, pw, ph) };
        (gray_raster(&small, pw, ph), Some(twin))
    } else {
        (gray_raster(plane, w, h), None)
    };
    // Under the retained roof, not the cache: the node keeps only the
    // pointer to this file, and the strokes it came from are zeroed at
    // the bake. The twin first, so a preview raster on disk always has
    // its twin beside it.
    if let Some(t) = &twin {
        write_full_matte(base, version, t)?;
    }
    if let Ok(bytes) = heeler_io::encode_png_raw(&preview) {
        let path = retained_raster_path(base, version);
        if let Some(dir) = path.parent() {
            std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
        }
        std::fs::write(&path, bytes).map_err(|e| e.to_string())?;
    }
    Ok(Baked { version, preview, full: twin })
}

fn paste(out: &mut [f32], w: usize, r: (usize, usize, usize, usize), alpha: &[f32]) {
    let (x0, y0, rw, rh) = r;
    for y in 0..rh {
        out[(y0 + y) * w + x0..(y0 + y) * w + x0 + rw].copy_from_slice(&alpha[y * rw..(y + 1) * rw]);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sel(id: &str, strokes: &str, matte_id: &str) -> UiNode {
        UiNode {
            id: id.into(),
            node_type: "heeler.selection_mask".into(),
            enabled: true,
            params: HashMap::from([
                ("regions".to_string(), serde_json::json!("[]")),
                ("strokes".to_string(), serde_json::json!(strokes)),
                ("matte_id".to_string(), serde_json::json!(matte_id)),
            ]),
        }
    }

    const STROKE: &str = r#"[{"points":[[0.2,0.2],[0.6,0.3]],"radius":0.05,"mode":"matte"}]"#;

    /// A twin whose bytes say where each pixel is, so any misplacement
    /// or stretch shows as a wrong value.
    fn coded(w: usize, h: usize) -> FullMatte {
        FullMatte { width: w, height: h, data: (0..w * h).map(|i| ((i % w) * 7 + (i / w) * 13) as u8).collect() }
    }

    #[test]
    fn the_tier_decides_the_size_a_twin_is_planted_at() {
        let (w, h) = (4000usize, 6000usize);
        assert_eq!(plant_dims(MatteTier::Full, None, w, h), (w, h), "an export plants the photograph's size");
        assert_eq!(plant_dims(MatteTier::Auto, None, w, h), (w, h));
        assert_eq!(plant_dims(MatteTier::Auto, Some((w, h)), w, h), (w, h), "the 1:1 slice and the settle plant it whole");
        assert_eq!(plant_dims(MatteTier::Auto, Some((1365, 2048)), w, h), (1365, 2048), "the preview plants its own size");
        assert_eq!(plant_dims(MatteTier::Preview, None, w, h), (1365, 2048), "a thumbnail plants the preview's");
        assert_eq!(plant_dims(MatteTier::Auto, Some((500, 500)), w, h), (1365, 2048), "a frame of another shape gets the preview's");
    }

    #[test]
    fn a_twin_survives_a_reload_and_plants_pixel_for_pixel() {
        let dir = tempfile::tempdir().unwrap();
        let (w, h) = (300usize, 450usize);
        let want = 0x1234u64;
        write_full_matte(dir.path(), want, &coded(w, h)).unwrap();
        assert!(
            full_matte_path(dir.path(), want).starts_with(retained_raster_dir(dir.path())),
            "kept where the Storage clear never looks"
        );
        // A fresh session: the twin comes back from disk.
        let mut session = Session::default();
        let mut sources = HashMap::new();
        assert!(plant_full_matte(&mut session, Some(dir.path()), "sel", want, MatteTier::Auto, Some((w, h)), &mut sources));
        let planted = sources["sel"].image.clone();
        assert_eq!((planted.width, planted.height), (w, h), "portrait stays portrait");
        let code = coded(w, h);
        for (i, px) in planted.data.chunks(4).enumerate() {
            assert_eq!((px[0] * 255.0).round() as u8, code.data[i], "pixel {i} moved");
        }
        // At the preview's size: the area average, under its own version.
        let full_version = sources["sel"].version;
        let mut small = HashMap::new();
        assert!(plant_full_matte(&mut session, Some(dir.path()), "sel", want, MatteTier::Auto, Some((100, 150)), &mut small));
        assert_eq!((small["sel"].image.width, small["sel"].image.height), (100, 150));
        assert_ne!(small["sel"].version, full_version, "two sizes are two rasters to the executor");
        // No twin for another recipe.
        let mut none = HashMap::new();
        assert!(!plant_full_matte(&mut session, Some(dir.path()), "sel", 0x9999, MatteTier::Auto, Some((w, h)), &mut none));
        assert!(none.is_empty());
    }

    /// The twin is keyed by the preview raster's recipe, so every road
    /// back to that recipe (undo, redo, a take, a paste onto the same
    /// photograph) finds it, and any other recipe (a new stroke, the
    /// undo of the stroke) plants what it planted before.
    #[test]
    fn the_twin_follows_the_recipe_through_undo_and_redo() {
        let dir = tempfile::tempdir().unwrap();
        let graph = |n: UiNode| UiGraph { graph_id: "t".into(), nodes: vec![n], connections: vec![] };
        let applied = sel("sel", STROKE, "x");
        let want = smart_want("img", &applied, DepthRecipe::default(), None);
        write_full_matte(dir.path(), want, &coded(64, 96)).unwrap();
        let mut session = Session::default();
        let mut sources = HashMap::new();
        plant_smart_rasters_at(&mut session, Some(dir.path()), &graph(applied.clone()), "img", &mut sources, MatteTier::Full);
        assert_eq!((sources["sel"].image.width, sources["sel"].image.height), (64, 96), "the applied recipe plants its twin");
        // Undo: the stroke comes off. The recipe moves and the twin with it.
        let before = sel("sel", "[]", "x");
        let before_want = smart_want("img", &before, DepthRecipe::default(), None);
        session.smart_rasters.insert("img|sel".into(), (Arc::new(ImageBuf::new(8, 12)), before_want));
        let mut undone = HashMap::new();
        plant_smart_rasters_at(&mut session, Some(dir.path()), &graph(before), "img", &mut undone, MatteTier::Full);
        assert_eq!((undone["sel"].image.width, undone["sel"].image.height), (8, 12), "the earlier recipe plants its own raster");
        // Redo: back to the applied recipe, and its twin.
        let mut redone = HashMap::new();
        plant_smart_rasters_at(&mut session, Some(dir.path()), &graph(applied), "img", &mut redone, MatteTier::Full);
        assert_eq!(redone["sel"].version, sources["sel"].version);
    }

    /// The photograph's geometry, crop and rotation included, carries
    /// the twin exactly as it carries the photograph: a twin whose bytes
    /// are the photograph's own values comes out of the planting and its
    /// conform identical to the photograph cut the same way.
    #[test]
    fn the_twin_lines_up_with_the_photograph_through_crop_and_rotation() {
        let dir = tempfile::tempdir().unwrap();
        let (w, h) = (240usize, 360usize);
        let twin = coded(w, h);
        let mut photo = ImageBuf::new(w, h);
        for (px, v) in photo.data.chunks_mut(4).zip(twin.data.iter()) {
            let v = *v as f32 / 255.0;
            px.copy_from_slice(&[v, v, v, 1.0]);
        }
        let photo = Arc::new(photo);
        for (angle, crop) in [(0.0f64, [0.1f64, 0.2, 0.5, 0.45]), (7.0, [0.05, 0.1, 0.8, 0.7])] {
            let applied = sel("sel", STROKE, "x");
            let want = smart_want("img", &applied, DepthRecipe::default(), None);
            write_full_matte(dir.path(), want, &twin).unwrap();
            let crop_node = UiNode {
                id: "crop".into(),
                node_type: "heeler.crop_rotate".into(),
                enabled: true,
                params: HashMap::from([
                    ("angle".to_string(), serde_json::json!(angle)),
                    ("crop_x".to_string(), serde_json::json!(crop[0])),
                    ("crop_y".to_string(), serde_json::json!(crop[1])),
                    ("crop_w".to_string(), serde_json::json!(crop[2])),
                    ("crop_h".to_string(), serde_json::json!(crop[3])),
                ]),
            };
            let src = UiNode { id: "src".into(), node_type: "heeler.image_source".into(), enabled: true, params: HashMap::new() };
            let graph = UiGraph {
                graph_id: "t".into(),
                nodes: vec![src, crop_node, applied],
                connections: vec![
                    UiConnection { from: ("src".into(), "out".into()), to: ("crop".into(), "in".into()) },
                    UiConnection { from: ("crop".into(), "out".into()), to: ("sel".into(), "in".into()) },
                ],
            };
            let mut session = Session::default();
            let mut sources = HashMap::from([("src".to_string(), SourceImage { image: photo.clone(), version: 1, measured: false })]);
            plant_smart_rasters(&mut session, Some(dir.path()), &graph, "img", &mut sources);
            let planted = sources["sel"].image.clone();
            let c = crop.map(|v| v as f32);
            let cut = if angle == 0.0 {
                heeler_engine::crop_raster_to_frame(&photo, w, h, c)
            } else {
                heeler_engine::crop_rotate_buf(&photo, angle as f32, 0.0, c)
            };
            assert_eq!((planted.width, planted.height), (cut.width, cut.height), "angle {angle}");
            for (i, (a, b)) in planted.data.chunks(4).zip(cut.data.chunks(4)).enumerate() {
                assert!((a[0] - b[0]).abs() < 1e-6, "angle {angle}: pixel {i} is {} against the photograph's {}", a[0], b[0]);
            }
        }
    }

    /// Photo > Flip (2026-10-01: "In [the RAW editor], the edits flip with the
    /// photo."): a Smart selection's twin is made on the photograph as it is,
    /// and the crop's flip carries it as it carries the photograph, so the
    /// selection stays on its subject, mirrored.
    #[test]
    fn the_twin_flips_with_the_photograph() {
        let dir = tempfile::tempdir().unwrap();
        let (w, h) = (240usize, 360usize);
        let twin = coded(w, h);
        let mut photo = ImageBuf::new(w, h);
        for (px, v) in photo.data.chunks_mut(4).zip(twin.data.iter()) {
            let v = *v as f32 / 255.0;
            px.copy_from_slice(&[v, v, v, 1.0]);
        }
        let photo = Arc::new(photo);
        for (angle, flip_h, flip_v) in [(0.0f64, 1.0f64, 0.0f64), (7.0, 0.0, 1.0), (-4.0, 1.0, 1.0)] {
            let crop = [0.1f64, 0.2, 0.5, 0.45];
            let applied = sel("sel", STROKE, "x");
            let want = smart_want("img", &applied, DepthRecipe::default(), None);
            write_full_matte(dir.path(), want, &twin).unwrap();
            let crop_node = UiNode {
                id: "crop".into(),
                node_type: "heeler.crop_rotate".into(),
                enabled: true,
                params: HashMap::from([
                    ("angle".to_string(), serde_json::json!(angle)),
                    ("crop_x".to_string(), serde_json::json!(crop[0])),
                    ("crop_y".to_string(), serde_json::json!(crop[1])),
                    ("crop_w".to_string(), serde_json::json!(crop[2])),
                    ("crop_h".to_string(), serde_json::json!(crop[3])),
                    ("flip_h".to_string(), serde_json::json!(flip_h)),
                    ("flip_v".to_string(), serde_json::json!(flip_v)),
                ]),
            };
            let src = UiNode { id: "src".into(), node_type: "heeler.image_source".into(), enabled: true, params: HashMap::new() };
            let graph = UiGraph {
                graph_id: "t".into(),
                nodes: vec![src, crop_node, applied],
                connections: vec![
                    UiConnection { from: ("src".into(), "out".into()), to: ("crop".into(), "in".into()) },
                    UiConnection { from: ("crop".into(), "out".into()), to: ("sel".into(), "in".into()) },
                ],
            };
            let mut session = Session::default();
            let mut sources = HashMap::from([("src".to_string(), SourceImage { image: photo.clone(), version: 1, measured: false })]);
            plant_smart_rasters(&mut session, Some(dir.path()), &graph, "img", &mut sources);
            let planted = sources["sel"].image.clone();
            let flipped = heeler_engine::mirror_buf(&photo, flip_h > 0.5, flip_v > 0.5);
            let c = crop.map(|v| v as f32);
            let cut = if angle == 0.0 {
                heeler_engine::crop_raster_to_frame(&flipped, w, h, c)
            } else {
                heeler_engine::crop_rotate_buf(&flipped, angle as f32, 0.0, c)
            };
            assert_eq!((planted.width, planted.height), (cut.width, cut.height), "angle {angle}");
            for (i, (a, b)) in planted.data.chunks(4).zip(cut.data.chunks(4)).enumerate() {
                assert!((a[0] - b[0]).abs() < 1e-6, "angle {angle}: pixel {i} is {} against the flipped photograph's {}", a[0], b[0]);
            }
        }
    }

    #[test]
    fn a_baked_chain_is_replayed_from_its_first_landing() {
        let dir = tempfile::tempdir().unwrap();
        let step = |parent: u64, strokes: &str, regions: &str| MatteStep {
            parent: format!("{parent:016x}"),
            regions: regions.into(),
            strokes: strokes.into(),
            reach: 50,
            contrast: 25,
        };
        // Subject (0xa), landing 0xb, landing 0xc (regions drawn), 0xd.
        record_matte_step(dir.path(), 0xb, &step(0xa, STROKE, "[]")).unwrap();
        record_matte_step(dir.path(), 0xc, &step(0xb, STROKE, "[{\"kind\":\"path\"}]")).unwrap();
        record_matte_step(dir.path(), 0xd, &step(0xc, STROKE, "[]")).unwrap();
        let (root, steps) = baked_chain(dir.path(), 0xd).unwrap();
        assert_eq!(root, 0xa, "the replay starts from the Subject selection");
        assert_eq!(steps.iter().map(|(v, _)| *v).collect::<Vec<_>>(), vec![0xb, 0xc, 0xd]);
        let stretches = stretches_of(&steps).unwrap();
        assert_eq!(stretches.len(), 2, "a landing that consumed regions starts a new stretch");
        assert_eq!(stretches[0].versions, vec![0xb]);
        assert_eq!(stretches[1].versions, vec![0xc, 0xd], "brush landings after it share one pass");
        assert_eq!(stretches[1].strokes.len(), 2);
        // An earlier Apply solved 0xb at full resolution: the replay
        // starts there instead of at the Subject selection.
        write_full_matte(dir.path(), 0xb, &coded(4, 4)).unwrap();
        let (root, steps) = baked_chain(dir.path(), 0xd).unwrap();
        assert_eq!(root, 0xb);
        assert_eq!(steps.len(), 2);
        // A base with no landing on it has nothing to replay.
        assert!(baked_chain(dir.path(), 0xa).is_none());
    }

    #[test]
    fn the_preview_and_the_apply_stamp_the_same_band() {
        let strokes = matte_strokes_of(STROKE).unwrap();
        let (sw, sh) = (205usize, 136usize);
        let (fw, fh) = (2050usize, 1360usize);
        let small = stamp_band(&strokes, sw, sh);
        let full = stamp_band(&strokes, fw, fh);
        let down = heeler_vision::area_downsample(&full, fw, fh, sw, sh);
        // They agree everywhere but along the capsule's rim, where a
        // pixel's center falls on one side at one size and the other side
        // at the other: no disagreement lies more than a pixel inside it.
        let on = |x: i64, y: i64| x >= 0 && y >= 0 && (x as usize) < sw && (y as usize) < sh && small[y as usize * sw + x as usize] > 0.5;
        for y in 0..sh as i64 {
            for x in 0..sw as i64 {
                let i = y as usize * sw + x as usize;
                if ((small[i] > 0.5) != (down[i] > 0.5)) && (-1..=1).all(|d| on(x + d, y) == on(x, y) && on(x, y + d) == on(x, y)) {
                    panic!("({x},{y}) disagrees inside the band");
                }
            }
        }
        assert!((band_radius_px(&strokes, fw, fh) - 10.0 * band_radius_px(&strokes, sw, sh)).abs() < 1e-3);
        // Engine-applied modes are not the band.
        assert!(matte_strokes_of(r#"[{"points":[[0.1,0.1]],"radius":0.1,"mode":"feather"}]"#).unwrap().is_empty());
    }

    /// The owner's lemur, measured (ignored; HEELER_FULLRES_PROBE is
    /// "photo|coarse png|out dir", HEELER_VISION_MODELS the model store,
    /// read in place). The brush as the app runs it on the preview, then
    /// Apply's pass over the full-resolution photograph with the same
    /// stroke, then the Refine edge button both ways; times, tiles and a 1:1
    /// crop of each answer written out. HEELER_FULLRES_SKIP=1 stops before
    /// the full-resolution passes, for a memory baseline.
    #[test]
    #[ignore]
    fn fullres_probe_on_a_real_photograph() {
        let Ok(spec) = std::env::var("HEELER_FULLRES_PROBE") else { return };
        let parts: Vec<&str> = spec.split('|').collect();
        let (photo, coarse_png, out) = (Path::new(parts[0]), Path::new(parts[1]), Path::new(parts[2]));
        let base = PathBuf::from(std::env::var("HEELER_VISION_MODELS").expect("HEELER_VISION_MODELS"));
        std::fs::create_dir_all(out).unwrap();
        let opts = heeler_io::RawSourceOpts::default();
        let t = std::time::Instant::now();
        let full = heeler_io::decode_any_with(photo, opts).unwrap();
        eprintln!("full decode {}x{} in {} ms", full.width, full.height, t.elapsed().as_millis());
        let preview = downscale(&heeler_io::decode_preview_at(photo, opts, 2048).unwrap(), 2048);
        let (w, h) = (full.width, full.height);
        let (pw, ph) = (preview.width, preview.height);
        let rgb_full = display_bytes(&full);
        drop(full);
        let prgb: Vec<f32> = display_bytes(&preview).iter().map(|v| *v as f32).collect();
        let cimg = heeler_io::decode_png_raw(&std::fs::read(coarse_png).unwrap()).unwrap();
        let plane: Vec<f32> = cimg.data.chunks(4).map(|p| p[0]).collect();
        let coarse_p = heeler_vision::resize_plane(&plane, cimg.width, cimg.height, pw, ph);
        // What the engine hands a baked base at full resolution.
        let coarse_f = heeler_vision::resize_plane(&plane, cimg.width, cimg.height, w, h);
        // A ring of matte strokes along the whole selection edge, 2
        // percent of the short side in radius, as the earlier probe
        // painted it; carried to full resolution by nearest neighbor so
        // both passes read the same stroke.
        let r = 0.02 * pw.min(ph) as f32;
        let ri = r.ceil() as i64;
        let mut band_p = vec![0.0f32; pw * ph];
        let on = |x: usize, y: usize| coarse_p[y * pw + x] >= 0.5;
        for y in 0..ph {
            for x in 0..pw {
                let c = on(x, y);
                if !((x + 1 < pw && on(x + 1, y) != c) || (y + 1 < ph && on(x, y + 1) != c)) {
                    continue;
                }
                for dy in -ri..=ri {
                    for dx in -ri..=ri {
                        let (px, py) = (x as i64 + dx, y as i64 + dy);
                        if (dx * dx + dy * dy) as f32 <= r * r && px >= 0 && py >= 0 && px < pw as i64 && py < ph as i64 {
                            band_p[py as usize * pw + px as usize] = 1.0;
                        }
                    }
                }
            }
        }
        let mut band_f = vec![0.0f32; w * h];
        for y in 0..h {
            let sy = (((y as f64 + 0.5) * ph as f64 / h as f64) as usize).min(ph - 1);
            for x in 0..w {
                let sx = (((x as f64 + 0.5) * pw as f64 / w as f64) as usize).min(pw - 1);
                band_f[y * w + x] = band_p[sy * pw + sx];
            }
        }
        let mut refiner = heeler_vision::Refiner::load(&base, &heeler_vision::VITMATTE).unwrap();
        let t = std::time::Instant::now();
        let prev = heeler_vision::refine_selection_brushed(&mut refiner, &prgb, &coarse_p, &band_p, pw, ph, matte_chase_px(50, r), POLISH_MATTE_SIDE).unwrap();
        eprintln!("preview brush pass: {} ms at {pw}x{ph}", t.elapsed().as_millis());
        let before = heeler_vision::resize_plane(&prev, pw, ph, w, h);
        if std::env::var("HEELER_FULLRES_SKIP").is_ok() {
            eprintln!("stopping before the full-resolution pass (memory baseline)");
            return;
        }
        // Apply's pass loads its own session and drops it after, so its
        // arena never outlives it.
        drop(refiner);
        let mut refiner = heeler_vision::Refiner::load(&base, &heeler_vision::VITMATTE).unwrap();
        let scale = w.max(h) as f32 / pw.max(ph) as f32;
        let haze = (heeler_vision::HAZE_REACH as f32 * scale).round() as usize;
        let chase_f = matte_chase_px(50, r * scale);
        let t = std::time::Instant::now();
        let margin = chase_f.ceil() as usize + haze + heeler_vision::FULL_OVERLAP;
        let roi = region_of(|i| band_f[i] > 0.5, w, h, margin).unwrap();
        let mut report = |d: usize, n: usize| eprint!("\r  tile {d} of {n}   ");
        let never = || false;
        let tile: usize = std::env::var("HEELER_FULLRES_TILE").ok().and_then(|v| v.parse().ok()).unwrap_or(heeler_vision::FULL_TILE);
        let overlap = heeler_vision::FULL_OVERLAP * tile / heeler_vision::FULL_TILE;
        let mut fo = heeler_vision::FullOptions { tile, overlap, progress: &mut report, cancel: &never };
        let (alpha, tiles) = heeler_vision::refine_brushed_full(
            &mut refiner,
            &crop_plane(&rgb_full, w, roi, 3),
            &crop_plane(&coarse_f, w, roi, 1),
            &crop_plane(&band_f, w, roi, 1),
            roi.2,
            roi.3,
            chase_f,
            haze,
            &mut fo,
        )
        .unwrap();
        let mut after = coarse_f.clone();
        paste(&mut after, w, roi, &alpha);
        let ms = t.elapsed().as_millis();
        eprintln!("\nApply, full-resolution brush pass: {ms} ms, {tiles} tiles ({:.0} ms a tile), working region {}x{} of {w}x{h}", ms as f64 / tiles.max(1) as f64, roi.2, roi.3);
        // The edge's softness under the stroke, both ways, at 1:1.
        let soft = |a: &[f32]| a.iter().zip(band_f.iter()).filter(|(v, b)| **b > 0.5 && **v > 0.05 && **v < 0.95).count();
        let edge_len = band_f.iter().filter(|b| **b > 0.5).count() as f64 / (2.0 * r as f64 * scale as f64);
        eprintln!(
            "soft (0.05..0.95) pixels under the stroke per pixel of edge: before {:.1}, after {:.1}",
            soft(&before) as f64 / edge_len,
            soft(&after) as f64 / edge_len
        );
        // 1:1 crops at the top of the head and down the back, where the
        // fur stands off the wall: photograph, then the matte before
        // (the preview's, stretched) and after (Apply's), then each as
        // Heeler's red overlay.
        let top = (0..w * h).find(|i| coarse_f[*i] >= 0.5).unwrap();
        let (tx, ty) = (top % w, top / w);
        for (name, cx, cy) in [("head", tx, ty + 60), ("side", roi.0 + roi.2 * 3 / 4, ty + roi.3 / 3)] {
            let (cw, ch) = (480usize, 360usize);
            let x0 = cx.saturating_sub(cw / 2).min(w - cw);
            let y0 = cy.saturating_sub(ch / 2).min(h - ch);
            let mut img = ImageBuf::new(cw * 3 + 16, ch * 2 + 8);
            for y in 0..ch {
                for x in 0..cw {
                    let i = (y0 + y) * w + x0 + x;
                    let photo = [rgb_full[i * 3] as f32 / 255.0, rgb_full[i * 3 + 1] as f32 / 255.0, rgb_full[i * 3 + 2] as f32 / 255.0];
                    let put = |img: &mut ImageBuf, px: usize, py: usize, c: [f32; 3]| {
                        let o = (py * img.width + px) * 4;
                        img.data[o..o + 4].copy_from_slice(&[c[0], c[1], c[2], 1.0]);
                    };
                    put(&mut img, x, y, photo);
                    put(&mut img, cw + 8 + x, y, [before[i]; 3]);
                    put(&mut img, 2 * cw + 16 + x, y, [after[i]; 3]);
                    let tint = |a: f32| {
                        let k = 0.5 * (1.0 - a);
                        [photo[0] * (1.0 - k) + 0.84 * k, photo[1] * (1.0 - k) + 0.25 * k, photo[2] * (1.0 - k) + 0.25 * k]
                    };
                    put(&mut img, cw + 8 + x, ch + 8 + y, tint(before[i]));
                    put(&mut img, 2 * cw + 16 + x, ch + 8 + y, tint(after[i]));
                    put(&mut img, x, ch + 8 + y, photo);
                }
            }
            std::fs::write(out.join(format!("lemur_{name}_1to1_photo_before_after.png")), heeler_io::encode_png_raw(&img).unwrap()).unwrap();
            eprintln!("crop {name}: {cw}x{ch} at ({x0},{y0})");
        }
        // The Refine edge button (no strokes): the one-shot on the
        // preview, then Apply's guided pass.
        let t = std::time::Instant::now();
        let one = heeler_vision::refine_selection(&mut refiner, &prgb, &coarse_p, pw, ph).unwrap();
        eprintln!("preview one-shot: {} ms", t.elapsed().as_millis());
        let t = std::time::Instant::now();
        let small = heeler_vision::area_downsample(&coarse_f, w, h, pw, ph);
        let unknown = guided_unknown(&one, &small, pw, ph, w, h);
        let roi = region_of(|i| unknown[i], w, h, heeler_vision::FULL_OVERLAP).unwrap();
        let mut report = |d: usize, n: usize| eprint!("\r  tile {d} of {n}   ");
        let mut fo = heeler_vision::FullOptions { tile, overlap, progress: &mut report, cancel: &never };
        let (_, tiles) = heeler_vision::refine_guided_full(
            &mut refiner,
            &crop_plane(&rgb_full, w, roi, 3),
            &crop_plane(&coarse_f, w, roi, 1),
            &crop_plane(&unknown, w, roi, 1),
            roi.2,
            roi.3,
            haze,
            &mut fo,
        )
        .unwrap();
        let ms = t.elapsed().as_millis();
        eprintln!("\nApply, full-resolution one-shot pass: {ms} ms, {tiles} tiles, working region {}x{}", roi.2, roi.3);
    }

    // ---- To Mask at the photograph's size (2026-09-29: "go with
    // option B for To Mask") ----

    /// A photograph-size source and a graph: the source feeding a
    /// selection whose base is baked `base_hex`.
    fn converted_graph(matte_id: &str, strokes: &str) -> UiGraph {
        let src = UiNode { id: "src".into(), node_type: "heeler.image_source".into(), enabled: true, params: HashMap::new() };
        UiGraph {
            graph_id: "t".into(),
            nodes: vec![src, sel("sel", strokes, matte_id)],
            connections: vec![UiConnection { from: ("src".into(), "out".into()), to: ("sel".into(), "in".into()) }],
        }
    }

    fn gray_source(w: usize, h: usize) -> Arc<ImageBuf> {
        let mut img = ImageBuf::new(w, h);
        for px in img.data.chunks_mut(4) {
            px.copy_from_slice(&[0.18, 0.18, 0.18, 1.0]);
        }
        Arc::new(img)
    }

    /// What bake_mask_raster does between its source and its store:
    /// plant at the tier, render the node, answer the plane and the
    /// render's content key.
    fn bake_render(
        session: &mut Session,
        base: &Path,
        graph: &UiGraph,
        source: Arc<ImageBuf>,
        tier: MatteTier,
    ) -> (Vec<f32>, usize, usize, u64) {
        let registry = Registry::builtin();
        let mut sources = HashMap::from([("src".to_string(), SourceImage { image: source, version: 7, measured: false })]);
        plant_smart_rasters_at(session, Some(base), graph, "img", &mut sources, tier);
        let g = build_graph(graph, &registry).unwrap();
        let mut exec = Executor::new();
        let value = exec.render(&g, "sel", &sources).unwrap();
        let key = Executor::key_of(&g, "sel", &sources).unwrap_or(0);
        match value {
            Value::Mask(m) => (m.data.clone(), m.width, m.height, key),
            Value::Image(mi) => (mi.data.chunks(4).map(|px| px[0]).collect(), mi.width, mi.height, key),
        }
    }

    /// A twin with a hard, wavy edge and a soft band: values a stretch
    /// or a misplacement would change.
    fn edged(w: usize, h: usize) -> FullMatte {
        let data = (0..w * h)
            .map(|i| {
                let (x, y) = ((i % w) as f32, (i / w) as f32);
                let edge = w as f32 * 0.5 + 9.0 * (y * 0.37).sin();
                ((edge - x) * 40.0 + 128.0).clamp(0.0, 255.0) as u8
            })
            .collect();
        FullMatte { width: w, height: h, data }
    }

    #[test]
    fn to_mask_with_a_twin_stores_the_twin_at_the_photographs_size() {
        let dir = tempfile::tempdir().unwrap();
        // A portrait longer than the preview's edge, so the preview copy
        // is a real reduction.
        let (w, h) = (1200usize, 2600usize);
        let twin = edged(w, h);
        write_full_matte(dir.path(), 0xabc, &twin).unwrap();
        let graph = converted_graph("baked:0000000000000abc", "[]");
        assert!(bake_has_twin(dir.path(), &graph, "img", "sel"), "the selection's recipe has a twin");
        let mut session = Session::default();
        let (plane, pw, ph, key) = bake_render(&mut session, dir.path(), &graph, gray_source(w, h), MatteTier::Full);
        assert_eq!((pw, ph), (w, h), "rendered at the photograph's size");
        let baked = store_bake(dir.path(), &plane, pw, ph, key, true).unwrap();
        // The full-size raster is the twin, byte for byte, kept as the
        // new version's twin (the converted mask's own).
        let kept = read_full_matte(dir.path(), baked.version).expect("the bake's twin is on disk");
        assert_eq!((kept.width, kept.height), (w, h));
        let differ = kept.data.iter().zip(twin.data.iter()).filter(|(a, b)| a != b).count();
        assert_eq!(differ, 0, "the converted mask is the twin, not a stretched preview");
        // The preview raster is at the preview's size, and it is exactly
        // what planting the twin makes for a preview: Fit and 1:1 agree.
        assert_eq!((baked.preview.width, baked.preview.height), (945, 2048));
        let mut fresh = Session::default();
        let mut small = HashMap::new();
        assert!(plant_full_matte(&mut fresh, Some(dir.path()), "sel", baked.version, MatteTier::Auto, Some((945, 2048)), &mut small));
        for (a, b) in small["sel"].image.data.chunks(4).zip(baked.preview.data.chunks(4)) {
            assert!((a[0] - b[0]).abs() < 1e-6);
        }
        let on_disk = heeler_io::decode_png_raw(&std::fs::read(retained_raster_path(dir.path(), baked.version)).unwrap()).unwrap();
        assert_eq!((on_disk.width, on_disk.height), (945, 2048), "the preview raster is kept beside the twin");
    }

    #[test]
    fn to_mask_without_a_twin_bakes_at_the_preview_size_as_before() {
        let dir = tempfile::tempdir().unwrap();
        let (pw, ph) = (400usize, 600usize);
        // A preview raster for the base, and no twin.
        let mut base = ImageBuf::new(pw, ph);
        for (i, px) in base.data.chunks_mut(4).enumerate() {
            let v = if i % pw < pw / 2 { 1.0 } else { 0.0 };
            px.copy_from_slice(&[v, v, v, 1.0]);
        }
        std::fs::create_dir_all(retained_raster_dir(dir.path())).unwrap();
        std::fs::write(retained_raster_path(dir.path(), 0xdef), heeler_io::encode_png_raw(&base).unwrap()).unwrap();
        let graph = converted_graph("baked:0000000000000def", "[]");
        assert!(!bake_has_twin(dir.path(), &graph, "img", "sel"));
        // Nor does a smart mask, or a selection with no matte, ever bake full.
        let mut smart = graph.clone();
        smart.nodes[1].node_type = "heeler.smart_mask".into();
        assert!(!bake_has_twin(dir.path(), &smart, "img", "sel"));
        let mut session = Session::default();
        let (plane, w, h, key) = bake_render(&mut session, dir.path(), &graph, gray_source(pw, ph), MatteTier::Auto);
        assert_eq!((w, h), (pw, ph));
        let baked = store_bake(dir.path(), &plane, w, h, key, false).unwrap();
        assert!(baked.full.is_none());
        assert!(!full_matte_path(dir.path(), baked.version).exists(), "no twin is made up");
        assert_eq!((baked.preview.width, baked.preview.height), (pw, ph));
    }

    /// To Mask pressed while Apply's pass runs: the bake waits, and
    /// takes the twin the pass lands for this recipe. A pass that lands
    /// for another recipe (an edit since) leaves the bake at the
    /// preview's, never a mismatched twin.
    #[test]
    fn to_mask_waits_for_a_running_pass_and_bakes_from_what_it_lands() {
        let dir = tempfile::tempdir().unwrap();
        let graph = converted_graph("baked:0000000000000abc", "[]");
        let running = Arc::new(Mutex::new(true));
        let (flag, path) = (running.clone(), dir.path().to_path_buf());
        let pass = std::thread::spawn(move || {
            std::thread::sleep(std::time::Duration::from_millis(150));
            write_full_matte(&path, 0xabc, &edged(64, 96)).unwrap();
            *flag.lock().unwrap() = false;
        });
        assert!(!bake_has_twin(dir.path(), &graph, "img", "sel"), "no twin while the pass runs");
        let waited = wait_for_pass(|| *running.lock().unwrap(), std::time::Duration::from_millis(10));
        pass.join().unwrap();
        assert!(waited, "the bake waited for the pass");
        assert!(bake_has_twin(dir.path(), &graph, "img", "sel"), "and bakes from the twin it landed");
        // Another recipe's pass: the twin is not this selection's.
        let running = Arc::new(Mutex::new(true));
        let (flag, path) = (running.clone(), dir.path().to_path_buf());
        let pass = std::thread::spawn(move || {
            std::thread::sleep(std::time::Duration::from_millis(50));
            write_full_matte(&path, 0x1234, &edged(64, 96)).unwrap();
            *flag.lock().unwrap() = false;
        });
        let edited = converted_graph("baked:0000000000000777", "[]");
        wait_for_pass(|| *running.lock().unwrap(), std::time::Duration::from_millis(10));
        pass.join().unwrap();
        assert!(!bake_has_twin(dir.path(), &edited, "img", "sel"), "a twin for another recipe never qualifies");
        // Nothing running: no wait at all.
        assert!(!wait_for_pass(|| false, std::time::Duration::from_millis(10)));
    }

    /// The converted mask after a save and a reload (a fresh session
    /// reading the retained folder) and through undo and redo: the
    /// full-size raster plants for 1:1 and export, its area average for
    /// the preview, and the recipe before the conversion plants neither.
    #[test]
    fn a_full_size_conversion_survives_reload_undo_and_redo() {
        let dir = tempfile::tempdir().unwrap();
        let (w, h) = (300usize, 450usize);
        let twin = edged(w, h);
        write_full_matte(dir.path(), 0xabc, &twin).unwrap();
        let before = converted_graph("baked:0000000000000abc", "[]");
        let mut session = Session::default();
        let (plane, pw, ph, key) = bake_render(&mut session, dir.path(), &before, gray_source(w, h), MatteTier::Full);
        let baked = store_bake(dir.path(), &plane, pw, ph, key, true).unwrap();
        let after = converted_graph(&format!("baked:{:016x}", baked.version), "[]");
        // Reload: nothing in memory.
        let mut reloaded = Session::default();
        let mut full = HashMap::from([("src".to_string(), SourceImage { image: gray_source(w, h), version: 7, measured: false })]);
        plant_smart_rasters_at(&mut reloaded, Some(dir.path()), &after, "img", &mut full, MatteTier::Full);
        let planted = full["sel"].image.clone();
        assert_eq!((planted.width, planted.height), (w, h));
        for (i, px) in planted.data.chunks(4).enumerate() {
            assert_eq!((px[0] * 255.0).round() as u8, twin.data[i], "pixel {i}");
        }
        // Undo: the selection before the conversion plants its own base's
        // twin, not the conversion's.
        let mut undone = HashMap::from([("src".to_string(), SourceImage { image: gray_source(w, h), version: 7, measured: false })]);
        plant_smart_rasters_at(&mut reloaded, Some(dir.path()), &before, "img", &mut undone, MatteTier::Full);
        assert_ne!(undone["sel"].version, full["sel"].version);
        // Redo: the conversion's raster again, the same version.
        let mut redone = HashMap::from([("src".to_string(), SourceImage { image: gray_source(w, h), version: 7, measured: false })]);
        plant_smart_rasters_at(&mut reloaded, Some(dir.path()), &after, "img", &mut redone, MatteTier::Full);
        assert_eq!(redone["sel"].version, full["sel"].version);
    }

    /// Timing, on a 24 MP converted mask (gated: a photograph-size plane
    /// in a debug build is slow for the suite). Run with
    /// `cargo test -p heeler-desktop --lib --release -- --ignored brush_stroke_on_a_24mp`.
    #[test]
    #[ignore]
    fn brush_stroke_on_a_24mp_converted_mask() {
        let dir = tempfile::tempdir().unwrap();
        let (w, h) = (4016usize, 6024usize);
        let t = std::time::Instant::now();
        write_full_matte(dir.path(), 0xabc, &edged(w, h)).unwrap();
        eprintln!("twin written: {} ms, {} bytes on disk", t.elapsed().as_millis(), std::fs::metadata(full_matte_path(dir.path(), 0xabc)).unwrap().len());
        let add = r#"[{"points":[[0.3,0.3],[0.7,0.6]],"radius":0.03,"mode":"add"}]"#;
        let add2 = r#"[{"points":[[0.3,0.3],[0.7,0.6]],"radius":0.03,"mode":"add"},{"points":[[0.2,0.7],[0.6,0.8]],"radius":0.03,"mode":"remove"}]"#;
        let (pw, ph) = (1365usize, 2048usize);
        let preview_src = gray_source(pw, ph);
        let full_src = gray_source(w, h);
        let mut session = Session::default();
        let registry = Registry::builtin();
        let mut exec = Executor::new();
        for (label, strokes, src, tier) in [
            ("preview, first stroke (reads the twin, area average)", add, preview_src.clone(), MatteTier::Auto),
            ("preview, next stroke", add2, preview_src.clone(), MatteTier::Auto),
            ("full size, first stroke (settle, export)", add, full_src.clone(), MatteTier::Full),
            ("full size, next stroke", add2, full_src.clone(), MatteTier::Full),
        ] {
            let graph = converted_graph("baked:0000000000000abc", strokes);
            let t = std::time::Instant::now();
            // Each size its own source version, as the preview and the
            // full decode have, so the executor never answers one with
            // the other.
            let version = if src.width == w { 8 } else { 7 };
            let mut sources = HashMap::from([("src".to_string(), SourceImage { image: src, version, measured: false })]);
            plant_smart_rasters_at(&mut session, Some(dir.path()), &graph, "img", &mut sources, tier);
            let planted_ms = t.elapsed().as_millis();
            let g = build_graph(&graph, &registry).unwrap();
            let value = exec.render(&g, "sel", &sources).unwrap();
            let (vw, vh) = match &value {
                Value::Mask(m) => (m.width, m.height),
                Value::Image(mi) => (mi.width, mi.height),
            };
            eprintln!("{label}: planted in {planted_ms} ms, rendered {vw}x{vh} in {} ms total", t.elapsed().as_millis());
        }
    }
}
