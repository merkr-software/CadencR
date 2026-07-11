use tracing::error;

use super::audit::{elapsed_ms, record_tool_audit, result_size_bytes, ToolAudit};
use super::gate_envelope::{build_gate_envelope, GateEnvelopeMetadata};
use super::requester_delivery::deliver_gate;
use super::scope::resolve_session_scope;
use crate::app_state::AppState;
use crate::error::AppError;

pub(crate) fn spawn_gate_notification(
    state: AppState,
    child_session_id: i64,
    payload: serde_json::Value,
) {
    tokio::spawn(async move {
        if let Err(cause) = notify_linked_parent(&state, child_session_id, &payload).await {
            error!(child_session_id, error = %cause, "failed to notify linked parent about child gate");
        }
    });
}

async fn notify_linked_parent(
    state: &AppState,
    child_session_id: i64,
    payload: &serde_json::Value,
) -> Result<(), AppError> {
    let started_at = std::time::Instant::now();
    let Some(parent_session_id) = linked_parent(&state.read_pool, child_session_id).await? else {
        return Ok(());
    };
    let (child, parent) = tokio::try_join!(
        resolve_session_scope(&state.write_pool, child_session_id),
        resolve_session_scope(&state.write_pool, parent_session_id),
    )?;
    let request_id = payload
        .get("request_id")
        .and_then(serde_json::Value::as_str)
        .ok_or_else(|| AppError::Internal("gate notification payload has no request_id".into()))?;
    let Some(gate) = state
        .pending_gates
        .find_pending(child_session_id, request_id)
        .await
    else {
        return Ok(());
    };
    let envelope = build_gate_envelope(
        GateEnvelopeMetadata {
            child_session_id,
            child_feature_id: child.feature_id,
            child_feature_title: &child.feature_title,
            child_project_id: child.project_id,
            kind: gate.kind.as_str(),
            request_id: &gate.request_id,
        },
        payload,
    )
    .map_err(|error| AppError::Internal(format!("failed to serialize gate envelope: {error}")))?;
    let delivery = deliver_gate(state, &child, &parent, &envelope).await;
    let delivery_error = delivery.as_ref().err().map(ToString::to_string);
    record_tool_audit(
        &state.write_pool,
        ToolAudit {
            server_name: "cadencr-project",
            tool_name: "project_gate_notification",
            source_session_id: Some(child.session_id),
            source_feature_id: Some(child.feature_id),
            source_project_id: Some(child.project_id),
            target_session_id: Some(parent.session_id),
            target_feature_id: Some(parent.feature_id),
            target_project_id: Some(parent.project_id),
            status: if delivery_error.is_some() {
                "error"
            } else {
                "ok"
            },
            result_size_bytes: result_size_bytes(&envelope),
            latency_ms: elapsed_ms(started_at),
            error: delivery_error.as_deref(),
        },
    )
    .await?;
    delivery
}

pub(super) async fn linked_parent(
    pool: &sqlx::SqlitePool,
    child_session_id: i64,
) -> Result<Option<i64>, AppError> {
    Ok(sqlx::query_scalar(
        "SELECT source_session_id FROM agent_session_links
         WHERE target_session_id = ? AND link_type IN ('spawned', 'handoff')
         ORDER BY id DESC LIMIT 1",
    )
    .bind(child_session_id)
    .fetch_optional(pool)
    .await?)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::gate_registry::PendingGate;
    use crate::shared::migrate::{run_migrations, MigrationContext};

    #[tokio::test]
    async fn linked_child_gate_is_enqueued_when_parent_has_its_own_gate() {
        let pool = sqlx::SqlitePool::connect("sqlite::memory:").await.unwrap();
        run_migrations(&MigrationContext {
            pool: &pool,
            db_path: None,
            app_version: None,
        })
        .await
        .unwrap();
        seed(&pool).await;
        let state = AppState::with_pool(pool.clone());
        let payload = serde_json::json!({
            "request_id": "req-42", "tool_name": "Bash",
            "options": [{"decision": "allow_once", "label": "Allow once"}]
        });
        state
            .pending_gates
            .register(
                22,
                PendingGate {
                    request_id: "req-42".into(),
                    kind: crate::domain::gate_registry::GateKind::Permission,
                    payload: payload.clone(),
                },
            )
            .await;

        notify_linked_parent(&state, 22, &payload).await.unwrap();

        let content: String = sqlx::query_scalar(
            "SELECT content FROM agent_session_message_queue WHERE target_session_id = 11",
        )
        .fetch_one(&pool)
        .await
        .unwrap();
        assert!(content.contains("<cadencr-gate"));
        assert!(content.contains("request-id=\"req-42\""));
        assert!(content.contains("Allow once"));
    }

    async fn seed(pool: &sqlx::SqlitePool) {
        sqlx::query("INSERT INTO projects (id, name, path) VALUES (1, 'P', '/tmp/p')")
            .execute(pool)
            .await
            .unwrap();
        sqlx::query("INSERT INTO features (id, project_id, title, status, type) VALUES (1, 1, 'Parent', 'active', 'ws-session'), (2, 1, 'Child', 'active', 'ws-session')")
            .execute(pool).await.unwrap();
        sqlx::query("INSERT INTO agent_sessions (id, feature_id, agent_type, status, runtime_provider) VALUES (11, 1, 'session', 'awaiting_question', 'missing'), (22, 2, 'session', 'running', 'missing')")
            .execute(pool).await.unwrap();
        sqlx::query("INSERT INTO agent_session_links (source_session_id, target_session_id, link_type) VALUES (11, 22, 'spawned')")
            .execute(pool).await.unwrap();
    }
}
