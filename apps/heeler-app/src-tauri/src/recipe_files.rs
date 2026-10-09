//! Recipe files: a person's node recipes as YAML files they can read,
//! edit by hand, share and keep.
//!
//! 2026-10-01: "As for YAML, I see there are crates for YAML can't you
//! use those? I am thinking ease of manual editing which YAML is far
//! better at than JSON." Earlier the same day he asked how custom
//! recipes are stored, exported and imported, and wanted "a common
//! clean format".
//!
//! Files live in `<app data>/recipes/<Category>/<Name>.heelerrecipe`,
//! beside `presets`. This side owns the YAML: parsing (strict, every
//! error with its line), writing (with a header comment pointing at the
//! guide), and the file work (list, save, rename, Remove into
//! `recipes/.trash`, import, export). The frontend receives the parsed
//! document as JSON in the same shape as the file (recipefiles.ts turns
//! it into a group) plus a table of lines, so the checks only the
//! frontend can make (does this Heeler know the node type, does the
//! node have that port) still name a line. It never needs a YAML
//! library of its own.
//!
//! The parser is saphyr's event parser (YAML 1.2: `no`, `on` and `yes`
//! are strings; the YAML 1.1 "Norway problem" cannot happen) with
//! saphyr's core-schema scalar resolution. The tree is built here, not
//! by saphyr's loader, so that a duplicate key is an error rather than
//! a silent overwrite, and so anchors, aliases and tags are refused
//! outright: an alias expands by copying, and a few lines of aliases
//! can ask for gigabytes. A file is at most 1 MB and 500 nodes. Nothing
//! in a recipe is ever executed; it is data.
//!
//! No code here deletes a file: Remove is a rename into `.trash`.

use std::borrow::Cow;
use std::collections::{BTreeMap, BTreeSet};
use std::fs::{File, OpenOptions};
use std::io::Write as _;
use std::path::{Path, PathBuf};

use saphyr::Scalar;
use saphyr_parser::{Event, Parser, ScalarStyle};
use serde_json::{json, Map, Value};

pub const RECIPE_EXT: &str = "heelerrecipe";
pub const RECIPE_VERSION: i64 = 1;
pub const MAX_BYTES: usize = 1024 * 1024;
pub const MAX_NODES: usize = 500;
const MAX_WIRES: usize = 5000;
const MAX_CONTROLS: usize = 200;
const MAX_DEPTH: usize = 24;
const MAX_TEXT: usize = 4096;

/// What the header of every written file says. Comments do not survive
/// Heeler writing the file again (a rename, a save over it), and the
/// header says so where a hand editor will read it.
pub const HEADER: &str = "\
# Heeler node recipe. Edit it in any text editor; Heeler reads it again
# when the node palette opens. Every field is explained in the user
# guide: Graph > Node recipes > Recipe files.
# Heeler keeps your comments when it imports this file, but not when it
# writes the file itself (Rename, Save as Recipe), so keep notes in
# `description:` or a node's `note:`.
";

/// A file that cannot be read as a recipe, and where.
#[derive(Debug, Clone, PartialEq)]
pub struct RecipeError {
    /// 1-based; 0 when the problem is the file as a whole.
    pub line: usize,
    pub message: String,
}

impl std::fmt::Display for RecipeError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        if self.line == 0 {
            write!(f, "{}", self.message)
        } else {
            write!(f, "line {}: {}", self.line, self.message)
        }
    }
}

fn err<T>(line: usize, message: impl Into<String>) -> Result<T, RecipeError> {
    Err(RecipeError { line, message: message.into() })
}

// --- The tree ----------------------------------------------------------

#[derive(Debug)]
enum Val {
    Null,
    Bool(bool),
    Num(f64),
    Str(String),
    Seq(Vec<Node>),
    /// Keys in file order with their lines.
    Map(Vec<(String, usize, Node)>),
}

#[derive(Debug)]
struct Node {
    line: usize,
    v: Val,
}

impl Node {
    fn kind(&self) -> &'static str {
        match self.v {
            Val::Null => "nothing",
            Val::Bool(_) => "true or false",
            Val::Num(_) => "a number",
            Val::Str(_) => "text",
            Val::Seq(_) => "a list",
            Val::Map(_) => "a set of fields",
        }
    }
}

enum Frame {
    Seq(usize, Vec<Node>),
    /// Line, items in file order, a key awaiting its value, and the keys
    /// seen so far: a duplicate is an error, and looking one up must not
    /// cost a walk of what came before (a 1 MB file holds tens of
    /// thousands of short keys, and a walk each makes that seconds).
    Map(usize, Vec<(String, usize, Node)>, Option<(String, usize)>, std::collections::HashSet<String>),
}

/// The text as a tree, every node with its line. Refuses what a recipe
/// never needs and what would make reading it unsafe or ambiguous.
fn tree(text: &str) -> Result<Node, RecipeError> {
    if text.len() > MAX_BYTES {
        return err(0, format!("the file is {} KB; a recipe file may be at most {} KB", text.len() / 1024, MAX_BYTES / 1024));
    }
    let mut parser = Parser::new_from_str(text);
    let mut stack: Vec<Frame> = Vec::new();
    let mut root: Option<Node> = None;
    let mut documents = 0;
    while let Some(next) = parser.next_event() {
        let (event, span) = next.map_err(|e| RecipeError { line: e.marker().line(), message: format!("this is not valid YAML: {}", e.info()) })?;
        let line = span.start.line();
        let value = match event {
            Event::StreamStart | Event::Nothing | Event::DocumentEnd => continue,
            Event::StreamEnd => break,
            Event::DocumentStart(_) => {
                documents += 1;
                if documents > 1 {
                    return err(line, "a recipe file holds one recipe; this is a second document (a line of three dashes starts one)");
                }
                continue;
            }
            Event::Alias(_) => return err(line, "aliases (*name) are not allowed in a recipe file; write the value out"),
            Event::Scalar(text, style, anchor, tag) => {
                if anchor != 0 {
                    return err(line, "anchors (&name) are not allowed in a recipe file");
                }
                if tag.is_some() {
                    return err(line, "tags (!name) are not allowed in a recipe file");
                }
                if text.len() > MAX_TEXT {
                    return err(line, format!("this value is longer than {MAX_TEXT} characters"));
                }
                let v = if style == ScalarStyle::Plain {
                    match Scalar::parse_from_cow(Cow::Borrowed(text.as_ref())) {
                        Scalar::Null => Val::Null,
                        Scalar::Boolean(b) => Val::Bool(b),
                        Scalar::Integer(i) => Val::Num(i as f64),
                        Scalar::FloatingPoint(f) => Val::Num(f.into_inner()),
                        Scalar::String(s) => Val::Str(s.into_owned()),
                    }
                } else {
                    Val::Str(text.into_owned())
                };
                Node { line, v }
            }
            Event::SequenceStart(anchor, tag) | Event::MappingStart(anchor, tag) if anchor != 0 || tag.is_some() => {
                let _ = tag;
                return err(line, "anchors (&name) and tags (!name) are not allowed in a recipe file");
            }
            Event::SequenceStart(..) => {
                if stack.len() >= MAX_DEPTH {
                    return err(line, "the file nests deeper than a recipe ever does");
                }
                stack.push(Frame::Seq(line, Vec::new()));
                continue;
            }
            Event::MappingStart(..) => {
                if stack.len() >= MAX_DEPTH {
                    return err(line, "the file nests deeper than a recipe ever does");
                }
                stack.push(Frame::Map(line, Vec::new(), None, std::collections::HashSet::new()));
                continue;
            }
            Event::SequenceEnd => match stack.pop() {
                Some(Frame::Seq(l, items)) => Node { line: l, v: Val::Seq(items) },
                _ => return err(line, "this is not valid YAML: a list ends where none began"),
            },
            Event::MappingEnd => match stack.pop() {
                Some(Frame::Map(l, items, None, _)) => Node { line: l, v: Val::Map(items) },
                _ => return err(line, "this is not valid YAML: a set of fields ends where none began"),
            },
        };
        // Hand the finished value to its parent.
        match stack.last_mut() {
            None => {
                if root.is_some() {
                    return err(line, "a recipe file holds one recipe");
                }
                root = Some(value);
            }
            Some(Frame::Seq(_, items)) => items.push(value),
            Some(Frame::Map(_, items, pending, seen)) => match pending.take() {
                None => {
                    let key = match value.v {
                        Val::Str(s) => s,
                        Val::Num(n) => fmt_num(n),
                        Val::Bool(b) => b.to_string(),
                        Val::Null => return err(value.line, "a field needs a name before its colon"),
                        _ => return err(value.line, "a field's name must be a plain word, not a list or a set of fields"),
                    };
                    if !seen.insert(key.clone()) {
                        return err(value.line, format!("\"{key}\" appears twice here; each name may appear once"));
                    }
                    *pending = Some((key, value.line));
                }
                Some((key, kl)) => items.push((key, kl, value)),
            },
        }
    }
    root.ok_or(RecipeError { line: 0, message: "the file is empty".into() })
}

// --- Reading: the tree as the frontend's document ----------------------

/// A parsed recipe: the document in the file's own shape, as JSON, and
/// the line of every field, keyed by its path (`nodes.blur.type`,
/// `wires.3.to`), for the checks the frontend makes.
#[derive(Debug, Clone, serde::Serialize)]
pub struct Parsed {
    pub doc: Value,
    pub lines: BTreeMap<String, usize>,
}

struct Reader {
    lines: BTreeMap<String, usize>,
}

fn is_id(s: &str) -> bool {
    let mut c = s.chars();
    matches!(c.next(), Some(ch) if ch.is_ascii_alphabetic() || ch == '_') && c.all(|ch| ch.is_ascii_alphanumeric() || ch == '_')
}

/// "node" or "node.port" / "node.param", the halves checked.
fn split_ref(s: &str, line: usize, what: &str) -> Result<(String, Option<String>), RecipeError> {
    let (node, rest) = match s.split_once('.') {
        Some((n, r)) => (n, Some(r)),
        None => (s, None),
    };
    if !is_id(node) || rest.is_some_and(|r| !is_id(r)) {
        return err(line, format!("{what} \"{s}\" should be a node's name, or a node's name, a dot and {}", if what.contains("control") { "a setting" } else { "a port" }));
    }
    Ok((node.to_string(), rest.map(str::to_string)))
}

impl Reader {
    fn at(&mut self, path: &str, line: usize) {
        self.lines.insert(path.to_string(), line);
    }

    fn fields<'a>(&mut self, n: &'a Node, path: &str, what: &str, allowed: &[&str]) -> Result<&'a [(String, usize, Node)], RecipeError> {
        let Val::Map(items) = &n.v else {
            return err(n.line, format!("{what} should be a set of fields (name: value lines), not {}", n.kind()));
        };
        for (k, kl, _) in items {
            if !allowed.contains(&k.as_str()) {
                return err(*kl, format!("\"{k}\" is not a field of {what}; {what} has {}", list_words(allowed)));
            }
            let p = if path.is_empty() { k.clone() } else { format!("{path}.{k}") };
            self.at(&p, *kl);
        }
        Ok(items)
    }

    fn text(&self, n: &Node, what: &str) -> Result<String, RecipeError> {
        match &n.v {
            Val::Str(s) => Ok(s.clone()),
            // A number where a name is wanted reads as the name (a node
            // called 2, a category called 2026).
            Val::Num(x) => Ok(fmt_num(*x)),
            _ => err(n.line, format!("{what} should be text, not {}", n.kind())),
        }
    }

    fn number(&self, n: &Node, what: &str) -> Result<f64, RecipeError> {
        match n.v {
            Val::Num(x) if x.is_finite() => Ok(x),
            Val::Num(_) => err(n.line, format!("{what} must be a finite number, not infinity or NaN")),
            _ => err(n.line, format!("{what} should be a number, not {}", n.kind())),
        }
    }

    fn pair(&self, n: &Node, what: &str) -> Result<[f64; 2], RecipeError> {
        match &n.v {
            Val::Seq(xs) if xs.len() == 2 => Ok([self.number(&xs[0], what)?, self.number(&xs[1], what)?]),
            _ => err(n.line, format!("{what} should be two numbers in brackets, like [0, 1]")),
        }
    }

    fn list<'a>(&self, n: &'a Node, what: &str) -> Result<&'a [Node], RecipeError> {
        match &n.v {
            Val::Seq(xs) => Ok(xs),
            _ => err(n.line, format!("{what} should be a list, not {}", n.kind())),
        }
    }

    /// Plain data under a node's curve fields: numbers, words, true and
    /// false, nothing, lists and fields, as JSON.
    fn data(&self, n: &Node) -> Result<Value, RecipeError> {
        Ok(match &n.v {
            Val::Null => Value::Null,
            Val::Bool(b) => json!(b),
            Val::Num(x) if x.is_finite() => json!(x),
            Val::Num(_) => return err(n.line, "numbers must be finite, not infinity or NaN"),
            Val::Str(s) => json!(s),
            Val::Seq(xs) => Value::Array(xs.iter().map(|x| self.data(x)).collect::<Result<_, _>>()?),
            Val::Map(items) => Value::Object(items.iter().map(|(k, _, v)| Ok((k.clone(), self.data(v)?))).collect::<Result<_, RecipeError>>()?),
        })
    }
}

fn list_words(words: &[&str]) -> String {
    match words {
        [] => String::new(),
        [one] => one.to_string(),
        [rest @ .., last] => format!("{} and {last}", rest.join(", ")),
    }
}

const TOP: &[&str] = &["heeler_recipe", "name", "description", "category", "keywords", "inputs", "output", "nodes", "wires", "controls"];
const NODE: &[&str] = &["type", "name", "at", "enabled", "note", "tint", "params", "curves", "curve_interp", "curve_tangents", "curve_handles"];
const WIRE: &[&str] = &["from", "to"];
const CONTROL: &[&str] = &["label", "drives", "range", "default", "options", "reads"];
const OPTION: &[&str] = &["label", "set"];
const GROUP_PORTS: &[&str] = &["in", "in2", "in3", "mask", "depth"];

/// Reads a recipe file's text. Strict: an unknown field, a value of the
/// wrong kind, a reference to a node the file does not have, a number
/// that is not finite, each is an error naming its line.
pub fn parse_recipe(text: &str) -> Result<Parsed, RecipeError> {
    let root = tree(text)?;
    let mut r = Reader { lines: BTreeMap::new() };
    let top = r.fields(&root, "", "a recipe", TOP)?;
    let get = |k: &str| top.iter().find(|(key, _, _)| key == k).map(|(_, _, v)| v);
    let mut doc = Map::new();

    // The version first: a newer file says so before anything else.
    let Some(version) = get("heeler_recipe") else {
        return err(root.line, "this is not a Heeler recipe: the first line should be `heeler_recipe: 1`");
    };
    match version.v {
        Val::Num(v) if v == RECIPE_VERSION as f64 => {}
        Val::Num(v) if v > RECIPE_VERSION as f64 && v.fract() == 0.0 => {
            return err(version.line, format!("this recipe is version {}; this version of Heeler reads version {RECIPE_VERSION}. A newer Heeler made it", fmt_num(v)));
        }
        _ => return err(version.line, format!("heeler_recipe should be {RECIPE_VERSION}")),
    }
    doc.insert("heeler_recipe".into(), json!(RECIPE_VERSION));

    let name = get("name").ok_or(RecipeError { line: root.line, message: "the recipe needs a name: add a `name:` line".into() })?;
    let name_text = r.text(name, "name")?.trim().to_string();
    if name_text.is_empty() {
        return err(name.line, "the name is empty");
    }
    doc.insert("name".into(), json!(name_text));
    for k in ["description", "category", "keywords"] {
        if let Some(v) = get(k) {
            if !matches!(v.v, Val::Null) {
                doc.insert(k.into(), json!(r.text(v, k)?));
            }
        }
    }

    // Nodes, in file order.
    let nodes_n = get("nodes").ok_or(RecipeError { line: root.line, message: "the recipe needs `nodes:`, the nodes inside the group".into() })?;
    let Val::Map(node_items) = &nodes_n.v else {
        return err(nodes_n.line, "nodes should list each node by a short name, then its fields");
    };
    if node_items.is_empty() {
        return err(nodes_n.line, "the recipe has no nodes");
    }
    if node_items.len() > MAX_NODES {
        return err(nodes_n.line, format!("the recipe has {} nodes; a recipe may have at most {MAX_NODES}", node_items.len()));
    }
    let mut ids: BTreeSet<String> = BTreeSet::new();
    let mut nodes = Vec::new();
    for (id, kl, n) in node_items {
        if !is_id(id) {
            return err(*kl, format!("\"{id}\" cannot name a node: use letters, digits and underscores, starting with a letter"));
        }
        ids.insert(id.clone());
        let path = format!("nodes.{id}");
        r.at(&path, *kl);
        let what = format!("node \"{id}\"");
        let f = r.fields(n, &path, &what, NODE)?;
        let mut out = Map::new();
        out.insert("id".into(), json!(id));
        let field = |k: &str| f.iter().find(|(key, _, _)| key == k).map(|(_, _, v)| v);
        let ty = field("type").ok_or(RecipeError { line: *kl, message: format!("{what} needs a `type:`, such as heeler.blur") })?;
        out.insert("type".into(), json!(r.text(ty, "type")?));
        for k in ["name", "note", "tint", "curve_interp"] {
            if let Some(v) = field(k) {
                out.insert(k.into(), json!(r.text(v, k)?));
            }
        }
        if let Some(v) = field("at") {
            out.insert("at".into(), json!(r.pair(v, "at")?));
        }
        if let Some(v) = field("enabled") {
            match v.v {
                Val::Bool(b) => out.insert("enabled".into(), json!(b)),
                _ => return err(v.line, "enabled should be true or false"),
            };
        }
        if let Some(p) = field("params") {
            let Val::Map(items) = &p.v else {
                return err(p.line, "params should list each setting by name, then its value");
            };
            let mut params = Map::new();
            for (k, pl, v) in items {
                if !is_id(k) {
                    return err(*pl, format!("\"{k}\" cannot name a setting"));
                }
                r.at(&format!("{path}.params.{k}"), *pl);
                let value = match &v.v {
                    Val::Num(_) => json!(r.number(v, k)?),
                    Val::Str(s) => json!(s),
                    Val::Bool(b) => json!(b),
                    _ => return err(v.line, format!("{k} should be a number, a word, or true or false, not {}", v.kind())),
                };
                params.insert(k.clone(), value);
            }
            out.insert("params".into(), Value::Object(params));
        }
        for k in ["curves", "curve_tangents", "curve_handles"] {
            if let Some(v) = field(k) {
                let data = r.data(v)?;
                if !data.is_object() {
                    return err(v.line, format!("{k} should list each channel by name, then its points"));
                }
                out.insert(k.into(), data);
            }
        }
        nodes.push(Value::Object(out));
    }
    doc.insert("nodes".into(), Value::Array(nodes));

    let known = |node: &str, line: usize, what: &str| -> Result<(), RecipeError> {
        if ids.contains(node) {
            Ok(())
        } else {
            err(line, format!("{what} names node \"{node}\", which this recipe does not have"))
        }
    };

    // The group's inputs: port -> node[.port], or a list of them.
    if let Some(inputs) = get("inputs") {
        let Val::Map(items) = &inputs.v else {
            return err(inputs.line, "inputs should list each of the group's inputs (in, in2, in3, mask, depth) and the node it feeds");
        };
        let mut out = Vec::new();
        for (port, pl, v) in items {
            if !GROUP_PORTS.contains(&port.as_str()) {
                return err(*pl, format!("\"{port}\" is not one of a group's inputs; a group has {}", list_words(GROUP_PORTS)));
            }
            let targets: Vec<&Node> = match &v.v {
                Val::Seq(xs) => xs.iter().collect(),
                _ => vec![v],
            };
            let mut to = Vec::new();
            for (i, t) in targets.into_iter().enumerate() {
                let s = r.text(t, "an input's node")?;
                let (node, _) = split_ref(&s, t.line, "the input")?;
                known(&node, t.line, &format!("input {port}"))?;
                r.at(&format!("inputs.{port}.{i}"), t.line);
                to.push(json!(s));
            }
            if to.is_empty() {
                return err(v.line, format!("input {port} feeds no node"));
            }
            out.push(json!({ "port": port, "to": to }));
        }
        doc.insert("inputs".into(), Value::Array(out));
    }

    let output = get("output").ok_or(RecipeError { line: root.line, message: "the recipe needs `output:`, the node whose picture leaves the group".into() })?;
    let out_s = r.text(output, "output")?;
    let (out_node, _) = split_ref(&out_s, output.line, "the output")?;
    known(&out_node, output.line, "output")?;
    doc.insert("output".into(), json!(out_s));

    if let Some(wires) = get("wires") {
        let items = r.list(wires, "wires")?;
        if items.len() > MAX_WIRES {
            return err(wires.line, format!("the recipe has {} wires; a recipe may have at most {MAX_WIRES}", items.len()));
        }
        let mut out = Vec::new();
        for (i, w) in items.iter().enumerate() {
            let path = format!("wires.{i}");
            r.at(&path, w.line);
            let f = r.fields(w, &path, "a wire", WIRE)?;
            let mut pair = Map::new();
            for end in ["from", "to"] {
                let (_, el, v) = f.iter().find(|(k, _, _)| k == end).ok_or(RecipeError { line: w.line, message: format!("a wire needs `{end}:`") })?;
                let s = r.text(v, end)?;
                let (node, _) = split_ref(&s, *el, &format!("the wire's {end}"))?;
                known(&node, *el, &format!("the wire's \"{end}\""))?;
                pair.insert(end.into(), json!(s));
            }
            out.push(Value::Object(pair));
        }
        doc.insert("wires".into(), Value::Array(out));
    }

    if let Some(controls) = get("controls") {
        let items = r.list(controls, "controls")?;
        if items.len() > MAX_CONTROLS {
            return err(controls.line, format!("the recipe has {} controls; a recipe may have at most {MAX_CONTROLS}", items.len()));
        }
        let mut labels = BTreeSet::new();
        let mut out = Vec::new();
        for (i, c) in items.iter().enumerate() {
            let path = format!("controls.{i}");
            r.at(&path, c.line);
            let f = r.fields(c, &path, "a control", CONTROL)?;
            let field = |k: &str| f.iter().find(|(key, _, _)| key == k).map(|(_, _, v)| v);
            let label_n = field("label").ok_or(RecipeError { line: c.line, message: "a control needs a `label:`, its name on the group".into() })?;
            let label = r.text(label_n, "label")?.trim().to_string();
            if label.is_empty() {
                return err(label_n.line, "the control's label is empty");
            }
            if !labels.insert(label.clone()) {
                return err(label_n.line, format!("two controls are called {label}; publish the second under its own name, or list both settings under one control's drives"));
            }
            let mut o = Map::new();
            o.insert("label".into(), json!(label));
            let target = |r: &mut Reader, n: &Node, p: String| -> Result<String, RecipeError> {
                let s = r.text(n, "a control's setting")?;
                let (node, param) = split_ref(&s, n.line, "the control's setting")?;
                if param.is_none() {
                    return err(n.line, format!("\"{s}\" names a node; a control drives a setting of it: write {s}.<setting>"));
                }
                known(&node, n.line, &format!("control {label}"))?;
                r.at(&p, n.line);
                Ok(s)
            };
            if let Some(opts) = field("options") {
                for k in ["drives", "range", "default"] {
                    if let Some(v) = field(k) {
                        return err(v.line, format!("{label} is a menu (it has options), so it takes no {k}"));
                    }
                }
                let mut list = Vec::new();
                for (j, opt) in r.list(opts, "options")?.iter().enumerate() {
                    let op = format!("{path}.options.{j}");
                    r.at(&op, opt.line);
                    let of = r.fields(opt, &op, "a menu choice", OPTION)?;
                    let ofield = |k: &str| of.iter().find(|(key, _, _)| key == k).map(|(_, _, v)| v);
                    let ol = ofield("label").ok_or(RecipeError { line: opt.line, message: "a menu choice needs a `label:`".into() })?;
                    let set = ofield("set").ok_or(RecipeError { line: opt.line, message: "a menu choice needs `set:`, the settings it writes".into() })?;
                    let Val::Map(writes) = &set.v else {
                        return err(set.line, "set should list each setting it writes (node.setting: value)");
                    };
                    let mut ws = Vec::new();
                    for (k, kl, v) in writes {
                        let key_node = Node { line: *kl, v: Val::Str(k.clone()) };
                        let t = target(&mut r, &key_node, format!("{op}.set.{k}"))?;
                        let value = match &v.v {
                            Val::Num(_) => json!(r.number(v, k)?),
                            Val::Str(s) => json!(s),
                            Val::Bool(b) => json!(if *b { 1.0 } else { 0.0 }),
                            _ => return err(v.line, format!("{k} should be a number or a word")),
                        };
                        ws.push(json!({ "target": t, "value": value }));
                    }
                    if ws.is_empty() {
                        return err(set.line, "this choice sets nothing");
                    }
                    list.push(json!({ "label": r.text(ol, "label")?, "set": ws }));
                }
                if list.is_empty() {
                    return err(opts.line, format!("{label} has no options"));
                }
                if let Some(v) = field("reads") {
                    let t = target(&mut r, v, format!("{path}.reads"))?;
                    o.insert("reads".into(), json!(t));
                }
                o.insert("options".into(), Value::Array(list));
            } else {
                if let Some(v) = field("reads") {
                    return err(v.line, format!("reads belongs to a menu; {label} is a slider, whose first drives entry is what it reads"));
                }
                let drives = field("drives").ok_or(RecipeError { line: c.line, message: format!("{label} needs `drives:`, the settings it moves (node.setting), or `options:` for a menu") })?;
                let targets: Vec<&Node> = match &drives.v {
                    Val::Seq(xs) => xs.iter().collect(),
                    _ => vec![drives],
                };
                if targets.is_empty() {
                    return err(drives.line, format!("{label} drives nothing"));
                }
                let mut ds = Vec::new();
                for (j, t) in targets.into_iter().enumerate() {
                    ds.push(json!(target(&mut r, t, format!("{path}.drives.{j}"))?));
                }
                o.insert("drives".into(), Value::Array(ds));
                if let Some(v) = field("range") {
                    let [lo, hi] = r.pair(v, "range")?;
                    if lo >= hi {
                        return err(v.line, format!("{label}'s range runs from {} to {}; the first number must be the smaller", fmt_num(lo), fmt_num(hi)));
                    }
                    o.insert("range".into(), json!([lo, hi]));
                }
                if let Some(v) = field("default") {
                    o.insert("default".into(), json!(r.number(v, "default")?));
                }
            }
            out.push(Value::Object(o));
        }
        doc.insert("controls".into(), Value::Array(out));
    }

    Ok(Parsed { doc: Value::Object(doc), lines: r.lines })
}

// --- Writing ------------------------------------------------------------

/// A number as YAML and people write it: 8, 0.05, -3.5.
fn fmt_num(x: f64) -> String {
    if x == x.trunc() && x.abs() < 1e15 {
        format!("{}", x as i64)
    } else {
        format!("{x}")
    }
}

/// Text that reads back as the same text under YAML 1.2, and under the
/// YAML 1.1 rules other tools still use: plain when that is safe,
/// double-quoted (JSON's escaping is valid YAML) when not.
fn yaml_str(s: &str, in_flow: bool) -> String {
    let plain_ok = !s.is_empty()
        && s.trim() == s
        && s.chars().next().is_some_and(|c| c.is_alphabetic() || c == '_')
        && s.chars().all(|c| c.is_alphanumeric() || " _.-()/'+&?".contains(c) || (!in_flow && ",".contains(c)))
        && !s.contains(": ")
        && !s.contains(" #")
        && matches!(Scalar::parse_from_cow(Cow::Borrowed(s)), Scalar::String(_))
        && !["y", "n", "yes", "no", "on", "off"].contains(&s.to_ascii_lowercase().as_str());
    if plain_ok {
        s.to_string()
    } else {
        serde_json::to_string(s).unwrap_or_else(|_| "\"\"".into())
    }
}

/// A scalar or small structure in flow style: [0, 1], [[0, 0], [1, 1]],
/// {l: [0.1, 0], broken: true}.
fn flow(v: &Value) -> String {
    match v {
        Value::Null => "null".into(),
        Value::Bool(b) => b.to_string(),
        Value::Number(n) => fmt_num(n.as_f64().unwrap_or(0.0)),
        Value::String(s) => yaml_str(s, true),
        Value::Array(xs) => format!("[{}]", xs.iter().map(flow).collect::<Vec<_>>().join(", ")),
        Value::Object(m) => format!("{{{}}}", m.iter().map(|(k, v)| format!("{}: {}", yaml_str(k, true), flow(v))).collect::<Vec<_>>().join(", ")),
    }
}

fn s<'a>(v: &'a Value, k: &str) -> Option<&'a str> {
    v.get(k).and_then(Value::as_str)
}

/// The document as a recipe file, header first, fields in the order a
/// person reads them. The inverse of parse_recipe: what it writes reads
/// back as the same document (the tests hold every built-in to that).
pub fn write_recipe(doc: &Value) -> Result<String, String> {
    let mut o = String::from(HEADER);
    o.push_str(&format!("heeler_recipe: {RECIPE_VERSION}\n"));
    let name = s(doc, "name").filter(|n| !n.trim().is_empty()).ok_or("a recipe needs a name")?;
    o.push_str(&format!("name: {}\n", yaml_str(name, false)));
    for k in ["description", "category", "keywords"] {
        if let Some(v) = s(doc, k) {
            o.push_str(&format!("{k}: {}\n", yaml_str(v, false)));
        }
    }
    if let Some(inputs) = doc.get("inputs").and_then(Value::as_array).filter(|a| !a.is_empty()) {
        o.push_str("inputs:\n");
        for i in inputs {
            let to: Vec<&Value> = i.get("to").and_then(Value::as_array).map(|a| a.iter().collect()).unwrap_or_default();
            let shown = if to.len() == 1 { flow(to[0]) } else { flow(&Value::Array(to.into_iter().cloned().collect())) };
            o.push_str(&format!("  {}: {shown}\n", s(i, "port").ok_or("an input needs a port")?));
        }
    }
    o.push_str(&format!("output: {}\n", yaml_str(s(doc, "output").ok_or("a recipe needs an output")?, false)));
    o.push_str("nodes:\n");
    for n in doc.get("nodes").and_then(Value::as_array).ok_or("a recipe needs nodes")? {
        o.push_str(&format!("  {}:\n", s(n, "id").ok_or("a node needs an id")?));
        o.push_str(&format!("    type: {}\n", yaml_str(s(n, "type").ok_or("a node needs a type")?, false)));
        for k in ["name", "note", "tint"] {
            if let Some(v) = s(n, k) {
                o.push_str(&format!("    {k}: {}\n", yaml_str(v, false)));
            }
        }
        if let Some(at) = n.get("at") {
            o.push_str(&format!("    at: {}\n", flow(at)));
        }
        if let Some(e) = n.get("enabled").and_then(Value::as_bool) {
            o.push_str(&format!("    enabled: {e}\n"));
        }
        if let Some(params) = n.get("params").and_then(Value::as_object).filter(|m| !m.is_empty()) {
            o.push_str("    params:\n");
            for (k, v) in params {
                o.push_str(&format!("      {k}: {}\n", flow(v)));
            }
        }
        if let Some(v) = s(n, "curve_interp") {
            o.push_str(&format!("    curve_interp: {}\n", yaml_str(v, false)));
        }
        for k in ["curves", "curve_tangents", "curve_handles"] {
            if let Some(m) = n.get(k).and_then(Value::as_object) {
                o.push_str(&format!("    {k}:\n"));
                for (ch, pts) in m {
                    o.push_str(&format!("      {}: {}\n", yaml_str(ch, false), flow(pts)));
                }
            }
        }
    }
    if let Some(wires) = doc.get("wires").and_then(Value::as_array).filter(|a| !a.is_empty()) {
        o.push_str("wires:\n");
        for w in wires {
            o.push_str(&format!("  - {{ from: {}, to: {} }}\n", yaml_str(s(w, "from").ok_or("a wire needs from")?, true), yaml_str(s(w, "to").ok_or("a wire needs to")?, true)));
        }
    }
    if let Some(controls) = doc.get("controls").and_then(Value::as_array).filter(|a| !a.is_empty()) {
        o.push_str("controls:\n");
        for c in controls {
            o.push_str(&format!("  - label: {}\n", yaml_str(s(c, "label").ok_or("a control needs a label")?, false)));
            if let Some(d) = c.get("drives") {
                o.push_str(&format!("    drives: {}\n", flow(d)));
            }
            if let Some(r) = c.get("range") {
                o.push_str(&format!("    range: {}\n", flow(r)));
            }
            if let Some(d) = c.get("default") {
                o.push_str(&format!("    default: {}\n", flow(d)));
            }
            if let Some(r) = s(c, "reads") {
                o.push_str(&format!("    reads: {}\n", yaml_str(r, false)));
            }
            if let Some(opts) = c.get("options").and_then(Value::as_array) {
                o.push_str("    options:\n");
                for opt in opts {
                    o.push_str(&format!("      - label: {}\n", yaml_str(s(opt, "label").ok_or("a choice needs a label")?, false)));
                    o.push_str("        set:\n");
                    for w in opt.get("set").and_then(Value::as_array).ok_or("a choice needs set")? {
                        o.push_str(&format!("          {}: {}\n", s(w, "target").ok_or("a write needs a target")?, flow(w.get("value").unwrap_or(&Value::Null))));
                    }
                }
            }
        }
    }
    Ok(o)
}

// --- Files ----------------------------------------------------------------

/// One file in the recipes folder, as the palette lists it: the parsed
/// document, or why it could not be read, so a broken file shows as a
/// grayed entry with its message rather than vanishing.
#[derive(Debug, Clone, serde::Serialize)]
pub struct RecipeEntry {
    pub path: String,
    pub category: String,
    /// The file's own name, for an entry whose name could not be read.
    pub file: String,
    pub parsed: Option<Parsed>,
    pub error: Option<String>,
}

pub fn safe_file_name(name: &str) -> String {
    let cleaned: String = name.chars().map(|c| if c.is_alphanumeric() || " -_&()".contains(c) { c } else { '_' }).collect();
    let trimmed = cleaned.trim();
    if trimmed.is_empty() { "Recipe".into() } else { trimmed.to_string() }
}

/// A path the frontend passes must name a file inside the folder. The
/// check is made on resolved paths; the answer is spelled from `base`,
/// as `list_recipes` spells it, so a path handed back (a renamed or
/// removed recipe) is the same string the list holds. Resolved, it was
/// `\\?\C:\...` on Windows against the list's `C:\...` (and on macOS
/// `/private/var/...` against `/var/...`).
fn inside(base: &Path, path: &str) -> Result<PathBuf, String> {
    let canon_base = std::fs::canonicalize(base).map_err(|_| "not a recipe file".to_string())?;
    let p = std::fs::canonicalize(path).map_err(|_| "not a recipe file".to_string())?;
    if p.extension().and_then(|x| x.to_str()) != Some(RECIPE_EXT) {
        return Err("not a recipe file".into());
    }
    let rel = p.strip_prefix(&canon_base).map_err(|_| "not a recipe file".to_string())?;
    Ok(base.join(rel))
}

/// Durable text replacement: a temporary neighbor, synced, renamed over.
fn write_text(path: &Path, text: &str) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let temp = heeler_project::atomic::unique_neighbor(path, "tmp");
    let mut f: File = OpenOptions::new().write(true).create_new(true).open(&temp).map_err(|e| format!("{}: {e}", path.display()))?;
    f.write_all(text.as_bytes()).and_then(|_| f.sync_all()).map_err(|e| format!("{}: {e}", path.display()))?;
    drop(f);
    std::fs::rename(&temp, path).map_err(|e| format!("{}: {e}", path.display()))?;
    #[cfg(unix)]
    if let Some(dir) = path.parent() {
        let _ = File::open(dir).and_then(|d| d.sync_all());
    }
    Ok(())
}

/// `dir/stem.heelerrecipe`, or `stem 2`, `stem 3` when taken.
fn free_name(dir: &Path, stem: &str) -> PathBuf {
    let mut dest = dir.join(format!("{stem}.{RECIPE_EXT}"));
    let mut k = 2;
    while dest.exists() {
        dest = dir.join(format!("{stem} {k}.{RECIPE_EXT}"));
        k += 1;
    }
    dest
}

fn read_capped(p: &Path) -> Result<String, String> {
    let len = std::fs::metadata(p).map_err(|e| e.to_string())?.len() as usize;
    if len > MAX_BYTES {
        return Err(format!("the file is {} KB; a recipe file may be at most {} KB", len / 1024, MAX_BYTES / 1024));
    }
    let bytes = std::fs::read(p).map_err(|e| e.to_string())?;
    String::from_utf8(bytes).map_err(|_| "the file is not UTF-8 text".to_string())
}

fn category_dir(base: &Path, category: &str) -> PathBuf {
    let mut dir = base.to_path_buf();
    let parts: Vec<String> = category.split('/').map(str::trim).filter(|p| !p.is_empty() && *p != "." && *p != "..").map(safe_file_name).collect();
    if parts.is_empty() {
        return dir.join("Personal");
    }
    for p in parts {
        dir = dir.join(p);
    }
    dir
}

/// Every recipe file under `base`, folders as categories, `.trash` and
/// other dot folders left out, sorted by category then file name.
pub fn list_recipes(base: &Path) -> Vec<RecipeEntry> {
    let mut out = Vec::new();
    let mut stack = vec![base.to_path_buf()];
    while let Some(dir) = stack.pop() {
        let Ok(entries) = std::fs::read_dir(&dir) else { continue };
        for e in entries.flatten() {
            let p = e.path();
            let name = e.file_name().to_string_lossy().to_string();
            if name.starts_with('.') {
                continue;
            }
            if p.is_dir() {
                stack.push(p);
            } else if p.extension().and_then(|x| x.to_str()) == Some(RECIPE_EXT) {
                let category = p.parent().and_then(|d| d.strip_prefix(base).ok()).map(|r| r.to_string_lossy().replace('\\', "/")).unwrap_or_default();
                let (parsed, error) = match read_capped(&p).map_err(|e| RecipeError { line: 0, message: e }).and_then(|t| parse_recipe(&t)) {
                    Ok(parsed) => (Some(parsed), None),
                    Err(e) => (None, Some(e.to_string())),
                };
                out.push(RecipeEntry {
                    path: p.to_string_lossy().to_string(),
                    category,
                    file: p.file_stem().map(|s| s.to_string_lossy().to_string()).unwrap_or_default(),
                    parsed,
                    error,
                });
            }
        }
    }
    out.sort_by(|a, b| a.category.cmp(&b.category).then(a.file.cmp(&b.file)));
    out
}

/// Writes a recipe document into its category's folder under a free
/// file name; the text is checked by reading it back before it lands.
pub fn save_recipe(base: &Path, category: &str, doc: &Value) -> Result<String, String> {
    let text = write_recipe(doc)?;
    parse_recipe(&text).map_err(|e| format!("Heeler wrote a recipe it cannot read back ({e}); nothing was saved"))?;
    let name = s(doc, "name").unwrap_or("Recipe");
    let dest = free_name(&category_dir(base, category), &safe_file_name(name));
    write_text(&dest, &text)?;
    Ok(dest.to_string_lossy().to_string())
}

/// Renames a recipe: the file (to the new name, free in its folder)
/// and the name inside it. A rename, then a write of the new text: no
/// file is removed.
pub fn rename_recipe(base: &Path, path: &str, name: &str) -> Result<String, String> {
    let from = inside(base, path)?;
    let name = name.trim();
    if name.is_empty() {
        return Err("a recipe needs a name".into());
    }
    let mut parsed = parse_recipe(&read_capped(&from)?).map_err(|e| e.to_string())?;
    parsed.doc["name"] = json!(name);
    let text = write_recipe(&parsed.doc)?;
    let dir = from.parent().ok_or("not a recipe file")?;
    let stem = safe_file_name(name);
    let dest = if from.file_stem().map(|s| s.to_string_lossy() == stem.as_str()).unwrap_or(false) { from.clone() } else { free_name(dir, &stem) };
    if dest != from {
        std::fs::rename(&from, &dest).map_err(|e| e.to_string())?;
    }
    write_text(&dest, &text)?;
    Ok(dest.to_string_lossy().to_string())
}

/// Remove: the file moves into `recipes/.trash`, its category folders
/// kept, under a free name. Nothing is deleted.
pub fn trash_recipe(base: &Path, path: &str) -> Result<String, String> {
    let from = inside(base, path)?;
    let rel_dir = from.parent().and_then(|d| d.strip_prefix(base).ok()).map(Path::to_path_buf).unwrap_or_default();
    let dir = base.join(".trash").join(rel_dir);
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let dest = free_name(&dir, &from.file_stem().unwrap_or_default().to_string_lossy());
    std::fs::rename(&from, &dest).map_err(|e| e.to_string())?;
    Ok(dest.to_string_lossy().to_string())
}

#[derive(Debug, Default, serde::Serialize)]
pub struct ImportReport {
    pub imported: Vec<String>,
    /// (file, why): a file that fails lands nowhere.
    pub failed: Vec<(String, String)>,
}

/// Copies each readable recipe file into its category's folder (the
/// file's `category:`, else Personal), as the person wrote it, comments
/// and all.
pub fn import_recipes(base: &Path, files: &[PathBuf]) -> ImportReport {
    let mut report = ImportReport::default();
    for f in files {
        let shown = f.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_else(|| f.to_string_lossy().to_string());
        let result = read_capped(f).and_then(|text| {
            let parsed = parse_recipe(&text).map_err(|e| e.to_string())?;
            let name = s(&parsed.doc, "name").unwrap_or("Recipe").to_string();
            let dest = free_name(&category_dir(base, s(&parsed.doc, "category").unwrap_or("")), &safe_file_name(&name));
            write_text(&dest, &text)?;
            Ok(dest.to_string_lossy().to_string())
        });
        match result {
            Ok(p) => report.imported.push(p),
            Err(e) => report.failed.push((shown, e)),
        }
    }
    report
}

/// Writes a recipe document to a file the person chose.
pub fn export_recipe_to(doc: &Value, dest: &Path) -> Result<(), String> {
    let text = write_recipe(doc)?;
    parse_recipe(&text).map_err(|e| format!("Heeler wrote a recipe it cannot read back ({e}); nothing was exported"))?;
    write_text(dest, &text)
}

// --- Commands ------------------------------------------------------------

fn recipes_base(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    use tauri::Manager;
    app.path().app_data_dir().map(|d| d.join("recipes")).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn recipe_list(app: tauri::AppHandle) -> Result<Vec<RecipeEntry>, String> {
    let base = recipes_base(&app)?;
    tauri::async_runtime::spawn_blocking(move || list_recipes(&base)).await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn recipe_save(app: tauri::AppHandle, category: String, doc: Value) -> Result<String, String> {
    save_recipe(&recipes_base(&app)?, &category, &doc)
}

#[tauri::command]
pub async fn recipe_rename(app: tauri::AppHandle, path: String, name: String) -> Result<String, String> {
    rename_recipe(&recipes_base(&app)?, &path, &name)
}

#[tauri::command]
pub async fn recipe_trash(app: tauri::AppHandle, path: String) -> Result<String, String> {
    trash_recipe(&recipes_base(&app)?, &path)
}

#[tauri::command]
pub async fn recipe_import(app: tauri::AppHandle) -> Result<ImportReport, String> {
    use tauri_plugin_dialog::DialogExt;
    let Some(picked) = app.dialog().file().add_filter("Heeler recipe", &[RECIPE_EXT, "yaml", "yml"]).blocking_pick_files() else {
        return Ok(ImportReport::default());
    };
    let mut report = ImportReport::default();
    let mut paths = Vec::new();
    for f in picked {
        match f.into_path() {
            Ok(p) => paths.push(p),
            Err(e) => report.failed.push(("<file>".into(), e.to_string())),
        }
    }
    let mut rest = import_recipes(&recipes_base(&app)?, &paths);
    report.imported.append(&mut rest.imported);
    report.failed.append(&mut rest.failed);
    Ok(report)
}

#[tauri::command]
pub async fn recipe_export(app: tauri::AppHandle, doc: Value, name: String) -> Result<Option<String>, String> {
    use tauri_plugin_dialog::DialogExt;
    let Some(fp) = app
        .dialog()
        .file()
        .set_file_name(format!("{}.{RECIPE_EXT}", safe_file_name(&name)))
        .add_filter("Heeler recipe", &[RECIPE_EXT])
        .blocking_save_file()
    else {
        return Ok(None);
    };
    let dest = fp.into_path().map_err(|e| e.to_string())?;
    export_recipe_to(&doc, &dest)?;
    Ok(Some(dest.to_string_lossy().to_string()))
}

#[cfg(test)]
mod tests;
