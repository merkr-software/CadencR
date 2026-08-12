//! Apply a catalog model id through ACP `session/set_config_option`, then any
//! provider companion options (Cursor `fast` / thought-level params).

use std::sync::atomic::AtomicBool;
use std::sync::Arc;

use tokio::sync::RwLock;

use crate::domain::agents::acp::runtime::provider_hooks::AcpProviderHooks;
use crate::domain::agents::acp::AcpClient;
use crate::domain::agents::adapter::{RuntimeError, RuntimeSessionConfigValue};

use super::config_options::{
    send_set_config_option, set_config_option_model_value, set_config_option_thinking_effort,
};
use super::session_config::AcpSessionConfigState;
use super::thought_level::is_thought_level_config_name;

pub async fn apply_model_config(
    client: &AcpClient,
    session_id: &str,
    current_model: &Arc<RwLock<Option<String>>>,
    current_effort: &Arc<RwLock<Option<String>>>,
    supports_flag: &Arc<AtomicBool>,
    session_config: &AcpSessionConfigState,
    hooks: &dyn AcpProviderHooks,
    model: &str,
) -> Result<(), RuntimeError> {
    let update_guard = session_config.lock_updates().await;
    let config_value = hooks.model_config_value(model);
    let result = set_config_option_model_value(
        client,
        session_id,
        current_model,
        supports_flag,
        hooks.model_config_id(),
        model,
        &config_value,
    )
    .await?;
    session_config
        .observe_raw_response(&update_guard, result.as_ref())
        .await?;
    let companions = hooks.model_config_companions(model);
    let effort_config_id = hooks.thinking_effort_config_id();
    for (config_id, value) in companions {
        let is_effort = effort_config_id.as_deref() == Some(config_id.as_str())
            || is_thought_level_config_name(&config_id);
        match value {
            RuntimeSessionConfigValue::Select(value) if is_effort => {
                let result = set_config_option_thinking_effort(
                    client,
                    session_id,
                    current_effort,
                    supports_flag,
                    Some(config_id),
                    Some(&value),
                )
                .await?;
                session_config
                    .observe_raw_response(&update_guard, result.as_ref())
                    .await?;
            }
            value => {
                let result = send_set_config_option(
                    client,
                    session_id,
                    supports_flag,
                    &config_id,
                    Some(&value),
                )
                .await?;
                session_config
                    .observe_raw_response(&update_guard, result.as_ref())
                    .await?;
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::apply_model_config;
    use crate::domain::agents::acp::runtime::provider_hooks::AcpProviderHooks;
    use crate::domain::agents::acp::runtime::session_config::AcpSessionConfigState;
    use crate::domain::agents::acp::runtime::test_support::{
        build_in_memory_client, read_request, send_response,
    };
    use crate::domain::agents::adapter::{
        RuntimeError, RuntimePermissionMode, RuntimeSessionConfigValue,
    };
    use agent_client_protocol::schema::v1::{
        SessionConfigOption, SessionConfigOptionCategory, SessionConfigSelectOption,
    };
    use serde_json::{json, Value};
    use std::sync::atomic::AtomicBool;
    use std::sync::{Arc, Mutex};
    use tokio::sync::RwLock;

    struct ModelSpecificCompanionHooks {
        thought_level_id: Mutex<String>,
    }

    impl ModelSpecificCompanionHooks {
        fn new(initial_id: &str) -> Self {
            Self {
                thought_level_id: Mutex::new(initial_id.to_string()),
            }
        }

        fn thought_level_id(&self) -> String {
            self.thought_level_id
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .clone()
        }
    }

    #[async_trait::async_trait]
    impl AcpProviderHooks for ModelSpecificCompanionHooks {
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

        fn observe_session_config_options(&self, options: &[SessionConfigOption]) {
            let Some(option) = options.iter().find(|option| {
                matches!(
                    option.category,
                    Some(SessionConfigOptionCategory::ThoughtLevel)
                )
            }) else {
                return;
            };
            *self
                .thought_level_id
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner()) = option.id.0.to_string();
        }

        fn model_config_value(&self, model: &str) -> String {
            model.to_string()
        }

        fn model_config_companions(
            &self,
            _model: &str,
        ) -> Vec<(String, RuntimeSessionConfigValue)> {
            vec![(
                self.thought_level_id(),
                RuntimeSessionConfigValue::Select("high".to_string()),
            )]
        }

        fn thinking_effort_config_id(&self) -> Option<String> {
            Some(self.thought_level_id())
        }
    }

    struct BooleanCompanionHooks;

    #[async_trait::async_trait]
    impl AcpProviderHooks for BooleanCompanionHooks {
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

        fn model_config_companions(
            &self,
            _model: &str,
        ) -> Vec<(String, RuntimeSessionConfigValue)> {
            vec![("fast".to_string(), RuntimeSessionConfigValue::Boolean(true))]
        }
    }

    #[tokio::test]
    async fn companions_use_options_returned_by_model_change() -> Result<(), RuntimeError> {
        let (client, mut stdout, mut stdin) = build_in_memory_client().await;
        let current_model = Arc::new(RwLock::new(None));
        let current_effort = Arc::new(RwLock::new(None));
        let supports = Arc::new(AtomicBool::new(true));
        let hooks = Arc::new(ModelSpecificCompanionHooks::new("reasoning"));
        let session_config = AcpSessionConfigState::new(Default::default(), hooks.clone());

        let task = tokio::spawn({
            let client = client.clone();
            let current_model = Arc::clone(&current_model);
            let current_effort = Arc::clone(&current_effort);
            let supports = Arc::clone(&supports);
            let hooks = Arc::clone(&hooks);
            let session_config = session_config.clone();
            async move {
                apply_model_config(
                    &client,
                    "session-1",
                    &current_model,
                    &current_effort,
                    &supports,
                    &session_config,
                    hooks.as_ref(),
                    "grok-4.5",
                )
                .await
            }
        });

        let model_request = read_request(&mut stdin).await;
        assert_eq!(model_request["params"]["configId"], "model");
        let effort_option = SessionConfigOption::select(
            "effort",
            "Effort",
            "high",
            vec![
                SessionConfigSelectOption::new("low", "Low"),
                SessionConfigSelectOption::new("high", "High"),
            ],
        )
        .category(SessionConfigOptionCategory::ThoughtLevel);
        send_response(
            &mut stdout,
            model_request["id"].clone(),
            json!({ "configOptions": [effort_option] }),
        )
        .await;

        let companion_request = read_request(&mut stdin).await;
        assert_eq!(companion_request["params"]["configId"], "effort");
        assert_eq!(companion_request["params"]["value"], "high");
        send_response(&mut stdout, companion_request["id"].clone(), json!({})).await;

        task.await.unwrap()?;
        assert_eq!(current_model.read().await.as_deref(), Some("grok-4.5"));
        assert_eq!(current_effort.read().await.as_deref(), Some("high"));
        Ok(())
    }

    #[tokio::test]
    async fn malformed_model_config_options_are_surfaced() {
        let (client, mut stdout, mut stdin) = build_in_memory_client().await;
        let current_model = Arc::new(RwLock::new(None));
        let current_effort = Arc::new(RwLock::new(None));
        let supports = Arc::new(AtomicBool::new(true));
        let hooks = Arc::new(ModelSpecificCompanionHooks::new("reasoning"));
        let session_config = AcpSessionConfigState::new(Default::default(), hooks.clone());

        let task = tokio::spawn({
            let client = client.clone();
            let current_model = Arc::clone(&current_model);
            let current_effort = Arc::clone(&current_effort);
            let supports = Arc::clone(&supports);
            let hooks = Arc::clone(&hooks);
            let session_config = session_config.clone();
            async move {
                apply_model_config(
                    &client,
                    "session-1",
                    &current_model,
                    &current_effort,
                    &supports,
                    &session_config,
                    hooks.as_ref(),
                    "grok-4.5",
                )
                .await
            }
        });

        let model_request = read_request(&mut stdin).await;
        send_response(
            &mut stdout,
            model_request["id"].clone(),
            json!({ "configOptions": { "unexpected": true } }),
        )
        .await;

        let error = task.await.unwrap().unwrap_err();
        assert!(error
            .to_string()
            .contains("invalid ACP configOptions response"));
    }

    #[tokio::test]
    async fn boolean_companions_keep_their_wire_type() {
        let (client, mut stdout, mut stdin) = build_in_memory_client().await;
        let current_model = Arc::new(RwLock::new(None));
        let current_effort = Arc::new(RwLock::new(None));
        let supports = Arc::new(AtomicBool::new(true));
        let hooks = Arc::new(BooleanCompanionHooks);
        let session_config = AcpSessionConfigState::new(Default::default(), hooks.clone());

        let task = tokio::spawn({
            let client = client.clone();
            let hooks = hooks.clone();
            let session_config = session_config.clone();
            let current_model = current_model.clone();
            let current_effort = current_effort.clone();
            let supports = supports.clone();
            async move {
                apply_model_config(
                    &client,
                    "session-1",
                    &current_model,
                    &current_effort,
                    &supports,
                    &session_config,
                    hooks.as_ref(),
                    "composer-2.5-fast",
                )
                .await
            }
        });

        let model_request = read_request(&mut stdin).await;
        send_response(
            &mut stdout,
            model_request["id"].clone(),
            json!({
                "configOptions": [SessionConfigOption::boolean("fast", "Fast", false)]
            }),
        )
        .await;
        let fast_request = read_request(&mut stdin).await;
        assert_eq!(fast_request["params"]["configId"], "fast");
        assert_eq!(fast_request["params"]["value"], true);
        send_response(
            &mut stdout,
            fast_request["id"].clone(),
            json!({
                "configOptions": [SessionConfigOption::boolean("fast", "Fast", true)]
            }),
        )
        .await;

        task.await.unwrap().unwrap();
    }
}
