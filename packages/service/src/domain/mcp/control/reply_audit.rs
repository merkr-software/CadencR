use super::audit::{elapsed_ms, record_tool_audit, result_size_bytes, ToolAudit};
use super::scope::SessionScope;
use crate::app_state::AppState;
use crate::error::AppError;

pub(super) async fn record_reply_delivery_audit(
    state: &AppState,
    responder: &SessionScope,
    requester: &SessionScope,
    envelope: &str,
    error: Option<&str>,
    started_at: std::time::Instant,
) -> Result<(), AppError> {
    record_tool_audit(
        &state.write_pool,
        ToolAudit {
            server_name: "cadencr-project",
            tool_name: "project_reply_delivery",
            source_session_id: Some(responder.session_id),
            source_feature_id: Some(responder.feature_id),
            source_project_id: Some(responder.project_id),
            target_session_id: Some(requester.session_id),
            target_feature_id: Some(requester.feature_id),
            target_project_id: Some(requester.project_id),
            status: if error.is_some() { "error" } else { "ok" },
            result_size_bytes: result_size_bytes(&envelope),
            latency_ms: elapsed_ms(started_at),
            error,
        },
    )
    .await
}
