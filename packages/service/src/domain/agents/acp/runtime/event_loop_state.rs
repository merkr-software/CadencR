//! State-mirror helpers for the ACP event loop. Lifted out of
//! `server_requests.rs` to keep that module under the 400-line ceiling
//! after W4 added the shared `EventIndexer` and prompt-turn lock.
//!
//! Mirrors agent-initiated session-info notifications into the session's
//! local state so set_model / set_thinking_effort callers see the right
//! current values, and so the FE's "current mode" indicator stays in sync.

use serde_json::Value;

use super::events::{mirror_session_info_update, parse_available_commands};
use super::events_config_option::{mirror_config_snapshot, mirror_legacy_config_update};
use super::events_stream_blocks::EventIndexer;
use super::server_requests::EventLoopConfig;
use super::session::select_value;
use super::session_config::ConfigNotificationUpdate;
use crate::domain::agents::adapter::{RuntimeEvent, RuntimeSessionConfigValue};

/// What a `session/update` changed in the session's mirrored state.
#[derive(Default)]
pub struct SessionStateSync {
    /// The update moved the session's model. The echo of the client's own
    /// `set_model` finds the model already there, as `apply_model_config`
    /// writes it under the same update lock.
    pub agent_moved_model: bool,
    /// A mode the agent switched itself into, in host terms.
    pub mode_changed: Option<RuntimeEvent>,
}

/// Mirror agent-initiated `current_mode_update` / `config_option_update` /
/// `session_info_update` notifications into the session's local state, and
/// log slash-command catalog updates for diagnostics.
pub async fn sync_session_state_from_update(
    params: &Value,
    config: &EventLoopConfig,
) -> SessionStateSync {
    // Borrowed — `events::session_update_to_events` does the same dance, and
    // both run on every `session/update` notification, so we pay no clones.
    let body = params.get("update").unwrap_or(params);
    let kind = body.get("sessionUpdate").and_then(Value::as_str);
    match kind {
        Some("current_mode_update") => {
            let Some(mode) = body.get("currentModeId").and_then(Value::as_str) else {
                return SessionStateSync::default();
            };
            return SessionStateSync {
                agent_moved_model: false,
                mode_changed: observe_provider_mode(config, mode).await,
            };
        }
        Some("available_commands_update") => {
            // Mirror the agent-advertised catalog into the provider's
            // per-cwd snapshot via the hook so the synchronous
            // `commands.get` WS request reads back a live list. The
            // typed `SlashCommandsUpdated` event continues to flow
            // through `events::map_available_commands_update` for
            // mid-session FE pushes.
            let commands = parse_available_commands(body);
            tracing::debug!(
                count = commands.len(),
                "ACP agent advertised slash commands"
            );
            config
                .hooks
                .record_available_commands(&config.cwd, commands)
                .await;
        }
        Some("config_option_update") => {
            let before = config.current_model.read().await.clone();
            let mode_changed = sync_config_update(body, config).await;
            return SessionStateSync {
                agent_moved_model: *config.current_model.read().await != before,
                mode_changed,
            };
        }
        Some("session_info_update") => {
            let before = config.current_model.read().await.clone();
            mirror_session_info_update(body, &config.current_model).await;
            return SessionStateSync {
                agent_moved_model: *config.current_model.read().await != before,
                mode_changed: None,
            };
        }
        _ => {}
    }
    SessionStateSync::default()
}

async fn sync_config_update(body: &Value, config: &EventLoopConfig) -> Option<RuntimeEvent> {
    let update_guard = config.session_config.lock_updates().await;
    let mode_value = match config
        .session_config
        .observe_notification(&update_guard, body)
        .await
    {
        Ok(ConfigNotificationUpdate::Snapshot(snapshot)) => {
            mirror_config_snapshot(&snapshot, &config.current_model, &config.current_effort).await;
            let mode_config_id = config.hooks.mode_config_id()?;
            select_value(&snapshot, &mode_config_id).map(ToOwned::to_owned)
        }
        Ok(ConfigNotificationUpdate::Legacy { config_id, value }) => {
            mirror_legacy_config_update(
                &config_id,
                value.as_ref(),
                &config.current_model,
                &config.current_effort,
            )
            .await;
            match value {
                Some(RuntimeSessionConfigValue::Select(value))
                    if config.hooks.mode_config_id().as_deref() == Some(config_id.as_str()) =>
                {
                    Some(value)
                }
                _ => None,
            }
        }
        Ok(ConfigNotificationUpdate::Ignored) => {
            tracing::debug!("ignoring ACP config update without options");
            None
        }
        Err(error) => {
            tracing::warn!(%error, "ignoring invalid ACP config option update");
            None
        }
    };
    drop(update_guard);
    observe_provider_mode(config, &mode_value?).await
}

/// Record the agent's current mode id; report it in host terms when it moved.
async fn observe_provider_mode(config: &EventLoopConfig, mode: &str) -> Option<RuntimeEvent> {
    {
        let mut current = config.current_mode.write().await;
        if *current == mode {
            return None;
        }
        *current = mode.to_string();
    }
    tracing::debug!(mode, "ACP agent updated current mode");
    let host_mode = config.hooks.permission_mode_for_mode_id(mode)?;
    let session_id = config.session_id.read().await.clone();
    Some(RuntimeEvent::permission_mode_changed_event(
        session_id, host_mode,
    ))
}

/// The model the running prompt's replies are labelled with. Only the agent
/// moves it (`agent_moved_model`, see [`sync_session_state_from_update`]) —
/// never a local `set_model`, which applies at the next prompt.
pub fn latched_turn_model(
    indexer: &mut EventIndexer,
    agent_moved_model: bool,
    current_model: Option<String>,
) -> Option<String> {
    if agent_moved_model || indexer.turn_model().is_none() {
        indexer.latch_turn_model(current_model);
    }
    indexer.turn_model().map(ToOwned::to_owned)
}

#[cfg(test)]
mod tests {
    use super::sync_session_state_from_update;
    use crate::domain::agents::acp::runtime::events_stream_blocks::EventIndexer;
    use crate::domain::agents::acp::runtime::permissions::PendingPermissions;
    use crate::domain::agents::acp::runtime::prompt_receipts::PendingPromptReceipts;
    use crate::domain::agents::acp::runtime::provider_hooks::AcpProviderHooks;
    use crate::domain::agents::acp::runtime::server_requests::EventLoopConfig;
    use crate::domain::agents::acp::runtime::session_config::{
        snapshot_from_options, AcpSessionConfigState,
    };
    use crate::domain::agents::acp::runtime::session_permissions::SessionPermissions;
    use crate::domain::agents::acp::runtime::terminal_registry::TerminalRegistry;
    use crate::domain::agents::adapter::{
        RuntimePermissionMode, RuntimeSessionConfigKind, RuntimeSlashCommand,
    };
    use agent_client_protocol::schema::v1::{
        SessionConfigOption, SessionConfigOptionCategory, SessionConfigSelectOption,
    };
    use serde_json::{json, Value};
    use std::path::{Path, PathBuf};
    use std::sync::atomic::AtomicBool;
    use std::sync::{Arc, Mutex};
    use tokio::sync::{Mutex as TokioMutex, RwLock};

    struct PlainHooks;
    #[async_trait::async_trait]
    impl AcpProviderHooks for PlainHooks {
        fn normalize_tool_name(&self, raw: &str) -> String {
            raw.to_string()
        }
        fn normalize_tool_input(&self, _: &str, input: Value) -> Value {
            input
        }
        fn flatten_tool_result_content(&self, blocks: &[Value]) -> Value {
            json!(blocks)
        }
        fn mode_for_permission_mode(&self, _: RuntimePermissionMode) -> Option<String> {
            None
        }
    }

    /// Hooks impl that records every `record_available_commands` call so
    /// the `event_loop_state` plumbing can be exercised without coupling
    /// to a specific provider's snapshot store.
    struct RecordingHooks {
        recorded: Arc<TokioMutex<Vec<(PathBuf, Vec<RuntimeSlashCommand>)>>>,
    }

    #[async_trait::async_trait]
    impl AcpProviderHooks for RecordingHooks {
        fn normalize_tool_name(&self, raw: &str) -> String {
            raw.to_string()
        }
        fn normalize_tool_input(&self, _: &str, input: Value) -> Value {
            input
        }
        fn flatten_tool_result_content(&self, blocks: &[Value]) -> Value {
            json!(blocks)
        }
        fn mode_for_permission_mode(&self, _: RuntimePermissionMode) -> Option<String> {
            None
        }
        async fn record_available_commands(&self, cwd: &Path, commands: Vec<RuntimeSlashCommand>) {
            self.recorded
                .lock()
                .await
                .push((cwd.to_path_buf(), commands));
        }
    }

    fn dummy_config() -> EventLoopConfig {
        let hooks = Arc::new(PlainHooks);
        EventLoopConfig {
            session_id: Arc::new(RwLock::new(None)),
            current_model: Arc::new(RwLock::new(None)),
            current_effort: Arc::new(RwLock::new(None)),
            current_mode: Arc::new(RwLock::new("build".to_string())),
            session_config: AcpSessionConfigState::new(Default::default(), hooks.clone()),
            cwd: PathBuf::from("/tmp"),
            closing: Arc::new(AtomicBool::new(false)),
            pending_permissions: PendingPermissions::default(),
            session_permissions: SessionPermissions::new(),
            terminals: Arc::new(TerminalRegistry::default()),
            hooks,
            replay_suppression: Arc::new(AtomicBool::new(false)),
            pending_prompt_receipts: Arc::new(PendingPromptReceipts::default()),
            indexer: Arc::new(Mutex::new(EventIndexer::default())),
        }
    }

    #[tokio::test]
    async fn current_mode_update_syncs_local_mode_state() {
        let cfg = dummy_config();
        let params = json!({
            "sessionId": "s1",
            "update": {
                "sessionUpdate": "current_mode_update",
                "currentModeId": "plan"
            }
        });
        sync_session_state_from_update(&params, &cfg).await;
        assert_eq!(cfg.current_mode.read().await.clone(), "plan".to_string());
    }

    #[tokio::test]
    async fn config_option_update_mirrors_model_into_session_state() {
        let mut cfg = dummy_config();
        let options = vec![SessionConfigOption::select(
            "model",
            "Model",
            "m1",
            vec![
                SessionConfigSelectOption::new("m1", "Model 1"),
                SessionConfigSelectOption::new("m2", "Model 2"),
            ],
        )
        .category(SessionConfigOptionCategory::Model)];
        cfg.session_config =
            AcpSessionConfigState::new(snapshot_from_options(&options), cfg.hooks.clone());
        let params = json!({
            "sessionId": "s1",
            "update": {
                "sessionUpdate": "config_option_update",
                "configOption": { "name": "model", "value": "m2" }
            }
        });
        assert!(
            sync_session_state_from_update(&params, &cfg)
                .await
                .agent_moved_model
        );
        assert_eq!(cfg.current_model.read().await.as_deref(), Some("m2"));
        assert!(matches!(
            &cfg.session_config.snapshot().await.options[0].kind,
            RuntimeSessionConfigKind::Select { current_value, .. } if current_value == "m2"
        ));
        assert!(
            !sync_session_state_from_update(&params, &cfg)
                .await
                .agent_moved_model,
            "the echo of a model the session already runs moves nothing"
        );
    }

    #[tokio::test]
    async fn complete_config_update_replaces_snapshot_and_legacy_model_mirror() {
        let cfg = dummy_config();
        let options = vec![
            SessionConfigOption::select(
                "model",
                "Model",
                "m2",
                vec![
                    SessionConfigSelectOption::new("m1", "Model 1"),
                    SessionConfigSelectOption::new("m2", "Model 2"),
                ],
            )
            .category(SessionConfigOptionCategory::Model),
            SessionConfigOption::select(
                "effort",
                "Effort",
                "high",
                vec![
                    SessionConfigSelectOption::new("low", "Low"),
                    SessionConfigSelectOption::new("high", "High"),
                ],
            )
            .category(SessionConfigOptionCategory::ThoughtLevel),
        ];
        let params = json!({
            "sessionId": "s1",
            "update": {
                "sessionUpdate": "config_option_update",
                "configOptions": options
            }
        });

        sync_session_state_from_update(&params, &cfg).await;

        assert_eq!(cfg.current_model.read().await.as_deref(), Some("m2"));
        assert_eq!(cfg.current_effort.read().await.as_deref(), Some("high"));
        let snapshot = cfg.session_config.snapshot().await;
        assert!(matches!(
            &snapshot.options[0].kind,
            RuntimeSessionConfigKind::Select { current_value, .. } if current_value == "m2"
        ));
    }

    #[tokio::test]
    async fn available_commands_update_invokes_hook_with_parsed_catalog() {
        let recorded = Arc::new(TokioMutex::new(Vec::new()));
        let mut cfg = dummy_config();
        cfg.cwd = PathBuf::from("/repo/feature");
        cfg.hooks = Arc::new(RecordingHooks {
            recorded: Arc::clone(&recorded),
        });
        let params = json!({
            "sessionId": "s1",
            "update": {
                "sessionUpdate": "available_commands_update",
                "availableCommands": [
                    { "name": "compact", "description": "summarize" },
                    { "name": "init" }
                ]
            }
        });
        sync_session_state_from_update(&params, &cfg).await;

        let recorded = recorded.lock().await;
        assert_eq!(recorded.len(), 1);
        let (cwd, commands) = &recorded[0];
        assert_eq!(cwd, &PathBuf::from("/repo/feature"));
        assert_eq!(commands.len(), 2);
        assert_eq!(commands[0].name, "compact");
        assert_eq!(commands[0].description.as_deref(), Some("summarize"));
        assert_eq!(commands[1].name, "init");
        assert!(commands[1].description.is_none());
    }

    #[tokio::test]
    async fn unrelated_session_updates_leave_mode_unchanged() {
        let cfg = dummy_config();
        let params = json!({
            "update": { "sessionUpdate": "agent_message_chunk", "content": "hi" }
        });
        sync_session_state_from_update(&params, &cfg).await;
        assert_eq!(cfg.current_mode.read().await.clone(), "build".to_string());
    }

    #[test]
    fn a_local_model_change_waits_for_the_next_prompt_unless_the_agent_moves_it() {
        use super::latched_turn_model;
        let mut indexer = EventIndexer::default();
        indexer.latch_turn_model(Some("m1".into()));
        assert_eq!(
            latched_turn_model(&mut indexer, false, Some("m2".into())).as_deref(),
            Some("m1")
        );
        assert_eq!(
            latched_turn_model(&mut indexer, true, Some("m2".into())).as_deref(),
            Some("m2")
        );
        let mut fresh = EventIndexer::default();
        assert_eq!(
            latched_turn_model(&mut fresh, false, Some("m3".into())).as_deref(),
            Some("m3")
        );
    }
}
