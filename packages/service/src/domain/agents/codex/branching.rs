use async_trait::async_trait;
use codex_app_server_sdk_rs::{CodexAppServerClient, SdkError, ThreadSnapshot};

use super::{app_server_failure, profile_runtime::app_server_spawn_options, CodexAdapter};
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
    let source = read_snapshot(client, &ctx.source_runtime_session_id).await?;
    let rollback_turns = rollback_turns_for_cut(&source, ctx.cut_user_ordinal)?;
    let forked = client
        .thread_fork(&ctx.source_runtime_session_id, &ctx.cwd)
        .await
        .map_err(branch_surgery)?;
    client
        .thread_rollback(&forked.id, rollback_turns)
        .await
        .map_err(branch_surgery)?;
    Ok(BranchResult {
        new_runtime_session_id: forked.id,
    })
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

fn rollback_turns_for_cut(
    snapshot: &ThreadSnapshot,
    cut_user_ordinal: usize,
) -> Result<u32, BranchError> {
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
            return Ok((snapshot.turns.len() - turn_index) as u32);
        }
        seen_user_messages += count;
    }
    Err(BranchError::Surgery(format!(
        "could not locate Codex cut point (ordinal {cut_user_ordinal})"
    )))
}

fn branch_surgery(error: SdkError) -> BranchError {
    BranchError::Surgery(format!("Codex app-server branching failed: {error}"))
}

#[cfg(test)]
mod tests {
    use super::{explain_surgery_failure, rollback_turns_for_cut};
    use crate::domain::agents::adapter::BranchError;
    use codex_app_server_sdk_rs::{ThreadSnapshot, ThreadTurn};

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
    fn rollback_plan_cuts_before_the_turn_containing_the_target_prompt() {
        let rollback_turns = rollback_turns_for_cut(&snapshot(&[1, 1, 1]), 2).unwrap();

        assert_eq!(rollback_turns, 2);
    }

    #[test]
    fn rollback_plan_rejects_cuts_inside_a_multi_prompt_turn() {
        let error = rollback_turns_for_cut(&snapshot(&[1, 2]), 3).unwrap_err();

        assert!(matches!(error, BranchError::Unsupported(_)), "{error}");
    }

    #[test]
    fn rollback_plan_rejects_missing_cut_prompt() {
        let error = rollback_turns_for_cut(&snapshot(&[1]), 3).unwrap_err();

        assert!(matches!(error, BranchError::Surgery(_)), "{error}");
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
