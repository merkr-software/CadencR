use crate::domain::agents::adapter::RuntimeEvent;

/// If this notification's `threadId` belongs to a tracked sub-agent thread,
/// stamp every emitted event with the spawning `Agent` tool_use's id so the
/// frontend nests them under that block. Provider-neutral nesting (Claude's
/// `Task`, OpenCode's `Agent`) keys off the same `parent_tool_use_id` field.
pub(super) fn apply_subagent_parent_tool_use_id(
    events: &mut [RuntimeEvent],
    parent_tool_use_id: &str,
) {
    for event in events.iter_mut() {
        // Don't override an already-set parent (defends against nested
        // sub-agents already correctly tagged by inner handlers).
        if event.parent_tool_use_id().is_some() {
            continue;
        }
        event.set_parent_tool_use_id(Some(parent_tool_use_id.to_string()));
    }
}

#[cfg(test)]
mod tests {
    use super::super::super::event_state::IndexState;
    use super::super::notification_events;
    use crate::domain::agents::adapter::{RuntimeContentBlock, RuntimeStreamEvent};
    use serde_json::json;

    #[test]
    fn spawn_agent_raw_function_call_emits_agent_block_and_tracks_subagent_thread() {
        // Real wire shape Codex emits when `experimentalRawEvents` is on:
        // `spawn_agent` arrives as a `rawResponseItem/completed` with a
        // `function_call` raw_item, NOT as `collabAgentToolCall`. The spawned
        // threadId is only revealed in the matching `function_call_output`
        // under `output.agentsStates` (object whose keys are threadIds).
        let mut indexes = IndexState::default();
        let spawn_call = notification_events(
            "rawResponseItem/completed",
            json!({
                "threadId": "thread_root",
                "item": {
                    "type": "function_call",
                    "call_id": "call_spawn_1",
                    "name": "spawn_agent",
                    "arguments": "{\"agent_type\":\"default\",\"message\":\"do work\"}"
                }
            }),
            None,
            &mut indexes,
        );

        // `spawn_agent` must be normalized to provider-neutral `Agent` so the
        // frontend's existing sub-agent UI (childBlocks) handles it.
        let Some(RuntimeStreamEvent::ContentBlockStart { block, .. }) =
            spawn_call[0].stream_event()
        else {
            panic!("expected tool_use start, got {spawn_call:?}");
        };
        let RuntimeContentBlock::ToolUse { name, id, .. } = block else {
            panic!("expected tool_use block");
        };
        assert_eq!(name, "Agent");
        assert_eq!(id, "call_spawn_1");
        assert!(spawn_call[0].parent_tool_use_id().is_none());

        // Function_call_output for the spawn carries the spawned threadId
        // under `output.agentsStates` — we register the mapping here.
        let spawn_result = notification_events(
            "rawResponseItem/completed",
            json!({
                "threadId": "thread_root",
                "item": {
                    "type": "function_call_output",
                    "call_id": "call_spawn_1",
                    "output": {
                        "agentsStates": {
                            "thread_child": { "status": "pendingInit", "message": null }
                        },
                        "id": "call_spawn_1",
                        "status": "pendingInit"
                    }
                }
            }),
            None,
            &mut indexes,
        );
        // The tool_result itself is deliberately suppressed: its content is
        // just the bookkeeping `agentsStates` blob (`pendingInit`, etc.)
        // which would dump as a JSON string under the Agent block. The
        // sub-agent's actual output flows in later via wait_agent /
        // close_agent results. The side effect we DO care about — the
        // registered mapping — is still in place.
        assert!(spawn_result
            .iter()
            .all(|event| event.user_message().is_none()));

        // Now any event whose threadId is `thread_child` must be tagged
        // with `parent_tool_use_id = call_spawn_1`. This includes streamed
        // text from the sub-agent…
        let child_text = notification_events(
            "item/agentMessage/delta",
            json!({
                "threadId": "thread_child",
                "itemId": "msg_child",
                "delta": "Reviewing"
            }),
            None,
            &mut indexes,
        );
        assert_eq!(child_text.len(), 1);
        assert_eq!(child_text[0].parent_tool_use_id(), Some("call_spawn_1"));
        assert_eq!(
            child_text[0].raw_json()["parent_tool_use_id"],
            json!("call_spawn_1"),
        );

        // …and tool calls the sub-agent makes (e.g. another raw function_call).
        let child_read = notification_events(
            "rawResponseItem/completed",
            json!({
                "threadId": "thread_child",
                "item": {
                    "type": "function_call",
                    "call_id": "call_child_read",
                    "name": "read_file",
                    "arguments": "{\"file_path\":\"src/lib.rs\"}"
                }
            }),
            None,
            &mut indexes,
        );
        assert_eq!(child_read[0].parent_tool_use_id(), Some("call_spawn_1"));

        // Events on the root thread must NOT be re-parented — they belong
        // at the top level alongside the Agent block.
        let root_text = notification_events(
            "item/agentMessage/delta",
            json!({
                "threadId": "thread_root",
                "itemId": "msg_root",
                "delta": "still here"
            }),
            None,
            &mut indexes,
        );
        assert!(root_text[0].parent_tool_use_id().is_none());
    }

    #[test]
    fn subagent_turn_completed_does_not_emit_root_result() {
        let mut indexes = IndexState::default();
        notification_events(
            "rawResponseItem/completed",
            json!({
                "threadId": "thread_root",
                "item": {
                    "type": "function_call",
                    "call_id": "call_spawn_1",
                    "name": "spawn_agent",
                    "arguments": "{\"message\":\"do work\"}"
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
                    "call_id": "call_spawn_1",
                    "output": {
                        "agentsStates": {
                            "thread_child": { "status": "completed", "message": "done" }
                        }
                    }
                }
            }),
            None,
            &mut indexes,
        );

        let events = notification_events(
            "turn/completed",
            json!({ "threadId": "thread_child" }),
            None,
            &mut indexes,
        );

        // Only the child's own sub-agent fact, never a root result.
        assert!(events
            .iter()
            .all(crate::domain::agents::adapter::RuntimeEvent::is_subagent_signal_only));
    }

    #[test]
    fn non_spawn_collab_function_calls_keep_their_name_and_do_not_register_subagents() {
        // `wait_agent` is the second function_call Codex emits in the
        // sub-agent flow. It must NOT be normalized to `Agent` and must NOT
        // register a sub-agent mapping (the threadId already comes from the
        // earlier `spawn_agent` output).
        let mut indexes = IndexState::default();
        let events = notification_events(
            "rawResponseItem/completed",
            json!({
                "threadId": "thread_root",
                "item": {
                    "type": "function_call",
                    "call_id": "call_wait_1",
                    "name": "wait_agent",
                    "arguments": "{\"targets\":[\"thread_child\"],\"timeout_ms\":120000}"
                }
            }),
            None,
            &mut indexes,
        );

        let Some(RuntimeStreamEvent::ContentBlockStart { block, .. }) = events[0].stream_event()
        else {
            panic!("expected tool_use start");
        };
        let RuntimeContentBlock::ToolUse { name, .. } = block else {
            panic!("expected tool_use block");
        };
        assert_eq!(name, "wait_agent");

        // No mapping should have been registered — events on `thread_child`
        // should still be re-parented (because spawn_agent registers them),
        // but events on a *different* unrelated thread should not be.
        let stray = notification_events(
            "item/agentMessage/delta",
            json!({
                "threadId": "thread_unrelated",
                "itemId": "msg",
                "delta": "x"
            }),
            None,
            &mut indexes,
        );
        assert!(stray[0].parent_tool_use_id().is_none());
    }

    #[test]
    fn wait_agent_completion_synthesizes_subagent_text_under_parent_block() {
        // Codex flow: spawn_agent returns immediately with `pendingInit`,
        // wait_agent's tool_result carries the sub-agent's full message
        // string under `agentsStates[threadId].message`. The codex adapter
        // must synthesize a child Text block tagged with the spawning
        // tool_use_id, otherwise the Agent block stays empty in the UI.
        let mut indexes = IndexState::default();
        // 1. spawn_agent function_call → emits Agent block + records pending
        notification_events(
            "rawResponseItem/completed",
            json!({
                "threadId": "thread_root",
                "item": {
                    "type": "function_call",
                    "call_id": "call_spawn_1",
                    "name": "spawn_agent",
                    "arguments": "{}"
                }
            }),
            None,
            &mut indexes,
        );
        // 2. spawn_agent function_call_output → registers child thread.
        notification_events(
            "rawResponseItem/completed",
            json!({
                "threadId": "thread_root",
                "item": {
                    "type": "function_call_output",
                    "call_id": "call_spawn_1",
                    "output": {
                        "agentsStates": {
                            "thread_child_1": { "status": "pendingInit", "message": null }
                        }
                    }
                }
            }),
            None,
            &mut indexes,
        );

        // 3. wait_agent function_call_output with the sub-agent's final
        //    message string → must produce a synthesized assistant text
        //    event tagged with parent_tool_use_id = call_spawn_1.
        let wait_events = notification_events(
            "rawResponseItem/completed",
            json!({
                "threadId": "thread_root",
                "item": {
                    "type": "function_call_output",
                    "call_id": "call_wait_1",
                    "output": {
                        "agentsStates": {
                            "thread_child_1": {
                                "status": "completed",
                                "message": "## Review\n- LGTM"
                            }
                        }
                    }
                }
            }),
            None,
            &mut indexes,
        );

        // The first event is the wait_agent's tool_result; subsequent events
        // are the synthesized sub-agent text(s).
        let synthesized = wait_events
            .iter()
            .find(|event| {
                event
                    .assistant_message()
                    .map(|msg| {
                        msg.content.iter().any(|cb| {
                            matches!(cb, RuntimeContentBlock::Text { text } if text.contains("LGTM"))
                        })
                    })
                    .unwrap_or(false)
            })
            .expect("expected synthesized sub-agent text event");
        assert_eq!(synthesized.parent_tool_use_id(), Some("call_spawn_1"));
        // Raw envelope must also carry parent_tool_use_id so the FE nests.
        assert_eq!(
            synthesized.raw_json()["parent_tool_use_id"],
            json!("call_spawn_1"),
        );
    }

    #[test]
    fn spawn_agent_raw_path_emits_prompt_as_first_child_text_block() {
        // Without this synthesis, the Agent block would render with no
        // visible "first message" — the user wouldn't see what the
        // sub-agent was actually asked to do. Codex never streams the
        // prompt as a separate event: it's only inside the spawn item.
        let mut indexes = IndexState::default();
        let events = notification_events(
            "rawResponseItem/completed",
            json!({
                "threadId": "thread_root",
                "item": {
                    "type": "function_call",
                    "call_id": "call_spawn_p",
                    "name": "spawn_agent",
                    "arguments": "{\"prompt\":\"Review the diff for regressions\"}"
                }
            }),
            None,
            &mut indexes,
        );
        // First event is the Agent tool_use start; second is the prompt
        // surfaced as an assistant Text block under the Agent.
        assert_eq!(events.len(), 2);
        let prompt_event = &events[1];
        assert_eq!(prompt_event.parent_tool_use_id(), Some("call_spawn_p"));
        let RuntimeContentBlock::Text { text } =
            &prompt_event.assistant_message().expect("assistant").content[0]
        else {
            panic!("expected text block, got {prompt_event:?}");
        };
        assert_eq!(text, "Review the diff for regressions");
    }
}
