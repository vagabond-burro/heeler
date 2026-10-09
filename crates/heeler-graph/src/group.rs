//! Node groups: reusable saved subgraphs, Heeler's preset format.
//!
//! A group is extracted from a selection of nodes in a graph, saved as a
//! standalone `.heelergroup` JSON file (no project references, no absolute
//! paths, marketplace-ready metadata from day one), and instantiated back
//! into any graph with remapped node ids.

use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::path::Path;

use serde::{Deserialize, Serialize};

use crate::error::GraphError;
use crate::graph::{Connection, Graph};
use crate::node::Node;
use crate::ports::PortKind;

pub const GROUP_SCHEMA_VERSION: u32 = 1;
pub const GROUP_EXTENSION: &str = "heelergroup";

#[derive(Debug, thiserror::Error)]
pub enum GroupError {
    #[error(transparent)]
    Graph(#[from] GraphError),
    #[error("group selection is empty")]
    EmptySelection,
    #[error("selected node '{0}' is not in the graph")]
    UnknownNode(String),
    #[error("exposed param target '{node}.{param}' does not exist in the group")]
    BadExposedParam { node: String, param: String },
    #[error("io error: {0}")]
    Io(#[from] std::io::Error),
    #[error("invalid group file: {0}")]
    Format(#[from] serde_json::Error),
    #[error("unsupported group schema version {0}")]
    SchemaVersion(u32),
}

/// A boundary port of the group: where outside connections attach when the
/// group is instantiated. `node`/`port` reference the group's internal ids.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct GroupPort {
    pub name: String,
    pub kind: PortKind,
    pub node: String,
    pub port: String,
}

/// An inner parameter promoted to the group's surface, so a look can be
/// tweaked without opening the group.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ExposedParam {
    pub alias: String,
    pub node: String,
    pub param: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct GroupDef {
    pub schema_version: u32,
    pub name: String,
    #[serde(default)]
    pub description: String,
    #[serde(default)]
    pub author: String,
    #[serde(default)]
    pub tags: Vec<String>,
    pub nodes: Vec<Node>,
    pub connections: Vec<Connection>,
    pub inputs: Vec<GroupPort>,
    pub outputs: Vec<GroupPort>,
    #[serde(default)]
    pub exposed_params: Vec<ExposedParam>,
}

/// The result of instantiating a group into a target graph: concrete nodes
/// and connections with remapped ids, plus maps from boundary port names to
/// the (node, port) pairs outside wiring should attach to.
#[derive(Debug, Clone)]
pub struct GroupInstance {
    pub nodes: Vec<Node>,
    pub connections: Vec<Connection>,
    pub inputs: BTreeMap<String, (String, String)>,
    pub outputs: BTreeMap<String, (String, String)>,
    pub exposed_params: BTreeMap<String, (String, String)>,
}

impl GroupDef {
    /// Extracts the selected nodes into a group definition.
    ///
    /// Boundary rules:
    /// - every selected-node input that is not fed from inside the selection
    ///   becomes a group input, unless it is optional and unconnected
    /// - every selected-node output that is not consumed inside the
    ///   selection becomes a group output
    pub fn extract(graph: &Graph, name: &str, selection: &[&str]) -> Result<GroupDef, GroupError> {
        if selection.is_empty() {
            return Err(GroupError::EmptySelection);
        }
        let sel: BTreeSet<&str> = selection.iter().copied().collect();
        for id in &sel {
            if graph.node(id).is_none() {
                return Err(GroupError::UnknownNode(id.to_string()));
            }
        }

        let nodes: Vec<Node> = sel
            .iter()
            .map(|id| graph.node(id).expect("checked above").clone())
            .collect();

        let internal: Vec<Connection> = graph
            .connections()
            .iter()
            .filter(|c| sel.contains(c.from.0.as_str()) && sel.contains(c.to.0.as_str()))
            .cloned()
            .collect();

        let fed_internally: BTreeSet<(String, String)> =
            internal.iter().map(|c| c.to.clone()).collect();
        let consumed_internally: BTreeSet<(String, String)> =
            internal.iter().map(|c| c.from.clone()).collect();

        let mut inputs = Vec::new();
        let mut outputs = Vec::new();
        for node in &nodes {
            for port in &node.inputs {
                let key = (node.id.clone(), port.name.clone());
                if fed_internally.contains(&key) {
                    continue;
                }
                let fed_externally = graph.incoming(&node.id, &port.name).is_some();
                if fed_externally || !port.optional {
                    inputs.push(GroupPort {
                        name: format!("{}.{}", node.id, port.name),
                        kind: port.kind,
                        node: node.id.clone(),
                        port: port.name.clone(),
                    });
                }
            }
            for port in &node.outputs {
                let key = (node.id.clone(), port.name.clone());
                if consumed_internally.contains(&key) {
                    continue;
                }
                outputs.push(GroupPort {
                    name: format!("{}.{}", node.id, port.name),
                    kind: port.kind,
                    node: node.id.clone(),
                    port: port.name.clone(),
                });
            }
        }

        Ok(GroupDef {
            schema_version: GROUP_SCHEMA_VERSION,
            name: name.to_string(),
            description: String::new(),
            author: String::new(),
            tags: Vec::new(),
            nodes,
            connections: internal,
            inputs,
            outputs,
            exposed_params: Vec::new(),
        })
    }

    /// Promotes an inner parameter to the group surface.
    pub fn expose(&mut self, alias: &str, node: &str, param: &str) -> Result<(), GroupError> {
        let target = self
            .nodes
            .iter()
            .find(|n| n.id == node)
            .filter(|n| n.params.contains_key(param));
        if target.is_none() {
            return Err(GroupError::BadExposedParam {
                node: node.to_string(),
                param: param.to_string(),
            });
        }
        self.exposed_params.push(ExposedParam {
            alias: alias.to_string(),
            node: node.to_string(),
            param: param.to_string(),
        });
        Ok(())
    }

    /// First image-kind boundary ports; the common wire-a-look-into-a-chain
    /// case only needs these.
    pub fn primary_input(&self) -> Option<&GroupPort> {
        self.inputs.iter().find(|p| p.kind == PortKind::Image)
    }

    pub fn primary_output(&self) -> Option<&GroupPort> {
        self.outputs.iter().find(|p| p.kind == PortKind::Image)
    }

    /// Produces nodes and connections ready to insert into a target graph.
    /// Every internal node id gets `prefix` prepended, so one group can be
    /// applied many times to the same graph.
    pub fn instantiate(&self, prefix: &str) -> GroupInstance {
        let remap = |id: &str| format!("{prefix}{id}");
        let nodes = self
            .nodes
            .iter()
            .map(|n| {
                let mut n = n.clone();
                n.id = remap(&n.id);
                n
            })
            .collect();
        let connections = self
            .connections
            .iter()
            .map(|c| Connection {
                from: (remap(&c.from.0), c.from.1.clone()),
                to: (remap(&c.to.0), c.to.1.clone()),
            })
            .collect();
        let inputs = self
            .inputs
            .iter()
            .map(|p| (p.name.clone(), (remap(&p.node), p.port.clone())))
            .collect();
        let outputs = self
            .outputs
            .iter()
            .map(|p| (p.name.clone(), (remap(&p.node), p.port.clone())))
            .collect();
        let exposed_params = self
            .exposed_params
            .iter()
            .map(|e| (e.alias.clone(), (remap(&e.node), e.param.clone())))
            .collect();
        GroupInstance {
            nodes,
            connections,
            inputs,
            outputs,
            exposed_params,
        }
    }

    pub fn save(&self, path: &Path) -> Result<(), GroupError> {
        fs::write(path, serde_json::to_string_pretty(self)?)?;
        Ok(())
    }

    pub fn load(path: &Path) -> Result<GroupDef, GroupError> {
        let def: GroupDef = serde_json::from_str(&fs::read_to_string(path)?)?;
        if def.schema_version != GROUP_SCHEMA_VERSION {
            return Err(GroupError::SchemaVersion(def.schema_version));
        }
        Ok(def)
    }
}

/// Inserts an instantiated group into a graph.
pub fn apply_instance(graph: &mut Graph, instance: &GroupInstance) -> Result<(), GraphError> {
    for node in &instance.nodes {
        graph.add_node(node.clone())?;
    }
    for c in &instance.connections {
        graph.connect(&c.from.0, &c.from.1, &c.to.0, &c.to.1)?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::node::{ParamValue, Section};
    use crate::spec::Registry;

    fn look_graph(registry: &Registry) -> Graph {
        // src -> exposure -> levels, the "look" being e + l.
        let mut g = Graph::new("template");
        for (t, id) in [
            ("heeler.image_source", "src"),
            ("heeler.exposure", "e"),
            ("heeler.levels", "l"),
        ] {
            g.add_node(registry.instantiate(t, id, Section::Creative).unwrap())
                .unwrap();
        }
        g.connect("src", "out", "e", "in").unwrap();
        g.connect("e", "out", "l", "in").unwrap();
        g.set_param("e", "exposure", ParamValue::Number(1.0)).unwrap();
        g
    }

    #[test]
    fn extract_finds_boundary_ports() {
        let r = Registry::builtin();
        let g = look_graph(&r);
        let def = GroupDef::extract(&g, "Test Look", &["e", "l"]).unwrap();

        assert_eq!(def.nodes.len(), 2);
        assert_eq!(def.connections.len(), 1, "only the internal e->l wire");
        assert_eq!(def.inputs.len(), 1, "e.in fed from outside; masks optional and unconnected");
        assert_eq!(def.inputs[0].name, "e.in");
        assert_eq!(def.outputs.len(), 1, "l.out unconsumed");
        assert_eq!(def.outputs[0].name, "l.out");
        assert_eq!(def.primary_input().unwrap().node, "e");
        assert_eq!(def.primary_output().unwrap().node, "l");
    }

    #[test]
    fn extract_preserves_param_values() {
        let r = Registry::builtin();
        let g = look_graph(&r);
        let def = GroupDef::extract(&g, "Look", &["e", "l"]).unwrap();
        let e = def.nodes.iter().find(|n| n.id == "e").unwrap();
        assert_eq!(e.params.get("exposure"), Some(&ParamValue::Number(1.0)));
    }

    #[test]
    fn extract_empty_selection_errors() {
        let r = Registry::builtin();
        let g = look_graph(&r);
        assert!(matches!(
            GroupDef::extract(&g, "x", &[]),
            Err(GroupError::EmptySelection)
        ));
    }

    #[test]
    fn extract_unknown_node_errors() {
        let r = Registry::builtin();
        let g = look_graph(&r);
        assert!(matches!(
            GroupDef::extract(&g, "x", &["e", "ghost"]),
            Err(GroupError::UnknownNode(_))
        ));
    }

    #[test]
    fn expose_validates_target() {
        let r = Registry::builtin();
        let g = look_graph(&r);
        let mut def = GroupDef::extract(&g, "Look", &["e", "l"]).unwrap();
        def.expose("Strength", "e", "exposure").unwrap();
        assert!(matches!(
            def.expose("Bad", "e", "sparkle"),
            Err(GroupError::BadExposedParam { .. })
        ));
        assert!(matches!(
            def.expose("Bad", "ghost", "exposure"),
            Err(GroupError::BadExposedParam { .. })
        ));
    }

    #[test]
    fn instantiate_remaps_ids_and_applies() {
        let r = Registry::builtin();
        let template = look_graph(&r);
        let mut def = GroupDef::extract(&template, "Look", &["e", "l"]).unwrap();
        def.expose("Strength", "e", "exposure").unwrap();

        let mut target = Graph::new("image_1");
        target
            .add_node(r.instantiate("heeler.image_source", "src", Section::RawFoundation).unwrap())
            .unwrap();

        let inst = def.instantiate("grp1_");
        apply_instance(&mut target, &inst).unwrap();
        assert!(target.node("grp1_e").is_some());
        assert!(target.node("grp1_l").is_some());
        assert_eq!(target.connections().len(), 1);

        let (in_node, in_port) = &inst.inputs["e.in"];
        target.connect("src", "out", in_node, in_port).unwrap();
        assert_eq!(target.connections().len(), 2);

        assert_eq!(
            inst.exposed_params.get("Strength"),
            Some(&("grp1_e".to_string(), "exposure".to_string()))
        );
    }

    #[test]
    fn same_group_applies_twice_with_different_prefixes() {
        let r = Registry::builtin();
        let template = look_graph(&r);
        let def = GroupDef::extract(&template, "Look", &["e", "l"]).unwrap();
        let mut target = Graph::new("image_1");
        apply_instance(&mut target, &def.instantiate("a_")).unwrap();
        apply_instance(&mut target, &def.instantiate("b_")).unwrap();
        assert_eq!(target.node_count(), 4);
    }

    #[test]
    fn group_file_round_trip() {
        let r = Registry::builtin();
        let g = look_graph(&r);
        let mut def = GroupDef::extract(&g, "Kodak Portra Portrait Grade", &["e", "l"]).unwrap();
        def.description = "Warm portrait look".into();
        def.author = "A. Photographer".into();
        def.tags = vec!["portrait".into(), "film".into()];
        def.expose("Strength", "e", "exposure").unwrap();

        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("PORTRA_FILM_LOOK.heelergroup");
        def.save(&path).unwrap();
        let back = GroupDef::load(&path).unwrap();
        assert_eq!(def, back);
    }

    #[test]
    fn group_file_bad_schema_rejected() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("bad.heelergroup");
        let r = Registry::builtin();
        let g = look_graph(&r);
        let mut def = GroupDef::extract(&g, "Look", &["e"]).unwrap();
        def.schema_version = 99;
        std::fs::write(&path, serde_json::to_string(&def).unwrap()).unwrap();
        assert!(matches!(
            GroupDef::load(&path),
            Err(GroupError::SchemaVersion(99))
        ));
    }
}
