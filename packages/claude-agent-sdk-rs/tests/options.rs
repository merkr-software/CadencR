use std::collections::HashMap;

use claude_agent_sdk_rs::{
    mcp::McpServerConfig,
    options::{Options, OptionsBuilder},
    permissions::{AllowAllTools, CanUseTool, PermissionMode, PermissionRequest, PermissionResult},
};

// ---------------------------------------------------------------------------
// PermissionMode serialization
// ---------------------------------------------------------------------------

#[test]
fn permission_mode_serializes_to_camel_case() {
    assert_eq!(
        serde_json::to_string(&PermissionMode::Plan).unwrap(),
        r#""plan""#
    );
    assert_eq!(
        serde_json::to_string(&PermissionMode::AcceptEdits).unwrap(),
        r#""acceptEdits""#
    );
    assert_eq!(
        serde_json::to_string(&PermissionMode::BypassPermissions).unwrap(),
        r#""bypassPermissions""#
    );
    assert_eq!(
        serde_json::to_string(&PermissionMode::Default).unwrap(),
        r#""default""#
    );
    assert_eq!(
        serde_json::to_string(&PermissionMode::DontAsk).unwrap(),
        r#""dontAsk""#
    );
    assert_eq!(
        serde_json::to_string(&PermissionMode::Auto).unwrap(),
        r#""auto""#
    );
}

#[test]
fn permission_mode_as_cli_flag() {
    assert_eq!(PermissionMode::Default.as_cli_flag(), "default");
    assert_eq!(PermissionMode::AcceptEdits.as_cli_flag(), "acceptEdits");
    assert_eq!(
        PermissionMode::BypassPermissions.as_cli_flag(),
        "bypassPermissions"
    );
    assert_eq!(PermissionMode::Plan.as_cli_flag(), "plan");
    assert_eq!(PermissionMode::DontAsk.as_cli_flag(), "dontAsk");
    assert_eq!(PermissionMode::Auto.as_cli_flag(), "auto");
}

// ---------------------------------------------------------------------------
// PermissionResult serialization
// ---------------------------------------------------------------------------

#[test]
fn permission_result_allow_serializes_with_behavior_tag() {
    let result = PermissionResult::Allow {
        updated_input: serde_json::json!({"command": "ls"}),
        updated_permissions: None,
        tool_use_id: None,
    };
    let json: serde_json::Value = serde_json::to_value(&result).unwrap();
    assert_eq!(json["behavior"], "allow");
    assert_eq!(json["updatedInput"], serde_json::json!({"command": "ls"}));
}

#[test]
fn permission_result_deny_serializes_with_message_and_interrupt() {
    let result = PermissionResult::Deny {
        message: "not allowed".to_string(),
        interrupt: Some(true),
        tool_use_id: Some("tid-1".to_string()),
    };
    let json: serde_json::Value = serde_json::to_value(&result).unwrap();
    assert_eq!(json["behavior"], "deny");
    assert_eq!(json["message"], "not allowed");
    assert_eq!(json["interrupt"], true);
    assert_eq!(json["toolUseId"], "tid-1");
}

#[test]
fn permission_result_allow_always_includes_updated_input() {
    let input = serde_json::json!({"file_path": "/tmp/test.txt", "content": "hello"});
    let result = PermissionResult::Allow {
        updated_input: input.clone(),
        updated_permissions: None,
        tool_use_id: None,
    };
    let json: serde_json::Value = serde_json::to_value(&result).unwrap();
    // updatedInput must always be present with original tool input (CLI Zod schema requires a record)
    assert_eq!(json["updatedInput"], input);
    assert!(json.get("updatedPermissions").is_none());
    assert!(json.get("toolUseId").is_none());
}

#[test]
fn permission_result_allow_serializes_camel_case_fields() {
    let result = PermissionResult::Allow {
        updated_input: serde_json::json!({"answer": "yes"}),
        updated_permissions: None,
        tool_use_id: Some("tu-99".to_string()),
    };
    let json: serde_json::Value = serde_json::to_value(&result).unwrap();
    // Fields must be camelCase for the CLI to recognize them
    assert_eq!(json["updatedInput"]["answer"], "yes");
    assert_eq!(json["toolUseId"], "tu-99");
    // snake_case variants must NOT be present
    assert!(json.get("updated_input").is_none());
    assert!(json.get("tool_use_id").is_none());
}

#[test]
fn permission_result_allow_roundtrips_through_deserialize() {
    let original = serde_json::json!({
        "behavior": "allow",
        "updatedInput": {"answers": {"0": "yes"}},
        "toolUseId": "t1"
    });
    let result: PermissionResult = serde_json::from_value(original.clone()).unwrap();
    let reserialized = serde_json::to_value(&result).unwrap();
    assert_eq!(reserialized, original);
}

// ---------------------------------------------------------------------------
// Options defaults
// ---------------------------------------------------------------------------

#[test]
fn options_default_include_partial_messages_is_true() {
    let opts = Options::default();
    assert!(opts.include_partial_messages);
}

#[test]
fn options_default_setting_sources_has_three_entries() {
    let opts = Options::default();
    assert_eq!(opts.setting_sources.len(), 3);
    assert!(opts.setting_sources.contains(&"user".to_string()));
    assert!(opts.setting_sources.contains(&"project".to_string()));
    assert!(opts.setting_sources.contains(&"local".to_string()));
}

// ---------------------------------------------------------------------------
// Options::to_cli_args
// ---------------------------------------------------------------------------

#[test]
fn to_cli_args_always_includes_output_format() {
    let opts = Options::default();
    let args = opts.to_cli_args();
    let pos = args
        .windows(2)
        .position(|w| w[0] == "--output-format" && w[1] == "stream-json");
    assert!(
        pos.is_some(),
        "Expected --output-format stream-json in args"
    );
}

#[test]
fn to_cli_args_always_includes_replay_user_messages() {
    let opts = Options::default();
    let args = opts.to_cli_args();
    assert!(
        args.iter().any(|a| a == "--replay-user-messages"),
        "Expected --replay-user-messages in args"
    );
}

#[test]
fn to_cli_args_always_forces_summarized_thinking_display() {
    // Opus 4.7 disables thinking display by default; Cadencr surfaces thinking
    // summaries in the UI, so `--thinking-display summarized` must always be
    // passed regardless of model or other options.
    let opts = Options::default();
    let args = opts.to_cli_args();
    let pos = args
        .windows(2)
        .position(|w| w[0] == "--thinking-display" && w[1] == "summarized");
    assert!(
        pos.is_some(),
        "Expected --thinking-display summarized in args"
    );
}

#[test]
fn to_cli_args_includes_model_when_set() {
    let opts = OptionsBuilder::new().model("claude-opus-4-5").build();
    let args = opts.to_cli_args();
    let pos = args
        .windows(2)
        .position(|w| w[0] == "--model" && w[1] == "claude-opus-4-5");
    assert!(pos.is_some());
}

#[test]
fn to_cli_args_includes_resume_when_set() {
    let opts = OptionsBuilder::new().resume("sess-abc-123").build();
    let args = opts.to_cli_args();
    let pos = args
        .windows(2)
        .position(|w| w[0] == "--resume" && w[1] == "sess-abc-123");
    assert!(pos.is_some());
}

#[test]
fn to_cli_args_includes_permission_mode_when_set() {
    let opts = OptionsBuilder::new()
        .permission_mode(PermissionMode::Plan)
        .build();
    let args = opts.to_cli_args();
    let pos = args
        .windows(2)
        .position(|w| w[0] == "--permission-mode" && w[1] == "plan");
    assert!(pos.is_some());
}

#[test]
fn to_cli_args_omits_permission_mode_when_unset() {
    let opts = Options::default();
    let args = opts.to_cli_args();
    assert!(!args.iter().any(|a| a == "--permission-mode"));
}

#[test]
fn to_cli_args_includes_permission_prompt_tool_when_can_use_tool_set() {
    let opts = Options {
        can_use_tool: Some(std::sync::Arc::new(AllowAllTools)),
        ..Options::default()
    };
    let args = opts.to_cli_args();
    let pos = args
        .windows(2)
        .position(|w| w[0] == "--permission-prompt-tool" && w[1] == "stdio");
    assert!(
        pos.is_some(),
        "Expected --permission-prompt-tool stdio in args"
    );
}

#[test]
fn to_cli_args_omits_permission_prompt_tool_when_no_can_use_tool() {
    let opts = Options::default();
    let args = opts.to_cli_args();
    assert!(!args.iter().any(|a| a == "--permission-prompt-tool"));
}

// ---------------------------------------------------------------------------
// McpServerConfig serde round-trip
// ---------------------------------------------------------------------------

#[test]
fn mcp_stdio_roundtrip() {
    let cfg = McpServerConfig::Stdio {
        command: "node".to_string(),
        args: Some(vec!["server.js".to_string()]),
        env: None,
    };
    let json = serde_json::to_string(&cfg).unwrap();
    let back: McpServerConfig = serde_json::from_str(&json).unwrap();
    assert_eq!(cfg, back);
}

#[test]
fn mcp_sse_roundtrip() {
    let mut headers = HashMap::new();
    headers.insert("Authorization".to_string(), "Bearer tok".to_string());
    let cfg = McpServerConfig::Sse {
        url: "https://example.com/sse".to_string(),
        headers: Some(headers),
    };
    let json = serde_json::to_string(&cfg).unwrap();
    let back: McpServerConfig = serde_json::from_str(&json).unwrap();
    assert_eq!(cfg, back);
}

#[test]
fn mcp_http_roundtrip() {
    let cfg = McpServerConfig::Http {
        url: "https://example.com/mcp".to_string(),
        headers: None,
    };
    let json = serde_json::to_string(&cfg).unwrap();
    let back: McpServerConfig = serde_json::from_str(&json).unwrap();
    assert_eq!(cfg, back);
}

#[test]
fn mcp_stdio_type_tag_in_json() {
    let cfg = McpServerConfig::Stdio {
        command: "python".to_string(),
        args: None,
        env: None,
    };
    let json: serde_json::Value = serde_json::to_value(&cfg).unwrap();
    assert_eq!(json["type"], "stdio");
}

// ---------------------------------------------------------------------------
// MCP config --mcp-config wrapping
// ---------------------------------------------------------------------------

#[test]
fn to_cli_args_wraps_mcp_servers_in_mcp_servers_key() {
    let mut servers = HashMap::new();
    servers.insert(
        "cadencr-plan".to_string(),
        McpServerConfig::Stdio {
            command: "/usr/bin/cadencr-service".to_string(),
            args: Some(vec![
                "mcp-serve".to_string(),
                "--agent-type".to_string(),
                "plan".to_string(),
            ]),
            env: None,
        },
    );
    let opts = OptionsBuilder::new().mcp_servers(servers).build();
    let args = opts.to_cli_args();

    let pos = args
        .iter()
        .position(|a| a == "--mcp-config")
        .expect("--mcp-config should be present");
    let config_json = &args[pos + 1];
    let parsed: serde_json::Value =
        serde_json::from_str(config_json).expect("should be valid JSON");

    // Must be wrapped in { "mcpServers": { ... } }
    assert!(
        parsed.get("mcpServers").is_some(),
        "config must have mcpServers wrapper key"
    );
    let inner = &parsed["mcpServers"]["cadencr-plan"];
    assert_eq!(inner["type"], "stdio");
    assert_eq!(inner["command"], "/usr/bin/cadencr-service");
}

#[test]
fn to_cli_args_omits_mcp_config_when_no_servers() {
    let opts = Options::default();
    let args = opts.to_cli_args();
    assert!(!args.iter().any(|a| a == "--mcp-config"));
}

// ---------------------------------------------------------------------------
// AllowAllTools
// ---------------------------------------------------------------------------

#[tokio::test]
async fn allow_all_tools_returns_allow_for_any_input() {
    let handler = AllowAllTools;
    let req = PermissionRequest {
        tool_name: "Bash".to_string(),
        input: serde_json::json!({"command": "ls"}),
        tool_use_id: "tu-1".to_string(),
        agent_id: None,
        suggestions: None,
        blocked_path: None,
        decision_reason: None,
    };
    let result = handler.can_use_tool(req).await;
    assert!(matches!(result, PermissionResult::Allow { .. }));
}
