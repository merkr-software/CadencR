//! The desktop's say in what the next start does with the agents a quit stops.

use axum::extract::State;
use axum::http::StatusCode;
use axum::routing::{get, post, put};
use axum::{Json, Router};
use serde::Deserialize;

use crate::app_state::AppState;
use crate::error::AppError;

pub(crate) use super::active_work::ActiveCloseWork;

#[derive(Debug, Deserialize)]
pub struct ShutdownIntentRequest {
    resume_agents: bool,
    /// Background work between turns; follows `resume_agents` when absent.
    resume_background_work: Option<bool>,
}

impl ShutdownIntentRequest {
    /// Whether turns, then background work, resume on the next start.
    fn resumes(&self) -> (bool, bool) {
        (
            self.resume_agents,
            self.resume_background_work.unwrap_or(self.resume_agents),
        )
    }
}

/// Record the desktop's shutdown intent before it stops the sidecar.
async fn set_shutdown_intent(
    State(state): State<AppState>,
    Json(body): Json<ShutdownIntentRequest>,
) -> Result<StatusCode, AppError> {
    let (turns, background_work) = body.resumes();
    super::quit_intent::record(&state.write_pool, turns, background_work).await?;
    Ok(StatusCode::NO_CONTENT)
}

/// Stop active work before the desktop quits, including its owned processes.
#[utoipa::path(
    post,
    path = "/api/restart-continuations/prepare-desktop-quit",
    operation_id = "stopLiveWorkForQuit",
    responses(
        (status = 204, description = "Active work and owned agent processes stopped"),
        (status = 409, description = "Could not confirm that active work stopped"),
    )
)]
pub(crate) async fn stop_live_work(State(state): State<AppState>) -> Result<StatusCode, AppError> {
    // A disconnect must not cancel recorded stops while runtimes close.
    tokio::spawn(async move { super::dev_quit::stop_active_work(&state).await })
        .await
        .map_err(|error| {
            AppError::internal(format!("Stopping work during quit failed: {error}"))
        })??;
    Ok(StatusCode::NO_CONTENT)
}

/// List conversations with active turns or background work for the close dialog.
#[utoipa::path(
    get,
    path = "/api/restart-continuations/active-work",
    operation_id = "getActiveCloseWork",
    responses((status = 200, body = Vec<ActiveCloseWork>))
)]
pub(crate) async fn get_active_close_work(
    State(state): State<AppState>,
) -> Result<Json<Vec<ActiveCloseWork>>, AppError> {
    Ok(Json(super::active_work::list(&state).await?))
}

/// Loopback only: quitting the desktop app is never a remote device's call.
pub fn loopback_router() -> Router<AppState> {
    Router::new()
        .route(
            "/api/restart-continuations/shutdown-intent",
            put(set_shutdown_intent),
        )
        .route(
            "/api/restart-continuations/active-work",
            get(get_active_close_work),
        )
        .route(
            "/api/restart-continuations/prepare-desktop-quit",
            post(stop_live_work),
        )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parse(json: &str) -> (bool, bool) {
        serde_json::from_str::<ShutdownIntentRequest>(json)
            .unwrap()
            .resumes()
    }

    #[test]
    fn background_work_follows_the_agents_unless_told_apart() {
        assert_eq!(parse(r#"{"resume_agents":false}"#), (false, false));
        assert_eq!(parse(r#"{"resume_agents":true}"#), (true, true));
        assert_eq!(
            parse(r#"{"resume_agents":true,"resume_background_work":false}"#),
            (true, false)
        );
    }
}
