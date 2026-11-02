//! Firing a `custom_action` schedule: run the action in the target
//! conversation's working copy, exactly as its header button would, and report
//! the run's exit status as the schedule's outcome.

use std::time::{Duration, Instant};

use super::fire::FireOutcome;
use super::models::Schedule;
use crate::app_state::AppState;
use crate::domain::custom_actions::models::TriggeredBy;
use crate::domain::custom_actions::{repository, runner};
use crate::error::AppError;

/// How long the timer waits for a run to exit before recording it as started.
///
/// The run itself is never cut short — custom actions may be dev servers that
/// never exit — this only bounds how long the schedule's claim is held. It has
/// to stay under the claim's stale-takeover window (25 min), or a slow run
/// would let another tick take the claim and start a second copy.
const TIMER_WAIT: Duration = Duration::from_secs(20 * 60);

/// How often a waiting timer re-reads the run's row.
const POLL_INTERVAL: Duration = Duration::from_secs(1);

/// Whether the caller waits for the run to exit before reporting.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Wait {
    /// The timer: the exit code decides `sent` vs `failed`, up to
    /// [`TIMER_WAIT`].
    ForExit,
    /// A manual "Run now": reports as soon as the run has started. Its output
    /// streams into the action's page in the conversation's launcher menu,
    /// and an HTTP request must not hang on a command that may never exit.
    ForStart,
}

pub async fn fire(state: &AppState, schedule: &Schedule, wait: Wait) -> FireOutcome {
    match run(state, schedule, wait).await {
        Ok(feature_id) => FireOutcome::Delivered { feature_id },
        Err(error) => FireOutcome::Failed { error },
    }
}

async fn run(state: &AppState, schedule: &Schedule, wait: Wait) -> Result<i64, String> {
    let (Some(action_id), Some(feature_id)) =
        (schedule.target.action_id, schedule.target.feature_id)
    else {
        return Err(format!(
            "schedule {} has no action or conversation to run it in",
            schedule.id
        ));
    };
    // Saving refuses terminal actions, but one can be switched to the terminal
    // after it was scheduled: unattended, it would never end.
    let action = repository::get(&state.read_pool, action_id)
        .await
        .map_err(user_message)?
        .ok_or_else(|| "the action was deleted".to_string())?;
    if action.run_in_terminal {
        return Err(
            "the action now runs in a terminal; switch it back to the background to schedule it"
                .into(),
        );
    }
    // Setup errors (missing worktree, unset `${VAR}` values) surface here,
    // before any run row exists — the message the user needs to fix them.
    let run_id = runner::start(state, action_id, feature_id, TriggeredBy::Schedule)
        .await
        .map_err(user_message)?;
    if wait == Wait::ForStart {
        return Ok(feature_id);
    }
    wait_for_exit(state, run_id, TIMER_WAIT).await?;
    Ok(feature_id)
}

/// Poll the run until it ends. `Ok` for exit 0 or a run still going at
/// `deadline` (it started; its output is on the action's page), `Err` otherwise.
async fn wait_for_exit(state: &AppState, run_id: i64, deadline: Duration) -> Result<(), String> {
    let started = Instant::now();
    loop {
        let outcome = repository::run_outcome(&state.read_pool, run_id)
            .await
            .map_err(|error| format!("could not read the run's status: {error}"))?
            .ok_or_else(|| "the run disappeared — its action was deleted".to_string())?;
        if outcome.ended_at.is_some() {
            return match outcome.exit_code {
                Some(0) => Ok(()),
                Some(code) => Err(format!("the command exited with code {code}")),
                None => Err("the command ended without an exit code".into()),
            };
        }
        if started.elapsed() >= deadline {
            return Ok(());
        }
        tokio::time::sleep(POLL_INTERVAL).await;
    }
}

/// The error without `AppError`'s "Bad request: " prefix — it is shown on the
/// schedule row as the reason the run failed.
fn user_message(error: AppError) -> String {
    match error {
        AppError::BadRequest(message) | AppError::NotFound(message) => message,
        other => other.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::custom_actions::models::Scope;
    use crate::domain::schedules::models::{RecurrenceInput, SaveScheduleRequest, ScheduleTarget};
    use crate::domain::schedules::recurrence::RecurrenceKind;
    use crate::domain::schedules::repository::test_support::fixture;
    use crate::domain::schedules::repository::{get, insert};

    async fn action_schedule(command: &str) -> (AppState, Schedule) {
        let (pool, project_id, feature_id) = fixture().await;
        // A real directory, so the shell can start in the conversation's
        // (worktree-less) working copy: the project root.
        sqlx::query("UPDATE projects SET path = ?")
            .bind(std::env::temp_dir().to_string_lossy().into_owned())
            .execute(&pool)
            .await
            .unwrap();
        let action_id = repository::insert(
            &pool,
            "Check",
            command,
            None,
            Scope::Project,
            Some(project_id),
            false,
        )
        .await
        .unwrap();
        let created = insert(
            &pool,
            SaveScheduleRequest {
                name: None,
                prompt: String::new(),
                target: ScheduleTarget::custom_action(feature_id, action_id),
                recurrence: RecurrenceInput {
                    kind: RecurrenceKind::Interval,
                    run_at: None,
                    interval_seconds: Some(3600),
                    time_of_day: None,
                    weekdays: None,
                    day_of_month: None,
                    timezone: Some("UTC".into()),
                },
                condition: None,
                enabled: None,
            },
        )
        .await
        .unwrap();
        let schedule = get(&pool, created.id).await.unwrap().unwrap();
        (AppState::with_pool(pool), schedule)
    }

    #[tokio::test]
    async fn a_successful_run_is_delivered_into_its_conversation() {
        let (state, schedule) = action_schedule("exit 0").await;
        let outcome = fire(&state, &schedule, Wait::ForExit).await;
        assert!(
            matches!(outcome, FireOutcome::Delivered { feature_id } if Some(feature_id) == schedule.target.feature_id)
        );
    }

    #[tokio::test]
    async fn a_failing_run_reports_its_exit_code() {
        let (state, schedule) = action_schedule("exit 3").await;
        let FireOutcome::Failed { error } = fire(&state, &schedule, Wait::ForExit).await else {
            panic!("expected a failed run");
        };
        assert_eq!(error, "the command exited with code 3");
    }

    #[tokio::test]
    async fn a_setup_error_is_reported_without_the_error_prefix() {
        let (state, schedule) = action_schedule("echo ${ENV}").await;
        let FireOutcome::Failed { error } = fire(&state, &schedule, Wait::ForStart).await else {
            panic!("expected a failed run");
        };
        assert_eq!(error, "Missing values for variables: ENV");
    }

    #[tokio::test]
    async fn an_action_moved_to_the_terminal_is_not_run_unattended() {
        let (state, schedule) = action_schedule("exit 0").await;
        sqlx::query("UPDATE custom_actions SET run_in_terminal = 1")
            .execute(&state.write_pool)
            .await
            .unwrap();
        let FireOutcome::Failed { error } = fire(&state, &schedule, Wait::ForExit).await else {
            panic!("expected a refused run");
        };
        assert!(error.contains("runs in a terminal"), "{error}");
    }

    #[tokio::test]
    async fn a_manual_run_reports_once_started() {
        let (state, schedule) = action_schedule("sleep 5").await;
        let started = Instant::now();
        let outcome = fire(&state, &schedule, Wait::ForStart).await;
        assert!(matches!(outcome, FireOutcome::Delivered { .. }));
        assert!(started.elapsed() < Duration::from_secs(10));
    }

    #[tokio::test]
    async fn a_run_still_going_at_the_deadline_counts_as_started() {
        let (state, schedule) = action_schedule("sleep 5").await;
        let run_id = runner::start(
            &state,
            schedule.target.action_id.unwrap(),
            schedule.target.feature_id.unwrap(),
            TriggeredBy::Schedule,
        )
        .await
        .unwrap();
        assert_eq!(
            wait_for_exit(&state, run_id, Duration::from_millis(10)).await,
            Ok(())
        );
    }
}
