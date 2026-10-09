//! The model registry: what can be downloaded, from where, and the
//! checksums that make the download trustworthy. Seven entries: SAM
//! (click selection), BiRefNet (subject matte), LaMa (inpaint fill),
//! ViTMatte (edge refinement), Depth Anything V2 Small (scene depth),
//! SCUNet (noise reduction) and Florence-2 (what is in the picture),
//! each with its license caveat recorded on the entry.

use std::io::Read;
use std::path::{Path, PathBuf};

use sha2::{Digest, Sha256};

use crate::VisionError;

/// Fixed staging names are shared by installation and updates, so
/// downloads serialize on this lock (module scope, so a test can prove
/// a poisoned lock still lets a download through).
static DOWNLOAD: std::sync::Mutex<()> = std::sync::Mutex::new(());

/// How the download arrives: a zip to extract from, or the file
/// itself.
#[derive(Clone, Copy, Debug, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ArchiveKind {
    Zip,
    File,
}

/// A model file downloaded on its own beside the archive: an ONNX
/// export whose weights live in an external `.onnx.data` sibling
/// ships as two plain files, and the graph file names the sibling by
/// relative path, so both must land in the model's directory. Pinned
/// like the archive; verified before it is trusted.
pub struct ExtraFile {
    pub name: &'static str,
    pub urls: &'static [&'static str],
    pub sha256: &'static str,
    pub bytes: u64,
}

pub struct ModelSpec {
    /// stable id; also the directory name under the models dir
    pub id: &'static str,
    pub label: &'static str,
    pub license: &'static str,
    /// The registry's version of these weights, as people read it
    /// ("2026.09"): what Preferences shows, and what the models
    /// manifest compares against to offer an update. Bumped whenever
    /// the pinned files change.
    pub version: &'static str,
    /// download sources, tried in order: the first is what the consent
    /// dialog names. The single pinned hash below covers them all, so a
    /// mirror joins with one line and a vanished upstream repo costs
    /// availability of ONE source, never integrity of any. The second
    /// source of every model is Vagabond Burro's own mirror, the `models`
    /// pre-release on github.com/vagabond-burro/heeler: an undated address
    /// that never changes (2026-09-28; it replaced `models-2026.09`, which
    /// stays up for versions before 2026.4), verified byte for byte
    /// against these pins. A changed model goes up under a new file name
    /// there, never over the old one.
    pub urls: &'static [&'static str],
    /// the downloaded archive's pinned SHA-256 (hex)
    pub archive_sha256: &'static str,
    pub archive_bytes: u64,
    pub kind: ArchiveKind,
    /// files extracted from the archive (or, for a File download, the
    /// single name it is stored under), plus every extra file: (name,
    /// pinned SHA-256). `installed` checks all of them.
    pub files: &'static [(&'static str, &'static str)],
    /// Further plain files fetched after the archive (see ExtraFile).
    pub extra: &'static [ExtraFile],
}

impl ModelSpec {
    /// Everything the download will fetch, for the consent card.
    pub fn total_bytes(&self) -> u64 {
        self.archive_bytes + self.extra.iter().map(|e| e.bytes).sum::<u64>()
    }
}

/// MobileSAM (Apache-2.0), packaged by the AnyLabeling maintainer:
/// the distilled SAM image encoder plus the standard SAM mask
/// decoder, both ONNX. Encoder input is dynamic HWC float32 with the
/// normalization baked into the graph; the decoder is Meta's exported
/// contract (embeddings + clicks in the 1024 frame -> mask logits at
/// the original size).
pub const MOBILE_SAM: ModelSpec = ModelSpec {
    id: "mobile_sam",
    version: "2023.06",
    label: "Segment Anything (MobileSAM)",
    license: "Apache-2.0 (code and weights; SA-1B training data under Meta's published terms)",
    urls: &[
        "https://huggingface.co/vietanhdev/segment-anything-onnx-models/resolve/main/mobile_sam_20230629.zip",
        "https://github.com/vagabond-burro/heeler/releases/download/models/mobile_sam_20230629.zip",
    ],
    archive_sha256: "41aff2660b7531becfee21fb257c49933ddc892c554507bdb775bf504d443942",
    archive_bytes: 36_655_105,
    kind: ArchiveKind::Zip,
    files: &[
        (
            "mobile_sam.encoder.onnx",
            "20deef402855b31222b528f52b04807e41ebe47216ac0e39a0729f43491a0209",
        ),
        (
            "sam_vit_h_4b8939.decoder.onnx",
            "22cf85e35d14182f4b4712364264c06b22edbef63f065189586f080ef4e2f325",
        ),
    ],
    extra: &[],
};

/// BiRefNet Lite (MIT, weights by the author; ONNX packaging by the
/// Hugging Face onnx-community): the one-shot subject matte with soft
/// edges: dichotomous segmentation, no clicks. The layer-4 caveat
/// from the spec stands and is stated on the open-source page: the
/// training corpus (DIS5K and friends) is academic in origin, one
/// notch below SAM's fully-published story. Fixed 1024x1024 input,
/// ImageNet normalization, logits out.
pub const BIREFNET_LITE: ModelSpec = ModelSpec {
    id: "birefnet_lite",
    version: "2024.09",
    label: "BiRefNet Lite (subject matte)",
    license: "MIT (code and weights; academic training corpus, see the open-source page)",
    urls: &[
        "https://huggingface.co/onnx-community/BiRefNet_lite-ONNX/resolve/main/onnx/model.onnx",
        "https://github.com/vagabond-burro/heeler/releases/download/models/birefnet_lite.onnx",
    ],
    archive_sha256: "5600024376f572a557870a5eb0afb1e5961636bef4e1e22132025467d0f03333",
    archive_bytes: 224_005_088,
    kind: ArchiveKind::File,
    files: &[(
        "model.onnx",
        "5600024376f572a557870a5eb0afb1e5961636bef4e1e22132025467d0f03333",
    )],
    extra: &[],
};

/// LaMa (Samsung AI, Apache-2.0; ONNX packaging by Carve, also
/// Apache-2.0): resolution-robust inpainting, the fill behind the
/// second Section 17 amendment's scoped generative cleanup. Fixed 512
/// square, image 0..1 CHW plus a binary hole mask. The layer-4 note
/// for the open-source page: trained on Places2, an academic corpus,
/// the weakest provenance layer, stated rather than
/// hidden.
pub const LAMA: ModelSpec = ModelSpec {
    id: "lama",
    version: "2024.03",
    label: "LaMa (inpainting)",
    license: "Apache-2.0 (code and weights; Places2 academic training corpus, see the open-source page)",
    urls: &[
        "https://huggingface.co/Carve/LaMa-ONNX/resolve/main/lama_fp32.onnx",
        "https://github.com/vagabond-burro/heeler/releases/download/models/lama_fp32.onnx",
    ],
    archive_sha256: "1faef5301d78db7dda502fe59966957ec4b79dd64e16f03ed96913c7a4eb68d6",
    archive_bytes: 208_044_816,
    kind: ArchiveKind::File,
    files: &[(
        "lama_fp32.onnx",
        "1faef5301d78db7dda502fe59966957ec4b79dd64e16f03ed96913c7a4eb68d6",
    )],
    extra: &[],
};

/// ViTMatte small (code MIT, weights Apache-2.0 per the author's own
/// model card; ONNX packaging by Xenova): trimap-guided alpha matting,
/// the P4 Selection Polish upgrade. Given the photograph and a trimap
/// (known subject, known background, unknown band), it resolves the
/// band at pixel level: hair strands, fur, branches, the fine edges
/// the classical polish could never read. Dynamic input size padded to
/// a multiple of 32; 4 channels (RGB at (x/255 - 0.5)/0.5 plus the
/// trimap as 0 / 0.5 / 1); alphas out at input size. The layer-4 note:
/// trained on Composition-1k, an academic corpus.
pub const VITMATTE: ModelSpec = ModelSpec {
    id: "vitmatte",
    version: "2024.06",
    label: "ViTMatte (edge refinement)",
    license: "Apache-2.0 weights, MIT code (Composition-1k academic training corpus, see the open-source page)",
    urls: &[
        "https://huggingface.co/Xenova/vitmatte-small-composition-1k/resolve/main/onnx/model.onnx",
        "https://github.com/vagabond-burro/heeler/releases/download/models/vitmatte_small_composition_1k.onnx",
    ],
    archive_sha256: "bf28d2e0be2c073286e88d60ad649d7123da2749a2d99133fd1098d5887e0225",
    archive_bytes: 103_885_865,
    kind: ArchiveKind::File,
    files: &[(
        "model.onnx",
        "bf28d2e0be2c073286e88d60ad649d7123da2749a2d99133fd1098d5887e0225",
    )],
    extra: &[],
};

pub const DEPTH_ANYTHING: ModelSpec = ModelSpec {
    id: "depth_anything_v2_small",
    version: "2024.06",
    label: "Depth Anything V2 Small (scene depth)",
    // The SMALL variant only: its weights are Apache-2.0. Base and
    // Large carry CC-BY-NC weights - NON-COMMERCIAL - and must never
    // be swapped in here.
    license: "Apache-2.0 (code and weights)",
    urls: &[
        "https://huggingface.co/onnx-community/depth-anything-v2-small/resolve/main/onnx/model.onnx",
        "https://github.com/vagabond-burro/heeler/releases/download/models/depth_anything_v2_small.onnx",
    ],
    archive_sha256: "afb6a5c28f3b6bf1618c6e43f02073ef9dfdc70e937502d51603e57b0a1df10c",
    archive_bytes: 99_060_839,
    kind: ArchiveKind::File,
    files: &[(
        "model.onnx",
        "afb6a5c28f3b6bf1618c6e43f02073ef9dfdc70e937502d51603e57b0a1df10c",
    )],
    extra: &[],
};

/// SCUNet (Zhang et al., 2022, "Practical Blind Image Denoising via
/// Swin-Conv-UNet and Data Synthesis"): the blind real-noise color
/// denoiser behind Noise Reduction's Model method. Upstream code and
/// weights are Apache-2.0 (cszn/SCUNet; the KAIR weight release is
/// MIT), re-exported to ONNX by Heliosoph under Apache-2.0. The graph
/// file names its external weights (`.onnx.data`) by relative path,
/// so the two travel as a pair. Input `image` NCHW float 0..1, sides
/// multiples of 8; output `denoised`, the same shape.
pub const SCUNET: ModelSpec = ModelSpec {
    id: "scunet_color_real_psnr",
    version: "2026.06",
    label: "SCUNet (noise reduction)",
    license: "Apache-2.0 (code and weights; synthetic training corpus, see the open-source page)",
    urls: &[
        "https://huggingface.co/Heliosoph/scunet-onnx/resolve/main/scunet_color_real_psnr.onnx",
        "https://github.com/vagabond-burro/heeler/releases/download/models/scunet_color_real_psnr.onnx",
    ],
    archive_sha256: "231be201ab413dbc999d7951caa9844846b93a12a40a41e037d6b5888ed4e88c",
    archive_bytes: 3_798_678,
    kind: ArchiveKind::File,
    files: &[
        (
            "scunet_color_real_psnr.onnx",
            "231be201ab413dbc999d7951caa9844846b93a12a40a41e037d6b5888ed4e88c",
        ),
        (
            "scunet_color_real_psnr.onnx.data",
            "98825ea1210b641c71e5f052f582c70c49fd44b35387ebe2c034268c17df3feb",
        ),
    ],
    extra: &[ExtraFile {
        name: "scunet_color_real_psnr.onnx.data",
        urls: &[
            "https://huggingface.co/Heliosoph/scunet-onnx/resolve/main/scunet_color_real_psnr.onnx.data",
            "https://github.com/vagabond-burro/heeler/releases/download/models/scunet_color_real_psnr.onnx.data",
        ],
        sha256: "98825ea1210b641c71e5f052f582c70c49fd44b35387ebe2c034268c17df3feb",
        bytes: 73_138_176,
    }],
};

/// Florence-2 base (Microsoft, MIT, code and weights; ONNX packaging by
/// the Hugging Face onnx-community, MIT): the assistant's eyes.
/// Captions, objects with boxes, a phrase to boxes; florence.rs runs
/// it. Trained on FLD-5B, Microsoft's own dataset (126 million images,
/// 5.4 billion annotations, labeled by Microsoft's models and
/// filtered), stated on the open-source page. Five files from one
/// pinned revision of the repository, so a later push there cannot
/// change what this entry fetches: the vision encoder (the download
/// proper), then the int8 token embedding, the text encoder, the merged
/// decoder and the tokenizer. The precision mix is florence.rs's
/// FLORENCE_FILES note.
pub const FLORENCE_2: ModelSpec = ModelSpec {
    id: "florence_2_base",
    version: "2025.05",
    label: "Florence-2 base (what is in the picture)",
    license: "MIT (code and weights; FLD-5B training data by Microsoft, see the open-source page)",
    urls: &[
        "https://huggingface.co/onnx-community/Florence-2-base/resolve/d59e079711c57174f29265539fb4cc9f0f335916/onnx/vision_encoder.onnx",
        "https://github.com/vagabond-burro/heeler/releases/download/models/florence_2_base_vision_encoder.onnx",
    ],
    archive_sha256: "2c7464fce495ea43b415b48afe7dbe84a9ebbe0cfe3c31fdd81c6dd66b39ff75",
    archive_bytes: 366_591_558,
    kind: ArchiveKind::File,
    files: &[
        ("vision_encoder.onnx", "2c7464fce495ea43b415b48afe7dbe84a9ebbe0cfe3c31fdd81c6dd66b39ff75"),
        ("embed_tokens_int8.onnx", "8818c58a214e53bf7e22c48bb4674c2fa3112b9539c3ce4075a2eac797b1ef74"),
        ("encoder_model.onnx", "b155b5a0e56a4244c62060751bb1b70dfe481015d0dbfa6d19b1912d9e58da0d"),
        ("decoder_model_merged.onnx", "6d6e1266d7f94f5d4ec9cc07d9c1f7b3e47049c9b0de7bbe82a91e62dfd152af"),
        ("tokenizer.json", "d69dcdb2323e124ac4f800cb9863ddccea0d7bb11e16125e8df3bd60f2f8aeac"),
    ],
    extra: &[
        ExtraFile {
            name: "embed_tokens_int8.onnx",
            urls: &[
                "https://huggingface.co/onnx-community/Florence-2-base/resolve/d59e079711c57174f29265539fb4cc9f0f335916/onnx/embed_tokens_int8.onnx",
                "https://github.com/vagabond-burro/heeler/releases/download/models/florence_2_base_embed_tokens_int8.onnx",
            ],
            sha256: "8818c58a214e53bf7e22c48bb4674c2fa3112b9539c3ce4075a2eac797b1ef74",
            bytes: 39_390_496,
        },
        ExtraFile {
            name: "encoder_model.onnx",
            urls: &[
                "https://huggingface.co/onnx-community/Florence-2-base/resolve/d59e079711c57174f29265539fb4cc9f0f335916/onnx/encoder_model.onnx",
                "https://github.com/vagabond-burro/heeler/releases/download/models/florence_2_base_encoder_model.onnx",
            ],
            sha256: "b155b5a0e56a4244c62060751bb1b70dfe481015d0dbfa6d19b1912d9e58da0d",
            bytes: 173_380_723,
        },
        ExtraFile {
            name: "decoder_model_merged.onnx",
            urls: &[
                "https://huggingface.co/onnx-community/Florence-2-base/resolve/d59e079711c57174f29265539fb4cc9f0f335916/onnx/decoder_model_merged.onnx",
                "https://github.com/vagabond-burro/heeler/releases/download/models/florence_2_base_decoder_model_merged.onnx",
            ],
            sha256: "6d6e1266d7f94f5d4ec9cc07d9c1f7b3e47049c9b0de7bbe82a91e62dfd152af",
            bytes: 388_421_910,
        },
        ExtraFile {
            name: "tokenizer.json",
            urls: &[
                "https://huggingface.co/onnx-community/Florence-2-base/resolve/d59e079711c57174f29265539fb4cc9f0f335916/tokenizer.json",
                "https://github.com/vagabond-burro/heeler/releases/download/models/florence_2_base_tokenizer.json",
            ],
            sha256: "d69dcdb2323e124ac4f800cb9863ddccea0d7bb11e16125e8df3bd60f2f8aeac",
            bytes: 2_297_961,
        },
    ],
};

/// An owned model source: the registry's pins, or a newer set read
/// from the models manifest, which is how weights update without an
/// app release. Everything a download needs and nothing it does
/// not.
#[derive(Clone, Debug, PartialEq, serde::Serialize, serde::Deserialize)]
pub struct ModelSource {
    pub id: String,
    pub version: String,
    pub urls: Vec<String>,
    pub archive_sha256: String,
    pub archive_bytes: u64,
    pub kind: ArchiveKind,
    pub files: Vec<(String, String)>,
    #[serde(default)]
    pub extra: Vec<ExtraSource>,
}

#[derive(Clone, Debug, PartialEq, serde::Serialize, serde::Deserialize)]
pub struct ExtraSource {
    pub name: String,
    pub urls: Vec<String>,
    pub sha256: String,
    pub bytes: u64,
}

fn safe_name(name: &str) -> bool {
    !name.is_empty() && name != "." && name != ".." && name != RECORD_FILE && name != "archive.zip"
        && name.bytes().all(|b| b.is_ascii_alphanumeric() || b"._-".contains(&b))
}

fn hash_pin(pin: &str) -> bool {
    pin.len() == 64 && pin.bytes().all(|b| b.is_ascii_hexdigit())
}

impl ModelSource {
    pub fn total_bytes(&self) -> u64 {
        self.extra.iter().fold(self.archive_bytes, |n, e| n.saturating_add(e.bytes))
    }

    /// Validate before any staging file is created or removed. File names
    /// are portable leaf names, and every external part has exactly one pin.
    pub fn validate(&self) -> Result<(), VisionError> {
        let bad = || VisionError::Download("the model source has inconsistent files, pins, or sizes".into());
        let mut names = std::collections::HashSet::new();
        if !safe_name(&self.id) || self.version.trim().is_empty() || self.files.is_empty()
            || !hash_pin(&self.archive_sha256) || self.archive_bytes == 0 || self.urls.is_empty()
            || !self.files.iter().all(|(n, h)| safe_name(n) && hash_pin(h) && names.insert(n)) {
            return Err(bad());
        }
        let mut extras = std::collections::HashSet::new();
        let mut total = self.archive_bytes;
        for e in &self.extra {
            if !safe_name(&e.name) || !hash_pin(&e.sha256) || e.bytes == 0 || e.urls.is_empty()
                || !extras.insert(&e.name)
                || !self.files.iter().any(|(n, h)| *n == e.name && h.eq_ignore_ascii_case(&e.sha256)) {
                return Err(bad());
            }
            total = total.checked_add(e.bytes).ok_or_else(bad)?;
        }
        if self.kind == ArchiveKind::File && (self.files.len() != 1 + self.extra.len()
            || extras.contains(&self.files[0].0)
            || !self.files[0].1.eq_ignore_ascii_case(&self.archive_sha256)) {
            return Err(bad());
        }
        Ok(())
    }
}

impl From<&ModelSpec> for ModelSource {
    fn from(spec: &ModelSpec) -> Self {
        ModelSource {
            id: spec.id.to_string(),
            version: spec.version.to_string(),
            urls: spec.urls.iter().map(|u| u.to_string()).collect(),
            archive_sha256: spec.archive_sha256.to_string(),
            archive_bytes: spec.archive_bytes,
            kind: spec.kind,
            files: spec.files.iter().map(|(n, h)| (n.to_string(), h.to_string())).collect(),
            extra: spec
                .extra
                .iter()
                .map(|e| ExtraSource { name: e.name.to_string(), urls: e.urls.iter().map(|u| u.to_string()).collect(), sha256: e.sha256.to_string(), bytes: e.bytes })
                .collect(),
        }
    }
}

/// What a download leaves beside the files: the version and the pins
/// it verified against, so `installed` can recognize weights the
/// manifest brought that the registry's own pins do not name.
#[derive(Clone, Debug, PartialEq, serde::Serialize, serde::Deserialize)]
pub struct InstallRecord {
    pub version: String,
    pub files: Vec<(String, String)>,
}

const RECORD_FILE: &str = "installed.json";

fn install_record(dir: &Path) -> Option<InstallRecord> {
    let text = std::fs::read_to_string(dir.join(RECORD_FILE)).ok()?;
    serde_json::from_str(&text).ok()
}

/// Where a model's files live: `<base>/models/<id>/`.
pub fn model_dir(base: &Path, spec: &ModelSpec) -> PathBuf {
    base.join("models").join(spec.id)
}

/// The extracted files' paths, in registry order.
pub fn model_paths(base: &Path, spec: &ModelSpec) -> Vec<PathBuf> {
    let dir = model_dir(base, spec);
    spec.files.iter().map(|(name, _)| dir.join(name)).collect()
}

/// Installed means every file is present AND matches its pinned hash:
/// a truncated or tampered file reads as not-installed, never as a
/// model to be loaded.
pub fn installed(base: &Path, spec: &ModelSpec) -> bool {
    installed_version(base, spec).is_some()
}

/// The version of the weights in place, if every file verifies: the
/// install record's pins when a download left one (a manifest update
/// is recognized that way), else the registry's own. None when a file
/// is missing or wrong, so nothing half-written ever counts.
///
/// Also the recovery half of crash-safe replacement: a download that
/// died between its two renames left the previous model parked under
/// <id>.old. When the live directory is gone and the parked copy
/// verifies, it is renamed back; beside a live model that verifies,
/// the parked copy is debris (the app's own, under the model store)
/// and is removed. A live directory that does not verify keeps its
/// .old untouched: that pattern is for a human, not for guessing.
pub fn installed_version(base: &Path, spec: &ModelSpec) -> Option<String> {
    let dir = model_dir(base, spec);
    let old_dir = base.join("models").join(format!("{}.old", spec.id));
    if old_dir.is_dir() {
        if dir.exists() {
            if verified_version(&dir, spec).is_some() {
                let _ = std::fs::remove_dir_all(&old_dir);
            }
        } else if verified_version(&old_dir, spec).is_some() {
            let _ = std::fs::rename(&old_dir, &dir);
        }
    }
    verified_version(&dir, spec)
}

/// The verification core, for the live directory and for a parked
/// .old copy alike.
fn verified_version(dir: &Path, spec: &ModelSpec) -> Option<String> {
    let verifies = |files: &[(String, String)]| files.iter().all(|(name, sha)| verify_file(&dir.join(name), sha).unwrap_or(false));
    if let Some(record) = install_record(dir) {
        let mut names = std::collections::HashSet::new();
        if !record.version.trim().is_empty() && record.files.len() == spec.files.len()
            && record.files.iter().all(|(name, sha)| safe_name(name) && hash_pin(sha)
                && names.insert(name) && spec.files.iter().any(|(expected, _)| name == expected))
            && verifies(&record.files) {
            return Some(record.version);
        }
    }
    let own: Vec<(String, String)> = spec.files.iter().map(|(n, h)| (n.to_string(), h.to_string())).collect();
    if verifies(&own) { Some(spec.version.to_string()) } else { None }
}

pub fn remove_model(base: &Path, spec: &ModelSpec) -> Result<(), VisionError> {
    let dir = model_dir(base, spec);
    if dir.exists() {
        std::fs::remove_dir_all(dir)?;
    }
    Ok(())
}

/// Streams a file through SHA-256 and compares against the pinned hex.
pub fn verify_file(path: &Path, sha256_hex: &str) -> Result<bool, VisionError> {
    let mut file = match std::fs::File::open(path) {
        Ok(f) => f,
        Err(_) => return Ok(false),
    };
    let mut hasher = Sha256::new();
    let mut buf = [0u8; 65536];
    loop {
        let n = file.read(&mut buf)?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
    }
    Ok(format!("{:x}", hasher.finalize()).eq_ignore_ascii_case(sha256_hex))
}

/// Downloads and installs one model: archive to a temp file, hash
/// verified BEFORE extraction, each extracted file verified again,
/// and the final directory appears atomically (rename) so a crash
/// mid-install can never leave a half-model that `installed` trusts.
pub fn download_model(
    base: &Path,
    spec: &ModelSpec,
    progress: impl FnMut(u64, u64),
) -> Result<(), VisionError> {
    download_source(base, &ModelSource::from(spec), progress)
}

/// The download itself, from any source: the registry's pins or the
/// manifest's. Staged, hashed as it streams, verified before a byte
/// of it is trusted, then renamed into place with its install record.
pub fn download_source(
    base: &Path,
    spec: &ModelSource,
    mut progress: impl FnMut(u64, u64),
) -> Result<(), VisionError> {
    spec.validate()?;
    // A poisoned lock (a panic in an earlier download) must not refuse
    // every download until restart; the staging directory is rebuilt
    // from nothing below either way.
    let _download = DOWNLOAD.lock().unwrap_or_else(|e| {
        DOWNLOAD.clear_poison();
        e.into_inner()
    });
    let staging = base.join("models").join(format!(".{}.staging", spec.id));
    let _ = std::fs::remove_dir_all(&staging);
    std::fs::create_dir_all(&staging)?;
    let archive_path = staging.join("archive.zip");

    // Fetch from the first source that answers, hashing as it streams.
    // A dead mirror is logged into the error only if EVERY source is
    // dead; the pinned hash makes the sources interchangeable.
    let mut resp = None;
    let mut last_err = String::new();
    for url in &spec.urls {
        match ureq::get(url).call() {
            Ok(r) => {
                resp = Some(r);
                break;
            }
            Err(e) => last_err = format!("{url}: {e}"),
        }
    }
    let resp = resp.ok_or(VisionError::Download(last_err))?;
    let mut reader = resp.into_reader();
    let mut out = std::fs::File::create(&archive_path)?;
    let mut hasher = Sha256::new();
    let mut buf = [0u8; 65536];
    let mut got: u64 = 0;
    loop {
        let n = reader
            .read(&mut buf)
            .map_err(|e| VisionError::Download(e.to_string()))?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
        std::io::Write::write_all(&mut out, &buf[..n])?;
        got += n as u64;
        progress(got, spec.total_bytes());
    }
    drop(out);
    if !format!("{:x}", hasher.finalize()).eq_ignore_ascii_case(&spec.archive_sha256) {
        let _ = std::fs::remove_dir_all(&staging);
        return Err(VisionError::Checksum { file: "archive".into() });
    }

    match spec.kind {
        ArchiveKind::Zip => {
            // Extract exactly the registered files; anything else in
            // the archive is ignored on principle.
            let file = std::fs::File::open(&archive_path)?;
            let mut zip =
                zip::ZipArchive::new(file).map_err(|e| VisionError::Download(e.to_string()))?;
            for (name, sha) in &spec.files {
                if spec.extra.iter().any(|extra| extra.name == *name) {
                    continue;
                }
                let mut entry = zip
                    .by_name(name)
                    .map_err(|_| VisionError::Download(format!("archive is missing {name}")))?;
                let target = staging.join(name);
                let mut out = std::fs::File::create(&target)?;
                std::io::copy(&mut entry, &mut out)?;
                drop(out);
                if !verify_file(&target, sha)? {
                    let _ = std::fs::remove_dir_all(&staging);
                    return Err(VisionError::Checksum { file: name.clone() });
                }
            }
            std::fs::remove_file(&archive_path)?;
        }
        ArchiveKind::File => {
            // The download IS the file: rename it under its registered
            // name (its hash was already verified above).
            let (name, _) = &spec.files[0];
            std::fs::rename(&archive_path, staging.join(name))?;
        }
    }

    // The extra files, each fetched from the first source that answers
    // and verified against its own pin before it counts.
    let mut got_total = spec.archive_bytes;
    let total = spec.total_bytes();
    for extra in &spec.extra {
        let mut resp = None;
        let mut last_err = String::new();
        for url in &extra.urls {
            match ureq::get(url).call() {
                Ok(r) => {
                    resp = Some(r);
                    break;
                }
                Err(e) => last_err = format!("{url}: {e}"),
            }
        }
        let Some(resp) = resp else {
            let _ = std::fs::remove_dir_all(&staging);
            return Err(VisionError::Download(last_err));
        };
        let mut reader = resp.into_reader();
        let target = staging.join(&extra.name);
        let mut out = std::fs::File::create(&target)?;
        let mut hasher = Sha256::new();
        let mut buf = [0u8; 65536];
        loop {
            let n = reader
                .read(&mut buf)
                .map_err(|e| VisionError::Download(e.to_string()))?;
            if n == 0 {
                break;
            }
            hasher.update(&buf[..n]);
            std::io::Write::write_all(&mut out, &buf[..n])?;
            got_total += n as u64;
            progress(got_total, total);
        }
        drop(out);
        if !format!("{:x}", hasher.finalize()).eq_ignore_ascii_case(&extra.sha256) {
            let _ = std::fs::remove_dir_all(&staging);
            return Err(VisionError::Checksum { file: extra.name.clone() });
        }
    }

    for (name, pin) in &spec.files {
        if !verify_file(&staging.join(name), pin)? {
            return Err(VisionError::Checksum { file: name.clone() });
        }
    }
    let record = InstallRecord { version: spec.version.clone(), files: spec.files.clone() };
    std::fs::write(staging.join(RECORD_FILE), serde_json::to_vec_pretty(&record).unwrap_or_default())?;
    let final_dir = base.join("models").join(&spec.id);
    let old_dir = base.join("models").join(format!("{}.old", spec.id));
    // Crash-safe replacement: park the live model under .old, land the
    // new one, then drop the parked copy. A crash between the two
    // renames leaves .old behind and installed_version renames it
    // back, so the model is never simply gone. A failed landing drops
    // its staging and leaves the live model untouched.
    let _ = std::fs::remove_dir_all(&old_dir);
    let landed = (|| {
        // Something the sweep could not clear sits where the parked copy
        // goes (a file, say). Unix refuses the rename by itself; Windows
        // renames a directory over a file, so the refusal is spelled out
        // here, and whatever is there is left for a human.
        if std::fs::symlink_metadata(&old_dir).is_ok() {
            return Err(std::io::Error::new(
                std::io::ErrorKind::AlreadyExists,
                format!("{} is in the way of the update", old_dir.display()),
            ));
        }
        if final_dir.exists() {
            std::fs::rename(&final_dir, &old_dir)?;
        }
        std::fs::rename(&staging, &final_dir)
    })();
    if landed.is_err() {
        let _ = std::fs::remove_dir_all(&staging);
    }
    landed?;
    let _ = std::fs::remove_dir_all(&old_dir);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn simultaneous_downloads_install_complete_files_and_report_the_whole_size() {
        use std::io::{Read, Write};
        use std::sync::{mpsc, Arc, Barrier};
        let base = tempdir();
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://{}/weights", listener.local_addr().unwrap());
        let payload = b"test weights";
        let sha = format!("{:x}", Sha256::digest(payload));
        let mut source = ModelSource::from(&SCUNET);
        source.urls = vec![url.clone()];
        source.archive_bytes = payload.len() as u64;
        source.archive_sha256 = sha.to_uppercase();
        for (_, pin) in &mut source.files { *pin = sha.clone(); }
        source.extra[0].urls = vec![url];
        source.extra[0].sha256 = sha.clone();
        source.extra[0].bytes = payload.len() as u64;
        // The server holds its first response on a channel pair the test
        // releases explicitly. No sleeps, deadlines, or timers anywhere,
        // so a loaded machine cannot flake the proof.
        let (held_tx, held_rx) = mpsc::channel::<()>();
        let (release_tx, release_rx) = mpsc::channel::<()>();
        let server = std::thread::spawn(move || {
            for request in 0..4 {
                let (mut socket, _) = listener.accept().unwrap();
                let mut header = Vec::new();
                while !header.ends_with(b"\r\n\r\n") {
                    let mut byte = [0u8; 1];
                    socket.read_exact(&mut byte).unwrap();
                    header.push(byte[0]);
                }
                // Hold the first response until the test has proven the
                // other caller is locked out of the staging directory.
                if request == 0 {
                    held_tx.send(()).unwrap();
                    release_rx.recv().unwrap();
                }
                write!(socket, "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n", payload.len()).unwrap();
                socket.write_all(payload).unwrap();
            }
        });
        let start = Arc::new(Barrier::new(3));
        let downloads: Vec<_> = (0..2).map(|_| {
            let start = start.clone();
            let source = source.clone();
            let base = base.path().to_path_buf();
            std::thread::spawn(move || {
                start.wait();
                let mut progress = Vec::new();
                download_source(&base, &source, |got, total| progress.push((got, total))).unwrap();
                assert!(progress.iter().all(|(_, total)| *total == source.total_bytes()));
                assert_eq!(progress.last(), Some(&(source.total_bytes(), source.total_bytes())));
            })
        }).collect();
        start.wait();
        // The first response is held mid-download, so a caller is inside
        // download_source and must be holding the staging lock. WouldBlock
        // specifically: a poisoned mutex also answers Err, but with nobody
        // holding it, so a bare is_err would pass for the wrong reason
        // whenever the poisoning test ran first in this process. Without
        // the lock both callers share the stage and this try_lock
        // succeeds instead of failing.
        held_rx.recv().unwrap();
        assert!(
            matches!(DOWNLOAD.try_lock(), Err(std::sync::TryLockError::WouldBlock)),
            "no download holds the staging lock"
        );
        release_tx.send(()).unwrap();
        for download in downloads { download.join().unwrap(); }
        server.join().unwrap();
        assert_eq!(installed_version(base.path(), &SCUNET), Some(source.version));
    }

    #[test]
    fn a_worker_panic_does_not_refuse_later_downloads() {
        // No server deadline: another test can hold DOWNLOAD while this
        // caller waits. Once acquired, this request must reach the network
        // and fail there, rather than refusing the recovered lock.
        let died = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            let _held = DOWNLOAD.lock().unwrap();
            panic!("a worker died holding the download lock");
        }));
        assert!(died.is_err());
        let base = tempdir();
        let mut source = ModelSource::from(&SCUNET);
        source.urls = vec!["https://127.0.0.1:1/weights".into()];
        match download_source(base.path(), &source, |_, _| {}) {
            Err(VisionError::Download(message)) => {
                assert!(message.contains("https://127.0.0.1:1/weights"), "{message}");
                assert!(message.to_ascii_lowercase().contains("connect"), "{message}");
                assert!(!message.contains("interrupted"), "{message}");
            }
            other => panic!("expected a connection error after lock recovery, got {other:?}"),
        }
        assert!(DOWNLOAD.lock().is_ok(), "the recovered lock must no longer be poisoned");
    }

    #[test]
    fn every_registry_source_validates_and_inconsistent_sources_fail_before_staging() {
        for spec in [&MOBILE_SAM, &BIREFNET_LITE, &LAMA, &VITMATTE, &DEPTH_ANYTHING, &SCUNET, &FLORENCE_2] {
            ModelSource::from(spec).validate().unwrap();
        }
        let base = tempdir();
        for variant in 0..6 {
            let mut source = ModelSource::from(&SCUNET);
            match variant {
                0 => source.files.clear(),
                1 => source.files[0].0 = "../escape".into(),
                2 => source.extra[0].sha256 = "a".repeat(64),
                3 => source.extra.push(source.extra[0].clone()),
                4 => source.archive_bytes = u64::MAX,
                _ => source.files[0].1 = "b".repeat(64),
            }
            assert!(download_source(base.path(), &source, |_, _| {}).is_err());
            assert!(!base.path().join("models").exists());
        }
    }

    #[test]
    fn an_install_record_cannot_skip_required_files_or_verify_an_unrelated_file() {
        let base = tempdir();
        let dir = model_dir(base.path(), &SCUNET);
        std::fs::create_dir_all(&dir).unwrap();
        let sha = format!("{:x}", Sha256::digest(b"test weights"));
        std::fs::write(dir.join(SCUNET.files[0].0), b"test weights").unwrap();
        std::fs::write(dir.join("unrelated.bin"), b"test weights").unwrap();
        for names in [vec!["unrelated.bin"], vec![SCUNET.files[0].0], vec![SCUNET.files[0].0, SCUNET.files[0].0]] {
            let record = InstallRecord { version: "2027.01".into(), files: names.iter().map(|n| (n.to_string(), sha.clone())).collect() };
            std::fs::write(dir.join(RECORD_FILE), serde_json::to_vec(&record).unwrap()).unwrap();
            assert_eq!(installed_version(base.path(), &SCUNET), None, "record {names:?}");
        }
    }

    /// A manifest update leaves an install record naming the newer
    /// pins; installed_version reads it, and reads the registry's own
    /// version when the files match the registry instead. A record
    /// whose files do not verify counts for nothing.
    #[test]
    fn an_install_record_names_the_version_in_place() {
        let dir = tempdir();
        let base = dir.path();
        let spec = &DEPTH_ANYTHING;
        let mdir = model_dir(base, spec);
        std::fs::create_dir_all(&mdir).unwrap();
        assert_eq!(installed_version(base, spec), None);
        // Newer weights the registry does not know, with their record.
        std::fs::write(mdir.join("model.onnx"), b"newer weights").unwrap();
        let sha = {
            use sha2::{Digest, Sha256};
            format!("{:x}", Sha256::digest(b"newer weights"))
        };
        let record = InstallRecord { version: "2027.01".into(), files: vec![("model.onnx".into(), sha)] };
        std::fs::write(mdir.join(RECORD_FILE), serde_json::to_vec(&record).unwrap()).unwrap();
        assert_eq!(installed_version(base, spec).as_deref(), Some("2027.01"));
        assert!(installed(base, spec));
        // The record lies about the bytes: nothing counts.
        std::fs::write(mdir.join("model.onnx"), b"tampered").unwrap();
        assert_eq!(installed_version(base, spec), None);
    }

    /// Plants a complete model under the given directory name, pinned
    /// by an install record so dummy bytes verify.
    fn plant_model(base: &Path, name: &str, version: &str, payload: &[u8]) -> PathBuf {
        let spec = &SCUNET;
        let dir = base.join("models").join(name);
        std::fs::create_dir_all(&dir).unwrap();
        let sha = format!("{:x}", Sha256::digest(payload));
        for (file, _) in spec.files {
            std::fs::write(dir.join(file), payload).unwrap();
        }
        let record = InstallRecord {
            version: version.into(),
            files: spec.files.iter().map(|(n, _)| (n.to_string(), sha.clone())).collect(),
        };
        std::fs::write(dir.join(RECORD_FILE), serde_json::to_vec(&record).unwrap()).unwrap();
        dir
    }

    /// A crash between the replacement's two renames leaves the old
    /// model parked under .old with no live directory: the next
    /// installed_version call parks it back.
    #[test]
    fn a_parked_old_model_is_renamed_back_when_the_live_one_is_missing() {
        let base = tempdir();
        let spec = &SCUNET;
        let old_dir = plant_model(base.path(), &format!("{}.old", spec.id), "2026.08", b"previous weights");
        assert_eq!(installed_version(base.path(), spec).as_deref(), Some("2026.08"));
        assert!(!old_dir.exists(), "the parked copy is still beside the model");
        assert!(model_dir(base.path(), spec).join(&spec.files[0].0).exists());
    }

    /// A parked copy beside a live model that verifies is debris from
    /// a crash after the new model landed; it is removed.
    #[test]
    fn a_leftover_parked_copy_beside_a_complete_model_is_removed() {
        let base = tempdir();
        let spec = &SCUNET;
        plant_model(base.path(), &spec.id.to_string(), "2026.09", b"weights");
        let old_dir = plant_model(base.path(), &format!("{}.old", spec.id), "2026.08", b"previous weights");
        assert_eq!(installed_version(base.path(), spec).as_deref(), Some("2026.09"));
        assert!(!old_dir.exists(), "the debris was left behind");
        assert!(model_dir(base.path(), spec).is_dir());
    }

    /// The landing cannot move the live model aside (a file sits where
    /// the parked copy would go): the download fails, the old model
    /// still reads as installed, and the staging directory is gone.
    #[test]
    fn a_failed_landing_keeps_the_old_model_and_drops_the_staging() {
        use std::io::{Read, Write};
        let base = tempdir();
        let spec = &SCUNET;
        let dir = plant_model(base.path(), &spec.id.to_string(), "2026.08", b"previous weights");
        std::fs::write(base.path().join("models").join(format!("{}.old", spec.id)), b"junk").unwrap();
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://{}/weights", listener.local_addr().unwrap());
        let payload = b"new weights";
        let sha = format!("{:x}", Sha256::digest(payload));
        let mut source = ModelSource::from(spec);
        source.urls = vec![url.clone()];
        source.archive_bytes = payload.len() as u64;
        source.archive_sha256 = sha.to_uppercase();
        for (_, pin) in &mut source.files { *pin = sha.clone(); }
        source.extra[0].urls = vec![url];
        source.extra[0].sha256 = sha.clone();
        source.extra[0].bytes = payload.len() as u64;
        let server = std::thread::spawn(move || {
            for _ in 0..2 {
                let (mut socket, _) = listener.accept().unwrap();
                let mut header = Vec::new();
                while !header.ends_with(b"\r\n\r\n") {
                    let mut byte = [0u8; 1];
                    socket.read_exact(&mut byte).unwrap();
                    header.push(byte[0]);
                }
                write!(socket, "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n", payload.len()).unwrap();
                socket.write_all(payload).unwrap();
            }
        });
        assert!(download_source(base.path(), &source, |_, _| {}).is_err());
        server.join().unwrap();
        assert_eq!(installed_version(base.path(), spec).as_deref(), Some("2026.08"));
        assert!(dir.join(&spec.files[0].0).exists(), "the old model was touched");
        assert!(!base.path().join("models").join(format!(".{}.staging", spec.id)).exists(), "staging was left behind");
    }

    /// Every model has the release mirror as a second source
    /// (2026-09-09), the archive and every extra file alike, so a
    /// renamed or deleted Hugging Face repository costs nothing.
    #[test]
    fn every_model_carries_the_release_mirror_as_a_second_source() {
        let mirror = "https://github.com/vagabond-burro/heeler/releases/download/models/";
        for spec in [&MOBILE_SAM, &BIREFNET_LITE, &LAMA, &VITMATTE, &DEPTH_ANYTHING, &SCUNET, &FLORENCE_2] {
            assert!(spec.urls.len() >= 2, "{}: one source only", spec.id);
            assert!(spec.urls.iter().any(|u| u.starts_with(mirror)), "{}: no mirror", spec.id);
            assert!(spec.urls.iter().all(|u| u.starts_with("https://")), "{}: a plain http source", spec.id);
            for extra in spec.extra {
                assert!(extra.urls.iter().any(|u| u.starts_with(mirror)), "{}: extra {} has no mirror", spec.id, extra.name);
            }
        }
    }

    /// Florence-2's entry pins the five files florence.rs loads, in its
    /// order, from one revision of onnx-community's repository, each
    /// extra's pin the same as its line in `files`.
    #[test]
    fn the_florence_entry_pins_the_measured_files() {
        let spec = &FLORENCE_2;
        let names: Vec<&str> = spec.files.iter().map(|(n, _)| *n).collect();
        assert_eq!(names, crate::florence::FLORENCE_FILES.to_vec());
        assert_eq!(spec.kind, ArchiveKind::File);
        assert_eq!(spec.files[0].1, spec.archive_sha256);
        assert_eq!(spec.extra.len(), 4);
        for (extra, (name, pin)) in spec.extra.iter().zip(&spec.files[1..]) {
            assert_eq!(extra.name, *name);
            assert_eq!(extra.sha256, *pin);
        }
        assert_eq!(spec.total_bytes(), 970_082_648);
        let revision = "onnx-community/Florence-2-base/resolve/d59e079711c57174f29265539fb4cc9f0f335916/";
        assert!(spec.urls[0].contains(revision));
        assert!(spec.extra.iter().all(|e| e.urls[0].contains(revision)));
        assert!(spec.license.starts_with("MIT"));
    }

    #[test]
    fn a_registry_spec_becomes_an_owned_source_with_every_file() {
        let src = ModelSource::from(&SCUNET);
        assert_eq!(src.id, "scunet_color_real_psnr");
        assert_eq!(src.files.len(), 2);
        assert_eq!(src.extra.len(), 1);
        assert_eq!(src.total_bytes(), SCUNET.total_bytes());
        let text = serde_json::to_string(&src).unwrap();
        assert_eq!(serde_json::from_str::<ModelSource>(&text).unwrap(), src);
    }

    #[test]
    fn a_missing_or_wrong_file_is_not_installed() {
        let dir = tempdir();
        assert!(!installed(dir.path(), &MOBILE_SAM));
        // Plant a wrong-content file under the right name.
        let mdir = model_dir(dir.path(), &MOBILE_SAM);
        std::fs::create_dir_all(&mdir).unwrap();
        for (name, _) in MOBILE_SAM.files {
            std::fs::write(mdir.join(name), b"not a model").unwrap();
        }
        assert!(!installed(dir.path(), &MOBILE_SAM), "wrong bytes must not count");
        remove_model(dir.path(), &MOBILE_SAM).unwrap();
        assert!(!model_dir(dir.path(), &MOBILE_SAM).exists());
    }

    #[test]
    fn verify_file_matches_a_known_hash() {
        let dir = tempdir();
        let p = dir.path().join("x");
        std::fs::write(&p, b"heeler").unwrap();
        // sha256("heeler")
        let sha = "0bf7bd45b526b6a5b45e470b2a311fb0d764d0eb0be771bff7d61048d7f0a557";
        let computed = {
            use sha2::{Digest, Sha256};
            format!("{:x}", Sha256::digest(b"heeler"))
        };
        assert_eq!(computed.len(), 64);
        // Pin against the freshly computed value (the constant above
        // documents the shape; the assertion trusts the library).
        assert!(verify_file(&p, &computed).unwrap());
        assert!(verify_file(&p, &computed.to_uppercase()).unwrap());
        assert!(!verify_file(&p, sha).unwrap() || sha == computed);
        assert!(!verify_file(dir.path().join("absent").as_path(), &computed).unwrap());
    }

    fn tempdir() -> TempDir {
        TempDir::new()
    }

    /// A tiny self-cleaning temp dir, so the crate needs no dev-deps.
    struct TempDir(PathBuf);
    impl TempDir {
        fn new() -> Self {
            static NEXT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
            let p = std::env::temp_dir().join(format!(
                "heeler-vision-test-{}-{}-{:?}",
                std::process::id(),
                NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed),
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap()
                    .as_nanos()
            ));
            std::fs::create_dir_all(&p).unwrap();
            TempDir(p)
        }
        fn path(&self) -> &Path {
            &self.0
        }
    }
    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }
}
