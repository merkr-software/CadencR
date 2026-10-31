use crate::domain::agents::adapter::{
    RuntimeError, RuntimeEvent, RuntimeEventKind, RuntimeEventMetadata,
};
use crate::domain::agents::opencode::acp::prompt_usage::context_usage;
use opencode_sdk_rs::{Message, MessageRole, OpenCodeClient};
use serde_json::json;
use tokio::sync::mpsc;

pub(super) async fn poll_once(
    client: &OpenCodeClient,
    directory: &str,
    root_session_id: &str,
    context_window: Option<u64>,
    state: &mut RootUsageState,
    runtime_tx: &mpsc::Sender<Result<RuntimeEvent, RuntimeError>>,
) -> Result<bool, ()> {
    match client.list_messages(root_session_id, Some(directory)).await {
        Ok(messages) => {
            if let Some(event) = state.handle_messages(root_session_id, context_window, &messages) {
                runtime_tx.send(Ok(event)).await.map_err(|_| ())?;
                return Ok(true);
            }
        }
        Err(error) => {
            tracing::debug!(%error, "OpenCode root usage listener: list_messages failed");
        }
    }
    Ok(false)
}

#[derive(Default)]
pub(super) struct RootUsageState {
    last_context_tokens: Option<u64>,
}

impl RootUsageState {
    pub(super) fn handle_messages(
        &mut self,
        root_session_id: &str,
        context_window: Option<u64>,
        messages: &[Message],
    ) -> Option<RuntimeEvent> {
        let tokens = messages
            .iter()
            .rev()
            .filter(|message| matches!(message.role, MessageRole::Assistant))
            .find_map(|message| message.tokens.as_ref())?;
        let usage = context_usage(tokens.input, tokens.cache.read)?;
        if self.last_context_tokens == Some(usage.input_tokens) {
            return None;
        }
        self.last_context_tokens = Some(usage.input_tokens);
        Some(RuntimeEvent::new(
            RuntimeEventMetadata {
                session_id: Some(root_session_id.to_string()),
                usage: Some(usage.clone()),
                context_window,
                raw: json!({
                    "type": "usage_update",
                    "source": "http_poll",
                    "session_id": root_session_id,
                    "input_tokens": usage.input_tokens,
                    "context_window": context_window,
                }),
            },
            RuntimeEventKind::Other,
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::RootUsageState;
    use opencode_sdk_rs::{Message, MessageRole, TokenCacheUsage, TokenUsage};

    fn assistant(tokens: Option<TokenUsage>) -> Message {
        Message {
            id: "msg_1".to_string(),
            session_id: "ses_1".to_string(),
            role: MessageRole::Assistant,
            parts: vec![],
            created_at: None,
            model: Some("openai/gpt-5.4".to_string()),
            tokens,
            finished: false,
            completed_at: None,
            finish: None,
            error: None,
            variant: None,
            error_name: None,
        }
    }

    fn tokens(input: u64, cache_read: u64) -> TokenUsage {
        TokenUsage {
            total: None,
            input,
            output: 100,
            reasoning: 0,
            cache: TokenCacheUsage {
                read: cache_read,
                write: 0,
            },
        }
    }

    #[test]
    fn emits_usage_for_first_nonzero_snapshot() {
        let mut state = RootUsageState::default();
        let event = state
            .handle_messages(
                "ses_1",
                Some(200_000),
                &[assistant(Some(tokens(10_000, 2_000)))],
            )
            .expect("usage event");
        let usage = event.usage().expect("event usage");
        assert_eq!(usage.input_tokens, 12_000);
        assert_eq!(usage.output_tokens, 0);
        assert_eq!(event.context_window(), Some(200_000));
    }

    #[test]
    fn suppresses_duplicate_snapshots() {
        let mut state = RootUsageState::default();
        let messages = [assistant(Some(tokens(10_000, 2_000)))];
        assert!(state.handle_messages("ses_1", None, &messages).is_some());
        assert!(state.handle_messages("ses_1", None, &messages).is_none());
    }
}
