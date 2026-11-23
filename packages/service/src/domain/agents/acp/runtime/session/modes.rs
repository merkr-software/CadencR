//! Host permission and access modes applied to a live ACP session.
//!
//! A provider whose live session exposes a mode-category config option gets
//! its mode through `session/set_config_option`; otherwise the host falls back
//! to `session/set_mode`. Access modes only exist as provider-mapped config
//! options. Every failure the agent reports propagates to the caller.

use crate::domain::agents::adapter::{
    RuntimeAccessMode, RuntimeError, RuntimeEvent, RuntimePermissionMode, RuntimeSessionConfigKind,
    RuntimeSessionConfigSnapshot, RuntimeSessionConfigValue,
};
use crate::shared::discard::IgnoreClosed;
use tokio::sync::MutexGuard;

use super::super::events_config_option::mirror_config_snapshot;
use super::super::mode_switch::set_session_mode;
use super::AcpRuntimeSession;

impl AcpRuntimeSession {
    /// Live `set_permission_mode`: the provider's mapping, else its
    /// handshake-time default mode id.
    pub(super) async fn switch_permission_mode(
        &self,
        mode: RuntimePermissionMode,
    ) -> Result<(), RuntimeError> {
        let mode_id = self
            .hooks
            .mode_for_permission_mode(mode)
            .or_else(|| self.hooks.default_mode_id().map(ToOwned::to_owned))
            .ok_or_else(|| RuntimeError::new("ACP provider does not support permission modes"))?;
        let session_id = self.require_session_id().await?;
        self.apply_mode_id(&session_id, &mode_id).await
    }

    /// Push one provider mode id, through the live mode option when present.
    pub(in crate::domain::agents::acp::runtime) async fn apply_mode_id(
        &self,
        session_id: &str,
        mode_id: &str,
    ) -> Result<(), RuntimeError> {
        let Some(config_id) = self.hooks.mode_config_id() else {
            return set_session_mode(
                &self.client,
                session_id,
                &self.current_mode,
                &self.supports_set_mode,
                mode_id,
            )
            .await;
        };
        let update_guard = self.session_config.lock_updates().await;
        let snapshot = self
            .set_select_option(&update_guard, session_id, &config_id, mode_id)
            .await?;
        let actual = select_value(&snapshot, &config_id);
        let changed = if let Some(actual) = actual {
            let mut current = self.current_mode.write().await;
            let changed = current.as_str() != actual;
            if changed {
                *current = actual.to_owned();
            }
            changed
        } else {
            false
        };
        drop(update_guard);
        if let Some(mode) = actual
            .filter(|actual| changed && *actual != mode_id)
            .and_then(|actual| self.hooks.permission_mode_for_mode_id(actual))
        {
            self.local_tx()
                .send(Ok(RuntimeEvent::permission_mode_changed_event(
                    Some(session_id.to_owned()),
                    mode,
                )))
                .await
                .ignore_closed();
        }
        confirm_select_value(&snapshot, &config_id, mode_id)
    }

    /// Apply a host access mode through the provider-mapped config option.
    pub(in crate::domain::agents::acp::runtime) async fn apply_access_mode(
        &self,
        mode: &RuntimeAccessMode,
    ) -> Result<(), RuntimeError> {
        let (config_id, value) = self
            .hooks
            .access_mode_config(mode)
            .ok_or_else(|| RuntimeError::new("ACP provider does not support this access mode"))?;
        let session_id = self.require_session_id().await?;
        let update_guard = self.session_config.lock_updates().await;
        let snapshot = self
            .set_select_option(&update_guard, &session_id, &config_id, &value)
            .await?;
        confirm_select_value(&snapshot, &config_id, &value)
    }

    async fn set_select_option(
        &self,
        update_guard: &MutexGuard<'_, ()>,
        session_id: &str,
        config_id: &str,
        value: &str,
    ) -> Result<RuntimeSessionConfigSnapshot, RuntimeError> {
        let snapshot = self.session_config.snapshot().await;
        if select_value(&snapshot, config_id) == Some(value) {
            return Ok(snapshot);
        }
        let snapshot = self
            .session_config
            .set_option(
                update_guard,
                &self.client,
                session_id,
                &self.supports_set_config_option,
                config_id,
                RuntimeSessionConfigValue::Select(value.to_string()),
            )
            .await
            .map_err(|error| {
                RuntimeError::new(format!(
                    "ACP agent rejected `{config_id}` = `{value}`: {error}"
                ))
            })?;
        mirror_config_snapshot(&snapshot, &self.current_model, &self.current_effort).await;
        Ok(snapshot)
    }
}

fn confirm_select_value(
    snapshot: &RuntimeSessionConfigSnapshot,
    config_id: &str,
    expected: &str,
) -> Result<(), RuntimeError> {
    match select_value(snapshot, config_id) {
        Some(current) if current == expected => Ok(()),
        Some(current) => Err(RuntimeError::new(format!(
            "ACP agent reported `{config_id}` = `{current}` after requesting `{expected}`"
        ))),
        None => Err(RuntimeError::new(format!(
            "ACP agent did not confirm `{config_id}` = `{expected}`"
        ))),
    }
}

/// Current value of the select option `config_id`, when the snapshot has one.
pub(in crate::domain::agents::acp::runtime) fn select_value<'a>(
    snapshot: &'a RuntimeSessionConfigSnapshot,
    config_id: &str,
) -> Option<&'a str> {
    snapshot
        .options
        .iter()
        .find(|option| option.id == config_id)
        .and_then(|option| match &option.kind {
            RuntimeSessionConfigKind::Select { current_value, .. } => Some(current_value.as_str()),
            RuntimeSessionConfigKind::Boolean { .. } => None,
        })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::agents::acp::runtime::events_stream_blocks::EventIndexer;
    use crate::domain::agents::acp::runtime::lifecycle::NegotiatedSession;
    use crate::domain::agents::acp::runtime::provider_hooks::AcpProviderHooks;
    use crate::domain::agents::acp::runtime::session_config::snapshot_from_options;
    use crate::domain::agents::acp::runtime::test_support::{
        build_in_memory_client, read_request, send_response,
    };
    use agent_client_protocol::schema::v1::SessionConfigOption;
    use serde_json::{json, Value};
    use std::sync::{Arc, Mutex};
    use tokio::sync::mpsc;

    struct ModeHooks;

    #[async_trait::async_trait]
    impl AcpProviderHooks for ModeHooks {
        fn normalize_tool_name(&self, raw: &str) -> String {
            raw.to_owned()
        }

        fn normalize_tool_input(&self, _: &str, input: Value) -> Value {
            input
        }

        fn mode_for_permission_mode(&self, _: RuntimePermissionMode) -> Option<String> {
            Some("auto".into())
        }

        fn mode_config_id(&self) -> Option<String> {
            Some("mode".into())
        }

        fn permission_mode_for_mode_id(&self, mode: &str) -> Option<RuntimePermissionMode> {
            (mode == "default").then_some(RuntimePermissionMode::Default)
        }
    }

    fn config_options(current: &str) -> Vec<SessionConfigOption> {
        serde_json::from_value(json!([{
            "id": "mode", "name": "Mode", "category": "mode", "type": "select",
            "currentValue": current, "options": [
                {"value": "default", "name": "Default"}, {"value": "auto", "name": "Auto"},
                {"value": "accept-edits", "name": "Accept edits"}
            ]
        }]))
        .unwrap()
    }

    #[tokio::test]
    async fn a_native_fallback_does_not_confirm_a_requested_mode() {
        let (client, mut stdout, mut stdin) = build_in_memory_client().await;
        let negotiated = NegotiatedSession {
            session_id: "s".into(),
            model: None,
            mcp_servers: Vec::new(),
            context_window: None,
            current_mode: Some("accept-edits".into()),
            session_config: snapshot_from_options(&config_options("accept-edits")),
            supports_session_close: false,
            supports_prompt_steering: false,
            may_replay_history: false,
        };
        let (tx, rx) = mpsc::channel(8);
        let mut session = AcpRuntimeSession::assemble()
            .client(&client)
            .negotiated(&negotiated)
            .cwd(std::env::temp_dir())
            .rx(rx)
            .local_tx(tx)
            .hooks(Arc::new(ModeHooks))
            .indexer(Arc::new(Mutex::new(EventIndexer::default())))
            .call();

        let switch = tokio::spawn(async move {
            let error = session.apply_mode_id("s", "auto").await.unwrap_err();
            assert!(error
                .to_string()
                .contains("`default` after requesting `auto`"));
            assert_eq!(session.current_mode.read().await.as_str(), "default");
            let observed = session
                .message_rx
                .as_mut()
                .unwrap()
                .try_recv()
                .unwrap()
                .unwrap();
            assert_eq!(
                observed.permission_mode_changed(),
                Some(&RuntimePermissionMode::Default)
            );
            session.apply_mode_id("s", "auto").await.unwrap();
            assert_eq!(session.current_mode.read().await.as_str(), "auto");
        });
        for current in ["default", "auto"] {
            let request = read_request(&mut stdin).await;
            assert_eq!(request["method"], "session/set_config_option");
            assert_eq!(request["params"]["value"], "auto");
            send_response(
                &mut stdout,
                request["id"].clone(),
                json!({"configOptions": config_options(current)}),
            )
            .await;
        }
        switch.await.unwrap();
    }
}
