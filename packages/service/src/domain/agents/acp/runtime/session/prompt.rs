//! Prompt dispatch for [`AcpRuntimeSession`].

use crate::shared::discard::IgnoreClosed;
use std::sync::atomic::Ordering;

use serde_json::Value;

use super::AcpRuntimeSession;
use crate::domain::agents::adapter::RuntimeError;

use super::super::prompt_turn::{acp_prompt_blocks_from_content, build_prompt_params};
use super::super::turn_lifecycle::{
    finalize_turn, request_prompt_with_cancel, start_turn_on_model,
};

impl AcpRuntimeSession {
    pub(super) async fn prompt_input(
        &self,
        content: Value,
        client_message_id: Option<String>,
    ) -> Result<(), RuntimeError> {
        // ACP v1 has no portable steering request. Serialize prompts so each
        // accepted input gets an authoritative result. A Stop withdraws inputs
        // that were waiting behind the turn it interrupted.
        let cancels = self.prompt_cancel.cancels();
        let turn_guard = self.prompt_turn_lock.lock().await;
        if self.prompt_cancel.cancelled_since(cancels) {
            return Err(RuntimeError::input_withdrawn(
                "the turn was stopped before this follow-up reached the agent",
            ));
        }
        let session_id = self.require_session_id().await?;
        let prompt = acp_prompt_blocks_from_content(content);
        self.hooks.validate_prompt_blocks(&prompt)?;
        let supports = self.supports_set_config_option.load(Ordering::SeqCst);
        let model = self.current_model.read().await.clone();
        let effort = self.current_effort.read().await.clone();
        start_turn_on_model(self.local_tx(), &self.indexer, &session_id, model.clone()).await;
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

        let reply = match request_prompt_with_cancel(
            &self.client,
            params,
            &self.prompt_cancel,
            self.local_tx(),
        )
        .await
        {
            Ok(reply) => reply,
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
                self.local_tx().send(Ok(event)).await.ignore_closed();
            }
        }
        let Some(reply) = reply else {
            return Ok(());
        };
        let (response, resume_updates) = reply.after_prior_events().await?;
        if let Some(reason) = response.get("stopReason").and_then(Value::as_str) {
            tracing::debug!(stop_reason = reason, "session/prompt completed");
            finalize_turn(
                self.local_tx(),
                &self.indexer,
                Some(session_id),
                self.context_window,
                self.hooks.prompt_response_usage(&response),
                reason,
                &response,
            )
            .await;
        }
        drop(turn_guard);
        drop(resume_updates);
        Ok(())
    }
}
