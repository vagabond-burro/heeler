//! Stack manifests and the admitted, batched source merge.
//! Session caches, render locks and application events stay with the caller.

use std::path::{Path, PathBuf};
use serde::{Deserialize, Serialize};
use heeler_engine::{ImageBuf, memory::{self, Job, WorkerJob}};
use heeler_engine::stack::{estimate_from_samples_with_stop, luma_samples, Merger, StackMode};
use rayon::prelude::*;
use super::{downscale, one, yes};

/// A stack manifest: which frames, merged how. This is the whole of a
/// stack on disk, a few hundred bytes sitting in the folder beside the
/// frames it names.
///
/// Members are stored as bare file names, relative to the manifest, so
/// moving or renaming the folder does not break the stack. Nothing is
/// rendered here: the merge happens at load, which is what keeps the
/// recipe editable instead of baked into a TIFF.
#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct StackManifest {
    #[serde(default = "one")]
    pub version: u32,
    /// hdr | mean | median | max | min
    pub mode: String,
    #[serde(default = "yes")]
    pub align: bool,
    pub members: Vec<String>,
}

pub fn read_stack(path: &Path) -> Result<StackManifest, String> {
    let text = std::fs::read_to_string(path).map_err(|e| e.to_string())?;
    serde_json::from_str(&text).map_err(|e| format!("bad stack manifest: {e}"))
}

pub fn write_stack(path: &Path, manifest: &StackManifest) -> Result<(), String> {
    let text = serde_json::to_string_pretty(manifest).map_err(|e| e.to_string())?;
    std::fs::write(path, text).map_err(|e| e.to_string())
}

/// One member of a stack, decoded for the merge at full size. A merge
/// of exposures needs light in the units the sensor counted, so a
/// phone's DNG comes scene-linear, without the gain table map, exposure
/// shift and curve its file carries (2026-10-03: "stacks use
/// scene-linear, panoramas keep phone rendering"): a tone-mapped frame
/// has had its shadows lifted and its highlights pulled by amounts that
/// differ across the frame and from frame to frame. Every other file
/// decodes as it does anywhere. A panorama's members keep the plain
/// decode, the phone's finished picture, which is what a stitch should
/// lay side by side.
pub(super) fn stack_member_full(path: &Path, opts: heeler_io::RawSourceOpts) -> Result<ImageBuf, String> {
    heeler_io::decode_any_scene_linear(path, opts).map_err(|e| e.to_string())
}

/// The same member at the preview tier.
pub(super) fn stack_member_preview(path: &Path, opts: heeler_io::RawSourceOpts, edge: usize) -> Result<ImageBuf, String> {
    heeler_io::decode_preview_scene_linear_at(path, opts, edge).map(|img| downscale(&img, edge)).map_err(|e| e.to_string())
}

/// The photometric exposure a frame's EXIF declares, as one linear
/// number: shutter time scaled by ISO over aperture area. Only RATIOS
/// between frames reach the merge, so the units cancel; what matters
/// is that a one-stop shutter step, an ISO doubling and a one-stop
/// aperture change all move this number by the same factor two the
/// sensor saw. None when any component is missing or degenerate; the
/// merge then estimates from the pixels as it always has.
pub(super) fn exif_exposure(exif: &heeler_io::Exif) -> Option<f64> {
    let t = exif.shutter?.value();
    let iso = exif.iso? as f64;
    let ap = exif.aperture?.value();
    if !(t > 0.0) || !(iso > 0.0) || !(ap > 0.0) {
        return None;
    }
    let value = t * iso / (ap * ap);
    (value.is_finite() && value > 0.0).then_some(value)
}

/// Absolute exposures into the relative vector the merge wants: first
/// frame is 1.0 here, and the merge re-anchors the vector at its median
/// so the result renders like the bracket's middle exposure whichever
/// frame sorts first. Empty, meaning "estimate instead", unless EVERY frame
/// answered: a bracket where one frame's EXIF is unreadable has no
/// trustworthy ratios at all, and half-recorded half-guessed would be
/// worse than either whole.
pub(super) fn relative_exposures(values: &[Option<f64>]) -> Vec<f32> {
    let Some(Some(first)) = values.first().copied() else { return Vec::new() };
    if !(first > 0.0) || !first.is_finite() {
        return Vec::new();
    }
    let mut out = Vec::with_capacity(values.len());
    for v in values {
        match v {
            Some(v) if *v > 0.0 && v.is_finite() => {
                let ratio = (*v / first) as f32;
                if !ratio.is_finite() || ratio <= 0.0 { return Vec::new(); }
                out.push(ratio);
            },
            _ => return Vec::new(),
        }
    }
    out
}

/// A decoder a merge can call from several threads at once.
pub type MemberDecode<'a> = dyn Fn(&Path) -> Result<ImageBuf, String> + Sync + 'a;

/// Where a merge has got to, for the progress the viewer shows.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct StackStep {
    /// Frames folded in so far, across every pass.
    pub done: usize,
    /// Frames the whole merge folds: members times passes.
    pub total: usize,
    pub pass: usize,
    pub passes: usize,
    /// Members that would not decode, so far.
    pub missing: usize,
}

/// What a running merge reports to and asks of its caller: progress
/// after every batch, and whether to stop, so a merge nobody is
/// waiting for any more gives the machine back.
pub struct StackWatch<'a> {
    pub progress: &'a (dyn Fn(StackStep) + Sync),
    pub stop: &'a (dyn Fn() -> Option<String> + Sync),
}

impl StackWatch<'static> {
    pub fn quiet() -> StackWatch<'static> {
        StackWatch { progress: &|_| {}, stop: &|| None }
    }
}

/// Decodes every member of a stack and merges them. `decode` is passed
/// in so the preview tier and the export tier share this code rather
/// than growing two copies that drift.
pub fn render_stack(path: &Path, decode: &MemberDecode) -> Result<ImageBuf, String> {
    render_stack_with_warn(path, decode, &|_| {})
}

/// The same, with the warnings a packaged build would otherwise lose
/// (unreadable frames, exposure-estimate fallbacks) handed to the
/// caller instead of a console nobody has.
pub fn render_stack_with_warn(path: &Path, decode: &MemberDecode, on_warn: &dyn Fn(&str)) -> Result<ImageBuf, String> {
    render_stack_at(path, decode, on_warn, None, &StackWatch::quiet())
}

fn probe_stack_members(members: &[PathBuf], decode: &MemberDecode, watch: &StackWatch) -> Result<Option<heeler_io::DecodeEstimate>, String> {
    // Sized from the first member whose header reads: a burst shares
    // one size, and a frame that does not is dropped by the merge.
    // Probing all of them read every file once more before the first
    // decode, a thousand reads for a number the first one gives.
    let mut probe = None;
    for m in members {
        if let Some(v) = heeler_io::probe_memory(m).map_err(|e| e.to_string())? {
            probe = Some(v);
            break;
        }
    }
    // An uncommon format may have no header probe but still decode.
    // Size it on this thread before lending fixed slices to workers.
    if probe.is_none() {
        for member in members {
            if let Some(why) = (watch.stop)() { return Err(why); }
            match decode(member) {
                Ok(img) => {
                    let encoded = std::fs::metadata(member).ok().and_then(|m| usize::try_from(m.len()).ok()).unwrap_or(0);
                    probe = Some(heeler_io::DecodeEstimate {
                        width: img.width, height: img.height, encoded,
                        retained: memory::bytes(img.width, img.height, 1, 16).map_err(|e| e.to_string())?,
                        workspace: memory::sum([memory::bytes(img.width, img.height, 1, 32).map_err(|e| e.to_string())?, encoded]).map_err(|e| e.to_string())?,
                    });
                    break;
                }
                Err(e) if memory::is_refusal(&e) => return Err(e),
                Err(_) => {},
            }
        }
    }
    Ok(probe)
}

struct StackAdmission {
    job: Job,
    worker: WorkerJob,
    batch: usize,
    band_budget: usize,
    estimate_held: usize,
}

fn admit_stack(path: &Path, manifest: &StackManifest, members: &[PathBuf], decode: &MemberDecode, preview_edge: Option<usize>, watch: &StackWatch, mode: StackMode) -> Result<StackAdmission, String> {
    let probe = probe_stack_members(members, decode, watch)?;
    let max_encoded = members.iter().filter_map(|m| std::fs::metadata(m).ok())
        .filter_map(|m| usize::try_from(m.len()).ok()).max().unwrap_or(0);
    let (frame_bytes, decode_bytes) = match &probe {
        Some(v) => match preview_edge {
            Some(edge) => {
                let (frame, _) = v.preview(edge).map_err(|e| e.to_string())?;
                (frame, memory::sum([v.retained, v.workspace]).map_err(|e| e.to_string())?)
            },
            None => (v.retained, v.workspace),
        },
        None => (0, 0),
    };
    let decode_bytes = decode_bytes.saturating_add(probe.as_ref().map(|v| max_encoded.saturating_sub(v.encoded)).unwrap_or(0));
    // One frame per core at a time, fewer when a frame and its decode
    // will not fit that many times over, and never more than 8 GiB of
    // frame and decoder storage in flight: 32 cores decoding 8K frames at full
    // size held 20 GB for a merge whose pace the decoder sets anyway.
    let per_frame = memory::sum([frame_bytes, decode_bytes, if manifest.align { frame_bytes.saturating_mul(2) } else { 0 }]).map_err(|e| e.to_string())?.max(1);
    let threads = rayon::current_num_threads().max(1);
    let batch = (memory::budget().available() / 2 / per_frame).min((8usize << 30) / per_frame).clamp(1, threads).min(members.len().max(1));
    // A median that cannot hold every frame's band at once makes more
    // passes instead. The budget is the machine's whole memory, and a
    // thousand-frame median at the preview tier took 29 GB of it in one
    // band, so its share is a quarter of what is free and never more
    // than 8 GiB: extra passes cost decode time, not other programs'
    // memory.
    let band_allowance = (memory::budget().available() / 4).min(8 << 30).max(1);
    let (band_budget, median_scratch) = if mode == StackMode::Median {
        match &probe {
            Some(v) => {
                let k = preview_edge.map(|e| (e as f64 / v.width.max(v.height).max(1) as f64).min(1.0)).unwrap_or(1.0);
                let (w, h) = ((v.width as f64 * k).ceil() as usize, (v.height as f64 * k).ceil() as usize);
                let samples = memory::bytes(w, 1, members.len().max(1), 12).map_err(|e| e.to_string())?;
                let scratch = memory::bytes(members.len().max(1), 1, 65, 4).map_err(|e| e.to_string())?;
                let rows = (band_allowance / memory::sum([samples, scratch]).map_err(|e| e.to_string())?.max(1)).clamp(1, h.max(1));
                (samples.saturating_mul(rows), scratch.saturating_mul(rows.min(threads)))
            }
            None => (band_allowance, 0),
        }
    } else { (band_allowance, 0) };
    let workspace = match &probe {
        Some(v) => {
            let k = preview_edge.map(|e| (e as f64 / v.width.max(v.height).max(1) as f64).min(1.0)).unwrap_or(1.0);
            let (w, h) = ((v.width as f64 * k).ceil() as usize, (v.height as f64 * k).ceil() as usize);
            Merger::workspace_bytes(w, h, mode, members.len(), band_budget)
        }
        None => 0,
    };
    // The batch in flight and the alignment reference. The estimate's
    // samples grow with the member count and are admitted separately,
    // only when EXIF cannot supply the exposures.
    let in_flight = batch.saturating_mul(per_frame);
    let held = memory::sum([workspace, in_flight, frame_bytes.saturating_mul(2), median_scratch]).map_err(|e| e.to_string())?;
    let estimate_held = match &probe {
        Some(v) if mode == StackMode::Hdr => {
            let k = preview_edge.map(|e| (e as f64 / v.width.max(v.height).max(1) as f64).min(1.0)).unwrap_or(1.0);
            let (w, h) = ((v.width as f64 * k).ceil() as usize, (v.height as f64 * k).ceil() as usize);
            memory::sum([held, heeler_engine::stack::exposure_estimate_bytes(w, h, members.len()).map_err(|e| e.to_string())?]).map_err(|e| e.to_string())?
        }
        _ => held,
    };
    let _job = Job::admit(held, "stack merge and one batch of frames").map_err(|e| format!("{e}: {}", path.display()))?;

    let worker = _job.worker(per_frame);
    Ok(StackAdmission { job: _job, worker, batch, band_budget, estimate_held })
}

fn stack_exposures(members: &[PathBuf], mode: StackMode, batch: usize, worker: &WorkerJob, watch: &StackWatch) -> Result<Vec<Option<f32>>, String> {
    // HDR reads the camera's own exposure record (the owner's approval of
    // the review's suggestion): shutter, ISO and aperture per frame, so the
    // merge weights by what the sensor actually saw instead of estimating
    // it back out of the pixels. All or nothing: a bracket where one
    // frame's EXIF is unreadable has no trustworthy ratios.
    Ok(if mode == StackMode::Hdr {
        let mut values = Vec::with_capacity(members.len());
        for chunk in members.chunks(batch) {
            if let Some(why) = (watch.stop)() { return Err(why); }
            let next: Result<Vec<Option<f64>>, String> = chunk.par_iter().map(|m| worker.run(|| {
                let size = std::fs::metadata(m).ok().and_then(|m| usize::try_from(m.len()).ok()).unwrap_or(0);
                let _read = Job::admit(size, "stack exposure metadata").map_err(|e| e.to_string())?;
                Ok(std::fs::read(m).ok().map(|b| heeler_io::read_exif(&b)).and_then(|e| exif_exposure(&e)))
            })).collect();
            values.extend(next?);
            if let Some(why) = (watch.stop)() { return Err(why); }
        }
        let relative = relative_exposures(&values);
        if relative.len() == members.len() { relative.into_iter().map(Some).collect() } else { vec![None; members.len()] }
    } else {
        vec![None; members.len()]
    })
}

/// HDR with no exposure record (a JPEG bracket without EXIF, or a
/// bracket where one frame's EXIF is unreadable): each member's luma
/// samples, a batch at a time, then one estimate over the whole set, so
/// it does not change with the members' order (the stacking review's R6,
/// 2026-10-08). The frames are not kept, only their samples, a quarter of
/// a megabyte each. A member that will not decode, or is not the first
/// readable member's size, gets None: the merge leaves it out anyway.
fn estimated_exposures(members: &[PathBuf], batch: usize, worker: &WorkerJob, decode: &MemberDecode, on_warn: &dyn Fn(&str), watch: &StackWatch) -> Result<Vec<Option<f32>>, String> {
    let mut samples: Vec<Option<((usize, usize), Vec<f32>)>> = Vec::with_capacity(members.len());
    for chunk in members.chunks(batch.max(1)) {
        if let Some(why) = (watch.stop)() { return Err(why); }
        let got: Vec<Result<Option<((usize, usize), Vec<f32>)>, String>> = chunk
            .par_iter()
            .map(|m| worker.run(|| match decode(m) {
                Ok(img) => Ok(Some(((img.width, img.height), luma_samples(&img)))),
                Err(e) if memory::is_refusal(&e) => Err(e),
                Err(_) => Ok(None),
            }))
            .collect();
        for g in got {
            samples.push(g?);
        }
    }
    if let Some(why) = (watch.stop)() { return Err(why); }
    let size = samples.iter().flatten().next().map(|(size, _)| *size);
    let usable: Vec<usize> = (0..members.len()).filter(|&k| matches!(&samples[k], Some((s, _)) if Some(*s) == size)).collect();
    let sets: Vec<&[f32]> = usable.iter().map(|&k| samples[k].as_ref().map(|(_, v)| v.as_slice()).unwrap_or(&[])).collect();
    let why = std::cell::RefCell::new(None);
    let estimated = estimate_from_samples_with_stop(&sets, on_warn, &|| {
        let stopped = (watch.stop)();
        if stopped.is_some() { *why.borrow_mut() = stopped; true } else { false }
    }).ok_or_else(|| why.into_inner().unwrap_or_else(|| "HDR exposure estimate canceled".into()))?;
    let mut out = vec![None; members.len()];
    for (j, &k) in usable.iter().enumerate() {
        out[k] = Some(estimated[j]);
    }
    Ok(out)
}

type DecodedMember = (Result<ImageBuf, String>, Option<(i32, i32)>);

fn decode_stack_batch(members: &[PathBuf], range: std::ops::Range<usize>, pass: usize, known: &[Option<(i32, i32)>], base: Option<&Merger>, worker: &WorkerJob, decode: &MemberDecode) -> Vec<DecodedMember> {
    range
        .into_par_iter()
        .map(|k| worker.run(|| {
            if pass > 0 {
                // A member that never merged is not decoded again.
                return match known[k] {
                    Some(s) => (decode(&members[k]), Some(s)),
                    None => (Err(String::new()), None),
                };
            }
            let img = decode(&members[k]);
            let shift = match (&img, base) {
                (Ok(f), Some(m)) => m.align(f),
                (Ok(_), None) => Some((0, 0)),
                _ => None,
            };
            (img, shift)
        }))
        .collect()
}

/// The merge, one batch of frames at a time.
///
/// It used to decode every member before merging any, and hold them all:
/// a thousand frames of 8K video is half a terabyte of float at full
/// size and tens of gigabytes even at the preview tier, so a big stack
/// was refused, or ran the machine out of memory, while every other
/// render queued behind it (the owner, "I should be able to stack a
/// 1000 images. It may indeed take longer, but it should be possible
/// without the canvas freezing"). Now a batch of frames, one per core,
/// decodes and aligns in parallel, folds into the merge in order and is
/// dropped. Memory is the merge's own accumulators plus one batch;
/// HDR without EXIF also retains one luma sample set per member.
pub(super) fn render_stack_at(
    path: &Path,
    decode: &MemberDecode,
    on_warn: &dyn Fn(&str),
    preview_edge: Option<usize>,
    watch: &StackWatch,
) -> Result<ImageBuf, String> {
    let manifest = read_stack(path)?;
    let folder = path.parent().unwrap_or(Path::new("."));
    let members: Vec<PathBuf> = manifest.members.iter().map(|name| folder.join(name)).collect();
    let mode = StackMode::from_str(&manifest.mode);
    let StackAdmission { job: _job, worker, batch, band_budget, estimate_held } = admit_stack(path, &manifest, &members, decode, preview_edge, watch, mode)?;

    let mut exposures = stack_exposures(&members, mode, batch, &worker, watch)?;
    let estimated = mode == StackMode::Hdr && exposures.iter().all(|e| e.is_none());
    if estimated {
        let _estimate = Job::admit(estimate_held, "HDR exposure samples and decode batch").map_err(|e| e.to_string())?;
        exposures = estimated_exposures(&members, batch, &worker, decode, on_warn, watch)?;
    }

    let n = members.len();
    let mut missing: Vec<String> = Vec::new();
    let mut merger: Option<Merger> = None;
    // Per member: its shift once aligned, None when it would not decode
    // or is the wrong size. A median's later passes decode again and
    // reuse these.
    let mut shifts: Vec<Option<(i32, i32)>> = vec![None; n];
    let mut pass = 0;
    let mut passes = 1;
    while pass < passes {
        let mut i = 0;
        while i < n {
            if let Some(why) = (watch.stop)() {
                return Err(why);
            }
            // The first frame builds the merge alone, since every other
            // frame aligns against it.
            let end = if merger.is_none() { i + 1 } else { (i + batch).min(n) };
            let batch_out = decode_stack_batch(&members, i..end, pass, &shifts, merger.as_ref(), &worker, decode);
            if let Some(why) = (watch.stop)() { return Err(why); }
            for (j, (img, shift)) in batch_out.into_iter().enumerate() {
                let k = i + j;
                match img {
                    Ok(_) if estimated && exposures[k].is_none() => {
                        // A frame omitted from the pre-pass has no exposure
                        // in this merge, even if a second read now succeeds.
                        missing.push(manifest.members[k].clone());
                    }
                    Ok(img) => {
                        let m = merger.get_or_insert_with(|| Merger::new(&img, mode, manifest.align, n, band_budget));
                        passes = m.passes();
                        if pass == 0 {
                            shifts[k] = shift;
                        }
                        if shifts[k].is_some() && (img.width, img.height) != m.dimensions() {
                            return Err(format!("Stack member dimensions changed on pass {}: {}", pass + 1, members[k].display()));
                        }
                        if pass == 0 && shift.is_none() {
                            missing.push(manifest.members[k].clone());
                        }
                        if let Some(shift) = shifts[k] {
                            m.add(k, &img, shift, exposures[k]);
                        }
                    }
                    Err(e) if memory::is_refusal(&e) => return Err(e),
                    Err(e) if pass > 0 && shifts[k].is_some() => return Err(format!("Stack member failed on pass {}: {}: {e}", pass + 1, members[k].display())),
                    Err(_) if pass > 0 => {}
                    Err(_) => missing.push(manifest.members[k].clone()),
                }
            }
            i = end;
            (watch.progress)(StackStep { done: pass * n + i, total: passes * n, pass, passes, missing: missing.len() });
        }
        let Some(m) = merger.as_mut() else { break };
        m.end_pass();
        pass += 1;
        if pass < passes {
            m.begin_pass(pass);
        }
    }
    if let Some(why) = (watch.stop)() { return Err(why); }
    let Some(merger) = merger else {
        return Err(format!("stack has no readable frames (missing: {})", missing.join(", ")));
    };
    if !missing.is_empty() {
        // Merging fewer frames than asked for looks exactly like the
        // merge not working, so say it rather than quietly producing
        // frame one. A frame is left out when it would not decode, is
        // not the first frame's size, or would not align, so the
        // message names all three: "could not read" sent the owner
        // looking for a broken file that was only the wrong size.
        on_warn(&format!(
            "Stack {} merged {} of {} frames; left out (unreadable, a different size, or would not align): {}",
            path.display(),
            n - missing.len(),
            n,
            missing.join(", ")
        ));
    }
    Ok(merger.finish())
}


#[cfg(test)]
mod math_tests {
    use super::*;

    #[test]
    fn review_hdr_cancels_while_estimating_nonoverlapping_exposures() {
        use std::sync::atomic::{AtomicUsize, Ordering};
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("dark.stack");
        let frame = ImageBuf::filled(16, 16, [0.0, 0.0, 0.0, 1.0]);
        let bytes = heeler_io::encode_png(&frame).unwrap();
        for k in 0..20 { std::fs::write(dir.path().join(format!("{k}.png")), &bytes).unwrap(); }
        write_stack(&path, &StackManifest { version: 1, mode: "hdr".into(), align: false,
            members: (0..20).map(|k| format!("{k}.png")).collect() }).unwrap();
        let warnings = AtomicUsize::new(0);
        let out = render_stack_at(&path, &|_| Ok(frame.clone()), &|_| { warnings.fetch_add(1, Ordering::Relaxed); }, None,
            &StackWatch { progress: &|_| {}, stop: &|| (warnings.load(Ordering::Relaxed) > 0).then(|| "review requested cancellation".to_string()) });
        assert_eq!(out.unwrap_err(), "review requested cancellation");
        assert_eq!(warnings.load(Ordering::Relaxed), 1, "cancel stops the candidate searches after the first warning");
    }

    #[test]
    fn review_hdr_keeps_prepass_failures_out_if_a_later_read_succeeds() {
        use std::sync::atomic::{AtomicUsize, Ordering};
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("changing.stack");
        let frames: Vec<_> = [0.1, 0.2, 0.4].into_iter().map(|v| ImageBuf::filled(16, 16, [v, v, v, 1.0])).collect();
        for k in 0..3 {
            std::fs::write(dir.path().join(format!("{k}.png")), heeler_io::encode_png(&frames[k]).unwrap()).unwrap();
        }
        write_stack(&path, &StackManifest { version: 1, mode: "hdr".into(), align: false,
            members: (0..3).map(|k| format!("{k}.png")).collect() }).unwrap();
        for fail_on in [0, 1] {
            let reads: Vec<_> = (0..3).map(|_| AtomicUsize::new(0)).collect();
            let got = render_stack_at(&path, &|p| {
                let k = p.file_stem().unwrap().to_str().unwrap().parse::<usize>().unwrap();
                let read = reads[k].fetch_add(1, Ordering::Relaxed);
                if k == 1 && read == fail_on { Err("member would not decode on this read".into()) }
                else { Ok(frames[k].clone()) }
            }, &|_| {}, None, &StackWatch::quiet()).unwrap();
            let want = heeler_engine::stack::merge(&[frames[0].clone(), frames[2].clone()], &heeler_engine::stack::StackOpts { mode: StackMode::Hdr, align: false, exposures: vec![1.0, 4.0] }).unwrap();
            assert_eq!(got, want, "a failed member stays out, on read {fail_on}");
        }
    }

    #[test]
    fn review_hdr_prepass_admits_retained_samples_before_decoding_the_set() {
        use std::sync::atomic::{AtomicUsize, Ordering};
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("many.stack");
        write_stack(&path, &StackManifest { version: 1, mode: "hdr".into(), align: false,
            members: (0..1000).map(|k| k.to_string()).collect() }).unwrap();
        let calls = AtomicUsize::new(0);
        let out = memory::with_budget(128 << 10, || render_stack_at(&path, &|_| {
            calls.fetch_add(1, Ordering::Relaxed);
            Ok(ImageBuf::filled(16, 16, [0.1, 0.1, 0.1, 1.0]))
        }, &|_| {}, None, &StackWatch::quiet()));
        assert!(out.as_ref().is_err_and(|e| memory::is_refusal(e)), "the 1 MiB sample set must not fit 128 KiB");
        assert!(calls.load(Ordering::Relaxed) <= 1, "only the unprobed format's sizing read may run before refusal");
    }

    #[test]
    fn review_batched_statistics_ignore_bad_channels_and_missing_members() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("hand.stack");
        let frames: Vec<_> = [
            [0.0, -0.25, 1.25, 0.2],
            [1.0, 0.25, 0.0, 0.3],
            [0.5, 0.5, 1.0, 0.4],
            [f32::NAN, f32::INFINITY, f32::NEG_INFINITY, 0.5],
        ]
        .into_iter()
        .map(|v| ImageBuf::filled(5, 4, v))
        .collect();
        for (mode, rgb) in [
            ("mean", [0.5, 1.0 / 6.0, 0.75]),
            ("median", [0.5, 0.25, 1.0]),
            ("max", [1.0, 0.5, 1.25]),
            ("min", [0.0, -0.25, 0.0]),
            ("hdr", [0.00022479768, 0.10003598, 0.0]),
        ] {
            // Every header declares the same exposure, including the missing
            // member. Pixel values come only from the synthetic decode closure.
            let source = Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("../../../crates/heeler-io/tests/fixtures/stack-exposure-0.jpg");
            for name in ["missing", "0", "1", "odd", "2", "3"] {
                std::fs::copy(&source, dir.path().join(name)).unwrap();
            }
            write_stack(
                &path,
                &StackManifest {
                    version: 1,
                    mode: mode.into(),
                    align: false,
                    members: vec![
                        "missing".into(),
                        "0".into(),
                        "1".into(),
                        "odd".into(),
                        "2".into(),
                        "3".into(),
                    ],
                },
            )
            .unwrap();
            let decode = |p: &Path| match p.file_name().unwrap().to_str().unwrap() {
                "missing" => Err("synthetic missing member".into()),
                "odd" => Ok(ImageBuf::filled(6, 4, [99.0; 4])),
                v => Ok(frames[v.parse::<usize>().unwrap()].clone()),
            };
            let got = render_stack_at(&path, &decode, &|_| {}, None, &StackWatch::quiet()).unwrap();
            for px in got.data.chunks_exact(4) {
                for c in 0..3 {
                    assert!(
                        (px[c] - rgb[c]).abs() < 1e-7,
                        "{mode} channel {c}: {}",
                        px[c]
                    );
                }
                assert_eq!(px[3], 1.0);
            }
        }
    }
    // All-at-once, f64 reference for synthetic batched members. No engine
    // statistic or HDR weight helper supplies the expected numbers.
    fn plain(frames: &[ImageBuf], mode: &str, exposures: &[f64]) -> ImageBuf {
        plain_shifted(frames, &vec![(0, 0); frames.len()], mode, exposures)
    }

    fn plain_shifted(
        frames: &[ImageBuf],
        shifts: &[(i32, i32)],
        mode: &str,
        exposures: &[f64],
    ) -> ImageBuf {
        let mut sorted = exposures.to_vec();
        sorted.sort_by(f64::total_cmp);
        let anchor = if sorted.len() % 2 == 0 {
            (sorted[sorted.len() / 2 - 1] * sorted[sorted.len() / 2]).sqrt()
        } else {
            sorted[sorted.len() / 2]
        };
        let (w, h) = (frames[0].width, frames[0].height);
        let mut out = ImageBuf::new(w, h);
        for y in 0..h {
            for x in 0..w {
                for c in 0..3 {
                    let mut samples: Vec<_> = frames
                        .iter()
                        .enumerate()
                        .filter_map(|(k, f)| {
                            let (sx, sy) = (x as i32 + shifts[k].0, y as i32 + shifts[k].1);
                            (sx >= 0 && sy >= 0 && sx < w as i32 && sy < h as i32)
                                .then(|| (k, f.pixel(sx as usize, sy as usize)[c] as f64))
                        })
                        .collect();
                    samples.retain(|(_, v)| v.is_finite());
                    let v = if samples.is_empty() {
                        0.0
                    } else {
                        match mode {
                            "mean" => {
                                samples.iter().map(|(_, v)| v).sum::<f64>() / samples.len() as f64
                            }
                            "max" => samples
                                .iter()
                                .map(|(_, v)| *v)
                                .fold(f64::NEG_INFINITY, f64::max),
                            "min" => samples
                                .iter()
                                .map(|(_, v)| *v)
                                .fold(f64::INFINITY, f64::min),
                            "median" => {
                                samples.sort_by(|a, b| a.1.total_cmp(&b.1));
                                let m = samples.len() / 2;
                                if samples.len() % 2 == 1 { samples[m].1 } else { (samples[m - 1].1 + samples[m].1) / 2.0 }
                            }
                            _ => {
                                let weights: Vec<_> = samples
                                    .iter()
                                    .map(|(k, v)| {
                                        let q = ((v - 0.8) / 0.15).clamp(0.0, 1.0);
                                        (1.0 - q * q * (3.0 - 2.0 * q)) * exposures[*k].powi(2)
                                            / (5.625e-9 + v.abs() / 40000.0)
                                    })
                                    .collect();
                                let ws = weights.iter().sum::<f64>();
                                anchor
                                    * if ws > 0.0 {
                                        samples
                                            .iter()
                                            .zip(weights)
                                            .map(|((k, v), w)| w * v / exposures[*k])
                                            .sum::<f64>()
                                            / ws
                                    } else {
                                        samples
                                            .iter()
                                            .map(|(k, v)| v / exposures[*k])
                                            .fold(0.0, f64::max)
                                    }
                            }
                        }
                    };
                    out.data[(y * w + x) * 4 + c] = v as f32;
                }
                out.data[(y * w + x) * 4 + 3] = 1.0;
            }
        }
        out
    }

    #[test]
    fn review_batched_all_methods_match_independent_reference_and_member_exposures() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("reference.stack");
        for k in 0..3 {
            let name = format!("stack-exposure-{k}.jpg");
            std::fs::copy(
                Path::new(env!("CARGO_MANIFEST_DIR"))
                    .join("../../../crates/heeler-io/tests/fixtures")
                    .join(&name),
                dir.path().join(name),
            )
            .unwrap();
        }
        let frames: Vec<_> = [0.2, 0.875, 1.1]
            .into_iter()
            .map(|v| ImageBuf::filled(5, 4, [v, v * 0.5, -v * 0.25, 0.2]))
            .collect();
        for order in [[0, 1, 2], [2, 0, 1], [1, 2, 0]] {
            for skipped in [None, Some(0), Some(1), Some(2)] {
                for wrong_size in [false, true] {
                    // The first readable member defines geometry. Put a size
                    // mismatch later; an unreadable first member is covered too.
                    if wrong_size && skipped == Some(order[0]) {
                        continue;
                    }
                    for mode in ["mean", "median", "max", "min", "hdr"] {
                        let names: Vec<_> = order
                            .iter()
                            .map(|k| format!("stack-exposure-{k}.jpg"))
                            .collect();
                        write_stack(
                            &path,
                            &StackManifest {
                                version: 1,
                                mode: mode.into(),
                                align: false,
                                members: names,
                            },
                        )
                        .unwrap();
                        let decode = |p: &Path| {
                            let k = p
                                .file_stem()
                                .unwrap()
                                .to_str()
                                .unwrap()
                                .rsplit('-')
                                .next()
                                .unwrap()
                                .parse::<usize>()
                                .unwrap();
                            if Some(k) == skipped {
                                if wrong_size {
                                    Ok(ImageBuf::filled(6, 4, [99.0; 4]))
                                } else {
                                    Err("synthetic missing".into())
                                }
                            } else {
                                Ok(frames[k].clone())
                            }
                        };
                        let got =
                            render_stack_at(&path, &decode, &|_| {}, None, &StackWatch::quiet())
                                .unwrap();
                        let usable: Vec<_> = order
                            .iter()
                            .copied()
                            .filter(|k| Some(*k) != skipped)
                            .collect();
                        let selected: Vec<_> = usable.iter().map(|k| frames[*k].clone()).collect();
                        let exposures: Vec<_> = usable.iter().map(|k| (1 << k) as f64).collect();
                        let want = plain(&selected, mode, &exposures);
                        for (a, b) in got.data.iter().zip(&want.data) {
                            assert!(
                                (a - b).abs() < 2e-6,
                                "{mode} order={order:?} skipped={skipped:?}: {a} != {b}"
                            );
                        }
                    }
                }
            }
        }
    }

    #[test]
    fn review_exif_ratios_include_aperture_and_auto_iso_and_require_all_members() {
        let source = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../../crates/heeler-io/tests/fixtures/stack-exposure-0.jpg");
        let mut exif = heeler_io::read_exif(&std::fs::read(source).unwrap());
        let base = exif_exposure(&exif).unwrap();
        exif.iso = Some(exif.iso.unwrap() * 2);
        assert_eq!(exif_exposure(&exif), Some(base * 2.0));
        // Scaling f-number by two gives one quarter of the exposure.
        let ap = exif.aperture.unwrap();
        exif.aperture = Some(heeler_io::exif::Ratio {
            num: ap.num * 2,
            den: ap.den,
        });
        assert_eq!(exif_exposure(&exif), Some(base * 0.5));
        assert_eq!(
            relative_exposures(&[Some(base), None, Some(base * 2.0)]),
            Vec::<f32>::new()
        );
        assert_eq!(
            relative_exposures(&[Some(base), Some(base * 4.0)]),
            vec![1.0, 4.0]
        );
    }

    #[test]
    fn review_batched_alignment_uses_shifted_samples_for_every_method() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("aligned.stack");
        let mut base = ImageBuf::new(128, 128);
        for y in 0..128 {
            for x in 0..128 {
                let u = x as f32 / 128.0;
                let v = y as f32 / 128.0;
                let mut value = 0.04;
                for (bx, by, r, a) in [
                    (0.23, 0.31, 0.16, 0.2),
                    (0.67, 0.19, 0.1, 0.15),
                    (0.41, 0.72, 0.2, 0.19),
                    (0.85, 0.61, 0.09, 0.25),
                    (0.12, 0.86, 0.13, 0.13),
                    (0.55, 0.45, 0.07, 0.27),
                ] {
                    value += a * (-((u - bx).powi(2) + (v - by).powi(2)) / (2.0 * r * r)).exp();
                }
                base.set_pixel(x, y, [value, value * 0.9, value * 0.8, 0.2]);
            }
        }
        let shifts = [(0, 0), (4, -3), (-4, 3)];
        let frames: Vec<_> = shifts
            .iter()
            .enumerate()
            .map(|(k, (dx, dy))| {
                let mut f = ImageBuf::new(128, 128);
                for y in 0..128 {
                    for x in 0..128 {
                        let mut px = base.pixel(
                            (x as i32 - dx).clamp(0, 127) as usize,
                            (y as i32 - dy).clamp(0, 127) as usize,
                        );
                        for c in 0..3 {
                            px[c] *= (1 << k) as f32;
                        }
                        f.set_pixel(x, y, px);
                    }
                }
                f
            })
            .collect();
        let names: Vec<_> = (0..3).map(|k| format!("stack-exposure-{k}.jpg")).collect();
        for (k, name) in names.iter().enumerate() {
            let bytes = std::fs::read(
                Path::new(env!("CARGO_MANIFEST_DIR"))
                    .join("../../../crates/heeler-io/tests/fixtures")
                    .join(name),
            )
            .unwrap();
            let exif = heeler_io::read_exif(&bytes);
            let mut jpeg = heeler_io::encode_jpeg(&frames[k], 95).unwrap();
            heeler_io::embed_jpeg_exif(
                &mut jpeg,
                &heeler_io::write_exif_tiff(
                    &exif,
                    heeler_io::ExifExportOptions {
                        width: 128,
                        height: 128,
                        dpi: 300,
                    },
                ),
            );
            std::fs::write(dir.path().join(name), jpeg).unwrap();
        }
        for mode in ["mean", "median", "max", "min", "hdr"] {
            write_stack(
                &path,
                &StackManifest {
                    version: 1,
                    mode: mode.into(),
                    align: true,
                    members: names.clone(),
                },
            )
            .unwrap();
            let decode = |p: &Path| {
                Ok(frames[p
                    .file_stem()
                    .unwrap()
                    .to_str()
                    .unwrap()
                    .rsplit('-')
                    .next()
                    .unwrap()
                    .parse::<usize>()
                    .unwrap()]
                .clone())
            };
            let got = render_stack_at(&path, &decode, &|_| {}, None, &StackWatch::quiet()).unwrap();
            let want = plain_shifted(&frames, &shifts, mode, &[1.0, 2.0, 4.0]);
            for (a, b) in got.data.iter().zip(&want.data) {
                assert!((a - b).abs() < 2e-6, "{mode}: {a} != {b}");
            }
        }
    }

    #[test]
    fn review_batched_one_row_median_matches_whole_band_reference() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("bands.stack");
        let frames: Vec<_> = (0..80)
            .map(|k| {
                ImageBuf::filled(
                    5,
                    4,
                    [
                        k as f32 / 80.0,
                        1.0 - k as f32 / 80.0,
                        (k % 7) as f32 / 7.0,
                        0.2,
                    ],
                )
            })
            .collect();
        write_stack(
            &path,
            &StackManifest {
                version: 1,
                mode: "median".into(),
                align: false,
                members: (0..80).map(|k| k.to_string()).collect(),
            },
        )
        .unwrap();
        let decode = |p: &Path| {
            Ok(frames[p
                .file_name()
                .unwrap()
                .to_str()
                .unwrap()
                .parse::<usize>()
                .unwrap()]
            .clone())
        };
        let want = plain(&frames, "median", &vec![1.0; 80]);
        for limit in [64 << 10, 16 << 20] {
            let steps = std::sync::Mutex::new(Vec::new());
            let got = memory::with_budget(limit, || {
                render_stack_at(
                    &path,
                    &decode,
                    &|_| {},
                    None,
                    &StackWatch {
                        progress: &|s| steps.lock().unwrap().push(s),
                        stop: &|| None,
                    },
                )
            })
            .unwrap();
            assert_eq!(got, want);
            let steps = steps.into_inner().unwrap();
            let last = steps.last().unwrap();
            assert_eq!(last.passes, if limit == 64 << 10 { 4 } else { 1 });
            assert_eq!(last.total, 80 * last.passes);
            assert_eq!(last.done, last.total);
        }
    }

    /// HDR with no EXIF estimates over the whole set before it merges, so
    /// the same bracket in the camera's order (0, -, +, -2, +2) and in
    /// sorted order renders the same picture, and a member that will not
    /// decode is left out of the estimate as well as the merge (R6,
    /// 2026-10-08). The members are not files, so no EXIF answers.
    #[test]
    fn an_estimated_hdr_stack_does_not_depend_on_its_members_order() {
        let scene = |x: usize, y: usize| 0.02 + 0.6 * ((x * 7 + y * 13) % 97) as f32 / 97.0;
        let stops = [1.0f32, 0.5, 2.0, 0.25, 4.0];
        let frames: Vec<ImageBuf> = stops
            .iter()
            .map(|&e| {
                // A little flare that does not scale with exposure, as a
                // real frame has: pairwise ratios then disagree slightly,
                // so a chain in member order is not the chain in sorted
                // order (on clean linear frames every order agrees).
                let flare = 0.01 * e.sqrt();
                let mut f = ImageBuf::new(64, 48);
                for y in 0..48 {
                    for x in 0..64 {
                        let v = (scene(x, y) * e + flare).min(1.0);
                        f.set_pixel(x, y, [v, v * 0.9, v * 0.8, 1.0]);
                    }
                }
                f
            })
            .collect();
        let dir = tempfile::tempdir().unwrap();
        let decode = |p: &Path| -> Result<ImageBuf, String> {
            let name = p.file_name().unwrap().to_str().unwrap();
            name.parse::<usize>().map(|k| frames[k].clone()).map_err(|_| format!("{name} will not decode"))
        };
        let render = |members: &[&str]| {
            let path = dir.path().join("hdr.stack");
            write_stack(&path, &StackManifest { version: 1, mode: "hdr".into(), align: false, members: members.iter().map(|m| m.to_string()).collect() }).unwrap();
            render_stack_at(&path, &decode, &|_| {}, None, &StackWatch::quiet()).unwrap()
        };
        let close = |a: &ImageBuf, b: &ImageBuf, what: &str| {
            for (i, (x, y)) in a.data.iter().zip(&b.data).enumerate() {
                assert!((x - y).abs() <= 2e-6 * y.abs().max(1.0), "{what}: sample {i} is {x}, want {y}");
            }
        };
        let camera = render(&["0", "1", "2", "3", "4"]);
        close(&render(&["3", "1", "0", "2", "4"]), &camera, "sorted order");
        close(&render(&["4", "2", "0", "1", "3"]), &camera, "reversed order");
        // The engine's all-at-once merge estimates the same way.
        let engine = heeler_engine::stack::merge(&frames, &heeler_engine::stack::StackOpts { mode: StackMode::Hdr, align: false, exposures: Vec::new() }).unwrap();
        close(&camera, &engine, "engine");
        // A member that will not decode is in neither the estimate nor the merge.
        close(&render(&["0", "1", "broken", "3", "4"]), &heeler_engine::stack::merge(&[frames[0].clone(), frames[1].clone(), frames[3].clone(), frames[4].clone()], &heeler_engine::stack::StackOpts { mode: StackMode::Hdr, align: false, exposures: Vec::new() }).unwrap(), "left out");
    }
}
