//! ACP permission elicitation ⇄ Cadencr `RuntimePermission*` mapping.
//!
//! ACP delivers `session/request_permission` server-requests with a
//! `toolCall` and a `PermissionOption[]`. Each option carries
//! `{ optionId, name, kind }` where `kind ∈ allow_once | allow_always |
//! reject_once | reject_always`. The client answers with
//! `{ outcome: "selected", optionId } | { outcome: "cancelled" }`.
//!
//! Cadencr maps UI decisions to advertised ACP `optionId`s, with canonical
//! fallbacks when the agent omits explicit ids.

use agent_client_protocol::schema::v1::{AgentRequest, RequestPermissionRequest};
use serde_json::Value;

use crate::domain::agents::acp::incoming::AcpServerRequest;
use crate::domain::agents::adapter::{
    RuntimePermissionOption, RuntimePermissionRequest, RuntimePermissionResponse,
};

use super::events_tool_call_metadata::enrich_tool_input;
pub use super::permission_events::permission_raw_event;
#[cfg(test)]
pub use super::permissions_dispatch::dispatch_permission_request;
pub use super::permissions_dispatch::{
    dispatch_permission_request_with_cache, pending_permission_response_kind,
    pending_permission_response_payload, reject_all_pending, take_pending, PendingPermissions,
};
pub use super::permissions_refresh::{
    has_pending_permission_for_tool_call, refreshed_permission_event_for_tool_input,
};
use super::permissions_typed::permission_request_from_typed;
use super::schema_bridge::{
    attach_updated_input, permission_response_value, resolve_permission_option,
};

mod options;

pub(super) use options::{default_options, derive_preview, permission_option};

/// Convert an ACP `session/request_permission` payload into a runtime request.
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
        enrich_tool_input(tool_call, raw_tool_input(tool_call)),
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

/// Prefer a programmatic tool name (the `toolName` extension, then the
/// standard ACP `name`) over the display `title`.
fn raw_tool_name(tool_call: &Value) -> Option<String> {
    ["toolName", "name", "title"]
        .into_iter()
        .filter_map(|key| tool_call.get(key).and_then(Value::as_str))
        .map(str::trim)
        .find(|name| !name.is_empty())
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
///
/// `updated_input` is the user's answer to an input-collecting gate (an
/// `AskUserQuestion` answer, an edited plan). It rides `_meta.updatedInput`
/// — see `docs/PROVIDER_SPEC/INSTALLED_ACP_PROVIDERS.md`.
pub fn acp_permission_response_payload(response: &RuntimePermissionResponse) -> Value {
    let mut value = permission_response_value(
        response.decision,
        response.option_id.as_deref(),
        response.feedback.as_deref(),
    );
    if let Some(updated_input) = response.updated_input.as_ref() {
        attach_updated_input(&mut value, updated_input);
    }
    value
}

#[cfg(test)]
mod tests {
    use super::{
        acp_permission_response_payload, default_options, dispatch_permission_request,
        permission_request_from_acp, permission_request_from_server_request, PendingPermissions,
    };
    use crate::domain::agents::acp::incoming::AcpServerRequest;
    use crate::domain::agents::adapter::{RuntimePermissionDecision, RuntimePermissionResponse};
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
                    "locations": [{ "path": "/repo/package.json" }],
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
        assert_eq!(req.tool_input["description"], "Run a shell command");
        assert_eq!(req.tool_input["path"], "/repo/package.json");
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

    fn response(
        decision: RuntimePermissionDecision,
        option_id: Option<&str>,
        feedback: Option<&str>,
    ) -> RuntimePermissionResponse {
        RuntimePermissionResponse {
            request_id: "perm-1".to_string(),
            decision,
            option_id: option_id.map(ToOwned::to_owned),
            feedback: feedback.map(ToOwned::to_owned),
            updated_input: None,
        }
    }

    #[test]
    fn allow_once_response_payload_has_selected_outcome() {
        let payload = acp_permission_response_payload(&response(
            RuntimePermissionDecision::AllowOnce,
            None,
            None,
        ));
        assert_eq!(payload["outcome"]["outcome"], "selected");
        assert_eq!(payload["outcome"]["optionId"], "allow_once");
        assert!(payload.get("feedback").is_none());
    }

    #[test]
    fn allow_future_uses_allow_always_when_no_option_id() {
        let payload = acp_permission_response_payload(&response(
            RuntimePermissionDecision::AllowFuture,
            None,
            None,
        ));
        assert_eq!(payload["outcome"]["optionId"], "allow_always");
    }

    #[test]
    fn explicit_option_id_overrides_default() {
        let payload = acp_permission_response_payload(&response(
            RuntimePermissionDecision::Deny,
            Some("custom-no"),
            None,
        ));
        assert_eq!(payload["outcome"]["optionId"], "custom-no");
    }

    #[test]
    fn deny_feedback_propagates_to_payload() {
        let payload = acp_permission_response_payload(&response(
            RuntimePermissionDecision::Deny,
            None,
            Some("not safe to run"),
        ));
        assert_eq!(payload["feedback"], "not safe to run");
        assert_eq!(payload["_meta"]["feedback"], "not safe to run");
    }

    #[test]
    fn updated_input_is_forwarded_under_meta() {
        let mut answer = response(RuntimePermissionDecision::AllowOnce, Some("allow"), None);
        answer.updated_input = Some(json!({ "answers": { "Color?": "Blue" } }));
        let payload = acp_permission_response_payload(&answer);
        assert_eq!(payload["outcome"]["optionId"], "allow");
        assert_eq!(
            payload["_meta"]["updatedInput"]["answers"]["Color?"],
            "Blue"
        );
        assert!(payload["_meta"].get("feedback").is_none());
    }

    #[test]
    fn programmatic_tool_name_wins_over_display_title() {
        let req = permission_request_from_acp(
            "perm-q",
            &json!({
                "sessionId": "s1",
                "toolCall": {
                    "toolCallId": "q-1",
                    "title": "Ask the user",
                    "name": "AskUserQuestion",
                    "rawInput": { "questions": [{ "question": "Color?" }] }
                },
                "options": []
            }),
        )
        .unwrap();
        assert_eq!(req.tool_name, "AskUserQuestion");
        assert_eq!(req.description.as_deref(), Some("Ask the user"));
        assert_eq!(req.tool_input["questions"][0]["question"], "Color?");
    }

    #[test]
    fn empty_feedback_is_omitted() {
        let payload = acp_permission_response_payload(&response(
            RuntimePermissionDecision::Deny,
            None,
            Some(""),
        ));
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
