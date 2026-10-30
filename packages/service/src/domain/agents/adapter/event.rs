use serde_json::Value;

use super::config::{RuntimeTokenUsage, RuntimeUsage};
use super::event_types::{
    BackgroundAgentSignal, RuntimeAssistantMessage, RuntimeCompactMetadata, RuntimeEvent,
    RuntimeEventKind, RuntimeEventMetadata, RuntimeInitEvent, RuntimeProviderError,
    RuntimeResultError, RuntimeStreamEvent, RuntimeStreamStatus, RuntimeTurnStartedSource,
    RuntimeUserMessage, ScheduledWakeup,
};
use super::permission::RuntimeSlashCommand;
use super::subagent::RuntimeSubagentUpdate;

/// Identity of one root or nested runtime stream within a provider session.
///
/// A runtime session can interleave root and subagent events that reuse the
/// same content-block indexes, so state keyed by the session alone is unsafe.
#[derive(Debug, Clone, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub struct RuntimeStreamScope {
    runtime_session_id: Option<String>,
    parent_tool_use_id: Option<String>,
}

impl RuntimeStreamScope {
    pub fn new(runtime_session_id: Option<&str>, parent_tool_use_id: Option<&str>) -> Self {
        Self {
            runtime_session_id: runtime_session_id.map(ToOwned::to_owned),
            parent_tool_use_id: parent_tool_use_id.map(ToOwned::to_owned),
        }
    }

    pub fn for_event(event: &RuntimeEvent) -> Self {
        Self::new(event.session_id(), event.parent_tool_use_id())
    }
}

impl RuntimeEvent {
    pub fn new(metadata: RuntimeEventMetadata, kind: RuntimeEventKind) -> Self {
        Self {
            metadata,
            kind,
            background_agent: None,
            background_tasks: None,
            scheduled_wakeup: None,
            result_error: None,
            token_usage: None,
            provider_message_id: None,
            subagent_updates: Vec::new(),
        }
    }

    /// Attach sub-agent facts (see [`RuntimeSubagentUpdate`]).
    pub fn with_subagent_updates(mut self, updates: Vec<RuntimeSubagentUpdate>) -> Self {
        self.subagent_updates.extend(updates);
        self
    }

    /// A standalone sub-agent fact with no transcript block of its own.
    pub fn subagent_signal(updates: Vec<RuntimeSubagentUpdate>) -> Self {
        Self::new(RuntimeEventMetadata::default(), RuntimeEventKind::Other)
            .with_subagent_updates(updates)
    }

    pub fn subagent_updates(&self) -> &[RuntimeSubagentUpdate] {
        &self.subagent_updates
    }

    /// Carries only sub-agent facts: nothing to persist or forward as a block.
    pub fn is_subagent_signal_only(&self) -> bool {
        !self.subagent_updates.is_empty() && matches!(self.kind, RuntimeEventKind::Other)
    }

    /// Attach a [`BackgroundAgentSignal`] to this event. Used by adapters that
    /// model run-in-background agents (today only Claude Code) so the shared
    /// stream reader can track which agents are still alive.
    pub fn with_background_agent(mut self, signal: Option<BackgroundAgentSignal>) -> Self {
        self.background_agent = signal;
        self
    }

    pub fn background_agent_signal(&self) -> Option<&BackgroundAgentSignal> {
        self.background_agent.as_ref()
    }

    /// Attach a snapshot of how many background tasks the runtime still runs.
    /// Used by adapters whose provider reports them (today only Claude Code).
    pub fn with_background_task_count(mut self, live: Option<usize>) -> Self {
        self.background_tasks = live;
        self
    }

    pub fn background_task_count(&self) -> Option<usize> {
        self.background_tasks
    }

    /// Attach an agent-scheduled wake-up. Used by adapters whose runtime can
    /// re-invoke the agent on a timer (today only Claude Code).
    pub fn with_scheduled_wakeup(mut self, wakeup: Option<ScheduledWakeup>) -> Self {
        self.scheduled_wakeup = wakeup;
        self
    }

    pub fn scheduled_wakeup(&self) -> Option<&ScheduledWakeup> {
        self.scheduled_wakeup.as_ref()
    }

    /// Attach failure detail to a turn-ending `Result`. Used by adapters whose
    /// turn-complete signal can itself report an error (today only Claude Code:
    /// `Result { is_error: true }`) so the reader can surface it (issue #78).
    pub fn with_result_error(mut self, error: Option<RuntimeResultError>) -> Self {
        self.result_error = error;
        self
    }

    /// Failure detail of a turn-ending result, when the result reported an
    /// error. `None` for a successful result and every non-result event.
    pub fn result_error(&self) -> Option<&RuntimeResultError> {
        self.result_error.as_ref()
    }

    pub fn with_token_usage(mut self, usage: Option<RuntimeTokenUsage>) -> Self {
        self.token_usage = usage.filter(|usage| !usage.is_noop());
        self
    }

    pub fn token_usage(&self) -> Option<&RuntimeTokenUsage> {
        self.token_usage.as_ref()
    }

    pub fn is_usage_accounting(&self) -> bool {
        matches!(self.kind, RuntimeEventKind::UsageAccounting)
    }

    pub fn with_provider_message_id(mut self, message_id: Option<String>) -> Self {
        self.provider_message_id = message_id;
        self
    }

    pub fn provider_message_id(&self) -> Option<&str> {
        self.provider_message_id.as_deref()
    }

    pub fn session_id(&self) -> Option<&str> {
        self.metadata.session_id.as_deref()
    }

    pub fn usage(&self) -> Option<&RuntimeUsage> {
        self.metadata.usage.as_ref()
    }

    pub fn context_window(&self) -> Option<u64> {
        self.metadata.context_window
    }

    pub fn is_result(&self) -> bool {
        matches!(self.kind, RuntimeEventKind::Result)
    }

    pub fn raw_json(&self) -> &Value {
        &self.metadata.raw
    }

    pub fn init(&self) -> Option<&RuntimeInitEvent> {
        match &self.kind {
            RuntimeEventKind::Init(init) => Some(init),
            _ => None,
        }
    }

    /// Init and catch-all provider signals carry operational metadata, not
    /// transcript blocks. Consume their side effects before omitting their raw
    /// payload from the conversation projection.
    pub fn is_operational_only(&self) -> bool {
        matches!(
            self.kind,
            RuntimeEventKind::Init(_) | RuntimeEventKind::Other
        )
    }

    pub fn assistant_message(&self) -> Option<&RuntimeAssistantMessage> {
        match &self.kind {
            RuntimeEventKind::AssistantMessage { message, .. } => Some(message),
            _ => None,
        }
    }

    pub fn user_message(&self) -> Option<&RuntimeUserMessage> {
        match &self.kind {
            RuntimeEventKind::UserMessage { message, .. } => Some(message),
            _ => None,
        }
    }

    /// A non-fatal, user-facing provider error to surface (e.g. an API 5xx the
    /// CLI reports as a synthetic assistant message). See
    /// [`RuntimeEventKind::ProviderError`].
    pub fn provider_error(&self) -> Option<RuntimeProviderError<'_>> {
        match &self.kind {
            RuntimeEventKind::ProviderError {
                message,
                code,
                parent_tool_use_id,
            } => Some(RuntimeProviderError {
                message,
                code: code.as_deref(),
                parent_tool_use_id: parent_tool_use_id.as_deref(),
            }),
            _ => None,
        }
    }

    /// A provider message the adapter could not recognize at all. Surfaced to
    /// the conversation verbatim so no agent output is silently dropped. See
    /// [`RuntimeEventKind::Unknown`].
    pub fn unknown_message(&self) -> Option<&Value> {
        match &self.kind {
            RuntimeEventKind::Unknown { raw } => Some(raw),
            _ => None,
        }
    }

    pub fn parent_tool_use_id(&self) -> Option<&str> {
        match &self.kind {
            RuntimeEventKind::AssistantMessage {
                parent_tool_use_id, ..
            }
            | RuntimeEventKind::UserMessage {
                parent_tool_use_id, ..
            }
            | RuntimeEventKind::StreamEvent {
                parent_tool_use_id, ..
            }
            | RuntimeEventKind::ProviderError {
                parent_tool_use_id, ..
            } => parent_tool_use_id.as_deref(),
            _ => None,
        }
    }

    /// Override the event's `parent_tool_use_id` on both the typed kind and
    /// the raw JSON envelope shipped to the frontend. Provider adapters use
    /// this to nest sub-agent events under a parent tool_use without having
    /// to thread the id through every event-builder helper.
    pub fn set_parent_tool_use_id(&mut self, parent: Option<String>) {
        match &mut self.kind {
            RuntimeEventKind::AssistantMessage {
                parent_tool_use_id, ..
            }
            | RuntimeEventKind::UserMessage {
                parent_tool_use_id, ..
            }
            | RuntimeEventKind::StreamEvent {
                parent_tool_use_id, ..
            }
            | RuntimeEventKind::ProviderError {
                parent_tool_use_id, ..
            } => {
                *parent_tool_use_id = parent.clone();
            }
            _ => {}
        }
        if let Value::Object(map) = &mut self.metadata.raw {
            let value = match parent {
                Some(id) => Value::String(id),
                None => Value::Null,
            };
            map.insert("parent_tool_use_id".to_string(), value);
        }
    }

    pub fn stream_event(&self) -> Option<&RuntimeStreamEvent> {
        match &self.kind {
            RuntimeEventKind::StreamEvent { event, .. } => Some(event),
            _ => None,
        }
    }

    #[allow(dead_code)]
    pub fn tool_use_summary_data(&self) -> Option<&Value> {
        match &self.kind {
            RuntimeEventKind::ToolUseSummary { data } => Some(data),
            _ => None,
        }
    }

    pub fn is_compact_boundary(&self) -> bool {
        matches!(self.kind, RuntimeEventKind::CompactBoundary { .. })
    }

    pub fn turn_started_signal(
        session_id: Option<String>,
        source: RuntimeTurnStartedSource,
        context_window: Option<u64>,
    ) -> Self {
        let raw = serde_json::json!({
            "type": "turn_started",
            "session_id": session_id,
            "source": source.as_str(),
        });
        Self::new(
            RuntimeEventMetadata {
                session_id,
                usage: None,
                context_window,
                raw,
            },
            RuntimeEventKind::TurnStarted { source },
        )
    }

    pub fn compact_metadata(&self) -> Option<&RuntimeCompactMetadata> {
        match &self.kind {
            RuntimeEventKind::CompactBoundary { metadata } => metadata.as_ref(),
            _ => None,
        }
    }

    pub fn is_turn_started_signal(&self) -> bool {
        self.turn_started_source().is_some()
    }

    pub fn turn_started_source(&self) -> Option<RuntimeTurnStartedSource> {
        match &self.kind {
            RuntimeEventKind::TurnStarted { source } => Some(*source),
            _ => None,
        }
    }

    pub fn stream_status(&self) -> Option<&RuntimeStreamStatus> {
        match &self.kind {
            RuntimeEventKind::StreamStatus(status) => Some(status),
            _ => None,
        }
    }

    /// Live slash-command catalog snapshot pushed by the agent over
    /// ACP `available_commands_update`. The WS bridge fans these out
    /// to subscribers so the FE picker reflects the agent's current
    /// catalog without re-querying.
    pub fn slash_commands_updated(&self) -> Option<&[RuntimeSlashCommand]> {
        match &self.kind {
            RuntimeEventKind::SlashCommandsUpdated(commands) => Some(commands.as_slice()),
            _ => None,
        }
    }

    pub fn prompt_received_client_message_id(&self) -> Option<&str> {
        match &self.kind {
            RuntimeEventKind::PromptReceived { client_message_id } => Some(client_message_id),
            _ => None,
        }
    }

    pub fn prompt_received_event(client_message_id: String) -> Self {
        Self::prompt_received_event_with_provider_message_id(client_message_id, None)
    }

    pub fn prompt_received_event_with_provider_message_id(
        client_message_id: String,
        provider_message_id: Option<String>,
    ) -> Self {
        Self::new(
            RuntimeEventMetadata {
                raw: serde_json::json!({
                    "type": "prompt_received",
                    "client_message_id": client_message_id,
                    "provider_message_id": provider_message_id.clone(),
                }),
                ..RuntimeEventMetadata::default()
            },
            RuntimeEventKind::PromptReceived { client_message_id },
        )
        .with_provider_message_id(provider_message_id)
    }

    /// Convenience constructor for stream-status events. Emitters don't
    /// have meaningful session_id / usage / context_window metadata for
    /// these — the WS bridge ignores those fields for status envelopes.
    pub fn stream_status_event(status: RuntimeStreamStatus) -> Self {
        Self::new(
            RuntimeEventMetadata::default(),
            RuntimeEventKind::StreamStatus(status),
        )
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::super::event_types::{
        RuntimeAssistantMessage, RuntimeContentBlock, RuntimeEvent, RuntimeEventKind,
        RuntimeEventMetadata, RuntimeStreamEvent,
    };

    #[test]
    fn operational_signals_do_not_hide_renderable_events_or_results() {
        let init = RuntimeEventKind::Init(super::RuntimeInitEvent {
            model: None,
            mcp_servers: Vec::new(),
            context_window: None,
        });
        for kind in [init, RuntimeEventKind::Other] {
            assert!(RuntimeEvent::new(RuntimeEventMetadata::default(), kind).is_operational_only());
        }
        for kind in [
            RuntimeEventKind::Result,
            RuntimeEventKind::StreamEvent {
                event: RuntimeStreamEvent::MessageStart {
                    model: None,
                    input_tokens: None,
                },
                parent_tool_use_id: None,
            },
        ] {
            assert!(!RuntimeEvent::new(RuntimeEventMetadata::default(), kind).is_operational_only());
        }
        assert!(!assistant_event_with_raw().is_operational_only());
    }

    fn assistant_event_with_raw() -> RuntimeEvent {
        RuntimeEvent::new(
            RuntimeEventMetadata {
                session_id: Some("root".into()),
                usage: None,
                context_window: None,
                raw: json!({
                    "type": "assistant",
                    "session_id": "root",
                    "parent_tool_use_id": null,
                }),
            },
            RuntimeEventKind::AssistantMessage {
                message: RuntimeAssistantMessage {
                    model: None,
                    content: vec![RuntimeContentBlock::Text { text: "hi".into() }],
                },
                parent_tool_use_id: None,
            },
        )
    }

    #[test]
    fn set_parent_tool_use_id_updates_kind_and_raw_envelope() {
        let mut event = assistant_event_with_raw();
        assert!(event.parent_tool_use_id().is_none());

        event.set_parent_tool_use_id(Some("toolu_parent".into()));
        assert_eq!(event.parent_tool_use_id(), Some("toolu_parent"));
        // Raw envelope is what the WS bridge ships to the frontend; it must
        // mirror the typed value so the FE's `parent_tool_use_id` lookup
        // sees the override too.
        assert_eq!(
            event.raw_json()["parent_tool_use_id"],
            json!("toolu_parent")
        );

        // Clearing it is also reflected on the raw envelope (becomes null,
        // not removed, so the FE still sees the field).
        event.set_parent_tool_use_id(None);
        assert!(event.parent_tool_use_id().is_none());
        assert!(event.raw_json()["parent_tool_use_id"].is_null());
    }

    #[test]
    fn set_parent_tool_use_id_is_a_noop_for_kinds_without_parent_field() {
        // Result events don't carry parent_tool_use_id in their kind, but the
        // mutator must still leave them in a valid state without panicking.
        let mut event =
            RuntimeEvent::new(RuntimeEventMetadata::default(), RuntimeEventKind::Result);
        event.set_parent_tool_use_id(Some("toolu_x".into()));
        assert!(event.parent_tool_use_id().is_none());
    }

    #[test]
    fn set_parent_tool_use_id_propagates_to_stream_event_kind() {
        let mut event = RuntimeEvent::new(
            RuntimeEventMetadata {
                session_id: Some("root".into()),
                usage: None,
                context_window: None,
                raw: json!({ "type": "stream_event", "parent_tool_use_id": null }),
            },
            RuntimeEventKind::StreamEvent {
                event: RuntimeStreamEvent::Other,
                parent_tool_use_id: None,
            },
        );
        event.set_parent_tool_use_id(Some("toolu_spawn".into()));
        assert_eq!(event.parent_tool_use_id(), Some("toolu_spawn"));
    }
}
