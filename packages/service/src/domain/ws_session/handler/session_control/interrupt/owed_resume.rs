//! A user's Stop ends any resume the conversation was owed.
//!
//! Background work the agent left running would otherwise make a restart
//! resume the conversation the user just stopped. The record is forgotten
//! (and the Stop remembered) durably, before the runtime is told to stop, so
//! no restart can land between the stop marker and that write.

use crate::app_state::AppState;
use crate::domain::agents::adapter::RuntimeSessionHandle;
use crate::domain::restart_continuations::{record_background_work, record_user_stop};
use crate::domain::ws_session::runtime::helpers::report_if_unsaved;
use crate::domain::ws_session::runtime::output::CommandError;
use crate::domain::ws_session::runtime::prompt::runtime_hold_registry;

/// The Stop went through, but its record did not.
const STOP_NOT_RECORDED: &str = "STOP_NOT_RECORDED";

/// Forget the resume `runtime` owed, in memory (so its reader does not write
/// it back) and in the database. A failed write does not hold the Stop back:
/// the caller reports it once the agent stopped.
pub(super) async fn forget(
    app_state: &AppState,
    runtime: &RuntimeSessionHandle,
    db_session_id: i64,
) -> Result<(), CommandError> {
    runtime_hold_registry::stop_by_user(db_session_id, runtime);
    record_user_stop(&app_state.write_pool, db_session_id, chrono::Utc::now())
        .await
        .map_err(|error| {
            tracing::error!(db_session_id, %error, "failed to record a user stop");
            CommandError::new(
                STOP_NOT_RECORDED,
                format!(
                    "The agent stopped, but Cadencr could not record it, so a restart may \
                     resume its background work: {error}"
                ),
            )
        })
}

/// The runtime did not stop: what it owed before [`forget`] still stands.
/// Its reader believes the record is written, so it is written back here.
pub(super) async fn restore(
    app_state: &AppState,
    runtime: &RuntimeSessionHandle,
    db_session_id: i64,
    feature_id: i64,
) {
    if !runtime_hold_registry::cancel_stop_by_user(db_session_id, runtime) {
        return;
    }
    // The Stop itself already failed and is reported; a failure here only
    // loses the resume a restart would have brought, and viewers are told.
    report_if_unsaved(
        &app_state.ws_feature_senders,
        feature_id,
        db_session_id,
        "background work state",
        record_background_work(
            &app_state.write_pool,
            db_session_id,
            Some(chrono::Utc::now()),
        )
        .await,
    )
    .await;
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use super::*;
    use crate::domain::agents::adapter::{RuntimeEvent, RuntimeEventKind, RuntimeEventMetadata};
    use crate::domain::ws_session::handler::tests::support::{
        make_active_handle, make_test_app_state,
    };
    use crate::domain::ws_session::handler::types::QueryState;
    use crate::domain::ws_session::runtime::prompt::runtime_hold_registry::{
        register, SharedRuntimeHold,
    };

    const SESSION: i64 = 9301;

    async fn count(app_state: &AppState, sql: &'static str) -> i64 {
        sqlx::query_scalar(sql)
            .bind(SESSION)
            .fetch_one(&app_state.write_pool)
            .await
            .unwrap()
    }

    const OWED: &str = "SELECT COUNT(*) FROM agent_background_work WHERE session_id = ?";
    const STOPS: &str = "SELECT COUNT(*) FROM agent_user_stops WHERE session_id = ?";

    /// The Stop's record is durable before the runtime is told to stop, and
    /// a Stop that did not go through gives the owed resume back.
    #[tokio::test]
    async fn a_stop_forgets_the_owed_resume_durably_and_a_failed_one_restores_it() {
        let app_state = make_test_app_state().await;
        let QueryState::Active { query: runtime, .. } = make_active_handle(1, None).state else {
            unreachable!("make_active_handle is active");
        };
        let hold = SharedRuntimeHold::default();
        hold.observe(
            &RuntimeEvent::new(RuntimeEventMetadata::default(), RuntimeEventKind::Other)
                .with_background_task_count(Some(1)),
            false,
        );
        let _registration = register(SESSION, &Arc::downgrade(&runtime), &hold);
        record_background_work(&app_state.write_pool, SESSION, Some(chrono::Utc::now()))
            .await
            .unwrap();

        forget(&app_state, &runtime, SESSION).await.unwrap();

        assert_eq!(count(&app_state, OWED).await, 0);
        assert_eq!(count(&app_state, STOPS).await, 1);
        assert!(!hold.owes_resume());

        restore(&app_state, &runtime, SESSION, 1).await;

        assert_eq!(count(&app_state, OWED).await, 1);
        assert!(hold.owes_resume());
    }
}
