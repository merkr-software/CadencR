use codex_app_server_sdk_rs::CodexAppServerClient;
use serde_json::Value;

use super::instructions::codex_developer_instructions;
use super::mcp::thread_config;
use super::native_config::reasoning_summary;
use super::thread_params::{thread_resume_params, thread_start_params};
use crate::domain::agents::adapter::{RuntimeError, RuntimeSpawnConfig};

pub(super) fn effective_thread_config(config: &RuntimeSpawnConfig, effective: &Value) -> Value {
    let native = effective.get("config").unwrap_or(effective);
    let native_instructions = native.get("developer_instructions").and_then(Value::as_str);
    let instructions = codex_developer_instructions(config, native_instructions);
    let mut result = thread_config(config.mcp_servers.as_ref(), instructions);
    if let Some(summary) = reasoning_summary(native) {
        ensure_object_mut(&mut result).insert(
            "model_reasoning_summary".to_string(),
            Value::String(summary.to_string()),
        );
    }
    if let Some(native_servers) = native.get("mcp_servers").and_then(Value::as_object) {
        let target = ensure_object_mut(&mut result)
            .entry("mcp_servers")
            .or_insert_with(|| serde_json::json!({}))
            .as_object_mut()
            .expect("Codex MCP config is an object");
        for (name, value) in native_servers {
            target
                .entry(name.clone())
                .or_insert_with(|| mcp_config_override(value));
        }
    }
    if config.resume_session_id.is_some() {
        if let Some(model) = config
            .overrides
            .model
            .as_deref()
            .or_else(|| native.get("model").and_then(Value::as_str))
        {
            ensure_object_mut(&mut result)
                .insert("model".to_string(), Value::String(model.to_string()));
        }
        if let Some(effort) = config
            .overrides
            .thinking_effort
            .as_deref()
            .or_else(|| native.get("model_reasoning_effort").and_then(Value::as_str))
        {
            ensure_object_mut(&mut result).insert(
                "model_reasoning_effort".to_string(),
                Value::String(effort.to_string()),
            );
        }
        let tier = config
            .overrides
            .fast_mode
            .map(super::fast_service_tier_value)
            .or_else(|| native.get("service_tier").cloned());
        if let Some(tier) = tier {
            ensure_object_mut(&mut result).insert("service_tier".to_string(), tier);
        }
    }
    result
}

fn ensure_object_mut(value: &mut Value) -> &mut serde_json::Map<String, Value> {
    if !value.is_object() {
        *value = serde_json::json!({});
    }
    value
        .as_object_mut()
        .expect("Codex thread config is an object")
}

// `config/read` includes null optional MCP fields. Thread overrides are converted
// to TOML by Codex, where null becomes an empty string (invalid for timeouts).
// Omit absent fields while retaining explicit values, including empty strings.
fn mcp_config_override(value: &Value) -> Value {
    match value {
        Value::Object(fields) => Value::Object(
            fields
                .iter()
                .filter(|(_, value)| !value.is_null())
                .map(|(key, value)| (key.clone(), mcp_config_override(value)))
                .collect(),
        ),
        Value::Array(values) => Value::Array(values.iter().map(mcp_config_override).collect()),
        value => value.clone(),
    }
}

pub(super) async fn start_or_resume_thread(
    client: &CodexAppServerClient,
    config: &RuntimeSpawnConfig,
    mcp_config: &Value,
) -> Result<String, RuntimeError> {
    match config.resume_session_id.as_deref() {
        Some(thread_id) => Ok(client
            .thread_resume(thread_resume_params(thread_id, config, mcp_config))
            .await?
            .id),
        None => Ok(client
            .thread_start(thread_start_params(config, mcp_config))
            .await?
            .id),
    }
}

#[cfg(test)]
mod tests {
    use super::effective_thread_config;
    use crate::domain::agents::adapter::{
        RuntimeMcpServerConfig, RuntimePurpose, RuntimeSpawnConfig,
    };
    use crate::domain::agents::codex::thread_params::{thread_resume_params, thread_start_params};
    use crate::domain::agents::response_style::RICH_MARKDOWN_INSTRUCTION;
    use serde_json::json;
    use std::collections::HashMap;

    #[test]
    fn start_and_resume_apply_provider_aware_summary_config() {
        for resume_session_id in [None, Some("thread-1".to_string())] {
            for (native, summary) in [
                (json!({"model_provider": "openai"}), Some("detailed")),
                (json!({"model_provider": "amazon-bedrock"}), None),
                (json!({"model_provider": "custom"}), None),
                (json!({"model_reasoning_summary": "none"}), Some("none")),
                (
                    json!({"model_reasoning_summary": "concise"}),
                    Some("concise"),
                ),
                (json!({"model_supports_reasoning_summaries": false}), None),
            ] {
                let config = RuntimeSpawnConfig {
                    resume_session_id: resume_session_id.clone(),
                    ..RuntimeSpawnConfig::default()
                };
                let thread_config = effective_thread_config(&config, &json!({"config": native}));
                let params = match resume_session_id.as_deref() {
                    Some(thread_id) => thread_resume_params(thread_id, &config, &thread_config),
                    None => thread_start_params(&config, &thread_config),
                };
                assert_eq!(
                    params["config"].get("model_reasoning_summary"),
                    summary.map(serde_json::Value::from).as_ref()
                );
                assert!(params["config"]
                    .get("model_supports_reasoning_summaries")
                    .is_none());
            }
        }
    }

    #[test]
    fn native_instructions_and_mcp_are_preserved_while_cadencr_servers_override_collisions() {
        let config = RuntimeSpawnConfig {
            mcp_servers: Some(HashMap::from([(
                "shared".into(),
                RuntimeMcpServerConfig::Stdio {
                    command: "cadencr".into(),
                    args: None,
                    env: None,
                },
            )])),
            ..RuntimeSpawnConfig::default()
        };
        let result = effective_thread_config(
            &config,
            &json!({"config": {
                "developer_instructions": "Native instruction",
                "mcp_servers": {"native": {"command": "native"}, "shared": {"command": "old"}}
            }}),
        );
        let instructions = result["developer_instructions"].as_str().unwrap();
        assert!(instructions.starts_with("Native instruction"));
        assert!(instructions.contains(RICH_MARKDOWN_INSTRUCTION));
        assert_eq!(result["mcp_servers"]["native"]["command"], "native");
        assert_eq!(result["mcp_servers"]["shared"]["command"], "cadencr");
    }

    #[test]
    fn auto_name_omits_cadencr_developer_instructions() {
        let config = RuntimeSpawnConfig {
            purpose: Some(RuntimePurpose::AutoName),
            system_prompt: Some("Name this session.".to_string()),
            ..RuntimeSpawnConfig::default()
        };
        let result = effective_thread_config(
            &config,
            &json!({"config": {"developer_instructions": "Native instruction"}}),
        );
        assert!(result.get("developer_instructions").is_none());

        let resumed_non_openai = RuntimeSpawnConfig {
            purpose: Some(RuntimePurpose::AutoName),
            resume_session_id: Some("thread-1".to_string()),
            ..RuntimeSpawnConfig::default()
        };
        let bedrock = effective_thread_config(
            &resumed_non_openai,
            &json!({"config": {"model_provider": "amazon-bedrock"}}),
        );
        assert!(bedrock.is_null());
    }

    #[test]
    fn resume_restores_native_model_effort_and_nonpriority_tier() {
        let config = RuntimeSpawnConfig {
            resume_session_id: Some("thread-1".into()),
            ..RuntimeSpawnConfig::default()
        };
        let result = effective_thread_config(
            &config,
            &json!({"config": {
                "model": "native-model",
                "model_reasoning_effort": "low",
                "service_tier": "flex"
            }}),
        );
        assert_eq!(result["model"], "native-model");
        assert_eq!(result["model_reasoning_effort"], "low");
        assert_eq!(result["service_tier"], "flex");
    }

    #[test]
    fn native_mcp_overrides_omit_null_fields_for_start_and_resume() {
        for resume_session_id in [None, Some("thread-1".to_string())] {
            let config = RuntimeSpawnConfig {
                resume_session_id,
                ..RuntimeSpawnConfig::default()
            };
            let result = effective_thread_config(
                &config,
                &json!({"config": {"mcp_servers": {
                    "chrome-devtools": {
                        "command": "chrome-devtools-mcp",
                        "args": [],
                        "enabled": false,
                        "tool_timeout_sec": null,
                        "startup_timeout_sec": null,
                        "env": {"EMPTY": "", "UNSET": null}
                    },
                    "explicit": {
                        "url": "https://example.test/mcp",
                        "tool_timeout_sec": 12.5,
                        "startup_timeout_sec": 0,
                        "enabled_tools": ["first", "second"],
                        "disabled_tools": []
                    }
                }}}),
            );
            assert_eq!(
                result["mcp_servers"],
                json!({
                    "chrome-devtools": {
                        "command": "chrome-devtools-mcp",
                        "args": [],
                        "enabled": false,
                        "env": {"EMPTY": ""}
                    },
                    "explicit": {
                        "url": "https://example.test/mcp",
                        "tool_timeout_sec": 12.5,
                        "startup_timeout_sec": 0,
                        "enabled_tools": ["first", "second"],
                        "disabled_tools": []
                    }
                })
            );
        }
    }
}
