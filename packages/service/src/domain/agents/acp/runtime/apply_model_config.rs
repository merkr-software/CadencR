//! Apply a catalog model id through ACP `session/set_config_option`.

use std::sync::atomic::AtomicBool;
use std::sync::Arc;

use tokio::sync::RwLock;

use crate::domain::agents::acp::runtime::provider_hooks::AcpProviderHooks;
use crate::domain::agents::acp::AcpClient;
use crate::domain::agents::adapter::RuntimeError;

use super::config_options::set_config_option_model_value;
use super::session_config::AcpSessionConfigState;

pub async fn apply_model_config(
    client: &AcpClient,
    session_id: &str,
    current_model: &Arc<RwLock<Option<String>>>,
    supports_flag: &Arc<AtomicBool>,
    session_config: &AcpSessionConfigState,
    hooks: &dyn AcpProviderHooks,
    model: &str,
) -> Result<(), RuntimeError> {
    let update_guard = session_config.lock_updates().await;
    let result = set_config_option_model_value(
        client,
        session_id,
        current_model,
        supports_flag,
        hooks.model_config_id(),
        model,
        model,
    )
    .await?;
    session_config
        .observe_raw_response(&update_guard, result.as_ref())
        .await
}

#[cfg(test)]
mod tests {
    use super::apply_model_config;
    use crate::domain::agents::acp::runtime::provider_hooks::AcpProviderHooks;
    use crate::domain::agents::acp::runtime::session_config::AcpSessionConfigState;
    use crate::domain::agents::acp::runtime::test_support::{
        build_in_memory_client, read_request, send_response,
    };
    use crate::domain::agents::adapter::{RuntimeError, RuntimePermissionMode};
    use serde_json::{json, Value};
    use std::sync::atomic::AtomicBool;
    use std::sync::Arc;
    use tokio::sync::RwLock;

    struct ModelSelectorHooks;

    #[async_trait::async_trait]
    impl AcpProviderHooks for ModelSelectorHooks {
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
            Some("model")
        }
    }

    async fn run_model_change(
        response: Value,
    ) -> (Result<(), RuntimeError>, Value, Arc<RwLock<Option<String>>>) {
        let (client, mut stdout, mut stdin) = build_in_memory_client().await;
        let current_model = Arc::new(RwLock::new(None));
        let supports = Arc::new(AtomicBool::new(true));
        let hooks = Arc::new(ModelSelectorHooks);
        let session_config = AcpSessionConfigState::new(Default::default(), hooks.clone());

        let task = tokio::spawn({
            let current_model = Arc::clone(&current_model);
            async move {
                apply_model_config(
                    &client,
                    "session-1",
                    &current_model,
                    &supports,
                    &session_config,
                    hooks.as_ref(),
                    "grok-4.5",
                )
                .await
            }
        });

        let model_request = read_request(&mut stdin).await;
        send_response(&mut stdout, model_request["id"].clone(), response).await;
        (task.await.unwrap(), model_request, current_model)
    }

    #[tokio::test]
    async fn model_change_sends_the_catalog_id_to_the_selector() {
        let (result, request, current_model) =
            run_model_change(json!({ "configOptions": [] })).await;
        result.unwrap();
        assert_eq!(request["params"]["configId"], "model");
        assert_eq!(request["params"]["value"], "grok-4.5");
        assert_eq!(current_model.read().await.as_deref(), Some("grok-4.5"));
    }

    #[tokio::test]
    async fn malformed_model_config_options_are_surfaced() {
        let (result, _, _) =
            run_model_change(json!({ "configOptions": { "unexpected": true } })).await;
        assert!(result
            .unwrap_err()
            .to_string()
            .contains("invalid ACP configOptions response"));
    }
}
