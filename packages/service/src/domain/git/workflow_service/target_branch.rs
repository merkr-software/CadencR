//! Target-branch persistence and the fallback chain for "what should we
//! compare against?". Split out of `status.rs` to keep both files under the
//! 400-line cap; the fallback logic deserves its own home anyway because it's
//! shared between the HTTP handler and the file-watcher's first-snapshot
//! computation.

use std::path::Path;

use crate::app_state::AppState;
use crate::domain::git::commands;
use crate::domain::git::linked_branches::{self, BranchOrigin, BranchRef};
use crate::domain::git::models::{SuccessResponse, UpdateTargetBranchBody};
use crate::domain::git::service::{
    branch_identity, recorded_feature_branch, resolve_feature_branch, resolve_feature_git_path,
};
use crate::error::AppError;
use crate::shared::git_cli::run_git;

use super::broadcast_after_write;

mod reference;
pub(crate) use reference::branch_exists;

/// Fallback chain for the compare target when the user hasn't picked one:
///
///   1. the explicit pick (stored verbatim — we never rewrite it): the one
///      for the conversation's current branch, else the conversation-wide
///      setting every branch shared before targets became per branch,
///   2. `branch.<head>.merge` upstream tracking — the branch the current
///      HEAD was set up to merge into,
///   3. **`origin/HEAD`** (resolved via `git symbolic-ref`) — the remote's
///      default branch, e.g. `origin/main`. Picked over local `main` on
///      purpose: it's the shared truth a stale local branch can't drift
///      from, and it's what GitHub/GitLab will compare a PR against,
///   4. local `main`,
///   5. local `master`,
///   6. literal `"main"` as a last-resort label.
///
/// We never error: if every probe fails we hand back `"main"` and let
/// `compute_status` set `ahead_of_target = 0` when the ref doesn't resolve.
///
/// Once the user picks a target for a branch — local `main` *or* remote
/// `origin/main` — that pick is stored verbatim and step 1 short-circuits
/// the rest. The fallback chain only runs for branches nobody picked for.
pub async fn resolve_target_branch(
    state: &AppState,
    feature_id: i64,
    repo: &Path,
) -> Result<String, AppError> {
    let has_git = crate::shared::git_context::has_git_metadata(repo).await?;
    // Targets are per branch: the conversation's current branch picks its own.
    let branch = if has_git {
        resolve_feature_branch(&state.read_pool, feature_id, repo).await?
    } else {
        None
    };
    if let Some(stored) =
        linked_branches::configured_target(&state.read_pool, feature_id, branch.as_deref()).await?
    {
        return Ok(stored);
    }

    if !has_git {
        return Ok("main".to_string());
    }

    // Tracking config: `branch.<head>.merge` points at the upstream this
    // branch was set up to merge into. When present it's the single best
    // signal — beats every heuristic below.
    // `None` is a detached HEAD: nothing tracks anything.
    if let Some(head) = branch {
        if let Ok(branch) = commands::get_original_branch(repo, &head).await {
            return Ok(branch);
        }
    }

    // Remote default branch — `git symbolic-ref refs/remotes/origin/HEAD`
    // gives `refs/remotes/origin/<name>`. We keep the `origin/` prefix so
    // the snapshot's `ahead_of_target` reflects the remote's tip, not a
    // potentially stale local copy of the same branch.
    if let Ok(out) = run_git(&["symbolic-ref", "refs/remotes/origin/HEAD"], repo).await {
        let trimmed = out.trim();
        if let Some(short) = trimmed.strip_prefix("refs/remotes/") {
            if !short.is_empty() {
                return Ok(short.to_string());
            }
        }
    }

    if run_git(&["rev-parse", "--verify", "main"], repo)
        .await
        .is_ok()
    {
        return Ok("main".to_string());
    }
    if run_git(&["rev-parse", "--verify", "master"], repo)
        .await
        .is_ok()
    {
        return Ok("master".to_string());
    }
    Ok("main".to_string())
}

pub async fn update_target_branch(
    state: &AppState,
    feature_id: i64,
    body: UpdateTargetBranchBody,
) -> Result<SuccessResponse, AppError> {
    let target = body.target_branch.trim();
    if target.is_empty() {
        return Err(AppError::BadRequest("target_branch is required".into()));
    }
    if target.starts_with('-') {
        return Err(AppError::BadRequest(
            "target_branch must not start with '-'".into(),
        ));
    }

    let git_path = resolve_feature_git_path(state, feature_id)
        .await?
        .ok_or_else(|| AppError::NotFound(format!("feature {feature_id} has no git path")))?;
    let repo = Path::new(&git_path);

    if !branch_exists(repo, target).await? {
        return Err(AppError::BadRequest(format!(
            "branch '{target}' does not resolve locally or on origin"
        )));
    }

    let branch = match body.branch.as_deref().and_then(branch_identity) {
        Some(branch) => branch,
        None => resolve_feature_branch(&state.read_pool, feature_id, repo)
            .await?
            .ok_or_else(|| {
                AppError::BadRequest("this conversation has no branch to set a target for".into())
            })?,
    };
    let recorded = recorded_feature_branch(&state.read_pool, feature_id).await?;
    let origin = if recorded.as_deref() == Some(branch.as_str()) {
        BranchOrigin::Provisioned
    } else {
        BranchOrigin::Manual
    };
    let key = BranchRef {
        feature_id,
        branch: &branch,
    };
    linked_branches::repository::set_target(&state.write_pool, key, origin, target).await?;

    // The new target changes `ahead_of_target` and the compare URL — push a
    // refreshed snapshot so any open WS sessions update without waiting for
    // the next fs event. Best-effort, same pattern as commit/push.
    broadcast_after_write(state, feature_id).await;

    Ok(SuccessResponse {
        success: true,
        error: None,
        blocked_reason: None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::git::repository;
    use sqlx::sqlite::SqlitePoolOptions;
    use sqlx::SqlitePool;

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
            "CREATE TABLE features (id INTEGER PRIMARY KEY, project_id INTEGER NOT NULL, title TEXT, type TEXT NOT NULL DEFAULT 'ws-session')",
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
        sqlx::query(linked_branches::repository::TEST_SCHEMA)
            .execute(&pool)
            .await
            .unwrap();
        pool
    }

    pub(super) fn run_git_for_test(dir: &std::path::Path, args: &[&str]) {
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

    #[tokio::test]
    async fn resolve_target_branch_prefers_explicit_setting() {
        let pool = setup_schema().await;
        sqlx::query("INSERT INTO features (id, project_id, title) VALUES (1, 1, 'feat')")
            .execute(&pool)
            .await
            .unwrap();
        repository::set_feature_setting(&pool, 1, "target_branch", "develop")
            .await
            .unwrap();

        let dir = tempfile::tempdir().unwrap();
        let state = AppState::with_pool(pool);
        let target = resolve_target_branch(&state, 1, dir.path()).await.unwrap();
        assert_eq!(target, "develop");
    }

    #[tokio::test]
    async fn resolve_target_branch_treats_blank_setting_as_unset() {
        let pool = setup_schema().await;
        sqlx::query("INSERT INTO features (id, project_id, title) VALUES (1, 1, 'feat')")
            .execute(&pool)
            .await
            .unwrap();
        repository::set_feature_setting(&pool, 1, "target_branch", "   ")
            .await
            .unwrap();

        // No git repo at this path → all detection paths fail → final fallback.
        let dir = tempfile::tempdir().unwrap();
        let state = AppState::with_pool(pool);
        let target = resolve_target_branch(&state, 1, dir.path()).await.unwrap();
        assert_eq!(target, "main");
    }

    #[tokio::test]
    async fn resolve_target_branch_prefers_origin_head_over_local_main() {
        // Default fallback for a fresh feature must land on `origin/main`
        // (the remote's default), not local `main`. This is what makes the
        // user's `4 commits ahead` bug self-resolve once they don't even
        // need to pick anything explicit: by default we already point at
        // the remote-tracking ref, so a stale local main can't bias the
        // count.
        let pool = setup_schema().await;
        sqlx::query("INSERT INTO features (id, project_id, title) VALUES (1, 1, 'feat')")
            .execute(&pool)
            .await
            .unwrap();

        let dir = tempfile::tempdir().unwrap();
        run_git_for_test(dir.path(), &["init", "-q", "-b", "main"]);
        run_git_for_test(dir.path(), &["config", "user.email", "t@t"]);
        run_git_for_test(dir.path(), &["config", "user.name", "T"]);
        run_git_for_test(dir.path(), &["commit", "--allow-empty", "-q", "-m", "init"]);
        // Detach HEAD so the tracking-config branch (step 2) doesn't fire and
        // we exercise the `origin/HEAD` step directly.
        run_git_for_test(dir.path(), &["checkout", "-q", "--detach"]);

        // Synthesize the `refs/remotes/origin/HEAD` symbolic ref. We don't
        // need an actual remote for this — `symbolic-ref` only cares that
        // the target exists, and we point it at a fake `origin/main` we
        // create out of the current commit.
        run_git_for_test(
            dir.path(),
            &["update-ref", "refs/remotes/origin/main", "HEAD"],
        );
        run_git_for_test(
            dir.path(),
            &[
                "symbolic-ref",
                "refs/remotes/origin/HEAD",
                "refs/remotes/origin/main",
            ],
        );

        let state = AppState::with_pool(pool);
        let target = resolve_target_branch(&state, 1, dir.path()).await.unwrap();
        assert_eq!(
            target, "origin/main",
            "default target must keep the `origin/` prefix so a stale local \
             main doesn't bias ahead-of-target counts"
        );
    }

    #[tokio::test]
    async fn resolve_target_branch_ignores_pushed_feature_self_upstream() {
        let pool = setup_schema().await;
        sqlx::query("INSERT INTO features (id, project_id, title) VALUES (1, 1, 'feat')")
            .execute(&pool)
            .await
            .unwrap();

        let dir = tempfile::tempdir().unwrap();
        run_git_for_test(dir.path(), &["init", "-q", "-b", "main"]);
        run_git_for_test(dir.path(), &["config", "user.email", "t@t"]);
        run_git_for_test(dir.path(), &["config", "user.name", "T"]);
        run_git_for_test(dir.path(), &["commit", "--allow-empty", "-q", "-m", "init"]);
        run_git_for_test(
            dir.path(),
            &["update-ref", "refs/remotes/origin/main", "HEAD"],
        );
        run_git_for_test(
            dir.path(),
            &[
                "symbolic-ref",
                "refs/remotes/origin/HEAD",
                "refs/remotes/origin/main",
            ],
        );
        run_git_for_test(dir.path(), &["checkout", "-q", "-b", "feature/x"]);
        run_git_for_test(dir.path(), &["config", "branch.feature/x.remote", "origin"]);
        run_git_for_test(
            dir.path(),
            &["config", "branch.feature/x.merge", "refs/heads/feature/x"],
        );

        let state = AppState::with_pool(pool);
        let target = resolve_target_branch(&state, 1, dir.path()).await.unwrap();
        assert_eq!(target, "origin/main");
    }

    #[tokio::test]
    async fn resolve_target_branch_falls_back_to_master_when_main_missing() {
        // Real git repo with `master` but no `main`. The fallback chain
        // `setting → original-branch → main → master → main` should land on
        // `master` here.
        let pool = setup_schema().await;
        sqlx::query("INSERT INTO features (id, project_id, title) VALUES (1, 1, 'feat')")
            .execute(&pool)
            .await
            .unwrap();

        let dir = tempfile::tempdir().unwrap();
        run_git_for_test(dir.path(), &["init", "-q", "-b", "master"]);
        run_git_for_test(dir.path(), &["config", "user.email", "t@t"]);
        run_git_for_test(dir.path(), &["config", "user.name", "T"]);
        run_git_for_test(dir.path(), &["commit", "--allow-empty", "-q", "-m", "init"]);
        // Detach HEAD so `get_original_branch` can't easily resolve and we
        // fall through to the main/master probes.
        run_git_for_test(dir.path(), &["checkout", "-q", "--detach"]);

        let state = AppState::with_pool(pool);
        let target = resolve_target_branch(&state, 1, dir.path()).await.unwrap();
        assert_eq!(target, "master");
    }

    fn repo_on(branches: &[&str]) -> tempfile::TempDir {
        let dir = tempfile::tempdir().unwrap();
        run_git_for_test(dir.path(), &["init", "-q", "-b", "main"]);
        run_git_for_test(dir.path(), &["config", "user.email", "t@t"]);
        run_git_for_test(dir.path(), &["config", "user.name", "T"]);
        run_git_for_test(dir.path(), &["commit", "--allow-empty", "-q", "-m", "init"]);
        for branch in branches {
            run_git_for_test(dir.path(), &["branch", branch]);
        }
        dir
    }

    #[tokio::test]
    async fn each_linked_branch_keeps_its_own_target() {
        let pool = setup_schema().await;
        let dir = repo_on(&["feature/a", "fix/b", "develop"]);
        let path = dir.path().to_string_lossy().to_string();
        sqlx::query("INSERT INTO projects (id, name, path) VALUES (1, 'p', ?)")
            .bind(&path)
            .execute(&pool)
            .await
            .unwrap();
        sqlx::query("INSERT INTO features (id, project_id, title) VALUES (1, 1, 'feat')")
            .execute(&pool)
            .await
            .unwrap();
        repository::set_feature_setting(&pool, 1, "feature_branch", "feature/a")
            .await
            .unwrap();
        repository::set_feature_setting(&pool, 1, "target_branch", "main")
            .await
            .unwrap();
        let state = AppState::with_pool(pool);
        let pick = |branch: &str, target: &str| UpdateTargetBranchBody {
            target_branch: target.to_string(),
            branch: Some(branch.to_string()),
        };
        update_target_branch(&state, 1, pick("fix/b", "feature/a"))
            .await
            .unwrap();
        update_target_branch(&state, 1, pick("feature/a", "develop"))
            .await
            .unwrap();

        // `fix/b` is now linked, so checking it out makes it current, with
        // its own target; switching back restores the provisioned branch's.
        run_git_for_test(dir.path(), &["checkout", "-q", "fix/b"]);
        let target = resolve_target_branch(&state, 1, dir.path()).await.unwrap();
        assert_eq!(target, "feature/a");
        run_git_for_test(dir.path(), &["checkout", "-q", "main"]);
        let target = resolve_target_branch(&state, 1, dir.path()).await.unwrap();
        assert_eq!(
            target, "develop",
            "main is not linked: feature/a stays current"
        );
    }
}
