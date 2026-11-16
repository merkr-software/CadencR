//! What each cleanup step does, once. Every step is idempotent: run again
//! after it already happened, it finds nothing to do (no live shell, no tab,
//! no worktree, a branch already gone) and reports done or skipped.

use serde::Deserialize;
use serde_json::json;

use super::{StepName, StepOutcome};
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

/// Why a browser step waits: it runs when the desktop app registers its bridge.
pub(super) const WAITING_FOR_DESKTOP: &str = "waiting for the desktop app";

pub(super) async fn run(
    state: &AppState,
    project_id: i64,
    feature_id: i64,
    step: StepName,
    force: bool,
) -> StepOutcome {
    match step {
        StepName::Terminals => {
            let killed = state.pty_manager.kill_feature_ptys(feature_id);
            StepOutcome::done(Some(format!("killed {killed} shell(s)")))
        }
        StepName::BrowserTabs => close_browser_tabs(state, feature_id).await,
        StepName::Worktree => {
            let params = DeleteWorktreeParams {
                project_id,
                feature_id,
                force,
            };
            // Also cancels a setup still running in the worktree.
            git_outcome(git_service::delete_worktree(state, params).await)
        }
        StepName::Branch => {
            // Keyed on the recorded branch, not the worktree: a retry comes
            // after an earlier run removed the worktree.
            let params = DeleteFeatureBranchParams {
                project_id,
                feature_id,
                force,
            };
            git_outcome(git_service::delete_feature_branch(state, params).await)
        }
    }
}

#[derive(Deserialize)]
struct ClosedScopeTabs {
    closed_tabs: u64,
}

/// The browser lives in the desktop shell, reached through the same loopback
/// bridge the browser MCP uses; its scope id is the feature id. Without a
/// desktop the step stays pending until one registers.
async fn close_browser_tabs(state: &AppState, feature_id: i64) -> StepOutcome {
    let config = match state.browser_bridge_config() {
        Ok(Some(config)) => config,
        Ok(None) => return StepOutcome::pending(Some(WAITING_FOR_DESKTOP.into())),
        Err(message) => return StepOutcome::failed(message),
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
        Ok(reply) => StepOutcome::done(Some(format!("closed {} tab(s)", reply.closed_tabs))),
        Err(message) => StepOutcome::failed(message),
    }
}

fn git_outcome(result: Result<SuccessResponse, AppError>) -> StepOutcome {
    match result {
        Ok(response) if response.success => StepOutcome::done(None),
        Ok(SuccessResponse {
            blocked_reason: Some(reason),
            error,
            ..
        }) => {
            let message = error.unwrap_or_else(|| reason.clone());
            if UNAVAILABLE_BLOCKS.contains(&reason.as_str()) {
                return StepOutcome::skipped(message);
            }
            StepOutcome::blocked(reason, message)
        }
        Ok(response) => StepOutcome::failed(
            response
                .error
                .unwrap_or_else(|| "The git operation failed".into()),
        ),
        // No worktree, or no recorded branch: nothing to remove.
        Err(AppError::NotFound(reason)) => StepOutcome::skipped(reason),
        Err(error) => StepOutcome::failed(error.to_string()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::features::archive_cleanup::StepStatus;

    fn blocked(reason: &str, error: &str) -> StepOutcome {
        git_outcome(Ok(SuccessResponse {
            success: false,
            error: Some(error.into()),
            blocked_reason: Some(reason.into()),
        }))
    }

    #[test]
    fn a_refusal_the_user_can_force_is_blocked_with_its_code() {
        let outcome = blocked(
            "dirty_worktree",
            "Worktree has uncommitted or untracked changes",
        );
        assert_eq!(outcome.status, StepStatus::Blocked);
        assert_eq!(outcome.reason.as_deref(), Some("dirty_worktree"));
        let failed = git_outcome(Err(AppError::internal("x")));
        assert_eq!(failed.status, StepStatus::Failed);
    }

    #[test]
    fn an_option_the_dialog_would_not_offer_is_skipped() {
        let outcome = blocked("default_branch", "Cannot remove the default branch");
        assert_eq!(outcome.status, StepStatus::Skipped);
        assert_eq!(
            outcome.reason.as_deref(),
            Some("Cannot remove the default branch")
        );
        let missing = git_outcome(Err(AppError::NotFound(
            "No worktree found for this feature".into(),
        )));
        assert_eq!(missing.status, StepStatus::Skipped);
    }

    #[tokio::test]
    async fn without_a_desktop_the_browser_step_waits_for_one() {
        let pool = sqlx::SqlitePool::connect("sqlite::memory:").await.unwrap();
        let state = AppState::with_pool(pool);
        let outcome = run(&state, 1, 1, StepName::BrowserTabs, false).await;
        assert_eq!(outcome.status, StepStatus::Pending);
        assert_eq!(outcome.reason.as_deref(), Some(WAITING_FOR_DESKTOP));
    }
}
