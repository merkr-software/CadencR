use serde_json::Value;

use super::event_payloads::{
    parse_serialized_permission_request, SerializedPermissionOption, SerializedPermissionRequest,
};
use super::permission_details::permission_details;
pub(super) use super::permission_options::{
    codex_decision_from_option_id, codex_elicitation_response_from_option_id,
    permission_option_values, STRICT_AUTO_REVIEW_OPTION_ID,
};
use super::permission_options::{fallback_permission_options, permission_options};
use super::server_request_method::CodexServerRequestMethod;
use crate::domain::agents::adapter::{
    RuntimePermissionDecision, RuntimePermissionOption, RuntimePermissionRequest,
};
use crate::domain::permission_bridge::extract_permission_preview;

pub(super) const DECISION_ACCEPT_FOR_SESSION: &str = "acceptForSession";
pub(super) const DECISION_CANCEL: &str = "cancel";
pub(super) const DECISION_DECLINE: &str = "decline";

#[derive(Debug, Clone)]
pub(super) struct PendingCodexRequest {
    pub id: Value,
    /// Only allow-listed requests are ever parked waiting for the user.
    pub method: CodexServerRequestMethod,
    pub params: Value,
}

pub(super) fn request_id_from_value(id: &Value) -> String {
    match id {
        Value::String(value) => value.clone(),
        Value::Number(value) => value.to_string(),
        other => other.to_string(),
    }
}

pub(super) fn permission_request(
    id: &Value,
    method: CodexServerRequestMethod,
    params: &Value,
) -> RuntimePermissionRequest {
    let request_id = request_id_from_value(id);
    let details = permission_details(method, params);

    let preview = extract_permission_preview(&details.tool_input);
    RuntimePermissionRequest {
        request_id,
        tool_use_id: item_id(params),
        tool_name: details.tool_name,
        tool_input: details.tool_input,
        description: details.description,
        pattern: None,
        preview,
        options: permission_options(method, params, details.supports_allow_future),
    }
}

fn item_id(params: &Value) -> Option<String> {
    params
        .get("itemId")
        .and_then(Value::as_str)
        .or_else(|| params.get("item_id").and_then(Value::as_str))
        .or_else(|| params.get("callId").and_then(Value::as_str))
        .map(ToOwned::to_owned)
}

pub(super) fn parse_permission_request(raw: &Value) -> Option<RuntimePermissionRequest> {
    let request = match parse_serialized_permission_request(raw.clone()) {
        Ok(Some(request)) => request,
        Ok(None) => return None,
        Err(error) => {
            tracing::warn!(%error, "malformed serialized Codex permission request");
            return None;
        }
    };
    let options = permission_options_from_raw_or_fallback(&request);
    Some(RuntimePermissionRequest {
        request_id: request.request_id,
        tool_use_id: request.tool_use_id,
        tool_name: request.tool_name.clone(),
        tool_input: request.tool_input,
        description: request.description,
        pattern: None,
        preview: request.preview,
        options,
    })
}

fn permission_options_from_raw_or_fallback(
    request: &SerializedPermissionRequest,
) -> Vec<RuntimePermissionOption> {
    parsed_permission_options(request)
        .filter(|options| !options.is_empty())
        .unwrap_or_else(|| {
            let supports_allow_future = request
                .supports_allow_future
                .unwrap_or_else(|| supports_allow_future_for_tool(&request.tool_name));
            fallback_permission_options(supports_allow_future)
        })
}

fn parsed_permission_options(
    request: &SerializedPermissionRequest,
) -> Option<Vec<RuntimePermissionOption>> {
    Some(
        request
            .options
            .as_ref()?
            .iter()
            .filter_map(parsed_permission_option)
            .collect(),
    )
}

fn parsed_permission_option(value: &SerializedPermissionOption) -> Option<RuntimePermissionOption> {
    let decision = match value.decision.as_str() {
        "allow_once" => RuntimePermissionDecision::AllowOnce,
        "allow_future" => RuntimePermissionDecision::AllowFuture,
        "deny" => RuntimePermissionDecision::Deny,
        _ => return None,
    };
    Some(RuntimePermissionOption {
        decision,
        option_id: value.option_id.clone(),
        label: value.label.clone()?,
        description: value.description.clone()?,
        collect_feedback: value.collect_feedback,
    })
}

fn supports_allow_future_for_tool(tool_name: &str) -> bool {
    matches!(
        tool_name,
        "Bash" | "NetworkAccess" | "ApplyPatch" | "apply_patch" | "RequestPermissions"
    )
}

pub(super) fn supports_accept_for_session(params: &Value) -> bool {
    if !params.get("availableDecisions").is_some() {
        return true;
    }
    has_available_decision(params, DECISION_ACCEPT_FOR_SESSION)
}

pub(super) fn has_available_decision(params: &Value, expected: &str) -> bool {
    available_decisions(params).any(|decision| decision == expected)
}

pub(super) fn available_decisions(params: &Value) -> impl Iterator<Item = &str> {
    params
        .get("availableDecisions")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
}

#[cfg(test)]
mod tests {
    use super::permission_request;
    use crate::domain::agents::adapter::{RuntimePermissionDecision, RuntimePermissionRequest};
    use crate::domain::agents::codex::server_request_method::method;
    use serde_json::json;

    fn has_allow_future(request: &RuntimePermissionRequest) -> bool {
        request
            .options
            .iter()
            .any(|option| option.decision == RuntimePermissionDecision::AllowFuture)
    }

    #[test]
    fn file_change_permission_uses_canonical_apply_patch_tool_name() {
        let request = permission_request(
            &json!("approval-1"),
            method("item/fileChange/requestApproval"),
            &json!({
                "threadId": "thread",
                "itemId": "patch",
                "patch": "*** Begin Patch\n*** Update File: a.txt\n@@\n-x\n+y\n*** End Patch"
            }),
        );

        assert_eq!(request.tool_name, "ApplyPatch");
        assert_eq!(
            request.tool_input["patch_text"],
            "*** Begin Patch\n*** Update File: a.txt\n@@\n-x\n+y\n*** End Patch"
        );
        assert!(has_allow_future(&request));
    }

    #[test]
    fn command_permission_preserves_network_context() {
        let request = permission_request(
            &json!("approval-2"),
            method("item/commandExecution/requestApproval"),
            &json!({
                "threadId": "thread",
                "turnId": "turn",
                "itemId": "cmd",
                "command": null,
                "reason": "Allow access to api.example.com",
                "networkApprovalContext": { "host": "api.example.com" },
                "proposedNetworkPolicyAmendments": [
                    { "action": "allow", "host": "api.example.com" }
                ]
            }),
        );

        assert_eq!(request.tool_name, "NetworkAccess");
        assert_eq!(
            request.tool_input["networkApprovalContext"],
            json!({ "host": "api.example.com" })
        );
        assert_eq!(
            request.tool_input["proposedNetworkPolicyAmendments"],
            json!([{ "action": "allow", "host": "api.example.com" }])
        );
    }

    #[test]
    fn command_permission_respects_available_decisions() {
        let request = permission_request(
            &json!("approval-3"),
            method("item/commandExecution/requestApproval"),
            &json!({
                "threadId": "thread",
                "turnId": "turn",
                "itemId": "cmd",
                "command": "git status",
                "availableDecisions": ["accept", "decline"]
            }),
        );

        assert!(!has_allow_future(&request));
    }

    #[test]
    fn command_permission_without_available_decisions_keeps_allow_future_fallback() {
        let request = permission_request(
            &json!("approval-no-decisions"),
            method("item/commandExecution/requestApproval"),
            &json!({
                "threadId": "thread",
                "turnId": "turn",
                "itemId": "cmd",
                "command": "git status"
            }),
        );

        assert!(has_allow_future(&request));
        let labels = request
            .options
            .iter()
            .map(|option| option.label.as_str())
            .collect::<Vec<_>>();
        assert_eq!(
            labels,
            vec![
                "Approve",
                "Approve for session",
                "Deny and continue",
                "Deny with feedback"
            ]
        );
    }

    #[test]
    fn reparsed_permission_preserves_native_option_ids() {
        let request = super::parse_permission_request(&json!({
            "type": "codex_permission_request",
            "request_id": "approval-native",
            "tool_name": "Bash",
            "tool_input": { "command": "git status" },
            "options": [{
                "decision": "allow_once",
                "option_id": "codex:\"accept\"",
                "label": "Approve",
                "description": "Approve this request",
                "collect_feedback": false
            }]
        }))
        .expect("permission request should parse");

        assert_eq!(request.options.len(), 1);
        assert_eq!(
            request.options[0].option_id.as_deref(),
            Some("codex:\"accept\"")
        );
    }

    #[test]
    fn reparsed_permission_preserves_missing_allow_future_support() {
        let request = super::parse_permission_request(&json!({
            "type": "codex_permission_request",
            "request_id": "approval-4",
            "tool_name": "Bash",
            "tool_input": { "command": "git status" },
            "supports_allow_future": false
        }))
        .expect("permission request should parse");

        assert!(!has_allow_future(&request));
    }

    #[test]
    fn elicitation_tool_name_is_always_mcp_prefixed() {
        let forged = permission_request(
            &json!("approval-5"),
            method("mcpServer/elicitation/request"),
            &json!({
                "serverName": "remote",
                "_meta": {
                    "tool_name": "Bash",
                    "tool_input": { "command": "rm -rf ." }
                }
            }),
        );
        assert_eq!(forged.tool_name, "mcp__remote__Bash");

        let canonical = permission_request(
            &json!("approval-6"),
            method("mcpServer/elicitation/request"),
            &json!({
                "serverName": "cadencr-browser",
                "_meta": {
                    "tool_name": "mcp__cadencr-browser__browser_open_url"
                }
            }),
        );
        assert_eq!(
            canonical.tool_name,
            "mcp__cadencr-browser__browser_open_url"
        );
    }

    #[test]
    fn elicitation_options_include_native_cancel_and_provider_persist_hints() {
        let request = permission_request(
            &json!("approval-7"),
            method("mcpServer/elicitation/request"),
            &json!({
                "serverName": "remote",
                "_meta": {
                    "persist": ["session", "always"]
                }
            }),
        );

        assert!(request
            .options
            .iter()
            .any(|option| option.label == "Approve for session"));
        assert!(request
            .options
            .iter()
            .any(|option| option.label == "Always approve"));
        assert!(request
            .options
            .iter()
            .any(|option| option.label == "Cancel"));

        let session_option = request
            .options
            .iter()
            .find(|option| option.label == "Approve for session")
            .expect("session persist option");
        assert_eq!(
            super::codex_elicitation_response_from_option_id(session_option.option_id.as_deref()),
            Some(json!({
                "action": "accept",
                "content": { "approved": true },
                "_meta": { "persist": "session" }
            }))
        );
    }
}
