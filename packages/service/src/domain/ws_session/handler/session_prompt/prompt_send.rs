use tracing::info;

use super::prompt_send_pending::spawn_pending_prompt;

use crate::app_state::AppState;
use crate::domain::ws_session::protocol::{PromptSendPayload, WsEnvelope};

use crate::domain::agents::adapter::RuntimeSessionHandle;

use super::super::session_profile::{
    apply_profile_update, desired_profile_name, prompt_profile, resolve_provider_profile,
    validate_resume_profile_state, SessionProfileUpdate,
};
use super::super::{send_error, QueryState, SdkHandle, SdkSessions, WsSender};
use super::prompt_send_entry::{report_prompt_result, PromptedSelection};
use super::prompt_validation;
use crate::domain::ws_session::runtime::prompt::prompt_followup::{
    handle_followup_prompt, FollowupPromptContext,
};
use crate::domain::ws_session::runtime::prompt::prompt_runtime_config::{
    apply_respawn_if_needed, dispatch_changes, log_dispatch_decision, notify_deferred_respawn,
};
use crate::domain::ws_session::runtime::prompt::prompt_selection_sync::{self, StoredSelection};

pub(in crate::domain::ws_session) struct PreparedPrompt {
    pub payload: PromptSendPayload,
    pub db_session_id: i64,
    pub profile_update: Option<SessionProfileUpdate>,
}

pub(in crate::domain::ws_session) async fn prepare_prompt(
    envelope: &WsEnvelope,
    sender: &WsSender,
    sdk_sessions: &SdkSessions,
    app_state: &AppState,
) -> Option<PreparedPrompt> {
    let mut payload = prompt_validation::parse_prompt_payload(envelope, sender)?;
    let db_session_id = prompt_validation::parse_prompt_session_id(&payload, envelope, sender)?;
    if let Err(message) = prompt_validation::normalize_message_uuid(&mut payload) {
        send_error(sender, &envelope.id, "INVALID_MESSAGE_UUID", &message);
        return None;
    }
    let has_profile_update = prompt_profile(&payload).is_some();
    let profile_update = match resolve_prompt_profile_update(
        app_state,
        sdk_sessions,
        db_session_id,
        &payload,
        sender,
        envelope,
    )
    .await
    {
        Ok(update) => update,
        Err(error) => {
            send_error(sender, &envelope.id, "PROFILE_ERROR", &error);
            return None;
        }
    };
    if has_profile_update && profile_update.is_none() {
        return None;
    }
    Some(PreparedPrompt {
        payload,
        db_session_id,
        profile_update,
    })
}

pub(in crate::domain::ws_session) async fn dispatch_local_phase(
    envelope: &WsEnvelope,
    sender: &WsSender,
    sdk_sessions: &SdkSessions,
    app_state: &AppState,
    db_session_id: i64,
    payload: PromptSendPayload,
    profile_update: Option<&SessionProfileUpdate>,
    stored: &StoredSelection,
) -> Option<PromptSendPayload> {
    let mut sessions = sdk_sessions.lock().await;
    let Some(handle) = sessions.get_mut(&db_session_id) else {
        send_error(
            sender,
            &envelope.id,
            "SESSION_NOT_FOUND",
            &format!("Session {db_session_id} not found. Send session.init first."),
        );
        return None;
    };
    prompt_selection_sync::sync_handle(handle, stored, app_state, db_session_id);
    apply_prompt_profile_update(handle, profile_update);
    let changes = apply_respawn_if_needed(handle, app_state, db_session_id).await;
    log_dispatch_decision(handle, db_session_id, &changes);
    notify_deferred_respawn(sender, &envelope.id, &changes);

    if let QueryState::Active { query, .. } = &handle.state {
        let selection = PromptedSelection::of(handle);
        let context = build_followup_context(
            query.clone(),
            handle.identity.begin_delivery(),
            handle.feature_id,
            db_session_id,
            handle.runtime_provider.clone(),
            sender,
            sdk_sessions,
            app_state,
            envelope.id.clone(),
        );
        drop(sessions);
        let result = handle_followup_prompt(context, payload).await;
        report_prompt_result(sender, &envelope.id, selection, result);
        return None;
    }
    Some(payload)
}

pub(in crate::domain::ws_session) async fn dispatch_owner_phase(
    envelope: &WsEnvelope,
    sender: &WsSender,
    app_state: &AppState,
    db_session_id: i64,
    payload: PromptSendPayload,
    profile_update: Option<&SessionProfileUpdate>,
    stored: &StoredSelection,
) -> Option<PromptSendPayload> {
    if let Some(owner) = app_state.active_turns.owner_sessions(db_session_id).await {
        if let Some(target) = owner_prompt_target(
            &owner,
            stored,
            db_session_id,
            sender,
            app_state,
            &envelope.id,
            profile_update,
        )
        .await
        {
            match target {
                OwnerPromptTarget::Followup(context, selection) => {
                    let result = handle_followup_prompt(context, payload).await;
                    report_prompt_result(sender, &envelope.id, selection, result);
                }
                OwnerPromptTarget::Pending(owner_sessions) => {
                    spawn_pending_prompt(
                        envelope,
                        sender,
                        &owner_sessions,
                        app_state,
                        db_session_id,
                        payload,
                    )
                    .await;
                }
            }
            return None;
        }
    }
    Some(payload)
}

/// Assemble a [`FollowupPromptContext`]. `sdk_sessions` is whichever map holds
/// the live turn — this connection's own map (Phase 1) or the owning
/// connection's map (Phase 2) — so the turn's timer/owner re-stamp keeps a
/// single source of truth.
#[allow(clippy::too_many_arguments)]
pub(super) fn build_followup_context(
    query: RuntimeSessionHandle,
    delivery_lease: crate::domain::ws_session::runtime::state::RuntimeDeliveryLease,
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
        delivery_lease: Some(delivery_lease),
        feature_id,
        db_session_id,
        write_pool: app_state.write_pool.clone(),
        session_status_tx: app_state.session_status_tx.clone(),
        sender: sender.clone().into(),
        ws_feature_senders: app_state.ws_feature_senders.clone(),
        feature_events_tx: app_state.feature_events_tx.clone(),
        envelope_id,
        sdk_sessions: sdk_sessions.clone(),
        active_turns: app_state.active_turns.clone(),
        provider_id,
        internal_replay: false,
        wait_for_delivery: false,
    }
}

/// Build a follow-up context against a live turn owned by *another* connection,
/// resolved via the active-turn registry. Returns `None` when that connection's
/// turn is no longer live.
enum OwnerPromptTarget {
    Followup(FollowupPromptContext, PromptedSelection),
    Pending(SdkSessions),
}

async fn owner_prompt_target(
    owner: &SdkSessions,
    stored: &StoredSelection,
    db_session_id: i64,
    sender: &WsSender,
    app_state: &AppState,
    envelope_id: &str,
    profile_update: Option<&SessionProfileUpdate>,
) -> Option<OwnerPromptTarget> {
    let (query, delivery_lease, feature_id, provider_id, selection) = {
        let mut sessions = owner.lock().await;
        let handle = sessions.get_mut(&db_session_id)?;
        // An idle runtime still on another model respawns before taking the
        // prompt; a live turn is steered as is.
        let adopted = prompt_selection_sync::sync_handle(handle, stored, app_state, db_session_id);
        let changes = if profile_update.is_some() || adopted {
            apply_prompt_profile_update(handle, profile_update);
            apply_respawn_if_needed(handle, app_state, db_session_id).await
        } else {
            dispatch_changes(handle)
        };
        log_dispatch_decision(handle, db_session_id, &changes);
        notify_deferred_respawn(sender, envelope_id, &changes);

        match &handle.state {
            QueryState::Active { query, .. } => (
                query.clone(),
                handle.identity.begin_delivery(),
                handle.feature_id,
                handle.runtime_provider.clone(),
                PromptedSelection::of(handle),
            ),
            QueryState::Pending(_) => return Some(OwnerPromptTarget::Pending(owner.clone())),
        }
    };
    info!(
        db_session_id,
        "steering live turn owned by another connection (no new agent)"
    );
    Some(OwnerPromptTarget::Followup(
        build_followup_context(
            query,
            delivery_lease,
            feature_id,
            db_session_id,
            provider_id,
            sender,
            owner,
            app_state,
            envelope_id.to_string(),
        ),
        selection,
    ))
}

async fn resolve_prompt_profile_update(
    app_state: &AppState,
    sdk_sessions: &SdkSessions,
    db_session_id: i64,
    payload: &PromptSendPayload,
    sender: &WsSender,
    envelope: &WsEnvelope,
) -> Result<Option<SessionProfileUpdate>, String> {
    let (provider, current_profile, cwd) = {
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
            handle.config.cwd.clone(),
        )
    };
    let selected_profile = prompt_profile(payload)
        .map(ToOwned::to_owned)
        .or_else(|| current_profile.clone());
    let Some(profile_name) = selected_profile.as_deref() else {
        return Ok(None);
    };
    let update = resolve_provider_profile(app_state, &provider, profile_name, &cwd).await?;
    {
        let sessions = sdk_sessions.lock().await;
        if let Some(handle) = sessions.get(&db_session_id) {
            validate_resume_profile_state(handle, &update)?;
        }
    }
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
