use crate::domain::ws_session::persistence::WsSessionPersistence;
use axum::extract::ws::Message;

use super::super::output::{CommandError, CommandOutput, OutputTarget};
use super::super::post_plan_mode::{
    should_transition_after_plan_approval, transition_session_to_post_plan_mode,
};
use super::super::prompt::PermissionResponse;
use super::super::state::{QueryState, SdkSessions};
use crate::domain::ws_session::protocol::*;

use super::permission_context::PermissionContext;
use super::permission_pending::clear_answered_gate_preserving_replacement;
use super::permission_user_message::persist_question_answer;
use crate::domain::agents::adapter::{
    RuntimePermissionResponse, RuntimePermissionResponseKind, RuntimeSessionHandle,
};
use crate::domain::agents::runtime_adapter;

struct ActivePermissionHandle {
    feature_id: i64,
    runtime_provider: String,
    query: RuntimeSessionHandle,
    permission_tx: tokio::sync::mpsc::Sender<PermissionResponse>,
}

struct ResolvedPermissionRuntime {
    sdk_sessions: SdkSessions,
    active: ActivePermissionHandle,
}

enum ActivePermissionLookup {
    Found(ActivePermissionHandle),
    NotFound,
    NotActive,
}

enum RuntimePermissionOutcome {
    Accepted(RuntimePermissionResponseKind),
    UsePermissionChannel,
}

async fn lookup_active_permission_handle(
    sdk_sessions: &SdkSessions,
    db_session_id: i64,
) -> ActivePermissionLookup {
    let sessions = sdk_sessions.lock().await;
    let Some(handle) = sessions.get(&db_session_id) else {
        return ActivePermissionLookup::NotFound;
    };
    let QueryState::Active {
        query,
        permission_tx,
    } = &handle.state
    else {
        return ActivePermissionLookup::NotActive;
    };
    ActivePermissionLookup::Found(ActivePermissionHandle {
        feature_id: handle.feature_id,
        runtime_provider: handle.runtime_provider.clone(),
        query: std::sync::Arc::clone(query),
        permission_tx: permission_tx.clone(),
    })
}

async fn finish_accepted_runtime_permission(
    output: &CommandOutput,
    context: &PermissionContext<'_>,
    db_session_id: i64,
    feature_id: i64,
    permission_kind: RuntimePermissionResponseKind,
    payload: &PermissionRespondPayload,
    answer_to_persist: Option<&serde_json::Value>,
) -> Result<PermissionResponseOutcome, CommandError> {
    let is_plan_approval = permission_kind == RuntimePermissionResponseKind::PlanApproval;
    let turn_feedback = if is_plan_approval {
        Some(payload.feedback.as_deref().unwrap_or("Plan feedback"))
    } else {
        payload.feedback.as_deref()
    };
    let next_status = crate::domain::permission_bridge::status_after_runtime_permission(
        permission_kind,
        payload.decision.clone(),
        turn_feedback,
    );
    let denial_completes_session =
        crate::domain::permission_bridge::runtime_permission_denial_completes_session(
            permission_kind,
            payload.decision.clone(),
            turn_feedback,
        );
    let mut warnings = Vec::new();
    let has_pending_gate = if denial_completes_session {
        if let Err(error) = WsSessionPersistence::try_clear_all_pending_user_input_static(
            context.write_pool,
            db_session_id,
        )
        .await
        {
            warnings.push(accepted_persistence_warning(error));
        }
        false
    } else {
        match clear_answered_gate_preserving_replacement(
            context.write_pool,
            db_session_id,
            &payload.request_id,
        )
        .await
        {
            Ok(has_replacement) => has_replacement,
            Err(error) => {
                warnings.push(accepted_persistence_warning(error));
                true
            }
        }
    };
    output.permission_accepted();
    if denial_completes_session {
        if let Err(error) =
            WsSessionPersistence::try_mark_completed_static(context.write_pool, db_session_id).await
        {
            warnings.push(accepted_persistence_warning(error));
        }
        let ended = WsEnvelope::session_event(&WsSessionEvent::Ended(SessionEndedPayload {
            reason: "permission_denied".into(),
            ..Default::default()
        }))
        .expect("session event payload should serialize");
        let _ = output
            .recipient
            .send(Message::Text(String::from(ended).into()));
    }
    warnings.extend(
        persist_question_answer(
            &context.answer_messages(),
            &output.recipient,
            feature_id,
            db_session_id,
            answer_to_persist,
            payload.message_uuid.as_deref(),
        )
        .await,
    );
    if !has_pending_gate {
        context.session_status.broadcast_gate_resolved(
            db_session_id,
            feature_id,
            &payload.request_id,
            next_status,
        );
    }
    Ok(PermissionResponseOutcome { warnings })
}

fn accepted_persistence_warning(error: sqlx::Error) -> CommandError {
    CommandError::new("DB_ERROR", format!("Provider accepted the response, but gate state was not persisted: {error}. This response was accepted; persisted state may reappear after restart or gate-cache eviction."))
}

async fn send_permission_channel_response(
    permission_tx: tokio::sync::mpsc::Sender<PermissionResponse>,
    payload: PermissionRespondPayload,
    output: &CommandOutput,
    context: &PermissionContext<'_>,
    feature_id: i64,
    db_session_id: i64,
    answer_to_persist: Option<serde_json::Value>,
) -> Result<PermissionResponseOutcome, CommandError> {
    let message_uuid = payload.message_uuid.clone();
    let response = PermissionResponse {
        request_id: payload.request_id,
        message_uuid: message_uuid.clone(),
        decision: payload.decision,
        option_id: payload.option_id,
        feedback: payload.feedback,
        updated_input: payload.updated_input,
        is_approval_gate: false,
    };

    permission_tx
        .send(response)
        .await
        .map_err(|_| CommandError::new("CHANNEL_ERROR", "Permission channel closed"))?;
    output.permission_accepted();
    let warnings = persist_question_answer(
        &context.answer_messages(),
        &output.recipient,
        feature_id,
        db_session_id,
        answer_to_persist.as_ref(),
        message_uuid.as_deref(),
    )
    .await;
    Ok(PermissionResponseOutcome { warnings })
}

async fn resolve_permission_runtime(
    sdk_sessions: &SdkSessions,
    context: &PermissionContext<'_>,
    db_session_id: i64,
) -> Result<ResolvedPermissionRuntime, CommandError> {
    let effective_sessions = super::super::control_policy::resolve_owner_sessions(
        sdk_sessions,
        context.active_turns,
        db_session_id,
    )
    .await;
    let active = match lookup_active_permission_handle(&effective_sessions, db_session_id).await {
        ActivePermissionLookup::Found(handle) => handle,
        ActivePermissionLookup::NotFound => {
            return Err(CommandError::new("SESSION_NOT_FOUND", "Session not found"))
        }
        ActivePermissionLookup::NotActive => {
            return Err(CommandError::new("INVALID_STATE", "Session not yet active"))
        }
    };
    Ok(ResolvedPermissionRuntime {
        sdk_sessions: effective_sessions,
        active,
    })
}

async fn respond_runtime_permission(
    runtime: &ResolvedPermissionRuntime,
    payload: &PermissionRespondPayload,
    db_session_id: i64,
    context: &PermissionContext<'_>,
    output: &CommandOutput,
) -> Result<RuntimePermissionOutcome, CommandError> {
    let runtime_response = RuntimePermissionResponse {
        request_id: payload.request_id.clone(),
        decision: payload
            .decision
            .to_runtime_decision(payload.option_id.as_deref()),
        option_id: payload.option_id.clone(),
        feedback: payload.feedback.clone(),
        updated_input: payload.updated_input.clone(),
    };
    let permission_kind = {
        let q = runtime.active.query.read().await;
        q.permission_response_kind(&payload.request_id)
    };
    if should_transition_after_plan_approval(permission_kind, runtime_response.decision) {
        if let Err(error) = transition_session_to_post_plan_mode(
            &runtime.sdk_sessions,
            db_session_id,
            context.write_pool,
            &output.recipient,
        )
        .await
        {
            return Err(CommandError::new(
                "SDK_ERROR",
                format!("Failed to apply post-plan permission mode: {error}"),
            ));
        }
    }
    let respond_result = {
        let q = runtime.active.query.read().await;
        q.respond_permission(runtime_response).await
    };
    let uses_legacy_channel = runtime_adapter(&runtime.active.runtime_provider)
        .is_some_and(|adapter| adapter.uses_legacy_permission_channel_on_response_error());
    match respond_result {
        Ok(()) => Ok(RuntimePermissionOutcome::Accepted(permission_kind)),
        Err(_) if uses_legacy_channel => Ok(RuntimePermissionOutcome::UsePermissionChannel),
        Err(error) => Err(CommandError::new("RUNTIME_PERMISSION_ERROR", error)),
    }
}

#[derive(Debug)]
pub(crate) struct PermissionResponseOutcome {
    /// Delivery has already been accepted; these must never cause a retry.
    pub(crate) warnings: Vec<CommandError>,
}

pub(crate) async fn respond_permission(
    context: &PermissionContext<'_>,
    sdk_sessions: &SdkSessions,
    payload: PermissionRespondPayload,
    output: &CommandOutput,
) -> Result<PermissionResponseOutcome, CommandError> {
    if payload
        .message_uuid
        .as_deref()
        .is_some_and(|value| uuid::Uuid::parse_str(value).is_err())
    {
        return Err(CommandError::new(
            "INVALID_MESSAGE_UUID",
            "message_uuid must be a valid UUID",
        ));
    }
    let session_id = payload
        .session_id
        .parse::<i64>()
        .map_err(|_| CommandError::new("INVALID_SESSION_ID", "Invalid session_id"))?;
    context
        .pending_gates
        .ensure_loaded(context.read_pool, session_id)
        .await
        .map_err(|error| CommandError::new("DB_ERROR", error))?;
    context
        .pending_gates
        .claim(session_id, &payload.request_id)
        .await
        .map_err(|error| {
            CommandError::new(
                "STALE_GATE",
                format!("Gate is stale, mismatched, or already answered: {error:?}"),
            )
        })?;
    let request_id = payload.request_id.clone();
    let result = respond_claimed(context, sdk_sessions, payload, output, session_id).await;
    if result.is_ok() {
        context
            .pending_gates
            .complete(session_id, &request_id)
            .await;
    } else {
        context.pending_gates.release(session_id, &request_id).await;
    }
    result
}

async fn respond_claimed(
    context: &PermissionContext<'_>,
    sdk_sessions: &SdkSessions,
    payload: PermissionRespondPayload,
    output: &CommandOutput,
    db_session_id: i64,
) -> Result<PermissionResponseOutcome, CommandError> {
    let runtime = resolve_permission_runtime(sdk_sessions, context, db_session_id).await?;
    let answer = payload.updated_input.clone();
    match respond_runtime_permission(&runtime, &payload, db_session_id, context, output).await? {
        RuntimePermissionOutcome::Accepted(kind) => {
            finish_accepted_runtime_permission(
                output,
                context,
                db_session_id,
                runtime.active.feature_id,
                kind,
                &payload,
                answer.as_ref(),
            )
            .await
        }
        RuntimePermissionOutcome::UsePermissionChannel => {
            send_permission_channel_response(
                runtime.active.permission_tx,
                payload,
                output,
                context,
                runtime.active.feature_id,
                db_session_id,
                answer,
            )
            .await
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::app_state::AppState;
    use crate::domain::agents::adapter::{
        AgentRuntimeSession, RuntimeError, RuntimeMessageRx, RuntimePermissionMode,
    };
    use crate::domain::ws_session::handler::tests::support::{
        make_in_place_effort_handle, make_test_app_state,
    };
    use crate::domain::ws_session::runtime::output::SessionOutput;
    use std::sync::{
        atomic::{AtomicUsize, Ordering},
        Arc,
    };
    use tokio::sync::{mpsc, RwLock};

    fn context(state: &AppState) -> PermissionContext<'_> {
        PermissionContext::builder()
            .read_pool(&state.read_pool)
            .write_pool(&state.write_pool)
            .pending_gates(&state.pending_gates)
            .active_turns(&state.active_turns)
            .session_status(&state.session_status_tx)
            .feature_senders(&state.ws_feature_senders)
            .feature_events(&state.feature_events_tx)
            .build()
    }

    struct PermissionRuntime {
        calls: Arc<AtomicUsize>,
    }

    #[async_trait::async_trait]
    impl AgentRuntimeSession for PermissionRuntime {
        fn take_message_rx(&mut self) -> RuntimeMessageRx {
            mpsc::channel(1).1
        }
        async fn session_id(&self) -> Option<String> {
            None
        }
        async fn stream_input(&self, _: serde_json::Value) -> Result<(), RuntimeError> {
            Ok(())
        }
        async fn interrupt(&self) -> Result<(), RuntimeError> {
            Ok(())
        }
        async fn close(&mut self) -> Result<(), RuntimeError> {
            Ok(())
        }
        async fn set_model(&self, _: &str) -> Result<(), RuntimeError> {
            Ok(())
        }
        async fn set_permission_mode(&self, _: RuntimePermissionMode) -> Result<(), RuntimeError> {
            Ok(())
        }
        async fn respond_permission(
            &self,
            _: RuntimePermissionResponse,
        ) -> Result<(), RuntimeError> {
            self.calls.fetch_add(1, Ordering::SeqCst);
            Ok(())
        }
        fn pid(&self) -> Option<u32> {
            None
        }
    }

    async fn fixture(
        fail_gate_cleanup: bool,
    ) -> (
        AppState,
        SdkSessions,
        PermissionRespondPayload,
        Arc<AtomicUsize>,
    ) {
        let state = make_test_app_state().await;
        let pending = serde_json::json!({ "request_id": "q-1", "tool_name": "AskUserQuestion", "tool_input": {"question": "Color?"}, "pattern": null });
        let id: i64 = sqlx::query_scalar("INSERT INTO agent_sessions (feature_id, agent_type, status, runtime_provider, pending_questions) VALUES (1, 'session', 'running', 'opencode', ?) RETURNING id")
            .bind(pending.to_string()).fetch_one(&state.write_pool).await.unwrap();
        let sessions = super::super::super::state::new_sdk_sessions();
        let calls = Arc::new(AtomicUsize::new(0));
        let mut handle = make_in_place_effort_handle(1);
        let (permission_tx, _) = mpsc::channel(1);
        handle.state = QueryState::Active {
            query: Arc::new(RwLock::new(Box::new(PermissionRuntime {
                calls: calls.clone(),
            }))),
            permission_tx,
        };
        sessions.lock().await.insert(id, handle);
        state.active_turns.begin_turn(id, &sessions).await;
        state.session_runtimes.bind(id, &sessions).await;
        if fail_gate_cleanup {
            sqlx::query("CREATE TRIGGER reject_gate_cleanup BEFORE UPDATE OF pending_permission, pending_questions ON agent_sessions BEGIN SELECT RAISE(FAIL, 'gate storage unavailable'); END")
                .execute(&state.write_pool).await.unwrap();
        }
        let payload = serde_json::from_value(serde_json::json!({
            "session_id": id.to_string(), "request_id": "q-1", "decision": "allow_once",
            "message_uuid": uuid::Uuid::new_v4().to_string(),
            "updated_input": {"question": "Color?", "answers": [["Blue"]]}
        }))
        .unwrap();
        (state, sessions, payload, calls)
    }

    #[tokio::test]
    async fn focused_context_accepts_and_tombstones_without_app_state() {
        use crate::domain::feature_events::FeatureEventBroadcaster;
        use crate::domain::gate_registry::{GateClaimError, GateKind, GateRegistry, PendingGate};
        use crate::domain::session_status::SessionStatusBroadcaster;
        use crate::domain::ws_session::runtime::turns::ActiveTurnRegistry;
        use crate::domain::ws_session::sender_registry::WsFeatureSenderRegistry;

        let pool = sqlx::SqlitePool::connect("sqlite::memory:").await.unwrap();
        sqlx::raw_sql("CREATE TABLE agent_sessions (id INTEGER PRIMARY KEY, pending_permission TEXT, pending_questions TEXT); INSERT INTO agent_sessions VALUES (7, '{\"request_id\":\"gate-1\"}', NULL);")
            .execute(&pool).await.unwrap();
        let gates = GateRegistry::new();
        gates
            .register(
                7,
                PendingGate {
                    request_id: "gate-1".into(),
                    kind: GateKind::Permission,
                    payload: serde_json::json!({"request_id": "gate-1"}),
                },
            )
            .await;
        let turns = ActiveTurnRegistry::new();
        let status = SessionStatusBroadcaster::new(tokio::sync::broadcast::channel(8).0);
        let events = FeatureEventBroadcaster::new(tokio::sync::broadcast::channel(8).0);
        let senders = WsFeatureSenderRegistry::new();
        let context = PermissionContext::builder()
            .read_pool(&pool)
            .write_pool(&pool)
            .pending_gates(&gates)
            .active_turns(&turns)
            .session_status(&status)
            .feature_senders(&senders)
            .feature_events(&events)
            .build();
        let owner = super::super::super::state::new_sdk_sessions();
        let calls = Arc::new(AtomicUsize::new(0));
        let mut handle = make_in_place_effort_handle(1);
        handle.state = QueryState::Active {
            query: Arc::new(RwLock::new(Box::new(PermissionRuntime {
                calls: calls.clone(),
            }))),
            permission_tx: mpsc::channel(1).0,
        };
        owner.lock().await.insert(7, handle);
        turns.begin_turn(7, &owner).await;
        let candidate = super::super::super::state::new_sdk_sessions();
        let payload = serde_json::from_value(serde_json::json!({
            "session_id": "7", "request_id": "gate-1", "decision": "allow_once"
        }))
        .unwrap();
        let output = CommandOutput {
            recipient: SessionOutput::headless(),
            correlation_id: String::new(),
        };
        let outcome = respond_permission(&context, &candidate, payload, &output)
            .await
            .unwrap();
        assert!(outcome.warnings.is_empty());
        assert_eq!(calls.load(Ordering::SeqCst), 1);
        assert_eq!(
            gates.claim(7, "gate-1").await,
            Err(GateClaimError::AlreadyClaimed)
        );
        let pending: Option<String> =
            sqlx::query_scalar("SELECT pending_permission FROM agent_sessions WHERE id = 7")
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(pending, None);
        assert!(Arc::ptr_eq(&turns.owner_sessions(7).await.unwrap(), &owner));
    }

    #[tokio::test]
    async fn headless_permission_acceptance_persists_one_answer_and_rejects_duplicate() {
        let (state, sessions, payload, calls) = fixture(false).await;
        let output = CommandOutput {
            recipient: SessionOutput::headless(),
            correlation_id: String::new(),
        };
        let outcome = respond_permission(&context(&state), &sessions, payload.clone(), &output)
            .await
            .unwrap();
        assert!(outcome.warnings.is_empty());
        assert_eq!(
            respond_permission(&context(&state), &sessions, payload.clone(), &output)
                .await
                .unwrap_err()
                .code,
            "STALE_GATE"
        );
        assert_eq!(calls.load(Ordering::SeqCst), 1);
        let messages: Vec<String> = sqlx::query_scalar(
            "SELECT content FROM agent_messages WHERE session_id = ? AND role = 'user'",
        )
        .bind(payload.session_id.parse::<i64>().unwrap())
        .fetch_all(&state.read_pool)
        .await
        .unwrap();
        assert_eq!(messages, ["Color?\nAnswer: Blue"]);
    }

    #[tokio::test]
    async fn headless_permission_reports_post_acceptance_storage_warning_without_retrying_provider()
    {
        let (state, _sessions, payload, calls) = fixture(true).await;
        let id = payload.session_id.parse::<i64>().unwrap();
        let warnings = crate::domain::mcp::control::gate_respond::dispatch_permission_response(
            &state,
            id,
            payload.clone(),
        )
        .await
        .unwrap();
        assert_eq!(warnings.len(), 1);
        assert!(warnings[0].contains("Provider accepted"));
        assert!(warnings[0].contains("after restart"));
        assert!(
            crate::domain::mcp::control::gate_respond::dispatch_permission_response(
                &state, id, payload
            )
            .await
            .is_err()
        );
        assert_eq!(calls.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn websocket_permission_ack_precedes_answer_and_correlated_storage_warning() {
        let (state, sessions, payload, calls) = fixture(true).await;
        let envelope =
            WsEnvelope::session_command(&WsSessionCommand::PermissionRespond(payload)).unwrap();
        let correlation = envelope.id.clone();
        let (sender, mut receiver) = mpsc::unbounded_channel();
        crate::domain::ws_session::handler::handle_permission_respond(
            envelope, &sender, &sessions, &state,
        )
        .await;
        let mut events = Vec::new();
        while let Ok(Message::Text(text)) = receiver.try_recv() {
            events.push(serde_json::from_str::<WsEnvelope>(&text).unwrap());
        }
        assert_eq!(
            events
                .iter()
                .map(|event| event.action.as_str())
                .collect::<Vec<_>>(),
            ["acknowledged", "user_message", "warning"]
        );
        assert_eq!(events[0].r#ref.as_deref(), Some(correlation.as_str()));
        assert_eq!(events[2].r#ref.as_deref(), Some(correlation.as_str()));
        assert_eq!(events[2].payload["code"], "DB_ERROR");
        assert_eq!(calls.load(Ordering::SeqCst), 1);
    }
}
