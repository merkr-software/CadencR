use serde_json::{Map, Value};

use super::event_inputs::mcp_tool_name_from_parts;
use super::legacy_permissions::legacy_permission_details;
use super::permissions::supports_accept_for_session;
use super::server_request_method::CodexServerRequestMethod;

pub(super) struct PermissionDetails {
    pub(super) tool_name: String,
    pub(super) tool_input: Value,
    pub(super) description: Option<String>,
    pub(super) supports_allow_future: bool,
}

pub(super) fn permission_details(
    method: CodexServerRequestMethod,
    params: &Value,
) -> PermissionDetails {
    match method {
        CodexServerRequestMethod::Legacy(legacy) => legacy_permission_details(legacy, params),
        CodexServerRequestMethod::CommandExecutionApproval => command_permission_details(params),
        CodexServerRequestMethod::FileChangeApproval => file_permission_details(params),
        CodexServerRequestMethod::PermissionsApproval => permissions_permission_details(params),
        CodexServerRequestMethod::ToolUserInput => PermissionDetails {
            tool_name: "AskUserQuestion".to_string(),
            tool_input: params.clone(),
            description: Some("Codex question".to_string()),
            supports_allow_future: false,
        },
        CodexServerRequestMethod::McpElicitation => elicitation_permission_details(params),
    }
}

fn command_permission_details(params: &Value) -> PermissionDetails {
    let is_network_request = params
        .get("networkApprovalContext")
        .is_some_and(|value| !value.is_null());
    PermissionDetails {
        tool_name: if is_network_request {
            "NetworkAccess".to_string()
        } else {
            "Bash".to_string()
        },
        tool_input: command_permission_input(params),
        description: description(
            params,
            if is_network_request {
                "Approve network access"
            } else {
                "Approve command execution"
            },
        ),
        supports_allow_future: supports_accept_for_session(params),
    }
}

fn file_permission_details(params: &Value) -> PermissionDetails {
    PermissionDetails {
        tool_name: "ApplyPatch".to_string(),
        tool_input: serde_json::json!({
            "patch_text": params.get("patch").cloned().unwrap_or(Value::Null),
            "patch": params.get("patch").cloned().unwrap_or(Value::Null),
            "changes": params.get("changes").cloned().unwrap_or(Value::Null),
            "grantRoot": params.get("grantRoot").cloned().unwrap_or(Value::Null),
            "reason": params.get("reason").cloned().unwrap_or(Value::Null),
        }),
        description: description(params, "Approve file change"),
        supports_allow_future: supports_accept_for_session(params),
    }
}

fn permissions_permission_details(params: &Value) -> PermissionDetails {
    PermissionDetails {
        tool_name: "RequestPermissions".to_string(),
        tool_input: serde_json::json!({
            "cwd": params.get("cwd").cloned().unwrap_or(Value::Null),
            "reason": params.get("reason").cloned().unwrap_or(Value::Null),
            "permissions": params.get("permissions").cloned().unwrap_or(Value::Null),
        }),
        description: description(params, "Approve requested permissions"),
        supports_allow_future: supports_accept_for_session(params),
    }
}

fn elicitation_permission_details(params: &Value) -> PermissionDetails {
    let meta = params.get("_meta").cloned().unwrap_or(Value::Null);
    let server = params
        .get("serverName")
        .and_then(Value::as_str)
        .unwrap_or("unknown");
    PermissionDetails {
        tool_name: mcp_tool_name_from_parts(
            server,
            meta.get("tool_name").and_then(Value::as_str),
            "elicitation",
        ),
        tool_input: meta
            .get("tool_input")
            .cloned()
            .unwrap_or_else(|| params.clone()),
        description: params
            .get("message")
            .and_then(Value::as_str)
            .map(ToOwned::to_owned),
        supports_allow_future: false,
    }
}

fn command_permission_input(params: &Value) -> Value {
    let mut input = Map::new();
    insert_param_or_null(&mut input, params, "approvalId");
    insert_param_or_null(&mut input, params, "command");
    insert_param_or_null(&mut input, params, "cwd");
    insert_param_or_null(&mut input, params, "reason");
    insert_param_or_null(&mut input, params, "commandActions");
    insert_optional_param(&mut input, params, "additionalPermissions");
    insert_optional_param(&mut input, params, "networkApprovalContext");
    insert_optional_param(&mut input, params, "proposedExecpolicyAmendment");
    insert_optional_param(&mut input, params, "proposedNetworkPolicyAmendments");
    Value::Object(input)
}

pub(super) fn insert_param_or_null(input: &mut Map<String, Value>, params: &Value, key: &str) {
    input.insert(
        key.to_string(),
        params.get(key).cloned().unwrap_or(Value::Null),
    );
}

fn insert_optional_param(input: &mut Map<String, Value>, params: &Value, key: &str) {
    let Some(value) = params.get(key).filter(|value| !value.is_null()) else {
        return;
    };
    input.insert(key.to_string(), value.clone());
}

pub(super) fn description(params: &Value, fallback: &str) -> Option<String> {
    Some(
        params
            .get("reason")
            .and_then(Value::as_str)
            .unwrap_or(fallback)
            .to_string(),
    )
}
