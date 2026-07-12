//! Codex-specific helpers for surfacing sub-agent output.
//!
//! Current Codex app-server versions stream sub-agent events live on child
//! thread ids; [`super::event_subagent_routes`] maps those threads back to the
//! spawning `Agent` block. Older versions delivered only a final output string
//! in `wait_agent` / `close_agent` tool results, under
//! `output.agentsStates[<threadId>].message`, so this module also preserves the
//! legacy synthesis fallback.
//!
//! To match the provider-neutral UI contract (an `Agent` block with
//! `childBlocks` populated) the codex adapter synthesizes a single Text
//! `RuntimeContentBlock` per sub-agent message and tags it with the
//! spawning call's `parent_tool_use_id`. Frontend nesting picks it up the
//! same way it does for Claude/OpenCode.

use serde_json::Value;

use super::event_json::{metadata, thread_id};
use super::event_state::IndexState;
use crate::domain::agents::adapter::{
    RuntimeAssistantMessage, RuntimeContentBlock, RuntimeEvent, RuntimeEventKind,
};

/// Build a clean tool_use input for the `Agent` (sub-agent) block.
///
/// The raw collab item carries thread-bookkeeping fields (agentsStates,
/// receiverThreadIds, status, model, etc.) that the sub-agent UI doesn't
/// render and that, if echoed back as a tool_result, would surface as a
/// JSON dump inside the Agent block. We surface only what the frontend's
/// `TaskAgentBlock` actually reads (`description`) plus the `prompt` for
/// downstream consumers (the synthesized prompt child block).
pub(super) fn agent_tool_input(item: &Value) -> Value {
    let prompt = subagent_prompt(item).unwrap_or_default();
    serde_json::json!({
        "description": agent_description(item, &prompt),
        "prompt": prompt,
    })
}

pub(super) fn agent_tool_block(id: &str, item: &Value) -> RuntimeContentBlock {
    RuntimeContentBlock::ToolUse {
        id: id.to_string(),
        name: "Agent".to_string(),
        input: agent_tool_input(item),
    }
}

/// Extract the spawn prompt from either the collab item shape (top-level
/// `prompt` string) or the raw OpenAI function_call shape (JSON-encoded
/// `arguments` whose object contains `prompt`).
pub(super) fn subagent_prompt(item: &Value) -> Option<String> {
    if let Some(prompt) = item.get("prompt").and_then(Value::as_str) {
        return Some(prompt.to_string());
    }
    let raw_args = item.get("arguments").and_then(Value::as_str)?;
    let parsed: Value = serde_json::from_str(raw_args).ok()?;
    parsed
        .get("prompt")
        .and_then(Value::as_str)
        .map(ToOwned::to_owned)
}

fn agent_description(item: &Value, prompt: &str) -> String {
    if let Some(line) = prompt.lines().map(str::trim).find(|line| !line.is_empty()) {
        return truncate_label(line);
    }
    if let Some(agent_path) = item
        .get("agentPath")
        .and_then(Value::as_str)
        .and_then(|path| path.rsplit('/').find(|segment| !segment.is_empty()))
    {
        return agent_path.to_string();
    }
    item.get("model")
        .and_then(Value::as_str)
        .filter(|model| !model.is_empty())
        .map(ToOwned::to_owned)
        .unwrap_or_else(|| "Sub-agent".to_string())
}

fn truncate_label(line: &str) -> String {
    const MAX_LEN: usize = 80;
    if line.chars().count() <= MAX_LEN {
        return line.to_string();
    }
    let mut out: String = line.chars().take(MAX_LEN).collect();
    out.push('…');
    out
}

/// If `item` carries a sub-agent prompt and we haven't already injected it
/// for this Agent block, build a synthetic assistant Text block that the
/// frontend will nest under the parent block via `parent_tool_use_id`.
///
/// Codex never streams the prompt as its own event — it's only baked into
/// the spawn item. Without this, the user would see an Agent block whose
/// first content is whatever the sub-agent eventually replies with, with
/// no record of what was actually asked.
pub(super) fn synthesize_subagent_prompt(
    session_id: &str,
    parent_tool_use_id: &str,
    item: &Value,
    index_state: &mut IndexState,
) -> Option<RuntimeEvent> {
    let prompt = subagent_prompt(item)?;
    if prompt.trim().is_empty() {
        return None;
    }
    if !index_state.record_subagent_prompt_injected(parent_tool_use_id) {
        return None;
    }
    Some(synthetic_text_event(
        session_id,
        parent_tool_use_id,
        &prompt,
    ))
}

/// If `payload` carries `agentsStates` with a non-empty `message` for any
/// known sub-agent thread, build one assistant Text block per such thread
/// tagged with the spawning tool_use's id. Idempotent per-thread: a second
/// `wait_agent` poll won't re-emit the same message.
pub(super) fn synthesize_subagent_messages(
    params: &Value,
    payload: &Value,
    index_state: &mut IndexState,
) -> Vec<RuntimeEvent> {
    let Some(states) = payload.get("agentsStates").and_then(Value::as_object) else {
        return Vec::new();
    };
    let session_id = thread_id(params).to_string();
    let mut events = Vec::new();
    for (subagent_thread_id, state) in states {
        let Some(message) = state.get("message").and_then(Value::as_str) else {
            continue;
        };
        if message.trim().is_empty() {
            continue;
        }
        let Some(parent_tool_use_id) = index_state
            .subagent_parent_tool_use_id(subagent_thread_id)
            .map(ToOwned::to_owned)
        else {
            continue;
        };
        if !index_state.record_subagent_message_injected(subagent_thread_id) {
            continue;
        }
        events.push(synthetic_text_event(
            &session_id,
            &parent_tool_use_id,
            message,
        ));
    }
    events
}

fn synthetic_text_event(session_id: &str, parent_tool_use_id: &str, message: &str) -> RuntimeEvent {
    // Shape the raw envelope like a normal assistant text message so the
    // frontend's existing `processAssistantMessage` path nests it under
    // the parent block via `parent_tool_use_id`.
    let raw = serde_json::json!({
        "type": "assistant",
        "session_id": session_id,
        "parent_tool_use_id": parent_tool_use_id,
        "message": {
            "model": null,
            "content": [{ "type": "text", "text": message }],
        },
    });
    RuntimeEvent::new(
        metadata(session_id, raw),
        RuntimeEventKind::AssistantMessage {
            message: RuntimeAssistantMessage {
                model: None,
                content: vec![RuntimeContentBlock::Text {
                    text: message.to_string(),
                }],
            },
            parent_tool_use_id: Some(parent_tool_use_id.to_string()),
        },
    )
}

#[cfg(test)]
mod tests {
    use super::{
        agent_tool_input, subagent_prompt, synthesize_subagent_messages, synthesize_subagent_prompt,
    };
    use crate::domain::agents::adapter::RuntimeContentBlock;
    use crate::domain::agents::codex::event_state::IndexState;
    use serde_json::json;

    fn params() -> serde_json::Value {
        json!({ "threadId": "thread_root" })
    }

    #[test]
    fn injects_one_text_block_per_subagent_with_message() {
        let mut indexes = IndexState::default();
        indexes.record_subagent_thread("thread_a", "call_spawn_a");
        indexes.record_subagent_thread("thread_b", "call_spawn_b");

        let payload = json!({
            "agentsStates": {
                "thread_a": { "status": "completed", "message": "Review A: LGTM" },
                "thread_b": { "status": "completed", "message": "Review B: NACK" },
            }
        });
        let events = synthesize_subagent_messages(&params(), &payload, &mut indexes);
        assert_eq!(events.len(), 2);

        // The output order is non-deterministic (HashMap-backed), so look up
        // each event by its parent_tool_use_id rather than by index.
        for event in &events {
            let parent = event.parent_tool_use_id().expect("parent_tool_use_id");
            let msg = event.assistant_message().expect("assistant message");
            assert_eq!(msg.content.len(), 1);
            let RuntimeContentBlock::Text { text } = &msg.content[0] else {
                panic!("expected text block");
            };
            match parent {
                "call_spawn_a" => assert_eq!(text, "Review A: LGTM"),
                "call_spawn_b" => assert_eq!(text, "Review B: NACK"),
                other => panic!("unexpected parent {other}"),
            }
        }
    }

    #[test]
    fn skips_threads_without_a_recorded_parent() {
        // `wait_agent` can echo `agentsStates` for threads we never tracked
        // (defensive — should not invent a parentless block).
        let mut indexes = IndexState::default();
        let payload = json!({
            "agentsStates": {
                "unknown_thread": { "message": "stranger danger" }
            }
        });
        assert!(synthesize_subagent_messages(&params(), &payload, &mut indexes).is_empty());
    }

    #[test]
    fn skips_empty_or_null_messages() {
        let mut indexes = IndexState::default();
        indexes.record_subagent_thread("thread_a", "call_spawn_a");
        let payload = json!({
            "agentsStates": {
                "thread_a": { "status": "pendingInit", "message": null }
            }
        });
        assert!(synthesize_subagent_messages(&params(), &payload, &mut indexes).is_empty());

        let payload = json!({
            "agentsStates": {
                "thread_a": { "status": "running", "message": "   " }
            }
        });
        assert!(synthesize_subagent_messages(&params(), &payload, &mut indexes).is_empty());
    }

    #[test]
    fn agent_tool_input_strips_bookkeeping_and_surfaces_description_plus_prompt() {
        // The collab item carries fields like agentsStates / receiverThreadIds /
        // status / model that the frontend's Agent block neither reads nor
        // renders cleanly. Only `description` (header label) and `prompt`
        // (used by `synthesize_subagent_prompt` to build the first child
        // block) should survive — anything else would just be JSON noise.
        let input = agent_tool_input(&json!({
            "type": "collabAgentToolCall",
            "tool": "spawnAgent",
            "id": "call_1",
            "model": "gpt-5.4",
            "agentsStates": { "thread_x": { "status": "pendingInit" } },
            "receiverThreadIds": ["thread_x"],
            "prompt": "Review commit 218f10a.\nLook at packages/desktop changes."
        }));
        assert_eq!(input["description"], "Review commit 218f10a.");
        assert_eq!(
            input["prompt"],
            "Review commit 218f10a.\nLook at packages/desktop changes."
        );
        assert!(input.get("agentsStates").is_none());
        assert!(input.get("receiverThreadIds").is_none());
        assert!(input.get("status").is_none());
    }

    #[test]
    fn agent_tool_input_truncates_long_first_line_for_description() {
        let long_line = "x".repeat(200);
        let input = agent_tool_input(&json!({ "prompt": long_line }));
        let description = input["description"].as_str().expect("description");
        assert!(description.ends_with('…'));
        assert!(description.chars().count() <= 81);
    }

    #[test]
    fn agent_tool_input_falls_back_to_model_or_subagent_label() {
        let input = agent_tool_input(&json!({ "agentPath": "/root/quality_review" }));
        assert_eq!(input["description"], "quality_review");
        let input = agent_tool_input(&json!({ "prompt": "   ", "model": "gpt-5.4" }));
        assert_eq!(input["description"], "gpt-5.4");
        let input = agent_tool_input(&json!({}));
        assert_eq!(input["description"], "Sub-agent");
    }

    #[test]
    fn subagent_prompt_handles_collab_and_raw_function_call_shapes() {
        // Collab item: prompt is a top-level string.
        assert_eq!(
            subagent_prompt(&json!({ "prompt": "Do the work" })).as_deref(),
            Some("Do the work"),
        );
        // Raw function_call: prompt is JSON-encoded inside `arguments`.
        assert_eq!(
            subagent_prompt(&json!({
                "name": "spawn_agent",
                "arguments": "{\"prompt\":\"Do the raw work\"}"
            }))
            .as_deref(),
            Some("Do the raw work"),
        );
        // Neither shape carries a prompt → None.
        assert!(subagent_prompt(&json!({ "name": "spawn_agent" })).is_none());
    }

    #[test]
    fn synthesize_subagent_prompt_emits_text_block_under_parent_once() {
        let mut indexes = IndexState::default();
        let item = json!({
            "type": "collabAgentToolCall",
            "tool": "spawnAgent",
            "prompt": "Review the diff for regressions"
        });
        let event = synthesize_subagent_prompt("thread_root", "call_spawn_x", &item, &mut indexes)
            .expect("expected a synthetic prompt event");
        assert_eq!(event.parent_tool_use_id(), Some("call_spawn_x"));
        let msg = event.assistant_message().expect("assistant message");
        let RuntimeContentBlock::Text { text } = &msg.content[0] else {
            panic!("expected text block");
        };
        assert_eq!(text, "Review the diff for regressions");

        // A second call for the same parent (e.g. the duplicate raw/collab
        // path) must NOT re-inject the prompt — that would double the chip
        // inside the Agent block.
        assert!(
            synthesize_subagent_prompt("thread_root", "call_spawn_x", &item, &mut indexes,)
                .is_none()
        );
    }

    #[test]
    fn synthesize_subagent_prompt_skips_blank_or_missing_prompts() {
        let mut indexes = IndexState::default();
        // No prompt on the item.
        assert!(synthesize_subagent_prompt(
            "thread_root",
            "call_spawn_x",
            &json!({ "tool": "spawnAgent" }),
            &mut indexes,
        )
        .is_none());
        // Whitespace-only prompt (defensive — a UI block with only spaces
        // is worse than no block at all).
        assert!(synthesize_subagent_prompt(
            "thread_root",
            "call_spawn_x",
            &json!({ "prompt": "   \n   " }),
            &mut indexes,
        )
        .is_none());
    }

    #[test]
    fn does_not_inject_the_same_message_twice() {
        // Polling wait_agent can repeat the response. We must inject only
        // once so the Agent block doesn't grow with duplicate child blocks.
        let mut indexes = IndexState::default();
        indexes.record_subagent_thread("thread_a", "call_spawn_a");
        let payload = json!({
            "agentsStates": {
                "thread_a": { "status": "completed", "message": "final" }
            }
        });
        assert_eq!(
            synthesize_subagent_messages(&params(), &payload, &mut indexes).len(),
            1,
        );
        assert_eq!(
            synthesize_subagent_messages(&params(), &payload, &mut indexes).len(),
            0,
        );
    }
}
