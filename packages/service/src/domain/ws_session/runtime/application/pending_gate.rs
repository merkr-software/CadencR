use sqlx::SqlitePool;
use tracing::error;

use crate::app_state::AppState;
use crate::domain::gate_registry::{GateKind, GateRegistry, PendingGate};
use crate::domain::session_status::{AgentStatus, SessionStatusBroadcaster};
use crate::domain::ws_session::persistence::{
    PendingUserInput, PendingUserInputKind, WsSessionPersistence,
};

/// Compose gate publication with the linked-parent notification service.
pub(crate) async fn mark_awaiting_user(
    state: &AppState,
    session_id: i64,
    feature_id: i64,
    input: &PendingUserInput<'_>,
) {
    let notification = persist_and_broadcast_gate(
        &state.write_pool,
        &state.pending_gates,
        &state.session_status_tx,
        PendingGateInput {
            session_id,
            feature_id,
            input,
        },
    )
    .await;
    if let Some(notification) = notification {
        crate::domain::mcp::control::gate_notify::spawn_gate_notification(
            state.clone(),
            notification.session_id,
            notification.payload,
        );
    }
}

/// Clear the persisted gate before publishing the next status.
pub(crate) async fn mark_agent_resumed(
    pool: &SqlitePool,
    broadcaster: &SessionStatusBroadcaster,
    session_id: i64,
    feature_id: i64,
    kind: PendingUserInputKind,
    next_status: AgentStatus,
) {
    debug_assert!(matches!(
        next_status,
        AgentStatus::Agent | AgentStatus::Idle
    ));
    WsSessionPersistence::clear_pending_user_input_static(pool, session_id, kind).await;
    broadcaster.broadcast(session_id, feature_id, next_status, None);
}

struct PendingGateInput<'a, 'payload> {
    session_id: i64,
    feature_id: i64,
    input: &'a PendingUserInput<'payload>,
}

/// Notification request produced by gate publication.
struct GateNotification {
    session_id: i64,
    payload: serde_json::Value,
}

async fn persist_and_broadcast_gate(
    pool: &SqlitePool,
    pending_gates: &GateRegistry,
    broadcaster: &SessionStatusBroadcaster,
    request: PendingGateInput<'_, '_>,
) -> Option<GateNotification> {
    let PendingGateInput {
        session_id,
        feature_id,
        input,
    } = request;
    let fallback_kind = input.kind().as_session_kind();
    WsSessionPersistence::set_pending_user_input_static(pool, session_id, input).await;
    let registered = register_gate(pending_gates, session_id, input).await;
    if let Some(gate) = &registered {
        // The registry recognizes question tools even when their payload was
        // stored on the permission column, and keeps plan approval semantics.
        broadcaster.broadcast_gate(
            session_id,
            feature_id,
            gate.kind.as_session_kind(),
            gate.request_id.clone(),
        );
    } else {
        broadcaster.broadcast(
            session_id,
            feature_id,
            AgentStatus::Question,
            Some(fallback_kind),
        );
    }
    registered.map(|gate| GateNotification {
        session_id,
        payload: gate.payload,
    })
}

async fn register_gate(
    pending_gates: &GateRegistry,
    session_id: i64,
    input: &PendingUserInput<'_>,
) -> Option<PendingGate> {
    let payload = match input {
        PendingUserInput::Permission(payload) => serde_json::to_value(payload),
        PendingUserInput::Question(payload) => Ok((*payload).clone()),
    };
    let payload = match payload {
        Ok(payload) => payload,
        Err(error) => {
            error!(session_id, %error, "failed to serialize pending gate for escalation");
            return None;
        }
    };
    let Some(request_id) = payload
        .get("request_id")
        .and_then(serde_json::Value::as_str)
    else {
        error!(
            session_id,
            "pending gate payload has no request_id; escalation unavailable"
        );
        return None;
    };
    let gate = PendingGate {
        request_id: request_id.to_string(),
        kind: GateKind::from_pending(
            input.kind(),
            payload
                .get("tool_name")
                .and_then(serde_json::Value::as_str)
                .unwrap_or_default(),
        ),
        payload,
    };
    pending_gates.register(session_id, gate.clone()).await;
    Some(gate)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::gate_registry::GateClaimError;
    use crate::domain::session_status::PendingKind;
    use crate::domain::ws_session::protocol::PermissionRequestPayload;

    struct GateServices {
        pool: SqlitePool,
        gates: GateRegistry,
        broadcaster: SessionStatusBroadcaster,
    }

    impl GateServices {
        async fn new() -> Self {
            let pool = SqlitePool::connect("sqlite::memory:").await.unwrap();
            sqlx::query(
                "CREATE TABLE agent_sessions (id INTEGER PRIMARY KEY,
                 pending_permission TEXT, pending_questions TEXT)",
            )
            .execute(&pool)
            .await
            .unwrap();
            sqlx::query("INSERT INTO agent_sessions (id) VALUES (7)")
                .execute(&pool)
                .await
                .unwrap();
            let (tx, _) = tokio::sync::broadcast::channel(16);
            Self {
                pool,
                gates: GateRegistry::new(),
                broadcaster: SessionStatusBroadcaster::new(tx),
            }
        }

        async fn publish(&self, input: &PendingUserInput<'_>) -> Option<GateNotification> {
            persist_and_broadcast_gate(
                &self.pool,
                &self.gates,
                &self.broadcaster,
                PendingGateInput {
                    session_id: 7,
                    feature_id: 42,
                    input,
                },
            )
            .await
        }
    }

    fn permission_payload() -> PermissionRequestPayload {
        PermissionRequestPayload {
            request_id: "r1".into(),
            tool_name: "Bash".into(),
            tool_input: serde_json::json!({"command": "ls"}),
            description: Some("run ls".into()),
            pattern: Some("Bash(ls:*)".into()),
            preview: None,
            options: Vec::new(),
        }
    }

    #[tokio::test]
    async fn mark_awaiting_user_writes_db_before_broadcasting() {
        let services = GateServices::new().await;
        let mut rx = services.broadcaster.subscribe();
        let payload = permission_payload();

        let notification = services
            .publish(&PendingUserInput::Permission(&payload))
            .await
            .unwrap();

        let persisted: String =
            sqlx::query_scalar("SELECT pending_permission FROM agent_sessions WHERE id = 7")
                .fetch_one(&services.pool)
                .await
                .unwrap();
        assert_eq!(
            serde_json::from_str::<serde_json::Value>(&persisted).unwrap()["request_id"],
            "r1"
        );
        assert_eq!(
            services.gates.latest_open(7).await.unwrap().request_id,
            "r1"
        );
        let event = rx.recv().await.unwrap();
        assert_eq!(event.session_id, 7);
        assert_eq!(event.feature_id, 42);
        assert_eq!(event.status, AgentStatus::Question);
        assert_eq!(event.kind, Some(PendingKind::Permission));
        assert_eq!(event.request_id.as_deref(), Some("r1"));
        assert!(event.seq > 0);
        assert_eq!(notification.session_id, 7);
        assert_eq!(notification.payload, serde_json::to_value(payload).unwrap());
    }

    #[tokio::test]
    async fn mark_awaiting_user_propagates_kind_for_question() {
        let services = GateServices::new().await;
        let mut rx = services.broadcaster.subscribe();
        let question = serde_json::json!({"tool_name": "AskUserQuestion", "request_id": "q1"});

        services
            .publish(&PendingUserInput::Question(&question))
            .await
            .unwrap();

        let event = rx.recv().await.unwrap();
        assert_eq!(event.kind, Some(PendingKind::Question));
        assert_eq!(event.request_id.as_deref(), Some("q1"));
    }

    #[tokio::test]
    async fn ask_user_question_payload_is_registered_as_question_defensively() {
        let services = GateServices::new().await;
        let mut rx = services.broadcaster.subscribe();
        let mut payload = permission_payload();
        payload.tool_name = "AskUserQuestion".into();
        payload.tool_input = serde_json::json!({"question": "Which provider?"});

        services
            .publish(&PendingUserInput::Permission(&payload))
            .await
            .unwrap();

        let gate = services.gates.latest_open(7).await.unwrap();
        assert_eq!(gate.kind, GateKind::Question);
        assert_eq!(gate.payload["tool_input"]["question"], "Which provider?");
        assert_eq!(rx.recv().await.unwrap().kind, Some(PendingKind::Question));
    }

    #[tokio::test]
    async fn plan_gate_retains_permission_status_and_notification_payload() {
        let services = GateServices::new().await;
        let mut rx = services.broadcaster.subscribe();
        let mut payload = permission_payload();
        payload.tool_name = "ExitPlanMode".into();

        let notification = services
            .publish(&PendingUserInput::Permission(&payload))
            .await
            .unwrap();

        assert_eq!(
            services.gates.latest_open(7).await.unwrap().kind,
            GateKind::Plan
        );
        assert_eq!(rx.recv().await.unwrap().kind, Some(PendingKind::Permission));
        assert_eq!(notification.payload["tool_name"], "ExitPlanMode");
    }

    #[tokio::test]
    async fn missing_request_id_broadcasts_without_notification_or_registration() {
        let services = GateServices::new().await;
        let mut rx = services.broadcaster.subscribe();
        let question = serde_json::json!({"tool_name": "AskUserQuestion"});

        assert!(services
            .publish(&PendingUserInput::Question(&question))
            .await
            .is_none());

        assert!(services.gates.latest_open(7).await.is_none());
        let event = rx.recv().await.unwrap();
        assert_eq!(event.kind, Some(PendingKind::Question));
        assert_eq!(event.request_id, None);
    }

    #[tokio::test]
    async fn repeated_gate_publication_does_not_reopen_an_active_claim() {
        let services = GateServices::new().await;
        let payload = permission_payload();
        services
            .publish(&PendingUserInput::Permission(&payload))
            .await
            .unwrap();
        services.gates.claim(7, "r1").await.unwrap();

        services
            .publish(&PendingUserInput::Permission(&payload))
            .await
            .unwrap();

        assert_eq!(
            services.gates.claim(7, "r1").await,
            Err(GateClaimError::AlreadyClaimed)
        );
    }

    #[tokio::test]
    async fn mark_agent_resumed_clears_db_before_broadcasting_agent_or_idle() {
        for next_status in [AgentStatus::Agent, AgentStatus::Idle] {
            let services = GateServices::new().await;
            let payload = permission_payload();
            services
                .publish(&PendingUserInput::Permission(&payload))
                .await
                .unwrap();
            let mut rx = services.broadcaster.subscribe();

            mark_agent_resumed(
                &services.pool,
                &services.broadcaster,
                7,
                42,
                PendingUserInputKind::Permission,
                next_status,
            )
            .await;

            let persisted: Option<String> =
                sqlx::query_scalar("SELECT pending_permission FROM agent_sessions WHERE id = 7")
                    .fetch_one(&services.pool)
                    .await
                    .unwrap();
            assert!(persisted.is_none());
            let event = rx.recv().await.unwrap();
            assert_eq!(event.feature_id, 42);
            assert_eq!(event.status, next_status);
            assert_eq!(event.kind, None);
        }
    }
}
