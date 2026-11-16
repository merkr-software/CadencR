use sqlx::SqlitePool;

use crate::domain::git::repository::get_project_path;
use crate::domain::workflow::worktree::resolve_live_worktree;
use crate::error::AppError;

/// Resolve the working directory for a terminal: feature worktree if set and
/// alive on disk, otherwise project path.
pub async fn resolve_cwd(
    pool: &SqlitePool,
    feature_id: i64,
    project_id: i64,
) -> Result<String, AppError> {
    let project_path = get_project_path(pool, project_id).await?;
    resolve_live_worktree(pool, feature_id, &project_path)
        .await
        .map(|worktree| worktree.unwrap_or(project_path))
        .map_err(|error| AppError::internal(error))
}

/// Same as [`resolve_cwd`] but honours `requested_cwd` when it matches the
/// feature's worktree path or the project path. Lets the frontend pin a fresh
/// PTY to the directory it just observed (e.g. on "Restart here") instead of
/// depending on a second snapshot read that may not have caught up with the
/// most recent write. Invalid input is silently downgraded to `resolve_cwd`.
pub async fn resolve_pty_cwd(
    pool: &SqlitePool,
    feature_id: i64,
    project_id: i64,
    requested_cwd: Option<&str>,
) -> Result<String, AppError> {
    let Some(req) = requested_cwd.filter(|path| !path.is_empty()) else {
        return resolve_cwd(pool, feature_id, project_id).await;
    };
    let project_path = get_project_path(pool, project_id).await?;
    let worktree_path = resolve_live_worktree(pool, feature_id, &project_path)
        .await
        .map_err(|error| AppError::internal(error))?;
    if req == project_path || worktree_path.as_deref() == Some(req) {
        return Ok(req.to_string());
    }
    Ok(worktree_path.unwrap_or(project_path))
}

#[cfg(test)]
mod tests {
    use super::*;
    use sqlx::sqlite::SqlitePoolOptions;

    async fn setup_db() -> SqlitePool {
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .unwrap();
        sqlx::query("CREATE TABLE projects (id INTEGER PRIMARY KEY, name TEXT, path TEXT)")
            .execute(&pool)
            .await
            .unwrap();
        sqlx::query(
            "CREATE TABLE feature_settings (feature_id INTEGER, key TEXT, value TEXT, PRIMARY KEY (feature_id, key))",
        )
        .execute(&pool)
        .await
        .unwrap();
        pool
    }

    fn temp_dir() -> String {
        std::env::temp_dir().to_string_lossy().into_owned()
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
    async fn resolve_pty_cwd_honours_requested_when_it_matches_worktree() {
        let pool = setup_db().await;
        let (_root, project, cwd) = linked_worktree().await;
        sqlx::query("INSERT INTO projects (id, name, path) VALUES (1, 'p', ?)")
            .bind(project)
            .execute(&pool)
            .await
            .unwrap();
        sqlx::query(
            "INSERT INTO feature_settings (feature_id, key, value) VALUES (1, 'worktree_path', ?)",
        )
        .bind(&cwd)
        .execute(&pool)
        .await
        .unwrap();

        let resolved = resolve_pty_cwd(&pool, 1, 1, Some(&cwd)).await.unwrap();
        assert_eq!(resolved, cwd);
    }

    #[tokio::test]
    async fn resolve_pty_cwd_rejects_a_leftover_non_git_worktree_directory() {
        let pool = setup_db().await;
        let project = tempfile::tempdir().unwrap();
        crate::shared::git_cli::run_git(&["init"], project.path())
            .await
            .unwrap();
        let leftover = tempfile::tempdir().unwrap();
        let project_path = project.path().to_string_lossy().into_owned();
        let leftover_path = leftover.path().to_string_lossy().into_owned();
        sqlx::query("INSERT INTO projects (id, name, path) VALUES (1, 'p', ?)")
            .bind(&project_path)
            .execute(&pool)
            .await
            .unwrap();
        sqlx::query(
            "INSERT INTO feature_settings (feature_id, key, value) VALUES (1, 'worktree_path', ?)",
        )
        .bind(&leftover_path)
        .execute(&pool)
        .await
        .unwrap();

        let resolved = resolve_pty_cwd(&pool, 1, 1, Some(&leftover_path))
            .await
            .unwrap();
        assert_eq!(resolved, project_path);
    }

    #[tokio::test]
    async fn resolve_pty_cwd_honours_requested_when_it_matches_project_path() {
        let pool = setup_db().await;
        let cwd = temp_dir();
        sqlx::query("INSERT INTO projects (id, name, path) VALUES (1, 'p', ?)")
            .bind(&cwd)
            .execute(&pool)
            .await
            .unwrap();

        let resolved = resolve_pty_cwd(&pool, 1, 1, Some(&cwd)).await.unwrap();
        assert_eq!(resolved, cwd);
    }

    #[tokio::test]
    async fn resolve_pty_cwd_rejects_arbitrary_paths() {
        let pool = setup_db().await;
        let project_path = temp_dir();
        sqlx::query("INSERT INTO projects (id, name, path) VALUES (1, 'p', ?)")
            .bind(&project_path)
            .execute(&pool)
            .await
            .unwrap();

        let resolved = resolve_pty_cwd(&pool, 1, 1, Some("/etc")).await.unwrap();
        assert_eq!(resolved, project_path);
    }

    #[tokio::test]
    async fn resolve_pty_cwd_falls_back_when_requested_is_none() {
        let pool = setup_db().await;
        let project_path = temp_dir();
        sqlx::query("INSERT INTO projects (id, name, path) VALUES (1, 'p', ?)")
            .bind(&project_path)
            .execute(&pool)
            .await
            .unwrap();

        let resolved = resolve_pty_cwd(&pool, 1, 1, None).await.unwrap();
        assert_eq!(resolved, project_path);
    }
}
