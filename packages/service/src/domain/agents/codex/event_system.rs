use serde_json::Value;

use super::event_json::{metadata, thread_id};
use super::permissions::{permission_option_values, permission_request, request_id_from_value};
use super::server_request_method::CodexServerRequestMethod;
use crate::domain::agents::adapter::{
    RuntimeEvent, RuntimeEventKind, RuntimeInitEvent, RuntimeMcpServerStatus,
    RuntimePermissionDecision,
};

pub fn init_event(
    thread_id: &str,
    model: Option<String>,
    context_window: Option<u64>,
    mcp_servers: Vec<RuntimeMcpServerStatus>,
) -> RuntimeEvent {
    RuntimeEvent::new(
        metadata(
            thread_id,
            serde_json::json!({
                "type": "system",
                "subtype": "init",
                "session_id": thread_id,
                "model": model,
                "mcp_servers": mcp_servers.iter().map(|server| {
                    serde_json::json!({ "name": server.name, "status": server.status })
                }).collect::<Vec<_>>(),
            }),
        ),
        RuntimeEventKind::Init(RuntimeInitEvent {
            model,
            mcp_servers,
            context_window,
        }),
    )
}

pub(super) fn permission_request_event(
    id: &Value,
    method: CodexServerRequestMethod,
    params: &Value,
) -> RuntimeEvent {
    let request = permission_request(id, method, params);
    let options = permission_option_values(&request.options);
    let supports_allow_future = request
        .options
        .iter()
        .any(|option| option.decision == RuntimePermissionDecision::AllowFuture);
    RuntimeEvent::new(
        metadata(
            thread_id(params),
            serde_json::json!({
                "type": "codex_permission_request",
                "request_id": request.request_id,
                "tool_use_id": request.tool_use_id,
                "tool_name": request.tool_name,
                "tool_input": request.tool_input,
                "description": request.description,
                "preview": request.preview,
                "supports_allow_future": supports_allow_future,
                "options": options,
            }),
        ),
        RuntimeEventKind::Other,
    )
}

pub fn request_key(id: &Value) -> String {
    request_id_from_value(id)
}

#[cfg(test)]
mod tests {
    use super::permission_request_event;
    use crate::domain::agents::codex::server_request_method::method;
    use serde_json::json;

    #[test]
    fn legacy_exec_approval_exposes_session_approval_option() {
        let event = permission_request_event(
            &json!(7),
            method("execCommandApproval"),
            &json!({
                "conversationId": "thread",
                "callId": "call-1",
                "command": ["git", "status"],
                "cwd": "/tmp/repo",
                "parsedCmd": []
            }),
        );

        let raw = event.raw_json();

        assert_eq!(raw["tool_name"], "Bash");
        assert_eq!(raw["tool_use_id"], "call-1");
        assert!(raw["options"].as_array().unwrap().iter().any(|option| {
            option["decision"] == "allow_future"
                && option["label"].as_str().unwrap().contains("session")
        }));
    }
}
