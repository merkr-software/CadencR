//! Stop active work and verify its processes before Electron confirms quit.

use std::collections::BTreeMap;
use std::time::Duration;

use crate::app_state::AppState;
use axum::extract::ws::Message;

use crate::domain::agents::process_sessions;
use crate::domain::session_status::{transcript_block_message, AgentStatus};
use crate::domain::sessions::models::AgentBlock;
use crate::domain::sessions::user_messages::resolve_pending_delivery_states;
use crate::domain::ws_session::handler::notify_gate_closed_on_quit;
use crate::domain::ws_session::protocol::{SessionEndedPayload, WsEnvelope, WsSessionEvent};
use crate::domain::ws_session::runtime::desktop_quit::close_runtime;
use crate::error::AppError;

use super::eligibility::SkipReason;
use super::store::{self, CaptureScope, Cause, Intent, Resolution};
use super::{active_work, capture::app_version, gates};

pub(super) async fn stop_active_work(state: &AppState) -> Result<(), AppError> {
    // Fail before recording a quit if a startup resume cannot hand over or
    // an admitted launch cannot settle. A timed-out request cannot later
    // start stopping agents after already telling Electron the quit failed.
    let (_quitting, (admission, sessions)) = tokio::time::timeout(Duration::from_secs(6), async {
        let quit = super::LIVE_CONTINUATIONS.lock().await;
        process_sessions::retry_failed_drains();
        let launches = state.session_runtimes.quiesce_launches().await;
        (quit, launches)
    })
    .await
    .map_err(|_| {
        AppError::Conflict(
            "An agent is still starting. Try quitting again when it is ready.".into(),
        )
    })?;
    let mut targets: BTreeMap<_, _> = sessions.into_iter().map(|id| (id, None)).collect();
    for work in active_work::list(state).await? {
        targets.insert(work.session_id, Some(work.feature_id));
    }

    // Make the quit's policy durable before touching any runtime. A crash
    // during the close sees these stopped continuations at the next start.
    let mut tx = state.write_pool.begin().await?;
    store::capture_with_intent(
        &mut tx,
        Cause::Shutdown,
        Intent::Stop.into(),
        Some(app_version()),
        CaptureScope::All,
    )
    .await?;
    tx.commit().await?;
    let drained = drain_work(state, targets).await;
    let stopped = drained.is_ok();
    let result = match drained {
        Ok(runtimes) => settle_work(state, runtimes).await,
        Err(error) => Err(error),
    };
    state
        .session_runtimes
        .finish_quit_admission(admission, stopped, result.is_ok());
    result
}

async fn drain_work(
    state: &AppState,
    mut targets: BTreeMap<i64, Option<i64>>,
) -> Result<Vec<(i64, i64)>, AppError> {
    for continuation in store::list_pending(&state.write_pool).await? {
        targets.insert(continuation.session_id, Some(continuation.feature_id));
    }

    // A protocol close (including a provider's rejected unsubscribe) does
    // not prove the launcher and its descendants ceased executing.
    let runtimes = futures::future::join_all(targets.into_iter().map(|(id, feature)| async move {
        let retired = close_runtime(state, id).await?;
        Ok::<_, AppError>(feature.or(retired).map(|feature| (id, feature)))
    }))
    .await
    .into_iter()
    .collect::<Result<Vec<_>, _>>()?;
    process_sessions::confirm_stopped()
        .await
        .map_err(|error| AppError::Conflict(format!("{error}. Try quitting again.")))?;

    Ok(runtimes.into_iter().flatten().collect())
}

async fn settle_work(state: &AppState, runtimes: Vec<(i64, i64)>) -> Result<(), AppError> {
    futures::future::join_all(
        runtimes
            .into_iter()
            .map(|(session_id, feature_id)| settle_session_work(state, session_id, feature_id)),
    )
    .await
    .into_iter()
    .collect()
}

async fn settle_session_work(
    state: &AppState,
    session_id: i64,
    feature_id: i64,
) -> Result<(), AppError> {
    // A handoff to a live runtime may have been in progress at the first capture.
    let mut tx = state.write_pool.begin().await?;
    store::capture_with_intent(
        &mut tx,
        Cause::Shutdown,
        Intent::Stop.into(),
        Some(app_version()),
        CaptureScope::Session(session_id),
    )
    .await?;
    tx.commit().await?;

    state.user_shell_runs.cancel(session_id).await;
    resolve_pending_delivery_states(&state.write_pool, session_id, "delivery_failed").await?;
    let continuation = store::pending_for_session(&state.write_pool, session_id).await?;
    let marker = match &continuation {
        Some(continuation) => store::write_marker(&state.write_pool, continuation).await?,
        None => None,
    };

    // A service crash after resolving a quit must not see a leftover row as
    // fresh work. The launch claim still excludes a successor's reader here.
    let mut tx = state.write_pool.begin().await?;
    sqlx::query("DELETE FROM agent_background_work WHERE session_id = ?")
        .bind(session_id)
        .execute(&mut *tx)
        .await?;
    sqlx::query("UPDATE agent_sessions SET status = 'paused', ended_at = ? WHERE id = ? AND status = 'running'")
        .bind(chrono::Utc::now().to_rfc3339())
        .bind(session_id)
        .execute(&mut *tx).await?;
    if let Some(continuation) = &continuation {
        store::resolve(
            &mut *tx,
            continuation.id,
            Resolution::Skipped,
            Some(SkipReason::StoppedOnQuit.code()),
        )
        .await?;
    }
    tx.commit().await?;
    let was_busy = state.session_status_tx.is_busy(session_id);
    if gates::clear_dead_gate(state, session_id, feature_id).await? {
        notify_gate_closed_on_quit(state, session_id, feature_id).await;
    }
    if let Some((id, marker)) = marker {
        let block =
            AgentBlock::system(format!("msg-{id}"), "turn_interrupted", marker.into(), None);
        state
            .ws_feature_senders
            .broadcast_all(feature_id, &transcript_block_message(session_id, block))
            .await;
    }
    state.active_turns.end_turn(session_id).await;
    state
        .session_status_tx
        .broadcast(session_id, feature_id, AgentStatus::Idle, None);
    if was_busy || continuation.is_some() {
        let ended = WsEnvelope::session_event(&WsSessionEvent::Ended(SessionEndedPayload {
            reason: "stream_closed".into(),
            received_prompt_message_uuids: Vec::new(),
        }))
        .expect("session ended payload should serialize");
        state
            .ws_feature_senders
            .broadcast_all(feature_id, &Message::Text(String::from(ended).into()))
            .await;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::restart_continuations::store::tests::session;
    use crate::domain::restart_continuations::{
        record_background_work, QUIT_BACKGROUND_MARKER_CONTENT, QUIT_MARKER_CONTENT,
    };
    use crate::domain::schedules::repository::test_support::fixture;

    #[tokio::test]
    async fn only_a_packaged_acknowledgement_keeps_new_launches_fenced_until_shutdown() {
        for packaged in [false, true] {
            let (pool, _, _) = fixture().await;
            let state = AppState::with_pool(pool);
            if packaged {
                state.session_runtimes.set_desktop_owned();
            }
            stop_active_work(&state).await.unwrap();
            stop_active_work(&state).await.unwrap();
            assert_eq!(
                state.session_runtimes.claim_spawn(91).await.is_none(),
                packaged
            );
        }
    }

    #[tokio::test]
    async fn live_quit_stops_both_kinds_without_leaving_a_global_quit_intent() {
        let (pool, _, feature_id) = fixture().await;
        let state = AppState::with_pool(pool.clone());
        let running = session(&pool, feature_id, "running").await;
        let background = session(&pool, feature_id, "completed").await;
        record_background_work(&pool, background, Some(chrono::Utc::now()))
            .await
            .unwrap();
        state
            .session_status_tx
            .broadcast_running(running, feature_id);

        for _ in 0..2 {
            stop_active_work(&state).await.unwrap();
        }

        assert_eq!(
            store::session_status(&pool, running).await.unwrap(),
            "paused"
        );
        assert!(!state.session_status_tx.is_busy(running));
        let transcript: Vec<(i64, String, String)> = sqlx::query_as(
            "SELECT session_id, message_type, content FROM agent_messages ORDER BY id",
        )
        .fetch_all(&pool)
        .await
        .unwrap();
        let mut transcript = transcript;
        transcript.sort_unstable();
        assert_eq!(
            transcript,
            [
                (
                    running,
                    "turn_interrupted".into(),
                    QUIT_MARKER_CONTENT.into()
                ),
                (
                    background,
                    "turn_interrupted".into(),
                    QUIT_BACKGROUND_MARKER_CONTENT.into()
                ),
            ]
        );
        let remaining: (i64, i64, i64) = sqlx::query_as(
            "SELECT (SELECT COUNT(*) FROM agent_background_work),
                    (SELECT COUNT(*) FROM restart_quit_intent),
                    (SELECT COUNT(*) FROM restart_continuations WHERE state = 'pending')",
        )
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(remaining, (0, 0, 0));

        let later = session(&pool, feature_id, "running").await;
        store::capture_running(&pool, Cause::Crash, Intent::Resume, None)
            .await
            .unwrap();
        let pending = store::list_pending(&pool).await.unwrap();
        assert_eq!(pending.len(), 1);
        assert_eq!(pending[0].session_id, later);
        assert!(!pending[0].stop_requested());
    }
}
