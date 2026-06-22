use axum::{extract::State, Json};
use serde::{Deserialize, Serialize};

use super::audit::{elapsed_ms, record_tool_audit, result_size_bytes, ToolAudit};
use super::scope::resolve_session_scope;
use crate::app_state::AppState;
use crate::domain::agents::codex::{
    canonical_access_mode_wire, configured_access_mode as configured_codex_access_mode,
    PROVIDER_ID as CODEX_PROVIDER_ID,
};
use crate::domain::agents::providers::{resolve_effective_provider, validate_provider_model};
use crate::domain::agents::runtime::{runtime_setting_key, DEFAULT_PROVIDER};
use crate::domain::feature_events::FeatureEventAction;
use crate::domain::features::service::create_feature_with_worktree;
use crate::domain::settings;
use crate::domain::ws_session::handler::session_prompt::dispatch_control_prompt;
use crate::error::AppError;

#[derive(Debug, Deserialize)]
pub(super) struct SpawnSessionRequest {
    source_feature_id: i64,
    source_session_id: i64,
    title: Option<String>,
    initial_message: Option<String>,
    branch: Option<SpawnBranch>,
    provider: Option<String>,
    model: Option<String>,
    permission_mode: Option<String>,
    codex_permission_mode: Option<String>,
    source_note: Option<String>,
    link_to_current_session: Option<bool>,
}

#[derive(Debug, Default, Deserialize)]
struct SpawnBranch {
    mode: Option<String>,
    base: Option<String>,
    reuse_branch: Option<String>,
}

#[derive(Debug, Serialize)]
pub(super) struct SpawnSessionResponse {
    #[serde(rename = "featureId")]
    feature_id: i64,
    #[serde(rename = "sessionId")]
    session_id: i64,
    #[serde(rename = "messageId", skip_serializing_if = "Option::is_none")]
    message_id: Option<i64>,
}

pub(super) async fn spawn_session_handler(
    State(state): State<AppState>,
    Json(body): Json<SpawnSessionRequest>,
) -> Result<Json<SpawnSessionResponse>, AppError> {
    let started_at = std::time::Instant::now();
    let source = resolve_session_scope(&state.write_pool, body.source_session_id).await?;
    if source.feature_id != body.source_feature_id {
        let message = "source_session_id does not belong to source_feature_id".to_string();
        audit_spawn_error(&state, &source, &message, started_at).await?;
        return Err(AppError::BadRequest(message));
    }

    let (worktree_mode, reuse_branch, base_branch) =
        match branch_worktree_settings(body.branch.as_ref()) {
            Ok(settings) => settings,
            Err(error) => {
                let message = error.to_string();
                audit_spawn_error(&state, &source, &message, started_at).await?;
                return Err(error);
            }
        };
    if let Err(error) = validate_spawn_model(&state, &source, &body).await {
        let message = error.to_string();
        audit_spawn_error(&state, &source, &message, started_at).await?;
        return Err(error);
    }
    let codex_permission_mode = match codex_permission_mode_for_spawn(&state, &source, &body).await
    {
        Ok(mode) => mode,
        Err(error) => {
            let message = error.to_string();
            audit_spawn_error(&state, &source, &message, started_at).await?;
            return Err(error);
        }
    };
    let created = create_feature_with_worktree(
        &state.write_pool,
        source.project_id,
        trimmed_optional(body.title.as_deref()),
        Some("ws-session".to_string()),
        Some(worktree_mode),
        reuse_branch,
        base_branch,
    )
    .await?;

    let session_id =
        insert_spawned_session(&state, created.id, &body, codex_permission_mode.as_deref()).await?;
    let message_id = insert_initial_message(&state, &source, session_id, &body).await?;
    if body.link_to_current_session.unwrap_or(true) {
        insert_spawn_link(
            &state,
            source.session_id,
            session_id,
            body.source_note.as_deref(),
        )
        .await?;
    }
    state.feature_events_tx.emit(
        created.id,
        Some(source.project_id),
        FeatureEventAction::Created,
    );
    if let Some(initial_message) = trimmed_optional(body.initial_message.as_deref()) {
        dispatch_control_prompt(&state, created.id, session_id, &initial_message, true).await?;
    }
    let response = SpawnSessionResponse {
        feature_id: created.id,
        session_id,
        message_id,
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
            target_project_id: Some(source.project_id),
            status: "ok",
            result_size_bytes: result_size_bytes(&response),
            latency_ms: elapsed_ms(started_at),
            error: None,
        },
    )
    .await?;
    Ok(Json(response))
}

async fn audit_spawn_error(
    state: &AppState,
    source: &super::scope::SessionScope,
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
            target_project_id: Some(source.project_id),
            status: "error",
            result_size_bytes: 0,
            latency_ms: elapsed_ms(started_at),
            error: Some(error),
        },
    )
    .await
}

fn branch_worktree_settings(
    branch: Option<&SpawnBranch>,
) -> Result<(String, Option<String>, Option<String>), AppError> {
    let default_branch = SpawnBranch::default();
    let branch = branch.unwrap_or(&default_branch);
    let mode = branch.mode.as_deref().unwrap_or("none");
    let worktree_mode = match mode {
        "none" | "skip" => "skip",
        "new" | "new_project_branch" | "new_worktree" => "new",
        "reuse" | "reuse_worktree" => "reuse",
        other => {
            return Err(AppError::BadRequest(format!(
                "unsupported branch mode '{other}'"
            )))
        }
    };
    if worktree_mode == "reuse"
        && branch
            .reuse_branch
            .as_deref()
            .unwrap_or("")
            .trim()
            .is_empty()
    {
        return Err(AppError::BadRequest(
            "branch.reuse_branch is required for reuse_worktree".to_string(),
        ));
    }
    let base_branch = if worktree_mode == "new" {
        trimmed_optional(branch.base.as_deref())
    } else {
        None
    };
    Ok((
        worktree_mode.to_string(),
        trimmed_optional(branch.reuse_branch.as_deref()),
        base_branch,
    ))
}

async fn validate_spawn_model(
    state: &AppState,
    source: &super::scope::SessionScope,
    body: &SpawnSessionRequest,
) -> Result<(), AppError> {
    let Some(model) = trimmed_optional(body.model.as_deref()) else {
        return Ok(());
    };
    let provider = effective_spawn_provider(state, source, body).await;
    validate_provider_model(&state.read_pool, &provider, &model)
        .await
        .map_err(|error| AppError::BadRequest(error.to_string()))
}

async fn insert_spawned_session(
    state: &AppState,
    feature_id: i64,
    body: &SpawnSessionRequest,
    codex_permission_mode: Option<&str>,
) -> Result<i64, AppError> {
    let now = chrono::Utc::now().to_rfc3339();
    Ok(sqlx::query_scalar(
        "INSERT INTO agent_sessions
         (feature_id, agent_type, status, runtime_provider, model, permission_mode, codex_permission_mode, started_at)
         VALUES (?, 'session', 'paused', ?, ?, ?, COALESCE(?, 'default'), ?)
         RETURNING id",
    )
    .bind(feature_id)
    .bind(trimmed_optional(body.provider.as_deref()))
    .bind(trimmed_optional(body.model.as_deref()))
    .bind(trimmed_optional(body.permission_mode.as_deref()))
    .bind(codex_permission_mode)
    .bind(now)
    .fetch_one(&state.write_pool)
    .await?)
}

async fn codex_permission_mode_for_spawn(
    state: &AppState,
    source: &super::scope::SessionScope,
    body: &SpawnSessionRequest,
) -> Result<Option<String>, AppError> {
    let provider = effective_spawn_provider(state, source, body).await;
    if provider != CODEX_PROVIDER_ID {
        return Ok(None);
    }
    if let Some(raw_mode) = trimmed_optional(body.codex_permission_mode.as_deref()) {
        return canonical_codex_permission_mode(&raw_mode).map(Some);
    }

    let configured = configured_codex_access_mode(&state.read_pool).await;
    canonical_codex_permission_mode(&configured).map(Some)
}

async fn effective_spawn_provider(
    state: &AppState,
    source: &super::scope::SessionScope,
    body: &SpawnSessionRequest,
) -> String {
    if let Some(provider) = trimmed_optional(body.provider.as_deref()) {
        return provider;
    }
    let configured = settings::resolve_setting(
        &state.read_pool,
        &runtime_setting_key("session"),
        Some(source.feature_id),
        Some(source.project_id),
        Some(DEFAULT_PROVIDER),
    )
    .await
    .unwrap_or_else(|| DEFAULT_PROVIDER.to_string());
    resolve_effective_provider(configured, body.model.as_deref())
}

fn canonical_codex_permission_mode(raw_mode: &str) -> Result<String, AppError> {
    canonical_access_mode_wire(raw_mode)
        .ok_or_else(|| AppError::BadRequest(format!("unsupported Codex access mode '{raw_mode}'")))
}

async fn insert_initial_message(
    state: &AppState,
    source: &super::scope::SessionScope,
    session_id: i64,
    body: &SpawnSessionRequest,
) -> Result<Option<i64>, AppError> {
    let Some(message) = trimmed_optional(body.initial_message.as_deref()) else {
        return Ok(None);
    };
    let mut tx = state.write_pool.begin().await?;
    let message_id: i64 = sqlx::query_scalar(
        "INSERT INTO agent_messages (session_id, role, content, message_type)
         VALUES (?, 'user', ?, 'user_message')
         RETURNING id",
    )
    .bind(session_id)
    .bind(&message)
    .fetch_one(&mut *tx)
    .await?;
    sqlx::query(
        "INSERT INTO agent_message_origins
         (message_id, origin_kind, source_session_id, source_feature_id, source_project_id, note)
         VALUES (?, 'session_generated', ?, ?, ?, ?)",
    )
    .bind(message_id)
    .bind(source.session_id)
    .bind(source.feature_id)
    .bind(source.project_id)
    .bind(body.source_note.as_deref())
    .execute(&mut *tx)
    .await?;
    tx.commit().await?;
    Ok(Some(message_id))
}

async fn insert_spawn_link(
    state: &AppState,
    source_session_id: i64,
    target_session_id: i64,
    note: Option<&str>,
) -> Result<(), AppError> {
    sqlx::query(
        "INSERT INTO agent_session_links (source_session_id, target_session_id, link_type, note)
         VALUES (?, ?, 'spawned', ?)",
    )
    .bind(source_session_id)
    .bind(target_session_id)
    .bind(note)
    .execute(&state.write_pool)
    .await?;
    Ok(())
}

fn trimmed_optional(value: Option<&str>) -> Option<String> {
    value
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn branch_worktree_settings_preserves_base_branch_for_new_worktree() {
        let branch = SpawnBranch {
            mode: Some("new_worktree".to_string()),
            base: Some("main".to_string()),
            reuse_branch: None,
        };

        let settings = branch_worktree_settings(Some(&branch)).unwrap();

        assert_eq!(settings.0, "new");
        assert_eq!(settings.1, None);
        assert_eq!(settings.2.as_deref(), Some("main"));
    }
}
