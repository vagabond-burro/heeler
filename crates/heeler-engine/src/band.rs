//! What an output row of each node depends on, for rendering a frame in
//! bands (the memory ceiling, Phase 2). A banded render walks back from
//! an output band to the rows each node must produce, and the class says
//! how: the same rows, the rows grown by a margin, the rows a transform
//! maps them back to, or the whole frame.
//!
//! Every node type the registry knows has a class here, and a test holds
//! the two together, so a new node type cannot reach a banded render
//! without someone deciding what its rows depend on. The class is the
//! node's nature; whether the banded renderer handles that class yet, and
//! with what margin, is the renderer's business. A node it does not handle
//! renders whole once, and the bands read it like a planted raster, so
//! the answer is exact either way and only the memory differs.

use heeler_graph::Node;

/// How an output row of a node depends on the node's inputs.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BandClass {
    /// A registered picture: the photograph, a File or a Catalog node.
    /// A band is the frame's rows, sliced.
    Source,
    /// An output pixel reads the same input pixel alone. It may read
    /// where it is in the frame (a vignette's center, a gradient's line,
    /// a mask's ellipse) and a planted plane at that pixel, so it needs
    /// the frame's size and the band's place in it, never more rows.
    Pointwise,
    /// An output pixel reads a window of input rows around it, and each
    /// output sums the same taps in the same order wherever it sits: blurs
    /// convolved directly, denoising, morphology, median. A band needs its
    /// rows grown by the node's margin above and below.
    Neighborhood,
    /// A window too, but built from running sums that walk down whole
    /// columns (box_blur_pass, box_mean_truncated, the guided filters
    /// built on them). A band started fresh would add the same values in
    /// another order and differ in the last bits, so each band carries
    /// the column sums and the last rows it made into the next.
    Carried,
    /// An output row maps back through an inverse transform to a source
    /// rectangle of any shape: crops, turns, warps, lens correction, a
    /// layer placed on the frame.
    Geometric,
    /// The answer reads values gathered over the whole frame first (a
    /// mean, a peak, a bounding box). A statistics pass gathers them the
    /// way the operator does over the whole frame, and the bands read
    /// them fixed.
    Statistics,
    /// The node answers from a raster the desktop planted for it (a
    /// segmentation, a matte, an inpaint fill, a model's denoise, a
    /// painted mask's bake). The raster is the whole frame's; a band
    /// reads its rows as it reads the photograph's.
    Raster,
    /// Rows depend on the whole frame in a way no band can follow (a
    /// distance transform down whole columns, a Poisson solve). The node
    /// renders whole.
    Unbandable,
}

/// The class of `node`, from its type and, where they change what it
/// reads, its params. None for a type this table does not know, which a
/// test turns into a failure for every type the registry builds.
pub fn class_of(node: &Node) -> Option<BandClass> {
    use BandClass::*;
    Some(match node.node_type.as_str() {
        "heeler.image_source" | "heeler.file" | "heeler.catalog" | "heeler.group" => Source,

        // Color and tone, per pixel. White balance, levels and the chart's
        // matrix arrive as params; nothing is measured from the frame.
        "heeler.exposure" | "heeler.white_balance" | "heeler.color_checker" | "heeler.curves" | "heeler.levels"
        | "heeler.color_balance" | "heeler.split_tone" | "heeler.paper" | "heeler.tone_profile"
        | "heeler.gamut_map" | "heeler.view_transform" | "heeler.lut" | "heeler.chromatic_adapt"
        | "heeler.channel_mixer" | "heeler.channel_gain" | "heeler.color_grade" | "heeler.color_bend"
        | "heeler.gradient_map" | "heeler.soft_clip" | "heeler.color_transform" | "heeler.to_display"
        | "heeler.to_scene" | "heeler.invert" | "heeler.desaturate" | "heeler.lift" | "heeler.fill"
        | "heeler.alpha_association" | "heeler.chroma_key" | "heeler.chroma_key_despill" => Pointwise,
        // Fields and masks read from pixel values, and the logic family.
        "heeler.channel_extract" | "heeler.channel_join" | "heeler.luminance_extract" | "heeler.tone_mask"
        | "heeler.luminance_range_mask" | "heeler.color_range_mask" | "heeler.hue_range_mask"
        | "heeler.range_mask" | "heeler.invert_mask" | "heeler.compare" | "heeler.logic" | "heeler.math"
        | "heeler.remap" | "heeler.conditional" | "heeler.luma_chroma_split" | "heeler.luma_chroma_join" => Pointwise,
        // Per pixel, by where the pixel is in the frame.
        "heeler.vignette" | "heeler.radial_mask" | "heeler.linear_mask" | "heeler.gradient"
        | "heeler.fx_color_overlay" | "heeler.fx_gradient_overlay" => Pointwise,
        // Fog reads the farness plane at the pixel and a noise hashed by
        // the pixel's place in the frame.
        "heeler.fog" => Pointwise,
        // Hand their input on.
        "heeler.output" | "heeler.export_layer" | "heeler.depth_map" => Pointwise,
        // Standard Color carries Detail's pass for older graphs; without
        // it the node is color alone.
        "heeler.standard_color" if crate::ops::detail_is_identity(&node.params) => Pointwise,
        "heeler.standard_color" => Carried,

        // Direct windows.
        "heeler.denoise" | "heeler.nlm_denoise" | "heeler.hot_pixel" | "heeler.edge_field"
        | "heeler.depth_normals" | "heeler.median" | "heeler.median_mask" | "heeler.morphology"
        | "heeler.blur" | "heeler.high_pass" | "heeler.sharpening" | "heeler.skin_soften"
        | "heeler.fx_shadow" | "heeler.fx_glow" | "heeler.fx_bevel" | "heeler.key_light" => Neighborhood,
        // Halation's glow is a window; its "showing" view divides by the
        // frame's peak.
        "heeler.halation" => Neighborhood,

        // Running sums down whole columns, directly or through the guided
        // filters and the illuminance estimate built on them.
        "heeler.tone_eq" | "heeler.color_console" | "heeler.recolor" | "heeler.measure" | "heeler.sharpen"
        | "heeler.clarity" | "heeler.detail" | "heeler.guided_filter" | "heeler.guided_filter_mask"
        | "heeler.black_white" => Carried,

        "heeler.crop_rotate" | "heeler.perspective" | "heeler.transform" | "heeler.grid_warp"
        | "heeler.shape_warp" | "heeler.layer_warp" | "heeler.layer_warp_mask" | "heeler.displacement_map"
        | "heeler.mask_crop" | "heeler.lens_correct" => Geometric,
        // A layer's content is fitted to and placed on the frame; a blend
        // of two frames the same size is per pixel, which the renderer
        // tells from the shapes.
        "heeler.blend" | "heeler.merge" => Geometric,

        // Grain and Noise take their field's mean and variance over the
        // whole frame; DoF sorts the frame into depth slices by their
        // bounding boxes; Flare's occlusion samples the plane around each
        // light, wherever the band is.
        "heeler.grain" | "heeler.noise" | "heeler.dof" | "heeler.flare" => Statistics,

        "heeler.smart_mask" | "heeler.matte_mask" | "heeler.inpaint" | "heeler.selection_mask"
        | "heeler.brush_mask" | "heeler.model_denoise" => Raster,

        // The distance transform runs the parabola envelope down whole
        // columns; Paint and Clone heal through a Poisson solve over the
        // stroke, and Clone reads its source wherever the offset points.
        "heeler.distance_field" | "heeler.paint" | "heeler.clone" => Unbandable,

        _ => return None,
    })
}

/// Where the buffer an operator is handed sits in its frame, while a
/// banded render runs it: the frame's whole size, and the frame row the
/// buffer's first row is. Full-width bands, so the column is always 0.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct BandFrame {
    pub(crate) full_w: usize,
    pub(crate) full_h: usize,
    pub(crate) y0: usize,
}

thread_local! {
    static FRAME: std::cell::Cell<Option<BandFrame>> = const { std::cell::Cell::new(None) };
}

/// The frame the current operator's buffer is a band of; None in a
/// whole-frame render. Read on the thread that runs the operator, before
/// it hands work to rayon, whose threads have no band.
pub(crate) fn frame() -> Option<BandFrame> {
    FRAME.with(|f| f.get())
}

/// The frame a `w` by `h` buffer is a band of, as its width, its height
/// and the frame row the buffer's first row is; the buffer itself, from
/// row 0, in a whole-frame render. An operator that reads where a pixel
/// is in the frame (a vignette's center, a mask's ellipse, a gradient's
/// line, a noise hashed by position) reads it from here.
pub(crate) fn placed(w: usize, h: usize) -> (usize, usize, usize) {
    match frame() {
        Some(f) => (f.full_w, f.full_h, f.y0),
        None => (w, h, 0),
    }
}

/// Runs `f` with `frame` as the band the operator's buffer is, restoring
/// what was there after, unwinding included.
pub(crate) fn with_frame<T>(frame: BandFrame, f: impl FnOnce() -> T) -> T {
    struct Reset(Option<BandFrame>);
    impl Drop for Reset {
        fn drop(&mut self) {
            FRAME.with(|f| f.set(self.0));
        }
    }
    let _reset = Reset(FRAME.with(|f| f.replace(Some(frame))));
    f()
}

#[cfg(test)]
mod tests {
    use super::*;
    use heeler_graph::{Registry, Section};

    /// Every node type the registry builds has a class, so a new type
    /// fails here until someone decides what its rows depend on.
    #[test]
    fn every_registered_node_type_has_a_band_class() {
        let registry = Registry::builtin();
        let missing: Vec<&str> = registry
            .types()
            .filter(|ty| class_of(&registry.instantiate(ty, "n", Section::Creative).unwrap()).is_none())
            .collect();
        assert!(missing.is_empty(), "node types without a band class: {missing:?}");
    }

    /// The registry's types and the operator table agree: every type the
    /// engine executes is registered and classed, and the table names no
    /// type the registry lacks (the photograph's group alias aside).
    #[test]
    fn the_band_table_names_only_registered_types() {
        let registry = Registry::builtin();
        let src = include_str!("band.rs");
        let table = &src[src.find("pub fn class_of").unwrap()..src.find("#[cfg(test)]").unwrap()];
        for name in table.split('"').filter(|s| s.starts_with("heeler.")) {
            if name == "heeler.group" {
                continue;
            }
            assert!(registry.get(name).is_some(), "{name} is classed but not registered");
        }
    }

    #[test]
    fn standard_color_is_per_pixel_until_its_detail_terms_are_on() {
        let registry = Registry::builtin();
        let mut node = registry.instantiate("heeler.standard_color", "c", Section::Creative).unwrap();
        assert_eq!(class_of(&node), Some(BandClass::Pointwise));
        node.params.insert("clarity".into(), heeler_graph::ParamValue::Number(20.0));
        assert_eq!(class_of(&node), Some(BandClass::Carried));
    }
}
