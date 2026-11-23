//! Reconnect snapshots come from the authoritative runtime, never a replacement.

use crate::app_state::AppState;
use crate::domain::agents::adapter::{access_mode_wire, RuntimeSessionHandle};
use crate::domain::agents::permission_modes::permission_mode_wire;
use crate::domain::agents::runtime_adapter;
use crate::domain::ws_session::persistence::SessionRow;
use crate::domain::ws_session::protocol::{SessionInitializedPayload, WsEnvelope, WsSessionEvent};
use crate::shared::discard::IgnoreClosed;

use super::super::{QueryState, SdkHandle, SdkSessions, SessionConfig, WsSender};

#[derive(bon::Builder)]
pub(super) struct Binding<'a> {
    app_state: &'a AppState,
    sdk_sessions: &'a SdkSessions,
    id: i64,
    feature_id: i64,
    sender: &'a WsSender,
    ref_id: &'a str,
}

impl Binding<'_> {
    /// Reply from a live handle when possible. After discovery, install the
    /// proposed handle only if a concurrent spawn has not already won.
    pub(super) async fn initialize(
        &self,
        row: Option<&SessionRow>,
        pending: Option<(SdkHandle, SessionInitializedPayload)>,
    ) -> bool {
        let mut sessions = self.sdk_sessions.lock().await;
        let spawning = self.app_state.session_runtimes.is_spawning(self.id).await;
        let live = sessions
            .get(&self.id)
            .and_then(|handle| live_payload(self.id, handle, row, spawning));
        let (mut payload, runtime, resume_id) = if let Some((payload, runtime)) = live {
            (
                payload,
                runtime,
                row.and_then(|row| row.runtime_session_id.clone()),
            )
        } else if let Some((handle, payload)) = pending {
            let resume_id = handle.resume_session_id.clone();
            sessions.insert(self.id, handle);
            (payload, None, resume_id)
        } else {
            return false;
        };
        if let Some(query) = runtime {
            drop(sessions);
            if let Some(steering) = query.read().await.negotiated_prompt_steering() {
                payload.supports_prompt_receipts = steering;
                payload.prompt_receipts_at_submission = steering;
            }
            self.send_initialized(payload);
            crate::domain::ws_session::runtime::prompt::mcp_servers::replay_cached_mcp_servers(
                self.sdk_sessions,
                self.id,
                &query,
                self.sender,
            )
            .await;
        } else {
            // A spawn publishes the negotiated capabilities after taking this
            // lock. Queue the provisional snapshot before that event can arrive.
            self.send_initialized(payload);
            drop(sessions);
        }
        self.app_state
            .persistence_health
            .replay(self.id, self.sender)
            .await;
        if let Some(resume_id) = resume_id {
            super::super::send_runtime_session_id(self.sender, &resume_id);
        }
        super::restore::restore_pending_or_idle(
            self.app_state,
            self.sender,
            self.id,
            self.feature_id,
        )
        .await;
        if let Err(error) = super::super::session_init_worktree::restore_worktree_state(
            self.app_state,
            self.sender,
            self.feature_id,
        )
        .await
        {
            super::super::send_error(self.sender, self.ref_id, "WORKTREE_CHECK_FAILED", &error);
        }
        true
    }

    fn send_initialized(&self, payload: SessionInitializedPayload) {
        let reply = WsEnvelope::session_reply(self.ref_id, &WsSessionEvent::Initialized(payload))
            .expect("session event payload should serialize");
        self.sender
            .send(axum::extract::ws::Message::Text(String::from(reply).into()))
            .ignore_closed();
    }
}

fn live_payload(
    id: i64,
    handle: &SdkHandle,
    row: Option<&SessionRow>,
    spawning: bool,
) -> Option<(SessionInitializedPayload, Option<RuntimeSessionHandle>)> {
    let live_query = match &handle.state {
        QueryState::Active { query, .. } => Some(query.clone()),
        QueryState::Pending(_) if spawning => None,
        QueryState::Pending(_) => return None,
    };
    let access_mode = handle
        .desired_access_mode
        .as_ref()
        .map(access_mode_wire)
        .map(str::to_owned);
    let adapter = runtime_adapter(&handle.runtime_provider);
    let payload = SessionInitializedPayload {
        session_id: id.to_string(),
        provider: Some(handle.runtime_provider.clone()),
        model: handle.desired_model.clone(),
        thinking_effort: handle.desired_thinking_effort.clone(),
        fast_mode: handle.config.fast_mode,
        profile: handle.desired_claude_profile.clone(),
        runtime_overrides: handle.config.overrides.clone(),
        permission_mode: handle
            .desired_permission_mode
            .as_ref()
            .map(permission_mode_wire),
        codex_permission_mode: adapter
            .as_ref()
            .and_then(|adapter| adapter.legacy_access_mode_wire(access_mode.as_deref())),
        access_mode,
        input_tokens: row.and_then(|row| row.input_tokens).map(|v| v as u64),
        output_tokens: row.and_then(|row| row.output_tokens).map(|v| v as u64),
        context_window: row.and_then(|row| row.context_window).map(|v| v as u64),
        supports_prompt_receipts: adapter
            .as_ref()
            .is_some_and(|adapter| adapter.supports_prompt_receipts()),
        prompt_receipts_at_submission: adapter
            .is_some_and(|adapter| adapter.prompt_receipts_at_submission()),
    };
    Some((payload, live_query))
}

#[bon::builder]
pub(super) fn pending_handle(
    runtime_config: crate::domain::agents::adapter::RuntimeSpawnConfig,
    feature_id: i64,
    runtime_provider: String,
    profile: Option<String>,
    resume_session_id: Option<String>,
) -> SdkHandle {
    let config = SessionConfig::from_runtime(&runtime_config, profile.clone());
    SdkHandle {
        identity: crate::domain::ws_session::runtime::state::RuntimeHandleIdentity::default(),
        feature_id,
        runtime_provider,
        config,
        resume_session_id,
        desired_model: runtime_config.model.clone(),
        desired_permission_mode: runtime_config.permission_mode.clone(),
        desired_access_mode: runtime_config.access_mode.clone(),
        desired_thinking_effort: runtime_config.thinking_effort.clone(),
        desired_claude_profile: profile,
        state: QueryState::Pending(runtime_config),
        spawned_model: None,
        spawned_permission_mode: None,
        spawned_access_mode: None,
        spawned_thinking_effort: None,
        spawned_claude_profile: None,
        runtime_control_endpoint: None,
        manual_compact_start: Default::default(),
        manual_compact_spawn_pending: std::sync::Arc::default(),
    }
}

/// The session row `session.init` resumes from. Without it a resumed
/// conversation would start a fresh agent with no resume id, so a failed read
/// is answered with `DB_ERROR` and stops the init.
pub(super) async fn read_row(
    app_state: &AppState,
    sender: &WsSender,
    envelope_id: &str,
    db_session_id: i64,
) -> Result<Option<SessionRow>, ()> {
    crate::domain::ws_session::persistence::WsSessionPersistence::get_session_row(
        &app_state.read_pool,
        db_session_id,
    )
    .await
    .map_err(|error| {
        super::super::send_error(
            sender,
            envelope_id,
            "DB_ERROR",
            &format!("Failed to read the session: {error}"),
        );
    })
}

pub(super) async fn prepare_controls(
    state: &AppState,
    row: Option<&mut SessionRow>,
    request: &crate::domain::ws_session::protocol::SessionInitPayload,
    cwd: &str,
) -> Result<bool, crate::error::AppError> {
    let Some(row) = row else { return Ok(false) };
    if request.provider.is_some() || request.model.is_some() || request.thinking_effort.is_some() {
        return Ok(false);
    }
    row.inherit_last_prompt(&state.read_pool, std::path::Path::new(cwd))
        .await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::agents::adapter::RuntimeSpawnConfig;
    use crate::domain::ws_session::handler::tests::support::{
        make_active_handle, make_test_app_state,
    };
    use crate::domain::ws_session::handler::types::new_sdk_sessions;

    #[tokio::test]
    async fn initialized_snapshot_precedes_spawn_publication_and_preserves_the_winning_handle() {
        let state = make_test_app_state().await;
        let sessions = new_sdk_sessions();
        for spawning in [false, true] {
            let (sender, mut receiver) = tokio::sync::mpsc::unbounded_channel();
            let binding = Binding::builder()
                .app_state(&state)
                .sdk_sessions(&sessions)
                .id(11)
                .feature_id(1)
                .sender(&sender)
                .ref_id("init")
                .build();
            let mut current = make_active_handle(1, None);
            if spawning {
                current.state = QueryState::Pending(RuntimeSpawnConfig::default());
            }
            current.desired_model = Some("existing-model".into());
            let claim = if spawning {
                Some(state.session_runtimes.claim_spawn(11).await)
            } else {
                None
            };
            let mut registry = sessions.lock().await;
            registry.insert(11, current);
            let pending = pending_handle()
                .runtime_config(RuntimeSpawnConfig::default())
                .feature_id(1)
                .runtime_provider("claude_code".into())
                .call();
            let (payload, _) = live_payload(11, &pending, None, true).unwrap();
            let initialize = binding.initialize(None, Some((pending, payload)));
            tokio::pin!(initialize);
            assert!(futures::poll!(&mut initialize).is_pending());
            drop(registry);
            let check = async {
                let registry = sessions.lock().await;
                assert_eq!(
                    registry[&11].desired_model.as_deref(),
                    Some("existing-model")
                );
                let snapshot: WsEnvelope = if spawning {
                    // A competing registration can now publish its handshake. The viewer
                    // must already have the provisional snapshot queued on its socket.
                    serde_json::from_str(receiver.try_recv().unwrap().to_text().unwrap()).unwrap()
                } else {
                    drop(registry);
                    serde_json::from_str(receiver.recv().await.unwrap().to_text().unwrap()).unwrap()
                };
                assert_eq!(snapshot.action, "initialized");
                assert_eq!(snapshot.payload["model"], "existing-model");
            };
            let (initialized, ()) = tokio::join!(initialize, check);
            assert!(initialized);
            drop(claim);
        }
    }
}
