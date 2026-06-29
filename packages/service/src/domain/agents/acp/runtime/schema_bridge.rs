//! Compatibility helpers for ACP payloads that still need raw JSON because
//! Cadencr preserves provider extensions on top of official ACP schema types.

use agent_client_protocol::schema::v1::{
    PermissionOption, PermissionOptionKind, RequestPermissionOutcome, RequestPermissionResponse,
    SelectedPermissionOutcome,
};
use serde::de::DeserializeOwned;
use serde::Serialize;
use serde_json::Value;

use crate::domain::agents::adapter::RuntimePermissionDecision;

pub fn permission_response_value(
    decision: RuntimePermissionDecision,
    option_id: Option<&str>,
    feedback: Option<&str>,
) -> Value {
    let selected_id = option_id.unwrap_or_else(|| default_option_id(decision));
    let outcome =
        RequestPermissionOutcome::Selected(SelectedPermissionOutcome::new(selected_id.to_string()));
    let mut value = to_value(RequestPermissionResponse::new(outcome));
    if let Some(text) = feedback.filter(|s| !s.is_empty()) {
        value["feedback"] = Value::String(text.to_string());
        value["_meta"] = serde_json::json!({ "feedback": text });
    }
    value
}

pub struct ResolvedPermissionOption {
    pub decision: RuntimePermissionDecision,
    pub option_id: Option<String>,
    pub name: Option<String>,
}

pub fn resolve_permission_option(option: &Value) -> Option<ResolvedPermissionOption> {
    if let Ok(option) = from_value::<PermissionOption>(option.clone()) {
        return decision_for_official_kind(option.kind).map(|decision| ResolvedPermissionOption {
            decision,
            option_id: Some(option.option_id.to_string()),
            name: Some(option.name),
        });
    }
    let decision = decision_for_kind_str(option.get("kind").and_then(Value::as_str)?)?;
    Some(ResolvedPermissionOption {
        decision,
        option_id: option
            .get("optionId")
            .and_then(Value::as_str)
            .map(ToOwned::to_owned),
        name: option
            .get("name")
            .and_then(Value::as_str)
            .map(ToOwned::to_owned),
    })
}

pub fn default_option_id(decision: RuntimePermissionDecision) -> &'static str {
    match decision {
        RuntimePermissionDecision::AllowOnce => "allow_once",
        RuntimePermissionDecision::AllowFuture => "allow_always",
        RuntimePermissionDecision::AllowForSession => "allow_for_session",
        RuntimePermissionDecision::Deny => "reject_once",
    }
}

pub fn decision_for_official_kind(kind: PermissionOptionKind) -> Option<RuntimePermissionDecision> {
    match kind {
        PermissionOptionKind::AllowOnce => Some(RuntimePermissionDecision::AllowOnce),
        PermissionOptionKind::AllowAlways => Some(RuntimePermissionDecision::AllowFuture),
        PermissionOptionKind::RejectOnce | PermissionOptionKind::RejectAlways => {
            Some(RuntimePermissionDecision::Deny)
        }
        _ => None,
    }
}

fn decision_for_kind_str(kind: &str) -> Option<RuntimePermissionDecision> {
    match kind {
        "allow_once" => Some(RuntimePermissionDecision::AllowOnce),
        "allow_always" => Some(RuntimePermissionDecision::AllowFuture),
        "allow_for_session" => Some(RuntimePermissionDecision::AllowForSession),
        "reject_once" | "reject_always" => Some(RuntimePermissionDecision::Deny),
        _ => None,
    }
}

fn to_value<T: Serialize>(payload: T) -> Value {
    serde_json::to_value(payload).expect("official ACP schema value should serialize")
}

fn from_value<T: DeserializeOwned>(value: Value) -> serde_json::Result<T> {
    serde_json::from_value(value)
}

#[cfg(test)]
mod tests {
    use super::{permission_response_value, resolve_permission_option};
    use agent_client_protocol::schema::v1::RequestPermissionResponse;
    use serde_json::json;

    use crate::domain::agents::adapter::RuntimePermissionDecision;

    #[test]
    fn permission_response_uses_official_schema_for_selected_outcome() {
        let value = permission_response_value(
            RuntimePermissionDecision::AllowOnce,
            Some("allow_once"),
            None,
        );
        let parsed: RequestPermissionResponse = serde_json::from_value(value.clone()).unwrap();

        assert_eq!(value["outcome"]["outcome"], "selected");
        assert_eq!(value["outcome"]["optionId"], "allow_once");
        assert!(parsed.meta.is_none());
    }

    #[test]
    fn permission_option_kind_preserves_allow_session_extension() {
        let value = json!({ "optionId": "session", "name": "Allow for session", "kind": "allow_for_session" });
        let option = resolve_permission_option(&value).unwrap();

        assert_eq!(option.decision, RuntimePermissionDecision::AllowForSession);
        assert_eq!(option.option_id.as_deref(), Some("session"));
    }
}
