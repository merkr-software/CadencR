//! ACP v1 session configuration mapped onto provider-neutral runtime types.

use std::sync::atomic::AtomicBool;
use std::sync::Arc;

use agent_client_protocol::schema::v1::{
    SessionConfigKind, SessionConfigOption, SessionConfigOptionCategory, SessionConfigSelectGroup,
    SessionConfigSelectOption, SessionConfigSelectOptions,
};
use tokio::sync::{Mutex, MutexGuard, RwLock};

use super::config_options::send_set_config_option;
use super::provider_hooks::AcpProviderHooks;
use crate::domain::agents::acp::AcpClient;
use crate::domain::agents::adapter::{
    RuntimeError, RuntimeSessionConfigChoices, RuntimeSessionConfigKind,
    RuntimeSessionConfigOption, RuntimeSessionConfigSelectGroup, RuntimeSessionConfigSelectOption,
    RuntimeSessionConfigSnapshot, RuntimeSessionConfigValue,
};

#[derive(Clone)]
pub struct AcpSessionConfigState {
    snapshot: Arc<RwLock<RuntimeSessionConfigSnapshot>>,
    set_lock: Arc<Mutex<()>>,
    hooks: Arc<dyn AcpProviderHooks>,
}

pub(super) enum ConfigNotificationUpdate {
    Snapshot(RuntimeSessionConfigSnapshot),
    Legacy {
        config_id: String,
        value: Option<RuntimeSessionConfigValue>,
    },
    Ignored,
}

impl AcpSessionConfigState {
    pub fn new(snapshot: RuntimeSessionConfigSnapshot, hooks: Arc<dyn AcpProviderHooks>) -> Self {
        Self {
            snapshot: Arc::new(RwLock::new(snapshot)),
            set_lock: Arc::new(Mutex::new(())),
            hooks,
        }
    }

    pub async fn snapshot(&self) -> RuntimeSessionConfigSnapshot {
        self.snapshot.read().await.clone()
    }

    pub(super) async fn read(
        &self,
    ) -> tokio::sync::RwLockReadGuard<'_, RuntimeSessionConfigSnapshot> {
        self.snapshot.read().await
    }

    pub(super) async fn observe_current_mode(&self, mode: &str) {
        let Some(id) = self.hooks.mode_config_id() else {
            return;
        };
        let mut snapshot = self.snapshot.write().await;
        if let Some(RuntimeSessionConfigKind::Select { current_value, .. }) = snapshot
            .options
            .iter_mut()
            .find(|option| option.id == id)
            .map(|option| &mut option.kind)
        {
            mode.clone_into(current_value);
        }
    }

    /// Serialize every ACP configuration request, including the legacy
    /// model/effort entry points. Responses carry complete snapshots, so
    /// allowing their application order to differ from request order could
    /// restore stale dependent choices.
    pub async fn lock_updates(&self) -> MutexGuard<'_, ()> {
        self.set_lock.lock().await
    }

    async fn replace(&self, options: &[SessionConfigOption]) {
        self.hooks.observe_session_config_options(options);
        *self.snapshot.write().await = snapshot_from_options(options);
    }

    /// Observe the complete `configOptions` list returned by an older raw
    /// request path. A missing list means the agent predates the contract and
    /// leaves the previous snapshot untouched.
    pub async fn observe_raw_response(
        &self,
        _update_guard: &MutexGuard<'_, ()>,
        response: Option<&serde_json::Value>,
    ) -> Result<(), RuntimeError> {
        let Some(options) = response.and_then(|value| value.get("configOptions")) else {
            return Ok(());
        };
        let options: Vec<SessionConfigOption> =
            serde_json::from_value(options.clone()).map_err(|error| {
                RuntimeError::new(format!("invalid ACP configOptions response: {error}"))
            })?;
        self.replace(&options).await;
        Ok(())
    }

    pub async fn set_option(
        &self,
        _update_guard: &MutexGuard<'_, ()>,
        client: &AcpClient,
        session_id: &str,
        supports_flag: &Arc<AtomicBool>,
        config_id: &str,
        value: RuntimeSessionConfigValue,
    ) -> Result<RuntimeSessionConfigSnapshot, RuntimeError> {
        self.snapshot
            .read()
            .await
            .validate_value(config_id, &value)
            .map_err(RuntimeError::new)?;
        let response =
            send_set_config_option(client, session_id, supports_flag, config_id, Some(&value))
                .await?
                .ok_or_else(|| {
                    RuntimeError::new("ACP agent does not support session/set_config_option")
                })?;
        let options = response
            .get("configOptions")
            .ok_or_else(|| RuntimeError::new("ACP config response omitted configOptions"))?;
        let options: Vec<SessionConfigOption> = serde_json::from_value(options.clone())
            .map_err(|error| RuntimeError::new(format!("invalid ACP configOptions: {error}")))?;
        self.replace(&options).await;
        Ok(self.snapshot().await)
    }

    /// Apply an agent-initiated ACP `config_option_update`. Current v1 agents
    /// send the complete `configOptions` list; the older single-option shape
    /// remains accepted so existing Cursor/OpenCode builds stay compatible.
    pub(super) async fn observe_notification(
        &self,
        _update_guard: &MutexGuard<'_, ()>,
        body: &serde_json::Value,
    ) -> Result<ConfigNotificationUpdate, RuntimeError> {
        if let Some(options) = body.get("configOptions") {
            let options: Vec<SessionConfigOption> = serde_json::from_value(options.clone())
                .map_err(|error| {
                    RuntimeError::new(format!("invalid ACP config_option_update options: {error}"))
                })?;
            self.replace(&options).await;
            return Ok(ConfigNotificationUpdate::Snapshot(self.snapshot().await));
        }
        let Some(option) = body.get("configOption") else {
            return Ok(ConfigNotificationUpdate::Ignored);
        };
        let Some(config_id) = option.get("name").and_then(serde_json::Value::as_str) else {
            return Ok(ConfigNotificationUpdate::Ignored);
        };
        let Some(raw_value) = option.get("value") else {
            return Ok(ConfigNotificationUpdate::Ignored);
        };
        let value = match raw_value {
            serde_json::Value::String(value) => {
                Some(RuntimeSessionConfigValue::Select(value.clone()))
            }
            serde_json::Value::Bool(value) => Some(RuntimeSessionConfigValue::Boolean(*value)),
            serde_json::Value::Null => None,
            _ => {
                return Err(RuntimeError::new(format!(
                    "ACP config_option_update value has an unsupported type for `{config_id}`"
                )))
            }
        };
        let mut snapshot = self.snapshot.write().await;
        let Some(option) = snapshot
            .options
            .iter_mut()
            .find(|option| option.id == config_id)
        else {
            return Ok(ConfigNotificationUpdate::Legacy {
                config_id: config_id.to_string(),
                value,
            });
        };
        match (&mut option.kind, value.as_ref()) {
            (
                RuntimeSessionConfigKind::Select { current_value, .. },
                Some(RuntimeSessionConfigValue::Select(value)),
            ) => *current_value = value.clone(),
            (
                RuntimeSessionConfigKind::Boolean { current_value },
                Some(RuntimeSessionConfigValue::Boolean(value)),
            ) => *current_value = *value,
            (_, None) => {}
            _ => {
                return Err(RuntimeError::new(format!(
                    "ACP config_option_update value has the wrong type for `{config_id}`"
                )))
            }
        }
        Ok(ConfigNotificationUpdate::Legacy {
            config_id: config_id.to_string(),
            value,
        })
    }
}

pub fn snapshot_from_options(options: &[SessionConfigOption]) -> RuntimeSessionConfigSnapshot {
    RuntimeSessionConfigSnapshot {
        options: options.iter().filter_map(map_option).collect(),
    }
}

fn map_option(option: &SessionConfigOption) -> Option<RuntimeSessionConfigOption> {
    Some(RuntimeSessionConfigOption {
        id: option.id.0.to_string(),
        name: option.name.clone(),
        description: option.description.clone(),
        category: option.category.as_ref().and_then(category_wire),
        kind: match &option.kind {
            SessionConfigKind::Select(select) => RuntimeSessionConfigKind::Select {
                current_value: select.current_value.0.to_string(),
                choices: map_choices(&select.options),
            },
            SessionConfigKind::Boolean(boolean) => RuntimeSessionConfigKind::Boolean {
                current_value: boolean.current_value,
            },
            _ => return None,
        },
        meta: option.meta.as_ref().and_then(meta_value),
    })
}

fn category_wire(category: &SessionConfigOptionCategory) -> Option<String> {
    serde_json::to_value(category)
        .ok()?
        .as_str()
        .map(ToOwned::to_owned)
}

fn map_choices(options: &SessionConfigSelectOptions) -> RuntimeSessionConfigChoices {
    match options {
        SessionConfigSelectOptions::Ungrouped(options) => RuntimeSessionConfigChoices::Ungrouped {
            options: options.iter().map(map_select_option).collect(),
        },
        SessionConfigSelectOptions::Grouped(groups) => RuntimeSessionConfigChoices::Grouped {
            groups: groups.iter().map(map_select_group).collect(),
        },
        _ => RuntimeSessionConfigChoices::Ungrouped {
            options: Vec::new(),
        },
    }
}

fn map_select_group(group: &SessionConfigSelectGroup) -> RuntimeSessionConfigSelectGroup {
    RuntimeSessionConfigSelectGroup {
        id: group.group.0.to_string(),
        name: group.name.clone(),
        options: group.options.iter().map(map_select_option).collect(),
        meta: group.meta.as_ref().and_then(meta_value),
    }
}

fn map_select_option(option: &SessionConfigSelectOption) -> RuntimeSessionConfigSelectOption {
    RuntimeSessionConfigSelectOption {
        value: option.value.0.to_string(),
        name: option.name.clone(),
        description: option.description.clone(),
        meta: option.meta.as_ref().and_then(meta_value),
    }
}

fn meta_value(meta: &agent_client_protocol::schema::v1::Meta) -> Option<serde_json::Value> {
    serde_json::to_value(meta).ok()
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::AtomicBool;
    use std::sync::Arc;

    use agent_client_protocol::schema::v1::{
        SessionConfigOption, SessionConfigOptionCategory, SessionConfigSelectOption,
    };
    use serde_json::json;

    use super::{snapshot_from_options, AcpSessionConfigState};
    use crate::domain::agents::acp::runtime::standard_hooks::StandardAcpHooks;
    use crate::domain::agents::acp::runtime::test_support::{
        build_in_memory_client, read_request, send_response,
    };
    use crate::domain::agents::adapter::{RuntimeSessionConfigKind, RuntimeSessionConfigValue};

    fn model_options(current: &str) -> Vec<SessionConfigOption> {
        vec![SessionConfigOption::select(
            "model",
            "Model",
            current.to_string(),
            vec![
                SessionConfigSelectOption::new("m1", "Model 1"),
                SessionConfigSelectOption::new("m2", "Model 2"),
            ],
        )
        .category(SessionConfigOptionCategory::Model)]
    }

    #[test]
    fn maps_typed_options_without_interpreting_ids() {
        let snapshot = snapshot_from_options(&model_options("m1"));
        assert_eq!(snapshot.options[0].id, "model");
        assert_eq!(snapshot.options[0].category.as_deref(), Some("model"));
        assert!(matches!(
            &snapshot.options[0].kind,
            RuntimeSessionConfigKind::Select { current_value, .. } if current_value == "m1"
        ));
    }

    #[tokio::test]
    async fn set_option_replaces_snapshot_with_the_complete_response() {
        let (client, mut stdout, mut stdin) = build_in_memory_client().await;
        let state = AcpSessionConfigState::new(
            snapshot_from_options(&model_options("m1")),
            Arc::new(StandardAcpHooks),
        );
        let state_for_request = state.clone();
        let client_for_request = client.clone();
        let supports = Arc::new(AtomicBool::new(true));
        let task = tokio::spawn(async move {
            let guard = state_for_request.lock_updates().await;
            state_for_request
                .set_option(
                    &guard,
                    &client_for_request,
                    "session-1",
                    &supports,
                    "model",
                    RuntimeSessionConfigValue::Select("m2".to_string()),
                )
                .await
        });

        let request = read_request(&mut stdin).await;
        assert_eq!(request["method"], "session/set_config_option");
        assert_eq!(request["params"]["configId"], "model");
        assert_eq!(request["params"]["value"], "m2");
        send_response(
            &mut stdout,
            request["id"].clone(),
            json!({ "configOptions": model_options("m2") }),
        )
        .await;

        let snapshot = task.await.unwrap().unwrap();
        assert!(matches!(
            &snapshot.options[0].kind,
            RuntimeSessionConfigKind::Select { current_value, .. } if current_value == "m2"
        ));
        assert_eq!(snapshot, state.snapshot().await);
        client.shutdown().await;
    }
}
