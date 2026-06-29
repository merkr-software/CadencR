//! ACP permission elicitation ⇄ Cadencr `RuntimePermission*` mapping.
//!
//! ACP delivers `session/request_permission` server-requests with a
//! `toolCall` and a `PermissionOption[]`. Each option carries
//! `{ optionId, name, kind }` where `kind ∈ allow_once | allow_always |
//! reject_once | reject_always`. The client answers with
//! `{ outcome: "selected", optionId } | { outcome: "cancelled" }`.
//!
//! Cadencr's UI renders three default options (AllowOnce / AllowFuture /
//! Deny) keyed by `RuntimePermissionDecision`. We map decisions to ACP
//! `optionId`s discovered in the request, falling back to canonical
//! "allow_once"/"allow_always"/"reject_once" strings when the agent didn't
//! advertise an explicit id.

use agent_client_protocol::schema::v1::{AgentRequest, RequestPermissionRequest};
use serde_json::Value;

use crate::domain::agents::acp::incoming::AcpServerRequest;
use crate::domain::agents::adapter::{
    RuntimePermissionDecision, RuntimePermissionOption, RuntimePermissionRequest,
};

#[cfg(test)]
pub use super::permissions_dispatch::dispatch_permission_request;
pub use super::permissions_dispatch::{
    dispatch_permission_request_with_cache, permission_raw_event, reject_all_pending, take_pending,
    PendingPermissions,
};
pub use super::permissions_refresh::{
    has_pending_permission_for_tool_call, refreshed_permission_event_for_tool_input,
};
use super::permissions_typed::permission_request_from_typed;
use super::schema_bridge::{permission_response_value, resolve_permission_option};

mod options;

pub(super) use options::{default_options, derive_preview, permission_option};

/// Convert an ACP `session/request_permission` server-request payload into a
/// Cadencr `RuntimePermissionRequest`.
///
/// Returns `None` if the params are malformed (no `toolCall`); callers
/// should respond to the server-request with a JSON-RPC error in that case
/// rather than silently dropping it.
pub fn permission_request_from_acp(
    request_id: &str,
    params: &Value,
) -> Option<RuntimePermissionRequest> {
    let tool_call = params.get("toolCall")?;
    Some(permission_request_at(
        request_id,
        raw_tool_use_id(tool_call),
        raw_tool_name(tool_call),
        raw_title(tool_call),
        raw_tool_input(tool_call),
        raw_options(params),
    ))
}

pub fn permission_request_from_server_request(
    request_id: &str,
    request: &AcpServerRequest,
) -> Option<RuntimePermissionRequest> {
    if let Some(typed) = request.typed_as(permission_request) {
        return permission_request_from_typed(request_id, typed);
    }
    permission_request_from_acp(request_id, request.params())
}

fn permission_request(request: &AgentRequest) -> Option<&RequestPermissionRequest> {
    match request {
        AgentRequest::RequestPermissionRequest(request) => Some(request),
        _ => None,
    }
}

pub(super) fn permission_request_at(
    request_id: &str,
    tool_use_id: Option<String>,
    tool_name: Option<String>,
    description: Option<String>,
    tool_input: Value,
    options: impl IntoIterator<Item = RuntimePermissionOption>,
) -> RuntimePermissionRequest {
    let options = options.into_iter().collect::<Vec<_>>();
    RuntimePermissionRequest {
        request_id: request_id.to_string(),
        tool_use_id,
        tool_name: tool_name.unwrap_or_else(|| "tool".to_string()),
        preview: derive_preview(&tool_input),
        tool_input,
        description,
        pattern: None,
        options: if options.is_empty() {
            default_options()
        } else {
            options
        },
    }
}

fn raw_tool_use_id(tool_call: &Value) -> Option<String> {
    tool_call
        .get("toolCallId")
        .or_else(|| tool_call.get("id"))
        .and_then(Value::as_str)
        .map(ToOwned::to_owned)
}

fn raw_tool_name(tool_call: &Value) -> Option<String> {
    tool_call
        .get("toolName")
        .or_else(|| tool_call.get("title"))
        .and_then(Value::as_str)
        .map(ToOwned::to_owned)
}

fn raw_title(tool_call: &Value) -> Option<String> {
    tool_call
        .get("title")
        .and_then(Value::as_str)
        .map(ToOwned::to_owned)
}

fn raw_tool_input(tool_call: &Value) -> Value {
    tool_call
        .get("toolInput")
        .or_else(|| tool_call.get("rawInput"))
        .cloned()
        .unwrap_or(Value::Null)
}

fn raw_options(params: &Value) -> impl Iterator<Item = RuntimePermissionOption> + '_ {
    params
        .get("options")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|option| {
            let option = resolve_permission_option(option)?;
            Some(permission_option(
                option.decision,
                option.option_id,
                option.name,
            ))
        })
}

/// Build the JSON payload Cadencr sends back as a response to
/// `session/request_permission`. Supports the cancellation case for when
/// the user closes the drawer without picking an option.
///
/// `feedback` is the optional user-typed reason that accompanies a Deny
/// decision. ACP doesn't define a first-class slot for it, so we attach
/// it under `_meta` AND mirror it as a top-level `feedback` field — agents
/// that recognise either form pick it up; the rest silently ignore the
/// extras (per JSON-RPC 2.0 / ACP passthrough).
pub fn acp_permission_response_payload(
    decision: RuntimePermissionDecision,
    option_id: Option<&str>,
    feedback: Option<&str>,
) -> Value {
    permission_response_value(decision, option_id, feedback)
}

#[cfg(test)]
mod tests {
    use super::{
        acp_permission_response_payload, default_options, dispatch_permission_request,
        permission_request_from_acp, permission_request_from_server_request, PendingPermissions,
    };
    use crate::domain::agents::acp::incoming::AcpServerRequest;
    use crate::domain::agents::adapter::RuntimePermissionDecision;
    use agent_client_protocol::schema::v1::{
        AgentRequest, PermissionOption, PermissionOptionKind, RequestPermissionRequest,
        ToolCallUpdate, ToolCallUpdateFields,
    };
    use serde_json::json;
    use tokio::sync::mpsc;

    #[test]
    fn parse_extracts_tool_metadata_and_options() {
        let req = permission_request_from_acp(
            "perm-1",
            &json!({
                "sessionId": "s1",
                "toolCall": {
                    "toolCallId": "call-9",
                    "toolName": "Bash",
                    "toolInput": { "command": "ls" },
                    "title": "Run a shell command",
                },
                "options": [
                    { "optionId": "y1", "name": "Allow once", "kind": "allow_once" },
                    { "optionId": "y2", "name": "Always", "kind": "allow_always" },
                    { "optionId": "n1", "name": "Reject", "kind": "reject_once" }
                ]
            }),
        )
        .expect("expected permission request");
        assert_eq!(req.request_id, "perm-1");
        assert_eq!(req.tool_use_id.as_deref(), Some("call-9"));
        assert_eq!(req.tool_name, "Bash");
        assert_eq!(req.preview.as_deref(), Some("ls"));
        assert_eq!(req.description.as_deref(), Some("Run a shell command"));
        assert_eq!(req.options.len(), 3);
        assert_eq!(
            req.options[0].decision,
            RuntimePermissionDecision::AllowOnce
        );
        assert_eq!(req.options[0].option_id.as_deref(), Some("y1"));
    }

    #[test]
    fn parse_returns_none_when_tool_call_missing() {
        assert!(permission_request_from_acp("p", &json!({})).is_none());
    }

    #[test]
    fn parse_falls_back_to_default_options_when_none_provided() {
        let req = permission_request_from_acp(
            "p",
            &json!({
                "toolCall": { "toolName": "Read", "toolInput": { "filePath": "/x" } }
            }),
        )
        .unwrap();
        assert_eq!(req.options.len(), 3);
    }

    #[test]
    fn parse_accepts_minimal_raw_canonical_options() {
        let req = permission_request_from_acp(
            "p",
            &json!({
                "toolCall": { "toolName": "Read", "toolInput": { "filePath": "/x" } },
                "options": [
                    { "kind": "allow_once" },
                    { "kind": "allow_for_session", "optionId": "session" },
                    { "kind": "reject_always" }
                ]
            }),
        )
        .unwrap();
        assert_eq!(req.options.len(), 3);
        assert_eq!(
            req.options[0].decision,
            RuntimePermissionDecision::AllowOnce
        );
        assert_eq!(
            req.options[1].decision,
            RuntimePermissionDecision::AllowForSession
        );
        assert_eq!(req.options[1].option_id.as_deref(), Some("session"));
        assert_eq!(req.options[2].decision, RuntimePermissionDecision::Deny);
    }

    fn typed_permission_request(
        session_id: &str,
        options: Vec<PermissionOption>,
    ) -> RequestPermissionRequest {
        RequestPermissionRequest::new(
            session_id.to_string(),
            ToolCallUpdate::new(
                "call-typed",
                ToolCallUpdateFields::new()
                    .title("Bash".to_string())
                    .raw_input(json!({ "command": "pwd" })),
            ),
            options,
        )
    }

    fn typed_server_request(typed: RequestPermissionRequest) -> AcpServerRequest {
        AcpServerRequest::Known {
            id: json!("perm-typed"),
            method: "session/request_permission".to_string(),
            raw: json!({ "sessionId": typed.session_id, "toolCall": {}, "options": [] }),
            typed: Some(AgentRequest::RequestPermissionRequest(typed)),
        }
    }

    #[test]
    fn typed_empty_options_fall_back_to_default_options() {
        let request = typed_server_request(typed_permission_request("s-typed", Vec::new()));
        let parsed = permission_request_from_server_request("perm-typed", &request).unwrap();
        assert_eq!(parsed.options.len(), 3);
        assert_eq!(
            parsed.options[0].decision,
            RuntimePermissionDecision::AllowOnce
        );
        assert_eq!(
            parsed.options[1].decision,
            RuntimePermissionDecision::AllowFuture
        );
        assert_eq!(parsed.options[2].decision, RuntimePermissionDecision::Deny);
    }

    #[test]
    fn typed_permission_option_kinds_map_to_runtime_decisions() {
        let request = typed_server_request(typed_permission_request(
            "s-typed",
            vec![
                PermissionOption::new("once", "Once", PermissionOptionKind::AllowOnce),
                PermissionOption::new("always", "Always", PermissionOptionKind::AllowAlways),
                PermissionOption::new("reject", "Reject", PermissionOptionKind::RejectOnce),
                PermissionOption::new("never", "Never", PermissionOptionKind::RejectAlways),
            ],
        ));
        let parsed = permission_request_from_server_request("perm-typed", &request).unwrap();
        let decisions = parsed
            .options
            .iter()
            .map(|option| option.decision)
            .collect::<Vec<_>>();
        assert_eq!(
            decisions,
            vec![
                RuntimePermissionDecision::AllowOnce,
                RuntimePermissionDecision::AllowFuture,
                RuntimePermissionDecision::Deny,
                RuntimePermissionDecision::Deny,
            ],
        );
    }

    #[tokio::test]
    async fn typed_permission_dispatch_preserves_session_id() {
        let request = typed_server_request(typed_permission_request("s-typed", Vec::new()));
        let parsed = permission_request_from_server_request("perm-typed", &request).unwrap();
        let pending = PendingPermissions::default();
        let (tx, mut rx) = mpsc::channel(1);
        dispatch_permission_request(
            &pending,
            Some("s-typed".to_string()),
            "perm-typed",
            json!("perm-typed"),
            parsed,
            request.params(),
            &tx,
        )
        .await
        .unwrap();
        let event = rx.recv().await.unwrap().unwrap();
        assert_eq!(event.session_id(), Some("s-typed"));
        assert_eq!(event.raw_json()["acp"]["sessionId"], "s-typed");
    }

    #[test]
    fn allow_once_response_payload_has_selected_outcome() {
        let payload =
            acp_permission_response_payload(RuntimePermissionDecision::AllowOnce, None, None);
        assert_eq!(payload["outcome"]["outcome"], "selected");
        assert_eq!(payload["outcome"]["optionId"], "allow_once");
        assert!(payload.get("feedback").is_none());
    }

    #[test]
    fn allow_future_uses_allow_always_when_no_option_id() {
        let payload =
            acp_permission_response_payload(RuntimePermissionDecision::AllowFuture, None, None);
        assert_eq!(payload["outcome"]["optionId"], "allow_always");
    }

    #[test]
    fn explicit_option_id_overrides_default() {
        let payload = acp_permission_response_payload(
            RuntimePermissionDecision::Deny,
            Some("custom-no"),
            None,
        );
        assert_eq!(payload["outcome"]["optionId"], "custom-no");
    }

    #[test]
    fn deny_feedback_propagates_to_payload() {
        let payload = acp_permission_response_payload(
            RuntimePermissionDecision::Deny,
            None,
            Some("not safe to run"),
        );
        assert_eq!(payload["feedback"], "not safe to run");
        assert_eq!(payload["_meta"]["feedback"], "not safe to run");
    }

    #[test]
    fn empty_feedback_is_omitted() {
        let payload =
            acp_permission_response_payload(RuntimePermissionDecision::Deny, None, Some(""));
        assert!(payload.get("feedback").is_none());
        assert!(payload.get("_meta").is_none());
    }

    #[test]
    fn defaults_have_three_options_in_canonical_order() {
        let opts = default_options();
        assert_eq!(opts.len(), 3);
        assert_eq!(opts[0].decision, RuntimePermissionDecision::AllowOnce);
        assert_eq!(opts[1].decision, RuntimePermissionDecision::AllowFuture);
        assert_eq!(opts[2].decision, RuntimePermissionDecision::Deny);
    }
}
