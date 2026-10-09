//! The lensfun database, read with our own parser.
//!
//! Only the DATA is used: the XML files under third_party/lensfun-db,
//! CC-BY-SA 3.0 with attribution in the NOTICE there. The lensfun
//! LIBRARY (LGPL C) is never linked; this parser is original code in
//! the same hand-rolled spirit as the XMP sidecar reader, because the
//! database's XML is flat, regular, and entity-free.
//!
//! Phase 1 (this module): parse and match, so the Lens panel can NAME
//! the profile it would use. The calibration rows are parsed and kept
//! now so phase 2 (applying the distortion model) is a consumer, not
//! a re-parse.

use std::path::Path;

#[derive(Debug, Clone, PartialEq)]
pub struct DistortionRow {
    pub focal: f32,
    /// "ptlens" (a,b,c), "poly3" (k1 in `a`), or "poly5" (k1, k2 in
    /// `a`, `b`). The field names follow the database's own.
    pub model: String,
    pub a: f32,
    pub b: f32,
    pub c: f32,
}

/// Lateral chromatic aberration at one focal length, in lensfun's
/// poly3 form: the red and blue radii as `ru (b ru² + c ru + v)`. The
/// database's "linear" model is folded in at parse time (v = k, the
/// rest zero), so consumers see one shape. Neutral is v = 1.
#[derive(Debug, Clone, PartialEq)]
pub struct TcaRow {
    pub focal: f32,
    pub vr: f32,
    pub cr: f32,
    pub br: f32,
    pub vb: f32,
    pub cb: f32,
    pub bb: f32,
}

/// Vignetting at one (focal, aperture, distance), lensfun's "pa"
/// model: the falloff polynomial `1 + k1 r² + k2 r⁴ + k3 r⁶`, with
/// r = 1 at the image CORNER (unlike distortion/TCA, whose r = 1 is
/// half the shorter side; lensfun's own convention split).
#[derive(Debug, Clone, PartialEq)]
pub struct VignettingRow {
    pub focal: f32,
    pub aperture: f32,
    pub distance: f32,
    pub k1: f32,
    pub k2: f32,
    pub k3: f32,
}

#[derive(Debug, Clone, PartialEq)]
pub struct LensProfile {
    pub maker: String,
    pub model: String,
    pub mount: String,
    pub crop_factor: f32,
    pub distortion: Vec<DistortionRow>,
    pub tca: Vec<TcaRow>,
    pub vignetting: Vec<VignettingRow>,
}

#[derive(Debug, Default)]
pub struct LensDb {
    pub lenses: Vec<LensProfile>,
}

/// The text of `<name>text</name>` inside a block, unescaped enough
/// for this database (it uses no entities beyond &amp;).
fn child_text(block: &str, name: &str) -> Option<String> {
    let open = format!("<{name}>");
    let close = format!("</{name}>");
    let s = block.find(&open)? + open.len();
    let e = block[s..].find(&close)? + s;
    Some(block[s..e].trim().replace("&amp;", "&"))
}

/// One attribute's value out of a single tag's text.
fn attr_val(tag: &str, name: &str) -> Option<String> {
    let pat = format!("{name}=\"");
    let s = tag.find(&pat)? + pat.len();
    let e = tag[s..].find('"')? + s;
    Some(tag[s..e].to_string())
}

fn attr_f32(tag: &str, name: &str) -> Option<f32> {
    attr_val(tag, name)?.parse().ok()
}

/// Every top-level `<name> ... </name>` block in a document.
fn blocks<'a>(xml: &'a str, name: &str) -> Vec<&'a str> {
    let open = format!("<{name}>");
    let close = format!("</{name}>");
    let mut out = Vec::new();
    let mut at = 0;
    while let Some(s) = xml[at..].find(&open) {
        let s = at + s;
        let Some(e) = xml[s..].find(&close) else { break };
        let e = s + e + close.len();
        out.push(&xml[s..e]);
        at = e;
    }
    out
}

/// Every self-closing `<name .../>` tag in a block.
fn tags<'a>(block: &'a str, name: &str) -> Vec<&'a str> {
    let open = format!("<{name} ");
    let mut out = Vec::new();
    let mut at = 0;
    while let Some(s) = block[at..].find(&open) {
        let s = at + s;
        let Some(e) = block[s..].find("/>") else { break };
        let e = s + e + 2;
        out.push(&block[s..e]);
        at = e;
    }
    out
}

pub fn parse_file(xml: &str) -> Vec<LensProfile> {
    blocks(xml, "lens")
        .into_iter()
        .filter_map(|block| {
            let maker = child_text(block, "maker")?;
            let model = child_text(block, "model")?;
            // Localized <model lang="..."> variants repeat the tag; the
            // bare first one is the canonical name, which child_text
            // already returns.
            let mount = child_text(block, "mount").unwrap_or_default();
            let crop_factor = child_text(block, "cropfactor")
                .and_then(|c| c.parse().ok())
                .unwrap_or(1.0);
            let mut distortion = Vec::new();
            for tag in tags(block, "distortion") {
                if let (Some(focal), Some(model)) = (attr_f32(tag, "focal"), attr_val(tag, "model"))
                {
                    distortion.push(DistortionRow {
                        focal,
                        a: attr_f32(tag, "a").or(attr_f32(tag, "k1")).unwrap_or(0.0),
                        b: attr_f32(tag, "b").or(attr_f32(tag, "k2")).unwrap_or(0.0),
                        c: attr_f32(tag, "c").unwrap_or(0.0),
                        model,
                    });
                }
            }
            let mut tca = Vec::new();
            for tag in tags(block, "tca") {
                let (Some(focal), Some(m)) = (attr_f32(tag, "focal"), attr_val(tag, "model"))
                else {
                    continue;
                };
                match m.as_str() {
                    // Linear is poly3 with only the linear term.
                    "linear" => tca.push(TcaRow {
                        focal,
                        vr: attr_f32(tag, "kr").unwrap_or(1.0),
                        vb: attr_f32(tag, "kb").unwrap_or(1.0),
                        cr: 0.0,
                        br: 0.0,
                        cb: 0.0,
                        bb: 0.0,
                    }),
                    "poly3" => tca.push(TcaRow {
                        focal,
                        vr: attr_f32(tag, "vr").unwrap_or(1.0),
                        cr: attr_f32(tag, "cr").unwrap_or(0.0),
                        br: attr_f32(tag, "br").unwrap_or(0.0),
                        vb: attr_f32(tag, "vb").unwrap_or(1.0),
                        cb: attr_f32(tag, "cb").unwrap_or(0.0),
                        bb: attr_f32(tag, "bb").unwrap_or(0.0),
                    }),
                    _ => {}
                }
            }
            let mut vignetting = Vec::new();
            for tag in tags(block, "vignetting") {
                if attr_val(tag, "model").as_deref() != Some("pa") {
                    continue;
                }
                let Some(focal) = attr_f32(tag, "focal") else { continue };
                vignetting.push(VignettingRow {
                    focal,
                    aperture: attr_f32(tag, "aperture").unwrap_or(0.0),
                    distance: attr_f32(tag, "distance").unwrap_or(0.0),
                    k1: attr_f32(tag, "k1").unwrap_or(0.0),
                    k2: attr_f32(tag, "k2").unwrap_or(0.0),
                    k3: attr_f32(tag, "k3").unwrap_or(0.0),
                });
            }
            Some(LensProfile { maker, model, mount, crop_factor, distortion, tca, vignetting })
        })
        .collect()
}

impl LensProfile {
    /// The distortion row for a shot's focal length: the calibration
    /// interpolated to where the zoom actually was.
    ///
    /// Rows are calibrated at discrete focal lengths. Between two rows
    /// of the same model the coefficients interpolate linearly (they
    /// vary smoothly through a zoom range); between rows of different
    /// models the nearer row wins as-is, because coefficients of
    /// different polynomials cannot be mixed. Outside the calibrated
    /// range the end row is used unscaled: extrapolating a polynomial
    /// fit invents data. With no focal length (a file that never said),
    /// a single-row calibration still applies: primes have one row and
    /// nothing to choose between.
    pub fn distortion_at(&self, focal: Option<f32>) -> Option<DistortionRow> {
        let mut rows: Vec<&DistortionRow> = self.distortion.iter().collect();
        if rows.is_empty() {
            return None;
        }
        rows.sort_by(|x, y| x.focal.total_cmp(&y.focal));
        let Some(f) = focal else {
            return if rows.len() == 1 { Some(rows[0].clone()) } else { None };
        };
        if f <= rows[0].focal {
            return Some(rows[0].clone());
        }
        if f >= rows[rows.len() - 1].focal {
            return Some(rows[rows.len() - 1].clone());
        }
        let hi = rows.iter().position(|r| r.focal >= f).unwrap_or(rows.len() - 1);
        let (lo, hi) = (rows[hi - 1], rows[hi]);
        if lo.model != hi.model {
            return Some(if f - lo.focal <= hi.focal - f { lo.clone() } else { hi.clone() });
        }
        let t = (f - lo.focal) / (hi.focal - lo.focal).max(1e-6);
        let lerp = |x: f32, y: f32| x + (y - x) * t;
        Some(DistortionRow {
            focal: f,
            model: lo.model.clone(),
            a: lerp(lo.a, hi.a),
            b: lerp(lo.b, hi.b),
            c: lerp(lo.c, hi.c),
        })
    }
}

impl LensProfile {
    /// The TCA coefficients for a shot's focal length, same rules as
    /// `distortion_at`: lerp between rows, clamp outside the range, a
    /// single row applies even without a focal length. Rows are all in
    /// poly3 form (see TcaRow), so there is no model mixing to refuse.
    pub fn tca_at(&self, focal: Option<f32>) -> Option<TcaRow> {
        let mut rows: Vec<&TcaRow> = self.tca.iter().collect();
        if rows.is_empty() {
            return None;
        }
        rows.sort_by(|x, y| x.focal.total_cmp(&y.focal));
        let Some(f) = focal else {
            return if rows.len() == 1 { Some(rows[0].clone()) } else { None };
        };
        if f <= rows[0].focal {
            return Some(rows[0].clone());
        }
        if f >= rows[rows.len() - 1].focal {
            return Some(rows[rows.len() - 1].clone());
        }
        let hi = rows.iter().position(|r| r.focal >= f).unwrap_or(rows.len() - 1);
        let (lo, hi) = (rows[hi - 1], rows[hi]);
        let t = (f - lo.focal) / (hi.focal - lo.focal).max(1e-6);
        let lerp = |x: f32, y: f32| x + (y - x) * t;
        Some(TcaRow {
            focal: f,
            vr: lerp(lo.vr, hi.vr),
            cr: lerp(lo.cr, hi.cr),
            br: lerp(lo.br, hi.br),
            vb: lerp(lo.vb, hi.vb),
            cb: lerp(lo.cb, hi.cb),
            bb: lerp(lo.bb, hi.bb),
        })
    }

    /// The vignetting polynomial `[k1, k2, k3]` for a shot, interpolated
    /// over focal length AND aperture (falloff changes sharply as a lens
    /// stops down, so aperture is not optional: without it, no answer is
    /// better than the wide-open answer applied to an f/8 frame). Where
    /// the database repeats a (focal, aperture) at several subject
    /// distances the largest wins: ordinary photography lives nearer
    /// infinity than the calibration chart does.
    pub fn vignetting_at(&self, focal: Option<f32>, aperture: Option<f32>) -> Option<[f32; 3]> {
        if self.vignetting.is_empty() {
            return None;
        }
        let ap = aperture?;
        // One row per (focal, aperture): the farthest-distance one.
        let mut rows: Vec<&VignettingRow> = Vec::new();
        for r in &self.vignetting {
            match rows.iter_mut().find(|q| q.focal == r.focal && q.aperture == r.aperture) {
                Some(q) if r.distance > q.distance => *q = r,
                Some(_) => {}
                None => rows.push(r),
            }
        }
        let mut focals: Vec<f32> = rows.iter().map(|r| r.focal).collect();
        focals.sort_by(f32::total_cmp);
        focals.dedup();
        let f = match focal {
            Some(f) => f,
            None if focals.len() == 1 => focals[0],
            None => return None,
        };
        // The polynomial at one calibrated focal, aperture-interpolated.
        let at_focal = |cf: f32| -> [f32; 3] {
            let mut at: Vec<&&VignettingRow> = rows.iter().filter(|r| r.focal == cf).collect();
            at.sort_by(|x, y| x.aperture.total_cmp(&y.aperture));
            let ks = |r: &VignettingRow| [r.k1, r.k2, r.k3];
            if ap <= at[0].aperture {
                return ks(at[0]);
            }
            if ap >= at[at.len() - 1].aperture {
                return ks(at[at.len() - 1]);
            }
            let hi = at.iter().position(|r| r.aperture >= ap).unwrap_or(at.len() - 1);
            let (lo, hi) = (at[hi - 1], at[hi]);
            let t = (ap - lo.aperture) / (hi.aperture - lo.aperture).max(1e-6);
            [
                lo.k1 + (hi.k1 - lo.k1) * t,
                lo.k2 + (hi.k2 - lo.k2) * t,
                lo.k3 + (hi.k3 - lo.k3) * t,
            ]
        };
        let f = f.clamp(focals[0], focals[focals.len() - 1]);
        let hi = focals.iter().position(|&cf| cf >= f).unwrap_or(focals.len() - 1);
        if focals[hi] == f || hi == 0 {
            return Some(at_focal(focals[hi]));
        }
        let (flo, fhi) = (focals[hi - 1], focals[hi]);
        let (klo, khi) = (at_focal(flo), at_focal(fhi));
        let t = (f - flo) / (fhi - flo).max(1e-6);
        Some([
            klo[0] + (khi[0] - klo[0]) * t,
            klo[1] + (khi[1] - klo[1]) * t,
            klo[2] + (khi[2] - klo[2]) * t,
        ])
    }
}

impl LensDb {
    /// Loads every XML file in the vendored database directory.
    pub fn load_dir(dir: &Path) -> LensDb {
        let mut lenses = Vec::new();
        if let Ok(entries) = std::fs::read_dir(dir) {
            for entry in entries.flatten() {
                let path = entry.path();
                if path.extension().and_then(|e| e.to_str()) != Some("xml") {
                    continue;
                }
                if let Ok(xml) = std::fs::read_to_string(&path) {
                    lenses.extend(parse_file(&xml));
                }
            }
        }
        LensDb { lenses }
    }

    /// The profile for a camera's reported lens name, or None.
    ///
    /// Matching is token-based, the same spirit as lensfun's own fuzzy
    /// rules: normalize both names, then require every NUMERIC token
    /// of the EXIF name (focal range, aperture) to appear in the
    /// candidate, and score by total token overlap. Numbers carry the
    /// identity ("20-60mm f/3.5-5.6"); words like "Lumix" and "Asph"
    /// come and go between the camera's spelling and the database's.
    pub fn match_lens(&self, exif_lens: &str) -> Option<&LensProfile> {
        // Cameras write literal sentinels for a body with no chipped lens;
        // matching those is matching nothing. The owner's RW2 wrote
        // "NO-LENS" and the fuzzy pass landed it on a Zeiss.
        let upper = exif_lens.trim().to_uppercase();
        if upper.is_empty() || upper == "NO-LENS" || upper == "N/A" || upper.chars().all(|c| c == '-') {
            return None;
        }
        let wanted = tokens(exif_lens);
        if wanted.is_empty() {
            return None;
        }
        let wanted_numbers: Vec<&String> =
            wanted.iter().filter(|t| t.chars().any(|c| c.is_ascii_digit())).collect();
        // A name with no numbers has no focal/aperture identity to
        // guard it, so it must match in FULL, not by one shared word.
        let full_match_required = wanted_numbers.is_empty();
        // Focal ranges repeat across brands (every maker sells a 24-70 f/2.8),
        // so when the EXIF name carries brand words, at least one must appear
        // in the candidate. The owner's Lumix S 24-70, absent from the
        // database, fuzzy-landed on the Nikkor without this.
        let wanted_words: Vec<&String> = wanted
            .iter()
            .filter(|t| t.len() >= 2 && t.chars().all(|c| c.is_ascii_alphabetic()))
            .collect();
        let mut best: Option<(usize, &LensProfile)> = None;
        for lens in &self.lenses {
            let have = tokens(&format!("{} {}", lens.maker, lens.model));
            if !wanted_numbers.iter().all(|n| have.contains(n)) {
                continue;
            }
            if !wanted_words.is_empty() && !wanted_words.iter().any(|w| have.contains(w)) {
                continue;
            }
            let overlap = wanted.iter().filter(|t| have.contains(t)).count();
            if overlap == 0 || (full_match_required && overlap < wanted.len()) {
                continue;
            }
            let better = match best {
                None => true,
                Some((score, incumbent)) => {
                    overlap > score
                        || (overlap == score && lens.distortion.len() > incumbent.distortion.len())
                }
            };
            if better {
                best = Some((overlap, lens));
            }
        }
        best.map(|(_, l)| l)
    }
}

/// Normalized name tokens: lowercase, split on everything that is not
/// a letter or digit, with unit suffixes split off numbers so "60mm"
/// and "60 mm" agree, and lone "f" dropped so "f/3.5" and "3.5" agree.
fn tokens(name: &str) -> Vec<String> {
    let lower = name.to_lowercase();
    let mut out = Vec::new();
    for raw in lower.split(|c: char| !c.is_ascii_alphanumeric() && c != '.') {
        if raw.is_empty() {
            continue;
        }
        let mut t = raw.trim_end_matches("mm").trim_end_matches('.');
        // Cameras glue the aperture letter on ("F3.5"); the database
        // writes "f/3.5". Peel a leading f from a number so they agree.
        if t.len() > 1 && t.starts_with('f') && t[1..].chars().all(|c| c.is_ascii_digit() || c == '.') {
            t = &t[1..];
        }
        if t.is_empty() || t == "f" {
            continue;
        }
        out.push(t.to_string());
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    const SAMPLE: &str = r#"
    <lensdatabase version="2">
        <lens>
            <maker>Panasonic</maker>
            <model>Lumix G 14mm f/2.5 Asph.</model>
            <mount>Micro 4/3 System</mount>
            <cropfactor>2</cropfactor>
            <calibration>
                <distortion focal="14" model="ptlens" a="0.0115556" b="-0.0589829" c="0.000154452"/>
            </calibration>
        </lens>
        <lens>
            <maker>Panasonic</maker>
            <model>Lumix S 20-60mm f/3.5-5.6</model>
            <mount>L-Mount</mount>
            <cropfactor>1</cropfactor>
            <calibration>
                <distortion focal="20" model="poly3" k1="-0.02"/>
                <distortion focal="60" model="poly3" k1="0.008"/>
                <tca model="poly3" focal="20" br="-0.0002" vr="1.0006" bb="0.0001" vb="0.9998"/>
                <tca model="poly3" focal="60" br="0.0002" vr="1.0002" bb="-0.0001" vb="1.0000"/>
                <vignetting model="pa" focal="20" aperture="3.5" distance="10" k1="-0.9" k2="0.5" k3="-0.2"/>
                <vignetting model="pa" focal="20" aperture="3.5" distance="1000" k1="-1.0" k2="0.6" k3="-0.3"/>
                <vignetting model="pa" focal="20" aperture="8" distance="1000" k1="-0.4" k2="0.2" k3="-0.1"/>
                <vignetting model="pa" focal="60" aperture="5.6" distance="1000" k1="-0.6" k2="0.3" k3="-0.1"/>
            </calibration>
        </lens>
    </lensdatabase>"#;

    #[test]
    fn the_parser_reads_lenses_and_their_distortion_rows() {
        let lenses = parse_file(SAMPLE);
        assert_eq!(lenses.len(), 2);
        assert_eq!(lenses[0].model, "Lumix G 14mm f/2.5 Asph.");
        assert_eq!(lenses[0].crop_factor, 2.0);
        assert_eq!(lenses[0].distortion.len(), 1);
        assert_eq!(lenses[0].distortion[0].model, "ptlens");
        assert!((lenses[0].distortion[0].a - 0.0115556).abs() < 1e-7);
        // poly3 rows park k1 in `a`.
        assert!((lenses[1].distortion[0].a + 0.02).abs() < 1e-7);
    }

    #[test]
    fn matching_survives_the_camera_spelling_the_database_never_saw() {
        let db = LensDb { lenses: parse_file(SAMPLE) };
        // A camera's EXIF spelling: different casing, spacing, no
        // "Asph.", maker glued in.
        let hit = db.match_lens("LUMIX S 20-60/F3.5-5.6").expect("should match");
        assert_eq!(hit.model, "Lumix S 20-60mm f/3.5-5.6");
        let hit = db.match_lens("Panasonic Lumix G 14 mm F2.5").expect("should match");
        assert_eq!(hit.model, "Lumix G 14mm f/2.5 Asph.");
        // The numbers guard identity: a lens the database lacks does
        // not fuzzy-land on a lookalike.
        assert!(db.match_lens("LUMIX S 24-105mm F4").is_none());
        assert!(db.match_lens("").is_none());
        // The sentinel the owner's Panasonic writes for an unchipped
        // lens, and the numberless near-misses that must not
        // fuzzy-land.
        assert!(db.match_lens("NO-LENS").is_none());
        assert!(db.match_lens("----").is_none());
        assert!(db.match_lens("Lumix Something").is_none());
        // Every maker sells the same focal range: matching numbers must
        // not cross brands when the EXIF name states one.
        assert!(db.match_lens("NIKKOR Z 20-60mm F3.5-5.6").is_none());
    }

    #[test]
    fn calibration_interpolates_to_the_focal_length_of_the_shot() {
        let db = LensDb { lenses: parse_file(SAMPLE) };
        let zoom = db.match_lens("LUMIX S 20-60/F3.5-5.6").unwrap();
        // On a calibrated row exactly, that row.
        assert!((zoom.distortion_at(Some(20.0)).unwrap().a + 0.02).abs() < 1e-7);
        // Halfway between 20 and 60, halfway between the coefficients.
        let mid = zoom.distortion_at(Some(40.0)).unwrap();
        assert_eq!(mid.model, "poly3");
        assert!((mid.a - (-0.02 + 0.008) / 2.0).abs() < 1e-6, "a = {}", mid.a);
        // Outside the calibrated range, the end row unscaled.
        assert!((zoom.distortion_at(Some(200.0)).unwrap().a - 0.008).abs() < 1e-7);
        // A prime's single row applies even when the file names no focal.
        let prime = db.match_lens("LUMIX G 14mm F2.5").unwrap();
        assert!((prime.distortion_at(None).unwrap().a - 0.0115556).abs() < 1e-7);
        // But a zoom with no focal length has nothing to choose between.
        assert!(zoom.distortion_at(None).is_none());
    }

    #[test]
    fn tca_rows_parse_and_interpolate_in_one_uniform_shape() {
        let db = LensDb { lenses: parse_file(SAMPLE) };
        let zoom = db.match_lens("LUMIX S 20-60/F3.5-5.6").unwrap();
        assert_eq!(zoom.tca.len(), 2);
        // Halfway through the zoom, halfway between the coefficients.
        let mid = zoom.tca_at(Some(40.0)).unwrap();
        assert!((mid.vr - 1.0004).abs() < 1e-6);
        assert!((mid.br - 0.0).abs() < 1e-7);
        // A linear-model row folds into the same shape at parse time.
        let linear = parse_file(
            r#"<lens><maker>X</maker><model>Y 50mm f/2</model>
               <calibration><tca model="linear" focal="50" kr="1.0003" kb="0.9997"/></calibration>
               </lens>"#,
        );
        let row = linear[0].tca_at(None).unwrap();
        assert!((row.vr - 1.0003).abs() < 1e-6);
        assert!((row.vb - 0.9997).abs() < 1e-6);
        assert_eq!(row.cr, 0.0);
    }

    #[test]
    fn vignetting_interpolates_over_aperture_and_focal_and_prefers_far_distance() {
        let db = LensDb { lenses: parse_file(SAMPLE) };
        let zoom = db.match_lens("LUMIX S 20-60/F3.5-5.6").unwrap();
        // At 20mm f/3.5 the distance-1000 row wins over the chart-close one.
        let k = zoom.vignetting_at(Some(20.0), Some(3.5)).unwrap();
        assert!((k[0] + 1.0).abs() < 1e-6, "k1 = {}", k[0]);
        // Between f/3.5 and f/8 the falloff interpolates: f/5.75 is halfway.
        let k = zoom.vignetting_at(Some(20.0), Some(5.75)).unwrap();
        assert!((k[0] + 0.7).abs() < 1e-6, "k1 = {}", k[0]);
        // Between focals it interpolates too (each end aperture-clamped).
        let k = zoom.vignetting_at(Some(40.0), Some(8.0)).unwrap();
        assert!((k[0] - (-0.4 + -0.6) / 2.0).abs() < 1e-6, "k1 = {}", k[0]);
        // No aperture, no answer: correcting the wide-open falloff on a
        // stopped-down frame would darken nothing and brighten wrongly.
        assert!(zoom.vignetting_at(Some(20.0), None).is_none());
    }

    #[test]
    fn the_vendored_database_parses_and_finds_a_known_lens() {
        // The real vendored tree, when running inside the repo. Guarded
        // so a packaged test environment without it still passes.
        let dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../third_party/lensfun-db/db");
        if !dir.exists() {
            eprintln!("vendored lensfun db not present; skipping");
            return;
        }
        let db = LensDb::load_dir(&dir);
        // 1562 <lens> blocks in the vendored snapshot, all captured;
        // the floor guards against a parser regression, not the count.
        assert!(db.lenses.len() > 1500, "expected 1500+ lenses, got {}", db.lenses.len());
        let hit = db.match_lens("LUMIX G 14mm F2.5").expect("the m43 pancake should match");
        assert!(!hit.distortion.is_empty(), "the pancake carries calibration");
    }
}
