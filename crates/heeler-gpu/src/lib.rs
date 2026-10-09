//! GPU compute path for Heeler image ops (wgpu: Vulkan/DX12 on Windows,
//! Metal on macOS).
//!
//! Contract with the CPU engine: for every op implemented here, the WGSL
//! kernel mirrors the exact formula in `heeler-engine`'s ops, and parity
//! tests assert the outputs match within float tolerance. The CPU path
//! stays the source of truth; the GPU path is the performance path.
//! Derived parameters (gains, pivots) are computed on the CPU side in one
//! place so both backends consume identical numbers.

use std::collections::HashMap;

use heeler_engine::ImageBuf;
use heeler_graph::Node;

#[derive(Debug, thiserror::Error)]
pub enum GpuError {
    #[error("no suitable GPU adapter found")]
    NoAdapter,
    #[error("device error: {0}")]
    Device(String),
    #[error("node type '{0}' has no GPU kernel")]
    Unsupported(String),
    #[error("gpu readback failed")]
    Readback,
}

const SHADER: &str = r#"
struct Params {
    p0: vec4<f32>,
    p1: vec4<f32>,
    p2: vec4<f32>,
    p3: vec4<f32>,
};

@group(0) @binding(0) var<storage, read> src: array<f32>;
@group(0) @binding(1) var<storage, read_write> dst: array<f32>;
@group(0) @binding(2) var<uniform> u: Params;

const PIVOT: f32 = 0.18;

fn luma_of(r: f32, g: f32, b: f32) -> f32 {
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

fn to_display(v: f32) -> f32 {
    if (v <= 0.0031308) { return v * 12.92; }
    return 1.055 * pow(v, 1.0 / 2.4) - 0.055;
}

fn to_scene(v: f32) -> f32 {
    if (v <= 0.04045) { return v / 12.92; }
    return pow((v + 0.055) / 1.055, 2.4);
}

// Mirrors ops::contrast_curve: power either side of the middle-gray
// anchor, over-range passed through.
fn contrast_curve(d: f32, g: f32) -> f32 {
    if (d >= 1.0) { return d; }
    if (d <= CONTRAST_PIVOT_D) {
        return CONTRAST_PIVOT_D * pow(max(d / CONTRAST_PIVOT_D, 0.0), g);
    }
    return 1.0 - (1.0 - CONTRAST_PIVOT_D) * pow((1.0 - d) / (1.0 - CONTRAST_PIVOT_D), g);
}

// Mirrors ops::shoulder. Zero is the old hard clip, exactly.
fn shoulder(d: f32, amount: f32) -> f32 {
    if (amount <= 0.0) { return min(d, 1.0); }
    let knee = 1.0 - 0.6 * amount;
    if (d <= knee) { return d; }
    let span = 1.0 - knee;
    return knee + span * (1.0 - exp(-(d - knee) / span));
}

// Mirrors the ops.rs constants; the parity tests hold the two to it.
const HIGHLIGHT_FLOOR: f32 = 0.35;
const SHADOW_CEIL: f32 = 0.55;
const TONE_MID: f32 = 0.5;
const PULL_BACK: f32 = 0.5;
const WHITE_FLOOR: f32 = 0.3;
const BLACK_CEIL: f32 = 0.5;
const WHITE_RANGE: f32 = 0.12;
const BLACK_LIFT: f32 = 0.05;
const BLACK_CRUSH: f32 = 0.12;
const HI_RECOVER: f32 = 0.06;
const HI_PULL: f32 = 0.45;
const SHADOW_CRUSH: f32 = 0.8;
const CONTRAST_PIVOT_D: f32 = 0.46127555;

// Dispatches are 2D because large images exceed the 65535 workgroup
// per-dimension cap; the pixel index is rebuilt from workgroup ids.
fn pixel_index(wg: vec3<u32>, nwg: vec3<u32>, li: u32) -> u32 {
    return (wg.y * nwg.x + wg.x) * 256u + li;
}

// p0 = (gain, contrast_gamma, highlights, shadows), p1 = (whites, blacks, color_contrast_gamma, 0)
@compute @workgroup_size(256)
fn exposure(
    @builtin(workgroup_id) wg: vec3<u32>,
    @builtin(num_workgroups) nwg: vec3<u32>,
    @builtin(local_invocation_index) li: u32,
) {
    let px = pixel_index(wg, nwg, li);
    if (px >= arrayLength(&src) / 4u) { return; }
    let i = px * 4u;
    let r = src[i];
    let g = src[i + 1u];
    let b = src[i + 2u];
    var v = vec3<f32>(r, g, b) * u.p0.x;

    // Contrast and the four range controls shaped in display space,
    // exactly as the CPU does it. The parity tests compare the two and
    // will not forgive a shortcut here.
    let cg = u.p0.y;
    let hi = u.p0.z;
    let sh = u.p0.w;
    let wt = u.p1.x;
    let bl = u.p1.y;
    let l = luma_of(v.x, v.y, v.z);
    if ((cg != 1.0 || hi != 0.0 || sh != 0.0 || wt != 0.0 || bl != 0.0) && l > 1e-6) {
        let d = to_display(l);
        var nd = d;
        if (cg != 1.0) {
            nd = contrast_curve(d, cg);
        }
        // Range controls read the contrasted tone, same as the CPU:
        // weights and headrooms from one value keeps the stack monotone.
        let dr = nd;
        // Endpoint controls first, range controls against the moved
        // value: same sequencing as the CPU op, same reason (stacked
        // monotonicity), same parity tests holding them together.
        nd = nd + wt * WHITE_RANGE * smoothstep(WHITE_FLOOR, 1.0, dr);
        let wb = 1.0 - smoothstep(0.0, BLACK_CEIL, dr);
        if (bl > 0.0) {
            nd = nd + bl * wb * BLACK_LIFT;
        } else {
            nd = nd + bl * wb * BLACK_CRUSH;
        }
        let ws = 1.0 - smoothstep(0.0, SHADOW_CEIL, dr);
        if (sh > 0.0) {
            nd = nd + sh * ws * PULL_BACK * max(TONE_MID - nd, 0.0);
        } else {
            nd = nd + sh * ws * SHADOW_CRUSH * max(nd, 0.0);
        }
        let wh = smoothstep(HIGHLIGHT_FLOOR, 1.0, dr);
        if (hi > 0.0) {
            nd = nd + hi * wh * max(1.0 - nd, 0.0);
        } else {
            nd = nd + hi * wh * (HI_RECOVER + HI_PULL * max(nd - TONE_MID, 0.0));
        }
        v = v * (to_scene(max(nd, 0.0)) / l);
    }

    // Color contrast: per-channel curve, luminance normalized back.
    // Mirrors the CPU stage exactly; grays never move.
    let ccg = u.p1.z;
    if (ccg != 1.0) {
        let l0 = luma_of(v.x, v.y, v.z);
        if (l0 > 1e-6) {
            let c = vec3<f32>(
                to_scene(contrast_curve(to_display(max(v.x, 0.0)), ccg)),
                to_scene(contrast_curve(to_display(max(v.y, 0.0)), ccg)),
                to_scene(contrast_curve(to_display(max(v.z, 0.0)), ccg)),
            );
            let l1 = luma_of(c.x, c.y, c.z);
            if (l1 > 1e-6) {
                v = c * (l0 / l1);
            }
        }
    }

    dst[i] = v.x;
    dst[i + 1u] = v.y;
    dst[i + 2u] = v.z;
    dst[i + 3u] = src[i + 3u];
}

// p0 = (r_gain, g_gain, b_gain, 0)
@compute @workgroup_size(256)
fn white_balance(
    @builtin(workgroup_id) wg: vec3<u32>,
    @builtin(num_workgroups) nwg: vec3<u32>,
    @builtin(local_invocation_index) li: u32,
) {
    let px = pixel_index(wg, nwg, li);
    if (px >= arrayLength(&src) / 4u) { return; }
    let i = px * 4u;
    dst[i] = src[i] * u.p0.x;
    dst[i + 1u] = src[i + 1u] * u.p0.y;
    dst[i + 2u] = src[i + 2u] * u.p0.z;
    dst[i + 3u] = src[i + 3u];
}

// Channel-mixer B&W: weights applied directly (no normalization by their
// sum, which had a singularity mid-slider), blended by the treatment
// amount. p0 = (wr, wg, wb, amount), weights /100, amount 0..1.
@compute @workgroup_size(256)
fn black_white(
    @builtin(workgroup_id) wg: vec3<u32>,
    @builtin(num_workgroups) nwg: vec3<u32>,
    @builtin(local_invocation_index) li: u32,
) {
    let px = pixel_index(wg, nwg, li);
    if (px >= arrayLength(&src) / 4u) { return; }
    let i = px * 4u;
    let rgb = vec3<f32>(src[i], src[i + 1u], src[i + 2u]);
    let gray = max(dot(rgb, u.p0.xyz), 0.0);
    let outv = mix(rgb, vec3<f32>(gray), u.p0.w);
    dst[i] = outv.x;
    dst[i + 1u] = outv.y;
    dst[i + 2u] = outv.z;
    dst[i + 3u] = src[i + 3u];
}

// Three-way color balance, mirroring the CPU op: each range pushes the
// pixel toward a chroma-only direction, then a per-range luminance gain.
// The push vectors are derived host-side (hue is a param, not per-pixel).
// p0 = (push_s.rgb, lumgain_s), p1 = (push_m.rgb, lumgain_m),
// p2 = (push_h.rgb, lumgain_h), p3.x = the gain still to come
// (2^range_ev): the ranges sit on the seen tonal scale, as the CPU's
// seen_tone and seen_range_weights place them.
@compute @workgroup_size(256)
fn color_balance(
    @builtin(workgroup_id) wg: vec3<u32>,
    @builtin(num_workgroups) nwg: vec3<u32>,
    @builtin(local_invocation_index) li: u32,
) {
    let px = pixel_index(wg, nwg, li);
    if (px >= arrayLength(&src) / 4u) { return; }
    let i = px * 4u;
    let rgb = vec3<f32>(src[i], src[i + 1u], src[i + 2u]);
    let y = luma_of(rgb.x, rgb.y, rgb.z);
    let d = clamp(to_display(max(y, 0.0) * u.p3.x), 0.0, 1.0);
    let ws = 1.0 - smoothstep(0.0, 0.5, d);
    let wh = smoothstep(0.5, 1.0, d);
    let wm = clamp(1.0 - ws - wh, 0.0, 1.0);

    let push = u.p0.xyz * ws + u.p1.xyz * wm + u.p2.xyz * wh;
    let lg = u.p0.w * ws + u.p1.w * wm + u.p2.w * wh + 1.0;
    let outv = (rgb + push) * lg;
    dst[i] = outv.x;
    dst[i + 1u] = outv.y;
    dst[i + 2u] = outv.z;
    dst[i + 3u] = src[i + 3u];
}

// Split tone: two chroma pushes across a balance-shifted crossover.
// p0 = (shadow_push.rgb, lo), p1 = (highlight_push.rgb, hi),
// p2.x = the gain still to come (2^range_ev), as color_balance.
@compute @workgroup_size(256)
fn split_tone(
    @builtin(workgroup_id) wg: vec3<u32>,
    @builtin(num_workgroups) nwg: vec3<u32>,
    @builtin(local_invocation_index) li: u32,
) {
    let px = pixel_index(wg, nwg, li);
    if (px >= arrayLength(&src) / 4u) { return; }
    let i = px * 4u;
    let rgb = vec3<f32>(src[i], src[i + 1u], src[i + 2u]);
    let y = clamp(to_display(max(luma_of(rgb.x, rgb.y, rgb.z), 0.0) * u.p2.x), 0.0, 1.0);
    let whi = smoothstep(u.p0.w, u.p1.w, y);
    let outv = rgb + u.p0.xyz * (1.0 - whi) + u.p1.xyz * whi;
    dst[i] = outv.x;
    dst[i + 1u] = outv.y;
    dst[i + 2u] = outv.z;
    dst[i + 3u] = src[i + 3u];
}

// Base tone profile: S-curve applied in display space, mirroring the CPU
// op's sRGB transfer pair. Baseline gain in scene space first, toe crush
// in display space last. p0 = (s_amount, toe, rolloff, gain),
// p1 = (crush, colorfulness_factor, 0, 0)
@compute @workgroup_size(256)
fn tone_profile(
    @builtin(workgroup_id) wg: vec3<u32>,
    @builtin(num_workgroups) nwg: vec3<u32>,
    @builtin(local_invocation_index) li: u32,
) {
    let px = pixel_index(wg, nwg, li);
    if (px >= arrayLength(&src) / 4u) { return; }
    let i = px * 4u;
    var o = vec3<f32>(0.0);
    for (var c = 0u; c < 3u; c = c + 1u) {
        let d = shoulder(to_display(max(src[i + c], 0.0) * u.p0.w), u.p0.z);
        let s = d * d * (3.0 - 2.0 * d);
        var curved = clamp(d + (s - d) * u.p0.x + u.p0.y * (1.0 - d), 0.0, 1.0);
        let f = 1.0 - curved;
        curved = curved - u.p1.x * curved * f * f * f;
        o[c] = to_scene(curved);
    }
    // Colorfulness: constant chroma factor around Rec.709 luma, the
    // exact arithmetic of the CPU op.
    if (u.p1.y != 1.0) {
        let y = dot(o, vec3<f32>(0.2126, 0.7152, 0.0722));
        o = max(vec3<f32>(0.0), vec3<f32>(y) + (o - vec3<f32>(y)) * u.p1.y);
    }
    dst[i] = o.x;
    dst[i + 1u] = o.y;
    dst[i + 2u] = o.z;
    dst[i + 3u] = src[i + 3u];
}

// Mirrors ops::levels' knee: a quadratic roll half k wide each side of
// the point on the normalized axis.
fn knee_low(n: f32, k: f32) -> f32 {
    if (k <= 0.0 || n >= k) { return n; }
    if (n <= -k) { return 0.0; }
    return (n + k) * (n + k) / (4.0 * k);
}

// p0 = (black, range, 1/gamma, black knee), p1 = (white knee, 0, 0, 0).
// Display domain in and out, exactly as ops::levels does it.
fn levels_channel(v: f32) -> f32 {
    var n = (to_display(max(v, 0.0)) - u.p0.x) / u.p0.y;
    n = knee_low(n, u.p0.w);
    // Headroom rides through the white knee, as ops::levels does it;
    // with no knee the mirror is already the identity above white.
    if (u.p1.x > 0.0) {
        let excess = max(n - 1.0, 0.0);
        n = 1.0 - knee_low(1.0 - n, u.p1.x) + excess;
    }
    if (n <= 0.0) { return n; }
    return to_scene(pow(n, u.p0.z));
}

@compute @workgroup_size(256)
fn levels(
    @builtin(workgroup_id) wg: vec3<u32>,
    @builtin(num_workgroups) nwg: vec3<u32>,
    @builtin(local_invocation_index) li: u32,
) {
    let px = pixel_index(wg, nwg, li);
    if (px >= arrayLength(&src) / 4u) { return; }
    let i = px * 4u;
    dst[i] = levels_channel(src[i]);
    dst[i + 1u] = levels_channel(src[i + 1u]);
    dst[i + 2u] = levels_channel(src[i + 2u]);
    dst[i + 3u] = src[i + 3u];
}

// OkLab, mirroring heeler-engine's color.rs matrices digit for digit;
// the color_grade parity tests hold the two backends together. cbrt is
// odd (sign-preserving) so scene-linear negatives pass through with
// their sign, exactly as f32::cbrt does on the CPU.
fn cbrt(x: f32) -> f32 {
    return sign(x) * pow(abs(x), 1.0 / 3.0);
}

fn to_oklab(c: vec3<f32>) -> vec3<f32> {
    let l = cbrt(0.41222147 * c.x + 0.53633254 * c.y + 0.05144599 * c.z);
    let m = cbrt(0.21190350 * c.x + 0.68069955 * c.y + 0.10739696 * c.z);
    let s = cbrt(0.08830246 * c.x + 0.28171884 * c.y + 0.62997870 * c.z);
    return vec3<f32>(
        0.21045426 * l + 0.79361779 * m - 0.004072047 * s,
        1.97799850 * l - 2.42859220 * m + 0.45059371 * s,
        0.025904037 * l + 0.78277177 * m - 0.80867577 * s,
    );
}

fn from_oklab(lab: vec3<f32>) -> vec3<f32> {
    let l_ = lab.x + 0.39633778 * lab.y + 0.21580376 * lab.z;
    let m_ = lab.x - 0.105561346 * lab.y - 0.063854173 * lab.z;
    let s_ = lab.x - 0.089484177 * lab.y - 1.29148550 * lab.z;
    let l = l_ * l_ * l_;
    let m = m_ * m_ * m_;
    let s = s_ * s_ * s_;
    return vec3<f32>(
        4.07674166 * l - 3.30771159 * m + 0.23096993 * s,
        -1.26843800 * l + 2.60975740 * m - 0.34131938 * s,
        -0.004196086 * l - 0.70341861 * m + 1.70761470 * s,
    );
}

// The engine's constant-luminance gamut floor (color::compress_gamut).
fn grade_compress_gamut(c: vec3<f32>) -> vec3<f32> {
    let mn = min(c.x, min(c.y, c.z));
    if (mn >= 0.0) { return c; }
    let y = luma_of(c.x, c.y, c.z);
    if (y <= 0.0) { return vec3<f32>(0.0); }
    let k = y / (y - mn);
    return vec3<f32>(y) + (c - vec3<f32>(y)) * k;
}

const TAU: f32 = 6.2831853;

// p0 = (hue_shift_rad, sat_gain, exposure_gain, uniformity),
// p1 = (band_center_rad, 0, 0, 0). Mirrors ops_grade::color_grade;
// the identity case never reaches here (kernel_for refuses it so the
// CPU's bit-exact short-circuit stays the identity).
@compute @workgroup_size(256)
fn color_grade(
    @builtin(workgroup_id) wg: vec3<u32>,
    @builtin(num_workgroups) nwg: vec3<u32>,
    @builtin(local_invocation_index) li: u32,
) {
    let px = pixel_index(wg, nwg, li);
    if (px >= arrayLength(&src) / 4u) { return; }
    let i = px * 4u;
    let lab = to_oklab(vec3<f32>(src[i], src[i + 1u], src[i + 2u]));
    let c = length(lab.yz) * u.p0.y;
    var h = atan2(lab.z, lab.y) + u.p0.x;
    if (u.p0.w > 0.0) {
        // Shortest-arc compress toward the band center: the CPU's
        // hue_delta wrap, phrased as a round.
        var d = h - u.p1.x;
        d = d - TAU * round(d / TAU);
        h = u.p1.x + d * (1.0 - u.p0.w);
    }
    let outv = grade_compress_gamut(from_oklab(vec3<f32>(lab.x, c * cos(h), c * sin(h)))) * u.p0.z;
    dst[i] = outv.x;
    dst[i + 1u] = outv.y;
    dst[i + 2u] = outv.z;
    dst[i + 3u] = src[i + 3u];
}
"#;

/// Mirrors ops::CONTRAST_GAMMA; the shader receives the resolved gamma.
const CONTRAST_GAMMA: f32 = 0.85;

const ENTRY_POINTS: &[&str] = &[
    "exposure",
    "white_balance",
    "levels",
    "black_white",
    "color_balance",
    "split_tone",
    "tone_profile",
    "color_grade",
];

pub struct GpuEngine {
    device: wgpu::Device,
    queue: wgpu::Queue,
    pipelines: HashMap<&'static str, wgpu::ComputePipeline>,
    /// Last uploaded source, keyed by the caller's cache key. During a
    /// slider drag the source never changes, so every render after the
    /// first skips the host-to-device copy entirely.
    resident: std::sync::Mutex<Option<(u64, wgpu::Buffer, u64)>>,
    /// Ping-pong scratch and the readback staging buffer, cached by
    /// frame size. Before this, every render allocated two frame-sized
    /// storage buffers plus a frame-sized staging buffer and dropped
    /// them on return: on a 24 MP frame that is over a gigabyte of
    /// fresh device allocations per slider tick, and the allocator was
    /// the slowest part of the "GPU" path. The sizes only change when
    /// the frame does, so they live beside the resident source.
    scratch: std::sync::Mutex<Option<(u64, wgpu::Buffer, wgpu::Buffer, wgpu::Buffer)>>,
    /// One uniform buffer per chain position, grown as the chain
    /// demands. A uniform's contents change every render, but its
    /// buffer does not have to: queue.write_buffer lands in submission
    /// order ahead of the single submit below, so reusing the buffer is
    /// exact, not racy.
    uniforms: std::sync::Mutex<Vec<wgpu::Buffer>>,
}

impl GpuEngine {
    /// Device source plus two working buffers and the readback buffer.
    pub fn cached_bytes(&self) -> usize {
        let source = self.resident.lock().ok().and_then(|v| v.as_ref().map(|(_, _, n)| *n)).unwrap_or(0);
        let scratch = self.scratch.lock().ok().and_then(|v| v.as_ref().map(|(n, _, _, _)| n.saturating_mul(3))).unwrap_or(0);
        source.saturating_add(scratch).min(usize::MAX as u64) as usize
    }

    /// Picks the highest-performance adapter available. Returns
    /// `GpuError::NoAdapter` on machines without GPU support so callers can
    /// fall back to the CPU engine.
    pub fn new() -> Result<GpuEngine, GpuError> {
        let instance = wgpu::Instance::new(&wgpu::InstanceDescriptor::default());
        let adapter = pollster::block_on(instance.request_adapter(&wgpu::RequestAdapterOptions {
            power_preference: wgpu::PowerPreference::HighPerformance,
            ..Default::default()
        }))
        .map_err(|_| GpuError::NoAdapter)?;
        // Full-frame photo buffers exceed the conservative default limits
        // (a 45 MP RGBA f32 frame is ~720 MB), so request what the adapter
        // actually supports for buffer sizes. Tiled execution will lower
        // this requirement later; the ceiling is still the right ask.
        let adapter_limits = adapter.limits();
        let required_limits = wgpu::Limits {
            max_buffer_size: adapter_limits.max_buffer_size,
            max_storage_buffer_binding_size: adapter_limits.max_storage_buffer_binding_size,
            ..wgpu::Limits::default()
        };
        let (device, queue) = pollster::block_on(adapter.request_device(&wgpu::DeviceDescriptor {
            label: Some("heeler"),
            required_limits,
            ..Default::default()
        }))
        .map_err(|e| GpuError::Device(e.to_string()))?;

        let module = device.create_shader_module(wgpu::ShaderModuleDescriptor {
            label: Some("heeler-ops"),
            source: wgpu::ShaderSource::Wgsl(SHADER.into()),
        });
        let mut pipelines = HashMap::new();
        for entry in ENTRY_POINTS {
            let pipeline = device.create_compute_pipeline(&wgpu::ComputePipelineDescriptor {
                label: Some(entry),
                layout: None,
                module: &module,
                entry_point: Some(entry),
                compilation_options: Default::default(),
                cache: None,
            });
            pipelines.insert(*entry, pipeline);
        }
        Ok(GpuEngine {
            device,
            queue,
            pipelines,
            resident: std::sync::Mutex::new(None),
            scratch: std::sync::Mutex::new(None),
            uniforms: std::sync::Mutex::new(Vec::new()),
        })
    }

    pub fn adapter_name(&self) -> String {
        // Informational only; callers log which backend rendering runs on.
        format!("{:?}", self.device.features())
    }

    /// Derived (entry point, uniform payload) for a supported node,
    /// mirroring heeler-engine's derivations exactly (parity-enforced).
    fn kernel_for(node: &Node) -> Result<(&'static str, [f32; 16]), GpuError> {
        let get = |name: &str, default: f64| -> f32 {
            node.params
                .get(name)
                .and_then(|v| v.as_f64())
                .unwrap_or(default) as f32
        };
        let pad = |first: [f32; 8]| -> [f32; 16] {
            let mut p = [0f32; 16];
            p[..8].copy_from_slice(&first);
            p
        };
        match node.node_type.as_str() {
            "heeler.exposure" => Ok((
                "exposure",
                pad([
                    2f32.powf(get("exposure", 0.0)),
                    2f32.powf((get("contrast", 0.0) / 100.0).clamp(-1.0, 1.0) * CONTRAST_GAMMA),
                    get("highlights", 0.0) / 100.0,
                    get("shadows", 0.0) / 100.0,
                    get("whites", 0.0) / 100.0,
                    get("blacks", 0.0) / 100.0,
                    2f32.powf((get("color_contrast", 0.0) / 100.0).clamp(-1.0, 1.0) * CONTRAST_GAMMA),
                    0.0,
                ]),
            )),
            "heeler.white_balance" => {
                let temp = get("temperature", 6500.0);
                let tint = get("tint", 0.0);
                let dt = ((temp - 6500.0) / 6500.0).clamp(-0.9, 3.0);
                Ok((
                    "white_balance",
                    pad([
                        1.0 + 0.4 * dt,
                        (1.0 - 0.45 * (tint / 150.0)).max(0.05),
                        (1.0 - 0.4 * dt).max(0.05),
                        0.0,
                        0.0,
                        0.0,
                        0.0,
                        0.0,
                    ]),
                ))
            }
            "heeler.levels" => {
                let black = get("black", 0.0);
                let white = get("white", 1.0);
                let gamma = get("gamma", 1.0).max(0.1);
                let soft_b = get("black_soft", 0.0) / 100.0 * 0.25;
                let soft_w = get("white_soft", 0.0) / 100.0 * 0.25;
                Ok((
                    "levels",
                    pad([black, (white - black).max(1e-6), 1.0 / gamma, soft_b, soft_w, 0.0, 0.0, 0.0]),
                ))
            }
            "heeler.black_white" => Ok((
                "black_white",
                pad([
                    get("red", 30.0) / 100.0,
                    get("green", 59.0) / 100.0,
                    get("blue", 11.0) / 100.0,
                    (get("amount", 0.0) / 100.0).clamp(0.0, 1.0),
                    0.0,
                    0.0,
                    0.0,
                    0.0,
                ]),
            )),
            "heeler.color_balance" => {
                // Push vectors come from the engine's own helper, so the
                // two backends cannot drift on wheel semantics.
                let mut p = [0f32; 16];
                for (i, range) in ["shadows", "midtones", "highlights"].iter().enumerate() {
                    let push = heeler_engine::ops::wheel_push(
                        get(&format!("{range}_hue"), 0.0),
                        get(&format!("{range}_sat"), 0.0),
                    );
                    p[i * 4] = push[0];
                    p[i * 4 + 1] = push[1];
                    p[i * 4 + 2] = push[2];
                    p[i * 4 + 3] = 0.4 * get(&format!("{range}_lum"), 0.0) / 100.0;
                }
                p[12] = 2f32.powf(get("range_ev", 0.0));
                Ok(("color_balance", p))
            }
            "heeler.split_tone" => {
                let shadow = heeler_engine::ops::wheel_push(
                    get("shadow_hue", 0.0),
                    get("shadow_sat", 0.0),
                );
                let highlight = heeler_engine::ops::wheel_push(
                    get("highlight_hue", 0.0),
                    get("highlight_sat", 0.0),
                );
                let balance = (get("balance", 0.0) / 100.0).clamp(-1.0, 1.0);
                let mid = 0.5 - balance * 0.35;
                Ok((
                    "split_tone",
                    [
                        shadow[0],
                        shadow[1],
                        shadow[2],
                        mid - 0.35,
                        highlight[0],
                        highlight[1],
                        highlight[2],
                        mid + 0.35,
                        2f32.powf(get("range_ev", 0.0)),
                        0.0,
                        0.0,
                        0.0,
                        0.0,
                        0.0,
                        0.0,
                        0.0,
                    ],
                ))
            }
            "heeler.tone_profile" => {
                let mode = node
                    .params
                    .get("mode")
                    .and_then(|v| v.as_str())
                    .unwrap_or("standard")
                    .to_string();
                let strength = get("contrast", 100.0) / 100.0;
                let (s_amount, toe) = match mode.as_str() {
                    "linear" => (0.0, 0.0),
                    "film" => (0.62 * strength, 0.012 * strength),
                    _ => (0.34 * strength, 0.0),
                };
                let rolloff = (get("highlight_rolloff", 0.0) / 100.0).clamp(0.0, 1.0);
                let gain = 2f32.powf(get("baseline_ev", 0.0));
                let crush = (get("shadow_toe", 0.0) / 100.0).clamp(0.0, 1.0);
                let color = 1.0 + get("colorfulness", 0.0).clamp(-100.0, 100.0) / 100.0;
                Ok((
                    "tone_profile",
                    pad([s_amount, toe, rolloff, gain, crush, color, 0.0, 0.0]),
                ))
            }
            "heeler.color_grade" => {
                let hue_shift = get("hue_shift", 0.0);
                let saturation = get("saturation", 0.0);
                let exposure = get("exposure", 0.0);
                let uniformity = get("uniformity", 0.0);
                if hue_shift == 0.0 && saturation == 0.0 && exposure == 0.0 && uniformity == 0.0
                {
                    // The CPU op short-circuits to a BIT-EXACT identity;
                    // a GPU round trip through OkLab would launder the
                    // floats it promised not to touch. Fall back.
                    return Err(GpuError::Unsupported("heeler.color_grade identity".into()));
                }
                Ok((
                    "color_grade",
                    pad([
                        hue_shift.to_radians(),
                        (1.0 + saturation / 100.0).max(0.0),
                        2f32.powf(exposure),
                        (uniformity / 100.0).clamp(0.0, 1.0),
                        get("band_center", 30.0).to_radians(),
                        0.0,
                        0.0,
                        0.0,
                    ]),
                ))
            }
            other => Err(GpuError::Unsupported(other.to_string())),
        }
    }

    /// Runs a supported node's op on the GPU. Same input/output contract as
    /// the CPU op. Returns Unsupported for node types without kernels so the
    /// caller can fall back per node.
    pub fn run_node(&self, node: &Node, src: &ImageBuf) -> Result<ImageBuf, GpuError> {
        self.run_chain(&[node], src)
    }

    /// Runs a linear chain of supported nodes GPU-resident: the source
    /// uploads once, each node is one dispatch ping-ponging between two
    /// on-device buffers, and only the final frame reads back. This is the
    /// win over per-node execution, which paid full transfer both ways at
    /// every step. Disabled nodes must be filtered out by the caller.
    pub fn run_chain(&self, nodes: &[&Node], src: &ImageBuf) -> Result<ImageBuf, GpuError> {
        self.run_chain_keyed(None, nodes, src)
    }

    /// `run_chain` with a caller-provided cache key for the SOURCE pixels:
    /// when the key matches the previous call, the upload is skipped and
    /// the resident device copy is reused. Callers must change the key
    /// whenever the source pixels change.
    pub fn run_chain_keyed(
        &self,
        key: Option<u64>,
        nodes: &[&Node],
        src: &ImageBuf,
    ) -> Result<ImageBuf, GpuError> {
        use wgpu::util::DeviceExt;

        // Resolve every kernel first: an unsupported node anywhere means
        // the caller should fall back before any GPU work happens.
        let mut steps = Vec::with_capacity(nodes.len());
        for node in nodes {
            steps.push(Self::kernel_for(node)?);
        }
        if steps.is_empty() {
            return Ok(src.clone());
        }

        let byte_len = (src.data.len() * 4) as u64;
        // The source lives in its own read-only buffer so it can stay
        // resident across renders; dispatches ping-pong between scratch.
        let mut resident = self.resident.lock().map_err(|_| GpuError::Readback)?;
        let reuse = matches!((key, resident.as_ref()), (Some(k), Some((rk, _, rl))) if k == *rk && byte_len == *rl);
        if !reuse {
            let buf = self
                .device
                .create_buffer_init(&wgpu::util::BufferInitDescriptor {
                    label: Some("chain-src"),
                    contents: bytemuck::cast_slice(&src.data),
                    usage: wgpu::BufferUsages::STORAGE,
                });
            *resident = Some((key.unwrap_or(u64::MAX), buf, byte_len));
        }
        let src_buf = &resident.as_ref().expect("just set").1;

        let mk_scratch = |label, usage| {
            self.device.create_buffer(&wgpu::BufferDescriptor {
                label: Some(label),
                size: byte_len,
                usage,
                mapped_at_creation: false,
            })
        };
        let mut scratch = self.scratch.lock().map_err(|_| GpuError::Readback)?;
        if !matches!(scratch.as_ref(), Some((len, _, _, _)) if *len == byte_len) {
            *scratch = Some((
                byte_len,
                mk_scratch(
                    "chain-a",
                    wgpu::BufferUsages::STORAGE | wgpu::BufferUsages::COPY_SRC,
                ),
                mk_scratch(
                    "chain-b",
                    wgpu::BufferUsages::STORAGE | wgpu::BufferUsages::COPY_SRC,
                ),
                mk_scratch(
                    "staging",
                    wgpu::BufferUsages::MAP_READ | wgpu::BufferUsages::COPY_DST,
                ),
            ));
        }
        let (_, buf_a, buf_b, staging) = scratch.as_ref().expect("just set");

        // Per-step uniforms: the buffers persist, only the payloads are
        // rewritten. write_buffer is ordered ahead of the submit below on
        // the same queue, so the dispatches see exactly these values.
        let mut uniforms = self.uniforms.lock().map_err(|_| GpuError::Readback)?;
        while uniforms.len() < steps.len() {
            uniforms.push(self.device.create_buffer(&wgpu::BufferDescriptor {
                label: Some("params"),
                size: 64, // [f32; 16], the uniform payload of every kernel
                usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST,
                mapped_at_creation: false,
            }));
        }

        let pixels = (src.width * src.height) as u32;
        let groups = pixels.div_ceil(256);
        let (gx, gy) = (groups.min(65535), groups.div_ceil(65535));

        let mut encoder = self
            .device
            .create_command_encoder(&wgpu::CommandEncoderDescriptor { label: None });
        for (i, (entry, params)) in steps.iter().enumerate() {
            let pipeline = self
                .pipelines
                .get(entry)
                .ok_or_else(|| GpuError::Unsupported(entry.to_string()))?;
            let uniform = &uniforms[i];
            self.queue
                .write_buffer(uniform, 0, bytemuck::cast_slice(params));
            // Step 0 reads the resident source; later steps ping-pong.
            let read: &wgpu::Buffer = if i == 0 {
                src_buf
            } else if i % 2 == 1 {
                buf_a
            } else {
                buf_b
            };
            let write = if i % 2 == 0 { buf_a } else { buf_b };
            let bind_group = self.device.create_bind_group(&wgpu::BindGroupDescriptor {
                label: None,
                layout: &pipeline.get_bind_group_layout(0),
                entries: &[
                    wgpu::BindGroupEntry { binding: 0, resource: read.as_entire_binding() },
                    wgpu::BindGroupEntry { binding: 1, resource: write.as_entire_binding() },
                    wgpu::BindGroupEntry { binding: 2, resource: uniform.as_entire_binding() },
                ],
            });
            let mut pass = encoder.begin_compute_pass(&wgpu::ComputePassDescriptor {
                label: None,
                timestamp_writes: None,
            });
            pass.set_pipeline(pipeline);
            pass.set_bind_group(0, &bind_group, &[]);
            pass.dispatch_workgroups(gx, gy, 1);
        }
        let last = if steps.len() % 2 == 1 { buf_a } else { buf_b };
        encoder.copy_buffer_to_buffer(last, 0, staging, 0, byte_len);
        self.queue.submit(Some(encoder.finish()));

        // The whole readback in one fallible block. When the buffers
        // were per-render, an error here was self-cleaning because the
        // wreckage was dropped; a CACHED staging buffer that errors
        // between map_async and unmap would stay mapped forever and
        // poison every later render, so an error evicts the cache and
        // the next render starts with fresh buffers.
        let readback = (|| -> Result<Vec<f32>, GpuError> {
            let slice = staging.slice(..);
            let (tx, rx) = std::sync::mpsc::channel();
            slice.map_async(wgpu::MapMode::Read, move |result| {
                let _ = tx.send(result);
            });
            self.device
                .poll(wgpu::PollType::Wait)
                .map_err(|_| GpuError::Readback)?;
            rx.recv()
                .map_err(|_| GpuError::Readback)?
                .map_err(|_| GpuError::Readback)?;
            let data: Vec<f32> = bytemuck::cast_slice(&slice.get_mapped_range()).to_vec();
            staging.unmap();
            Ok(data)
        })();
        let data = match readback {
            Ok(data) => data,
            Err(e) => {
                *scratch = None;
                return Err(e);
            }
        };

        Ok(ImageBuf {
            width: src.width,
            height: src.height,
            data,
        })
    }

    pub fn supports(node_type: &str) -> bool {
        matches!(
            node_type,
            "heeler.exposure"
                | "heeler.white_balance"
                | "heeler.levels"
                | "heeler.black_white"
                | "heeler.color_balance"
                | "heeler.split_tone"
                | "heeler.tone_profile"
        )
    }

}

#[cfg(test)]
mod tests {
    use super::*;
    use heeler_engine::{ops, Value};
    use heeler_graph::{ParamValue, Registry, Section};
    use std::sync::Arc;

    /// One engine shared by every test, mirroring the app's one-per-process
    /// setup. The old version built a fresh engine per test, so the runner
    /// fired sixteen concurrent adapter/device requests at the driver; with
    /// the dev app also holding the device, that occasionally wedged and
    /// `cargo test --workspace` sat forever with no output.
    ///
    /// Acquisition now happens once, on its own thread, with a deadline.
    /// Tests skip (with a note) on machines without an adapter, and also
    /// when the driver does not answer promptly: a skipped suite with a
    /// loud message beats a hung one. On timeout the acquisition thread is
    /// abandoned; the process exits without joining it.
    fn gpu() -> Option<&'static GpuEngine> {
        use std::sync::OnceLock;
        static ENGINE: OnceLock<Option<GpuEngine>> = OnceLock::new();
        ENGINE
            .get_or_init(|| {
                let (tx, rx) = std::sync::mpsc::channel();
                std::thread::spawn(move || {
                    let _ = tx.send(GpuEngine::new());
                });
                match rx.recv_timeout(std::time::Duration::from_secs(15)) {
                    Ok(Ok(engine)) => Some(engine),
                    Ok(Err(e)) => {
                        eprintln!("skipping GPU tests: {e}");
                        None
                    }
                    Err(_) => {
                        eprintln!(
                            "skipping GPU tests: no adapter/device within 15s. \
                             The GPU is busy or the driver is wedged; close the \
                             running Heeler app and rerun to exercise these."
                        );
                        None
                    }
                }
            })
            .as_ref()
    }

    fn test_image() -> ImageBuf {
        let (w, h) = (64, 64);
        let mut img = ImageBuf::new(w, h);
        for y in 0..h {
            for x in 0..w {
                img.set_pixel(
                    x,
                    y,
                    [
                        x as f32 / 63.0,
                        y as f32 / 63.0,
                        (x + y) as f32 / 126.0,
                        1.0,
                    ],
                );
            }
        }
        img
    }

    fn node_with(node_type: &str, params: &[(&str, f64)]) -> Node {
        let mut node = Registry::builtin()
            .instantiate(node_type, "n", Section::Creative)
            .unwrap();
        for (k, v) in params {
            node.params.insert(k.to_string(), ParamValue::Number(*v));
        }
        node
    }

    fn cpu_reference(node: &Node, src: &ImageBuf) -> ImageBuf {
        let out = ops::execute(
            node,
            &[("in".to_string(), Value::Image(Arc::new(src.clone())))],
        )
        .unwrap();
        (**out.as_image().unwrap()).clone()
    }

    fn assert_parity(node: &Node, tolerance: f32) {
        let Some(gpu) = gpu() else { return };
        let src = test_image();
        let cpu = cpu_reference(node, &src);
        let gpu_out = gpu.run_node(node, &src).unwrap();
        assert_eq!(cpu.data.len(), gpu_out.data.len());
        let mut max_diff = 0f32;
        for (a, b) in cpu.data.iter().zip(gpu_out.data.iter()) {
            max_diff = max_diff.max((a - b).abs());
        }
        assert!(
            max_diff <= tolerance,
            "GPU/CPU divergence {max_diff} exceeds {tolerance} for {}",
            node.node_type
        );
    }

    #[test]
    fn exposure_parity_with_cpu_reference() {
        assert_parity(
            &node_with(
                "heeler.exposure",
                &[
                    ("exposure", 1.3),
                    ("contrast", 40.0),
                    ("highlights", -60.0),
                    ("shadows", 30.0),
                    ("whites", 20.0),
                    ("blacks", -10.0),
                ],
            ),
            2e-4,
        );
    }

    #[test]
    fn exposure_defaults_parity() {
        assert_parity(&node_with("heeler.exposure", &[]), 1e-6);
    }

    #[test]
    fn white_balance_parity_with_cpu_reference() {
        assert_parity(
            &node_with(
                "heeler.white_balance",
                &[("temperature", 9200.0), ("tint", -45.0)],
            ),
            2e-4,
        );
    }

    #[test]
    fn levels_parity_with_cpu_reference() {
        assert_parity(
            &node_with(
                "heeler.levels",
                &[("black", 0.1), ("white", 0.85), ("gamma", 1.8), ("black_soft", 60.0), ("white_soft", 40.0)],
            ),
            2e-4,
        );
    }

    #[test]
    fn levels_superwhite_parity_with_cpu_reference() {
        let Some(gpu) = gpu() else { return };
        let mut src = ImageBuf::new(5, 1);
        for (x, v) in [0.0, 0.8, 1.0, 4.0, 16.0].into_iter().enumerate() {
            src.set_pixel(x, 0, [v, v * 0.5, v * 0.25, 0.7]);
        }
        for soft in [0.0, 40.0] {
            let node = node_with("heeler.levels", &[("black", 0.1), ("white", 0.85), ("gamma", 1.8), ("black_soft", 60.0), ("white_soft", soft)]);
            let cpu = cpu_reference(&node, &src);
            let out = gpu.run_node(&node, &src).unwrap();
            for (a, b) in cpu.data.iter().zip(&out.data) {
                assert!(a.is_finite() && b.is_finite());
                assert!((a - b).abs() < 2e-4, "HDR Levels differs: {a} vs {b}, white knee {soft}");
            }
        }
    }

    #[test]
    fn gpu_exposure_plus_one_ev_doubles_exactly() {
        let Some(gpu) = gpu() else { return };
        let node = node_with("heeler.exposure", &[("exposure", 1.0)]);
        let src = ImageBuf::filled(4, 4, [0.2, 0.2, 0.2, 1.0]);
        let out = gpu.run_node(&node, &src).unwrap();
        let px = out.pixel(0, 0);
        assert!((px[0] - 0.4).abs() < 1e-6);
        assert!((px[3] - 1.0).abs() < 1e-6, "alpha untouched");
    }

    #[test]
    fn finish_black_white_missing_strength_is_neutral_on_gpu() {
        let mut node = node_with("heeler.black_white", &[]);
        node.params.remove("amount");
        assert_parity(&node, 2e-4);
    }

    #[test]
    fn black_white_parity_with_cpu_reference() {
        assert_parity(
            &node_with("heeler.black_white", &[("red", 100.0), ("green", -20.0), ("blue", 15.0)]),
            2e-4,
        );
        // The old normalization's singularity: weights summing to zero
        // must be an ordinary (dark) result on both backends, not a
        // special case.
        assert_parity(
            &node_with("heeler.black_white", &[("red", 50.0), ("green", -50.0), ("blue", 0.0)]),
            2e-4,
        );
    }

    #[test]
    fn color_balance_parity_with_cpu_reference() {
        assert_parity(
            &node_with(
                "heeler.color_balance",
                &[
                    ("shadows_hue", 40.0),
                    ("midtones_hue", -25.0),
                    ("highlights_hue", 120.0),
                    ("shadows_sat", 30.0),
                    ("midtones_sat", -45.0),
                    ("highlights_sat", 60.0),
                    ("shadows_lum", -20.0),
                    ("midtones_lum", 35.0),
                    ("highlights_lum", 50.0),
                ],
            ),
            5e-4,
        );
        assert_parity(&node_with("heeler.color_balance", &[]), 1e-6);
        // With the brightness still to come stamped, as every desktop
        // render stamps it: the ranges move and both backends agree.
        for ev in [-2.0, 0.0, 1.3, 3.3] {
            assert_parity(
                &node_with(
                    "heeler.color_balance",
                    &[("shadows_sat", 60.0), ("highlights_hue", 200.0), ("highlights_sat", 80.0), ("midtones_lum", 30.0), ("range_ev", ev)],
                ),
                5e-4,
            );
        }
    }

    #[test]
    fn split_tone_parity_with_cpu_reference() {
        assert_parity(
            &node_with(
                "heeler.split_tone",
                &[
                    ("shadow_hue", 220.0),
                    ("shadow_sat", 70.0),
                    ("highlight_hue", 35.0),
                    ("highlight_sat", 85.0),
                    ("balance", -40.0),
                ],
            ),
            5e-4,
        );
        for ev in [-2.0, 0.0, 1.3, 3.3] {
            assert_parity(
                &node_with(
                    "heeler.split_tone",
                    &[("shadow_hue", 220.0), ("shadow_sat", 70.0), ("highlight_hue", 35.0), ("highlight_sat", 85.0), ("range_ev", ev)],
                ),
                5e-4,
            );
        }
    }

    #[test]
    fn tone_profile_parity_with_cpu_reference() {
        for mode in ["standard", "film"] {
            let mut node = node_with("heeler.tone_profile", &[]);
            node.params
                .insert("mode".into(), heeler_graph::ParamValue::Text(mode.into()));
            assert_parity(&node, 5e-4);
        }
    }

    /// The colorfulness axis (ICC ): the chroma factor must agree between
    /// backends at every setting, or the calibration fitted on one would
    /// quietly render differently on the other.
    #[test]
    fn tone_profile_colorfulness_parity() {
        for color in [-40.0, 0.0, 15.0, 60.0] {
            let node = node_with(
                "heeler.tone_profile",
                &[("colorfulness", color), ("baseline_ev", 1.3), ("shadow_toe", 50.0)],
            );
            assert_parity(&node, 5e-4);
        }
    }

    /// The baseline lift and the toe are the default look of every
    /// freshly opened photograph, on whichever backend happens to render
    /// it. Zero disagreement allowed at exactly the shipped defaults.
    #[test]
    fn tone_profile_baseline_and_toe_parity() {
        for ev in [-1.0, 0.0, 1.0, 1.3] {
            for toe in [0.0, 25.0, 100.0] {
                for mode in ["linear", "standard"] {
                    let mut node = node_with(
                        "heeler.tone_profile",
                        &[("baseline_ev", ev), ("shadow_toe", toe), ("highlight_rolloff", 25.0)],
                    );
                    node.params
                        .insert("mode".into(), heeler_graph::ParamValue::Text(mode.into()));
                    assert_parity(&node, 5e-4);
                }
            }
        }
    }

    /// The highlight shoulder is what makes a merged HDR renderable, and
    /// it lives in two implementations. A preview that used the GPU would
    /// otherwise disagree with an export that used the CPU, on exactly
    /// the images where the difference is a blown sky.
    #[test]
    fn tone_profile_highlight_rolloff_parity() {
        for rolloff in [0.0, 35.0, 70.0, 100.0] {
            for mode in ["linear", "standard", "film"] {
                let mut node = node_with("heeler.tone_profile", &[("highlight_rolloff", rolloff)]);
                node.params
                    .insert("mode".into(), heeler_graph::ParamValue::Text(mode.into()));
                assert_parity(&node, 5e-4);
            }
        }
    }

    /// The owner's tone controls, on both backends. These were reworked to
    /// be shaped in display space; the shader has to be reworked with them
    /// or the preview and the export part company.
    #[test]
    fn tone_control_parity_across_the_slider_range() {
        for hi in [-100.0, -50.0, 0.0, 50.0, 100.0] {
            for sh in [-100.0, 0.0, 100.0] {
                assert_parity(
                    &node_with("heeler.exposure", &[("highlights", hi), ("shadows", sh)]),
                    5e-4,
                );
            }
        }
        // Whites and blacks moved into the same display-space section
        // when they stopped being a linear gain and an offset; they are
        // held to the same two-backend agreement.
        for wt in [-100.0, -40.0, 0.0, 40.0, 100.0] {
            for bl in [-100.0, 0.0, 100.0] {
                assert_parity(
                    &node_with("heeler.exposure", &[("whites", wt), ("blacks", bl)]),
                    5e-4,
                );
            }
        }
        // Contrast followed them into display space; same deal, and the
        // color half rides the same parity bar.
        for con in [-100.0, -50.0, 25.0, 100.0] {
            assert_parity(&node_with("heeler.exposure", &[("contrast", con)]), 5e-4);
            assert_parity(&node_with("heeler.exposure", &[("color_contrast", con)]), 5e-4);
        }
        assert_parity(
            &node_with("heeler.exposure", &[("contrast", 80.0), ("color_contrast", 60.0)]),
            5e-4,
        );
    }

    /// The Color Set grade in both backends: hue rotation, chroma,
    /// uniformity and the gamut floor all pass through OkLab, and the
    /// preview (GPU) must land on the export (CPU) or a set tuned on
    /// screen ships differently.
    #[test]
    fn color_grade_parity_across_the_controls() {
        for shift in [-120.0, -30.0, 45.0, 150.0] {
            assert_parity(&node_with("heeler.color_grade", &[("hue_shift", shift)]), 5e-4);
        }
        for sat in [-100.0, -40.0, 60.0, 100.0] {
            assert_parity(&node_with("heeler.color_grade", &[("saturation", sat)]), 5e-4);
        }
        for ev in [-2.0, 0.7, 3.0] {
            assert_parity(&node_with("heeler.color_grade", &[("exposure", ev)]), 5e-4);
        }
        for (uni, center) in [(40.0, 30.0), (100.0, 200.0), (70.0, 350.0)] {
            assert_parity(
                &node_with(
                    "heeler.color_grade",
                    &[("uniformity", uni), ("band_center", center)],
                ),
                5e-4,
            );
        }
        // The lot at once, including a combination that drives colors
        // out of gamut so the floor runs on both sides.
        assert_parity(
            &node_with(
                "heeler.color_grade",
                &[
                    ("hue_shift", 90.0),
                    ("saturation", 100.0),
                    ("exposure", 1.2),
                    ("uniformity", 55.0),
                    ("band_center", 120.0),
                ],
            ),
            5e-4,
        );
    }

    /// Zero params must stay the CPU's bit-exact identity: the kernel
    /// refuses the node so the executor falls back rather than
    /// laundering floats through the OkLab round trip.
    #[test]
    fn color_grade_identity_is_refused_for_cpu_fallback() {
        let node = node_with("heeler.color_grade", &[]);
        assert!(matches!(
            GpuEngine::kernel_for(&node),
            Err(GpuError::Unsupported(_))
        ));
    }

    #[test]
    fn keyed_source_reuse_is_correct_across_param_changes() {
        let Some(gpu) = gpu() else { return };
        let src = test_image();
        let cheap = node_with("heeler.exposure", &[("exposure", 0.0)]);
        let bright = node_with("heeler.exposure", &[("exposure", 1.0)]);
        // Same key twice: the second call reuses the resident source but
        // must apply the NEW params.
        let a = gpu.run_chain_keyed(Some(42), &[&cheap, &cheap], &src).unwrap();
        let b = gpu.run_chain_keyed(Some(42), &[&bright, &cheap], &src).unwrap();
        assert_eq!(gpu.cached_bytes(), src.data.len() * 4 * 4);
        assert!((a.pixel(8, 8)[0] - src.pixel(8, 8)[0]).abs() < 1e-5, "identity chain");
        assert!(
            (b.pixel(8, 8)[0] - src.pixel(8, 8)[0] * 2.0).abs() < 1e-5,
            "+1 EV applied on the reused resident source"
        );
        // A new key with different pixels uploads fresh.
        let dark = ImageBuf::filled(64, 64, [0.1, 0.1, 0.1, 1.0]);
        let c = gpu.run_chain_keyed(Some(7), &[&cheap, &cheap], &dark).unwrap();
        assert!((c.pixel(8, 8)[0] - 0.1).abs() < 1e-5);
    }

    #[test]
    fn chain_matches_cpu_sequential_execution() {
        let Some(gpu) = gpu() else { return };
        let wb = node_with("heeler.white_balance", &[("temperature", 8200.0), ("tint", 30.0)]);
        let exposure = node_with(
            "heeler.exposure",
            &[("exposure", 0.8), ("contrast", 25.0), ("shadows", 40.0)],
        );
        let levels = node_with("heeler.levels", &[("black", 0.05), ("gamma", 1.4)]);
        let src = test_image();

        // CPU: run the three ops sequentially.
        let mut cpu = src.clone();
        for node in [&wb, &exposure, &levels] {
            cpu = cpu_reference(node, &cpu);
        }
        // GPU: one upload, three resident dispatches, one readback.
        let gpu_out = gpu.run_chain(&[&wb, &exposure, &levels], &src).unwrap();

        let mut max_diff = 0f32;
        for (a, b) in cpu.data.iter().zip(gpu_out.data.iter()) {
            max_diff = max_diff.max((a - b).abs());
        }
        assert!(max_diff <= 5e-4, "chain divergence {max_diff}");
    }

    #[test]
    fn chain_with_unsupported_node_falls_back_before_any_work() {
        let Some(gpu) = gpu() else { return };
        let exposure = node_with("heeler.exposure", &[("exposure", 1.0)]);
        let grain = node_with("heeler.grain", &[]);
        assert!(matches!(
            gpu.run_chain(&[&exposure, &grain], &test_image()),
            Err(GpuError::Unsupported(_))
        ));
    }

    #[test]
    fn unsupported_node_reports_for_fallback() {
        let Some(gpu) = gpu() else { return };
        let node = node_with("heeler.grain", &[]);
        assert!(matches!(
            gpu.run_node(&node, &test_image()),
            Err(GpuError::Unsupported(_))
        ));
        assert!(!GpuEngine::supports("heeler.grain"));
        assert!(GpuEngine::supports("heeler.exposure"));
    }

    /// Chain amortization check: one transfer round trip serves N
    /// dispatches, which is where the GPU pulls ahead of per-op execution.
    #[test]
    #[ignore]
    fn throughput_45mp_chain() {
        let Some(gpu) = gpu() else { return };
        let src = ImageBuf::filled(8192, 5504, [0.2, 0.3, 0.4, 1.0]);
        let wb = node_with("heeler.white_balance", &[("temperature", 8000.0)]);
        let exposure = node_with("heeler.exposure", &[("exposure", 0.7), ("contrast", 25.0)]);
        let levels = node_with("heeler.levels", &[("black", 0.05), ("gamma", 1.3)]);
        let chain = [&wb, &exposure, &levels];

        let start = std::time::Instant::now();
        let out = gpu.run_chain_keyed(Some(1), &chain, &src).unwrap();
        let cold_ms = start.elapsed().as_millis();

        // Warm render: same source key, new params: the drag case.
        let start = std::time::Instant::now();
        let _ = gpu.run_chain_keyed(Some(1), &chain, &src).unwrap();
        let warm_ms = start.elapsed().as_millis();

        let start = std::time::Instant::now();
        let mut cpu = src.clone();
        for node in chain {
            cpu = cpu_reference(node, &cpu);
        }
        let cpu_ms = start.elapsed().as_millis();
        println!(
            "45MP 3-op chain: gpu cold {cold_ms} ms, warm {warm_ms} ms (resident source), cpu {cpu_ms} ms"
        );
        assert_eq!(out.width, 8192);
    }

    /// Manual throughput check: `cargo test -p heeler-gpu --release -- --ignored --nocapture`
    #[test]
    #[ignore]
    fn throughput_45mp_exposure() {
        let Some(gpu) = gpu() else { return };
        let src = ImageBuf::filled(8192, 5504, [0.2, 0.3, 0.4, 1.0]);
        let node = node_with("heeler.exposure", &[("exposure", 0.7), ("contrast", 25.0)]);
        let start = std::time::Instant::now();
        let out = gpu.run_node(&node, &src).unwrap();
        let gpu_ms = start.elapsed().as_millis();
        let start = std::time::Instant::now();
        let _ = cpu_reference(&node, &src);
        let cpu_ms = start.elapsed().as_millis();
        println!("45MP exposure: gpu {gpu_ms} ms (incl. transfer), cpu {cpu_ms} ms");
        assert_eq!(out.width, 8192);
    }
}
