//! The tab revocation policy in force, and the decisions taken from it.
use super::envelope::{Verified, FEED};
use super::unavailable;
use crate::domain::agents::providers::installed::managed::trust::ManagedTrustStore;
use crate::error::AppError;
use chrono::{DateTime, SecondsFormat, Utc};
use serde::Serialize;
use std::collections::{BTreeMap, BTreeSet};
use std::path::Path;
use utoipa::ToSchema;

/// Whether the cached policy can vouch for new work.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum PolicyFreshness {
    /// This build has no tab policy feed: like a policy never fetched, no
    /// marketplace tab installs, updates or starts a backend; pages serve.
    NotConfigured,
    /// An unexpired policy signed by an active key.
    Fresh,
    /// An authenticated policy that is no longer current (past `expires_at`,
    /// or signed by a retired key). It still blocks what it lists.
    Stale,
    /// No usable policy: never fetched, or the cache is unreadable/unauthenticated.
    Missing,
}

/// The managed revision a decision is about.
#[derive(Clone, Copy, Debug)]
pub struct PolicySubject<'a> {
    pub id: &'a str,
    pub version: &'a str,
    /// The signed web archive digest (`tab.distribution.sha256`).
    pub archive_sha256: &'a str,
    /// The signed host-platform backend executable digest, if the tab has one.
    pub executable_sha256: Option<&'a str>,
}

#[derive(Debug, Serialize, ToSchema)]
pub struct ManagedTabPolicyStatus {
    pub source_configured: bool,
    pub cache_status: PolicyFreshness,
    pub generated_at: Option<String>,
    pub expires_at: Option<String>,
    /// Why the policy is not fresh, or the last feed failure.
    pub detail: Option<String>,
}

pub struct PolicySnapshot {
    pub(super) configured: bool,
    policy: Option<Verified>,
    /// The cached envelope's signature: identifies the signed payload.
    fingerprint: Option<String>,
    detail: Option<String>,
    pub(super) generation: Option<u64>,
}

impl PolicySnapshot {
    pub fn freshness(&self) -> PolicyFreshness {
        self.freshness_at(Utc::now())
    }

    pub(super) fn freshness_at(&self, now: DateTime<Utc>) -> PolicyFreshness {
        match (&self.policy, self.configured) {
            (_, false) => PolicyFreshness::NotConfigured,
            (None, true) => PolicyFreshness::Missing,
            (Some(policy), true) if policy.current_signer && policy.expires_at > now => {
                PolicyFreshness::Fresh
            }
            (Some(_), true) => PolicyFreshness::Stale,
        }
    }

    /// The reason an authenticated cached policy (fresh or not) gives for
    /// blocking this revision.
    pub fn blocked_reason(&self, subject: PolicySubject<'_>) -> Result<Option<String>, AppError> {
        let Some(policy) = &self.policy else {
            return Ok(None);
        };
        policy
            .policy
            .blocked_reason(
                subject.id,
                subject.version,
                subject.archive_sha256,
                subject.executable_sha256,
            )
            .map(|reason| reason.map(str::to_owned))
            .map_err(unavailable)
    }

    /// 403 `PLUGIN_TAB_BLOCKED` when the policy blocks the revision.
    pub fn require_not_blocked(&self, subject: PolicySubject<'_>) -> Result<(), AppError> {
        match self.blocked_reason(subject)? {
            Some(reason) => Err(super::blocked(subject.id, &reason)),
            None => Ok(()),
        }
    }

    /// Starting a backend: not blocked, and a fresh policy (409
    /// `MANAGED_TAB_POLICY_UNAVAILABLE` otherwise, a build without a feed
    /// included; see `marketplace::revocation`).
    pub fn require_backend_start(&self, subject: PolicySubject<'_>) -> Result<(), AppError> {
        self.require_not_blocked(subject)?;
        self.require_fresh("start its backend", subject.id)
    }

    /// Installing or updating: a fresh policy, and 409 `MANAGED_TAB_BLOCKED`
    /// when it blocks the revision.
    pub fn require_install(&self, subject: PolicySubject<'_>) -> Result<(), AppError> {
        if let Some(reason) = self.blocked_reason(subject)? {
            return Err(super::install_blocked(subject, &reason));
        }
        self.require_fresh("install it", subject.id)
    }

    fn require_fresh(&self, action: &str, id: &str) -> Result<(), AppError> {
        let state = match self.freshness() {
            PolicyFreshness::Fresh => return Ok(()),
            PolicyFreshness::NotConfigured => {
                return Err(unavailable(format!(
                    "{}; cannot {action} for {id}",
                    crate::domain::marketplace::revocation::no_feed(
                        crate::domain::marketplace::ExtensionKind::Tab
                    )
                )))
            }
            PolicyFreshness::Stale => "is out of date",
            PolicyFreshness::Missing => "is unavailable",
        };
        let detail = self
            .detail
            .as_deref()
            .map(|detail| format!(" ({detail})"))
            .unwrap_or_default();
        Err(unavailable(format!(
            "the custom tab revocation policy {state}{detail}; cannot {action} for {id} until it is refreshed"
        )))
    }

    /// Tab ids the policy names: the only tabs a policy change can affect.
    pub fn listed_ids(&self) -> BTreeSet<&str> {
        self.policy
            .iter()
            .flat_map(|policy| policy.policy.entries.iter())
            .map(|entry| entry.tab_id.as_str())
            .collect()
    }

    /// Tab ids whose entries differ between this policy and `next`: the only
    /// tabs a policy change can block or unblock. A new signature or detail
    /// (a feed failure) over the same entries changes none.
    pub fn changed_ids(&self, next: &Self) -> BTreeSet<String> {
        let (before, after) = (self.entries_by_id(), next.entries_by_id());
        before
            .keys()
            .chain(after.keys())
            .filter(|id| before.get(*id) != after.get(*id))
            .map(|id| (*id).to_owned())
            .collect()
    }

    /// Every entry's matching fields and reason, by tab id.
    fn entries_by_id(&self) -> BTreeMap<&str, Vec<[Option<&str>; 4]>> {
        let mut entries: BTreeMap<&str, Vec<_>> = BTreeMap::new();
        for entry in self.policy.iter().flat_map(|policy| &policy.policy.entries) {
            entries.entry(entry.tab_id.as_str()).or_default().push([
                entry.version_requirement.as_deref(),
                entry.archive_sha256.as_deref(),
                entry.executable_sha256.as_deref(),
                Some(entry.reason.as_str()),
            ]);
        }
        entries
    }

    pub fn status(&self) -> ManagedTabPolicyStatus {
        let format = |at: DateTime<Utc>| at.to_rfc3339_opts(SecondsFormat::Secs, true);
        ManagedTabPolicyStatus {
            source_configured: self.configured,
            cache_status: self.freshness(),
            generated_at: self.policy.as_ref().map(|p| format(p.generated_at)),
            expires_at: self.policy.as_ref().map(|p| format(p.expires_at)),
            detail: self.detail.clone(),
        }
    }

    /// Same signed payload, same failure: nothing for subscribers to learn.
    pub(super) fn same_as(&self, other: &Self) -> bool {
        self.configured == other.configured
            && self.fingerprint == other.fingerprint
            && self.detail == other.detail
            && self.generation == other.generation
    }
}

/// Read the cached policy. Never fails: an unusable cache is `Missing` with
/// the reason in `detail`, alongside the last feed `failure` if any.
pub(super) fn load(
    root: &Path,
    configured: bool,
    trust: &ManagedTrustStore,
    now: DateTime<Utc>,
    failure: Option<String>,
) -> PolicySnapshot {
    let mut snapshot = PolicySnapshot {
        configured,
        policy: None,
        fingerprint: None,
        detail: failure,
        generation: trust.generation(),
    };
    if !configured {
        return snapshot;
    }
    let cached = FEED.cached(root).and_then(|cached| {
        cached
            .map(|cached| {
                FEED.verify(&cached, trust, false, now)
                    .map(|verified| (verified, cached.signature.value))
            })
            .transpose()
    });
    let problem = match cached {
        Ok(Some((verified, fingerprint))) => {
            snapshot.policy = Some(verified);
            snapshot.fingerprint = Some(fingerprint);
            None
        }
        Ok(None) => Some("no verified tab revocation policy has been fetched yet".to_owned()),
        Err(error) => Some(format!("cached tab revocation policy is unusable: {error}")),
    };
    snapshot.detail = match (problem, snapshot.detail.take()) {
        (Some(problem), Some(failure)) => Some(format!("{failure}; {problem}")),
        (problem, failure) => problem.or(failure),
    };
    snapshot
}

#[cfg(test)]
mod tests {
    use super::super::tests::{rotation_trust, signed};
    use super::*;
    use crate::domain::plugin_tabs::managed::storage;
    use serde_json::json;

    fn subject<'a>(id: &'a str, executable: Option<&'a str>) -> PolicySubject<'a> {
        PolicySubject {
            id,
            version: "1.0.0",
            archive_sha256: "0000000000000000000000000000000000000000000000000000000000000000",
            executable_sha256: executable,
        }
    }

    #[test]
    fn without_a_feed_a_tab_neither_installs_nor_starts_but_its_page_still_serves() {
        let root = storage::root();
        let (envelope, trust) = signed(-1, json!([{"tab_id":"ports","reason":"unsafe"}]));
        FEED.ingest(&root, &envelope, &trust, Utc::now()).unwrap();
        let snapshot = load(&root, false, &trust, Utc::now(), None);
        assert_eq!(snapshot.freshness(), PolicyFreshness::NotConfigured);
        for refused in [
            snapshot.require_backend_start(subject("other", None)),
            snapshot.require_install(subject("other", None)),
        ] {
            assert!(matches!(
                refused,
                Err(AppError::Coded {
                    code: "MANAGED_TAB_POLICY_UNAVAILABLE",
                    ..
                })
            ));
        }
        // Inert content stays usable; a cache another build left is not
        // this build's policy.
        snapshot
            .require_not_blocked(subject("ports", None))
            .unwrap();
        assert!(!snapshot.status().source_configured);
    }

    #[test]
    fn freshness_follows_cache_expiry_and_signer() {
        let root = storage::root();
        let now = Utc::now();
        let (envelope, trust) = signed(-1, json!([]));
        let missing = load(&root, true, &trust, now, Some("offline".into()));
        assert_eq!(missing.freshness(), PolicyFreshness::Missing);
        let refused = missing.require_backend_start(subject("ports", None));
        let message = refused.unwrap_err().to_string();
        assert!(message.contains("offline") && message.contains("fetched yet"));
        FEED.ingest(&root, &envelope, &trust, now).unwrap();
        let fresh = load(&root, true, &trust, now, None);
        assert_eq!(fresh.freshness_at(now), PolicyFreshness::Fresh);
        let later = now + chrono::Duration::hours(2);
        assert_eq!(fresh.freshness_at(later), PolicyFreshness::Stale);
        let rotated = rotation_trust(now - chrono::Duration::minutes(1), false, vec![]);
        let retired = load(&root, true, &rotated, now, None);
        assert_eq!(retired.freshness_at(now), PolicyFreshness::Stale);
        assert!(retired.require_install(subject("ports", None)).is_err());
        let unauthenticated = load(&root, true, &ManagedTrustStore::default(), now, None);
        assert_eq!(unauthenticated.freshness(), PolicyFreshness::Missing);
        assert!(unauthenticated
            .status()
            .detail
            .unwrap()
            .contains("unusable"));
    }

    #[test]
    fn blocked_reason_matches_id_version_archive_and_executable_even_when_stale() {
        let root = storage::root();
        let now = Utc::now();
        let executable = "e".repeat(64);
        let (envelope, trust) = signed(
            -1,
            json!([
                {"tab_id":"binary","executable_sha256":executable,"reason":"bad binary"},
                {"tab_id":"ports","version_requirement":"<2.0.0","reason":"unsafe"},
                {"tab_id":"web","archive_sha256":"0".repeat(64),"reason":"bad web"}
            ]),
        );
        FEED.ingest(&root, &envelope, &trust, now).unwrap();
        let snapshot = load(&root, true, &trust, now, None);
        let reason = |subject| snapshot.blocked_reason(subject).unwrap();
        assert_eq!(reason(subject("ports", None)).as_deref(), Some("unsafe"));
        assert_eq!(reason(subject("web", None)).as_deref(), Some("bad web"));
        assert_eq!(reason(subject("binary", None)), None);
        let other = "f".repeat(64);
        assert_eq!(reason(subject("binary", Some(&other))), None);
        let blocked = subject("binary", Some(&executable));
        assert_eq!(reason(blocked).as_deref(), Some("bad binary"));
        let mut newer = subject("ports", None);
        newer.version = "2.0.0";
        assert_eq!(reason(newer), None);
        let error = snapshot.require_backend_start(blocked).unwrap_err();
        assert!(error.to_string().contains("bad binary"));
        let error = snapshot.require_install(blocked).unwrap_err();
        assert!(error.to_string().contains("blocked"));
        assert_eq!(
            snapshot.listed_ids(),
            BTreeSet::from(["binary", "ports", "web"])
        );
        // A cache read after its expiry still authenticates, and still blocks.
        let later = now + chrono::Duration::hours(2);
        let stale = load(&root, true, &trust, later, None);
        assert_eq!(stale.freshness_at(later), PolicyFreshness::Stale);
        assert_eq!(
            stale
                .blocked_reason(subject("ports", None))
                .unwrap()
                .as_deref(),
            Some("unsafe")
        );
        assert!(stale.require_not_blocked(subject("other", None)).is_ok());
    }

    #[test]
    fn only_entry_changes_name_tabs_and_detail_alone_changes_none() {
        let root = storage::root();
        let now = Utc::now();
        let (first, trust) = signed(
            -2,
            json!([{"tab_id":"other","reason":"x"},{"tab_id":"ports","reason":"unsafe"}]),
        );
        FEED.ingest(&root, &first, &trust, now).unwrap();
        let before = load(&root, true, &trust, now, None);
        let failing = load(&root, true, &trust, now, Some("feed offline".into()));
        assert!(
            !before.same_as(&failing),
            "subscribers still learn the detail"
        );
        assert!(before.changed_ids(&failing).is_empty());
        assert_eq!(failing.status().detail.as_deref(), Some("feed offline"));
        let (second, _) = signed(
            -1,
            json!([
                {"tab_id":"other","reason":"x"},
                {"tab_id":"ports","reason":"worse"},
                {"tab_id":"web","archive_sha256":"0".repeat(64),"reason":"bad web"}
            ]),
        );
        FEED.ingest(&root, &second, &trust, now).unwrap();
        let after = load(&root, true, &trust, now, None);
        assert_eq!(
            before.changed_ids(&after),
            BTreeSet::from(["ports".to_owned(), "web".to_owned()])
        );
        let unusable = load(&root, true, &ManagedTrustStore::default(), now, None);
        assert_eq!(after.changed_ids(&unusable).len(), 3, "every listed tab");
    }
}
