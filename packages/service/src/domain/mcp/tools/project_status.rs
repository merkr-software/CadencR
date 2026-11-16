use serde_json::json;

use crate::domain::mcp::context::McpContext;
use crate::domain::mcp::tools::helpers::require_i64;
use crate::domain::session_status::{
    derive_status_from_db, AgentStatus, DbStatusInputs, PendingKind,
};

use super::project::{current_project, ensure_current_project_session};

pub(super) async fn get_session_status(
    ctx: &McpContext,
    args: &serde_json::Value,
) -> Result<serde_json::Value, String> {
    let project = current_project(ctx).await?;
    let session_id = require_i64(args, "session_id")?;
    ensure_current_project_session(ctx, session_id, project.id).await?;

    let (status, pending_permission, pending_questions): (String, Option<String>, Option<String>) =
        sqlx::query_as(
            "SELECT status, pending_permission, pending_questions
         FROM agent_sessions WHERE id = ?",
        )
        .bind(session_id)
        .fetch_one(&ctx.read_pool)
        .await
        .map_err(|e| format!("Failed to read session status: {e}"))?;
    let derived = derive_status_from_db(DbStatusInputs {
        status_col: &status,
        pending_permission: pending_permission.is_some(),
        pending_question: pending_questions.is_some(),
    });
    let turn_state = match (derived.status, derived.kind) {
        (AgentStatus::Agent, _) => "working",
        (AgentStatus::Question, Some(PendingKind::Permission)) => "awaiting_permission",
        (AgentStatus::Question, Some(PendingKind::Question)) => "awaiting_question",
        _ => "idle",
    };
    let lifecycle = match status.as_str() {
        "completed" => "completed",
        "error" => "error",
        _ => "open",
    };
    let pending_queue_count: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM agent_session_message_queue
         WHERE target_session_id = ? AND status = 'pending'",
    )
    .bind(session_id)
    .fetch_one(&ctx.read_pool)
    .await
    .map_err(|e| format!("Failed to read pending queue count: {e}"))?;

    Ok(json!({
        "session_id": session_id,
        "project_id": project.id,
        "source_session_id": ctx.source_session_id,
        "status": status,
        "lifecycle": lifecycle,
        "turn_state": turn_state,
        "pending_queue_count": pending_queue_count,
        "has_pending_queue": pending_queue_count > 0,
        "delivery_mode": "reactive_push",
        "polling_guidance": "Recovery snapshot only. Followed gates and awaited replies are delivered automatically; do not poll status or session tails."
    }))
}
