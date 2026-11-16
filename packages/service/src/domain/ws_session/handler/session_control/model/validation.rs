//! Request parsing and validation for `session.model.set`.

use super::super::super::super::protocol::*;
use super::super::super::helpers::{parse_session_id, send_error};
use super::super::super::types::{SdkSessions, WsSender};
use crate::app_state::AppState;
use crate::domain::agents::providers::{
    canonical_provider_or_error, resolve_model_or_error_for_profile,
};
use crate::domain::agents::runtime::ModelCatalogEntry;

/// Session state the model was validated against; the switch re-checks it
/// under the lock so a concurrent provider or profile change is not lost.
pub(super) struct ModelSetSnapshot {
    pub(super) runtime_provider: String,
    pub(super) cwd: std::path::PathBuf,
    pub(super) claude_profile: Option<String>,
}

pub(super) async fn validate_model_set(
    sessions: &SdkSessions,
    app_state: &AppState,
    sender: &WsSender,
    envelope_id: &str,
    db_session_id: i64,
    payload: &ModelSetPayload,
) -> Option<(ModelSetSnapshot, String, ModelCatalogEntry)> {
    let snapshot = {
        let sessions = sessions.lock().await;
        let Some(handle) = sessions.get(&db_session_id) else {
            send_error(
                sender,
                envelope_id,
                "SESSION_NOT_FOUND",
                "Session not found",
            );
            return None;
        };
        ModelSetSnapshot {
            runtime_provider: handle.runtime_provider.clone(),
            cwd: handle.config.cwd.clone(),
            claude_profile: handle.desired_claude_profile.clone(),
        }
    };
    if !validate_requested_provider(payload, &snapshot.runtime_provider, sender, envelope_id) {
        return None;
    }
    match resolve_model_or_error_for_profile(
        &app_state.read_pool,
        Some(&snapshot.cwd),
        &snapshot.runtime_provider,
        &payload.model,
        snapshot.claude_profile.as_deref(),
    )
    .await
    {
        Ok((model, entry)) => Some((snapshot, model, entry)),
        Err(error) => {
            send_error(
                sender,
                envelope_id,
                "MODEL_PROVIDER_MISMATCH",
                &error.to_string(),
            );
            None
        }
    }
}

fn validate_requested_provider(
    payload: &ModelSetPayload,
    runtime_provider: &str,
    sender: &WsSender,
    envelope_id: &str,
) -> bool {
    let Some(requested_provider) = payload.provider.as_deref() else {
        return true;
    };
    let requested_provider = match canonical_provider_or_error(requested_provider) {
        Ok(provider) => provider,
        Err(error) => {
            send_error(sender, envelope_id, "INVALID_PROVIDER", &error.to_string());
            return false;
        }
    };
    if requested_provider == runtime_provider {
        return true;
    }
    send_error(
        sender,
        envelope_id,
        "PROVIDER_MISMATCH",
        "Selected model provider does not match the active session provider",
    );
    false
}

pub(super) fn parse_model_set_request(
    envelope: &WsEnvelope,
    sender: &WsSender,
) -> Option<(ModelSetPayload, i64)> {
    let payload: ModelSetPayload = match serde_json::from_value(envelope.payload.clone()) {
        Ok(payload) => payload,
        Err(error) => {
            send_error(sender, &envelope.id, "INVALID_PAYLOAD", &error.to_string());
            return None;
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
            return None;
        }
    };
    Some((payload, db_session_id))
}
