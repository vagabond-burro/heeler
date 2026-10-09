//! The single mutation path for Heeler graphs.
//!
//! Every change to a graph, whether it comes from the UI, the AI assistant,
//! batch processing, or a future scripting API, is a [`Command`] applied
//! through a [`CommandProcessor`]. That gives undo/redo, crash-recovery
//! journaling, and AI change-sets one shared mechanism.

use serde::{Deserialize, Serialize};

use heeler_graph::{Connection, Graph, GraphError, Node, ParamValue, Registry, Section};

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum Command {
    CreateNode {
        node_type: String,
        node_id: String,
        section: Section,
    },
    DeleteNode {
        node_id: String,
    },
    /// Inverse of DeleteNode: puts back the exact node and its connections.
    RestoreNode {
        node: Node,
        connections: Vec<Connection>,
    },
    SetParam {
        node_id: String,
        param: String,
        value: ParamValue,
    },
    SetEnabled {
        node_id: String,
        enabled: bool,
    },
    RenameNode {
        node_id: String,
        label: String,
    },
    Connect {
        from_node: String,
        from_port: String,
        to_node: String,
        to_port: String,
    },
    Disconnect {
        to_node: String,
        to_port: String,
    },
    /// Applied atomically: if any inner command fails, the ones already
    /// applied are rolled back and the whole batch reports the error.
    Batch {
        commands: Vec<Command>,
    },
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "entry", rename_all = "snake_case")]
pub enum JournalEntry {
    Do { command: Command },
    Undo,
    Redo,
}

#[derive(Debug, thiserror::Error, PartialEq)]
pub enum CommandError {
    #[error(transparent)]
    Graph(#[from] GraphError),
    #[error("nothing to undo")]
    NothingToUndo,
    #[error("nothing to redo")]
    NothingToRedo,
}

pub struct CommandProcessor<'r> {
    graph: Graph,
    registry: &'r Registry,
    undo_stack: Vec<Command>,
    redo_stack: Vec<Command>,
    journal: Vec<JournalEntry>,
}

impl<'r> CommandProcessor<'r> {
    pub fn new(graph: Graph, registry: &'r Registry) -> Self {
        CommandProcessor {
            graph,
            registry,
            undo_stack: Vec::new(),
            redo_stack: Vec::new(),
            journal: Vec::new(),
        }
    }

    pub fn graph(&self) -> &Graph {
        &self.graph
    }

    pub fn into_graph(self) -> Graph {
        self.graph
    }

    pub fn journal(&self) -> &[JournalEntry] {
        &self.journal
    }

    pub fn can_undo(&self) -> bool {
        !self.undo_stack.is_empty()
    }

    pub fn can_redo(&self) -> bool {
        !self.redo_stack.is_empty()
    }

    pub fn apply(&mut self, command: Command) -> Result<(), CommandError> {
        let inverse = self.apply_internal(&command)?;
        self.undo_stack.push(inverse);
        self.redo_stack.clear();
        self.journal.push(JournalEntry::Do { command });
        Ok(())
    }

    pub fn undo(&mut self) -> Result<(), CommandError> {
        let inverse = self.undo_stack.pop().ok_or(CommandError::NothingToUndo)?;
        let redo = self.apply_internal(&inverse).expect("inverse of an applied command must apply");
        self.redo_stack.push(redo);
        self.journal.push(JournalEntry::Undo);
        Ok(())
    }

    pub fn redo(&mut self) -> Result<(), CommandError> {
        let command = self.redo_stack.pop().ok_or(CommandError::NothingToRedo)?;
        let inverse = self.apply_internal(&command).expect("redo of an undone command must apply");
        self.undo_stack.push(inverse);
        self.journal.push(JournalEntry::Redo);
        Ok(())
    }

    /// Rebuilds a processor from a persisted journal, for crash recovery.
    pub fn replay(
        graph_id: &str,
        registry: &'r Registry,
        journal: &[JournalEntry],
    ) -> Result<Self, CommandError> {
        let mut proc = CommandProcessor::new(Graph::new(graph_id), registry);
        for entry in journal {
            match entry {
                JournalEntry::Do { command } => proc.apply(command.clone())?,
                JournalEntry::Undo => proc.undo()?,
                JournalEntry::Redo => proc.redo()?,
            }
        }
        Ok(proc)
    }

    fn apply_internal(&mut self, command: &Command) -> Result<Command, CommandError> {
        match command {
            Command::CreateNode {
                node_type,
                node_id,
                section,
            } => {
                let node = self.registry.instantiate(node_type, node_id, *section)?;
                self.graph.add_node(node)?;
                Ok(Command::DeleteNode {
                    node_id: node_id.clone(),
                })
            }
            Command::DeleteNode { node_id } => {
                let (node, connections) = self.graph.remove_node(node_id)?;
                Ok(Command::RestoreNode { node, connections })
            }
            Command::RestoreNode { node, connections } => {
                let node_id = node.id.clone();
                self.graph.add_node(node.clone())?;
                for c in connections {
                    self.graph.connect(&c.from.0, &c.from.1, &c.to.0, &c.to.1)?;
                }
                Ok(Command::DeleteNode { node_id })
            }
            Command::SetParam {
                node_id,
                param,
                value,
            } => {
                let node = self
                    .graph
                    .node(node_id)
                    .ok_or_else(|| GraphError::NodeNotFound(node_id.clone()))?;
                let clamped = self.registry.clamp(&node.node_type, param, value.clone())?;
                let old = self.graph.set_param(node_id, param, clamped)?;
                Ok(Command::SetParam {
                    node_id: node_id.clone(),
                    param: param.clone(),
                    value: old,
                })
            }
            Command::SetEnabled { node_id, enabled } => {
                let old = self.graph.set_enabled(node_id, *enabled)?;
                Ok(Command::SetEnabled {
                    node_id: node_id.clone(),
                    enabled: old,
                })
            }
            Command::RenameNode { node_id, label } => {
                let old = self.graph.set_label(node_id, label)?;
                Ok(Command::RenameNode {
                    node_id: node_id.clone(),
                    label: old,
                })
            }
            Command::Connect {
                from_node,
                from_port,
                to_node,
                to_port,
            } => {
                self.graph.connect(from_node, from_port, to_node, to_port)?;
                Ok(Command::Disconnect {
                    to_node: to_node.clone(),
                    to_port: to_port.clone(),
                })
            }
            Command::Disconnect { to_node, to_port } => {
                let removed = self.graph.disconnect(to_node, to_port)?;
                Ok(Command::Connect {
                    from_node: removed.from.0,
                    from_port: removed.from.1,
                    to_node: removed.to.0,
                    to_port: removed.to.1,
                })
            }
            Command::Batch { commands } => {
                let mut inverses: Vec<Command> = Vec::with_capacity(commands.len());
                for cmd in commands {
                    match self.apply_internal(cmd) {
                        Ok(inv) => inverses.push(inv),
                        Err(e) => {
                            for inv in inverses.into_iter().rev() {
                                self.apply_internal(&inv)
                                    .expect("rollback of applied commands must succeed");
                            }
                            return Err(e);
                        }
                    }
                }
                inverses.reverse();
                Ok(Command::Batch { commands: inverses })
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn processor(registry: &Registry) -> CommandProcessor<'_> {
        CommandProcessor::new(Graph::new("test"), registry)
    }

    fn create(node_type: &str, node_id: &str) -> Command {
        Command::CreateNode {
            node_type: node_type.into(),
            node_id: node_id.into(),
            section: Section::Creative,
        }
    }

    #[test]
    fn create_then_undo_then_redo() {
        let r = Registry::builtin();
        let mut p = processor(&r);
        p.apply(create("heeler.exposure", "e1")).unwrap();
        assert!(p.graph().node("e1").is_some());

        p.undo().unwrap();
        assert!(p.graph().node("e1").is_none());

        p.redo().unwrap();
        assert!(p.graph().node("e1").is_some());
    }

    #[test]
    fn set_param_clamps_to_hard_limits_and_undoes() {
        // The house rule: sliders stop where taste stops, typing stops
        // where physics stops. 12 EV is past the slider but legal; a
        // negative radius is not a radius anywhere.
        let r = Registry::builtin();
        let mut p = processor(&r);
        p.apply(create("heeler.exposure", "e1")).unwrap();
        p.apply(Command::SetParam {
            node_id: "e1".into(),
            param: "exposure".into(),
            value: ParamValue::Number(12.0),
        })
        .unwrap();
        assert_eq!(
            p.graph().node("e1").unwrap().params.get("exposure"),
            Some(&ParamValue::Number(12.0)),
            "12 EV exceeds the slider, not the physics"
        );
        p.undo().unwrap();
        assert_eq!(
            p.graph().node("e1").unwrap().params.get("exposure"),
            Some(&ParamValue::Number(0.0))
        );

        p.apply(create("heeler.blur", "b1")).unwrap();
        p.apply(Command::SetParam {
            node_id: "b1".into(),
            param: "radius".into(),
            value: ParamValue::Number(-3.0),
        })
        .unwrap();
        assert_eq!(
            p.graph().node("b1").unwrap().params.get("radius"),
            Some(&ParamValue::Number(0.0)),
            "a negative radius clamps at the physical floor"
        );
    }

    #[test]
    fn set_param_unknown_param_fails_without_side_effects() {
        let r = Registry::builtin();
        let mut p = processor(&r);
        p.apply(create("heeler.exposure", "e1")).unwrap();
        let before = p.graph().clone();
        let err = p
            .apply(Command::SetParam {
                node_id: "e1".into(),
                param: "sparkle".into(),
                value: ParamValue::Number(1.0),
            })
            .unwrap_err();
        assert!(matches!(err, CommandError::Graph(GraphError::UnknownParam { .. })));
        assert_eq!(p.graph(), &before);
        assert!(!p.can_undo() || p.journal().len() == 1);
    }

    #[test]
    fn delete_node_undo_restores_connections() {
        let r = Registry::builtin();
        let mut p = processor(&r);
        p.apply(create("heeler.image_source", "src")).unwrap();
        p.apply(create("heeler.exposure", "e1")).unwrap();
        p.apply(create("heeler.output", "out")).unwrap();
        p.apply(Command::Connect {
            from_node: "src".into(),
            from_port: "out".into(),
            to_node: "e1".into(),
            to_port: "in".into(),
        })
        .unwrap();
        p.apply(Command::Connect {
            from_node: "e1".into(),
            from_port: "out".into(),
            to_node: "out".into(),
            to_port: "in".into(),
        })
        .unwrap();

        p.apply(Command::DeleteNode { node_id: "e1".into() }).unwrap();
        assert!(p.graph().node("e1").is_none());
        assert_eq!(p.graph().connections().len(), 0);

        p.undo().unwrap();
        assert!(p.graph().node("e1").is_some());
        assert_eq!(p.graph().connections().len(), 2);
        assert!(p.graph().incoming("e1", "in").is_some());
        assert!(p.graph().incoming("out", "in").is_some());
    }

    #[test]
    fn connect_disconnect_are_inverses() {
        let r = Registry::builtin();
        let mut p = processor(&r);
        p.apply(create("heeler.image_source", "src")).unwrap();
        p.apply(create("heeler.exposure", "e1")).unwrap();
        p.apply(Command::Connect {
            from_node: "src".into(),
            from_port: "out".into(),
            to_node: "e1".into(),
            to_port: "in".into(),
        })
        .unwrap();
        p.undo().unwrap();
        assert_eq!(p.graph().connections().len(), 0);
        p.redo().unwrap();
        assert_eq!(p.graph().connections().len(), 1);
    }

    #[test]
    fn new_command_clears_redo_stack() {
        let r = Registry::builtin();
        let mut p = processor(&r);
        p.apply(create("heeler.exposure", "e1")).unwrap();
        p.undo().unwrap();
        assert!(p.can_redo());
        p.apply(create("heeler.levels", "l1")).unwrap();
        assert!(!p.can_redo());
        assert_eq!(p.redo().unwrap_err(), CommandError::NothingToRedo);
    }

    #[test]
    fn rename_round_trips() {
        let r = Registry::builtin();
        let mut p = processor(&r);
        p.apply(create("heeler.exposure", "e1")).unwrap();
        p.apply(Command::RenameNode {
            node_id: "e1".into(),
            label: "Brighten face".into(),
        })
        .unwrap();
        assert_eq!(p.graph().node("e1").unwrap().label, "Brighten face");
        p.undo().unwrap();
        assert_eq!(p.graph().node("e1").unwrap().label, "Exposure");
    }

    #[test]
    fn batch_applies_atomically_and_undoes_as_one() {
        let r = Registry::builtin();
        let mut p = processor(&r);
        p.apply(Command::Batch {
            commands: vec![
                create("heeler.image_source", "src"),
                create("heeler.exposure", "e1"),
                Command::Connect {
                    from_node: "src".into(),
                    from_port: "out".into(),
                    to_node: "e1".into(),
                    to_port: "in".into(),
                },
                Command::SetParam {
                    node_id: "e1".into(),
                    param: "exposure".into(),
                    value: ParamValue::Number(0.7),
                },
            ],
        })
        .unwrap();
        assert_eq!(p.graph().node_count(), 2);
        assert_eq!(p.graph().connections().len(), 1);

        p.undo().unwrap();
        assert_eq!(p.graph().node_count(), 0);
        assert_eq!(p.graph().connections().len(), 0);
    }

    #[test]
    fn failed_batch_rolls_back_completely() {
        let r = Registry::builtin();
        let mut p = processor(&r);
        p.apply(create("heeler.image_source", "src")).unwrap();
        let before = p.graph().clone();
        let err = p.apply(Command::Batch {
            commands: vec![
                create("heeler.exposure", "e1"),
                create("heeler.exposure", "src"), // duplicate id, must fail
            ],
        });
        assert!(err.is_err());
        assert_eq!(p.graph(), &before, "partial batch must leave no trace");
    }

    #[test]
    fn journal_replay_reproduces_graph() {
        let r = Registry::builtin();
        let mut p = processor(&r);
        p.apply(create("heeler.image_source", "src")).unwrap();
        p.apply(create("heeler.exposure", "e1")).unwrap();
        p.apply(Command::Connect {
            from_node: "src".into(),
            from_port: "out".into(),
            to_node: "e1".into(),
            to_port: "in".into(),
        })
        .unwrap();
        p.apply(Command::SetParam {
            node_id: "e1".into(),
            param: "exposure".into(),
            value: ParamValue::Number(1.2),
        })
        .unwrap();
        p.undo().unwrap();
        p.redo().unwrap();
        p.apply(Command::SetEnabled {
            node_id: "e1".into(),
            enabled: false,
        })
        .unwrap();
        p.undo().unwrap();

        let replayed = CommandProcessor::replay("test", &r, p.journal()).unwrap();
        assert_eq!(replayed.graph(), p.graph());
    }

    #[test]
    fn commands_serialize_round_trip() {
        let cmd = Command::Batch {
            commands: vec![
                create("heeler.exposure", "e1"),
                Command::SetParam {
                    node_id: "e1".into(),
                    param: "exposure".into(),
                    value: ParamValue::Number(0.7),
                },
            ],
        };
        let json = serde_json::to_string(&cmd).unwrap();
        let back: Command = serde_json::from_str(&json).unwrap();
        assert_eq!(cmd, back);
    }
}
