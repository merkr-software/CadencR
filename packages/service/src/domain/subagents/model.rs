//! Sub-agent run record and the pure rules that fold a patch into it.

use serde::{Deserialize, Serialize};

use crate::domain::agents::adapter::{RuntimeSubagentPatch, RuntimeSubagentStatus};

/// Longest prompt kept per run; the transcript keeps the carrier's full input.
const MAX_PROMPT_CHARS: usize = 16_000;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, utoipa::ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum SubagentRunStatus {
    Running,
    Completed,
    Failed,
    Stopped,
}

impl From<RuntimeSubagentStatus> for SubagentRunStatus {
    fn from(status: RuntimeSubagentStatus) -> Self {
        match status {
            RuntimeSubagentStatus::Running => Self::Running,
            RuntimeSubagentStatus::Completed => Self::Completed,
            RuntimeSubagentStatus::Failed => Self::Failed,
            RuntimeSubagentStatus::Stopped => Self::Stopped,
        }
    }
}

impl SubagentRunStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Running => "running",
            Self::Completed => "completed",
            Self::Failed => "failed",
            Self::Stopped => "stopped",
        }
    }

    pub fn parse(value: &str) -> Option<Self> {
        RuntimeSubagentStatus::parse(value).map(Self::from)
    }

    pub fn is_terminal(self) -> bool {
        self != Self::Running
    }
}

/// One sub-agent as the desktop renders it: the transcript's sub-agent card
/// for its carrier. `action_count` is observed by Cadencr from the
/// sub-agent's transcript; every other field is a provider fact.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, utoipa::ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct SubagentRun {
    pub session_id: i64,
    /// The carrier tool_use id: joins the run to its transcript block.
    pub tool_use_id: String,
    /// Carrier of the sub-agent that launched this one, when nested.
    pub parent_tool_use_id: Option<String>,
    pub status: SubagentRunStatus,
    pub status_reason: Option<String>,
    pub agent_type: Option<String>,
    pub agent_name: Option<String>,
    pub description: Option<String>,
    pub prompt: Option<String>,
    pub model: Option<String>,
    /// `model` is what the sub-agent ran on, not just what it was asked to use.
    pub model_resolved: bool,
    pub reasoning_effort: Option<String>,
    pub background: bool,
    pub child_session_id: Option<String>,
    pub duration_ms: Option<i64>,
    pub total_tokens: Option<i64>,
    /// Tool calls the provider reports the sub-agent made.
    pub tool_use_count: Option<i64>,
    pub result_summary: Option<String>,
    pub started_at: String,
    pub ended_at: Option<String>,
    /// Tool calls Cadencr saw in the sub-agent's transcript.
    pub action_count: Option<i64>,
}

#[bon::bon]
impl SubagentRun {
    /// A run first seen now. Launch facts come from the first patch.
    #[builder]
    pub fn launched(
        session_id: i64,
        tool_use_id: &str,
        parent_tool_use_id: Option<&str>,
        now: &str,
    ) -> Self {
        Self {
            session_id,
            tool_use_id: tool_use_id.to_string(),
            parent_tool_use_id: parent_tool_use_id.map(str::to_string),
            status: SubagentRunStatus::Running,
            status_reason: None,
            agent_type: None,
            agent_name: None,
            description: None,
            prompt: None,
            model: None,
            model_resolved: false,
            reasoning_effort: None,
            background: false,
            child_session_id: None,
            duration_ms: None,
            total_tokens: None,
            tool_use_count: None,
            result_summary: None,
            started_at: now.to_string(),
            ended_at: None,
            action_count: None,
        }
    }

    /// Fold `patch` in. Returns whether anything the desktop shows changed.
    pub fn apply(&mut self, patch: &RuntimeSubagentPatch, now: &str) -> bool {
        let before = self.clone();
        if let Some(status) = patch.status.map(SubagentRunStatus::from) {
            self.transition(status, now);
        }
        set_text(&mut self.status_reason, &patch.status_reason);
        set_text(&mut self.agent_type, &patch.agent_type);
        set_text(&mut self.agent_name, &patch.agent_name);
        set_text(&mut self.description, &patch.description);
        let prompt = patch
            .prompt
            .as_ref()
            .map(|prompt| prompt.chars().take(MAX_PROMPT_CHARS).collect());
        set_text(&mut self.prompt, &prompt);
        self.apply_model(patch);
        set_text(&mut self.reasoning_effort, &patch.reasoning_effort);
        if let Some(background) = patch.background {
            self.background = background;
        }
        set_text(&mut self.child_session_id, &patch.child_session_id);
        set_count(&mut self.duration_ms, patch.duration_ms);
        set_count(&mut self.total_tokens, patch.total_tokens);
        set_count(&mut self.tool_use_count, patch.tool_use_count);
        set_text(&mut self.result_summary, &patch.result_summary);
        *self != before
    }

    fn transition(&mut self, status: SubagentRunStatus, now: &str) {
        if status == self.status {
            return;
        }
        self.status = status;
        if status.is_terminal() {
            self.ended_at.get_or_insert_with(|| now.to_string());
            if self.duration_ms.is_none() {
                self.duration_ms = elapsed_ms(&self.started_at, now);
            }
        } else {
            // Resumed (Codex `send_input` / follow-up): it runs again.
            self.ended_at = None;
            self.status_reason = None;
            self.duration_ms = None;
            self.result_summary = None;
        }
    }

    fn apply_model(&mut self, patch: &RuntimeSubagentPatch) {
        let Some(model) = &patch.model else { return };
        // A requested alias never replaces the model it actually ran on.
        if self.model_resolved && !patch.model_resolved {
            return;
        }
        self.model = Some(model.clone());
        self.model_resolved |= patch.model_resolved;
    }
}

fn set_text(slot: &mut Option<String>, value: &Option<String>) {
    if let Some(value) = value {
        *slot = Some(value.clone());
    }
}

fn set_count(slot: &mut Option<i64>, value: Option<u64>) {
    if let Some(value) = value {
        *slot = Some(i64::try_from(value).unwrap_or(i64::MAX));
    }
}

pub fn now_timestamp() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

fn elapsed_ms(started_at: &str, now: &str) -> Option<i64> {
    let start = chrono::DateTime::parse_from_rfc3339(started_at).ok()?;
    let end = chrono::DateTime::parse_from_rfc3339(now).ok()?;
    Some((end - start).num_milliseconds().max(0))
}

#[cfg(test)]
mod tests {
    use super::*;

    const T0: &str = "2026-10-30T10:00:00.000Z";
    const T1: &str = "2026-10-30T10:00:42.500Z";

    fn run() -> SubagentRun {
        SubagentRun::launched()
            .session_id(7)
            .tool_use_id("toolu_1")
            .now(T0)
            .call()
    }

    #[test]
    fn terminal_status_stamps_end_and_duration() {
        let mut run = run();
        assert!(run.apply(
            &RuntimeSubagentPatch::status(RuntimeSubagentStatus::Completed),
            T1
        ));
        assert_eq!(run.status, SubagentRunStatus::Completed);
        assert_eq!(run.ended_at.as_deref(), Some(T1));
        assert_eq!(run.duration_ms, Some(42_500));
    }

    #[test]
    fn provider_duration_wins_over_wall_clock() {
        let mut run = run();
        let patch = RuntimeSubagentPatch {
            status: Some(RuntimeSubagentStatus::Completed),
            duration_ms: Some(1_000),
            ..RuntimeSubagentPatch::default()
        };
        run.apply(&patch, T1);
        assert_eq!(run.duration_ms, Some(1_000));
    }

    #[test]
    fn resuming_clears_the_end() {
        let mut run = run();
        run.apply(
            &RuntimeSubagentPatch {
                status: Some(RuntimeSubagentStatus::Stopped),
                status_reason: Some("interrupted".into()),
                ..RuntimeSubagentPatch::default()
            },
            T1,
        );
        run.apply(
            &RuntimeSubagentPatch::status(RuntimeSubagentStatus::Running),
            T1,
        );
        assert_eq!(run.status, SubagentRunStatus::Running);
        assert_eq!(run.ended_at, None);
        assert_eq!(run.status_reason, None);
        assert_eq!(run.duration_ms, None);
    }

    #[test]
    fn requested_alias_never_replaces_resolved_model() {
        let mut run = run();
        run.apply(
            &RuntimeSubagentPatch {
                model: Some("claude-haiku-5-5".into()),
                model_resolved: true,
                ..RuntimeSubagentPatch::default()
            },
            T1,
        );
        let changed = run.apply(
            &RuntimeSubagentPatch {
                model: Some("haiku".into()),
                ..RuntimeSubagentPatch::default()
            },
            T1,
        );
        assert!(!changed);
        assert_eq!(run.model.as_deref(), Some("claude-haiku-5-5"));
        assert!(run.model_resolved);
    }

    #[test]
    fn empty_patch_changes_nothing() {
        let mut run = run();
        assert!(!run.apply(&RuntimeSubagentPatch::default(), T1));
    }

    #[test]
    fn prompt_is_capped() {
        let mut run = run();
        run.apply(
            &RuntimeSubagentPatch {
                prompt: Some("p".repeat(MAX_PROMPT_CHARS + 10)),
                ..RuntimeSubagentPatch::default()
            },
            T1,
        );
        assert_eq!(run.prompt.unwrap().chars().count(), MAX_PROMPT_CHARS);
    }
}
