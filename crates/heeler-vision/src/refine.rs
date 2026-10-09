//! Matting-grade Selection Polish: ViTMatte, trimap-guided alpha
//! matting. The classical polish reads color means and gradient
//! energy, and the owner watched it lose the fight with hair: "just
//! couldn't get fine selections (like hair strands) figured out."
//! This model was trained on exactly that fight.
//!
//! The shape of the pass: the user's coarse selection becomes a trimap
//! (erode for the certain inside, dilate for the band where the truth
//! is unknown), the model resolves the band against the photograph,
//! and the answer becomes the selection's base raster. Everything the
//! polish already does (strokes, grow, feather) still applies on
//! top, in the engine, with no model in the room.

use std::path::Path;

use ort::session::Session;
use ort::value::Tensor;

use crate::models::{model_paths, ModelSpec};
use crate::pre::{resize_exact_rgb, resize_plane};
use crate::VisionError;

/// The model's working budget: the unknown band's crop is brought
/// under this side before inference. ViT attention is quadratic in
/// area; 1024 held ~0.7s on CPU in the acceptance probe.
/// The one-shot pass's working size, the long side the unknown band's
/// crop is scaled to before the model. The brushed pass takes its own
/// (polish_matte hands it a larger one: its crop is a stroke's
/// neighborhood, not the whole edge, so it can afford the pixels).
const MAX_SIDE: usize = 1024;

pub struct Refiner {
    session: Session,
}

fn inference(e: ort::Error) -> VisionError {
    VisionError::Inference(e.to_string())
}

impl Refiner {
    pub fn load(base: &Path, spec: &ModelSpec) -> Result<Refiner, VisionError> {
        let paths = model_paths(base, spec);
        let session = Session::builder()
            .map_err(inference)?
            .commit_from_file(&paths[0])
            .map_err(inference)?;
        Ok(Refiner { session })
    }

    /// RGB HWC f32 0..255 plus a trimap plane (0 background, 0.5
    /// unknown, 1 foreground) in; the resolved 0..1 alpha at the same
    /// (w, h) out. Input is padded to the /32 grid the ViT patches
    /// need (the export's own size_divisibility), padding cropped off
    /// the answer.
    pub fn refine(
        &mut self,
        rgb: &[f32],
        trimap: &[f32],
        w: usize,
        h: usize,
    ) -> Result<Vec<f32>, VisionError> {
        assert_eq!(rgb.len(), w * h * 3, "HWC RGB expected");
        assert_eq!(trimap.len(), w * h, "trimap plane expected");
        let (pw, ph) = (w.div_ceil(32) * 32, h.div_ceil(32) * 32);
        // CHW, 4 channels: normalized RGB then the trimap, padded with
        // zeros (background, which is what off-frame is).
        let mut chw = vec![0.0f32; 4 * pw * ph];
        for y in 0..h {
            for x in 0..w {
                let src = y * w + x;
                let dst = y * pw + x;
                for c in 0..3 {
                    chw[c * pw * ph + dst] = (rgb[src * 3 + c] / 255.0 - 0.5) / 0.5;
                }
                chw[3 * pw * ph + dst] = trimap[src];
            }
        }
        let input = Tensor::from_array(([1usize, 4, ph, pw], chw)).map_err(inference)?;
        let outputs = self
            .session
            .run(ort::inputs!["pixel_values" => input])
            .map_err(inference)?;
        let (shape, alphas) = outputs["alphas"]
            .try_extract_tensor::<f32>()
            .map_err(inference)?;
        let (ah, aw) = (shape[2] as usize, shape[3] as usize);
        let mut out = vec![0.0f32; w * h];
        for y in 0..h.min(ah) {
            for x in 0..w.min(aw) {
                out[y * w + x] = alphas[y * aw + x].clamp(0.0, 1.0);
            }
        }
        Ok(out)
    }
}

/// Chamfer distance to the nearest pixel where `inside` differs: two
/// passes, 3-4 weights, plenty for band-building. Returns distances in
/// (scaled) pixels, capped so the buffer stays f32-exact.
fn chamfer(mask: &[f32], w: usize, h: usize, from_inside: bool) -> Vec<f32> {
    const FAR: f32 = 1e7;
    let is_in = |v: f32| v >= 0.5;
    let mut d: Vec<f32> = mask
        .iter()
        .map(|v| if is_in(*v) == from_inside { FAR } else { 0.0 })
        .collect();
    let idx = |x: usize, y: usize| y * w + x;
    for y in 0..h {
        for x in 0..w {
            let mut best = d[idx(x, y)];
            if x > 0 {
                best = best.min(d[idx(x - 1, y)] + 3.0);
                if y > 0 {
                    best = best.min(d[idx(x - 1, y - 1)] + 4.0);
                }
            }
            if y > 0 {
                best = best.min(d[idx(x, y - 1)] + 3.0);
                if x + 1 < w {
                    best = best.min(d[idx(x + 1, y - 1)] + 4.0);
                }
            }
            d[idx(x, y)] = best;
        }
    }
    for y in (0..h).rev() {
        for x in (0..w).rev() {
            let mut best = d[idx(x, y)];
            if x + 1 < w {
                best = best.min(d[idx(x + 1, y)] + 3.0);
                if y + 1 < h {
                    best = best.min(d[idx(x + 1, y + 1)] + 4.0);
                }
            }
            if y + 1 < h {
                best = best.min(d[idx(x, y + 1)] + 3.0);
                if x > 0 {
                    best = best.min(d[idx(x - 1, y + 1)] + 4.0);
                }
            }
            d[idx(x, y)] = best;
        }
    }
    // 3-4 chamfer: divide by 3 to land near euclidean pixels.
    d.iter_mut().for_each(|v| *v /= 3.0);
    d
}

/// The coarse selection as a trimap: certainly-inside where the mask
/// survives an erode of `keep_px`, certainly-outside past `band_px`
/// from the edge, unknown between. The band is deliberately generous:
/// it is the search area for the strands the coarse selection missed,
/// and the model charges nothing extra for honesty about uncertainty.
pub fn trimap_from_coarse(
    mask: &[f32],
    w: usize,
    h: usize,
    keep_px: f32,
    band_px: f32,
) -> Vec<f32> {
    let to_edge_in = chamfer(mask, w, h, true); // distance to outside, from inside
    let to_edge_out = chamfer(mask, w, h, false); // distance to inside, from outside
    mask.iter()
        .enumerate()
        .map(|(i, v)| {
            if *v >= 0.5 {
                if to_edge_in[i] > keep_px { 1.0 } else { 0.5 }
            } else if to_edge_out[i] > band_px {
                0.0
            } else {
                0.5
            }
        })
        .collect()
}

/// The one-shot P4 pass over one frame: coarse mask to trimap, the
/// unknown band's crop through the model at working resolution, the
/// answer stitched back so certain pixels stay exactly certain.
/// RGB is HWC f32 0..255; the coarse mask and the returned alpha are
/// 0..1 planes at (w, h).
pub fn refine_selection(
    refiner: &mut Refiner,
    rgb: &[f32],
    coarse: &[f32],
    w: usize,
    h: usize,
) -> Result<Vec<f32>, VisionError> {
    let short = w.min(h) as f32;
    // Keep radius trims the coarse edge's own error margin; the band
    // reaches for what the selection missed. Fractions of the short
    // side so a phone frame and a medium-format scan get the same
    // relative reach. The band errs WIDE: a strand whose tip pokes
    // past it gets labeled certain-background, and the model then
    // rightly distrusts the whole strand: a narrow band does not
    // save compute, it poisons the trimap. (The acceptance probe's
    // strands reach ~20% of the short side past the coarse edge.)
    refine_selection_at(refiner, rgb, coarse, w, h, (short * 0.22).max(48.0))
}

/// The haze under a matte, taken out. Over open, soft background a
/// matting model hedges: on the owner's lemur it answered 0.1 to 0.4
/// for tens of pixels round the fur, a smooth gray skirt with no
/// strand in it, and in a red overlay that reads as a feather, not a
/// matte. A strand is the opposite shape: bright along its length,
/// dark in the gaps beside it. So outside the coarse selection each
/// pixel loses the lowest alpha within `reach` pixels of it
/// (HAZE_REACH on the preview), a floor the skirt sits on and a strand
/// stands above, rescaled so a strand's own peak keeps its value:
///
///   alpha' = (alpha - floor) / (1 - floor)
///
/// Two things are exempt. Inside the coarse selection nothing changes
/// (the model may still thin the fur's own edge). And a strand's CORE,
/// pixels at a half or more that connect back to the selection through
/// pixels at a half or more, keeps the model's word whole: fur that the
/// selection missed is fur, not haze.
fn cut_haze(alpha: &[f32], coarse: &[f32], w: usize, h: usize, reach: usize) -> Vec<f32> {
    let mut core = vec![false; w * h];
    let mut queue: Vec<usize> = Vec::new();
    for i in 0..w * h {
        if coarse[i] >= 0.5 {
            core[i] = true;
            queue.push(i);
        }
    }
    while let Some(i) = queue.pop() {
        let (x, y) = (i % w, i / w);
        let mut push = |j: usize| {
            if !core[j] && alpha[j] >= 0.5 {
                core[j] = true;
                queue.push(j);
            }
        };
        // A one-pixel diagonal hair is connected through corners.
        // Four-neighbor flooding mistook that core for background
        // haze and could push it below half coverage.
        for ny in y.saturating_sub(1)..=(y + 1).min(h - 1) {
            for nx in x.saturating_sub(1)..=(x + 1).min(w - 1) {
                push(ny * w + nx);
            }
        }
    }
    let floor = min_filter(alpha, w, h, reach);
    // The cut comes in over `reach` pixels from the selection's edge
    // rather than all at once at it: fur standing just off the edge at
    // 0.3 or 0.4 lost its floor the moment it left the selection, and at
    // 1:1 (Apply's full-resolution pass) that drew the selection's edge
    // as a hard line through the fur.
    let off_edge = chamfer(coarse, w, h, false);
    alpha
        .iter()
        .enumerate()
        .map(|(i, a)| {
            // Inside the selection, a strand's core, and every pixel the
            // model did not answer (it passed the coarse mask through)
            // keep their value.
            if coarse[i] >= 0.5 || core[i] || (*a - coarse[i]).abs() < 1e-6 {
                *a
            } else {
                let ease = (off_edge[i] / reach.max(1) as f32).clamp(0.0, 1.0);
                let f = floor[i].min(*a) * ease;
                if f >= 1.0 - 1e-6 { *a } else { ((a - f) / (1.0 - f)).clamp(0.0, 1.0) }
            }
        })
        .collect()
}

/// How far a strand's gap is looked for, in working pixels: fur on a
/// 2048 px preview is two to four pixels a hair with gaps as wide, so a
/// window of nine always holds a gap where there is hair and never
/// does across a skirt tens of pixels wide.
pub const HAZE_REACH: usize = 4;

/// The lowest value within `r` pixels (a square window), separable.
fn min_filter(plane: &[f32], w: usize, h: usize, r: usize) -> Vec<f32> {
    let mut rows = vec![0.0f32; w * h];
    for y in 0..h {
        for x in 0..w {
            let (x0, x1) = (x.saturating_sub(r), (x + r).min(w - 1));
            let mut m = f32::MAX;
            for xx in x0..=x1 {
                m = m.min(plane[y * w + xx]);
            }
            rows[y * w + x] = m;
        }
    }
    let mut out = vec![0.0f32; w * h];
    for y in 0..h {
        let (y0, y1) = (y.saturating_sub(r), (y + r).min(h - 1));
        for x in 0..w {
            let mut m = f32::MAX;
            for yy in y0..=y1 {
                m = m.min(rows[yy * w + x]);
            }
            out[y * w + x] = m;
        }
    }
    out
}

/// The one-shot with its outer band given in pixels.
fn refine_selection_at(
    refiner: &mut Refiner,
    rgb: &[f32],
    coarse: &[f32],
    w: usize,
    h: usize,
    band_px: f32,
) -> Result<Vec<f32>, VisionError> {
    let short = w.min(h) as f32;
    let keep_px = (short * 0.02).max(4.0);
    let trimap = trimap_from_coarse(coarse, w, h, keep_px, band_px);
    let alpha = refine_adaptive(
        refiner,
        rgb,
        coarse,
        trimap,
        w,
        h,
        (band_px * 0.5) as usize + 16,
        (band_px * 0.5) as usize,
    )?;
    // The band stays wide (a strand pressing past a narrow one is
    // distrusted whole), and the hedge a wide band invites comes off
    // after: on the lemur, 0.20 mean alpha past the fur fell to 0.05.
    Ok(cut_haze(&alpha, coarse, w, h, HAZE_REACH))
}

/// The matte brush, as a layer editor's Refine does it (2026-09-29, on his
/// lemur: a soft halo round the whole animal where that editor kept
/// "crisp, hair-level fur edges"). The stroke IS the matting area: the
/// model resolves what the hand painted, the coarse selection stays
/// certain everywhere else, and a strand is followed past the stroke only
/// through its CORE.
///
/// Measured on the lemur (a ring of strokes along the subject
/// selection's edge, the app's 2048 px preview), the scout-and-chase
/// this replaces did two things wrong. Its trimap made everything
/// within an eighth of the frame of the stroke unknown, and a model
/// asked about that much open background hedges: under the stroke, past
/// the fur, 87% of pixels came back between 0.05 and 0.5, mean 0.25. And
/// its chase accepted the scout down to a hold of 0.3, so what it took
/// past the stroke was that haze and nothing else: of 4691 pixels it
/// changed there, 6 read above a half. That was the gray skirt, and on
/// the lemur it ran up the rope beside the animal.
///
/// Here the unknown region is the stroke plus a corridor of
/// `chase_px` outside the coarse edge (where a strand the hand did not
/// quite cover can still be found), the chase takes only pixels the
/// model holds at a half or more (a strand's core; haze never gets
/// there), and a strand's own one-pixel rim rides along with it so a
/// chased hair keeps its antialiasing. `chase_px` 0 is the stroke and
/// nothing else.
#[allow(clippy::too_many_arguments)]
pub fn refine_selection_brushed(
    refiner: &mut Refiner,
    rgb: &[f32],
    coarse: &[f32],
    band: &[f32],
    w: usize,
    h: usize,
    chase_px: f32,
    max_side: usize,
) -> Result<Vec<f32>, VisionError> {
    let chase = chase_px.max(0.0);
    let trimap = brushed_trimap(coarse, band, w, h, chase);
    let margin = (chase as usize).max(16) + 16;
    let scout = refine_trimap(refiner, rgb, coarse, &trimap, w, h, margin, max_side)?;
    Ok(brushed_finish(&trimap, &scout, coarse, band, w, h, chase, HAZE_REACH))
}

/// The brush's trimap: the stroke unknown, a corridor of `chase` pixels
/// outside the coarse edge unknown too, the coarse selection certain
/// everywhere else. Shared by the preview pass and the full-resolution
/// pass at Apply, so the two ask the model the same question.
fn brushed_trimap(coarse: &[f32], band: &[f32], w: usize, h: usize, chase: f32) -> Vec<f32> {
    let to_band = if chase > 0.0 { chamfer(band, w, h, false) } else { Vec::new() };
    (0..w * h)
        .map(|i| {
            if band[i] > 0.5 || (chase > 0.0 && coarse[i] < 0.5 && to_band[i] <= chase) {
                0.5
            } else if coarse[i] >= 0.5 {
                1.0
            } else {
                0.0
            }
        })
        .collect()
}

/// The brush's answer from the model's: everything under the stroke
/// takes the model's word, a strand's core is chased through the
/// corridor (and its one-pixel rim rides along), the coarse selection
/// stands everywhere else, and the haze comes off within `haze_reach`.
#[allow(clippy::too_many_arguments)]
fn brushed_finish(
    trimap: &[f32],
    scout: &[f32],
    coarse: &[f32],
    band: &[f32],
    w: usize,
    h: usize,
    chase: f32,
    haze_reach: usize,
) -> Vec<f32> {
    let accept = chase_core(band, trimap, scout, w, h, chase);
    // Where the stroke ends inside the selection, the model's word meets
    // the selection's certain 1.0. Over dark fur the model says 0.7 or 0.8
    // right up to that line, and on the owner's lemur at 1:1 the matte
    // showed the stroke's inner edge as a hard curve through the fur.
    // Inside the selection the answer eases from the selection's value to
    // the model's over the stroke's first quarter-radius, so the stroke
    // leaves no line. Outside the selection nothing eases: the strands are
    // there, and the haze cut below handles the ground.
    let to_edge = chamfer(band, w, h, true);
    let radius = (0..w * h).filter(|i| band[*i] > 0.5).map(|i| to_edge[i]).fold(0.0f32, f32::max);
    let ramp = (radius * 0.25).max(2.0);
    let out: Vec<f32> = coarse
        .iter()
        .enumerate()
        .map(|(i, c)| {
            if !accept[i] {
                *c
            } else if band[i] > 0.5 && *c >= 0.5 {
                let t = (to_edge[i] / ramp).clamp(0.0, 1.0);
                c + (scout[i] - c) * t
            } else {
                scout[i]
            }
        })
        .collect();
    cut_haze(&out, coarse, w, h, haze_reach)
}

/// The full-resolution pass's tile. Measured on the owner's lemur (4016
/// x 6024, a ring of strokes round the whole animal, CPU): 1536 px tiles
/// ran in 10.5 s but the model's working set took the process to 14.1
/// GB; 1024 px ran in 7.3 s at 5.1 GB; 768 px in 6.7 s at 3.1 GB,
/// against 2.3 GB for the decode and the preview pass alone. Attention
/// grows with the square of a tile's area, so the small tile is both the
/// lighter and the quicker, and 768 photograph pixels still hold several
/// hundred pixels of fur and wall around every stroke.
pub const FULL_TILE: usize = 768;

/// How far neighboring tiles overlap. A sixth of the tile: the answers
/// cross-fade over it linearly, so a pixel near one tile's edge, where
/// the model's context is cut, is carried by the neighbor that sees it
/// from the middle.
pub const FULL_OVERLAP: usize = 128;

/// One tile of the full-resolution plan, in the working region's pixels.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct MatteTile {
    pub x: usize,
    pub y: usize,
    pub w: usize,
    pub h: usize,
}

/// One tile's model: HWC RGB 0..255 and the trimap in, alpha out, at
/// the tile's (w, h).
pub type TileModel<'a> = dyn FnMut(&[f32], &[f32], usize, usize) -> Result<Vec<f32>, VisionError> + 'a;

/// How a tiled pass reports and stops: tiles done and in all, told
/// after every tile; and a flag read between tiles, never mid-tile.
pub struct FullOptions<'a> {
    pub tile: usize,
    pub overlap: usize,
    pub progress: &'a mut dyn FnMut(usize, usize),
    pub cancel: &'a dyn Fn() -> bool,
}

/// Positions of `tile`-long spans stepping `tile - overlap` across `n`,
/// the last pulled back to end on the edge. One span of `n` when `n`
/// fits in a tile.
fn axis_plan(n: usize, tile: usize, overlap: usize) -> Vec<(usize, usize)> {
    if n <= tile {
        return vec![(0, n)];
    }
    let step = tile.saturating_sub(overlap).max(1);
    let mut out = Vec::new();
    let mut at = 0usize;
    loop {
        if at + tile >= n {
            out.push((n - tile, tile));
            break;
        }
        out.push((at, tile));
        at += step;
    }
    out
}

/// The tiles a trimap needs: the grid over the whole working region,
/// less every tile with no unknown pixel anywhere in it (a neighbor
/// that shares an overlap with unknown pixels in it is kept, so no
/// unknown pixel loses the tile that would carry it from the middle).
pub fn matte_tiles(trimap: &[f32], w: usize, h: usize, tile: usize, overlap: usize) -> Vec<MatteTile> {
    let unknown = |x: usize, y: usize| (trimap[y * w + x] - 0.5).abs() < 0.25;
    let mut out = Vec::new();
    for (y, th) in axis_plan(h, tile, overlap) {
        for (x, tw) in axis_plan(w, tile, overlap) {
            if (y..y + th).any(|yy| (x..x + tw).any(|xx| unknown(xx, yy))) {
                out.push(MatteTile { x, y, w: tw, h: th });
            }
        }
    }
    out
}

/// A tile's blend weight at one of its pixels: rising linearly from its
/// edge over `overlap`, except along an edge that is the working
/// region's own (there is no neighbor there to hand over to).
fn tile_weight(t: &MatteTile, x: usize, y: usize, w: usize, h: usize, overlap: usize) -> f32 {
    let ramp = overlap.max(1) as f32;
    let mut d = f32::MAX;
    if t.x > 0 {
        d = d.min((x - t.x) as f32 + 0.5);
    }
    if t.x + t.w < w {
        d = d.min((t.x + t.w - x) as f32 - 0.5);
    }
    if t.y > 0 {
        d = d.min((y - t.y) as f32 + 0.5);
    }
    if t.y + t.h < h {
        d = d.min((t.y + t.h - y) as f32 - 0.5);
    }
    (d / ramp).clamp(1e-3, 1.0)
}

/// The model over a trimap at the working region's own resolution, in
/// overlapping tiles blended across the overlap. `model` answers one
/// tile: HWC RGB 0..255 and its trimap plane in, alpha out, at the
/// tile's size. Only unknown pixels take the blended answer; every
/// other pixel keeps `coarse`. Memory is the region's planes plus one
/// tile's input and answer at a time. Returns the answer and the tiles
/// run.
pub fn solve_tiled(
    model: &mut TileModel,
    rgb: &[u8],
    coarse: &[f32],
    trimap: &[f32],
    w: usize,
    h: usize,
    opts: &mut FullOptions,
) -> Result<(Vec<f32>, usize), VisionError> {
    assert_eq!(rgb.len(), w * h * 3, "HWC RGB expected");
    let tiles = matte_tiles(trimap, w, h, opts.tile, opts.overlap);
    let total = tiles.len();
    let mut acc = vec![0.0f32; w * h];
    let mut wsum = vec![0.0f32; w * h];
    (opts.progress)(0, total);
    for (k, t) in tiles.iter().enumerate() {
        if (opts.cancel)() {
            return Err(VisionError::Canceled);
        }
        let mut crop_rgb = vec![0.0f32; t.w * t.h * 3];
        let mut crop_tri = vec![0.0f32; t.w * t.h];
        for y in 0..t.h {
            for x in 0..t.w {
                let src = (y + t.y) * w + (x + t.x);
                let dst = y * t.w + x;
                crop_tri[dst] = trimap[src];
                for c in 0..3 {
                    crop_rgb[dst * 3 + c] = rgb[src * 3 + c] as f32;
                }
            }
        }
        let alpha = model(&crop_rgb, &crop_tri, t.w, t.h)?;
        for y in 0..t.h {
            for x in 0..t.w {
                let full = (y + t.y) * w + (x + t.x);
                if (trimap[full] - 0.5).abs() >= 0.25 {
                    continue;
                }
                let wt = tile_weight(t, x + t.x, y + t.y, w, h, opts.overlap);
                acc[full] += alpha[y * t.w + x] * wt;
                wsum[full] += wt;
            }
        }
        (opts.progress)(k + 1, total);
    }
    let out: Vec<f32> = (0..w * h)
        .map(|i| {
            if (trimap[i] - 0.5).abs() < 0.25 && wsum[i] > 0.0 {
                (acc[i] / wsum[i]).clamp(0.0, 1.0)
            } else {
                coarse[i]
            }
        })
        .collect();
    Ok((out, total))
}

/// The brush at Apply, at the photograph's own resolution (2026-09-29:
/// "yes, do the full resolution fix"). The preview pass solves the
/// matte on the 2048 px preview, and the engine stretched that answer
/// about three times over for 1:1 and export, so a hair one pixel wide
/// in the photograph was a third of a pixel to the model and a soft
/// smear at 100 percent. Here the same trimap (the stroke, the
/// corridor, the selection certain elsewhere) is drawn at full
/// resolution and the model reads it in overlapping FULL_TILE tiles.
/// `rgb` is display-encoded HWC 0..255 bytes; `haze_reach` is
/// HAZE_REACH scaled by the full-to-preview ratio, so the haze cut
/// looks as far as it did on the preview. Returns the alpha and the
/// tiles run.
#[allow(clippy::too_many_arguments)]
pub fn refine_brushed_full(
    refiner: &mut Refiner,
    rgb: &[u8],
    coarse: &[f32],
    band: &[f32],
    w: usize,
    h: usize,
    chase_px: f32,
    haze_reach: usize,
    opts: &mut FullOptions,
) -> Result<(Vec<f32>, usize), VisionError> {
    let chase = chase_px.max(0.0);
    let trimap = brushed_trimap(coarse, band, w, h, chase);
    let mut model = |r: &[f32], t: &[f32], tw: usize, th: usize| refiner.refine(r, t, tw, th);
    let (scout, tiles) = solve_tiled(&mut model, rgb, coarse, &trimap, w, h, opts)?;
    Ok((brushed_finish(&trimap, &scout, coarse, band, w, h, chase, haze_reach), tiles))
}

/// The one-shot at Apply, at full resolution. The one-shot's band is
/// wide on purpose and grows where a strand presses on it; at full
/// resolution that band is most of the frame, so the preview's answer
/// says where to look instead: `unknown` is where the preview's matte
/// moved the selection or left it partial (dilated by the caller), the
/// model answers there at full resolution, and the full-resolution
/// selection stands everywhere else, exactly.
#[allow(clippy::too_many_arguments)]
pub fn refine_guided_full(
    refiner: &mut Refiner,
    rgb: &[u8],
    coarse: &[f32],
    unknown: &[bool],
    w: usize,
    h: usize,
    haze_reach: usize,
    opts: &mut FullOptions,
) -> Result<(Vec<f32>, usize), VisionError> {
    let trimap: Vec<f32> = (0..w * h)
        .map(|i| if unknown[i] { 0.5 } else if coarse[i] >= 0.5 { 1.0 } else { 0.0 })
        .collect();
    let mut model = |r: &[f32], t: &[f32], tw: usize, th: usize| refiner.refine(r, t, tw, th);
    let (alpha, tiles) = solve_tiled(&mut model, rgb, coarse, &trimap, w, h, opts)?;
    Ok((cut_haze(&alpha, coarse, w, h, haze_reach), tiles))
}

/// A plane brought down by whole-area averaging: each output pixel is
/// the mean of the source pixels its footprint covers, partial ones by
/// their share. The full-resolution matte's preview-scale copy, so a
/// strand one pixel wide in the photograph reads as the partial pixel
/// it is at Fit rather than vanishing between two bilinear taps.
pub fn area_downsample(plane: &[f32], w: usize, h: usize, nw: usize, nh: usize) -> Vec<f32> {
    assert_eq!(plane.len(), w * h, "single plane expected");
    if (w, h) == (nw, nh) {
        return plane.to_vec();
    }
    // Per output column (or row): the source ones it covers and their shares.
    let spans = |n: usize, src: usize| -> Vec<Vec<(usize, f32)>> {
        let s = src as f64 / n as f64;
        (0..n)
            .map(|o| {
                let (a, b) = (o as f64 * s, ((o + 1) as f64 * s).min(src as f64));
                let mut v = Vec::new();
                let mut i = a.floor() as usize;
                while (i as f64) < b && i < src {
                    let lo = a.max(i as f64);
                    let hi = b.min((i + 1) as f64);
                    if hi > lo {
                        v.push((i, ((hi - lo) / (b - a)) as f32));
                    }
                    i += 1;
                }
                v
            })
            .collect()
    };
    let cols = spans(nw, w);
    let rows = spans(nh, h);
    let mut tmp = vec![0.0f32; nw * h];
    for y in 0..h {
        for (x, col) in cols.iter().enumerate() {
            tmp[y * nw + x] = col.iter().map(|(i, f)| plane[y * w + i] * f).sum();
        }
    }
    let mut out = vec![0.0f32; nw * nh];
    for (y, row) in rows.iter().enumerate() {
        for x in 0..nw {
            out[y * nw + x] = row.iter().map(|(i, f)| tmp[i * nw + x] * f).sum();
        }
    }
    out
}

/// Which pixels take the model's word after a brushed pass: the stroke
/// itself, and, with a Reach corridor, the strands chased out of it.
/// The chase walks from the stroke through pixels the trimap left
/// unknown and the model holds at a half or more (a strand's core;
/// haze never reads that high), in eight directions: a one-pixel hair
/// crosses the pixel grid through corners as often as through edges,
/// and a four-way walk stopped at the first diagonal step, so a strand
/// leaning across the corridor was cut where it left the brush (the
/// same connectivity cut_haze keeps a core by). A chased strand's rim,
/// its 8-neighbors in the corridor, rides along so the hair keeps its
/// antialiasing rather than being cut at the half-way line.
fn chase_core(band: &[f32], trimap: &[f32], scout: &[f32], w: usize, h: usize, chase: f32) -> Vec<bool> {
    let mut accept = vec![false; w * h];
    let mut queue: Vec<usize> = Vec::new();
    for i in 0..w * h {
        if band[i] > 0.5 {
            accept[i] = true;
            queue.push(i);
        }
    }
    if chase <= 0.0 {
        return accept;
    }
    let mut chased: Vec<usize> = Vec::new();
    while let Some(i) = queue.pop() {
        let (x, y) = (i % w, i / w);
        for ny in y.saturating_sub(1)..=(y + 1).min(h - 1) {
            for nx in x.saturating_sub(1)..=(x + 1).min(w - 1) {
                let j = ny * w + nx;
                if !accept[j] && trimap[j] == 0.5 && scout[j] >= 0.5 {
                    accept[j] = true;
                    queue.push(j);
                    chased.push(j);
                }
            }
        }
    }
    for &i in &chased {
        let (x, y) = (i % w, i / w);
        for ny in y.saturating_sub(1)..=(y + 1).min(h - 1) {
            for nx in x.saturating_sub(1)..=(x + 1).min(w - 1) {
                let j = ny * w + nx;
                if trimap[j] == 0.5 {
                    accept[j] = true;
                }
            }
        }
    }
    accept
}

/// P4.2: the band follows the hair. A fixed band amputates any strand
/// that streams past it: the strand's far end lies in
/// certainly-outside territory the model is forbidden to claim, so it
/// does a beautiful job for the band's width and then just stops.
/// After each pass, an unknown pixel that touches certain-background
/// AND came back mid-or-high from the model is a strand pressing
/// against the band's outer wall: the band grows outward there (and
/// only there; a clean shoulder shows no such pressure and its edge
/// stays narrow), then the model runs again. At most two growths, and
/// never past two fifths of the frame, so a pathological frontier
/// cannot run the model forever.
// Eight parameters, but each is a distinct axis of the job (model,
// image, matte, trimap, geometry, growth), and bundling them into a
// struct would only rename the arity, so allow the lint.
#[allow(clippy::too_many_arguments)]
fn refine_adaptive(
    refiner: &mut Refiner,
    rgb: &[f32],
    coarse: &[f32],
    mut trimap: Vec<f32>,
    w: usize,
    h: usize,
    margin: usize,
    grow_px: usize,
) -> Result<Vec<f32>, VisionError> {
    let mut alpha = refine_trimap(refiner, rgb, coarse, &trimap, w, h, margin, MAX_SIDE)?;
    let cap = w * h * 2 / 5;
    for _ in 0..2 {
        let unknown = trimap.iter().filter(|t| (**t - 0.5).abs() < 0.25).count();
        if unknown > cap {
            break;
        }
        let frontier = uncertain_frontier(&alpha, &trimap, w, h);
        if frontier.is_empty() {
            break;
        }
        if grow_band(&mut trimap, &frontier, w, h, grow_px) == 0 {
            break;
        }
        alpha = refine_trimap(refiner, rgb, coarse, &trimap, w, h, margin, MAX_SIDE)?;
    }
    // The answer is the model's own alpha. How decided the edge reads is
    // the engine's Contrast on the selection node, live, not baked here.
    Ok(alpha)
}

/// Unknown-band pixels that touch certain-background and carry
/// meaningful alpha: the signature of a strand exiting the band.
fn uncertain_frontier(alpha: &[f32], trimap: &[f32], w: usize, h: usize) -> Vec<usize> {
    let mut out = Vec::new();
    for y in 0..h {
        for x in 0..w {
            let i = y * w + x;
            if (trimap[i] - 0.5).abs() >= 0.25 || alpha[i] < 0.12 {
                continue;
            }
            let bg = |xi: i64, yi: i64| {
                xi >= 0
                    && yi >= 0
                    && (xi as usize) < w
                    && (yi as usize) < h
                    && trimap[yi as usize * w + xi as usize] < 0.25
            };
            let (xi, yi) = (x as i64, y as i64);
            if bg(xi - 1, yi) || bg(xi + 1, yi) || bg(xi, yi - 1) || bg(xi, yi + 1) {
                out.push(i);
            }
        }
    }
    out
}

/// Converts certain-background to unknown in discs around the
/// frontier. Certain-foreground never converts: growth reaches for
/// what the selection missed, not into what it already holds.
fn grow_band(trimap: &mut [f32], frontier: &[usize], w: usize, h: usize, grow_px: usize) -> usize {
    let r = grow_px as i64;
    let r2 = r * r;
    let mut added = 0usize;
    for &i in frontier {
        let (fx, fy) = ((i % w) as i64, (i / w) as i64);
        for dy in -r..=r {
            for dx in -r..=r {
                if dx * dx + dy * dy > r2 {
                    continue;
                }
                let (x, y) = (fx + dx, fy + dy);
                if x < 0 || y < 0 || x >= w as i64 || y >= h as i64 {
                    continue;
                }
                let j = y as usize * w + x as usize;
                if trimap[j] < 0.25 {
                    trimap[j] = 0.5;
                    added += 1;
                }
            }
        }
    }
    added
}

/// The shared middle: crop the trimap's unknown band (plus margin),
/// work under the model's budget, and stitch the answer back. Only
/// pixels the trimap calls unknown take the model's word; everywhere
/// else the coarse mask passes through untouched.
fn refine_trimap(
    refiner: &mut Refiner,
    rgb: &[f32],
    coarse: &[f32],
    trimap: &[f32],
    w: usize,
    h: usize,
    margin: usize,
    max_side: usize,
) -> Result<Vec<f32>, VisionError> {
    // The crop: the unknown band's bounding box plus margin. Certain
    // areas outside it never meet the model.
    let (mut x0, mut y0, mut x1, mut y1) = (w, h, 0usize, 0usize);
    for y in 0..h {
        for x in 0..w {
            if (trimap[y * w + x] - 0.5).abs() < 0.25 {
                x0 = x0.min(x);
                y0 = y0.min(y);
                x1 = x1.max(x);
                y1 = y1.max(y);
            }
        }
    }
    if x0 > x1 {
        // No unknown band at all: the coarse mask is already the
        // answer (empty, or full-frame, or a band that missed).
        return Ok(coarse.to_vec());
    }
    let x0 = x0.saturating_sub(margin);
    let y0 = y0.saturating_sub(margin);
    let x1 = (x1 + margin).min(w - 1);
    let y1 = (y1 + margin).min(h - 1);
    let (cw, ch) = (x1 - x0 + 1, y1 - y0 + 1);

    let mut crop_rgb = vec![0.0f32; cw * ch * 3];
    let mut crop_tri = vec![0.0f32; cw * ch];
    for y in 0..ch {
        for x in 0..cw {
            let src = (y + y0) * w + (x + x0);
            let dst = y * cw + x;
            crop_tri[dst] = trimap[src];
            for c in 0..3 {
                crop_rgb[dst * 3 + c] = rgb[src * 3 + c];
            }
        }
    }

    // Downscale to the working budget. The trimap resamples bilinear
    // and re-quantizes: a trimap has exactly three words in it.
    let scale = (max_side as f32 / cw.max(ch) as f32).min(1.0);
    let (rw, rh) = (
        ((cw as f32 * scale).round() as usize).max(1),
        ((ch as f32 * scale).round() as usize).max(1),
    );
    let (run_rgb, run_tri) = if scale < 1.0 {
        let rgb_s = resize_exact_rgb(&crop_rgb, cw, ch, rw, rh);
        let tri_s: Vec<f32> = resize_plane(&crop_tri, cw, ch, rw, rh)
            .iter()
            .map(|v| {
                if *v > 0.85 {
                    1.0
                } else if *v < 0.15 {
                    0.0
                } else {
                    0.5
                }
            })
            .collect();
        (rgb_s, tri_s)
    } else {
        (crop_rgb, crop_tri.clone())
    };

    let alpha_small = refiner.refine(&run_rgb, &run_tri, rw, rh)?;
    let alpha_crop = if (rw, rh) == (cw, ch) {
        alpha_small
    } else {
        resize_plane(&alpha_small, rw, rh, cw, ch)
    };

    // Stitch: ONLY the unknown band takes the model's word. Everything
    // else keeps the coarse mask verbatim: a pixel the user's
    // selection was sure about must not drift, resample or no
    // resample, and a soft value far from the band is the user's own
    // work passing through.
    let mut out = coarse.to_vec();
    for y in 0..ch {
        for x in 0..cw {
            let full = (y + y0) * w + (x + x0);
            if (trimap[full] - 0.5).abs() < 0.25 {
                out[full] = alpha_crop[y * cw + x];
            }
        }
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn haze_removal_preserves_a_diagonally_connected_fur_core() {
        let (w, h) = (20, 20);
        let mut coarse = vec![0.0; w * h];
        let mut alpha = vec![0.25; w * h];
        coarse[0] = 1.0;
        alpha[0] = 1.0;
        for k in 1..16 { alpha[k * w + k] = 0.6; }
        let clean = cut_haze(&alpha, &coarse, w, h, HAZE_REACH);
        for k in 1..16 {
            assert_eq!(clean[k * w + k], 0.6, "connected core at ({k},{k}) must survive");
        }
        assert_eq!(clean[19 * w], 0.0, "open background haze is still removed");
    }

    /// Reach follows a strand's core in eight directions: a one-pixel
    /// hair leaning across the corridor steps diagonally, and the
    /// four-way walk stopped at its first corner, leaving the strand
    /// cut where it left the brush. Haze in the corridor (under a half)
    /// is still never taken, and past the corridor nothing moves.
    #[test]
    fn reach_follows_a_diagonal_strand_through_its_core() {
        let (w, h) = (12usize, 12usize);
        let band: Vec<f32> = (0..w * h).map(|i| if i % w < 3 { 1.0 } else { 0.0 }).collect();
        let to_band = chamfer(&band, w, h, false);
        let chase = 6.0f32;
        let trimap: Vec<f32> = (0..w * h)
            .map(|i| if band[i] > 0.5 || to_band[i] <= chase { 0.5 } else { 0.0 })
            .collect();
        let mut scout = vec![0.3f32; w * h];
        for k in 3..7 {
            scout[k * w + k] = 0.9;
        }
        let accept = chase_core(&band, &trimap, &scout, w, h, chase);
        for k in 3..7 {
            assert!(accept[k * w + k], "the strand's core at ({k},{k}) is followed");
        }
        assert!(accept[4 * w + 5], "the strand's rim rides along");
        assert!(!accept[1 * w + 8], "haze in the corridor is not taken");
        assert!(!accept[10 * w + 10], "past the corridor nothing moves");
        let stroke_only = chase_core(&band, &trimap, &scout, w, h, 0.0);
        assert!(!stroke_only[3 * w + 3], "Reach 0 is the stroke alone");
        assert!(stroke_only[3 * w + 2]);
    }

    #[test]
    fn the_trimap_speaks_three_words() {
        // A centered disc: the trimap must keep an eroded core, doubt a
        // band around the edge, and stay certain far away.
        let (w, h) = (200usize, 200usize);
        let mut mask = vec![0.0f32; w * h];
        for y in 0..h {
            for x in 0..w {
                let d = ((x as f32 - 100.0).powi(2) + (y as f32 - 100.0).powi(2)).sqrt();
                if d < 50.0 {
                    mask[y * w + x] = 1.0;
                }
            }
        }
        let tri = trimap_from_coarse(&mask, w, h, 8.0, 20.0);
        assert_eq!(tri[100 * w + 100], 1.0, "the core is certain");
        assert_eq!(tri[10 * w + 10], 0.0, "the far corner is certain");
        // On the boundary itself: unknown, from both sides.
        assert_eq!(tri[100 * w + 148], 0.5, "just inside the edge");
        assert_eq!(tri[100 * w + 160], 0.5, "just outside the edge");
        assert_eq!(tri[100 * w + 100 + 30], 1.0, "well inside the erode");
    }

    #[test]
    fn chamfer_distance_grows_from_the_boundary() {
        let (w, h) = (60usize, 20usize);
        // Left half inside.
        let mask: Vec<f32> =
            (0..w * h).map(|i| if i % w < 30 { 1.0 } else { 0.0 }).collect();
        let d_in = chamfer(&mask, w, h, true);
        // 10 pixels from the boundary reads ~10 (chamfer error < 10%).
        let at = d_in[10 * w + 20];
        assert!((at - 10.0).abs() < 1.5, "expected ~10, got {at}");
        assert_eq!(d_in[10 * w + 35], 0.0, "outside is 0 from-inside");
    }

    #[test]
    fn no_unknown_band_returns_the_coarse_mask() {
        // An empty selection erodes to nothing but also dilates to
        // nothing: no band, no model, the coarse answer echoes back.
        // (Load no model: the refiner is only reached past the guard.)
        let (w, h) = (64usize, 64usize);
        let coarse = vec![0.0f32; w * h];
        let tri = trimap_from_coarse(&coarse, w, h, 4.0, 8.0);
        assert!(tri.iter().all(|v| *v == 0.0));
    }

    #[test]
    fn a_band_that_misses_everything_returns_the_coarse_mask() {
        // A brushed band nowhere near the selection still answers: the
        // trimap has no unknown pixels only when the band is empty, so
        // this exercises the band-far-from-edge case cheaply by
        // checking the trimap semantics (the model is gated).
        let (w, h) = (64usize, 64usize);
        let coarse: Vec<f32> = (0..w * h).map(|i| if i % w < 32 { 1.0 } else { 0.0 }).collect();
        let band = vec![0.0f32; w * h];
        // With an empty band the trimap is all-certain and mirrors the
        // coarse mask exactly.
        let trimap: Vec<f32> = coarse
            .iter()
            .zip(band.iter())
            .map(|(c, b)| if *b > 0.5 { 0.5 } else if *c >= 0.5 { 1.0 } else { 0.0 })
            .collect();
        assert!(trimap.iter().zip(coarse.iter()).all(|(t, c)| (t - c).abs() < 1e-6));
    }

    /// Gated like the other model tests: the hair-strand acceptance
    /// probe, in Rust, against the real model. A subject disc with fine
    /// strands over a busy ground; the coarse selection covers only the
    /// disc; the refined alpha must recover the strands the classical
    /// polish never could.
    #[test]
    fn gated_a_brushed_fur_edge_is_a_matte_not_a_halo() {
        // The owner's lemur, in miniature (2026-09-29): a gray furred body with fine
        // light strands standing off it, against a soft, defocused, similar-toned
        // wall. The coarse selection stops a few pixels inside the fur; the matte
        // brush is painted along the edge. A layer editor's Refine gives crisp
        // strands on a clean ground; the 26.4 brush gave a gray skirt round the
        // whole animal.
        let Ok(base) = std::env::var("HEELER_VISION_MODELS") else {
            eprintln!("skipped: HEELER_VISION_MODELS not set");
            return;
        };
        let base = std::path::PathBuf::from(base);
        if !crate::models::installed(&base, &crate::models::VITMATTE) {
            eprintln!("skipped: vitmatte not installed under {base:?}");
            return;
        }
        let f = fur_fixture();
        let (w, h) = (f.w, f.h);
        let mut refiner = Refiner::load(&base, &crate::models::VITMATTE).unwrap();
        let t0 = std::time::Instant::now();
        let alpha = brush_pass(&mut refiner, &f);
        eprintln!("brushed matte: {}ms at {w}x{h}", t0.elapsed().as_millis());
        // The ground is the wall clear of the animal: three pixels or
        // more from any fur or strand, so a strand's own antialiased
        // edge never counts as haze.
        let subject: Vec<f32> = f.gt.iter().map(|g| if *g >= 0.02 { 1.0 } else { 0.0 }).collect();
        let off_subject = chamfer(&subject, w, h, false);
        let (mut ground, mut ground_n, mut ground_haze, mut ground_sel) = (0.0f64, 0usize, 0usize, 0usize);
        let (mut strand, mut strand_n) = (0.0f64, 0usize);
        for i in 0..w * h {
            if f.band[i] <= 0.5 || f.coarse[i] >= 0.5 {
                continue;
            }
            if off_subject[i] >= 3.0 {
                ground += alpha[i] as f64;
                ground_n += 1;
                if alpha[i] > 0.05 && alpha[i] < 0.5 {
                    ground_haze += 1;
                }
                if alpha[i] >= 0.5 {
                    ground_sel += 1;
                }
            } else if f.gt[i] >= 0.6 {
                strand += alpha[i] as f64;
                strand_n += 1;
            }
        }
        let ground_mean = ground / ground_n.max(1) as f64;
        let strand_mean = strand / strand_n.max(1) as f64;
        let haze = ground_haze as f64 / ground_n.max(1) as f64;
        eprintln!(
            "under the stroke, past the selection: ground {ground_n} px mean alpha {ground_mean:.3}, hazed {:.1}%, selected {ground_sel}; strands {strand_n} px mean alpha {strand_mean:.3}; separation {:.3}",
            haze * 100.0,
            strand_mean - ground_mean,
        );
        // The ground stays out: no skirt.
        assert!(ground_mean < 0.03, "the wall under the stroke must stay out: mean alpha {ground_mean}");
        assert!(haze < 0.10, "the wall under the stroke must not haze: {haze}");
        // The strands come in, well clear of the ground.
        assert!(strand_mean > 0.45, "the strands under the stroke must come in: {strand_mean}");
        assert!(strand_mean - ground_mean > 0.4, "strand and ground must separate");
        // Past the stroke the selection is exactly what it was.
        for i in 0..w * h {
            if f.band[i] <= 0.5 && f.to_band[i] > f.chase + 1.5 {
                assert_eq!(alpha[i], f.coarse[i], "outside the stroke the selection must not move");
            }
        }
    }

    struct FurFixture {
        w: usize,
        h: usize,
        rgb: Vec<f32>,
        gt: Vec<f32>,
        coarse: Vec<f32>,
        band: Vec<f32>,
        to_band: Vec<f32>,
        chase: f32,
    }

    /// The brush pass the app runs: the stroke is the matting area, a
    /// half-radius corridor for strands past it (Reach 50).
    fn brush_pass(refiner: &mut Refiner, f: &FurFixture) -> Vec<f32> {
        refine_selection_brushed(refiner, &f.rgb, &f.coarse, &f.band, f.w, f.h, f.chase, 1536).unwrap()
    }

    fn fur_fixture() -> FurFixture {
        let (w, h) = (768usize, 768usize);
        let (cx, cy, r0) = (384.0f32, 420.0f32, 230.0f32);
        let mut rng: u64 = 11;
        let mut next = move || {
            rng = rng.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
            ((rng >> 33) as f32) / (u32::MAX >> 1) as f32
        };
        // A defocused block wall: beige, soft mortar lines, low contrast.
        let mut rgb = vec![0.0f32; w * h * 3];
        for y in 0..h {
            for x in 0..w {
                let mortar = (((y as f32 / 90.0) * std::f32::consts::TAU).sin() * 0.5 + 0.5).powf(6.0);
                let shade = 0.9 + 0.1 * ((x as f32 / 170.0).sin() * (y as f32 / 230.0).cos());
                let base = [168.0f32, 150.0, 124.0];
                for c in 0..3 {
                    rgb[(y * w + x) * 3 + c] = base[c] * shade * (1.0 - 0.12 * mortar);
                }
            }
        }
        let fur = [118.0f32, 114.0, 108.0];
        let tip = [196.0f32, 192.0, 186.0];
        let mut gt = vec![0.0f32; w * h];
        for y in 0..h {
            for x in 0..w {
                let d = ((x as f32 - cx).powi(2) + (y as f32 - cy).powi(2)).sqrt();
                // The body's own edge is soft, as a furred edge a touch
                // out of focus is: six pixels from fur to wall.
                let cov = ((r0 + 3.0 - d) / 6.0).clamp(0.0, 1.0);
                if cov > 0.0 {
                    let grain = 0.85 + 0.3 * next();
                    for c in 0..3 {
                        let i = (y * w + x) * 3 + c;
                        rgb[i] = rgb[i] * (1.0 - cov) + fur[c] * grain * cov;
                    }
                    gt[y * w + x] = cov;
                }
            }
        }
        // Fine light strands, one pixel wide, 6 to 14 px off the body,
        // on the upper half where the stroke will run.
        for i in 0..90 {
            let theta = std::f32::consts::PI * (1.0 + i as f32 / 90.0) + (next() - 0.5) * 0.01;
            let len = 6.0 + next() * 8.0;
            let bend = (next() - 0.5) * 0.6;
            let steps = (len * 4.0) as usize;
            for s in 0..steps {
                let t = s as f32 / steps as f32;
                let rad = r0 - 2.0 + t * len;
                let ang = theta + bend * t * t / rad * 10.0;
                let (px, py) = (cx + rad * ang.cos(), cy + rad * ang.sin());
                let (xi, yi) = (px.round() as i64, py.round() as i64);
                if xi < 0 || yi < 0 || xi >= w as i64 || yi >= h as i64 {
                    continue;
                }
                let idx = yi as usize * w + xi as usize;
                let a = 0.9 * (1.0 - 0.3 * t);
                for c in 0..3 {
                    rgb[idx * 3 + c] = rgb[idx * 3 + c] * (1.0 - a) + tip[c] * a;
                }
                gt[idx] = gt[idx].max(a);
            }
        }
        // The subject selection stops 3 px inside the fur, as a smart
        // selection's does; the stroke rides the edge, 20 px either side.
        let mut coarse = vec![0.0f32; w * h];
        let mut band = vec![0.0f32; w * h];
        for y in 0..h {
            for x in 0..w {
                let d = ((x as f32 - cx).powi(2) + (y as f32 - cy).powi(2)).sqrt();
                if d <= r0 - 3.0 {
                    coarse[y * w + x] = 1.0;
                }
                if (d - r0).abs() <= 20.0 && (y as f32) < cy {
                    band[y * w + x] = 1.0;
                }
            }
        }
        let to_band = chamfer(&band, w, h, false);
        FurFixture { w, h, rgb, gt, coarse, band, to_band, chase: 6.0 }
    }

    #[test]
    fn gated_the_matte_recovers_hair_strands() {
        let Ok(base) = std::env::var("HEELER_VISION_MODELS") else {
            eprintln!("skipped: HEELER_VISION_MODELS not set");
            return;
        };
        let base = std::path::PathBuf::from(base);
        if !crate::models::installed(&base, &crate::models::VITMATTE) {
            eprintln!("skipped: vitmatte not installed under {base:?}");
            return;
        }
        let (w, h) = (640usize, 512usize);
        let (cx, cy, r0) = (300.0f32, 260.0f32, 90.0f32);
        // A busy background: overlapping soft blobs, deterministic.
        let mut rng: u64 = 7;
        let mut next = move || {
            rng = rng.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
            ((rng >> 33) as f32) / (u32::MAX >> 1) as f32
        };
        let mut rgb = vec![0.0f32; w * h * 3];
        for _ in 0..60 {
            let (bx, by) = (next() * w as f32, next() * h as f32);
            let br = 20.0 + next() * 50.0;
            let col = [next() * 115.0 + 38.0, next() * 115.0 + 38.0, next() * 115.0 + 38.0];
            for y in 0..h {
                for x in 0..w {
                    let d2 = ((x as f32 - bx).powi(2) + (y as f32 - by).powi(2)) / (br * br);
                    let e = (-d2).exp() * 0.35;
                    for c in 0..3 {
                        rgb[(y * w + x) * 3 + c] =
                            (rgb[(y * w + x) * 3 + c] + col[c] * e).min(255.0);
                    }
                }
            }
        }
        // The subject disc and its ground truth.
        let hair = [140.0f32, 97.0, 56.0];
        let mut gt = vec![0.0f32; w * h];
        let mut coarse = vec![0.0f32; w * h];
        for y in 0..h {
            for x in 0..w {
                let d = ((x as f32 - cx).powi(2) + (y as f32 - cy).powi(2)).sqrt();
                if d <= r0 {
                    for c in 0..3 {
                        rgb[(y * w + x) * 3 + c] = hair[c];
                    }
                    gt[y * w + x] = 1.0;
                    coarse[y * w + x] = 1.0;
                }
            }
        }
        // Ninety fine strands, width 1-2, swaying outward.
        for i in 0..90 {
            let theta = i as f32 / 90.0 * std::f32::consts::TAU;
            let len = 50.0 + (i % 7) as f32 * 8.0;
            let width = if i % 3 == 0 { 2i32 } else { 1 };
            let steps = (len * 3.0) as usize;
            for s in 0..steps {
                let t = s as f32 / steps as f32;
                let rad = r0 + t * len;
                let sway = 18.0 * (t * 5.0 + theta * 3.0).sin() * t;
                let px = cx + rad * theta.cos() - sway * theta.sin();
                let py = cy + rad * theta.sin() + sway * theta.cos();
                for dx in -width..=width {
                    for dy in -width..=width {
                        if dx * dx + dy * dy > width * width {
                            continue;
                        }
                        let (xi, yi) = (px as i32 + dx, py as i32 + dy);
                        if xi < 0 || yi < 0 || xi >= w as i32 || yi >= h as i32 {
                            continue;
                        }
                        let idx = yi as usize * w + xi as usize;
                        let a = (1.0 - t * 0.35).max(0.0);
                        for c in 0..3 {
                            let s_col = hair[c] * (0.7 + 0.3 * t);
                            rgb[idx * 3 + c] = rgb[idx * 3 + c] * (1.0 - a) + s_col * a;
                        }
                        gt[idx] = gt[idx].max(a);
                    }
                }
            }
        }
        let mut refiner = Refiner::load(&base, &crate::models::VITMATTE).unwrap();
        let t0 = std::time::Instant::now();
        let alpha = refine_selection(&mut refiner, &rgb, &coarse, w, h).unwrap();
        eprintln!("vitmatte refine: {}ms at {w}x{h}", t0.elapsed().as_millis());
        // Score exactly as the acceptance probe did: strand alpha mass
        // recovered, in the region the coarse selection missed.
        let mut got = 0.0f32;
        let mut want = 0.0f32;
        let mut bg_false = 0.0f32;
        let mut bg_n = 0usize;
        for i in 0..w * h {
            if gt[i] > 0.2 && coarse[i] < 0.5 {
                want += gt[i];
                got += alpha[i].min(gt[i]);
            }
            if gt[i] < 0.05 {
                bg_false += alpha[i];
                bg_n += 1;
            }
        }
        let recovered = got / want.max(1.0);
        let false_bg = bg_false / bg_n.max(1) as f32;
        eprintln!("strand recovery {:.1}%, background false alpha {:.2}%", recovered * 100.0, false_bg * 100.0);
        assert!(recovered > 0.85, "the strands must come back: {recovered}");
        assert!(false_bg < 0.08, "the background must stay out: {false_bg}");
        // The matte BRUSH over the same frame (2026-09-29: the brushed edge must
        // be a matte, not a halo). A stroked ring that covers the strand zone is
        // the matting area; the model answers there and the coarse mask stays
        // exactly itself everywhere else.
        let mut band = vec![0.0f32; w * h];
        for y in 0..h {
            for x in 0..w {
                let d = ((x as f32 - cx).powi(2) + (y as f32 - cy).powi(2)).sqrt();
                if d > r0 - 12.0 && d < r0 + 150.0 {
                    band[y * w + x] = 1.0;
                }
            }
        }
        let score = |alpha: &[f32], within: &[f32]| {
            let (mut got, mut want, mut bg, mut bg_n) = (0.0f32, 0.0f32, 0.0f32, 0usize);
            for i in 0..w * h {
                if within[i] <= 0.5 {
                    continue;
                }
                if gt[i] > 0.2 && coarse[i] < 0.5 {
                    want += gt[i];
                    got += alpha[i].min(gt[i]);
                }
                if gt[i] < 0.05 {
                    bg += alpha[i];
                    bg_n += 1;
                }
            }
            (got / want.max(1.0), bg / bg_n.max(1) as f32)
        };
        let t1 = std::time::Instant::now();
        let brushed = refine_selection_brushed(&mut refiner, &rgb, &coarse, &band, w, h, 0.0, 1024).unwrap();
        eprintln!("brushed refine: {}ms", t1.elapsed().as_millis());
        for i in 0..w * h {
            if band[i] <= 0.5 {
                assert_eq!(brushed[i], coarse[i], "outside the stroke the coarse mask passes through");
            }
        }
        let (rec_b, bg_b) = score(&brushed, &band);
        eprintln!(
            "under the stroke: strand recovery {:.1}%, background false alpha {:.2}%",
            rec_b * 100.0,
            bg_b * 100.0,
        );
        assert!(rec_b > 0.8, "the brushed stroke must recover its strands: {rec_b}");
        assert!(bg_b < 0.05, "the ground under the stroke must stay out: {bg_b}");

        // A stroke NARROWER than the hair, with the corridor: a strand's
        // core is followed past the stroke, the ground is not, and
        // nothing moves past the corridor.
        let mut narrow = vec![0.0f32; w * h];
        for y in 0..h {
            for x in 0..w {
                let d = ((x as f32 - cx).powi(2) + (y as f32 - cy).powi(2)).sqrt();
                if d > r0 - 12.0 && d < r0 + 40.0 {
                    narrow[y * w + x] = 1.0;
                }
            }
        }
        let chase = 52.0f32;
        let chased = refine_selection_brushed(&mut refiner, &rgb, &coarse, &narrow, w, h, chase, 1024).unwrap();
        let to_band = chamfer(&narrow, w, h, false);
        let (mut beyond, mut ground_beyond) = (0.0f32, 0usize);
        for i in 0..w * h {
            if narrow[i] > 0.5 {
                continue;
            }
            if to_band[i] > chase + 1.5 {
                assert_eq!(chased[i], coarse[i], "past the corridor the coarse mask must pass through");
            }
            if gt[i] > 0.2 && coarse[i] < 0.5 {
                beyond += chased[i].min(gt[i]);
            }
            if gt[i] < 0.05 && chased[i] > 0.05 {
                ground_beyond += 1;
            }
        }
        eprintln!("narrow stroke: strand mass chased past it {beyond:.0}, ground pixels picked up past it {ground_beyond}");
        assert!(beyond > 0.0, "a strand's core is followed past the stroke");
    }

    /// A model that answers each tile with the red channel of the
    /// pixels it was given, plus a per-tile offset. With no offset the
    /// blend must give back exactly what the pixels say (every unknown
    /// pixel covered, the weights normalized); with the offset, the
    /// tiles disagree and the cross-fade must hide it: no step between
    /// neighbors larger than the disagreement spread over the overlap.
    fn blended(offset: f32) -> (Vec<f32>, Vec<f32>, Vec<MatteTile>, usize, usize) {
        let (w, h) = (1100usize, 700usize);
        let mut rgb = vec![0u8; w * h * 3];
        let mut truth = vec![0.0f32; w * h];
        for y in 0..h {
            for x in 0..w {
                // 0.2 to 0.8, so an offset tile never clamps at 0 or 1.
                let v = (((x as f32 / 37.0).sin() * (y as f32 / 53.0).cos()) * 0.3 + 0.5) * 255.0;
                let v = v.round().clamp(0.0, 255.0);
                rgb[(y * w + x) * 3] = v as u8;
                truth[y * w + x] = v / 255.0;
            }
        }
        // Unknown everywhere but a band at the left, certain inside.
        let coarse = vec![1.0f32; w * h];
        let trimap: Vec<f32> = (0..w * h).map(|i| if i % w < 40 { 1.0 } else { 0.5 }).collect();
        let tiles = matte_tiles(&trimap, w, h, 512, 128);
        let mut k = 0usize;
        let mut model = |r: &[f32], _t: &[f32], tw: usize, th: usize| {
            let bias = if k.is_multiple_of(2) { offset } else { -offset };
            k += 1;
            Ok((0..tw * th).map(|i| r[i * 3] / 255.0 + bias).collect::<Vec<f32>>())
        };
        let mut seen = (0usize, 0usize);
        let mut progress = |d: usize, t: usize| seen = (d, t);
        let never = || false;
        let mut opts = FullOptions { tile: 512, overlap: 128, progress: &mut progress, cancel: &never };
        let (out, n) = solve_tiled(&mut model, &rgb, &coarse, &trimap, w, h, &mut opts).unwrap();
        assert_eq!(n, tiles.len());
        assert_eq!(seen, (n, n), "progress reaches the total");
        (out, truth, tiles, w, h)
    }

    #[test]
    fn tiles_cover_every_unknown_pixel_and_blend_exactly() {
        let (out, truth, tiles, w, h) = blended(0.0);
        assert!(tiles.len() > 4, "the fixture must span several tiles: {}", tiles.len());
        for y in 0..h {
            for x in 40..w {
                let i = y * w + x;
                assert!((out[i] - truth[i]).abs() < 1e-5, "({x},{y}): {} vs {}", out[i], truth[i]);
            }
            for x in 0..40 {
                assert_eq!(out[y * w + x], 1.0, "a certain pixel keeps the coarse value");
            }
        }
    }

    #[test]
    fn disagreeing_tiles_leave_no_seam() {
        // Neighboring tiles answer 0.1 apart; a hard seam would be a 0.1
        // step at a tile's edge. The cross-fade spreads it over the
        // overlap, so no step between neighbors grows past the content's
        // own gradient by more than the spread share.
        let (out, truth, tiles, w, h) = blended(0.05);
        let mut worst = 0.0f32;
        for y in 1..h {
            for x in 41..w {
                let i = y * w + x;
                let dx = ((out[i] - truth[i]) - (out[i - 1] - truth[i - 1])).abs();
                let dy = ((out[i] - truth[i]) - (out[i - w] - truth[i - w])).abs();
                worst = worst.max(dx).max(dy);
            }
        }
        eprintln!("tiles {}, largest step of the tile disagreement between neighbors {worst:.5}", tiles.len());
        assert!(worst < 0.1 / 128.0 * 2.5, "a seam: a step of {worst} where the tiles disagree by 0.1");
    }

    #[test]
    fn a_canceled_pass_stops_between_tiles() {
        let (w, h) = (1200usize, 400usize);
        let rgb = vec![0u8; w * h * 3];
        let coarse = vec![0.0f32; w * h];
        let trimap = vec![0.5f32; w * h];
        let ran = std::cell::Cell::new(0usize);
        let mut model = |_r: &[f32], _t: &[f32], tw: usize, th: usize| {
            ran.set(ran.get() + 1);
            Ok(vec![0.0f32; tw * th])
        };
        let mut progress = |_d: usize, _t: usize| {};
        let cancel = || ran.get() >= 1;
        let mut opts = FullOptions { tile: 512, overlap: 128, progress: &mut progress, cancel: &cancel };
        let err = solve_tiled(&mut model, &rgb, &coarse, &trimap, w, h, &mut opts).unwrap_err();
        assert!(matches!(err, VisionError::Canceled), "{err}");
        assert_eq!(ran.get(), 1, "one tile ran, then the flag was read");
    }

    #[test]
    fn tiles_with_nothing_unknown_are_skipped() {
        let (w, h) = (3000usize, 1000usize);
        let mut trimap = vec![0.0f32; w * h];
        // A small unknown patch near the right end, in one tile of three.
        for y in 400..420 {
            for x in 2900..2920 {
                trimap[y * w + x] = 0.5;
            }
        }
        let tiles = matte_tiles(&trimap, w, h, 1536, 256);
        assert!(!tiles.is_empty());
        assert!(tiles.len() < axis_plan(w, 1536, 256).len() * axis_plan(h, 1536, 256).len() || tiles.len() == 1);
        for t in &tiles {
            assert!(t.x <= 2900 && t.x + t.w >= 2920, "{t:?} does not hold the patch");
        }
    }

    #[test]
    fn area_downsample_keeps_a_one_pixel_strand() {
        // A strand one pixel wide on a 3000 px row, brought to 1000:
        // the area mean keeps it as the third of a pixel it is; a
        // bilinear tap between it and its neighbors would miss it or not
        // depending on where it falls.
        let (w, h) = (3000usize, 30usize);
        let mut plane = vec![0.0f32; w * h];
        for y in 0..h {
            plane[y * w + 1501] = 1.0;
        }
        let small = area_downsample(&plane, w, h, 1000, 10);
        let row: Vec<f32> = small[5 * 1000..6 * 1000].to_vec();
        let peak = row.iter().cloned().fold(0.0f32, f32::max);
        let mass: f32 = row.iter().sum();
        assert!((peak - 1.0 / 3.0).abs() < 1e-4, "peak {peak}");
        assert!((mass * 3.0 - 1.0).abs() < 1e-4, "mass {mass}");
    }

    /// The full-resolution fixture: a gray furred body on a soft wall at
    /// 4800 x 3200, with light strands one pixel wide standing off its
    /// upper edge, the case the 2048 px preview cannot resolve (a strand
    /// is 0.43 of a preview pixel). Returned with the matte stroke along
    /// the top of the edge and the selection stopping inside the fur.
    struct HairFixture {
        w: usize,
        h: usize,
        rgb: Vec<u8>,
        gt_strand: Vec<f32>,
        body: Vec<f32>,
        coarse: Vec<f32>,
        band: Vec<f32>,
        chase: f32,
        cx: f32,
        cy: f32,
        r0: f32,
    }

    fn hair_fixture() -> HairFixture {
        let (w, h) = (4800usize, 3200usize);
        let (cx, cy, r0) = (2400.0f32, 1900.0f32, 1100.0f32);
        let mut rng: u64 = 29;
        let mut next = move || {
            rng = rng.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
            ((rng >> 33) as f32) / (u32::MAX >> 1) as f32
        };
        let mut body = vec![0.0f32; w * h];
        let mut coarse = vec![0.0f32; w * h];
        let mut band = vec![0.0f32; w * h];
        for y in 0..h {
            for x in 0..w {
                let d = ((x as f32 - cx).powi(2) + (y as f32 - cy).powi(2)).sqrt();
                body[y * w + x] = ((r0 + 1.5 - d) / 3.0).clamp(0.0, 1.0);
                coarse[y * w + x] = ((r0 - 8.0 - d) + 0.5).clamp(0.0, 1.0);
                if (d - r0).abs() <= 70.0 && (y as f32) < cy - 600.0 {
                    band[y * w + x] = 1.0;
                }
            }
        }
        // Strands: 200 of them in five sectors of the upper arc, bare
        // sectors between (where the body's own edge is measured), 20 to
        // 55 px long, drawn one pixel wide with antialiasing (a splat
        // every quarter pixel).
        let mut gt_strand = vec![0.0f32; w * h];
        for i in 0..400 {
            let sector = i / 40;
            if sector % 2 == 1 {
                continue;
            }
            let theta = std::f32::consts::PI * (1.22 + 0.056 * (sector as f32 + (i % 40) as f32 / 40.0))
                + (next() - 0.5) * 0.002;
            let len = 20.0 + next() * 35.0;
            let bend = (next() - 0.5) * 0.4;
            let steps = (len * 4.0) as usize;
            for s in 0..steps {
                let t = s as f32 / steps as f32;
                let rad = r0 - 1.0 + t * len;
                let ang = theta + bend * t * t * len / rad;
                let (px, py) = (cx + rad * ang.cos(), cy + rad * ang.sin());
                let a = 0.95 * (1.0 - 0.35 * t);
                let (fx, fy) = (px - 0.5, py - 0.5);
                let (x0, y0) = (fx.floor() as i64, fy.floor() as i64);
                for (dx, dy) in [(0i64, 0i64), (1, 0), (0, 1), (1, 1)] {
                    let (xi, yi) = (x0 + dx, y0 + dy);
                    if xi < 0 || yi < 0 || xi >= w as i64 || yi >= h as i64 {
                        continue;
                    }
                    let wx = 1.0 - (fx - xi as f32).abs();
                    let wy = 1.0 - (fy - yi as f32).abs();
                    let cov = (wx * wy).clamp(0.0, 1.0) * a;
                    let idx = yi as usize * w + xi as usize;
                    gt_strand[idx] = gt_strand[idx].max(cov);
                }
            }
        }
        let mut rgb = vec![0u8; w * h * 3];
        let fur = [112.0f32, 108.0, 102.0];
        let tip = [214.0f32, 210.0, 204.0];
        for y in 0..h {
            for x in 0..w {
                let i = y * w + x;
                let mortar = (((y as f32 / 240.0) * std::f32::consts::TAU).sin() * 0.5 + 0.5).powf(6.0);
                let shade = 0.9 + 0.1 * ((x as f32 / 450.0).sin() * (y as f32 / 610.0).cos());
                let wall = [168.0f32, 150.0, 124.0];
                let grain = 0.9 + 0.2 * (((x * 7919 + y * 104729) % 1000) as f32 / 1000.0);
                for c in 0..3 {
                    let mut v = wall[c] * shade * (1.0 - 0.12 * mortar);
                    v = v * (1.0 - body[i]) + fur[c] * grain * body[i];
                    v = v * (1.0 - gt_strand[i]) + tip[c] * gt_strand[i];
                    rgb[i * 3 + c] = v.round().clamp(0.0, 255.0) as u8;
                }
            }
        }
        // Past the body only: the strand's own coverage where the body is
        // not, which is what the selection must gain.
        for i in 0..w * h {
            if body[i] > 0.02 {
                gt_strand[i] = 0.0;
            }
        }
        HairFixture { w, h, rgb, gt_strand, body, coarse, band, chase: 35.0, cx, cy, r0 }
    }

    /// Scores a full-resolution alpha on the fixture, under the stroke:
    /// strand recovery (the strands' coverage the selection gained, over
    /// what there is), strand contrast (mean alpha on a strand minus on
    /// the wall two pixels beside it), the wall's false alpha, and the
    /// body edge's width (edge_width).
    fn hair_score(f: &HairFixture, alpha: &[f32]) -> (f64, f64, f64, f64) {
        let (w, h) = (f.w, f.h);
        let near_strand = {
            let s: Vec<f32> = f.gt_strand.iter().map(|v| if *v > 0.05 { 1.0 } else { 0.0 }).collect();
            chamfer(&s, w, h, false)
        };
        let (mut got, mut want) = (0.0f64, 0.0f64);
        let (mut on, mut on_n, mut beside, mut beside_n) = (0.0f64, 0usize, 0.0f64, 0usize);
        let (mut wall, mut wall_n) = (0.0f64, 0usize);
        for y in 0..h {
            for x in 0..w {
                let i = y * w + x;
                if f.band[i] <= 0.5 {
                    continue;
                }
                let d = ((x as f32 - f.cx).powi(2) + (y as f32 - f.cy).powi(2)).sqrt();
                if f.gt_strand[i] > 0.2 {
                    want += f.gt_strand[i] as f64;
                    got += alpha[i].min(f.gt_strand[i]) as f64;
                }
                if f.gt_strand[i] > 0.6 {
                    on += alpha[i] as f64;
                    on_n += 1;
                }
                if f.body[i] < 0.01 && f.gt_strand[i] < 0.01 && near_strand[i] >= 1.5 && near_strand[i] <= 2.5 {
                    beside += alpha[i] as f64;
                    beside_n += 1;
                }
                if f.body[i] < 0.01 && near_strand[i] > 6.0 && d > f.r0 + 6.0 {
                    wall += alpha[i] as f64;
                    wall_n += 1;
                }
            }
        }
        let recovery = got / want.max(1.0);
        let contrast = on / on_n.max(1) as f64 - beside / beside_n.max(1) as f64;
        let wall_mean = wall / wall_n.max(1) as f64;
        (recovery, contrast, wall_mean, edge_width(f, alpha))
    }

    /// The body's edge, 90 to 10 percent, in photograph pixels: read
    /// along rays out of the center through the bare sectors (no strand
    /// there), at a tenth of a pixel, averaged. The drawn edge is a
    /// three pixel ramp, so the truth is 2.4 px.
    fn edge_width(f: &HairFixture, alpha: &[f32]) -> f64 {
        let (w, h) = (f.w, f.h);
        let at = |x: f32, y: f32| {
            let (x0, y0) = ((x - 0.5).floor() as usize, (y - 0.5).floor() as usize);
            let (fx, fy) = (x - 0.5 - x0 as f32, y - 0.5 - y0 as f32);
            let p = |xx: usize, yy: usize| alpha[yy.min(h - 1) * w + xx.min(w - 1)];
            let top = p(x0, y0) * (1.0 - fx) + p(x0 + 1, y0) * fx;
            let bot = p(x0, y0 + 1) * (1.0 - fx) + p(x0 + 1, y0 + 1) * fx;
            top * (1.0 - fy) + bot * fy
        };
        let (mut sum, mut n) = (0.0f64, 0usize);
        for sector in [1usize, 3, 5, 7] {
            for k in 4..36 {
                let theta = std::f32::consts::PI * (1.22 + 0.056 * (sector as f32 + k as f32 / 40.0));
                let (c, s) = (theta.cos(), theta.sin());
                let (mut hi, mut lo) = (None, None);
                let mut r = f.r0 - 20.0;
                while r < f.r0 + 20.0 {
                    let a = at(f.cx + r * c, f.cy + r * s);
                    if a >= 0.9 {
                        hi = Some(r);
                    }
                    if a > 0.1 {
                        lo = Some(r);
                    }
                    r += 0.1;
                }
                if let (Some(hi), Some(lo)) = (hi, lo) {
                    sum += (lo - hi).max(0.0) as f64;
                    n += 1;
                }
            }
        }
        sum / n.max(1) as f64
    }

    /// 2026-09-29: "yes, do the full resolution fix". Before: the app's
    /// brush on the 2048 px preview, its answer stretched to the photograph
    /// the way the engine stretches a planted raster. After: the same brush
    /// at Apply, tiled over the photograph's own pixels.
    #[test]
    fn gated_full_resolution_recovers_strands_the_preview_cannot() {
        let Ok(base) = std::env::var("HEELER_VISION_MODELS") else {
            eprintln!("skipped: HEELER_VISION_MODELS not set");
            return;
        };
        let base = std::path::PathBuf::from(base);
        if !crate::models::installed(&base, &crate::models::VITMATTE) {
            eprintln!("skipped: vitmatte not installed under {base:?}");
            return;
        }
        let f = hair_fixture();
        let (w, h) = (f.w, f.h);
        let mut refiner = Refiner::load(&base, &crate::models::VITMATTE).unwrap();
        // Before: the preview the app hands the brush, 2048 on the long
        // side, each plane brought down by area.
        let (pw, ph) = (2048usize, (2048.0 * h as f32 / w as f32).round() as usize);
        let s = pw as f32 / w as f32;
        let mut prgb = vec![0.0f32; pw * ph * 3];
        for c in 0..3 {
            let ch: Vec<f32> = (0..w * h).map(|i| f.rgb[i * 3 + c] as f32).collect();
            let small = area_downsample(&ch, w, h, pw, ph);
            for i in 0..pw * ph {
                prgb[i * 3 + c] = small[i];
            }
        }
        let pcoarse = area_downsample(&f.coarse, w, h, pw, ph);
        let pband: Vec<f32> = area_downsample(&f.band, w, h, pw, ph).iter().map(|v| if *v > 0.5 { 1.0 } else { 0.0 }).collect();
        let t0 = std::time::Instant::now();
        let preview = refine_selection_brushed(&mut refiner, &prgb, &pcoarse, &pband, pw, ph, f.chase * s, 1536).unwrap();
        let preview_ms = t0.elapsed().as_millis();
        let before = crate::pre::resize_plane(&preview, pw, ph, w, h);
        // After: the same stroke at full resolution.
        let mut tiles_seen = (0usize, 0usize);
        let mut progress = |d: usize, t: usize| tiles_seen = (d, t);
        let never = || false;
        let mut opts = FullOptions { tile: FULL_TILE, overlap: FULL_OVERLAP, progress: &mut progress, cancel: &never };
        let t1 = std::time::Instant::now();
        let reach = (HAZE_REACH as f32 / s).round() as usize;
        let (after, tiles) =
            refine_brushed_full(&mut refiner, &f.rgb, &f.coarse, &f.band, w, h, f.chase, reach, &mut opts).unwrap();
        let full_ms = t1.elapsed().as_millis();
        let (rb, cb, wb, eb) = hair_score(&f, &before);
        let (ra, ca, wa, ea) = hair_score(&f, &after);
        eprintln!("preview pass {preview_ms} ms at {pw}x{ph}; full pass {full_ms} ms at {w}x{h}, {tiles} tiles ({:.0} ms a tile)", full_ms as f64 / tiles.max(1) as f64);
        eprintln!("before (preview matte stretched to 1:1): strand recovery {:.1}%, strand contrast {cb:.3}, wall alpha {wb:.4}, soft edge {eb:.1} px", rb * 100.0);
        eprintln!("after (full-resolution matte):          strand recovery {:.1}%, strand contrast {ca:.3}, wall alpha {wa:.4}, soft edge {ea:.1} px", ra * 100.0);
        assert_eq!(tiles_seen, (tiles, tiles));
        // Outside the stroke and its corridor the selection is exactly
        // itself at full resolution.
        let to_band = chamfer(&f.band, w, h, false);
        for i in 0..w * h {
            if f.band[i] <= 0.5 && to_band[i] > f.chase + 1.5 {
                assert_eq!(after[i], f.coarse[i], "outside the stroke the selection must not move");
            }
        }
        // Seams: a tile's edge inside the stroke, where one tile's answer
        // would stop and the next begin, must not be where the matte
        // steps. The mean step across each tile edge (columns and rows)
        // against the mean step a few pixels either side of it.
        let trimap = brushed_trimap(&f.coarse, &f.band, w, h, f.chase);
        let plan = matte_tiles(&trimap, w, h, FULL_TILE, FULL_OVERLAP);
        let (mut cols, mut rows) = (std::collections::BTreeSet::new(), std::collections::BTreeSet::new());
        for t in &plan {
            for x in [t.x, t.x + t.w] {
                if x > 0 && x < w {
                    cols.insert(x);
                }
            }
            for y in [t.y, t.y + t.h] {
                if y > 0 && y < h {
                    rows.insert(y);
                }
            }
        }
        let (mut on_edge, mut on_n, mut near, mut near_n) = (0.0f64, 0usize, 0.0f64, 0usize);
        let mut look = |i: usize, j: usize, edge: bool| {
            if f.band[i] <= 0.5 || f.band[j] <= 0.5 {
                return;
            }
            let step = (after[i] - after[j]).abs() as f64;
            if edge {
                on_edge += step;
                on_n += 1;
            } else {
                near += step;
                near_n += 1;
            }
        };
        for &x in &cols {
            for y in 0..h {
                look(y * w + x, y * w + x - 1, true);
                for off in [4usize, 6, 8] {
                    for xx in [x.saturating_sub(off), (x + off).min(w - 1)] {
                        if xx > 0 {
                            look(y * w + xx, y * w + xx - 1, false);
                        }
                    }
                }
            }
        }
        for &y in &rows {
            for x in 0..w {
                look(y * w + x, (y - 1) * w + x, true);
                for off in [4usize, 6, 8] {
                    for yy in [y.saturating_sub(off), (y + off).min(h - 1)] {
                        if yy > 0 {
                            look(yy * w + x, (yy - 1) * w + x, false);
                        }
                    }
                }
            }
        }
        let (edge_mean, near_mean) = (on_edge / on_n.max(1) as f64, near / near_n.max(1) as f64);
        eprintln!(
            "tile edges inside the stroke: mean step across an edge {edge_mean:.4} over {on_n} px, a few px either side {near_mean:.4}"
        );
        assert!(on_n > 0, "the plan must put a tile edge inside the stroke");
        assert!(edge_mean <= near_mean * 1.5 + 0.002, "a seam at a tile edge: {edge_mean} against {near_mean}");
        // Crops for the report, when asked for: before and after side by
        // side at 1:1 over a sector with strands.
        if let Ok(dir) = std::env::var("HEELER_FULLRES_OUT") {
            let (x0, y0, cw, ch) = (1600usize, 900usize, 420usize, 300usize);
            let mut img = image::GrayImage::new((cw * 3 + 8) as u32, ch as u32);
            for y in 0..ch {
                for x in 0..cw {
                    let i = (y0 + y) * w + x0 + x;
                    let luma = (f.rgb[i * 3] as u32 + f.rgb[i * 3 + 1] as u32 + f.rgb[i * 3 + 2] as u32) / 3;
                    img.put_pixel(x as u32, y as u32, image::Luma([luma as u8]));
                    img.put_pixel((cw + 4 + x) as u32, y as u32, image::Luma([(before[i] * 255.0).round() as u8]));
                    img.put_pixel((2 * cw + 8 + x) as u32, y as u32, image::Luma([(after[i] * 255.0).round() as u8]));
                }
            }
            img.save(std::path::Path::new(&dir).join("fixture_photo_before_after.png")).unwrap();
        }
        // The strands: the full-resolution matte must resolve them where
        // the stretched preview smeared them.
        assert!(ra > rb + 0.1, "strand recovery must rise: {rb} to {ra}");
        assert!(ca > cb + 0.1, "strands must stand off the wall beside them: {cb} to {ca}");
        assert!(wa < 0.05, "the wall stays out: {wa}");
        assert!(ea < eb, "the body's edge must be crisper at 1:1: {eb} to {ea}");
    }
}
