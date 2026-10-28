//! The desktop's say in what the next start does with the agents a quit stops.

use axum::http::StatusCode;
use axum::routing::put;
use axum::{Json, Router};
use serde::Deserialize;

use crate::app_state::AppState;

#[derive(Debug, Deserialize)]
pub struct ShutdownIntentRequest {
    resume_agents: bool,
}

/// Sent by the desktop right before it stops the service, when the user quits
/// and chooses to stop their agents instead of resuming them next time.
async fn set_shutdown_intent(Json(body): Json<ShutdownIntentRequest>) -> StatusCode {
    super::capture::set_resume_on_shutdown(body.resume_agents);
    StatusCode::NO_CONTENT
}

/// Loopback only: quitting the desktop app is never a remote device's call.
pub fn loopback_router() -> Router<AppState> {
    Router::new().route(
        "/api/restart-continuations/shutdown-intent",
        put(set_shutdown_intent),
    )
}
