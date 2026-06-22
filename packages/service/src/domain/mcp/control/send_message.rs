use axum::{extract::ws::Message, extract::State, Json};
use serde::{Deserialize, Serialize};

use super::audit::{elapsed_ms, record_tool_audit, result_size_bytes, ToolAudit};
use super::scope::resolve_session_scope;
use crate::app_state::AppState;
use crate::domain::feature_events::FeatureEventAction;
use crate::domain::sessions::models::AgentMessageOrigin;
use crate::domain::ws_session::handler::session_prompt::dispatch_control_prompt;
use crate::domain::ws_session::protocol::{UserMessageMirrorPayload, WsEnvelope};
use crate::error::AppError;

const MAX_SEND_MESSAGES_PER_SOURCE_PER_HOUR: i64 = 20;

#[derive(Debug, Deserialize)]
pub(super) struct SendMessageRequest {
    source_feature_id: i64,
    source_session_id: i64,
    target_session_id: i64,
    message: String,
    delivery: Option<String>,
    source_note: Option<String>,
    link_to_current_session: Option<bool>,
}

#[derive(Debug, Serialize)]
pub(super) struct SendMessageResponse {
    #[serde(rename = "messageId", skip_serializing_if = "Option::is_none")]
    message_id: Option<i64>,
    #[serde(rename = "queueId", skip_serializing_if = "Option::is_none")]
    queue_id: Option<i64>,
    #[serde(rename = "targetSessionId")]
    target_session_id: i64,
}

pub(super) async fn send_message_handler(
    State(state): State<AppState>,
    Json(body): Json<SendMessageRequest>,
) -> Result<Json<SendMessageResponse>, AppError> {
    let started_at = std::time::Instant::now();
    let message = body.message.trim();
    if message.is_empty() {
        return Err(AppError::BadRequest(
            "message must not be blank".to_string(),
        ));
    }

    let source = resolve_session_scope(&state.write_pool, body.source_session_id).await?;
    let target = resolve_session_scope(&state.write_pool, body.target_session_id).await?;
    if source.feature_id != body.source_feature_id {
        return Err(AppError::BadRequest(
            "source_session_id does not belong to source_feature_id".to_string(),
        ));
    }
    if source.project_id != target.project_id {
        return Err(AppError::BadRequest(
            "target session does not belong to current project".to_string(),
        ));
    }
    if let Err(error) = ensure_send_budget(&state, &source).await {
        let message = error.to_string();
        audit_send_message_error(&state, &source, &target, &message, started_at).await?;
        return Err(error);
    }

    let delivery = match delivery_mode(body.delivery.as_deref()) {
        Ok(mode) => mode,
        Err(message) => {
            audit_send_message_error(&state, &source, &target, &message, started_at).await?;
            return Err(AppError::BadRequest(message));
        }
    };
    if requires_user_resolution(&target.status) {
        let message = format!(
            "target session is awaiting user resolution: {}",
            target.status
        );
        audit_send_message_error(&state, &source, &target, &message, started_at).await?;
        return Err(AppError::BadRequest(message));
    }
    if target.status == "running" && delivery == DeliveryMode::RejectIfBusy {
        let message = "target session is busy".to_string();
        audit_send_message_error(&state, &source, &target, &message, started_at).await?;
        return Err(AppError::BadRequest(message));
    }
    if target.status == "running" && delivery == DeliveryMode::QueueIfBusy {
        let queue_id = queue_message(&state, source.session_id, target.session_id, message).await?;
        if body.link_to_current_session.unwrap_or(true) {
            insert_message_link(
                &state,
                source.session_id,
                target.session_id,
                body.source_note.as_deref(),
            )
            .await?;
        }
        let response = SendMessageResponse {
            message_id: None,
            queue_id: Some(queue_id),
            target_session_id: target.session_id,
        };
        audit_send_message(&state, &source, &target, &response, started_at).await?;
        return Ok(Json(response));
    }

    let mut tx = state.write_pool.begin().await?;
    let message_id: i64 = sqlx::query_scalar(
        "INSERT INTO agent_messages (session_id, role, content, message_type)
         VALUES (?, 'user', ?, 'user_message')
         RETURNING id",
    )
    .bind(target.session_id)
    .bind(message)
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
    if body.link_to_current_session.unwrap_or(true) {
        sqlx::query(
            "INSERT INTO agent_session_links (source_session_id, target_session_id, link_type, note)
             VALUES (?, ?, 'messaged', ?)",
        )
        .bind(source.session_id)
        .bind(target.session_id)
        .bind(body.source_note.as_deref())
        .execute(&mut *tx)
        .await?;
    }
    tx.commit().await?;

    state
        .feature_events_tx
        .emit(target.feature_id, None, FeatureEventAction::Reordered);
    broadcast_generated_user_message(
        &state,
        &source,
        target.feature_id,
        message,
        body.source_note.as_deref(),
    )
    .await;
    // The user message was already persisted/broadcast above.
    dispatch_control_prompt(&state, target.feature_id, target.session_id, message, true).await?;
    let response = SendMessageResponse {
        message_id: Some(message_id),
        queue_id: None,
        target_session_id: target.session_id,
    };
    audit_send_message(&state, &source, &target, &response, started_at).await?;
    Ok(Json(response))
}

pub(super) async fn broadcast_generated_user_message(
    state: &AppState,
    source: &super::scope::SessionScope,
    target_feature_id: i64,
    message: &str,
    note: Option<&str>,
) {
    let origin = AgentMessageOrigin {
        origin_kind: "session_generated".to_string(),
        source_session_id: Some(source.session_id),
        source_feature_id: Some(source.feature_id),
        source_project_id: Some(source.project_id),
        source_message_id: None,
        note: note.map(str::to_string),
        created_at: None,
    };
    let envelope = WsEnvelope::new(
        "session",
        "user_message",
        serde_json::to_value(UserMessageMirrorPayload {
            text: message.to_string(),
            origin: Some(origin),
        })
        .unwrap(),
    );
    let ws_message = Message::Text(String::from(envelope).into());
    for sender in state
        .ws_feature_senders
        .get_senders(target_feature_id)
        .await
    {
        let _ = sender.send(ws_message.clone());
    }
}

async fn ensure_send_budget(
    state: &AppState,
    source: &super::scope::SessionScope,
) -> Result<(), AppError> {
    let recent_send_count: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM mcp_tool_audit_log
         WHERE tool_name = 'project_send_session_message'
           AND source_session_id = ?
           AND status = 'ok'
           AND created_at >= datetime('now', '-1 hour')",
    )
    .bind(source.session_id)
    .fetch_one(&state.write_pool)
    .await?;
    if recent_send_count >= MAX_SEND_MESSAGES_PER_SOURCE_PER_HOUR {
        return Err(AppError::BadRequest(format!(
            "project_send_session_message hourly limit exceeded for source session {}",
            source.session_id
        )));
    }
    Ok(())
}

async fn insert_message_link(
    state: &AppState,
    source_session_id: i64,
    target_session_id: i64,
    note: Option<&str>,
) -> Result<(), AppError> {
    sqlx::query(
        "INSERT INTO agent_session_links (source_session_id, target_session_id, link_type, note)
         VALUES (?, ?, 'messaged', ?)",
    )
    .bind(source_session_id)
    .bind(target_session_id)
    .bind(note)
    .execute(&state.write_pool)
    .await?;
    Ok(())
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum DeliveryMode {
    SendNow,
    QueueIfBusy,
    RejectIfBusy,
}

fn delivery_mode(value: Option<&str>) -> Result<DeliveryMode, String> {
    match value.unwrap_or("send_now") {
        "send_now" => Ok(DeliveryMode::SendNow),
        "queue_if_busy" => Ok(DeliveryMode::QueueIfBusy),
        "reject_if_busy" => Ok(DeliveryMode::RejectIfBusy),
        other => Err(format!("unsupported delivery mode '{other}'")),
    }
}

fn requires_user_resolution(status: &str) -> bool {
    matches!(
        status,
        "awaiting_permission"
            | "awaiting_question"
            | "waiting_for_permission"
            | "waiting_for_question"
    )
}

async fn queue_message(
    state: &AppState,
    source_session_id: i64,
    target_session_id: i64,
    message: &str,
) -> Result<i64, AppError> {
    Ok(sqlx::query_scalar(
        "INSERT INTO agent_session_message_queue (target_session_id, source_session_id, content)
         VALUES (?, ?, ?)
         RETURNING id",
    )
    .bind(target_session_id)
    .bind(source_session_id)
    .bind(message)
    .fetch_one(&state.write_pool)
    .await?)
}

async fn audit_send_message(
    state: &AppState,
    source: &super::scope::SessionScope,
    target: &super::scope::SessionScope,
    response: &SendMessageResponse,
    started_at: std::time::Instant,
) -> Result<(), AppError> {
    record_tool_audit(
        &state.write_pool,
        ToolAudit {
            server_name: "cadencr-project",
            tool_name: "project_send_session_message",
            source_session_id: Some(source.session_id),
            source_feature_id: Some(source.feature_id),
            source_project_id: Some(source.project_id),
            target_session_id: Some(target.session_id),
            target_feature_id: Some(target.feature_id),
            target_project_id: Some(target.project_id),
            status: "ok",
            result_size_bytes: result_size_bytes(&response),
            latency_ms: elapsed_ms(started_at),
            error: None,
        },
    )
    .await
}

async fn audit_send_message_error(
    state: &AppState,
    source: &super::scope::SessionScope,
    target: &super::scope::SessionScope,
    error: &str,
    started_at: std::time::Instant,
) -> Result<(), AppError> {
    record_tool_audit(
        &state.write_pool,
        ToolAudit {
            server_name: "cadencr-project",
            tool_name: "project_send_session_message",
            source_session_id: Some(source.session_id),
            source_feature_id: Some(source.feature_id),
            source_project_id: Some(source.project_id),
            target_session_id: Some(target.session_id),
            target_feature_id: Some(target.feature_id),
            target_project_id: Some(target.project_id),
            status: "error",
            result_size_bytes: 0,
            latency_ms: elapsed_ms(started_at),
            error: Some(error),
        },
    )
    .await
}
