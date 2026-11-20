//! The desktop's say in what the next start does with the agents a quit stops.

use axum::extract::State;
use axum::http::StatusCode;
use axum::routing::put;
use axum::{Json, Router};
use serde::Deserialize;

use crate::app_state::AppState;
use crate::error::AppError;

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

/// Sent by the desktop right before it stops the service, when the user quits
/// and chooses to stop their agents instead of resuming them next time, or
/// quits with no agent working (background work then stays stopped). Kept in
/// the database first, so the next start follows it even when this shutdown
/// cannot capture what it cuts off.
async fn set_shutdown_intent(
    State(state): State<AppState>,
    Json(body): Json<ShutdownIntentRequest>,
) -> Result<StatusCode, AppError> {
    let (turns, background_work) = body.resumes();
    super::quit_intent::record(&state.write_pool, turns, background_work).await?;
    super::capture::set_resume_on_shutdown(turns, background_work);
    Ok(StatusCode::NO_CONTENT)
}

/// Loopback only: quitting the desktop app is never a remote device's call.
pub fn loopback_router() -> Router<AppState> {
    Router::new().route(
        "/api/restart-continuations/shutdown-intent",
        put(set_shutdown_intent),
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
