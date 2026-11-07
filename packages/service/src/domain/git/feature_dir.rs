//! The one place that decides which directory a feature works in.
//!
//! Git endpoints, the agent cwd, terminals and plugin tabs go through
//! [`resolve_feature_dir`] so they cannot disagree about whether a recorded
//! worktree is still live. (Worktree removal and the CLI-log import read the
//! raw `worktree_path` on purpose: they act on the recorded directory itself.) A stale worktree setting can point at a
//! deleted directory or at residual files left after Git detached the
//! worktree; both fall back to the project directory, with the reason kept in
//! [`FeatureDirSource`] instead of being folded into an ambiguous path.

use std::path::{Path, PathBuf};

use sqlx::SqlitePool;

use crate::domain::git::service::SETTING_WORKTREE_PATH;
use crate::domain::git::worktree_context::resolve_source_git_root;
use crate::domain::git::{commands, repository};
use crate::error::AppError;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FeatureDir {
    /// Directory the feature's agent, terminals, and Git commands run in: the
    /// worktree copy of the project directory, or the project directory.
    pub cwd: String,
    pub source: FeatureDirSource,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum FeatureDirSource {
    /// A live, registered worktree. `root` is the worktree root; `cwd` may be
    /// below it when the project is a monorepo subdirectory.
    Worktree {
        root: PathBuf,
    },
    Project(ProjectFallback),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ProjectFallback {
    /// The feature never recorded a worktree (it runs on the project checkout).
    NoWorktreeRecorded,
    /// The project has no Git metadata, so there can be no worktree.
    ProjectWithoutGit,
    /// A worktree was recorded but is gone or no longer registered.
    WorktreeNotLive,
}

impl FeatureDir {
    pub fn live_worktree_cwd(&self) -> Option<&str> {
        matches!(self.source, FeatureDirSource::Worktree { .. }).then_some(self.cwd.as_str())
    }

    /// Root of the checkout that owns `cwd`, or `None` without Git metadata.
    ///
    /// Git reports changed paths relative to this root (`status --porcelain`,
    /// `diff --name-only`, …), so every command that takes such a path back,
    /// and every read of one from disk, must run here: from a monorepo
    /// subdirectory `cwd`, `packages/app/x` would resolve to
    /// `packages/app/packages/app/x`. A feature at the root keeps `cwd`'s own
    /// spelling, so the common case sees the exact path it always did.
    pub async fn git_root(&self) -> Result<Option<PathBuf>, AppError> {
        let cwd = Path::new(&self.cwd);
        let root = match &self.source {
            FeatureDirSource::Worktree { root } => root.clone(),
            FeatureDirSource::Project(ProjectFallback::ProjectWithoutGit) => return Ok(None),
            FeatureDirSource::Project(_) => {
                if !crate::shared::git_context::has_git_metadata(cwd).await? {
                    return Ok(None);
                }
                // The common case, a project at its checkout root, needs no
                // `git` process on every Git request.
                if cwd.join(".git").symlink_metadata().is_ok() {
                    return Ok(Some(cwd.to_path_buf()));
                }
                resolve_source_git_root(cwd)
                    .await
                    .map_err(AppError::GitCommandError)?
            }
        };
        let at_root = cwd == root || commands::canonical_dir(cwd) == commands::canonical_dir(&root);
        Ok(Some(if at_root { cwd.to_path_buf() } else { root }))
    }
}

/// Resolve a feature's directory. `Ok(None)` only when the feature row does
/// not exist; database and Git failures are errors, never "no worktree".
pub async fn resolve_feature_dir(
    pool: &SqlitePool,
    feature_id: i64,
) -> Result<Option<FeatureDir>, AppError> {
    let project_id: Option<i64> =
        sqlx::query_scalar("SELECT project_id FROM features WHERE id = ?")
            .bind(feature_id)
            .fetch_optional(pool)
            .await?;
    let Some(project_id) = project_id else {
        return Ok(None);
    };
    let project_path = repository::get_project_path(pool, project_id).await?;
    resolve_feature_dir_in_project(pool, feature_id, &project_path)
        .await
        .map(Some)
}

/// [`resolve_feature_dir`] for callers that already hold the project path.
pub async fn resolve_feature_dir_in_project(
    pool: &SqlitePool,
    feature_id: i64,
    project_path: &str,
) -> Result<FeatureDir, AppError> {
    let recorded = repository::get_feature_setting(pool, feature_id, SETTING_WORKTREE_PATH)
        .await?
        .filter(|path| !path.trim().is_empty());
    let project = |fallback| FeatureDir {
        cwd: project_path.to_string(),
        source: FeatureDirSource::Project(fallback),
    };
    let Some(recorded) = recorded else {
        return Ok(project(ProjectFallback::NoWorktreeRecorded));
    };
    if !crate::shared::git_context::has_git_metadata(Path::new(project_path)).await? {
        return Ok(project(ProjectFallback::ProjectWithoutGit));
    }
    match commands::live_worktree_root(Path::new(project_path), Path::new(&recorded)).await? {
        Some(root) => Ok(FeatureDir {
            cwd: recorded,
            source: FeatureDirSource::Worktree { root },
        }),
        None => {
            tracing::debug!(
                feature_id,
                recorded = %recorded,
                "recorded worktree is not live; using the project directory"
            );
            Ok(project(ProjectFallback::WorktreeNotLive))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::shared::git_cli::run_git;

    async fn pool(project_path: &str) -> SqlitePool {
        let pool = sqlx::sqlite::SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .unwrap();
        for sql in [
            "CREATE TABLE projects (id INTEGER PRIMARY KEY, path TEXT NOT NULL)",
            "CREATE TABLE features (id INTEGER PRIMARY KEY, project_id INTEGER NOT NULL)",
            "CREATE TABLE feature_settings (feature_id INTEGER, key TEXT, value TEXT, PRIMARY KEY(feature_id, key))",
        ] {
            sqlx::query(sql).execute(&pool).await.unwrap();
        }
        sqlx::query("INSERT INTO projects (id, path) VALUES (1, ?)")
            .bind(project_path)
            .execute(&pool)
            .await
            .unwrap();
        sqlx::query("INSERT INTO features (id, project_id) VALUES (1, 1)")
            .execute(&pool)
            .await
            .unwrap();
        pool
    }

    async fn record_worktree(pool: &SqlitePool, path: &str) {
        sqlx::query(
            "INSERT INTO feature_settings (feature_id, key, value) VALUES (1, 'worktree_path', ?)",
        )
        .bind(path)
        .execute(pool)
        .await
        .unwrap();
    }

    async fn init_repo(path: &Path) {
        std::fs::create_dir_all(path).unwrap();
        for args in [
            &["init", "-q"][..],
            &["config", "user.email", "test@example.com"],
            &["config", "user.name", "Test"],
            &["config", "commit.gpgsign", "false"],
        ] {
            run_git(args, path).await.unwrap();
        }
        std::fs::write(path.join("README.md"), "test").unwrap();
        run_git(&["add", "README.md"], path).await.unwrap();
        run_git(&["commit", "-qm", "init"], path).await.unwrap();
    }

    #[tokio::test]
    async fn a_monorepo_subdirectory_feature_resolves_to_its_worktree_copy() {
        let root = tempfile::tempdir().unwrap();
        let repo = root.path().join("repo");
        init_repo(&repo).await;
        let project = repo.join("packages/app");
        std::fs::create_dir_all(&project).unwrap();
        let worktree = root.path().join("wt");
        run_git(
            &[
                "worktree",
                "add",
                "-qb",
                "feature/x",
                worktree.to_str().unwrap(),
            ],
            &repo,
        )
        .await
        .unwrap();
        let session_cwd = worktree.join("packages/app");
        std::fs::create_dir_all(&session_cwd).unwrap();
        let pool = pool(project.to_str().unwrap()).await;
        record_worktree(&pool, session_cwd.to_str().unwrap()).await;

        let dir = resolve_feature_dir(&pool, 1).await.unwrap().unwrap();

        assert_eq!(dir.cwd, session_cwd.to_str().unwrap());
        assert_eq!(dir.live_worktree_cwd(), Some(session_cwd.to_str().unwrap()));
        let FeatureDirSource::Worktree { root: live_root } = dir.source else {
            panic!("expected a live worktree, got {:?}", dir.source);
        };
        assert_eq!(
            std::fs::canonicalize(live_root).unwrap(),
            std::fs::canonicalize(&worktree).unwrap()
        );
    }

    #[tokio::test]
    async fn fallbacks_carry_their_reason() {
        let root = tempfile::tempdir().unwrap();
        let repo = root.path().join("repo");
        init_repo(&repo).await;
        let pool = pool(repo.to_str().unwrap()).await;
        let project_dir = |fallback| FeatureDir {
            cwd: repo.to_str().unwrap().to_string(),
            source: FeatureDirSource::Project(fallback),
        };

        assert_eq!(
            resolve_feature_dir(&pool, 1).await.unwrap(),
            Some(project_dir(ProjectFallback::NoWorktreeRecorded))
        );
        let residual = root.path().join("residual");
        std::fs::create_dir_all(&residual).unwrap();
        record_worktree(&pool, residual.to_str().unwrap()).await;
        assert_eq!(
            resolve_feature_dir(&pool, 1).await.unwrap(),
            Some(project_dir(ProjectFallback::WorktreeNotLive))
        );
        assert_eq!(resolve_feature_dir(&pool, 2).await.unwrap(), None);
    }

    #[tokio::test]
    async fn database_errors_are_not_reported_as_missing_worktrees() {
        let pool = pool("/tmp/unused").await;
        sqlx::query("DROP TABLE feature_settings")
            .execute(&pool)
            .await
            .unwrap();
        assert!(resolve_feature_dir(&pool, 1).await.is_err());
    }
}
