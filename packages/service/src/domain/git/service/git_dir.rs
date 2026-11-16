//! The directories a feature's Git endpoints run in.
//!
//! The Git tab receives paths relative to the checkout root (`status
//! --porcelain`, `diff --name-only`, …) and sends them back for diffs, index
//! mutations, commits, and file reads. A project registered on a monorepo
//! subdirectory works in that subdirectory, so those commands run from the
//! checkout root ([`FeatureDir::git_root`]) instead. The agent, terminals, the
//! editor, and the status watcher keep the feature's own directory.

use std::path::PathBuf;

use crate::app_state::AppState;
use crate::domain::git::feature_dir::resolve_feature_dir;
use crate::domain::git::models::{GetGitPathPrefixParams, GitPathPrefixResponse};
use crate::error::AppError;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FeatureGitDir {
    /// The feature's own directory. The status watcher is keyed by it, so
    /// mutation permits and post-write refreshes name it.
    pub cwd: PathBuf,
    /// Root of the checkout owning `cwd`, where Git runs. Equal to `cwd`
    /// unless the project is a repository subdirectory.
    pub root: PathBuf,
}

/// Resolve a feature's Git directories, `None` when the feature does not
/// exist or its directory has no Git metadata. Optional read endpoints already
/// use `None` for empty results; mutations reject it before running Git.
pub async fn resolve_feature_git_dir(
    state: &AppState,
    feature_id: i64,
) -> Result<Option<FeatureGitDir>, AppError> {
    let Some(dir) = resolve_feature_dir(&state.read_pool, feature_id).await? else {
        return Ok(None);
    };
    Ok(dir.git_root().await?.map(|root| FeatureGitDir {
        cwd: PathBuf::from(dir.cwd),
        root,
    }))
}

/// The checkout root of [`resolve_feature_git_dir`]: the directory every Git
/// read that names repository-relative paths runs in.
pub async fn resolve_feature_git_path(
    state: &AppState,
    feature_id: i64,
) -> Result<Option<String>, AppError> {
    Ok(resolve_feature_git_dir(state, feature_id)
        .await?
        .map(|dir| dir.root.to_string_lossy().into_owned()))
}

impl FeatureGitDir {
    /// `cwd` relative to `root`, `/`-separated: what a repository-relative
    /// path loses when it is opened relative to the feature's directory.
    pub fn cwd_prefix(&self) -> Result<String, AppError> {
        let canonical = |path: &PathBuf| {
            std::fs::canonicalize(path).map_err(|error| {
                AppError::internal(format!("cannot resolve {}: {error}", path.display()))
            })
        };
        let (cwd, root) = (canonical(&self.cwd)?, canonical(&self.root)?);
        let relative = cwd.strip_prefix(&root).map_err(|_| {
            AppError::internal(format!(
                "feature directory {} is outside its checkout {}",
                cwd.display(),
                root.display()
            ))
        })?;
        Ok(relative
            .components()
            .map(|part| part.as_os_str().to_string_lossy())
            .collect::<Vec<_>>()
            .join("/"))
    }
}

pub async fn get_git_path_prefix(
    state: &AppState,
    params: GetGitPathPrefixParams,
) -> Result<GitPathPrefixResponse, AppError> {
    let Some(dir) = resolve_feature_git_dir(state, params.feature_id).await? else {
        return Ok(GitPathPrefixResponse {
            prefix: None,
            root: None,
        });
    };
    Ok(GitPathPrefixResponse {
        prefix: Some(dir.cwd_prefix()?),
        root: Some(dir.root.to_string_lossy().into_owned()),
    })
}

#[cfg(test)]
mod tests {
    use std::path::{Path, PathBuf};

    use super::*;
    use crate::domain::git::models::{
        CommitBody, FileMutationBody, GetChangedFilesParams, GetFileContentParams,
        GetFileDiffParams, GetUncommittedFilesParams,
    };
    use crate::domain::git::service::{get_changed_files, get_file_content, get_file_diff};
    use crate::domain::git::workflow_service::{self, index};
    use crate::shared::git_cli::run_git;

    const TRACKED: &str = "packages/app/readme.txt";
    const UNTRACKED: &str = "packages/app/new.txt";
    const FEATURE: i64 = 1;

    /// Where the project is registered in a repository whose files live
    /// under `packages/app`.
    #[derive(Clone, Copy, Debug)]
    enum Layout {
        /// The project is `packages/app`; the feature works in place.
        Subdirectory,
        /// The project is `packages/app`; the feature works in the matching
        /// subdirectory of a linked worktree.
        SubdirectoryWorktree,
        /// The project is the repository root; the feature works in place.
        Root,
        /// The project is the repository root; the feature works in a linked
        /// worktree root.
        RootWorktree,
    }

    const LAYOUTS: [Layout; 4] = [
        Layout::Subdirectory,
        Layout::SubdirectoryWorktree,
        Layout::Root,
        Layout::RootWorktree,
    ];

    struct Fixture {
        _temp: tempfile::TempDir,
        /// The checkout the feature's Git commands act on.
        checkout: PathBuf,
        /// The feature's own directory.
        cwd: PathBuf,
        state: AppState,
    }

    async fn git(args: &[&str], cwd: &Path) -> String {
        run_git(args, cwd).await.unwrap()
    }

    impl Fixture {
        /// A committed `packages/app/readme.txt`, then an uncommitted edit of
        /// it and a new untracked `packages/app/new.txt` in the checkout.
        async fn new(layout: Layout) -> Self {
            let temp = tempfile::tempdir().unwrap();
            let repo = temp.path().join("repo");
            std::fs::create_dir_all(repo.join("packages/app")).unwrap();
            for args in [
                &["init", "-q", "-b", "main"][..],
                &["config", "user.email", "test@example.com"],
                &["config", "user.name", "Test"],
                &["config", "commit.gpgsign", "false"],
            ] {
                git(args, &repo).await;
            }
            std::fs::write(repo.join(TRACKED), "one\ntwo\n").unwrap();
            git(&["add", "."], &repo).await;
            git(&["commit", "-qm", "init"], &repo).await;

            let worktree = temp.path().join("wt");
            let (project, checkout, recorded) = match layout {
                Layout::Subdirectory => (repo.join("packages/app"), repo.clone(), None),
                Layout::Root => (repo.clone(), repo.clone(), None),
                Layout::SubdirectoryWorktree | Layout::RootWorktree => {
                    let path = worktree.to_str().unwrap();
                    git(&["worktree", "add", "-qb", "feature/x", path], &repo).await;
                    let recorded = match layout {
                        Layout::SubdirectoryWorktree => worktree.join("packages/app"),
                        _ => worktree.clone(),
                    };
                    let project = match layout {
                        Layout::SubdirectoryWorktree => repo.join("packages/app"),
                        _ => repo.clone(),
                    };
                    (project, worktree.clone(), Some(recorded))
                }
            };
            std::fs::write(checkout.join(TRACKED), "one\nchanged\n").unwrap();
            std::fs::write(checkout.join(UNTRACKED), "hello\nworld\n").unwrap();

            let pool = super::super::test_support::setup_diff_refs_schema().await;
            sqlx::query("INSERT INTO projects (id, name, path) VALUES (1, 'app', ?)")
                .bind(project.to_str().unwrap())
                .execute(&pool)
                .await
                .unwrap();
            sqlx::query("INSERT INTO features (id, project_id, title) VALUES (?, 1, 'f')")
                .bind(FEATURE)
                .execute(&pool)
                .await
                .unwrap();
            if let Some(recorded) = &recorded {
                sqlx::query(
                    "INSERT INTO feature_settings (feature_id, key, value) VALUES (?, 'worktree_path', ?)",
                )
                .bind(FEATURE)
                .bind(recorded.to_str().unwrap())
                .execute(&pool)
                .await
                .unwrap();
            }
            Self {
                _temp: temp,
                checkout,
                cwd: recorded.unwrap_or(project),
                state: AppState::with_pool(pool),
            }
        }

        async fn staged(&self) -> String {
            git(&["diff", "--cached", "--name-only"], &self.checkout).await
        }

        async fn file_diff(&self, file_path: &str) -> String {
            let params = GetFileDiffParams {
                feature_id: FEATURE,
                file_path: file_path.into(),
                old_file_path: None,
                mode: "uncommitted".into(),
                commit_sha: None,
                target_branch: None,
            };
            get_file_diff(&self.state, params).await.unwrap().diff
        }

        fn mutation(file_path: &str) -> FileMutationBody {
            FileMutationBody {
                feature_id: FEATURE,
                file_path: file_path.into(),
            }
        }
    }

    #[tokio::test]
    async fn git_runs_from_the_checkout_root_and_keeps_the_feature_cwd() {
        for layout in LAYOUTS {
            let fixture = Fixture::new(layout).await;
            let dir = resolve_feature_git_dir(&fixture.state, FEATURE)
                .await
                .unwrap()
                .unwrap();
            assert_eq!(dir.cwd, fixture.cwd, "{layout:?}");
            assert_eq!(
                std::fs::canonicalize(&dir.root).unwrap(),
                std::fs::canonicalize(&fixture.checkout).unwrap(),
                "{layout:?}"
            );
            let mapping = get_git_path_prefix(
                &fixture.state,
                GetGitPathPrefixParams {
                    feature_id: FEATURE,
                },
            )
            .await
            .unwrap();
            // The contract the desktop relies on: `root` is absolute and joining
            // `prefix` onto it names the feature's directory.
            let root = PathBuf::from(mapping.root.expect("root"));
            let prefix = mapping.prefix;
            assert!(root.is_absolute(), "{layout:?}");
            assert_eq!(
                std::fs::canonicalize(root.join(prefix.as_deref().unwrap())).unwrap(),
                std::fs::canonicalize(&fixture.cwd).unwrap(),
                "{layout:?}"
            );
            if matches!(layout, Layout::Root | Layout::RootWorktree) {
                // A feature at the root keeps its recorded spelling.
                assert_eq!(dir.root, fixture.cwd, "{layout:?}");
                assert_eq!(prefix.as_deref(), Some(""), "{layout:?}");
            } else {
                assert_eq!(prefix.as_deref(), Some("packages/app"), "{layout:?}");
            }
        }
    }

    #[tokio::test]
    async fn per_file_diffs_have_hunks_for_modified_and_new_files() {
        for layout in LAYOUTS {
            let fixture = Fixture::new(layout).await;

            let modified = fixture.file_diff(TRACKED).await;
            assert!(modified.contains("@@"), "{layout:?}: {modified}");
            assert!(modified.contains("+changed"), "{layout:?}: {modified}");

            let added = fixture.file_diff(UNTRACKED).await;
            assert!(added.contains("new file mode"), "{layout:?}: {added}");
            assert!(added.contains("+hello"), "{layout:?}: {added}");
        }
    }

    #[tokio::test]
    async fn stage_and_unstage_accept_listed_paths() {
        for layout in LAYOUTS {
            let fixture = Fixture::new(layout).await;

            index::stage_file(&fixture.state, Fixture::mutation(TRACKED))
                .await
                .unwrap();
            index::stage_file(&fixture.state, Fixture::mutation(UNTRACKED))
                .await
                .unwrap();
            let staged = fixture.staged().await;
            assert!(staged.contains(TRACKED), "{layout:?}: {staged}");
            assert!(staged.contains(UNTRACKED), "{layout:?}: {staged}");

            index::reset_file(&fixture.state, Fixture::mutation(TRACKED))
                .await
                .unwrap();
            assert_eq!(fixture.staged().await.trim(), UNTRACKED, "{layout:?}");
        }
    }

    #[tokio::test]
    async fn commit_adds_listed_paths() {
        for layout in LAYOUTS {
            let fixture = Fixture::new(layout).await;
            let body = CommitBody {
                feature_id: FEATURE,
                message: "add new".into(),
                file_paths: vec![UNTRACKED.into()],
            };

            let response = workflow_service::commit(&fixture.state, body)
                .await
                .unwrap();

            assert!(response.success, "{layout:?}: {:?}", response.error);
            let committed = git(
                &["show", "--name-only", "--format=", "HEAD"],
                &fixture.checkout,
            )
            .await;
            assert_eq!(committed.trim(), UNTRACKED, "{layout:?}");
        }
    }

    #[tokio::test]
    async fn file_content_reads_the_listed_path() {
        for layout in LAYOUTS {
            let fixture = Fixture::new(layout).await;
            let params = GetFileContentParams {
                feature_id: FEATURE,
                file_path: TRACKED.into(),
                mode: "uncommitted".into(),
                commit_sha: None,
                target_branch: None,
            };

            let content = get_file_content(&fixture.state, params).await.unwrap();

            assert_eq!(
                content.old_content.as_deref(),
                Some("one\ntwo\n"),
                "{layout:?}"
            );
            assert_eq!(
                content.new_content.as_deref(),
                Some("one\nchanged\n"),
                "{layout:?}"
            );
        }
    }

    #[tokio::test]
    async fn untracked_files_count_their_lines() {
        for layout in LAYOUTS {
            let fixture = Fixture::new(layout).await;
            let params = GetChangedFilesParams {
                feature_id: FEATURE,
                mode: "uncommitted".into(),
                commit_sha: None,
                target_branch: None,
            };
            let changed = get_changed_files(&fixture.state, params).await.unwrap();
            let listed = changed.iter().find(|file| file.file == UNTRACKED);
            assert_eq!(listed.map(|file| file.additions), Some(2), "{layout:?}");

            let params = GetUncommittedFilesParams {
                feature_id: FEATURE,
            };
            let uncommitted = workflow_service::get_uncommitted_files(&fixture.state, params)
                .await
                .unwrap();
            let listed = uncommitted.iter().find(|file| file.path == UNTRACKED);
            assert_eq!(listed.map(|file| file.additions), Some(2), "{layout:?}");
        }
    }
}
