//! The startup pass: resume what the last exit interrupted, then report it.

use crate::app_state::AppState;
use crate::domain::workspace::repository::setting_enabled_by_default;

use super::capture::{app_version, startup_capture_error};
use super::eligibility::{decide, live_skip, Candidate, Decision, LOOP_WINDOW_MINUTES};
use super::report::{
    boot_id, publish, RestartContinuationEntry, RestartContinuationOutcome,
    RestartContinuationReport,
};
use super::store::{self, PendingContinuation, Resolution};
use super::{gates, message, ENABLED_SETTING_KEY};

/// Reason on a resumed entry whose agent was waiting on the user: its
/// question died with the old process and it will ask again.
const LOST_GATE: &str = "lost_gate";

/// Run the pass in the background once the listener is up: resumed agents
/// call back into the service (MCP tools, permission prompts) right away.
pub fn spawn_startup_pass(state: AppState) {
    tokio::spawn(async move {
        let report = run(&state).await;
        publish(report);
    });
}

async fn run(state: &AppState) -> RestartContinuationReport {
    let mut report = RestartContinuationReport {
        boot_id: boot_id(),
        app_version: app_version().to_string(),
        previous_version: None,
        entries: Vec::new(),
        error: startup_capture_error(),
    };
    let pending = match store::list_pending(&state.write_pool).await {
        Ok(pending) => pending,
        Err(error) => {
            tracing::error!(%error, "failed to read interrupted agent turns");
            report.error = Some(format!(
                "Cadencr could not read which agents the restart interrupted: {error}"
            ));
            return report;
        }
    };
    report.previous_version = previous_version(&pending, &report.app_version);
    let enabled = setting_enabled_by_default(&state.read_pool, ENABLED_SETTING_KEY).await;
    let resolutions = futures::future::join_all(
        pending
            .iter()
            .map(|continuation| resolve_one(state, continuation, enabled)),
    )
    .await;
    report.entries = pending
        .iter()
        .zip(resolutions)
        .map(
            |(continuation, (outcome, reason))| RestartContinuationEntry {
                session_id: continuation.session_id,
                feature_id: continuation.feature_id,
                project_id: continuation.project_id,
                feature_title: continuation.feature_title.clone(),
                outcome,
                reason,
            },
        )
        .collect();
    report
}

/// The version the interrupted turns ran under, when it is not this one.
/// Crash captures carry none (the dead process could not say).
fn previous_version(pending: &[PendingContinuation], current: &str) -> Option<String> {
    pending
        .iter()
        .filter_map(|continuation| continuation.app_version.as_deref())
        .find(|version| *version != current)
        .map(str::to_string)
}

/// Mark the transcript, apply the guards, resume if allowed, and record the
/// outcome. Every failure becomes the entry's outcome: the report is how the
/// user learns about it.
async fn resolve_one(
    state: &AppState,
    continuation: &PendingContinuation,
    enabled: bool,
) -> (RestartContinuationOutcome, Option<String>) {
    let (outcome, reason) = match prepare(state, continuation, enabled).await {
        Ok((Decision::Skip(reason), _)) => {
            record(
                state,
                continuation.id,
                Resolution::Skipped,
                Some(reason.code().to_string()),
            )
            .await
        }
        Ok((Decision::Resume, lost_gate)) => resume(state, continuation, lost_gate).await,
        Err(error) => record(state, continuation.id, Resolution::Failed, Some(error)).await,
    };
    if outcome == RestartContinuationOutcome::Failed {
        tracing::warn!(
            session_id = continuation.session_id,
            reason = reason.as_deref().unwrap_or(""),
            "could not resume an agent turn interrupted by a restart"
        );
    }
    (outcome, reason)
}

/// Recorded as resumed before the prompt goes out: a service that stops while
/// sending it leaves the session `running`, so the next start captures that
/// turn anew (and a crash counts toward the loop guard) instead of re-sending
/// from a row whose transcript it already marked.
async fn resume(
    state: &AppState,
    continuation: &PendingContinuation,
    lost_gate: bool,
) -> (RestartContinuationOutcome, Option<String>) {
    let reason = lost_gate.then(|| LOST_GATE.to_string());
    if let Err(error) = store::resolve(
        &state.write_pool,
        continuation.id,
        Resolution::Resumed,
        reason.as_deref(),
    )
    .await
    {
        return (
            RestartContinuationOutcome::Failed,
            Some(format!("its resume could not be recorded: {error}")),
        );
    }
    let delivered = message::deliver(
        state,
        continuation.feature_id,
        continuation.session_id,
        continuation.id,
    )
    .await;
    let Err(error) = delivered else {
        return (RestartContinuationOutcome::Resumed, reason);
    };
    let reason = error.to_string();
    let reason = match store::fail_resumed(&state.write_pool, continuation.id, &reason).await {
        Ok(()) => reason,
        Err(error) => format!("{reason}; its outcome could not be saved: {error}"),
    };
    (RestartContinuationOutcome::Failed, Some(reason))
}

/// Save a skip or failure, adding to the reason when that write fails too.
async fn record(
    state: &AppState,
    id: i64,
    resolution: Resolution,
    reason: Option<String>,
) -> (RestartContinuationOutcome, Option<String>) {
    let outcome = match resolution {
        Resolution::Resumed => RestartContinuationOutcome::Resumed,
        Resolution::Skipped => RestartContinuationOutcome::Skipped,
        Resolution::Failed => RestartContinuationOutcome::Failed,
    };
    match store::resolve(&state.write_pool, id, resolution, reason.as_deref()).await {
        Ok(()) => (outcome, reason),
        Err(error) => {
            let detail = format!("its outcome could not be saved: {error}");
            let reason = match reason {
                Some(reason) => format!("{reason}; {detail}"),
                None => detail,
            };
            (outcome, Some(reason))
        }
    }
}

/// Re-check the session, mark the transcript and clear the dead gate, then
/// apply the guards. Returns the decision and whether the agent had been
/// waiting on the user.
async fn prepare(
    state: &AppState,
    continuation: &PendingContinuation,
    enabled: bool,
) -> Result<(Decision, bool), String> {
    let status = store::session_status(&state.write_pool, continuation.session_id)
        .await
        .map_err(|error| format!("could not read the conversation's status: {error}"))?;
    if let Some(skip) = live_skip(&status) {
        return Ok((Decision::Skip(skip), false));
    }
    store::write_marker(&state.write_pool, continuation)
        .await
        .map_err(|error| format!("could not mark the interrupted turn: {error}"))?;
    let lost_gate = gates::clear_dead_gate(state, continuation.session_id, continuation.feature_id)
        .await
        .map_err(|error| format!("could not clear the question it was waiting on: {error}"))?;
    let recent_crashes = store::recent_crashes(
        &state.write_pool,
        continuation.session_id,
        LOOP_WINDOW_MINUTES,
    )
    .await
    .map_err(|error| format!("could not read earlier crashes: {error}"))?;
    let decision = decide(&Candidate {
        stop_requested: continuation.stop_requested(),
        enabled,
        feature_archived: continuation.feature_archived,
        has_resume_id: continuation.has_resume_id,
        recent_crashes,
    });
    Ok((decision, lost_gate))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::restart_continuations::store::{
        capture_running, tests::session, Cause, Intent,
    };
    use crate::domain::schedules::repository::test_support::fixture;

    #[tokio::test]
    async fn a_gated_turn_loses_its_dead_gate_and_is_marked() {
        let (pool, _, feature_id) = fixture().await;
        let session_id = session(&pool, feature_id, "running").await;
        sqlx::query(
            r#"UPDATE agent_sessions SET pending_questions =
               '{"request_id":"q-1","tool_name":"AskUserQuestion","tool_input":{}}' WHERE id = ?"#,
        )
        .bind(session_id)
        .execute(&pool)
        .await
        .unwrap();
        capture_running(&pool, Cause::Shutdown, Intent::Resume, Some("0.9.0"))
            .await
            .unwrap();
        sqlx::query("UPDATE agent_sessions SET status = 'paused'")
            .execute(&pool)
            .await
            .unwrap();

        let report = run(&AppState::with_pool(pool.clone())).await;

        assert_eq!(report.previous_version.as_deref(), Some("0.9.0"));
        assert_eq!(report.entries.len(), 1);
        let entry = &report.entries[0];
        assert_eq!(entry.session_id, session_id);
        assert_eq!(entry.feature_title, "Conversation");
        // No provider in tests, so the resume itself fails; the gate is gone.
        assert_eq!(entry.outcome, RestartContinuationOutcome::Failed);
        let pending: Option<String> =
            sqlx::query_scalar("SELECT pending_questions FROM agent_sessions WHERE id = ?")
                .bind(session_id)
                .fetch_one(&pool)
                .await
                .unwrap();
        assert!(pending.is_none());
        assert!(store::list_pending(&pool).await.unwrap().is_empty());
        let markers: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM agent_messages
             WHERE session_id = ? AND message_type = 'turn_interrupted'",
        )
        .bind(session_id)
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(markers, 1);
    }

    #[tokio::test]
    async fn a_turn_stopped_on_quit_is_closed_but_not_resumed() {
        let (pool, _, feature_id) = fixture().await;
        let session_id = session(&pool, feature_id, "running").await;
        capture_running(&pool, Cause::Shutdown, Intent::Stop, Some("1.0.0"))
            .await
            .unwrap();
        sqlx::query("UPDATE agent_sessions SET status = 'paused'")
            .execute(&pool)
            .await
            .unwrap();

        let report = run(&AppState::with_pool(pool.clone())).await;

        assert_eq!(report.entries.len(), 1);
        assert_eq!(
            report.entries[0].outcome,
            RestartContinuationOutcome::Skipped
        );
        assert_eq!(report.entries[0].reason.as_deref(), Some("stopped_on_quit"));
        let marker: String = sqlx::query_scalar(
            "SELECT content FROM agent_messages
             WHERE session_id = ? AND message_type = 'turn_interrupted'",
        )
        .bind(session_id)
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(
            marker,
            crate::domain::restart_continuations::QUIT_MARKER_CONTENT
        );
        let prompts: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM agent_messages
             WHERE session_id = ? AND message_type = 'user_message'",
        )
        .bind(session_id)
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(prompts, 0, "no continue prompt is sent");
    }

    #[tokio::test]
    async fn a_turn_that_moved_on_since_its_capture_keeps_its_transcript() {
        let (pool, _, feature_id) = fixture().await;
        let finished = session(&pool, feature_id, "running").await;
        let restarted = session(&pool, feature_id, "running").await;
        capture_running(&pool, Cause::Shutdown, Intent::Resume, Some("1.0.0"))
            .await
            .unwrap();
        // One finished during the shutdown drain; something already started
        // a new turn in the other before the pass reached it.
        sqlx::query("UPDATE agent_sessions SET status = 'completed' WHERE id = ?")
            .bind(finished)
            .execute(&pool)
            .await
            .unwrap();

        let report = run(&AppState::with_pool(pool.clone())).await;

        let reasons: Vec<_> = report
            .entries
            .iter()
            .map(|entry| (entry.session_id, entry.outcome, entry.reason.clone()))
            .collect();
        assert_eq!(
            reasons,
            vec![
                (
                    finished,
                    RestartContinuationOutcome::Skipped,
                    Some("finished".into())
                ),
                (
                    restarted,
                    RestartContinuationOutcome::Skipped,
                    Some("already_running".into())
                ),
            ]
        );
        let markers: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM agent_messages WHERE message_type = 'turn_interrupted'",
        )
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(markers, 0);
    }

    #[tokio::test]
    async fn nothing_interrupted_means_an_empty_report() {
        let (pool, _, _) = fixture().await;
        let report = run(&AppState::with_pool(pool)).await;
        assert!(report.is_empty());
    }

    #[test]
    fn only_a_different_version_counts_as_the_previous_one() {
        let continuation = |version: Option<&str>| PendingContinuation {
            id: 1,
            session_id: 1,
            app_version: version.map(str::to_string),
            intent: "resume".into(),
            marker_message_id: None,
            feature_id: 1,
            project_id: 1,
            feature_title: String::new(),
            feature_archived: false,
            has_resume_id: true,
        };
        assert_eq!(
            previous_version(&[continuation(Some("1.0.0"))], "1.0.0"),
            None
        );
        assert_eq!(previous_version(&[continuation(None)], "1.0.0"), None);
        assert_eq!(
            previous_version(&[continuation(None), continuation(Some("0.9.0"))], "1.0.0")
                .as_deref(),
            Some("0.9.0")
        );
    }
}
