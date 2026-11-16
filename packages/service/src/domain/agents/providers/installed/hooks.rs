//! ACP hooks for code-backed installed providers.
//!
//! Everything provider-specific here is data from the provider executable:
//! the model selector and mode maps come from its `models` output, the
//! compaction command from `host-integration`, and prompt capabilities from
//! the live `initialize` handshake.

use agent_client_protocol::schema::v1::{
    SessionConfigKind, SessionConfigOption, SessionConfigOptionCategory,
};
use async_trait::async_trait;
use serde_json::Value;
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, RwLock, RwLockReadGuard, RwLockWriteGuard};

use super::model_discovery::{ProviderModeMap, ACCESS_MODE_ROLE};
use super::prompt_capabilities::SharedPromptCapabilities;
use super::slash_commands::SlashCommandCatalog;
use crate::domain::agents::acp::runtime::provider_hooks::AcpProviderHooks;
use crate::domain::agents::acp::runtime::thought_level::thought_level_config_id;
use crate::domain::agents::adapter::{
    RuntimeAccessMode, RuntimeError, RuntimePermissionMode, RuntimeSlashCommand,
};
use crate::domain::agents::runtime::ProviderPromptCapabilities;

/// Provider-neutral hooks with one host-enforced addition: the model selector
/// discovered before the session must be present and confirmed before prompting.
pub struct InstalledAcpHooks {
    model_config_id: String,
    modes: Arc<ProviderModeMap>,
    compact_command: Option<String>,
    live: RwLock<LiveConfigIds>,
    capabilities: InstalledAcpCapabilities,
    prompt_capabilities: SharedPromptCapabilities,
    slash_commands: Arc<SlashCommandCatalog>,
}

/// Provider-owned option ids the live session currently exposes.
#[derive(Default)]
struct LiveConfigIds {
    thinking_effort: Option<String>,
    mode: Option<String>,
    access_mode: Option<String>,
}

#[bon::bon]
impl InstalledAcpHooks {
    #[builder]
    pub fn new(
        model_config_id: String,
        #[builder(default)] modes: Arc<ProviderModeMap>,
        compact_command: Option<String>,
        #[builder(default)] prompt_capabilities: SharedPromptCapabilities,
        #[builder(default)] slash_commands: Arc<SlashCommandCatalog>,
    ) -> Self {
        Self {
            model_config_id,
            modes,
            compact_command,
            live: RwLock::new(LiveConfigIds::default()),
            capabilities: InstalledAcpCapabilities::default(),
            prompt_capabilities,
            slash_commands,
        }
    }

    fn live(&self) -> RwLockReadGuard<'_, LiveConfigIds> {
        self.live
            .read()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    fn live_mut(&self) -> RwLockWriteGuard<'_, LiveConfigIds> {
        self.live
            .write()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }
}

/// Session-local memory of this connector handshake. Stored resume IDs
/// remain independently valid inputs so a capability downgrade fails visibly
/// instead of silently starting a new session.
pub(super) struct InstalledAcpCapabilities {
    durable_resume: AtomicBool,
    prompt: RwLock<Option<ProviderPromptCapabilities>>,
}

impl Default for InstalledAcpCapabilities {
    fn default() -> Self {
        Self {
            durable_resume: AtomicBool::new(false),
            prompt: RwLock::new(None),
        }
    }
}

impl InstalledAcpCapabilities {
    pub(super) fn supports_durable_resume(&self) -> bool {
        self.durable_resume.load(Ordering::Acquire)
    }

    fn observe_durable_resume(&self, supported: bool) {
        self.durable_resume.store(supported, Ordering::Release);
    }

    fn prompt(&self) -> ProviderPromptCapabilities {
        self.prompt
            .read()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .unwrap_or_default()
    }
}

fn select_option_id(
    options: &[SessionConfigOption],
    matches: impl Fn(&SessionConfigOption) -> bool,
) -> Option<String> {
    options
        .iter()
        .find(|option| matches!(option.kind, SessionConfigKind::Select(_)) && matches(option))
        .map(|option| option.id.0.to_string())
}

/// The content block kinds a prompt may only carry when advertised.
fn unsupported_block(kind: &str, capabilities: ProviderPromptCapabilities) -> Option<&'static str> {
    match kind {
        "image" if !capabilities.image => Some("images"),
        "audio" if !capabilities.audio => Some("audio"),
        "resource" if !capabilities.embedded_context => Some("embedded documents such as PDFs"),
        _ => None,
    }
}

#[async_trait]
impl AcpProviderHooks for InstalledAcpHooks {
    fn normalize_tool_name(&self, raw: &str) -> String {
        raw.to_string()
    }

    fn normalize_tool_input(&self, _tool_name: &str, input: Value) -> Value {
        input
    }

    fn mode_for_permission_mode(&self, mode: RuntimePermissionMode) -> Option<String> {
        self.modes.mode_for(&mode).map(|entry| entry.value.clone())
    }

    fn mode_config_id(&self) -> Option<String> {
        self.live().mode.clone()
    }

    fn permission_mode_for_mode_id(&self, mode_id: &str) -> Option<RuntimePermissionMode> {
        self.modes.permission_mode_for_value(mode_id)
    }

    fn access_mode_config(&self, mode: &RuntimeAccessMode) -> Option<(String, String)> {
        let entry = self.modes.access_mode_for(mode)?;
        let config_id = self
            .live()
            .access_mode
            .clone()
            .or_else(|| self.modes.access_config_id.clone())?;
        Some((config_id, entry.value.clone()))
    }

    fn compact_prompt(&self) -> Option<String> {
        self.compact_command
            .as_ref()
            .map(|command| format!("/{command}"))
    }

    fn model_config_id(&self) -> Option<&str> {
        Some(&self.model_config_id)
    }

    fn requires_verified_model_selection(&self) -> bool {
        true
    }

    fn supports_durable_resume(&self) -> bool {
        self.capabilities.supports_durable_resume()
    }

    fn observe_durable_resume_capability(&self, supported: bool) {
        self.capabilities.observe_durable_resume(supported);
    }

    fn observe_prompt_capabilities(&self, capabilities: ProviderPromptCapabilities) {
        *self
            .capabilities
            .prompt
            .write()
            .unwrap_or_else(|poisoned| poisoned.into_inner()) = Some(capabilities);
        self.prompt_capabilities.observe(capabilities);
    }

    fn validate_prompt_blocks(&self, blocks: &[Value]) -> Result<(), RuntimeError> {
        let capabilities = self.capabilities.prompt();
        let refused = blocks
            .iter()
            .filter_map(|block| block.get("type").and_then(Value::as_str))
            .find_map(|kind| unsupported_block(kind, capabilities));
        match refused {
            Some(what) => Err(RuntimeError::new(format!(
                "this provider does not accept {what} in prompts (its ACP agent did not \
                 advertise the matching promptCapabilities); remove the attachment and resend"
            ))),
            None => Ok(()),
        }
    }

    fn observe_session_config_options(&self, options: &[SessionConfigOption]) {
        // ACP v1 `configOptions` responses are complete snapshots. Clearing an
        // absent selector prevents a later durable change from targeting a
        // stale provider-owned id.
        let mut live = self.live_mut();
        live.thinking_effort = thought_level_config_id(options);
        live.mode = select_option_id(options, |option| {
            matches!(option.category, Some(SessionConfigOptionCategory::Mode))
        });
        live.access_mode = select_option_id(options, |option| {
            super::model_discovery::option_role(option) == Some(ACCESS_MODE_ROLE)
        });
    }

    fn thinking_effort_config_id(&self) -> Option<String> {
        self.live().thinking_effort.clone()
    }

    /// Keep the live catalog for the `/` menu of later conversations here.
    async fn record_available_commands(&self, cwd: &Path, commands: Vec<RuntimeSlashCommand>) {
        self.slash_commands
            .record_live(&cwd.to_string_lossy(), commands)
            .await;
    }
}

#[cfg(test)]
mod tests {
    use super::InstalledAcpHooks;
    use crate::domain::agents::acp::runtime::provider_hooks::AcpProviderHooks;
    use agent_client_protocol::schema::v1::SessionConfigOption;
    use serde_json::json;

    fn hooks(model_config_id: &str) -> InstalledAcpHooks {
        InstalledAcpHooks::builder()
            .model_config_id(model_config_id.to_string())
            .build()
    }

    #[test]
    fn installed_hooks_require_the_discovered_model_selector() {
        let hooks = hooks("model-picker");
        assert_eq!(hooks.model_config_id(), Some("model-picker"));
        assert!(hooks.requires_verified_model_selection());
        assert!(!hooks.supports_durable_resume());
        hooks.observe_durable_resume_capability(true);
        assert!(hooks.supports_durable_resume());
        hooks.observe_durable_resume_capability(false);
        assert!(!hooks.supports_durable_resume());
    }

    #[test]
    fn installed_hooks_apply_the_negotiated_thinking_selector() {
        let hooks = hooks("model");
        let options: Vec<SessionConfigOption> = serde_json::from_value(json!([
            {
                "id": "model",
                "name": "Model",
                "category": "model",
                "type": "select",
                "currentValue": "m1",
                "options": [{ "value": "m1", "name": "Model 1" }]
            },
            {
                "id": "pi-thinking",
                "name": "Thinking",
                "category": "thought_level",
                "type": "select",
                "currentValue": "medium",
                "options": [{ "value": "medium", "name": "Medium" }]
            }
        ]))
        .unwrap();

        hooks.observe_session_config_options(&options);
        assert_eq!(
            hooks.thinking_effort_config_id().as_deref(),
            Some("pi-thinking")
        );

        hooks.observe_session_config_options(&options[..1]);
        assert!(hooks.thinking_effort_config_id().is_none());
    }
}
