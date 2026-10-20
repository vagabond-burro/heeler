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
    fn a_develop_matrix_keeps_white_white() {
        let cam_xyz = [[0.836, -0.296, -0.074], [-0.413, 1.208, 0.229], [-0.086, 0.196, 0.597]];
        let (m, _) = srgb_from_camera(&cam_xyz).unwrap();
        for row in m {
            assert!((row.iter().sum::<f64>() - 1.0).abs() < 1e-9);
        }
    }
}
