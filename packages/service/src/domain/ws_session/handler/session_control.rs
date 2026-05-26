use std::path::PathBuf;
use std::sync::atomic::Ordering;

use axum::extract::ws::Message;
use tracing::{error, info};

use super::super::persistence::WsSessionPersistence;
use super::super::protocol::*;
use super::post_plan_mode::{
    should_transition_after_plan_approval, transition_session_to_post_plan_mode,
};
use super::session_gate::clear_persisted_gate_and_notify;
use super::session_prompt::PermissionResponse;
use super::{
    default_permission_mode_wire, parse_permission_mode, parse_session_id, persist_and_close_query,
    provider_supports_mode, send_error, QueryState, SdkSessions, WsSender,
};
use crate::app_state::AppState;
use crate::domain::agents::adapter::{
    RuntimeError, RuntimePermissionResponse, RuntimePermissionResponseKind, RuntimeSessionHandle,
    RuntimeSpawnConfig,
};
use crate::domain::agents::permission_modes::permission_mode_wire;
use crate::domain::agents::runtime::DEFAULT_PROVIDER;
use crate::domain::agents::{adapter_for_model, runtime_adapter};
use crate::domain::workflow::worktree;
use crate::domain::ws_session::protocol::GateCloseReason;
use crate::domain::ws_session::question_answers::format_answers_plain_text;

async fn session_has_messages(
    pool: &sqlx::SqlitePool,
    session_id: i64,
) -> Result<bool, sqlx::Error> {
    sqlx::query_scalar::<_, i64>("SELECT EXISTS(SELECT 1 FROM agent_messages WHERE session_id = ?)")
        .bind(session_id)
        .fetch_one(pool)
        .await
        .map(|exists| exists != 0)
}

fn provider_for_model(current_provider: &str, model: &str) -> String {
    adapter_for_model(model)
        .map(|(provider_id, _)| provider_id)
        .map(ToOwned::to_owned)
        .unwrap_or_else(|| {
            if current_provider != DEFAULT_PROVIDER && !model.contains('/') {
                return DEFAULT_PROVIDER.to_string();
            }

            current_provider.to_string()
        })
}

async fn persist_question_answer(
    pool: sqlx::SqlitePool,
    feature_id: i64,
    db_session_id: i64,
    updated_input: Option<&serde_json::Value>,
) {
    let Some(answer_text) = updated_input.and_then(format_answers_plain_text) else {
        return;
    };
    let p = WsSessionPersistence::with_session_id(pool, feature_id, Some(db_session_id));
    p.persist_user_message(&answer_text).await;
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

fn send_provider_set_ok(
    sender: &WsSender,
    envelope_id: &str,
    provider: &str,
    supports_prompt_receipts: bool,
) {
    let reply = WsEnvelope::reply(
        envelope_id,
        "session",
        "provider.set.ok",
        serde_json::json!({
            "provider": provider,
            "supports_prompt_receipts": supports_prompt_receipts,
        }),
    );
    let _ = sender.send(Message::Text(String::from(reply).into()));
}

/// Handle session.permission.respond
pub(super) async fn handle_permission_respond(
    envelope: WsEnvelope,
    sender: &WsSender,
    sdk_sessions: &SdkSessions,
    app_state: &AppState,
) {
    let payload: PermissionRespondPayload = match serde_json::from_value(envelope.payload.clone()) {
        Ok(p) => p,
        Err(e) => {
            send_error(sender, &envelope.id, "INVALID_PAYLOAD", &e.to_string());
            return;
        }
    };

    let db_session_id = match parse_session_id(&payload.session_id) {
        Some(id) => id,
        None => {
            send_error(
                sender,
                &envelope.id,
                "INVALID_SESSION_ID",
                "Invalid session_id",
            );
            return;
        }
    };

    // Extract everything we need from the handle, then drop the sdk_sessions
    // lock before ANY `.await` that touches the DB or runtime. The lock is
    // global; holding it across `q.respond_permission()` or
    // `permission_tx.send()` blocks every other handler from making progress.
    struct ExtractedHandle {
        feature_id: i64,
        runtime_provider: String,
        active: Option<ActiveParts>,
    }
    struct ActiveParts {
        query: crate::domain::agents::adapter::RuntimeSessionHandle,
        permission_tx: tokio::sync::mpsc::Sender<PermissionResponse>,
    }

    let extracted: ExtractedHandle = {
        let sessions = sdk_sessions.lock().await;
        let handle = match sessions.get(&db_session_id) {
            Some(h) => h,
            None => {
                send_error(
                    sender,
                    &envelope.id,
                    "SESSION_NOT_FOUND",
                    "Session not found",
                );
                return;
            }
        };
        let active = match &handle.state {
            QueryState::Active {
                query,
                permission_tx,
            } => Some(ActiveParts {
                query: std::sync::Arc::clone(query),
                permission_tx: permission_tx.clone(),
            }),
            QueryState::Pending(_) => None,
        };
        ExtractedHandle {
            feature_id: handle.feature_id,
            runtime_provider: handle.runtime_provider.clone(),
            active,
        }
    };
    // sdk_sessions lock dropped here.

    if extracted.active.is_none() {
        send_error(
            sender,
            &envelope.id,
            "INVALID_STATE",
            "Session not yet active",
        );
        return;
    }
    let ActiveParts {
        query,
        permission_tx,
    } = extracted.active.expect("active presence checked above");

    let answer_to_persist = payload.updated_input.clone();

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
        let q = query.read().await;
        q.permission_response_kind(&payload.request_id)
    };
    if should_transition_after_plan_approval(permission_kind, runtime_response.decision) {
        if let Err(error) = transition_session_to_post_plan_mode(
            sdk_sessions,
            db_session_id,
            &app_state.write_pool,
            sender,
        )
        .await
        {
            send_error(
                sender,
                &envelope.id,
                "SDK_ERROR",
                &format!("Failed to apply post-plan permission mode: {error}"),
            );
            return;
        }
    }
    let respond_result = {
        let q = query.read().await;
        q.respond_permission(runtime_response).await
    };
    let is_plan_approval = permission_kind == RuntimePermissionResponseKind::PlanApproval;
    match respond_result {
        Ok(()) => {
            // Acknowledge the UI as soon as the runtime accepts the response.
            // Permission handling must not wait behind SQLite cleanup,
            // status broadcasts, or answer persistence; otherwise the
            // frontend request/response timer can expire even though the
            // ACP server request was already answered.
            acknowledge_permission_response(sender, &envelope.id);
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
            if crate::domain::permission_bridge::runtime_permission_denial_completes_session(
                permission_kind,
                payload.decision.clone(),
                turn_feedback,
            ) {
                WsSessionPersistence::mark_completed_static(&app_state.write_pool, db_session_id)
                    .await;
                let ended = WsEnvelope::new(
                    "session",
                    "ended",
                    serde_json::to_value(SessionEndedPayload {
                        reason: "permission_denied".into(),
                    })
                    .unwrap(),
                );
                let _ = sender.send(Message::Text(String::from(ended).into()));
            }
            // Providers that resolve the permission in-SDK (OpenCode) never
            // persisted a pending_* row through the `handle_needs_prompt`
            // path — their askUser lives purely in the broadcast channel.
            // Clear all pending-input columns defensively: if anything DID get
            // written (e.g. stream_reader.rs persisting OpenCode permissions
            // for reconnect-safety), this closes the gate atomically.
            WsSessionPersistence::clear_all_pending_user_input_static(
                &app_state.write_pool,
                db_session_id,
            )
            .await;
            persist_question_answer(
                app_state.write_pool.clone(),
                extracted.feature_id,
                db_session_id,
                answer_to_persist.as_ref(),
            )
            .await;
            WsSessionPersistence::broadcast_session_status(
                &app_state.session_status_tx,
                db_session_id,
                extracted.feature_id,
                next_status,
                None,
            );
            return;
        }
        Err(error) if extracted.runtime_provider != DEFAULT_PROVIDER => {
            send_error(
                sender,
                &envelope.id,
                "RUNTIME_PERMISSION_ERROR",
                &error.to_string(),
            );
            return;
        }
        Err(_) => {
            // Claude Code path: `respond_permission` is a no-op at the SDK
            // level; the response is delivered to `bridge.rs`'s
            // `wait_and_apply_decision` via the permission_tx channel below.
            // That function OWNS the DB clear + terminal broadcast, so we
            // don't touch either here.
        }
    }

    let response = PermissionResponse {
        request_id: payload.request_id,
        decision: payload.decision,
        option_id: payload.option_id,
        feedback: payload.feedback,
        updated_input: payload.updated_input,
        is_approval_gate: false,
    };

    if permission_tx.send(response).await.is_err() {
        send_error(
            sender,
            &envelope.id,
            "CHANNEL_ERROR",
            "Permission channel closed",
        );
    } else {
        acknowledge_permission_response(sender, &envelope.id);
        persist_question_answer(
            app_state.write_pool.clone(),
            extracted.feature_id,
            db_session_id,
            answer_to_persist.as_ref(),
        )
        .await;
    }
}

/// Handle session.provider.set: change the provider before the first prompt only.
pub(super) async fn handle_provider_set(
    envelope: WsEnvelope,
    sender: &WsSender,
    sdk_sessions: &SdkSessions,
    app_state: &AppState,
) {
    let payload: ProviderSetPayload = match serde_json::from_value(envelope.payload.clone()) {
        Ok(p) => p,
        Err(e) => {
            send_error(sender, &envelope.id, "INVALID_PAYLOAD", &e.to_string());
            return;
        }
    };

    let db_session_id = match parse_session_id(&payload.session_id) {
        Some(id) => id,
        None => {
            send_error(
                sender,
                &envelope.id,
                "INVALID_SESSION_ID",
                "Invalid session_id",
            );
            return;
        }
    };

    let Some(adapter) = runtime_adapter(&payload.provider) else {
        send_error(
            sender,
            &envelope.id,
            "UNSUPPORTED_PROVIDER",
            &format!(
                "Runtime provider '{}' is not implemented yet",
                payload.provider
            ),
        );
        return;
    };
    let supports_prompt_receipts = adapter.supports_prompt_receipts();

    let has_messages = match session_has_messages(&app_state.read_pool, db_session_id).await {
        Ok(value) => value,
        Err(error) => {
            error!(db_session_id, %error, "failed to verify session history before provider change");
            send_error(
                sender,
                &envelope.id,
                "DB_ERROR",
                "Failed to verify session history",
            );
            return;
        }
    };

    let mut sessions = sdk_sessions.lock().await;
    let handle = match sessions.get_mut(&db_session_id) {
        Some(h) => h,
        None => {
            send_error(
                sender,
                &envelope.id,
                "SESSION_NOT_FOUND",
                "Session not found",
            );
            return;
        }
    };

    if has_messages {
        send_error(
            sender,
            &envelope.id,
            "PROVIDER_LOCKED",
            "Provider cannot be changed after the conversation starts",
        );
        return;
    }

    match &mut handle.state {
        QueryState::Pending(options) => {
            let provider_changed = handle.runtime_provider != payload.provider;
            if provider_changed {
                handle.runtime_provider = payload.provider.clone();
                // Resume IDs are provider-specific; drop any stale value when switching providers.
                handle.resume_session_id = None;
                options.resume_session_id = None;

                // Permission modes are also provider-specific (Claude's `auto`
                // doesn't exist on Codex, Codex's `default` doesn't exist on
                // Claude, etc.). Reset the desired/spawned/options modes so
                // the next spawn picks the new provider's adapter default
                // rather than carrying stale Claude-flavored state into a
                // Codex session.
                handle.desired_permission_mode = None;
                handle.config.permission_mode = None;
                options.permission_mode = None;

                let new_mode_wire = default_permission_mode_wire(&payload.provider);
                let _ = sqlx::query("UPDATE agent_sessions SET runtime_provider = ? WHERE id = ?")
                    .bind(&payload.provider)
                    .bind(db_session_id)
                    .execute(&app_state.write_pool)
                    .await;
                WsSessionPersistence::update_permission_mode_static(
                    &app_state.write_pool,
                    db_session_id,
                    new_mode_wire,
                )
                .await;

                send_provider_set_ok(
                    sender,
                    &envelope.id,
                    &payload.provider,
                    supports_prompt_receipts,
                );

                // Broadcast the new chip state via the standard `mode.changed`
                // envelope so the FE updates through the same path as a
                // user-initiated mode change (no optimistic update).
                let mode_changed = WsEnvelope::reply(
                    &envelope.id,
                    "session",
                    "mode.changed",
                    serde_json::json!({ "mode": new_mode_wire }),
                );
                let _ = sender.send(Message::Text(String::from(mode_changed).into()));
            } else {
                // Same-provider re-set: idempotent ack, no DB writes / mode reset.
                send_provider_set_ok(
                    sender,
                    &envelope.id,
                    &payload.provider,
                    supports_prompt_receipts,
                );
            }
        }
        QueryState::Active { .. } => {
            send_error(
                sender,
                &envelope.id,
                "PROVIDER_LOCKED",
                "Provider cannot be changed after the conversation starts",
            );
        }
    }
}

/// Handle session.model.set: change the model and persist to DB.
pub(super) async fn handle_model_set(
    envelope: WsEnvelope,
    sender: &WsSender,
    sdk_sessions: &SdkSessions,
    app_state: &AppState,
) {
    let payload: ModelSetPayload = match serde_json::from_value(envelope.payload.clone()) {
        Ok(p) => p,
        Err(e) => {
            send_error(sender, &envelope.id, "INVALID_PAYLOAD", &e.to_string());
            return;
        }
    };

    let db_session_id = match parse_session_id(&payload.session_id) {
        Some(id) => id,
        None => {
            send_error(
                sender,
                &envelope.id,
                "INVALID_SESSION_ID",
                "Invalid session_id",
            );
            return;
        }
    };

    let has_messages = match session_has_messages(&app_state.read_pool, db_session_id).await {
        Ok(value) => value,
        Err(error) => {
            error!(db_session_id, %error, "failed to verify session history before model change");
            send_error(
                sender,
                &envelope.id,
                "DB_ERROR",
                "Failed to verify session history",
            );
            return;
        }
    };

    let mut sessions = sdk_sessions.lock().await;
    let handle = match sessions.get_mut(&db_session_id) {
        Some(h) => h,
        None => {
            send_error(
                sender,
                &envelope.id,
                "SESSION_NOT_FOUND",
                "Session not found",
            );
            return;
        }
    };

    let target_provider = provider_for_model(&handle.runtime_provider, &payload.model);
    if has_messages && handle.runtime_provider != target_provider {
        send_error(
            sender,
            &envelope.id,
            "PROVIDER_LOCKED",
            "Start a new session to switch providers",
        );
        return;
    }

    info!(db_session_id, model = %payload.model, "updating desired model");
    handle.desired_model = Some(payload.model.clone());

    match &mut handle.state {
        QueryState::Pending(options) => {
            options.model = Some(payload.model.clone());
            if handle.runtime_provider != target_provider {
                handle.runtime_provider = target_provider.clone();
                handle.resume_session_id = None;
                options.resume_session_id = None;
                let _ = sqlx::query("UPDATE agent_sessions SET runtime_provider = ? WHERE id = ?")
                    .bind(&target_provider)
                    .bind(db_session_id)
                    .execute(&app_state.write_pool)
                    .await;
            }
        }
        QueryState::Active { query, .. } => {
            let q = query.read().await;
            if let Err(e) = q.set_model(&payload.model).await {
                error!(db_session_id, error = %e, "failed to set model on active query");
                send_error(sender, &envelope.id, "SDK_ERROR", &e.to_string());
                return;
            }
        }
    }

    // Persist to DB
    WsSessionPersistence::update_model_static(&app_state.write_pool, db_session_id, &payload.model)
        .await;
    // Seed the new model's context window ONLY when the target adapter can
    // answer authoritatively right now (e.g. opencode knows its catalog
    // windows). Never fall back to history — for Claude Code, the CLI is the
    // source of truth and the window arrives on the first `result` event.
    // Token counts are NOT reset: the conversation history has not changed,
    // only the model has. The first `result` from the new model will stamp
    // fresh token totals.
    let target_adapter = adapter_for_model(&payload.model)
        .map(|(_, a)| a)
        .or_else(|| runtime_adapter(&handle.runtime_provider));
    let seeded_window = match target_adapter {
        Some(adapter) => adapter.context_window_for_model(&payload.model).await,
        None => None,
    };
    WsSessionPersistence::update_context_window(
        &app_state.write_pool,
        db_session_id,
        seeded_window,
    )
    .await;

    let reply = WsEnvelope::reply(
        &envelope.id,
        "session",
        "model.set.ok",
        serde_json::to_value(serde_json::json!({
            "model": payload.model,
            "context_window": seeded_window,
        }))
        .unwrap(),
    );
    let _ = sender.send(Message::Text(String::from(reply).into()));
}

/// Handle session.mode.set: change the permission mode and persist to DB.
pub(super) async fn handle_mode_set(
    envelope: WsEnvelope,
    sender: &WsSender,
    sdk_sessions: &SdkSessions,
    app_state: &AppState,
) {
    let payload: ModeSetPayload = match serde_json::from_value(envelope.payload.clone()) {
        Ok(p) => p,
        Err(e) => {
            send_error(sender, &envelope.id, "INVALID_PAYLOAD", &e.to_string());
            return;
        }
    };

    let db_session_id = match parse_session_id(&payload.session_id) {
        Some(id) => id,
        None => {
            send_error(
                sender,
                &envelope.id,
                "INVALID_SESSION_ID",
                "Invalid session_id",
            );
            return;
        }
    };

    let new_mode = parse_permission_mode(&payload.mode);

    let mut sessions = sdk_sessions.lock().await;
    let handle = match sessions.get_mut(&db_session_id) {
        Some(h) => h,
        None => {
            send_error(
                sender,
                &envelope.id,
                "SESSION_NOT_FOUND",
                "Session not found",
            );
            return;
        }
    };

    // Reject modes the active provider doesn't support — guards against a
    // stale FE catalog (e.g. user just switched provider but UI hadn't
    // re-rendered) and surfaces the failure to the user via the standard
    // error envelope rather than silently dropping the request.
    if !provider_supports_mode(&handle.runtime_provider, &new_mode) {
        send_error(
            sender,
            &envelope.id,
            "MODE_NOT_SUPPORTED",
            &format!(
                "Provider {} does not support permission mode {}",
                handle.runtime_provider, payload.mode
            ),
        );
        return;
    }

    info!(db_session_id, mode = %payload.mode, "updating permission mode");

    match &mut handle.state {
        QueryState::Pending(options) => {
            // No live CLI yet; the queued mode will be passed via
            // `Options.permission_mode` at spawn time.
            handle.desired_permission_mode = Some(new_mode.clone());
            handle.config.permission_mode = Some(new_mode.clone());
            options.permission_mode = Some(new_mode);
        }
        QueryState::Active { query, .. } => {
            let q = query.read().await;
            if let Err(e) = q.set_permission_mode(new_mode.clone()).await {
                // The CLI rejected (or never acked) the mode change.
                // Per `no-optimistic-updates.md` we leave the FE chip
                // alone, and don't mutate desired/config state until the
                // CLI accepts. Otherwise the next prompt sees desired !=
                // spawned and respawns into the rejected mode invisibly.
                error!(db_session_id, error = %e, "failed to set permission mode on active query");
                // `ControlRequestRejected` for `set_permission_mode` is
                // the recoverable case (CLI alive, refused this mode for
                // this model — e.g. Claude Code `auto` on a non-auto
                // model). Tag it with the rejected wire mode so the FE
                // can skip past it in the Shift+Tab cycle rather than
                // locking the chip.
                let payload = match &e {
                    RuntimeError::ControlRequestRejected { subtype, .. }
                        if subtype == "set_permission_mode" =>
                    {
                        SessionErrorPayload {
                            code: "MODE_REJECTED_BY_CLI".into(),
                            message: e.to_string(),
                            mode: Some(permission_mode_wire(&new_mode)),
                        }
                    }
                    _ => SessionErrorPayload {
                        code: "SDK_ERROR".into(),
                        message: e.to_string(),
                        ..Default::default()
                    },
                };
                let err = WsEnvelope::reply(
                    &envelope.id,
                    "session",
                    "error",
                    serde_json::to_value(payload).unwrap(),
                );
                let _ = sender.send(Message::Text(String::from(err).into()));
                return;
            }
            handle.desired_permission_mode = Some(new_mode.clone());
            handle.config.permission_mode = Some(new_mode.clone());
            // Track what the CLI actually accepted. Without this,
            // `plan_post_plan_mode_transition`'s "already in target mode"
            // short-circuit (post_plan_mode.rs) reads stale state and
            // may skip the post-plan-approval transition.
            handle.spawned_permission_mode = Some(new_mode);
        }
    }

    // Persist to DB
    WsSessionPersistence::update_permission_mode_static(
        &app_state.write_pool,
        db_session_id,
        &payload.mode,
    )
    .await;

    let reply = WsEnvelope::reply(
        &envelope.id,
        "session",
        "mode.changed",
        serde_json::to_value(serde_json::json!({ "mode": payload.mode })).unwrap(),
    );
    let _ = sender.send(Message::Text(String::from(reply).into()));
}

/// Handle session.effort.set: change the thinking effort for subsequent turns.
pub(super) async fn handle_effort_set(
    envelope: WsEnvelope,
    sender: &WsSender,
    sdk_sessions: &SdkSessions,
    app_state: &AppState,
) {
    let payload: EffortSetPayload = match serde_json::from_value(envelope.payload.clone()) {
        Ok(p) => p,
        Err(e) => {
            send_error(sender, &envelope.id, "INVALID_PAYLOAD", &e.to_string());
            return;
        }
    };

    let db_session_id = match parse_session_id(&payload.session_id) {
        Some(id) => id,
        None => {
            send_error(
                sender,
                &envelope.id,
                "INVALID_SESSION_ID",
                "Invalid session_id",
            );
            return;
        }
    };

    // Snapshot the (provider, model) at the moment of the change so the per-
    // model workspace default is keyed against the model that's actually in
    // use right now. If the user later switches models, that's a separate
    // event and should not back-propagate to the previous model's default.
    let (active_query, runtime_provider, current_model): (
        Option<RuntimeSessionHandle>,
        String,
        Option<String>,
    ) = {
        let mut sessions = sdk_sessions.lock().await;
        let handle = match sessions.get_mut(&db_session_id) {
            Some(h) => h,
            None => {
                send_error(
                    sender,
                    &envelope.id,
                    "SESSION_NOT_FOUND",
                    "Session not found",
                );
                return;
            }
        };

        info!(
            db_session_id,
            thinking_effort = ?payload.thinking_effort,
            "updating desired thinking effort"
        );
        handle.desired_thinking_effort = payload.thinking_effort.clone();
        handle.config.thinking_effort = payload.thinking_effort.clone();

        let provider = handle.runtime_provider.clone();
        let model = handle
            .desired_model
            .clone()
            .or_else(|| handle.spawned_model.clone());

        let active = match &mut handle.state {
            QueryState::Pending(options) => {
                options.thinking_effort = payload.thinking_effort.clone();
                None
            }
            QueryState::Active { query, .. } => Some(query.clone()),
        };
        (active, provider, model)
    };

    if let Some(query) = active_query {
        let q = query.read().await;
        let applies_in_place = q.applies_thinking_effort_in_place();
        if let Err(error) = q.set_thinking_effort(payload.thinking_effort.clone()).await {
            error!(db_session_id, %error, "failed to set thinking effort on active query");
            send_error(sender, &envelope.id, "SDK_ERROR", &error.to_string());
            return;
        }

        if applies_in_place {
            let mut sessions = sdk_sessions.lock().await;
            if let Some(handle) = sessions.get_mut(&db_session_id) {
                handle.spawned_thinking_effort = payload.thinking_effort.clone();
            }
        }
    }

    // Persist the conversation-level override (column on agent_sessions). A
    // None payload clears the override; the next session.init will fall back
    // to the per-model workspace default.
    WsSessionPersistence::update_thinking_effort_static(
        &app_state.write_pool,
        db_session_id,
        payload.thinking_effort.as_deref(),
    )
    .await;

    // Update the per-model workspace default so newly opened conversations on
    // the same model start at the level the user just chose. Resets (None)
    // intentionally do not erase the default — clearing for one conversation
    // shouldn't surprise the next new one.
    if let (Some(ref effort), Some(ref model_id)) = (&payload.thinking_effort, &current_model) {
        let key = crate::domain::settings::thinking_effort_model_key(&runtime_provider, model_id);
        if let Err(error) =
            crate::domain::workspace::repository::set_setting(&app_state.write_pool, &key, effort)
                .await
        {
            error!(
                db_session_id,
                %error,
                key = %key,
                "failed to persist per-model thinking effort default"
            );
        }
    }

    let reply = WsEnvelope::reply(
        &envelope.id,
        "session",
        "effort.set.ok",
        serde_json::to_value(serde_json::json!({
            "thinking_effort": payload.thinking_effort,
        }))
        .unwrap(),
    );
    let _ = sender.send(Message::Text(String::from(reply).into()));
}

/// Handle session.interrupt
pub(super) async fn handle_interrupt(
    envelope: WsEnvelope,
    sender: &WsSender,
    sdk_sessions: &SdkSessions,
) {
    let payload: SessionActionPayload = match serde_json::from_value(envelope.payload.clone()) {
        Ok(p) => p,
        Err(e) => {
            send_error(sender, &envelope.id, "INVALID_PAYLOAD", &e.to_string());
            return;
        }
    };

    let db_session_id = match parse_session_id(&payload.session_id) {
        Some(id) => id,
        None => {
            send_error(
                sender,
                &envelope.id,
                "INVALID_SESSION_ID",
                "Invalid session_id",
            );
            return;
        }
    };

    let active_query = {
        let sessions = sdk_sessions.lock().await;
        let handle = match sessions.get(&db_session_id) {
            Some(h) => h,
            None => {
                send_error(
                    sender,
                    &envelope.id,
                    "SESSION_NOT_FOUND",
                    "Session not found",
                );
                return;
            }
        };

        match &handle.state {
            QueryState::Active { query, .. } => Some(std::sync::Arc::clone(query)),
            QueryState::Pending(_) => {
                handle.manual_compact_cancel.store(true, Ordering::SeqCst);
                None
            }
        }
    };

    if let Some(query) = active_query {
        let q = query.read().await;
        if let Err(e) = q.interrupt().await {
            error!(db_session_id, error = %e, "interrupt failed");
            send_error(sender, &envelope.id, "SDK_ERROR", &e.to_string());
        }
    } else {
        send_error(sender, &envelope.id, "INVALID_STATE", "Session not active");
    }
}

/// Handle session.destroy: mark session as completed and close subprocess.
pub(super) async fn handle_destroy(
    envelope: WsEnvelope,
    sender: &WsSender,
    sdk_sessions: &SdkSessions,
    app_state: &AppState,
) {
    let payload: SessionActionPayload = match serde_json::from_value(envelope.payload.clone()) {
        Ok(p) => p,
        Err(e) => {
            send_error(sender, &envelope.id, "INVALID_PAYLOAD", &e.to_string());
            return;
        }
    };

    let db_session_id = match parse_session_id(&payload.session_id) {
        Some(id) => id,
        None => {
            send_error(
                sender,
                &envelope.id,
                "INVALID_SESSION_ID",
                "Invalid session_id",
            );
            return;
        }
    };

    let mut sessions = sdk_sessions.lock().await;
    let handle = match sessions.remove(&db_session_id) {
        Some(h) => h,
        None => {
            send_error(
                sender,
                &envelope.id,
                "SESSION_NOT_FOUND",
                "Session not found",
            );
            return;
        }
    };

    let feature_id = handle.feature_id;
    let runtime_provider = handle.runtime_provider.clone();

    // Close active subprocess if running
    if let QueryState::Active { query, .. } = handle.state {
        persist_and_close_query(
            &query,
            &app_state.write_pool,
            db_session_id,
            &runtime_provider,
        )
        .await;
    }

    WsSessionPersistence::mark_completed_static(&app_state.write_pool, db_session_id).await;
    WsSessionPersistence::broadcast_session_status(
        &app_state.session_status_tx,
        db_session_id,
        feature_id,
        crate::domain::session_status::AgentStatus::Idle,
        None,
    );

    let reply = WsEnvelope::reply(
        &envelope.id,
        "session",
        "ended",
        serde_json::to_value(SessionEndedPayload {
            reason: "destroyed".into(),
        })
        .unwrap(),
    );
    let _ = sender.send(Message::Text(String::from(reply).into()));
}

/// Handle session.delete: hard-delete a session and its messages from the DB.
pub(super) async fn handle_delete(
    envelope: WsEnvelope,
    sender: &WsSender,
    sdk_sessions: &SdkSessions,
    app_state: &AppState,
) {
    let payload: SessionActionPayload = match serde_json::from_value(envelope.payload.clone()) {
        Ok(p) => p,
        Err(e) => {
            send_error(sender, &envelope.id, "INVALID_PAYLOAD", &e.to_string());
            return;
        }
    };

    let db_session_id = match parse_session_id(&payload.session_id) {
        Some(id) => id,
        None => {
            send_error(
                sender,
                &envelope.id,
                "INVALID_SESSION_ID",
                "Invalid session_id",
            );
            return;
        }
    };

    // Remove from in-memory map if present (shouldn't be active, but clean up)
    sdk_sessions.lock().await.remove(&db_session_id);

    match WsSessionPersistence::delete_session_static(&app_state.write_pool, db_session_id).await {
        Ok((feature_id, agent_type)) => {
            WsSessionPersistence::broadcast_session_status(
                &app_state.session_status_tx,
                db_session_id,
                feature_id,
                crate::domain::session_status::AgentStatus::Idle,
                None,
            );

            let _ = agent_type; // agent_type kept for log/symmetry — no further branching.

            let reply = WsEnvelope::reply(
                &envelope.id,
                "session",
                "deleted",
                serde_json::json!({ "session_id": db_session_id.to_string() }),
            );
            let _ = sender.send(Message::Text(String::from(reply).into()));
        }
        Err(reason) => {
            send_error(sender, &envelope.id, "DELETE_FAILED", &reason);
        }
    }
}

/// Handle session.clear: archive conversation and reset to fresh state.
pub(super) async fn handle_clear(
    envelope: WsEnvelope,
    sender: &WsSender,
    sdk_sessions: &SdkSessions,
    app_state: &AppState,
) {
    let payload: SessionActionPayload = match serde_json::from_value(envelope.payload.clone()) {
        Ok(p) => p,
        Err(e) => {
            send_error(sender, &envelope.id, "INVALID_PAYLOAD", &e.to_string());
            return;
        }
    };

    let db_session_id = match parse_session_id(&payload.session_id) {
        Some(id) => id,
        None => {
            send_error(
                sender,
                &envelope.id,
                "INVALID_SESSION_ID",
                "Invalid session_id",
            );
            return;
        }
    };

    let mut sessions = sdk_sessions.lock().await;
    let handle = match sessions.get_mut(&db_session_id) {
        Some(h) => h,
        None => {
            send_error(
                sender,
                &envelope.id,
                "SESSION_NOT_FOUND",
                "Session not found",
            );
            return;
        }
    };

    // Close active subprocess if any, capturing runtime_session_id for archive.
    // If stream already finished (Pending with resume), extract from those options.
    let cli_sid = match &handle.state {
        QueryState::Active { query, .. } => {
            persist_and_close_query(
                query,
                &app_state.write_pool,
                db_session_id,
                &handle.runtime_provider,
            )
            .await
        }
        QueryState::Pending(opts) => opts.resume_session_id.clone(),
    };

    // Also clear the init-time resume_session_id in case it wasn't consumed yet
    let cli_sid = cli_sid.or_else(|| handle.resume_session_id.take());

    // Archive and clear in DB (pass cli_sid to avoid re-reading it)
    WsSessionPersistence::archive_and_clear(
        &app_state.write_pool,
        db_session_id,
        cli_sid.as_deref(),
    )
    .await;

    // Reset handle to Pending with fresh options (no resume)
    let fresh_options = RuntimeSpawnConfig {
        cwd: handle.config.cwd.clone(),
        permission_mode: handle.desired_permission_mode.clone(),
        model: handle.desired_model.clone(),
        thinking_effort: handle.desired_thinking_effort.clone(),
        system_prompt: handle.config.system_prompt.clone(),
        env: handle.config.env.clone(),
        ..RuntimeSpawnConfig::default()
    };
    handle.state = QueryState::Pending(fresh_options);

    let reply = WsEnvelope::reply(
        &envelope.id,
        "session",
        "cleared",
        serde_json::json!({
            "session_id": db_session_id.to_string(),
            "previous_session_id": cli_sid,
        }),
    );
    let _ = sender.send(Message::Text(String::from(reply).into()));
}

/// Broadcast a `session.lifecycle` envelope so the frontend turn-lifecycle
/// state machine flips only on backend-confirmed transitions (per
/// `no-optimistic-updates.md`). Used by both suspend and resume paths.
fn broadcast_lifecycle(sender: &WsSender, session_id: i64, kind: SessionLifecycleKind) {
    let envelope = WsEnvelope::new(
        "session",
        "lifecycle",
        serde_json::to_value(SessionLifecyclePayload {
            session_id: session_id.to_string(),
            kind,
        })
        .unwrap(),
    );
    let _ = sender.send(Message::Text(String::from(envelope).into()));
}

/// Handle `session.suspend`. Provider-neutral pause driven by the renderer
/// when the OS reports a pending suspend. Persisted permission/question gates
/// are closed first because the user cannot answer them while the machine is
/// asleep. For an active runtime we then capture the session id (so it can be
/// `--resume`'d after wake even if the subprocess dies), abort the in-flight
/// turn via the existing `interrupt()` trait method, and persist `paused` to
/// the DB. A Pending session without a gate has nothing to suspend, so its
/// reply stays silent.
pub(super) async fn handle_suspend(
    envelope: WsEnvelope,
    sender: &WsSender,
    sdk_sessions: &SdkSessions,
    app_state: &AppState,
) {
    let payload: SessionActionPayload = match serde_json::from_value(envelope.payload.clone()) {
        Ok(p) => p,
        Err(e) => {
            send_error(sender, &envelope.id, "INVALID_PAYLOAD", &e.to_string());
            return;
        }
    };
    let Some(db_session_id) = parse_session_id(&payload.session_id) else {
        send_error(
            sender,
            &envelope.id,
            "INVALID_SESSION_ID",
            "Invalid session_id",
        );
        return;
    };

    if let Err(error) = clear_persisted_gate_and_notify(
        sender,
        app_state,
        db_session_id,
        None,
        GateCloseReason::Sleep,
        Some(&envelope.id),
    )
    .await
    {
        send_error(
            sender,
            &envelope.id,
            "DB_ERROR",
            &format!("Failed to close pending gate before sleep: {error}"),
        );
        return;
    }

    // Extract the live query handle while briefly holding the lock, then
    // drop it so the await on `interrupt()` doesn't block other handlers
    // (same pattern as `handle_permission_respond`).
    let active: Option<(RuntimeSessionHandle, String, i64)> = {
        let sessions = sdk_sessions.lock().await;
        let Some(handle) = sessions.get(&db_session_id) else {
            return;
        };
        match &handle.state {
            QueryState::Active { query, .. } => Some((
                std::sync::Arc::clone(query),
                handle.runtime_provider.clone(),
                handle.feature_id,
            )),
            QueryState::Pending(_) => None,
        }
    };

    let Some((query, runtime_provider, feature_id)) = active else {
        // Pending session: nothing to interrupt, no resume id to persist,
        // no banner to flip. The envelope reply is silent to keep DB/UI
        // state consistent.
        return;
    };

    // Capture session id BEFORE interrupt: once the subprocess starts
    // tearing down, `session_id()` may return None for some adapters.
    let cli_sid = {
        let q = query.read().await;
        let sid = q.session_id().await;
        let interrupt_result = q.interrupt().await;
        drop(q);
        if let Err(error) = interrupt_result {
            info!(db_session_id, %error, "suspend: interrupt failed (treating as best-effort)");
        }
        sid
    };
    if let Some(sid) = cli_sid.as_deref() {
        // Persist so resume survives a subprocess death during suspend.
        // DB is the source of truth for resume IDs across restarts.
        WsSessionPersistence::persist_runtime_session_id_static(
            &app_state.write_pool,
            db_session_id,
            &runtime_provider,
            sid,
        )
        .await;
    }
    WsSessionPersistence::mark_paused_static(&app_state.write_pool, db_session_id).await;
    WsSessionPersistence::broadcast_session_status(
        &app_state.session_status_tx,
        db_session_id,
        feature_id,
        crate::domain::session_status::AgentStatus::Idle,
        None,
    );

    broadcast_lifecycle(
        sender,
        db_session_id,
        SessionLifecycleKind::SuspendRequested,
    );
}

/// Handle `session.resume`. Counterpart to `handle_suspend`: provider-neutral
/// acknowledgement of OS wake. We don't respawn anything — the renderer has
/// already called `forceReconnectAll` to refresh transport, and the next
/// user prompt picks up `resume_session_id` from the DB via the existing
/// pending-spawn path. The lifecycle envelope is broadcast unconditionally
/// because the renderer can fan this out before the reconnect has finished
/// rebuilding `sdk_sessions` — an existence check here would race the new
/// connection and produce spurious `SESSION_NOT_FOUND` errors.
pub(super) async fn handle_resume(envelope: WsEnvelope, sender: &WsSender) {
    let payload: SessionActionPayload = match serde_json::from_value(envelope.payload.clone()) {
        Ok(p) => p,
        Err(e) => {
            send_error(sender, &envelope.id, "INVALID_PAYLOAD", &e.to_string());
            return;
        }
    };
    let Some(db_session_id) = parse_session_id(&payload.session_id) else {
        send_error(
            sender,
            &envelope.id,
            "INVALID_SESSION_ID",
            "Invalid session_id",
        );
        return;
    };

    broadcast_lifecycle(sender, db_session_id, SessionLifecycleKind::Resumed);
}

/// Handle session.retry_worktree_setup: re-run setup commands for an existing worktree.
pub(super) async fn handle_retry_worktree_setup(
    envelope: WsEnvelope,
    sender: &WsSender,
    app_state: &AppState,
) {
    let payload: serde_json::Value = envelope.payload;
    let feature_id = match payload.get("feature_id").and_then(|v| v.as_i64()) {
        Some(fid) => fid,
        None => {
            send_error(
                sender,
                &envelope.id,
                "MISSING_FEATURE_ID",
                "feature_id is required",
            );
            return;
        }
    };

    let wt_path_str =
        match worktree::get_setting(&app_state.read_pool, feature_id, "worktree_path").await {
            Some(p) => p,
            None => {
                send_error(
                    sender,
                    &envelope.id,
                    "NO_WORKTREE",
                    "No worktree found for this feature",
                );
                return;
            }
        };

    let reply = WsEnvelope::reply(
        &envelope.id,
        "session",
        "retry_worktree_setup.ok",
        serde_json::json!({
            "feature_id": feature_id,
        }),
    );
    let _ = sender.send(Message::Text(String::from(reply).into()));

    let rp = app_state.read_pool.clone();
    let wp = app_state.write_pool.clone();
    let ws = sender.clone();
    let path = PathBuf::from(wt_path_str);
    tokio::spawn(async move {
        worktree::run_setup_commands(rp, wp, feature_id, path, ws).await;
    });
}
