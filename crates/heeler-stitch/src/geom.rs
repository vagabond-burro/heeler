//! 3x3 matrices, small dense solves, and fitting a homography to point
//! correspondences.
//!
//! Everything here runs in f64 even though the images are f32. A
//! homography fit is a badly conditioned problem: the design matrix
//! mixes pixel coordinates near a thousand with products of them near a
//! million, and in f32 the small terms disappear into rounding. The
//! conditioning is fixed properly below (Hartley normalization), but the
//! arithmetic stays in f64 because it costs nothing at these sizes.

/// Row-major 3x3.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Mat3(pub [f64; 9]);

impl Mat3 {
    pub const IDENTITY: Mat3 = Mat3([1.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0]);

    pub fn mul(&self, other: &Mat3) -> Mat3 {
        let mut out = [0.0; 9];
        for r in 0..3 {
            for c in 0..3 {
                let mut acc = 0.0;
                for k in 0..3 {
                    acc += self.0[r * 3 + k] * other.0[k * 3 + c];
                }
                out[r * 3 + c] = acc;
            }
        }
        Mat3(out)
    }

    /// Maps a point, dividing through by the third coordinate. Returns
    /// None when that coordinate is zero, which is a point the mapping
    /// sends to infinity: real for a homography, and not something the
    /// caller can draw.
    pub fn apply(&self, x: f64, y: f64) -> Option<(f64, f64)> {
        let m = &self.0;
        let w = m[6] * x + m[7] * y + m[8];
        if w.abs() < 1e-12 {
            return None;
        }
        Some(((m[0] * x + m[1] * y + m[2]) / w, (m[3] * x + m[4] * y + m[5]) / w))
    }

    pub fn det(&self) -> f64 {
        let m = &self.0;
        m[0] * (m[4] * m[8] - m[5] * m[7]) - m[1] * (m[3] * m[8] - m[5] * m[6])
            + m[2] * (m[3] * m[7] - m[4] * m[6])
    }

    pub fn inverse(&self) -> Option<Mat3> {
        let d = self.det();
        if d.abs() < 1e-14 {
            return None;
        }
        let m = &self.0;
        let inv = [
            (m[4] * m[8] - m[5] * m[7]) / d,
            (m[2] * m[7] - m[1] * m[8]) / d,
            (m[1] * m[5] - m[2] * m[4]) / d,
            (m[5] * m[6] - m[3] * m[8]) / d,
            (m[0] * m[8] - m[2] * m[6]) / d,
            (m[2] * m[3] - m[0] * m[5]) / d,
            (m[3] * m[7] - m[4] * m[6]) / d,
            (m[1] * m[6] - m[0] * m[7]) / d,
            (m[0] * m[4] - m[1] * m[3]) / d,
        ];
        Some(Mat3(inv))
    }

    /// Scales so the bottom-right entry is 1. A homography is only
    /// defined up to scale, so two that differ by a factor are the same
    /// mapping; comparing them without this is comparing arbitrary
    /// numbers.
    pub fn normalised(&self) -> Mat3 {
        let s = self.0[8];
        if s.abs() < 1e-12 {
            return *self;
        }
        let mut out = self.0;
        for v in &mut out {
            *v /= s;
        }
        Mat3(out)
    }
}

impl Mat3 {
    pub fn transpose(&self) -> Mat3 {
        let m = &self.0;
        Mat3([m[0], m[3], m[6], m[1], m[4], m[7], m[2], m[5], m[8]])
    }

    /// Multiplies a column vector.
    pub fn mul_vec(&self, v: [f64; 3]) -> [f64; 3] {
        let m = &self.0;
        [
            m[0] * v[0] + m[1] * v[1] + m[2] * v[2],
            m[3] * v[0] + m[4] * v[1] + m[5] * v[2],
            m[6] * v[0] + m[7] * v[1] + m[8] * v[2],
        ]
    }

    /// Nearest rotation, by Gram-Schmidt.
    ///
    /// Rotations composed from measured data drift off the manifold: the
    /// product of two nearly-orthonormal matrices is slightly less
    /// orthonormal, and after a chain of ten images the accumulated skew
    /// is visible as a shear in the panorama.
    pub fn orthonormalised(&self) -> Mat3 {
        let m = &self.0;
        let mut r0 = [m[0], m[1], m[2]];
        let mut r1 = [m[3], m[4], m[5]];
        normalise3(&mut r0);
        let d = dot3(r1, r0);
        for i in 0..3 {
            r1[i] -= d * r0[i];
        }
        normalise3(&mut r1);
        let r2 = cross3(r0, r1);
        Mat3([r0[0], r0[1], r0[2], r1[0], r1[1], r1[2], r2[0], r2[1], r2[2]])
    }
}

pub fn dot3(a: [f64; 3], b: [f64; 3]) -> f64 {
    a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
}

pub fn cross3(a: [f64; 3], b: [f64; 3]) -> [f64; 3] {
    [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
}

pub fn normalise3(v: &mut [f64; 3]) {
    let n = dot3(*v, *v).sqrt();
    if n > 1e-15 {
        for c in v.iter_mut() {
            *c /= n;
        }
    }
}

/// Rotation from an axis-angle vector, whose direction is the axis and
/// whose length is the angle. Rodrigues' formula.
///
/// Three numbers for three degrees of freedom, which is what a solver
/// wants: a nine-number matrix carries six constraints the optimizer
/// would have to be stopped from violating, and Euler angles gimbal lock
/// exactly where a panorama looks up.
pub fn rodrigues(w: [f64; 3]) -> Mat3 {
    let theta = dot3(w, w).sqrt();
    if theta < 1e-12 {
        return Mat3::IDENTITY;
    }
    let (s, c) = theta.sin_cos();
    let k = [w[0] / theta, w[1] / theta, w[2] / theta];
    let v = 1.0 - c;
    Mat3([
        c + k[0] * k[0] * v,
        k[0] * k[1] * v - k[2] * s,
        k[0] * k[2] * v + k[1] * s,
        k[1] * k[0] * v + k[2] * s,
        c + k[1] * k[1] * v,
        k[1] * k[2] * v - k[0] * s,
        k[2] * k[0] * v - k[1] * s,
        k[2] * k[1] * v + k[0] * s,
        c + k[2] * k[2] * v,
    ])
}

/// The axis-angle vector a rotation came from.
pub fn inverse_rodrigues(m: &Mat3) -> [f64; 3] {
    let r = &m.0;
    let trace = r[0] + r[4] + r[8];
    let cos = ((trace - 1.0) * 0.5).clamp(-1.0, 1.0);
    let theta = cos.acos();
    if theta < 1e-9 {
        return [0.0, 0.0, 0.0];
    }
    // Half a turn: the antisymmetric part vanishes and the axis has to
    // come from the diagonal instead. Rare, but a panorama that wraps
    // right around passes through it.
    if (std::f64::consts::PI - theta).abs() < 1e-6 {
        let mut axis = [
            ((r[0] + 1.0) * 0.5).max(0.0).sqrt(),
            ((r[4] + 1.0) * 0.5).max(0.0).sqrt(),
            ((r[8] + 1.0) * 0.5).max(0.0).sqrt(),
        ];
        // Signs from the off-diagonal entries, relative to the largest
        // component which is the only one whose sign is free.
        let major = (0..3).max_by(|&a, &b| axis[a].partial_cmp(&axis[b]).unwrap()).unwrap();
        match major {
            0 => {
                axis[1] = axis[1].copysign(r[1] + r[3]);
                axis[2] = axis[2].copysign(r[2] + r[6]);
            }
            1 => {
                axis[0] = axis[0].copysign(r[1] + r[3]);
                axis[2] = axis[2].copysign(r[5] + r[7]);
            }
            _ => {
                axis[0] = axis[0].copysign(r[2] + r[6]);
                axis[1] = axis[1].copysign(r[5] + r[7]);
            }
        }
        normalise3(&mut axis);
        return [axis[0] * theta, axis[1] * theta, axis[2] * theta];
    }
    let s = 2.0 * theta.sin();
    [(r[7] - r[5]) / s * theta, (r[2] - r[6]) / s * theta, (r[3] - r[1]) / s * theta]
}

/// Eigenvalues and eigenvectors of a symmetric 3x3, by cyclic Jacobi
/// rotations. Values ascending; column `i` of the returned matrix is the
/// eigenvector for value `i`.
///
/// Used for one thing: finding the axis a set of camera orientations
/// varies least about, which is the direction the horizon runs.
pub fn symmetric_eigen(m: &Mat3) -> ([f64; 3], Mat3) {
    let mut a = m.0;
    let mut v = Mat3::IDENTITY.0;
    for _ in 0..64 {
        // Largest off-diagonal entry: zero it, repeat until there is
        // nothing left off the diagonal worth zeroing.
        let (mut p, mut q, mut max) = (0usize, 1usize, 0.0f64);
        for (i, j) in [(0usize, 1usize), (0, 2), (1, 2)] {
            if a[i * 3 + j].abs() > max {
                max = a[i * 3 + j].abs();
                p = i;
                q = j;
            }
        }
        if max < 1e-14 {
            break;
        }
        let theta = 0.5 * (a[q * 3 + q] - a[p * 3 + p]) / a[p * 3 + q];
        let t = theta.signum() / (theta.abs() + (theta * theta + 1.0).sqrt());
        let c = 1.0 / (t * t + 1.0).sqrt();
        let s = t * c;
        let mut rot = Mat3::IDENTITY.0;
        rot[p * 3 + p] = c;
        rot[q * 3 + q] = c;
        rot[p * 3 + q] = s;
        rot[q * 3 + p] = -s;
        let r = Mat3(rot);
        a = r.transpose().mul(&Mat3(a)).mul(&r).0;
        v = Mat3(v).mul(&r).0;
    }

    let mut values = [a[0], a[4], a[8]];
    let mut order = [0usize, 1, 2];
    order.sort_by(|&i, &j| values[i].partial_cmp(&values[j]).unwrap());
    let sorted_values = [values[order[0]], values[order[1]], values[order[2]]];
    values = sorted_values;
    let mut vectors = [0.0; 9];
    for (col, &src) in order.iter().enumerate() {
        for row in 0..3 {
            vectors[row * 3 + col] = v[row * 3 + src];
        }
    }
    (values, Mat3(vectors))
}

/// Solves a dense system by Gaussian elimination with partial pivoting.
/// `a` is n by n row-major and is consumed. None means singular.
pub fn solve(n: usize, mut a: Vec<f64>, mut b: Vec<f64>) -> Option<Vec<f64>> {
    for col in 0..n {
        // Pivot on the largest remaining entry. Without this a zero (or
        // merely small) pivot divides through and destroys the answer,
        // and degenerate point sets produce exactly that.
        let mut best = col;
        for r in col + 1..n {
            if a[r * n + col].abs() > a[best * n + col].abs() {
                best = r;
            }
        }
        if a[best * n + col].abs() < 1e-12 {
            return None;
        }
        if best != col {
            for c in 0..n {
                a.swap(col * n + c, best * n + c);
            }
            b.swap(col, best);
        }
        let pivot = a[col * n + col];
        for r in col + 1..n {
            let f = a[r * n + col] / pivot;
            if f == 0.0 {
                continue;
            }
            for c in col..n {
                a[r * n + c] -= f * a[col * n + c];
            }
            b[r] -= f * b[col];
        }
    }
    let mut x = vec![0.0; n];
    for r in (0..n).rev() {
        let mut acc = b[r];
        for c in r + 1..n {
            acc -= a[r * n + c] * x[c];
        }
        x[r] = acc / a[r * n + r];
    }
    if x.iter().any(|v| !v.is_finite()) {
        return None;
    }
    Some(x)
}

/// A similarity that moves a point set's centroid to the origin and
/// scales it so the mean distance from there is sqrt(2).
///
/// Hartley's normalization, and it is not optional. Fitting a homography
/// to raw pixel coordinates mixes terms of wildly different magnitude in
/// the same matrix, and the fit comes out dominated by whichever points
/// happen to have the largest coordinates. Normalizing first, then
/// undoing it afterwards, makes the result independent of where the
/// origin happened to be.
fn normalising_transform(pts: &[(f64, f64)]) -> Mat3 {
    let n = pts.len() as f64;
    let cx = pts.iter().map(|p| p.0).sum::<f64>() / n;
    let cy = pts.iter().map(|p| p.1).sum::<f64>() / n;
    let mean_dist = pts
        .iter()
        .map(|p| ((p.0 - cx).powi(2) + (p.1 - cy).powi(2)).sqrt())
        .sum::<f64>()
        / n;
    let s = if mean_dist > 1e-12 { 2f64.sqrt() / mean_dist } else { 1.0 };
    Mat3([s, 0.0, -s * cx, 0.0, s, -s * cy, 0.0, 0.0, 1.0])
}

/// Fits the homography taking `src` onto `dst`.
///
/// Four correspondences determine it exactly; more are solved in the
/// least-squares sense through the normal equations, which is what the
/// refit on RANSAC's inliers uses. Fewer than four is not a homography.
pub fn fit_homography(src: &[(f64, f64)], dst: &[(f64, f64)]) -> Option<Mat3> {
    if src.len() < 4 || src.len() != dst.len() {
        return None;
    }
    let t_src = normalising_transform(src);
    let t_dst = normalising_transform(dst);
    let sn: Vec<(f64, f64)> = src.iter().filter_map(|p| t_src.apply(p.0, p.1)).collect();
    let dn: Vec<(f64, f64)> = dst.iter().filter_map(|p| t_dst.apply(p.0, p.1)).collect();
    if sn.len() != src.len() || dn.len() != dst.len() {
        return None;
    }

    // Eight unknowns: the ninth entry is fixed at 1, since scale is
    // arbitrary. Each correspondence contributes two rows.
    let mut rows: Vec<[f64; 8]> = Vec::with_capacity(sn.len() * 2);
    let mut rhs: Vec<f64> = Vec::with_capacity(sn.len() * 2);
    for i in 0..sn.len() {
        let (x, y) = sn[i];
        let (u, v) = dn[i];
        rows.push([x, y, 1.0, 0.0, 0.0, 0.0, -u * x, -u * y]);
        rhs.push(u);
        rows.push([0.0, 0.0, 0.0, x, y, 1.0, -v * x, -v * y]);
        rhs.push(v);
    }

    // Normal equations: A'A h = A'b. An 8x8 solve regardless of how many
    // correspondences went in, and no SVD needed.
    let mut ata = vec![0.0; 64];
    let mut atb = vec![0.0; 8];
    for (row, r) in rows.iter().zip(&rhs) {
        for i in 0..8 {
            atb[i] += row[i] * r;
            for j in 0..8 {
                ata[i * 8 + j] += row[i] * row[j];
            }
        }
    }
    let h = solve(8, ata, atb)?;
    let hn = Mat3([h[0], h[1], h[2], h[3], h[4], h[5], h[6], h[7], 1.0]);

    // Undo the normalization: the fit was made in normalized space, and
    // the caller wants pixels.
    let inv = t_dst.inverse()?;
    Some(inv.mul(&hn).mul(&t_src).normalised())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn identity_maps_points_to_themselves() {
        assert_eq!(Mat3::IDENTITY.apply(3.0, 4.0), Some((3.0, 4.0)));
        assert_eq!(Mat3::IDENTITY.inverse(), Some(Mat3::IDENTITY));
    }

    #[test]
    fn inverse_undoes_the_mapping() {
        let m = Mat3([2.0, 0.3, 10.0, -0.1, 1.7, -5.0, 0.0004, 0.0002, 1.0]);
        let inv = m.inverse().unwrap();
        let round = m.mul(&inv).normalised();
        for (i, v) in round.0.iter().enumerate() {
            let want = Mat3::IDENTITY.0[i];
            assert!((v - want).abs() < 1e-9, "entry {i} is {v}");
        }
    }

    #[test]
    fn a_singular_matrix_has_no_inverse() {
        // Two identical rows: it collapses the plane onto a line.
        assert!(Mat3([1.0, 2.0, 3.0, 1.0, 2.0, 3.0, 4.0, 5.0, 6.0]).inverse().is_none());
    }

    #[test]
    fn solve_handles_a_system_that_needs_pivoting() {
        // A zero in the first pivot position: without row swapping this
        // divides by zero on the first step. 2*x1 = 4 and x0 + 3*x1 = 11,
        // so x1 = 2 and x0 = 5.
        let a = vec![0.0, 2.0, 1.0, 3.0];
        let b = vec![4.0, 11.0];
        let x = solve(2, a, b).unwrap();
        assert!((x[0] - 5.0).abs() < 1e-9 && (x[1] - 2.0).abs() < 1e-9, "got {x:?}");
        assert!(solve(2, vec![1.0, 2.0, 2.0, 4.0], vec![1.0, 2.0]).is_none(), "singular");
    }

    fn apply_all(m: &Mat3, pts: &[(f64, f64)]) -> Vec<(f64, f64)> {
        pts.iter().map(|p| m.apply(p.0, p.1).unwrap()).collect()
    }

    #[test]
    fn fitting_recovers_the_transform_that_made_the_points() {
        let src = vec![(10.0, 20.0), (400.0, 35.0), (390.0, 300.0), (25.0, 280.0), (150.0, 160.0)];
        // A rotation, a scale, a translation and a little perspective.
        let truth = Mat3([0.94, -0.31, 42.0, 0.29, 0.97, -17.0, 0.0002, 0.0001, 1.0]).normalised();
        let dst = apply_all(&truth, &src);
        let got = fit_homography(&src, &dst).unwrap();
        for (i, v) in got.0.iter().enumerate() {
            assert!((v - truth.0[i]).abs() < 1e-6, "entry {i}: {v} vs {}", truth.0[i]);
        }
    }

    /// Four points is the minimum, and it has to work: RANSAC fits from
    /// exactly four on every one of its trials.
    #[test]
    fn four_correspondences_are_enough() {
        let src = vec![(0.0, 0.0), (100.0, 0.0), (100.0, 100.0), (0.0, 100.0)];
        let truth = Mat3([1.1, 0.2, 5.0, -0.15, 0.95, 12.0, 0.0003, -0.0001, 1.0]).normalised();
        let dst = apply_all(&truth, &src);
        let got = fit_homography(&src, &dst).unwrap();
        for p in &src {
            let (gx, gy) = got.apply(p.0, p.1).unwrap();
            let (tx, ty) = truth.apply(p.0, p.1).unwrap();
            assert!((gx - tx).abs() < 1e-6 && (gy - ty).abs() < 1e-6);
        }
        assert!(fit_homography(&src[..3], &dst[..3]).is_none(), "three is not enough");
    }

    /// Hartley normalization is the reason this works at all. Points a
    /// long way from the origin are exactly the case that breaks a naive
    /// fit, and photographs are full of them.
    #[test]
    fn fitting_survives_coordinates_far_from_the_origin() {
        let src: Vec<(f64, f64)> = vec![
            (5000.0, 4000.0),
            (5400.0, 4020.0),
            (5390.0, 4300.0),
            (5020.0, 4280.0),
            (5200.0, 4150.0),
        ];
        let truth = Mat3([0.98, -0.05, 7.0, 0.04, 1.01, -3.0, 0.00001, 0.00002, 1.0]).normalised();
        let dst = apply_all(&truth, &src);
        let got = fit_homography(&src, &dst).unwrap();
        for p in &src {
            let (gx, gy) = got.apply(p.0, p.1).unwrap();
            let (tx, ty) = truth.apply(p.0, p.1).unwrap();
            assert!((gx - tx).abs() < 1e-4 && (gy - ty).abs() < 1e-4, "drifted at {p:?}");
        }
    }

    #[test]
    fn rodrigues_round_trips() {
        for w in [
            [0.0, 0.0, 0.0],
            [0.3, -0.2, 0.1],
            [0.0, 1.2, 0.0],
            [-0.7, 0.4, 0.9],
            [0.001, 0.0, 0.0],
        ] {
            let m = rodrigues(w);
            let back = inverse_rodrigues(&m);
            for i in 0..3 {
                assert!((back[i] - w[i]).abs() < 1e-9, "{w:?} came back as {back:?}");
            }
            // And it really is a rotation: orthonormal, determinant one.
            assert!((m.det() - 1.0).abs() < 1e-12, "det {}", m.det());
            let should_be_identity = m.mul(&m.transpose());
            for (i, v) in should_be_identity.0.iter().enumerate() {
                assert!((v - Mat3::IDENTITY.0[i]).abs() < 1e-12);
            }
        }
    }

    /// Half a turn is where the usual axis extraction divides by zero,
    /// and a panorama that wraps right around goes through it.
    #[test]
    fn rodrigues_survives_a_half_turn() {
        for axis in [[1.0, 0.0, 0.0], [0.0, 1.0, 0.0], [0.0, 0.0, 1.0], [0.577, 0.577, 0.577]] {
            let w = [
                axis[0] * std::f64::consts::PI,
                axis[1] * std::f64::consts::PI,
                axis[2] * std::f64::consts::PI,
            ];
            let m = rodrigues(w);
            let back = rodrigues(inverse_rodrigues(&m));
            for (i, v) in back.0.iter().enumerate() {
                assert!((v - m.0[i]).abs() < 1e-6, "half turn about {axis:?} lost entry {i}");
            }
        }
    }

    #[test]
    fn orthonormalising_repairs_a_drifted_rotation() {
        let clean = rodrigues([0.2, -0.5, 0.3]);
        // Skew it the way a chain of multiplications would.
        let mut drifted = clean.0;
        drifted[1] += 0.02;
        drifted[5] -= 0.015;
        drifted[8] += 0.01;
        let fixed = Mat3(drifted).orthonormalised();
        assert!((fixed.det() - 1.0).abs() < 1e-12, "det {}", fixed.det());
        let i = fixed.mul(&fixed.transpose());
        for (k, v) in i.0.iter().enumerate() {
            assert!((v - Mat3::IDENTITY.0[k]).abs() < 1e-12);
        }
        // And it stayed near the rotation it came from.
        for (k, v) in fixed.0.iter().enumerate() {
            assert!((v - clean.0[k]).abs() < 0.05, "moved too far at {k}");
        }
    }

    #[test]
    fn symmetric_eigen_finds_known_axes() {
        // Diagonal, so the answers are the entries and the axes.
        let (vals, vecs) = symmetric_eigen(&Mat3([3.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 7.0]));
        assert!((vals[0] - 1.0).abs() < 1e-9 && (vals[2] - 7.0).abs() < 1e-9, "{vals:?}");
        // Smallest eigenvalue's vector is the y axis.
        let v0 = [vecs.0[0], vecs.0[3], vecs.0[6]];
        assert!(v0[1].abs() > 0.999, "smallest axis is {v0:?}");
    }

    /// The case straightening actually uses: points spread widely in two
    /// directions and hardly at all in a third. The third is the answer.
    #[test]
    fn symmetric_eigen_finds_the_direction_of_least_spread() {
        let dirs = [[1.0, 0.0, 0.02], [0.7, 0.7, -0.01], [0.0, 1.0, 0.015], [-0.7, 0.7, 0.0]];
        let mut cov = [0.0f64; 9];
        for d in dirs {
            for r in 0..3 {
                for c in 0..3 {
                    cov[r * 3 + c] += d[r] * d[c];
                }
            }
        }
        let (_, vecs) = symmetric_eigen(&Mat3(cov));
        let up = [vecs.0[0], vecs.0[3], vecs.0[6]];
        assert!(up[2].abs() > 0.99, "expected the z axis, got {up:?}");
    }

    /// Collinear points do not determine a homography. Returning a
    /// confident wrong answer here would put a garbage transform into
    /// RANSAC's inlier count.
    #[test]
    fn degenerate_point_sets_are_refused() {
        let src = vec![(0.0, 0.0), (10.0, 0.0), (20.0, 0.0), (30.0, 0.0)];
        let dst = vec![(0.0, 5.0), (10.0, 5.0), (20.0, 5.0), (30.0, 5.0)];
        assert!(fit_homography(&src, &dst).is_none(), "collinear points fitted anyway");
    }
}
