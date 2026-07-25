//! The background poll loop that fires due schedules.
//!
//! One loop for every schedule, not a timer per rule. Creating, editing,
//! pausing or deleting a schedule is just a write to `schedules` — the next
//! tick picks the change up, so there is no in-memory timer set to drift out of
//! sync with the database (the failure mode the custom-action scheduler has to
//! work around with explicit `apply_change` calls).

use std::time::Duration;

use chrono::Utc;
use tracing::{info, warn};

use super::planner::{self, DueAction};
use super::repository::{self, ClaimedSchedule, RunOutcome};
use super::{dispatch, models::Schedule};
use crate::app_state::AppState;
use crate::error::AppError;

/// Scheduling is human-grained (minute precision at best), so a 10s tick keeps
/// worst-case lateness imperceptible while staying cheap — the scan is a single
/// indexed query.
const POLL_INTERVAL: Duration = Duration::from_secs(10);

/// Ceiling on how many schedules one tick will fire. Rolling a rule forward
/// always lands strictly in the future, so this can only be reached by a large
/// genuine backlog; capping it keeps one tick from monopolising the runtime and
/// leaves the rest for the next one, ten seconds later.
const MAX_RUNS_PER_TICK: usize = 25;

pub fn spawn(state: AppState) {
    info!("starting schedule dispatcher");
    tokio::spawn(async move {
        let mut ticker = tokio::time::interval(POLL_INTERVAL);
        ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        loop {
            ticker.tick().await;
            if let Err(error) = tick(&state).await {
                warn!(error = %error, "schedule scan failed");
            }
        }
    });
}

async fn tick(state: &AppState) -> Result<(), AppError> {
    for _ in 0..MAX_RUNS_PER_TICK {
        let Some(claimed) = repository::claim_due(&state.write_pool).await? else {
            return Ok(());
        };
        run_claimed(state, claimed).await;
    }
    Ok(())
}

/// Dispatch one claimed schedule and record what happened.
///
/// Every path ends in a `finish_run`, including failure: a rule that can never
/// succeed must still roll forward, or it would re-fire on every tick forever.
async fn run_claimed(state: &AppState, claimed: ClaimedSchedule) {
    let ClaimedSchedule {
        schedule,
        claim_token,
    } = claimed;
    let now = Utc::now();
    let scheduled_for = schedule
        .next_run_at
        .as_deref()
        .and_then(planner::parse_instant);
    let next_run_at = planner::next_run_after_run(&schedule.recurrence, scheduled_for, now);
    let occurrence = schedule
        .next_run_at
        .clone()
        .unwrap_or_else(|| now.to_rfc3339());

    let outcome = match planner::due_action(scheduled_for, now) {
        DueAction::Skip => {
            info!(
                schedule_id = schedule.id,
                scheduled_for = schedule.next_run_at.as_deref().unwrap_or("?"),
                "skipping a schedule that came due while Cadencr was closed"
            );
            skipped(next_run_at.clone())
        }
        DueAction::Run => deliver(state, &schedule, &occurrence, next_run_at.clone()).await,
    };

    if let Err(error) =
        repository::finish_run(&state.write_pool, schedule.id, &claim_token, outcome).await
    {
        warn!(error = %error, schedule_id = schedule.id, "failed to record schedule run");
    }
}

async fn deliver(
    state: &AppState,
    schedule: &Schedule,
    occurrence: &str,
    next_run_at: Option<String>,
) -> RunOutcome {
    match dispatch::run(state, schedule, occurrence).await {
        Ok(feature_id) => RunOutcome {
            status: "sent",
            error: None,
            feature_id: Some(feature_id),
            next_run_at,
        },
        Err(error) => {
            warn!(error = %error, schedule_id = schedule.id, "schedule dispatch failed");
            RunOutcome {
                status: "failed",
                error: Some(error.to_string()),
                feature_id: None,
                next_run_at,
            }
        }
    }
}

fn skipped(next_run_at: Option<String>) -> RunOutcome {
    RunOutcome {
        status: "skipped",
        error: Some(
            "Cadencr was not running when this was due, and it was too old to send late.".into(),
        ),
        feature_id: None,
        next_run_at,
    }
}
