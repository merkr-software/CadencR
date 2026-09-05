use axum::extract::ws::Message;
use tracing::error;

use super::super::super::protocol::*;
use super::super::helpers::{parse_session_id, send_error};
use super::super::types::{SdkSessions, WsSender};
use super::session_has_messages;
use crate::app_state::AppState;
use crate::domain::agents::adapter::{access_mode_wire, RuntimeAccessMode};
use crate::domain::agents::providers::resolve_requested_model_or_provider_default;
use crate::domain::agents::runtime_adapter;

async fn persist_provider_selection(
    pool: &sqlx::SqlitePool,
    session_id: i64,
    provider: &str,
    model: Option<&str>,
    codex_permission_mode: Option<&str>,
    permission_mode: &str,
) -> Result<(), sqlx::Error> {
    // The model travels with the provider in one statement: a row carrying the
    // new provider next to the previous provider's model is the exact mismatch
    // `session.init` would later restore.
    if let Some(codex_mode) = codex_permission_mode {
        sqlx::query(
            "UPDATE agent_sessions SET runtime_provider = ?, model = ?, codex_permission_mode = ?, permission_mode = ?, fast_mode = 0 WHERE id = ?",
        )
        .bind(provider)
        .bind(model)
        .bind(codex_mode)
        .bind(permission_mode)
        .bind(session_id)
        .execute(pool)
        .await?;
    } else {
        sqlx::query(
            "UPDATE agent_sessions SET runtime_provider = ?, model = ?, permission_mode = ?, fast_mode = 0 WHERE id = ?",
        )
        .bind(provider)
        .bind(model)
        .bind(permission_mode)
        .bind(session_id)
        .execute(pool)
        .await?;
    }
    Ok(())
}

fn send_provider_set_ok(
    sender: &WsSender,
    envelope_id: &str,
    provider: &str,
    model: &str,
    supports_prompt_receipts: bool,
    codex_permission_mode: Option<&str>,
) {
    let reply = WsEnvelope::session_reply(
        envelope_id,
        WsSessionAction::ProviderSetOk,
        ProviderSetOkPayload {
            provider: provider.to_string(),
            model: model.to_string(),
            supports_prompt_receipts,
            codex_permission_mode: codex_permission_mode.map(ToOwned::to_owned),
            access_mode: codex_permission_mode.map(ToOwned::to_owned),
        },
    )
    .expect("provider set payload should serialize");
    let _ = sender.send(Message::Text(String::from(reply).into()));
}

mod switch;
use switch::{
    commit_switch, decide_switch, ensure_still_pending, ProviderSetError, SwitchDecision,
    SwitchSnapshot,
};
pub(crate) use switch::{read_persisted_selection, restore_persisted_selection};

/// Reject the switch before the first prompt is even possible: unparseable
/// payloads, unknown providers, and sessions that already have history.
async fn validate_provider_set(
    payload: &ProviderSetPayload,
    db_session_id: i64,
    app_state: &AppState,
) -> Result<(), ProviderSetError> {
    if runtime_adapter(&payload.provider).is_none() {
        return Err(ProviderSetError::new(
            "UNSUPPORTED_PROVIDER",
            format!(
                "Runtime provider '{}' is not implemented yet",
                payload.provider
            ),
        ));
    }
    let has_messages = session_has_messages(&app_state.read_pool, db_session_id)
        .await
        .map_err(|error| {
            error!(db_session_id, %error, "failed to verify session history before provider change");
            ProviderSetError::new("DB_ERROR", "Failed to verify session history")
        })?;
    if has_messages {
        return Err(ProviderSetError::locked());
    }
    Ok(())
}

/// Handle session.provider.set: change the provider before the first prompt only.
pub(crate) async fn handle_provider_set(
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
    let Some(db_session_id) = parse_session_id(&payload.session_id) else {
        send_error(
            sender,
            &envelope.id,
            "INVALID_SESSION_ID",
            "Invalid session_id",
        );
        return;
    };

    if let Err(error) = apply_provider_set(
        &envelope,
        sender,
        sdk_sessions,
        app_state,
        &payload,
        db_session_id,
    )
    .await
    {
        send_error(sender, &envelope.id, error.code, &error.message);
    }
}

/// The caller's explicit `model` (from an atomic provider+model switch) takes
/// priority over the model carried over from the previous provider. Either
/// way, the result must belong to the new provider's catalog, or we fall back
/// to its default — even when no model was requested at all, a provider switch
/// must still land on *some* model for the new provider.
///
/// Resolved before anything is written, so the provider and the model are
/// committed together.
///
/// `None` means the new provider exposes no usable model — normal when its CLI
/// is not installed. That must not block the switch: refusing it would make a
/// provider unreachable precisely when the user is trying to configure it.
/// `commit_switch` clears the model instead of keeping the old provider's.
async fn resolve_switch_model(
    app_state: &AppState,
    payload: &ProviderSetPayload,
    snapshot: &SwitchSnapshot,
) -> Option<String> {
    let requested_model = payload
        .model
        .clone()
        .or_else(|| snapshot.desired_model.clone());
    resolve_requested_model_or_provider_default(
        &app_state.read_pool,
        Some(snapshot.cwd.as_path()),
        &payload.provider,
        requested_model.as_deref(),
        snapshot.profile.as_deref(),
    )
    .await
}

async fn apply_provider_set(
    envelope: &WsEnvelope,
    sender: &WsSender,
    sdk_sessions: &SdkSessions,
    app_state: &AppState,
    payload: &ProviderSetPayload,
    db_session_id: i64,
) -> Result<(), ProviderSetError> {
    validate_provider_set(payload, db_session_id, app_state).await?;
    let adapter = runtime_adapter(&payload.provider).ok_or_else(|| {
        ProviderSetError::new(
            "UNSUPPORTED_PROVIDER",
            "Runtime provider is not implemented",
        )
    })?;
    let supports_prompt_receipts = adapter.supports_prompt_receipts();

    let snapshot = match decide_switch(sdk_sessions, db_session_id, payload).await? {
        SwitchDecision::Unchanged { active_model } => {
            send_provider_set_ok(
                sender,
                &envelope.id,
                &payload.provider,
                &active_model,
                supports_prompt_receipts,
                None,
            );
            return Ok(());
        }
        SwitchDecision::Changed(snapshot) => snapshot,
    };

    let resolved_model = resolve_switch_model(app_state, payload, &snapshot).await;

    let configured_access_mode = adapter.configured_access_mode(&app_state.read_pool).await;
    let configured_access_wire = configured_access_mode.as_ref().map(access_mode_wire);
    let new_mode_wire = adapter.default_permission_mode_wire();

    let (feature_id, active_model) = persist_and_commit_switch(
        app_state,
        sdk_sessions,
        db_session_id,
        &payload.provider,
        resolved_model,
        configured_access_mode,
        configured_access_wire,
        new_mode_wire.as_ref(),
    )
    .await?;

    broadcast_provider_set(
        app_state,
        sender,
        &envelope.id,
        feature_id,
        BroadcastArgs {
            provider: payload.provider.clone(),
            model: active_model,
            supports_prompt_receipts,
            configured_access_wire,
            mode_wire: new_mode_wire.as_ref(),
        },
    )
    .await;
    Ok(())
}

/// Re-validate state, persist the selection, then commit it to the live
/// handle. The lock cannot be held across the DB write (it is global to the
/// WS connection), so the re-check here shrinks the race window to the write
/// itself: a prompt that started during the (much longer) model resolution is
/// rejected *before* the row is touched. `commit_switch` re-checks once more
/// under the lock it actually mutates.
async fn persist_and_commit_switch(
    app_state: &AppState,
    sdk_sessions: &SdkSessions,
    db_session_id: i64,
    provider: &str,
    resolved_model: Option<String>,
    configured_access_mode: Option<RuntimeAccessMode>,
    configured_access_wire: Option<&'static str>,
    new_mode_wire: &str,
) -> Result<(i64, String), ProviderSetError> {
    ensure_still_pending(sdk_sessions, db_session_id).await?;

    // Snapshot before the write: the lock cannot be held across it, so the
    // session may still go active before `commit_switch` runs. Without this,
    // a rejected switch would leave the row moved and a reconnect would
    // restore a selection the session refused.
    let previous = read_persisted_selection(&app_state.read_pool, db_session_id)
        .await
        .map_err(|error| {
            error!(db_session_id, %error, "failed to read the current runtime selection");
            ProviderSetError::new("DB_ERROR", "Failed to read the current runtime selection")
        })?;

    // DB first: a write failure must leave the live handle untouched.
    persist_provider_selection(
        &app_state.write_pool,
        db_session_id,
        provider,
        resolved_model.as_deref(),
        configured_access_wire,
        new_mode_wire,
    )
    .await
    .map_err(|error| {
        error!(
            db_session_id,
            runtime_provider = %provider,
            %error,
            "failed to persist runtime provider selection"
        );
        ProviderSetError::new("DB_ERROR", "Failed to persist runtime provider selection")
    })?;

    // In-memory last, re-validating state: a session that went active while the
    // model resolved and the DB was written is rejected here.
    match commit_switch(
        sdk_sessions,
        db_session_id,
        provider,
        resolved_model,
        configured_access_mode,
    )
    .await
    {
        Ok(committed) => Ok(committed),
        Err(rejection) => {
            restore_persisted_selection(&app_state.write_pool, db_session_id, &previous).await?;
            Err(rejection)
        }
    }
}

struct BroadcastArgs<'a> {
    provider: String,
    model: String,
    supports_prompt_receipts: bool,
    configured_access_wire: Option<&'a str>,
    mode_wire: &'a str,
}

/// Mirror to other devices viewing this feature so their provider/mode chips
/// stay in sync (provider can only change before the first prompt).
async fn broadcast_provider_set(
    app_state: &AppState,
    sender: &WsSender,
    envelope_id: &str,
    feature_id: i64,
    args: BroadcastArgs<'_>,
) {
    super::reply_and_broadcast(
        app_state,
        sender,
        envelope_id,
        feature_id,
        WsSessionAction::ProviderSetOk,
        ProviderSetOkPayload {
            codex_permission_mode: (args.provider == crate::domain::agents::codex::PROVIDER_ID)
                .then(|| args.configured_access_wire.map(ToOwned::to_owned))
                .flatten(),
            access_mode: args.configured_access_wire.map(ToOwned::to_owned),
            provider: args.provider,
            model: args.model,
            supports_prompt_receipts: args.supports_prompt_receipts,
        },
    )
    .await;
    super::reply_and_broadcast(
        app_state,
        sender,
        envelope_id,
        feature_id,
        WsSessionAction::ModeChanged,
        ModeChangedPayload {
            mode: args.mode_wire.to_string(),
        },
    )
    .await;
}
