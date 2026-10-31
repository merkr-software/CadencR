//! Provider-neutral sub-agent lifecycle signal.
//!
//! A sub-agent is a delegated agent the main agent launches through a
//! dispatch tool call (the "carrier": Claude Code's `Task`/`Agent`, Codex's
//! `spawn_agent`, OpenCode's `task`, Cursor's task tool). Adapters normalize
//! the carrier to a `Task`/`Agent` tool_use and describe the sub-agent with
//! [`RuntimeSubagentUpdate`] patches as facts become known: its configuration
//! at launch, the model it actually runs on, and its terminal status. The
//! shared stream reader merges the patches into the persisted sub-agent
//! registry, which is the single source of truth the desktop renders.

use serde_json::Value;

/// Dispatch tool names whose tool_use launches a sub-agent. Adapters map
/// their provider-native dispatch tool onto one of these.
pub const SUBAGENT_TOOL_NAMES: &[&str] = &["Task", "Agent"];

pub fn is_subagent_tool_name(name: &str) -> bool {
    SUBAGENT_TOOL_NAMES.contains(&name)
}

/// Why a sub-agent stopped: the registry's `status_reason` keys the desktop
/// labels (`REASON_LABEL` in `subagent-presentation.ts`).
pub mod stop_reason {
    /// The user or its parent interrupted it.
    pub const INTERRUPTED: &str = "interrupted";
    /// Its parent closed it, or the provider shut it down.
    pub const CLOSED: &str = "closed";
    /// The provider no longer knows it.
    pub const NOT_FOUND: &str = "not_found";
    /// The turn that waited on it failed.
    pub const TURN_FAILED: &str = "turn_failed";
    /// The runtime that ran it went away.
    pub const RUNTIME_ENDED: &str = "runtime_ended";
    /// The service stopped while it ran.
    pub const SERVICE_RESTARTED: &str = "service_restarted";
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RuntimeSubagentStatus {
    Running,
    Completed,
    Failed,
    /// Ended without completing: interrupted, cancelled, closed by its parent,
    /// or its runtime went away. `status_reason` says which.
    Stopped,
}

impl RuntimeSubagentStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Running => "running",
            Self::Completed => "completed",
            Self::Failed => "failed",
            Self::Stopped => "stopped",
        }
    }

    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "running" => Some(Self::Running),
            "completed" => Some(Self::Completed),
            "failed" => Some(Self::Failed),
            "stopped" => Some(Self::Stopped),
            _ => None,
        }
    }

    pub fn is_terminal(self) -> bool {
        self != Self::Running
    }
}

/// What changed about one sub-agent. `None` leaves a field as it was, so a
/// provider reports each fact when it learns it.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct RuntimeSubagentPatch {
    pub status: Option<RuntimeSubagentStatus>,
    /// Why the sub-agent stopped or failed (`interrupted`, an error message…).
    pub status_reason: Option<String>,
    /// Agent definition it runs (Claude `subagent_type`, Codex role, OpenCode agent).
    pub agent_type: Option<String>,
    /// Instance name when the provider gives one (Codex nickname, a named agent).
    pub agent_name: Option<String>,
    pub description: Option<String>,
    pub prompt: Option<String>,
    /// Requested or resolved model. See `model_resolved`.
    pub model: Option<String>,
    /// `true` when `model` is the model the sub-agent actually ran on rather
    /// than the alias it was asked for; a resolved model is never replaced by
    /// a requested one.
    pub model_resolved: bool,
    pub reasoning_effort: Option<String>,
    pub background: Option<bool>,
    /// Provider handle of the sub-agent's own session/thread, when it has one.
    pub child_session_id: Option<String>,
    pub duration_ms: Option<u64>,
    pub total_tokens: Option<u64>,
    pub tool_use_count: Option<u64>,
    /// Head of the sub-agent's final report or error.
    pub result_summary: Option<String>,
}

impl RuntimeSubagentPatch {
    pub fn status(status: RuntimeSubagentStatus) -> Self {
        Self {
            status: Some(status),
            ..Self::default()
        }
    }

    /// Stopped for `reason` (one of [`stop_reason`]).
    pub fn stopped(reason: &str) -> Self {
        Self {
            status: Some(RuntimeSubagentStatus::Stopped),
            status_reason: Some(reason.to_string()),
            ..Self::default()
        }
    }

    pub fn is_empty(&self) -> bool {
        self == &Self::default()
    }

    /// Configuration the dispatch tool's input carries. Reads the argument
    /// names providers use for the same concept, so every adapter that maps
    /// its dispatch tool onto `Task`/`Agent` gets the same metadata.
    pub fn from_tool_input(input: &Value) -> Self {
        let text = |keys: &[&str]| {
            keys.iter()
                .find_map(|key| input.get(*key).and_then(non_empty_str))
        };
        Self {
            agent_type: text(&[
                "subagent_type",
                "subagentType",
                "agent_type",
                "agentType",
                "role",
            ]),
            agent_name: text(&["name", "nickname", "task_name"]),
            description: text(&["description", "title"]),
            prompt: text(&["prompt", "message", "task"]),
            model: text(&["model"]).filter(|model| model != "inherit"),
            reasoning_effort: text(&["reasoning_effort", "reasoningEffort", "effort"]),
            background: ["run_in_background", "background", "isBackground"]
                .iter()
                .find_map(|key| input.get(*key).and_then(Value::as_bool)),
            ..Self::default()
        }
    }
}

/// One sub-agent fact, keyed by its carrier tool_use id.
#[derive(Debug, Clone, PartialEq)]
pub struct RuntimeSubagentUpdate {
    pub tool_use_id: String,
    pub patch: RuntimeSubagentPatch,
}

impl RuntimeSubagentUpdate {
    pub fn new(tool_use_id: impl Into<String>, patch: RuntimeSubagentPatch) -> Self {
        Self {
            tool_use_id: tool_use_id.into(),
            patch,
        }
    }
}

/// Trimmed head of a sub-agent's report for the registry's preview column.
pub fn summarize_subagent_result(text: &str) -> Option<String> {
    const MAX_CHARS: usize = 280;
    let trimmed = text.trim();
    if trimmed.is_empty() {
        return None;
    }
    let mut summary: String = trimmed.chars().take(MAX_CHARS).collect();
    if trimmed.chars().count() > MAX_CHARS {
        summary.push('…');
    }
    Some(summary)
}

/// The text of a sub-agent's result content: a string, or the text parts of
/// a content array.
pub fn subagent_result_text(content: &Value) -> String {
    match content {
        Value::String(text) => text.clone(),
        Value::Array(parts) => parts
            .iter()
            .filter_map(|part| part.get("text").and_then(Value::as_str))
            .collect::<Vec<_>>()
            .join("\n"),
        _ => String::new(),
    }
}

/// A JSON string, trimmed, when it says something.
pub fn non_empty_str(value: &Value) -> Option<String> {
    let text = value.as_str()?.trim();
    (!text.is_empty()).then(|| text.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn reads_claude_agent_tool_input() {
        let patch = RuntimeSubagentPatch::from_tool_input(&json!({
            "description": "Audit codex",
            "prompt": "Look at the codex adapter",
            "subagent_type": "Explore",
            "model": "haiku",
            "run_in_background": true
        }));
        assert_eq!(patch.agent_type.as_deref(), Some("Explore"));
        assert_eq!(patch.description.as_deref(), Some("Audit codex"));
        assert_eq!(patch.prompt.as_deref(), Some("Look at the codex adapter"));
        assert_eq!(patch.model.as_deref(), Some("haiku"));
        assert!(!patch.model_resolved);
        assert_eq!(patch.background, Some(true));
        assert_eq!(patch.status, None);
    }

    #[test]
    fn reads_camel_case_and_ignores_inherit_and_blanks() {
        let patch = RuntimeSubagentPatch::from_tool_input(&json!({
            "subagentType": "reviewer",
            "model": "inherit",
            "description": "   ",
            "reasoningEffort": "high"
        }));
        assert_eq!(patch.agent_type.as_deref(), Some("reviewer"));
        assert_eq!(patch.model, None);
        assert_eq!(patch.description, None);
        assert_eq!(patch.reasoning_effort.as_deref(), Some("high"));
    }

    #[test]
    fn summary_trims_and_caps() {
        assert_eq!(summarize_subagent_result("  \n "), None);
        let long = "x".repeat(400);
        let summary = summarize_subagent_result(&long).unwrap();
        assert_eq!(summary.chars().count(), 281);
        assert!(summary.ends_with('…'));
    }

    #[test]
    fn status_round_trips() {
        for status in [
            RuntimeSubagentStatus::Running,
            RuntimeSubagentStatus::Completed,
            RuntimeSubagentStatus::Failed,
            RuntimeSubagentStatus::Stopped,
        ] {
            assert_eq!(RuntimeSubagentStatus::parse(status.as_str()), Some(status));
        }
        assert!(!RuntimeSubagentStatus::Running.is_terminal());
        assert!(RuntimeSubagentStatus::Stopped.is_terminal());
    }
}
