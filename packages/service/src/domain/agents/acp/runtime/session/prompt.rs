//! Prompt dispatch for [`AcpRuntimeSession`].

use std::sync::atomic::Ordering;

use serde_json::Value;
use tokio::sync::{oneshot, OwnedMutexGuard};

use super::AcpRuntimeSession;
use crate::domain::agents::adapter::RuntimeError;
use crate::shared::discard::SendIgnoreClosed;

use super::super::prompt_settlement::CompletePrompt;
use super::super::prompt_turn::{acp_prompt_blocks_from_content, build_prompt_params};
use super::super::turn_lifecycle::{request_registered_prompt, start_turn_on_model};

impl AcpRuntimeSession {
    pub(super) async fn prompt_input(
        &self,
        content: Value,
        client_message_id: Option<String>,
        delivery_order: &mut Option<OwnedMutexGuard<()>>,
        submitted: &mut Option<oneshot::Sender<()>>,
    ) -> Result<(), RuntimeError> {
        let cancels = self.prompt_cancel.cancels();
        let session_id = self.require_session_id().await?;
        let prompt = acp_prompt_blocks_from_content(content);
        self.hooks.validate_prompt_blocks(&prompt)?;
        let (turn_guard, admission, first) = self.prompt_turn_lock.begin().await;
        if self.prompt_cancel.cancelled_since(cancels) {
            return Err(RuntimeError::input_withdrawn(
                "the turn was stopped before this follow-up reached the agent",
            ));
        }
        let supports = self.supports_set_config_option.load(Ordering::SeqCst);
        let model = self.current_model.read().await.clone();
        let effort = self.current_effort.read().await.clone();
        let epoch = if first {
            let epoch = self.prompt_cancel.begin_prompt();
            start_turn_on_model(self.local_tx(), &self.indexer, &session_id, model.clone()).await;
            epoch
        } else {
            cancels
        };
        let steering = self.prompt_turn_lock.supports_steering();
        let response_id = steering.then(|| {
            client_message_id
                .clone()
                .unwrap_or_else(|| uuid::Uuid::new_v4().to_string())
        });
        if let Some(client_message_id) = &client_message_id {
            self.pending_prompt_receipts.enqueue_prompt(
                client_message_id.clone(),
                &prompt,
                !steering,
            );
        }
        let mut params = build_prompt_params(
            &session_id,
            prompt,
            model.as_deref(),
            effort.as_deref(),
            supports,
        );
        if let Some(client_message_id) = client_message_id.as_deref() {
            params["messageId"] = Value::String(client_message_id.to_string());
        }
        self.replay_suppression.store(false, Ordering::SeqCst);

        let reply = request_registered_prompt(
            &self.client,
            params,
            &self.prompt_cancel,
            self.local_tx(),
            epoch,
            || {
                drop(admission);
                if steering {
                    drop(delivery_order.take());
                }
                if let Some(tx) = submitted.take() {
                    tx.send_ignore_closed(());
                }
            },
        )
        .await;
        CompletePrompt::builder()
            .client(&self.client)
            .tx(self.local_tx())
            .indexer(&self.indexer)
            .session_id(&session_id)
            .maybe_context_window(self.context_window)
            .hooks(self.hooks.as_ref())
            .request(turn_guard)
            .first_in_turn(first)
            .cancel(&self.prompt_cancel)
            .epoch(epoch)
            .maybe_response_id(response_id.as_deref())
            .maybe_receipt(
                client_message_id
                    .as_deref()
                    .map(|id| (self.pending_prompt_receipts.as_ref(), id)),
            )
            .build()
            .complete(reply)
            .await
    }
}
