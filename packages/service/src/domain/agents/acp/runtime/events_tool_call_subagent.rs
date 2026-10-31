//! Sub-agent facts for ACP dispatch tools (`Task` / `Agent` carriers).
//!
//! Standard ACP only says a tool call is `in_progress`, `completed` or
//! `failed`; the shared sub-agent tracker derives launch and result facts from
//! the tool_use / tool_result blocks, but ACP agents often surface a carrier's
//! input late (an `in_progress` update) and finish it without any result
//! content. This module turns those updates into `RuntimeSubagentUpdate`s so a
//! carrier is configured once its input lands and always settles when the
//! agent reports it terminal. Providers refine the terminal patch by returning
//! sub-agent signal events from `synthesize_tool_call_completion`; their
//! updates ride the same event as the generic ones, after them, so the
//! provider has the last word without a visible flicker.

use serde_json::Value;

use super::events_stream_blocks::EventIndexer;
use super::events_tool_call_metadata::is_empty_value;
use super::provider_hooks::AcpProviderHooks;
use super::tool_result_flatten::unwrap_nested_text_block;
use crate::domain::agents::adapter::{
    is_subagent_tool_name, stop_reason, summarize_subagent_result, RuntimeEvent,
    RuntimeSubagentPatch, RuntimeSubagentStatus, RuntimeSubagentUpdate,
};

/// Launch configuration carried by a carrier update's input, when present.
pub(super) fn carrier_input_update(
    tool_call_id: &str,
    tool_name: &str,
    body: &Value,
    hooks: &dyn AcpProviderHooks,
) -> Option<RuntimeSubagentUpdate> {
    if !is_subagent_tool_name(tool_name) {
        return None;
    }
    let input = body
        .get("rawInput")
        .filter(|value| value.is_object() && !is_empty_value(value))
        .or_else(|| body.get("toolInput").filter(|value| value.is_object()))?;
    let patch = RuntimeSubagentPatch::from_tool_input(
        &hooks.normalize_tool_input(tool_name, input.clone()),
    );
    (!patch.is_empty()).then(|| RuntimeSubagentUpdate::new(tool_call_id, patch))
}

/// A tool call reaching a terminal ACP status (`completed` / `failed`).
pub(super) struct TerminalToolCall<'a> {
    pub tool_call_id: &'a str,
    pub tool_name: &'a str,
    pub body: &'a Value,
    pub status: &'a str,
}

/// Settle a carrier on its terminal update.
///
/// `provider_events` are the provider's `synthesize_tool_call_completion`
/// output: signal-only events are folded into the call's terminal event (the
/// tool_result when one was emitted, else the closing stop) and the rest are
/// appended unchanged.
pub(super) fn settle_carrier(
    call: &TerminalToolCall<'_>,
    indexer: &EventIndexer,
    provider_events: Vec<RuntimeEvent>,
    events: &mut Vec<RuntimeEvent>,
) {
    let mut updates: Vec<RuntimeSubagentUpdate> = terminal_update(call).into_iter().collect();
    let mut passthrough = Vec::with_capacity(provider_events.len());
    for event in provider_events {
        if event.is_subagent_signal_only() {
            updates.extend(event.subagent_updates().iter().cloned());
        } else {
            passthrough.push(event);
        }
    }
    if indexer.turn_interrupted() {
        updates.iter_mut().for_each(mark_interrupted);
    }
    attach_to_terminal_event(events, updates);
    events.extend(passthrough);
}

fn terminal_update(call: &TerminalToolCall<'_>) -> Option<RuntimeSubagentUpdate> {
    if !is_subagent_tool_name(call.tool_name) {
        return None;
    }
    let patch = match call.status {
        "completed" => RuntimeSubagentPatch::status(RuntimeSubagentStatus::Completed),
        "failed" => RuntimeSubagentPatch {
            status: Some(RuntimeSubagentStatus::Failed),
            status_reason: failure_reason(call.body),
            ..RuntimeSubagentPatch::default()
        },
        _ => return None,
    };
    Some(RuntimeSubagentUpdate::new(call.tool_call_id, patch))
}

/// `rawOutput.error` (OpenCode, Cursor), a plain-text `rawOutput`, or the
/// text of the failed update's content.
pub(crate) fn failure_reason(body: &Value) -> Option<String> {
    let raw_output = body.get("rawOutput");
    let text = raw_output
        .and_then(|output| output.get("error"))
        .and_then(Value::as_str)
        .or_else(|| raw_output.and_then(Value::as_str))
        .map(ToOwned::to_owned)
        .or_else(|| content_text(body))?;
    summarize_subagent_result(&text)
}

fn content_text(body: &Value) -> Option<String> {
    let texts: Vec<&str> = body
        .get("content")
        .and_then(Value::as_array)?
        .iter()
        .filter_map(unwrap_nested_text_block)
        .collect();
    (!texts.is_empty()).then(|| texts.join("\n"))
}

/// A carrier the agent fails while the user cancels the turn was interrupted.
fn mark_interrupted(update: &mut RuntimeSubagentUpdate) {
    if update.patch.status == Some(RuntimeSubagentStatus::Failed) {
        update.patch.status = Some(RuntimeSubagentStatus::Stopped);
        update.patch.status_reason = Some(stop_reason::INTERRUPTED.to_string());
    }
}

fn attach_to_terminal_event(events: &mut Vec<RuntimeEvent>, updates: Vec<RuntimeSubagentUpdate>) {
    if updates.is_empty() {
        return;
    }
    let target = events
        .iter()
        .position(|event| event.user_message().is_some())
        .or_else(|| events.len().checked_sub(1));
    match target {
        Some(index) => {
            let event = events.remove(index).with_subagent_updates(updates);
            events.insert(index, event);
        }
        None => events.push(RuntimeEvent::subagent_signal(updates)),
    }
}

#[cfg(test)]
mod tests {
    use super::{carrier_input_update, failure_reason, settle_carrier, TerminalToolCall};
    use crate::domain::agents::acp::runtime::events_stream_blocks::EventIndexer;
    use crate::domain::agents::acp::runtime::standard_hooks::StandardAcpHooks;
    use crate::domain::agents::adapter::{
        RuntimeEvent, RuntimeEventKind, RuntimeEventMetadata, RuntimeSubagentPatch,
        RuntimeSubagentStatus, RuntimeSubagentUpdate,
    };
    use serde_json::json;

    fn stop() -> RuntimeEvent {
        RuntimeEvent::new(RuntimeEventMetadata::default(), RuntimeEventKind::Other)
    }

    fn call<'a>(
        tool_call_id: &'a str,
        tool_name: &'a str,
        body: &'a serde_json::Value,
        status: &'a str,
    ) -> TerminalToolCall<'a> {
        TerminalToolCall {
            tool_call_id,
            tool_name,
            body,
            status,
        }
    }

    #[test]
    fn late_raw_input_configures_the_carrier() {
        // OpenCode `runningToolUpdate` for the task tool (acp-tool.ts): the
        // input only lands on the in_progress update.
        let update = carrier_input_update(
            "call_task",
            "Task",
            &json!({
                "toolCallId": "call_task",
                "status": "in_progress",
                "kind": "think",
                "title": "Audit auth",
                "rawInput": {
                    "description": "Audit auth",
                    "prompt": "Look at the auth flow",
                    "subagent_type": "general",
                    "background": true
                }
            }),
            &StandardAcpHooks,
        )
        .expect("update");
        assert_eq!(update.tool_use_id, "call_task");
        assert_eq!(update.patch.agent_type.as_deref(), Some("general"));
        assert_eq!(
            update.patch.prompt.as_deref(),
            Some("Look at the auth flow")
        );
        assert_eq!(update.patch.background, Some(true));
        assert_eq!(update.patch.status, None);
    }

    #[test]
    fn input_update_ignores_ordinary_tools_and_empty_input() {
        let body = json!({ "rawInput": { "description": "x" } });
        assert!(carrier_input_update("t", "Bash", &body, &StandardAcpHooks).is_none());
        let empty = json!({ "rawInput": { "_toolName": "task" } });
        assert!(carrier_input_update("t", "Agent", &empty, &StandardAcpHooks).is_none());
        assert!(carrier_input_update("t", "Agent", &json!({}), &StandardAcpHooks).is_none());
    }

    #[test]
    fn completed_carrier_without_content_still_completes() {
        let mut events = vec![stop()];
        settle_carrier(
            &call(
                "agent-1",
                "Agent",
                &json!({ "toolCallId": "agent-1" }),
                "completed",
            ),
            &EventIndexer::default(),
            Vec::new(),
            &mut events,
        );
        assert_eq!(events.len(), 1);
        let updates = events[0].subagent_updates();
        assert_eq!(updates[0].tool_use_id, "agent-1");
        assert_eq!(
            updates[0].patch.status,
            Some(RuntimeSubagentStatus::Completed)
        );
    }

    #[test]
    fn failed_carrier_records_the_error() {
        // OpenCode `errorToolUpdate` shape (acp-tool.ts).
        let body = json!({
            "toolCallId": "call_task",
            "status": "failed",
            "content": [{ "type": "content", "content": { "type": "text", "text": "boom" } }],
            "rawOutput": { "error": "Subagent failed (task_id: ses_c): rate limited", "metadata": {} }
        });
        let mut events = vec![stop()];
        settle_carrier(
            &call("call_task", "Task", &body, "failed"),
            &EventIndexer::default(),
            Vec::new(),
            &mut events,
        );
        let patch = &events[0].subagent_updates()[0].patch;
        assert_eq!(patch.status, Some(RuntimeSubagentStatus::Failed));
        assert_eq!(
            patch.status_reason.as_deref(),
            Some("Subagent failed (task_id: ses_c): rate limited")
        );
        assert_eq!(
            failure_reason(&json!({ "content": [{ "type": "text", "text": "plain" }] })).as_deref(),
            Some("plain")
        );
    }

    #[test]
    fn provider_signal_rides_the_tool_result_after_the_generic_patch() {
        let result = RuntimeEvent::new(
            RuntimeEventMetadata::default(),
            RuntimeEventKind::UserMessage {
                message: crate::domain::agents::adapter::RuntimeUserMessage { content: vec![] },
                parent_tool_use_id: None,
            },
        );
        let mut events = vec![result, stop()];
        let provider = RuntimeEvent::subagent_signal(vec![RuntimeSubagentUpdate::new(
            "agent-1",
            RuntimeSubagentPatch {
                status: Some(RuntimeSubagentStatus::Failed),
                status_reason: Some("quota".into()),
                ..RuntimeSubagentPatch::default()
            },
        )]);
        let text = stop();
        settle_carrier(
            &call(
                "agent-1",
                "Agent",
                &json!({ "rawOutput": { "error": "quota" } }),
                "completed",
            ),
            &EventIndexer::default(),
            vec![provider, text],
            &mut events,
        );
        assert_eq!(events.len(), 3, "signal folded, other event appended");
        let updates = events[0].subagent_updates();
        assert_eq!(updates.len(), 2);
        assert_eq!(
            updates[0].patch.status,
            Some(RuntimeSubagentStatus::Completed)
        );
        assert_eq!(updates[1].patch.status, Some(RuntimeSubagentStatus::Failed));
        assert!(events[1].subagent_updates().is_empty());
    }

    #[test]
    fn failure_during_cancellation_is_an_interruption() {
        let mut indexer = EventIndexer::default();
        let cancel = crate::domain::agents::acp::runtime::turn_lifecycle::PromptCancel::new();
        indexer.watch_prompt_cancel(cancel.clone());
        cancel.cancel_current_turn();
        let mut events = vec![stop()];
        let body = json!({ "rawOutput": { "error": "Tool execution aborted" } });
        settle_carrier(
            &call("call_task", "Task", &body, "failed"),
            &indexer,
            Vec::new(),
            &mut events,
        );
        let patch = &events[0].subagent_updates()[0].patch;
        assert_eq!(patch.status, Some(RuntimeSubagentStatus::Stopped));
        assert_eq!(patch.status_reason.as_deref(), Some("interrupted"));
    }

    #[test]
    fn ordinary_tools_get_no_terminal_patch() {
        let mut events = vec![stop()];
        settle_carrier(
            &call("bash-1", "Bash", &json!({}), "failed"),
            &EventIndexer::default(),
            Vec::new(),
            &mut events,
        );
        assert!(events[0].subagent_updates().is_empty());
    }
}
