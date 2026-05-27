//! `POST /api/git/commit` and `GET /api/git/uncommitted-files`. Thin
//! orchestrators that delegate the actual git work to `commands` and the
//! WS broadcast to the watcher. Push lives in its sibling [`super::push`]
//! module — extracted to keep both files under the 400-line cap.

use std::path::Path;

use crate::app_state::AppState;
use crate::domain::git::commands;
use crate::domain::git::models::{CommitBody, GetUncommittedFilesParams, SuccessResponse};
use crate::domain::git::porcelain::{parse_porcelain_v2_files, UncommittedFile};
use crate::domain::git::service::resolve_feature_git_path;
use crate::error::AppError;
use crate::shared::git_cli::run_git_background;

use super::broadcast_after_write;
use super::streaming::{broadcast_complete, stream_git_operation, GitStreamOp};

// ---------------------------------------------------------------------------
// POST /api/git/commit
// ---------------------------------------------------------------------------

pub async fn commit(state: &AppState, body: CommitBody) -> Result<SuccessResponse, AppError> {
    let CommitBody {
        feature_id,
        message,
        file_paths,
    } = body;

    let message_trim = message.trim();
    if message_trim.is_empty() {
        return Err(AppError::BadRequest("commit message is required".into()));
    }
    if file_paths.is_empty() {
        return Err(AppError::BadRequest(
            "at least one file path is required".into(),
        ));
    }
    for p in &file_paths {
        if p.contains("..") || p.starts_with('-') {
            return Err(AppError::BadRequest(format!(
                "refusing unsafe file path: {p:?}"
            )));
        }
    }

    let git_path = resolve_feature_git_path(state, feature_id)
        .await?
        .ok_or_else(|| AppError::NotFound(format!("feature {feature_id} has no git path")))?;
    let repo = Path::new(&git_path);

    // Streaming setup is shared with `push` — see [`super::streaming`].
    // The synthetic `$ git add …` header gives the dialog a first line to
    // render the instant the user clicks Commit, even on fast commits
    // with no pre-commit hooks. If this line never appears in the
    // terminal pane, the WS pipeline (broadcast → frontend store → React
    // render) is broken, not the PTY reader.
    let header = format!("$ git add {}\n", file_paths.join(" "));
    let outcome = stream_git_operation(
        state,
        feature_id,
        GitStreamOp::Commit,
        header,
        |output_tx| async move {
            commands::commit_streaming(repo, message_trim, &file_paths, output_tx).await
        },
    )
    .await;

    if outcome.success {
        broadcast_after_write(state, feature_id).await;
    }
    let response = SuccessResponse {
        success: outcome.success,
        error: outcome.error.clone(),
        blocked_reason: None,
    };
    broadcast_complete(
        &outcome.senders,
        feature_id,
        GitStreamOp::Commit,
        response.success,
        &response.error,
    );

    Ok(response)
}

// ---------------------------------------------------------------------------
// GET /api/git/uncommitted-files
// ---------------------------------------------------------------------------

pub async fn get_uncommitted_files(
    state: &AppState,
    params: GetUncommittedFilesParams,
) -> Result<Vec<UncommittedFile>, AppError> {
    let git_path = resolve_feature_git_path(state, params.feature_id)
        .await?
        .ok_or_else(|| {
            AppError::NotFound(format!("feature {} has no git path", params.feature_id))
        })?;
    let repo = Path::new(&git_path);

    // Fetch porcelain (file list + status flags) and both numstat sides
    // (staged + unstaged) concurrently. Untracked files don't show up in
    // numstat — their `additions`/`deletions` stay at the parser's `0`
    // defaults, which is the right answer (we don't have a baseline to
    // diff against until they're staged).
    //
    // All three are read-style probes: `run_git_background` so they pass
    // `--no-optional-locks` and can't race a concurrent user-initiated
    // rebase / commit for `.git/index.lock`.
    let (porcelain, staged_num, unstaged_num) = tokio::try_join!(
        run_git_background(&["status", "--porcelain=v2"], repo),
        run_git_background(&["diff", "--cached", "--numstat"], repo),
        run_git_background(&["diff", "--numstat"], repo),
    )?;

    let staged_stats = commands::parse_numstat(&staged_num);
    let unstaged_stats = commands::parse_numstat(&unstaged_num);
    let mut files = parse_porcelain_v2_files(&porcelain);
    for f in files.iter_mut() {
        let mut add = 0;
        let mut del = 0;
        if let Some((a, d)) = staged_stats.get(&f.path) {
            add += a;
            del += d;
        }
        if let Some((a, d)) = unstaged_stats.get(&f.path) {
            add += a;
            del += d;
        }
        f.additions = add;
        f.deletions = del;
    }
    Ok(files)
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::sync::mpsc;

    /// End-to-end pipeline assertion. Event ordering: at least one
    /// `commit.output`-style chunk arrives on the streaming channel
    /// BEFORE `commit_streaming` returns. If the read loop ever batches
    /// everything to the end, no chunk is observed mid-flight and the
    /// assertion fails. Replaces a previous fragile elapsed-ms spread
    /// check — duration-based assertions are unreliable under load.
    #[tokio::test]
    async fn streams_chunks_before_commit_completes() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().to_path_buf();
        for args in [
            &["init", "-q"][..],
            &["config", "user.email", "t@example.com"][..],
            &["config", "user.name", "T"][..],
            &["config", "commit.gpgsign", "false"][..],
            &["config", "tag.gpgsign", "false"][..],
            &["commit", "--allow-empty", "-m", "init"][..],
        ] {
            crate::shared::git_cli::run_git(args, &path).await.unwrap();
        }

        // Slow pre-commit hook so `commit_streaming` is guaranteed to
        // still be running when the first hook line lands on the channel.
        // Five lines × 200 ms = ~1s of in-flight output to race against
        // the completion future.
        let hook = path.join(".git").join("hooks").join("pre-commit");
        tokio::fs::write(
            &hook,
            "#!/bin/sh\nfor i in 1 2 3 4 5; do echo \"hook $i\"; sleep 0.2; done\n",
        )
        .await
        .unwrap();
        use std::os::unix::fs::PermissionsExt;
        let mut perms = tokio::fs::metadata(&hook).await.unwrap().permissions();
        perms.set_mode(0o755);
        tokio::fs::set_permissions(&hook, perms).await.unwrap();

        tokio::fs::write(path.join("a.txt"), "hello\n")
            .await
            .unwrap();

        let (chunk_tx, mut chunk_rx) = mpsc::unbounded_channel::<(String, String)>();
        let path_for_commit = path.clone();
        let mut commit_task = tokio::spawn(async move {
            commands::commit_streaming(
                &path_for_commit,
                "stream me",
                &["a.txt".to_string()],
                chunk_tx,
            )
            .await
        });

        // Race the chunk channel against the commit's completion future.
        // The streaming contract is "chunks arrive while the operation
        // is still running" — encoded directly as event ordering, not
        // as an elapsed-millisecond threshold.
        let mut got_mid_flight_chunk = false;
        loop {
            tokio::select! {
                biased;
                maybe_chunk = chunk_rx.recv() => {
                    match maybe_chunk {
                        Some((_kind, text)) if text.contains("hook ") => {
                            got_mid_flight_chunk = true;
                            break;
                        }
                        Some(_) => continue,
                        None => break,
                    }
                }
                res = &mut commit_task => {
                    res.unwrap().unwrap();
                    break;
                }
                // Bound the wait so a hung PTY fails the test instead
                // of the harness. Generous (10s) — pure budget, not a
                // success criterion.
                _ = tokio::time::sleep(std::time::Duration::from_secs(10)) => {
                    panic!("timed out waiting for streamed hook output");
                }
            }
        }
        // Drain to let the commit finish even if it's still running.
        if !commit_task.is_finished() {
            commit_task.await.unwrap().unwrap();
        }

        assert!(
            got_mid_flight_chunk,
            "expected ≥1 hook chunk on the stream channel before commit completed"
        );
    }
}
