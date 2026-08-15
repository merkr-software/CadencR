//! Prompt dispatch for [`AcpRuntimeSession`].

use std::sync::atomic::Ordering;

use serde_json::Value;

use super::AcpRuntimeSession;
use crate::domain::agents::adapter::RuntimeError;

use super::super::prompt_turn::{acp_prompt_blocks_from_content, build_prompt_params};
use super::super::turn_lifecycle::{
    await_event_loop_barrier, finalize_turn, request_prompt_with_cancel,
};

impl AcpRuntimeSession {
    pub(super) async fn prompt_input(
        &self,
        content: Value,
        client_message_id: Option<String>,
        finalize_response: bool,
    ) -> Result<(), RuntimeError> {
        self.prompt_input_once(content, client_message_id, finalize_response)
            .await?;
        if finalize_response {
            loop {
                let followup = self.pending_followups.write().await.pop_front();
                let Some((_, followup)) = followup else {
                    break;
                };
                self.prompt_input_once(followup, None, true).await?;
            }
        }
        Ok(())
    }

    async fn prompt_input_once(
        &self,
        content: Value,
        client_message_id: Option<String>,
        finalize_response: bool,
    ) -> Result<(), RuntimeError> {
        let session_id = self.require_session_id().await?;
        let prompt = acp_prompt_blocks_from_content(content);
        let supports = self.supports_set_config_option.load(Ordering::SeqCst);
        let model = self.current_model.read().await.clone();
        let effort = self.current_effort.read().await.clone();
        let receipt_client_message_id = client_message_id.clone();
        if let Some(client_message_id) = client_message_id {
            self.pending_prompt_receipts
                .enqueue(client_message_id, &prompt);
        }
        let mut params = build_prompt_params(
            &session_id,
            prompt,
            model.as_deref(),
            effort.as_deref(),
            supports,
        );
        if let Some(client_message_id) = receipt_client_message_id.as_deref() {
            params["messageId"] = Value::String(client_message_id.to_string());
        }
        self.replay_suppression.store(false, Ordering::SeqCst);

        let response =
            match request_prompt_with_cancel(&self.client, params, &self.prompt_cancel).await {
                Ok(response) => response,
                Err(error) => {
                    if let Some(client_message_id) = receipt_client_message_id.as_deref() {
                        self.pending_prompt_receipts
                            .discard_client_message_id(client_message_id);
                    }
                    return Err(error);
                }
            };
        if let Some(client_message_id) = receipt_client_message_id.as_deref() {
            if let Some(event) = self
                .pending_prompt_receipts
                .acknowledge_client_message_id(client_message_id)
            {
                let _ = self.local_tx.send(Ok(event)).await;
            }
        }
        await_event_loop_barrier(&self.client).await?;
        if finalize_response {
            if let Some(reason) = response.get("stopReason").and_then(Value::as_str) {
                tracing::debug!(stop_reason = reason, "session/prompt completed");
                finalize_turn(
                    &self.local_tx,
                    &self.indexer,
                    self.current_session_id().await,
                    self.context_window,
                    self.hooks.prompt_response_usage(&response),
                    reason,
                    &response,
                )
                .await;
            }
        }
        Ok(())
    }
}
