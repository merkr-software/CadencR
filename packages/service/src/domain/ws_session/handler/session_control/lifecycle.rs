use axum::extract::ws::Message;

use super::super::super::persistence::WsSessionPersistence;
use super::super::super::protocol::*;
use super::super::helpers::{parse_session_id, send_error, send_state_not_saved};
use super::super::types::{QueryState, SdkSessions, WsSender};
use crate::app_state::AppState;
use crate::domain::agents::adapter::RuntimeSpawnConfig;
use crate::domain::ws_session::runtime::detached_runtime::{resume_session_id, DetachedRuntime};
use crate::domain::ws_session::runtime::output::CommandError;

/// Handle session.interrupt
pub(crate) async fn handle_interrupt(
    envelope: WsEnvelope,
    sender: &WsSender,
    sdk_sessions: &SdkSessions,
    app_state: &AppState,
) {
    let payload: SessionActionPayload = match serde_json::from_value(envelope.payload.clone()) {
        Ok(p) => p,
        Err(e) => {
            send_error(sender, &envelope.id, "INVALID_PAYLOAD", &e.to_string());
            return;
        }
    };

    let db_session_id = match parse_session_id(&payload.session_id) {
        Some(id) => id,
        None => {
            send_error(
                sender,
                &envelope.id,
                "INVALID_SESSION_ID",
                "Invalid session_id",
            );
            return;
        }
    };

    if let Err(error) = stop_once_started(app_state, sdk_sessions, db_session_id).await {
        send_error(sender, &envelope.id, error.code, &error.message);
    }
}

/// Stop the session's work. A Stop that lands while its runtime is still
/// launching (a socket's controls no longer wait behind its own prompt) stops
/// the turn that launch starts, rather than asking the user to stop again.
async fn stop_once_started(
    app_state: &AppState,
    sdk_sessions: &SdkSessions,
    db_session_id: i64,
) -> Result<(), CommandError> {
    match super::stop_session(app_state, Some(sdk_sessions), db_session_id).await {
        Err(error) if error.code == super::AGENT_STARTING => {
            app_state
                .session_runtimes
                .spawn_settled(db_session_id)
                .await;
            super::stop_session(app_state, Some(sdk_sessions), db_session_id).await
        }
        stopped => stopped,
    }
}

/// Handle session.destroy: mark session as completed and close subprocess.
pub(crate) async fn handle_destroy(
    envelope: WsEnvelope,
    sender: &WsSender,
    sdk_sessions: &SdkSessions,
    app_state: &AppState,
) {
    let payload: SessionActionPayload = match serde_json::from_value(envelope.payload.clone()) {
        Ok(p) => p,
        Err(e) => {
            send_error(sender, &envelope.id, "INVALID_PAYLOAD", &e.to_string());
            return;
        }
    };

    let db_session_id = match parse_session_id(&payload.session_id) {
        Some(id) => id,
        None => {
            send_error(
                sender,
                &envelope.id,
                "INVALID_SESSION_ID",
                "Invalid session_id",
            );
            return;
        }
    };

    let mut sessions = sdk_sessions.lock().await;
    let handle = match sessions.remove(&db_session_id) {
        Some(h) => h,
        None => {
            send_error(
                sender,
                &envelope.id,
                "SESSION_NOT_FOUND",
                "Session not found",
            );
            return;
        }
    };

    // Out of the map, the runtime reads as superseded to its stream reader, so
    // the close below is benign and needs no session lock (see
    // `detached_runtime`).
    let retired = handle.state.active_query().map(|query| {
        DetachedRuntime::of(&handle, query, db_session_id, &app_state.session_runtimes)
    });
    drop(sessions);
    let feature_id = handle.feature_id;

    // Mark completed BEFORE closing the subprocess too: a reader that looked
    // the runtime up just before the removal reads the status instead.
    if let Err(error) =
        WsSessionPersistence::mark_completed_static(&app_state.write_pool, db_session_id).await
    {
        send_state_not_saved(sender, &envelope.id, "that the agent stopped", &error);
    }

    // Close active subprocess if running
    if let Some(retired) = retired {
        retired.close_in(app_state).await;
    }
    app_state.session_status_tx.broadcast(
        db_session_id,
        feature_id,
        crate::domain::session_status::AgentStatus::Idle,
        None,
    );

    let reply = WsEnvelope::session_reply(
        &envelope.id,
        &WsSessionEvent::Ended(SessionEndedPayload {
            reason: "destroyed".into(),
            ..Default::default()
        }),
    )
    .expect("session event payload should serialize");
    let _ = sender.send(Message::Text(String::from(reply).into()));
}

/// Handle session.delete: hard-delete a session and its messages from the DB.
pub(crate) async fn handle_delete(
    envelope: WsEnvelope,
    sender: &WsSender,
    sdk_sessions: &SdkSessions,
    app_state: &AppState,
) {
    let payload: SessionActionPayload = match serde_json::from_value(envelope.payload.clone()) {
        Ok(p) => p,
        Err(e) => {
            send_error(sender, &envelope.id, "INVALID_PAYLOAD", &e.to_string());
            return;
        }
    };

    let db_session_id = match parse_session_id(&payload.session_id) {
        Some(id) => id,
        None => {
            send_error(
                sender,
                &envelope.id,
                "INVALID_SESSION_ID",
                "Invalid session_id",
            );
            return;
        }
    };

    match WsSessionPersistence::delete_session_static(&app_state.write_pool, db_session_id).await {
        Ok((feature_id, agent_type)) => {
            // The DB delete is the source of truth. Only drop the in-memory
            // handle after it succeeds; failed deletes (for example a running
            // session) must leave the live handle intact.
            sdk_sessions.lock().await.remove(&db_session_id);
            app_state
                .persistence_health
                .forget_session(db_session_id)
                .await;

            app_state.session_status_tx.broadcast(
                db_session_id,
                feature_id,
                crate::domain::session_status::AgentStatus::Idle,
                None,
            );

            let _ = agent_type; // agent_type kept for log/symmetry — no further branching.

            let reply = WsEnvelope::session_reply(
                &envelope.id,
                &WsSessionEvent::Deleted(SessionDeletedPayload {
                    session_id: db_session_id.to_string(),
                }),
            )
            .expect("session event payload should serialize");
            let _ = sender.send(Message::Text(String::from(reply).into()));
        }
        Err(reason) => {
            send_error(sender, &envelope.id, "DELETE_FAILED", &reason);
        }
    }
}

/// Handle session.clear: archive conversation and reset to fresh state.
pub(crate) async fn handle_clear(
    envelope: WsEnvelope,
    sender: &WsSender,
    sdk_sessions: &SdkSessions,
    app_state: &AppState,
) {
    let payload: SessionActionPayload = match serde_json::from_value(envelope.payload.clone()) {
        Ok(p) => p,
        Err(e) => {
            send_error(sender, &envelope.id, "INVALID_PAYLOAD", &e.to_string());
            return;
        }
    };

    let db_session_id = match parse_session_id(&payload.session_id) {
        Some(id) => id,
        None => {
            send_error(
                sender,
                &envelope.id,
                "INVALID_SESSION_ID",
                "Invalid session_id",
            );
            return;
        }
    };

    let mut sessions = sdk_sessions.lock().await;
    let handle = match sessions.get_mut(&db_session_id) {
        Some(h) => h,
        None => {
            send_error(
                sender,
                &envelope.id,
                "SESSION_NOT_FOUND",
                "Session not found",
            );
            return;
        }
    };

    // Spawns wait until the archive is written (see `detached_closes`), so a
    // prompt sent meanwhile from another device never lands before the clear
    // divider or has its own resume id archived — with or without a live
    // runtime to close.
    let archive_lease = app_state
        .session_runtimes
        .begin_detached_close(db_session_id);

    // Capture runtime_session_id for the archive. A live runtime is closed once
    // the session lock is released (see `detached_runtime`); if the stream
    // already finished (Pending with resume), extract it from those options.
    let (cli_sid, retired) = match &handle.state {
        QueryState::Active { query, .. } => {
            // Flip status off `running` BEFORE closing: closing ends the stream,
            // and the per-turn reader treats a clean close while the DB still
            // shows `running` as an unexpected mid-turn death (raising
            // `AGENT_STOPPED`). An intentional clear must read as a benign close.
            // (`archive_and_clear` below only nulls the runtime id, not status.)
            if let Err(error) =
                WsSessionPersistence::mark_completed_static(&app_state.write_pool, db_session_id)
                    .await
            {
                send_state_not_saved(sender, &envelope.id, "that the agent stopped", &error);
            }
            let query = query.clone();
            let cli_sid = resume_session_id(&query, &handle.runtime_provider).await;
            (
                cli_sid,
                Some(DetachedRuntime::of(
                    handle,
                    query,
                    db_session_id,
                    &app_state.session_runtimes,
                )),
            )
        }
        QueryState::Pending(opts) => (opts.resume_session_id.clone(), None),
    };

    // Also clear the init-time resume_session_id in case it wasn't consumed yet
    let cli_sid = cli_sid.or_else(|| handle.resume_session_id.take());

    // Reset handle to Pending with fresh options (no resume)
    let fresh_options = RuntimeSpawnConfig {
        cwd: handle.config.cwd.clone(),
        permission_mode: handle.desired_permission_mode.clone(),
        access_mode: handle.desired_access_mode.clone(),
        model: handle.desired_model.clone(),
        thinking_effort: handle.desired_thinking_effort.clone(),
        system_prompt: handle.config.system_prompt.clone(),
        env: handle.config.env.clone(),
        env_unset: handle.config.env_unset.clone(),
        profile: handle.config.claude_profile.clone(),
        overrides: handle.config.overrides.clone(),
        profile_revision: handle.config.profile_revision.clone(),
        profile_state_identity: handle.config.profile_state_identity.clone(),
        ..RuntimeSpawnConfig::default()
    };
    handle.state = QueryState::Pending(fresh_options);
    drop(sessions);

    // The close persists the runtime id; the archive then moves it aside.
    if let Some(retired) = retired {
        retired.close_in(app_state).await;
    }
    // Archive and clear in DB (pass cli_sid to avoid re-reading it)
    let archived = WsSessionPersistence::archive_and_clear(
        &app_state.write_pool,
        db_session_id,
        cli_sid.as_deref(),
    )
    .await;
    drop(archive_lease);
    if let Err(error) = archived {
        // Nothing was written, so the conversation still resumes from where
        // it was: the clear did not happen, and the client must not show one.
        tracing::error!(db_session_id, %error, "failed to archive the cleared conversation");
        send_error(
            sender,
            &envelope.id,
            "CLEAR_NOT_SAVED",
            &format!("The conversation was not cleared: {error}"),
        );
        return;
    }

    let reply = WsEnvelope::session_reply(
        &envelope.id,
        &WsSessionEvent::Cleared(SessionClearedPayload {
            session_id: db_session_id.to_string(),
            previous_session_id: cli_sid,
        }),
    )
    .expect("session event payload should serialize");
    let _ = sender.send(Message::Text(String::from(reply).into()));
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::ws_session::handler::tests::support::{
        make_active_handle, make_test_app_state,
    };
    use crate::domain::ws_session::handler::types::new_sdk_sessions;

    /// A Stop sent on the socket whose prompt is still launching the runtime
    /// stops the turn once the launch registered it.
    #[tokio::test]
    async fn a_stop_during_a_launch_stops_the_turn_it_starts() {
        let app_state = make_test_app_state().await;
        let sessions = new_sdk_sessions();
        let mut pending = make_active_handle(1, None);
        pending.state = QueryState::Pending(RuntimeSpawnConfig::default());
        sessions.lock().await.insert(51, pending);
        app_state.session_status_tx.broadcast_running(51, 1);
        let launch = app_state.session_runtimes.claim_spawn(51).await;

        let stop = tokio::spawn({
            let app_state = app_state.clone();
            let sessions = sessions.clone();
            async move { stop_once_started(&app_state, &sessions, 51).await }
        });
        tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        assert!(!stop.is_finished(), "the Stop waits for the launch");

        sessions
            .lock()
            .await
            .insert(51, make_active_handle(1, Some("cli".into())));
        drop(launch);

        // The stub runtime has no CLI behind it: its refusal proves the Stop
        // reached the launched runtime instead of reporting `AGENT_STARTING`.
        let error = stop.await.unwrap().unwrap_err();
        assert_eq!(error.code, "SDK_ERROR");
    }

    /// The launch failed and the session went idle: the Stop got what it asked.
    #[tokio::test]
    async fn a_stop_during_a_failed_launch_finds_nothing_to_stop() {
        let app_state = make_test_app_state().await;
        let sessions = new_sdk_sessions();
        let mut pending = make_active_handle(1, None);
        pending.state = QueryState::Pending(RuntimeSpawnConfig::default());
        sessions.lock().await.insert(52, pending);
        app_state.session_status_tx.broadcast_running(52, 1);
        let launch = app_state.session_runtimes.claim_spawn(52).await;

        let stop = tokio::spawn({
            let app_state = app_state.clone();
            let sessions = sessions.clone();
            async move { stop_once_started(&app_state, &sessions, 52).await }
        });
        tokio::task::yield_now().await;
        app_state.session_status_tx.broadcast(
            52,
            1,
            crate::domain::session_status::AgentStatus::Idle,
            None,
        );
        drop(launch);

        let error = stop.await.unwrap().unwrap_err();
        assert_eq!(error.code, super::super::NOTHING_TO_STOP);
    }
}
