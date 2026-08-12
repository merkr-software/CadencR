//! ACP hooks for code-backed installed providers.

use async_trait::async_trait;
use serde_json::Value;

use crate::domain::agents::acp::runtime::provider_hooks::AcpProviderHooks;
use crate::domain::agents::adapter::RuntimePermissionMode;

/// Provider-neutral hooks with one host-enforced addition: the model selector
/// discovered before the session must be present and confirmed before prompting.
pub struct InstalledAcpHooks {
    model_config_id: String,
}

impl InstalledAcpHooks {
    pub fn new(model_config_id: String) -> Self {
        Self { model_config_id }
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
}

#[cfg(test)]
mod tests {
    use super::InstalledAcpHooks;
    use crate::domain::agents::acp::runtime::provider_hooks::AcpProviderHooks;

    #[test]
    fn installed_hooks_require_the_discovered_model_selector() {
        let hooks = InstalledAcpHooks::new("model-picker".to_string());
        assert_eq!(hooks.model_config_id(), Some("model-picker"));
        assert!(hooks.requires_verified_model_selection());
    }
}
