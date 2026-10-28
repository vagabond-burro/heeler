//! Undoing the lens before the frames meet.
//!
//! The camera model the solve uses is a pinhole: a straight line in the
//! world is a straight line in the frame. A real lens bows it, barrel on
//! a wide angle and pincushion on a long one, and the bow grows toward
//! the edges, which is exactly where neighboring frames overlap. Fitted
//! as pinholes, wide frames agree in the middle of their overlap and
//! drift apart at its ends, and the blend is left to hide it.
//!
//! So each frame's lens is undone in the geometry, never in the pixels:
//! keypoints are moved to where a pinhole would have seen them before
//! matching and the solve, and the composite asks the lens where each
//! ray landed when it samples the frame. No frame is resampled twice,
//! and nothing at a frame's corner is lost to a correction's stretch.
//!
//! The radius is measured as the calibration database measures it:
//! 1 at half the frame's shorter side, from its center. That convention
//! is independent of resolution, so a frame registered at REGISTER_EDGE
//! and the same frame at full size share one description.

use heeler_engine::ops_lens::profile_factor;

/// One frame's distortion.
#[derive(Debug, Clone, PartialEq)]
pub enum Lens {
    /// A calibrated profile from the lens database: its model (poly3,
    /// poly5 or ptlens), the model's coefficients, and the camera to
    /// calibration radius conversion, the profile's crop factor over the
    /// camera's (1 for a lens on its own mount). The model gives the
    /// distorted radius from the undistorted one.
    Profile { model: String, a: f32, b: f32, c: f32, scale: f32 },
    /// One radial term the solve fitted itself, for a lens the database
    /// does not know: the undistorted radius is `r (1 + k r²)` of the
    /// distorted one.
    Radial { k: f64 },
}

impl Lens {
    /// Whether this describes a lens that bends anything, and one the
    /// composite can use.
    pub fn is_known(&self) -> bool {
        match self {
            Lens::Profile { model, a, b, c, scale } => {
                a.is_finite()
                    && b.is_finite()
                    && c.is_finite()
                    && scale.is_finite()
                    && *scale > 0.0
                    && profile_factor(model, *a, *b, *c, 0.5).is_some_and(|f| f.is_finite() && f > 0.0)
            }
            Lens::Radial { k } => k.is_finite(),
        }
    }

    /// Whether the lens maps a frame `w` by `h` one to one: the distorted
    /// radius has to keep rising out to the frame's corners, or undoing
    /// it has two answers and distort and undistort stop being inverses.
    /// A profile that folds back inside the frame is a calibration taken
    /// past its range, and a fitted term that does is the solve bending
    /// the lens to explain bad matches; either is better left unused.
    pub fn holds_over(&self, w: usize, h: usize) -> bool {
        if !self.is_known() {
            return false;
        }
        let reach = (w as f64).hypot(h as f64) * 0.5 / half_short(w, h);
        match self {
            // The undistortion is the closed form here; its slope is
            // 1 + 3 k r², lowest at the corner when k is negative.
            Lens::Radial { k } => 1.0 + 3.0 * k.min(0.0) * reach * reach > 0.0,
            // Walk the undistorted radius out until the distorted one
            // reaches the corner, which it must do while rising.
            Lens::Profile { .. } => {
                const STEP: f64 = 1.0 / 256.0;
                let mut last = 0.0;
                let mut ru = STEP;
                while ru < 4.0 * reach {
                    let rd = ru * self.forward(ru);
                    if !(rd > last) {
                        return false;
                    }
                    if rd >= reach {
                        return true;
                    }
                    last = rd;
                    ru += STEP;
                }
                false
            }
        }
    }

    /// Distorted radius over undistorted, at undistorted radius `ru`.
    fn forward(&self, ru: f64) -> f64 {
        match self {
            Lens::Profile { model, a, b, c, scale } => {
                profile_factor(model, *a, *b, *c, (ru * *scale as f64) as f32).map_or(1.0, |f| f as f64)
            }
            // The inverse of the undistortion, which is the one in closed
            // form here.
            Lens::Radial { k } => {
                let rd = invert(ru, |r| r * (1.0 + k * r * r));
                if ru > 1e-12 { rd / ru } else { 1.0 }
            }
        }
    }

    /// Undistorted radius over distorted, at distorted radius `rd`.
    fn backward(&self, rd: f64) -> f64 {
        match self {
            Lens::Profile { .. } => {
                let ru = invert(rd, |r| r * self.forward(r));
                if rd > 1e-12 { ru / rd } else { 1.0 / self.forward(0.0) }
            }
            Lens::Radial { k } => 1.0 + k * rd * rd,
        }
    }

    /// Where a pinhole would have seen what the lens put at `(x, y)`.
    /// Coordinates from the frame's center, in pixels of a frame `w` by
    /// `h`.
    pub fn undistort(&self, x: f64, y: f64, w: usize, h: usize) -> (f64, f64) {
        let norm = half_short(w, h);
        let f = self.backward((x * x + y * y).sqrt() / norm);
        (x * f, y * f)
    }

    /// Where the lens put what a pinhole would see at `(x, y)`: the
    /// inverse of undistort.
    pub fn distort(&self, x: f64, y: f64, w: usize, h: usize) -> (f64, f64) {
        let norm = half_short(w, h);
        let f = self.forward((x * x + y * y).sqrt() / norm);
        (x * f, y * f)
    }
}

/// The radius convention's unit, in pixels.
fn half_short(w: usize, h: usize) -> f64 {
    (w.min(h) as f64 * 0.5).max(1.0)
}

/// The radius `r` at which `g(r)` reaches `target`, for a `g` that rises
/// from zero, as every distortion short of a fisheye's does over the
/// frame. Newton's method from the target itself, which is where an
/// undistorted lens would put it, with bisection as the fallback where
/// a step goes astray.
fn invert(target: f64, g: impl Fn(f64) -> f64) -> f64 {
    if target <= 0.0 {
        return 0.0;
    }
    let mut r = target;
    for _ in 0..30 {
        let e = g(r) - target;
        if e.abs() < 1e-12 {
            return r;
        }
        let d = 1e-6 * r.max(1e-3);
        let slope = (g(r + d) - g(r - d)) / (2.0 * d);
        let next = r - e / slope;
        if !(slope > 0.0 && next > 0.0 && next.is_finite()) {
            break;
        }
        r = next;
    }
    if (g(r) - target).abs() < 1e-9 {
        return r;
    }
    // Bracket and halve.
    let (mut lo, mut hi) = (0.0, target.max(1e-6));
    while g(hi) < target && hi < 1e3 {
        hi *= 2.0;
    }
    for _ in 0..80 {
        let mid = 0.5 * (lo + hi);
        if g(mid) < target {
            lo = mid;
        } else {
            hi = mid;
        }
    }
    0.5 * (lo + hi)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn profiles() -> Vec<Lens> {
        vec![
            // A wide zoom's barrel, in each of the database's models.
            Lens::Profile { model: "ptlens".into(), a: 0.012, b: -0.045, c: 0.0, scale: 1.0 },
            Lens::Profile { model: "poly3".into(), a: -0.03, b: 0.0, c: 0.0, scale: 1.0 },
            Lens::Profile { model: "poly5".into(), a: -0.06, b: 0.01, c: 0.0, scale: 0.8 },
            // A long lens's pincushion.
            Lens::Profile { model: "poly3".into(), a: 0.02, b: 0.0, c: 0.0, scale: 1.0 },
            Lens::Radial { k: -0.04 },
            Lens::Radial { k: 0.03 },
        ]
    }

    #[test]
    fn distorting_and_undistorting_are_inverses() {
        let (w, h) = (6000, 4000);
        for lens in profiles() {
            for (x, y) in [(0.0, 0.0), (1500.0, 0.0), (2900.0, 1950.0), (-2400.0, 1200.0), (-10.0, -3.0)] {
                let (ux, uy) = lens.undistort(x, y, w, h);
                let (bx, by) = lens.distort(ux, uy, w, h);
                assert!((bx - x).abs() < 1e-6 && (by - y).abs() < 1e-6, "{lens:?} at ({x}, {y}) came back ({bx}, {by})");
            }
        }
    }

    /// Barrel distortion pulls the corners in, so undoing it pushes them
    /// out; the center stays where it is. And the convention is the
    /// database's, so the same lens at a quarter of the size moves the
    /// same fraction of the frame.
    #[test]
    fn a_barrel_lens_is_undone_outward_at_any_size() {
        let barrel = Lens::Profile { model: "poly3".into(), a: -0.03, b: 0.0, c: 0.0, scale: 1.0 };
        let (cx, _) = barrel.undistort(2900.0, 0.0, 6000, 4000);
        assert!(cx > 2900.0, "a barrel corner should move out, went to {cx}");
        let (small, _) = barrel.undistort(2900.0 / 4.0, 0.0, 1500, 1000);
        assert!((small * 4.0 - cx).abs() < 1e-6, "{} against {cx}", small * 4.0);
        let (ox, oy) = barrel.undistort(0.0, 0.0, 6000, 4000);
        assert!(ox.abs() < 1e-12 && oy.abs() < 1e-12);
    }

    #[test]
    fn an_unknown_or_non_finite_model_is_not_a_lens() {
        assert!(!Lens::Profile { model: "fisheye".into(), a: 0.1, b: 0.0, c: 0.0, scale: 1.0 }.is_known());
        for (a, b, c, scale) in [(f32::NAN, 0.0, 0.0, 1.0), (0.0, f32::INFINITY, 0.0, 1.0), (0.0, 0.0, 0.0, f32::NAN), (0.0, 0.0, 0.0, 0.0)] {
            assert!(!Lens::Profile { model: "poly3".into(), a, b, c, scale }.is_known());
        }
        assert!(Lens::Radial { k: 0.0 }.is_known());
    }

    #[test]
    fn a_lens_that_folds_back_inside_the_frame_is_not_used() {
        let (w, h) = (6000, 4000);
        for lens in profiles() {
            assert!(lens.holds_over(w, h), "{lens:?}");
        }
        // Strong enough that the corner of a 3:2 frame lands inside its
        // own edge.
        assert!(!Lens::Profile { model: "poly3".into(), a: -0.4, b: 0.0, c: 0.0, scale: 1.0 }.holds_over(w, h));
        assert!(!Lens::Radial { k: -0.2 }.holds_over(w, h));
        // A milder term folds past a 3:2 frame's corner but not a square
        // one's, which is nearer the center.
        assert!(!Lens::Radial { k: -0.12 }.holds_over(w, h));
        assert!(Lens::Radial { k: -0.12 }.holds_over(4000, 4000));
        assert!(!Lens::Profile { model: "poly3".into(), a: f32::NAN, b: 0.0, c: 0.0, scale: 1.0 }.holds_over(w, h));
    }
}
