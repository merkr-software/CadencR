//! `project_create_schedule`: an agent schedules a prompt into its own
//! conversation — optionally gated on a command it writes itself ("every 30
//! minutes, run the e2e suite; if it fails, fix it").
//!
//! The schedule is the same object the Schedules page edits: it goes through
//! the same save validation, shows up in the same lists, and can be paused or
//! deleted by the user like any other. The only thing an agent cannot choose is
//! the target — it is always the calling conversation, never another one.

use axum::{extract::State, Json};
use serde::Deserialize;

use super::schedule_scope::{audit_schedule_call, notify_schedule_changed, require_conversation};
use super::scope::{resolve_session_scope, SessionScope};
use crate::app_state::AppState;
use crate::domain::schedules::local_zone::local_timezone;
use crate::domain::schedules::models::{
    RecurrenceInput, SaveScheduleRequest, Schedule, ScheduleCondition, ScheduleTarget, TargetKind,
};
use crate::domain::schedules::repository;
use crate::error::AppError;

const TOOL_NAME: &str = "project_create_schedule";

#[derive(Debug, Deserialize)]
pub(super) struct CreateScheduleRequest {
    source_feature_id: i64,
    source_session_id: i64,
    name: Option<String>,
    prompt: String,
    recurrence: RecurrenceInput,
    condition: Option<ScheduleCondition>,
    model: Option<String>,
    thinking_level: Option<String>,
    permission_mode: Option<String>,
}

pub(super) async fn create_schedule_handler(
    State(state): State<AppState>,
    Json(body): Json<CreateScheduleRequest>,
) -> Result<Json<Schedule>, AppError> {
    let started_at = std::time::Instant::now();
    let source = resolve_session_scope(&state.write_pool, body.source_session_id).await?;
    let result = async {
        require_conversation(&source, body.source_feature_id)?;
        repository::insert(&state.write_pool, save_request(&source, body)).await
    }
    .await;
    if let Ok(schedule) = &result {
        notify_schedule_changed(&state, schedule.id);
    }
    audit_schedule_call(&state, TOOL_NAME, &source, &result, started_at).await?;
    result.map(Json)
}

/// The target is pinned to the caller's conversation; everything else is the
/// agent's choice, validated by the ordinary save path.
fn save_request(source: &SessionScope, body: CreateScheduleRequest) -> SaveScheduleRequest {
    let mut recurrence = body.recurrence;
    recurrence.timezone.get_or_insert_with(local_timezone);
    SaveScheduleRequest {
        name: body.name,
        prompt: body.prompt,
        target: ScheduleTarget {
            kind: TargetKind::Conversation,
            feature_id: Some(source.feature_id),
            action_id: None,
            project_id: None,
            provider: None,
            model: body.model,
            thinking_level: body.thinking_level,
            permission_mode: body.permission_mode,
            access_mode: None,
            profile: None,
            worktree_mode: None,
            reuse_branch: None,
            base_branch: None,
        },
        recurrence,
        condition: body.condition,
        enabled: Some(true),
    }
}

#[cfg(test)]
mod tests {
    use axum::http::StatusCode;
    use serde_json::{json, Value};

    use super::super::schedule_scope::test_support::{post, session};
    use crate::app_state::AppState;
    use crate::domain::schedules::repository::test_support::fixture;

    async fn create(state: AppState, body: Value) -> (StatusCode, Value) {
        post(state, "/internal/mcp/project/create-schedule", body).await
    }

    #[tokio::test]
    async fn an_agent_schedules_a_command_gated_prompt_into_its_own_conversation() {
        let (pool, _, feature_id) = fixture().await;
        let session_id = session(&pool, feature_id).await;
        let state = AppState::with_pool(pool.clone());
        let mut events = state.schedule_events_tx.subscribe();

        let (status, body) = create(
            state,
            json!({
                "source_feature_id": feature_id,
                "source_session_id": session_id,
                "name": "Keep tests green",
                "prompt": "The test suite is failing again. Fix it.",
                "recurrence": { "kind": "interval", "interval_seconds": 900 },
                "condition": { "command": "cargo test", "timeout_seconds": 120 },
            }),
        )
        .await;

        assert_eq!(status, StatusCode::OK, "{body}");
        assert_eq!(body["target"]["kind"], "conversation");
        assert_eq!(body["target"]["feature_id"], feature_id);
        assert_eq!(body["condition"]["command"], "cargo test");
        assert_eq!(body["condition"]["timeout_seconds"], 120);
        assert_eq!(body["recurrence"]["interval_seconds"], 900);
        assert!(body["recurrence"]["timezone"].is_string());
        assert_eq!(body["enabled"], true);
        assert_eq!(events.try_recv().unwrap().schedule_id, body["id"]);

        let audited: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM mcp_tool_audit_log WHERE tool_name = 'project_create_schedule' AND status = 'ok'",
        )
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(audited, 1);
    }

    // The target is the caller's conversation, so a session id from another
    // conversation can't be used to plant a schedule there.
    #[tokio::test]
    async fn a_session_outside_the_calling_conversation_is_refused() {
        let (pool, project_id, feature_id) = fixture().await;
        let other_feature: i64 = sqlx::query_scalar(
            "INSERT INTO features (project_id, title) VALUES (?, 'Other') RETURNING id",
        )
        .bind(project_id)
        .fetch_one(&pool)
        .await
        .unwrap();
        let foreign_session = session(&pool, other_feature).await;

        let (status, _) = create(
            AppState::with_pool(pool.clone()),
            json!({
                "source_feature_id": feature_id,
                "source_session_id": foreign_session,
                "prompt": "p",
                "recurrence": { "kind": "interval", "interval_seconds": 900 },
            }),
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
        let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM schedules")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(count, 0);
    }

    #[tokio::test]
    async fn an_invalid_rule_is_reported_with_the_save_path_message() {
        let (pool, _, feature_id) = fixture().await;
        let session_id = session(&pool, feature_id).await;
        let (status, body) = create(
            AppState::with_pool(pool),
            json!({
                "source_feature_id": feature_id,
                "source_session_id": session_id,
                "prompt": "p",
                "recurrence": { "kind": "interval", "interval_seconds": 5 },
            }),
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
        assert!(body["error"]
            .as_str()
            .unwrap()
            .contains("shortest supported interval"));
    }
}
