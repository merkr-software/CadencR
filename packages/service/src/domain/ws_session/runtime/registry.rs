//! Strong service ownership of each session's runtime cell.
//!
//! The directory lock only selects cells. Runtime work uses the selected
//! session's lock, so a blocked provider never holds up unrelated sessions.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex as StdMutex};

use tokio::sync::{Mutex, MutexGuard, OwnedMutexGuard, OwnedRwLockWriteGuard, RwLock};

use super::detached_closes::{DetachedCloseLease, DetachedCloses};
use super::state::{new_sdk_sessions, QueryState, SdkHandle, SdkSessions};
use crate::domain::ws_session::sender_registry::WsFeatureSenderRegistry;
pub(crate) use launch_fence::LaunchFence;
use launch_fence::LaunchFences;

mod launch_fence;

pub(crate) const APP_QUITTING: &str =
    "Cadencr is still stopping agents for quit. Try again when the stop completes.";
pub(crate) const APP_QUITTING_CODE: &str = "APP_QUITTING";

pub(crate) fn quit_conflict() -> crate::error::AppError {
    crate::error::AppError::coded(
        axum::http::StatusCode::CONFLICT,
        APP_QUITTING_CODE,
        APP_QUITTING,
    )
}

struct RuntimeEntry {
    cell: SdkSessions,
    launch: Arc<Mutex<()>>,
    /// Serializes control commands that switch the live runtime with the cell
    /// released (model, fast mode, permission mode) across connections.
    control: Arc<Mutex<()>>,
    feature_id: Option<i64>,
}

#[derive(Default)]
pub(crate) struct SessionRuntimeRegistry {
    sessions: Mutex<HashMap<i64, RuntimeEntry>>,
    retirement: Mutex<()>,
    detached_closes: DetachedCloses,
    fences: LaunchFences,
    launch_admission: Arc<RwLock<()>>,
    quit_admission: StdMutex<Option<OwnedRwLockWriteGuard<()>>>,
    desktop_owned: AtomicBool,
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
        loop {
            let mut sessions = self.sessions.lock().await;
            // Checked under the directory lock that raising a fence takes, so
            // a cell is either claimed by the fence or bound after it drops.
            if let Some(gate) = feature_id.and_then(|id| self.fences.gate(id)) {
                drop(sessions);
                drop(gate.read().await);
                continue;
            }
            return sessions
                .entry(session_id)
                .or_insert_with(|| RuntimeEntry {
                    cell: candidate.clone(),
                    launch: Arc::default(),
                    control: Arc::default(),
                    feature_id,
                })
                .cell
                .clone();
        }
    }

    /// Claim the session's control commands. Taken before the cell lock and
    /// never while holding it. A session with no registered runtime cell has
    /// no live runtime to race on, so it needs (and creates) no claim.
    pub(crate) async fn claim_control(&self, session_id: i64) -> Option<OwnedMutexGuard<()>> {
        let control = self
            .sessions
            .lock()
            .await
            .get(&session_id)
            .map(|entry| entry.control.clone())?;
        Some(control.lock_owned().await)
    }

    /// Lock `cell` for a spawn of `session_id` once no runtime detached from
    /// it is still closing. The launch claim already waited, but a runtime can
    /// be detached between that wait and this lock; the check under the cell
    /// lock closes the window, since detaching takes the cell lock too.
    pub(crate) async fn lock_settled<'a>(
        &self,
        cell: &'a SdkSessions,
        session_id: i64,
    ) -> MutexGuard<'a, HashMap<i64, SdkHandle>> {
        loop {
            let handles = cell.lock().await;
            if !self.detached_closes.is_pending(session_id) {
                return handles;
            }
            drop(handles);
            self.detached_closes.finished(session_id).await;
        }
    }

    /// Mark a runtime detached from `session_id`'s cell as closing; spawns of
    /// the session wait until the lease drops. Synchronous, for use under the
    /// cell lock.
    pub(crate) fn begin_detached_close(&self, session_id: i64) -> DetachedCloseLease {
        self.detached_closes.begin(session_id)
    }

    /// Serialize only pending-runtime launches. Permission/control commands do
    /// not take this claim, and registration releases it before delivery waits.
    /// A launch also waits for detached closes, so the conversation never
    /// resumes in a second process while the previous one still runs.
    pub(crate) async fn claim_spawn(&self, session_id: i64) -> Option<OwnedMutexGuard<()>> {
        let _admitted = self.launch_admission.try_read().ok()?;
        let launch = self
            .sessions
            .lock()
            .await
            .entry(session_id)
            .or_insert_with(|| RuntimeEntry {
                cell: new_sdk_sessions(),
                launch: Arc::default(),
                control: Arc::default(),
                feature_id: None,
            })
            .launch
            .clone();
        let claim = launch.lock_owned().await;
        self.detached_closes.finished(session_id).await;
        Some(claim)
    }

    pub(crate) fn accepting_prompts(&self) -> bool {
        self.launch_admission.try_read().is_ok()
    }

    /// Let admitted launches settle, then keep new launches from crossing the
    /// desktop's quit until its current runtimes are completely stopped.
    pub(crate) async fn quiesce_launches(&self) -> (Option<OwnedRwLockWriteGuard<()>>, Vec<i64>) {
        let already_fenced = self
            .quit_admission
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .is_some();
        let admission = if already_fenced {
            None
        } else {
            Some(self.launch_admission.clone().write_owned().await)
        };
        let entries: Vec<_> = self
            .sessions
            .lock()
            .await
            .iter()
            .map(|(&id, entry)| (id, entry.launch.clone()))
            .collect();
        let launches = entries.iter().map(|(id, launch)| async move {
            drop(launch.lock().await);
            self.detached_closes.finished(*id).await;
        });
        futures::future::join_all(launches).await;
        (admission, entries.into_iter().map(|(id, _)| id).collect())
    }

    /// A quit may fail after recording the stops. Keep its fence for a retry,
    /// and after a packaged acknowledgement until that service exits.
    pub(crate) fn finish_quit_admission(
        &self,
        admission: Option<OwnedRwLockWriteGuard<()>>,
        stopped: bool,
        accepted: bool,
    ) {
        let mut retained = self
            .quit_admission
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        if stopped && !(accepted && self.desktop_owned.load(Ordering::Relaxed)) {
            drop(retained.take());
        } else if let Some(admission) = admission {
            *retained = Some(admission);
        }
    }

    pub(crate) fn set_desktop_owned(&self) {
        self.desktop_owned.store(true, Ordering::Relaxed);
    }

    /// Wait until no launch of `session_id` holds its claim: the runtime it
    /// started is registered (or the launch failed).
    pub(crate) async fn spawn_settled(&self, session_id: i64) {
        let launch = self
            .sessions
            .lock()
            .await
            .get(&session_id)
            .map(|entry| entry.launch.clone());
        if let Some(launch) = launch {
            drop(launch.lock().await);
        }
    }

    pub(crate) async fn is_spawning(&self, session_id: i64) -> bool {
        self.sessions
            .lock()
            .await
            .get(&session_id)
            .is_some_and(|entry| entry.launch.try_lock().is_err())
    }

    /// Keep the conversations of `feature_ids` from binding a new runtime cell
    /// until the returned fence drops, and hold the launch claim of every
    /// cell they already own, so none of them spawns until the claims drop.
    /// Waits for launches already under way.
    pub(crate) async fn claim_feature_launches(
        &self,
        feature_ids: &std::collections::HashSet<i64>,
    ) -> (LaunchFence, Vec<(i64, SdkSessions, OwnedMutexGuard<()>)>) {
        let (fence, entries) = {
            let sessions = self.sessions.lock().await;
            let fence = self.fences.raise(feature_ids);
            let entries: Vec<_> = sessions
                .iter()
                .filter(|(_, entry)| entry.feature_id.is_some_and(|id| feature_ids.contains(&id)))
                .map(|(&id, entry)| (id, entry.cell.clone(), entry.launch.clone()))
                .collect();
            (fence, entries)
        };
        let mut claims = Vec::with_capacity(entries.len());
        for (id, cell, launch) in entries {
            claims.push((id, cell, launch.lock_owned().await));
        }
        (fence, claims)
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
            self.detached_closes.finished(id).await;
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
    async fn quit_waits_for_an_admitted_launch_and_fences_its_successor() {
        let registry = SessionRuntimeRegistry::new();
        let launch = registry.claim_spawn(4).await.unwrap();
        let mut quit = std::pin::pin!(registry.quiesce_launches());
        assert!(futures::poll!(&mut quit).is_pending());

        drop(launch);
        let (admission, sessions) = quit.await;
        assert_eq!(sessions, [4]);
        assert!(registry.claim_spawn(4).await.is_none());

        drop(admission);
        assert!(registry.claim_spawn(4).await.is_some());
    }

    #[tokio::test]
    async fn a_conversation_of_a_moving_project_binds_once_the_move_is_over() {
        let registry = Arc::new(SessionRuntimeRegistry::new());
        let bound = new_sdk_sessions();
        registry.bind_feature(1, 10, &bound).await;
        let (fence, claims) = registry
            .claim_feature_launches(&std::collections::HashSet::from([10]))
            .await;
        assert_eq!(claims.len(), 1, "the existing cell is claimed");
        let bind = {
            let registry = registry.clone();
            tokio::spawn(async move { registry.bind_feature(2, 10, &new_sdk_sessions()).await })
        };
        let other = registry.bind_feature(3, 11, &new_sdk_sessions()).await;
        tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        assert!(
            !bind.is_finished(),
            "the moving project's conversation waits"
        );
        assert!(registry
            .get(3)
            .await
            .is_some_and(|cell| Arc::ptr_eq(&cell, &other)));

        drop(claims);
        drop(fence);

        tokio::time::timeout(std::time::Duration::from_secs(1), bind)
            .await
            .expect("it binds once the fence dropped")
            .unwrap();
        assert!(registry.get(2).await.is_some());
    }

    #[tokio::test]
    async fn a_launch_waits_for_the_detached_close_of_the_previous_runtime() {
        let registry = Arc::new(SessionRuntimeRegistry::new());
        let close = registry.begin_detached_close(3);
        let launch = {
            let registry = registry.clone();
            tokio::spawn(async move { drop(registry.claim_spawn(3).await.unwrap()) })
        };
        tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        assert!(!launch.is_finished(), "the old runtime is still closing");

        drop(close);

        tokio::time::timeout(std::time::Duration::from_secs(1), launch)
            .await
            .expect("the launch proceeds once the close finished")
            .unwrap();
    }

    #[tokio::test]
    async fn a_spawn_past_its_claim_still_waits_for_a_later_detach() {
        let registry = Arc::new(SessionRuntimeRegistry::new());
        let cell = new_sdk_sessions();
        let claim = registry.claim_spawn(5).await.unwrap();
        // Detached after the claim's own wait, before the spawn reads the cell.
        let close = registry.begin_detached_close(5);
        let read = {
            let (registry, cell) = (registry.clone(), cell.clone());
            tokio::spawn(async move { drop(registry.lock_settled(&cell, 5).await) })
        };
        tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        assert!(!read.is_finished(), "the detached runtime is still closing");

        drop(close);

        tokio::time::timeout(std::time::Duration::from_secs(1), read)
            .await
            .expect("the spawn reads the cell once the close finished")
            .unwrap();
        drop(claim);
    }

    #[tokio::test]
    async fn control_is_claimed_only_for_a_registered_session() {
        let registry = SessionRuntimeRegistry::new();
        assert!(registry.claim_control(8).await.is_none());
        registry.bind(8, &new_sdk_sessions()).await;
        let first = registry.claim_control(8).await.expect("registered session");
        let second = tokio::time::timeout(
            std::time::Duration::from_millis(50),
            registry.claim_control(8),
        )
        .await;
        assert!(second.is_err(), "a second control command waits");
        drop(first);
    }

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
        let first = registry.claim_spawn(1).await.unwrap();
        let queued_registry = registry.clone();
        let queued = tokio::spawn(async move { queued_registry.claim_spawn(1).await.unwrap() });
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
