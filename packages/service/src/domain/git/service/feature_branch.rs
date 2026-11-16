//! Resolution of "the branch this feature is bound to".
//!
//! Three provisioning modes record their branch differently, and every git
//! surface that answers "what branch is this conversation working on?" has to
//! agree on the order:
//!
//! 0. The feature's own worktree's checkout. `worktree_branch` only names the
//!    branch the worktree was created on; an agent may switch branches in it.
//! 1. `worktree_branch` — written when a worktree is provisioned. It survives
//!    the worktree being removed (only `worktree_path` is deleted), which is
//!    deliberate: a deleted worktree whose branch still exists must keep
//!    reporting its own pull request, not the project checkout's.
//! 2. `feature_branch` — written by the worktree-free "From branch" flow. The
//!    branch is checked out in the project directory itself, so as soon as the
//!    user (or another feature) moves that checkout, the live HEAD stops being
//!    this conversation's branch.
//! 3. The resolved path's current branch — the "On branch" mode, where the
//!    feature genuinely follows whatever the project has checked out.
//!
//! The recorded branch is only the one a feature was *provisioned* with. A
//! conversation can work on several (see [`crate::domain::git::linked_branches`]),
//! so outside its own worktree, when the live checkout is one of its linked
//! branches, that checkout is the current branch — the header and the forge poller agree on it instead of
//! the poller sticking to the provisioned branch the agent has since left.
//!
//! Without step 2 the forge poller matched pull requests against the project
//! checkout's HEAD — usually `main` — for every "From branch" feature.

use std::path::Path;

use sqlx::SqlitePool;

use super::{
    normalize_git_path, SETTING_FEATURE_BRANCH, SETTING_WORKTREE_BRANCH, SETTING_WORKTREE_PATH,
};
use crate::domain::git::refs::normalize_branch_identity;
use crate::domain::git::{commands, linked_branches, repository, workflow_service};
use crate::error::AppError;

pub const HEAD_REVISION: &str = "HEAD";

/// A branch identity we are willing to hand out, or `None` for anything that
/// isn't one: blank settings, a bare `refs/heads/` prefix, the literal `HEAD`
/// that `git rev-parse --abbrev-ref` reports for a detached checkout, and any
/// value git would read as a flag (these reach `git log` as positionals).
pub fn branch_identity(value: &str) -> Option<String> {
    let branch = normalize_branch_identity(value);
    if branch.is_empty() || branch == HEAD_REVISION || branch.starts_with('-') {
        return None;
    }
    Some(branch.to_string())
}

/// The branch recorded for `feature_id` by whichever flow provisioned it, with
/// no fallback to the live checkout.
///
/// An unusable recorded value falls through to the next key rather than
/// resolving to nothing — a corrupt `worktree_branch` shouldn't blind a
/// feature that also recorded a `feature_branch`.
pub async fn recorded_feature_branch(
    read_pool: &SqlitePool,
    feature_id: i64,
) -> Result<Option<String>, AppError> {
    for key in [SETTING_WORKTREE_BRANCH, SETTING_FEATURE_BRANCH] {
        let recorded = repository::get_feature_setting(read_pool, feature_id, key).await?;
        if let Some(branch) = recorded.as_deref().and_then(branch_identity) {
            return Ok(Some(branch));
        }
    }
    Ok(None)
}

/// The branch bound to `feature_id` (see the module docs for the order), or
/// `None` when nothing usable is recorded and `path` has no branch checked out
/// (detached HEAD, fresh repo).
pub async fn resolve_feature_branch(
    read_pool: &SqlitePool,
    feature_id: i64,
    path: &Path,
) -> Result<Option<String>, AppError> {
    let checked_out = checked_out_branch(path).await?;
    current_feature_branch(read_pool, feature_id, path, checked_out).await
}

/// The conversation's current branch given what is checked out at `path`: the
/// checkout when `path` is the feature's own worktree or the checkout is one of
/// the conversation's branches, otherwise the recorded branch, otherwise the
/// checkout ("On branch" mode follows it).
pub async fn current_feature_branch(
    read_pool: &SqlitePool,
    feature_id: i64,
    path: &Path,
    checked_out: Option<String>,
) -> Result<Option<String>, AppError> {
    let Some(head) = checked_out.as_deref() else {
        return recorded_feature_branch(read_pool, feature_id).await;
    };
    // Ownership first: nobody else switches branches in the feature's worktree.
    if is_own_worktree(read_pool, feature_id, path).await? {
        return Ok(checked_out);
    }
    let recorded = recorded_feature_branch(read_pool, feature_id).await?;
    let key = linked_branches::BranchRef {
        feature_id,
        branch: head,
    };
    if recorded.as_deref() == Some(head)
        || linked_branches::repository::is_linked(read_pool, key).await?
    {
        return Ok(checked_out);
    }
    Ok(recorded.or(checked_out))
}

/// True when `path` is the worktree provisioned for `feature_id` rather than
/// the project directory the resolvers fall back to once it is gone. Git
/// endpoints pass the checkout root, which for a monorepo project's worktree is
/// the linked worktree holding the recorded subdirectory, so it counts too.
pub async fn is_own_worktree(
    read_pool: &SqlitePool,
    feature_id: i64,
    path: &Path,
) -> Result<bool, AppError> {
    // One query: every git status recompute asks this.
    let row: Option<(String, String)> = sqlx::query_as(
        "SELECT fs.value, p.path FROM feature_settings fs \
         JOIN features f ON f.id = fs.feature_id \
         JOIN projects p ON p.id = f.project_id \
         WHERE fs.feature_id = ? AND fs.key = ?",
    )
    .bind(feature_id)
    .bind(SETTING_WORKTREE_PATH)
    .fetch_optional(read_pool)
    .await?;
    let Some((worktree, project_path)) = row else {
        return Ok(false);
    };
    let path = normalize_git_path(&path.to_string_lossy());
    if normalize_git_path(&project_path) == path {
        return Ok(false);
    }
    let worktree = normalize_git_path(&worktree);
    Ok(worktree == path
        || linked_worktree_root(Path::new(&worktree)).is_some_and(|root| root == Path::new(&path)))
}

/// The linked worktree root holding `dir`: its nearest ancestor with Git
/// metadata, when that metadata is a linked worktree's `.git` file. The main
/// checkout's `.git` directory is never a feature's own worktree.
fn linked_worktree_root(dir: &Path) -> Option<&Path> {
    let root = dir
        .ancestors()
        .find(|ancestor| ancestor.join(".git").symlink_metadata().is_ok())?;
    root.join(".git").is_file().then_some(root)
}

async fn checked_out_branch(path: &Path) -> Result<Option<String>, AppError> {
    Ok(commands::get_current_branch(path)
        .await?
        .as_deref()
        .and_then(branch_identity))
}

/// The branch a feature is bound to plus the revision its history views must
/// read — resolved together because the two answers share the settings lookup
/// and the `git rev-parse` of the live checkout.
pub struct FeatureScope {
    /// The branch this conversation works on, for labels and comparisons.
    pub branch: Option<String>,
    /// What to hand `git log` / `git rev-list` for this feature.
    pub revision: String,
}

/// Resolve [`FeatureScope`] with one settings pass and one `git rev-parse`.
///
/// `HEAD` is only the right revision while the bound branch is the one checked
/// out at `path`. A feature whose worktree was removed, or a worktree-free
/// "From branch" feature whose project checkout has since moved on, is bound to
/// a branch that still exists as a ref but is no longer `HEAD` — reading `HEAD`
/// there silently reports another branch's commits as this conversation's.
///
/// Falls back to `HEAD` when the bound branch no longer exists locally (the
/// user deleted it), since a missing ref would fail every git call instead.
pub async fn resolve_feature_scope(
    read_pool: &SqlitePool,
    feature_id: i64,
    path: &Path,
) -> Result<FeatureScope, AppError> {
    let checked_out = checked_out_branch(path).await?;
    let branch = current_feature_branch(read_pool, feature_id, path, checked_out.clone()).await?;
    let head_scope = FeatureScope {
        branch: branch.clone(),
        revision: HEAD_REVISION.to_string(),
    };
    let Some(bound) = branch else {
        return Ok(head_scope);
    };
    if checked_out.as_deref() == Some(bound.as_str())
        || !workflow_service::local_branch_exists(path, &bound).await
    {
        return Ok(head_scope);
    }
    Ok(FeatureScope {
        revision: bound.clone(),
        branch: Some(bound),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::git::service::test_support::setup_diff_refs_schema;

    async fn run_git(dir: &Path, args: &[&str]) {
        tokio::process::Command::new("git")
            .args(args)
            .current_dir(dir)
            .status()
            .await
            .unwrap();
    }

    async fn init_repo(dir: &Path) {
        for args in [
            vec!["init", "-q", "-b", "main"],
            vec!["config", "user.email", "t@example.com"],
            vec!["config", "user.name", "T"],
            vec!["config", "commit.gpgsign", "false"],
            vec!["commit", "--allow-empty", "-q", "-m", "init"],
        ] {
            run_git(dir, &args).await;
        }
    }

    #[tokio::test]
    async fn prefers_the_worktree_branch_over_the_checked_out_branch() {
        // The worktree-removed case: `worktree_path` is gone so callers resolve
        // the project directory, but the recorded branch must still win.
        let pool = setup_diff_refs_schema().await;
        let repo = tempfile::tempdir().unwrap();
        init_repo(repo.path()).await;
        repository::set_feature_setting(&pool, 1, SETTING_WORKTREE_BRANCH, "feature/removed-wt")
            .await
            .unwrap();

        let branch = resolve_feature_branch(&pool, 1, repo.path()).await.unwrap();

        assert_eq!(branch.as_deref(), Some("feature/removed-wt"));
    }

    #[tokio::test]
    async fn falls_back_to_the_project_branch_recorded_by_the_from_branch_flow() {
        let pool = setup_diff_refs_schema().await;
        let repo = tempfile::tempdir().unwrap();
        init_repo(repo.path()).await;
        repository::set_feature_setting(
            &pool,
            1,
            SETTING_FEATURE_BRANCH,
            "refs/heads/feature/forked",
        )
        .await
        .unwrap();

        let branch = resolve_feature_branch(&pool, 1, repo.path()).await.unwrap();

        assert_eq!(branch.as_deref(), Some("feature/forked"));
    }

    #[tokio::test]
    async fn falls_back_to_the_live_branch_when_nothing_is_recorded() {
        let pool = setup_diff_refs_schema().await;
        let repo = tempfile::tempdir().unwrap();
        init_repo(repo.path()).await;

        let branch = resolve_feature_branch(&pool, 1, repo.path()).await.unwrap();

        assert_eq!(branch.as_deref(), Some("main"));
    }

    #[tokio::test]
    async fn falls_through_a_recorded_value_that_normalizes_to_nothing() {
        let pool = setup_diff_refs_schema().await;
        let repo = tempfile::tempdir().unwrap();
        init_repo(repo.path()).await;
        repository::set_feature_setting(&pool, 1, SETTING_WORKTREE_BRANCH, "refs/heads/")
            .await
            .unwrap();
        repository::set_feature_setting(&pool, 1, SETTING_FEATURE_BRANCH, "feature/real")
            .await
            .unwrap();

        let branch = resolve_feature_branch(&pool, 1, repo.path()).await.unwrap();

        assert_eq!(branch.as_deref(), Some("feature/real"));
    }

    /// Project at `<tmp>/repo`, feature 1 with its own worktree at
    /// `<tmp>/wt` provisioned on `feature/old`, now switched to `feature/new`.
    struct SwitchedWorktree {
        pool: SqlitePool,
        project: std::path::PathBuf,
        worktree: std::path::PathBuf,
        _dir: tempfile::TempDir,
    }

    async fn switched_worktree() -> SwitchedWorktree {
        let pool = setup_diff_refs_schema().await;
        let dir = tempfile::tempdir().unwrap();
        let project = dir.path().join("repo");
        let worktree = dir.path().join("wt");
        std::fs::create_dir(&project).unwrap();
        init_repo(&project).await;
        let wt_arg = worktree.to_string_lossy().to_string();
        run_git(
            &project,
            &["worktree", "add", "-q", "-b", "feature/old", &wt_arg],
        )
        .await;
        run_git(&worktree, &["checkout", "-q", "-b", "feature/new"]).await;
        sqlx::query("INSERT INTO projects (id, name, path) VALUES (1, 'repo', ?)")
            .bind(project.to_string_lossy().as_ref())
            .execute(&pool)
            .await
            .unwrap();
        sqlx::query("INSERT INTO features (id, project_id, title) VALUES (1, 1, 'f')")
            .execute(&pool)
            .await
            .unwrap();
        repository::set_feature_setting(&pool, 1, SETTING_WORKTREE_PATH, &wt_arg)
            .await
            .unwrap();
        repository::set_feature_setting(&pool, 1, SETTING_WORKTREE_BRANCH, "feature/old")
            .await
            .unwrap();
        SwitchedWorktree {
            pool,
            project,
            worktree,
            _dir: dir,
        }
    }

    #[tokio::test]
    async fn the_feature_worktree_follows_its_checked_out_branch() {
        let fx = switched_worktree().await;

        let branch = resolve_feature_branch(&fx.pool, 1, &fx.worktree)
            .await
            .unwrap();
        let scope = resolve_feature_scope(&fx.pool, 1, &fx.worktree)
            .await
            .unwrap();

        assert_eq!(branch.as_deref(), Some("feature/new"));
        assert_eq!(scope.branch.as_deref(), Some("feature/new"));
        assert_eq!(scope.revision, HEAD_REVISION);
    }

    #[tokio::test]
    async fn a_monorepo_worktree_root_is_the_features_own_worktree() {
        // Git endpoints pass the checkout root (`wt`), not the recorded
        // subdirectory (`wt/packages/app`); ownership must survive that.
        let pool = setup_diff_refs_schema().await;
        let dir = tempfile::tempdir().unwrap();
        let repo = dir.path().join("repo");
        std::fs::create_dir(&repo).unwrap();
        init_repo(&repo).await;
        let worktree = dir.path().join("wt");
        let wt_arg = worktree.to_string_lossy().to_string();
        run_git(
            &repo,
            &["worktree", "add", "-q", "-b", "feature/old", &wt_arg],
        )
        .await;
        run_git(&worktree, &["checkout", "-q", "-b", "feature/new"]).await;
        let recorded = worktree.join("packages/app");
        std::fs::create_dir_all(&recorded).unwrap();
        std::fs::create_dir_all(repo.join("packages/app")).unwrap();
        sqlx::query("INSERT INTO projects (id, name, path) VALUES (1, 'app', ?)")
            .bind(repo.join("packages/app").to_string_lossy().as_ref())
            .execute(&pool)
            .await
            .unwrap();
        sqlx::query("INSERT INTO features (id, project_id, title) VALUES (1, 1, 'f')")
            .execute(&pool)
            .await
            .unwrap();
        let recorded_arg = recorded.to_string_lossy().to_string();
        repository::set_feature_setting(&pool, 1, SETTING_WORKTREE_PATH, &recorded_arg)
            .await
            .unwrap();
        repository::set_feature_setting(&pool, 1, SETTING_WORKTREE_BRANCH, "feature/old")
            .await
            .unwrap();

        for path in [&recorded, &worktree] {
            assert!(is_own_worktree(&pool, 1, path).await.unwrap(), "{path:?}");
            let branch = resolve_feature_branch(&pool, 1, path).await.unwrap();
            assert_eq!(branch.as_deref(), Some("feature/new"), "{path:?}");
        }
        // The main checkout the resolvers fall back to is never the feature's.
        assert!(!is_own_worktree(&pool, 1, &repo).await.unwrap());
    }

    #[tokio::test]
    async fn the_feature_worktree_follows_an_unlinked_checkout_of_the_trunk() {
        // The trunk is never linked to a conversation, yet it is what the
        // worktree has checked out: merging or comparing must start from it.
        let fx = switched_worktree().await;
        run_git(&fx.worktree, &["checkout", "-q", "--detach"]).await;
        run_git(&fx.project, &["checkout", "-q", "--detach"]).await;
        run_git(&fx.worktree, &["checkout", "-q", "main"]).await;

        let branch = resolve_feature_branch(&fx.pool, 1, &fx.worktree)
            .await
            .unwrap();

        assert_eq!(branch.as_deref(), Some("main"));
    }

    #[tokio::test]
    async fn the_project_directory_keeps_the_recorded_branch() {
        let fx = switched_worktree().await;

        let branch = resolve_feature_branch(&fx.pool, 1, &fx.project)
            .await
            .unwrap();

        assert_eq!(branch.as_deref(), Some("feature/old"));
    }

    #[tokio::test]
    async fn a_worktree_path_naming_the_project_keeps_the_recorded_branch() {
        let fx = switched_worktree().await;
        let project = fx.project.to_string_lossy();
        repository::set_feature_setting(&fx.pool, 1, SETTING_WORKTREE_PATH, &project)
            .await
            .unwrap();

        let branch = resolve_feature_branch(&fx.pool, 1, &fx.project)
            .await
            .unwrap();

        assert_eq!(branch.as_deref(), Some("feature/old"));
    }

    #[tokio::test]
    async fn a_detached_feature_worktree_falls_back_to_the_recorded_branch() {
        let fx = switched_worktree().await;
        run_git(&fx.worktree, &["checkout", "-q", "--detach"]).await;

        let branch = resolve_feature_branch(&fx.pool, 1, &fx.worktree)
            .await
            .unwrap();

        assert_eq!(branch.as_deref(), Some("feature/old"));
    }

    #[tokio::test]
    async fn reports_no_branch_for_a_detached_head() {
        let pool = setup_diff_refs_schema().await;
        let repo = tempfile::tempdir().unwrap();
        init_repo(repo.path()).await;
        run_git(repo.path(), &["checkout", "-q", "--detach"]).await;

        let branch = resolve_feature_branch(&pool, 1, repo.path()).await.unwrap();

        // `rev-parse --abbrev-ref` says "HEAD" here, which is not a branch.
        assert_eq!(branch, None);
    }

    #[tokio::test]
    async fn reads_head_while_the_bound_branch_is_the_one_checked_out() {
        let pool = setup_diff_refs_schema().await;
        let repo = tempfile::tempdir().unwrap();
        init_repo(repo.path()).await;
        repository::set_feature_setting(&pool, 1, SETTING_WORKTREE_BRANCH, "main")
            .await
            .unwrap();

        let scope = resolve_feature_scope(&pool, 1, repo.path()).await.unwrap();

        assert_eq!(scope.branch.as_deref(), Some("main"));
        assert_eq!(scope.revision, HEAD_REVISION);
    }

    #[tokio::test]
    async fn reads_the_bound_branch_once_the_checkout_moves_away() {
        let pool = setup_diff_refs_schema().await;
        let repo = tempfile::tempdir().unwrap();
        init_repo(repo.path()).await;
        run_git(repo.path(), &["branch", "feature/left-behind"]).await;
        repository::set_feature_setting(&pool, 1, SETTING_FEATURE_BRANCH, "feature/left-behind")
            .await
            .unwrap();

        let scope = resolve_feature_scope(&pool, 1, repo.path()).await.unwrap();

        assert_eq!(scope.branch.as_deref(), Some("feature/left-behind"));
        assert_eq!(scope.revision, "feature/left-behind");
    }

    #[tokio::test]
    async fn falls_back_to_head_when_the_bound_branch_was_deleted() {
        let pool = setup_diff_refs_schema().await;
        let repo = tempfile::tempdir().unwrap();
        init_repo(repo.path()).await;
        repository::set_feature_setting(&pool, 1, SETTING_WORKTREE_BRANCH, "feature/gone")
            .await
            .unwrap();

        let scope = resolve_feature_scope(&pool, 1, repo.path()).await.unwrap();

        // Reading a ref that no longer exists would fail every git call, but the
        // label still belongs to the branch the feature was provisioned with.
        assert_eq!(scope.branch.as_deref(), Some("feature/gone"));
        assert_eq!(scope.revision, HEAD_REVISION);
    }

    #[tokio::test]
    async fn refuses_a_recorded_branch_git_would_read_as_a_flag() {
        let pool = setup_diff_refs_schema().await;
        let repo = tempfile::tempdir().unwrap();
        init_repo(repo.path()).await;
        repository::set_feature_setting(&pool, 1, SETTING_WORKTREE_BRANCH, "--all")
            .await
            .unwrap();

        let scope = resolve_feature_scope(&pool, 1, repo.path()).await.unwrap();

        // It reaches `git log` as a positional; falling through to the live
        // branch is the only safe reading.
        assert_eq!(scope.branch.as_deref(), Some("main"));
        assert_eq!(scope.revision, HEAD_REVISION);
    }

    #[tokio::test]
    async fn reports_no_branch_and_head_for_a_detached_checkout_with_nothing_recorded() {
        let pool = setup_diff_refs_schema().await;
        let repo = tempfile::tempdir().unwrap();
        init_repo(repo.path()).await;
        run_git(repo.path(), &["checkout", "-q", "--detach"]).await;

        let scope = resolve_feature_scope(&pool, 1, repo.path()).await.unwrap();

        assert_eq!(scope.branch, None);
        assert_eq!(scope.revision, HEAD_REVISION);
    }

    #[tokio::test]
    async fn ignores_a_blank_recorded_branch() {
        let pool = setup_diff_refs_schema().await;
        let repo = tempfile::tempdir().unwrap();
        init_repo(repo.path()).await;
        repository::set_feature_setting(&pool, 1, SETTING_WORKTREE_BRANCH, "   ")
            .await
            .unwrap();

        let branch = resolve_feature_branch(&pool, 1, repo.path()).await.unwrap();

        assert_eq!(branch.as_deref(), Some("main"));
    }
}
