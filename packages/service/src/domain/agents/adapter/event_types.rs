use std::sync::Arc;

use serde::Serialize;
use serde_json::Value;

use super::config::RuntimeUsage;
use super::permission::RuntimeSlashCommand;

#[derive(Debug, Clone)]
pub struct RuntimeEvent {
    pub(super) metadata: RuntimeEventMetadata,
    pub(super) kind: RuntimeEventKind,
    /// Lifecycle signal for an out-of-band background agent (Claude Code's
    /// `Agent`/`Task` tool with `run_in_background: true`). Populated only by
    /// adapters that model such agents; `None` for every other event and
    /// provider. The shared stream reader uses it to keep a session "working"
    /// while a launched-and-detached agent is still running, instead of going
    /// idle the moment the launching turn's `Result` arrives (issue #58).
    pub(super) background_agent: Option<BackgroundAgentSignal>,
}

/// Provider-neutral lifecycle edge for a background (run-in-background) agent.
///
/// `agent_id` is an opaque, per-provider stable handle (Claude Code: the
/// background task's `task_id`). The same id appears on the matching
/// `Started` and `Finished` so the reader can pair them; an unmatched
/// `Finished` (e.g. a sibling task that was never tracked) is a harmless
/// no-op remove.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum BackgroundAgentSignal {
    /// A background agent began running and is now detached from the turn.
    Started { agent_id: String },
    /// A background agent reached a terminal state (completed/failed/etc).
    Finished { agent_id: String },
}

#[derive(Debug, Clone, Default)]
pub struct RuntimeEventMetadata {
    pub session_id: Option<String>,
    pub usage: Option<RuntimeUsage>,
    /// Authoritative context window reported by the provider for this turn
    /// (e.g. from Claude Code's `result.modelUsage[model].contextWindow`).
    /// Populated on turn-complete events; `None` on intermediate events.
    pub context_window: Option<u64>,
    pub raw: Value,
}

#[derive(Debug, Clone)]
pub enum RuntimeEventKind {
    Init(RuntimeInitEvent),
    AssistantMessage {
        message: RuntimeAssistantMessage,
        parent_tool_use_id: Option<String>,
    },
    UserMessage {
        message: RuntimeUserMessage,
        parent_tool_use_id: Option<String>,
    },
    StreamEvent {
        event: RuntimeStreamEvent,
        parent_tool_use_id: Option<String>,
    },
    ToolUseSummary {
        #[allow(dead_code)]
        data: Value,
    },
    Result,
    /// Provider surfaced a non-fatal, user-facing error mid-stream — e.g. an
    /// API 5xx the CLI reports as a synthetic assistant message. Unlike
    /// [`RuntimeError`](super::RuntimeError) (a dead transport, which tears the
    /// reader down), the session stays alive and the provider's own `Result`
    /// still ends the turn. This variant only carries the message to persist
    /// and surface so it isn't silently dropped.
    ProviderError {
        message: String,
        code: Option<String>,
        parent_tool_use_id: Option<String>,
    },
    CompactBoundary {
        metadata: Option<RuntimeCompactMetadata>,
    },
    /// Provider-derived signal that a turn has started but should not render
    /// as a transcript block. Used for work that has no initial assistant
    /// message, such as compact-only turns.
    TurnStarted {
        source: RuntimeTurnStartedSource,
    },
    /// Provider-neutral signal that the underlying transport is degraded
    /// (reconnecting, stalled, reconcile-failed) or recovered. Mapped to
    /// the `session.stream_status` WS envelope so the UI can show a
    /// "Reconnecting…" banner instead of an infinite silent loader.
    /// Hard failures stay on the existing `RuntimeError` channel.
    StreamStatus(RuntimeStreamStatus),
    /// Live slash-command catalog pushed by the agent (today: the ACP
    /// `available_commands_update` notification). Carries the full
    /// list, not a delta — every push replaces the prior snapshot.
    /// `Arc` so the WS bridge can fan out without cloning the vec
    /// per subscriber.
    SlashCommandsUpdated(Arc<Vec<RuntimeSlashCommand>>),
    /// Runtime accepted a user prompt for delivery to the provider. The
    /// frontend uses this to clear "not received yet" UI.
    PromptReceived {
        client_message_id: String,
    },
    Other,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RuntimeTurnStartedSource {
    ContextCompaction,
    ManualCompact,
}

impl RuntimeTurnStartedSource {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::ContextCompaction => "context_compaction",
            Self::ManualCompact => "manual_compact",
        }
    }
}

/// Lifecycle of the agent's underlying transport, surfaced provider-neutral
/// so any adapter (today only OpenCode emits these) can opt in. OpenCode ACP emits this from provider-specific workaround paths when needed.
#[derive(Debug, Clone)]
pub enum RuntimeStreamStatus {
    /// The transport is degraded (reconnecting, no heartbeat, reconcile
    /// failed). Carries a free-form reason for logging / tooltip.
    Degraded { reason: String },
    /// The transport recovered after a degraded period. The UI banner
    /// should clear.
    Recovered,
}

/// Provider-neutral metadata captured from a compaction boundary event.
///
/// Cadencr persists this alongside the `compact_divider` block so the UI can
/// surface why the compaction happened and how many tokens were freed.
#[derive(Debug, Clone, Default, Serialize)]
pub struct RuntimeCompactMetadata {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub trigger: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pre_tokens: Option<u64>,
}

#[derive(Debug, Clone)]
#[allow(dead_code)]
pub struct RuntimeInitEvent {
    pub model: Option<String>,
    pub mcp_servers: Vec<super::config::RuntimeMcpServerStatus>,
    pub context_window: Option<u64>,
}

#[derive(Debug, Clone)]
pub struct RuntimeAssistantMessage {
    pub model: Option<String>,
    pub content: Vec<RuntimeContentBlock>,
}

/// Borrowed view of a [`RuntimeEventKind::ProviderError`], returned by
/// [`RuntimeEvent::provider_error`](super::RuntimeEvent::provider_error).
#[derive(Debug, Clone, Copy)]
pub struct RuntimeProviderError<'a> {
    pub message: &'a str,
    pub code: Option<&'a str>,
    pub parent_tool_use_id: Option<&'a str>,
}

#[derive(Debug, Clone)]
pub struct RuntimeUserMessage {
    pub content: Vec<RuntimeUserContentBlock>,
}

#[derive(Debug, Clone)]
pub enum RuntimeContentBlock {
    Text {
        text: String,
    },
    Thinking {
        thinking: String,
    },
    ToolUse {
        id: String,
        name: String,
        input: Value,
    },
    Other,
}

#[derive(Debug, Clone)]
pub enum RuntimeUserContentBlock {
    ToolResult {
        tool_use_id: Option<String>,
        is_error: bool,
        content: Value,
    },
    Other,
}

#[derive(Debug, Clone)]
pub enum RuntimeStreamEvent {
    MessageStart {
        model: Option<String>,
        input_tokens: Option<u64>,
    },
    ContentBlockStart {
        index: u64,
        block: RuntimeContentBlock,
    },
    ContentBlockDelta {
        index: u64,
        delta: RuntimeContentDelta,
    },
    ContentBlockStop {
        index: u64,
    },
    Other,
}

#[derive(Debug, Clone)]
pub enum RuntimeContentDelta {
    Text { text: String },
    Thinking { thinking: String },
    InputJson { partial_json: String },
}
