//! Background polling (startup, then every 10 minutes) and the tab change
//! events a policy change causes.
use super::envelope::FEED;
use super::PolicySnapshot;
use crate::domain::plugin_tabs::managed::storage;
use crate::domain::plugin_tabs::watcher::PluginTabChangedEvent;
use std::path::PathBuf;
use std::sync::Arc;
use tokio::sync::{broadcast, watch};

/// Poll the configured feed for the process lifetime, and announce every
/// installed managed tab whose entries a policy change alters as
/// `PluginTabChangedEvent`:
/// the grants watcher re-validates it (revoking grants once `require_valid`
/// refuses blocked tabs) and clients refetch it. No-op without a feed.
pub fn spawn_refresh_task(events: broadcast::Sender<PluginTabChangedEvent>) {
    let root = super::root();
    if super::source().is_none() {
        return;
    }
    match super::subscribe() {
        Ok(changes) => {
            tokio::spawn(announce(root, changes, events));
        }
        Err(error) => tracing::error!(
            %error,
            "custom tab revocation changes cannot be announced; tabs pick them up on their next check"
        ),
    }
    tokio::spawn(poll());
}

async fn poll() {
    let mut ticker = tokio::time::interval(FEED.poll_cadence);
    ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    loop {
        ticker.tick().await;
        // A feed failure lives on in the snapshot's `detail` (the policy status).
        match super::refresh(false).await {
            Ok(snapshot) => {
                if let Some(detail) = snapshot.status().detail {
                    tracing::warn!(detail, "custom tab revocation policy refresh");
                }
            }
            Err(error) => tracing::error!(%error, "custom tab revocation policy refresh failed"),
        }
    }
}

async fn announce(
    root: PathBuf,
    mut changes: watch::Receiver<Arc<PolicySnapshot>>,
    events: broadcast::Sender<PluginTabChangedEvent>,
) {
    let mut previous = changes.borrow_and_update().clone();
    while changes.changed().await.is_ok() {
        let next = changes.borrow_and_update().clone();
        let named = previous.changed_ids(&next);
        previous = next;
        if named.is_empty() {
            continue;
        }
        let root = root.clone();
        let installed = tokio::task::spawn_blocking(move || storage::ids(&root))
            .await
            .map_err(|error| error.to_string())
            .and_then(|ids| ids.map_err(|error| error.to_string()));
        let installed = match installed {
            Ok(installed) => installed,
            Err(error) => {
                tracing::error!(
                    error,
                    "cannot list managed tabs to announce a policy change"
                );
                continue;
            }
        };
        for plugin_id in installed.into_iter().filter(|id| named.contains(id)) {
            // No subscriber yet is not a failure: they read the policy on connect.
            let _ = events.send(PluginTabChangedEvent { plugin_id });
        }
    }
}

#[cfg(test)]
mod tests {
    use super::super::tests::{configure, respond};
    use super::*;
    use serde_json::json;

    fn install(id: &str) {
        let owner = storage::owner(&storage::root(), id).unwrap();
        std::fs::create_dir_all(&owner).unwrap();
        std::fs::write(owner.join("active.json"), "\"placeholder\"").unwrap();
    }

    #[tokio::test(flavor = "current_thread")]
    async fn announces_installed_tabs_a_new_policy_names() {
        let _policy = configure(json!([]));
        storage::secure(&storage::root(), &storage::root()).unwrap();
        install("ports");
        install("other");
        let (events, mut received) = broadcast::channel(8);
        let changes = super::super::subscribe().unwrap();
        tokio::spawn(announce(storage::root(), changes, events));
        respond(json!([{"tab_id":"absent","reason":"x"},{"tab_id":"ports","reason":"unsafe"}]));
        let snapshot = super::super::refresh(true).await.unwrap();
        assert_eq!(snapshot.listed_ids().len(), 2, "{:?}", snapshot.status());
        let event = tokio::time::timeout(std::time::Duration::from_secs(5), received.recv())
            .await
            .unwrap()
            .unwrap();
        assert_eq!(event.plugin_id, "ports");
        assert!(received.try_recv().is_err(), "only installed, named tabs");
    }
}
