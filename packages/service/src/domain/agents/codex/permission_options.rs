use serde_json::Value;

use super::command_decisions::synthesized_command_decisions;
use super::legacy_permissions::legacy_permission_options;
use super::permissions::{DECISION_ACCEPT_FOR_SESSION, DECISION_CANCEL, DECISION_DECLINE};
use super::server_request_method::CodexServerRequestMethod;
use crate::domain::agents::adapter::{RuntimePermissionDecision, RuntimePermissionOption};

const CODEX_OPTION_PREFIX: &str = "codex:";
const CODEX_ELICITATION_OPTION_PREFIX: &str = "codex_elicitation:";
pub(super) const STRICT_AUTO_REVIEW_OPTION_ID: &str = "codex_permissions_strict_auto_review";

pub(super) fn permission_options(
    method: CodexServerRequestMethod,
    params: &Value,
    supports_allow_future: bool,
) -> Vec<RuntimePermissionOption> {
    match method {
        CodexServerRequestMethod::Legacy(_) => legacy_permission_options(),
        CodexServerRequestMethod::CommandExecutionApproval => {
            command_permission_options(params, supports_allow_future)
        }
        CodexServerRequestMethod::FileChangeApproval => file_permission_options(),
        CodexServerRequestMethod::PermissionsApproval => permissions_request_options(),
        CodexServerRequestMethod::McpElicitation => elicitation_permission_options(params),
        // Answered through the question UI; the options only gate submit/deny.
        CodexServerRequestMethod::ToolUserInput => {
            fallback_permission_options(supports_allow_future)
        }
    }
}

pub(super) fn fallback_permission_options(
    supports_allow_future: bool,
) -> Vec<RuntimePermissionOption> {
    let mut options = vec![RuntimePermissionOption {
        decision: RuntimePermissionDecision::AllowOnce,
        option_id: None,
        label: "Allow once".to_string(),
        description: "Approve this Codex request".to_string(),
        collect_feedback: false,
    }];
    if supports_allow_future {
        options.push(RuntimePermissionOption {
            decision: RuntimePermissionDecision::AllowFuture,
            option_id: None,
            label: "Allow for session".to_string(),
            description: "Approve matching requests for this Codex session".to_string(),
            collect_feedback: false,
        });
    }
    options.push(RuntimePermissionOption {
        decision: RuntimePermissionDecision::Deny,
        option_id: None,
        label: "Deny".to_string(),
        description: "Reject this Codex request".to_string(),
        collect_feedback: true,
    });
    options
}

pub(super) fn command_permission_options(
    params: &Value,
    supports_allow_future: bool,
) -> Vec<RuntimePermissionOption> {
    let decisions = available_decision_values(params)
        .unwrap_or_else(|| synthesized_command_decisions(params, supports_allow_future));
    decisions
        .into_iter()
        .filter_map(|decision| command_decision_option(decision, params))
        .collect()
}

fn command_decision_option(decision: Value, params: &Value) -> Option<RuntimePermissionOption> {
    let key = decision_key(&decision)?;
    let is_network = params
        .get("networkApprovalContext")
        .is_some_and(|value| !value.is_null());
    let has_extra_permissions = params
        .get("additionalPermissions")
        .is_some_and(|value| !value.is_null());
    match key {
        "accept" => Some(native_option(
            RuntimePermissionDecision::AllowOnce,
            decision,
            if is_network { "Allow once" } else { "Approve" },
            "Approve this request only",
            false,
        )),
        DECISION_ACCEPT_FOR_SESSION => Some(native_option(
            RuntimePermissionDecision::AllowFuture,
            decision,
            if is_network {
                "Allow host for session"
            } else if has_extra_permissions {
                "Allow permissions for session"
            } else {
                "Approve for session"
            },
            "Approve matching requests for this Codex session",
            false,
        )),
        "acceptWithExecpolicyAmendment" => Some(native_option(
            RuntimePermissionDecision::AllowFuture,
            decision,
            "Approve similar commands",
            "Approve this command and future commands matching Codex's proposed rule",
            false,
        )),
        "applyNetworkPolicyAmendment" => Some(native_option(
            network_policy_decision(&decision),
            decision.clone(),
            network_policy_label(&decision),
            "Apply Codex's proposed network policy rule",
            false,
        )),
        DECISION_DECLINE => Some(native_option(
            RuntimePermissionDecision::Deny,
            decision,
            "Deny and continue",
            "Reject this request and let Codex continue",
            true,
        )),
        DECISION_CANCEL => Some(native_option(
            RuntimePermissionDecision::Deny,
            decision,
            "Deny with feedback",
            "Reject this request and tell Codex what to do differently",
            true,
        )),
        _ => None,
    }
}

fn file_permission_options() -> Vec<RuntimePermissionOption> {
    vec![
        native_option(
            RuntimePermissionDecision::AllowOnce,
            Value::String("accept".to_string()),
            "Approve",
            "Apply these file changes",
            false,
        ),
        native_option(
            RuntimePermissionDecision::AllowFuture,
            Value::String(DECISION_ACCEPT_FOR_SESSION.to_string()),
            "Approve for session",
            "Approve future changes to the same files this session",
            false,
        ),
        native_option(
            RuntimePermissionDecision::Deny,
            Value::String(DECISION_CANCEL.to_string()),
            "Deny with feedback",
            "Reject these file changes and tell Codex what to do differently",
            true,
        ),
    ]
}

fn permissions_request_options() -> Vec<RuntimePermissionOption> {
    vec![
        RuntimePermissionOption {
            decision: RuntimePermissionDecision::AllowOnce,
            option_id: None,
            label: "Grant for turn".to_string(),
            description: "Grant these permissions for the current turn".to_string(),
            collect_feedback: false,
        },
        RuntimePermissionOption {
            decision: RuntimePermissionDecision::AllowOnce,
            option_id: Some(STRICT_AUTO_REVIEW_OPTION_ID.to_string()),
            label: "Grant with strict review".to_string(),
            description: "Grant for this turn and review subsequent commands strictly".to_string(),
            collect_feedback: false,
        },
        RuntimePermissionOption {
            decision: RuntimePermissionDecision::AllowFuture,
            option_id: None,
            label: "Grant for session".to_string(),
            description: "Grant these permissions for this Codex session".to_string(),
            collect_feedback: false,
        },
        RuntimePermissionOption {
            decision: RuntimePermissionDecision::Deny,
            option_id: None,
            label: "Deny".to_string(),
            description: "Continue without granting these permissions".to_string(),
            collect_feedback: false,
        },
    ]
}

fn elicitation_permission_options(params: &Value) -> Vec<RuntimePermissionOption> {
    let mut options = vec![elicitation_option(
        RuntimePermissionDecision::AllowOnce,
        "accept",
        serde_json::json!({ "approved": true }),
        Value::Null,
        "Approve",
        "Accept this MCP elicitation",
        false,
    )];

    for persist in elicitation_persist_values(params) {
        let (label, description) = match persist {
            "always" => (
                "Always approve",
                "Accept and let Codex persist this MCP approval",
            ),
            "session" => (
                "Approve for session",
                "Accept matching MCP approvals for this Codex session",
            ),
            _ => continue,
        };
        options.push(elicitation_option(
            RuntimePermissionDecision::AllowFuture,
            "accept",
            serde_json::json!({ "approved": true }),
            serde_json::json!({ "persist": persist }),
            label,
            description,
            false,
        ));
    }

    options.push(elicitation_option(
        RuntimePermissionDecision::Deny,
        DECISION_DECLINE,
        Value::Null,
        Value::Null,
        "Deny and continue",
        "Decline this MCP elicitation",
        false,
    ));
    options.push(elicitation_option(
        RuntimePermissionDecision::Deny,
        DECISION_CANCEL,
        Value::Null,
        Value::Null,
        "Cancel",
        "Cancel this MCP elicitation",
        true,
    ));
    options
}

fn elicitation_option(
    decision: RuntimePermissionDecision,
    action: &str,
    content: Value,
    meta: Value,
    label: &str,
    description: &str,
    collect_feedback: bool,
) -> RuntimePermissionOption {
    RuntimePermissionOption {
        decision,
        option_id: Some(format!(
            "{CODEX_ELICITATION_OPTION_PREFIX}{}",
            serde_json::json!({
                "action": action,
                "content": content,
                "_meta": meta,
            })
        )),
        label: label.to_string(),
        description: description.to_string(),
        collect_feedback,
    }
}

fn elicitation_persist_values(params: &Value) -> Vec<&'static str> {
    let persist = params
        .get("_meta")
        .or_else(|| params.get("meta"))
        .and_then(|meta| meta.get("persist"));
    match persist {
        Some(Value::String(value)) => persist_value(value).into_iter().collect(),
        Some(Value::Array(values)) => values
            .iter()
            .filter_map(Value::as_str)
            .filter_map(persist_value)
            .collect(),
        _ => Vec::new(),
    }
}

fn native_option(
    decision: RuntimePermissionDecision,
    codex_decision: Value,
    label: &str,
    description: &str,
    collect_feedback: bool,
) -> RuntimePermissionOption {
    RuntimePermissionOption {
        decision,
        option_id: Some(format!(
            "{CODEX_OPTION_PREFIX}{}",
            serde_json::to_string(&codex_decision).unwrap_or_else(|_| "null".to_string())
        )),
        label: label.to_string(),
        description: description.to_string(),
        collect_feedback,
    }
}

fn decision_key(decision: &Value) -> Option<&str> {
    if let Some(key) = decision.as_str() {
        return Some(key);
    }
    let object = decision.as_object()?;
    object.get("type").and_then(Value::as_str).or_else(|| {
        [
            "acceptWithExecpolicyAmendment",
            "applyNetworkPolicyAmendment",
        ]
        .into_iter()
        .find(|key| object.contains_key(*key))
    })
}

fn network_policy_decision(decision: &Value) -> RuntimePermissionDecision {
    let amendment = decision
        .get("networkPolicyAmendment")
        .or_else(|| decision.get("network_policy_amendment"))
        .or_else(|| {
            decision
                .get("applyNetworkPolicyAmendment")
                .and_then(|value| value.get("network_policy_amendment"))
        });
    let action = amendment
        .and_then(|value| value.get("action"))
        .and_then(Value::as_str);
    if action == Some("deny") {
        RuntimePermissionDecision::Deny
    } else {
        RuntimePermissionDecision::AllowFuture
    }
}

fn network_policy_label(decision: &Value) -> &'static str {
    match network_policy_decision(decision) {
        RuntimePermissionDecision::Deny => "Block host in future",
        _ => "Allow host in future",
    }
}

pub(super) fn codex_decision_from_option_id(option_id: Option<&str>) -> Option<Value> {
    let raw = option_id?.strip_prefix(CODEX_OPTION_PREFIX)?;
    serde_json::from_str(raw).ok()
}

pub(super) fn codex_elicitation_response_from_option_id(option_id: Option<&str>) -> Option<Value> {
    let raw = option_id?.strip_prefix(CODEX_ELICITATION_OPTION_PREFIX)?;
    serde_json::from_str(raw).ok()
}

pub(super) fn permission_option_values(options: &[RuntimePermissionOption]) -> Vec<Value> {
    options
        .iter()
        .map(|option| {
            serde_json::json!({
                "decision": match option.decision {
                    RuntimePermissionDecision::AllowOnce => "allow_once",
                    // Codex doesn't construct `AllowForSession` itself, but
                    // share the same wire discriminant so a future ACP-style
                    // option can flow through this serializer without an
                    // unreachable! panic.
                    RuntimePermissionDecision::AllowFuture
                    | RuntimePermissionDecision::AllowForSession => "allow_future",
                    RuntimePermissionDecision::Deny => "deny",
                },
                "option_id": option.option_id.clone(),
                "label": option.label.clone(),
                "description": option.description.clone(),
                "collect_feedback": option.collect_feedback,
            })
        })
        .collect()
}

fn available_decision_values(params: &Value) -> Option<Vec<Value>> {
    Some(params.get("availableDecisions")?.as_array()?.clone())
}

fn persist_value(value: &str) -> Option<&'static str> {
    match value {
        "session" => Some("session"),
        "always" => Some("always"),
        _ => None,
    }
}
