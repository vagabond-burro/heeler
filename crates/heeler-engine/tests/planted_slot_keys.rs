//! The cache keys of nodes that read a planted raster, pinned to the
//! value: a planted raster's slot (a raster-fed node's own, Depth
//! Lighting's normals, a wire off a planted port) is hashed into the key
//! of every node that reads it, and those keys reach disk (the desktop
//! names a depth map's file by its input's key), so they must not change
//! by accident. Also the admission estimate's read of a planted plane.
//! Every slot kind, with a raster and without, and the measured mark.

use heeler_engine::{executor::PLANTED_AS, Executor, ImageBuf, SourceImage};
use heeler_graph::{Graph, ParamValue, Registry, Section};
use std::{collections::HashMap, sync::Arc};

fn plant(v: f32, version: u64, measured: bool) -> SourceImage {
    SourceImage { image: Arc::new(ImageBuf::filled(8, 6, [v, v, v, 1.0])), version, measured }
}

/// src -> smart mask sm; dm (Depth Map) planted port -> Invert Mask inv;
/// src and dm's plane -> Depth Lighting kl.
fn graph() -> Graph {
    graph_with(None)
}

/// The same, with the smart mask told to read another node's raster
/// (PLANTED_AS, which the desktop sets on the engine graph alone, never
/// through a spec param).
fn graph_with(planted_as: Option<&str>) -> Graph {
    let r = Registry::builtin();
    let mut g = Graph::new("slots");
    for (ty, id) in [
        ("heeler.image_source", "src"),
        ("heeler.smart_mask", "sm"),
        ("heeler.depth_map", "dm"),
        ("heeler.invert_mask", "inv"),
        ("heeler.key_light", "kl"),
    ] {
        let mut n = r.instantiate(ty, id, Section::Creative).unwrap();
        if let (Some(other), "sm") = (planted_as, id) {
            n.params.insert(PLANTED_AS.into(), ParamValue::Text(other.into()));
        }
        g.add_node(n).unwrap();
    }
    g.connect("src", "out", "sm", "in").unwrap();
    g.connect("src", "out", "dm", "in").unwrap();
    g.connect("dm", "depth", "inv", "mask").unwrap();
    g.connect("src", "out", "kl", "in").unwrap();
    g.connect("dm", "depth", "kl", "depth").unwrap();
    g
}

fn sources(raster: bool, depth: Option<bool>, normals: bool) -> HashMap<String, SourceImage> {
    let mut s = HashMap::from([("src".to_string(), plant(0.3, 1, false))]);
    if raster {
        s.insert("sm".into(), plant(0.9, 5, false));
    }
    if let Some(measured) = depth {
        s.insert("dm@depth".into(), plant(0.5, 7, measured));
    }
    if normals {
        s.insert("kl@normal".into(), plant(0.5, 3, false));
    }
    s
}

fn keys(g: &Graph, s: &HashMap<String, SourceImage>) -> [u64; 3] {
    ["sm", "inv", "kl"].map(|id| Executor::key_of(g, id, s).unwrap())
}

#[test]
fn planted_slot_keys_are_pinned() {
    let g = graph();
    let cases: [(&str, HashMap<String, SourceImage>, [u64; 3]); 4] = [
        ("nothing planted", sources(false, None, false), [4371581857097913061, 10275381172048920720, 15299367817446202319]),
        ("everything planted", sources(true, Some(false), true), [5270013868791001075, 4226895556898822380, 2616015882822297083]),
        ("the plane measured", sources(true, Some(true), true), [5270013868791001075, 4226896656410450591, 2616014783310668872]),
        ("planted at version 0", {
            let mut s = sources(true, Some(false), true);
            for slot in ["sm", "dm@depth", "kl@normal"] {
                s.get_mut(slot).unwrap().version = 0;
            }
            s
        }, [6796383947310787042, 12051243099088134873, 9084895613584890985]),
    ];
    for (name, s, want) in cases {
        assert_eq!(keys(&g, &s), want, "{name}");
    }
}

/// A raster-fed node told to read another node's raster (PLANTED_AS)
/// keys by that slot.
#[test]
fn a_planted_as_slot_is_keyed_by_the_slot_it_names() {
    let g = graph_with(Some("other"));
    let mut s = sources(false, None, false);
    let without = Executor::key_of(&g, "sm", &s).unwrap();
    s.insert("other".into(), plant(0.9, 5, false));
    let with = Executor::key_of(&g, "sm", &s).unwrap();
    assert_eq!([without, with], [15055192598223988918, 4369477483476002840]);
}

/// Admission reads a planted plane's size into the mask it becomes.
#[test]
fn admission_counts_a_planted_plane() {
    let g = graph();
    let planted = Executor::new().estimate(&g, "inv", &sources(false, Some(false), false)).unwrap();
    let absent = Executor::new().estimate(&g, "inv", &sources(false, None, false)).unwrap();
    // With the plane planted, the render reads it into a mask and inverts
    // that; without it, the empty mask a missing plane answers. Planted:
    // the photograph and the plane resident (768 bytes each), and the
    // Invert's worst moment, the plane read in (192), its mask out (192)
    // and two frames of scratch (1536). Absent: the photograph, and a one
    // pixel mask's 4 bytes out and 32 of scratch.
    assert_eq!([planted, absent], [3456, 804]);
}
