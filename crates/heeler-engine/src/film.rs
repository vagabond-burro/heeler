//! Development: the negative's characteristic curve as the Tone Profile
//!.
//!
//! A film's characteristic (H&D) curve is density against log exposure:
//! a toe where the emulsion starts to respond, a straight line whose
//! slope is the gamma, a shoulder where it saturates. Development time
//! moves the family: longer development is a steeper line and a little
//! more speed. Film makers publish these families for their stocks
//! at several development times. Here each stock is a parametric fit of
//! that shape, and Development in N steps (N-2 to N+2) walks the family.
//!
//! The print, until phase 6 brings the paper, is the ideal one: the
//! negative on a grade 2 paper, with scene white landing on paper white.
//! A negative is developed to a contrast near 0.6 BECAUSE the paper it
//! goes onto has a contrast near 1.7, and the two multiply to a normal
//! print; printed "straight", with no paper contrast, every negative
//! came out flat and bright (2026-09-14: "all it did was get bright").
//! So the display value is 10^(g_paper (D(x) - D(x_white))): a
//! straight-line film of gamma g renders as the power curve
//! (E/E_white)^(g g_paper), the toe compresses the shadows and the
//! shoulder the highlights, which is what a negative does to a print.
//!
//! HONESTY: the numbers in STOCKS describe the published families'
//! shapes from general knowledge of them (speed, the gamma a normal
//! development gives, how long the toe is, how straight the line runs,
//! how the family fans with time). Where a stock's published reference
//! gives a figure, the stock is fitted to it and a test holds it there
//! (DEVELOPMENT_TARGETS: the contrast index normal development aims
//! at). The full fit, every stock within 0.05 density of its reference's
//! curves at every published development, still waits on those curves
//! being read off; every stock is labeled "modeled on" for that reason,
//! in the panel as in the docs.

/// One stock's parametric characteristic curve, in relative log
/// exposure x = log10(E / E_middle_gray).
#[derive(Clone, Copy, Debug)]
pub struct Stock {
    pub key: &'static str,
    pub name: &'static str,
    /// The sheet the shape is modeled on.
    pub modelled_on: &'static str,
    /// Slope of the straight line at normal development.
    pub gamma: f32,
    /// How much the slope changes per N step, as a fraction.
    pub gamma_per_n: f32,
    /// Where the straight line, extended down, meets base fog: the toe's
    /// foot, in log exposure below middle gray.
    pub toe_foot: f32,
    /// The toe's softness, in log exposure: long for cubic-grain films,
    /// short for T-grain.
    pub toe_soft: f32,
    /// Speed gained per N step, in log exposure (a push gains a little).
    pub speed_per_n: f32,
    /// The density range above base fog the shoulder saturates toward:
    /// long for a straight-running film, shorter for one that shoulders.
    pub range: f32,
}

/// The first cut (decision 3): four looks, one list shared with the
/// spectral stage.
pub const STOCKS: [Stock; 7] = [
    Stock {
        key: "hp5",
        name: "HP5 Plus",
        modelled_on: "Ilford HP5 Plus, ISO 400, cubic grain: a long gentle toe and a long straight line",
        gamma: 0.62,
        gamma_per_n: 0.18,
        toe_foot: -1.45,
        toe_soft: 0.25,
        speed_per_n: 0.10,
        range: 2.6,
    },
    Stock {
        key: "fp4",
        name: "FP4 Plus",
        modelled_on: "Ilford FP4 Plus, ISO 125, fine cubic grain: a shorter toe and an earlier shoulder",
        gamma: 0.65,
        gamma_per_n: 0.18,
        toe_foot: -1.35,
        toe_soft: 0.18,
        speed_per_n: 0.08,
        range: 2.2,
    },
    Stock {
        key: "trix",
        name: "Tri-X 400",
        modelled_on: "Kodak Tri-X 400, cubic grain: the longest toe and a line that keeps running",
        // Fitted: the gamma whose contrast index at normal development is
        // the reference's published target, 0.56 (DEVELOPMENT_TARGETS).
        gamma: 0.651,
        gamma_per_n: 0.20,
        // A tenth later than the first guess, so the steeper fitted line
        // keeps this cubic-grain stock's deep shadows softer than the
        // T-grain stock's (the toe test). The move itself barely shifts
        // middle gray; the fitted gamma does: middle gray renders darker
        // than before the fit (0.187 to 0.162 display-linear, about a fifth
        // of a stop), and the 0.1 density point sits about a fifth of a
        // stop later. Kept by the toe test, not by the reference's curves,
        // which are not read off yet.
        toe_foot: -1.40,
        toe_soft: 0.30,
        speed_per_n: 0.12,
        range: 2.8,
    },
    Stock {
        key: "tmax400",
        name: "T-Max 400",
        modelled_on: "Kodak T-Max 400, T-grain: a short toe and a very straight line",
        gamma: 0.66,
        gamma_per_n: 0.16,
        toe_foot: -1.30,
        toe_soft: 0.12,
        speed_per_n: 0.08,
        range: 3.0,
    },
    Stock {
        key: "ortho",
        name: "Ortho Plus",
        modelled_on: "Ilford Ortho Plus, ISO 80, orthochromatic: a contrasty line and a modest range",
        gamma: 0.80,
        gamma_per_n: 0.20,
        toe_foot: -1.20,
        toe_soft: 0.15,
        speed_per_n: 0.06,
        range: 2.4,
    },
    // The infrared pair: what they see is the spectral stage's guess; how
    // they develop is modeled here like the rest.
    Stock {
        key: "rolleiir",
        name: "Rollei Infrared 400",
        modelled_on: "Rollei Infrared 400, a panchromatic film reaching to about 820 nm: a moderate toe and a straight line",
        gamma: 0.65,
        gamma_per_n: 0.18,
        toe_foot: -1.35,
        toe_soft: 0.2,
        speed_per_n: 0.1,
        range: 2.5,
    },
    Stock {
        key: "hie",
        name: "Kodak HIE",
        modelled_on: "Kodak HIE, reaching to about 900 nm with no anti-halation layer: contrasty, a short range, famous for its glow (add Halation for that)",
        gamma: 0.72,
        gamma_per_n: 0.2,
        toe_foot: -1.25,
        toe_soft: 0.18,
        speed_per_n: 0.1,
        range: 2.0,
    },
];

/// The contrast index a stock's published reference aims normal
/// development at, where the reference gives one. The stock's gamma is
/// fitted so its own contrast_index, the horizontal approximation,
/// matches; see contrast_index for how far that can differ from the
/// arc construction.
pub const DEVELOPMENT_TARGETS: [(&str, f32); 1] = [("trix", 0.56)];

pub fn stock(key: &str) -> Option<&'static Stock> {
    STOCKS.iter().find(|s| s.key == key)
}

/// Relative log exposure of scene white: 1.0 against middle gray 0.18.
const X_WHITE: f32 = 0.744_727_5;
/// The ideal print's paper contrast, a grade 2's, until the Print
/// section makes it a dial (phase 6).
pub const PAPER_GAMMA: f32 = 1.65;

impl Stock {
    /// Density above base fog at relative log exposure `x`, developed
    /// `n` steps from normal, the straight line's slope scaled by
    /// `gamma_scale` (the Profile amt dial, 1 at rest).
    pub fn density(&self, x: f32, n: f32, gamma_scale: f32) -> f32 {
        let gamma = self.gamma * (1.0 + self.gamma_per_n * n).max(0.1) * gamma_scale.max(0.05);
        let foot = self.toe_foot - self.speed_per_n * n;
        // A soft toe: softplus rising into the straight line.
        let t = (x - foot) / self.toe_soft;
        let line = gamma * self.toe_soft * if t > 20.0 { t } else { (1.0 + t.exp()).ln() };
        // A shoulder that leaves the straight line alone until near the
        // range, then rolls: a soft minimum with a fixed softness. The
        // first cut saturated from the foot up and printed middle gray
        // half a stop too bright.
        const SOFT: f32 = 0.35;
        -SOFT * ((-line / SOFT).exp() + (-self.range / SOFT).exp()).ln()
    }

    /// The contrast index at development `n`, by the common horizontal
    /// approximation: the average slope from the point 0.1 above base fog
    /// to the point 2.0 further along in log exposure. Published
    /// development targets are given as a contrast index, and the
    /// original definition is a construction with two concentric arcs
    /// (radii 0.2 and 2.2) about a point on the base-fog line; on the
    /// fitted stock's curve that construction reads about 0.015 lower
    /// than this (0.545 against 0.560, the 2026-10-10 review), and the
    /// reference does not say which it used. So the fit is to the target
    /// by this approximation, good to about 0.02. Either way the index
    /// sits below the straight line's gamma by as much as the toe is long.
    pub fn contrast_index(&self, n: f32) -> f32 {
        // The first log exposure where density reaches 0.1, by bisection
        // (density rises monotonically).
        let (mut lo, mut hi) = (-6.0f32, 3.0f32);
        for _ in 0..60 {
            let mid = 0.5 * (lo + hi);
            if self.density(mid, n, 1.0) < 0.1 { lo = mid } else { hi = mid }
        }
        let x1 = 0.5 * (lo + hi);
        (self.density(x1 + 2.0, n, 1.0) - self.density(x1, n, 1.0)) / 2.0
    }

    /// The display-linear value a scene-linear luminance renders to:
    /// the negative on a grade 2 paper, scene white on paper white.
    pub fn display(&self, scene: f32, n: f32, gamma_scale: f32) -> f32 {
        let x = (scene.max(1e-6) / 0.18).log10();
        let d = self.density(x, n, gamma_scale);
        let d_white = self.density(X_WHITE, n, gamma_scale);
        10f32.powf(PAPER_GAMMA * (d - d_white)).clamp(0.0, 1.0)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A stock fitted to a published development target meets it, read
    /// the way the target is defined (Stock::contrast_index).
    #[test]
    fn a_stock_with_a_published_development_target_meets_it() {
        for (key, target) in DEVELOPMENT_TARGETS {
            let ci = stock(key).unwrap().contrast_index(0.0);
            assert!((ci - target).abs() < 0.005, "{key}: contrast index {ci:.3} against the published {target}");
        }
        // The index sits under the straight line's gamma by the toe.
        for s in STOCKS.iter() {
            assert!(s.contrast_index(0.0) < s.gamma, "{}", s.key);
        }
    }

    #[test]
    fn every_stock_is_monotone_at_every_development() {
        for s in STOCKS.iter() {
            for n in [-2.0f32, -1.0, 0.0, 1.0, 2.0] {
                let mut prev = -1.0f32;
                for i in 0..200 {
                    let scene = 10f32.powf(-4.0 + i as f32 * 0.03);
                    let v = s.display(scene, n, 1.0);
                    assert!(v >= prev - 1e-6, "{} at N{n:+} folded at scene {scene}: {v} < {prev}", s.key);
                    prev = v;
                }
            }
        }
    }

    #[test]
    fn scene_white_prints_as_paper_white_and_middle_gray_is_a_middle_tone() {
        for s in STOCKS.iter() {
            assert!((s.display(1.0, 0.0, 1.0) - 1.0).abs() < 1e-4, "{} white", s.key);
            let mid = s.display(0.18, 0.0, 1.0);
            assert!((0.10..0.30).contains(&mid), "{} middle gray renders at {mid}", s.key);
        }
    }

    /// A normal negative on a grade 2 paper is a normal print: the
    /// overall contrast through the mids sits near one, not the flat
    /// 0.6 of the negative alone, which printed bright.
    #[test]
    fn a_normal_negative_on_grade_two_paper_is_a_normal_print() {
        for s in STOCKS.iter() {
            let a = s.display(0.18 / 2.0, 0.0, 1.0);
            let b = s.display(0.18 * 2.0, 0.0, 1.0);
            let overall = (b / a).log2() / 2.0;
            assert!((0.85..1.5).contains(&overall), "{} overall contrast {overall}", s.key);
        }
    }

    #[test]
    fn a_push_is_steeper_and_a_pull_is_flatter_through_the_mids() {
        for s in STOCKS.iter() {
            let slope = |n: f32| {
                let a = s.display(0.18 * 0.5, n, 1.0);
                let b = s.display(0.18 * 2.0, n, 1.0);
                (b / a.max(1e-6)).log2()
            };
            assert!(slope(1.0) > slope(0.0) && slope(0.0) > slope(-1.0), "{} development order", s.key);
        }
    }

    #[test]
    fn the_toe_compresses_the_shadows_and_cubic_grain_has_the_longer_toe() {
        let contrast = |s: &Stock, scene: f32| {
            let a = s.display(scene / 1.414, 0.0, 1.0);
            let b = s.display(scene * 1.414, 0.0, 1.0);
            (b.max(1e-6) / a.max(1e-6)).log2()
        };
        for s in STOCKS.iter() {
            assert!(contrast(s, 0.18 / 16.0) < contrast(s, 0.18), "{} toe", s.key);
        }
        // Tri-X's shadows are softer than T-Max's four stops under.
        let trix = stock("trix").unwrap();
        let tmax = stock("tmax400").unwrap();
        assert!(contrast(trix, 0.18 / 16.0) < contrast(tmax, 0.18 / 16.0));
    }

    #[test]
    fn the_profile_amt_scales_the_gamma_and_an_unknown_key_is_none() {
        let s = stock("hp5").unwrap();
        let strong = s.display(0.18, 0.0, 1.3);
        let plain = s.display(0.18, 0.0, 1.0);
        assert!(strong < plain, "more gamma renders middle gray darker against white");
        assert!(stock("kodachrome").is_none());
    }
}
