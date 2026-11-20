//! Telling a later restart that this runtime owes the agent a resume.
//!
//! Between turns the session is not `running`, yet the runtime may still run
//! background work and start the next turn on its own once it settles (see
//! [`super::runtime_hold`]). A restart kills that work with the runtime, so
//! the reader records the conversation for the restart capture
//! ([`crate::domain::restart_continuations`]) for as long as the hold keeps
//! the runtime: its grace covers the gap between the work settling and the
//! resume turn marking the session `running`.

use crate::domain::restart_continuations::{
    capture_cut_off_turn, is_shutting_down, record_background_work,
};

use super::stream_reader_task::{StreamReaderState, StreamReaderTask};

/// What a failed record is reported as.
const WHAT: &str = "background work state";

impl StreamReaderTask {
    /// Record the conversation when the hold starts or stops owing a resume.
    /// Runs after every event and on every idle tick, so the record clears
    /// once the grace runs out and a failed write is retried.
    pub(super) async fn sync_background_work(&self, state: &mut StreamReaderState) {
        let held = state.runtime_hold.holds_runtime();
        if held != state.background_work_recorded {
            self.record(state, held).await;
        }
    }

    /// The runtime is gone, and the work it owed a resume for with it. A
    /// shutdown captured the conversation before closing the runtime; this
    /// covers one it missed (its capture failed, or the work started during
    /// the drain), the way a stream reader captures a turn shutdown cut off.
    pub(super) async fn forget_background_work(&self, state: &mut StreamReaderState) {
        if !state.background_work_recorded {
            return;
        }
        if is_shutting_down() {
            capture_cut_off_turn(&self.write_pool, self.db_session_id).await;
        }
        self.record(state, false).await;
    }

    async fn record(&self, state: &mut StreamReaderState, owed: bool) {
        let written = record_background_work(&self.write_pool, self.db_session_id, owed)
            .await
            .map(|()| true);
        if written.is_ok() {
            state.background_work_recorded = owed;
        }
        self.report_usage_write(&mut state.background_work_save_failed, WHAT, written)
            .await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::agents::adapter::{
        RuntimeEvent, RuntimeEventKind, RuntimeEventMetadata, RuntimeSessionHandle,
    };
    use crate::domain::runtime_stream::RuntimeUsageSnapshot;

    fn tasks(live: usize) -> RuntimeEvent {
        RuntimeEvent::new(RuntimeEventMetadata::default(), RuntimeEventKind::Other)
            .with_background_task_count(Some(live))
    }

    fn fresh_state() -> StreamReaderState {
        StreamReaderState::new(RuntimeUsageSnapshot {
            input_tokens: 0,
            output_tokens: 0,
            context_window: None,
        })
    }

    /// The idle-reader fixture's hand-made schema predates the table.
    async fn reader_task() -> (StreamReaderTask, RuntimeSessionHandle) {
        let (task, runtime, _) = super::super::stream_reader_idle::tests::idle_task().await;
        sqlx::query("CREATE TABLE agent_background_work (session_id INTEGER PRIMARY KEY)")
            .execute(&task.write_pool)
            .await
            .unwrap();
        (task, runtime)
    }

    async fn recorded(task: &StreamReaderTask) -> bool {
        sqlx::query_scalar::<_, i64>(
            "SELECT COUNT(*) FROM agent_background_work WHERE session_id = ?",
        )
        .bind(task.db_session_id)
        .fetch_one(&task.write_pool)
        .await
        .unwrap()
            == 1
    }

    /// The conversation stays recorded through the resume grace: when the
    /// work settles, the resume turn has not marked the session `running` yet.
    #[tokio::test]
    async fn records_background_work_until_the_hold_releases_the_runtime() {
        let (task, _runtime) = reader_task().await;
        let mut state = fresh_state();

        state.runtime_hold.observe(&tasks(1), false);
        task.sync_background_work(&mut state).await;
        assert!(recorded(&task).await);

        state.runtime_hold.observe(&tasks(0), false);
        task.sync_background_work(&mut state).await;
        assert!(recorded(&task).await, "the resume grace still holds it");

        task.forget_background_work(&mut state).await;
        assert!(!recorded(&task).await, "an ended reader forgets it");
    }

    #[tokio::test]
    async fn a_failed_record_is_retried_on_the_next_sync() {
        let (task, _runtime) = reader_task().await;
        let mut state = fresh_state();
        state.runtime_hold.observe(&tasks(1), false);
        sqlx::query("ALTER TABLE agent_background_work RENAME TO unavailable")
            .execute(&task.write_pool)
            .await
            .unwrap();

        task.sync_background_work(&mut state).await;
        assert!(!state.background_work_recorded);
        assert!(state.background_work_save_failed);

        sqlx::query("ALTER TABLE unavailable RENAME TO agent_background_work")
            .execute(&task.write_pool)
            .await
            .unwrap();
        task.sync_background_work(&mut state).await;
        assert!(recorded(&task).await);
        assert!(!state.background_work_save_failed);
    }
}
