//! ACP hooks for code-backed installed providers.

use agent_client_protocol::schema::v1::SessionConfigOption;
use async_trait::async_trait;
use serde_json::Value;
use std::sync::{RwLock, RwLockReadGuard, RwLockWriteGuard};

use crate::domain::agents::acp::runtime::provider_hooks::AcpProviderHooks;
use crate::domain::agents::acp::runtime::thought_level::thought_level_config_id;
use crate::domain::agents::adapter::RuntimePermissionMode;

/// Provider-neutral hooks with one host-enforced addition: the model selector
/// discovered before the session must be present and confirmed before prompting.
pub struct InstalledAcpHooks {
    model_config_id: String,
    thinking_effort_config_id: RwLock<Option<String>>,
}

impl InstalledAcpHooks {
    pub fn new(model_config_id: String) -> Self {
        Self {
            model_config_id,
            thinking_effort_config_id: RwLock::new(None),
        }
    }

    fn thinking_effort_config_id_guard(&self) -> RwLockReadGuard<'_, Option<String>> {
        self.thinking_effort_config_id
            .read()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    fn thinking_effort_config_id_mut(&self) -> RwLockWriteGuard<'_, Option<String>> {
        self.thinking_effort_config_id
            .write()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
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

    fn mode_for_permission_mode(&self, _mode: RuntimePermissionMode) -> Option<String> {
        None
    }

    fn model_config_id(&self) -> Option<&str> {
        Some(&self.model_config_id)
    }

    fn requires_verified_model_selection(&self) -> bool {
        true
    }

    fn observe_session_config_options(&self, options: &[SessionConfigOption]) {
        // ACP v1 `configOptions` responses are complete snapshots. Clearing an
        // absent selector prevents a later durable change from targeting a
        // stale provider-owned id.
        *self.thinking_effort_config_id_mut() = thought_level_config_id(options);
    }

    fn thinking_effort_config_id(&self) -> Option<String> {
        self.thinking_effort_config_id_guard().clone()
    }
}

#[cfg(test)]
mod tests {
    use super::InstalledAcpHooks;
    use crate::domain::agents::acp::runtime::provider_hooks::AcpProviderHooks;
    use agent_client_protocol::schema::v1::SessionConfigOption;
    use serde_json::json;

    #[test]
    fn installed_hooks_require_the_discovered_model_selector() {
        let hooks = InstalledAcpHooks::new("model-picker".to_string());
        assert_eq!(hooks.model_config_id(), Some("model-picker"));
        assert!(hooks.requires_verified_model_selection());
    }

    #[test]
    fn installed_hooks_apply_the_negotiated_thinking_selector() {
        let hooks = InstalledAcpHooks::new("model".to_string());
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
