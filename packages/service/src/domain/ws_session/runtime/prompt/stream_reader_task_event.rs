use super::super::send_runtime_session_id;
use super::mcp_servers::mcp_servers_message_if_init;
use super::stream_reader_resume::runtime_allows_resume_persistence;
use super::stream_reader_task::{StreamReaderState, StreamReaderTask};
use super::stream_reader_task_event_phases::EventObservation;
use crate::domain::agents::adapter::{AgentRuntimeAdapter, RuntimeEvent};
use crate::domain::runtime_stream::{capture_runtime_session_id, persist_usage};
use crate::domain::ws_session::persistence::{TranscriptPersistenceError, WsSessionPersistence};
use axum::extract::ws::Message;
use tracing::{error, info};

impl StreamReaderTask {
    /// Process one runtime event. A closed owner socket is no longer fatal:
    /// every send becomes best-effort because the agent must keep running on
    /// the host after a client (e.g. a sleeping phone) disconnects. The reader
    /// stops only when the runtime stream itself ends, or via deferred teardown
    /// (see [`StreamReaderTask::maybe_teardown_orphaned`]).
    pub(in crate::domain::ws_session) async fn handle_runtime_event(
        &self,
        state: &mut StreamReaderState,
        runtime_adapter: Option<&dyn AgentRuntimeAdapter>,
        persistence: &mut WsSessionPersistence,
        runtime_event: RuntimeEvent,
    ) {
        if runtime_event.mcp_servers_changed() {
            self.publish_current_mcp_servers().await;
            return;
        }
        state.last_runtime_activity = tokio::time::Instant::now();
        state.diagnostics.record(runtime_event.raw_json());
        let detached_generation = if runtime_event.is_detached_reply_end() {
            Some(
                self.app_state
                    .active_turns
                    .lock_turn_generation(self.db_session_id)
                    .await,
            )
        } else {
            None
        };
        if !self.accepts_result_event(state, &runtime_event).await {
            return;
        }
        let EventObservation::Continue {
            interrupted_generation,
        } = self.observe_runtime_event(state, &runtime_event).await
        else {
            return;
        };
        if self
            .handle_before_persistence(state, runtime_adapter, persistence, &runtime_event)
            .await
        {
            return;
        }
        if self
            .surface_event_errors(state, persistence, &runtime_event, interrupted_generation)
            .await
        {
            return;
        }
        if self.handle_non_result_signal(state, &runtime_event).await {
            return;
        }

        self.persist_and_forward_event(
            state,
            runtime_adapter,
            persistence,
            &runtime_event,
            interrupted_generation,
        )
        .await;
        // Queue delivery can begin a new generation in this same session.
        drop(detached_generation);
        if runtime_event.is_result() {
            self.continue_after_result(state, interrupted_generation)
                .await;
        }
    }

    pub(super) async fn capture_runtime_session_id(
        &self,
        state: &mut StreamReaderState,
        adapter: Option<&dyn AgentRuntimeAdapter>,
        runtime_event: &RuntimeEvent,
    ) {
        let Some(runtime_sid) =
            capture_runtime_session_id(runtime_event, state.runtime_session_id.as_deref())
        else {
            return;
        };
        let durable = if runtime_allows_resume_persistence(self.runtime_session_handle.as_ref())
            .await
        {
            adapter.and_then(|adapter| adapter.persistable_resume_session_id(Some(&runtime_sid)))
        } else {
            None
        };
        state.runtime_session_id = Some(runtime_sid.clone());
        state.usage_state.set_root_session_id(runtime_sid.as_str());
        let Some(persisted_sid) = durable else {
            send_runtime_session_id(&self.sender, runtime_sid.as_str());
            return;
        };
        info!(self.db_session_id, runtime_session_id = %persisted_sid, "stream_reader: persisting runtime session_id to DB");
        self.check_write(
            WsSessionPersistence::persist_runtime_session_id_static(
                &self.write_pool,
                self.db_session_id,
                &self.runtime_provider,
                persisted_sid.as_str(),
            )
            .await,
            "its resume point",
        )
        .await;
        send_runtime_session_id(&self.sender, persisted_sid.as_str());
    }

    pub(super) async fn send_mcp_servers_if_init(&self, runtime_event: &RuntimeEvent) {
        let message =
            mcp_servers_message_if_init(&self.sdk_sessions, self.db_session_id, runtime_event)
                .await;
        if let Some(message) = message {
            self.publish(message).await;
        }
    }

    async fn handle_non_result_signal(
        &self,
        state: &mut StreamReaderState,
        runtime_event: &RuntimeEvent,
    ) -> bool {
        if runtime_event.is_result() {
            return false;
        }
        if crate::domain::session_status::event_starts_fresh_turn(runtime_event) {
            // New turn: clear any error surfaced in the previous turn so this
            // turn's terminal error-result (if any) can surface (issue #78).
            state.turn_state.mark_fresh_turn_started();
            // Also a turn the CLI opened itself: a Stop during it must count.
            self.app_state
                .active_turns
                .resume_turn(self.db_session_id)
                .await;
        }
        if !state.turn_state.is_between_turns() {
            self.broadcast_runtime_signal(runtime_event).await;
        }
        runtime_event.is_turn_started_signal()
    }

    async fn broadcast_runtime_signal(&self, runtime_event: &RuntimeEvent) {
        if runtime_event.is_turn_started_signal() {
            self.record_running().await;
        }
        self.session_status_tx
            .stream_event(self.db_session_id, self.feature_id, runtime_event);
        // A turn the CLI opened itself (no prompt) is in the book only now.
        if crate::domain::session_status::event_starts_fresh_turn(runtime_event) {
            self.reflect_reported_status(runtime_event);
        }
    }

    async fn persist_and_forward_event(
        &self,
        state: &mut StreamReaderState,
        runtime_adapter: Option<&dyn AgentRuntimeAdapter>,
        persistence: &mut WsSessionPersistence,
        runtime_event: &RuntimeEvent,
        interrupted_generation: Option<u64>,
    ) {
        let usage_update = state
            .usage_state
            .apply_event(runtime_adapter, runtime_event);
        if usage_update.context_window_changed {
            let saved = WsSessionPersistence::update_context_window(
                &self.write_pool,
                self.db_session_id,
                usage_update.snapshot.context_window,
            )
            .await;
            self.report_usage_write(
                &mut state.context_window_save_failed,
                "its context window",
                saved.map(|()| true),
            )
            .await;
        }

        let persisted_message = match persistence
            .persist_runtime_event_buffered(runtime_event)
            .await
        {
            Ok(message) => message,
            Err(TranscriptPersistenceError::AwaitingReconciliation) => None,
            Err(error) => {
                error!(self.db_session_id, error = %error, "transcript persistence degraded");
                None
            }
        };
        self.publish_transcript_status(persistence, runtime_event.is_result())
            .await;
        // Only stream-event blocks carry a stamped model, so skip the lookup
        // entirely for other events on this per-delta hot path.
        let current_model = runtime_event
            .stream_event()
            .and_then(|_| persistence.current_model_for_event(runtime_event));
        if !usage_update.is_subagent {
            let saved = persist_usage(runtime_event, self.db_session_id, &self.write_pool).await;
            self.report_usage_write(&mut state.token_usage_save_failed, "its token usage", saved)
                .await;
        }
        // Any change is worth pushing, including a window that resolved on the
        // `init` event before this turn spent a token — without that the UI
        // keeps scaling by whatever window it last had (a different model's)
        // for the whole turn. The snapshot carries the persisted token totals,
        // so a window-only update restates them rather than blanking the bar.
        if usage_update.changed {
            self.send_usage_update(
                usage_update.snapshot.input_tokens,
                usage_update.snapshot.output_tokens,
                usage_update.snapshot.context_window,
            )
            .await;
        }

        let envelope = self
            .runtime_event_envelope(
                state,
                runtime_event,
                persisted_message,
                current_model,
                interrupted_generation,
            )
            .await;
        // Live forwarding continues even when transcript durability is degraded.
        // The event is mirrored to any other connected
        // device, so a gone owner socket is fine — keep streaming. A `None`
        // envelope means the turn-complete signal was intentionally withheld
        // because a background agent is still alive (issue #58) — keep the turn
        // lifecycle in `active` so the header timer doesn't reset on resume.
        if let Some(envelope) = envelope {
            self.publish(Message::Text(String::from(envelope).into()))
                .await;
        }
        // Write the deltas whose flush window has passed only after this
        // frame went out, so the frame itself never waits on SQLite. The write
        // still runs on this task: the next event waits for it (at most one
        // UPDATE per block per window), which keeps writes in stream order
        // and their failures on this event's durability path.
        self.flush_due_deltas(persistence).await;
    }

    async fn continue_after_result(
        &self,
        state: &StreamReaderState,
        interrupted_generation: Option<u64>,
    ) {
        if let Some(generation) = interrupted_generation {
            self.after_stopped_turn(generation).await;
        } else if state.live_background_agents.is_empty() {
            if let Err(error) = crate::domain::mcp::control::reply_wait::deliver_completed(
                &self.app_state,
                self.db_session_id,
            )
            .await
            {
                error!(self.db_session_id, error = %error, "failed to deliver MCP session reply");
            }
            self.after_turn_result().await;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::agents::adapter::{
        AgentRuntimeSession, BackgroundAgentSignal, RuntimeError, RuntimeEventKind,
        RuntimeEventMetadata, RuntimeSpawnConfig, RuntimeStreamEvent,
    };
    use crate::domain::runtime_stream::RuntimeUsageSnapshot;
    use serde_json::json;

    #[tokio::test]
    async fn held_acp_boundaries_keep_one_clock_and_one_persisted_turn_summary() {
        use crate::domain::session_status::AgentStatus;

        let (task, _runtime, _) = super::super::stream_reader_idle::tests::idle_task().await;
        let mut state = StreamReaderState::new(RuntimeUsageSnapshot {
            input_tokens: 0,
            output_tokens: 0,
            context_window: None,
        });
        let id = task.db_session_id;
        let pool = &task.write_pool;
        let mut persistence =
            WsSessionPersistence::with_session_id(pool.clone(), task.feature_id, Some(id));
        task.record_running().await;
        let statuses = &task.session_status_tx;
        statuses.broadcast_running(id, task.feature_id);
        let session = id.to_string();
        let started_at = statuses.snapshot().states[&session]
            .clock
            .turn_started_at_ms;
        assert!(started_at.is_some());
        let mut status_rx = statuses.subscribe();

        let detached_end = || {
            RuntimeEvent::new(
                RuntimeEventMetadata::default(),
                RuntimeEventKind::DetachedReplyEnded,
            )
        };
        let hold = || {
            Some(BackgroundAgentSignal::Started {
                agent_id: "acp-background-work".into(),
            })
        };
        let resumed = || {
            RuntimeEvent::new(
                RuntimeEventMetadata::default(),
                RuntimeEventKind::StreamEvent {
                    event: RuntimeStreamEvent::MessageStart {
                        model: None,
                        input_tokens: None,
                    },
                    parent_tool_use_id: None,
                },
            )
        };
        for event in [
            RuntimeEvent::new(RuntimeEventMetadata::default(), RuntimeEventKind::Result)
                .with_background_agent(hold()),
            resumed(),
            detached_end().with_background_agent(hold()),
            resumed(),
            RuntimeEvent::new(RuntimeEventMetadata::default(), RuntimeEventKind::Other)
                .with_background_agent(Some(BackgroundAgentSignal::Finished {
                    agent_id: "acp-background-work".into(),
                })),
        ] {
            task.handle_runtime_event(&mut state, None, &mut persistence, event)
                .await;
            let active = &statuses.snapshot().states[&session];
            assert_eq!(active.status, AgentStatus::Agent);
            assert_eq!(active.clock.turn_started_at_ms, started_at);
        }

        let summaries = "SELECT content FROM agent_messages WHERE session_id = ? AND message_type = 'turn_summary'";
        let journal = statuses.journal();
        journal.flush(pool, &task.feature_senders).await;
        let interim = sqlx::query_scalar::<_, String>(summaries)
            .bind(id)
            .fetch_all(pool)
            .await
            .unwrap();
        assert!(interim.is_empty());
        assert!(status_rx.try_recv().is_err());

        task.handle_runtime_event(&mut state, None, &mut persistence, detached_end())
            .await;
        assert_eq!(status_rx.try_recv().unwrap().status, AgentStatus::Idle);
        assert!(status_rx.try_recv().is_err());
        journal.flush(pool, &task.feature_senders).await;
        let completed = sqlx::query_scalar::<_, String>(summaries)
            .bind(id)
            .fetch_all(pool)
            .await
            .unwrap();
        assert_eq!(completed.len(), 1);
        let summary: serde_json::Value = serde_json::from_str(&completed[0]).unwrap();
        assert_eq!(summary["startedAtMs"].as_i64(), started_at);
    }

    #[tokio::test]
    async fn detached_completion_preserves_prompt_delivery_and_an_open_gate() {
        use crate::domain::ws_session::persistence::PendingUserInput;

        let (task, _runtime, _) = super::super::stream_reader_idle::tests::idle_task().await;
        let mut state = StreamReaderState::new(RuntimeUsageSnapshot {
            input_tokens: 0,
            output_tokens: 0,
            context_window: None,
        });
        let id = task.db_session_id;
        let pool = &task.write_pool;
        let turns = &task.app_state.active_turns;
        let mut persistence =
            WsSessionPersistence::with_session_id(pool.clone(), task.feature_id, Some(id));
        let message_uuid = uuid::Uuid::new_v4();
        persistence
            .persist_user_message_with_delivery(
                "Still preparing to send",
                message_uuid,
                Some("pending_agent"),
            )
            .await
            .unwrap();
        turns.begin_turn(id, &task.sdk_sessions).await;
        assert!(state
            .turn_state
            .accepts_result_generation(false, turns.current_generation(id).await));
        state.turn_state.mark_fresh_turn_started();

        // The newer foreground prompt is preparing, before its ACP request
        // has even taken the session's prompt lock.
        turns.begin_turn(id, &task.sdk_sessions).await;
        WsSessionPersistence::mark_running_static(pool, id)
            .await
            .unwrap();
        let end = RuntimeEvent::new(
            RuntimeEventMetadata::default(),
            RuntimeEventKind::DetachedReplyEnded,
        );
        state.live_background_agents.insert("older-work".into());
        let stale = end
            .clone()
            .with_background_agent(Some(BackgroundAgentSignal::Finished {
                agent_id: "older-work".into(),
            }));
        task.handle_runtime_event(&mut state, None, &mut persistence, stale)
            .await;
        assert!(state.live_background_agents.is_empty());
        let row = WsSessionPersistence::get_session_row(pool, id)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(row.status, "running");
        assert!(!state.turn_state.is_between_turns());

        // When the detached reply belongs to the current generation, its
        // boundary closes the stream without deciding the pending question.
        assert!(state
            .turn_state
            .accepts_result_generation(false, turns.current_generation(id).await));
        let gate = json!({"request_id":"detached-gate", "tool_name":"AskUserQuestion"});
        WsSessionPersistence::set_pending_user_input_static(
            pool,
            id,
            &PendingUserInput::Question(&gate),
        )
        .await;
        task.handle_runtime_event(&mut state, None, &mut persistence, end)
            .await;
        assert!(state.turn_state.is_between_turns());
        let row = WsSessionPersistence::get_session_row(pool, id)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(row.status, "completed");
        let (_, payload) = row.pending_gate_payload().unwrap();
        assert_eq!(payload.request_id, "detached-gate");
        let delivery: String =
            sqlx::query_scalar("SELECT delivery_state FROM agent_messages WHERE message_uuid = ?")
                .bind(message_uuid.to_string())
                .fetch_one(pool)
                .await
                .unwrap();
        assert_eq!(delivery, "pending_agent");
    }

    #[tokio::test]
    async fn stale_background_release_does_not_interrupt_the_new_prompt() {
        check_background_release_after_new_prompt(false).await;
    }

    #[tokio::test]
    async fn stale_background_release_preserves_a_stop_of_the_new_prompt() {
        check_background_release_after_new_prompt(true).await;
    }

    async fn check_background_release_after_new_prompt(stop_new_prompt: bool) {
        let (task, runtime, _) = super::super::stream_reader_idle::tests::idle_task().await;
        let mut state = StreamReaderState::new(RuntimeUsageSnapshot {
            input_tokens: 0,
            output_tokens: 0,
            context_window: None,
        });
        let id = task.db_session_id;
        let pool = &task.write_pool;
        let turns = &task.app_state.active_turns;
        let mut persistence =
            WsSessionPersistence::with_session_id(pool.clone(), task.feature_id, Some(id));
        let result =
            || RuntimeEvent::new(RuntimeEventMetadata::default(), RuntimeEventKind::Result);

        turns.begin_turn(id, &task.sdk_sessions).await;
        let held = result().with_background_agent(Some(BackgroundAgentSignal::Started {
            agent_id: "older-work".into(),
        }));
        task.handle_runtime_event(&mut state, None, &mut persistence, held)
            .await;
        assert_eq!(turns.request_interruption(id, &runtime).await, Some(1));
        turns.begin_turn(id, &task.sdk_sessions).await;
        task.record_running().await;
        if stop_new_prompt {
            assert_eq!(turns.request_interruption(id, &runtime).await, Some(2));
        }

        let release = RuntimeEvent::new(
            RuntimeEventMetadata::default(),
            RuntimeEventKind::DetachedReplyEnded,
        )
        .with_background_agent(Some(BackgroundAgentSignal::Finished {
            agent_id: "older-work".into(),
        }));
        task.handle_runtime_event(&mut state, None, &mut persistence, release)
            .await;
        assert!(state.live_background_agents.is_empty());
        let row = WsSessionPersistence::get_session_row(pool, id)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(row.status, "running");

        task.handle_runtime_event(&mut state, None, &mut persistence, result())
            .await;
        let row = WsSessionPersistence::get_session_row(pool, id)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(row.status, "completed");
        let interruption_count: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM agent_messages WHERE session_id = ? AND message_type = 'turn_interrupted'",
        )
        .bind(id)
        .fetch_one(pool)
        .await
        .unwrap();
        assert_eq!(interruption_count, i64::from(stop_new_prompt));
    }

    struct BoundOwnerAdapter;
    #[async_trait::async_trait]
    impl AgentRuntimeAdapter for BoundOwnerAdapter {
        fn catalog_entry(&self) -> crate::domain::agents::runtime::ProviderCatalogEntry {
            unreachable!("not a discovery test")
        }
        fn persistable_resume_session_id(&self, native: Option<&str>) -> Option<String> {
            native.map(|id| format!("owner-bound:{id}"))
        }
        fn resolve_resume_session_id(&self, stored: Option<&str>) -> Option<String> {
            stored?.strip_prefix("owner-bound:").map(ToOwned::to_owned)
        }
        async fn spawn(
            &self,
            _: serde_json::Value,
            _: RuntimeSpawnConfig,
        ) -> Result<Box<dyn AgentRuntimeSession>, RuntimeError> {
            Err(RuntimeError::new(
                "the event test must never spawn a contributor",
            ))
        }
    }

    #[tokio::test]
    async fn first_runtime_event_persists_and_emits_the_bound_id_before_any_close() {
        let (mut task, runtime, _) = super::super::stream_reader_idle::tests::idle_task().await;
        task.runtime_provider = "pi".into();
        let (sender, mut receiver) = tokio::sync::mpsc::unbounded_channel();
        task.sender = sender.into();
        let mut state =
            StreamReaderState::new(crate::domain::runtime_stream::RuntimeUsageSnapshot {
                input_tokens: 0,
                output_tokens: 0,
                context_window: None,
            });
        let event = RuntimeEvent::new(
            RuntimeEventMetadata {
                session_id: Some("native-session".into()),
                usage: None,
                context_window: None,
                raw: json!({"type":"system","subtype":"init"}),
            },
            RuntimeEventKind::Other,
        );
        task.capture_runtime_session_id(&mut state, Some(&BoundOwnerAdapter), &event)
            .await;
        // A crash can happen here: no shutdown/close persistence has run.
        drop(runtime);
        let row = WsSessionPersistence::get_session_row(&task.write_pool, task.db_session_id)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(
            row.runtime_session_id.as_deref(),
            Some("owner-bound:native-session")
        );
        assert_eq!(
            BoundOwnerAdapter
                .resolve_resume_session_id(row.runtime_session_id.as_deref())
                .as_deref(),
            Some("native-session")
        );
        let message = receiver.try_recv().unwrap();
        assert!(message
            .to_text()
            .unwrap()
            .contains("owner-bound:native-session"));
        assert_eq!(state.runtime_session_id.as_deref(), Some("native-session"));
    }
}
