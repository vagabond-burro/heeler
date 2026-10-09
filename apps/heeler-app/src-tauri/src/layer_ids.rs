//! The persisted Develop identity grammar, checked against the frontend fixture.

pub(crate) fn is_layer_node(id: &str) -> bool {
    let rest = id.strip_prefix("layer_");
    match rest {
        Some(r) => r.find('_')
            .map(|i| !r[..i].is_empty() && r[..i].chars().all(|c| c.is_ascii_digit()))
            .unwrap_or(false),
        None => false,
    }
}

/// Whether an id is a Develop layer's own node, `layer_<digits>_adj`:
/// the node that carries the layer's name, its switch and its Opacity.
pub(crate) fn is_layer_adj(id: &str) -> bool {
    id.strip_prefix("layer_")
        .and_then(|r| r.strip_suffix("_adj"))
        .is_some_and(|n| !n.is_empty() && n.chars().all(|c| c.is_ascii_digit()))
}

