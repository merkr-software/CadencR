use serde_json::{json, Value};

use super::instructions::codex_system_prompt;
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
    if let Some(model) = config.model.as_ref() {
        params["model"] = Value::String(model.clone());
    }
    if let Some(mode) = collaboration_mode(
        config.permission_mode.as_ref(),
        config.model.as_deref(),
        config.thinking_effort.as_deref(),
    ) {
        params["collaborationMode"] = mode;
    }
    params["baseInstructions"] =
        Value::String(codex_system_prompt(config.system_prompt.as_deref()));
    params
}

#[cfg(test)]
mod tests {
    use super::{thread_resume_params, thread_start_params};
    use crate::domain::agents::adapter::{
        RuntimeMcpServerConfig, RuntimePermissionMode, RuntimeSpawnConfig,
    };
    use crate::domain::agents::codex::mcp::thread_config;
    use crate::domain::agents::response_style::RICH_MARKDOWN_INSTRUCTION;
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
            ..RuntimeSpawnConfig::default()
        };
        let params = thread_start_params(&config, &Value::Null);

        assert_eq!(params["collaborationMode"]["mode"], json!("plan"));
        assert_eq!(
            params["collaborationMode"]["settings"]["reasoning_effort"],
            json!("high")
        );
    }

    #[test]
    fn resume_params_keep_thread_overrides_and_mcp_config() {
        let config = RuntimeSpawnConfig {
            cwd: PathBuf::from("/tmp/project"),
            permission_mode: Some(RuntimePermissionMode::AcceptEdits),
            model: Some("gpt-5.5".to_string()),
            system_prompt: Some("Be useful".to_string()),
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
                Some(RICH_MARKDOWN_INSTRUCTION),
            ),
        );

        assert_eq!(params["threadId"], json!("thread-1"));
        assert_eq!(params["cwd"], json!("/tmp/project"));
        assert_eq!(params["model"], json!("gpt-5.5"));
        assert_eq!(params["experimentalRawEvents"], json!(true));
        assert_eq!(params["persistExtendedHistory"], json!(true));
        let base_instructions = params["baseInstructions"]
            .as_str()
            .expect("base instructions");
        assert!(base_instructions.starts_with(RICH_MARKDOWN_INSTRUCTION));
        assert!(base_instructions.contains("Be useful"));
        assert!(base_instructions.contains("mcp__cadencr_browser____browser_open_url"));
        assert_eq!(
            params["config"]["mcp_servers"]["cadencr-browser"]["command"],
            json!("svc")
        );
        assert!(params.get("approvalPolicy").is_some());
        assert!(params.get("sandbox").is_some());
    }
}
