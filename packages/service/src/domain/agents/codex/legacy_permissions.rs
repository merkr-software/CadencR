use serde_json::{json, Map, Value};

use super::permission_details::{description, insert_param_or_null, PermissionDetails};
use crate::domain::agents::adapter::{
    RuntimePermissionDecision, RuntimePermissionOption, RuntimePermissionResponse,
};

const LEGACY_OPTION_PREFIX: &str = "codex_legacy:";
const METHOD_APPLY_PATCH_APPROVAL: &str = "applyPatchApproval";
const METHOD_EXEC_COMMAND_APPROVAL: &str = "execCommandApproval";
const REVIEW_APPROVED: &str = "approved";
const REVIEW_APPROVED_FOR_SESSION: &str = "approved_for_session";
const REVIEW_DENIED: &str = "denied";
const REVIEW_ABORT: &str = "abort";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum LegacyPermissionMethod {
    ApplyPatchApproval,
    ExecCommandApproval,
}

pub(super) fn legacy_permission_details(
    method: LegacyPermissionMethod,
    params: &Value,
) -> PermissionDetails {
    match method {
        LegacyPermissionMethod::ExecCommandApproval => exec_command_details(params),
        LegacyPermissionMethod::ApplyPatchApproval => apply_patch_details(params),
    }
}

/// Both legacy methods share the `ReviewDecision` vocabulary.
pub(super) fn legacy_permission_options() -> Vec<RuntimePermissionOption> {
    vec![
        review_option(
            RuntimePermissionDecision::AllowOnce,
            REVIEW_APPROVED,
            "Approve",
            "Approve this request only",
            false,
        ),
        review_option(
            RuntimePermissionDecision::AllowFuture,
            REVIEW_APPROVED_FOR_SESSION,
            "Approve for session",
            "Approve matching requests for this Codex session",
            false,
        ),
        review_option(
            RuntimePermissionDecision::Deny,
            REVIEW_DENIED,
            "Deny and continue",
            "Reject this request and let Codex continue",
            true,
        ),
        review_option(
            RuntimePermissionDecision::Deny,
            REVIEW_ABORT,
            "Cancel",
            "Reject this request and stop the current turn",
            true,
        ),
    ]
}

pub(super) fn legacy_response_value(response: &RuntimePermissionResponse) -> Value {
    let decision = legacy_review_decision_from_option_id(response.option_id.as_deref())
        .unwrap_or_else(|| fallback_review_decision(response.decision));
    json!({ "decision": decision })
}

impl LegacyPermissionMethod {
    pub(super) fn parse(method: &str) -> Option<Self> {
        match method {
            METHOD_APPLY_PATCH_APPROVAL => Some(Self::ApplyPatchApproval),
            METHOD_EXEC_COMMAND_APPROVAL => Some(Self::ExecCommandApproval),
            _ => None,
        }
    }
}

fn exec_command_details(params: &Value) -> PermissionDetails {
    PermissionDetails {
        tool_name: "Bash".to_string(),
        tool_input: exec_command_input(params),
        description: description(params, "Approve command execution"),
        supports_allow_future: true,
    }
}

fn apply_patch_details(params: &Value) -> PermissionDetails {
    PermissionDetails {
        tool_name: "ApplyPatch".to_string(),
        tool_input: json!({
            "fileChanges": params.get("fileChanges").cloned().unwrap_or(Value::Null),
            "grantRoot": params.get("grantRoot").cloned().unwrap_or(Value::Null),
            "reason": params.get("reason").cloned().unwrap_or(Value::Null),
        }),
        description: description(params, "Approve file change"),
        supports_allow_future: true,
    }
}

fn exec_command_input(params: &Value) -> Value {
    let mut input = Map::new();
    input.insert(
        "command".to_string(),
        Value::String(command_preview(params)),
    );
    insert_param_or_null(&mut input, params, "approvalId");
    insert_param_or_null(&mut input, params, "cwd");
    insert_param_or_null(&mut input, params, "reason");
    insert_param_or_null(&mut input, params, "parsedCmd");
    Value::Object(input)
}

fn command_preview(params: &Value) -> String {
    params
        .get("command")
        .and_then(Value::as_array)
        .map(|parts| {
            parts
                .iter()
                .filter_map(Value::as_str)
                .collect::<Vec<_>>()
                .join(" ")
        })
        .filter(|command| !command.is_empty())
        .unwrap_or_else(|| "<unknown command>".to_string())
}

fn review_option(
    decision: RuntimePermissionDecision,
    review_decision: &str,
    label: &str,
    description: &str,
    collect_feedback: bool,
) -> RuntimePermissionOption {
    RuntimePermissionOption {
        decision,
        option_id: Some(format!("{LEGACY_OPTION_PREFIX}{review_decision}")),
        label: label.to_string(),
        description: description.to_string(),
        collect_feedback,
    }
}

fn legacy_review_decision_from_option_id(option_id: Option<&str>) -> Option<&'static str> {
    match option_id?.strip_prefix(LEGACY_OPTION_PREFIX)? {
        REVIEW_APPROVED => Some(REVIEW_APPROVED),
        REVIEW_APPROVED_FOR_SESSION => Some(REVIEW_APPROVED_FOR_SESSION),
        REVIEW_DENIED => Some(REVIEW_DENIED),
        REVIEW_ABORT => Some(REVIEW_ABORT),
        _ => None,
    }
}

fn fallback_review_decision(decision: RuntimePermissionDecision) -> &'static str {
    match decision {
        RuntimePermissionDecision::AllowOnce => REVIEW_APPROVED,
        RuntimePermissionDecision::AllowFuture | RuntimePermissionDecision::AllowForSession => {
            REVIEW_APPROVED_FOR_SESSION
        }
        RuntimePermissionDecision::Deny => REVIEW_DENIED,
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::{legacy_permission_details, legacy_permission_options, LegacyPermissionMethod};
    use crate::domain::agents::adapter::{RuntimePermissionDecision, RuntimePermissionResponse};

    #[test]
    fn legacy_exec_allow_future_maps_to_approved_for_session() {
        let response = RuntimePermissionResponse {
            request_id: "exec-1".to_string(),
            decision: RuntimePermissionDecision::AllowFuture,
            option_id: None,
            feedback: None,
            updated_input: None,
        };

        let value = super::legacy_response_value(&response);

        assert_eq!(value, json!({ "decision": "approved_for_session" }));
    }

    #[test]
    fn legacy_exec_allow_for_session_maps_to_approved_for_session() {
        let response = RuntimePermissionResponse {
            request_id: "exec-1".to_string(),
            decision: RuntimePermissionDecision::AllowForSession,
            option_id: None,
            feedback: None,
            updated_input: None,
        };

        let value = super::legacy_response_value(&response);

        assert_eq!(value, json!({ "decision": "approved_for_session" }));
    }

    #[test]
    fn legacy_apply_patch_details_are_session_approvable() {
        let details = legacy_permission_details(
            LegacyPermissionMethod::ApplyPatchApproval,
            &json!({
                "conversationId": "thread",
                "callId": "patch-1",
                "fileChanges": { "src/main.rs": { "type": "update", "unified_diff": "@@" } },
                "grantRoot": "/tmp/repo"
            }),
        );
        let options = legacy_permission_options();

        assert_eq!(details.tool_name, "ApplyPatch");
        assert!(details.supports_allow_future);
        assert_eq!(details.tool_input["grantRoot"], "/tmp/repo");
        assert!(options
            .iter()
            .any(|option| option.decision == RuntimePermissionDecision::AllowFuture));
    }
}
