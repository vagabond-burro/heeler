//! Color sources measured against color charts, for the choice of where
//! a non-DNG raw's camera matrix comes from.
//!
//! Two measurements, each scored by CIEDE2000 against reference values:
//!
//! `chart`: a raw shot of an X-Rite ColorChecker (Classic 24 or Digital
//! SG). The patches' mean camera RGB (black subtracted, from LibRaw's
//! unpacked mosaic, no demosaic) is white balanced on the chart's own
//! neutral patches and taken to XYZ (D50) by each source: LibRaw's
//! develop matrix; the DNG specification's color model (chapter 6:
//! ColorMatrix1/2 or ForwardMatrix1/2 weighted by the white's color
//! temperature, CameraCalibration, AnalogBalance) with the tags of a DNG
//! written from the same file by a converter; and a 3 by 3 matrix fitted
//! to the chart itself, cross-validated (each patch scored by a fit that
//! never saw it), which shows the best a single matrix can do on that
//! shot. Each source's exposure is fitted on the neutral patches. With
//! COLORCHECK_FLARE set, the lens flare (the offset where each channel's
//! line through the neutral patches meets zero luminance) is subtracted
//! from every patch first, the same for every source. Scored
//! against X-Rite's published L*a*b* (D50): Classic after November 2014,
//! Digital SG before November 2014.
//!
//!   colorcheck preview RAW OUT.ppm [K]        a 1/(2K) preview, to find the chart
//!   colorcheck mark RAW OUT.ppm K CHART TL TR BL BR
//!   colorcheck chart RAW DNG K CHART TL TR BL BR
//!
//! CHART is classic or sg; TL, TR, BL and BR are the preview coordinates
//! (x,y) of the centers of the chart's corner patches as it lies in the
//! preview (top left A1 or dark skin, top right, bottom left, bottom
//! right); `mark` draws the boxes measured, to check them.
//!
//! `spectral`: a camera whose spectral sensitivities were measured (the
//! Academy Software Foundation's ACES camera data, Apache-2.0: its
//! data folder, with camera, cmf and training inside). Its response to the 190 training patches is
//! simulated under CIE D65 and Standard Illuminant A and scored for
//! LibRaw's matrix, the DNG model with a converter's tags, and a 3 by 3
//! matrix fitted from the sensitivities under the same illuminant (on half
//! the patches, scored on the other half, and the other way round).
//!
//!   colorcheck spectral DATA_DIR CAMERA_JSON RAW DNG
//!
//! The reference tables in this file are standard data: X-Rite's
//! published chart values, and the CIE daylight basis functions S0, S1
//! and S2 (CIE 15).
use std::io::Write;

use heeler_rawdec::color::{apply, bradford, camera_to_xyz_d50, invert3, mul3, D50, XYZ_FROM_SRGB};
use heeler_rawdec::dng::Dng;

type M3 = [[f64; 3]; 3];

const CLASSIC_LAB: [[f64; 3]; 24] = [
    [37.54, 14.37, 14.92],
    [64.66, 19.27, 17.50],
    [49.32, -3.82, -22.54],
    [43.46, -12.74, 22.72],
    [54.94, 9.61, -24.79],
    [70.48, -32.26, -0.37],
    [62.73, 35.83, 56.50],
    [39.43, 10.75, -45.17],
    [50.57, 48.64, 16.67],
    [30.10, 22.54, -20.87],
    [71.77, -24.13, 58.19],
    [71.51, 18.24, 67.37],
    [28.37, 15.42, -49.80],
    [54.38, -39.72, 32.27],
    [42.43, 51.05, 28.62],
    [81.80, 2.67, 80.41],
    [50.63, 51.28, -14.12],
    [49.57, -29.71, -28.32],
    [95.19, -1.03, 2.93],
    [81.29, -0.57, 0.44],
    [66.89, -0.75, -0.06],
    [50.76, -0.13, 0.14],
    [35.63, -0.46, -0.48],
    [20.64, 0.07, -0.46],
];
const SG_LAB: [[f64; 3]; 140] = [
    [96.55, -0.91, 0.57],
    [6.43, -0.06, -0.41],
    [49.70, -0.18, 0.03],
    [96.50, -0.89, 0.59],
    [6.50, -0.06, -0.44],
    [49.66, -0.20, 0.01],
    [96.52, -0.91, 0.58],
    [6.49, -0.02, -0.28],
    [49.72, -0.20, 0.04],
    [96.43, -0.91, 0.67],
    [49.72, -0.19, 0.02],
    [32.60, 51.58, -10.85],
    [60.75, 26.22, -18.69],
    [28.69, 48.28, -39.00],
    [49.38, -15.43, -48.48],
    [60.63, -30.77, -26.23],
    [19.29, -26.37, -6.15],
    [60.15, -41.77, -12.60],
    [21.42, 1.67, 8.79],
    [49.69, -0.20, 0.01],
    [6.50, -0.03, -0.67],
    [21.82, 17.33, -18.35],
    [41.53, 18.48, -37.26],
    [19.99, -0.16, -36.29],
    [60.16, -18.45, -31.42],
    [19.94, -17.92, -20.96],
    [60.68, -6.05, -32.81],
    [50.81, -49.80, -9.63],
    [60.65, -39.77, 20.76],
    [6.53, -0.03, -0.43],
    [96.56, -0.91, 0.59],
    [84.19, -1.95, -8.23],
    [84.75, 14.55, 0.23],
    [84.87, -19.07, -0.82],
    [85.15, 13.48, 6.82],
    [84.17, -10.45, 26.78],
    [61.74, 31.06, 36.42],
    [64.37, 20.82, 18.92],
    [50.40, -53.22, 14.62],
    [96.51, -0.89, 0.65],
    [49.74, -0.19, 0.03],
    [31.91, 18.62, 21.99],
    [60.74, 38.66, 70.97],
    [19.35, 22.23, -58.86],
    [96.52, -0.91, 0.62],
    [6.66, 0.00, -0.30],
    [76.51, 20.81, 22.72],
    [72.79, 29.15, 24.18],
    [22.33, -20.70, 5.75],
    [49.70, -0.19, 0.01],
    [6.53, -0.05, -0.61],
    [63.42, 20.19, 19.22],
    [34.94, 11.64, -50.70],
    [52.03, -44.15, 39.04],
    [79.43, 0.29, -0.17],
    [30.67, -0.14, -0.53],
    [63.60, 14.44, 26.07],
    [64.37, 14.50, 17.05],
    [60.01, -44.33, 8.49],
    [6.63, -0.01, -0.47],
    [96.56, -0.93, 0.59],
    [46.37, -5.09, -24.46],
    [47.08, 52.97, 20.49],
    [36.04, 64.92, 38.51],
    [65.05, 0.00, -0.32],
    [40.14, -0.19, -0.38],
    [43.77, 16.46, 27.12],
    [64.39, 17.00, 16.59],
    [60.79, -29.74, 41.50],
    [96.48, -0.89, 0.64],
    [49.75, -0.21, 0.01],
    [38.18, -16.99, 30.87],
    [21.31, 29.14, -27.51],
    [80.57, 3.85, 89.61],
    [49.71, -0.20, 0.03],
    [60.27, 0.08, -0.41],
    [67.34, 14.45, 16.90],
    [64.69, 16.95, 18.57],
    [51.12, -49.31, 44.41],
    [49.70, -0.20, 0.02],
    [6.67, -0.05, -0.64],
    [51.56, 9.16, -26.88],
    [70.83, -24.26, 64.77],
    [48.06, 55.33, -15.61],
    [35.26, -0.09, -0.24],
    [75.16, 0.25, -0.20],
    [44.54, 26.27, 38.93],
    [35.91, 16.59, 26.46],
    [61.49, -52.73, 47.30],
    [6.59, -0.05, -0.50],
    [96.58, -0.90, 0.61],
    [68.93, -34.58, -0.34],
    [69.65, 20.09, 78.57],
    [47.79, -33.18, -30.21],
    [15.94, -0.42, -1.20],
    [89.02, -0.36, -0.48],
    [63.43, 25.44, 26.25],
    [65.75, 22.06, 27.82],
    [61.47, 17.10, 50.72],
    [96.53, -0.89, 0.66],
    [49.79, -0.20, 0.03],
    [85.17, 10.89, 17.26],
    [89.74, -16.52, 6.19],
    [84.55, 5.07, -6.12],
    [84.02, -13.87, -8.72],
    [70.76, 0.07, -0.35],
    [45.59, -0.05, 0.23],
    [20.30, 0.07, -0.32],
    [61.79, -13.41, 55.42],
    [49.72, -0.19, 0.02],
    [6.77, -0.05, -0.44],
    [21.85, 34.37, 7.83],
    [42.66, 67.43, 48.42],
    [60.33, 36.56, 3.56],
    [61.22, 36.61, 17.32],
    [62.07, 52.80, 77.14],
    [72.42, -9.82, 89.66],
    [62.03, 3.53, 57.01],
    [71.95, -27.34, 73.69],
    [6.59, -0.04, -0.45],
    [49.77, -0.19, 0.04],
    [41.84, 62.05, 10.01],
    [19.78, 29.16, -7.85],
    [39.56, 65.98, 33.71],
    [52.39, 68.33, 47.84],
    [81.23, 24.12, 87.51],
    [81.80, 6.78, 95.75],
    [71.72, -16.23, 76.28],
    [20.31, 14.45, 16.74],
    [49.68, -0.19, 0.05],
    [96.48, -0.88, 0.68],
    [49.69, -0.18, 0.03],
    [6.39, -0.04, -0.33],
    [96.54, -0.90, 0.67],
    [49.72, -0.18, 0.05],
    [6.49, -0.03, -0.41],
    [96.51, -0.90, 0.69],
    [49.70, -0.19, 0.07],
    [6.47, 0.00, -0.38],
    [96.46, -0.89, 0.71],
];
const DAYLIGHT_BASIS: [[f64; 81]; 3] = [
    [63.4, 64.6, 65.8, 80.3, 94.8, 99.8, 104.8, 105.35, 105.9, 101.35, 96.8, 105.35, 113.9, 119.75, 125.6, 125.55, 125.5, 123.4, 121.3, 121.3, 121.3, 117.4, 113.5, 113.3, 113.1, 111.95, 110.8, 108.65, 106.5, 107.65, 108.8, 107.05, 105.3, 104.85, 104.4, 102.2, 100.0, 98.0, 96.0, 95.55, 95.1, 92.1, 89.1, 89.8, 90.5, 90.4, 90.3, 89.35, 88.4, 86.2, 84.0, 84.55, 85.1, 83.5, 81.9, 82.25, 82.6, 83.75, 84.9, 83.1, 81.3, 76.6, 71.9, 73.1, 74.3, 75.35, 76.4, 69.85, 63.3, 67.5, 71.7, 74.35, 77.0, 71.1, 65.2, 56.45, 47.7, 58.15, 68.6, 66.8, 65.0],
    [38.5, 36.75, 35.0, 39.2, 43.4, 44.85, 46.3, 45.1, 43.9, 40.5, 37.1, 36.9, 36.7, 36.3, 35.9, 34.25, 32.6, 30.25, 27.9, 26.1, 24.3, 22.2, 20.1, 18.15, 16.2, 14.7, 13.2, 10.9, 8.6, 7.35, 6.1, 5.15, 4.2, 3.05, 1.9, 0.95, 0.0, -0.8, -1.6, -2.55, -3.5, -3.5, -3.5, -4.65, -5.8, -6.5, -7.2, -7.9, -8.6, -9.05, -9.5, -10.2, -10.9, -10.8, -10.7, -11.35, -12.0, -13.0, -14.0, -13.8, -13.6, -12.8, -12.0, -12.65, -13.3, -13.1, -12.9, -11.75, -10.6, -11.1, -11.6, -11.9, -12.2, -11.2, -10.2, -9.0, -7.8, -9.5, -11.2, -10.8, -10.4],
    [3.0, 2.1, 1.2, 0.05, -1.1, -0.8, -0.5, -0.6, -0.7, -0.95, -1.2, -1.9, -2.6, -2.75, -2.9, -2.85, -2.8, -2.7, -2.6, -2.6, -2.6, -2.2, -1.8, -1.65, -1.5, -1.4, -1.3, -1.25, -1.2, -1.1, -1.0, -0.75, -0.5, -0.4, -0.3, -0.15, 0.0, 0.1, 0.2, 0.35, 0.5, 1.3, 2.1, 2.65, 3.2, 3.65, 4.1, 4.4, 4.7, 4.9, 5.1, 5.9, 6.7, 7.0, 7.3, 7.95, 8.6, 9.2, 9.8, 10.0, 10.2, 9.25, 8.3, 8.95, 9.6, 9.05, 8.5, 7.75, 7.0, 7.3, 7.6, 7.8, 8.0, 7.35, 6.7, 5.95, 5.2, 6.3, 7.4, 7.1, 6.8],
];


fn lab(xyz: [f64; 3]) -> [f64; 3] {
    let f = |t: f64| if t > 216.0 / 24389.0 { t.cbrt() } else { (24389.0 / 27.0 * t + 16.0) / 116.0 };
    let (fx, fy, fz) = (f(xyz[0] / D50[0]), f(xyz[1] / D50[1]), f(xyz[2] / D50[2]));
    [116.0 * fy - 16.0, 500.0 * (fx - fy), 200.0 * (fy - fz)]
}

fn xyz_of_lab(l: [f64; 3]) -> [f64; 3] {
    let fy = (l[0] + 16.0) / 116.0;
    let (fx, fz) = (fy + l[1] / 500.0, fy - l[2] / 200.0);
    let g = |f: f64| if f.powi(3) > 216.0 / 24389.0 { f.powi(3) } else { (116.0 * f - 16.0) * 27.0 / 24389.0 };
    [g(fx) * D50[0], g(fy) * D50[1], g(fz) * D50[2]]
}

/// CIEDE2000 (Sharma, Wu and Dalal, 2005), kL = kC = kH = 1.
fn de2000(a: [f64; 3], b: [f64; 3]) -> f64 {
    use std::f64::consts::PI;
    let (l1, a1, b1, l2, a2, b2) = (a[0], a[1], a[2], b[0], b[1], b[2]);
    let cbar = ((a1 * a1 + b1 * b1).sqrt() + (a2 * a2 + b2 * b2).sqrt()) / 2.0;
    let g = 0.5 * (1.0 - (cbar.powi(7) / (cbar.powi(7) + 25f64.powi(7))).sqrt());
    let (a1p, a2p) = ((1.0 + g) * a1, (1.0 + g) * a2);
    let (c1p, c2p) = ((a1p * a1p + b1 * b1).sqrt(), (a2p * a2p + b2 * b2).sqrt());
    let hue = |b: f64, a: f64| if b == 0.0 && a == 0.0 { 0.0 } else { let h = b.atan2(a).to_degrees(); if h < 0.0 { h + 360.0 } else { h } };
    let (h1p, h2p) = (hue(b1, a1p), hue(b2, a2p));
    let dl = l2 - l1;
    let dc = c2p - c1p;
    let dh = if c1p * c2p == 0.0 {
        0.0
    } else if (h2p - h1p).abs() <= 180.0 {
        h2p - h1p
    } else if h2p - h1p > 180.0 {
        h2p - h1p - 360.0
    } else {
        h2p - h1p + 360.0
    };
    let dhh = 2.0 * (c1p * c2p).sqrt() * (dh.to_radians() / 2.0).sin();
    let lbar = (l1 + l2) / 2.0;
    let cbarp = (c1p + c2p) / 2.0;
    let hbarp = if c1p * c2p == 0.0 {
        h1p + h2p
    } else if (h1p - h2p).abs() <= 180.0 {
        (h1p + h2p) / 2.0
    } else if h1p + h2p < 360.0 {
        (h1p + h2p + 360.0) / 2.0
    } else {
        (h1p + h2p - 360.0) / 2.0
    };
    let t = 1.0 - 0.17 * ((hbarp - 30.0) * PI / 180.0).cos() + 0.24 * ((2.0 * hbarp) * PI / 180.0).cos() + 0.32 * ((3.0 * hbarp + 6.0) * PI / 180.0).cos()
        - 0.20 * ((4.0 * hbarp - 63.0) * PI / 180.0).cos();
    let dtheta = 30.0 * (-((hbarp - 275.0) / 25.0).powi(2)).exp();
    let rc = 2.0 * (cbarp.powi(7) / (cbarp.powi(7) + 25f64.powi(7))).sqrt();
    let sl = 1.0 + 0.015 * (lbar - 50.0).powi(2) / (20.0 + (lbar - 50.0).powi(2)).sqrt();
    let sc = 1.0 + 0.045 * cbarp;
    let sh = 1.0 + 0.015 * cbarp * t;
    let rt = -(2.0 * dtheta * PI / 180.0).sin() * rc;
    ((dl / sl).powi(2) + (dc / sc).powi(2) + (dhh / sh).powi(2) + rt * (dc / sc) * (dhh / sh)).sqrt()
}

/// LibRaw's develop matrix as a camera (white balanced) to XYZ D50 matrix:
/// its camera to linear sRGB, sRGB to XYZ (D65), adapted to D50.
fn libraw_to_xyz(rgb_cam: &[[f32; 4]; 3]) -> M3 {
    let rc: M3 = [0, 1, 2].map(|i| [0, 1, 2].map(|j| rgb_cam[i][j] as f64));
    let d65 = apply(&XYZ_FROM_SRGB, [1.0, 1.0, 1.0]);
    mul3(&bradford(d65, D50), &mul3(&XYZ_FROM_SRGB, &rc))
}

/// The DNG color model (heeler-rawdec's color::camera_to_xyz_d50) with a
/// DNG's own tags, through its ForwardMatrix or, unless `forward`, its
/// ColorMatrix alone.
fn dng_to_xyz(d: &Dng, neutral: [f64; 3], forward: bool) -> Option<M3> {
    let mut p = d.profile();
    if !forward {
        p.forward_matrix = [None, None];
    }
    camera_to_xyz_d50(&p, neutral)
}

/// The 3 by 3 matrix taking `cam` nearest to `xyz` (least squares).
fn fit(cam: &[[f64; 3]], xyz: &[[f64; 3]]) -> Option<M3> {
    let mut a = [[0.0; 3]; 3];
    let mut b = [[0.0; 3]; 3];
    for (c, x) in cam.iter().zip(xyz) {
        for i in 0..3 {
            for j in 0..3 {
                a[i][j] += c[i] * c[j];
                b[i][j] += x[i] * c[j];
            }
        }
    }
    Some(mul3(&b, &invert3(&a)?))
}

struct Score {
    /// Mean over the patches whose reference L* is 25 or more, where
    /// lens flare in a dark patch weighs least.
    lit: f64,
    mean: f64,
    median: f64,
    p90: f64,
    max: f64,
    chromatic: f64,
}

fn score(est: &[[f64; 3]], refs: &[[f64; 3]]) -> Score {
    let mut d: Vec<f64> = est.iter().zip(refs).map(|(e, r)| de2000(lab(*e), lab(*r))).collect();
    let chroma: Vec<f64> = est.iter().zip(refs).filter(|(_, r)| { let l = lab(**r); (l[1] * l[1] + l[2] * l[2]).sqrt() > 10.0 }).map(|(e, r)| de2000(lab(*e), lab(*r))).collect();
    let lit: Vec<f64> = est.iter().zip(refs).filter(|(_, r)| lab(**r)[0] >= 25.0).map(|(e, r)| de2000(lab(*e), lab(*r))).collect();
    if std::env::var_os("COLORCHECK_WORST").is_some() {
        let mut w: Vec<(f64, [f64; 3], [f64; 3])> = est.iter().zip(refs).map(|(e, r)| (de2000(lab(*e), lab(*r)), lab(*r), lab(*e))).collect();
        w.sort_by(|a, b| b.0.total_cmp(&a.0));
        for (d, r, e) in w.iter().take(5) {
            println!("    worst {d:5.2}: reference L {:5.1} a {:6.1} b {:6.1}, measured L {:5.1} a {:6.1} b {:6.1}", r[0], r[1], r[2], e[0], e[1], e[2]);
        }
    }
    let mean = d.iter().sum::<f64>() / d.len() as f64;
    d.sort_by(|a, b| a.total_cmp(b));
    Score { lit: lit.iter().sum::<f64>() / lit.len().max(1) as f64, mean, median: d[d.len() / 2], p90: d[(d.len() * 9) / 10], max: *d.last().unwrap(), chromatic: chroma.iter().sum::<f64>() / chroma.len().max(1) as f64 }
}

fn report(name: &str, s: &Score) {
    println!("  {name:<28} mean {:5.2}  median {:5.2}  p90 {:5.2}  max {:5.2}  chromatic mean {:5.2}  L>=25 mean {:5.2}", s.mean, s.median, s.p90, s.max, s.chromatic, s.lit);
}

/// The scale that best matches `est`'s luminance to `refs`' (least squares).
fn exposure(est: &[[f64; 3]], refs: &[[f64; 3]]) -> f64 {
    let (n, d) = est.iter().zip(refs).fold((0.0, 0.0), |(n, d), (e, r)| (n + e[1] * r[1], d + e[1] * e[1]));
    n / d
}

/// A raw file's sensor data as LibRaw unpacks it, black subtracted, with
/// the CFA color of each site.
struct Mosaic {
    w: usize,
    h: usize,
    data: Vec<f32>,
    color: [[u8; 2]; 2],
    white: f32,
}

fn mosaic(bytes: &[u8]) -> Mosaic {
    let (w, h, raw) = heeler_raw::libraw_mosaic(bytes).expect("LibRaw unpacks the file");
    let f = heeler_raw::linear_dng::libraw_facts(bytes, heeler_raw::DevelopOpts::default()).unwrap();
    let black = heeler_raw::libraw_black_8x8(bytes).unwrap();
    let fc = |r: usize, c: usize| {
        let v = ((f.filters >> ((((r << 1) & 14) | (c & 1)) << 1)) & 3) as u8;
        if v == 3 { 1 } else { v }
    };
    let color = [[fc(0, 0), fc(0, 1)], [fc(1, 0), fc(1, 1)]];
    let data = raw.iter().enumerate().map(|(i, &v)| (v as f32 - black[(i / w) % 8][(i % w) % 8] as f32).max(0.0)).collect();
    Mosaic { w, h, data, color, white: f.maximum as f32 - black[0][0] as f32 }
}

struct Chart {
    cols: usize,
    rows: usize,
    lab: Vec<[f64; 3]>,
}

fn chart(name: &str) -> Chart {
    match name {
        // Row by row, dark skin first.
        "classic" => Chart { cols: 6, rows: 4, lab: CLASSIC_LAB.to_vec() },
        // Column by column, A1 to A10, then B.
        "sg" => Chart { cols: 14, rows: 10, lab: SG_LAB.to_vec() },
        _ => panic!("chart is classic or sg"),
    }
}

impl Chart {
    fn reference(&self, col: usize, row: usize) -> [f64; 3] {
        if self.cols == 14 { self.lab[col * 10 + row] } else { self.lab[row * 6 + col] }
    }
}

fn point(s: &str) -> (f64, f64) {
    let (x, y) = s.split_once(',').expect("x,y");
    (x.parse().unwrap(), y.parse().unwrap())
}

/// Each patch's center and half box size in mosaic pixels, from the corner
/// patches' centers in preview pixels.
fn patches(c: &Chart, k: f64, corners: &[String]) -> Vec<(usize, usize, f64, f64, f64)> {
    let p: Vec<(f64, f64)> = corners.iter().map(|s| point(s)).map(|(x, y)| (x * 2.0 * k, y * 2.0 * k)).collect();
    let pitch = ((p[1].0 - p[0].0).hypot(p[1].1 - p[0].1)) / (c.cols - 1) as f64;
    let mut out = Vec::new();
    for row in 0..c.rows {
        for col in 0..c.cols {
            let (u, v) = (col as f64 / (c.cols - 1) as f64, row as f64 / (c.rows - 1) as f64);
            let x = (1.0 - u) * (1.0 - v) * p[0].0 + u * (1.0 - v) * p[1].0 + (1.0 - u) * v * p[2].0 + u * v * p[3].0;
            let y = (1.0 - u) * (1.0 - v) * p[0].1 + u * (1.0 - v) * p[1].1 + (1.0 - u) * v * p[2].1 + u * v * p[3].1;
            out.push((col, row, x, y, pitch * 0.18));
        }
    }
    out
}

/// A patch's mean camera RGB, and whether any of its samples clipped.
fn sample(m: &Mosaic, x: f64, y: f64, half: f64) -> ([f64; 3], bool) {
    let mut s = [0f64; 3];
    let mut n = [0f64; 3];
    let mut clipped = false;
    for r in (y - half) as usize..(y + half) as usize {
        for c in (x - half) as usize..(x + half) as usize {
            let v = m.data[r * m.w + c];
            clipped |= v >= 0.98 * m.white;
            let k = m.color[r & 1][c & 1] as usize;
            s[k] += v as f64;
            n[k] += 1.0;
        }
    }
    ([s[0] / n[0], s[1] / n[1], s[2] / n[2]], clipped)
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    match args.first().map(String::as_str) {
        Some("preview") => preview(&args),
        Some("mark") => mark(&args),
        Some("chart") => measure_chart(&args),
        Some("spectral") => spectral(&args),
        _ => eprintln!("colorcheck preview|mark|chart|spectral ... (see the file's header)"),
    }
}

fn write_ppm(path: &str, w: usize, h: usize, px: &[[u8; 3]]) {
    let mut out = std::fs::File::create(path).unwrap();
    write!(out, "P6\n{w} {h}\n255\n").unwrap();
    out.write_all(&px.iter().flatten().copied().collect::<Vec<u8>>()).unwrap();
}

fn preview_pixels(m: &Mosaic, k: usize) -> (usize, usize, Vec<[u8; 3]>) {
    let (ow, oh) = (m.w / (2 * k), m.h / (2 * k));
    let mut px = vec![[0f32; 3]; ow * oh];
    for y in 0..oh {
        for x in 0..ow {
            let mut s = [0f32; 3];
            let mut n = [0f32; 3];
            for dy in 0..2 * k {
                for dx in 0..2 * k {
                    let (r, c) = (y * 2 * k + dy, x * 2 * k + dx);
                    let col = m.color[r & 1][c & 1] as usize;
                    s[col] += m.data[r * m.w + c];
                    n[col] += 1.0;
                }
            }
            px[y * ow + x] = [s[0] / n[0], s[1] / n[1], s[2] / n[2]];
        }
    }
    let mut mx = [1f32; 3];
    for p in &px {
        for c in 0..3 {
            mx[c] = mx[c].max(p[c]);
        }
    }
    (ow, oh, px.iter().map(|p| [0, 1, 2].map(|c| ((p[c] / mx[c]).powf(1.0 / 2.2) * 255.0) as u8)).collect())
}

fn preview(args: &[String]) {
    let m = mosaic(&std::fs::read(&args[1]).unwrap());
    let k: usize = args.get(3).map_or(4, |s| s.parse().unwrap());
    let (ow, oh, px) = preview_pixels(&m, k);
    write_ppm(&args[2], ow, oh, &px);
    println!("{} x {} mosaic, preview {ow} x {oh}", m.w, m.h);
}

fn mark(args: &[String]) {
    let m = mosaic(&std::fs::read(&args[1]).unwrap());
    let k: usize = args[3].parse().unwrap();
    let c = chart(&args[4]);
    let (ow, oh, mut px) = preview_pixels(&m, k);
    for (_, _, x, y, half) in patches(&c, k as f64, &args[5..9]) {
        let s = 2.0 * k as f64;
        let (x0, x1, y0, y1) = (((x - half) / s) as usize, ((x + half) / s) as usize, ((y - half) / s) as usize, ((y + half) / s) as usize);
        for xx in x0..=x1 {
            px[y0 * ow + xx] = [255, 0, 255];
            px[y1 * ow + xx] = [255, 0, 255];
        }
        for yy in y0..=y1 {
            px[yy * ow + x0] = [255, 0, 255];
            px[yy * ow + x1] = [255, 0, 255];
        }
    }
    write_ppm(&args[2], ow, oh, &px);
}

fn measure_chart(args: &[String]) {
    let bytes = std::fs::read(&args[1]).unwrap();
    let dng = Dng::parse(&std::fs::read(&args[2]).unwrap()).expect("a DNG of the same file");
    let k: f64 = args[3].parse().unwrap();
    let c = chart(&args[4]);
    let m = mosaic(&bytes);
    let facts = heeler_raw::linear_dng::libraw_facts(&bytes, heeler_raw::DevelopOpts::default()).unwrap();
    let mut cam = Vec::new();
    let mut refs = Vec::new();
    let mut clipped = 0;
    for (col, row, x, y, half) in patches(&c, k, &args[5..9]) {
        let (rgb, clip) = sample(&m, x, y, half);
        if clip {
            clipped += 1;
            continue;
        }
        cam.push(rgb);
        refs.push(xyz_of_lab(c.reference(col, row)));
    }
    // Lens flare: each neutral patch's camera value against its reference
    // luminance is a line per channel, and where the line meets zero
    // luminance is the light every patch received from the rest of the
    // scene. Scored both ways; the same offset for every source.
    let flare_free = std::env::var_os("COLORCHECK_FLARE").is_some();
    let grey: Vec<usize> = (0..refs.len()).filter(|&i| { let l = lab(refs[i]); (l[1] * l[1] + l[2] * l[2]).sqrt() < 2.0 }).collect();
    let mut flare = [0.0; 3];
    for ch in 0..3 {
        let n = grey.len() as f64;
        let (sx, sy) = grey.iter().fold((0.0, 0.0), |(a, b), &i| (a + refs[i][1], b + cam[i][ch]));
        let (sxx, sxy) = grey.iter().fold((0.0, 0.0), |(a, b), &i| (a + refs[i][1] * refs[i][1], b + refs[i][1] * cam[i][ch]));
        let slope = (n * sxy - sx * sy) / (n * sxx - sx * sx);
        flare[ch] = (sy - slope * sx) / n;
    }
    if flare_free {
        for v in cam.iter_mut() {
            for ch in 0..3 {
                v[ch] -= flare[ch];
            }
        }
    }
    // White balance on the chart's neutral patches.
    let neutral: Vec<usize> = (0..refs.len()).filter(|&i| { let l = lab(refs[i]); (l[1] * l[1] + l[2] * l[2]).sqrt() < 2.0 && l[0] > 15.0 && l[0] < 92.0 }).collect();
    let mut n = [0.0; 3];
    for &i in &neutral {
        for ch in 0..3 {
            n[ch] += cam[i][ch] / cam[i][1] / neutral.len() as f64;
        }
    }
    let balanced: Vec<[f64; 3]> = cam.iter().map(|v| [v[0] / n[0], v[1], v[2] / n[2]]).collect();
    println!("{}: {} patches ({} clipped, left out), {} neutral; camera neutral {:.4} {:.4} {:.4}; flare {} ({:.0} {:.0} {:.0} of white {:.0})", args[1].rsplit('/').next().unwrap(), cam.len(), clipped, neutral.len(), n[0], n[1], n[2], if flare_free { "subtracted" } else { "kept" }, flare[0], flare[1], flare[2], m.white);
    let neutral_refs: Vec<[f64; 3]> = neutral.iter().map(|&i| refs[i]).collect();
    let run = |name: &str, est: Vec<[f64; 3]>| {
        let nest: Vec<[f64; 3]> = neutral.iter().map(|&i| est[i]).collect();
        let s = exposure(&nest, &neutral_refs);
        let est: Vec<[f64; 3]> = est.iter().map(|v| v.map(|x| x * s)).collect();
        report(name, &score(&est, &refs));
    };
    let lr = libraw_to_xyz(&facts.rgb_cam);
    run("LibRaw matrix", balanced.iter().map(|v| apply(&lr, *v)).collect());
    for (name, forward) in [("DNG model, converter's tags", true), ("  same, ColorMatrix only", false)] {
        if let Some(ad) = dng_to_xyz(&dng, n, forward) {
            run(name, cam.iter().map(|v| apply(&ad, *v)).collect());
        }
    }
    // Cross-validated fit: ten folds, interleaved.
    let folds = 10.min(cam.len());
    let mut est = vec![[0.0; 3]; cam.len()];
    for f in 0..folds {
        let train: Vec<usize> = (0..cam.len()).filter(|i| i % folds != f).collect();
        let m = fit(&train.iter().map(|&i| balanced[i]).collect::<Vec<_>>(), &train.iter().map(|&i| refs[i]).collect::<Vec<_>>()).unwrap();
        for i in (0..cam.len()).filter(|i| i % folds == f) {
            est[i] = apply(&m, balanced[i]);
        }
    }
    run("chart fit (cross-validated)", est);
}

/// One ACES camera data spectral file's rows at 380 to 780 nm in 5 nm steps:
/// each wavelength's values in the file's column order.
fn spectra(path: &std::path::Path) -> Vec<Vec<f64>> {
    let v: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(path).unwrap_or_else(|e| panic!("{}: {e}", path.display()))).unwrap();
    let main = &v["spectral_data"]["data"]["main"];
    (380..=780).step_by(5).map(|nm| main[nm.to_string()].as_array().unwrap_or_else(|| panic!("{} has no {nm} nm", path.display())).iter().map(|x| x.as_f64().unwrap()).collect()).collect()
}

/// CIE daylight at correlated color temperature `t` (CIE 15), 380 to 780 nm.
fn daylight(t: f64) -> Vec<f64> {
    let x = -4.6070e9 / t.powi(3) + 2.9678e6 / t.powi(2) + 0.09911e3 / t + 0.244063;
    let y = -3.0 * x * x + 2.870 * x - 0.275;
    let m = 0.0241 + 0.2562 * x - 0.7341 * y;
    let (m1, m2) = ((-1.3515 - 1.7703 * x + 5.9114 * y) / m, (0.0300 - 31.4424 * x + 30.0717 * y) / m);
    (0..81).map(|i| DAYLIGHT_BASIS[0][i] + m1 * DAYLIGHT_BASIS[1][i] + m2 * DAYLIGHT_BASIS[2][i]).collect()
}

/// CIE Standard Illuminant A: a Planckian radiator at 2856 K, 380 to 780 nm.
fn illuminant_a() -> Vec<f64> {
    let c2 = 1.435e-2;
    let p = |nm: f64| { let l = nm * 1e-9; 1.0 / (l.powi(5) * ((c2 / (2856.0 * l)).exp() - 1.0)) };
    (0..81).map(|i| 100.0 * p(380.0 + 5.0 * i as f64) / p(560.0)).collect()
}

fn spectral(args: &[String]) {
    let data = std::path::Path::new(&args[1]);
    let data = if data.join("data").is_dir() { data.join("data") } else { data.to_path_buf() };
    let ssf = spectra(std::path::Path::new(&args[2]));
    let cmf = spectra(&data.join("cmf/cmf_1931.json"));
    let patches = spectra(&data.join("training/training_spectral.json"));
    let bytes = std::fs::read(&args[3]).unwrap();
    let facts = heeler_raw::linear_dng::libraw_facts(&bytes, heeler_raw::DevelopOpts::default()).unwrap();
    let dng = Dng::parse(&std::fs::read(&args[4]).unwrap()).expect("a DNG of the same camera");
    let n = patches[0].len();
    println!("{} ({} training patches)", args[2].rsplit('/').next().unwrap(), n);
    let integrate = |e: &[f64], r: &dyn Fn(usize) -> f64, w: &Vec<Vec<f64>>| -> [f64; 3] {
        let mut s = [0.0; 3];
        for i in 0..81 {
            for c in 0..3 {
                s[c] += w[i][c] * r(i) * e[i];
            }
        }
        s
    };
    // The measured sensitivities' channel scale is arbitrary; the camera's
    // own is the one under which its DNG's D65 matrix sees D65 white.
    let d65 = daylight(6504.0);
    let sim_d65 = integrate(&d65, &|_| 1.0, &ssf);
    let gain = match dng.color_matrix.iter().zip(dng.illuminant).find(|(_, il)| *il == 21).and_then(|(m, _)| m.as_deref().and_then(heeler_rawdec::color::as3)) {
        Some(cm) => {
            let real = apply(&cm, apply(&XYZ_FROM_SRGB, [1.0, 1.0, 1.0]));
            [real[0] / real[1] / (sim_d65[0] / sim_d65[1]), 1.0, real[2] / real[1] / (sim_d65[2] / sim_d65[1])]
        }
        None => [1.0; 3],
    };
    let lr = libraw_to_xyz(&facts.rgb_cam);
    for (name, e) in [("D65", d65.clone()), ("A", illuminant_a())] {
        let white_xyz = integrate(&e, &|_| 1.0, &cmf);
        let ca = bradford(white_xyz.map(|v| v / white_xyz[1]), D50);
        let refs: Vec<[f64; 3]> = (0..n).map(|p| apply(&ca, integrate(&e, &|i| patches[i][p], &cmf).map(|v| v / white_xyz[1]))).collect();
        let w = integrate(&e, &|_| 1.0, &ssf).map(|v| v);
        let w = [w[0] * gain[0], w[1], w[2] * gain[2]];
        let cam: Vec<[f64; 3]> = (0..n).map(|p| { let c = integrate(&e, &|i| patches[i][p], &ssf); [c[0] * gain[0] / w[1], c[1] / w[1], c[2] * gain[2] / w[1]] }).collect();
        let neutral = [w[0] / w[1], 1.0, w[2] / w[1]];
        let balanced: Vec<[f64; 3]> = cam.iter().map(|v| [v[0] / neutral[0], v[1], v[2] / neutral[2]]).collect();
        println!(" under {name}: camera neutral {:.4} {:.4} {:.4}", neutral[0], neutral[1], neutral[2]);
        report("LibRaw matrix", &score(&balanced.iter().map(|v| apply(&lr, *v)).collect::<Vec<_>>(), &refs));
        for (label, forward) in [("DNG model, converter's tags", true), ("  same, ColorMatrix only", false)] {
            if let Some(m) = dng_to_xyz(&dng, neutral, forward) {
                // Exposure as the model gives it for the white.
                let s = 1.0 / apply(&m, neutral)[1];
                report(label, &score(&cam.iter().map(|v| apply(&m, *v).map(|x| x * s)).collect::<Vec<_>>(), &refs));
            }
        }
        // Fitted from the sensitivities on half the patches, scored on the other.
        let mut est = vec![[0.0; 3]; n];
        for half in 0..2 {
            let train: Vec<usize> = (0..n).filter(|i| i % 2 != half).collect();
            let m = fit(&train.iter().map(|&i| balanced[i]).collect::<Vec<_>>(), &train.iter().map(|&i| refs[i]).collect::<Vec<_>>()).unwrap();
            for i in (0..n).filter(|i| i % 2 == half) {
                est[i] = apply(&m, balanced[i]);
            }
        }
        report("fit to sensitivities (held out)", &score(&est, &refs));
    }
}
