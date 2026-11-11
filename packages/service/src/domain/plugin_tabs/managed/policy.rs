//! Host-owned, signed custom-tab revocations: the `tab-blocklist` feed, signed
//! with the same key as the catalog and the other policies.
//!
//! The verified high-water policy is cached at `<managed-tabs>/.tab-blocklist.json`
//! (a dot-file: the root's other entries are tab ids). Any authenticated cached
//! policy may block a tab, even an expired one; only a fresh policy (current
//! signer, unexpired) lets a backend start or a tab install while a source is
//! configured. A build without `CADENCR_MANAGED_TAB_BLOCKLIST_URL` blocks nothing.
mod envelope;
mod refresh;
mod snapshot;
mod task;

use super::storage::ManagedFacts;
use crate::domain::agents::providers::installed::managed::trust::{
    pinned_index_trust_store, ManagedTrustStore,
};
use crate::error::AppError;
use std::path::PathBuf;
use std::sync::Arc;

pub use snapshot::{ManagedTabPolicyStatus, PolicyFreshness, PolicySnapshot, PolicySubject};
pub use task::spawn_refresh_task;

/// 403 `PLUGIN_TAB_BLOCKED`: Cadencr's revocation policy blocks this
/// installed revision, which cannot run (only be removed or updated).
pub fn blocked(id: &str, reason: &str) -> AppError {
    AppError::coded(
        axum::http::StatusCode::FORBIDDEN,
        "PLUGIN_TAB_BLOCKED",
        format!("custom tab {id} is blocked: {reason}"),
    )
}

/// 409 `MANAGED_TAB_BLOCKED`: the policy blocks the signed revision an
/// install or update would bring in.
pub fn install_blocked(subject: PolicySubject<'_>, reason: &str) -> AppError {
    AppError::coded(
        axum::http::StatusCode::CONFLICT,
        "MANAGED_TAB_BLOCKED",
        format!(
            "custom tab {} {} is blocked: {reason}",
            subject.id, subject.version
        ),
    )
}

impl<'a> PolicySubject<'a> {
    /// An installed (or staged) marketplace revision.
    pub fn installed(id: &'a str, version: &'a str, facts: &'a ManagedFacts) -> Self {
        Self {
            id,
            version,
            archive_sha256: &facts.archive_sha256,
            executable_sha256: facts.backend_digest(),
        }
    }

    /// A signed catalog revision: `package`'s web archive, with this host's
    /// backend executable when it ships one. `None` when the package names
    /// no archive digest.
    pub fn signed(
        id: &'a str,
        version: &'a str,
        package: &'a serde_json::Value,
        executable_sha256: Option<&'a str>,
    ) -> Option<Self> {
        Some(Self {
            id,
            version,
            archive_sha256: package["tab"]["distribution"]["sha256"].as_str()?,
            executable_sha256,
        })
    }
}

impl PolicySnapshot {
    /// Why this policy blocks `subject`. Fails closed: a revision it cannot
    /// be checked against is blocked, and says why.
    pub fn blocked_reason_or_unverifiable(&self, subject: PolicySubject<'_>) -> Option<String> {
        self.blocked_reason(subject)
            .unwrap_or_else(|error| Some(unverifiable(error)))
    }

    /// [`Self::blocked_reason_or_unverifiable`] for an installed revision.
    pub fn installed_blocked_reason(
        &self,
        id: &str,
        version: &str,
        facts: &ManagedFacts,
    ) -> Option<String> {
        self.blocked_reason_or_unverifiable(PolicySubject::installed(id, version, facts))
    }
}

/// [`PolicySnapshot::blocked_reason_or_unverifiable`] against the policy in
/// force; a policy that cannot be read blocks too.
pub fn current_blocked_reason(subject: PolicySubject<'_>) -> Option<String> {
    match current() {
        Ok(policy) => policy.blocked_reason_or_unverifiable(subject),
        Err(error) => Some(unverifiable(error)),
    }
}

fn unverifiable(error: impl std::fmt::Display) -> String {
    format!("it cannot be checked against the revocation policy ({error})")
}

fn unavailable(message: impl std::fmt::Display) -> AppError {
    AppError::coded(
        axum::http::StatusCode::CONFLICT,
        "MANAGED_TAB_POLICY_UNAVAILABLE",
        message.to_string(),
    )
}

/// The policy feed compiled into this build, if any.
fn source() -> Option<String> {
    #[cfg(test)]
    if let Some(fixture) = tests::fixture() {
        return Some(fixture.url);
    }
    option_env!("CADENCR_MANAGED_TAB_BLOCKLIST_URL")
        .filter(|url| !url.trim().is_empty())
        .map(str::to_owned)
}

fn trust_store() -> ManagedTrustStore {
    #[cfg(test)]
    if let Some(fixture) = tests::fixture() {
        return fixture.trust;
    }
    pinned_index_trust_store()
}

fn root() -> PathBuf {
    super::storage::root()
}

/// The policy in force now: in memory after the first read, re-read from the
/// cache when the registry trust generation changed. Never touches the network.
pub fn current() -> Result<Arc<PolicySnapshot>, AppError> {
    refresh::current(&root(), source().is_some(), &trust_store())
}

/// Poll the feed (coalesced; at most every 10 minutes unless `force`, which
/// still waits 5 s between polls and 60 s after a failure), then return the
/// policy in force. A feed failure is not an error: the cached policy stays in
/// force and the snapshot's `detail` carries the failure. Without a configured
/// source this returns the `NotConfigured` snapshot without any request.
pub async fn refresh(force: bool) -> Result<Arc<PolicySnapshot>, AppError> {
    let Some(url) = source() else {
        return refresh::current(&root(), false, &trust_store());
    };
    refresh::refresh_with()
        .root(root())
        .trust(trust_store())
        .force(force)
        .requested(std::time::Instant::now())
        .now(chrono::Utc::now())
        .fetch(|| fetch(url))
        .call()
        .await
}

async fn fetch(url: String) -> Result<Vec<u8>, AppError> {
    #[cfg(test)]
    if let Some(fixture) = tests::fixture() {
        return tests::fetched(fixture.response);
    }
    crate::domain::marketplace::catalog::download(&url, envelope::FEED.max_bytes)
        .await
        .map_err(unavailable)
}

/// Every policy change (refresh, trust rotation reload), in order. The value
/// is the snapshot now in force; compare with the previous one to find tabs
/// that became blocked.
pub fn subscribe() -> Result<tokio::sync::watch::Receiver<Arc<PolicySnapshot>>, AppError> {
    refresh::subscribe(&root(), source().is_some(), &trust_store())
}

/// What `GET /api/marketplace/tabs/policy` would report.
pub fn status() -> Result<ManagedTabPolicyStatus, AppError> {
    Ok(current()?.status())
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    pub(super) use crate::domain::marketplace::policy_feed::tests::{at, resign_b, signed_with};
    use chrono::{DateTime, Utc};
    use serde_json::{json, Value};
    use std::collections::HashMap;
    use std::sync::Mutex;

    #[derive(Clone)]
    pub(super) struct Fixture {
        pub(super) url: String,
        pub(super) trust: ManagedTrustStore,
        pub(super) response: Result<Vec<u8>, String>,
        calls: usize,
    }

    fn fixtures() -> &'static Mutex<HashMap<PathBuf, Fixture>> {
        static FIXTURES: std::sync::OnceLock<Mutex<HashMap<PathBuf, Fixture>>> =
            std::sync::OnceLock::new();
        FIXTURES.get_or_init(Default::default)
    }

    /// This test's configured feed (keyed by its storage root), if any.
    pub(super) fn fixture() -> Option<Fixture> {
        fixtures().lock().unwrap().get(&root()).cloned()
    }

    pub(super) fn fetched(response: Result<Vec<u8>, String>) -> Result<Vec<u8>, AppError> {
        if let Some(fixture) = fixtures().lock().unwrap().get_mut(&root()) {
            fixture.calls += 1;
        }
        response.map_err(unavailable)
    }

    /// A configured feed for this test's storage root, seeded with a fresh
    /// policy listing `entries`; the feed serves the same envelope until
    /// `respond` changes it.
    pub(crate) struct ConfiguredPolicy(PathBuf);
    impl Drop for ConfiguredPolicy {
        fn drop(&mut self) {
            fixtures().lock().unwrap().remove(&self.0);
        }
    }
    pub(crate) fn configure(entries: Value) -> ConfiguredPolicy {
        let root = root();
        let (envelope, trust) = signed(-1, entries);
        envelope::FEED
            .ingest(&root, &envelope, &trust, Utc::now())
            .unwrap();
        let fixture = Fixture {
            url: "https://registry.example/tab-blocklist.json".into(),
            trust: trust.clone(),
            response: Ok(serde_json::to_vec(&envelope).unwrap()),
            calls: 0,
        };
        fixtures().lock().unwrap().insert(root.clone(), fixture);
        refresh::reload(&root, true, &trust).unwrap();
        ConfiguredPolicy(root)
    }
    /// What the feed serves next: a newer policy, or a network failure.
    pub(crate) fn respond(entries: Value) {
        let bytes = serde_json::to_vec(&signed(0, entries).0).unwrap();
        fixtures()
            .lock()
            .unwrap()
            .get_mut(&root())
            .unwrap()
            .response = Ok(bytes);
    }
    pub(crate) fn go_offline() {
        let mut fixtures = fixtures().lock().unwrap();
        fixtures.get_mut(&root()).unwrap().response = Err("test policy feed offline".into());
    }
    pub(crate) fn fetch_count() -> usize {
        fixtures().lock().unwrap()[&root()].calls
    }
    /// Replace the cache with an authenticated but expired policy.
    pub(crate) fn expire_cache(entries: Value) {
        let (mut envelope, trust) = signed(-2, entries);
        envelope.signed["expires_at"] = at(-1).into();
        let envelope = signed_with(envelope.signed, 19, "test");
        let root = root();
        crate::shared::atomic_file::write_atomic_private(
            &envelope::FEED.cache(&root),
            &serde_json::to_string(&envelope).unwrap(),
        )
        .unwrap();
        refresh::reload(&root, true, &trust).unwrap();
    }

    /// A tab policy generated `offset_minutes` from now, valid for an hour,
    /// signed by the legacy single-key trust it returns (key `test`, seed 19).
    pub(super) fn signed(
        offset_minutes: i64,
        entries: Value,
    ) -> (
        crate::domain::marketplace::policy_feed::Envelope,
        ManagedTrustStore,
    ) {
        crate::domain::marketplace::policy_feed::tests::signed(
            "tab-blocklist",
            offset_minutes,
            entries,
        )
    }
    /// Trust generation 2: `current-b` active, `test` retired at `cutoff` (or
    /// revoked), with tab-policy recovery checkpoints.
    pub(super) fn rotation_trust(
        cutoff: DateTime<Utc>,
        revoked: bool,
        tab_checkpoints: Vec<String>,
    ) -> ManagedTrustStore {
        crate::domain::marketplace::catalog::tests::rotation_trust_with(
            cutoff,
            revoked,
            &[("recovery_tab_policy_sha256", tab_checkpoints)],
        )
    }

    /// Live-API QA (no feed needed): writes a policy signed by the custom-tab
    /// fixture key (`tab-test`, seed 37 — the key `qa_seed_marketplace_backend_tab`
    /// prints) as the cache of `CADENCR_QA_TAB_PLUGINS=<plugins dir>`. The
    /// service must be built with that key and any
    /// `CADENCR_MANAGED_TAB_BLOCKLIST_URL`; a feed that fails leaves the cache
    /// in force, re-read on the next poll (a forced catalog refresh, at most
    /// once a minute after a failure).
    ///
    /// `CADENCR_QA_POLICY_ENTRIES` is the JSON `entries` array (default `[]`);
    /// `CADENCR_QA_POLICY_EXPIRED=1` writes one that expired an hour ago.
    #[test]
    #[ignore = "live QA seeding: run explicitly with the environment above"]
    fn qa_write_tab_blocklist() {
        let plugins = PathBuf::from(std::env::var("CADENCR_QA_TAB_PLUGINS").unwrap());
        let entries: Value = serde_json::from_str(
            &std::env::var("CADENCR_QA_POLICY_ENTRIES").unwrap_or_else(|_| "[]".into()),
        )
        .unwrap();
        let expired = std::env::var("CADENCR_QA_POLICY_EXPIRED").is_ok_and(|value| value == "1");
        let (generated, expires) = if expired { (-120, -60) } else { (0, 60) };
        let signed = json!({"schema_version":1,"kind":"tab-blocklist","generated_at":at(generated),"expires_at":at(expires),"entries":entries});
        let envelope = signed_with(signed, 37, "tab-test");
        let root = plugins.join("managed-tabs");
        crate::shared::atomic_file::write_atomic_private(
            &envelope::FEED.cache(&root),
            &serde_json::to_string(&envelope).unwrap(),
        )
        .unwrap();
        println!("wrote {}", envelope::FEED.cache(&root).display());
    }

    fn ports() -> PolicySubject<'static> {
        PolicySubject {
            id: "ports",
            version: "1.0.0",
            archive_sha256: "0000000000000000000000000000000000000000000000000000000000000000",
            executable_sha256: None,
        }
    }

    #[tokio::test(flavor = "current_thread")]
    async fn unconfigured_build_blocks_nothing_and_never_fetches() {
        let snapshot = refresh(true).await.unwrap();
        assert_eq!(snapshot.freshness(), PolicyFreshness::NotConfigured);
        current().unwrap().require_backend_start(ports()).unwrap();
        let status = status().unwrap();
        assert!(!status.source_configured);
        assert_eq!(status.cache_status, PolicyFreshness::NotConfigured);
    }

    #[tokio::test(flavor = "current_thread")]
    async fn refresh_blocks_newly_listed_tabs_and_expiry_refuses_backend_start() {
        let _policy = configure(json!([]));
        let changes = subscribe().unwrap();
        assert_eq!(current().unwrap().freshness(), PolicyFreshness::Fresh);
        current().unwrap().require_backend_start(ports()).unwrap();
        respond(json!([{"tab_id":"ports","reason":"unsafe"}]));
        let snapshot = refresh(false).await.unwrap();
        assert_eq!(fetch_count(), 1);
        assert!(changes.has_changed().unwrap());
        let refused = snapshot.require_not_blocked(ports()).unwrap_err();
        assert!(refused.to_string().contains("unsafe"));
        assert_eq!(snapshot.status().cache_status, PolicyFreshness::Fresh);
        go_offline();
        refresh(true).await.unwrap();
        assert_eq!(fetch_count(), 1, "forced refreshes are rate limited");
        expire_cache(json!([{"tab_id":"blocked","reason":"still blocked"}]));
        let stale = current().unwrap();
        assert_eq!(stale.freshness(), PolicyFreshness::Stale);
        let refused = stale.require_backend_start(ports()).unwrap_err();
        assert!(refused.to_string().contains("out of date"));
        let mut blocked = ports();
        blocked.id = "blocked";
        assert!(
            stale.require_not_blocked(blocked).is_err(),
            "expired still blocks"
        );
        assert!(
            stale.require_not_blocked(ports()).is_ok(),
            "the tab UI keeps working"
        );
        assert_eq!(status().unwrap().cache_status, PolicyFreshness::Stale);
    }
}
