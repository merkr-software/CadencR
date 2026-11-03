//! LSP-specific signed revocations; offline launches use the last current verified policy.
use super::{invalid, storage};
use crate::domain::agents::providers::installed::managed::trust::{
    pinned_index_trust_store, ManagedTrustStore,
};
use crate::domain::themes::managed::{
    catalog,
    policy_feed::{Feed, PollState, Verified},
};
use crate::error::AppError;
use cadencr_registry_core::{LspBlocklistEntry, LspTarget};
use chrono::Utc;
use std::{
    sync::OnceLock,
    time::{Duration, Instant},
};

static FEED: Feed<LspBlocklistEntry> = Feed {
    label: "LSP revocation policy",
    max_bytes: cadencr_registry_core::MAX_SIGNED_LSP_BLOCKLIST_BYTES,
    cache_file: ".lsp-blocklist.json",
    prepare: cadencr_registry_core::prepare_lsp_blocklist,
    baseline: ManagedTrustStore::authenticate_lsp_policy_baseline,
    error: unavailable,
    secure: storage::secure,
    poll_cadence: Duration::from_secs(600),
};
fn unavailable(message: String) -> AppError {
    AppError::coded(
        axum::http::StatusCode::CONFLICT,
        "LSP_POLICY_UNAVAILABLE",
        message,
    )
}
fn source() -> Option<&'static str> {
    #[cfg(test)]
    if tests::configured() {
        return Some("https://example.invalid/lsp-policy");
    }
    option_env!("CADENCR_MANAGED_LSP_BLOCKLIST_URL").filter(|value| !value.trim().is_empty())
}
pub async fn refresh(force: bool) -> Result<(), AppError> {
    let Some(url) = source() else {
        return Err(unavailable(
            "LSP installation is unavailable: this build has no LSP revocation feed".into(),
        ));
    };
    static POLL: OnceLock<tokio::sync::Mutex<PollState>> = OnceLock::new();
    let requested = Instant::now();
    let mut poll = POLL.get_or_init(Default::default).lock().await;
    if !poll.needs_poll(FEED.poll_cadence, force, requested) {
        return Ok(());
    }
    let root = storage::root()?;
    let result = match catalog::download(url, FEED.max_bytes).await {
        Err(error) => Err(error),
        Ok(bytes) => {
            FEED.offload(move || {
                let envelope = FEED.parse(&bytes)?;
                FEED.ingest(&root, &envelope, &pinned_index_trust_store(), Utc::now())
                    .map(drop)
            })
            .await
        }
    };
    poll.completed = Some(Instant::now());
    poll.failure = result.as_ref().err().map(ToString::to_string);
    result
}
pub fn require_install(id: &str, version: &str, target: &LspTarget) -> Result<(), AppError> {
    snapshot()?.require_install(id, version, target)
}
pub fn require(id: &str, version: &str, target: &LspTarget) -> Result<(), AppError> {
    snapshot()?.require(id, version, target)
}

pub(super) struct PolicySnapshot(Option<Verified<LspBlocklistEntry>>);

/// One authenticated view per evaluation; mutations and launches acquire their own fresh view.
pub(super) fn snapshot() -> Result<PolicySnapshot, AppError> {
    if source().is_none() {
        return Ok(PolicySnapshot(None));
    }
    #[cfg(test)]
    let (root, trust) = tests::context().unwrap_or((storage::root()?, pinned_index_trust_store()));
    #[cfg(not(test))]
    let (root, trust) = (storage::root()?, pinned_index_trust_store());
    let now = Utc::now();
    let envelope = FEED
        .cached(&root)?
        .ok_or_else(|| unavailable("No verified LSP revocation policy is cached".into()))?;
    FEED.verify(&envelope, &trust, false, now)
        .map(|policy| PolicySnapshot(Some(policy)))
}

impl PolicySnapshot {
    pub(super) fn require_install(
        &self,
        id: &str,
        version: &str,
        target: &LspTarget,
    ) -> Result<(), AppError> {
        if self.0.is_none() {
            return Err(unavailable(
                "LSP installation is unavailable: this build has no LSP revocation feed".into(),
            ));
        }
        self.require(id, version, target)
    }
    fn require(&self, id: &str, version: &str, target: &LspTarget) -> Result<(), AppError> {
        let Some(policy) = &self.0 else {
            return Ok(());
        };
        if let Some(reason) = policy
            .policy
            .blocked_reason(id, version, &target.sha256, Some(&target.entry_sha256))
            .map_err(invalid)?
        {
            return Err(AppError::coded(
                axum::http::StatusCode::FORBIDDEN,
                "LSP_BLOCKED",
                format!("LSP {id} is blocked: {reason}"),
            ));
        }
        if !policy.current_signer || policy.expires_at <= Utc::now() {
            return Err(unavailable(
                "LSP revocation policy is out of date; refresh the marketplace".into(),
            ));
        }
        Ok(())
    }
}

#[cfg(test)]
pub(super) mod tests {
    use super::*;
    use serde_json::Value;
    use std::path::PathBuf;
    thread_local! {
        static CONTEXT: std::cell::RefCell<Option<(PathBuf,ManagedTrustStore)>> = const { std::cell::RefCell::new(None) };
    }
    pub struct Guard(Option<(PathBuf, ManagedTrustStore)>);
    impl Drop for Guard {
        fn drop(&mut self) {
            CONTEXT.with(|slot| slot.replace(self.0.take()));
        }
    }
    pub fn configured() -> bool {
        CONTEXT.with(|slot| slot.borrow().is_some())
    }
    pub fn context() -> Option<(PathBuf, ManagedTrustStore)> {
        CONTEXT.with(|slot| slot.borrow().clone())
    }
    pub fn configure(root: &std::path::Path, entries: Value) -> Guard {
        let (mut envelope, trust) = crate::domain::themes::managed::policy_feed::tests::signed(
            "lsp-blocklist",
            -1,
            entries,
        );
        storage::secure(root).unwrap();
        if let Some(previous) = FEED.cached(root).unwrap() {
            let generated = chrono::DateTime::parse_from_rfc3339(
                previous.signed["generated_at"].as_str().unwrap(),
            )
            .unwrap()
                + chrono::Duration::seconds(1);
            envelope.signed["generated_at"] = generated
                .to_rfc3339_opts(chrono::SecondsFormat::Secs, true)
                .into();
            envelope = crate::domain::themes::managed::policy_feed::tests::signed_with(
                envelope.signed,
                19,
                "test",
            );
        }
        FEED.ingest(root, &envelope, &trust, Utc::now()).unwrap();
        Guard(CONTEXT.with(|slot| slot.replace(Some((root.to_path_buf(), trust)))))
    }
    #[test]
    fn signed_policy_blocks_matching_digest_and_expiry_fails_closed() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("lsp");
        let target = cadencr_registry_core::LspTarget {
            archive: "https://github.com/acme/lsp/releases/download/v1/lsp.tar.gz".into(),
            sha256: "a".repeat(64),
            size: 1,
            entry: "server.js".into(),
            entry_sha256: "b".repeat(64),
            entry_size: 1,
            runtime: cadencr_registry_core::LspRuntime::Node,
        };
        let _guard = configure(
            &root,
            serde_json::json!([{"lsp_id":"fixture","archive_sha256":"a".repeat(64),"reason":"unsafe fixture"}]),
        );
        assert!(matches!(
            require_install("fixture", "1.0.0", &target),
            Err(AppError::Coded {
                code: "LSP_BLOCKED",
                ..
            })
        ));
        assert!(require_install("other", "1.0.0", &target).is_ok());
        let current = snapshot().unwrap();
        std::fs::write(FEED.cache(&root), "corrupt cached policy").unwrap();
        assert!(current.require_install("other", "1.0.0", &target).is_ok());
        assert!(require_install("other", "1.0.0", &target).is_err());
        assert!(matches!(
            current.require_install("fixture", "1.0.0", &target),
            Err(AppError::Coded {
                code: "LSP_BLOCKED",
                ..
            })
        ));
        let (envelope, _) = crate::domain::themes::managed::policy_feed::tests::signed(
            "lsp-blocklist",
            -120,
            serde_json::json!([]),
        );
        let mut signed = envelope.signed;
        signed["expires_at"] = (Utc::now() - chrono::Duration::hours(1))
            .to_rfc3339()
            .into();
        let envelope =
            crate::domain::themes::managed::policy_feed::tests::signed_with(signed, 19, "test");
        crate::shared::atomic_file::write_atomic_private(
            &FEED.cache(&root),
            &serde_json::to_string(&envelope).unwrap(),
        )
        .unwrap();
        assert!(require_install("other", "1.0.0", &target).is_err());
    }
}
