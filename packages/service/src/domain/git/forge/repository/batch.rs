//! Forge target resolution: the one implementation behind both the poller's
//! [`super::active_feature_targets`] and the per-feature
//! [`super::resolve_feature_target`] of the HTTP routes, so the two cannot
//! disagree about a feature's branch or remote.
//!
//! Loads features, project paths, settings, and linked branches in two SQL
//! queries, probes Git (`list_worktrees` + `detect_origin_remote`) once per
//! unique project, and runs all filesystem canonicalization / `WorktreeRoots`
//! matching inside `tokio::task::spawn_blocking`. The rules match
//! [`crate::domain::git::feature_dir`] (a recorded worktree counts only while
//! it is a live, registered copy of the project) and
//! [`crate::domain::git::service::select_feature_branch`].
//!
//! The remote is read once per project, from the repository configuration
//! every worktree shares (`git remote add` run inside a linked worktree
//! writes there too). Per-worktree overrides (`extensions.worktreeConfig`)
//! are not consulted.

use std::collections::HashMap;
use std::future::Future;
use std::path::Path;

use futures::{stream, StreamExt};
use sqlx::SqlitePool;

use super::{assemble_tracked, failed_target, linked_branch_entry, FeatureForgeTarget};
use crate::domain::git::commands::{canonical_dir, list_worktrees, WorktreeRoots};
use crate::domain::git::host::{detect_origin_remote, RemoteInfo};
use crate::domain::git::models::WorktreeInfo;
use crate::domain::git::service::{branch_identity, select_feature_branch};
use crate::error::AppError;

#[derive(sqlx::FromRow)]
struct ActiveFeatureRow {
    id: i64,
    project_path: Option<String>,
    worktree_path: Option<String>,
    worktree_branch: Option<String>,
    feature_branch: Option<String>,
}

#[derive(sqlx::FromRow)]
struct ActiveLinkedBranchRow {
    feature_id: i64,
    branch: String,
    pr_number: Option<i64>,
    pr_state: Option<String>,
}

struct FeatureInput {
    feature_id: i64,
    worktree_path: Option<String>,
    worktree_branch: Option<String>,
    feature_branch: Option<String>,
    linked_rows: Vec<ActiveLinkedBranchRow>,
}

pub(super) enum ProjectGitInfo {
    NoGit,
    Git {
        worktrees: Vec<WorktreeInfo>,
        remote: Option<RemoteInfo>,
    },
}

/// Which features to resolve.
#[derive(Clone, Copy)]
enum Scope {
    Active,
    /// One feature, whatever its status.
    Feature(i64),
}

impl Scope {
    /// Bound to `?1`: `NULL` selects every active feature.
    fn feature_id(self) -> Option<i64> {
        match self {
            Self::Active => None,
            Self::Feature(feature_id) => Some(feature_id),
        }
    }
}

pub(super) async fn active_feature_targets(
    pool: &SqlitePool,
) -> Result<Vec<FeatureForgeTarget>, AppError> {
    targets_with_probe(pool, Scope::Active, &inspect_project_git).await
}

/// Resolve one feature. Failures are reported on the target, like the
/// poller reports them.
pub(super) async fn feature_target(pool: &SqlitePool, feature_id: i64) -> FeatureForgeTarget {
    match targets_with_probe(pool, Scope::Feature(feature_id), &inspect_project_git).await {
        Ok(mut targets) => targets
            .pop()
            .unwrap_or_else(|| failed_target(feature_id, no_repository(feature_id))),
        Err(error) => failed_target(feature_id, error.to_string()),
    }
}

fn no_repository(feature_id: i64) -> String {
    AppError::NotFound(format!("No repository found for feature {feature_id}")).to_string()
}

async fn targets_with_probe<F, Fut>(
    pool: &SqlitePool,
    scope: Scope,
    probe: &F,
) -> Result<Vec<FeatureForgeTarget>, AppError>
where
    F: Fn(String) -> Fut,
    Fut: Future<Output = Result<ProjectGitInfo, AppError>>,
{
    let feature_rows = sqlx::query_as::<_, ActiveFeatureRow>(
        "SELECT
            f.id,
            p.path AS project_path,
            MAX(CASE WHEN fs.key = 'worktree_path' THEN fs.value END) AS worktree_path,
            MAX(CASE WHEN fs.key = 'worktree_branch' THEN fs.value END) AS worktree_branch,
            MAX(CASE WHEN fs.key = 'feature_branch' THEN fs.value END) AS feature_branch
         FROM features f
         LEFT JOIN projects p ON p.id = f.project_id
         LEFT JOIN feature_settings fs
           ON fs.feature_id = f.id
          AND fs.key IN ('worktree_path', 'worktree_branch', 'feature_branch')
         WHERE (?1 IS NULL AND f.status = 'active') OR f.id = ?1
         GROUP BY f.id, p.path
         ORDER BY f.id",
    )
    .bind(scope.feature_id())
    .fetch_all(pool)
    .await?;

    if feature_rows.is_empty() {
        return Ok(Vec::new());
    }

    let linked_rows = sqlx::query_as::<_, ActiveLinkedBranchRow>(
        "SELECT fb.feature_id, fb.branch, fb.pr_number, fb.pr_state
         FROM feature_branches fb
         JOIN features f ON f.id = fb.feature_id
         WHERE ((?1 IS NULL AND f.status = 'active') OR f.id = ?1)
           AND fb.unlinked_at IS NULL
         ORDER BY fb.feature_id, fb.last_seen_at DESC, fb.id DESC",
    )
    .bind(scope.feature_id())
    .fetch_all(pool)
    .await?;

    let mut linked_by_feature = HashMap::<i64, Vec<ActiveLinkedBranchRow>>::new();
    for row in linked_rows {
        linked_by_feature
            .entry(row.feature_id)
            .or_default()
            .push(row);
    }

    let mut by_project = HashMap::<String, Vec<FeatureInput>>::new();
    let mut results = Vec::<FeatureForgeTarget>::with_capacity(feature_rows.len());
    for row in feature_rows {
        let linked = linked_by_feature.remove(&row.id).unwrap_or_default();
        let Some(project_path) = row.project_path else {
            results.push(failed_target(row.id, no_repository(row.id)));
            continue;
        };
        by_project
            .entry(project_path)
            .or_default()
            .push(FeatureInput {
                feature_id: row.id,
                worktree_path: row.worktree_path,
                worktree_branch: row.worktree_branch,
                feature_branch: row.feature_branch,
                linked_rows: linked,
            });
    }

    let per_project = stream::iter(by_project)
        .map(|(project_path, features)| resolve_project_group(project_path, features, probe))
        .buffer_unordered(8)
        .collect::<Vec<_>>()
        .await;
    results.extend(per_project.into_iter().flatten());
    results.sort_by_key(|target| target.feature_id);
    Ok(results)
}

async fn resolve_project_group<F, Fut>(
    project_path: String,
    features: Vec<FeatureInput>,
    probe: &F,
) -> Vec<FeatureForgeTarget>
where
    F: Fn(String) -> Fut,
    Fut: Future<Output = Result<ProjectGitInfo, AppError>>,
{
    let project_git = match probe(project_path.clone()).await {
        Ok(info) => info,
        Err(error) => return fail_all(&features, &error.to_string()),
    };

    match project_git {
        ProjectGitInfo::NoGit => features
            .into_iter()
            .map(|feature| {
                let recorded = recorded_branch(&feature);
                let linked = linked_entries(feature.linked_rows);
                let tracked = assemble_tracked(linked, recorded, None);
                FeatureForgeTarget {
                    feature_id: feature.feature_id,
                    branch: None,
                    tracked,
                    remote: None,
                    error: None,
                }
            })
            .collect(),
        ProjectGitInfo::Git { worktrees, remote } => {
            let fallback_ids: Vec<i64> = features.iter().map(|f| f.feature_id).collect();
            match tokio::task::spawn_blocking(move || {
                resolve_git_project_features(&project_path, worktrees, remote, features)
            })
            .await
            {
                Ok(targets) => targets,
                Err(error) => {
                    let message = format!("resolve forge targets failed: {error}");
                    fallback_ids
                        .into_iter()
                        .map(|id| failed_target(id, message.clone()))
                        .collect()
                }
            }
        }
    }
}

fn fail_all(features: &[FeatureInput], message: &str) -> Vec<FeatureForgeTarget> {
    features
        .iter()
        .map(|f| failed_target(f.feature_id, message))
        .collect()
}

async fn inspect_project_git(project_path: String) -> Result<ProjectGitInfo, AppError> {
    let path = Path::new(&project_path);
    if !crate::shared::git_context::has_git_metadata(path).await? {
        return Ok(ProjectGitInfo::NoGit);
    }
    let (worktrees, remote) = tokio::join!(list_worktrees(path), detect_origin_remote(path));
    Ok(ProjectGitInfo::Git {
        worktrees: worktrees?,
        remote: remote?,
    })
}

fn resolve_git_project_features(
    project_path: &str,
    worktrees: Vec<WorktreeInfo>,
    remote: Option<RemoteInfo>,
    features: Vec<FeatureInput>,
) -> Vec<FeatureForgeTarget> {
    let project_canonical = canonical_dir(Path::new(project_path));
    let roots = WorktreeRoots::new(worktrees);
    let subpath = roots.project_subpath_canonical(&project_canonical);
    let project_checked_out =
        worktree_branch_identity(roots.find_copy_canonical(&project_canonical, &subpath));
    features
        .into_iter()
        .map(|f| {
            resolve_one_git_feature(
                f,
                &roots,
                &subpath,
                &project_canonical,
                project_checked_out.as_deref(),
                remote.as_ref(),
            )
        })
        .collect()
}

fn resolve_one_git_feature(
    feature: FeatureInput,
    roots: &WorktreeRoots,
    subpath: &Path,
    project_canonical: &Path,
    project_checked_out: Option<&str>,
    remote: Option<&RemoteInfo>,
) -> FeatureForgeTarget {
    let recorded_wt = feature
        .worktree_path
        .as_deref()
        .map(str::trim)
        .filter(|path| !path.is_empty());

    let (own_worktree, checked_out) = match recorded_wt {
        Some(recorded) => match std::fs::metadata(recorded) {
            Ok(meta) if meta.is_dir() => {
                let recorded_canonical = canonical_dir(Path::new(recorded));
                match roots.find_copy_canonical(&recorded_canonical, subpath) {
                    Some(worktree) => (
                        recorded_canonical != project_canonical,
                        worktree_branch_identity(Some(worktree)),
                    ),
                    None => (false, project_checked_out.map(str::to_string)),
                }
            }
            Ok(_) => (false, project_checked_out.map(str::to_string)),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                (false, project_checked_out.map(str::to_string))
            }
            Err(error) => {
                return failed_target(
                    feature.feature_id,
                    AppError::internal(format!("Failed to inspect worktree path: {error}"))
                        .to_string(),
                );
            }
        },
        None => (false, project_checked_out.map(str::to_string)),
    };

    let recorded = recorded_branch(&feature);
    let checked_out_is_linked = checked_out
        .as_deref()
        .is_some_and(|head| feature.linked_rows.iter().any(|row| row.branch == head));
    let current = select_feature_branch(
        checked_out,
        recorded.clone(),
        own_worktree,
        checked_out_is_linked,
    );
    let linked = linked_entries(feature.linked_rows);
    let tracked = assemble_tracked(linked, recorded, current.as_deref());

    FeatureForgeTarget {
        feature_id: feature.feature_id,
        branch: current,
        tracked,
        remote: remote.cloned(),
        error: None,
    }
}

fn worktree_branch_identity(worktree: Option<&WorktreeInfo>) -> Option<String> {
    let wt = worktree?;
    let unborn = !wt.head.is_empty() && wt.head.chars().all(|c| c == '0');
    if wt.is_bare || wt.branch == "(detached)" || unborn {
        return None;
    }
    branch_identity(&wt.branch)
}

fn recorded_branch(feature: &FeatureInput) -> Option<String> {
    feature
        .worktree_branch
        .as_deref()
        .and_then(branch_identity)
        .or_else(|| feature.feature_branch.as_deref().and_then(branch_identity))
}

fn linked_entries(linked_rows: Vec<ActiveLinkedBranchRow>) -> Vec<super::TrackedBranch> {
    linked_rows
        .into_iter()
        .map(|row| linked_branch_entry(row.branch, row.pr_number, row.pr_state))
        .collect()
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Arc;

    use sqlx::sqlite::SqlitePoolOptions;

    use super::*;
    use crate::domain::git::host::GitHost;

    fn run_git(dir: &Path, args: &[&str]) {
        let out = std::process::Command::new("git")
            .args(args)
            .current_dir(dir)
            .env("GIT_CONFIG_NOSYSTEM", "1")
            .env("HOME", dir)
            .output()
            .expect("git spawn");
        assert!(
            out.status.success(),
            "git {} failed: {}",
            args.join(" "),
            String::from_utf8_lossy(&out.stderr)
        );
    }

    async fn setup_pool() -> SqlitePool {
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .unwrap();
        for sql in [
            "CREATE TABLE projects (id INTEGER PRIMARY KEY, name TEXT, path TEXT)",
            "CREATE TABLE features (id INTEGER PRIMARY KEY, project_id INTEGER NOT NULL, title TEXT, status TEXT NOT NULL DEFAULT 'active')",
            "CREATE TABLE feature_settings (feature_id INTEGER, key TEXT, value TEXT, PRIMARY KEY (feature_id, key))",
            crate::domain::git::linked_branches::repository::TEST_SCHEMA,
        ] {
            sqlx::query(sql).execute(&pool).await.unwrap();
        }
        pool
    }

    #[tokio::test]
    async fn batches_multiple_features_in_one_project_with_a_single_git_probe() {
        let temp = tempfile::tempdir().unwrap();
        let repo = temp.path().join("repo");
        let wt1 = temp.path().join("wt1");
        std::fs::create_dir(&repo).unwrap();
        run_git(&repo, &["init", "-q", "-b", "main"]);
        run_git(&repo, &["config", "user.email", "t@t"]);
        run_git(&repo, &["config", "user.name", "T"]);
        run_git(&repo, &["config", "commit.gpgsign", "false"]);
        std::fs::write(repo.join("a.txt"), "a\n").unwrap();
        run_git(&repo, &["add", "."]);
        run_git(&repo, &["commit", "-q", "-m", "init"]);
        run_git(
            &repo,
            &[
                "remote",
                "add",
                "origin",
                "https://github.com/acme/demo.git",
            ],
        );
        run_git(
            &repo,
            &[
                "worktree",
                "add",
                "-q",
                "-b",
                "feature/old",
                wt1.to_str().unwrap(),
            ],
        );
        // Feature 1 switched branches inside its own worktree.
        run_git(&wt1, &["checkout", "-q", "-b", "feature/switched"]);

        let pool = setup_pool().await;
        sqlx::query("INSERT INTO projects (id, name, path) VALUES (1, 'demo', ?)")
            .bind(repo.to_str().unwrap())
            .execute(&pool)
            .await
            .unwrap();
        sqlx::query(
            "INSERT INTO features (id, project_id, title, status) VALUES
                (1, 1, 'own-worktree', 'active'),
                (2, 1, 'from-branch', 'active'),
                (3, 1, 'on-branch', 'active'),
                (4, 1, 'archived', 'archived')",
        )
        .execute(&pool)
        .await
        .unwrap();
        for (fid, key, value) in [
            (1, "worktree_path", wt1.to_str().unwrap()),
            (1, "worktree_branch", "feature/old"),
            (2, "feature_branch", "feature/from-branch"),
            (4, "feature_branch", "feature/archived"),
        ] {
            sqlx::query("INSERT INTO feature_settings (feature_id, key, value) VALUES (?, ?, ?)")
                .bind(fid)
                .bind(key)
                .bind(value)
                .execute(&pool)
                .await
                .unwrap();
        }
        sqlx::query(
            "INSERT INTO feature_branches (feature_id, branch, origin, pr_number, pr_state) \
             VALUES (1, 'feature/old', 'provisioned', 42, 'open')",
        )
        .execute(&pool)
        .await
        .unwrap();

        let probe_calls = Arc::new(AtomicUsize::new(0));
        let targets = targets_with_probe(&pool, Scope::Active, &|project_path| {
            let probe_calls = Arc::clone(&probe_calls);
            async move {
                probe_calls.fetch_add(1, Ordering::SeqCst);
                inspect_project_git(project_path).await
            }
        })
        .await
        .unwrap();

        assert_eq!(
            probe_calls.load(Ordering::SeqCst),
            1,
            "per-project worktree/remote lookup must run once for all features in the project"
        );
        assert_eq!(targets.len(), 3, "archived feature must be excluded");

        // Feature 1: own worktree follows checked-out `feature/switched`, keeps
        // linked `feature/old` with stored PR #42.
        let t1 = &targets[0];
        assert_eq!(t1.feature_id, 1);
        assert_eq!(t1.branch.as_deref(), Some("feature/switched"));
        assert_eq!(t1.tracked.len(), 2);
        assert_eq!(t1.tracked[0].name, "feature/switched");
        assert!(!t1.tracked[0].linked);
        assert_eq!(t1.tracked[1].name, "feature/old");
        assert!(t1.tracked[1].linked);
        assert_eq!(t1.tracked[1].stored_pr, Some((42, "open".into())));
        assert_eq!(t1.remote.as_ref().map(|r| r.host), Some(GitHost::GitHub));

        // Feature 2: worktree-free "From branch" stays bound to `feature/from-branch`
        // even though project HEAD is `main`.
        let t2 = &targets[1];
        assert_eq!(t2.feature_id, 2);
        assert_eq!(t2.branch.as_deref(), Some("feature/from-branch"));
        assert_eq!(t2.tracked.len(), 1);
        assert_eq!(t2.tracked[0].name, "feature/from-branch");
        assert!(t2.tracked[0].linked);
        assert_eq!(t2.remote.as_ref().map(|r| r.repo.as_str()), Some("demo"));

        // Feature 3: "On branch" follows project HEAD (`main`), unlinked.
        let t3 = &targets[2];
        assert_eq!(t3.feature_id, 3);
        assert_eq!(t3.branch.as_deref(), Some("main"));
        assert_eq!(t3.tracked.len(), 1);
        assert_eq!(t3.tracked[0].name, "main");
        assert!(!t3.tracked[0].linked);
    }

    /// A repository committed on `main`, without remotes.
    fn init_repo_with_origin(repo: &Path) {
        std::fs::create_dir_all(repo).unwrap();
        run_git(repo, &["init", "-q", "-b", "main"]);
        run_git(repo, &["config", "user.email", "t@t"]);
        run_git(repo, &["config", "user.name", "T"]);
        run_git(repo, &["config", "commit.gpgsign", "false"]);
        std::fs::write(repo.join("a.txt"), "a\n").unwrap();
        run_git(repo, &["add", "."]);
        run_git(repo, &["commit", "-q", "-m", "init"]);
    }

    async fn insert_feature(pool: &SqlitePool, id: i64, settings: &[(&str, &str)]) {
        sqlx::query(
            "INSERT INTO features (id, project_id, title, status) VALUES (?, 1, 't', 'active')",
        )
        .bind(id)
        .execute(pool)
        .await
        .unwrap();
        for (key, value) in settings {
            sqlx::query("INSERT INTO feature_settings (feature_id, key, value) VALUES (?, ?, ?)")
                .bind(id)
                .bind(key)
                .bind(value)
                .execute(pool)
                .await
                .unwrap();
        }
    }

    fn summary(target: &FeatureForgeTarget) -> (Option<String>, Vec<String>, Option<String>) {
        (
            target.branch.clone(),
            target.tracked.iter().map(|b| b.name.clone()).collect(),
            target
                .remote
                .as_ref()
                .map(|r| format!("{}/{}", r.owner, r.repo)),
        )
    }

    /// The HTTP routes' single-feature resolution and the poller's batch
    /// agree on every edge case, because they are the same code.
    #[tokio::test]
    async fn single_feature_resolution_matches_the_batch_on_edge_cases() {
        let temp = tempfile::tempdir().unwrap();
        let repo = temp.path().join("repo");
        init_repo_with_origin(&repo);
        let path = |name: &str| temp.path().join(name).to_str().unwrap().to_string();
        // A remote added from inside a linked worktree lands in the shared
        // repository config.
        run_git(
            &repo,
            &["worktree", "add", "-q", "-b", "feature/live", &path("live")],
        );
        run_git(
            &temp.path().join("live"),
            &[
                "remote",
                "add",
                "origin",
                "https://github.com/acme/demo.git",
            ],
        );
        run_git(
            &repo,
            &[
                "worktree",
                "add",
                "-q",
                "-b",
                "feature/detached",
                &path("detached"),
            ],
        );
        run_git(
            &temp.path().join("detached"),
            &["checkout", "-q", "--detach"],
        );
        std::fs::create_dir(temp.path().join("unregistered")).unwrap();
        run_git(&repo, &["branch", "fix/linked"]);
        run_git(&repo, &["checkout", "-q", "fix/linked"]);

        let pool = setup_pool().await;
        sqlx::query("INSERT INTO projects (id, name, path) VALUES (1, 'demo', ?)")
            .bind(repo.to_str().unwrap())
            .execute(&pool)
            .await
            .unwrap();
        let (live, detached, gone, unregistered) = (
            path("live"),
            path("detached"),
            path("gone"),
            path("unregistered"),
        );
        insert_feature(
            &pool,
            1,
            &[
                ("worktree_path", &live),
                ("worktree_branch", "feature/live"),
            ],
        )
        .await;
        insert_feature(
            &pool,
            2,
            &[
                ("worktree_path", &detached),
                ("worktree_branch", "feature/detached"),
            ],
        )
        .await;
        insert_feature(
            &pool,
            3,
            &[
                ("worktree_path", &gone),
                ("worktree_branch", "feature/gone"),
            ],
        )
        .await;
        insert_feature(
            &pool,
            4,
            &[
                ("worktree_path", &unregistered),
                ("worktree_branch", "feature/residual"),
            ],
        )
        .await;
        insert_feature(&pool, 5, &[("feature_branch", "feature/from-branch")]).await;
        sqlx::query(
            "INSERT INTO feature_branches (feature_id, branch, origin) VALUES (5, 'fix/linked', 'observed')",
        )
        .execute(&pool)
        .await
        .unwrap();

        let batch = active_feature_targets(&pool).await.unwrap();
        let remote = Some("acme/demo".to_string());
        let expected = [
            (Some("feature/live"), vec!["feature/live"]),
            // Detached HEAD in its own worktree: the recorded branch.
            (Some("feature/detached"), vec!["feature/detached"]),
            // Deleted or unregistered worktree: the recorded branch, not the
            // project checkout.
            (Some("feature/gone"), vec!["feature/gone"]),
            (Some("feature/residual"), vec!["feature/residual"]),
            // The project checkout is one of the feature's linked branches.
            (
                Some("fix/linked"),
                vec!["fix/linked", "feature/from-branch"],
            ),
        ];
        for (target, (branch, tracked)) in batch.iter().zip(expected) {
            let single = feature_target(&pool, target.feature_id).await;
            assert!(single.error.is_none(), "{:?}", single.error);
            assert_eq!(
                summary(&single),
                summary(target),
                "feature {}",
                target.feature_id
            );
            assert_eq!(
                summary(target),
                (
                    branch.map(str::to_string),
                    tracked.into_iter().map(str::to_string).collect(),
                    remote.clone()
                ),
                "feature {}",
                target.feature_id
            );
        }
        assert_eq!(batch.len(), 5);

        let missing = feature_target(&pool, 99).await;
        assert_eq!(
            missing.error.as_deref(),
            Some("Not found: No repository found for feature 99")
        );
    }
}
