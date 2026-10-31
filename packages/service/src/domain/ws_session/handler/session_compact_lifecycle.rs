use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use super::{SdkSessions, WsSender};
use crate::app_state::AppState;
use crate::domain::session_status::AgentStatus;
use crate::domain::ws_session::persistence::WsSessionPersistence;

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
    let reservation = CompactReservation {
        pending: handle.manual_compact_spawn_pending.clone(),
        armed: true,
    };
    let was_running = app_state.is_some_and(|state| state.session_status_tx.is_busy(session_id));
    if let Some(state) = app_state {
        super::session_prompt::mark_agent_running(
            &state.write_pool,
            &state.session_status_tx,
            &state.active_turns,
            sdk_sessions,
            session_id,
            handle.feature_id,
        )
        .await;
    }
    Ok((was_running, reservation))
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
            WsSessionPersistence::mark_paused_static(&state.write_pool, session_id).await;
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
