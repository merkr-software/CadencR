use std::collections::HashMap;

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::types::{
    CompactMetadata, ContentBlock, ContentDelta, McpServerStatus, PluginInfo, Usage,
};

// ── StreamEventData ──────────────────────────────────────────────────────────

/// Body of a `message_start` streaming event.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MessageStartBody {
    pub id: String,
    pub model: String,
    #[serde(default)]
    pub usage: Option<Usage>,
    #[serde(rename = "type", default)]
    pub msg_type: Option<String>,
}

/// Body of a `message_delta` streaming event.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MessageDeltaBody {
    pub stop_reason: Option<String>,
}

/// All streaming event subtypes. Tagged by the `type` field.
///
/// `ContentBlockDelta` is the **critical** one — it carries `TextDelta`,
/// `ThinkingDelta`, and `InputJsonDelta` for real-time UI streaming.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type")]
pub enum StreamEventData {
    /// Marks the start of a message; carries initial usage info.
    #[serde(rename = "message_start")]
    MessageStart { message: MessageStartBody },

    /// Marks the start of a content block (text, tool_use, thinking).
    #[serde(rename = "content_block_start")]
    ContentBlockStart {
        index: u32,
        content_block: ContentBlock,
    },

    /// **THE critical event.** Carries partial text / thinking / tool-input JSON.
    #[serde(rename = "content_block_delta")]
    ContentBlockDelta { index: u32, delta: ContentDelta },

    /// Marks the end of a content block.
    #[serde(rename = "content_block_stop")]
    ContentBlockStop { index: u32 },

    /// Carries stop_reason and optional updated usage at message end.
    #[serde(rename = "message_delta")]
    MessageDelta {
        delta: MessageDeltaBody,
        usage: Option<Usage>,
    },

    /// Marks the complete end of the streamed message.
    #[serde(rename = "message_stop")]
    MessageStop,

    /// Any stream event the CLI emits that we don't model yet. Catching it here
    /// keeps a novel event from sinking the whole `stream_event` message into
    /// `SdkMessage::Unknown`, which would silently drop the live turn. Carries
    /// the raw JSON so the consumer can log/inspect what was dropped.
    #[serde(untagged)]
    Other(Value),
}

// ── SystemMessage ────────────────────────────────────────────────────────────

/// Typed `system` message subtypes. Tagged by the `subtype` field.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "subtype")]
pub enum SystemMessage {
    /// Session initialisation — carries session_id, model, tools, MCP servers.
    ///
    /// Cadencr captures `session_id` from this for resume workflows.
    #[serde(rename = "init")]
    Init {
        #[serde(default)]
        uuid: String,
        session_id: String,
        // Everything except `session_id` and `model` is defaulted: a single
        // renamed/removed field must never sink the whole init message into
        // `SdkMessage::Unknown`, because losing init means losing the
        // `session_id` capture that the entire resume/turn machinery depends on.
        #[serde(default)]
        claude_code_version: String,
        #[serde(default)]
        cwd: String,
        #[serde(default)]
        tools: Vec<String>,
        #[serde(default)]
        mcp_servers: Vec<McpServerStatus>,
        model: String,
        // The CLI emits this one field in camelCase (`permissionMode`);
        // without the alias the whole init message fails to deserialize
        // and falls back to `SdkMessage::Unknown`.
        #[serde(alias = "permissionMode", default)]
        permission_mode: String,
        #[serde(default)]
        slash_commands: Vec<String>,
        #[serde(default)]
        output_style: String,
        #[serde(default)]
        skills: Vec<String>,
        #[serde(default)]
        plugins: Vec<PluginInfo>,
        #[serde(default)]
        agents: Option<Vec<String>>,
        #[serde(default)]
        betas: Option<Vec<String>>,
        #[serde(flatten)]
        extra: HashMap<String, Value>,
    },

    /// Marks a context compaction boundary.
    ///
    /// Cadencr sets `was_compacted = true` when this is received.
    #[serde(rename = "compact_boundary")]
    CompactBoundary {
        uuid: String,
        session_id: String,
        compact_metadata: CompactMetadata,
    },

    /// Transient background-progress status update.
    ///
    /// Claude emits this for long-running work such as context compaction.
    #[serde(rename = "status")]
    Status {
        uuid: String,
        session_id: String,
        #[serde(default)]
        status: Option<String>,
        #[serde(default)]
        compact_result: Option<String>,
        #[serde(default)]
        compact_error: Option<String>,
        #[serde(flatten)]
        extra: HashMap<String, Value>,
    },
    // NOTE: intentionally NO `#[serde(other)]` catch-all here. The background
    // run-in-background agent protocol (issue #58) relies on the CLI's
    // `system/task_started` and `system/task_notification` subtypes arriving as
    // `SdkMessage::Unknown(raw)` so it can read their fields off the raw JSON
    // (see `background_agents::background_agent_signal`). A catch-all would
    // capture those as a typed-but-empty variant and silently break it.
}

impl SystemMessage {
    /// Returns the `session_id` regardless of subtype.
    pub fn session_id(&self) -> &str {
        match self {
            SystemMessage::Init { session_id, .. } => session_id,
            SystemMessage::CompactBoundary { session_id, .. } => session_id,
            SystemMessage::Status { session_id, .. } => session_id,
        }
    }

    /// `true` when this status message marks the start of a compaction.
    pub fn is_compaction_started(&self) -> bool {
        matches!(
            self,
            SystemMessage::Status { status: Some(s), .. } if s == "compacting"
        )
    }
}

// ── ModelUsageInfo ───────────────────────────────────────────────────────────

/// Per-model usage record from the CLI's `result` message `modelUsage` map.
///
/// The CLI emits a `modelUsage` object keyed by the fully-qualified model
/// identifier (e.g. `"claude-opus-4-7[1m]"`), with per-turn token counts and
/// — critically — the authoritative `contextWindow` for that model. This is
/// the source of truth for Cadencr's context-window tracking: no parsing of
/// description strings, no alias-prefix guessing.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ModelUsageInfo {
    #[serde(default)]
    pub input_tokens: u64,
    #[serde(default)]
    pub output_tokens: u64,
    #[serde(default)]
    pub cache_read_input_tokens: u64,
    #[serde(default)]
    pub cache_creation_input_tokens: u64,
    /// Authoritative context window reported by the CLI for this model.
    #[serde(default)]
    pub context_window: Option<u64>,
    #[serde(default)]
    pub max_output_tokens: Option<u64>,
    #[serde(default)]
    pub cost_usd: Option<f64>,
}

impl ModelUsageInfo {
    pub fn total_input_tokens(&self) -> u64 {
        self.input_tokens
            .saturating_add(self.cache_read_input_tokens)
            .saturating_add(self.cache_creation_input_tokens)
    }
}

// ── AssistantMessageBody ─────────────────────────────────────────────────────

/// Full assistant message body (emitted after a stream turn completes).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AssistantMessageBody {
    pub id: String,
    pub content: Vec<ContentBlock>,
    pub model: String,
    pub stop_reason: Option<String>,
    #[serde(default)]
    pub usage: Option<Usage>,
    #[serde(rename = "type", default)]
    pub msg_type: Option<String>,
}
