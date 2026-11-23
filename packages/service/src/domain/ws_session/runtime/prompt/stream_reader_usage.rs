use std::collections::HashSet;

use tokio::time::Instant;

use crate::domain::agents::adapter::RuntimeEvent;
use crate::domain::runtime_stream::{RuntimeUsageSnapshot, RuntimeUsageState};

use super::stream_reader_task::{StreamReaderState, StreamReaderTask};
use super::stream_reader_turn_state::StreamTurnState;
use crate::domain::ws_session::protocol::{SessionUsageUpdatePayload, WsEnvelope, WsSessionEvent};
use crate::domain::ws_session::runtime::helpers::report_session_write_failure;
use axum::extract::ws::Message;

impl StreamReaderState {
    pub(in crate::domain::ws_session) fn new(initial_usage: RuntimeUsageSnapshot) -> Self {
        Self {
            runtime_session_id: None,
            usage_state: RuntimeUsageState::new(initial_usage),
            usage_attribution: None,
            usage_attribution_captured: false,
            provider_usage_event_id: None,
            canonical_projection:
                crate::domain::agents::canonical::CanonicalSessionProjection::default(),
            last_runtime_activity: Instant::now(),
            last_provider_reconcile: Instant::now(),
            turn_state: StreamTurnState::new(),
            live_background_agents: HashSet::new(),
            runtime_hold: Default::default(),
            message_seq: 0,
            received_prompt_message_uuids: Vec::new(),
            diagnostics: super::stream_diagnostics::StreamDiagnostics::new(),
            subagents: Default::default(),
            reported_model: None,
            token_usage_save_failed: false,
            background_work_recorded: false,
            background_work_save_failed: false,
            context_window_save_failed: false,
        }
    }
}

/// The error to report for a write in a failure streak tracked by `failing`:
/// only the first failure; a write that ran and succeeded ends the streak.
fn first_failure_of_streak<E: std::fmt::Display>(
    failing: &mut bool,
    saved: Result<bool, E>,
) -> Option<E> {
    match saved {
        Ok(true) => {
            *failing = false;
            None
        }
        Ok(false) => None,
        Err(error) if *failing => {
            tracing::debug!(%error, "session usage still not saved");
            None
        }
        Err(error) => {
            *failing = true;
            Some(error)
        }
    }
}

impl StreamReaderTask {
    /// Surface a failed usage (or background-work) write once per failure
    /// streak: usage changes on most streamed events, and the background-work
    /// record is retried every idle tick, so a broken database must not flood
    /// every viewer with one error per attempt. `saved` is `Ok(false)` when there was
    /// nothing to write, which neither ends nor extends the streak.
    pub(in crate::domain::ws_session) async fn report_usage_write(
        &self,
        failing: &mut bool,
        what: &str,
        saved: Result<bool, sqlx::Error>,
    ) {
        if let Some(error) = first_failure_of_streak(failing, saved) {
            report_session_write_failure(
                &self.feature_senders,
                self.feature_id,
                self.db_session_id,
                what,
                &error,
            )
            .await;
        }
    }

    /// Capture what this turn's provider token report should be attributed to.
    pub(in crate::domain::ws_session) async fn capture_usage_attribution(
        &self,
        state: &mut StreamReaderState,
        event: &RuntimeEvent,
    ) {
        let starts_turn = event.stream_event().is_some()
            || event.assistant_message().is_some()
            || event.turn_started_source().is_some()
            || event.token_usage().is_some();
        if state.usage_attribution_captured || !starts_turn {
            return;
        }
        state.usage_attribution =
            crate::domain::usage_stats::snapshot_attribution(&self.write_pool, self.db_session_id)
                .await;
        state.usage_attribution_captured = true;
    }

    pub(in crate::domain::ws_session) async fn record_token_usage(
        &self,
        state: &mut StreamReaderState,
        event: &RuntimeEvent,
    ) {
        let Some(mut usage) = event.token_usage().cloned() else {
            return;
        };
        usage.normalize_root_scope(state.runtime_session_id.as_deref());
        usage.correlate_event_id(
            || {
                state
                    .provider_usage_event_id
                    .as_deref()
                    .map(crate::domain::usage_stats::provider_message_event_id)
            },
            state
                .received_prompt_message_uuids
                .first()
                .map(String::as_str),
        );
        crate::domain::usage_stats::record_runtime_usage(
            &self.write_pool,
            self.db_session_id,
            state.usage_attribution.clone(),
            usage,
        )
        .await;
    }

    pub(in crate::domain::ws_session) fn capture_provider_usage_event_id(
        &self,
        state: &mut StreamReaderState,
        event: &RuntimeEvent,
    ) {
        if state.provider_usage_event_id.is_some() {
            return;
        }
        state.provider_usage_event_id = event.provider_message_id().map(ToOwned::to_owned);
    }

    /// Seed live context usage from the persisted session snapshot.
    pub(in crate::domain::ws_session) async fn initial_usage_snapshot(
        &self,
    ) -> RuntimeUsageSnapshot {
        // A failed read is already reported (alone or as part of a reported
        // failure streak): seed from zero.
        let row = self
            .read_session_row("Its context usage restarts from zero until the next update.")
            .await
            .unwrap_or(None);
        let persisted = |value: Option<i64>| value.and_then(|v| u64::try_from(v).ok()).unwrap_or(0);
        let context_window = match self.provider_context_window {
            Some(cw) if cw > 0 => Some(cw),
            _ => row
                .as_ref()
                .and_then(|row| row.context_window)
                .and_then(|cw| u64::try_from(cw).ok())
                .filter(|cw| *cw > 0),
        };
        RuntimeUsageSnapshot {
            input_tokens: persisted(row.as_ref().and_then(|row| row.input_tokens)),
            output_tokens: persisted(row.as_ref().and_then(|row| row.output_tokens)),
            context_window,
        }
    }
}

impl StreamReaderTask {
    pub(in crate::domain::ws_session) async fn send_usage_update(
        &self,
        input_tokens: u64,
        output_tokens: u64,
        context_window: Option<u64>,
    ) {
        let usage_env =
            WsEnvelope::session_event(&WsSessionEvent::UsageUpdate(SessionUsageUpdatePayload {
                input_tokens,
                output_tokens,
                context_window,
            }))
            .expect("session event payload should serialize");
        self.publish(Message::Text(String::from(usage_env).into()))
            .await;
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;
    use std::time::Duration;

    use super::*;
    use crate::domain::agents::acp::runtime::{
        spawn_acp_runtime_session, AcpRuntimeSpawnArgs, StandardAcpHooks,
    };
    use crate::domain::agents::acp::{AcpClientInfo, AcpProcessTreePolicy, AcpStderrPolicy};
    use crate::domain::agents::adapter::{
        RuntimeEventKind, RuntimeEventMetadata, RuntimeMessageRx, RuntimeSpawnConfig,
    };
    use crate::domain::ws_session::persistence::WsSessionPersistence;
    use serde_json::{json, Value};
    use tokio::process::Command;
    use uuid::Uuid;

    async fn next_runtime_event(events: &mut RuntimeMessageRx) -> RuntimeEvent {
        tokio::time::timeout(Duration::from_secs(10), events.recv())
            .await
            .expect("ACP usage event timed out")
            .expect("ACP event stream closed early")
            .expect("ACP fixture returned an error")
    }

    async fn wait_for_context(events: &mut RuntimeMessageRx, input_tokens: u64) {
        loop {
            let event = next_runtime_event(events).await;
            if event
                .usage()
                .is_some_and(|usage| usage.input_tokens == input_tokens)
            {
                assert!(event.token_usage().is_none());
                return;
            }
        }
    }

    async fn usage_bucket(task: &StreamReaderTask) -> (i64, i64) {
        sqlx::query_as(
            "SELECT input_tokens, output_tokens FROM provider_usage_stats
             WHERE provider_id = 'antigravity' AND model_id = 'gemini-3.8-flash'",
        )
        .fetch_one(&task.write_pool)
        .await
        .unwrap()
    }

    #[tokio::test]
    async fn overlapping_acp_prompt_usage_is_persisted_once_per_response() {
        let cwd = tempfile::tempdir().unwrap();
        let mut command = Command::new("python3");
        command
            .arg(concat!(
                env!("CARGO_MANIFEST_DIR"),
                "/tests/fixtures/fake_acp_steering_usage.py"
            ))
            .kill_on_drop(true);
        let mut session = spawn_acp_runtime_session(AcpRuntimeSpawnArgs {
            command,
            spawn_guard: None,
            wire_transform: None,
            client_info: AcpClientInfo::default(),
            stderr_policy: AcpStderrPolicy::Log,
            process_tree_policy: AcpProcessTreePolicy::Inherit,
            config: RuntimeSpawnConfig {
                cwd: cwd.path().to_path_buf(),
                ..Default::default()
            },
            initial_content: Value::String("P1".into()),
            context_window: None,
            hooks: Arc::new(StandardAcpHooks),
            wire_transform: None,
        })
        .await
        .unwrap();
        let mut events = session.take_message_rx();
        wait_for_context(&mut events, 1).await;

        let (task, _idle_runtime, _) = super::super::stream_reader_idle::tests::idle_task().await;
        let pool = &task.write_pool;
        let db_session = task.db_session_id;
        sqlx::query(
            "UPDATE agent_sessions SET runtime_provider = 'antigravity',
                     model = 'gemini-3.8-flash' WHERE id = ?",
        )
        .bind(db_session)
        .execute(pool)
        .await
        .unwrap();
        let mut persistence =
            WsSessionPersistence::with_session_id(pool.clone(), task.feature_id, Some(db_session));
        let receipts = [Uuid::new_v4(), Uuid::new_v4()];
        for (text, id) in ["P2", "P3"].into_iter().zip(receipts) {
            persistence
                .persist_user_message_with_delivery(text, id, Some("pending_agent"))
                .await
                .unwrap();
        }
        let mut state = StreamReaderState::new(task.initial_usage_snapshot().await);
        task.capture_provider_usage_event_id(
            &mut state,
            &RuntimeEvent::new(RuntimeEventMetadata::default(), RuntimeEventKind::Other)
                .with_provider_message_id(Some("earlier-provider-message".into())),
        );

        let mut session = Arc::new(session);
        let submit = |text: &'static str, id: Uuid| {
            let session = Arc::clone(&session);
            tokio::spawn(async move {
                session
                    .stream_input_with_client_message_id(json!(text), Some(id.to_string()))
                    .await
                    .unwrap();
            })
        };
        let second = submit("P2", receipts[0]);
        wait_for_context(&mut events, 2).await;
        let third = submit("P3", receipts[1]);
        let mut accounting_events = Vec::new();
        let mut saw_both_receipts = false;
        let mut finished = false;
        while !finished {
            let event = next_runtime_event(&mut events).await;
            if event.token_usage().is_some() {
                assert_eq!(
                    state.provider_usage_event_id.as_deref(),
                    Some("earlier-provider-message")
                );
                saw_both_receipts |= receipts.iter().all(|id| {
                    state
                        .received_prompt_message_uuids
                        .contains(&id.to_string())
                });
                accounting_events.push(event.clone());
            }
            finished = event.is_result();
            task.handle_runtime_event(&mut state, None, &mut persistence, event)
                .await;
        }
        tokio::try_join!(second, third).unwrap();
        Arc::get_mut(&mut session).unwrap().close().await.unwrap();

        let usage_keys: Vec<String> = sqlx::query_scalar(
            "SELECT event_id FROM provider_usage_events WHERE session_id = ? AND provider_id = 'antigravity'",
        )
        .bind(db_session)
        .fetch_all(pool)
        .await
        .unwrap();
        assert!(saw_both_receipts);
        assert_eq!(accounting_events.len(), 3);
        assert_eq!(usage_keys.len(), 3);
        assert!(receipts
            .iter()
            .all(|id| usage_keys.contains(&format!("acp-prompt/{id}"))));
        assert!(usage_keys.iter().all(|key| key
            .strip_prefix("acp-prompt/")
            .is_some_and(|id| Uuid::parse_str(id).is_ok())));
        assert_eq!(usage_bucket(&task).await, (28_422, 802));

        let context: (i64, i64, i64) = sqlx::query_as(
            "SELECT input_tokens, output_tokens, context_window FROM agent_sessions WHERE id = ?",
        )
        .bind(db_session)
        .fetch_one(pool)
        .await
        .unwrap();
        assert_eq!(context, (11_054, 0, 1_048_576));

        // Replaying the same reports with different correlation state keeps
        // their wire identities and cannot add a second copy to the bucket.
        let mut replay = StreamReaderState::new(task.initial_usage_snapshot().await);
        replay.received_prompt_message_uuids =
            vec![receipts[1].to_string(), receipts[0].to_string()];
        for event in accounting_events.iter().rev() {
            task.record_token_usage(&mut replay, event).await;
        }
        assert_eq!(usage_bucket(&task).await, (28_422, 802));
    }

    #[test]
    fn a_failure_streak_is_reported_once() {
        let mut failing = false;
        assert_eq!(
            first_failure_of_streak(&mut failing, Err("busy")),
            Some("busy")
        );
        // Events without usage write nothing: the streak goes on.
        assert_eq!(
            first_failure_of_streak::<&str>(&mut failing, Ok(false)),
            None
        );
        assert_eq!(first_failure_of_streak(&mut failing, Err("busy")), None);
        // A write that ran and succeeded ends it.
        assert_eq!(
            first_failure_of_streak::<&str>(&mut failing, Ok(true)),
            None
        );
        assert_eq!(
            first_failure_of_streak(&mut failing, Err("full")),
            Some("full")
        );
    }
}
