//! Logical-turn generations and interruption identity for service-owned runtimes.

use std::collections::HashMap;
use std::sync::{Arc, Weak};

use tokio::sync::Mutex;

use crate::domain::agents::adapter::{RuntimeSessionHandle, RuntimeSessionWeakHandle};

use super::state::{QueryState, SdkHandle, SdkSessions};

/// Inner of [`SdkSessions`] (`Arc<Mutex<HashMap<i64, SdkHandle>>>`) — the
/// target a [`Weak`] points at.
type SdkSessionsInner = Mutex<HashMap<i64, SdkHandle>>;

struct ActiveTurn {
    /// Weak handle to the service registry's canonical runtime cell.
    /// Releasing an idle cell makes its logical-turn entry inert.
    owner: Weak<SdkSessionsInner>,
    /// Monotonic logical-turn generation. A stop can race with a new prompt;
    /// the generation lets the old turn finish without marking the newer turn
    /// idle.
    generation: u64,
    /// Generation explicitly interrupted by the user. Provider runtimes may
    /// report that normal control action as an error result or a closed stream;
    /// the stream reader consumes this marker and treats it as benign.
    interrupted_turn: Option<InterruptedTurn>,
}

#[derive(Clone)]
struct InterruptedTurn {
    generation: u64,
    runtime: RuntimeSessionWeakHandle,
}

/// Maps `agent_sessions.id` to its canonical runtime cell and logical turn.
#[derive(Default)]
pub struct ActiveTurnRegistry {
    turns: Mutex<HashMap<i64, ActiveTurn>>,
}

impl ActiveTurnRegistry {
    pub fn new() -> Self {
        Self::default()
    }

    /// Record a new logical turn for `db_session_id` in its runtime cell.
    /// Called at every turn start (`mark_agent_running`); a mid-turn respawn
    /// keeps the same owner map, so it does not need to touch the registry.
    pub(crate) async fn begin_turn(&self, db_session_id: i64, owner: &SdkSessions) {
        let mut turns = self.turns.lock().await;
        let (generation, interrupted_turn) = turns
            .get(&db_session_id)
            .map(|turn| {
                (
                    turn.generation.saturating_add(1),
                    turn.interrupted_turn.clone(),
                )
            })
            .unwrap_or((1, None));
        turns.insert(
            db_session_id,
            ActiveTurn {
                owner: Arc::downgrade(owner),
                generation,
                interrupted_turn,
            },
        );
    }

    /// Mark the current logical turn as intentionally interrupted. Returns its
    /// generation so the caller can clear the exact marker if the control
    /// request itself fails.
    pub(crate) async fn request_interruption(
        &self,
        db_session_id: i64,
        runtime: &RuntimeSessionHandle,
    ) -> Option<u64> {
        let mut turns = self.turns.lock().await;
        let turn = turns.get_mut(&db_session_id)?;
        turn.interrupted_turn = Some(InterruptedTurn {
            generation: turn.generation,
            runtime: Arc::downgrade(runtime),
        });
        Some(turn.generation)
    }

    /// Consume the one-shot interruption marker only from the stream reader
    /// that owns the interrupted runtime. A replacement reader must never
    /// consume the older runtime's marker.
    pub(crate) async fn take_interruption(
        &self,
        db_session_id: i64,
        runtime: &RuntimeSessionWeakHandle,
    ) -> Option<u64> {
        let mut turns = self.turns.lock().await;
        let turn = turns.get_mut(&db_session_id)?;
        let interrupted = turn.interrupted_turn.as_ref()?;
        if !Weak::ptr_eq(&interrupted.runtime, runtime) {
            return None;
        }
        turn.interrupted_turn.take().map(|turn| turn.generation)
    }

    /// Clear a marker only when it still belongs to the failed control request.
    pub(crate) async fn clear_interruption(
        &self,
        db_session_id: i64,
        generation: u64,
        runtime: &RuntimeSessionHandle,
    ) -> bool {
        let mut turns = self.turns.lock().await;
        let Some(turn) = turns.get_mut(&db_session_id) else {
            return false;
        };
        let Some(interrupted) = turn.interrupted_turn.as_ref() else {
            return false;
        };
        let runtime = Arc::downgrade(runtime);
        if interrupted.generation == generation && Weak::ptr_eq(&interrupted.runtime, &runtime) {
            turn.interrupted_turn = None;
            return true;
        }
        false
    }

    /// Whether `generation` still identifies the newest prompt for a session.
    pub(crate) async fn is_current_generation(&self, db_session_id: i64, generation: u64) -> bool {
        self.turns
            .lock()
            .await
            .get(&db_session_id)
            .is_some_and(|turn| turn.generation == generation)
    }

    /// Resolve the runtime cell for a live logical turn. The service registry
    /// keeps it alive independently of connected clients.
    pub(crate) async fn owner_sessions(&self, db_session_id: i64) -> Option<SdkSessions> {
        let mut turns = self.turns.lock().await;
        let entry = turns.get(&db_session_id)?;
        match entry.owner.upgrade() {
            Some(arc) => Some(arc),
            None => {
                turns.remove(&db_session_id);
                None
            }
        }
    }

    pub(crate) async fn requires_prompt_queue(&self, session_id: i64) -> bool {
        let Some(owner) = self.owner_sessions(session_id).await else {
            return false;
        };
        let query = {
            let sessions = owner.lock().await;
            let Some(handle) = sessions.get(&session_id) else {
                return false;
            };
            if handle
                .manual_compact_spawn_pending
                .load(std::sync::atomic::Ordering::SeqCst)
            {
                return true;
            }
            let QueryState::Active { query, .. } = &handle.state else {
                return false;
            };
            query.clone()
        };
        let runtime = query.read().await;
        runtime.requires_prompt_queue()
    }

    /// Pid of every live agent process, keyed to the feature it serves.
    ///
    /// Read straight from the authoritative runtime cells rather than from
    /// a registration side-table, so a runtime respawned mid-session (model
    /// change, resume, compaction) is always reported under its current pid. A
    /// map or runtime that is busy is skipped instead of waited on: this only
    /// feeds port attribution, which re-runs seconds later.
    pub(crate) async fn agent_process_owners(&self) -> HashMap<i32, i64> {
        let owners = self.live_owners().await;
        let mut pids = HashMap::new();
        for sessions in owners {
            let Ok(sessions) = sessions.try_lock() else {
                continue;
            };
            for handle in sessions.values() {
                let QueryState::Active { query, .. } = &handle.state else {
                    continue;
                };
                let Ok(runtime) = query.try_read() else {
                    continue;
                };
                if let Some(pid) = runtime.pid() {
                    pids.insert(pid as i32, handle.feature_id);
                }
            }
        }
        pids
    }

    /// The distinct service runtime cells still reachable from the registry.
    /// Collected under the registry lock and returned before any of them is
    /// locked, since handlers can hold a cell while updating logical turns.
    async fn live_owners(&self) -> Vec<SdkSessions> {
        let mut turns = self.turns.lock().await;
        turns.retain(|_, turn| turn.owner.strong_count() > 0);
        let mut seen = Vec::new();
        let mut owners = Vec::new();
        for turn in turns.values() {
            let Some(owner) = turn.owner.upgrade() else {
                continue;
            };
            let key = Arc::as_ptr(&owner) as usize;
            if seen.contains(&key) {
                continue;
            }
            seen.push(key);
            owners.push(owner);
        }
        owners
    }

    /// Drop every entry for a released runtime cell.
    #[cfg(test)]
    pub(crate) async fn remove_owned_by(&self, owner: &SdkSessions) {
        // Compare by address-as-`usize` rather than holding a raw pointer
        // across the lock `.await` (a raw pointer is `!Send`, which would
        // poison the whole connection future).
        let target = Arc::as_ptr(owner) as usize;
        let mut turns = self.turns.lock().await;
        turns.retain(|_, t| match t.owner.upgrade() {
            Some(arc) => Arc::as_ptr(&arc) as usize != target,
            None => false,
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap as StdHashMap;

    fn empty_sessions() -> SdkSessions {
        Arc::new(Mutex::new(StdHashMap::new()))
    }

    #[tokio::test]
    async fn begin_turn_records_owner() {
        let reg = ActiveTurnRegistry::new();
        let owner = empty_sessions();
        reg.begin_turn(42, &owner).await;

        assert!(reg.owner_sessions(42).await.is_some());
    }

    #[tokio::test]
    async fn interruption_survives_a_racing_new_turn_but_stays_scoped_to_the_old_one() {
        let reg = ActiveTurnRegistry::new();
        let owner = empty_sessions();
        let runtime = runtime_session();
        reg.begin_turn(42, &owner).await;
        let interrupted = reg.request_interruption(42, &runtime).await.unwrap();

        reg.begin_turn(42, &owner).await;

        assert_eq!(
            reg.take_interruption(42, &Arc::downgrade(&runtime)).await,
            Some(interrupted)
        );
        assert!(!reg.is_current_generation(42, interrupted).await);
    }

    #[tokio::test]
    async fn replacement_runtime_cannot_consume_an_older_interruption() {
        let reg = ActiveTurnRegistry::new();
        let owner = empty_sessions();
        let interrupted_runtime = runtime_session();
        let replacement_runtime = runtime_session();
        reg.begin_turn(42, &owner).await;
        let interrupted = reg
            .request_interruption(42, &interrupted_runtime)
            .await
            .unwrap();
        reg.begin_turn(42, &owner).await;

        assert_eq!(
            reg.take_interruption(42, &Arc::downgrade(&replacement_runtime))
                .await,
            None
        );
        assert_eq!(
            reg.take_interruption(42, &Arc::downgrade(&interrupted_runtime))
                .await,
            Some(interrupted)
        );
    }

    #[tokio::test]
    async fn failed_interrupt_clears_only_its_own_marker() {
        let reg = ActiveTurnRegistry::new();
        let owner = empty_sessions();
        let runtime = runtime_session();
        reg.begin_turn(42, &owner).await;
        let interrupted = reg.request_interruption(42, &runtime).await.unwrap();

        assert!(reg.clear_interruption(42, interrupted, &runtime).await);

        assert_eq!(
            reg.take_interruption(42, &Arc::downgrade(&runtime)).await,
            None
        );
    }

    #[tokio::test]
    async fn dropped_owner_makes_entry_inert() {
        let reg = ActiveTurnRegistry::new();
        let owner = empty_sessions();
        reg.begin_turn(7, &owner).await;
        drop(owner);

        assert!(reg.owner_sessions(7).await.is_none());
    }

    #[tokio::test]
    async fn remove_owned_by_drops_only_matching_entries() {
        let reg = ActiveTurnRegistry::new();
        let a = empty_sessions();
        let b = empty_sessions();
        reg.begin_turn(1, &a).await;
        reg.begin_turn(2, &b).await;

        reg.remove_owned_by(&a).await;

        assert!(reg.owner_sessions(1).await.is_none());
        assert!(reg.owner_sessions(2).await.is_some());
    }

    fn runtime_session() -> RuntimeSessionHandle {
        Arc::new(tokio::sync::RwLock::new(Box::new(
            crate::domain::agents::adapter::DummySession,
        )))
    }
}
