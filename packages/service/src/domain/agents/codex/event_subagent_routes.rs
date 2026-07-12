//! Routing signals for Codex multi-agent v2.
//!
//! The raw `spawn_agent` function call contains the Cadencr `Agent` block id
//! and task name, while the spawned thread id can be announced independently
//! on `thread/started`. Joining those shapes lets the adapter stamp every
//! child event with `parent_tool_use_id`. Authoritative `subAgentActivity`
//! items are handled separately by [`super::event_subagent_activity`].

use serde_json::Value;

use super::event_state::IndexState;

pub(super) fn register_thread_started_route(
    method: &str,
    params: &Value,
    index_state: &mut IndexState,
) {
    // App-server writes notifications on one ordered stream: the model's raw
    // function_call is emitted before Codex executes it and can create this
    // thread, so the matching pending spawn already exists here.
    let route = (method == "thread/started")
        .then(|| route_from_thread_started(params))
        .flatten();
    let Some(route) = route else {
        return;
    };
    register_route(route, index_state);
}

fn register_route(route: SubagentRoute<'_>, index_state: &mut IndexState) {
    if index_state
        .subagent_parent_tool_use_id(route.child_thread_id)
        .is_some()
    {
        return;
    }
    let Some(parent_tool_use_id) =
        index_state.take_pending_spawn_route(route.parent_thread_id, route.agent_path)
    else {
        return;
    };
    index_state.record_subagent_thread(route.child_thread_id, &parent_tool_use_id);
}

struct SubagentRoute<'a> {
    parent_thread_id: &'a str,
    child_thread_id: &'a str,
    agent_path: Option<&'a str>,
}

fn route_from_thread_started(params: &Value) -> Option<SubagentRoute<'_>> {
    let thread = params.get("thread")?;
    let child_thread_id = thread.get("id").and_then(Value::as_str)?;
    // Exclude guardian/review/compaction subagents. They also carry a
    // `parentThreadId`, but there is no visible spawn `Agent` block to attach
    // them to. Only an explicit `thread_spawn` source is routable here.
    let spawn_source = subagent_spawn_source(thread.get("source")?)?;
    let parent_thread_id = thread
        .get("parentThreadId")
        .and_then(Value::as_str)
        .or_else(|| spawn_source.get("parent_thread_id").and_then(Value::as_str))?;
    let agent_path = spawn_source.get("agent_path").and_then(Value::as_str);
    Some(SubagentRoute {
        parent_thread_id,
        child_thread_id,
        agent_path,
    })
}

fn subagent_spawn_source(source: &Value) -> Option<&Value> {
    let subagent = source.get("subAgent").or_else(|| source.get("subagent"))?;
    subagent
        .get("thread_spawn")
        .or_else(|| subagent.get("threadSpawn"))
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
        assert!(notification_events(
            "turn/completed",
            json!({ "threadId": "thread_reuse" }),
            None,
            &mut indexes,
        )
        .is_empty());
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
            activity.is_empty(),
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
}
