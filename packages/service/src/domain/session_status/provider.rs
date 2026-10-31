use crate::domain::agents::adapter::{RuntimeEvent, RuntimeStreamEvent};

use super::AgentStatus;

/// Provider-neutral signal derived from a runtime event.
///
/// Stream events emitted directly from the runtime carry only Agent/Idle
/// information (turn started / turn ended). User-input gates are detected
/// out-of-band via the adapter's `parse_permission_request` and routed
/// through application `mark_awaiting_user`, which sets the DB pending column
/// AND broadcasts Question — they don't flow through this enum.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ProviderSignal {
    /// The agent has started (or is actively producing) a turn.
    TurnStarted,
    /// The turn is finished (provider sent `Result`, stream closed, etc.).
    TurnEnded,
}

impl ProviderSignal {
    pub fn status(self) -> AgentStatus {
        match self {
            Self::TurnStarted => AgentStatus::Agent,
            Self::TurnEnded => AgentStatus::Idle,
        }
    }
}

/// Provider-neutral mapping from a [`RuntimeStreamEvent`] to a signal.
///
/// Exhaustive on every variant — adding a new `RuntimeStreamEvent` arm
/// without updating this match is a build error. That is the regression
/// guard for the Codex `MessageStart`-never-broadcast bug.
pub fn provider_signal_for_stream_event(event: &RuntimeStreamEvent) -> Option<ProviderSignal> {
    match event {
        RuntimeStreamEvent::MessageStart { .. }
        | RuntimeStreamEvent::ContentBlockStart { .. }
        | RuntimeStreamEvent::ContentBlockDelta { .. }
        | RuntimeStreamEvent::ContentBlockStop { .. } => Some(ProviderSignal::TurnStarted),
        RuntimeStreamEvent::Other => None,
    }
}

/// Provider-neutral mapping from a [`RuntimeEvent`] to a signal.
///
/// Permission / question gates are NOT derived here — they go through
/// `parse_permission_request` on the adapter, then call
/// application `mark_awaiting_user` which calls `broadcaster.broadcast_gate`
/// with the right pending kind.
pub fn provider_signal_for_event(event: &RuntimeEvent) -> Option<ProviderSignal> {
    if event.is_result() {
        return Some(ProviderSignal::TurnEnded);
    }
    match event.stream_event() {
        Some(stream_event) => provider_signal_for_stream_event(stream_event),
        None if event.is_turn_started_signal() => Some(ProviderSignal::TurnStarted),
        None => match event_kind_implies_turn_started(event) {
            true => Some(ProviderSignal::TurnStarted),
            false => None,
        },
    }
}

/// `AssistantMessage` / `UserMessage` (tool result) imply the turn is in
/// progress for every provider. `Init` / `ToolUseSummary` / `CompactBoundary`
/// / `Other` do NOT — they're metadata the agent emits without owning the
/// turn (e.g. a CompactBoundary fires when summarizing in the background).
fn event_kind_implies_turn_started(event: &RuntimeEvent) -> bool {
    match event {
        e if e.assistant_message().is_some() => true,
        e if e.user_message().is_some() => true,
        _ => false,
    }
}

/// Whether this event explicitly starts a fresh turn.
///
/// After a turn ends (Result event), tool_results, content deltas, etc.
/// can still arrive on a stale stream — these must NOT re-enter the
/// "Agent is working" state. Only an explicit `MessageStart` is a valid
/// turn-start signal post-Result. Provider-neutral: every adapter is
/// expected to synthesize `MessageStart` at the top of every turn (Codex
/// emits one on `turn/started`, Claude on `message_start`, OpenCode on
/// stream open). See `stream_reader.rs` for the call site that uses this
/// to gate post-turn status broadcasts.
pub fn event_starts_fresh_turn(event: &RuntimeEvent) -> bool {
    event.is_turn_started_signal()
        || matches!(
            event.stream_event(),
            Some(RuntimeStreamEvent::MessageStart { .. })
        )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn provider_signal_status_mapping() {
        assert_eq!(ProviderSignal::TurnStarted.status(), AgentStatus::Agent);
        assert_eq!(ProviderSignal::TurnEnded.status(), AgentStatus::Idle);
    }

    #[test]
    fn event_starts_fresh_turn_only_on_message_start() {
        use crate::domain::agents::adapter::{
            RuntimeAssistantMessage, RuntimeContentBlock, RuntimeEvent, RuntimeEventKind,
            RuntimeEventMetadata,
        };

        let message_start = RuntimeEvent::new(
            RuntimeEventMetadata::default(),
            RuntimeEventKind::StreamEvent {
                event: RuntimeStreamEvent::MessageStart {
                    model: None,
                    input_tokens: None,
                },
                parent_tool_use_id: None,
            },
        );
        assert!(event_starts_fresh_turn(&message_start));

        let assistant = RuntimeEvent::new(
            RuntimeEventMetadata::default(),
            RuntimeEventKind::AssistantMessage {
                message: RuntimeAssistantMessage {
                    model: None,
                    content: vec![RuntimeContentBlock::Text { text: "x".into() }],
                },
                parent_tool_use_id: None,
            },
        );
        assert!(!event_starts_fresh_turn(&assistant));

        let content_block_stop = RuntimeEvent::new(
            RuntimeEventMetadata::default(),
            RuntimeEventKind::StreamEvent {
                event: RuntimeStreamEvent::ContentBlockStop { index: 0 },
                parent_tool_use_id: None,
            },
        );
        assert!(!event_starts_fresh_turn(&content_block_stop));

        let result = RuntimeEvent::new(RuntimeEventMetadata::default(), RuntimeEventKind::Result);
        assert!(!event_starts_fresh_turn(&result));
    }

    #[test]
    fn provider_signal_for_stream_event_covers_all_variants() {
        use crate::domain::agents::adapter::{RuntimeContentBlock, RuntimeContentDelta};

        let cases: Vec<(RuntimeStreamEvent, Option<ProviderSignal>)> = vec![
            (
                RuntimeStreamEvent::MessageStart {
                    model: None,
                    input_tokens: None,
                },
                Some(ProviderSignal::TurnStarted),
            ),
            (
                RuntimeStreamEvent::ContentBlockStart {
                    index: 0,
                    block: RuntimeContentBlock::Other,
                },
                Some(ProviderSignal::TurnStarted),
            ),
            (
                RuntimeStreamEvent::ContentBlockDelta {
                    index: 0,
                    delta: RuntimeContentDelta::Text { text: "x".into() },
                },
                Some(ProviderSignal::TurnStarted),
            ),
            (
                RuntimeStreamEvent::ContentBlockStop { index: 0 },
                Some(ProviderSignal::TurnStarted),
            ),
            (RuntimeStreamEvent::Other, None),
        ];

        for (event, expected) in cases {
            assert_eq!(provider_signal_for_stream_event(&event), expected);
        }
    }
}
