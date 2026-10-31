use axum::{extract::State, Json};
use serde::{Deserialize, Serialize};

use super::audit::{elapsed_ms, record_tool_audit, result_size_bytes, ToolAudit};
use super::scope::resolve_session_scope;
use super::spawn_follow::{SpawnFollowOptions, SpawnFollowResponse};
use super::spawn_persist::{insert_initial_message, insert_spawn_link, insert_spawned_session};
use super::spawn_resolve::{
    branch_worktree_settings, codex_permission_mode_for_spawn, resolve_spawn_runtime,
    resolve_target_project, SpawnBranch, TargetProject,
};
use crate::app_state::AppState;
use crate::domain::feature_events::FeatureEventAction;
use crate::domain::features::models::FeatureStatus;
use crate::domain::features::service::{create_feature_with_worktree, update_status};
use crate::domain::ws_session::runtime::application::dispatch_control_prompt;
use crate::domain::ws_session::runtime::prompt::publish_user_message;
use crate::error::AppError;

#[derive(Debug, Deserialize)]
pub(super) struct SpawnSessionRequest {
    pub(super) source_feature_id: i64,
    pub(super) source_session_id: i64,
    pub(super) title: Option<String>,
    pub(super) initial_message: Option<String>,
    pub(super) branch: Option<SpawnBranch>,
    pub(super) provider: Option<String>,
    pub(super) model: Option<String>,
    pub(super) thinking_level: Option<String>,
    pub(super) profile: Option<String>,
    pub(super) permission_mode: Option<String>,
    pub(super) codex_permission_mode: Option<String>,
    pub(super) source_note: Option<String>,
    pub(super) follow: Option<SpawnFollowOptions>,
    pub(super) link_to_current_session: Option<bool>,
    pub(super) await_result: Option<bool>,
    pub(super) target_project_id: Option<i64>,
    pub(super) target_project_path: Option<String>,
    /// Born archived: a temporary conversation (a side question) that stays
    /// out of the sidebar until the user keeps it. Never set over the wire.
    #[serde(skip)]
    pub(super) start_archived: bool,
}

#[derive(Debug, Serialize)]
pub(super) struct SpawnSessionResponse {
    #[serde(rename = "featureId")]
    pub(super) feature_id: i64,
    #[serde(rename = "sessionId")]
    pub(super) session_id: i64,
    #[serde(rename = "messageId", skip_serializing_if = "Option::is_none")]
    message_id: Option<i64>,
    project: TargetProject,
    #[serde(rename = "crossProject")]
    cross_project: bool,
    #[serde(rename = "dispatchError", skip_serializing_if = "Option::is_none")]
    pub(super) dispatch_error: Option<String>,
    follow: SpawnFollowResponse,
}

pub(super) async fn spawn_session_handler(
    State(state): State<AppState>,
    Json(body): Json<SpawnSessionRequest>,
) -> Result<Json<SpawnSessionResponse>, AppError> {
    let started_at = std::time::Instant::now();
    let source = resolve_session_scope(&state.write_pool, body.source_session_id).await?;
    if source.feature_id != body.source_feature_id {
        let message = "source_session_id does not belong to source_feature_id".to_string();
        // Target not resolved yet; attribute to the requested id when one was supplied.
        audit_spawn_error(
            &state,
            &source,
            body.target_project_id,
            &message,
            started_at,
        )
        .await?;
        return Err(AppError::BadRequest(message));
    }

    let target_project = match resolve_target_project(
        &state.write_pool,
        source.project_id,
        body.target_project_id,
        body.target_project_path.as_deref(),
    )
    .await
    {
        Ok(project) => project,
        Err(error) => {
            audit_spawn_error(
                &state,
                &source,
                body.target_project_id,
                &error.to_string(),
                started_at,
            )
            .await?;
            return Err(error);
        }
    };

    // Everything past target resolution is audited against the resolved target, so the
    // pipeline uses `?` and a single failure-audit site instead of repeating the dance.
    match spawn_into_target(&state, &source, &target_project, &body, started_at).await {
        Ok(response) => Ok(Json(response)),
        Err(error) => {
            audit_spawn_error(
                &state,
                &source,
                Some(target_project.id),
                &error.to_string(),
                started_at,
            )
            .await?;
            Err(error)
        }
    }
}

/// Runs the fallible spawn pipeline once a target project is resolved, recording the
/// success audit itself. Any error bubbles to the caller, which audits it against the
/// resolved target project.
async fn spawn_into_target(
    state: &AppState,
    source: &super::scope::SessionScope,
    target_project: &TargetProject,
    body: &SpawnSessionRequest,
    started_at: std::time::Instant,
) -> Result<SpawnSessionResponse, AppError> {
    validate_follow_result(body)?;
    let (worktree_mode, reuse_branch, base_branch) =
        branch_worktree_settings(body.branch.as_ref())?;
    let runtime = resolve_spawn_runtime(state, source, target_project, body).await?;
    let codex_permission_mode = codex_permission_mode_for_spawn(state, &runtime, body).await?;
    let created = create_feature_with_worktree(
        &state.write_pool,
        target_project.id,
        super::trimmed_optional(body.title.as_deref()),
        Some("ws-session".to_string()),
        Some(worktree_mode),
        reuse_branch,
        base_branch,
    )
    .await?;
    // Archived before anything announces the feature, so no sidebar ever
    // lists it in between.
    if body.start_archived {
        update_status(&state.write_pool, created.id, FeatureStatus::Archived).await?;
    }

    let session_id = insert_spawned_session(
        state,
        created.id,
        body,
        &runtime,
        codex_permission_mode.as_deref(),
    )
    .await?;
    let message_id = persist_and_announce_spawn(
        state,
        source,
        target_project.id,
        created.id,
        session_id,
        body,
    )
    .await?;
    // The conversation is already fully persisted at this point. If dispatching the
    // initial prompt fails we must NOT return an error: that would leave a complete
    // target session behind while signalling failure, tempting the caller to spawn a
    // duplicate. Instead we surface the failure in the response so it can retry by
    // messaging the existing session.
    let mut dispatch_error =
        dispatch_initial_message(state, created.id, session_id, body, message_id).await?;
    if body.follows_completion() {
        if let Some(error) = dispatch_error.clone() {
            if let Err(reply_error) =
                super::reply_wait::deliver_failed(state, session_id, &error).await
            {
                dispatch_error = Some(format!(
                    "{error}; automatic reply delivery also failed: {reply_error}"
                ));
            }
        }
    }
    let response = SpawnSessionResponse {
        feature_id: created.id,
        session_id,
        message_id,
        project: target_project.clone(),
        cross_project: target_project.id != source.project_id,
        dispatch_error: dispatch_error.clone(),
        follow: SpawnFollowResponse::from_request(body),
    };
    record_tool_audit(
        &state.write_pool,
        ToolAudit {
            server_name: "cadencr-project",
            tool_name: "project_spawn_session",
            source_session_id: Some(source.session_id),
            source_feature_id: Some(source.feature_id),
            source_project_id: Some(source.project_id),
            target_session_id: Some(session_id),
            target_feature_id: Some(created.id),
            target_project_id: Some(target_project.id),
            // The target conversation exists, but if dispatch failed the tool call did
            // not fully succeed — audit it as an error (the created ids stay recorded so
            // provenance survives). The audit CHECK only permits 'ok' | 'error'.
            status: if dispatch_error.is_some() {
                "error"
            } else {
                "ok"
            },
            result_size_bytes: result_size_bytes(&response),
            latency_ms: elapsed_ms(started_at),
            error: dispatch_error.as_deref(),
        },
    )
    .await?;
    Ok(response)
}

async fn persist_and_announce_spawn(
    state: &AppState,
    source: &super::scope::SessionScope,
    target_project_id: i64,
    feature_id: i64,
    session_id: i64,
    body: &SpawnSessionRequest,
) -> Result<Option<i64>, AppError> {
    let initial_message = insert_initial_message(state, source, session_id, body).await?;
    if body.follows_gates() {
        insert_spawn_link(
            state,
            source.session_id,
            session_id,
            body.source_note.as_deref(),
        )
        .await?;
    }
    state.feature_events_tx.emit(
        feature_id,
        Some(target_project_id),
        FeatureEventAction::Created,
    );
    let Some((message, origin)) = initial_message else {
        return Ok(None);
    };
    let message_id = message.id;
    publish_user_message(
        &state.ws_feature_senders,
        None,
        feature_id,
        &message,
        Some(origin),
        false,
    )
    .await
    .map_err(|error| AppError::Internal(error.to_string()))?;
    Ok(Some(message_id))
}

fn validate_follow_result(body: &SpawnSessionRequest) -> Result<(), AppError> {
    if body.follows_completion()
        && super::trimmed_optional(body.initial_message.as_deref()).is_none()
    {
        return Err(AppError::BadRequest(
            "follow.completion=true (or await_result=true) requires initial_message".to_string(),
        ));
    }
    Ok(())
}

async fn dispatch_initial_message(
    state: &AppState,
    feature_id: i64,
    session_id: i64,
    body: &SpawnSessionRequest,
    message_id: Option<i64>,
) -> Result<Option<String>, AppError> {
    let Some(initial_message) = super::trimmed_optional(body.initial_message.as_deref()) else {
        return Ok(None);
    };
    if body.follows_completion() {
        let message_id = message_id.expect("await_result requires a persisted message");
        super::reply_wait::arm(&state.write_pool, session_id, message_id).await?;
    }
    Ok(
        dispatch_control_prompt(state, feature_id, session_id, &initial_message, true)
            .await
            .map(|outcome| outcome.delivery_confirmed())
            .err()
            .map(|error| error.to_string()),
    )
}

async fn audit_spawn_error(
    state: &AppState,
    source: &super::scope::SessionScope,
    target_project_id: Option<i64>,
    error: &str,
    started_at: std::time::Instant,
) -> Result<(), AppError> {
    record_tool_audit(
        &state.write_pool,
        ToolAudit {
            server_name: "cadencr-project",
            tool_name: "project_spawn_session",
            source_session_id: Some(source.session_id),
            source_feature_id: Some(source.feature_id),
            source_project_id: Some(source.project_id),
            target_session_id: None,
            target_feature_id: None,
            target_project_id,
            status: "error",
            result_size_bytes: 0,
            latency_ms: elapsed_ms(started_at),
            error: Some(error),
        },
    )
    .await
}

#[cfg(test)]
mod tests {
    use super::*;

    async fn make_audit_state() -> AppState {
        let pool = sqlx::SqlitePool::connect("sqlite::memory:").await.unwrap();
        sqlx::raw_sql(
            r#"
            CREATE TABLE mcp_tool_audit_log (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                server_name TEXT NOT NULL,
                tool_name TEXT NOT NULL,
                source_session_id INTEGER,
                source_feature_id INTEGER,
                source_project_id INTEGER,
                target_session_id INTEGER,
                target_feature_id INTEGER,
                target_project_id INTEGER,
                status TEXT NOT NULL CHECK (status IN ('ok', 'error')),
                result_size_bytes INTEGER NOT NULL DEFAULT 0,
                latency_ms INTEGER NOT NULL DEFAULT 0,
                error TEXT,
                created_at TEXT NOT NULL DEFAULT (datetime('now'))
            );
            "#,
        )
        .execute(&pool)
        .await
        .unwrap();
        AppState::with_pool(pool)
    }

    fn source_scope() -> super::super::scope::SessionScope {
        super::super::scope::SessionScope {
            session_id: 100,
            feature_id: 10,
            feature_title: "Source feature".to_string(),
            project_id: 7,
            status: "active".to_string(),
            pending_permission: None,
            pending_questions: None,
        }
    }

    // Regression: a spawn that fails while targeting another project must be audited
    // against the *target* project, not the caller's, so cross-project provenance holds.
    #[tokio::test]
    async fn audit_spawn_error_attributes_the_resolved_target_project() {
        let state = make_audit_state().await;
        let source = source_scope();
        audit_spawn_error(&state, &source, Some(9), "boom", std::time::Instant::now())
            .await
            .unwrap();

        let (source_project, target_project): (i64, i64) = sqlx::query_as(
            "SELECT source_project_id, target_project_id FROM mcp_tool_audit_log LIMIT 1",
        )
        .fetch_one(&state.read_pool)
        .await
        .unwrap();
        assert_eq!(source_project, 7);
        assert_eq!(target_project, 9);
    }

    // When the target could not be resolved (and none was supplied), the audit row must
    // leave the target unset rather than falsely blaming the caller's project.
    #[tokio::test]
    async fn audit_spawn_error_leaves_target_unset_when_unresolved() {
        let state = make_audit_state().await;
        let source = source_scope();
        audit_spawn_error(
            &state,
            &source,
            None,
            "no target",
            std::time::Instant::now(),
        )
        .await
        .unwrap();

        let target_project: Option<i64> =
            sqlx::query_scalar("SELECT target_project_id FROM mcp_tool_audit_log LIMIT 1")
                .fetch_one(&state.read_pool)
                .await
                .unwrap();
        assert_eq!(target_project, None);
    }
}
