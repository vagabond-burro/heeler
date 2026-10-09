use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum PortKind {
    Image,
    Mask,
    Channel,
}

impl PortKind {
    /// Mask and Channel are both single-channel float and interchangeable.
    /// Image only connects to Image; converting an image to a mask requires
    /// an explicit node (Luminance Extract or Channel).
    pub fn accepts(self, from: PortKind) -> bool {
        match self {
            PortKind::Image => from == PortKind::Image,
            PortKind::Mask | PortKind::Channel => {
                matches!(from, PortKind::Mask | PortKind::Channel)
            }
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PortSpec {
    pub name: String,
    pub kind: PortKind,
    #[serde(default)]
    pub optional: bool,
}

impl PortSpec {
    pub fn new(name: &str, kind: PortKind, optional: bool) -> Self {
        PortSpec {
            name: name.to_string(),
            kind,
            optional,
        }
    }
}
