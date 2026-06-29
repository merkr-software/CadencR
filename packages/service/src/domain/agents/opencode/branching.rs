use std::time::Duration;

use async_trait::async_trait;
use opencode_sdk_rs::{Message, MessageRole, OpenCodeClient, SdkError};

use super::acp::spawn_headless_acp;
use crate::domain::agents::adapter::{BranchContext, BranchError, BranchResult, SessionBranching};

const BRANCH_TIMEOUT: Duration = Duration::from_secs(20);
const SERVER_READY_TIMEOUT: Duration = Duration::from_secs(5);
const SERVER_READY_POLL: Duration = Duration::from_millis(100);

pub(super) static OPENCODE_SESSION_BRANCHING: OpenCodeSessionBranching = OpenCodeSessionBranching;

pub(super) struct OpenCodeSessionBranching;

#[async_trait]
impl SessionBranching for OpenCodeSessionBranching {
    async fn truncate_before(&self, ctx: &BranchContext) -> Result<BranchResult, BranchError> {
        let (client, port) = spawn_headless_acp(ctx.cwd.as_os_str())
            .await
            .map_err(|error| BranchError::Surgery(format!("OpenCode ACP spawn failed: {error}")))?;
        let http = OpenCodeClient::new(port);
        let result = tokio::time::timeout(BRANCH_TIMEOUT, truncate_with_client(&http, ctx)).await;
        client.shutdown().await;
        result.map_err(|_| BranchError::Surgery("OpenCode fork timed out".to_string()))?
    }
}

async fn truncate_with_client(
    client: &OpenCodeClient,
    ctx: &BranchContext,
) -> Result<BranchResult, BranchError> {
    let messages = wait_for_messages(client, &ctx.source_runtime_session_id).await?;
    let message_id = cut_message_id(ctx, &messages)?;
    let directory = ctx.cwd.to_string_lossy();
    let forked = client
        .fork_session(
            &ctx.source_runtime_session_id,
            Some(&message_id),
            Some(directory.as_ref()),
        )
        .await
        .map_err(branch_surgery)?;
    Ok(BranchResult {
        new_runtime_session_id: forked.id,
    })
}

async fn wait_for_messages(
    client: &OpenCodeClient,
    session_id: &str,
) -> Result<Vec<Message>, BranchError> {
    let deadline = tokio::time::Instant::now() + SERVER_READY_TIMEOUT;
    loop {
        match client.list_messages(session_id).await {
            Ok(messages) => return Ok(messages),
            Err(error) if tokio::time::Instant::now() < deadline => {
                tracing::debug!(%error, "waiting for OpenCode HTTP backend");
                tokio::time::sleep(SERVER_READY_POLL).await;
            }
            Err(error) => return Err(branch_surgery(error)),
        }
    }
}

fn cut_message_id(ctx: &BranchContext, messages: &[Message]) -> Result<String, BranchError> {
    if let Some(uuid) = ctx
        .cut_provider_uuid
        .as_ref()
        .filter(|uuid| messages.iter().any(|message| message.id == **uuid))
    {
        return Ok(uuid.clone());
    }
    let mut seen_user_messages = 0usize;
    for message in messages {
        if message.role != MessageRole::User {
            continue;
        }
        seen_user_messages += 1;
        if seen_user_messages == ctx.cut_user_ordinal {
            return Ok(message.id.clone());
        }
    }
    Err(BranchError::Surgery(format!(
        "could not locate OpenCode cut point (ordinal {})",
        ctx.cut_user_ordinal
    )))
}

fn branch_surgery(error: SdkError) -> BranchError {
    BranchError::Surgery(format!("OpenCode branching failed: {error}"))
}

#[cfg(test)]
mod tests {
    use super::cut_message_id;
    use crate::domain::agents::adapter::BranchContext;
    use opencode_sdk_rs::{Message, MessageRole};

    fn ctx(ordinal: usize, uuid: Option<&str>) -> BranchContext {
        BranchContext {
            cwd: std::path::PathBuf::from("/tmp/project"),
            source_runtime_session_id: "ses_src".to_string(),
            cut_provider_uuid: uuid.map(ToOwned::to_owned),
            cut_user_ordinal: ordinal,
        }
    }

    fn message(id: &str, role: MessageRole) -> Message {
        Message {
            id: id.to_string(),
            session_id: "ses_src".to_string(),
            role,
            parts: Vec::new(),
            created_at: None,
            model: None,
            tokens: None,
            finished: true,
        }
    }

    #[test]
    fn cut_message_id_prefers_provider_uuid() {
        let messages = vec![message("msg_provider", MessageRole::User)];
        let id = cut_message_id(&ctx(2, Some("msg_provider")), &messages).unwrap();
        assert_eq!(id, "msg_provider");
    }

    #[test]
    fn cut_message_id_falls_back_when_provider_uuid_is_absent() {
        let messages = vec![message("msg_u1", MessageRole::User)];
        let id = cut_message_id(&ctx(1, Some("msg_missing")), &messages).unwrap();
        assert_eq!(id, "msg_u1");
    }

    #[test]
    fn cut_message_id_ignores_non_opencode_provider_uuid() {
        let messages = vec![message("msg_u1", MessageRole::User)];
        let id = cut_message_id(&ctx(1, Some("not-opencode-id")), &messages).unwrap();
        assert_eq!(id, "msg_u1");
    }

    #[test]
    fn cut_message_id_falls_back_to_user_ordinal() {
        let messages = vec![
            message("msg_u1", MessageRole::User),
            message("msg_a1", MessageRole::Assistant),
            message("msg_u2", MessageRole::User),
        ];
        let id = cut_message_id(&ctx(2, None), &messages).unwrap();
        assert_eq!(id, "msg_u2");
    }
}
