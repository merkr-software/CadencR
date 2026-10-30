//! A child thread's own notifications: its configuration when it starts,
//! its turns, status changes, token usage and final answer.
//!
//! Shapes from `codex app-server generate-ts` (codex-cli 0.165.0):
//! `v2/Thread.ts`, `v2/ThreadStatus.ts`, `v2/Turn.ts`, `v2/TurnStatus.ts`,
//! `v2/TurnError.ts`, `v2/ThreadTokenUsageUpdatedNotification.ts`,
//! `v2/ThreadItem.ts` (`agentMessage`, `MessagePhase.ts`).
use serde_json::Value;

use super::child::{ChildChange, End, Strength};
use super::Fact;
use crate::domain::agents::adapter::{
    non_empty_str as text, stop_reason, summarize_subagent_result, RuntimeSubagentPatch,
};
use crate::domain::agents::codex::event_subagent_routes::subagent_spawn_source;

const TURN_FAILED: &str = "Codex turn failed without error details";
/// `ThreadStatus::systemError` carries no detail; the reason is shown as-is.
const SYSTEM_ERROR: &str = "Codex sub-agent thread hit a system error";

/// `thread/started`: the nickname, role and model Codex gave a child.
pub(super) fn started(thread: &Value) -> Vec<Fact> {
    let Some(id) = text(&thread["id"]) else {
        return Vec::new();
    };
    let spawn = subagent_spawn_source(&thread["source"]).unwrap_or(&Value::Null);
    let model = text(&thread["model"]);
    let config = RuntimeSubagentPatch {
        agent_name: text(&thread["agentNickname"]).or_else(|| text(&spawn["agent_nickname"])),
        agent_type: text(&thread["agentRole"]).or_else(|| text(&spawn["agent_role"])),
        // The child thread's configured model is the one it runs on.
        model_resolved: model.is_some(),
        model,
        reasoning_effort: text(&thread["reasoningEffort"]),
        ..RuntimeSubagentPatch::default()
    };
    let mut facts = vec![Fact::Child {
        thread: id.clone(),
        change: ChildChange::Config(config),
    }];
    if thread["status"]["type"] == "active" {
        facts.push(Fact::Child {
            thread: id,
            change: ChildChange::Spawned,
        });
    }
    facts
}

/// Lifecycle notifications keyed by the thread they concern.
pub(super) fn change(method: &str, params: &Value) -> Option<ChildChange> {
    match method {
        "turn/started" => Some(ChildChange::Started {
            turn: text(&params["turn"]["id"]),
        }),
        "turn/completed" => Some(turn_ended(&params["turn"])),
        "thread/status/changed" => status_changed(&params["status"]),
        "thread/closed" => Some(ChildChange::Settled(End::stopped(
            stop_reason::CLOSED,
            Strength::Inferred,
        ))),
        "thread/tokenUsage/updated" => params["tokenUsage"]["total"]["totalTokens"]
            .as_u64()
            .map(ChildChange::Tokens),
        _ => None,
    }
}

/// A completed `agentMessage` that answers, as opposed to commentary or a
/// question to the user.
pub(super) fn report(item: &Value) -> Option<ChildChange> {
    let answers = matches!(item["phase"].as_str(), None | Some("final_answer"));
    let asks = item["questions"]
        .as_array()
        .is_some_and(|questions| !questions.is_empty());
    if !answers || asks {
        return None;
    }
    let summary = item["text"].as_str().and_then(summarize_subagent_result)?;
    Some(ChildChange::Report(summary))
}

fn turn_ended(turn: &Value) -> ChildChange {
    let error = text(&turn["error"]["message"]);
    let end = match turn["status"].as_str() {
        Some("interrupted") => End::stopped(stop_reason::INTERRUPTED, Strength::Turn),
        // Like the root's result: an error on a non-interrupted turn fails it.
        Some("failed") => End::failed(error.as_deref().unwrap_or(TURN_FAILED), Strength::Turn),
        _ => match error {
            Some(error) => End::failed(&error, Strength::Turn),
            None => End::completed(Strength::Turn),
        },
    };
    ChildChange::TurnEnded {
        turn: text(&turn["id"]),
        end,
        duration_ms: turn_duration_ms(turn),
    }
}

fn turn_duration_ms(turn: &Value) -> Option<u64> {
    turn["durationMs"].as_u64().or_else(|| {
        // `startedAt` / `completedAt` are Unix seconds.
        let started = turn["startedAt"].as_u64()?;
        let completed = turn["completedAt"].as_u64()?;
        completed.checked_sub(started)?.checked_mul(1_000)
    })
}

fn status_changed(status: &Value) -> Option<ChildChange> {
    let end = match status["type"].as_str()? {
        // A new turn reports the resume; `active` alone only confirms it runs.
        "active" => return Some(ChildChange::Spawned),
        "idle" => End::completed(Strength::Inferred),
        "notLoaded" => End::stopped(stop_reason::CLOSED, Strength::Inferred),
        "systemError" => End::new(
            crate::domain::agents::adapter::RuntimeSubagentStatus::Failed,
            Some(SYSTEM_ERROR),
            Strength::Reported,
        ),
        _ => return None,
    };
    Some(ChildChange::Settled(end))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::agents::adapter::RuntimeSubagentStatus;
    use serde_json::json;

    fn settled(change: Option<ChildChange>) -> End {
        match change {
            Some(ChildChange::Settled(end)) => end,
            _ => panic!("expected a settled change"),
        }
    }

    fn turn_end(turn: Value) -> (End, Option<u64>) {
        match change("turn/completed", &json!({"threadId": "c", "turn": turn})) {
            Some(ChildChange::TurnEnded {
                end, duration_ms, ..
            }) => (end, duration_ms),
            _ => panic!("expected a turn end"),
        }
    }

    #[test]
    fn thread_started_reads_nickname_role_and_model() {
        // v2/Thread.ts: nickname/role at the top level, spawn metadata in source.
        let facts = started(&json!({
            "id": "thread_child", "parentThreadId": "root", "model": "gpt-6.1-sol",
            "reasoningEffort": "xhigh", "agentNickname": "Hypatia", "agentRole": "explorer",
            "status": {"type": "active", "activeFlags": []},
            "source": {"subAgent": {"thread_spawn": {"parent_thread_id": "root", "depth": 1,
                "agent_path": "/root/finish_reuse", "agent_nickname": "Other", "agent_role": null}}}
        }));
        let Fact::Child {
            thread,
            change: ChildChange::Config(config),
        } = &facts[0]
        else {
            panic!("expected config");
        };
        assert_eq!(thread, "thread_child");
        assert_eq!(config.agent_name.as_deref(), Some("Hypatia"));
        assert_eq!(config.agent_type.as_deref(), Some("explorer"));
        assert_eq!(config.model.as_deref(), Some("gpt-6.1-sol"));
        assert!(config.model_resolved);
        assert_eq!(config.reasoning_effort.as_deref(), Some("xhigh"));
        assert!(matches!(
            facts[1],
            Fact::Child {
                change: ChildChange::Spawned,
                ..
            }
        ));
    }

    #[test]
    fn thread_started_falls_back_to_spawn_source_and_skips_idle_spawned() {
        let facts = started(&json!({
            "id": "c", "model": null, "agentNickname": null, "agentRole": null,
            "status": {"type": "idle"},
            "source": {"subAgent": {"thread_spawn": {"parent_thread_id": "root",
                "agent_nickname": "Mendel", "agent_role": "reviewer"}}}
        }));
        assert_eq!(facts.len(), 1);
        let Fact::Child {
            change: ChildChange::Config(config),
            ..
        } = &facts[0]
        else {
            panic!("expected config");
        };
        assert_eq!(config.agent_name.as_deref(), Some("Mendel"));
        assert_eq!(config.agent_type.as_deref(), Some("reviewer"));
        assert_eq!(config.model, None);
        assert!(!config.model_resolved);
    }

    #[test]
    fn turn_status_maps_to_endings_with_duration() {
        let (end, duration) =
            turn_end(json!({"id": "t", "status": "completed", "error": null, "durationMs": 4200}));
        assert_eq!(
            (end, duration),
            (End::completed(Strength::Turn), Some(4200))
        );
        let (end, duration) = turn_end(json!({"id": "t", "status": "failed",
            "error": {"message": "Selected model is at capacity", "codexErrorInfo": null, "additionalDetails": null},
            "startedAt": 100, "completedAt": 112, "durationMs": null}));
        assert_eq!(
            end,
            End::failed("Selected model is at capacity", Strength::Turn)
        );
        assert_eq!(duration, Some(12_000));
        assert_eq!(
            turn_end(json!({"status": "failed"})).0,
            End::failed(TURN_FAILED, Strength::Turn)
        );
        let (end, _) =
            turn_end(json!({"status": "interrupted", "error": {"message": "cancelled"}}));
        assert_eq!(end, End::stopped("interrupted", Strength::Turn));
        assert_eq!(turn_end(json!({})).0, End::completed(Strength::Turn));
    }

    #[test]
    fn thread_status_and_close_map_to_endings() {
        let status = |kind: &str| {
            change(
                "thread/status/changed",
                &json!({"threadId": "c", "status": {"type": kind}}),
            )
        };
        assert!(matches!(status("active"), Some(ChildChange::Spawned)));
        assert_eq!(settled(status("idle")), End::completed(Strength::Inferred));
        assert_eq!(
            settled(status("notLoaded")),
            End::stopped("closed", Strength::Inferred)
        );
        assert_eq!(
            settled(status("systemError")),
            End::new(
                RuntimeSubagentStatus::Failed,
                Some(SYSTEM_ERROR),
                Strength::Reported
            )
        );
        assert!(status("future").is_none());
        let closed = change("thread/closed", &json!({"threadId": "c"}));
        assert_eq!(settled(closed), End::stopped("closed", Strength::Inferred));
    }

    #[test]
    fn token_usage_reads_the_cumulative_total() {
        // v2/ThreadTokenUsage.ts.
        let params = json!({"threadId": "c", "turnId": "t", "tokenUsage": {
            "total": {"totalTokens": 12_345, "inputTokens": 10_000, "cachedInputTokens": 0,
                "cacheWriteInputTokens": 0, "outputTokens": 2_345, "reasoningOutputTokens": 0},
            "last": {"totalTokens": 345, "inputTokens": 300, "cachedInputTokens": 0,
                "cacheWriteInputTokens": 0, "outputTokens": 45, "reasoningOutputTokens": 0},
            "modelContextWindow": 400_000}});
        assert!(matches!(
            change("thread/tokenUsage/updated", &params),
            Some(ChildChange::Tokens(12_345))
        ));
        assert!(change("turn/plan/updated", &params).is_none());
    }

    #[test]
    fn only_final_answers_are_reports() {
        let message = |phase: Value, questions: Value| {
            json!({"type": "agentMessage", "id": "m",
            "text": "No actionable findings.", "phase": phase, "questions": questions})
        };
        assert!(
            matches!(report(&message(json!("final_answer"), json!(null))), Some(ChildChange::Report(text)) if text == "No actionable findings.")
        );
        assert!(report(&message(json!(null), json!(null))).is_some());
        assert!(report(&message(json!("commentary"), json!(null))).is_none());
        assert!(report(&message(json!(null), json!([{"id": "q"}]))).is_none());
    }
}
