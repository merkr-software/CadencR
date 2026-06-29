use std::collections::HashMap;

use serde::{Deserialize, Deserializer};
use serde_json::Value;
use tracing::warn;

use crate::types::{PermissionDenial, Usage};

use super::events::{AssistantMessageBody, ModelUsageInfo, StreamEventData, SystemMessage};
use super::sdk_message::SdkMessage;

// ── Custom Deserialize for SdkMessage ────────────────────────────────────────

/// Internal mirror of `SdkMessage` used by the derived deserializer.
/// We keep this private and convert into the public enum, adding the
/// `Unknown` fallback path.
#[derive(Deserialize)]
#[serde(tag = "type")]
enum SdkMessageInner {
    #[serde(rename = "stream_event")]
    StreamEvent {
        event: StreamEventData,
        parent_tool_use_id: Option<String>,
        uuid: String,
        session_id: String,
    },
    #[serde(rename = "result")]
    Result {
        subtype: String,
        uuid: String,
        session_id: String,
        duration_ms: u64,
        duration_api_ms: u64,
        is_error: bool,
        num_turns: u64,
        result: Option<String>,
        errors: Option<Vec<String>>,
        stop_reason: Option<String>,
        total_cost_usd: f64,
        usage: Usage,
        #[serde(default)]
        permission_denials: Vec<PermissionDenial>,
        structured_output: Option<Value>,
        #[serde(default, rename = "modelUsage")]
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
    #[serde(rename = "rate_limit", alias = "rate_limit_event")]
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
}

impl From<SdkMessageInner> for SdkMessage {
    fn from(inner: SdkMessageInner) -> Self {
        match inner {
            SdkMessageInner::StreamEvent {
                event,
                parent_tool_use_id,
                uuid,
                session_id,
            } => SdkMessage::StreamEvent {
                event,
                parent_tool_use_id,
                uuid,
                session_id,
            },
            SdkMessageInner::Result {
                subtype,
                uuid,
                session_id,
                duration_ms,
                duration_api_ms,
                is_error,
                num_turns,
                result,
                errors,
                stop_reason,
                total_cost_usd,
                usage,
                permission_denials,
                structured_output,
                model_usage,
                extra,
            } => SdkMessage::Result {
                subtype,
                uuid,
                session_id,
                duration_ms,
                duration_api_ms,
                is_error,
                num_turns,
                result,
                errors,
                stop_reason,
                total_cost_usd,
                usage,
                permission_denials,
                structured_output,
                model_usage,
                extra,
            },
            SdkMessageInner::System(s) => SdkMessage::System(s),
            SdkMessageInner::Assistant {
                uuid,
                session_id,
                message,
                parent_tool_use_id,
                error,
                is_api_error_message,
                api_error_status,
            } => SdkMessage::Assistant {
                uuid,
                session_id,
                message,
                parent_tool_use_id,
                error,
                is_api_error_message,
                api_error_status,
            },
            SdkMessageInner::User {
                uuid,
                session_id,
                message,
                parent_tool_use_id,
                is_synthetic,
                tool_use_result,
                is_replay,
            } => SdkMessage::User {
                uuid,
                session_id,
                message,
                parent_tool_use_id,
                is_synthetic,
                tool_use_result,
                is_replay,
            },
            SdkMessageInner::Status {
                uuid,
                session_id,
                data,
            } => SdkMessage::Status {
                uuid,
                session_id,
                data,
            },
            SdkMessageInner::HookStarted {
                uuid,
                session_id,
                hook_event,
                hook_id,
                matcher,
            } => SdkMessage::HookStarted {
                uuid,
                session_id,
                hook_event,
                hook_id,
                matcher,
            },
            SdkMessageInner::HookProgress {
                uuid,
                session_id,
                hook_id,
                data,
            } => SdkMessage::HookProgress {
                uuid,
                session_id,
                hook_id,
                data,
            },
            SdkMessageInner::HookResponse {
                uuid,
                session_id,
                hook_id,
                data,
            } => SdkMessage::HookResponse {
                uuid,
                session_id,
                hook_id,
                data,
            },
            SdkMessageInner::ToolProgress {
                uuid,
                session_id,
                tool_use_id,
                data,
            } => SdkMessage::ToolProgress {
                uuid,
                session_id,
                tool_use_id,
                data,
            },
            SdkMessageInner::AuthStatus {
                uuid,
                session_id,
                data,
            } => SdkMessage::AuthStatus {
                uuid,
                session_id,
                data,
            },
            SdkMessageInner::TaskNotification {
                uuid,
                session_id,
                task_id,
                data,
            } => SdkMessage::TaskNotification {
                uuid,
                session_id,
                task_id,
                data,
            },
            SdkMessageInner::TaskStarted {
                uuid,
                session_id,
                task_id,
                data,
            } => SdkMessage::TaskStarted {
                uuid,
                session_id,
                task_id,
                data,
            },
            SdkMessageInner::TaskProgress {
                uuid,
                session_id,
                task_id,
                data,
            } => SdkMessage::TaskProgress {
                uuid,
                session_id,
                task_id,
                data,
            },
            SdkMessageInner::FilesPersisted {
                uuid,
                session_id,
                data,
            } => SdkMessage::FilesPersisted {
                uuid,
                session_id,
                data,
            },
            SdkMessageInner::ToolUseSummary {
                uuid,
                session_id,
                data,
            } => SdkMessage::ToolUseSummary {
                uuid,
                session_id,
                data,
            },
            SdkMessageInner::RateLimit {
                uuid,
                session_id,
                data,
            } => SdkMessage::RateLimit {
                uuid,
                session_id,
                data,
            },
            SdkMessageInner::PromptSuggestion {
                uuid,
                session_id,
                suggestion,
            } => SdkMessage::PromptSuggestion {
                uuid,
                session_id,
                suggestion,
            },
        }
    }
}

impl<'de> Deserialize<'de> for SdkMessage {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> std::result::Result<Self, D::Error> {
        // Buffer the raw value so we can try again on failure.
        let raw = Value::deserialize(deserializer)?;
        match SdkMessageInner::deserialize(&raw) {
            Ok(inner) => Ok(SdkMessage::from(inner)),
            Err(error) => {
                // Never silently drop: a message that fails to match any known
                // schema becomes `Unknown` (so the stream survives), but we log
                // exactly what and why so a CLI wire-format drift is diagnosable
                // instead of presenting as an agent that "just stopped".
                let message_type = raw
                    .get("type")
                    .and_then(|v| v.as_str())
                    .unwrap_or("<missing>");
                let subtype = raw.get("subtype").and_then(|v| v.as_str());
                warn!(
                    message_type,
                    ?subtype,
                    %error,
                    "claude SDK: message did not match any known schema; forwarding as Unknown (it will not render in the conversation)"
                );
                Ok(SdkMessage::Unknown(raw))
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn deserializes_api_error_markers_on_assistant() {
        let msg: SdkMessage = serde_json::from_value(json!({
            "type": "assistant",
            "uuid": "u",
            "session_id": "s",
            "message": { "id": "syn", "model": "<synthetic>", "content": [] },
            "error": "server_error",
            "isApiErrorMessage": true,
            "apiErrorStatus": 529
        }))
        .expect("valid assistant");

        match msg {
            SdkMessage::Assistant {
                is_api_error_message,
                api_error_status,
                error,
                ..
            } => {
                assert!(is_api_error_message);
                assert_eq!(api_error_status, Some(529));
                assert_eq!(error.as_deref(), Some("server_error"));
            }
            other => panic!("expected assistant, got {other:?}"),
        }
    }

    #[test]
    fn defaults_api_error_markers_when_absent() {
        let msg: SdkMessage = serde_json::from_value(json!({
            "type": "assistant",
            "uuid": "u",
            "session_id": "s",
            "message": { "id": "m", "model": "claude-opus-4-8", "content": [] }
        }))
        .expect("valid assistant");

        match msg {
            SdkMessage::Assistant {
                is_api_error_message,
                api_error_status,
                ..
            } => {
                assert!(!is_api_error_message);
                assert_eq!(api_error_status, None);
            }
            other => panic!("expected assistant, got {other:?}"),
        }
    }
}
