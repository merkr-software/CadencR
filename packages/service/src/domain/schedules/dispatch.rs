//! Delivers a schedule's prompt when its time comes.
//!
//! Both target kinds converge on `dispatch_control_prompt_with_message_uuid`
//! with `replay = false`, so the prompt is persisted and broadcast as an
//! ordinary user message: a scheduled message must be indistinguishable from
//! one the user typed, both in the transcript and to the agent.

mod overrides;
mod spawn;

use std::time::Duration;

use uuid::Uuid;

use super::models::{Schedule, TargetKind};
use crate::app_state::AppState;
use crate::domain::ws_session::handler::session_prompt::dispatch_control_prompt_with_message_uuid;
use crate::error::AppError;

/// Deadlock backstop on one delivery, not a latency budget.
///
/// The scheduler fires schedules one at a time, so an await with no deadline is
/// a single point of stall for every other schedule: a dispatch waiting on a
/// wedged provider process or a half-open session handle would hold the tick
/// indefinitely and nothing else would ever run.
///
/// Deliberately generous, because this does *not* only bound a hand-off. The
/// prompt path provisions the working copy first — `git worktree add` against a
/// large repo, on a cold checkout — and then spawns the provider process, both
/// inside this future. A timeout drops that future mid-flight, so a value tuned
/// to a healthy hand-off would cancel a slow-but-fine first run and (for
/// `new_conversation`) send the caller down the rollback path, deleting a
/// conversation whose worktree may already be half-written to disk. Anything
/// that reaches this ceiling is wedged, not busy.
///
/// The tick is serial, so a backlog of wedged deliveries can still hold it for
/// `MAX_RUNS_PER_TICK` × this. That is the accepted trade: each of those runs
/// used to hang the loop forever.
const DISPATCH_TIMEOUT: Duration = Duration::from_secs(600);

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
    deliver_prompt(state, feature_id, session_id, schedule, occurrence).await?;
    Ok(feature_id)
}

/// Hand the prompt to the ordinary prompt path, under [`DISPATCH_TIMEOUT`].
///
/// A timeout is returned as an error like any other, so the caller's own
/// cleanup runs and the scheduler records a failed run and rolls the rule
/// forward instead of re-firing it on every tick.
pub(super) async fn deliver_prompt(
    state: &AppState,
    feature_id: i64,
    session_id: i64,
    schedule: &Schedule,
    occurrence: &str,
) -> Result<(), AppError> {
    let dispatch = dispatch_control_prompt_with_message_uuid(
        state,
        feature_id,
        session_id,
        &schedule.prompt,
        false,
        Some(message_uuid(schedule.id, occurrence)),
    );
    match tokio::time::timeout(DISPATCH_TIMEOUT, dispatch).await {
        Ok(result) => result,
        Err(_) => Err(AppError::Internal(format!(
            "delivering schedule {} timed out after {}s",
            schedule.id,
            DISPATCH_TIMEOUT.as_secs()
        ))),
    }
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
/// Both statements run in one write-pool transaction. Reading from `read_pool`
/// and writing to `write_pool` would let a manual run racing the dispatcher (or
/// two manual runs) both miss the row and insert a second session for the same
/// conversation, splitting its transcript in two.
///
/// sqlx begins deferred, so the SELECT takes only a read lock and the INSERT
/// upgrades it. That is safe *because* `write_pool` is `max_connections(1)`,
/// which serialises writers for us; if the write pool ever grows, this needs
/// `BEGIN IMMEDIATE` or the upgrade becomes `SQLITE_BUSY`-prone.
///
/// Unlike the live prompt path this never forces an existing session to
/// `paused`: dispatch drives status itself and must not disturb a session that
/// is mid-turn.
pub(super) async fn resolve_or_create_session(
    state: &AppState,
    feature_id: i64,
) -> Result<i64, AppError> {
    let mut tx = state.write_pool.begin().await?;
    if let Some((id,)) = sqlx::query_as::<_, (i64,)>(
        "SELECT id FROM agent_sessions WHERE feature_id = ? AND agent_type = 'session'
         ORDER BY id DESC LIMIT 1",
    )
    .bind(feature_id)
    .fetch_optional(&mut *tx)
    .await?
    {
        // Committed rather than dropped: the common path is a hit, and dropping
        // would queue a ROLLBACK on the one write connection every dispatch.
        tx.commit().await?;
        return Ok(id);
    }
    let id = sqlx::query_scalar::<_, i64>(
        "INSERT INTO agent_sessions (feature_id, agent_type, status) VALUES (?, 'session', 'paused')
         RETURNING id",
    )
    .bind(feature_id)
    .fetch_one(&mut *tx)
    .await?;
    tx.commit().await?;
    Ok(id)
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
