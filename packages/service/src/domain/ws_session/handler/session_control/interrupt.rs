use std::sync::atomic::Ordering;

use super::super::types::{QueryState, SdkSessions};
use crate::app_state::AppState;
use crate::domain::agents::adapter::{AgentRuntimeSession, RuntimeError, RuntimeSessionHandle};
use crate::domain::ws_session::runtime::output::CommandError;

/// Nothing is running: the turn already ended. The user asked for a stop, so
/// clients treat it as done.
pub(crate) const NOTHING_TO_STOP: &str = "NOTHING_TO_STOP";
/// A turn is starting but has no runtime to stop yet. Not done: the agent
/// starts anyway, so the user must stop it again once it runs. (A socket's
/// Stop waits for the launch instead: see `lifecycle::stop_once_started`.)
pub(crate) const AGENT_STARTING: &str = "AGENT_STARTING";

/// Stop `db_session_id`'s running work: its user shell command, the starting
/// manual compaction, or the live runtime's turn. Shared by the socket's
/// `session.interrupt` and the HTTP stop used for conversations no client has
/// open. `Ok` means the runtime took the stop; the status change itself reaches
/// every client through the status book once it reports the stopped turn.
pub(crate) async fn stop_session(
    app_state: &AppState,
    own: Option<&SdkSessions>,
    db_session_id: i64,
) -> Result<(), CommandError> {
    if app_state.user_shell_runs.cancel(db_session_id).await {
        return Ok(());
    }
    // The live turn may be owned by another connection (e.g. the host stopping a
    // conversation started on a remote device), or by none (a schedule, MCP).
    let Some(sessions) = owner_sessions(app_state, own, db_session_id).await else {
        return Err(nothing_to_stop());
    };
    // Nothing working (a live runtime between turns included): interrupting
    // anyway would leave a stop marker that the next turn's result consumes.
    if !app_state.session_status_tx.is_busy(db_session_id) {
        return Err(nothing_to_stop());
    }
    let query = {
        let sessions = sessions.lock().await;
        let Some(handle) = sessions.get(&db_session_id) else {
            return Err(CommandError::new("SESSION_NOT_FOUND", "Session not found"));
        };
        match &handle.state {
            QueryState::Active { query, .. } => Some(std::sync::Arc::clone(query)),
            QueryState::Pending(_)
                if handle.manual_compact_spawn_pending.load(Ordering::SeqCst) =>
            {
                // Its runtime is still spawning: the compaction gives up before
                // it starts and reports the session idle.
                handle.manual_compact_cancel.store(true, Ordering::SeqCst);
                return Ok(());
            }
            QueryState::Pending(_) => None,
        }
    };
    let Some(query) = query else {
        if app_state.session_runtimes.is_spawning(db_session_id).await {
            return Err(CommandError::new(
                AGENT_STARTING,
                "The agent is still starting. Stop it again once it runs.",
            ));
        }
        return Err(nothing_to_stop());
    };

    // Stop is an intentional user control, not a responder failure. Mark it
    // before interrupting so the concurrently running stream reader can
    // classify Claude's error-result / EOF (and equivalent provider terminal
    // events) as benign. The reply wait deliberately remains armed: a later
    // instruction may resume this same child and should be the result
    // eventually reported to its parent.
    let q = query.read().await;
    let _barrier = q.turn_control_guard().await;
    interrupt_as_intended(
        app_state,
        &query,
        &**q,
        db_session_id,
        true,
        StopReason::User,
    )
    .await
    .map_err(|error| {
        tracing::error!(db_session_id, %error, "interrupt failed");
        CommandError::new("SDK_ERROR", error)
    })
}

/// Why a control stops the running turn.
pub(in super::super) enum StopReason {
    /// The user's Stop: the runtime's full stop wait.
    User,
    /// The machine is about to sleep: the runtime's bounded stop.
    Sleep,
}

/// Stop `runtime`'s turn as an intended control. When `mark`, the turn is
/// marked first, so the stream reader ends it as stopped (or
/// `AGENT_STOP_ESCALATED`) rather than as the provider's error or a closed
/// stream; a failed stop then clears that mark unless the reader consumed it.
/// Call it holding `runtime` (read from `query`) and its turn-control barrier,
/// so no prompt is delivered between the mark and the stop.
pub(in super::super) async fn interrupt_as_intended(
    app_state: &AppState,
    query: &RuntimeSessionHandle,
    runtime: &dyn AgentRuntimeSession,
    db_session_id: i64,
    mark: bool,
    reason: StopReason,
) -> Result<(), RuntimeError> {
    let interrupted_generation = if mark {
        app_state
            .active_turns
            .request_interruption(db_session_id, query)
            .await
    } else {
        None
    };
    let result = match reason {
        StopReason::User => runtime.interrupt().await,
        StopReason::Sleep => runtime.interrupt_before_sleep().await,
    };
    finish_interruption(
        result,
        query,
        app_state,
        db_session_id,
        interrupted_generation,
    )
    .await
}

fn nothing_to_stop() -> CommandError {
    CommandError::new(NOTHING_TO_STOP, "Session not active")
}

/// The cell holding `db_session_id`'s runtime: the caller's own map when it
/// holds the live turn, else the service registry's (no client needs to hold
/// the conversation for it to be found).
pub(crate) async fn owner_sessions(
    app_state: &AppState,
    own: Option<&SdkSessions>,
    db_session_id: i64,
) -> Option<SdkSessions> {
    match own {
        Some(own) => {
            Some(super::resolve_owner_sessions(own, &app_state.active_turns, db_session_id).await)
        }
        None => match app_state.session_runtimes.get(db_session_id).await {
            Some(sessions) => Some(sessions),
            None => app_state.active_turns.owner_sessions(db_session_id).await,
        },
    }
}

/// Complete a user-requested stop whose generation was marked before any
/// provider action (including a gate denial that may itself end the turn).
pub(in super::super) async fn finish_interruption(
    result: Result<(), RuntimeError>,
    query: &RuntimeSessionHandle,
    app_state: &AppState,
    session_id: i64,
    generation: Option<u64>,
) -> Result<(), RuntimeError> {
    if let Err(error) = result {
        if let Some(generation) = generation {
            if !app_state
                .active_turns
                .clear_interruption(session_id, generation, query)
                .await
            {
                // Some providers close the control channel while stopping. The
                // reader consumed the marker, so the requested stop succeeded.
                tracing::info!(session_id, %error, "interrupt control ended after the runtime had already stopped");
                return Ok(());
            }
        }
        return Err(error);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::Ordering;

    use super::*;
    use crate::domain::agents::adapter::RuntimeSpawnConfig;
    use crate::domain::ws_session::handler::tests::support::{
        make_active_handle, make_test_app_state,
    };
    use crate::domain::ws_session::handler::types::new_sdk_sessions;

    /// The status book says the session is working, as `mark_agent_running`
    /// does before any turn or compaction starts.
    fn working(app_state: &AppState, session_id: i64) {
        app_state.session_status_tx.broadcast_running(session_id, 1);
    }

    async fn pending_session(session_id: i64) -> SdkSessions {
        let sessions = new_sdk_sessions();
        let mut handle = make_active_handle(1, None);
        handle.state = QueryState::Pending(RuntimeSpawnConfig::default());
        sessions.lock().await.insert(session_id, handle);
        sessions
    }

    #[tokio::test]
    async fn a_stop_during_a_compaction_spawn_cancels_the_compaction() {
        let app_state = make_test_app_state().await;
        let sessions = pending_session(41).await;
        working(&app_state, 41);
        sessions.lock().await[&41]
            .manual_compact_spawn_pending
            .store(true, Ordering::SeqCst);

        stop_session(&app_state, Some(&sessions), 41).await.unwrap();

        assert!(sessions.lock().await[&41]
            .manual_compact_cancel
            .load(Ordering::SeqCst));
    }

    #[tokio::test]
    async fn a_stop_with_nothing_running_reports_nothing_to_stop() {
        let app_state = make_test_app_state().await;
        let sessions = pending_session(42).await;

        let error = stop_session(&app_state, Some(&sessions), 42)
            .await
            .unwrap_err();

        assert_eq!(error.code, NOTHING_TO_STOP);
    }

    #[tokio::test]
    async fn a_stop_while_the_agent_spawns_is_not_reported_as_done() {
        let app_state = make_test_app_state().await;
        let sessions = pending_session(43).await;
        working(&app_state, 43);
        let _spawning = app_state.session_runtimes.claim_spawn(43).await;

        let error = stop_session(&app_state, Some(&sessions), 43)
            .await
            .unwrap_err();

        assert_eq!(error.code, AGENT_STARTING);
    }

    #[tokio::test]
    async fn a_stop_by_id_without_any_runtime_reports_nothing_to_stop() {
        let app_state = make_test_app_state().await;

        let error = stop_session(&app_state, None, 44).await.unwrap_err();

        assert_eq!(error.code, NOTHING_TO_STOP);
    }

    #[tokio::test]
    async fn a_stop_by_id_reaches_the_registry_runtime() {
        let app_state = make_test_app_state().await;
        let sessions = new_sdk_sessions();
        sessions
            .lock()
            .await
            .insert(45, make_active_handle(1, Some("cli".into())));
        app_state.session_runtimes.bind(45, &sessions).await;
        working(&app_state, 45);

        // The stub runtime has no CLI behind it: its refusal proves the stop
        // reached the runtime instead of reporting nothing to stop.
        let error = stop_session(&app_state, None, 45).await.unwrap_err();
        assert_eq!(error.code, "SDK_ERROR");
        assert_eq!(error.message, "stdin is closed");
    }

    /// Found live: a runtime kept between turns is not interrupted, so no stop
    /// marker is left for its next turn to consume.
    #[tokio::test]
    async fn a_stop_between_turns_leaves_the_runtime_alone() {
        let app_state = make_test_app_state().await;
        let sessions = new_sdk_sessions();
        sessions
            .lock()
            .await
            .insert(46, make_active_handle(1, Some("cli".into())));
        app_state.session_runtimes.bind(46, &sessions).await;

        let error = stop_session(&app_state, None, 46).await.unwrap_err();

        assert_eq!(error.code, NOTHING_TO_STOP);
    }
}
