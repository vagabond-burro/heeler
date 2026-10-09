use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

use crate::error::GraphError;
use crate::node::{Node, ParamValue, Section};
use crate::ports::{PortKind, PortSpec};

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ParamSpec {
    pub name: String,
    pub default: ParamValue,
    pub min: Option<f64>,
    pub max: Option<f64>,
    /// For a text parameter with a closed set of answers: what those
    /// answers are, declared here so there is one list rather than one
    /// per place that has an opinion.
    ///
    /// It used to be three: the op's match arms, the graph inspector's
    /// picker and the layer stack's picker, each written at a different
    /// time. The engine parses nineteen blend modes, the layer stack
    /// offers nineteen, and the inspector offers nine, which nobody
    /// decided. A list in the registry is a list the UI can be checked
    /// against.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub choices: Vec<String>,
    /// Whether a value outside `choices` is an error rather than a
    /// fallback to the default. See `choice` and `strict_choice`.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub strict: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct NodeSpec {
    pub type_name: String,
    pub version: u32,
    pub label: String,
    pub params: Vec<ParamSpec>,
    pub inputs: Vec<PortSpec>,
    pub outputs: Vec<PortSpec>,
}

pub struct Registry {
    specs: BTreeMap<String, NodeSpec>,
}

/// What a value may actually BE, as opposed to what the slider spans.
///
/// "The sliders go from X to Y. A user may be able to type
/// in larger or smaller values (when possible, like for Radius you
/// should not be able to go below 0 but go as high as you want)... Let's
/// make this a whole pass on its own and set it as a rule in the app."
///
/// So min/max are the CONTROL range: where dragging feels right, and
/// where the useful settings live. The limit that survives a typed value
/// is this one, and it is derived rather than declared per param,
/// because there is only one honest rule to derive: a slider that starts
/// at zero starts there because below zero is meaningless (a radius, a
/// kelvin, a size), and a slider that goes negative already admits both
/// directions. Everything else is editorial and a typed number may
/// exceed it.
///
/// Ops still clamp for their own correctness; this only stops the graph
/// throwing the number away before the op ever sees it.
pub fn hard_limits(spec: &ParamSpec) -> (f64, f64) {
    match spec.min {
        Some(lo) if lo >= 0.0 => (0.0, f64::INFINITY),
        _ => (f64::NEG_INFINITY, f64::INFINITY),
    }
}

fn num(name: &str, default: f64, min: f64, max: f64) -> ParamSpec {
    ParamSpec {
        name: name.to_string(),
        default: ParamValue::Number(default),
        min: Some(min),
        max: Some(max),
        choices: Vec::new(),
        strict: false,
    }
}

fn text(name: &str, default: &str) -> ParamSpec {
    ParamSpec {
        name: name.to_string(),
        default: ParamValue::Text(default.to_string()),
        min: None,
        max: None,
        choices: Vec::new(),
        strict: false,
    }
}

fn flag(name: &str, default: bool) -> ParamSpec {
    ParamSpec {
        name: name.to_string(),
        default: ParamValue::Bool(default),
        min: None,
        max: None,
        choices: Vec::new(),
        strict: false,
    }
}

/// A text parameter with a closed set of answers, where an unknown
/// answer falls back to the default.
///
/// The lenient flavor, and the right one whenever the default is an
/// honest answer to the question. A project saved with a mode that a
/// later version renamed still renders, which is the rule that matters
/// more than strictness: never trap somebody's work over a spelling.
fn choice(name: &str, default: &str, values: &[&str]) -> ParamSpec {
    ParamSpec {
        name: name.to_string(),
        default: ParamValue::Text(default.to_string()),
        min: None,
        max: None,
        choices: values.iter().map(|v| v.to_string()).collect(),
        strict: false,
    }
}

/// The same, where an unknown answer is an error.
///
/// For a parameter with no honest default: where the choices are equally
/// valid answers to the question rather than one obvious one and some
/// variations, picking silently produces a wrong picture rather than a
/// different-looking one. Which half of an image to hand out is the case
/// this was built for.
fn strict_choice(name: &str, default: &str, values: &[&str]) -> ParamSpec {
    ParamSpec { strict: true, ..choice(name, default, values) }
}

/// A Finish warp's params (heeler.layer_warp), which the mask it carries
/// (heeler.layer_warp_mask) takes the same of.
fn layer_warp_params() -> Vec<ParamSpec> {
    vec![
        num("cols", 4.0, 1.0, 64.0),
        num("rows", 3.0, 1.0, 64.0),
        text("cols_u", ""),
        text("rows_v", ""),
        text("mesh", "[]"),
        text("lattice", ""),
        text("shapes", "[]"),
        choice("edges", "clamp", &["clamp", "transparent"]),
        choice("space", "frame", &["frame", "picture"]),
        num("room", 25.0, 0.0, 100.0),
        // Which of the two applies (2026-09-30: "The first control is
        // type: Either GRID or SHAPES"); the other is kept, at rest.
        // "auto" is a warp made before the choice: the shapes when it has
        // any, the grid otherwise.
        choice("kind", "auto", &["auto", "grid", "shapes"]),
    ]
}

fn image_in() -> PortSpec {
    PortSpec::new("in", PortKind::Image, false)
}

fn mask_in() -> PortSpec {
    PortSpec::new("mask", PortKind::Mask, true)
}

/// The depth input every depth consumer takes (26.3 Phase 10.3): the
/// Depth Map's farness plane, wired from its `depth` output, 0 near ..
/// 1 far. Optional: unwired, the op sees no plane and renders flat.
fn depth_in() -> PortSpec {
    PortSpec::new("depth", PortKind::Mask, true)
}

/// The paint stencil: a selection limiting where strokes land.
///
/// Kept apart from "mask" so a layer can carry both. A selection is not
/// a layer mask, and a layer that is stenciled while painting should
/// still be free to wear a mask of its own afterwards.
fn clip_in() -> PortSpec {
    PortSpec::new("clip", PortKind::Mask, true)
}

fn image_out() -> PortSpec {
    PortSpec::new("out", PortKind::Image, false)
}

impl Registry {
    pub fn get(&self, type_name: &str) -> Option<&NodeSpec> {
        self.specs.get(type_name)
    }

    pub fn types(&self) -> impl Iterator<Item = &str> {
        self.specs.keys().map(|s| s.as_str())
    }

    /// Creates a node with every parameter present at its default, so
    /// downstream code never deals with missing params.
    pub fn instantiate(
        &self,
        type_name: &str,
        id: &str,
        section: Section,
    ) -> Result<Node, GraphError> {
        let spec = self
            .specs
            .get(type_name)
            .ok_or_else(|| GraphError::UnknownNodeType(type_name.to_string()))?;
        Ok(Node {
            id: id.to_string(),
            node_type: spec.type_name.clone(),
            version: spec.version,
            label: spec.label.clone(),
            section,
            enabled: true,
            params: spec
                .params
                .iter()
                .map(|p| (p.name.clone(), p.default.clone()))
                .collect(),
            inputs: spec.inputs.clone(),
            outputs: spec.outputs.clone(),
        })
    }

    /// Validates a param against the spec: unknown names and type mismatches
    /// error; out-of-range numbers clamp.
    pub fn clamp(
        &self,
        type_name: &str,
        param: &str,
        value: ParamValue,
    ) -> Result<ParamValue, GraphError> {
        let spec = self
            .specs
            .get(type_name)
            .ok_or_else(|| GraphError::UnknownNodeType(type_name.to_string()))?;
        let pspec = spec
            .params
            .iter()
            .find(|p| p.name == param)
            .ok_or_else(|| GraphError::UnknownParam {
                node_type: type_name.to_string(),
                param: param.to_string(),
            })?;
        match (&pspec.default, value) {
            (ParamValue::Number(_), ParamValue::Number(n)) => {
                let (lo, hi) = hard_limits(pspec);
                Ok(ParamValue::Number(n.clamp(lo, hi)))
            }
            (ParamValue::Bool(_), ParamValue::Bool(b)) => Ok(ParamValue::Bool(b)),
            (ParamValue::Text(_), ParamValue::Text(s)) => Ok(ParamValue::Text(s)),
            (expected, _) => Err(GraphError::ParamTypeMismatch {
                param: param.to_string(),
                expected: match expected {
                    ParamValue::Number(_) => "number",
                    ParamValue::Bool(_) => "boolean",
                    ParamValue::Text(_) => "text",
                }
                .to_string(),
            }),
        }
    }

    /// The built-in node set.
    pub fn builtin() -> Self {
        let mut specs = BTreeMap::new();
        let mut add = |spec: NodeSpec| {
            specs.insert(spec.type_name.clone(), spec);
        };

        add(NodeSpec {
            type_name: "heeler.image_source".into(),
            version: 1,
            label: "Image Source".into(),
            // camera_wb / camera_matrix ride as UI flags the decode
            // reads; highlights is the RAW milestone's reconstruction
            // choice, resolved by the decoder (LibRaw clip/blend/
            // rebuild). Lenient: clip is an honest default.
            params: vec![
                choice("highlights", "clip", &["clip", "blend", "rebuild"]),
                // Demosaic quality, resolved by the decoder: fast is
                // linear interpolation, fine is DHT, standard leaves
                // LibRaw's default AHD-class choice.
                choice("demosaic", "standard", &["fast", "standard", "fine"]),
                // Capture sharpening, resolved by the decoder on sensor
                // data (never on a linear DNG): off, low, standard and
                // high are 0, 30, 60 and 100 of the develop's gain.
                choice("sharpening", "standard", &["off", "low", "standard", "high"]),
            ],
            inputs: vec![],
            outputs: vec![image_out()],
        });

        add(NodeSpec {
            type_name: "heeler.exposure".into(),
            version: 1,
            label: "Exposure".into(),
            params: vec![
                num("exposure", 0.0, -5.0, 5.0),
                // Contrast decomposed, which is the thing the majors
                // hard-wire: `contrast` steepens luminance only (chroma
                // untouched), `color_contrast` steepens the channels
                // against each other at constant luminance (darks
                // saturate the way per-channel curves make them).
                // One reference RAW editor's Contrast is roughly
                // luminance + some color; the other's couples color
                // harder. Heeler
                // hands the photographer the two axes separately.
                num("contrast", 0.0, -100.0, 100.0),
                num("color_contrast", 0.0, -100.0, 100.0),
                num("highlights", 0.0, -100.0, 100.0),
                num("shadows", 0.0, -100.0, 100.0),
                num("whites", 0.0, -100.0, 100.0),
                num("blacks", 0.0, -100.0, 100.0),
            ],
            inputs: vec![image_in(), mask_in()],
            outputs: vec![image_out()],
        });

        add(NodeSpec {
            type_name: "heeler.white_balance".into(),
            version: 1,
            label: "White Balance".into(),
            params: vec![
                num("temperature", 6500.0, 2000.0, 50000.0),
                num("tint", 0.0, -150.0, 150.0),
            ],
            inputs: vec![image_in(), mask_in()],
            outputs: vec![image_out()],
        });

        // 26.3 Phase 11: the Color Checker calibration. The 3x3 and the
        // exposure are what a fit against a photographed chart wrote
        // (the chart id, quad, patch overrides and fit report ride as
        // text params the panel owns); amount blends toward the fit.
        add(NodeSpec {
            type_name: "heeler.color_checker".into(),
            version: 1,
            label: "Color Checker".into(),
            params: vec![
                num("m00", 1.0, -4.0, 4.0),
                num("m01", 0.0, -4.0, 4.0),
                num("m02", 0.0, -4.0, 4.0),
                num("m10", 0.0, -4.0, 4.0),
                num("m11", 1.0, -4.0, 4.0),
                num("m12", 0.0, -4.0, 4.0),
                num("m20", 0.0, -4.0, 4.0),
                num("m21", 0.0, -4.0, 4.0),
                num("m22", 1.0, -4.0, 4.0),
                num("exposure", 0.0, -5.0, 5.0),
                num("amount", 100.0, 0.0, 100.0),
                // The sample circle's diameter as a percent of the cell;
                // the overlay draws it and the sampler measures it.
                num("sample", 40.0, 10.0, 90.0),
                text("chart", "colorchecker-classic"),
                text("quad", ""),
                text("patches", ""),
                text("fit", ""),
            ],
            inputs: vec![image_in(), mask_in()],
            outputs: vec![image_out()],
        });

        add(NodeSpec {
            type_name: "heeler.standard_color".into(),
            version: 1,
            label: "Color".into(),
            params: vec![
                num("temperature", 6500.0, 2000.0, 50000.0),
                num("tint", 0.0, -150.0, 150.0),
                num("exposure", 0.0, -5.0, 5.0),
                num("contrast", 0.0, -100.0, 100.0),
                num("saturation", 0.0, -100.0, 100.0),
                num("vibrance", 0.0, -100.0, 100.0),
                num("texture", 0.0, -100.0, 100.0),
                num("clarity", 0.0, -100.0, 100.0),
                num("dehaze", 0.0, -100.0, 100.0),
                // Each detail effect can be re-weighted by tonal band and
                // by channel, the same way grain is: clarity in the
                // midtones only, texture kept out of the shadows, dehaze
                // pulled mostly from the blues. Percent, 100 = as-is.
                num("texture_shadows", 100.0, 0.0, 200.0),
                num("texture_midtones", 100.0, 0.0, 200.0),
                num("texture_highlights", 100.0, 0.0, 200.0),
                num("texture_red", 100.0, 0.0, 200.0),
                num("texture_green", 100.0, 0.0, 200.0),
                num("texture_blue", 100.0, 0.0, 200.0),
                num("clarity_shadows", 100.0, 0.0, 200.0),
                num("clarity_midtones", 100.0, 0.0, 200.0),
                num("clarity_highlights", 100.0, 0.0, 200.0),
                num("clarity_red", 100.0, 0.0, 200.0),
                num("clarity_green", 100.0, 0.0, 200.0),
                num("clarity_blue", 100.0, 0.0, 200.0),
                num("dehaze_shadows", 100.0, 0.0, 200.0),
                num("dehaze_midtones", 100.0, 0.0, 200.0),
                num("dehaze_highlights", 100.0, 0.0, 200.0),
                num("dehaze_red", 100.0, 0.0, 200.0),
                num("dehaze_green", 100.0, 0.0, 200.0),
                num("dehaze_blue", 100.0, 0.0, 200.0),
            ],
            inputs: vec![image_in(), mask_in()],
            outputs: vec![image_out()],
        });

        add(NodeSpec {
            type_name: "heeler.curves".into(),
            version: 1,
            label: "Curves".into(),
            params: vec![text("points", "[]")],
            inputs: vec![image_in(), mask_in()],
            outputs: vec![image_out()],
        });

        add(NodeSpec {
            type_name: "heeler.levels".into(),
            version: 1,
            label: "Levels".into(),
            params: vec![
                num("black", 0.0, 0.0, 0.99),
                num("white", 1.0, 0.01, 1.0),
                num("gamma", 1.0, 0.1, 10.0),
                // Soft knees on both points: values roll into the clip instead
                // of snapping (the owner's Levels round).
                num("black_soft", 0.0, 0.0, 100.0),
                num("white_soft", 0.0, 0.0, 100.0),
            ],
            inputs: vec![image_in(), mask_in()],
            outputs: vec![image_out()],
        });

        add(NodeSpec {
            type_name: "heeler.color_balance".into(),
            version: 1,
            label: "Color Balance".into(),
            params: vec![
                num("shadows_hue", 0.0, -180.0, 180.0),
                num("shadows_sat", 0.0, -100.0, 100.0),
                num("shadows_lum", 0.0, -100.0, 100.0),
                num("midtones_hue", 0.0, -180.0, 180.0),
                num("midtones_sat", 0.0, -100.0, 100.0),
                num("midtones_lum", 0.0, -100.0, 100.0),
                num("highlights_hue", 0.0, -180.0, 180.0),
                num("highlights_sat", 0.0, -100.0, 100.0),
                num("highlights_lum", 0.0, -100.0, 100.0),
            ],
            inputs: vec![image_in(), mask_in()],
            outputs: vec![image_out()],
        });

        add(NodeSpec {
            type_name: "heeler.sharpen".into(),
            version: 1,
            label: "Sharpen".into(),
            params: vec![
                num("amount", 0.0, 0.0, 300.0),
                num("radius", 1.0, 0.1, 5.0),
                num("threshold", 0.0, 0.0, 255.0),
            ],
            inputs: vec![image_in(), mask_in()],
            outputs: vec![image_out()],
        });

        add(NodeSpec {
            type_name: "heeler.clarity".into(),
            version: 1,
            label: "Clarity".into(),
            params: vec![
                num("texture", 0.0, -100.0, 100.0),
                num("clarity", 0.0, -100.0, 100.0),
                num("local_contrast", 0.0, -100.0, 100.0),
            ],
            inputs: vec![image_in(), mask_in()],
            outputs: vec![image_out()],
        });

        add(NodeSpec {
            type_name: "heeler.grain".into(),
            version: 1,
            label: "Grain".into(),
            params: vec![
                num("intensity", 0.0, 0.0, 100.0),
                num("size", 25.0, 1.0, 100.0),
                flag("color_grain", false),
                // Stock character.
                choice("pattern", "standard", &["fine", "standard", "coarse", "cinema"]),
                // Enlargement: size read against the full frame's short side rather than
                // the render's pixels, and the negative's format against the print. Off
                // on graphs saved before it, so they keep the grain they were drawn
                // with.
                flag("by_frame", false),
                choice("format", "35mm", &["35mm", "645", "6x6", "6x7", "4x5"]),
                // Tonal-band and per-channel grain weighting, percent.
                num("shadows_gain", 100.0, 0.0, 200.0),
                num("midtones_gain", 100.0, 0.0, 200.0),
                num("highlights_gain", 100.0, 0.0, 200.0),
                num("red_gain", 100.0, 0.0, 200.0),
                num("green_gain", 100.0, 0.0, 200.0),
                num("blue_gain", 100.0, 0.0, 200.0),
            ],
            inputs: vec![image_in(), mask_in()],
            outputs: vec![image_out()],
        });

        // The pieces effects are built out of.
        //
        // "Is it not possible to have generic utility nodes that
        // support gain adjustments on a single channel? [...] I want to go
        // beyond 'here is a grain node' and rather show the user 'this is
        // how grain effects are built' to educate and empower them."
        //
        // Small on purpose. A gain of 100 is unchanged and a tone mask is
        // just a shape, so a group made of these sitting at their defaults
        // is a group that does nothing, which is what lets one be opened up
        // and read without changing the picture.
        add(NodeSpec {
            type_name: "heeler.noise".into(),
            version: 1,
            label: "Grain Field".into(),
            params: vec![
                num("size", 25.0, 1.0, 100.0),
                choice("pattern", "standard", &["fine", "standard", "coarse", "cinema"]),
                flag("color_grain", false),
                num("seed", 0.0, 0.0, 9999.0),
                // The same Enlargement as the grain op, so a grain built
                // from fields is the grain.
                flag("by_frame", false),
                choice("format", "35mm", &["35mm", "645", "6x6", "6x7", "4x5"]),
            ],
            inputs: vec![image_in()],
            outputs: vec![image_out()],
        });

        add(NodeSpec {
            type_name: "heeler.channel_gain".into(),
            version: 1,
            label: "Channel Gain".into(),
            params: vec![
                // red | green | blue | luma: the LONG spellings, where
                // channel_extract takes the short ones. The engine reads
                // "luma" (and any unknown spelling) as "all channels",
                // which is what a luma gain amounts to.
                choice("channel", "luma", &["luma", "red", "green", "blue"]),
                num("gain", 100.0, 0.0, 400.0),
            ],
            inputs: vec![image_in(), mask_in()],
            outputs: vec![image_out()],
        });

        add(NodeSpec {
            type_name: "heeler.tone_mask".into(),
            version: 1,
            label: "Tone Mask".into(),
            // shadows | midtones | highlights | bell
            params: vec![choice("range", "midtones", &["shadows", "midtones", "highlights", "bell"])],
            inputs: vec![image_in()],
            outputs: vec![image_out()],
        });

        add(NodeSpec {
            type_name: "heeler.crop_rotate".into(),
            version: 1,
            label: "Crop & Rotate".into(),
            params: vec![
                num("angle", 0.0, -45.0, 45.0),
                // Squeeze toward square or stretch away from it, a RAW
                // editor's Transform > Aspect convention: negative widens,
                // positive heightens. The frame keeps its dimensions;
                // the content stretches within it.
                num("aspect", 0.0, -100.0, 100.0),
                num("crop_x", 0.0, 0.0, 0.95),
                num("crop_y", 0.0, 0.0, 0.95),
                num("crop_w", 1.0, 0.05, 1.0),
                num("crop_h", 1.0, 0.05, 1.0),
                // Photo > Flip Horizontal and Flip Vertical: on at a half
                // or more, applied before the turn and the crop
                // (ops_geometry::crop_flips).
                num("flip_h", 0.0, 0.0, 1.0),
                num("flip_v", 0.0, 0.0, 1.0),
            ],
            // Geometry nodes take no mask: they change pixel positions, not
            // values, so masking them is meaningless.
            inputs: vec![image_in()],
            outputs: vec![image_out()],
        });

        add(NodeSpec {
            type_name: "heeler.black_white".into(),
            version: 1,
            label: "Black & White".into(),
            params: vec![
                num("red", 30.0, -200.0, 300.0),
                num("green", 59.0, -200.0, 300.0),
                num("blue", 11.0, -200.0, 300.0),
                // Treatment strength: 0 leaves color untouched, so the
                // enabled flag stays a pure bypass. Defaulting to 0 keeps
                // the node identity until asked, the same as every other
                // node here. It used to default to 100, which meant a
                // graph that omitted the param rendered fully monochrome.
                num("amount", 0.0, 0.0, 100.0),
                // The expert face: a periodic hue-to-EV curve over the mixed gray,
                // Recolor's point list on a 0..360 axis. Empty is the mixer alone.
                text("hue_curve", ""),
                // Filter and film: a Wratten key (w8, w11, w15, w21, w25, w29, w47, w58)
                // and a stock key make the gray a spectral integral; empty is the mixer.
                // The serializer copies the Film section's stock here, so a film is one
                // choice.
                text("filter", ""),
                text("film", ""),
                // Near and Far (idea 6, phase 5): the filter on the far end
                // of the depth map (the `filter` above is the near end),
                // and the curve along depth between them, x depth 0..100
                // near to far, y the far share 0..100; empty is linear.
                // Empty Far, or Far the same as Near, is one conversion.
                text("far_filter", ""),
                text("depth_curve", ""),
                // Infrared (phase 4b): the material guess past 700 nm, in
                // stops, and the curve that outranks the four when drawn.
                num("ir_foliage", 2.4, -4.0, 4.0),
                num("ir_sky", -2.5, -4.0, 4.0),
                num("ir_water", -0.8, -4.0, 4.0),
                num("ir_skin", 0.6, -4.0, 4.0),
                text("ir_curve", ""),
                // Each curve its own interpolation face (review
                // 2026-09-15, item 7): the hue curve reads eq_interp, the
                // infrared guess ir_interp and the depth curve
                // depth_interp, each falling back to eq_interp when
                // empty, which is what a graph saved with one face means.
                text("ir_interp", ""),
                text("depth_interp", ""),
                // Neutral (2026-09-15): the infrared guess's floor, how gray a color
                // must be before the guess leaves it alone, 0..100 over saturation
                // 0..0.06. One dial for every material, since the gate is asked before
                // any hue is looked up. The hue curve gates at the default.
                num("neutral", 10.0, 0.0, 100.0),
                // The curve's own switch (2026-09-14: "toggle the effect of the hue
                // curve on and off ... to see how it changes the image"): off renders
                // the mixer alone, the points kept.
                flag("hue_curve_on", true),
            ],
            inputs: vec![image_in(), mask_in()],
            outputs: vec![image_out()],
        });

        add(NodeSpec {
            // Noise Reduction's Model method: the planted SCUNet answer blended
            // in. Sits right after the source so the answer the desktop computed
            // from the source is the picture this node sees.
            type_name: "heeler.model_denoise".into(),
            version: 1,
            label: "Model Denoise".into(),
            params: vec![
                num("luminance", 50.0, 0.0, 100.0),
                num("chroma", 50.0, 0.0, 100.0),
                num("detail", 50.0, 0.0, 100.0),
                // The section's remembered choice: 1 while Model is
                // the method, even with the section switched off.
                num("method", 0.0, 0.0, 1.0),
            ],
            inputs: vec![image_in(), mask_in()],
            outputs: vec![image_out()],
        });

        add(NodeSpec {
            type_name: "heeler.denoise".into(),
            version: 1,
            label: "Denoise".into(),
            params: vec![num("strength", 0.0, 0.0, 100.0)],
            inputs: vec![image_in(), mask_in()],
            outputs: vec![image_out()],
        });

        add(NodeSpec {
            // Switching median for stuck photosites: replaces a channel with its
            // neighborhood median only when it deviates past the sensitivity, so
            // the rest of the frame passes through untouched.
            type_name: "heeler.hot_pixel".into(),
            version: 1,
            label: "Hot Pixels".into(),
            params: vec![num("sensitivity", 50.0, 0.0, 100.0)],
            inputs: vec![image_in(), mask_in()],
            outputs: vec![image_out()],
        });

        add(NodeSpec {
            // Perspective correction [P2]: keystone for converging
            // verticals and skewed horizontals; zoom hides the
            // revealed borders.
            type_name: "heeler.perspective".into(),
            version: 1,
            label: "Perspective".into(),
            params: vec![
                num("vertical", 0.0, -100.0, 100.0),
                num("horizontal", 0.0, -100.0, 100.0),
                num("zoom", 0.0, 0.0, 100.0),
            ],
            inputs: vec![image_in(), mask_in()],
            outputs: vec![image_out()],
        });

        add(NodeSpec {
            // Grid Warp: a mesh of handles over the whole frame and the
            // smooth field between them (heeler-engine/src/ops_warp.rs).
            // A geometry op with no mask port, like crop and lens: it
            // sits upstream of every mask and stroke so what is painted
            // afterwards lands where it was painted. cols and rows count
            // CELLS; the vertex lists are one longer on each axis.
            type_name: "heeler.grid_warp".into(),
            version: 1,
            label: "Grid Warp".into(),
            params: vec![
                num("cols", 4.0, 1.0, 64.0),
                num("rows", 3.0, 1.0, 64.0),
                // Grid line positions per axis as JSON arrays in [0, 1];
                // empty means even spacing. Non-uniform density lives
                // here, so a row added near the eyes leaves the rest of
                // the grid where it was.
                text("cols_u", ""),
                text("rows_v", ""),
                // One displacement per vertex, dx dy flat, row-major, in
                // fractions of the frame; stored as displacement rather
                // than position so a density change resamples the warp
                // instead of resetting it.
                text("mesh", "[]"),
                // The affine from the frame to the grid's own fractions
                // (six numbers as JSON), written when the photograph is
                // re-cropped under a drawn grid so the warp stays on the
                // scene (the stroke remap, framemap.ts); empty is the
                // frame's own grid.
                text("lattice", ""),
                // What a source outside the frame shows: the border
                // stretched in (a reshaped photograph's usual want) or
                // transparency, which the crop can then cut away.
                choice("edges", "clamp", &["clamp", "transparent"]),
            ],
            inputs: vec![image_in()],
            outputs: vec![image_out()],
        });

        add(NodeSpec {
            // Shape Warp: the Radial layer's shapes as regions of
            // influence, each with a move, twist and pinch for the
            // pixels under it; overlapping shapes share the pull, so a
            // still shape holds (heeler-engine/src/ops_warp.rs). Same
            // resampler as Grid Warp, after it in the chain; a geometry
            // op with no mask port.
            type_name: "heeler.shape_warp".into(),
            version: 1,
            label: "Shape Warp".into(),
            params: vec![
                // The list as JSON objects: enabled, cx, cy, radius,
                // feather, aspect, rotation (the placement), dx, dy,
                // angle, scale, scale_y, amount (the warp), plus id and
                // name the engine ignores.
                text("shapes", "[]"),
                choice("edges", "clamp", &["clamp", "transparent"]),
            ],
            inputs: vec![image_in()],
            outputs: vec![image_out()],
        });

        add(NodeSpec {
            // The Finish tab's warp (2026-09-30: "build both, A for image layers
            // and B for the photo"): Grid Warp's mesh and Shape Warp's list on one
            // node, under their own param names, run through the same resampler,
            // grid first. In "frame" space it is a Warp layer's content, warping
            // everything below it in the stack; in "picture" space it is an image
            // layer's own warp, in the picture's fractions before the blend places
            // it, with `room` percent of transparent margin so a pull can leave
            // the picture's rectangle (heeler-engine/src/ops_warp.rs layer_warp).
            // `weight` is a Warp layer's mask, wired by the desktop beside the
            // carried one (build_graph): the picture is weighed by it through the
            // warp. Not "mask", which the executor would read as the node's own
            // gate.
            type_name: "heeler.layer_warp".into(),
            version: 1,
            label: "Warp".into(),
            params: layer_warp_params(),
            inputs: vec![image_in(), PortSpec::new("weight", PortKind::Mask, true)],
            outputs: vec![image_out()],
        });

        add(NodeSpec {
            // A Warp layer's mask carried through the layer's warp, so the mask says
            // what is warped and travels with it (2026-09-30: "I would have wanted to
            // see its head bigger but not effect the background"). Spliced in by the
            // desktop between the mask and the layer's blend with the warp node's own
            // params (build_graph); not a node anyone places by hand.
            type_name: "heeler.layer_warp_mask".into(),
            version: 1,
            label: "warp mask".into(),
            params: layer_warp_params(),
            // `beyond`: the same mask over the frame and the margin past
            // it the warp reads, from the mask node asked for it (the
            // desktop wires it; ops_masks.rs beyond_render).
            inputs: vec![PortSpec::new("in", PortKind::Mask, false), PortSpec::new("beyond", PortKind::Mask, true)],
            outputs: vec![PortSpec::new("out", PortKind::Mask, false)],
        });

        add(NodeSpec {
            // Creative elliptical vignette [P2]: a look, not the lens
            // correction. Negative darkens corners.
            type_name: "heeler.vignette".into(),
            version: 1,
            label: "Vignette".into(),
            params: vec![
                num("vignette", 0.0, -100.0, 100.0),
                num("vignette_mid", 50.0, 0.0, 100.0),
                num("softness", 0.5, 0.0, 1.0),
            ],
            inputs: vec![image_in(), mask_in()],
            outputs: vec![image_out()],
        });

        add(NodeSpec {
            // Patch-similarity denoise: KNN is the interactive default, NLM the
            // block-matching quality mode priced for export. Both honest defaults,
            // so the lenient choice.
            type_name: "heeler.nlm_denoise".into(),
            version: 1,
            label: "Detail Denoise".into(),
            params: vec![
                // Signed strength belongs to Depth Lighting, not here:
                // nlm_denoise treats strength <= 0 as a passthrough, so
                // a negative half to this slider would be a control
                // that silently does nothing.
                num("strength", 0.0, 0.0, 100.0),
                choice("mode", "knn", &["knn", "nlm"]),
            ],
            inputs: vec![image_in(), mask_in()],
            outputs: vec![image_out()],
        });

        add(NodeSpec {
            type_name: "heeler.luminance_extract".into(),
            version: 1,
            label: "Luminance Extract".into(),
            params: vec![],
            inputs: vec![image_in()],
            outputs: vec![PortSpec::new("out", PortKind::Channel, false)],
        });

        add(NodeSpec {
            // Three fields in, an image out: the join the logic family was missing
            // ("How would I merge the outputs of 3 float into an
            // vector 3 to input to a color channel?"). Each port is optional and
            // reads as zero when unwired, so one field on "r" is a red picture,
            // and nothing wired is black. Alpha is one everywhere: this makes
            // color, not transparency.
            type_name: "heeler.channel_join".into(),
            version: 1,
            label: "Channel Join".into(),
            params: vec![],
            inputs: vec![
                PortSpec::new("r", PortKind::Mask, true),
                PortSpec::new("g", PortKind::Mask, true),
                PortSpec::new("b", PortKind::Mask, true),
                // The alpha the image carries (node recipes, 2026-09-30:
                // Image Arithmetic keeps input A's transparency). Unwired
                // is one everywhere, what shipped before the port.
                PortSpec::new("alpha", PortKind::Mask, true),
            ],
            outputs: vec![image_out()],
        });

        add(NodeSpec {
            // Any image from disk, as a second source in the graph
            // (a compositor's Read or Loader node). Image Source stays the
            // photograph itself; this is how a texture, a logo or a
            // second photograph gets in. The path rides as a parameter
            // and the desktop plants the decoded file in the sources
            // map under this node's id, the way it plants the photo.
            type_name: "heeler.file".into(),
            version: 1,
            label: "File".into(),
            // layer (26.3 Phase 6): "" is the first page of a TIFF;
            // "page 2" .. "page n" name the rest; "A" is the page's
            // alpha as the mask output.
            // space (Finish image layers, 2026-09-30): "scene" hands the
            // decode on as it is, scene-linear, for a Merge in the graph;
            // "display" encodes it to the display space the Finish stack
            // composites in, so a picture placed as a layer looks like
            // itself instead of a stop and a half darker.
            params: vec![text("path", ""), text("layer", ""), choice("space", "scene", &["scene", "display"])],
            inputs: vec![],
            // The page's alpha, or the named channel, as a field: the
            // desktop plants it under `{id}@mask` when a pipe leaves
            // the port, the same bargain as Depth Map's depth plane.
            outputs: vec![image_out(), PortSpec::new("mask", PortKind::Mask, false)],
        });

        add(NodeSpec {
            // Texture, clarity and dehaze with their per-band weights, on
            // a node of their own (2026-09-02). Standard Color keeps the
            // same params so graphs saved before the split still render;
            // the loader moves them here.
            type_name: "heeler.detail".into(),
            version: 1,
            label: "Detail".into(),
            params: vec![
                num("texture", 0.0, -100.0, 100.0),
                num("clarity", 0.0, -100.0, 100.0),
                num("dehaze", 0.0, -100.0, 100.0),
                num("texture_shadows", 100.0, 0.0, 200.0),
                num("texture_midtones", 100.0, 0.0, 200.0),
                num("texture_highlights", 100.0, 0.0, 200.0),
                num("texture_red", 100.0, 0.0, 200.0),
                num("texture_green", 100.0, 0.0, 200.0),
                num("texture_blue", 100.0, 0.0, 200.0),
                num("clarity_shadows", 100.0, 0.0, 200.0),
                num("clarity_midtones", 100.0, 0.0, 200.0),
                num("clarity_highlights", 100.0, 0.0, 200.0),
                num("clarity_red", 100.0, 0.0, 200.0),
                num("clarity_green", 100.0, 0.0, 200.0),
                num("clarity_blue", 100.0, 0.0, 200.0),
                num("dehaze_shadows", 100.0, 0.0, 200.0),
                num("dehaze_midtones", 100.0, 0.0, 200.0),
                num("dehaze_highlights", 100.0, 0.0, 200.0),
                num("dehaze_red", 100.0, 0.0, 200.0),
                num("dehaze_green", 100.0, 0.0, 200.0),
                num("dehaze_blue", 100.0, 0.0, 200.0),
            ],
            inputs: vec![image_in(), mask_in()],
            outputs: vec![image_out()],
        });

        add(NodeSpec {
            // Another photograph from the catalog, as a source: the double-exposure
            // node ("Sometimes people like to create double exposure
            // effects"). "developed" is that photo's own Output, rendered from the
            // graph saved beside it; "shot" is its file as decoded. The desktop
            // plants the result under this node's id, the way it plants the photo
            // and a File.
            type_name: "heeler.catalog".into(),
            version: 1,
            label: "Catalog".into(),
            params: vec![
                text("image", ""),
                choice("mode", "developed", &["developed", "shot"]),
                // The File node's space, for the same reason: a Finish
                // image layer takes the other photograph display-encoded.
                choice("space", "scene", &["scene", "display"]),
            ],
            inputs: vec![],
            outputs: vec![image_out()],
        });

        add(NodeSpec {
            // Move, scale and rotate about a pivot, in ONE node, so the
            // three concatenate into one matrix and the picture is
            // resampled once (three nodes would soften it three times).
            // Moves are a percentage of the frame, size a percentage,
            // the pivot a fraction of the frame; the frame itself stays
            // put, and what leaves it is gone, what enters is
            // transparent, which is what a Merge wants on top.
            type_name: "heeler.transform".into(),
            version: 1,
            label: "Transform".into(),
            params: vec![
                num("move_x", 0.0, -200.0, 200.0),
                num("move_y", 0.0, -200.0, 200.0),
                num("size", 100.0, 1.0, 400.0),
                num("rotate", 0.0, -180.0, 180.0),
                num("pivot_x", 50.0, 0.0, 100.0),
                num("pivot_y", 50.0, 0.0, 100.0),
            ],
            inputs: vec![image_in()],
            outputs: vec![image_out()],
        });

        add(NodeSpec {
            type_name: "heeler.luminance_range_mask".into(),
            version: 1,
            label: "Luminance Mask".into(),
            params: vec![
                num("low", 0.0, 0.0, 1.0),
                num("high", 1.0, 0.0, 1.0),
                num("feather", 0.1, 0.0, 1.0),
                flag("invert", false),
            ],
            inputs: vec![image_in()],
            outputs: vec![PortSpec::new("out", PortKind::Mask, false)],
        });

        add(NodeSpec {
            // A mask, inverted, as its own node. Exists for the Outside
            // gesture: one mask feeding a grade AND, through this, the
            // complement grade, so editing the mask moves both. A color
            // grader shares an inverted key invisibly; here the inversion is a
            // node on the canvas, which is the graph being honest.
            type_name: "heeler.invert_mask".into(),
            version: 1,
            label: "Invert Mask".into(),
            params: vec![],
            inputs: vec![PortSpec::new("mask", PortKind::Mask, false)],
            outputs: vec![PortSpec::new("out", PortKind::Mask, false)],
        });

        // The advanced field nodes (engine: ops_field.rs), graph-only: no
        // Develop slider, no Finish layer. 2026-09-30: "go ahead with the first
        // batch of nodes". Radii are in the photograph's pixels (the op
        // multiplies by px_scale), and every one of them reads neighbors, so
        // each has a row in the desktop's clone_reach or the 1:1 slice would
        // cut its window short.
        //
        // Morphology: Erode (a minimum filter), Dilate (a maximum),
        // Open (erode then dilate) and Close (dilate then erode) over a
        // Round or Square window. Grayscale by default, so a soft mask
        // keeps its soft values; Coverage Hard thresholds at one half
        // first. Erode and Dilate are opposites, so an unknown mode is
        // an error rather than a guess.
        add(NodeSpec {
            type_name: "heeler.morphology".into(),
            version: 1,
            label: "Morphology".into(),
            params: vec![
                strict_choice("mode", "erode", &["erode", "dilate", "open", "close"]),
                num("radius", 2.0, 0.0, 50.0),
                choice("shape", "round", &["round", "square"]),
                choice("coverage", "soft", &["soft", "hard"]),
            ],
            inputs: vec![PortSpec::new("in", PortKind::Mask, true)],
            outputs: vec![PortSpec::new("out", PortKind::Mask, false)],
        });

        // Guided Filter: the picture (or a mask) smoothed where the
        // guide is flat and kept where it has an edge. The guide is read
        // in color, display encoded; Epsilon is in display units
        // squared. Two type names because a port's kind is fixed: the
        // picture form takes and gives rgb (with the classic
        // self-guided smoothing when the guide is unwired), the mask
        // form takes a field on `target` and the guide picture on `in`
        // and gives a field. Radius is the box radius in photograph
        // pixels; the filter reads twice it (two box stages).
        add(NodeSpec {
            type_name: "heeler.guided_filter".into(),
            version: 1,
            label: "Guided Filter".into(),
            params: vec![num("radius", 8.0, 0.0, 100.0), num("epsilon", 0.01, 0.0, 0.1)],
            inputs: vec![
                image_in(),
                PortSpec::new("guide", PortKind::Image, true),
                mask_in(),
            ],
            outputs: vec![image_out()],
        });
        add(NodeSpec {
            type_name: "heeler.guided_filter_mask".into(),
            version: 1,
            label: "Guided Filter (Mask)".into(),
            params: vec![num("radius", 8.0, 0.0, 100.0), num("epsilon", 0.01, 0.0, 0.1)],
            inputs: vec![
                // The guide: the picture whose edges the mask settles on.
                image_in(),
                PortSpec::new("target", PortKind::Mask, true),
            ],
            outputs: vec![PortSpec::new("out", PortKind::Mask, false)],
        });

        // Edge Field: where the picture (or a field) changes, as a mask.
        // Sobel or Scharr give the gradient's magnitude, the Laplacian
        // the second derivative's. Measured through a gaussian of Scale
        // photograph pixels and normalized by the same measurement of a
        // hard 0 to 1 step, so a full step reads 1 at Fit, 1:1 and the
        // export alike. Threshold and Softness shape it (both zero: as
        // measured). The picture is read on `in` as display luminance;
        // a field on `field` (the card's diamond) is read as it is and
        // wins.
        add(NodeSpec {
            type_name: "heeler.edge_field".into(),
            version: 1,
            label: "Edge Field".into(),
            params: vec![
                choice("operator", "sobel", &["sobel", "scharr", "laplacian"]),
                num("scale", 1.0, 0.0, 10.0),
                num("threshold", 0.0, 0.0, 1.0),
                num("softness", 0.0, 0.0, 1.0),
            ],
            inputs: vec![
                PortSpec::new("in", PortKind::Image, true),
                PortSpec::new("field", PortKind::Mask, true),
            ],
            outputs: vec![PortSpec::new("out", PortKind::Mask, false)],
        });

        // Alpha Association: Extract (the alpha as a gray picture),
        // Replace (the mask on `alpha` becomes the alpha, exactly),
        // Premultiply and Unpremultiply (color times or over alpha,
        // with heeler-io's floor, so color under a zero alpha is kept).
        // THE GRAPH RULE: every wire carries straight alpha. Readers
        // unpremultiply on the way in (an EXR's associated color is
        // divided out in heeler-io's fill_rgb), writers premultiply on
        // the way out, so this node is never the fix for a file's
        // association; a Premultiply is a deliberate, unmarked
        // intermediate and comes back through Unpremultiply before
        // anything composites, masks or exports. The two are opposites,
        // so an unknown mode is an error rather than a guess.
        add(NodeSpec {
            type_name: "heeler.alpha_association".into(),
            version: 1,
            label: "Alpha Association".into(),
            params: vec![strict_choice(
                "mode",
                "replace",
                &["extract", "replace", "premultiply", "unpremultiply"],
            )],
            inputs: vec![image_in(), PortSpec::new("alpha", PortKind::Mask, true)],
            outputs: vec![image_out()],
        });

        // The second batch of advanced nodes (engine: ops_advanced.rs),
        // graph-only like the first. 2026-09-30: "queue those up next as they
        // don't look too extensive." Radii and distances are in the
        // photograph's pixels (times px_scale), and each one that reads
        // neighbors has a row in the desktop's clone_reach.
        //
        // Technical Soft Clip: values past Ceiling (scene-linear)
        // rolled into it by a tanh Knee (a share of the ceiling: 0.2
        // starts at 0.8 of it; 0 is a hard clip), and with a Toe width
        // values under it rolled toward zero (0, the default, is off).
        // The identity between the two. By Brightest channel (the
        // default) keeps a pixel's ratios, so hue, and no channel
        // passes the ceiling; Each channel knees the three apart.
        add(NodeSpec {
            type_name: "heeler.soft_clip".into(),
            version: 1,
            label: "Technical Soft Clip".into(),
            params: vec![
                num("ceiling", 1.0, 0.0, 16.0),
                num("knee", 0.2, 0.0, 1.0),
                num("toe", 0.0, 0.0, 0.1),
                choice("by", "max", &["max", "channel"]),
            ],
            inputs: vec![image_in(), mask_in()],
            outputs: vec![image_out()],
        });

        // Median / Percentile: each pixel becomes the value at
        // Percentile (50, the median; 0 the window's least, 100 its
        // most) of a round window of Radius photograph pixels, cut at
        // the frame. Two type names because a port's kind is fixed:
        // the picture form ranks By luminance (one real pixel's whole
        // color handed out, no hue shift) or Each channel, the mask
        // form ranks a field. Reach: the radius.
        add(NodeSpec {
            type_name: "heeler.median".into(),
            version: 1,
            label: "Median / Percentile".into(),
            params: vec![
                num("radius", 2.0, 0.0, 50.0),
                num("percentile", 50.0, 0.0, 100.0),
                choice("rank", "luminance", &["luminance", "channel"]),
            ],
            inputs: vec![image_in(), mask_in()],
            outputs: vec![image_out()],
        });
        add(NodeSpec {
            type_name: "heeler.median_mask".into(),
            version: 1,
            label: "Median / Percentile (Mask)".into(),
            params: vec![num("radius", 2.0, 0.0, 50.0), num("percentile", 50.0, 0.0, 100.0)],
            inputs: vec![PortSpec::new("in", PortKind::Mask, true)],
            outputs: vec![PortSpec::new("out", PortKind::Mask, false)],
        });

        // Signed Distance Field: each pixel's exact Euclidean distance
        // (Felzenszwalb and Huttenlocher) to the mask's 0.5 contour,
        // inside positive, mapped so the contour reads 0.5, Max
        // distance inside 1 and Max distance outside 0. Max distance
        // in photograph pixels; 0 is the hard mask. Reach: Max
        // distance and a pixel.
        add(NodeSpec {
            type_name: "heeler.distance_field".into(),
            version: 1,
            label: "Signed Distance Field".into(),
            params: vec![num("max_distance", 20.0, 0.0, 200.0)],
            inputs: vec![PortSpec::new("in", PortKind::Mask, true)],
            outputs: vec![PortSpec::new("out", PortKind::Mask, false)],
        });

        // Chroma Key, basic: the Key color (red, green, blue as they
        // read on screen, 0..1; chroma key green #00B140 to start), its
        // distance measured in OkLab's chroma plane with lightness left
        // out (a pixel of the key's hue at least as colorful counts as
        // the key). Two type names because a node has one output: the
        // matte as a mask (0 on the key, 1 far from it; Tolerance keyed
        // out completely, Softness the ramp past it), and the picture
        // with the key's hue taken out by Spill (lightness kept, a
        // pixel leaning away from the key untouched). Pixel-local.
        let key_params = || {
            vec![
                num("key_r", 0.0, 0.0, 1.0),
                num("key_g", 0.694, 0.0, 1.0),
                num("key_b", 0.251, 0.0, 1.0),
            ]
        };
        add(NodeSpec {
            type_name: "heeler.chroma_key".into(),
            version: 1,
            label: "Chroma Key".into(),
            params: [key_params(), vec![num("tolerance", 0.05, 0.0, 0.5), num("softness", 0.1, 0.0, 0.5)]].concat(),
            inputs: vec![image_in()],
            outputs: vec![PortSpec::new("out", PortKind::Mask, false)],
        });
        add(NodeSpec {
            type_name: "heeler.chroma_key_despill".into(),
            version: 1,
            label: "Chroma Key (Despill)".into(),
            params: [key_params(), vec![num("spill", 1.0, 0.0, 1.0)]].concat(),
            inputs: vec![image_in(), mask_in()],
            outputs: vec![image_out()],
        });

        // Normals from Depth: a depth plane (or any height field) on
        // `in` as a normal map, unit normals packed (n + 1) / 2, in
        // Depth Lighting's convention (x right, y down, z toward the
        // viewer; flat is 0.5, 0.5, 1). Reads Depth (farness, the near
        // stands up) or Height (white up). Strength is how tall a full
        // step of the field stands in photograph pixels, so the slope
        // is per photograph pixel. Cliff: a jump between neighbors past
        // it is a seam, each side sloped from its own side (Depth
        // Lighting's measured-contract slope). Reach: one pixel.
        add(NodeSpec {
            type_name: "heeler.depth_normals".into(),
            version: 1,
            label: "Normals from Depth".into(),
            params: vec![
                choice("reads", "depth", &["depth", "height"]),
                num("strength", 2000.0, 0.0, 10000.0),
                num("cliff", 0.15, 0.0, 1.0),
            ],
            inputs: vec![PortSpec::new("in", PortKind::Mask, true)],
            outputs: vec![image_out()],
        });

        // Explicit Color Transform: the picture's numbers decoded from
        // a declared space and encoded in another, exactly: a gamut
        // (published primaries and white, Bradford between whites) and
        // a transfer (linear, the sRGB curve, ACEScct) each, one 3x3
        // matrix between, f64 inside, no OpenColorIO. A to B to A is
        // the identity. The spaces are equally honest answers, so an
        // unknown one is an error rather than a guess. Pixel-local.
        let spaces: &[&str] = &["linear_rec709", "srgb", "linear_rec2020", "acescg", "acescct", "aces2065_1", "linear_p3", "display_p3"];
        add(NodeSpec {
            type_name: "heeler.color_transform".into(),
            version: 1,
            label: "Color Transform".into(),
            params: vec![strict_choice("from", "linear_rec709", spaces), strict_choice("to", "acescg", spaces)],
            inputs: vec![image_in(), mask_in()],
            outputs: vec![image_out()],
        });

        // Displacement Map, bounded: the picture's pixels moved by the
        // fields on `x` and `y` (the card's mask and alpha diamonds),
        // 0.5 no move, 1 Strength photograph pixels right or down, 0
        // the same left or up, every move held to Max displacement;
        // bilinear reads; Edges is the warps' choice (Stretch, the
        // default and the old behavior, or Transparent past the frame,
        // ops_warp.rs's tap rule). A picture operation,
        // not frame geometry: masks read from ahead of it do not move
        // with it (the op's comment says why). Reach: the largest move
        // and a pixel.
        add(NodeSpec {
            type_name: "heeler.displacement_map".into(),
            version: 1,
            label: "Displacement Map".into(),
            params: vec![
                num("strength", 20.0, 0.0, 500.0),
                num("max_displacement", 50.0, 0.0, 500.0),
                // What a read past the frame shows, as the warps offer
                // it: the edge stretched across the gap, or nothing.
                choice("edges", "clamp", &["clamp", "transparent"]),
            ],
            inputs: vec![
                image_in(),
                PortSpec::new("x", PortKind::Mask, true),
                PortSpec::new("y", PortKind::Mask, true),
            ],
            outputs: vec![image_out()],
        });

        // The logic family (engine: ops_logic.rs). Measure turns the
        // picture into a field of numbers; compare, logic and math turn
        // fields into conditions; remap reshapes a field; conditional
        // spends a condition on a per-pixel if/then/else between two
        // images. Mask-kind input ports accept both Mask and Channel
        // wires, so fields and masks intermate freely. Every operand
        // port is optional: a half-wired logic node passes its wired
        // side through, and an unwired compare/remap answers a field of
        // nothing rather than sinking the render.
        add(NodeSpec {
            type_name: "heeler.measure".into(),
            version: 1,
            label: "Measure".into(),
            params: vec![
                choice(
                    "metric",
                    "luma",
                    // alpha (node recipes, 2026-09-30): the picture's
                    // transparency as a field, so a recipe that takes an
                    // image apart can hand Channel Join its alpha back.
                    &["luma", "red", "green", "blue", "hue", "chroma", "saturation", "alpha"],
                ),
                // Box-blur radius in pixels on the measured field, so a
                // condition keys on the region rather than the noise.
                num("smoothing", 0.0, 0.0, 100.0),
            ],
            inputs: vec![image_in()],
            outputs: vec![PortSpec::new("out", PortKind::Channel, false)],
        });
        add(NodeSpec {
            type_name: "heeler.compare".into(),
            version: 1,
            label: "Compare".into(),
            params: vec![
                // The operand is a constant level rather than a second
                // field on purpose: two-field comparisons are the idiom
                // math(subtract) -> compare(gt, 0), which keeps the
                // subtracted field visible on its own wire.
                strict_choice("op", "gt", &["lt", "le", "gt", "ge", "eq", "neq"]),
                num("level", 0.5, 0.0, 1.0),
                // Feather across the threshold; conditions on raw
                // channels tear along sensor noise without it.
                num("softness", 0.0, 0.0, 1.0),
            ],
            inputs: vec![PortSpec::new("in", PortKind::Mask, true)],
            outputs: vec![PortSpec::new("out", PortKind::Mask, false)],
        });
        add(NodeSpec {
            // Fuzzy gates (and=min, or=max, xor=|a-b|, subtract=a-b):
            // boolean on hard masks, sensible on feathered ones. NOT is
            // invert_mask's job, one way per thing. The second operand
            // rides "fg", the name the UI's second input port already
            // lands on for every two-input node.
            type_name: "heeler.logic".into(),
            version: 1,
            label: "Logic".into(),
            params: vec![strict_choice("op", "and", &["and", "or", "xor", "subtract"])],
            inputs: vec![
                PortSpec::new("in", PortKind::Mask, true),
                PortSpec::new("fg", PortKind::Mask, true),
            ],
            outputs: vec![PortSpec::new("out", PortKind::Mask, false)],
        });
        add(NodeSpec {
            // Field arithmetic. With "fg" unwired the constant param is
            // the second operand; with nothing wired the node is a
            // constant-field generator. Output is op(a,b)*scale+offset,
            // unclamped: fields may live outside 0..1 until a consumer
            // clamps them.
            type_name: "heeler.math".into(),
            version: 1,
            label: "Math".into(),
            params: vec![
                strict_choice(
                    "op",
                    "add",
                    &[
                        "add", "subtract", "multiply", "divide", "min", "max",
                        "difference", "power",
                    ],
                ),
                num("constant", 0.0, -1.0, 1.0),
                num("scale", 1.0, -4.0, 4.0),
                num("offset", 0.0, -1.0, 1.0),
            ],
            inputs: vec![
                PortSpec::new("in", PortKind::Mask, true),
                PortSpec::new("fg", PortKind::Mask, true),
            ],
            outputs: vec![PortSpec::new("out", PortKind::Channel, false)],
        });
        add(NodeSpec {
            // A levels control for fields: pull the [in_low, in_high]
            // window out to [out_low, out_high] with a gamma between
            // (Levels' convention: gamma 2 brightens). clamp off lets a
            // field overshoot for later math; on, the answer is a mask.
            type_name: "heeler.remap".into(),
            version: 1,
            label: "Remap".into(),
            params: vec![
                num("in_low", 0.0, 0.0, 1.0),
                num("in_high", 1.0, 0.0, 1.0),
                num("gamma", 1.0, 0.1, 10.0),
                num("out_low", 0.0, 0.0, 1.0),
                num("out_high", 1.0, 0.0, 1.0),
                flag("clamp", true),
            ],
            inputs: vec![PortSpec::new("in", PortKind::Mask, true)],
            outputs: vec![PortSpec::new("out", PortKind::Channel, false)],
        });
        add(NodeSpec {
            // if/then/else per pixel: "in" is the else branch, "fg" the
            // then branch, "mask" the condition. The op only chooses the
            // branch image; the executor's blend_through_mask performs
            // the per-pixel select, so a feathered condition crossfades
            // the branches. No condition wired = else; disabled = else.
            type_name: "heeler.conditional".into(),
            version: 1,
            label: "Conditional".into(),
            params: vec![],
            inputs: vec![
                image_in(),
                PortSpec::new("fg", PortKind::Image, true),
                mask_in(),
            ],
            outputs: vec![image_out()],
        });
        add(NodeSpec {
            // A color grader's range keyer: selects pixels inside a
            // hue/saturation/luminance window. Defaults select everything.
            type_name: "heeler.range_mask".into(),
            version: 1,
            label: "range".into(),
            params: vec![
                // The Depth block (2026-09-09): the mask multiplied by a window on the
                // photograph's farness plane, with its own near, far, feather and invert,
                // so one layer can invert the depth without touching another's. Percent
                // units, as the panel shows them.
                flag("depth_on", false),
                flag("depth_invert", false),
                // Levels on the plane, the layer's Depth widget.
                num("depth_black", 0.0, 0.0, 0.99),
                num("depth_white", 1.0, 0.01, 1.0),
                num("depth_gamma", 1.0, 0.1, 10.0),
                num("depth_black_soft", 0.0, 0.0, 100.0),
                num("depth_white_soft", 0.0, 0.0, 100.0),
                num("luma_low", 0.0, 0.0, 1.0),
                num("luma_high", 1.0, 0.0, 1.0),
                num("sat_low", 0.0, 0.0, 1.0),
                num("sat_high", 1.0, 0.0, 1.0),
                num("hue_center", 0.0, -180.0, 180.0),
                num("hue_width", 180.0, 0.0, 180.0),
                num("softness", 0.15, 0.0, 1.0),
                flag("invert", false),
            ],
            inputs: vec![image_in(), depth_in()],
            outputs: vec![PortSpec::new("out", PortKind::Mask, false)],
        });

        add(NodeSpec {
            // Region-of-interest support: crops a MASK with the image
            // crop's exact rectangle math, so a mask rasterized on the
            // full frame stays aligned with an image patch. Spliced in
            // by the ROI preview path; not a node anyone places by hand.
            type_name: "heeler.mask_crop".into(),
            version: 1,
            label: "mask crop".into(),
            params: vec![
                num("crop_x", 0.0, 0.0, 0.95),
                num("crop_y", 0.0, 0.0, 0.95),
                num("crop_w", 1.0, 0.05, 1.0),
                num("crop_h", 1.0, 0.05, 1.0),
            ],
            inputs: vec![PortSpec::new("in", PortKind::Mask, false)],
            outputs: vec![PortSpec::new("out", PortKind::Mask, false)],
        });

        add(NodeSpec {
            type_name: "heeler.color_bend".into(),
            version: 1,
            label: "Color Bend".into(),
            params: vec![
                // Source and destination points in the hue/saturation
                // disc: hue is the angle, saturation the radius.
                num("src_hue", 0.0, 0.0, 360.0),
                num("src_sat", 0.0, 0.0, 1.0),
                num("dst_hue", 0.0, 0.0, 360.0),
                num("dst_sat", 0.0, 0.0, 1.0),
                // How far from the source the pull still reaches, as a
                // distance across that disc.
                // A third of the wheel, not all of it. Reaching the
                // whole disc drew the reach ring exactly on top of the
                // wheel's own edge, so the control was invisible, and a
                // bend that reaches everything is a global hue shift
                // rather than a bend. Existing graphs carry their own
                // value and are untouched.
                num("falloff", 1.0 / 3.0, 0.15, 2.0),
                num("amount", 100.0, 0.0, 100.0),
            ],
            inputs: vec![image_in(), mask_in()],
            outputs: vec![image_out()],
        });

        add(NodeSpec {
            type_name: "heeler.split_tone".into(),
            version: 1,
            label: "Split Tone".into(),
            params: vec![
                num("shadow_hue", 0.0, -180.0, 180.0),
                num("shadow_sat", 0.0, -100.0, 100.0),
                num("highlight_hue", 0.0, -180.0, 180.0),
                num("highlight_sat", 0.0, -100.0, 100.0),
                num("balance", 0.0, -100.0, 100.0),
            ],
            inputs: vec![image_in(), mask_in()],
            outputs: vec![image_out()],
        });

        add(NodeSpec {
            // The print: the paper, display domain, last before Output. Grade or
            // the split pair with their times, the paper's Dmax and base, and
            // toning by density.
            type_name: "heeler.paper".into(),
            version: 1,
            label: "Print".into(),
            params: vec![
                num("grade", 2.0, 0.0, 5.0),
                num("time", 0.0, -2.0, 2.0),
                flag("split", false),
                num("soft", 0.0, -2.0, 2.0),
                num("hard", 0.0, -2.0, 2.0),
                num("dmax", 2.1, 1.4, 2.4),
                num("base", 0.0, -100.0, 100.0),
                // none | selenium | sepia | gold | split
                text("toner", ""),
                num("toning", 0.0, 0.0, 100.0),
                num("crossover", 50.0, 0.0, 100.0),
            ],
            inputs: vec![image_in(), mask_in()],
            outputs: vec![image_out()],
        });

        add(NodeSpec {
            type_name: "heeler.tone_profile".into(),
            version: 1,
            label: "Tone Profile".into(),
            params: vec![
                // linear | standard | film
                text("mode", "standard"),
                num("contrast", 100.0, 0.0, 200.0),
                // Development: a stock key (hp5, fp4, trix, tmax400, ortho) renders the
                // profile through that film's characteristic curve; empty is the modes
                // above. `development` walks the family in N steps.
                text("film", ""),
                num("development", 0.0, -2.0, 2.0),
                // How much of the over-range is pulled back into view.
                // Zero clips at scene white, which is what a photograph
                // off a single frame wants and what every existing edit
                // was made under. A merged HDR carries highlights several
                // times past white and needs a shoulder to show them.
                num("highlight_rolloff", 0.0, 0.0, 100.0),
                // The chroma component of the default rendering (ICC ): a constant
                // chroma factor around Rec.709 luma, visible like baseline_ev,
                // awaiting its calibration round against the reference editors to
                // pick the shipped value.
                num("colorfulness", 0.0, -100.0, 100.0),
                // Baseline exposure in stops, before the curve: the lift
                // the reference RAW editors apply quietly, made visible.
                // Registry default stays 0 so every saved graph renders
                // as it always did; the app's default graph carries the
                // shipped value.
                num("baseline_ev", 0.0, -3.0, 3.0),
                // Toe: restores black density after the baseline lift.
                num("shadow_toe", 0.0, 0.0, 100.0),
            ],
            inputs: vec![image_in(), mask_in()],
            outputs: vec![image_out()],
        });

        add(NodeSpec {
            type_name: "heeler.channel_extract".into(),
            version: 1,
            label: "Channel".into(),
            params: vec![
                // r | g | b | luma, the SHORT spellings: the engine
                // matches "r"/"g"/"b" and falls back to luma on anything
                // else, so "red" here would silently render luma.
                // Declared as a choice so the picker's list and the
                // engine's list cannot drift apart (the desktop's
                // picker cross-check holds them together).
                choice("channel", "luma", &["luma", "r", "g", "b"]),
            ],
            inputs: vec![image_in()],
            outputs: vec![image_out()],
        });

        add(NodeSpec {
            type_name: "heeler.selection_mask".into(),
            version: 1,
            label: "Selection Mask".into(),
            params: vec![
                // The Depth block (2026-09-09): the mask multiplied by a window on the
                // photograph's farness plane, with its own near, far, feather and invert,
                // so one layer can invert the depth without touching another's. Percent
                // units, as the panel shows them.
                flag("depth_on", false),
                flag("depth_invert", false),
                // Levels on the plane, the layer's Depth widget.
                num("depth_black", 0.0, 0.0, 0.99),
                num("depth_white", 1.0, 0.01, 1.0),
                num("depth_gamma", 1.0, 0.1, 10.0),
                num("depth_black_soft", 0.0, 0.0, 100.0),
                num("depth_white_soft", 0.0, 0.0, 100.0),
                // Editable geometry, as JSON. Paths and color keys with
                // an operation each, rasterized fresh at whatever size is
                // being rendered rather than baked into pixels.
                text("regions", "[]"),
                // Polish strokes, same idea. Undeclared, the app's
                // graph conversion dropped the param on the floor and
                // the polish brush painted into the void: the engine
                // honored strokes it could never receive.
                text("strokes", "[]"),
                // The ViTMatte refinement's recipe pointer (P4): empty
                // means never refined; otherwise the version hash of
                // (image, node, regions) the desktop computed the
                // matte for. The desktop plants the raster only while
                // this matches the CURRENT regions, so an edited
                // selection falls back to classical geometry instead
                // of wearing a stale matte.
                text("matte_id", ""),
                num("feather", 0.0, 0.0, 1.0),
                // The polish controls. Grow is bipolar: negative shrinks.
                num("grow", 0.0, -1.0, 1.0),
                num("smooth", 0.0, 0.0, 1.0),
                flag("invert", false),
                // On: a staircase edge is a worse default than a soft
                // one, and every selection here is geometry rendered
                // fresh at whatever size is being asked for.
                flag("antialias", true),
                // Border width: how far out the refinement looks, as a
                // percentage. A layer editor's default is 10%.
                num("border_width", 10.0, 0.0, 100.0),
                // Ramp: sharpens the partial-alpha transition and biases
                // it in or out, leaving solid areas alone. Another layer
                // editor needs Contrast plus Shift Edge to say this, and those
                // can eat into the interior. This cannot.
                num("ramp", 0.0, -100.0, 100.0),
                // The Polish panel's two matte dials (2026-09-22). Contrast: how
                // decided the refined edge reads, applied live to the planted base.
                // Reach: how far the brush follows hair past the stroke, part of the
                // matte's recipe, so a change re-reads the edge. Defaults half way
                // between 26.3.0's fixed behavior (no contrast, a chase through every
                // trace) and the first fix's (a quarter-to-three-quarters stretch, a
                // chase through nothing under a half): 2026-09-22.
                num("matte_contrast", 25.0, 0.0, 100.0),
                num("matte_reach", 50.0, 0.0, 100.0),
                // Feather follows the picture (2026-09-23): the feather guided by
                // the photograph, so hair and fur keep their shape where the
                // picture has an edge.
                flag("feather_guided", false),
            ],
            inputs: vec![image_in(), depth_in()],
            outputs: vec![PortSpec::new("out", PortKind::Mask, false)],
        });

        add(NodeSpec {
            type_name: "heeler.radial_mask".into(),
            version: 1,
            label: "Radial Mask".into(),
            params: vec![
                // The Depth block (2026-09-09): the mask multiplied by a window on the
                // photograph's farness plane, with its own near, far, feather and invert,
                // so one layer can invert the depth without touching another's. Percent
                // units, as the panel shows them.
                flag("depth_on", false),
                flag("depth_invert", false),
                // Levels on the plane, the layer's Depth widget.
                num("depth_black", 0.0, 0.0, 0.99),
                num("depth_white", 1.0, 0.01, 1.0),
                num("depth_gamma", 1.0, 0.1, 10.0),
                num("depth_black_soft", 0.0, 0.0, 100.0),
                num("depth_white_soft", 0.0, 0.0, 100.0),
                // The center may sit off the frame: a crop that leaves
                // the subject outside carries the oval with it (the
                // stroke remap, framemap.ts), and a slider starting at
                // zero would make zero a hard floor (hard_limits).
                num("center_x", 0.5, -1.0, 2.0),
                num("center_y", 0.5, -1.0, 2.0),
                num("radius", 0.4, 0.01, 1.0),
                num("feather", 0.3, 0.0, 1.0),
                // Empty, not "ellipse", and that is load-bearing. The
                // app fills every registry default before executing, so
                // the presence of this key says nothing about how old a
                // graph is; only its VALUE survives from the save file.
                // Empty means "a radial mask from before shapes", which
                // renders on the old metric. See radial_mask.
                text("shape", ""),
                num("aspect", 1.0, 0.1, 10.0),
                num("rotation", 0.0, -180.0, 180.0),
                // One knob whose meaning follows the shape: the arms of
                // a cross, the bite out of a crescent, the taper of a
                // trapeze. The round shapes ignore it.
                num("shape_amount", 0.5, 0.0, 1.0),
                flag("invert", false),
            ],
            inputs: vec![image_in(), depth_in()],
            outputs: vec![PortSpec::new("out", PortKind::Mask, false)],
        });

        add(NodeSpec {
            type_name: "heeler.linear_mask".into(),
            version: 1,
            label: "Linear Mask".into(),
            params: vec![
                // The Depth block (2026-09-09): the mask multiplied by a window on the
                // photograph's farness plane, with its own near, far, feather and invert,
                // so one layer can invert the depth without touching another's. Percent
                // units, as the panel shows them.
                flag("depth_on", false),
                flag("depth_invert", false),
                // Levels on the plane, the layer's Depth widget.
                num("depth_black", 0.0, 0.0, 0.99),
                num("depth_white", 1.0, 0.01, 1.0),
                num("depth_gamma", 1.0, 0.1, 10.0),
                num("depth_black_soft", 0.0, 0.0, 100.0),
                num("depth_white_soft", 0.0, 0.0, 100.0),
                num("angle", 90.0, -180.0, 180.0),
                // Off the frame too, after a crop (as center_x above).
                num("position", 0.5, -1.0, 2.0),
                num("span", 0.25, 0.02, 1.0),
                flag("invert", false),
            ],
            inputs: vec![image_in(), depth_in()],
            outputs: vec![PortSpec::new("out", PortKind::Mask, false)],
        });

        add(NodeSpec {
            type_name: "heeler.color_range_mask".into(),
            version: 1,
            label: "Color Range Mask".into(),
            params: vec![
                text("color", "#ffffff"),
                num("range", 0.2, 0.0, 1.0),
                num("falloff", 0.1, 0.0, 1.0),
                flag("invert", false),
            ],
            inputs: vec![image_in()],
            outputs: vec![PortSpec::new("out", PortKind::Mask, false)],
        });

        // The three depth tools. Each reads the photograph's computed
        // FARNESS plane (0 near, 1 far; Depth Anything V2 Small,
        // desktop-cached, executor-injected like the smart-mask
        // rasters). No raster, no depth: every one of them is a
        // perfect passthrough at neutral params AND without its
        // raster, so a machine without the model renders the
        // photograph plainly instead of erroring.
        add(NodeSpec {
            // The depth map's own settings (2026-09-05): how the farness plane
            // every depth tool reads is refined against the photograph. The engine
            // passes the picture through untouched; the desktop reads these params
            // when it computes and caches the plane. Edges snaps the model's
            // stretched cliffs onto the picture's edges (the embossed rims around
            // a close subject); Flatten takes the ripples the model invents out of
            // what the picture shows as flat.
            type_name: "heeler.depth_map".into(),
            version: 1,
            label: "Depth Map".into(),
            params: vec![
                num("edges", 50.0, 0.0, 100.0),
                num("flatten", 25.0, 0.0, 100.0),
                // The share of the picture folded into "nearest" and
                // "farthest", for a scene where one close thing eats
                // the range or the far end is one flat wall.
                num("near_clip", 0.0, 0.0, 40.0),
                num("far_clip", 0.0, 0.0, 40.0),
                // The model's working size on the long edge: 518 is
                // its own; 700 and 1036 buy finer edges at attention's
                // quadratic price. Snapped to those three.
                num("size", 518.0, 518.0, 1036.0),
                // The map's own Levels (2026-09-13): applied desktop-side to the
                // plane every depth reader is handed, ahead of each reader's own.
                num("depth_black", 0.0, 0.0, 0.99),
                num("depth_white", 1.0, 0.01, 1.0),
                num("depth_gamma", 1.0, 0.1, 10.0),
                num("depth_black_soft", 0.0, 0.0, 100.0),
                num("depth_white_soft", 0.0, 0.0, 100.0),
            ],
            inputs: vec![image_in()],
            // The plane as a graph value (26.3 Phase 4): the same
            // farness raster the `{id}@depth` slot carries, 0 near ..
            // 1 far after Edges/Flatten/clips, so a channel or logic
            // node can wire depth without a special case. The image
            // passthrough stays the primary output.
            outputs: vec![image_out(), PortSpec::new("depth", PortKind::Mask, false)],
        });
        add(NodeSpec {
            // Atmosphere: the picture mixes toward a fog color by
            // farness, 1-exp falloff, with optional far desaturation
            // (aerial perspective).
            type_name: "heeler.fog".into(),
            version: 1,
            label: "Fog".into(),
            params: vec![
                num("density", 0.0, 0.0, 100.0),
                // Where fog begins, in farness: 0 at the lens, 100
                // only at the far limit.
                num("start", 0.0, 0.0, 100.0),
                // How the fog arrives: 50 is a straight ramp, lower front-loads it,
                // higher holds it off then rolls it in late ("it needs
                // a falloff so the effect tapers off better").
                num("falloff", 50.0, 0.0, 100.0),
                // Drifts in the veil: fractal noise on the thickness,
                // with its own wavelength and a walk through the
                // field so no two fogs need look alike.
                num("texture", 0.0, 0.0, 100.0),
                num("texture_size", 30.0, 0.0, 100.0),
                num("texture_shift", 0.0, 0.0, 100.0),
                // The veil's own brightness: low is night haze and
                // smoke, which darkens what it covers.
                num("fog_level", 72.0, 0.0, 100.0),
                num("fog_hue", 220.0, 0.0, 360.0),
                num("fog_sat", 10.0, 0.0, 100.0),
                num("desat", 0.0, 0.0, 100.0),
                // Levels on the plane as this section reads it (2026-09-13), the
                // layers' Depth widget on the tool.
                num("depth_black", 0.0, 0.0, 0.99),
                num("depth_white", 1.0, 0.01, 1.0),
                num("depth_gamma", 1.0, 0.1, 10.0),
                num("depth_black_soft", 0.0, 0.0, 100.0),
                num("depth_white_soft", 0.0, 0.0, 100.0),
            ],
            inputs: vec![image_in(), mask_in(), depth_in()],
            outputs: vec![image_out()],
        });
        add(NodeSpec {
            // A positioned main light over the depth heightfield: 2.5D
            // normals from the farness gradient, Lambert-shaded. Named
            // for the film set's key light - "Relight" was taken by
            // the tone equalizer.
            type_name: "heeler.key_light".into(),
            version: 1,
            label: "Depth Lighting".into(),
            params: vec![
                // Signed, like the rig JSON's strengths: negative is the owner's
                // color-grader dark light, the lit flanks darkening instead of
                // brightening. The op has always read it signed and the UI slider runs
                // -200..200; a 0..100 spec clamped every negative legacy light to zero
                // at graph build, silently dropping the dark.
                num("strength", 0.0, -200.0, 200.0),
                // Degrees: 0 lights from the right, 90 from above.
                num("azimuth", 45.0, -180.0, 180.0),
                num("elevation", 45.0, 5.0, 90.0),
                num("ambient", 50.0, 0.0, 100.0),
                // How much height the depth gradient is worth: the
                // relative map has no scale of its own.
                num("relief", 30.0, 1.0, 100.0),
                // Flip the heightfield: the BACKGROUND becomes the lit relief (the
                // owner's color-grader workflow). A flag, like every other invert: the
                // UI serializes flag-named params as JSON booleans, and build_graph
                // only accepts a boolean for a param the registry declares boolean.
                // Declared as a number, this one was dropped at graph build and Invert
                // was dead in the app while every direct-param op test passed.
                flag("invert", false),
                // Additional lights beyond the params' own: JSON
                // [{azimuth, elevation, strength}], strength signed -
                // negative is the dark light.
                text("lights", "[]"),
                // The surface normals a render wrote into its own file, in place of the
                // ones estimated from the depth map: auto uses them when the file also
                // says which way its camera faces, camera takes the pass as camera space
                // already, off shades from the depth map alone. The desktop plants the
                // pass as a second raster, `{id}@normal`.
                strict_choice("normals", "auto", &["auto", "camera", "off"]),
                // Levels on the plane as this section reads it (2026-09-13), the
                // layers' Depth widget on the tool.
                num("depth_black", 0.0, 0.0, 0.99),
                num("depth_white", 1.0, 0.01, 1.0),
                num("depth_gamma", 1.0, 0.1, 10.0),
                num("depth_black_soft", 0.0, 0.0, 100.0),
                num("depth_white_soft", 0.0, 0.0, 100.0),
            ],
            inputs: vec![image_in(), mask_in(), depth_in()],
            outputs: vec![image_out()],
        });
        add(NodeSpec {
            // Depth of field: blur grows with distance from a chosen
            // focal plane (in farness).
            type_name: "heeler.dof".into(),
            version: 1,
            label: "Depth of Field".into(),
            params: vec![
                num("aperture", 0.0, 0.0, 100.0),
                num("focus", 0.0, 0.0, 100.0),
                // The lens's own vices ("I don't care about
                // cost, the ROI with user will be well worth it").
                num("blades", 6.0, 3.0, 9.0),
                num("blade_curve", 100.0, 0.0, 100.0),
                num("fringe", 0.0, 0.0, 100.0),
                num("field_curve", 0.0, -100.0, 100.0),
                num("glow", 0.0, 0.0, 100.0),
                // The disc's character: the soap-bubble rim, the anamorphic squeeze,
                // the swirl.
                num("bubble", 0.0, 0.0, 100.0),
                num("squeeze", 0.0, -100.0, 100.0),
                num("swirl", 0.0, 0.0, 100.0),
                // The lens character the photograph last took (the id
                // of the preset), stamped here because every character
                // writes this node; the engine ignores it.
                text("character", ""),
            ],
            inputs: vec![image_in(), mask_in(), depth_in()],
            outputs: vec![image_out()],
        });

        add(NodeSpec {
            // Lens flare: the lens's signature for the Depth Lighting rig's
            // flaring lights, added in scene-linear light after Depth of Field.
            type_name: "heeler.flare".into(),
            version: 1,
            label: "Lens Flare".into(),
            params: vec![
                num("intensity", 100.0, 0.0, 300.0),
                num("temp", 0.0, -100.0, 100.0),
                num("size", 6.0, 0.0, 30.0),
                num("softness", 50.0, 0.0, 100.0),
                num("rays", 0.0, 0.0, 32.0),
                num("ray_length", 30.0, 0.0, 100.0),
                num("ray_softness", 30.0, 0.0, 100.0),
                num("rotation", 0.0, 0.0, 360.0),
                num("ghosts", 0.0, 0.0, 16.0),
                num("ghost_spacing", 100.0, 10.0, 200.0),
                num("ghost_size", 6.0, 0.0, 30.0),
                num("blades", 7.0, 3.0, 12.0),
                num("dispersion", 30.0, 0.0, 100.0),
                num("ghost_opacity", 60.0, 0.0, 100.0),
                num("anamorphic", 0.0, 0.0, 100.0),
                // The streak's shape (percent of the short side where a
                // length), its taper, angle, offset from the source
                // along and across its axis, and its internal grain.
                num("streak_size", 1.5, 0.2, 8.0),
                num("streak_length", 60.0, 10.0, 300.0),
                num("streak_taper", 30.0, 0.0, 100.0),
                num("streak_angle", 0.0, -90.0, 90.0),
                num("streak_offset", 0.0, -50.0, 50.0),
                num("streak_shift", 0.0, -50.0, 50.0),
                // Breakup: the streak swelling and thinning, denser and
                // sparser, along its length.
                num("streak_noise", 0.0, 0.0, 100.0),
                num("veil", 20.0, 0.0, 100.0),
                num("veil_radius", 40.0, 5.0, 100.0),
                num("veil_depth", 0.0, -100.0, 100.0),
                num("occlusion", 100.0, 0.0, 100.0),
                num("occlusion_soft", 30.0, 0.0, 100.0),
                // The patch of the full frame this render is (the ROI
                // splice writes these; whole frame otherwise).
                num("roi_x", 0.0, 0.0, 1.0),
                num("roi_y", 0.0, 0.0, 1.0),
                num("roi_w", 1.0, 0.0, 1.0),
                num("roi_h", 1.0, 0.0, 1.0),
                // The rig, mirrored from Depth Lighting by the panel,
                // with each light's flare toggle and strength.
                text("lights", "[]"),
                text("streak_color", "#5aa0ff"),
                // The ribbon: the gradient layer's stop list, from the
                // source (0) to the streak's end (100); empty means the
                // single streak_color.
                text("streak_stops", ""),
                text("preset", ""),
            ],
            inputs: vec![image_in(), mask_in(), depth_in()],
            outputs: vec![image_out()],
        });
        add(NodeSpec {
            // Halation: highlights bleed a colored mist, gated by dark
            // surroundings, after Depth of Field in scene-linear light.
            type_name: "heeler.halation".into(),
            version: 1,
            label: "Halation".into(),
            params: vec![
                num("threshold", 50.0, 0.0, 100.0),
                num("background", 50.0, 0.0, 100.0),
                num("by_depth", 0.0, -100.0, 100.0),
                num("radius", 4.0, 0.5, 30.0),
                num("diffusion", 60.0, 0.0, 100.0),
                num("hue", 18.0, 0.0, 360.0),
                num("saturation", 70.0, 0.0, 100.0),
                num("blue_comp", 0.0, 0.0, 100.0),
                num("amount", 100.0, 0.0, 300.0),
                num("mix", 100.0, 0.0, 100.0),
                num("bloom", 0.0, 0.0, 100.0),
                num("bloom_radius", 20.0, 5.0, 60.0),
                num("roi_x", 0.0, 0.0, 1.0),
                num("roi_y", 0.0, 0.0, 1.0),
                num("roi_w", 1.0, 0.0, 1.0),
                num("roi_h", 1.0, 0.0, 1.0),
                // 8mm, 16mm, 35mm, 65mm: a smaller gauge is enlarged more.
                text("format", "35mm"),
                // "source" renders the gated source instead of the frame:
                // the isolated-regions view. View state, written by the
                // render path, never saved.
                text("view", ""),
            ],
            inputs: vec![image_in(), mask_in(), depth_in()],
            outputs: vec![image_out()],
        });
        add(NodeSpec {
            // Mask-driven inpainting: the model's fill for the hole a mask
            // describes. The mask port IS the hole - brush strokes, a Smart
            // selection, a Finish selection, any mask wire drives it - and the
            // executor's generic mask blending does the compositing, so this op
            // only serves the desktop-computed raster. fill_id is the recipe
            // pointer: the desktop writes it when a fill lands, and the cache keys
            // by it.
            type_name: "heeler.inpaint".into(),
            version: 1,
            label: "Inpaint".into(),
            params: vec![
                text("fill_id", ""),
                text("model", ""),
                // Two lives, one op. "wire": the chain-spliced Remove,
                // whose raster must die with its mask wire (no hole,
                // no fill). "layer": a Finish Fill layer's content,
                // where the LAYER's own mask gates visibility at the
                // blend and the raster may serve unmasked.
                strict_choice("hole", "wire", &["wire", "layer"]),
            ],
            inputs: vec![image_in(), mask_in()],
            outputs: vec![image_out()],
        });

        add(NodeSpec {
            // Object matte: the mask a renderer wrote into the photograph's own file,
            // as an ordinary mask node. The params are the RECIPE, which Cryptomatte
            // layer and which names, or which plain channel; the desktop reads the
            // coverage out of the OpenEXR and the executor injects it as the raster,
            // exactly as a Smart Mask is fed. A photograph without the file renders
            // it empty.
            type_name: "heeler.matte_mask".into(),
            version: 1,
            label: "Object Mask".into(),
            params: vec![
                flag("depth_on", false),
                flag("depth_invert", false),
                num("depth_black", 0.0, 0.0, 0.99),
                num("depth_white", 1.0, 0.01, 1.0),
                num("depth_gamma", 1.0, 0.1, 10.0),
                num("depth_black_soft", 0.0, 0.0, 100.0),
                num("depth_white_soft", 0.0, 0.0, 100.0),
                // The Cryptomatte layer the names belong to (a file may
                // carry objects and materials), or empty for a plain
                // channel named in `names`.
                text("layer", ""),
                // JSON: ["Suzanne", "CubeGreen"], names from the layer's
                // manifest, or the one channel name.
                text("names", "[]"),
                // Shapes drawn on the mask with the selection tools, as
                // a selection's regions (JSON), combined onto the file's
                // coverage in order, by each one's op.
                text("regions", "[]"),
                num("feather", 0.0, 0.0, 100.0),
                flag("invert", false),
            ],
            inputs: vec![image_in(), depth_in()],
            outputs: vec![PortSpec::new("out", PortKind::Mask, false)],
        });
        add(NodeSpec {
            // Smart selection: the mask an ML model computed, as an ordinary mask
            // node. The params are the RECIPE (mode, the clicks, which model),
            // never the pixels: the desktop caches the raster and the executor
            // injects it, so graphs stay small and a machine without the model
            // renders the mask empty with a badge rather than erroring the
            // render.
            type_name: "heeler.smart_mask".into(),
            version: 1,
            label: "Smart Mask".into(),
            params: vec![
                // The Depth block (2026-09-09): the mask multiplied by a window on the
                // photograph's farness plane, with its own near, far, feather and invert,
                // so one layer can invert the depth without touching another's. Percent
                // units, as the panel shows them.
                flag("depth_on", false),
                flag("depth_invert", false),
                // Levels on the plane, the layer's Depth widget.
                num("depth_black", 0.0, 0.0, 0.99),
                num("depth_white", 1.0, 0.01, 1.0),
                num("depth_gamma", 1.0, 0.1, 10.0),
                num("depth_black_soft", 0.0, 0.0, 100.0),
                num("depth_white_soft", 0.0, 0.0, 100.0),
                strict_choice("mode", "click", &["click", "subject", "sky"]),
                // JSON: [{"x":..,"y":..,"positive":true}, ...] in
                // 0..1 normalized image coordinates.
                text("prompts", "[]"),
                // Which model produced the raster, for honesty and
                // cache keying; empty until one has.
                text("model", ""),
                // Shapes drawn on the mask with the selection tools (2026-10-02), as a
                // selection's regions (JSON): combined onto the model's cut in order, by
                // each one's op, so a Subtract takes an over-selected part out. Not part
                // of the recipe: the model's raster does not depend on them.
                text("regions", "[]"),
                num("threshold", 50.0, 0.0, 100.0),
                num("feather", 0.0, 0.0, 100.0),
                num("expand", 0.0, -100.0, 100.0),
                flag("invert", false),
            ],
            inputs: vec![image_in(), depth_in()],
            outputs: vec![PortSpec::new("out", PortKind::Mask, false)],
        });

        add(NodeSpec {
            // Hue-band selection in OkLCh: pick a range of hue with a smooth
            // falloff, chroma-gated so neutrals never select. Degrees of OkLab
            // hue angle.
            type_name: "heeler.hue_range_mask".into(),
            version: 1,
            label: "Hue Range Mask".into(),
            params: vec![
                num("band_center", 30.0, 0.0, 360.0),
                num("hue_range", 60.0, 0.0, 180.0),
                num("hue_falloff", 30.0, 0.0, 120.0),
                flag("invert", false),
                // The Depth mask block a layer's mask carries, at the foot of every
                // Color Set (2026-09-13): the set's own switch, Levels on the plane,
                // and Invert.
                flag("depth_on", false),
                flag("depth_invert", false),
                num("depth_black", 0.0, 0.0, 0.99),
                num("depth_white", 1.0, 0.01, 1.0),
                num("depth_gamma", 1.0, 0.1, 10.0),
                num("depth_black_soft", 0.0, 0.0, 100.0),
                num("depth_white_soft", 0.0, 0.0, 100.0),
            ],
            inputs: vec![image_in(), depth_in()],
            outputs: vec![PortSpec::new("out", PortKind::Mask, false)],
        });

        add(NodeSpec {
            // The Color Set grade: hue shift, chroma and uniformity in
            // OkLCh, exposure as a scene-linear gain. band_center feeds
            // uniformity's target; a Develop Color Set keeps it in step
            // with its mask's center.
            type_name: "heeler.color_grade".into(),
            version: 1,
            label: "Color Grade".into(),
            params: vec![
                num("hue_shift", 0.0, -180.0, 180.0),
                num("saturation", 0.0, -100.0, 100.0),
                // Saturation weighted toward the set's LESS saturated
                // pixels, the Console's own convention, so rich color
                // does not clip while the pale catches up.
                num("vibrance", 0.0, -100.0, 100.0),
                num("exposure", 0.0, -3.0, 3.0),
                num("uniformity", 0.0, 0.0, 100.0),
                num("band_center", 30.0, 0.0, 360.0),
                // The expert curves face (spec-color-sets.md): the three
                // grades as hue-indexed EQ curves, one JSON map. Empty
                // means flat, and every graph saved before this param
                // existed still means what it meant.
                text("curves", ""),
            ],
            inputs: vec![image_in(), mask_in()],
            outputs: vec![image_out()],
        });

        add(NodeSpec {
            // CAT16 chromatic adaptation: source illuminant to the D65 working
            // white. Mixed lighting is the mask input.
            type_name: "heeler.chromatic_adapt".into(),
            version: 1,
            label: "Chromatic Adaptation".into(),
            params: vec![
                choice("illuminant", "custom", &["custom", "d65", "d50", "a", "f2"]),
                num("temperature", 6500.0, 1667.0, 25000.0),
                num("strength", 100.0, 0.0, 100.0),
            ],
            inputs: vec![image_in(), mask_in()],
            outputs: vec![image_out()],
        });

        add(NodeSpec {
            // The full 3x3 that Channel Gain is one diagonal cell of;
            // preserve_gray renormalizes rows so neutrals hold.
            type_name: "heeler.channel_mixer".into(),
            version: 1,
            label: "Channel Mixer".into(),
            params: vec![
                num("mix_rr", 100.0, -200.0, 200.0),
                num("mix_rg", 0.0, -200.0, 200.0),
                num("mix_rb", 0.0, -200.0, 200.0),
                num("mix_gr", 0.0, -200.0, 200.0),
                num("mix_gg", 100.0, -200.0, 200.0),
                num("mix_gb", 0.0, -200.0, 200.0),
                num("mix_br", 0.0, -200.0, 200.0),
                num("mix_bg", 0.0, -200.0, 200.0),
                num("mix_bb", 100.0, -200.0, 200.0),
                // Numeric like `invert` and the other switches the
                // sliders write: 1 is on.
                num("preserve_gray", 1.0, 0.0, 1.0),
            ],
            inputs: vec![image_in(), mask_in()],
            outputs: vec![image_out()],
        });

        add(NodeSpec {
            // A .cube 3D LUT from disk, applied in display-encoded space. The
            // path rides as a parameter; the file itself never enters the graph.
            type_name: "heeler.lut".into(),
            version: 1,
            label: "3D LUT".into(),
            params: vec![text("path", ""), num("amount", 100.0, 0.0, 100.0)],
            inputs: vec![image_in(), mask_in()],
            outputs: vec![image_out()],
        });

        add(NodeSpec {
            // Per-hue-family grading strips (the Color Tune): six
            // fixed bands on the primary/secondary hues plus custom
            // picked bands, all riding in one JSON list.
            type_name: "heeler.color_console".into(),
            version: 1,
            label: "Color Tune".into(),
            params: vec![text("bands", ""), num("smoothing", 50.0, 0.0, 100.0)],
            inputs: vec![image_in(), mask_in()],
            outputs: vec![image_out()],
        });

        add(NodeSpec {
            // The channel-routing color EQ (Recolor): curves indexed by
            // hue, sat, or lum, adjusting hue, sat, or lum, evaluated
            // in parallel against the original channels. The curves
            // ride as one JSON map.
            type_name: "heeler.recolor".into(),
            version: 1,
            label: "Recolor".into(),
            params: vec![
                text("curves", ""),
                num("neutral_guard", 10.0, 0.0, 100.0),
                num("smoothing", 50.0, 0.0, 100.0),
                // The Around row's reach: how far out the surroundings
                // are averaged, in percent of the short side.
                num("around_radius", 15.0, 2.0, 50.0),
                // The Mask row's source: the id of a mask node in the
                // graph, wired to the "by" port by the serializer.
                text("by_mask", ""),
                // The hue→hue cell's verb: "" or "shift" turns hues by
                // the curve's degrees; "spread" reads the curve as local
                // hue contrast, +100 doubling the separation of
                // neighboring hues there, -100 merging them.
                text("hue_hue_mode", ""),
                // The two-input surfaces (Hue × Lum → each output): a
                // JSON map of 5 rows (EV -6..+3) by 12 columns (every
                // 30° of hue), in the output's own units.
                text("surfaces", ""),
            ],
            // "by" is a mask read as an INDEX (the Mask row's x-axis), distinct from
            // "mask", which gates the whole node. "ref": the color the hue and
            // saturation axes INDEX by, when it is not the picture itself: below a
            // black and white conversion the picture is gray and has no hue to key
            // on, so the serializer wires the conversion's input here. Adjustments
            // still land on the picture; only the lookup reads the reference.
            inputs: vec![image_in(), mask_in(), PortSpec::new("by", PortKind::Mask, true), PortSpec::new("ref", PortKind::Image, true), depth_in()],
            outputs: vec![image_out()],
        });

        add(NodeSpec {
            // The zone system with sliders: per-illuminance exposure, nine zones
            // one EV apart around middle gray. In the default graph as an
            // identity, like Lens Correction.
            type_name: "heeler.tone_eq".into(),
            version: 1,
            label: "Relight".into(),
            params: vec![
                num("ev_m4", 0.0, -2.0, 2.0),
                num("ev_m3", 0.0, -2.0, 2.0),
                num("ev_m2", 0.0, -2.0, 2.0),
                num("ev_m1", 0.0, -2.0, 2.0),
                num("ev_0", 0.0, -2.0, 2.0),
                num("ev_p1", 0.0, -2.0, 2.0),
                num("ev_p2", 0.0, -2.0, 2.0),
                num("ev_p3", 0.0, -2.0, 2.0),
                num("ev_p4", 0.0, -2.0, 2.0),
                num("smoothing", 50.0, 0.0, 100.0),
                // The parametric face (the owner's EQ redesign): free points with
                // optional tangents, as JSON. When present it replaces the nine fixed
                // zones above, which remain the no-points fallback so old graphs render
                // unchanged.
                text("points", ""),
                // Slides the photo's tones through the curve's window.
                num("range_shift", 0.0, -4.0, 4.0),
            ],
            inputs: vec![image_in(), mask_in()],
            outputs: vec![image_out()],
        });

        add(NodeSpec {
            // The scene-to-display rendering as an explicit node with selectable
            // published curves. Meant in place of the Tone Profile, not on top of
            // it; the graph shows whichever is doing the rendering.
            type_name: "heeler.view_transform".into(),
            version: 1,
            label: "View Transform".into(),
            params: vec![
                choice("mode", "sigmoid", &["sigmoid", "filmic", "agx", "aces"]),
                num("exposure_ev", 0.0, -4.0, 4.0),
                num("contrast", 100.0, 25.0, 300.0),
                num("white_ev", 6.0, 1.0, 10.0),
            ],
            inputs: vec![image_in(), mask_in()],
            outputs: vec![image_out()],
        });

        add(NodeSpec {
            // The shared constant-luminance soft clip as a placeable
            // node; the gamut warning's one-click fix inserts it.
            type_name: "heeler.gamut_map".into(),
            version: 1,
            label: "Gamut Map".into(),
            params: vec![num("amount", 100.0, 0.0, 100.0)],
            inputs: vec![image_in(), mask_in()],
            outputs: vec![image_out()],
        });

        add(NodeSpec {
            type_name: "heeler.brush_mask".into(),
            version: 1,
            label: "Brush Mask".into(),
            params: vec![
                text("strokes", "[]"),
                flag("invert", false),
                // A pixel mask's base (2026-09-30): a selection made into
                // a layer's mask is its coverage rendered once and kept
                // as a bake this points at ("baked:<hex>", planted on the
                // raster slot), which the strokes paint over.
                text("matte_id", ""),
                // A layer mask saved as a live selection before then: the
                // selection's recipe, frozen, as JSON. The desktop lays it
                // out for the engine; nothing edits it.
                text("base_selection", ""),
                // Lay the base in as its complement, so a Finish mask
                // keeps Add layer mask's polarity (inverted) and still
                // shows the selection.
                flag("base_invert", false),
                // The Depth block (2026-09-09): the mask multiplied by a window on the
                // photograph's farness plane, with its own near, far, feather and invert,
                // so one layer can invert the depth without touching another's. Percent
                // units, as the panel shows them.
                flag("depth_on", false),
                flag("depth_invert", false),
                // Levels on the plane, the layer's Depth widget.
                num("depth_black", 0.0, 0.0, 0.99),
                num("depth_white", 1.0, 0.01, 1.0),
                num("depth_gamma", 1.0, 0.1, 10.0),
                num("depth_black_soft", 0.0, 0.0, 100.0),
                num("depth_white_soft", 0.0, 0.0, 100.0),
            ],
            inputs: vec![image_in(), depth_in()],
            outputs: vec![PortSpec::new("out", PortKind::Mask, false)],
        });

        add(NodeSpec {
            // Art-layer paint: RGBA strokes over a transparent canvas
            // sized to the input. Colors are display-encoded; the layer
            // stack composites between to_display and to_scene. The
            // roi_* params are set by the ROI preview path, never by a
            // person.
            type_name: "heeler.paint".into(),
            version: 1,
            label: "Paint".into(),
            params: vec![
                text("strokes", "[]"),
                // Strokes carrying a source offset clone; this is the
                // default for whether they also match the destination's
                // tone, which each stroke may override.
                flag("heal", false),
                num("roi_x", 0.0, 0.0, 0.95),
                num("roi_y", 0.0, 0.0, 0.95),
                num("roi_w", 1.0, 0.05, 1.0),
                num("roi_h", 1.0, 0.05, 1.0),
            ],
            inputs: vec![image_in(), clip_in()],
            outputs: vec![image_out()],
        });

        add(NodeSpec {
            // Clone stamp, and healing when the flag is set. Strokes
            // carry their own source offset, so a repair is replayable
            // data rather than baked pixels and survives a re-develop.
            type_name: "heeler.clone".into(),
            version: 1,
            label: "Clone / Heal".into(),
            params: vec![
                text("strokes", "[]"),
                flag("heal", false),
                num("roi_x", 0.0, 0.0, 0.95),
                num("roi_y", 0.0, 0.0, 0.95),
                num("roi_w", 1.0, 0.05, 1.0),
                num("roi_h", 1.0, 0.05, 1.0),
            ],
            inputs: vec![image_in()],
            outputs: vec![image_out()],
        });

        add(NodeSpec {
            // What "Selection to layer" makes: the picture below, carried
            // as this layer's own pixels, so the layer holds an
            // instruction rather than a second copy of the frame.
            type_name: "heeler.lift".into(),
            version: 1,
            label: "Lift".into(),
            params: vec![],
            inputs: vec![image_in()],
            outputs: vec![image_out()],
        });

        add(NodeSpec {
            type_name: "heeler.fill".into(),
            version: 1,
            label: "Fill".into(),
            params: vec![text("color", "#808080")],
            inputs: vec![image_in()],
            outputs: vec![image_out()],
        });

        add(NodeSpec {
            type_name: "heeler.gradient".into(),
            version: 1,
            label: "Gradient".into(),
            params: vec![
                text("color_a", "#000000"),
                text("color_b", "#ffffff"),
                num("alpha_a", 100.0, 0.0, 100.0),
                num("alpha_b", 100.0, 0.0, 100.0),
                num("angle", 0.0, -180.0, 180.0),
                // "linear" and "radial" run across the frame; "tone"
                // runs along the input's brightness (the By tone shape,
                // which took over the Finish Gradient Map layer).
                text("shape", "linear"),
                // Where the blend between two colors reaches halfway.
                num("midpoint", 50.0, 5.0, 95.0),
                // Advanced mode: a full stop list as JSON. Present and
                // valid, it wins; absent, the two-color params above
                // build the same thing.
                text("stops", ""),
                // Set by the ROI preview so the gradient is measured
                // against the frame rather than the patch.
                num("roi_x", 0.0, 0.0, 0.95),
                num("roi_y", 0.0, 0.0, 0.95),
                num("roi_w", 1.0, 0.05, 1.0),
                num("roi_h", 1.0, 0.05, 1.0),
            ],
            inputs: vec![image_in()],
            outputs: vec![image_out()],
        });

        add(NodeSpec {
            // Brightness decides color. Three stops rather than two:
            // cool shadows with warm highlights and the mids left alone
            // is the thing people reach for a gradient map to do, and
            // two stops cannot say it.
            type_name: "heeler.gradient_map".into(),
            version: 1,
            label: "Gradient Map".into(),
            params: vec![
                text("color_lo", "#000000"),
                text("color_mid", "#808080"),
                text("color_hi", "#ffffff"),
                num("midpoint", 50.0, 1.0, 99.0),
                num("amount", 100.0, 0.0, 100.0),
            ],
            inputs: vec![image_in(), mask_in()],
            outputs: vec![image_out()],
        });

        // Layer effects: every one a function of the layer's alpha,
        // so a paint layer gets a shadow without anyone authoring one.
        for (name, label) in [("heeler.fx_shadow", "Shadow"), ("heeler.fx_glow", "Glow")] {
            let mut params = vec![
                num("size", 12.0, 0.0, 250.0),
                num("opacity", 75.0, 0.0, 100.0),
                text("color", "#000000"),
                flag("inner", false),
            ];
            // A glow has nowhere to fall, so it is not offered a
            // distance to fall by.
            if name == "heeler.fx_shadow" {
                params.push(num("distance", 8.0, 0.0, 250.0));
                params.push(num("angle", 135.0, -180.0, 180.0));
            }
            add(NodeSpec {
                type_name: name.into(),
                version: 1,
                label: label.into(),
                params,
                inputs: vec![image_in()],
                outputs: vec![image_out()],
            });
        }

        add(NodeSpec {
            type_name: "heeler.fx_color_overlay".into(),
            version: 1,
            label: "Color Overlay".into(),
            params: vec![num("opacity", 100.0, 0.0, 100.0), text("color", "#808080")],
            inputs: vec![image_in()],
            outputs: vec![image_out()],
        });

        add(NodeSpec {
            type_name: "heeler.fx_gradient_overlay".into(),
            version: 1,
            label: "Gradient Overlay".into(),
            params: vec![
                num("opacity", 100.0, 0.0, 100.0),
                num("angle", 0.0, -180.0, 180.0),
                text("color_a", "#000000"),
                text("color_b", "#ffffff"),
                text("shape", "linear"),
                num("midpoint", 50.0, 5.0, 95.0),
                text("stops", ""),
                num("roi_x", 0.0, 0.0, 0.95),
                num("roi_y", 0.0, 0.0, 0.95),
                num("roi_w", 1.0, 0.05, 1.0),
                num("roi_h", 1.0, 0.05, 1.0),
            ],
            inputs: vec![image_in()],
            outputs: vec![image_out()],
        });

        add(NodeSpec {
            type_name: "heeler.fx_bevel".into(),
            version: 1,
            label: "Bevel / Emboss".into(),
            params: vec![
                num("size", 6.0, 0.0, 100.0),
                num("depth", 100.0, 0.0, 400.0),
                num("angle", 135.0, -180.0, 180.0),
                num("opacity", 75.0, 0.0, 100.0),
                text("highlight", "#ffffff"),
                text("shadow", "#000000"),
            ],
            inputs: vec![image_in()],
            outputs: vec![image_out()],
        });

        add(NodeSpec {
            type_name: "heeler.blend".into(),
            version: 1,
            label: "Blend Mode".into(),
            // A percentage, like every other amount in this app. It was
            // declared 0..1 and clamped, which meant the UI (which has
            // always written 72 and 84 for these) had its value pinned at
            // full and the slider stepped between off and on.
            params: vec![
                // How a second picture of another shape meets the base:
                // uniform inside (fit), uniform over (fill), pulled to the
                // frame (stretch), or at its own size (none). "place"
                // (Finish image layers, 2026-09-30) puts the picture's
                // whole extent on the transform's four corners below, in
                // one resample from the picture's own pixels; with no
                // transform written it fills the frame as stretch does.
                choice("fit", "stretch", &["stretch", "fit", "fill", "none", "place"]),
                // Every mode the engine actually parses, which is more
                // than either picker offered. A test holds this list
                // against BlendMode::parse so the two cannot drift.
                choice(
                    "mode",
                    "normal",
                    &[
                        "normal", "multiply", "screen", "add", "overlay", "hard_light",
                        "vivid_light", "linear_light", "soft_light", "darken", "lighten",
                        "difference", "exclusion", "color_burn", "color_dodge", "hue",
                        "saturation", "color", "luminosity",
                    ],
                ),
                num("opacity", 100.0, 0.0, 100.0),
                // A clipping mask: the image on the mask port is read by
                // its ALPHA rather than its red channel. The wire comes
                // from the base layer's content, so this layer shows
                // only where the base has visible pixels.
                flag("clip", false),
                // Where the base layer's blend puts the clip source,
                // "fit;bx,by,bw,bh,x0,y0,x1,y1,x2,y2,x3,y3" and the base's
                // warp_aspect as a thirteenth number when it has one (zero for none)
                // and the base's place_pad as a fourteenth, folded on by
                // the frontend at serialization from the base layer (the
                // clip wire carries the base's content before its own
                // blend placed it). Empty clips by the content stretched
                // to the frame, as before (Finish image layers,
                // 2026-09-30).
                text("clip_place", ""),
                // The layer transform: where this layer's content
                // started, and where its four corners have been dragged
                // to. Move/Scale/Rotate and Warp both write these, and
                // they live on the blend rather than on the content
                // because the picture and its mask have to travel
                // together: the blend is the one node that sees both.
                //
                // Declared here or they do not exist. The desktop's
                // graph ingest drops any param the registry has never
                // heard of, which is a silence rather than an error:
                // the tool would draw its handles, write its numbers,
                // and the photograph would not move.
                //
                // Normalized to the frame, so the same numbers mean the
                // same transform on the proxy the screen shows and on
                // the full-resolution export. The bounds are generous
                // on purpose: a corner dragged outside the frame is a
                // perfectly ordinary thing to do to a layer.
                num("warp_bx", 0.0, -8.0, 8.0),
                num("warp_by", 0.0, -8.0, 8.0),
                // Zero width or height is what "no transform" looks
                // like, and the engine reads it as absent.
                num("warp_bw", 0.0, 0.0, 8.0),
                num("warp_bh", 0.0, 0.0, 8.0),
                num("warp_x0", 0.0, -8.0, 8.0),
                num("warp_y0", 0.0, -8.0, 8.0),
                num("warp_x1", 0.0, -8.0, 8.0),
                num("warp_y1", 0.0, -8.0, 8.0),
                num("warp_x2", 0.0, -8.0, 8.0),
                num("warp_y2", 0.0, -8.0, 8.0),
                num("warp_x3", 0.0, -8.0, 8.0),
                num("warp_y3", 0.0, -8.0, 8.0),
                // The frame shape (width over height) a placed picture's corners were
                // written against. On a frame of another shape the engine keeps the
                // layer's center as a fraction of the frame and its extent in units of
                // the frame's short side, so a square logo stays square after a crop or
                // Paste Edits (ops::placement_on_frame; 2026-09-30: "yes, fix the frame
                // shape issue for Finish layers"). Zero, the default and every graph
                // saved before, reads the corners as plain fractions.
                num("warp_aspect", 0.0, 0.0, 100.0),
                // The room an image layer's own warp gave its picture,
                // in percent of each side (the Warp node's `room`,
                // heeler.layer_warp in picture space). Folded on by the
                // frontend at serialization from the layer's warp, so
                // the placement puts the margin OUTSIDE the corners and
                // the picture itself still lands on them; zero, the
                // default, is a picture with no margin.
                num("place_pad", 0.0, 0.0, 100.0),
            ],
            inputs: vec![
                PortSpec::new("base", PortKind::Image, false),
                // Optional: with nothing wired on top the node hands its base through, the way a
                // compositor's Merge passes B when A is empty. Deleting the node that fed it used
                // to leave a required port unwired, the render failed, and the viewer kept the
                // last frame ("it still showed the image from the File node until I
                // deleted the Blend Mode node").
                PortSpec::new("blend", PortKind::Image, true),
                mask_in(),
                // The clipping mask: the base layer's content, read by
                // alpha. Its own port rather than a flag on the mask
                // port, because connect() checks port kinds and an
                // image into a Mask port is rejected -- the first
                // version of clipping was a wire the ingest silently
                // dropped, so nothing clipped while every test on the
                // op itself passed.
                PortSpec::new("clip", PortKind::Image, true),
            ],
            outputs: vec![image_out()],
        });

        // "We are missing a lens correction category in
// adjustments."
        //
        // Manual rather than profile-driven. A lens profile database is a
        // large piece of work with a license question attached (the usual
        // one is LGPL, which this project stays away from), so these are
        // the controls you turn until the brick wall is straight. A profile
        // reader can arrive later and drive exactly these parameters.
        add(NodeSpec {
            type_name: "heeler.lens_correct".into(),
            version: 1,
            label: "Lens Correction".into(),
            params: vec![
                num("distortion", 0.0, -100.0, 100.0),
                num("ca_red", 0.0, -100.0, 100.0),
                num("ca_blue", 0.0, -100.0, 100.0),
                num("vignette", 0.0, -100.0, 100.0),
                num("vignette_mid", 50.0, 0.0, 100.0),
                // The lensfun distortion models, written by the Lens panel's profile
                // Apply. Raw database coefficients, not friendly sliders; the manual
                // distortion above stays the hand-driven face and composes on top.
                choice("dist_model", "none", &["none", "ptlens", "poly3", "poly5"]),
                num("dist_a", 0.0, -2.0, 2.0),
                num("dist_b", 0.0, -2.0, 2.0),
                num("dist_c", 0.0, -2.0, 2.0),
                num("dist_scale", 1.0, 0.1, 4.0),
                // Profile TCA (lensfun poly3 form; the linear model is
                // the same thing with only the v term). Neutral v is 1:
                // red and blue at exactly green's size.
                num("tca_vr", 1.0, 0.5, 1.5),
                num("tca_cr", 0.0, -0.5, 0.5),
                num("tca_br", 0.0, -0.5, 0.5),
                num("tca_vb", 1.0, 0.5, 1.5),
                num("tca_cb", 0.0, -0.5, 0.5),
                num("tca_bb", 0.0, -0.5, 0.5),
                // Profile vignetting (lensfun "pa"): the falloff
                // polynomial 1 + k1 r² + k2 r⁴ + k3 r⁶, r = 1 at the
                // CORNER; correction divides by it.
                num("vig_k1", 0.0, -3.0, 3.0),
                num("vig_k2", 0.0, -3.0, 3.0),
                num("vig_k3", 0.0, -3.0, 3.0),
                // Provenance, not math: the name of the user preset these parameters came
                // from, so the panel can say so when the photo comes back. The engine
                // never reads it.
                text("lens_preset", ""),
            ],
            inputs: vec![image_in(), mask_in()],
            outputs: vec![image_out()],
        });

        // The nodes that let a graph do what a layer stack does.
        //
        // On why these are nodes rather than something the blend node does
        // invisibly: "Adding more nodes means adding more capabilities
        // rather than rewiring something unnatural to how the engine was
        // working just to match [the layer editor]."
        //
        // Overlay and Vivid Light are defined on display-referred values.
        // This engine is scene-linear. So a recipe that wants a layer editor's
        // numbers moves into display space with these, works, and comes
        // back, and you can see it happening in the graph.
        add(NodeSpec {
            type_name: "heeler.to_display".into(),
            version: 1,
            label: "To Display".into(),
            // Zero means the sRGB curve; anything else is a plain power,
            // for the recipes and tutorials that assume a flat 2.2.
            params: vec![num("gamma", 0.0, 0.0, 4.0)],
            inputs: vec![image_in()],
            outputs: vec![image_out()],
        });

        add(NodeSpec {
            type_name: "heeler.to_scene".into(),
            version: 1,
            label: "To Scene".into(),
            params: vec![num("gamma", 0.0, 0.0, 4.0)],
            inputs: vec![image_in(), PortSpec::new("reference", PortKind::Image, true)],
            outputs: vec![image_out()],
        });

        // Brightness and color, taken apart and put back together. The
        // same there-and-back shape as the pair above, and for the same
        // reason: some work is only sensible in a space the engine does
        // not natively hold, and a graph should show you the trip rather
        // than hide it inside a node.
        //
        // What it is for is noise. Chroma noise is blobby and low
        // frequency and the eye forgives smoothing it; luma noise is
        // detail's neighbor and it does not. Fan a source into two
        // splits, denoise each half at its own strength, and join.
        add(NodeSpec {
            type_name: "heeler.luma_chroma_split".into(),
            version: 1,
            label: "Luma / Color Split".into(),
            // luma | color. Which half comes out; the other one comes
            // out of a second split reading the same source, because a
            // wire that forks is how this graph duplicates a layer.
            params: vec![strict_choice("part", "luma", &["luma", "color"])],
            inputs: vec![image_in()],
            outputs: vec![image_out()],
        });

        add(NodeSpec {
            type_name: "heeler.luma_chroma_join".into(),
            version: 1,
            label: "Luma / Color Join".into(),
            params: vec![],
            // The color half is optional and missing means zero color,
            // so a join nobody has finished wiring renders gray instead
            // of taking the whole graph down with it.
            inputs: vec![
                image_in(),
                PortSpec::new("chroma", PortKind::Image, true),
            ],
            outputs: vec![image_out()],
        });

        add(NodeSpec {
            type_name: "heeler.invert".into(),
            version: 1,
            label: "Invert".into(),
            params: vec![num("amount", 1.0, 0.0, 1.0)],
            inputs: vec![image_in(), mask_in()],
            outputs: vec![image_out()],
        });

        add(NodeSpec {
            type_name: "heeler.blur".into(),
            version: 1,
            label: "Blur".into(),
            // Radius in pixels, the way both reference layer editors label
            // it, so the numbers in a tutorial mean what they say.
            params: vec![
                num("radius", 0.0, 0.0, 200.0),
                choice("kind", "gaussian", &["gaussian", "box", "motion"]),
                // Which way a motion blur streaks, in degrees.
                num("angle", 0.0, -180.0, 180.0),
            ],
            inputs: vec![image_in(), mask_in()],
            outputs: vec![image_out()],
        });

        // The two Develop recipes as single nodes, so they ride a layer behind
        // its mask: the owner, "You would always smooth or sharpen via layers
        // and masking." Each is its recipe's chain, tap for tap.
        add(NodeSpec {
            type_name: "heeler.sharpening".into(),
            version: 1,
            label: "Sharpening".into(),
            params: vec![
                num("radius", 3.0, 0.0, 200.0),
                num("intensity", 50.0, 0.0, 100.0),
                num("keep_color", 100.0, 0.0, 100.0),
                choice("mode", "vivid", &["vivid", "hipass"]),
            ],
            inputs: vec![image_in(), mask_in()],
            outputs: vec![image_out()],
        });

        add(NodeSpec {
            type_name: "heeler.skin_soften".into(),
            version: 1,
            label: "Skin Softening".into(),
            params: vec![
                num("softening", 8.0, 0.0, 200.0),
                num("detail_back", 4.0, 0.0, 200.0),
                num("strength", 50.0, 0.0, 100.0),
            ],
            inputs: vec![image_in(), mask_in()],
            outputs: vec![image_out()],
        });

        add(NodeSpec {
            type_name: "heeler.high_pass".into(),
            version: 1,
            label: "High Pass".into(),
            params: vec![num("radius", 3.0, 0.0, 200.0)],
            inputs: vec![image_in(), mask_in()],
            outputs: vec![image_out()],
        });

        add(NodeSpec {
            type_name: "heeler.desaturate".into(),
            version: 1,
            label: "Desaturate".into(),
            params: vec![num("amount", 1.0, 0.0, 1.0)],
            inputs: vec![image_in(), mask_in()],
            outputs: vec![image_out()],
        });

        add(NodeSpec {
            type_name: "heeler.merge".into(),
            version: 1,
            label: "Merge".into(),
            params: vec![
                // How a second picture of another shape meets the base:
                // uniform inside (fit), uniform over (fill), pulled to the
                // frame (stretch), or at its own size (none).
                choice("fit", "stretch", &["stretch", "fit", "fill", "none"]),num("opacity", 100.0, 0.0, 100.0)],
            inputs: vec![
                PortSpec::new("base", PortKind::Image, false),
                // Optional: with nothing wired on top the node hands its base through, the way a
                // compositor's Merge passes B when A is empty. Deleting the node that fed it used
                // to leave a required port unwired, the render failed, and the viewer kept the
                // last frame ("it still showed the image from the File node until I
                // deleted the Blend Mode node").
                PortSpec::new("fg", PortKind::Image, true),
            ],
            outputs: vec![image_out()],
        });

        // 26.3 Phase 8: the Export Layer names one extra layer the
        // exporter packs into the one EXR or writes as a sibling TIFF.
        // It is a pass-through, like a Write node: the engine hands the
        // wired input back unchanged, so the node drops onto any wire
        // as a tap without changing what downstream readers see. One
        // pair wired at a time (the card keeps the one-input rule). The
        // alpha input names the written layer's alpha at export time;
        // it never changes the passed-through picture.
        add(NodeSpec {
            type_name: "heeler.export_layer".into(),
            version: 1,
            label: "Export Layer".into(),
            params: vec![
                // Empty means the node's own label.
                text("name", ""),
                choice("part", "rgb", &["rgb", "alpha"]),
                // Empty for a hand-placed node; "finish:<blend id>"
                // for one the Finish tab's Export checkbox created.
                text("source", ""),
            ],
            inputs: vec![
                PortSpec::new("image", PortKind::Image, true),
                PortSpec::new("mask", PortKind::Mask, true),
                PortSpec::new("alpha", PortKind::Mask, true),
            ],
            outputs: vec![
                PortSpec::new("image", PortKind::Image, false),
                PortSpec::new("mask", PortKind::Mask, false),
            ],
        });

        add(NodeSpec {
            type_name: "heeler.output".into(),
            version: 1,
            label: "Output".into(),
            params: vec![
                text("format", "jpeg"),
                num("quality", 90.0, 1.0, 100.0),
                num("long_edge", 0.0, 0.0, 30000.0),
                text("color_space", "srgb"),
            ],
            inputs: vec![
                image_in(),
                // 26.3 Phase 5: the beauty's alpha, when a mask pipe
                // names it. Unwired reads as opaque; the Transparent
                // matte toggle is the special case that yields to it.
                PortSpec::new("alpha", PortKind::Mask, true),
            ],
            outputs: vec![],
        });

        Registry { specs }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn builtin_covers_phase_one_set() {
        let r = Registry::builtin();
        for t in [
            "heeler.image_source",
            "heeler.channel_join",
            "heeler.file",
            "heeler.catalog",
            "heeler.detail",
            "heeler.transform",
            "heeler.standard_color",
            "heeler.color_checker",
            "heeler.exposure",
            "heeler.white_balance",
            "heeler.curves",
            "heeler.levels",
            "heeler.color_balance",
            "heeler.sharpen",
            "heeler.clarity",
            "heeler.grain",
            "heeler.noise",
            "heeler.channel_gain",
            "heeler.tone_mask",
            "heeler.black_white",
            "heeler.denoise",
            "heeler.model_denoise",
            "heeler.crop_rotate",
            "heeler.luminance_extract",
            "heeler.luminance_range_mask",
            "heeler.split_tone",
            "heeler.tone_profile",
            "heeler.channel_extract",
            "heeler.range_mask",
            "heeler.radial_mask",
            "heeler.linear_mask",
            "heeler.color_range_mask",
            "heeler.brush_mask",
            "heeler.blend",
            "heeler.merge",
            "heeler.output",
        ] {
            assert!(r.get(t).is_some(), "missing spec for {t}");
        }
    }

    #[test]
    fn instantiate_fills_all_defaults() {
        let r = Registry::builtin();
        let n = r
            .instantiate("heeler.exposure", "e1", Section::Creative)
            .unwrap();
        assert_eq!(n.params.len(), 7);
        assert_eq!(n.params.get("exposure"), Some(&ParamValue::Number(0.0)));
        assert!(n.enabled);
        assert_eq!(n.input("mask").unwrap().kind, PortKind::Mask);
    }

    #[test]
    fn instantiate_unknown_type_errors() {
        let r = Registry::builtin();
        let err = r
            .instantiate("heeler.nonsense", "x", Section::Creative)
            .unwrap_err();
        assert_eq!(err, GraphError::UnknownNodeType("heeler.nonsense".into()));
    }

    #[test]
    fn clamp_keeps_what_the_slider_cannot_reach() {
        let r = Registry::builtin();
        // Exposure's slider stops at five stops either way. Nine is a
        // number someone typed on purpose, and the graph is not the
        // place to decide they did not mean it.
        let v = r
            .clamp("heeler.exposure", "exposure", ParamValue::Number(9.0))
            .unwrap();
        assert_eq!(v, ParamValue::Number(9.0));
        let v = r
            .clamp("heeler.exposure", "exposure", ParamValue::Number(-9.0))
            .unwrap();
        assert_eq!(v, ParamValue::Number(-9.0));
    }

    #[test]
    fn clamp_still_holds_the_limits_that_are_real() {
        let r = Registry::builtin();
        // A radius slider starts at zero because a negative radius is
        // not a thing, so that limit survives typing.
        let spec = r.get("heeler.blur").unwrap();
        let radius = spec.params.iter().find(|p| p.name == "radius").unwrap();
        assert_eq!(radius.min, Some(0.0));
        assert_eq!(hard_limits(radius), (0.0, f64::INFINITY));
        let v = r
            .clamp("heeler.blur", "radius", ParamValue::Number(-3.0))
            .unwrap();
        assert_eq!(v, ParamValue::Number(0.0));
        // But it may go as far above the slider as asked.
        let v = r
            .clamp("heeler.blur", "radius", ParamValue::Number(9000.0))
            .unwrap();
        assert_eq!(v, ParamValue::Number(9000.0));
    }

    #[test]
    fn clamp_rejects_wrong_type() {
        let r = Registry::builtin();
        let err = r
            .clamp("heeler.exposure", "exposure", ParamValue::Text("big".into()))
            .unwrap_err();
        assert!(matches!(err, GraphError::ParamTypeMismatch { .. }));
    }

    #[test]
    fn clamp_rejects_unknown_param() {
        let r = Registry::builtin();
        let err = r
            .clamp("heeler.exposure", "zoom", ParamValue::Number(1.0))
            .unwrap_err();
        assert!(matches!(err, GraphError::UnknownParam { .. }));
    }
}
