//! The Zone System: eleven zones of print value, 0 to X, with Zone V
//! at middle gray, and the placement solver that moves a chosen spot
//! onto a chosen zone.
//!
//! Zones are PRINT values, so they live in the display domain the way
//! Levels does: the encoded gray the screen shows. Zone V is the encoded
//! value of 18% reflectance; the five zones below it divide the way to
//! black in equal steps of print value, the five above divide the way to
//! white the same way. Adams' zones on the negative are a stop apart;
//! on the print they are steps of tone, which is what the ruler shows
//! and what a placement lands on. A zone's band reaches halfway to its
//! neighbors' centers.

use crate::buffers::{luma, ImageBuf};
use crate::ops::{to_display, to_scene};

pub const ZONES: usize = 11;
/// Zone V: 18% reflectance, sRGB-encoded.
pub const ZONE_V: f32 = 0.461_356_1;

/// The encoded gray at the center of zone `k`.
pub fn zone_centre(k: usize) -> f32 {
    let k = k.min(ZONES - 1) as f32;
    if k <= 5.0 {
        ZONE_V * k / 5.0
    } else {
        ZONE_V + (1.0 - ZONE_V) * (k - 5.0) / 5.0
    }
}

/// The zone an encoded gray falls in: the nearest center.
pub fn zone_of(encoded: f32) -> usize {
    let e = encoded.clamp(0.0, 1.0);
    let k = if e <= ZONE_V { (e / ZONE_V * 5.0).round() } else { 5.0 + ((e - ZONE_V) / (1.0 - ZONE_V) * 5.0).round() };
    (k as usize).min(ZONES - 1)
}

/// The zone map: the frame (display-referred, before encode) posterized
/// to its eleven zones, a spot meter reading the whole scene; or, with
/// `only`, that one zone lit in gold over the picture dimmed, the way
/// the other views dim.
pub fn zone_map(frame: &ImageBuf, only: Option<usize>) -> ImageBuf {
    let n = frame.width * frame.height;
    let mut out = ImageBuf::new(frame.width, frame.height);
    for i in 0..n {
        let s = &frame.data[i * 4..i * 4 + 4];
        let o = &mut out.data[i * 4..i * 4 + 4];
        let y = luma(s[0], s[1], s[2]).max(0.0);
        let e = to_display(y).clamp(0.0, 1.0);
        let z = zone_of(e);
        match only {
            None => {
                let g = to_scene(zone_centre(z));
                o[0] = g;
                o[1] = g;
                o[2] = g;
            }
            Some(k) if k == z => {
                o[0] = 1.0;
                o[1] = 0.62;
                o[2] = 0.05;
            }
            Some(_) => {
                let d = (y * 0.30).clamp(0.0, 0.6);
                o[0] = d;
                o[1] = d;
                o[2] = d;
            }
        }
        o[3] = s[3];
    }
    out
}

/// A placement: a spot on the frame (0..1 each way) and the encoded
/// gray it should land on (a zone center).
#[derive(Clone, Copy, Debug)]
pub struct Placement {
    pub x: f32,
    pub y: f32,
    pub target: f32,
}

/// The solver's answer: the exposure, the contrast when a second spot
/// asked for one, and where each spot landed, so a target out of the
/// dials' reach is reported as the miss it is rather than as a
/// landing (review 2026-09-15, item 3; show the miss).
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Solved {
    pub exposure: f32,
    pub contrast: Option<f32>,
    /// The first spot's encoded value at the answer, and the second's
    /// when there was one.
    pub landed: (f32, Option<f32>),
}

/// Within this much of the target's encoded value a spot has landed:
/// a third of a zone, which no print shows as a different zone.
pub const LANDED: f32 = 0.03;

/// One unknown, one target: regula falsi with the Illinois step on a
/// bracket, which converges in a handful of renders where bisection
/// takes thirty. The response need not rise with the unknown (a spot
/// below the pivot goes DOWN with contrast); the bracket's ends say
/// which way it runs. A target outside the bracket answers the nearer
/// end: the most the parameter can do.
fn solve_1d(read: &mut dyn FnMut(f32) -> Option<f32>, target: f32, lo: f32, hi: f32, steps: usize) -> Option<f32> {
    let (mut a, mut b) = (lo, hi);
    let (mut fa, mut fb) = (read(a)? - target, read(b)? - target);
    if fa == 0.0 {
        return Some(a);
    }
    if fb == 0.0 {
        return Some(b);
    }
    if fa.signum() == fb.signum() {
        return Some(if fa.abs() < fb.abs() { a } else { b });
    }
    let mut side = 0i8;
    let mut c = a;
    for _ in 0..steps {
        c = (a * fb - b * fa) / (fb - fa);
        let fc = read(c)? - target;
        if fc.abs() < 1e-4 {
            return Some(c);
        }
        if fc.signum() == fb.signum() {
            b = c;
            fb = fc;
            if side == -1 {
                fa *= 0.5;
            }
            side = -1;
        } else {
            a = c;
            fa = fc;
            if side == 1 {
                fb *= 0.5;
            }
            side = 1;
        }
    }
    Some(c)
}

/// Places one or two spots (Adams: "expose for the shadows, develop for
/// the highlights"). `read(exposure, contrast)` renders with those two
/// parameters and answers the encoded gray at the first spot and at the
/// second (any value when there is none); None from it aborts.
///
/// One spot: exposure alone, over its range, regula falsi. Two spots:
/// exposure and contrast together by damped Newton on a numerical
/// Jacobian, because the two pull on each other (the contrast pivots
/// on middle gray, so it moves the shadow the exposure just placed) and
/// solving them in turn oscillates for many rounds where Newton lands
/// in three or four. Each round is three renders and at most three
/// halvings; the step is clamped to the parameters' ranges.
pub fn solve_placement(
    mut read: impl FnMut(f32, f32) -> Option<(f32, f32)>,
    exposure0: f32,
    contrast0: f32,
    contrast_range: (f32, f32),
    first: Placement,
    second: Option<Placement>,
) -> Option<Solved> {
    const EV: (f32, f32) = (-5.0, 5.0);
    const STEPS: usize = 8;
    const CLOSE: f32 = 0.001;
    let contrast = contrast0;
    let Some(sec) = second else {
        let mut r = |ev: f32| read(ev, contrast).map(|v| v.0);
        let exposure = solve_1d(&mut r, first.target, EV.0, EV.1, STEPS)?;
        let at = read(exposure, contrast)?.0;
        return Some(Solved { exposure, contrast: None, landed: (at, None) });
    };
    // Newton from the current settings, seeded by a one-dimensional
    // exposure solve so the first Jacobian is taken near the answer.
    let mut ev = {
        let mut r = |e: f32| read(e, contrast).map(|v| v.0);
        solve_1d(&mut r, first.target, EV.0, EV.1, STEPS)?
    };
    let mut k = contrast;
    let residual = |read: &mut dyn FnMut(f32, f32) -> Option<(f32, f32)>, e: f32, c: f32| -> Option<[f32; 2]> {
        let (v1, v2) = read(e, c)?;
        Some([v1 - first.target, v2 - sec.target])
    };
    let mut f = residual(&mut read, ev, k)?;
    for _ in 0..6 {
        if f[0].abs() < CLOSE && f[1].abs() < CLOSE {
            break;
        }
        // At the upper end a forward difference has zero width. Read
        // inward instead, and divide by the step actually taken.
        let de = if ev + 0.1 <= EV.1 { 0.1 } else { -0.1 };
        let dk = 0.025 * (contrast_range.1 - contrast_range.0);
        let dk = if k + dk <= contrast_range.1 { dk } else { -dk };
        if dk == 0.0 { break; }
        let fe = residual(&mut read, ev + de, k)?;
        let fk = residual(&mut read, ev, k + dk)?;
        let j = [
            [(fe[0] - f[0]) / de, (fk[0] - f[0]) / dk],
            [(fe[1] - f[1]) / de, (fk[1] - f[1]) / dk],
        ];
        let det = j[0][0] * j[1][1] - j[0][1] * j[1][0];
        if det.abs() < 1e-9 {
            break;
        }
        let step = [
            -(j[1][1] * f[0] - j[0][1] * f[1]) / det,
            -(-j[1][0] * f[0] + j[0][0] * f[1]) / det,
        ];
        let norm = |r: [f32; 2]| r[0].abs() + r[1].abs();
        let mut scale = 1.0f32;
        let mut accepted = None;
        for _ in 0..4 {
            let e2 = (ev + step[0] * scale).clamp(EV.0, EV.1);
            let k2 = (k + step[1] * scale).clamp(contrast_range.0, contrast_range.1);
            let f2 = residual(&mut read, e2, k2)?;
            if norm(f2) < norm(f) {
                accepted = Some((e2, k2, f2));
                break;
            }
            scale *= 0.5;
        }
        match accepted {
            Some((e2, k2, f2)) => {
                ev = e2;
                k = k2;
                f = f2;
            }
            None => break,
        }
    }
    let _ = exposure0;
    Some(Solved { exposure: ev, contrast: Some(k), landed: (first.target + f[0], Some(sec.target + f[1])) })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn zone_v_is_middle_gray_and_the_ends_are_black_and_white() {
        assert!((zone_centre(5) - to_display(0.18)).abs() < 1e-4);
        assert_eq!(zone_centre(0), 0.0);
        assert!((zone_centre(10) - 1.0).abs() < 1e-6);
        for k in 1..ZONES {
            assert!(zone_centre(k) > zone_centre(k - 1));
        }
    }

    #[test]
    fn every_centre_reads_as_its_own_zone_and_the_bands_meet_halfway() {
        for k in 0..ZONES {
            assert_eq!(zone_of(zone_centre(k)), k);
        }
        let edge = 0.5 * (zone_centre(3) + zone_centre(4));
        assert_eq!(zone_of(edge - 1e-3), 3);
        assert_eq!(zone_of(edge + 1e-3), 4);
        assert_eq!(zone_of(-1.0), 0);
        assert_eq!(zone_of(2.0), 10);
    }

    #[test]
    fn the_map_posterises_to_centres_and_lights_one_zone_in_gold() {
        let mut f = ImageBuf::new(2, 1);
        f.set_pixel(0, 0, [0.18, 0.18, 0.18, 1.0]);
        f.set_pixel(1, 0, [0.02, 0.02, 0.02, 1.0]);
        let all = zone_map(&f, None);
        assert!((all.pixel(0, 0)[0] - 0.18).abs() < 1e-3, "zone V posterizes to itself");
        assert!((all.pixel(1, 0)[0] - to_scene(zone_centre(zone_of(to_display(0.02))))).abs() < 1e-5);
        let one = zone_map(&f, Some(5));
        assert!(one.pixel(0, 0)[0] > 0.9 && one.pixel(0, 0)[2] < 0.1, "zone V lit in gold");
        let d = one.pixel(1, 0);
        assert!(d[0] == d[1] && d[1] == d[2] && d[0] < 0.02, "the rest dimmed");
    }

    /// A model of the chain: display = profile(2^ev * scene) with a
    /// contrast pivoting on middle gray in log space.
    fn model(scene: f32, ev: f32, contrast: f32) -> f32 {
        let lin = scene * 2f32.powf(ev);
        // Exposure's Contrast: -100..100 around zero, one at rest.
        let k = 1.0 + contrast / 100.0;
        let out = 0.18 * (lin / 0.18).powf(k);
        to_display(out.clamp(0.0, 1.0))
    }

    #[test]
    fn one_placement_moves_a_spot_onto_its_zone() {
        // A shadow at scene 0.045 (two stops under middle gray) placed on
        // Zone V wants about +2 EV.
        let read = |ev: f32, c: f32| Some((model(0.045, ev, c), 0.0));
        let s = solve_placement(read, 0.0, 0.0, (-100.0, 100.0), Placement { x: 0.1, y: 0.1, target: zone_centre(5) }, None).unwrap();
        assert!((s.exposure - 2.0).abs() < 0.05, "exposure {}", s.exposure);
        assert!(s.contrast.is_none());
        assert!((model(0.045, s.exposure, 0.0) - zone_centre(5)).abs() < 0.01);
    }

    #[test]
    fn two_placements_hold_the_shadow_and_develop_the_highlight() {
        // Shadow at 0.045 on Zone III, highlight at 0.5 on Zone VIII: the
        // shadow needs the exposure, the highlight the contrast, and
        // both must hold together.
        let shadow = Placement { x: 0.1, y: 0.1, target: zone_centre(3) };
        let high = Placement { x: 0.9, y: 0.9, target: zone_centre(8) };
        let read = |ev: f32, c: f32| Some((model(0.045, ev, c), model(0.5, ev, c)));
        let s = solve_placement(read, 0.0, 0.0, (-100.0, 100.0), shadow, Some(high)).unwrap();
        let c = s.contrast.unwrap();
        assert!((model(0.045, s.exposure, c) - shadow.target).abs() < 0.02, "shadow lands: {}", model(0.045, s.exposure, c));
        assert!((model(0.5, s.exposure, c) - high.target).abs() < 0.02, "highlight lands: {}", model(0.5, s.exposure, c));
    }

    #[test]
    fn a_render_that_fails_aborts_the_solve() {
        let read = |_: f32, _: f32| None;
        assert!(solve_placement(read, 0.0, 0.0, (-100.0, 100.0), Placement { x: 0.0, y: 0.0, target: 0.5 }, None).is_none());
    }

    #[test]
    fn review_two_placements_can_leave_maximum_development() {
        let shadow = Placement { x: 0.1, y: 0.1, target: zone_centre(3) };
        let high = Placement { x: 0.9, y: 0.9, target: zone_centre(5) };
        let read = |ev: f32, c: f32| Some((model(0.045, ev, c), model(0.09, ev, c)));
        let solved = solve_placement(read, 0.0, 100.0, (-100.0, 100.0), shadow, Some(high)).unwrap();
        let c = solved.contrast.unwrap();
        assert!((model(0.045, solved.exposure, c) - shadow.target).abs() < 0.001);
        assert!((model(0.09, solved.exposure, c) - high.target).abs() < 0.001);
    }

    /// A target the dial cannot reach answers the most the dial can do
    /// and says where the spot landed, so the caller can show the miss.
    #[test]
    fn an_unreachable_target_reports_where_it_landed() {
        // A spot so dark that even five stops leave it under Zone V.
        let read = |ev: f32, c: f32| Some((model(0.0005, ev, c), 0.0));
        let solved = solve_placement(read, 0.0, 0.0, (-100.0, 100.0), Placement { x: 0.5, y: 0.5, target: zone_centre(5) }, None).unwrap();
        assert!(solved.exposure > 4.9, "the dial went as far as it goes: {}", solved.exposure);
        assert!(solved.landed.0 < zone_centre(5) - LANDED, "and the miss is reported: {} short of {}", solved.landed.0, zone_centre(5));
        // A reachable one reports a landing.
        let read = |ev: f32, c: f32| Some((model(0.045, ev, c), 0.0));
        let solved = solve_placement(read, 0.0, 0.0, (-100.0, 100.0), Placement { x: 0.5, y: 0.5, target: zone_centre(3) }, None).unwrap();
        assert!((solved.landed.0 - zone_centre(3)).abs() < LANDED);
    }
}
