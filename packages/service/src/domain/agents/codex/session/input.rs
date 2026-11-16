use std::sync::atomic::Ordering;

use codex_app_server_sdk_rs::SdkError;
use serde_json::Value;
use tracing::warn;

use super::CodexSession;
use crate::domain::agents::adapter::{
    AgentRuntimeSession, RuntimeError, RuntimePermissionResponse,
};
use crate::domain::agents::codex::input::user_input_from_content;
use crate::domain::agents::codex::session_permissions::plan_approval_prompt;
use crate::domain::agents::codex::turn_steer_recovery::{
    steer_failure_recovery, SteerFailureRecovery,
};

impl CodexSession {
    pub(super) async fn convert_input(&self, content: Value) -> Result<Vec<Value>, RuntimeError> {
        let mut new_files = Vec::new();
        let input = user_input_from_content(content, &mut new_files)?;
        if !new_files.is_empty() {
            self.temp_files.lock().await.extend(new_files);
        }
        Ok(input)
    }

    pub(super) async fn stream_converted_input(
        &self,
        input: Vec<Value>,
        client_message_id: Option<&str>,
        // Read on entry, before the conversion awaits: a stop meanwhile counts.
        interrupts_at_entry: u64,
    ) -> Result<(), RuntimeError> {
        let mut recovered_steer_failure = false;
        loop {
            if raced_an_interrupt(
                recovered_steer_failure,
                interrupts_at_entry,
                self.interrupts.load(Ordering::SeqCst),
            ) {
                return Err(RuntimeError::input_withdrawn(
                    "Codex turn was stopped before this follow-up reached it",
                ));
            }
            let Some(turn_id) = self.active_turn_id.read().await.clone() else {
                return self.start_turn(input, client_message_id).await;
            };

            let result = self
                .client
                .turn_steer(&self.thread_id, &turn_id, &input, client_message_id)
                .await;
            let Err(error) = result else {
                return Ok(());
            };
            if recovered_steer_failure {
                return Err(RuntimeError::from(error));
            }
            if self.recover_steer_failure(&turn_id, &error).await {
                recovered_steer_failure = true;
                continue;
            }
            return Err(RuntimeError::from(error));
        }
    }

    async fn recover_steer_failure(&self, attempted_turn_id: &str, error: &SdkError) -> bool {
        let Some(recovery) = steer_failure_recovery(error) else {
            return false;
        };
        let mut active_turn_id = self.active_turn_id.write().await;
        if active_turn_id.as_deref() != Some(attempted_turn_id) {
            warn!(
                thread_id = %self.thread_id,
                attempted_turn_id = %attempted_turn_id,
                "Codex turn/steer stale failure ignored because active turn changed"
            );
            return true;
        }
        match recovery {
            SteerFailureRecovery::StartNewTurn => {
                warn!(
                    thread_id = %self.thread_id,
                    turn_id = %attempted_turn_id,
                    "Codex turn/steer found no active turn; starting a new turn"
                );
                *active_turn_id = None;
                true
            }
            SteerFailureRecovery::RetryWithTurn(found_turn_id) => {
                warn!(
                    thread_id = %self.thread_id,
                    attempted_turn_id = %attempted_turn_id,
                    found_turn_id = %found_turn_id,
                    "Codex turn/steer active turn mismatch; retrying with server turn"
                );
                *active_turn_id = Some(found_turn_id);
                true
            }
        }
    }

    pub(super) async fn respond_plan_approval(
        &self,
        response: RuntimePermissionResponse,
    ) -> Result<(), RuntimeError> {
        let prompt = plan_approval_prompt(response.decision, response.feedback);
        self.stream_input(Value::String(prompt)).await
    }
}

/// The turn an input steered was stopped while the input was on its way (its
/// steer failed and an interrupt came since): a retry, or a turn started for
/// it, would run past the Stop.
fn raced_an_interrupt(steer_failed: bool, interrupts_at_entry: u64, interrupts_now: u64) -> bool {
    steer_failed && interrupts_now != interrupts_at_entry
}

#[cfg(test)]
mod tests {
    use super::raced_an_interrupt;

    #[test]
    fn only_a_failed_steer_that_raced_an_interrupt_is_withdrawn() {
        assert!(raced_an_interrupt(true, 3, 4));
        assert!(
            !raced_an_interrupt(true, 3, 3),
            "the turn just ended: start one"
        );
        assert!(
            !raced_an_interrupt(false, 3, 4),
            "a first try still steers or starts"
        );
    }
}
