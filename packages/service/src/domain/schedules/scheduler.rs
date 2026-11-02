//! The background poll loop that fires due schedules.
//!
//! One loop for every schedule, not a timer per rule. Creating, editing,
//! pausing or deleting a schedule is just a write to `schedules` — the next
//! tick picks the change up, so there is no in-memory timer set to drift out of
//! sync with the database. Custom actions are scheduled here too (a
//! `custom_action` target), not on timers of their own.

use std::time::Duration;

use chrono::Utc;
use tracing::{info, warn};

use super::fire::{self, FireOutcome};
use super::models::{Schedule, ScheduleRanEvent, TargetKind};
use super::planner::{self, DueAction};
use super::repository::{self, ClaimedSchedule, RunOutcome};
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
        if claimed.schedule.condition.is_some()
            || claimed.schedule.target.kind == TargetKind::CustomAction
        {
            // A condition command or a custom action can run for minutes;
            // evaluated inline it would hold every other schedule behind it.
            // The claim already keeps the row exclusive, so it can finish on
            // its own task.
            let state = state.clone();
            tokio::spawn(async move { run_claimed(&state, claimed).await });
        } else {
            run_claimed(state, claimed).await;
        }
    }
    Ok(())
}

/// Dispatch one claimed schedule and record what happened.
///
/// Every path ends by releasing the claim, including failure: a rule that can
/// never succeed must still roll forward, or it would re-fire on every tick
/// forever.
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

    let recorded = match planner::due_action(scheduled_for, now) {
        DueAction::Skip => {
            info!(
                schedule_id = schedule.id,
                scheduled_for = schedule.next_run_at.as_deref().unwrap_or("?"),
                "skipping a schedule that came due while Cadencr was closed"
            );
            let outcome = skipped(next_run_at);
            repository::finish_run(&state.write_pool, schedule.id, &claim_token, outcome).await
        }
        DueAction::Run => {
            let outcome = fire::fire(state, &schedule, &occurrence, true).await;
            record(state, &schedule, &claim_token, outcome, next_run_at).await
        }
    };

    if let Err(error) = recorded {
        warn!(error = %error, schedule_id = schedule.id, "failed to record schedule run");
        return;
    }
    // Announced only after the row is durable, so a client refetching on this
    // cue can't read back the pre-run state. Every outcome is broadcast, not
    // just `sent`: a failed, skipped or held run still advanced the rule.
    let _ = state.schedule_events_tx.send(ScheduleRanEvent {
        schedule_id: schedule.id,
    });
}

async fn record(
    state: &AppState,
    schedule: &Schedule,
    claim_token: &str,
    outcome: FireOutcome,
    next_run_at: Option<String>,
) -> Result<(), AppError> {
    let outcome = match outcome {
        FireOutcome::Passed | FireOutcome::Busy => {
            return repository::release_claim(
                &state.write_pool,
                schedule.id,
                claim_token,
                next_run_at.as_deref(),
            )
            .await;
        }
        FireOutcome::Delivered { feature_id } => RunOutcome {
            status: "sent",
            error: None,
            feature_id: Some(feature_id),
            next_run_at,
        },
        FireOutcome::Failed { error } => RunOutcome {
            status: "failed",
            error: Some(error),
            feature_id: None,
            next_run_at,
        },
    };
    repository::finish_run(&state.write_pool, schedule.id, claim_token, outcome).await
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
