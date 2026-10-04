use axum::extract::ws::Message;

use super::super::super::persistence::WsSessionPersistence;
use super::super::super::protocol::*;
use super::super::helpers::send_error;
use super::super::post_plan_mode::{
    should_transition_after_plan_approval, transition_session_to_post_plan_mode,
};
use super::super::session_prompt::PermissionResponse;
use super::super::types::{QueryState, SdkSessions, WsSender};
use super::permission_dispatch::finish_gate_claim;
use super::permission_gate::clear_answered_gate_preserving_replacement;
use super::permission_user_message::persist_question_answer;
use crate::app_state::AppState;
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

fn acknowledge_permission_response(sender: &WsSender, envelope_id: &str) {
    let ack = WsEnvelope::reply(
        envelope_id,
        "session",
        "acknowledged",
        serde_json::json!({ "action": "permission.respond" }),
    );
    let _ = sender.send(Message::Text(String::from(ack).into()));
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
    sender: &WsSender,
    envelope_id: &str,
    app_state: &AppState,
    db_session_id: i64,
    feature_id: i64,
    permission_kind: RuntimePermissionResponseKind,
    payload: &PermissionRespondPayload,
    answer_to_persist: Option<&serde_json::Value>,
) -> Option<crate::domain::session_status::AgentStatus> {
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
    if denial_completes_session {
        clear_runtime_resolved_gate(app_state, db_session_id).await;
    } else {
        match clear_answered_gate_preserving_replacement(
            &app_state.write_pool,
            db_session_id,
            &payload.request_id,
        )
        .await
        {
            Ok(_) => {}
            Err(error) => {
                send_error(sender, envelope_id, "DB_ERROR", &error.to_string());
                return None;
            }
        }
    };
    acknowledge_permission_response(sender, envelope_id);
    if denial_completes_session {
        WsSessionPersistence::mark_completed_static(&app_state.write_pool, db_session_id).await;
        let ended = WsEnvelope::new(
            "session",
            "ended",
            serde_json::to_value(SessionEndedPayload {
                reason: "permission_denied".into(),
                ..Default::default()
            })
            .unwrap(),
        );
        let _ = sender.send(Message::Text(String::from(ended).into()));
    }
    persist_question_answer(
        app_state,
        sender,
        envelope_id,
        feature_id,
        db_session_id,
        answer_to_persist,
        payload.message_uuid.as_deref(),
    )
    .await;
    Some(next_status)
}

async fn clear_runtime_resolved_gate(app_state: &AppState, db_session_id: i64) {
    // In-SDK permission handlers may only use the live broadcast path; clear
    // defensively in case a reconnect-safe pending row also exists.
    WsSessionPersistence::clear_all_pending_user_input_static(&app_state.write_pool, db_session_id)
        .await;
}

async fn send_permission_channel_response(
    permission_tx: tokio::sync::mpsc::Sender<PermissionResponse>,
    payload: PermissionRespondPayload,
    sender: &WsSender,
    envelope_id: &str,
    app_state: &AppState,
    feature_id: i64,
    db_session_id: i64,
    answer_to_persist: Option<serde_json::Value>,
) -> bool {
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

    if permission_tx.send(response).await.is_err() {
        send_error(
            sender,
            envelope_id,
            "CHANNEL_ERROR",
            "Permission channel closed",
        );
        false
    } else {
        acknowledge_permission_response(sender, envelope_id);
        persist_question_answer(
            app_state,
            sender,
            envelope_id,
            feature_id,
            db_session_id,
            answer_to_persist.as_ref(),
            message_uuid.as_deref(),
        )
        .await;
        true
    }
}

async fn resolve_permission_runtime(
    sdk_sessions: &SdkSessions,
    app_state: &AppState,
    db_session_id: i64,
    sender: &WsSender,
    envelope_id: &str,
) -> Option<ResolvedPermissionRuntime> {
    let effective_sessions =
        super::resolve_owner_sessions(sdk_sessions, app_state, db_session_id).await;
    let active = match lookup_active_permission_handle(&effective_sessions, db_session_id).await {
        ActivePermissionLookup::Found(handle) => handle,
        ActivePermissionLookup::NotFound => {
            send_error(
                sender,
                envelope_id,
                "SESSION_NOT_FOUND",
                "Session not found",
            );
            return None;
        }
        ActivePermissionLookup::NotActive => {
            send_error(
                sender,
                envelope_id,
                "INVALID_STATE",
                "Session not yet active",
            );
            return None;
        }
    };
    Some(ResolvedPermissionRuntime {
        sdk_sessions: effective_sessions,
        active,
    })
}

async fn respond_runtime_permission(
    runtime: &ResolvedPermissionRuntime,
    payload: &PermissionRespondPayload,
    db_session_id: i64,
    app_state: &AppState,
    sender: &WsSender,
    envelope_id: &str,
) -> Option<RuntimePermissionOutcome> {
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
            &app_state.write_pool,
            sender,
        )
        .await
        {
            send_error(
                sender,
                envelope_id,
                "SDK_ERROR",
                &format!("Failed to apply post-plan permission mode: {error}"),
            );
            return None;
        }
    }
    let respond_result = {
        let q = runtime.active.query.read().await;
        q.respond_permission(runtime_response).await
    };
    let uses_legacy_channel = runtime_adapter(&runtime.active.runtime_provider)
        .is_some_and(|adapter| adapter.uses_legacy_permission_channel_on_response_error());
    match respond_result {
        Ok(()) => Some(RuntimePermissionOutcome::Accepted(permission_kind)),
        Err(_) if uses_legacy_channel => Some(RuntimePermissionOutcome::UsePermissionChannel),
        Err(error) => {
            send_error(
                sender,
                envelope_id,
                "RUNTIME_PERMISSION_ERROR",
                &error.to_string(),
            );
            None
        }
    }
}

pub(super) async fn respond_permission_claimed(
    payload: PermissionRespondPayload,
    envelope_id: &str,
    sender: &WsSender,
    sdk_sessions: &SdkSessions,
    app_state: &AppState,
    db_session_id: i64,
) {
    let Some(runtime) =
        resolve_permission_runtime(sdk_sessions, app_state, db_session_id, sender, envelope_id)
            .await
    else {
        app_state
            .pending_gates
            .release(db_session_id, &payload.request_id)
            .await;
        return;
    };
    let answer_to_persist = payload.updated_input.clone();
    let resolution = crate::domain::session_status::SessionStatusEvent::builder()
        .session_id(db_session_id)
        .feature_id(runtime.active.feature_id)
        .resolved_request_id(payload.request_id.clone())
        .maybe_turn_started_at_ms(app_state.active_turns.started_at(db_session_id).await);
    match respond_runtime_permission(
        &runtime,
        &payload,
        db_session_id,
        app_state,
        sender,
        envelope_id,
    )
    .await
    {
        Some(RuntimePermissionOutcome::Accepted(permission_kind)) => {
            let next_status = finish_accepted_runtime_permission(
                sender,
                envelope_id,
                app_state,
                db_session_id,
                runtime.active.feature_id,
                permission_kind,
                &payload,
                answer_to_persist.as_ref(),
            )
            .await;
            finish_gate_claim(
                app_state,
                resolution
                    .status(
                        next_status.unwrap_or(crate::domain::session_status::AgentStatus::Agent),
                    )
                    .build(),
                next_status.is_some(),
            )
            .await;
            return;
        }
        Some(RuntimePermissionOutcome::UsePermissionChannel) => {}
        None => {
            app_state
                .pending_gates
                .release(db_session_id, &payload.request_id)
                .await;
            return;
        }
    }
    let succeeded = send_permission_channel_response(
        runtime.active.permission_tx,
        payload,
        sender,
        envelope_id,
        app_state,
        runtime.active.feature_id,
        db_session_id,
        answer_to_persist,
    )
    .await;
    finish_gate_claim(
        app_state,
        resolution
            .status(crate::domain::session_status::AgentStatus::Agent)
            .build(),
        succeeded,
    )
    .await;
}
