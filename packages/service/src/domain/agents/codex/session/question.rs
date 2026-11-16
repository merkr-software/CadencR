use std::future::Future;

use codex_app_server_sdk_rs::SdkError;
use serde_json::{json, Value};

use super::CodexSession;
use crate::domain::agents::adapter::{
    AgentRuntimeSession, RuntimeError, RuntimePermissionResponse,
};
use crate::domain::agents::codex::async_questions::{answer_prompt, restored_question_input};
use crate::domain::agents::codex::turn_steer_recovery::{
    steer_failure_recovery, SteerFailureRecovery,
};

impl CodexSession {
    pub(super) async fn respond_async_question(
        &self,
        response: RuntimePermissionResponse,
    ) -> Result<(), RuntimeError> {
        let pending = {
            let questions = self.async_questions.lock().await;
            if questions.contains(&response.request_id) {
                Some(questions.current(&response.request_id)?)
            } else {
                None
            }
        };
        let Some(pending) = pending else {
            // Asked before this runtime existed (a restart, a respawn): only
            // the persisted form remembers it. Codex never waited on it, so
            // the answer is ordinary input to the conversation.
            let prompt = answer_prompt(&restored_question_input(&response)?, &response)?;
            return self.stream_input(Value::String(prompt)).await;
        };
        let prompt = answer_prompt(&pending.raw_json()["tool_input"], &response)?;
        let thread_id = pending
            .session_id()
            .ok_or_else(|| RuntimeError::new("Missing Codex question thread"))?;
        if thread_id == self.thread_id {
            self.stream_input(Value::String(prompt)).await?;
        } else {
            self.send_child_question_answer(thread_id, prompt).await?;
        }
        // Consume only after Codex accepts the input so failures remain retryable.
        let next = self
            .async_questions
            .lock()
            .await
            .complete(&response.request_id)?;
        self.surface_next_question(next)
    }

    /// Drop a question the user closed. Codex never waited on it, so nothing
    /// is sent and the turn goes on.
    pub(super) async fn dismiss_async_question(
        &self,
        request_id: &str,
    ) -> Result<(), RuntimeError> {
        let next = self.async_questions.lock().await.discard(request_id);
        self.surface_next_question(next)
    }

    fn surface_next_question(
        &self,
        next: Option<crate::domain::agents::adapter::RuntimeEvent>,
    ) -> Result<(), RuntimeError> {
        let Some(next) = next else { return Ok(()) };
        self.local_tx
            .send(Ok(next))
            .map_err(|_| RuntimeError::new("Codex question event stream closed"))
    }

    async fn send_child_question_answer(
        &self,
        thread_id: &str,
        prompt: String,
    ) -> Result<(), RuntimeError> {
        let input = self.convert_input(Value::String(prompt)).await?;
        let turn_id = self
            .child_turn_ids
            .read()
            .await
            .get(thread_id)
            .cloned()
            .flatten();
        let delivered = steer_question(turn_id, |turn| {
            let input = &input;
            async move {
                self.client
                    .turn_steer(thread_id, &turn, input, None)
                    .await
                    .map(|_| ())
            }
        })
        .await?;
        if !delivered {
            let turn = self
                .client
                .turn_start(json!({"threadId": thread_id, "input": input}))
                .await?;
            self.child_turn_ids
                .write()
                .await
                .insert(thread_id.to_string(), Some(turn.id));
        }
        Ok(())
    }
}

/// Return false only when a new turn is needed; a mismatch retries the active
/// turn reported by Codex, without interrupting or starting a duplicate turn.
async fn steer_question<F, Fut>(turn: Option<String>, mut steer: F) -> Result<bool, SdkError>
where
    F: FnMut(String) -> Fut,
    Fut: Future<Output = Result<(), SdkError>>,
{
    let Some(turn) = turn else { return Ok(false) };
    match steer(turn).await {
        Ok(()) => Ok(true),
        Err(error) => match steer_failure_recovery(&error) {
            Some(SteerFailureRecovery::StartNewTurn) => Ok(false),
            Some(SteerFailureRecovery::RetryWithTurn(found)) => steer(found).await.map(|()| true),
            None => Err(error),
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rpc(message: &str) -> SdkError {
        SdkError::Rpc {
            code: -32600,
            message: message.into(),
        }
    }

    #[tokio::test]
    async fn active_child_is_steered_and_mismatch_retries_once() {
        let mut calls = Vec::new();
        let delivered = steer_question(Some("old".into()), |turn| {
            calls.push(turn);
            std::future::ready(if calls.len() == 1 {
                Err(rpc("expected active turn id `old` but found `new`"))
            } else {
                Ok(())
            })
        })
        .await
        .unwrap();
        assert!(delivered);
        assert_eq!(calls, ["old", "new"]);
    }

    #[tokio::test]
    async fn completed_child_starts_a_turn_and_unrelated_failures_propagate() {
        assert!(!steer_question(None, |_| std::future::ready(Ok(())))
            .await
            .unwrap());
        assert!(!steer_question(Some("old".into()), |_| {
            std::future::ready(Err(rpc("no active turn to steer")))
        })
        .await
        .unwrap());
        assert!(steer_question(Some("old".into()), |_| {
            std::future::ready(Err(rpc("permission denied")))
        })
        .await
        .is_err());
    }

    #[tokio::test]
    async fn repeated_mismatch_does_not_retry_forever() {
        let mut calls = 0;
        assert!(steer_question(Some("old".into()), |_| {
            calls += 1;
            std::future::ready(Err(rpc("expected active turn id `old` but found `new`")))
        })
        .await
        .is_err());
        assert_eq!(calls, 2);
    }
}
