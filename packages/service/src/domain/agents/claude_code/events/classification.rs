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
            subtype,
            result,
            errors,
            stop_reason,
            ..
        } => {
            let error = is_error.then(|| {
                build_result_error(
                    &subtype,
                    result.as_deref(),
                    errors.as_deref(),
                    stop_reason.as_deref(),
                )
            });
            return (RuntimeEventKind::Result, error);
        }
        claude_agent_sdk_rs::SdkMessage::Malformed(message) => {
            return classify_malformed_message(message)
        }
        claude_agent_sdk_rs::SdkMessage::Unknown(raw) => classify_unknown_message(raw),
        // Background-task lifecycle frames: operational, consumed by the
        // background-agent / subagent observers off the raw payload.
        claude_agent_sdk_rs::SdkMessage::TaskLifecycle(_) => RuntimeEventKind::Other,
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
        | claude_agent_sdk_rs::SdkMessage::PromptSuggestion { .. }
        | claude_agent_sdk_rs::SdkMessage::CommandLifecycle { .. } => RuntimeEventKind::Other,
    };
    // Only a turn-ending `result` carries error detail; see `RuntimeResultError`.
    (kind, None)
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

/// Map a known message kind whose payload failed to decode. A `result` still
/// ends the turn — dropping it would leave the session "working" forever — and
/// carries a visible error unless the CLI explicitly reported success. Other
/// kinds keep the unmodeled-message handling of [`classify_unknown_message`].
fn classify_malformed_message(
    message: claude_agent_sdk_rs::messages::MalformedMessage,
) -> (RuntimeEventKind, Option<RuntimeResultError>) {
    if message.is_result() {
        let error = (message.reported_is_error() != Some(false))
            .then(|| build_malformed_result_error(&message));
        return (RuntimeEventKind::Result, error);
    }
    if message.message_type() == "system" {
        warn!(
            subtype = message.subtype().unwrap_or("<missing>"),
            error = message.error(),
            "claude adapter: malformed system message dropped"
        );
        return (RuntimeEventKind::Other, None);
    }
    (
        RuntimeEventKind::Unknown {
            raw: message.into_raw(),
        },
        None,
    )
}

fn build_malformed_result_error(
    message: &claude_agent_sdk_rs::messages::MalformedMessage,
) -> RuntimeResultError {
    let detail = message
        .raw()
        .get("result")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|text| !text.is_empty())
        .map(|text| format!(": {text}"))
        .unwrap_or_default();
    RuntimeResultError {
        code: "MALFORMED_RESULT".to_string(),
        message: format!(
            "Claude Code ended the turn with a result Cadencr could not read ({}){detail}",
            message.error()
        ),
    }
}

/// Map an unmodeled (`Unknown`) message to its runtime event kind. Keep the raw
/// payload so the stream reader can surface it to the conversation instead of
/// dropping it silently — the silent-stop class users couldn't diagnose. EXCEPT
/// `system` messages: those are operational metadata, not conversation content
/// (the CLI emits dozens of subtypes such as `api_retry` or `notification`), so
/// an untyped `system` subtype stays out of the conversation (`Other`) and logs
/// loudly so a CLI drift is diagnosable from the service log. Background-task
/// frames never land here: the SDK types them as `TaskLifecycle`. Known
/// subtypes with nothing to show stay quiet: `thinking_tokens` arrives once
/// per streamed thinking chunk and would flood the log.
fn classify_unknown_message(raw: Value) -> RuntimeEventKind {
    if raw_type(&raw) == "system" {
        const QUIET_SYSTEM_SUBTYPES: [&str; 1] = ["thinking_tokens"];
        let subtype = raw.get("subtype").and_then(Value::as_str);
        if !subtype.is_some_and(|s| QUIET_SYSTEM_SUBTYPES.contains(&s)) {
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
    use super::{build_result_error, classify_message, RuntimeEventKind};

    #[test]
    fn command_lifecycle_stays_out_of_the_conversation() {
        // Not conversation content: as `Unknown` it would render as an error.
        let msg = claude_agent_sdk_rs::SdkMessage::from_raw(serde_json::json!({
            "type": "command_lifecycle",
            "command_uuid": "c",
            "state": "completed",
            "uuid": "u",
            "session_id": "s"
        }));
        let (kind, result_error) = classify_message(msg);
        assert!(matches!(kind, RuntimeEventKind::Other));
        assert!(result_error.is_none());
    }

    /// Warnings logged while `f` runs.
    fn warnings_while(f: impl FnOnce()) -> String {
        #[derive(Clone, Default)]
        struct Captured(std::sync::Arc<std::sync::Mutex<Vec<u8>>>);
        impl std::io::Write for Captured {
            fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
                self.0.lock().unwrap().extend_from_slice(bytes);
                Ok(bytes.len())
            }
            fn flush(&mut self) -> std::io::Result<()> {
                Ok(())
            }
        }
        let captured = Captured::default();
        let writer = captured.clone();
        let subscriber = tracing_subscriber::fmt()
            .with_max_level(tracing::Level::WARN)
            .with_ansi(false)
            .with_writer(move || writer.clone())
            .finish();
        tracing::subscriber::with_default(subscriber, f);
        let logged = captured.0.lock().unwrap().clone();
        String::from_utf8(logged).unwrap()
    }

    fn classify_system(subtype: &str) -> (RuntimeEventKind, String) {
        let msg = claude_agent_sdk_rs::SdkMessage::from_raw(serde_json::json!({
            "type": "system", "subtype": subtype, "session_id": "s", "tokens": 12
        }));
        let mut classified = None;
        let warnings = warnings_while(|| classified = Some(classify_message(msg)));
        let (kind, result_error) = classified.unwrap();
        assert!(result_error.is_none());
        (kind, warnings)
    }

    #[test]
    fn thinking_tokens_frames_are_dropped_quietly() {
        let (kind, warnings) = classify_system("thinking_tokens");
        // Out of the conversation and not a turn boundary: the turn goes on.
        assert!(matches!(kind, RuntimeEventKind::Other));
        assert!(warnings.is_empty(), "unexpected warning: {warnings}");
    }

    #[test]
    fn an_unknown_system_subtype_still_warns() {
        let (kind, warnings) = classify_system("brand_new_subtype");
        assert!(matches!(kind, RuntimeEventKind::Other));
        assert!(
            warnings.contains("unrecognized system message dropped")
                && warnings.contains("brand_new_subtype"),
            "{warnings}"
        );
    }

    #[test]
    fn build_result_error_falls_back_to_a_generic_message_without_detail() {
        // A failing result with no human-readable text must still produce a
        // surfaceable message rather than an empty one.
        let error = build_result_error("error_max_turns", None, None, None);
        assert_eq!(error.code, "ERROR_MAX_TURNS");
        assert!(error.message.contains("error_max_turns"));
    }
}
