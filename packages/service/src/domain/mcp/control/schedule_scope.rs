//! What the `project_*_schedule` control endpoints share: the caller's scope,
//! the rule that an agent only ever touches schedules delivering into its own
//! conversation, the audit row, and the cue that makes open windows refetch.

use super::audit::{audit_outcome, elapsed_ms, record_tool_audit, ToolAudit};
use super::scope::SessionScope;
use crate::app_state::AppState;
use crate::domain::schedules::models::{Schedule, ScheduleRanEvent, TargetKind};
use crate::domain::schedules::repository;
use crate::error::AppError;

/// The session must run in the conversation it claims to: that conversation is
/// the only one whose schedules it may create or change. Checked inside the
/// audited block, after the session is resolved, so a refused call is still
/// recorded against the session that made it.
pub(super) fn require_conversation(
    source: &SessionScope,
    source_feature_id: i64,
) -> Result<(), AppError> {
    if source.feature_id == source_feature_id {
        Ok(())
    } else {
        Err(AppError::BadRequest(
            "source_session_id does not belong to source_feature_id".into(),
        ))
    }
}

/// A schedule the caller may change: one delivering into its own conversation,
/// whoever created it. Anything else — another conversation's schedule, a
/// new-conversation rule — reads as not found, so an id can't be used to probe
/// or rewrite the user's other schedules.
pub(super) async fn owned_schedule(
    state: &AppState,
    source: &SessionScope,
    schedule_id: i64,
) -> Result<Schedule, AppError> {
    repository::get(&state.write_pool, schedule_id)
        .await?
        .filter(|schedule| {
            schedule.target.kind == TargetKind::Conversation
                && schedule.target.feature_id == Some(source.feature_id)
        })
        .ok_or_else(|| {
            AppError::NotFound(format!(
                "schedule {schedule_id} in this conversation (see project_list_schedules)"
            ))
        })
}

pub(super) async fn audit_schedule_call<T: serde::Serialize>(
    state: &AppState,
    tool_name: &str,
    source: &SessionScope,
    result: &Result<T, AppError>,
    started_at: std::time::Instant,
) -> Result<(), AppError> {
    let (status, error, size) = audit_outcome(result);
    record_tool_audit(
        &state.write_pool,
        ToolAudit {
            server_name: "cadencr-project",
            tool_name,
            source_session_id: Some(source.session_id),
            source_feature_id: Some(source.feature_id),
            source_project_id: Some(source.project_id),
            target_session_id: None,
            target_feature_id: Some(source.feature_id),
            target_project_id: Some(source.project_id),
            status,
            result_size_bytes: size,
            latency_ms: elapsed_ms(started_at),
            error: error.as_deref(),
        },
    )
    .await
}

/// Every open Schedules page and composer banner refetches on this cue —
/// without it, a change the agent made would stay invisible until the user
/// happened to reload.
pub(super) fn notify_schedule_changed(state: &AppState, schedule_id: i64) {
    let _ = state
        .schedule_events_tx
        .send(ScheduleRanEvent { schedule_id });
}

#[cfg(test)]
pub(super) mod test_support {
    use axum::{body::Body, http::Request, http::StatusCode};
    use serde_json::Value;
    use sqlx::SqlitePool;
    use tower::ServiceExt;

    use crate::api::middleware::MCP_CONTROL_HEADER;
    use crate::app_state::AppState;
    use crate::domain::mcp::control::control_router;

    /// One authenticated call to a control endpoint, its body parsed as JSON.
    pub(in crate::domain::mcp::control) async fn post(
        state: AppState,
        path: &str,
        body: Value,
    ) -> (StatusCode, Value) {
        let request = Request::builder()
            .method("POST")
            .uri(path)
            .header(MCP_CONTROL_HEADER, "test-mcp-token")
            .header("content-type", "application/json")
            .body(Body::from(body.to_string()))
            .unwrap();
        let response = control_router()
            .with_state(state)
            .oneshot(request)
            .await
            .unwrap();
        let status = response.status();
        let bytes = axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .unwrap();
        (
            status,
            serde_json::from_slice(&bytes).unwrap_or(Value::Null),
        )
    }

    /// A running session in `feature_id`, to call the tools from.
    pub(in crate::domain::mcp::control) async fn session(
        pool: &SqlitePool,
        feature_id: i64,
    ) -> i64 {
        sqlx::query_scalar(
            "INSERT INTO agent_sessions (feature_id, agent_type, status) VALUES (?, 'session', 'running') RETURNING id",
        )
        .bind(feature_id)
        .fetch_one(pool)
        .await
        .unwrap()
    }
}
