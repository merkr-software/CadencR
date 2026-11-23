//! A feature that chose a worktree (new or reused) whose provisioning never
//! completed. Such a feature has no worktree to run in, and its project root
//! is never a substitute: the agent would edit the project checkout instead
//! of the worktree the user picked.

use std::path::PathBuf;

use sqlx::SqlitePool;

use super::{ensure_worktree, get_project_id_for_feature, get_setting, read_worktree_mode};
use super::{WorktreeMode, WorktreeSetupRegistry};
use crate::domain::workflow::ws_sender::WsSender;
use crate::error::AppError;

/// Whether the feature asked for a worktree that was never recorded. The
/// setup step is saved together with the worktree path, and a worktree removed
/// later keeps its step: only a provisioning that never completed has none.
pub async fn provisioning_unfinished(
    read_pool: &SqlitePool,
    feature_id: i64,
) -> Result<bool, AppError> {
    let chosen = matches!(
        get_setting(read_pool, feature_id, "worktree_mode")
            .await?
            .as_deref(),
        Some("new" | "reuse")
    );
    Ok(chosen
        && read_worktree_mode(read_pool, feature_id).await? != WorktreeMode::Skip
        && get_setting(read_pool, feature_id, "worktree_setup_step")
            .await?
            .is_none())
}

/// Provision the worktree a failed first attempt left unfinished, in the mode
/// the feature chose. `None` when there is nothing to finish.
pub async fn finish_provisioning(
    read_pool: &SqlitePool,
    write_pool: &SqlitePool,
    setup_runs: &WorktreeSetupRegistry,
    feature_id: i64,
    ws_sender: &WsSender,
) -> Result<Option<PathBuf>, String> {
    if !provisioning_unfinished(read_pool, feature_id)
        .await
        .map_err(|e| e.to_string())?
    {
        return Ok(None);
    }
    let project_id = get_project_id_for_feature(read_pool, feature_id).await?;
    ensure_worktree(
        read_pool, write_pool, setup_runs, feature_id, project_id, ws_sender,
    )
    .await
    .map(Some)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::workflow::worktree::set_setting;

    async fn pool() -> SqlitePool {
        let pool = sqlx::sqlite::SqlitePoolOptions::new()
            .connect(":memory:")
            .await
            .unwrap();
        sqlx::query(
            "CREATE TABLE feature_settings (feature_id INTEGER, key TEXT, value TEXT, \
             PRIMARY KEY (feature_id, key))",
        )
        .execute(&pool)
        .await
        .unwrap();
        pool
    }

    #[tokio::test]
    async fn only_a_chosen_worktree_without_a_recorded_step_is_unfinished() {
        let pool = pool().await;
        // No choice recorded: an "On branch" feature runs in the project.
        assert!(!provisioning_unfinished(&pool, 1).await.unwrap());

        set_setting(&pool, 1, "worktree_mode", "reuse")
            .await
            .unwrap();
        set_setting(&pool, 1, "worktree_reuse_branch", "feat/a")
            .await
            .unwrap();
        assert!(provisioning_unfinished(&pool, 1).await.unwrap());

        // Recorded once (a worktree removed later keeps its step).
        set_setting(&pool, 1, "worktree_setup_step", "ready")
            .await
            .unwrap();
        assert!(!provisioning_unfinished(&pool, 1).await.unwrap());

        set_setting(&pool, 2, "worktree_mode", "skip")
            .await
            .unwrap();
        assert!(!provisioning_unfinished(&pool, 2).await.unwrap());
    }
}
