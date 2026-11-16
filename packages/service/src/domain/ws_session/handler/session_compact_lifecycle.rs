use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use axum::extract::ws::Message;

use super::super::protocol::{SessionCompactStoppedPayload, WsEnvelope, WsSessionEvent};
use super::{SdkSessions, WsSender};
use crate::app_state::AppState;
use crate::domain::session_status::AgentStatus;
use crate::domain::ws_session::persistence::WsSessionPersistence;
use crate::domain::ws_session::runtime::helpers::report_if_unsaved;

pub(super) struct CompactReservation {
    pending: Arc<AtomicBool>,
    armed: bool,
}

impl Drop for CompactReservation {
    fn drop(&mut self) {
        if self.armed {
            self.pending.store(false, Ordering::SeqCst);
        }
    }
}

/// Reserve the owner and running status before any asynchronous runtime spawn.
/// The pending flag also blocks steering until the compaction RPC is accepted.
pub(super) async fn begin_compact(
    sdk_sessions: &SdkSessions,
    session_id: i64,
    app_state: Option<&AppState>,
) -> Result<(bool, CompactReservation), String> {
    let sessions = sdk_sessions.lock().await;
    let handle = sessions.get(&session_id).ok_or("Session not found")?;
    if handle
        .manual_compact_spawn_pending
        .swap(true, Ordering::SeqCst)
    {
        return Err("Manual compaction is already starting for this session".into());
    }
    // A Stop from an earlier start must not cancel this one.
    handle.manual_compact_start.begin();
    let reservation = CompactReservation {
        pending: handle.manual_compact_spawn_pending.clone(),
        armed: true,
    };
    let was_running = app_state.is_some_and(|state| state.session_status_tx.is_busy(session_id));
    if let Some(state) = app_state {
        super::session_prompt::mark_agent_running(
            &state.write_pool,
            &state.session_status_tx,
            &state.ws_feature_senders,
            &state.active_turns,
            sdk_sessions,
            session_id,
            handle.feature_id,
        )
        .await;
    }
    Ok((was_running, reservation))
}

/// Right before the runtime is asked to compact: the feature of a session a
/// Stop cancelled first (while its runtime spawned, or once it was up; see
/// `stop_session`), whose compaction then gives up before it starts. `None`
/// lets it start, and a later Stop interrupts the runtime instead.
pub(super) async fn stopped_before_dispatch(
    sdk_sessions: &SdkSessions,
    session_id: i64,
) -> Option<i64> {
    let sessions = sdk_sessions.lock().await;
    let handle = sessions.get(&session_id)?;
    (!handle.manual_compact_start.dispatch()).then_some(handle.feature_id)
}

/// A Stop cancelled the compaction before it began. That is the outcome the
/// user asked for, so it is reported as one (`compact.stopped` and a
/// transcript marker), never as a rejected compaction.
pub(super) async fn report_compact_stopped(
    app_state: &AppState,
    sender: &WsSender,
    envelope_id: &str,
    session_id: i64,
    feature_id: i64,
) {
    let written =
        WsSessionPersistence::persist_compaction_stopped_static(&app_state.write_pool, session_id)
            .await;
    report_if_unsaved(
        &app_state.ws_feature_senders,
        feature_id,
        session_id,
        "that the compaction was stopped",
        written,
    )
    .await;
    let reply = WsEnvelope::session_reply(
        envelope_id,
        &WsSessionEvent::CompactStopped(SessionCompactStoppedPayload {}),
    )
    .expect("compact stopped payload should serialize");
    if sender
        .send(Message::Text(String::from(reply).into()))
        .is_err()
    {
        tracing::warn!(session_id, "compact.stopped reply delivery failed");
    }
}

pub(super) async fn finish_compact_start(
    sdk_sessions: &SdkSessions,
    session_id: i64,
    app_state: Option<&AppState>,
    succeeded: bool,
    was_running: bool,
    mut reservation: CompactReservation,
) {
    let feature_id = {
        let sessions = sdk_sessions.lock().await;
        let Some(handle) = sessions.get(&session_id) else {
            return;
        };
        if !Arc::ptr_eq(&handle.manual_compact_spawn_pending, &reservation.pending) {
            return;
        }
        handle
            .manual_compact_spawn_pending
            .store(false, Ordering::SeqCst);
        reservation.armed = false;
        handle.feature_id
    };
    if let Some(state) = app_state {
        if !succeeded && !was_running {
            let paused =
                WsSessionPersistence::mark_paused_static(&state.write_pool, session_id).await;
            let senders = &state.ws_feature_senders;
            report_if_unsaved(
                senders,
                feature_id,
                session_id,
                "that the agent paused",
                paused,
            )
            .await;
            state
                .session_status_tx
                .broadcast(session_id, feature_id, AgentStatus::Idle, None);
        }
        // Failure has no turn/completed event. Success can finish its turn
        // before the RPC replies, while the reservation still blocks delivery.
        if let Err(error) =
            crate::domain::prompt_queue::delivery::drain_next_if_idle(state, session_id).await
        {
            tracing::warn!(session_id, %error, "queued prompt delivery after compaction startup");
        }
    }
}

pub(super) async fn persist_compact_command(
    app_state: &AppState,
    sender: &WsSender,
    session_id: i64,
    message_uuid: Option<&str>,
) -> Result<bool, String> {
    let feature_id: i64 = sqlx::query_scalar("SELECT feature_id FROM agent_sessions WHERE id = ?")
        .bind(session_id)
        .fetch_one(&app_state.read_pool)
        .await
        .map_err(|error| error.to_string())?;
    let message_uuid =
        crate::domain::sessions::user_messages::canonical_user_message_uuid(message_uuid)
            .map_err(|_| "message_uuid must be a valid UUID".to_string())?;
    let outcome = super::session_prompt::persist_and_publish_user_message(
        super::session_prompt::CanonicalUserMessageRequest {
            pool: &app_state.write_pool,
            feature_senders: &app_state.ws_feature_senders,
            owner: Some(sender),
            feature_id,
            session_id,
            content: "/compact",
            message_uuid,
            origin: None,
            mode: super::session_prompt::CanonicalUserMessageMode::PersistOnly,
        },
    )
    .await
    .map_err(|error| error.to_string())?;
    if let Err(error) = outcome.delivery {
        tracing::warn!(feature_id, session_id, error = %error, "compact command owner disconnected");
    }
    let message = outcome.message;
    if message.inserted {
        app_state.feature_events_tx.emit(
            feature_id,
            None,
            crate::domain::feature_events::FeatureEventAction::Reordered,
        );
    }
    Ok(message.inserted)
}

#[cfg(test)]
mod tests {
    use serde_json::Value;

    use super::*;
    use crate::domain::ws_session::handler::tests::support::{
        insert_running_session, make_test_app_state,
    };
    use crate::domain::ws_session::persistence::COMPACTION_STOPPED_MARKER;

    /// Found in QA: a Stop while the compaction's runtime spawned showed a
    /// `COMPACT_REJECTED` error. It is the stop the user asked for: a
    /// `compact.stopped` reply and a persisted marker, no error.
    #[tokio::test]
    async fn a_compaction_stopped_before_it_began_is_reported_as_stopped() {
        let app_state = make_test_app_state().await;
        insert_running_session(&app_state, 61, 1).await;
        let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();

        report_compact_stopped(&app_state, &tx, "compact-req", 61, 1).await;

        let Ok(Message::Text(text)) = rx.try_recv() else {
            panic!("the stop must be answered");
        };
        let reply: Value = serde_json::from_str(&text).unwrap();
        assert_eq!(reply["action"], "compact.stopped");
        assert_eq!(reply["ref"], "compact-req");
        assert!(rx.try_recv().is_err(), "no error may follow the reply");
        let marker: (String, String) =
            sqlx::query_as("SELECT message_type, content FROM agent_messages WHERE session_id = ?")
                .bind(61)
                .fetch_one(&app_state.write_pool)
                .await
                .unwrap();
        assert_eq!(
            marker,
            (
                "turn_interrupted".to_string(),
                COMPACTION_STOPPED_MARKER.to_string()
            )
        );
    }
}
