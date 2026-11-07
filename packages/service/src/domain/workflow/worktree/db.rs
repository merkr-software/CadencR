//! Settings + project lookups used across the worktree provisioning flow.

use sqlx::SqlitePool;

/// Look up the project_id for a given feature.
pub async fn get_project_id_for_feature(pool: &SqlitePool, feature_id: i64) -> Result<i64, String> {
    sqlx::query_scalar("SELECT project_id FROM features WHERE id = ?")
        .bind(feature_id)
        .fetch_one(pool)
        .await
        .map_err(|e| {
            format!(
                "Failed to look up project for feature {}: {}",
                feature_id, e
            )
        })
}

/// Look up the project directory for a given project_id.
pub async fn get_project_directory(pool: &SqlitePool, project_id: i64) -> Result<String, String> {
    sqlx::query_scalar("SELECT path FROM projects WHERE id = ?")
        .bind(project_id)
        .fetch_one(pool)
        .await
        .map_err(|e| {
            format!(
                "Failed to look up directory for project {}: {}",
                project_id, e
            )
        })
}

/// Resolve the directory a feature's agent actually runs in: its worktree when
/// one is provisioned and live, otherwise the project directory (features can
/// run "on branch" directly in the project folder). Delegates to the single
/// resolver in [`crate::domain::git::feature_dir`] so checkpoints, rewind/fork,
/// terminals, and Git endpoints all agree.
pub async fn resolve_feature_cwd(pool: &SqlitePool, feature_id: i64) -> Result<String, String> {
    crate::domain::git::feature_dir::resolve_feature_dir(pool, feature_id)
        .await
        .map_err(|error| format!("Failed to resolve directory for feature {feature_id}: {error}"))?
        .map(|dir| dir.cwd)
        .ok_or_else(|| format!("Failed to look up project for feature {feature_id}: not found"))
}

/// Resolve the recorded worktree only when it still exists and is registered
/// by the owning project repository. Verification and database failures are
/// surfaced rather than silently routing work into a different directory.
/// Plain projects have no Git worktree; callers keep using the project
/// directory.
pub async fn resolve_live_worktree(
    pool: &SqlitePool,
    feature_id: i64,
    project_path: &str,
) -> Result<Option<String>, String> {
    crate::domain::git::feature_dir::resolve_feature_dir_in_project(pool, feature_id, project_path)
        .await
        .map(|dir| dir.live_worktree_cwd().map(str::to_string))
        .map_err(|error| format!("Failed to verify feature worktree: {error}"))
}

pub async fn get_setting(pool: &SqlitePool, feature_id: i64, key: &str) -> Option<String> {
    sqlx::query_as::<_, (String,)>(
        "SELECT value FROM feature_settings WHERE feature_id = ? AND key = ?",
    )
    .bind(feature_id)
    .bind(key)
    .fetch_optional(pool)
    .await
    .ok()
    .flatten()
    .map(|r| r.0)
}

pub async fn set_setting(
    pool: &SqlitePool,
    feature_id: i64,
    key: &str,
    value: &str,
) -> Result<(), String> {
    sqlx::query(
        "INSERT OR REPLACE INTO feature_settings (feature_id, key, value) VALUES (?, ?, ?)",
    )
    .bind(feature_id)
    .bind(key)
    .bind(value)
    .execute(pool)
    .await
    .map_err(|e| format!("DB error setting {key}: {e}"))?;
    Ok(())
}

/// Look up project path + name in one query — both the new and reuse paths
/// need them.
pub(super) async fn lookup_project(
    read_pool: &SqlitePool,
    project_id: i64,
) -> Result<(String, String), String> {
    sqlx::query_as::<_, (String, String)>("SELECT p.path, p.name FROM projects p WHERE p.id = ?")
        .bind(project_id)
        .fetch_optional(read_pool)
        .await
        .map_err(|e| format!("DB error looking up project: {e}"))?
        .ok_or_else(|| format!("Project {project_id} not found"))
}

/// Read the optional `worktree_base_branch` setting. Empty/whitespace values
/// are treated as unset so the caller falls back to project HEAD.
pub(super) async fn read_base_branch(read_pool: &SqlitePool, feature_id: i64) -> Option<String> {
    get_setting(read_pool, feature_id, "worktree_base_branch")
        .await
        .and_then(|v| {
            let trimmed = v.trim();
            if trimmed.is_empty() {
                None
            } else {
                Some(trimmed.to_string())
            }
        })
}

#[cfg(test)]
mod tests {
    use super::*;

    async fn make_pool() -> SqlitePool {
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
    async fn plain_project_ignores_worktree_settings_but_corruption_still_errors() {
        let pool = make_pool().await;
        let dir = tempfile::tempdir().unwrap();
        let project = dir.path().to_str().unwrap();
        set_setting(&pool, 1, "worktree_path", project)
            .await
            .unwrap();
        assert_eq!(
            resolve_live_worktree(&pool, 1, project).await.unwrap(),
            None
        );
        std::fs::write(dir.path().join(".git"), "broken metadata").unwrap();
        assert!(resolve_live_worktree(&pool, 1, project).await.is_err());
    }

    #[tokio::test]
    async fn read_base_branch_returns_none_when_unset() {
        let pool = make_pool().await;
        assert_eq!(read_base_branch(&pool, 1).await, None);
    }

    #[tokio::test]
    async fn read_base_branch_returns_trimmed_value_when_set() {
        let pool = make_pool().await;
        set_setting(&pool, 1, "worktree_base_branch", "  develop  ")
            .await
            .unwrap();
        assert_eq!(
            read_base_branch(&pool, 1).await,
            Some("develop".to_string())
        );
    }

    #[tokio::test]
    async fn read_base_branch_treats_blank_as_unset() {
        let pool = make_pool().await;
        set_setting(&pool, 1, "worktree_base_branch", "   ")
            .await
            .unwrap();
        assert_eq!(read_base_branch(&pool, 1).await, None);
    }

    /// Pool with the tables `resolve_feature_cwd` touches: a feature in a
    /// project whose path is the fallback cwd, plus `feature_settings`.
    async fn make_cwd_pool() -> SqlitePool {
        let pool = make_pool().await;
        sqlx::query("CREATE TABLE projects (id INTEGER PRIMARY KEY, path TEXT NOT NULL)")
            .execute(&pool)
            .await
            .unwrap();
        sqlx::query("CREATE TABLE features (id INTEGER PRIMARY KEY, project_id INTEGER NOT NULL)")
            .execute(&pool)
            .await
            .unwrap();
        sqlx::query("INSERT INTO projects (id, path) VALUES (6, '/Users/x/proj')")
            .execute(&pool)
            .await
            .unwrap();
        sqlx::query("INSERT INTO features (id, project_id) VALUES (1, 6)")
            .execute(&pool)
            .await
            .unwrap();
        pool
    }

    async fn linked_worktree() -> (tempfile::TempDir, String, String) {
        let root = tempfile::tempdir().unwrap();
        let repo = root.path().join("repo");
        let worktree = root.path().join("worktree");
        std::fs::create_dir(&repo).unwrap();
        for args in [
            &["init"][..],
            &["config", "user.email", "test@example.com"],
            &["config", "user.name", "Test"],
            &["config", "commit.gpgsign", "false"],
        ] {
            crate::shared::git_cli::run_git(args, &repo).await.unwrap();
        }
        std::fs::write(repo.join("README.md"), "test").unwrap();
        crate::shared::git_cli::run_git(&["add", "README.md"], &repo)
            .await
            .unwrap();
        crate::shared::git_cli::run_git(&["commit", "-m", "init"], &repo)
            .await
            .unwrap();
        crate::shared::git_cli::run_git(
            &[
                "worktree",
                "add",
                "-b",
                "feature/test",
                worktree.to_str().unwrap(),
            ],
            &repo,
        )
        .await
        .unwrap();
        (
            root,
            repo.to_string_lossy().into_owned(),
            worktree.to_string_lossy().into_owned(),
        )
    }

    #[tokio::test]
    async fn resolve_feature_cwd_prefers_the_worktree_path() {
        let pool = make_cwd_pool().await;
        let (_root, repo, worktree) = linked_worktree().await;
        sqlx::query("UPDATE projects SET path = ? WHERE id = 6")
            .bind(repo)
            .execute(&pool)
            .await
            .unwrap();
        set_setting(&pool, 1, "worktree_path", &worktree)
            .await
            .unwrap();
        assert_eq!(resolve_feature_cwd(&pool, 1).await.unwrap(), worktree);
    }

    #[tokio::test]
    async fn resolve_feature_cwd_falls_back_to_project_dir_without_a_worktree() {
        // The "on branch / no worktree" case — the previous code bailed here,
        // which broke rewind/fork and follow-up checkpoints for the feature.
        let pool = make_cwd_pool().await;
        assert_eq!(
            resolve_feature_cwd(&pool, 1).await.unwrap(),
            "/Users/x/proj"
        );
    }

    #[tokio::test]
    async fn resolve_feature_cwd_treats_blank_worktree_as_no_worktree() {
        let pool = make_cwd_pool().await;
        set_setting(&pool, 1, "worktree_path", "   ").await.unwrap();
        assert_eq!(
            resolve_feature_cwd(&pool, 1).await.unwrap(),
            "/Users/x/proj"
        );
    }

    #[tokio::test]
    async fn resolve_feature_cwd_rejects_a_leftover_non_git_directory() {
        let pool = make_cwd_pool().await;
        let project = tempfile::tempdir().unwrap();
        crate::shared::git_cli::run_git(&["init"], project.path())
            .await
            .unwrap();
        let project_path = project.path().to_string_lossy().into_owned();
        sqlx::query("UPDATE projects SET path = ? WHERE id = 6")
            .bind(&project_path)
            .execute(&pool)
            .await
            .unwrap();
        let leftover = tempfile::tempdir().unwrap();
        set_setting(
            &pool,
            1,
            "worktree_path",
            &leftover.path().to_string_lossy(),
        )
        .await
        .unwrap();
        assert_eq!(resolve_feature_cwd(&pool, 1).await.unwrap(), project_path);
    }
}
