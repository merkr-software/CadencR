//! Independent signed channels have independent monotonic cache histories.
//! Historical receipts and the legacy cache are retained during client upgrades.
use std::path::{Path, PathBuf};

pub fn path(root: &Path, source: Option<&str>) -> PathBuf {
    // Source-less compatible clients still use the current channel, never the
    // legacy high-water/cache as an administrative admission fallback.
    let administrative = source
        .is_none_or(|url| url.ends_with("/refs/heads/marketplace-v2-admin/managed-index.json"));
    root.join(if administrative {
        "administrative-catalog.json"
    } else {
        "catalog.json"
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn newer_legacy_cache_is_never_the_administrative_high_water_or_fallback() {
        let root = tempfile::tempdir().unwrap();
        let legacy = path(root.path(), Some("https://raw.githubusercontent.com/o/r/refs/heads/marketplace-v2/managed-index.json"));
        let administrative = path(root.path(), Some("https://raw.githubusercontent.com/o/r/refs/heads/marketplace-v2-admin/managed-index.json"));
        std::fs::write(&legacy, "later legacy generation").unwrap();
        assert_ne!(legacy, administrative);
        assert!(!administrative.exists());
        std::fs::write(&administrative, "earlier current administrative generation").unwrap();
        assert_eq!(
            std::fs::read_to_string(&legacy).unwrap(),
            "later legacy generation"
        );
        assert_eq!(path(root.path(), None), administrative);
    }
}
