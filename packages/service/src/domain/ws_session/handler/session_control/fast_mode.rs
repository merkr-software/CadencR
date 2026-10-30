use std::path::PathBuf;

use tracing::{error, info};

use super::super::super::persistence::WsSessionPersistence;
use super::super::super::protocol::*;
use super::super::fast_mode_support::{model_supports_fast_mode, FastModeTarget};
use super::super::helpers::{parse_session_id, send_error};
use super::super::types::{QueryState, SdkHandle, SdkSessions, WsSender};
use crate::app_state::AppState;

#[derive(Debug)]
pub(super) enum FastModeChangeError {
    SessionNotFound,
    Unsupported,
    ConfigurationChanged,
    Persistence(String),
    Sdk(String),
}

#[derive(Clone, PartialEq, Eq)]
struct FastModeConfigSnapshot {
    provider: String,
    model: Option<String>,
    cwd: PathBuf,
    profile: Option<String>,
}

impl FastModeConfigSnapshot {
    fn from_handle(handle: &SdkHandle) -> Self {
        Self {
            provider: handle.runtime_provider.clone(),
            model: handle
                .desired_model
                .clone()
                .or_else(|| handle.spawned_model.clone()),
            cwd: handle.config.cwd.clone(),
            profile: handle.desired_claude_profile.clone(),
        }
    }

    fn matches(&self, handle: &SdkHandle) -> bool {
        self.provider == handle.runtime_provider
            && self.model.as_deref()
                == handle
                    .desired_model
                    .as_deref()
                    .or(handle.spawned_model.as_deref())
            && self.cwd == handle.config.cwd
            && self.profile == handle.desired_claude_profile
    }
}

/// Handle `session.fast_mode.set`: use the model's advertised fast service
/// tier on subsequent turns.
pub(crate) async fn handle_fast_mode_set(
    envelope: WsEnvelope,
    sender: &WsSender,
    sdk_sessions: &SdkSessions,
    app_state: &AppState,
) {
    let payload: FastModeSetPayload = match serde_json::from_value(envelope.payload.clone()) {
        Ok(payload) => payload,
        Err(error) => {
            send_error(sender, &envelope.id, "INVALID_PAYLOAD", &error.to_string());
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

    let feature_id =
        match apply_fast_mode_change(sdk_sessions, app_state, db_session_id, payload.enabled).await
        {
            Ok(feature_id) => feature_id,
            Err(error) => {
                send_fast_mode_error(sender, &envelope.id, db_session_id, error);
                return;
            }
        };

    send_fast_mode_set_ok(app_state, sender, &envelope.id, feature_id, payload.enabled).await;
}

fn send_fast_mode_error(
    sender: &WsSender,
    envelope_id: &str,
    db_session_id: i64,
    error: FastModeChangeError,
) {
    match error {
        FastModeChangeError::SessionNotFound => {
            send_error(
                sender,
                envelope_id,
                "SESSION_NOT_FOUND",
                "Session not found",
            );
        }
        FastModeChangeError::Unsupported => send_error(
            sender,
            envelope_id,
            "FAST_MODE_NOT_SUPPORTED",
            "Fast mode is not supported by the selected model",
        ),
        FastModeChangeError::ConfigurationChanged => send_error(
            sender,
            envelope_id,
            "SESSION_CONFIG_CHANGED",
            "Session configuration changed while validating fast mode; retry the change",
        ),
        FastModeChangeError::Persistence(error) => {
            error!(db_session_id, %error, "failed to persist fast mode");
            send_error(
                sender,
                envelope_id,
                "DB_ERROR",
                "Failed to persist fast mode",
            );
        }
        FastModeChangeError::Sdk(error) => {
            error!(db_session_id, %error, "failed to set fast mode on active query");
            send_error(sender, envelope_id, "SDK_ERROR", &error);
        }
    }
}

pub(super) async fn apply_fast_mode_change(
    sdk_sessions: &SdkSessions,
    app_state: &AppState,
    db_session_id: i64,
    enabled: bool,
) -> Result<i64, FastModeChangeError> {
    let effective_sessions =
        super::resolve_owner_sessions(sdk_sessions, app_state, db_session_id).await;

    let validation_snapshot = if enabled {
        let sessions = effective_sessions.lock().await;
        let handle = sessions
            .get(&db_session_id)
            .ok_or(FastModeChangeError::SessionNotFound)?;
        Some(FastModeConfigSnapshot::from_handle(handle))
    } else {
        None
    };

    if let Some(snapshot) = validation_snapshot.as_ref() {
        if !model_supports_fast_mode(
            app_state,
            FastModeTarget {
                provider: &snapshot.provider,
                model: snapshot.model.as_deref(),
                cwd: &snapshot.cwd,
                profile: snapshot.profile.as_deref(),
            },
        )
        .await
        {
            return Err(FastModeChangeError::Unsupported);
        }
    }

    apply_validated_fast_mode_change(
        &effective_sessions,
        app_state,
        db_session_id,
        enabled,
        validation_snapshot.as_ref(),
    )
    .await
}

async fn apply_validated_fast_mode_change(
    sessions: &SdkSessions,
    app_state: &AppState,
    db_session_id: i64,
    enabled: bool,
    validation_snapshot: Option<&FastModeConfigSnapshot>,
) -> Result<i64, FastModeChangeError> {
    let mut sessions = sessions.lock().await;
    let handle = sessions
        .get_mut(&db_session_id)
        .ok_or(FastModeChangeError::SessionNotFound)?;
    if validation_snapshot.is_some_and(|snapshot| !snapshot.matches(handle)) {
        return Err(FastModeChangeError::ConfigurationChanged);
    }

    let previous = handle.config.fast_mode;
    let active_query = match &handle.state {
        QueryState::Pending(_) => None,
        QueryState::Active { query, .. } => Some(query.clone()),
    };
    info!(db_session_id, enabled, "updating fast mode");

    if let Some(query) = active_query.as_ref() {
        query
            .read()
            .await
            .set_fast_mode(enabled)
            .await
            .map_err(|error| FastModeChangeError::Sdk(error.to_string()))?;
    }

    if let Err(error) =
        WsSessionPersistence::update_fast_mode_static(&app_state.write_pool, db_session_id, enabled)
            .await
    {
        let mut message = error.to_string();
        if let Some(query) = active_query {
            if let Err(rollback_error) = query.read().await.set_fast_mode(previous).await {
                message.push_str(&format!("; runtime rollback failed: {rollback_error}"));
            }
        }
        return Err(FastModeChangeError::Persistence(message));
    }

    handle.config.fast_mode = enabled;
    if let QueryState::Pending(options) = &mut handle.state {
        options.fast_mode = enabled;
    }
    Ok(handle.feature_id)
}

pub(super) async fn send_fast_mode_set_ok(
    app_state: &AppState,
    sender: &WsSender,
    envelope_id: &str,
    feature_id: i64,
    enabled: bool,
) {
    super::reply_and_broadcast(
        app_state,
        sender,
        envelope_id,
        feature_id,
        &WsSessionEvent::FastModeSetOk(FastModeSetOkPayload { enabled }),
    )
    .await;
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::agents::adapter::RuntimeSpawnConfig;
    use crate::domain::ws_session::handler::tests::support::{
        make_active_handle, make_test_app_state,
    };
    use crate::domain::ws_session::handler::types::new_sdk_sessions;

    async fn insert_session(app_state: &AppState, enabled: bool) -> i64 {
        sqlx::query("INSERT INTO agent_sessions (feature_id, fast_mode) VALUES (7, ?)")
            .bind(enabled)
            .execute(&app_state.write_pool)
            .await
            .unwrap()
            .last_insert_rowid()
    }

    #[test]
    fn validation_snapshot_detects_a_model_change() {
        let mut handle = make_active_handle(7, None);
        let snapshot = FastModeConfigSnapshot::from_handle(&handle);

        handle.desired_model = Some("different-model".to_string());

        assert!(!snapshot.matches(&handle));
    }

    #[tokio::test]
    async fn pending_change_persists_before_updating_memory() {
        let app_state = make_test_app_state().await;
        let session_id = insert_session(&app_state, true).await;
        let sessions = new_sdk_sessions();
        let mut handle = make_active_handle(7, None);
        handle.config.fast_mode = true;
        handle.state = QueryState::Pending(RuntimeSpawnConfig {
            fast_mode: true,
            ..RuntimeSpawnConfig::default()
        });
        sessions.lock().await.insert(session_id, handle);

        apply_validated_fast_mode_change(&sessions, &app_state, session_id, false, None)
            .await
            .unwrap();

        let sessions = sessions.lock().await;
        let handle = sessions.get(&session_id).unwrap();
        assert!(!handle.config.fast_mode);
        let QueryState::Pending(options) = &handle.state else {
            panic!("expected pending session");
        };
        assert!(!options.fast_mode);
        let stored: bool = sqlx::query_scalar("SELECT fast_mode FROM agent_sessions WHERE id = ?")
            .bind(session_id)
            .fetch_one(&app_state.read_pool)
            .await
            .unwrap();
        assert!(!stored);
    }

    #[tokio::test]
    async fn runtime_failure_keeps_memory_and_database_unchanged() {
        let app_state = make_test_app_state().await;
        let session_id = insert_session(&app_state, false).await;
        let sessions = new_sdk_sessions();
        sessions
            .lock()
            .await
            .insert(session_id, make_active_handle(7, None));

        let error = apply_validated_fast_mode_change(&sessions, &app_state, session_id, true, None)
            .await
            .unwrap_err();

        assert!(matches!(error, FastModeChangeError::Sdk(_)));
        assert!(
            !sessions
                .lock()
                .await
                .get(&session_id)
                .unwrap()
                .config
                .fast_mode
        );
        let stored: bool = sqlx::query_scalar("SELECT fast_mode FROM agent_sessions WHERE id = ?")
            .bind(session_id)
            .fetch_one(&app_state.read_pool)
            .await
            .unwrap();
        assert!(!stored);
    }

    #[tokio::test]
    async fn persistence_failure_keeps_pending_memory_unchanged() {
        let app_state = make_test_app_state().await;
        let session_id = insert_session(&app_state, false).await;
        let sessions = new_sdk_sessions();
        let mut handle = make_active_handle(7, None);
        handle.state = QueryState::Pending(RuntimeSpawnConfig::default());
        sessions.lock().await.insert(session_id, handle);
        sqlx::query("DROP TABLE agent_sessions")
            .execute(&app_state.write_pool)
            .await
            .unwrap();

        let error = apply_validated_fast_mode_change(&sessions, &app_state, session_id, true, None)
            .await
            .unwrap_err();

        assert!(matches!(error, FastModeChangeError::Persistence(_)));
        assert!(
            !sessions
                .lock()
                .await
                .get(&session_id)
                .unwrap()
                .config
                .fast_mode
        );
    }
}
