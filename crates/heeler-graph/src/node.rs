use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

use crate::ports::PortSpec;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Section {
    RawFoundation,
    Creative,
    Retouch,
    Output,
}

/// Untagged so params serialize as plain JSON scalars.
/// Bool must come before Number so `true` is not read as a number.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum ParamValue {
    Bool(bool),
    Number(f64),
    Text(String),
}

impl ParamValue {
    pub fn as_f64(&self) -> Option<f64> {
        match self {
            ParamValue::Number(n) => Some(*n),
            _ => None,
        }
    }

    pub fn as_bool(&self) -> Option<bool> {
        match self {
            ParamValue::Bool(b) => Some(*b),
            _ => None,
        }
    }

    pub fn as_str(&self) -> Option<&str> {
        match self {
            ParamValue::Text(s) => Some(s),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Node {
    pub id: String,
    #[serde(rename = "type")]
    pub node_type: String,
    pub version: u32,
    pub label: String,
    pub section: Section,
    pub enabled: bool,
    pub params: BTreeMap<String, ParamValue>,
    pub inputs: Vec<PortSpec>,
    pub outputs: Vec<PortSpec>,
}

impl Node {
    pub fn input(&self, name: &str) -> Option<&PortSpec> {
        self.inputs.iter().find(|p| p.name == name)
    }

    pub fn output(&self, name: &str) -> Option<&PortSpec> {
        self.outputs.iter().find(|p| p.name == name)
    }

    /// Canonical string of the parameters, used in cache keys.
    /// BTreeMap keeps key order stable.
    pub fn params_canonical(&self) -> String {
        serde_json::to_string(&self.params).expect("params always serialize")
    }
}
