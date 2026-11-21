//! Logical-turn generations and interruption identity for service-owned runtimes.

use std::collections::HashMap;
use std::sync::{Arc, Weak};

use tokio::sync::{Mutex, OwnedMutexGuard};

use crate::domain::agents::adapter::{RuntimeSessionHandle, RuntimeSessionWeakHandle};
use crate::shared::keyed_locks::KeyedLocks;

use super::followup_stops::FollowupStops;
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
    /// Whether this generation's turn already ended (its stream reader wrote
    /// the end, and saw no turn start since). A stop mark of an ended turn is
    /// never carried into the next one: no result would answer it there.
    ended: bool,
    /// Generation whose stop should let the queue go on once it ends: a gate
    /// closed with "Reject & Stop" ends the turn the gate held, and the next
    /// queued prompt runs, as after a turn that ended by itself.
    queue_after_stop: Option<u64>,
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
    generation_changes: KeyedLocks<i64>,
    followups: FollowupStops,
}

impl ActiveTurnRegistry {
    pub fn new() -> Self {
        Self::default()
    }

    /// Which follow-ups a user Stop cancels (see [`FollowupStops`]).
    pub(crate) fn followups(&self) -> &FollowupStops {
        &self.followups
    }

    /// Record a new logical turn for `db_session_id` in its runtime cell.
    /// Called at every turn start (`mark_agent_running`); a mid-turn respawn
    /// keeps the same owner map, so it does not need to touch the registry.
    pub(crate) async fn begin_turn(&self, db_session_id: i64, owner: &SdkSessions) {
        let _generation = self.lock_turn_generation(db_session_id).await;
        let mut turns = self.turns.lock().await;
        // A stop of a turn still ending is carried, so that turn's late result
        // is not taken for this one's; the mark of a turn that already ended
        // would only swallow this turn's result.
        let (generation, interrupted_turn) = turns
            .get(&db_session_id)
            .map(|turn| {
                let carried = turn.interrupted_turn.clone().filter(|_| !turn.ended);
                (turn.generation.saturating_add(1), carried)
            })
            .unwrap_or((1, None));
        turns.insert(
            db_session_id,
            ActiveTurn {
                owner: Arc::downgrade(owner),
                generation,
                interrupted_turn,
                ended: false,
                queue_after_stop: None,
            },
        );
    }

    /// Keep the generation stable across a detached completion's status and
    /// transcript writes. Other sessions can still begin their own turns.
    pub(super) async fn lock_turn_generation(&self, db_session_id: i64) -> OwnedMutexGuard<()> {
        self.generation_changes
            .lock_for(&db_session_id)
            .await
            .lock_owned()
            .await
    }

    /// The current turn ended (completed, stopped, failed or paused). A stop
    /// mark of it left now came after its end: no result will consume it.
    pub(crate) async fn end_turn(&self, db_session_id: i64) {
        if let Some(turn) = self.turns.lock().await.get_mut(&db_session_id) {
            turn.ended = true;
            if turn
                .interrupted_turn
                .as_ref()
                .is_some_and(|mark| mark.generation == turn.generation)
            {
                turn.interrupted_turn = None;
            }
        }
    }

    /// The runtime started a turn on its own (no prompt began one): it can be
    /// stopped again.
    pub(crate) async fn resume_turn(&self, db_session_id: i64) {
        if let Some(turn) = self.turns.lock().await.get_mut(&db_session_id) {
            turn.ended = false;
        }
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

    /// Once the stopped turn `generation` ends, its stream reader delivers the
    /// next queued prompt (see [`Self::take_queue_after_stop`]).
    pub(crate) async fn queue_after_stop(&self, db_session_id: i64, generation: u64) {
        if let Some(turn) = self.turns.lock().await.get_mut(&db_session_id) {
            if turn.generation == generation {
                turn.queue_after_stop = Some(generation);
            }
        }
    }

    /// Whether the stop that ended `generation` asked for the queue to go on.
    pub(crate) async fn take_queue_after_stop(&self, db_session_id: i64, generation: u64) -> bool {
        let mut turns = self.turns.lock().await;
        let Some(turn) = turns.get_mut(&db_session_id) else {
            return false;
        };
        if turn.queue_after_stop != Some(generation) {
            return false;
        }
        turn.queue_after_stop = None;
        true
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

    /// The newest logical turn's generation for a session.
    pub(crate) async fn current_generation(&self, db_session_id: i64) -> Option<u64> {
        self.turns
            .lock()
            .await
            .get(&db_session_id)
            .map(|turn| turn.generation)
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
    async fn a_detached_completion_only_blocks_a_new_turn_in_its_own_session() {
        let reg = ActiveTurnRegistry::new();
        let owner = empty_sessions();
        reg.begin_turn(42, &owner).await;
        let completing = reg.lock_turn_generation(42).await;
        let new_turn = reg.begin_turn(42, &owner);
        tokio::pin!(new_turn);
        assert!(futures::poll!(new_turn.as_mut()).is_pending());

        reg.begin_turn(43, &owner).await;
        assert_eq!(reg.current_generation(42).await, Some(1));
        assert_eq!(reg.current_generation(43).await, Some(1));
        drop(completing);

        new_turn.await;
        assert_eq!(reg.current_generation(42).await, Some(2));
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
    async fn a_stop_of_a_turn_that_ended_is_not_carried_into_the_next() {
        let reg = ActiveTurnRegistry::new();
        let owner = empty_sessions();
        let runtime = runtime_session();
        reg.begin_turn(42, &owner).await;
        reg.end_turn(42).await;

        assert!(reg.request_interruption(42, &runtime).await.is_some());
        reg.begin_turn(42, &owner).await;
        assert_eq!(
            reg.take_interruption(42, &Arc::downgrade(&runtime)).await,
            None
        );
    }

    /// A turn the CLI opens itself after the last one ended (no prompt began
    /// it): a Stop during it is marked and its interrupted result consumes it,
    /// even after a prompt queued meanwhile began the next generation.
    #[tokio::test]
    async fn a_stop_of_a_turn_the_runtime_opened_itself_still_counts() {
        let reg = ActiveTurnRegistry::new();
        let owner = empty_sessions();
        let runtime = runtime_session();
        reg.begin_turn(42, &owner).await;
        reg.end_turn(42).await;
        reg.resume_turn(42).await;

        let stopped = reg.request_interruption(42, &runtime).await;
        reg.begin_turn(42, &owner).await;
        assert_eq!(
            reg.take_interruption(42, &Arc::downgrade(&runtime)).await,
            stopped
        );
    }

    /// The mark landed between the reader's look for one at the result and the
    /// turn's end: neither the next turn nor a later result may consume it.
    /// A turn the runtime starts on its own can be stopped again.
    #[tokio::test]
    async fn a_mark_left_by_a_turn_that_ended_is_dropped() {
        let reg = ActiveTurnRegistry::new();
        let owner = empty_sessions();
        let runtime = runtime_session();
        reg.begin_turn(42, &owner).await;
        reg.request_interruption(42, &runtime).await.unwrap();
        reg.end_turn(42).await;
        assert_eq!(
            reg.take_interruption(42, &Arc::downgrade(&runtime)).await,
            None
        );

        reg.resume_turn(42).await;
        let stopped = reg.request_interruption(42, &runtime).await;
        assert!(stopped.is_some());
        assert_eq!(
            reg.take_interruption(42, &Arc::downgrade(&runtime)).await,
            stopped
        );
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
