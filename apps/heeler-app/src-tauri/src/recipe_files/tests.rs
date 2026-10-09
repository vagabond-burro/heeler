//! Recipe files (2026-10-01: "As for YAML, I see there are crates for
//! YAML can't you use those? I am thinking ease of manual editing
//! which YAML is far better at than JSON").
//!
//! Held here: every document the frontend writes (the built-ins and a
//! hand-made group, src/__tests__/fixtures/recipe-docs.json) goes to
//! YAML and back unchanged; the guide's hand-written example parses
//! (and is the fixture the frontend builds a group from); every error a
//! hand editor can make names its line; YAML 1.2 keeps `no`, `yes` and
//! `on` words; and the folder work: save, list, rename, Remove into
//! .trash (a rename, never a deletion), import keeping comments,
//! export, and paths that try to leave the folder.
//!
//! After a deliberate change to the guide's example:
//!   GEN_FIXTURE=1 cargo test -p heeler-desktop --lib recipe_files
use super::*;

/// Numbers compared as numbers: the frontend writes 12, the parser
/// reads 12.0, and both are the same setting.
fn norm(v: &Value) -> Value {
    match v {
        Value::Number(n) => json!(n.as_f64().unwrap()),
        Value::Array(xs) => Value::Array(xs.iter().map(norm).collect()),
        Value::Object(m) => Value::Object(m.iter().map(|(k, v)| (k.clone(), norm(v))).collect()),
        other => other.clone(),
    }
}

fn fixture_docs() -> Map<String, Value> {
    serde_json::from_str(include_str!("../../../src/__tests__/fixtures/recipe-docs.json")).unwrap()
}

fn error(text: &str) -> RecipeError {
    parse_recipe(text).expect_err("this file should not read")
}

const MINIMAL: &str = "heeler_recipe: 1\nname: T\noutput: a\nnodes:\n  a:\n    type: heeler.blur\n";

#[test]
fn every_fixture_document_goes_to_yaml_and_back_unchanged() {
    let docs = fixture_docs();
    assert!(docs.len() >= 6, "the frontend's fixture lists the built-ins and a hand-made group");
    for (name, doc) in &docs {
        let text = write_recipe(doc).unwrap();
        assert!(text.starts_with(HEADER), "{name}: the header comes first");
        assert!(text.contains("\nheeler_recipe: 1\n"));
        let back = parse_recipe(&text).unwrap_or_else(|e| panic!("{name}: {e}\n{text}"));
        assert_eq!(norm(&back.doc), norm(doc), "{name} changed on the way through YAML:\n{text}");
        // And writing what was read gives the same text: stable files.
        assert_eq!(write_recipe(&back.doc).unwrap(), text, "{name}");
        // Every node and wire has a line for the frontend's checks.
        for n in doc["nodes"].as_array().unwrap() {
            let id = n["id"].as_str().unwrap();
            assert!(back.lines.contains_key(&format!("nodes.{id}.type")), "{name}: no line for {id}");
        }
    }
    // The hand-made group's tricky words came back as the same words.
    let hand = &docs["hand_made"];
    let text = write_recipe(hand).unwrap();
    assert!(text.contains("name: \"Hand made: no, yes, on\""), "{text}");
    assert!(text.contains("tint: \"#4a8ac6\""), "{text}");
    assert!(text.contains("  - { from: soft.out, to: curves.in }"), "{text}");
    assert!(text.contains("    drives: [high_r.scale, high_g.scale, high_b.scale]") || !text.contains("high_r"));
    let fs = write_recipe(&docs["frequency_separation"]).unwrap();
    assert!(fs.contains("    drives: [high_r.scale, high_g.scale, high_b.scale]\n    range: [0, 2]\n"), "{fs}");
    assert!(fs.contains("  blur:\n    type: heeler.blur\n    name: Low (blur)\n    at: [170, 0]\n    params:\n      kind: gaussian\n      radius: 8\n"), "{fs}");
}

/// The YAML block under "Recipe files" in the user guide.
fn guide_example() -> String {
    let guide = include_str!("../../../../../docs/user-guide/graph/recipes.md");
    let at = guide.find("### The format").expect("the guide has the format section");
    let rest = &guide[at..];
    let start = rest.find("```yaml\n").expect("a yaml block") + "```yaml\n".len();
    let end = rest[start..].find("```").unwrap();
    rest[start..start + end].to_string()
}

#[test]
fn the_guide_example_parses() {
    let text = guide_example();
    let parsed = parse_recipe(&text).unwrap_or_else(|e| panic!("the guide's example: {e}"));
    let doc = &parsed.doc;
    assert_eq!(doc["name"], json!("Soft Glow"));
    assert_eq!(doc["nodes"].as_array().unwrap().len(), 3);
    assert_eq!(doc["controls"][2]["options"][1], json!({ "label": "Soft Light", "set": [{ "target": "glow.mode", "value": "soft_light" }] }));
    let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("../src/__tests__/fixtures/recipe-guide-example.json");
    let fresh = serde_json::to_string_pretty(&parsed).unwrap() + "\n";
    if std::env::var("GEN_FIXTURE").is_ok() {
        std::fs::write(&path, &fresh).unwrap();
    }
    let have: Value = serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
    assert_eq!(have, serde_json::to_value(&parsed).unwrap(), "the guide's example changed: regenerate with GEN_FIXTURE=1");
    // Its comments are a hand editor's: writing it again keeps the
    // recipe and drops them (the guide says so).
    let rewritten = write_recipe(doc).unwrap();
    assert!(!rewritten.contains("the base"));
    assert_eq!(norm(&parse_recipe(&rewritten).unwrap().doc), norm(doc));
}

#[test]
fn yaml_1_2_keeps_no_yes_and_on_words() {
    let text = "heeler_recipe: 1\nname: no\nkeywords: on off yes\noutput: a\nnodes:\n  a:\n    type: heeler.blur\n    enabled: false\n    params:\n      kind: no\n      mode: on\n      flag: true\n      radius: 0x10\n";
    let doc = parse_recipe(text).unwrap().doc;
    assert_eq!(doc["name"], json!("no"));
    assert_eq!(doc["nodes"][0]["params"]["kind"], json!("no"));
    assert_eq!(doc["nodes"][0]["params"]["mode"], json!("on"));
    assert_eq!(doc["nodes"][0]["params"]["flag"], json!(true));
    assert_eq!(doc["nodes"][0]["enabled"], json!(false));
    assert_eq!(doc["nodes"][0]["params"]["radius"], json!(16.0));
    // `yes` is a word too, so it cannot stand where true or false must.
    assert_eq!(error(&MINIMAL.replace("    type: heeler.blur\n", "    type: heeler.blur\n    enabled: yes\n")).line, 7);
    // And the writer quotes words other YAML readers would misread.
    for word in ["no", "Yes", "on", "OFF", "true", "null", "~", "12", "1.5", "", " padded", "a: b", "#tag", "[x]"] {
        let written = yaml_str(word, false);
        let doc = parse_recipe(&format!("heeler_recipe: 1\nname: x\ndescription: {written}\noutput: a\nnodes:\n  a:\n    type: heeler.blur\n")).unwrap().doc;
        assert_eq!(doc["description"], json!(word), "{word:?} written as {written}");
    }
    assert_eq!(yaml_str("Low (blur)", false), "Low (blur)");
}

#[test]
fn every_error_names_its_line() {
    let cases: Vec<(String, usize, &str)> = vec![
        (MINIMAL.replace("name: T\n", "name: T\ncolr: red\n"), 3, "\"colr\" is not a field of a recipe"),
        (MINIMAL.replace("    type: heeler.blur\n", "    type: heeler.blur\n    colr: red\n"), 7, "\"colr\" is not a field of node \"a\""),
        (MINIMAL.replace("heeler_recipe: 1\n", "heeler_recipe: 2\n"), 1, "this recipe is version 2"),
        (MINIMAL.replace("heeler_recipe: 1\n", ""), 1, "the first line should be `heeler_recipe: 1`"),
        (MINIMAL.replace("output: a\n", "output: b\n"), 3, "output names node \"b\", which this recipe does not have"),
        (format!("{MINIMAL}wires:\n  - from: a.out\n    to: hihg.in\n"), 9, "the wire's \"to\" names node \"hihg\""),
        (format!("{MINIMAL}wires:\n  - from: a.out\n"), 8, "a wire needs `to:`"),
        (format!("{MINIMAL}wires:\n  - {{ from: a, to: a.in.x }}\n"), 8, "should be a node's name"),
        (format!("{MINIMAL}    params:\n      radius: .nan\n"), 8, "must be a finite number"),
        (format!("{MINIMAL}    params:\n      radius: .inf\n"), 8, "must be a finite number"),
        (format!("{MINIMAL}    params:\n      radius: [1, 2]\n"), 8, "should be a number, a word, or true or false"),
        (format!("{MINIMAL}    at: [1]\n"), 7, "two numbers in brackets"),
        (format!("{MINIMAL}  a:\n    type: heeler.blur\n"), 7, "\"a\" appears twice"),
        (format!("{MINIMAL}  2b:\n    type: heeler.blur\n"), 7, "cannot name a node"),
        (format!("{MINIMAL}  b:\n    name: B\n"), 7, "node \"b\" needs a `type:`"),
        (format!("{MINIMAL}inputs:\n  in4: a\n"), 8, "\"in4\" is not one of a group's inputs"),
        (format!("{MINIMAL}inputs:\n  in: [a.in, c.in]\n"), 8, "input in names node \"c\""),
        (format!("{MINIMAL}controls:\n  - label: Size\n    drives: [a]\n"), 9, "a control drives a setting of it"),
        (format!("{MINIMAL}controls:\n  - label: Size\n    drives: [z.radius]\n"), 9, "control Size names node \"z\""),
        (format!("{MINIMAL}controls:\n  - label: Size\n"), 8, "Size needs `drives:`"),
        (format!("{MINIMAL}controls:\n  - label: Size\n    drives: a.radius\n    range: [5, 1]\n"), 10, "the first number must be the smaller"),
        (format!("{MINIMAL}controls:\n  - label: K\n    drives: a.kind\n    options:\n      - label: Box\n        set: {{ a.kind: box }}\n"), 9, "K is a menu (it has options), so it takes no drives"),
        (format!("{MINIMAL}controls:\n  - label: K\n    options:\n      - label: Box\n        set: {{}}\n"), 11, "this choice sets nothing"),
        (format!("{MINIMAL}controls:\n  - label: S\n    drives: a.radius\n  - label: S\n    drives: a.angle\n"), 10, "two controls are called S"),
        (format!("{MINIMAL}controls:\n  - label: S\n    reads: a.radius\n    drives: a.radius\n"), 9, "reads belongs to a menu"),
        (format!("base: &b {{ type: heeler.blur }}\n{MINIMAL}"), 1, "anchors (&name)"),
        (MINIMAL.replace("    type: heeler.blur\n", "    type: !!str heeler.blur\n"), 6, "tags (!name)"),
        (format!("{MINIMAL}---\nname: again\n"), 7, "a recipe file holds one recipe"),
        (MINIMAL.replace("nodes:\n", "nodes: [\n"), 6, "this is not valid YAML"),
        ("heeler_recipe: 1\nname: T\noutput: a\nnodes: {}\n".to_string(), 4, "the recipe has no nodes"),
        ("".to_string(), 0, "the file is empty"),
    ];
    for (text, line, words) in cases {
        let e = error(&text);
        assert!(e.message.contains(words), "expected {words:?}, got {e}\n{text}");
        assert_eq!(e.line, line, "{words}: wrong line in {e}\n{text}");
        if line > 0 {
            assert!(e.to_string().starts_with(&format!("line {line}: ")));
        }
    }
}

#[test]
fn aliases_cannot_expand_and_size_is_capped() {
    // A few lines of aliases asking for 9^9 copies: refused at the first.
    let bomb = "a: &a [x, x, x, x, x, x, x, x, x]\nb: &b [*a, *a, *a, *a, *a, *a, *a, *a, *a]\nc: [*b, *b, *b, *b, *b, *b, *b, *b, *b]\n";
    let e = error(bomb);
    assert!(e.message.contains("anchors"), "{e}");
    let big = format!("{MINIMAL}description: {}\n", "x".repeat(MAX_BYTES));
    assert!(error(&big).message.contains("may be at most 1024 KB"));
    let mut many = String::from("heeler_recipe: 1\nname: T\noutput: n0\nnodes:\n");
    for i in 0..=MAX_NODES {
        many.push_str(&format!("  n{i}:\n    type: heeler.blur\n"));
    }
    assert!(error(&many).message.contains("at most 500"));
    let deep = format!("{MINIMAL}description: {}1{}\n", "[".repeat(40), "]".repeat(40));
    assert!(error(&deep).message.contains("nests deeper"));
}

#[test]
fn a_duplicate_key_deep_in_a_wide_map_names_its_line() {
    // A map may hold thousands of keys (a curve's channels, a hand
    // editor's long list) and a duplicate near the end is still an
    // error at its own line, found without walking every key before it.
    let mut text = String::from("heeler_recipe: 1\nname: T\noutput: a\nnodes:\n  a:\n    type: heeler.blur\n    curves:\n");
    for i in 0..4000 {
        text.push_str(&format!("      ch{i}: [[0, 0]]\n"));
    }
    let parsed = parse_recipe(&text).unwrap();
    assert!(parsed.doc["nodes"][0]["curves"].as_object().unwrap().len() == 4000);
    // The first key lands on line 8, so the duplicate lands on 4008.
    text.push_str("      ch2000: [[1, 1]]\n");
    let e = error(&text);
    assert!(e.message.contains("\"ch2000\" appears twice"), "{e}");
    assert_eq!(e.line, 4008, "{e}");
}

fn temp_base() -> tempfile::TempDir {
    tempfile::tempdir().unwrap()
}

fn soft_glow() -> Value {
    parse_recipe(&guide_example()).unwrap().doc
}

#[test]
fn save_lists_in_its_category_and_never_overwrites() {
    let dir = temp_base();
    let base = dir.path();
    let doc = soft_glow();
    let a = save_recipe(base, "Looks", &doc).unwrap();
    let b = save_recipe(base, "Looks", &doc).unwrap();
    assert_eq!(Path::new(&a), base.join("Looks/Soft Glow.heelerrecipe"), "{a}");
    assert_eq!(Path::new(&b), base.join("Looks/Soft Glow 2.heelerrecipe"), "{b}");
    let c = save_recipe(base, "", &doc).unwrap();
    assert_eq!(Path::new(&c), base.join("Personal/Soft Glow.heelerrecipe"), "{c}");
    // A category cannot climb out of the folder.
    let d = save_recipe(base, "../../outside", &doc).unwrap();
    assert!(Path::new(&d).starts_with(base), "{d}");
    let listed = list_recipes(base);
    assert_eq!(listed.iter().map(|e| (e.category.as_str(), e.file.as_str())).collect::<Vec<_>>(), vec![
        ("Looks", "Soft Glow"),
        ("Looks", "Soft Glow 2"),
        ("Personal", "Soft Glow"),
        ("outside", "Soft Glow"),
    ]);
    assert!(listed.iter().all(|e| e.error.is_none() && e.parsed.as_ref().unwrap().doc["name"] == json!("Soft Glow")));
    let text = std::fs::read_to_string(&a).unwrap();
    assert!(text.starts_with(HEADER));
}

#[test]
fn a_broken_file_lists_with_its_error() {
    let dir = temp_base();
    let base = dir.path();
    std::fs::create_dir_all(base.join("Personal")).unwrap();
    std::fs::write(base.join("Personal/Broken.heelerrecipe"), MINIMAL.replace("name: T\n", "name: T\ncolr: red\n")).unwrap();
    std::fs::write(base.join("Personal/Not a recipe.txt"), "hello").unwrap();
    std::fs::create_dir_all(base.join(".trash")).unwrap();
    std::fs::write(base.join(".trash/Old.heelerrecipe"), MINIMAL).unwrap();
    let listed = list_recipes(base);
    assert_eq!(listed.len(), 1, "the .trash and other files are not recipes");
    assert_eq!(listed[0].file, "Broken");
    assert!(listed[0].parsed.is_none());
    assert_eq!(listed[0].error.as_deref(), Some("line 3: \"colr\" is not a field of a recipe; a recipe has heeler_recipe, name, description, category, keywords, inputs, output, nodes, wires and controls"));
}

#[test]
fn rename_renames_the_file_and_the_name_inside() {
    let dir = temp_base();
    let base = dir.path();
    let path = save_recipe(base, "Looks", &soft_glow()).unwrap();
    let renamed = rename_recipe(base, &path, "Dreamy").unwrap();
    assert_eq!(Path::new(&renamed), base.join("Looks/Dreamy.heelerrecipe"), "{renamed}");
    // The frontend matches the answer against the list by string: the
    // same spelling, never the resolved one (Windows: `\\?\C:\...`).
    assert!(list_recipes(base).iter().any(|e| e.path == renamed), "{renamed} is not a path the list holds");
    assert!(!Path::new(&path).exists(), "the old name is gone: renamed, not copied");
    let doc = parse_recipe(&std::fs::read_to_string(&renamed).unwrap()).unwrap().doc;
    assert_eq!(doc["name"], json!("Dreamy"));
    assert_eq!(norm(&doc["nodes"]), norm(&soft_glow()["nodes"]));
    // Onto a name that is taken: a free one beside it.
    let other = save_recipe(base, "Looks", &soft_glow()).unwrap();
    let second = rename_recipe(base, &other, "Dreamy").unwrap();
    assert_eq!(Path::new(&second), base.join("Looks/Dreamy 2.heelerrecipe"), "{second}");
    assert!(rename_recipe(base, &second, "  ").is_err());
}

#[test]
fn remove_moves_the_file_into_dot_trash() {
    let dir = temp_base();
    let base = dir.path();
    let path = save_recipe(base, "Looks", &soft_glow()).unwrap();
    let bytes = std::fs::read(&path).unwrap();
    let moved = trash_recipe(base, &path).unwrap();
    assert_eq!(Path::new(&moved), base.join(".trash/Looks/Soft Glow.heelerrecipe"), "{moved}");
    assert!(!Path::new(&path).exists());
    assert_eq!(std::fs::read(&moved).unwrap(), bytes, "the same file, moved");
    assert!(list_recipes(base).is_empty());
    // The same name again lands beside the first, nothing replaced.
    let again = save_recipe(base, "Looks", &soft_glow()).unwrap();
    let moved2 = trash_recipe(base, &again).unwrap();
    assert_eq!(Path::new(&moved2), base.join(".trash/Looks/Soft Glow 2.heelerrecipe"), "{moved2}");
    assert!(Path::new(&moved).exists());
}

#[test]
fn paths_outside_the_folder_are_refused() {
    let dir = temp_base();
    let base = dir.path().join("recipes");
    std::fs::create_dir_all(&base).unwrap();
    let outside = dir.path().join("Mine.heelerrecipe");
    std::fs::write(&outside, MINIMAL).unwrap();
    let p = outside.to_string_lossy().to_string();
    assert!(trash_recipe(&base, &p).is_err());
    assert!(rename_recipe(&base, &p, "X").is_err());
    let sneaky = base.join("../Mine.heelerrecipe").to_string_lossy().to_string();
    assert!(trash_recipe(&base, &sneaky).is_err());
    assert!(outside.exists());
    let text_file = base.join("notes.txt");
    std::fs::write(&text_file, "x").unwrap();
    assert!(trash_recipe(&base, &text_file.to_string_lossy()).is_err(), "only recipe files");
}

#[test]
fn import_keeps_the_file_as_written_and_refuses_what_cannot_be_read() {
    let dir = temp_base();
    let base = dir.path().join("recipes");
    let good = dir.path().join("glow.yaml");
    std::fs::write(&good, guide_example()).unwrap();
    let plain = dir.path().join("plain.heelerrecipe");
    std::fs::write(&plain, MINIMAL).unwrap();
    let bad = dir.path().join("bad.heelerrecipe");
    std::fs::write(&bad, MINIMAL.replace("heeler_recipe: 1", "heeler_recipe: 7")).unwrap();
    let missing = dir.path().join("missing.heelerrecipe");
    let report = import_recipes(&base, &[good.clone(), plain, bad, missing]);
    assert_eq!(report.imported.len(), 2, "{report:?}");
    assert_eq!(Path::new(&report.imported[0]), base.join("Looks/Soft Glow.heelerrecipe"), "its category: {:?}", report.imported);
    assert_eq!(Path::new(&report.imported[1]), base.join("Personal/T.heelerrecipe"));
    assert_eq!(std::fs::read_to_string(&report.imported[0]).unwrap(), guide_example(), "comments and all");
    assert_eq!(report.failed.len(), 2);
    assert_eq!(report.failed[0].0, "bad.heelerrecipe");
    assert!(report.failed[0].1.starts_with("line 1: this recipe is version 7"), "{:?}", report.failed);
    assert_eq!(report.failed[1].0, "missing.heelerrecipe");
    assert_eq!(list_recipes(&base).len(), 2, "a refused file lands nowhere");
    assert!(good.exists(), "the source is left where it was");
}

#[test]
fn export_writes_a_file_that_reads_back() {
    let dir = temp_base();
    let dest = dir.path().join("out/Frequency Separation.heelerrecipe");
    let doc = &fixture_docs()["frequency_separation"];
    export_recipe_to(doc, &dest).unwrap();
    let back = parse_recipe(&std::fs::read_to_string(&dest).unwrap()).unwrap();
    assert_eq!(norm(&back.doc), norm(doc));
    assert!(export_recipe_to(&json!({ "name": "" }), &dir.path().join("x.heelerrecipe")).is_err());
    assert!(!dir.path().join("x.heelerrecipe").exists());
}

#[test]
fn the_commands_match_the_frontend_bridge() {
    let ts = std::fs::read_to_string(Path::new(env!("CARGO_MANIFEST_DIR")).join("../src/bridge.ts")).unwrap();
    for (command, args) in [
        ("recipe_list", vec![]),
        ("recipe_save", vec!["category", "doc"]),
        ("recipe_rename", vec!["path", "name"]),
        ("recipe_trash", vec!["path"]),
        ("recipe_import", vec![]),
        ("recipe_export", vec!["doc", "name"]),
    ] {
        let line = ts.lines().find(|l| l.contains(&format!("call(\"{command}\""))).unwrap_or_else(|| panic!("bridge no longer calls {command}"));
        for arg in args {
            assert!(line.contains(arg), "bridge's {command} call no longer names {arg}: {line}");
        }
    }
    let lib = include_str!("../lib.rs");
    for command in ["recipe_list", "recipe_save", "recipe_rename", "recipe_trash", "recipe_import", "recipe_export"] {
        assert!(lib.contains(&format!("recipe_files::{command},")), "{command} is not registered");
    }
}
