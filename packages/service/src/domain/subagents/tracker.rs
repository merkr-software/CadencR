//! Provider-neutral sub-agent facts read off one stream's runtime events.
//!
//! What every provider's normalized stream shows the same way is derived
//! here: a `Task`/`Agent` tool_use launches a sub-agent with the
//! configuration its input names, a child assistant message reveals the
//! model it runs on, and the carrier's tool_result ends it. Adapters add
//! what only their protocol knows (background launches, progress, the real
//! terminal status) as `RuntimeSubagentUpdate`s, applied after the derived
//! facts so a provider always has the last word.

use std::collections::HashMap;

use super::repository::SubagentChange;
use crate::domain::agents::adapter::{
    is_subagent_tool_name, subagent_result_text, summarize_subagent_result, RuntimeContentBlock,
    RuntimeEvent, RuntimeStreamEvent, RuntimeSubagentPatch, RuntimeSubagentStatus,
    RuntimeUserContentBlock,
};

#[derive(Debug, Default, Clone, Copy)]
struct CarrierState {
    terminal: bool,
    model_resolved: bool,
}

#[derive(Debug, Default)]
pub struct SubagentTracker {
    carriers: HashMap<String, CarrierState>,
}

impl SubagentTracker {
    /// Carriers this runtime launched or settled that have not ended: what
    /// dies with it.
    pub fn live_tool_use_ids(&self) -> Vec<String> {
        self.carriers
            .iter()
            .filter(|(_, state)| !state.terminal)
            .map(|(id, _)| id.clone())
            .collect()
    }

    /// Whether this runtime has launched or settled any sub-agent yet.
    pub fn has_carriers(&self) -> bool {
        !self.carriers.is_empty()
    }

    pub fn observe(&mut self, event: &RuntimeEvent) -> Vec<SubagentChange> {
        let parent = event.parent_tool_use_id().map(str::to_string);
        let mut changes = Vec::new();
        if let Some(RuntimeStreamEvent::ContentBlockStart { block, .. }) = event.stream_event() {
            self.observe_launch(block, &parent, &mut changes);
        }
        if let Some(message) = event.assistant_message() {
            for block in &message.content {
                self.observe_launch(block, &parent, &mut changes);
            }
            self.observe_child_model(parent.as_deref(), message.model.as_deref(), &mut changes);
        }
        if let Some(message) = event.user_message() {
            for block in &message.content {
                self.observe_result(block, &mut changes);
            }
        }
        changes.extend(
            event
                .subagent_updates()
                .iter()
                .map(|update| SubagentChange {
                    tool_use_id: update.tool_use_id.clone(),
                    parent_tool_use_id: None,
                    patch: update.patch.clone(),
                }),
        );
        let changes = coalesce(changes);
        for change in &changes {
            self.record(change);
        }
        changes
    }

    /// Note a change decided outside `observe` (a turn-end sweep).
    pub fn record(&mut self, change: &SubagentChange) {
        let state = self.carriers.entry(change.tool_use_id.clone()).or_default();
        if let Some(status) = change.patch.status {
            state.terminal = status.is_terminal();
        }
        state.model_resolved |= change.patch.model_resolved;
    }

    fn observe_launch(
        &mut self,
        block: &RuntimeContentBlock,
        parent: &Option<String>,
        changes: &mut Vec<SubagentChange>,
    ) {
        let RuntimeContentBlock::ToolUse { id, name, input } = block else {
            return;
        };
        if !is_subagent_tool_name(name) {
            return;
        }
        let mut patch = RuntimeSubagentPatch::from_tool_input(input);
        if !self.carriers.contains_key(id) {
            patch.status = Some(RuntimeSubagentStatus::Running);
        } else if patch.is_empty() {
            return;
        }
        changes.push(SubagentChange {
            tool_use_id: id.clone(),
            parent_tool_use_id: parent.clone(),
            patch,
        });
    }

    fn observe_child_model(
        &self,
        parent: Option<&str>,
        model: Option<&str>,
        changes: &mut Vec<SubagentChange>,
    ) {
        let (Some(parent), Some(model)) = (parent, model) else {
            return;
        };
        let Some(state) = self.carriers.get(parent) else {
            return;
        };
        if state.model_resolved || model.trim().is_empty() {
            return;
        }
        changes.push(SubagentChange {
            tool_use_id: parent.to_string(),
            parent_tool_use_id: None,
            patch: RuntimeSubagentPatch {
                model: Some(model.to_string()),
                model_resolved: true,
                ..RuntimeSubagentPatch::default()
            },
        });
    }

    fn observe_result(&self, block: &RuntimeUserContentBlock, changes: &mut Vec<SubagentChange>) {
        let RuntimeUserContentBlock::ToolResult {
            tool_use_id: Some(id),
            is_error,
            content,
        } = block
        else {
            return;
        };
        if !self.carriers.get(id).is_some_and(|state| !state.terminal) {
            return;
        }
        let status = if *is_error {
            RuntimeSubagentStatus::Failed
        } else {
            RuntimeSubagentStatus::Completed
        };
        changes.push(SubagentChange {
            tool_use_id: id.clone(),
            parent_tool_use_id: None,
            patch: RuntimeSubagentPatch {
                status: Some(status),
                result_summary: summarize_subagent_result(&subagent_result_text(content)),
                ..RuntimeSubagentPatch::default()
            },
        });
    }
}

/// One change per sub-agent, later facts overriding earlier ones, so a
/// provider's correction in the same event never shows as a flicker.
fn coalesce(changes: Vec<SubagentChange>) -> Vec<SubagentChange> {
    let mut merged: Vec<SubagentChange> = Vec::with_capacity(changes.len());
    for change in changes {
        match merged
            .iter_mut()
            .find(|existing| existing.tool_use_id == change.tool_use_id)
        {
            Some(existing) => {
                existing.parent_tool_use_id = existing
                    .parent_tool_use_id
                    .take()
                    .or(change.parent_tool_use_id);
                overlay(&mut existing.patch, change.patch);
            }
            None => merged.push(change),
        }
    }
    for change in &mut merged {
        // A sub-agent still running has no result yet (a launch ack is not one).
        if change.patch.status == Some(RuntimeSubagentStatus::Running) {
            change.patch.result_summary = None;
        }
    }
    merged
}

fn overlay(base: &mut RuntimeSubagentPatch, top: RuntimeSubagentPatch) {
    macro_rules! take {
        ($($field:ident),*) => { $( if top.$field.is_some() { base.$field = top.$field; } )* };
    }
    take!(
        status,
        status_reason,
        agent_type,
        agent_name,
        description,
        prompt,
        reasoning_effort,
        background,
        child_session_id,
        duration_ms,
        total_tokens,
        tool_use_count,
        result_summary
    );
    if top.model.is_some() && (top.model_resolved || !base.model_resolved) {
        base.model = top.model;
        base.model_resolved = top.model_resolved;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::agents::adapter::{
        RuntimeAssistantMessage, RuntimeEventKind, RuntimeEventMetadata, RuntimeSubagentUpdate,
        RuntimeUserMessage,
    };
    use serde_json::{json, Value};

    fn assistant(
        parent: Option<&str>,
        model: Option<&str>,
        content: Vec<RuntimeContentBlock>,
    ) -> RuntimeEvent {
        RuntimeEvent::new(
            RuntimeEventMetadata::default(),
            RuntimeEventKind::AssistantMessage {
                message: RuntimeAssistantMessage {
                    model: model.map(str::to_string),
                    content,
                },
                parent_tool_use_id: parent.map(str::to_string),
            },
        )
    }

    fn carrier(id: &str, input: Value) -> RuntimeContentBlock {
        RuntimeContentBlock::ToolUse {
            id: id.into(),
            name: "Agent".into(),
            input,
        }
    }

    fn result(id: &str, is_error: bool, content: Value) -> RuntimeEvent {
        RuntimeEvent::new(
            RuntimeEventMetadata::default(),
            RuntimeEventKind::UserMessage {
                message: RuntimeUserMessage {
                    content: vec![RuntimeUserContentBlock::ToolResult {
                        tool_use_id: Some(id.into()),
                        is_error,
                        content,
                    }],
                },
                parent_tool_use_id: None,
            },
        )
    }

    #[test]
    fn launch_then_model_then_result() {
        let mut tracker = SubagentTracker::default();
        let launch = tracker.observe(&assistant(
            None,
            Some("claude-opus-5-5"),
            vec![carrier(
                "a1",
                json!({"description": "Audit", "model": "haiku"}),
            )],
        ));
        assert_eq!(launch.len(), 1);
        assert_eq!(launch[0].patch.status, Some(RuntimeSubagentStatus::Running));
        assert_eq!(launch[0].patch.model.as_deref(), Some("haiku"));

        let model = tracker.observe(&assistant(Some("a1"), Some("claude-haiku-5-5"), vec![]));
        assert_eq!(model[0].patch.model.as_deref(), Some("claude-haiku-5-5"));
        assert!(model[0].patch.model_resolved);
        assert!(tracker
            .observe(&assistant(Some("a1"), Some("claude-haiku-5-5"), vec![]))
            .is_empty());

        let done = tracker.observe(&result(
            "a1",
            false,
            json!([{"type": "text", "text": "Found 3 issues"}]),
        ));
        assert_eq!(done[0].patch.status, Some(RuntimeSubagentStatus::Completed));
        assert_eq!(
            done[0].patch.result_summary.as_deref(),
            Some("Found 3 issues")
        );
        assert!(tracker
            .observe(&result("a1", false, json!("again")))
            .is_empty());
    }

    #[test]
    fn ignores_results_of_ordinary_tools_and_marks_errors_failed() {
        let mut tracker = SubagentTracker::default();
        assert!(tracker
            .observe(&result("bash-1", false, json!("ok")))
            .is_empty());
        tracker.observe(&assistant(None, None, vec![carrier("a2", json!({}))]));
        assert_eq!(tracker.live_tool_use_ids(), vec!["a2".to_string()]);
        let failed = tracker.observe(&result("a2", true, json!("boom")));
        assert_eq!(failed[0].patch.status, Some(RuntimeSubagentStatus::Failed));
        assert!(tracker.live_tool_use_ids().is_empty());
    }

    #[test]
    fn provider_update_in_the_same_event_wins_without_flicker() {
        let mut tracker = SubagentTracker::default();
        tracker.observe(&assistant(None, None, vec![carrier("bg", json!({}))]));
        let ack = result("bg", false, json!("Async agent launched")).with_subagent_updates(vec![
            RuntimeSubagentUpdate::new(
                "bg",
                RuntimeSubagentPatch {
                    status: Some(RuntimeSubagentStatus::Running),
                    background: Some(true),
                    result_summary: None,
                    ..RuntimeSubagentPatch::default()
                },
            ),
        ]);
        let changes = tracker.observe(&ack);
        assert_eq!(changes.len(), 1);
        assert_eq!(
            changes[0].patch.status,
            Some(RuntimeSubagentStatus::Running)
        );
        assert_eq!(changes[0].patch.background, Some(true));
        // Still running, so its later real result completes it.
        let done = tracker.observe(&result("bg", false, json!("report")));
        assert_eq!(done[0].patch.status, Some(RuntimeSubagentStatus::Completed));
    }

    #[test]
    fn nested_launch_keeps_its_parent() {
        let mut tracker = SubagentTracker::default();
        let changes = tracker.observe(&assistant(
            Some("outer"),
            None,
            vec![carrier("inner", json!({}))],
        ));
        assert_eq!(changes[0].parent_tool_use_id.as_deref(), Some("outer"));
    }
}
