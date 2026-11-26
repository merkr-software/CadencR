use std::time::Duration;

use crate::app_state::AppState;
use crate::domain::agents::adapter::RuntimeSessionHandle;
use crate::domain::ws_session::stream_readers::wait_for_session_transcript;
use crate::error::AppError;

use super::detached_runtime::close_context;
use super::helpers::{persist_and_close_runtime, persistable_resume_sid};
use super::prompt::prompt_runtime_config::reset_handle_to_pending;
use super::{QueryState, SdkSessions};

/// Called with launch admission closed. Even if a previous attempt retired a
/// runtime, its reader must finish saving the transcript before the quit marker.
pub(crate) async fn close_runtime(
    state: &AppState,
    session_id: i64,
) -> Result<Option<i64>, AppError> {
    let feature_id = match state.session_runtimes.get(session_id).await {
        Some(cell) => retire(state, &cell, session_id).await?,
        None => None,
    };
    if !wait_for_session_transcript(session_id).await {
        return Err(AppError::Conflict(format!(
            "Session {session_id} is still saving its transcript. Try quitting again."
        )));
    }
    Ok(feature_id)
}

async fn retire(
    state: &AppState,
    cell: &SdkSessions,
    session_id: i64,
) -> Result<Option<i64>, AppError> {
    let query = cell
        .lock()
        .await
        .get(&session_id)
        .and_then(|handle| handle.state.active_query());
    let Some(query) = query else {
        return Ok(None);
    };
    make_writer_available(&query, session_id).await;
    // Only detach once we own the writer of this exact runtime. On a
    // refusal, it remains attached and a retry will still find it.
    let (lease, mut runtime, provider, feature_id) = {
        let mut handles = cell.lock().await;
        let Some(handle) = handles.get_mut(&session_id) else {
            return Ok(None);
        };
        if matches!(handle.state, QueryState::Pending(_)) {
            return Ok(None);
        }
        if !handle.state.runs(Some(&query)) {
            return Err(still_busy(session_id));
        }
        let runtime = query
            .try_write_owned()
            .map_err(|_| still_busy(session_id))?;
        let provider = handle.runtime_provider.clone();
        let resume = persistable_resume_sid(runtime.as_ref(), &provider).await;
        let lease = state.session_runtimes.begin_detached_close(session_id);
        reset_handle_to_pending(handle, resume);
        (lease, runtime, provider, handle.feature_id)
    };
    let state = state.clone();
    let close = tokio::spawn(async move {
        let _lease = lease;
        persist_and_close_runtime(
            runtime.as_mut(),
            &close_context(&state),
            session_id,
            &provider,
            feature_id,
        )
        .await;
    });
    // The owned task retains its lease if it needs longer. A new launch or
    // quit waits for that same close instead of losing the detached runtime.
    tokio::time::timeout(Duration::from_secs(8), close)
        .await
        .map_err(|_| still_busy(session_id))?
        .map_err(|error| {
            AppError::internal(format!("Closing session {session_id} failed: {error}"))
        })?;
    Ok(Some(feature_id))
}

async fn make_writer_available(query: &RuntimeSessionHandle, session_id: i64) {
    if tokio::time::timeout(Duration::from_millis(250), query.write())
        .await
        .is_ok()
    {
        return;
    }
    // A provider prompt can retain a read guard for the whole reply. Closing
    // its transport, when supported, also prevents a late admitted prompt
    // from starting after a cooperative cancel.
    if tokio::time::timeout(Duration::from_secs(3), async {
        let runtime = query.read().await;
        if !runtime.terminate_unresponsive_stop(format!("Stopping session {session_id} for quit")).await {
            if let Err(error) = runtime.interrupt_before_sleep().await {
                tracing::info!(session_id, %error, "could not interrupt session before closing it for quit");
            }
        }
    }).await.is_err() {
        tracing::warn!(session_id, "provider did not finish stopping its prompt before quit");
    }
    // Give the cancelled prompt time to release its guard, without holding
    // the cell or queuing a writer indefinitely.
    if tokio::time::timeout(Duration::from_secs(2), query.write())
        .await
        .is_err()
    {
        tracing::warn!(session_id, "session runtime is still in use during quit");
    }
}

fn still_busy(session_id: i64) -> AppError {
    AppError::Conflict(format!(
        "Session {session_id} is still closing. Try quitting again."
    ))
}

#[cfg(test)]
mod tests {
    use axum::body::Body;
    use axum::http::{Request, StatusCode};
    use tower::ServiceExt;

    use super::*;
    use crate::domain::restart_continuations::{loopback_router, write_background_work};
    use crate::domain::schedules::repository::test_support::fixture;
    use crate::domain::ws_session::handler::tests::support::make_active_handle;
    use crate::domain::ws_session::runtime::state::new_sdk_sessions;

    #[tokio::test]
    async fn dev_quit_keeps_the_runtime_if_recording_fails_then_closes_it_on_retry() {
        let (pool, _, feature_id) = fixture().await;
        let id: i64 = sqlx::query_scalar(
            "INSERT INTO agent_sessions (feature_id, agent_type, status)
             VALUES (?, 'session', 'completed') RETURNING id",
        )
        .bind(feature_id)
        .fetch_one(&pool)
        .await
        .unwrap();
        let state = AppState::with_pool(pool.clone());
        let cell = new_sdk_sessions();
        cell.lock()
            .await
            .insert(id, make_active_handle(feature_id, None));
        state
            .session_runtimes
            .bind_feature(id, feature_id, &cell)
            .await;
        write_background_work(&pool, id, "unopened", Some(chrono::Utc::now()))
            .await
            .unwrap();

        let router = loopback_router().with_state(state);
        let request = || {
            Request::post("/api/restart-continuations/prepare-desktop-quit")
                .body(Body::empty())
                .unwrap()
        };
        sqlx::raw_sql(
            "CREATE TRIGGER reject_capture BEFORE INSERT ON restart_continuations
             BEGIN SELECT RAISE(ABORT, 'capture unavailable'); END;",
        )
        .execute(&pool)
        .await
        .unwrap();

        assert_eq!(
            router.clone().oneshot(request()).await.unwrap().status(),
            StatusCode::INTERNAL_SERVER_ERROR
        );
        assert!(cell.lock().await[&id].state.active_query().is_some());

        sqlx::query("DROP TRIGGER reject_capture")
            .execute(&pool)
            .await
            .unwrap();
        assert_eq!(
            router.oneshot(request()).await.unwrap().status(),
            StatusCode::NO_CONTENT
        );
        assert!(matches!(
            cell.lock().await[&id].state,
            QueryState::Pending(_)
        ));
        let transcript: String = sqlx::query_scalar(
            "SELECT content FROM agent_messages WHERE session_id = ? AND message_type = 'turn_interrupted'",
        ).bind(id).fetch_one(&pool).await.unwrap();
        assert_eq!(
            transcript,
            crate::domain::restart_continuations::QUIT_BACKGROUND_MARKER_CONTENT
        );
    }
}
