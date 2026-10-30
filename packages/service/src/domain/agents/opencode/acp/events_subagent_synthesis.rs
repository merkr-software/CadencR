//! Synthesise the cleaned final-text block for an OpenCode sub-agent
//! (`Task` / `Agent`) tool completion.
//!
//! OpenCode does **not** stream a sub-agent's intermediate events on the
//! parent JSON-RPC stream. Inspecting the live wire log shows the parent
//! session only ever receives:
//!
//! 1. A parent `tool_call` with empty `rawInput` and `title: "task"`.
//! 2. An in-progress `tool_call_update` with full
//!    `rawInput {description, prompt, subagent_type, task_id, command}`.
//! 3. A single completed `tool_call_update` whose payload contains:
//!    - `content[0]` = an `{type:"content", content:{type:"text", text:…}}`
//!      envelope wrapping the body
//!    - `rawOutput.output` = the same body
//!    - `rawOutput.metadata.sessionId` = the (otherwise unused) sub-agent
//!      session id
//!
//! The body itself is wrapped in one of two shapes OpenCode has used:
//!
//! - Legacy: `task_id: <child-session>\n\n<task_result>\n…body…\n</task_result>`
//! - Current (`renderOutput` in `tool/task.ts`):  
//!   `<task id="…" state="completed">\n<task_result>\n…body…\n</task_result>\n</task>`
//!
//! This module strips those wrappers and builds a synthetic
//! `AssistantMessage` event tagged with `parent_tool_use_id == <task
//! tool_use_id>` so the FE's existing nesting path renders the body as a
//! child Text block inside the Task tool block. Mirrors the Codex pattern
//! in `domain::agents::codex::event_subagents::synthetic_text_event`.

use serde_json::{json, Value};

use crate::domain::agents::acp::runtime::provider_hooks::unwrap_nested_text_block;
use crate::domain::agents::adapter::{
    RuntimeAssistantMessage, RuntimeContentBlock, RuntimeEvent, RuntimeEventKind,
    RuntimeEventMetadata,
};

/// Pull the cleaned sub-agent body text out of a Task / Agent
/// `tool_call_update` body. Prefers `rawOutput.output` (most authoritative),
/// falls back to recursively-unwrapped `content[0]`. Strips OpenCode's
/// legacy `task_id:` preamble and/or `<task id=…>` envelope plus inner
/// `<task_result>` / `<task_error>` markers, then trims. Returns `None` if
/// no body text is present or the result is empty.
pub(super) fn extract_subagent_body(body: &Value) -> Option<String> {
    let raw = raw_text_from_body(body)?;
    let cleaned = strip_subagent_wrappers(&raw);
    let trimmed = cleaned.trim();
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed.to_string())
    }
}

fn raw_text_from_body(body: &Value) -> Option<String> {
    if let Some(output) = body
        .get("rawOutput")
        .and_then(|raw_output| raw_output.get("output"))
        .and_then(Value::as_str)
    {
        return Some(output.to_string());
    }
    let content = body.get("content").and_then(Value::as_array)?;
    for entry in content {
        if let Some(text) = unwrap_nested_text_block(entry) {
            return Some(text.to_string());
        }
    }
    None
}

/// Strip OpenCode's Task output wrappers.
///
/// Handles both the legacy `task_id:` preamble and the current
/// `<task id="…" state="…">…</task>` envelope, then peels
/// `<task_result>` / `</task_result>` (or `<task_error>`). Defensive: if
/// markers are absent, leave the rest of the text unchanged so a future
/// wire-shape change still surfaces something readable.
fn strip_subagent_wrappers(raw: &str) -> String {
    let without_prefix = match raw.split_once("\n\n") {
        Some((first_line, rest)) if first_line.trim_start().starts_with("task_id:") => rest,
        _ => raw,
    };
    let without_task_envelope = strip_task_element(without_prefix);
    let trimmed = without_task_envelope.trim();
    for tag in ["task_result", "task_error"] {
        if let Some(inside) = extract_tagged(trimmed, tag) {
            return inside.trim().to_string();
        }
    }
    trimmed.to_string()
}

/// Peel a leading `<task …>` / trailing `</task>` envelope when present.
/// Must not treat `<task_result>` / `<task_error>` as the outer envelope.
fn strip_task_element(raw: &str) -> &str {
    let trimmed = raw.trim();
    let Some(rest) = trimmed.strip_prefix("<task") else {
        return trimmed;
    };
    // `<task` must be followed by whitespace, `>`, or `/` — not `_result`.
    match rest.chars().next() {
        Some(' ' | '\t' | '\n' | '\r' | '>' | '/') => {}
        _ => return trimmed,
    }
    let Some(after_open) = rest.find('>').map(|index| &rest[index + 1..]) else {
        return trimmed;
    };
    after_open
        .trim()
        .strip_suffix("</task>")
        .map(str::trim_end)
        .unwrap_or(after_open.trim())
}

fn extract_tagged<'a>(raw: &'a str, tag: &str) -> Option<&'a str> {
    let start_tag = format!("<{tag}>");
    let end_tag = format!("</{tag}>");
    let start = raw.find(&start_tag)?;
    let content_start = start + start_tag.len();
    let end = raw[content_start..].find(&end_tag)? + content_start;
    Some(&raw[content_start..end])
}

/// Build the synthetic `AssistantMessage` event that nests under the parent
/// Task block via `parent_tool_use_id`. The raw JSON envelope is shaped like
/// a normal assistant text message (matching codex's pattern) so the FE's
/// existing `processAssistantMessage` dispatch routes it correctly.
pub(super) fn synthesize_subagent_text_event(
    metadata: &RuntimeEventMetadata,
    parent_tool_use_id: &str,
    body_text: &str,
) -> RuntimeEvent {
    let session_id = metadata.session_id.clone().unwrap_or_default();
    let raw = json!({
        "type": "assistant",
        "session_id": session_id,
        "parent_tool_use_id": parent_tool_use_id,
        "message": {
            "model": Value::Null,
            "content": [{ "type": "text", "text": body_text }],
        },
    });
    let synthesised_metadata = RuntimeEventMetadata {
        session_id: metadata.session_id.clone(),
        usage: None,
        context_window: None,
        raw,
    };
    RuntimeEvent::new(
        synthesised_metadata,
        RuntimeEventKind::AssistantMessage {
            message: RuntimeAssistantMessage {
                model: None,
                content: vec![RuntimeContentBlock::Text {
                    text: body_text.to_string(),
                }],
            },
            parent_tool_use_id: Some(parent_tool_use_id.to_string()),
        },
    )
}

#[cfg(test)]
mod tests {
    use super::{extract_subagent_body, synthesize_subagent_text_event};
    use crate::domain::agents::adapter::{RuntimeContentBlock, RuntimeEventMetadata};
    use serde_json::json;

    fn metadata() -> RuntimeEventMetadata {
        RuntimeEventMetadata {
            session_id: Some("ses_parent".to_string()),
            raw: json!({}),
            ..RuntimeEventMetadata::default()
        }
    }

    #[test]
    fn extracts_body_from_raw_output_and_strips_full_wrapper() {
        // Legacy shape: task_id preamble + <task_result>.
        let body = json!({
            "rawOutput": {
                "output": "task_id: ses_child\n\n<task_result>\nReal body line 1\nReal body line 2\n</task_result>",
                "metadata": { "sessionId": "ses_child" }
            }
        });
        let extracted = extract_subagent_body(&body).expect("body");
        assert_eq!(extracted, "Real body line 1\nReal body line 2");
    }

    #[test]
    fn extracts_body_from_current_task_element_wrapper() {
        // Current OpenCode renderOutput shape (v1.18+):
        //   <task id="ses_…" state="completed">\n<task_result>\n…\n</task_result>\n</task>
        let body = json!({
            "rawOutput": {
                "output": "<task id=\"ses_child\" state=\"completed\">\n<task_result>\nCurrent body line 1\nCurrent body line 2\n</task_result>\n</task>",
                "metadata": { "sessionId": "ses_child" }
            }
        });
        let extracted = extract_subagent_body(&body).expect("body");
        assert_eq!(extracted, "Current body line 1\nCurrent body line 2");
    }

    #[test]
    fn falls_back_to_content_when_raw_output_absent() {
        // OpenCode's content envelope: {type:"content", content:{type:"text", text}}
        let body = json!({
            "content": [
                { "type": "content", "content": { "type": "text", "text": "task_id: ses_child\n\n<task_result>\nFallback body\n</task_result>" } }
            ]
        });
        let extracted = extract_subagent_body(&body).expect("body");
        assert_eq!(extracted, "Fallback body");
    }

    #[test]
    fn strips_body_without_task_id_prefix() {
        // Defensive: if a future build drops the `task_id:` preamble, the
        // `<task_result>` strip still fires.
        let body = json!({
            "rawOutput": { "output": "<task_result>\nNo preamble here\n</task_result>" }
        });
        let extracted = extract_subagent_body(&body).expect("body");
        assert_eq!(extracted, "No preamble here");
    }

    #[test]
    fn returns_unwrapped_text_when_markers_missing() {
        // Defensive: an unexpected wire shape with no wrappers should still
        // surface the text rather than dropping it on the floor.
        let body = json!({ "rawOutput": { "output": "Just plain output." } });
        let extracted = extract_subagent_body(&body).expect("body");
        assert_eq!(extracted, "Just plain output.");
    }

    #[test]
    fn returns_none_for_empty_body() {
        let body = json!({
            "rawOutput": { "output": "task_id: ses_child\n\n<task_result>\n   \n</task_result>" }
        });
        assert!(extract_subagent_body(&body).is_none());
    }

    #[test]
    fn returns_none_when_neither_raw_output_nor_text_content_present() {
        let body = json!({ "content": [{ "type": "diff", "path": "/x" }] });
        assert!(extract_subagent_body(&body).is_none());
    }

    #[test]
    fn synthesised_event_carries_text_and_parent_tool_use_id() {
        let event = synthesize_subagent_text_event(&metadata(), "call_parent", "Hello child");
        assert_eq!(event.parent_tool_use_id(), Some("call_parent"));
        let assistant = event.assistant_message().expect("assistant message");
        assert_eq!(assistant.content.len(), 1);
        let RuntimeContentBlock::Text { text } = &assistant.content[0] else {
            panic!("expected text block");
        };
        assert_eq!(text, "Hello child");
        // Raw envelope is shaped like an assistant message so the FE
        // `processAssistantMessage` path picks it up and applies parent
        // nesting from `parent_tool_use_id`.
        let raw = event.raw_json();
        assert_eq!(raw["type"], "assistant");
        assert_eq!(raw["parent_tool_use_id"], "call_parent");
        assert_eq!(raw["message"]["content"][0]["type"], "text");
        assert_eq!(raw["message"]["content"][0]["text"], "Hello child");
    }
}
