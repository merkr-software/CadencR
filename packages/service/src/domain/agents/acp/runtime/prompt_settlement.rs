//! Settles provider prompt delivery and the visible turn independently.

use std::sync::Mutex;

use serde_json::Value;
use tokio::sync::{mpsc, oneshot};

use crate::domain::agents::acp::AcpClient;
use crate::domain::agents::adapter::{
    RuntimeError, RuntimeEvent, RuntimeEventKind, RuntimeEventMetadata, RuntimeResultError,
    RuntimeTokenUsage,
};
use crate::shared::discard::IgnoreClosed;

use super::background_work;
use super::events_stream_blocks::EventIndexer;
use super::prompt_receipts::PendingPromptReceipts;
use super::prompt_turn_lock::{PromptRequest, PromptSettlement};
use super::provider_hooks::AcpProviderHooks;
use super::turn_lifecycle::{publish_prompt_boundary, PromptCancel, PromptReply};
use super::turn_result::{accounting_token_usage, turn_result};

#[derive(bon::Builder)]
pub(super) struct CompletePrompt<'a> {
    client: &'a AcpClient,
    tx: &'a mpsc::Sender<Result<RuntimeEvent, RuntimeError>>,
    indexer: &'a Mutex<EventIndexer>,
    session_id: &'a str,
    context_window: Option<u64>,
    hooks: &'a dyn AcpProviderHooks,
    request: PromptRequest<'a>,
    first_in_turn: bool,
    cancel: &'a PromptCancel,
    epoch: u64,
    response_id: Option<&'a str>,
    receipt: Option<(&'a PendingPromptReceipts, &'a str)>,
}

impl CompletePrompt<'_> {
    pub(super) async fn complete_initial(self, reply: Result<PromptReply, RuntimeError>) {
        let tx = self.tx;
        let outcome = self.complete(reply).await;
        if let Err(RuntimeError::PromptDeliveryFailed {
            message,
            surfaced_on_stream: false,
        }) = outcome
        {
            let event = RuntimeEvent::new(
                RuntimeEventMetadata::default(),
                RuntimeEventKind::ProviderError {
                    message,
                    code: Some("PROMPT_DELIVERY_FAILED".into()),
                    parent_tool_use_id: None,
                },
            );
            tx.send(Ok(event)).await.ignore_closed();
        }
        // Settlement already reported any final error on the stream.
    }

    pub(super) async fn complete(
        mut self,
        reply: Result<PromptReply, RuntimeError>,
    ) -> Result<(), RuntimeError> {
        let (response, resumed) = self.ordered_response(reply).await;
        let body = response.as_ref().ok();
        let reason = body.and_then(stop_reason);
        let retain = body.filter(|_| reason.is_some_and(|reason| reason != "cancelled"));
        let (settling, settlement) = self.request.settle(retain).await;
        let cancelled_by_user = self.cancel.cancelled_since(self.epoch);
        let failure = match &response {
            Err(error) => Some(error.to_string()),
            Ok(_) if reason.is_none() => Some("ACP session/prompt returned no stop reason".into()),
            Ok(_)
                if reason == Some("cancelled")
                    && self.response_id.is_some()
                    && !self.cooperative_stop_confirms_delivery(cancelled_by_user) =>
            {
                Some("The agent cancelled this prompt".into())
            }
            Ok(_) => None,
        };
        self.confirm_receipt(failure.is_none()).await;
        let killed = response
            .as_ref()
            .err()
            .is_some_and(RuntimeError::is_stop_escalation);
        let usage = body.and_then(|body| accounting_token_usage(body, self.response_id));
        let surfaced_on_stream = match settlement {
            PromptSettlement::Outstanding => {
                self.publish_intermediate(body, usage).await;
                cancelled_by_user
            }
            PromptSettlement::Final { .. }
                if killed || (cancelled_by_user && resumed.is_none()) =>
            {
                true
            }
            PromptSettlement::Final { earlier_boundary } => {
                self.finish_turn(
                    body,
                    reason,
                    earlier_boundary.as_ref(),
                    usage,
                    failure.as_deref(),
                    cancelled_by_user,
                )
                .await
            }
        };
        drop(self.request);
        drop(settling);
        drop(resumed);

        match response {
            Err(error) if error.is_stop_escalation() => Err(error),
            _ => match failure {
                Some(message) => Err(RuntimeError::PromptDeliveryFailed {
                    message,
                    surfaced_on_stream,
                }),
                None => Ok(()),
            },
        }
    }

    fn cooperative_stop_confirms_delivery(&self, cancelled_by_user: bool) -> bool {
        cancelled_by_user
            && (self.first_in_turn
                || self
                    .receipt
                    .is_some_and(|(receipts, id)| !receipts.is_pending(id)))
    }

    async fn confirm_receipt(&self, accepted: bool) {
        let Some((receipts, id)) = self.receipt else {
            return;
        };
        if accepted {
            if let Some(event) = receipts.acknowledge_client_message_id(id) {
                self.tx.send(Ok(event)).await.ignore_closed();
            }
        } else {
            receipts.discard_client_message_id(id);
        }
    }

    async fn publish_intermediate(&self, body: Option<&Value>, usage: Option<RuntimeTokenUsage>) {
        self.publish_usage(usage).await;
        if let Some(pending) = body.and_then(background_work::pending) {
            let signal = self
                .indexer
                .lock()
                .expect("EventIndexer poisoned")
                .background_work
                .observe_progress(pending);
            if signal.is_some() {
                let event =
                    RuntimeEvent::new(RuntimeEventMetadata::default(), RuntimeEventKind::Other)
                        .with_background_agent(signal);
                self.tx.send(Ok(event)).await.ignore_closed();
            }
        }
    }

    async fn publish_usage(&self, usage: Option<RuntimeTokenUsage>) {
        if let Some(usage) = usage {
            let event = RuntimeEvent::new(
                RuntimeEventMetadata {
                    session_id: Some(self.session_id.into()),
                    ..Default::default()
                },
                RuntimeEventKind::UsageAccounting,
            )
            .with_token_usage(Some(usage));
            self.tx.send(Ok(event)).await.ignore_closed();
        }
    }

    async fn finish_turn(
        &self,
        body: Option<&Value>,
        reason: Option<&str>,
        earlier_boundary: Option<&Value>,
        usage: Option<RuntimeTokenUsage>,
        failure: Option<&str>,
        cancelled_by_user: bool,
    ) -> bool {
        if cancelled_by_user {
            self.result(
                body.unwrap_or(&Value::Null),
                "cancelled",
                Some(false),
                usage,
                None,
            )
            .await;
            return true;
        }
        if let Some(message) = failure {
            if let Some(earlier) = earlier_boundary {
                self.publish_usage(usage).await;
                // Its usage and explicit work snapshot were already consumed
                // at the earlier wire boundary. A later release wins.
                self.result(
                    earlier,
                    stop_reason(earlier).unwrap_or("end_turn"),
                    body.and_then(background_work::pending),
                    None,
                    None,
                )
                .await;
                return false;
            }
            self.result(
                body.unwrap_or(&Value::Null),
                reason.unwrap_or("prompt_failed"),
                body.and_then(background_work::pending),
                usage,
                Some(message),
            )
            .await;
            return true;
        }
        let body = body.unwrap_or(&Value::Null);
        let reason = reason.unwrap_or("prompt_failed");
        let pending = if reason == "end_turn" {
            background_work::pending(body)
        } else if self.response_id.is_none() {
            Some(false)
        } else {
            background_work::pending(body)
        };
        self.result(body, reason, pending, usage, None).await;
        false
    }

    async fn result(
        &self,
        body: &Value,
        reason: &str,
        pending: Option<bool>,
        usage: Option<RuntimeTokenUsage>,
        error: Option<&str>,
    ) {
        let result = turn_result(
            Some(self.session_id.into()),
            self.context_window,
            self.hooks.prompt_response_usage(body),
            reason,
            body,
        )
        .with_token_usage(usage)
        .with_result_error(error.map(|message| RuntimeResultError {
            code: "PROMPT_DELIVERY_FAILED".into(),
            message: message.to_owned(),
        }));
        publish_prompt_boundary(self.tx, self.indexer, reason, pending, result).await;
    }
    async fn ordered_response(
        &self,
        reply: Result<PromptReply, RuntimeError>,
    ) -> (Result<Value, RuntimeError>, Option<oneshot::Sender<()>>) {
        match reply {
            Ok(reply) => match reply.ordered(self.client, self.cancel, self.tx).await {
                Ok((response, resumed)) => (response, Some(resumed)),
                Err(error) => (Err(error), None),
            },
            Err(error) => (Err(error), None),
        }
    }
}

fn stop_reason(body: &Value) -> Option<&str> {
    body.get("stopReason").and_then(Value::as_str)
}
