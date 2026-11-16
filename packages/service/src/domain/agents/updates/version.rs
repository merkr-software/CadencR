//! Version ordering for the native CLI updaters.

/// Whether `latest` should be offered over `current`. Numeric triples decide.
/// On a tie, an installed suffixed build (`2026.10.14-0f9edde`, `1.0.0-beta.1`)
/// is replaced by any different build of the same triple: the release feed
/// only ever names its newest build. Unparseable versions are never offered —
/// a wrong prompt is worse than none.
pub fn is_newer(latest: &str, current: &str) -> bool {
    let (Some(latest_key), Some(current_key)) = (
        cli_discovery::parse_version_string(latest),
        cli_discovery::parse_version_string(current),
    ) else {
        return false;
    };
    latest_key > current_key
        || (latest_key == current_key && latest != current && current.contains('-'))
}

#[cfg(test)]
mod tests {
    use super::is_newer;

    #[test]
    fn compares_numeric_triples_and_builds() {
        assert!(is_newer("2.1.300", "2.1.299"));
        assert!(is_newer("0.10.0", "0.9.9"));
        assert!(is_newer("2026.10.14-0f9edde", "2026.08.25-3e8eec8"));
        assert!(is_newer("2026.10.14-0f9edde", "2026.10.14-3e8eec8"));
        assert!(is_newer("1.0.0", "1.0.0-beta.1"));
        assert!(!is_newer("1.0.0-beta.1", "1.0.0"));
        assert!(!is_newer("2.1.299", "2.1.299"));
        assert!(!is_newer("2.1.298", "2.1.299"));
        assert!(!is_newer("garbage", "1.0.0"));
    }
}
