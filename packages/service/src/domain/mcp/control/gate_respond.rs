use axum::extract::{ws::Message, State};
use axum::{routing::post, Json, Router};
use serde::{Deserialize, Serialize};
use tracing::error;

use super::audit::{elapsed_ms, record_tool_audit, ToolAudit};
use super::gate_notify::linked_parent;
use super::gate_policy::{authorize_decision, GateDecision};
use super::message_queue::persist_and_broadcast_generated_user_message;
use super::scope::{resolve_session_scope, SessionScope};
use crate::app_state::AppState;
use crate::domain::ws_session::protocol::{PermissionRespondPayload, WsEnvelope};
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
) -> Result<(), AppError> {
    require_linked_parent(state, request.source_session_id, request.session_id).await?;
    let payload = authorize_decision(
        state,
        request.session_id,
        &request.request_id,
        &request.decision,
    )
    .await?;
    dispatch_response(state, request.session_id, payload).await
}

async fn finish_response(
    state: AppState,
    source: SessionScope,
    target: SessionScope,
    request: RespondGateRequest,
    response: Result<(), AppError>,
    started_at: std::time::Instant,
) -> Result<Json<serde_json::Value>, AppError> {
    let mut warnings = Vec::new();
    if response.is_ok() {
        if let Err(cause) = persist_visible_decision(&state, &source, &target, &request).await {
            error!(session_id = target.session_id, error = %cause, "failed to persist visible gate decision");
            warnings.push(format!(
                "gate resolved, but transcript visibility failed: {cause}"
            ));
        }
    }
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

async fn dispatch_response(
    state: &AppState,
    session_id: i64,
    payload: PermissionRespondPayload,
) -> Result<(), AppError> {
    let sessions = state
        .active_turns
        .owner_sessions(session_id)
        .await
        .ok_or_else(|| AppError::Conflict("target session has no live turn owner".into()))?;
    let (sender, mut receiver) = tokio::sync::mpsc::unbounded_channel::<Message>();
    let envelope = WsEnvelope::new(
        "session",
        "permission.respond",
        serde_json::to_value(payload).map_err(|cause| AppError::Internal(cause.to_string()))?,
    );
    crate::domain::ws_session::handler::handle_permission_respond(
        envelope, &sender, &sessions, state,
    )
    .await;
    drop(sender);
    let response = receiver.try_recv().map_err(|cause| {
        AppError::Internal(format!(
            "permission response produced no acknowledgement: {cause}"
        ))
    })?;
    response_result(response)
}

fn response_result(response: Message) -> Result<(), AppError> {
    let Message::Text(text) = response else {
        return Err(AppError::Internal(
            "unexpected permission acknowledgement".into(),
        ));
    };
    let value: serde_json::Value =
        serde_json::from_str(&text).map_err(|cause| AppError::Internal(cause.to_string()))?;
    if value.get("action").and_then(serde_json::Value::as_str) != Some("error") {
        return Ok(());
    }
    Err(AppError::Conflict(
        value
            .pointer("/payload/message")
            .and_then(serde_json::Value::as_str)
            .unwrap_or("gate response rejected")
            .into(),
    ))
}

async fn persist_visible_decision(
    state: &AppState,
    source: &SessionScope,
    target: &SessionScope,
    request: &RespondGateRequest,
) -> Result<(), AppError> {
    let text = format!(
        "Gate `{}` was answered programmatically by session #{} (linked parent). Decision: {:?}.",
        request.request_id, source.session_id, request.decision
    );
    persist_and_broadcast_generated_user_message(
        state,
        source,
        target.session_id,
        target.feature_id,
        &text,
        "programmatic gate decision by linked parent",
    )
    .await
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
