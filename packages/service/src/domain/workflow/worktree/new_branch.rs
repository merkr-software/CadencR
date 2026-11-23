//! Helpers for the `WorktreeMode::New` provisioning path: deriving the
//! branch name (and persisting it so retries don't churn) plus running
//! `git worktree add` with optional base-branch fork point.

use std::path::Path;

use sqlx::SqlitePool;

use crate::domain::features::title::is_default_title;
use crate::shared::git_cli::run_git_safe_refs;

use super::branch::build_branch_name;
use super::db::{get_setting, set_setting};

/// Get-or-derive the new branch name for the `New` mode. Persists the
/// generated name immediately so retries don't make a fresh one each time.
pub(super) async fn ensure_new_branch_name(
    read_pool: &SqlitePool,
    write_pool: &SqlitePool,
    feature_id: i64,
    project_id: i64,
) -> Result<String, String> {
    if let Some(b) = get_setting(read_pool, feature_id, "worktree_branch")
        .await
        .map_err(|e| e.to_string())?
    {
        return Ok(b);
    }
    let name = derive_branch_name(read_pool, feature_id, project_id).await?;
    // Unsaved, a retry would derive a new branch and orphan this one.
    set_setting(write_pool, feature_id, "worktree_branch", &name).await?;
    Ok(name)
}

/// Derive a fresh branch name from the project's `branch_prefix` and the
/// feature title — `{prefix}{slug}-{hex}`. Pure-ish: reads settings but
/// persists nothing, so callers that don't want a worktree (the project-path
/// "From branch" flow) don't leave a `worktree_branch` row behind that the UI
/// would read as "this feature has a worktree".
pub(super) async fn derive_branch_name(
    read_pool: &SqlitePool,
    feature_id: i64,
    project_id: i64,
) -> Result<String, String> {
    // `branch_prefix` is a project setting and now lives in the JSON settings
    // store (the legacy `project_settings` row is kept only as a backup).
    let prefix = crate::domain::settings_store::project_get(read_pool, project_id, "branch_prefix")
        .await
        .map_err(|e| format!("error looking up branch_prefix: {e}"))?
        .filter(|v| !v.trim().is_empty())
        .unwrap_or_else(|| "feature/".to_string());

    let title = sqlx::query_as::<_, (String,)>("SELECT title FROM features WHERE id = ?")
        .bind(feature_id)
        .fetch_optional(read_pool)
        .await
        .map_err(|e| format!("DB error looking up feature title: {e}"))?
        .map(|r| r.0)
        .unwrap_or_else(|| format!("feature-{feature_id}"));

    // Auto-naming runs synchronously before this on the prompt-send path, but
    // the LLM step can silently return `None` (timeout, empty extraction,
    // provider error). When that happens the title is still the
    // per-project counter "Session N" — slugifying that produces
    // `feature/session-N-xxxx`, which is meaningless and collides across
    // projects. Fall back to a stable feature-scoped slug instead so the
    // branch name doesn't lock in a bad value that the user has to manually
    // fix later.
    let slug_source = if is_default_title(&title) {
        format!("feature-{feature_id}")
    } else {
        title
    };
    Ok(build_branch_name(&prefix, &slug_source))
}

/// Run `git worktree add -b <branch> <path> [<base>]`. When `base` is set,
/// the new branch forks from that ref; otherwise from the project's current
/// HEAD. If the new branch already exists (race / retry), fall back to
/// attaching without `-b` (base is ignored in that case — the branch is
/// already at its tip and we're just reattaching).
pub(super) async fn add_new_worktree(
    project_dir: &str,
    branch: &str,
    path_str: &str,
    base: Option<&str>,
) -> Result<(), String> {
    let positional: Vec<&str> = match base {
        Some(b) => vec![path_str, b],
        None => vec![path_str],
    };
    match run_git_safe_refs(
        &["worktree", "add"],
        &["-b", branch],
        &positional,
        Path::new(project_dir),
    )
    .await
    {
        Ok(_) => Ok(()),
        Err(e) => {
            let msg = format!("{e}");
            if msg.contains("already exists") {
                run_git_safe_refs(
                    &["worktree", "add"],
                    &[],
                    &[path_str, branch],
                    Path::new(project_dir),
                )
                .await
                .map_err(|e2| format!("git worktree add failed: {e2}"))?;
                Ok(())
            } else {
                Err(format!("git worktree add failed: {msg}"))
            }
        }
    }
}

/// [`add_new_worktree`], adopting the worktree an earlier attempt already
/// created for `branch` (outside the project folder itself) when its record
/// could not be saved: retrying `git worktree add` there can only fail. The
/// branch is this feature's own (persisted, with a random suffix), so no other
/// feature's worktree can match. Returns the worktree path.
pub(super) async fn add_or_adopt_worktree(
    project_dir: &Path,
    branch: &str,
    path_str: String,
    base: Option<&str>,
) -> Result<String, String> {
    let attachments = crate::domain::git::commands::list_worktree_branches(project_dir)
        .await
        .map_err(|e| format!("failed to list worktrees: {e}"))?;
    if let Some(existing) = attachments
        .get(branch)
        .filter(|existing| !crate::shared::path_rebase::same_folder(existing, project_dir))
    {
        return Ok(existing.to_string_lossy().into_owned());
    }
    add_new_worktree(&project_dir.to_string_lossy(), branch, &path_str, base).await?;
    Ok(path_str)
}

/// Run `git checkout -b <branch> [<base>]` in the project directory itself —
/// the worktree-free "From branch" path (new branch, no worktree). When `base`
/// is set the new branch forks from that ref; otherwise from the current HEAD.
/// If the branch already exists (race / retry), fall back to a plain
/// `git checkout <branch>` so the operation is idempotent.
pub(super) async fn create_branch_in_project(
    project_dir: &str,
    branch: &str,
    base: Option<&str>,
) -> Result<(), String> {
    let positionals: Vec<&str> = match base {
        Some(b) => vec![b],
        None => vec![],
    };
    match run_git_safe_refs(
        &["checkout"],
        &["-b", branch],
        &positionals,
        Path::new(project_dir),
    )
    .await
    {
        Ok(_) => Ok(()),
        Err(e) => {
            let msg = format!("{e}");
            if msg.contains("already exists") {
                run_git_safe_refs(&["checkout"], &[], &[branch], Path::new(project_dir))
                    .await
                    .map_err(|e2| format!("git checkout failed: {e2}"))?;
                Ok(())
            } else {
                Err(format!("git checkout -b failed: {msg}"))
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    async fn init_repo(dir: &Path) {
        let _ = tokio::process::Command::new("git")
            .arg("init")
            .arg("-q")
            .current_dir(dir)
            .status()
            .await
            .unwrap();
        tokio::process::Command::new("git")
            .args(["config", "user.email", "t@example.com"])
            .current_dir(dir)
            .status()
            .await
            .unwrap();
        tokio::process::Command::new("git")
            .args(["config", "user.name", "T"])
            .current_dir(dir)
            .status()
            .await
            .unwrap();
        // Disable gpg signing locally so the test doesn't depend on the
        // developer's global `commit.gpgsign` state.
        tokio::process::Command::new("git")
            .args(["config", "commit.gpgsign", "false"])
            .current_dir(dir)
            .status()
            .await
            .unwrap();
        tokio::process::Command::new("git")
            .args(["config", "tag.gpgsign", "false"])
            .current_dir(dir)
            .status()
            .await
            .unwrap();
        tokio::process::Command::new("git")
            .args(["commit", "--allow-empty", "-m", "init"])
            .current_dir(dir)
            .status()
            .await
            .unwrap();
    }

    /// A first attempt created the worktree, then failed to record it. The
    /// retry used to run `git worktree add` again and fail forever.
    #[tokio::test]
    async fn a_retry_adopts_the_worktree_an_earlier_attempt_created() {
        let project = tempfile::tempdir().unwrap();
        let worktrees = tempfile::tempdir().unwrap();
        init_repo(project.path()).await;
        let path = worktrees.path().join("feat-a");
        let path_str = path.to_string_lossy().into_owned();
        add_new_worktree(
            &project.path().to_string_lossy(),
            "feat/a-1234",
            &path_str,
            None,
        )
        .await
        .unwrap();

        let adopted = add_or_adopt_worktree(project.path(), "feat/a-1234", path_str, None)
            .await
            .unwrap();

        let adopted = std::fs::canonicalize(adopted).unwrap();
        assert_eq!(adopted, std::fs::canonicalize(&path).unwrap());
    }

    #[tokio::test]
    async fn add_new_worktree_with_base_branch_forks_from_base() {
        // Set up a repo with two branches at different commits; verify that
        // passing `base = "develop"` makes the new worktree's branch start
        // from `develop`'s tip rather than `main`'s.
        let project = tempfile::tempdir().unwrap();
        init_repo(project.path()).await;

        // Resolve initial branch — `git init` may default to `main` or
        // `master` depending on user config.
        let initial = tokio::process::Command::new("git")
            .args(["rev-parse", "--abbrev-ref", "HEAD"])
            .current_dir(project.path())
            .output()
            .await
            .unwrap();
        let initial_branch = String::from_utf8(initial.stdout)
            .unwrap()
            .trim()
            .to_string();

        // Create `develop` and add a distinguishing commit.
        tokio::process::Command::new("git")
            .args(["checkout", "-q", "-b", "develop"])
            .current_dir(project.path())
            .status()
            .await
            .unwrap();
        tokio::process::Command::new("git")
            .args(["commit", "--allow-empty", "-m", "develop-only"])
            .current_dir(project.path())
            .status()
            .await
            .unwrap();
        let develop_sha = tokio::process::Command::new("git")
            .args(["rev-parse", "HEAD"])
            .current_dir(project.path())
            .output()
            .await
            .unwrap();
        let develop_sha = String::from_utf8(develop_sha.stdout)
            .unwrap()
            .trim()
            .to_string();

        // Switch back so HEAD ≠ develop — proves the explicit base argument
        // is what the new branch actually forks from.
        tokio::process::Command::new("git")
            .args(["checkout", "-q", &initial_branch])
            .current_dir(project.path())
            .status()
            .await
            .unwrap();

        // Place the worktree in its own unique temp dir (a sibling of the
        // project, not inside it). Using a fixed shared path here would let
        // parallel runs — or a leftover from a panicked prior run — collide on
        // `git worktree add ... already exists`.
        let wt_parent = tempfile::tempdir().unwrap();
        let wt_path = wt_parent.path().join("base-branch-wt");
        let wt_path_str = wt_path.to_str().unwrap();
        add_new_worktree(
            project.path().to_str().unwrap(),
            "feat/from-develop",
            wt_path_str,
            Some("develop"),
        )
        .await
        .unwrap();

        let head_sha = tokio::process::Command::new("git")
            .args(["rev-parse", "HEAD"])
            .current_dir(&wt_path)
            .output()
            .await
            .unwrap();
        let head_sha = String::from_utf8(head_sha.stdout)
            .unwrap()
            .trim()
            .to_string();
        assert_eq!(
            head_sha, develop_sha,
            "new worktree should fork from develop"
        );

        // Cleanup
        let _ = tokio::process::Command::new("git")
            .args(["worktree", "remove", "--force", wt_path_str])
            .current_dir(project.path())
            .status()
            .await;
    }

    #[tokio::test]
    async fn create_branch_in_project_forks_from_base_and_checks_out() {
        // `branch` mode: create a new branch forked from `develop` in the
        // project dir itself, and verify the project's HEAD now points at the
        // new branch sitting on develop's tip.
        let project = tempfile::tempdir().unwrap();
        init_repo(project.path()).await;
        let project_dir = project.path().to_str().unwrap();

        tokio::process::Command::new("git")
            .args(["checkout", "-q", "-b", "develop"])
            .current_dir(project.path())
            .status()
            .await
            .unwrap();
        tokio::process::Command::new("git")
            .args(["commit", "--allow-empty", "-m", "develop-only"])
            .current_dir(project.path())
            .status()
            .await
            .unwrap();
        let develop_sha = tokio::process::Command::new("git")
            .args(["rev-parse", "HEAD"])
            .current_dir(project.path())
            .output()
            .await
            .unwrap();
        let develop_sha = String::from_utf8(develop_sha.stdout)
            .unwrap()
            .trim()
            .to_string();

        // Move HEAD away from develop so the explicit base argument is what
        // the new branch actually forks from.
        tokio::process::Command::new("git")
            .args(["checkout", "-q", "-b", "scratch"])
            .current_dir(project.path())
            .status()
            .await
            .unwrap();

        create_branch_in_project(project_dir, "feat/from-develop", Some("develop"))
            .await
            .unwrap();

        let current_branch = tokio::process::Command::new("git")
            .args(["rev-parse", "--abbrev-ref", "HEAD"])
            .current_dir(project.path())
            .output()
            .await
            .unwrap();
        assert_eq!(
            String::from_utf8(current_branch.stdout).unwrap().trim(),
            "feat/from-develop",
        );
        let head_sha = tokio::process::Command::new("git")
            .args(["rev-parse", "HEAD"])
            .current_dir(project.path())
            .output()
            .await
            .unwrap();
        assert_eq!(
            String::from_utf8(head_sha.stdout).unwrap().trim(),
            develop_sha,
            "new branch should fork from develop's tip",
        );

        // Idempotent: a retry on the existing branch falls back to a plain
        // checkout instead of erroring.
        create_branch_in_project(project_dir, "feat/from-develop", Some("develop"))
            .await
            .unwrap();
    }
}
