//! `project_update_schedule` / `project_delete_schedule`: the other half of
//! `project_create_schedule`. An agent that scheduled "check the build every
//! 15 minutes" has to be able to move, pause, or drop that rule once the build
//! is fixed — otherwise the only way out is asking the user to find it in the
//! Schedules view.
//!
//! Both go through the same repository calls the Schedules page uses, and both
//! are limited to schedules delivering into the calling conversation.

use axum::{extract::State, Json};
use serde::Deserialize;

use super::schedule_scope::{
    audit_schedule_call, notify_schedule_changed, owned_schedule, require_conversation,
};
use super::scope::resolve_session_scope;
use crate::app_state::AppState;
use crate::domain::schedules::models::{
    RecurrenceInput, SaveScheduleRequest, Schedule, ScheduleCondition, ScheduleDeleted,
};
use crate::domain::schedules::repository;
use crate::error::AppError;

/// A patch: every absent field keeps the stored value.
#[derive(Debug, Deserialize)]
pub(super) struct UpdateScheduleRequest {
    source_feature_id: i64,
    source_session_id: i64,
    schedule_id: i64,
    name: Option<String>,
    prompt: Option<String>,
    recurrence: Option<RecurrenceInput>,
    condition: Option<ScheduleCondition>,
    #[serde(default)]
    remove_condition: bool,
    enabled: Option<bool>,
    /// An empty string clears the pin back to the conversation's own setting.
    model: Option<String>,
    thinking_level: Option<String>,
    permission_mode: Option<String>,
}

#[derive(Debug, Deserialize)]
pub(super) struct DeleteScheduleRequest {
    source_feature_id: i64,
    source_session_id: i64,
    schedule_id: i64,
}

pub(super) async fn update_schedule_handler(
    State(state): State<AppState>,
    Json(body): Json<UpdateScheduleRequest>,
) -> Result<Json<Schedule>, AppError> {
    let started_at = std::time::Instant::now();
    let source = resolve_session_scope(&state.write_pool, body.source_session_id).await?;
    let result = async {
        require_conversation(&source, body.source_feature_id)?;
        let current = owned_schedule(&state, &source, body.schedule_id).await?;
        apply_update(&state, current, body).await
    }
    .await;
    if let Ok(schedule) = &result {
        notify_schedule_changed(&state, schedule.id);
    }
    audit_schedule_call(
        &state,
        "project_update_schedule",
        &source,
        &result,
        started_at,
    )
    .await?;
    result.map(Json)
}

pub(super) async fn delete_schedule_handler(
    State(state): State<AppState>,
    Json(body): Json<DeleteScheduleRequest>,
) -> Result<Json<ScheduleDeleted>, AppError> {
    let started_at = std::time::Instant::now();
    let source = resolve_session_scope(&state.write_pool, body.source_session_id).await?;
    let result = async {
        require_conversation(&source, body.source_feature_id)?;
        owned_schedule(&state, &source, body.schedule_id).await?;
        let deleted = repository::delete(&state.write_pool, body.schedule_id).await?;
        Ok(ScheduleDeleted { deleted })
    }
    .await;
    if let Ok(ScheduleDeleted { deleted: true }) = &result {
        notify_schedule_changed(&state, body.schedule_id);
    }
    audit_schedule_call(
        &state,
        "project_delete_schedule",
        &source,
        &result,
        started_at,
    )
    .await?;
    result.map(Json)
}

/// A new rule is planned from now like any save; without one the schedule
/// keeps its place in time.
async fn apply_update(
    state: &AppState,
    current: Schedule,
    body: UpdateScheduleRequest,
) -> Result<Schedule, AppError> {
    if body.condition.is_some() && body.remove_condition {
        return Err(AppError::BadRequest(
            "pass either condition or remove_condition, not both".into(),
        ));
    }
    let replans = body.recurrence.is_some();
    let request = merged_request(&current, body);
    if replans {
        repository::update(&state.write_pool, current.id, request).await
    } else {
        repository::update_in_place(&state.write_pool, &current, request).await
    }
}

/// The stored schedule with the patch laid over it, in the shape the
/// Schedules editor saves — so the usual validation applies to the result.
/// The save path trims and drops an empty name or pin, so `""` clears it.
fn merged_request(current: &Schedule, body: UpdateScheduleRequest) -> SaveScheduleRequest {
    let recurrence = match body.recurrence {
        Some(mut recurrence) => {
            recurrence
                .timezone
                .get_or_insert_with(|| current.recurrence.timezone.clone());
            recurrence
        }
        None => stored_recurrence(current),
    };
    let mut target = current.target.clone();
    target.model = body.model.or(target.model);
    target.thinking_level = body.thinking_level.or(target.thinking_level);
    target.permission_mode = body.permission_mode.or(target.permission_mode);
    let condition = if body.remove_condition {
        None
    } else {
        body.condition.or_else(|| current.condition.clone())
    };
    SaveScheduleRequest {
        name: body.name.or_else(|| current.name.clone()),
        prompt: body.prompt.unwrap_or_else(|| current.prompt.clone()),
        target,
        recurrence,
        condition,
        enabled: body.enabled,
    }
}

/// The stored rule as a save payload. A one-off's instant is `next_run_at`,
/// which `update_in_place` keeps on its own.
fn stored_recurrence(current: &Schedule) -> RecurrenceInput {
    let rule = &current.recurrence;
    RecurrenceInput {
        kind: rule.kind,
        run_at: None,
        interval_seconds: rule.interval_seconds,
        time_of_day: rule.time_of_day.clone(),
        weekdays: rule.weekdays.clone(),
        day_of_month: rule.day_of_month,
        timezone: Some(rule.timezone.clone()),
    }
}

#[cfg(test)]
mod tests {
    use axum::http::StatusCode;
    use serde_json::{json, Value};
    use sqlx::SqlitePool;

    use super::super::schedule_scope::test_support::{post, session};
    use crate::app_state::AppState;
    use crate::domain::schedules::models::ScheduleCondition;
    use crate::domain::schedules::repository::test_support::{fixture, once_into_conversation};
    use crate::domain::schedules::repository::{get, insert};

    const UPDATE: &str = "/internal/mcp/project/update-schedule";
    const DELETE: &str = "/internal/mcp/project/delete-schedule";

    /// A conversation with one running session and one command-gated,
    /// model-pinned one-off schedule delivering into it.
    struct Scheduled {
        pool: SqlitePool,
        project_id: i64,
        feature_id: i64,
        session_id: i64,
        schedule_id: i64,
    }

    impl Scheduled {
        async fn new() -> Self {
            let (pool, project_id, feature_id) = fixture().await;
            let session_id = session(&pool, feature_id).await;
            let mut body = once_into_conversation(feature_id, "2099-01-01T09:00:00Z");
            body.condition = Some(ScheduleCondition {
                command: "pnpm test".into(),
                timeout_seconds: Some(60),
            });
            body.target.model = Some("haiku".into());
            let schedule_id = insert(&pool, body).await.unwrap().id;
            Self {
                pool,
                project_id,
                feature_id,
                session_id,
                schedule_id,
            }
        }

        fn call(&self, patch: Value) -> Value {
            let mut body = json!({
                "source_feature_id": self.feature_id,
                "source_session_id": self.session_id,
                "schedule_id": self.schedule_id,
            });
            body.as_object_mut()
                .unwrap()
                .extend(patch.as_object().unwrap().clone());
            body
        }

        async fn timezone(&self) -> String {
            get(&self.pool, self.schedule_id)
                .await
                .unwrap()
                .unwrap()
                .recurrence
                .timezone
        }

        async fn audited(&self, tool: &str, status: &str) -> i64 {
            sqlx::query_scalar(
                "SELECT COUNT(*) FROM mcp_tool_audit_log WHERE tool_name = ? AND status = ?",
            )
            .bind(tool)
            .bind(status)
            .fetch_one(&self.pool)
            .await
            .unwrap()
        }
    }

    #[tokio::test]
    async fn an_update_changes_only_what_the_agent_passed() {
        let scheduled = Scheduled::new().await;
        let state = AppState::with_pool(scheduled.pool.clone());
        let mut events = state.schedule_events_tx.subscribe();

        let (status, body) = post(
            state,
            UPDATE,
            scheduled.call(json!({ "prompt": "The suite broke again. Fix it." })),
        )
        .await;

        assert_eq!(status, StatusCode::OK, "{body}");
        assert_eq!(body["prompt"], "The suite broke again. Fix it.");
        assert_eq!(body["condition"]["command"], "pnpm test");
        assert_eq!(body["target"]["model"], "haiku");
        assert_eq!(body["recurrence"]["kind"], "once");
        assert_eq!(body["next_run_at"], "2099-01-01T09:00:00Z");
        assert_eq!(
            events.try_recv().unwrap().schedule_id,
            scheduled.schedule_id
        );
        assert_eq!(scheduled.audited("project_update_schedule", "ok").await, 1);
    }

    #[tokio::test]
    async fn an_update_replaces_the_rule_and_clears_the_condition_and_pins() {
        let scheduled = Scheduled::new().await;
        let (status, body) = post(
            AppState::with_pool(scheduled.pool.clone()),
            UPDATE,
            scheduled.call(json!({
                "recurrence": { "kind": "interval", "interval_seconds": 1800 },
                "remove_condition": true,
                "model": ""
            })),
        )
        .await;

        assert_eq!(status, StatusCode::OK, "{body}");
        assert_eq!(body["recurrence"]["kind"], "interval");
        assert_eq!(body["recurrence"]["interval_seconds"], 1800);
        // A new rule without a timezone stays in the zone the old one used.
        assert_eq!(body["recurrence"]["timezone"], scheduled.timezone().await);
        assert!(body.get("condition").is_none(), "{body}");
        assert!(body["target"].get("model").is_none(), "{body}");
    }

    #[tokio::test]
    async fn enabled_alone_pauses_and_resumes_without_touching_the_rule() {
        let scheduled = Scheduled::new().await;
        let state = AppState::with_pool(scheduled.pool.clone());

        let (_, paused) = post(
            state.clone(),
            UPDATE,
            scheduled.call(json!({ "enabled": false })),
        )
        .await;
        assert_eq!(paused["enabled"], false);
        assert_eq!(paused["next_run_at"], "2099-01-01T09:00:00Z");

        let (_, resumed) = post(state, UPDATE, scheduled.call(json!({ "enabled": true }))).await;
        assert_eq!(resumed["enabled"], true);
        assert_eq!(resumed["condition"]["command"], "pnpm test");
    }

    #[tokio::test]
    async fn a_contradictory_or_mistyped_patch_is_refused() {
        let scheduled = Scheduled::new().await;
        let state = AppState::with_pool(scheduled.pool.clone());
        let (status, _) = post(
            state.clone(),
            UPDATE,
            scheduled.call(json!({
                "condition": { "command": "true" },
                "remove_condition": true
            })),
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
        assert_eq!(
            scheduled.audited("project_update_schedule", "error").await,
            1
        );

        // Read as "keep the stored value", a mistyped field would report
        // success while dropping the change.
        let (status, _) = post(
            state,
            UPDATE,
            scheduled.call(json!({ "prompt": "new", "enabled": "false" })),
        )
        .await;
        assert!(status.is_client_error(), "{status}");
        let stored = get(&scheduled.pool, scheduled.schedule_id)
            .await
            .unwrap()
            .unwrap();
        assert_ne!(stored.prompt, "new");
    }

    #[tokio::test]
    async fn editing_an_interval_schedule_keeps_its_next_run() {
        let scheduled = Scheduled::new().await;
        let state = AppState::with_pool(scheduled.pool.clone());
        let (status, _) = post(
            state.clone(),
            UPDATE,
            scheduled.call(json!({
                "recurrence": { "kind": "interval", "interval_seconds": 3600 }
            })),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        // As if it were due sooner than a full interval from now.
        sqlx::query("UPDATE schedules SET next_run_at = '2099-01-01 08:00:00' WHERE id = ?")
            .bind(scheduled.schedule_id)
            .execute(&scheduled.pool)
            .await
            .unwrap();

        let (status, body) = post(state, UPDATE, scheduled.call(json!({ "prompt": "v2" }))).await;

        assert_eq!(status, StatusCode::OK, "{body}");
        assert_eq!(body["prompt"], "v2");
        assert_eq!(body["next_run_at"], "2099-01-01T08:00:00Z");
        // Kept in the form the poll loop compares against.
        let stored: String = sqlx::query_scalar("SELECT next_run_at FROM schedules WHERE id = ?")
            .bind(scheduled.schedule_id)
            .fetch_one(&scheduled.pool)
            .await
            .unwrap();
        assert_eq!(stored, "2099-01-01 08:00:00");
    }

    #[tokio::test]
    async fn a_one_off_that_already_ran_stays_done_until_given_a_new_rule() {
        let scheduled = Scheduled::new().await;
        sqlx::query("UPDATE schedules SET next_run_at = NULL WHERE id = ?")
            .bind(scheduled.schedule_id)
            .execute(&scheduled.pool)
            .await
            .unwrap();
        let state = AppState::with_pool(scheduled.pool.clone());

        let (status, body) = post(
            state.clone(),
            UPDATE,
            scheduled.call(json!({ "prompt": "again" })),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{body}");
        assert_eq!(body["completed"], true);

        let (status, body) = post(
            state,
            UPDATE,
            scheduled.call(json!({
                "recurrence": { "kind": "once", "run_at": "2099-06-01T09:00:00Z" }
            })),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{body}");
        assert_eq!(body["completed"], false);
        assert_eq!(body["next_run_at"], "2099-06-01T09:00:00Z");
    }

    #[tokio::test]
    async fn a_delete_removes_the_schedule_and_tells_open_windows() {
        let scheduled = Scheduled::new().await;
        let state = AppState::with_pool(scheduled.pool.clone());
        let mut events = state.schedule_events_tx.subscribe();

        let (status, body) = post(state, DELETE, scheduled.call(json!({}))).await;

        assert_eq!(status, StatusCode::OK, "{body}");
        assert_eq!(body, json!({ "deleted": true }));
        assert!(get(&scheduled.pool, scheduled.schedule_id)
            .await
            .unwrap()
            .is_none());
        assert_eq!(
            events.try_recv().unwrap().schedule_id,
            scheduled.schedule_id
        );
        assert_eq!(scheduled.audited("project_delete_schedule", "ok").await, 1);
    }

    // An agent only manages schedules delivering into its own conversation: a
    // session elsewhere in the project can neither change nor delete this one.
    #[tokio::test]
    async fn another_conversation_cannot_touch_the_schedule() {
        let scheduled = Scheduled::new().await;
        let other_feature: i64 = sqlx::query_scalar(
            "INSERT INTO features (project_id, title) VALUES (?, 'Other') RETURNING id",
        )
        .bind(scheduled.project_id)
        .fetch_one(&scheduled.pool)
        .await
        .unwrap();
        let other_session = session(&scheduled.pool, other_feature).await;
        let state = AppState::with_pool(scheduled.pool.clone());
        let foreign = |patch: Value| {
            let mut body = scheduled.call(patch);
            body["source_feature_id"] = json!(other_feature);
            body["source_session_id"] = json!(other_session);
            body
        };

        let (status, _) = post(state.clone(), UPDATE, foreign(json!({ "enabled": false }))).await;
        assert_eq!(status, StatusCode::NOT_FOUND);
        let (status, _) = post(state.clone(), DELETE, foreign(json!({}))).await;
        assert_eq!(status, StatusCode::NOT_FOUND);
        // Nor by claiming the right conversation with its own session.
        let mut spoofed = foreign(json!({}));
        spoofed["source_feature_id"] = json!(scheduled.feature_id);
        let (status, _) = post(state, DELETE, spoofed).await;
        assert_eq!(status, StatusCode::BAD_REQUEST);

        let survivor = get(&scheduled.pool, scheduled.schedule_id)
            .await
            .unwrap()
            .unwrap();
        assert!(survivor.enabled);
        assert_eq!(
            scheduled.audited("project_delete_schedule", "error").await,
            2
        );
    }
}
