//! Provider-neutral worktree checkpoints for the Rewind feature.
//!
//! On each turn start we snapshot the worktree (via an isolated git index) and
//! link the snapshot to the user message that started the turn. Rewind later
//! restores that snapshot. Pure git + a side table; no provider knowledge —
//! Codex / OpenCode reuse this as-is.

mod git_ops;
mod repo;

use std::path::Path;
use std::time::Duration;

use sqlx::SqlitePool;
use tracing::warn;

use crate::error::AppError;

pub use repo::get_commit_sha;

/// Upper bound on a single pre-turn snapshot. A normal worktree stages well
/// under this; the cap only guards against a hung git so a turn never stalls
/// indefinitely behind the checkpoint barrier.
const CAPTURE_TIMEOUT: Duration = Duration::from_secs(15);

fn checkpoint_ref(feature_id: i64, message_id: i64) -> String {
    format!("refs/cadencr/checkpoints/{feature_id}/{message_id}")
}

/// Capture a pre-turn snapshot of `cwd` and link it to `message_id`.
///
/// This is a deliberate **pre-turn barrier**: the snapshot must finish before
/// the prompt reaches the agent, or the agent could edit files before the
/// snapshot stages them and the checkpoint would capture a mid-edit tree. It is
/// best-effort — any git/db failure or a [`CAPTURE_TIMEOUT`] overrun is logged
/// and swallowed; a missing checkpoint only disables *code* rewind for that one
/// message, never the turn or the conversation rewind.
pub async fn capture_pre_turn(pool: &SqlitePool, cwd: &Path, feature_id: i64, message_id: i64) {
    match tokio::time::timeout(
        CAPTURE_TIMEOUT,
        try_capture_pre_turn(pool, cwd, feature_id, message_id),
    )
    .await
    {
        Ok(Ok(())) => {}
        Ok(Err(error)) => warn!(
            feature_id,
            message_id,
            error = %error,
            "pre-turn checkpoint capture failed (code rewind unavailable for this message)"
        ),
        Err(_) => warn!(
            feature_id,
            message_id,
            timeout_secs = CAPTURE_TIMEOUT.as_secs(),
            "pre-turn checkpoint capture timed out (code rewind unavailable for this message)"
        ),
    }
}

async fn try_capture_pre_turn(
    pool: &SqlitePool,
    cwd: &Path,
    feature_id: i64,
    message_id: i64,
) -> Result<(), AppError> {
    let ref_name = checkpoint_ref(feature_id, message_id);
    let label = format!("{feature_id}/{message_id}");
    let commit = git_ops::snapshot_commit(cwd, &ref_name, &label).await?;
    repo::upsert_checkpoint(pool, message_id, &commit).await?;
    Ok(())
}

/// Roll the worktree back to a checkpoint commit. Used by rewind only.
pub async fn restore(cwd: &Path, commit_sha: &str) -> Result<(), AppError> {
    git_ops::restore_worktree(cwd, commit_sha).await
}

/// Whether the worktree has uncommitted changes — the rewind confirm gate.
/// Reuses the shared git command so there's a single definition of "dirty".
pub async fn is_dirty(cwd: &Path) -> Result<bool, AppError> {
    crate::domain::git::commands::has_uncommitted_changes(cwd).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use sqlx::sqlite::SqlitePoolOptions;
    use std::fs;

    async fn checkpoint_pool() -> SqlitePool {
        let pool = SqlitePoolOptions::new()
            .connect("sqlite::memory:")
            .await
            .unwrap();
        sqlx::query(
            "CREATE TABLE turn_checkpoints (
                message_id INTEGER PRIMARY KEY,
                commit_sha TEXT NOT NULL,
                kind TEXT NOT NULL DEFAULT 'pre_turn',
                created_at TEXT NOT NULL DEFAULT (datetime('now'))
            )",
        )
        .execute(&pool)
        .await
        .unwrap();
        pool
    }

    async fn init_repo() -> tempfile::TempDir {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path();
        crate::shared::git_cli::run_git(&["init", "-q"], p)
            .await
            .unwrap();
        crate::shared::git_cli::run_git(&["config", "user.email", "t@example.com"], p)
            .await
            .unwrap();
        crate::shared::git_cli::run_git(&["config", "user.name", "Test"], p)
            .await
            .unwrap();
        fs::write(p.join("a.txt"), "v1").unwrap();
        crate::shared::git_cli::run_git(&["add", "-A"], p)
            .await
            .unwrap();
        crate::shared::git_cli::run_git(&["commit", "-qm", "init"], p)
            .await
            .unwrap();
        dir
    }

    #[tokio::test]
    async fn capture_writes_a_ref_and_a_row_then_restore_rolls_back() {
        let pool = checkpoint_pool().await;
        let dir = init_repo().await;
        let p = dir.path();

        capture_pre_turn(&pool, p, 7, 42).await;

        // Row persisted.
        let sha = get_commit_sha(&pool, 42)
            .await
            .unwrap()
            .expect("checkpoint row");
        // Ref created.
        let ref_sha =
            crate::shared::git_cli::run_git(&["rev-parse", "refs/cadencr/checkpoints/7/42"], p)
                .await
                .unwrap();
        assert_eq!(ref_sha.trim(), sha);

        // Mutate and roll back.
        fs::write(p.join("a.txt"), "v2").unwrap();
        restore(p, &sha).await.unwrap();
        assert_eq!(fs::read_to_string(p.join("a.txt")).unwrap(), "v1");
    }

    #[tokio::test]
    async fn is_dirty_reflects_worktree_state() {
        let dir = init_repo().await;
        let p = dir.path();
        assert!(!is_dirty(p).await.unwrap(), "clean checkout is not dirty");
        fs::write(p.join("a.txt"), "v2").unwrap();
        assert!(is_dirty(p).await.unwrap(), "uncommitted edit is dirty");
    }

    #[tokio::test]
    async fn missing_checkpoint_returns_none() {
        let pool = checkpoint_pool().await;
        assert!(get_commit_sha(&pool, 999).await.unwrap().is_none());
    }

    #[tokio::test]
    async fn capture_is_best_effort_on_a_non_repo() {
        let pool = checkpoint_pool().await;
        let dir = tempfile::tempdir().unwrap();
        // Not a git repo — capture must swallow the error, not panic.
        capture_pre_turn(&pool, dir.path(), 1, 1).await;
        assert!(get_commit_sha(&pool, 1).await.unwrap().is_none());
    }
}
