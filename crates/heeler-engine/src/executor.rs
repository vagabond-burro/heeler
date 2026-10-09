use std::collections::HashMap;
use std::sync::Arc;

use heeler_graph::hash::Hasher;
use heeler_graph::{Connection, Graph, Node, PortKind};

use crate::buffers::{ImageBuf, Value};
use crate::ops;

#[derive(Debug, thiserror::Error, PartialEq)]
pub enum EngineError {
    #[error("{0}")]
    Memory(#[from] crate::memory::MemoryError),
    #[error("node '{0}' not found in graph")]
    NodeNotFound(String),
    #[error("required input '{port}' on node '{node}' is not connected")]
    MissingInput { node: String, port: String },
    #[error("input '{port}' on node '{node}' received the wrong value type")]
    TypeMismatch { node: String, port: String },
    #[error("inputs to node '{node}' have mismatched dimensions")]
    SizeMismatch { node: String },
    #[error("no source image registered for source node '{0}'")]
    SourceMissing(String),
    #[error("node type '{0}' is not implemented in the CPU engine yet")]
    UnsupportedNode(String),
    /// The render's stop flag tripped between nodes (set_stop): the
    /// desktop canceled it, as it does a full-resolution settle the
    /// moment an edit lands. Nothing below the canceled node was
    /// computed; what was computed above it stays cached.
    #[error("render canceled")]
    Cancelled,
    #[error("invalid parameter '{param}' on node '{node}': {message}")]
    InvalidParam {
        node: String,
        param: String,
        message: String,
    },
    #[error("node '{node}' is disabled but has no image input to pass through")]
    NoPassthroughInput { node: String },
}

/// A decoded source image plus a version. The version participates in cache
/// keys, so bumping it (file changed on disk, new decode quality) invalidates
/// everything downstream.
#[derive(Clone)]
pub struct SourceImage {
    pub image: Arc<ImageBuf>,
    pub version: u64,
    /// A measured plane: the desktop sets this on a `{id}@depth` plant it
    /// read out of the photograph's own depth pass (an OpenEXR Z or mist
    /// pass) with the Depth Map's Edges and Flatten at zero, so the
    /// raster's edges are the renderer's own to the pixel. The executor
    /// hands a depth consumer wired straight to such a plant the fact as an
    /// internal `depth_measured` param, and Depth Lighting shades it
    /// exactly instead of through the smoothing a guessed map needs. False
    /// for every photograph, every model plane and every other plant.
    pub measured: bool,
}

#[derive(Debug, Default, Clone)]
pub struct ExecStats {
    /// How many times each node actually executed (cache misses).
    pub executions: HashMap<String, u64>,
    pub cache_hits: u64,
}

/// Pull-based, memoizing executor. Cache keys are content hashes over
/// (node type, params, enabled, input keys), so "dirty propagation" falls out
/// naturally: changing a param changes that node's key and every downstream
/// key, while upstream results keep hitting the cache.
#[derive(Default)]
pub struct Executor {
    cache: HashMap<u64, Value>,
    /// Last-use tick per cache key, for LRU trimming.
    cache_used: HashMap<u64, u64>,
    use_clock: u64,
    /// The byte budget the last trim held the cache to, so admission can
    /// count the outputs a render will actually keep rather than one
    /// whole frame per node of the chain.
    cache_budget: Option<usize>,
    pub stats: ExecStats,
    /// Polled before each node is evaluated; true stops the render with
    /// EngineError::Cancelled. None renders to the end.
    stop: Option<Box<dyn Fn() -> bool + Send + Sync>>,
}

/// Resident bytes of one cached value: f32 RGBA for images, one f32
/// channel for masks. Arc sharing with sources and other caches makes
/// this an upper bound, which is the safe direction for a budget.
fn value_bytes(v: &Value) -> usize {
    match v {
        Value::Image(i) => i.data.capacity().saturating_mul(4),
        Value::Mask(m) => m.data.capacity().saturating_mul(4),
    }
}

/// Node types whose desktop-computed raster rides the sources map,
/// injected as a "raster" input and hashed into the content key
/// (absence hashes as zero: no raster is a valid state). The smart
/// masks, the inpaint fills, the refined selections, Black & White's
/// farness plane, and the noise model's answer.
/// The param naming the node whose planted raster a raster-fed node
/// reads, when it is not its own: the copy of a Warp layer's mask the
/// desktop asks for the margin past the frame (ops_masks.rs
/// beyond_render) reads its mask's bake. Never in a spec or a saved
/// graph; the desktop sets it on the engine graph alone.
pub const PLANTED_AS: &str = "planted_as";

/// The id a raster-fed node's planted raster is kept under.
fn planted_id(node: &Node) -> &str {
    node.params.get(PLANTED_AS).and_then(|v| v.as_str()).unwrap_or(&node.id)
}

/// Nodes whose output is a registered picture rather than a function of
/// their inputs: the photograph itself, and any file read in beside it.
fn is_source(ty: &str) -> bool {
    matches!(ty, "heeler.image_source" | "heeler.file" | "heeler.catalog")
}

/// Depth Lighting's second planted slot, `{id}@normal`: the surface
/// normals a render wrote into its own file, when the desktop found
/// and converted them.
fn normal_slot(ty: &str) -> bool {
    ty == "heeler.key_light"
}

/// A wire off a node's second output answers the planted slot,
/// `{id}@{port}`: Depth Map's farness plane at `@depth` (26.3 Phase 4),
/// 0 near .. 1 far, at the size the desktop planted it (the render's
/// own size; the export re-refines before planting), the same gray
/// raster the Depth blocks read; a File node's page alpha or named
/// channel at `@mask` (Phase 6). Nothing planted is an empty mask, the
/// passthrough rule every field reader follows.
fn planted_port_value(node_id: &str, port: &str, sources: &HashMap<String, SourceImage>) -> Value {
    let Some(src) = sources.get(&format!("{node_id}@{port}")) else {
        return Value::Mask(Arc::new(crate::buffers::MaskBuf::new(0, 0)));
    };
    let img = &src.image;
    Value::Mask(Arc::new(crate::buffers::MaskBuf {
        width: img.width,
        height: img.height,
        data: img.data.chunks_exact(4).map(|px| px[0].clamp(0.0, 1.0)).collect(),
    }))
}

/// 26.3 Phase 8: the Export Layer passes its wired input through
/// unchanged, so a wire off its `image` or `mask` output is the node's
/// own render, never the planted slot other non-"out" ports answer
/// with.
fn passthrough_port(graph: &Graph, node_id: &str, port: &str) -> bool {
    (port == "image" || port == "mask")
        && graph
            .node(node_id)
            .map(|n| n.node_type == "heeler.export_layer")
            .unwrap_or(false)
}

fn raster_fed(ty: &str) -> bool {
    matches!(
        ty,
        "heeler.smart_mask"
            // The object matte read out of the photograph's own file.
            | "heeler.matte_mask"
            | "heeler.inpaint"
            | "heeler.selection_mask"
            // A pixel mask's baked base, or its frozen selection's matte.
            | "heeler.brush_mask"
            // Black & White grades between its Near and Far filters
            // along the plane; planted only with a Far named
            // (black_white_wants_depth). The other depth readers take
            // the plane by wire (26.3 Phase 10.3); Black & White is
            // not on the automatic wiring list and keeps the raster.
            | "heeler.black_white"
            // Noise Reduction's Model method drinks the SCUNet answer
            // the desktop computed for the source tier.
            | "heeler.model_denoise"
    )
}

impl Executor {
    pub fn new() -> Self {
        Executor::default()
    }

    pub fn clear_cache(&mut self) {
        self.cache.clear();
        self.cache_used.clear();
    }

    /// The stop flag the walk polls before each node (2026-09-23: the
    /// full-resolution settle must give way to the next edit at once,
    /// and the engine's render lock held the next frame behind it). Set
    /// for one render, cleared after; a render already past its last
    /// node is not affected.
    pub fn set_stop(&mut self, stop: Option<Box<dyn Fn() -> bool + Send + Sync>>) {
        self.stop = stop;
    }

    /// Bounds the memoized graph results without throwing away hot entries.
    /// Preview rendering calls this between frames, so a wholesale clear here
    /// turns one extra node into a complete graph rerender.
    pub fn trim(&mut self, max_entries: usize) {
        if max_entries == 0 {
            self.clear_cache();
            return;
        }
        let remove = self.cache.len().saturating_sub(max_entries);
        if remove == 0 {
            return;
        }
        let mut oldest: Vec<(u64, u64)> = self
            .cache_used
            .iter()
            .map(|(&key, &used)| (key, used))
            .collect();
        oldest.sort_unstable_by_key(|&(_, used)| used);
        for (key, _) in oldest.into_iter().take(remove) {
            self.cache.remove(&key);
            self.cache_used.remove(&key);
        }
    }

    /// Bounds the memoized graph results by resident bytes. Entry count
    /// is the wrong unit for this cache: a 2048px preview frame is ~45 MB
    /// and a curve LUT's mask is a few KB, so 48 entries could pin over
    /// 2 GB or under 1 MB depending on what happened to be hot. Evicts
    /// least recently used first; the most recent entry always survives,
    /// whatever its size, or the cache would be pure overhead exactly
    /// when frames are biggest.
    pub fn trim_bytes(&mut self, budget: usize) {
        self.cache_budget = Some(budget);
        let mut total: usize = self.cache.values().map(value_bytes).sum();
        if total <= budget {
            return;
        }
        let mut oldest: Vec<(u64, u64)> = self
            .cache_used
            .iter()
            .map(|(&key, &used)| (key, used))
            .collect();
        oldest.sort_unstable_by_key(|&(_, used)| used);
        for (key, _) in oldest {
            if total <= budget || self.cache.len() <= 1 {
                break;
            }
            if let Some(v) = self.cache.remove(&key) {
                total = total.saturating_sub(value_bytes(&v));
                self.cache_used.remove(&key);
            }
        }
    }

    fn touch(&mut self, key: u64) {
        self.use_clock = self.use_clock.wrapping_add(1);
        self.cache_used.insert(key, self.use_clock);
    }

    pub fn render(
        &mut self,
        graph: &Graph,
        node_id: &str,
        sources: &HashMap<String, SourceImage>,
    ) -> Result<Value, EngineError> {
        // One key memo for the whole pass: graph and sources are fixed for
        // its duration, so every node's key is computed exactly once no
        // matter how many paths reach it. Without this, the recursive hash
        // walk repeats per path, quadratic on the layer chain and worse on
        // hand-wired graphs where diamonds nest.
        self.track_cache();
        let needed = self.estimate(graph, node_id, sources)?;
        let _job = crate::memory::Job::admit(needed, "graph render and intermediates")?;
        let result = crate::memory::catch(|| {
            let mut keys = HashMap::new();
            self.resolve(graph, node_id, sources, &mut keys).map(|(v, _)| v)
        });
        self.track_cache();
        result?
    }

    pub fn track_cache(&self) {
        let budget = crate::memory::budget();
        for v in self.cache.values() {
            match v { Value::Image(i) => budget.track_image(i), Value::Mask(m) => budget.track_mask(m) }
        }
    }

    /// Renders what a connection carries (26.3 Phase 5): the export
    /// reads the Output node's alpha port and every Export Channel
    /// node's input this way, through the same executor and sources as
    /// the beauty, so shared upstream work is memoized. A wire off a
    /// planted port (depth, a File node's mask) answers the planted
    /// plane; anything else is the source node's own render.
    pub fn render_connection(
        &mut self,
        graph: &Graph,
        conn: &Connection,
        sources: &HashMap<String, SourceImage>,
    ) -> Result<Value, EngineError> {
        if conn.from.1 != "out" && !passthrough_port(graph, &conn.from.0, &conn.from.1) {
            Ok(planted_port_value(&conn.from.0, &conn.from.1, sources))
        } else {
            self.render(graph, &conn.from.0, sources)
        }
    }

    /// Retained outputs for reachable cache misses, plus the largest operator
    /// workspace. Disconnected nodes and cache hits do not reserve new images.
    pub fn estimate(&self, graph: &Graph, terminal: &str, sources: &HashMap<String, SourceImage>) -> Result<usize, EngineError> {
        use crate::memory;
        fn shape(v: &Value) -> (usize, usize, usize) {
            match v { Value::Image(i) => (i.width, i.height, 4), Value::Mask(m) => (m.width, m.height, 1) }
        }
        struct Walk<'a> {
            exec: &'a Executor, graph: &'a Graph, sources: &'a HashMap<String, SourceImage>,
            shapes: HashMap<String, (usize, usize, usize)>, keys: HashMap<String, u64>, outputs: usize, scratch: usize,
        }
        impl Walk<'_> {
            fn visit(&mut self, id: &str) -> Result<(usize, usize, usize), EngineError> {
                if let Some(d) = self.shapes.get(id) { return Ok(*d); }
                let node = self.graph.node(id).ok_or_else(|| EngineError::NodeNotFound(id.into()))?;
                let key = Executor::key_of_memo(self.graph, id, self.sources, &mut self.keys)?;
                let dims = if let Some(v) = self.exec.cache.get(&key) { shape(v) }
                else if is_source(&node.node_type) {
                    let src = self.sources.get(id).ok_or_else(|| EngineError::SourceMissing(id.into()))?;
                    memory::bytes(src.image.width, src.image.height, 4, 4)?;
                    (src.image.width, src.image.height, 4)
                } else {
                    let mut base = None;
                    for port in &node.inputs {
                        if let Some(c) = self.graph.incoming(id, &port.name) {
                            // A wire off a planted port carries the
                            // planted slot, never the source node's own
                            // render, so reserving through it would both
                            // overestimate and demand a source image the
                            // render never reads. An Export Layer's
                            // pass-through outputs are the exception:
                            // they carry the node's own render.
                            let d = if c.from.1 != "out" && !passthrough_port(self.graph, &c.from.0, &c.from.1) {
                                match self.sources.get(&format!("{}@{}", c.from.0, c.from.1)) {
                                    Some(src) => (src.image.width, src.image.height, 1),
                                    None => continue,
                                }
                            } else {
                                self.visit(&c.from.0)?
                            };
                            if base.is_none() || port.name == "in" || port.name == "base" { base = Some(d); }
                        }
                    }
                    let (mut w, mut h, incoming_channels) = base.unwrap_or((1, 1, 4));
                    if node.enabled && node.node_type == "heeler.crop_rotate" {
                        // Match crop_rotate_buf exactly. Downstream nodes and ROI
                        // patches reserve cropped pixels, not the entire sensor.
                        let x = ops::p(&node.params, "crop_x", 0.0).clamp(0.0, 0.95);
                        let y = ops::p(&node.params, "crop_y", 0.0).clamp(0.0, 0.95);
                        let cw = ops::p(&node.params, "crop_w", 1.0).clamp(0.05, 1.0 - x);
                        let ch = ops::p(&node.params, "crop_h", 1.0).clamp(0.05, 1.0 - y);
                        w = ((w as f32 * cw).round() as usize).max(1);
                        h = ((h as f32 * ch).round() as usize).max(1);
                    }
                    let channels = if !node.enabled { incoming_channels }
                        else if node.outputs.iter().any(|p| p.kind == PortKind::Image) { 4 } else { 1 };
                    if node.enabled {
                        self.outputs = memory::sum([self.outputs, memory::bytes(w, h, channels, 4)?])?;
                        let workspace = match node.node_type.as_str() {
                            // Detail retains its incoming and dehazed frames alongside
                            // the guided filter's planes and weighted output.
                            "heeler.detail" | "heeler.dof" | "heeler.halation" | "heeler.flare" => 8,
                            // The guided filter holds its guide, the guide's
                            // moments, the coefficients and the blend's second
                            // radius: some thirty planes at once.
                            "heeler.guided_filter" | "heeler.guided_filter_mask" => 8,
                            "heeler.denoise" | "heeler.nlm_denoise" | "heeler.model_denoise" | "heeler.sharpen" | "heeler.sharpening" | "heeler.clarity" | "heeler.tone_eq" | "heeler.skin_soften" | "heeler.blur" | "heeler.high_pass" => 4,
                            "heeler.crop_rotate" => 0,
                            _ => 2,
                        };
                        self.scratch = self.scratch.max(memory::bytes(w, h, 16, workspace)?);
                    }
                    (w, h, channels)
                };
                self.shapes.insert(id.into(), dims);
                Ok(dims)
            }
        }
        let mut walk = Walk { exec: self, graph, sources, shapes: HashMap::new(), keys: HashMap::new(), outputs: 0, scratch: 0 };
        let (w, h, _) = walk.visit(terminal)?;
        let budget = memory::budget();
        let mut seen = std::collections::HashSet::new();
        let mut held = Vec::new();
        for i in sources.values().map(|s| &s.image).chain(self.cache.values().filter_map(|v| v.as_image())) {
            if seen.insert(Arc::as_ptr(i) as usize) && !budget.image_is_resident(i) { held.push(i.data.capacity().saturating_mul(4)); }
        }
        for m in self.cache.values().filter_map(|v| v.as_mask()) {
            if seen.insert(Arc::as_ptr(m) as usize) && !budget.mask_is_resident(m) { held.push(m.data.capacity().saturating_mul(4)); }
        }
        // A render keeps at most what the trim leaves: counting one whole
        // frame per node of a long chain would refuse a full-size export
        // the machine has always managed.
        let outputs = match self.cache_budget {
            Some(cap) => walk.outputs.min(cap),
            None => walk.outputs,
        };
        // The returned clone and format conversion coexist with cached outputs.
        Ok(memory::sum([memory::sum(held)?, outputs, walk.scratch, memory::bytes(w, h, 4, 8)?])?)
    }

    /// The cache key a node WOULD render under, without executing anything:
    /// a content hash over (node type, params, enabled, input keys), walked
    /// up to the sources. Pure hashing (no pixel work, no cache access),
    /// so a caller can ask "do I already have this?" before paying for it.
    pub fn key_of(
        graph: &Graph,
        node_id: &str,
        sources: &HashMap<String, SourceImage>,
    ) -> Result<u64, EngineError> {
        Self::key_of_memo(graph, node_id, sources, &mut HashMap::new())
    }

    /// key_of against a memo of already-hashed nodes. The memo is only
    /// valid for one (graph, sources) pair; callers hold both fixed for
    /// the memo's lifetime.
    fn key_of_memo(
        graph: &Graph,
        node_id: &str,
        sources: &HashMap<String, SourceImage>,
        keys: &mut HashMap<String, u64>,
    ) -> Result<u64, EngineError> {
        if let Some(&key) = keys.get(node_id) {
            return Ok(key);
        }
        let node = graph
            .node(node_id)
            .ok_or_else(|| EngineError::NodeNotFound(node_id.to_string()))?;

        let mut hasher = Hasher::new();
        hasher.write(node.node_type.as_bytes());
        hasher.write(node.params_canonical().as_bytes());
        hasher.write(&[node.enabled as u8]);

        if is_source(&node.node_type) {
            let src = sources
                .get(node_id)
                .ok_or_else(|| EngineError::SourceMissing(node_id.to_string()))?;
            // Source output depends on which image is registered, not just on
            // params, so the node id must be part of the key. Every other
            // node type is a pure function of (params, inputs).
            hasher.write(node_id.as_bytes());
            hasher.write_u64(src.version);
        } else if raster_fed(&node.node_type) {
            // These nodes' rasters ride the sources map too, but
            // OPTIONALLY: no raster is a valid state (empty mask, a
            // passthrough, or a selection's classical geometry), so
            // absence hashes as zero rather than erroring the render.
            let planted = planted_id(node);
            hasher.write(planted.as_bytes());
            hasher.write_u64(sources.get(planted).map(|s| s.version).unwrap_or(0));
        }
        if normal_slot(&node.node_type) {
            hasher.write(b"@normal");
            hasher.write_u64(sources.get(&format!("{node_id}@normal")).map(|s| s.version).unwrap_or(0));
        }

        for port in &node.inputs {
            match graph.incoming(node_id, &port.name) {
                Some(conn) => {
                    hasher.write(port.name.as_bytes());
                    if conn.from.1 != "out" && !passthrough_port(graph, &conn.from.0, &conn.from.1) {
                        // A wire off a planted port (the depth plane,
                        // a File node's mask) carries the planted slot,
                        // so the key is the slot's version, not the
                        // source node's image output. The desktop
                        // re-plants when the recipe moves, so the
                        // version covers the params too.
                        hasher.write(b"@planted-port");
                        hasher.write(conn.from.1.as_bytes());
                        let planted = sources.get(&format!("{}@{}", conn.from.0, conn.from.1));
                        hasher.write_u64(planted.map(|s| s.version).unwrap_or(0));
                        // The measured mark changes what the consumer
                        // draws, so it is part of the key too: the
                        // desktop can learn a plane's origin after
                        // planting it once under the same version.
                        hasher.write(&[planted.is_some_and(|s| s.measured) as u8]);
                    } else {
                        let key = Self::key_of_memo(graph, &conn.from.0, sources, keys)?;
                        hasher.write_u64(key);
                    }
                }
                None if port.optional => {}
                None => {
                    return Err(EngineError::MissingInput {
                        node: node_id.to_string(),
                        port: port.name.clone(),
                    })
                }
            }
        }
        let key = hasher.finish();
        keys.insert(node_id.to_string(), key);
        Ok(key)
    }

    /// A cached value by key, for callers that computed the key themselves.
    pub fn get(&self, key: u64) -> Option<Value> {
        self.cache.get(&key).cloned()
    }

    /// Plants an externally produced value under its key, so a render that
    /// reaches it is a cache hit instead of a recompute. Used to carry an
    /// expensive intermediate (the full-resolution ROI slice) across the
    /// throwaway executors the zoomed-in path renders with.
    pub fn seed(&mut self, key: u64, value: Value) {
        self.cache.insert(key, value);
        self.touch(key);
    }

    fn resolve(
        &mut self,
        graph: &Graph,
        node_id: &str,
        sources: &HashMap<String, SourceImage>,
        keys: &mut HashMap<String, u64>,
    ) -> Result<(Value, u64), EngineError> {
        if self.stop.as_ref().is_some_and(|stop| stop()) {
            return Err(EngineError::Cancelled);
        }
        // Key first, inputs second. The old order resolved (and thereby
        // computed) every upstream value before discovering the result was
        // already cached; with the key known up front, a hit skips the
        // whole upstream walk, which is what makes a seeded slice able to
        // stand in for the full-resolution prefix that produced it.
        let key = Self::key_of_memo(graph, node_id, sources, keys)?;
        if let Some(value) = self.cache.get(&key).cloned() {
            self.stats.cache_hits += 1;
            self.touch(key);
            // Keep the ancestors that produced this value warm too, or LRU
            // trimming would evict entries a downstream hit still depends
            // on being cheap to re-derive.
            self.touch_cached_ancestors(graph, node_id, sources, keys);
            return Ok((value, key));
        }

        let node = graph
            .node(node_id)
            .ok_or_else(|| EngineError::NodeNotFound(node_id.to_string()))?;
        // Resolve inputs in declared port order.
        let mut inputs: Vec<(String, Value)> = Vec::new();
        // Whether the node's `depth` input drinks a measured plane: wired
        // DIRECTLY from a planted `@depth` port whose plant carries the mark. A
        // wire that passes through any other node first (an invert, a logic or
        // math node, anything) loses the mark, since that node's output is its
        // own render and the executor cannot know what it did to the plane's
        // edges.
        let mut depth_measured = false;
        for port in &node.inputs {
            match graph.incoming(node_id, &port.name) {
                Some(conn) => {
                    // A planted port (26.3 Phase 4 depth, Phase 6 file
                    // mask) answers from the planted plane, not from the
                    // source node's image output: the node's own render
                    // is the passthrough. An Export Layer's pass-through
                    // outputs are the exception.
                    let (value, _) = if conn.from.1 != "out" && !passthrough_port(graph, &conn.from.0, &conn.from.1) {
                        if port.name == "depth" && conn.from.1 == "depth" {
                            depth_measured = sources.get(&format!("{}@depth", conn.from.0)).is_some_and(|s| s.measured);
                        }
                        (planted_port_value(&conn.from.0, &conn.from.1, sources), 0)
                    } else {
                        self.resolve(graph, &conn.from.0, sources, keys)?
                    };
                    inputs.push((port.name.clone(), value));
                }
                None if port.optional => {}
                None => {
                    return Err(EngineError::MissingInput {
                        node: node_id.to_string(),
                        port: port.name.clone(),
                    })
                }
            }
        }

        // A child may have spent seconds in a pixel operator after
        // this parent's first poll. Do not execute the already-visited
        // downstream nodes when cancellation arrived during that work.
        if self.stop.as_ref().is_some_and(|stop| stop()) {
            return Err(EngineError::Cancelled);
        }

        // A source has nothing to pass through, so "off" on one is the
        // same picture: the branch comes before the bypass.
        let value = if is_source(&node.node_type) {
            let src = sources.get(node_id).expect("checked above");
            Value::Image(src.image.clone())
        } else if !node.enabled {
            self.passthrough(node_id, node, &inputs)?
        } else {
            // The smart mask's computed raster is planted by the
            // desktop under the node's own id; the op reads it as an
            // input like any other and applies its dials. No raster,
            // no injection: the op answers empty. A selection mask's
            // raster is its ViTMatte-refined base (P4); without one it
            // rasterizes its geometry as it always did.
            if raster_fed(&node.node_type) {
                if let Some(src) = sources.get(planted_id(node)) {
                    inputs.push(("raster".to_string(), Value::Image(src.image.clone())));
                }
            }
            if normal_slot(&node.node_type) {
                if let Some(src) = sources.get(&format!("{node_id}@normal")) {
                    inputs.push(("normal".to_string(), Value::Image(src.image.clone())));
                }
            }
            // The measured mark rides an internal numeric param on a
            // copy of the node, never on the graph: not in the spec,
            // never serialized, never shown (the registry test below
            // pins that no node declares it).
            let marked;
            let node = if depth_measured {
                let mut copy = node.clone();
                copy.params.insert("depth_measured".to_string(), heeler_graph::ParamValue::Number(1.0));
                marked = copy;
                &marked
            } else {
                node
            };
            weigh_mask_input(node, &mut inputs);
            let result = ops::execute(node, &inputs)?;
            let result = if mask_is_off(node) { open_everywhere(result) } else { result };
            self.blend_through_mask(node, &inputs, result)
        };

        *self
            .stats
            .executions
            .entry(node_id.to_string())
            .or_insert(0) += 1;
        self.cache.insert(key, value.clone());
        self.touch(key);
        Ok((value, key))
    }

    /// Marks every cached ancestor of a hit as recently used, approximating
    /// the old resolve order's LRU writes without re-deriving any values.
    fn touch_cached_ancestors(
        &mut self,
        graph: &Graph,
        node_id: &str,
        sources: &HashMap<String, SourceImage>,
        keys: &mut HashMap<String, u64>,
    ) {
        let Some(node) = graph.node(node_id) else {
            return;
        };
        for port in &node.inputs {
            let Some(conn) = graph.incoming(node_id, &port.name) else {
                continue;
            };
            let Ok(key) = Self::key_of_memo(graph, &conn.from.0, sources, keys) else {
                continue;
            };
            if self.cache.contains_key(&key) {
                self.touch(key);
                self.touch_cached_ancestors(graph, &conn.from.0, sources, keys);
            }
        }
    }

    /// A disabled node forwards its first connected image input untouched.
    ///
    /// The logic family (compare/logic/math/remap) has no image input to
    /// forward: its ports carry masks and fields. There the honest reading
    /// of "disabled" is "pass operand a along", so the fall-back is the
    /// first connected Mask/Channel input. A disabled conditional still
    /// resolves through the image rule above, and its first image port is
    /// "in" (the else branch), which is the only answer that is never a
    /// surprise.
    fn passthrough(
        &self,
        node_id: &str,
        node: &heeler_graph::Node,
        inputs: &[(String, Value)],
    ) -> Result<Value, EngineError> {
        for port in &node.inputs {
            if port.kind == PortKind::Image {
                if let Some((_, v)) = inputs.iter().find(|(n, _)| n == &port.name) {
                    return Ok(v.clone());
                }
            }
        }
        let makes_image = node
            .outputs
            .first()
            .map(|p| p.kind == PortKind::Image)
            .unwrap_or(false);
        for port in &node.inputs {
            if matches!(port.kind, PortKind::Mask | PortKind::Channel) {
                if let Some((_, v)) = inputs.iter().find(|(n, _)| n == &port.name) {
                    // A node that turns fields into a picture (Channel
                    // Join) cannot hand a field downstream when bypassed:
                    // the next node wants rgb. Its first field goes on as
                    // a gray picture, which is the honest "off" for it.
                    if makes_image {
                        if let Some(m) = v.as_mask() {
                            let mut img = crate::buffers::ImageBuf::filled(
                                m.width,
                                m.height,
                                [0.0, 0.0, 0.0, 1.0],
                            );
                            for (px, &f) in m.data.iter().enumerate() {
                                img.data[px * 4] = f;
                                img.data[px * 4 + 1] = f;
                                img.data[px * 4 + 2] = f;
                            }
                            return Ok(Value::Image(Arc::new(img)));
                        }
                    }
                    return Ok(v.clone());
                }
            }
        }
        Err(EngineError::NoPassthroughInput {
            node: node_id.to_string(),
        })
    }

    /// If an adjustment node has a connected mask, the processed result is
    /// blended back toward the primary input: mask 0 = untouched, 1 = full
    /// effect. Applies to any node with an image "in" port and a "mask" port.
    ///
    /// The guard used to check the mask against the original only. A node
    /// whose output is not the size of its input (a crop is the shape of
    /// the thing, even though crop_rotate itself takes no mask port) would
    /// then blend the top-left corner of one frame against another, and a
    /// LARGER output would index the mask out of bounds and panic. The
    /// conditional node leans on this mechanism for its per-pixel
    /// if/then/else, which made the hole worth closing rather than
    /// documenting: no same-size triple, no blend.
    fn blend_through_mask(
        &self,
        node: &heeler_graph::Node,
        inputs: &[(String, Value)],
        result: Value,
    ) -> Value {
        let mask = inputs
            .iter()
            .find(|(n, _)| n == "mask")
            .and_then(|(_, v)| v.as_mask());
        let original = inputs
            .iter()
            .find(|(n, _)| n == "in")
            .and_then(|(_, v)| v.as_image());
        if node.input("mask").is_none() {
            return result;
        }
        // A mask of another size than the frame it gates cannot be
        // placed. It used to fall to the catch-all below and the node
        // ran unmasked over the whole frame (a Develop layer whose mask
        // read the photograph ahead of a crop); now the gate closes and
        // the node applies nowhere, noted for the log (mask_on_frame).
        if let (Some(m), Some(orig)) = (mask, original) {
            if m.width != orig.width || m.height != orig.height {
                ops::note_mask_mismatch(&node.id, (m.width, m.height), (orig.width, orig.height));
                return Value::Image(orig.clone());
            }
        }
        match (mask, original, &result) {
            (Some(m), Some(orig), Value::Image(processed))
                if m.width == orig.width
                    && m.height == orig.height
                    && processed.width == orig.width
                    && processed.height == orig.height =>
            {
                Value::Image(Arc::new(ops::apply_mask(orig, processed, m)))
            }
            _ => result,
        }
    }
}

/// The internal param that scales a node's mask: a Develop layer's
/// Opacity (2026-09-30: "Adjustment layers are missing an opacity
/// slider"). The desktop stamps it on every node a layer's mask gates
/// when it builds the graph, so a layer at 50 applies half its edit
/// wherever its mask is on. Like `depth_measured` it is never declared
/// by a node, never saved and never a control of its own: the saved
/// number is the layer's `opacity`, and this is what that number means
/// to the nodes it reaches.
pub const MASK_WEIGHT_PARAM: &str = "mask_weight";

/// The internal param that turns a layer's mask off (2026-10-01: "yes,
/// build disable mask"): the mask node renders open everywhere, so
/// every node it gates applies at full weight (times the layer's
/// opacity, which `mask_weight` still carries) while the mask's own
/// data (strokes, clicks, regions, its Depth mask) stays as it was.
/// The desktop stamps it from the mask node's saved `mask_off` flag
/// when it builds the graph; like `mask_weight` no node declares it.
/// Not the node's `enabled` flag: a bypassed mask node hands its input
/// on, which would gate the layer by the photograph's own picture.
pub const MASK_OFF_PARAM: &str = "mask_off";

/// Whether a node carries the mask-off mark (MASK_OFF_PARAM).
fn mask_is_off(node: &heeler_graph::Node) -> bool {
    node.params
        .get(MASK_OFF_PARAM)
        .and_then(|v| match v {
            heeler_graph::ParamValue::Bool(b) => Some(*b),
            other => other.as_f64().map(|x| x != 0.0),
        })
        .unwrap_or(false)
}

/// A mask node's render opened everywhere, its size kept: a mask of
/// ones, or a white opaque picture for a node that hands a picture on.
/// The size is the one the node rendered at, so a mask that would have
/// closed its node by size closes it still.
fn open_everywhere(value: Value) -> Value {
    match value {
        Value::Mask(m) => Value::Mask(Arc::new(crate::buffers::MaskBuf { width: m.width, height: m.height, data: vec![1.0; m.width * m.height] })),
        Value::Image(img) => Value::Image(Arc::new(crate::buffers::ImageBuf::filled(img.width, img.height, [1.0, 1.0, 1.0, 1.0]))),
    }
}

/// Scales the value on a node's `mask` port by its `mask_weight`, the
/// one multiply behind a Develop layer's Opacity: effective weight =
/// mask x opacity. Done to the input rather than to the result, so it
/// reaches both kinds of consumer the same way: a node the executor
/// blends through its mask (blend_through_mask) and one that reads its
/// mask itself (a Blend Mode's "Apply mask" inside a tool group). The
/// mask node's own render is untouched, which is what the mask eye
/// shows: the mask, not the weight.
///
/// A node that declares a mask port with nothing wired to it (an
/// unpainted brush layer, whose wire the desktop leaves off so the
/// layer applies everywhere) is handed a flat mask of the weight, the
/// size of its picture, so the opacity still holds there.
fn weigh_mask_input(node: &heeler_graph::Node, inputs: &mut Vec<(String, Value)>) {
    let Some(weight) = node.params.get(MASK_WEIGHT_PARAM).and_then(|v| v.as_f64()) else {
        return;
    };
    if !weight.is_finite() || weight >= 1.0 {
        return;
    }
    let w = weight.max(0.0) as f32;
    if let Some((_, value)) = inputs.iter_mut().find(|(port, _)| port == "mask") {
        *value = match &*value {
            Value::Mask(m) => {
                let mut scaled = (**m).clone();
                for v in scaled.data.iter_mut() {
                    *v = v.clamp(0.0, 1.0) * w;
                }
                Value::Mask(Arc::new(scaled))
            }
            // An image on a mask port is read from its red channel
            // (the Blend Mode) or its luminance; scaling the color
            // scales either reading.
            Value::Image(img) => {
                let mut scaled = (**img).clone();
                for px in scaled.data.chunks_mut(4) {
                    for c in px.iter_mut().take(3) {
                        *c *= w;
                    }
                }
                Value::Image(Arc::new(scaled))
            }
        };
        return;
    }
    if node.input("mask").is_none() {
        return;
    }
    let frame = inputs
        .iter()
        .find(|(port, _)| port == "in" || port == "base")
        .and_then(|(_, v)| v.as_image())
        .map(|img| (img.width, img.height));
    if let Some((width, height)) = frame {
        inputs.push((
            "mask".to_string(),
            Value::Mask(Arc::new(crate::buffers::MaskBuf { width, height, data: vec![w; width * height] })),
        ));
    }
}

/// The weight a masked node's edit is applied through at each pixel of
/// its frame, from the inputs the executor hands it (`in` and `mask`,
/// rendered): the mask scaled by the node's `mask_weight`, by the same
/// steps the executor takes (weigh_mask_input, then
/// blend_through_mask's reading). A mask of another size closes the
/// node, so the weight is zero there; no mask is the whole effect, the
/// weight everywhere. The export writes it as a Develop layer's mask
/// (2026-10-01: "The Export Mask as Layer option underneath Depth mask
/// in adjustment layers"). None when the node takes no mask or has no
/// picture to size the answer by.
pub fn applied_mask_weight(node: &heeler_graph::Node, inputs: &[(String, Value)]) -> Option<crate::buffers::MaskBuf> {
    node.input("mask")?;
    let mut inputs = inputs.to_vec();
    weigh_mask_input(node, &mut inputs);
    let frame = inputs.iter().find(|(port, _)| port == "in").and_then(|(_, v)| v.as_image())?;
    let (width, height) = (frame.width, frame.height);
    let flat = |v: f32| crate::buffers::MaskBuf { width, height, data: vec![v; width * height] };
    let weight = node
        .params
        .get(MASK_WEIGHT_PARAM)
        .and_then(|v| v.as_f64())
        .filter(|w| w.is_finite())
        .map(|w| w.clamp(0.0, 1.0) as f32)
        .unwrap_or(1.0);
    Some(match inputs.iter().find(|(port, _)| port == "mask").map(|(_, v)| v) {
        Some(Value::Mask(m)) if (m.width, m.height) == (width, height) => crate::buffers::MaskBuf {
            width,
            height,
            data: m.data.iter().map(|v| v.clamp(0.0, 1.0)).collect(),
        },
        // The gate closes: the node hands its input on untouched.
        Some(Value::Mask(_)) => flat(0.0),
        // A picture on the mask port is not a gate blend_through_mask
        // reads: the node's own result stands, the weight applied by
        // the scaling above when the node reads it itself.
        Some(Value::Image(_)) => flat(weight),
        None => flat(1.0),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use heeler_graph::{ParamValue, Registry, Section};

    /// applied_mask_weight is the weight the executor blended through:
    /// out = in + (processed - in) x weight, for a painted mask at a
    /// layer's opacity, an unwired mask at one, and a mask of another
    /// size (closed).
    #[test]
    fn applied_mask_weight_is_what_the_executor_blends_through() {
        for (case, weight, wired, mask_size) in [
            ("painted at 0.7", Some(0.7), true, (8, 6)),
            ("unwired at 0.4", Some(0.4), false, (8, 6)),
            ("unwired at none", None, false, (8, 6)),
            ("another size", Some(0.7), true, (4, 3)),
        ] {
            let mut rig = Rig::new();
            rig.source("src", ImageBuf::filled(8, 6, [0.2, 0.2, 0.2, 1.0]));
            // A linear gradient for a mask, measured on a frame of its own.
            rig.source("gate", ImageBuf::filled(mask_size.0, mask_size.1, [0.5, 0.5, 0.5, 1.0]));
            rig.node("heeler.linear_mask", "m");
            let mut grade = rig.registry.instantiate("heeler.exposure", "grade", Section::Creative).unwrap();
            grade.params.insert("exposure".into(), ParamValue::Number(1.0));
            if let Some(w) = weight {
                grade.params.insert(MASK_WEIGHT_PARAM.into(), ParamValue::Number(w));
            }
            let processed = {
                let mut bare = grade.clone();
                bare.id = "bare".into();
                bare.params.remove(MASK_WEIGHT_PARAM);
                bare
            };
            rig.graph.add_node(grade).unwrap();
            rig.graph.add_node(processed).unwrap();
            rig.graph.connect("src", "out", "grade", "in").unwrap();
            rig.graph.connect("src", "out", "bare", "in").unwrap();
            rig.graph.connect("gate", "out", "m", "in").unwrap();
            if wired {
                rig.graph.connect("m", "out", "grade", "mask").unwrap();
            }
            let mut exec = Executor::new();
            let out = exec.render(&rig.graph, "grade", &rig.sources).unwrap().as_image().unwrap().clone();
            let full = exec.render(&rig.graph, "bare", &rig.sources).unwrap().as_image().unwrap().clone();
            let mut inputs = vec![("in".to_string(), exec.render(&rig.graph, "src", &rig.sources).unwrap())];
            if wired {
                inputs.push(("mask".to_string(), exec.render(&rig.graph, "m", &rig.sources).unwrap()));
            }
            let node = rig.graph.node("grade").unwrap();
            let w = applied_mask_weight(node, &inputs).unwrap();
            assert_eq!((w.width, w.height), (8, 6), "{case}: on the node's frame");
            for px in 0..48 {
                let applied = (out.data[px * 4] - 0.2) / (full.data[px * 4] - 0.2);
                assert!((applied - w.data[px]).abs() < 1e-4, "{case}: pixel {px} applied {applied}, said {}", w.data[px]);
            }
        }
    }

    /// A Develop layer's Opacity (2026-09-30): the node's mask is scaled
    /// by its `mask_weight`, so an Exposure +1 through an all-white mask
    /// lands at none, half and all of its effect at 0, 0.5 and 1, and the
    /// mask node's own render is left as it was.
    #[test]
    fn mask_weight_scales_what_a_mask_lets_through() {
        let render = |weight: Option<f64>, wired: bool| {
            let mut rig = Rig::new();
            rig.source("src", ImageBuf::filled(8, 6, [0.2, 0.2, 0.2, 1.0]));
            rig.node("heeler.brush_mask", "m");
            let mut grade = rig.registry.instantiate("heeler.exposure", "grade", Section::Creative).unwrap();
            grade.params.insert("exposure".into(), ParamValue::Number(1.0));
            if let Some(w) = weight {
                grade.params.insert(MASK_WEIGHT_PARAM.into(), ParamValue::Number(w));
            }
            rig.graph.add_node(grade).unwrap();
            rig.graph.set_param("m", "invert", ParamValue::Bool(true)).unwrap();
            rig.graph.connect("src", "out", "grade", "in").unwrap();
            rig.graph.connect("src", "out", "m", "in").unwrap();
            if wired {
                rig.graph.connect("m", "out", "grade", "mask").unwrap();
            }
            let mut exec = Executor::new();
            let out = exec.render(&rig.graph, "grade", &rig.sources).unwrap().as_image().unwrap().pixel(3, 3)[0];
            let mask = exec.render(&rig.graph, "m", &rig.sources).unwrap();
            (out, mask.as_mask().map(|m| m.data[0]))
        };
        for wired in [true, false] {
            let (none, _) = render(Some(0.0), wired);
            let (half, mask) = render(Some(0.5), wired);
            let (full, _) = render(Some(1.0), wired);
            let (old, _) = render(None, wired);
            assert!((none - 0.2).abs() < 1e-6, "0 is no effect: {none}");
            assert!(full > 0.3, "1 is the whole effect: {full}");
            assert!((half - (0.2 + full) / 2.0).abs() < 1e-5, "0.5 is half the lift: {half} of {full}");
            assert_eq!(old, full, "no weight is full weight");
            if wired {
                assert_eq!(mask, Some(1.0), "the mask renders unscaled");
            }
        }
    }

    /// The weight is internal, like the measured mark: no node declares
    /// it, so it never becomes a control or a saved value of its own.
    #[test]
    fn no_node_declares_the_mask_weight() {
        let registry = Registry::builtin();
        for ty in registry.types() {
            let spec = registry.get(ty).unwrap();
            assert!(spec.params.iter().all(|p| p.name != MASK_WEIGHT_PARAM), "{ty} declares {MASK_WEIGHT_PARAM}");
        }
    }

    /// A mask turned off (MASK_OFF_PARAM) opens everywhere: the node it
    /// gates applies its whole effect, times the layer's opacity, as if
    /// it had no mask, and the export's applied weight says the same.
    /// The test mask is an unpainted brush mask, which on hides the
    /// layer everywhere: the opposite answer.
    #[test]
    fn a_mask_turned_off_opens_everywhere() {
        let render = |off: bool, weight: Option<f64>| {
            let mut rig = Rig::new();
            rig.source("src", ImageBuf::filled(8, 6, [0.2, 0.2, 0.2, 1.0]));
            let mut mask = rig.registry.instantiate("heeler.brush_mask", "m", Section::Creative).unwrap();
            if off {
                mask.params.insert(MASK_OFF_PARAM.into(), ParamValue::Bool(true));
            }
            let mut grade = rig.registry.instantiate("heeler.exposure", "grade", Section::Creative).unwrap();
            grade.params.insert("exposure".into(), ParamValue::Number(1.0));
            if let Some(w) = weight {
                grade.params.insert(MASK_WEIGHT_PARAM.into(), ParamValue::Number(w));
            }
            rig.graph.add_node(mask).unwrap();
            rig.graph.add_node(grade).unwrap();
            rig.graph.connect("src", "out", "grade", "in").unwrap();
            rig.graph.connect("src", "out", "m", "in").unwrap();
            rig.graph.connect("m", "out", "grade", "mask").unwrap();
            let mut exec = Executor::new();
            let out = exec.render(&rig.graph, "grade", &rig.sources).unwrap().as_image().unwrap().pixel(3, 3)[0];
            let inputs = vec![
                ("in".to_string(), exec.render(&rig.graph, "src", &rig.sources).unwrap()),
                ("mask".to_string(), exec.render(&rig.graph, "m", &rig.sources).unwrap()),
            ];
            let w = applied_mask_weight(rig.graph.node("grade").unwrap(), &inputs).unwrap();
            (out, w.data[0])
        };
        let (on, w_on) = render(false, None);
        assert!((on - 0.2).abs() < 1e-6, "an unpainted brush mask hides the layer: {on}");
        assert_eq!(w_on, 0.0);
        let (off, w_off) = render(true, None);
        assert!(off > 0.3, "off, the layer applies everywhere: {off}");
        assert_eq!(w_off, 1.0, "the export writes white");
        let (half, w_half) = render(true, Some(0.5));
        assert!((half - (0.2 + off) / 2.0).abs() < 1e-5, "times the opacity: {half}");
        assert!((w_half - 0.5).abs() < 1e-6, "the export writes the opacity: {w_half}");
    }

    /// The off mark is internal: no node declares it.
    #[test]
    fn no_node_declares_the_mask_off() {
        let registry = Registry::builtin();
        for ty in registry.types() {
            let spec = registry.get(ty).unwrap();
            assert!(spec.params.iter().all(|p| p.name != MASK_OFF_PARAM), "{ty} declares {MASK_OFF_PARAM}");
        }
    }

    /// A mask of another size than the frame a masked node works on
    /// closes the node (its input handed on untouched) rather than
    /// dropping out and letting the node apply everywhere: a Develop
    /// layer whose mask read the photograph ahead of a crop.
    #[test]
    fn a_node_mask_of_another_size_closes_the_node() {
        let mut rig = Rig::new();
        let photo = ImageBuf::filled(8, 6, [0.2, 0.2, 0.2, 1.0]);
        rig.source("src", photo.clone()).source("whole", ImageBuf::filled(12, 6, [0.2, 0.2, 0.2, 1.0]));
        rig.node("heeler.brush_mask", "m").node("heeler.exposure", "grade");
        rig.graph.set_param("m", "invert", ParamValue::Bool(true)).unwrap();
        rig.graph.set_param("grade", "exposure", ParamValue::Number(1.0)).unwrap();
        rig.graph.connect("src", "out", "grade", "in").unwrap();
        rig.graph.connect("whole", "out", "m", "in").unwrap();
        rig.graph.connect("m", "out", "grade", "mask").unwrap();
        let _ = ops::take_mask_mismatches();
        let out = Executor::new().render(&rig.graph, "grade", &rig.sources).unwrap();
        assert_eq!(out.as_image().unwrap().data, photo.data, "closed, not applied everywhere");
        let notes = ops::take_mask_mismatches();
        assert!(notes.iter().any(|n| n.contains("grade") && n.contains("12 by 6") && n.contains("8 by 6")), "{notes:?}");
        // The same mask on a frame its size gates as it always did.
        rig.graph.disconnect("m", "in").unwrap();
        rig.graph.connect("src", "out", "m", "in").unwrap();
        let out = Executor::new().render(&rig.graph, "grade", &rig.sources).unwrap();
        assert!(out.as_image().unwrap().pixel(3, 3)[0] > 0.39, "an all-white mask applies the grade");
        assert!(ops::take_mask_mismatches().is_empty());
    }

    #[test]
    fn detail_admission_covers_its_extra_frames() {
        let estimate = |kind: &str| {
            let mut rig = Rig::new();
            rig.node("heeler.image_source", "src").node(kind, "effect");
            rig.graph.connect("src", "out", "effect", "in").unwrap();
            rig.sources.insert("src".into(), SourceImage {
                image: Arc::new(ImageBuf { width: 6000, height: 4000, data: Vec::new() }),
                version: 1, measured: false,
            });
            Executor::new().estimate(&rig.graph, "effect", &rig.sources).unwrap()
        };
        assert!(estimate("heeler.detail") >= estimate("heeler.clarity") + 6000 * 4000 * 64);
    }

    /// A stop flag that trips after the first poll stops the walk with
    /// Canceled and leaves the rest unevaluated; cleared, the same
    /// executor renders to the end.
    #[test]
    fn a_tripped_stop_flag_cancels_between_nodes() {
        use std::sync::atomic::{AtomicUsize, Ordering};
        let mut rig = Rig::new();
        rig.node("heeler.image_source", "src").node("heeler.exposure", "a").node("heeler.exposure", "b");
        rig.graph.connect("src", "out", "a", "in").unwrap();
        rig.graph.connect("a", "out", "b", "in").unwrap();
        rig.graph.set_param("a", "exposure", ParamValue::Number(0.5)).unwrap();
        rig.graph.set_param("b", "exposure", ParamValue::Number(-0.5)).unwrap();
        rig.sources.insert("src".into(), SourceImage { image: Arc::new(ImageBuf::filled(8, 8, [0.2, 0.2, 0.2, 1.0])), version: 1, measured: false });
        let mut exec = Executor::new();
        let polls = Arc::new(AtomicUsize::new(0));
        let seen = polls.clone();
        exec.set_stop(Some(Box::new(move || seen.fetch_add(1, Ordering::SeqCst) >= 1)));
        match exec.render(&rig.graph, "b", &rig.sources) {
            Err(EngineError::Cancelled) => {}
            other => panic!("expected EngineError::Cancelled, got {other:?}"),
        }
        assert!(polls.load(Ordering::SeqCst) >= 2, "the walk polled the flag per node: {}", polls.load(Ordering::SeqCst));
        exec.set_stop(None);
        let out = exec.render(&rig.graph, "b", &rig.sources).unwrap();
        assert!(out.as_image().is_some());
    }

    #[test]
    fn cancellation_is_polled_again_after_inputs_and_before_cached_results() {
        use std::sync::atomic::{AtomicUsize, Ordering};
        let mut rig = Rig::new();
        rig.node("heeler.image_source", "src").node("heeler.exposure", "a").node("heeler.exposure", "b");
        rig.graph.connect("src", "out", "a", "in").unwrap();
        rig.graph.connect("a", "out", "b", "in").unwrap();
        rig.sources.insert("src".into(), SourceImage { image: Arc::new(ImageBuf::filled(8, 8, [0.2,0.2,0.2,1.0])), version:1, measured:false });
        let mut exec = Executor::new();
        let polls = Arc::new(AtomicUsize::new(0));
        exec.set_stop(Some(Box::new(move || polls.fetch_add(1, Ordering::SeqCst) >= 4)));
        assert!(matches!(exec.render(&rig.graph, "b", &rig.sources), Err(EngineError::Cancelled)));
        assert!(!exec.stats.executions.contains_key("a"));
        assert!(!exec.stats.executions.contains_key("b"));
        assert!(exec.stats.executions.contains_key("src"), "completed input stays cached");
        exec.set_stop(None);
        exec.render(&rig.graph,"b",&rig.sources).unwrap();
        assert!(exec.stats.cache_hits > 0);
        exec.set_stop(Some(Box::new(|| true)));
        assert!(matches!(exec.render(&rig.graph,"b",&rig.sources),Err(EngineError::Cancelled)));
    }

    #[test]
    fn admission_tracks_crop_dimensions_without_allocating_sensor_pixels() {
        let mut rig = Rig::new();
        rig.node("heeler.image_source", "src").node("heeler.crop_rotate", "crop").node("heeler.exposure", "exp");
        rig.graph.connect("src", "out", "crop", "in").unwrap();
        rig.graph.connect("crop", "out", "exp", "in").unwrap();
        rig.sources.insert("src".into(), SourceImage { image: Arc::new(ImageBuf { width: 6000, height: 4000, data: Vec::new() }), version: 1, measured: false });
        let exec = Executor::new();
        let full = exec.estimate(&rig.graph, "exp", &rig.sources).unwrap();
        rig.graph.set_param("crop", "crop_w", ParamValue::Number(0.25)).unwrap();
        rig.graph.set_param("crop", "crop_h", ParamValue::Number(0.25)).unwrap();
        let crop = exec.estimate(&rig.graph, "exp", &rig.sources).unwrap();
        assert_eq!(crop * 16, full);
    }

    const EPS: f32 = 1e-5;

    fn assert_close(a: f32, b: f32) {
        assert!((a - b).abs() < EPS, "{a} != {b}");
    }

    struct Rig {
        graph: Graph,
        sources: HashMap<String, SourceImage>,
        registry: Registry,
    }

    impl Rig {
        fn new() -> Self {
            Rig {
                graph: Graph::new("test"),
                sources: HashMap::new(),
                registry: Registry::builtin(),
            }
        }

        fn node(&mut self, node_type: &str, id: &str) -> &mut Self {
            let n = self
                .registry
                .instantiate(node_type, id, Section::Creative)
                .unwrap();
            self.graph.add_node(n).unwrap();
            self
        }

        fn source(&mut self, id: &str, image: ImageBuf) -> &mut Self {
            self.node("heeler.image_source", id);
            self.sources.insert(
                id.to_string(),
                SourceImage {
                    image: Arc::new(image),
                    version: 1,
                    measured: false,
                },
            );
            self
        }

        fn wire(&mut self, from: &str, from_port: &str, to: &str, to_port: &str) -> &mut Self {
            self.graph.connect(from, from_port, to, to_port).unwrap();
            self
        }

        fn set(&mut self, node: &str, param: &str, v: f64) -> &mut Self {
            self.graph
                .set_param(node, param, ParamValue::Number(v))
                .unwrap();
            self
        }

        fn render(&self, exec: &mut Executor, node: &str) -> Value {
            exec.render(&self.graph, node, &self.sources).unwrap()
        }
    }

    fn gray(v: f32) -> ImageBuf {
        ImageBuf::filled(2, 2, [v, v, v, 1.0])
    }

    #[test]
    fn source_renders_through_output_untouched() {
        let mut rig = Rig::new();
        rig.source("src", gray(0.25))
            .node("heeler.output", "out")
            .wire("src", "out", "out", "in");
        let mut exec = Executor::new();
        let v = rig.render(&mut exec, "out");
        assert_eq!(v.as_image().unwrap().pixel(0, 0), [0.25, 0.25, 0.25, 1.0]);
    }

    #[test]
    fn exposure_defaults_are_identity() {
        let mut rig = Rig::new();
        rig.source("src", gray(0.4))
            .node("heeler.exposure", "e")
            .wire("src", "out", "e", "in");
        let mut exec = Executor::new();
        let v = rig.render(&mut exec, "e");
        let px = v.as_image().unwrap().pixel(0, 0);
        assert_close(px[0], 0.4);
        assert_close(px[3], 1.0);
    }

    #[test]
    fn exposure_plus_one_ev_doubles_linear_values() {
        let mut rig = Rig::new();
        rig.source("src", gray(0.2))
            .node("heeler.exposure", "e")
            .wire("src", "out", "e", "in")
            .set("e", "exposure", 1.0);
        let mut exec = Executor::new();
        let px = rig.render(&mut exec, "e").as_image().unwrap().pixel(0, 0);
        assert_close(px[0], 0.4);
        assert_close(px[3], 1.0, );
    }

    #[test]
    fn contrast_leaves_pivot_gray_unchanged() {
        // Contrast now works in display space (measured against the
        // reference RAW editors: the old scene-linear pivot multiply sent the shadow band
        // to black at +100), but its anchor is still middle gray, and
        // that value must not move at any strength.
        let mut rig = Rig::new();
        rig.source("src", gray(ops::CONTRAST_PIVOT))
            .node("heeler.exposure", "e")
            .wire("src", "out", "e", "in")
            .set("e", "contrast", 60.0);
        let mut exec = Executor::new();
        let px = rig.render(&mut exec, "e").as_image().unwrap().pixel(0, 0);
        assert!(
            (px[0] - ops::CONTRAST_PIVOT).abs() < 1e-4,
            "{} moved from {}",
            px[0],
            ops::CONTRAST_PIVOT
        );
    }

    #[test]
    fn positive_contrast_spreads_values_from_pivot() {
        let mut rig = Rig::new();
        let mut img = ImageBuf::new(2, 1);
        img.set_pixel(0, 0, [0.05, 0.05, 0.05, 1.0]);
        img.set_pixel(1, 0, [0.5, 0.5, 0.5, 1.0]);
        rig.source("src", img)
            .node("heeler.exposure", "e")
            .wire("src", "out", "e", "in")
            .set("e", "contrast", 50.0);
        let mut exec = Executor::new();
        let out = rig.render(&mut exec, "e");
        let img = out.as_image().unwrap();
        assert!(img.pixel(0, 0)[0] < 0.05, "darks pushed darker");
        assert!(img.pixel(1, 0)[0] > 0.5, "brights pushed brighter");
    }

    #[test]
    fn highlights_affect_bright_pixels_more_than_dark() {
        let mut rig = Rig::new();
        let mut img = ImageBuf::new(2, 1);
        img.set_pixel(0, 0, [0.05, 0.05, 0.05, 1.0]);
        img.set_pixel(1, 0, [0.9, 0.9, 0.9, 1.0]);
        rig.source("src", img)
            .node("heeler.exposure", "e")
            .wire("src", "out", "e", "in")
            .set("e", "highlights", -100.0);
        let mut exec = Executor::new();
        let out = rig.render(&mut exec, "e");
        let img = out.as_image().unwrap();
        let dark_ratio = img.pixel(0, 0)[0] / 0.05;
        let bright_ratio = img.pixel(1, 0)[0] / 0.9;
        assert!(bright_ratio < dark_ratio, "highlight cut must hit brights harder");
        assert!(bright_ratio < 1.0);
    }

    #[test]
    fn shadows_lift_dark_pixels_more_than_bright() {
        let mut rig = Rig::new();
        let mut img = ImageBuf::new(2, 1);
        img.set_pixel(0, 0, [0.05, 0.05, 0.05, 1.0]);
        img.set_pixel(1, 0, [0.9, 0.9, 0.9, 1.0]);
        rig.source("src", img)
            .node("heeler.exposure", "e")
            .wire("src", "out", "e", "in")
            .set("e", "shadows", 100.0);
        let mut exec = Executor::new();
        let out = rig.render(&mut exec, "e");
        let img = out.as_image().unwrap();
        assert!(img.pixel(0, 0)[0] / 0.05 > img.pixel(1, 0)[0] / 0.9);
    }

    #[test]
    fn white_balance_neutral_at_defaults() {
        let mut rig = Rig::new();
        rig.source("src", gray(0.3))
            .node("heeler.white_balance", "wb")
            .wire("src", "out", "wb", "in");
        let mut exec = Executor::new();
        let px = rig.render(&mut exec, "wb").as_image().unwrap().pixel(0, 0);
        assert_close(px[0], 0.3);
        assert_close(px[1], 0.3);
        assert_close(px[2], 0.3);
    }

    #[test]
    fn warmer_temperature_raises_red_lowers_blue() {
        let mut rig = Rig::new();
        rig.source("src", gray(0.3))
            .node("heeler.white_balance", "wb")
            .wire("src", "out", "wb", "in")
            .set("wb", "temperature", 10000.0);
        let mut exec = Executor::new();
        let px = rig.render(&mut exec, "wb").as_image().unwrap().pixel(0, 0);
        assert!(px[0] > 0.3);
        assert!(px[2] < 0.3);
        assert_close(px[1], 0.3);
    }

    /// Levels reads on the display axis (2026-09-13): a pixel the screen
    /// shows at 0.5 sits at 0.5 on the widget, and black 0.2 / white 0.8
    /// leave it exactly there; gamma 2 lifts it to sqrt(0.5) on that axis.
    #[test]
    fn levels_remap_is_exact() {
        use crate::ops::to_scene;
        let mut rig = Rig::new();
        rig.source("src", gray(to_scene(0.5)))
            .node("heeler.levels", "l")
            .wire("src", "out", "l", "in")
            .set("l", "black", 0.2)
            .set("l", "white", 0.8);
        let mut exec = Executor::new();
        let px = rig.render(&mut exec, "l").as_image().unwrap().pixel(0, 0);
        assert_close(px[0], to_scene(0.5));

        rig.set("l", "gamma", 2.0);
        let mut exec = Executor::new();
        let px = rig.render(&mut exec, "l").as_image().unwrap().pixel(0, 0);
        assert_close(px[0], to_scene(0.5f32.powf(0.5)));
    }

    /// The White falloff keeps the headroom above white: a super-white
    /// beyond the knee comes out where it went in, the knee shapes only
    /// the approach to white.
    #[test]
    fn levels_white_falloff_keeps_super_whites() {
        use crate::ops::to_scene;
        let mut rig = Rig::new();
        rig.source("src", gray(to_scene(1.8)))
            .node("heeler.levels", "l")
            .wire("src", "out", "l", "in")
            .set("l", "white_soft", 60.0);
        let mut exec = Executor::new();
        let px = rig.render(&mut exec, "l").as_image().unwrap().pixel(0, 0);
        assert!((px[0] - to_scene(1.8)).abs() < 1e-4, "headroom kept through the knee: {}", px[0]);
        // Below white the knee still rolls toward the clip.
        let mut rig = Rig::new();
        rig.source("src", gray(to_scene(0.95)))
            .node("heeler.levels", "l")
            .wire("src", "out", "l", "in")
            .set("l", "white_soft", 60.0);
        let mut exec = Executor::new();
        let px = rig.render(&mut exec, "l").as_image().unwrap().pixel(0, 0);
        assert!(px[0] < to_scene(0.95) && px[0] > to_scene(0.85), "the knee rolls the approach: {}", px[0]);
    }

    /// An untouched Levels is the input itself, wherever it sits: no
    /// round trip through the transfer pair.
    #[test]
    fn identity_levels_is_bit_exact() {
        let mut rig = Rig::new();
        rig.source("src", gray(0.3)).node("heeler.levels", "l").wire("src", "out", "l", "in");
        let mut exec = Executor::new();
        let px = rig.render(&mut exec, "l").as_image().unwrap().pixel(0, 0);
        assert_eq!(px[0], 0.3);
    }

    /// The soft knees: a value just under the black point rolls to a
    /// small positive instead of snapping to zero, and the far field
    /// is untouched - same mirrored at white.
    #[test]
    fn levels_knees_roll_instead_of_snapping() {
        let mut rig = Rig::new();
        rig.source("src", gray(0.0)).node("heeler.levels", "lv").wire("src", "out", "lv", "in");
        rig.graph.set_param("lv", "black", ParamValue::Number(0.2)).unwrap();
        rig.graph.set_param("lv", "black_soft", ParamValue::Number(80.0)).unwrap();
        let mut exec = Executor::new();
        // Hard levels would clip 0.15 (below black 0.2) to <= 0; the
        // knee keeps a little light in it.
        // On the display axis: 0.15 as shown sits under the black point.
        let dark = crate::ops::to_scene(0.15);
        rig.sources.get_mut("src").unwrap().image = std::sync::Arc::new({
            let mut i = ImageBuf::new(2, 1);
            i.set_pixel(0, 0, [dark, dark, dark, 1.0]);
            i.set_pixel(1, 0, [0.9, 0.9, 0.9, 1.0]);
            i
        });
        rig.sources.get_mut("src").unwrap().version += 1;
        let out = rig.render(&mut exec, "lv");
        let img = out.as_image().unwrap();
        assert!(img.data[0] > 0.0, "the knee keeps shadow detail: {}", img.data[0]);
        assert!(img.data[0] < 0.06, "but barely: {}", img.data[0]);
        // Bright values far from the knee are the plain remap, on the
        // display axis and back.
        let plain = crate::ops::to_scene((crate::ops::to_display(0.9) - 0.2) / 0.8);
        assert!((img.pixel(1, 0)[0] - plain).abs() < 1e-4);
    }

    #[test]
    fn luminance_extract_uses_rec709_luma() {
        let mut rig = Rig::new();
        rig.source("src", ImageBuf::filled(1, 1, [1.0, 0.0, 0.0, 1.0]))
            .node("heeler.luminance_extract", "lum")
            .wire("src", "out", "lum", "in");
        let mut exec = Executor::new();
        let v = rig.render(&mut exec, "lum");
        assert_close(v.as_mask().unwrap().value(0, 0), 0.2126);
    }

    #[test]
    fn luminance_range_mask_windows_correctly() {
        let mut rig = Rig::new();
        let mut img = ImageBuf::new(3, 1);
        img.set_pixel(0, 0, [0.05, 0.05, 0.05, 1.0]);
        img.set_pixel(1, 0, [0.5, 0.5, 0.5, 1.0]);
        img.set_pixel(2, 0, [0.95, 0.95, 0.95, 1.0]);
        rig.source("src", img)
            .node("heeler.luminance_range_mask", "m")
            .wire("src", "out", "m", "in")
            .set("m", "low", 0.3)
            .set("m", "high", 0.7)
            .set("m", "feather", 0.05);
        let mut exec = Executor::new();
        let v = rig.render(&mut exec, "m");
        let m = v.as_mask().unwrap();
        assert_close(m.value(0, 0), 0.0);
        assert_close(m.value(1, 0), 1.0);
        assert_close(m.value(2, 0), 0.0);
    }

    #[test]
    fn blend_multiply_and_opacity() {
        let mut rig = Rig::new();
        rig.source("a", gray(0.5))
            .source("b", gray(0.4))
            .node("heeler.blend", "bl")
            .wire("a", "out", "bl", "base")
            .wire("b", "out", "bl", "blend");
        rig.graph
            .set_param("bl", "mode", ParamValue::Text("multiply".into()))
            .unwrap();
        let mut exec = Executor::new();
        let px = rig.render(&mut exec, "bl").as_image().unwrap().pixel(0, 0);
        assert_close(px[0], 0.2);

        rig.set("bl", "opacity", 50.0);
        let mut exec = Executor::new();
        let px = rig.render(&mut exec, "bl").as_image().unwrap().pixel(0, 0);
        assert_close(px[0], 0.35, );
    }

    #[test]
    fn merge_composites_over_by_alpha() {
        let mut rig = Rig::new();
        rig.source("base", ImageBuf::filled(1, 1, [1.0, 0.0, 0.0, 1.0]))
            .source("fg", ImageBuf::filled(1, 1, [0.0, 1.0, 0.0, 0.25]))
            .node("heeler.merge", "m")
            .wire("base", "out", "m", "base")
            .wire("fg", "out", "m", "fg");
        let mut exec = Executor::new();
        let px = rig.render(&mut exec, "m").as_image().unwrap().pixel(0, 0);
        assert_close(px[0], 0.75);
        assert_close(px[1], 0.25);
        assert_close(px[3], 1.0);
    }

    #[test]
    fn disabled_node_passes_input_through() {
        let mut rig = Rig::new();
        rig.source("src", gray(0.3))
            .node("heeler.exposure", "e")
            .wire("src", "out", "e", "in")
            .set("e", "exposure", 2.0);
        rig.graph.set_enabled("e", false).unwrap();
        let mut exec = Executor::new();
        let px = rig.render(&mut exec, "e").as_image().unwrap().pixel(0, 0);
        assert_close(px[0], 0.3);
    }

    #[test]
    fn disabled_logic_node_passes_operand_a_through() {
        // The logic family has no image input; "disabled" there means
        // the first mask operand flows on unchanged.
        let mut rig = Rig::new();
        rig.source("src", gray(0.3))
            .node("heeler.measure", "m")
            .node("heeler.logic", "lg")
            .wire("src", "out", "m", "in")
            .wire("m", "out", "lg", "in");
        rig.graph.set_enabled("lg", false).unwrap();
        let mut exec = Executor::new();
        let v = rig.render(&mut exec, "lg");
        assert_close(v.as_mask().unwrap().value(0, 0), 0.3);
    }

    #[test]
    fn conditional_full_scene() {
        let mut rig = Rig::new();
        let mut img = ImageBuf::new(2, 1);
        img.set_pixel(0, 0, [0.8, 0.2, 0.2, 1.0]); // red high: then
        img.set_pixel(1, 0, [0.2, 0.2, 0.2, 1.0]); // red low: else
        rig.source("src", img)
            .node("heeler.measure", "red")
            .node("heeler.compare", "cond")
            .node("heeler.channel_gain", "then")
            .node("heeler.conditional", "if")
            .wire("src", "out", "red", "in")
            .wire("red", "out", "cond", "in")
            .wire("src", "out", "then", "in")
            .wire("src", "out", "if", "in")
            .wire("then", "out", "if", "fg")
            .wire("cond", "out", "if", "mask");
        rig.graph
            .set_param("red", "metric", ParamValue::Text("red".into()))
            .unwrap();
        rig.graph
            .set_param("then", "channel", ParamValue::Text("blue".into()))
            .unwrap();
        rig.set("then", "gain", 200.0);
        rig.set("cond", "level", 0.5);
        let mut exec = Executor::new();
        let out = rig.render(&mut exec, "if");
        let img = out.as_image().unwrap();
        // Pixel 0: condition true, blue doubled. Pixel 1: else, untouched.
        assert_close(img.pixel(0, 0)[2], 0.4);
        assert_close(img.pixel(0, 0)[0], 0.8);
        assert_close(img.pixel(1, 0)[2], 0.2);
    }

    #[test]
    fn disabled_conditional_is_its_else_branch() {
        let mut rig = Rig::new();
        rig.source("a", gray(0.2))
            .source("b", gray(0.9))
            .node("heeler.conditional", "if")
            .wire("a", "out", "if", "in")
            .wire("b", "out", "if", "fg");
        rig.graph.set_enabled("if", false).unwrap();
        let mut exec = Executor::new();
        let px = rig.render(&mut exec, "if").as_image().unwrap().pixel(0, 0);
        assert_close(px[0], 0.2);
    }

    #[test]
    fn conditional_with_no_condition_passes_else_whole() {
        let mut rig = Rig::new();
        rig.source("a", gray(0.2))
            .source("b", gray(0.9))
            .node("heeler.conditional", "if")
            .wire("a", "out", "if", "in")
            .wire("b", "out", "if", "fg");
        let mut exec = Executor::new();
        let px = rig.render(&mut exec, "if").as_image().unwrap().pixel(0, 0);
        assert_close(px[0], 0.2);
    }

    #[test]
    fn masked_node_with_resized_output_is_not_blended() {
        // blend_through_mask used to guard mask size against the input
        // only. A node whose output is a different size than its input
        // would blend corner-against-corner, and a LARGER output would
        // index the mask out of bounds. The guard now wants the full
        // same-size triple; anything else passes the result unblended.
        let mut rig = Rig::new();
        rig.source("src", gray(0.4))
            .node("heeler.luminance_range_mask", "m")
            .node("heeler.exposure", "e")
            .wire("src", "out", "m", "in")
            .wire("src", "out", "e", "in")
            .wire("m", "out", "e", "mask")
            .set("e", "exposure", 1.0)
            .set("m", "low", 0.3)
            .set("m", "feather", 0.05);
        let mut exec = Executor::new();
        // 0.4 luma is inside the 0.3..1 window: full +1 EV, blended
        // normally (the same-size path must keep working).
        let px = rig.render(&mut exec, "e").as_image().unwrap().pixel(0, 0);
        assert_close(px[0], 0.8);
    }

    #[test]
    fn mask_input_limits_adjustment() {
        // Full-white source: exposure +1 doubles it, but the luminance range
        // mask over a half-dark half-bright source gates where it applies.
        let mut rig = Rig::new();
        let mut key_img = ImageBuf::new(2, 1);
        key_img.set_pixel(0, 0, [0.0, 0.0, 0.0, 1.0]);
        key_img.set_pixel(1, 0, [1.0, 1.0, 1.0, 1.0]);
        let mut main_img = ImageBuf::new(2, 1);
        main_img.set_pixel(0, 0, [0.2, 0.2, 0.2, 1.0]);
        main_img.set_pixel(1, 0, [0.2, 0.2, 0.2, 1.0]);

        rig.source("main", main_img)
            .source("key", key_img)
            .node("heeler.luminance_range_mask", "m")
            .node("heeler.exposure", "e")
            .wire("key", "out", "m", "in")
            .wire("main", "out", "e", "in")
            .wire("m", "out", "e", "mask")
            .set("e", "exposure", 1.0)
            .set("m", "low", 0.5)
            .set("m", "feather", 0.01);

        let mut exec = Executor::new();
        let out = rig.render(&mut exec, "e");
        let img = out.as_image().unwrap();
        assert_close(img.pixel(0, 0)[0], 0.2, );
        assert_close(img.pixel(1, 0)[0], 0.4, );
    }

    #[test]
    fn second_render_is_fully_cached() {
        let mut rig = Rig::new();
        rig.source("src", gray(0.3))
            .node("heeler.exposure", "e")
            .node("heeler.levels", "l")
            .wire("src", "out", "e", "in")
            .wire("e", "out", "l", "in");
        let mut exec = Executor::new();
        rig.render(&mut exec, "l");
        assert_eq!(exec.stats.executions.get("e"), Some(&1));
        assert_eq!(exec.stats.executions.get("l"), Some(&1));

        rig.render(&mut exec, "l");
        assert_eq!(exec.stats.executions.get("e"), Some(&1), "no re-execution");
        assert_eq!(exec.stats.executions.get("l"), Some(&1));
        assert!(exec.stats.cache_hits >= 1);
    }

    #[test]
    fn param_change_recomputes_only_downstream() {
        let mut rig = Rig::new();
        rig.source("src", gray(0.3))
            .node("heeler.exposure", "e")
            .node("heeler.levels", "l")
            .wire("src", "out", "e", "in")
            .wire("e", "out", "l", "in");
        let mut exec = Executor::new();
        rig.render(&mut exec, "l");

        rig.set("l", "gamma", 2.0);
        rig.render(&mut exec, "l");

        assert_eq!(
            exec.stats.executions.get("e"),
            Some(&1),
            "upstream exposure must stay cached"
        );
        assert_eq!(
            exec.stats.executions.get("l"),
            Some(&2),
            "levels must recompute with the new gamma"
        );
    }

    #[test]
    fn source_version_bump_invalidates_downstream() {
        let mut rig = Rig::new();
        rig.source("src", gray(0.3))
            .node("heeler.exposure", "e")
            .wire("src", "out", "e", "in");
        let mut exec = Executor::new();
        rig.render(&mut exec, "e");
        rig.sources.get_mut("src").unwrap().version = 2;
        rig.render(&mut exec, "e");
        assert_eq!(exec.stats.executions.get("e"), Some(&2));
    }

    #[test]
    fn missing_required_input_errors() {
        let mut rig = Rig::new();
        rig.node("heeler.exposure", "e");
        let mut exec = Executor::new();
        let err = exec.render(&rig.graph, "e", &rig.sources).unwrap_err();
        assert_eq!(
            err,
            EngineError::MissingInput {
                node: "e".into(),
                port: "in".into()
            }
        );
    }

    #[test]
    fn unsupported_node_reports_cleanly() {
        let mut rig = Rig::new();
        rig.source("src", gray(0.3)).node("heeler.exposure", "g");
        // Hand-craft a node type the registry knows nothing about; every
        // registry type is implemented, so this simulates a future/plugin
        // node reaching an older engine.
        let mut mystery = rig
            .registry
            .instantiate("heeler.exposure", "x", Section::Creative)
            .unwrap();
        mystery.node_type = "heeler.mystery".into();
        rig.graph.add_node(mystery).unwrap();
        rig.wire("src", "out", "x", "in");
        let mut exec = Executor::new();
        let err = exec.render(&rig.graph, "x", &rig.sources).unwrap_err();
        assert_eq!(err, EngineError::UnsupportedNode("heeler.mystery".into()));
    }

    #[test]
    fn missing_source_image_errors() {
        let mut rig = Rig::new();
        rig.node("heeler.image_source", "src");
        let mut exec = Executor::new();
        let err = exec.render(&rig.graph, "src", &rig.sources).unwrap_err();
        assert_eq!(err, EngineError::SourceMissing("src".into()));
    }

    #[test]
    fn trim_keeps_the_most_recent_cache_entries() {
        let mut exec = Executor::new();
        for key in 1..=4 {
            exec.cache.insert(key, Value::Image(Arc::new(gray(key as f32))));
            exec.touch(key);
        }
        // Make the first entry hot again before trimming the two oldest.
        exec.touch(1);
        exec.trim(2);
        assert_eq!(exec.cache.len(), 2);
        assert!(exec.cache.contains_key(&1));
        assert!(exec.cache.contains_key(&4));
        assert_eq!(exec.cache.len(), exec.cache_used.len());
    }

    #[test]
    fn trim_bytes_evicts_oldest_until_the_budget_holds() {
        let px = |w: usize| Value::Image(Arc::new(ImageBuf::new(w, 1)));
        let mut exec = Executor::new();
        // Four entries of 100 pixels = 1600 bytes each, oldest first.
        for key in 1..=4u64 {
            exec.cache.insert(key, px(100));
            exec.touch(key);
        }
        // Entry 1 becomes the hot one before the budget bites.
        exec.touch(1);
        // Room for two entries: the two least recently used (2, 3) go,
        // the hot 1 and the newest 4 survive.
        exec.trim_bytes(3200);
        assert!(exec.cache.contains_key(&1), "hot entry survives");
        assert!(exec.cache.contains_key(&4), "newest entry survives");
        assert!(!exec.cache.contains_key(&2));
        assert!(!exec.cache.contains_key(&3));
        assert_eq!(exec.cache.len(), exec.cache_used.len());

        // Under budget: untouched.
        exec.trim_bytes(1_000_000);
        assert_eq!(exec.cache.len(), 2);

        // A single entry over budget stays: evicting the frame just
        // used would make the cache pure overhead. The survivor is the
        // most recently USED, which the touch above made entry 1.
        exec.trim_bytes(16);
        assert_eq!(exec.cache.len(), 1);
        assert!(exec.cache.contains_key(&1), "most recently used survives any budget");
    }

    #[test]
    fn seeded_intermediate_skips_upstream_execution() {
        // The ROI path carries an expensive intermediate across throwaway
        // executors by seeding it. A render that reaches the seeded node
        // must be a cache hit: nothing upstream of it may execute.
        let mut rig = Rig::new();
        rig.source("src", gray(0.3))
            .node("heeler.exposure", "e")
            .node("heeler.levels", "l")
            .wire("src", "out", "e", "in")
            .wire("e", "out", "l", "in");

        let slice_key = Executor::key_of(&rig.graph, "e", &rig.sources).unwrap();
        let mut exec = Executor::new();
        exec.seed(slice_key, Value::Image(Arc::new(gray(0.9))));
        let v = rig.render(&mut exec, "l");
        assert_eq!(
            exec.stats.executions.get("e"),
            None,
            "seeded node must not execute"
        );
        assert_eq!(
            exec.stats.executions.get("src"),
            None,
            "nothing upstream of a seeded node may execute"
        );
        assert_eq!(exec.stats.executions.get("l"), Some(&1));
        // levels(gamma default 1) over the seeded 0.9, not the source's 0.3.
        assert_close(v.as_image().unwrap().pixel(0, 0)[0], 0.9);
    }

    #[test]
    fn key_of_is_stable_and_input_sensitive() {
        let mut rig = Rig::new();
        rig.source("src", gray(0.3))
            .node("heeler.exposure", "e")
            .wire("src", "out", "e", "in");
        let a = Executor::key_of(&rig.graph, "e", &rig.sources).unwrap();
        let b = Executor::key_of(&rig.graph, "e", &rig.sources).unwrap();
        assert_eq!(a, b);
        rig.set("e", "exposure", 1.0);
        let c = Executor::key_of(&rig.graph, "e", &rig.sources).unwrap();
        assert_ne!(a, c);
    }

    #[test]
    fn cache_hit_does_not_execute_ancestors() {
        // With only the terminal cached, a render is one hash walk and one
        // hit: the source's version feeds the key, but no upstream node
        // (source included) executes.
        let mut rig = Rig::new();
        rig.source("src", gray(0.3))
            .node("heeler.exposure", "e")
            .wire("src", "out", "e", "in");
        let key = Executor::key_of(&rig.graph, "e", &rig.sources).unwrap();
        let mut exec = Executor::new();
        exec.seed(key, Value::Image(Arc::new(gray(0.5))));
        let v = rig.render(&mut exec, "e");
        assert_close(v.as_image().unwrap().pixel(0, 0)[0], 0.5);
        assert!(exec.stats.cache_hits >= 1);
        assert!(exec.stats.executions.is_empty(), "a full hit executes nothing");
    }

    /// The smart mask's raster rides the sources map under the node's
    /// own id: absent it renders empty (never errors), present it
    /// renders the raster through the dials, and bumping the planted
    /// version is what invalidates the cache.
    #[test]
    fn smart_mask_reads_its_planted_raster_and_its_version() {
        let mut rig = Rig::new();
        rig.source("src", gray(0.3))
            .node("heeler.smart_mask", "sm")
            .wire("src", "out", "sm", "in");

        let mut exec = Executor::new();
        let empty = rig.render(&mut exec, "sm");
        assert!(empty.as_mask().unwrap().data.iter().all(|v| *v == 0.0), "no raster: empty");

        // Plant a raster: full confidence everywhere.
        let mut raster = ImageBuf::new(2, 2);
        for px in raster.data.chunks_mut(4) {
            px.copy_from_slice(&[0.9, 0.9, 0.9, 1.0]);
        }
        rig.sources.insert(
            "sm".to_string(),
            SourceImage { image: Arc::new(raster), version: 7, measured: false },
        );
        let full = rig.render(&mut exec, "sm");
        assert!(
            full.as_mask().unwrap().data.iter().all(|v| *v > 0.9),
            "the planted raster renders"
        );

        // Same version renders from cache; a new version recomputes.
        let before = exec.stats.executions.get("sm").copied().unwrap_or(0);
        let _ = rig.render(&mut exec, "sm");
        assert_eq!(exec.stats.executions.get("sm").copied().unwrap_or(0), before);
        rig.sources.get_mut("sm").unwrap().version = 8;
        let _ = rig.render(&mut exec, "sm");
        assert_eq!(exec.stats.executions.get("sm").copied().unwrap_or(0), before + 1);
    }

    /// The measured mark reaches Depth Lighting only along a wire straight
    /// from the planted `@depth` port: with the plant marked measured the
    /// key light renders the exact contract, which differs from the model
    /// path on a plane with a cliff in it, and the key knows the mark (a
    /// re-render, not a cache hit). Through an Invert Mask node the mark
    /// is lost: marked or not, the render is the same.
    #[test]
    fn a_measured_depth_plant_marks_only_the_consumer_wired_straight_to_it() {
        let (w, h) = (96, 64);
        let mut plane = ImageBuf::new(w, h);
        for y in 0..h {
            for x in 0..w {
                let v = if x < w / 2 { 0.2 + 0.3 * y as f32 / h as f32 } else { 0.8 };
                plane.set_pixel(x, y, [v, v, v, 1.0]);
            }
        }
        let plane = Arc::new(plane);
        let build = |through_invert: bool| {
            let mut rig = Rig::new();
            rig.source("src", ImageBuf::filled(w, h, [0.3, 0.3, 0.3, 1.0]))
                .node("heeler.depth_map", "dm")
                .node("heeler.key_light", "kl")
                .wire("src", "out", "dm", "in")
                .wire("dm", "out", "kl", "in")
                .set("kl", "strength", 100.0)
                .set("kl", "azimuth", 0.0)
                .set("kl", "elevation", 35.0);
            if through_invert {
                rig.node("heeler.invert_mask", "inv").wire("dm", "depth", "inv", "mask").wire("inv", "out", "kl", "depth");
            } else {
                rig.wire("dm", "depth", "kl", "depth");
            }
            rig
        };
        let render = |rig: &mut Rig, measured: bool, exec: &mut Executor| -> Vec<f32> {
            rig.sources.insert("dm@depth".to_string(), SourceImage { image: plane.clone(), version: 5, measured });
            rig.render(exec, "kl").as_image().unwrap().data.clone()
        };
        let mut direct = build(false);
        let mut exec = Executor::new();
        let model = render(&mut direct, false, &mut exec);
        let exact = render(&mut direct, true, &mut exec);
        assert_ne!(model, exact, "the mark reached the op along the direct wire");
        assert_eq!(exec.stats.executions.get("kl").copied(), Some(2), "the mark is in the key: the marked render is not a cache hit");
        // A fresh executor renders the marked plant the same: the
        // difference is the mark, not the cache.
        assert_eq!(render(&mut direct, true, &mut Executor::new()), exact);
        let mut indirect = build(true);
        let mut exec = Executor::new();
        let a = render(&mut indirect, false, &mut exec);
        let b = render(&mut indirect, true, &mut exec);
        assert_eq!(a, b, "through another node the mark is lost");
    }

    /// The mark is internal: no node in the registry declares a
    /// `depth_measured` param, so it is never in a saved graph, never
    /// a control, and never settable from the desktop.
    #[test]
    fn no_node_declares_the_measured_mark_as_a_param() {
        let registry = Registry::builtin();
        for ty in registry.types() {
            let spec = registry.get(ty).unwrap();
            assert!(spec.params.iter().all(|p| p.name != "depth_measured"), "{ty} declares depth_measured");
        }
    }

    /// Showing the depth map is a view, and a view cannot change what is
    /// selected (2026-09-11, with two screenshots of one dialog: "I turned
    /// on depth map and the selection changed. This doesn't make sense").
    /// The mask comes from the plane on the depth wire whatever the display
    /// shows, which this proves by rendering the photograph and the plane
    /// in turn, then by feeding the displayed plane in as the photograph on
    /// a cold executor.
    #[test]
    fn viewing_depth_does_not_change_a_depth_range_mask() {
        let mut rig = Rig::new();
        let (w, h) = (16, 4);
        let mut photo = ImageBuf::new(w, h);
        let mut plane = ImageBuf::new(w, h);
        let mut view = ImageBuf::new(w, h);
        for y in 0..h {
            for x in 0..w {
                let brightness = if y < h / 2 { 1.0 } else { 0.0 };
                let far = x as f32 / (w - 1) as f32;
                photo.set_pixel(x, y, [brightness, brightness, brightness, 1.0]);
                plane.set_pixel(x, y, [far, far, far, 1.0]);
                view.set_pixel(x, y, [1.0 - far, 1.0 - far, 1.0 - far, 1.0]);
            }
        }
        rig.source("photo", photo)
            .source("depth_view", view)
            .node("heeler.depth_map", "dm")
            .node("heeler.selection_mask", "selection")
            .wire("photo", "out", "dm", "in")
            .wire("photo", "out", "selection", "in")
            .wire("dm", "depth", "selection", "depth");
        rig.graph.set_param("selection", "regions", ParamValue::Text(
            r#"[{"kind":"range","op":"replace","channel":"depth","lo":0.5,"hi":1.0,"soft":0.08}]"#.into(),
        )).unwrap();
        rig.sources.insert("dm@depth".into(), SourceImage { image: Arc::new(plane), version: 7, measured: false });
        let mut exec = Executor::new();
        // View state is a terminal choice outside the recipe. Render
        // each display, then independently ask for the selection mask.
        let _ = rig.render(&mut exec, "photo");
        let off = rig.render(&mut exec, "selection");
        let _ = rig.render(&mut exec, "depth_view");
        let on = rig.render(&mut exec, "selection");
        let a = off.as_mask().unwrap();
        let b = on.as_mask().unwrap();
        assert_eq!((a.width, a.height), (w, h));
        assert_eq!(a.data, b.data);
        assert!(a.value(0, 0) < 0.01);
        assert!(a.value(w - 1, h - 1) > 0.99);
        // Also defeat the cache and replace the photographic feed by
        // the displayed plane: range coverage must still use the wire.
        rig.sources.insert("photo".into(), rig.sources["depth_view"].clone());
        let fresh = rig.render(&mut Executor::new(), "selection");
        assert_eq!(a.data, fresh.as_mask().unwrap().data);
        eprintln!("depth range: wire=dm.depth planted=dm@depth version=7 size={w}x{h} off/on/fresh mask pixels identical");
    }

    /// The depth-range region's plane rides the wire off the Depth
    /// Map's `depth` port (26.3 Phase 10.3; the `{id}@depth` slot it
    /// replaced is gone): wired, the region slices by farness; unwired,
    /// it honestly selects nothing. The regression this guards is a
    /// depth plane that was versioned and cached but never delivered,
    /// so Select by Depth Range rendered empty no matter what depth was
    /// computed.
    #[test]
    fn a_masks_depth_block_weights_the_layer_by_nearness_and_inverts_for_itself() {
        // (2026-09-09): depth as a mask on adjustment and Finish layers, each
        // layer with an Invert of its own. A range mask at its defaults selects
        // everything; its Depth block weights the exposure it gates by nearness
        // on the wired plane, the near edge taking all of it and the far edge
        // none.
        let mut rig = Rig::new();
        let mut main = ImageBuf::new(8, 2);
        for y in 0..2 {
            for x in 0..8 {
                main.set_pixel(x, y, [0.2, 0.2, 0.2, 1.0]);
            }
        }
        rig.source("main", main)
            .node("heeler.depth_map", "dm")
            .node("heeler.range_mask", "m")
            .node("heeler.exposure", "e")
            .wire("main", "out", "dm", "in")
            .wire("main", "out", "m", "in")
            .wire("main", "out", "e", "in")
            .wire("m", "out", "e", "mask")
            .wire("dm", "depth", "m", "depth")
            .set("e", "exposure", 1.0);
        rig.graph.set_param("m", "depth_on", ParamValue::Bool(true)).unwrap();

        // No plane yet: the block is a passthrough and the whole frame
        // doubles, so a layer keeps working while the model computes.
        let mut exec = Executor::new();
        let out = rig.render(&mut exec, "e");
        let img = out.as_image().unwrap();
        assert_close(img.pixel(0, 0)[0], 0.4);
        assert_close(img.pixel(7, 0)[0], 0.4);

        // A near-to-far ramp planted where the desktop plants it: the
        // near edge doubles, the far edge is left alone, and halfway
        // along the frame takes half the boost.
        let mut depth = ImageBuf::new(8, 2);
        for y in 0..2 {
            for x in 0..8 {
                let v = x as f32 / 7.0;
                depth.set_pixel(x, y, [v, v, v, 1.0]);
            }
        }
        rig.sources.insert("dm@depth".to_string(), SourceImage { image: Arc::new(depth), version: 3, measured: false });
        let out = rig.render(&mut exec, "e");
        let img = out.as_image().unwrap();
        assert_close(img.pixel(0, 0)[0], 0.4);
        assert_close(img.pixel(7, 0)[0], 0.2);
        let mid = img.pixel(3, 0)[0];
        assert!(mid > 0.25 && mid < 0.35, "mid {mid}");

        // Invert, for this mask alone: the far edge doubles instead.
        rig.graph.set_param("m", "depth_invert", ParamValue::Bool(true)).unwrap();
        let out = rig.render(&mut exec, "e");
        let img = out.as_image().unwrap();
        assert_close(img.pixel(0, 0)[0], 0.2);
        assert_close(img.pixel(7, 0)[0], 0.4);

        // The Levels handles on the plane: Black at half the nearness
        // leaves the far half untouched and stretches the near half
        // over the whole effect; White at half does the mirror.
        rig.graph.set_param("m", "depth_invert", ParamValue::Bool(false)).unwrap();
        rig.graph.set_param("m", "depth_black", ParamValue::Number(0.5)).unwrap();
        let out = rig.render(&mut exec, "e");
        let img = out.as_image().unwrap();
        assert_close(img.pixel(0, 0)[0], 0.4);
        // x = 7 is far 1.0 (near 0), x = 0 near 1; x = 3 is near 4/7,
        // just past Black: a sliver of the effect.
        let n3 = ((4.0f32 / 7.0 - 0.5) / 0.5).clamp(0.0, 1.0);
        assert_close(img.pixel(3, 0)[0], 0.2 * (1.0 + n3));
        assert_close(img.pixel(7, 0)[0], 0.2);
        rig.graph.set_param("m", "depth_black", ParamValue::Number(0.0)).unwrap();
        rig.graph.set_param("m", "depth_white", ParamValue::Number(0.5)).unwrap();
        let out = rig.render(&mut exec, "e");
        let img = out.as_image().unwrap();
        assert_close(img.pixel(0, 0)[0], 0.4);
        assert_close(img.pixel(3, 0)[0], 0.4);
        assert_close(img.pixel(7, 0)[0], 0.2);
        rig.graph.set_param("m", "depth_white", ParamValue::Number(1.0)).unwrap();

        // The plane's version is in the mask's key: a new plane re-runs
        // the mask, the same one is a cache hit.
        let before = exec.stats.executions.get("m").copied().unwrap_or(0);
        let _ = rig.render(&mut exec, "e");
        assert_eq!(exec.stats.executions.get("m").copied().unwrap_or(0), before);
        rig.sources.get_mut("dm@depth").unwrap().version = 4;
        let _ = rig.render(&mut exec, "e");
        assert_eq!(exec.stats.executions.get("m").copied().unwrap_or(0), before + 1);
    }

    /// A gesture render runs at the half tier under the desktop's
    /// zero-size "preview" job, with the model's answer planted at the
    /// full preview tier; the op fits it, and that fit must be paid
    /// for by the render's own reservation, never refused.
    #[test]
    fn model_denoise_fits_a_raster_of_another_tier_inside_the_render_job() {
        crate::memory::with_budget(64 << 30, || {
            let mut rig = Rig::new();
            rig.source("main", gray(0.2))
                .node("heeler.model_denoise", "md")
                .node("heeler.exposure", "e")
                .wire("main", "out", "md", "in")
                .wire("md", "out", "e", "in")
                .set("md", "luminance", 100.0)
                .set("md", "chroma", 100.0);
            // The planted answer, twice the size of the source.
            let src = gray(0.2);
            let mut big = ImageBuf::new(src.width * 2, src.height * 2);
            for px in big.data.chunks_mut(4) {
                px.copy_from_slice(&[0.5, 0.5, 0.5, 1.0]);
            }
            rig.sources.insert("md".to_string(), SourceImage { image: Arc::new(big), version: 7, measured: false });
            // The desktop's zero-size preview job, admitted around the
            // render the way render_preview does.
            let _outer = crate::memory::Job::admit(0, "preview").unwrap();
            let mut exec = Executor::new();
            let out = crate::memory::catch(|| exec.render(&rig.graph, "e", &rig.sources));
            let out = match out {
                Ok(Ok(v)) => v,
                Ok(Err(e)) => panic!("render error: {e}"),
                Err(e) => panic!("memory refusal: {e}"),
            };
            let img = out.as_image().unwrap();
            assert_eq!((img.width, img.height), (src.width, src.height));
        });
    }

    /// The Finish layer's mask is a brush mask born empty and
    /// inverted (reveal all); an empty uninverted brush with Depth on
    /// reads as reveal-all too. Both come out weighted by nearness.
    #[test]
    fn an_empty_brush_mask_with_depth_on_is_the_nearness_plane() {
        for invert in [true, false] {
            let mut rig = Rig::new();
            rig.source("main", gray(0.2))
                .node("heeler.depth_map", "dm")
                .node("heeler.brush_mask", "m")
                .node("heeler.exposure", "e")
                .wire("main", "out", "dm", "in")
                .wire("main", "out", "m", "in")
                .wire("main", "out", "e", "in")
                .wire("m", "out", "e", "mask")
                .wire("dm", "depth", "m", "depth")
                .set("e", "exposure", 1.0);
            rig.graph.set_param("m", "depth_on", ParamValue::Bool(true)).unwrap();
            rig.graph.set_param("m", "invert", ParamValue::Bool(invert)).unwrap();
            let (w, h) = (gray(0.2).width, gray(0.2).height);
            let mut depth = ImageBuf::new(w, h);
            for y in 0..h {
                for x in 0..w {
                    let v = x as f32 / (w - 1) as f32;
                    depth.set_pixel(x, y, [v, v, v, 1.0]);
                }
            }
            rig.sources.insert("dm@depth".to_string(), SourceImage { image: Arc::new(depth), version: 3, measured: false });
            let mut exec = Executor::new();
            let out = rig.render(&mut exec, "e");
            let img = out.as_image().unwrap();
            assert_close(img.pixel(0, 0)[0], 0.4);
            assert_close(img.pixel(w - 1, 0)[0], 0.2);
        }
    }

    /// The Finish Object mask (26.3): the desktop plants the file's
    /// coverage under the art mask's own id and the Depth block rides
    /// the same node, so one Finish mask multiplies the two, coverage
    /// times nearness. Verified here rather than assumed, since the
    /// feature is two existing behaviors meeting on one node.
    #[test]
    fn a_finish_object_mask_multiplies_coverage_by_nearness() {
        let mut rig = Rig::new();
        let mut main = ImageBuf::new(8, 2);
        for y in 0..2 {
            for x in 0..8 {
                main.set_pixel(x, y, [0.2, 0.2, 0.2, 1.0]);
            }
        }
        rig.source("main", main)
            .node("heeler.depth_map", "dm")
            .node("heeler.matte_mask", "art_m_art_b1")
            .node("heeler.exposure", "e")
            .wire("main", "out", "dm", "in")
            .wire("main", "out", "art_m_art_b1", "in")
            .wire("main", "out", "e", "in")
            .wire("art_m_art_b1", "out", "e", "mask")
            .wire("dm", "depth", "art_m_art_b1", "depth")
            .set("e", "exposure", 1.0);
        rig.graph
            .set_param("art_m_art_b1", "depth_on", ParamValue::Bool(true))
            .unwrap();
        // Half coverage everywhere, planted the way the desktop plants
        // it, under the mask's own id; a near-to-far ramp under the
        // Depth Map's slot.
        rig.sources.insert(
            "art_m_art_b1".to_string(),
            SourceImage { image: Arc::new(ImageBuf::filled(8, 2, [0.5, 0.5, 0.5, 1.0])), version: 7, measured: false },
        );
        let mut depth = ImageBuf::new(8, 2);
        for y in 0..2 {
            for x in 0..8 {
                let v = x as f32 / 7.0;
                depth.set_pixel(x, y, [v, v, v, 1.0]);
            }
        }
        rig.sources.insert("dm@depth".to_string(), SourceImage { image: Arc::new(depth), version: 3, measured: false });
        let mut exec = Executor::new();
        let out = rig.render(&mut exec, "e");
        let img = out.as_image().unwrap();
        // Near: coverage 0.5 at nearness 1 halves the doubling, 0.3
        // rather than 0.4. Far: nearness 0 takes the coverage's say to
        // nothing, 0.2. Either factor alone would miss one of those.
        assert_close(img.pixel(0, 0)[0], 0.3);
        assert_close(img.pixel(7, 0)[0], 0.2);
        // Depth off, same coverage: the half mask weighs the whole frame.
        rig.graph
            .set_param("art_m_art_b1", "depth_on", ParamValue::Bool(false))
            .unwrap();
        let out = rig.render(&mut exec, "e");
        let img = out.as_image().unwrap();
        assert_close(img.pixel(0, 0)[0], 0.3);
        assert_close(img.pixel(7, 0)[0], 0.3);
    }

    #[test]
    fn a_selections_depth_wire_reaches_the_depth_range_region() {
        let mut rig = Rig::new();
        rig.source("src", gray(0.3))
            .node("heeler.depth_map", "dm")
            .node("heeler.selection_mask", "sel")
            .wire("src", "out", "dm", "in")
            .wire("src", "out", "sel", "in")
            .wire("dm", "depth", "sel", "depth");
        // Select the far half by farness.
        rig.graph
            .set_param(
                "sel",
                "regions",
                ParamValue::Text(
                    r#"[{"kind":"range","op":"replace","channel":"depth","lo":0.6,"hi":1.0,"soft":0.01}]"#
                        .into(),
                ),
            )
            .unwrap();

        let mut exec = Executor::new();
        let bare = rig.render(&mut exec, "sel");
        assert!(
            bare.as_mask().unwrap().data.iter().all(|v| *v == 0.0),
            "no depth plane on the wire: the region selects nothing"
        );

        // Plant a near-to-far ramp where the desktop plants it: the far
        // side must light up, and ONLY the far side.
        let mut depth = ImageBuf::new(8, 4);
        for y in 0..4 {
            for x in 0..8 {
                let v = x as f32 / 7.0;
                depth.set_pixel(x, y, [v, v, v, 1.0]);
            }
        }
        rig.sources.insert(
            "dm@depth".to_string(),
            SourceImage { image: Arc::new(depth), version: 3, measured: false },
        );
        let out = rig.render(&mut exec, "sel");
        let m = out.as_mask().unwrap();
        // Assert against the mask's own size (the render tier's), not
        // the planted raster's: the op resamples the plane.
        let mid = m.height / 2;
        assert!(m.data[mid * m.width + (m.width - 1)] > 0.9, "the far edge is selected");
        assert!(m.data[mid * m.width] < 0.1, "the near edge is not");

        // A new depth version re-renders; the same one does not.
        let before = exec.stats.executions.get("sel").copied().unwrap_or(0);
        let _ = rig.render(&mut exec, "sel");
        assert_eq!(exec.stats.executions.get("sel").copied().unwrap_or(0), before);
        rig.sources.get_mut("dm@depth").unwrap().version = 4;
        let _ = rig.render(&mut exec, "sel");
        assert_eq!(exec.stats.executions.get("sel").copied().unwrap_or(0), before + 1);
    }

    /// 26.3 Phase 4: `heeler.depth_map`'s second output `depth` emits
    /// the planted farness plane as a mask value, so an ordinary mask
    /// consumer - Invert here - renders it with no special case.
    #[test]
    fn depth_maps_depth_port_feeds_a_mask_input() {
        let mut rig = Rig::new();
        rig.source("main", gray(0.3))
            .node("heeler.depth_map", "dm")
            .node("heeler.invert_mask", "inv")
            .wire("main", "out", "dm", "in")
            .wire("dm", "depth", "inv", "mask");

        // A near-to-far ramp planted where the desktop plants it. The
        // port answers at the slot's own size: the desktop plants at
        // the render's size and re-refines before export.
        let mut depth = ImageBuf::new(4, 2);
        for y in 0..2 {
            for x in 0..4 {
                let v = x as f32 / 3.0;
                depth.set_pixel(x, y, [v, v, v, 1.0]);
            }
        }
        rig.sources
            .insert("dm@depth".to_string(), SourceImage { image: Arc::new(depth), version: 3, measured: false });

        let mut exec = Executor::new();
        let out = rig.render(&mut exec, "inv");
        let m = out.as_mask().unwrap();
        assert_eq!((m.width, m.height), (4, 2));
        for y in 0..2 {
            for x in 0..4 {
                let want = 1.0 - x as f32 / 3.0;
                assert_close(m.data[y * 4 + x], want);
            }
        }
        // The depth wire never renders depth_map itself: its image
        // output is the passthrough, and nobody asked for it.
        assert_eq!(exec.stats.executions.get("dm").copied().unwrap_or(0), 0);
    }

    /// 26.3 Phase 6: `heeler.file`'s second output `mask` emits the
    /// planted page alpha (or named channel) the same way Depth Map's
    /// port emits its plane, so any mask consumer reads a file's
    /// transparency with no special case.
    #[test]
    fn a_file_nodes_mask_port_feeds_a_mask_input() {
        let mut rig = Rig::new();
        rig.node("heeler.file", "f")
            .node("heeler.invert_mask", "inv")
            .wire("f", "mask", "inv", "mask");
        let mut alpha = ImageBuf::new(2, 1);
        alpha.set_pixel(0, 0, [0.25, 0.25, 0.25, 1.0]);
        alpha.set_pixel(1, 0, [0.75, 0.75, 0.75, 1.0]);
        rig.sources
            .insert("f@mask".to_string(), SourceImage { image: Arc::new(alpha), version: 9, measured: false });
        let mut exec = Executor::new();
        let out = rig.render(&mut exec, "inv");
        let m = out.as_mask().unwrap();
        assert_eq!((m.width, m.height), (2, 1));
        assert_close(m.data[0], 0.75);
        assert_close(m.data[1], 0.25);
        // Unplanted, the same wire reads empty, the passthrough rule.
        rig.sources.remove("f@mask");
        let mut exec = Executor::new();
        let out = rig.render(&mut exec, "inv");
        assert_eq!(out.as_mask().unwrap().width, 0);
    }

    /// 26.3 Phase 8: the Export Layer is a tap, not an adjustment.
    /// Dropped onto a wire it passes the picture through unchanged, and
    /// a reader off its `image` output gets the node's own render, not
    /// the planted-slot answer other non-"out" ports give.
    #[test]
    fn an_export_layer_dropped_on_a_wire_passes_the_image_through_unchanged() {
        let mut src = ImageBuf::new(2, 1);
        src.set_pixel(0, 0, [0.2, 0.4, 0.6, 0.8]);
        src.set_pixel(1, 0, [0.9, 0.1, 0.3, 1.0]);
        let mut rig = Rig::new();
        rig.source("src", src)
            .node("heeler.export_layer", "el")
            .node("heeler.invert", "inv")
            .wire("src", "out", "el", "image")
            .wire("el", "image", "inv", "in");
        let mut exec = Executor::new();
        // The tap itself renders the source untouched.
        let tap = rig.render(&mut exec, "el");
        let img = tap.as_image().unwrap();
        assert_eq!(img.pixel(0, 0), [0.2, 0.4, 0.6, 0.8]);
        assert_eq!(img.pixel(1, 0), [0.9, 0.1, 0.3, 1.0]);
        // Downstream of the tap the picture is the same render.
        let out = rig.render(&mut exec, "inv");
        let img = out.as_image().unwrap();
        assert_close(img.pixel(0, 0)[0], 0.8);
        assert_close(img.pixel(1, 0)[0], 0.1);
    }

    /// The mask pair passes a mask through the same way: a planted mask
    /// in, the same mask out, so a selection tapped for export stays a
    /// mask downstream.
    #[test]
    fn an_export_layer_passes_a_mask_through_unchanged() {
        let mut rig = Rig::new();
        rig.node("heeler.file", "f")
            .node("heeler.export_layer", "el")
            .node("heeler.invert_mask", "inv")
            .wire("f", "mask", "el", "mask")
            .wire("el", "mask", "inv", "mask");
        let mut alpha = ImageBuf::new(2, 1);
        alpha.set_pixel(0, 0, [0.25, 0.25, 0.25, 1.0]);
        alpha.set_pixel(1, 0, [0.75, 0.75, 0.75, 1.0]);
        rig.sources
            .insert("f@mask".to_string(), SourceImage { image: Arc::new(alpha), version: 9, measured: false });
        let mut exec = Executor::new();
        let tap = rig.render(&mut exec, "el");
        let m = tap.as_mask().unwrap();
        assert_eq!((m.width, m.height), (2, 1));
        assert_close(m.data[0], 0.25);
        assert_close(m.data[1], 0.75);
        let out = rig.render(&mut exec, "inv");
        let m = out.as_mask().unwrap();
        assert_close(m.data[0], 0.75);
        assert_close(m.data[1], 0.25);
    }

    /// No plane planted yet: the port reads as an empty mask, the
    /// passthrough rule every depth reader follows, so a graph wired
    /// for depth keeps rendering while the model computes.
    #[test]
    fn an_unplanted_depth_port_reads_as_an_empty_mask() {
        let mut rig = Rig::new();
        rig.source("main", gray(0.3))
            .node("heeler.depth_map", "dm")
            .node("heeler.invert_mask", "inv")
            .wire("main", "out", "dm", "in")
            .wire("dm", "depth", "inv", "mask");
        let mut exec = Executor::new();
        let out = rig.render(&mut exec, "inv");
        let m = out.as_mask().unwrap();
        assert_eq!((m.width, m.height), (0, 0));
    }

    /// The planted plane's version is the wire's key: a re-refined
    /// plane (Edges/Flatten/clips moved) re-runs the consumer, the
    /// same plane is a cache hit.
    #[test]
    fn a_depth_port_wire_renders_again_when_the_plane_changes() {
        let mut rig = Rig::new();
        rig.source("main", gray(0.3))
            .node("heeler.depth_map", "dm")
            .node("heeler.invert_mask", "inv")
            .wire("main", "out", "dm", "in")
            .wire("dm", "depth", "inv", "mask");
        rig.sources
            .insert("dm@depth".to_string(), SourceImage { image: Arc::new(gray(0.25)), version: 3, measured: false });
        let mut exec = Executor::new();
        let out = rig.render(&mut exec, "inv");
        assert_close(out.as_mask().unwrap().data[0], 0.75);

        let before = exec.stats.executions.get("inv").copied().unwrap_or(0);
        let _ = rig.render(&mut exec, "inv");
        assert_eq!(exec.stats.executions.get("inv").copied().unwrap_or(0), before);
        rig.sources.get_mut("dm@depth").unwrap().version = 4;
        let _ = rig.render(&mut exec, "inv");
        assert_eq!(exec.stats.executions.get("inv").copied().unwrap_or(0), before + 1);
    }

    /// 26.3 Phase 10.3: the plane every comparison here drinks, a
    /// near-to-far ramp so where the plane lands shows in the pixels.
    fn depth_ramp(w: usize, h: usize) -> ImageBuf {
        let mut depth = ImageBuf::new(w, h);
        for y in 0..h {
            for x in 0..w {
                let v = x as f32 / (w - 1) as f32;
                depth.set_pixel(x, y, [v, v, v, 1.0]);
            }
        }
        depth
    }

    /// A non-uniform frame, so an op that did nothing stands out.
    fn depth_test_frame(w: usize, h: usize) -> ImageBuf {
        let mut img = ImageBuf::new(w, h);
        for y in 0..h {
            for x in 0..w {
                let v = 0.2 + 0.6 * (x + y) as f32 / (w + h - 2) as f32;
                img.set_pixel(x, y, [v, 0.5 - v * 0.4, v, 1.0]);
            }
        }
        img
    }

    fn assert_same_value(a: &Value, b: &Value, what: &str) {
        match (a, b) {
            (Value::Image(x), Value::Image(y)) => {
                assert_eq!((x.width, x.height), (y.width, y.height), "{what}: size");
                for (i, (p, q)) in x.data.iter().zip(y.data.iter()).enumerate() {
                    assert!((p - q).abs() < EPS, "{what}: pixel {i}: {p} != {q}");
                }
            }
            (Value::Mask(x), Value::Mask(y)) => {
                assert_eq!((x.width, x.height), (y.width, y.height), "{what}: size");
                for (i, (p, q)) in x.data.iter().zip(y.data.iter()).enumerate() {
                    assert!((p - q).abs() < EPS, "{what}: mask pixel {i}: {p} != {q}");
                }
            }
            _ => panic!("{what}: one side an image, the other a mask"),
        }
    }

    /// One consumer rendered two ways: the plane wired off the Depth
    /// Map's `depth` port, and no plane at all (the flat answer, to
    /// prove the plane landed). While the planted slot existed these
    /// tests also pinned the wire against it pixel for pixel; the slot
    /// is gone now (26.3 Phase 10, slot removal), and the equivalence
    /// it proved is pinned at the op level in ops_depth's
    /// the_depth_input_reads_the_same_plane_the_raster_slot_read.
    fn wired_and_bare(setup: &dyn Fn(&mut Rig, &str), w: usize, h: usize) -> (Value, Value) {
        let mut wired = Rig::new();
        wired.source("src", depth_test_frame(w, h));
        wired.node("heeler.depth_map", "dm");
        setup(&mut wired, "c");
        wired
            .wire("src", "out", "dm", "in")
            .wire("src", "out", "c", "in")
            .wire("dm", "depth", "c", "depth");
        wired
            .sources
            .insert("dm@depth".to_string(), SourceImage { image: Arc::new(depth_ramp(w, h)), version: 3, measured: false });

        let mut bare = Rig::new();
        bare.source("src", depth_test_frame(w, h));
        setup(&mut bare, "c");
        bare.wire("src", "out", "c", "in");

        (
            wired.render(&mut Executor::new(), "c"),
            bare.render(&mut Executor::new(), "c"),
        )
    }

    /// 26.3 Phase 10.3: every picture consumer reads the wired plane,
    /// so the wired render differs from the flat one.
    #[test]
    fn picture_consumers_read_the_wired_plane() {
        let cases: Vec<(&str, Box<dyn Fn(&mut Rig, &str)>)> = vec![
            ("fog", Box::new(|rig, id| {
                rig.node("heeler.fog", id).set(id, "density", 80.0);
            })),
            ("key_light", Box::new(|rig, id| {
                // A point lamp, not the legacy directional: the
                // directional is anchored so flat ground keeps its
                // exposure, and a straight ramp IS flat ground to it.
                // The lamp's depth falloff moves along the ramp.
                rig.node("heeler.key_light", id);
                rig.graph
                    .set_param(id, "lights", ParamValue::Text(r#"[{"kind":"point","px":0.45,"py":0.5,"depth":40,"range":60,"strength":-120}]"#.to_string()))
                    .unwrap();
            })),
            ("dof", Box::new(|rig, id| {
                rig.node("heeler.dof", id).set(id, "aperture", 60.0);
            })),
            ("flare", Box::new(|rig, id| {
                rig.node("heeler.flare", id);
                rig.graph
                    .set_param(id, "lights", ParamValue::Text(r##"[{"kind":"point","px":0.5,"py":0.5,"depth":40,"on":true,"color":"#ffffff","flare":true,"flare_strength":100}]"##.to_string()))
                    .unwrap();
            })),
            ("halation", Box::new(|rig, id| {
                rig.node("heeler.halation", id)
                    .set(id, "threshold", 10.0)
                    .set(id, "by_depth", 80.0);
            })),
            ("recolor", Box::new(|rig, id| {
                rig.node("heeler.recolor", id);
                // Far pixels lose two stops; near pixels are untouched.
                rig.graph
                    .set_param(id, "curves", ParamValue::Text(r#"{"depth_lum":[{"x":0,"y":0},{"x":100,"y":-2}]}"#.to_string()))
                    .unwrap();
            })),
        ];
        for (name, setup) in &cases {
            let (wired, bare) = wired_and_bare(setup, 64, 48);
            let flat = bare.as_image().unwrap();
            let by_wire = wired.as_image().unwrap();
            assert_ne!(flat.data, by_wire.data, "{name}: the plane never landed");
        }
    }

    /// The masks' Depth block drinks the plane off the wire: a radial
    /// mask weighted by the ramp is not the unweighted mask.
    #[test]
    fn mask_consumers_read_the_wired_plane() {
        let cases: Vec<(&str, Box<dyn Fn(&mut Rig, &str)>)> = vec![
            ("range_mask", Box::new(|rig, id| {
                rig.node("heeler.range_mask", id).set(id, "depth_on", 1.0);
            })),
            ("hue_range_mask", Box::new(|rig, id| {
                // The widest band: the frame's chroma selects
                // everywhere, so the Depth block has something to weigh.
                rig.node("heeler.hue_range_mask", id)
                    .set(id, "depth_on", 1.0)
                    .set(id, "hue_range", 180.0)
                    .set(id, "hue_falloff", 120.0);
            })),
            ("radial_mask", Box::new(|rig, id| {
                rig.node("heeler.radial_mask", id).set(id, "depth_on", 1.0);
            })),
            ("linear_mask", Box::new(|rig, id| {
                rig.node("heeler.linear_mask", id).set(id, "depth_on", 1.0);
            })),
            ("brush_mask", Box::new(|rig, id| {
                rig.node("heeler.brush_mask", id).set(id, "depth_on", 1.0);
                rig.graph
                    .set_param(id, "strokes", ParamValue::Text(r#"[{"points":[[0.5,0.5]],"radius":0.9,"hardness":0.5,"flow":1.0,"blur_strength":0.4}]"#.to_string()))
                    .unwrap();
            })),
            ("smart_mask", Box::new(|rig, id| {
                rig.node("heeler.smart_mask", id).set(id, "depth_on", 1.0);
                // No clicks means no matte and nothing for depth to
                // weigh, so the model's answer stands in planted.
                rig.sources.insert(id.to_string(), SourceImage { image: Arc::new(ImageBuf::filled(4, 2, [1.0, 1.0, 1.0, 1.0])), version: 9, measured: false });
            })),
            ("matte_mask", Box::new(|rig, id| {
                rig.node("heeler.matte_mask", id).set(id, "depth_on", 1.0);
                rig.sources.insert(id.to_string(), SourceImage { image: Arc::new(ImageBuf::filled(4, 2, [1.0, 1.0, 1.0, 1.0])), version: 9, measured: false });
            })),
        ];
        for (name, setup) in &cases {
            let (wired, bare) = wired_and_bare(setup, 4, 2);
            assert_ne!(
                wired.as_mask().unwrap().data,
                bare.as_mask().unwrap().data,
                "{name}: the plane never landed"
            );
        }
    }

    /// A selection's depth-range region reads the wire.
    #[test]
    fn a_selections_depth_region_reads_the_wire() {
        let region = r#"[{"kind":"range","op":"replace","channel":"depth","lo":0.6,"hi":1.0,"soft":0.01}]"#;
        let setup = |rig: &mut Rig, id: &str| {
            rig.node("heeler.selection_mask", id);
            rig.graph.set_param(id, "regions", ParamValue::Text(region.to_string())).unwrap();
        };
        let (wired, bare) = wired_and_bare(&setup, 4, 2);
        // lo 0.6 keeps only the far end of the ramp: the plane landed.
        assert_ne!(wired.as_mask().unwrap().data, bare.as_mask().unwrap().data, "selection: the plane never landed");
    }

    /// No Depth Map, no planted plane: every consumer renders as if the
    /// plane were flat, and a wire whose plane was never planted (the
    /// model still computing) reads the same way.
    #[test]
    fn without_a_plane_every_depth_consumer_renders_flat() {
        // A hot Fog with nothing planted passes the picture through.
        let mut rig = Rig::new();
        rig.source("src", depth_test_frame(4, 2))
            .node("heeler.fog", "f")
            .wire("src", "out", "f", "in");
        rig.set("f", "density", 80.0);
        let out = rig.render(&mut Executor::new(), "f");
        assert_eq!(out.as_image().unwrap().data, depth_test_frame(4, 2).data);

        // The same Fog wired to a Depth Map whose plane never landed:
        // the empty mask on the wire is no plane, the same flat answer.
        let mut wired = Rig::new();
        wired
            .source("src", depth_test_frame(4, 2))
            .node("heeler.depth_map", "dm")
            .node("heeler.fog", "f")
            .wire("src", "out", "dm", "in")
            .wire("src", "out", "f", "in")
            .wire("dm", "depth", "f", "depth");
        wired.set("f", "density", 80.0);
        let out = wired.render(&mut Executor::new(), "f");
        assert_eq!(out.as_image().unwrap().data, depth_test_frame(4, 2).data);

        // A mask's Depth block with no plane leaves the mask it had.
        let base = |on: f64| {
            let mut rig = Rig::new();
            rig.source("src", depth_test_frame(4, 2))
                .node("heeler.radial_mask", "m")
                .wire("src", "out", "m", "in");
            rig.set("m", "depth_on", on);
            rig.render(&mut Executor::new(), "m")
        };
        assert_same_value(&base(1.0), &base(0.0), "radial mask with no plane");
    }
}
