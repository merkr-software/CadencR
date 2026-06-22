//! `WorktreeMode::Reuse` path: attach a feature to an existing branch and,
//! when the branch is already checked out elsewhere, share that worktree.

use std::path::Path;

use crate::domain::git::commands as git_commands;
use crate::shared::git_cli::run_git_safe_refs;
use crate::shared::worktree_paths::compute_worktree_path;

/// Outcome of `attach_to_existing_branch`: whether the worktree was newly
/// created or already attached to a different feature on disk.
pub struct WorktreeAttached {
    pub worktree_path: String,
    pub branch: String,
    pub was_already_attached: bool,
}

/// Attach a feature to an existing branch. If the branch is already checked
/// out in another worktree (e.g. another Cadencr feature), reuse that path —
/// the two features will then share working-copy state. Otherwise create a
/// fresh worktree on the same branch (no `-b`).
///
/// The project's own main working tree is **not** a reusable worktree: git
/// reports it in `worktree list`, but it lives at the project path itself and
/// can't host a second checkout of the same branch. Treating it as a "reuse"
/// target would silently run the agent in the project folder on the project
/// branch — the exact "shows a worktree but stays on the project branch"
/// failure. When the branch is only checked out there, we error instead so the
/// caller surfaces it rather than degrading to the project root.
///
/// This helper does not touch DB or send envelopes — `ensure_reuse` does
/// both via `persist_and_announce`. Keeping the helper pure makes it
/// testable (the decision logic is exercised via the parsed map).
pub async fn attach_to_existing_branch(
    branch: &str,
    project_path: &Path,
    project_name: &str,
) -> Result<WorktreeAttached, String> {
    let attachments = git_commands::list_worktree_branches(project_path)
        .await
        .map_err(|e| format!("failed to list worktrees: {e}"))?;

    if let Some(existing) = attachments.get(branch) {
        if is_same_path(existing, project_path) {
            return Err(format!(
                "Branch '{branch}' is checked out in the project folder, so a separate \
                 worktree can't be created for it. Switch the project to another branch, \
                 or use \"From branch with worktree\" to start a new branch."
            ));
        }
        return Ok(WorktreeAttached {
            worktree_path: existing.to_string_lossy().to_string(),
            branch: branch.to_string(),
            was_already_attached: true,
        });
    }

    // Build a fresh path under ~/.cadencr/worktrees/<project>/<safe-branch>
    // and run `git worktree add <path> <branch>` (no `-b` — branch exists).
    let path_str = compute_worktree_path(project_name, branch).await?;
    run_git_safe_refs(
        &["worktree", "add"],
        &[],
        &[&path_str, branch],
        project_path,
    )
    .await
    .map_err(|e| format!("git worktree add failed: {e}"))?;

    Ok(WorktreeAttached {
        worktree_path: path_str,
        branch: branch.to_string(),
        was_already_attached: false,
    })
}

/// Whether two paths point at the same directory. `git worktree list` emits
/// canonicalized paths while the project path comes from the DB, so canonicalize
/// both before comparing; fall back to a trailing-slash-tolerant string compare
/// when canonicalization fails (e.g. the path no longer exists).
fn is_same_path(a: &Path, b: &Path) -> bool {
    match (std::fs::canonicalize(a), std::fs::canonicalize(b)) {
        (Ok(ca), Ok(cb)) => ca == cb,
        _ => {
            let norm = |p: &Path| p.to_string_lossy().trim_end_matches('/').to_string();
            norm(a) == norm(b)
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

    #[tokio::test]
    async fn attach_to_existing_branch_reuses_attached_worktree() {
        // Set up: repo with branch `feat/a` already checked out in a sibling
        // worktree. Calling `attach_to_existing_branch("feat/a")` should
        // return the existing path with `was_already_attached=true`.
        //
        // Both worktrees live inside dedicated tempdirs so they get cleaned up
        // automatically on Drop, even if the test panics mid-way. The
        // project_name is randomized so that the fallback `~/.cadencr/worktrees/
        // <project>/<branch>` path (only hit when something goes wrong) can't
        // collide with leftovers from a prior failed run.
        let project = tempfile::tempdir().unwrap();
        let donor_parent = tempfile::tempdir().unwrap();
        init_repo(project.path()).await;

        // Create branch `feat/a` and attach it in a sibling worktree.
        tokio::process::Command::new("git")
            .args(["branch", "feat/a"])
            .current_dir(project.path())
            .status()
            .await
            .unwrap();
        let donor_wt = donor_parent.path().join("donor-wt");
        let add_status = tokio::process::Command::new("git")
            .args(["worktree", "add", donor_wt.to_str().unwrap(), "feat/a"])
            .current_dir(project.path())
            .status()
            .await
            .unwrap();
        assert!(add_status.success(), "donor worktree add failed");

        let project_name = format!("attach-reuse-test-{}", std::process::id());
        let result = attach_to_existing_branch("feat/a", project.path(), &project_name)
            .await
            .unwrap();
        assert!(result.was_already_attached);
        // git worktree list emits canonicalized paths, so a contains check is
        // more robust than equality.
        assert!(
            result.worktree_path.contains("donor-wt"),
            "{}",
            result.worktree_path
        );

        // Cleanup: remove the donor worktree registration (its files are
        // inside `donor_parent` and will go away with the tempdir). Also
        // sweep the fallback path in case a prior run leaked.
        let _ = tokio::process::Command::new("git")
            .args(["worktree", "remove", "--force", donor_wt.to_str().unwrap()])
            .current_dir(project.path())
            .status()
            .await;
        if let Ok(home) = std::env::var("HOME") {
            let _ = std::fs::remove_dir_all(
                std::path::Path::new(&home)
                    .join(".cadencr/worktrees")
                    .join(&project_name),
            );
        }
    }

    #[tokio::test]
    async fn attach_to_existing_branch_rejects_project_main_working_tree() {
        // The branch is checked out in the project's *own* main working tree
        // (no separate worktree exists for it). Git can't create a second
        // worktree on it, so `attach_to_existing_branch` must error rather than
        // return the project path itself — otherwise the agent would silently
        // run in the project folder on the project branch. Regression test for
        // the "shows a worktree but stays on the project branch" bug.
        let project = tempfile::tempdir().unwrap();
        init_repo(project.path()).await;
        let current_branch = tokio::process::Command::new("git")
            .args(["rev-parse", "--abbrev-ref", "HEAD"])
            .current_dir(project.path())
            .output()
            .await
            .unwrap();
        let current_branch = String::from_utf8(current_branch.stdout)
            .unwrap()
            .trim()
            .to_string();

        let project_name = format!("attach-main-tree-test-{}", std::process::id());
        let attached_path =
            attach_to_existing_branch(&current_branch, project.path(), &project_name)
                .await
                .map(|a| a.worktree_path);
        assert!(
            attached_path.is_err(),
            "reusing the project's main-tree branch must error, got {attached_path:?}"
        );

        // Defensive sweep of the fallback path in case anything leaked.
        if let Ok(home) = std::env::var("HOME") {
            let _ = std::fs::remove_dir_all(
                std::path::Path::new(&home)
                    .join(".cadencr/worktrees")
                    .join(&project_name),
            );
        }
    }
}
