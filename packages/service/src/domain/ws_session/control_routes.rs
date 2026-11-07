//! Stop or suspend a conversation over HTTP.
//!
//! `session.interrupt` and `session.suspend` need the conversation's socket,
//! and a window only holds sockets for the conversations it loaded. An agent
//! started by a schedule, MCP, or another device keeps running otherwise, so
//! "Stop all agents" and the OS suspend reach those through here. Each call
//! answers once the runtime acknowledged; the status change itself reaches
//! every client through the status book, as for the socket commands.
//!
//! The work runs in its own task: a client that goes away (a window closing,
//! a machine falling asleep) must not cancel a stop or a pause half done.

use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::routing::post;
use axum::{Json, Router};
use serde::Serialize;
use utoipa::ToSchema;

use super::handler::{
    owner_sessions, stop_session, suspend_session, AGENT_STARTING, NOTHING_TO_STOP,
};
use super::runtime::output::{CommandError, SessionOutput};
use crate::app_state::AppState;
use crate::error::AppError;

#[derive(Debug, Serialize, ToSchema)]
pub struct AgentSessionControlAck {
    pub accepted: bool,
}

/// Stop the session's running turn.
#[utoipa::path(post, path = "/api/sessions/{session_id}/interrupt",
    params(("session_id" = i64, Path,)),
    responses(
        (status = 200, body = AgentSessionControlAck),
        (status = 404, description = "SESSION_NOT_FOUND"),
        (status = 409, description = "INVALID_STATE: nothing is running; AGENT_STARTING: not stoppable yet"),
        (status = 502, description = "SDK_ERROR: the agent refused the stop"),
    ))]
pub async fn interrupt_agent_session(
    State(state): State<AppState>,
    Path(session_id): Path<i64>,
) -> Result<Json<AgentSessionControlAck>, AppError> {
    detached(async move { stop_session(&state, None, session_id).await }).await?;
    Ok(Json(AgentSessionControlAck { accepted: true }))
}

/// Pause the session for an OS sleep, keeping its resume point.
#[utoipa::path(post, path = "/api/sessions/{session_id}/suspend",
    params(("session_id" = i64, Path,)),
    responses(
        (status = 200, body = AgentSessionControlAck),
        (status = 500, description = "DB_ERROR: its pending request could not be closed"),
        (status = 502, description = "SDK_ERROR: the agent refused the pause"),
    ))]
pub async fn suspend_agent_session(
    State(state): State<AppState>,
    Path(session_id): Path<i64>,
) -> Result<Json<AgentSessionControlAck>, AppError> {
    detached(async move {
        // No runtime: nothing to pause, and nothing to resume after the wake.
        let Some(sessions) = owner_sessions(&state, None, session_id).await else {
            return Ok(());
        };
        suspend_session(
            &state,
            &sessions,
            session_id,
            &SessionOutput::headless(),
            None,
        )
        .await
    })
    .await?;
    Ok(Json(AgentSessionControlAck { accepted: true }))
}

async fn detached(
    work: impl std::future::Future<Output = Result<(), CommandError>> + Send + 'static,
) -> Result<(), AppError> {
    tokio::spawn(work)
        .await
        .map_err(|error| AppError::Internal(format!("session control task failed: {error}")))?
        .map_err(app_error)
}

fn app_error(error: CommandError) -> AppError {
    let status = match error.code {
        "SESSION_NOT_FOUND" => StatusCode::NOT_FOUND,
        NOTHING_TO_STOP | AGENT_STARTING => StatusCode::CONFLICT,
        "DB_ERROR" => StatusCode::INTERNAL_SERVER_ERROR,
        _ => StatusCode::BAD_GATEWAY,
    };
    AppError::coded(status, error.code, error.message)
}

pub fn session_control_router() -> Router<AppState> {
    Router::new()
        .route(
            "/api/sessions/{session_id}/interrupt",
            post(interrupt_agent_session),
        )
        .route(
            "/api/sessions/{session_id}/suspend",
            post(suspend_agent_session),
        )
}

#[cfg(test)]
mod tests {
    use axum::body::Body;
    use axum::http::Request;
    use tower::ServiceExt;

    use super::*;

    async fn post(path: &str) -> (StatusCode, serde_json::Value) {
        let pool = sqlx::SqlitePool::connect("sqlite::memory:").await.unwrap();
        let app = session_control_router().with_state(AppState::with_pool(pool));
        let request = Request::builder()
            .method("POST")
            .uri(path)
            .body(Body::empty())
            .unwrap();
        let response = app.oneshot(request).await.unwrap();
        let status = response.status();
        let body = axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .unwrap();
        (status, serde_json::from_slice(&body).unwrap())
    }

    #[tokio::test]
    async fn stopping_a_session_with_nothing_running_says_so() {
        let (status, body) = post("/api/sessions/7/interrupt").await;

        assert_eq!(status, StatusCode::CONFLICT);
        assert_eq!(body["code"], NOTHING_TO_STOP);
    }

    #[tokio::test]
    async fn pausing_a_session_without_a_runtime_is_accepted() {
        let (status, body) = post("/api/sessions/7/suspend").await;

        assert_eq!(status, StatusCode::OK);
        assert_eq!(body["accepted"], true);
    }
}
