//! Host permission and access modes applied to a live ACP session.
//!
//! A provider whose live session exposes a mode-category config option gets
//! its mode through `session/set_config_option`; otherwise the host falls back
//! to `session/set_mode`. Access modes only exist as provider-mapped config
//! options. Every failure the agent reports propagates to the caller.

use crate::domain::agents::adapter::{
    RuntimeAccessMode, RuntimeError, RuntimePermissionMode, RuntimeSessionConfigKind,
    RuntimeSessionConfigSnapshot, RuntimeSessionConfigValue,
};

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
        self.set_select_option(session_id, &config_id, mode_id)
            .await?;
        *self.current_mode.write().await = mode_id.to_string();
        Ok(())
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
        self.set_select_option(&session_id, &config_id, &value)
            .await
    }

    async fn set_select_option(
        &self,
        session_id: &str,
        config_id: &str,
        value: &str,
    ) -> Result<(), RuntimeError> {
        let update_guard = self.session_config.lock_updates().await;
        if select_value(&self.session_config.snapshot().await, config_id) == Some(value) {
            return Ok(());
        }
        let snapshot = self
            .session_config
            .set_option(
                &update_guard,
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
        Ok(())
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
