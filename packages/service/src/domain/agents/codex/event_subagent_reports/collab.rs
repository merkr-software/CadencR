//! A parent's view of its children: `subAgentActivity` items, collab tool
//! calls and the `agentsStates` snapshots their results carry.
//!
//! Shapes from `codex app-server generate-ts` (codex-cli 0.165.0):
//! `v2/ThreadItem.ts` (`collabAgentToolCall`, `subAgentActivity`),
//! `v2/CollabAgentState.ts`, `v2/CollabAgentStatus.ts`,
//! `v2/CollabAgentToolCallStatus.ts`, `v2/SubAgentActivityKind.ts`.
use serde_json::Value;

use super::child::{ChildChange, End, Strength};
use super::Fact;
use crate::domain::agents::adapter::{
    non_empty_str as text, stop_reason, summarize_subagent_result, RuntimeSubagentPatch,
    RuntimeSubagentStatus,
};
use crate::domain::agents::codex::event_subagents::{prompt_label, readable_prompt};

const SPAWN_FAILED: &str = "Codex could not start the sub-agent";

pub(super) fn activity(item: &Value) -> Vec<Fact> {
    let Some(thread) = text(&item["agentThreadId"]) else {
        return Vec::new();
    };
    let child = |change| Fact::Child {
        thread: thread.clone(),
        change,
    };
    match item["kind"].as_str() {
        // Codex resolves the child's model when it creates it.
        Some("started") => {
            let model = text(&item["model"]);
            let config = RuntimeSubagentPatch {
                model_resolved: model.is_some(),
                model,
                reasoning_effort: text(&item["reasoningEffort"]),
                ..RuntimeSubagentPatch::default()
            };
            vec![
                child(ChildChange::Spawned),
                child(ChildChange::Config(config)),
            ]
        }
        Some("completed") => vec![child(ChildChange::Settled(End::completed(
            Strength::Reported,
        )))],
        Some("interrupted") => vec![child(ChildChange::Settled(End::stopped(
            stop_reason::INTERRUPTED,
            Strength::Reported,
        )))],
        // `interacted` is messaging, not lifecycle.
        _ => Vec::new(),
    }
}

pub(super) fn tool_call(item: &Value, completed: bool) -> Vec<Fact> {
    match item["tool"].as_str() {
        // Mirrors `collab_tool_name`: a call without a tool is a spawn.
        None | Some("spawnAgent" | "spawn_agent") => spawn(item, completed).into_iter().collect(),
        // A finished wait/close/send reports where its targets stand.
        Some(_) if completed => agents_states(&item["agentsStates"]),
        Some(_) => Vec::new(),
    }
}

/// What a spawn call asked for, and whether it failed to start a child.
fn spawn(item: &Value, completed: bool) -> Option<Fact> {
    let call_id = text(&item["id"])?;
    let prompt = text(&item["prompt"]).filter(|prompt| readable_prompt(prompt));
    let mut patch = RuntimeSubagentPatch {
        description: prompt.as_deref().and_then(prompt_label),
        prompt,
        model: text(&item["model"]),
        reasoning_effort: text(&item["reasoningEffort"]),
        child_session_id: text(&item["newThreadId"]).or_else(|| {
            item["receiverThreadIds"]
                .as_array()
                .and_then(|ids| ids.iter().find_map(text))
        }),
        ..RuntimeSubagentPatch::default()
    };
    match item["status"].as_str() {
        Some("failed") if completed => {
            let error = first_state_message(&item["agentsStates"]);
            let error = summarize_subagent_result(error.as_deref().unwrap_or(SPAWN_FAILED));
            patch.status = Some(RuntimeSubagentStatus::Failed);
            patch.status_reason = error.clone();
            patch.result_summary = error;
        }
        Some("interrupted") if completed => {
            patch.status = Some(RuntimeSubagentStatus::Stopped);
            patch.status_reason = Some(stop_reason::INTERRUPTED.to_string());
        }
        _ => {}
    }
    Some(Fact::Spawn { call_id, patch })
}

/// Raw `function_call_output`s of collab tools: legacy `agentsStates`
/// snapshots, and v1 `spawn_agent`'s `{agent_id, nickname}`.
pub(super) fn raw_output(item: &Value) -> Vec<Fact> {
    if item["type"] != "function_call_output" {
        return Vec::new();
    }
    let output = &item["output"];
    let decoded;
    let output = match output.as_str() {
        // Raw outputs are free text; only JSON naming a child is a fact.
        Some(raw) if raw.contains("agentsStates") || raw.contains("agent_id") => {
            decoded = serde_json::from_str::<Value>(raw).ok();
            match &decoded {
                Some(value) => value,
                None => return Vec::new(),
            }
        }
        Some(_) => return Vec::new(),
        None => output,
    };
    let mut facts = agents_states(&output["agentsStates"]);
    if let Some(thread) = text(&output["agent_id"]) {
        let config = RuntimeSubagentPatch {
            agent_name: text(&output["nickname"]),
            ..RuntimeSubagentPatch::default()
        };
        facts.push(Fact::Child {
            thread,
            change: ChildChange::Config(config),
        });
    }
    facts
}

fn agents_states(states: &Value) -> Vec<Fact> {
    let Some(states) = states.as_object() else {
        return Vec::new();
    };
    states
        .iter()
        .filter_map(|(thread, state)| {
            let message = text(&state["message"]);
            let end = match state["status"].as_str()? {
                "completed" => End::completed(Strength::Reported),
                "errored" => {
                    End::failed(message.as_deref().unwrap_or("errored"), Strength::Reported)
                }
                "interrupted" => End::stopped(stop_reason::INTERRUPTED, Strength::Reported),
                "shutdown" => End::stopped(stop_reason::CLOSED, Strength::Inferred),
                "notFound" => End::stopped(stop_reason::NOT_FOUND, Strength::Reported),
                // pendingInit / running: nothing ended.
                _ => return None,
            };
            let summary = message.as_deref().and_then(summarize_subagent_result);
            Some(Fact::Child {
                thread: thread.clone(),
                change: ChildChange::Settled(end.with_summary(summary)),
            })
        })
        .collect()
}

fn first_state_message(states: &Value) -> Option<String> {
    states
        .as_object()?
        .values()
        .find_map(|state| text(&state["message"]))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn child_change(fact: &Fact) -> (&str, &ChildChange) {
        match fact {
            Fact::Child { thread, change } => (thread, change),
            Fact::Spawn { .. } => panic!("expected a child fact"),
        }
    }

    #[test]
    fn started_activity_carries_the_resolved_model() {
        // v2/ThreadItem.ts `subAgentActivity`.
        let facts = activity(&json!({
            "type": "subAgentActivity", "id": "call_spawn", "kind": "started",
            "agentThreadId": "thread_child", "agentPath": "/root/finish_reuse",
            "model": "gpt-6.1-sol", "reasoningEffort": "xhigh"
        }));
        assert!(matches!(
            child_change(&facts[0]),
            ("thread_child", ChildChange::Spawned)
        ));
        let (_, ChildChange::Config(config)) = child_change(&facts[1]) else {
            panic!("expected config");
        };
        assert_eq!(config.model.as_deref(), Some("gpt-6.1-sol"));
        assert!(config.model_resolved);
        assert_eq!(config.reasoning_effort.as_deref(), Some("xhigh"));
    }

    #[test]
    fn completion_activities_settle_and_interactions_do_not() {
        let item = |kind| json!({"type": "subAgentActivity", "id": "subagent-completed-1", "kind": kind, "agentThreadId": "c", "agentPath": "/root/c", "model": null, "reasoningEffort": null});
        let completed = activity(&item("completed"));
        assert!(
            matches!(child_change(&completed[0]), (_, ChildChange::Settled(end)) if *end == End::completed(Strength::Reported))
        );
        let interrupted = activity(&item("interrupted"));
        assert!(
            matches!(child_change(&interrupted[0]), (_, ChildChange::Settled(end)) if *end == End::stopped("interrupted", Strength::Reported))
        );
        assert!(activity(&item("interacted")).is_empty());
    }

    #[test]
    fn spawn_call_reports_request_and_failure() {
        // v2/ThreadItem.ts `collabAgentToolCall` with tool `spawnAgent`.
        let item = json!({
            "type": "collabAgentToolCall", "id": "call_spawn", "tool": "spawnAgent",
            "status": "failed", "senderThreadId": "root", "receiverThreadIds": [],
            "prompt": "Audit the codex adapter\nThen report", "model": "gpt-5.4-mini",
            "reasoningEffort": "low",
            "agentsStates": {"x": {"status": "errored", "message": "agent limit reached"}}
        });
        let started = tool_call(&item, false);
        let Fact::Spawn { call_id, patch } = &started[0] else {
            panic!("expected spawn")
        };
        assert_eq!(call_id, "call_spawn");
        assert_eq!(patch.status, None);
        assert_eq!(
            patch.description.as_deref(),
            Some("Audit the codex adapter")
        );
        assert_eq!(
            patch.prompt.as_deref(),
            Some("Audit the codex adapter\nThen report")
        );
        assert_eq!(patch.model.as_deref(), Some("gpt-5.4-mini"));
        assert!(!patch.model_resolved);
        assert_eq!(patch.reasoning_effort.as_deref(), Some("low"));

        let Fact::Spawn { patch, .. } = &tool_call(&item, true)[0] else {
            panic!("expected spawn")
        };
        assert_eq!(patch.status, Some(RuntimeSubagentStatus::Failed));
        assert_eq!(patch.status_reason.as_deref(), Some("agent limit reached"));
        assert_eq!(patch.result_summary.as_deref(), Some("agent limit reached"));

        let silent = json!({"id": "call_2", "tool": "spawnAgent", "status": "failed", "receiverThreadIds": ["t2"], "agentsStates": {}});
        let Fact::Spawn { patch, .. } = &tool_call(&silent, true)[0] else {
            panic!("expected spawn")
        };
        assert_eq!(patch.status_reason.as_deref(), Some(SPAWN_FAILED));
        assert_eq!(patch.child_session_id.as_deref(), Some("t2"));
    }

    #[test]
    fn wait_result_maps_every_agent_state() {
        // v2/CollabAgentStatus.ts: every terminal status, plus still-running ones.
        let item = json!({
            "type": "collabAgentToolCall", "id": "call_wait", "tool": "wait", "status": "completed",
            "senderThreadId": "root", "receiverThreadIds": ["a", "b", "c", "d", "e", "f"],
            "prompt": null, "model": null, "reasoningEffort": null,
            "agentsStates": {
                "a": {"status": "completed", "message": "Review A: LGTM"},
                "b": {"status": "errored", "message": "sandbox denied"},
                "c": {"status": "interrupted", "message": null},
                "d": {"status": "shutdown", "message": null},
                "e": {"status": "notFound", "message": null},
                "f": {"status": "running", "message": null}
            }
        });
        assert!(tool_call(&item, false).is_empty());
        let facts = tool_call(&item, true);
        assert_eq!(facts.len(), 5);
        let end = |thread: &str| {
            facts
                .iter()
                .map(child_change)
                .find(|(id, _)| *id == thread)
                .map(|(_, change)| match change {
                    ChildChange::Settled(end) => end.clone(),
                    _ => panic!("expected settled"),
                })
        };
        let a = end("a").unwrap();
        assert_eq!(
            a,
            End::completed(Strength::Reported).with_summary(Some("Review A: LGTM".into()))
        );
        assert_eq!(
            end("b").unwrap(),
            End::failed("sandbox denied", Strength::Reported)
        );
        assert_eq!(
            end("c").unwrap(),
            End::stopped("interrupted", Strength::Reported)
        );
        assert_eq!(
            end("d").unwrap(),
            End::stopped("closed", Strength::Inferred)
        );
        assert_eq!(
            end("e").unwrap(),
            End::stopped("not_found", Strength::Reported)
        );
        assert_eq!(end("f"), None);
    }

    #[test]
    fn raw_outputs_name_v1_children_and_carry_legacy_states() {
        let v1 = raw_output(&json!({
            "type": "function_call_output", "call_id": "call_spawn_v1",
            "output": "{\"agent_id\":\"thread_v1_child\",\"nickname\":\"Euler\"}"
        }));
        let ("thread_v1_child", ChildChange::Config(config)) = child_change(&v1[0]) else {
            panic!("expected config");
        };
        assert_eq!(config.agent_name.as_deref(), Some("Euler"));

        let legacy = raw_output(&json!({
            "type": "function_call_output", "call_id": "call_wait",
            "output": {"agentsStates": {"t": {"status": "completed", "message": "done"}}}
        }));
        assert!(matches!(
            child_change(&legacy[0]),
            ("t", ChildChange::Settled(_))
        ));
        for output in [
            json!("plain text"),
            json!("agent_id is not json"),
            json!({"task_name": "/root/x"}),
        ] {
            assert!(
                raw_output(&json!({"type": "function_call_output", "output": output})).is_empty()
            );
        }
        assert!(
            raw_output(&json!({"type": "function_call", "arguments": "{\"agent_id\":\"x\"}"}))
                .is_empty()
        );
    }
}
