//! Filter and film: the spectral conversion.
//!
//! A red filter is not "red 150, green 0, blue 0". It is a transmission
//! curve, the film behind it has a sensitivity curve, and the gray is the
//! integral of the pixel's spectrum through both. The sensor recorded
//! three numbers, so the spectrum is a reconstruction: Smits' method
//! (1999), a non-negative combination of seven smooth basis spectra
//! (white, cyan, magenta, yellow, red, green, blue) chosen by the order
//! of the three channels. It is linear in the pixel, so the gray is a
//! dot product of the pixel's seven weights with seven integrals fixed
//! per filter-and-film pair: no lookup table, one pass.
//!
//! The gray is normalized so a neutral keeps its value under any filter
//! and film: the filter factor is the exposure's business, not the
//! conversion's, and a digital user expects a filter to change the
//! RELATIONS between colors, not the brightness of the frame.
//!
//! HONESTY: the basis spectra, the Wratten transmissions and the films'
//! sensitivities are smooth models of the published shapes (a sharp-cut
//! long-pass filter is a logistic edge at its cut, a panchromatic film
//! is flat with a green dip and a red roll-off, an orthochromatic one
//! stops at the yellow), not digitized curves. They are labeled
//! "modeled on". The digitizing is the same follow-up the stocks'
//! characteristic curves wait on.

use crate::film::STOCKS;

/// The grid: 380 nm to 900 nm in 10 nm steps. The visible band ends at
/// 700 nm; past it the sensor recorded nothing and the spectrum is the
/// infrared prior's (below).
pub const LAMBDA_0: f32 = 380.0;
pub const LAMBDA_STEP: f32 = 10.0;
pub const SAMPLES: usize = 53;
/// The first sample past the visible band.
const NIR_FROM: usize = 33;

/// Infrared: the Wood effect as a material prior. The sensor's cut
/// filter recorded nothing past 700 nm, so a pixel's near-infrared
/// reflectance is a guess from what its color says the material is:
/// foliage (chlorophyll's red edge) goes to several times its visible
/// gray, sky (Rayleigh, the fourth power of wavelength) to near
/// nothing, water dark, skin pale, neutrals flat. The prior is a
/// periodic curve of visible hue to a lift in stops, chroma-gated like
/// the hue curve so a neutral stays flat, and it is a control, not a
/// constant ("the features are in place for a user to fine
/// tune the guessed spectrum"). This is the default; the panel's five
/// materials and its curve replace it.
#[derive(Clone)]
pub struct IrPrior {
    /// The curve expanded across the seam, ready to evaluate.
    expanded: Vec<crate::ops::EqPoint>,
}

/// The four materials the panel offers, in stops: the defaults are the Wood
/// effect as infrared film shows it. Haze waits on the depth plane (phase
/// 5).
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct IrMaterials {
    pub foliage: f32,
    pub sky: f32,
    pub water: f32,
    pub skin: f32,
}

impl IrMaterials {
    pub const DEFAULT: IrMaterials = IrMaterials { foliage: 2.4, sky: -2.5, water: -0.8, skin: 0.6 };
}

impl IrPrior {
    /// The prior from the four materials: each sits at its hues on the
    /// wheel, and the curve runs smoothly between them.
    pub fn from_materials(m: IrMaterials) -> IrPrior {
        let pts: Vec<crate::ops::EqPoint> = [
            (20.0, m.skin),                       // skin, brick
            (60.0, 0.4 * m.skin + 0.2 * m.foliage), // yellow: dry grass
            (110.0, m.foliage),                    // yellow-green
            (150.0, m.foliage),                    // green
            (190.0, m.water),                      // cyan: water
            (230.0, m.sky),                        // blue: sky
            (270.0, m.sky * 0.8),                  // blue-violet
            (320.0, 0.0),                          // magenta: flat
        ]
        .into_iter()
        .map(|(x, y)| crate::ops::EqPoint { x, y, l: None, r: None })
        .collect();
        IrPrior::from_points(pts)
    }

    /// The prior from a curve of the user's (the panel's expert face,
    /// Recolor's point format on a 0..360 hue axis). Fewer than two
    /// points is the default.
    pub(crate) fn from_points(points: Vec<crate::ops::EqPoint>) -> IrPrior {
        if points.len() < 2 {
            return IrPrior::from_materials(IrMaterials::DEFAULT);
        }
        let mut pts = points;
        pts.sort_by(|a, b| a.x.total_cmp(&b.x));
        IrPrior { expanded: crate::ops_recolor::expand_eq_periodic(&pts, 360.0) }
    }

    pub fn default_prior() -> IrPrior {
        IrPrior::from_materials(IrMaterials::DEFAULT)
    }

    pub(crate) fn with_interp(mut self, interp: &str) -> Self {
        crate::ops::apply_eq_interp(&mut self.expanded, interp);
        self
    }

    /// The lift at a hue, in stops, clamped to four either way.
    pub fn lift(&self, hue: f32) -> f32 {
        crate::ops::eval_eq_points(&self.expanded, hue.rem_euclid(360.0)).clamp(-4.0, 4.0)
    }

    /// How the guess changes deeper into the infrared, in stops from 720 to
    /// 850 nm: the sky keeps falling (Rayleigh, the fourth power of
    /// wavelength, is a stop between the two), foliage sits on its plateau,
    /// the rest is flat. Not a control: it is what tells a 720 from an 850
    /// (2026-09-15: "don't see much of a difference between the two").
    pub fn slope(hue: f32) -> f32 {
        let h = hue.rem_euclid(360.0);
        let d = (h - 245.0).abs().min(360.0 - (h - 245.0).abs());
        -1.0 * (1.0 - (d / 55.0).clamp(0.0, 1.0))
    }
}

fn lambda(i: usize) -> f32 {
    LAMBDA_0 + i as f32 * LAMBDA_STEP
}

fn sigmoid(x: f32) -> f32 {
    1.0 / (1.0 + (-x).exp())
}

/// The seven basis spectra, Smits' set as smooth curves: blue is a
/// short-pass at 490 nm, red a long-pass at 600 nm (the red primary's
/// energy lies above 600, and a softer edge at 590 let an
/// orthochromatic film see a fifth of a saturated red: the owner's red
/// hoodie rendered mid-gray on Ortho Plus), green what is left between
/// them; cyan, magenta and yellow are their complements; white is
/// flat.
fn basis(name: usize, l: f32) -> f32 {
    let blue = sigmoid((490.0 - l) / 20.0);
    let red = sigmoid((l - 600.0) / 12.0);
    let green = (1.0 - blue - red).max(0.0);
    match name {
        0 => 1.0,
        1 => 1.0 - red,   // cyan
        2 => 1.0 - green, // magenta
        3 => 1.0 - blue,  // yellow
        4 => red,
        5 => green,
        _ => blue,
    }
}

/// A Wratten filter, as a transmission curve.
#[derive(Clone, Copy, Debug)]
pub struct Filter {
    pub key: &'static str,
    pub name: &'static str,
    pub modelled_on: &'static str,
    kind: Shape,
}

#[derive(Clone, Copy, Debug)]
enum Shape {
    /// Passes above the cut, a logistic edge of the given width.
    LongPass { cut: f32, width: f32 },
    /// Passes a band around the center, a gaussian of the given width.
    Band { centre: f32, width: f32 },
    /// Passes a band and a shoulder of the long side (the yellow-green
    /// 11: green through, some red, little blue).
    BandPlus { centre: f32, width: f32, tail: f32 },
}

pub const FILTERS: [Filter; 10] = [
    Filter { key: "w8", name: "8 yellow", modelled_on: "Wratten 8 (K2), a sharp cut at about 495 nm", kind: Shape::LongPass { cut: 495.0, width: 12.0 } },
    Filter { key: "w11", name: "11 yellow-green", modelled_on: "Wratten 11 (X1), green through with a little red and less blue", kind: Shape::BandPlus { centre: 540.0, width: 45.0, tail: 0.35 } },
    Filter { key: "w15", name: "15 deep yellow", modelled_on: "Wratten 15 (G), a sharp cut at about 520 nm", kind: Shape::LongPass { cut: 520.0, width: 12.0 } },
    Filter { key: "w21", name: "21 orange", modelled_on: "Wratten 21, a sharp cut at about 550 nm", kind: Shape::LongPass { cut: 550.0, width: 12.0 } },
    Filter { key: "w25", name: "25 red", modelled_on: "Wratten 25 (A), a sharp cut at about 600 nm", kind: Shape::LongPass { cut: 600.0, width: 12.0 } },
    Filter { key: "w29", name: "29 deep red", modelled_on: "Wratten 29 (F), a sharp cut at about 620 nm", kind: Shape::LongPass { cut: 620.0, width: 12.0 } },
    Filter { key: "w47", name: "47 blue", modelled_on: "Wratten 47 (B), a band around 450 nm", kind: Shape::Band { centre: 450.0, width: 32.0 } },
    Filter { key: "w58", name: "58 green", modelled_on: "Wratten 58 (B2), a band around 530 nm", kind: Shape::Band { centre: 530.0, width: 30.0 } },
    // The infrared pair: nothing visible through them, so what they
    // show is the prior's guess and the film's reach.
    Filter { key: "r72", name: "720 infrared", modelled_on: "an R72, a sharp cut at 720 nm: the visible band gone, the near infrared through", kind: Shape::LongPass { cut: 720.0, width: 10.0 } },
    Filter { key: "r85", name: "850 infrared", modelled_on: "an 850 nm long-pass: deep infrared only, for a film that reaches it", kind: Shape::LongPass { cut: 850.0, width: 12.0 } },
];

pub fn filter(key: &str) -> Option<&'static Filter> {
    FILTERS.iter().find(|f| f.key == key)
}

impl Filter {
    pub fn transmission(&self, l: f32) -> f32 {
        match self.kind {
            Shape::LongPass { cut, width } => sigmoid((l - cut) / width),
            Shape::Band { centre, width } => (-0.5 * ((l - centre) / width).powi(2)).exp(),
            Shape::BandPlus { centre, width, tail } => {
                let band = (-0.5 * ((l - centre) / width).powi(2)).exp();
                let shoulder = tail * sigmoid((l - centre) / 25.0);
                band.max(shoulder)
            }
        }
    }
}

/// A film's spectral sensitivity: panchromatic (flat, a dip in the
/// green, a roll-off past the red the stock reaches to), or
/// orthochromatic (nothing past the yellow).
#[derive(Clone, Copy, Debug)]
pub struct Sensitivity {
    pub key: &'static str,
    pub modelled_on: &'static str,
    /// Where the red response is half gone.
    red_end: f32,
    /// How sharply it goes, in nm: panchromatic films roll off,
    /// orthochromatic ones stop.
    red_soft: f32,
    /// Depth of the panchromatic green dip, 0 for none.
    green_dip: f32,
}

pub const SENSITIVITIES: [Sensitivity; 7] = [
    Sensitivity { key: "hp5", modelled_on: "Ilford HP5 Plus, panchromatic to about 650 nm", red_end: 655.0, red_soft: 15.0, green_dip: 0.25 },
    Sensitivity { key: "fp4", modelled_on: "Ilford FP4 Plus, panchromatic to about 650 nm", red_end: 650.0, red_soft: 15.0, green_dip: 0.25 },
    Sensitivity { key: "trix", modelled_on: "Kodak Tri-X 400, panchromatic to about 660 nm", red_end: 660.0, red_soft: 15.0, green_dip: 0.20 },
    Sensitivity { key: "tmax400", modelled_on: "Kodak T-Max 400, panchromatic to about 660 nm, a little further into the red", red_end: 665.0, red_soft: 15.0, green_dip: 0.15 },
    Sensitivity { key: "ortho", modelled_on: "Ilford Ortho Plus, orthochromatic: blind past about 570 nm", red_end: 565.0, red_soft: 8.0, green_dip: 0.0 },
    // The infrared films: panchromatic, and on into the near infrared.
    Sensitivity { key: "rolleiir", modelled_on: "Rollei Infrared 400, sensitive to about 820 nm", red_end: 815.0, red_soft: 20.0, green_dip: 0.2 },
    Sensitivity { key: "hie", modelled_on: "Kodak HIE, sensitive to about 900 nm and famous for its glow", red_end: 890.0, red_soft: 25.0, green_dip: 0.15 },
];

pub fn sensitivity(key: &str) -> Option<&'static Sensitivity> {
    SENSITIVITIES.iter().find(|s| s.key == key)
}

impl Sensitivity {
    pub fn response(&self, l: f32) -> f32 {
        let uv_end = sigmoid((l - 390.0) / 10.0);
        let red = 1.0 - sigmoid((l - self.red_end) / self.red_soft);
        let dip = 1.0 - self.green_dip * (-0.5 * ((l - 520.0) / 30.0).powi(2)).exp();
        uv_end * red * dip
    }
}

/// The conversion for one filter-and-film pair: seven integrals over the
/// visible band, one per basis spectrum, and the pair's reach into the
/// near infrared, all normalized so the flat spectrum integrates to one.
/// Past 700 nm the pixel's reflectance is its visible gray lifted by the
/// prior at its hue, so a neutral stays exactly itself.
#[derive(Clone)]
pub struct Conversion {
    weights: [f32; 7],
    /// The pair's normalized throughput past 700 nm.
    nir: f32,
    /// Where that throughput sits, 0 at 720 nm and 1 at 850 and beyond:
    /// the slope's lever.
    nir_depth: f32,
    prior: IrPrior,
}

impl Conversion {
    /// None when neither a filter nor a film is named: the mixer's job.
    pub fn new(filter_key: &str, film_key: &str) -> Option<Conversion> {
        let f = filter(filter_key);
        let s = sensitivity(film_key);
        if f.is_none() && s.is_none() {
            return None;
        }
        Self::with_prior(filter_key, film_key, IrPrior::default_prior())
    }

    /// The same pair with a prior of the user's (the panel's materials
    /// and curve).
    pub fn with_prior(filter_key: &str, film_key: &str, prior: IrPrior) -> Option<Conversion> {
        let f = filter(filter_key);
        let s = sensitivity(film_key);
        if f.is_none() && s.is_none() {
            return None;
        }
        let through = |l: f32| f.map(|f| f.transmission(l)).unwrap_or(1.0) * s.map(|s| s.response(l)).unwrap_or(1.0);
        // Only an infrared stock, or an infrared filter without a
        // named stock, asks for the guessed band. The visible films'
        // smooth roll-offs are not infrared sensitivity, and no stock
        // on a visible filter means the visible band alone.
        let infrared = matches!(film_key, "rolleiir" | "hie")
            || (s.is_none() && matches!(filter_key, "r72" | "r85"));
        let mut weights = [0.0f32; 7];
        let mut nir = 0.0f32;
        let mut nir_pos = 0.0f32;
        let mut norm = 0.0f32;
        for i in 0..SAMPLES {
            if i >= NIR_FROM && !infrared { continue; }
            let l = lambda(i);
            let t = through(l);
            norm += t;
            if i < NIR_FROM {
                for (b, w) in weights.iter_mut().enumerate() {
                    *w += basis(b, l) * t;
                }
            } else {
                nir += t;
                nir_pos += t * ((l - 720.0) / 130.0).clamp(0.0, 1.0);
            }
        }
        // A pair that passes nothing (an 850 filter on a film blind past
        // 660 nm) is a black frame, not the mixer: the honest answer to
        // a combination nobody would load.
        if norm <= 1e-6 {
            return Some(Conversion { weights: [0.0; 7], nir: 0.0, nir_depth: 0.0, prior });
        }
        for w in weights.iter_mut() {
            *w /= norm;
        }
        let nir_depth = if nir > 1e-9 { nir_pos / nir } else { 0.0 };
        Some(Conversion { weights, nir: nir / norm, nir_depth, prior })
    }

    /// How much of the pair's throughput lies past the visible band: one
    /// for a 720 filter on an infrared film, nothing for a panchromatic
    /// pair, which is what makes the visible path exact for them.
    pub fn infrared_share(&self) -> f32 {
        self.nir
    }

    /// The gray of a scene-linear pixel: Smits' weights by channel order,
    /// dotted with the pair's integrals. Linear and homogeneous in the
    /// pixel, so it is as happy above white as below.
    pub fn gray(&self, r: f32, g: f32, b: f32) -> f32 {
        let (r, g, b) = (r.max(0.0), g.max(0.0), b.max(0.0));
        if self.nir < 1e-4 {
            return self.visible(r, g, b);
        }
        let lab = crate::color::linear_to_oklab(r, g, b);
        let (hue, chroma) = crate::color::oklch_of(lab);
        let gate = crate::ops::black_white_hue_gate(
            crate::ops::black_white_saturation(chroma, lab[0]),
            crate::ops::black_white_neutral_floor(crate::ops::BW_NEUTRAL_DEFAULT),
        );
        self.gray_at(r, g, b, hue, gate)
    }

    /// The gray with the hue and its gate supplied: the render reads them
    /// from a smoothed field, so a JPEG's chroma blocks and the sensor's
    /// chroma noise do not become the guess (2026-09-15: "the scene
    /// pixelates (look at the clouds)").
    pub fn gray_at(&self, r: f32, g: f32, b: f32, hue: f32, gate: f32) -> f32 {
        let (r, g, b) = (r.max(0.0), g.max(0.0), b.max(0.0));
        let visible = self.visible(r, g, b);
        if self.nir < 1e-4 {
            return visible;
        }
        // The near infrared: the pixel's visible gray, lifted by the
        // prior at its hue through the chroma gate, and by the slope
        // for how deep the pair reaches. Linear light: a stop is a
        // doubling.
        let y = crate::buffers::luma(r, g, b).max(0.0);
        let lift = (self.prior.lift(hue) + IrPrior::slope(hue) * self.nir_depth) * gate;
        (visible + y * 2f32.powf(lift) * self.nir).max(0.0)
    }

    fn visible(&self, r: f32, g: f32, b: f32) -> f32 {
        let w = &self.weights;
        // (white, cyan, magenta, yellow, red, green, blue)
        let v = if r <= g && g <= b {
            r * w[0] + (g - r) * w[1] + (b - g) * w[6]
        } else if r <= b && b <= g {
            r * w[0] + (b - r) * w[1] + (g - b) * w[5]
        } else if g <= r && r <= b {
            g * w[0] + (r - g) * w[2] + (b - r) * w[6]
        } else if g <= b && b <= r {
            g * w[0] + (b - g) * w[2] + (r - b) * w[4]
        } else if b <= r && r <= g {
            b * w[0] + (r - b) * w[3] + (g - r) * w[5]
        } else {
            b * w[0] + (g - b) * w[3] + (r - g) * w[4]
        };
        v.max(0.0)
    }
}

/// The stock keys the panel offers, the one list Film and the conversion
/// share (decision 3).
pub fn stock_keys() -> impl Iterator<Item = &'static str> {
    STOCKS.iter().map(|s| s.key)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn review_visible_pairs_never_read_the_infrared_guess() {
        for film in ["", "hp5", "fp4", "trix", "tmax400", "ortho"] {
            for filter in ["", "w8", "w11", "w15", "w21", "w25", "w29", "w47", "w58"] {
                let Some(pair) = Conversion::new(filter, film) else { continue };
                assert_eq!(pair.infrared_share(), 0.0, "{filter}/{film}");
            }
        }
        assert!(Conversion::new("", "rolleiir").unwrap().infrared_share() > 0.1);
        assert!(Conversion::new("r72", "").unwrap().infrared_share() > 0.9);
    }

    fn lum(r: f32, g: f32, b: f32) -> f32 {
        crate::buffers::luma(r, g, b)
    }

    #[test]
    fn every_film_has_a_sensitivity_and_nothing_named_is_the_mixers_job() {
        for k in stock_keys() {
            assert!(sensitivity(k).is_some(), "{k}");
        }
        assert!(Conversion::new("", "").is_none());
        assert!(Conversion::new("w25", "").is_some());
        assert!(Conversion::new("", "hp5").is_some());
        assert!(Conversion::new("nope", "nope").is_none());
    }

    #[test]
    fn a_neutral_keeps_its_value_under_every_filter_and_film_that_passes_light() {
        for f in FILTERS.iter().map(|f| f.key).chain(std::iter::once("")) {
            for s in SENSITIVITIES.iter().map(|s| s.key).chain(std::iter::once("")) {
                if f.is_empty() && s.is_empty() {
                    continue;
                }
                let c = Conversion::new(f, s).unwrap();
                // An infrared filter on a film blind before its cut passes
                // nothing: a black frame, by design, and only then.
                if c.gray(0.5, 0.5, 0.5) == 0.0 {
                    let infrared_film = ["rolleiir", "hie", ""].contains(&s);
                    assert!(f.starts_with('r') && !infrared_film, "{f}/{s} should pass light");
                    continue;
                }
                for v in [0.02f32, 0.18, 1.0, 3.0] {
                    assert!((c.gray(v, v, v) - v).abs() < 1e-4, "{f}/{s} at {v}: {}", c.gray(v, v, v));
                }
            }
        }
    }

    #[test]
    fn a_red_filter_lightens_red_and_darkens_blue_and_a_blue_filter_the_reverse() {
        let red = Conversion::new("w25", "hp5").unwrap();
        let blue = Conversion::new("w47", "hp5").unwrap();
        let (r, b) = ((0.8, 0.05, 0.05), (0.05, 0.05, 0.8));
        assert!(red.gray(r.0, r.1, r.2) > lum(r.0, r.1, r.2) * 1.5, "red through 25");
        assert!(red.gray(b.0, b.1, b.2) < lum(b.0, b.1, b.2) * 0.5, "blue through 25");
        assert!(blue.gray(b.0, b.1, b.2) > lum(b.0, b.1, b.2) * 1.5, "blue through 47");
        assert!(blue.gray(r.0, r.1, r.2) < lum(r.0, r.1, r.2) * 0.5, "red through 47");
    }

    #[test]
    fn orthochromatic_renders_a_red_darker_than_a_cyan_of_equal_luminance_and_panchromatic_within_a_stop() {
        // Infrared haze lifts only where depth says far; near foliage keeps its tone.
        let ortho = Conversion::new("", "ortho").unwrap();
        let pan = Conversion::new("", "hp5").unwrap();
        let red = (0.8f32, 0.05f32, 0.05f32);
        let y = lum(red.0, red.1, red.2);
        // A cyan of the same Rec.709 luminance.
        let k = y / lum(0.05, 0.8, 0.8);
        let cyan = (0.05 * k, 0.8 * k, 0.8 * k);
        // Near black, not merely darker: a saturated red on an orthochromatic
        // film keeps only what its blue and green reflectance lets through
        // (this red carries six percent of gray, and keeps about that).
        assert!(ortho.gray(red.0, red.1, red.2) < ortho.gray(cyan.0, cyan.1, cyan.2) * 0.3);
        assert!(ortho.gray(red.0, red.1, red.2) < lum(red.0, red.1, red.2) * 0.5, "ortho red {} vs luma {}", ortho.gray(red.0, red.1, red.2), lum(red.0, red.1, red.2));
        // What leaks is the pixel's own gray share: a pure red is gone.
        assert!(ortho.gray(1.0, 0.0, 0.0) < 0.03, "a pure red on ortho: {}", ortho.gray(1.0, 0.0, 0.0));
        let ratio = pan.gray(red.0, red.1, red.2) / pan.gray(cyan.0, cyan.1, cyan.2);
        assert!((0.5..2.0).contains(&ratio), "panchromatic within a stop: {ratio}");
    }

    #[test]
    fn the_yellow_filters_order_the_sky_from_light_to_dark() {
        let sky = (0.35f32, 0.5f32, 0.9f32);
        let g = |k: &str| Conversion::new(k, "hp5").unwrap().gray(sky.0, sky.1, sky.2);
        assert!(g("w8") > g("w15"));
        assert!(g("w15") > g("w21"));
        assert!(g("w21") > g("w25"));
        assert!(g("w25") > g("w29"));
    }

    /// Infrared: through a 720 filter on Rollei IR, foliage goes several
    /// times its visible gray, sky near black, a neutral stays itself,
    /// and a panchromatic pair has no infrared share at all.
    #[test]
    fn infrared_lifts_foliage_and_drops_the_sky_and_leaves_neutrals_alone() {
        let ir = Conversion::new("r72", "rolleiir").unwrap();
        assert!(ir.infrared_share() > 0.95, "a 720 on an IR film is all infrared: {}", ir.infrared_share());
        let pan = Conversion::new("w25", "hp5").unwrap();
        assert!(pan.infrared_share() < 0.02, "panchromatic: {}", pan.infrared_share());
        let leaf = (0.12f32, 0.32f32, 0.06f32);
        let sky = (0.30f32, 0.48f32, 0.90f32);
        let yl = lum(leaf.0, leaf.1, leaf.2);
        let ys = lum(sky.0, sky.1, sky.2);
        assert!(ir.gray(leaf.0, leaf.1, leaf.2) > yl * 3.0, "foliage lifted: {} vs {yl}", ir.gray(leaf.0, leaf.1, leaf.2));
        assert!(ir.gray(sky.0, sky.1, sky.2) < ys * 0.3, "sky dropped: {} vs {ys}", ir.gray(sky.0, sky.1, sky.2));
        for v in [0.05f32, 0.18, 0.8] {
            assert!((ir.gray(v, v, v) - v).abs() < 1e-4, "neutral {v}: {}", ir.gray(v, v, v));
        }
        // A prior of the user's changes the answer: foliage flat.
        let flat = IrPrior::from_materials(IrMaterials { foliage: 0.0, sky: 0.0, water: 0.0, skin: 0.0 });
        let dull = Conversion::with_prior("r72", "rolleiir", flat).unwrap();
        // Within the sliver of visible light a 720 filter still passes.
        assert!((dull.gray(leaf.0, leaf.1, leaf.2) - yl).abs() < yl * 0.03, "flat prior: {} vs {yl}", dull.gray(leaf.0, leaf.1, leaf.2));
    }

    /// An 850 reaches deeper than a 720, and the sky keeps falling with
    /// depth: on HIE the 850 renders a sky darker than the 720 does,
    /// while foliage sits on its plateau.
    #[test]
    fn a_deeper_filter_drops_the_sky_further_and_leaves_foliage_on_its_plateau() {
        let near = Conversion::new("r72", "hie").unwrap();
        let deep = Conversion::new("r85", "hie").unwrap();
        let sky = (0.30f32, 0.48f32, 0.90f32);
        let leaf = (0.12f32, 0.32f32, 0.06f32);
        // About half a stop: the two pass bands sit a hundred nanometers
        // apart on a fourth-power law, and a 720 on HIE still reaches to
        // 900, so its own band is not shallow.
        assert!(deep.gray(sky.0, sky.1, sky.2) < near.gray(sky.0, sky.1, sky.2) * 0.85, "850 sky {} vs 720 sky {}", deep.gray(sky.0, sky.1, sky.2), near.gray(sky.0, sky.1, sky.2));
        let ratio = deep.gray(leaf.0, leaf.1, leaf.2) / near.gray(leaf.0, leaf.1, leaf.2);
        assert!((0.9..1.1).contains(&ratio), "foliage holds: {ratio}");
    }

    #[test]
    fn the_prior_wraps_round_the_wheel_and_a_curve_of_the_users_replaces_it() {
        let p = IrPrior::default_prior();
        assert!((p.lift(150.0) - 2.4).abs() < 1e-4);
        assert!(p.lift(230.0) < -2.0);
        // Between the last point (320) and the first (20) through 0: on
        // the way from flat to skin's lift, and rising.
        let a = p.lift(350.0);
        let b = p.lift(10.0);
        assert!(a > -0.2 && a < 0.6 && b > a, "wrap: {a} {b}");
        // A user's curve: green down instead of up.
        let curve = crate::ops::parse_eq_points(r#"[{"x":30,"y":0},{"x":150,"y":-1},{"x":270,"y":0}]"#);
        let user = IrPrior::from_points(curve);
        assert!((user.lift(150.0) + 1.0).abs() < 1e-4);
        // One point is not a curve: the default.
        let one = IrPrior::from_points(crate::ops::parse_eq_points(r#"[{"x":150,"y":-1}]"#));
        assert!((one.lift(150.0) - 2.4).abs() < 1e-4);
    }

    #[test]
    fn the_conversion_is_linear_in_the_pixel() {
        let c = Conversion::new("w15", "trix").unwrap();
        let a = c.gray(0.3, 0.5, 0.2);
        assert!((c.gray(0.6, 1.0, 0.4) - 2.0 * a).abs() < 1e-5);
    }
}
