//! The 3D LUT node: a .cube file applied by trilinear
//! interpolation.
//!
//! Applied in DISPLAY-ENCODED space, deliberately: creative .cube LUTs
//! from grading tools and film emulations are built against encoded
//! 0..1 video, not scene-linear light, and feeding them scene values
//! shreds their shadows. So: encode, look up, decode, the same dance
//! the tone profile does around its curve. `amount` blends in scene
//! space afterwards.
//!
//! The file rides as a PATH parameter, not embedded data: a 33³ LUT is
//! four hundred kilobytes and a graph file should not carry it. The
//! parsed table is cached per path and reloaded when the file's mtime
//! moves. Honest limitation: the executor caches by parameters, so
//! overwriting the file in place shows up on the next edit rather than
//! instantly; missing files are an error, never a silent identity,
//! because a graph that quietly renders without its LUT is lying about
//! what it will export.

use std::collections::HashMap;
use std::path::Path;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::SystemTime;

use heeler_graph::Node;

use crate::buffers::Value;
use crate::executor::EngineError;
use crate::ops::{image_input, invalid_param, map_rgb, p, to_display, to_scene};

pub struct Lut3d {
    pub title: String,
    pub size: usize,
    /// r-fastest, per the .cube spec: index = r + g*N + b*N², three
    /// floats per entry.
    pub data: Vec<f32>,
    pub domain_min: [f32; 3],
    pub domain_max: [f32; 3],
}

/// Parses the .cube LUT text format: LUT_3D_SIZE, optional
/// TITLE and DOMAIN_MIN/MAX, then size³ lines of three floats, red
/// varying fastest. 1D LUTs are refused by name rather than misread.
pub fn parse_cube(text: &str) -> Result<Lut3d, String> {
    let mut lut = Lut3d {
        title: String::new(),
        size: 0,
        data: Vec::new(),
        domain_min: [0.0; 3],
        domain_max: [1.0; 3],
    };
    for line in text.lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let mut parts = line.split_whitespace();
        let head = parts.next().unwrap_or("");
        match head {
            "TITLE" => {
                lut.title = line["TITLE".len()..].trim().trim_matches('"').to_string();
            }
            "LUT_3D_SIZE" => {
                let n: usize =
                    parts.next().and_then(|v| v.parse().ok()).ok_or("bad LUT_3D_SIZE")?;
                if !(2..=256).contains(&n) {
                    return Err(format!("unreasonable LUT size {n}"));
                }
                lut.size = n;
                lut.data.reserve(n * n * n * 3);
            }
            "LUT_1D_SIZE" => return Err("1D LUTs are not supported; this needs a 3D .cube".into()),
            "DOMAIN_MIN" | "DOMAIN_MAX" => {
                let mut v = [0.0f32; 3];
                for slot in &mut v {
                    *slot = parts.next().and_then(|t| t.parse().ok()).ok_or("bad DOMAIN line")?;
                }
                if head == "DOMAIN_MIN" {
                    lut.domain_min = v;
                } else {
                    lut.domain_max = v;
                }
            }
            _ => {
                // A data line: three floats. Anything else is a keyword
                // this parser does not know, skipped rather than fatal.
                let (Ok(r), Some(g), Some(b)) = (
                    head.parse::<f32>(),
                    parts.next().and_then(|t| t.parse::<f32>().ok()),
                    parts.next().and_then(|t| t.parse::<f32>().ok()),
                ) else {
                    continue;
                };
                lut.data.extend_from_slice(&[r, g, b]);
            }
        }
    }
    if lut.size == 0 {
        return Err("no LUT_3D_SIZE line; not a 3D .cube file".into());
    }
    let expect = lut.size * lut.size * lut.size * 3;
    if lut.data.len() != expect {
        return Err(format!(
            "expected {} entries for a {}³ LUT, found {}",
            expect / 3,
            lut.size,
            lut.data.len() / 3
        ));
    }
    Ok(lut)
}

impl Lut3d {
    /// Trilinear lookup of one encoded color, domain-normalized.
    pub fn sample(&self, rgb: [f32; 3]) -> [f32; 3] {
        let n = self.size;
        let mut idx = [0usize; 3];
        let mut frac = [0f32; 3];
        for c in 0..3 {
            let span = (self.domain_max[c] - self.domain_min[c]).max(1e-6);
            let t = ((rgb[c] - self.domain_min[c]) / span).clamp(0.0, 1.0) * (n - 1) as f32;
            idx[c] = (t.floor() as usize).min(n - 2);
            frac[c] = t - idx[c] as f32;
        }
        let at = |r: usize, g: usize, b: usize| {
            let i = (r + g * n + b * n * n) * 3;
            [self.data[i], self.data[i + 1], self.data[i + 2]]
        };
        let mut out = [0f32; 3];
        for c in 0..3 {
            let mut acc = 0.0;
            for (db, wb) in [(0, 1.0 - frac[2]), (1, frac[2])] {
                for (dg, wg) in [(0, 1.0 - frac[1]), (1, frac[1])] {
                    for (dr, wr) in [(0, 1.0 - frac[0]), (1, frac[0])] {
                        acc += wr * wg * wb * at(idx[0] + dr, idx[1] + dg, idx[2] + db)[c];
                    }
                }
            }
            out[c] = acc;
        }
        out
    }
}

/// Per-path cache, invalidated by mtime: a slider drag must not re-read
/// half a megabyte per frame.
fn cached(path: &str) -> Result<Arc<Lut3d>, String> {
    static CACHE: OnceLock<Mutex<HashMap<String, (SystemTime, Arc<Lut3d>)>>> = OnceLock::new();
    let cache = CACHE.get_or_init(|| Mutex::new(HashMap::new()));
    let mtime = std::fs::metadata(path)
        .and_then(|m| m.modified())
        .map_err(|e| format!("cannot read LUT {path}: {e}"))?;
    let mut map = cache.lock().unwrap();
    if let Some((t, lut)) = map.get(path) {
        if *t == mtime {
            return Ok(lut.clone());
        }
    }
    let text =
        std::fs::read_to_string(path).map_err(|e| format!("cannot read LUT {path}: {e}"))?;
    let lut = Arc::new(parse_cube(&text).map_err(|e| format!("{}: {e}", Path::new(path).file_name().and_then(|n| n.to_str()).unwrap_or(path)))?);
    map.insert(path.to_string(), (mtime, lut.clone()));
    Ok(lut)
}

pub(crate) fn lut(node: &Node, inputs: &[(String, Value)]) -> Result<Value, EngineError> {
    let src = image_input(inputs, "in", &node.id)?;
    let path = node.params.get("path").and_then(|v| v.as_str()).unwrap_or("").trim().to_string();
    let amount = p(&node.params, "amount", 100.0).clamp(0.0, 100.0) / 100.0;
    if path.is_empty() || amount <= 0.0 {
        return Ok(Value::Image(src.clone()));
    }
    let table = cached(&path).map_err(|e| invalid_param(node, "path", e))?;
    let out = map_rgb(src, |r, g, b| {
        let enc = [to_display(r.max(0.0)), to_display(g.max(0.0)), to_display(b.max(0.0))];
        let looked = table.sample(enc);
        let mut o = [0f32; 3];
        for c in 0..3 {
            let v = to_scene(looked[c].clamp(0.0, 1.0));
            let orig = [r, g, b][c];
            o[c] = orig + (v - orig) * amount;
        }
        o
    });
    Ok(Value::Image(Arc::new(out)))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::buffers::ImageBuf;
    use crate::ops::test_util::{make_node, run_on, set_num, set_text};

    /// An identity .cube of the given size, generated the way every
    /// grading tool writes them: red varying fastest.
    fn identity_cube(n: usize) -> String {
        let mut s = format!("TITLE \"unit\"\nLUT_3D_SIZE {n}\n");
        for b in 0..n {
            for g in 0..n {
                for r in 0..n {
                    let f = |i: usize| i as f32 / (n - 1) as f32;
                    s.push_str(&format!("{} {} {}\n", f(r), f(g), f(b)));
                }
            }
        }
        s
    }

    #[test]
    fn the_parser_reads_what_resolve_writes_and_refuses_what_it_cannot() {
        let lut = parse_cube(&identity_cube(3)).unwrap();
        assert_eq!(lut.title, "unit");
        assert_eq!(lut.size, 3);
        assert_eq!(lut.data.len(), 81);
        // Wrong entry count is a hard error, not a short read.
        assert!(parse_cube("LUT_3D_SIZE 3\n0 0 0\n").is_err());
        assert!(parse_cube("LUT_1D_SIZE 1024\n").is_err());
        assert!(parse_cube("just words\n").is_err());
    }

    #[test]
    fn an_identity_lut_is_very_nearly_the_identity() {
        // Trilinear across a 5³ identity table: values on and off the
        // knots come back within interpolation distance of themselves.
        let lut = parse_cube(&identity_cube(5)).unwrap();
        for v in [[0.0, 0.0, 0.0], [0.25, 0.5, 0.75], [1.0, 1.0, 1.0], [0.1, 0.9, 0.33]] {
            let out = lut.sample(v);
            for c in 0..3 {
                assert!((out[c] - v[c]).abs() < 1e-5, "{v:?} -> {out:?}");
            }
        }
    }

    #[test]
    fn the_node_applies_a_lut_from_disk_and_blends_by_amount() {
        // A channel-swap LUT (red becomes green): unambiguous, and
        // any indexing-order mistake shows up as the wrong channel.
        let n = 3;
        let mut cube = format!("LUT_3D_SIZE {n}\n");
        for b in 0..n {
            for g in 0..n {
                for r in 0..n {
                    let f = |i: usize| i as f32 / (n - 1) as f32;
                    cube.push_str(&format!("{} {} {}\n", f(g), f(r), f(b)));
                }
            }
        }
        let dir = std::env::temp_dir().join("heeler-lut-test");
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("swap.cube");
        std::fs::write(&path, cube).unwrap();

        let mut node = make_node("heeler.lut");
        set_text(&mut node, "path", path.to_str().unwrap());
        let mut img = ImageBuf::new(1, 1);
        img.data.copy_from_slice(&[0.6, 0.2, 0.1, 1.0]);
        let out = run_on(&node, img.clone()).unwrap();
        let d = out.as_image().unwrap().data.clone();
        // Red and green traded places, in scene terms, within trilinear slack.
        assert!((d[0] - 0.2).abs() < 0.02, "{d:?}");
        assert!((d[1] - 0.6).abs() < 0.02, "{d:?}");
        assert!((d[2] - 0.1).abs() < 0.02, "{d:?}");

        // Half amount lands halfway.
        set_num(&mut node, "amount", 50.0);
        let mid = run_on(&node, img.clone()).unwrap();
        let m = mid.as_image().unwrap().data.clone();
        assert!((m[0] - (0.6 + d[0]) / 2.0).abs() < 0.02, "{m:?}");

        // A missing file is an error, never a silent identity.
        set_text(&mut node, "path", "/nowhere/never.cube");
        assert!(run_on(&node, img).is_err());
    }
}
