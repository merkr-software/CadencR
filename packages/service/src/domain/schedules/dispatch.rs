//! Delivers a schedule's prompt when its time comes.
//!
//! Both target kinds converge on `dispatch_control_prompt_with_message_uuid`
//! with `replay = false`, so the prompt is persisted and broadcast as an
//! ordinary user message: a scheduled message must be indistinguishable from
//! one the user typed, both in the transcript and to the agent.

mod overrides;
mod spawn;

use uuid::Uuid;

use super::models::{Schedule, TargetKind};
use crate::app_state::AppState;
use crate::domain::ws_session::handler::session_prompt::dispatch_control_prompt_with_message_uuid;
use crate::error::AppError;

/// Deliver a schedule's prompt, returning the conversation it landed in.
///
/// `occurrence` identifies which firing this is (the slot's timestamp, or a
/// manual-run marker). It seeds the message uuid so a retry after a crash
/// mid-dispatch reconciles with the message already persisted instead of
/// duplicating it.
pub async fn run(state: &AppState, schedule: &Schedule, occurrence: &str) -> Result<i64, AppError> {
    match schedule.target.kind {
        TargetKind::Conversation => deliver_to_conversation(state, schedule, occurrence).await,
        TargetKind::NewConversation => spawn::run(state, schedule, occurrence).await,
    }
}

async fn deliver_to_conversation(
    state: &AppState,
    schedule: &Schedule,
    occurrence: &str,
) -> Result<i64, AppError> {
    let feature_id = schedule.target.feature_id.ok_or_else(|| {
        AppError::Internal(format!(
            "schedule {} targets a conversation but has no feature_id",
            schedule.id
        ))
    })?;
    let session_id = resolve_or_create_session(state, feature_id).await?;
    overrides::apply(state, feature_id, session_id, schedule).await?;
    dispatch_control_prompt_with_message_uuid(
        state,
        feature_id,
        session_id,
        &schedule.prompt,
        false,
        Some(message_uuid(schedule.id, occurrence)),
    )
    .await?;
    Ok(feature_id)
}

/// Stable per (schedule, occurrence) so a redelivery is recognisably the same
/// message rather than a second one.
pub(super) fn message_uuid(schedule_id: i64, occurrence: &str) -> Uuid {
    Uuid::new_v5(
        &Uuid::NAMESPACE_URL,
        format!("cadencr:schedule:{schedule_id}:{occurrence}").as_bytes(),
    )
}

/// Resolve the conversation's session, creating a bare one when it has never
/// spawned an agent — scheduling is keyed on the conversation precisely so the
/// very first message of a brand-new one can be scheduled.
///
/// Unlike the live prompt path this never forces an existing session to
/// `paused`: dispatch drives status itself and must not disturb a session that
/// is mid-turn.
pub(super) async fn resolve_or_create_session(
    state: &AppState,
    feature_id: i64,
) -> Result<i64, AppError> {
    if let Some((id,)) = sqlx::query_as::<_, (i64,)>(
        "SELECT id FROM agent_sessions WHERE feature_id = ? AND agent_type = 'session'
         ORDER BY id DESC LIMIT 1",
    )
    .bind(feature_id)
    .fetch_optional(&state.read_pool)
    .await?
    {
        return Ok(id);
    }
    Ok(sqlx::query_scalar::<_, i64>(
        "INSERT INTO agent_sessions (feature_id, agent_type, status) VALUES (?, 'session', 'paused')
         RETURNING id",
    )
    .bind(feature_id)
    .fetch_one(&state.write_pool)
    .await?)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::schedules::repository::test_support::fixture;

    #[test]
    fn the_same_occurrence_always_yields_the_same_message_uuid() {
        let first = message_uuid(7, "2026-07-24 09:00:00");
        assert_eq!(first, message_uuid(7, "2026-07-24 09:00:00"));
        assert_ne!(first, message_uuid(7, "2026-07-25 09:00:00"));
        assert_ne!(first, message_uuid(8, "2026-07-24 09:00:00"));
    }

    #[tokio::test]
    async fn a_session_is_created_once_then_reused() {
        let (pool, _, feature_id) = fixture().await;
        let state = AppState::with_pool(pool.clone());

        let first = resolve_or_create_session(&state, feature_id).await.unwrap();
        let second = resolve_or_create_session(&state, feature_id).await.unwrap();
        assert_eq!(first, second);

        let count: i64 =
            sqlx::query_scalar("SELECT COUNT(*) FROM agent_sessions WHERE feature_id = ?")
                .bind(feature_id)
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(count, 1);
    }
}
