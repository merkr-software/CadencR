//! Codex sub-agent facts for the provider-neutral sub-agent registry.
//!
//! Codex reports a child on two sides: on its own thread (`thread/started`,
//! `turn/*`, `thread/status/changed`, `thread/closed`, token usage, its final
//! answer) and on its parent's (`subAgentActivity`, collab tool calls and
//! their `agentsStates`, raw spawn outputs). Facts are read off a
//! notification before it is routed, resolved to the spawning carrier after
//! (routing is what registers a new child thread), and leave as one
//! standalone sub-agent signal that the shared tracker merges into the
//! registry. Launch configuration the carrier's own input names stays the
//! tracker's job.

mod child;
mod collab;
mod thread;

use std::collections::HashMap;
use std::time::Instant;

use serde_json::Value;

use self::child::{ChildChange, ChildReport};
use super::event_state::IndexState;
use crate::domain::agents::adapter::{RuntimeEvent, RuntimeSubagentPatch, RuntimeSubagentUpdate};

/// Per-child lifecycle bookkeeping, keyed by child thread id. Outlives root
/// turns, as the children do.
#[derive(Default)]
pub(super) struct SubagentReports {
    children: HashMap<String, ChildReport>,
}

enum Fact {
    /// About a spawn call, keyed by its call id.
    Spawn {
        call_id: String,
        patch: RuntimeSubagentPatch,
    },
    /// About a child thread, resolved to its carrier through the routes.
    Child { thread: String, change: ChildChange },
}

/// What one notification says about sub-agents, before it is routed.
pub(super) struct SubagentFacts {
    sender: Option<String>,
    facts: Vec<Fact>,
}

pub(super) fn read_subagent_facts(method: &str, params: &Value) -> SubagentFacts {
    let sender = params.get("threadId").and_then(Value::as_str);
    let facts = match method {
        "thread/started" => thread::started(&params["thread"]),
        "item/started" | "item/completed" => {
            item_facts(sender, &params["item"], method == "item/completed")
        }
        "rawResponseItem/completed" => collab::raw_output(&params["item"]),
        _ => sender
            .zip(thread::change(method, params))
            .map(|(thread, change)| Fact::Child {
                thread: thread.to_string(),
                change,
            })
            .into_iter()
            .collect(),
    };
    SubagentFacts {
        sender: sender.map(ToOwned::to_owned),
        facts,
    }
}

fn item_facts(sender: Option<&str>, item: &Value, completed: bool) -> Vec<Fact> {
    match item["type"].as_str() {
        Some("subAgentActivity") => collab::activity(item),
        Some("collabAgentToolCall") => collab::tool_call(item, completed),
        Some("agentMessage") if completed => sender
            .zip(thread::report(item))
            .map(|(thread, change)| Fact::Child {
                thread: thread.to_string(),
                change,
            })
            .into_iter()
            .collect(),
        _ => Vec::new(),
    }
}

/// Resolve `facts` to carrier patches, as one standalone signal event.
pub(super) fn subagent_report_event(
    facts: SubagentFacts,
    indexes: &mut IndexState,
    now: Instant,
) -> Option<RuntimeEvent> {
    // Guardian and foreign threads never speak for this session's children.
    if facts.facts.is_empty()
        || facts
            .sender
            .as_deref()
            .is_some_and(|sender| indexes.is_untracked_thread(sender))
    {
        return None;
    }
    let updates: Vec<_> = facts
        .facts
        .into_iter()
        .filter_map(|fact| resolve(fact, indexes, now))
        .collect();
    (!updates.is_empty()).then(|| RuntimeEvent::subagent_signal(updates))
}

fn resolve(fact: Fact, indexes: &mut IndexState, now: Instant) -> Option<RuntimeSubagentUpdate> {
    let (carrier, patch) = match fact {
        Fact::Spawn { call_id, patch } => (indexes.canonical_id(&call_id), patch),
        Fact::Child { thread, change } => {
            let carrier = indexes.subagent_parent_tool_use_id(&thread)?.to_owned();
            let report = indexes
                .subagent_reports
                .children
                .entry(thread.clone())
                .or_default();
            let mut patch = report.apply(change, now);
            if report.announce() {
                patch.child_session_id = Some(thread);
            }
            (carrier, patch)
        }
    };
    (!patch.is_empty()).then(|| RuntimeSubagentUpdate::new(carrier, patch))
}

#[cfg(test)]
mod tests {
    use super::super::events::notification_events;
    use super::*;
    use crate::domain::agents::adapter::RuntimeSubagentStatus;
    use serde_json::json;

    /// Every sub-agent update `notification_events` emits for one notification.
    fn updates(
        indexes: &mut IndexState,
        method: &str,
        params: Value,
    ) -> Vec<RuntimeSubagentUpdate> {
        notification_events(method, params, None, indexes)
            .iter()
            .flat_map(|event| event.subagent_updates().to_vec())
            .collect()
    }

    fn only(updates: Vec<RuntimeSubagentUpdate>) -> RuntimeSubagentUpdate {
        assert_eq!(updates.len(), 1, "{updates:?}");
        updates.into_iter().next().unwrap()
    }

    fn v2_spawn(indexes: &mut IndexState) {
        // Multi-agent v2: the raw spawn call, then the child's thread/started.
        indexes.should_reset_for_turn_started("root");
        let raw = updates(
            indexes,
            "rawResponseItem/completed",
            json!({"threadId": "root", "item": {
            "type": "function_call", "call_id": "call_spawn", "name": "spawn_agent",
            "arguments": "{\"task_name\":\"finish_reuse\",\"message\":\"Review reuse\"}"}}),
        );
        assert!(raw.is_empty(), "launch facts are the tracker's: {raw:?}");
        let started = only(updates(
            indexes,
            "thread/started",
            json!({"thread": {
            "id": "child", "parentThreadId": "root", "model": "gpt-6.1-sol", "reasoningEffort": "high",
            "agentNickname": "Hypatia", "agentRole": null, "status": {"type": "active", "activeFlags": []},
            "source": {"subAgent": {"thread_spawn": {"parent_thread_id": "root", "depth": 1,
                "agent_path": "/root/finish_reuse", "agent_nickname": "Hypatia", "agent_role": null}}}}}),
        ));
        assert_eq!(started.tool_use_id, "call_spawn");
        assert_eq!(started.patch.agent_name.as_deref(), Some("Hypatia"));
        assert_eq!(started.patch.model.as_deref(), Some("gpt-6.1-sol"));
        assert!(started.patch.model_resolved);
        assert_eq!(started.patch.reasoning_effort.as_deref(), Some("high"));
        assert_eq!(started.patch.child_session_id.as_deref(), Some("child"));
    }

    #[test]
    fn child_turns_report_running_tokens_report_and_completion() {
        let mut indexes = IndexState::default();
        v2_spawn(&mut indexes);
        let running = only(updates(
            &mut indexes,
            "turn/started",
            json!({"threadId": "child", "turn": {"id": "ct1"}}),
        ));
        assert_eq!(running.patch.status, Some(RuntimeSubagentStatus::Running));
        let tokens = only(updates(
            &mut indexes,
            "thread/tokenUsage/updated",
            json!({"threadId": "child", "turnId": "ct1",
            "tokenUsage": {"total": {"totalTokens": 900}, "last": {"totalTokens": 900}}}),
        ));
        assert_eq!(tokens.patch.total_tokens, Some(900));
        let throttled = updates(
            &mut indexes,
            "thread/tokenUsage/updated",
            json!({"threadId": "child", "turnId": "ct1",
            "tokenUsage": {"total": {"totalTokens": 1_200}, "last": {"totalTokens": 300}}}),
        );
        assert!(throttled.is_empty());
        assert!(updates(&mut indexes, "item/completed", json!({"threadId": "child", "turnId": "ct1",
            "item": {"type": "agentMessage", "id": "m", "text": "No reuse findings.", "phase": "final_answer"}})).is_empty());
        let done = only(updates(
            &mut indexes,
            "turn/completed",
            json!({"threadId": "child",
            "turn": {"id": "ct1", "status": "completed", "error": null, "durationMs": 3_000}}),
        ));
        assert_eq!(done.tool_use_id, "call_spawn");
        assert_eq!(done.patch.status, Some(RuntimeSubagentStatus::Completed));
        assert_eq!(
            done.patch.result_summary.as_deref(),
            Some("No reuse findings.")
        );
        assert_eq!(done.patch.duration_ms, Some(3_000));
        assert_eq!(done.patch.total_tokens, Some(1_200));
        // Bookkeeping after the turn end keeps it completed.
        for (method, params) in [
            (
                "thread/status/changed",
                json!({"threadId": "child", "status": {"type": "idle"}}),
            ),
            (
                "item/completed",
                json!({"threadId": "root", "item": {"type": "subAgentActivity",
                "id": "subagent-completed-1", "kind": "completed", "agentThreadId": "child", "agentPath": "/root/finish_reuse"}}),
            ),
            ("thread/closed", json!({"threadId": "child"})),
        ] {
            assert!(updates(&mut indexes, method, params).is_empty(), "{method}");
        }
    }

    #[test]
    fn resumed_child_runs_again_then_fails_with_its_error() {
        let mut indexes = IndexState::default();
        v2_spawn(&mut indexes);
        updates(
            &mut indexes,
            "turn/started",
            json!({"threadId": "child", "turn": {"id": "ct1"}}),
        );
        updates(
            &mut indexes,
            "turn/completed",
            json!({"threadId": "child", "turn": {"id": "ct1", "status": "completed"}}),
        );
        // followup_task in a later root turn resumes the same child.
        indexes.reset();
        let resumed = only(updates(
            &mut indexes,
            "turn/started",
            json!({"threadId": "child", "turn": {"id": "ct2"}}),
        ));
        assert_eq!(resumed.tool_use_id, "call_spawn");
        assert_eq!(resumed.patch.status, Some(RuntimeSubagentStatus::Running));
        let failed = only(updates(
            &mut indexes,
            "turn/completed",
            json!({"threadId": "child", "turn": {"id": "ct2",
            "status": "failed", "error": {"message": "Selected model is at capacity"}}}),
        ));
        assert_eq!(failed.patch.status, Some(RuntimeSubagentStatus::Failed));
        assert_eq!(
            failed.patch.status_reason.as_deref(),
            Some("Selected model is at capacity")
        );
    }

    #[test]
    fn interrupted_activity_and_system_error_settle_the_child() {
        let mut indexes = IndexState::default();
        v2_spawn(&mut indexes);
        let interrupted = only(updates(
            &mut indexes,
            "item/completed",
            json!({"threadId": "root", "item": {
            "type": "subAgentActivity", "id": "subagent-interrupted-1", "kind": "interrupted",
            "agentThreadId": "child", "agentPath": "/root/finish_reuse", "model": null, "reasoningEffort": null}}),
        ));
        assert_eq!(
            interrupted.patch.status,
            Some(RuntimeSubagentStatus::Stopped)
        );
        assert_eq!(
            interrupted.patch.status_reason.as_deref(),
            Some("interrupted")
        );

        let mut indexes = IndexState::default();
        v2_spawn(&mut indexes);
        let crashed = only(updates(
            &mut indexes,
            "thread/status/changed",
            json!({"threadId": "child", "status": {"type": "systemError"}}),
        ));
        assert_eq!(crashed.patch.status, Some(RuntimeSubagentStatus::Failed));
        assert_eq!(
            crashed.patch.status_reason.as_deref(),
            Some("Codex sub-agent thread hit a system error")
        );
    }

    #[test]
    fn closing_a_running_child_stops_it() {
        let mut indexes = IndexState::default();
        v2_spawn(&mut indexes);
        updates(
            &mut indexes,
            "turn/started",
            json!({"threadId": "child", "turn": {"id": "ct1"}}),
        );
        let closed = only(updates(
            &mut indexes,
            "thread/closed",
            json!({"threadId": "child"}),
        ));
        assert_eq!(closed.patch.status, Some(RuntimeSubagentStatus::Stopped));
        assert_eq!(closed.patch.status_reason.as_deref(), Some("closed"));
    }

    #[test]
    fn v1_collab_spawn_wait_and_failed_spawn() {
        let mut indexes = IndexState::for_root_thread("root");
        let spawn = |status: &str, receivers: Value| {
            json!({"threadId": "root", "item": {
            "type": "collabAgentToolCall", "id": "call_spawn", "tool": "spawnAgent", "status": status,
            "senderThreadId": "root", "receiverThreadIds": receivers, "prompt": "Review the diff",
            "model": "gpt-5.4-mini", "reasoningEffort": "low",
            "agentsStates": {"child": {"status": "pendingInit", "message": null}}}})
        };
        let requested = only(updates(
            &mut indexes,
            "item/started",
            spawn("inProgress", json!([])),
        ));
        assert_eq!(requested.tool_use_id, "call_spawn");
        assert_eq!(requested.patch.model.as_deref(), Some("gpt-5.4-mini"));
        assert!(!requested.patch.model_resolved);
        let wait = only(updates(
            &mut indexes,
            "item/completed",
            json!({"threadId": "root", "item": {
            "type": "collabAgentToolCall", "id": "call_wait", "tool": "wait", "status": "completed",
            "senderThreadId": "root", "receiverThreadIds": ["child"], "prompt": null, "model": null,
            "reasoningEffort": null, "agentsStates": {"child": {"status": "errored", "message": "sandbox denied"}}}}),
        ));
        assert_eq!(wait.tool_use_id, "call_spawn");
        assert_eq!(wait.patch.status, Some(RuntimeSubagentStatus::Failed));
        assert_eq!(wait.patch.result_summary.as_deref(), Some("sandbox denied"));
        assert_eq!(wait.patch.child_session_id.as_deref(), Some("child"));

        let mut indexes = IndexState::for_root_thread("root");
        let failed = only(updates(
            &mut indexes,
            "item/completed",
            spawn("failed", json!([])),
        ));
        assert_eq!(failed.patch.status, Some(RuntimeSubagentStatus::Failed));
        assert!(failed.patch.status_reason.is_some());
    }

    #[test]
    fn foreign_senders_and_unrouted_threads_report_nothing() {
        let mut indexes = IndexState::for_root_thread("root");
        indexes.record_subagent_thread("child", "call_spawn");
        assert!(updates(
            &mut indexes,
            "item/completed",
            json!({"threadId": "foreign", "item": {
            "type": "subAgentActivity", "id": "x", "kind": "completed", "agentThreadId": "child"}})
        )
        .is_empty());
        assert!(updates(
            &mut indexes,
            "turn/completed",
            json!({"threadId": "stranger", "turn": {"status": "failed"}})
        )
        .is_empty());
        assert!(updates(
            &mut indexes,
            "turn/started",
            json!({"threadId": "root", "turn": {"id": "r1"}})
        )
        .is_empty());
    }
}
