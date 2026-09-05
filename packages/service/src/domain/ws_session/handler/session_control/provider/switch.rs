//! Switch-decision state for `provider.set`: the error type, the captured
//! snapshot, the accept/reject decision, and the state guards that keep a
//! rejected switch from touching the row or the live handle.

use super::super::super::super::protocol::ProviderSetPayload;
use super::super::super::types::{QueryState, SdkSessions};
use crate::domain::agents::adapter::RuntimeAccessMode;

/// A failure to report back over the WS as `{code, message}`.
pub(crate) struct ProviderSetError {
    pub(crate) code: &'static str,
    pub(crate) message: String,
}

impl ProviderSetError {
    pub(crate) fn new(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }

    pub(crate) fn locked() -> Self {
        Self::new(
            "PROVIDER_LOCKED",
            "Provider cannot be changed after the conversation starts",
        )
    }

    pub(crate) fn session_not_found() -> Self {
        Self::new("SESSION_NOT_FOUND", "Session not found")
    }
}

/// What the session looked like when the switch was accepted. Captured under
/// the lock so the model resolution can run without holding it.
pub(crate) struct SwitchSnapshot {
    pub(crate) desired_model: Option<String>,
    pub(crate) cwd: std::path::PathBuf,
    pub(crate) profile: Option<String>,
}

pub(crate) enum SwitchDecision {
    /// Already on the requested provider — ack with the current model.
    Unchanged {
        active_model: String,
    },
    Changed(SwitchSnapshot),
}

/// Decide whether the switch applies, and capture what resolving the new
/// model needs. Rejects sessions whose conversation has already started.
///
/// "Unchanged" requires the provider *and* the requested model (when one was
/// sent) to already match — comparing the provider alone would silently drop
/// a same-provider model change (picking model C right after model B) by
/// acknowledging the stale model instead of applying the new one.
pub(crate) async fn decide_switch(
    sdk_sessions: &SdkSessions,
    db_session_id: i64,
    payload: &ProviderSetPayload,
) -> Result<SwitchDecision, ProviderSetError> {
    let sessions = sdk_sessions.lock().await;
    let handle = sessions
        .get(&db_session_id)
        .ok_or_else(ProviderSetError::session_not_found)?;
    let QueryState::Pending(_) = &handle.state else {
        return Err(ProviderSetError::locked());
    };
    let provider_unchanged = handle.runtime_provider == payload.provider;
    let model_unchanged = payload
        .model
        .as_deref()
        .is_none_or(|requested| Some(requested) == handle.desired_model.as_deref());
    if provider_unchanged && model_unchanged {
        return Ok(SwitchDecision::Unchanged {
            active_model: handle.desired_model.clone().unwrap_or_default(),
        });
    }
    Ok(SwitchDecision::Changed(SwitchSnapshot {
        desired_model: handle.desired_model.clone(),
        cwd: handle.config.cwd.clone(),
        profile: handle
            .desired_claude_profile
            .clone()
            .or_else(|| handle.spawned_claude_profile.clone()),
    }))
}

/// Re-read the session state without mutating it. Called immediately before
/// the DB write so a session that went active while the model resolved is
/// rejected before anything is persisted, not after. The lock cannot be held
/// across the DB write (it is global to the WS connection), so this is a
/// short read-only re-validation that shrinks the race window to the write
/// itself.
pub(crate) async fn ensure_still_pending(
    sdk_sessions: &SdkSessions,
    db_session_id: i64,
) -> Result<(), ProviderSetError> {
    let sessions = sdk_sessions.lock().await;
    let handle = sessions
        .get(&db_session_id)
        .ok_or_else(ProviderSetError::session_not_found)?;
    let QueryState::Pending(_) = &handle.state else {
        return Err(ProviderSetError::locked());
    };
    Ok(())
}

/// Apply the resolved provider/model pair to the in-memory handle. Re-checks
/// the session state, since the lock was released while the model resolved.
/// Contains no `await`, so provider and model always land together.
///
/// `resolved_model` is `None` when the new provider exposes no usable model
/// (typically its CLI is not installed). The switch still applies, but the
/// model is *cleared* rather than kept: carrying the previous provider's model
/// over would leave an incompatible provider/model pair behind.
pub(crate) async fn commit_switch(
    sdk_sessions: &SdkSessions,
    db_session_id: i64,
    new_provider: &str,
    resolved_model: Option<String>,
    next_access_mode: Option<RuntimeAccessMode>,
) -> Result<(i64, String), ProviderSetError> {
    let mut sessions = sdk_sessions.lock().await;
    let handle = sessions
        .get_mut(&db_session_id)
        .ok_or_else(ProviderSetError::session_not_found)?;
    let QueryState::Pending(options) = &mut handle.state else {
        return Err(ProviderSetError::locked());
    };
    handle.runtime_provider = new_provider.to_string();
    handle.resume_session_id = None;
    options.resume_session_id = None;
    handle.desired_permission_mode = None;
    handle.config.permission_mode = None;
    options.permission_mode = None;
    handle.desired_access_mode = next_access_mode.clone();
    handle.config.access_mode = next_access_mode.clone();
    options.access_mode = next_access_mode;
    handle.config.fast_mode = false;
    options.fast_mode = false;
    handle.desired_model = resolved_model.clone();
    options.model = resolved_model.clone();
    Ok((handle.feature_id, resolved_model.unwrap_or_default()))
}

/// The columns `persist_provider_selection` overwrites. Captured before the
/// write so a switch rejected afterwards can be undone.
#[derive(Debug, Clone, PartialEq, Eq, sqlx::FromRow)]
pub(crate) struct PersistedSelection {
    pub(crate) runtime_provider: Option<String>,
    pub(crate) model: Option<String>,
    pub(crate) codex_permission_mode: String,
    pub(crate) permission_mode: Option<String>,
    pub(crate) fast_mode: bool,
}

pub(crate) async fn read_persisted_selection(
    pool: &sqlx::SqlitePool,
    session_id: i64,
) -> Result<PersistedSelection, sqlx::Error> {
    sqlx::query_as::<_, PersistedSelection>(
        "SELECT runtime_provider, model, codex_permission_mode, permission_mode, fast_mode \
         FROM agent_sessions WHERE id = ?",
    )
    .bind(session_id)
    .fetch_one(pool)
    .await
}

/// Put the row back exactly as it was. Writes all five columns rather than
/// mirroring `persist_provider_selection`'s two branches: the goal is the
/// previous state, not a variant of the new one.
pub(crate) async fn restore_persisted_selection(
    pool: &sqlx::SqlitePool,
    session_id: i64,
    previous: &PersistedSelection,
) -> Result<(), ProviderSetError> {
    sqlx::query(
        "UPDATE agent_sessions SET runtime_provider = ?, model = ?, codex_permission_mode = ?, \
         permission_mode = ?, fast_mode = ? WHERE id = ?",
    )
    .bind(&previous.runtime_provider)
    .bind(&previous.model)
    .bind(&previous.codex_permission_mode)
    .bind(&previous.permission_mode)
    .bind(previous.fast_mode)
    .bind(session_id)
    .execute(pool)
    .await
    .map_err(|error| {
        tracing::error!(
            session_id,
            %error,
            "failed to restore runtime selection after rejected switch"
        );
        ProviderSetError::new(
            "DB_ERROR",
            "Provider change was rejected, but the previous runtime selection could not be restored",
        )
    })?;
    Ok(())
}
