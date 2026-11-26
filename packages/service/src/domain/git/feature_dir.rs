//! The one place that decides which directory a feature works in.
//!
//! Git endpoints, the agent cwd, terminals and plugin tabs go through
//! [`resolve_feature_dir`] so they cannot disagree about whether a recorded
//! worktree is still live. A distinct recorded checkout owns the feature even
//! when it is unavailable. Worktree removal and log import use the raw path
//! because they act on the recorded directory itself.

use std::path::{Path, PathBuf};

use sqlx::SqlitePool;

use crate::domain::git::service::SETTING_WORKTREE_PATH;
use crate::domain::git::{commands, repository};
use crate::error::AppError;
use crate::shared::git_cli::run_git_background;

mod linked_checkout;

pub(crate) use linked_checkout::{
    is_worktree_unavailable, require_linked_checkout, worktree_unavailable, WORKTREE_UNAVAILABLE,
};
use linked_checkout::{linked_path, registered_linked_root, same_directory_spelling};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FeatureDir {
    path: String,
    source: FeatureDirSource,
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum FeatureDirSource {
    /// A live, registered worktree. `root` is the worktree root; `cwd` may be
    /// below it when the project is a monorepo subdirectory.
    Worktree {
        root: PathBuf,
        git_dir: PathBuf,
    },
    Project {
        recorded: bool,
    },
    WorktreeUnavailable,
}

impl FeatureDir {
    pub fn cwd(&self) -> Result<&str, AppError> {
        match self.source {
            FeatureDirSource::WorktreeUnavailable => Err(worktree_unavailable()),
            _ => Ok(&self.path),
        }
    }

    /// The binding used to retire an old watcher even if the path is absent.
    pub(crate) fn expected_path(&self) -> &Path {
        Path::new(&self.path)
    }

    pub(crate) fn linked_root(&self) -> Option<&Path> {
        self.linked_binding().map(|(root, _)| root)
    }

    pub(crate) fn linked_binding(&self) -> Option<(&Path, &Path)> {
        match &self.source {
            FeatureDirSource::Worktree { root, git_dir } => Some((root, git_dir)),
            _ => None,
        }
    }

    /// State replay and provisioning also accept a legacy explicit binding
    /// to the project directory, once Git has verified that directory.
    pub(crate) async fn live_recorded_cwd(&self) -> Result<Option<&str>, AppError> {
        match self.source {
            FeatureDirSource::Worktree { .. } => Ok(Some(&self.path)),
            FeatureDirSource::Project { recorded: true } => {
                let path = self.expected_path();
                let live = crate::shared::git_context::has_git_metadata(path).await?
                    && commands::is_live_worktree(path, path).await?;
                Ok(live.then_some(self.path.as_str()))
            }
            _ => Ok(None),
        }
    }

    pub(crate) async fn validate(&self) -> Result<(), AppError> {
        let cwd = Path::new(self.cwd()?);
        if let Some((root, git_dir)) = self.linked_binding() {
            if require_linked_checkout(cwd, root).await? != git_dir {
                return Err(worktree_unavailable());
            }
        }
        Ok(())
    }

    /// Confirm the checkout survived a read before using its result.
    pub(crate) async fn checked_read<T>(
        &self,
        read: impl AsyncFnOnce(&Path) -> Result<T, AppError>,
    ) -> Result<T, AppError> {
        let cwd = Path::new(self.cwd()?);
        let result =
            crate::shared::git_cli::in_linked_checkout(self.linked_binding(), cwd, read(cwd)).await;
        self.validate().await?;
        result
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
        let cwd = Path::new(self.cwd()?);
        let root = match self.linked_root() {
            Some(root) => root.to_path_buf(),
            None => {
                if !crate::shared::git_context::has_git_metadata(cwd).await? {
                    return Ok(None);
                }
                // The common case, a project at its checkout root, needs no
                // `git` process on every Git request.
                if cwd.join(".git").symlink_metadata().is_ok() {
                    return Ok(Some(cwd.to_path_buf()));
                }
                // Git's own error, so a refusal (an unsafe or broken
                // repository) keeps its user-facing `GIT_*` classification.
                let top = run_git_background(&["rev-parse", "--show-toplevel"], cwd).await?;
                PathBuf::from(top.trim())
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
    let project = |recorded| FeatureDir {
        path: project_path.to_string(),
        source: FeatureDirSource::Project { recorded },
    };
    let Some(recorded) = recorded else {
        return Ok(project(false));
    };
    let (project_path, recorded_path) = (Path::new(project_path), Path::new(&recorded));
    // Skip leaves no path. Some older features explicitly recorded the
    // project directory, including with a different spelling of its parent.
    if same_directory_spelling(project_path, recorded_path).await {
        return Ok(project(true));
    }
    if let Some(actual) = linked_path(recorded_path).await? {
        if let Some(root) = registered_linked_root(project_path, recorded_path, &actual).await? {
            match require_linked_checkout(&actual, &root).await {
                Ok(git_dir) => {
                    return Ok(FeatureDir {
                        path: recorded,
                        source: FeatureDirSource::Worktree { root, git_dir },
                    })
                }
                Err(error) if is_worktree_unavailable(&error) => {}
                Err(error) => return Err(error),
            }
        }
    }
    Ok(FeatureDir {
        path: recorded,
        source: FeatureDirSource::WorktreeUnavailable,
    })
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

        assert_eq!(dir.cwd().unwrap(), session_cwd.to_str().unwrap());
        assert_eq!(
            dir.live_recorded_cwd().await.unwrap(),
            Some(session_cwd.to_str().unwrap())
        );
        let FeatureDirSource::Worktree {
            root: live_root, ..
        } = dir.source
        else {
            panic!("expected a live worktree, got {:?}", dir.source);
        };
        assert_eq!(
            std::fs::canonicalize(live_root).unwrap(),
            std::fs::canonicalize(&worktree).unwrap()
        );
    }

    #[tokio::test]
    async fn only_unassigned_or_legacy_project_paths_resolve_to_the_project() {
        let root = tempfile::tempdir().unwrap();
        let repo = root.path().join("repo");
        init_repo(&repo).await;
        let pool = pool(repo.to_str().unwrap()).await;
        let project_dir = |recorded| FeatureDir {
            path: repo.to_str().unwrap().to_string(),
            source: FeatureDirSource::Project { recorded },
        };

        assert_eq!(
            resolve_feature_dir(&pool, 1).await.unwrap(),
            Some(project_dir(false))
        );
        record_worktree(&pool, repo.to_str().unwrap()).await;
        assert_eq!(
            resolve_feature_dir(&pool, 1).await.unwrap(),
            Some(project_dir(true))
        );
        assert_eq!(resolve_feature_dir(&pool, 2).await.unwrap(), None);
    }

    #[tokio::test]
    async fn a_registered_nested_directory_without_its_git_marker_cannot_inherit_the_parent() {
        let root = tempfile::tempdir().unwrap();
        let repo = root.path().join("repo");
        init_repo(&repo).await;
        let worktree = repo.join("feature-checkout");
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
        let pool = pool(repo.to_str().unwrap()).await;
        record_worktree(&pool, worktree.to_str().unwrap()).await;
        let dir = resolve_feature_dir(&pool, 1).await.unwrap().unwrap();
        let index_before = std::fs::read(repo.join(".git/index")).unwrap();
        std::fs::write(repo.join("root-only.txt"), "parent file").unwrap();
        let error = dir
            .checked_read(async |cwd| {
                std::fs::write(
                    worktree.join(".git"),
                    format!("gitdir: {}\n", repo.join(".git").display()),
                )
                .unwrap();
                run_git(&["add", "--all"], cwd).await.unwrap();
                std::fs::remove_file(worktree.join(".git")).unwrap();
                // Without the explicit checkout binding, Git climbs to the
                // parent from this residual directory and stages files there.
                let result = run_git(&["add", "--all"], cwd).await;
                assert!(result.is_err());
                Ok(Vec::<String>::new())
            })
            .await
            .unwrap_err();
        assert!(is_worktree_unavailable(&error));
        assert_eq!(
            std::fs::read(repo.join(".git/index")).unwrap(),
            index_before
        );

        let dir = resolve_feature_dir(&pool, 1).await.unwrap().unwrap();
        assert!(is_worktree_unavailable(&dir.git_root().await.unwrap_err()));
        assert_eq!(dir.expected_path(), worktree);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn a_recorded_checkout_path_redirected_to_the_project_cannot_bind_to_it() {
        let root = tempfile::tempdir().unwrap();
        let repo = root.path().join("repo");
        init_repo(&repo).await;
        let expected = root.path().join("feature-checkout");
        std::os::unix::fs::symlink(&repo, &expected).unwrap();
        let pool = pool(repo.to_str().unwrap()).await;
        record_worktree(&pool, expected.to_str().unwrap()).await;
        let dir = resolve_feature_dir(&pool, 1).await.unwrap().unwrap();
        assert!(is_worktree_unavailable(&dir.cwd().unwrap_err()));
    }

    #[tokio::test]
    async fn a_git_refusal_resolving_the_checkout_root_keeps_its_classification() {
        // Metadata that Git itself refuses (here a `.git` file pointing
        // nowhere) is Git's user-facing error, not a masked internal one.
        let root = tempfile::tempdir().unwrap();
        std::fs::write(root.path().join(".git"), "gitdir: missing").unwrap();
        let project = root.path().join("packages/app");
        std::fs::create_dir_all(&project).unwrap();
        let dir = FeatureDir {
            path: project.to_str().unwrap().to_string(),
            source: FeatureDirSource::Project { recorded: false },
        };

        let error = dir.git_root().await.unwrap_err();

        assert!(matches!(error, AppError::GitRejected(_)), "{error:?}");
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
