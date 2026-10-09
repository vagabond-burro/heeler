use thiserror::Error;

#[derive(Debug, Error, PartialEq)]
pub enum GraphError {
    #[error("node '{0}' already exists")]
    NodeExists(String),
    #[error("node '{0}' not found")]
    NodeNotFound(String),
    #[error("port '{port}' not found on node '{node}'")]
    PortNotFound { node: String, port: String },
    #[error("cannot connect {from_kind:?} output to {to_kind:?} input")]
    IncompatiblePorts {
        from_kind: crate::ports::PortKind,
        to_kind: crate::ports::PortKind,
    },
    #[error("input '{port}' on node '{node}' already has a connection")]
    InputOccupied { node: String, port: String },
    #[error("connection would create a cycle")]
    CycleDetected,
    #[error("a node cannot connect to itself")]
    SelfConnection,
    #[error("no connection into '{port}' on node '{node}'")]
    ConnectionNotFound { node: String, port: String },
    #[error("unknown node type '{0}'")]
    UnknownNodeType(String),
    #[error("unknown parameter '{param}' for node type '{node_type}'")]
    UnknownParam { node_type: String, param: String },
    #[error("parameter '{param}' expects a {expected} value")]
    ParamTypeMismatch { param: String, expected: String },
}
