//! The signed `tab-blocklist` feed: the shared signed-policy feed
//! ([`policy_feed`]) with this feed's budget, cache, trust scope and error.
use super::unavailable;
use crate::domain::agents::providers::installed::managed::trust::ManagedTrustStore;
use crate::domain::marketplace::policy_feed::{self, Feed};
use crate::domain::plugin_tabs::managed::storage;
use crate::error::AppError;
use cadencr_registry_core::TabBlocklistEntry;
use std::path::Path;
use std::time::Duration;

pub(super) type Verified = policy_feed::Verified<TabBlocklistEntry>;

/// The cache is `<managed-tabs>/.tab-blocklist.json`: a dot-file, since the
/// root's other entries are tab ids.
pub(super) static FEED: Feed<TabBlocklistEntry> = Feed {
    label: "tab revocation policy",
    max_bytes: cadencr_registry_core::MAX_SIGNED_TAB_BLOCKLIST_BYTES,
    cache_file: ".tab-blocklist.json",
    prepare: cadencr_registry_core::prepare_tab_blocklist,
    baseline: ManagedTrustStore::authenticate_tab_policy_baseline,
    error: feed_error,
    secure: secure_root,
    poll_cadence: Duration::from_secs(10 * 60),
};

fn feed_error(message: String) -> AppError {
    unavailable(message)
}

fn secure_root(root: &Path) -> Result<(), AppError> {
    storage::secure(root, root)
}

#[cfg(test)]
mod tests {
    use super::super::tests::{resign_b, rotation_trust, signed, signed_with};
    use super::*;
    use chrono::Utc;
    use serde_json::json;
    use std::path::PathBuf;

    fn root() -> PathBuf {
        storage::root()
    }

    #[test]
    fn verifies_signature_domain_and_window() {
        let (envelope, trust) = signed(-1, json!([{"tab_id":"ports","reason":"unsafe"}]));
        let now = Utc::now();
        let verified = FEED.verify(&envelope, &trust, true, now).unwrap();
        assert!(verified.current_signer);
        let mut tampered = envelope.clone();
        tampered.signed["entries"][0]["reason"] = "changed".into();
        assert!(FEED.verify(&tampered, &trust, true, now).is_err());
        assert!(FEED.verify(&tampered, &trust, false, now).is_err());
        assert!(FEED
            .verify(&envelope, &ManagedTrustStore::default(), true, now)
            .is_err());
        let later = now + chrono::Duration::hours(2);
        assert!(FEED.verify(&envelope, &trust, true, later).is_err());
        assert!(FEED.verify(&envelope, &trust, false, later).is_ok());
        let mut wrong_domain = envelope;
        wrong_domain.signed["kind"] = "theme-blocklist".into();
        assert!(FEED.verify(&wrong_domain, &trust, false, now).is_err());
        assert!(FEED.parse(&vec![b' '; FEED.max_bytes + 1]).is_err());
    }

    #[test]
    fn rejects_rollback_and_equivocation_and_skips_exact_replay() {
        let root = root();
        let now = Utc::now();
        let (old, trust) = signed(-3, json!([]));
        FEED.ingest(&root, &old, &trust, now).unwrap();
        let bytes = std::fs::read(FEED.cache(&root)).unwrap();
        FEED.ingest(&root, &old, &trust, now).unwrap();
        assert_eq!(std::fs::read(FEED.cache(&root)).unwrap(), bytes);
        let (newer, _) = signed(-1, json!([{"tab_id":"ports","reason":"unsafe"}]));
        FEED.ingest(&root, &newer, &trust, now).unwrap();
        assert!(FEED.ingest(&root, &old, &trust, now).is_err(), "rollback");
        let mut equivocation = signed(-1, json!([])).0;
        equivocation.signed["generated_at"] = newer.signed["generated_at"].clone();
        let equivocation = signed_with(equivocation.signed, 19, "test");
        assert!(FEED.ingest(&root, &equivocation, &trust, now).is_err());
        let cached = FEED.cached(&root).unwrap().unwrap();
        assert!(policy_feed::same_envelope(&cached, &newer));
    }

    #[test]
    fn corrupt_or_symlinked_cache_is_never_replaced() {
        let root = root();
        let (envelope, trust) = signed(-1, json!([]));
        assert!(FEED.cached(&root).unwrap().is_none());
        storage::secure(&root, &root).unwrap();
        crate::shared::atomic_file::write_atomic_private(&FEED.cache(&root), "broken").unwrap();
        assert!(FEED.cached(&root).is_err());
        assert!(FEED.ingest(&root, &envelope, &trust, Utc::now()).is_err());
        assert_eq!(std::fs::read(FEED.cache(&root)).unwrap(), b"broken");
        #[cfg(unix)]
        {
            std::fs::remove_file(FEED.cache(&root)).unwrap();
            std::os::unix::fs::symlink(root.join("elsewhere"), FEED.cache(&root)).unwrap();
            assert!(FEED.ingest(&root, &envelope, &trust, Utc::now()).is_err());
            assert!(FEED.cache(&root).symlink_metadata().unwrap().is_symlink());
        }
    }

    #[test]
    fn retired_signer_is_a_baseline_never_current_authority() {
        let root = root();
        let now = Utc::now();
        let (old, original) = signed(-3, json!([]));
        FEED.ingest(&root, &old, &original, now).unwrap();
        let rotated = rotation_trust(now - chrono::Duration::minutes(1), false, vec![]);
        assert!(FEED.verify(&old, &rotated, true, now).is_err());
        let baseline = FEED.verify(&old, &rotated, false, now).unwrap();
        assert!(!baseline.current_signer);
        let renewed = resign_b(old.clone());
        FEED.ingest(&root, &renewed, &rotated, now).unwrap();
        assert_eq!(
            FEED.cached(&root).unwrap().unwrap().signature.key_id,
            "current-b"
        );
        let (older, _) = signed(-4, json!([]));
        assert!(FEED.ingest(&root, &resign_b(older), &rotated, now).is_err());
    }

    #[test]
    fn compromised_signer_needs_a_tab_scoped_recovery_checkpoint() {
        let root = root();
        let now = Utc::now();
        let (old, original) = signed(-3, json!([]));
        FEED.ingest(&root, &old, &original, now).unwrap();
        let digest = cadencr_registry_core::VerifiedRegistryTrust::catalog_digest(
            &serde_json::to_value(&old).unwrap(),
        );
        let renewed = resign_b(old.clone());
        assert!(FEED
            .ingest(&root, &renewed, &rotation_trust(now, true, vec![]), now)
            .is_err());
        let approved = rotation_trust(now, true, vec![digest]);
        assert!(FEED.verify(&old, &approved, true, now).is_err());
        FEED.verify(&old, &approved, false, now).unwrap();
        FEED.ingest(&root, &renewed, &approved, now).unwrap();
        FEED.verify(&FEED.cached(&root).unwrap().unwrap(), &approved, true, now)
            .unwrap();
    }
}
