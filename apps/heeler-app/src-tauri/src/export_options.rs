//! Inputs and settings for the shared export writer.
use std::{collections::HashMap, path::PathBuf, sync::Arc};
use heeler_engine::{ImageBuf, SourceImage, Value};
use crate::{UiGraph, export_layers::ExportLayer};

/// Render inputs belong together; none is a saved export preference.
pub(crate) struct ExportInput<'a> {
    pub graph: &'a UiGraph,
    pub source_path: Option<&'a PathBuf>,
    pub source: Arc<ImageBuf>,
    pub smart: &'a HashMap<String, SourceImage>,
    pub keywords: &'a [String],
    pub alpha: Option<Value>,
    pub layers: Vec<ExportLayer>,
    /// The beauty, when it was rendered with the alpha and the layers in
    /// the same banded passes (render_export_layers_and_beauty_for);
    /// None renders it here.
    pub beauty: Option<ImageBuf>,
}

/// A new export setting adds a named field instead of another positional argument.
pub(crate) struct ExportOptions<'a> {
    pub format: &'a str,
    pub quality: u8,
    pub max_edge: Option<u32>,
    pub keep_metadata: bool,
    pub matte: bool,
    pub scale_percent: Option<f32>,
    pub allow_overwrite: bool,
    pub dpi: u32,
}
