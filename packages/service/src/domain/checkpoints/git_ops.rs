//! Pure git plumbing for worktree checkpoints. No provider knowledge, no DB.
//!
//! A checkpoint snapshots the worktree with an **isolated index**
//! (`GIT_INDEX_FILE`) so the user's real `.git/index` is never disturbed,
//! commits it as an orphan commit, and parks it under
//! `refs/cadencr/checkpoints/<feature>/<seq>` so it stays reachable (not GC'd)
//! until the feature is cleaned up.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

use crate::error::AppError;
use crate::shared::git_cli::{run_git, run_git_with_env};

/// Deterministic committer identity so `commit-tree` never fails on a worktree
/// that has no configured `user.name` / `user.email`.
const IDENTITY_ENV: [(&str, &str); 4] = [
    ("GIT_AUTHOR_NAME", "Cadencr Checkpoints"),
    ("GIT_AUTHOR_EMAIL", "checkpoints@cadencr.local"),
    ("GIT_COMMITTER_NAME", "Cadencr Checkpoints"),
    ("GIT_COMMITTER_EMAIL", "checkpoints@cadencr.local"),
];

/// Unique scratch path for the isolated index. Git creates the file (and its
/// `.lock` sibling) here; we remove it afterwards.
fn temp_index_path() -> PathBuf {
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    let n = COUNTER.fetch_add(1, Ordering::Relaxed);
    let pid = std::process::id();
    std::env::temp_dir().join(format!("cadencr-checkpoint-index-{pid}-{n}"))
}

/// Snapshot tracked worktree paths into a fresh orphan commit and return its sha,
/// parking it under `ref_name` so it stays reachable.
///
/// We deliberately use `git add -u`, not `git add -A`: untracked local files may
/// contain secrets the user forgot to ignore, and checkpoint refs keep their
/// objects reachable. The user's real index is untouched (we stage into a temp
/// index).
pub(super) async fn snapshot_commit(
    cwd: &Path,
    ref_name: &str,
    label: &str,
) -> Result<String, AppError> {
    let index_path = temp_index_path();
    let index_str = index_path.to_string_lossy().to_string();

    let mut env: Vec<(&str, &str)> = IDENTITY_ENV.to_vec();
    env.push(("GIT_INDEX_FILE", index_str.as_str()));

    // Seed the isolated index from HEAD, then stage tracked worktree changes.
    let result = snapshot_inner(cwd, ref_name, label, &env).await;

    // Best-effort cleanup of the scratch index; a leftover is harmless.
    let _ = std::fs::remove_file(&index_path);
    let _ = std::fs::remove_file(index_path.with_extension("lock"));

    result
}

async fn snapshot_inner(
    cwd: &Path,
    ref_name: &str,
    label: &str,
    env: &[(&str, &str)],
) -> Result<String, AppError> {
    run_git_with_env(&["read-tree", "HEAD"], cwd, env).await?;
    run_git_with_env(&["add", "-u", "--", "."], cwd, env).await?;
    let tree = run_git_with_env(&["write-tree"], cwd, env).await?;
    let tree = tree.trim();

    let message = format!("cadencr checkpoint {label}");
    // Orphan commit: restore only needs the tree, and keeping it parentless
    // avoids dragging history into the checkpoint ref.
    let commit = run_git_with_env(&["commit-tree", tree, "-m", &message], cwd, &IDENTITY_ENV)
        .await?
        .trim()
        .to_string();

    run_git(&["update-ref", ref_name, &commit], cwd).await?;
    Ok(commit)
}

/// Roll tracked paths in the worktree back to the snapshot at `commit_sha`
/// (index + working tree).
///
/// Untracked files are intentionally preserved: they may contain local secrets
/// or scratch work that checkpoint commits do not retain.
pub(super) async fn restore_worktree(cwd: &Path, commit_sha: &str) -> Result<(), AppError> {
    run_git(
        &[
            "restore",
            "--source",
            commit_sha,
            "--staged",
            "--worktree",
            "--",
            ".",
        ],
        cwd,
    )
    .await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::shared::git_cli::run_git_background;
    use std::fs;

    async fn init_repo() -> tempfile::TempDir {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path();
        run_git(&["init", "-q"], p).await.unwrap();
        run_git(&["config", "user.email", "t@example.com"], p)
            .await
            .unwrap();
        run_git(&["config", "user.name", "Test"], p).await.unwrap();
        run_git(&["config", "commit.gpgsign", "false"], p)
            .await
            .unwrap();
        fs::write(p.join("tracked.txt"), "v1").unwrap();
        fs::write(p.join("doomed.txt"), "keep-me").unwrap();
        run_git(&["add", "-A"], p).await.unwrap();
        run_git(&["commit", "-qm", "init"], p).await.unwrap();
        dir
    }

    #[tokio::test]
    async fn snapshot_then_restore_round_trips_edits_adds_and_deletes() {
        let dir = init_repo().await;
        let p = dir.path();

        // Snapshot the clean v1 state.
        let sha = snapshot_commit(p, "refs/cadencr/checkpoints/1/1", "1/1")
            .await
            .unwrap();
        assert_eq!(sha.len(), 40, "sha should be a full commit hash");

        // Mutate: edit a tracked file, add a new untracked file, delete another
        // tracked one.
        fs::write(p.join("tracked.txt"), "v2-edited").unwrap();
        fs::write(p.join("new.txt"), "added").unwrap();
        fs::remove_file(p.join("doomed.txt")).unwrap();

        super::restore_worktree(p, &sha).await.unwrap();

        assert_eq!(fs::read_to_string(p.join("tracked.txt")).unwrap(), "v1");
        assert!(p.join("new.txt").exists(), "untracked files are preserved");
        assert_eq!(
            fs::read_to_string(p.join("doomed.txt")).unwrap(),
            "keep-me",
            "restore brings back a deleted tracked file"
        );
    }

    #[tokio::test]
    async fn restore_preserves_ignored_and_untracked_files() {
        let dir = init_repo().await;
        let p = dir.path();
        fs::write(p.join(".gitignore"), "secret.env\n").unwrap();
        run_git(&["add", "-A"], p).await.unwrap();
        run_git(&["commit", "-qm", "ignore"], p).await.unwrap();

        let sha = snapshot_commit(p, "refs/cadencr/checkpoints/1/2", "1/2")
            .await
            .unwrap();

        fs::write(p.join("secret.env"), "TOKEN=abc").unwrap();
        fs::write(p.join("junk.txt"), "untracked").unwrap();

        super::restore_worktree(p, &sha).await.unwrap();

        assert!(p.join("secret.env").exists(), "ignored file must survive");
        assert!(p.join("junk.txt").exists(), "untracked file must survive");
    }

    #[tokio::test]
    async fn snapshot_does_not_retain_untracked_files() {
        let dir = init_repo().await;
        let p = dir.path();
        fs::write(p.join("local-secret.txt"), "TOKEN=abc").unwrap();

        let sha = snapshot_commit(p, "refs/cadencr/checkpoints/1/secret", "1/secret")
            .await
            .unwrap();

        let tree = run_git_background(&["ls-tree", "-r", "--name-only", &sha], p)
            .await
            .unwrap();
        assert!(
            !tree.lines().any(|line| line == "local-secret.txt"),
            "checkpoint commits must not retain local untracked files"
        );
    }

    #[tokio::test]
    async fn restore_preserves_untracked_files() {
        let dir = init_repo().await;
        let p = dir.path();
        fs::write(p.join("local-secret.txt"), "TOKEN=before").unwrap();
        let sha = snapshot_commit(p, "refs/cadencr/checkpoints/1/preserve", "1/preserve")
            .await
            .unwrap();

        fs::write(p.join("tracked.txt"), "v2-edited").unwrap();
        fs::write(p.join("local-secret.txt"), "TOKEN=after").unwrap();

        super::restore_worktree(p, &sha).await.unwrap();

        assert_eq!(fs::read_to_string(p.join("tracked.txt")).unwrap(), "v1");
        assert_eq!(
            fs::read_to_string(p.join("local-secret.txt")).unwrap(),
            "TOKEN=after",
            "rewind must not overwrite or delete untracked local files"
        );
    }

    #[tokio::test]
    async fn snapshot_does_not_touch_the_real_index() {
        let dir = init_repo().await;
        let p = dir.path();
        // Stage a change in the REAL index.
        fs::write(p.join("tracked.txt"), "staged-change").unwrap();
        run_git(&["add", "tracked.txt"], p).await.unwrap();
        let before = run_git_background(&["status", "--porcelain"], p)
            .await
            .unwrap();

        snapshot_commit(p, "refs/cadencr/checkpoints/1/3", "1/3")
            .await
            .unwrap();

        let after = run_git_background(&["status", "--porcelain"], p)
            .await
            .unwrap();
        assert_eq!(before, after, "real index/status must be unchanged");
    }
}
