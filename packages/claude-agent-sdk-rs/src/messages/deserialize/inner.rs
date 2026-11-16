use std::collections::HashMap;

use serde::Deserialize;
use serde_json::Value;

use crate::types::{PermissionDenial, Usage};

use crate::messages::{AssistantMessageBody, ModelUsageInfo, StreamEventData, SystemMessage};

use super::lenient::lenient;

/// `type` tags [`SdkMessageInner`] models. A payload carrying one of these
/// that still fails to decode is malformed, not unknown.
pub(super) const KNOWN_TYPES: [&str; 20] = [
    "stream_event",
    "result",
    "system",
    "assistant",
    "user",
    "status",
    "hook_started",
    "hook_progress",
    "hook_response",
    "tool_progress",
    "auth_status",
    "task_notification",
    "task_started",
    "task_progress",
    "files_persisted",
    "tool_use_summary",
    "rate_limit_event",
    "rate_limit",
    "prompt_suggestion",
    "command_lifecycle",
];

/// `subtype` tags [`SystemMessage`] models; any other `system` subtype is a
/// message kind the SDK has never seen.
pub(super) const KNOWN_SYSTEM_SUBTYPES: [&str; 3] = ["init", "compact_boundary", "status"];

/// Internal mirror of `SdkMessage` used by the derived deserializer.
/// We keep this private and convert into the public enum, adding the
/// `Unknown` fallback path.
#[derive(Deserialize)]
#[serde(tag = "type")]
pub(super) enum SdkMessageInner {
    #[serde(rename = "stream_event")]
    StreamEvent {
        event: StreamEventData,
        parent_tool_use_id: Option<String>,
        uuid: String,
        session_id: String,
    },
    /// Everything but the `subtype` tag tolerates absence, `null` and drift:
    /// a `result` that fails to decode would never complete the turn.
    #[serde(rename = "result")]
    Result {
        subtype: String,
        #[serde(default, deserialize_with = "lenient")]
        uuid: String,
        #[serde(default, deserialize_with = "lenient")]
        session_id: String,
        #[serde(default, deserialize_with = "lenient")]
        duration_ms: u64,
        #[serde(default, deserialize_with = "lenient")]
        duration_api_ms: u64,
        /// `None` when absent, `null` or drifted: the conversion then derives
        /// it from `subtype` rather than reporting a failed turn as a success.
        #[serde(default, deserialize_with = "lenient")]
        is_error: Option<bool>,
        #[serde(default, deserialize_with = "lenient")]
        num_turns: u64,
        #[serde(default, deserialize_with = "lenient")]
        result: Option<String>,
        #[serde(default, deserialize_with = "lenient")]
        errors: Option<Vec<String>>,
        #[serde(default, deserialize_with = "lenient")]
        stop_reason: Option<String>,
        #[serde(default, deserialize_with = "lenient")]
        total_cost_usd: f64,
        #[serde(default, deserialize_with = "lenient")]
        usage: Usage,
        #[serde(default, deserialize_with = "lenient")]
        permission_denials: Vec<PermissionDenial>,
        #[serde(default, deserialize_with = "lenient")]
        structured_output: Option<Value>,
        #[serde(default, rename = "modelUsage", deserialize_with = "lenient")]
        model_usage: HashMap<String, ModelUsageInfo>,
        #[serde(flatten)]
        extra: HashMap<String, Value>,
    },
    #[serde(rename = "system")]
    System(SystemMessage),
    #[serde(rename = "assistant")]
    Assistant {
        uuid: String,
        session_id: String,
        message: AssistantMessageBody,
        parent_tool_use_id: Option<String>,
        error: Option<String>,
        #[serde(default, rename = "isApiErrorMessage")]
        is_api_error_message: bool,
        #[serde(default, rename = "apiErrorStatus")]
        api_error_status: Option<u16>,
    },
    #[serde(rename = "user")]
    User {
        uuid: Option<String>,
        session_id: String,
        message: Value,
        parent_tool_use_id: Option<String>,
        #[serde(default)]
        is_synthetic: Option<bool>,
        tool_use_result: Option<Value>,
        #[serde(default)]
        is_replay: Option<bool>,
    },
    #[serde(rename = "status")]
    Status {
        uuid: String,
        session_id: String,
        #[serde(flatten)]
        data: Value,
    },
    #[serde(rename = "hook_started")]
    HookStarted {
        uuid: String,
        session_id: String,
        hook_event: String,
        hook_id: String,
        matcher: Option<String>,
    },
    #[serde(rename = "hook_progress")]
    HookProgress {
        uuid: String,
        session_id: String,
        hook_id: String,
        #[serde(flatten)]
        data: Value,
    },
    #[serde(rename = "hook_response")]
    HookResponse {
        uuid: String,
        session_id: String,
        hook_id: String,
        #[serde(flatten)]
        data: Value,
    },
    #[serde(rename = "tool_progress")]
    ToolProgress {
        uuid: String,
        session_id: String,
        tool_use_id: String,
        #[serde(flatten)]
        data: Value,
    },
    #[serde(rename = "auth_status")]
    AuthStatus {
        uuid: String,
        session_id: String,
        #[serde(flatten)]
        data: Value,
    },
    #[serde(rename = "task_notification")]
    TaskNotification {
        uuid: String,
        session_id: String,
        task_id: String,
        #[serde(flatten)]
        data: Value,
    },
    #[serde(rename = "task_started")]
    TaskStarted {
        uuid: String,
        session_id: String,
        task_id: String,
        #[serde(flatten)]
        data: Value,
    },
    #[serde(rename = "task_progress")]
    TaskProgress {
        uuid: String,
        session_id: String,
        task_id: String,
        #[serde(flatten)]
        data: Value,
    },
    #[serde(rename = "files_persisted")]
    FilesPersisted {
        uuid: String,
        session_id: String,
        #[serde(flatten)]
        data: Value,
    },
    #[serde(rename = "tool_use_summary")]
    ToolUseSummary {
        uuid: String,
        session_id: String,
        #[serde(flatten)]
        data: Value,
    },
    #[serde(rename = "rate_limit_event", alias = "rate_limit")]
    RateLimit {
        uuid: String,
        session_id: String,
        #[serde(flatten)]
        data: Value,
    },
    #[serde(rename = "prompt_suggestion")]
    PromptSuggestion {
        uuid: String,
        session_id: String,
        suggestion: String,
    },
    #[serde(rename = "command_lifecycle")]
    CommandLifecycle {
        uuid: String,
        session_id: String,
        command_uuid: String,
        state: String,
    },
}
