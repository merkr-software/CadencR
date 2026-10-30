use super::scope::SessionScope;
use super::send_message::publish_generated_user_message;
use crate::app_state::AppState;
use crate::domain::sessions::models::AgentMessageOrigin;
use crate::domain::sessions::user_messages::{
    persist_user_message, NewUserMessage, PersistedUserMessage,
};
use crate::domain::ws_session::runtime::application::dispatch_control_prompt_with_message_uuid;
use crate::error::AppError;

pub(super) async fn persist_generated_user_message(
    state: &AppState,
    target_session_id: i64,
    source: &SessionScope,
    content: &str,
    note: &str,
    message_uuid: uuid::Uuid,
) -> Result<(PersistedUserMessage, AgentMessageOrigin), AppError> {
    let mut tx = state.write_pool.begin().await?;
    let persisted = persist_user_message(
        &mut tx,
        NewUserMessage {
            session_id: target_session_id,
            content,
            message_uuid,
            delivery_state: Some("pending_agent"),
        },
    )
    .await?;
    if persisted.inserted {
        persist_origin(&mut tx, &persisted, source, note).await?;
    }
    tx.commit().await?;
    let origin =
        crate::domain::sessions::repository::get_message_origin(&state.write_pool, persisted.id)
            .await?
            .ok_or_else(|| {
                AppError::Internal(format!(
                    "message {} is missing canonical provenance",
                    persisted.id
                ))
            })?;
    validate_origin(&persisted, &origin, source, note)?;
    Ok((persisted, origin))
}

async fn persist_origin(
    tx: &mut sqlx::Transaction<'_, sqlx::Sqlite>,
    message: &PersistedUserMessage,
    source: &SessionScope,
    note: &str,
) -> Result<(), AppError> {
    sqlx::query(
        "INSERT INTO agent_message_origins
         (message_id, origin_kind, source_session_id, source_feature_id, source_project_id, note)
         VALUES (?, 'session_generated', ?, ?, ?, ?)",
    )
    .bind(message.id)
    .bind(source.session_id)
    .bind(source.feature_id)
    .bind(source.project_id)
    .bind(note)
    .execute(&mut **tx)
    .await?;
    Ok(())
}

fn validate_origin(
    message: &PersistedUserMessage,
    origin: &AgentMessageOrigin,
    source: &SessionScope,
    note: &str,
) -> Result<(), AppError> {
    if crate::domain::sessions::repository::origin_matches_session_generated(
        origin,
        source.session_id,
        source.feature_id,
        source.project_id,
        Some(note),
    ) {
        return Ok(());
    }
    Err(AppError::Conflict(format!(
        "message UUID {} already has different provenance on message row {}",
        message.message_uuid, message.id
    )))
}

pub(super) async fn persist_and_broadcast_generated_user_message(
    state: &AppState,
    source: &SessionScope,
    target_session_id: i64,
    target_feature_id: i64,
    content: &str,
    note: &str,
    message_uuid: uuid::Uuid,
) -> Result<PersistedUserMessage, AppError> {
    let (message, origin) = persist_generated_user_message(
        state,
        target_session_id,
        source,
        content,
        note,
        message_uuid,
    )
    .await?;
    publish_generated_user_message(state, target_feature_id, &message, origin).await?;
    Ok(message)
}

pub(super) async fn dispatch_generated_prompt(
    state: &AppState,
    target_feature_id: i64,
    target_session_id: i64,
    content: &str,
    message_uuid: uuid::Uuid,
) -> Result<(), AppError> {
    let result = dispatch_control_prompt_with_message_uuid(
        state,
        target_feature_id,
        target_session_id,
        content,
        true,
        Some(message_uuid),
    )
    .await;
    if let Err(dispatch_error) = &result {
        if let Err(state_error) = crate::domain::sessions::user_messages::update_delivery_state(
            &state.write_pool,
            target_session_id,
            &message_uuid.to_string(),
            "delivery_failed",
        )
        .await
        {
            return Err(AppError::Internal(format!(
                "generated prompt dispatch failed ({dispatch_error}) and its receipt state could not be persisted ({state_error})"
            )));
        }
    }
    result.map(|outcome| outcome.delivery_confirmed())
}
