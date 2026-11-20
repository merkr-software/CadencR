//! Answering a gate without a socket: the `respond-gate` route and the MCP
//! `project_respond_gate` tool. Rejecting a plan closes its gate and stops the
//! turn, as the desktop's "Reject & Stop"; every other decision is delivered
//! to the agent, as the desktop's other gate buttons.

use axum::http::StatusCode;

use super::gate_policy::{authorize_decision, GateDecision, PlanAction};
use super::gate_respond::dispatch_permission_response;
use crate::app_state::AppState;
use crate::domain::ws_session::handler::{
    close_gate, new_sdk_sessions, owner_sessions, GateCloseRequest,
};
use crate::domain::ws_session::protocol::GateCloseReason;
use crate::domain::ws_session::runtime::output::{CommandError, SessionOutput};
use crate::error::AppError;

/// Answer the pending gate `request_id` with `decision`; the warnings the
/// answer collected.
pub(crate) async fn answer_gate(
    state: &AppState,
    session_id: i64,
    request_id: &str,
    decision: &GateDecision,
) -> Result<Vec<String>, AppError> {
    let payload = authorize_decision(state, session_id, request_id, decision).await?;
    if !rejects_the_plan(decision) {
        return dispatch_permission_response(state, session_id, payload).await;
    }
    // With no runtime left, closing still clears the stored gate.
    let sessions = owner_sessions(state, None, session_id)
        .await
        .unwrap_or_else(new_sdk_sessions);
    let request = GateCloseRequest {
        db_session_id: session_id,
        request_id: Some(request_id),
        reason: GateCloseReason::Escape,
        ref_id: None,
    };
    close_gate(state, &sessions, &SessionOutput::headless(), request)
        .await
        .map_err(close_error)?;
    Ok(Vec::new())
}

fn rejects_the_plan(decision: &GateDecision) -> bool {
    matches!(
        decision,
        GateDecision::Plan {
            action: PlanAction::Reject,
            ..
        }
    )
}

fn close_error(error: CommandError) -> AppError {
    let status = match error.code {
        "STALE_GATE" => StatusCode::CONFLICT,
        "SESSION_NOT_FOUND" => StatusCode::NOT_FOUND,
        "SDK_ERROR" => StatusCode::BAD_GATEWAY,
        _ => StatusCode::INTERNAL_SERVER_ERROR,
    };
    AppError::coded(status, error.code, error.message)
}

#[cfg(test)]
mod tests {
    use axum::extract::ws::Message;

    use super::*;
    use crate::shared::migrate::{run_migrations, MigrationContext};

    async fn state_with_plan_gate() -> AppState {
        let pool = sqlx::SqlitePool::connect("sqlite::memory:").await.unwrap();
        run_migrations(&MigrationContext::pool_only(&pool))
            .await
            .unwrap();
        let plan = serde_json::json!({
            "request_id": "plan-9",
            "tool_name": "ExitPlanMode",
            "tool_input": {"plan": "Create hello.txt"},
            "description": "Plan is ready for approval",
            "options": []
        });
        sqlx::query(
            "INSERT INTO projects (id, name, path) VALUES (7, 'P', '/tmp/p');
             INSERT INTO features (id, project_id, title, status, type)
             VALUES (5, 7, 'Plan', 'active', 'ws-session');",
        )
        .execute(&pool)
        .await
        .unwrap();
        sqlx::query(
            "INSERT INTO agent_sessions (id, feature_id, agent_type, status, runtime_provider, pending_permission)
             VALUES (9, 5, 'session', 'running', 'claude_code', ?)",
        )
        .bind(plan.to_string())
        .execute(&pool)
        .await
        .unwrap();
        AppState::with_pool(pool)
    }

    /// Rejecting a plan is the desktop's "Reject & Stop": the gate closes and
    /// every viewer hears of it, rather than the plan being denied and the
    /// agent asked to plan again.
    #[tokio::test]
    async fn rejecting_a_plan_closes_its_gate_for_every_viewer() {
        let state = state_with_plan_gate().await;
        let (viewer, mut viewer_rx) = tokio::sync::mpsc::unbounded_channel();
        state.ws_feature_senders.register(5, viewer).await;
        let reject = GateDecision::Plan {
            action: PlanAction::Reject,
            message: None,
        };

        let warnings = answer_gate(&state, 9, "plan-9", &reject).await.unwrap();

        assert!(warnings.is_empty());
        let stored: Option<String> =
            sqlx::query_scalar("SELECT pending_permission FROM agent_sessions WHERE id = 9")
                .fetch_one(&state.read_pool)
                .await
                .unwrap();
        assert_eq!(stored, None, "the gate is closed for good");
        let Ok(Message::Text(text)) = viewer_rx.try_recv() else {
            panic!("the viewer hears the gate closed");
        };
        let envelope: serde_json::Value = serde_json::from_str(&text).unwrap();
        assert_eq!(envelope["action"], "gate.closed");
        assert_eq!(envelope["payload"]["request_id"], "plan-9");
        assert_eq!(envelope["payload"]["reason"], "escape");
    }

    #[test]
    fn only_a_plan_rejection_closes_the_gate() {
        let plan = |action| GateDecision::Plan {
            action,
            message: None,
        };
        assert!(rejects_the_plan(&plan(PlanAction::Reject)));
        assert!(!rejects_the_plan(&plan(PlanAction::RequestChanges)));
        assert!(!rejects_the_plan(&plan(PlanAction::Approve)));
    }
}
