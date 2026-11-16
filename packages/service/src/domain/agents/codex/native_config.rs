use codex_app_server_sdk_rs::CodexModel;
use serde_json::Value;

use super::{catalog_from_models, FAST_SERVICE_TIER};
use crate::domain::agents::runtime::{ModelCatalogEntry, ProviderCatalogEntry};

#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) struct NativeEffectiveConfig {
    pub model: Option<String>,
    pub thinking_effort: Option<String>,
    pub fast_mode: Option<bool>,
    pub service_tier: Option<String>,
}

pub(super) fn native_effective_config(config_read: &Value) -> NativeEffectiveConfig {
    let config = config_read.get("config").unwrap_or(config_read);
    NativeEffectiveConfig {
        model: config
            .get("model")
            .and_then(Value::as_str)
            .map(ToOwned::to_owned),
        thinking_effort: config
            .get("model_reasoning_effort")
            .or_else(|| config.get("reasoning_effort"))
            .and_then(Value::as_str)
            .map(ToOwned::to_owned),
        service_tier: config
            .get("service_tier")
            .or_else(|| config.get("serviceTier"))
            .and_then(Value::as_str)
            .map(ToOwned::to_owned),
        fast_mode: config
            .get("service_tier")
            .or_else(|| config.get("serviceTier"))
            .and_then(Value::as_str)
            .map(|tier| tier == FAST_SERVICE_TIER),
    }
}

pub(super) fn reasoning_summary(config_read: &Value) -> Option<&str> {
    let config = config_read.get("config").unwrap_or(config_read);
    if let Some(summary) = config
        .get("model_reasoning_summary")
        .and_then(Value::as_str)
    {
        return Some(summary);
    }
    // OpenAI's model catalog can default summaries to `none`. Cadencr displays
    // them, so opt in without forcing model capabilities. Other inference
    // providers (including Bedrock) may reject the summary parameter.
    let provider = config.get("model_provider").and_then(Value::as_str);
    let supports_summaries = config
        .get("model_supports_reasoning_summaries")
        .and_then(Value::as_bool);
    if matches!(provider, None | Some("openai")) && supports_summaries != Some(false) {
        Some("detailed")
    } else {
        None
    }
}

pub(super) fn enrich_resume_config(
    config_read: &mut Value,
    models: &[CodexModel],
    selected_model: Option<&str>,
) {
    let config_value = if config_read.get("config").is_some() {
        &mut config_read["config"]
    } else {
        config_read
    };
    let config = config_value
        .as_object_mut()
        .expect("Codex config/read config is an object");
    let model = config
        .get("model")
        .and_then(Value::as_str)
        .map(ToOwned::to_owned)
        .or_else(|| {
            models
                .iter()
                .find(|model| model.is_default)
                .map(|model| model.id.clone())
        })
        .or_else(|| models.first().map(|model| model.id.clone()));
    if config.get("model").and_then(Value::as_str).is_none() {
        if let Some(model) = model.as_ref() {
            config.insert("model".to_string(), Value::String(model.clone()));
        }
    }
    if config
        .get("model_reasoning_effort")
        .and_then(Value::as_str)
        .is_none()
    {
        let effort = selected_model.or(model.as_deref()).and_then(|selected| {
            models
                .iter()
                .find(|model| model.id == selected)
                .and_then(|model| model.default_effort.clone())
        });
        if let Some(effort) = effort {
            config.insert("model_reasoning_effort".to_string(), Value::String(effort));
        }
    }
    config.entry("service_tier").or_insert(Value::Null);
}
pub(super) fn catalog_with_effective_config(
    models: Vec<CodexModel>,
    config_read: &Value,
) -> ProviderCatalogEntry {
    let effective = native_effective_config(config_read);
    let configured_model = effective.model.as_deref();
    let configured_effort = effective.thinking_effort.as_deref();
    let mut catalog = catalog_from_models(models);
    if let Some(model) = configured_model {
        if let Some(entry) = catalog.models.iter_mut().find(|entry| entry.id == model) {
            if let Some(effort) = configured_effort {
                entry.default_effort_level = Some(effort.to_string());
            }
        } else {
            catalog.models.push(ModelCatalogEntry {
                id: model.to_string(),
                label: model.to_string(),
                description: Some("Configured in the effective Codex config".to_string()),
                supports_effort: configured_effort.map(|_| true),
                supported_effort_levels: configured_effort.map(|value| vec![value.to_string()]),
                default_effort_level: configured_effort.map(ToOwned::to_owned),
                supports_adaptive_thinking: None,
                supports_fast_mode: effective.fast_mode,
                supports_auto_mode: None,
            });
        }
        catalog.default_model = Some(model.to_string());
    }
    catalog
}

#[cfg(test)]
mod tests {
    use super::{catalog_with_effective_config, enrich_resume_config, reasoning_summary};
    use codex_app_server_sdk_rs::CodexModel;
    use serde_json::json;

    #[test]
    fn openai_summaries_are_enabled_without_forcing_model_capabilities() {
        for config in [
            json!({}),
            json!({"model_provider": null, "model_reasoning_summary": null}),
            json!({"model_provider": "openai"}),
        ] {
            assert_eq!(reasoning_summary(&config), Some("detailed"));
        }
    }

    #[test]
    fn other_providers_and_explicitly_unsupported_models_keep_native_defaults() {
        for config in [
            json!({"model_provider": "amazon-bedrock"}),
            json!({"model_provider": "custom"}),
            json!({"model_provider": "ollama"}),
            json!({"model_supports_reasoning_summaries": false}),
            json!({"model_provider": "openai", "model_supports_reasoning_summaries": false}),
        ] {
            assert_eq!(reasoning_summary(&config), None);
        }
    }

    #[test]
    fn explicit_native_summary_choices_are_preserved_for_every_provider() {
        for provider in ["openai", "amazon-bedrock", "custom"] {
            for summary in ["none", "auto", "concise", "detailed"] {
                assert_eq!(
                    reasoning_summary(&json!({
                        "model_provider": provider,
                        "model_reasoning_summary": summary,
                    })),
                    Some(summary)
                );
            }
        }
    }

    #[test]
    fn configured_unknown_model_and_effort_become_catalog_default() {
        let catalog = catalog_with_effective_config(
            vec![CodexModel {
                id: "known".into(),
                label: "Known".into(),
                description: None,
                supported_efforts: vec!["low".into()],
                default_effort: Some("low".into()),
                service_tiers: Vec::new(),
                context_window: None,
                is_default: true,
            }],
            &json!({"config": {"model": "custom-native", "model_reasoning_effort": "xhigh", "service_tier": "priority"}}),
        );
        assert_eq!(catalog.default_model.as_deref(), Some("custom-native"));
        let custom = catalog
            .models
            .iter()
            .find(|model| model.id == "custom-native")
            .unwrap();
        assert_eq!(custom.default_effort_level.as_deref(), Some("xhigh"));
        assert_eq!(custom.supports_fast_mode, Some(true));
    }

    #[test]
    fn resume_config_uses_model_metadata_defaults_when_file_omits_them() {
        let mut config =
            json!({"config": {"model": "native-default", "model_reasoning_effort": null}});
        enrich_resume_config(
            &mut config,
            &[
                CodexModel {
                    id: "native-default".into(),
                    label: "Native".into(),
                    description: None,
                    supported_efforts: vec!["low".into()],
                    default_effort: Some("low".into()),
                    service_tiers: Vec::new(),
                    context_window: None,
                    is_default: true,
                },
                CodexModel {
                    id: "selected".into(),
                    label: "Selected".into(),
                    description: None,
                    supported_efforts: vec!["high".into()],
                    default_effort: Some("high".into()),
                    service_tiers: Vec::new(),
                    context_window: None,
                    is_default: false,
                },
            ],
            Some("selected"),
        );
        assert_eq!(config["config"]["model"], "native-default");
        assert_eq!(config["config"]["model_reasoning_effort"], "high");
        assert!(config["config"]["service_tier"].is_null());
    }
}
