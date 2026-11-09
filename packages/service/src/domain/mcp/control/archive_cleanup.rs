//! The cleanup half of `project_archive_session`: the optional teardown the
//! sidebar's Archive dialog runs once the archive has committed, in the same
//! order — shells, browser tabs, worktree, branch — and, like the dialog, on
//! the selected conversation only, never on relatives archived alongside it.
//!
//! A step never fails the call: the archive is already done, and the agent
//! needs to know which part to retry. Where the dialog would show the user a
//! warning and then force (a dirty worktree, an unmerged branch), the step is
//! reported as blocked instead, and the agent has to ask for force explicitly.

use serde::{Deserialize, Serialize};
use serde_json::json;

use crate::app_state::AppState;
use crate::domain::git::models::{
    DeleteFeatureBranchParams, DeleteWorktreeParams, SuccessResponse,
};
use crate::domain::git::service as git_service;
use crate::domain::mcp::tools::browser::BROWSER_CLOSE_SCOPE_TABS;
use crate::domain::mcp::tools::browser_bridge::{BrowserBridgeClient, BrowserBridgeRequest};
use crate::error::AppError;

/// Git refusals that mean the option doesn't apply to this conversation (the
/// dialog doesn't offer it), rather than a cleanup that went wrong.
const UNAVAILABLE_BLOCKS: [&str; 3] = ["default_worktree", "default_branch", "target_branch"];

/// The dialog's cleanup checkboxes, plus the force it would have implied.
#[derive(Debug, Default, Deserialize)]
pub(super) struct CleanupSelection {
    #[serde(default)]
    kill_terminals: bool,
    #[serde(default)]
    close_browser_tabs: bool,
    #[serde(default)]
    remove_worktree: bool,
    #[serde(default)]
    remove_branch: bool,
    #[serde(default)]
    force_remove_worktree: bool,
    #[serde(default)]
    force_remove_branch: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "status", rename_all = "snake_case")]
pub enum StepOutcome {
    Done {
        #[serde(skip_serializing_if = "Option::is_none")]
        detail: Option<String>,
    },
    Skipped {
        reason: String,
    },
    Blocked {
        reason: String,
        message: String,
    },
    Failed {
        message: String,
    },
}

/// One entry per step that was asked for; absent steps were not requested.
#[derive(Debug, Clone, Default, Serialize)]
pub struct CleanupReport {
    #[serde(skip_serializing_if = "Option::is_none")]
    terminals: Option<StepOutcome>,
    #[serde(skip_serializing_if = "Option::is_none")]
    browser_tabs: Option<StepOutcome>,
    #[serde(skip_serializing_if = "Option::is_none")]
    worktree: Option<StepOutcome>,
    #[serde(skip_serializing_if = "Option::is_none")]
    branch: Option<StepOutcome>,
}

pub(super) async fn run_cleanup(
    state: &AppState,
    project_id: i64,
    feature_id: i64,
    selection: &CleanupSelection,
) -> CleanupReport {
    let mut report = CleanupReport::default();
    if selection.kill_terminals {
        let killed = state.pty_manager.kill_feature_ptys(feature_id);
        report.terminals = Some(StepOutcome::Done {
            detail: Some(format!("killed {killed} shell(s)")),
        });
    }
    if selection.close_browser_tabs {
        report.browser_tabs = Some(close_browser_tabs(state, feature_id).await);
    }
    if selection.remove_worktree || selection.remove_branch {
        report.worktree = remove_worktree(state, project_id, feature_id, selection).await;
    }
    if selection.remove_branch {
        report.branch =
            Some(remove_branch(state, project_id, feature_id, selection, &report).await);
    }
    report
}

#[derive(Deserialize)]
struct ClosedScopeTabs {
    closed_tabs: u64,
}

/// The browser lives in the desktop shell, reached through the same loopback
/// bridge the browser MCP uses; its scope id is the feature id.
async fn close_browser_tabs(state: &AppState, feature_id: i64) -> StepOutcome {
    let config = match state.browser_bridge_config() {
        Ok(Some(config)) => config,
        Ok(None) => return skipped("the desktop browser is not available"),
        Err(message) => return StepOutcome::Failed { message },
    };
    let request = BrowserBridgeRequest::new(BROWSER_CLOSE_SCOPE_TABS, json!({}), feature_id);
    let closed = async {
        let response = BrowserBridgeClient::from_config(config)?
            .call(request)
            .await?;
        serde_json::from_str::<ClosedScopeTabs>(&response.text)
            .map_err(|error| format!("The browser's reply was unreadable: {error}"))
    };
    match closed.await {
        Ok(reply) => StepOutcome::Done {
            detail: Some(format!("closed {} tab(s)", reply.closed_tabs)),
        },
        Err(message) => StepOutcome::Failed { message },
    }
}

/// As in the dialog, removing the branch takes the worktree with it: git
/// won't delete a branch that is still checked out there. When only the
/// branch was asked for, a worktree that doesn't exist goes unreported.
async fn remove_worktree(
    state: &AppState,
    project_id: i64,
    feature_id: i64,
    selection: &CleanupSelection,
) -> Option<StepOutcome> {
    let params = DeleteWorktreeParams {
        project_id,
        feature_id,
        force: selection.force_remove_worktree,
    };
    let outcome = git_outcome(git_service::delete_worktree(state, params).await);
    (selection.remove_worktree || !matches!(outcome, StepOutcome::Skipped { .. }))
        .then_some(outcome)
}

async fn remove_branch(
    state: &AppState,
    project_id: i64,
    feature_id: i64,
    selection: &CleanupSelection,
    report: &CleanupReport,
) -> StepOutcome {
    if matches!(
        report.worktree,
        Some(StepOutcome::Blocked { .. } | StepOutcome::Failed { .. })
    ) {
        return skipped("the worktree that has it checked out could not be removed");
    }
    // Keyed on the recorded branch, not the worktree: a retry with
    // force_remove_branch comes after the first call removed the worktree.
    let params = DeleteFeatureBranchParams {
        project_id,
        feature_id,
        force: selection.force_remove_branch,
    };
    git_outcome(git_service::delete_feature_branch(state, params).await)
}

fn git_outcome(result: Result<SuccessResponse, AppError>) -> StepOutcome {
    match result {
        Ok(response) if response.success => StepOutcome::Done { detail: None },
        Ok(SuccessResponse {
            blocked_reason: Some(reason),
            error,
            ..
        }) => {
            let message = error.unwrap_or_else(|| reason.clone());
            if UNAVAILABLE_BLOCKS.contains(&reason.as_str()) {
                return StepOutcome::Skipped { reason: message };
            }
            let message = match force_hint(&reason) {
                Some(hint) => format!("{message}. {hint}"),
                None => message,
            };
            StepOutcome::Blocked { reason, message }
        }
        Ok(response) => StepOutcome::Failed {
            message: response
                .error
                .unwrap_or_else(|| "The git operation failed".into()),
        },
        // No worktree, or no recorded branch: nothing to remove.
        Err(AppError::NotFound(reason)) => StepOutcome::Skipped { reason },
        Err(error) => StepOutcome::Failed {
            message: error.to_string(),
        },
    }
}

fn force_hint(blocked_reason: &str) -> Option<&'static str> {
    match blocked_reason {
        "dirty_worktree" => Some(
            "Retry with force_remove_worktree=true to discard those changes, after checking they are not needed",
        ),
        "unmerged_branch" => Some(
            "Retry with force_remove_branch=true to delete it anyway, after checking its commits are not needed",
        ),
        _ => None,
    }
}

fn skipped(reason: &str) -> StepOutcome {
    StepOutcome::Skipped {
        reason: reason.into(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn blocked(reason: &str, error: &str) -> serde_json::Value {
        serde_json::to_value(git_outcome(Ok(SuccessResponse {
            success: false,
            error: Some(error.into()),
            blocked_reason: Some(reason.into()),
        })))
        .unwrap()
    }

    #[test]
    fn a_refusal_the_dialog_would_force_names_the_flag_to_force_it() {
        let value = blocked(
            "dirty_worktree",
            "Worktree has uncommitted or untracked changes",
        );
        assert_eq!(value["status"], "blocked");
        assert_eq!(value["reason"], "dirty_worktree");
        assert!(value["message"]
            .as_str()
            .unwrap()
            .contains("force_remove_worktree=true"));
        let failed = serde_json::to_value(git_outcome(Err(AppError::internal("x")))).unwrap();
        assert_eq!(failed["status"], "failed");
    }

    #[test]
    fn an_option_the_dialog_would_not_offer_is_skipped() {
        let value = blocked("default_branch", "Cannot remove the default branch");
        assert_eq!(value["status"], "skipped");
        assert_eq!(value["reason"], "Cannot remove the default branch");
        let missing = git_outcome(Err(AppError::NotFound(
            "No worktree found for this feature".into(),
        )));
        assert!(matches!(missing, StepOutcome::Skipped { .. }));
    }
}
