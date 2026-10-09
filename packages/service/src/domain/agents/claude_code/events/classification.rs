use serde_json::Value;
use tracing::warn;

use super::mapping::{
    api_error_text, map_content_block, map_stream_event, map_user_message, raw_type,
};
use crate::domain::agents::adapter::{
    RuntimeAssistantMessage, RuntimeCompactMetadata, RuntimeEventKind, RuntimeInitEvent,
    RuntimeMcpServerStatus, RuntimeResultError, RuntimeTurnStartedSource,
};

/// Map an `SdkMessage` to its runtime event kind plus, for a failing `Result`,
/// the extracted [`RuntimeResultError`]. Split out of [`normalize_event`]
/// (which keeps metadata assembly) so each stays within the function-size
/// budget. The match is intentionally exhaustive — no `_` catch-all — so a new
/// SDK variant is a compile error here instead of a silent drop.
pub(super) fn classify_message(
    msg: claude_agent_sdk_rs::SdkMessage,
) -> (RuntimeEventKind, Option<RuntimeResultError>) {
    // Populated by a failing (`is_error`) `Result`; see `RuntimeResultError`.
    let mut result_error: Option<RuntimeResultError> = None;

    let kind = match msg {
        claude_agent_sdk_rs::SdkMessage::System(system) => classify_system_message(system),
        claude_agent_sdk_rs::SdkMessage::Assistant {
            message,
            parent_tool_use_id,
            error,
            is_api_error_message,
            api_error_status,
            ..
        } if is_api_error_message => RuntimeEventKind::ProviderError {
            message: api_error_text(&message.content, error.as_deref()),
            code: Some(
                api_error_status
                    .map(|status| format!("API_ERROR_{status}"))
                    .unwrap_or_else(|| "API_ERROR".to_string()),
            ),
            parent_tool_use_id,
        },
        claude_agent_sdk_rs::SdkMessage::Assistant {
            message,
            parent_tool_use_id,
            ..
        } => RuntimeEventKind::AssistantMessage {
            message: RuntimeAssistantMessage {
                model: Some(message.model),
                content: message.content.iter().map(map_content_block).collect(),
            },
            parent_tool_use_id,
        },
        claude_agent_sdk_rs::SdkMessage::User {
            message,
            parent_tool_use_id,
            ..
        } => RuntimeEventKind::UserMessage {
            message: map_user_message(&message),
            parent_tool_use_id,
        },
        claude_agent_sdk_rs::SdkMessage::StreamEvent {
            event,
            parent_tool_use_id,
            ..
        } => RuntimeEventKind::StreamEvent {
            event: map_stream_event(&event),
            parent_tool_use_id,
        },
        claude_agent_sdk_rs::SdkMessage::ToolUseSummary { data, .. } => {
            RuntimeEventKind::ToolUseSummary { data }
        }
        claude_agent_sdk_rs::SdkMessage::Result {
            is_error,
            ref subtype,
            ref result,
            ref errors,
            ref stop_reason,
            ..
        } => {
            if is_error {
                result_error = Some(build_result_error(
                    subtype,
                    result.as_deref(),
                    errors.as_deref(),
                    stop_reason.as_deref(),
                ));
            }
            RuntimeEventKind::Result
        }
        claude_agent_sdk_rs::SdkMessage::Unknown(raw) => classify_unknown_message(raw),
        // Modeled operational messages, intentionally not part of the
        // conversation. Listed explicitly (no `_` catch-all) so a future SDK
        // variant is a compile error here instead of a silent drop.
        claude_agent_sdk_rs::SdkMessage::Status { .. }
        | claude_agent_sdk_rs::SdkMessage::HookStarted { .. }
        | claude_agent_sdk_rs::SdkMessage::HookProgress { .. }
        | claude_agent_sdk_rs::SdkMessage::HookResponse { .. }
        | claude_agent_sdk_rs::SdkMessage::ToolProgress { .. }
        | claude_agent_sdk_rs::SdkMessage::AuthStatus { .. }
        | claude_agent_sdk_rs::SdkMessage::TaskNotification { .. }
        | claude_agent_sdk_rs::SdkMessage::TaskStarted { .. }
        | claude_agent_sdk_rs::SdkMessage::TaskProgress { .. }
        | claude_agent_sdk_rs::SdkMessage::FilesPersisted { .. }
        | claude_agent_sdk_rs::SdkMessage::RateLimit { .. }
        | claude_agent_sdk_rs::SdkMessage::PromptSuggestion { .. } => RuntimeEventKind::Other,
    };

    (kind, result_error)
}

/// Map a `system` message to its runtime event kind. Compaction start is a
/// synthetic turn boundary; its end/failure is carried by the typed
/// `CompactBoundary` and the compact command's own response, so other status
/// values are operational and unmapped — but a status we've never seen must
/// leave a trace.
fn classify_system_message(
    system: claude_agent_sdk_rs::messages::SystemMessage,
) -> RuntimeEventKind {
    match system {
        claude_agent_sdk_rs::messages::SystemMessage::Init {
            model, mcp_servers, ..
        } => {
            RuntimeEventKind::Init(RuntimeInitEvent {
                model: Some(model),
                mcp_servers: mcp_servers
                    .into_iter()
                    .map(|server| RuntimeMcpServerStatus {
                        name: server.name,
                        status: server.status,
                    })
                    .collect(),
                // The CLI's init carries no window; the adapter resolves it
                // from windows learned off earlier results.
                context_window: None,
            })
        }
        claude_agent_sdk_rs::messages::SystemMessage::CompactBoundary {
            compact_metadata, ..
        } => RuntimeEventKind::CompactBoundary {
            metadata: Some(RuntimeCompactMetadata {
                trigger: Some(compact_metadata.trigger),
                pre_tokens: Some(compact_metadata.pre_tokens),
            }),
        },
        status @ claude_agent_sdk_rs::messages::SystemMessage::Status { .. } => {
            if status.is_compaction_started() {
                RuntimeEventKind::TurnStarted {
                    source: RuntimeTurnStartedSource::ManualCompact,
                }
            } else {
                if let claude_agent_sdk_rs::messages::SystemMessage::Status {
                    status: Some(value),
                    compact_result: None,
                    compact_error: None,
                    ..
                } = &status
                {
                    warn!(status = %value, "claude adapter: unrecognized system status dropped");
                }
                RuntimeEventKind::Other
            }
        }
    }
}

/// Map an unmodeled (`Unknown`) message to its runtime event kind. Keep the raw
/// payload so the stream reader can surface it to the conversation instead of
/// dropping it silently — the silent-stop class users couldn't diagnose. EXCEPT
/// `system` messages: those are operational metadata, not conversation content,
/// and the run-in-background agent protocol (issue #58) emits
/// `system/task_started` / `system/task_notification` that arrive here as
/// Unknown by design. Surfacing those as visible errors would spam the
/// conversation on every background-agent run, so an unknown `system` subtype
/// stays out of the conversation (`Other`) — but only the allowlisted
/// background-task subtypes stay *quiet*; anything else logs loudly so a CLI
/// drift is diagnosable from the service log.
fn classify_unknown_message(raw: Value) -> RuntimeEventKind {
    if raw_type(&raw) == "system" {
        let subtype = raw.get("subtype").and_then(Value::as_str);
        const IGNORED_SYSTEM_SUBTYPES: [&str; 3] =
            ["task_started", "task_notification", "task_progress"];
        if !subtype.is_some_and(|s| IGNORED_SYSTEM_SUBTYPES.contains(&s)) {
            warn!(
                subtype = subtype.unwrap_or("<missing>"),
                "claude adapter: unrecognized system message dropped"
            );
        }
        RuntimeEventKind::Other
    } else {
        RuntimeEventKind::Unknown { raw }
    }
}

/// Assemble a [`RuntimeResultError`] from a failing Claude Code `Result`.
/// `code` is the upper-cased subtype (e.g. `ERROR_DURING_EXECUTION`) so the
/// failure mode is identifiable; the message prefers the CLI's human-readable
/// `result` text, then any `errors`, and appends a `stop_reason` when present.
pub(super) fn build_result_error(
    subtype: &str,
    result: Option<&str>,
    errors: Option<&[String]>,
    stop_reason: Option<&str>,
) -> RuntimeResultError {
    let code = if subtype.is_empty() {
        "AGENT_ERROR".to_string()
    } else {
        subtype.to_uppercase()
    };
    let detail = result
        .map(str::trim)
        .filter(|text| !text.is_empty())
        .map(ToOwned::to_owned)
        .or_else(|| {
            errors
                .filter(|list| !list.is_empty())
                .map(|list| list.join("; "))
        });
    let mut message = match detail {
        Some(detail) => format!("Claude Code ended the turn with an error ({subtype}): {detail}"),
        None => format!("Claude Code ended the turn with an error ({subtype})."),
    };
    if let Some(reason) = stop_reason
        .map(str::trim)
        .filter(|reason| !reason.is_empty())
    {
        message.push_str(&format!(" [stop reason: {reason}]"));
    }
    RuntimeResultError { code, message }
}

#[cfg(test)]
mod tests {
    use super::build_result_error;

    #[test]
    fn build_result_error_falls_back_to_a_generic_message_without_detail() {
        // A failing result with no human-readable text must still produce a
        // surfaceable message rather than an empty one.
        let error = build_result_error("error_max_turns", None, None, None);
        assert_eq!(error.code, "ERROR_MAX_TURNS");
        assert!(error.message.contains("error_max_turns"));
    }
}
