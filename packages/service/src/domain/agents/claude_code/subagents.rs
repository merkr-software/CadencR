//! Claude Code sub-agent facts the provider-neutral tracker cannot derive.
//!
//! The shared tracker reads launches, child models and carrier results off
//! the normalized stream. What only Claude's protocol says is attached here
//! as [`RuntimeSubagentUpdate`]s on the event that revealed it: the Agent
//! tool's structured result (a background launch ack is not a completion; a
//! foreground completion carries totals and the resolved model), the
//! `system/task_*` lifecycle that settles background agents, and the
//! model/effort a custom agent definition pins, and the report a sub-agent
//! hands back through its own call when the carrier's result only points at it.
//!
//! The task lifecycle travels on the CLI's side queue, so it can trail the
//! main stream: a carrier whose tool_result already arrived is not revived by
//! a late `task_started`, while a running update after the queue itself
//! reported the end is a genuine resume. Conforms to
//! `.claude/rules/inline-rust-tests.md`.

mod definitions;
mod handback;
mod task_events;
mod tool_result;

use std::collections::HashMap;
use std::path::Path;
use std::time::{Duration, Instant};

use serde_json::Value;

use super::events::normalize_event;
use crate::domain::agents::adapter::{
    is_subagent_tool_name, summarize_subagent_result, RuntimeEvent, RuntimeSubagentPatch,
    RuntimeSubagentStatus, RuntimeSubagentUpdate,
};
use definitions::{AgentDirs, DefinitionLookup};
use handback::{apply_handback, handback_report};
pub(super) use task_events::terminal_task_status;
use task_events::TaskEvent;
use tool_result::{parse_agent_tool_result, AgentToolResult};

/// At most one progress update per agent per interval.
const PROGRESS_INTERVAL: Duration = Duration::from_secs(1);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum CarrierPhase {
    /// Launched and not known to have ended.
    Live,
    /// Its tool_result arrived; queued lifecycle messages may still trail.
    ResultSeen,
    /// The task queue reported its end.
    Notified,
}

impl CarrierPhase {
    /// Whether a running signal from the task queue may mark it running.
    fn resume(&mut self) -> bool {
        if *self == Self::ResultSeen {
            return false;
        }
        *self = Self::Live;
        true
    }
}

#[derive(Debug)]
struct TaskEntry {
    tool_use_id: String,
    description: Option<String>,
    last_progress: Option<Instant>,
}

#[derive(Debug, Default)]
struct Observed {
    updates: Vec<RuntimeSubagentUpdate>,
    lookups: Vec<DefinitionLookup>,
}

/// Per-runtime sub-agent bookkeeping, owned by the session's message pump.
#[derive(Debug, Default)]
pub(super) struct ClaudeSubagentState {
    definitions: AgentDirs,
    /// Agent/Task carriers seen on this stream, by tool_use id.
    carriers: HashMap<String, CarrierPhase>,
    /// Lifecycle tasks by `task_id` (`task_updated` names only the task).
    tasks: HashMap<String, TaskEntry>,
    /// Reports sub-agents handed back, by carrier. Kept, not taken: the
    /// carrier's result and the task queue's end each report the pointer, in
    /// either order, and each must read the report instead.
    handbacks: HashMap<String, String>,
}

impl ClaudeSubagentState {
    pub(super) fn new(cwd: &Path) -> Self {
        Self {
            definitions: AgentDirs::new(cwd, dirs::home_dir().as_deref()),
            ..Self::default()
        }
    }

    /// Normalize `msg` and attach the sub-agent facts it reveals.
    pub(super) async fn normalize(&mut self, msg: claude_agent_sdk_rs::SdkMessage) -> RuntimeEvent {
        let Observed {
            mut updates,
            lookups,
        } = self.observe(&msg, Instant::now());
        for lookup in &lookups {
            updates.extend(self.definitions.resolve(lookup).await);
        }
        normalize_event(msg).with_subagent_updates(updates)
    }

    fn observe(&mut self, msg: &claude_agent_sdk_rs::SdkMessage, now: Instant) -> Observed {
        match msg {
            claude_agent_sdk_rs::SdkMessage::Assistant {
                message,
                parent_tool_use_id,
                ..
            } => Observed {
                updates: self
                    .observe_handback(parent_tool_use_id.as_deref(), &message.content)
                    .into_iter()
                    .collect(),
                lookups: self.observe_launches(&message.content),
            },
            claude_agent_sdk_rs::SdkMessage::User {
                message,
                tool_use_result,
                ..
            } => Observed {
                updates: self.observe_tool_results(message, tool_use_result.as_ref()),
                ..Observed::default()
            },
            claude_agent_sdk_rs::SdkMessage::Unknown(raw) => Observed {
                updates: TaskEvent::parse(raw)
                    .and_then(|event| self.observe_task(event, now))
                    .into_iter()
                    .collect(),
                ..Observed::default()
            },
            _ => Observed::default(),
        }
    }

    fn observe_launches(
        &mut self,
        content: &[claude_agent_sdk_rs::ContentBlock],
    ) -> Vec<DefinitionLookup> {
        let mut lookups = Vec::new();
        for block in content {
            let claude_agent_sdk_rs::ContentBlock::ToolUse { id, name, input } = block else {
                continue;
            };
            if !is_subagent_tool_name(name) || self.carriers.contains_key(id) {
                continue;
            }
            self.carriers.insert(id.clone(), CarrierPhase::Live);
            lookups.extend(DefinitionLookup::for_launch(id, input));
        }
        lookups
    }

    /// A run the task queue already ended takes the report at once; a later
    /// carrier result reads it again.
    fn observe_handback(
        &mut self,
        parent: Option<&str>,
        content: &[claude_agent_sdk_rs::ContentBlock],
    ) -> Option<RuntimeSubagentUpdate> {
        let carrier = parent?;
        let phase = *self.carriers.get(carrier)?;
        let report = handback_report(content)?;
        self.handbacks.insert(carrier.to_string(), report.clone());
        if phase != CarrierPhase::Notified {
            return None;
        }
        let mut patch = RuntimeSubagentPatch::default();
        apply_handback(&mut patch, Some(report));
        (!patch.is_empty()).then(|| RuntimeSubagentUpdate::new(carrier, patch))
    }

    /// The structured result is only attributable when the message carries a
    /// single tool_result (the CLI emits one per message).
    fn observe_tool_results(
        &mut self,
        message: &Value,
        structured: Option<&Value>,
    ) -> Vec<RuntimeSubagentUpdate> {
        let ids = tool_result_ids(message);
        let structured = structured.filter(|_| ids.len() == 1);
        let mut updates = Vec::new();
        for id in ids {
            let Some(phase) = self.carriers.get_mut(id) else {
                continue;
            };
            let outcome = structured.map_or(AgentToolResult::Other, parse_agent_tool_result);
            match outcome {
                AgentToolResult::Launched(mut patch) => {
                    if *phase == CarrierPhase::Notified {
                        // It already finished; the ack trailed its end.
                        patch.status = None;
                    }
                    updates.push(RuntimeSubagentUpdate::new(id, patch));
                }
                AgentToolResult::Completed(mut patch) => {
                    mark_result_seen(phase);
                    apply_handback(&mut patch, self.handbacks.get(id).cloned());
                    updates.push(RuntimeSubagentUpdate::new(id, patch));
                }
                AgentToolResult::Other => {
                    mark_result_seen(phase);
                    let mut patch = RuntimeSubagentPatch::default();
                    apply_handback(&mut patch, self.handbacks.get(id).cloned());
                    if !patch.is_empty() {
                        updates.push(RuntimeSubagentUpdate::new(id, patch));
                    }
                }
            }
        }
        updates
    }

    fn observe_task(&mut self, event: TaskEvent, now: Instant) -> Option<RuntimeSubagentUpdate> {
        let tool_use_id = self.carrier_of(&event)?;
        let phase = self.carriers.get_mut(&tool_use_id)?;
        let entry = self.tasks.get_mut(event.task_id())?;
        let patch = match event {
            TaskEvent::Started {
                task_id,
                agent_type,
                description,
                backgrounded,
                ..
            } => {
                entry.description = description;
                RuntimeSubagentPatch {
                    status: phase.resume().then_some(RuntimeSubagentStatus::Running),
                    agent_type,
                    background: backgrounded.filter(|backgrounded| *backgrounded),
                    child_session_id: Some(task_id),
                    ..RuntimeSubagentPatch::default()
                }
            }
            TaskEvent::Progress { usage, .. } => {
                let usage = usage?;
                if entry
                    .last_progress
                    .is_some_and(|at| now.duration_since(at) < PROGRESS_INTERVAL)
                {
                    return None;
                }
                entry.last_progress = Some(now);
                usage.into_patch()
            }
            TaskEvent::Notification {
                status,
                reason,
                summary,
                usage,
                ..
            } => {
                let mut patch = notification_patch(phase, entry, &status, reason, summary, usage)?;
                if patch.status == Some(RuntimeSubagentStatus::Completed) {
                    apply_handback(&mut patch, self.handbacks.get(&tool_use_id).cloned());
                }
                patch
            }
            TaskEvent::Updated {
                status,
                error,
                backgrounded,
                ..
            } => updated_patch(phase, status.as_deref(), error, backgrounded),
        };
        (!patch.is_empty()).then(|| RuntimeSubagentUpdate::new(tool_use_id, patch))
    }

    /// The carrier a task belongs to: its own `tool_use_id` when it names a
    /// carrier of this stream, else the one recorded for its `task_id`.
    /// Tasks of anything else (shell commands, monitors) resolve to nothing.
    fn carrier_of(&mut self, event: &TaskEvent) -> Option<String> {
        let task_id = event.task_id();
        if let Some(id) = event
            .tool_use_id()
            .filter(|id| self.carriers.contains_key(*id))
        {
            self.tasks
                .entry(task_id.to_string())
                .or_insert_with(|| TaskEntry {
                    tool_use_id: id.to_string(),
                    description: None,
                    last_progress: None,
                });
            return Some(id.to_string());
        }
        self.tasks
            .get(task_id)
            .map(|entry| entry.tool_use_id.clone())
    }
}

fn mark_result_seen(phase: &mut CarrierPhase) {
    if *phase == CarrierPhase::Live {
        *phase = CarrierPhase::ResultSeen;
    }
}

/// `task_notification`: the end of a task, foreground or background. For a
/// foreground agent the CLI's `summary` is just the description and its
/// totals are cruder than the tool result's, which wins when already seen.
fn notification_patch(
    phase: &mut CarrierPhase,
    entry: &TaskEntry,
    label: &str,
    reason: Option<String>,
    summary: Option<String>,
    usage: Option<task_events::TaskUsage>,
) -> Option<RuntimeSubagentPatch> {
    let status = terminal_task_status(label)?;
    let first_end = *phase != CarrierPhase::Notified;
    let mut patch = match usage {
        Some(usage) if *phase != CarrierPhase::ResultSeen => usage.into_patch(),
        _ => RuntimeSubagentPatch::default(),
    };
    *phase = CarrierPhase::Notified;
    let summary = summary
        .filter(|summary| {
            !entry
                .description
                .as_deref()
                .is_some_and(|d| same_words(d, summary))
        })
        .and_then(|summary| summarize_subagent_result(&summary));
    // An explicit reason always applies; a derived one only names the first
    // reported end, so the `killed` of a preceding `task_updated` survives
    // the notification's generic `stopped`.
    let derived = match status {
        RuntimeSubagentStatus::Completed | RuntimeSubagentStatus::Running => None,
        RuntimeSubagentStatus::Failed => summary.clone().or_else(|| Some(label.to_string())),
        RuntimeSubagentStatus::Stopped => Some(label.to_string()),
    };
    patch.status = Some(status);
    patch.status_reason = reason
        .filter(|_| status != RuntimeSubagentStatus::Completed)
        .or(derived.filter(|_| first_end));
    patch.result_summary = summary;
    Some(patch)
}

/// `task_updated`: a diff of the task's state. `killed` is how a stopped
/// agent ends; `paused` keeps it running.
fn updated_patch(
    phase: &mut CarrierPhase,
    status: Option<&str>,
    error: Option<String>,
    backgrounded: Option<bool>,
) -> RuntimeSubagentPatch {
    let mut patch = RuntimeSubagentPatch {
        background: backgrounded.filter(|backgrounded| *backgrounded),
        ..RuntimeSubagentPatch::default()
    };
    match status {
        Some("pending" | "running") => {
            if phase.resume() {
                patch.status = Some(RuntimeSubagentStatus::Running);
            }
        }
        Some(label) => {
            if let Some(terminal) = terminal_task_status(label) {
                *phase = CarrierPhase::Notified;
                patch.status = Some(terminal);
                patch.status_reason = match terminal {
                    RuntimeSubagentStatus::Completed => None,
                    _ => error.or_else(|| Some(label.to_string())),
                };
            }
        }
        None => {}
    }
    patch
}

fn same_words(a: &str, b: &str) -> bool {
    a.split_whitespace().eq(b.split_whitespace())
}

fn tool_result_ids(message: &Value) -> Vec<&str> {
    message
        .get("content")
        .and_then(Value::as_array)
        .map(|blocks| {
            blocks
                .iter()
                .filter(|block| block.get("type").and_then(Value::as_str) == Some("tool_result"))
                .filter_map(|block| block.get("tool_use_id").and_then(Value::as_str))
                .collect()
        })
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use std::time::{Duration, Instant};

    use serde_json::{json, Value};

    use super::{ClaudeSubagentState, RuntimeSubagentPatch, RuntimeSubagentStatus};
    use crate::domain::agents::adapter::RuntimeSubagentUpdate;

    fn msg(value: Value) -> claude_agent_sdk_rs::SdkMessage {
        serde_json::from_value(value).expect("valid sdk message")
    }

    fn launch(id: &str, input: Value) -> claude_agent_sdk_rs::SdkMessage {
        msg(json!({
            "type": "assistant", "uuid": "u", "session_id": "s", "parent_tool_use_id": null,
            "message": { "id": "m", "model": "claude-opus-5-5",
                "content": [{ "type": "tool_use", "id": id, "name": "Agent", "input": input }] }
        }))
    }

    fn tool_result(id: &str, structured: Value) -> claude_agent_sdk_rs::SdkMessage {
        msg(json!({
            "type": "user", "uuid": "u", "session_id": "s", "parent_tool_use_id": null,
            "message": { "role": "user", "content": [{ "type": "tool_result", "tool_use_id": id,
                "content": [{ "type": "text", "text": "Async agent launched successfully." }] }] },
            "tool_use_result": structured
        }))
    }

    fn system(subtype: &str, fields: Value) -> claude_agent_sdk_rs::SdkMessage {
        let mut value =
            json!({ "type": "system", "subtype": subtype, "uuid": "u", "session_id": "s" });
        value
            .as_object_mut()
            .unwrap()
            .extend(fields.as_object().unwrap().clone());
        msg(value)
    }

    fn started(
        task_id: &str,
        tool_use_id: &str,
        backgrounded: bool,
    ) -> claude_agent_sdk_rs::SdkMessage {
        system(
            "task_started",
            json!({ "task_id": task_id, "tool_use_id": tool_use_id, "task_type": "local_agent",
                "description": "Audit codex", "subagent_type": "Explore",
                "is_backgrounded": backgrounded }),
        )
    }

    fn notification(
        task_id: &str,
        status: &str,
        summary: &str,
        usage: Value,
    ) -> claude_agent_sdk_rs::SdkMessage {
        system(
            "task_notification",
            json!({ "task_id": task_id, "tool_use_id": "toolu_1", "status": status,
                "output_file": "", "summary": summary, "usage": usage }),
        )
    }

    fn observe(
        state: &mut ClaudeSubagentState,
        message: claude_agent_sdk_rs::SdkMessage,
    ) -> Vec<RuntimeSubagentUpdate> {
        observe_at(state, message, Instant::now())
    }

    fn observe_at(
        state: &mut ClaudeSubagentState,
        message: claude_agent_sdk_rs::SdkMessage,
        now: Instant,
    ) -> Vec<RuntimeSubagentUpdate> {
        state.observe(&message, now).updates
    }

    fn only(updates: Vec<RuntimeSubagentUpdate>) -> RuntimeSubagentPatch {
        assert_eq!(updates.len(), 1, "{updates:?}");
        assert_eq!(updates[0].tool_use_id, "toolu_1");
        updates.into_iter().next().unwrap().patch
    }

    #[test]
    fn background_agent_runs_until_its_notification() {
        let mut state = ClaudeSubagentState::default();
        assert!(observe(
            &mut state,
            launch("toolu_1", json!({"description": "Audit codex"}))
        )
        .is_empty());

        let ack = only(observe(
            &mut state,
            tool_result(
                "toolu_1",
                json!({ "isAsync": true, "status": "async_launched", "agentId": "a8f3c2",
                    "description": "Audit codex", "resolvedModel": "claude-haiku-5-5",
                    "prompt": "p", "outputFile": "/tmp/a8f3c2.output" }),
            ),
        ));
        assert_eq!(ack.status, Some(RuntimeSubagentStatus::Running));
        assert_eq!(ack.background, Some(true));
        assert_eq!(ack.child_session_id.as_deref(), Some("a8f3c2"));
        assert!(ack.model_resolved);

        let start = only(observe(&mut state, started("a8f3c2", "toolu_1", true)));
        assert_eq!(start.status, Some(RuntimeSubagentStatus::Running));
        assert_eq!(start.background, Some(true));
        assert_eq!(start.agent_type.as_deref(), Some("Explore"));

        let t0 = Instant::now();
        let progress = |tokens: u64| {
            system(
                "task_progress",
                json!({ "task_id": "a8f3c2", "tool_use_id": "toolu_1", "description": "Audit codex",
                    "usage": { "total_tokens": tokens, "tool_uses": 2, "duration_ms": 900 } }),
            )
        };
        let first = only(observe_at(&mut state, progress(500), t0));
        assert_eq!(first.total_tokens, Some(500));
        assert_eq!(first.tool_use_count, Some(2));
        assert_eq!(first.status, None);
        assert!(observe_at(&mut state, progress(600), t0 + Duration::from_millis(400)).is_empty());
        let later = only(observe_at(
            &mut state,
            progress(700),
            t0 + Duration::from_millis(1100),
        ));
        assert_eq!(later.total_tokens, Some(700));

        let end = only(observe(
            &mut state,
            notification(
                "a8f3c2",
                "completed",
                "Found 3 issues in the codex adapter",
                json!({ "total_tokens": 9000, "tool_uses": 12, "duration_ms": 30000 }),
            ),
        ));
        assert_eq!(end.status, Some(RuntimeSubagentStatus::Completed));
        assert_eq!(end.status_reason, None);
        assert_eq!(
            end.result_summary.as_deref(),
            Some("Found 3 issues in the codex adapter")
        );
        assert_eq!(end.total_tokens, Some(9000));
        assert_eq!(end.tool_use_count, Some(12));
        assert_eq!(end.duration_ms, Some(30000));
    }

    #[test]
    fn foreground_completion_wins_over_trailing_queue_messages() {
        let mut state = ClaudeSubagentState::default();
        observe(
            &mut state,
            launch("toolu_1", json!({"description": "Audit codex"})),
        );
        let done = only(observe(
            &mut state,
            tool_result(
                "toolu_1",
                json!({ "status": "completed", "prompt": "p", "agentId": "a8f3c2",
                    "agentType": "Explore", "content": [{ "type": "text", "text": "Found 3 issues" }],
                    "resolvedModel": "claude-haiku-5-5", "totalDurationMs": 4210,
                    "totalTokens": 18342, "totalToolUseCount": 7 }),
            ),
        ));
        assert_eq!(done.status, None);
        assert_eq!(done.total_tokens, Some(18342));
        assert_eq!(done.result_summary.as_deref(), Some("Found 3 issues"));

        // The queue's own start trails the result: it must not revive the run.
        let late = only(observe(&mut state, started("a8f3c2", "toolu_1", false)));
        assert_eq!(late.status, None);
        assert_eq!(late.background, None);

        // A sync agent's notification summary is its description and its
        // usage is cruder than the tool result's totals.
        let end = only(observe(
            &mut state,
            notification(
                "a8f3c2",
                "completed",
                "Audit  codex",
                json!({ "total_tokens": 18000, "tool_uses": 7, "duration_ms": 4300 }),
            ),
        ));
        assert_eq!(end.status, Some(RuntimeSubagentStatus::Completed));
        assert_eq!(end.result_summary, None);
        assert_eq!(end.total_tokens, None);
        assert_eq!(end.duration_ms, None);
    }

    fn handback(parent: &str, message: &str) -> claude_agent_sdk_rs::SdkMessage {
        msg(json!({
            "type": "assistant", "uuid": "u", "session_id": "s", "parent_tool_use_id": parent,
            "message": { "id": "m", "model": "claude-haiku-5-5",
                "content": [{ "type": "tool_use", "id": "hb", "name": "SubagentHandback",
                    "input": { "message": message } }] }
        }))
    }

    #[test]
    fn handed_back_report_replaces_the_pointer_result() {
        let pointer = "This agent's report was delivered to you as a message from \"a8f3c2\" \
            (its SubagentHandback call). Read it there; it is not repeated here.";
        let mut state = ClaudeSubagentState::default();
        observe(
            &mut state,
            launch("toolu_1", json!({"description": "Scan"})),
        );
        // A handback from outside any carrier is not attributable.
        assert!(observe(&mut state, handback("toolu_other", "Stray")).is_empty());
        assert!(observe(&mut state, handback("toolu_1", "Found 3 adapters")).is_empty());

        let done = only(observe(
            &mut state,
            tool_result(
                "toolu_1",
                json!({ "status": "completed", "agentId": "a8f3c2",
                    "content": [{ "type": "text", "text": pointer }], "totalTokens": 900,
                    "totalToolUseCount": 3 }),
            ),
        ));
        assert_eq!(done.result_summary.as_deref(), Some("Found 3 adapters"));
        assert_eq!(done.total_tokens, Some(900));
        assert_eq!(done.tool_use_count, Some(2));

        // Without a structured result the report still settles the summary.
        observe(
            &mut state,
            launch("toolu_2", json!({"description": "Scan"})),
        );
        observe(&mut state, handback("toolu_2", "Second report"));
        let updates = observe(&mut state, tool_result("toolu_2", Value::Null));
        assert_eq!(updates.len(), 1);
        assert_eq!(updates[0].tool_use_id, "toolu_2");
        assert_eq!(
            updates[0].patch.result_summary.as_deref(),
            Some("Second report")
        );
    }

    #[test]
    fn background_handback_replaces_the_notification_pointer() {
        let pointer = "This agent's report was delivered to you as a message from \"a8f3c2\" \
            (its SubagentHandback call). Read it there; it is not repeated here.";
        let usage = json!({ "total_tokens": 900, "tool_uses": 2, "duration_ms": 26000 });
        let mut state = ClaudeSubagentState::default();
        observe(
            &mut state,
            launch("toolu_1", json!({"description": "Wait"})),
        );
        observe(&mut state, started("a8f3c2", "toolu_1", true));
        assert!(observe(&mut state, handback("toolu_1", "scout done")).is_empty());

        let end = only(observe(
            &mut state,
            notification("a8f3c2", "completed", pointer, usage.clone()),
        ));
        assert_eq!(end.result_summary.as_deref(), Some("scout done"));
        assert_eq!(end.tool_use_count, Some(1));

        // A handback the queue's end overtook still lands on the run.
        let mut state = ClaudeSubagentState::default();
        observe(
            &mut state,
            launch("toolu_1", json!({"description": "Wait"})),
        );
        observe(&mut state, started("a8f3c2", "toolu_1", true));
        observe(
            &mut state,
            notification("a8f3c2", "completed", pointer, usage),
        );
        let late = only(observe(&mut state, handback("toolu_1", "scout done")));
        assert_eq!(late.result_summary.as_deref(), Some("scout done"));
        assert_eq!(late.status, None);
    }

    #[test]
    fn foreground_report_survives_a_queue_end_before_the_carrier_result() {
        let pointer = "This agent's report was delivered to you as a message from \"a8f3c2\" \
            (its SubagentHandback call). Read it there; it is not repeated here.";
        let mut state = ClaudeSubagentState::default();
        observe(
            &mut state,
            launch("toolu_1", json!({"description": "Read"})),
        );
        observe(&mut state, started("a8f3c2", "toolu_1", false));
        observe(&mut state, handback("toolu_1", "# QA repo"));
        let queued = only(observe(
            &mut state,
            notification("a8f3c2", "completed", "Read", json!({ "tool_uses": 2 })),
        ));
        assert_eq!(queued.result_summary.as_deref(), Some("# QA repo"));

        let done = only(observe(
            &mut state,
            tool_result(
                "toolu_1",
                json!({ "status": "completed", "agentId": "a8f3c2",
                    "content": [{ "type": "text", "text": pointer }], "totalToolUseCount": 2 }),
            ),
        ));
        assert_eq!(done.result_summary.as_deref(), Some("# QA repo"));
        assert_eq!(done.tool_use_count, Some(1));
    }

    #[test]
    fn killed_update_resolves_by_task_id_and_keeps_its_reason() {
        let mut state = ClaudeSubagentState::default();
        observe(
            &mut state,
            launch("toolu_1", json!({"run_in_background": true})),
        );
        observe(&mut state, started("a8f3c2", "toolu_1", true));
        let killed = only(observe(
            &mut state,
            system(
                "task_updated",
                json!({ "task_id": "a8f3c2", "run_id": "r1",
                    "patch": { "status": "killed", "end_time": 1761800000000u64 } }),
            ),
        ));
        assert_eq!(killed.status, Some(RuntimeSubagentStatus::Stopped));
        assert_eq!(killed.status_reason.as_deref(), Some("killed"));

        let end = only(observe(
            &mut state,
            notification("a8f3c2", "stopped", "Audit codex", json!({})),
        ));
        assert_eq!(end.status, Some(RuntimeSubagentStatus::Stopped));
        assert_eq!(
            end.status_reason, None,
            "the notification must not mask `killed`"
        );

        // An explicit running update after the queue's end is a resume.
        let resumed = only(observe(
            &mut state,
            system(
                "task_updated",
                json!({ "task_id": "a8f3c2", "patch": { "status": "running" } }),
            ),
        ));
        assert_eq!(resumed.status, Some(RuntimeSubagentStatus::Running));
    }

    #[test]
    fn failures_carry_their_reason() {
        let mut state = ClaudeSubagentState::default();
        observe(&mut state, launch("toolu_1", json!({})));
        observe(&mut state, started("a8f3c2", "toolu_1", true));
        let failed = only(observe(
            &mut state,
            system(
                "task_updated",
                json!({ "task_id": "a8f3c2", "patch": { "status": "failed", "error": "API Error: 529" } }),
            ),
        ));
        assert_eq!(failed.status, Some(RuntimeSubagentStatus::Failed));
        assert_eq!(failed.status_reason.as_deref(), Some("API Error: 529"));

        let mut state = ClaudeSubagentState::default();
        observe(&mut state, launch("toolu_1", json!({})));
        observe(&mut state, started("b1", "toolu_1", true));
        let failed = only(observe(
            &mut state,
            notification("b1", "failed", "Agent crashed: out of context", json!({})),
        ));
        assert_eq!(failed.status, Some(RuntimeSubagentStatus::Failed));
        assert_eq!(
            failed.status_reason.as_deref(),
            Some("Agent crashed: out of context")
        );
        assert_eq!(
            failed.result_summary.as_deref(),
            Some("Agent crashed: out of context")
        );
    }

    #[test]
    fn paused_and_backgrounding_updates() {
        let mut state = ClaudeSubagentState::default();
        observe(&mut state, launch("toolu_1", json!({})));
        observe(&mut state, started("a8f3c2", "toolu_1", false));
        assert!(observe(
            &mut state,
            system(
                "task_updated",
                json!({ "task_id": "a8f3c2", "patch": { "status": "paused" } })
            ),
        )
        .is_empty());
        // Moved to the background mid-run: the turn's end must not settle it.
        let moved = only(observe(
            &mut state,
            system(
                "task_updated",
                json!({ "task_id": "a8f3c2", "patch": { "is_backgrounded": true } }),
            ),
        ));
        assert_eq!(moved.background, Some(true));
        assert_eq!(moved.status, None);
    }

    #[test]
    fn ack_trailing_the_end_does_not_revive() {
        let mut state = ClaudeSubagentState::default();
        observe(&mut state, launch("toolu_1", json!({})));
        observe(&mut state, started("a8f3c2", "toolu_1", true));
        observe(
            &mut state,
            notification("a8f3c2", "completed", "done", json!({})),
        );
        let ack = only(observe(
            &mut state,
            tool_result(
                "toolu_1",
                json!({ "status": "async_launched", "agentId": "a8f3c2" }),
            ),
        ));
        assert_eq!(ack.status, None);
        assert_eq!(ack.background, Some(true));
    }

    #[test]
    fn ignores_tasks_and_results_of_other_tools() {
        let mut state = ClaudeSubagentState::default();
        // A background shell's lifecycle names its Bash tool_use, not a carrier.
        assert!(observe(
            &mut state,
            system(
                "task_started",
                json!({ "task_id": "bwhoajb5w", "tool_use_id": "toolu_bash", "task_type": "local_bash",
                    "description": "sleep" }),
            ),
        )
        .is_empty());
        assert!(observe(
            &mut state,
            system(
                "task_updated",
                json!({ "task_id": "bwhoajb5w", "patch": { "status": "completed" } })
            ),
        )
        .is_empty());
        assert!(observe(
            &mut state,
            tool_result(
                "toolu_bash",
                json!({ "status": "async_launched", "agentId": "x" })
            ),
        )
        .is_empty());
    }

    #[test]
    fn structured_result_needs_a_single_tool_result() {
        let mut state = ClaudeSubagentState::default();
        observe(&mut state, launch("toolu_1", json!({})));
        let updates = observe(
            &mut state,
            msg(json!({
                "type": "user", "uuid": "u", "session_id": "s", "parent_tool_use_id": null,
                "message": { "role": "user", "content": [
                    { "type": "tool_result", "tool_use_id": "toolu_1", "content": "a" },
                    { "type": "tool_result", "tool_use_id": "toolu_2", "content": "b" }
                ] },
                "tool_use_result": { "status": "async_launched", "agentId": "x" }
            })),
        );
        assert!(updates.is_empty());
        // Its result arrived, so a trailing start does not revive it.
        let late = only(observe(&mut state, started("a1", "toolu_1", false)));
        assert_eq!(late.status, None);
    }

    #[tokio::test]
    async fn normalize_attaches_updates_and_custom_agent_definition() {
        let root = tempfile::tempdir().unwrap();
        let cwd = root.path().join("repo");
        let agents = cwd.join(".claude").join("agents");
        std::fs::create_dir_all(&agents).unwrap();
        std::fs::write(
            agents.join("reviewer.md"),
            "---\nname: reviewer\nmodel: haiku\neffort: high\n---\n",
        )
        .unwrap();
        let mut state = ClaudeSubagentState::new(&cwd);

        let event = state
            .normalize(launch(
                "toolu_1",
                json!({"subagent_type": "reviewer", "description": "Review"}),
            ))
            .await;
        assert!(event.assistant_message().is_some());
        let patch = &event.subagent_updates()[0].patch;
        assert_eq!(patch.model.as_deref(), Some("haiku"));
        assert!(!patch.model_resolved);
        assert_eq!(patch.reasoning_effort.as_deref(), Some("high"));

        // A task message carries its facts on a signal-only event that still
        // drives background-agent tracking.
        let event = state.normalize(started("a8f3c2", "toolu_1", true)).await;
        assert!(event.is_subagent_signal_only());
        assert!(event.background_agent_signal().is_some());
        assert_eq!(event.subagent_updates()[0].tool_use_id, "toolu_1");
    }
}
