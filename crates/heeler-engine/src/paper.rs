//! The print: the paper as a node in the display domain, last before
//! Output. Levels and Curves shape the negative-to-print; this is the
//! paper the print is made on.
//!
//! The picture arriving here is the ideal print of phase 3 (the negative
//! on a grade 2 paper, scene white on paper white) or, without a film,
//! the rendered photograph; either way a display-linear value v, and
//! the print density it stands for is D = -log10(v). The paper reworks
//! that density: a grade is a contrast around middle gray's density,
//! a time is more or less exposure, and the deepest black is the
//! paper's Dmax and not the screen's. Split grade is the printer's
//! pair: a soft exposure (grade 0) that lays the highlights and a hard
//! one (grade 5) that sets the shadows, each with its own time, met by
//! density. Base is the paper's white, cold to warm, on every
//! reflected value. Toning is a function of density, not of hue band,
//! which is what separates it from Split Tone: selenium deepens and
//! cools the shadows first, sepia warms the highlights first, gold is
//! a blue-black, and split is sepia in the highlights over gold in the
//! shadows with the crossover a dial.
//!
//! A color photograph is printed by its luminance and keeps its
//! color, so the node is safe anywhere; under the treatment it is the
//! print.

use crate::buffers::{luma, Value};
use crate::executor::EngineError;
use crate::ops::{image_input, map_rgb, p, p_bool, smoothstep};
use heeler_graph::Node;
use std::sync::Arc;

/// Middle gray's density on the ideal print, the pivot a grade turns
/// about: -log10(0.18).
pub const D_PIVOT: f32 = 0.744_727_5;

/// The paper's contrast at a grade, relative to grade 2: a grade is a
/// sixth more contrast than the one below, so grade 0 is three
/// quarters and grade 5 is a half again (the ISO(R) ladder, smoothed).
pub fn contrast_of(grade: f32) -> f32 {
    1.16f32.powf(grade.clamp(0.0, 5.0) - 2.0)
}

/// The density one grade makes of the ideal print's density `d` with
/// `time` stops of exposure, capped at the paper's `dmax`: contrast
/// about the pivot, a stop of time worth a paper gamma of a stop, no
/// density below the paper's white, and a soft shoulder into Dmax.
pub fn graded(d: f32, grade: f32, time: f32, dmax: f32) -> f32 {
    let c = contrast_of(grade);
    let lin = c * (d - D_PIVOT + crate::film::PAPER_GAMMA * 0.301 * time) + D_PIVOT;
    let lin = lin.max(0.0);
    const SOFT: f32 = 0.25;
    -SOFT * ((-lin / SOFT).exp() + (-dmax / SOFT).exp()).ln()
}

/// One print's settings, read off the node.
#[derive(Clone, Copy, Debug)]
pub struct Print {
    pub grade: f32,
    pub time: f32,
    pub split: bool,
    pub soft: f32,
    pub hard: f32,
    pub dmax: f32,
    /// -100 cold to 100 warm
    pub base: f32,
    pub toner: Toner,
    /// 0..1
    pub toning: f32,
    /// 0..100, where the highlight toner hands over to the shadow toner
    pub crossover: f32,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Toner {
    None,
    Selenium,
    Sepia,
    Gold,
    Split,
}

impl Toner {
    pub fn parse(key: &str) -> Toner {
        match key {
            "selenium" => Toner::Selenium,
            "sepia" => Toner::Sepia,
            "gold" => Toner::Gold,
            "split" => Toner::Split,
            _ => Toner::None,
        }
    }
}

/// A tint scaled to unit luminance, so toning and base move the color
/// of a value and not its brightness.
fn unit_tint(rgb: [f32; 3]) -> [f32; 3] {
    let y = luma(rgb[0], rgb[1], rgb[2]).max(1e-6);
    [rgb[0] / y, rgb[1] / y, rgb[2] / y]
}

// The baths at full strength, unmistakable at Toning 100 and dialed
// back from there (2026-09-15: "Toner doesn't seem to work": the
// first cut's tints were too timid to read).
const SELENIUM: [f32; 3] = [0.93, 0.90, 1.08];
const SEPIA: [f32; 3] = [1.22, 1.0, 0.72];
const GOLD: [f32; 3] = [0.84, 0.94, 1.18];
const WARM_BASE: [f32; 3] = [1.0, 0.975, 0.92];
const COLD_BASE: [f32; 3] = [0.93, 0.965, 1.0];

fn lerp3(a: [f32; 3], b: [f32; 3], t: f32) -> [f32; 3] {
    [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]
}

impl Print {
    pub fn from_node(node: &Node) -> Print {
        Print {
            grade: p(&node.params, "grade", 2.0),
            time: p(&node.params, "time", 0.0),
            split: p_bool(&node.params, "split", false),
            soft: p(&node.params, "soft", 0.0),
            hard: p(&node.params, "hard", 0.0),
            dmax: p(&node.params, "dmax", 2.1).clamp(1.0, 3.0),
            base: p(&node.params, "base", 0.0).clamp(-100.0, 100.0),
            toner: Toner::parse(node.params.get("toner").and_then(|v: &heeler_graph::ParamValue| v.as_str()).unwrap_or("")),
            toning: (p(&node.params, "toning", 0.0) / 100.0).clamp(0.0, 1.0),
            crossover: p(&node.params, "crossover", 50.0).clamp(0.0, 100.0),
        }
    }

    /// The print's density for the ideal print's density `d`.
    pub fn density(&self, d: f32) -> f32 {
        let mut out = if self.split {
            // Two exposures on one sheet add density, each with its own
            // contrast: the soft one lays tone everywhere the negative
            // lets light through, most of all in the highlights, and
            // the hard one, steep about middle gray, reaches the
            // highlights hardly at all and builds the shadows. A sum
            // of two curves that rise with the negative's density
            // rises too, so the print keeps its tonal order whatever
            // the two times (review 2026-09-15, item 5; the first cut
            // blended the two by density and could reverse it). Each
            // at half, so equal times print about a grade 2.
            0.5 * graded(d, 0.0, self.soft, self.dmax) + 0.5 * graded(d, 5.0, self.hard, self.dmax)
        } else {
            graded(d, self.grade, self.time, self.dmax)
        };
        // Selenium deepens the shadows it tones.
        if matches!(self.toner, Toner::Selenium) && self.toning > 0.0 {
            out += 0.15 * self.toning * self.shadow_weight(out);
        }
        // The shoulder's soft minimum dips a hair under zero at the
        // paper's white; the paper has no density below its white.
        out.clamp(0.0, self.dmax)
    }

    /// Where the shadow toner sits: a fade in density about the
    /// crossover, 0.3 at the dial's bottom to 1.5 at its top.
    fn shadow_weight(&self, d: f32) -> f32 {
        let dc = 0.3 + 1.2 * self.crossover / 100.0;
        smoothstep(dc - 0.4, dc + 0.4, d)
    }

    /// The tint on a value of print density `d`: the toner by density,
    /// then the paper's base on everything.
    pub fn tint(&self, d: f32) -> [f32; 3] {
        let mut t = [1.0f32; 3];
        if self.toning > 0.0 {
            let ws = self.shadow_weight(d);
            let wh = 1.0 - ws;
            let (shadow, high): (Option<[f32; 3]>, Option<[f32; 3]>) = match self.toner {
                Toner::None => (None, None),
                Toner::Selenium => (Some(SELENIUM), None),
                Toner::Gold => (Some(GOLD), None),
                Toner::Sepia => (None, Some(SEPIA)),
                Toner::Split => (Some(GOLD), Some(SEPIA)),
            };
            if let Some(s) = shadow {
                t = lerp3(t, unit_tint(s), self.toning * ws);
            }
            if let Some(h) = high {
                t = lerp3(t, unit_tint(h), self.toning * wh);
            }
        }
        if self.base != 0.0 {
            let b = (self.base / 100.0).abs();
            let base = if self.base > 0.0 { WARM_BASE } else { COLD_BASE };
            t = lerp3(t, unit_tint(base), b);
        }
        t
    }

    /// The printed value of a display-linear luminance, and its tint.
    pub fn print(&self, y: f32) -> (f32, [f32; 3]) {
        let v = y.clamp(1e-6, 1.0);
        let d = self.density(-v.log10());
        (10f32.powf(-d), self.tint(d))
    }
}

/// The node: every pixel printed by its luminance, its color riding
/// along, the paper's tint over it.
pub fn paper(node: &Node, inputs: &[(String, Value)]) -> Result<Value, EngineError> {
    let src = image_input(inputs, "in", &node.id)?;
    let print = Print::from_node(node);
    let out = map_rgb(src, |r, g, b| {
        let y = luma(r.max(0.0), g.max(0.0), b.max(0.0));
        if y <= 1e-6 {
            let (v, t) = print.print(0.0);
            return [v * t[0], v * t[1], v * t[2]];
        }
        let (v, t) = print.print(y);
        let k = v / y;
        [r.max(0.0) * k * t[0], g.max(0.0) * k * t[1], b.max(0.0) * k * t[2]]
    });
    Ok(Value::Image(Arc::new(out)))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::buffers::ImageBuf;

    fn at(grade: f32, time: f32, dmax: f32) -> Print {
        Print { grade, time, split: false, soft: 0.0, hard: 0.0, dmax, base: 0.0, toner: Toner::None, toning: 0.0, crossover: 50.0 }
    }

    #[test]
    fn review_crossover_moves_the_shadow_toner_toward_deeper_density() {
        let mut print = at(2.0, 0.0, 2.1);
        print.toner = Toner::Gold;
        print.toning = 1.0;
        print.crossover = 0.0;
        let low = print.tint(D_PIVOT);
        print.crossover = 100.0;
        let high = print.tint(D_PIVOT);
        assert!(low[2] - low[0] > 0.2);
        assert!((high[2] - high[0]).abs() < 1e-6);
        for y in [0.0, 1e-12, 0.18, 1.0, 4.0] {
            let (value, tint) = print.print(y);
            assert!(value.is_finite() && tint.iter().all(|v| v.is_finite()));
        }
    }

    /// Grade 2 at no time is the ideal print through the midtones, and
    /// the paper's black is Dmax, not zero.
    #[test]
    fn grade_two_is_the_ideal_print_and_black_is_the_papers() {
        let p = at(2.0, 0.0, 2.1);
        for v in [0.9f32, 0.5, 0.18, 0.05] {
            let (out, _) = p.print(v);
            // Within three percent: the shoulder into Dmax lifts the darkest of these a touch.
            assert!((out - v).abs() < 0.03 * v, "grade 2 holds {v}: {out}");
        }
        let (black, _) = p.print(0.0);
        assert!((black - 10f32.powf(-2.1)).abs() < 1e-3, "the deepest black is the paper's: {black}");
        let (white, _) = p.print(1.0);
        assert!((white - 1.0).abs() < 1e-6, "paper white is white: {white}");
        let matte = at(2.0, 0.0, 1.7);
        assert!(matte.print(0.0).0 > black * 2.0, "a matte paper's black is lighter");
    }

    /// A harder grade spreads the tones about middle gray; a softer one
    /// gathers them; time darkens the whole print.
    #[test]
    fn grade_is_contrast_about_middle_gray_and_time_is_exposure() {
        let (mid_hard, _) = at(4.0, 0.0, 2.1).print(0.18);
        let (mid_soft, _) = at(0.0, 0.0, 2.1).print(0.18);
        assert!((mid_hard - 0.18).abs() < 0.01 && (mid_soft - 0.18).abs() < 0.01, "middle gray is the pivot: {mid_hard} {mid_soft}");
        let (hi_hard, _) = at(4.0, 0.0, 2.1).print(0.6);
        let (hi_soft, _) = at(0.0, 0.0, 2.1).print(0.6);
        assert!(hi_hard > 0.6 && hi_soft < 0.6, "a hard grade lifts a light tone and a soft grade lowers it: {hi_hard} {hi_soft}");
        let (lo_hard, _) = at(4.0, 0.0, 2.1).print(0.05);
        let (lo_soft, _) = at(0.0, 0.0, 2.1).print(0.05);
        assert!(lo_hard < 0.05 && lo_soft > 0.05, "and the reverse for a dark one: {lo_hard} {lo_soft}");
        let (longer, _) = at(2.0, 1.0, 2.1).print(0.5);
        let (shorter, _) = at(2.0, -1.0, 2.1).print(0.5);
        assert!(longer < 0.5 && shorter > 0.5, "more time is a darker print: {longer} {shorter}");
    }

    /// Split grade: the soft time moves the highlights and leaves the
    /// shadows; the hard time the reverse.
    #[test]
    fn split_grade_times_own_their_ends() {
        let mut s = at(2.0, 0.0, 2.1);
        s.split = true;
        let base_hi = s.print(0.7).0;
        let base_lo = s.print(0.04).0;
        s.soft = 1.0;
        let soft_hi = s.print(0.7).0;
        let soft_lo = s.print(0.04).0;
        assert!(soft_hi < base_hi * 0.9, "the soft time darkens the highlights: {soft_hi} vs {base_hi}");
        // Light adds up, so the soft time reaches the shadows too, but
        // by less, in stops, than it moves the highlights.
        let (hi_stops, lo_stops) = ((base_hi / soft_hi).log2(), (base_lo / soft_lo).log2());
        assert!(hi_stops > lo_stops, "the soft time is the highlights' more than the shadows': {hi_stops} vs {lo_stops} stops");
        s.soft = 0.0;
        s.hard = 1.0;
        let hard_hi = s.print(0.7).0;
        let hard_lo = s.print(0.04).0;
        assert!(hard_lo < base_lo * 0.8, "the hard time deepens the shadows: {hard_lo} vs {base_lo}");
        // A stop more hard exposure reaches the highlights too, as it
        // does under an enlarger once they sit above the paper's toe;
        // the shadows, against Dmax, move least. What holds is the
        // deepening and the order, held by the next test.
        assert!(hard_hi < base_hi, "and darkens the highlights as well: {hard_hi} vs {base_hi}");
    }

    /// Whatever the two times, the print keeps its tonal order: two
    /// exposures add density, and a sum of rising curves rises.
    #[test]
    fn split_grade_keeps_tonal_order_for_any_two_times() {
        let ramp: Vec<f32> = (0..=40).map(|i| 0.002 * 1.17f32.powi(i)).map(|v| v.min(1.0)).collect();
        for soft in [-2.0f32, -1.0, 0.0, 1.0, 2.0] {
            for hard in [-2.0f32, -1.0, 0.0, 1.0, 2.0] {
                let mut s = at(2.0, 0.0, 2.1);
                s.split = true;
                s.soft = soft;
                s.hard = hard;
                let mut prev = -1.0f32;
                for &v in &ramp {
                    let out = s.print(v).0;
                    assert!(out >= prev - 1e-6, "soft {soft} hard {hard}: {v} printed {out} under a darker tone's {prev}");
                    prev = out;
                }
            }
        }
    }

    /// Toning is by density: sepia warms a highlight and leaves a
    /// shadow, selenium cools and deepens a shadow and leaves a
    /// highlight; both keep the value's luminance. Base tints the
    /// white.
    #[test]
    fn toning_is_by_density_and_keeps_luminance() {
        let mut s = at(2.0, 0.0, 2.1);
        s.toner = Toner::Sepia;
        s.toning = 1.0;
        let (_, hi) = s.print(0.8);
        let (_, lo) = s.print(0.02);
        assert!(hi[0] > hi[2] * 1.15, "sepia warms the highlight: {hi:?}");
        assert!((lo[0] - lo[2]).abs() < 0.03, "and leaves the shadow: {lo:?}");
        assert!((luma(hi[0], hi[1], hi[2]) - 1.0).abs() < 1e-3, "a tint is unit luminance");
        s.toner = Toner::Selenium;
        let plain = at(2.0, 0.0, 2.1).print(0.02).0;
        let (v, lo) = s.print(0.02);
        assert!(lo[2] > lo[0] && v < plain, "selenium cools and deepens the shadow: {lo:?}, {v} vs {plain}");
        let (_, hi) = s.print(0.8);
        assert!((hi[0] - hi[2]).abs() < 0.02, "and leaves the highlight: {hi:?}");
        let mut warm = at(2.0, 0.0, 2.1);
        warm.base = 100.0;
        let (_, w) = warm.print(1.0);
        assert!(w[0] > w[2], "a warm base is a warm white: {w:?}");
    }

    /// The node prints by luminance and keeps color; a neutral stays
    /// neutral.
    #[test]
    fn the_node_prints_by_luminance_and_keeps_colour() {
        use heeler_graph::ParamValue;
        let mut node = heeler_graph::Registry::builtin()
            .instantiate("heeler.paper", "n", heeler_graph::Section::Creative)
            .unwrap();
        node.params.insert("grade".into(), ParamValue::Number(4.0));
        let mut img = ImageBuf::new(2, 1);
        img.set_pixel(0, 0, [0.6, 0.6, 0.6, 1.0]);
        img.set_pixel(1, 0, [0.8, 0.5, 0.3, 1.0]);
        let out = paper(&node, &[("in".to_string(), Value::Image(Arc::new(img)))]).unwrap();
        let o = out.as_image().unwrap();
        let g = o.pixel(0, 0);
        assert!((g[0] - g[1]).abs() < 1e-6 && (g[1] - g[2]).abs() < 1e-6, "a neutral stays neutral");
        assert!(g[0] > 0.6, "grade 4 lifts a light neutral: {}", g[0]);
        let c = o.pixel(1, 0);
        assert!((c[0] / c[2] - 0.8 / 0.3).abs() < 1e-3, "color ratios hold: {c:?}");
    }
}
