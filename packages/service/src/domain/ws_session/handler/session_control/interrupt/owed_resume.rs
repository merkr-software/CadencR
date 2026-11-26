//! A user's Stop ends any resume the conversation was owed.

use crate::app_state::AppState;
use crate::domain::restart_continuations::{record_user_stop, UserStop};
use crate::domain::ws_session::runtime::helpers::report_if_unsaved;
use crate::domain::ws_session::runtime::output::CommandError;

/// Persist Stop before changing the hold, withdrawing a prompt, or touching
/// the runtime. A refusal to save leaves the running work alone.
pub(super) async fn record(
    app_state: &AppState,
    db_session_id: i64,
) -> Result<Option<UserStop>, CommandError> {
    record_user_stop(&app_state.write_pool, db_session_id, chrono::Utc::now())
        .await
        .map_err(|error| {
            tracing::error!(db_session_id, %error, "failed to record a user stop");
            CommandError::new(
                "STOP_NOT_RECORDED",
                format!("Cadencr could not save the request to stop the agent: {error}"),
            )
        })
}

/// The runtime refused Stop. Remove only this request's record. The reader
/// still owns its hold, and its background work was never deleted.
pub(super) async fn restore(
    app_state: &AppState,
    stop: UserStop,
    db_session_id: i64,
    feature_id: i64,
) {
    report_if_unsaved(
        &app_state.ws_feature_senders,
        feature_id,
        db_session_id,
        "that the agent is still working",
        stop.undo(&app_state.write_pool).await,
    )
    .await;
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use crate::domain::agents::adapter::{RuntimeEvent, RuntimeEventKind, RuntimeEventMetadata};
    use crate::domain::restart_continuations::write_background_work;
    use crate::domain::ws_session::handler::tests::support::{
        insert_running_session, make_active_handle, make_test_app_state,
    };
    use crate::domain::ws_session::runtime::prompt::runtime_hold_registry::{
        register, SharedRuntimeHold,
    };
    use crate::domain::ws_session::runtime::state::new_sdk_sessions;

    #[tokio::test]
    async fn a_refused_stop_leaves_the_original_background_work_owned_and_recoverable() {
        let state = make_test_app_state().await;
        let id = 9301;
        insert_running_session(&state, id, 1).await;
        let sessions = new_sdk_sessions();
        let handle = make_active_handle(1, None);
        let runtime = handle.state.active_query().unwrap();
        sessions.lock().await.insert(id, handle);
        state.session_runtimes.bind(id, &sessions).await;
        state.active_turns.begin_turn(id, &sessions).await;
        state.session_status_tx.broadcast_running(id, 1);
        let hold = SharedRuntimeHold::default();
        hold.observe(
            &RuntimeEvent::new(RuntimeEventMetadata::default(), RuntimeEventKind::Other)
                .with_background_task_count(Some(1)),
            false,
        );
        let _registration = register(id, &Arc::downgrade(&runtime), &hold);
        write_background_work(
            &state.write_pool,
            id,
            "original-reader",
            Some(chrono::Utc::now()),
        )
        .await
        .unwrap();

        // The stub provider cannot accept a control request: its stdin is
        // already closed. The handler still has to unwind its durable Stop.
        let refusal = super::super::stop_session(&state, Some(&sessions), id)
            .await
            .unwrap_err();
        assert_eq!(refusal.code, "SDK_ERROR");
        assert!(state.session_status_tx.is_busy(id));
        assert!(hold.owes_resume());
        let (owner, stops): (String, i64) = sqlx::query_as(
            "SELECT reader_id, (SELECT COUNT(*) FROM agent_user_stops WHERE session_id = ?1)
             FROM agent_background_work WHERE session_id = ?1",
        )
        .bind(id)
        .fetch_one(&state.write_pool)
        .await
        .unwrap();
        assert_eq!((owner.as_str(), stops), ("original-reader", 0));
    }
}
