//! PTY-backed `git commit` and `git push` streaming entry points.
//!
//! Pre-commit hooks routinely shell out to tools (`pnpm`, `vitest`,
//! `eslint`, `prettier`, …) that detect non-TTY stdio and switch to 4 KB
//! block-buffered output. Plain `Stdio::piped()` therefore looks frozen.
//! Allocating a real PTY makes the hooks see a terminal so they stay
//! line-buffered (or unbuffered for tools that flush per write). Same
//! pattern as `terminal::service`. The actual `spawn`/IO loop lives in
//! [`super::pty_spawn`].

use crate::shared::discard::IgnoreClosed;
use std::path::Path;

use crate::domain::git::models::PushForceMode;
use crate::error::AppError;
use crate::shared::git_cli::run_git_capture;

use super::pty_spawn::spawn_pty_git;
use super::SensitiveInput;

/// Pipes each output chunk of the underlying `git commit` process to `tx`
/// as (`stream_kind`, chunk) pairs while the command is still running. The
/// dialog renders these chunks live so long-running pre-commit hooks
/// (lint, tests) show progress as it happens.
///
/// **Why a PTY.** Pre-commit hooks routinely shell out to tools (`pnpm`,
/// `vitest`, `eslint`, `prettier`, …) that detect non-TTY stdio and switch
/// to 4 KB block-buffered output. Plain `Stdio::piped()` therefore looks
/// frozen: nothing arrives until the hook either fills its buffer or
/// exits. Allocating a real PTY makes the hooks see a terminal so they
/// stay line-buffered (or unbuffered for tools that flush per write).
/// This mirrors `terminal::service` which uses the same `portable-pty`
/// pattern for the in-app terminal and is the only approach in this
/// codebase that streams hook output reliably.
///
/// **No timeout.** Pre-commit hooks routinely run the full test suite;
/// wall-clock minutes are normal. The HTTP/WS handler is responsible for
/// canceling on disconnect.
pub async fn commit_streaming(
    repo: &Path,
    message: &str,
    paths: &[String],
    tx: tokio::sync::mpsc::UnboundedSender<(String, String)>,
) -> Result<(), AppError> {
    // `git add` is non-interactive and quiet; captured plain. Errors go
    // through the same stream channel so the dialog's terminal frame
    // displays them — never via a separate UI surface.
    let path_refs: Vec<&str> = paths.iter().map(String::as_str).collect();
    if let Err(e) = run_git_capture(&["add"], &[], &path_refs, repo).await {
        tx.send(("stderr".into(), format!("{e}\n"))).ignore_closed();
        return Err(e);
    }
    // Commits don't need user-typed input on the PTY (gpg-agent + pinentry
    // handle signing prompts out-of-band). Pass `None` so no writer task
    // is spawned.
    spawn_pty_git(&["commit", "-m", message], repo, tx, None).await
}

/// Run `git push -u origin HEAD` through a PTY so ssh sees a controlling
/// terminal and emits its passphrase / known-hosts / OTP prompts as
/// regular output chunks. The caller wires `stdin_rx` to a dialog input
/// field so the user can answer those prompts in-app — exactly the same
/// shape as commit, just bidirectional.
///
/// `stdin_rx` carries raw bytes the user typed (already terminated with a
/// newline by the caller — the PTY doesn't echo a `\r` for us). When the
/// receiver drops, the writer task exits cleanly; the push itself still
/// completes if ssh didn't actually need stdin.
///
/// `force` appends `--force` / `--force-with-lease` to the argv. The flag
/// goes *before* the refspec so `git` parses it as an option in every
/// supported version.
pub async fn push_streaming(
    repo: &Path,
    tx: tokio::sync::mpsc::UnboundedSender<(String, String)>,
    stdin_rx: tokio::sync::mpsc::UnboundedReceiver<SensitiveInput>,
    force: PushForceMode,
) -> Result<(), AppError> {
    spawn_pty_git(&push_args(force), repo, tx, Some(stdin_rx)).await
}

/// Full argv (minus the leading `git`) for a push in the given force mode.
/// Shared with the caller's echoed header line so the terminal pane always
/// shows exactly the command we ran.
pub fn push_args(force: PushForceMode) -> Vec<&'static str> {
    let mut args = vec!["push", "-u"];
    if let Some(flag) = force.flag() {
        args.push(flag);
    }
    args.extend_from_slice(&["origin", "HEAD"]);
    args
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::shared::git_cli::run_git;

    async fn init_test_repo() -> tempfile::TempDir {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path();
        run_git(&["init", "-q"], path).await.unwrap();
        run_git(&["config", "user.email", "test@example.com"], path)
            .await
            .unwrap();
        run_git(&["config", "user.name", "Test"], path)
            .await
            .unwrap();
        // Disable gpg signing locally so the test doesn't depend on the
        // developer's global `commit.gpgsign` / signing-key state.
        run_git(&["config", "commit.gpgsign", "false"], path)
            .await
            .unwrap();
        run_git(&["config", "tag.gpgsign", "false"], path)
            .await
            .unwrap();
        run_git(&["commit", "--allow-empty", "-m", "init"], path)
            .await
            .unwrap();
        dir
    }

    #[tokio::test]
    async fn commit_happy_path_creates_commit() {
        let dir = init_test_repo().await;
        let path = dir.path();
        let file = path.join("hello.txt");
        tokio::fs::write(&file, "hi\n").await.unwrap();
        let (tx, _rx) = tokio::sync::mpsc::unbounded_channel();
        commit_streaming(path, "add hello", &["hello.txt".to_string()], tx)
            .await
            .unwrap();
        let log = run_git(&["log", "--oneline"], path).await.unwrap();
        assert!(log.contains("add hello"), "{log}");
    }

    #[tokio::test]
    async fn commit_returns_raw_error_when_nothing_staged() {
        let dir = init_test_repo().await;
        // Nothing changed — `git add foo.txt` fails because `foo.txt` doesn't
        // exist. Either way, the captured stderr should be non-empty and
        // surface the real git error rather than a sanitized "<path>".
        let (tx, _rx) = tokio::sync::mpsc::unbounded_channel();
        let err = commit_streaming(dir.path(), "noop", &["does-not-exist.txt".to_string()], tx)
            .await
            .unwrap_err();
        let msg = err.to_string();
        assert!(!msg.is_empty(), "{msg}");
        // The raw git error mentions the path.
        assert!(
            msg.contains("does-not-exist.txt") || msg.to_lowercase().contains("pathspec"),
            "expected raw stderr, got: {msg}"
        );
    }

    #[tokio::test]
    async fn commit_streaming_emits_chunks_on_the_stream_channel() {
        // Verify the streaming side-channel: a successful commit produces
        // at least one chunk (git's "[branch …]" summary). Chunks are raw
        // PTY reads — *not* split into lines — so partial output, `\r`
        // progress bars, and slow flushers all reach the frontend the
        // moment they arrive instead of waiting for a `\n`.
        let dir = init_test_repo().await;
        let path = dir.path();
        tokio::fs::write(path.join("hi.txt"), "x\n").await.unwrap();
        let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
        commit_streaming(path, "stream me", &["hi.txt".to_string()], tx)
            .await
            .unwrap();
        let mut chunks = Vec::new();
        while let Ok(chunk) = rx.try_recv() {
            chunks.push(chunk);
        }
        assert!(
            !chunks.is_empty(),
            "expected ≥1 chunk on the stream channel"
        );
    }

    #[tokio::test]
    async fn push_streaming_fails_without_remote() {
        let dir = init_test_repo().await;
        let (output_tx, _output_rx) = tokio::sync::mpsc::unbounded_channel();
        let (_stdin_tx, stdin_rx) = tokio::sync::mpsc::unbounded_channel();
        let err = push_streaming(dir.path(), output_tx, stdin_rx, PushForceMode::None)
            .await
            .unwrap_err();
        let msg = err.to_string();
        assert!(!msg.is_empty(), "{msg}");
    }

    /// End-to-end through a real PTY and a real `git push`, against a bare
    /// repo on disk (no network). Proves the flag position in
    /// [`push_args`] is one git actually accepts, and that a diverged
    /// history is rewritten only by the modes that are supposed to.
    #[tokio::test]
    async fn push_streaming_force_modes_overwrite_a_diverged_remote() {
        async fn push_once(repo: &Path, force: PushForceMode) -> Result<(), AppError> {
            let (output_tx, _output_rx) = tokio::sync::mpsc::unbounded_channel();
            let (_stdin_tx, stdin_rx) = tokio::sync::mpsc::unbounded_channel();
            push_streaming(repo, output_tx, stdin_rx, force).await
        }

        let remote = tempfile::tempdir().unwrap();
        run_git(&["init", "-q", "--bare"], remote.path())
            .await
            .unwrap();
        let dir = init_test_repo().await;
        let path = dir.path();
        run_git(
            &["remote", "add", "origin", remote.path().to_str().unwrap()],
            path,
        )
        .await
        .unwrap();

        // Plain push publishes the branch.
        push_once(path, PushForceMode::None).await.unwrap();

        // Rewrite history so the local tip is no longer a descendant of the
        // remote tip — exactly the state a plain push must refuse.
        run_git(&["commit", "--allow-empty", "-m", "second"], path)
            .await
            .unwrap();
        push_once(path, PushForceMode::None).await.unwrap();
        run_git(&["reset", "--hard", "HEAD~1"], path).await.unwrap();
        run_git(&["commit", "--allow-empty", "-m", "rewritten"], path)
            .await
            .unwrap();

        assert!(
            push_once(path, PushForceMode::None).await.is_err(),
            "a non-fast-forward push must fail without a force flag"
        );
        // The lease is intact here (we fetched the remote tip when we pushed
        // it), so --force-with-lease is allowed to rewrite it.
        push_once(path, PushForceMode::ForceWithLease)
            .await
            .unwrap();

        let local = run_git(&["rev-parse", "HEAD"], path).await.unwrap();
        let published = run_git(&["rev-parse", "HEAD"], remote.path())
            .await
            .unwrap();
        assert_eq!(
            local.trim(),
            published.trim(),
            "lease push must publish HEAD"
        );

        run_git(&["commit", "--allow-empty", "-m", "third"], path)
            .await
            .unwrap();
        push_once(path, PushForceMode::Force).await.unwrap();
        let local = run_git(&["rev-parse", "HEAD"], path).await.unwrap();
        let published = run_git(&["rev-parse", "HEAD"], remote.path())
            .await
            .unwrap();
        assert_eq!(
            local.trim(),
            published.trim(),
            "force push must publish HEAD"
        );
    }

    #[test]
    fn push_args_appends_the_force_flag_before_the_refspec() {
        assert_eq!(
            push_args(PushForceMode::None),
            ["push", "-u", "origin", "HEAD"]
        );
        assert_eq!(
            push_args(PushForceMode::Force),
            ["push", "-u", "--force", "origin", "HEAD"]
        );
        assert_eq!(
            push_args(PushForceMode::ForceWithLease),
            ["push", "-u", "--force-with-lease", "origin", "HEAD"]
        );
    }
}
