//! ACP hooks for code-backed installed providers.

use agent_client_protocol::schema::v1::SessionConfigOption;
use async_trait::async_trait;
use serde_json::Value;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{RwLock, RwLockReadGuard, RwLockWriteGuard};

use crate::domain::agents::acp::runtime::provider_hooks::AcpProviderHooks;
use crate::domain::agents::acp::runtime::thought_level::thought_level_config_id;
use crate::domain::agents::adapter::RuntimePermissionMode;

/// Provider-neutral hooks with one host-enforced addition: the model selector
/// discovered before the session must be present and confirmed before prompting.
pub struct InstalledAcpHooks {
    model_config_id: String,
    thinking_effort_config_id: RwLock<Option<String>>,
    capabilities: std::sync::Arc<InstalledAcpCapabilities>,
}

impl InstalledAcpHooks {
    pub fn new(
        model_config_id: String,
        capabilities: std::sync::Arc<InstalledAcpCapabilities>,
    ) -> Self {
        Self {
            model_config_id,
            thinking_effort_config_id: RwLock::new(None),
            capabilities,
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

/// Process-local memory of the latest connector handshake. Stored resume IDs
/// remain independently valid inputs so a capability downgrade fails visibly
/// instead of silently starting a new session.
pub(super) struct InstalledAcpCapabilities {
    durable_resume: AtomicBool,
}

impl Default for InstalledAcpCapabilities {
    fn default() -> Self {
        Self {
            durable_resume: AtomicBool::new(false),
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

    fn supports_durable_resume(&self) -> bool {
        self.capabilities.supports_durable_resume()
    }

    fn observe_durable_resume_capability(&self, supported: bool) {
        self.capabilities.observe_durable_resume(supported);
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
    use super::{InstalledAcpCapabilities, InstalledAcpHooks};
    use crate::domain::agents::acp::runtime::provider_hooks::AcpProviderHooks;
    use agent_client_protocol::schema::v1::SessionConfigOption;
    use serde_json::json;
    use std::sync::Arc;

    fn hooks(model_config_id: &str) -> InstalledAcpHooks {
        InstalledAcpHooks::new(
            model_config_id.to_string(),
            Arc::new(InstalledAcpCapabilities::default()),
        )
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
