use std::collections::HashSet;

use tokio::time::Instant;

use crate::domain::agents::adapter::RuntimeEvent;
use crate::domain::runtime_stream::{RuntimeUsageSnapshot, RuntimeUsageState};
use crate::domain::ws_session::persistence::WsSessionPersistence;

use super::stream_reader_task::{StreamReaderState, StreamReaderTask};
use super::stream_reader_turn_state::StreamTurnState;

impl StreamReaderState {
    pub(super) fn new(initial_usage: RuntimeUsageSnapshot) -> Self {
        Self {
            runtime_session_id: None,
            usage_state: RuntimeUsageState::new(initial_usage),
            usage_attribution: None,
            usage_attribution_captured: false,
            provider_usage_event_id: None,
            last_runtime_activity: Instant::now(),
            last_provider_reconcile: Instant::now(),
            turn_state: StreamTurnState::new(),
            live_background_agents: HashSet::new(),
            message_seq: 0,
            received_prompt_message_uuids: Vec::new(),
            diagnostics: super::stream_diagnostics::StreamDiagnostics::new(),
        }
    }
}

impl StreamReaderTask {
    /// Capture what this turn's provider token report should be attributed to.
    pub(super) async fn capture_usage_attribution(
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

    pub(super) async fn record_token_usage(
        &self,
        state: &mut StreamReaderState,
        event: &RuntimeEvent,
    ) {
        let Some(mut usage) = event.token_usage().cloned() else {
            return;
        };
        let correlation_id = state
            .provider_usage_event_id
            .as_deref()
            .map(crate::domain::usage_stats::provider_message_event_id);
        usage.correlate_event_id(
            correlation_id,
            state.received_prompt_message_uuids.first().cloned(),
        );
        crate::domain::usage_stats::record_runtime_usage(
            &self.write_pool,
            self.db_session_id,
            state.usage_attribution.clone(),
            usage,
        )
        .await;
    }

    pub(super) fn capture_provider_usage_event_id(
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
    pub(super) async fn initial_usage_snapshot(&self) -> RuntimeUsageSnapshot {
        let row = WsSessionPersistence::get_session_row(&self.write_pool, self.db_session_id).await;
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
