//! Routing signals for Codex multi-agent v2.
//!
//! The raw `spawn_agent` function call contains the Cadencr `Agent` block id
//! and task name, while the spawned thread id can be announced independently
//! on `thread/started`. Joining those shapes lets the adapter stamp every
//! child event with `parent_tool_use_id`. Authoritative `subAgentActivity`
//! items are handled separately by [`super::event_subagent_activity`].

mod ancestry;

pub(super) use ancestry::{lineage_error, subagent_spawn_source, thread_spawn_parent};
use serde_json::Value;

use super::event_json::runtime_stream_event;
use super::event_state::IndexState;
use super::event_subagents::agent_tool_block;
use crate::domain::agents::adapter::{RuntimeError, RuntimeEvent, RuntimeStreamEvent};

pub(super) fn register_thread_started_route(
    method: &str,
    params: &Value,
    index_state: &mut IndexState,
) -> Vec<RuntimeEvent> {
    // App-server writes notifications on one ordered stream: the model's raw
    // function_call is emitted before Codex executes it and can create this
    // thread, so the matching pending spawn already exists here.
    if method != "thread/started" {
        return Vec::new();
    }
    let route = match route_from_thread_started(params) {
        Ok(Some(route)) => route,
        Ok(None) => return Vec::new(),
        Err(error) => {
            return vec![lineage_error(
                params["thread"]["id"].as_str().unwrap_or(""),
                error,
            )]
        }
    };
    register_route(route, index_state)
}

fn register_route(route: SubagentRoute<'_>, index_state: &mut IndexState) -> Vec<RuntimeEvent> {
    if index_state.is_root_thread(route.child_thread_id)
        || route.child_thread_id == route.parent_thread_id
        || index_state.is_untracked_thread(route.parent_thread_id)
        || index_state
            .subagent_parent_tool_use_id(route.child_thread_id)
            .is_some()
    {
        return Vec::new();
    }
    if let Some(parent_tool_use_id) =
        index_state.take_pending_spawn_route(route.parent_thread_id, route.agent_path)
    {
        index_state.record_subagent_thread(route.child_thread_id, &parent_tool_use_id);
        return Vec::new();
    }
    // Rehydrated children have no pending spawn in this transport. Give them
    // a stable visible parent before their first turn/status or content event.
    let parent_tool_use_id = format!("codex-agent-{}", route.child_thread_id);
    index_state.record_subagent_thread(route.child_thread_id, &parent_tool_use_id);
    let item = serde_json::json!({ "agentPath": route.agent_path });
    let mut event = runtime_stream_event(
        route.parent_thread_id,
        RuntimeStreamEvent::ContentBlockStart {
            index: index_state.index_for(&parent_tool_use_id),
            block: agent_tool_block(&parent_tool_use_id, &item),
        },
    );
    event.set_parent_tool_use_id(
        index_state
            .subagent_parent_tool_use_id(route.parent_thread_id)
            .map(ToOwned::to_owned),
    );
    vec![event]
}

struct SubagentRoute<'a> {
    parent_thread_id: &'a str,
    child_thread_id: &'a str,
    agent_path: Option<&'a str>,
}

fn route_from_thread_started(params: &Value) -> Result<Option<SubagentRoute<'_>>, RuntimeError> {
    let thread = &params["thread"];
    let Some(child_thread_id) = thread["id"].as_str() else {
        return Ok(None);
    };
    let Some(parent_thread_id) = thread_spawn_parent(thread)? else {
        return Ok(None);
    };
    let agent_path =
        subagent_spawn_source(&thread["source"]).and_then(|spawn| spawn["agent_path"].as_str());
    Ok(Some(SubagentRoute {
        parent_thread_id,
        child_thread_id,
        agent_path,
    }))
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::super::event_state::IndexState;
    use super::super::events::notification_events;

    fn record_spawn(indexes: &mut IndexState, task_name: &str, call_id: &str) {
        notification_events(
            "rawResponseItem/completed",
            json!({
                "threadId": "thread_root",
                "item": {
                    "type": "function_call",
                    "call_id": call_id,
                    "name": "spawn_agent",
                    "arguments": serde_json::to_string(&json!({
                        "task_name": task_name,
                        "message": "review the diff"
                    })).unwrap()
                }
            }),
            None,
            indexes,
        );
    }

    #[test]
    fn thread_started_routes_streamed_child_events_to_spawn_block() {
        let mut indexes = IndexState::default();
        indexes.should_reset_for_turn_started("thread_root");
        record_spawn(&mut indexes, "quality_review", "call_quality");

        // Multi-agent v2's matching function output contains only the logical
        // task path, not `agentsStates` or a child thread id. The route must
        // stay pending until the independent `thread/started` notification.
        notification_events(
            "rawResponseItem/completed",
            json!({
                "threadId": "thread_root",
                "item": {
                    "type": "function_call_output",
                    "call_id": "call_quality",
                    "output": { "task_name": "/root/quality_review" }
                }
            }),
            None,
            &mut indexes,
        );

        notification_events(
            "thread/started",
            json!({
                "thread": {
                    "id": "thread_child",
                    "parentThreadId": "thread_root",
                    "source": {
                        "subAgent": {
                            "thread_spawn": {
                                "parent_thread_id": "thread_root",
                                "depth": 1,
                                "agent_path": "/root/quality_review"
                            }
                        }
                    }
                }
            }),
            None,
            &mut indexes,
        );

        let child = notification_events(
            "item/agentMessage/delta",
            json!({
                "threadId": "thread_child",
                "itemId": "child_message",
                "delta": "reviewing"
            }),
            None,
            &mut indexes,
        );
        assert_eq!(child[0].parent_tool_use_id(), Some("call_quality"));
    }

    #[test]
    fn concurrent_children_route_to_distinct_agent_blocks() {
        let mut indexes = IndexState::default();
        indexes.should_reset_for_turn_started("thread_root");
        record_spawn(&mut indexes, "reuse_review", "call_reuse");
        record_spawn(&mut indexes, "quality_review", "call_quality");

        for (task_name, thread_id) in [
            ("reuse_review", "thread_reuse"),
            ("quality_review", "thread_quality"),
        ] {
            notification_events(
                "thread/started",
                json!({
                    "thread": {
                        "id": thread_id,
                        "parentThreadId": "thread_root",
                        "source": {
                            "subAgent": {
                                "thread_spawn": {
                                    "parent_thread_id": "thread_root",
                                    "depth": 1,
                                    "agent_path": format!("/root/{task_name}")
                                }
                            }
                        }
                    }
                }),
                None,
                &mut indexes,
            );
        }

        assert_eq!(
            indexes.subagent_parent_tool_use_id("thread_reuse"),
            Some("call_reuse")
        );
        assert_eq!(
            indexes.subagent_parent_tool_use_id("thread_quality"),
            Some("call_quality")
        );
        // Only the child's own sub-agent fact, never a root result.
        assert!(notification_events(
            "turn/completed",
            json!({ "threadId": "thread_reuse" }),
            None,
            &mut indexes,
        )
        .iter()
        .all(crate::domain::agents::adapter::RuntimeEvent::is_subagent_signal_only));
    }

    #[test]
    fn subagent_activity_is_a_fallback_routing_signal() {
        let mut indexes = IndexState::default();
        indexes.should_reset_for_turn_started("thread_root");
        record_spawn(&mut indexes, "reuse_review", "call_reuse");

        let activity = notification_events(
            "item/started",
            json!({
                "threadId": "thread_root",
                "turnId": "root_turn",
                "item": {
                    "type": "subAgentActivity",
                    "id": "call_reuse",
                    "kind": "started",
                    "agentPath": "/root/reuse_review",
                    "agentThreadId": "thread_child"
                }
            }),
            None,
            &mut indexes,
        );

        assert!(
            activity
                .iter()
                .all(crate::domain::agents::adapter::RuntimeEvent::is_subagent_signal_only),
            "raw spawn already emitted the Agent block"
        );
        assert_eq!(
            indexes.subagent_parent_tool_use_id("thread_child"),
            Some("call_reuse")
        );
    }

    #[test]
    fn guardian_thread_does_not_consume_pending_v1_spawn_route() {
        let mut indexes = IndexState::default();
        indexes.should_reset_for_turn_started("thread_root");
        notification_events(
            "rawResponseItem/completed",
            json!({
                "threadId": "thread_root",
                "item": {
                    "type": "function_call",
                    "call_id": "call_v1",
                    "name": "spawn_agent",
                    "arguments": "{\"agent_type\":\"explorer\",\"message\":\"review\"}"
                }
            }),
            None,
            &mut indexes,
        );

        notification_events(
            "thread/started",
            json!({
                "thread": {
                    "id": "thread_guardian",
                    "parentThreadId": "thread_root",
                    "source": { "subAgent": { "other": "guardian" } }
                }
            }),
            None,
            &mut indexes,
        );
        assert_eq!(indexes.subagent_parent_tool_use_id("thread_guardian"), None);

        notification_events(
            "thread/started",
            json!({
                "thread": {
                    "id": "thread_v1_child",
                    "parentThreadId": "thread_root",
                    "source": {
                        "subAgent": {
                            "thread_spawn": {
                                "parent_thread_id": "thread_root",
                                "depth": 1,
                                "agent_path": null
                            }
                        }
                    }
                }
            }),
            None,
            &mut indexes,
        );
        assert_eq!(
            indexes.subagent_parent_tool_use_id("thread_v1_child"),
            Some("call_v1")
        );
    }
    #[test]
    fn resumed_child_is_routed_before_its_first_turn_without_raw_spawn() {
        let mut indexes = IndexState::for_root_thread("root");
        let params = json!({"thread":{"id":"child", "source":{"subAgent":{
            "thread_spawn":{"parent_thread_id":"root","agent_path":"/root/reviewer"}
        }}}});
        let events = notification_events("thread/started", params.clone(), None, &mut indexes);
        assert_eq!(events.len(), 2);
        assert_eq!(
            events[1].subagent_updates()[0].tool_use_id,
            "codex-agent-child"
        );
        assert_eq!(
            indexes.subagent_parent_tool_use_id("child"),
            Some("codex-agent-child")
        );
        assert!(!indexes.should_reset_for_turn_started("child"));
        assert!(notification_events("thread/started", params, None, &mut indexes).is_empty());
    }
    #[test]
    fn recovered_grandchild_block_and_content_keep_both_nesting_levels() {
        let mut indexes = IndexState::for_root_thread("root");
        indexes.record_subagent_thread("child", "spawn-child");
        let events = notification_events(
            "thread/started",
            json!({"thread":{
                "id":"grandchild", "source":{"subAgent":{"thread_spawn":{
                    "parent_thread_id":"child","agent_path":"/root/child/grandchild"
                }}}
            }}),
            None,
            &mut indexes,
        );
        assert_eq!(events[0].parent_tool_use_id(), Some("spawn-child"));
        assert_eq!(events[0].raw_json()["parent_tool_use_id"], "spawn-child");
        let content = notification_events(
            "item/agentMessage/delta",
            json!({
                "threadId":"grandchild", "itemId":"text", "delta":"working"
            }),
            None,
            &mut indexes,
        );
        assert!(content
            .iter()
            .all(|event| event.parent_tool_use_id() == Some("codex-agent-grandchild")));
    }
}
