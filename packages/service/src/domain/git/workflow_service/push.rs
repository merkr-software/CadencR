//! `POST /api/git/push` and `POST /api/git/push-input` — interactive,
//! PTY-streamed push with passphrase / yes-no prompt support.
//!
//! Split out of `commit_push.rs` to keep both files under the 400-line
//! cap. Same orchestration shape as `commit`: snapshot WS subscribers,
//! stream PTY chunks through them via `git/push.output` envelopes,
//! broadcast `start`/`complete` markers around the run.
//!
//! The novel piece is the **stdin side** of the PTY: ssh prints prompts
//! on the merged stdout stream and reads answers from stdin. We expose
//! that stdin via the per-feature [`PushSessionRegistry`] so the dialog
//! can `POST /api/git/push-input` to forward the user's typed line back
//! into the PTY in real time.

use tokio::sync::mpsc;

use crate::app_state::AppState;
use crate::domain::git::commands;
use crate::domain::git::commands::SensitiveInput;
use crate::domain::git::models::{PushBody, PushForceMode, PushInputBody, SuccessResponse};
use crate::error::AppError;

use super::streaming::{broadcast_complete, stream_git_operation, GitStreamOp};
use super::{broadcast_after_write, mutation_guard_error};
use crate::domain::git::service::resolve_feature_git_dir;

pub async fn push(state: &AppState, body: PushBody) -> Result<SuccessResponse, AppError> {
    let feature_id = body.feature_id;
    let repo = resolve_feature_git_dir(state, feature_id)
        .await?
        .ok_or_else(|| AppError::NotFound(format!("feature {feature_id} has no git path")))?
        .cwd;
    let permit = state
        .git_mutations
        .try_acquire(&repo)
        .map_err(|error| mutation_guard_error(error))?;

    // ssh's prompts (`Enter passphrase…`, `(yes/no)?`) arrive on stdout
    // exactly like any other line, so the dialog can detect them and
    // surface a password input — answers come back via
    // `POST /api/git/push-input`, routed through `state.push_sessions`.
    let (stdin_tx, stdin_rx) = mpsc::unbounded_channel::<SensitiveInput>();
    if !state.push_sessions.register(feature_id, stdin_tx).await {
        // Concurrent push for the same feature — the dialog is supposed to
        // be single-instance per feature, so this is either a bug or a stale
        // session. Refuse explicitly rather than racing two PTYs.
        return Ok(SuccessResponse {
            success: false,
            error: Some("a push is already running for this feature".into()),
            blocked_reason: None,
        });
    }

    // Send-once Option dance: the closure is `FnOnce` so it can take ownership
    // of `stdin_rx` directly — no Mutex needed.
    let mut stdin_rx_slot = Some(stdin_rx);
    let force = body.force;
    let outcome = stream_git_operation(
        state,
        feature_id,
        GitStreamOp::Push,
        push_header_line(force),
        |output_tx| async move {
            let stdin_rx = stdin_rx_slot.take().expect("run closure invoked once");
            commands::push_streaming(&repo, output_tx, stdin_rx, force).await
        },
    )
    .await;
    state.push_sessions.unregister(feature_id).await;
    drop(permit);

    let final_error = match outcome.error {
        Some(e) => Some(decorate_with_ssh_diagnostic(e).await),
        None => None,
    };
    if outcome.success {
        broadcast_after_write(state, feature_id).await;
    }
    let response = SuccessResponse {
        success: outcome.success,
        error: final_error,
        blocked_reason: None,
    };
    broadcast_complete(
        &outcome.senders,
        feature_id,
        GitStreamOp::Push,
        response.success,
        &response.error,
    );

    Ok(response)
}

/// Synthetic first line for the dialog's terminal pane. Echoes the exact
/// argv we hand to git so a forced push is unmistakable in the output.
fn push_header_line(force: PushForceMode) -> String {
    format!("$ git {}\n", commands::push_args(force).join(" "))
}

/// Handler for `POST /api/git/push-input`. Routes the user-typed text into
/// the active push session's PTY stdin. Always appends `\n` because every
/// known prompt (passphrase, yes/no, password) reads a line.
pub async fn push_input(
    state: &AppState,
    body: PushInputBody,
) -> Result<SuccessResponse, AppError> {
    let delivered = state
        .push_sessions
        .send_input(body.feature_id, body.text)
        .await;
    if !delivered {
        return Ok(SuccessResponse {
            success: false,
            error: Some("no active push for this feature".into()),
            blocked_reason: None,
        });
    }
    Ok(SuccessResponse {
        success: true,
        error: None,
        blocked_reason: None,
    })
}

/// If the raw error matches an ssh auth failure, append our backend-side
/// view of `SSH_AUTH_SOCK` / `HOME` / `ssh-add -l` so the user can compare
/// with what Terminal shows. Useful even when the dialog is visible: the
/// canonical `Permission denied (publickey)` can fire *after* the user
/// typed a passphrase if the agent has no matching key.
async fn decorate_with_ssh_diagnostic(raw: String) -> String {
    if !looks_like_ssh_auth_failure(&raw) {
        return raw;
    }
    let diag = ssh_auth_diagnostic().await;
    format!("{raw}\n\n--- SSH diagnostic ---\n{diag}")
}

/// Cheap match against the canonical OpenSSH "no key worked" error.
/// `Permission denied (publickey)` is the universal signal — present
/// whether the cause is an empty agent, missing IdentityFile, or wrong
/// authorized_keys entry on the server.
fn looks_like_ssh_auth_failure(stderr: &str) -> bool {
    stderr.contains("Permission denied (publickey)")
        || stderr.contains("Could not read from remote repository")
}

/// Capture what *our* process sees of the SSH auth chain. Three pieces:
///   - `SSH_AUTH_SOCK` we inherited (or hydrated from the login shell).
///   - `ssh-add -l` output, which queries that socket — distinguishes
///     "agent unreachable" (exit 2 / `Could not open a connection`),
///     "agent reachable but empty" (exit 1 / `The agent has no
///     identities`), and "agent has these keys" (exit 0 with fingerprints).
///   - `HOME`, since misconfigured `HOME` is a classic source of "ssh
///     can't find ~/.ssh/config" surprises in GUI launches.
async fn ssh_auth_diagnostic() -> String {
    let sock = std::env::var("SSH_AUTH_SOCK").unwrap_or_else(|_| "<unset>".into());
    let home = std::env::var("HOME").unwrap_or_else(|_| "<unset>".into());

    let mut ssh_add = tokio::process::Command::new("ssh-add");
    ssh_add.arg("-l");
    crate::shared::security::scrub_service_only_env(&mut ssh_add);
    let listing = match ssh_add.output().await {
        Ok(out) => {
            let stdout = String::from_utf8_lossy(&out.stdout);
            let stderr = String::from_utf8_lossy(&out.stderr);
            let combined = format!("{stdout}{stderr}");
            let trimmed = combined.trim();
            if trimmed.is_empty() {
                format!("(exit {:?}, no output)", out.status.code())
            } else {
                format!("(exit {:?})\n{trimmed}", out.status.code())
            }
        }
        Err(e) => format!("ssh-add spawn failed: {e}"),
    };

    format!("SSH_AUTH_SOCK = {sock}\nHOME          = {home}\nssh-add -l    {listing}")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn push_header_line_echoes_the_force_flag() {
        assert_eq!(
            push_header_line(PushForceMode::None),
            "$ git push -u origin HEAD\n"
        );
        assert_eq!(
            push_header_line(PushForceMode::ForceWithLease),
            "$ git push -u --force-with-lease origin HEAD\n"
        );
        assert_eq!(
            push_header_line(PushForceMode::Force),
            "$ git push -u --force origin HEAD\n"
        );
    }

    #[test]
    fn looks_like_ssh_auth_failure_matches_canonical_strings() {
        assert!(looks_like_ssh_auth_failure(
            "git@github.com: Permission denied (publickey).\nfatal: Could not read from remote repository."
        ));
        assert!(looks_like_ssh_auth_failure("Permission denied (publickey)"));
        assert!(looks_like_ssh_auth_failure(
            "fatal: Could not read from remote repository."
        ));
    }

    #[test]
    fn looks_like_ssh_auth_failure_ignores_unrelated_errors() {
        assert!(!looks_like_ssh_auth_failure(
            "fatal: refusing to merge unrelated histories"
        ));
        assert!(!looks_like_ssh_auth_failure(""));
    }

    #[tokio::test]
    async fn decorate_with_ssh_diagnostic_appends_only_on_match() {
        let unrelated = decorate_with_ssh_diagnostic("nothing to do".into()).await;
        assert!(
            !unrelated.contains("--- SSH diagnostic ---"),
            "unrelated errors must pass through untouched: {unrelated}"
        );

        let auth_failure =
            decorate_with_ssh_diagnostic("git@github.com: Permission denied (publickey).".into())
                .await;
        assert!(
            auth_failure.contains("--- SSH diagnostic ---"),
            "auth failures must get the diagnostic appended: {auth_failure}"
        );
        assert!(auth_failure.contains("SSH_AUTH_SOCK"));
        assert!(auth_failure.contains("ssh-add -l"));
    }
}
