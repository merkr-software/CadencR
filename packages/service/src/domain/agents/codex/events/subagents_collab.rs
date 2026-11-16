//! Sub-agent nesting tests for the `collabAgentToolCall` wire path.
//!
//! These exercise the same provider-neutral re-parenting behavior as
//! [`super::subagents`], but for Codex's normalized `collabAgentToolCall`
//! notifications (as opposed to the raw OpenAI `function_call` path). The
//! tests live in their own module purely to keep each source file under the
//! repo's file-size limit; they cover the same logical unit.

#[cfg(test)]
mod tests {
    use super::super::super::event_state::IndexState;
    use super::super::notification_events;
    use crate::domain::agents::adapter::{RuntimeContentBlock, RuntimeStreamEvent};
    use serde_json::json;

    #[test]
    fn spawn_agent_collab_tool_emits_agent_block_and_tracks_subagent_thread() {
        let mut indexes = IndexState::default();
        let started = notification_events(
            "item/started",
            json!({
                "threadId": "thread_root",
                "item": {
                    "type": "collabAgentToolCall",
                    "id": "collab_1",
                    "tool": "spawn_agent",
                    "newThreadId": "thread_child",
                    "prompt": "Look at the auth module"
                }
            }),
            None,
            &mut indexes,
        );

        // Codex's `spawn_agent` is normalized to the provider-neutral `Agent`
        // tool name so the frontend's existing sub-agent UI nests events
        // under it without provider branches.
        let Some(RuntimeStreamEvent::ContentBlockStart { block, .. }) = started[0].stream_event()
        else {
            panic!("expected tool_use start, got {started:?}");
        };
        let RuntimeContentBlock::ToolUse { name, id, .. } = block else {
            panic!("expected tool_use block");
        };
        assert_eq!(name, "Agent");
        assert_eq!(id, "collab_1");
        // The root-thread emission itself must not carry parent_tool_use_id.
        assert!(started[0].parent_tool_use_id().is_none());

        // Now the sub-agent thread starts streaming an agent message — the
        // adapter should stamp it with `parent_tool_use_id = collab_1` so
        // the frontend nests it inside the Agent block.
        let child_text = notification_events(
            "item/agentMessage/delta",
            json!({
                "threadId": "thread_child",
                "itemId": "msg_child",
                "delta": "Looking at auth"
            }),
            None,
            &mut indexes,
        );
        assert_eq!(child_text.len(), 1);
        assert_eq!(child_text[0].parent_tool_use_id(), Some("collab_1"));
        assert_eq!(
            child_text[0].raw_json()["parent_tool_use_id"],
            json!("collab_1"),
        );

        // A child tool use (e.g. the sub-agent calls Read) must also be
        // nested under the parent Agent block.
        let child_tool = notification_events(
            "item/started",
            json!({
                "threadId": "thread_child",
                "item": { "type": "fileChange", "id": "patch_child", "changes": [] }
            }),
            None,
            &mut indexes,
        );
        assert_eq!(child_tool[0].parent_tool_use_id(), Some("collab_1"));

        // Events on the root thread must remain at root level.
        let root_text = notification_events(
            "item/agentMessage/delta",
            json!({
                "threadId": "thread_root",
                "itemId": "msg_root",
                "delta": "back to you"
            }),
            None,
            &mut indexes,
        );
        assert!(root_text[0].parent_tool_use_id().is_none());
    }

    #[test]
    fn non_spawn_collab_tools_do_not_register_a_subagent_thread() {
        // `send_input`, `resume_agent`, `wait`, `close_agent` are messages to
        // an existing sub-agent — they must NOT introduce a new nesting root
        // and they must keep their own tool name (no normalization to Agent).
        let mut indexes = IndexState::default();
        let started = notification_events(
            "item/started",
            json!({
                "threadId": "thread_root",
                "item": {
                    "type": "collabAgentToolCall",
                    "id": "collab_send_1",
                    "tool": "send_input",
                    "receiverThreadId": "thread_child",
                    "prompt": "more details please"
                }
            }),
            None,
            &mut indexes,
        );

        let Some(RuntimeStreamEvent::ContentBlockStart { block, .. }) = started[0].stream_event()
        else {
            panic!("expected tool_use start");
        };
        let RuntimeContentBlock::ToolUse { name, .. } = block else {
            panic!("expected tool_use block");
        };
        assert_eq!(name, "send_input");

        // No subagent thread should have been registered for `thread_child`
        // by a non-spawn collab op.
        let child_text = notification_events(
            "item/agentMessage/delta",
            json!({
                "threadId": "thread_child",
                "itemId": "msg",
                "delta": "anything"
            }),
            None,
            &mut indexes,
        );
        assert_eq!(child_text.len(), 1);
        assert!(child_text[0].parent_tool_use_id().is_none());
    }

    #[test]
    fn collab_spawn_agent_camelcase_normalizes_and_registers_subagent_threads() {
        // Real wire shape from Codex: the collab item uses camelCase
        // `tool: "spawnAgent"` and lists spawned threads under
        // `receiverThreadIds` and `agentsStates`. (Snake-case `spawn_agent`
        // appears on the raw OpenAI function_call; camelCase appears on the
        // normalized collabAgentToolCall.) Both must collapse to `Agent` and
        // both threadId-bearing fields must register sub-agent mappings.
        let mut indexes = IndexState::default();
        let started = notification_events(
            "item/started",
            json!({
                "threadId": "thread_root",
                "item": {
                    "type": "collabAgentToolCall",
                    "id": "call_collab_1",
                    "tool": "spawnAgent",
                    "receiverThreadIds": ["thread_child_1"],
                    "agentsStates": {
                        "thread_child_1": { "status": "pendingInit", "message": null }
                    }
                }
            }),
            None,
            &mut indexes,
        );
        let Some(RuntimeStreamEvent::ContentBlockStart { block, .. }) = started[0].stream_event()
        else {
            panic!("expected tool_use start");
        };
        let RuntimeContentBlock::ToolUse { name, .. } = block else {
            panic!("expected tool_use block");
        };
        assert_eq!(name, "Agent");

        // Sanity: an event on the receiver thread now gets parent stamped.
        let child = notification_events(
            "item/agentMessage/delta",
            json!({
                "threadId": "thread_child_1",
                "itemId": "msg",
                "delta": "hi"
            }),
            None,
            &mut indexes,
        );
        assert_eq!(child[0].parent_tool_use_id(), Some("call_collab_1"));
    }

    #[test]
    fn spawn_agent_collab_path_uses_clean_input_and_skips_tool_result_dump() {
        // Repro of the bug where the Agent block's first child was the
        // entire collab item JSON. The fix surfaces only `description` +
        // `prompt` as the tool_use input, suppresses the tool_result, and
        // synthesizes the prompt as a Text child block.
        let mut indexes = IndexState::default();
        let prompt_text = "You are reviewing commit 218f10a.\nLook at packages/desktop changes.";
        let events = notification_events(
            "item/completed",
            json!({
                "threadId": "thread_root",
                "item": {
                    "type": "collabAgentToolCall",
                    "id": "call_collab_spawn",
                    "tool": "spawnAgent",
                    "model": "gpt-5.4",
                    "agentsStates": {
                        "thread_child_a": { "status": "pendingInit", "message": null }
                    },
                    "receiverThreadIds": ["thread_child_a"],
                    "status": "completed",
                    "prompt": prompt_text
                }
            }),
            None,
            &mut indexes,
        );

        // No tool_result is emitted for the spawn — the bookkeeping JSON
        // would have rendered as a literal dump inside the Agent block.
        assert!(
            events.iter().all(|event| event.user_message().is_none()),
            "spawn_agent collab item must not emit a tool_result: {events:?}",
        );

        let Some(RuntimeStreamEvent::ContentBlockStart { block, .. }) = events[0].stream_event()
        else {
            panic!("expected tool_use start, got {events:?}");
        };
        let RuntimeContentBlock::ToolUse { name, input, .. } = block else {
            panic!("expected tool_use block");
        };
        assert_eq!(name, "Agent");
        // Only the cleaned shape — no agentsStates / receiverThreadIds.
        assert_eq!(
            input["description"].as_str().expect("description"),
            "You are reviewing commit 218f10a."
        );
        assert_eq!(input["prompt"].as_str(), Some(prompt_text));
        assert!(input.get("agentsStates").is_none());
        assert!(input.get("receiverThreadIds").is_none());

        // The prompt is rendered as a child Text block via parent_tool_use_id.
        let prompt_child = events
            .iter()
            .find(|event| {
                event.parent_tool_use_id() == Some("call_collab_spawn")
                    && event.assistant_message().is_some()
            })
            .expect("expected prompt child block");
        let RuntimeContentBlock::Text { text } =
            &prompt_child.assistant_message().expect("assistant").content[0]
        else {
            panic!("expected text content block");
        };
        assert_eq!(text, prompt_text);
    }

    #[test]
    fn spawn_agent_dual_path_emits_prompt_only_once() {
        // Codex emits the same spawn through both the raw function_call and
        // the collabAgentToolCall paths. The prompt synthesis is keyed by
        // the tool_use id (= call_id) to dedupe across paths — otherwise
        // the user would see the prompt twice inside the Agent block.
        let mut indexes = IndexState::default();
        notification_events(
            "rawResponseItem/completed",
            json!({
                "threadId": "thread_root",
                "item": {
                    "type": "function_call",
                    "call_id": "call_spawn_dup",
                    "name": "spawn_agent",
                    "arguments": "{\"prompt\":\"Do the work\"}"
                }
            }),
            None,
            &mut indexes,
        );
        let collab = notification_events(
            "item/completed",
            json!({
                "threadId": "thread_root",
                "item": {
                    "type": "collabAgentToolCall",
                    "id": "call_spawn_dup",
                    "tool": "spawnAgent",
                    "prompt": "Do the work",
                    "agentsStates": {
                        "thread_child_b": { "status": "pendingInit" }
                    }
                }
            }),
            None,
            &mut indexes,
        );

        // The second-arriving path must not re-emit the prompt block.
        let prompt_blocks: Vec<_> = collab
            .iter()
            .filter(|event| {
                event
                    .assistant_message()
                    .map(|msg| {
                        msg.content.iter().any(|cb| {
                            matches!(cb, RuntimeContentBlock::Text { text } if text == "Do the work")
                        })
                    })
                    .unwrap_or(false)
            })
            .collect();
        assert!(
            prompt_blocks.is_empty(),
            "prompt was re-emitted on the collab path: {collab:?}",
        );
        // And the late path still must not surface a tool_result JSON dump.
        assert!(collab.iter().all(|event| event.user_message().is_none()));
    }

    #[test]
    fn collab_completion_after_raw_function_call_does_not_emit_duplicate_agent_start() {
        // Reproduces the duplicate-Agent-block bug seen in the live DB
        // (rows 1668158 + 1668160 both being `tool_call` for the same
        // call_xH9 id). With the index intact across the two spawns, the
        // collab.item/completed for the second call must dedupe via
        // `has_index` and only emit a tool_result.
        let mut indexes = IndexState::default();
        for (cid, child) in [
            ("call_spawn_1", "thread_child_1"),
            ("call_spawn_2", "thread_child_2"),
        ] {
            notification_events(
                "rawResponseItem/completed",
                json!({
                    "threadId": "thread_root",
                    "item": {
                        "type": "function_call",
                        "call_id": cid,
                        "name": "spawn_agent",
                        "arguments": "{}"
                    }
                }),
                None,
                &mut indexes,
            );
            notification_events(
                "rawResponseItem/completed",
                json!({
                    "threadId": "thread_root",
                    "item": {
                        "type": "function_call_output",
                        "call_id": cid,
                        "output": {
                            "agentsStates": { child: { "status": "pendingInit" } }
                        }
                    }
                }),
                None,
                &mut indexes,
            );
        }

        // The second spawn's collab.item/completed must NOT emit a duplicate
        // Agent start — its index from the function_call should still be
        // present in `IndexState`.
        let collab = notification_events(
            "item/completed",
            json!({
                "threadId": "thread_root",
                "item": {
                    "type": "collabAgentToolCall",
                    "id": "call_spawn_2",
                    "tool": "spawnAgent",
                    "agentsStates": {
                        "thread_child_2": { "status": "pendingInit" }
                    }
                }
            }),
            None,
            &mut indexes,
        );

        let starts: Vec<_> = collab
            .iter()
            .filter(|event| {
                matches!(
                    event.stream_event(),
                    Some(RuntimeStreamEvent::ContentBlockStart { .. })
                )
            })
            .collect();
        assert!(
            starts.is_empty(),
            "duplicate Agent block emitted: {collab:?}",
        );
    }

    #[test]
    fn failed_collab_call_result_is_an_error() {
        // v2/ThreadItem.ts `collabAgentToolCall`: no `error` field, only a
        // `CollabAgentToolCallStatus`.
        let mut indexes = IndexState::for_root_thread("thread_root");
        let result = |status: &str, indexes: &mut IndexState| {
            let events = notification_events(
                "item/completed",
                json!({
                    "threadId": "thread_root",
                    "item": {
                        "type": "collabAgentToolCall", "id": format!("call_send_{status}"),
                        "tool": "sendInput", "status": status, "senderThreadId": "thread_root",
                        "receiverThreadIds": ["thread_gone"], "prompt": "continue",
                        "model": null, "reasoningEffort": null, "agentsStates": {}
                    }
                }),
                None,
                indexes,
            );
            events.iter().find_map(|event| {
                let message = event.user_message()?;
                match &message.content[0] {
                    crate::domain::agents::adapter::RuntimeUserContentBlock::ToolResult {
                        is_error,
                        ..
                    } => Some(*is_error),
                    _ => None,
                }
            })
        };
        assert_eq!(result("failed", &mut indexes), Some(true));
        assert_eq!(result("completed", &mut indexes), Some(false));
    }
}
