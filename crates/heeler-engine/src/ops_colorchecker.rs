//! Color Checker calibration: chart reference data and the fit that turns
//! a photographed chart into a white balance, an exposure, and a 3x3
//! matrix (Phase 11 of the 26.3 plan).
//!
//! The working space is scene-linear Rec.709 D65. Published chart values
//! are CIE Lab D50, so the reference path is Lab -> XYZ D50 -> Bradford
//! adaptation to D65 -> linear Rec.709, mirroring heeler-io's
//! `input_color.rs` (`bradford`, `D50_TO_D65`, the working space XYZ
//! matrix). It is reimplemented here because heeler-io depends on this
//! crate; the reverse dependency exists only as a dev-dependency for
//! tests, so production engine code cannot call into it.
//!
//! Chart data lives in `data/charts/*.json` with the source of the values
//! cited inside each file. Built-in charts load with `include_str!`;
//! custom charts (user-built, stored under the presets base) parse from
//! the same format through `chart_from_json`.

use std::sync::Arc;

use heeler_graph::Node;
use serde::{Deserialize, Serialize};

use crate::buffers::Value;
use crate::executor::EngineError;
use crate::ops::{image_input, map_rgb, p, wb_gains};

// ---------------------------------------------------------------------------
// Chart data

#[derive(Debug, Deserialize)]
struct ChartFile {
    id: String,
    name: String,
    rows: usize,
    cols: usize,
    source: String,
    #[serde(default)]
    alias: Option<String>,
    #[serde(default)]
    neutrals: Option<Vec<usize>>,
    #[serde(default)]
    skin: Option<Vec<usize>>,
    #[serde(default)]
    patches: Option<Vec<PatchFile>>,
}

#[derive(Debug, Deserialize)]
struct PatchFile {
    name: String,
    /// None for a control with no published value: the overlay still
    /// draws it and the sampler still reads it, but the fit ignores it.
    /// Custom charts use this for the cells the user left untargeted.
    #[serde(default)]
    lab: Option<[f64; 3]>,
}

/// One chart patch: its display name, published Lab D50 value, and that
/// value converted to the working space. `target` is false for a control
/// with no published value; its `lab`/`linear` are zero and unused.
#[derive(Clone, Debug)]
pub struct ChartPatch {
    pub name: String,
    pub lab: [f64; 3],
    pub linear: [f64; 3],
    pub target: bool,
}

/// A resolved chart: grid dimensions, patch list in row-major order, and
/// the indices of the neutral and skin-tone patches the fit leans on.
#[derive(Clone, Debug)]
pub struct Chart {
    pub id: String,
    pub name: String,
    pub rows: usize,
    pub cols: usize,
    pub source: String,
    pub neutrals: Vec<usize>,
    pub skin: Vec<usize>,
    pub patches: Vec<ChartPatch>,
}

const CHART_FILES: &[(&str, &str)] = &[
    ("colorchecker-classic", include_str!("../data/charts/colorchecker-classic.json")),
    ("colorchecker-classic-pre-2014", include_str!("../data/charts/colorchecker-classic-pre-2014.json")),
    ("colorchecker-passport", include_str!("../data/charts/colorchecker-passport.json")),
    ("colorchecker-passport-pre-2014", include_str!("../data/charts/colorchecker-passport-pre-2014.json")),
    ("colorchecker-sg", include_str!("../data/charts/colorchecker-sg.json")),
    ("spydercheckr-24", include_str!("../data/charts/spydercheckr-24.json")),
    ("spydercheckr-48", include_str!("../data/charts/spydercheckr-48.json")),
];

/// Parse a chart file. Alias files (the Passport shares the Classic's
/// published values) resolve against the built-ins.
pub fn chart_from_json(raw: &str) -> Result<Chart, String> {
    let file: ChartFile = serde_json::from_str(raw).map_err(|e| format!("chart file does not parse: {e}"))?;
    if let Some(target) = &file.alias {
        let mut chart = builtin_chart(target).ok_or_else(|| format!("chart aliases unknown chart {target}"))?;
        chart.id = file.id;
        chart.name = file.name;
        chart.source = file.source;
        return Ok(chart);
    }
    let patches = file.patches.ok_or("chart file has no patches")?;
    if patches.len() != file.rows * file.cols {
        return Err(format!(
            "chart {} has {} patches for a {}x{} grid",
            file.id,
            patches.len(),
            file.rows,
            file.cols
        ));
    }
    let patches: Vec<ChartPatch> = patches
        .into_iter()
        .map(|p| {
            let target = p.lab.is_some();
            let lab = p.lab.unwrap_or([0.0; 3]);
            ChartPatch {
                linear: if target { lab_d50_to_working(lab) } else { [0.0; 3] },
                name: p.name,
                lab,
                target,
            }
        })
        .collect();
    // A neutral or skin index that names a missing or targetless patch
    // would lean the fit on nothing; drop it at the door.
    let roles = |idx: Option<Vec<usize>>| -> Vec<usize> {
        idx.unwrap_or_default()
            .into_iter()
            .filter(|&i| i < patches.len() && patches[i].target)
            .collect()
    };
    Ok(Chart {
        id: file.id,
        name: file.name,
        rows: file.rows,
        cols: file.cols,
        source: file.source,
        neutrals: roles(file.neutrals),
        skin: roles(file.skin),
        patches,
    })
}

pub fn builtin_chart(id: &str) -> Option<Chart> {
    let (_, raw) = CHART_FILES.iter().find(|(cid, _)| *cid == id)?;
    chart_from_json(raw).ok()
}

/// Every built-in chart, aliases included (Classic and Passport each list
/// both formulations).
pub fn builtin_charts() -> Vec<Chart> {
    CHART_FILES.iter().filter_map(|(id, _)| builtin_chart(id)).collect()
}

/// A chart flattened for the desktop's `chart_defs` answer: patch values
/// sRGB-encoded and clipped to display range, so the overlay can tint each
/// swatch with the reference color without carrying the color science.
#[derive(Clone, Debug, Serialize)]
pub struct ChartDef {
    pub id: String,
    pub name: String,
    pub rows: usize,
    pub cols: usize,
    pub neutrals: Vec<usize>,
    pub skin: Vec<usize>,
    pub patches: Vec<PatchDef>,
}

#[derive(Clone, Debug, Serialize)]
pub struct PatchDef {
    pub name: String,
    pub rgb: [f32; 3],
    /// False for a control with no target: the overlay draws it hollow
    /// and the editor shows it as untargeted.
    pub target: bool,
}

/// Linear to sRGB display encoding, the inverse of input_color's decode.
fn srgb_encode(c: f64) -> f32 {
    let c = c.clamp(0.0, 1.0);
    (if c <= 0.0031308 { 12.92 * c } else { 1.055 * c.powf(1.0 / 2.4) - 0.055 }) as f32
}

impl Chart {
    pub fn def(&self) -> ChartDef {
        ChartDef {
            id: self.id.clone(),
            name: self.name.clone(),
            rows: self.rows,
            cols: self.cols,
            neutrals: self.neutrals.clone(),
            skin: self.skin.clone(),
            patches: self
                .patches
                .iter()
                .map(|p| PatchDef {
                    name: p.name.clone(),
                    // A targetless control gets a quiet gray: the overlay
                    // keys its hollow look off `target`, not this color.
                    rgb: if p.target { p.linear.map(srgb_encode) } else { [srgb_encode(0.18); 3] },
                    target: p.target,
                })
                .collect(),
        }
    }
}

/// Every built-in chart as a frontend def. Custom charts merge into this
/// answer on the desktop side (Phase 11's custom charts).
pub fn chart_defs() -> Vec<ChartDef> {
    builtin_charts().iter().map(Chart::def).collect()
}

/// The raw JSON of a built-in chart, for the export door: a built-in has
/// no file on disk, so its shipping text is the file.
pub fn builtin_chart_json(id: &str) -> Option<&'static str> {
    CHART_FILES.iter().find(|(cid, _)| *cid == id).map(|(_, raw)| *raw)
}

/// One entry of the custom-chart editor's target palette: a named color
/// with its Lab D50 value (the chart file's own space) computed here, so
/// the editor never ports the color science, and an sRGB-encoded display
/// color for the chip.
#[derive(Clone, Debug, Serialize)]
pub struct PaletteTarget {
    pub key: String,
    pub name: String,
    pub lab: [f64; 3],
    pub rgb: [f32; 3],
    /// Gray entries: the fit's white balance leans on these, and the
    /// editor marks a control carrying one as a neutral in the chart file.
    pub neutral: bool,
    /// The chart the entry came from, for the editor's grouping.
    pub chart: String,
}

/// The custom-chart target palette: every patch of every built-in chart,
/// the Classic's 24 first, then the SG's and the SpyderCheckrs' new
/// names, deduplicated by name. The Passport and the pre-2014 files share
/// the Classic's names and the SpyderCheckrs' cell addresses the SG's, so
/// those charts contribute nothing. Each entry carries its chart's own
/// published Lab and the chart's name, so the editor can group by source.
pub fn palette_targets() -> Vec<PaletteTarget> {
    let mut seen = std::collections::HashSet::new();
    let mut out = Vec::new();
    for chart in builtin_charts() {
        for (i, p) in chart.patches.iter().enumerate() {
            if !p.target || !seen.insert(p.name.clone()) {
                continue;
            }
            out.push(PaletteTarget {
                key: palette_key(&p.name),
                name: p.name.clone(),
                lab: p.lab,
                rgb: p.linear.map(srgb_encode),
                neutral: chart.neutrals.contains(&i),
                chart: chart.name.clone(),
            });
        }
    }
    out
}

/// A palette key from a patch name: lowercase, every punctuation run one
/// dash ("neutral 6.5 (.44 D)" is "neutral-6-5-44-d").
fn palette_key(name: &str) -> String {
    let mut key = String::new();
    let mut dashed = true; // no leading dash
    for c in name.chars() {
        if c.is_ascii_alphanumeric() {
            key.push(c.to_ascii_lowercase());
            dashed = false;
        } else if !dashed {
            key.push('-');
            dashed = true;
        }
    }
    while key.ends_with('-') {
        key.pop();
    }
    key
}

// ---------------------------------------------------------------------------
// Color conversions (mirror of heeler-io input_color.rs)

type Mat3 = [[f64; 3]; 3];

/// ICC D50 white, Y = 1.
const D50: [f64; 3] = [0.9642, 1.0, 0.8251];
/// Bradford D50 to D65, the same constants input_color.rs uses.
const D50_TO_D65: Mat3 = [
    [0.9555766, -0.0230393, 0.0631636],
    [-0.0282895, 1.0099416, 0.0210077],
    [0.0122982, -0.0204830, 1.3299098],
];
/// XYZ D65 to linear Rec.709 (the working space), from input_color.rs's
/// WORKING_SPACE.
const XYZ_D65_TO_RGB: Mat3 = [
    [3.2404542, -1.5371385, -0.4985314],
    [-0.9692660, 1.8760108, 0.0415560],
    [0.0556434, -0.2040259, 1.0572252],
];

fn mat_mul(m: Mat3, v: [f64; 3]) -> [f64; 3] {
    m.map(|r| r[0] * v[0] + r[1] * v[1] + r[2] * v[2])
}

fn mat_invert(m: Mat3) -> Mat3 {
    let det = m[0][0] * (m[1][1] * m[2][2] - m[1][2] * m[2][1])
        - m[0][1] * (m[1][0] * m[2][2] - m[1][2] * m[2][0])
        + m[0][2] * (m[1][0] * m[2][1] - m[1][1] * m[2][0]);
    let mut out = [[0.0; 3]; 3];
    for i in 0..3 {
        for j in 0..3 {
            let (a, b) = ((i + 1) % 3, (i + 2) % 3);
            let (c, d) = ((j + 1) % 3, (j + 2) % 3);
            out[j][i] = (m[a][c] * m[b][d] - m[a][d] * m[b][c]) / det;
        }
    }
    out
}

fn rgb_to_xyz_d65() -> Mat3 {
    mat_invert(XYZ_D65_TO_RGB)
}

fn d65_to_d50() -> Mat3 {
    mat_invert(D50_TO_D65)
}

fn lab_to_xyz_d50(lab: [f64; 3]) -> [f64; 3] {
    let fy = (lab[0] + 16.0) / 116.0;
    let fx = fy + lab[1] / 500.0;
    let fz = fy - lab[2] / 200.0;
    let finv = |f: f64| {
        let d = 6.0 / 29.0;
        if f > d {
            f * f * f
        } else {
            3.0 * d * d * (f - 4.0 / 29.0)
        }
    };
    [D50[0] * finv(fx), D50[1] * finv(fy), D50[2] * finv(fz)]
}

fn xyz_to_lab_d50(xyz: [f64; 3]) -> [f64; 3] {
    let d = 6.0 / 29.0;
    let f = |t: f64| {
        let t = t.max(0.0);
        if t > d * d * d {
            t.cbrt()
        } else {
            t / (3.0 * d * d) + 4.0 / 29.0
        }
    };
    let (fx, fy, fz) = (f(xyz[0] / D50[0]), f(xyz[1] / D50[1]), f(xyz[2] / D50[2]));
    [116.0 * fy - 16.0, 500.0 * (fx - fy), 200.0 * (fy - fz)]
}

/// Published chart value (CIE Lab, D50) to scene-linear working space.
pub fn lab_d50_to_working(lab: [f64; 3]) -> [f64; 3] {
    mat_mul(XYZ_D65_TO_RGB, mat_mul(D50_TO_D65, lab_to_xyz_d50(lab)))
}

/// Working space back to Lab D50, for the per-patch residuals in the
/// report.
pub fn working_to_lab_d50(rgb: [f64; 3]) -> [f64; 3] {
    xyz_to_lab_d50(mat_mul(d65_to_d50(), mat_mul(rgb_to_xyz_d65(), rgb)))
}

/// CIEDE2000, the Sharma et al. (2005) formula with kL = kC = kH = 1.
pub fn ciede2000(lab1: [f64; 3], lab2: [f64; 3]) -> f64 {
    let (l1, a1, b1) = (lab1[0], lab1[1], lab1[2]);
    let (l2, a2, b2) = (lab2[0], lab2[1], lab2[2]);
    let c1 = (a1 * a1 + b1 * b1).sqrt();
    let c2 = (a2 * a2 + b2 * b2).sqrt();
    let c_bar7 = ((c1 + c2) / 2.0).powi(7);
    let g = 0.5 * (1.0 - (c_bar7 / (c_bar7 + 25f64.powi(7))).sqrt());
    let (a1p, a2p) = (a1 * (1.0 + g), a2 * (1.0 + g));
    let c1p = (a1p * a1p + b1 * b1).sqrt();
    let c2p = (a2p * a2p + b2 * b2).sqrt();
    let hue = |ap: f64, b: f64| {
        if ap == 0.0 && b == 0.0 {
            0.0
        } else {
            b.atan2(ap).to_degrees().rem_euclid(360.0)
        }
    };
    let (h1p, h2p) = (hue(a1p, b1), hue(a2p, b2));
    let dl = l2 - l1;
    let dc = c2p - c1p;
    let dh = if c1p * c2p == 0.0 {
        0.0
    } else {
        let d = h2p - h1p;
        if d > 180.0 {
            d - 360.0
        } else if d < -180.0 {
            d + 360.0
        } else {
            d
        }
    };
    let dh_term = 2.0 * (c1p * c2p).sqrt() * (dh.to_radians() / 2.0).sin();
    let l_bar = (l1 + l2) / 2.0;
    let c_bar_p = (c1p + c2p) / 2.0;
    let h_bar = if c1p * c2p == 0.0 {
        h1p + h2p
    } else if (h1p - h2p).abs() <= 180.0 {
        (h1p + h2p) / 2.0
    } else if h1p + h2p < 360.0 {
        (h1p + h2p + 360.0) / 2.0
    } else {
        (h1p + h2p - 360.0) / 2.0
    };
    let t = 1.0 - 0.17 * (h_bar - 30.0f64).to_radians().cos()
        + 0.24 * (2.0 * h_bar).to_radians().cos()
        + 0.32 * (3.0 * h_bar + 6.0).to_radians().cos()
        - 0.20 * (4.0 * h_bar - 63.0).to_radians().cos();
    let dtheta = 30.0 * (-((h_bar - 275.0) / 25.0).powi(2)).exp();
    let cp7 = c_bar_p.powi(7);
    let rc = 2.0 * (cp7 / (cp7 + 25f64.powi(7))).sqrt();
    let sl = 1.0 + 0.015 * (l_bar - 50.0).powi(2) / (20.0 + (l_bar - 50.0).powi(2)).sqrt();
    let sc = 1.0 + 0.045 * c_bar_p;
    let sh = 1.0 + 0.015 * c_bar_p * t;
    let rt = -(2.0 * dtheta.to_radians()).sin() * rc;
    ((dl / sl).powi(2) + (dc / sc).powi(2) + (dh_term / sh).powi(2) + rt * (dc / sc) * (dh_term / sh)).sqrt()
}

// ---------------------------------------------------------------------------
// The fit

/// One sampled patch: the mean over the sample circle, the per-channel
/// maximum, and the luminance spread (max minus min) across the circle.
/// The sampler (desktop, Phase 11 milestone 4) computes these from the
/// node's input; the fit only consumes them.
#[derive(Clone, Copy, Debug)]
pub struct PatchSample {
    pub mean: [f64; 3],
    pub max: [f64; 3],
    pub spread: f64,
}

/// What the fit found. `temperature`/`tint` go to the White Balance node
/// when the user keeps "Set white balance" on; otherwise the white
/// balance is folded into `matrix` and `wb_in_matrix` is set. `matrix` is
/// row-major m00..m22. `residuals` are per-patch CIEDE2000, worst first.
#[derive(Clone, Debug, Serialize)]
pub struct FitResult {
    pub temperature: f64,
    pub tint: f64,
    pub exposure: f64,
    pub matrix: [f64; 9],
    pub matrix_is_identity: bool,
    pub wb_in_matrix: bool,
    pub residuals: Vec<(usize, f64)>,
    pub mean_de: f64,
    pub illuminant: String,
    pub flagged: Vec<usize>,
    pub fitted: usize,
    pub note: String,
}

/// A patch whose sampled maximum climbs above this fraction of the
/// brightest neutral patch is clipped or flared and is excluded.
const CLIP_LEVEL: f64 = 0.95;
/// A patch whose sample circle varies by more than this fraction of its
/// own mean level caught glare or an edge and is excluded.
const SPREAD_REL: f64 = 0.25;
/// The clip check only runs when the chart's brightest neutral is near
/// white (this luminance, about L* 76): without a white on the card there
/// is no ceiling to measure against, and a mid-gray neutral would read
/// every honest saturated patch as clipped.
const WHITE_REF_MIN: f64 = 0.5;

fn luminance(rgb: [f64; 3]) -> f64 {
    0.2126 * rgb[0] + 0.7126 * rgb[1] + 0.0722 * rgb[2]
}

/// The brightest sampled neutral by reference luminance: the ceiling the
/// clip check measures against. None when the chart has no near-white
/// neutral sampled, which stands the clip check down (custom cards of
/// grays and primaries have no white to clip against).
fn brightest_neutral(chart: &Chart, samples: &[Option<PatchSample>]) -> Option<usize> {
    chart
        .neutrals
        .iter()
        .copied()
        .filter(|&i| samples[i].is_some())
        .filter(|&i| luminance(chart.patches[i].linear) >= WHITE_REF_MIN)
        .max_by(|&a, &b| {
            luminance(chart.patches[a].linear)
                .partial_cmp(&luminance(chart.patches[b].linear))
                .unwrap_or(std::cmp::Ordering::Equal)
        })
}

/// Why a patch was flagged, for the report: "clip" when its sample's
/// maximum climbed toward the brightest neutral (clipped or flared),
/// "glare" when the circle's spread says an edge or a reflection crossed
/// it. None for a patch the fit can use. The brightest neutral itself is
/// the clip reference and is exempt from that check, and when the chart
/// offers no near-white neutral there is no clip check at all.
pub fn flag_reason(
    samples: &[Option<PatchSample>],
    brightest: Option<usize>,
    index: usize,
) -> Option<&'static str> {
    let s = samples.get(index).copied().flatten()?;
    if let Some(bn) = brightest {
        if index != bn {
            let bright = samples[bn].unwrap().mean;
            if (0..3).any(|c| s.max[c] > CLIP_LEVEL * bright[c]) {
                return Some("clip");
            }
        }
    }
    let level = luminance(s.mean);
    if s.spread > SPREAD_REL * level.max(1e-6) {
        return Some("glare");
    }
    None
}

/// Invert measured white balance gains to the two-slider (temperature,
/// tint) model `wb_gains` implements. Gains arrive green-normalized (an
/// overall exposure error must not leak into the white balance), so with
/// g = wb_gains green = 1 - 0.45 * tint / 150 and r/b = 1 +/- 0.4 * dt,
/// the model says gains_r * g = 1 + 0.4 * dt and gains_b * g = 1 - 0.4 *
/// dt. Adding the two gives g = 2 / (gains_r + gains_b), and dt and tint
/// follow directly. Closed form, exact when the camera's shift is a
/// temperature/tint move; clamped to the model's domain otherwise.
fn gains_to_temperature_tint(gains: [f64; 3]) -> (f64, f64) {
    let sum = gains[0] + gains[2];
    if sum <= 1e-6 {
        return (6500.0, 0.0);
    }
    let g = 2.0 / sum;
    let dt = ((gains[0] * g - 1.0) / 0.4).clamp(-0.9, 3.0);
    let temperature = 6500.0 * (1.0 + dt);
    let tint = ((1.0 - g) / 0.45 * 150.0).clamp(-150.0, 150.0);
    (temperature, tint)
}

fn illuminant_guess(temperature: f64) -> &'static str {
    if temperature < 3400.0 {
        "tungsten"
    } else if temperature < 4300.0 {
        "fluorescent"
    } else if temperature < 5400.0 {
        "daylight"
    } else if temperature < 7000.0 {
        "overcast"
    } else {
        "shade"
    }
}

/// Run the calibration fit. `samples` has one entry per chart patch,
/// `None` for patches the user excluded. With `set_wb` the white balance
/// is reported as temperature/tint for the White Balance node; without it
/// the same gains are folded into the matrix. `weight_neutrals` doubles
/// the weight of the neutral and skin patches in the matrix solve.
pub fn fit(
    chart: &Chart,
    samples: &[Option<PatchSample>],
    set_wb: bool,
    weight_neutrals: bool,
) -> Result<FitResult, String> {
    if samples.len() != chart.patches.len() {
        return Err(format!(
            "chart {} has {} patches but {} samples",
            chart.id,
            chart.patches.len(),
            samples.len()
        ));
    }

    // The brightest neutral by reference luminance sets the ceiling for
    // the clip check; its own sample is the reference and is exempt.
    let brightest_neutral = brightest_neutral(chart, samples);

    let mut flagged = Vec::new();
    for i in 0..samples.len() {
        // A targetless control is never flagged: the fit ignores it, so
        // there is nothing to warn about.
        if chart.patches[i].target && flag_reason(samples, brightest_neutral, i).is_some() {
            flagged.push(i);
        }
    }

    let usable = |i: usize| chart.patches[i].target && samples[i].is_some() && !flagged.contains(&i);

    // (1) White balance from the neutrals: per-channel gains that turn
    // each measured neutral gray, green-normalized so exposure stays out.
    let neutral_idx: Vec<usize> = chart.neutrals.iter().copied().filter(|&i| usable(i)).collect();
    if neutral_idx.is_empty() {
        return Err("no usable neutral patches: cannot fit white balance".to_string());
    }
    let mut gains = [0.0f64; 3];
    let mut counts = [0usize; 3];
    for &i in &neutral_idx {
        let s = samples[i].unwrap().mean;
        for c in 0..3 {
            if s[c] > 1e-6 && s[1] > 1e-6 {
                gains[c] += s[1] / s[c];
                counts[c] += 1;
            }
        }
    }
    for c in 0..3 {
        if counts[c] == 0 {
            return Err("neutral patches sample to zero: cannot fit white balance".to_string());
        }
        gains[c] /= counts[c] as f64;
    }
    let (temperature, tint) = gains_to_temperature_tint(gains);
    // The node will apply wb_gains(temperature, tint) exactly, so every
    // later step and the report use those model gains, not the raw fit.
    let wb = wb_gains(temperature as f32, tint as f32).map(|v| v as f64);

    let corrected = |i: usize| -> [f64; 3] {
        let s = samples[i].unwrap().mean;
        [wb[0] * s[0], wb[1] * s[1], wb[2] * s[2]]
    };

    // (2) Exposure from the neutrals' reflectance: median ratio of
    // reference to measured luminance, in stops.
    let mut ratios: Vec<f64> = neutral_idx
        .iter()
        .map(|&i| {
            let reference = luminance(chart.patches[i].linear);
            let measured = luminance(corrected(i));
            if measured > 1e-8 {
                reference / measured
            } else {
                1.0
            }
        })
        .collect();
    ratios.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    let exposure_gain = ratios[ratios.len() / 2].max(1e-8);
    let exposure = exposure_gain.log2();

    // (3) The 3x3 by weighted least squares in linear space, row sums
    // fixed to 1 so a neutral stays neutral. With M[r][2] substituted as
    // 1 - M[r][0] - M[r][1], each row is a 2x2 system:
    //   ref[r] - s[2] = M[r][0] * (s[0] - s[2]) + M[r][1] * (s[1] - s[2])
    let fitted_idx: Vec<usize> = (0..chart.patches.len()).filter(|&i| usable(i)).collect();
    let chromatic = fitted_idx.iter().filter(|i| !chart.neutrals.contains(i)).count();
    let enough_for_matrix = fitted_idx.len() >= 4 && chromatic >= 3;

    let mut matrix = [1.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0];
    let mut matrix_is_identity = true;
    let note;
    if enough_for_matrix {
        let weight = |i: usize| {
            if weight_neutrals && (chart.neutrals.contains(&i) || chart.skin.contains(&i)) {
                2.0
            } else {
                1.0
            }
        };
        let mut m = [[0.0f64; 3]; 3];
        for row in 0..3 {
            // Standard Color follows the checker. Solve against target / D
            // in that mode, retaining neutrality in white-balanced coordinates.
            let row_scale = if set_wb { 1.0 / wb[row] } else { 1.0 };
            let (mut a00, mut a01, mut a11) = (0.0, 0.0, 0.0);
            let (mut v0, mut v1) = (0.0, 0.0);
            for &i in &fitted_idx {
                let w = weight(i);
                let s = corrected(i).map(|v| v * exposure_gain);
                let target = chart.patches[i].linear[row] * row_scale;
                let d0 = s[0] - s[2];
                let d1 = s[1] - s[2];
                let t = target - row_scale * s[2];
                a00 += w * d0 * d0;
                a01 += w * d0 * d1;
                a11 += w * d1 * d1;
                v0 += w * d0 * t;
                v1 += w * d1 * t;
            }
            let det = a00 * a11 - a01 * a01;
            if det.abs() > 1e-12 {
                let x = (v0 * a11 - v1 * a01) / det;
                let y = (a00 * v1 - a01 * v0) / det;
                m[row] = [x, y, row_scale - x - y];
            } else {
                m[row][row] = row_scale;
            }
        }
        matrix_is_identity = false;
        // Convert the solve's white-balanced input coordinates to raw RGB.
        // To node: D^-1 * correction * D. In matrix: correction * D.
        let flat = [m[0], m[1], m[2]].concat().iter().enumerate()
            .map(|(i, v)| v * wb[i % 3]).collect::<Vec<f64>>();
        matrix.copy_from_slice(&flat);
        note = format!("fitted on {} patches", fitted_idx.len());
    } else {
        note = format!(
            "only {} usable patches ({} chromatic): fitted white balance and exposure, color correction left at identity",
            fitted_idx.len(),
            chromatic
        );
        if !set_wb {
            // With no chromatic fit the color correction is identity,
            // but this node still owns the requested white balance.
            matrix = [wb[0], 0.0, 0.0, 0.0, wb[1], 0.0, 0.0, 0.0, wb[2]];
            matrix_is_identity = wb == [1.0; 3];
        }
    }

    // Report: per-patch CIEDE2000 of the corrected sample against the
    // reference, worst first, plus the mean.
    let apply = |i: usize| apply_transform(matrix, exposure_gain,
        if set_wb { wb } else { [1.0; 3] }, samples[i].unwrap().mean);
    let mut residuals: Vec<(usize, f64)> = fitted_idx
        .iter()
        .map(|&i| (i, ciede2000(working_to_lab_d50(apply(i)), chart.patches[i].lab)))
        .collect();
    residuals.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));
    let mean_de = if residuals.is_empty() {
        0.0
    } else {
        residuals.iter().map(|r| r.1).sum::<f64>() / residuals.len() as f64
    };

    Ok(FitResult {
        temperature,
        tint,
        exposure,
        matrix,
        matrix_is_identity,
        wb_in_matrix: !set_wb,
        residuals,
        mean_de,
        illuminant: illuminant_guess(temperature).to_string(),
        flagged,
        fitted: fitted_idx.len(),
        note,
    })
}

/// Apply the checker matrix and exposure, then the following node's WB.
pub fn apply_fit(fit: &FitResult, rgb: [f64; 3]) -> [f64; 3] {
    let wb = if fit.wb_in_matrix { [1.0; 3] } else {
        wb_gains(fit.temperature as f32, fit.tint as f32).map(|v| v as f64)
    };
    apply_transform(fit.matrix, 2f64.powf(fit.exposure), wb, rgb)
}

fn apply_transform(m: [f64; 9], gain: f64, wb: [f64; 3], rgb: [f64; 3]) -> [f64; 3] {
    std::array::from_fn(|row| gain * wb[row] *
        (m[row * 3] * rgb[0] + m[row * 3 + 1] * rgb[1] + m[row * 3 + 2] * rgb[2]))
}

// ---------------------------------------------------------------------------
// The sampler

/// The projective map the chart quad lives by, in f64: the same eight
/// coefficients ops_geometry solves in f32 for the warps, duplicated here
/// because that solver is private to the warp and this one works in image
/// fractions, not pixel coordinates. Corner order TL, TR, BR, BL, the one
/// quadmap.ts and ops_geometry both use.
fn solve_homography(from: &[[f64; 2]; 4], to: &[[f64; 2]; 4]) -> Option<[f64; 8]> {
    let mut m = [[0.0f64; 9]; 8];
    for i in 0..4 {
        let [u, v] = from[i];
        let [x, y] = to[i];
        m[2 * i] = [u, v, 1.0, 0.0, 0.0, 0.0, -x * u, -x * v, x];
        m[2 * i + 1] = [0.0, 0.0, 0.0, u, v, 1.0, -y * u, -y * v, y];
    }
    for col in 0..8 {
        let mut pivot = col;
        #[allow(clippy::needless_range_loop)]
        for r in col + 1..8 {
            if m[r][col].abs() > m[pivot][col].abs() {
                pivot = r;
            }
        }
        if m[pivot][col].abs() < 1e-12 {
            return None;
        }
        m.swap(col, pivot);
        let d = m[col][col];
        for k in 0..9 {
            m[col][k] /= d;
        }
        for r in 0..8 {
            if r == col {
                continue;
            }
            let f = m[r][col];
            if f == 0.0 {
                continue;
            }
            for k in 0..9 {
                m[r][k] -= f * m[col][k];
            }
        }
    }
    let h: [f64; 8] = std::array::from_fn(|i| m[i][8]);
    if h.iter().all(|v| v.is_finite()) {
        Some(h)
    } else {
        None
    }
}

/// One image-fraction point through a solved map.
fn map_point(h: &[f64; 8], p: [f64; 2]) -> [f64; 2] {
    let d = h[6] * p[0] + h[7] * p[1] + 1.0;
    if d.abs() < 1e-12 {
        return p;
    }
    [
        (h[0] * p[0] + h[1] * p[1] + h[2]) / d,
        (h[3] * p[0] + h[4] * p[1] + h[5]) / d,
    ]
}

/// A circle must cover at least this many pixels to say anything: under
/// that, the mean is a coincidence of the raster grid, not a patch.
const MIN_SAMPLE_PIXELS: usize = 8;

/// Sample every chart patch out of the node's input frame. `quad` is the
/// four corners in image fractions (TL, TR, BR, BL), `nudged` the
/// hand-placed patch centers, also in image fractions, and `sample_pct`
/// the node's sample param: the circle's diameter as a percent of the
/// cell (10 to 90, 40 at rest), the same number the overlay draws.
///
/// Each patch's circle is defined in chart space, so the quad's
/// perspective stretches it with the patch: pixel centers are
/// inverse-mapped into chart space and a pixel counts when its distance
/// from the patch's center, in cell units, is within sample_pct / 200.
/// A nudged patch's center inverse-maps the same way and its circle
/// moves with it; its natural cell stops counting so the stain the user
/// moved the circle off stays out. None for a patch whose circle lands
/// off the frame or on too few pixels, or for every patch when the quad
/// is degenerate.
pub fn sample_chart(
    chart: &Chart,
    frame: &crate::buffers::ImageBuf,
    quad: &[[f64; 2]; 4],
    nudged: &std::collections::HashMap<usize, [f64; 2]>,
    sample_pct: f64,
) -> Vec<Option<PatchSample>> {
    // The radius in cell units, clamped to the param's own range: the
    // caller passes the node's value straight through.
    let r = (sample_pct / 200.0).clamp(0.05, 0.45);
    let r2 = r * r;
    let n = chart.patches.len();
    let unit = [[0.0, 0.0], [1.0, 0.0], [1.0, 1.0], [0.0, 1.0]];
    let Some(inv) = solve_homography(quad, &unit) else {
        return vec![None; n];
    };
    let cols = chart.cols as f64;
    let rows = chart.rows as f64;
    // Every patch's circle center in chart space: the cell center, or the
    // nudge inverse-mapped so one distance test serves both.
    let centres: Vec<[f64; 2]> = (0..n)
        .map(|i| {
            if let Some(p) = nudged.get(&i) {
                map_point(&inv, *p)
            } else {
                let c = (i % chart.cols) as f64;
                let r = (i / chart.cols) as f64;
                [(c + 0.5) / cols, (r + 0.5) / rows]
            }
        })
        .collect();
    let nudged_set: std::collections::HashSet<usize> =
        nudged.keys().copied().filter(|&i| i < n).collect();

    let mut count = vec![0usize; n];
    let mut sum = vec![[0.0f64; 3]; n];
    let mut mx = vec![[0.0f64; 3]; n];
    let mut lum_lo = vec![f64::INFINITY; n];
    let mut lum_hi = vec![f64::NEG_INFINITY; n];
    let w = frame.width;
    let hgt = frame.height;
    let mut gather = |i: usize, px: [f32; 4]| {
        let rgb = [px[0] as f64, px[1] as f64, px[2] as f64];
        count[i] += 1;
        for c in 0..3 {
            sum[i][c] += rgb[c];
            mx[i][c] = mx[i][c].max(rgb[c]);
        }
        let lum = luminance(rgb);
        lum_lo[i] = lum_lo[i].min(lum);
        lum_hi[i] = lum_hi[i].max(lum);
    };
    for y in 0..hgt {
        let fy = (y as f64 + 0.5) / hgt as f64;
        for x in 0..w {
            let fx = (x as f64 + 0.5) / w as f64;
            let uv = map_point(&inv, [fx, fy]);
            let px = frame.pixel(x, y);
            // The natural cell, when the patch sits where the grid says.
            if uv[0] >= 0.0 && uv[0] < 1.0 && uv[1] >= 0.0 && uv[1] < 1.0 {
                let ci = (uv[0] * cols).floor() as usize;
                let ri = (uv[1] * rows).floor() as usize;
                let i = ri * chart.cols + ci;
                if i < n && !nudged_set.contains(&i) {
                    let du = uv[0] * cols - ci as f64 - 0.5;
                    let dv = uv[1] * rows - ri as f64 - 0.5;
                    if du * du + dv * dv <= r2 {
                        gather(i, px);
                    }
                }
            }
            // The nudged circles, wherever they were put.
            for &i in &nudged_set {
                let du = (uv[0] - centres[i][0]) * cols;
                let dv = (uv[1] - centres[i][1]) * rows;
                if du * du + dv * dv <= r2 {
                    gather(i, px);
                }
            }
        }
    }
    (0..n)
        .map(|i| {
            if count[i] < MIN_SAMPLE_PIXELS {
                return None;
            }
            Some(PatchSample {
                mean: sum[i].map(|v| v / count[i] as f64),
                max: mx[i],
                spread: lum_hi[i] - lum_lo[i],
            })
        })
        .collect()
}

/// One row of the panel's report: the patch, its measured and corrected
/// colors sRGB-encoded for display, its CIEDE2000 when it was fitted,
/// and the reason when it was flagged instead.
#[derive(Clone, Debug, Serialize)]
pub struct PatchReport {
    pub index: usize,
    pub name: String,
    pub before: [f32; 3],
    pub after: [f32; 3],
    pub de: Option<f64>,
    pub flag: Option<String>,
}

/// The panel report, worst first: the fitted patches by residual, then
/// the flagged ones with their reason. `after` is the measured color
/// through the fitted transform, so the swatch pair shows the correction
/// the chain will make, and `before` is what the camera actually saw.
pub fn patch_report(chart: &Chart, samples: &[Option<PatchSample>], fit: &FitResult) -> Vec<PatchReport> {
    let bn = brightest_neutral(chart, samples);
    let de_of: std::collections::HashMap<usize, f64> = fit.residuals.iter().copied().collect();
    let mut rows: Vec<PatchReport> = samples
        .iter()
        .enumerate()
        .filter_map(|(i, s)| {
            // A targetless control has no reference to report against.
            if !chart.patches[i].target {
                return None;
            }
            let s = (*s)?;
            let flag = flag_reason(samples, bn, i).map(str::to_string);
            Some(PatchReport {
                index: i,
                name: chart.patches[i].name.clone(),
                before: s.mean.map(srgb_encode),
                after: apply_fit(fit, s.mean).map(srgb_encode),
                de: de_of.get(&i).copied(),
                flag,
            })
        })
        .collect();
    rows.sort_by(|a, b| {
        b.de.unwrap_or(-1.0)
            .partial_cmp(&a.de.unwrap_or(-1.0))
            .unwrap_or(std::cmp::Ordering::Equal)
    });
    rows
}

// ---------------------------------------------------------------------------
// The node op

/// The Color Checker node: scene-linear RGB through the fitted 3x3 and
/// the exposure scale, blended by amount. Nothing else: tone stays in
/// Tone Profile. An untouched node (unit matrix, no exposure) or amount
/// at zero is a bit-exact passthrough, the same shortcut the Exposure
/// node takes, and the alpha channel always copies through.
pub(crate) fn color_checker(node: &Node, inputs: &[(String, Value)]) -> Result<Value, EngineError> {
    let src = image_input(inputs, "in", &node.id)?;
    let m = [
        p(&node.params, "m00", 1.0),
        p(&node.params, "m01", 0.0),
        p(&node.params, "m02", 0.0),
        p(&node.params, "m10", 0.0),
        p(&node.params, "m11", 1.0),
        p(&node.params, "m12", 0.0),
        p(&node.params, "m20", 0.0),
        p(&node.params, "m21", 0.0),
        p(&node.params, "m22", 0.0),
    ];
    let ev = p(&node.params, "exposure", 0.0);
    let amount = (p(&node.params, "amount", 100.0) / 100.0).clamp(0.0, 1.0);
    if (m == [1.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0] && ev == 0.0) || amount == 0.0 {
        return Ok(Value::Image(Arc::clone(src)));
    }
    let gain = 2f32.powf(ev);
    Ok(Value::Image(Arc::new(map_rgb(src, move |r, g, b| {
        let t = [
            gain * (m[0] * r + m[1] * g + m[2] * b),
            gain * (m[3] * r + m[4] * g + m[5] * b),
            gain * (m[6] * r + m[7] * g + m[8] * b),
        ];
        [
            r + (t[0] - r) * amount,
            g + (t[1] - g) * amount,
            b + (t[2] - b) * amount,
        ]
    }))))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn mat_invert3(m: Mat3) -> Mat3 {
        mat_invert(m)
    }

    /// Render the chart as a camera would: the reference values under a
    /// white balance shift, a matrix, and an exposure error. The fit must
    /// undo all three.
    fn synthetic_samples(chart: &Chart, m: Mat3, wb: [f64; 3], ev: f64) -> Vec<Option<PatchSample>> {
        let inv = mat_invert3(m);
        let gain = 2f64.powf(ev);
        chart
            .patches
            .iter()
            .map(|p| {
                let mut s = mat_mul(inv, p.linear);
                for c in 0..3 {
                    s[c] *= gain / wb[c];
                }
                Some(PatchSample { mean: s, max: s, spread: 0.0 })
            })
            .collect()
    }

    const M_TRUE: Mat3 = [
        [1.05, -0.08, 0.03],
        [0.02, 1.00, -0.02],
        [-0.05, 0.04, 1.01],
    ];

    #[test]
    fn synthetic_chart_recovers_matrix_exposure_and_wb() {
        let chart = builtin_chart("colorchecker-classic").unwrap();
        let wb_true = wb_gains(5000.0, 20.0).map(|v| v as f64);
        let samples = synthetic_samples(&chart, M_TRUE, wb_true, -0.7);
        let r = fit(&chart, &samples, true, true).unwrap();
        // The Classic's neutral patches carry a little published chroma
        // (white 9.5 sits at b = 2.93), which biases the recovered
        // temperature; the tolerance reflects that, not solver slack.
        assert!(
            (r.temperature - 5000.0).abs() < 80.0,
            "temperature {} should be near 5000",
            r.temperature
        );
        assert!((r.tint - 20.0).abs() < 4.0, "tint {} should be near 20", r.tint);
        assert!(
            (r.exposure - 0.7).abs() < 0.02,
            "exposure {} should recover +0.7 stops",
            r.exposure
        );
        let flat: Vec<f64> = [M_TRUE[0], M_TRUE[1], M_TRUE[2]].concat().iter().enumerate()
            .map(|(i, v)| v * wb_true[i % 3] / wb_true[i / 3]).collect();
        // The matrix absorbs whatever the two-slider white balance could
        // not (the neutrals' published chroma shifts the WB by a hair),
        // so the tolerance is wider than solver noise.
        for i in 0..9 {
            assert!(
                (r.matrix[i] - flat[i]).abs() < 0.02,
                "matrix[{i}] = {} should be {}",
                r.matrix[i],
                flat[i]
            );
        }
        assert!(!r.matrix_is_identity);
        assert!(r.mean_de < 1.0, "mean dE {} should be under 1", r.mean_de);
        for w in r.residuals.windows(2) {
            assert!(w[0].1 >= w[1].1, "residuals must sort worst first");
        }
        assert_eq!(r.illuminant, "daylight");
    }

    #[test]
    fn wb_folded_into_matrix_when_set_wb_off() {
        let chart = builtin_chart("colorchecker-classic").unwrap();
        let wb_true = wb_gains(5000.0, 20.0).map(|v| v as f64);
        let samples = synthetic_samples(&chart, M_TRUE, wb_true, -0.7);
        let r = fit(&chart, &samples, false, true).unwrap();
        assert!(r.wb_in_matrix);
        // The folded matrix is M_true * diag(wb): applying it with the
        // exposure must land every patch on its reference.
        let gain = 2f64.powf(r.exposure);
        for (i, p) in chart.patches.iter().enumerate() {
            let s = samples[i].unwrap().mean.map(|v| v * gain);
            let out = [
                r.matrix[0] * s[0] + r.matrix[1] * s[1] + r.matrix[2] * s[2],
                r.matrix[3] * s[0] + r.matrix[4] * s[1] + r.matrix[5] * s[2],
                r.matrix[6] * s[0] + r.matrix[7] * s[1] + r.matrix[8] * s[2],
            ];
            for c in 0..3 {
                assert!(
                    (out[c] - p.linear[c]).abs() < 0.01,
                    "patch {} channel {c}: {} vs {}",
                    p.name,
                    out[c],
                    p.linear[c]
                );
            }
        }
        assert!(r.mean_de < 1.0);
    }

    #[test]
    fn a_neutral_stays_neutral_after_the_fit() {
        let chart = builtin_chart("colorchecker-classic").unwrap();
        let wb_true = wb_gains(4300.0, -12.0).map(|v| v as f64);
        let samples = synthetic_samples(&chart, M_TRUE, wb_true, -0.4);
        let r = fit(&chart, &samples, true, true).unwrap();
        // A neutral in white-balanced coordinates stays neutral in graph order.
        let wb = wb_gains(r.temperature as f32, r.tint as f32).map(|v| v as f64);
        let gain = 2f64.powf(r.exposure);
        for g in [0.02, 0.18, 0.5, 0.9] {
            let out = apply_fit(&r, std::array::from_fn(|c| g / wb[c] / gain));
            for c in 0..3 {
                assert!(
                    (out[c] - g).abs() < 1e-9,
                    "matrix turns gray {g} into {out:?}: row sums must hold at 1"
                );
            }
        }
        // And each measured chart neutral lands on its published value.
        for &i in &chart.neutrals {
            let out = apply_fit(&r, samples[i].unwrap().mean);
            for c in 0..3 {
                assert!(
                    (out[c] - chart.patches[i].linear[c]).abs() < 0.01,
                    "neutral {} corrects to {out:?}, reference is {:?}",
                    chart.patches[i].name,
                    chart.patches[i].linear
                );
            }
        }
    }

    #[test]
    fn a_glare_patch_is_flagged_and_excluded() {
        let chart = builtin_chart("colorchecker-classic").unwrap();
        let wb_true = wb_gains(5000.0, 20.0).map(|v| v as f64);
        let mut samples = synthetic_samples(&chart, M_TRUE, wb_true, -0.7);
        // Foliage catches the sun: clipped maximum on one patch.
        let mut blown = samples[3].unwrap();
        blown.max = [4.0, 4.0, 4.0];
        samples[3] = Some(blown);
        // Blue flower is half glare: the circle's spread blows out.
        let mut streaky = samples[4].unwrap();
        streaky.spread = luminance(streaky.mean) * 0.6;
        samples[4] = Some(streaky);
        let r = fit(&chart, &samples, true, true).unwrap();
        assert!(r.flagged.contains(&3), "clipped patch 3 must be flagged: {:?}", r.flagged);
        assert!(r.flagged.contains(&4), "glare patch 4 must be flagged: {:?}", r.flagged);
        assert!(!r.residuals.iter().any(|(i, _)| *i == 3 || *i == 4));
        let flat: Vec<f64> = [M_TRUE[0], M_TRUE[1], M_TRUE[2]].concat();
        for i in 0..9 {
            assert!(
                (r.matrix[i] - flat[i]).abs() < 0.02,
                "matrix[{i}] = {} should stay near {} with two patches excluded",
                r.matrix[i],
                flat[i]
            );
        }
    }

    #[test]
    fn neutrals_only_fits_wb_and_exposure_with_identity_matrix() {
        let chart = builtin_chart("colorchecker-classic").unwrap();
        let wb_true = wb_gains(3800.0, 8.0).map(|v| v as f64);
        let all = synthetic_samples(&chart, M_TRUE, wb_true, -1.2);
        let samples: Vec<Option<PatchSample>> = all
            .into_iter()
            .enumerate()
            .map(|(i, s)| if chart.neutrals.contains(&i) { s } else { None })
            .collect();
        let r = fit(&chart, &samples, true, true).unwrap();
        assert!(r.matrix_is_identity, "note: {}", r.note);
        assert!(r.note.contains("identity"), "panel-facing note must say so: {}", r.note);
        assert!((r.temperature - 3800.0).abs() < 80.0, "temperature {} should be near 3800", r.temperature);
        assert!((r.exposure - 1.2).abs() < 0.02);
        let identity = [1.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0];
        assert_eq!(r.matrix, identity);
    }

    #[test]
    fn neutrals_only_keeps_white_balance_in_the_matrix_when_requested() {
        let chart = builtin_chart("colorchecker-classic").unwrap();
        let wb = wb_gains(3800.0, 8.0).map(|v| v as f64);
        let samples: Vec<_> = synthetic_samples(&chart, M_TRUE, wb, -1.2)
            .into_iter().enumerate()
            .map(|(i, s)| if chart.neutrals.contains(&i) { s } else { None })
            .collect();
        let to_node = fit(&chart, &samples, true, true).unwrap();
        let in_matrix = fit(&chart, &samples, false, true).unwrap();
        assert!(in_matrix.wb_in_matrix);
        for sample in samples.iter().flatten() {
            let expected = apply_fit(&to_node, sample.mean);
            let actual = apply_fit(&in_matrix, sample.mean);
            for c in 0..3 {
                assert!((expected[c] - actual[c]).abs() < 1e-6,
                    "white balance must survive the neutrals-only fallback: {actual:?} vs {expected:?}");
            }
        }
    }

    /// A 2x2 custom chart as the editor writes one: a gray and the three
    /// primaries, Lab values taken from the palette the editor offers.
    fn custom_four_control_chart() -> Chart {
        let pal = palette_targets();
        let lab_of = |key: &str| pal.iter().find(|p| p.key == key).unwrap().lab;
        let raw = serde_json::json!({
            "id": "custom-test-card",
            "name": "Test Card",
            "rows": 2,
            "cols": 2,
            "source": "test",
            "neutrals": [0],
            "patches": [
                { "name": "A1", "lab": lab_of("neutral-6-5-44-d") },
                { "name": "A2", "lab": lab_of("red") },
                { "name": "B1", "lab": lab_of("green") },
                { "name": "B2", "lab": lab_of("blue") },
            ]
        });
        chart_from_json(&raw.to_string()).unwrap()
    }

    #[test]
    fn a_custom_chart_with_four_controls_fits() {
        let chart = custom_four_control_chart();
        let wb_true = wb_gains(5200.0, 10.0).map(|v| v as f64);
        let samples = synthetic_samples(&chart, M_TRUE, wb_true, -0.5);
        let r = fit(&chart, &samples, true, true).unwrap();
        assert!(!r.matrix_is_identity, "four controls, three chromatic, must fit a matrix: {}", r.note);
        assert_eq!(r.fitted, 4);
        assert!((r.exposure - 0.5).abs() < 0.02, "exposure {} should recover +0.5 stops", r.exposure);
        let flat: Vec<f64> = [M_TRUE[0], M_TRUE[1], M_TRUE[2]].concat();
        for i in 0..9 {
            assert!(
                (r.matrix[i] - flat[i]).abs() < 0.02,
                "matrix[{i}] = {} should be {}",
                r.matrix[i],
                flat[i]
            );
        }
    }

    #[test]
    fn a_targetless_control_is_ignored_by_the_fit() {
        // The same card with B2 left untargeted, as the editor writes a
        // cell the user never assigned: no lab key at all.
        let pal = palette_targets();
        let lab_of = |key: &str| pal.iter().find(|p| p.key == key).unwrap().lab;
        let raw = serde_json::json!({
            "id": "custom-sparse",
            "name": "Sparse Card",
            "rows": 2,
            "cols": 2,
            "source": "test",
            "neutrals": [0, 3],
            "patches": [
                { "name": "A1", "lab": lab_of("neutral-6-5-44-d") },
                { "name": "A2", "lab": lab_of("red") },
                { "name": "B1", "lab": lab_of("green") },
                { "name": "B2" },
            ]
        });
        let chart = chart_from_json(&raw.to_string()).unwrap();
        assert!(!chart.patches[3].target, "a patch with no lab parses as targetless");
        assert!(!chart.def().patches[3].target, "the def must carry the flag to the overlay");
        // The targetless neutral index is dropped at the door.
        assert_eq!(chart.neutrals, vec![0]);

        // Garbage under the untargeted cell must move nothing: the fit
        // equals the fit with that cell unsampled.
        let wb_true = wb_gains(5200.0, 10.0).map(|v| v as f64);
        let mut dirty = synthetic_samples(&chart, M_TRUE, wb_true, -0.5);
        dirty[3] = Some(PatchSample { mean: [9.0, 0.0, 9.0], max: [99.0, 99.0, 99.0], spread: 50.0 });
        let mut clean = dirty.clone();
        clean[3] = None;
        let a = fit(&chart, &dirty, true, true).unwrap();
        let b = fit(&chart, &clean, true, true).unwrap();
        assert_eq!(a.matrix, b.matrix, "a targetless patch must not move the matrix");
        assert_eq!(a.fitted, b.fitted);
        assert!(!a.flagged.contains(&3), "a targetless patch is never flagged: {:?}", a.flagged);
        // Three usable controls, two chromatic: below the matrix minimum,
        // so white balance and exposure fit and the matrix stays home.
        assert!(a.matrix_is_identity, "note: {}", a.note);
        assert_eq!(a.fitted, 3);
        // And the report has no row for the untargeted cell.
        let rows = patch_report(&chart, &dirty, &a);
        assert!(!rows.iter().any(|p| p.index == 3), "the report skips targetless controls");
    }

    #[test]
    fn the_palette_is_every_builtin_charts_patches_deduped_by_name() {
        let pal = palette_targets();
        let classic = builtin_chart("colorchecker-classic").unwrap();
        // The Classic's 24 first, in chart order, attributed and flagged.
        for (i, p) in classic.patches.iter().enumerate() {
            assert_eq!(pal[i].name, p.name, "palette entry {i} should be the Classic's {}", p.name);
            assert_eq!(pal[i].chart, classic.name, "{} must name its chart", p.name);
            assert_eq!(pal[i].lab, p.lab, "{} must carry the chart's published Lab", p.name);
            assert_eq!(pal[i].neutral, classic.neutrals.contains(&i), "{}'s neutral flag", p.name);
        }
        // The Passport and the pre-2014 files share the Classic's names,
        // and the SpyderCheckrs' cell addresses the SG's, so only the SG
        // adds names past the Classic.
        let sg = builtin_chart("colorchecker-sg").unwrap();
        let sg_new = sg
            .patches
            .iter()
            .filter(|p| p.target && classic.patches.iter().all(|c| c.name != p.name))
            .count();
        assert_eq!(pal.len(), 24 + sg_new, "Classic plus the SG's new names, nothing else");
        for entry in &pal[24..] {
            assert_eq!(entry.chart, sg.name, "{} must come from the SG", entry.name);
        }
        // Keys are unique slugs.
        let keys: std::collections::HashSet<_> = pal.iter().map(|p| p.key.clone()).collect();
        assert_eq!(keys.len(), pal.len(), "palette keys must be unique");
        assert_eq!(pal[0].key, "dark-skin");
        assert_eq!(pal[20].key, "neutral-6-5-44-d");
        // The Classic's mid gray reads near achromatic (the published
        // values carry a whisper of color, real charts do).
        let grey = &pal[20];
        assert!(grey.neutral);
        assert!(grey.lab[1].abs() < 1.0 && grey.lab[2].abs() < 1.0, "a gray must be near achromatic: {:?}", grey.lab);
        let red = pal.iter().find(|p| p.key == "red").unwrap();
        let chart_red = classic.patches.iter().find(|p| p.name == "red").unwrap();
        let back = lab_d50_to_working(red.lab);
        for c in 0..3 {
            assert!((back[c] - chart_red.linear[c]).abs() < 1e-6, "red channel {c} round-trips: {back:?}");
        }
    }


    #[test]
    fn every_builtin_chart_has_neutral_neutrals_after_conversion() {
        for chart in builtin_charts() {
            assert!(!chart.neutrals.is_empty(), "{} lists no neutrals", chart.id);
            for &i in &chart.neutrals {
                let lin = chart.patches[i].linear;
                let hi = lin.iter().cloned().fold(f64::MIN, f64::max);
                let lo = lin.iter().cloned().fold(f64::MAX, f64::min);
                // The published values carry real chroma (the Classic
                // white sits at b = 2.93, the SpyderCheckr white at
                // a = 2.16, b = 2.60); a correct Bradford conversion
                // preserves that, a broken one would blow far past it.
                // The exact half of this guard is
                // a_pure_neutral_converts_to_equal_channels below.
                assert!(
                    hi - lo <= 0.12 * hi + 1e-4,
                    "{} patch {} (Lab {:?}) converts to {lin:?}: not neutral",
                    chart.id,
                    chart.patches[i].name,
                    chart.patches[i].lab
                );
            }
        }
        // The seven ids the panel offers.
        let all = builtin_charts();
        let ids: Vec<&str> = all.iter().map(|c| c.id.as_str()).collect();
        for want in [
            "colorchecker-classic",
            "colorchecker-classic-pre-2014",
            "colorchecker-passport",
            "colorchecker-passport-pre-2014",
            "colorchecker-sg",
            "spydercheckr-24",
            "spydercheckr-48",
        ] {
            assert!(ids.contains(&want), "missing built-in chart {want}");
        }
        assert_eq!(builtin_chart("colorchecker-sg").unwrap().patches.len(), 140);
        // The Passport aliases share the Classic's values.
        let classic = builtin_chart("colorchecker-classic").unwrap();
        let passport = builtin_chart("colorchecker-passport").unwrap();
        assert_eq!(passport.patches[0].lab, classic.patches[0].lab);
    }

    #[test]
    fn a_pure_neutral_converts_to_equal_channels() {
        // Lab [L, 0, 0] is D50-neutral by definition; after Bradford to
        // D65 and the Rec.709 matrix its channels must agree. Tolerance
        // covers the rounded matrix constants, nothing more.
        for l in [5.0, 20.0, 50.0, 80.0, 95.0] {
            let lin = lab_d50_to_working([l, 0.0, 0.0]);
            let hi = lin.iter().cloned().fold(f64::MIN, f64::max);
            let lo = lin.iter().cloned().fold(f64::MAX, f64::min);
            assert!(hi - lo < 2e-3 * hi + 1e-9, "Lab [{l}, 0, 0] converts to {lin:?}");
        }
    }

    #[test]
    fn ciede2000_matches_the_sharma_reference_pair() {
        // Sharma et al. (2005) test data, pair 1: dE00 = 2.0425.
        let d = ciede2000([50.0, 2.6772, -79.7751], [50.0, 0.0, -82.7485]);
        assert!((d - 2.0425).abs() < 0.001, "dE00 {d} should be 2.0425");
    }

    #[test]
    fn lab_working_round_trip() {
        for lab in [[50.0, 20.0, -30.0], [80.0, -5.0, 60.0], [20.0, 0.0, 0.0]] {
            let back = working_to_lab_d50(lab_d50_to_working(lab));
            for c in 0..3 {
                assert!((back[c] - lab[c]).abs() < 1e-6, "round trip {lab:?} -> {back:?}");
            }
        }
    }

    // The sampler.

    /// A tiny 3 x 2 chart with known working-space colors.
    fn test_chart() -> Chart {
        let patches: [(&str, [f64; 3]); 6] = [
            ("red", [0.5, 0.1, 0.1]),
            ("green", [0.1, 0.5, 0.1]),
            ("blue", [0.1, 0.1, 0.5]),
            ("yellow", [0.5, 0.5, 0.1]),
            ("gray", [0.4, 0.4, 0.4]),
            ("white", [0.9, 0.9, 0.9]),
        ];
        Chart {
            id: "test".into(),
            name: "Test".into(),
            rows: 2,
            cols: 3,
            source: "test".into(),
            neutrals: vec![4, 5],
            skin: vec![],
            patches: patches
                .iter()
                .map(|(name, linear)| ChartPatch { name: name.to_string(), lab: [0.0; 3], linear: *linear, target: true })
                .collect(),
        }
    }

    const TEST_QUAD: [[f64; 2]; 4] = [[0.1, 0.1], [0.9, 0.1], [0.9, 0.9], [0.1, 0.9]];

    /// Paint the chart through the quad: every pixel whose center lands
    /// in a cell wears that patch's color, modified by `tweak` (the
    /// stain and streak tests hook in here). Black outside the quad.
    fn paint_chart(
        chart: &Chart,
        quad: &[[f64; 2]; 4],
        w: usize,
        h: usize,
        tweak: impl Fn(usize, f64, f64, [f64; 3]) -> [f64; 3],
    ) -> crate::buffers::ImageBuf {
        let unit = [[0.0, 0.0], [1.0, 0.0], [1.0, 1.0], [0.0, 1.0]];
        let inv = solve_homography(quad, &unit).unwrap();
        let mut img = crate::buffers::ImageBuf::new(w, h);
        for y in 0..h {
            for x in 0..w {
                let uv = map_point(&inv, [(x as f64 + 0.5) / w as f64, (y as f64 + 0.5) / h as f64]);
                if uv[0] < 0.0 || uv[0] >= 1.0 || uv[1] < 0.0 || uv[1] >= 1.0 {
                    continue;
                }
                let ci = (uv[0] * chart.cols as f64).floor() as usize;
                let ri = (uv[1] * chart.rows as f64).floor() as usize;
                let i = ri * chart.cols + ci;
                let du = uv[0] * chart.cols as f64 - ci as f64 - 0.5;
                let dv = uv[1] * chart.rows as f64 - ri as f64 - 0.5;
                let rgb = tweak(i, du, dv, chart.patches[i].linear);
                img.set_pixel(x, y, [rgb[0] as f32, rgb[1] as f32, rgb[2] as f32, 1.0]);
            }
        }
        img
    }

    #[test]
    fn an_axis_aligned_quad_recovers_each_patch_colour() {
        let chart = test_chart();
        let frame = paint_chart(&chart, &TEST_QUAD, 300, 200, |_, _, _, rgb| rgb);
        let samples = sample_chart(&chart, &frame, &TEST_QUAD, &std::collections::HashMap::new(), 40.0);
        for (i, s) in samples.iter().enumerate() {
            let s = s.unwrap_or_else(|| panic!("patch {i} did not sample"));
            for c in 0..3 {
                assert!(
                    (s.mean[c] - chart.patches[i].linear[c]).abs() < 0.01,
                    "patch {i} channel {c}: {} != {}",
                    s.mean[c],
                    chart.patches[i].linear[c]
                );
            }
            assert!(s.spread < 0.01, "a flat patch has no spread, patch {i} shows {}", s.spread);
        }
    }

    #[test]
    fn a_nudged_centre_moves_the_circle_off_a_stain() {
        let chart = test_chart();
        // Patch 2 (blue) wears a black stain across its lower half.
        let frame = paint_chart(&chart, &TEST_QUAD, 300, 200, |i, _, dv, rgb| {
            if i == 2 && dv > 0.0 {
                [0.0, 0.0, 0.0]
            } else {
                rgb
            }
        });
        let stained = sample_chart(&chart, &frame, &TEST_QUAD, &std::collections::HashMap::new(), 40.0);
        assert!(stained[2].unwrap().mean[2] < 0.35, "the stain pulled the mean: {:?}", stained[2]);
        // Nudge the sample circle into the clean half: the center a
        // quarter cell up, mapped to image fractions through the quad.
        let unit = [[0.0, 0.0], [1.0, 0.0], [1.0, 1.0], [0.0, 1.0]];
        let fwd = solve_homography(&unit, &TEST_QUAD).unwrap();
        let nudged = std::collections::HashMap::from([(2usize, map_point(&fwd, [2.5 / 3.0, 0.25 / 2.0]))]);
        let clean = sample_chart(&chart, &frame, &TEST_QUAD, &nudged, 40.0);
        let s = clean[2].expect("the nudged circle samples");
        assert!((s.mean[2] - 0.5).abs() < 0.01, "the nudge recovered the blue: {:?}", s.mean);
        assert!(s.spread < 0.01, "the clean half has no spread: {}", s.spread);
    }

    #[test]
    fn a_glare_streak_flags_the_patch() {
        let chart = test_chart();
        // A bright streak down the middle of the gray patch: under the
        // clip level (white sits at 0.9), so it is the spread that
        // catches it, not the ceiling.
        let frame = paint_chart(&chart, &TEST_QUAD, 300, 200, |i, du, _, rgb| {
            if i == 4 && du.abs() < 0.06 {
                [0.8, 0.8, 0.8]
            } else {
                rgb
            }
        });
        let samples = sample_chart(&chart, &frame, &TEST_QUAD, &std::collections::HashMap::new(), 40.0);
        let reason = flag_reason(&samples, brightest_neutral(&chart, &samples), 4);
        assert_eq!(reason, Some("glare"), "a streak across the gray is glare");
        // And the fit excludes it without being asked.
        let r = fit(&chart, &samples, true, true).unwrap();
        assert!(r.flagged.contains(&4), "the fit's flagged list carries the streak");
        assert!(!r.residuals.iter().any(|(i, _)| *i == 4), "a flagged patch is not fitted");
    }

    #[test]
    fn a_degenerate_quad_samples_nothing() {
        let chart = test_chart();
        let frame = paint_chart(&chart, &TEST_QUAD, 300, 200, |_, _, _, rgb| rgb);
        // Three corners in a line: no interior, no map, no samples.
        let folded = [[0.1, 0.1], [0.5, 0.1], [0.9, 0.1], [0.1, 0.9]];
        let samples = sample_chart(&chart, &frame, &folded, &std::collections::HashMap::new(), 40.0);
        assert!(samples.iter().all(|s| s.is_none()), "a folded quad must not invent samples");
    }

    #[test]
    fn the_sample_circle_follows_the_sample_param() {
        let chart = test_chart();
        // Patch 2 wears a black ring between 0.25 and 0.42 cell units
        // from its center: outside the 40% circle (radius 0.2), inside
        // the 90% one (radius 0.45).
        let frame = paint_chart(&chart, &TEST_QUAD, 300, 200, |i, du, dv, rgb| {
            let d2 = du * du + dv * dv;
            if i == 2 && d2 > 0.0625 && d2 < 0.1764 {
                [0.0, 0.0, 0.0]
            } else {
                rgb
            }
        });
        let tight = sample_chart(&chart, &frame, &TEST_QUAD, &std::collections::HashMap::new(), 40.0);
        let wide = sample_chart(&chart, &frame, &TEST_QUAD, &std::collections::HashMap::new(), 90.0);
        let t = tight[2].expect("the 40% circle samples");
        let w = wide[2].expect("the 90% circle samples");
        assert!(
            (t.mean[2] - 0.5).abs() < 0.01,
            "the ring stays out at 40: {:?}",
            t.mean
        );
        assert!(w.mean[2] < t.mean[2] - 0.05, "at 90 the ring is in the mean: tight {:?} wide {:?}", t.mean, w.mean);
        assert!(w.spread > 0.05, "the ring is spread the tight circle never saw: {}", w.spread);
    }

    #[test]
    fn the_after_swatch_is_the_chains_answer() {
        // White balance in the matrix: apply_fit is matrix x 2^ev alone.
        let fit_in = FitResult {
            temperature: 6500.0,
            tint: 0.0,
            exposure: -1.0,
            matrix: [2.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.5],
            matrix_is_identity: false,
            wb_in_matrix: true,
            residuals: vec![],
            mean_de: 0.0,
            illuminant: "daylight".into(),
            flagged: vec![],
            fitted: 0,
            note: String::new(),
        };
        let out = apply_fit(&fit_in, [0.4, 0.4, 0.4]);
        assert!((out[0] - 0.4).abs() < 1e-9, "r: 2.0 x 0.5 x 0.4");
        assert!((out[2] - 0.1).abs() < 1e-9, "b: 0.5 x 0.5 x 0.4");
        // White balance at the WB node: the gains come from the same
        // wb_gains model the node applies. At 6500 K and zero tint the
        // gains are unity and the two paths agree.
        let fit_wb = FitResult { wb_in_matrix: false, ..fit_in.clone() };
        let a = apply_fit(&fit_in, [0.3, 0.2, 0.6]);
        let b = apply_fit(&fit_wb, [0.3, 0.2, 0.6]);
        for c in 0..3 {
            assert!((a[c] - b[c]).abs() < 1e-9, "neutral WB: {a:?} != {b:?}");
        }
    }

    // The node op.

    fn make_checker() -> Node {
        heeler_graph::Registry::builtin()
            .instantiate("heeler.color_checker", "cc", heeler_graph::Section::RawFoundation)
            .unwrap()
    }

    fn frame(px: &[[f32; 4]]) -> crate::buffers::ImageBuf {
        crate::buffers::ImageBuf {
            width: px.len(),
            height: 1,
            data: px.iter().flat_map(|p| p.iter().copied()).collect(),
        }
    }

    fn run(node: &Node, img: crate::buffers::ImageBuf) -> crate::buffers::ImageBuf {
        match crate::ops::execute(node, &[("in".to_string(), Value::Image(Arc::new(img)))]) {
            Ok(Value::Image(out)) => (*out).clone(),
            other => panic!("expected an image, got {}", other.is_ok()),
        }
    }

    fn set_num(node: &mut Node, param: &str, v: f64) {
        node.params
            .insert(param.to_string(), heeler_graph::ParamValue::Number(v));
    }

    #[test]
    fn an_untouched_node_is_a_bit_exact_passthrough() {
        let node = make_checker();
        let img = frame(&[[0.25, -0.5, 2.0, 0.7], [1.0, 1.0, 1.0, 1.0]]);
        let out = run(&node, img.clone());
        assert_eq!(out.data, img.data, "identity matrix and no exposure must not touch a pixel");
    }

    #[test]
    fn matrix_exposure_and_amount_apply_in_scene_linear() {
        let mut node = make_checker();
        // Double red, halve green, blue untouched, then +1 stop.
        set_num(&mut node, "m00", 2.0);
        set_num(&mut node, "m11", 0.5);
        set_num(&mut node, "exposure", 1.0);
        let img = frame(&[[0.1, 0.2, 0.3, 0.4]]);
        let out = run(&node, img);
        assert!((out.data[0] - 0.4).abs() < 1e-6, "r: {}", out.data[0]);
        assert!((out.data[1] - 0.2).abs() < 1e-6, "g: {}", out.data[1]);
        assert!((out.data[2] - 0.6).abs() < 1e-6, "b: {}", out.data[2]);
        assert_eq!(out.data[3], 0.4, "alpha copies through");
    }

    #[test]
    fn amount_blends_toward_the_fit() {
        let mut node = make_checker();
        set_num(&mut node, "m00", 3.0);
        set_num(&mut node, "amount", 50.0);
        let img = frame(&[[0.2, 0.0, 0.0, 1.0]]);
        let out = run(&node, img);
        assert!((out.data[0] - 0.4).abs() < 1e-6, "half of 0.2 -> 0.6 is 0.4: {}", out.data[0]);
    }

    #[test]
    fn amount_zero_is_a_passthrough() {
        let mut node = make_checker();
        set_num(&mut node, "m00", 3.0);
        set_num(&mut node, "amount", 0.0);
        let img = frame(&[[0.2, 0.4, 0.6, 0.9]]);
        let out = run(&node, img.clone());
        assert_eq!(out.data, img.data);
    }
}
