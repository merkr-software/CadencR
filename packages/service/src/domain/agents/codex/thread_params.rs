use serde_json::{json, Value};

use super::model::{approval_policy, approvals_reviewer, sandbox_mode};
use super::turn_start::collaboration_mode;
use crate::domain::agents::adapter::RuntimeSpawnConfig;

pub(super) fn thread_start_params(config: &RuntimeSpawnConfig, mcp_config: &Value) -> Value {
    let mut params = base_thread_params(config);
    if !mcp_config.is_null() {
        params["config"] = mcp_config.clone();
    }
    params
}

pub(super) fn thread_resume_params(
    thread_id: &str,
    config: &RuntimeSpawnConfig,
    mcp_config: &Value,
) -> Value {
    let mut params = base_thread_params(config);
    params["threadId"] = Value::String(thread_id.to_string());
    // Cadencr already stores the transcript and only consumes the resumed id.
    // Returning every turn can exceed the SDK's bounded JSONL frame size.
    params["excludeTurns"] = json!(true);
    if !mcp_config.is_null() {
        params["config"] = mcp_config.clone();
    }
    params
}

fn base_thread_params(config: &RuntimeSpawnConfig) -> Value {
    let mut params = json!({
        "cwd": config.cwd.to_string_lossy(),
        "approvalPolicy": approval_policy(config.permission_mode.as_ref(), config.access_mode.as_ref()),
        "approvalsReviewer": approvals_reviewer(config.access_mode.as_ref()),
        "experimentalRawEvents": true,
        "persistExtendedHistory": true,
        // `thread/start` takes the shorthand sandbox mode, while per-turn
        // overrides use `sandboxPolicy`.
        "sandbox": sandbox_mode(config.permission_mode.as_ref(), config.access_mode.as_ref()),
    });
    if let Some(model) = config.overrides.model.as_ref() {
        params["model"] = Value::String(model.clone());
    }
    if let Some(fast_mode) = config.overrides.fast_mode {
        params["serviceTier"] = super::fast_service_tier_value(fast_mode);
    }
    if let Some(mode) = collaboration_mode(
        config.permission_mode.as_ref(),
        config.model.as_deref(),
        config.thinking_effort.as_deref(),
    ) {
        params["collaborationMode"] = mode;
    }
    if let Some(system_prompt) = config
        .system_prompt
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        params["baseInstructions"] = Value::String(system_prompt.to_string());
    }
    params
}

#[cfg(test)]
mod tests {
    use super::{thread_resume_params, thread_start_params};
    use crate::domain::agents::adapter::{
        RuntimeConfigOverrides, RuntimeMcpServerConfig, RuntimePermissionMode, RuntimeSpawnConfig,
    };
    use crate::domain::agents::codex::mcp::thread_config;
    use serde_json::{json, Value};
    use std::collections::HashMap;
    use std::path::PathBuf;

    #[test]
    fn thread_start_params_apply_initial_plan_collaboration_mode() {
        let config = RuntimeSpawnConfig {
            cwd: PathBuf::from("/tmp/project"),
            permission_mode: Some(RuntimePermissionMode::Plan),
            model: Some("gpt-5.5".to_string()),
            thinking_effort: Some("high".to_string()),
            overrides: RuntimeConfigOverrides {
                model: Some("gpt-5.5".to_string()),
                thinking_effort: Some("high".to_string()),
                fast_mode: None,
            },
            ..RuntimeSpawnConfig::default()
        };
        let params = thread_start_params(&config, &Value::Null);

        assert_eq!(params["collaborationMode"]["mode"], json!("plan"));
        assert!(params.get("serviceTier").is_none());
        assert_eq!(
            params["collaborationMode"]["settings"]["reasoning_effort"],
            json!("high")
        );
    }

    #[test]
    fn thread_start_params_enable_fast_service_tier() {
        let config = RuntimeSpawnConfig {
            fast_mode: true,
            overrides: RuntimeConfigOverrides {
                fast_mode: Some(true),
                ..RuntimeConfigOverrides::default()
            },
            ..RuntimeSpawnConfig::default()
        };

        let params = thread_start_params(&config, &Value::Null);

        assert_eq!(params["serviceTier"], json!("priority"));
    }

    #[test]
    fn inherited_model_enables_plan_collaboration_without_model_override() {
        let config = RuntimeSpawnConfig {
            permission_mode: Some(RuntimePermissionMode::Plan),
            model: Some("native-model".to_string()),
            thinking_effort: Some("high".to_string()),
            ..RuntimeSpawnConfig::default()
        };
        let params = thread_start_params(&config, &Value::Null);
        assert!(params.get("model").is_none());
        assert_eq!(params["collaborationMode"]["mode"], json!("plan"));
        assert_eq!(
            params["collaborationMode"]["settings"]["model"],
            json!("native-model")
        );
    }

    #[test]
    fn resume_params_keep_thread_overrides_and_mcp_config() {
        let config = RuntimeSpawnConfig {
            cwd: PathBuf::from("/tmp/project"),
            permission_mode: Some(RuntimePermissionMode::AcceptEdits),
            model: Some("gpt-5.5".to_string()),
            system_prompt: Some("Be useful".to_string()),
            overrides: RuntimeConfigOverrides {
                model: Some("gpt-5.5".to_string()),
                ..RuntimeConfigOverrides::default()
            },
            ..RuntimeSpawnConfig::default()
        };
        let params = thread_resume_params(
            "thread-1",
            &config,
            &thread_config(
                Some(&HashMap::from([(
                    "cadencr-browser".to_string(),
                    RuntimeMcpServerConfig::Stdio {
                        command: "svc".to_string(),
                        args: None,
                        env: None,
                    },
                )])),
                Some("Use rich Markdown"),
            ),
        );

        assert_eq!(params["threadId"], json!("thread-1"));
        assert_eq!(params["excludeTurns"], json!(true));
        assert_eq!(params["cwd"], json!("/tmp/project"));
        assert_eq!(params["model"], json!("gpt-5.5"));
        assert_eq!(params["experimentalRawEvents"], json!(true));
        assert_eq!(params["persistExtendedHistory"], json!(true));
        assert_eq!(params["baseInstructions"], json!("Be useful"));
        assert_eq!(
            params["config"]["mcp_servers"]["cadencr-browser"]["command"],
            json!("svc")
        );
        assert!(params.get("approvalPolicy").is_some());
        assert!(params.get("sandbox").is_some());
    }
}
