/// Only the packaging scripts opt into an identity. An old pair exported
/// in a shell must not silently label a hand build as a shipped build.
pub fn identity(stamped: Option<&str>, number: Option<&str>, hash: Option<&str>) -> (String, String) {
    if stamped != Some("1") {
        return ("dev".into(), "dev".into());
    }
    let number = number.unwrap_or("").trim();
    let hash = hash.unwrap_or("").trim();
    if (!number.is_empty() && number.bytes().all(|b| b.is_ascii_digit())
        && hash.len() >= 7 && hash.bytes().all(|b| b.is_ascii_hexdigit()))
        || (number == "unknown" && hash == "unknown")
    {
        (number.into(), hash.into())
    } else {
        ("unknown".into(), "unknown".into())
    }
}

#[cfg(test)]
mod tests {
    use super::identity;
    #[test]
    fn ambient_values_are_not_a_packaging_stamp() {
        for pair in [(None, None), (Some("123"), None), (None, Some("abcdef0")), (Some("123"), Some("abcdef0"))] {
            assert_eq!(identity(None, pair.0, pair.1), ("dev".into(), "dev".into()));
        }
    }
    #[test]
    fn an_explicit_stamp_is_atomic_and_source_archives_still_build() {
        assert_eq!(identity(Some("1"), Some(" 123 "), Some(" abcdef0 ")), ("123".into(), "abcdef0".into()));
        for pair in [(None, None), (Some("123"), None), (Some("bad"), Some("abcdef0")), (Some("unknown"), Some("unknown"))] {
            assert_eq!(identity(Some("1"), pair.0, pair.1), ("unknown".into(), "unknown".into()));
        }
    }
}
