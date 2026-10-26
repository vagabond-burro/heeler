//! The quarter curves of the Phase One P40+ and P65+, the response
//! correction LibRaw applies to each quarter of their frames (iiq_cal.rs
//! step 2), as found from the files' bytes against LibRaw's loaded image.
//!
//! These backs read their sensor in quarters (top left, top right, bottom
//! left, bottom right, split at the container's 0x0222 and 0x0224) and
//! correct each quarter's response by a curve. The calibration block's
//! entries used:
//!
//! - 0x041F, the levels: 32-bit words, for each quarter in that order 16
//!   increasing levels (a quarter's response at 16 exposures, all four
//!   quarters given the same value at the twelfth), then a 1.
//! - 0x041E, the gains: "II", a 16-bit 1, then twenty 32-bit floats, of
//!   which the 4th, 10th, 14th and 18th are the quarters' gains (0 for
//!   none). Absent, the gains are 0.
//!
//! The entries 0x0420 to 0x0428 (eight more tables of levels and one of
//! offsets by level) change nothing in LibRaw's output: hidden one at a
//! time or together, its loaded image is the same. 0x041E without 0x041F
//! is not seen.
//!
//! The rules (each value is the one after the black, step 1):
//!
//! 1. Gain: the value x becomes x (1 + g), g the quarter's gain, the sum
//!    and product in 32-bit floats, rounded down, then held to 0 to 65535.
//! 2. Curve: the value goes through its quarter's curve, the cubic spline
//!    through (0, 0), each of the quarter's 16 levels paired with the mean
//!    of the four quarters' levels there (rounded half up), and (65535,
//!    65535), its second derivative 0 at 0 and its slope 1 at 65535, the
//!    result rounded half up.
//!
//! The curve is close to LibRaw's, not exact: a few values in a thousand
//! differ by one (where the spline is within a few thousandths of a half:
//! LibRaw's arithmetic is not the double precision used here), and in the
//! last span, from the top level to 65535, LibRaw's spline is not exactly
//! the one with slope 1 at 65535 (nor the natural one): its response to
//! the top level lies between the two, and there values differ by up to 4
//! near 60000. Identical tables in all four quarters (not seen in a file)
//! are corrected by LibRaw by a rule not found.

/// The block's 32-bit little-endian word at `at`.
fn word(block: &[u8], at: usize) -> Option<u32> {
    block.get(at..at + 4).map(|v| u32::from_le_bytes([v[0], v[1], v[2], v[3]]))
}

/// The quarter curves of a calibration block, given its entries (tag,
/// length, offset from the block's start) as iiq_cal.rs lists them: for
/// each quarter (top left, top right, bottom left, bottom right) a table of
/// the corrected value for every value after the black from `from` up to,
/// not including, `to`. None where the block has no 0x041F, or one not read
/// here.
pub fn read(block: &[u8], entries: &[(u32, usize, usize)], from: i32, to: i32) -> Option<[Vec<i32>; 4]> {
    let entry = |tag: u32| entries.iter().find(|e| e.0 == tag).map(|e| (e.2, e.1));
    let (at, len) = entry(0x041f)?;
    if len < 4 * 64 || from >= to {
        return None;
    }
    let mut levels = [[0i64; 16]; 4];
    for (q, l) in levels.iter_mut().enumerate() {
        for (i, v) in l.iter_mut().enumerate() {
            *v = word(block, at + 4 * (16 * q + i))? as i32 as i64;
        }
        // Increasing, within the range: else not read here.
        if l[0] <= 0 || l[15] >= 65535 || l.windows(2).any(|w| w[1] <= w[0]) {
            return None;
        }
    }
    let gains = match entry(0x041e) {
        Some((at, len)) if len >= 84 => [16, 40, 56, 72].map(|o| word(block, at + o).map(f32::from_bits)),
        Some(_) => return None,
        None => [Some(0.0); 4],
    };
    let target: Vec<f64> = (0..16).map(|i| ((levels.iter().map(|l| l[i]).sum::<i64>() + 2).div_euclid(4)) as f64).collect();
    let curve = |q: usize| -> Option<Vec<i32>> {
        let g = gains[q].filter(|g| g.is_finite())?;
        let mut pts = vec![(0.0, 0.0)];
        pts.extend((0..16).map(|i| (levels[q][i] as f64, target[i])));
        pts.push((65535.0, 65535.0));
        let s = Spline::new(&pts, 1.0);
        let k = 1.0f32 + g;
        Some((from..to).map(|v| s.at((v as f32 * k).floor().clamp(0.0, 65535.0) as f64)).collect())
    };
    Some([curve(0)?, curve(1)?, curve(2)?, curve(3)?])
}

/// A cubic spline through points in increasing x: its second derivative 0
/// at the first, its slope given at the last.
struct Spline {
    x: Vec<f64>,
    y: Vec<f64>,
    /// The second derivative at each point.
    m: Vec<f64>,
}

impl Spline {
    fn new(pts: &[(f64, f64)], end_slope: f64) -> Spline {
        let n = pts.len() - 1;
        let (x, y): (Vec<f64>, Vec<f64>) = pts.iter().copied().unzip();
        let h: Vec<f64> = (0..n).map(|i| x[i + 1] - x[i]).collect();
        let d: Vec<f64> = (0..n).map(|i| (y[i + 1] - y[i]) / h[i]).collect();
        // The tridiagonal system, row i: sub, diagonal, super, right side.
        let mut sub = vec![0f64; n + 1];
        let mut diag = vec![1f64; n + 1];
        let mut sup = vec![0f64; n + 1];
        let mut rhs = vec![0f64; n + 1];
        for i in 1..n {
            (sub[i], diag[i], sup[i], rhs[i]) = (h[i - 1], 2.0 * (h[i - 1] + h[i]), h[i], 6.0 * (d[i] - d[i - 1]));
        }
        (sub[n], diag[n], rhs[n]) = (h[n - 1], 2.0 * h[n - 1], 6.0 * (end_slope - d[n - 1]));
        for i in 1..=n {
            let w = sub[i] / diag[i - 1];
            diag[i] -= w * sup[i - 1];
            rhs[i] -= w * rhs[i - 1];
        }
        let mut m = vec![0f64; n + 1];
        m[n] = rhs[n] / diag[n];
        for i in (0..n).rev() {
            m[i] = (rhs[i] - sup[i] * m[i + 1]) / diag[i];
        }
        Spline { x, y, m }
    }

    /// The value at `t` (from the first point's x to the last's), rounded
    /// half up.
    fn at(&self, t: f64) -> i32 {
        let n = self.x.len() - 1;
        let i = self.x[1..n].partition_point(|&k| k <= t);
        let h = self.x[i + 1] - self.x[i];
        let (a, b) = ((self.x[i + 1] - t) / h, (t - self.x[i]) / h);
        let v = a * self.y[i] + b * self.y[i + 1] + ((a * a * a - a) * self.m[i] + (b * b * b - b) * self.m[i + 1]) * h * h / 6.0;
        (v + 0.5).floor() as i32
    }
}
