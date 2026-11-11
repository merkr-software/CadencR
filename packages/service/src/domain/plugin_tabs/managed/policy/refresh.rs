//! Coalesced feed polling per storage root, and the snapshot channel every
//! reader and subscriber shares.
use super::envelope::FEED;
use super::snapshot::{self, PolicySnapshot};
use crate::domain::agents::providers::installed::managed::trust::ManagedTrustStore;
use crate::domain::marketplace::policy_feed::{per_root, PerRoot, PollState};
use crate::error::AppError;
use chrono::{DateTime, Utc};
use std::path::{Path, PathBuf};
use std::sync::{Arc, OnceLock};
use std::time::Instant;
use tokio::sync::watch;

struct Handle {
    refresh: tokio::sync::Mutex<PollState>,
    latest: watch::Sender<Arc<PolicySnapshot>>,
}

fn handle(
    root: &Path,
    configured: bool,
    trust: &ManagedTrustStore,
) -> Result<Arc<Handle>, AppError> {
    static ROOTS: PerRoot<Handle> = OnceLock::new();
    per_root(&ROOTS, root, || Handle {
        refresh: Default::default(),
        latest: watch::channel(Arc::new(snapshot::load(
            root,
            configured,
            trust,
            Utc::now(),
            None,
        )))
        .0,
    })
    .map_err(|error| FEED.fail(error))
}

/// Replace the snapshot, waking subscribers only when something changed.
fn publish(handle: &Handle, next: PolicySnapshot) -> Arc<PolicySnapshot> {
    let next = Arc::new(next);
    handle.latest.send_if_modified(|current| {
        let changed = !current.same_as(&next);
        *current = next.clone();
        changed
    });
    next
}

pub(super) fn current(
    root: &Path,
    configured: bool,
    trust: &ManagedTrustStore,
) -> Result<Arc<PolicySnapshot>, AppError> {
    let handle = handle(root, configured, trust)?;
    let snapshot = handle.latest.borrow().clone();
    if snapshot.generation == trust.generation() && snapshot.configured == configured {
        return Ok(snapshot);
    }
    // Trust rotated: what authenticates (and who is current) may have changed.
    Ok(publish(
        &handle,
        snapshot::load(root, configured, trust, Utc::now(), None),
    ))
}

pub(super) fn subscribe(
    root: &Path,
    configured: bool,
    trust: &ManagedTrustStore,
) -> Result<watch::Receiver<Arc<PolicySnapshot>>, AppError> {
    current(root, configured, trust)?;
    Ok(handle(root, configured, trust)?.latest.subscribe())
}

/// Poll when due, admit what the feed served, then publish the cached policy
/// with the poll failure (if any) as its detail.
#[bon::builder]
pub(super) async fn refresh_with<F, Fut>(
    root: PathBuf,
    trust: ManagedTrustStore,
    force: bool,
    requested: Instant,
    now: DateTime<Utc>,
    fetch: F,
) -> Result<Arc<PolicySnapshot>, AppError>
where
    F: FnOnce() -> Fut,
    Fut: std::future::Future<Output = Result<Vec<u8>, AppError>>,
{
    let handle = handle(&root, true, &trust)?;
    let mut state = handle.refresh.lock().await;
    if !state.needs_poll(FEED.poll_cadence, force, requested) {
        return current(&root, true, &trust);
    }
    let admitted = match fetch().await {
        Ok(bytes) => {
            let (root, trust) = (root.clone(), trust.clone());
            FEED.offload(move || {
                FEED.ingest(&root, &FEED.parse(&bytes)?, &trust, now)
                    .map(|_| ())
            })
            .await
        }
        Err(error) => Err(error),
    };
    state.completed = Some(Instant::now().max(requested));
    state.failure = admitted.err().map(|error| error.to_string());
    let failure = state.failure.clone();
    let next = FEED
        .offload(move || Ok(snapshot::load(&root, true, &trust, now, failure)))
        .await?;
    Ok(publish(&handle, next))
}

/// Re-read the cache now (tests write it behind the channel's back).
#[cfg(test)]
pub(super) fn reload(
    root: &Path,
    configured: bool,
    trust: &ManagedTrustStore,
) -> Result<Arc<PolicySnapshot>, AppError> {
    let next = snapshot::load(root, configured, trust, Utc::now(), None);
    Ok(publish(&*handle(root, configured, trust)?, next))
}

#[cfg(test)]
mod tests {
    use super::super::tests::signed;
    use super::super::PolicyFreshness;
    use super::*;
    use crate::domain::marketplace::policy_feed::FORCE_CADENCE;
    use crate::domain::plugin_tabs::managed::storage;
    use serde_json::json;
    use std::cell::Cell;
    use std::time::Duration;

    #[tokio::test(flavor = "current_thread")]
    async fn polls_once_at_startup_coalesces_and_backs_off_after_failure() {
        let root = storage::root();
        let now = Utc::now();
        let (old, trust) = signed(-2, json!([]));
        FEED.ingest(&root, &old, &trust, now).unwrap();
        let (new, _) = signed(-1, json!([{"tab_id":"ports","reason":"unsafe"}]));
        let bytes = serde_json::to_vec(&new).unwrap();
        let calls = Cell::new(0);
        let fetch = || async {
            calls.set(calls.get() + 1);
            tokio::task::yield_now().await;
            Ok(bytes.clone())
        };
        let requested = Instant::now();
        let run = |force, requested| {
            refresh_with()
                .root(root.clone())
                .trust(trust.clone())
                .force(force)
                .requested(requested)
                .now(now)
                .fetch(fetch)
                .call()
        };
        // A valid cache never suppresses the startup poll; concurrent callers share it.
        let (first, second) = tokio::join!(run(false, requested), run(true, requested));
        assert_eq!(first.unwrap().listed_ids().len(), 1);
        assert_eq!(second.unwrap().freshness(), PolicyFreshness::Fresh);
        assert_eq!(calls.get(), 1);
        let offline = || {
            calls.set(calls.get() + 1);
            std::future::ready(Err(super::super::unavailable("feed offline")))
        };
        let due = requested + FEED.poll_cadence + Duration::from_secs(1);
        let served = refresh_with()
            .root(root.clone())
            .trust(trust.clone())
            .force(false)
            .requested(due)
            .now(now)
            .fetch(offline)
            .call()
            .await
            .unwrap();
        assert_eq!(calls.get(), 2);
        assert_eq!(
            served.freshness(),
            PolicyFreshness::Fresh,
            "cache stays in force"
        );
        assert!(served.status().detail.unwrap().contains("feed offline"));
        let backoff = refresh_with()
            .root(root.clone())
            .trust(trust.clone())
            .force(true)
            .requested(due)
            .now(now)
            .fetch(offline)
            .call()
            .await
            .unwrap();
        assert_eq!(
            calls.get(),
            2,
            "forced requests still respect the retry backoff"
        );
        assert_eq!(backoff.listed_ids().len(), 1);
    }

    #[tokio::test(flavor = "current_thread")]
    async fn subscribers_wake_only_on_change_and_rollback_is_reported() {
        let root = storage::root();
        let now = Utc::now();
        let (newer, trust) = signed(-1, json!([{"tab_id":"ports","reason":"unsafe"}]));
        let (older, _) = signed(-2, json!([]));
        let mut changes = subscribe(&root, true, &trust).unwrap();
        assert_eq!(
            changes.borrow_and_update().freshness(),
            PolicyFreshness::Missing
        );
        let serve = |envelope: &crate::domain::marketplace::policy_feed::Envelope, requested| {
            let bytes = serde_json::to_vec(envelope).unwrap();
            refresh_with()
                .root(root.clone())
                .trust(trust.clone())
                .force(true)
                .requested(requested)
                .now(now)
                .fetch(move || std::future::ready(Ok(bytes)))
                .call()
        };
        let start = Instant::now();
        serve(&newer, start).await.unwrap();
        assert!(changes.has_changed().unwrap());
        assert_eq!(changes.borrow_and_update().listed_ids().len(), 1);
        serve(&newer, start + 2 * FORCE_CADENCE).await.unwrap();
        assert!(!changes.has_changed().unwrap(), "same payload, no wake-up");
        let rollback = serve(&older, start + 4 * FORCE_CADENCE).await.unwrap();
        assert!(rollback.status().detail.unwrap().contains("rollback"));
        assert_eq!(rollback.listed_ids().len(), 1, "high-water policy kept");
    }
}
