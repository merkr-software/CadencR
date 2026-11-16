//! `GET /api/git/status` and `GET /api/git/compare-url`, plus the
//! `enrich_snapshot` helper shared with the file-watcher.
//! Target-branch persistence lives in [`super::target_branch`].

use std::path::Path;

use crate::app_state::AppState;
use crate::domain::git::git_status::{self, GitStatusSnapshot, SharedFeatureRef};
use crate::domain::git::models::{CompareUrlResponse, GetCompareUrlParams, GetGitStatusParams};
use crate::domain::git::repository;
use crate::domain::git::service::resolve_feature_working_path;
use crate::error::AppError;

use super::target_branch::resolve_target_branch;

// ---------------------------------------------------------------------------
// /api/git/status
// ---------------------------------------------------------------------------

pub async fn get_git_status(
    state: &AppState,
    params: GetGitStatusParams,
) -> Result<GitStatusSnapshot, AppError> {
    let git_path = resolve_feature_working_path(state, params.feature_id)
        .await?
        .ok_or_else(|| {
            AppError::NotFound(format!("feature {} has no git path", params.feature_id))
        })?;
    let target = resolve_target_branch(state, params.feature_id, Path::new(&git_path)).await?;
    // `compute_status_or_empty` returns a degraded snapshot when the worktree
    // path doesn't exist yet (or has been deleted) instead of bubbling a 500.
    // That keeps the header chip + action button populated rather than stuck
    // on "Loading…", and avoids spamming the error log on every refetch.
    let mut snapshot =
        git_status::compute_status_or_empty(Path::new(&git_path), params.feature_id, &target)
            .await?;
    enrich_snapshot(state, &mut snapshot, &git_path).await;
    Ok(snapshot)
}

/// Everything a computed snapshot carries beyond what `git status` reports:
/// the features sharing its worktree, then the conversation's branches (which
/// need `shared_with` to know whether a checkout can be attributed).
pub async fn enrich_snapshot(state: &AppState, snapshot: &mut GitStatusSnapshot, path: &str) {
    enrich_with_sharing(state, snapshot, path).await;
    crate::domain::git::linked_branches::enrich_snapshot(state, snapshot, path).await;
}

/// Fill `snapshot.shared_with` with OTHER features in the same project whose
/// `worktree_path` setting points at the same directory. This is the
/// reuse-branch flow's signal — multiple features share a single worktree
/// dir, and we want the header to surface that. Best-effort: a DB error is
/// logged but doesn't fail the snapshot.
async fn enrich_with_sharing(
    state: &AppState,
    snapshot: &mut GitStatusSnapshot,
    worktree_path: &str,
) {
    let project_id =
        match repository::get_feature_type_and_project(&state.read_pool, snapshot.feature_id).await
        {
            Ok(Some((pid, _))) => pid,
            Ok(None) => return,
            Err(err) => {
                tracing::warn!(
                    feature_id = snapshot.feature_id,
                    error = %err,
                    "git status: skipping shared-worktree enrichment (project lookup failed)"
                );
                return;
            }
        };

    let canonical_self = canonicalize_str(worktree_path);

    let lookup = match repository::get_worktree_feature_lookup(&state.read_pool, project_id).await {
        Ok(rows) => rows,
        Err(err) => {
            tracing::warn!(
                feature_id = snapshot.feature_id,
                error = %err,
                "git status: skipping shared-worktree enrichment (lookup failed)"
            );
            return;
        }
    };

    snapshot.shared_with = lookup
        .into_iter()
        .filter(|row| {
            row.feature_id != snapshot.feature_id
                && canonicalize_str(&row.worktree_path) == canonical_self
        })
        .map(|row| SharedFeatureRef {
            feature_id: row.feature_id,
            title: row.feature_title,
        })
        .collect();
}

/// Canonicalize a path for symlink-safe equality. Falls back to the input
/// string (trimmed of trailing `/`) when canonicalization fails — fresh
/// worktree paths may not exist on disk yet but the textual match is still
/// useful in that window.
fn canonicalize_str(p: &str) -> String {
    match std::fs::canonicalize(p) {
        Ok(buf) => buf.to_string_lossy().trim_end_matches('/').to_string(),
        Err(_) => p.trim_end_matches('/').to_string(),
    }
}

// ---------------------------------------------------------------------------
// /api/git/compare-url
// ---------------------------------------------------------------------------

pub async fn get_compare_url(
    state: &AppState,
    params: GetCompareUrlParams,
) -> Result<CompareUrlResponse, AppError> {
    let snapshot = get_git_status(
        state,
        GetGitStatusParams {
            feature_id: params.feature_id,
        },
    )
    .await?;

    // `compare_url` is `None` when the host can't be classified (`Other`) or
    // there is no remote at all. Either way, the action is unavailable. The
    // `Other` sentinel itself never crosses this boundary — it's confined to
    // `host.rs`.
    let label = snapshot
        .action_label
        .clone()
        .unwrap_or_else(|| "Open compare".to_string());
    match snapshot.compare_url.clone() {
        Some(url) => Ok(CompareUrlResponse {
            url,
            label,
            available: true,
        }),
        None => Ok(CompareUrlResponse {
            url: String::new(),
            label,
            available: false,
        }),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use sqlx::sqlite::SqlitePoolOptions;
    use sqlx::SqlitePool;

    #[test]
    fn canonicalize_str_strips_trailing_slash_when_path_missing() {
        // For a path that doesn't exist, the function falls back to the
        // textual form trimmed of trailing `/`.
        assert_eq!(
            canonicalize_str("/no/such/path/"),
            "/no/such/path".to_string()
        );
        assert_eq!(canonicalize_str("/no/such/path"), "/no/such/path");
    }

    #[tokio::test]
    async fn canonicalize_str_resolves_real_path() {
        let dir = tempfile::tempdir().unwrap();
        let raw = dir.path().to_string_lossy().to_string();
        let canonical = std::fs::canonicalize(dir.path()).unwrap();
        assert_eq!(
            canonicalize_str(&raw),
            canonical
                .to_string_lossy()
                .trim_end_matches('/')
                .to_string()
        );
    }

    /// Set up an in-memory schema matching what `enrich_with_sharing` queries
    /// (the same minimal subset used by the repository tests).
    async fn setup_schema() -> SqlitePool {
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .unwrap();
        sqlx::query(
            "CREATE TABLE projects (id INTEGER PRIMARY KEY, name TEXT, path TEXT, branch_prefix TEXT DEFAULT 'feature/')",
        )
        .execute(&pool)
        .await
        .unwrap();
        sqlx::query(
            "CREATE TABLE features (id INTEGER PRIMARY KEY, project_id INTEGER NOT NULL, title TEXT, status TEXT NOT NULL DEFAULT 'active', type TEXT NOT NULL DEFAULT 'ws-session')",
        )
        .execute(&pool)
        .await
        .unwrap();
        sqlx::query(
            "CREATE TABLE feature_settings (feature_id INTEGER, key TEXT, value TEXT, PRIMARY KEY(feature_id, key))",
        )
        .execute(&pool)
        .await
        .unwrap();
        pool
    }

    fn fresh_snapshot(feature_id: i64) -> GitStatusSnapshot {
        GitStatusSnapshot {
            feature_id,
            current_branch: "feat".into(),
            target_branch: "main".into(),
            uncommitted_count: 0,
            staged_count: 0,
            unstaged_count: 0,
            untracked_count: 0,
            ahead_of_remote: 0,
            behind_remote: 0,
            ahead_of_target: 0,
            behind_target: 0,
            target_resolved: false,
            update_target_branch: None,
            ahead_of_update_target: 0,
            behind_update_target: 0,
            update_target_resolved: false,
            conflict_count: 0,
            operation: None,
            has_remote: false,
            host: None,
            compare_url: None,
            action_label: None,
            shared_with: Vec::new(),
            thread_branches: Vec::new(),
            computed_at: 0,
        }
    }

    #[tokio::test]
    async fn enrich_with_sharing_finds_other_features_on_same_path() {
        let pool = setup_schema().await;
        sqlx::query("INSERT INTO projects (id, name, path) VALUES (1, 'p', '/tmp')")
            .execute(&pool)
            .await
            .unwrap();
        sqlx::query(
            "INSERT INTO features (id, project_id, title) VALUES (1, 1, 'self'), (2, 1, 'other'), (3, 1, 'unrelated')",
        )
        .execute(&pool)
        .await
        .unwrap();
        // feature 1 (self) and feature 2 share the same worktree dir;
        // feature 3 has its own.
        let dir_shared = tempfile::tempdir().unwrap();
        let dir_other = tempfile::tempdir().unwrap();
        let shared_str = dir_shared.path().to_string_lossy().to_string();
        let other_str = dir_other.path().to_string_lossy().to_string();
        repository::set_feature_setting(&pool, 1, "worktree_path", &shared_str)
            .await
            .unwrap();
        repository::set_feature_setting(&pool, 2, "worktree_path", &shared_str)
            .await
            .unwrap();
        repository::set_feature_setting(&pool, 3, "worktree_path", &other_str)
            .await
            .unwrap();

        let state = AppState::with_pool(pool);
        let mut snap = fresh_snapshot(1);
        enrich_with_sharing(&state, &mut snap, &shared_str).await;

        assert_eq!(snap.shared_with.len(), 1);
        assert_eq!(snap.shared_with[0].feature_id, 2);
        assert_eq!(snap.shared_with[0].title, "other");
    }

    #[tokio::test]
    async fn enrich_with_sharing_excludes_self_and_unmatched_paths() {
        let pool = setup_schema().await;
        sqlx::query("INSERT INTO projects (id, name, path) VALUES (1, 'p', '/tmp')")
            .execute(&pool)
            .await
            .unwrap();
        sqlx::query("INSERT INTO features (id, project_id, title) VALUES (1, 1, 'self')")
            .execute(&pool)
            .await
            .unwrap();
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().to_string_lossy().to_string();
        repository::set_feature_setting(&pool, 1, "worktree_path", &p)
            .await
            .unwrap();

        let state = AppState::with_pool(pool);
        let mut snap = fresh_snapshot(1);
        enrich_with_sharing(&state, &mut snap, &p).await;
        assert!(
            snap.shared_with.is_empty(),
            "self must not appear in shared_with"
        );
    }

    #[tokio::test]
    async fn enrich_with_sharing_treats_trailing_slash_as_same_path() {
        let pool = setup_schema().await;
        sqlx::query("INSERT INTO projects (id, name, path) VALUES (1, 'p', '/tmp')")
            .execute(&pool)
            .await
            .unwrap();
        sqlx::query(
            "INSERT INTO features (id, project_id, title) VALUES (1, 1, 'self'), (2, 1, 'other')",
        )
        .execute(&pool)
        .await
        .unwrap();
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().to_string_lossy().to_string();
        let p_with_slash = format!("{p}/");
        repository::set_feature_setting(&pool, 1, "worktree_path", &p)
            .await
            .unwrap();
        repository::set_feature_setting(&pool, 2, "worktree_path", &p_with_slash)
            .await
            .unwrap();

        let state = AppState::with_pool(pool);
        let mut snap = fresh_snapshot(1);
        enrich_with_sharing(&state, &mut snap, &p).await;
        assert_eq!(snap.shared_with.len(), 1);
        assert_eq!(snap.shared_with[0].feature_id, 2);
    }
}
