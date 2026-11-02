//! Strong service ownership of each session's runtime cell.
//!
//! The directory lock only selects cells. Runtime work uses the selected
//! session's lock, so a blocked provider never holds up unrelated sessions.

use std::collections::HashMap;
use std::sync::Arc;

use tokio::sync::{Mutex, OwnedMutexGuard};

use super::state::{new_sdk_sessions, QueryState, SdkSessions};
use crate::domain::ws_session::sender_registry::WsFeatureSenderRegistry;

struct RuntimeEntry {
    cell: SdkSessions,
    launch: Arc<Mutex<()>>,
    feature_id: Option<i64>,
}

#[derive(Default)]
pub(crate) struct SessionRuntimeRegistry {
    sessions: Mutex<HashMap<i64, RuntimeEntry>>,
    retirement: Mutex<()>,
}

impl SessionRuntimeRegistry {
    pub(crate) fn new() -> Self {
        Self::default()
    }

    pub(crate) async fn get(&self, session_id: i64) -> Option<SdkSessions> {
        self.sessions
            .lock()
            .await
            .get(&session_id)
            .map(|entry| entry.cell.clone())
    }

    /// Bind the first candidate; reconnecting clients receive the same cell.
    /// Production callers allocate one candidate for each session.
    #[cfg(test)]
    pub(crate) async fn bind(&self, session_id: i64, candidate: &SdkSessions) -> SdkSessions {
        self.bind_feature(session_id, None, candidate).await
    }

    pub(crate) async fn bind_feature(
        &self,
        session_id: i64,
        feature_id: impl Into<Option<i64>>,
        candidate: &SdkSessions,
    ) -> SdkSessions {
        let feature_id = feature_id.into();
        self.sessions
            .lock()
            .await
            .entry(session_id)
            .or_insert_with(|| RuntimeEntry {
                cell: candidate.clone(),
                launch: Arc::default(),
                feature_id,
            })
            .cell
            .clone()
    }

    /// Serialize only pending-runtime launches. Permission/control commands do
    /// not take this claim, and registration releases it before delivery waits.
    pub(crate) async fn claim_spawn(&self, session_id: i64) -> OwnedMutexGuard<()> {
        let launch = self
            .sessions
            .lock()
            .await
            .entry(session_id)
            .or_insert_with(|| RuntimeEntry {
                cell: new_sdk_sessions(),
                launch: Arc::default(),
                feature_id: None,
            })
            .launch
            .clone();
        launch.lock_owned().await
    }

    pub(crate) async fn is_spawning(&self, session_id: i64) -> bool {
        self.sessions
            .lock()
            .await
            .get(&session_id)
            .is_some_and(|entry| entry.launch.try_lock().is_err())
    }

    /// The database deletion has already succeeded. Wait only for this
    /// feature's launch claims, then close and release its exact runtimes.
    pub(crate) async fn retire_feature(&self, feature_id: i64) -> Result<(), String> {
        let entries: Vec<_> = self
            .sessions
            .lock()
            .await
            .iter()
            .filter(|(_, entry)| entry.feature_id == Some(feature_id))
            .map(|(&id, entry)| (id, entry.cell.clone(), entry.launch.clone()))
            .collect();
        let mut failures = Vec::new();
        for (id, cell, launch) in entries {
            let _launch = launch.lock().await;
            let mut handles = cell.lock().await;
            if let Some(handle) = handles.remove(&id) {
                if let QueryState::Active { query, .. } = handle.state {
                    if let Err(error) = query.write().await.close().await {
                        failures.push(format!("session {id}: {error}"));
                    }
                }
            }
            let mut directory = self.sessions.lock().await;
            if directory
                .get(&id)
                .is_some_and(|entry| Arc::ptr_eq(&entry.cell, &cell))
            {
                directory.remove(&id);
            }
        }
        if failures.is_empty() {
            Ok(())
        } else {
            Err(failures.join("; "))
        }
    }

    /// Release idle cells after their last viewer and command lease leave.
    /// Active runtimes belong to their reader until its safe-idle checks pass.
    pub(crate) async fn prune_unobserved(&self, viewers: &WsFeatureSenderRegistry) {
        // Serialize sweeps so their temporary Arc leases cannot mutually
        // prevent retirement. Provider locks are never awaited during a sweep.
        let _sweep = self.retirement.lock().await;
        let candidates: Vec<_> = self
            .sessions
            .lock()
            .await
            .iter()
            .map(|(&id, entry)| (id, entry.cell.clone()))
            .collect();
        for (id, cell) in candidates {
            self.prune_cell(id, cell, viewers).await;
        }
    }

    /// Retire only the session touched by a completed command.
    pub(crate) async fn prune_session(&self, id: i64, viewers: &WsFeatureSenderRegistry) {
        let _sweep = self.retirement.lock().await;
        if let Some(cell) = self.get(id).await {
            self.prune_cell(id, cell, viewers).await;
        }
    }

    async fn prune_cell(&self, id: i64, cell: SdkSessions, viewers: &WsFeatureSenderRegistry) {
        let Ok(handles) = cell.try_lock() else {
            return;
        };
        if let Some(handle) = handles.get(&id) {
            if matches!(handle.state, QueryState::Active { .. })
                || !viewers.get_senders(handle.feature_id).await.is_empty()
            {
                return;
            }
        }
        let mut directory = self.sessions.lock().await;
        // A resolved command leases this exact cell. Both the check and
        // removal run under the directory lock, so a new lease cannot race
        // between them. The sweeper and directory own the only two Arcs.
        if Arc::strong_count(&cell) == 2
            && directory.get(&id).is_some_and(|current| {
                Arc::ptr_eq(&current.cell, &cell) && current.launch.try_lock().is_ok()
            })
        {
            directory.remove(&id);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::super::state::new_sdk_sessions;
    use super::*;

    #[tokio::test]
    async fn concurrent_binding_preserves_one_authoritative_cell() {
        let registry = SessionRuntimeRegistry::new();
        let first = new_sdk_sessions();
        let second = new_sdk_sessions();
        let (a, b) = tokio::join!(registry.bind(7, &first), registry.bind(7, &second));
        assert!(Arc::ptr_eq(&a, &b));
        assert!(Arc::ptr_eq(&registry.get(7).await.unwrap(), &a));
    }

    #[tokio::test]
    async fn locked_runtime_does_not_block_another_session() {
        let registry = SessionRuntimeRegistry::new();
        let a = registry.bind(1, &new_sdk_sessions()).await;
        let _blocked_provider = a.lock().await;
        let other = tokio::time::timeout(std::time::Duration::from_millis(100), async {
            let b = registry.bind(2, &new_sdk_sessions()).await;
            let _handle = b.lock().await;
        })
        .await;
        assert!(other.is_ok());
    }

    #[tokio::test]
    async fn command_lease_prevents_idle_eviction_then_last_release_prunes() {
        let registry = SessionRuntimeRegistry::new();
        let viewers = WsFeatureSenderRegistry::new();
        let command = registry.bind(1, &new_sdk_sessions()).await;
        registry.prune_unobserved(&viewers).await;
        assert!(Arc::ptr_eq(&registry.get(1).await.unwrap(), &command));
        drop(command);
        registry.prune_unobserved(&viewers).await;
        assert!(registry.get(1).await.is_none());
    }
    #[tokio::test]
    async fn simultaneous_sweeps_release_idle_cells_without_mutual_leases() {
        let registry = SessionRuntimeRegistry::new();
        let viewers = WsFeatureSenderRegistry::new();
        drop(registry.bind(1, &new_sdk_sessions()).await);
        tokio::join!(
            registry.prune_unobserved(&viewers),
            registry.prune_unobserved(&viewers)
        );
        assert!(registry.get(1).await.is_none());
    }

    #[tokio::test]
    async fn blocked_provider_does_not_delay_disconnect_sweep() {
        let registry = SessionRuntimeRegistry::new();
        let viewers = WsFeatureSenderRegistry::new();
        let blocked = registry.bind(1, &new_sdk_sessions()).await;
        let guard = blocked.lock().await;
        drop(registry.bind(2, &new_sdk_sessions()).await);
        tokio::time::timeout(
            std::time::Duration::from_millis(100),
            registry.prune_unobserved(&viewers),
        )
        .await
        .unwrap();
        assert!(registry.get(2).await.is_none());
        drop(guard);
        drop(blocked);
        registry.prune_unobserved(&viewers).await;
        assert!(registry.get(1).await.is_none());
    }

    #[tokio::test]
    async fn cancelled_spawn_claim_releases_queued_launcher() {
        let registry = Arc::new(SessionRuntimeRegistry::new());
        drop(registry.bind(1, &new_sdk_sessions()).await);
        let first = registry.claim_spawn(1).await;
        let queued_registry = registry.clone();
        let queued = tokio::spawn(async move { queued_registry.claim_spawn(1).await });
        tokio::task::yield_now().await;
        assert!(!queued.is_finished());
        drop(first);
        let second = tokio::time::timeout(std::time::Duration::from_millis(100), queued)
            .await
            .unwrap()
            .unwrap();
        assert!(registry.is_spawning(1).await);
        drop(second);
        assert!(!registry.is_spawning(1).await);
    }
}
