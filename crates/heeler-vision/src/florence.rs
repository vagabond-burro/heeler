//! Florence-2 base (Microsoft, MIT): what is in the photograph and
//! where. It captions, lists objects with boxes, and turns a phrase
//! into boxes ("the cheetah's face"). It does not chat; it sees and
//! labels.
//!
//! Four ONNX graphs from onnx-community's packaging, run on the same
//! ONNX Runtime as every other model here, plus the tokenizer:
//!
//! - `vision_encoder`: pixel_values [1, 3, 768, 768] to 577 image
//!   features of 768.
//! - `embed_tokens`: token ids to embeddings of 768.
//! - `encoder_model`: the image features followed by the prompt's
//!   embeddings, through the text encoder.
//! - `decoder_model_merged`: one decoder step with its key/value cache
//!   (the merged export: a first step without a cache, every later
//!   step with it, chosen by `use_cache_branch`).
//!
//! Generation is greedy with Florence-2's own generation rules (the
//! decoder starts from `</s>`, the first token is forced to `<s>`, no
//! three-token sequence repeats), bounded per task, and stoppable
//! between steps. Boxes arrive as `<loc_N>` tokens, a thousand bins per
//! side; they are returned in 0..1 image space.
//!
//! Nothing here reaches the network: the desktop hands in pixels and
//! gets words and boxes back.

use std::collections::HashMap;
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};

use ort::session::{Session, SessionInputValue};
use ort::value::{DynValue, Tensor};

use crate::models::{model_paths, ModelSpec};
use crate::VisionError;

// --- preprocessing -------------------------------------------------------

/// The model's input side (preprocessor_config.json: size 768 by 768,
/// no crop): the photograph is squeezed to a square whatever its shape,
/// which is how Florence-2 was trained, and the boxes come back in the
/// photograph's own proportions because they are fractions of each
/// side.
pub const FLORENCE_SIDE: usize = 768;
/// preprocessor_config.json's image_mean and image_std (ImageNet).
pub const FLORENCE_MEAN: [f32; 3] = [0.485, 0.456, 0.406];
pub const FLORENCE_STD: [f32; 3] = [0.229, 0.224, 0.225];
/// preprocessor_config.json's rescale_factor: 1/255.
pub const FLORENCE_RESCALE: f32 = 1.0 / 255.0;

/// Bicubic weight, a = -0.5: the kernel PIL uses for resample 3
/// (BICUBIC), which is what the config names.
fn bicubic(x: f64) -> f64 {
    const A: f64 = -0.5;
    let x = x.abs();
    if x < 1.0 {
        ((A + 2.0) * x - (A + 3.0)) * x * x + 1.0
    } else if x < 2.0 {
        (((x - 5.0) * x + 8.0) * x - 4.0) * A
    } else {
        0.0
    }
}

/// One axis of PIL's resampling: for each output sample, the first
/// input index and its normalized weights. The kernel widens by the
/// scale when shrinking (PIL's antialiasing), so a 4000 px photograph
/// squeezed to 768 averages what it drops instead of skipping it.
fn axis_weights(input: usize, output: usize) -> Vec<(usize, Vec<f64>)> {
    let scale = input as f64 / output as f64;
    let filter_scale = scale.max(1.0);
    let support = 2.0 * filter_scale;
    (0..output)
        .map(|i| {
            let center = (i as f64 + 0.5) * scale;
            let lo = ((center - support + 0.5).floor().max(0.0)) as usize;
            let hi = ((center + support + 0.5).floor() as usize).min(input);
            let mut w: Vec<f64> = (lo..hi).map(|k| bicubic((k as f64 - center + 0.5) / filter_scale)).collect();
            let sum: f64 = w.iter().sum();
            if sum != 0.0 {
                for v in &mut w {
                    *v /= sum;
                }
            }
            (lo, w)
        })
        .collect()
}

/// PIL's 8-bit BICUBIC resize of an RGB HWC image to (nw, nh):
/// horizontal pass, then vertical, each rounded back to 8 bits as PIL
/// does. Exposed at any size so the tests can check it against PIL's
/// own answers on small images.
pub fn resize_bicubic_rgb8(rgb: &[u8], w: usize, h: usize, nw: usize, nh: usize) -> Vec<u8> {
    assert_eq!(rgb.len(), w * h * 3, "HWC RGB expected");
    let to8 = |v: f64| v.round().clamp(0.0, 255.0) as u8;
    let horizontal = axis_weights(w, nw);
    let mut mid = vec![0u8; nw * h * 3];
    for y in 0..h {
        for (x, (lo, weights)) in horizontal.iter().enumerate() {
            for c in 0..3 {
                let mut acc = 0.0;
                for (k, wt) in weights.iter().enumerate() {
                    acc += rgb[(y * w + lo + k) * 3 + c] as f64 * wt;
                }
                mid[(y * nw + x) * 3 + c] = to8(acc);
            }
        }
    }
    let vertical = axis_weights(h, nh);
    let mut out = vec![0u8; nw * nh * 3];
    for (y, (lo, weights)) in vertical.iter().enumerate() {
        for x in 0..nw {
            for c in 0..3 {
                let mut acc = 0.0;
                for (k, wt) in weights.iter().enumerate() {
                    acc += mid[((lo + k) * nw + x) * 3 + c] as f64 * wt;
                }
                out[(y * nw + x) * 3 + c] = to8(acc);
            }
        }
    }
    out
}

/// The vision encoder's input from an 8-bit RGB HWC photograph (display
/// encoded, as the viewer shows it): resized to 768 square, rescaled to
/// 0..1, normalized by the config's mean and deviation, CHW.
pub fn florence_pixels(rgb: &[u8], w: usize, h: usize) -> Vec<f32> {
    let side = FLORENCE_SIDE;
    let small = resize_bicubic_rgb8(rgb, w, h, side, side);
    let mut chw = vec![0.0f32; 3 * side * side];
    for i in 0..side * side {
        for c in 0..3 {
            chw[c * side * side + i] = (small[i * 3 + c] as f32 * FLORENCE_RESCALE - FLORENCE_MEAN[c]) / FLORENCE_STD[c];
        }
    }
    chw
}

// --- tokenizer -----------------------------------------------------------

/// Florence-2's tokenizer: BART's byte-level BPE (the GPT-2 scheme),
/// read from the model's own tokenizer.json, with its thousand-odd added
/// tokens (`<loc_0>` to `<loc_999>`, `<od>`, and the rest). Written
/// here rather than taken from a crate: it is a few hundred lines, and
/// the tokenizer crates bring a regex engine and a dozen dependencies
/// for the same answer.
pub struct Tokenizer {
    vocab: HashMap<String, u32>,
    id_to_token: HashMap<u32, String>,
    ranks: HashMap<(String, String), u32>,
    /// Added tokens, longest first so `<loc_10>` wins over a shorter
    /// prefix, with their ids.
    added: Vec<(String, u32)>,
    added_ids: HashMap<u32, String>,
    byte_to_char: [char; 256],
    char_to_byte: HashMap<char, u8>,
}

pub const BOS: u32 = 0;
pub const EOS: u32 = 2;

/// GPT-2's reversible map from bytes to printable characters: the
/// printable Latin-1 bytes stand for themselves, the rest are shifted
/// past 255.
fn bytes_to_unicode() -> [char; 256] {
    let mut table = ['\0'; 256];
    let mut n = 0u32;
    for b in 0..=255u32 {
        let printable = (b'!' as u32..=b'~' as u32).contains(&b) || (0xA1..=0xAC).contains(&b) || (0xAE..=0xFF).contains(&b);
        table[b as usize] = if printable {
            char::from_u32(b).unwrap()
        } else {
            n += 1;
            char::from_u32(255 + n).unwrap()
        };
    }
    table
}

/// The GPT-2 pre-tokenizer, by hand (the pattern is
/// `'s|'t|'re|'ve|'m|'ll|'d| ?\p{L}+| ?\p{N}+| ?[^\s\p{L}\p{N}]+|\s+(?!\S)|\s+`):
/// words carry their one leading space, runs of whitespace keep their
/// last space for the word after them.
fn pretokenize(text: &str) -> Vec<&str> {
    let chars: Vec<(usize, char)> = text.char_indices().collect();
    let n = chars.len();
    let at = |i: usize| if i < n { chars[i].0 } else { text.len() };
    let letter = |c: char| c.is_alphabetic();
    let digit = |c: char| c.is_numeric();
    let other = |c: char| !c.is_whitespace() && !c.is_alphabetic() && !c.is_numeric();
    let mut out = Vec::new();
    let mut i = 0;
    while i < n {
        let c = chars[i].1;
        // Contractions.
        if c == '\'' {
            let rest = &text[chars[i].0..];
            if let Some(len) = ["'s", "'t", "'re", "'ve", "'m", "'ll", "'d"].iter().find(|p| rest.starts_with(**p)).map(|p| p.chars().count()) {
                out.push(&text[at(i)..at(i + len)]);
                i += len;
                continue;
            }
        }
        // ` ?` then one class, greedily.
        let start = i;
        let body = if c == ' ' && i + 1 < n { i + 1 } else { i };
        let class: Option<&dyn Fn(char) -> bool> = if letter(chars[body].1) {
            Some(&letter)
        } else if digit(chars[body].1) {
            Some(&digit)
        } else if other(chars[body].1) {
            Some(&other)
        } else {
            None
        };
        if let Some(class) = class {
            let mut j = body;
            while j < n && class(chars[j].1) {
                j += 1;
            }
            out.push(&text[at(start)..at(j)]);
            i = j;
            continue;
        }
        // Whitespace: the run, less its last character when a word
        // follows (`\s+(?!\S)`), else the whole run (`\s+`).
        let mut j = i;
        while j < n && chars[j].1.is_whitespace() {
            j += 1;
        }
        let end = if j < n && j - i > 1 { j - 1 } else { j };
        out.push(&text[at(i)..at(end)]);
        i = end;
    }
    out
}

impl Tokenizer {
    /// Reads a Hugging Face tokenizer.json of the byte-level BPE kind.
    pub fn from_json(text: &str) -> Result<Tokenizer, VisionError> {
        let bad = |what: &str| VisionError::Inference(format!("the tokenizer file is not the one expected ({what})"));
        let json: serde_json::Value = serde_json::from_str(text).map_err(|e| bad(&e.to_string()))?;
        let model = json.get("model").ok_or_else(|| bad("no model"))?;
        if model.get("type").and_then(|t| t.as_str()) != Some("BPE") {
            return Err(bad("not BPE"));
        }
        let vocab: HashMap<String, u32> = model
            .get("vocab")
            .and_then(|v| v.as_object())
            .ok_or_else(|| bad("no vocabulary"))?
            .iter()
            .filter_map(|(k, v)| v.as_u64().map(|id| (k.clone(), id as u32)))
            .collect();
        let mut ranks = HashMap::new();
        for (rank, merge) in model.get("merges").and_then(|m| m.as_array()).ok_or_else(|| bad("no merges"))?.iter().enumerate() {
            let pair = match merge {
                serde_json::Value::String(s) => s.split_once(' ').map(|(a, b)| (a.to_string(), b.to_string())),
                serde_json::Value::Array(a) if a.len() == 2 => {
                    Some((a[0].as_str().unwrap_or_default().to_string(), a[1].as_str().unwrap_or_default().to_string()))
                }
                _ => None,
            };
            let pair = pair.ok_or_else(|| bad("a merge is not a pair"))?;
            ranks.entry(pair).or_insert(rank as u32);
        }
        let mut added: Vec<(String, u32)> = json
            .get("added_tokens")
            .and_then(|a| a.as_array())
            .map(|a| {
                a.iter()
                    .filter_map(|t| Some((t.get("content")?.as_str()?.to_string(), t.get("id")?.as_u64()? as u32)))
                    .collect()
            })
            .unwrap_or_default();
        added.sort_by(|a, b| b.0.len().cmp(&a.0.len()).then(a.1.cmp(&b.1)));
        let added_ids = added.iter().map(|(s, id)| (*id, s.clone())).collect();
        let id_to_token = vocab.iter().map(|(k, v)| (*v, k.clone())).collect();
        let byte_to_char = bytes_to_unicode();
        let char_to_byte = byte_to_char.iter().enumerate().map(|(b, c)| (*c, b as u8)).collect();
        Ok(Tokenizer { vocab, id_to_token, ranks, added, added_ids, byte_to_char, char_to_byte })
    }

    pub fn from_file(path: &Path) -> Result<Tokenizer, VisionError> {
        Tokenizer::from_json(&std::fs::read_to_string(path)?)
    }

    /// The size of the id space: the vocabulary plus the added tokens.
    pub fn id_space(&self) -> usize {
        let top = self.vocab.values().chain(self.added_ids.keys()).copied().max().unwrap_or(0);
        top as usize + 1
    }

    /// BPE over one pre-token's byte-mapped characters.
    fn bpe(&self, word: &str) -> Vec<u32> {
        let mut parts: Vec<String> = word.chars().map(|c| c.to_string()).collect();
        while parts.len() > 1 {
            let best = (0..parts.len() - 1)
                .filter_map(|i| self.ranks.get(&(parts[i].clone(), parts[i + 1].clone())).map(|r| (*r, i)))
                .min();
            let Some((_, i)) = best else { break };
            let merged = format!("{}{}", parts[i], parts[i + 1]);
            parts[i] = merged;
            parts.remove(i + 1);
        }
        // Every single byte-character is in a byte-level vocabulary; a
        // piece that is not (a damaged file) falls back to its bytes'
        // characters one by one, then to <unk>.
        let mut ids = Vec::with_capacity(parts.len());
        for p in parts {
            match self.vocab.get(&p) {
                Some(id) => ids.push(*id),
                None => ids.extend(p.chars().map(|c| self.vocab.get(&c.to_string()).copied().unwrap_or(3))),
            }
        }
        ids
    }

    fn encode_plain(&self, text: &str, ids: &mut Vec<u32>) {
        for piece in pretokenize(text) {
            let mapped: String = piece.bytes().map(|b| self.byte_to_char[b as usize]).collect();
            ids.extend(self.bpe(&mapped));
        }
    }

    /// Text to ids, framed as the model's processor frames it:
    /// `<s>` ... `</s>`. Added tokens written out in the text (`<loc_5>`)
    /// become their own ids, as the reference tokenizer does.
    pub fn encode(&self, text: &str) -> Vec<u32> {
        let mut ids = vec![BOS];
        let mut rest = text;
        while !rest.is_empty() {
            // The earliest added token in what is left, longest first
            // at a tie.
            let found = self
                .added
                .iter()
                .filter_map(|(s, id)| rest.find(s.as_str()).map(|at| (at, std::cmp::Reverse(s.len()), *id, s.len())))
                .min();
            match found {
                Some((at, _, id, len)) => {
                    self.encode_plain(&rest[..at], &mut ids);
                    ids.push(id);
                    rest = &rest[at + len..];
                }
                None => {
                    self.encode_plain(rest, &mut ids);
                    rest = "";
                }
            }
        }
        ids.push(EOS);
        ids
    }

    /// Ids to text, special tokens written out (`<s>`, `<loc_12>`), as
    /// Florence-2's post-processing expects to read them.
    pub fn decode(&self, ids: &[u32]) -> String {
        let mut out = String::new();
        let mut bytes: Vec<u8> = Vec::new();
        let flush = |bytes: &mut Vec<u8>, out: &mut String| {
            out.push_str(&String::from_utf8_lossy(bytes));
            bytes.clear();
        };
        for id in ids {
            if let Some(s) = self.added_ids.get(id) {
                flush(&mut bytes, &mut out);
                out.push_str(s);
            } else if let Some(tok) = self.id_to_token.get(id) {
                bytes.extend(tok.chars().filter_map(|c| self.char_to_byte.get(&c).copied()));
            }
        }
        flush(&mut bytes, &mut out);
        out
    }
}

// --- tasks and answers ---------------------------------------------------

/// What Florence-2 is asked. Each maps to the prompt its processor
/// writes for the task token (preprocessor_config.json's
/// task_prompts_without_inputs and task_prompts_with_input).
#[derive(Clone, Debug, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(tag = "task", rename_all = "snake_case")]
pub enum FlorenceTask {
    /// `<CAPTION>`: one sentence.
    Caption,
    /// `<DETAILED_CAPTION>`: a few sentences.
    DetailedCaption,
    /// `<OD>`: the objects it knows, each with a box.
    Objects,
    /// `<CAPTION_TO_PHRASE_GROUNDING>`: where a phrase is, as boxes.
    Grounding { phrase: String },
}

impl FlorenceTask {
    pub fn token(&self) -> &'static str {
        match self {
            FlorenceTask::Caption => "<CAPTION>",
            FlorenceTask::DetailedCaption => "<DETAILED_CAPTION>",
            FlorenceTask::Objects => "<OD>",
            FlorenceTask::Grounding { .. } => "<CAPTION_TO_PHRASE_GROUNDING>",
        }
    }

    pub fn prompt(&self) -> String {
        match self {
            FlorenceTask::Caption => "What does the image describe?".into(),
            FlorenceTask::DetailedCaption => "Describe in detail what is shown in the image.".into(),
            FlorenceTask::Objects => "Locate the objects with category name in the image.".into(),
            FlorenceTask::Grounding { phrase } => format!("Locate the phrases in the caption: {}", phrase.trim()),
        }
    }

    /// The bound on new tokens: a caption is a sentence, a detailed
    /// caption a short paragraph, an object list five tokens an object.
    pub fn max_new_tokens(&self) -> usize {
        match self {
            FlorenceTask::Caption => 48,
            FlorenceTask::DetailedCaption => 160,
            FlorenceTask::Objects | FlorenceTask::Grounding { .. } => 256,
        }
    }
}

/// A labeled box in 0..1 image space: x0, y0 top left, x1, y1 bottom
/// right, fractions of the photograph's width and height.
#[derive(Clone, Debug, PartialEq, serde::Serialize, serde::Deserialize)]
pub struct FlorenceRegion {
    pub label: String,
    pub x0: f32,
    pub y0: f32,
    pub x1: f32,
    pub y1: f32,
}

#[derive(Clone, Debug, PartialEq, serde::Serialize, serde::Deserialize)]
pub struct FlorenceAnswer {
    /// The task's words: the caption, or for boxes the labels in order.
    pub text: String,
    /// Boxes, for Objects and Grounding; empty for the captions.
    pub regions: Vec<FlorenceRegion>,
    /// Whether generation stopped at the task's bound rather than at
    /// the model's own end.
    pub truncated: bool,
}

/// Florence-2's quantization: a thousand bins per side, a bin's value
/// its middle.
pub const LOC_BINS: u32 = 1000;

fn dequantize(bin: u32) -> f32 {
    (bin.min(LOC_BINS - 1) as f32 + 0.5) / LOC_BINS as f32
}

/// Reads the model's decoded text (special tokens written out) into
/// labeled boxes: each run of text followed by `<loc_N>` tokens, the
/// tokens read four at a time as x0, y0, x1, y1. A phrase grounded in
/// several places carries several boxes, each with the phrase's label;
/// leftover tokens that do not make four are dropped.
pub fn parse_regions(decoded: &str) -> Vec<FlorenceRegion> {
    let clean = strip_specials(decoded);
    let mut regions = Vec::new();
    let mut label = String::new();
    let mut locs: Vec<u32> = Vec::new();
    let mut rest = clean.as_str();
    let close = |label: &mut String, locs: &mut Vec<u32>, regions: &mut Vec<FlorenceRegion>| {
        let name = label.trim().to_string();
        for q in locs.chunks_exact(4) {
            let (mut x0, mut y0, mut x1, mut y1) = (dequantize(q[0]), dequantize(q[1]), dequantize(q[2]), dequantize(q[3]));
            if x1 < x0 {
                std::mem::swap(&mut x0, &mut x1);
            }
            if y1 < y0 {
                std::mem::swap(&mut y0, &mut y1);
            }
            regions.push(FlorenceRegion { label: name.clone(), x0, y0, x1, y1 });
        }
        locs.clear();
        label.clear();
    };
    while !rest.is_empty() {
        if let Some(after) = rest.strip_prefix("<loc_") {
            if let Some(end) = after.find('>') {
                if let Ok(bin) = after[..end].parse::<u32>() {
                    locs.push(bin);
                    rest = &after[end + 1..];
                    continue;
                }
            }
        }
        // Text: a new label begins once boxes have been read.
        if !locs.is_empty() {
            close(&mut label, &mut locs, &mut regions);
        }
        let next = rest[1..].find("<loc_").map(|i| i + 1).unwrap_or(rest.len());
        label.push_str(&rest[..next]);
        rest = &rest[next..];
    }
    if !locs.is_empty() {
        close(&mut label, &mut locs, &mut regions);
    }
    regions
}

/// The decoded text without the tokens that frame it.
fn strip_specials(decoded: &str) -> String {
    decoded.replace("</s>", "").replace("<s>", "").replace("<pad>", "")
}

/// A caption's words: specials gone, whitespace tidied.
pub fn clean_caption(decoded: &str) -> String {
    strip_specials(decoded).split_whitespace().collect::<Vec<_>>().join(" ")
}

// --- generation rules ----------------------------------------------------

/// Tokens that would repeat a three-token sequence already generated
/// (generation_config.json: no_repeat_ngram_size 3).
fn banned_by_ngrams(seq: &[u32], n: usize) -> Vec<u32> {
    if seq.len() + 1 < n {
        return Vec::new();
    }
    let prefix = &seq[seq.len() + 1 - n..];
    seq.windows(n).filter(|w| &w[..n - 1] == prefix).map(|w| w[n - 1]).collect()
}

/// The greedy choice under Florence-2's rules: the first step is forced
/// to `<s>` (forced_bos_token_id), banned n-gram completions are out,
/// and the last step allowed is forced to `</s>` (forced_eos_token_id).
fn next_token(logits: &[f32], generated: &[u32], last_step: bool) -> u32 {
    if generated.len() == 1 {
        return BOS;
    }
    if last_step {
        return EOS;
    }
    let banned = banned_by_ngrams(generated, 3);
    let mut best = (f32::NEG_INFINITY, EOS);
    for (id, v) in logits.iter().enumerate() {
        let id = id as u32;
        if *v > best.0 && !banned.contains(&id) {
            best = (*v, id);
        }
    }
    best.1
}

// --- the model -----------------------------------------------------------

pub struct Florence {
    vision: Session,
    embed: Session,
    encoder: Session,
    decoder: Session,
    tokenizer: Tokenizer,
    /// The decoder's cache inputs, by name, with the head count and
    /// head size read from the graph.
    past_inputs: Vec<String>,
    heads: usize,
    head_dim: usize,
}

/// The image's features, computed once and reusable across tasks: the
/// vision encoder is most of a run's cost.
pub struct FlorenceImage {
    features: Vec<f32>,
    tokens: usize,
    width: usize,
}

fn inference(e: ort::Error) -> VisionError {
    VisionError::Inference(e.to_string())
}

/// Registry file order (models.rs): the four graphs, then the tokenizer.
/// The precisions were chosen by measurement (2026-09-28, the ignored
/// florence_bench over the nine demo photographs): the vision encoder,
/// text encoder and decoder at fp32, the token embedding at int8. That
/// mix answered every task word for word and box for box as all-fp32
/// does, 119 MB lighter; quantizing the vision encoder changed captions
/// on six photographs of nine and was slower on this CPU besides, and
/// the fp16 exports' merged decoder does not load in this ONNX Runtime.
pub const FLORENCE_FILES: [&str; 5] = [
    "vision_encoder.onnx",
    "embed_tokens_int8.onnx",
    "encoder_model.onnx",
    "decoder_model_merged.onnx",
    "tokenizer.json",
];

impl Florence {
    pub fn load(base: &Path, spec: &ModelSpec) -> Result<Florence, VisionError> {
        let paths = model_paths(base, spec);
        if paths.len() != FLORENCE_FILES.len() {
            return Err(VisionError::Inference("the Florence-2 entry does not list its five files".into()));
        }
        Florence::load_files(&paths[0], &paths[1], &paths[2], &paths[3], &paths[4])
    }

    /// The five files by path, for the registry's folder or a bench's.
    pub fn load_files(vision: &Path, embed: &Path, encoder: &Path, decoder: &Path, tokenizer: &Path) -> Result<Florence, VisionError> {
        let open = |p: &Path| -> Result<Session, VisionError> {
            if !p.is_file() {
                return Err(VisionError::NotInstalled(p.display().to_string()));
            }
            Session::builder().map_err(inference)?.commit_from_file(p).map_err(inference)
        };
        let decoder = open(decoder)?;
        let mut past_inputs = Vec::new();
        let (mut heads, mut head_dim) = (12usize, 64usize);
        for input in decoder.inputs() {
            if input.name().starts_with("past_key_values.") {
                past_inputs.push(input.name().to_string());
                if let Some(shape) = input.dtype().tensor_shape() {
                    if shape.len() == 4 {
                        if shape[1] > 0 {
                            heads = shape[1] as usize;
                        }
                        if shape[3] > 0 {
                            head_dim = shape[3] as usize;
                        }
                    }
                }
            }
        }
        Ok(Florence {
            vision: open(vision)?,
            embed: open(embed)?,
            encoder: open(encoder)?,
            decoder,
            tokenizer: Tokenizer::from_file(tokenizer)?,
            past_inputs,
            heads,
            head_dim,
        })
    }

    pub fn tokenizer(&self) -> &Tokenizer {
        &self.tokenizer
    }

    /// Runs the vision encoder on an 8-bit RGB HWC photograph.
    pub fn encode_image(&mut self, rgb: &[u8], w: usize, h: usize) -> Result<FlorenceImage, VisionError> {
        if w == 0 || h == 0 || rgb.len() != w * h * 3 {
            return Err(VisionError::Inference(format!("expected {w}x{h} RGB, got {} bytes", rgb.len())));
        }
        let pixels = florence_pixels(rgb, w, h);
        let input = Tensor::from_array(([1usize, 3, FLORENCE_SIDE, FLORENCE_SIDE], pixels)).map_err(inference)?;
        let outputs = self.vision.run(ort::inputs!["pixel_values" => input]).map_err(inference)?;
        let (shape, data) = outputs[0].try_extract_tensor::<f32>().map_err(inference)?;
        if shape.len() != 3 {
            return Err(VisionError::Inference(format!("the vision encoder answered {shape:?}")));
        }
        Ok(FlorenceImage { features: data.to_vec(), tokens: shape[1] as usize, width: shape[2] as usize })
    }

    fn embed_ids(&mut self, ids: &[u32]) -> Result<(Vec<f32>, usize), VisionError> {
        let ids: Vec<i64> = ids.iter().map(|i| *i as i64).collect();
        let n = ids.len();
        let input = Tensor::from_array(([1usize, n], ids)).map_err(inference)?;
        let outputs = self.embed.run(ort::inputs!["input_ids" => input]).map_err(inference)?;
        let (shape, data) = outputs[0].try_extract_tensor::<f32>().map_err(inference)?;
        Ok((data.to_vec(), shape[2] as usize))
    }

    /// One task on an encoded image. `stop` is read between decoder
    /// steps; a set flag ends the run with an error that says so.
    pub fn run(&mut self, image: &FlorenceImage, task: &FlorenceTask, stop: &AtomicBool) -> Result<FlorenceAnswer, VisionError> {
        let prompt_ids = self.tokenizer.encode(&task.prompt());
        let (text_embeds, width) = self.embed_ids(&prompt_ids)?;
        if width != image.width {
            return Err(VisionError::Inference(format!("image features of {} against text embeddings of {width}", image.width)));
        }
        // The encoder reads the image's features, then the prompt's.
        let seq = image.tokens + prompt_ids.len();
        let mut embeds = Vec::with_capacity(seq * width);
        embeds.extend_from_slice(&image.features);
        embeds.extend_from_slice(&text_embeds);
        let mask = vec![1i64; seq];
        let hidden = {
            let e = Tensor::from_array(([1usize, seq, width], embeds)).map_err(inference)?;
            let m = Tensor::from_array(([1usize, seq], mask.clone())).map_err(inference)?;
            let outputs = self.encoder.run(ort::inputs!["inputs_embeds" => e, "attention_mask" => m]).map_err(inference)?;
            let (_, data) = outputs[0].try_extract_tensor::<f32>().map_err(inference)?;
            data.to_vec()
        };
        let hidden = Tensor::from_array(([1usize, seq, width], hidden)).map_err(inference)?;
        let enc_mask = Tensor::from_array(([1usize, seq], mask)).map_err(inference)?;

        let limit = task.max_new_tokens();
        let mut generated: Vec<u32> = vec![EOS]; // decoder_start_token_id
        let mut past: HashMap<String, DynValue> = HashMap::new();
        let mut truncated = false;
        for step in 0..=limit {
            if stop.load(Ordering::Relaxed) {
                return Err(VisionError::Inference("canceled".into()));
            }
            let last = *generated.last().unwrap();
            let (embed, _) = self.embed_ids(&[last])?;
            let embed = Tensor::from_array(([1usize, 1, width], embed)).map_err(inference)?;
            let first = step == 0;
            let branch = Tensor::from_array(([1usize], vec![!first])).map_err(inference)?;
            let mut inputs: Vec<(std::borrow::Cow<str>, SessionInputValue)> = vec![
                ("inputs_embeds".into(), embed.into()),
                ("encoder_hidden_states".into(), (&hidden).into()),
                ("encoder_attention_mask".into(), (&enc_mask).into()),
                ("use_cache_branch".into(), branch.into()),
            ];
            for name in &self.past_inputs {
                match past.get(name) {
                    Some(v) if !first => inputs.push((name.clone().into(), v.into())),
                    _ => {
                        let empty = Tensor::from_array(([1usize, self.heads, 0, self.head_dim], Vec::<f32>::new())).map_err(inference)?;
                        inputs.push((name.clone().into(), empty.into()));
                    }
                }
            }
            let mut outputs = self.decoder.run(inputs).map_err(inference)?;
            let logits = {
                let (shape, data) = outputs["logits"].try_extract_tensor::<f32>().map_err(inference)?;
                let vocab = shape[shape.len() - 1] as usize;
                data[data.len() - vocab..].to_vec()
            };
            // The self-attention cache moves on every step; the
            // cross-attention cache is the encoder's and is kept from
            // the first step.
            for name in &self.past_inputs {
                let present = name.replacen("past_key_values", "present", 1);
                if first || name.contains(".decoder.") {
                    if let Some(v) = outputs.remove(present.as_str()) {
                        past.insert(name.clone(), v);
                    }
                }
            }
            drop(outputs);
            let token = next_token(&logits, &generated, step == limit);
            generated.push(token);
            if token == EOS {
                break;
            }
            if step == limit {
                truncated = true;
            }
        }
        let decoded = self.tokenizer.decode(&generated[1..]);        Ok(answer_from(task, &decoded, truncated))
    }

    /// Several tasks on one photograph, the image encoded once.
    pub fn describe(&mut self, rgb: &[u8], w: usize, h: usize, tasks: &[FlorenceTask], stop: &AtomicBool) -> Result<Vec<FlorenceAnswer>, VisionError> {
        let image = self.encode_image(rgb, w, h)?;
        tasks.iter().map(|t| self.run(&image, t, stop)).collect()
    }
}

/// The decoded text as the task's answer.
pub fn answer_from(task: &FlorenceTask, decoded: &str, truncated: bool) -> FlorenceAnswer {
    match task {
        FlorenceTask::Caption | FlorenceTask::DetailedCaption => {
            FlorenceAnswer { text: clean_caption(decoded), regions: Vec::new(), truncated }
        }
        FlorenceTask::Objects | FlorenceTask::Grounding { .. } => {
            let regions = parse_regions(decoded);
            let mut labels: Vec<&str> = Vec::new();
            for r in &regions {
                if !labels.contains(&r.label.as_str()) {
                    labels.push(&r.label);
                }
            }
            FlorenceAnswer { text: labels.join(", "), regions, truncated }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The constants match the model's preprocessor_config.json (a copy
    /// of onnx-community's file at the pinned revision sits beside this
    /// module, so the check runs offline).
    #[test]
    fn preprocessing_matches_the_models_config() {
        let config: serde_json::Value = serde_json::from_str(include_str!("florence_preprocessor_config.json")).unwrap();
        assert_eq!(config["size"]["height"], FLORENCE_SIDE);
        assert_eq!(config["size"]["width"], FLORENCE_SIDE);
        assert_eq!(config["do_center_crop"], false);
        assert_eq!(config["do_resize"], true);
        assert_eq!(config["resample"], 3, "BICUBIC");
        let rescale = config["rescale_factor"].as_f64().unwrap() as f32;
        assert!((rescale - FLORENCE_RESCALE).abs() < 1e-9);
        for c in 0..3 {
            assert!((config["image_mean"][c].as_f64().unwrap() as f32 - FLORENCE_MEAN[c]).abs() < 1e-7);
            assert!((config["image_std"][c].as_f64().unwrap() as f32 - FLORENCE_STD[c]).abs() < 1e-7);
        }
        let prompts = &config["task_prompts_without_inputs"];
        for task in [FlorenceTask::Caption, FlorenceTask::DetailedCaption, FlorenceTask::Objects] {
            assert_eq!(prompts[task.token()], task.prompt(), "{}", task.token());
        }
        let grounding = config["task_prompts_with_input"]["<CAPTION_TO_PHRASE_GROUNDING>"].as_str().unwrap();
        let task = FlorenceTask::Grounding { phrase: "a red car".into() };
        assert_eq!(grounding.replace("{input}", "a red car"), task.prompt());
    }

    /// The resize against PIL's own answer: a 7 by 5 gradient image
    /// resized with Image.resize((3, 2), Image.BICUBIC) and
    /// ((11, 8), Image.BICUBIC) in Pillow 12.2, both directions of
    /// scale, the numbers pasted from its output.
    #[test]
    fn the_resize_is_pils_bicubic() {
        let (w, h) = (7usize, 5usize);
        let mut rgb = vec![0u8; w * h * 3];
        for y in 0..h {
            for x in 0..w {
                let i = (y * w + x) * 3;
                rgb[i] = (x * 255 / (w - 1)) as u8;
                rgb[i + 1] = (y * 255 / (h - 1)) as u8;
                rgb[i + 2] = ((x * 37 + y * 91) % 256) as u8;
            }
        }
        let down = resize_bicubic_rgb8(&rgb, w, h, 3, 2);
        assert_eq!(down, PIL_DOWN.to_vec());
        let up = resize_bicubic_rgb8(&rgb, w, h, 11, 8);
        assert_eq!(up, PIL_UP.to_vec());
    }

    #[test]
    fn a_flat_image_normalizes_to_the_configs_numbers() {
        let rgb = vec![255u8; 40 * 30 * 3];
        let chw = florence_pixels(&rgb, 40, 30);
        assert_eq!(chw.len(), 3 * FLORENCE_SIDE * FLORENCE_SIDE);
        for c in 0..3 {
            let v = chw[c * FLORENCE_SIDE * FLORENCE_SIDE + 1234];
            assert!((v - (1.0 - FLORENCE_MEAN[c]) / FLORENCE_STD[c]).abs() < 1e-5, "channel {c}: {v}");
        }
    }

    #[test]
    fn location_tokens_become_boxes_in_image_space() {
        let decoded = "</s><s>car<loc_52><loc_333><loc_932><loc_774>wheel<loc_708><loc_575><loc_813><loc_775><loc_147><loc_563><loc_266><loc_778></s>";
        let regions = parse_regions(decoded);
        assert_eq!(regions.len(), 3);
        assert_eq!(regions[0].label, "car");
        assert!((regions[0].x0 - 0.0525).abs() < 1e-6 && (regions[0].y0 - 0.3335).abs() < 1e-6);
        assert!((regions[0].x1 - 0.9325).abs() < 1e-6 && (regions[0].y1 - 0.7745).abs() < 1e-6);
        // Two boxes for one phrase, both labeled with it.
        assert_eq!(regions[1].label, "wheel");
        assert_eq!(regions[2].label, "wheel");
        assert!((regions[2].x0 - 0.1475).abs() < 1e-6);
        let answer = answer_from(&FlorenceTask::Objects, decoded, false);
        assert_eq!(answer.text, "car, wheel");
    }

    #[test]
    fn the_location_parser_survives_odd_output() {
        // Spaces around a phrase, a swapped box, an out-of-range bin, a
        // dangling partial box, and a label with no box at the end.
        let regions = parse_regions("<s> the cheetah's face <loc_600><loc_400><loc_200><loc_1200><loc_5> tail</s>");
        assert_eq!(regions.len(), 1);
        let r = &regions[0];
        assert_eq!(r.label, "the cheetah's face");
        assert!(r.x0 < r.x1 && r.y0 < r.y1);
        assert!((r.x0 - 0.2005).abs() < 1e-6 && (r.x1 - 0.6005).abs() < 1e-6);
        assert!((r.y1 - 0.9995).abs() < 1e-6, "clamped to the last bin: {}", r.y1);
        assert!(parse_regions("</s><s>no boxes here</s>").is_empty());
        assert!(parse_regions("<loc_x>car").is_empty());
        assert_eq!(clean_caption("</s><s>A  cheetah lying\nin the grass.</s>"), "A cheetah lying in the grass.");
    }

    #[test]
    fn generation_forces_bos_first_then_bans_repeated_trigrams() {
        let mut logits = vec![0.0f32; 10];
        logits[7] = 5.0;
        assert_eq!(next_token(&logits, &[EOS], false), BOS);
        assert_eq!(next_token(&logits, &[EOS, BOS], false), 7);
        assert_eq!(next_token(&logits, &[EOS, BOS, 5, 6], true), EOS);
        // 5 6 7 was generated; after another 5 6, 7 would repeat it.
        logits[8] = 4.0;
        assert_eq!(next_token(&logits, &[EOS, BOS, 5, 6, 7, 5, 6], false), 8);
        assert_eq!(banned_by_ngrams(&[1, 2, 3, 1, 2], 3), vec![3]);
        assert!(banned_by_ngrams(&[1], 3).is_empty());
    }

    /// A small byte-level BPE in the tokenizer.json shape: the
    /// vocabulary holds the characters, three merges, the four specials
    /// and two added tokens.
    fn tiny_tokenizer() -> Tokenizer {
        let mut vocab = serde_json::Map::new();
        let mut next = 0u32;
        for s in ["<s>", "<pad>", "</s>", "<unk>"] {
            vocab.insert(s.into(), next.into());
            next += 1;
        }
        for c in bytes_to_unicode() {
            vocab.insert(c.to_string(), next.into());
            next += 1;
        }
        for s in ["Ġc", "Ġca", "Ġcat"] {
            vocab.insert(s.into(), next.into());
            next += 1;
        }
        let json = serde_json::json!({
            "added_tokens": [
                {"id": 0, "content": "<s>"}, {"id": 1, "content": "<pad>"},
                {"id": 2, "content": "</s>"}, {"id": 3, "content": "<unk>"},
                {"id": next, "content": "<loc_1>"}, {"id": next + 1, "content": "<loc_10>"}
            ],
            "model": { "type": "BPE", "vocab": vocab, "merges": ["Ġ c", "Ġc a", ["Ġca", "t"]] }
        });
        Tokenizer::from_json(&json.to_string()).unwrap()
    }

    #[test]
    fn the_tokenizer_round_trips_text_and_added_tokens() {
        let t = tiny_tokenizer();
        let ids = t.encode("a cat");
        // <s>, a, Ġcat (merged through all three ranks), </s>
        assert_eq!(ids.len(), 4, "{ids:?}");
        assert_eq!(ids[0], BOS);
        assert_eq!(*ids.last().unwrap(), EOS);
        assert_eq!(t.decode(&ids), "<s>a cat</s>");
        // The longer added token wins; text around it is plain BPE.
        let ids = t.encode("x<loc_10>é  ok\n");
        assert!(ids.contains(&(t.id_space() as u32 - 1)), "{ids:?}");
        assert_eq!(t.decode(&ids), "<s>x<loc_10>é  ok\n</s>");
        for text in ["It's 2 o'clock!", "tabs\tand  spaces   end", "日本語 and emoji 🐆", ""] {
            assert_eq!(t.decode(&t.encode(text)), format!("<s>{text}</s>"), "{text:?}");
        }
    }

    #[test]
    fn pretokenizing_follows_the_gpt2_pattern() {
        assert_eq!(pretokenize("What does it's"), vec!["What", " does", " it", "'s"]);
        assert_eq!(pretokenize("a   b"), vec!["a", "  ", " b"]);
        assert_eq!(pretokenize("x: 42?"), vec!["x", ":", " 42", "?"]);
        assert_eq!(pretokenize("end  "), vec!["end", "  "]);
        assert_eq!(pretokenize("a\nb"), vec!["a", "\n", "b"]);
    }

    fn demo_photo(name: &str) -> (Vec<u8>, usize, usize) {
        let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../apps/heeler-app/src/demo-photos").join(name);
        let img = image::open(&path).unwrap().to_rgb8();
        let (w, h) = (img.width() as usize, img.height() as usize);
        (img.into_raw(), w, h)
    }

    /// The real weights from the registry's folder, on a demo
    /// photograph of a big cat: the caption names one, the objects put
    /// a box on it, the real tokenizer frames the caption prompt the
    /// way the reference does, and a raised stop flag ends a run. Run
    /// by hand with the model installed:
    /// `HEELER_VISION_BASE=<folder holding models/> cargo test -p heeler-vision --release -- --ignored real_model --nocapture`.
    #[test]
    #[ignore]
    fn florence_real_model_names_the_cat() {
        let Ok(base) = std::env::var("HEELER_VISION_BASE") else { return };
        let base = Path::new(&base);
        assert!(crate::models::installed(base, &crate::models::FLORENCE_2), "Florence-2 is not installed under {}", base.display());
        let mut model = Florence::load(base, &crate::models::FLORENCE_2).unwrap();
        // "What does the image describe?" as the reference tokenizer
        // has it: <s> What Ġdoes Ġthe Ġimage Ġdescribe ? </s>.
        assert_eq!(model.tokenizer().encode(&FlorenceTask::Caption.prompt()), vec![0, 2264, 473, 5, 2274, 6190, 116, 2]);
        for text in ["the cheetah's face", "Loc <loc_12> ünïcode 🐆  two  spaces", "12:30 p.m."] {
            let t = model.tokenizer();
            assert_eq!(t.decode(&t.encode(text)), format!("<s>{text}</s>"));
        }
        let (rgb, w, h) = demo_photo("demo-09.jpg");
        let stop = AtomicBool::new(false);
        let tasks = [FlorenceTask::Caption, FlorenceTask::Objects];
        let answers = model.describe(&rgb, w, h, &tasks, &stop).unwrap();
        println!("{answers:?}");
        let caption = answers[0].text.to_lowercase();
        assert!(["leopard", "cheetah", "serval", "cat"].iter().any(|w| caption.contains(w)), "{caption}");
        let cat = answers[1].regions.iter().find(|r| ["leopard", "cheetah", "cat", "animal"].iter().any(|w| r.label.contains(w)));
        let cat = cat.unwrap_or_else(|| panic!("no box on the cat: {:?}", answers[1]));
        assert!(cat.x1 - cat.x0 > 0.3 && cat.y1 - cat.y0 > 0.3, "{cat:?}");
        stop.store(true, Ordering::Relaxed);
        let image = model.encode_image(&rgb, w, h).unwrap();
        assert!(model.run(&image, &FlorenceTask::Caption, &stop).is_err(), "a raised stop flag must end the run");
    }

    /// Any precision variant of onnx-community's export, from a folder
    /// holding its onnx/ directory and tokenizer.json, timed on four
    /// demo photographs; how the shipped variant was chosen. Run by
    /// hand, in release:
    /// `FLORENCE_BENCH_DIR=<folder> FLORENCE_VARIANT=_quantized cargo test -p heeler-vision --release -- --ignored florence_bench --nocapture`
    /// (an empty FLORENCE_VARIANT is fp32).
    #[test]
    #[ignore]
    fn florence_bench() {
        let Ok(dir) = std::env::var("FLORENCE_BENCH_DIR") else { return };
        let v = std::env::var("FLORENCE_VARIANT").unwrap_or_default();
        let dir = Path::new(&dir);
        // One suffix for all four graphs, or four separated by commas
        // (vision, embeddings, encoder, decoder) to mix precisions.
        let parts: Vec<&str> = if v.contains(',') { v.split(',').collect() } else { vec![v.as_str(); 4] };
        let onnx = |part: &str, i: usize| dir.join("onnx").join(format!("{part}{}.onnx", parts[i]));
        let t = std::time::Instant::now();
        let mut model = Florence::load_files(
            &onnx("vision_encoder", 0),
            &onnx("embed_tokens", 1),
            &onnx("encoder_model", 2),
            &onnx("decoder_model_merged", 3),
            &dir.join("tokenizer.json"),
        )
        .unwrap();
        println!("variant '{v}': load {:?}", t.elapsed());
        let stop = AtomicBool::new(false);
        let photos = [
            ("demo-09.jpg", "the cheetah's face"),
            ("demo-01.jpg", "the rock tower"),
            ("demo-02.jpg", "the red hill"),
            ("demo-08.jpg", "the person's face"),
            ("demo-03.jpg", "the sky"),
            ("demo-04.jpg", "the sky"),
            ("demo-05.jpg", "the prairie dog"),
            ("demo-06.jpg", "the lightning"),
            ("demo-07.jpg", "the sign"),
        ];
        for (name, phrase) in photos {
            let (rgb, w, h) = demo_photo(name);
            let t = std::time::Instant::now();
            let image = model.encode_image(&rgb, w, h).unwrap();
            println!("{name}: vision encoder {:?}", t.elapsed());
            let tasks = [
                FlorenceTask::Caption,
                FlorenceTask::DetailedCaption,
                FlorenceTask::Objects,
                FlorenceTask::Grounding { phrase: phrase.into() },
            ];
            for task in &tasks {
                let t = std::time::Instant::now();
                let answer = model.run(&image, task, &stop).unwrap();
                let boxes: Vec<String> =
                    answer.regions.iter().map(|r| format!("{} [{:.3} {:.3} {:.3} {:.3}]", r.label, r.x0, r.y0, r.x1, r.y1)).collect();
                let cut = if answer.truncated { " (truncated)" } else { "" };
                println!("  {} {:?}: {:?}{cut} {}", task.token(), t.elapsed(), answer.text, boxes.join("; "));
            }
        }
    }

    const PIL_DOWN: [u8; 18] = [30, 54, 95, 127, 54, 130, 224, 54, 133, 30, 200, 110, 127, 200, 116, 224, 200, 126];
    const PIL_UP: [u8; 264] = [
        0, 0, 0, 15, 0, 6, 46, 0, 33, 73, 0, 57, 100, 0, 80, 127, 0, 104, 154, 0, 127, 181, 0, 156, 208, 0, 193, 239, 0, 222, 255, 0, 237, 0, 22, 30, 15, 22, 44, 46, 22, 72, 73, 22, 105, 100, 22, 132, 127, 22, 155, 154, 22, 187, 181, 22, 176, 208, 22, 119, 239, 22, 133, 255, 22, 155, 0, 67, 94, 15, 67, 111, 46, 67, 137, 73, 67, 153, 100, 67, 174, 127, 67, 198, 154, 67, 240, 181, 67, 188, 208, 67, 30, 239, 67, 29, 255, 67, 59, 0, 107, 169, 15, 107, 197, 46, 107, 201, 73, 107, 78, 100, 107, 44, 127, 107, 78, 154, 107, 108, 181, 107, 108, 208, 107, 75, 239, 107, 94, 255, 107, 114, 0, 147, 138, 15, 147, 165, 46, 147, 170, 73, 147, 46, 100, 147, 12, 127, 147, 47, 154, 147, 75, 181, 147, 107, 208, 147, 144, 239, 147, 173, 255, 147, 188, 0, 187, 18, 15, 187, 34, 46, 187, 60, 73, 187, 77, 100, 187, 97, 127, 187, 122, 154, 187, 151, 181, 187, 176, 208, 187, 200, 239, 187, 227, 255, 187, 243, 0, 233, 61, 15, 233, 76, 46, 233, 104, 73, 233, 138, 100, 233, 171, 127, 233, 188, 154, 233, 108, 181, 233, 74, 208, 233, 103, 239, 233, 131, 255, 233, 147, 0, 255, 112, 15, 255, 128, 46, 255, 155, 73, 255, 179, 100, 255, 213, 127, 255, 226, 154, 255, 66, 181, 255, 0, 208, 255, 21, 239, 255, 49, 255, 255, 65,
    ];
}
