//! The color math of a develop: a camera's XYZ-to-camera matrix turned
//! into the camera-to-sRGB matrix a develop multiplies by.

/// sRGB primaries (linear) to CIE XYZ, D65 white (IEC 61966-2-1),
/// to seven places, the precision LibRaw develops with.
pub const XYZ_FROM_SRGB: [[f64; 3]; 3] = [[0.4124564, 0.3575761, 0.1804375], [0.2126729, 0.7151522, 0.0721750], [0.0193339, 0.1191920, 0.9503041]];

/// The D65 white point in XYZ, Y = 1.
pub const D65: [f32; 3] = [0.95047, 1.0, 1.08883];

pub fn mul3(a: &[[f64; 3]; 3], b: &[[f64; 3]; 3]) -> [[f64; 3]; 3] {
    let mut m = [[0.0; 3]; 3];
    for i in 0..3 {
        for j in 0..3 {
            for k in 0..3 {
                m[i][j] += a[i][k] * b[k][j];
            }
        }
    }
    m
}

pub fn invert3(m: &[[f64; 3]; 3]) -> Option<[[f64; 3]; 3]> {
    let det = m[0][0] * (m[1][1] * m[2][2] - m[1][2] * m[2][1]) - m[0][1] * (m[1][0] * m[2][2] - m[1][2] * m[2][0]) + m[0][2] * (m[1][0] * m[2][1] - m[1][1] * m[2][0]);
    if det.abs() < 1e-12 {
        return None;
    }
    let mut r = [[0.0; 3]; 3];
    for i in 0..3 {
        for j in 0..3 {
            let (a, b) = ((j + 1) % 3, (j + 2) % 3);
            let (c, d) = ((i + 1) % 3, (i + 2) % 3);
            r[i][j] = (m[a][c] * m[b][d] - m[a][d] * m[b][c]) / det;
        }
    }
    Some(r)
}

pub fn as3(v: &[f64]) -> Option<[[f64; 3]; 3]> {
    (v.len() == 9).then(|| [[v[0], v[1], v[2]], [v[3], v[4], v[5]], [v[6], v[7], v[8]]])
}

/// The camera-to-sRGB matrix for an XYZ-to-camera matrix: the camera's
/// response to each sRGB primary, each row scaled so sRGB white reads as
/// camera white (1, 1, 1), then inverted. Also the white balance that
/// matrix implies (the reciprocal of each row's sum before scaling).
pub fn srgb_from_camera(cam_xyz: &[[f64; 3]; 3]) -> Option<([[f64; 3]; 3], [f64; 3])> {
    let mut cam_rgb = mul3(cam_xyz, &XYZ_FROM_SRGB);
    let mut implied = [0.0; 3];
    for (row, w) in cam_rgb.iter_mut().zip(&mut implied) {
        let sum: f64 = row.iter().sum();
        if sum.abs() < 1e-12 {
            return None;
        }
        for v in row.iter_mut() {
            *v /= sum;
        }
        *w = 1.0 / sum;
    }
    Some((invert3(&cam_rgb)?, implied))
}

/// The ICC D50 white, Y = 1: the white the DNG color model maps to.
pub const D50: [f64; 3] = [0.96422, 1.0, 0.82521];

type M3 = [[f64; 3]; 3];

pub fn apply(m: &M3, v: [f64; 3]) -> [f64; 3] {
    [0, 1, 2].map(|i| m[i][0] * v[0] + m[i][1] * v[1] + m[i][2] * v[2])
}

pub fn diag(v: [f64; 3]) -> M3 {
    [[v[0], 0.0, 0.0], [0.0, v[1], 0.0], [0.0, 0.0, v[2]]]
}

/// Bradford chromatic adaptation from white `src` to white `dst` (XYZ).
pub fn bradford(src: [f64; 3], dst: [f64; 3]) -> M3 {
    const B: M3 = [[0.8951, 0.2664, -0.1614], [-0.7502, 1.7135, 0.0367], [0.0389, -0.0685, 1.0296]];
    let (s, d) = (apply(&B, src), apply(&B, dst));
    mul3(&invert3(&B).unwrap(), &mul3(&diag([d[0] / s[0], d[1] / s[1], d[2] / s[2]]), &B))
}

/// Correlated color temperature of a chromaticity (McCamy, 1992), clamped
/// to 2000 to 50000 K.
pub fn cct(x: f64, y: f64) -> f64 {
    let n = (x - 0.3320) / (0.1858 - y);
    (449.0 * n.powi(3) + 3525.0 * n.powi(2) + 6823.3 * n + 5520.33).clamp(2000.0, 50000.0)
}

/// A camera's color calibration in the DNG specification's terms: up to
/// two calibrations, each under its own illuminant (EXIF LightSource
/// codes), as XYZ to camera matrices (ColorMatrix), per-unit adjustments
/// (CameraCalibration), and white-balanced camera to XYZ (D50) matrices
/// (ForwardMatrix); and the AnalogBalance.
#[derive(Clone, Debug, Default)]
pub struct Profile {
    pub illuminants: [u32; 2],
    pub color_matrix: [Option<M3>; 2],
    pub camera_calibration: [Option<M3>; 2],
    pub forward_matrix: [Option<M3>; 2],
    pub analog_balance: Option<[f64; 3]>,
}

/// The DNG specification's camera to XYZ (D50) matrix (chapter 6, "Mapping
/// Camera Color Space to CIE XYZ Space") for `neutral`, the camera's
/// response to the scene's white: the two calibrations weighted by that
/// white's color temperature (linearly in its reciprocal between theirs,
/// the white found by iterating), then through the ForwardMatrix where the
/// profile has one, else through the inverted ColorMatrix and a Bradford
/// adaptation to D50. A profile's hue and saturation tables are not part
/// of this. None for a profile without a usable matrix.
pub fn camera_to_xyz_d50(p: &Profile, neutral: [f64; 3]) -> Option<M3> {
    let id = diag([1.0; 3]);
    let ab = diag(p.analog_balance.unwrap_or([1.0; 3]));
    let t1 = crate::dng::illuminant_kelvin(p.illuminants[0]) as f64;
    let t2 = crate::dng::illuminant_kelvin(p.illuminants[1]) as f64;
    let cm1 = p.color_matrix[0]?;
    let cm2 = p.color_matrix[1];
    let (cc1, cc2) = (p.camera_calibration[0].unwrap_or(id), p.camera_calibration[1].unwrap_or(id));
    let weight = |t: f64| -> f64 {
        if cm2.is_none() || t1 <= 0.0 || t2 <= 0.0 || t1 == t2 {
            return 1.0;
        }
        ((1.0 / t - 1.0 / t2) / (1.0 / t1 - 1.0 / t2)).clamp(0.0, 1.0)
    };
    let mix = |a: &M3, b: Option<M3>, g: f64| -> M3 {
        match b {
            Some(b) => [0, 1, 2].map(|i| [0, 1, 2].map(|j| g * a[i][j] + (1.0 - g) * b[i][j])),
            None => *a,
        }
    };
    let mut xy = (0.3457, 0.3585);
    let mut xyz_to_cam = id;
    for _ in 0..20 {
        let g = weight(cct(xy.0, xy.1));
        xyz_to_cam = mul3(&ab, &mul3(&mix(&cc1, Some(cc2), g), &mix(&cm1, cm2, g)));
        let w = apply(&invert3(&xyz_to_cam)?, neutral);
        let s = w[0] + w[1] + w[2];
        if !(s.is_finite() && s.abs() > 1e-12) {
            return None;
        }
        xy = (w[0] / s, w[1] / s);
    }
    let g = weight(cct(xy.0, xy.1));
    match p.forward_matrix[0] {
        Some(fm1) => {
            let abcc = mul3(&ab, &mix(&cc1, Some(cc2), g));
            let r = apply(&invert3(&abcc)?, neutral);
            let d = diag([1.0 / r[0], 1.0 / r[1], 1.0 / r[2]]);
            Some(mul3(&mix(&fm1, p.forward_matrix[1], g), &mul3(&d, &invert3(&abcc)?)))
        }
        None => {
            let white = [xy.0 / xy.1, 1.0, (1.0 - xy.0 - xy.1) / xy.1];
            Some(mul3(&bradford(white, D50), &invert3(&xyz_to_cam)?))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_srgb_camera_develops_to_the_identity() {
        let cam_xyz = invert3(&XYZ_FROM_SRGB).unwrap();
        let (m, wb) = srgb_from_camera(&cam_xyz).unwrap();
        for i in 0..3 {
            assert!((wb[i] - 1.0).abs() < 1e-4, "{wb:?}");
            for j in 0..3 {
                assert!((m[i][j] - if i == j { 1.0 } else { 0.0 }).abs() < 1e-9);
            }
        }
    }

    #[test]
    fn the_dng_model_takes_the_white_to_d50_white() {
        // A calibration pair (Standard A, D65) with and without forward
        // matrices: the camera's white under either light lands on D50.
        let cm_a = [[0.8664, -0.4056, 0.0403], [-0.4565, 1.2378, 0.2453], [-0.0301, 0.0889, 0.7157]];
        let cm_d65 = [[0.7374, -0.2389, -0.0551], [-0.5435, 1.3162, 0.2519], [-0.1006, 0.1795, 0.6552]];
        let fm = [[0.6558, 0.247, 0.0615], [0.2273, 0.8504, -0.0776], [0.0083, -0.2636, 1.0804]];
        for forward in [false, true] {
            let p = Profile { illuminants: [17, 21], color_matrix: [Some(cm_a), Some(cm_d65)], forward_matrix: if forward { [Some(fm), Some(fm)] } else { [None, None] }, ..Default::default() };
            for white_xyz in [apply(&XYZ_FROM_SRGB, [1.0; 3]), [1.0985, 1.0, 0.3558]] {
                let neutral = apply(&cm_d65, white_xyz);
                let m = camera_to_xyz_d50(&p, neutral).unwrap();
                let out = apply(&m, neutral);
                let k = out[1];
                for c in 0..3 {
                    assert!((out[c] / k - D50[c]).abs() < 2e-3, "forward {forward}: {out:?}");
                }
            }
        }
    }

    #[test]
    fn under_daylight_the_dng_model_is_the_daylight_calibration() {
        // A white of D65 weights the D65 matrix alone; the model is then
        // its inverse adapted to D50, which sends sRGB white to D50.
        let cm_a = [[0.9, -0.3, 0.0], [-0.4, 1.3, 0.1], [0.0, 0.1, 0.8]];
        let cm_d65 = [[0.7374, -0.2389, -0.0551], [-0.5435, 1.3162, 0.2519], [-0.1006, 0.1795, 0.6552]];
        let p = Profile { illuminants: [17, 21], color_matrix: [Some(cm_a), Some(cm_d65)], ..Default::default() };
        let d65 = apply(&XYZ_FROM_SRGB, [1.0; 3]);
        let m = camera_to_xyz_d50(&p, apply(&cm_d65, d65)).unwrap();
        let want = mul3(&bradford(d65, D50), &invert3(&cm_d65).unwrap());
        for i in 0..3 {
            for j in 0..3 {
                assert!((m[i][j] - want[i][j]).abs() < 2e-3, "{m:?} vs {want:?}");
            }
        }
    }

    #[test]
    fn a_develop_matrix_keeps_white_white() {
        let cam_xyz = [[0.836, -0.296, -0.074], [-0.413, 1.208, 0.229], [-0.086, 0.196, 0.597]];
        let (m, _) = srgb_from_camera(&cam_xyz).unwrap();
        for row in m {
            assert!((row.iter().sum::<f64>() - 1.0).abs() < 1e-9);
        }
    }
}
