//! The safety net for agent messages: a session that went idle without a turn
//! ending through the stream reader (a stop, a dead runtime, a restart) still
//! receives what other sessions' agents queued for it. The user's own prompts
//! are left alone: a Stop holds them until the next turn ends.

use futures::{stream, StreamExt};
use std::sync::OnceLock;
use tokio::sync::Notify;

use crate::app_state::AppState;
use crate::error::AppError;

use super::delivery::drain_agent_messages_if_idle;

static WAKE: OnceLock<Notify> = OnceLock::new();

fn wake_signal() -> &'static Notify {
    WAKE.get_or_init(Notify::new)
}

/// Run a sweep now instead of at the next tick.
pub(crate) fn wake() {
    wake_signal().notify_one();
}

pub fn spawn(state: AppState) {
    tokio::spawn(async move {
        let mut interval = tokio::time::interval(std::time::Duration::from_secs(30));
        interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        loop {
            tokio::select! {
                _ = interval.tick() => {}
                _ = wake_signal().notified() => {}
            }
            if let Err(error) = sweep_once(&state).await {
                tracing::error!(error = %error, "queued agent message sweep failed");
            }
        }
    });
}

async fn sweep_once(state: &AppState) -> Result<(), AppError> {
    let sessions: Vec<i64> = sqlx::query_scalar(
        "SELECT DISTINCT session_id FROM agent_session_prompt_queue
         WHERE status = 'pending' AND origin_kind = 'session'",
    )
    .fetch_all(&state.read_pool)
    .await?;
    stream::iter(sessions)
        .for_each_concurrent(4, |session_id| async move {
            // The failure is on the row, and its sender was told.
            if let Err(error) = drain_agent_messages_if_idle(state, session_id).await {
                tracing::error!(session_id, error = %error, "queued agent message delivery failed");
            }
        })
        .await;
    Ok(())
}
