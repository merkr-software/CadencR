//! Telling a later restart that this runtime owes the agent a resume.
//!
//! Between turns the session is not `running`, yet the runtime may still run
//! background work and start the next turn on its own once it settles (see
//! [`super::runtime_hold`]). A restart kills that work with the runtime, so
//! the reader records the conversation for the restart capture
//! ([`crate::domain::restart_continuations`]) for as long as the hold owes
//! that resume: until the resume turn starts (it is then the turn a restart
//! cuts off), or the user stops the agent.

use chrono::{DateTime, Utc};

use crate::domain::restart_continuations::{
    end_background_work, is_shutting_down, write_background_work,
};

use super::stream_reader_task::{StreamReaderState, StreamReaderTask};

/// What a failed record is reported as.
const WHAT: &str = "background work state";

impl StreamReaderTask {
    /// Record the conversation when the hold starts or stops owing a resume.
    /// Runs once each event is fully handled and on every idle tick, so the
    /// record clears once the grace runs out (or a user stop lands) and a
    /// failed write is retried.
    ///
    /// At every moment a restart must find either this record or a `running`
    /// session it captures as a turn: once the resume turn has started, the
    /// record is only dropped after `running` reached the database.
    pub(super) async fn sync_background_work(&self, state: &mut StreamReaderState) {
        let Some(owed) = state.runtime_hold.background_work_owed() else {
            return;
        };
        if owed == state.background_work_recorded {
            return;
        }
        if owed {
            self.record(state, Some(chrono::Utc::now())).await;
            if !state.runtime_hold.owes_resume() {
                self.record(state, None).await;
            }
        } else if state.turn_state.is_between_turns() || self.running_persisted(state).await {
            self.record(state, None).await;
        }
    }

    /// Whether the session row says `running`. A failed read keeps the record
    /// (the next event or tick retries) and is reported like a failed write.
    async fn running_persisted(&self, state: &mut StreamReaderState) -> bool {
        let status =
            sqlx::query_scalar::<_, String>("SELECT status FROM agent_sessions WHERE id = ?")
                .bind(self.db_session_id)
                .fetch_one(&self.write_pool)
                .await;
        let running = status.as_ref().is_ok_and(|status| status == "running");
        self.report_usage_write(
            &mut state.background_work_save_failed,
            WHAT,
            status.map(|_| false),
        )
        .await;
        running
    }

    /// The runtime is gone, and the work it owed a resume for with it. A
    /// shutdown captured the conversation before closing the runtime; this
    /// covers one it missed (its capture failed, or the work started during
    /// the drain), the way a stream reader captures a turn shutdown cut off.
    /// When that capture fails too, the record stays: it is the only trace
    /// left, and the next start captures it as a crash.
    pub(super) async fn forget_background_work(&self, state: &mut StreamReaderState) {
        self.forget_background_work_when(state, is_shutting_down())
            .await;
    }

    async fn forget_background_work_when(
        &self,
        state: &mut StreamReaderState,
        shutting_down: bool,
    ) {
        if !state.background_work_recorded {
            return;
        }
        let written = end_background_work(
            &self.write_pool,
            self.db_session_id,
            &self.signals.reader_id.to_string(),
            shutting_down,
        )
        .await;
        self.report_usage_write(
            &mut state.background_work_save_failed,
            WHAT,
            written.map(|()| true),
        )
        .await;
    }

    async fn record(&self, state: &mut StreamReaderState, owed_since: Option<DateTime<Utc>>) {
        // The cell protects publication against a runtime replacement. A
        // retiring reader can still delete its own row without the cell.
        let cell = if owed_since.is_some() {
            let cell = self.sdk_sessions.lock().await;
            if !self.owns_runtime(cell.get(&self.db_session_id)) {
                return;
            }
            Some(cell)
        } else {
            None
        };
        let written = write_background_work(
            &self.write_pool,
            self.db_session_id,
            &self.signals.reader_id.to_string(),
            owed_since,
        )
        .await;
        drop(cell);
        if let Ok(recorded) = &written {
            state.background_work_recorded = *recorded;
        }
        self.report_usage_write(
            &mut state.background_work_save_failed,
            WHAT,
            written.map(|_| true),
        )
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

    async fn reader_task() -> (StreamReaderTask, RuntimeSessionHandle) {
        let (task, runtime, _) = super::super::stream_reader_idle::tests::idle_task().await;
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

    #[tokio::test]
    async fn another_running_signal_for_the_same_turn_keeps_its_stop() {
        let (task, _runtime) = reader_task().await;
        task.record_running().await;
        crate::domain::restart_continuations::record_user_stop(
            &task.write_pool,
            task.db_session_id,
            chrono::Utc::now(),
        )
        .await
        .unwrap();

        task.record_running().await;

        let pending: bool =
            sqlx::query_scalar("SELECT marker_pending FROM agent_user_stops WHERE session_id = ?")
                .bind(task.db_session_id)
                .fetch_one(&task.write_pool)
                .await
                .unwrap();
        assert!(pending, "an intermediate status is not a successor turn");
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

    /// Once the resume turn starts the record is no longer owed, but it stays
    /// until `running` is saved: a restart must always find one or the other.
    #[tokio::test]
    async fn the_record_outlives_the_resume_turn_start_until_running_is_saved() {
        let (task, _runtime) = reader_task().await;
        let mut state = fresh_state();
        state.runtime_hold.observe(&tasks(1), false);
        state.runtime_hold.observe(&tasks(0), false);
        task.sync_background_work(&mut state).await;
        assert!(recorded(&task).await);

        let turn_started = RuntimeEvent::new(
            RuntimeEventMetadata::default(),
            RuntimeEventKind::TurnStarted {
                source: crate::domain::agents::adapter::RuntimeTurnStartedSource::ProviderActivity,
            },
        );
        state.runtime_hold.observe(&turn_started, false);
        state.turn_state.mark_fresh_turn_started();
        task.sync_background_work(&mut state).await;
        assert!(recorded(&task).await, "the session is not `running` yet");

        sqlx::query("UPDATE agent_sessions SET status = 'running' WHERE id = ?")
            .bind(task.db_session_id)
            .execute(&task.write_pool)
            .await
            .unwrap();
        task.sync_background_work(&mut state).await;
        assert!(!recorded(&task).await);
    }

    /// A user Stop ends any resume the conversation was owed, even though
    /// the background task keeps running.
    #[tokio::test]
    async fn a_user_stop_forgets_the_record() {
        let (task, runtime) = reader_task().await;
        let mut state = fresh_state();
        let _registration = super::super::runtime_hold_registry::register(
            task.db_session_id,
            &std::sync::Arc::downgrade(&runtime),
            &state.runtime_hold,
        );
        state.runtime_hold.observe(&tasks(1), true);
        task.sync_background_work(&mut state).await;
        assert!(recorded(&task).await);

        super::super::runtime_hold_registry::stop_by_user(task.db_session_id, &runtime);
        task.sync_background_work(&mut state).await;

        assert!(!recorded(&task).await);
    }

    /// When shutdown could not capture the conversation, its record is the
    /// only trace left: the next start captures it as a crash.
    #[tokio::test]
    async fn a_failed_shutdown_capture_keeps_the_record() {
        let (task, _runtime) = reader_task().await;
        let mut state = fresh_state();
        state.runtime_hold.observe(&tasks(1), false);
        task.sync_background_work(&mut state).await;
        sqlx::query("DROP TABLE IF EXISTS restart_continuations")
            .execute(&task.write_pool)
            .await
            .unwrap();

        task.forget_background_work_when(&mut state, true).await;

        assert!(recorded(&task).await);
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
