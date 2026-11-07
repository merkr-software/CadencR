use crate::messages::SdkMessage;

use super::inner::SdkMessageInner;

/// Fallback for a `result` whose `is_error` flag is unusable: the CLI tags
/// every failed turn with an `error*` subtype (`error_during_execution`,
/// `error_max_turns`, ...), so a failure stays a failure.
fn subtype_reports_error(subtype: &str) -> bool {
    subtype.starts_with("error")
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
                is_error: is_error.unwrap_or_else(|| subtype_reports_error(&subtype)),
                subtype,
                uuid,
                session_id,
                duration_ms,
                duration_api_ms,
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
            SdkMessageInner::CommandLifecycle {
                uuid,
                session_id,
                command_uuid,
                state,
            } => SdkMessage::CommandLifecycle {
                uuid,
                session_id,
                command_uuid,
                state,
            },
        }
    }
}
