use std::time::Duration;

use tracing::{info, warn};

use super::repository;
use crate::app_state::AppState;
use crate::domain::ws_session::handler::session_prompt::dispatch_control_prompt;
use crate::error::AppError;

/// How often the poll loop scans for due messages. Scheduling is human-grained
/// (minute precision), so a 10s tick keeps worst-case lateness imperceptible
/// while staying cheap — the scan is a single indexed query.
const POLL_INTERVAL: Duration = Duration::from_secs(10);

/// Start the background scheduler. A single loop polls `scheduled_messages` for
/// rows whose time has come and dispatches each into its session, surviving the
/// process lifetime. Creating / editing / cancelling a schedule just writes the
/// table — the next tick picks the change up, so there's no per-row timer to
/// keep in sync.
pub fn spawn(state: AppState) {
    info!("starting scheduled-message dispatcher");
    tokio::spawn(async move {
        let mut ticker = tokio::time::interval(POLL_INTERVAL);
        ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        loop {
            ticker.tick().await;
            if let Err(e) = tick(&state).await {
                warn!(error = %e, "scheduled-message scan failed");
            }
        }
    });
}

async fn tick(state: &AppState) -> Result<(), AppError> {
    let due = repository::list_due(&state.read_pool).await?;
    for msg in due {
        // Mark terminal state regardless of dispatch outcome so a persistently
        // failing row can never wedge the loop or re-fire every tick.
        match dispatch_due(state, &msg).await {
            Ok(()) => {
                if let Err(e) = repository::mark_sent(&state.write_pool, msg.id).await {
                    warn!(error = %e, id = msg.id, "failed to mark scheduled message sent");
                }
            }
            Err(e) => {
                warn!(error = %e, id = msg.id, feature_id = msg.feature_id, "scheduled message dispatch failed");
                if let Err(e) =
                    repository::mark_failed(&state.write_pool, msg.id, &e.to_string()).await
                {
                    warn!(error = %e, id = msg.id, "failed to mark scheduled message failed");
                }
            }
        }
    }
    Ok(())
}

/// Resolve the conversation's session (creating one if it has never spawned an
/// agent) and deliver the message into it. Keying schedules on the feature lets
/// users schedule the first message of a brand-new conversation.
async fn dispatch_due(
    state: &AppState,
    msg: &super::models::ScheduledMessage,
) -> Result<(), AppError> {
    let session_id =
        repository::resolve_or_create_session(&state.write_pool, msg.feature_id).await?;
    // `replay = false`: persist and broadcast the scheduled text as a normal
    // user message so it appears in the conversation when it fires.
    dispatch_control_prompt(state, msg.feature_id, session_id, &msg.text, false).await
}
