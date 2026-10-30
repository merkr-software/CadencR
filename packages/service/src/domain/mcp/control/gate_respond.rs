use axum::extract::State;
use axum::{routing::post, Json, Router};
use serde::{Deserialize, Serialize};
use tracing::error;

use super::audit::{elapsed_ms, record_tool_audit, ToolAudit};
use super::gate_notify::linked_parent;
use super::gate_policy::{authorize_decision, GateDecision};
use super::scope::{resolve_session_scope, SessionScope};
use crate::app_state::AppState;
use crate::domain::ws_session::protocol::PermissionRespondPayload;
use crate::domain::ws_session::runtime::application::respond_permission;
use crate::domain::ws_session::runtime::output::{CommandOutput, SessionOutput};
use crate::error::AppError;

#[derive(Debug, Deserialize)]
pub(super) struct ListPendingGatesRequest {
    source_session_id: i64,
    session_id: i64,
}

#[derive(Debug, Deserialize)]
pub(super) struct RespondGateRequest {
    source_session_id: i64,
    session_id: i64,
    request_id: String,
    decision: GateDecision,
}

#[derive(Debug, Serialize)]
pub(super) struct PendingGatesResponse {
    gates: Vec<crate::domain::gate_registry::PendingGate>,
}

pub(super) fn routes() -> Router<AppState> {
    Router::new()
        .route(
            "/internal/mcp/project/respond-gate",
            post(respond_gate_handler),
        )
        .route(
            "/internal/mcp/project/pending-gates",
            post(list_pending_gates_handler),
        )
}

pub(super) async fn list_pending_gates_handler(
    State(state): State<AppState>,
    Json(request): Json<ListPendingGatesRequest>,
) -> Result<Json<PendingGatesResponse>, AppError> {
    require_linked_parent(&state, request.source_session_id, request.session_id).await?;
    state
        .pending_gates
        .ensure_loaded(&state.read_pool, request.session_id)
        .await?;
    let gates = state.pending_gates.pending_all(request.session_id).await;
    Ok(Json(PendingGatesResponse { gates }))
}

pub(super) async fn respond_gate_handler(
    State(state): State<AppState>,
    Json(request): Json<RespondGateRequest>,
) -> Result<Json<serde_json::Value>, AppError> {
    let started_at = std::time::Instant::now();
    let (source, target) = tokio::try_join!(
        resolve_session_scope(&state.read_pool, request.source_session_id),
        resolve_session_scope(&state.read_pool, request.session_id),
    )?;
    let response = respond_authorized(&state, &request).await;
    finish_response(state, source, target, request, response, started_at).await
}

async fn respond_authorized(
    state: &AppState,
    request: &RespondGateRequest,
) -> Result<Vec<String>, AppError> {
    require_linked_parent(state, request.source_session_id, request.session_id).await?;
    let payload = authorize_decision(
        state,
        request.session_id,
        &request.request_id,
        &request.decision,
    )
    .await?;
    dispatch_permission_response(state, request.session_id, payload).await
}

async fn finish_response(
    state: AppState,
    source: SessionScope,
    target: SessionScope,
    request: RespondGateRequest,
    response: Result<Vec<String>, AppError>,
    started_at: std::time::Instant,
) -> Result<Json<serde_json::Value>, AppError> {
    let mut warnings = response.as_ref().ok().cloned().unwrap_or_default();
    let primary_error = response.as_ref().err().map(ToString::to_string);
    let audit_error = primary_error
        .clone()
        .or_else(|| (!warnings.is_empty()).then(|| warnings.join("; ")));
    if let Err(cause) = audit_response(
        &state,
        &source,
        &target,
        primary_error.is_none(),
        audit_error.as_deref(),
        started_at,
    )
    .await
    {
        error!(session_id = target.session_id, error = %cause, "failed to audit gate decision");
        warnings.push(format!("gate decision audit failed: {cause}"));
    }
    response?;
    let mut body = serde_json::json!({
        "resolved": true,
        "requestId": request.request_id,
    });
    if !warnings.is_empty() {
        body["warnings"] = serde_json::json!(warnings);
    }
    Ok(Json(body))
}

async fn require_linked_parent(
    state: &AppState,
    parent_session_id: i64,
    child_session_id: i64,
) -> Result<(), AppError> {
    if linked_parent(&state.read_pool, child_session_id).await? != Some(parent_session_id) {
        return Err(AppError::BadRequest(
            "only the linked spawned/handoff parent may access this gate".into(),
        ));
    }
    Ok(())
}

/// Dispatch a permission/question/plan response into the live turn owner.
/// Shared by MCP parent-child gate replies and the sidebar pending-gate API.
pub(crate) async fn dispatch_permission_response(
    state: &AppState,
    session_id: i64,
    payload: PermissionRespondPayload,
) -> Result<Vec<String>, AppError> {
    let sessions = state
        .active_turns
        .owner_sessions(session_id)
        .await
        .ok_or_else(|| AppError::Conflict("target session has no live turn owner".into()))?;
    let output = CommandOutput {
        recipient: SessionOutput::headless(),
        correlation_id: String::new(),
    };
    let outcome = respond_permission(state, &sessions, payload, &output)
        .await
        .map_err(|error| AppError::Conflict(error.message))?;
    Ok(outcome
        .warnings
        .into_iter()
        .map(|warning| format!("{}: {}", warning.code, warning.message))
        .collect())
}

async fn audit_response(
    state: &AppState,
    source: &SessionScope,
    target: &SessionScope,
    success: bool,
    audit_error: Option<&str>,
    started_at: std::time::Instant,
) -> Result<(), AppError> {
    record_tool_audit(
        &state.write_pool,
        ToolAudit {
            server_name: "cadencr-project",
            tool_name: "project_respond_gate",
            source_session_id: Some(source.session_id),
            source_feature_id: Some(source.feature_id),
            source_project_id: Some(source.project_id),
            target_session_id: Some(target.session_id),
            target_feature_id: Some(target.feature_id),
            target_project_id: Some(target.project_id),
            status: if success { "ok" } else { "error" },
            result_size_bytes: 0,
            latency_ms: elapsed_ms(started_at),
            error: audit_error,
        },
    )
    .await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::mcp::control::gate_policy::PermissionAction;
    use crate::shared::migrate::{run_migrations, MigrationContext};

    #[tokio::test]
    async fn successful_permission_response_does_not_create_a_user_message() {
        let pool = sqlx::SqlitePool::connect("sqlite::memory:").await.unwrap();
        run_migrations(&MigrationContext::pool_only(&pool))
            .await
            .unwrap();
        sqlx::raw_sql(
            "INSERT INTO projects (id, name, path) VALUES (7, 'P', '/tmp/p');
             INSERT INTO features (id, project_id, title, status, type)
             VALUES (42, 7, 'Parent', 'active', 'ws-session'),
                    (43, 7, 'Child', 'active', 'ws-session');
             INSERT INTO agent_sessions (id, feature_id, agent_type, status)
             VALUES (777, 42, 'session', 'running'),
                    (888, 43, 'session', 'running');",
        )
        .execute(&pool)
        .await
        .unwrap();
        let state = AppState::with_pool(pool.clone());
        let source = resolve_session_scope(&pool, 777).await.unwrap();
        let target = resolve_session_scope(&pool, 888).await.unwrap();
        let request = RespondGateRequest {
            source_session_id: 777,
            session_id: 888,
            request_id: "permission-1".into(),
            decision: GateDecision::Permission {
                action: PermissionAction::AllowOnce,
                message: None,
            },
        };

        let _ = finish_response(
            state,
            source,
            target,
            request,
            Ok(Vec::new()),
            std::time::Instant::now(),
        )
        .await
        .unwrap();

        let user_messages: i64 =
            sqlx::query_scalar("SELECT COUNT(*) FROM agent_messages WHERE session_id = 888")
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(user_messages, 0);
        let audit_rows: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM mcp_tool_audit_log
             WHERE tool_name = 'project_respond_gate' AND status = 'ok'",
        )
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(audit_rows, 1);
    }
}
