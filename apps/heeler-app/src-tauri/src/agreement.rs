//! The acceptance receipt's format: what the Assistant's disclaimer
//! writes when it is accepted (src/assistant.rs).
//!
//! Nothing here reaches the network and nothing here is sent anywhere.
//! The device is named by the machine fingerprint, a sha256 over stable
//! machine identity that carries none of its components.

use serde::Serialize;

/// The receipt, read back: which document, which version of it, when,
/// and on what.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Acceptance {
    pub document: String,
    pub version: String,
    pub unix_time: i64,
    pub fingerprint: String,
}

pub(crate) fn now() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

/// Renders the receipt.
///
/// A plain text file of `key: value` lines under a sentence. It is a
/// legal record, so the first thing it has to survive is being opened
/// by a person who has never seen it before: the header sentence says
/// what the file is, and the fields below say it again in a form this
/// module can read back.
pub(crate) fn render(doc: &str, version: &str, unix_time: i64, fingerprint: &str) -> String {
    format!(
        "{doc} accepted\n\
         document: {doc}\n\
         version: {version}\n\
         unix_time: {unix_time}\n\
         fingerprint: {fingerprint}\n"
    )
}

/// Reads a receipt back, or None if it is absent, truncated, or was
/// written by something else.
///
/// Total on purpose: every failure here means "not accepted", which
/// asks again. That is the safe direction. The opposite
/// mistake, treating an unreadable file as consent, would record an
/// agreement nobody made.
pub(crate) fn parse(text: &str) -> Option<Acceptance> {
    let mut document = None;
    let mut version = None;
    let mut unix_time = None;
    let mut fingerprint = None;
    for line in text.lines() {
        let Some((key, value)) = line.split_once(": ") else { continue };
        let value = value.trim().to_string();
        if value.is_empty() {
            continue;
        }
        match key.trim() {
            "document" => document = Some(value),
            "version" => version = Some(value),
            "unix_time" => unix_time = value.parse::<i64>().ok(),
            "fingerprint" => fingerprint = Some(value),
            _ => {}
        }
    }
    Some(Acceptance {
        document: document?,
        version: version?,
        unix_time: unix_time?,
        fingerprint: fingerprint?,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// What is written is what comes back, field for field.
    #[test]
    fn a_receipt_round_trips() {
        let text = render("Assistant notice", "2026-08-28", 1_756_339_200, "abc123");
        let back = parse(&text).expect("a receipt this module wrote");
        assert_eq!(back.document, "Assistant notice");
        assert_eq!(back.version, "2026-08-28");
        assert_eq!(back.unix_time, 1_756_339_200);
        assert_eq!(back.fingerprint, "abc123");
        // The header sentence is for whoever opens the file, and must
        // not be mistaken for one of the fields.
        assert!(text.starts_with("Assistant notice accepted\n"));
    }

    /// Every way a receipt can fail to be one reads as "not accepted",
    /// which asks again rather than assuming consent.
    #[test]
    fn a_damaged_receipt_is_no_receipt() {
        for text in [
            "",
            "Assistant notice accepted\n",
            // Truncated mid-write: the fingerprint never landed.
            "document: notice\nversion: 2026-08-28\nunix_time: 1\n",
            // A version line with nothing after it is not a version.
            "document: notice\nversion: \nunix_time: 1\nfingerprint: a\n",
            // A date that is not one.
            "document: notice\nversion: 2026-08-28\nunix_time: soon\nfingerprint: a\n",
        ] {
            assert!(parse(text).is_none(), "accepted a damaged receipt: {text:?}");
        }
    }

    /// Unknown lines are ignored rather than fatal, so a later version
    /// of this file can add a field without invalidating every receipt
    /// already on disk.
    #[test]
    fn an_unknown_field_does_not_spoil_a_receipt() {
        let text = "document: notice\nversion: 2026-08-28\nunix_time: 1\nfingerprint: a\nseat: 3\n";
        assert_eq!(parse(text).expect("still a receipt").version, "2026-08-28");
    }
}
