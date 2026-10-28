//! The system-generated prompt that resumes an interrupted conversation.

use std::time::Duration;

use uuid::Uuid;

use crate::app_state::AppState;
use crate::domain::feature_events::FeatureEventAction;
use crate::domain::sessions::user_messages::{
    persist_user_message, update_delivery_state, NewUserMessage, PersistedUserMessage,
};
use crate::domain::ws_session::handler::session_prompt::{
    dispatch_control_prompt_with_message_uuid, publish_user_message,
};
use crate::error::AppError;

/// What the agent is told. It names what was lost (the running command,
/// background work, a pending question) so the agent re-checks or re-asks
/// instead of assuming it finished. One text for every case: the message
/// identity is stable per continuation, so its content must be too.
pub(super) const CONTINUE_PROMPT: &str = "Cadencr restarted while you were working (an app \
update or restart), which interrupted your previous turn. Any command, background task, or \
sub-agent that was still running was stopped, and any question or permission request you were \
waiting on the user for was lost. Continue where you left off: re-run anything that was \
interrupted if it is still needed, and ask again anything you were waiting on the user for.";

/// `agent_message_origins.note` of the prompt; the frontend renders a message
/// with this note as an automatic resume rather than as the user's words.
pub(super) const ORIGIN_NOTE: &str = "restart_continuation";

/// Deadlock backstop for one resume, not a latency budget: the prompt path
/// spawns the provider process, which can be slow on a cold start.
const DISPATCH_TIMEOUT: Duration = Duration::from_secs(300);

/// Stable per continuation, so a pass that runs twice reuses the message
/// instead of sending a second one.
pub(super) fn message_uuid(continuation_id: i64) -> Uuid {
    Uuid::new_v5(
        &Uuid::NAMESPACE_URL,
        format!("cadencr:restart-continuation:{continuation_id}").as_bytes(),
    )
}

/// Persist the prompt (marked system-generated), show it to connected
/// clients, then start the turn that resumes the provider session.
pub(super) async fn deliver(
    state: &AppState,
    feature_id: i64,
    session_id: i64,
    continuation_id: i64,
) -> Result<(), AppError> {
    let message_uuid = message_uuid(continuation_id);
    let message = persist(state, session_id, message_uuid).await?;
    let origin =
        crate::domain::sessions::repository::get_message_origin(&state.write_pool, message.id)
            .await?;
    publish_user_message(
        &state.ws_feature_senders,
        None,
        feature_id,
        &message,
        origin,
        false,
    )
    .await
    .map_err(|error| AppError::Internal(error.to_string()))?;
    if message.inserted {
        state
            .feature_events_tx
            .emit(feature_id, None, FeatureEventAction::Reordered);
    }
    let dispatch = dispatch_control_prompt_with_message_uuid(
        state,
        feature_id,
        session_id,
        CONTINUE_PROMPT,
        true,
        Some(message_uuid),
    );
    let result = match tokio::time::timeout(DISPATCH_TIMEOUT, dispatch).await {
        Ok(result) => result,
        Err(_) => Err(AppError::Internal(format!(
            "resuming the conversation timed out after {}s",
            DISPATCH_TIMEOUT.as_secs()
        ))),
    };
    if let Err(error) = &result {
        update_delivery_state(
            &state.write_pool,
            session_id,
            &message_uuid.to_string(),
            "delivery_failed",
        )
        .await
        .map_err(|state_error| {
            AppError::Internal(format!(
                "{error}; the prompt's delivery state could not be saved either: {state_error}"
            ))
        })?;
    }
    result
}

async fn persist(
    state: &AppState,
    session_id: i64,
    message_uuid: Uuid,
) -> Result<PersistedUserMessage, AppError> {
    let mut tx = state.write_pool.begin().await?;
    let message = persist_user_message(
        &mut tx,
        NewUserMessage {
            session_id,
            content: CONTINUE_PROMPT,
            message_uuid,
            delivery_state: Some("pending_agent"),
        },
    )
    .await?;
    if message.inserted {
        sqlx::query(
            "INSERT INTO agent_message_origins (message_id, origin_kind, note)
             VALUES (?, 'system_generated', ?)",
        )
        .bind(message.id)
        .bind(ORIGIN_NOTE)
        .execute(&mut *tx)
        .await?;
    }
    tx.commit().await?;
    Ok(message)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn each_continuation_has_its_own_stable_message_uuid() {
        assert_eq!(message_uuid(4), message_uuid(4));
        assert_ne!(message_uuid(4), message_uuid(5));
    }

    #[tokio::test]
    async fn the_prompt_is_persisted_once_as_a_system_generated_message() {
        let (pool, _, feature_id) =
            crate::domain::schedules::repository::test_support::fixture().await;
        let session_id = super::super::store::tests::session(&pool, feature_id, "paused").await;
        let state = AppState::with_pool(pool.clone());

        let first = persist(&state, session_id, message_uuid(1)).await.unwrap();
        let second = persist(&state, session_id, message_uuid(1)).await.unwrap();

        assert!(first.inserted);
        assert!(!second.inserted);
        assert_eq!(first.id, second.id);
        let origin = crate::domain::sessions::repository::get_message_origin(&pool, first.id)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(origin.origin_kind, "system_generated");
        assert_eq!(origin.note.as_deref(), Some(ORIGIN_NOTE));
    }
}
