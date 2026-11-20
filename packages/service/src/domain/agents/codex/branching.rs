use async_trait::async_trait;
use codex_app_server_sdk_rs::{CodexAppServerClient, SdkError, ThreadSnapshot};

use super::{app_server_failure, spawn_options::app_server_spawn_options, CodexAdapter};
use crate::domain::agents::adapter::{
    AgentRuntimeAdapter, BranchContext, BranchError, BranchResult, SessionBranching,
};

pub(super) static CODEX_SESSION_BRANCHING: CodexSessionBranching = CodexSessionBranching;

pub(super) struct CodexSessionBranching;

#[async_trait]
impl SessionBranching for CodexSessionBranching {
    async fn truncate_before(&self, ctx: &BranchContext) -> Result<BranchResult, BranchError> {
        let resolved = CodexAdapter
            .resolve_profile(Some(ctx.profile.as_deref().unwrap_or("default")), &ctx.cwd)
            .await
            .map_err(|error| BranchError::Surgery(error.to_string()))?
            .expect("Codex always resolves a default profile");
        let secrets = app_server_failure::secrets(Some(&resolved.env));
        let client = CodexAppServerClient::spawn_with_options(app_server_spawn_options(
            Some(resolved.env),
            resolved.env_unset,
            Some(ctx.cwd.clone()),
        ))
        .await
        .map_err(branch_surgery)?;
        let result = truncate_with_client(&client, ctx).await;
        client.shutdown().await;
        result.map_err(|error| {
            explain_surgery_failure(error, app_server_failure::exit_reason(&client, &secrets))
        })
    }
}

/// A fork that failed because the app-server died says how and why, like
/// every other Codex request; a cut Cadencr refused stays as it is.
fn explain_surgery_failure(error: BranchError, app_server_died: Option<String>) -> BranchError {
    match (error, app_server_died) {
        (BranchError::Surgery(_), Some(reason)) => BranchError::Surgery(reason),
        (error, _) => error,
    }
}

async fn truncate_with_client(
    client: &CodexAppServerClient,
    ctx: &BranchContext,
) -> Result<BranchResult, BranchError> {
    client.initialize().await.map_err(branch_surgery)?;
    let source = client
        .thread_read(&ctx.source_runtime_session_id, true)
        .await
        .map_err(source_failure)?;
    let cut = cut_before(&source, ctx.cut_user_ordinal)?;
    let forked = client
        .thread_fork(&ctx.source_runtime_session_id, &ctx.cwd)
        .await
        .map_err(source_failure)?;
    let cut_checked = async {
        cut_fork(client, &forked.id, &cut).await?;
        check_cut(&read_snapshot(client, &forked.id).await?, &cut)
    };
    if let Err(error) = cut_checked.await {
        return Err(discard_fork(client, &forked.id, error).await);
    }
    Ok(BranchResult {
        new_runtime_session_id: forked.id,
    })
}

/// Where a fork is cut: before `before_turn_id`, the turn holding the cut
/// prompt, which drops `dropped_turns` turns and keeps `kept_turns`.
#[derive(Debug, PartialEq, Eq)]
struct Cut {
    before_turn_id: String,
    dropped_turns: u32,
    kept_turns: usize,
}

/// Cut the fork's history. App-servers since Codex 0.167 cut with
/// `thread/revert` and no longer know `thread/rollback`; older ones only
/// know `thread/rollback`. The method the app-server lacks says which it is.
async fn cut_fork(
    client: &CodexAppServerClient,
    thread_id: &str,
    cut: &Cut,
) -> Result<(), BranchError> {
    match client.thread_revert(thread_id, &cut.before_turn_id).await {
        Err(error) if error.is_unknown_method("thread/revert") => client
            .thread_rollback(thread_id, cut.dropped_turns)
            .await
            .map_err(branch_surgery),
        result => result.map_err(branch_surgery),
    }
}

/// A fork whose cut failed holds the whole history: archive it so it does
/// not linger in the user's Codex threads, and say so when that fails too.
async fn discard_fork(
    client: &CodexAppServerClient,
    fork_id: &str,
    error: BranchError,
) -> BranchError {
    match client.thread_archive(fork_id).await {
        Ok(()) => error,
        Err(archive_error) => BranchError::Surgery(format!(
            "{error}; the uncut Codex fork {fork_id} could not be archived either: {archive_error}"
        )),
    }
}

/// An app-server that took the cut without applying it would leave the
/// fork with its whole history; never hand that on as a cut conversation.
fn check_cut(fork: &ThreadSnapshot, cut: &Cut) -> Result<(), BranchError> {
    if fork.turns.len() == cut.kept_turns {
        return Ok(());
    }
    Err(BranchError::Surgery(format!(
        "Codex kept {} turns in the fork instead of {}",
        fork.turns.len(),
        cut.kept_turns
    )))
}

async fn read_snapshot(
    client: &CodexAppServerClient,
    thread_id: &str,
) -> Result<ThreadSnapshot, BranchError> {
    client
        .thread_read(thread_id, true)
        .await
        .map_err(branch_surgery)
}

fn cut_before(snapshot: &ThreadSnapshot, cut_user_ordinal: usize) -> Result<Cut, BranchError> {
    let mut seen_user_messages = 0usize;
    for (turn_index, turn) in snapshot.turns.iter().enumerate() {
        let count = turn.user_message_count();
        if count == 0 {
            continue;
        }
        if cut_user_ordinal <= seen_user_messages + count {
            if cut_user_ordinal != seen_user_messages + 1 {
                return Err(BranchError::Unsupported(
                    "This Codex message is inside a multi-message turn, so it can't be branched safely yet.".to_string(),
                ));
            }
            return Ok(Cut {
                before_turn_id: turn.id.clone(),
                dropped_turns: (snapshot.turns.len() - turn_index) as u32,
                kept_turns: turn_index,
            });
        }
        seen_user_messages += count;
    }
    Err(BranchError::Surgery(format!(
        "could not locate Codex cut point (ordinal {cut_user_ordinal})"
    )))
}

/// A request on the source thread. One Codex no longer has (its rollout was
/// deleted, or never written) is not a failed cut: say that it is gone. The
/// code carries the meaning; the message is the app-server's own detail.
fn source_failure(error: SdkError) -> BranchError {
    if error.is_unknown_thread() {
        return BranchError::ConversationMissing(format!("Codex {error}"));
    }
    branch_surgery(error)
}

fn branch_surgery(error: SdkError) -> BranchError {
    BranchError::Surgery(format!("Codex app-server branching failed: {error}"))
}

#[cfg(test)]
mod tests {
    use super::{check_cut, cut_before, explain_surgery_failure, source_failure, Cut};
    use crate::domain::agents::adapter::BranchError;
    use codex_app_server_sdk_rs::{SdkError, ThreadSnapshot, ThreadTurn};

    fn snapshot(user_counts: &[usize]) -> ThreadSnapshot {
        ThreadSnapshot {
            id: "forked-thread".to_string(),
            turns: user_counts
                .iter()
                .enumerate()
                .map(|(index, count)| ThreadTurn::new(format!("turn-{index}"), *count))
                .collect(),
        }
    }

    #[test]
    fn the_cut_falls_before_the_turn_containing_the_target_prompt() {
        let cut = cut_before(&snapshot(&[1, 0, 1, 1]), 2).unwrap();

        assert_eq!(
            cut,
            Cut {
                before_turn_id: "turn-2".to_string(),
                dropped_turns: 2,
                kept_turns: 2,
            }
        );
    }

    #[test]
    fn the_cut_rejects_a_prompt_inside_a_multi_prompt_turn() {
        let error = cut_before(&snapshot(&[1, 2]), 3).unwrap_err();

        assert!(matches!(error, BranchError::Unsupported(_)), "{error}");
    }

    #[test]
    fn the_cut_rejects_a_missing_prompt() {
        let error = cut_before(&snapshot(&[1]), 3).unwrap_err();

        assert!(matches!(error, BranchError::Surgery(_)), "{error}");
    }

    #[test]
    fn a_fork_that_kept_its_whole_history_is_refused() {
        let cut = cut_before(&snapshot(&[1, 1, 1]), 2).unwrap();

        assert!(check_cut(&snapshot(&[1]), &cut).is_ok());
        let error = check_cut(&snapshot(&[1, 1, 1]), &cut).unwrap_err();
        assert!(
            matches!(&error, BranchError::Surgery(message) if message.contains("kept 3 turns")),
            "{error}"
        );
    }

    /// Codex 0.167 answers a fork of a thread whose rollout is gone this way.
    #[test]
    fn a_source_thread_codex_lost_is_a_missing_conversation() {
        let gone = source_failure(SdkError::Rpc {
            code: -32600,
            message: "no rollout found for thread id 0199a000-0000-7000-8000-000000000000"
                .to_string(),
        });
        assert!(
            matches!(&gone, BranchError::ConversationMissing(message)
                if message.starts_with("Codex app-server returned error -32600: no rollout")),
            "{gone}"
        );

        let refused = source_failure(SdkError::Rpc {
            code: -32600,
            message: "Invalid request: missing field `threadId`".to_string(),
        });
        assert!(matches!(refused, BranchError::Surgery(_)), "{refused}");

        // A missing conversation is not hidden behind the app-server's exit.
        let kept = explain_surgery_failure(gone, Some("exited".to_string()));
        assert!(
            matches!(kept, BranchError::ConversationMissing(_)),
            "{kept}"
        );
    }

    #[test]
    fn a_fork_the_app_server_died_on_says_why() {
        let died = "Codex app-server exited with status 1: simulated codex failure".to_string();
        let error = explain_surgery_failure(
            BranchError::Surgery("Codex app-server branching failed: stdout closed".to_string()),
            Some(died.clone()),
        );
        assert!(
            matches!(&error, BranchError::Surgery(message) if *message == died),
            "{error}"
        );

        let refused = explain_surgery_failure(
            BranchError::Unsupported("multi-message turn".to_string()),
            Some(died),
        );
        assert!(matches!(refused, BranchError::Unsupported(_)), "{refused}");

        let alive = explain_surgery_failure(BranchError::Surgery("rejected".to_string()), None);
        assert!(matches!(&alive, BranchError::Surgery(message) if message == "rejected"));
    }
}
