//! Link the branches a conversation's agent checked out during a turn.
//!
//! Follows the live status stream (the single, provider-neutral source of
//! "a turn started" / "a turn ended") and, when a turn ends, reads the reflog
//! of the conversation's directory for the turn's window. That is the only
//! attribution available to a conversation without a worktree: its directory
//! is the project's, and the watcher cannot tell whose checkout it saw.

use std::collections::HashMap;
use std::path::Path;

use tokio::sync::broadcast::error::RecvError;

use super::{reflog, repository, BranchOrigin, BranchRef};
use crate::app_state::AppState;
use crate::domain::git::service::{recorded_feature_branch, resolve_feature_git_path};
use crate::domain::git::workflow_service::{resolve_default_branch, same_branch_identity};
use crate::domain::session_status::AgentStatus;
use crate::error::AppError;

/// Reflog entries are stamped in whole seconds by the machine that wrote
/// them; widen the window so a checkout in the turn's first or last second
/// is not lost to rounding.
const WINDOW_SLACK_SECS: i64 = 2;

struct OpenTurn {
    feature_id: i64,
    started_at_ms: i64,
}

pub fn spawn(state: AppState) {
    tokio::spawn(async move {
        let mut events = state.session_status_tx.subscribe();
        let mut open = HashMap::<i64, OpenTurn>::new();
        loop {
            let event = match events.recv().await {
                Ok(event) => event,
                // A missed transition only costs the attribution of one turn.
                // Forget the open turns too: one whose end was skipped would
                // otherwise stretch the next turn's window back to its start.
                Err(RecvError::Lagged(skipped)) => {
                    tracing::warn!(skipped, "linked branches: status events lagged");
                    open.clear();
                    continue;
                }
                Err(RecvError::Closed) => return,
            };
            match event.status {
                AgentStatus::Agent => {
                    let turn = OpenTurn {
                        feature_id: event.feature_id,
                        started_at_ms: event
                            .clock
                            .turn_started_at_ms
                            .unwrap_or_else(|| chrono::Utc::now().timestamp_millis()),
                    };
                    // The turn's own start is authoritative. Without one, keep
                    // the earliest: a respawn mid-turn re-announces the turn
                    // without starting a new one.
                    if event.clock.turn_started_at_ms.is_some() {
                        open.insert(event.session_id, turn);
                    } else {
                        open.entry(event.session_id).or_insert(turn);
                    }
                }
                // A gate pauses the turn; it has not ended.
                AgentStatus::Question => {}
                AgentStatus::Idle => {
                    if let Some(turn) = open.remove(&event.session_id) {
                        let state = state.clone();
                        tokio::spawn(async move {
                            if let Err(error) = attribute_turn(&state, &turn).await {
                                tracing::warn!(
                                    feature_id = turn.feature_id,
                                    %error,
                                    "linked branches: reading the turn's checkouts failed"
                                );
                            }
                        });
                    }
                }
            }
        }
    });
}

async fn attribute_turn(state: &AppState, turn: &OpenTurn) -> Result<(), AppError> {
    let feature_id = turn.feature_id;
    let Some(path) = resolve_feature_git_path(state, feature_id).await? else {
        return Ok(());
    };
    let repo = Path::new(&path);
    let since = turn.started_at_ms / 1000 - WINDOW_SLACK_SECS;
    let until = chrono::Utc::now().timestamp() + WINDOW_SLACK_SECS;
    let checkouts = reflog::checkouts_between(repo, since, until).await?;
    let recorded = recorded_feature_branch(&state.read_pool, feature_id).await?;
    let default = resolve_default_branch(repo).await?;
    let mut changed = false;
    for checkout in checkouts {
        // The provisioned branch belongs to the conversation without a row,
        // and going back to the trunk does not make it the conversation's.
        if recorded.as_deref() == Some(checkout.branch.as_str())
            || same_branch_identity(&checkout.branch, &default)
        {
            continue;
        }
        let key = BranchRef {
            feature_id,
            branch: &checkout.branch,
        };
        if repository::is_unlinked(&state.read_pool, key).await? {
            continue;
        }
        let seen_at = chrono::DateTime::from_timestamp(checkout.at, 0)
            .map(|at| at.to_rfc3339_opts(chrono::SecondsFormat::Millis, true));
        changed |= repository::record_seen(
            &state.write_pool,
            key,
            BranchOrigin::Agent,
            seen_at.as_deref(),
        )
        .await?;
    }
    if changed {
        super::refresh_after_change(state, feature_id).await;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::git::service::test_support::setup_diff_refs_schema;

    async fn git(dir: &Path, args: &[&str]) {
        let status = tokio::process::Command::new("git")
            .args(args)
            .current_dir(dir)
            .status()
            .await
            .unwrap();
        assert!(status.success(), "git {args:?}");
    }

    #[tokio::test]
    async fn links_the_branches_a_turn_visited_but_not_the_trunk() {
        let dir = tempfile::tempdir().unwrap();
        let repo = dir.path();
        for args in [
            &["init", "-q", "-b", "main"][..],
            &["config", "user.email", "t@example.com"],
            &["config", "user.name", "T"],
            &["config", "commit.gpgsign", "false"],
            &["commit", "--allow-empty", "-q", "-m", "init"],
        ] {
            git(repo, args).await;
        }
        let pool = setup_diff_refs_schema().await;
        sqlx::query("INSERT INTO projects (id, name, path) VALUES (1, 'p', ?)")
            .bind(repo.to_string_lossy().to_string())
            .execute(&pool)
            .await
            .unwrap();
        sqlx::query("INSERT INTO features (id, project_id, title) VALUES (1, 1, 'feat')")
            .execute(&pool)
            .await
            .unwrap();
        let state = AppState::with_pool(pool.clone());
        let turn = OpenTurn {
            feature_id: 1,
            started_at_ms: chrono::Utc::now().timestamp_millis(),
        };
        git(repo, &["checkout", "-q", "-b", "qa/agent"]).await;
        git(repo, &["checkout", "-q", "main"]).await;

        attribute_turn(&state, &turn).await.unwrap();

        let linked = repository::list_linked(&pool, 1).await.unwrap();
        assert_eq!(
            linked
                .iter()
                .map(|row| row.branch.as_str())
                .collect::<Vec<_>>(),
            vec!["qa/agent"]
        );
    }
}
