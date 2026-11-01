//! Typed-payload conversion for ACP `session/request_permission` requests.
//!
//! Sibling to [`super::permissions`]: when the inbound request deserializes
//! cleanly into the official `RequestPermissionRequest` schema we route here
//! to avoid a second raw-JSON parse. The OpenCode `toolCall` extension shape
//! still falls through `permission_request_from_acp` and shares the same
//! helpers (`default_options`, `default_description`, `derive_preview`).

use agent_client_protocol::schema::v1::RequestPermissionRequest;

use crate::domain::agents::adapter::RuntimePermissionRequest;

use super::permissions::{permission_option, permission_request_at};
use super::schema_bridge::decision_for_official_kind;

/// Typed-payload variant of `permission_request_from_acp`.
///
/// Used when the inbound `session/request_permission` deserializes cleanly
/// into the official ACP schema; the OpenCode `toolCall` extension shape
/// still falls through the raw helper. Both paths converge on the same
/// `RuntimePermissionRequest` so the UI is unaware of which branch produced
/// it.
pub fn permission_request_from_typed(
    request_id: &str,
    request: &RequestPermissionRequest,
) -> Option<RuntimePermissionRequest> {
    Some(permission_request_at(
        request_id,
        Some(request.tool_call.tool_call_id.to_string()),
        // The programmatic ACP `name` (e.g. `AskUserQuestion`) identifies the
        // tool; `title` is display text and only a fallback.
        request
            .tool_call
            .fields
            .name
            .clone()
            .filter(|name| !name.trim().is_empty())
            .or_else(|| request.tool_call.fields.title.clone()),
        request.tool_call.fields.title.clone(),
        request
            .tool_call
            .fields
            .raw_input
            .clone()
            .unwrap_or_default(),
        typed_options(request),
    ))
}

fn typed_options(
    request: &RequestPermissionRequest,
) -> impl Iterator<Item = crate::domain::agents::adapter::RuntimePermissionOption> + '_ {
    request.options.iter().filter_map(|option| {
        let decision = decision_for_official_kind(option.kind)?;
        Some(permission_option(
            decision,
            Some(option.option_id.to_string()),
            Some(option.name.clone()),
        ))
    })
}

#[cfg(test)]
mod tests {
    use super::permission_request_from_typed;
    use agent_client_protocol::schema::v1::{
        PermissionOption, PermissionOptionKind, RequestPermissionRequest, ToolCallUpdate,
        ToolCallUpdateFields,
    };
    use serde_json::json;

    #[test]
    fn typed_permission_request_extracts_options_without_raw_reparse() {
        let tool_call = ToolCallUpdate::new(
            "call-1",
            ToolCallUpdateFields::new()
                .title("Bash".to_string())
                .raw_input(json!({ "command": "ls" })),
        );
        let typed = RequestPermissionRequest::new(
            "s-1",
            tool_call,
            vec![PermissionOption::new(
                "allow-once",
                "Allow once",
                PermissionOptionKind::AllowOnce,
            )],
        );

        let req = permission_request_from_typed("perm-1", &typed).unwrap();
        assert_eq!(req.request_id, "perm-1");
        assert_eq!(req.tool_use_id.as_deref(), Some("call-1"));
        assert_eq!(req.tool_name, "Bash");
        assert_eq!(req.options.len(), 1);
        assert_eq!(req.options[0].option_id.as_deref(), Some("allow-once"));
        assert_eq!(req.preview.as_deref(), Some("ls"));
    }

    #[test]
    fn typed_permission_request_prefers_the_programmatic_name() {
        let tool_call = ToolCallUpdate::new(
            "call-q",
            ToolCallUpdateFields::new()
                .title("Ask the user".to_string())
                .name("AskUserQuestion".to_string())
                .raw_input(json!({ "questions": [{ "question": "Color?" }] })),
        );
        let typed = RequestPermissionRequest::new("s-1", tool_call, vec![]);

        let req = permission_request_from_typed("perm-q", &typed).unwrap();
        assert_eq!(req.tool_name, "AskUserQuestion");
        assert_eq!(req.description.as_deref(), Some("Ask the user"));
        assert_eq!(req.tool_input["questions"][0]["question"], "Color?");
    }
}
