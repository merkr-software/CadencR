//! An archive and its optional cleanup, orchestrated by the service in one
//! call: the Archive dialog (`POST /api/features/{id}/archive`) and the agents'
//! `project_archive_session` tool both go through [`runner::archive_with_cleanup`].
//!
//! The cleanup is durable. Its steps are planned in the archive's own
//! transaction (`journal`) and each outcome is written as soon as it settles,
//! so a cleanup cut short by a crash, a restart or a closed window is still
//! known afterwards: startup marks its unsettled steps `interrupted`, and the
//! user resumes them (`POST /api/features/{id}/archive-cleanup/retry`). Every
//! change is pushed to clients as `app/archive_cleanup`.

use serde::{Deserialize, Serialize};
use utoipa::ToSchema;

pub mod journal;
pub mod routes;
pub mod runner;
mod steps;

/// The dialog's cleanup checkboxes, plus the force the user confirmed
/// (`ArchiveRequest::cleanup`).
#[derive(Debug, Default, Clone)]
pub struct CleanupSelection {
    pub kill_terminals: bool,
    pub close_browser_tabs: bool,
    pub remove_worktree: bool,
    pub remove_branch: bool,
    pub force_remove_worktree: bool,
    pub force_remove_branch: bool,
}

/// The cleanup steps, in run order.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StepName {
    Terminals,
    BrowserTabs,
    Worktree,
    Branch,
}

impl StepName {
    pub const ALL: [StepName; 4] = [
        StepName::Terminals,
        StepName::BrowserTabs,
        StepName::Worktree,
        StepName::Branch,
    ];

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Terminals => "terminals",
            Self::BrowserTabs => "browser_tabs",
            Self::Worktree => "worktree",
            Self::Branch => "branch",
        }
    }

    pub fn parse(value: &str) -> Option<Self> {
        Self::ALL.into_iter().find(|step| step.as_str() == value)
    }

    fn position(self) -> i64 {
        Self::ALL.iter().position(|step| *step == self).unwrap_or(0) as i64
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum StepStatus {
    /// Planned, or waiting on something else (the desktop app, the worktree).
    Pending,
    Running,
    /// Was pending or running when the service stopped: resume it.
    Interrupted,
    Done,
    /// Nothing to do, or the option doesn't apply to this conversation.
    Skipped,
    /// Refused to lose work (uncommitted changes, unmerged commits): only
    /// forcing it goes further.
    Blocked,
    Failed,
}

impl StepStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Pending => "pending",
            Self::Running => "running",
            Self::Interrupted => "interrupted",
            Self::Done => "done",
            Self::Skipped => "skipped",
            Self::Blocked => "blocked",
            Self::Failed => "failed",
        }
    }

    pub fn parse(value: &str) -> Option<Self> {
        [
            Self::Pending,
            Self::Running,
            Self::Interrupted,
            Self::Done,
            Self::Skipped,
            Self::Blocked,
            Self::Failed,
        ]
        .into_iter()
        .find(|status| status.as_str() == value)
    }

    pub fn is_settled(self) -> bool {
        matches!(self, Self::Done | Self::Skipped)
    }
}

/// One step's state. `reason` is a skip explanation, a blocked code
/// (`dirty_worktree`, `unmerged_branch`) or what a pending step waits on.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, ToSchema)]
pub struct StepOutcome {
    pub status: StepStatus,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
}

impl StepOutcome {
    fn with(status: StepStatus) -> Self {
        Self {
            status,
            reason: None,
            message: None,
            detail: None,
        }
    }

    pub fn pending(reason: Option<String>) -> Self {
        Self {
            reason,
            ..Self::with(StepStatus::Pending)
        }
    }

    pub fn running() -> Self {
        Self::with(StepStatus::Running)
    }

    pub fn done(detail: Option<String>) -> Self {
        Self {
            detail,
            ..Self::with(StepStatus::Done)
        }
    }

    pub fn skipped(reason: impl Into<String>) -> Self {
        Self {
            reason: Some(reason.into()),
            ..Self::with(StepStatus::Skipped)
        }
    }

    pub fn blocked(reason: String, message: String) -> Self {
        Self {
            reason: Some(reason),
            message: Some(message),
            ..Self::with(StepStatus::Blocked)
        }
    }

    pub fn failed(message: impl Into<String>) -> Self {
        Self {
            message: Some(message.into()),
            ..Self::with(StepStatus::Failed)
        }
    }
}

/// One entry per step that was asked for; absent steps were not requested.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, ToSchema)]
pub struct CleanupReport {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub terminals: Option<StepOutcome>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub browser_tabs: Option<StepOutcome>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub worktree: Option<StepOutcome>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub branch: Option<StepOutcome>,
}

impl CleanupReport {
    pub fn get(&self, step: StepName) -> Option<&StepOutcome> {
        match step {
            StepName::Terminals => self.terminals.as_ref(),
            StepName::BrowserTabs => self.browser_tabs.as_ref(),
            StepName::Worktree => self.worktree.as_ref(),
            StepName::Branch => self.branch.as_ref(),
        }
    }

    pub fn slot(&mut self, step: StepName) -> &mut Option<StepOutcome> {
        match step {
            StepName::Terminals => &mut self.terminals,
            StepName::BrowserTabs => &mut self.browser_tabs,
            StepName::Worktree => &mut self.worktree,
            StepName::Branch => &mut self.branch,
        }
    }

    /// Every requested step is done or had nothing to do.
    pub fn is_settled(&self) -> bool {
        StepName::ALL
            .into_iter()
            .filter_map(|step| self.get(step))
            .all(|outcome| outcome.status.is_settled())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_step_serializes_as_the_tagged_report_agents_already_read() {
        let value = serde_json::to_value(StepOutcome::blocked(
            "dirty_worktree".into(),
            "Worktree has uncommitted or untracked changes".into(),
        ))
        .unwrap();
        assert_eq!(
            value,
            serde_json::json!({
                "status": "blocked",
                "reason": "dirty_worktree",
                "message": "Worktree has uncommitted or untracked changes"
            })
        );
        let done = serde_json::to_value(StepOutcome::done(None)).unwrap();
        assert_eq!(done, serde_json::json!({ "status": "done" }));
    }

    #[test]
    fn a_report_is_settled_only_when_every_requested_step_is_done_or_skipped() {
        let mut report = CleanupReport::default();
        assert!(report.is_settled());
        report.terminals = Some(StepOutcome::done(None));
        report.worktree = Some(StepOutcome::skipped("No worktree"));
        assert!(report.is_settled());
        report.branch = Some(StepOutcome::pending(None));
        assert!(!report.is_settled());
        *report.slot(StepName::Branch) = Some(StepOutcome::failed("boom"));
        assert!(!report.is_settled());
    }

    #[test]
    fn step_and_status_names_round_trip() {
        for step in StepName::ALL {
            assert_eq!(StepName::parse(step.as_str()), Some(step));
        }
        assert_eq!(
            StepStatus::parse("interrupted"),
            Some(StepStatus::Interrupted)
        );
        assert_eq!(StepStatus::parse("nope"), None);
    }
}
