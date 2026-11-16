//! Sidebar pending-gate surface: fetch the open permission/question/plan for a
//! feature and answer it without opening the conversation.

use axum::extract::{Json, Path, State};
use axum::routing::{get, post};
use axum::Router;
use serde::{Deserialize, Serialize};
use utoipa::ToSchema;

use crate::app_state::AppState;
use crate::domain::gate_registry::PendingGate;
use crate::domain::mcp::control::gate_policy::{authorize_decision, GateDecision};
use crate::domain::mcp::control::gate_respond::dispatch_permission_response;
use crate::error::AppError;

#[derive(Debug, Serialize, ToSchema)]
pub struct FeaturePendingGateResponse {
    pub session_id: i64,
    pub request_id: String,
    /// `permission` | `question` | `plan`
    pub kind: String,
    pub payload: serde_json::Value,
    /// Truncated last assistant text message for context, when available.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_assistant_text: Option<String>,
}

#[derive(Debug, Deserialize, ToSchema)]
pub struct FeatureRespondGateRequest {
    pub request_id: String,
    pub decision: FeatureGateDecision,
}

/// Public mirror of MCP [`GateDecision`] with utoipa schema support.
#[derive(Debug, Deserialize, ToSchema)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum FeatureGateDecision {
    Permission {
        action: FeaturePermissionAction,
        #[serde(default)]
        message: Option<String>,
    },
    Plan {
        action: FeaturePlanAction,
        #[serde(default)]
        message: Option<String>,
    },
    Question {
        answers: serde_json::Value,
    },
}

#[derive(Debug, Deserialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum FeaturePermissionAction {
    AllowOnce,
    AllowAlways,
    Deny,
}

#[derive(Debug, Deserialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum FeaturePlanAction {
    Approve,
    RequestChanges,
    Reject,
}

#[derive(Debug, Serialize, ToSchema)]
pub struct FeatureRespondGateResponse {
    pub resolved: bool,
    pub request_id: String,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub warnings: Vec<String>,
}

pub fn pending_gate_routes() -> Router<AppState> {
    Router::new()
        .route(
            "/api/features/{id}/pending-gate",
            get(get_pending_gate_handler),
        )
        .route(
            "/api/features/{id}/respond-gate",
            post(respond_gate_handler),
        )
}

#[utoipa::path(
    get,
    path = "/api/features/{id}/pending-gate",
    params(("id" = i64, Path, description = "Feature id")),
    responses(
        (status = 200, body = FeaturePendingGateResponse),
        (status = 404, description = "No pending gate")
    )
)]
pub async fn get_pending_gate_handler(
    State(state): State<AppState>,
    Path(feature_id): Path<i64>,
) -> Result<Json<FeaturePendingGateResponse>, AppError> {
    let (session_id, gate) = load_feature_gate(&state, feature_id).await?;
    let last_assistant_text = last_assistant_text(&state.read_pool, session_id).await?;
    Ok(Json(FeaturePendingGateResponse {
        session_id,
        request_id: gate.request_id,
        kind: gate.kind.as_str().to_string(),
        payload: gate.payload,
        last_assistant_text,
    }))
}

#[utoipa::path(
    post,
    path = "/api/features/{id}/respond-gate",
    params(("id" = i64, Path, description = "Feature id")),
    request_body = FeatureRespondGateRequest,
    responses((status = 200, body = FeatureRespondGateResponse))
)]
pub async fn respond_gate_handler(
    State(state): State<AppState>,
    Path(feature_id): Path<i64>,
    Json(body): Json<FeatureRespondGateRequest>,
) -> Result<Json<FeatureRespondGateResponse>, AppError> {
    let (session_id, gate) = load_feature_gate(&state, feature_id).await?;
    if gate.request_id != body.request_id {
        return Err(AppError::Conflict(
            "pending gate request_id does not match".into(),
        ));
    }
    let decision = to_internal_decision(body.decision);
    let payload = authorize_decision(&state, session_id, &body.request_id, &decision).await?;
    let warnings = dispatch_permission_response(&state, session_id, payload).await?;
    Ok(Json(FeatureRespondGateResponse {
        resolved: true,
        request_id: body.request_id,
        warnings,
    }))
}

async fn load_feature_gate(
    state: &AppState,
    feature_id: i64,
) -> Result<(i64, PendingGate), AppError> {
    let session_id: Option<i64> = sqlx::query_scalar(
        "SELECT id FROM agent_sessions \
         WHERE feature_id = ? AND (pending_permission IS NOT NULL OR pending_questions IS NOT NULL) \
         ORDER BY id DESC LIMIT 1",
    )
    .bind(feature_id)
    .fetch_optional(&state.read_pool)
    .await?;

    let Some(session_id) = session_id else {
        return Err(AppError::NotFound(format!(
            "feature {feature_id} has no pending gate"
        )));
    };

    state
        .pending_gates
        .ensure_loaded(&state.read_pool, session_id)
        .await?;

    let gate = state
        .pending_gates
        .latest_open(session_id)
        .await
        .ok_or_else(|| AppError::NotFound(format!("feature {feature_id} has no pending gate")))?;

    Ok((session_id, gate))
}

async fn last_assistant_text(
    pool: &sqlx::SqlitePool,
    session_id: i64,
) -> Result<Option<String>, AppError> {
    let content: Option<String> = sqlx::query_scalar(
        "SELECT substr(trim(content), 1, 281) FROM agent_messages \
         WHERE session_id = ? AND role = 'assistant' AND message_type = 'text' \
           AND content IS NOT NULL AND TRIM(content) != '' \
         ORDER BY id DESC LIMIT 1",
    )
    .bind(session_id)
    .fetch_optional(pool)
    .await?;

    Ok(content.map(|text| truncate_for_sidebar(&text)))
}

fn truncate_for_sidebar(text: &str) -> String {
    // SQL caps via substr(…, 1, 281); if we still have >280 chars, original was longer.
    const MAX_CHARS: usize = 280;
    let trimmed = text.trim();
    if trimmed.chars().count() <= MAX_CHARS {
        return trimmed.to_string();
    }
    let mut out = trimmed.chars().take(MAX_CHARS).collect::<String>();
    out.push('…');
    out
}

fn to_internal_decision(decision: FeatureGateDecision) -> GateDecision {
    match decision {
        FeatureGateDecision::Permission { action, message } => GateDecision::Permission {
            action: match action {
                FeaturePermissionAction::AllowOnce => {
                    crate::domain::mcp::control::gate_policy::PermissionAction::AllowOnce
                }
                FeaturePermissionAction::AllowAlways => {
                    crate::domain::mcp::control::gate_policy::PermissionAction::AllowAlways
                }
                FeaturePermissionAction::Deny => {
                    crate::domain::mcp::control::gate_policy::PermissionAction::Deny
                }
            },
            message,
        },
        FeatureGateDecision::Plan { action, message } => GateDecision::Plan {
            action: match action {
                FeaturePlanAction::Approve => {
                    crate::domain::mcp::control::gate_policy::PlanAction::Approve
                }
                FeaturePlanAction::RequestChanges => {
                    crate::domain::mcp::control::gate_policy::PlanAction::RequestChanges
                }
                FeaturePlanAction::Reject => {
                    crate::domain::mcp::control::gate_policy::PlanAction::Reject
                }
            },
            message,
        },
        FeatureGateDecision::Question { answers } => GateDecision::Question { answers },
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::gate_registry::GateKind;

    #[test]
    fn truncates_long_assistant_text() {
        let long = "a".repeat(400);
        let out = truncate_for_sidebar(&long);
        assert!(out.ends_with('…'));
        assert_eq!(out.chars().count(), 281);
    }

    #[test]
    fn gate_kind_labels() {
        assert_eq!(GateKind::Permission.as_str(), "permission");
        assert_eq!(GateKind::Question.as_str(), "question");
        assert_eq!(GateKind::Plan.as_str(), "plan");
    }
}
