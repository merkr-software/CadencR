use std::collections::HashSet;

use crate::domain::agents::adapter::{RuntimeContentBlock, RuntimeEvent, RuntimeUserContentBlock};

/// Names of dispatch tools that spawn a sub-agent inside the same runtime
/// session. Provider-neutral: Claude Code uses `Task`, OpenCode uses `Agent`.
pub(super) const SUBAGENT_TOOL_NAMES: &[&str] = &["Task", "Agent"];

/// Tracks in-flight sub-agent dispatch calls (`Task` / `Agent` tool_use ids).
///
/// Claude Code Task sub-agents reuse the parent's `session_id`, and the CLI
/// does not consistently set `parent_tool_use_id` on every sub-agent
/// `stream_event` (notably `MessageStart`). Without this set the leaked
/// frames overwrite the root snapshot's `input_tokens` with the sub-agent's
/// much larger value, inflating the `ContextUsageBar` to ~100% even when the
/// root has barely used any context.
#[derive(Debug, Default)]
pub(super) struct SubagentWindow {
    active: HashSet<String>,
}

impl SubagentWindow {
    pub(super) fn new() -> Self {
        Self::default()
    }

    pub(super) fn is_active(&self) -> bool {
        !self.active.is_empty()
    }

    /// Walks a root assistant message for `Task`/`Agent` tool_use blocks and
    /// records each id. Skips events that already belong to a sub-agent
    /// (`parent_tool_use_id.is_some()`) so a nested sub-agent's tool_use
    /// can't pollute the root window.
    pub(super) fn record_starts(&mut self, runtime_event: &RuntimeEvent) {
        if runtime_event.parent_tool_use_id().is_some() {
            return;
        }
        let Some(msg) = runtime_event.assistant_message() else {
            return;
        };
        for block in &msg.content {
            if let RuntimeContentBlock::ToolUse { id, name, .. } = block {
                if SUBAGENT_TOOL_NAMES.contains(&name.as_str()) {
                    self.active.insert(id.clone());
                }
            }
        }
    }

    /// Walks a user message for tool_result blocks and removes any id it
    /// closes. We intentionally do NOT require `parent_tool_use_id` to be
    /// absent because some provider transcripts attach it to the root close
    /// event; if we skip that event, the fallback window can get stuck open.
    pub(super) fn record_ends(&mut self, runtime_event: &RuntimeEvent) {
        if self.active.is_empty() {
            return;
        }
        let Some(msg) = runtime_event.user_message() else {
            return;
        };
        for block in &msg.content {
            if let RuntimeUserContentBlock::ToolResult {
                tool_use_id: Some(id),
                ..
            } = block
            {
                self.active.remove(id);
            }
        }
    }

    /// Returns true if the event is the root carrier of a Task/Agent
    /// tool_use (assistant) or a tool_result that closes one (user). The
    /// classifier exempts these from sub-agent filtering so the root's own
    /// turn boundary still updates the snapshot.
    ///
    /// An event is either an assistant or user message, never both — only
    /// one branch fires per call.
    pub(super) fn carries_lifecycle_block(&self, runtime_event: &RuntimeEvent) -> bool {
        if let Some(msg) = runtime_event.assistant_message() {
            return msg.content.iter().any(|block| {
                matches!(
                    block,
                    RuntimeContentBlock::ToolUse { name, .. }
                        if SUBAGENT_TOOL_NAMES.contains(&name.as_str())
                )
            });
        }
        if let Some(msg) = runtime_event.user_message() {
            return msg.content.iter().any(|block| {
                matches!(
                    block,
                    RuntimeUserContentBlock::ToolResult { tool_use_id: Some(id), .. }
                        if self.active.contains(id)
                )
            });
        }
        false
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::SubagentWindow;
    use crate::domain::agents::adapter::{
        RuntimeAssistantMessage, RuntimeContentBlock, RuntimeEvent, RuntimeEventKind,
        RuntimeEventMetadata, RuntimeUserContentBlock, RuntimeUserMessage,
    };

    fn assistant_with_tool_use(
        tool_use_id: &str,
        name: &str,
        parent_tool_use_id: Option<&str>,
    ) -> RuntimeEvent {
        RuntimeEvent::new(
            RuntimeEventMetadata {
                session_id: Some("root-1".into()),
                usage: None,
                context_window: None,
                raw: json!({ "type": "assistant" }),
            },
            RuntimeEventKind::AssistantMessage {
                message: RuntimeAssistantMessage {
                    model: None,
                    content: vec![RuntimeContentBlock::ToolUse {
                        id: tool_use_id.into(),
                        name: name.into(),
                        input: json!({}),
                    }],
                },
                parent_tool_use_id: parent_tool_use_id.map(ToOwned::to_owned),
            },
        )
    }

    fn user_with_tool_result(tool_use_id: &str) -> RuntimeEvent {
        RuntimeEvent::new(
            RuntimeEventMetadata {
                session_id: Some("root-1".into()),
                usage: None,
                context_window: None,
                raw: json!({ "type": "user" }),
            },
            RuntimeEventKind::UserMessage {
                message: RuntimeUserMessage {
                    content: vec![RuntimeUserContentBlock::ToolResult {
                        tool_use_id: Some(tool_use_id.into()),
                        is_error: false,
                        content: json!("ok"),
                    }],
                },
                parent_tool_use_id: None,
            },
        )
    }

    #[test]
    fn record_starts_inserts_task_tool_use() {
        let mut win = SubagentWindow::new();
        win.record_starts(&assistant_with_tool_use("toolu_1", "Task", None));
        assert!(win.is_active());
    }

    #[test]
    fn record_starts_inserts_agent_tool_use() {
        let mut win = SubagentWindow::new();
        win.record_starts(&assistant_with_tool_use("toolu_2", "Agent", None));
        assert!(win.is_active());
    }

    #[test]
    fn record_starts_ignores_subagent_messages() {
        // A nested tool_use inside a sub-agent's own assistant message must
        // not be added to the root window.
        let mut win = SubagentWindow::new();
        win.record_starts(&assistant_with_tool_use(
            "toolu_nested",
            "Task",
            Some("toolu_outer"),
        ));
        assert!(!win.is_active());
    }

    #[test]
    fn record_ends_removes_matching_id() {
        let mut win = SubagentWindow::new();
        win.record_starts(&assistant_with_tool_use("toolu_1", "Task", None));
        win.record_ends(&user_with_tool_result("toolu_1"));
        assert!(!win.is_active());
    }

    #[test]
    fn carries_lifecycle_block_detects_task_tool_use() {
        let win = SubagentWindow::new();
        assert!(win.carries_lifecycle_block(&assistant_with_tool_use("toolu_1", "Task", None)));
    }

    #[test]
    fn carries_lifecycle_block_only_detects_active_tool_results() {
        let mut win = SubagentWindow::new();
        // Tool_result for an unknown id is NOT a lifecycle close.
        assert!(!win.carries_lifecycle_block(&user_with_tool_result("toolu_unknown")));

        win.record_starts(&assistant_with_tool_use("toolu_1", "Task", None));
        assert!(win.carries_lifecycle_block(&user_with_tool_result("toolu_1")));
    }

    #[test]
    fn record_ends_accepts_tool_result_with_parent_tool_use_id() {
        let mut win = SubagentWindow::new();
        win.record_starts(&assistant_with_tool_use("toolu_1", "Task", None));
        let event = RuntimeEvent::new(
            RuntimeEventMetadata {
                session_id: Some("root-1".into()),
                usage: None,
                context_window: None,
                raw: json!({ "type": "user" }),
            },
            RuntimeEventKind::UserMessage {
                message: RuntimeUserMessage {
                    content: vec![RuntimeUserContentBlock::ToolResult {
                        tool_use_id: Some("toolu_1".into()),
                        is_error: false,
                        content: json!("ok"),
                    }],
                },
                parent_tool_use_id: Some("toolu_1".into()),
            },
        );

        win.record_ends(&event);
        assert!(!win.is_active());
    }

    #[test]
    fn nested_tool_uses_require_all_to_close() {
        let mut win = SubagentWindow::new();
        win.record_starts(&assistant_with_tool_use("toolu_1", "Task", None));
        win.record_starts(&assistant_with_tool_use("toolu_2", "Task", None));
        assert!(win.is_active());
        win.record_ends(&user_with_tool_result("toolu_1"));
        assert!(win.is_active());
        win.record_ends(&user_with_tool_result("toolu_2"));
        assert!(!win.is_active());
    }
}
