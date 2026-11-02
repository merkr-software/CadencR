//! One firing of a schedule: evaluate its condition (if any), then deliver —
//! or, for a `custom_action` schedule, run the action (see `custom_action`).
//!
//! Shared by the poll loop and "Run now" so a manual run tests exactly what the
//! timer will do — including running the command and staying quiet when it
//! passes.

use std::path::PathBuf;

use super::condition::{self, CheckRecord, Evaluation};
use super::custom_action::{self, Wait};
use super::dispatch;
use super::models::{Schedule, ScheduleCheckStatus, ScheduleCondition, TargetKind};
use super::repository;
use crate::app_state::AppState;
use crate::domain::mcp::control::is_active_db_state;
use crate::domain::projects::service::resolve_project_root;
use crate::domain::workflow::worktree::resolve_feature_cwd;

pub enum FireOutcome {
    /// The prompt reached the agent, or the custom action ran successfully.
    Delivered { feature_id: i64 },
    /// Delivery, or the condition evaluation that gates it, failed.
    Failed { error: String },
    /// The command passed: nothing to send.
    Passed,
    /// The target's agent was still working, so the command wasn't run.
    Busy,
}

/// Fire `schedule` once.
///
/// `skip_when_busy` is the timer's guard against piling up: a check that fails
/// every 15 minutes while the agent spends an hour fixing it would otherwise
/// queue four more copies of the same failure into the conversation it is
/// working in. A manual run passes `false` — the user asked for it now.
pub async fn fire(
    state: &AppState,
    schedule: &Schedule,
    occurrence: &str,
    skip_when_busy: bool,
) -> FireOutcome {
    if schedule.target.kind == TargetKind::CustomAction {
        // Only the timer passes `skip_when_busy`: it records the run's exit
        // status, while a manual run reports as soon as the command started.
        let wait = if skip_when_busy {
            Wait::ForExit
        } else {
            Wait::ForStart
        };
        return custom_action::fire(state, schedule, wait).await;
    }
    let Some(condition) = &schedule.condition else {
        return deliver(state, schedule, occurrence).await;
    };
    fire_gated(state, schedule, condition, occurrence, skip_when_busy)
        .await
        .unwrap_or_else(|error| FireOutcome::Failed { error })
}

async fn fire_gated(
    state: &AppState,
    schedule: &Schedule,
    condition: &ScheduleCondition,
    occurrence: &str,
    skip_when_busy: bool,
) -> Result<FireOutcome, String> {
    if skip_when_busy && target_is_busy(state, schedule).await? {
        record(state, schedule, ScheduleCheckStatus::Busy, None).await?;
        return Ok(FireOutcome::Busy);
    }
    let evaluation = match condition_cwd(state, schedule).await {
        Ok(cwd) => condition::evaluate(condition, &cwd).await,
        Err(error) => {
            Evaluation::Error(format!("trigger command has no working directory: {error}"))
        }
    };
    match evaluation {
        Evaluation::Passed => {
            record(state, schedule, ScheduleCheckStatus::Passed, Some(0)).await?;
            Ok(FireOutcome::Passed)
        }
        Evaluation::Error(error) => {
            tracing::warn!(schedule_id = schedule.id, %error, "schedule condition could not run");
            record(state, schedule, ScheduleCheckStatus::Error, None)
                .await
                .map_err(|record_error| format!("{error}; {record_error}"))?;
            Err(error)
        }
        Evaluation::Failed { exit_code, output } => {
            // Recorded before delivery: once the prompt is out, a failed write
            // must not be able to fail the run, or its retry would send the
            // prompt a second time.
            record(
                state,
                schedule,
                ScheduleCheckStatus::Triggered,
                exit_code.map(i64::from),
            )
            .await?;
            let mut triggered = schedule.clone();
            triggered.prompt = condition::triggered_prompt(
                &schedule.prompt,
                &condition.command,
                exit_code,
                &output,
            );
            Ok(deliver(state, &triggered, occurrence).await)
        }
    }
}

async fn deliver(state: &AppState, schedule: &Schedule, occurrence: &str) -> FireOutcome {
    match dispatch::run(state, schedule, occurrence).await {
        Ok(feature_id) => FireOutcome::Delivered { feature_id },
        Err(error) => {
            tracing::warn!(error = %error, schedule_id = schedule.id, "schedule dispatch failed");
            FireOutcome::Failed {
                error: error.to_string(),
            }
        }
    }
}

async fn record(
    state: &AppState,
    schedule: &Schedule,
    status: ScheduleCheckStatus,
    exit_code: Option<i64>,
) -> Result<(), String> {
    repository::record_check(
        &state.write_pool,
        schedule.id,
        CheckRecord { status, exit_code },
    )
    .await
    .map_err(|error| format!("could not record the trigger check: {error}"))
}

/// Where the command runs: where the conversation's agent works (its live
/// worktree, or the project root without one), or the project root for a
/// schedule that creates its conversation per run — that conversation doesn't
/// exist yet.
async fn condition_cwd(state: &AppState, schedule: &Schedule) -> Result<PathBuf, String> {
    match schedule.target.kind {
        TargetKind::Conversation | TargetKind::CustomAction => {
            let feature_id = schedule
                .target
                .feature_id
                .ok_or_else(|| format!("schedule {} has no feature_id", schedule.id))?;
            resolve_feature_cwd(&state.read_pool, feature_id)
                .await
                .map(PathBuf::from)
        }
        TargetKind::NewConversation => {
            let project_id = schedule
                .target
                .project_id
                .ok_or_else(|| format!("schedule {} has no project_id", schedule.id))?;
            resolve_project_root(&state.read_pool, project_id)
                .await
                .map_err(|error| error.to_string())
        }
    }
}

/// Whether the targeted conversation's agent is mid-turn or waiting on the
/// user. A schedule that creates its own conversation is never busy.
async fn target_is_busy(state: &AppState, schedule: &Schedule) -> Result<bool, String> {
    let (TargetKind::Conversation, Some(feature_id)) =
        (schedule.target.kind, schedule.target.feature_id)
    else {
        return Ok(false);
    };
    let sessions: Vec<(String, bool, bool)> = sqlx::query_as(
        "SELECT status, pending_permission IS NOT NULL, pending_questions IS NOT NULL
         FROM agent_sessions WHERE feature_id = ? AND agent_type = 'session'",
    )
    .bind(feature_id)
    .fetch_all(&state.read_pool)
    .await
    .map_err(|error| format!("could not read the agent's status: {error}"))?;
    Ok(sessions
        .iter()
        .any(|(status, permission, question)| is_active_db_state(status, *permission, *question)))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::schedules::repository::test_support::{fixture, once_into_conversation};
    use crate::domain::schedules::repository::{get, insert};

    async fn conditional(
        pool: &sqlx::SqlitePool,
        feature_id: i64,
        command: &str,
    ) -> (AppState, Schedule) {
        sqlx::query("UPDATE projects SET path = ?")
            .bind(std::env::temp_dir().to_string_lossy().into_owned())
            .execute(pool)
            .await
            .unwrap();
        let mut body = once_into_conversation(feature_id, "2099-01-01T09:00:00Z");
        body.condition = Some(ScheduleCondition {
            command: command.into(),
            timeout_seconds: Some(30),
        });
        let created = insert(pool, body).await.unwrap();
        let schedule = get(pool, created.id).await.unwrap().unwrap();
        (AppState::with_pool(pool.clone()), schedule)
    }

    async fn last_check(pool: &sqlx::SqlitePool, id: i64) -> (ScheduleCheckStatus, Option<i64>) {
        let check = get(pool, id).await.unwrap().unwrap().last_check.unwrap();
        (check.status, check.exit_code)
    }

    async fn add_session(pool: &sqlx::SqlitePool, feature_id: i64, status: &str, gate: bool) {
        sqlx::query(
            "INSERT INTO agent_sessions (feature_id, agent_type, status, pending_permission)
             VALUES (?, 'session', ?, ?)",
        )
        .bind(feature_id)
        .bind(status)
        .bind(gate.then_some("{}"))
        .execute(pool)
        .await
        .unwrap();
    }

    #[tokio::test]
    async fn a_passing_command_holds_the_prompt() {
        let (pool, _, feature_id) = fixture().await;
        let (state, schedule) = conditional(&pool, feature_id, "exit 0").await;

        let outcome = fire(&state, &schedule, "occurrence", true).await;
        assert!(matches!(outcome, FireOutcome::Passed));
        assert_eq!(
            last_check(&pool, schedule.id).await,
            (ScheduleCheckStatus::Passed, Some(0))
        );
    }

    // The point of the busy guard: while the agent works on the last failure,
    // the command isn't even run — its result would be meaningless mid-edit.
    #[tokio::test]
    async fn a_busy_conversation_is_not_evaluated_by_the_timer() {
        let (pool, _, feature_id) = fixture().await;
        let (state, schedule) = conditional(&pool, feature_id, "exit 1").await;
        add_session(&pool, feature_id, "running", false).await;

        let outcome = fire(&state, &schedule, "occurrence", true).await;
        assert!(matches!(outcome, FireOutcome::Busy));
        assert_eq!(
            last_check(&pool, schedule.id).await,
            (ScheduleCheckStatus::Busy, None)
        );
    }

    // An agent stopped at a permission prompt is still on the job: a new copy
    // of the failure would land behind a question the user hasn't answered.
    #[tokio::test]
    async fn an_agent_waiting_at_a_gate_counts_as_busy() {
        let (pool, _, feature_id) = fixture().await;
        let (state, schedule) = conditional(&pool, feature_id, "exit 1").await;
        add_session(&pool, feature_id, "paused", true).await;

        let outcome = fire(&state, &schedule, "occurrence", true).await;
        assert!(matches!(outcome, FireOutcome::Busy));
    }

    #[tokio::test]
    async fn a_command_that_cannot_finish_is_a_failed_run() {
        let (pool, _, feature_id) = fixture().await;
        let (state, mut schedule) = conditional(&pool, feature_id, "sleep 5").await;
        schedule.condition.as_mut().unwrap().timeout_seconds = Some(1);

        let FireOutcome::Failed { error } = fire(&state, &schedule, "occurrence", false).await
        else {
            panic!("expected a failed run");
        };
        assert!(error.contains("timed out"), "{error}");
        assert_eq!(
            last_check(&pool, schedule.id).await,
            (ScheduleCheckStatus::Error, None)
        );
    }
}
