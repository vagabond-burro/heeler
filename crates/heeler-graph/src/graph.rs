use std::collections::{BTreeMap, BTreeSet, VecDeque};

use serde::{Deserialize, Serialize};

use crate::error::GraphError;
use crate::node::{Node, ParamValue};

pub const SCHEMA_VERSION: u32 = 1;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Connection {
    /// (node id, output port name)
    pub from: (String, String),
    /// (node id, input port name)
    pub to: (String, String),
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Graph {
    pub schema_version: u32,
    pub graph_id: String,
    nodes: BTreeMap<String, Node>,
    connections: Vec<Connection>,
    /// Editor positions; never affects execution.
    #[serde(default)]
    layout: BTreeMap<String, (f64, f64)>,
}

impl Graph {
    pub fn new(graph_id: &str) -> Self {
        Graph {
            schema_version: SCHEMA_VERSION,
            graph_id: graph_id.to_string(),
            nodes: BTreeMap::new(),
            connections: Vec::new(),
            layout: BTreeMap::new(),
        }
    }

    pub fn node(&self, id: &str) -> Option<&Node> {
        self.nodes.get(id)
    }

    pub fn nodes(&self) -> impl Iterator<Item = &Node> {
        self.nodes.values()
    }

    pub fn node_count(&self) -> usize {
        self.nodes.len()
    }

    pub fn connections(&self) -> &[Connection] {
        &self.connections
    }

    pub fn add_node(&mut self, node: Node) -> Result<(), GraphError> {
        if self.nodes.contains_key(&node.id) {
            return Err(GraphError::NodeExists(node.id));
        }
        self.nodes.insert(node.id.clone(), node);
        Ok(())
    }

    /// Removes a node plus every connection touching it. Returns both so the
    /// caller (the command system) can build an exact inverse for undo.
    pub fn remove_node(&mut self, id: &str) -> Result<(Node, Vec<Connection>), GraphError> {
        let node = self
            .nodes
            .remove(id)
            .ok_or_else(|| GraphError::NodeNotFound(id.to_string()))?;
        let (removed, kept): (Vec<Connection>, Vec<Connection>) = self
            .connections
            .drain(..)
            .partition(|c| c.from.0 == id || c.to.0 == id);
        self.connections = kept;
        self.layout.remove(id);
        Ok((node, removed))
    }

    pub fn set_param(
        &mut self,
        node_id: &str,
        param: &str,
        value: ParamValue,
    ) -> Result<ParamValue, GraphError> {
        let node = self
            .nodes
            .get_mut(node_id)
            .ok_or_else(|| GraphError::NodeNotFound(node_id.to_string()))?;
        match node.params.get_mut(param) {
            Some(slot) => Ok(std::mem::replace(slot, value)),
            None => Err(GraphError::UnknownParam {
                node_type: node.node_type.clone(),
                param: param.to_string(),
            }),
        }
    }

    pub fn set_enabled(&mut self, node_id: &str, enabled: bool) -> Result<bool, GraphError> {
        let node = self
            .nodes
            .get_mut(node_id)
            .ok_or_else(|| GraphError::NodeNotFound(node_id.to_string()))?;
        Ok(std::mem::replace(&mut node.enabled, enabled))
    }

    pub fn set_label(&mut self, node_id: &str, label: &str) -> Result<String, GraphError> {
        let node = self
            .nodes
            .get_mut(node_id)
            .ok_or_else(|| GraphError::NodeNotFound(node_id.to_string()))?;
        Ok(std::mem::replace(&mut node.label, label.to_string()))
    }

    pub fn set_position(&mut self, node_id: &str, x: f64, y: f64) -> Result<(), GraphError> {
        if !self.nodes.contains_key(node_id) {
            return Err(GraphError::NodeNotFound(node_id.to_string()));
        }
        self.layout.insert(node_id.to_string(), (x, y));
        Ok(())
    }

    pub fn position(&self, node_id: &str) -> Option<(f64, f64)> {
        self.layout.get(node_id).copied()
    }

    pub fn incoming(&self, node_id: &str, port: &str) -> Option<&Connection> {
        self.connections
            .iter()
            .find(|c| c.to.0 == node_id && c.to.1 == port)
    }

    pub fn connect(
        &mut self,
        from_node: &str,
        from_port: &str,
        to_node: &str,
        to_port: &str,
    ) -> Result<(), GraphError> {
        if from_node == to_node {
            return Err(GraphError::SelfConnection);
        }
        let from = self
            .nodes
            .get(from_node)
            .ok_or_else(|| GraphError::NodeNotFound(from_node.to_string()))?;
        let to = self
            .nodes
            .get(to_node)
            .ok_or_else(|| GraphError::NodeNotFound(to_node.to_string()))?;
        let out_spec = from.output(from_port).ok_or_else(|| GraphError::PortNotFound {
            node: from_node.to_string(),
            port: from_port.to_string(),
        })?;
        let in_spec = to.input(to_port).ok_or_else(|| GraphError::PortNotFound {
            node: to_node.to_string(),
            port: to_port.to_string(),
        })?;
        if !in_spec.kind.accepts(out_spec.kind) {
            return Err(GraphError::IncompatiblePorts {
                from_kind: out_spec.kind,
                to_kind: in_spec.kind,
            });
        }
        if self.incoming(to_node, to_port).is_some() {
            return Err(GraphError::InputOccupied {
                node: to_node.to_string(),
                port: to_port.to_string(),
            });
        }
        if self.reaches_downstream(to_node, from_node) {
            return Err(GraphError::CycleDetected);
        }
        self.connections.push(Connection {
            from: (from_node.to_string(), from_port.to_string()),
            to: (to_node.to_string(), to_port.to_string()),
        });
        Ok(())
    }

    pub fn disconnect(&mut self, to_node: &str, to_port: &str) -> Result<Connection, GraphError> {
        let idx = self
            .connections
            .iter()
            .position(|c| c.to.0 == to_node && c.to.1 == to_port)
            .ok_or_else(|| GraphError::ConnectionNotFound {
                node: to_node.to_string(),
                port: to_port.to_string(),
            })?;
        Ok(self.connections.remove(idx))
    }

    /// True if `target` is reachable by following connections downstream
    /// from `start`.
    fn reaches_downstream(&self, start: &str, target: &str) -> bool {
        let mut queue = VecDeque::from([start.to_string()]);
        let mut seen = BTreeSet::new();
        while let Some(current) = queue.pop_front() {
            if current == target {
                return true;
            }
            if !seen.insert(current.clone()) {
                continue;
            }
            for c in &self.connections {
                if c.from.0 == current {
                    queue.push_back(c.to.0.clone());
                }
            }
        }
        false
    }

    /// Kahn's algorithm; deterministic because ready nodes are drained in
    /// sorted id order. Graph mutations reject cycles, so this covers all
    /// nodes by construction.
    pub fn topo_order(&self) -> Vec<String> {
        let mut indegree: BTreeMap<&str, usize> =
            self.nodes.keys().map(|id| (id.as_str(), 0)).collect();
        for c in &self.connections {
            if let Some(d) = indegree.get_mut(c.to.0.as_str()) {
                *d += 1;
            }
        }
        let mut ready: BTreeSet<&str> = indegree
            .iter()
            .filter(|(_, d)| **d == 0)
            .map(|(id, _)| *id)
            .collect();
        let mut order = Vec::with_capacity(self.nodes.len());
        while let Some(&id) = ready.iter().next() {
            ready.remove(id);
            order.push(id.to_string());
            for c in &self.connections {
                if c.from.0 == id {
                    let d = indegree.get_mut(c.to.0.as_str()).expect("known node");
                    *d -= 1;
                    if *d == 0 {
                        ready.insert(c.to.0.as_str());
                    }
                }
            }
        }
        order
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::node::Section;
    use crate::spec::Registry;

    fn graph_with(registry: &Registry, specs: &[(&str, &str)]) -> Graph {
        let mut g = Graph::new("test");
        for (id, node_type) in specs {
            let node = registry
                .instantiate(node_type, id, Section::Creative)
                .unwrap();
            g.add_node(node).unwrap();
        }
        g
    }

    #[test]
    fn add_duplicate_node_rejected() {
        let r = Registry::builtin();
        let mut g = graph_with(&r, &[("a", "heeler.exposure")]);
        let dup = r.instantiate("heeler.exposure", "a", Section::Creative).unwrap();
        assert_eq!(g.add_node(dup), Err(GraphError::NodeExists("a".into())));
    }

    #[test]
    fn connect_image_to_image_ok() {
        let r = Registry::builtin();
        let mut g = graph_with(&r, &[("src", "heeler.image_source"), ("e", "heeler.exposure")]);
        g.connect("src", "out", "e", "in").unwrap();
        assert_eq!(g.connections().len(), 1);
        assert!(g.incoming("e", "in").is_some());
    }

    #[test]
    fn connect_image_to_mask_rejected() {
        let r = Registry::builtin();
        let mut g = graph_with(&r, &[("src", "heeler.image_source"), ("e", "heeler.exposure")]);
        let err = g.connect("src", "out", "e", "mask").unwrap_err();
        assert!(matches!(err, GraphError::IncompatiblePorts { .. }));
    }

    #[test]
    fn channel_output_feeds_mask_input() {
        let r = Registry::builtin();
        let mut g = graph_with(
            &r,
            &[
                ("src", "heeler.image_source"),
                ("lum", "heeler.luminance_extract"),
                ("e", "heeler.exposure"),
            ],
        );
        g.connect("src", "out", "lum", "in").unwrap();
        g.connect("lum", "out", "e", "mask").unwrap();
    }

    #[test]
    fn occupied_input_rejected() {
        let r = Registry::builtin();
        let mut g = graph_with(
            &r,
            &[
                ("a", "heeler.image_source"),
                ("b", "heeler.image_source"),
                ("e", "heeler.exposure"),
            ],
        );
        g.connect("a", "out", "e", "in").unwrap();
        let err = g.connect("b", "out", "e", "in").unwrap_err();
        assert!(matches!(err, GraphError::InputOccupied { .. }));
    }

    #[test]
    fn cycle_rejected() {
        let r = Registry::builtin();
        let mut g = graph_with(
            &r,
            &[
                ("a", "heeler.exposure"),
                ("b", "heeler.exposure"),
                ("c", "heeler.exposure"),
            ],
        );
        g.connect("a", "out", "b", "in").unwrap();
        g.connect("b", "out", "c", "in").unwrap();
        assert_eq!(g.connect("c", "out", "a", "in"), Err(GraphError::CycleDetected));
    }

    #[test]
    fn self_connection_rejected() {
        let r = Registry::builtin();
        let mut g = graph_with(&r, &[("a", "heeler.exposure")]);
        assert_eq!(g.connect("a", "out", "a", "in"), Err(GraphError::SelfConnection));
    }

    #[test]
    fn remove_node_returns_attached_connections() {
        let r = Registry::builtin();
        let mut g = graph_with(
            &r,
            &[
                ("src", "heeler.image_source"),
                ("e", "heeler.exposure"),
                ("out", "heeler.output"),
            ],
        );
        g.connect("src", "out", "e", "in").unwrap();
        g.connect("e", "out", "out", "in").unwrap();
        let (node, removed) = g.remove_node("e").unwrap();
        assert_eq!(node.id, "e");
        assert_eq!(removed.len(), 2);
        assert_eq!(g.connections().len(), 0);
    }

    #[test]
    fn set_param_unknown_rejected() {
        let r = Registry::builtin();
        let mut g = graph_with(&r, &[("e", "heeler.exposure")]);
        let err = g.set_param("e", "nonsense", ParamValue::Number(1.0)).unwrap_err();
        assert!(matches!(err, GraphError::UnknownParam { .. }));
    }

    #[test]
    fn set_param_returns_old_value() {
        let r = Registry::builtin();
        let mut g = graph_with(&r, &[("e", "heeler.exposure")]);
        let old = g.set_param("e", "exposure", ParamValue::Number(1.5)).unwrap();
        assert_eq!(old, ParamValue::Number(0.0));
        assert_eq!(
            g.node("e").unwrap().params.get("exposure"),
            Some(&ParamValue::Number(1.5))
        );
    }

    #[test]
    fn topo_order_respects_dependencies() {
        let r = Registry::builtin();
        let mut g = graph_with(
            &r,
            &[
                ("z_src", "heeler.image_source"),
                ("m_exp", "heeler.exposure"),
                ("a_out", "heeler.output"),
            ],
        );
        g.connect("z_src", "out", "m_exp", "in").unwrap();
        g.connect("m_exp", "out", "a_out", "in").unwrap();
        let order = g.topo_order();
        let pos = |id: &str| order.iter().position(|n| n == id).unwrap();
        assert!(pos("z_src") < pos("m_exp"));
        assert!(pos("m_exp") < pos("a_out"));
        assert_eq!(order.len(), 3);
    }

    #[test]
    fn serialization_round_trip() {
        let r = Registry::builtin();
        let mut g = graph_with(
            &r,
            &[("src", "heeler.image_source"), ("e", "heeler.exposure")],
        );
        g.connect("src", "out", "e", "in").unwrap();
        g.set_param("e", "exposure", ParamValue::Number(0.7)).unwrap();
        g.set_position("e", 420.0, 180.0).unwrap();
        let json = serde_json::to_string_pretty(&g).unwrap();
        let back: Graph = serde_json::from_str(&json).unwrap();
        assert_eq!(g, back);
    }
}
