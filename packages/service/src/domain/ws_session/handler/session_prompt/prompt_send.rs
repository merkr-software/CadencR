use tracing::{debug, info};

use crate::app_state::AppState;
use crate::domain::agents::adapter::RuntimeSpawnConfig;
use crate::domain::ws_session::protocol::{PromptSendPayload, WsEnvelope};

use crate::domain::agents::adapter::RuntimeSessionHandle;

use super::super::session_profile::{
    apply_profile_update, desired_profile_name, prompt_profile, resolve_provider_profile,
    SessionProfileUpdate,
};
use super::super::{parse_session_id, send_error, QueryState, SdkHandle, SdkSessions, WsSender};
use super::prompt_followup::{handle_followup_prompt, FollowupPromptContext};
use super::prompt_pending::{handle_pending_prompt, PendingPromptContext};
use super::prompt_runtime_config::{
    apply_respawn_if_needed, dispatch_changes, log_dispatch_decision,
};

/// Handle session.prompt.send: send prompt to runtime or spawn new query.
pub(crate) async fn handle_prompt_send(
    envelope: WsEnvelope,
    sender: &WsSender,
    sdk_sessions: &SdkSessions,
    app_state: &AppState,
) {
    let Some(payload) = parse_prompt_payload(&envelope, sender) else {
        return;
    };
    let Some(db_session_id) = parse_prompt_session_id(&payload, &envelope, sender) else {
        return;
    };

    let has_profile_update = prompt_profile(&payload).is_some();
    let profile_update = match resolve_prompt_profile_update(
        app_state,
        sdk_sessions,
        db_session_id,
        &payload,
        sender,
        &envelope,
    )
    .await
    {
        Ok(update) => update,
        Err(error) => {
            send_error(sender, &envelope.id, "PROFILE_ERROR", &error);
            return;
        }
    };
    if has_profile_update && profile_update.is_none() {
        return;
    }

    // Phase 1 — this connection's own map. Apply any respawn-on-config-change,
    // then if we own the live turn, steer it directly (fast path).
    {
        let mut sessions = sdk_sessions.lock().await;
        let Some(handle) = sessions.get_mut(&db_session_id) else {
            send_error(
                sender,
                &envelope.id,
                "SESSION_NOT_FOUND",
                &format!("Session {db_session_id} not found. Send session.init first."),
            );
            return;
        };
        apply_prompt_profile_update(handle, profile_update.as_ref());
        let changes = apply_respawn_if_needed(handle, app_state, db_session_id).await;
        log_dispatch_decision(handle, db_session_id, &changes);

        if let QueryState::Active { query, .. } = &handle.state {
            let context = build_followup_context(
                query.clone(),
                handle.feature_id,
                db_session_id,
                handle.runtime_provider.clone(),
                sender,
                sdk_sessions,
                app_state,
                envelope.id.clone(),
            );
            drop(sessions);
            handle_followup_prompt(context, payload).await;
            return;
        }
    }

    // Phase 2 — another connection may be driving this session's live turn
    // (multi-device, or a remote client whose socket is gone but whose agent we
    // kept running via deferred teardown). Steer that live agent rather than
    // starting a second one: never spawn a new agent on an existing conversation.
    if let Some(owner) = app_state.active_turns.owner_sessions(db_session_id).await {
        if let Some(target) = owner_prompt_target(
            &owner,
            db_session_id,
            sender,
            app_state,
            &envelope.id,
            profile_update.as_ref(),
        )
        .await
        {
            match target {
                OwnerPromptTarget::Followup(context) => {
                    handle_followup_prompt(context, payload).await;
                }
                OwnerPromptTarget::Pending(owner_sessions) => {
                    spawn_pending_prompt(
                        &envelope,
                        sender,
                        &owner_sessions,
                        app_state,
                        db_session_id,
                        payload,
                    )
                    .await;
                }
            }
            return;
        }
    }

    // Phase 3 — no live turn anywhere. Spawn, re-resolving worktree cwd + resume
    // id from the DB (in `handle_pending_prompt`) so the conversation continues
    // in the right place instead of forking a fresh, context-less agent.
    spawn_pending_prompt(
        &envelope,
        sender,
        sdk_sessions,
        app_state,
        db_session_id,
        payload,
    )
    .await;
}

/// Assemble a [`FollowupPromptContext`]. `sdk_sessions` is whichever map holds
/// the live turn — this connection's own map (Phase 1) or the owning
/// connection's map (Phase 2) — so the turn's timer/owner re-stamp keeps a
/// single source of truth.
#[allow(clippy::too_many_arguments)]
fn build_followup_context(
    query: RuntimeSessionHandle,
    feature_id: i64,
    db_session_id: i64,
    provider_id: String,
    sender: &WsSender,
    sdk_sessions: &SdkSessions,
    app_state: &AppState,
    envelope_id: String,
) -> FollowupPromptContext {
    FollowupPromptContext {
        query,
        feature_id,
        db_session_id,
        write_pool: app_state.write_pool.clone(),
        session_status_tx: app_state.session_status_tx.clone(),
        sender: sender.clone(),
        ws_feature_senders: app_state.ws_feature_senders.clone(),
        feature_events_tx: app_state.feature_events_tx.clone(),
        envelope_id,
        sdk_sessions: sdk_sessions.clone(),
        active_turns: app_state.active_turns.clone(),
        provider_id,
    }
}

/// Build a follow-up context against a live turn owned by *another* connection,
/// resolved via the active-turn registry. Returns `None` when that connection's
/// turn is no longer live.
enum OwnerPromptTarget {
    Followup(FollowupPromptContext),
    Pending(SdkSessions),
}

async fn owner_prompt_target(
    owner: &SdkSessions,
    db_session_id: i64,
    sender: &WsSender,
    app_state: &AppState,
    envelope_id: &str,
    profile_update: Option<&SessionProfileUpdate>,
) -> Option<OwnerPromptTarget> {
    let (query, feature_id, provider_id) = {
        let mut sessions = owner.lock().await;
        let handle = sessions.get_mut(&db_session_id)?;
        let changes = if profile_update.is_some() {
            apply_prompt_profile_update(handle, profile_update);
            apply_respawn_if_needed(handle, app_state, db_session_id).await
        } else {
            dispatch_changes(handle)
        };
        log_dispatch_decision(handle, db_session_id, &changes);

        match &handle.state {
            QueryState::Active { query, .. } => (
                query.clone(),
                handle.feature_id,
                handle.runtime_provider.clone(),
            ),
            QueryState::Pending(_) => return Some(OwnerPromptTarget::Pending(owner.clone())),
        }
    };
    info!(
        db_session_id,
        "steering live turn owned by another connection (no new agent)"
    );
    Some(OwnerPromptTarget::Followup(build_followup_context(
        query,
        feature_id,
        db_session_id,
        provider_id,
        sender,
        owner,
        app_state,
        envelope_id.to_string(),
    )))
}

/// First prompt (or respawn after a config change): take the stored spawn
/// options off this connection's `Pending` handle and start the runtime.
async fn spawn_pending_prompt(
    envelope: &WsEnvelope,
    sender: &WsSender,
    sdk_sessions: &SdkSessions,
    app_state: &AppState,
    db_session_id: i64,
    payload: PromptSendPayload,
) {
    let mut sessions = sdk_sessions.lock().await;
    let Some(handle) = sessions.get_mut(&db_session_id) else {
        send_error(
            sender,
            &envelope.id,
            "SESSION_NOT_FOUND",
            &format!("Session {db_session_id} not found. Send session.init first."),
        );
        return;
    };
    let spawned_model = handle.desired_model.clone();
    let spawned_thinking_effort = handle.desired_thinking_effort.clone();
    let config = handle.config.clone();
    let feature_id = handle.feature_id;
    let provider_id = handle.runtime_provider.clone();
    // Sequential per-connection dispatch guarantees the handle is still
    // `Pending` here (we only reach Phase 3 when Phase 1 saw `Pending`).
    let mut options = match std::mem::replace(
        &mut handle.state,
        QueryState::Pending(RuntimeSpawnConfig::default()),
    ) {
        QueryState::Pending(opts) => opts,
        _ => unreachable!("handle was Pending in phase 1 and dispatch is sequential"),
    };

    // Use the runtime session ID captured at init time for --resume.
    if options.resume_session_id.is_none() {
        if let Some(runtime_sid) = handle.resume_session_id.take() {
            info!(db_session_id, runtime_session_id = %runtime_sid, "resuming previous runtime session");
            options.resume_session_id = Some(runtime_sid);
        } else {
            debug!(
                db_session_id,
                feature_id, "no runtime_session_id found, spawning fresh"
            );
        }
    }
    let context = PendingPromptContext {
        envelope_id: envelope.id.clone(),
        sender: sender.clone(),
        sdk_sessions: sdk_sessions.clone(),
        app_state: app_state.clone(),
        db_session_id,
        feature_id,
        provider_id,
        spawned_model,
        spawned_thinking_effort,
        config,
        options,
        payload,
        permission_tx: None,
    };
    drop(sessions);
    // Persist user message in the pending helper after releasing sdk_sessions.
    handle_pending_prompt(context).await;
}

async fn resolve_prompt_profile_update(
    app_state: &AppState,
    sdk_sessions: &SdkSessions,
    db_session_id: i64,
    payload: &PromptSendPayload,
    sender: &WsSender,
    envelope: &WsEnvelope,
) -> Result<Option<SessionProfileUpdate>, String> {
    let Some(profile_name) = prompt_profile(payload) else {
        return Ok(None);
    };
    let (provider, current_profile) = {
        let sessions = sdk_sessions.lock().await;
        let Some(handle) = sessions.get(&db_session_id) else {
            send_error(
                sender,
                &envelope.id,
                "SESSION_NOT_FOUND",
                &format!("Session {db_session_id} not found. Send session.init first."),
            );
            return Ok(None);
        };
        (
            handle.runtime_provider.clone(),
            desired_profile_name(handle).map(str::to_string),
        )
    };
    let update = resolve_provider_profile(app_state, &provider, profile_name).await?;
    if current_profile.as_deref() != Some(update.name.as_str()) {
        crate::domain::ws_session::persistence::WsSessionPersistence::update_profile_static(
            &app_state.write_pool,
            db_session_id,
            &update.name,
        )
        .await;
    }
    Ok(Some(update))
}

fn apply_prompt_profile_update(handle: &mut SdkHandle, update: Option<&SessionProfileUpdate>) {
    let Some(update) = update else {
        return;
    };
    apply_profile_update(handle, update);
}

fn parse_prompt_payload(envelope: &WsEnvelope, sender: &WsSender) -> Option<PromptSendPayload> {
    match serde_json::from_value(envelope.payload.clone()) {
        Ok(payload) => Some(payload),
        Err(error) => {
            send_error(sender, &envelope.id, "INVALID_PAYLOAD", &error.to_string());
            None
        }
    }
}

fn parse_prompt_session_id(
    payload: &PromptSendPayload,
    envelope: &WsEnvelope,
    sender: &WsSender,
) -> Option<i64> {
    match parse_session_id(&payload.session_id) {
        Some(id) => Some(id),
        None => {
            send_error(
                sender,
                &envelope.id,
                "INVALID_SESSION_ID",
                "session_id must be a numeric DB id",
            );
            None
        }
    }
}
