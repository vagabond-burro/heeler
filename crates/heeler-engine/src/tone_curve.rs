//! The Tone Profile's Custom mode: a curve the user draws, from scene
//! light to display.
//!
//! The input axis is scene light in stops around middle gray (0 is a
//! scene value of 0.18, +1 twice that, scene white about +2.47), so a
//! point means the same thing whatever exposure the curve meets, and a
//! curve can reach past white and bring highlights back the way a
//! film stock's shoulder does. The output is a display value, sRGB
//! encoded, 0 to 1: what the Standard mode's S produces before it goes
//! back to scene linear.
//!
//! The curve rides in the node's `curve` text param as JSON, every
//! point in it, so a document renders the same on a machine that never
//! saw the profile file it was picked from:
//! `{"name": "Soft", "interp": "smooth", "points": [[-8, 0], [0, 0.46], [2.47, 1]]}`.
//! Smooth is the Curves node's monotone Hermite (no overshoot between
//! points), linear is straight segments, and tangent is Curves' tangent
//! mode: the Hermite through each point's own slope (`tangents`), or,
//! where a point carries handle vectors (`handles`, in stops and display
//! units), the Bezier through them, so a handle's length shapes its
//! segment as it does in Curves (2026-10-29: "could the tone curve
//! support tangents like the other curve editors do?"). Past either end
//! the end's value holds, so below the first point is that point's
//! black and above the last that point's white.
//!
//! The imports (a 1D .cube, a two-column text file, a camera profile's
//! ProfileToneCurve) all come down to a function from scene light to
//! display, sampled here at half stops into a curve of the same form.

use serde::{Deserialize, Serialize};

use crate::ops::{eval_curve_with, eval_eq_points, monotone_tangents, to_display, to_scene, EqPoint};

/// Scene middle gray, the axis's 0.
pub const MIDDLE_GRAY: f32 = 0.18;

/// The most points a curve may carry. A hand-drawn curve has a dozen;
/// imports are resampled to a few dozen; this keeps a hostile document
/// from asking for a table the size of the photograph.
pub const MAX_POINTS: usize = 1024;

/// The furthest from middle gray a point may sit, in stops.
pub const MAX_STOPS: f32 = 24.0;

/// Where a resampled import starts, in stops: eight below middle gray
/// is under a display value of 0.01 on any sensible curve, and below
/// the first point the curve holds.
pub const RESAMPLE_FLOOR: f32 = -8.0;

/// Scene white, 1.0, in stops above middle gray.
pub fn white_stops() -> f32 {
    (1.0 / MIDDLE_GRAY).log2()
}

/// Entries in the table a render looks the curve up in. Over a curve
/// spanning eleven stops that is a step of under 0.003 stops, finer
/// than any display value can show.
const TABLE: usize = 4096;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ToneCurve {
    #[serde(default)]
    pub name: String,
    /// "smooth" (the default) or "linear".
    #[serde(default = "smooth")]
    pub interp: String,
    /// (stops, display) pairs, sorted by stops.
    pub points: Vec<[f32; 2]>,
    /// Tangent mode's slope at each point, display per stop, parallel to
    /// the points. Read only under "tangent"; a list of another length
    /// is dropped, and the curve falls back to the monotone slopes.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tangents: Option<Vec<f32>>,
    /// Tangent mode's handle vectors, parallel to the points, null for
    /// an automatic point. Preferred over the slopes where any point has
    /// one, as in Curves.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub handles: Option<Vec<Option<ToneHandle>>>,
}

/// One point's handle pair: vectors from the point, in stops and display
/// units, either side or both.
#[derive(Debug, Clone, Copy, PartialEq, Default, Serialize, Deserialize)]
pub struct ToneHandle {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub l: Option<[f32; 2]>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub r: Option<[f32; 2]>,
}

/// How a checked curve is read between its points.
enum Shape {
    Through(Option<Vec<f32>>),
    Handles(Vec<EqPoint>),
}

fn smooth() -> String {
    "smooth".into()
}

impl ToneCurve {
    /// The curve a `curve` param holds, checked: two points at least,
    /// finite, inside the axis, no two at the same place. Points are
    /// sorted; display values outside 0 to 1 are held to it.
    pub fn from_json(text: &str) -> Result<Self, String> {
        let curve: ToneCurve = serde_json::from_str(text).map_err(|e| format!("bad tone curve JSON: {e}"))?;
        curve.checked()
    }

    pub fn to_json(&self) -> String {
        serde_json::to_string(self).unwrap_or_default()
    }

    /// The same curve, sorted and held to its limits, or why it cannot be.
    pub fn checked(mut self) -> Result<Self, String> {
        if self.interp != "smooth" && self.interp != "linear" && self.interp != "tangent" {
            return Err(format!("unknown interpolation \"{}\": smooth, linear or tangent", self.interp));
        }
        if self.points.len() < 2 {
            return Err("a tone curve needs two points at least".into());
        }
        if self.points.len() > MAX_POINTS {
            return Err(format!("a tone curve may have at most {MAX_POINTS} points, this one has {}", self.points.len()));
        }
        if self.points.iter().any(|[x, y]| !x.is_finite() || !y.is_finite()) {
            return Err("a tone curve's points must be finite numbers".into());
        }
        if self.points.iter().any(|[x, _]| x.abs() > MAX_STOPS) {
            return Err(format!("a tone curve's points must sit within {MAX_STOPS} stops of middle gray"));
        }
        // Slopes and handles ride with their points through the sort; a
        // list that does not match the points, or holds a number that is
        // not one, is dropped rather than guessed at.
        let n = self.points.len();
        if self.interp != "tangent" {
            self.tangents = None;
            self.handles = None;
        }
        if self.tangents.as_ref().is_some_and(|t| t.len() != n || t.iter().any(|v| !v.is_finite())) {
            self.tangents = None;
        }
        let finite = |v: &Option<[f32; 2]>| v.is_none_or(|[a, b]| a.is_finite() && b.is_finite());
        if self.handles.as_ref().is_some_and(|h| h.len() != n || h.iter().flatten().any(|p| !finite(&p.l) || !finite(&p.r))) {
            self.handles = None;
        }
        let mut order: Vec<usize> = (0..n).collect();
        order.sort_by(|&a, &b| self.points[a][0].total_cmp(&self.points[b][0]));
        self.points = order.iter().map(|&i| self.points[i]).collect();
        self.tangents = self.tangents.take().map(|t| order.iter().map(|&i| t[i]).collect());
        self.handles = self.handles.take().map(|h| order.iter().map(|&i| h[i]).collect());
        if self.points.windows(2).any(|w| w[1][0] - w[0][0] < 1e-4) {
            return Err("two points of the tone curve sit at the same stop".into());
        }
        for p in &mut self.points {
            p[1] = p[1].clamp(0.0, 1.0);
        }
        Ok(self)
    }

    /// The curve's display value at `stops`, held at the ends.
    pub fn eval(&self, stops: f32) -> f32 {
        self.eval_with(&self.shape(), stops)
    }

    /// Curves' choice, made once: tangent mode with a handle on any point
    /// reads the handle vectors; tangent mode otherwise reads its slopes,
    /// or the monotone ones without; smooth the monotone ones; linear
    /// none.
    fn shape(&self) -> Shape {
        match self.interp.as_str() {
            "linear" => Shape::Through(None),
            "tangent" => {
                if let Some(h) = self.handles.as_ref().filter(|h| h.iter().flatten().any(|p| p.l.is_some() || p.r.is_some())) {
                    return Shape::Handles(
                        self.points
                            .iter()
                            .zip(h)
                            .map(|([x, y], p)| EqPoint { x: *x, y: *y, l: p.and_then(|p| p.l), r: p.and_then(|p| p.r) })
                            .collect(),
                    );
                }
                Shape::Through(Some(self.tangents.clone().unwrap_or_else(|| monotone_tangents(&self.points))))
            }
            _ => Shape::Through(Some(monotone_tangents(&self.points))),
        }
    }

    fn eval_with(&self, shape: &Shape, stops: f32) -> f32 {
        let first = self.points[0];
        let last = self.points[self.points.len() - 1];
        if stops.is_nan() || stops <= first[0] {
            return first[1];
        }
        if stops >= last[0] {
            return last[1];
        }
        match shape {
            Shape::Through(tangents) => eval_curve_with(&self.points, tangents.as_deref(), stops),
            Shape::Handles(eq) => eval_eq_points(eq, stops),
        }
        .clamp(0.0, 1.0)
    }

    /// The curve baked into a table for a render.
    pub fn table(&self) -> CurveTable {
        let shape = self.shape();
        let lo = self.points[0][0];
        let hi = self.points[self.points.len() - 1][0];
        let step = (hi - lo) / (TABLE - 1) as f32;
        let values = (0..TABLE).map(|i| self.eval_with(&shape, lo + step * i as f32)).collect();
        CurveTable { lo, step, values }
    }

    /// A curve from a function of scene light (white 1.0) to display,
    /// sampled at half stops from `lo` to `hi` and at both ends.
    pub fn sampled(name: &str, lo: f32, hi: f32, f: impl Fn(f32) -> f32) -> Self {
        let mut xs = vec![lo];
        let mut x = (lo * 2.0).floor() / 2.0 + 0.5;
        while x < hi - 1e-3 {
            if x > lo + 1e-3 {
                xs.push(x);
            }
            x += 0.5;
        }
        xs.push(hi);
        let points = xs
            .into_iter()
            .map(|x| [x, f(MIDDLE_GRAY * x.exp2()).clamp(0.0, 1.0)])
            .collect();
        ToneCurve { name: name.into(), interp: "smooth".into(), points, tangents: None, handles: None }
    }

    /// A camera profile's ProfileToneCurve: (input, output) pairs,
    /// linear both ways, white at 1. Between pairs the curve runs
    /// straight, as the tag means it; past its ends the end holds.
    pub fn from_linear_pairs(name: &str, pairs: &[(f32, f32)]) -> Result<Self, String> {
        let sound = pairs.len() >= 2
            && pairs.iter().all(|(x, y)| x.is_finite() && y.is_finite())
            && pairs.windows(2).all(|w| w[1].0 >= w[0].0);
        if !sound {
            return Err("the profile's tone curve is not a curve: it needs two points at least, rising".into());
        }
        let top = pairs[pairs.len() - 1].0.max(1e-6);
        let at = |x: f32| to_display(piecewise(pairs, x).max(0.0));
        ToneCurve::sampled(name, RESAMPLE_FLOOR, (top / MIDDLE_GRAY).log2(), at).checked()
    }

    /// A 1D .cube: LUT_1D_SIZE entries of three values over its domain
    /// (0 to 1 unless DOMAIN_MIN and DOMAIN_MAX say otherwise), display
    /// encoded in and out, the way the LUT node reads a 3D one. The
    /// three channels are averaged: a tone curve is one curve.
    pub fn from_cube_1d(name: &str, text: &str) -> Result<Self, String> {
        let mut size = 0usize;
        let (mut lo, mut hi) = (0.0f32, 1.0f32);
        let mut values: Vec<f32> = Vec::new();
        for line in text.lines() {
            let line = line.trim();
            if line.is_empty() || line.starts_with('#') {
                continue;
            }
            let mut parts = line.split_whitespace();
            let head = parts.next().unwrap_or("");
            match head {
                "LUT_1D_SIZE" => {
                    let n: usize = parts.next().and_then(|v| v.parse().ok()).ok_or("bad LUT_1D_SIZE")?;
                    if !(2..=65536).contains(&n) {
                        return Err(format!("unreasonable LUT size {n}"));
                    }
                    size = n;
                }
                "LUT_3D_SIZE" => return Err("a 3D .cube is a color look, not a tone curve: use the LUT node for it".into()),
                "DOMAIN_MIN" | "DOMAIN_MAX" => {
                    let v: f32 = parts.next().and_then(|t| t.parse().ok()).ok_or("bad DOMAIN line")?;
                    if head == "DOMAIN_MIN" { lo = v } else { hi = v }
                }
                _ => {
                    // A data line is three numbers; anything else is a
                    // keyword this reader does not need.
                    let nums: Vec<f32> = line.split_whitespace().filter_map(|t| t.parse().ok()).collect();
                    if nums.len() == 3 && head.parse::<f32>().is_ok() {
                        values.push((nums[0] + nums[1] + nums[2]) / 3.0);
                    }
                }
            }
        }
        if size == 0 {
            return Err("no LUT_1D_SIZE line; not a 1D .cube file".into());
        }
        if values.len() != size {
            return Err(format!("expected {size} entries for a 1D LUT, found {}", values.len()));
        }
        if !(hi > lo) || !lo.is_finite() || !hi.is_finite() || values.iter().any(|v| !v.is_finite()) {
            return Err("the LUT's domain or entries are not usable numbers".into());
        }
        let pairs: Vec<(f32, f32)> =
            values.iter().enumerate().map(|(i, &v)| (lo + (hi - lo) * i as f32 / (size - 1) as f32, v)).collect();
        // Its inputs are display values: at scene white the domain's
        // top, or 1.0 when the domain runs past it.
        let top = to_scene(hi.min(1.0)).max(1e-6);
        let at = |scene: f32| piecewise(&pairs, to_display(scene));
        ToneCurve::sampled(name, RESAMPLE_FLOOR, (top / MIDDLE_GRAY).log2(), at).checked()
    }

    /// A plain text file of two columns: stops around middle gray, then
    /// the display value, one point a line, separated by spaces, tabs
    /// or a comma; `#` starts a comment. The curve's own terms, so a
    /// short file is taken point for point; a long one (a sampled
    /// curve) is resampled at half stops.
    pub fn from_two_columns(name: &str, text: &str) -> Result<Self, String> {
        let mut pairs: Vec<(f32, f32)> = Vec::new();
        for (i, line) in text.lines().enumerate() {
            let line = line.split('#').next().unwrap_or("").trim();
            if line.is_empty() {
                continue;
            }
            let nums: Vec<&str> = line.split(|c: char| c == ',' || c.is_whitespace()).filter(|t| !t.is_empty()).collect();
            let parsed = match nums.as_slice() {
                [a, b] => a.parse::<f32>().ok().zip(b.parse::<f32>().ok()),
                _ => None,
            };
            match parsed {
                Some(p) => pairs.push(p),
                // A header line before any data is a column title.
                None if pairs.is_empty() => continue,
                None => return Err(format!("line {}: expected two numbers, stops and a display value", i + 1)),
            }
        }
        if pairs.len() < 2 {
            return Err("the file needs two lines of two numbers at least: stops, then a display value".into());
        }
        if pairs.iter().any(|(x, y)| !x.is_finite() || !y.is_finite() || x.abs() > MAX_STOPS) {
            return Err(format!("the file's points must be finite and within {MAX_STOPS} stops of middle gray"));
        }
        if pairs.len() <= 64 {
            let points = pairs.iter().map(|&(x, y)| [x, y]).collect();
            return ToneCurve { name: name.into(), interp: "smooth".into(), points, tangents: None, handles: None }.checked();
        }
        pairs.sort_by(|a, b| a.0.total_cmp(&b.0));
        let (lo, hi) = (pairs[0].0, pairs[pairs.len() - 1].0);
        if !lo.is_finite() || !hi.is_finite() || hi - lo < 1e-3 {
            return Err("the file's stops are not usable numbers".into());
        }
        ToneCurve::sampled(name, lo, hi, |scene| piecewise(&pairs, (scene / MIDDLE_GRAY).log2())).checked()
    }
}

/// Straight segments through ascending pairs, the ends held.
fn piecewise(pairs: &[(f32, f32)], x: f32) -> f32 {
    let first = pairs[0];
    let last = pairs[pairs.len() - 1];
    if x.is_nan() || x <= first.0 {
        return first.1;
    }
    if x >= last.0 {
        return last.1;
    }
    let i = pairs.partition_point(|p| p.0 <= x).clamp(1, pairs.len() - 1);
    let (a, b) = (pairs[i - 1], pairs[i]);
    let span = b.0 - a.0;
    if span <= 0.0 { b.1 } else { a.1 + (b.1 - a.1) * (x - a.0) / span }
}

/// A curve baked for a render: display values at even steps of stops
/// from the first point to the last, read by straight interpolation.
pub struct CurveTable {
    lo: f32,
    step: f32,
    values: Vec<f32>,
}

impl CurveTable {
    /// The display value at a scene value (white 1.0).
    #[inline]
    pub fn at_scene(&self, scene: f32) -> f32 {
        self.at(scene.max(0.0).log2() - MIDDLE_GRAY.log2())
    }

    /// The display value at `stops` around middle gray.
    #[inline]
    pub fn at(&self, stops: f32) -> f32 {
        let last = self.values.len() - 1;
        let t = (stops - self.lo) / self.step;
        // NaN and minus infinity (a black pixel) land on the first entry.
        if !(t > 0.0) {
            return self.values[0];
        }
        if t >= last as f32 {
            return self.values[last];
        }
        let i = t as usize;
        let f = t - i as f32;
        self.values[i] + (self.values[i + 1] - self.values[i]) * f
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn curve(points: &[[f32; 2]]) -> ToneCurve {
        ToneCurve { name: "t".into(), interp: "smooth".into(), points: points.to_vec(), tangents: None, handles: None }.checked().unwrap()
    }

    #[test]
    fn a_curve_reads_back_from_its_json() {
        let c = curve(&[[-8.0, 0.0], [0.0, 0.46], [2.5, 1.0]]);
        assert_eq!(ToneCurve::from_json(&c.to_json()).unwrap(), c);
        // interp defaults to smooth, name to empty.
        let bare = ToneCurve::from_json(r#"{"points": [[0, 0.2], [-4, 0]]}"#).unwrap();
        assert_eq!(bare.interp, "smooth");
        assert_eq!(bare.points[0], [-4.0, 0.0], "sorted");
    }

    #[test]
    fn a_curve_that_is_not_one_is_refused() {
        for bad in [
            r#"{"points": [[0, 0.5]]}"#,
            r#"{"points": [[0, 0.5], [0, 0.6]]}"#,
            r#"{"points": [[0, 0.5], [40, 1]]}"#,
            r#"{"interp": "cubic", "points": [[0, 0.5], [1, 1]]}"#,
            r#"{"points": "none"}"#,
        ] {
            assert!(ToneCurve::from_json(bad).is_err(), "{bad}");
        }
        // Display values are held to 0..1 rather than refused.
        let held = ToneCurve::from_json(r#"{"points": [[-2, -0.5], [2, 1.5]]}"#).unwrap();
        assert_eq!(held.points, vec![[-2.0, 0.0], [2.0, 1.0]]);
    }

    #[test]
    fn the_curve_passes_its_points_and_holds_past_its_ends() {
        let c = curve(&[[-6.0, 0.02], [-2.0, 0.2], [0.0, 0.45], [3.0, 0.97]]);
        let t = c.table();
        for [x, y] in &c.points {
            assert!((c.eval(*x) - y).abs() < 1e-6);
            assert!((t.at(*x) - y).abs() < 1e-4, "table at {x}: {} against {y}", t.at(*x));
        }
        assert_eq!(t.at(-30.0), 0.02);
        assert_eq!(t.at(f32::NEG_INFINITY), 0.02);
        assert_eq!(t.at(f32::NAN), 0.02);
        assert_eq!(t.at(9.0), 0.97);
        assert_eq!(t.at_scene(0.0), 0.02, "black is the first point");
        assert!((t.at_scene(MIDDLE_GRAY) - 0.45).abs() < 1e-4);
        // Smooth and rising points stay rising between them.
        let mut prev = 0.0;
        for i in 0..=900 {
            let v = t.at(-6.0 + i as f32 * 0.01);
            assert!(v >= prev - 1e-6);
            prev = v;
        }
    }

    #[test]
    fn linear_interp_runs_straight() {
        let mut c = curve(&[[-4.0, 0.0], [0.0, 0.4], [4.0, 1.0]]);
        c.interp = "linear".into();
        assert!((c.eval(-2.0) - 0.2).abs() < 1e-6);
        assert!((c.eval(2.0) - 0.7).abs() < 1e-6);
    }

    /// Tangent mode is Curves' (2026-10-29): the Hermite through each
    /// point's own slope, the Bezier through handle vectors where any
    /// point has one, the monotone slopes where neither is given; slopes
    /// and handles travel with their points through the sort; a list of
    /// the wrong length is dropped, never guessed at; and the other modes
    /// keep neither.
    #[test]
    fn tangent_mode_reads_slopes_and_handles_as_curves_does() {
        let pts = vec![[-4.0, 0.1], [0.0, 0.5], [4.0, 0.9]];
        let tangent = |t: Option<Vec<f32>>, h: Option<Vec<Option<ToneHandle>>>| {
            ToneCurve { name: "t".into(), interp: "tangent".into(), points: pts.clone(), tangents: t, handles: h }.checked().unwrap()
        };
        // No slopes: the smooth curve exactly.
        let smooth = curve(&pts);
        let bare = tangent(None, None);
        for x in [-3.0, -1.0, 1.0, 3.5] {
            assert!((bare.eval(x) - smooth.eval(x)).abs() < 1e-6);
        }
        // A flat slope at middle gray holds the curve level around it.
        let flat = tangent(Some(vec![0.1, 0.0, 0.1]), None);
        assert!((flat.eval(0.3) - 0.5).abs() < 0.01, "{}", flat.eval(0.3));
        assert!((smooth.eval(0.3) - 0.5).abs() > 0.02);
        // A long right handle on the first point bows its segment up
        // further than a short one does: length shapes the curve.
        let handle = |len: f32| Some(vec![Some(ToneHandle { l: None, r: Some([len, len * 0.2]) }), None, None]);
        let long = tangent(None, handle(2.5));
        let short = tangent(None, handle(0.5));
        assert!(long.eval(-3.0) > short.eval(-3.0), "{} {}", long.eval(-3.0), short.eval(-3.0));
        // All-automatic handles read as the slopes, as in Curves.
        let auto = tangent(Some(vec![0.1, 0.0, 0.1]), Some(vec![None, None, None]));
        assert!((auto.eval(0.3) - flat.eval(0.3)).abs() < 1e-6);
        // Sorted together: each slope and handle stays with its point.
        // The lists are lopsided, so one left in place reads differently.
        let far = ToneHandle { l: Some([-0.5, -0.1]), r: None };
        let shuffled = ToneCurve {
            name: "t".into(),
            interp: "tangent".into(),
            points: vec![[4.0, 0.9], [0.0, 0.5], [-4.0, 0.1]],
            tangents: Some(vec![0.3, 0.0, 0.1]),
            handles: Some(vec![Some(far), None, None]),
        }
        .checked()
        .unwrap();
        assert_eq!(shuffled.tangents.as_deref(), Some(&[0.1, 0.0, 0.3][..]));
        assert_eq!(shuffled.handles, Some(vec![None, None, Some(far)]));
        // Wrong lengths and non-numbers are dropped.
        assert_eq!(tangent(Some(vec![0.0]), None).tangents, None);
        assert_eq!(tangent(Some(vec![0.0, f32::NAN, 0.0]), None).tangents, None);
        assert_eq!(tangent(None, Some(vec![None])).handles, None);
        // Smooth and linear carry neither, and a JSON round trip keeps them.
        let mut smooth_with = tangent(Some(vec![0.1, 0.0, 0.1]), handle(1.0));
        let json = smooth_with.to_json();
        assert_eq!(ToneCurve::from_json(&json).unwrap(), smooth_with);
        smooth_with.interp = "smooth".into();
        let cleared = smooth_with.checked().unwrap();
        assert_eq!((cleared.tangents, cleared.handles), (None, None));
        assert!(!curve(&pts).to_json().contains("tangents"));
        // The render's table reads the same curve.
        let table = flat.table();
        assert!((table.values[(4.3 / table.step) as usize] - flat.eval(-4.0 + 4.3)).abs() < 1e-3);
    }

    /// A camera profile's curve, linear both ways, comes back as half
    /// stops that redraw it within a hair of display at every scene
    /// value it covers.
    #[test]
    fn a_linear_pair_curve_resamples_faithfully() {
        // A gentle S over linear light, 257 pairs as a profile carries.
        let pairs: Vec<(f32, f32)> = (0..=256)
            .map(|i| {
                let x = i as f32 / 256.0;
                let d = to_display(x);
                (x, to_scene(d + (d * d * (3.0 - 2.0 * d) - d) * 0.4))
            })
            .collect();
        let c = ToneCurve::from_linear_pairs("p", &pairs).unwrap();
        assert!(c.points.len() < 30, "{} points", c.points.len());
        assert!((c.points[c.points.len() - 1][0] - white_stops()).abs() < 1e-5);
        let t = c.table();
        for i in 0..=1000 {
            let scene = 0.004 + 0.996 * i as f32 / 1000.0;
            let want = to_display(piecewise(&pairs, scene));
            let got = t.at_scene(scene);
            assert!((got - want).abs() < 0.006, "at {scene}: {got} against {want}");
        }
        assert!(ToneCurve::from_linear_pairs("p", &[(0.0, 0.0)]).is_err());
        assert!(ToneCurve::from_linear_pairs("p", &[(0.5, 0.0), (0.2, 1.0)]).is_err());
    }

    #[test]
    fn a_1d_cube_reads_as_display_in_and_out() {
        // The identity LUT is the identity in display terms.
        let n = 33;
        let mut text = String::from("TITLE \"id\"\n# a comment\nLUT_1D_SIZE 33\n");
        for i in 0..n {
            let v = i as f32 / (n - 1) as f32;
            text.push_str(&format!("{v} {v} {v}\n"));
        }
        let c = ToneCurve::from_cube_1d("id", &text).unwrap();
        let t = c.table();
        for scene in [0.01f32, 0.05, 0.18, 0.5, 0.9] {
            assert!((t.at_scene(scene) - to_display(scene)).abs() < 0.004, "at {scene}");
        }
        assert!(ToneCurve::from_cube_1d("x", "LUT_3D_SIZE 2\n").unwrap_err().contains("LUT node"));
        assert!(ToneCurve::from_cube_1d("x", "LUT_1D_SIZE 3\n0 0 0\n1 1 1\n").is_err());
        assert!(ToneCurve::from_cube_1d("x", "0 0 0\n1 1 1\n").is_err());
    }

    #[test]
    fn two_columns_read_in_the_curves_own_terms() {
        let c = ToneCurve::from_two_columns("x", "stops,display\n-8, 0\n0\t0.45 # gray\n\n2.5 1\n").unwrap();
        assert_eq!(c.points, vec![[-8.0, 0.0], [0.0, 0.45], [2.5, 1.0]]);
        assert!(ToneCurve::from_two_columns("x", "-8 0\n0 0.45\nnot a line\n").unwrap_err().starts_with("line 3"));
        assert!(ToneCurve::from_two_columns("x", "0 0.5\n").is_err());
        // A long one resamples over its own range.
        let text: String = (0..=200).map(|i| format!("{} {}\n", -8.0 + i as f32 * 0.05, i as f32 / 200.0)).collect();
        let long = ToneCurve::from_two_columns("x", &text).unwrap();
        assert!(long.points.len() < 30);
        assert_eq!(long.points[0][0], -8.0);
        assert_eq!(long.points[long.points.len() - 1][0], 2.0);
        assert!((long.eval(-3.0) - 0.5).abs() < 0.01);
        // Validate before resampling too: an extreme endpoint must not
        // send the half-stop sampler into an effectively endless loop.
        let outside: String = (0..65).map(|i| if i == 64 { "40 1\n".into() } else { format!("{i} 0\n") }).collect();
        assert!(ToneCurve::from_two_columns("x", &outside).is_err());
        let nonfinite: String = (0..65).map(|i| if i == 64 { "64 NaN\n".into() } else { format!("{i} 0\n") }).collect();
        assert!(ToneCurve::from_two_columns("x", &nonfinite).is_err());
    }

    /// tests/tone_curve_cases.json is read by the panel's test too
    /// (toneprofilecustom.test.tsx): the panel must draw a curve exactly
    /// when this renders it, so the two take and refuse the same curves.
    #[test]
    fn curves_match_the_shared_cases() {
        #[derive(Deserialize)]
        struct Case {
            name: String,
            json: String,
            interp: Option<String>,
            points: Option<Vec<[f32; 2]>>,
        }
        #[derive(Deserialize)]
        struct Cases {
            cases: Vec<Case>,
        }
        let v: Cases = serde_json::from_str(include_str!("../tests/tone_curve_cases.json")).unwrap();
        for c in v.cases {
            match (ToneCurve::from_json(&c.json), c.points) {
                (Ok(got), Some(want)) => {
                    assert_eq!(got.points, want, "{}", c.name);
                    assert_eq!(Some(got.interp), c.interp, "{}", c.name);
                }
                (Err(_), None) => {}
                (got, want) => panic!("{}: got {got:?}, want {want:?}", c.name),
            }
        }
    }
}
